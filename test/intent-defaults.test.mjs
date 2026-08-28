import assert from "node:assert/strict"
import test from "node:test"

import {
  FLEET_INTENT_PRESENCE_CONSTRAINT,
  FLEET_INTENT_VALUE_CONSTRAINT,
} from "../src/fleet-intent.mjs"
import { defaultFleetIntentPolicyConstraints } from "../src/intent-defaults.mjs"

function cell(canonical) {
  return { canonical }
}

const scope = [
  { unavailable: false, zoneName: "alpha.example" },
  { unavailable: false, zoneName: "beta.example" },
  { unavailable: false, zoneName: "gamma.example" },
]

test("full single-variant coverage defaults to required exact intent", () => {
  const row = {
    cells: new Map(scope.map((zone) => [zone.zoneName, cell('"on"')])),
  }

  assert.deepEqual(defaultFleetIntentPolicyConstraints(row, scope), {
    presenceConstraint: FLEET_INTENT_PRESENCE_CONSTRAINT.REQUIRED,
    valueConstraint: FLEET_INTENT_VALUE_CONSTRAINT.EXACT,
  })
})

test("sparse single-variant coverage defaults to optional exact intent", () => {
  const row = {
    cells: new Map([["alpha.example", cell('"on"')]]),
  }

  assert.deepEqual(defaultFleetIntentPolicyConstraints(row, scope), {
    presenceConstraint: FLEET_INTENT_PRESENCE_CONSTRAINT.OPTIONAL,
    valueConstraint: FLEET_INTENT_VALUE_CONSTRAINT.EXACT,
  })
})

test("full varied coverage defaults to required may-differ intent", () => {
  const row = {
    cells: new Map([
      ["alpha.example", cell('"on"')],
      ["beta.example", cell('"off"')],
      ["gamma.example", cell('"on"')],
    ]),
  }

  assert.deepEqual(defaultFleetIntentPolicyConstraints(row, scope), {
    presenceConstraint: FLEET_INTENT_PRESENCE_CONSTRAINT.REQUIRED,
    valueConstraint: FLEET_INTENT_VALUE_CONSTRAINT.MAY_DIFFER,
  })
})

test("empty observed coverage defaults to optional may-differ intent", () => {
  assert.deepEqual(defaultFleetIntentPolicyConstraints({ cells: new Map() }, scope), {
    presenceConstraint: FLEET_INTENT_PRESENCE_CONSTRAINT.OPTIONAL,
    valueConstraint: FLEET_INTENT_VALUE_CONSTRAINT.MAY_DIFFER,
  })
})

test("unavailable group members do not imply optional presence", () => {
  const row = {
    cells: new Map([["alpha.example", cell('"on"')]]),
  }
  const namedScope = [
    scope[0],
    { unavailable: true, zoneName: "retired.example" },
  ]

  assert.deepEqual(defaultFleetIntentPolicyConstraints(row, namedScope), {
    presenceConstraint: FLEET_INTENT_PRESENCE_CONSTRAINT.REQUIRED,
    valueConstraint: FLEET_INTENT_VALUE_CONSTRAINT.EXACT,
  })
})
