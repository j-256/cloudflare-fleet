import assert from "node:assert/strict"
import test from "node:test"

import {
  buildFleetAudit,
  FLEET_AUDIT_SCHEMA_VERSION,
  renderFleetAuditHtml,
  renderFleetAuditMarkdown,
} from "../src/audit-report.mjs"
import { SURFACES } from "../src/constants.mjs"
import { createEmptyFleetIntentDocument } from "../src/fleet-intent.mjs"
import {
  makeInventory,
  makeZone,
  ok,
} from "./fixtures.mjs"

const NOW = Date.parse("2026-08-09T18:00:00.000Z")

function completeSurfaces(zone) {
  const defaults = {
    "certificate-packs": [{ status: "active" }],
    dnssec: { status: "disabled" },
    "universal-ssl": { enabled: true },
  }
  for (const surface of SURFACES) {
    if (zone.surfaces[surface.id]) continue
    zone.surfaces[surface.id] = ok(defaults[surface.id] ?? [])
  }
  return zone
}

test("fleet audit detects stalled DNSSEC and concrete cleanup candidates", () => {
  const duplicateRecord = {
    content: "192.0.2.1",
    name: "alpha.example",
    proxied: true,
    ttl: 300,
    type: "A",
  }
  const alpha = completeSurfaces(makeZone("alpha.example", {
    dns: [
      { ...duplicateRecord, id: "duplicate-one" },
      { ...duplicateRecord, id: "duplicate-two" },
      {
        content: "\"v=spf1 include:one.example -all\"",
        id: "spf-one",
        name: "alpha.example",
        ttl: 60,
        type: "TXT",
      },
      {
        content: "\"v=spf1 include:two.example -all\"",
        id: "spf-two",
        name: "alpha.example",
        ttl: 60,
        type: "TXT",
      },
    ],
    ruleDetails: [{
      ok: true,
      result: {
        id: "empty-ruleset",
        kind: "zone",
        name: "Empty response headers",
        phase: "http_response_headers_transform",
        rules: [],
      },
    }, {
      ok: true,
      result: {
        id: "redirect-ruleset",
        kind: "zone",
        name: "Dynamic redirects",
        phase: "http_request_dynamic_redirect",
        rules: [{
          description: "[ARCHIVED] Archived redirect",
          enabled: false,
          id: "disabled-rule",
          last_updated: "2025-01-01T00:00:00.000Z",
        }, {
          description: "Dormant redirect",
          enabled: false,
          id: "dormant-rule",
          last_updated: "2025-01-01T00:00:00.000Z",
        }],
      },
    }],
    settings: [{ editable: true, id: "always_use_https", value: "off" }, {
      editable: true,
      id: "min_tls_version",
      value: "1.0",
    }, {
      editable: true,
      id: "ssl",
      value: "full",
    }],
    surfaces: {
      dnssec: ok({
        modified_on: "2026-08-01T00:00:00.000Z",
        status: "pending",
      }),
      "universal-ssl": ok({ enabled: false }),
      "certificate-packs": ok([{ status: "pending_validation" }]),
    },
  }))
  const beta = completeSurfaces(makeZone("beta.example"))
  const inventory = makeInventory([alpha, beta])
  const intent = createEmptyFleetIntentDocument("account-id")
  intent.coverageExpectations.push({
    createdAt: "2026-08-01T00:00:00.000Z",
    id: "inactive-coverage",
    kind: "surface",
    observedCanonical: "{\"codes\":[1000],\"message\":null,\"status\":403}",
    reason: "The surface was unavailable",
    subjectId: "bot-management",
    subjectLabel: "Bot management",
    updatedAt: "2026-08-01T00:00:00.000Z",
    zoneId: alpha.meta.id,
    zoneName: alpha.meta.name,
  })

  const report = buildFleetAudit(inventory, {
    intent,
    now: NOW,
  })
  const ids = new Set(report.findings.map((entry) => entry.id))

  assert.equal(report.schemaVersion, FLEET_AUDIT_SCHEMA_VERSION)
  assert.equal(report.generatedAt, "2026-08-09T18:00:00.000Z")
  assert.ok(ids.has("dnssec.stalled:alpha.example"))
  assert.ok([...ids].some((id) => id.startsWith("dns.exact-duplicate:alpha.example:A:")))
  assert.ok(ids.has("dns.multiple-spf:alpha.example"))
  assert.ok(ids.has("ruleset.empty:alpha.example:empty-ruleset"))
  assert.ok(ids.has("ruleset.disabled-rules:alpha.example:redirect-ruleset"))
  assert.ok(ids.has("settings.editable-drift"))
  assert.ok(ids.has("security.legacy-edge-tls"))
  assert.ok(ids.has("security.origin-certificate-unverified"))
  assert.ok(ids.has("security.http-not-redirected"))
  const settingDrift = report.findings.find(
    (entry) => entry.id === "settings.editable-drift",
  )
  assert.deepEqual(settingDrift.zones, ["alpha.example", "beta.example"])
  const disabledRules = report.findings.find(
    (entry) => entry.id === "ruleset.disabled-rules:alpha.example:redirect-ruleset",
  )
  assert.equal(
    disabledRules.evidence.rules[0].cleanupReason,
    "archived-description",
  )
  assert.equal(
    disabledRules.evidence.rules[1].cleanupReason,
    "unchanged-over-one-year",
  )
  assert.ok(ids.has("tls.universal-disabled:alpha.example"))
  assert.ok(ids.has("tls.no-active-certificate-pack:alpha.example"))
  assert.ok(ids.has("coverage.expectations-need-review"))
  assert.ok(ids.has("coverage.unexpected:legacy-page-rules"))
})

