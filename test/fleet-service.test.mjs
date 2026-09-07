import assert from "node:assert/strict"
import path from "node:path"
import test from "node:test"

import {
  FleetIntentRevisionConflictError,
} from "../src/activity-store.mjs"
import {
  ALIGNMENT_PREPARATION_STATUS,
} from "../src/alignment-service.mjs"
import {
  createFleetService,
  FleetIntentChangedError,
  FLEET_SERVICE_STATUS,
} from "../src/fleet-service.mjs"
import {
  createEmptyFleetIntentDocument,
  FLEET_INTENT_GROUP_MODE,
  FLEET_INTENT_GROUP_NAME_SOURCE,
  replaceFleetIntentGroup,
} from "../src/fleet-intent.mjs"
import {
  createVerificationGuards,
  OPERATION_ACTIVITY_STATUS,
} from "../src/operation-history.mjs"
import { AlignmentPlanChangedError } from "../src/write-executor.mjs"

const SELECTOR = Object.freeze({ policyId: "policy-one" })
const BATCH_SELECTORS = Object.freeze([
  SELECTOR,
  Object.freeze({ policyId: "policy-two" }),
])
const PLAN_SET = Object.freeze({
  digest: "sha256:approved",
  intentRevision: "intent-one",
  plans: [{
    operations: [{
      body: { value: "on" },
      label: "Enable HTTPS",
      method: "PATCH",
      path: "zones/zone-one/settings/always_use_https",
    }],
  }],
  validatedAt: "2026-08-12T00:00:00.000Z",
})
const CHANGE = Object.freeze({
  desired: "on",
  kind: "zone-setting-update",
  settingId: "always_use_https",
  zoneId: "zone-one",
})
const CHANGE_PLAN_SET = Object.freeze({
  digest: "sha256:approved",
  plans: [{
    operations: [{
      body: { value: "on" },
      label: "Enable HTTPS",
      method: "PATCH",
      path: "zones/zone-one/settings/always_use_https",
    }],
    zoneId: "zone-one",
    zoneName: "one.example",
  }],
  preview: [],
  request: CHANGE,
  validatedAt: "2026-08-12T00:00:00.000Z",
})

function preparation(overrides = {}) {
  return {
    assessment: {
      actionableCount: 1,
      available: true,
      blockers: [],
      reason: "One target differs",
      targetCount: 1,
      targetZones: [{ zoneId: "zone-one", zoneName: "one.example" }],
    },
    facet: {
      category: "settings",
      key: "always_use_https",
      label: "Always Use HTTPS",
      phase: "",
    },
    planSet: PLAN_SET,
    reason: "One target differs",
    selector: SELECTOR,
    status: ALIGNMENT_PREPARATION_STATUS.PLANNED,
    ...overrides,
  }
}

function batchPreparation(overrides = {}) {
  return {
    alignments: [
      preparation(),
      preparation({
        facet: {
          category: "settings",
          key: "early_hints",
          label: "Early Hints",
          phase: "",
        },
        selector: BATCH_SELECTORS[1],
      }),
    ].map(({ planSet: _planSet, ...entry }) => entry),
    planSet: {
      ...PLAN_SET,
      selectors: BATCH_SELECTORS,
    },
    reason: "Two targets differ",
    selectors: BATCH_SELECTORS,
    status: ALIGNMENT_PREPARATION_STATUS.PLANNED,
    ...overrides,
  }
}

