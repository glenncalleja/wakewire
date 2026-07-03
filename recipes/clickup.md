# ClickUp

ClickUp signs webhooks with HMAC-SHA256 (hex) of the raw body in the
`X-Signature` header — but it **generates the secret itself** when you register
the webhook, so the flow is: create the source, register the webhook via
ClickUp's API, then store the secret ClickUp returned.

## 1. Source

```json
bridge_source_setup_webhook {
  "name": "clickup",
  "verification": { "kind": "hmac-sha256", "header": "x-signature" },
  "mapping": {
    "deliveryId": "webhook_id",
    "kind": "event",
    "summary": "{{kind}} on task {{taskId}}",
    "fields": {
      "taskId": "task_id",
      "historyStatus": "history_items.0.after.status",
      "historyUser": "history_items.0.user.username",
      "historyField": "history_items.0.field"
    }
  }
}
```

Note: `deliveryId: "webhook_id"` is per-webhook, not per-event — if you see
`skipped-duplicate` on distinct events, re-run setup without `deliveryId` (body
hash) or capture an event and pick a better id path. ClickUp payloads vary a
lot by event type; capture mode is your friend here.

## 2. Register the webhook (ClickUp API)

```bash
curl -X POST "https://api.clickup.com/api/v2/team/<team_id>/webhook" \
  -H "Authorization: <your ClickUp API token>" \
  -H "Content-Type: application/json" \
  -d '{"endpoint": "<webhookUrl from step 1>", "events": ["taskCreated", "taskUpdated", "taskCommentPosted", "taskAssigneeUpdated"]}'
```

The response contains `webhook.secret` — store it:

```bash
bridgehead auth webhook --source webhook-clickup
```

## 3. Route

```json
bridge_route_add {
  "name": "clickup task events",
  "source": "webhook",
  "match": { "provider": "clickup" },
  "target": { "type": "thread", "threadId": "<your thread>" },
  "promptTemplate": "A ClickUp {{kind}} event arrived. Summarize what changed and whether it needs my attention."
}
```
