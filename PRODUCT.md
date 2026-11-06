# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Cloudflare operators responsible for understanding and maintaining configuration across a fleet of zones. Their work includes comparing configuration, deciding which differences are intentional, defining expected state, investigating failures, and reviewing supported corrections.

Open decision: the primary audience's Cloudflare experience level and the relative priority of individual operators versus shared infrastructure teams have not been established.

## Product Purpose

Cloudflare Fleet is a self-hosted control plane for auditing and safely aligning Cloudflare zones. It brings observed configuration, saved expectations, read coverage, reviewed changes, and recorded outcomes into a common operating workflow.

The desired operating state is an empty misalignment queue. Fleet leads with outstanding misalignments, ungoverned decisions, and read health as distinct queues. Comparison is evidence inside the path from an outstanding item to a reviewed correction, verification, and completion; the full matrix supports investigation.

Success means an operator can explain a difference, distinguish an intentional exception from actionable drift or missing evidence, review the exact proposed correction, and inspect the verified result or recovery options. An empty queue establishes alignment only within successfully checked, configured intent; undefined expectations and incomplete evidence remain explicit.

## Positioning

Fleet combines cross-zone comparison with explicit fleet intent and bounded, endpoint-specific change adapters. The comparison matrix preserves access to raw source values, while intent describes expected presence and value relationships for exact zone scopes.

Saving intent and changing Cloudflare are distinct operations. Browser, CLI, and purpose-built MCP interfaces support the operator workflow; equivalent bounded MCP coverage is required when operator capabilities are added or changed.

## Operating Context

The browser application runs through an Access-protected Cloudflare Worker with D1 persistence or through a local loopback broker on macOS. Hosted configuration and the local dashboard default to read-only access. Write-capable sessions still require review and confirmation for supported mutations.

Hosted browser, CLI, and stdio MCP clients can share the same backend and persisted state. D1 is authoritative for shared Fleet intent, activity, and Worker records; Cloudflare is authoritative for live resources. Standalone local files are a separate operating mode, not synchronized replicas of hosted state. A configured hosted backend must not silently fall back to local operation.

The operating loop starts with diagnostics and an audit, proceeds through comparison and intent decisions, and uses reviewed plans for corrections. Activity and recovery workflows retain evidence when an operation fails, completes partially, or has an unknown outcome.

## Capabilities and Constraints

- Compare normalized zone settings, DNS, DNSSEC, Email Routing, rules, and supported account resources while retaining their source values
- Distinguish observed differences, saved intent, acknowledged exceptions, ungoverned configuration, and incomplete read coverage
- Define expected presence and value relationships, review adoption candidates, and save intent without mutating Cloudflare
- Plan supported changes with fresh reads, exact targets, current and desired values, and canonical request details bound to the reviewed confirmation
- Persist pending activity before execution, verify affected resources afterward, and offer guarded undo only when the inverse is lossless
- Keep unsupported changes and incomplete evidence visibly blocked with actionable reasons; unread data must never establish absence
- Provide structured diagnostics for failures, partial outcomes, resource limits, and recovery without exposing secrets or unnecessary personal data
- Keep credentials out of browser JavaScript and committed configuration; operator state, policy, and deployment configuration remain private
- Preserve equivalent read, plan, confirmation, mutation, persistence, verification, activity, and recovery behavior through bounded MCP tools wherever those semantics apply
- Consider Cloudflare Free compatibility when designing features, and document known Paid dependencies and workload-dependent limits without treating successful Paid testing as proof of Free support

## Brand Commitments

Use the established product name, Cloudflare Fleet. Operator-facing language must distinguish observation, saved intent, proposed action, and verified outcome. Explain blocked actions and unknown evidence directly without inventing assurances.

## Evidence on Hand

- [README.md](README.md) describes supported workflows, operating modes, safety boundaries, and distribution
- [The documentation source](docs/index.html) and its linked guides explain getting started, architecture, deployment, and security
- [Product screenshots](docs/screenshots/) demonstrate the real dashboard using synthetic fleet data; they are not customer deployments or production usage evidence
- [Browser fixtures and workflow tests](test/e2e/) exercise the dashboard with a deterministic local broker
- [Example policy](fleet-policy.example.json) and [deployment configuration](wrangler.example.jsonc) provide portable configuration shapes rather than live operator values

Public examples and images must remain synthetic and must not disclose private fleet data or credentials. Testimonials, customer adoption, and performance or reliability claims require separate evidence.

## Product Principles

1. Preserve evidence and uncertainty: show what was observed, what could not be read, and which conclusions remain unsupported
2. Keep operator intent explicit: observation, policy adoption, and Cloudflare mutation are separate decisions
3. Make changes reviewable and accountable: bind execution to the reviewed plan, record activity durably, and verify the outcome
4. Preserve authority across interfaces: browser, CLI, and MCP workflows must respect the same backend selection and change safeguards
5. Make operational workflows accessible: an operator must be able to understand status and complete tasks without relying on a pointer or color alone

## Accessibility & Inclusion

WCAG 2.2 AA and complete keyboard workflows are product requirements. Preserve semantic structure, accessible control names, visible focus, usable dialog navigation, and programmatic status and error feedback. Dense comparisons and long resource identifiers must remain understandable at supported viewport sizes and zoom levels.

These are requirements for future work, not a claim that the existing interface has passed a complete conformance audit. Any such claim requires verification of the relevant workflows and states.
