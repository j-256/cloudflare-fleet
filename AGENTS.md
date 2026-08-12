# Repository guidance

## Development

Install dependencies with `npm ci`. Keep `state.json`, `fleet-policy.json`, `.dev.vars`, and `wrangler.jsonc` untracked because they contain operator-specific configuration or fleet data. Use the example files as templates.

Run focused tests while developing, then run `npm test`, `npm run test:e2e`, `npm run build:hosted`, and `npm run check:publication` before a release. Regenerate public product images with `npm run screenshots` when visible dashboard behavior changes.

## Browser handoff

Whenever browser verification leaves the local dashboard open, ensure the final surviving launch is read/write (`./launch.sh --write`). Terminate a read-only launch instead of leaving it open.
