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

Do not add an operator domain, account identifier, D1 identifier, Access audience, team name, email address, API token, deployment target, or machine-local absolute path to tracked content. Official repository and documentation links identify the upstream project; they do not configure a clone's deployment. Run `npm run check:publication` before proposing a change.

## Making changes

- Keep browser, local broker, and hosted Worker behavior aligned through the shared transport and persistence contracts.
- Give a new write path an explicit capability, scoped preflight reads, endpoint-specific planner, reviewed operation shape, durable activity behavior, and authoritative verification mapping.
- Add equivalent purpose-built CLI and MCP read, plan, apply, confirmation, persistence, verification, activity, and recovery coverage for every operator capability. Do not add a raw Cloudflare request escape hatch.
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
npm run build:docs
npm run deploy:docs:dry-run
npm run check:install
npm run check:publication
```

The opt-in live read-only test is useful for changes to inventory coverage, but it is not required for contributions and must never produce public artifacts.

## Documentation and screenshots

The Workers Static Assets site lives under `docs/` and uses only relative, dependency-free assets. Preview it with `npm run docs:serve`; reproduce the exact deployment artifact with `npm run build:docs`.

When visible dashboard behavior changes, regenerate the public screenshots with `npm run screenshots`. The capture must continue using only the deterministic fixture. Inspect each image for synthetic `.example` data before committing it. Do not replace these images with live-account captures.

### Optional documentation publication

The default workflow verifies the documentation source, artifact, and neutral Worker configuration. Publication is opt-in so a fork does not attempt to deploy after an ordinary push to `main`.

To enable publication for a repository, set the repository variable `CLOUDFLARE_FLEET_PUBLISH_DOCUMENTATION` to `true` and set `CLOUDFLARE_FLEET_DOCUMENTATION_URL` to that repository's HTTPS documentation origin. Create a protected GitHub Actions environment named `documentation`, store the Cloudflare account identifier in its `CLOUDFLARE_ACCOUNT_ID` variable, and store a dedicated account-owned token with Workers Scripts Write in its `CLOUDFLARE_WORKERS_DEPLOY_TOKEN` secret. Configure any custom domain and redirects in the owning Cloudflare account rather than in tracked source.

The workflow deploys the exact artifact produced by verification and checks it against the configured origin. A maintainer can run the same verification against any deployment without changing source:

```sh
npm run check:docs:public -- --url https://docs.example.com
```

## Releases

Update `package.json` and `package-lock.json` to the intended version, complete the full verification surface, and merge the release-ready source before creating its annotated tag. The tag must exactly equal `v` followed by the package version. Pushing that tag runs the complete release gate again, packs the allowlisted source package, and attaches it to a generated GitHub Release. The workflow refuses a mismatched tag, and the package remains private to prevent npm registry publication.

```sh
release_version="$(node -p 'require("./package.json").version')"
git tag -a "v$release_version" -m "Cloudflare Fleet v$release_version"
git push origin "v$release_version"
```

## Pull requests

Keep a pull request focused on one coherent change. Explain the user-facing outcome, important trust-boundary effects, and how it was verified. Call out new Cloudflare API permissions, persistent schema changes, migrations, or operational steps explicitly.

By contributing, you agree that your contribution is licensed under AGPL-3.0-only, the same license as the project.
