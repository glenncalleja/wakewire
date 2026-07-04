import type { SandboxPolicy } from "../core/route.js";

export interface DeliveryOptions {
  sandbox: SandboxPolicy;
  /** Working directory override (used for new threads; ignored for resume by some adapters). */
  cwd?: string | undefined;
}

export interface DeliveryResult {
  threadId: string;
  turnId?: string | undefined;
  /** Final agent message when the adapter runs the turn to completion (SDK/exec adapters). */
  finalResponse?: string | undefined;
}

/**
 * The one seam between wakewire and any coding agent. v1 ships Codex
 * implementations only; a Claude Code adapter would implement this interface.
 */
export interface AgentAdapter {
  readonly name: string;
  /** Append a turn to an existing thread. */
  deliverToThread(threadId: string, prompt: string, opts: DeliveryOptions): Promise<DeliveryResult>;
  /** Start a new thread in opts.cwd and send the prompt as its first turn. */
  startThread(prompt: string, opts: DeliveryOptions): Promise<DeliveryResult>;
  /** Cheap reachability check — used to decide held-vs-failed and for status reporting. */
  probe(): Promise<boolean>;
}

/** The target thread has a turn in flight. Retry later; never a failure. */
export class BusyError extends Error {}

/** Codex (app-server or CLI) is not reachable. Retry with backoff, forever. */
export class UnreachableError extends Error {}

/** Delivery can never succeed (unknown thread, invalid target). Fail immediately. */
export class PermanentError extends Error {}