test("fleet audit markdown keeps the machine-stable finding identifier visible", () => {
  const zone = completeSurfaces(makeZone("alpha.example", {
    surfaces: {
      dnssec: ok({
        modified_on: "2026-08-01T00:00:00.000Z",
        status: "pending",
      }),
    },
  }))
  const report = buildFleetAudit(makeInventory([zone]), {
    intent: createEmptyFleetIntentDocument("account-id"),
    now: NOW,
  })

  const markdown = renderFleetAuditMarkdown(report)

  assert.match(markdown, /^# Cloudflare Fleet audit/m)
  assert.match(markdown, /ID: `dnssec\.stalled:alpha\.example`/)
  assert.match(markdown, /Recommendation:/)
})

test("fleet audit HTML is self-contained and escapes finding evidence", () => {
  const report = {
    accountId: "account<&",
    findings: [{
      category: "DNS & TLS",
      detail: "Unsafe <script>alert(1)</script>",
      evidence: { value: "</pre><script>alert(2)</script>" },
      id: "finding<&",
      recommendation: "Review \"quoted\" input",
      severity: "warning",
      title: "Escaped <finding>",
      zones: ["alpha&beta.example"],
    }],
    generatedAt: "2026-08-09T18:00:00.000Z",
    inventoryLoadedAt: "2026-08-09T17:00:00.000Z",
    mode: "core",
    schemaVersion: FLEET_AUDIT_SCHEMA_VERSION,
    summary: {
      findings: 1,
      intent: null,
      matrix: {
        differences: 1,
        facets: 2,
      },
      severity: {
        critical: 0,
        info: 0,
        review: 0,
        warning: 1,
      },
      zones: 1,
    },
  }

  const html = renderFleetAuditHtml(report)

  assert.match(html, /^<!doctype html>/)
  assert.match(html, /Content-Security-Policy/)
  assert.match(html, /Escaped &lt;finding&gt;/)
  assert.match(html, /alpha&amp;beta\.example/)
  assert.match(html, /&lt;\/pre&gt;&lt;script&gt;alert\(2\)&lt;\/script&gt;/)
  assert.equal(html.includes("<script>alert"), false)
  assert.match(html, /<details>[\s\S]*<summary>Evidence<\/summary>/)
})

test("fleet audit flags an apex SPF record published without a DMARC policy", () => {
  const spfOnly = completeSurfaces(makeZone("spf-only.example", {
    dns: [
      {
        content: "\"v=spf1 include:_spf.google.com -all\"",
        id: "spf-only-spf",
        name: "spf-only.example",
        ttl: 60,
        type: "TXT",
      },
    ],
  }))
  const aligned = completeSurfaces(makeZone("aligned.example"))
  const report = buildFleetAudit(makeInventory([spfOnly, aligned]), { now: NOW })

  const spfWithoutDmarc = report.findings.find(
    (entry) => entry.id === "dns.spf-without-dmarc:spf-only.example",
  )
  assert.ok(spfWithoutDmarc, "expected an SPF-without-DMARC finding")
  assert.equal(spfWithoutDmarc.severity, "warning")
  assert.equal(spfWithoutDmarc.category, "DNS")
  assert.deepEqual(spfWithoutDmarc.zones, ["spf-only.example"])

  const ids = new Set(report.findings.map((entry) => entry.id))
  assert.ok(
    !ids.has("dns.spf-without-dmarc:aligned.example"),
    "a zone publishing both SPF and DMARC must not be flagged",
  )
})

test("fleet audit does not expect DMARC when a zone publishes no SPF", () => {
  const noMail = completeSurfaces(makeZone("no-mail.example", {
    dns: [
      {
        content: "192.0.2.10",
        id: "no-mail-a",
        name: "no-mail.example",
        proxied: true,
        ttl: 300,
        type: "A",
      },
    ],
  }))
  const report = buildFleetAudit(makeInventory([noMail]), { now: NOW })
  const ids = new Set(report.findings.map((entry) => entry.id))
  assert.ok(!ids.has("dns.spf-without-dmarc:no-mail.example"))
})

test("fleet audit distinguishes duplicate DNS groups that lack record identifiers", () => {
  const aRecord = (content) => ({ content, name: "dup.alpha.example", ttl: 300, type: "A" })
  const alpha = completeSurfaces(makeZone("alpha.example", {
    // Two independent duplicate pairs at the same host/type, none carrying an id
    dns: [aRecord("192.0.2.1"), aRecord("192.0.2.1"), aRecord("192.0.2.9"), aRecord("192.0.2.9")],
  }))

  // Must not crash on the finding-id collision, and must report both groups distinctly
  const report = buildFleetAudit(makeInventory([alpha]), { now: NOW })
  const dupIds = report.findings
    .map((entry) => entry.id)
    .filter((id) => id.startsWith("dns.exact-duplicate:alpha.example:A:dup.alpha.example:"))
  assert.equal(dupIds.length, 2, "expected two distinct duplicate findings")
  assert.equal(new Set(dupIds).size, 2, "duplicate finding identifiers must be unique")
})
