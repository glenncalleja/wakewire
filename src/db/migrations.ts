import type { Database } from "better-sqlite3";

/**
 * Append-only list of migrations. Each entry runs once, inside a transaction,
 * tracked in schema_migrations. Never edit a shipped migration — add a new one.
 * disableForeignKeys is for table rebuilds (SQLite cannot alter constraints).
 */
const MIGRATIONS: ReadonlyArray<{
  version: number;
  name: string;
  sql: string;
  disableForeignKeys?: boolean;
}> = [
  {
    version: 1,
    name: "initial",
    sql: `
      CREATE TABLE routes (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        source_kind TEXT NOT NULL CHECK (source_kind IN ('github', 'gmail')),
        match_json TEXT NOT NULL,
        target_json TEXT NOT NULL,
        prompt_template TEXT,
        sandbox_policy TEXT NOT NULL DEFAULT 'read-only'
          CHECK (sandbox_policy IN ('read-only', 'workspace-write')),
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL
      );

      CREATE TABLE deliveries (
        id TEXT PRIMARY KEY,
        route_id TEXT NOT NULL REFERENCES routes(id),
        source_delivery_id TEXT NOT NULL,
        received_at TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN (
          'received', 'queued', 'delivering', 'delivered',
          'failed', 'skipped-duplicate', 'held', 'coalesced'
        )),
        attempt_count INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT,
        event_json TEXT NOT NULL,
        rendered_prompt TEXT,
        thread_id TEXT,
        turn_id TEXT,
        error TEXT,
        coalesced_into TEXT REFERENCES deliveries(id),
        is_replay INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );

      -- Dedup: one live delivery per (route, source delivery id). Rows that only
      -- record a skipped duplicate or a replay are excluded from the constraint.
      CREATE UNIQUE INDEX deliveries_dedup
        ON deliveries (route_id, source_delivery_id)
        WHERE status NOT IN ('skipped-duplicate') AND is_replay = 0;

      CREATE INDEX deliveries_status ON deliveries (status, next_attempt_at);
      CREATE INDEX deliveries_route ON deliveries (route_id, received_at);

      CREATE TABLE sources (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('github', 'gmail')),
        config_json TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1
      );

      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `,
  },
  {
    version: 2,
    name: "route-rate-limit",
    sql: `
      ALTER TABLE routes ADD COLUMN rate_limit_per_minute INTEGER;
    `,
  },
  {
    // Source kinds are an extensible enum (slack joined github/gmail) and are
    // validated by zod at the boundaries; baking them into CHECK constraints
    // was a mistake. Rebuild routes and sources without the kind CHECKs.
    version: 3,
    name: "drop-source-kind-checks",
    disableForeignKeys: true,
    sql: `
      CREATE TABLE routes_new (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        source_kind TEXT NOT NULL,
        match_json TEXT NOT NULL,
        target_json TEXT NOT NULL,
        prompt_template TEXT,
        sandbox_policy TEXT NOT NULL DEFAULT 'read-only'
          CHECK (sandbox_policy IN ('read-only', 'workspace-write')),
        rate_limit_per_minute INTEGER,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL
      );
      INSERT INTO routes_new (id, name, source_kind, match_json, target_json, prompt_template, sandbox_policy, rate_limit_per_minute, enabled, created_at)
        SELECT id, name, source_kind, match_json, target_json, prompt_template, sandbox_policy, rate_limit_per_minute, enabled, created_at FROM routes;
      DROP TABLE routes;
      ALTER TABLE routes_new RENAME TO routes;

      CREATE TABLE sources_new (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        config_json TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1
      );
      INSERT INTO sources_new (id, kind, config_json, enabled)
        SELECT id, kind, config_json, enabled FROM sources;
      DROP TABLE sources;
      ALTER TABLE sources_new RENAME TO sources;
    `,
  },
  {
    // Capture mode for generic webhook sources: the first few raw payloads are
    // stored so the model can inspect a real event and author the field mapping.
    version: 4,
    name: "webhook-captures",
    sql: `
      CREATE TABLE captures (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL,
        received_at TEXT NOT NULL,
        body TEXT NOT NULL
      );
      CREATE INDEX captures_source ON captures (source_id, received_at);
    `,
  },
];

/** targetVersion is for tests that need to exercise upgrade paths from older schemas. */
export function migrate(db: Database, targetVersion = Number.POSITIVE_INFINITY): void {
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)",
  );
  const applied = new Set(
    (db.prepare("SELECT version FROM schema_migrations").all() as Array<{ version: number }>).map(
      (r) => r.version,
    ),
  );
  for (const migration of MIGRATIONS) {
    if (migration.version > targetVersion) break;
    if (applied.has(migration.version)) continue;
    if (migration.disableForeignKeys) db.pragma("foreign_keys = OFF");
    try {
      const run = db.transaction(() => {
        db.exec(migration.sql);
        db.prepare(
          "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
        ).run(migration.version, migration.name, new Date().toISOString());
      });
      run();
    } finally {
      if (migration.disableForeignKeys) db.pragma("foreign_keys = ON");
    }
    if (migration.disableForeignKeys) {
      const violations = db.pragma("foreign_key_check") as unknown[];
      if (violations.length > 0) {
        throw new Error(`migration ${migration.version} left foreign key violations`);
      }
    }
  }
}
