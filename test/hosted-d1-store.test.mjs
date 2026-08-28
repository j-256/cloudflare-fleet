import assert from "node:assert/strict"
import test from "node:test"

import {
  createCacheRecord,
} from "../src/cache.mjs"
import {
  createEmptyFleetIntentDocument,
} from "../src/fleet-intent.mjs"
import {
  appendHostedOperationActivity,
  finalizeHostedOperationActivity,
  HostedFleetIntentRevisionConflictError,
  persistHostedCacheRecord,
  persistHostedFleetIntent,
  readHostedCacheRecord,
  readHostedFleetIntent,
  readHostedOperationActivity,
} from "../src/hosted/d1-store.mjs"
import {
  completeOperationActivity,
  createPendingOperationActivity,
  createVerificationGuards,
  OPERATION_ACTIVITY_STATUS,
} from "../src/operation-history.mjs"
import {
  WRITE_VERIFICATION_KIND,
} from "../src/write-verification.mjs"
import {
  hostedD1Fixture,
} from "./hosted-d1.fixture.mjs"

const ACCOUNT_ID = "account-one"
const STARTED_AT = "2026-08-12T01:00:00.000Z"
const COMPLETED_AT = "2026-08-12T01:01:00.000Z"

function pendingActivity(id, options = {}) {
  return createPendingOperationActivity(
    options.title || "Update zone setting",
    {
      plans: [{
        id: `plan-${id}`,
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
      undoOf: options.undoOf || null,
    },
  )
}

function completedActivity(pending, options = {}) {
  const reversible = Boolean(options.reversible)
  return completeOperationActivity(pending, {
    completedAt: COMPLETED_AT,
    execution: { completed: 1, total: 1 },
    inverse: reversible
      ? {
          available: true,
          plans: pending.plans,
          reason: "Guard required",
        }
      : {
          available: false,
          plans: [],
          reason: "Test",
        },
    status: OPERATION_ACTIVITY_STATUS.VERIFIED,
    verification: reversible
      ? createVerificationGuards([{
          response: { result: { id: "always_use_https", value: "on" } },
          target: {
            kind: WRITE_VERIFICATION_KIND.SETTING,
            settingId: "always_use_https",
            zoneId: "zone-one",
          },
        }])
      : [],
  })
}

function cacheRecord(loadedAt, updatedAt, zoneName) {
  return createCacheRecord(ACCOUNT_ID, {
    account: {
      emailAddresses: { ok: true, result: [] },
      id: ACCOUNT_ID,
    },
    loadedAt,
    zones: [{ meta: { id: `zone-${zoneName}`, name: zoneName } }],
  }, { updatedAt })
}

test("hosted D1 intent saves use atomic revisions", async (context) => {
  const db = hostedD1Fixture(context)
  const initial = await readHostedFleetIntent(db, ACCOUNT_ID)

  assert.deepEqual(initial, createEmptyFleetIntentDocument(ACCOUNT_ID))

  const left = structuredClone(initial)
  const right = structuredClone(initial)
  const saved = await persistHostedFleetIntent(
    db,
    ACCOUNT_ID,
    initial.revision,
    left,
  )

  assert.match(saved.revision, /^[a-f0-9]{64}$/)
  assert.ok(saved.updatedAt)
  await assert.rejects(
    persistHostedFleetIntent(db, ACCOUNT_ID, initial.revision, right),
    (error) => error instanceof HostedFleetIntentRevisionConflictError
      && error.currentDocument.revision === saved.revision,
  )
})

test("hosted D1 activity appends do not clobber concurrent entries", async (context) => {
  const db = hostedD1Fixture(context)
  const [left, right] = await Promise.all([
    appendHostedOperationActivity(db, ACCOUNT_ID, pendingActivity("activity-left")),
    appendHostedOperationActivity(db, ACCOUNT_ID, pendingActivity("activity-right")),
  ])
  const document = await readHostedOperationActivity(db, ACCOUNT_ID)

  assert.ok(left.entries.some((entry) => entry.id === "activity-left"))
  assert.ok(right.entries.some((entry) => entry.id === "activity-right"))
  assert.deepEqual(
    document.entries.map((entry) => entry.id).sort(),
    ["activity-left", "activity-right"],
  )
  assert.match(document.revision, /^[a-f0-9]{64}$/)
})

test("hosted D1 activity finalizes a pending entry only once", async (context) => {
  const db = hostedD1Fixture(context)
  const pending = pendingActivity("activity-finalize")
  const completed = completedActivity(pending)
  await appendHostedOperationActivity(db, ACCOUNT_ID, pending)
  const document = await finalizeHostedOperationActivity(
    db,
    ACCOUNT_ID,
    completed,
  )

  assert.equal(document.entries[0].status, OPERATION_ACTIVITY_STATUS.VERIFIED)
  await assert.rejects(
    finalizeHostedOperationActivity(db, ACCOUNT_ID, completed),
    /already complete/,
  )
})

test("hosted D1 activity permits only one active guarded undo", async (context) => {
  const db = hostedD1Fixture(context)
  const parent = pendingActivity("activity-parent")
  await appendHostedOperationActivity(db, ACCOUNT_ID, parent)
  await finalizeHostedOperationActivity(
    db,
    ACCOUNT_ID,
    completedActivity(parent, { reversible: true }),
  )
  const results = await Promise.allSettled([
    appendHostedOperationActivity(
      db,
      ACCOUNT_ID,
      pendingActivity("activity-undo-left", { undoOf: parent.id }),
    ),
    appendHostedOperationActivity(
      db,
      ACCOUNT_ID,
      pendingActivity("activity-undo-right", { undoOf: parent.id }),
    ),
  ])
  const document = await readHostedOperationActivity(db, ACCOUNT_ID)

  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1)
  assert.equal(results.filter((result) => result.status === "rejected").length, 1)
  assert.equal(document.entries.filter((entry) => entry.undoOf === parent.id).length, 1)
})

test("hosted D1 cache keeps full-audit freshness separate from patch time", async (context) => {
  const db = hostedD1Fixture(context)
  const loadedAt = "2026-08-12T01:00:00.000Z"
  await persistHostedCacheRecord(
    db,
    ACCOUNT_ID,
    cacheRecord(loadedAt, loadedAt, "alpha.example"),
  )
  await persistHostedCacheRecord(
    db,
    ACCOUNT_ID,
    cacheRecord(loadedAt, "2026-08-12T02:00:00.000Z", "patched.example"),
  )

  const record = await readHostedCacheRecord(db, ACCOUNT_ID)

  assert.equal(record.loadedAt, loadedAt)
  assert.equal(record.updatedAt, "2026-08-12T02:00:00.000Z")
  assert.equal(record.inventory.zones[0].meta.name, "patched.example")
})

test("hosted D1 cache rejects records for another account", async (context) => {
  const db = hostedD1Fixture(context)
  const record = cacheRecord(
    "2026-08-12T01:00:00.000Z",
    "2026-08-12T01:00:00.000Z",
    "alpha.example",
  )
  record.accountId = "account-two"

  await assert.rejects(
    persistHostedCacheRecord(db, ACCOUNT_ID, record),
    /invalid for this account/,
  )
})
