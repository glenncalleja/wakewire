import type { BridgeEvent } from "../core/event.js";
import type { Stores } from "../db/repos.js";
import type { Logger } from "../logging.js";
import type { SecretStore } from "../secrets/store.js";
import { GithubSourceConfigSchema, GithubWebhookSource } from "../sources/github/source.js";
import { GmailImapSource, GmailSourceConfigSchema } from "../sources/gmail/source.js";
import { SlackSocketSource, SlackSourceConfigSchema } from "../sources/slack/source.js";
import type { Source } from "../sources/types.js";
import { WebhookIngestSource, WebhookSourceConfigSchema } from "../sources/webhook/source.js";

/**
 * Owns the live Source instances, keeps them in sync with the sources table,
 * and fans their events into the router callback.
 */
export class SourceManager {
  private readonly live = new Map<string, Source>();

  constructor(
    private readonly stores: Stores,
    private readonly secrets: SecretStore,
    private readonly logger: Logger,
    private readonly onEvent: (event: BridgeEvent) => void,
  ) {}

  async startAll(): Promise<void> {
    for (const record of this.stores.sources.listEnabled()) {
      await this.startOne(record.id);
    }
  }

  async stopAll(): Promise<void> {
    for (const [id] of this.live) {
      await this.stopOne(id);
    }
  }

  /** Stop the live instance (if any) and delete the DB record. */
  async remove(id: string): Promise<boolean> {
    if (!this.stores.sources.get(id)) return false;
    await this.stopOne(id);
    return this.stores.sources.remove(id);
  }

  /** (Re)create a source from its DB record — used after setup/auth changes. */
  async restart(id: string): Promise<boolean> {
    if (!this.stores.sources.get(id)) return false;
    await this.stopOne(id);
    await this.startOne(id);
    return true;
  }

  get(id: string): Source | undefined {
    return this.live.get(id);
  }

  statuses(): Record<string, Record<string, unknown>> {
    const out: Record<string, Record<string, unknown>> = {};
    for (const [id, source] of this.live) {
      out[id] = { kind: source.kind, ...source.status() };
    }
    return out;
  }

  private async startOne(id: string): Promise<void> {
    const record = this.stores.sources.get(id);
    if (!record || !record.enabled) return;
    const ctx = {
      emit: this.onEvent,
      logger: this.logger.child({ source: id, kind: record.kind }),
    };
    try {
      let source: Source;
      if (record.kind === "github") {
        const config = GithubSourceConfigSchema.parse(record.config);
        source = new GithubWebhookSource(id, config, this.secrets, ctx);
      } else if (record.kind === "slack") {
        const config = SlackSourceConfigSchema.parse(record.config);
        source = new SlackSocketSource(id, config, this.secrets, ctx);
      } else if (record.kind === "webhook") {
        const config = WebhookSourceConfigSchema.parse(record.config);
        source = new WebhookIngestSource(id, config, this.secrets, ctx, {
          capture: (sourceId, body) => this.stores.captures.add(sourceId, body),
          persistConfig: (patch) => {
            const current = this.stores.sources.get(id);
            if (current) {
              this.stores.sources.upsert({
                id,
                kind: current.kind,
                config: { ...current.config, ...patch },
                enabled: current.enabled,
              });
            }
          },
        });
      } else {
        const config = GmailSourceConfigSchema.parse(record.config);
        source = new GmailImapSource(id, config, this.secrets, ctx, (state) => {
          const current = this.stores.sources.get(id);
          if (current) {
            this.stores.sources.upsert({
              id,
              kind: current.kind,
              config: { ...current.config, state },
              enabled: current.enabled,
            });
          }
        });
      }
      await source.start();
      this.live.set(id, source);
      this.logger.info({ source: id, kind: record.kind }, "source started");
    } catch (err) {
      this.logger.error(
        { source: id, kind: record.kind, err: err instanceof Error ? err.message : String(err) },
        "source failed to start",
      );
    }
  }

  private async stopOne(id: string): Promise<void> {
    const source = this.live.get(id);
    if (!source) return;
    this.live.delete(id);
    try {
      await source.stop();
    } catch (err) {
      this.logger.warn({ source: id, err: String(err) }, "source stop error");
    }
  }
}