function serviceFixture(overrides = {}) {
  const calls = {
    baselineInventories: [],
    batchBaselineInventories: [],
    loadInventory: 0,
  }
  const events = []
  let stateReads = 0
  const currentRevision = overrides.currentRevision || (() => "intent-one")
  const service = createFleetService({
    accountId: "account-one",
    api: { accountId: "account-one" },
    baselineInventoryTtlMs: overrides.baselineInventoryTtlMs,
    appendActivity: overrides.appendActivity || (async () => ({ entries: [] })),
    executePlanSet: overrides.executePlanSet || (async (options) => {
      events.push("execute")
      await options.beforeExecute?.()
      const verificationEntries = await options.verify([{
        kind: "setting",
        settingId: "always_use_https",
        zoneId: "zone-one",
      }])
      return {
        activity: {
          execution: { completed: 1, total: 1 },
          id: "activity-one",
          status: OPERATION_ACTIVITY_STATUS.VERIFIED,
        },
        error: null,
        executionResults: [{}],
        historyError: null,
        inverse: { available: true, plans: [] },
        status: OPERATION_ACTIVITY_STATUS.VERIFIED,
        verificationEntries,
      }
    }),
    finalizeActivity: async () => ({ entries: [] }),
    listCandidates: overrides.listCandidates || (() => ({
      candidates: [{
        assessment: { actionableCount: 1, available: true },
        facet: { label: "Always Use HTTPS" },
        selector: SELECTOR,
      }],
      inventory: { privatePayload: true },
      summary: { candidates: 1, zones: 1 },
    })),
    loadInventory: overrides.loadInventory || (async () => {
      calls.loadInventory += 1
      return { zones: [] }
    }),
    prepareAlignment: overrides.prepareAlignment || (async (_api, _intent, _selector, options) => {
      calls.baselineInventories.push(options.baselineInventory)
      return preparation()
    }),
    prepareAlignments: overrides.prepareAlignments || (async (_api, _intent, _selectors, options) => {
      calls.batchBaselineInventories.push(options.baselineInventory)
      return batchPreparation()
    }),
    ...(overrides.persistIntent ? { persistIntent: overrides.persistIntent } : {}),
    ...(overrides.prepareChange ? { prepareChange: overrides.prepareChange } : {}),
    ...(overrides.prepareIntentChange
      ? { prepareIntentChange: overrides.prepareIntentChange }
      : {}),
    now: overrides.now,
    readActivity: overrides.readActivity || (async () => ({
      entries: [
        { id: "older", startedAt: "2026-08-11T00:00:00.000Z" },
        { id: "newer", startedAt: "2026-08-12T00:00:00.000Z" },
      ],
      revision: "activity-one",
      updatedAt: "2026-08-12T00:00:00.000Z",
    })),
    ...(overrides.readIntent ? { readIntent: overrides.readIntent } : {}),
    ...(overrides.readPolicy ? { readPolicy: overrides.readPolicy } : {}),
    readState: overrides.readState || (async () => {
      stateReads += 1
      return { intent: { revision: currentRevision(stateReads) } }
    }),
    readVerificationTarget: overrides.readVerificationTarget || (async (_api, target) => ({
      response: { result: { value: "on" }, status: 200 },
      target,
    })),
    stateFile: path.resolve("test-results/fleet-service-state.json"),
    withWriteLock: overrides.withWriteLock || (async (operation) => {
      events.push("lock")
      return operation()
    }),
  })
  return { calls, events, service }
}

test("fleet service lists public alignment candidates without returning raw inventory", async () => {
  const { service } = serviceFixture()

  const result = await service.listAlignments()

  assert.equal(result.status, FLEET_SERVICE_STATUS.OK)
  assert.equal(result.accountId, "account-one")
  assert.equal(result.candidates.length, 1)
  assert.equal(Object.hasOwn(result, "inventory"), false)
  assert.doesNotMatch(JSON.stringify(result), /privatePayload/)
})

test("fleet service returns a digest-bound read-only alignment plan", async () => {
  const { service } = serviceFixture()

  const result = await service.planAlignment(SELECTOR)

  assert.equal(result.status, ALIGNMENT_PREPARATION_STATUS.PLANNED)
  assert.equal(result.planSet.digest, "sha256:approved")
  assert.deepEqual(result.selector, SELECTOR)
})

test("fleet service reuses the candidate inventory as a planning baseline", async () => {
  const { calls, service } = serviceFixture()

  await service.listAlignments()
  await service.planAlignment(SELECTOR)

  assert.equal(calls.loadInventory, 1)
  assert.equal(calls.baselineInventories.length, 1)
})

test("fleet service misses a cached baseline after intent changes", async () => {
  const { calls, service } = serviceFixture({
    currentRevision(read) {
      return read === 1 ? "intent-one" : "intent-two"
    },
  })

  await service.listAlignments()
  await service.planAlignment(SELECTOR)

  assert.equal(calls.loadInventory, 1)
  assert.deepEqual(calls.baselineInventories, [null])
})

test("fleet service misses an expired planning baseline", async () => {
  let clock = 0
  const { calls, service } = serviceFixture({
    baselineInventoryTtlMs: 10,
    now: () => clock,
  })

  await service.listAlignments()
  clock = 11
  await service.planAlignment(SELECTOR)

  assert.equal(calls.loadInventory, 1)
  assert.deepEqual(calls.baselineInventories, [null])
})

