import assert from "node:assert/strict"
import test from "node:test"
import { Client, InMemoryTransport } from "@modelcontextprotocol/client"
import { createFleetMcpServer } from "../src/mcp.mjs"
import { parseFleetArguments, runFleetCli } from "../src/cli.mjs"
import { createRemoteFleetService } from "../src/remote-fleet-service.mjs"
import { createPendingOperationActivity } from "../src/operation-history.mjs"
import { appendHostedOperationActivity } from "../src/hosted/d1-store.mjs"
import { fetchHostedFleet } from "../src/hosted/worker.mjs"
import { hostedD1Fixture } from "./hosted-d1.fixture.mjs"

const ACCOUNT = "account-one"
const ZONE = "zone-one"
const environment = { CLOUDFLARE_FLEET_URL: "https://fleet.example.com", CLOUDFLARE_FLEET_ACCOUNT_ID: ACCOUNT, CLOUDFLARE_FLEET_ACCESS_CLIENT_ID: "test-client", CLOUDFLARE_FLEET_ACCESS_CLIENT_SECRET: "test-secret" }
const empty = { write() {} }

async function connect(context, service) {
  const server = createFleetMcpServer({ service, environment, stderr: empty })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "retrieval-test", version: "1.0.0" }, { capabilities: {} })
  await client.connect(clientTransport)
  context.after(async () => { await client.close(); await server.close() })
  return client
}

function pending(id) {
  return createPendingOperationActivity("Enable HTTPS", {
    validatedAt: "2026-09-14T00:00:00Z",
    plans: [{ id: "https", kind: "setting", summary: "Enable HTTPS", zoneId: ZONE, zoneName: "one.example", operations: [{ method: "PATCH", path: `zones/${ZONE}/settings/always_use_https`, label: "Enable HTTPS", currentValue: { value: "off" }, body: { value: "on" } }] }],
  }, { id })
}

test("CLI exposes bounded retrieval and validates query syntax before selecting a backend", async () => {
  const argumentsByKind = [
    [["activity", "list", "-l2", "--zone-id=zone-one", "--status", "pending"], "activity-list"],
    [["activity", "get", "-i", "entry", "--path", "plans", "--path", "0"], "activity-get"],
    [["intent", "list", "--group-id", "all-zones"], "policy-list"],
    [["intent", "get", "-i", "policy"], "policy-get"],
    [["zone", "list", "-n", "one.example"], "zone-list"],
    [["resource", "list", "-k", "ruleset-rule", "-z", ZONE, "--ruleset-id", "ruleset"], "resource-list"],
    [["facet", "list", "-c", "Zone settings"], "facet-list"],
    [["facet", "inspect", "-c", "Zone settings", "--key", "always_use_https", "-z", ZONE], "facet-inspect"],
  ]
  for (const [argv, kind] of argumentsByKind) {
    const parsed = parseFleetArguments(argv)
    assert.equal(parsed.retrievalKind, kind)
    assert.equal(parsed.query.limit, kind.endsWith("get") ? undefined : argv.includes("-l2") ? 2 : 20)
    assert.equal(parseFleetArguments([...argv, "-h"]).command, "retrieval-help")
  }
  for (const argv of [["activity", "list", "--limit", "-1"], ["zone", "list", "--limit="], ["zone", "list", "--surprise"], ["facet", "list"], ["activity", "get", "--id"], ["activity", "list", "--", "--limit", "1"]]) {
    assert.throws(() => parseFleetArguments(argv))
  }
})

