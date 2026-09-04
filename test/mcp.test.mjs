import assert from "node:assert/strict"
import process from "node:process"
import test from "node:test"

import {
  Client,
  InMemoryTransport,
} from "@modelcontextprotocol/client"
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio"

import {
  createFleetMcpServer,
  runFleetMcpMain,
} from "../src/mcp.mjs"
import { createEmptyFleetIntentDocument } from "../src/fleet-intent.mjs"

const DIGEST = `sha256:${"a".repeat(64)}`
const DIFFERENT_DIGEST = `sha256:${"b".repeat(64)}`
const SECRET = "test-cloudflare-token"
const SELECTOR = Object.freeze({ policyId: "policy-one" })
const BATCH_SELECTORS = Object.freeze([
  SELECTOR,
  Object.freeze({
    category: "Zone settings",
    key: "early_hints",
    zoneIds: ["zone-one"],
  }),
])
const NORMALIZED_BATCH_SELECTORS = Object.freeze([
  Object.freeze({ kind: "policy", policyId: "policy-one" }),
  Object.freeze({
    category: "Zone settings",
    key: "early_hints",
    kind: "cell",
    phase: "",
    zoneIds: ["zone-one"],
  }),
])
const INTENT_DOCUMENT = Object.freeze(
  createEmptyFleetIntentDocument("account-one"),
)
const CHANGE = Object.freeze({
  desired: "on",
  kind: "zone-setting-update",
  settingId: "always_use_https",
  zoneId: "zone-one",
})
const TOOL_NAMES = Object.freeze([
  "get_runtime_status",
  "audit_fleet",
  "describe_zone_alias_policy",
  "get_fleet_intent",
  "plan_fleet_intent",
  "apply_fleet_intent",
  "list_alignment_candidates",
  "plan_alignment",
  "apply_alignment",
  "apply_alignments",
  "plan_fleet_change",
  "apply_fleet_change",
  "list_activity",
  "plan_activity_undo",
  "apply_activity_undo",
])

