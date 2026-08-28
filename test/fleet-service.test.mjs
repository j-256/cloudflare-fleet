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
import { OPERATION_ACTIVITY_STATUS } from "../src/operation-history.mjs"
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
      await options.beforeExecute()
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
    now: overrides.now,
    readActivity: overrides.readActivity || (async () => ({
      entries: [
        { id: "older", startedAt: "2026-08-11T00:00:00.000Z" },
        { id: "newer", startedAt: "2026-08-12T00:00:00.000Z" },
      ],
      revision: "activity-one",
      updatedAt: "2026-08-12T00:00:00.000Z",
    })),
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

  assert.equal(calls.loadInventory, 2)
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

  assert.equal(calls.loadInventory, 2)
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
  assert.equal(calls.loadInventory, 1)
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

  await service.planAlignment(SELECTOR)
  await service.applyAlignment(SELECTOR, "sha256:approved")
  await service.planAlignment(SELECTOR)

  assert.equal(calls.loadInventory, 2)
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
