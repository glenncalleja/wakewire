import fs from "node:fs";
import path from "node:path";
import type { Logger } from "../logging.js";
import { secretsFilePath } from "../paths.js";

/**
 * Secrets (webhook secrets, OAuth tokens, IMAP passwords) live in the OS
 * keychain when available, with a 0600 JSON file as a loud fallback.
 * Secret values are never logged.
 */
export interface SecretStore {
  readonly backend: "keychain" | "file";
  get(name: string): string | null;
  set(name: string, value: string): void;
  delete(name: string): void;
}

const SERVICE = "bridgehead";

class KeychainSecretStore implements SecretStore {
  readonly backend = "keychain" as const;
  constructor(private readonly entryFactory: (service: string, name: string) => KeyringEntry) {}

  get(name: string): string | null {
    try {
      return this.entryFactory(SERVICE, name).getPassword();
    } catch {
      return null;
    }
  }

  set(name: string, value: string): void {
    this.entryFactory(SERVICE, name).setPassword(value);
  }

  delete(name: string): void {
    try {
      this.entryFactory(SERVICE, name).deletePassword();
    } catch {
      // already gone
    }
  }
}

interface KeyringEntry {
  getPassword(): string | null;
  setPassword(value: string): void;
  deletePassword(): boolean;
}

export class FileSecretStore implements SecretStore {
  readonly backend = "file" as const;
  constructor(private readonly file: string = secretsFilePath()) {}

  get(name: string): string | null {
    return this.read()[name] ?? null;
  }

  set(name: string, value: string): void {
    const all = this.read();
    all[name] = value;
    this.write(all);
  }

  delete(name: string): void {
    const all = this.read();
    delete all[name];
    this.write(all);
  }

  private read(): Record<string, string> {
    try {
      return JSON.parse(fs.readFileSync(this.file, "utf8"));
    } catch {
      return {};
    }
  }

  private write(all: Record<string, string>): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(all, null, 2), { mode: 0o600 });
    fs.chmodSync(this.file, 0o600);
  }
}

export async function createSecretStore(logger: Logger): Promise<SecretStore> {
  try {
    const { Entry } = await import("@napi-rs/keyring");
    const store = new KeychainSecretStore((service, name) => new Entry(service, name));
    // Round-trip probe: some Linux environments load the module but have no
    // usable secret service.
    const probeName = "__bridgehead_probe__";
    store.set(probeName, "ok");
    const ok = store.get(probeName) === "ok";
    store.delete(probeName);
    if (ok) return store;
  } catch {
    // fall through to file store
  }
  logger.warn(
    { file: secretsFilePath() },
    "OS keychain unavailable — falling back to a 0600 JSON file for secrets. " +
      "Anyone with read access to this file can read your webhook secrets and OAuth tokens.",
  );
  return new FileSecretStore();
}

/** Well-known secret names. */
export const secretNames = {
  githubWebhookSecret: (sourceId: string) => `github:${sourceId}:webhook-secret`,
  gmailClientId: (sourceId: string) => `gmail:${sourceId}:client-id`,
  gmailClientSecret: (sourceId: string) => `gmail:${sourceId}:client-secret`,
  gmailRefreshToken: (sourceId: string) => `gmail:${sourceId}:refresh-token`,
  imapPassword: (sourceId: string) => `imap:${sourceId}:password`,
  slackAppToken: (sourceId: string) => `slack:${sourceId}:app-token`,
  slackBotToken: (sourceId: string) => `slack:${sourceId}:bot-token`,
  webhookSecret: (sourceId: string) => `webhook:${sourceId}:secret`,
} as const;
