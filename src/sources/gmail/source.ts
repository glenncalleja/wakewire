import { OAuth2Client } from "google-auth-library";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { z } from "zod";
import type { SecretStore } from "../../secrets/store.js";
import { secretNames } from "../../secrets/store.js";
import type { Source, SourceContext } from "../types.js";
import { emailToWakeEvent } from "./extract.js";

export const GmailSourceConfigSchema = z.object({
  /** Gmail label (IMAP mailbox) to watch. Required — no watch-everything sources. */
  label: z.string().min(1),
  auth: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("gmail-oauth"),
      user: z.string().email(),
    }),
    // Bonus: plain app-password IMAP for non-Gmail servers.
    z.object({
      kind: z.literal("imap-password"),
      user: z.string().min(1),
      host: z.string().min(1),
      port: z.number().int().positive().default(993),
      secure: z.boolean().default(true),
    }),
  ]),
  /** Watermarks persisted across restarts. Managed by the source. */
  state: z
    .object({ uidValidity: z.number().optional(), lastSeenUid: z.number().optional() })
    .default({}),
});

export type GmailSourceConfig = z.infer<typeof GmailSourceConfigSchema>;

const GMAIL_IMAP_HOST = "imap.gmail.com";
const RECONNECT_CAP_MS = 60_000;

/**
 * IMAP IDLE watcher. ImapFlow re-enters IDLE automatically whenever the
 * connection is unused, so the loop's job is: connect, catch up on UIDs past
 * the watermark, then sit on 'exists' notifications until the connection
 * drops — then reconnect with capped exponential backoff.
 */
export class GmailImapSource implements Source {
  readonly kind = "gmail" as const;
  private running = false;
  private client: ImapFlow | null = null;
  private loop: Promise<void> | null = null;
  private connected = false;
  private received = 0;
  private lastEventAt: string | null = null;
  private lastError: string | null = null;
  private state: { uidValidity?: number | undefined; lastSeenUid?: number | undefined };

  constructor(
    readonly id: string,
    private readonly config: GmailSourceConfig,
    private readonly secrets: SecretStore,
    private readonly ctx: SourceContext,
    private readonly persistState: (state: Record<string, unknown>) => void,
  ) {
    this.state = { ...config.state };
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.loop = this.runLoop();
  }

  async stop(): Promise<void> {
    this.running = false;
    const client = this.client;
    this.client = null;
    if (client) {
      try {
        await client.logout();
      } catch {
        client.close();
      }
    }
    await this.loop?.catch(() => undefined);
  }

  status(): Record<string, unknown> {
    return {
      label: this.config.label,
      user: this.config.auth.user,
      authKind: this.config.auth.kind,
      connected: this.connected,
      received: this.received,
      lastEventAt: this.lastEventAt,
      lastError: this.lastError,
    };
  }

  private async runLoop(): Promise<void> {
    let backoffMs = 1_000;
    while (this.running) {
      try {
        await this.connectAndWatch();
        backoffMs = 1_000; // clean session — reset backoff
      } catch (err) {
        this.lastError = imapErrorText(err);
        this.ctx.logger.warn({ source: this.id, err: this.lastError }, "gmail connection error");
      }
      this.connected = false;
      if (!this.running) break;
      this.ctx.logger.info({ source: this.id, retryInMs: backoffMs }, "gmail reconnecting");
      await sleep(backoffMs);
      backoffMs = Math.min(backoffMs * 2, RECONNECT_CAP_MS);
    }
  }

