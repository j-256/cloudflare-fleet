import assert from "node:assert/strict"
import test from "node:test"

import {
  buildInversePlans,
  compareVerificationGuards,
  completeOperationActivity,
  createEmptyOperationActivityDocument,
  createPendingOperationActivity,
  createVerificationGuards,
  isOperationActivityDocument,
  isOperationActivityEntry,
  OPERATION_ACTIVITY_STATUS,
} from "../src/operation-history.mjs"
import {
  WRITE_VERIFICATION_KIND,
  WRITE_VERIFICATION_SURFACE,
} from "../src/write-verification.mjs"

const STARTED_AT = "2026-08-03T03:00:00.000Z"
const COMPLETED_AT = "2026-08-03T03:01:00.000Z"

function plan(operation, options = {}) {
  return {
    id: options.id || "plan-zone-one",
    kind: options.kind || "test",
    operations: [operation],
    summary: options.summary || "Change alpha.example",
    zoneId: options.zoneId || "zone-one",
    zoneName: options.zoneName || "alpha.example",
  }
}

function result(operation, response, options = {}) {
  return {
    operation,
    plan: plan(operation, options),
    response: {
      result: response,
      status: 200,
    },
  }
}

test("operation activity records immutable reviewed plans and verified results", () => {
  const operation = {
    body: { value: "on" },
    currentValue: "off",
    label: "Set always_use_https",
    method: "PATCH",
    path: "zones/zone-one/settings/always_use_https",
  }
  const pending = createPendingOperationActivity(
    "Update zone setting",
    {
      plans: [plan(operation)],
      validatedAt: STARTED_AT,
    },
    {
      id: "activity-one",
      startedAt: STARTED_AT,
    },
  )
  const completed = completeOperationActivity(pending, {
    completedAt: COMPLETED_AT,
    execution: { completed: 1, total: 1 },
    inverse: {
      available: true,
      plans: [plan(operation)],
      reason: "Guard required",
    },
    status: OPERATION_ACTIVITY_STATUS.VERIFIED,
    verification: createVerificationGuards([{
      response: {
        result: {
          id: "always_use_https",
          value: "on",
        },
      },
      target: {
        kind: WRITE_VERIFICATION_KIND.SETTING,
        settingId: "always_use_https",
        zoneId: "zone-one",
      },
    }]),
  })

  assert.equal(isOperationActivityEntry(pending), true)
  assert.equal(isOperationActivityEntry(completed), true)
  assert.equal(completed.status, OPERATION_ACTIVITY_STATUS.VERIFIED)
  assert.equal(pending.status, OPERATION_ACTIVITY_STATUS.PENDING)
  assert.equal(isOperationActivityDocument(createEmptyOperationActivityDocument()), true)
})

test("operation activity schema rejects malformed executable state", () => {
  const operation = {
    body: { value: "on" },
    currentValue: "off",
    label: "Set always_use_https",
    method: "PATCH",
    path: "zones/zone-one/settings/always_use_https",
  }
  const pending = createPendingOperationActivity(
    "Update zone setting",
    {
      plans: [plan(operation)],
      validatedAt: STARTED_AT,
    },
    {
      id: "activity-schema",
      startedAt: STARTED_AT,
    },
  )
  const malformedPlan = structuredClone(pending)
  malformedPlan.plans[0].operations = []
  const readOperation = structuredClone(pending)
  readOperation.plans[0].operations[0].method = "GET"
  const completed = completeOperationActivity(pending, {
    completedAt: COMPLETED_AT,
    execution: { completed: 1, total: 1 },
    inverse: { available: false, plans: [], reason: "Test" },
    status: OPERATION_ACTIVITY_STATUS.VERIFIED,
    verification: [],
  })
  const mismatchedExecution = structuredClone(completed)
  mismatchedExecution.execution.total = 2
  const mismatchedGuard = structuredClone(completed)
  mismatchedGuard.verification = createVerificationGuards([{
    response: { result: { id: "always_use_https", value: "on" } },
    target: {
      kind: WRITE_VERIFICATION_KIND.SETTING,
      settingId: "always_use_https",
      zoneId: "zone-one",
    },
  }])
  mismatchedGuard.verification[0].canonical = "changed"
  const orphanedUndo = structuredClone(pending)
  orphanedUndo.undoOf = "missing-parent"

  assert.equal(isOperationActivityEntry(malformedPlan), false)
  assert.equal(isOperationActivityEntry(readOperation), false)
  assert.equal(isOperationActivityEntry(mismatchedExecution), false)
  assert.equal(isOperationActivityEntry(mismatchedGuard), false)
  assert.equal(isOperationActivityDocument({
    entries: [malformedPlan],
    revision: "",
    updatedAt: null,
  }), false)
  assert.equal(isOperationActivityDocument({
    entries: [orphanedUndo],
    revision: "",
    updatedAt: null,
  }), false)
  assert.throws(
    () => completeOperationActivity(pending, {
      completedAt: COMPLETED_AT,
      execution: { completed: 1, total: 1 },
      inverse: {
        available: true,
        plans: [plan(operation)],
        reason: "Guard required",
      },
      status: OPERATION_ACTIVITY_STATUS.VERIFIED,
      verification: [],
    }),
    /invalid/,
  )
})

