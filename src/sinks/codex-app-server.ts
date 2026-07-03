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

interface TurnStartResponse {
  turn: { id: string; status?: string };
}

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
 * Unlike the SDK/exec adapters, this one returns as soon as the turn is
 * ACCEPTED (turn/start response) rather than waiting for the agent to finish,
 * and it can detect a turn already in flight on the thread (BusyError).
 */
export class CodexAppServerAdapter implements AgentAdapter {
  readonly name = "codex-app-server";
  private connection: JsonRpcChild | null = null;
  private initializing: Promise<JsonRpcChild> | null = null;

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
    const turn = await this.call<TurnStartResponse>(rpc, "turn/start", {
      threadId,
      input: [{ type: "text", text: prompt }],
      approvalPolicy: "never",
      sandboxPolicy: sandboxPolicyFor(opts),
      ...(this.config.model ? { model: this.config.model } : {}),
    });
    return { threadId, turnId: turn.turn.id };
  }

  async startThread(prompt: string, opts: DeliveryOptions): Promise<DeliveryResult> {
    const rpc = await this.connect();
    const started = await this.call<ThreadResumeResponse>(rpc, "thread/start", {
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      sandbox: opts.sandbox,
      approvalPolicy: "never",
      ...(this.config.model ? { model: this.config.model } : {}),
    });
    const threadId = started.thread.id;
    const turn = await this.call<TurnStartResponse>(rpc, "turn/start", {
      threadId,
      input: [{ type: "text", text: prompt }],
      approvalPolicy: "never",
      sandboxPolicy: sandboxPolicyFor(opts),
    });
    return { threadId, turnId: turn.turn.id };
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
