# Recipes

Preset configs for the generic webhook source (`wakewire_source_setup_webhook`).
Each recipe is a provider-specific verification preset + field mapping you can
paste, or hand to the model ("set up Sentry using the recipe"). The mapping
doubles as the payload whitelist: only mapped fields ever reach the model.

General workflow for a provider without a recipe:

1. `wakewire_source_setup_webhook` with just `name` + `verification` — the next
   3 events are captured raw.
2. Trigger a test event from the provider.
3. `wakewire_source_captures` — read the real payload.
4. Re-run `wakewire_source_setup_webhook` with the mapping you authored.
5. `wakewire_route_add` with `source: "webhook"`, `match: {"provider": "<name>"}`.

Recipes: [clickup.md](clickup.md) · [linear.md](linear.md) · [sentry.md](sentry.md)
