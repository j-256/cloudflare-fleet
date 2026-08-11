import assert from "node:assert/strict"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import {
  appendOperationActivity,
  finalizeOperationActivity,
  readOperationActivityDocument,
} from "../src/activity-store.mjs"
import {
  createEmptyFleetIntentDocument,
  FLEET_INTENT_GROUP_NAME_SOURCE,
  FLEET_INTENT_SCHEMA_VERSION,
} from "../src/fleet-intent.mjs"
import {
  FLEET_STATE_SCHEMA_VERSION,
  isFleetStateDocument,
} from "../src/fleet-state.mjs"
import {
  completeOperationActivity,
  createPendingOperationActivity,
  createVerificationGuards,
  OPERATION_ACTIVITY_STATUS,
} from "../src/operation-history.mjs"
import {
  persistFleetIntentDocument,
} from "../src/intent-store.mjs"
import {
  readFleetStateDocument,
  updateFleetStateDocument,
} from "../src/state-store.mjs"
import {
  WRITE_VERIFICATION_KIND,
} from "../src/write-verification.mjs"

const STARTED_AT = "2026-08-03T03:00:00.000Z"

async function fixture(context) {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "cloudflare-fleet-state-test."),
  )
  context.after(() => fs.rm(directory, {
    force: true,
    recursive: true,
  }))
  return {
    directory,
    stateFile: path.join(directory, "state.json"),
  }
}

function pendingActivity(id = "activity-one") {
  return createPendingOperationActivity(
    "Update zone setting",
    {
      plans: [{
        id: "plan-one",
        kind: "setting",
        operations: [{
          body: { value: "on" },
          currentValue: "off",
          label: "Set always_use_https",
          method: "PATCH",
          path: "zones/zone-one/settings/always_use_https",
        }],
        summary: "Update always_use_https on alpha.example",
        zoneId: "zone-one",
        zoneName: "alpha.example",
      }],
      validatedAt: STARTED_AT,
    },
    {
      id,
      startedAt: STARTED_AT,
    },
  )
}

test("fleet state wraps an existing intent document without losing it", async (context) => {
  const { stateFile } = await fixture(context)
  const intent = createEmptyFleetIntentDocument("account-one")
  intent.groups.push({
    id: "primary",
    members: [{ zoneId: "zone-one", zoneName: "alpha.example" }],
    mode: "members",
    name: "Primary",
    nameSource: FLEET_INTENT_GROUP_NAME_SOURCE.CUSTOM,
  })
  await fs.writeFile(stateFile, `${JSON.stringify(intent)}\n`)

  const state = await readFleetStateDocument(stateFile, "account-one")

  assert.equal(state.schemaVersion, FLEET_STATE_SCHEMA_VERSION)
  assert.deepEqual(state.intent, intent)
  assert.deepEqual(state.activity.entries, [])
  assert.equal(isFleetStateDocument(state, "account-one"), true)
})

test("fleet state migrates a legacy nested intent document without losing activity", async (context) => {
  const { stateFile } = await fixture(context)
  const legacy = await readFleetStateDocument(stateFile, "account-one")
  legacy.intent.schemaVersion = 3
  await fs.writeFile(stateFile, `${JSON.stringify(legacy)}\n`)

  const migrated = await readFleetStateDocument(stateFile, "account-one")

  assert.equal(migrated.intent.schemaVersion, FLEET_INTENT_SCHEMA_VERSION)
  assert.deepEqual(migrated.activity, legacy.activity)
  assert.equal(isFleetStateDocument(migrated, "account-one"), true)
})

test("operation activity persists alongside intent in one state file", async (context) => {
  const { stateFile } = await fixture(context)
  const pending = pendingActivity()
  const afterAppend = await appendOperationActivity(
    stateFile,
    "account-one",
    pending,
  )
  const completed = completeOperationActivity(pending, {
    execution: { completed: 1, total: 1 },
    inverse: { available: false, plans: [], reason: "Test" },
    status: OPERATION_ACTIVITY_STATUS.VERIFIED,
    verification: [],
  })
  const afterFinalize = await finalizeOperationActivity(
    stateFile,
    "account-one",
    completed,
  )
  const state = await readFleetStateDocument(stateFile, "account-one")

  assert.notEqual(afterAppend.revision, "")
  assert.notEqual(afterFinalize.revision, afterAppend.revision)
  assert.equal(state.activity.entries[0].status, OPERATION_ACTIVITY_STATUS.VERIFIED)
  assert.equal(state.intent.revision, "")
  assert.deepEqual(
    await readOperationActivityDocument(stateFile, "account-one"),
    state.activity,
  )
  assert.equal((await fs.stat(stateFile)).mode & 0o777, 0o600)
})

test("concurrent operation starts merge without a stale document overwrite", async (context) => {
  const { stateFile } = await fixture(context)
  await Promise.all([
    appendOperationActivity(stateFile, "account-one", pendingActivity("activity-left")),
    appendOperationActivity(stateFile, "account-one", pendingActivity("activity-right")),
  ])

  const activity = await readOperationActivityDocument(stateFile, "account-one")
  assert.deepEqual(
    activity.entries.map((entry) => entry.id).sort(),
    ["activity-left", "activity-right"],
  )
})

