import assert from "node:assert/strict"
import test from "node:test"

import {
  buildMatrix,
  matrixRenderKey,
} from "../src/matrix.mjs"
import {
  makeInventory,
  makeRule,
  makeZone,
  ok,
} from "./fixtures.mjs"

test("matrix marks divergent settings and exposes editable actions", () => {
  const inventory = makeInventory([
    makeZone("alpha.example"),
    makeZone("beta.example", {
      settings: [
        {
          editable: true,
          id: "always_use_https",
          value: "off",
        },
      ],
    }),
  ])

  const matrix = buildMatrix(inventory)
  const row = matrix.rows.find(
    (entry) => entry.category === "Zone settings" && entry.label === "always_use_https",
  )

  assert.equal(row.different, true)
  assert.equal(row.missingCount, 0)
  assert.equal(row.cells.get("alpha.example").display, "on")
  assert.deepEqual(row.cells.get("beta.example").action, {
    settingId: "always_use_https",
    type: "zone-setting",
    value: "off",
    zoneId: "zone-beta.example",
  })
})

test("matrix distinguishes direct setting edits from unavailable direct edits", () => {
  const inventory = makeInventory([
    makeZone("alpha.example", {
      settings: [
        {
          editable: false,
          id: "polish",
          value: "off",
        },
      ],
    }),
  ])

  const matrix = buildMatrix(inventory)
  const row = matrix.rows.find(
    (entry) => entry.category === "Zone settings" && entry.label === "polish",
  )
  const cell = row.cells.get("alpha.example")

  assert.equal(cell.action, null)
  assert.deepEqual(cell.capability, {
    kind: "not-directly-editable",
    label: "No direct setting edit",
    reason: "Cloudflare reports editable=false for this zone setting; another product API may still configure equivalent behavior",
  })
})

test("matrix leads with rule names and separates direct edits from copying", () => {
  const ruleset = {
    id: "redirect-entrypoint",
    kind: "zone",
    name: "default",
    phase: "http_request_dynamic_redirect",
    rules: [
      makeRule("Redirect docs", {
        action: "redirect",
        action_parameters: {
          from_value: {
            preserve_query_string: true,
            status_code: 301,
            target_url: {
              value: "https://alpha.example/docs",
            },
          },
        },
        expression: "http.host eq \"alpha.example\"",
      }),
    ],
  }
  const inventory = makeInventory([
    makeZone("alpha.example", {
      ruleDetails: [ok(ruleset)],
    }),
  ])

  const matrix = buildMatrix(inventory)
  const row = matrix.rows.find(
    (entry) => entry.category === "Ruleset rules" && entry.label === "Redirect docs",
  )
  const cell = row.cells.get("alpha.example")

  assert.equal(row.description, "redirect | http_request_dynamic_redirect")
  assert.deepEqual(cell.action, {
    phase: "http_request_dynamic_redirect",
    ruleId: "id-Redirect docs",
    rulesetId: "redirect-entrypoint",
    type: "ruleset-rule",
    zoneId: "zone-alpha.example",
  })
  assert.deepEqual(cell.secondaryAction, {
    phase: "http_request_dynamic_redirect",
    ruleId: "id-Redirect docs",
    rulesetId: "redirect-entrypoint",
    sourceZoneId: "zone-alpha.example",
    type: "ruleset-rule-copy",
  })
  assert.deepEqual(cell.capability, {
    kind: "copy-to-zones",
    label: "Copy to selected zones",
    reason: "Self-contained zone entrypoint rule",
  })
})

test("matrix exposes dependency-backed rules for editing but not copying", () => {
  const ruleset = {
    id: "sanitize-entrypoint",
    kind: "zone",
    name: "default",
    phase: "http_request_sanitize",
    rules: [
      makeRule("Run sanitizer", {
        action: "execute",
        action_parameters: {
          id: "managed-ruleset-id",
        },
        expression: "true",
      }),
    ],
  }
  const inventory = makeInventory([
    makeZone("alpha.example", {
      ruleDetails: [ok(ruleset)],
    }),
  ])

  const matrix = buildMatrix(inventory)
  const row = matrix.rows.find(
    (entry) => entry.category === "Ruleset rules" && entry.label === "Run sanitizer",
  )
  const cell = row.cells.get("alpha.example")

  assert.equal(cell.action.type, "ruleset-rule")
  assert.equal(cell.secondaryAction, null)
  assert.equal(cell.capability.kind, "not-copyable")
})

