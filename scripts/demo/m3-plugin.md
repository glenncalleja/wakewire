# M3 demo: zero-to-route from inside the Codex app

The plugin's MCP server starts via `npx -y bridgehead mcp`, so it works without a
global install. The daemon itself still needs `npm install -g bridgehead` (or a
local checkout) to run `bridgehead start`.

1. Add the plugin marketplace and install:

   ```
   codex plugin marketplace add <this-repo-url-or-local-path>
   ```

   Then in Codex run `/plugins`, find **Bridgehead**, and install it. Restart Codex.

2. In a Codex conversation, say:

   > Use $bridge-setup to watch pushes to acme/api and drop them into this thread.

   The model should:
   - call `bridge_status`, see the daemon is missing, and tell you to run
     `bridgehead init && bridgehead start --detach`;
   - run `echo "$CODEX_THREAD_ID"` to resolve the current thread;
   - call `bridge_source_setup_github` and relay the smee URL + secret for you to
     paste into the repo's webhook settings;
   - call `bridge_route_add` targeting this thread.

3. Push a commit to the repo. Within seconds a `[bridgehead event]` turn appears.

4. Ask: "replay the last delivery" — the model uses `bridge_deliveries` + `bridge_replay`.
