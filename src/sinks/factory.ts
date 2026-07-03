import type { DaemonConfig } from "../config.js";
import type { Logger } from "../logging.js";
import { CodexAppServerAdapter } from "./codex-app-server.js";
import { CodexExecAdapter } from "./codex-exec.js";
import { CodexSdkAdapter } from "./codex-sdk.js";
import type { AgentAdapter } from "./types.js";

export function createAdapter(config: DaemonConfig, logger: Logger): AgentAdapter {
  switch (config.adapter) {
    case "codex-app-server":
      return new CodexAppServerAdapter(logger, {
        codexPath: config.codexPath,
        model: config.model,
        connection: config.appServerConnection,
      });
    case "codex-exec":
      return new CodexExecAdapter(logger, {
        codexPath: config.codexPath,
        model: config.model,
      });
    default:
      return new CodexSdkAdapter(logger, {
        codexPath: config.codexPath,
        model: config.model,
      });
  }
}
