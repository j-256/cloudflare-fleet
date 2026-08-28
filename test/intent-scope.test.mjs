import assert from "node:assert/strict"
import test from "node:test"

import {
  findIntentGroupForZoneSelection,
  generatedIntentScopeName,
  intentGroupMatchesZoneSelection,
  intentGroupsForZoneSelection,
} from "../src/intent-scope.mjs"

const allZones = {
  id: "all-zones",
  members: [],
  mode: "all",
  name: "All zones",
}
const selectedZones = {
  id: "group-selected",
  members: [
    { zoneId: "zone-a", zoneName: "a.example" },
    { zoneId: "zone-c", zoneName: "c.example" },
  ],
  mode: "members",
  name: "Selected",
}

test("intent scope matching treats saved groups as exact membership shortcuts", () => {
  const groups = [allZones, selectedZones]
  const loadedZoneIds = ["zone-a", "zone-b", "zone-c"]

  assert.equal(
    findIntentGroupForZoneSelection(groups, loadedZoneIds, loadedZoneIds),
    allZones,
  )
  assert.equal(
    findIntentGroupForZoneSelection(groups, ["zone-c", "zone-a"], loadedZoneIds),
    selectedZones,
  )
  assert.equal(
    findIntentGroupForZoneSelection(groups, ["zone-b"], loadedZoneIds),
    null,
  )
  assert.equal(
    intentGroupMatchesZoneSelection(selectedZones, ["zone-a"], loadedZoneIds),
    false,
  )
})

test("intent scope matching leaves duplicate saved memberships explicit", () => {
  const duplicate = {
    ...selectedZones,
    id: "group-duplicate",
    name: "Duplicate",
  }
  const groups = [allZones, selectedZones, duplicate]
  const loadedZoneIds = ["zone-a", "zone-b", "zone-c"]

  assert.equal(
    findIntentGroupForZoneSelection(groups, ["zone-a", "zone-c"], loadedZoneIds),
    null,
  )
  assert.deepEqual(
    intentGroupsForZoneSelection(
      groups,
      ["zone-a", "zone-c"],
      loadedZoneIds,
    ).map((group) => group.id),
    ["group-selected", "group-duplicate"],
  )
  assert.equal(
    findIntentGroupForZoneSelection(
      [...groups, {
        id: "fixed-all",
        members: loadedZoneIds.map((zoneId) => ({ zoneId, zoneName: zoneId })),
        mode: "members",
        name: "Fixed all",
      }],
      loadedZoneIds,
      loadedZoneIds,
    ),
    allZones,
  )
})

test("intent scope names are generated from membership and made unique", () => {
  const members = [
    { zoneId: "zone-c", zoneName: "c.example" },
    { zoneId: "zone-a", zoneName: "a.example" },
    { zoneId: "zone-b", zoneName: "b.example" },
  ]
  const groups = [{ id: "existing", name: "a.example +2 more" }]

  assert.equal(
    generatedIntentScopeName(members, groups),
    "a.example +2 more (2)",
  )
  assert.equal(
    generatedIntentScopeName(members.slice(0, 1), groups),
    "c.example",
  )
})

test("intent scope names honor the persisted label limit", () => {
  const name = generatedIntentScopeName([
    { zoneId: "zone-a", zoneName: "a-very-long-zone-name.example" },
  ], [], { maximum: 12 })

  assert.equal(name, "a-very-long-")
})