test("fleet service plans and applies one digest-bound alignment batch", async () => {
  const { calls, events, service } = serviceFixture()

  const plan = await service.planAlignments(BATCH_SELECTORS)
  const result = await service.applyAlignments(
    BATCH_SELECTORS,
    "sha256:approved",
  )

  assert.equal(plan.status, ALIGNMENT_PREPARATION_STATUS.PLANNED)
  assert.deepEqual(plan.selectors, BATCH_SELECTORS)
  assert.equal(result.status, OPERATION_ACTIVITY_STATUS.VERIFIED)
  assert.deepEqual(result.selectors, BATCH_SELECTORS)
  assert.equal(calls.loadInventory, 0)
  assert.equal(calls.batchBaselineInventories.length, 2)
  assert.deepEqual(events, ["lock", "execute"])
})

test("fleet service rejects a changed batch digest before execution", async () => {
  const { events, service } = serviceFixture()

  await assert.rejects(
    service.applyAlignments(BATCH_SELECTORS, "sha256:reviewed"),
    (error) => error instanceof AlignmentPlanChangedError
      && error.actualDigest === "sha256:approved",
  )
  assert.deepEqual(events, ["lock"])
})

test("fleet service invalidates the baseline after execution", async () => {
  const { calls, service } = serviceFixture()

  await service.listAlignments()
  await service.planAlignment(SELECTOR)
  await service.applyAlignment(SELECTOR, "sha256:approved")
  await service.planAlignment(SELECTOR)

  assert.equal(calls.loadInventory, 1)
  assert.deepEqual(calls.baselineInventories, [{ zones: [] }, { zones: [] }, null])
})

test("fleet service applies an unchanged plan inside the exclusive write scope", async () => {
  const { events, service } = serviceFixture()

  const result = await service.applyAlignment(SELECTOR, "sha256:approved")

  assert.equal(result.status, OPERATION_ACTIVITY_STATUS.VERIFIED)
  assert.equal(result.applied, true)
  assert.deepEqual(result.execution, { completed: 1, total: 1 })
  assert.equal(result.verification[0].status, 200)
  assert.deepEqual(events, ["lock", "execute"])
})

test("fleet service rejects a newly calculated digest before execution", async () => {
  const { events, service } = serviceFixture()

  await assert.rejects(
    service.applyAlignment(SELECTOR, "sha256:reviewed"),
    (error) => error instanceof AlignmentPlanChangedError
      && error.actualDigest === "sha256:approved",
  )
  assert.deepEqual(events, ["lock"])
})

test("fleet service rejects an intent revision change immediately before execution", async () => {
  const { service } = serviceFixture({
    currentRevision(read) {
      return read === 1 ? "intent-one" : "intent-two"
    },
  })

  await assert.rejects(
    service.applyAlignment(SELECTOR, "sha256:approved"),
    (error) => error instanceof FleetIntentChangedError,
  )
})

test("fleet service translates an atomic activity revision conflict into plan change", async () => {
  const { service } = serviceFixture({
    appendActivity: async () => {
      throw new FleetIntentRevisionConflictError("intent-one", "intent-two")
    },
    executePlanSet: async (options) => {
      await options.beforeExecute()
      await options.activityStore.append({})
    },
  })

  await assert.rejects(
    service.applyAlignment(SELECTOR, "sha256:approved"),
    (error) => error instanceof FleetIntentChangedError,
  )
})

test("fleet service returns aligned and blocked preparations without executing", async () => {
  for (const status of [
    ALIGNMENT_PREPARATION_STATUS.ALIGNED,
    ALIGNMENT_PREPARATION_STATUS.BLOCKED,
  ]) {
    const { events, service } = serviceFixture({
      prepareAlignment: async () => preparation({
        planSet: null,
        status,
      }),
    })
    const result = await service.applyAlignment(SELECTOR, "sha256:approved")
    assert.equal(result.status, status)
    assert.equal(result.applied, false)
    assert.deepEqual(events, ["lock"])
  }
})

test("fleet service returns activity newest first", async () => {
  const { service } = serviceFixture()

  const result = await service.listActivity()

  assert.deepEqual(result.entries.map((entry) => entry.id), ["newer", "older"])
})

test("fleet service plans and applies bounded direct changes under the write lock", async () => {
  let preparations = 0
  const policies = []
  const { events, service } = serviceFixture({
    prepareChange: async (_api, _change, options) => {
      preparations += 1
      policies.push(await options.readPolicy())
      return {
        change: CHANGE,
        planSet: CHANGE_PLAN_SET,
        reason: "One bounded write prepared",
        status: "planned",
        title: "Update zone setting",
      }
    },
  })

  const plan = await service.planChange(CHANGE)
  const result = await service.applyChange(CHANGE, "sha256:approved")

  assert.equal(plan.planSet.digest, "sha256:approved")
  assert.equal(result.status, OPERATION_ACTIVITY_STATUS.VERIFIED)
  assert.equal(result.applied, true)
  assert.equal(preparations, 2)
  assert.deepEqual(policies, [
    { emailDnsRecordExceptions: [], schemaVersion: 1 },
    { emailDnsRecordExceptions: [], schemaVersion: 1 },
  ])
  assert.deepEqual(events, ["lock", "execute"])
})

