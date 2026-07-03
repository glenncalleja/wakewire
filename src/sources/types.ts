import type { BridgeEvent } from "../core/event.js";
import type { Logger } from "../logging.js";

export interface SourceContext {
  /**
   * Contract: emit is SYNCHRONOUS through route matching and the SQLite
   * enqueue. Sources rely on this — e.g. the Slack source acks its envelope
   * only after emit returns, treating "emit returned" as "durably queued".
   */
  emit(event: BridgeEvent): void;
  logger: Logger;
}

/** Pluggable event producer: github-webhook, gmail-imap, slack-socket-mode, generic webhook. */
export interface Source {
  readonly id: string;
  readonly kind: "github" | "gmail" | "slack" | "webhook";
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Small status blob for bridge_status / GET /api/health. */
  status(): Record<string, unknown>;
}
