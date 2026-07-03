import crypto from "node:crypto";
import type { Database } from "better-sqlite3";
import type { BridgeEvent } from "../core/event.js";
import { BridgeEventSchema } from "../core/event.js";
import type { Route, RouteInput, RouteTarget, SandboxPolicy } from "../core/route.js";

export type DeliveryStatus =
  | "received"
  | "queued"
  | "delivering"
  | "delivered"
  | "failed"
  | "skipped-duplicate"
  | "held"
  | "coalesced";

export interface Delivery {
  id: string;
  routeId: string;
  sourceDeliveryId: string;
  receivedAt: string;
  status: DeliveryStatus;
  attemptCount: number;
  nextAttemptAt: string | null;
  event: BridgeEvent;
  renderedPrompt: string | null;
  threadId: string | null;
  turnId: string | null;
  error: string | null;
  coalescedInto: string | null;
  isReplay: boolean;
  updatedAt: string;
}

export type SourceKind = "github" | "gmail" | "slack";

export interface SourceRecord {
  id: string;
  kind: SourceKind;
  config: Record<string, unknown>;
  enabled: boolean;
}

interface RouteRow {
  id: string;
  name: string;
  source_kind: string;
  match_json: string;
  target_json: string;
  prompt_template: string | null;
  sandbox_policy: string;
  rate_limit_per_minute: number | null;
  enabled: number;
  created_at: string;
}

interface DeliveryRow {
  id: string;
  route_id: string;
  source_delivery_id: string;
  received_at: string;
  status: string;
  attempt_count: number;
  next_attempt_at: string | null;
  event_json: string;
  rendered_prompt: string | null;
  thread_id: string | null;
  turn_id: string | null;
  error: string | null;
  coalesced_into: string | null;
  is_replay: number;
  updated_at: string;
}

interface SourceRow {
  id: string;
  kind: string;
  config_json: string;
  enabled: number;
}

function nowIso(): string {
  return new Date().toISOString();
}

export class RouteStore {
  constructor(private readonly db: Database) {}

  create(input: RouteInput): Route {
    const id = crypto.randomUUID();
    const createdAt = nowIso();
    this.db
      .prepare(
        `INSERT INTO routes (id, name, source_kind, match_json, target_json, prompt_template, sandbox_policy, rate_limit_per_minute, enabled, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.name,
        input.source,
        JSON.stringify(input.match),
        JSON.stringify(input.target),
        input.promptTemplate ?? null,
        input.sandbox,
        input.rateLimitPerMinute ?? null,
        input.enabled ? 1 : 0,
        createdAt,
      );
    const route = this.get(id);
    if (!route) throw new Error("route insert failed");
    return route;
  }

  get(id: string): Route | null {
    const row = this.db.prepare("SELECT * FROM routes WHERE id = ?").get(id) as
      | RouteRow
      | undefined;
    return row ? toRoute(row) : null;
  }

  list(): Route[] {
    const rows = this.db.prepare("SELECT * FROM routes ORDER BY created_at").all() as RouteRow[];
    return rows.map(toRoute);
  }

  listEnabled(): Route[] {
    return this.list().filter((r) => r.enabled);
  }

  setEnabled(id: string, enabled: boolean): boolean {
    const result = this.db
      .prepare("UPDATE routes SET enabled = ? WHERE id = ?")
      .run(enabled ? 1 : 0, id);
    return result.changes > 0;
  }

  remove(id: string): boolean {
    // Deliveries reference routes; keep history but detach is not possible with FK.
    // Deleting a route deletes its delivery history intentionally.
    const run = this.db.transaction(() => {
      this.db.prepare("DELETE FROM deliveries WHERE route_id = ?").run(id);
      return this.db.prepare("DELETE FROM routes WHERE id = ?").run(id).changes > 0;
    });
    return run();
  }
}

function toRoute(row: RouteRow): Route {
  return {
    id: row.id,
    name: row.name,
    source: row.source_kind as Route["source"],
    match: JSON.parse(row.match_json),
    target: JSON.parse(row.target_json) as RouteTarget,
    promptTemplate: row.prompt_template,
    sandbox: row.sandbox_policy as SandboxPolicy,
    rateLimitPerMinute: row.rate_limit_per_minute,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
  };
}

export class DeliveryStore {
  constructor(private readonly db: Database) {}

  /**
   * Insert a new delivery in `queued` status. If the same (route, source
   * delivery id) was already recorded, a `skipped-duplicate` row is written
   * instead and null is returned.
   */
  enqueue(args: {
    routeId: string;
    event: BridgeEvent;
    renderedPrompt: string;
    isReplay?: boolean;
  }): Delivery | null {
    const id = crypto.randomUUID();
    const now = nowIso();
    try {
      this.db
        .prepare(
          `INSERT INTO deliveries (id, route_id, source_delivery_id, received_at, status, attempt_count, next_attempt_at, event_json, rendered_prompt, is_replay, updated_at)
           VALUES (?, ?, ?, ?, 'queued', 0, NULL, ?, ?, ?, ?)`,
        )
        .run(
          id,
          args.routeId,
          args.event.deliveryId,
          now,
          JSON.stringify(args.event),
          args.renderedPrompt,
          args.isReplay ? 1 : 0,
          now,
        );
    } catch (err) {
      if (isUniqueViolation(err)) {
        this.db
          .prepare(
            `INSERT INTO deliveries (id, route_id, source_delivery_id, received_at, status, attempt_count, event_json, updated_at)
             VALUES (?, ?, ?, ?, 'skipped-duplicate', 0, ?, ?)`,
          )
          .run(id, args.routeId, args.event.deliveryId, now, JSON.stringify(args.event), now);
        return null;
      }
      throw err;
    }
    const created = this.get(id);
    if (!created) throw new Error("delivery insert failed");
    return created;
  }

  get(id: string): Delivery | null {
    const row = this.db.prepare("SELECT * FROM deliveries WHERE id = ?").get(id) as
      | DeliveryRow
      | undefined;
    return row ? toDelivery(row) : null;
  }

  /** Deliveries ready to attempt now (queued or held whose backoff expired), oldest first. */
  listReady(nowIsoStr: string = nowIso()): Delivery[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM deliveries
         WHERE status IN ('queued', 'held') AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
         ORDER BY received_at ASC`,
      )
      .all(nowIsoStr) as DeliveryRow[];
    return rows.map(toDelivery);
  }

