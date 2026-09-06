import assert from "node:assert/strict"
import test from "node:test"

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
import { materializeValue } from "../src/normalize.mjs"
import { buildInversePlans } from "../src/operation-history.mjs"
import {
  buildHostnameScopedFreeRateLimitAlignmentPlan,
} from "../src/rate-limit-remediation.mjs"
import {
  buildRateLimitSkipExpression,
  createHostnameScopedFreeRateLimitIntentValue,
  describeHostnameScopedFreeRateLimitPolicy,
  HOSTNAME_SCOPED_RATE_LIMIT_CATEGORY,
  HOSTNAME_SCOPED_RATE_LIMIT_KEY,
  hostnameScopedFreeRateLimitMatrixFacet,
  isHostnameScopedFreeRateLimitIntentValue,
  observeHostnameScopedFreeRateLimitIntent,
  RATE_LIMIT_PHASE,
  rateLimitHostsFromSkipExpression,
} from "../src/rate-limit-intent.mjs"
import { makeInventory, makeZone, ok } from "./fixtures.mjs"

const SKIP_PHASE = "http_request_firewall_custom"

function desiredRateLimit(hosts = ["api.{zone}"]) {
  return createHostnameScopedFreeRateLimitIntentValue({
    hosts,
    rateDescription: "[fleet] Limit API requests by source",
    rateExpression: "starts_with(http.request.uri.path, \"/api/\")",
    requestsPerPeriod: 100,
    skipDescription: "[fleet] Skip API rate limit on other hosts",
  })
}

function ruleDetails(zoneName, desired = desiredRateLimit()) {
  const value = materializeValue(desired, zoneName)
  return [
    ok({
      id: `rate-${zoneName}`,
      kind: "zone",
      name: "default",
      phase: RATE_LIMIT_PHASE,
      rules: [{ id: `rate-rule-${zoneName}`, ...value.rateRules[0] }],
    }),
    ok({
      id: `skip-${zoneName}`,
      kind: "zone",
      name: "default",
      phase: SKIP_PHASE,
      rules: [{ id: `skip-rule-${zoneName}`, ...value.skipRules[0] }],
    }),
  ]
}

function configuredZone(zoneName, desired = desiredRateLimit()) {
  const details = ruleDetails(zoneName, desired)
  return makeZone(zoneName, {
    ruleDetails: details,
    rulesets: details.map((entry) => ({
      id: entry.result.id,
      kind: entry.result.kind,
      name: entry.result.name,
      phase: entry.result.phase,
    })),
  })
}

function intentFor(inventory, zone, value, overrides = {}) {
  let document = createEmptyFleetIntentDocument(inventory.account.id)
  const group = {
    id: "rate-limited",
    members: [{ zoneId: zone.meta.id, zoneName: zone.meta.name }],
    mode: "members",
    name: "Rate limited",
    nameSource: "custom",
  }
  document = replaceFleetIntentGroup(document, group)
  return replaceFleetIntentPolicy(document, {
    expected: createAuthoredFleetIntentExpected(value),
    facet: hostnameScopedFreeRateLimitMatrixFacet(),
    groupId: group.id,
    id: "policy-rate-limit",
    presenceConstraint: "required",
    valueConstraint: "exact",
    ...overrides,
  })
}

test("typed Free rate-limit values derive one exact complementary skip", () => {
  const value = desiredRateLimit(["www.{zone}", "api.{zone}", "api.{zone}"])

  assert.deepEqual(value.hosts, ["api.{zone}", "www.{zone}"])
  assert.equal(value.rateRules[0].ratelimit.period, 10)
  assert.equal(value.rateRules[0].ratelimit.mitigation_timeout, 10)
  assert.deepEqual(value.rateRules[0].ratelimit.characteristics, ["cf.colo.id", "ip.src"])
  assert.equal(value.skipRules[0].expression, buildRateLimitSkipExpression(value.hosts))
  assert.deepEqual(
    rateLimitHostsFromSkipExpression(value.skipRules[0].expression),
    value.hosts,
  )
  assert.equal(isHostnameScopedFreeRateLimitIntentValue(value), true)
})

