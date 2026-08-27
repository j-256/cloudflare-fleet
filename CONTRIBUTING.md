# Contributing to Cloudflare Fleet

Thank you for improving Cloudflare Fleet. Contributions should preserve its central safety property: configuration is observable by default, while every supported mutation is fresh-read, explicitly planned, human-reviewed, durably recorded, narrowly executed, and verified.

## Development setup

Cloudflare Fleet requires Node.js 22 or newer. Install the exact dependency graph and Playwright Chromium build:

```sh
npm ci
npx playwright install chromium
```

Run the deterministic local fixture server for exploratory work:

```sh
npm run test:e2e:serve
```

The command prints a loopback URL backed by synthetic `.example` zones. Stop it with Ctrl-C.

## Keep operator data private

Never commit or attach `state.json`, `fleet-policy.json`, `wrangler.jsonc`, `.dev.vars*`, `.env*`, live audit output, browser traces, or screenshots from a real account. Use the committed example files and deterministic fixture data in tests, docs, issues, and pull requests.

Do not add a real domain, account identifier, D1 identifier, Access audience, team name, email address, API token, or machine-local absolute path to tracked content. Run `npm run check:publication` before proposing a change.

## Making changes

- Keep browser, local broker, and hosted Worker behavior aligned through the shared transport and persistence contracts.
- Give a new write path an explicit capability, scoped preflight reads, endpoint-specific planner, reviewed operation shape, durable activity behavior, and authoritative verification mapping.
- Leave unsupported or schema-unknown resources comparison-only instead of widening a generic adapter.
- Add focused unit coverage near the domain module and an end-to-end journey when behavior crosses the browser and backend boundary.
- Keep documentation prose soft-wrapped and use straight ASCII quotes.

## Verification

Run focused tests while iterating, then use the complete checks appropriate to the change:

```sh
npm test
npm run test:e2e
npm run test:e2e:ergonomics
shellcheck launch.sh
npm run build:hosted
npx wrangler deploy --dry-run --config wrangler.example.jsonc
npm run check:publication
```

The opt-in live read-only test is useful for changes to inventory coverage, but it is not required for contributions and must never produce public artifacts.

## Documentation and screenshots

The GitHub Pages site lives under `docs/` and uses only relative, dependency-free assets. Preview it with `npm run docs:serve`.

When visible dashboard behavior changes, regenerate the public screenshots with `npm run screenshots`. The capture must continue using only the deterministic fixture. Inspect each image for synthetic `.example` data before committing it. Do not replace these images with live-account captures.

## Pull requests

Keep a pull request focused on one coherent change. Explain the user-facing outcome, important trust-boundary effects, and how it was verified. Call out new Cloudflare API permissions, persistent schema changes, migrations, or operational steps explicitly.

By contributing, you agree that your contribution is licensed under AGPL-3.0-only, the same license as the project.
