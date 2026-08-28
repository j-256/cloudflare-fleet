import assert from "node:assert/strict"
import test from "node:test"

import {
  completeIntentUndo,
  currentIntentUndo,
  prepareIntentUndoDocument,
  recordIntentUndo,
} from "../src/intent-undo.mjs"

function intent(revision, policyIds = []) {
  return {
    accountId: "account-id",
    policies: policyIds.map((id) => ({ id })),
    revision,
    updatedAt: `2026-08-09T20:00:0${revision.slice(-1)}.000Z`,
  }
}

test("intent undo records an isolated pre-save snapshot for the saved revision", () => {
  const before = intent("revision-0", ["policy-a"])
  const after = intent("revision-1", ["policy-a", "policy-b"])
  const stack = recordIntentUndo([], before, after, "Policy B saved")

  before.policies[0].id = "mutated"

  assert.equal(currentIntentUndo(stack, after), stack[0])
  assert.equal(stack[0].before.policies[0].id, "policy-a")
  assert.equal(currentIntentUndo(stack, intent("external-revision")), null)
})

test("intent undo restores prior content on top of the active revision", () => {
  const before = intent("revision-0", ["policy-a"])
  const after = intent("revision-1", ["policy-a", "policy-b"])
  const entry = recordIntentUndo([], before, after, "Policy B saved")[0]
  const restore = prepareIntentUndoDocument(entry, after)

  assert.deepEqual(restore.policies, [{ id: "policy-a" }])
  assert.equal(restore.revision, "revision-1")
  assert.equal(restore.updatedAt, after.updatedAt)
  assert.equal(prepareIntentUndoDocument(entry, intent("external-revision")), null)
})

test("completing undo reanchors the next older change to the restored revision", () => {
  const first = recordIntentUndo(
    [],
    intent("revision-0"),
    intent("revision-1", ["policy-a"]),
    "Policy A saved",
  )
  const second = recordIntentUndo(
    first,
    intent("revision-1", ["policy-a"]),
    intent("revision-2", ["policy-a", "policy-b"]),
    "Policy B saved",
  )
  const restored = intent("revision-3", ["policy-a"])
  const remaining = completeIntentUndo(second, restored)

  assert.equal(remaining.length, 1)
  assert.equal(remaining[0].description, "Policy A saved")
  assert.equal(currentIntentUndo(remaining, restored), remaining[0])
  assert.deepEqual(completeIntentUndo(remaining, intent("revision-4")), [])
})