test("inverse plans restore direct edits and reverse operation order", () => {
  const setting = {
    body: { value: "on" },
    currentValue: "off",
    label: "Set always_use_https",
    method: "PATCH",
    path: "zones/zone-one/settings/always_use_https",
  }
  const dns = {
    body: {
      content: "target.example",
      name: "www.alpha.example",
      ttl: 1,
      type: "CNAME",
    },
    label: "Create CNAME www.alpha.example",
    method: "POST",
    path: "zones/zone-one/dns_records",
  }
  const inverse = buildInversePlans([
    result(setting, { id: "always_use_https", value: "on" }),
    result(dns, { id: "record-one" }),
  ])

  assert.equal(inverse.available, true)
  assert.deepEqual(
    inverse.plans[0].operations.map((operation) => [operation.method, operation.path]),
    [
      ["DELETE", "zones/zone-one/dns_records/record-one"],
      ["PATCH", "zones/zone-one/settings/always_use_https"],
    ],
  )
  assert.deepEqual(
    inverse.plans[0].operations[1].body,
    { value: "off" },
  )
})

test("inverse adapters cover every directly reversible resource lifecycle", () => {
  const cases = [
    {
      expected: {
        body: { content: "old", name: "alpha.example", ttl: 1, type: "TXT" },
        method: "PATCH",
        path: "zones/zone-one/dns_records/record-one",
      },
      operation: {
        body: { content: "new", name: "alpha.example", ttl: 300, type: "TXT" },
        currentValue: { content: "old", name: "alpha.example", ttl: 1, type: "TXT" },
        label: "Update TXT alpha.example",
        method: "PATCH",
        path: "zones/zone-one/dns_records/record-one",
      },
      response: { id: "record-one" },
    },
    {
      expected: {
        body: { content: "old", name: "alpha.example", ttl: 1, type: "TXT" },
        method: "POST",
        path: "zones/zone-one/dns_records",
      },
      operation: {
        currentValue: { content: "old", name: "alpha.example", ttl: 1, type: "TXT" },
        label: "Delete TXT alpha.example",
        method: "DELETE",
        path: "zones/zone-one/dns_records/record-one",
      },
      response: null,
    },
    {
      expected: {
        body: { skip_wizard: false, support_subaddress: false },
        method: "PATCH",
        path: "zones/zone-one/email/routing",
      },
      operation: {
        body: { skip_wizard: true, support_subaddress: true },
        currentValue: { skip_wizard: false, support_subaddress: false },
        label: "Match Email Routing settings",
        method: "PATCH",
        path: "zones/zone-one/email/routing",
      },
      response: { skip_wizard: true, support_subaddress: true },
    },
    {
      expected: {
        body: {
          actions: [{ type: "drop" }],
          enabled: false,
          matchers: [{ field: "to", type: "literal", value: "old@alpha.example" }],
          name: "Old rule",
        },
        method: "PUT",
        path: "zones/zone-one/email/routing/rules/rule-one",
      },
      operation: {
        body: {
          actions: [{ type: "forward", value: ["new@example.com"] }],
          enabled: true,
          matchers: [{ field: "to", type: "literal", value: "new@alpha.example" }],
          name: "New rule",
        },
        currentValue: {
          actions: [{ type: "drop" }],
          enabled: false,
          matchers: [{ field: "to", type: "literal", value: "old@alpha.example" }],
          name: "Old rule",
        },
        label: "Update Email Routing rule",
        method: "PUT",
        path: "zones/zone-one/email/routing/rules/rule-one",
      },
      response: { id: "rule-one" },
    },
    {
      expected: {
        method: "DELETE",
        path: "zones/zone-one/rulesets/ruleset-new",
      },
      operation: {
        body: {
          description: "New ruleset",
          kind: "zone",
          name: "default",
          phase: "http_request_firewall_custom",
          rules: [],
        },
        label: "Create ruleset",
        method: "POST",
        path: "zones/zone-one/rulesets",
      },
      response: { id: "ruleset-new" },
    },
    {
      expected: {
        body: {
          description: "Old ruleset",
          kind: "zone",
          name: "default",
          phase: "http_request_firewall_custom",
        },
        method: "POST",
        path: "zones/zone-one/rulesets",
      },
      operation: {
        currentValue: {
          description: "Old ruleset",
          kind: "zone",
          name: "default",
          phase: "http_request_firewall_custom",
        },
        label: "Delete empty ruleset",
        method: "DELETE",
        path: "zones/zone-one/rulesets/ruleset-one",
      },
      response: null,
    },
    {
      expected: {
        body: { description: "Old", rules: [] },
        method: "PUT",
        path: "zones/zone-one/rulesets/ruleset-one",
      },
      operation: {
        body: { description: "New", rules: [] },
        currentValue: { description: "Old", rules: [] },
        label: "Update ruleset description",
        method: "PUT",
        path: "zones/zone-one/rulesets/ruleset-one",
      },
      response: { id: "ruleset-one" },
    },
    {
      expected: {
        body: { action: "block", enabled: true, expression: "true" },
        method: "PATCH",
        path: "zones/zone-one/rulesets/ruleset-one/rules/rule-one",
      },
      operation: {
        body: { action: "block", enabled: false, expression: "true" },
        currentValue: { action: "block", enabled: true, expression: "true" },
        label: "Update rule",
        method: "PATCH",
        path: "zones/zone-one/rulesets/ruleset-one/rules/rule-one",
      },
      response: { id: "ruleset-one" },
    },
    {
      expected: {
        body: { position: { index: 3 } },
        method: "PATCH",
        path: "zones/zone-one/rulesets/ruleset-one/rules/rule-one",
      },
      operation: {
        body: { position: { before: "rule-two" } },
        currentValue: { position: 3 },
        label: "Reorder rule",
        method: "PATCH",
        path: "zones/zone-one/rulesets/ruleset-one/rules/rule-one",
      },
      response: { id: "ruleset-one" },
    },
  ]

  for (const entry of cases) {
    const inverse = buildInversePlans([
      result(entry.operation, entry.response),
    ])

    assert.equal(inverse.available, true, entry.operation.label)
    const operation = inverse.plans[0].operations[0]
    assert.equal(operation.method, entry.expected.method, entry.operation.label)
    assert.equal(operation.path, entry.expected.path, entry.operation.label)
    if (entry.expected.body) {
      assert.deepEqual(operation.body, entry.expected.body, entry.operation.label)
    }
  }
})

