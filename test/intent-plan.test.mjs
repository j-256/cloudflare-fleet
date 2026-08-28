import assert from "node:assert/strict"
import test from "node:test"

import {
  createEmptyFleetIntentDocument,
  FLEET_INTENT_GROUP_MODE,
  FLEET_INTENT_GROUP_NAME_SOURCE,
  replaceFleetIntentGroup,
} from "../src/fleet-intent.mjs"
import {
  FLEET_INTENT_CHANGE_STATUS,
  prepareFleetIntentChange,
} from "../src/intent-plan.mjs"

function intentDocuments() {
  const current = createEmptyFleetIntentDocument("account-one")
  const desired = replaceFleetIntentGroup(current, {
    id: "production",
    members: [{ zoneId: "zone-one", zoneName: "one.example" }],
    mode: FLEET_INTENT_GROUP_MODE.MEMBERS,
    name: "Production",
    nameSource: FLEET_INTENT_GROUP_NAME_SOURCE.CUSTOM,
  })
  return { current, desired }
}

test("fleet intent replacement reports collection changes and a stable digest", () => {
  const { current, desired } = intentDocuments()
  const first = prepareFleetIntentChange(
    "account-one",
    current,
    desired,
    { validatedAt: "2026-08-28T00:00:00.000Z" },
  )
  const second = prepareFleetIntentChange(
    "account-one",
    current,
    desired,
    { validatedAt: "2026-08-28T01:00:00.000Z" },
  )

  assert.equal(first.status, FLEET_INTENT_CHANGE_STATUS.PLANNED)
  assert.deepEqual(first.diff.groups, {
    added: ["production"],
    changed: [],
    removed: [],
  })
  assert.equal(first.planSet.digest, second.planSet.digest)
  assert.notEqual(first.planSet.validatedAt, second.planSet.validatedAt)
})

test("fleet intent replacement preserves persistence fields and detects no-ops", () => {
  const current = createEmptyFleetIntentDocument("account-one")
  const desired = {
    ...structuredClone(current),
    updatedAt: null,
  }
  const result = prepareFleetIntentChange("account-one", current, desired)

  assert.equal(result.status, FLEET_INTENT_CHANGE_STATUS.UNCHANGED)
  assert.equal(result.desired.revision, current.revision)
  assert.equal(result.desired.updatedAt, current.updatedAt)
})

test("fleet intent replacement rejects another account or stale revision", () => {
  const { current, desired } = intentDocuments()
  assert.throws(
    () => prepareFleetIntentChange("account-two", current, desired),
    /another Cloudflare account/,
  )
  assert.throws(
    () => prepareFleetIntentChange("account-one", current, {
      ...desired,
      revision: "a".repeat(64),
    }),
    /revision does not match/,
  )
})
