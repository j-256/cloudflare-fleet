import assert from "node:assert/strict"
import process from "node:process"
import test from "node:test"

import {
  Client,
  InMemoryTransport,
} from "@modelcontextprotocol/client"
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio"

import { createFleetMcpServer } from "../src/mcp.mjs"

const DIGEST = `sha256:${"a".repeat(64)}`
const DIFFERENT_DIGEST = `sha256:${"b".repeat(64)}`
const SECRET = "test-cloudflare-token"
const SELECTOR = Object.freeze({ policyId: "policy-one" })

function plannedAlignment(overrides = {}) {
  return {
    accountId: "account-one",
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
    planSet: {
      digest: DIGEST,
      intentRevision: "intent-one",
      plans: [{
        operations: [{
          body: { value: "on" },
          label: "Enable Always Use HTTPS",
          method: "PATCH",
          path: "zones/zone-one/settings/always_use_https",
        }],
        zoneId: "zone-one",
        zoneName: "one.example",
      }],
      preview: [{
        body: { value: "on" },
        label: "Enable Always Use HTTPS",
        method: "PATCH",
        path: "zones/zone-one/settings/always_use_https",
        zoneId: "zone-one",
        zoneName: "one.example",
      }],
      validatedAt: "2026-08-12T00:00:00.000Z",
    },
    reason: "One target differs",
    schemaVersion: 1,
    selector: { kind: "policy", policyId: "policy-one" },
    status: "planned",
    ...overrides,
  }
}

function verifiedAlignment() {
  return {
    accountId: "account-one",
    activity: { id: "activity-one", status: "verified" },
    applied: true,
    error: null,
    execution: { completed: 1, total: 1 },
    historyError: null,
    inverse: { available: true, plans: [] },
    planDigest: DIGEST,
    schemaVersion: 1,
    selector: { kind: "policy", policyId: "policy-one" },
    status: "verified",
    verification: [{
      status: 200,
      target: {
        kind: "setting",
        settingId: "always_use_https",
        zoneId: "zone-one",
      },
    }],
  }
}

function serviceFixture(overrides = {}) {
  const calls = {
    apply: [],
    listActivity: 0,
    listAlignments: 0,
    plan: [],
  }
  const service = {
    accountId: "account-one",
    async applyAlignment(selector, digest) {
      calls.apply.push({ digest, selector })
      return overrides.applyResult || verifiedAlignment()
    },
    async listActivity() {
      calls.listActivity += 1
      if (overrides.activityError) throw overrides.activityError
      return {
        accountId: "account-one",
        entries: [],
        revision: "",
        schemaVersion: 1,
        status: "ok",
        updatedAt: null,
      }
    },
    async listAlignments() {
      calls.listAlignments += 1
      return {
        accountId: "account-one",
        candidates: [],
        intentRevision: "intent-one",
        schemaVersion: 1,
        status: "ok",
        summary: {
          availableCandidates: 0,
          blockedCandidates: 0,
          candidates: 0,
          zones: 1,
        },
      }
    },
    async planAlignment(selector) {
      calls.plan.push(selector)
      return overrides.planResult || plannedAlignment()
    },
    stateFile: "/unused/fleet-state.json",
  }
  return { calls, service }
}

function auditReport() {
  return {
    accountId: "account-one",
    findings: [],
    generatedAt: "2026-08-12T00:00:00.000Z",
    inventoryLoadedAt: "2026-08-12T00:00:00.000Z",
    mode: "core",
    schemaVersion: 1,
    summary: {
      findings: 0,
      zones: 1,
    },
  }
}