test("inverse plans identify newly created rules in whole-ruleset responses", () => {
  const first = {
    body: {
      action: "block",
      description: "First",
      enabled: false,
      expression: "false",
    },
    currentValue: { ruleIds: ["existing"] },
    label: "Create First",
    method: "POST",
    path: "zones/zone-one/rulesets/ruleset-one/rules",
  }
  const second = {
    body: {
      action: "block",
      description: "Second",
      enabled: false,
      expression: "false",
    },
    currentValue: { ruleIds: ["existing"] },
    label: "Create Second",
    method: "POST",
    path: "zones/zone-one/rulesets/ruleset-one/rules",
  }
  const existing = {
    action: "block",
    enabled: true,
    expression: "true",
    id: "existing",
  }
  const createdFirst = { ...first.body, id: "created-first" }
  const createdSecond = { ...second.body, id: "created-second" }
  const inverse = buildInversePlans([
    result(first, { rules: [existing, createdFirst] }),
    result(second, { rules: [existing, createdFirst, createdSecond] }),
  ])

  assert.equal(inverse.available, true)
  assert.deepEqual(
    inverse.plans[0].operations.map((operation) => operation.path),
    [
      "zones/zone-one/rulesets/ruleset-one/rules/created-second",
      "zones/zone-one/rulesets/ruleset-one/rules/created-first",
    ],
  )
})

