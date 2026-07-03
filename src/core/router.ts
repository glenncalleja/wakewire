import type { BridgeEvent } from "./event.js";
import type { GithubMatch, GmailMatch, Route } from "./route.js";

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
    default:
      return false;
  }
}

function matchGithub(match: GithubMatch, event: BridgeEvent): boolean {
  const repo = event.payload.repo;
  if (typeof repo !== "string" || repo.toLowerCase() !== match.repo.toLowerCase()) return false;

  // route "push" matches kind "push"; route "pull_request" matches "pull_request.opened";
  // route "pull_request.opened" matches only that action.
  const kindMatches = match.events.some((e) => event.kind === e || event.kind.startsWith(`${e}.`));
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