  /** Resolves when the connection closes; throws on connect/auth errors. */
  private async connectAndWatch(): Promise<void> {
    const client = new ImapFlow({
      ...(await this.connectionOptions()),
      logger: false,
      // Fail fast instead of hanging when Gmail tarpits repeated bad logins.
      // No socketTimeout: a healthy IDLE connection is legitimately quiet.
      connectionTimeout: 30_000,
      greetingTimeout: 30_000,
    });
    this.client = client;

    const closed = new Promise<void>((resolve) => {
      client.on("close", () => resolve());
      client.on("error", (err: Error) => {
        this.lastError = err.message;
        resolve();
      });
    });

    await client.connect();
    const mailbox = await client.mailboxOpen(this.config.label);
    this.connected = true;
    this.lastError = null;
    this.ctx.logger.info(
      { source: this.id, label: this.config.label, messages: mailbox.exists },
      "gmail mailbox open — idling",
    );

    const uidValidity = Number(mailbox.uidValidity ?? 0);
    if (this.state.uidValidity !== undefined && this.state.uidValidity !== uidValidity) {
      // Mailbox was recreated; UIDs are not comparable. Restart the watermark
      // at the current end rather than re-delivering history.
      this.ctx.logger.warn({ source: this.id }, "uidValidity changed — resetting watermark");
      this.state.lastSeenUid = undefined;
    }
    this.state.uidValidity = uidValidity;
    if (this.state.lastSeenUid === undefined) {
      // First run: start at the current end of the mailbox; do not replay history.
      this.state.lastSeenUid = Math.max(0, Number(mailbox.uidNext ?? 1) - 1);
      this.saveState();
    }

    await this.fetchNew(client); // catch up on anything that arrived while disconnected

    client.on("exists", () => {
      void this.fetchNew(client).catch((err) => {
        this.ctx.logger.warn({ source: this.id, err: String(err) }, "gmail fetch failed");
      });
    });

    await closed;
    this.client = null;
  }

  private async fetchNew(client: ImapFlow): Promise<void> {
    const from = (this.state.lastSeenUid ?? 0) + 1;
    let maxUid = this.state.lastSeenUid ?? 0;
    for await (const message of client.fetch(
      `${from}:*`,
      { uid: true, source: true },
      { uid: true },
    )) {
      if (message.uid <= (this.state.lastSeenUid ?? 0)) continue; // `${n}:*` includes the last message even when n > it
      maxUid = Math.max(maxUid, message.uid);
      if (!message.source) continue;
      try {
        const mail = await simpleParser(message.source);
        const event = emailToWakeEvent({
          mail,
          label: this.config.label,
          fallbackId: `imap-${this.id}-${this.state.uidValidity}-${message.uid}`,
        });
        this.received++;
        this.lastEventAt = new Date().toISOString();
        this.ctx.emit(event);
      } catch (err) {
        this.ctx.logger.warn(
          { source: this.id, uid: message.uid, err: String(err) },
          "failed to parse message — skipped",
        );
      }
    }
    if (maxUid > (this.state.lastSeenUid ?? 0)) {
      this.state.lastSeenUid = maxUid;
      this.saveState();
    }
  }

  private async connectionOptions() {
    const auth = this.config.auth;
    if (auth.kind === "gmail-oauth") {
      const accessToken = await this.freshAccessToken();
      return {
        host: GMAIL_IMAP_HOST,
        port: 993,
        secure: true,
        auth: { user: auth.user, accessToken },
      };
    }
    const pass = this.secrets.get(secretNames.imapPassword(this.id));
    if (!pass) throw new Error(`no IMAP password stored for source ${this.id}`);
    return {
      host: auth.host,
      port: auth.port,
      secure: auth.secure,
      auth: { user: auth.user, pass },
    };
  }

  private async freshAccessToken(): Promise<string> {
    const clientId = this.secrets.get(secretNames.gmailClientId(this.id));
    const clientSecret = this.secrets.get(secretNames.gmailClientSecret(this.id));
    const refreshToken = this.secrets.get(secretNames.gmailRefreshToken(this.id));
    if (!clientId || !clientSecret || !refreshToken) {
      throw new Error(
        `gmail OAuth is not configured for source ${this.id} — run: wakewire auth gmail`,
      );
    }
    const oauth = new OAuth2Client({ clientId, clientSecret });
    oauth.setCredentials({ refresh_token: refreshToken });
    const { token } = await oauth.getAccessToken();
    if (!token) throw new Error("failed to obtain Gmail access token");
    return token;
  }

  private saveState(): void {
    this.persistState({
      uidValidity: this.state.uidValidity,
      lastSeenUid: this.state.lastSeenUid,
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** imapflow throws generic "Command failed"; the server's reason lives in responseText. */
function imapErrorText(err: unknown): string {
  if (err instanceof Error) {
    const responseText = (err as { responseText?: string }).responseText;
    return responseText ? `${err.message}: ${responseText}` : err.message;
  }
  return String(err);
}
