#!/usr/bin/env bash
# M1 demo: inject a turn into an existing Codex thread through the daemon.
#
#   ./scripts/demo/m1-inject.sh <threadId> [prompt]
#
# Get a thread id from `codex resume` (picker shows ids) or, inside a Codex
# conversation, run: echo "$CODEX_THREAD_ID"
set -euo pipefail

THREAD_ID="${1:?usage: m1-inject.sh <threadId> [prompt]}"
PROMPT="${2:-hello from wakewire}"
STATE_FILE="${WAKEWIRE_HOME:-$HOME/.wakewire}/daemon.json"

if [[ ! -f "$STATE_FILE" ]]; then
  echo "daemon not running (no $STATE_FILE) — run: wakewire start --detach" >&2
  exit 1
fi

PORT=$(python3 -c "import json;print(json.load(open('$STATE_FILE'))['port'])")
TOKEN=$(python3 -c "import json;print(json.load(open('$STATE_FILE'))['token'])")

BODY=$(THREAD_ID="$THREAD_ID" PROMPT="$PROMPT" python3 <<'EOF'
import json, os
print(json.dumps({"threadId": os.environ["THREAD_ID"], "prompt": os.environ["PROMPT"]}))
EOF
)

curl -sS -X POST "http://127.0.0.1:${PORT}/api/inject" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d "$BODY" | python3 -m json.tool

echo
echo "Now open the thread (codex resume ${THREAD_ID}) — the injected turn and the agent's reply should be there."
