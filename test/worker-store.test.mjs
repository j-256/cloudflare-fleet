import assert from "node:assert/strict"
import test from "node:test"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { hostedD1Fixture } from "./hosted-d1.fixture.mjs"
import { hostedWorkerStore } from "../src/hosted/worker-store.mjs"
import { localWorkerStore } from "../src/worker-store.mjs"
import { disabledWorkerChange, workerFixture } from "./worker.fixture.mjs"
import { fetchHostedFleet } from "../src/hosted/worker.mjs"

test("local and hosted Worker records enforce revisions and preserve assessment history", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "fleet-worker-records-"))
  context.after(() => fs.rm(root, { recursive: true, force: true }))
  const fixture = workerFixture()
  await fixture.service.record({ worker: "example-worker" })
  const captured = await fixture.store.read()
  const db = hostedD1Fixture(context)
  for (const store of [localWorkerStore(path.join(root, "state.json"), "example-account"), hostedWorkerStore(db, "example-account")]) {
    assert.equal((await store.read()).revision, "")
    const saved = await store.write("", captured)
    assert.equal((await store.read()).records[0].id, captured.records[0].id)
    await assert.rejects(store.write("", captured), /revision changed/)
    await store.write(saved.revision, { ...saved, intents: { "example-worker": disabledWorkerChange.intent } })
    assert.equal((await store.read()).records.length, 1)
  }
  const mode = (await fs.stat(path.join(root, "state.json"))).mode & 0o777
  assert.equal(mode, 0o600)
  assert.equal((await hostedWorkerStore(db, "other-account").read()).records.length, 0)
})

test("hosted Worker writes exclude concurrent owners and release a failed operation", async (context) => {
  const db = hostedD1Fixture(context)
  const first = hostedWorkerStore(db, "example-account")
  const second = hostedWorkerStore(db, "example-account")
  await assert.rejects(first.withWriteLock(async () => {
    await assert.rejects(second.withWriteLock(async () => {}), /in progress/)
    throw new Error("test failure")
  }), /test failure/)
  await second.withWriteLock(async () => {})
  await db.prepare("INSERT INTO worker_execution_lock (account_id, owner, expires_at) VALUES (?, ?, ?)").bind("example-account", "abandoned", Date.now() - 1).run()
  await first.withWriteLock(async () => {})
})

test("hosted bounded Worker commands preserve projection, review, journal and access boundaries", async (context) => {
  const fixture = workerFixture({ now: Date.now() })
  const originalFetch = globalThis.fetch
  context.after(() => { globalThis.fetch = originalFetch })
  globalThis.fetch = async (url, request) => {
    const relative = new URL(url).pathname.replace("/client/v4/", "")
    try {
      const response = await fixture.api.request(relative, { ...request, body: request.body ? JSON.parse(request.body) : undefined })
      return Response.json({ result: response.result, success: true })
    } catch (error) { return Response.json({ success: false, errors: [{ message: "Fixture failure" }] }, { status: error.status || 500 }) }
  }
  const env = { FLEET_DB: hostedD1Fixture(context), FLEET_ACCOUNT_ID: fixture.api.accountId, CLOUDFLARE_API_TOKEN: "fixture-token", FLEET_READ_ONLY: "false", ASSETS: { fetch: async () => new Response("") }, ACCESS_AUD: "fixture", ACCESS_TEAM_DOMAIN: "https://example.cloudflareaccess.com" }
  const call = async (command, payload, overrides = {}, origin = "http://localhost:8787") => fetchHostedFleet(new Request(`http://localhost:8787/api/workers/${command}`, { method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify(payload) }), { ...env, ...overrides })
  const report = await (await call("inspect", { worker: "example-worker" }, { FLEET_READ_ONLY: "true" })).json()
  assert.equal(report.result.assessment.status, "mismatch")
  assert.equal((await call("record", { worker: "example-worker" }, { FLEET_READ_ONLY: "true" })).status, 403)
  assert.equal((await call("record", { worker: "example-worker" }, {}, "https://attacker.example")).status, 403)
  assert.equal((await call("arbitrary", { method: "DELETE", path: "/anything" })).status, 400)
  const plan = (await (await call("schedules-plan", disabledWorkerChange)).json()).result
  assert.equal((await call("schedules-apply", { input: disabledWorkerChange, planDigest: `sha256:${"0".repeat(64)}` })).status, 409)
  const applied = (await (await call("schedules-apply", { input: disabledWorkerChange, planDigest: plan.planSet.digest })).json()).result
  assert.equal(applied.status, "verified")
  assert.equal(applied.inverse.available, true)
  const verification = (await (await call("verify", { worker: "example-worker", activityId: applied.activity.id })).json()).result
  assert.equal(verification.record.report.verification.status, "propagation-pending")
  const history = (await (await call("history", { worker: "example-worker" })).json()).result
  assert.equal(history.records.length, 1)
})
