import crypto from "node:crypto";
import { z } from "zod";
import type { BridgeEvent } from "../../core/event.js";

const FIELD_VALUE_LIMIT = 2_000;

/**
 * Declarative payload mapping — deliberately tiny: dot-paths (with numeric
 * array segments) and a summary template over the mapped fields. The mapping
 * doubles as the trim whitelist: only mapped fields ever reach the model.
 */
export const WebhookMappingSchema = z.object({
  /**
   * HTTP header carrying a unique delivery id (e.g. Linear-Delivery).
   * Checked before deliveryId. Headers are relayed by smee, so this works in
   * both transport modes.
   */
  deliveryIdHeader: z.string().min(1).optional(),
  /** Path to a unique event id in the body. Fallback: hash of the raw body. */
  deliveryId: z.string().min(1).optional(),
  /** Path to an event type/name. Fallback: "event". */
  kind: z.string().min(1).optional(),
  /** Path to a timestamp (ISO 8601, epoch seconds, or epoch millis). Fallback: arrival time. */
  occurredAt: z.string().min(1).optional(),
  /** One-line summary template over mapped field aliases, e.g. "{{level}}: {{title}}". */
  summary: z.string().max(500).optional(),
  /** alias → dot.path extractions. THIS is the payload the model will see. */
  fields: z
    .record(z.string().regex(/^\w+$/, "aliases must be word characters"), z.string().min(1))
    .default({}),
});

export type WebhookMapping = z.infer<typeof WebhookMappingSchema>;

export function mapWebhookEvent(args: {
  provider: string;
  mapping: WebhookMapping | undefined;
  body: Record<string, unknown>;
  rawBody: string;
  /** Value of mapping.deliveryIdHeader, resolved by the source. */
  headerDeliveryId?: string | undefined;
}): BridgeEvent {
  const { provider, mapping, body, rawBody, headerDeliveryId } = args;
  const kind = scalarAt(body, mapping?.kind) || "event";
  const deliveryId =
    (headerDeliveryId ? truncate(headerDeliveryId, 200) : "") ||
    scalarAt(body, mapping?.deliveryId) ||
    `hash-${crypto.createHash("sha256").update(rawBody).digest("hex").slice(0, 32)}`;
  const occurredAt =
    coerceTimestamp(valueAt(body, mapping?.occurredAt)) ?? new Date().toISOString();

  const fields: Record<string, string> = {};
  for (const [alias, path] of Object.entries(mapping?.fields ?? {})) {
    const value = valueAt(body, path);
    if (value === undefined || value === null) continue;
    const text =
      typeof value === "object"
        ? JSON.stringify(value)
        : String(value as string | number | boolean);
    fields[alias] = truncate(text, FIELD_VALUE_LIMIT);
  }

  const summary = mapping?.summary
    ? renderLenient(mapping.summary, { ...fields, provider, kind })
    : `${provider} ${kind} event`;

  return {
    source: "webhook",
    kind,
    deliveryId,
    occurredAt,
    summary: truncate(summary, 300),
    payload: { provider, ...fields },
  };
}

/** "a.b.0.c" — objects and array indices only; anything else is undefined. */
export function valueAt(obj: unknown, path: string | undefined): unknown {
  if (!path) return undefined;
  let current: unknown = obj;
  for (const segment of path.split(".")) {
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index)) return undefined;
      current = current[index];
    } else if (current !== null && typeof current === "object") {
      current = (current as Record<string, unknown>)[segment];
    } else {
      return undefined;
    }
  }
  return current;
}

function scalarAt(obj: unknown, path: string | undefined): string {
  const value = valueAt(obj, path);
  if (typeof value === "string") return truncate(value, 200);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

/**
 * Unlike route templates (strict, user-authored against a known whitelist),
 * source summary templates render leniently: an unmapped field becomes "",
 * because a mapping typo must never make events undeliverable.
 */
function renderLenient(template: string, fields: Record<string, string>): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_whole, name: string) => fields[name] ?? "");
}

export function coerceTimestamp(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return epochToIso(value);
  }
  if (typeof value === "string" && value.trim() !== "") {
    const asNumber = Number(value);
    if (Number.isFinite(asNumber) && asNumber > 0 && /^\d+(\.\d+)?$/.test(value.trim())) {
      return epochToIso(asNumber);
    }
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();
  }
  return null;
}

function epochToIso(value: number): string | null {
  const ms = value >= 1e12 ? value : value * 1000; // heuristics: ≥1e12 is millis
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}… [truncated]`;
}
