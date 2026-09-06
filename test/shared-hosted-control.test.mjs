import assert from "node:assert/strict"
import test from "node:test"
import { hostedD1Fixture } from "./hosted-d1.fixture.mjs"
import { fetchHostedFleet } from "../src/hosted/worker.mjs"
import { createRemoteFleetService } from "../src/remote-fleet-service.mjs"
import { selectFleetBackend } from "../src/backend-selection.mjs"
import { hostedExecutionLock, HOSTED_LEASE_MS } from "../src/hosted/execution-lock.mjs"
import { diagnoseFleetRuntime } from "../src/runtime-status.mjs"
import { validateFleetCommand } from "../src/fleet-command.mjs"
import { createEmptyFleetIntentDocument } from "../src/fleet-intent.mjs"
import { AlignmentPlanChangedError } from "../src/write-executor.mjs"
import { createPendingOperationActivity, completeOperationActivity } from "../src/operation-history.mjs"
import { hostedActivityRecovery } from "../src/hosted/activity-recovery.mjs"
import { appendHostedOperationActivity, readHostedOperationActivity } from "../src/hosted/d1-store.mjs"
import { hostedStateReconciliation } from "../src/hosted/state-reconciliation.mjs"
import { planStateReconciliation } from "../src/state-reconciliation.mjs"
import { createFleetMcpServer } from "../src/mcp.mjs"
import { Client, InMemoryTransport } from "@modelcontextprotocol/client"

const ACCOUNT = "account-one"
const clientEnvironment = {
  CLOUDFLARE_FLEET_URL: "https://fleet.example.com",
  CLOUDFLARE_FLEET_ACCOUNT_ID: ACCOUNT,
  CLOUDFLARE_FLEET_ACCESS_CLIENT_ID: "test-client",
  CLOUDFLARE_FLEET_ACCESS_CLIENT_SECRET: "test-secret",
}
function serverEnvironment(context) {
  return {
    FLEET_ACCOUNT_ID: ACCOUNT, FLEET_DB: hostedD1Fixture(context),
    FLEET_READ_ONLY: "false", CLOUDFLARE_API_TOKEN: "server-only",
    ASSETS: { fetch: async () => new Response("Fleet") },
  }
}
function client(env, options = {}) {
  return createRemoteFleetService({
    environment: clientEnvironment,
    fetchImpl: async (url, request) => {
      assert.equal(new URL(url).origin, clientEnvironment.CLOUDFLARE_FLEET_URL)
      assert.equal(request.redirect, "error")
      assert.equal(request.headers.Authorization, undefined)
      return fetchHostedFleet(new Request("http://localhost/api/commands", request), env)
    },
    ...options,
  })
}

test("hosted backend is explicit, account-bound and has no local file fallback", () => {
  assert.equal(selectFleetBackend({ environment: clientEnvironment }).kind, "hosted")
  assert.equal(selectFleetBackend({ environment: { ...clientEnvironment, CLOUDFLARE_FLEET_BACKEND: "local" } }).kind, "local")
  assert.throws(() => selectFleetBackend({ environment: clientEnvironment, stateFile: "/example/state.json" }), /Hosted Fleet owns state/)
  for (const url of ["http://fleet.example.com", "https://secret@fleet.example.com", "https://fleet.example.com/path", "https://fleet.example.com?token=secret"]) {
    assert.throws(() => selectFleetBackend({ environment: { ...clientEnvironment, CLOUDFLARE_FLEET_URL: url } }), /HTTPS origin/)
  }
  assert.throws(() => createRemoteFleetService({ environment: { ...clientEnvironment, CLOUDFLARE_FLEET_ACCESS_CLIENT_SECRET: "" } }), /no local fallback/)
})