test("matrix replaces an auto-generated rule reference with a readable fallback", () => {
  const ruleset = {
    id: "sanitize-entrypoint",
    kind: "zone",
    name: "default",
    phase: "http_request_sanitize",
    rules: [
      makeRule("", {
        action: "execute",
        expression: "true",
        id: "auto-rule-id",
        ref: "auto-rule-id",
      }),
    ],
  }
  const matrix = buildMatrix(makeInventory([
    makeZone("alpha.example", {
      ruleDetails: [ok(ruleset)],
    }),
  ]))
  const row = matrix.rows.find(
    (entry) => entry.category === "Ruleset rules",
  )

  assert.equal(row.label, "execute rule 1 | true")
  assert.equal(row.description, "execute | http_request_sanitize")
})

test("matrix reports every action when a named rule differs across zones", () => {
  const phase = "http_request_firewall_custom"
  const ruleset = (action) => ({
    id: `${action}-entrypoint`,
    kind: "zone",
    name: "default",
    phase,
    rules: [
      makeRule("Shared name", {
        action,
      }),
    ],
  })
  const matrix = buildMatrix(makeInventory([
    makeZone("alpha.example", {
      ruleDetails: [ok(ruleset("block"))],
    }),
    makeZone("beta.example", {
      ruleDetails: [ok(ruleset("skip"))],
    }),
  ]))
  const row = matrix.rows.find(
    (entry) => entry.category === "Ruleset rules" && entry.label === "Shared name",
  )

  assert.equal(
    row.description,
    "block | http_request_firewall_custom / skip | http_request_firewall_custom",
  )
})

test("matrix exposes one fleet rename action for every editable rule instance in a row", () => {
  const phase = "http_request_dynamic_redirect"
  const ruleset = (zoneName) => ({
    id: `entrypoint-${zoneName}`,
    kind: "zone",
    name: "default",
    phase,
    rules: [
      makeRule(`${zoneName} docs`, {
        id: `rule-${zoneName}`,
      }),
    ],
  })
  const matrix = buildMatrix(makeInventory([
    makeZone("alpha.example", {
      ruleDetails: [ok(ruleset("alpha.example"))],
    }),
    makeZone("beta.example", {
      ruleDetails: [ok(ruleset("beta.example"))],
    }),
    makeZone("missing.example"),
  ]))
  const row = matrix.rows.find(
    (entry) => entry.category === "Ruleset rules" && entry.label === "{zone} docs",
  )

  assert.deepEqual(row.fleetAction, {
    currentName: "{zone} docs",
    missingZoneCount: 1,
    rules: [
      {
        phase,
        ruleId: "rule-alpha.example",
        rulesetId: "entrypoint-alpha.example",
        zoneId: "zone-alpha.example",
      },
      {
        phase,
        ruleId: "rule-beta.example",
        rulesetId: "entrypoint-beta.example",
        zoneId: "zone-beta.example",
      },
    ],
    type: "ruleset-rule-rename",
  })
})

test("matrix withholds fleet rename when any present rule is managed", () => {
  const phase = "http_request_firewall_managed"
  const managedRuleset = {
    id: "managed-entrypoint",
    kind: "managed",
    name: "managed",
    phase,
    rules: [
      makeRule("Managed rule"),
    ],
  }
  const matrix = buildMatrix(makeInventory([
    makeZone("alpha.example", {
      ruleDetails: [ok(managedRuleset)],
    }),
  ]))
  const row = matrix.rows.find(
    (entry) => entry.category === "Ruleset rules" && entry.label === "Managed rule",
  )

  assert.equal(row.fleetAction, null)
  assert.match(row.fleetActionReason, /not directly editable/)
})

test("matrix withholds fleet rename when one zone has duplicate rule identities", () => {
  const phase = "http_request_firewall_custom"
  const ruleset = {
    id: "entrypoint",
    kind: "zone",
    name: "default",
    phase,
    rules: [
      makeRule("Duplicate name", { id: "first-rule" }),
      makeRule("Duplicate name", { id: "second-rule" }),
    ],
  }
  const matrix = buildMatrix(makeInventory([
    makeZone("alpha.example", {
      ruleDetails: [ok(ruleset)],
    }),
  ]))
  const row = matrix.rows.find(
    (entry) => entry.category === "Ruleset rules" && entry.label === "Duplicate name",
  )

  assert.equal(row.fleetAction, null)
  assert.match(row.fleetActionReason, /Duplicate rule identities/)
})

