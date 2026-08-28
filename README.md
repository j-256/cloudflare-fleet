# Cloudflare Fleet

Cloudflare Fleet is a self-hosted control plane for auditing and aligning Cloudflare zones. It turns settings, DNS, DNSSEC, Email Routing, rules, and account resources into one comparable matrix; lets operators define expected state for exact zone scopes; and keeps supported mutations behind fresh reads, exact plans, human confirmation, durable activity, and scoped verification.

![Cloudflare Fleet dashboard with a synthetic example fleet](docs/screenshots/dashboard-overview.png)

The same browser application runs in two modes:

- An Access-protected Cloudflare Worker with D1 persistence for hosted access
- An ephemeral local loopback broker on macOS for a complete local workflow

Neither mode exposes the Cloudflare API token to browser JavaScript. Hosted configuration defaults to read-only, and local capabilities remain available after a hosted deployment.

## What Fleet does

- Compares normalized configuration across every selected zone without hiding raw source values
- Separates observed differences from saved fleet intent, acknowledged exceptions, and expected coverage gaps
- Turns supported exact and forbidden intent into first-class cell, row, and policy alignment reviews
- Audits core fleet posture in Markdown, JSON, or self-contained HTML, with an optional deep account and endpoint pass
- Plans direct settings, DNS, DNSSEC, Email Routing, and ruleset changes through endpoint-specific adapters
- Displays targets, before and after values, methods, endpoints, and request bodies before a write
- Saves pending activity before mutation, verifies authoritative resources afterward, and offers guarded undo only when the inverse is lossless
- Keeps the hosted Cloudflare proxy inside explicit read and write allowlists

The [documentation site](docs/index.html) includes the complete [architecture](docs/architecture.html), [deployment guide](docs/deployment.html), [security model](docs/security.html), and accessible visual diagrams.

## Install from source

The package is intentionally private to prevent accidental registry publication, but its declared binary and package allowlist support a conventional source install:

```sh
git clone https://github.com/j-256/cloudflare-fleet.git
cd cloudflare-fleet
npm ci
npm install --global .
cloudflare-fleet --help
```

`cloudflare-fleet` is the canonical operator command. The npm scripts and `./launch.sh` remain source-checkout compatibility wrappers and enter the same implementations. Durable state defaults to `$XDG_STATE_HOME/cloudflare-fleet/state.json`, falling back to `~/.local/state/cloudflare-fleet/state.json`; policy defaults to the corresponding `cloudflare-fleet/fleet-policy.json` below `$XDG_CONFIG_HOME` or `~/.config`. Explicit profile flags and `CLOUDFLARE_FLEET_STATE_FILE` or `CLOUDFLARE_FLEET_POLICY_FILE` override those paths.

## Hosted quick start

Hosted Fleet needs a Cloudflare zone, D1 database, self-hosted Access application, custom-domain Worker, and account API token. Node.js 22 or newer is required for the toolchain.

```sh
npm ci
npx wrangler d1 create cloudflare-fleet

cloudflare-fleet hosted configure \
  --account-id "$CLOUDFLARE_ACCOUNT_ID" \
  --database-id "$CLOUDFLARE_FLEET_D1_DATABASE_ID" \
  --hostname fleet.example.com \
  --access-aud "$CLOUDFLARE_ACCESS_AUD" \
  --access-team-domain "$CLOUDFLARE_ACCESS_TEAM_DOMAIN"

npm run db:migrate:remote
umask 077
printf 'CLOUDFLARE_API_TOKEN="%s"\n' "$CLOUDFLARE_API_TOKEN" > .dev.vars.production
npm run deploy -- --secrets-file .dev.vars.production
```

The generator writes ignored, mode-restricted `wrangler.jsonc` and defaults it to backend-enforced read-only mode. See the [deployment guide](docs/deployment.html) for Access setup, secret handling, verification, optional state import, and the deliberate `--write` opt-in.

`wrangler.example.jsonc` documents the portable binding shape. `fleet-policy.example.json` documents optional typed operator exceptions. Live account IDs, D1 IDs, Access values, policy exceptions, fleet state, and secrets do not belong in Git.

## Local launch

The local launcher requires macOS, Node.js 22 or newer, `jq`, a Chromium-compatible browser, and account credentials in the shell.

```sh
export CLOUDFLARE_API_TOKEN="your-account-token"
export CLOUDFLARE_ACCOUNT_ID="your-account-id"
cloudflare-fleet dashboard --read-only
```

Use `cloudflare-fleet dashboard --write` for the full reviewed-write workflow. The launcher opens a normal browser tab through a random loopback broker, persists intent and activity to the durable per-user state file, and removes its private runtime after the last dashboard connection closes. `--state-file` and `--policy-file` select explicit profiles; their environment-variable equivalents require absolute paths. `./launch.sh` accepts the same options for checkout-local compatibility.

