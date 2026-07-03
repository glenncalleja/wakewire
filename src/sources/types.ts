import type { BridgeEvent } from "../core/event.js";
import type { Logger } from "../logging.js";

export interface SourceContext {
  emit(event: BridgeEvent): void;
  logger: Logger;
}

/** Pluggable event producer: github-webhook, gmail-imap, slack-socket-mode. */
export interface Source {
  readonly id: string;
  readonly kind: "github" | "gmail" | "slack";
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Small status blob for bridge_status / GET /api/health. */
  status(): Record<string, unknown>;
}
