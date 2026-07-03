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

export const RouteInputSchema = z
  .object({
    name: z.string().min(1).max(100),
    source: z.enum(["github", "gmail"]),
    match: z.record(z.string(), z.unknown()),
    target: RouteTargetSchema,
    promptTemplate: z.string().max(4000).optional(),
    sandbox: SandboxPolicySchema.default("read-only"),
    /** Deliveries per minute before coalescing into a digest. Omit to use the daemon default (10). */
    rateLimitPerMinute: z.number().int().positive().max(600).optional(),
    enabled: z.boolean().default(true),
  })
  .superRefine((route, ctx) => {
    const matchSchema = route.source === "github" ? GithubMatchSchema : GmailMatchSchema;
    const parsed = matchSchema.safeParse(route.match);
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
  });

export type GithubMatch = z.infer<typeof GithubMatchSchema>;
export type GmailMatch = z.infer<typeof GmailMatchSchema>;
export type RouteTarget = z.infer<typeof RouteTargetSchema>;
export type SandboxPolicy = z.infer<typeof SandboxPolicySchema>;
export type RouteInput = z.infer<typeof RouteInputSchema>;

export interface Route {
  id: string;
  name: string;
  source: "github" | "gmail";
  match: GithubMatch | GmailMatch;
  target: RouteTarget;
  promptTemplate: string | null;
  sandbox: SandboxPolicy;
  /** null = use the daemon-wide default. */
  rateLimitPerMinute: number | null;
  enabled: boolean;
  createdAt: string;
}
