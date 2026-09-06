import assert from "node:assert/strict"
import test from "node:test"
import { Client, InMemoryTransport } from "@modelcontextprotocol/client"
import { CloudflareApi, CloudflareApiError, serializeApiError } from "../src/api.mjs"
import { runFleetServiceCommand } from "../src/fleet-command.mjs"
import { FleetCommandError } from "../src/command-diagnostics.mjs"
import { commandDiagnosticsSchema } from "../src/interface-schemas.mjs"
import { commandFailureResponse } from "../src/hosted/command-response.mjs"
import { createHostedFleetService } from "../src/hosted/fleet-service.mjs"
import { fetchHostedFleet } from "../src/hosted/worker.mjs"
import { createRemoteFleetService } from "../src/remote-fleet-service.mjs"
import { createFleetMcpServer } from "../src/mcp.mjs"
import { runFleetCli } from "../src/cli.mjs"
import { hostedD1Fixture } from "./hosted-d1.fixture.mjs"
import { createAuthoredFleetIntentExpected, FLEET_INTENT_ALL_ZONES_GROUP_ID, replaceFleetIntentPolicy } from "../src/fleet-intent.mjs"

const ACCOUNT = "account-one"
const SECRET = "synthetic-secret-token"
const REQUEST_ID = "34c4f601-0863-4824-a5b3-e26ce2e1a3b1"
const environment = {
  CLOUDFLARE_FLEET_URL: "https://fleet.example.com", CLOUDFLARE_FLEET_ACCOUNT_ID: ACCOUNT,
  CLOUDFLARE_FLEET_ACCESS_CLIENT_ID: "synthetic-client", CLOUDFLARE_FLEET_ACCESS_CLIENT_SECRET: SECRET,
}
const command = { version: 1, accountId: ACCOUNT, command: "alignment-list", input: {} }

function timeoutError() {
  return new CloudflareApiError(`Unsafe upstream message ${SECRET}`, {
    path: `/client/v4/zones/zone-one/rulesets/rule-one?token=${SECRET}`,
    aborted: true, abortKind: "timeout", elapsedMs: 45000,
    errors: [{ message: `Do not log provider payloads ${SECRET}` }],
  })
}

function serverEnvironment(context) {
  return {
    FLEET_ACCOUNT_ID: ACCOUNT, FLEET_DB: hostedD1Fixture(context), FLEET_READ_ONLY: "false",
    CLOUDFLARE_API_TOKEN: SECRET, ASSETS: { fetch: async () => new Response("Fleet") },
  }
}

async function capturedCommandFailure(value = command) {
  try {
    const fail = async () => { throw timeoutError() }
    await runFleetServiceCommand({ accountId: ACCOUNT, listAlignments: fail, applyAlignment: fail }, value)
    assert.fail("Expected a command error")
  } catch (error) {
    assert.ok(error instanceof FleetCommandError)
    return error
  }
}

test("API abort metadata survives fetch and response-body timeouts", async () => {
  for (const inBody of [false, true]) {
    const controller = new AbortController()
    const fail = () => { controller.abort(new DOMException("Timed out", "TimeoutError")); throw controller.signal.reason }
    const api = new CloudflareApi({ accountId: ACCOUNT, apiToken: SECRET,
      fetchImpl: async () => inBody ? { ok: true, status: 200, json: fail } : fail(),
    })
    await assert.rejects(api.request("zones/zone-one/rulesets", { signal: controller.signal }), (error) => {
      assert.ok(error instanceof CloudflareApiError)
      const serialized = serializeApiError(error)
      assert.equal(serialized.aborted, true)
      assert.equal(serialized.abortKind, "timeout")
      assert.equal(serialized.path, "/client/v4/zones/zone-one/rulesets")
      assert.ok(serialized.elapsedMs >= 0)
      return true
    })
  }
})

test("command deadline stops cooperative reads and retains stage and upstream context", async () => {
  const api = new CloudflareApi({ accountId: ACCOUNT, apiToken: SECRET,
    fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true })
    }),
  })
  const keepAlive = setTimeout(() => {}, 1000)
  try {
    await assert.rejects(runFleetServiceCommand({ accountId: ACCOUNT, async listAlignments(context) {
      context.onProgress({ stage: "rulesets", completed: 2, total: 3, message: SECRET })
      return api.request("zones/zone-one/rulesets/rule-one", context)
    } }, command, { timeoutMs: 5 }), (error) => {
      assert.ok(error instanceof FleetCommandError)
      assert.equal(error.status, 504)
      assert.equal(error.diagnostics.kind, "command-timeout")
      assert.equal(error.diagnostics.deadlineMs, 5)
      assert.ok(error.diagnostics.elapsedMs >= 4)
      assert.deepEqual(error.diagnostics.progress, { stage: "rulesets", completed: 2, total: 3 })
      assert.equal(error.diagnostics.upstream.path, "/client/v4/zones/zone-one/rulesets/rule-one")
      assert.doesNotMatch(JSON.stringify(error.diagnostics), new RegExp(SECRET))
      return true
    })
  } finally { clearTimeout(keepAlive) }
})