Debug mode is intentionally separate. `cloudflare-fleet dashboard --debug-port 9224` creates an isolated browser profile with direct Cloudflare transport for development and browser automation; it cannot persist intent or activity through the broker.

## Read-only audit

The CLI reads live Cloudflare inventory and configured Fleet state without sending mutations. Progress goes to stderr so stdout remains pipeable.

```sh
cloudflare-fleet audit
cloudflare-fleet audit --format json
cloudflare-fleet audit --format html > audit.html
cloudflare-fleet audit --deep --fail-on warning
```

Core findings cover inventory gaps, fleet intent, DNSSEC transitions, Email Routing policy, shared WAF rules, editable settings, TLS and certificate posture, duplicate DNS, mail policy, and ruleset health. Deep mode adds bounded public DNS, endpoint, Registrar, Pages, Workers, storage, binding, route, and dependency evidence. Use `--state-file` or `--policy-file` to select explicit documents.

`--fail-on` exits with a distinct policy status after rendering the complete report. Authentication, inventory, argument, and rendering failures remain operational errors. The deep audit is a point-in-time review of every proxied exact hostname; it does not schedule probes or retain endpoint state.

## Operator CLI and MCP

The fleet CLI exposes the dashboard's complete headless operator contract: audit, intent persistence, intent alignment, bounded direct changes, durable activity, guarded undo, hosted configuration, and state import. Text is the default for operators; `--format json` emits one structured JSON document on stdout while progress and diagnostics remain on stderr.

```sh
cloudflare-fleet alignment list --format json
cloudflare-fleet alignment plan --policy POLICY_ID --format json
cloudflare-fleet alignment apply --policy POLICY_ID \
  --expect-plan 'sha256:...' --format json

umask 077
cloudflare-fleet intent show > fleet-intent.json
cloudflare-fleet intent plan --input fleet-intent.json --format json
cloudflare-fleet intent apply --input fleet-intent.json \
  --expect-plan 'sha256:...' --format json

cloudflare-fleet schema change > fleet-change.schema.json
cloudflare-fleet change plan --input change.json --format json
cloudflare-fleet change apply --input change.json \
  --expect-plan 'sha256:...' --format json

cloudflare-fleet activity list --format json
cloudflare-fleet activity undo plan --id ACTIVITY_ID --format json
cloudflare-fleet activity undo apply --id ACTIVITY_ID \
  --expect-plan 'sha256:...' --format json
```

Select an alignment policy with `--policy ID`, a complete matrix row with `--category CATEGORY --key KEY [--phase PHASE]`, or repeat `--zone-id ID` with a row selector to target cells. `intent show` emits an editable complete document in text mode; intent apply validates its account and revision, computes collection-level differences, and persists it atomically only if the reviewed digest still matches. `schema change` describes the discriminated direct-change vocabulary for settings, DNS, Email Routing, rulesets, safe copies, fleet rename, and shared-policy alignment. It accepts operator outcomes and identifiers, never arbitrary HTTP methods or API paths.

Every Cloudflare apply repeats fresh scoped planning inside the exclusive write lock, writes a pending activity record before mutation, executes in order, and verifies authoritative resources afterward. Guarded undo is available only for a lossless inverse and is blocked when fresh reads differ from the recorded post-write state. The CLI is deliberately noninteractive, so its caller is responsible for presenting and approving the complete plan before passing the digest.

The stable exit contract is documented by `cloudflare-fleet --help`: success is `0`, runtime failure is `1`, invalid usage is `2`, a missing dependency is `3`, blocked or attention-required outcomes are `4`, a changed plan is `5`, a write failure is `6`, and a verification failure is `7`.

The local stdio MCP server gives compatible agents a narrower tool surface than a raw Cloudflare API proxy:

```sh
cloudflare-fleet mcp
```

Configure clients with the installed executable and a subcommand, which is the standard MCP stdio command-plus-arguments shape:

```json
{
  "mcpServers": {
    "cloudflare-fleet": {
      "command": "cloudflare-fleet",
      "args": ["mcp"]
    }
  }
}
```

The server registers read, plan, and apply tools for fleet audit, complete intent persistence, single or batched intent alignment, bounded direct changes, activity inspection, and guarded undo. Mutation tools display the exact request, digest, and operations through MCP input elicitation, require explicit approval, authenticate short-lived method-bound confirmation state, and call the service's fresh apply path. Tool results include typed structured content plus an equivalent serialized JSON text block for clients that have not adopted structured results. Tool-specific output schemas describe the meaningful result fields instead of one generic envelope.

- Read: `audit_fleet`, `get_fleet_intent`, `list_alignment_candidates`, and `list_activity`
- Plan: `plan_fleet_intent`, `plan_alignment`, `plan_fleet_change`, and `plan_activity_undo`
- Apply: `apply_fleet_intent`, `apply_alignment`, `apply_alignments`, `apply_fleet_change`, and `apply_activity_undo`

