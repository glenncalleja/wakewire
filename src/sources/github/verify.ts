import { verify } from "@octokit/webhooks-methods";

/**
 * HMAC-SHA256 webhook signature check (X-Hub-Signature-256). Verified even in
 * smee relay mode — the relay is untrusted transport, the secret is the trust root.
 */
export async function verifyGithubSignature(
  secret: string,
  rawBody: string,
  signatureHeader: string | undefined | null,
): Promise<boolean> {
  if (!signatureHeader?.startsWith("sha256=")) return false;
  try {
    return await verify(secret, rawBody, signatureHeader);
  } catch {
    return false;
  }
}
