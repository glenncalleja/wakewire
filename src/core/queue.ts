import type { Delivery, Stores } from "../db/repos.js";
import type { Logger } from "../logging.js";
import type { AgentAdapter } from "../sinks/types.js";
import { BusyError, PermanentError, UnreachableError } from "../sinks/types.js";
import { buildDigestPrompt, buildPrompt } from "./envelope.js";
import type { BridgeEvent } from "./event.js";
import type { Route } from "./route.js";
import { DEFAULT_TEMPLATES, renderTemplate, TemplateError, templateFields } from "./template.js";

export interface QueueOptions {
  /** Max deliveries per route per minute before coalescing into a digest. */
  ratePerMinute?: number;
  /** Attempts before a non-busy, non-unreachable error becomes a permanent failure. */
  maxAttempts?: number;
  /** Backoff ceiling in ms (plan: cap 60s). */
  backoffCapMs?: number;
  /** Processor poll interval in ms. */
  tickMs?: number;
  /** Injectable clock for tests. */
  now?: () => Date;
  /** Kick a processor pass on every enqueue (default). Tests disable this and call tick() directly. */
  autoWake?: boolean;
  /** Hook for new-thread worktree targets; returns the cwd to use. */
  prepareWorktree?: (route: Route, delivery: Delivery) => Promise<string>;
}

/**
 * Persistent per-thread FIFO. All state lives in SQLite (crash-only design);
 * the in-memory `inFlight` set only prevents concurrent sends to one thread
 * within this process, and `delivering` rows are reset to `queued` on boot.
 */
export class DeliveryQueue {
  private readonly ratePerMinute: number;
  private readonly maxAttempts: number;
  private readonly backoffCapMs: number;
  private readonly tickMs: number;
  private readonly now: () => Date;
  private readonly inFlight = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;

  constructor(
    private readonly stores: Stores,
    private readonly adapter: AgentAdapter,
    private readonly logger: Logger,
    private readonly options: QueueOptions = {},
  ) {
    this.ratePerMinute = options.ratePerMinute ?? 10;
    this.maxAttempts = options.maxAttempts ?? 8;
    this.backoffCapMs = options.backoffCapMs ?? 60_000;
    this.tickMs = options.tickMs ?? 1_000;
    this.now = options.now ?? (() => new Date());
  }