test("CLI and MCP retrieval share the hosted command API, resource discovery and error diagnostics", async (context) => {
  const requests = []
  const settings = [{ id: "always_use_https", value: "on", editable: true }]
  let failSettings = false
  context.mock.method(globalThis, "fetch", async (url, request) => {
    const parsed = new URL(url)
    assert.equal(parsed.origin, "https://api.cloudflare.com")
    assert.equal(request.method, "GET")
    requests.push(parsed.pathname)
    const path = parsed.pathname.slice("/client/v4/".length)
    let result
    if (path === "zones") result = [{ id: ZONE, name: "one.example", account: { id: ACCOUNT } }]
    else if (path === `zones/${ZONE}`) result = { id: ZONE, name: "one.example", account: { id: ACCOUNT } }
    else if (path === `zones/${ZONE}/settings` || path === `zones/${ZONE}/settings/always_use_https`) {
      if (failSettings) return Response.json({ success: false, errors: [{ message: "Read failed", code: 1000 }] }, { status: 503 })
      result = path.endsWith("/always_use_https") ? settings[0] : settings
    } else throw new Error(`Unexpected provider request: ${path}`)
    return Response.json({ success: true, result })
  })
  const env = { FLEET_ACCOUNT_ID: ACCOUNT, FLEET_DB: hostedD1Fixture(context), FLEET_READ_ONLY: "true", CLOUDFLARE_API_TOKEN: "server-secret", ASSETS: { fetch: async () => new Response("Fleet") } }
  for (const id of ["first", "second"]) await appendHostedOperationActivity(env.FLEET_DB, ACCOUNT, pending(id))
  const service = createRemoteFleetService({ environment, fetchImpl: (url, request) => {
    assert.equal(new URL(url).origin, environment.CLOUDFLARE_FLEET_URL)
    return fetchHostedFleet(new Request("http://localhost/api/commands", request), env)
  } })
  const client = await connect(context, service)
  const catalog = await client.listResources()
  assert.deepEqual(catalog.resources.map((resource) => resource.uri), ["fleet://catalog/retrieval"])
  const readCatalog = await client.readResource({ uri: catalog.resources[0].uri })
  assert.ok(JSON.parse(readCatalog.contents[0].text).resourceKinds.includes("dns-record"))
  for (const [name, input] of [
    ["list_activity", { limit: 1 }], ["get_activity", { id: "first", path: ["plans", "0", "operations", "0", "currentValue"] }],
    ["list_fleet_policies", {}], ["get_fleet_policy", { id: "absent" }], ["list_zones", { name: "one.example" }],
    ["list_resources", { kind: "zone-setting", zoneId: ZONE, id: "always_use_https", view: "full" }],
    ["list_facets", { category: "Zone settings", zoneId: ZONE }], ["inspect_facet", { category: "Zone settings", key: "always_use_https", zoneId: ZONE }],
  ]) {
    requests.length = 0
    const result = await client.callTool({ name, arguments: input })
    assert.equal(result.isError, undefined, JSON.stringify(result))
    assert.ok(["ok", "not-found"].includes(result.structuredContent.status), JSON.stringify(result))
    if (name === "list_resources") {
      assert.equal(result.structuredContent.items[0].detail.value.id, "always_use_https")
      assert.ok(requests.includes(`/client/v4/zones/${ZONE}/settings/always_use_https`))
      assert.ok(!requests.includes(`/client/v4/zones/${ZONE}/settings`))
    }
    if (["list_activity", "get_activity", "list_fleet_policies", "get_fleet_policy"].includes(name)) assert.equal(requests.length, 0)
  }
  let output = ""
  let exitCode
  await runFleetCli({ argv: ["activity", "list", "--limit", "1", "--format", "json"], service, environment, stdout: { write: (text) => { output += text } }, stderr: empty, onExitCode: (value) => { exitCode = value } })
  const cliResult = JSON.parse(output)
  assert.equal(cliResult.returned, 1)
  assert.equal(exitCode, 0)
  await appendHostedOperationActivity(env.FLEET_DB, ACCOUNT, pending("new"))
  await assert.rejects(service.retrieve("activity-list", { limit: 1, cursor: cliResult.nextCursor }), (error) => error instanceof TypeError && /cursor/.test(error.message))
  output = ""
  await runFleetCli({ argv: ["activity", "list", "--limit", "1", "--cursor", cliResult.nextCursor, "--format", "json"], service, environment, stdout: { write: (text) => { output += text } }, stderr: empty, onExitCode: (value) => { exitCode = value } })
  assert.equal(exitCode, 2)
  assert.equal(JSON.parse(output).status, "usage-error")
  failSettings = true
  const warnings = []
  context.mock.method(console, "warn", (value) => warnings.push(value))
  const incomplete = await client.callTool({ name: "inspect_facet", arguments: { category: "Zone settings", key: "always_use_https", zoneId: ZONE } })
  assert.equal(incomplete.isError, undefined, JSON.stringify(incomplete))
  assert.equal(incomplete.structuredContent.status, "incomplete")
  assert.equal(incomplete.structuredContent.intent.status, "unknown")
  assert.equal(incomplete.structuredContent.coverage.failures[0].status, 503)
  assert.equal(warnings[0].requestId, incomplete.structuredContent.diagnostics.requestId)
  assert.doesNotMatch(JSON.stringify(incomplete), /server-secret/)
  output = ""
  await runFleetCli({ argv: ["facet", "inspect", "--category", "Zone settings", "--key", "always_use_https", "--zone-id", ZONE], service, environment, stdout: { write: (text) => { output += text } }, stderr: empty, onExitCode: (value) => { exitCode = value } })
  assert.equal(exitCode, 4)
  assert.match(output, /Intent: unknown/)
  assert.match(output, /Request ID:/)
})
