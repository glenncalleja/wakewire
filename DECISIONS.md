# Decisions & doc-verification notes

Per the build plan: current docs win over the plan; deviations are recorded here.
API surfaces were verified on **2026-07-03** against **codex-cli 0.142.0** installed
locally (including `codex app-server generate-ts` output from that binary) and the
live pages at developers.openai.com (app-server, sdk, noninteractive, plugins,
skills, mcp, config-reference).

## Codex protocol facts we build on

- **app-server v2** (from generated bindings + README): newline-delimited JSON-RPC
  with the `jsonrpc` field omitted; handshake is `initialize` → `initialized`
  notification. Methods used: `thread/start`, `thread/resume`, `turn/start`.
  `ThreadStatus` (`idle` vs `active`) is how we detect a turn in flight.
- **Per-turn sandbox exists.** The plan worried sandbox might be thread-level only.
  `turn/start` takes a full `sandboxPolicy` object per turn (`readOnly` /
  `workspaceWrite{writableRoots,networkAccess,...}` / `dangerFullAccess`), and
  `thread/start`/`thread/resume` take a `sandbox` *mode* string. The SDK exposes
  sandbox on `ThreadOptions` only, but since it re-applies options to every spawned
  `codex exec` run, our per-delivery resume gives per-delivery sandbox in practice.
  `wakewire_route_add` output still carries a note (the override persists for
  subsequent turns on that thread until changed).
- **The SDK shells out.** `@openai/codex-sdk` (0.142.5) spawns its vendored codex
  binary as `codex exec --experimental-json ... resume <id>` per `run()`. Threads
  persist in `~/.codex/sessions`, shared with the CLI and desktop app — that shared
  store is the documented basis for resume-and-append interop.
- **`codex exec resume <SESSION_ID> "<prompt>"`** with `--json`,
  `--output-last-message`, `--sandbox`, `--skip-git-repo-check` verified against
  the local CLI's help output.
- **Plugins**: manifest at `.codex-plugin/plugin.json`; MCP servers via `.mcp.json`
  (stdio `command`/`args`); skills at `skills/<name>/SKILL.md` with `name`/
  `description` frontmatter. Distribution is via marketplaces
  (`codex plugin marketplace add <repo|path>` + `/plugins`), not
  `codex plugin install` — the plan's assumption of direct install was adjusted;
  we ship `.agents/plugins/marketplace.json` so the repo doubles as a marketplace.

## Deviations from the plan

1. **MCP tools cannot see the current thread id.** Confirmed: no session metadata
   reaches MCP servers, and upstream request openai/codex#19937 was closed
   not-planned. But shell commands run inside a conversation DO get
   `CODEX_THREAD_ID`. So `wakewire_route_add` with `target: "this-thread"` returns
   instructions telling the model to run `echo "$CODEX_THREAD_ID"` and re-call
   with the explicit id; the `$wakewire-setup` skill teaches this flow up front.
   This is exactly the fallback the plan asked us to verify and design for.
