import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Logger } from "../logging.js";
import { JsonRpcChild, JsonRpcError } from "./jsonrpc.js";
import type { AgentAdapter, DeliveryOptions, DeliveryResult } from "./types.js";
import { BusyError, PermanentError, UnreachableError } from "./types.js";

export interface CodexAppServerAdapterConfig {
  codexPath?: string | undefined;
  model?: string | undefined;
  /** Force "proxy" (attach to running app-server) or "spawn" (own instance). Default: auto. */
  connection?: "auto" | "proxy" | "spawn" | undefined;
}

const CLIENT_INFO = { name: "bridgehead", title: "Bridgehead", version: "0.1.0" };

interface ThreadResumeResponse {
  thread: { id: string; status?: { type: string } };
}

interface TurnItem {
  type: string;
  text?: string;
}

interface Turn {
  id: string;
  status: "completed" | "interrupted" | "failed" | "inProgress";
  items?: TurnItem[];
  error?: { message?: string } | null;
  /** Set by us from streamed item/completed events, not on the wire. */
  streamedFinal?: string | undefined;
}

interface TurnStartResponse {
  turn: Turn;
}

interface TurnCompletedNotification {
  threadId: string;
  turn: Turn;
}

interface TurnWaiter {
  resolve: (turn: Turn) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

/** How long to wait for a turn to finish before giving up (agent turns can be long). */
const TURN_COMPLETION_TIMEOUT_MS = 30 * 60_000;

/**
 * Raw JSON-RPC sink against `codex app-server` (v2 protocol, JSONL framing,
 * verified against codex-cli 0.142.0 generated bindings).
 *
 * Connection strategy: if the app-server control socket exists
 * ($CODEX_HOME/app-server-control/app-server-control.sock), spawn
 * `codex app-server proxy` to attach to the RUNNING server — injected turns
 * then stream live into any client of that server. Otherwise spawn a private
 * `codex app-server`; turns are persisted to the shared session store and
 * appear when the thread is next loaded elsewhere.
 *
 * Like the SDK/exec adapters it waits for the turn to finish (via the
 * turn/completed notification) so the queue's per-thread FIFO stays clean, but
 * unlike them it can detect a turn already in flight on the thread (BusyError)
 * and — in proxy mode — inject into a running app-server so the turn appears
 * live.
 */
export class CodexAppServerAdapter implements AgentAdapter {
  readonly name = "codex-app-server";
  private connection: JsonRpcChild | null = null;
  private initializing: Promise<JsonRpcChild> | null = null;
  /** One turn per thread (guaranteed by BusyError), so key completion waiters by threadId. */
  private readonly turnWaiters = new Map<string, TurnWaiter>();
  /**
   * The final agent message arrives via item/completed during the turn; the
   * turn/completed notification often carries only a "summary" items view. Keep
   * the latest agentMessage text per thread so we can report finalResponse.
   */
  private readonly lastAgentMessage = new Map<string, string>();

  constructor(
    private readonly logger: Logger,
    private readonly config: CodexAppServerAdapterConfig = {},
  ) {}

  async deliverToThread(
    threadId: string,
    prompt: string,
    opts: DeliveryOptions,
  ): Promise<DeliveryResult> {
    const rpc = await this.connect();
    const resumed = await this.call<ThreadResumeResponse>(rpc, "thread/resume", { threadId });
    if (resumed.thread.status?.type === "active") {
      throw new BusyError(`thread ${threadId} has a turn in flight`);
    }
    return this.runTurn(rpc, threadId, prompt, opts);
  }

  async startThread(prompt: string, opts: DeliveryOptions): Promise<DeliveryResult> {
    const rpc = await this.connect();
    const started = await this.call<ThreadResumeResponse>(rpc, "thread/start", {
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      sandbox: opts.sandbox,
      approvalPolicy: "never",
      ...(this.config.model ? { model: this.config.model } : {}),
    });
    return this.runTurn(rpc, started.thread.id, prompt, opts);
  }

  /**
   * Start a turn and wait for it to finish. Registering the completion waiter
   * BEFORE turn/start closes the race where a fast turn completes before we
   * start listening; the per-thread key is safe because BusyError guarantees a
   * single in-flight turn per thread. Blocking to completion (rather than
   * returning on accept) keeps the queue's per-thread FIFO clean, matching the
   * SDK and exec adapters.
   */
  private async runTurn(
    rpc: JsonRpcChild,
    threadId: string,
    prompt: string,
    opts: DeliveryOptions,
  ): Promise<DeliveryResult> {
    const completion = this.awaitTurnCompletion(threadId);
    let turnId: string;
    try {
      const started = await this.call<TurnStartResponse>(rpc, "turn/start", {
        threadId,
        input: [{ type: "text", text: prompt }],
        approvalPolicy: "never",
        sandboxPolicy: sandboxPolicyFor(opts),
        ...(this.config.model ? { model: this.config.model } : {}),
      });
      turnId = started.turn.id;
    } catch (err) {
      this.cancelWaiter(threadId, err instanceof Error ? err : new Error(String(err)));
      throw err;
    }

    const turn = await completion;
    if (turn.status === "failed") {
      throw new Error(`turn ${turnId} failed: ${turn.error?.message ?? "unknown error"}`);
    }
    if (turn.status === "interrupted") {
      throw new Error(`turn ${turnId} was interrupted`);
    }
    return { threadId, turnId, finalResponse: finalMessageOf(turn) };
  }

