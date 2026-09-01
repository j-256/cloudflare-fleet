import assert from "node:assert/strict"
import test from "node:test"

import { buildFleetAudit } from "../src/audit-report.mjs"
import {
  assessIntentAlignment,
  buildIntentAlignmentPlans,
  intentAlignmentReadRequirement,
} from "../src/intent-alignment.mjs"
import {
  createAuthoredFleetIntentExpected,
  createEmptyFleetIntentDocument,
  evaluateFleetIntent,
  fleetIntentFacetId,
  replaceFleetIntentGroup,
  replaceFleetIntentPolicy,
} from "../src/fleet-intent.mjs"
import { buildMatrix } from "../src/matrix.mjs"
import {
  buildZoneAliasRedirectRule,
  createZoneAliasIntentValue,
  ZONE_ALIAS_CATEGORY,
  ZONE_ALIAS_KEY,
  ZONE_ALIAS_REDIRECT_PHASE,
  zoneAliasMatrixFacet,
} from "../src/zone-alias-intent.mjs"
import {
  makeInventory,
  makeZone,
  ok,
} from "./fixtures.mjs"

function servingDns(zoneName, extra = []) {
  return [
    {
      content: "255.255.255.255",
      id: `apex-${zoneName}`,
      name: zoneName,
      proxied: true,
      ttl: 1,
      type: "A",
    },
    {
      content: "255.255.255.255",
      id: `wildcard-${zoneName}`,
      name: `*.${zoneName}`,
      proxied: true,
      ttl: 1,
      type: "A",
    },
    ...extra,
  ]
}

function aliasZone(sourceHost, desired, options = {}) {
  const rule = {
    id: `alias-rule-${sourceHost}`,
    ...buildZoneAliasRedirectRule(sourceHost, desired),
    ...options.rule,
  }
  const ruleset = {
    id: `redirect-ruleset-${sourceHost}`,
    kind: "zone",
    name: "default",
    phase: ZONE_ALIAS_REDIRECT_PHASE,
    rules: [rule, ...(options.extraRules || [])],
  }
  return makeZone(sourceHost, {
    dns: servingDns(sourceHost, options.extraDns),
    ruleDetails: [ok(ruleset), ...(options.ruleDetails || [])],
    rulesets: [
      {
        id: ruleset.id,
        kind: ruleset.kind,
        name: ruleset.name,
        phase: ruleset.phase,
      },
      ...(options.rulesets || []),
    ],
    workerRoutes: options.workerRoutes,
  })
}

function aliasIntent(inventory, zone, desired) {
  let document = createEmptyFleetIntentDocument(inventory.account.id)
  const group = {
    id: `alias-${zone.meta.name.replaceAll(".", "-")}`,
    members: [{ zoneId: zone.meta.id, zoneName: zone.meta.name }],
    mode: "members",
    name: `${zone.meta.name} alias`,
    nameSource: "custom",
  }
  document = replaceFleetIntentGroup(document, group)
  document = replaceFleetIntentPolicy(document, {
    expected: createAuthoredFleetIntentExpected(desired),
    facet: zoneAliasMatrixFacet(),
    groupId: group.id,
    id: `policy-${group.id}`,
    presenceConstraint: "required",
    valueConstraint: "exact",
  })
  return document
}

function evaluatedAlias(inventory, intent) {
  const matrix = buildMatrix(inventory)
  const evaluation = evaluateFleetIntent(intent, inventory, matrix)
  const row = matrix.rows.find((entry) => (
    entry.category === ZONE_ALIAS_CATEGORY && entry.key === ZONE_ALIAS_KEY
  ))
  return {
    evaluation,
    row: {
      ...row,
      intentState: evaluation.rowStates.get(
        fleetIntentFacetId(ZONE_ALIAS_CATEGORY, ZONE_ALIAS_KEY),
      ),
    },
  }
}

