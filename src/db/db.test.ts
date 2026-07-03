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
