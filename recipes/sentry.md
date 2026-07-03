# Sentry

Sentry (internal integrations) signs webhooks with HMAC-SHA256 (hex) of the raw
body in the `sentry-hook-signature` header, using the integration's Client
Secret.

## 1. Source

Create the source first in capture mode to see your org's exact payload shape,
then apply a mapping like:

```json
bridge_source_setup_webhook {
  "name": "sentry",
  "verification": { "kind": "hmac-sha256", "header": "sentry-hook-signature" },
  "mapping": {
    "kind": "action",
    "summary": "{{level}}: {{title}} ({{project}})",
    "fields": {
      "title": "data.issue.title",
      "level": "data.issue.level",
      "project": "data.issue.project.slug",
      "culprit": "data.issue.culprit",
      "url": "data.issue.web_url"
    }
  }
}
```

No `deliveryId` path: Sentry doesn't put a stable event id at a fixed path
across resource types, and the body-hash fallback dedups exact redeliveries.

## 2. Integration

Sentry → Settings → Developer Settings → New Internal Integration: set the
Webhook URL to the `webhookUrl` from step 1, enable "Issue & Event" webhooks.
Sentry issues its own Client Secret — store it instead of the generated one:

```bash
bridgehead auth webhook --source webhook-sentry
```

## 3. Route

```json
bridge_route_add {
  "name": "sentry errors",
  "source": "webhook",
  "match": { "provider": "sentry", "where": [{ "field": "level", "equals": "error" }] },
  "target": { "type": "new-thread", "cwd": "/path/to/repo", "worktree": true },
  "sandbox": "workspace-write",
  "promptTemplate": "A Sentry error arrived: {{title}}. Investigate the stack trace info in the event data and propose a fix."
}
```
