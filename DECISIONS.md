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
  `bridge_route_add` output still carries a note (the override persists for
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
   `CODEX_THREAD_ID`. So `bridge_route_add` with `target: "this-thread"` returns
   instructions telling the model to run `echo "$CODEX_THREAD_ID"` and re-call
   with the explicit id; the `$bridge-setup` skill teaches this flow up front.
   This is exactly the fallback the plan asked us to verify and design for.
2. **Adapter naming/split.** The plan's `CodexAppServerAdapter (via SDK)` became
   two adapters, because the SDK does not talk to the app-server at all (it wraps
   `codex exec`): `codex-sdk` (default, per the plan's "default to SDK") and
   `codex-app-server` (raw JSON-RPC, JSONL over stdio). `codex-exec` is the third,
   plan-mandated fallback. All three implement `AgentAdapter`; selection via the
   `sink.adapter` setting.
3. **Live-refresh behavior (M1 observation).** Officially undocumented. Smoke-tested
   on 2026-07-03 against codex-cli 0.142.0 (ChatGPT auth): injecting via the daemon's
   `/api/inject` with the default SDK adapter ran the turn to completion
   (`finalResponse: "ACK-BRIDGEHEAD"`) and appended both the injected user turn and
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
9. **npm name.** `bridgehead` was unclaimed on npm as of 2026-07-03 — kept the
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
    retired) had four ideas worth adopting, merged 2026-07-03:
    deterministic source ids (`github-<owner>-<repo>`, `gmail-<user>-<label>`)
    so repeated setup upserts instead of accumulating sources — re-setup also
    reuses the existing smee channel and preserves the Gmail UID watermark;
    per-route `rateLimitPerMinute` (falling back to the daemon default of 10);
    exec-adapter prompts passed via stdin (`codex exec ... -`) to dodge argv
    length limits; and `.mcp.json` launching the MCP server with
    `npx -y bridgehead mcp` so the plugin works without a global install.
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
14. **Approvals.** Injected turns always run `approvalPolicy: "never"`; the
    app-server adapter additionally declines any unexpected server→client approval
    request. Unattended operation must never wedge on an interactive prompt — the
    sandbox, not approvals, is the safety boundary (see SECURITY.md).
