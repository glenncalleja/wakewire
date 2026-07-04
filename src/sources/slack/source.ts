import { SocketModeClient } from "@slack/socket-mode";
import { LogLevel, WebClient } from "@slack/web-api";
import { z } from "zod";
import type { SecretStore } from "../../secrets/store.js";
import { secretNames } from "../../secrets/store.js";
import type { Source, SourceContext } from "../types.js";
import { isBotEvent, slackToWakeEvent } from "./normalize.js";

export const SlackSourceConfigSchema = z.object({
  /** Informational workspace name used in the deterministic source id. */
  team: z.string().min(1).default("default"),
  /** Deliver messages posted by bots/integrations too. Off by default. */
  includeBotMessages: z.boolean().default(false),
});

export type SlackSourceConfig = z.infer<typeof SlackSourceConfigSchema>;

interface SlackEnvelope {
  ack: (response?: Record<string, unknown>) => Promise<void>;
  type: string;
  body: {
    event_id?: string;
    team_id?: string;
    event?: Record<string, unknown>;
  };
  retry_num?: number;
}

/**
 * Slack source over Socket Mode: an outbound WebSocket authenticated with an
 * app-level token (xapp-…), so — like the smee relay for GitHub — no public
 * HTTP endpoint is needed. The bot token (xoxb-…) is only used to resolve
 * channel/user names for summaries and match rules.
 *
 * Deliverable events are acked only after they are durably enqueued (see
 * handleEnvelope); un-acked envelopes are redelivered by Slack with the same
 * event_id, and dedup collapses them.
 */
export class SlackSocketSource implements Source {
  readonly kind = "slack" as const;
  private client: SocketModeClient | null = null;
  private web: WebClient | null = null;
  private connected = false;
  private received = 0;
  private skippedBots = 0;
  private lastEventAt: string | null = null;
  private lastError: string | null = null;
  private readonly channelNames = new Map<string, string | undefined>();
  private readonly userNames = new Map<string, string | undefined>();

  constructor(
    readonly id: string,
    private readonly config: SlackSourceConfig,
    private readonly secrets: SecretStore,
    private readonly ctx: SourceContext,
  ) {}

  async start(): Promise<void> {
    const appToken = this.secrets.get(secretNames.slackAppToken(this.id));
    const botToken = this.secrets.get(secretNames.slackBotToken(this.id));
    if (!appToken) {
      throw new Error(`no Slack app token stored for source ${this.id} — run: wakewire auth slack`);
    }
    this.web = botToken ? new WebClient(botToken) : null;
    if (!this.web) {
      this.ctx.logger.warn(
        { source: this.id },
        "no Slack bot token stored — channel/user names will not be resolved",
      );
    }

    const client = new SocketModeClient({ appToken, logger: noopSlackLogger() });
    this.client = client;

    client.on("connected", () => {
      this.connected = true;
      this.lastError = null;
      this.ctx.logger.info({ source: this.id }, "slack socket connected");
    });
    client.on("disconnected", () => {
      this.connected = false;
      this.ctx.logger.warn(
        { source: this.id },
        "slack socket disconnected — client will reconnect",
      );
    });
    client.on("error", (err: Error) => {
      this.lastError = err.message;
      this.ctx.logger.warn({ source: this.id, err: err.message }, "slack socket error");
    });

    client.on("slack_event", (envelope: SlackEnvelope) => {
      void this.handleEnvelope(envelope).catch((err) => {
        this.ctx.logger.warn({ source: this.id, err: String(err) }, "slack event handling failed");
      });
    });

    await client.start();
  }

  async stop(): Promise<void> {
    const client = this.client;
    this.client = null;
    this.connected = false;
    if (client) {
      try {
        await client.disconnect();
      } catch {
        // socket already gone
      }
    }
  }

  status(): Record<string, unknown> {
    return {
      team: this.config.team,
      connected: this.connected,
      received: this.received,
      skippedBots: this.skippedBots,
      lastEventAt: this.lastEventAt,
      lastError: this.lastError,
    };
  }

  /**
   * Ack ordering: events we won't deliver are acked immediately, but
   * deliverable events are acked only AFTER ctx.emit() returns — emit is
   * synchronous through route matching and the SQLite enqueue, so an ack
   * means the event is durably queued. If anything throws (or the process
   * dies) before that, the envelope stays un-acked and Slack redelivers with
   * the same event_id, which our dedup collapses. Name resolution happens
   * inside that window; caches keep it fast, and blowing Slack's ~3s ack
   * deadline merely causes a redelivery that dedups.
   */
  private async handleEnvelope(envelope: SlackEnvelope): Promise<void> {
    if (envelope.type !== "events_api") {
      await envelope.ack();
      return;
    }
    const event = envelope.body.event;
    const eventId = envelope.body.event_id;
    if (!event || !eventId) {
      await envelope.ack();
      return;
    }
    if (!this.config.includeBotMessages && isBotEvent(event)) {
      this.skippedBots++;
      await envelope.ack();
      return;
    }

    const names = {
      channelName: await this.resolveChannel(strOf(event.channel)),
      userName: await this.resolveUser(strOf(event.user)),
    };
    const wakeEvent = slackToWakeEvent({
      event,
      eventId,
      teamId: envelope.body.team_id,
      names,
    });
    if (!wakeEvent) {
      await envelope.ack();
      return;
    }
    this.received++;
    this.lastEventAt = new Date().toISOString();
    this.ctx.emit(wakeEvent); // synchronous: matches routes and enqueues to SQLite
    await envelope.ack();
  }

  private async resolveChannel(id: string): Promise<string | undefined> {
    if (!id || !this.web) return undefined;
    if (this.channelNames.has(id)) return this.channelNames.get(id);
    let name: string | undefined;
    try {
      const info = await this.web.conversations.info({ channel: id });
      name = info.channel?.name ?? undefined;
    } catch {
      name = undefined; // bot lacks access/scope — ids still work for matching
    }
    this.channelNames.set(id, name);
    return name;
  }

  private async resolveUser(id: string): Promise<string | undefined> {
    if (!id || !this.web) return undefined;
    if (this.userNames.has(id)) return this.userNames.get(id);
    let name: string | undefined;
    try {
      const info = await this.web.users.info({ user: id });
      name = info.user?.profile?.display_name || info.user?.real_name || info.user?.name;
    } catch {
      name = undefined;
    }
    this.userNames.set(id, name);
    return name;
  }
}

function strOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** The SDK's default logger writes to stdout; route everything through pino instead. */
function noopSlackLogger() {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    setLevel: () => {},
    getLevel: () => LogLevel.ERROR,
    setName: () => {},
  };
}