test("concurrent intent and activity updates preserve both state sections", async (context) => {
  const { stateFile } = await fixture(context)
  const intent = createEmptyFleetIntentDocument("account-one")
  intent.groups.push({
    id: "primary",
    members: [{ zoneId: "zone-one", zoneName: "alpha.example" }],
    mode: "members",
    name: "Primary",
    nameSource: FLEET_INTENT_GROUP_NAME_SOURCE.CUSTOM,
  })

  await Promise.all([
    appendOperationActivity(
      stateFile,
      "account-one",
      pendingActivity("activity-concurrent"),
    ),
    persistFleetIntentDocument(
      stateFile,
      "account-one",
      intent.revision,
      intent,
    ),
  ])

  const state = await readFleetStateDocument(stateFile, "account-one")
  assert.equal(state.intent.groups.some((group) => group.id === "primary"), true)
  assert.equal(state.activity.entries[0].id, "activity-concurrent")
})

test("state lock release preserves a successor writer's lock", async (context) => {
  const { directory, stateFile } = await fixture(context)
  const lockPath = `${stateFile}.lock`
  const replacedLockPath = `${lockPath}.replaced`
  const successorOwner = {
    pid: process.pid,
    token: "successor-owner",
  }

  await updateFleetStateDocument(stateFile, "account-one", async (current) => {
    await fs.rename(lockPath, replacedLockPath)
    await fs.mkdir(lockPath, { mode: 0o700 })
    await fs.writeFile(
      path.join(lockPath, "owner.json"),
      `${JSON.stringify(successorOwner)}\n`,
      { mode: 0o600 },
    )
    await fs.rm(replacedLockPath, { recursive: true })
    return current
  })

  assert.deepEqual(
    JSON.parse(await fs.readFile(path.join(lockPath, "owner.json"), "utf8")),
    successorOwner,
  )
  await fs.rm(lockPath, { recursive: true })
  assert.deepEqual(await fs.readdir(directory), ["state.json"])
})

test("state store does not reclaim a stale lock owned by a live process", async (context) => {
  const { stateFile } = await fixture(context)
  const lockPath = `${stateFile}.lock`
  await fs.mkdir(lockPath, { mode: 0o700 })
  await fs.writeFile(
    path.join(lockPath, "owner.json"),
    `${JSON.stringify({ pid: process.pid, token: "live-owner" })}\n`,
    { mode: 0o600 },
  )
  const staleTime = new Date(Date.now() - 60000)
  await fs.utimes(lockPath, staleTime, staleTime)

  await assert.rejects(
    updateFleetStateDocument(
      stateFile,
      "account-one",
      (current) => current,
    ),
    /Fleet state store is busy/,
  )
  assert.deepEqual(
    JSON.parse(await fs.readFile(path.join(lockPath, "owner.json"), "utf8")),
    { pid: process.pid, token: "live-owner" },
  )
})

test("concurrent guarded undo starts allow only one active inverse", async (context) => {
  const { stateFile } = await fixture(context)
  const pending = pendingActivity("activity-parent")
  await appendOperationActivity(stateFile, "account-one", pending)
  const inversePlans = [{
    ...pending.plans[0],
    id: "undo-plan-one",
    kind: "operation-undo",
    operations: [{
      body: { value: "off" },
      currentValue: "on",
      label: "Undo: Set always_use_https",
      method: "PATCH",
      path: "zones/zone-one/settings/always_use_https",
    }],
    summary: "Undo always_use_https on alpha.example",
  }]
  const completed = completeOperationActivity(pending, {
    execution: { completed: 1, total: 1 },
    inverse: {
      available: true,
      plans: inversePlans,
      reason: "Guard required",
    },
    status: OPERATION_ACTIVITY_STATUS.VERIFIED,
    verification: createVerificationGuards([{
      response: { result: { id: "always_use_https", value: "on" } },
      target: {
        kind: WRITE_VERIFICATION_KIND.SETTING,
        settingId: "always_use_https",
        zoneId: "zone-one",
      },
    }]),
  })
  await finalizeOperationActivity(stateFile, "account-one", completed)
  const undo = (id) => createPendingOperationActivity(
    "Undo Update zone setting",
    {
      plans: inversePlans,
      validatedAt: STARTED_AT,
    },
    {
      id,
      startedAt: STARTED_AT,
      undoOf: completed.id,
    },
  )

  const attempts = await Promise.allSettled([
    appendOperationActivity(stateFile, "account-one", undo("activity-undo-left")),
    appendOperationActivity(stateFile, "account-one", undo("activity-undo-right")),
  ])
  const activity = await readOperationActivityDocument(stateFile, "account-one")

  assert.deepEqual(
    attempts.map((attempt) => attempt.status).sort(),
    ["fulfilled", "rejected"],
  )
  assert.equal(
    activity.entries.filter((entry) => entry.undoOf === completed.id).length,
    1,
  )
})

test("activity finalization rejects a changed reviewed plan", async (context) => {
  const { stateFile } = await fixture(context)
  const pending = pendingActivity()
  await appendOperationActivity(stateFile, "account-one", pending)
  const completed = completeOperationActivity(pending, {
    execution: { completed: 1, total: 1 },
    inverse: { available: false, plans: [], reason: "Test" },
    status: OPERATION_ACTIVITY_STATUS.VERIFIED,
    verification: [],
  })
  completed.plans[0].operations[0].body.value = "changed"

  await assert.rejects(
    finalizeOperationActivity(stateFile, "account-one", completed),
    /changed its reviewed plan/,
  )
})
