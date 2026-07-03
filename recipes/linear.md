# Linear

Linear signs webhooks with HMAC-SHA256 (hex) of the raw body in the
`linear-signature` header. You choose the secret when creating the webhook, so
use the one bridgehead generates.

## 1. Source

```json
bridge_source_setup_webhook {
  "name": "linear",
  "verification": { "kind": "hmac-sha256", "header": "linear-signature" },
  "mapping": {
    "deliveryId": "webhookId",
    "kind": "type",
    "occurredAt": "createdAt",
    "summary": "{{action}} {{kind}}: {{title}}",
    "fields": {
      "action": "action",
      "title": "data.title",
      "identifier": "data.identifier",
      "state": "data.state.name",
      "assignee": "data.assignee.name",
      "priority": "data.priorityLabel",
      "url": "url"
    }
  }
}
```

(As with ClickUp, capture an event first if you want to refine the id path —
`webhookId` dedups per delivery attempt, which is usually what you want.)

## 2. Webhook

Linear → Settings → API → Webhooks → New webhook: paste the `webhookUrl` and
the `secret` from step 1, pick the resource types (Issues, Comments, …).

## 3. Route examples

Urgent bugs into a thread:

```json
bridge_route_add {
  "name": "urgent linear issues",
  "source": "webhook",
  "match": {
    "provider": "linear",
    "events": ["Issue"],
    "where": [{ "field": "priority", "equals": "Urgent" }]
  },
  "target": { "type": "thread", "threadId": "<your thread>" }
}
```
