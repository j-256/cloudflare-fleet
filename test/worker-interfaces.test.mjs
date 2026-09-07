import assert from "node:assert/strict"
import { Readable } from "node:stream"
import test from "node:test"
import { Client, InMemoryTransport } from "@modelcontextprotocol/client"
import { runFleetCommand, parseFleetArguments } from "../src/cli.mjs"
import { createFleetMcpServer } from "../src/mcp.mjs"
import { workerFixture, disabledWorkerChange, WORKER_FIXTURE_SECRET } from "./worker.fixture.mjs"

async function connection(context, fixture, handler) {
  const service = {
    accountId: fixture.api.accountId,
    workers: fixture.service,
    planChange: fixture.service.planSchedules,
    applyChange: fixture.service.applySchedules,
    planActivityUndo: fixture.service.planUndo,
    applyActivityUndo: fixture.service.applyUndo,
  }
  const server = createFleetMcpServer({ service, environment: {}, requestStateKey: new Uint8Array(32).fill(9), stderr: { write() {} } })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "worker-diagnostics-test", version: "1.0.0" }, { capabilities: { elicitation: {} } })
  if (handler) client.setRequestHandler("elicitation/create", handler)
  await client.connect(clientTransport)
  context.after(async () => { await client.close(); await server.close() })
  return async (name, input, expectedError = false) => {
    const result = await client.callTool({ name, arguments: input })
    assert.doesNotMatch(JSON.stringify(result), new RegExp(WORKER_FIXTURE_SECRET))
    assert.equal(result.isError === true, expectedError, JSON.stringify(result))
    return result.structuredContent
  }
}

const approve = (request) => ({ action: "accept", content: Object.fromEntries(request.params.requestedSchema.required.map((key) => [key, "approve"])) })

test("MCP Worker tools preserve scoped evidence, signed review, intent, journal and guarded undo", async (context) => {
  const fixture = workerFixture({ now: Date.now() })
  let confirmations = 0
  const call = await connection(context, fixture, (request) => {
    confirmations += 1
    assert.match(JSON.stringify(request.params), /example-worker/)
    assert.doesNotMatch(JSON.stringify(request.params), /Zone: undefined/)
    return approve(request)
  })
  const report = await call("inspect_worker", { findingId: "deep.worker-scheduled-handler-missing:example-worker" })
  assert.equal(report.assessment.status, "mismatch")
  assert.equal(report.logs.value.invocations, 3)
  assert.equal(report.logs.value.httpStatuses.find((entry) => entry.status === 503).servingVersion, false)
  const first = await call("record_worker_incident", { worker: "example-worker" })
  const history = await call("list_worker_incidents", { worker: "example-worker" })
  const intentInput = { worker: "example-worker", expectedRevision: history.revision, intent: disabledWorkerChange.intent }
  const intentPlan = await call("plan_worker_intent", intentInput)
  assert.equal((await fixture.store.read()).intents["example-worker"], undefined)
  const saved = await call("apply_worker_intent", { input: intentInput, planDigest: intentPlan.planSet.digest })
  assert.equal(saved.status, "saved")
  const planned = await call("plan_fleet_change", { change: disabledWorkerChange })
  assert.equal(fixture.state.calls.some((entry) => entry.method === "PUT"), false)
  const applied = await call("apply_fleet_change", { change: disabledWorkerChange, planDigest: planned.planSet.digest })
  assert.equal(applied.status, "verified")
  assert.equal(applied.activity.verification[0].target.worker, "example-worker")
  const verified = await call("verify_worker_incident", { worker: "example-worker", activityId: applied.activity.id })
  assert.equal(verified.record.supersedes, first.record.id)
  assert.equal(verified.record.report.verification.status, "propagation-pending")
  const undo = await call("plan_activity_undo", { activityId: applied.activity.id })
  assert.equal((await call("apply_activity_undo", { activityId: applied.activity.id, planDigest: undo.planSet.digest })).status, "verified")
  assert.equal(confirmations, 3)
  assert.deepEqual(fixture.state.crons, ["*/2 * * * *"])
})

test("MCP Worker schedule plans cannot bypass rejection or drift during confirmation", async (context) => {
  for (const drift of [false, true]) await context.test(drift ? "deployment drift" : "declined review", async (subcontext) => {
    const fixture = workerFixture()
    const call = await connection(subcontext, fixture, (request) => {
      if (!drift) return { action: "decline" }
      fixture.state.deployment.id = "another-deployment"
      return approve(request)
    })
    const plan = await call("plan_fleet_change", { change: disabledWorkerChange })
    const result = await call("apply_fleet_change", { change: disabledWorkerChange, planDigest: plan.planSet.digest }, drift)
    assert.equal(result.status, drift ? "plan-changed" : "confirmation-declined")
    assert.equal(fixture.state.calls.some((entry) => entry.method === "PUT"), false)
  })
})

test("Worker CLI JSON commands use the shared service and require the reviewed apply digest", async () => {
  const fixture = workerFixture()
  async function run(command, input, digest) {
    let output = ""
    const result = await runFleetCommand({
      argv: ["worker", command, "--input", "-", "--format", "json", ...(digest ? ["--expect-plan", digest] : [])],
      stdin: Readable.from([JSON.stringify(input)]), stdout: { write(value) { output += value } }, stderr: { write() {} },
      service: { workers: fixture.service }, environment: {},
    })
    assert.deepEqual(JSON.parse(output), result)
    assert.doesNotMatch(output, new RegExp(WORKER_FIXTURE_SECRET))
    return result
  }
  assert.throws(() => parseFleetArguments(["worker", "schedules-apply", "--input", "-"]), /expect-plan/)
  assert.equal((await run("inspect", { worker: "example-worker" })).assessment.status, "mismatch")
  const plan = await run("schedules-plan", disabledWorkerChange)
  assert.equal(fixture.state.calls.some((entry) => entry.method === "PUT"), false)
  const applied = await run("schedules-apply", disabledWorkerChange, plan.planSet.digest)
  assert.equal(applied.status, "verified")
  assert.equal((await run("record", { worker: "example-worker" })).record.report.assessment.status, "consistent")
  assert.equal((await run("history", { worker: "example-worker" })).records.length, 1)
  const undo = await run("undo-plan", { activityId: applied.activity.id })
  assert.equal((await run("undo-apply", { activityId: applied.activity.id }, undo.planSet.digest)).status, "verified")
})
