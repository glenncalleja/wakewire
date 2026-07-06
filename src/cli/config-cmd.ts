import { apiFetch } from "../client.js";
import { AdapterNameSchema, settingKeys } from "../config.js";
import { openDatabase } from "../db/db.js";
import { createStores } from "../db/repos.js";
import { assertLoopbackWsUrl } from "../sinks/codex-app-server.js";

const KNOWN: Record<string, string> = {
  [settingKeys.adapter]: "codex sink: codex-sdk (default) | codex-app-server | codex-exec",
  [settingKeys.codexPath]: "override the codex binary path",
  [settingKeys.model]: "model override for injected turns",
  [settingKeys.appServerConnection]: "app-server connection: auto (default) | proxy | spawn",
  [settingKeys.appServerListen]:
    "shared-server mode: loopback ws:// URL (e.g. ws://127.0.0.1:4571) for live codex --remote viewing",
  [settingKeys.ratePerMinute]: "default deliveries/minute per route before digest coalescing (10)",
  [settingKeys.apiPort]: "management API port (0 = random)",
};

const SENSITIVE = new Set<string>([settingKeys.apiToken]);

export function configList(): void {
  const db = openDatabase();
  const settings = createStores(db).settings;
  for (const [key, help] of Object.entries(KNOWN)) {
    const value = settings.get(key);
    console.log(`${key} = ${value ?? "(default)"}\n    ${help}`);
  }
  db.close();
}

export function configGet(key: string): void {
  if (SENSITIVE.has(key)) {
    console.error(`${key} is sensitive and not printable here`);
    process.exitCode = 1;
    return;
  }
  const db = openDatabase();
  const value = createStores(db).settings.get(key);
  db.close();
  console.log(value ?? "(not set — using default)");
}

export async function configSet(key: string, value: string): Promise<void> {
  if (!(key in KNOWN)) {
    console.error(`unknown setting "${key}" — known keys:\n  ${Object.keys(KNOWN).join("\n  ")}`);
    process.exitCode = 1;
    return;
  }
  if (key === settingKeys.adapter) {
    const parsed = AdapterNameSchema.safeParse(value);
    if (!parsed.success) {
      console.error(`invalid adapter "${value}" — use codex-sdk | codex-app-server | codex-exec`);
      process.exitCode = 1;
      return;
    }
  }
  if (key === settingKeys.appServerListen && value !== "") {
    try {
      assertLoopbackWsUrl(value);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
      return;
    }
  }
  const db = openDatabase();
  createStores(db).settings.set(key, value);
  db.close();
  console.log(`${key} = ${value}`);
  try {
    await apiFetch("/api/health");
    console.log("Note: the daemon is running — restart it to apply: wakewire stop && wakewire start --detach");
  } catch {
    // daemon not running; new value applies on next start
  }
}
