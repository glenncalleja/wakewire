import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { apiFetch, DaemonNotRunningError } from "../client.js";
import { WebhookMappingSchema } from "../sources/webhook/map.js";
import { WebhookVerificationSchema } from "../sources/webhook/verify.js";
import { VERSION } from "../version.js";

/**
 * Stdio MCP server bundled in the Codex plugin. It is a thin, stateless client
 * of the daemon's localhost API — all state lives in the daemon.
 */
export async function runMcpServer(): Promise<void> {
  const server = new McpServer({ name: "wakewire", version: VERSION });

  server.registerTool(
    "wakewire_status",
    {
      title: "WakeWire status",
      description:
        "Health of the wakewire daemon: sources, queue depth, and whether Codex is reachable.",
      inputSchema: {},
    },
    async () => call("GET", "/api/health"),
  );

  server.registerTool(
    "wakewire_route_add",
    {
      title: "Add a wakewire route",
      description:
        "Create a route that delivers matching external events into a Codex thread. " +
        'For GitHub, match is like {"repo":"owner/repo","events":["push"],"branches":["main"]}. ' +
        'For Gmail, match is like {"label":"agent-inbox"} (a label is required). ' +
        'For Slack, match is like {"events":["app_mention"]} or {"channels":["#dev"],"events":["message"]} ' +
        "(matching plain messages requires naming channels). " +
        'For generic webhook sources, match is like {"provider":"sentry","events":["issue"],"where":[{"field":"level","equals":"error"}]}. ' +
        'target.type "this-thread" targets the current conversation — the tool will tell you how to resolve the thread id if it cannot.',
      inputSchema: {
        name: z.string().min(1).describe("Short human name for the route"),
        source: z.enum(["github", "gmail", "slack", "webhook"]),
        match: z
          .record(z.string(), z.unknown())
          .describe("Source-specific match rules (see tool description)"),
        target: z.object({
          type: z.enum(["this-thread", "thread", "new-thread"]),
          threadId: z.string().optional().describe('Required when type is "thread"'),
          cwd: z.string().optional().describe('Required when type is "new-thread"'),
          worktree: z
            .boolean()
            .optional()
            .describe("new-thread only: run in a fresh git worktree per delivery"),
        }),
        promptTemplate: z
          .string()
          .optional()
          .describe(
            "Optional instructions template. May interpolate only whitelisted summary fields " +
              "like {{summary}}, {{repo}}, {{branch}}, {{subject}} — never raw payload content.",
          ),
        sandbox: z
          .enum(["read-only", "workspace-write"])
          .optional()
          .describe(
            "Sandbox for injected turns. Default read-only. Gmail routes are always read-only.",
          ),
        rateLimitPerMinute: z
          .number()
          .int()
          .positive()
          .max(600)
          .optional()
          .describe(
            "Deliveries per minute for this route before bursts coalesce into a digest turn (default 10).",
          ),
      },
    },
    async (args) => {
      if (args.target.type === "this-thread") {
        return text(
          [
            "To target the current thread I need its id, and MCP tools cannot see it.",
            "Do this now:",
            '1. Run this shell command in this conversation: echo "$CODEX_THREAD_ID"',
            "   (Codex exposes the current thread id to shell commands.)",
            '2. Call wakewire_route_add again with target {"type":"thread","threadId":"<the value>"}.',
          ].join("\n"),
        );
      }
      if (args.target.type === "thread" && !args.target.threadId) {
        return text('target.type "thread" requires target.threadId');
      }
      if (args.target.type === "new-thread" && !args.target.cwd) {
        return text('target.type "new-thread" requires target.cwd (an absolute path)');
      }
      const target =
        args.target.type === "thread"
          ? { type: "thread", threadId: args.target.threadId }
          : { type: "new-thread", cwd: args.target.cwd, worktree: args.target.worktree ?? false };
      const result = await call("POST", "/api/routes", {
        name: args.name,
        source: args.source,
        match: args.match,
        target,
        ...(args.promptTemplate ? { promptTemplate: args.promptTemplate } : {}),
        ...(args.sandbox ? { sandbox: args.sandbox } : {}),
        ...(args.rateLimitPerMinute ? { rateLimitPerMinute: args.rateLimitPerMinute } : {}),
      });
      return appendNote(
        result,
        "Sandbox note: the sandbox policy is applied to each injected turn (and to subsequent turns " +
          "on that thread until something changes it again). Gmail routes are forced read-only.",
      );
    },
  );

  server.registerTool(
    "wakewire_route_list",
    {
      title: "List wakewire routes",
      description:
        "List all configured routes with their ids, matches, targets, and enabled state.",
      inputSchema: {},
    },
    async () => call("GET", "/api/routes"),
  );

  server.registerTool(
    "wakewire_route_remove",
    {
      title: "Remove a wakewire route",
      description: "Delete a route (and its delivery history) by id.",
      inputSchema: { id: z.string().min(1) },
    },
    async ({ id }) => call("DELETE", `/api/routes/${encodeURIComponent(id)}`),
  );

  server.registerTool(
    "wakewire_route_toggle",
    {
      title: "Enable/disable a wakewire route",
      description: "Toggle a route on or off without deleting it.",
      inputSchema: { id: z.string().min(1), enabled: z.boolean() },
    },
    async ({ id, enabled }) =>
      call("POST", `/api/routes/${encodeURIComponent(id)}/toggle`, { enabled }),
  );

  server.registerTool(
    "wakewire_deliveries",
    {
      title: "Inspect wakewire deliveries",
      description:
        "The event inspector: recent deliveries with status (queued, delivered, failed, held, " +
        "skipped-duplicate, coalesced), errors, and the rendered prompts.",
      inputSchema: {
        limit: z.number().int().positive().max(500).optional(),
        routeId: z.string().optional(),
        status: z
          .enum([
            "received",
            "queued",
            "delivering",
            "delivered",
            "failed",
            "skipped-duplicate",
            "held",
            "coalesced",
          ])
          .optional(),
      },
    },
    async (args) => {
      const params = new URLSearchParams();
      if (args.limit) params.set("limit", String(args.limit));
      if (args.routeId) params.set("routeId", args.routeId);
      if (args.status) params.set("status", args.status);
      const qs = params.toString();
      return call("GET", `/api/deliveries${qs ? `?${qs}` : ""}`);
    },
  );

  server.registerTool(
    "wakewire_replay",
    {
      title: "Replay a wakewire delivery",
      description:
        "Re-render a past delivery against the route's current template and enqueue it again.",
      inputSchema: { deliveryId: z.string().min(1) },
    },
    async ({ deliveryId }) =>
      call("POST", `/api/deliveries/${encodeURIComponent(deliveryId)}/replay`),
  );

  server.registerTool(
    "wakewire_source_setup_github",
    {
      title: "Set up the GitHub event source",
      description:
        "Create a webhook ingress for GitHub (a smee.io relay channel by default) and return the " +
        "webhook URL, secret, and step-by-step setup instructions to relay to the user.",
      inputSchema: {
        repo: z
          .string()
          .regex(/^[\w.-]+\/[\w.-]+$/)
          .optional()
          .describe('"owner/repo" the webhook will be added to (informational)'),
        mode: z
          .enum(["smee", "listen"])
          .optional()
          .describe("smee (default): relay via smee.io. listen: direct POSTs to the local daemon."),
      },
    },
    async (args) => call("POST", "/api/sources/github/setup", args),
  );

  server.registerTool(
    "wakewire_source_setup_webhook",
    {
      title: "Set up a generic webhook source",
      description:
        "Register a signed webhook ingress for ANY provider (Sentry, Grafana, Linear, ClickUp, " +
        "Stripe, CI, custom apps). Verification presets: hmac-sha256 (HMAC of the raw body in a " +
        'header, optional prefix like "sha256=") or secret-header (shared secret sent verbatim). ' +
        "The field mapping doubles as the payload whitelist — only mapped fields reach the model. " +
        "Workflow for a new provider: 1) call this without a mapping (capture mode stores the next " +
        "few raw events), 2) trigger a test event, 3) inspect it with wakewire_source_captures, " +
        '4) call this again with the mapping you authored, 5) add a route with source "webhook" ' +
        'and match {"provider": "<name>"}.',
      inputSchema: {
        name: z
          .string()
          .regex(/^[a-z0-9][a-z0-9_-]*$/i)
          .describe('Provider label, e.g. "sentry" — used as match.provider in routes'),
        mode: z.enum(["smee", "listen"]).optional().describe("smee (default) or direct listen"),
        // The canonical schemas — never redeclare these here: zod strips
        // unknown keys, so a drifted copy silently drops tool arguments.
        verification: WebhookVerificationSchema.describe("How the provider signs requests"),
        mapping: WebhookMappingSchema.optional().describe(
          "Omit on first setup to use capture mode",
        ),
        capture: z
          .number()
          .int()
          .min(0)
          .max(10)
          .optional()
          .describe("How many upcoming raw events to capture (default 3 for new sources)"),
        rotateSecret: z.boolean().optional().describe("Mint a new signing secret"),
      },
    },
    async (args) => call("POST", "/api/sources/webhook/setup", args),
  );

  server.registerTool(
    "wakewire_source_captures",
    {
      title: "Inspect captured webhook payloads",
      description:
        "Raw payloads captured while a webhook source is in capture mode — read one to author " +
        "the field mapping for wakewire_source_setup_webhook.",
      inputSchema: {
        sourceId: z.string().min(1),
        limit: z.number().int().positive().max(10).optional(),
      },
    },
    async ({ sourceId, limit }) => {
      const qs = limit ? `?limit=${limit}` : "";
      return call("GET", `/api/sources/${encodeURIComponent(sourceId)}/captures${qs}`);
    },
  );

  server.registerTool(
    "wakewire_source_setup_slack",
    {
      title: "Set up the Slack event source",
      description:
        "Register a Slack workspace watch over Socket Mode (outbound WebSocket — no public URL). " +
        "Returns the one-time Slack app setup steps; the tokens themselves are stored in a " +
        "terminal via `wakewire auth slack`, never through this conversation.",
      inputSchema: {
        team: z
          .string()
          .optional()
          .describe("Workspace name, informational — used in the source id (default: default)"),
        includeBotMessages: z
          .boolean()
          .optional()
          .describe("Also deliver messages posted by bots/integrations (default false)"),
      },
    },
    async (args) => call("POST", "/api/sources/slack/setup", args),
  );

  server.registerTool(
    "wakewire_source_remove",
    {
      title: "Remove a wakewire source",
      description:
        "Stop and delete an event source by id (see wakewire_status for ids). Also removes its stored secrets.",
      inputSchema: { id: z.string().min(1) },
    },
    async ({ id }) => call("DELETE", `/api/sources/${encodeURIComponent(id)}`),
  );

  server.registerTool(
    "wakewire_source_setup_gmail",
    {
      title: "Set up the Gmail/IMAP event source",
      description:
        "Register a mail label watch and return setup instructions. Two auth options: " +
        '"gmail-oauth" (default — user brings their own Google OAuth client, then runs ' +
        '`wakewire auth gmail`) or "imap-password" (a Gmail app password or any IMAP ' +
        "server's password, then `wakewire auth imap` — simpler, no OAuth client needed).",
      inputSchema: {
        label: z.string().min(1).describe("Label/folder to watch, e.g. agent-inbox"),
        user: z.string().email().describe("Mail address"),
        authKind: z
          .enum(["gmail-oauth", "imap-password"])
          .optional()
          .describe("Default gmail-oauth. Use imap-password for app passwords or non-Gmail IMAP."),
        host: z
          .string()
          .optional()
          .describe("imap-password only: IMAP host (default imap.gmail.com)"),
        port: z.number().int().positive().optional().describe("imap-password only: default 993"),
      },
    },
    async (args) => call("POST", "/api/sources/gmail/setup", args),
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

type ToolResult = { content: Array<{ type: "text"; text: string }> };

async function call(method: string, path: string, body?: unknown): Promise<ToolResult> {
  try {
    const response = await apiFetch(path, { method, ...(body !== undefined ? { body } : {}) });
    const payload = JSON.stringify(response.body, null, 2);
    if (response.status >= 400) {
      return text(`daemon returned HTTP ${response.status}:\n${payload}`);
    }
    return text(payload);
  } catch (err) {
    if (err instanceof DaemonNotRunningError) {
      return text(
        `${err.message}\nIf wakewire is not installed: npm install -g wakewire && wakewire init && wakewire start`,
      );
    }
    return text(`wakewire error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function text(message: string): ToolResult {
  return { content: [{ type: "text", text: message }] };
}

function appendNote(result: ToolResult, note: string): ToolResult {
  return { content: [...result.content, { type: "text" as const, text: note }] };
}