test("upstream timeout responses and structured logs share a safe correlation ID", async (context) => {
  const logs = []
  context.mock.method(console, "error", (value) => logs.push(value))
  const error = await capturedCommandFailure()
  const response = commandFailureResponse(error, REQUEST_ID, { CLOUDFLARE_API_TOKEN: SECRET })
  assert.equal(response.status, 504)
  const envelope = await response.json()
  assert.ok(commandDiagnosticsSchema.safeParse(envelope.error.diagnostics).success)
  assert.equal(envelope.error.diagnostics.kind, "upstream-timeout")
  assert.equal(envelope.error.diagnostics.requestId, REQUEST_ID)
  assert.equal(envelope.error.diagnostics.upstream.elapsedMs, 45000)
  assert.equal(logs[0].requestId, REQUEST_ID)
  assert.equal(logs[0].event, "fleet.command.failed")
  assert.match(envelope.errors[0].message, /read-only command made no changes/)
  assert.doesNotMatch(JSON.stringify({ envelope, logs }), /synthetic-secret-token|Unsafe upstream|provider payloads|\?token/)
})

test("unexpected failures retain bounded source locations without raw messages or machine paths", async () => {
  const cause = new Error(SECRET)
  cause.stack = `Error: ${SECRET}\n    at investigate (/private/operator/context/client.mjs:42:5)\n    at worker.js:50:7`
  await assert.rejects(runFleetServiceCommand({ accountId: ACCOUNT, listAlignments: () => { throw cause } }, command), (error) => {
    assert.equal(error.status, 500)
    assert.equal(error.diagnostics.kind, "internal-error")
    assert.deepEqual(error.diagnostics.error.frames, [{ file: "client.mjs", line: 42, column: 5 }, { file: "worker.js", line: 50, column: 7 }])
    assert.doesNotMatch(JSON.stringify(error.diagnostics), /synthetic-secret-token|private\/operator/)
    return true
  })
})

test("write timeout advice never asserts no changes or automatically retries", async (context) => {
  context.mock.method(console, "error", () => {})
  const error = await capturedCommandFailure({ ...command, command: "alignment-apply", input: { selector: { policyId: "policy-one" }, planDigest: `sha256:${"a".repeat(64)}` } })
  assert.equal(error.diagnostics.readOnly, false)
  assert.match(error.message, /outcome may be unknown.*inspect hosted activity.*not retried/)
  assert.doesNotMatch(error.message, /made no changes|retry the read/)
  let calls = 0
  const remote = createRemoteFleetService({ environment, fetchImpl: async () => {
    calls += 1
    return commandFailureResponse(error, REQUEST_ID, { CLOUDFLARE_API_TOKEN: SECRET })
  } })
  await assert.rejects(remote.applyAlignment({ policyId: "policy-one" }, `sha256:${"a".repeat(64)}`), /outcome may be unknown/)
  assert.equal(calls, 1)
})

test("remote CLI and MCP retain typed hosted diagnostics and the request ID", async (context) => {
  context.mock.method(console, "error", () => {})
  const error = await capturedCommandFailure()
  const remote = createRemoteFleetService({ environment, fetchImpl: async () => commandFailureResponse(error, REQUEST_ID, { CLOUDFLARE_API_TOKEN: SECRET }) })
  let output = ""
  let exitCode
  await runFleetCli({ argv: ["alignment", "list", "--format", "json"], environment, service: remote,
    stdout: { write: (value) => { output += value } }, stderr: { write() {} }, onExitCode: (value) => { exitCode = value },
  })
  assert.equal(exitCode, 1)
  const cli = JSON.parse(output)
  assert.equal(cli.error.diagnostics.requestId, REQUEST_ID)
  const server = createFleetMcpServer({ environment, service: remote, stderr: { write() {} } })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "diagnostics-test", version: "1" })
  context.after(async () => { await client.close(); await server.close() })
  await client.connect(clientTransport)
  const result = await client.callTool({ name: "list_alignment_candidates", arguments: {} })
  assert.equal(result.isError, true)
  assert.deepEqual(result.structuredContent.error.diagnostics, cli.error.diagnostics)
  assert.doesNotMatch(JSON.stringify(result), new RegExp(SECRET))
  const advertised = await client.listTools()
  for (const name of ["list_alignment_candidates", "plan_alignment", "apply_alignment"]) {
    assert.match(JSON.stringify(advertised.tools.find((entry) => entry.name === name).outputSchema), /"diagnostics"/)
    assert.match(JSON.stringify(advertised.tools.find((entry) => entry.name === name).outputSchema), /"coverage"/)
  }
})

