import { execFile } from "node:child_process";
import { Codex, type ThreadOptions } from "@openai/codex-sdk";
import type { Logger } from "../logging.js";
import type { AgentAdapter, DeliveryOptions, DeliveryResult } from "./types.js";
import { PermanentError, UnreachableError } from "./types.js";

export interface CodexSdkAdapterConfig {
  /** Override the codex binary the SDK spawns (defaults to the npm-vendored one). */
  codexPath?: string | undefined;
  /** Model override for injected turns. */
  model?: string | undefined;
}

/**
 * Default sink. Uses @openai/codex-sdk, which spawns the vendored codex CLI
 * (`codex exec --experimental-json ... resume <id>`) per turn. Threads live in
 * ~/.codex/sessions, shared with the CLI and desktop app, so appended turns
 * show up when the thread is next (re)loaded there.
 *
 * Note: this adapter RUNS the turn to completion in-process; the queue keeps
 * one turn per thread. It cannot see a human's in-flight turn in the app —
 * see DECISIONS.md for the trade-off vs the app-server adapter.
 */
export class CodexSdkAdapter implements AgentAdapter {
  readonly name = "codex-sdk";
  private readonly codex: Codex;

  constructor(
    private readonly logger: Logger,
    private readonly config: CodexSdkAdapterConfig = {},
  ) {
    this.codex = new Codex(config.codexPath ? { codexPathOverride: config.codexPath } : {});
  }

  async deliverToThread(
    threadId: string,
    prompt: string,
    opts: DeliveryOptions,
  ): Promise<DeliveryResult> {
    const thread = this.codex.resumeThread(threadId, this.threadOptions(opts));
    const turn = await this.runMapped(() => thread.run(prompt), threadId);
    return { threadId, finalResponse: turn.finalResponse };
  }

  async startThread(prompt: string, opts: DeliveryOptions): Promise<DeliveryResult> {
    const thread = this.codex.startThread(this.threadOptions(opts));
    const turn = await this.runMapped(() => thread.run(prompt), null);
    if (!thread.id) throw new UnreachableError("codex did not report a thread id");
    return { threadId: thread.id, finalResponse: turn.finalResponse };
  }

  async probe(): Promise<boolean> {
    // The SDK vendors its own binary, so reachability is only about spawning.
    const bin = this.config.codexPath ?? "codex";
    return new Promise((resolve) => {
      execFile(bin, ["--version"], { timeout: 10_000 }, (err) => resolve(!err));
    });
  }

  private threadOptions(opts: DeliveryOptions): ThreadOptions {
    return {
      sandboxMode: opts.sandbox,
      approvalPolicy: "never", // unattended: never block on approval prompts
      skipGitRepoCheck: true,
      ...(opts.cwd ? { workingDirectory: opts.cwd } : {}),
      ...(this.config.model ? { model: this.config.model } : {}),
    };
  }

  private async runMapped<T>(fn: () => Promise<T>, threadId: string | null): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      throw mapCodexError(err, threadId, this.logger);
    }
  }
}

export function mapCodexError(err: unknown, threadId: string | null, logger: Logger): Error {
  const message = err instanceof Error ? err.message : String(err);
  if (/ENOENT|spawn|not installed/i.test(message)) {
    return new UnreachableError(`codex binary not runnable: ${message}`);
  }
  if (threadId && /(no.*(session|thread|conversation).*(found|exists))|not found/i.test(message)) {
    return new PermanentError(`thread ${threadId} not found: ${message}`);
  }
  logger.debug({ err: message }, "codex run error");
  return err instanceof Error ? err : new Error(message);
}
