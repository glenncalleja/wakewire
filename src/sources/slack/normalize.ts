import type { BridgeEvent } from "../../core/event.js";

const TEXT_LIMIT = 4_000;

export interface SlackNames {
  channelName?: string | undefined;
  userName?: string | undefined;
}

/**
 * Reduce a Slack Events API inner event to the fields routes and prompts
 * need. Like every source: nothing outside this trimmed shape reaches the
 * model, and message text is capped.
 */
export function slackToBridgeEvent(args: {
  event: Record<string, unknown>;
  eventId: string;
  teamId: string | undefined;
  names: SlackNames;
}): BridgeEvent | null {
  const { event, eventId, teamId, names } = args;
  const type = str(event.type);
  if (!type) return null;
  const subtype = str(event.subtype);
  const kind = subtype ? `${type}.${subtype}` : type;
  const channel = str(event.channel) || str((event.item as Record<string, unknown>)?.channel);
  const user = str(event.user);
  const occurredAt = tsToIso(str(event.ts) || str(event.event_ts));
  const userLabel = names.userName ?? (user || "unknown");
  const channelLabel = names.channelName ?? (channel || "unknown");

  // userName/channelName are ALWAYS present (falling back to the raw ids):
  // the default prompt template interpolates them, and a missing whitelisted
  // field is a hard template error that would fail every delivery.
  const base = {
    channel,
    channelName: channelLabel,
    user,
    userName: userLabel,
    eventType: kind,
    ...(teamId ? { team: teamId } : {}),
  };

  if (type === "reaction_added" || type === "reaction_removed") {
    const reaction = str(event.reaction);
    return {
      source: "slack",
      kind,
      deliveryId: eventId,
      occurredAt,
      summary: `@${userLabel} ${type === "reaction_added" ? "reacted" : "unreacted"} :${reaction}: in #${channelLabel}`,
      payload: { ...base, reaction, itemTs: str((event.item as Record<string, unknown>)?.ts) },
    };
  }

  // message / app_mention (and message subtypes)
  const text = truncate(str(event.text), TEXT_LIMIT);
  const snippet = text.replace(/\s+/g, " ").slice(0, 80);
  return {
    source: "slack",
    kind,
    deliveryId: eventId,
    occurredAt,
    summary:
      type === "app_mention"
        ? `@${userLabel} mentioned the bot in #${channelLabel}: ${snippet}`
        : `Slack ${kind} from @${userLabel} in #${channelLabel}${snippet ? `: ${snippet}` : ""}`,
    payload: {
      ...base,
      text,
      ts: str(event.ts),
      ...(str(event.thread_ts) ? { threadTs: str(event.thread_ts) } : {}),
    },
  };
}

/** Bot chatter is skipped by default so integrations can't flood routes. */
export function isBotEvent(event: Record<string, unknown>): boolean {
  return Boolean(event.bot_id) || str(event.subtype) === "bot_message";
}

function tsToIso(ts: string): string {
  const seconds = Number.parseFloat(ts);
  if (!Number.isFinite(seconds) || seconds <= 0) return new Date().toISOString();
  return new Date(seconds * 1000).toISOString();
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}… [truncated]`;
}
