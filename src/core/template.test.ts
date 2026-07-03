import { describe, expect, it } from "vitest";
import type { BridgeEvent } from "./event.js";
import { DEFAULT_TEMPLATES, renderTemplate, TemplateError, templateFields } from "./template.js";

const githubEvent: BridgeEvent = {
  source: "github",
  kind: "push",
  deliveryId: "d-1",
  occurredAt: "2026-07-03T10:00:00.000Z",
  summary: "2 commits pushed to acme/api:main by glenn",
  payload: {
    repo: "acme/api",
    branch: "main",
    pusher: "glenn",
    compareUrl: "https://github.com/acme/api/compare/a...b",
    commitCount: 2,
    commits: [{ sha: "a", author: "glenn", message: "ignore me — I'm payload", filesChanged: 3 }],
  },
};

describe("templateFields", () => {
  it("exposes common fields and whitelisted source fields", () => {
    const fields = templateFields("my route", githubEvent);
    expect(fields.routeName).toBe("my route");
    expect(fields.kind).toBe("push");
    expect(fields.summary).toContain("2 commits");
    expect(fields.repo).toBe("acme/api");
    expect(fields.branch).toBe("main");
    expect(fields.commitCount).toBe("2");
  });

  it("never exposes non-whitelisted payload content (e.g. commit messages)", () => {
    const fields = templateFields("r", githubEvent);
    expect(Object.values(fields).join(" ")).not.toContain("ignore me");
    expect(fields).not.toHaveProperty("commits");
  });

  it("skips whitelisted fields with non-scalar values", () => {
    const event: BridgeEvent = { ...githubEvent, payload: { repo: { evil: true } } };
    const fields = templateFields("r", event);
    expect(fields).not.toHaveProperty("repo");
  });
});

describe("renderTemplate", () => {
  it("interpolates known fields", () => {
    const out = renderTemplate(
      "{{routeName}}: {{kind}} on {{repo}}:{{branch}} ({{ commitCount }} commits)",
      templateFields("ci", githubEvent),
    );
    expect(out).toBe("ci: push on acme/api:main (2 commits)");
  });

  it("throws TemplateError for unknown fields, listing what is allowed", () => {
    expect(() => renderTemplate("{{commits}}", templateFields("r", githubEvent))).toThrow(
      TemplateError,
    );
    expect(() => renderTemplate("{{brnach}}", templateFields("r", githubEvent))).toThrow(
      /allowed fields/,
    );
  });

  it("leaves non-template braces alone", () => {
    const out = renderTemplate("keep {this} and { that }", templateFields("r", githubEvent));
    expect(out).toBe("keep {this} and { that }");
  });

  it("default templates render for both sources", () => {
    expect(() =>
      renderTemplate(DEFAULT_TEMPLATES.github, templateFields("r", githubEvent)),
    ).not.toThrow();
    const gmailEvent: BridgeEvent = {
      source: "gmail",
      kind: "email",
      deliveryId: "<m@x>",
      occurredAt: "2026-07-03T10:00:00.000Z",
      summary: "Email from a@b: hi",
      payload: { label: "agent-inbox", from: "a@b", to: "me@x", subject: "hi", date: "2026-07-03" },
    };
    expect(() =>
      renderTemplate(DEFAULT_TEMPLATES.gmail, templateFields("r", gmailEvent)),
    ).not.toThrow();
  });
});
