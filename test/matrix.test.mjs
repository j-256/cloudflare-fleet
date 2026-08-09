import assert from "node:assert/strict"
import test from "node:test"

import {
  buildMatrix,
  dnsTargetFillBatch,
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
  assert.equal(row.consensusCanonical, null)
  assert.equal(row.consensusCount, 0)
  assert.equal(row.variantCount, 2)
  assert.notEqual(
    row.variantIndexes.get(row.cells.get("alpha.example").canonical),
    0,
  )
  assert.notEqual(
    row.variantIndexes.get(row.cells.get("beta.example").canonical),
    0,
  )
  assert.deepEqual(row.cells.get("beta.example").action, {
    settingId: "always_use_https",
    type: "zone-setting",
    value: "off",
    zoneId: "zone-beta.example",
  })
  assert.equal(row.cells.get("beta.example").inspectionValue, "off")
})

test("matrix reserves variant index zero for a unique row consensus", () => {
  const inventory = makeInventory([
    makeZone("alpha.example", {
      settings: [
        {
          editable: true,
          id: "always_use_https",
          value: "off",
        },
      ],
    }),
    makeZone("beta.example"),
    makeZone("gamma.example"),
    makeZone("delta.example", { settings: [] }),
  ])

  const matrix = buildMatrix(inventory)
  const row = matrix.rows.find(
    (entry) => entry.category === "Zone settings" && entry.label === "always_use_https",
  )
  const variantCanonical = row.cells.get("alpha.example").canonical
  const consensusCanonical = row.cells.get("beta.example").canonical

  assert.equal(row.different, true)
  assert.equal(row.consensusCanonical, consensusCanonical)
  assert.equal(row.consensusCount, 2)
  assert.equal(row.variantCount, 2)
  assert.equal(row.missingCount, 1)
  assert.equal(row.variantIndexes.get(consensusCanonical), 0)
  assert.notEqual(row.variantIndexes.get(variantCanonical), 0)
})

test("matrix identifies uniform present values as the row consensus", () => {
  const matrix = buildMatrix(makeInventory([
    makeZone("alpha.example"),
    makeZone("beta.example"),
  ]))
  const row = matrix.rows.find(
    (entry) => entry.category === "Zone settings" && entry.label === "always_use_https",
  )
  const canonical = row.cells.get("alpha.example").canonical

  assert.equal(row.different, false)
  assert.equal(row.consensusCanonical, canonical)
  assert.equal(row.consensusCount, 2)
  assert.equal(row.variantCount, 1)
  assert.equal(row.variantIndexes.get(canonical), 0)
})

