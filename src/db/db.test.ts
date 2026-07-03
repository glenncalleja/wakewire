import DatabaseConstructor from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { openDatabase } from "./db.js";
import { migrate } from "./migrations.js";
import { createStores } from "./repos.js";

describe("migrations", () => {
  it("creates the schema and is idempotent", () => {
    const db = openDatabase(":memory:");
    migrate(db); // second run is a no-op
    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
        name: string;
      }>
    ).map((t) => t.name);
    expect(tables).toEqual(
      expect.arrayContaining(["routes", "deliveries", "sources", "settings", "schema_migrations"]),
    );
  });
});

describe("migration 3 upgrade (source-kind CHECK removal)", () => {
  it("preserves routes, sources, and deliveries across the table rebuild", () => {
    const db = new DatabaseConstructor(":memory:");
    migrate(db, 2); // simulate an installation on the v2 schema
    const stores = createStores(db);
    const route = stores.routes.create({
      name: "old route",
      source: "github",
      match: { repo: "a/b", events: ["push"] },
      target: { type: "thread", threadId: "t-1" },
      sandbox: "read-only",
      rateLimitPerMinute: 3,
      enabled: true,
    });
    stores.sources.upsert({ id: "src-1", kind: "gmail", config: { label: "x" } });
    stores.deliveries.enqueue({
      routeId: route.id,
      event: {
        source: "github",
        kind: "push",
        deliveryId: "d-1",
        occurredAt: "t",
        summary: "s",
        payload: {},
      },
      renderedPrompt: "p",
    });

    migrate(db); // apply v3 rebuild

    const migrated = createStores(db);
    expect(migrated.routes.get(route.id)?.rateLimitPerMinute).toBe(3);
    expect(migrated.sources.get("src-1")?.config.label).toBe("x");
    expect(migrated.deliveries.list({}).length).toBe(1);
    // and the rebuilt table accepts the new source kind
    expect(() =>
      migrated.sources.upsert({ id: "src-2", kind: "slack", config: { team: "default" } }),
    ).not.toThrow();
    expect(() =>
      migrated.routes.create({
        name: "slack route",
        source: "slack",
        match: { events: ["app_mention"] },
        target: { type: "thread", threadId: "t-1" },
        sandbox: "read-only",
        enabled: true,
      }),
    ).not.toThrow();
  });
});

describe("stores", () => {
  it("round-trips routes with JSON columns", () => {
    const stores = createStores(openDatabase(":memory:"));
    const route = stores.routes.create({
      name: "r",
      source: "github",
      match: { repo: "a/b", events: ["push"] },
      target: { type: "thread", threadId: "t-1" },
      sandbox: "read-only",
      enabled: true,
    });
    const loaded = stores.routes.get(route.id);
    expect(loaded?.match).toEqual({ repo: "a/b", events: ["push"] });
    expect(loaded?.target).toEqual({ type: "thread", threadId: "t-1" });
    expect(stores.routes.list()).toHaveLength(1);
    expect(stores.routes.remove(route.id)).toBe(true);
    expect(stores.routes.list()).toHaveLength(0);
  });

  it("settings getOrCreate only creates once", () => {
    const stores = createStores(openDatabase(":memory:"));
    let calls = 0;
    const make = () => {
      calls++;
      return "token-value";
    };
    expect(stores.settings.getOrCreate("k", make)).toBe("token-value");
    expect(stores.settings.getOrCreate("k", make)).toBe("token-value");
    expect(calls).toBe(1);
  });

  it("sources upsert preserves ids and updates configs", () => {
    const stores = createStores(openDatabase(":memory:"));
    const created = stores.sources.upsert({ kind: "gmail", config: { label: "a" } });
    const updated = stores.sources.upsert({
      id: created.id,
      kind: "gmail",
      config: { label: "b" },
    });
    expect(updated.id).toBe(created.id);
    expect(stores.sources.list()).toHaveLength(1);
    expect(stores.sources.get(created.id)?.config.label).toBe("b");
  });
});
