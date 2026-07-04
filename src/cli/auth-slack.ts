import { apiFetch } from "../client.js";
import { openDatabase } from "../db/db.js";
import { createStores } from "../db/repos.js";
import type { Logger } from "../logging.js";
import { createSecretStore, secretNames } from "../secrets/store.js";
import { promptHidden } from "./prompt.js";

/**
 * Store the Socket Mode tokens for a slack source: the app-level token
 * (xapp-…, connections:write) that opens the WebSocket, and the bot token
 * (xoxb-…) used to resolve channel/user names.
 */
export async function authSlack(
  logger: Logger,
  opts: { source?: string; appToken?: string; botToken?: string },
): Promise<void> {
  const db = openDatabase();
  const stores = createStores(db);
  const candidates = stores.sources.findByKind("slack");
  let sourceId = opts.source;
  if (!sourceId) {
    if (candidates.length === 1) {
      sourceId = candidates[0]?.id;
    } else if (candidates.length === 0) {
      console.error(
        "No slack source configured yet. Create one first (from Codex: wakewire_source_setup_slack).",
      );
      process.exitCode = 1;
      return;
    } else {
      console.error("Multiple slack sources exist — pass --source <id>:");
      for (const s of candidates) {
        console.error(`  ${s.id}  team=${String(s.config.team)}`);
      }
      process.exitCode = 1;
      return;
    }
  }
  const source = sourceId ? stores.sources.get(sourceId) : null;
  db.close();
  if (!sourceId || !source || source.kind !== "slack") {
    console.error(`slack source ${sourceId} not found`);
    process.exitCode = 1;
    return;
  }

  const appToken = opts.appToken ?? (await promptHidden("App-level token (xapp-…): "));
  if (!appToken.startsWith("xapp-")) {
    console.error("that does not look like an app-level token (should start with xapp-)");
    process.exitCode = 1;
    return;
  }
  const botToken = opts.botToken ?? (await promptHidden("Bot token (xoxb-…, Enter to skip): "));
  if (botToken && !botToken.startsWith("xoxb-")) {
    console.error("that does not look like a bot token (should start with xoxb-)");
    process.exitCode = 1;
    return;
  }

  const secrets = await createSecretStore(logger);
  secrets.set(secretNames.slackAppToken(sourceId), appToken);
  if (botToken) {
    secrets.set(secretNames.slackBotToken(sourceId), botToken);
  }
  console.log(
    `Stored Slack ${botToken ? "app + bot tokens" : "app token (no bot token — names will not resolve)"} for source ${sourceId} (${secrets.backend}).`,
  );

  try {
    await apiFetch(`/api/sources/${sourceId}/restart`, { method: "POST" });
    console.log("Daemon notified — the slack source is (re)starting.");
  } catch {
    console.log("Daemon not running; the source will start with the next `wakewire start`.");
  }
}
