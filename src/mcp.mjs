#!/usr/bin/env node

import { randomBytes } from "node:crypto"
import process from "node:process"

import {
  acceptedContent,
  createRequestStateCodec,
  inputRequired,
  inputResponse,
  McpServer,
} from "@modelcontextprotocol/server"
import { serveStdio } from "@modelcontextprotocol/server/stdio"
import { z } from "zod"

import {
  ALIGNMENT_PREPARATION_STATUS,
  normalizeAlignmentSelector,
} from "./alignment-service.mjs"
import { collectFleetAudit } from "./audit.mjs"
import { isMainModule } from "./entrypoint.mjs"
import {
  createLocalFleetService,
  FLEET_SERVICE_SCHEMA_VERSION,
} from "./fleet-service.mjs"
import { stableString } from "./normalize.mjs"
import { OPERATION_ACTIVITY_STATUS } from "./operation-history.mjs"
import { AlignmentPlanChangedError } from "./write-executor.mjs"

const MCP_SERVER_NAME = "cloudflare-fleet"
const MCP_SERVER_VERSION = "0.1.0"
const CONFIRMATION_KEY = "confirm_alignment"
const REQUEST_STATE_TTL_SECONDS = 600

const identifierSchema = z.string().trim().min(1).max(256)
const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const policySelectorSchema = z.strictObject({
  policyId: identifierSchema.describe("Fleet intent policy identifier"),
})
const facetSelectorSchema = z.strictObject({
  category: identifierSchema.describe("Matrix facet category"),
  key: identifierSchema.describe("Matrix facet key"),
  phase: z.string().max(256).optional().describe("Ruleset phase when the facet has one"),
  zoneIds: z.array(identifierSchema).min(1).max(100).optional()
    .describe("Zone identifiers for a cell-scoped alignment"),
})
const selectorSchema = z.union([
  policySelectorSchema,
  facetSelectorSchema,
])
const emptyInputSchema = z.strictObject({})
const selectorInputSchema = z.strictObject({
  selector: selectorSchema,
})
const applyInputSchema = z.strictObject({
  planDigest: digestSchema.describe("Exact digest returned by plan_alignment"),
  selector: selectorSchema,
})
const confirmationSchema = z.strictObject({
  approve: z.boolean().describe("Set true only after reviewing every operation"),
  confirmDigest: digestSchema.describe("Paste the exact plan digest to approve"),
})
const confirmationRequestSchema = Object.freeze({
  properties: {
    approve: {
      description: "Set true only after reviewing every operation",
      title: "Approve alignment",
      type: "boolean",
    },
    confirmDigest: {
      description: "Paste the exact plan digest shown in the confirmation",
      title: "Plan digest",
      type: "string",
    },
  },
  required: ["approve", "confirmDigest"],
  type: "object",
})
const requestStateSchema = z.strictObject({
  accountId: identifierSchema,
  planDigest: digestSchema,
  selector: selectorSchema,
})
const toolOutputSchema = z.looseObject({
  schemaVersion: z.number().int(),
  status: z.string(),
})

const READ_ONLY_EXTERNAL_ANNOTATIONS = Object.freeze({
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
  readOnlyHint: true,
})
const READ_ONLY_LOCAL_ANNOTATIONS = Object.freeze({
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
  readOnlyHint: true,
})
const APPLY_ANNOTATIONS = Object.freeze({
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: true,
  readOnlyHint: false,
})

function jsonClone(value) {
  return JSON.parse(JSON.stringify(value))
}

function toolResult(result, summary, options = {}) {
  return {
    content: [{ type: "text", text: summary }],
    ...(options.isError ? { isError: true } : {}),
    structuredContent: jsonClone(result),
  }
}

function redact(value, secrets) {
  let output = value
  for (const secret of secrets) {
    if (typeof secret === "string" && secret.length > 0) {
      output = output.replaceAll(secret, "[redacted]")
    }
  }
  return output
}

