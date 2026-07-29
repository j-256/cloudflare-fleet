# Cloudflare Fleet

Cloudflare Fleet is a static local control plane for comparing and aligning Cloudflare zones. It loads zone configuration into a matrix, highlights missing and divergent values, and supports explicit, previewed writes for common fleet policies. The UI has no remote backend. A short-lived loopback broker lets the normal Chrome profile use the static dashboard without exposing the Cloudflare token to browser JavaScript.

## Launch

The launcher requires macOS, Google Chrome, Node.js with built-in `fetch` and `AbortSignal.timeout`, `jq`, `CLOUDFLARE_API_TOKEN`, and `CLOUDFLARE_ACCOUNT_ID`. Debug sessions also require built-in `WebSocket`.

```sh
./launch.sh
```

The default session is read/write with previewed and confirmed write controls. It opens as a regular tab in the existing Chrome profile without DevTools, a dedicated profile, or weakened browser security. Use `./launch.sh --read-only` to remove every write control and make the loopback broker reject Cloudflare write methods. Use `./launch.sh --debug-port 9224` only to open an isolated direct-client browser through Chrome DevTools for development and browser automation.

The launcher explicitly activates the registered broker job and retries once if it does not publish readiness. Executable modules resolve synthetic and symlinked paths before deciding whether to run their command entrypoint. The launcher exits after Chrome establishes the tab's liveness connection. The loopback broker remains available while the tab is open, then removes its launchd service and temporary files after the final connection closes. If the broker stops unexpectedly, the loaded matrix remains visible and every live read and write control locks. Relaunch to restore live access.

## Cache and concurrent windows

Each successful full refresh is saved as an account-scoped configuration snapshot in the macOS user cache directory. A later launch renders the newest valid snapshot as the ready reading experience, labels it with its collection time, and does not repeat the full audit automatically.

Every write action performs a scoped live preflight before showing its confirmation. Actions declare the facts they require, and a read composer merges and deduplicates those requirements into direct resource reads or a scoped inventory read. Email alignment rereads only the live Email Routing and DNS inputs needed to rebuild the fleet policy, WAF alignment rereads its rule phase, a DNS hole reads only its source and destination, a rule copy rereads only its source, targets, and phase, a fleet rename reads exact rulesets, and an individual cell edit rereads that resource. **Refresh full fleet** remains the explicit operation that rereads every configured surface, updates the entire matrix, and replaces the persistent snapshot.

Use `./launch.sh --fresh` to bypass the cache for one launch without deleting it. Use `./launch.sh --clear-cache` to remove this account's snapshots before loading live state. Set `CLOUDFLARE_FLEET_CACHE_DIR` to override the cache directory for development or isolation.

Concurrent normal dashboard tabs use separate loopback brokers, random session capabilities, and runtime files. Debug launches also use separate disposable Chrome profiles and debugging ports. Sessions share only the persistent snapshot directory, write to separate per-session files, and select snapshots by the inventory collection time. Closing one tab ends only its broker and leaves the shared snapshots and other tabs intact.

## Architecture

The control plane keeps UI intent separate from Cloudflare endpoint shape. A single desired-state edit can therefore require no write, one direct write, or a sequence of dependent operations.

```text
cached inventory -> normalized matrix -> desired-state intent
                                          |
                                          v
live read composer -> endpoint adapter -> operation plan
                                          |
                                          v
reviewed confirmation -> executor -> full audit -> persistent snapshot
```

`src/inventory.mjs` owns complete and scoped inventory reads. `src/cache-store.mjs` persists only completed snapshots. `src/session-broker.mjs` serves the static runtime, forwards bounded same-origin API requests, saves snapshots, and owns normal-tab cleanup. `src/session-watcher.mjs` manages direct-client debug sessions. `src/matrix.mjs` turns raw inventory into stable comparable facets and capability metadata. `src/fleet-policy.mjs` contains intentional enforcement exceptions without hiding differences. `src/read-composer.mjs` merges action requirements, deduplicates direct reads, and resolves dependent phase reads. `src/policies.mjs` validates desired state against endpoint-specific writable fields and produces ordered operation plans. `src/app.mjs` coordinates browser state, confirmations, execution, and explicit full refreshes.

## Security model

Cloudflare's API rejects the cross-origin preflight from a normal `file://` page. The default launcher therefore creates a mode-0700 temporary runtime and an ephemeral HTTP broker bound only to `127.0.0.1` on a random port. The token is transferred through a mode-0600 startup file that the broker reads and deletes before accepting browser traffic. It remains only in the broker process and is never sent to the browser.

The page receives a random session capability instead of the Cloudflare credential. Broker API requests require that capability, reject cross-site browser requests, and can target only the Cloudflare API boundary with `GET`, `PATCH`, `POST`, or `PUT`. Static responses are same-origin-only and non-frameable. The Content Security Policy loads no remote code, images, fonts, or frames. Neither the token nor the session capability is placed in browser storage or the persistent cache, rendered, logged, or passed in the dashboard URL.

The broker validates account and cache schema before saving a completed snapshot with mode 0600. Its streaming liveness connection keeps the session available while the dashboard is open and triggers cleanup after the last tab disconnects. Cached snapshots contain the configuration displayed by the dashboard, so treat the cache directory as sensitive local data even though it contains no API token.