A short-lived, intent-revision-bound baseline avoids repeating the complete alignment candidate inventory, but fresh membership and selected surfaces are still reread. Protocol messages use stdout and diagnostics use stderr. The package version is reported consistently by the CLI, package metadata, and MCP server identity.

Cloudflare GET requests honor `Retry-After` when the API returns HTTP 429. Exhausted throttling fails the inventory operation instead of presenting partial coverage as trustworthy drift, and mutating requests are never automatically retried.

The CLI and MCP process inherit `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. Keep the token in the launching process environment instead of a tracked or shared client configuration. Durable per-user state and policy paths are independent of the npm installation, so reinstalling the binary cannot replace operator data. Pass `--state-file PATH` and `--policy-file PATH` to `cloudflare-fleet mcp` when using explicit profiles; the same profile options are available where the corresponding CLI workflow needs them. These direct local processes hold the token's authority, and their JSON, audit, plan, and activity output can contain sensitive fleet configuration.

## Fleet intent and writes

Fleet intent defines presence and value constraints independently. Broader groups act as baselines, contained groups refine them, and partial overlaps remain peers. Exact acknowledgements bind one policy, zone, and observed normalized value, then become stale if that context changes. Saving intent evaluates drift but never writes Cloudflare.

Review alignment appears on a supported policy, matrix row, and individual drifting cell. Exact intent can edit supported zone settings, Email Routing's `skip_wizard` and `support_subaddress` settings, DNS records, DNSSEC status, API-managed Email Routing rules, redirects, and ruleset rules, and it can fill missing DNS records and portable rules from a matching fleet source. Forbidden intent can remove supported DNS records and rules through reversible adapters. Conflicts, must-differ choices, required values without an exact expectation, missing portable sources, generated resources, and unsupported endpoint shapes stay visibly blocked with their exact reason beside the disabled action.

A row or policy review is all-or-nothing: every unacknowledged drift cell in that action scope must have a deterministic adapter. A cell review deliberately narrows the requested change to one zone. Both forms reread the relevant facet across every account zone, reject changed fleet membership or incomplete reads, reevaluate the latest saved intent, and only then build the confirmation.

![Cloudflare Fleet intent alignment review using a synthetic example fleet](docs/screenshots/intent-alignment.png)

Endpoint adapters strip server fields, preserve target-specific identity, and refuse unsupported shapes. The confirmation contains the live validation time, affected zones, current and desired values, methods, endpoints, and payloads. A pending activity record is durable before execution. Verification rereads exact affected resources and patches the matrix and persistent snapshot once.

Clearing or bypassing the inventory cache never removes intent or activity. Hosted sessions use transactional D1 state; local sessions use revisioned sections in the ignored account-scoped state file.

## Documentation and screenshots

The dependency-free site under [`docs/`](docs/) is ready for GitHub Pages branch publishing from `/docs`. Preview it locally with:

```sh
npm run docs:serve
```

Public product screenshots are automated:

```sh
npx playwright install chromium
npm run screenshots
```

The capture script drives the real dashboard through its deterministic local test broker. It uses only `alpha.example`, `bravo.example`, `charlie.example`, documentation IP addresses, synthetic configuration, and a literal fake test token. It does not read shell Cloudflare credentials, ignored operator files, D1, the hosted Worker, or a live API endpoint.

## Development

Install the exact lockfile and browser once per checkout:

```sh
npm ci
npx playwright install chromium
```

Run the complete deterministic verification surface:

```sh
npm test
npm run test:e2e
npm run test:e2e:ergonomics
shellcheck launch.sh
npm run build:hosted
npx wrangler deploy --dry-run --config wrangler.example.jsonc
npm run check:publication
```

`npm run test:all` combines the unit and browser suites. The browser suite serves the shipped dashboard through its real loopback broker and replaces only the upstream Cloudflare transport with a stateful local fake. Playwright failure artifacts stay under ignored `test-results/` because traces and screenshots can contain rendered configuration.

An opt-in live read-only journey is available through `npm run test:e2e:live:read-only`. It requires account credentials, bypasses cached inventory, isolates state and cache, and enforces `GET` at both the broker and test transport. Keep its ignored artifacts private.

## Publication safety

Run the publication gate before proposing a public change:

```sh
npm run check:publication
```

The checker rejects operator files, unexpected symbolic links, machine-private paths, malformed screenshots, and broken local documentation links. It also requires the public documentation, security guidance, CI workflow, and synthetic product screenshots that make the repository independently useful.

## Security

Read [SECURITY.md](SECURITY.md) and the [security architecture](docs/security.html) before enabling writes. Do not report suspected vulnerabilities through a public issue, and never attach live tokens, state files, audit reports, or fleet screenshots to a public report.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, verification, screenshot, documentation, and pull request guidance.

## License

Cloudflare Fleet is licensed under [AGPL-3.0-only](LICENSE).

Cloudflare is a trademark of Cloudflare, Inc. This independent project is not affiliated with or endorsed by Cloudflare, Inc.
