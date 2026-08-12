import assert from "node:assert/strict"
import test from "node:test"

import {
  FLEET_INTENT_ALL_ZONES_GROUP_ID,
  FLEET_INTENT_CELL_STATUS,
  FLEET_INTENT_EXPECTED_ORIGIN,
  FLEET_INTENT_PRESENCE_CONSTRAINT,
  FLEET_INTENT_VALUE_CONSTRAINT,
  createAuthoredFleetIntentExpected,
  createEmptyFleetIntentDocument,
  evaluateFleetIntent,
  fleetIntentFacetId,
  replaceFleetIntentPolicy,
} from "../src/fleet-intent.mjs"
import {
  INTENT_ALIGNMENT_TARGET_KIND,
  applyIntentExpectedValue,
  assessIntentAlignment,
  buildIntentAlignmentPlans,
  intentAlignmentReadRequirement,
} from "../src/intent-alignment.mjs"
import {
  buildMatrix,
} from "../src/matrix.mjs"
import {
  facetCellComparisonValue,
} from "../src/facet-equivalence.mjs"
import {
  editableRulePayload,
} from "../src/policies.mjs"
import {
  makeInventory,
  makeRule,
  makeZone,
  ok,
} from "./fixtures.mjs"

const RULE_PHASE = "http_request_firewall_custom"

function observedExpected(row, zone) {
  const cell = row.cells.get(zone.meta.name)
  return {
    canonical: cell.intentCanonical,
    display: cell.display,
    origin: FLEET_INTENT_EXPECTED_ORIGIN.OBSERVED,
    resolutionCanonical: cell.resolutionCanonical,
    sourceZoneId: zone.meta.id,
    sourceZoneName: zone.meta.name,
    value: facetCellComparisonValue(cell),
  }
}

function policyFor(row, expected, options = {}) {
  return {
    expected,
    facet: {
      category: row.category,
      description: row.description,
      key: row.key,
      label: row.label,
      phase: row.phase || undefined,
    },
    groupId: FLEET_INTENT_ALL_ZONES_GROUP_ID,
    id: options.id || "policy-one",
    presenceConstraint: options.presenceConstraint
      || FLEET_INTENT_PRESENCE_CONSTRAINT.REQUIRED,
    valueConstraint: options.valueConstraint
      || FLEET_INTENT_VALUE_CONSTRAINT.EXACT,
  }
}

function evaluatedRow(inventory, row, policy) {
  const document = replaceFleetIntentPolicy(
    createEmptyFleetIntentDocument(inventory.account.id),
    policy,
  )
  const matrix = buildMatrix(inventory)
  const evaluation = evaluateFleetIntent(document, inventory, matrix)
  const liveRow = matrix.rows.find(
    (entry) => entry.category === row.category && entry.key === row.key,
  )
  return {
    ...liveRow,
    intentState: evaluation.rowStates.get(
      fleetIntentFacetId(liveRow.category, liveRow.key),
    ),
  }
}

function ruleset(zoneName, enabled) {
  return {
    id: `ruleset-${zoneName}`,
    kind: "zone",
    name: "default",
    phase: RULE_PHASE,
    rules: [makeRule("Protect service", {
      enabled,
      expression: `http.host eq "service.${zoneName}"`,
      id: `rule-${zoneName}`,
      ref: `protect-${zoneName}`,
    })],
  }
}

function layeredMissingRow(row, zone, policies) {
  return {
    ...row,
    intentState: {
      cells: new Map([[zone.meta.id, {
        policies,
        status: FLEET_INTENT_CELL_STATUS.MISSING,
        zone,
      }]]),
      unresolved: false,
    },
  }
}