test("inverse plans restore deleted rules at their original one-based position", () => {
  const operation = {
    currentValue: {
      position: 2,
      rule: {
        action: "block",
        enabled: true,
        expression: "true",
      },
    },
    label: "Delete old rule",
    method: "DELETE",
    path: "zones/zone-one/rulesets/ruleset-one/rules/rule-one",
  }
  const inverse = buildInversePlans([result(operation, { rules: [] })])

  assert.equal(inverse.available, true)
  assert.equal(inverse.plans[0].operations[0].method, "POST")
  assert.deepEqual(inverse.plans[0].operations[0].body.position, { index: 2 })
})

test("coupled Email Routing DNS changes are explicitly non-reversible", () => {
  const operation = {
    label: "Enable Email Routing and create required DNS records",
    method: "POST",
    path: "zones/zone-one/email/routing/dns",
  }
  const inverse = buildInversePlans([result(operation, { enabled: true })])

  assert.equal(inverse.available, false)
  assert.match(inverse.reason, /without a lossless inverse/)
  assert.deepEqual(inverse.plans, [])
})

test("verification guards ignore volatile ruleset metadata but detect definition drift", () => {
  const target = {
    kind: WRITE_VERIFICATION_KIND.RULESET,
    rulesetId: "ruleset-one",
    zoneId: "zone-one",
  }
  const original = {
    response: {
      result: {
        id: "ruleset-one",
        kind: "zone",
        last_updated: "2026-08-03T03:00:00Z",
        name: "default",
        phase: "http_request_firewall_custom",
        rules: [{
          action: "block",
          enabled: true,
          expression: "true",
          id: "rule-one",
          last_updated: "2026-08-03T03:00:00Z",
          version: "1",
        }],
        version: "1",
      },
    },
    target,
  }
  const guards = createVerificationGuards([original])
  const metadataOnly = structuredClone(original)
  metadataOnly.response.result.version = "2"
  metadataOnly.response.result.last_updated = "2026-08-03T03:02:00Z"
  metadataOnly.response.result.rules[0].version = "2"
  const definitionChange = structuredClone(metadataOnly)
  definitionChange.response.result.rules[0].enabled = false

  assert.equal(compareVerificationGuards(guards, [metadataOnly]).matches, true)
  assert.equal(compareVerificationGuards(guards, [definitionChange]).matches, false)
})

test("DNS surface guards are stable across API list ordering", () => {
  const target = {
    kind: WRITE_VERIFICATION_KIND.SURFACE,
    surfaceId: WRITE_VERIFICATION_SURFACE.DNS,
    zoneId: "zone-one",
  }
  const records = [
    { content: "one", id: "record-a", name: "a.example", ttl: 1, type: "TXT" },
    { content: "two", id: "record-b", name: "b.example", ttl: 1, type: "TXT" },
  ]
  const guards = createVerificationGuards([{
    response: { result: records },
    target,
  }])

  assert.equal(compareVerificationGuards(guards, [{
    response: { result: [...records].reverse() },
    target,
  }]).matches, true)
})
