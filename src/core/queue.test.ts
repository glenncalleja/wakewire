import pino from "pino";
import { beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "../db/db.js";
import { createStores, type Stores } from "../db/repos.js";
import type { AgentAdapter, DeliveryOptions, DeliveryResult } from "../sinks/types.js";
import { BusyError, PermanentError, UnreachableError } from "../sinks/types.js";
import type { BridgeEvent } from "./event.js";
import { DeliveryQueue } from "./queue.js";
import type { Route, RouteInput } from "./route.js";

const logger = pino({ level: "silent" });

class FakeAdapter implements AgentAdapter {
  readonly name = "fake";
  calls: Array<{
    kind: "resume" | "start";
    threadId?: string;
    prompt: string;
    opts: DeliveryOptions;
  }> = [];
  failWith: Error | null = null;
  failTimes = 0;
  private gate: Promise<void> | null = null;
  private openGate: (() => void) | null = null;

  block(): void {
    this.gate = new Promise((resolve) => {
      this.openGate = resolve;
    });
  }

  unblock(): void {
    this.openGate?.();
    this.gate = null;
  }

  async deliverToThread(
    threadId: string,
    prompt: string,
    opts: DeliveryOptions,
  ): Promise<DeliveryResult> {
    this.calls.push({ kind: "resume", threadId, prompt, opts });
    if (this.gate) await this.gate;
    this.maybeFail();
    return { threadId, turnId: `turn-${this.calls.length}` };
  }

  async startThread(prompt: string, opts: DeliveryOptions): Promise<DeliveryResult> {
    this.calls.push({ kind: "start", prompt, opts });
    if (this.gate) await this.gate;
    this.maybeFail();
    return { threadId: `new-thread-${this.calls.length}` };
  }

  async probe(): Promise<boolean> {
    return true;
  }

  /** Throws failWith while failTimes > 0 (set to MAX_SAFE_INTEGER for "always"). */
  private maybeFail(): void {
    if (this.failWith && this.failTimes > 0) {
      this.failTimes--;
      throw this.failWith;
    }
  }
}

function makeEvent(deliveryId: string, extra: Record<string, unknown> = {}): BridgeEvent {
  return {
    source: "github",
    kind: "push",
    deliveryId,
    occurredAt: new Date().toISOString(),
    summary: `push ${deliveryId}`,
    payload: { repo: "acme/api", branch: "main", ...extra },
  };
}

function routeInput(overrides: Partial<RouteInput> = {}): RouteInput {
  return {
    name: "test route",
    source: "github",
    match: { repo: "acme/api", events: ["push"] },
    target: { type: "thread", threadId: "thread-1" },
    sandbox: "read-only",
    enabled: true,
    ...overrides,
  } as RouteInput;
}

describe("DeliveryQueue", () => {
  let stores: Stores;
  let adapter: FakeAdapter;
  let now: Date;
  let queue: DeliveryQueue;
  let route: Route;

  beforeEach(() => {
    const db = openDatabase(":memory:");
    stores = createStores(db);
    adapter = new FakeAdapter();
    now = new Date("2026-07-03T10:00:00.000Z");
    queue = new DeliveryQueue(stores, adapter, logger, {
      now: () => now,
      ratePerMinute: 10,
      maxAttempts: 3,
      autoWake: false,
    });
    route = stores.routes.create(routeInput());
  });

  it("delivers a queued event with the safety envelope and route sandbox", async () => {
    const delivery = queue.enqueueEvent(route, makeEvent("d-1"));
    expect(delivery?.status).toBe("queued");
    await queue.tick();

    expect(adapter.calls).toHaveLength(1);
    const call = adapter.calls[0];
    expect(call?.threadId).toBe("thread-1");
    expect(call?.opts.sandbox).toBe("read-only");
    expect(call?.prompt).toContain("UNTRUSTED EVENT DATA");

    const stored = stores.deliveries.get(delivery?.id ?? "");
    expect(stored?.status).toBe("delivered");
    expect(stored?.threadId).toBe("thread-1");
    expect(stored?.turnId).toBe("turn-1");
  });

  it("dedups by source delivery id and records the skip", async () => {
    queue.enqueueEvent(route, makeEvent("dup"));
    const second = queue.enqueueEvent(route, makeEvent("dup"));
    expect(second).toBeNull();
    await queue.tick();
    expect(adapter.calls).toHaveLength(1);
    const skipped = stores.deliveries.list({ status: "skipped-duplicate" });
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.sourceDeliveryId).toBe("dup");
  });

  it("replay bypasses dedup and re-renders", async () => {
    const original = queue.enqueueEvent(route, makeEvent("d-replay"));
    await queue.tick();
    const replayed = queue.replay(original?.id ?? "");
    expect(replayed.isReplay).toBe(true);
    await queue.tick();
    expect(adapter.calls).toHaveLength(2);
  });

  it("keeps strict per-thread FIFO: one in flight, order preserved", async () => {
    const first = queue.enqueueEvent(route, makeEvent("d-a"));
    adapter.block();
    const firstTick = queue.tick();
    queue.enqueueEvent(route, makeEvent("d-b"));
    await queue.tick(); // first still in flight — d-b must wait
    expect(adapter.calls).toHaveLength(1);
    adapter.unblock();
    await firstTick;
    await queue.tick();
    expect(adapter.calls).toHaveLength(2);
    expect(adapter.calls.map((c) => promptDeliveryId(c.prompt))).toEqual(["d-a", "d-b"]);
    expect(stores.deliveries.get(first?.id ?? "")?.status).toBe("delivered");
  });

  it("holds and retries with backoff on BusyError, forever", async () => {
    adapter.failWith = new BusyError("turn in flight");
    adapter.failTimes = Number.MAX_SAFE_INTEGER;
    const delivery = queue.enqueueEvent(route, makeEvent("d-busy"));
    await queue.tick();
    let stored = stores.deliveries.get(delivery?.id ?? "");
    expect(stored?.status).toBe("held");
    expect(stored?.attemptCount).toBe(1);
    expect(new Date(stored?.nextAttemptAt ?? 0).getTime()).toBeGreaterThan(now.getTime());

    // before the backoff expires nothing happens
    await queue.tick();
    expect(adapter.calls).toHaveLength(1);

    // after 5 more failures the backoff is capped at 60s
    for (let i = 0; i < 8; i++) {
      now = new Date(now.getTime() + 120_000);
      await queue.tick();
    }
    stored = stores.deliveries.get(delivery?.id ?? "");
    expect(stored?.status).toBe("held"); // busy retries never become failures
    expect(stored?.attemptCount).toBe(9);
    const lastDelay = new Date(stored?.nextAttemptAt ?? 0).getTime() - now.getTime();
    expect(lastDelay).toBeLessThanOrEqual(60_000);

    // codex comes back → delivered
    adapter.failWith = null;
    now = new Date(now.getTime() + 120_000);
    await queue.tick();
    expect(stores.deliveries.get(delivery?.id ?? "")?.status).toBe("delivered");
  });

  it("UnreachableError also retries forever", async () => {
    adapter.failWith = new UnreachableError("app closed");
    adapter.failTimes = Number.MAX_SAFE_INTEGER;
    const delivery = queue.enqueueEvent(route, makeEvent("d-unreachable"));
    for (let i = 0; i < 5; i++) {
      await queue.tick();
      now = new Date(now.getTime() + 120_000);
    }
    expect(stores.deliveries.get(delivery?.id ?? "")?.status).toBe("held");
  });

  it("fails after maxAttempts for generic errors", async () => {
    adapter.failWith = new Error("boom");
    adapter.failTimes = Number.MAX_SAFE_INTEGER;
    const delivery = queue.enqueueEvent(route, makeEvent("d-err"));
    for (let i = 0; i < 4; i++) {
      await queue.tick();
      now = new Date(now.getTime() + 120_000);
    }
    const stored = stores.deliveries.get(delivery?.id ?? "");
    expect(stored?.status).toBe("failed");
    expect(stored?.error).toContain("after 3 attempts");
    expect(adapter.calls).toHaveLength(3);
  });

  it("fails immediately on PermanentError", async () => {
    adapter.failWith = new PermanentError("no such thread");
    adapter.failTimes = Number.MAX_SAFE_INTEGER;
    const delivery = queue.enqueueEvent(route, makeEvent("d-perm"));
    await queue.tick();
    expect(stores.deliveries.get(delivery?.id ?? "")?.status).toBe("failed");
    expect(adapter.calls).toHaveLength(1);
  });

  it("records a failed delivery when the template is invalid", async () => {
    const badRoute = stores.routes.create(
      routeInput({ name: "bad", promptTemplate: "hello {{nope}}" }),
    );
    const delivery = queue.enqueueEvent(badRoute, makeEvent("d-tpl"));
    expect(stores.deliveries.get(delivery?.id ?? "")?.status).toBe("failed");
    expect(stores.deliveries.get(delivery?.id ?? "")?.error).toContain("template error");
    await queue.tick();
    expect(adapter.calls).toHaveLength(0);
  });

  it("coalesces into a digest when the rate limit is exceeded", async () => {
    const fastQueue = new DeliveryQueue(stores, adapter, logger, {
      now: () => now,
      ratePerMinute: 2,
      autoWake: false,
    });
    // two deliveries land inside the window
    fastQueue.enqueueEvent(route, makeEvent("d-1"));
    await fastQueue.tick();
    fastQueue.enqueueEvent(route, makeEvent("d-2"));
    await fastQueue.tick();
    expect(adapter.calls).toHaveLength(2);

    // burst of three more while over budget → single digest turn
    fastQueue.enqueueEvent(route, makeEvent("d-3"));
    fastQueue.enqueueEvent(route, makeEvent("d-4"));
    fastQueue.enqueueEvent(route, makeEvent("d-5"));
    await fastQueue.tick();
    expect(adapter.calls).toHaveLength(3);
    const digestPrompt = adapter.calls[2]?.prompt ?? "";
    expect(digestPrompt).toContain("3 github events coalesced");
    expect(digestPrompt).toContain("push d-3");
    expect(digestPrompt).toContain("push d-5");

    const coalesced = stores.deliveries.list({ status: "coalesced" });
    expect(coalesced).toHaveLength(2);
    const delivered = stores.deliveries.list({ status: "delivered" });
    expect(delivered).toHaveLength(3);
  });

  it("route-level rateLimitPerMinute overrides the queue default", async () => {
    // Queue default is 10, route allows only 1/minute.
    const strictRoute = stores.routes.create(routeInput({ name: "strict", rateLimitPerMinute: 1 }));
    queue.enqueueEvent(strictRoute, makeEvent("d-1"));
    await queue.tick();
    expect(adapter.calls).toHaveLength(1);

    queue.enqueueEvent(strictRoute, makeEvent("d-2"));
    queue.enqueueEvent(strictRoute, makeEvent("d-3"));
    await queue.tick();
    expect(adapter.calls).toHaveLength(2);
    expect(adapter.calls[1]?.prompt).toContain("2 github events coalesced");
    expect(stores.deliveries.list({ status: "coalesced" })).toHaveLength(1);
  });

  it("starts new threads (and requires a worktree hook for worktree targets)", async () => {
    const newThreadRoute = stores.routes.create(
      routeInput({
        name: "spawn",
        target: { type: "new-thread", cwd: "/tmp/repo", worktree: false },
      }),
    );
    const delivery = queue.enqueueEvent(newThreadRoute, makeEvent("d-new"));
    await queue.tick();
    expect(adapter.calls[0]?.kind).toBe("start");
    expect(adapter.calls[0]?.opts.cwd).toBe("/tmp/repo");
    expect(stores.deliveries.get(delivery?.id ?? "")?.threadId).toBe("new-thread-1");

    const worktreeRoute = stores.routes.create(
      routeInput({ name: "wt", target: { type: "new-thread", cwd: "/tmp/repo", worktree: true } }),
    );
    const wtDelivery = queue.enqueueEvent(worktreeRoute, makeEvent("d-wt"));
    await queue.tick();
    expect(stores.deliveries.get(wtDelivery?.id ?? "")?.status).toBe("failed");
    expect(stores.deliveries.get(wtDelivery?.id ?? "")?.error).toContain("worktree");
  });

  it("recovers crashed in-flight deliveries on start", async () => {
    const delivery = queue.enqueueEvent(route, makeEvent("d-crash"));
    stores.deliveries.markDelivering(delivery?.id ?? "");
    expect(stores.deliveries.resetInFlight()).toBe(1);
    expect(stores.deliveries.get(delivery?.id ?? "")?.status).toBe("queued");
  });

  it("skips routes that were disabled after enqueue", async () => {
    const delivery = queue.enqueueEvent(route, makeEvent("d-disabled"));
    stores.routes.setEnabled(route.id, false);
    await queue.tick();
    expect(adapter.calls).toHaveLength(0);
    expect(stores.deliveries.get(delivery?.id ?? "")?.status).toBe("queued");
  });
});

function promptDeliveryId(prompt: string): string {
  const match = prompt.match(/push (d-\w+)/);
  return match?.[1] ?? "";
}
