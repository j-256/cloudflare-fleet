import assert from "node:assert/strict"
import test from "node:test"

import {
  dnssecDesiredStatus,
  dnssecIntentCorrection,
} from "../src/dnssec-intent.mjs"
import {
  FLEET_INTENT_CELL_STATUS,
  FLEET_INTENT_VALUE_CONSTRAINT,
} from "../src/fleet-intent.mjs"

function zone(name) {
  return {
    meta: {
      id: `zone-${name}`,
      name,
    },
  }
}

function policy(id, status) {
  return {
    expected: {
      value: { status },
    },
    id,
    valueConstraint: FLEET_INTENT_VALUE_CONSTRAINT.EXACT,
  }
}

function intentCell(zoneEntry, policyEntry, status, options = {}) {
  return {
    policies: options.policies,
    policy: options.policy === null ? null : policyEntry,
    status,
    zone: zoneEntry,
  }
}

function dnssecRow(entries, intentCells) {
  return {
    category: "DNSSEC",
    cells: new Map(entries.map(([zoneEntry, status]) => [
      zoneEntry.meta.name,
      { inspectionValue: { status } },
    ])),
    intentState: {
      cells: new Map(intentCells.map((cell) => [cell.zone.meta.id, cell])),
    },
    key: "configuration",
  }
}

test("DNSSEC intent correction targets writable drift and separates pending or generated differences", () => {
  const desired = policy("active-policy", "active")
  const matching = zone("matching.example")
  const disabled = zone("disabled.example")
  const pending = zone("pending.example")
  const generated = zone("generated.example")
  const acknowledged = zone("acknowledged.example")
  const conflicted = zone("conflicted.example")
  const row = dnssecRow([
    [matching, "active"],
    [disabled, "disabled"],
    [pending, "pending"],
    [generated, "active"],
    [acknowledged, "disabled"],
    [conflicted, "disabled"],
  ], [
    intentCell(matching, desired, FLEET_INTENT_CELL_STATUS.MATCH),
    intentCell(disabled, desired, FLEET_INTENT_CELL_STATUS.VARIANT),
    intentCell(pending, desired, FLEET_INTENT_CELL_STATUS.VARIANT),
    intentCell(generated, desired, FLEET_INTENT_CELL_STATUS.VARIANT),
    intentCell(acknowledged, desired, FLEET_INTENT_CELL_STATUS.ACKNOWLEDGED),
    intentCell(conflicted, desired, FLEET_INTENT_CELL_STATUS.CONFLICT, {
      policies: [desired, policy("other-policy", "disabled")],
      policy: null,
    }),
  ])

  const correction = dnssecIntentCorrection(row)

  assert.equal(correction.available, true)
  assert.deepEqual(correction.targets, [
    {
      desiredStatus: "active",
      policyId: "active-policy",
      zoneId: "zone-disabled.example",
      zoneName: "disabled.example",
    },
  ])
  assert.deepEqual(correction.waiting, ["pending.example"])
  assert.deepEqual(correction.generatedOnly, ["generated.example"])
  assert.deepEqual(correction.conflicts, ["conflicted.example"])
})

test("DNSSEC intent correction can isolate one policy from disjoint coverage", () => {
  const activePolicy = policy("active-policy", "active")
  const disabledPolicy = policy("disabled-policy", "disabled")
  const first = zone("first.example")
  const second = zone("second.example")
  const row = dnssecRow([
    [first, "disabled"],
    [second, "active"],
  ], [
    intentCell(first, activePolicy, FLEET_INTENT_CELL_STATUS.VARIANT),
    intentCell(second, disabledPolicy, FLEET_INTENT_CELL_STATUS.VARIANT),
  ])

  assert.deepEqual(
    dnssecIntentCorrection(row, { policyId: activePolicy.id }).targets
      .map((target) => target.zoneName),
    ["first.example"],
  )
  assert.deepEqual(
    dnssecIntentCorrection(row, { policyId: disabledPolicy.id }).targets
      .map((target) => target.zoneName),
    ["second.example"],
  )
})

test("DNSSEC intent requires a writable expected status", () => {
  assert.equal(dnssecDesiredStatus({ value: { status: "active" } }), "active")
  assert.equal(dnssecDesiredStatus({ value: { status: "disabled" } }), "disabled")
  assert.equal(dnssecDesiredStatus({ value: { status: "pending" } }), null)
  assert.equal(dnssecDesiredStatus({ value: {} }), null)
})
