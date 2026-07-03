import type { Database } from "better-sqlite3";

/**
 * Append-only list of migrations. Each entry runs once, inside a transaction,
 * tracked in schema_migrations. Never edit a shipped migration — add a new one.
 */
const MIGRATIONS: ReadonlyArray<{ version: number; name: string; sql: string }> = [
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
];

export function migrate(db: Database): void {
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
    if (applied.has(migration.version)) continue;
    const run = db.transaction(() => {
      db.exec(migration.sql);
      db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(
        migration.version,
        migration.name,
        new Date().toISOString(),
      );
    });
    run();
  }
}