test("hosted command dispatch rejects arbitrary methods, extra input and account mismatch", async (context) => {
  assert.throws(() => validateFleetCommand({ version: 1, accountId: ACCOUNT, command: "request", input: { path: "/accounts" } }), /Unsupported/)
  assert.throws(() => validateFleetCommand({ version: 1, accountId: ACCOUNT, command: "intent-get", input: { path: "/accounts" } }), /Invalid input/)
  const env = serverEnvironment(context)
  const response = await fetchHostedFleet(new Request("http://localhost/api/commands", {
    method: "POST", body: JSON.stringify({ version: 1, accountId: "other", command: "status", input: {} }),
  }), env)
  assert.equal(response.status, 403)
})

test("independent hosted clients and browser share D1 intent and reject stale plans", async (context) => {
  const env = serverEnvironment(context)
  const first = client(env)
  const second = client(env)
  const initial = await first.getIntent()
  const desired = structuredClone(initial.document)
  desired.groups.push({ id: "selected", name: "Selected", nameSource: "custom", mode: "members", members: [{ zoneId: "zone-one", zoneName: "example.com" }] })
  const plan = await first.planIntent(desired)
  const applied = await first.applyIntent(desired, plan.planSet.digest)
  assert.equal(applied.applied, true)
  assert.deepEqual((await second.getIntent()).document, applied.document)
  const browser = await fetchHostedFleet(new Request("http://localhost/api/intent"), env)
  assert.deepEqual((await browser.json()).result, applied.document)
  await assert.rejects(() => second.applyIntent(desired, plan.planSet.digest), AlignmentPlanChangedError)
  const activity = await second.listActivity()
  assert.equal(activity.accountId, ACCOUNT)
})

function pendingActivity(id = "interrupted") {
  return createPendingOperationActivity("Change setting", {
    validatedAt: "2026-08-01T00:00:00Z",
    plans: [{
      id: "setting-plan", kind: "zone-setting-update", summary: "Change setting",
      zoneId: "zone-one", zoneName: "example.com",
      operations: [{ method: "PATCH", path: "zones/zone-one/settings/always_use_https", label: "Enable HTTPS", currentValue: "off", body: { value: "on" } }],
    }],
  }, { id })
}

test("pending activity blocks expired lease takeover and requires reviewed, inactive recovery", async (context) => {
  const db = hostedD1Fixture(context)
  const lock = hostedExecutionLock(db, ACCOUNT)
  const entry = pendingActivity()
  const owner = await lock.acquire(entry.id)
  await appendHostedOperationActivity(db, ACCOUNT, entry)
  const recovery = hostedActivityRecovery(db, ACCOUNT)
  const input = { activityId: entry.id, reason: "Stopped the old browser and inspected the HTTPS setting", stoppedClientsAndInspectedResources: true }
  await assert.rejects(() => recovery.planRecovery(input), /still active/)
  await db.prepare("UPDATE worker_execution_lock SET expires_at = 0 WHERE account_id = ?").bind(ACCOUNT).run()
  await assert.rejects(() => lock.acquire(), /Another Fleet operation/)
  await assert.rejects(() => recovery.planRecovery({ ...input, stoppedClientsAndInspectedResources: false }), /confirmation/)
  const plan = await recovery.planRecovery(input)
  await assert.rejects(() => recovery.applyRecovery({ ...input, reason: "Different operator investigation" }, plan.planSet.digest), AlignmentPlanChangedError)
  assert.equal((await readHostedOperationActivity(db, ACCOUNT)).entries[0].status, "pending")
  const result = await recovery.applyRecovery(input, plan.planSet.digest)
  assert.equal(result.outcome, "unknown")
  assert.equal(result.entry.status, "write-failed")
  assert.equal(result.entry.inverse.available, false)
  assert.equal(result.entry.execution.completed, 0)
  assert.match(result.entry.error, /not zero applied writes/)
  assert.deepEqual(result.entry.plans, entry.plans)
  await assert.rejects(() => lock.renew(owner), /expired or changed/)
  const next = await lock.acquire()
  await lock.release(next)
  await assert.rejects(() => recovery.applyRecovery(input, plan.planSet.digest), /unresolved pending/)
})