`--debug-port` is the only mode that creates a disposable profile, enables direct browser-to-Cloudflare requests, weakens cross-origin enforcement inside that profile, and exposes a loopback DevTools endpoint. Do not open unrelated sites in that debug window. Debug mode does not change the normal Chrome profile.

## Inventory

The dashboard reads zone metadata, zone settings, DNS records, DNSSEC, Email Routing settings and rules, rulesets and zone-owned rule details, Workers routes, legacy firewall views, and other comparable zone surfaces supported by the account. Each failed or blocked surface is reported in the coverage panel.

Opaque identifiers and timestamps are removed before comparison. Zone names inside values are normalized to `{zone}`, unordered collections are sorted, and semantically meaningful settings remain visible.

## Writes

The dashboard supports these write paths:

- Align Email Routing with the verified fleet catch-all destination, required DNS records, unlocked record state, plus-addressing, and the unique live SPF and zone-relative DMARC consensus
- Create or update the two named `[fleet]` WAF rules from the unique live fleet consensus
- Edit Cloudflare zone settings that the API marks editable
- Edit existing unlocked DNS records, including Email DNS specification rows backed by live DNS records
- Edit rules in zone entrypoint and custom rulesets
- Copy a self-contained rule from a zone entrypoint to selected zones
- Fill a missing DNS cell from a type-compatible fleet variant
- Fill a missing portable rule from an existing zone
- Route a missing Email policy cell through the full Email Routing policy composer
- Rename every present editable instance of a rule across the fleet

In write mode, click an editable matrix cell to open its desired-state editor. Click an outlined missing cell to use the unique fleet value or choose among tied variants, inspect the live operation plan, and fill the hole. Zone settings edit a desired value. DNS records and rules edit a desired definition, with a record chooser when one DNS cell contains multiple records. Use **Select targets** before running a fleet alignment or rule-copy action. **Edit settings** filters the matrix to zone settings and focuses the first editable cell.

The matrix opens on differences among fleet patterns, defined as facets present in at least two zones, so records unique to one zone do not dominate the initial view. The scope filter exposes fleet-wide, zone-specific, and unfiltered views without dropping any inventory. Category and DNS-type filters include facet counts. Search uses all entered terms and covers facet names, values, and the zones where each facet is present.

Keyboard users can skip directly to the fleet controls or matrix, press `/` to focus search, and press Escape in search to clear it. The matrix exposes one tab stop for its cell controls; arrow keys move between disclosures and actions, Home and End move within a row, and Ctrl/Command+Home and End move across the visible matrix. Filtering preserves a valid matrix tab stop. Dialogs have programmatic names, deliberate initial focus, focus restoration, announced validation errors, and non-destructive Escape and backdrop dismissal. Reduced-motion and forced-color preferences receive explicit presentation support.

The matrix reports capabilities instead of treating every non-editable cell as globally read-only. A zone setting with `editable=false` cannot be changed through the Zone Settings endpoint, but another Cloudflare product API may expose equivalent behavior. Rule facets lead with the rule name and show the action and phase as secondary metadata. Rules remain directly editable even when they cannot be copied. Self-contained rules in a zone entrypoint expose **Copy to selected** as a secondary action. Managed rules, custom rulesets that need deployment, and rules with target-specific identifiers stay blocked from copying with a reason.

A rule copy strips Cloudflare-managed identifiers, replaces source-zone names with the destination zone, and checks the live destination for an exact match, a stable reference, or a unique description before deciding whether to skip, update, append, or create the phase entrypoint. Known plan quotas are checked before append operations. The exact decision and request body remain visible in the confirmation.

An editable rule row exposes **Rename across fleet**. The action rereads every exact live ruleset represented in the row, preserves each zone's action, expression, parameters, enabled state, logging, rate limits, stable reference, and dependencies, and changes only the rule description. A `{zone}` placeholder materializes to each zone's domain. Missing zones remain holes under the new name and can be filled separately. If any present instance is managed or otherwise lacks the direct rule adapter, the fleet rename action is withheld instead of applying a partial rename.

The editor captures desired state rather than exposing an endpoint-shaped form. A resource planner compares that state with the composed live reads and emits zero, one, or several Cloudflare API operations. An actionable plan opens a confirmation dialog containing the validation time, target zones, current value when applicable, HTTP methods, endpoints, and JSON bodies. Every dialog can be dismissed with its X, a backdrop click, Escape, or Cancel where shown; dismissal never performs a write. Writes run only after confirmation. The dashboard then reloads the full fleet to verify the resulting state. It does not offer delete operations.

DNS and Ruleset payload allowlists follow Cloudflare's official [OpenAPI schemas](https://github.com/cloudflare/api-schemas). Computed DNS `content` is excluded for structured record types that write through `data`, server-managed rule fields are stripped, and an unknown DNS type remains inspectable instead of receiving an unsafe generic write control.

The matrix is descriptive and always shows real differences. Enforcement exceptions live in `src/fleet-policy.mjs`; the bundled policy acknowledges the storefront-specific SPF value on `zone-c.example`, keeps that difference visible in the matrix, excludes it from actionable policy drift, and preserves it during Email Routing alignment. Review selected zones and payloads before applying a write.

## Tests

Run the dependency-free unit suite and shell validation:

```sh
node --test test/*.test.mjs
shellcheck launch.sh
```

## License

Cloudflare Fleet is licensed under AGPL-3.0-only. See `LICENSE`.
