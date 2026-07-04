# Contributing

## Dev setup

```bash
npm install
npm run typecheck
npm test               # vitest; coverage: npm run test:coverage
npm run lint           # biome
npm run build          # tsc → dist/
```

Node ≥ 20.18. No end-to-end Codex tests run in CI (CI can't assume a logged-in
codex install) — the sink is mocked in unit tests, and the real path is covered by
the manual smoke test below. Run it before cutting a release.

## Manual smoke test (~10 minutes, needs codex installed + logged in)

1. **Init & start**
   ```bash
   WAKEWIRE_HOME=$(mktemp -d) ; export WAKEWIRE_HOME
   node dist/cli.js init
   node dist/cli.js start &      # foreground daemon in the background of this shell
   node dist/cli.js status       # expect adapter.codexReachable: true
   ```
2. **M1 — injection.** Create a target thread and inject:
   ```bash
   codex exec --skip-git-repo-check "say READY and stop" --json | grep thread.started
   ./scripts/demo/m1-inject.sh <threadId> "hello from wakewire"
   codex resume <threadId>   # verify both turns are there
   ```
3. **M2 — webhook path.** Create a listen-mode source + route (see header of
   `scripts/demo/m2-github-push.sh`), then:
   ```bash
   ./scripts/demo/m2-github-push.sh <sourceId> <secret> demo-1
   ./scripts/demo/m2-github-push.sh <sourceId> <secret> demo-1   # duplicate → skipped-duplicate
   ```
   Check `GET /api/deliveries`: first `delivered`, second `skipped-duplicate`.
   With a real repo webhook (smee mode), a push should land within ~10 seconds.
4. **M3 — plugin.** Follow `scripts/demo/m3-plugin.md` from a fresh Codex session.
5. **M4 — gmail.** Follow `scripts/demo/m4-gmail.md`; a labeled email should land
   within ~30 seconds; verify an HTML-only email renders readably.
6. **Resilience.** Quit the Codex app / revoke network, send an event, confirm the
   delivery goes `held` and delivers after recovery; `kill -9` the daemon
   mid-delivery and restart — the delivery must not be lost or doubled.

## Release checklist

- `npm run prepublishOnly` green on Node 20 and 22
- `npm publish --dry-run` — confirm the tarball contains `dist/`, `plugin/`, docs
- Tag, publish, then submit/refresh the entry on awesome-codex-plugins
- Re-run `codex app-server generate-ts` against the newest codex and diff — the
  app-server surface is experimental and drifts; adapters live in `src/sinks/`.

## Style

Biome-formatted, strict TypeScript, ESM. Keep the AgentAdapter seam clean: nothing
outside `src/sinks/` may know how turns reach Codex. Sources own payload trimming;
nothing downstream of a source may see raw provider payloads.
