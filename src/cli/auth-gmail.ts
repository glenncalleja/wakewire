import http from "node:http";
import readline from "node:readline/promises";
import { OAuth2Client } from "google-auth-library";
import { apiFetch } from "../client.js";
import { openDatabase } from "../db/db.js";
import { createStores } from "../db/repos.js";
import type { Logger } from "../logging.js";
import { createSecretStore, secretNames } from "../secrets/store.js";

const GMAIL_SCOPE = "https://mail.google.com/"; // required for IMAP XOAUTH2

/**
 * Interactive OAuth consent for a gmail source. The user supplies their own
 * OAuth client (Desktop type): wakewire is self-hosted, so shipping a shared
 * client id would put every user behind Google's restricted-scope app
 * verification. A personal client in test mode works immediately.
 */
export async function authGmail(
  logger: Logger,
  opts: { source?: string; clientId?: string; clientSecret?: string },
): Promise<void> {
  const db = openDatabase();
  const stores = createStores(db);
  const gmailSources = stores.sources.findByKind("gmail");
  let sourceId = opts.source;
  if (!sourceId) {
    if (gmailSources.length === 1) {
      sourceId = gmailSources[0]?.id;
    } else if (gmailSources.length === 0) {
      console.error(
        "No gmail source configured yet. Create one first (from Codex: wakewire_source_setup_gmail, or POST /api/sources/gmail/setup).",
      );
      process.exitCode = 1;
      return;
    } else {
      console.error("Multiple gmail sources exist — pass --source <id>:");
      for (const s of gmailSources) {
        console.error(`  ${s.id}  label=${String(s.config.label)}`);
      }
      process.exitCode = 1;
      return;
    }
  }
  if (!sourceId || !stores.sources.get(sourceId)) {
    console.error(`gmail source ${sourceId} not found`);
    process.exitCode = 1;
    return;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const clientId = opts.clientId ?? (await rl.question("Google OAuth client ID: ")).trim();
  const clientSecret =
    opts.clientSecret ?? (await rl.question("Google OAuth client secret: ")).trim();
  rl.close();
  if (!clientId || !clientSecret) {
    console.error("client id and secret are required");
    process.exitCode = 1;
    return;
  }

  const { code, redirectUri } = await receiveAuthCode(clientId, clientSecret);
  const oauth = new OAuth2Client({ clientId, clientSecret, redirectUri });
  const { tokens } = await oauth.getToken(code);
  if (!tokens.refresh_token) {
    console.error(
      "Google did not return a refresh token. Remove the app's prior grant at " +
        "https://myaccount.google.com/permissions and try again.",
    );
    process.exitCode = 1;
    return;
  }

  const secrets = await createSecretStore(logger);
  secrets.set(secretNames.gmailClientId(sourceId), clientId);
  secrets.set(secretNames.gmailClientSecret(sourceId), clientSecret);
  secrets.set(secretNames.gmailRefreshToken(sourceId), tokens.refresh_token);
  console.log(`Stored Gmail OAuth credentials for source ${sourceId} (${secrets.backend}).`);

  db.close();
  try {
    await apiFetch(`/api/sources/${sourceId}/restart`, { method: "POST" });
    console.log("Daemon notified — the gmail source is (re)starting.");
  } catch {
    console.log("Daemon not running; the source will start with the next `wakewire start`.");
  }
}

function receiveAuthCode(
  clientId: string,
  clientSecret: string,
): Promise<{ code: string; redirectUri: string }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("could not open loopback listener"));
        return;
      }
      const redirectUri = `http://127.0.0.1:${address.port}/oauth2callback`;
      const oauth = new OAuth2Client({ clientId, clientSecret, redirectUri });
      const url = oauth.generateAuthUrl({
        access_type: "offline",
        prompt: "consent",
        scope: [GMAIL_SCOPE],
      });
      console.log("\nOpen this URL in your browser and approve access:\n");
      console.log(`  ${url}\n`);

      server.on("request", (req, res) => {
        const reqUrl = new URL(req.url ?? "/", redirectUri);
        if (reqUrl.pathname !== "/oauth2callback") {
          res.writeHead(404).end();
          return;
        }
        const code = reqUrl.searchParams.get("code");
        const error = reqUrl.searchParams.get("error");
        res.writeHead(200, { "content-type": "text/plain" });
        res.end(
          code
            ? "wakewire: Gmail authorization received. You can close this tab."
            : `wakewire: authorization failed: ${error ?? "no code"}`,
        );
        server.close();
        if (code) {
          resolve({ code, redirectUri });
        } else {
          reject(new Error(`authorization failed: ${error ?? "no code returned"}`));
        }
      });
    });
    server.on("error", reject);
  });
}