  start(): void {
    if (this.timer) return;
    const recovered = this.stores.deliveries.resetInFlight();
    if (recovered > 0) {
      this.logger.warn({ recovered }, "reset stale in-flight deliveries to queued");
    }
    this.timer = setInterval(() => void this.tick(), this.tickMs);
    this.timer.unref?.();
    void this.tick();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Render the prompt for a matched event and persist it as a queued delivery. */
  enqueueEvent(
    route: Route,
    event: BridgeEvent,
    opts: { isReplay?: boolean } = {},
  ): Delivery | null {
    let prompt: string;
    try {
      prompt = this.renderPrompt(route, event);
    } catch (err) {
      if (err instanceof TemplateError) {
        const delivery = this.stores.deliveries.enqueue({
          routeId: route.id,
          event,
          renderedPrompt: "",
          isReplay: opts.isReplay ?? false,
        });
        if (delivery)
          this.stores.deliveries.markFailed(delivery.id, `template error: ${err.message}`);
        this.logger.error({ route: route.name, err: err.message }, "template render failed");
        return delivery;
      }
      throw err;
    }
    const delivery = this.stores.deliveries.enqueue({
      routeId: route.id,
      event,
      renderedPrompt: prompt,
      isReplay: opts.isReplay ?? false,
    });
    if (delivery === null) {
      this.logger.info(
        { route: route.name, deliveryId: event.deliveryId },
        "duplicate delivery skipped",
      );
      return null;
    }
    if (this.options.autoWake ?? true) this.wake();
    return delivery;
  }

  /** Re-render a past delivery against the route's current config and enqueue it again. */
  replay(deliveryId: string): Delivery {
    const old = this.stores.deliveries.get(deliveryId);
    if (!old) throw new Error(`delivery ${deliveryId} not found`);
    const route = this.stores.routes.get(old.routeId);
    if (!route) throw new Error(`route ${old.routeId} no longer exists`);
    const replayed = this.enqueueEvent(route, old.event, { isReplay: true });
    if (!replayed) throw new Error("replay enqueue failed");
    return replayed;
  }

  wake(): void {
    void this.tick();
  }

  /** One scheduler pass. Public for deterministic tests. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const ready = this.stores.deliveries.listReady(this.now().toISOString());
      const jobs: Array<Promise<void>> = [];
      const claimed = new Set<string>();

      for (const delivery of ready) {
        const route = this.stores.routes.get(delivery.routeId);
        if (!route) {
          this.stores.deliveries.markFailed(delivery.id, "route no longer exists");
          continue;
        }
        if (!route.enabled) continue;
        const key = threadKey(route);
        if (this.inFlight.has(key) || claimed.has(key)) continue; // strict per-thread FIFO
        claimed.add(key);

        const batch = this.maybeCoalesce(route, delivery, ready);
        this.inFlight.add(key);
        this.stores.deliveries.markDelivering(batch.id);
        jobs.push(
          this.process(route, batch).finally(() => {
            this.inFlight.delete(key);
          }),
        );
      }
      await Promise.all(jobs);
    } finally {
      this.ticking = false;
    }
  }

  queueDepth(): number {
    return this.stores.deliveries.countPending();
  }

  private renderPrompt(route: Route, event: BridgeEvent): string {
    const template = route.promptTemplate ?? DEFAULT_TEMPLATES[event.source];
    const instructions = renderTemplate(template, templateFields(route.name, event));
    return buildPrompt({ routeName: route.name, event, instructions });
  }

  /**
   * Rate limiting: when a route exceeds its per-minute budget and several
   * deliveries are waiting for the same thread, merge them into one digest
   * turn carried by the newest delivery.
   */
  private maybeCoalesce(route: Route, delivery: Delivery, ready: Delivery[]): Delivery {
    const windowStart = new Date(this.now().getTime() - 60_000).toISOString();
    const recent = this.stores.deliveries.countRecentAttempts(route.id, windowStart);
    const siblings = ready.filter((d) => d.routeId === route.id && d.id !== delivery.id);
    if (recent < this.ratePerMinute || siblings.length === 0) return delivery;

    const all = [delivery, ...siblings];
    const carrier = all[all.length - 1] as Delivery;
    const rest = all.slice(0, -1);
    const events = all.map((d) => d.event);
    const template = route.promptTemplate ?? DEFAULT_TEMPLATES[route.source];
    let instructions: string;
    try {
      instructions = renderTemplate(template, templateFields(route.name, carrier.event));
    } catch {
      instructions = DEFAULT_TEMPLATES[route.source];
    }
    const digest = buildDigestPrompt({
      routeName: route.name,
      source: route.source,
      instructions,
      events,
    });
    this.stores.deliveries.updatePrompt(carrier.id, digest);
    this.stores.deliveries.markCoalesced(
      rest.map((d) => d.id),
      carrier.id,
    );
    this.logger.info(
      { route: route.name, coalesced: rest.length + 1 },
      "rate limit exceeded — coalesced deliveries into a digest turn",
    );
    return this.stores.deliveries.get(carrier.id) ?? carrier;
  }

  private async process(route: Route, delivery: Delivery): Promise<void> {
    const prompt = delivery.renderedPrompt;
    if (!prompt) {
      this.stores.deliveries.markFailed(delivery.id, "no rendered prompt");
      return;
    }
    try {
      const result = await this.deliver(route, delivery, prompt);
      this.stores.deliveries.markDelivered(delivery.id, result);
      this.logger.info(
        { route: route.name, delivery: delivery.id, threadId: result.threadId },
        "delivered",
      );
    } catch (err) {
      this.handleFailure(route, delivery, err);
    }
  }

  private async deliver(route: Route, delivery: Delivery, prompt: string) {
    const opts = { sandbox: route.sandbox };
    if (route.target.type === "thread") {
      return this.adapter.deliverToThread(route.target.threadId, prompt, opts);
    }
    let cwd = route.target.cwd;
    if (route.target.worktree) {
      if (!this.options.prepareWorktree) {
        throw new PermanentError("worktree targets are not supported in this configuration");
      }
      cwd = await this.options.prepareWorktree(route, delivery);
    }
    return this.adapter.startThread(prompt, { ...opts, cwd });
  }

  private handleFailure(route: Route, delivery: Delivery, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof PermanentError) {
      this.stores.deliveries.markFailed(delivery.id, message);
      this.logger.error(
        { route: route.name, delivery: delivery.id, err: message },
        "delivery failed permanently",
      );
      return;
    }
    const retryForever = err instanceof BusyError || err instanceof UnreachableError;
    if (!retryForever && delivery.attemptCount + 1 >= this.maxAttempts) {
      this.stores.deliveries.markFailed(
        delivery.id,
        `${message} (after ${this.maxAttempts} attempts)`,
      );
      this.logger.error(
        { route: route.name, delivery: delivery.id, err: message },
        "delivery failed after max attempts",
      );
      return;
    }
    const delayMs = Math.min(this.backoffCapMs, 1_000 * 2 ** delivery.attemptCount);
    const nextAttemptAt = new Date(this.now().getTime() + delayMs).toISOString();
    this.stores.deliveries.markHeld(delivery.id, message, nextAttemptAt);
    this.logger.warn(
      { route: route.name, delivery: delivery.id, err: message, retryInMs: delayMs },
      err instanceof BusyError ? "thread busy — held" : "delivery held for retry",
    );
  }
}

export function threadKey(route: Route): string {
  return route.target.type === "thread" ? `thread:${route.target.threadId}` : `route:${route.id}`;
}
