import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { logsDir } from "../paths.js";

const execFileAsync = promisify(execFile);

const LAUNCHD_LABEL = "io.wakewire.daemon";

/**
 * launchd (macOS) / systemd user unit (Linux) registration so the daemon
 * starts at login. Windows: run under a terminal or NSSM — documented in the
 * README, no service wrapper in v1.
 */
export async function installService(cliPath: string): Promise<void> {
  if (process.platform === "darwin") {
    const plist = path.join(os.homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
    fs.mkdirSync(path.dirname(plist), { recursive: true });
    fs.mkdirSync(logsDir(), { recursive: true });
    fs.writeFileSync(plist, launchdPlist(cliPath));
    await execFileAsync("launchctl", ["unload", plist]).catch(() => undefined);
    await execFileAsync("launchctl", ["load", plist]);
    console.log(`Installed and loaded launchd agent: ${plist}`);
    return;
  }
  if (process.platform === "linux") {
    const unitDir = path.join(os.homedir(), ".config", "systemd", "user");
    const unit = path.join(unitDir, "wakewire.service");
    fs.mkdirSync(unitDir, { recursive: true });
    fs.writeFileSync(unit, systemdUnit(cliPath));
    console.log(`Wrote ${unit}`);
    console.log(
      "Enable it with:\n  systemctl --user daemon-reload && systemctl --user enable --now wakewire",
    );
    return;
  }
  console.log(
    "No service wrapper for this platform in v1. Run `wakewire start` in a terminal, " +
      "or on Windows use NSSM: nssm install wakewire <node> <cli.js> start",
  );
}

export async function uninstallService(): Promise<void> {
  if (process.platform === "darwin") {
    const plist = path.join(os.homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
    await execFileAsync("launchctl", ["unload", plist]).catch(() => undefined);
    fs.rmSync(plist, { force: true });
    console.log(`Removed ${plist}`);
    return;
  }
  if (process.platform === "linux") {
    const unit = path.join(os.homedir(), ".config", "systemd", "user", "wakewire.service");
    await execFileAsync("systemctl", ["--user", "disable", "--now", "wakewire"]).catch(
      () => undefined,
    );
    fs.rmSync(unit, { force: true });
    console.log(`Removed ${unit}`);
    return;
  }
  console.log("Nothing to uninstall on this platform.");
}

function launchdPlist(cliPath: string): string {
  const stdout = path.join(logsDir(), "launchd.out.log");
  const stderr = path.join(logsDir(), "launchd.err.log");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${process.execPath}</string>
    <string>${cliPath}</string>
    <string>start</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${stdout}</string>
  <key>StandardErrorPath</key><string>${stderr}</string>
</dict>
</plist>
`;
}

function systemdUnit(cliPath: string): string {
  return `[Unit]
Description=wakewire - push external events into Codex threads
After=network-online.target

[Service]
ExecStart=${process.execPath} ${cliPath} start
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;
}
