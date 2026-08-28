# Repository guidance

## Development

Install dependencies with `npm ci`. Keep `state.json`, `fleet-policy.json`, `.dev.vars`, and `wrangler.jsonc` untracked because they contain operator-specific configuration or fleet data. Use the example files as templates.

Run focused tests while developing, then run `npm test`, `npm run test:e2e`, `npm run build:hosted`, and `npm run check:publication` before a release. Regenerate public product images with `npm run screenshots` when visible dashboard behavior changes.

## MCP feature coverage

Treat the MCP server as a first-class interface to every operator capability. Any new or adjusted operator-facing feature must include equivalent bounded MCP coverage in the same logical change, including read, plan, mutation, confirmation, persistence, verification, activity, and recovery behavior wherever those semantics apply. When changing an existing feature that lacks MCP parity, close that feature's parity gap as part of the change rather than preserving the current omission. A feature is not complete until an agent can accomplish the same operator outcome through purpose-built MCP tools without an arbitrary Cloudflare API passthrough. Update MCP schemas, server instructions, focused tests, and public documentation alongside the feature. Purely visual changes do not require a new MCP surface unless they alter an operator capability.

## Browser handoff

Whenever browser verification leaves the local dashboard open, ensure the final surviving launch is read/write (`./launch.sh --write`). Terminate a read-only launch instead of leaving it open.
