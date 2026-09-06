import assert from "node:assert/strict"
import test from "node:test"
import { readFile } from "node:fs/promises"
import { normalizeWorkerInspection, projectInvocationEvidence } from "../src/worker-inspection.mjs"
import { CRON_PROPAGATION_MS } from "../src/worker-triggers.mjs"
import { isOperationActivityEntry } from "../src/operation-history.mjs"
import { workerFixture, disabledWorkerChange, WORKER_FIXTURE_TIME, WORKER_FIXTURE_SECRET } from "./worker.fixture.mjs"

test("focused inspection separates event outcomes and HTTP statuses without source or payload exposure", async () => {
  const fixture = workerFixture()
  const report = await fixture.service.inspect({ worker: "example-worker", zoneIds: ["example-zone"] })
  assert.equal(report.assessment.status, "mismatch")
  assert.equal(report.logs.value.invocations, 3)
  assert.equal(report.logs.value.groups.find((group) => group.eventType === "scheduled").count, 1)
  assert.equal(report.logs.value.httpStatuses.find((group) => group.status === 503).servingVersion, false)
  assert.equal(report.logs.value.httpStatuses.find((group) => group.status === 200).servingVersion, true)
  assert.deepEqual(report.logs.value.errorSignatures, ["missing-scheduled-handler"])
  assert.doesNotMatch(JSON.stringify(report), new RegExp(WORKER_FIXTURE_SECRET))
  assert.equal(fixture.state.calls.some((call) => /\/content$|\/workers\/scripts$|\/settings$/.test(call.path)), false)
})

test("sanitized upstream console reproduction has no required outcome or invocation count", async () => {
  const event = JSON.parse(await readFile(new URL("../docs/fixtures/observability-console-missing-outcome.json", import.meta.url), "utf8"))
  assert.equal(Object.hasOwn(event.$workers, "outcome"), false)
  const evidence = projectInvocationEvidence([event], normalizeWorkerInspection({ worker: "example-worker" }, event.timestamp + 1000))
  assert.equal(evidence.invocations, 0)
  assert.deepEqual(evidence.errorSignatures, ["missing-scheduled-handler"])
})

test("inspection remains useful after log denial and does not invent metadata coverage", async () => {
  const fixture = workerFixture({ logDenied: true })
  const report = await fixture.service.inspect({ findingId: "deep.worker-scheduled-handler-missing:example-worker" })
  assert.equal(report.assessment.status, "mismatch")
  assert.equal(report.logs.status, "unknown")
  assert.doesNotMatch(JSON.stringify(report), new RegExp(WORKER_FIXTURE_SECRET))
  fixture.state.schedulesDenied = true
  assert.equal((await fixture.service.inspect({ worker: "example-worker" })).assessment.status, "unknown")
  fixture.state.routeAccount = "another-account"
  const bounded = await fixture.service.inspect({ worker: "example-worker", zoneIds: ["example-zone"] })
  assert.equal(bounded.routes[0].status, "unknown")
  assert.equal(fixture.state.calls.some((call) => call.path.endsWith("/workers/routes")), false)
})

test("inspection validates scope and paginates a frozen observation window", async () => {
  for (const input of [
    {}, { worker: null }, { worker: 123 },
    { worker: "../other" }, { worker: "example-worker", limit: 201 },
    { worker: "example-worker", start: "bad" }, { worker: "example-worker", cursor: "id" },
    { worker: "other", findingId: "deep.worker-scheduled-handler-missing:example-worker" },
    { worker: "example-worker", start: "2026-08-01T00:00:00Z" },
  ]) assert.throws(() => normalizeWorkerInspection(input, WORKER_FIXTURE_TIME))
  const fixture = workerFixture()
  const first = await fixture.service.inspect({ worker: "example-worker", limit: 2 })
  assert.equal(first.logs.value.limitReached, true)
  const second = await fixture.service.inspect({ ...first.selector, cursor: first.logs.value.nextCursor })
  assert.equal(second.selector.start, first.selector.start)
  assert.equal(second.logs.value.invocations, 1)
})

test("schedule plans are read-only and bind schedule, deployment, intent and account state", async () => {
  const fixture = workerFixture()
  const planned = await fixture.service.planSchedules(disabledWorkerChange)
  assert.equal(planned.status, "planned")
  assert.equal(fixture.state.calls.some((call) => call.method === "PUT"), false)
  assert.equal(planned.planSet.plans[0].operations.length, 1)
  fixture.state.deployment.id = "deployment-changed"
  await assert.rejects(fixture.service.applySchedules(disabledWorkerChange, planned.planSet.digest), /does not match/)
  fixture.state.deployment.id = "deployment-serving"
  fixture.state.crons = ["0 * * * *"]
  await assert.rejects(fixture.service.applySchedules(disabledWorkerChange, planned.planSet.digest), /does not match/)
  assert.equal(fixture.state.calls.some((call) => call.method === "PUT"), false)
})