test("typed values reject unpaired rules and non-Free expression fields", () => {
  const value = desiredRateLimit()
  assert.equal(isHostnameScopedFreeRateLimitIntentValue({
    ...value,
    skipRules: [],
  }), false)
  assert.equal(isHostnameScopedFreeRateLimitIntentValue({
    ...value,
    rateRules: [{
      ...value.rateRules[0],
      expression: "http.host eq \"api.example\"",
    }],
  }), false)
  assert.equal(isHostnameScopedFreeRateLimitIntentValue({
    ...value,
    rateRules: [{
      ...value.rateRules[0],
      expression: "raw.http.request.full_uri contains \"/api/\"",
    }],
  }), false)
  assert.equal(isHostnameScopedFreeRateLimitIntentValue({
    ...value,
    skipRules: [{
      ...value.skipRules[0],
      expression: "true",
    }],
  }), false)
  assert.equal(isHostnameScopedFreeRateLimitIntentValue({
    ...value,
    rateRules: [{
      ...value.rateRules[0],
      ratelimit: {
        ...value.rateRules[0].ratelimit,
        counting_expression: "http.response.code eq 500",
      },
    }],
  }), false)
  assert.equal(isHostnameScopedFreeRateLimitIntentValue({
    ...value,
    skipRules: [{
      ...value.skipRules[0],
      action_parameters: {
        phases: [RATE_LIMIT_PHASE],
        products: ["zoneLockdown"],
      },
    }],
  }), false)
})

test("an intentionally unused rate-limit slot is a valid exact posture", () => {
  const value = createHostnameScopedFreeRateLimitIntentValue({ enabled: false })
  assert.deepEqual(value, {
    hosts: [],
    kind: "hostname-scoped-free-rate-limit",
    rateRules: [],
    skipRules: [],
  })
  assert.equal(isHostnameScopedFreeRateLimitIntentValue(value), true)
})

test("live rule pairs normalize across zones into one portable posture", () => {
  const desired = desiredRateLimit()
  const alpha = configuredZone("alpha.example", desired)
  const beta = configuredZone("beta.example", desired)
  beta.ruleDetails[0].result.rules[0].ratelimit.characteristics.reverse()

  assert.deepEqual(observeHostnameScopedFreeRateLimitIntent(alpha).value, desired)
  assert.deepEqual(observeHostnameScopedFreeRateLimitIntent(beta).value, desired)
})

test("a simple one-host skip normalizes to the fail-safe portable expression", () => {
  const desired = desiredRateLimit(["api.{zone}"])
  const zone = configuredZone("alpha.example", desired)
  zone.ruleDetails[1].result.rules[0].expression = "http.host ne \"api.alpha.example\""

  assert.deepEqual(observeHostnameScopedFreeRateLimitIntent(zone).value, desired)
})

test("the synthetic matrix facet is opt-in and evaluates a healthy pair once", () => {
  const desired = desiredRateLimit()
  const zone = configuredZone("alpha.example", desired)
  const unused = makeZone("unused.example")
  const inventory = makeInventory([zone, unused])
  const intent = intentFor(inventory, zone, desired)
  const matrix = buildMatrix(inventory)
  const evaluation = evaluateFleetIntent(intent, inventory, matrix)
  const row = matrix.rows.find((entry) => (
    entry.category === HOSTNAME_SCOPED_RATE_LIMIT_CATEGORY
      && entry.key === HOSTNAME_SCOPED_RATE_LIMIT_KEY
  ))
  const state = evaluation.rowStates.get(fleetIntentFacetId(
    HOSTNAME_SCOPED_RATE_LIMIT_CATEGORY,
    HOSTNAME_SCOPED_RATE_LIMIT_KEY,
  ))

  assert.equal(row.intentOptInOnly, true)
  assert.equal(row.cells.get(zone.meta.name).display, "100 requests / 10s on api.{zone}")
  assert.equal(row.cells.get(unused.meta.name).display, "Unused")
  assert.equal(state.cells.get(zone.meta.id).status, "match")
  assert.equal(evaluation.summary.actionableCells, 0)
})

