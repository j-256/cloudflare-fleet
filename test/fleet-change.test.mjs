import assert from "node:assert/strict"
import test from "node:test"

import {
  FLEET_CHANGE_STATUS,
  normalizeFleetChange,
  prepareFleetChange,
} from "../src/fleet-change.mjs"

const ZONE = Object.freeze({
  meta: Object.freeze({ id: "zone-one", name: "one.example" }),
  ruleDetails: Object.freeze([]),
  surfaces: Object.freeze({}),
})

function scopedReads(resources = []) {
  return async () => ({
    inventory: {
      account: {},
      zones: [structuredClone(ZONE)],
    },
    resources: new Map(resources),
    rulePhases: new Map(),
  })
}

test("bounded change schema rejects arbitrary API passthrough fields", () => {
  assert.throws(
    () => normalizeFleetChange({
      desired: "on",
      kind: "zone-setting-update",
      method: "PATCH",
      path: "zones/zone-one/settings/always_use_https",
      settingId: "always_use_https",
      zoneId: "zone-one",
    }),
    /Fleet change is invalid/,
  )
  assert.throws(
    () => normalizeFleetChange({
      kind: "dns-record-copy",
      sourceRecordIds: ["record-one"],
      sourceZoneId: "zone-one",
      targetZoneIds: ["zone-one"],
    }),
    /source zone cannot also be a target zone/,
  )
})

test("zone setting change plans one exact write from a fresh resource read", async () => {
  const result = await prepareFleetChange(
    { accountId: "account-one" },
    {
      desired: "on",
      kind: "zone-setting-update",
      settingId: "always_use_https",
      zoneId: "zone-one",
    },
    {
      executeReadPlan: scopedReads([[
        "setting:zone-one:always_use_https",
        { editable: true, id: "always_use_https", value: "off" },
      ]]),
      readPolicy: async () => ({}),
      validatedAt: "2026-08-28T00:00:00.000Z",
    },
  )

  assert.equal(result.status, FLEET_CHANGE_STATUS.PLANNED)
  assert.match(result.planSet.digest, /^sha256:[a-f0-9]{64}$/)
  assert.deepEqual(result.planSet.preview, [{
    body: { value: "on" },
    currentValue: "off",
    label: "Set always_use_https",
    method: "PATCH",
    path: "zones/zone-one/settings/always_use_https",
    zoneId: "zone-one",
    zoneName: "one.example",
  }])
  assert.equal(Object.hasOwn(result.planSet.request, "method"), false)
  assert.equal(Object.hasOwn(result.planSet.request, "path"), false)
})

test("bounded change planner reports fresh no-ops and builder blockers", async () => {
  const noOp = await prepareFleetChange(
    { accountId: "account-one" },
    {
      desired: "on",
      kind: "zone-setting-update",
      settingId: "always_use_https",
      zoneId: "zone-one",
    },
    {
      executeReadPlan: scopedReads([[
        "setting:zone-one:always_use_https",
        { editable: true, id: "always_use_https", value: "on" },
      ]]),
      readPolicy: async () => ({}),
    },
  )
  const blocked = await prepareFleetChange(
    { accountId: "account-one" },
    {
      desired: "on",
      kind: "zone-setting-update",
      settingId: "always_use_https",
      zoneId: "zone-one",
    },
    {
      executeReadPlan: scopedReads([[
        "setting:zone-one:always_use_https",
        { editable: false, id: "always_use_https", value: "off" },
      ]]),
      readPolicy: async () => ({}),
    },
  )

  assert.equal(noOp.status, FLEET_CHANGE_STATUS.ALIGNED)
  assert.equal(noOp.planSet.preview.length, 0)
  assert.equal(blocked.status, FLEET_CHANGE_STATUS.BLOCKED)
  assert.equal(blocked.planSet, null)
  assert.match(blocked.reason, /read-only/)
})
