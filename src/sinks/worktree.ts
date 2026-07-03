import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { worktreesDir } from "../paths.js";
import { PermanentError } from "./types.js";

const execFileAsync = promisify(execFile);

/**
 * For {type:"new-thread", worktree:true} targets: create a detached git
 * worktree of the route's cwd so the spawned thread works on an isolated
 * checkout. Worktrees accumulate under ~/.bridgehead/worktrees; `git worktree
 * remove` them when done.
 */
export async function prepareWorktree(baseCwd: string, deliveryId: string): Promise<string> {
  try {
    await execFileAsync("git", ["-C", baseCwd, "rev-parse", "--git-dir"]);
  } catch {
    throw new PermanentError(`worktree target requires a git repository at ${baseCwd}`);
  }
  const name = `${path.basename(baseCwd)}-${deliveryId.slice(0, 8)}-${Date.now()}`;
  const dir = path.join(worktreesDir(), name);
  fs.mkdirSync(worktreesDir(), { recursive: true });
  try {
    await execFileAsync("git", ["-C", baseCwd, "worktree", "add", "--detach", dir]);
  } catch (err) {
    throw new PermanentError(
      `git worktree add failed: ${err instanceof Error ? err.message : err}`,
    );
  }
  return dir;
}
