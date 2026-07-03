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

describe("matchRoutes — slack", () => {
  function slackEvent(
    overrides: Partial<BridgeEvent> & { payload?: Record<string, unknown> },
  ): BridgeEvent {
    return {
      source: "slack",
      kind: "app_mention",
      deliveryId: "Ev1",
      occurredAt: "t",
      summary: "s",
      payload: {
        channel: "C123",
        channelName: "dev",
        user: "U1",
        userName: "glenn",
        text: "help me deploy",
      },
      ...overrides,
    };
  }

  it("matches app_mention routes across channels by default", () => {
    const r = route({ source: "slack", match: { events: ["app_mention"] } });
    expect(matchRoutes([r], slackEvent({}))).toHaveLength(1);
    expect(matchRoutes([r], slackEvent({ kind: "message" }))).toHaveLength(0);
  });

  it("tolerates stored routes whose match lacks events (pre-normalization rows)", () => {
    const legacySlack = route({ source: "slack", match: {} as never });
    expect(() => matchRoutes([legacySlack], slackEvent({}))).not.toThrow();
    expect(matchRoutes([legacySlack], slackEvent({}))).toHaveLength(1); // defaults to app_mention

    const legacyGithub = route({ match: { repo: "acme/api" } as never });
    expect(() =>
      matchRoutes([legacyGithub], githubEvent({ payload: { repo: "acme/api", branch: "main" } })),
    ).not.toThrow();
    expect(
      matchRoutes([legacyGithub], githubEvent({ payload: { repo: "acme/api", branch: "main" } })),
    ).toHaveLength(1); // defaults to push
  });

  it("matches channels by id or #name, case-insensitively", () => {
    const r = route({ source: "slack", match: { channels: ["#Dev"], events: ["message"] } });
    expect(matchRoutes([r], slackEvent({ kind: "message" }))).toHaveLength(1);
    expect(
      matchRoutes(
        [r],
        slackEvent({ kind: "message", payload: { channel: "C123", channelName: "ops" } }),
      ),
    ).toHaveLength(0);
    const byId = route({ source: "slack", match: { channels: ["C123"], events: ["message"] } });
    expect(matchRoutes([byId], slackEvent({ kind: "message" }))).toHaveLength(1);
  });

  it("matches message subtypes via the bare event name", () => {
    const r = route({ source: "slack", match: { channels: ["dev"], events: ["message"] } });
    expect(matchRoutes([r], slackEvent({ kind: "message.channel_topic" }))).toHaveLength(1);
  });

  it("applies fromUser (id or name substring) and textContains", () => {
    const r = route({
      source: "slack",
      match: { events: ["app_mention"], fromUser: "glenn", textContains: "deploy" },
    });
    expect(matchRoutes([r], slackEvent({}))).toHaveLength(1);
    expect(
      matchRoutes([r], slackEvent({ payload: { channel: "C1", userName: "sam", text: "deploy" } })),
    ).toHaveLength(0);
    expect(
      matchRoutes(
        [r],
        slackEvent({ payload: { channel: "C1", userName: "glenn", text: "lunch?" } }),
      ),
    ).toHaveLength(0);
    const byId = route({ source: "slack", match: { events: ["app_mention"], fromUser: "U1" } });
    expect(matchRoutes([byId], slackEvent({}))).toHaveLength(1);
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