  private awaitTurnCompletion(threadId: string): Promise<Turn> {
    // A prior waiter for this thread should never exist (BusyError), but if it
    // somehow does, fail it rather than leak it.
    this.cancelWaiter(threadId, new Error("superseded by a new turn"));
    return new Promise<Turn>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.turnWaiters.delete(threadId);
        reject(new UnreachableError(`turn on ${threadId} did not complete in time`));
      }, TURN_COMPLETION_TIMEOUT_MS);
      this.turnWaiters.set(threadId, { resolve, reject, timer });
    });
  }

  private cancelWaiter(threadId: string, err: Error): void {
    const waiter = this.turnWaiters.get(threadId);
    if (!waiter) return;
    clearTimeout(waiter.timer);
    this.turnWaiters.delete(threadId);
    waiter.reject(err);
  }

  private handleNotification(method: string, params: unknown): void {
    if (method === "item/completed") {
      const note = params as { item?: TurnItem; threadId?: string };
      if (note.item?.type === "agentMessage" && note.item.text && note.threadId) {
        this.lastAgentMessage.set(note.threadId, note.item.text);
      }
      return;
    }
    if (method !== "turn/completed") return;
    const note = params as TurnCompletedNotification;
    const waiter = this.turnWaiters.get(note.threadId);
    if (!waiter) return;
    clearTimeout(waiter.timer);
    this.turnWaiters.delete(note.threadId);
    // Prefer a full items view if present, else the streamed agent message.
    const streamed = this.lastAgentMessage.get(note.threadId);
    this.lastAgentMessage.delete(note.threadId);
    waiter.resolve({ ...note.turn, streamedFinal: streamed });
  }

  private failAllWaiters(err: Error): void {
    for (const [, waiter] of this.turnWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(err instanceof UnreachableError ? err : new UnreachableError(err.message));
    }
    this.turnWaiters.clear();
  }

  async probe(): Promise<boolean> {
    try {
      await this.connect();
      return true;
    } catch {
      return false;
    }
  }

  close(): void {
    this.failAllWaiters(new UnreachableError("adapter closed"));
    this.connection?.stop();
    this.connection = null;
  }

  private async connect(): Promise<JsonRpcChild> {
    if (this.connection?.alive) return this.connection;
    if (this.initializing) return this.initializing;
    this.initializing = this.doConnect().finally(() => {
      this.initializing = null;
    });
    return this.initializing;
  }

  private async doConnect(): Promise<JsonRpcChild> {
    this.connection?.stop();
    const bin = this.config.codexPath ?? "codex";
    const mode = this.resolveConnectionMode();
    const args = mode === "proxy" ? ["app-server", "proxy"] : ["app-server"];
    this.logger.info({ mode }, "connecting to codex app-server");

    const rpc = new JsonRpcChild(bin, args, this.logger);
    rpc.onNotification = (method, params) => this.handleNotification(method, params);
    rpc.onClose = (err) => this.failAllWaiters(err);
    rpc.onRequest = (method) => {
      this.logger.warn({ method }, "declining unexpected app-server request");
      return { errorMessage: "bridgehead runs unattended and declines interactive requests" };
    };
    try {
      rpc.start();
      await rpc.request("initialize", { clientInfo: CLIENT_INFO, capabilities: null }, 15_000);
      rpc.notify("initialized", {});
    } catch (err) {
      rpc.stop();
      throw new UnreachableError(
        `cannot connect to codex app-server (${mode}): ${err instanceof Error ? err.message : err}`,
      );
    }
    this.connection = rpc;
    return rpc;
  }

  private resolveConnectionMode(): "proxy" | "spawn" {
    const preference = this.config.connection ?? "auto";
    if (preference !== "auto") return preference;
    return fs.existsSync(controlSocketPath()) ? "proxy" : "spawn";
  }

  private async call<T>(rpc: JsonRpcChild, method: string, params: unknown): Promise<T> {
    try {
      return await rpc.request<T>(method, params);
    } catch (err) {
      throw mapRpcError(err, method);
    }
  }
}

function mapRpcError(err: unknown, method: string): Error {
  if (err instanceof JsonRpcError) {
    if (err.code === -32001) {
      // "Server overloaded; retry later."
      return new UnreachableError(`app-server overloaded during ${method}`);
    }
    if (/not.?found|no such|does not exist/i.test(err.message)) {
      return new PermanentError(`${method}: ${err.message}`);
    }
    return new Error(`${method}: ${err.message}`);
  }
  const message = err instanceof Error ? err.message : String(err);
  if (/exited|not open|ENOENT|timed out/i.test(message)) {
    return new UnreachableError(`${method}: ${message}`);
  }
  return err instanceof Error ? err : new Error(message);
}

/** The agent's final message: from the completed turn's items, or the streamed fallback. */
function finalMessageOf(turn: Turn): string | undefined {
  const messages = (turn.items ?? []).filter((i) => i.type === "agentMessage" && i.text);
  return messages[messages.length - 1]?.text ?? turn.streamedFinal;
}

function sandboxPolicyFor(opts: DeliveryOptions) {
  if (opts.sandbox === "workspace-write") {
    return {
      type: "workspaceWrite",
      writableRoots: opts.cwd ? [opts.cwd] : [],
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    };
  }
  return { type: "readOnly", networkAccess: false };
}

function controlSocketPath(): string {
  const codexHome = process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
  return path.join(codexHome, "app-server-control", "app-server-control.sock");
}