  /** All deliveries currently waiting (for queue-depth reporting). */
  countPending(): number {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS n FROM deliveries WHERE status IN ('queued', 'held', 'delivering')",
      )
      .get() as { n: number };
    return row.n;
  }

  list(filter: { limit?: number; routeId?: string; status?: DeliveryStatus }): Delivery[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filter.routeId) {
      clauses.push("route_id = ?");
      params.push(filter.routeId);
    }
    if (filter.status) {
      clauses.push("status = ?");
      params.push(filter.status);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(`SELECT * FROM deliveries ${where} ORDER BY received_at DESC LIMIT ?`)
      .all(...params, Math.min(filter.limit ?? 50, 500)) as DeliveryRow[];
    return rows.map(toDelivery);
  }

  markDelivering(id: string): void {
    this.update(id, { status: "delivering" });
  }

  markDelivered(id: string, result: { threadId: string; turnId?: string | undefined }): void {
    this.db
      .prepare(
        `UPDATE deliveries SET status = 'delivered', thread_id = ?, turn_id = ?, error = NULL, updated_at = ? WHERE id = ?`,
      )
      .run(result.threadId, result.turnId ?? null, nowIso(), id);
  }

  markHeld(id: string, error: string, nextAttemptAt: string): void {
    this.db
      .prepare(
        `UPDATE deliveries SET status = 'held', error = ?, next_attempt_at = ?, attempt_count = attempt_count + 1, updated_at = ? WHERE id = ?`,
      )
      .run(error, nextAttemptAt, nowIso(), id);
  }

  markFailed(id: string, error: string): void {
    this.db
      .prepare(
        `UPDATE deliveries SET status = 'failed', error = ?, next_attempt_at = NULL, updated_at = ? WHERE id = ?`,
      )
      .run(error, nowIso(), id);
  }

  updatePrompt(id: string, renderedPrompt: string): void {
    this.db
      .prepare("UPDATE deliveries SET rendered_prompt = ?, updated_at = ? WHERE id = ?")
      .run(renderedPrompt, nowIso(), id);
  }

  markCoalesced(ids: string[], intoId: string): void {
    const stmt = this.db.prepare(
      `UPDATE deliveries SET status = 'coalesced', coalesced_into = ?, updated_at = ? WHERE id = ?`,
    );
    const run = this.db.transaction(() => {
      for (const id of ids) stmt.run(intoId, nowIso(), id);
    });
    run();
  }

  /** Count deliveries attempted for a route within the trailing window (rate limiting). */
  countRecentAttempts(routeId: string, sinceIso: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM deliveries
         WHERE route_id = ? AND updated_at >= ? AND status IN ('delivered', 'delivering')`,
      )
      .get(routeId, sinceIso) as { n: number };
    return row.n;
  }

  /** Crash recovery: anything stuck in 'delivering' from a previous run goes back to queued. */
  resetInFlight(): number {
    return this.db
      .prepare(
        `UPDATE deliveries SET status = 'queued', updated_at = ? WHERE status = 'delivering'`,
      )
      .run(nowIso()).changes;
  }

  private update(id: string, fields: { status: DeliveryStatus }): void {
    this.db
      .prepare("UPDATE deliveries SET status = ?, updated_at = ? WHERE id = ?")
      .run(fields.status, nowIso(), id);
  }
}

function toDelivery(row: DeliveryRow): Delivery {
  return {
    id: row.id,
    routeId: row.route_id,
    sourceDeliveryId: row.source_delivery_id,
    receivedAt: row.received_at,
    status: row.status as DeliveryStatus,
    attemptCount: row.attempt_count,
    nextAttemptAt: row.next_attempt_at,
    event: BridgeEventSchema.parse(JSON.parse(row.event_json)),
    renderedPrompt: row.rendered_prompt,
    threadId: row.thread_id,
    turnId: row.turn_id,
    error: row.error,
    coalescedInto: row.coalesced_into,
    isReplay: row.is_replay === 1,
    updatedAt: row.updated_at,
  };
}

function isUniqueViolation(err: unknown): boolean {
  return (
    err instanceof Error &&
    "code" in err &&
    (err as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE"
  );
}

export class SourceStore {
  constructor(private readonly db: Database) {}

  upsert(record: {
    id?: string;
    kind: SourceKind;
    config: Record<string, unknown>;
    enabled?: boolean;
  }): SourceRecord {
    const id = record.id ?? crypto.randomUUID();
    this.db
      .prepare(
        `INSERT INTO sources (id, kind, config_json, enabled) VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, config_json = excluded.config_json, enabled = excluded.enabled`,
      )
      .run(id, record.kind, JSON.stringify(record.config), (record.enabled ?? true) ? 1 : 0);
    const created = this.get(id);
    if (!created) throw new Error("source upsert failed");
    return created;
  }

  get(id: string): SourceRecord | null {
    const row = this.db.prepare("SELECT * FROM sources WHERE id = ?").get(id) as
      | SourceRow
      | undefined;
    return row ? toSource(row) : null;
  }

  list(): SourceRecord[] {
    const rows = this.db.prepare("SELECT * FROM sources").all() as SourceRow[];
    return rows.map(toSource);
  }

  listEnabled(): SourceRecord[] {
    return this.list().filter((s) => s.enabled);
  }

  findByKind(kind: SourceKind): SourceRecord[] {
    return this.list().filter((s) => s.kind === kind);
  }

  setEnabled(id: string, enabled: boolean): boolean {
    return (
      this.db.prepare("UPDATE sources SET enabled = ? WHERE id = ?").run(enabled ? 1 : 0, id)
        .changes > 0
    );
  }

  remove(id: string): boolean {
    return this.db.prepare("DELETE FROM sources WHERE id = ?").run(id).changes > 0;
  }
}

function toSource(row: SourceRow): SourceRecord {
  return {
    id: row.id,
    kind: row.kind as SourceRecord["kind"],
    config: JSON.parse(row.config_json),
    enabled: row.enabled === 1,
  };
}

export class SettingsStore {
  constructor(private readonly db: Database) {}

  get(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  set(key: string, value: string): void {
    this.db
      .prepare(
        "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(key, value);
  }

  getOrCreate(key: string, create: () => string): string {
    const existing = this.get(key);
    if (existing !== null) return existing;
    const value = create();
    this.set(key, value);
    return value;
  }
}

export interface Stores {
  routes: RouteStore;
  deliveries: DeliveryStore;
  sources: SourceStore;
  settings: SettingsStore;
}

export function createStores(db: Database): Stores {
  return {
    routes: new RouteStore(db),
    deliveries: new DeliveryStore(db),
    sources: new SourceStore(db),
    settings: new SettingsStore(db),
  };
}
