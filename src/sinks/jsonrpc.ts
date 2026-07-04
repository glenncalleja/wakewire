import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import readline from "node:readline";
import WebSocket from "ws";
import type { Logger } from "../logging.js";

/**
 * Minimal JSON-RPC client for the codex app-server: messages are JSON objects
 * with the `jsonrpc` field omitted. Two transports share one dispatch core:
 * JSONL over a child process's stdio, and one-message-per-frame WebSocket.
 */

export class JsonRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export interface JsonRpcConnection {
  readonly alive: boolean;
  onNotification: ((method: string, params: unknown) => void) | null;
  onClose: ((err: Error) => void) | null;
  onRequest:
    | ((method: string, params: unknown) => { result?: unknown; errorMessage?: string })
    | null;
  start(): void;
  stop(): void;
  request<T>(method: string, params: unknown, timeoutMs?: number): Promise<T>;
  notify(method: string, params: unknown): void;
}

abstract class JsonRpcPeer implements JsonRpcConnection {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  protected exited = false;

  onNotification: ((method: string, params: unknown) => void) | null = null;
  /** Invoked once when the connection dies, so callers can fail long-lived waits. */
  onClose: ((err: Error) => void) | null = null;
  /** Incoming server->client requests (e.g. approval prompts). Return the result to send. */
  onRequest:
    | ((method: string, params: unknown) => { result?: unknown; errorMessage?: string })
    | null = null;

  constructor(protected readonly logger: Logger) {}

  abstract get alive(): boolean;
  abstract start(): void;
  abstract stop(): void;
  protected abstract send(message: Record<string, unknown>): void;

  request<T>(method: string, params: unknown, timeoutMs = 60_000): Promise<T> {
    if (!this.alive) {
      return Promise.reject(new Error("app-server connection is not open"));
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });
      this.send({ id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    if (!this.alive) return;
    this.send({ method, params });
  }

  protected handleRaw(raw: string): void {
    const trimmed = raw.trim();
    if (!trimmed) return;
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(trimmed);
    } catch {
      this.logger.debug({ raw: trimmed.slice(0, 200) }, "non-JSON message from app-server");
      return;
    }

    if (typeof message.id === "number" && ("result" in message || "error" in message)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if ("error" in message && message.error) {
        const err = message.error as { code?: number; message?: string; data?: unknown };
        pending.reject(new JsonRpcError(err.code ?? 0, err.message ?? "unknown error", err.data));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (typeof message.method === "string" && message.id !== undefined) {
      // Server-initiated request. We run with approvalPolicy "never" so these
      // should not occur; decline anything that does.
      const handler = this.onRequest;
      const outcome = handler
        ? handler(message.method, message.params)
        : { errorMessage: "bridgehead does not handle interactive requests" };
      if (outcome.errorMessage !== undefined) {
        this.send({ id: message.id, error: { code: -32601, message: outcome.errorMessage } });
      } else {
        this.send({ id: message.id, result: outcome.result ?? null });
      }
      return;
    }

    if (typeof message.method === "string") {
      this.onNotification?.(message.method, message.params);
    }
  }

  protected fail(err: Error): void {
    this.exited = true;
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.pending.clear();
    this.onClose?.(err);
  }
}

/** JSONL over a spawned child's stdio (`codex app-server` / `codex app-server proxy`). */
export class JsonRpcChild extends JsonRpcPeer {
  private child: ChildProcessWithoutNullStreams | null = null;

  constructor(
    private readonly command: string,
    private readonly args: string[],
    logger: Logger,
  ) {
    super(logger);
  }

  override get alive(): boolean {
    return this.child !== null && !this.exited;
  }

  override start(): void {
    const child = spawn(this.command, this.args, { stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    this.exited = false;

    const rl = readline.createInterface({ input: child.stdout });
    rl.on("line", (line) => this.handleRaw(line));
    child.stderr.on("data", (chunk: Buffer) => {
      this.logger.debug({ stderr: chunk.toString().trim() }, "app-server stderr");
    });
    child.on("error", (err) => {
      this.fail(err instanceof Error ? err : new Error(String(err)));
    });
    child.on("close", (code) => {
      this.fail(new Error(`app-server process exited with code ${code}`));
    });
  }

  override stop(): void {
    this.child?.kill();
    this.child = null;
    this.exited = true;
  }

  protected override send(message: Record<string, unknown>): void {
    const child = this.child;
    if (!child || this.exited) return;
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }
}

/** One JSON message per frame over a WebSocket (`codex app-server --listen ws://…`). */
export class JsonRpcWs extends JsonRpcPeer {
  private ws: WebSocket | null = null;
  private opened = false;

  constructor(
    private readonly url: string,
    logger: Logger,
  ) {
    super(logger);
  }

  override get alive(): boolean {
    return this.ws !== null && this.opened && !this.exited;
  }

  override start(): void {
    const ws = new WebSocket(this.url);
    this.ws = ws;
    this.exited = false;
    ws.on("message", (data) => this.handleRaw(data.toString()));
    ws.on("error", (err) => {
      this.fail(err instanceof Error ? err : new Error(String(err)));
    });
    ws.on("close", () => {
      this.fail(new Error("app-server websocket closed"));
    });
  }

  /** Resolves once the socket is open (or rejects on failure). */
  waitOpen(timeoutMs = 5_000): Promise<void> {
    const ws = this.ws;
    if (!ws) return Promise.reject(new Error("not started"));
    if (ws.readyState === WebSocket.OPEN) {
      this.opened = true;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("websocket open timed out")), timeoutMs);
      ws.once("open", () => {
        clearTimeout(timer);
        this.opened = true;
        resolve();
      });
      ws.once("error", (err) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      });
    });
  }

  override stop(): void {
    try {
      this.ws?.close();
    } catch {
      // already closed
    }
    this.ws = null;
    this.exited = true;
  }

  protected override send(message: Record<string, unknown>): void {
    if (!this.alive) return;
    this.ws?.send(JSON.stringify(message));
  }
}
