import os from "node:os";
import path from "node:path";

/** Root directory for all bridgehead state. Overridable for tests and multi-profile setups. */
export function bridgeheadHome(): string {
  return process.env.BRIDGEHEAD_HOME ?? path.join(os.homedir(), ".bridgehead");
}

export function dbPath(): string {
  return path.join(bridgeheadHome(), "state.db");
}

/** Written by the daemon on boot: { pid, port, token, startedAt }. Mode 0600. */
export function stateFilePath(): string {
  return path.join(bridgeheadHome(), "daemon.json");
}

export function logsDir(): string {
  return path.join(bridgeheadHome(), "logs");
}

export function logFilePath(): string {
  return path.join(logsDir(), "bridgehead.log");
}

/** Fallback secret storage when no OS keychain is available. Mode 0600. */
export function secretsFilePath(): string {
  return path.join(bridgeheadHome(), "secrets.json");
}

export function worktreesDir(): string {
  return path.join(bridgeheadHome(), "worktrees");
}
