# Linear

Linear signs webhooks with HMAC-SHA256 (hex) of the raw body in the
`linear-signature` header. **Linear generates the signing secret itself** — you
copy it from the webhook's detail page after creating the webhook. Each
delivery also carries a `Linear-Delivery` header, "a UUID (v4) that uniquely
identifies this payload" — the correct dedup key.

## 1. Source

```json
bridge_source_setup_webhook {
  "name": "linear",
  "verification": { "kind": "hmac-sha256", "header": "linear-signature" },
  "mapping": {
    "deliveryIdHeader": "linear-delivery",
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

Do NOT map `deliveryId` to the body's `webhookId` — that is the webhook's own
id, identical on every event, and would dedup everything after the first
delivery into `skipped-duplicate`.

## 2. Webhook

Linear → Settings → API → Webhooks → New webhook: paste the `webhookUrl` from
step 1 and pick the resource types (Issues, Comments, …). Then open the
webhook's detail page, copy **Linear's signing secret**, and store it:

```bash
bridgehead auth webhook --source webhook-linear
```

(Ignore the secret bridgehead generated at setup — Linear issues its own.)

Note: Linear requires an exact HTTP 200 response within 5 seconds; bridgehead's
listen-mode ingress returns exactly that.

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