test("matrix distinguishes holes from configuration variants", () => {
  const inventory = makeInventory([
    makeZone("alpha.example", {
      dns: [
        {
          content: "192.0.2.1",
          id: "record-id",
          name: "alpha.example",
          proxied: true,
          ttl: 1,
          type: "A",
        },
      ],
    }),
    makeZone("beta.example"),
  ])

  const matrix = buildMatrix(inventory)
  const row = matrix.rows.find(
    (entry) => entry.category === "DNS records" && entry.label === "A @",
  )

  assert.equal(row.different, true)
  assert.equal(row.missingCount, 1)
  assert.equal(row.cells.has("alpha.example"), true)
  assert.equal(row.cells.has("beta.example"), false)
  assert.equal(row.missingResolutions.get("beta.example").available, true)
  assert.equal(
    row.missingResolutions.get("beta.example").kind,
    "dns-record-copy",
  )
  assert.equal(
    row.missingResolutions.get("beta.example").recommendedCandidateId,
    "variant-1",
  )
  assert.equal(matrix.summary.missingCells > 0, true)
})

test("matrix requires a source choice when missing DNS values are tied", () => {
  const dnsRecord = (name, content) => ({
    content,
    id: `record-${name}`,
    locked: false,
    name,
    ttl: 1,
    type: "A",
  })
  const matrix = buildMatrix(makeInventory([
    makeZone("alpha.example", {
      dns: [dnsRecord("alpha.example", "192.0.2.1")],
    }),
    makeZone("beta.example", {
      dns: [dnsRecord("beta.example", "192.0.2.2")],
    }),
    makeZone("gamma.example", {
      dns: [],
    }),
  ]))
  const row = matrix.rows.find(
    (entry) => entry.category === "DNS records" && entry.label === "A @",
  )
  const resolution = row.missingResolutions.get("gamma.example")

  assert.equal(resolution.available, true)
  assert.equal(resolution.candidates.length, 2)
  assert.equal(resolution.recommendedCandidateId, null)
})

test("matrix never turns a DNS coverage failure into a fill action", () => {
  const matrix = buildMatrix(makeInventory([
    makeZone("alpha.example", {
      dns: [
        {
          content: "192.0.2.1",
          id: "record-alpha",
          locked: false,
          name: "alpha.example",
          ttl: 1,
          type: "A",
        },
      ],
    }),
    makeZone("beta.example", {
      surfaces: {
        dns: {
          error: { message: "denied" },
          ok: false,
          result: null,
          status: 403,
        },
      },
    }),
  ]))
  const row = matrix.rows.find(
    (entry) => entry.category === "DNS records" && entry.label === "A @",
  )
  const resolution = row.missingResolutions.get("beta.example")

  assert.equal(resolution.available, false)
  assert.match(resolution.reason, /not readable/)
})

test("matrix exposes a destination-owned fill for a portable missing rule", () => {
  const ruleset = {
    id: "redirect-entrypoint",
    kind: "zone",
    name: "default",
    phase: "http_request_dynamic_redirect",
    rules: [
      makeRule("Redirect docs", {
        action: "redirect",
        action_parameters: {
          from_value: {
            preserve_query_string: true,
            status_code: 301,
            target_url: {
              value: "https://alpha.example/docs",
            },
          },
        },
        expression: "http.host eq \"alpha.example\"",
      }),
    ],
  }
  const matrix = buildMatrix(makeInventory([
    makeZone("alpha.example", {
      ruleDetails: [ok(ruleset)],
      rulesets: [
        {
          id: ruleset.id,
          kind: ruleset.kind,
          phase: ruleset.phase,
        },
      ],
    }),
    makeZone("beta.example"),
  ]))
  const row = matrix.rows.find(
    (entry) => entry.category === "Ruleset rules" && entry.label === "Redirect docs",
  )
  const resolution = row.missingResolutions.get("beta.example")

  assert.equal(resolution.available, true)
  assert.equal(resolution.kind, "ruleset-rule-copy")
  assert.equal(resolution.candidates[0].sourceZoneName, "alpha.example")
})

test("matrix routes missing Email policy cells through the policy composer", () => {
  const matrix = buildMatrix(makeInventory([
    makeZone("alpha.example"),
    makeZone("beta.example", {
      surfaces: {
        email: ok({}),
      },
    }),
  ]))
  const row = matrix.rows.find(
    (entry) => entry.category === "Email" && entry.label === "enabled",
  )
  const resolution = row.missingResolutions.get("beta.example")

  assert.equal(resolution.available, true)
  assert.equal(resolution.kind, "email-policy")
  assert.equal(resolution.candidates.length, 0)
})

