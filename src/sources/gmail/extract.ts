import { convert } from "html-to-text";
import type { ParsedMail } from "mailparser";
import type { WakeEvent } from "../../core/event.js";

const BODY_LIMIT = 4_000;

/**
 * Reduce a parsed email to the fields prompts need. Plain text is preferred;
 * HTML is converted with html-to-text (never regex-stripped). Body is
 * truncated to 4,000 chars.
 */
export function emailToWakeEvent(args: {
  mail: ParsedMail;
  label: string;
  fallbackId: string;
}): WakeEvent {
  const { mail, label, fallbackId } = args;
  const from = mail.from?.text ?? "unknown";
  const to = addressText(mail.to);
  const subject = mail.subject ?? "(no subject)";
  const date = (mail.date ?? new Date()).toISOString();
  const body = extractBody(mail);
  return {
    source: "gmail",
    kind: "email",
    deliveryId: mail.messageId ?? fallbackId,
    occurredAt: date,
    summary: `Email from ${from}: ${subject}`,
    payload: { label, from, to, subject, date, body },
  };
}

export function extractBody(mail: Pick<ParsedMail, "text" | "html">): string {
  const text =
    mail.text && mail.text.trim().length > 0
      ? mail.text
      : typeof mail.html === "string"
        ? convert(mail.html, {
            wordwrap: false,
            selectors: [
              { selector: "a", options: { ignoreHref: false } },
              { selector: "img", format: "skip" },
            ],
          })
        : "";
  return truncate(text.trim(), BODY_LIMIT);
}

function addressText(to: ParsedMail["to"]): string {
  if (!to) return "";
  if (Array.isArray(to)) return to.map((a) => a.text).join(", ");
  return to.text;
}

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}… [truncated]`;
}