test("schedule execution journals before writing and preserves a guarded inverse", async () => {
  const fixture = workerFixture()
  fixture.state.beforeWrite = async () => {
    const journal = await fixture.activityStore.read()
    assert.equal(journal.entries.length, 1)
    assert.equal(journal.entries[0].status, "pending")
    assert.deepEqual(journal.entries[0].plans[0].operations[0].currentValue, [{ cron: "*/2 * * * *" }])
  }
  const plan = await fixture.service.planSchedules(disabledWorkerChange)
  const applied = await fixture.service.applySchedules(disabledWorkerChange, plan.planSet.digest)
  assert.equal(applied.status, "verified")
  assert.equal(applied.health.status, "propagation-pending")
  assert.equal(applied.inverse.available, true)
  assert.equal(isOperationActivityEntry(applied.activity), true)
  assert.deepEqual(fixture.state.crons, [])
  fixture.state.beforeWrite = null
  const undo = await fixture.service.planUndo(applied.activity.id)
  assert.equal(undo.status, "planned")
  const undone = await fixture.service.applyUndo(applied.activity.id, undo.planSet.digest)
  assert.equal(undone.status, "verified")
  assert.deepEqual(fixture.state.crons, ["*/2 * * * *"])
  assert.equal((await fixture.service.planUndo(applied.activity.id)).status, "blocked")
})

test("journal failure prevents writes, and verification drift prevents inverse", async () => {
  const fixture = workerFixture({ journalFailure: true })
  const plan = await fixture.service.planSchedules(disabledWorkerChange)
  await assert.rejects(fixture.service.applySchedules(disabledWorkerChange, plan.planSet.digest), /Journal/)
  assert.equal(fixture.state.calls.some((call) => call.method === "PUT"), false)
  fixture.state.journalFailure = false
  fixture.state.afterWrite = () => { fixture.state.crons = ["0 * * * *"] }
  const applied = await fixture.service.applySchedules(disabledWorkerChange, plan.planSet.digest)
  assert.equal(applied.status, "verification-failed")
  assert.equal(applied.inverse.available, false)
})

test("saved intent requires a reviewed owner, rejects revision drift, and survives incident records", async () => {
  const fixture = workerFixture()
  await assert.rejects(fixture.service.planIntent({ worker: "example-worker", expectedRevision: "", intent: { mode: "disabled" } }), /owning deployment/)
  const input = { worker: "example-worker", expectedRevision: "", intent: disabledWorkerChange.intent }
  const plan = await fixture.service.planIntent(input)
  await fixture.service.applyIntent(input, plan.planSet.digest)
  await assert.rejects(fixture.service.applyIntent(input, plan.planSet.digest), /revision changed/)
  const first = await fixture.service.record({ worker: "example-worker" })
  fixture.state.crons = []
  const second = await fixture.service.record({ worker: "example-worker" })
  assert.equal(second.record.supersedes, first.record.id)
  assert.equal(second.record.report.assessment.status, "consistent")
  const history = await fixture.service.history({ worker: "example-worker", limit: 1 })
  assert.equal(history.nextOffset, 1)
  assert.equal(history.intent.mode, "disabled")
  assert.equal((await fixture.store.read()).records.length, 2)
})

test("post-change verification ignores historical failures and waits for fresh evidence after propagation", async () => {
  const fixture = workerFixture({ now: Date.now() })
  const planned = await fixture.service.planSchedules(disabledWorkerChange)
  const applied = await fixture.service.applySchedules(disabledWorkerChange, planned.planSet.digest)
  const input = { worker: "example-worker", activityId: applied.activity.id }
  const pending = await fixture.service.verify(input)
  assert.equal(pending.record.report.verification.status, "propagation-pending")
  fixture.advance(CRON_PROPAGATION_MS + 10000)
  fixture.state.events = []
  assert.equal((await fixture.service.verify(input)).record.report.verification.status, "awaiting-evidence")
  fixture.state.events = [fixture.event("fresh-ok", "fetch", "ok", "version-serving", 1000, 200)]
  const healthy = await fixture.service.verify(input)
  assert.equal(healthy.record.report.verification.status, "observed-healthy")
  assert.ok(Date.parse(healthy.record.report.selector.start) >= Date.parse(applied.activity.completedAt) + CRON_PROPAGATION_MS)
  fixture.state.crons = ["0 * * * *"]
  assert.equal((await fixture.service.planUndo(applied.activity.id)).status, "blocked")
})

test("retained schedules require handlers and fresh evidence for every desired expression", async () => {
  const fixture = workerFixture({ now: Date.now() })
  const change = { ...disabledWorkerChange, intent: { ...disabledWorkerChange.intent, mode: "exact", crons: ["0,30 * * * *", "15 * * * *"] } }
  assert.equal((await fixture.service.planSchedules(change)).status, "blocked")
  fixture.state.handlers = ["fetch", "scheduled"]
  const plan = await fixture.service.planSchedules(change)
  const applied = await fixture.service.applySchedules(change, plan.planSet.digest)
  fixture.advance(CRON_PROPAGATION_MS + 10000)
  const input = { worker: "example-worker", activityId: applied.activity.id }
  const invocation = (id, cron) => {
    const sample = fixture.event(id, "scheduled", "ok", "version-serving", 1000)
    sample.$workers.event.cron = cron
    return sample
  }
  fixture.state.events = [invocation("first-schedule", change.intent.crons[0])]
  assert.equal((await fixture.service.verify(input)).record.report.verification.status, "awaiting-evidence")
  fixture.state.events.push(invocation("second-schedule", change.intent.crons[1]))
  assert.equal((await fixture.service.verify(input)).record.report.verification.status, "observed-healthy")
})
