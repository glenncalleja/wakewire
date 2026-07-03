import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Logger } from "../logging.js";
import type { AgentAdapter, DeliveryOptions, DeliveryResult } from "./types.js";
import { PermanentError, UnreachableError } from "./types.js";

export interface CodexExecAdapterConfig {
  codexPath?: string | undefined;
  model?: string | undefined;
}

/**
 * Fallback sink shelling out to `codex exec` / `codex exec resume`. Same
 * semantics as the SDK adapter (which wraps the same CLI), useful when the
 * vendored SDK binary misbehaves or a specific codex install must be used.
 */
export class CodexExecAdapter implements AgentAdapter {
  readonly name = "codex-exec";

  constructor(
    private readonly logger: Logger,
    private readonly config: CodexExecAdapterConfig = {},
  ) {}

  async deliverToThread(
    threadId: string,
    prompt: string,
    opts: DeliveryOptions,
  ): Promise<DeliveryResult> {
    const { args, lastMessageFile } = this.baseArgs(opts);
    // "-" reads the prompt from stdin — rendered prompts can exceed argv limits.
    args.push("resume", threadId, "-");
    const { stdout } = await this.run(args, threadId, prompt);
    return {
      threadId: parseThreadId(stdout) ?? threadId,
      finalResponse: readAndUnlink(lastMessageFile),
    };
  }

  async startThread(prompt: string, opts: DeliveryOptions): Promise<DeliveryResult> {
    const { args, lastMessageFile } = this.baseArgs(opts, { cd: true });
    args.push("-");
    const { stdout } = await this.run(args, null, prompt);
    const threadId = parseThreadId(stdout);
    if (!threadId) throw new UnreachableError("codex exec did not report a thread id");
    return { threadId, finalResponse: readAndUnlink(lastMessageFile) };
  }

  async probe(): Promise<boolean> {
    try {
      await this.spawnCollect(["--version"], 10_000);
      return true;
    } catch {
      return false;
    }
  }

  private baseArgs(
    opts: DeliveryOptions,
    flags: { cd?: boolean } = {},
  ): { args: string[]; lastMessageFile: string } {
    const lastMessageFile = path.join(
      os.tmpdir(),
      `bridgehead-last-message-${process.pid}-${Math.random().toString(36).slice(2)}.txt`,
    );
    const args = [
      "exec",
      "--json",
      "--skip-git-repo-check",
      "--sandbox",
      opts.sandbox,
      "--output-last-message",
      lastMessageFile,
    ];
    if (this.config.model) args.push("--model", this.config.model);
    if (flags.cd && opts.cwd) args.push("--cd", opts.cwd);
    return { args, lastMessageFile };
  }

  private async run(
    args: string[],
    threadId: string | null,
    stdin?: string,
  ): Promise<{ stdout: string }> {
    try {
      return await this.spawnCollect(args, 30 * 60_000, stdin);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/ENOENT/i.test(message)) {
        throw new UnreachableError(`codex CLI not found: ${message}`);
      }
      if (
        threadId &&
        /(no.*(session|thread|conversation).*(found|exists))|not found/i.test(message)
      ) {
        throw new PermanentError(`thread ${threadId} not found: ${message}`);
      }
      throw err instanceof Error ? err : new Error(message);
    }
  }

  private spawnCollect(
    args: string[],
    timeoutMs: number,
    stdin?: string,
  ): Promise<{ stdout: string }> {
    const bin = this.config.codexPath ?? "codex";
    return new Promise((resolve, reject) => {
      const child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"] });
      child.stdin.end(stdin ?? "");
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`codex ${args[0]} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) {
          resolve({ stdout });
        } else {
          this.logger.debug({ code, stderr: stderr.slice(-2000) }, "codex exec failed");
          reject(new Error(`codex exited with code ${code}: ${stderr.slice(-500).trim()}`));
        }
      });
    });
  }
}

/** Find the thread id in a `codex exec --json` JSONL event stream. */
export function parseThreadId(jsonl: string): string | null {
  for (const line of jsonl.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const event = JSON.parse(trimmed) as Record<string, unknown>;
      if (event.type === "thread.started" && typeof event.thread_id === "string") {
        return event.thread_id;
      }
    } catch {
      // non-JSON noise on stdout — ignore
    }
  }
  return null;
}

function readAndUnlink(file: string): string | undefined {
  try {
    const content = fs.readFileSync(file, "utf8");
    fs.unlinkSync(file);
    return content.trim() || undefined;
  } catch {
    return undefined;
  }
}