function errorEnvelope(error, secrets) {
  const planChanged = error instanceof AlignmentPlanChangedError
  const result = {
    error: {
      message: redact(
        error instanceof Error ? error.message : String(error),
        secrets,
      ),
      name: error instanceof Error ? error.name : "Error",
    },
    schemaVersion: FLEET_SERVICE_SCHEMA_VERSION,
    status: planChanged ? "plan-changed" : "error",
  }
  if (planChanged) {
    result.error.actualDigest = error.actualDigest
    result.error.expectedDigest = error.expectedDigest
  }
  return result
}

function safeToolHandler(handler, secrets) {
  return async (input, context) => {
    try {
      return await handler(input, context)
    } catch (error) {
      const result = errorEnvelope(error, secrets)
      return toolResult(result, result.error.message, { isError: true })
    }
  }
}

function progressReporter(stderr, toolName) {
  let lastMessage = ""
  return (progress) => {
    const message = progress.message
      || `${progress.stage || "working"} ${progress.completed}/${progress.total}`
    if (message === lastMessage) return
    lastMessage = message
    stderr.write(`[mcp:${toolName}] ${message}\n`)
  }
}

function operationCount(planSet) {
  return planSet.plans.reduce(
    (total, plan) => total + plan.operations.length,
    0,
  )
}

function auditSummary(result) {
  const report = result.report
  return `Fleet audit found ${report.summary.findings} findings across ${report.summary.zones} zones`
}

function candidateSummary(result) {
  return `Fleet intent has ${result.summary.candidates} alignment candidates: ${result.summary.availableCandidates} ready and ${result.summary.blockedCandidates} blocked`
}

function planSummary(result) {
  if (result.status !== ALIGNMENT_PREPARATION_STATUS.PLANNED) {
    return `${result.facet?.label || "Alignment"} is ${result.status}: ${result.reason}`
  }
  return `${result.facet.label} plan ${result.planSet.digest} contains ${operationCount(result.planSet)} operations across ${result.planSet.plans.length} zones`
}

function applySummary(result) {
  if ([
    ALIGNMENT_PREPARATION_STATUS.ALIGNED,
    ALIGNMENT_PREPARATION_STATUS.BLOCKED,
  ].includes(result.status)) {
    return `${result.facet?.label || "Alignment"} is ${result.status}: ${result.reason}`
  }
  return `Alignment ${result.status}: ${result.execution.completed}/${result.execution.total} operations completed and ${result.verification.length} resources reread`
}

function activitySummary(result) {
  return `Fleet activity contains ${result.entries.length} entries`
}

function confirmationMessage(plan) {
  const operations = plan.planSet.preview.map((operation, index) => [
    `${index + 1}. ${operation.method} ${operation.path}`,
    `Zone: ${operation.zoneName} (${operation.zoneId})`,
    `Change: ${operation.label}`,
    `Body: ${JSON.stringify(operation.body)}`,
  ].join("\n"))
  return [
    `Approve Cloudflare Fleet alignment for account ${plan.accountId}?`,
    `Facet: ${plan.facet.label}`,
    `Plan digest: ${plan.planSet.digest}`,
    `Validated: ${plan.planSet.validatedAt}`,
    "",
    ...operations,
    "",
    "Set approve to true and enter the exact plan digest only after reviewing every operation.",
  ].join("\n")
}

function planChangedResult(plan, expectedDigest) {
  return {
    accountId: plan.accountId,
    actualDigest: plan.planSet?.digest || null,
    expectedDigest,
    reason: "The fresh alignment plan does not match the requested approval digest",
    schemaVersion: FLEET_SERVICE_SCHEMA_VERSION,
    selector: plan.selector,
    status: "plan-changed",
  }
}

function confirmationOutcome(accountId, selector, status, reason) {
  return {
    accountId,
    reason,
    schemaVersion: FLEET_SERVICE_SCHEMA_VERSION,
    selector,
    status,
  }
}

function validRequestState(value, accountId, selector, planDigest) {
  const parsed = requestStateSchema.safeParse(value)
  if (!parsed.success
    || parsed.data.accountId !== accountId
    || parsed.data.planDigest !== planDigest) return false
  let stateSelector
  try {
    stateSelector = normalizeAlignmentSelector(parsed.data.selector)
  } catch {
    return false
  }
  return stableString(stateSelector) === stableString(selector)
}

