import { describe, expect, it } from "vitest";
import { RouteInputSchema } from "./route.js";

describe("RouteInputSchema", () => {
  it("accepts a valid github route and applies defaults", () => {
    const route = RouteInputSchema.parse({
      name: "ci watch",
      source: "github",
      match: { repo: "acme/api" },
      target: { type: "thread", threadId: "t-1" },
    });
    expect(route.sandbox).toBe("read-only");
    expect(route.enabled).toBe(true);
  });

  it("persists match defaults into the parsed route (regression: default routes lost events)", () => {
    // github: events defaults to ["push"]
    const github = RouteInputSchema.parse({
      name: "gh",
      source: "github",
      match: { repo: "acme/api" },
      target: { type: "thread", threadId: "t-1" },
    });
    expect(github.match).toEqual({ repo: "acme/api", events: ["push"] });

    // slack: events defaults to ["app_mention"]
    const slack = RouteInputSchema.parse({
      name: "mentions",
      source: "slack",
      match: {},
      target: { type: "thread", threadId: "t-1" },
    });
    expect(slack.match).toEqual({ events: ["app_mention"] });
  });

  it("rejects malformed repo matchers", () => {
    const result = RouteInputSchema.safeParse({
      name: "bad",
      source: "github",
      match: { repo: "not-a-repo" },
      target: { type: "thread", threadId: "t-1" },
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain("owner/repo");
  });

  it("rejects gmail routes without a label (no match-everything routes)", () => {
    const result = RouteInputSchema.safeParse({
      name: "all mail",
      source: "gmail",
      match: {},
      target: { type: "thread", threadId: "t-1" },
    });
    expect(result.success).toBe(false);
    const empty = RouteInputSchema.safeParse({
      name: "all mail",
      source: "gmail",
      match: { label: "" },
      target: { type: "thread", threadId: "t-1" },
    });
    expect(empty.success).toBe(false);
    expect(JSON.stringify(empty.error?.issues)).toContain("label");
  });

  it("forces gmail routes to a read-only sandbox", () => {
    const result = RouteInputSchema.safeParse({
      name: "mail",
      source: "gmail",
      match: { label: "agent-inbox" },
      target: { type: "thread", threadId: "t-1" },
      sandbox: "workspace-write",
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain("read-only");
  });

  it("allows github routes to opt into workspace-write", () => {
    const result = RouteInputSchema.safeParse({
      name: "ci fix",
      source: "github",
      match: { repo: "acme/api", events: ["push"], branches: ["main"] },
      target: { type: "new-thread", cwd: "/repos/api", worktree: true },
      sandbox: "workspace-write",
    });
    expect(result.success).toBe(true);
    expect(result.data?.target).toEqual({ type: "new-thread", cwd: "/repos/api", worktree: true });
  });

  it("slack: message routes require channels; mention-only routes do not", () => {
    const mentionOnly = RouteInputSchema.safeParse({
      name: "mentions",
      source: "slack",
      match: {},
      target: { type: "thread", threadId: "t-1" },
    });
    expect(mentionOnly.success).toBe(true); // events defaults to ["app_mention"]

    const allMessages = RouteInputSchema.safeParse({
      name: "everything",
      source: "slack",
      match: { events: ["message"] },
      target: { type: "thread", threadId: "t-1" },
    });
    expect(allMessages.success).toBe(false);
    expect(JSON.stringify(allMessages.error?.issues)).toContain("channels");

    const scoped = RouteInputSchema.safeParse({
      name: "dev messages",
      source: "slack",
      match: { channels: ["#dev"], events: ["message"] },
      target: { type: "thread", threadId: "t-1" },
      sandbox: "workspace-write",
    });
    expect(scoped.success).toBe(true); // slack may opt into workspace-write, like github
  });

  it("webhook routes require a provider and validate where conditions", () => {
    expect(
      RouteInputSchema.safeParse({
        name: "w",
        source: "webhook",
        match: {},
        target: { type: "thread", threadId: "t-1" },
      }).success,
    ).toBe(false);
    expect(
      RouteInputSchema.safeParse({
        name: "w",
        source: "webhook",
        match: { provider: "sentry", where: [{ field: "level" }] },
        target: { type: "thread", threadId: "t-1" },
      }).success,
    ).toBe(false); // condition needs equals or contains
    const ok = RouteInputSchema.safeParse({
      name: "w",
      source: "webhook",
      match: { provider: "sentry", where: [{ field: "level", equals: "error" }] },
      target: { type: "thread", threadId: "t-1" },
    });
    expect(ok.success).toBe(true);
  });

  it("rejects unknown target types and missing thread ids", () => {
    expect(
      RouteInputSchema.safeParse({
        name: "x",
        source: "github",
        match: { repo: "a/b" },
        target: { type: "thread" },
      }).success,
    ).toBe(false);
    expect(
      RouteInputSchema.safeParse({
        name: "x",
        source: "github",
        match: { repo: "a/b" },
        target: { type: "triage-inbox" },
      }).success,
    ).toBe(false);
  });
});