test("exact setting intent produces one live plan for every drifting zone", () => {
  const alpha = makeZone("alpha.example")
  const bravo = makeZone("bravo.example", {
    settings: [{ editable: true, id: "always_use_https", value: "off" }],
  })
  const inventory = makeInventory([alpha, bravo])
  const matrix = buildMatrix(inventory)
  const row = matrix.rows.find((entry) => (
    entry.category === "Zone settings" && entry.key === "always_use_https"
  ))
  const governed = evaluatedRow(
    inventory,
    row,
    policyFor(row, observedExpected(row, alpha)),
  )

  const assessment = assessIntentAlignment(governed)
  const plans = buildIntentAlignmentPlans(inventory, governed, assessment)

  assert.equal(assessment.available, true)
  assert.equal(assessment.actionableCount, 1)
  assert.deepEqual(
    assessment.targets.map((entry) => [entry.kind, entry.zoneName]),
    [[INTENT_ALIGNMENT_TARGET_KIND.EDIT_SETTING, "bravo.example"]],
  )
  assert.deepEqual(plans[0].operations, [{
    body: { value: "on" },
    currentValue: "off",
    label: "Set always_use_https",
    method: "PATCH",
    path: "zones/zone-bravo.example/settings/always_use_https",
  }])
})

test("authored exact subsets change only governed rule fields", () => {
  const alphaRuleset = ruleset("alpha.example", true)
  const bravoRuleset = ruleset("bravo.example", false)
  const alpha = makeZone("alpha.example", {
    ruleDetails: [ok(alphaRuleset)],
    rulesets: [alphaRuleset],
  })
  const bravo = makeZone("bravo.example", {
    ruleDetails: [ok(bravoRuleset)],
    rulesets: [bravoRuleset],
  })
  const inventory = makeInventory([alpha, bravo])
  const matrix = buildMatrix(inventory)
  const row = matrix.rows.find((entry) => (
    entry.category === "Ruleset rules" && entry.label === "Protect service"
  ))
  const governed = evaluatedRow(
    inventory,
    row,
    policyFor(row, createAuthoredFleetIntentExpected({ enabled: true })),
  )

  const assessment = assessIntentAlignment(governed)
  const plans = buildIntentAlignmentPlans(inventory, governed, assessment)
  const body = plans[0].operations[0].body

  assert.equal(assessment.available, true)
  assert.equal(body.enabled, true)
  assert.equal(body.description, "Protect service")
  assert.equal(body.expression, 'http.host eq "service.bravo.example"')
  assert.equal(body.ref, "protect-bravo.example")
})

test("exact DNS intent edits every writable record field from live state", () => {
  const record = (zoneName, content, ttl) => ({
    content,
    id: `docs-${zoneName}`,
    name: `docs.${zoneName}`,
    proxied: false,
    ttl,
    type: "CNAME",
  })
  const alpha = makeZone("alpha.example", {
    dns: [record("alpha.example", "primary.example.net", 300)],
  })
  const bravo = makeZone("bravo.example", {
    dns: [record("bravo.example", "secondary.example.net", 120)],
  })
  const inventory = makeInventory([alpha, bravo])
  const row = buildMatrix(inventory).rows.find(
    (entry) => entry.key === "CNAME docs",
  )
  const governed = evaluatedRow(
    inventory,
    row,
    policyFor(row, observedExpected(row, alpha)),
  )

  const assessment = assessIntentAlignment(governed)
  const plans = buildIntentAlignmentPlans(inventory, governed, assessment)

  assert.equal(
    assessment.targets[0].kind,
    INTENT_ALIGNMENT_TARGET_KIND.EDIT_DNS_RECORDS,
  )
  assert.deepEqual(plans[0].operations[0].body, {
    content: "primary.example.net",
    name: "docs.bravo.example",
    proxied: false,
    ttl: 300,
    type: "CNAME",
  })
})