function resultIsExecutionError(result) {
  return [
    OPERATION_ACTIVITY_STATUS.VERIFICATION_FAILED,
    OPERATION_ACTIVITY_STATUS.WRITE_FAILED,
  ].includes(result.status)
}

export function createFleetMcpServer(options = {}) {
  const environment = options.environment || process.env
  const stderr = options.stderr || process.stderr
  const service = options.service || createLocalFleetService({
    environment,
    stateFile: options.stateFile,
  })
  const auditFleet = options.auditFleet || ((auditOptions) => collectFleetAudit({
    deep: auditOptions.deep,
    environment,
    onProgress: auditOptions.onProgress,
    policyFile: options.policyFile,
    signal: auditOptions.signal,
    stateFile: service.stateFile,
  }))
  const requestStateCodec = createRequestStateCodec({
    bind: (context) => context.mcpReq.method,
    key: options.requestStateKey || randomBytes(32),
    ttlSeconds: options.requestStateTtlSeconds || REQUEST_STATE_TTL_SECONDS,
  })
  const server = new McpServer(
    {
      name: MCP_SERVER_NAME,
      version: MCP_SERVER_VERSION,
    },
    {
      capabilities: { tools: {} },
      inputRequired: { maxRounds: 2 },
      instructions: "Inspect Cloudflare Fleet with read-only tools, prepare exact intent alignment plans, and call apply_alignment only with a reviewed plan digest. apply_alignment requires interactive confirmation and performs a fresh plan check before writes.",
      requestState: { verify: requestStateCodec.verify },
    },
  )
  const secrets = [environment.CLOUDFLARE_API_TOKEN]

  server.registerTool(
    "audit_fleet",
    {
      annotations: READ_ONLY_EXTERNAL_ANNOTATIONS,
      description: "Audit live Cloudflare fleet posture without writing. Deep mode adds bounded account, delegation, endpoint, and dependency checks.",
      inputSchema: z.strictObject({
        deep: z.boolean().default(false),
      }),
      outputSchema: toolOutputSchema,
      title: "Audit Cloudflare fleet",
    },
    safeToolHandler(async ({ deep }, context) => {
      const report = await auditFleet({
        deep,
        onProgress: progressReporter(stderr, "audit_fleet"),
        signal: context.mcpReq.signal,
      })
      const result = {
        report,
        schemaVersion: FLEET_SERVICE_SCHEMA_VERSION,
        status: "ok",
      }
      return toolResult(result, auditSummary(result))
    }, secrets),
  )

  server.registerTool(
    "list_alignment_candidates",
    {
      annotations: READ_ONLY_EXTERNAL_ANNOTATIONS,
      description: "Read complete live fleet inventory and list intent scopes that are aligned, actionable, or blocked.",
      inputSchema: emptyInputSchema,
      outputSchema: toolOutputSchema,
      title: "List fleet alignment candidates",
    },
    safeToolHandler(async (_input, context) => {
      const result = await service.listAlignments({
        onProgress: progressReporter(stderr, "list_alignment_candidates"),
        signal: context.mcpReq.signal,
      })
      return toolResult(result, candidateSummary(result))
    }, secrets),
  )

  server.registerTool(
    "plan_alignment",
    {
      annotations: READ_ONLY_EXTERNAL_ANNOTATIONS,
      description: "Prepare an exact intent alignment from fresh full and scoped Cloudflare reads without writing.",
      inputSchema: selectorInputSchema,
      outputSchema: toolOutputSchema,
      title: "Plan fleet intent alignment",
    },
    safeToolHandler(async ({ selector }, context) => {
      const result = await service.planAlignment(selector, {
        onProgress: progressReporter(stderr, "plan_alignment"),
        signal: context.mcpReq.signal,
      })
      return toolResult(result, planSummary(result))
    }, secrets),
  )

  server.registerTool(
    "apply_alignment",
    {
      annotations: APPLY_ANNOTATIONS,
      description: "Apply only the exact reviewed alignment plan after interactive digest confirmation, fresh replanning, pending journaling, sequential writes, and scoped verification.",
      inputSchema: applyInputSchema,
      outputSchema: toolOutputSchema,
      title: "Apply reviewed fleet alignment",
    },
    safeToolHandler(async ({ planDigest, selector: requestedSelector }, context) => {
      const selector = normalizeAlignmentSelector(requestedSelector)
      const requestState = context.mcpReq.requestState()
      if (requestState !== undefined) {
        if (!validRequestState(
          requestState,
          service.accountId,
          selector,
          planDigest,
        )) {
          const result = confirmationOutcome(
            service.accountId,
            selector,
            "confirmation-invalid",
            "Signed confirmation state does not match this account, selector, or plan digest",
          )
          return toolResult(result, result.reason, { isError: true })
        }
        const response = inputResponse(
          context.mcpReq.inputResponses,
          CONFIRMATION_KEY,
        )
        if (response.kind === "elicit"
          && ["cancel", "decline"].includes(response.action)) {
          const result = confirmationOutcome(
            service.accountId,
            selector,
            "confirmation-declined",
            `Alignment confirmation was ${response.action}d`,
          )
          return toolResult(result, result.reason)
        }
        const confirmation = acceptedContent(
          context.mcpReq.inputResponses,
          CONFIRMATION_KEY,
          confirmationSchema,
        )
        if (!confirmation
          || confirmation.approve !== true
          || confirmation.confirmDigest !== planDigest) {
          const result = confirmationOutcome(
            service.accountId,
            selector,
            "confirmation-invalid",
            "Alignment confirmation must approve and repeat the exact plan digest",
          )
          return toolResult(result, result.reason, { isError: true })
        }
        const result = await service.applyAlignment(selector, planDigest, {
          onProgress: progressReporter(stderr, "apply_alignment"),
          signal: context.mcpReq.signal,
        })
        return toolResult(result, applySummary(result), {
          isError: resultIsExecutionError(result),
        })
      }
      if (context.mcpReq.inputResponses !== undefined) {
        const result = confirmationOutcome(
          service.accountId,
          selector,
          "confirmation-invalid",
          "Alignment confirmation responses require signed request state",
        )
        return toolResult(result, result.reason, { isError: true })
      }

      const plan = await service.planAlignment(selector, {
        onProgress: progressReporter(stderr, "apply_alignment"),
        signal: context.mcpReq.signal,
      })
      if (plan.status !== ALIGNMENT_PREPARATION_STATUS.PLANNED) {
        return toolResult(plan, planSummary(plan))
      }
      if (plan.planSet.digest !== planDigest) {
        const result = planChangedResult(plan, planDigest)
        return toolResult(result, result.reason)
      }
      const signedState = await requestStateCodec.mint({
        accountId: service.accountId,
        planDigest,
        selector: requestedSelector,
      }, context)
      return inputRequired({
        inputRequests: {
          [CONFIRMATION_KEY]: inputRequired.elicit({
            message: confirmationMessage(plan),
            requestedSchema: confirmationRequestSchema,
          }),
        },
        requestState: signedState,
      })
    }, secrets),
  )

  server.registerTool(
    "list_activity",
    {
      annotations: READ_ONLY_LOCAL_ANNOTATIONS,
      description: "List durable local operation activity newest first without reading or writing Cloudflare.",
      inputSchema: emptyInputSchema,
      outputSchema: toolOutputSchema,
      title: "List fleet operation activity",
    },
    safeToolHandler(async () => {
      const result = await service.listActivity()
      return toolResult(result, activitySummary(result))
    }, secrets),
  )

  return server
}

export function runFleetMcpServer(options = {}) {
  const environment = options.environment || process.env
  const stderr = options.stderr || process.stderr
  const secrets = [environment.CLOUDFLARE_API_TOKEN]
  const server = createFleetMcpServer({ ...options, environment, stderr })
  stderr.write("[mcp] Cloudflare Fleet stdio server ready\n")
  return serveStdio(() => server, {
    onerror(error) {
      stderr.write(`[mcp] ${redact(error.message, secrets)}\n`)
    },
  })
}

if (isMainModule(import.meta.url)) {
  try {
    runFleetMcpServer()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`[mcp] ${redact(message, [process.env.CLOUDFLARE_API_TOKEN])}\n`)
    process.exitCode = 1
  }
}
