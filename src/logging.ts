import fs from "node:fs";
import { createRequire } from "node:module";
import pino from "pino";
import { logFilePath, logsDir } from "./paths.js";

export type Logger = pino.Logger;

/** Pretty logs on a TTY (CLI use), JSON to file for the daemon. */
export function createLogger(opts: { daemon?: boolean; level?: string } = {}): Logger {
  const level = opts.level ?? process.env.BRIDGEHEAD_LOG_LEVEL ?? "info";
  if (opts.daemon) {
    fs.mkdirSync(logsDir(), { recursive: true });
    const fileDest = pino.destination({ dest: logFilePath(), mkdir: true, sync: false });
    if (process.stdout.isTTY) {
      // Foreground daemon: pretty to stdout AND JSON to file.
      return pino(
        { level },
        pino.multistream([{ stream: pinoPrettyStream() }, { stream: fileDest }]),
      );
    }
    return pino({ level }, fileDest);
  }
  if (process.stdout.isTTY) {
    return pino({ level }, pinoPrettyStream());
  }
  return pino({ level });
}

function pinoPrettyStream(): NodeJS.WritableStream {
  // pino.transport would spawn a worker thread; the sync stream API is simpler and fine at our volume.
  const require = createRequire(import.meta.url);
  const pretty = require("pino-pretty") as (opts: object) => NodeJS.WritableStream;
  return pretty({ colorize: true, translateTime: "SYS:HH:MM:ss", ignore: "pid,hostname" });
}