test("exact Email Routing intent edits API-managed rules", () => {
  const route = (zoneName, enabled) => ({
    actions: [{ type: "worker", value: ["email-worker"] }],
    enabled,
    id: `route-${zoneName}`,
    matchers: [{
      field: "to",
      type: "literal",
      value: `worker@${zoneName}`,
    }],
    name: "Worker route",
    priority: 0,
    source: "api",
  })
  const alpha = makeZone("alpha.example", {
    emailRules: [route("alpha.example", true)],
  })
  const bravo = makeZone("bravo.example", {
    emailRules: [route("bravo.example", false)],
  })
  const inventory = makeInventory([alpha, bravo])
  const row = buildMatrix(inventory).rows.find(
    (entry) => entry.category === "Email routes" && entry.label === "Worker route",
  )
  const governed = evaluatedRow(
    inventory,
    row,
    policyFor(row, observedExpected(row, alpha)),
  )

  const assessment = assessIntentAlignment(governed)
  const plans = buildIntentAlignmentPlans(inventory, governed, assessment)

  assert.equal(
    assessment.targets[0].kind,
    INTENT_ALIGNMENT_TARGET_KIND.EDIT_EMAIL_RULE,
  )
  assert.equal(plans[0].operations[0].body.enabled, true)
  assert.equal(
    plans[0].operations[0].body.matchers[0].value,
    "worker@bravo.example",
  )
})

test("exact Email Routing setting intent patches support_subaddress", () => {
  const alpha = makeZone("alpha.example")
  const bravo = makeZone("bravo.example", {
    email: { support_subaddress: false },
  })
  const inventory = makeInventory([alpha, bravo])
  const row = buildMatrix(inventory).rows.find((entry) => (
    entry.category === "Email"
      && entry.key === "settings:support_subaddress"
  ))
  const governed = evaluatedRow(
    inventory,
    row,
    policyFor(row, observedExpected(row, alpha)),
  )

  const assessment = assessIntentAlignment(governed)
  const plans = buildIntentAlignmentPlans(inventory, governed, assessment)

  assert.equal(assessment.available, true)
  assert.equal(
    assessment.targets[0].kind,
    INTENT_ALIGNMENT_TARGET_KIND.EDIT_EMAIL_SETTING,
  )
  assert.deepEqual(plans[0].operations, [{
    body: { support_subaddress: true },
    currentValue: { support_subaddress: false },
    label: "Set Email Routing support_subaddress",
    method: "PATCH",
    path: "zones/zone-bravo.example/email/routing",
  }])
  assert.deepEqual(
    intentAlignmentReadRequirement(governed).surfaceIds,
    ["email"],
  )
})

test("read-only Email Routing status intent names its blocker", () => {
  const alpha = makeZone("alpha.example")
  const bravo = makeZone("bravo.example", {
    email: { status: "misconfigured" },
  })
  const inventory = makeInventory([alpha, bravo])
  const row = buildMatrix(inventory).rows.find((entry) => (
    entry.category === "Email" && entry.key === "settings:status"
  ))
  const governed = evaluatedRow(
    inventory,
    row,
    policyFor(row, observedExpected(row, alpha)),
  )

  const assessment = assessIntentAlignment(governed)

  assert.equal(assessment.available, false)
  assert.equal(assessment.blockers.length, 1)
  assert.equal(
    assessment.blockers[0].reason,
    "Cloudflare reports Email Routing status as read-only",
  )
})

test("exact DNSSEC intent plans only the requested status", () => {
  const alpha = makeZone("alpha.example", {
    surfaces: {
      dnssec: ok({ algorithm: "13", status: "active" }),
    },
  })
  const bravo = makeZone("bravo.example", {
    surfaces: {
      dnssec: ok({ algorithm: "15", status: "disabled" }),
    },
  })
  const inventory = makeInventory([alpha, bravo])
  const row = buildMatrix(inventory).rows.find(
    (entry) => entry.category === "DNSSEC",
  )
  const governed = evaluatedRow(
    inventory,
    row,
    policyFor(row, observedExpected(row, alpha)),
  )

  const assessment = assessIntentAlignment(governed)
  const plans = buildIntentAlignmentPlans(inventory, governed, assessment)

  assert.equal(
    assessment.targets[0].kind,
    INTENT_ALIGNMENT_TARGET_KIND.SET_DNSSEC_STATUS,
  )
  assert.deepEqual(plans[0].operations[0].body, { status: "active" })
})

