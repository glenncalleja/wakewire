import { describe, expect, it } from "vitest";
import { trimGithubEvent } from "./trim.js";

describe("trimGithubEvent — push", () => {
  const payload = {
    ref: "refs/heads/main",
    compare: "https://github.com/acme/api/compare/aaa...bbb",
    repository: { full_name: "acme/api", private: true, description: "SECRET DESCRIPTION" },
    pusher: { name: "glenn", email: "glenn@example.com" },
    commits: [
      {
        id: "abc123",
        message: "fix: a bug",
        author: { name: "glenn", email: "g@x" },
        added: ["a.ts"],
        removed: [],
        modified: ["b.ts", "c.ts"],
      },
      {
        id: "def456",
        message: "m".repeat(1000),
        author: { name: "sam" },
        added: [],
        removed: ["gone.ts"],
        modified: [],
      },
    ],
  };

  it("keeps only the whitelisted push fields", () => {
    const event = trimGithubEvent({ eventName: "push", deliveryId: "d-1", payload });
    expect(event).not.toBeNull();
    expect(event?.kind).toBe("push");
    expect(event?.deliveryId).toBe("d-1");
    expect(event?.payload).toMatchObject({
      repo: "acme/api",
      branch: "main",
      pusher: "glenn",
      compareUrl: "https://github.com/acme/api/compare/aaa...bbb",
      commitCount: 2,
    });
    expect(JSON.stringify(event?.payload)).not.toContain("SECRET DESCRIPTION");
    expect(JSON.stringify(event?.payload)).not.toContain("glenn@example.com");
  });

  it("truncates commit messages at 500 chars and counts changed files", () => {
    const event = trimGithubEvent({ eventName: "push", deliveryId: "d-1", payload });
    const commits = event?.payload.commits as Array<Record<string, unknown>>;
    expect(commits[0]).toEqual({
      sha: "abc123",
      author: "glenn",
      message: "fix: a bug",
      filesChanged: 3,
    });
    expect((commits[1]?.message as string).length).toBeLessThanOrEqual(
      500 + "… [truncated]".length,
    );
    expect(commits[1]?.message as string).toContain("[truncated]");
    expect(commits[1]?.filesChanged).toBe(1);
  });

  it("caps commits at 20 and records the truncation", () => {
    const many = {
      ...payload,
      commits: Array.from({ length: 30 }, (_, i) => ({
        id: `c${i}`,
        message: "x",
        author: { name: "a" },
      })),
    };
    const event = trimGithubEvent({ eventName: "push", deliveryId: "d-2", payload: many });
    expect((event?.payload.commits as unknown[]).length).toBe(20);
    expect(event?.payload.commitCount).toBe(30);
    expect(event?.payload.commitsTruncatedTo).toBe(20);
    expect(event?.summary).toBe("30 commits pushed to acme/api:main by glenn");
  });
});

describe("trimGithubEvent — pull_request / issues / fallback", () => {
  it("trims pull_request events with the action in the kind", () => {
    const event = trimGithubEvent({
      eventName: "pull_request",
      deliveryId: "d-3",
      payload: {
        action: "opened",
        number: 42,
        repository: { full_name: "acme/api" },
        pull_request: {
          title: "Add feature",
          body: "please review",
          html_url: "https://github.com/acme/api/pull/42",
          user: { login: "glenn" },
          head: { ref: "feat/x" },
          base: { ref: "main" },
        },
      },
    });
    expect(event?.kind).toBe("pull_request.opened");
    expect(event?.summary).toBe("PR #42 opened on acme/api: Add feature");
    expect(event?.payload).toMatchObject({
      number: 42,
      author: "glenn",
      branch: "feat/x",
      baseBranch: "main",
    });
  });

  it("trims issues events", () => {
    const event = trimGithubEvent({
      eventName: "issues",
      deliveryId: "d-4",
      payload: {
        action: "closed",
        repository: { full_name: "acme/api" },
        issue: { number: 7, title: "Bug", user: { login: "sam" }, html_url: "u", body: "b" },
      },
    });
    expect(event?.kind).toBe("issues.closed");
    expect(event?.summary).toContain("Issue #7 closed");
  });

  it("falls back to a minimal payload for other events", () => {
    const event = trimGithubEvent({
      eventName: "watch",
      deliveryId: "d-5",
      payload: { action: "started", repository: { full_name: "acme/api" }, sender: { login: "x" } },
    });
    expect(event?.kind).toBe("watch.started");
    expect(event?.payload).toEqual({ repo: "acme/api", action: "started" });
  });

  it("returns null for events without a repository", () => {
    expect(trimGithubEvent({ eventName: "meta", deliveryId: "d", payload: {} })).toBeNull();
  });

  it("tolerates missing fields with safe fallbacks", () => {
    const push = trimGithubEvent({
      eventName: "push",
      deliveryId: "d-6",
      payload: { repository: { full_name: "acme/api" }, commits: [{}, "garbage"] },
    });
    expect(push?.payload).toMatchObject({
      repo: "acme/api",
      branch: "",
      pusher: "unknown",
      commitCount: 2,
    });
    expect((push?.payload.commits as unknown[])[1]).toEqual({});
    expect((push?.payload.commits as Array<Record<string, unknown>>)[0]).toEqual({
      sha: "",
      author: "unknown",
      message: "",
      filesChanged: 0,
    });

    const pr = trimGithubEvent({
      eventName: "pull_request",
      deliveryId: "d-7",
      payload: { repository: { full_name: "acme/api" }, pull_request: {} },
    });
    expect(pr?.kind).toBe("pull_request");
    expect(pr?.summary).toContain("PR #?");
    expect(pr?.payload).toMatchObject({ number: null, author: "unknown", title: "" });

    const issue = trimGithubEvent({
      eventName: "issues",
      deliveryId: "d-8",
      payload: { repository: { full_name: "acme/api" } },
    });
    expect(issue?.payload).toMatchObject({ number: null, author: "unknown" });

    const tag = trimGithubEvent({
      eventName: "push",
      deliveryId: "d-9",
      payload: { repository: { full_name: "acme/api" }, ref: "refs/tags/v1.0.0" },
    });
    expect(tag?.payload.branch).toBe("v1.0.0");
  });
});
