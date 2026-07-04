import { simpleParser } from "mailparser";
import { describe, expect, it } from "vitest";
import { emailToWakeEvent, extractBody } from "./extract.js";

describe("extractBody", () => {
  it("prefers plain text when present", () => {
    expect(extractBody({ text: "hello plain", html: "<b>hello html</b>" })).toBe("hello plain");
  });

  it("converts HTML with a real parser (no tags in output)", () => {
    const body = extractBody({
      text: "",
      html: '<html><body><p>Hi <b>there</b></p><a href="https://x.test/a">click</a><img src="x.png"></body></html>',
    });
    expect(body).toContain("Hi there");
    expect(body).toContain("https://x.test/a");
    expect(body).not.toMatch(/<[a-z]+[ >]/i);
  });

  it("truncates the body at 4000 chars", () => {
    const body = extractBody({ text: "x".repeat(10_000), html: false });
    expect(body.length).toBeLessThanOrEqual(4_000 + "… [truncated]".length);
    expect(body).toContain("[truncated]");
  });
});

describe("emailToWakeEvent", () => {
  it("builds a trimmed event from a parsed message", async () => {
    const raw = [
      "Message-ID: <msg-1@example.com>",
      "From: Boss <boss@corp.example>",
      "To: me@corp.example",
      "Subject: Deploy tonight",
      "Date: Fri, 03 Jul 2026 10:00:00 +0000",
      "Content-Type: text/plain",
      "",
      "Please deploy after 6pm.",
    ].join("\r\n");
    const mail = await simpleParser(raw);
    const event = emailToWakeEvent({ mail, label: "agent-inbox", fallbackId: "fb-1" });
    expect(event.source).toBe("gmail");
    expect(event.kind).toBe("email");
    expect(event.deliveryId).toBe("<msg-1@example.com>");
    expect(event.summary).toBe('Email from "Boss" <boss@corp.example>: Deploy tonight');
    expect(event.payload).toMatchObject({
      label: "agent-inbox",
      from: '"Boss" <boss@corp.example>',
      to: "me@corp.example",
      subject: "Deploy tonight",
      body: "Please deploy after 6pm.",
    });
  });

  it("falls back to the synthetic id when Message-ID is missing", async () => {
    const mail = await simpleParser("Subject: no id\r\n\r\nbody");
    const event = emailToWakeEvent({ mail, label: "l", fallbackId: "imap-src-5-42" });
    expect(event.deliveryId).toBe("imap-src-5-42");
    expect(event.payload.subject).toBe("no id");
  });
});
