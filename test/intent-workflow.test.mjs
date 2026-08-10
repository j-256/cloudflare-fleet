import assert from "node:assert/strict"
import test from "node:test"

import {
  createIntentWorkflowNavigation,
  INTENT_WORKFLOW_SCREEN,
  intentWorkflowPath,
} from "../src/intent-workflow.mjs"

test("intent workflow navigation preserves suspended parent entries", () => {
  const navigation = createIntentWorkflowNavigation()
  const manager = { screen: INTENT_WORKFLOW_SCREEN.MANAGER }
  const adoption = { screen: INTENT_WORKFLOW_SCREEN.ADOPTION }
  const group = { screen: INTENT_WORKFLOW_SCREEN.GROUP }

  navigation.begin(manager)
  navigation.push(adoption)
  navigation.push(group)

  assert.equal(navigation.depth(), 3)
  assert.equal(navigation.active(), group)
  assert.equal(
    intentWorkflowPath(navigation.entries()),
    "Fleet intent / Review ungoverned drift / Saved scope",
  )

  const popped = navigation.pop()
  assert.equal(popped.removed, group)
  assert.equal(popped.active, adoption)
  assert.equal(navigation.active(), adoption)
})

test("intent workflow navigation can hide, restore, and clear one routed unit", () => {
  const navigation = createIntentWorkflowNavigation()
  const policy = { screen: INTENT_WORKFLOW_SCREEN.POLICY }

  navigation.begin(policy)
  navigation.hide()
  assert.equal(navigation.isVisible(), false)
  assert.equal(navigation.active(), policy)

  assert.equal(navigation.restore(), policy)
  assert.equal(navigation.isVisible(), true)
  assert.deepEqual(navigation.clear(), [policy])
  assert.equal(navigation.depth(), 0)
  assert.equal(navigation.active(), null)
})

test("intent workflow paths always identify the fleet intent workspace", () => {
  assert.equal(
    intentWorkflowPath([{ screen: INTENT_WORKFLOW_SCREEN.POLICY }]),
    "Fleet intent / Facet policy",
  )
  assert.equal(
    intentWorkflowPath([{ screen: INTENT_WORKFLOW_SCREEN.MANAGER }]),
    "Fleet intent",
  )
})
