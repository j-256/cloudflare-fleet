import assert from "node:assert/strict"
import test from "node:test"

import {
  OPERATION_ACTIVITY_STATUS,
} from "../src/operation-history.mjs"
import {
  AlignmentPlanChangedError,
  executeVerifiedPlanSet,
} from "../src/write-executor.mjs"

function operation(zoneId, settingId, currentValue, desiredValue) {
  return {
    body: { value: desiredValue },
    currentValue,
    label: `Set ${settingId}`,
    method: "PATCH",
    path: `zones/${zoneId}/settings/${settingId}`,
  }
}

function planSet(operations = [
  operation("zone-one", "always_use_https", "off", "on"),
]) {
  return {
    digest: "sha256:approved",
    plans: [{
      id: "plan-one",
      kind: "intent-alignment",
      operations,
      summary: "Align settings",
      zoneId: "zone-one",
      zoneName: "one.example",
    }],
    validatedAt: "2026-08-12T00:00:00.000Z",
  }
}

function activityStore(events) {
  return {
    async append(entry) {
      events.push(["activity", entry.status])
      return { entries: [entry] }
    },
    async finalize(entry) {
      events.push(["activity", entry.status])
      return { entries: [entry] }
    },
  }
}

function verificationEntry(target, value = "on") {
  return {
    response: {
      result: {
        id: target.settingId,
        value,
      },
      status: 200,
    },
    target,
  }
}

test("verified execution rejects a changed plan before journaling or writing", async () => {
  let writes = 0
  const api = {
    async executeOperation() {
      writes += 1
    },
  }

  await assert.rejects(
    executeVerifiedPlanSet({
      api,
      expectedDigest: "sha256:reviewed",
      planSet: planSet(),
      title: "Align settings",
      verify: async () => [],
    }),
    (error) => error instanceof AlignmentPlanChangedError
      && error.actualDigest === "sha256:approved",
  )
  assert.equal(writes, 0)
})

test("verified execution journals before writing and finalizes verified state", async () => {
  const events = []
  const api = {
    async executeOperation(entry) {
      events.push(["write", entry.path])
      return {
        result: { value: entry.body.value },
        status: 200,
      }
    },
  }
  const outcome = await executeVerifiedPlanSet({
    activityStore: activityStore(events),
    api,
    expectedDigest: "sha256:approved",
    planSet: planSet(),
    title: "Align settings",
    async verify(targets) {
      events.push(["verify", targets.length])
      return targets.map((target) => verificationEntry(target))
    },
  })

  assert.equal(outcome.ok, true)
  assert.equal(outcome.status, OPERATION_ACTIVITY_STATUS.VERIFIED)
  assert.equal(outcome.inverse.available, true)
  assert.deepEqual(events.map((entry) => entry[0]), [
    "activity",
    "write",
    "verify",
    "activity",
  ])
  assert.deepEqual(events[0], ["activity", OPERATION_ACTIVITY_STATUS.PENDING])
  assert.deepEqual(events[3], ["activity", OPERATION_ACTIVITY_STATUS.VERIFIED])
})

test("verified execution records partial write failure without a batch inverse", async () => {
  const events = []
  const plans = planSet([
    operation("zone-one", "always_use_https", "off", "on"),
    operation("zone-one", "min_tls_version", "1.0", "1.2"),
  ])
  let calls = 0
  const api = {
    async executeOperation(entry) {
      calls += 1
      events.push(["write", entry.path])
      if (calls === 2) throw new Error("Second write failed")
      return { result: { value: entry.body.value }, status: 200 }
    },
  }
  const outcome = await executeVerifiedPlanSet({
    activityStore: activityStore(events),
    api,
    planSet: plans,
    title: "Align settings",
    async verify(targets) {
      events.push(["verify", targets.length])
      return targets.map((target) => verificationEntry(target))
    },
  })

  assert.equal(outcome.ok, false)
  assert.equal(outcome.status, OPERATION_ACTIVITY_STATUS.WRITE_FAILED)
  assert.equal(outcome.executionResults.length, 1)
  assert.equal(outcome.activity.execution.completed, 1)
  assert.equal(outcome.activity.execution.total, 2)
  assert.equal(outcome.activity.inverse.available, false)
  assert.match(outcome.activity.error, /Second write failed/)
  assert.deepEqual(events.map((entry) => entry[0]), [
    "activity",
    "write",
    "write",
    "verify",
    "activity",
  ])
})

test("verified execution records verification failure after completed writes", async () => {
  const events = []
  const api = {
    async executeOperation(entry) {
      events.push(["write", entry.path])
      return { result: { value: entry.body.value }, status: 200 }
    },
  }
  let verificationCalls = 0
  const outcome = await executeVerifiedPlanSet({
    activityStore: activityStore(events),
    api,
    planSet: planSet(),
    title: "Align settings",
    async verify() {
      verificationCalls += 1
      throw new Error("Verification unavailable")
    },
  })

  assert.equal(outcome.ok, false)
  assert.equal(outcome.status, OPERATION_ACTIVITY_STATUS.VERIFICATION_FAILED)
  assert.equal(outcome.writesCompleted, true)
  assert.equal(verificationCalls, 2)
  assert.match(outcome.activity.error, /Verification unavailable/)
})

test("verified execution does not write when pending activity cannot be saved", async () => {
  let writes = 0
  const api = {
    async executeOperation() {
      writes += 1
    },
  }

  await assert.rejects(
    executeVerifiedPlanSet({
      activityStore: {
        async append() {
          throw new Error("State store unavailable")
        },
        async finalize() {},
      },
      api,
      planSet: planSet(),
      title: "Align settings",
      verify: async () => [],
    }),
    /State store unavailable/,
  )
  assert.equal(writes, 0)
})
