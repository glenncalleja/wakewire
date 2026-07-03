import crypto from "node:crypto";
import { z } from "zod";
import type { SettingsStore } from "./db/repos.js";

export const AdapterNameSchema = z.enum(["codex-sdk", "codex-app-server", "codex-exec"]);
export type AdapterName = z.infer<typeof AdapterNameSchema>;

export interface DaemonConfig {
  adapter: AdapterName;
  codexPath: string | undefined;
  model: string | undefined;
  appServerConnection: "auto" | "proxy" | "spawn";
  ratePerMinute: number;
  /** 0 = pick a random free port and record it in the state file. */
  apiPort: number;
  apiToken: string;
}

export const settingKeys = {
  adapter: "sink.adapter",
  codexPath: "sink.codexPath",
  model: "sink.model",
  appServerConnection: "sink.appServerConnection",
  ratePerMinute: "queue.ratePerMinute",
  apiPort: "api.port",
  apiToken: "api.token",
} as const;

export function loadConfig(settings: SettingsStore): DaemonConfig {
  const adapter = AdapterNameSchema.catch("codex-sdk").parse(
    settings.get(settingKeys.adapter) ?? "codex-sdk",
  );
  const rate = Number(settings.get(settingKeys.ratePerMinute) ?? "10");
  const port = Number(settings.get(settingKeys.apiPort) ?? "0");
  const connection = z
    .enum(["auto", "proxy", "spawn"])
    .catch("auto")
    .parse(settings.get(settingKeys.appServerConnection) ?? "auto");
  return {
    adapter,
    codexPath: settings.get(settingKeys.codexPath) ?? undefined,
    model: settings.get(settingKeys.model) ?? undefined,
    appServerConnection: connection,
    ratePerMinute: Number.isFinite(rate) && rate > 0 ? rate : 10,
    apiPort: Number.isFinite(port) && port >= 0 ? port : 0,
    apiToken: settings.getOrCreate(settingKeys.apiToken, () =>
      crypto.randomBytes(32).toString("hex"),
    ),
  };
}
