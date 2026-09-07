import assert from "node:assert/strict"
import test from "node:test"

import {
  dnssecDesiredStatus,
  dnssecIntentCorrection,
} from "../src/dnssec-intent.mjs"
import {
  FLEET_INTENT_CELL_STATUS,
  FLEET_INTENT_PRESENCE_CONSTRAINT,
  FLEET_INTENT_VALUE_CONSTRAINT,
} from "../src/fleet-intent.mjs"

function zone(name, dnssec = null) {
  return {
    meta: {
      id: `zone-${name}`,
      name,
    },
    surfaces: dnssec === null
      ? {}
      : {
          dnssec: {
            ok: true,
            result: dnssec,
          },
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
    intentCell(pending, desired, FLEET_INTENT_CELL_STATUS.MATCH),
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

test("DNSSEC intent correction ignores cells without a governing policy", () => {
  const ungoverned = zone("ungoverned.example")
  const outsideScope = zone("outside.example")
  const governed = zone("governed.example")
  const desired = policy("active-policy", "active")
  const row = dnssecRow([
    [ungoverned, "disabled"],
    [outsideScope, "disabled"],
    [governed, "disabled"],
  ], [
    intentCell(ungoverned, undefined, FLEET_INTENT_CELL_STATUS.UNGOVERNED),
    intentCell(outsideScope, null, FLEET_INTENT_CELL_STATUS.OUT_OF_SCOPE),
    intentCell(governed, desired, FLEET_INTENT_CELL_STATUS.VARIANT),
  ])

  const correction = dnssecIntentCorrection(row)

  assert.equal(correction.available, true)
  assert.deepEqual(correction.targets.map((target) => target.zoneName), ["governed.example"])
  assert.deepEqual(correction.conflicts, [])
  assert.deepEqual(correction.generatedOnly, [])
  assert.deepEqual(correction.waiting, [])
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

test("DNSSEC intent correction separates stalled transitions from propagation", () => {
  const desired = policy("active-policy", "active")
  const waiting = zone("waiting.example", {
    modified_on: "2026-08-09T00:00:00.000Z",
    status: "pending",
  })
  const stalled = zone("stalled.example", {
    modified_on: "2026-08-01T00:00:00.000Z",
    status: "pending",
  })
  const row = dnssecRow([
    [waiting, "pending"],
    [stalled, "pending"],
  ], [
    intentCell(waiting, desired, FLEET_INTENT_CELL_STATUS.MATCH),
    intentCell(stalled, desired, FLEET_INTENT_CELL_STATUS.MATCH),
  ])

  const correction = dnssecIntentCorrection(row, {
    now: Date.parse("2026-08-09T18:00:00.000Z"),
  })

  assert.equal(correction.available, false)
  assert.deepEqual(correction.waiting, ["waiting.example"])
  assert.deepEqual(correction.stalled, ["stalled.example"])
  assert.match(correction.reason, /has not completed/)
})

test("DNSSEC intent requires a writable expected status", () => {
  assert.equal(dnssecDesiredStatus({ value: { status: "active" } }), "active")
  assert.equal(dnssecDesiredStatus({ value: { status: "disabled" } }), "disabled")
  assert.equal(dnssecDesiredStatus({ value: { status: "pending" } }), null)
  assert.equal(dnssecDesiredStatus({ value: {} }), null)
})

test("forbidden DNSSEC presence does not offer a status correction", () => {
  const forbidden = {
    ...policy("forbidden-policy", "active"),
    expected: null,
    presenceConstraint: FLEET_INTENT_PRESENCE_CONSTRAINT.FORBIDDEN,
    valueConstraint: FLEET_INTENT_VALUE_CONSTRAINT.MAY_DIFFER,
  }
  const present = zone("present.example")
  const row = dnssecRow([
    [present, "active"],
  ], [
    intentCell(present, forbidden, FLEET_INTENT_CELL_STATUS.VARIANT),
  ])

  assert.equal(dnssecIntentCorrection(row).available, false)
  assert.deepEqual(dnssecIntentCorrection(row).targets, [])
})
