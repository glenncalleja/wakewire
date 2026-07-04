import fs from "node:fs";
import type { DaemonState } from "./daemon/daemon.js";
import { stateFilePath } from "./paths.js";

/** Shared by the CLI and the MCP server to talk to the daemon's localhost API. */

export class DaemonNotRunningError extends Error {
  constructor(detail = "") {
    super(
      `wakewire daemon is not running${detail ? ` (${detail})` : ""}. Start it with: wakewire start`,
    );
  }
}

export function readDaemonState(): DaemonState | null {
  try {
    const state = JSON.parse(fs.readFileSync(stateFilePath(), "utf8")) as DaemonState;
    if (!state.port || !state.token) return null;
    return state;
  } catch {
    return null;
  }
}

export interface ApiResponse<T = unknown> {
  status: number;
  body: T;
}

export async function apiFetch<T = unknown>(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<ApiResponse<T>> {
  const state = readDaemonState();
  if (!state) throw new DaemonNotRunningError("no state file");
  let response: Response;
  try {
    response = await fetch(`http://127.0.0.1:${state.port}${path}`, {
      method: init.method ?? "GET",
      headers: {
        authorization: `Bearer ${state.token}`,
        ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
  } catch (err) {
    throw new DaemonNotRunningError(err instanceof Error ? err.message : String(err));
  }
  const body = (await response.json().catch(() => ({}))) as T;
  return { status: response.status, body };
}
