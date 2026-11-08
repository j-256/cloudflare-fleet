import assert from "node:assert/strict"
import test from "node:test"
import os from "node:os"
import path from "node:path"
import { createFleetService } from "../src/fleet-service.mjs"
import { createEmptyFleetIntentDocument } from "../src/fleet-intent.mjs"
import { runFleetServiceCommand } from "../src/fleet-command.mjs"
import { makeInventory, makeZone } from "./fixtures.mjs"
import { Client, InMemoryTransport } from "@modelcontextprotocol/client"
import { createFleetMcpServer } from "../src/mcp.mjs"
import { createDemoFleet } from "./demo-fleet.mjs"

test("bounded queue discovery is read-only and pagination rejects a changed queue", async () => {
  const inventory = makeInventory([
    makeZone("one.example"),
    makeZone("two.example", { settings: [{ id: "always_use_https", value: "off" }] }),
  ])
  const intent = createEmptyFleetIntentDocument(inventory.account.id)
  let reads = 0
  const service = createFleetService({
    accountId: inventory.account.id, api: { accountId: inventory.account.id }, stateFile: path.join(os.tmpdir(), "fleet-review-unused.json"),
    readState: async () => ({ intent }),
    loadInventory: async () => { reads += 1; return inventory },
  })
  await assert.rejects(() => service.listReviewQueue({ limit: 500 }))
  assert.equal(reads, 0)
  const page = await runFleetServiceCommand(service, {
    version: 1, accountId: inventory.account.id, command: "review-queue", input: { queue: "decisions", limit: 1 },
  }, { readOnly: true })
  assert.equal(page.items.length, 1)
  assert.equal(page.summary.configured, false)
  assert.equal(typeof page.revision, "string")
  inventory.loadedAt = "2026-11-07T00:00:00.000Z"
  const continued = await service.listReviewQueue({ queue: "decisions", offset: 1, revision: page.revision })
  assert.equal(continued.revision, page.revision)
  inventory.zones[0].surfaces.dns.result[0].ttl += 1
  await assert.rejects(() => service.listReviewQueue({ queue: "decisions", offset: 1, revision: page.revision }), /changed/i)
  inventory.zones[1].surfaces.settings.result[0].value = "on"
  await assert.rejects(() => service.listReviewQueue({ queue: "decisions", offset: 1, revision: page.revision }), /changed/i)
})

test("MCP exposes the same bounded queues and rejects oversized discovery", async (context) => {
  const { inventory, intent } = createDemoFleet()
  let reads = 0
  const service = createFleetService({
    accountId: inventory.account.id, api: { accountId: inventory.account.id }, stateFile: path.join(os.tmpdir(), "fleet-review-unused.json"),
    readState: async () => ({ intent }),
    loadInventory: async () => { reads += 1; return inventory },
  })
  const server = createFleetMcpServer({ service, environment: {}, stderr: { write() {} } })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "review-queue-test", version: "1.0.0" })
  await client.connect(clientTransport)
  context.after(async () => { await client.close(); await server.close() })
  const invalid = await client.callTool({ name: "list_review_queue", arguments: { limit: 1000 } })
  assert.equal(invalid.isError, true)
  assert.equal(reads, 0)
  const result = await client.callTool({ name: "list_review_queue", arguments: { queue: "misalignments", limit: 1 } })
  assert.notEqual(result.isError, true)
  assert.equal(result.structuredContent.summary.configured, true)
  assert.equal(result.structuredContent.items.length, 1)
  assert.equal(result.structuredContent.items[0].observed[0].expected, "on")
  assert.equal(result.structuredContent.items[0].observed[0].value, "off")
  assert.ok(result.structuredContent.summary.reads > 0)
  assert.equal(reads, 1)
})