function reviewedPlan(request, overrides = {}) {
  return {
    accountId: "account-one",
    planSet: {
      digest: DIGEST,
      plans: [{
        operations: [{
          body: { value: "on" },
          currentValue: { value: "off" },
          label: "Enable Always Use HTTPS",
          method: "PATCH",
          path: "zones/zone-one/settings/always_use_https",
        }],
        zoneId: "zone-one",
        zoneName: "one.example",
      }],
      preview: [{
        body: { value: "on" },
        currentValue: { value: "off" },
        label: "Enable Always Use HTTPS",
        method: "PATCH",
        path: "zones/zone-one/settings/always_use_https",
        zoneId: "zone-one",
        zoneName: "one.example",
      }],
      request,
      validatedAt: "2026-08-28T00:00:00.000Z",
    },
    reason: "One bounded write prepared",
    schemaVersion: 1,
    status: "planned",
    ...overrides,
  }
}

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
          currentValue: { value: "off" },
          label: "Enable Always Use HTTPS",
          method: "PATCH",
          path: "zones/zone-one/settings/always_use_https",
        }],
        zoneId: "zone-one",
        zoneName: "one.example",
      }],
      preview: [{
        body: { value: "on" },
        currentValue: { value: "off" },
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

function plannedAlignmentBatch(overrides = {}) {
  return {
    accountId: "account-one",
    alignments: [
      {
        facet: {
          category: "settings",
          key: "always_use_https",
          label: "Always Use HTTPS",
          phase: "",
        },
        selector: NORMALIZED_BATCH_SELECTORS[0],
        status: "planned",
      },
      {
        facet: {
          category: "settings",
          key: "early_hints",
          label: "Early Hints",
          phase: "",
        },
        selector: NORMALIZED_BATCH_SELECTORS[1],
        status: "planned",
      },
    ],
    planSet: {
      digest: DIGEST,
      intentRevision: "intent-one",
      plans: [
        {
          operations: [{
            body: { value: "on" },
            label: "Enable Always Use HTTPS",
            method: "PATCH",
            path: "zones/zone-one/settings/always_use_https",
          }],
          zoneId: "zone-one",
          zoneName: "one.example",
        },
        {
          operations: [{
            body: { value: "on" },
            label: "Enable Early Hints",
            method: "PATCH",
            path: "zones/zone-one/settings/early_hints",
          }],
          zoneId: "zone-one",
          zoneName: "one.example",
        },
      ],
      preview: [
        {
          body: { value: "on" },
          label: "Enable Always Use HTTPS",
          method: "PATCH",
          path: "zones/zone-one/settings/always_use_https",
          zoneId: "zone-one",
          zoneName: "one.example",
        },
        {
          body: { value: "on" },
          label: "Enable Early Hints",
          method: "PATCH",
          path: "zones/zone-one/settings/early_hints",
          zoneId: "zone-one",
          zoneName: "one.example",
        },
      ],
      selectors: NORMALIZED_BATCH_SELECTORS,
      validatedAt: "2026-08-13T00:00:00.000Z",
    },
    reason: "Two targets differ",
    schemaVersion: 1,
    selectors: NORMALIZED_BATCH_SELECTORS,
    status: "planned",
    ...overrides,
  }
}

function verifiedAlignmentBatch() {
  return {
    ...verifiedAlignment(),
    selector: undefined,
    selectors: NORMALIZED_BATCH_SELECTORS,
  }
}

function serviceFixture(overrides = {}) {
  const calls = {
    applyChange: [],
    applyIntent: [],
    applyUndo: [],
    apply: [],
    applyBatch: [],
    getIntent: 0,
    listActivity: 0,
    listAlignments: 0,
    plan: [],
    planBatch: [],
    planChange: [],
    planIntent: [],
    planUndo: [],
  }
  const service = {
    accountId: "account-one",
    async applyActivityUndo(activityId, digest) {
      calls.applyUndo.push({ activityId, digest })
      return {
        ...verifiedAlignment(),
        activityId,
        selector: undefined,
      }
    },
    async applyAlignment(selector, digest) {
      calls.apply.push({ digest, selector })
      return overrides.applyResult || verifiedAlignment()
    },
    async applyAlignments(selectors, digest) {
      calls.applyBatch.push({ digest, selectors })
      return overrides.applyBatchResult || verifiedAlignmentBatch()
    },
    async applyChange(change, digest) {
      calls.applyChange.push({ change, digest })
      return {
        ...verifiedAlignment(),
        change,
        selector: undefined,
        title: "Update zone setting",
      }
    },
    async applyIntent(document, digest) {
      calls.applyIntent.push({ digest, document })
      return {
        accountId: "account-one",
        applied: true,
        document: {
          ...document,
          revision: "c".repeat(64),
          updatedAt: "2026-08-28T00:00:00.000Z",
        },
        planDigest: digest,
        schemaVersion: 1,
        status: "saved",
      }
    },
    async getIntent() {
      calls.getIntent += 1
      return {
        accountId: "account-one",
        document: INTENT_DOCUMENT,
        schemaVersion: 1,
        status: "ok",
      }
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
    async planAlignments(selectors) {
      calls.planBatch.push(selectors)
      return overrides.planBatchResult || plannedAlignmentBatch()
    },
    async planActivityUndo(activityId) {
      calls.planUndo.push(activityId)
      return reviewedPlan({
        activityId,
        activityRevision: "activity-one",
        kind: "activity-undo",
      }, {
        activityId,
        entry: { id: activityId, title: "Enable HTTPS" },
      })
    },
    async planChange(change) {
      calls.planChange.push(change)
      return reviewedPlan(change, {
        change,
        title: "Update zone setting",
      })
    },
    async planIntent(document) {
      calls.planIntent.push(document)
      const result = reviewedPlan({
        document,
        expectedRevision: document.revision,
        kind: "fleet-intent-replace",
      }, {
        diff: {
          acknowledgements: { added: [], changed: [], removed: [] },
          coverageExpectations: { added: [], changed: [], removed: [] },
          groups: { added: [], changed: [], removed: [] },
          policies: { added: [], changed: [], removed: [] },
        },
      })
      result.planSet.plans = []
      result.planSet.preview = []
      return result
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

function runtimeStatus() {
  return {
    checkedAt: "2026-08-30T00:00:00.000Z",
    checks: [{
      detail: "Node.js is supported",
      id: "runtime.node",
      label: "Node.js runtime",
      status: "pass",
    }],
    credentials: {
      accountId: { environmentName: "CLOUDFLARE_ACCOUNT_ID", present: true },
      apiToken: { environmentName: "CLOUDFLARE_API_TOKEN", present: true },
    },
    dashboard: {
      available: false,
      dependencies: [],
      reason: "CLI and MCP workflows remain available",
      status: "unsupported",
    },
    live: { requested: false, status: "skipped" },
    paths: {
      policy: {
        accessible: false,
        exists: false,
        kind: "missing",
        mode: null,
        path: "/profiles/policy.json",
        source: "default",
        sourceName: "per-user default",
        symbolicLink: false,
      },
      state: {
        accessible: true,
        exists: true,
        kind: "file",
        mode: "0600",
        path: "/profiles/state.json",
        source: "argument",
        sourceName: "--state-file",
        symbolicLink: false,
      },
    },
    runtime: {
      architecture: "arm64",
      node: { minimumMajor: 22, supported: true, version: "22.0.0" },
      packageVersion: "0.1.0",
      platform: "darwin",
    },
    schemaVersion: 1,
    status: "ready",
    summary: { fail: 0, pass: 1, skip: 0, warning: 0 },
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
    diagnoseRuntime: options.diagnoseRuntime || (async () => runtimeStatus()),
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

function approvedElicitation(request) {
  return {
    action: "accept",
    content: Object.fromEntries(
      request.params.requestedSchema.required.map((key) => [key, "approve"]),
    ),
  }
}

function elicitationReviewText(request) {
  return Object.values(request.params.requestedSchema.properties)
    .map((field) => `${field.title}\n${field.description}`)
    .join("\n")
}

test("MCP server advertises the bounded fleet tools and accurate annotations", async (context) => {
  const { client } = await connectedFixture(context)

  const result = await client.listTools()

  assert.deepEqual(
    result.tools.map((entry) => entry.name),
    TOOL_NAMES,
  )
  const apply = result.tools.find((entry) => entry.name === "apply_alignment")
  assert.deepEqual(apply.annotations, {
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
    readOnlyHint: false,
  })
  assert.deepEqual(apply.inputSchema.required, ["planDigest", "selector"])
  assert.match(JSON.stringify(apply.outputSchema), /execution/)
  const applyBatch = result.tools.find((entry) => entry.name === "apply_alignments")
  assert.deepEqual(applyBatch.inputSchema.required, ["selectors"])
  assert.equal(
    Object.hasOwn(applyBatch.inputSchema.properties, "planDigest"),
    false,
  )
  const activity = result.tools.find((entry) => entry.name === "list_activity")
  assert.equal(activity.annotations.openWorldHint, false)
  assert.match(JSON.stringify(activity.outputSchema), /"title"/)
  const candidates = result.tools.find(
    (entry) => entry.name === "list_alignment_candidates",
  )
  assert.match(JSON.stringify(candidates.outputSchema), /"assessment"/)
  const change = result.tools.find((entry) => entry.name === "plan_fleet_change")
  assert.doesNotMatch(JSON.stringify(change.inputSchema), /"method"|"path"/)
  assert.match(JSON.stringify(change.outputSchema), /"operations"/)
  const intentApply = result.tools.find((entry) => entry.name === "apply_fleet_intent")
  assert.equal(intentApply.annotations.openWorldHint, false)
  const aliases = result.tools.find(
    (entry) => entry.name === "describe_zone_alias_policy",
  )
  assert.equal(aliases.annotations.readOnlyHint, true)
  assert.match(JSON.stringify(aliases.outputSchema), /canonicalization-dns-mail-security-v1/)
  assert.match(JSON.stringify(aliases.outputSchema), /includeSubdomains/)
  assert.match(JSON.stringify(aliases.outputSchema), /unreadSurfaces/)
  const runtime = result.tools.find((entry) => entry.name === "get_runtime_status")
  assert.equal(runtime.annotations.readOnlyHint, true)
  assert.match(JSON.stringify(runtime.outputSchema), /"checks"/)
  assert.doesNotMatch(JSON.stringify(result), new RegExp(SECRET))
})

test("MCP read tools return structured service and audit results", async (context) => {
  const { auditCalls, calls, client } = await connectedFixture(context)

  const [
    audit,
    aliases,
    intent,
    intentPlan,
    candidates,
    plan,
    changePlan,
    activity,
    undoPlan,
    runtime,
  ] = await Promise.all([
    client.callTool({
      arguments: { deep: true },
      name: "audit_fleet",
    }),
    client.callTool({
      arguments: {},
      name: "describe_zone_alias_policy",
    }),
    client.callTool({
      arguments: {},
      name: "get_fleet_intent",
    }),
    client.callTool({
      arguments: { document: INTENT_DOCUMENT },
      name: "plan_fleet_intent",
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
      arguments: { change: CHANGE },
      name: "plan_fleet_change",
    }),
    client.callTool({
      arguments: {},
      name: "list_activity",
    }),
    client.callTool({
      arguments: { activityId: "activity-one" },
      name: "plan_activity_undo",
    }),
    client.callTool({
      arguments: { live: false },
      name: "get_runtime_status",
    }),
  ])

  assert.equal(audit.structuredContent.report.summary.findings, 0)
  assert.equal(auditCalls[0].deep, true)
  assert.equal(aliases.structuredContent.templates.length, 3)
  assert.match(aliases.structuredContent.limitations[0], /Legacy Page Rules/)
  assert.equal(
    aliases.structuredContent.templates[0].value.kind,
    "canonical-web-passthrough",
  )
  assert.equal(intent.structuredContent.document.accountId, "account-one")
  assert.equal(intentPlan.structuredContent.planSet.digest, DIGEST)
  assert.equal(candidates.structuredContent.status, "ok")
  assert.equal(plan.structuredContent.planSet.digest, DIGEST)
  assert.match(plan.content[0].text, new RegExp(DIGEST))
  assert.equal(activity.structuredContent.status, "ok")
  assert.equal(changePlan.structuredContent.planSet.digest, DIGEST)
  assert.equal(undoPlan.structuredContent.activityId, "activity-one")
  assert.equal(runtime.structuredContent.status, "ready")
  assert.match(runtime.content[0].text, /is ready/)
  assert.deepEqual(
    JSON.parse(plan.content[1].text),
    plan.structuredContent,
  )
  assert.equal(calls.getIntent, 1)
  assert.equal(calls.listAlignments, 1)
  assert.equal(calls.listActivity, 1)
  assert.deepEqual(calls.plan, [SELECTOR])
  assert.deepEqual(calls.planChange, [CHANGE])
  assert.deepEqual(calls.planIntent, [INTENT_DOCUMENT])
  assert.deepEqual(calls.planUndo, ["activity-one"])
})

test("MCP runtime diagnostics remain available before Cloudflare credentials are configured", async (context) => {
  const server = createFleetMcpServer({
    diagnoseRuntime: async ({ live }) => ({
      ...runtimeStatus(),
      live: { requested: live, status: "skipped" },
    }),
    environment: {},
    stderr: { write() {} },
  })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client(
    { name: "cloudflare-fleet-runtime-test", version: "1.0.0" },
    { capabilities: {} },
  )
  await client.connect(clientTransport)
  context.after(async () => {
    await client.close()
    await server.close()
  })

  const tools = await client.listTools()
  const result = await client.callTool({
    arguments: {},
    name: "get_runtime_status",
  })

  assert.equal(tools.tools[0].name, "get_runtime_status")
  assert.equal(result.structuredContent.status, "ready")
})

test("MCP apply elicits one explicit plan approval before invoking the write service", async (context) => {
  let request
  const { calls, client } = await connectedFixture(context, {
    elicitationHandler: async (incoming) => {
      request = incoming
      return approvedElicitation(incoming)
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
  const review = elicitationReviewText(request)
  assert.match(request.params.message, /Account: account-one/)
  assert.match(request.params.message, new RegExp(DIGEST))
  assert.match(review, /API: PATCH settings\/always_use_https/)
  assert.match(review, /value: "off" -> "on"/)
  assert.doesNotMatch(review, /Body:|Current:/)
  assert.deepEqual(request.params.requestedSchema.required, ["review_1"])
  assert.deepEqual(
    request.params.requestedSchema.properties.review_1.oneOf,
    [
      { const: "decline", title: "Do not apply" },
      { const: "approve", title: "Approve this change" },
    ],
  )
  assert.equal(
    Object.hasOwn(request.params.requestedSchema.properties, "confirmDigest"),
    false,
  )
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

test("MCP apply stops cleanly when a review field rejects the plan", async (context) => {
  const { calls, client } = await connectedFixture(context, {
    elicitationHandler: async (request) => {
      const response = approvedElicitation(request)
      response.content.review_1 = "decline"
      return response
    },
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

test("MCP apply refuses an unchecked confirmation", async (context) => {
  const { calls, client } = await connectedFixture(context, {
    elicitationHandler: async () => ({
      action: "accept",
      content: {},
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

test("MCP batch apply elicits one combined review and fresh apply", async (context) => {
  let request
  let elicitations = 0
  const { calls, client } = await connectedFixture(context, {
    elicitationHandler: async (incoming) => {
      elicitations += 1
      request = incoming
      return approvedElicitation(incoming)
    },
  })

  const result = await client.callTool({
    arguments: { selectors: BATCH_SELECTORS },
    name: "apply_alignments",
  })

  assert.equal(result.structuredContent.status, "verified")
  assert.equal(result.isError, undefined)
  assert.equal(elicitations, 1)
  assert.deepEqual(calls.planBatch, [NORMALIZED_BATCH_SELECTORS])
  assert.deepEqual(calls.applyBatch, [{
    digest: DIGEST,
    selectors: NORMALIZED_BATCH_SELECTORS,
  }])
  const review = elicitationReviewText(request)
  assert.match(request.params.message, /alignment batch/)
  assert.match(request.params.message, /Scopes: 2/)
  assert.match(review, /Enable Always Use HTTPS/)
  assert.match(review, /Enable Early Hints/)
  assert.match(review, /settings\/always_use_https/)
  assert.match(review, /settings\/early_hints/)
  assert.deepEqual(
    request.params.requestedSchema.required,
    ["review_1", "review_2"],
  )
})

test("MCP batch apply stops without writing when confirmation is declined", async (context) => {
  const { calls, client } = await connectedFixture(context, {
    elicitationHandler: async () => ({ action: "decline" }),
  })

  const result = await client.callTool({
    arguments: { selectors: BATCH_SELECTORS },
    name: "apply_alignments",
  })

  assert.equal(result.structuredContent.status, "confirmation-declined")
  assert.equal(calls.applyBatch.length, 0)
})

test("MCP batch apply rejects a partially reviewed operation set", async (context) => {
  const { calls, client } = await connectedFixture(context, {
    elicitationHandler: async () => ({
      action: "accept",
      content: { review_1: "approve" },
    }),
  })

  const result = await client.callTool({
    arguments: { selectors: BATCH_SELECTORS },
    name: "apply_alignments",
  })

  assert.equal(result.structuredContent.status, "confirmation-invalid")
  assert.equal(result.isError, true)
  assert.equal(calls.applyBatch.length, 0)
})

test("MCP reviewed mutation tools bind intent, direct changes, and undo to signed confirmation", async (context) => {
  const requests = []
  const { calls, client } = await connectedFixture(context, {
    elicitationHandler: async (request) => {
      requests.push(request)
      return approvedElicitation(request)
    },
  })

  const intent = await client.callTool({
    arguments: {
      document: INTENT_DOCUMENT,
      planDigest: DIGEST,
    },
    name: "apply_fleet_intent",
  })
  const change = await client.callTool({
    arguments: {
      change: CHANGE,
      planDigest: DIGEST,
    },
    name: "apply_fleet_change",
  })
  const undo = await client.callTool({
    arguments: {
      activityId: "activity-one",
      planDigest: DIGEST,
    },
    name: "apply_activity_undo",
  })

  assert.equal(intent.structuredContent.status, "saved")
  assert.equal(change.structuredContent.status, "verified")
  assert.equal(undo.structuredContent.status, "verified")
  assert.equal(calls.applyIntent.length, 1)
  assert.equal(calls.applyChange.length, 1)
  assert.equal(calls.applyUndo.length, 1)
  assert.equal(requests.length, 3)
  assert.doesNotMatch(requests[0].params.message, /Exact request:/)
  assert.match(elicitationReviewText(requests[0]), /Cloudflare API writes: none/)
  assert.match(elicitationReviewText(requests[1]), /value: "off" -> "on"/)
  assert.match(requests[2].params.message, /Activity: activity-one/)
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

test("MCP direct entrypoint applies explicit state and policy profiles", async () => {
  const environment = {
    CLOUDFLARE_ACCOUNT_ID: "account-one",
    CLOUDFLARE_API_TOKEN: SECRET,
  }
  const stderr = { write() {} }
  let serverOptions

  const result = await runFleetMcpMain({
    argv: [
      "--state-file",
      "profiles/state.json",
      "--policy-file=profiles/policy.json",
    ],
    environment,
    runServer(options) {
      serverOptions = options
      return "started"
    },
    stderr,
  })

  assert.equal(result, "started")
  assert.deepEqual(serverOptions, {
    environment,
    policyFile: "profiles/policy.json",
    stateFile: "profiles/state.json",
    stderr,
  })
})

test("MCP direct entrypoint rejects unknown options", async () => {
  await assert.rejects(
    runFleetMcpMain({ argv: ["--definitely-invalid"] }),
    /Unknown option: --definitely-invalid/,
  )
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
    TOOL_NAMES,
  )
  assert.match(diagnostics, /stdio server ready/)
  assert.doesNotMatch(diagnostics, new RegExp(SECRET))
})
