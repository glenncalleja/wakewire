import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyGithubSignature } from "./verify.js";

function sign(secret: string, body: string): string {
  return `sha256=${crypto.createHmac("sha256", secret).update(body).digest("hex")}`;
}

describe("verifyGithubSignature", () => {
  const secret = "shhh-webhook-secret";
  const body = JSON.stringify({ ref: "refs/heads/main", repository: { full_name: "acme/api" } });

  it("accepts a valid HMAC-SHA256 signature", async () => {
    expect(await verifyGithubSignature(secret, body, sign(secret, body))).toBe(true);
  });

  it("rejects a signature made with the wrong secret", async () => {
    expect(await verifyGithubSignature(secret, body, sign("other-secret", body))).toBe(false);
  });

  it("rejects a tampered body", async () => {
    const tampered = body.replace("main", "evil");
    expect(await verifyGithubSignature(secret, tampered, sign(secret, body))).toBe(false);
  });

  it("rejects missing or malformed signature headers", async () => {
    expect(await verifyGithubSignature(secret, body, undefined)).toBe(false);
    expect(await verifyGithubSignature(secret, body, null)).toBe(false);
    expect(await verifyGithubSignature(secret, body, "")).toBe(false);
    expect(await verifyGithubSignature(secret, body, "sha1=deadbeef")).toBe(false);
    expect(await verifyGithubSignature(secret, body, "sha256=nothex")).toBe(false);
  });
});
