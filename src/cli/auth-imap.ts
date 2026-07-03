import readline from "node:readline/promises";
import { apiFetch } from "../client.js";
import { openDatabase } from "../db/db.js";
import { createStores } from "../db/repos.js";
import type { Logger } from "../logging.js";
import { createSecretStore, secretNames } from "../secrets/store.js";

/**
 * Store the IMAP password for an imap-password gmail source. For Gmail this is
 * an app password (https://myaccount.google.com/apppasswords, requires 2-Step
 * Verification); for other providers, the account's IMAP password.
 */
export async function authImap(
  logger: Logger,
  opts: { source?: string; password?: string },
): Promise<void> {
  const db = openDatabase();
  const stores = createStores(db);
  const candidates = stores.sources
    .findByKind("gmail")
    .filter((s) => (s.config.auth as { kind?: string } | undefined)?.kind === "imap-password");

  let sourceId = opts.source;
  if (!sourceId) {
    if (candidates.length === 1) {
      sourceId = candidates[0]?.id;
    } else if (candidates.length === 0) {
      console.error(
        "No password-based mail source configured yet. Create one first (from Codex: " +
          'bridge_source_setup_gmail with authKind "imap-password").',
      );
      process.exitCode = 1;
      return;
    } else {
      console.error("Multiple password-based sources exist — pass --source <id>:");
      for (const s of candidates) {
        console.error(`  ${s.id}  label=${String(s.config.label)}`);
      }
      process.exitCode = 1;
      return;
    }
  }
  const source = sourceId ? stores.sources.get(sourceId) : null;
  db.close();
  if (!sourceId || !source) {
    console.error(`source ${sourceId} not found`);
    process.exitCode = 1;
    return;
  }
  const auth = source.config.auth as { kind?: string; user?: string; host?: string } | undefined;
  if (auth?.kind !== "imap-password") {
    console.error(
      `source ${sourceId} uses ${auth?.kind ?? "unknown"} auth — use \`bridgehead auth gmail\` for OAuth sources`,
    );
    process.exitCode = 1;
    return;
  }

  const password =
    opts.password ??
    (await promptHidden(`IMAP password for ${auth.user ?? "?"} at ${auth.host ?? "?"}: `));
  if (!password) {
    console.error("no password provided");
    process.exitCode = 1;
    return;
  }

  const secrets = await createSecretStore(logger);
  secrets.set(secretNames.imapPassword(sourceId), password);
  console.log(`Stored IMAP password for source ${sourceId} (${secrets.backend}).`);

  try {
    await apiFetch(`/api/sources/${sourceId}/restart`, { method: "POST" });
    console.log("Daemon notified — the mail source is (re)starting.");
  } catch {
    console.log("Daemon not running; the source will start with the next `bridgehead start`.");
  }
}

/** Read a line from the terminal without echoing it. Falls back to visible input off-TTY. */
async function promptHidden(question: string): Promise<string> {
  if (!process.stdin.isTTY) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question(question);
    rl.close();
    return answer.trim();
  }
  process.stdout.write(question);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise<string>((resolve) => {
    let value = "";
    const onData = (chunk: Buffer) => {
      for (const char of chunk.toString("utf8")) {
        if (char === "\r" || char === "\n") {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdin.off("data", onData);
          process.stdout.write("\n");
          resolve(value.trim());
          return;
        }
        if (char === "") {
          // Ctrl+C
          process.stdin.setRawMode(false);
          process.stdout.write("\n");
          process.exit(130);
        }
        if (char === "" || char === "\b") {
          value = value.slice(0, -1);
        } else {
          value += char;
        }
      }
    };
    process.stdin.on("data", onData);
  });
}
