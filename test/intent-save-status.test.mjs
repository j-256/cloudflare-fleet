import assert from "node:assert/strict"
import test from "node:test"

import {
  FLEET_INTENT_SAVE_STATUS,
  intentSaveStatusPresentation,
  resolveIntentSaveStatus,
} from "../src/intent-save-status.mjs"

test("intent save status stays visibly pending until persistence finishes", () => {
  const status = resolveIntentSaveStatus({
    failureMessage: "",
    readOnly: false,
    saving: true,
    transportAvailable: true,
    updatedAt: "2026-08-05T01:20:00.000Z",
    usesBroker: true,
  })

  assert.equal(status, FLEET_INTENT_SAVE_STATUS.SAVING)
  assert.deepEqual(intentSaveStatusPresentation(status), {
    label: "Saving...",
    modifier: "saving",
    title: "Fleet intent is being saved to project state",
  })
})

test("intent save status confirms the broker-provided save time", () => {
  const status = resolveIntentSaveStatus({
    failureMessage: "",
    readOnly: false,
    saving: false,
    transportAvailable: true,
    updatedAt: "2026-08-05T01:20:00.000Z",
    usesBroker: true,
  })

  assert.equal(status, FLEET_INTENT_SAVE_STATUS.SAVED)
  assert.deepEqual(
    intentSaveStatusPresentation(status, { savedAtLabel: "Aug 5, 1:20 AM" }),
    {
      label: "Saved Aug 5, 1:20 AM",
      modifier: "saved",
      title: "Fleet intent was saved to project state Aug 5, 1:20 AM",
    },
  )
})

test("intent save status keeps persistence failures visible", () => {
  const failureMessage = "Project state could not be written"
  const status = resolveIntentSaveStatus({
    failureMessage,
    readOnly: false,
    saving: false,
    transportAvailable: true,
    updatedAt: "2026-08-05T01:20:00.000Z",
    usesBroker: true,
  })

  assert.equal(status, FLEET_INTENT_SAVE_STATUS.FAILED)
  assert.deepEqual(
    intentSaveStatusPresentation(status, { failureMessage }),
    {
      label: "Save failed",
      modifier: "failed",
      title: failureMessage,
    },
  )
})

test("intent save status distinguishes unsaved, read-only, and offline sessions", () => {
  const base = {
    failureMessage: "",
    readOnly: false,
    saving: false,
    transportAvailable: true,
    updatedAt: null,
    usesBroker: true,
  }

  assert.equal(
    resolveIntentSaveStatus(base),
    FLEET_INTENT_SAVE_STATUS.UNSAVED,
  )
  assert.equal(
    resolveIntentSaveStatus({ ...base, readOnly: true }),
    FLEET_INTENT_SAVE_STATUS.READ_ONLY,
  )
  assert.equal(
    resolveIntentSaveStatus({ ...base, transportAvailable: false }),
    FLEET_INTENT_SAVE_STATUS.OFFLINE,
  )
  assert.equal(
    resolveIntentSaveStatus({ ...base, usesBroker: false }),
    FLEET_INTENT_SAVE_STATUS.UNAVAILABLE,
  )
})