async function connectedFixture(context, options = {}) {
  const serviceData = serviceFixture(options.serviceOverrides)
  const auditCalls = []
  const server = createFleetMcpServer({
    auditFleet: options.auditFleet || (async (auditOptions) => {
      auditCalls.push(auditOptions)
      return auditReport()
    }),
    environment: { CLOUDFLARE_API_TOKEN: SECRET },
    requestStateKey: new Uint8Array(32).fill(7),
    service: serviceData.service,
    stderr: { write() {} },
  })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client(
    { name: "cloudflare-fleet-test", version: "1.0.0" },
    { capabilities: { elicitation: {} } },
  )
  if (options.elicitationHandler) {
    client.setRequestHandler(
      "elicitation/create",
      options.elicitationHandler,
    )
  }
  await client.connect(clientTransport)
  context.after(async () => {
    try {
      await client.close()
    } catch {}
    try {
      await server.close()
    } catch {}
  })
  return {
    auditCalls,
    client,
    ...serviceData,
  }
}

test("MCP server advertises the bounded fleet tools and accurate annotations", async (context) => {
  const { client } = await connectedFixture(context)

  const result = await client.listTools()

  assert.deepEqual(
    result.tools.map((entry) => entry.name),
    [
      "audit_fleet",
      "list_alignment_candidates",
      "plan_alignment",
      "apply_alignment",
      "list_activity",
    ],
  )
  const apply = result.tools.find((entry) => entry.name === "apply_alignment")
  assert.deepEqual(apply.annotations, {
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
    readOnlyHint: false,
  })
  assert.deepEqual(apply.inputSchema.required, ["planDigest", "selector"])
  assert.deepEqual(apply.outputSchema.required, ["schemaVersion", "status"])
  const activity = result.tools.find((entry) => entry.name === "list_activity")
  assert.equal(activity.annotations.openWorldHint, false)
  assert.doesNotMatch(JSON.stringify(result), new RegExp(SECRET))
})

test("MCP read tools return structured service and audit results", async (context) => {
  const { auditCalls, calls, client } = await connectedFixture(context)

  const [audit, candidates, plan, activity] = await Promise.all([
    client.callTool({
      arguments: { deep: true },
      name: "audit_fleet",
    }),
    client.callTool({
      arguments: {},
      name: "list_alignment_candidates",
    }),
    client.callTool({
      arguments: { selector: SELECTOR },
      name: "plan_alignment",
    }),
    client.callTool({
      arguments: {},
      name: "list_activity",
    }),
  ])

  assert.equal(audit.structuredContent.report.summary.findings, 0)
  assert.equal(auditCalls[0].deep, true)
  assert.equal(candidates.structuredContent.status, "ok")
  assert.equal(plan.structuredContent.planSet.digest, DIGEST)
  assert.match(plan.content[0].text, new RegExp(DIGEST))
  assert.equal(activity.structuredContent.status, "ok")
  assert.equal(calls.listAlignments, 1)
  assert.equal(calls.listActivity, 1)
  assert.deepEqual(calls.plan, [SELECTOR])
})

test("MCP apply elicits exact plan review before invoking the write service", async (context) => {
  let request
  const { calls, client } = await connectedFixture(context, {
    elicitationHandler: async (incoming) => {
      request = incoming
      return {
        action: "accept",
        content: {
          approve: true,
          confirmDigest: DIGEST,
        },
      }
    },
  })

  const result = await client.callTool({
    arguments: {
      planDigest: DIGEST,
      selector: SELECTOR,
    },
    name: "apply_alignment",
  })

  assert.equal(result.structuredContent.status, "verified")
  assert.equal(result.isError, undefined)
  assert.equal(calls.plan.length, 1)
  assert.deepEqual(calls.apply, [{
    digest: DIGEST,
    selector: { kind: "policy", policyId: "policy-one" },
  }])
  assert.match(request.params.message, /account account-one/)
  assert.match(request.params.message, new RegExp(DIGEST))
  assert.match(request.params.message, /PATCH zones\/zone-one\/settings\/always_use_https/)
  assert.match(request.params.message, /Body: \{"value":"on"\}/)
  assert.deepEqual(request.params.requestedSchema.required, [
    "approve",
    "confirmDigest",
  ])
})

