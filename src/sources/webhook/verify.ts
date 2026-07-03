import crypto from "node:crypto";
import { z } from "zod";

/**
 * Verification presets for generic webhook sources. Two shapes cover almost
 * every provider:
 *
 * - hmac-sha256: HMAC of the raw body, sent in a header, optionally prefixed
 *   (GitHub-style "sha256=…", Linear, Sentry, ClickUp).
 * - secret-header: a shared secret sent verbatim in a header (Grafana,
 *   homegrown apps).
 *
 * There is deliberately no "none": every generic source has a secret. Plain
 * HMAC is replayable by design; dedup by delivery id blunts that (SECURITY.md).
 */
export const WebhookVerificationSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("hmac-sha256"),
    /** Header carrying the signature, e.g. "linear-signature", "x-signature". */
    header: z.string().min(1),
    /** Literal prefix to strip, e.g. "sha256=". */
    prefix: z.string().default(""),
    encoding: z.enum(["hex", "base64"]).default("hex"),
  }),
  z.object({
    kind: z.literal("secret-header"),
    /** Header that must equal the shared secret, e.g. "x-webhook-token". */
    header: z.string().min(1),
  }),
]);

export type WebhookVerification = z.infer<typeof WebhookVerificationSchema>;

export function verifyWebhook(
  verification: WebhookVerification,
  secret: string,
  rawBody: string,
  headerValue: string | undefined,
): boolean {
  if (!headerValue) return false;
  if (verification.kind === "secret-header") {
    return timingSafeEqual(headerValue, secret);
  }
  if (!headerValue.startsWith(verification.prefix)) return false;
  const presented = headerValue.slice(verification.prefix.length);
  const expected = crypto
    .createHmac("sha256", secret)
    .update(rawBody)
    .digest(verification.encoding);
  return timingSafeEqual(presented, expected);
}

function timingSafeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}
