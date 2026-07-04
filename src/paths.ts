import os from "node:os";
import path from "node:path";

/** Root directory for all wakewire state. Overridable for tests and multi-profile setups. */
export function wakewireHome(): string {
  return process.env.WAKEWIRE_HOME ?? path.join(os.homedir(), ".wakewire");
}

export function dbPath(): string {
  return path.join(wakewireHome(), "state.db");
}

/** Written by the daemon on boot: { pid, port, token, startedAt }. Mode 0600. */
export function stateFilePath(): string {
  return path.join(wakewireHome(), "daemon.json");
}

export function logsDir(): string {
  return path.join(wakewireHome(), "logs");
}

export function logFilePath(): string {
  return path.join(logsDir(), "wakewire.log");
}

/** Fallback secret storage when no OS keychain is available. Mode 0600. */
export function secretsFilePath(): string {
  return path.join(wakewireHome(), "secrets.json");
}

export function worktreesDir(): string {
  return path.join(wakewireHome(), "worktrees");
}