test("fleet service atomically plans and persists complete intent documents", async () => {
  const current = createEmptyFleetIntentDocument("account-one")
  const desired = replaceFleetIntentGroup(current, {
    id: "production",
    members: [{ zoneId: "zone-one", zoneName: "one.example" }],
    mode: FLEET_INTENT_GROUP_MODE.MEMBERS,
    name: "Production",
    nameSource: FLEET_INTENT_GROUP_NAME_SOURCE.CUSTOM,
  })
  const persisted = {
    ...desired,
    revision: "b".repeat(64),
    updatedAt: "2026-08-28T00:00:00.000Z",
  }
  const persistenceCalls = []
  const { events, service } = serviceFixture({
    persistIntent: async (...arguments_) => {
      persistenceCalls.push(arguments_)
      return persisted
    },
    readIntent: async () => current,
  })

  const shown = await service.getIntent()
  const plan = await service.planIntent(desired)
  const result = await service.applyIntent(desired, plan.planSet.digest)

  assert.deepEqual(shown.document, current)
  assert.deepEqual(plan.diff.groups.added, ["production"])
  assert.equal(result.status, "saved")
  assert.equal(result.document.revision, "b".repeat(64))
  assert.equal(persistenceCalls.length, 1)
  assert.deepEqual(events, ["lock"])
})

test("fleet service plans and executes guarded undo only while live state matches", async () => {
  const target = {
    kind: "setting",
    settingId: "always_use_https",
    zoneId: "zone-one",
  }
  const liveEntry = {
    response: { result: { value: "on" }, status: 200 },
    target,
  }
  const entry = {
    id: "activity-one",
    inverse: {
      available: true,
      plans: [{
        id: "undo:setting",
        kind: "operation-undo",
        operations: [{
          body: { value: "off" },
          currentValue: "on",
          label: "Undo: Enable HTTPS",
          method: "PATCH",
          path: "zones/zone-one/settings/always_use_https",
        }],
        summary: "Undo Enable HTTPS",
        zoneId: "zone-one",
        zoneName: "one.example",
      }],
      reason: "Live state must still match",
    },
    status: OPERATION_ACTIVITY_STATUS.VERIFIED,
    title: "Enable HTTPS",
    verification: createVerificationGuards([liveEntry]),
  }
  const { events, service } = serviceFixture({
    readActivity: async () => ({
      entries: [entry],
      revision: "activity-revision",
      updatedAt: "2026-08-28T00:00:00.000Z",
    }),
    readVerificationTarget: async () => liveEntry,
  })

  const plan = await service.planActivityUndo("activity-one")
  const result = await service.applyActivityUndo(
    "activity-one",
    plan.planSet.digest,
  )

  assert.equal(plan.status, FLEET_SERVICE_STATUS.PLANNED)
  assert.equal(result.status, OPERATION_ACTIVITY_STATUS.VERIFIED)
  assert.equal(result.activityId, "activity-one")
  assert.deepEqual(events, ["lock", "execute"])
})

test("fleet service blocks guarded undo after live drift", async () => {
  const target = {
    kind: "setting",
    settingId: "always_use_https",
    zoneId: "zone-one",
  }
  const entry = {
    id: "activity-one",
    inverse: { available: true, plans: [], reason: "Reversible" },
    status: OPERATION_ACTIVITY_STATUS.VERIFIED,
    title: "Enable HTTPS",
    verification: createVerificationGuards([{
      response: { result: { value: "on" }, status: 200 },
      target,
    }]),
  }
  const { service } = serviceFixture({
    readActivity: async () => ({
      entries: [entry],
      revision: "activity-revision",
      updatedAt: "2026-08-28T00:00:00.000Z",
    }),
    readVerificationTarget: async () => ({
      response: { result: { value: "off" }, status: 200 },
      target,
    }),
  })

  const result = await service.planActivityUndo("activity-one")

  assert.equal(result.status, FLEET_SERVICE_STATUS.BLOCKED)
  assert.equal(result.planSet, null)
  assert.equal(result.differences.length, 1)
})