2. **Adapter naming/split.** The plan's `CodexAppServerAdapter (via SDK)` became
   two adapters, because the SDK does not talk to the app-server at all (it wraps
   `codex exec`): `codex-sdk` (default, per the plan's "default to SDK") and
   `codex-app-server` (raw JSON-RPC, JSONL over stdio). `codex-exec` is the third,
   plan-mandated fallback. All three implement `AgentAdapter`; selection via the
   `sink.adapter` setting.
3a. **codex-app-server adapter, completion-blocking (2026-07-04).** Originally
   returned on turn-accept (fire-and-forget); now it registers a completion
   waiter keyed by threadId, sends `turn/start`, and awaits the `turn/completed`
   notification before returning — matching the SDK/exec adapters so the queue's
   per-thread FIFO stays clean, while keeping the BusyError guard the others
   lack. `finalResponse` is accumulated from `item/completed` agentMessage events
   (the `turn/completed` payload usually carries only a "summary" items view).
   Connection death rejects in-flight waiters (UnreachableError → queue retries).
   Live-verified on codex-cli 0.142.0 (spawn mode): block-to-completion,
   finalResponse extraction, and BusyError-on-concurrent-turn all confirmed.
   Proxy mode dead-end + shared-ws mode (2026-07-04): the desktop app runs its
   own embedded `app-server --listen stdio://`, so no external process can
   attach to it (live in-app refresh is impossible until OpenAI rewires the app
   to the managed daemon; `codex app-server daemon` also requires their
   standalone installer). Cross-process busy detection is likewise limited to
   clients of the same server process. The answer is shared-ws mode
   (`sink.appServerListen = ws://127.0.0.1:PORT`): the adapter connects to — or
   spawns and owns — a shared `codex app-server --listen ws://…`, and any
   `codex --remote <url>` TUI attaches to the same server. Loopback-only is
   enforced (a ws listener has no auth on loopback; non-loopback would expose an
   unauthenticated Codex control plane). Live-verified end to end on the real
   daemon: a watcher client on the shared server received turn/started,
   agentMessage deltas, and turn/completed for a queue-replayed gmail delivery —
   live streaming AND whole-server busy detection both real in this topology.
3. **Live-refresh behavior (M1 observation).** Officially undocumented. Smoke-tested
   on 2026-07-03 against codex-cli 0.142.0 (ChatGPT auth): injecting via the daemon's
   `/api/inject` with the default SDK adapter ran the turn to completion
   (`finalResponse: "ACK-WAKEWIRE"`) and appended both the injected user turn and
   the agent reply to the *same* rollout file under `~/.codex/sessions` — the thread
   resumes with full history in `codex resume`. With the SDK adapter the turn runs in
   the daemon's spawned process and appears in the app after the thread is reloaded
   there; live in-place refresh of an open app window was not observed/verifiable in
   that test. The `codex-app-server` adapter
   attaches to the *running* app-server via `codex app-server proxy` when the
   control socket (`$CODEX_HOME/app-server-control/app-server-control.sock`)
   exists — subscribers of that server receive the turn live; whether the desktop
   app's embedded server uses that socket varies by app version, so we auto-detect
   and fall back to spawning a private app-server. Cross-client attachment beyond
   this relies on unsupported behavior (openai/codex#24398 closed not-planned), so
   we stay on documented methods and the shared session store.
4. **keytar is dead** (archived with Atom, last publish 2022). Replaced with
   `@napi-rs/keyring` (maintained, prebuilt binaries), same keychain semantics,
   with the plan's 0600-JSON-file fallback and loud warning.
5. **pnpm → npm.** This machine's Node 25 has no corepack and no pnpm; the repo
   uses npm + `package-lock.json`. Nothing in the package requires pnpm.
6. **Extra delivery statuses.** Added `delivering` (claimed by the in-process
   sender; reset to `queued` on boot for crash-only recovery) and `coalesced`
   (folded into a rate-limit digest, with `coalescedInto` pointing at the carrier)
   beyond the plan's list.
7. **Smee + HMAC caveat.** smee relays the *parsed* JSON body, so we verify the
   signature against `JSON.stringify(body)`. GitHub sends compact JSON, so this
   reproduces the signed bytes in practice; if GitHub ever changes serialization,
   verification fails closed (delivery rejected, `rejected` counter increments) and
   listen mode is the escape hatch.
8. **Gmail watermark.** First connection starts at the current end of the mailbox
   (no history replay); `uidValidity` changes reset the watermark forward. Message
   dedup rides on Message-ID (falling back to a uidValidity+uid synthetic id).
9. **npm name.** `wakewire` was unclaimed on npm as of 2026-07-03 — kept the
   working name.
10. **commander@14, not 15** — v15 requires Node ≥22.12; the plan's floor is
    Node ≥20. zod v4, TypeScript 5.9, Biome 2.x, vitest 4.
11. **Digest semantics.** When a route exceeds its per-minute budget and several
    deliveries are waiting on the same thread, the newest becomes the digest
    carrier ("N events coalesced… latest payload"), the rest are marked
    `coalesced`. A single over-budget delivery is not delayed — coalescing only
    kicks in when there's actually a burst to merge.
12. **Ported from the parallel implementation.** A second independent
    implementation of the same plan (previously at `tools/bridgehead`, since
    retired (archived)) had four ideas worth adopting, merged 2026-07-03:
    deterministic source ids (`github-<owner>-<repo>`, `gmail-<user>-<label>`)
    so repeated setup upserts instead of accumulating sources — re-setup also
    reuses the existing smee channel and preserves the Gmail UID watermark;
    per-route `rateLimitPerMinute` (falling back to the daemon default of 10);
    exec-adapter prompts passed via stdin (`codex exec ... -`) to dodge argv
    length limits; and `.mcp.json` launching the MCP server with
    `npx -y wakewire mcp` so the plugin works without a global install.
13. **Slack via Socket Mode (added 2026-07-03).** `@slack/socket-mode` 2.x +
    `@slack/web-api`: an outbound WebSocket authenticated by an app-level token,
    so — like the smee relay — no public endpoint. Deliverable envelopes are
    acked only after the event is synchronously enqueued to SQLite ("ack =
    durably queued"); anything that fails before that stays un-acked, Slack
    redelivers with the same `event_id`, and dedup collapses the retry. Events
    we deliberately skip (bot chatter, non-events envelopes) are acked
    immediately. Name resolution runs inside the ack window — cached, and an
    occasional blown ~3s deadline just causes a deduped redelivery. The
    bot token is only used to resolve channel/user names (cached, best-effort;
    unresolved names fall back to raw ids so templates always render).
    Guardrails: `message` routes must name channels, mention-only routes may
    span the bot's channels, bot-authored messages are skipped by default, and
    slack routes get github-like sandbox rules (default read-only, opt-in
    write) — see SECURITY.md for the reasoning. Migration 3 rebuilds the routes
    and sources tables to drop the `kind` CHECK constraints: extensible enums
    belong in zod at the boundary, not baked into SQLite DDL.
14. **Generic webhook source (added 2026-07-03).** Provider-specific code
    collapsed into two declarative pieces: a verification preset (hmac-sha256
    over the raw body with configurable header/prefix/encoding, or a
    shared-secret header — no unsigned mode) and a field mapping (dot-paths
    only, no expression language) that doubles as the payload trim whitelist.
    Capture mode stores the first N raw payloads (capped, pruned to 10/source)
    so the model can author mappings from real events via
    `wakewire_source_captures`. Source-level summary templates render leniently
    (unmapped → "") unlike strict route templates — a mapping typo must not
    make events undeliverable. Missing id path → body-hash delivery id, which
    also blunts HMAC replay. ClickUp/Linear/Sentry ship as recipes/ rather
    than dedicated adapters; bespoke Source implementations stay reserved for
    non-webhook transports (IMAP, Socket Mode).
15. **Approvals.** Injected turns always run `approvalPolicy: "never"`; the
    app-server adapter additionally declines any unexpected server→client approval
    request. Unattended operation must never wedge on an interactive prompt — the
    sandbox, not approvals, is the safety boundary (see SECURITY.md).

16. **Renamed bridgehead → WakeWire (2026-07-04).** The original working name
    collided with the BridgeMind ecosystem (BridgeCode, BridgeMCP, BridgeSpace…),
    which occupies the agentic/vibe-coding space this tool lives in — a
    Bridge-prefixed Codex tool would read as part of that family. Descriptive
    alternatives converged on strip-mined prefixes (agent*, thread* — AgentWire
    at agentwire.run is a near-identical competing product; AgentRelay is
    quadruple-taken). "wakewire" names the anti-polling idea itself (events WAKE
    the agent; the wire delivers them), was free on npm and clean in the product
    space (nearest neighbors: Wake-on-LAN relays — friendly heritage, not
    collision). Home dir moved to ~/.wakewire, keychain service renamed
    (entries migrated), env vars WAKEWIRE_*, MCP tools wakewire_*, skills
    $wakewire-setup / $wakewire-inspect. No back-compat shims: pre-publish.

## Deliberately deferred

### Write-capable email routes (deferred 2026-07-04)

Gmail routes are forced `read-only`. This deliberately blocks a legitimate use
case — email as a personal command channel ("mail myself 'redeploy staging' and
have Codex act on it"). We accept that cost for now, and here is the reasoning so
it is not re-litigated:

**Why not just allow it (or gate it on a `From` match).** Prompt-injection risk
is really about *unauthenticated content*. Slack authenticates the sender (the
workspace vouches for the user id) and GitHub/webhook payloads are HMAC-signed —
so opting those into `workspace-write` is an informed choice backed by a real
authenticity signal. Plain email authenticates nothing about the sender at the
layer wakewire operates: the `From` header is forgeable, so a route scoped
`fromContains: me@x` means "emails that *claim* to be from me," which an attacker
can satisfy — and if a Gmail filter labels on `from:me`, the spoofed mail gets
routed too. So a write-capable email route gated on `From` is the
dangerous-but-looks-safe shape: the user would reasonably believe it is scoped to
them when it is not. Read-only email from any sender remains fine (an injected
email can at worst mislead a summary).

**Why not a secret in the subject/body.** A subject line is the least private part
of an email (notifications, lock screens, previews, logs); the body is only
marginally better (cleartext on the mail server, quoted into replies, forwarded,
indexed, captured to disk here). A bearer secret anywhere in an email leaks into
many persistent places — a weak design.

**How we would enable it, when revisited.** Authenticate the sender instead of
carrying a secret: Gmail runs DKIM/DMARC and stamps `Authentication-Results` on
delivery, and since we read straight from Gmail's IMAP we can trust that header —
verifying "really came from this domain, not forged" with no shared secret to
leak. Then write-capable email becomes a legitimate, informed opt-in on the same
footing as Slack/GitHub. Alternatively, keep email read-only for triage and route
*actions* through channels that authenticate their sender by construction (a Slack
DM to the bot, a signed webhook from a Shortcut) — use the right medium for the
trust level.

Related hardening still open (see the security-review round): make sandbox
network-off explicit and identical across all three adapters (today only the
app-server adapter forces `networkAccess: false` for `workspace-write`; the SDK
and exec adapters inherit Codex's default), and warn at route-creation time when a
route pairs an untrusted-content source with `workspace-write`.