test("browser activity ownership and account-wide exclusion survive other clients", async (context) => {
  const env = serverEnvironment(context)
  const entry = pendingActivity()
  const browser = (method, payload, headers = {}) => fetchHostedFleet(new Request("http://localhost/api/activity", {
    method, body: JSON.stringify({ entry: payload }), headers,
  }), env)
  assert.equal((await browser("POST", entry)).status, 200)
  const remote = client(env)
  const document = (await remote.getIntent()).document
  const plan = await remote.planIntent(document)
  await assert.rejects(() => remote.applyIntent(document, plan.planSet.digest), /Another Fleet operation/)
  const completed = completeOperationActivity(entry, {
    status: "write-failed", execution: { completed: 0, total: 1 }, error: "Cancelled test write",
    inverse: { available: false, plans: [], reason: "No result was verified" },
  })
  assert.equal((await browser("PATCH", completed)).status, 409)
  assert.equal((await browser("PATCH", completed, { "X-Fleet-Execution": entry.id })).status, 200)
  assert.equal((await remote.applyIntent(document, plan.planSet.digest)).applied, false)
})

test("legacy multiple pending journals can be recovered one at a time without allowing ordinary writes", async (context) => {
  const db = hostedD1Fixture(context)
  await appendHostedOperationActivity(db, ACCOUNT, pendingActivity("first"))
  await appendHostedOperationActivity(db, ACCOUNT, pendingActivity("second"))
  const recovery = hostedActivityRecovery(db, ACCOUNT)
  const input = { activityId: "first", reason: "Stopped all old clients and inspected both affected resources", stoppedClientsAndInspectedResources: true }
  const plan = await recovery.planRecovery(input)
  await recovery.applyRecovery(input, plan.planSet.digest)
  await assert.rejects(() => hostedExecutionLock(db, ACCOUNT).acquire(), /Another Fleet operation/)
  const second = { ...input, activityId: "second" }
  await recovery.applyRecovery(second, (await recovery.planRecovery(second)).planSet.digest)
  const lock = hostedExecutionLock(db, ACCOUNT)
  const owner = await lock.acquire()
  await lock.release(owner)
})

test("reconciliation preserves distinct history, rejects conflicts and stale plans, and supports archive recovery", async (context) => {
  const db = hostedD1Fixture(context)
  const stateService = hostedStateReconciliation(db, ACCOUNT)
  const original = (await stateService.getState()).state
  const activity = completeOperationActivity(pendingActivity("incoming"), {
    status: "write-failed", execution: { completed: 0, total: 1 }, error: "Test failure",
    inverse: { available: false, plans: [], reason: "No verified result" },
  })
  const incoming = structuredClone(original)
  incoming.activity.entries.push(activity)
  const input = { state: incoming, intentSource: "incoming" }
  const plan = await stateService.planState(input)
  assert.equal(plan.summary.addedActivities, 1)
  const result = await stateService.applyState(input, plan.planSet.digest)
  assert.deepEqual(result.state.activity.entries, [activity])
  assert.deepEqual((await stateService.getState(result.archiveId)).state, original)
  await assert.rejects(() => stateService.applyState(input, plan.planSet.digest), AlignmentPlanChangedError)
  const rollback = await stateService.planState({ state: original, intentSource: "incoming" })
  assert.deepEqual(rollback.target.activity.entries, [activity])
  const conflict = structuredClone(result.state)
  conflict.activity.entries[0].title = "Conflicting same ID"
  await assert.rejects(() => planStateReconciliation(result.state, { state: conflict, intentSource: "hosted" }), /Conflicting activity identity/)
  await assert.rejects(() => stateService.planState({ state: incoming }), /explicit intentSource/)
  const pending = structuredClone(original)
  pending.activity.entries.push(pendingActivity())
  await assert.rejects(() => stateService.planState({ state: pending, intentSource: "incoming" }), /pending activity/)
})