test("healthy canonical aliases share one reusable intent model", () => {
  const definitions = [
    ["j256.dev", "j-256.dev", 307],
    ["strangelaser.com", "strangelasers.com", 308],
    ["strangelasers.net", "strangelasers.com", 307],
  ]
  for (const [sourceHost, targetHost, statusCode] of definitions) {
    const desired = createZoneAliasIntentValue({ statusCode, targetHost })
    const zone = aliasZone(sourceHost, desired)
    const inventory = makeInventory([zone])
    const intent = aliasIntent(inventory, zone, desired)
    const { evaluation, row } = evaluatedAlias(inventory, intent)

    assert.equal(evaluation.summary.actionableCells, 0, sourceHost)
    assert.equal(row.cells.get(sourceHost).intentCanonical, intent.policies[0].expected.canonical)
    assert.deepEqual(row.cells.get(sourceHost).intentValue.unexpectedResources, [])
    assert.deepEqual(row.cells.get(sourceHost).intentValue.unreadSurfaces, [])
  }
})

test("canonical alias posture is opt-in intent instead of fleet-wide adoption noise", () => {
  const desired = createZoneAliasIntentValue({
    statusCode: 307,
    targetHost: "j-256.dev",
  })
  const alias = aliasZone("j256.dev", desired)
  const application = makeZone("application.example", {
    dns: servingDns("application.example", [{
      content: "192.0.2.20",
      id: "application-origin",
      name: "www.application.example",
      proxied: true,
      ttl: 1,
      type: "A",
    }]),
  })
  const inventory = makeInventory([alias, application])
  const matrix = buildMatrix(inventory)
  const evaluation = evaluateFleetIntent(
    createEmptyFleetIntentDocument(inventory.account.id),
    inventory,
    matrix,
  )
  const row = matrix.rows.find((entry) => entry.category === ZONE_ALIAS_CATEGORY)
  const rowState = evaluation.rowStates.get(
    fleetIntentFacetId(ZONE_ALIAS_CATEGORY, ZONE_ALIAS_KEY),
  )

  assert.equal(row.different, true)
  assert.equal(rowState.actionable, false)
})

test("every canonical redirect behavior dimension produces actionable drift", () => {
  const desired = createZoneAliasIntentValue({
    statusCode: 308,
    targetHost: "strangelasers.com",
  })
  const variants = [
    { statusCode: 307 },
    { targetHost: "other.example" },
    { preservePath: false },
    { preserveQuery: false },
    { preserveSubdomains: false },
    { includeSubdomains: false, preserveSubdomains: false },
  ]
  for (const override of variants) {
    const observed = createZoneAliasIntentValue({
      ...desired.redirect,
      ...override,
      servingWildcard: true,
    })
    const zone = aliasZone("strangelaser.com", observed)
    const inventory = makeInventory([zone])
    const intent = aliasIntent(inventory, zone, desired)
    const { evaluation } = evaluatedAlias(inventory, intent)
    assert.equal(evaluation.summary.actionableCells, 1, JSON.stringify(override))
  }
})

test("redirect drift produces one reversible rule edit after alias-scoped reads", () => {
  const desired = createZoneAliasIntentValue({
    statusCode: 307,
    targetHost: "j-256.dev",
  })
  const observed = createZoneAliasIntentValue({
    statusCode: 302,
    targetHost: "j-256.dev",
  })
  const zone = aliasZone("j256.dev", observed)
  const inventory = makeInventory([zone])
  const intent = aliasIntent(inventory, zone, desired)
  const { row } = evaluatedAlias(inventory, intent)
  const requirement = intentAlignmentReadRequirement(row)
  const assessment = assessIntentAlignment(row)
  const plans = buildIntentAlignmentPlans(inventory, row, assessment)

  assert.equal(assessment.available, true)
  assert.deepEqual(requirement.accountSurfaceIds, [
    "pages-projects",
    "worker-custom-domains",
  ])
  assert.equal(requirement.includeRuleDetails, true)
  assert.deepEqual(requirement.surfaceIds, [
    "custom-hostnames",
    "dns",
    "healthchecks",
    "load-balancers",
    "rulesets",
    "snippets",
    "waiting-rooms",
    "web3",
    "workers-routes",
  ])
  assert.equal(plans[0].operations.length, 1)
  assert.equal(plans[0].operations[0].method, "PATCH")
  assert.equal(
    plans[0].operations[0].body.action_parameters.from_value.status_code,
    307,
  )
})