test("MCP apply stops cleanly when confirmation is declined", async (context) => {
  const { calls, client } = await connectedFixture(context, {
    elicitationHandler: async () => ({ action: "decline" }),
  })

  const result = await client.callTool({
    arguments: {
      planDigest: DIGEST,
      selector: SELECTOR,
    },
    name: "apply_alignment",
  })

  assert.equal(result.structuredContent.status, "confirmation-declined")
  assert.equal(result.isError, undefined)
  assert.equal(calls.apply.length, 0)
})

test("MCP apply refuses confirmation with a different digest", async (context) => {
  const { calls, client } = await connectedFixture(context, {
    elicitationHandler: async () => ({
      action: "accept",
      content: {
        approve: true,
        confirmDigest: DIFFERENT_DIGEST,
      },
    }),
  })

  const result = await client.callTool({
    arguments: {
      planDigest: DIGEST,
      selector: SELECTOR,
    },
    name: "apply_alignment",
  })

  assert.equal(result.structuredContent.status, "confirmation-invalid")
  assert.equal(result.isError, true)
  assert.equal(calls.apply.length, 0)
})

test("MCP apply refuses a changed plan before requesting confirmation", async (context) => {
  let elicitationCalls = 0
  const { calls, client } = await connectedFixture(context, {
    elicitationHandler: async () => {
      elicitationCalls += 1
      return { action: "cancel" }
    },
    serviceOverrides: {
      planResult: plannedAlignment({
        planSet: {
          ...plannedAlignment().planSet,
          digest: DIFFERENT_DIGEST,
        },
      }),
    },
  })

  const result = await client.callTool({
    arguments: {
      planDigest: DIGEST,
      selector: SELECTOR,
    },
    name: "apply_alignment",
  })

  assert.equal(result.structuredContent.status, "plan-changed")
  assert.equal(result.structuredContent.actualDigest, DIFFERENT_DIGEST)
  assert.equal(elicitationCalls, 0)
  assert.equal(calls.apply.length, 0)
})

test("MCP tool errors redact the Cloudflare API token", async (context) => {
  const { client } = await connectedFixture(context, {
    serviceOverrides: {
      activityError: new Error(`Activity failed with ${SECRET}`),
    },
  })

  const result = await client.callTool({
    arguments: {},
    name: "list_activity",
  })

  assert.equal(result.isError, true)
  assert.equal(result.structuredContent.status, "error")
  assert.match(result.content[0].text, /\[redacted\]/)
  assert.doesNotMatch(JSON.stringify(result), new RegExp(SECRET))
})

test("MCP stdio entrypoint negotiates the modern protocol without stdout noise", async (context) => {
  const transport = new StdioClientTransport({
    args: ["src/mcp.mjs"],
    command: process.execPath,
    cwd: process.cwd(),
    env: {
      CLOUDFLARE_ACCOUNT_ID: "account-one",
      CLOUDFLARE_API_TOKEN: SECRET,
      PATH: process.env.PATH || "",
    },
    stderr: "pipe",
  })
  let diagnostics = ""
  transport.stderr.on("data", (chunk) => {
    diagnostics += chunk
  })
  const client = new Client(
    { name: "cloudflare-fleet-stdio-test", version: "1.0.0" },
    {
      capabilities: { elicitation: {} },
      versionNegotiation: { mode: { pin: "2026-07-28" } },
    },
  )
  context.after(async () => {
    try {
      await client.close()
    } catch {}
  })

  await client.connect(transport)
  const result = await client.listTools()

  assert.deepEqual(
    result.tools.map((entry) => entry.name),
    [
      "audit_fleet",
      "list_alignment_candidates",
      "plan_alignment",
      "apply_alignment",
      "list_activity",
    ],
  )
  assert.match(diagnostics, /stdio server ready/)
  assert.doesNotMatch(diagnostics, new RegExp(SECRET))
})
