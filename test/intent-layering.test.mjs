import assert from "node:assert/strict"
import test from "node:test"

import {
  FLEET_INTENT_POLICY_LAYER_PRESENTATION,
  FLEET_INTENT_POLICY_LAYER_ROLE,
  fleetIntentPolicyLayers,
} from "../src/intent-layering.mjs"

const FACET = Object.freeze({
  category: "Ruleset rules",
  key: "scanner-block",
  label: "Scanner block",
})

function policy(id, groupId, facet = FACET) {
  return { facet, groupId, id }
}

test("broader policy coverage is presented as a baseline refined by narrower groups", () => {
  const groups = [
    {
      id: "all-zones",
      members: [],
      mode: "all",
      name: "All zones",
    },
    {
      id: "alpha-zone",
      members: [{ zoneId: "zone-alpha", zoneName: "alpha.example" }],
      mode: "members",
      name: "alpha.example",
    },
  ]
  const layers = fleetIntentPolicyLayers(
    [
      policy("fleet-policy", "all-zones"),
      policy("zone-policy", "alpha-zone"),
    ],
    groups,
    ["zone-alpha", "zone-beta"],
  )

  assert.deepEqual(layers.get("fleet-policy"), {
    broaderGroupNames: [],
    narrowerGroupNames: ["alpha.example"],
    overlappingGroupNames: [],
    role: FLEET_INTENT_POLICY_LAYER_ROLE.BASELINE,
  })
  assert.deepEqual(layers.get("zone-policy"), {
    broaderGroupNames: ["All zones"],
    narrowerGroupNames: [],
    overlappingGroupNames: [],
    role: FLEET_INTENT_POLICY_LAYER_ROLE.REFINEMENT,
  })
  assert.equal(
    FLEET_INTENT_POLICY_LAYER_PRESENTATION[
      FLEET_INTENT_POLICY_LAYER_ROLE.BASELINE
    ].label,
    "Fleet baseline",
  )
  assert.equal(
    FLEET_INTENT_POLICY_LAYER_PRESENTATION[
      FLEET_INTENT_POLICY_LAYER_ROLE.REFINEMENT
    ].label,
    "Group refinement",
  )
})

test("partial overlaps remain peers rather than implying precedence", () => {
  const groups = [
    {
      id: "left-group",
      members: [
        { zoneId: "zone-a", zoneName: "a.example" },
        { zoneId: "zone-b", zoneName: "b.example" },
      ],
      mode: "members",
      name: "Left group",
    },
    {
      id: "right-group",
      members: [
        { zoneId: "zone-b", zoneName: "b.example" },
        { zoneId: "zone-c", zoneName: "c.example" },
      ],
      mode: "members",
      name: "Right group",
    },
  ]
  const layers = fleetIntentPolicyLayers(
    [
      policy("left-policy", "left-group"),
      policy("right-policy", "right-group"),
    ],
    groups,
    ["zone-a", "zone-b", "zone-c"],
  )

  assert.equal(
    layers.get("left-policy").role,
    FLEET_INTENT_POLICY_LAYER_ROLE.OVERLAP,
  )
  assert.deepEqual(
    layers.get("left-policy").overlappingGroupNames,
    ["Right group"],
  )
})

test("a fixed group stays narrower than all zones when it has unavailable members", () => {
  const groups = [
    {
      id: "all-zones",
      members: [],
      mode: "all",
      name: "All zones",
    },
    {
      id: "fixed-group",
      members: [
        { zoneId: "zone-a", zoneName: "a.example" },
        { zoneId: "zone-retired", zoneName: "retired.example" },
      ],
      mode: "members",
      name: "Fixed group",
    },
  ]
  const layers = fleetIntentPolicyLayers(
    [
      policy("fleet-policy", "all-zones"),
      policy("fixed-policy", "fixed-group"),
    ],
    groups,
    ["zone-a"],
  )

  assert.equal(
    layers.get("fleet-policy").role,
    FLEET_INTENT_POLICY_LAYER_ROLE.BASELINE,
  )
  assert.equal(
    layers.get("fixed-policy").role,
    FLEET_INTENT_POLICY_LAYER_ROLE.REFINEMENT,
  )
})