test("MCP signed approval reaches hosted D1 and includes complete state and interrupted recovery reviews", async (context) => {
  const env = serverEnvironment(context)
  const remote = client(env)
  const server = createFleetMcpServer({ environment: clientEnvironment, service: remote, stderr: { write() {} } })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const mcp = new Client({ name: "shared-hosted-test", version: "1.0.0" }, { capabilities: { elicitation: {} } })
  const reviews = []
  mcp.setRequestHandler("elicitation/create", async (request) => {
    reviews.push(JSON.stringify(request.params.requestedSchema))
    return { action: "accept", content: Object.fromEntries(request.params.requestedSchema.required.map((key) => [key, "approve"])) }
  })
  await mcp.connect(clientTransport)
  context.after(async () => { await mcp.close(); await server.close() })
  const advertised = await mcp.listTools()
  for (const name of ["get_fleet_intent", "plan_fleet_intent", "apply_fleet_intent", "list_activity", "apply_worker_intent"]) {
    assert.equal(advertised.tools.find((tool) => tool.name === name).annotations.openWorldHint, true)
  }
  const input = { state: (await remote.getState()).state, intentSource: "incoming" }
  const plan = await mcp.callTool({ name: "plan_state_reconciliation", arguments: input })
  assert.equal(plan.isError, undefined)
  const applied = await mcp.callTool({ name: "apply_state_reconciliation", arguments: { ...input, planDigest: plan.structuredContent.planSet.digest } })
  assert.equal(applied.isError, undefined)
  assert.equal(applied.structuredContent.status, "saved")
  assert.match(reviews[0], /State authority/)
  assert.equal((await remote.getState()).archives.length, 1)
  const entry = pendingActivity()
  await appendHostedOperationActivity(env.FLEET_DB, ACCOUNT, entry)
  const recoveryInput = { activityId: entry.id, reason: "Stopped clients and inspected current HTTPS configuration", stoppedClientsAndInspectedResources: true }
  const recoveryPlan = await mcp.callTool({ name: "plan_activity_recovery", arguments: recoveryInput })
  assert.equal(recoveryPlan.isError, undefined)
  const recovered = await mcp.callTool({ name: "apply_activity_recovery", arguments: { ...recoveryInput, planDigest: recoveryPlan.structuredContent.planSet.digest } })
  assert.equal(recovered.isError, undefined)
  assert.equal(recovered.structuredContent.outcome, "unknown")
  assert.match(reviews[1], /does not retry, reverse, or verify/)
  assert.equal((await remote.listActivity()).entries[0].status, "write-failed")
})

test("reconciliation revision guard rejects a race after review without archiving or overwriting the new state", async (context) => {
  const db = hostedD1Fixture(context)
  const service = hostedStateReconciliation(db, ACCOUNT)
  const input = { state: (await service.getState()).state, intentSource: "incoming" }
  const plan = await service.planState(input)
  const batch = db.batch.bind(db)
  let raced = false
  db.batch = async (statements) => {
    if (!raced && statements[0].sql.includes("INSERT INTO state_reconciliation")) {
      raced = true
      await db.prepare("UPDATE activity_meta SET revision = ? WHERE account_id = ?").bind("a".repeat(64), ACCOUNT).run()
    }
    return batch(statements)
  }
  await assert.rejects(() => service.applyState(input, plan.planSet.digest), AlignmentPlanChangedError)
  const result = await service.getState()
  assert.equal(result.archives.length, 0)
  assert.equal(result.state.activity.revision, "a".repeat(64))
  assert.deepEqual(result.state.intent, input.state.intent)
})