test("matrix preserves an explicit null setting inspection value", () => {
  const inventory = makeInventory([
    makeZone("alpha.example", {
      settings: [
        {
          editable: true,
          id: "nullable_setting",
          value: null,
        },
      ],
    }),
  ])

  const matrix = buildMatrix(inventory)
  const row = matrix.rows.find((entry) => entry.key === "nullable_setting")
  assert.equal(row.cells.get("alpha.example").inspectionValue, null)
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

test("matrix intent compares setting values independently of edit capability", () => {
  const inventory = makeInventory([
    makeZone("alpha.example", {
      settings: [
        {
          editable: true,
          id: "polish",
          value: "on",
        },
      ],
    }),
    makeZone("beta.example", {
      settings: [
        {
          editable: false,
          id: "polish",
          value: "on",
        },
      ],
    }),
  ])

  const row = buildMatrix(inventory).rows.find(
    (entry) => entry.category === "Zone settings" && entry.label === "polish",
  )
  const editableCell = row.cells.get("alpha.example")
  const unavailableCell = row.cells.get("beta.example")

  assert.notEqual(editableCell.canonical, unavailableCell.canonical)
  assert.equal(editableCell.intentCanonical, unavailableCell.intentCanonical)
})

test("DNSSEC intent compares writable status while preserving generated configuration", () => {
  const inventory = makeInventory([
    makeZone("alpha.example", {
      surfaces: {
        dnssec: ok({
          algorithm: "13",
          digest_algorithm: "SHA256",
          key_type: "ECDSAP256SHA256",
          status: "active",
        }),
      },
    }),
    makeZone("beta.example", {
      surfaces: {
        dnssec: ok({
          algorithm: "15",
          digest_algorithm: "SHA384",
          key_type: "ED25519",
          status: "pending",
        }),
      },
    }),
  ])

  const row = buildMatrix(inventory).rows.find(
    (entry) => entry.category === "DNSSEC" && entry.key === "configuration",
  )
  const alpha = row.cells.get("alpha.example")
  const beta = row.cells.get("beta.example")

  assert.equal(row.different, true)
  assert.notEqual(alpha.canonical, beta.canonical)
  assert.equal(alpha.intentCanonical, '{"status":"active"}')
  assert.equal(alpha.intentCanonical, beta.intentCanonical)
  assert.deepEqual(alpha.intentValue, { status: "active" })
  assert.deepEqual(beta.intentValue, { status: "active" })
  assert.equal(beta.inspectionValue.status, "pending")
  assert.equal(alpha.intentDisplay, "active")
  assert.notDeepEqual(alpha.inspectionValue, beta.inspectionValue)
})

test("matrix uniqueness preserves literal zone-relative values", () => {
  const inventory = makeInventory([
    makeZone("alpha.example", {
      settings: [{ editable: true, id: "custom_host", value: "alpha.example" }],
    }),
    makeZone("beta.example", {
      settings: [{ editable: true, id: "custom_host", value: "beta.example" }],
    }),
  ])

  const row = buildMatrix(inventory).rows.find(
    (entry) => entry.category === "Zone settings" && entry.label === "custom_host",
  )
  const alpha = row.cells.get("alpha.example")
  const beta = row.cells.get("beta.example")

  assert.equal(alpha.intentCanonical, beta.intentCanonical)
  assert.notEqual(alpha.uniquenessCanonical, beta.uniquenessCanonical)
  assert.equal(alpha.uniquenessCanonical, '"alpha.example"')
  assert.equal(beta.uniquenessCanonical, '"beta.example"')
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
    (entry) => entry.category === "Redirects" && entry.label === "Redirect docs",
  )
  const cell = row.cells.get("alpha.example")

  assert.equal(row.phase, "http_request_dynamic_redirect")
  assert.equal(row.labelSource, "Rule description")
  assert.equal(row.description, "When http.host eq \"{zone}\"")
  assert.deepEqual(row.redirectTypes, ["static"])
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
  assert.equal(cell.presentation.kind, "rule")
  assert.equal(cell.presentation.phase, "http_request_dynamic_redirect")
  assert.equal(cell.presentation.rule.action, "redirect")
  assert.equal(cell.presentation.rule.expression, "http.host eq \"{zone}\"")
  assert.equal(cell.presentation.redirect.target, "https://{zone}/docs")
  assert.equal(cell.presentation.redirect.targetKind, "static")
  assert.equal(cell.presentation.redirect.position, 1)
  assert.equal(cell.display, "https://{zone}/docs")
  assert.equal(cell.inspectionValue.id, "id-Redirect docs")
  assert.equal(cell.inspectionValue.expression, "http.host eq \"alpha.example\"")
  assert.equal(cell.presentation.rule.expression, "http.host eq \"{zone}\"")
  assert.deepEqual(cell.parentAction, {
    kind: "zone",
    name: "default",
    phase: "http_request_dynamic_redirect",
    rulesetId: "redirect-entrypoint",
    type: "ruleset-open",
    zoneId: "zone-alpha.example",
  })
  const parentRow = matrix.rows.find(
    (entry) => entry.category === "Rulesets"
      && entry.label === "Zone entrypoint",
  )
  assert.equal(parentRow.phase, "http_request_dynamic_redirect")
  assert.equal(parentRow.labelSource, "Ruleset kind")
  assert.deepEqual(
    parentRow.cells.get("alpha.example").workspaceAction,
    cell.parentAction,
  )
  assert.match(row.search, /dynamic redirects entrypoint/)
})

test("ruleset parent exact values include ordered editable rule fields", () => {
  const ruleset = (zoneName, securityLevel) => ({
    description: "",
    id: `config-entrypoint-${zoneName}`,
    kind: "zone",
    name: "default",
    phase: "http_config_settings",
    rules: [makeRule("exclude service", {
      action: "set_config",
      action_parameters: {
        security_level: securityLevel,
      },
      expression: `(http.host eq \"s.${zoneName}\")`,
      last_updated: "2024-03-11T23:35:27Z",
      ref: `rule-${zoneName}`,
      version: "1",
    })],
    version: "1",
  })
  const matrix = buildMatrix(makeInventory([
    makeZone("alpha.example", {
      ruleDetails: [ok(ruleset("alpha.example", "essentially_off"))],
    }),
    makeZone("beta.example", {
      ruleDetails: [ok(ruleset("beta.example", "essentially_off"))],
    }),
    makeZone("gamma.example", {
      ruleDetails: [ok(ruleset("gamma.example", "low"))],
    }),
  ]))
  const parent = matrix.rows.find(
    (entry) => entry.category === "Rulesets"
      && entry.key === "zone:http_config_settings",
  )
  const alpha = parent.cells.get("alpha.example")
  const beta = parent.cells.get("beta.example")
  const gamma = parent.cells.get("gamma.example")
  const compared = JSON.parse(alpha.intentCanonical)

  assert.equal(parent.phase, "http_config_settings")
  assert.equal(parent.variantCount, 2)
  assert.equal(parent.consensusCount, 2)
  assert.equal(parent.different, true)
  assert.equal(alpha.intentCanonical, beta.intentCanonical)
  assert.notEqual(alpha.intentCanonical, gamma.intentCanonical)
  assert.equal(Object.hasOwn(compared, "kind"), false)
  assert.equal(Object.hasOwn(compared, "name"), false)
  assert.equal(compared.description, "")
  assert.equal(compared.rules.length, 1)
  assert.equal(compared.rules[0].expression, "(http.host eq \"s.{zone}\")")
  assert.equal(compared.rules[0].action_parameters.security_level, "essentially_off")
  assert.equal(Object.hasOwn(compared, "rule_count"), false)
  assert.equal(Object.hasOwn(compared.rules[0], "id"), false)
  assert.equal(compared.rules[0].ref, "rule-{zone}")
  assert.equal(Object.hasOwn(compared.rules[0], "version"), false)
})

test("matrix aligns redirects by normalized match behavior despite name differences", () => {
  const ruleset = (zoneName, description) => ({
    id: `redirect-entrypoint-${zoneName}`,
    kind: "zone",
    name: "default",
    phase: "http_request_dynamic_redirect",
    rules: [
      makeRule(description, {
        action: "redirect",
        action_parameters: {
          from_value: {
            preserve_query_string: true,
            status_code: 302,
            target_url: {
              expression: `concat(\"https://${zoneName}\", http.request.uri.path)`,
            },
          },
        },
        expression: `http.host eq \"www.${zoneName}\"`,
        id: `redirect-${zoneName}`,
      }),
    ],
  })
  const matrix = buildMatrix(makeInventory([
    makeZone("alpha.example", {
      ruleDetails: [ok(ruleset("alpha.example", "Redirect from www to root"))],
    }),
    makeZone("beta.example", {
      ruleDetails: [ok(ruleset("beta.example", "Redirect from WWW to root"))],
    }),
  ]))
  const rows = matrix.rows.filter((entry) => entry.category === "Redirects")
  const row = rows.find(
    (entry) => entry.key.includes("http.host eq \"www.{zone}\""),
  )

  assert.equal(rows.length, 1)
  assert.equal(row.presentCount, 2)
  assert.equal(row.different, true)
  assert.deepEqual(row.redirectTypes, ["dynamic"])
  assert.equal(
    row.cells.get("beta.example").presentation.redirect.target,
    "concat(\"https://{zone}\", http.request.uri.path)",
  )
})

test("matrix preserves duplicate redirects with the same match expression", () => {
  const ruleset = {
    id: "redirect-entrypoint",
    kind: "zone",
    name: "default",
    phase: "http_request_dynamic_redirect",
    rules: [
      makeRule("First redirect", {
        action: "redirect",
        action_parameters: {
          from_value: {
            preserve_query_string: false,
            status_code: 301,
            target_url: { value: "https://alpha.example/first" },
          },
        },
        expression: "http.request.uri.path eq \"/old\"",
        id: "first-redirect",
      }),
      makeRule("Second redirect", {
        action: "redirect",
        action_parameters: {
          from_value: {
            preserve_query_string: false,
            status_code: 302,
            target_url: { value: "https://alpha.example/second" },
          },
        },
        expression: "http.request.uri.path eq \"/old\"",
        id: "second-redirect",
      }),
    ],
  }
  const matrix = buildMatrix(makeInventory([
    makeZone("alpha.example", {
      ruleDetails: [ok(ruleset)],
    }),
  ]))
  const rows = matrix.rows.filter((entry) => entry.category === "Redirects")

  assert.equal(rows.length, 2)
  assert.deepEqual(
    rows.map((row) => [...row.cells.values()][0].action.ruleId).sort(),
    ["first-redirect", "second-redirect"],
  )
})

test("matrix treats redirect order as behavioral drift", () => {
  const redirect = makeRule("Redirect docs", {
    action: "redirect",
    action_parameters: {
      from_value: {
        preserve_query_string: true,
        status_code: 302,
        target_url: { value: "https://example.com/docs" },
      },
    },
    expression: "http.request.uri.path eq \"/docs\"",
    id: "redirect-docs",
  })
  const ruleset = (rules) => ({
    id: "redirect-entrypoint",
    kind: "zone",
    name: "default",
    phase: "http_request_dynamic_redirect",
    rules,
  })
  const matrix = buildMatrix(makeInventory([
    makeZone("alpha.example", {
      ruleDetails: [ok(ruleset([redirect]))],
    }),
    makeZone("beta.example", {
      ruleDetails: [ok(ruleset([
        makeRule("Earlier rule", { id: "earlier-rule" }),
        redirect,
      ]))],
    }),
  ]))
  const row = matrix.rows.find(
    (entry) => entry.category === "Redirects" && entry.label === "Redirect docs",
  )

  assert.equal(row.different, true)
  assert.equal(row.cells.get("alpha.example").presentation.redirect.position, 1)
  assert.equal(row.cells.get("beta.example").presentation.redirect.position, 2)
  assert.equal(
    row.cells.get("alpha.example").resolutionCanonical,
    row.cells.get("beta.example").resolutionCanonical,
  )
})

test("matrix exposes managed rulesets as individual workspaces", () => {
  const matrix = buildMatrix(makeInventory([
    makeZone("alpha.example", {
      rulesets: [
        {
          id: "managed-firewall",
          kind: "managed",
          name: "Cloudflare Managed Free Ruleset",
          phase: "http_request_firewall_managed",
          version: "12",
        },
        {
          id: "managed-normalization",
          kind: "managed",
          name: "Cloudflare Normalization Ruleset",
          phase: "http_request_sanitize",
          version: "7",
        },
      ],
    }),
  ]))
  const managedRows = matrix.rows.filter(
    (entry) => entry.category === "Rulesets"
      && entry.key.startsWith("managed:"),
  )

  assert.deepEqual(
    managedRows.map((row) => row.label).sort(),
    [
      "Cloudflare Managed Free Ruleset",
      "Cloudflare Normalization Ruleset",
    ],
  )
  assert.deepEqual(
    managedRows[0].cells.get("alpha.example").workspaceAction.type,
    "ruleset-open",
  )
  assert.equal(managedRows[0].labelSource, "Ruleset name")
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
  assert.match(row.search, /request sanitization entrypoint/)
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
  assert.equal(row.labelSource, "Generated fallback")
  assert.equal(row.description, "Action: execute")
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
    "Action: block / Action: skip",
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
  assert.deepEqual(
    dnsTargetFillBatch(row, inventory, new Set(["zone-beta.example"])),
    {
      available: true,
      candidate: row.missingResolutions.get("beta.example").candidates[0],
      reason: "",
      targetZoneIds: ["zone-beta.example"],
      targetZoneNames: ["beta.example"],
    },
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
  const inventory = makeInventory([
    makeZone("alpha.example", {
      dns: [dnsRecord("alpha.example", "192.0.2.1")],
    }),
    makeZone("beta.example", {
      dns: [dnsRecord("beta.example", "192.0.2.2")],
    }),
    makeZone("gamma.example", {
      dns: [],
    }),
  ])
  const matrix = buildMatrix(inventory)
  const row = matrix.rows.find(
    (entry) => entry.category === "DNS records" && entry.label === "A @",
  )
  const resolution = row.missingResolutions.get("gamma.example")

  assert.equal(resolution.available, true)
  assert.equal(resolution.candidates.length, 2)
  assert.equal(resolution.recommendedCandidateId, null)
  assert.match(
    dnsTargetFillBatch(row, inventory, new Set(["zone-gamma.example"])).reason,
    /Multiple fleet variants are tied/,
  )
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
    (entry) => entry.category === "Redirects" && entry.label === "Redirect docs",
  )
  const resolution = row.missingResolutions.get("beta.example")

  assert.equal(resolution.available, true)
  assert.equal(resolution.kind, "ruleset-rule-copy")
  assert.equal(resolution.candidates[0].sourceZoneName, "alpha.example")
  assert.equal(resolution.candidates[0].presentation.kind, "rule")
})

test("matrix exposes API-managed Email Routing rules as direct edits", () => {
  const route = (zoneName, source = "api") => ({
    actions: [
      {
        type: "worker",
        value: ["email-worker"],
      },
    ],
    enabled: true,
    id: `route-${zoneName}`,
    matchers: [
      {
        field: "to",
        type: "literal",
        value: `worker@${zoneName}`,
      },
    ],
    name: "Worker route",
    priority: 0,
    source,
  })
  const matrix = buildMatrix(makeInventory([
    makeZone("alpha.example", {
      catchAll: {
        id: "catch-all-alpha",
        source: "api",
      },
      emailRules: [route("alpha.example")],
    }),
    makeZone("beta.example", {
      emailRules: [route("beta.example", "wrangler")],
    }),
  ]))
  const routeRow = matrix.rows.find(
    (row) => row.category === "Email routes" && row.label === "Worker route",
  )
  const catchAllRow = matrix.rows.find(
    (row) => row.category === "Email" && row.label === "Catch-all rule",
  )

  assert.deepEqual(routeRow.cells.get("alpha.example").action, {
    catchAll: false,
    ruleId: "route-alpha.example",
    ruleIdentifier: "route-alpha.example",
    type: "email-routing-rule",
    zoneId: "zone-alpha.example",
  })
  assert.equal(routeRow.cells.get("beta.example").action, null)
  assert.match(
    routeRow.cells.get("beta.example").capability.reason,
    /Wrangler owns this route/,
  )
  assert.deepEqual(catchAllRow.cells.get("alpha.example").action, {
    catchAll: true,
    ruleId: "catch-all-alpha",
    ruleIdentifier: "catch_all",
    type: "email-routing-rule",
    zoneId: "zone-alpha.example",
  })
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
  assert.deepEqual(cell.inspectionValue, [
    {
      content: "192.0.2.1",
      proxied: true,
      ttl: 1,
    },
  ])
  assert.deepEqual(row.missingZoneIds, [])
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

test("matrix ignores Cloudflare-assigned Email Routing MX priorities for drift", () => {
  const routingMx = (zoneName, priorities, options = {}) => [
    "route1.mx.cloudflare.net",
    "route2.mx.cloudflare.net",
    "route3.mx.cloudflare.net",
  ].map((content, index) => ({
    content: options.trailingDot ? `${content}.` : content,
    id: options.includeIds ? `mx-${zoneName}-${index + 1}` : undefined,
    locked: false,
    name: zoneName,
    priority: priorities[index],
    ttl: 1,
    type: "MX",
  }))
  const matrix = buildMatrix(makeInventory([
    makeZone("alpha.example", {
      dns: routingMx("alpha.example", [95, 46, 23], {
        includeIds: true,
      }),
      emailDns: routingMx("alpha.example", [95, 46, 23], {
        trailingDot: true,
      }),
    }),
    makeZone("beta.example", {
      dns: routingMx("beta.example", [17, 81, 42], {
        includeIds: true,
      }),
      emailDns: routingMx("beta.example", [17, 81, 42], {
        trailingDot: true,
      }),
    }),
  ]))
  const specification = matrix.rows.find(
    (row) => row.category === "Email DNS specification" && row.label === "MX @",
  )
  const records = matrix.rows.find(
    (row) => row.category === "DNS records" && row.label === "MX @",
  )
  const alphaRecords = records.cells.get("alpha.example")
  const betaRecords = records.cells.get("beta.example")

  assert.equal(specification.different, false)
  assert.equal(records.different, false)
  assert.match(specification.description, /priorities are ignored for drift/)
  assert.match(records.description, /priorities are ignored for drift/)
  assert.equal(alphaRecords.canonical, betaRecords.canonical)
  assert.notEqual(
    alphaRecords.resolutionCanonical,
    betaRecords.resolutionCanonical,
  )
  assert.deepEqual(
    alphaRecords.inspectionValue.map((record) => record.priority).sort(
      (left, right) => left - right,
    ),
    [23, 46, 95],
  )
})

test("matrix preserves ordinary MX priority differences as drift", () => {
  const customMx = (zoneName, priority) => ({
    content: "mail.example.net",
    id: `custom-mx-${zoneName}`,
    locked: false,
    name: zoneName,
    priority,
    ttl: 1,
    type: "MX",
  })
  const matrix = buildMatrix(makeInventory([
    makeZone("alpha.example", {
      dns: [customMx("alpha.example", 10)],
    }),
    makeZone("beta.example", {
      dns: [customMx("beta.example", 20)],
    }),
  ]))
  const row = matrix.rows.find(
    (entry) => entry.category === "DNS records" && entry.label === "MX @",
  )

  assert.equal(row.different, true)
  assert.equal(row.description, "")
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
