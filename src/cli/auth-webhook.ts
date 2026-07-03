import { apiFetch } from "../client.js";
import { openDatabase } from "../db/db.js";
import { createStores } from "../db/repos.js";
import type { Logger } from "../logging.js";
import { createSecretStore, secretNames } from "../secrets/store.js";
import { promptHidden } from "./prompt.js";

/**
 * Store a provider-issued signing secret for a generic webhook source (some
 * providers, like ClickUp, generate the secret themselves and hand it to you
 * when the webhook is registered).
 */
export async function authWebhook(
  logger: Logger,
  opts: { source?: string; secret?: string },
): Promise<void> {
  const db = openDatabase();
  const stores = createStores(db);
  const candidates = stores.sources.findByKind("webhook");
  let sourceId = opts.source;
  if (!sourceId) {
    if (candidates.length === 1) {
      sourceId = candidates[0]?.id;
    } else if (candidates.length === 0) {
      console.error(
        "No webhook source configured yet. Create one first (from Codex: bridge_source_setup_webhook).",
      );
      process.exitCode = 1;
      return;
    } else {
      console.error("Multiple webhook sources exist — pass --source <id>:");
      for (const s of candidates) {
        console.error(`  ${s.id}  provider=${String(s.config.name)}`);
      }
      process.exitCode = 1;
      return;
    }
  }
  const source = sourceId ? stores.sources.get(sourceId) : null;
  db.close();
  if (!sourceId || !source || source.kind !== "webhook") {
    console.error(`webhook source ${sourceId} not found`);
    process.exitCode = 1;
    return;
  }

  const secret =
    opts.secret ?? (await promptHidden(`Signing secret for ${String(source.config.name)}: `));
  if (!secret) {
    console.error("no secret provided");
    process.exitCode = 1;
    return;
  }
  const secrets = await createSecretStore(logger);
  secrets.set(secretNames.webhookSecret(sourceId), secret);
  console.log(`Stored webhook secret for source ${sourceId} (${secrets.backend}).`);

  try {
    await apiFetch(`/api/sources/${sourceId}/restart`, { method: "POST" });
    console.log("Daemon notified — the source is (re)starting.");
  } catch {
    console.log("Daemon not running; the source will start with the next `bridgehead start`.");
  }
}