test("missing DNS exact intent fills from its portable observed source", () => {
  const alpha = makeZone("alpha.example", {
    dns: [{
      content: "docs-host.example.net",
      id: "docs-alpha",
      name: "docs.alpha.example",
      proxied: false,
      ttl: 300,
      type: "CNAME",
    }],
  })
  const bravo = makeZone("bravo.example", { dns: [] })
  const inventory = makeInventory([alpha, bravo])
  const matrix = buildMatrix(inventory)
  const row = matrix.rows.find((entry) => entry.key === "CNAME docs")
  const governed = evaluatedRow(
    inventory,
    row,
    policyFor(row, observedExpected(row, alpha)),
  )

  const assessment = assessIntentAlignment(governed)
  const plans = buildIntentAlignmentPlans(inventory, governed, assessment)

  assert.equal(assessment.available, true)
  assert.equal(
    assessment.targets[0].kind,
    INTENT_ALIGNMENT_TARGET_KIND.FILL_DNS_RECORDS,
  )
  assert.deepEqual(plans[0].operations[0].body, {
    content: "docs-host.example.net",
    name: "docs.bravo.example",
    proxied: false,
    ttl: 300,
    type: "CNAME",
  })
  assert.equal(plans[0].operations[0].method, "POST")
})

test("missing DNS alignment applies authored layers to the copied source", () => {
  const alpha = makeZone("alpha.example", {
    dns: [{
      content: "docs-host.example.net",
      id: "docs-alpha",
      name: "docs.alpha.example",
      proxied: false,
      ttl: 300,
      type: "CNAME",
    }],
  })
  const bravo = makeZone("bravo.example", { dns: [] })
  const inventory = makeInventory([alpha, bravo])
  const row = buildMatrix(inventory).rows.find(
    (entry) => entry.key === "CNAME docs",
  )
  const sourcePolicy = policyFor(row, observedExpected(row, alpha), {
    id: "baseline",
  })
  const refinement = policyFor(
    row,
    createAuthoredFleetIntentExpected([{ ttl: 120 }]),
    { id: "refinement" },
  )
  const governed = layeredMissingRow(
    row,
    bravo,
    [sourcePolicy, refinement],
  )

  const assessment = assessIntentAlignment(governed)
  const plans = buildIntentAlignmentPlans(inventory, governed, assessment)

  assert.equal(assessment.available, true)
  assert.equal(plans[0].operations[0].body.ttl, 120)
  assert.equal(plans[0].operations[0].body.name, "docs.bravo.example")
})

test("missing rule alignment applies authored layers inside a new entrypoint", () => {
  const alphaRuleset = ruleset("alpha.example", true)
  const alpha = makeZone("alpha.example", {
    ruleDetails: [ok(alphaRuleset)],
    rulesets: [alphaRuleset],
  })
  const bravo = makeZone("bravo.example", {
    ruleDetails: [],
    rulesets: [],
  })
  const inventory = makeInventory([alpha, bravo])
  const row = buildMatrix(inventory).rows.find(
    (entry) => entry.label === "Protect service",
  )
  const sourcePolicy = policyFor(row, observedExpected(row, alpha), {
    id: "baseline",
  })
  const refinement = policyFor(
    row,
    createAuthoredFleetIntentExpected({ enabled: false }),
    { id: "refinement" },
  )
  const governed = layeredMissingRow(
    row,
    bravo,
    [sourcePolicy, refinement],
  )

  const assessment = assessIntentAlignment(governed)
  const plans = buildIntentAlignmentPlans(inventory, governed, assessment)
  const body = plans[0].operations[0].body

  assert.equal(assessment.available, true)
  assert.equal(body.enabled, undefined)
  assert.equal(body.rules[0].enabled, false)
  assert.equal(body.rules[0].expression, 'http.host eq "service.bravo.example"')
})