test("reconciliation reviews Worker intent changes and preserves chronological incident links", async (context) => {
  const service = hostedStateReconciliation(hostedD1Fixture(context), ACCOUNT)
  const hosted = (await service.getState()).state
  const incident = (id, day, supersedes = null) => ({
    id, worker: "example-worker", recordedAt: `2026-08-${day}T00:00:00Z`,
    findingId: "worker-finding", activityId: null, supersedes, report: { accountId: ACCOUNT, worker: "example-worker" },
  })
  hosted.workers.records = [incident("first", "01"), incident("hosted-latest", "03", "first")]
  const incoming = structuredClone(hosted)
  incoming.workers.records = [incident("first", "01"), incident("incoming-middle", "02", "first")]
  incoming.workers.intents["example-worker"] = { mode: "disabled", crons: [], owner: "example:wrangler.jsonc", reconciliation: "Remove the obsolete trigger" }
  const plan = await planStateReconciliation(hosted, { state: incoming, intentSource: "incoming" })
  assert.deepEqual(plan.target.workers.records.map((record) => record.id), ["first", "incoming-middle", "hosted-latest"])
  assert.match(JSON.stringify(plan.reviewItems), /Worker intent: example-worker/)
  assert.deepEqual(plan.summary.changedWorkerIntents, ["example-worker"])
  incoming.workers.records[1].supersedes = "missing"
  await assert.rejects(() => planStateReconciliation(hosted, { state: incoming, intentSource: "incoming" }), /supersession/)
})

test("read-only hosted deployment permits reads but refuses persistence", async (context) => {
  const env = { ...serverEnvironment(context), FLEET_READ_ONLY: "true" }
  const remote = client(env)
  assert.equal((await remote.status()).readOnly, true)
  const document = createEmptyFleetIntentDocument(ACCOUNT)
  const plan = await remote.planIntent(document)
  await assert.rejects(() => remote.applyIntent(document, plan.planSet.digest), /denied access/)
})

test("remote client never retries uncertain mutations or sends the account token", async () => {
  let calls = 0
  const remote = createRemoteFleetService({
    environment: { ...clientEnvironment, CLOUDFLARE_API_TOKEN: "never-forward" },
    fetchImpl: async (_url, options) => {
      calls++
      assert.equal(JSON.stringify(options).includes("never-forward"), false)
      throw new Error("transport leaked secret")
    },
  })
  await assert.rejects(() => remote.applyIntent({}, "sha256:bad"), /outcome is unknown/)
  assert.equal(calls, 1)
})

test("remote client rejects login redirects and response account confusion", async () => {
  const redirected = createRemoteFleetService({ environment: clientEnvironment, fetchImpl: async () => new Response(null, { status: 302 }) })
  await assert.rejects(() => redirected.getIntent(), /denied access/)
  const confused = createRemoteFleetService({
    environment: clientEnvironment,
    fetchImpl: async () => Response.json({ success: true, result: {}, accountId: "wrong", version: 1 }),
  })
  await assert.rejects(() => confused.getIntent(), /does not match/)
  const changed = createRemoteFleetService({
    environment: clientEnvironment,
    fetchImpl: async () => Response.json({ success: false, error: { name: "AlignmentPlanChangedError", actualDigest: "fresh" } }, { status: 409 }),
  })
  await assert.rejects(() => changed.applyIntent({}, "old"), AlignmentPlanChangedError)
})

test("hosted execution lock excludes clients, renews leases and rejects expired owners", async (context) => {
  const db = hostedD1Fixture(context)
  let now = 1000
  const first = hostedExecutionLock(db, ACCOUNT, { now: () => now })
  const second = hostedExecutionLock(db, ACCOUNT, { now: () => now })
  const owner = await first.acquire()
  await assert.rejects(() => second.acquire(), /Another Fleet operation/)
  await first.renew(owner)
  now += HOSTED_LEASE_MS + 1
  const next = await second.acquire()
  await assert.rejects(() => first.renew(owner), /expired or changed/)
  await first.release(owner)
  await second.renew(next)
})

test("hosted doctor needs no account token or local files and redacts Access credentials", async () => {
  const result = await diagnoseFleetRuntime({ environment: clientEnvironment, platform: "linux" })
  assert.equal(result.status, "ready")
  assert.equal(result.backend.kind, "hosted")
  assert.equal(result.backend.fallback, false)
  assert.equal(result.paths.state.kind, "remote")
  assert.equal(JSON.stringify(result).includes("test-secret"), false)
})
