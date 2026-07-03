import { SmeeClient } from "smee-client";
import { z } from "zod";
import type { SecretStore } from "../../secrets/store.js";
import { secretNames } from "../../secrets/store.js";
import type { Source, SourceContext } from "../types.js";
import { mapWebhookEvent, WebhookMappingSchema } from "./map.js";
import { verifyWebhook, WebhookVerificationSchema } from "./verify.js";

export const WebhookSourceConfigSchema = z
  .object({
    /** Provider label ("sentry", "clickup"): used in route matching and the source id. */
    name: z
      .string()
      .min(1)
      .max(40)
      .regex(/^[a-z0-9][a-z0-9_-]*$/i, "letters, digits, - and _ only"),
    mode: z.enum(["smee", "listen"]).default("smee"),
    smeeUrl: z.string().optional(),
    verification: WebhookVerificationSchema,
    mapping: WebhookMappingSchema.optional(),
    /** While > 0, incoming raw payloads are stored for mapping authoring. */
    captureRemaining: z.number().int().min(0).default(0),
  })
  .refine((c) => !(c.mode === "smee" && c.verification.kind === "secret-header"), {
    path: ["verification"],
    // secret-header is a bearer token; the smee relay is readable by anyone with
    // the channel URL, so one observed event leaks the reusable secret. Require
    // listen mode (your own tunnel) for it, or use hmac-sha256 over smee.
    message:
      "secret-header verification is not allowed in smee mode (the relay is public and would expose the secret) — use listen mode or hmac-sha256",
  });

export type WebhookSourceConfig = z.infer<typeof WebhookSourceConfigSchema>;

interface SmeeMessage {
  body?: unknown;
  [header: string]: unknown;
}

export interface WebhookSourceHooks {
  /** Store a raw payload while in capture mode. */
  capture(sourceId: string, body: string): void;
  /** Persist config changes (capture countdown). */
  persistConfig(patch: Partial<WebhookSourceConfig>): void;
}

/**
 * Generic signed webhook source. Same transport options as the GitHub source
 * (smee relay by default, or the daemon's /ingress/webhook/:id in listen
 * mode); provider specifics are declarative: a verification preset and a
 * field mapping that doubles as the payload trim.
 */
export class WebhookIngestSource implements Source {
  readonly kind = "webhook" as const;
  private smee: SmeeClient | null = null;
  private connected = false;
  private received = 0;
  private rejected = 0;
  private captured = 0;
  private lastEventAt: string | null = null;
  private captureRemaining: number;

  constructor(
    readonly id: string,
    private readonly config: WebhookSourceConfig,
    private readonly secrets: SecretStore,
    private readonly ctx: SourceContext,
    private readonly hooks: WebhookSourceHooks,
  ) {
    this.captureRemaining = config.captureRemaining;
  }

  async start(): Promise<void> {
    if (this.config.mode !== "smee") return; // listen mode: daemon ingress calls handleWebhook
    if (!this.config.smeeUrl) {
      throw new Error(`webhook source ${this.id} is in smee mode but has no smeeUrl`);
    }
    this.smee = new SmeeClient({
      source: this.config.smeeUrl,
      target: "http://127.0.0.1/unused",
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
      provider: this.config.name,
      mode: this.config.mode,
      ...(this.config.smeeUrl ? { smeeUrl: this.config.smeeUrl } : {}),
      connected: this.config.mode === "smee" ? this.connected : undefined,
      hasMapping: Boolean(this.config.mapping),
      captureRemaining: this.captureRemaining,
      received: this.received,
      rejected: this.rejected,
      captured: this.captured,
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
    const rawBody = JSON.stringify(message.body);
    const result = await this.handleWebhook({
      getHeader: (name) => {
        const value = message[name.toLowerCase()];
        return typeof value === "string" ? value : undefined;
      },
      rawBody,
    });
    if (result.status >= 400) {
      this.ctx.logger.warn({ source: this.id, reason: result.message }, "webhook event rejected");
    }
  }

  /** Shared ingress: smee mode above, and the daemon's listen-mode HTTP route. */
  async handleWebhook(args: {
    getHeader: (name: string) => string | undefined;
    rawBody: string;
  }): Promise<{ status: number; message: string }> {
    const { getHeader, rawBody } = args;
    const secret = this.secrets.get(secretNames.webhookSecret(this.id));
    if (!secret) {
      this.rejected++;
      return { status: 503, message: "webhook secret not configured for this source" };
    }
    const headerValue = getHeader(this.config.verification.header);
    if (!verifyWebhook(this.config.verification, secret, rawBody, headerValue)) {
      this.rejected++;
      return { status: 401, message: "signature verification failed" };
    }
    let body: Record<string, unknown>;
    try {
      const parsed = JSON.parse(rawBody);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { status: 400, message: "body must be a JSON object" };
      }
      body = parsed;
    } catch {
      return { status: 400, message: "body is not valid JSON" };
    }

    if (this.captureRemaining > 0) {
      this.captureRemaining--;
      this.captured++;
      this.hooks.capture(this.id, rawBody);
      this.hooks.persistConfig({ captureRemaining: this.captureRemaining });
      this.ctx.logger.info(
        { source: this.id, remaining: this.captureRemaining },
        "captured raw webhook payload for mapping authoring",
      );
    }

    const event = mapWebhookEvent({
      provider: this.config.name,
      mapping: this.config.mapping,
      body,
      rawBody,
      headerDeliveryId: this.config.mapping?.deliveryIdHeader
        ? getHeader(this.config.mapping.deliveryIdHeader)
        : undefined,
    });
    this.received++;
    this.lastEventAt = new Date().toISOString();
    this.ctx.emit(event);
    // Exactly 200: some providers (Linear) treat any other status — even 202 —
    // as a failure, retry, and eventually disable the webhook.
    return { status: 200, message: "accepted" };
  }
}
