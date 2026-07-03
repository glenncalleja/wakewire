import type { BridgeEvent } from "../core/event.js";
import type { Logger } from "../logging.js";

export interface SourceContext {
  emit(event: BridgeEvent): void;
  logger: Logger;
}

/** Pluggable event producer. v1: github-webhook, gmail-imap. */
export interface Source {
  readonly id: string;
  readonly kind: "github" | "gmail";
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Small status blob for bridge_status / GET /api/health. */
  status(): Record<string, unknown>;
}
