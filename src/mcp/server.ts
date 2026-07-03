import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { apiFetch, DaemonNotRunningError } from "../client.js";
import { VERSION } from "../version.js";

/**
 * Stdio MCP server bundled in the Codex plugin. It is a thin, stateless client
 * of the daemon's localhost API — all state lives in the daemon.
 */
export async function runMcpServer(): Promise<void> {
  const server = new McpServer({ name: "bridgehead", version: VERSION });

  server.registerTool(
    "bridge_status",
    {
      title: "Bridgehead status",
      description:
        "Health of the bridgehead daemon: sources, queue depth, and whether Codex is reachable.",
      inputSchema: {},
    },
    async () => call("GET", "/api/health"),
  );

  server.registerTool(
    "bridge_route_add",
    {
      title: "Add a bridgehead route",
      description:
        "Create a route that delivers matching external events into a Codex thread. " +
        'For GitHub, match is like {"repo":"owner/repo","events":["push"],"branches":["main"]}. ' +
        'For Gmail, match is like {"label":"agent-inbox"} (a label is required). ' +
        'target.type "this-thread" targets the current conversation — the tool will tell you how to resolve the thread id if it cannot.',
      inputSchema: {
        name: z.string().min(1).describe("Short human name for the route"),
        source: z.enum(["github", "gmail"]),
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
            '2. Call bridge_route_add again with target {"type":"thread","threadId":"<the value>"}.',
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
    "bridge_route_list",
    {
      title: "List bridgehead routes",
      description:
        "List all configured routes with their ids, matches, targets, and enabled state.",
      inputSchema: {},
    },
    async () => call("GET", "/api/routes"),
  );

  server.registerTool(
    "bridge_route_remove",
    {
      title: "Remove a bridgehead route",
      description: "Delete a route (and its delivery history) by id.",
      inputSchema: { id: z.string().min(1) },
    },
    async ({ id }) => call("DELETE", `/api/routes/${encodeURIComponent(id)}`),
  );

  server.registerTool(
    "bridge_route_toggle",
    {
      title: "Enable/disable a bridgehead route",
      description: "Toggle a route on or off without deleting it.",
      inputSchema: { id: z.string().min(1), enabled: z.boolean() },
    },
    async ({ id, enabled }) =>
      call("POST", `/api/routes/${encodeURIComponent(id)}/toggle`, { enabled }),
  );

  server.registerTool(
    "bridge_deliveries",
    {
      title: "Inspect bridgehead deliveries",
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
    "bridge_replay",
    {
      title: "Replay a bridgehead delivery",
      description:
        "Re-render a past delivery against the route's current template and enqueue it again.",
      inputSchema: { deliveryId: z.string().min(1) },
    },
    async ({ deliveryId }) =>
      call("POST", `/api/deliveries/${encodeURIComponent(deliveryId)}/replay`),
  );

  server.registerTool(
    "bridge_source_setup_github",
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
    "bridge_source_setup_gmail",
    {
      title: "Set up the Gmail event source",
      description:
        "Register a Gmail label watch and return the OAuth setup instructions. The browser OAuth " +
        "flow itself runs in a terminal via `bridgehead auth gmail`.",
      inputSchema: {
        label: z.string().min(1).describe("Gmail label to watch, e.g. agent-inbox"),
        user: z.string().email().describe("Gmail address"),
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
        `${err.message}\nIf bridgehead is not installed: npm install -g bridgehead && bridgehead init && bridgehead start`,
      );
    }
    return text(`bridgehead error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function text(message: string): ToolResult {
  return { content: [{ type: "text", text: message }] };
}

function appendNote(result: ToolResult, note: string): ToolResult {
  return { content: [...result.content, { type: "text" as const, text: note }] };
}