test("typed rate-limit policies are always required and exact", () => {
  const desired = desiredRateLimit()
  const zone = configuredZone("alpha.example", desired)
  const inventory = makeInventory([zone])

  assert.throws(() => intentFor(inventory, zone, desired, {
    presenceConstraint: "optional",
  }), /Fleet intent policy is invalid/)
  assert.throws(() => intentFor(inventory, zone, desired, {
    valueConstraint: "may-differ",
  }), /Fleet intent policy is invalid/)
})

test("the descriptor exposes the composite relationship and reusable values", () => {
  const result = describeHostnameScopedFreeRateLimitPolicy()
  assert.equal(result.facet.key, HOSTNAME_SCOPED_RATE_LIMIT_KEY)
  assert.equal(result.relationship.firstPhase, SKIP_PHASE)
  assert.equal(result.relationship.ratePhase, RATE_LIMIT_PHASE)
  assert.equal(result.freePlanLimits.wafCustomRulesConsumed, 1)
  assert.match(result.portability.customResponse, /does not introduce one on Free/)
  assert.equal(result.templates[0].value.rateRules.length, 0)
  assert.equal(result.templates[1].value.rateRules.length, 1)
})

test("missing rules are created skip first and rate last", () => {
  const desired = desiredRateLimit()
  const zone = makeZone("alpha.example")
  const action = observeHostnameScopedFreeRateLimitIntent(zone).action
  const plan = buildHostnameScopedFreeRateLimitAlignmentPlan(
    zone,
    action,
    materializeValue(desired, zone.meta.name),
  )

  assert.deepEqual(plan.operations.map((operation) => [
    operation.method,
    operation.body.phase,
  ]), [
    ["POST", SKIP_PHASE],
    ["POST", RATE_LIMIT_PHASE],
  ])
})

test("a full Free custom-rules allowance blocks creation of the required skip", () => {
  const zone = makeZone("alpha.example", {
    ruleDetails: [ok({
      id: "full-waf",
      kind: "zone",
      name: "default",
      phase: SKIP_PHASE,
      rules: Array.from({ length: 5 }, (_, index) => ({
        action: "block",
        description: `Rule ${index + 1}`,
        enabled: true,
        expression: `http.request.uri.path eq \"/blocked-${index + 1}\"`,
        id: `rule-${index + 1}`,
      })),
    })],
    rulesets: [{
      id: "full-waf",
      kind: "zone",
      name: "default",
      phase: SKIP_PHASE,
    }],
  })
  const action = observeHostnameScopedFreeRateLimitIntent(zone).action

  assert.throws(() => buildHostnameScopedFreeRateLimitAlignmentPlan(
    zone,
    action,
    materializeValue(desiredRateLimit(), zone.meta.name),
  ), /no capacity for the required rate-limit skip/)
})

test("Free alignment preserves but does not introduce a paid custom response", () => {
  const desired = createHostnameScopedFreeRateLimitIntentValue({
    actionParameters: {
      response: {
        content: "Rate limited",
        content_type: "text/plain",
        status_code: 429,
      },
    },
    hosts: ["api.{zone}"],
    rateDescription: "[fleet] Limit API requests by source",
    rateExpression: "starts_with(http.request.uri.path, \"/api/\")",
    requestsPerPeriod: 100,
    skipDescription: "[fleet] Skip API rate limit on other hosts",
  })
  const empty = makeZone("alpha.example")
  assert.throws(() => buildHostnameScopedFreeRateLimitAlignmentPlan(
    empty,
    observeHostnameScopedFreeRateLimitIntent(empty).action,
    materializeValue(desired, empty.meta.name),
  ), /will not introduce one/)

  const configured = configuredZone("alpha.example", desired)
  assert.doesNotThrow(() => buildHostnameScopedFreeRateLimitAlignmentPlan(
    configured,
    observeHostnameScopedFreeRateLimitIntent(configured).action,
    materializeValue(desired, configured.meta.name),
  ))
})

