# M3 demo: zero-to-route from inside the Codex app

The plugin's MCP server starts via `npx -y wakewire mcp`, so it works without a
global install. The daemon itself still needs `npm install -g wakewire` (or a
local checkout) to run `wakewire start`.

1. Add the plugin marketplace and install:

   ```
   codex plugin marketplace add <this-repo-url-or-local-path>
   ```

   Then in Codex run `/plugins`, find **WakeWire**, and install it. Restart Codex.

2. In a Codex conversation, say:

   > Use $wakewire-setup to watch pushes to acme/api and drop them into this thread.

   The model should:
   - call `wakewire_status`, see the daemon is missing, and tell you to run
     `wakewire init && wakewire start --detach`;
   - run `echo "$CODEX_THREAD_ID"` to resolve the current thread;
   - call `wakewire_source_setup_github` and relay the smee URL + secret for you to
     paste into the repo's webhook settings;
   - call `wakewire_route_add` targeting this thread.

3. Push a commit to the repo. Within seconds a `[wakewire event]` turn appears.

4. Ask: "replay the last delivery" — the model uses `wakewire_deliveries` + `wakewire_replay`.
