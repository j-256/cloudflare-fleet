import assert from "node:assert/strict"
import test from "node:test"

import {
  FLEET_INTENT_HEALTH_STATUS,
  fleetIntentHealth,
} from "../src/intent-health.mjs"

function summary(overrides = {}) {
  return {
    actionableCells: 0,
    actionableZones: 0,
    governedRows: 4,
    matchingZones: 3,
    policies: 4,
    ungovernedRows: 2,
    unresolvedPolicies: 0,
    zones: 3,
    ...overrides,
  }
}

test("aligned intent names the complete zone result and separates ungoverned differences", () => {
  const health = fleetIntentHealth(summary())

  assert.equal(health.status, FLEET_INTENT_HEALTH_STATUS.ALIGNED)
  assert.equal(health.title, "All 3 zones match fleet intent")
  assert.equal(health.matchMetric, "3 / 3")
  assert.match(health.detail, /Every loaded zone satisfies/)
  assert.match(health.detail, /not failures/)
})

test("intent drift reports matching zones and actionable mismatch scope", () => {
  const health = fleetIntentHealth(summary({
    actionableCells: 2,
    actionableZones: 1,
    matchingZones: 2,
  }))

  assert.equal(health.status, FLEET_INTENT_HEALTH_STATUS.DRIFT)
  assert.equal(health.title, "2 of 3 zones match fleet intent")
  assert.equal(health.matchMetric, "2 / 3")
  assert.match(health.detail, /1 zone has 2 actionable mismatches/)
})

test("missing policies do not claim that zones match undefined intent", () => {
  const health = fleetIntentHealth(summary({
    governedRows: 0,
    matchingZones: 3,
    policies: 0,
    ungovernedRows: 6,
  }))

  assert.equal(health.status, FLEET_INTENT_HEALTH_STATUS.EMPTY)
  assert.equal(health.title, "Fleet intent is not defined")
  assert.equal(health.matchMetric, "Not set")
})

test("unresolved policies prevent a complete match verdict", () => {
  const health = fleetIntentHealth(summary({ unresolvedPolicies: 1 }))

  assert.equal(health.status, FLEET_INTENT_HEALTH_STATUS.REVIEW)
  assert.equal(health.title, "Fleet intent cannot be fully evaluated")
  assert.equal(health.matchMetric, "Review")
})

test("a one-zone fleet uses a singular match verdict", () => {
  const health = fleetIntentHealth(summary({
    governedRows: 1,
    matchingZones: 1,
    policies: 1,
    ungovernedRows: 0,
    zones: 1,
  }))

  assert.equal(health.title, "The loaded zone matches fleet intent")
})
