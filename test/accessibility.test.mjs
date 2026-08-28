import assert from "node:assert/strict"
import test from "node:test"

import { contextualActionLabel } from "../src/accessibility.mjs"

test("contextual action labels retain their visible text", () => {
  assert.equal(
    contextualActionLabel("Compare 2 values", "Observed values for DNSSEC"),
    "Compare 2 values: Observed values for DNSSEC",
  )
  assert.equal(contextualActionLabel("Activity 0", ""), "Activity 0")
})

test("contextual action labels require visible text", () => {
  assert.throws(
    () => contextualActionLabel("", "Operation history"),
    /require visible text/,
  )
})
