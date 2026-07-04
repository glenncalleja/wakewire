import fs from "node:fs";
import type { Server } from "node:http";
import { serve } from "@hono/node-server";
import { loadConfig } from "../config.js";
import { DeliveryQueue } from "../core/queue.js";
import { matchRoutes } from "../core/router.js";
import { openDatabase } from "../db/db.js";
import { createStores, type Stores } from "../db/repos.js";
import type { Logger } from "../logging.js";
import { stateFilePath, wakewireHome } from "../paths.js";
import { createSecretStore } from "../secrets/store.js";
import { createAdapter } from "../sinks/factory.js";
import { prepareWorktree } from "../sinks/worktree.js";
import { VERSION } from "../version.js";
import { createApi } from "./api.js";
import { SourceManager } from "./sources.js";

export interface DaemonState {
  pid: number;
  port: number;
  token: string;
  startedAt: string;
  version: string;
}

export class Daemon {
  private stores: Stores | null = null;
  private queue: DeliveryQueue | null = null;
  private sources: SourceManager | null = null;
  private server: Server | null = null;
  private adapter: import("../sinks/types.js").AgentAdapter | null = null;
  private db: ReturnType<typeof openDatabase> | null = null;

  constructor(private readonly logger: Logger) {}

  async start(): Promise<DaemonState> {
    fs.mkdirSync(wakewireHome(), { recursive: true });
    this.db = openDatabase();
    const stores = createStores(this.db);
    this.stores = stores;
    const config = loadConfig(stores.settings);
    const secrets = await createSecretStore(this.logger);
    const adapter = createAdapter(config, this.logger);
    this.adapter = adapter;

    const queue = new DeliveryQueue(stores, adapter, this.logger, {
      ratePerMinute: config.ratePerMinute,
      prepareWorktree: (_route, delivery) =>
        prepareWorktree((_route.target as { cwd: string }).cwd, delivery.id),
    });
    this.queue = queue;

    const sources = new SourceManager(stores, secrets, this.logger, (event) => {
      const routes = matchRoutes(stores.routes.listEnabled(), event);
      if (routes.length === 0) {
        this.logger.debug(
          { source: event.source, kind: event.kind, deliveryId: event.deliveryId },
          "event matched no routes",
        );
        return;
      }
      for (const route of routes) {
        queue.enqueueEvent(route, event);
      }
    });
    this.sources = sources;

    const startedAt = new Date().toISOString();
    const api = createApi({
      stores,
      queue,
      sources,
      secrets,
      adapter,
      config,
      logger: this.logger,
      startedAt,
    });

    const port = await new Promise<number>((resolve) => {
      const server = serve(
        { fetch: api.fetch, hostname: "127.0.0.1", port: config.apiPort },
        (info) => resolve(info.port),
      );
      this.server = server as Server;
    });

    const state: DaemonState = {
      pid: process.pid,
      port,
      token: config.apiToken,
      startedAt,
      version: VERSION,
    };
    fs.writeFileSync(stateFilePath(), JSON.stringify(state, null, 2), { mode: 0o600 });
    fs.chmodSync(stateFilePath(), 0o600);

    queue.start();
    await sources.startAll();

    this.logger.info(
      { port, adapter: adapter.name, version: VERSION },
      "wakewire daemon ready on 127.0.0.1",
    );
    return state;
  }

  async stop(): Promise<void> {
    this.logger.info("daemon shutting down");
    this.queue?.stop();
    await this.sources?.stopAll();
    // Kills adapter connections AND any shared app-server child it owns —
    // otherwise the hard exit below orphans the spawned server.
    this.adapter?.close?.();
    await new Promise<void>((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
    });
    this.db?.close();
    try {
      const state = JSON.parse(fs.readFileSync(stateFilePath(), "utf8")) as DaemonState;
      if (state.pid === process.pid) fs.unlinkSync(stateFilePath());
    } catch {
      // state file already gone
    }
  }
}

/** Run the daemon in the foreground until SIGINT/SIGTERM. */
export async function runDaemon(logger: Logger): Promise<void> {
  const daemon = new Daemon(logger);
  await daemon.start();
  await new Promise<void>((resolve) => {
    const shutdown = () => {
      void daemon.stop().finally(resolve);
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
  // Lingering source sockets (e.g. a tarpitted IMAP connect) must not keep a
  // cleanly-stopped daemon alive as a zombie.
  process.exit(0);
}
