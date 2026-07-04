import { SmeeClient } from "smee-client";
import { z } from "zod";
import type { SecretStore } from "../../secrets/store.js";
import { secretNames } from "../../secrets/store.js";
import type { Source, SourceContext } from "../types.js";
import { trimGithubEvent } from "./trim.js";
import { verifyGithubSignature } from "./verify.js";

export const GithubSourceConfigSchema = z.object({
  mode: z.enum(["smee", "listen"]).default("smee"),
  /** smee.io channel URL (smee mode). */
  smeeUrl: z.string().url().optional(),
  /** Informational: the repo this endpoint was set up for. Routing happens per-route. */
  repo: z.string().optional(),
});

export type GithubSourceConfig = z.infer<typeof GithubSourceConfigSchema>;

interface SmeeMessage {
  body?: unknown;
  [header: string]: unknown;
}

/**
 * GitHub webhook source. Default transport is a smee.io relay consumed over
 * SSE (no listening port at all). "listen" mode instead accepts direct posts
 * on the daemon's ingress endpoint, for users who bring their own tunnel or
 * reverse proxy. Signatures are verified in both modes.
 */
export class GithubWebhookSource implements Source {
  readonly kind = "github" as const;
  private smee: SmeeClient | null = null;
  private connected = false;
  private lastEventAt: string | null = null;
  private received = 0;
  private rejected = 0;

  constructor(
    readonly id: string,
    private readonly config: GithubSourceConfig,
    private readonly secrets: SecretStore,
    private readonly ctx: SourceContext,
  ) {}

  async start(): Promise<void> {
    if (this.config.mode !== "smee") return; // listen mode: daemon routes ingress to handleWebhook
    if (!this.config.smeeUrl) {
      throw new Error(`github source ${this.id} is in smee mode but has no smeeUrl`);
    }
    this.smee = new SmeeClient({
      source: this.config.smeeUrl,
      target: "http://127.0.0.1/unused", // forward:false — we consume messages directly
      forward: false,
      logger: {
        info: (...args: unknown[]) => this.ctx.logger.debug({ smee: args }, "smee"),
        error: (...args: unknown[]) => this.ctx.logger.warn({ smee: args }, "smee error"),
      },
    });
    this.smee.onmessage = (msg: MessageEvent) => {
      void this.handleSmeeMessage(String(msg.data));
    };
    this.smee.onopen = () => {
      this.connected = true;
      this.ctx.logger.info({ source: this.id, url: this.config.smeeUrl }, "smee channel connected");
    };
    this.smee.onerror = () => {
      this.connected = false;
      // smee-client reconnects internally (EventSource retry)
      this.ctx.logger.warn({ source: this.id }, "smee channel error — will retry");
    };
    await this.smee.start();
  }

  async stop(): Promise<void> {
    await this.smee?.stop();
    this.smee = null;
    this.connected = false;
  }

  status(): Record<string, unknown> {
    return {
      mode: this.config.mode,
      ...(this.config.smeeUrl ? { smeeUrl: this.config.smeeUrl } : {}),
      connected: this.config.mode === "smee" ? this.connected : undefined,
      received: this.received,
      rejected: this.rejected,
      lastEventAt: this.lastEventAt,
    };
  }

  private async handleSmeeMessage(data: string): Promise<void> {
    let message: SmeeMessage;
    try {
      message = JSON.parse(data);
    } catch {
      this.ctx.logger.warn({ source: this.id }, "unparseable smee message dropped");
      return;
    }
    if (!message || typeof message !== "object" || message.body === undefined) return;
    // smee relays the parsed JSON body; GitHub sends compact JSON, so
    // re-serializing reproduces the signed bytes. See DECISIONS.md.
    const rawBody = JSON.stringify(message.body);
    const result = await this.handleWebhook({
      eventName: headerOf(message, "x-github-event"),
      deliveryId: headerOf(message, "x-github-delivery"),
      signature: headerOf(message, "x-hub-signature-256"),
      rawBody,
    });
    if (result.status >= 400) {
      this.ctx.logger.warn({ source: this.id, reason: result.message }, "smee event rejected");
    }
  }

  /**
   * Shared ingress path: used by smee mode above and by the daemon's HTTP
   * ingress route in listen mode (where rawBody is the true request body).
   */
  async handleWebhook(args: {
    eventName: string | undefined;
    deliveryId: string | undefined;
    signature: string | undefined;
    rawBody: string;
  }): Promise<{ status: number; message: string }> {
    const { eventName, deliveryId, signature, rawBody } = args;
    if (!eventName || !deliveryId) {
      this.rejected++;
      return { status: 400, message: "missing X-GitHub-Event or X-GitHub-Delivery" };
    }
    const secret = this.secrets.get(secretNames.githubWebhookSecret(this.id));
    if (!secret) {
      this.rejected++;
      return { status: 503, message: "webhook secret not configured for this source" };
    }
    if (!(await verifyGithubSignature(secret, rawBody, signature))) {
      this.rejected++;
      return { status: 401, message: "signature verification failed" };
    }
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      this.rejected++;
      return { status: 400, message: "body is not valid JSON" };
    }
    if (eventName === "ping") {
      return { status: 200, message: "pong" };
    }
    const event = trimGithubEvent({ eventName, deliveryId, payload });
    if (!event) {
      return { status: 200, message: "event has no repository — ignored" };
    }
    this.received++;
    this.lastEventAt = new Date().toISOString();
    this.ctx.emit(event);
    // Exactly 200: strictest common denominator across webhook providers.
    return { status: 200, message: "accepted" };
  }
}

function headerOf(message: SmeeMessage, name: string): string | undefined {
  const value = message[name];
  return typeof value === "string" ? value : undefined;
}

/** Create a fresh smee.io channel (used by wakewire_source_setup_github). */
export async function createSmeeChannel(): Promise<string> {
  return SmeeClient.createChannel();
}
