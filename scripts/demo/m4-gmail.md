# M4 demo: Gmail label → Codex thread

1. In Google Cloud Console create an OAuth client, type **Desktop app** (any project;
   the OAuth consent screen can stay in *Testing* with your address as a test user).
   You bring your own client because bridgehead is self-hosted — publishing a shared
   client with the full-mail scope would require Google's restricted-scope verification.

2. In a Codex conversation:

   > Watch emails I label agent-inbox and summarize them in this thread.

   The model calls `bridge_source_setup_gmail` with `{label: "agent-inbox", user: "you@gmail.com"}`
   and relays the instructions.

3. In a terminal: `bridgehead auth gmail` — paste the client id/secret, approve in
   the browser. The daemon starts the IMAP IDLE watch immediately.

4. Create the route (the model does this via `bridge_route_add` with
   `match: {"label": "agent-inbox"}`). Note: gmail routes are forced read-only, and
   a route without a label is rejected.

5. Send yourself an email and apply the `agent-inbox` label. Within ~30 seconds a
   `[bridgehead event]` turn appears with the trimmed message (HTML converted to
   text, body capped at 4,000 chars) fenced as untrusted data.
