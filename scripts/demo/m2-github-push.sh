#!/usr/bin/env bash
# M2 demo: simulate a signed GitHub push delivery against a listen-mode source.
#
# Setup (once):
#   1. wakewire start --detach
#   2. Create a listen-mode source and note sourceId + secret:
#        curl -s -X POST http://127.0.0.1:$PORT/api/sources/github/setup \
#          -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
#          -d '{"repo":"acme/api","mode":"listen"}'
#   3. Add a route for repo acme/api (wakewire_route_add from Codex, or POST /api/routes).
#
#   ./scripts/demo/m2-github-push.sh <sourceId> <secret> [deliveryId]
#
# Run it twice with the same deliveryId to see dedup (skipped-duplicate).
set -euo pipefail

SOURCE_ID="${1:?usage: m2-github-push.sh <sourceId> <secret> [deliveryId]}"
SECRET="${2:?usage: m2-github-push.sh <sourceId> <secret> [deliveryId]}"
DELIVERY_ID="${3:-demo-$(date +%s)}"
STATE_FILE="${WAKEWIRE_HOME:-$HOME/.wakewire}/daemon.json"
PORT=$(python3 -c "import json;print(json.load(open('$STATE_FILE'))['port'])")

BODY=$(cat "$(dirname "$0")/sample-push.json")
SIG="sha256=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" | awk '{print $NF}')"

curl -sS -X POST "http://127.0.0.1:${PORT}/ingress/github/${SOURCE_ID}" \
  -H "Content-Type: application/json" \
  -H "X-GitHub-Event: push" \
  -H "X-GitHub-Delivery: ${DELIVERY_ID}" \
  -H "X-Hub-Signature-256: ${SIG}" \
  --data-binary "$BODY" | python3 -m json.tool

echo
echo "Check the delivery log: wakewire_deliveries (from Codex) or GET /api/deliveries."