test("shared security rules remain inside the allowed resource envelope", () => {
  const desired = createZoneAliasIntentValue({
    statusCode: 307,
    targetHost: "j-256.dev",
  })
  const wafRuleset = {
    id: "shared-waf",
    kind: "zone",
    name: "default",
    phase: "http_request_firewall_custom",
    rules: [{
      action: "block",
      enabled: true,
      expression: "cf.client.bot",
      id: "shared-bot-rule",
    }],
  }
  const zone = aliasZone("j256.dev", desired, {
    ruleDetails: [ok(wafRuleset)],
    rulesets: [{
      id: wafRuleset.id,
      kind: wafRuleset.kind,
      name: wafRuleset.name,
      phase: wafRuleset.phase,
    }],
  })
  const inventory = makeInventory([zone])
  const intent = aliasIntent(inventory, zone, desired)
  const { evaluation, row } = evaluatedAlias(inventory, intent)

  assert.equal(evaluation.summary.actionableCells, 0)
  assert.deepEqual(row.cells.get(zone.meta.name).intentValue.unexpectedResources, [])
})

test("Cloudflare-managed rulesets remain inside the allowed resource envelope", () => {
  const desired = createZoneAliasIntentValue({
    statusCode: 307,
    targetHost: "j-256.dev",
  })
  const managedRuleset = {
    id: "managed-transform",
    kind: "managed",
    name: "Cloudflare Managed Transforms",
    phase: "http_request_transform",
  }
  const zone = aliasZone("j256.dev", desired, {
    rulesets: [managedRuleset],
  })
  const inventory = makeInventory([zone])
  const intent = aliasIntent(inventory, zone, desired)
  const { evaluation, row } = evaluatedAlias(inventory, intent)

  assert.equal(evaluation.summary.actionableCells, 0)
  assert.deepEqual(row.cells.get(zone.meta.name).intentValue.unexpectedResources, [])
})

test("mail and ownership DNS remain inside the allowed resource envelope", () => {
  const desired = createZoneAliasIntentValue({
    statusCode: 307,
    targetHost: "j-256.dev",
  })
  const zone = aliasZone("j256.dev", desired, {
    extraDns: [
      {
        content: "mail.j256.dev",
        id: "mail-exchanger",
        name: "j256.dev",
        priority: 10,
        ttl: 300,
        type: "MX",
      },
      {
        content: "192.0.2.25",
        id: "mail-address",
        name: "mail.j256.dev",
        proxied: false,
        ttl: 300,
        type: "A",
      },
      {
        content: "validation.example.net",
        id: "acme-validation",
        name: "_acme-challenge.j256.dev",
        proxied: false,
        ttl: 300,
        type: "CNAME",
      },
    ],
  })
  const inventory = makeInventory([zone])
  const intent = aliasIntent(inventory, zone, desired)
  const { evaluation, row } = evaluatedAlias(inventory, intent)

  assert.equal(evaluation.summary.actionableCells, 0)
  assert.deepEqual(row.cells.get(zone.meta.name).intentValue.unexpectedResources, [])
})

test("extra redirect and service behavior receive distinct canonical-owner findings", () => {
  const desired = createZoneAliasIntentValue({
    statusCode: 307,
    targetHost: "j-256.dev",
  })
  const zone = aliasZone("j256.dev", desired, {
    extraRules: [{
      action: "redirect",
      action_parameters: {
        from_value: {
          preserve_query_string: true,
          status_code: 302,
          target_url: { value: "https://elsewhere.example" },
        },
      },
      enabled: true,
      expression: "http.request.uri.path eq \"/short\"",
      id: "short-link",
    }],
    workerRoutes: [{
      id: "route-id",
      pattern: "j256.dev/app/*",
      script: "independent-app",
    }],
  })
  const inventory = makeInventory([zone], {
    pagesProjects: [{
      domains: ["site.j256.dev"],
      name: "independent-pages",
    }],
  })
  const intent = aliasIntent(inventory, zone, desired)
  const report = buildFleetAudit(inventory, { intent })
  const aliasFindings = report.findings.filter(
    (finding) => finding.id.startsWith("alias.unexpected:"),
  )

  assert.equal(aliasFindings.length, 3)
  assert.equal(aliasFindings.every(
    (finding) => finding.evidence.canonicalOwner === "j-256.dev",
  ), true)
  assert.deepEqual(
    aliasFindings.map((finding) => finding.evidence.resource.kind).sort(),
    ["pages-domain", "redirect-rule", "worker-route"],
  )
})

