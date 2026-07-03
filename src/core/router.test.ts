import { describe, expect, it } from "vitest";
import type { BridgeEvent } from "./event.js";
import type { Route } from "./route.js";
import { matchRoutes } from "./router.js";

function route(overrides: Partial<Route>): Route {
  return {
    id: "r-1",
    name: "test",
    source: "github",
    match: { repo: "acme/api", events: ["push"] },
    target: { type: "thread", threadId: "t-1" },
    promptTemplate: null,
    sandbox: "read-only",
    rateLimitPerMinute: null,
    enabled: true,
    createdAt: "2026-07-03T00:00:00.000Z",
    ...overrides,
  };
}

function githubEvent(
  overrides: Partial<BridgeEvent> & { payload?: Record<string, unknown> },
): BridgeEvent {
  return {
    source: "github",
    kind: "push",
    deliveryId: "d-1",
    occurredAt: "2026-07-03T10:00:00.000Z",
    summary: "s",
    payload: { repo: "acme/api", branch: "main" },
    ...overrides,
  };
}

describe("matchRoutes — github", () => {
  it("matches repo case-insensitively and filters disabled routes", () => {
    const routes = [route({}), route({ id: "r-2", enabled: false })];
    const matched = matchRoutes(
      routes,
      githubEvent({ payload: { repo: "Acme/API", branch: "main" } }),
    );
    expect(matched.map((r) => r.id)).toEqual(["r-1"]);
  });

  it("rejects other repos and other sources", () => {
    expect(matchRoutes([route({})], githubEvent({ payload: { repo: "other/repo" } }))).toHaveLength(
      0,
    );
    const gmailEvent: BridgeEvent = {
      source: "gmail",
      kind: "email",
      deliveryId: "d",
      occurredAt: "t",
      summary: "s",
      payload: { label: "x", from: "a@b" },
    };
    expect(matchRoutes([route({})], gmailEvent)).toHaveLength(0);
  });

  it("matches event kinds by exact name or action prefix", () => {
    const prRoute = route({ match: { repo: "acme/api", events: ["pull_request"] } });
    expect(matchRoutes([prRoute], githubEvent({ kind: "pull_request.opened" }))).toHaveLength(1);
    expect(
      matchRoutes([prRoute], githubEvent({ kind: "pull_request_review.submitted" })),
    ).toHaveLength(0);

    const exact = route({ match: { repo: "acme/api", events: ["pull_request.closed"] } });
    expect(matchRoutes([exact], githubEvent({ kind: "pull_request.opened" }))).toHaveLength(0);
    expect(matchRoutes([exact], githubEvent({ kind: "pull_request.closed" }))).toHaveLength(1);
  });

  it("applies branch filters to pushes only", () => {
    const branchRoute = route({
      match: { repo: "acme/api", events: ["push", "issues"], branches: ["main"] },
    });
    expect(
      matchRoutes([branchRoute], githubEvent({ payload: { repo: "acme/api", branch: "dev" } })),
    ).toHaveLength(0);
    expect(
      matchRoutes([branchRoute], githubEvent({ payload: { repo: "acme/api", branch: "main" } })),
    ).toHaveLength(1);
    // non-push events pass through the branch filter
    expect(
      matchRoutes(
        [branchRoute],
        githubEvent({ kind: "issues.opened", payload: { repo: "acme/api" } }),
      ),
    ).toHaveLength(1);
  });
});

describe("matchRoutes — gmail", () => {
  const gmailRoute = route({
    id: "g-1",
    source: "gmail",
    match: { label: "agent-inbox", fromContains: "boss@" },
  });

  function email(payload: Record<string, unknown>): BridgeEvent {
    return {
      source: "gmail",
      kind: "email",
      deliveryId: "<m@x>",
      occurredAt: "t",
      summary: "s",
      payload,
    };
  }

  it("requires the label to match (case-insensitive)", () => {
    expect(
      matchRoutes([gmailRoute], email({ label: "Agent-Inbox", from: "boss@corp.com" })),
    ).toHaveLength(1);
    expect(
      matchRoutes([gmailRoute], email({ label: "other", from: "boss@corp.com" })),
    ).toHaveLength(0);
  });

  it("applies fromContains as a case-insensitive substring", () => {
    expect(
      matchRoutes([gmailRoute], email({ label: "agent-inbox", from: "BOSS@corp.com" })),
    ).toHaveLength(1);
    expect(
      matchRoutes([gmailRoute], email({ label: "agent-inbox", from: "peer@corp.com" })),
    ).toHaveLength(0);
  });
});
