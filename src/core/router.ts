import type { BridgeEvent } from "./event.js";
import type { GithubMatch, GmailMatch, Route, SlackMatch, WebhookMatch } from "./route.js";

/** Returns the enabled routes whose match rules accept this event. */
export function matchRoutes(routes: Route[], event: BridgeEvent): Route[] {
  return routes.filter(
    (route) => route.enabled && route.source === event.source && matches(route, event),
  );
}

function matches(route: Route, event: BridgeEvent): boolean {
  switch (route.source) {
    case "github":
      return matchGithub(route.match as GithubMatch, event);
    case "gmail":
      return matchGmail(route.match as GmailMatch, event);
    case "slack":
      return matchSlack(route.match as SlackMatch, event);
    case "webhook":
      return matchWebhook(route.match as WebhookMatch, event);
    default:
      return false;
  }
}

function matchWebhook(match: WebhookMatch, event: BridgeEvent): boolean {
  const provider = str(event.payload.provider);
  if (!match.provider || provider.toLowerCase() !== match.provider.toLowerCase()) return false;

  if (match.events && match.events.length > 0) {
    const kindMatches = match.events.some(
      (e) => event.kind === e || event.kind.startsWith(`${e}.`),
    );
    if (!kindMatches) return false;
  }

  for (const condition of match.where ?? []) {
    const value = str(event.payload[condition.field]).toLowerCase();
    if (condition.equals !== undefined && value !== condition.equals.toLowerCase()) return false;
    if (condition.contains !== undefined && !value.includes(condition.contains.toLowerCase()))
      return false;
  }
  return true;
}

function matchSlack(match: SlackMatch, event: BridgeEvent): boolean {
  // route "message" matches kind "message.channel_topic"; exact kinds match exactly.
  // Defensive default: rows stored before match normalization may lack events.
  const events = match.events ?? ["app_mention"];
  const kindMatches = events.some((e) => event.kind === e || event.kind.startsWith(`${e}.`));
  if (!kindMatches) return false;

  if (match.channels && match.channels.length > 0) {
    const channelId = str(event.payload.channel);
    const channelName = str(event.payload.channelName);
    const ok = match.channels.some((wanted) => {
      const bare = wanted.replace(/^#/, "");
      return (
        bare.localeCompare(channelId, undefined, { sensitivity: "accent" }) === 0 ||
        bare.localeCompare(channelName, undefined, { sensitivity: "accent" }) === 0
      );
    });
    if (!ok) return false;
  }

  if (match.fromUser) {
    const user = str(event.payload.user);
    const userName = str(event.payload.userName).toLowerCase();
    const wanted = match.fromUser;
    if (user !== wanted && !userName.includes(wanted.toLowerCase())) return false;
  }

  if (match.textContains) {
    const text = str(event.payload.text).toLowerCase();
    if (!text.includes(match.textContains.toLowerCase())) return false;
  }
  return true;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function matchGithub(match: GithubMatch, event: BridgeEvent): boolean {
  const repo = event.payload.repo;
  if (typeof repo !== "string" || repo.toLowerCase() !== match.repo.toLowerCase()) return false;

  // route "push" matches kind "push"; route "pull_request" matches "pull_request.opened";
  // route "pull_request.opened" matches only that action.
  // Defensive default: rows stored before match normalization may lack events.
  const events = match.events ?? ["push"];
  const kindMatches = events.some((e) => event.kind === e || event.kind.startsWith(`${e}.`));
  if (!kindMatches) return false;

  if (match.branches && match.branches.length > 0 && event.kind === "push") {
    const branch = event.payload.branch;
    if (typeof branch !== "string") return false;
    if (!match.branches.includes(branch)) return false;
  }
  return true;
}

function matchGmail(match: GmailMatch, event: BridgeEvent): boolean {
  if (event.kind !== "email") return false;
  const label = event.payload.label;
  if (typeof label !== "string" || label.toLowerCase() !== match.label.toLowerCase()) return false;
  if (match.fromContains) {
    const from = event.payload.from;
    if (typeof from !== "string") return false;
    if (!from.toLowerCase().includes(match.fromContains.toLowerCase())) return false;
  }
  return true;
}
