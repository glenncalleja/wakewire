import { describe, expect, it } from "vitest";
import { coerceTimestamp, mapWebhookEvent, valueAt } from "./map.js";

describe("valueAt", () => {
  const obj = { a: { b: [{ c: "deep" }, { c: "deeper" }] }, top: 5 };

  it("resolves nested objects and array indices", () => {
    expect(valueAt(obj, "a.b.1.c")).toBe("deeper");
    expect(valueAt(obj, "top")).toBe(5);
    expect(valueAt(obj, "a.b")).toEqual([{ c: "deep" }, { c: "deeper" }]);
  });

  it("returns undefined for misses without throwing", () => {
    expect(valueAt(obj, "a.x.y")).toBeUndefined();
    expect(valueAt(obj, "a.b.zz.c")).toBeUndefined();
    expect(valueAt(obj, "top.deeper")).toBeUndefined();
    expect(valueAt(null, "a")).toBeUndefined();
  });
});

describe("coerceTimestamp", () => {
  it("handles ISO strings, epoch seconds, and epoch millis", () => {
    expect(coerceTimestamp("2026-07-03T10:00:00Z")).toBe("2026-07-03T10:00:00.000Z");
    expect(coerceTimestamp(1751551200)).toBe("2025-07-03T14:00:00.000Z");
    expect(coerceTimestamp(1751551200000)).toBe("2025-07-03T14:00:00.000Z");
    expect(coerceTimestamp("1751551200")).toBe("2025-07-03T14:00:00.000Z");
  });

  it("returns null for garbage", () => {
    expect(coerceTimestamp("not a date")).toBeNull();
    expect(coerceTimestamp(undefined)).toBeNull();
    expect(coerceTimestamp(-5)).toBeNull();
  });
});

describe("mapWebhookEvent", () => {
  const sentryish = {
    id: "evt_42",
    action: "issue.created",
    created_at: "2026-07-03T10:00:00Z",
    data: {
      issue: { title: "TypeError in checkout", level: "error", url: "https://x/1" },
      internal: { apiKey: "SECRET-DO-NOT-LEAK" },
    },
  };

  it("maps ids, kind, timestamp, and whitelisted fields only", () => {
    const event = mapWebhookEvent({
      provider: "sentry",
      mapping: {
        deliveryId: "id",
        kind: "action",
        occurredAt: "created_at",
        summary: "{{level}}: {{title}}",
        fields: { title: "data.issue.title", level: "data.issue.level", url: "data.issue.url" },
      },
      body: sentryish,
      rawBody: JSON.stringify(sentryish),
    });
    expect(event).toMatchObject({
      source: "webhook",
      kind: "issue.created",
      deliveryId: "evt_42",
      occurredAt: "2026-07-03T10:00:00.000Z",
      summary: "error: TypeError in checkout",
    });
    expect(event.payload).toEqual({
      provider: "sentry",
      title: "TypeError in checkout",
      level: "error",
      url: "https://x/1",
    });
    expect(JSON.stringify(event)).not.toContain("SECRET-DO-NOT-LEAK");
  });

  it("survives with no mapping at all (capture-mode events still flow)", () => {
    const event = mapWebhookEvent({
      provider: "grafana",
      mapping: undefined,
      body: { anything: true },
      rawBody: '{"anything":true}',
    });
    expect(event.kind).toBe("event");
    expect(event.deliveryId).toMatch(/^hash-[0-9a-f]{32}$/);
    expect(event.summary).toBe("grafana event event");
    expect(event.payload).toEqual({ provider: "grafana" });
  });

  it("prefers the header delivery id over body paths and hash (Linear-Delivery style)", () => {
    const event = mapWebhookEvent({
      provider: "linear",
      mapping: { deliveryIdHeader: "linear-delivery", deliveryId: "webhookId", fields: {} },
      body: { webhookId: "wh-constant" },
      rawBody: '{"webhookId":"wh-constant"}',
      headerDeliveryId: "uuid-per-delivery-1",
    });
    expect(event.deliveryId).toBe("uuid-per-delivery-1");

    // header configured but absent on this request → falls back to body path
    const fallback = mapWebhookEvent({
      provider: "linear",
      mapping: { deliveryIdHeader: "linear-delivery", deliveryId: "id", fields: {} },
      body: { id: "evt-9" },
      rawBody: "{}",
      headerDeliveryId: undefined,
    });
    expect(fallback.deliveryId).toBe("evt-9");
  });

  it("hash delivery ids are stable for identical bodies (dedup) and differ otherwise", () => {
    const a = mapWebhookEvent({ provider: "p", mapping: undefined, body: {}, rawBody: "{'a':1}" });
    const b = mapWebhookEvent({ provider: "p", mapping: undefined, body: {}, rawBody: "{'a':1}" });
    const c = mapWebhookEvent({ provider: "p", mapping: undefined, body: {}, rawBody: "{'a':2}" });
    expect(a.deliveryId).toBe(b.deliveryId);
    expect(a.deliveryId).not.toBe(c.deliveryId);
  });

  it("summary template is lenient: unmapped fields render as empty, never throw", () => {
    const event = mapWebhookEvent({
      provider: "p",
      mapping: { summary: "{{missing}} ok {{provider}}", fields: {} },
      body: {},
      rawBody: "{}",
    });
    expect(event.summary).toBe(" ok p");
  });

  it("truncates long field values and stringifies objects", () => {
    const event = mapWebhookEvent({
      provider: "p",
      mapping: { fields: { big: "big", obj: "obj" } },
      body: { big: "x".repeat(5000), obj: { nested: true } },
      rawBody: "{}",
    });
    expect((event.payload.big as string).length).toBeLessThanOrEqual(2000 + "… [truncated]".length);
    expect(event.payload.obj).toBe('{"nested":true}');
  });
});