test("host-scope changes disable the rate before the skip and re-enable it last", () => {
  const current = desiredRateLimit(["old.{zone}"])
  const desired = desiredRateLimit(["new.{zone}"])
  const zone = configuredZone("alpha.example", current)
  const action = observeHostnameScopedFreeRateLimitIntent(zone).action
  const plan = buildHostnameScopedFreeRateLimitAlignmentPlan(
    zone,
    action,
    materializeValue(desired, zone.meta.name),
  )

  assert.deepEqual(plan.operations.map((operation) => [
    operation.method,
    operation.body.action,
    operation.body.enabled,
  ]), [
    ["PATCH", "block", false],
    ["PATCH", "skip", true],
    ["PATCH", "block", true],
  ])
  assert.match(plan.operations[0].label, /before changing host scope/)
})

test("removal deletes the rate before its host-scope skip", () => {
  const current = desiredRateLimit()
  const desired = createHostnameScopedFreeRateLimitIntentValue({ enabled: false })
  const zone = configuredZone("alpha.example", current)
  const action = observeHostnameScopedFreeRateLimitIntent(zone).action
  const plan = buildHostnameScopedFreeRateLimitAlignmentPlan(
    zone,
    action,
    desired,
  )

  assert.deepEqual(plan.operations.map((operation) => operation.path), [
    `zones/${zone.meta.id}/rulesets/rate-${zone.meta.name}/rules/rate-rule-${zone.meta.name}`,
    `zones/${zone.meta.id}/rulesets/skip-${zone.meta.name}/rules/skip-rule-${zone.meta.name}`,
  ])
  assert.ok(plan.operations.every((operation) => operation.method === "DELETE"))
})

test("guarded inverse preserves fail-safe ordering for scope changes and removal", () => {
  const zone = configuredZone("alpha.example", desiredRateLimit(["old.{zone}"]))
  const action = observeHostnameScopedFreeRateLimitIntent(zone).action
  const scopePlan = buildHostnameScopedFreeRateLimitAlignmentPlan(
    zone,
    action,
    materializeValue(desiredRateLimit(["new.{zone}"]), zone.meta.name),
  )
  const scopeInverse = buildInversePlans(scopePlan.operations.map((operation) => ({
    operation,
    plan: scopePlan,
    response: { result: operation.body, status: 200 },
  })))

  assert.equal(scopeInverse.available, true)
  assert.deepEqual(scopeInverse.plans[0].operations.map((operation) => [
    operation.body.action,
    operation.body.enabled,
  ]), [
    ["block", false],
    ["skip", true],
    ["block", true],
  ])

  const removalPlan = buildHostnameScopedFreeRateLimitAlignmentPlan(
    zone,
    action,
    createHostnameScopedFreeRateLimitIntentValue({ enabled: false }),
  )
  const removalInverse = buildInversePlans(removalPlan.operations.map((operation) => ({
    operation,
    plan: removalPlan,
    response: { result: {}, status: 200 },
  })))

  assert.equal(removalInverse.available, true)
  assert.deepEqual(removalInverse.plans[0].operations.map((operation) => (
    operation.body.action
  )), ["skip", "block"])
})

test("ordinary intent alignment reads both phases and emits the composite plan", () => {
  const desired = desiredRateLimit()
  const zone = makeZone("alpha.example")
  const inventory = makeInventory([zone])
  const intent = intentFor(inventory, zone, desired)
  const matrix = buildMatrix(inventory)
  const evaluation = evaluateFleetIntent(intent, inventory, matrix)
  const row = matrix.rows.find((entry) => (
    entry.category === HOSTNAME_SCOPED_RATE_LIMIT_CATEGORY
      && entry.key === HOSTNAME_SCOPED_RATE_LIMIT_KEY
  ))
  row.intentState = evaluation.rowStates.get(fleetIntentFacetId(
    HOSTNAME_SCOPED_RATE_LIMIT_CATEGORY,
    HOSTNAME_SCOPED_RATE_LIMIT_KEY,
  ))
  const requirement = intentAlignmentReadRequirement(row)
  const assessment = assessIntentAlignment(row)
  const plans = buildIntentAlignmentPlans(inventory, row, assessment)

  assert.deepEqual(requirement.ruleDetailPhases, [SKIP_PHASE, RATE_LIMIT_PHASE])
  assert.equal(assessment.available, true)
  assert.deepEqual(plans[0].operations.map((operation) => operation.body.phase), [
    SKIP_PHASE,
    RATE_LIMIT_PHASE,
  ])
})
