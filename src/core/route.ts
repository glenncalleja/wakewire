import { z } from "zod";

export const GithubMatchSchema = z.object({
  /** "owner/repo" */
  repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/, 'expected "owner/repo"'),
  /**
   * GitHub event names, optionally with an action suffix: "push",
   * "pull_request", "pull_request.opened", "issues.closed".
   * A bare event name matches all of its actions.
   */
  events: z.array(z.string().min(1)).min(1).default(["push"]),
  /** For push events: only these branches. Omit for all branches. */
  branches: z.array(z.string().min(1)).optional(),
});

export const SlackMatchSchema = z
  .object({
    /**
     * Channel ids (C…) or names (with or without "#"). Required when matching
     * plain messages — mention-only routes may span all channels the bot is in.
     */
    channels: z.array(z.string().min(1)).min(1).optional(),
    /**
     * Slack event types: "app_mention" (default), "message",
     * "message.<subtype>", "reaction_added". Bare "message" matches all subtypes.
     */
    events: z.array(z.string().min(1)).min(1).default(["app_mention"]),
    /** Filter on the sender: user id (U…) or a case-insensitive name substring. */
    fromUser: z.string().min(1).optional(),
    /** Case-insensitive substring the message text must contain. */
    textContains: z.string().min(1).optional(),
  })
  .superRefine((match, ctx) => {
    const wantsMessages = match.events.some((e) => e === "message" || e.startsWith("message."));
    if (wantsMessages && (!match.channels || match.channels.length === 0)) {
      ctx.addIssue({
        code: "custom",
        path: ["channels"],
        message:
          'matching "message" events requires naming channels — watching every message everywhere is not allowed',
      });
    }
  });

export const GmailMatchSchema = z.object({
  /**
   * Required: a Gmail label (IMAP mailbox) to watch. Routes that would match
   * the whole inbox are rejected by design.
   */
  label: z.string().min(1, "gmail routes must name a label — matching everything is not allowed"),
  /** Case-insensitive substring filter on the From header. */
  fromContains: z.string().min(1).nullish(),
});

export const RouteTargetSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("thread"),
    /** Existing Codex thread id (UUID from ~/.codex/sessions). */
    threadId: z.string().min(1),
  }),
  z.object({
    type: z.literal("new-thread"),
    /** Working directory for the spawned thread. */
    cwd: z.string().min(1),
    /** Create a fresh git worktree of cwd per delivery and run the thread there. */
    worktree: z.boolean().default(false),
  }),
]);

export const SandboxPolicySchema = z.enum(["read-only", "workspace-write"]);

function matchSchemaFor(source: "github" | "gmail" | "slack") {
  switch (source) {
    case "github":
      return GithubMatchSchema;
    case "gmail":
      return GmailMatchSchema;
    default:
      return SlackMatchSchema;
  }
}

export const RouteInputSchema = z
  .object({
    name: z.string().min(1).max(100),
    source: z.enum(["github", "gmail", "slack"]),
    match: z.record(z.string(), z.unknown()),
    target: RouteTargetSchema,
    promptTemplate: z.string().max(4000).optional(),
    sandbox: SandboxPolicySchema.default("read-only"),
    /** Deliveries per minute before coalescing into a digest. Omit to use the daemon default (10). */
    rateLimitPerMinute: z.number().int().positive().max(600).optional(),
    enabled: z.boolean().default(true),
  })
  .superRefine((route, ctx) => {
    const parsed = matchSchemaFor(route.source).safeParse(route.match);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        ctx.addIssue({ code: "custom", path: ["match", ...issue.path], message: issue.message });
      }
    }
    if (route.source === "gmail" && route.sandbox !== "read-only") {
      ctx.addIssue({
        code: "custom",
        path: ["sandbox"],
        message: "gmail routes are forced to read-only sandbox",
      });
    }
  })
  .transform((route) => {
    // Persist the PARSED match so schema defaults (github events: ["push"],
    // slack events: ["app_mention"]) reach the router — storing the raw input
    // dropped them and made the router throw on default routes.
    const parsed = matchSchemaFor(route.source).safeParse(route.match);
    return {
      ...route,
      match: (parsed.success ? parsed.data : route.match) as GithubMatch | GmailMatch | SlackMatch,
    };
  });

export type GithubMatch = z.infer<typeof GithubMatchSchema>;
export type GmailMatch = z.infer<typeof GmailMatchSchema>;
export type SlackMatch = z.infer<typeof SlackMatchSchema>;
export type RouteTarget = z.infer<typeof RouteTargetSchema>;
export type SandboxPolicy = z.infer<typeof SandboxPolicySchema>;
export type RouteInput = z.infer<typeof RouteInputSchema>;

export interface Route {
  id: string;
  name: string;
  source: "github" | "gmail" | "slack";
  match: GithubMatch | GmailMatch | SlackMatch;
  target: RouteTarget;
  promptTemplate: string | null;
  sandbox: SandboxPolicy;
  /** null = use the daemon-wide default. */
  rateLimitPerMinute: number | null;
  enabled: boolean;
  createdAt: string;
}
