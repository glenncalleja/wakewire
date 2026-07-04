import { z } from "zod";

/**
 * Normalized event emitted by every source. Payloads are already trimmed by the
 * source (see sources/github/trim.ts and sources/gmail/extract.ts) — the queue
 * and sink never see raw provider payloads.
 */
export const WakeEventSchema = z.object({
  source: z.enum(["github", "gmail", "slack", "webhook"]),
  /** e.g. "push", "pull_request.opened", "email", "app_mention", "message" */
  kind: z.string().min(1),
  /** Source-native unique id: X-GitHub-Delivery, RFC 5322 Message-ID. */
  deliveryId: z.string().min(1),
  /** ISO 8601, UTC. */
  occurredAt: z.string(),
  /** One-line human summary, built by the source. */
  summary: z.string(),
  /** Trimmed, source-specific payload. Treated as untrusted data everywhere. */
  payload: z.record(z.string(), z.unknown()),
});

export type WakeEvent = z.infer<typeof WakeEventSchema>;
