# Getting started

Step-by-step setup for each source, with prompts you can paste straight into a
Codex conversation. Everything conversational goes through the WakeWire plugin's
`wakewire_*` tools; everything secret goes through terminal commands with hidden
prompts, so credentials never transit a model conversation.

## 0. Install (once, ~3 minutes)

```bash
npm install -g wakewire
wakewire init
wakewire start --detach        # or: wakewire service install  (starts at login)
wakewire status                # expect adapter.codexReachable: true
```

Install the Codex plugin:

```bash
codex plugin marketplace add https://github.com/glenncalleja/wakewire   # or a local checkout path
```

then in a `codex` CLI session run `/plugins`, install **WakeWire**, and restart.
(Desktop app: the Plugins screen in settings.)

**Quick sanity check** — paste into any Codex conversation:

> Call wakewire_status and tell me if the daemon is healthy and Codex is reachable.

## 1. Pick where events should land

Routes target a Codex thread. Open the thread you want (a dedicated "triage"
thread works well — every event appends a turn), and note: MCP tools can't see
which thread they're called from, but shell commands can. The prompts below
handle this for you via `echo "$CODEX_THREAD_ID"`.

## 2. GitHub

Paste into the target thread:

> Use $wakewire-setup. Watch pushes to OWNER/REPO on main and deliver them into
> this thread. Create the GitHub source with wakewire_source_setup_github, relay
> the webhook URL and secret to me so I can add them