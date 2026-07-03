import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import readline from "node:readline";
import type { Logger } from "../logging.js";

/**
 * Minimal JSON-RPC client over a child process's stdio using the codex
 * app-server framing: newline-delimited JSON with the `jsonrpc` field omitted.
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

export class JsonRpcChild {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private exited = false;

  onNotification: ((method: string, params: unknown) => void) | null = null;
  /** Invoked once when the connection dies, so callers can fail long-lived waits. */
  onClose: ((err: Error) => void) | null = null;
  /** Incoming server->client requests (e.g. approval prompts). Return the result to send. */
  onRequest:
    | ((method: string, params: unknown) => { result?: unknown; errorMessage?: string })
    | null = null;

  constructor(
    private readonly command: string,
    private readonly args: string[],
    private readonly logger: Logger,
  ) {}

  get alive(): boolean {
    return this.child !== null && !this.exited;
  }

  start(): void {
    const child = spawn(this.command, this.args, { stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    this.exited = false;

    const rl = readline.createInterface({ input: child.stdout });
    rl.on("line", (line) => this.handleLine(line));
    child.stderr.on("data", (chunk: Buffer) => {
      this.logger.debug({ stderr: chunk.toString().trim() }, "app-server stderr");
    });
    child.on("error", (err) => {
      this.exited = true;
      const e = err instanceof Error ? err : new Error(String(err));
      this.failAll(e);
      this.onClose?.(e);
    });
    child.on("close", (code) => {
      this.exited = true;
      const e = new Error(`app-server process exited with code ${code}`);
      this.failAll(e);
      this.onClose?.(e);
    });
  }

  stop(): void {
    this.child?.kill();
    this.child = null;
    this.exited = true;
  }

  request<T>(method: string, params: unknown, timeoutMs = 60_000): Promise<T> {
    const child = this.child;
    if (!child || this.exited) {
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
      this.write({ id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    this.write({ method, params });
  }

  private write(message: Record<string, unknown>): void {
    const child = this.child;
    if (!child || this.exited) return;
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(trimmed);
    } catch {
      this.logger.debug({ line: trimmed.slice(0, 200) }, "non-JSON line from app-server");
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
        this.write({ id: message.id, error: { code: -32601, message: outcome.errorMessage } });
      } else {
        this.write({ id: message.id, result: outcome.result ?? null });
      }
      return;
    }

    if (typeof message.method === "string") {
      this.onNotification?.(message.method, message.params);
    }
  }

  private failAll(err: Error): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.pending.clear();
  }
}
