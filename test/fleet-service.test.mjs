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

function serviceFixture(overrides = {}) {
  const events = []
  let stateReads = 0
  const currentRevision = overrides.currentRevision || (() => "intent-one")
  const service = createFleetService({
    accountId: "account-one",
    api: { accountId: "account-one" },
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
    loadInventory: overrides.loadInventory || (async () => ({ zones: [] })),
    prepareAlignment: overrides.prepareAlignment || (async () => preparation()),
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
  return { events, service }
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