test("hosted command handler returns correlated timeout responses without dispatching cancelled work", async (context) => {
  const logs = []
  context.mock.method(console, "error", (value) => logs.push(value))
  context.mock.method(globalThis, "fetch", () => assert.fail("Cancelled command must not reach Cloudflare"))
  const response = await fetchHostedFleet(new Request("http://localhost/api/commands", {
    method: "POST", body: JSON.stringify(command), signal: AbortSignal.abort(new DOMException("Timed out", "TimeoutError")),
  }), serverEnvironment(context))
  assert.equal(response.status, 504)
  const envelope = await response.json()
  assert.equal(envelope.error.diagnostics.kind, "command-timeout")
  assert.equal(envelope.error.diagnostics.requestId, logs[0].requestId)
})

test("hosted zone ownership reads observe command cancellation before any target read", async (context) => {
  const calls = []
  const controller = new AbortController()
  const api = new CloudflareApi({ accountId: ACCOUNT, apiToken: SECRET,
    fetchImpl: async (url, { signal }) => {
      calls.push(new URL(url).pathname)
      controller.abort()
      signal.throwIfAborted()
      assert.fail("Membership read must receive the caller's signal")
    },
  })
  createHostedFleetService(serverEnvironment(context), { api })
  await assert.rejects(api.request("zones/zone-one/rulesets", { signal: controller.signal }), (error) => error.aborted && error.abortKind === "cancelled")
  assert.deepEqual(calls, ["/client/v4/zones/zone-one"])
})

test("hosted partial coverage reaches MCP as a blocked plan with correlated diagnostics", async (context) => {
  const logs = []
  const requests = []
  context.mock.method(console, "warn", (value) => logs.push(value))
  const zone = { id: "zone-one", name: "alpha.example", account: { id: ACCOUNT } }
  context.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(options.method, "GET")
    const path = new URL(url).pathname
    requests.push(path)
    if (path === "/client/v4/zones") return Response.json({ success: true, result: [zone] })
    if (path === "/client/v4/zones/zone-one") return Response.json({ success: true, result: zone })
    if (path === "/client/v4/zones/zone-one/rulesets") return Response.json({ success: true, result: [{ id: "rate-one", phase: "http_ratelimit", kind: "zone" }] })
    assert.equal(path, "/client/v4/zones/zone-one/rulesets/rate-one")
    return Response.json({ success: false, errors: [{ message: SECRET }] }, { status: 503 })
  })
  const env = serverEnvironment(context)
  const remote = createRemoteFleetService({ environment, fetchImpl: (_url, options) => fetchHostedFleet(new Request("http://localhost/api/commands", options), env) })
  const desired = replaceFleetIntentPolicy((await remote.getIntent()).document, {
    id: "rate-policy", groupId: FLEET_INTENT_ALL_ZONES_GROUP_ID,
    facet: { category: "Ruleset rules", key: "http_ratelimit:guard", label: "Guard", description: "Guard", phase: "http_ratelimit" },
    presenceConstraint: "required", valueConstraint: "exact", expected: createAuthoredFleetIntentExpected({ enabled: true }),
  })
  await remote.applyIntent(desired, (await remote.planIntent(desired)).planSet.digest)
  const server = createFleetMcpServer({ environment, service: remote, stderr: { write() {} } })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "coverage-test", version: "1" })
  context.after(async () => { await client.close(); await server.close() })
  await client.connect(clientTransport)
  for (const request of [
    { name: "plan_alignment", arguments: { selector: { policyId: "rate-policy" } } },
    { name: "apply_alignments", arguments: { selectors: [{ policyId: "rate-policy" }] } },
  ]) {
    const result = await client.callTool(request)
    assert.equal(result.structuredContent.status, "blocked")
    assert.equal(result.structuredContent.planSet, null)
    const coverage = result.structuredContent.coverage || result.structuredContent.alignments[0].coverage
    assert.equal(coverage.complete, false)
    assert.equal(coverage.failures[0].status, 503)
    assert.equal(result.structuredContent.diagnostics.kind, "incomplete-inventory")
    assert.equal(result.structuredContent.diagnostics.requestId, logs.at(-1).requestId)
    assert.equal(logs.at(-1).event, "fleet.command.incomplete-inventory")
    assert.doesNotMatch(JSON.stringify({ result, logs }), new RegExp(SECRET))
  }
  assert.equal(logs.length, 2)
  assert.equal(requests.filter((path) => path === "/client/v4/zones").length, 2)
  assert.equal((await remote.listActivity()).entries.length, 0)
})