test("reversible alias cleanup deletes only extra DNS and rules", () => {
  const desired = createZoneAliasIntentValue({
    statusCode: 307,
    targetHost: "j-256.dev",
  })
  const zone = aliasZone("j256.dev", desired, {
    extraDns: [{
      content: "192.0.2.10",
      id: "independent-app-dns",
      name: "app.j256.dev",
      proxied: true,
      ttl: 1,
      type: "A",
    }],
    extraRules: [{
      action: "redirect",
      action_parameters: {
        from_value: {
          preserve_query_string: true,
          status_code: 302,
          target_url: { value: "https://elsewhere.example" },
        },
      },
      enabled: true,
      expression: "http.request.uri.path eq \"/short\"",
      id: "short-link",
    }],
  })
  const inventory = makeInventory([zone])
  const intent = aliasIntent(inventory, zone, desired)
  const { row } = evaluatedAlias(inventory, intent)
  const assessment = assessIntentAlignment(row)
  const plans = buildIntentAlignmentPlans(inventory, row, assessment)
  const operations = plans[0].operations

  assert.equal(assessment.available, true)
  assert.deepEqual(operations.map((operation) => operation.path).sort(), [
    `zones/${zone.meta.id}/dns_records/independent-app-dns`,
    `zones/${zone.meta.id}/rulesets/redirect-ruleset-j256.dev/rules/short-link`,
  ])
  assert.equal(operations.every((operation) => operation.method === "DELETE"), true)
  assert.equal(operations.some((operation) => (
    operation.path.includes("apex-j256.dev")
      || operation.path.includes("wildcard-j256.dev")
      || operation.path.includes("alias-rule-j256.dev")
  )), false)
})

test("unsupported or unread alias evidence blocks the complete remediation", () => {
  const desired = createZoneAliasIntentValue({
    statusCode: 307,
    targetHost: "j-256.dev",
  })
  const unsupportedZone = aliasZone("j256.dev", desired, {
    workerRoutes: [{
      id: "route-id",
      pattern: "j256.dev/*",
      script: "app",
    }],
  })
  const unsupportedInventory = makeInventory([unsupportedZone])
  const unsupportedIntent = aliasIntent(
    unsupportedInventory,
    unsupportedZone,
    desired,
  )
  const unsupported = assessIntentAlignment(
    evaluatedAlias(unsupportedInventory, unsupportedIntent).row,
  )
  assert.equal(unsupported.available, false)
  assert.match(unsupported.reason, /unsupported resources/)

  const unreadZone = aliasZone("j256.dev", desired, {
    workerRoutes: [],
  })
  unreadZone.surfaces["workers-routes"] = {
    error: { message: "permission denied", status: 403 },
    ok: false,
    result: null,
  }
  const unreadInventory = makeInventory([unreadZone])
  const unreadIntent = aliasIntent(unreadInventory, unreadZone, desired)
  const unread = assessIntentAlignment(
    evaluatedAlias(unreadInventory, unreadIntent).row,
  )
  assert.equal(unread.available, false)
  assert.match(unread.reason, /readable surfaces: workers-routes/)
})

test("alias policy validation prevents weakening the exact empty envelope", () => {
  const desired = createZoneAliasIntentValue({
    statusCode: 307,
    targetHost: "j-256.dev",
  })
  const zone = aliasZone("j256.dev", desired)
  const inventory = makeInventory([zone])
  const document = aliasIntent(inventory, zone, desired)
  const weakened = structuredClone(document.policies[0])
  weakened.valueConstraint = "may-differ"
  weakened.expected = null

  assert.throws(
    () => replaceFleetIntentPolicy(document, weakened),
    /policy is invalid/,
  )

  const expanded = structuredClone(document.policies[0])
  expanded.expected.value.unexpectedResources = [{ kind: "worker-route" }]
  assert.throws(
    () => replaceFleetIntentPolicy(document, expanded),
    /policy is invalid/,
  )
})