test("matrix exposes unlocked DNS records as direct cell edits", () => {
  const inventory = makeInventory([
    makeZone("alpha.example", {
      dns: [
        {
          content: "192.0.2.1",
          id: "record-id",
          locked: false,
          name: "alpha.example",
          proxied: true,
          ttl: 1,
          type: "A",
        },
      ],
    }),
  ])

  const matrix = buildMatrix(inventory)
  const row = matrix.rows.find(
    (entry) => entry.category === "DNS records" && entry.label === "A @",
  )
  const cell = row.cells.get("alpha.example")

  assert.deepEqual(cell.action, {
    recordIds: ["record-id"],
    type: "dns-records",
    zoneId: "zone-alpha.example",
  })
  assert.deepEqual(cell.capability, {
    kind: "direct-edit",
    label: "Direct DNS edit",
    reason: "Every matching record has a type-aware DNS Records API adapter",
  })
  assert.equal(row.presentCount, 1)
  assert.equal(row.recordType, "A")
  assert.match(row.search, /alpha\.example/)
})

test("matrix links Email DNS MX specifications to their live DNS records", () => {
  const inventory = makeInventory([
    makeZone("alpha.example", {
      dns: [
        {
          content: "route1.mx.cloudflare.net",
          id: "mx-route-1",
          locked: false,
          name: "alpha.example",
          priority: 10,
          ttl: 1,
          type: "MX",
        },
        {
          content: "unrelated verification",
          id: "unrelated-txt",
          locked: false,
          name: "alpha.example",
          ttl: 1,
          type: "TXT",
        },
      ],
      emailDns: [
        {
          content: "route1.mx.cloudflare.net.",
          name: "alpha.example",
          priority: 10,
          ttl: 1,
          type: "MX",
        },
      ],
    }),
  ])

  const matrix = buildMatrix(inventory)
  const row = matrix.rows.find(
    (entry) => entry.category === "Email DNS specification" && entry.label === "MX @",
  )
  const cell = row.cells.get("alpha.example")

  assert.deepEqual(cell.action, {
    recordIds: ["mx-route-1"],
    type: "dns-records",
    zoneId: "zone-alpha.example",
  })
  assert.equal(cell.capability.kind, "direct-edit")
})

test("matrix does not link unrelated DNS records to an Email DNS specification", () => {
  const inventory = makeInventory([
    makeZone("alpha.example", {
      dns: [
        {
          content: "unrelated verification",
          id: "unrelated-txt",
          locked: false,
          name: "alpha.example",
          ttl: 1,
          type: "TXT",
        },
      ],
      emailDns: [
        {
          content: "\"v=spf1 include:_spf.mx.cloudflare.net ~all\"",
          name: "alpha.example",
          ttl: 1,
          type: "TXT",
        },
      ],
    }),
  ])

  const matrix = buildMatrix(inventory)
  const row = matrix.rows.find(
    (entry) => entry.category === "Email DNS specification" && entry.label === "TXT @",
  )
  const cell = row.cells.get("alpha.example")

  assert.equal(cell.action, null)
  assert.match(cell.capability.reason, /no matching live DNS record/)
})

test("matrix leaves schema-unknown DNS records inspectable but not directly editable", () => {
  const inventory = makeInventory([
    makeZone("alpha.example", {
      dns: [
        {
          content: "opaque",
          id: "future-record",
          name: "alpha.example",
          ttl: 1,
          type: "FUTURE",
        },
      ],
    }),
  ])

  const matrix = buildMatrix(inventory)
  const row = matrix.rows.find(
    (entry) => entry.category === "DNS records" && entry.label === "FUTURE @",
  )
  const cell = row.cells.get("alpha.example")

  assert.equal(cell.action, null)
  assert.equal(cell.capability.kind, "not-directly-editable")
  assert.match(cell.capability.reason, /not supported by the edit adapter/)
})

test("matrix render keys ignore collection time but detect visible changes", () => {
  const cached = makeInventory([makeZone("alpha.example")])
  const refreshed = structuredClone(cached)
  refreshed.loadedAt = "2026-07-29T01:00:00Z"

  assert.equal(
    matrixRenderKey(cached, buildMatrix(cached)),
    matrixRenderKey(refreshed, buildMatrix(refreshed)),
  )

  refreshed.zones[0].surfaces.settings.result[0].value = "off"
  assert.notEqual(
    matrixRenderKey(cached, buildMatrix(cached)),
    matrixRenderKey(refreshed, buildMatrix(refreshed)),
  )
})