test("forbidden DNS intent creates reversible deletion plans", () => {
  const zone = makeZone("alpha.example", {
    dns: [{
      content: "docs-host.example.net",
      id: "docs-alpha",
      name: "docs.alpha.example",
      proxied: false,
      ttl: 300,
      type: "CNAME",
    }],
  })
  const inventory = makeInventory([zone])
  const matrix = buildMatrix(inventory)
  const row = matrix.rows.find((entry) => entry.key === "CNAME docs")
  const governed = evaluatedRow(
    inventory,
    row,
    policyFor(row, null, {
      presenceConstraint: FLEET_INTENT_PRESENCE_CONSTRAINT.FORBIDDEN,
      valueConstraint: FLEET_INTENT_VALUE_CONSTRAINT.MAY_DIFFER,
    }),
  )

  const assessment = assessIntentAlignment(governed)
  const plans = buildIntentAlignmentPlans(inventory, governed, assessment)

  assert.equal(assessment.available, true)
  assert.equal(
    assessment.targets[0].kind,
    INTENT_ALIGNMENT_TARGET_KIND.DELETE_DNS_RECORDS,
  )
  assert.equal(plans[0].operations[0].method, "DELETE")
  assert.deepEqual(plans[0].operations[0].currentValue, {
    content: "docs-host.example.net",
    name: "docs.alpha.example",
    proxied: false,
    ttl: 300,
    type: "CNAME",
  })
})

test("forbidden rule intent creates a reversible rule deletion", () => {
  const liveRuleset = ruleset("alpha.example", true)
  const zone = makeZone("alpha.example", {
    ruleDetails: [ok(liveRuleset)],
    rulesets: [liveRuleset],
  })
  const inventory = makeInventory([zone])
  const row = buildMatrix(inventory).rows.find(
    (entry) => entry.label === "Protect service",
  )
  const governed = evaluatedRow(
    inventory,
    row,
    policyFor(row, null, {
      presenceConstraint: FLEET_INTENT_PRESENCE_CONSTRAINT.FORBIDDEN,
      valueConstraint: FLEET_INTENT_VALUE_CONSTRAINT.MAY_DIFFER,
    }),
  )

  const assessment = assessIntentAlignment(governed)
  const plans = buildIntentAlignmentPlans(inventory, governed, assessment)

  assert.equal(
    assessment.targets[0].kind,
    INTENT_ALIGNMENT_TARGET_KIND.DELETE_RULE,
  )
  assert.equal(plans[0].operations[0].method, "DELETE")
  assert.deepEqual(
    plans[0].operations[0].currentValue.rule,
    editableRulePayload(liveRuleset.rules[0]),
  )
})

test("row alignment blocks the whole batch when one drifting cell is unsupported", () => {
  const alpha = makeZone("alpha.example")
  const bravo = makeZone("bravo.example", {
    settings: [{ editable: true, id: "always_use_https", value: "off" }],
  })
  const charlie = makeZone("charlie.example", {
    settings: [{ editable: false, id: "always_use_https", value: "off" }],
  })
  const inventory = makeInventory([alpha, bravo, charlie])
  const matrix = buildMatrix(inventory)
  const row = matrix.rows.find((entry) => entry.key === "always_use_https")
  const governed = evaluatedRow(
    inventory,
    row,
    policyFor(row, observedExpected(row, alpha)),
  )

  const assessment = assessIntentAlignment(governed)

  assert.equal(assessment.available, false)
  assert.equal(assessment.targets.length, 1)
  assert.equal(assessment.blockers.length, 1)
  assert.match(assessment.reason, /charlie\.example/)
  assert.throws(
    () => buildIntentAlignmentPlans(inventory, governed, assessment),
    /Complete alignment is blocked/,
  )
})

test("expected subsets preserve fields outside the intent comparison", () => {
  assert.deepEqual(
    applyIntentExpectedValue(
      {
        action: "block",
        action_parameters: { response: { status_code: 403 } },
        enabled: false,
      },
      { enabled: true },
    ),
    {
      action: "block",
      action_parameters: { response: { status_code: 403 } },
      enabled: true,
    },
  )
})

test("alignment live reads are scoped to the row surface across the account", () => {
  const inventory = makeInventory([makeZone("alpha.example")])
  const matrix = buildMatrix(inventory)
  const settingRow = matrix.rows.find((entry) => entry.key === "always_use_https")
  const requirement = intentAlignmentReadRequirement(settingRow)

  assert.deepEqual(requirement.surfaceIds, ["settings"])
  assert.equal(requirement.zoneIds, undefined)
  assert.equal(requirement.includeEmailAddresses, false)
})
