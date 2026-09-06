#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto"
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
  normalizeAlignmentSelectors,
} from "./alignment-service.mjs"
import { collectFleetAudit } from "./audit.mjs"
import {
  FLEET_CLI_EXIT_CODE,
  FleetConfigurationError,
} from "./cli-contract.mjs"
import { isMainModule } from "./entrypoint.mjs"
import {
  createLocalFleetService,
  FLEET_SERVICE_SCHEMA_VERSION,
} from "./fleet-service.mjs"
import {
  activityUndoInputSchema,
  digestSchema,
  fleetChangeSchema,
  fleetIntentDocumentSchema,
  identifierSchema,
  runtimeStatusInputSchema,
  runtimeStatusOutputSchema,
  workerInspectionSchema,
  workerIntentInputSchema,
  workerHistorySchema,
  workerVerificationSchema,
  workerReportOutputSchema,
  workerIncidentOutputSchema,
} from "./interface-schemas.mjs"
import {
  buildConfirmationForm,
  CONFIRMATION_DECISION,
  confirmationFieldKeys,
  intentReviewItems,
  operationReviewItems,
} from "./mcp-confirmation.mjs"
import { stableString } from "./normalize.mjs"
import { OPERATION_ACTIVITY_STATUS } from "./operation-history.mjs"
import { PACKAGE_VERSION } from "./package-metadata.mjs"
import { createProgressReporter } from "./progress.mjs"
import { diagnoseFleetRuntime } from "./runtime-status.mjs"
import { AlignmentPlanChangedError } from "./write-executor.mjs"
import {
  describeZoneAliasPolicy,
  ZONE_ALIAS_INTENT_KIND,
  ZONE_ALIAS_RESOURCE_ENVELOPE,
} from "./zone-alias-intent.mjs"

const MCP_SERVER_NAME = "cloudflare-fleet"
const CONFIRMATION_KEY = "confirm_action"
const REQUEST_STATE_TTL_SECONDS = 600

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
const selectorsSchema = z.array(selectorSchema).min(1).max(20)
const emptyInputSchema = z.strictObject({})
const selectorInputSchema = z.strictObject({
  selector: selectorSchema,
})
const applyInputSchema = z.strictObject({
  planDigest: digestSchema.describe("Exact digest returned by plan_alignment"),
  selector: selectorSchema,
})
const batchApplyInputSchema = z.strictObject({
  selectors: selectorsSchema.describe("Distinct alignment selectors to review and apply together"),
})
const intentInputSchema = z.strictObject({
  document: fleetIntentDocumentSchema.describe("Complete desired fleet intent document based on get_fleet_intent"),
})
const intentApplyInputSchema = intentInputSchema.extend({
  planDigest: digestSchema.describe("Exact digest returned by plan_fleet_intent"),
})
const changeInputSchema = z.strictObject({
  change: fleetChangeSchema,
})
const changeApplyInputSchema = changeInputSchema.extend({
  planDigest: digestSchema.describe("Exact digest returned by plan_fleet_change"),
})
const undoApplyInputSchema = activityUndoInputSchema.extend({
  planDigest: digestSchema.describe("Exact digest returned by plan_activity_undo"),
})
const requestStateSchema = z.strictObject({
  accountId: identifierSchema,
  confirmationCount: z.number().int().positive(),
  planDigest: digestSchema,
  selector: selectorSchema,
})
const batchRequestStateSchema = z.strictObject({
  accountId: identifierSchema,
  confirmationCount: z.number().int().positive(),
  planDigest: digestSchema,
  selectors: selectorsSchema,
})
const reviewedRequestStateSchema = z.strictObject({
  accountId: identifierSchema,
  action: identifierSchema,
  confirmationCount: z.number().int().positive(),
  fingerprint: digestSchema,
  planDigest: digestSchema,
})
const errorOutputSchema = z.looseObject({
  error: z.looseObject({
    message: z.string(),
    name: z.string(),
  }),
  schemaVersion: z.number().int(),
  status: z.string(),
})
const accountOutputSchema = z.looseObject({
  accountId: identifierSchema,
  schemaVersion: z.number().int(),
  status: z.string(),
})
const operationOutputSchema = z.looseObject({
  body: z.unknown().optional(),
  currentValue: z.unknown().optional(),
  label: z.string(),
  method: z.string(),
  path: z.string(),
})
const operationPlanOutputSchema = z.looseObject({
  id: z.string().optional(),
  kind: z.string().optional(),
  operations: z.array(operationOutputSchema),
  summary: z.string().optional(),
  zoneId: identifierSchema.optional(),
  zoneName: z.string().optional(),
  worker: identifierSchema.optional(),
  accountId: identifierSchema.optional(),
})
const operationPreviewOutputSchema = operationOutputSchema.extend({
  zoneId: identifierSchema.optional(),
  zoneName: z.string().optional(),
  worker: identifierSchema.optional(),
  accountId: identifierSchema.optional(),
})
const planSetOutputSchema = z.looseObject({
  digest: digestSchema,
  plans: z.array(operationPlanOutputSchema),
  preview: z.array(operationPreviewOutputSchema),
  request: z.unknown().optional(),
  validatedAt: z.string(),
})
const assessmentOutputSchema = z.looseObject({
  actionableCount: z.number().int().nonnegative(),
  available: z.boolean(),
  blockers: z.array(z.looseObject({
    reason: z.string(),
    zoneId: identifierSchema,
    zoneName: z.string(),
  })),
  reason: z.string(),
  targetCount: z.number().int().nonnegative(),
  targetZones: z.array(z.looseObject({
    zoneId: identifierSchema,
    zoneName: z.string(),
  })),
})
const candidateOutputSchema = z.looseObject({
  assessment: assessmentOutputSchema,
  facet: z.looseObject({
    category: z.string(),
    key: z.string(),
    label: z.string(),
    phase: z.string(),
  }),
  policyId: identifierSchema.nullable(),
  scope: z.string(),
  selector: z.looseObject({
    kind: z.string(),
  }),
})
const verificationGuardOutputSchema = z.looseObject({
  canonical: z.string(),
  summary: z.string(),
  target: z.looseObject({
    kind: z.string(),
    zoneId: identifierSchema.optional(),
    worker: identifierSchema.optional(),
    accountId: identifierSchema.optional(),
  }),
  value: z.unknown(),
})
const activityEntryOutputSchema = z.looseObject({
  completedAt: z.string().nullable(),
  error: z.string().nullable(),
  execution: z.looseObject({
    completed: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  }).nullable(),
  id: identifierSchema,
  inverse: z.looseObject({
    available: z.boolean(),
    plans: z.array(operationPlanOutputSchema),
    reason: z.string(),
  }).nullable(),
  plans: z.array(operationPlanOutputSchema),
  startedAt: z.string(),
  status: z.string(),
  title: z.string(),
  undoOf: identifierSchema.nullable(),
  validatedAt: z.string(),
  verification: z.array(verificationGuardOutputSchema),
})
const auditOutputSchema = z.union([
  z.looseObject({
    report: z.looseObject({
      accountId: identifierSchema,
      findings: z.array(z.unknown()),
      summary: z.looseObject({
        findings: z.number().int(),
        zones: z.number().int(),
      }),
    }),
    schemaVersion: z.number().int(),
    status: z.string(),
  }),
  errorOutputSchema,
]).describe("Completed audit or operational error; exhausted HTTP 429 retries return an error without a partial audit report")
const candidatesOutputSchema = z.union([
  accountOutputSchema.extend({
    candidates: z.array(candidateOutputSchema),
    summary: z.looseObject({
      candidates: z.number().int(),
    }),
  }),
  errorOutputSchema,
])
const planOutputSchema = z.union([
  accountOutputSchema.extend({
    planSet: planSetOutputSchema.nullable(),
    reason: z.string(),
  }),
  errorOutputSchema,
])
const applyOutputSchema = z.union([
  accountOutputSchema.extend({
    applied: z.boolean().optional(),
    execution: z.looseObject({
      completed: z.number().int(),
      total: z.number().int(),
    }).optional(),
    reason: z.string().optional(),
  }),
  errorOutputSchema,
])
const activityOutputSchema = z.union([
  accountOutputSchema.extend({
    entries: z.array(activityEntryOutputSchema),
    revision: z.string(),
  }),
  errorOutputSchema,
])
const intentOutputSchema = z.union([
  accountOutputSchema.extend({
    document: fleetIntentDocumentSchema,
  }),
  errorOutputSchema,
])
const runtimeOutputSchema = z.union([
  runtimeStatusOutputSchema,
  errorOutputSchema,
])
const zoneAliasIntentValueOutputSchema = z.strictObject({
  kind: z.literal(ZONE_ALIAS_INTENT_KIND),
  redirect: z.strictObject({
    enabled: z.literal(true),
    includeSubdomains: z.boolean(),
    preservePath: z.boolean(),
    preserveQuery: z.boolean(),
    preserveSubdomains: z.boolean(),
    statusCode: z.union([
      z.literal(301),
      z.literal(302),
      z.literal(307),
      z.literal(308),
    ]),
    targetHost: z.string(),
    targetScheme: z.literal("https"),
  }),
  resourceEnvelope: z.literal(ZONE_ALIAS_RESOURCE_ENVELOPE),
  servingDns: z.strictObject({
    apex: z.literal(true),
    wildcard: z.boolean(),
  }),
  unexpectedResources: z.array(z.never()).max(0),
  unreadSurfaces: z.array(z.never()).max(0),
})
const zoneAliasPolicyOutputSchema = z.strictObject({
  allowedResources: z.array(z.string()),
  facet: z.strictObject({
    category: z.string(),
    description: z.string(),
    key: z.string(),
    label: z.string(),
  }),
  limitations: z.array(z.string()),
  requiredConstraints: z.strictObject({
    presenceConstraint: z.literal("required"),
    valueConstraint: z.literal("exact"),
  }),
  resourceEnvelope: z.literal(ZONE_ALIAS_RESOURCE_ENVELOPE),
  templates: z.array(z.strictObject({
    id: identifierSchema,
    sourceHost: z.string(),
    value: zoneAliasIntentValueOutputSchema,
  })),
  unexpectedResources: z.array(z.string()),
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
const APPLY_LOCAL_ANNOTATIONS = Object.freeze({
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: false,
  readOnlyHint: false,
})

function jsonClone(value) {
  return JSON.parse(JSON.stringify(value))
}

function toolResult(result, summary, options = {}) {
  return {
    content: [
      { type: "text", text: summary },
      { type: "text", text: JSON.stringify(result) },
    ],
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

function batchPlanSummary(result) {
  if (result.status !== ALIGNMENT_PREPARATION_STATUS.PLANNED) {
    return `Alignment batch is ${result.status}: ${result.reason}`
  }
  return `Alignment batch ${result.planSet.digest} contains ${operationCount(result.planSet)} operations across ${result.planSet.plans.length} zones`
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

function intentSummary(result) {
  return `Fleet intent revision ${result.document.revision || "empty"} contains ${result.document.groups.length} groups and ${result.document.policies.length} policies`
}

function intentPlanSummary(result) {
  if (result.status !== "planned") {
    return `Fleet intent persistence is ${result.status}: ${result.reason}`
  }
  const changes = Object.values(result.diff).reduce((total, difference) => (
    total
      + difference.added.length
      + difference.changed.length
      + difference.removed.length
  ), 0)
  return `Fleet intent persistence plan ${result.planSet.digest} contains ${changes} collection changes and no Cloudflare API writes`
}

function reviewedPlanSummary(result, label) {
  if (result.status !== "planned") {
    return `${label} is ${result.status}: ${result.reason}`
  }
  return `${label} plan ${result.planSet.digest} contains ${operationCount(result.planSet)} Cloudflare operations`
}

function reviewedApplySummary(result, label) {
  if (!result.execution) {
    if (result.applied) return `${label} completed with status ${result.status}`
    return `${label} is ${result.status}: ${result.reason || "no mutation was required"}`
  }
  return `${label} ${result.status}: ${result.execution.completed}/${result.execution.total} operations completed and ${result.verification.length} resources reread`
}

function inputFingerprint(value) {
  return `sha256:${createHash("sha256")
    .update(stableString(value))
    .digest("hex")}`
}

const confirmationDecisionSchema = z.enum([
  CONFIRMATION_DECISION.APPROVE,
  CONFIRMATION_DECISION.DECLINE,
])

function confirmationResponseSchema(count) {
  return z.strictObject(Object.fromEntries(
    confirmationFieldKeys(count).map((key) => [
      key,
      confirmationDecisionSchema,
    ]),
  ))
}

function acceptedConfirmation(inputResponses, count) {
  return acceptedContent(
    inputResponses,
    CONFIRMATION_KEY,
    confirmationResponseSchema(count),
  )
}

function confirmationWasDeclined(confirmation) {
  return Object.values(confirmation).includes(CONFIRMATION_DECISION.DECLINE)
}

function operationSummaryLines(count) {
  return count > 1 ? [`Operations: ${count}`] : []
}

function reviewedConfirmationForm(title, plan) {
  const operations = plan.planSet.preview
  const summaryLines = []
  if (plan.activityId) summaryLines.push(`Activity: ${plan.activityId}`)
  summaryLines.push(...operationSummaryLines(operations.length))
  let reviewItems
  if (operations.length > 0) {
    reviewItems = operationReviewItems(operations)
  } else if (plan.diff) {
    reviewItems = intentReviewItems(plan)
  } else {
    reviewItems = [{
      lines: [
        "Cloudflare API writes: none",
        "The plan digest binds the complete local request",
      ],
      title: "Review local change",
    }]
  }
  return buildConfirmationForm({
    accountId: plan.accountId,
    heading: `Review ${title}`,
    planSet: plan.planSet,
    reviewItems,
    summaryLines,
  })
}

function reviewedPlanChanged(plan, expectedDigest, action) {
  return {
    accountId: plan.accountId,
    action,
    actualDigest: plan.planSet?.digest || null,
    expectedDigest,
    reason: "The fresh reviewed plan does not match the requested approval digest",
    schemaVersion: FLEET_SERVICE_SCHEMA_VERSION,
    status: "plan-changed",
  }
}

function reviewedConfirmationOutcome(accountId, action, status, reason) {
  return {
    accountId,
    action,
    reason,
    schemaVersion: FLEET_SERVICE_SCHEMA_VERSION,
    status,
  }
}

function declinedConfirmationReason(subject, action) {
  const outcome = action === "cancel" ? "cancelled" : "declined"
  return `${subject} confirmation was ${outcome}`
}

function reviewedRequestState(
  value,
  accountId,
  action,
  fingerprint,
  planDigest,
) {
  const parsed = reviewedRequestStateSchema.safeParse(value)
  return parsed.success
    && parsed.data.accountId === accountId
    && parsed.data.action === action
    && parsed.data.fingerprint === fingerprint
    && parsed.data.planDigest === planDigest
    ? parsed.data
    : null
}

function confirmationForm(plan) {
  const operations = plan.planSet.preview
  return buildConfirmationForm({
    accountId: plan.accountId,
    heading: `Review alignment: ${plan.facet.label}`,
    planSet: plan.planSet,
    reviewItems: operationReviewItems(operations),
    summaryLines: operationSummaryLines(operations.length),
  })
}

function batchConfirmationForm(plan) {
  const operations = plan.planSet.preview
  return buildConfirmationForm({
    accountId: plan.accountId,
    heading: "Review alignment batch",
    planSet: plan.planSet,
    reviewItems: operationReviewItems(operations),
    summaryLines: [
      `Scopes: ${plan.alignments.length}`,
      ...operationSummaryLines(operations.length),
    ],
  })
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

function alignmentRequestState(value, accountId, selector, planDigest) {
  const parsed = requestStateSchema.safeParse(value)
  if (!parsed.success
    || parsed.data.accountId !== accountId
    || parsed.data.planDigest !== planDigest) return null
  let stateSelector
  try {
    stateSelector = normalizeAlignmentSelector(parsed.data.selector)
  } catch {
    return null
  }
  return stableString(stateSelector) === stableString(selector)
    ? parsed.data
    : null
}

function batchRequestState(value, accountId, selectors) {
  const parsed = batchRequestStateSchema.safeParse(value)
  if (!parsed.success || parsed.data.accountId !== accountId) return null
  let stateSelectors
  try {
    stateSelectors = normalizeAlignmentSelectors(parsed.data.selectors)
  } catch {
    return null
  }
  return stableString(stateSelectors) === stableString(selectors)
    ? parsed.data
    : null
}

function resultIsExecutionError(result) {
  return [
    OPERATION_ACTIVITY_STATUS.VERIFICATION_FAILED,
    OPERATION_ACTIVITY_STATUS.WRITE_FAILED,
  ].includes(result.status)
}

function lazyLocalFleetService(options) {
  let service
  return new Proxy({}, {
    get(_target, property) {
      service ||= createLocalFleetService(options)
      return service[property]
    },
  })
}

export function createFleetMcpServer(options = {}) {
  const environment = options.environment || process.env
  const stderr = options.stderr || process.stderr
  const service = options.service || lazyLocalFleetService({
    environment,
    policyFile: options.policyFile,
    stateFile: options.stateFile,
  })
  const inspectRuntime = options.diagnoseRuntime || diagnoseFleetRuntime
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
      version: PACKAGE_VERSION,
    },
    {
      capabilities: { tools: {} },
      inputRequired: { maxRounds: 2 },
      instructions: "Start with get_runtime_status when setup, paths, credentials, or permissions are uncertain. Use read and plan tools before mutations. GET reads honor Retry-After with bounded retries and a shared cooldown within each API client; cancellation stops waiting reads before dispatch, and mutation requests are never automatically retried. Use inspect_worker for a Worker name or trigger finding ID and a bounded past window; log counts cover invocation records on that page, not console messages or total HTTP failure rates. Record and verify Worker incidents explicitly to preserve assessment history. Use plan_worker_intent and apply_worker_intent for disabled, exact, or unmanaged schedule intent with owning deployment configuration and reconciliation. Use worker-schedules-update through plan_fleet_change and apply_fleet_change for schedule-only writes, then verify_worker_incident after propagation and the activity undo tools for guarded recovery. Configuration acceptance is not observed health. No Worker source, arbitrary local paths or raw log payloads are exposed. Use describe_zone_alias_policy for the strict reusable canonical-web-passthrough facet and its initial compatibility-domain templates, then persist it through plan_fleet_intent and apply_fleet_intent. Remediate its drift through the ordinary alignment tools. Every apply tool binds the exact request to signed elicitation state, presents compact operation review fields that all require approval, replans under the shared write lock, journals Cloudflare writes before execution, and verifies affected live resources. Fleet intent persistence is revision-safe and guarded undo is blocked when live state drifts.",
      requestState: { verify: requestStateCodec.verify },
    },
  )
  const secrets = [environment.CLOUDFLARE_API_TOKEN]

  function reviewedMutationHandler(configuration) {
    return safeToolHandler(async (input, context) => {
      const request = configuration.request(input)
      const planDigest = input.planDigest
      const fingerprint = inputFingerprint(request)
      const requestState = context.mcpReq.requestState()
      if (requestState !== undefined) {
        const state = reviewedRequestState(
          requestState,
          service.accountId,
          configuration.action,
          fingerprint,
          planDigest,
        )
        if (!state) {
          const result = reviewedConfirmationOutcome(
            service.accountId,
            configuration.action,
            "confirmation-invalid",
            "Signed confirmation state does not match this account, action, request, or plan digest",
          )
          return toolResult(result, result.reason, { isError: true })
        }
        const response = inputResponse(
          context.mcpReq.inputResponses,
          CONFIRMATION_KEY,
        )
        if (response.kind === "elicit"
          && ["cancel", "decline"].includes(response.action)) {
          const result = reviewedConfirmationOutcome(
            service.accountId,
            configuration.action,
            "confirmation-declined",
            declinedConfirmationReason(configuration.title, response.action),
          )
          return toolResult(result, result.reason)
        }
        const confirmation = acceptedConfirmation(
          context.mcpReq.inputResponses,
          state.confirmationCount,
        )
        if (!confirmation) {
          const result = reviewedConfirmationOutcome(
            service.accountId,
            configuration.action,
            "confirmation-invalid",
            "Confirmation must answer every review field with a valid decision",
          )
          return toolResult(result, result.reason, { isError: true })
        }
        if (confirmationWasDeclined(confirmation)) {
          const result = reviewedConfirmationOutcome(
            service.accountId,
            configuration.action,
            "confirmation-declined",
            declinedConfirmationReason(configuration.title, "decline"),
          )
          return toolResult(result, result.reason)
        }
        const result = await configuration.apply(request, planDigest, {
          onProgress: createProgressReporter(
            stderr,
            `[mcp:${configuration.toolName}]`,
          ),
          signal: context.mcpReq.signal,
        })
        return toolResult(
          result,
          reviewedApplySummary(result, configuration.title),
          { isError: resultIsExecutionError(result) },
        )
      }
      if (context.mcpReq.inputResponses !== undefined) {
        const result = reviewedConfirmationOutcome(
          service.accountId,
          configuration.action,
          "confirmation-invalid",
          "Confirmation responses require signed request state",
        )
        return toolResult(result, result.reason, { isError: true })
      }

      const plan = await configuration.plan(request, {
        onProgress: createProgressReporter(
          stderr,
          `[mcp:${configuration.toolName}]`,
        ),
        signal: context.mcpReq.signal,
      })
      if (plan.status !== "planned") {
        return toolResult(
          plan,
          reviewedPlanSummary(plan, configuration.title),
        )
      }
      if (plan.planSet.digest !== planDigest) {
        const result = reviewedPlanChanged(
          plan,
          planDigest,
          configuration.action,
        )
        return toolResult(result, result.reason)
      }
      const confirmation = reviewedConfirmationForm(configuration.title, plan)
      const signedState = await requestStateCodec.mint({
        accountId: service.accountId,
        action: configuration.action,
        confirmationCount: confirmation.fieldCount,
        fingerprint,
        planDigest,
      }, context)
      return inputRequired({
        inputRequests: {
          [CONFIRMATION_KEY]: inputRequired.elicit({
            message: confirmation.message,
            requestedSchema: confirmation.requestedSchema,
          }),
        },
        requestState: signedState,
      })
    }, secrets)
  }

  server.registerTool(
    "get_runtime_status",
    {
      annotations: READ_ONLY_EXTERNAL_ANNOTATIONS,
      description: "Inspect effective local paths, credential presence, private file modes, runtime and dashboard prerequisites, with an optional bounded live zone-list probe. Secret values are never returned.",
      inputSchema: runtimeStatusInputSchema,
      outputSchema: runtimeOutputSchema,
      title: "Diagnose Cloudflare Fleet runtime",
    },
    safeToolHandler(async ({ live }, context) => {
      const result = await inspectRuntime({
        environment,
        live,
        policyFile: options.policyFile,
        signal: context.mcpReq.signal,
        stateFile: options.stateFile,
      })
      const summary = result.status === "ready"
        ? `Cloudflare Fleet is ready: ${result.summary.pass} checks passed`
        : `Cloudflare Fleet needs attention: ${result.summary.fail} failed and ${result.summary.warning} warned`
      return toolResult(result, summary)
    }, secrets),
  )

  const workerOutputSchema = z.union([accountOutputSchema, errorOutputSchema])
  for (const [name, method, schema, description, readOnly] of [
    ["inspect_worker", "inspect", workerInspectionSchema, "Inspect one exact Worker or Worker finding within a bounded past time window. Return redacted configuration, deployed versions, invocation-only page counts, separate HTTP statuses and explicit coverage. Pass the original start/end with the next cursor. Does not retrieve source or save an incident.", true],
    ["record_worker_incident", "record", workerInspectionSchema, "Capture fresh scoped Worker evidence as an append-only local incident assessment, linking the prior assessment without erasing it. Does not change Cloudflare resources.", false],
    ["list_worker_incidents", "history", workerHistorySchema, "Read paginated incident history, supersession links and explicit schedule intent for one Worker.", true],
    ["verify_worker_incident", "verify", workerVerificationSchema, "Verify this Worker's recorded schedule change using only evidence after the propagation grace period, and save the new assessment. Distinguishes configuration acceptance, propagation pending, observed failures, awaiting evidence and observed health.", false],
    ["plan_worker_intent", "planIntent", workerIntentInputSchema, "Plan revision-safe local schedule intent: disabled, exact desired set, or unmanaged. Include the owning configuration and reviewed reconciliation step; no arbitrary local file is edited.", true],
  ]) {
    server.registerTool(name, {
      title: name.replaceAll("_", " "), description,
      annotations: readOnly ? READ_ONLY_EXTERNAL_ANNOTATIONS : { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      inputSchema: schema,
      outputSchema: method === "inspect" ? z.union([workerReportOutputSchema, errorOutputSchema])
        : ["record", "verify"].includes(method) ? z.union([accountOutputSchema.extend({ record: workerIncidentOutputSchema }), errorOutputSchema])
        : method === "history" ? z.union([accountOutputSchema.extend({ records: z.array(workerIncidentOutputSchema).max(50), nextOffset: z.number().int().nullable(), intent: z.json(), revision: z.string() }), errorOutputSchema])
        : planOutputSchema,
    }, safeToolHandler(async (input, context) => {
      const result = await service.workers[method](input, { signal: context.mcpReq.signal })
      return toolResult(result, result.summary || result.reason || `Worker diagnostics ${result.status}`)
    }, secrets))
  }
  server.registerTool("apply_worker_intent", {
    title: "Save reviewed Worker schedule intent",
    description: "Persist only the exact reviewed schedule intent after signed interactive confirmation and revision checking. Does not modify deployment files or Cloudflare schedules.",
    annotations: { ...APPLY_ANNOTATIONS, openWorldHint: false },
    inputSchema: z.strictObject({ input: workerIntentInputSchema, planDigest: digestSchema }),
    outputSchema: workerOutputSchema,
  }, reviewedMutationHandler({
    action: "worker-intent-apply", toolName: "apply_worker_intent", title: "Worker schedule intent",
    request: (input) => input.input,
    plan: (input, options) => service.workers.planIntent(input, options),
    apply: (input, digest, options) => service.workers.applyIntent(input, digest, options),
  }))

  server.registerTool(
    "audit_fleet",
    {
      annotations: READ_ONLY_EXTERNAL_ANNOTATIONS,
      description: "Audit live Cloudflare fleet posture without writing, including canonical alias redirect semantics and independent web attachments. Deep mode adds bounded account, delegation, endpoint, and dependency checks, including independent Worker Cron/handler mismatches with explicit unknown coverage when metadata is missing. All-invocation errors are not HTTP failure rates.",
      inputSchema: z.strictObject({
        deep: z.boolean().default(false),
      }),
      outputSchema: auditOutputSchema,
      title: "Audit Cloudflare fleet",
    },
    safeToolHandler(async ({ deep }, context) => {
      const report = await auditFleet({
        deep,
        onProgress: createProgressReporter(stderr, "[mcp:audit_fleet]"),
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
    "describe_zone_alias_policy",
    {
      annotations: READ_ONLY_LOCAL_ANNOTATIONS,
      description: "Return the strict reusable canonical web passthrough facet, allowed resource envelope, and initial compatibility-domain templates without reading or writing Cloudflare.",
      inputSchema: emptyInputSchema,
      outputSchema: zoneAliasPolicyOutputSchema,
      title: "Describe canonical zone alias policy",
    },
    safeToolHandler(async () => {
      const result = describeZoneAliasPolicy()
      return toolResult(
        result,
        `Canonical zone alias policy has ${result.templates.length} initial templates`,
      )
    }, secrets),
  )

  server.registerTool(
    "get_fleet_intent",
    {
      annotations: READ_ONLY_LOCAL_ANNOTATIONS,
      description: "Read the complete revisioned fleet intent document for editing without reading or writing Cloudflare.",
      inputSchema: emptyInputSchema,
      outputSchema: intentOutputSchema,
      title: "Get fleet intent",
    },
    safeToolHandler(async () => {
      const result = await service.getIntent()
      return toolResult(result, intentSummary(result))
    }, secrets),
  )

  server.registerTool(
    "plan_fleet_intent",
    {
      annotations: READ_ONLY_LOCAL_ANNOTATIONS,
      description: "Validate a complete desired fleet intent document against its current account and revision, then return an exact digest-bound collection diff without persisting it.",
      inputSchema: intentInputSchema,
      outputSchema: planOutputSchema,
      title: "Plan fleet intent persistence",
    },
    safeToolHandler(async ({ document }) => {
      const result = await service.planIntent(document)
      return toolResult(
        result,
        intentPlanSummary(result),
      )
    }, secrets),
  )

  server.registerTool(
    "apply_fleet_intent",
    {
      annotations: APPLY_LOCAL_ANNOTATIONS,
      description: "Persist only the exact reviewed complete fleet intent document after signed interactive confirmation, exclusive locking, fresh revision validation, and digest comparison.",
      inputSchema: intentApplyInputSchema,
      outputSchema: applyOutputSchema,
      title: "Apply reviewed fleet intent",
    },
    reviewedMutationHandler({
      action: "fleet-intent-apply",
      apply: (document, digest, commandOptions) => (
        service.applyIntent(document, digest, commandOptions)
      ),
      plan: (document, commandOptions) => (
        service.planIntent(document, commandOptions)
      ),
      request: (input) => input.document,
      title: "fleet intent persistence",
      toolName: "apply_fleet_intent",
    }),
  )

  server.registerTool(
    "list_alignment_candidates",
    {
      annotations: READ_ONLY_EXTERNAL_ANNOTATIONS,
      description: "Read complete live fleet inventory and list intent scopes that are aligned, actionable, or blocked.",
      inputSchema: emptyInputSchema,
      outputSchema: candidatesOutputSchema,
      title: "List fleet alignment candidates",
    },
    safeToolHandler(async (_input, context) => {
      const result = await service.listAlignments({
        onProgress: createProgressReporter(
          stderr,
          "[mcp:list_alignment_candidates]",
        ),
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
      outputSchema: planOutputSchema,
      title: "Plan fleet intent alignment",
    },
    safeToolHandler(async ({ selector }, context) => {
      const result = await service.planAlignment(selector, {
        onProgress: createProgressReporter(stderr, "[mcp:plan_alignment]"),
        signal: context.mcpReq.signal,
      })
      return toolResult(result, planSummary(result))
    }, secrets),
  )

  server.registerTool(
    "apply_alignment",
    {
      annotations: APPLY_ANNOTATIONS,
      description: "Apply only the exact reviewed alignment plan after interactive plan confirmation, fresh replanning, pending journaling, sequential writes, and scoped verification.",
      inputSchema: applyInputSchema,
      outputSchema: applyOutputSchema,
      title: "Apply reviewed fleet alignment",
    },
    safeToolHandler(async ({ planDigest, selector: requestedSelector }, context) => {
      const selector = normalizeAlignmentSelector(requestedSelector)
      const requestState = context.mcpReq.requestState()
      if (requestState !== undefined) {
        const state = alignmentRequestState(
          requestState,
          service.accountId,
          selector,
          planDigest,
        )
        if (!state) {
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
            declinedConfirmationReason("Alignment", response.action),
          )
          return toolResult(result, result.reason)
        }
        const confirmation = acceptedConfirmation(
          context.mcpReq.inputResponses,
          state.confirmationCount,
        )
        if (!confirmation) {
          const result = confirmationOutcome(
            service.accountId,
            selector,
            "confirmation-invalid",
            "Alignment confirmation must answer every review field with a valid decision",
          )
          return toolResult(result, result.reason, { isError: true })
        }
        if (confirmationWasDeclined(confirmation)) {
          const result = confirmationOutcome(
            service.accountId,
            selector,
            "confirmation-declined",
            declinedConfirmationReason("Alignment", "decline"),
          )
          return toolResult(result, result.reason)
        }
        const result = await service.applyAlignment(selector, planDigest, {
          onProgress: createProgressReporter(
            stderr,
            "[mcp:apply_alignment]",
          ),
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
        onProgress: createProgressReporter(
          stderr,
          "[mcp:apply_alignment]",
        ),
        signal: context.mcpReq.signal,
      })
      if (plan.status !== ALIGNMENT_PREPARATION_STATUS.PLANNED) {
        return toolResult(plan, planSummary(plan))
      }
      if (plan.planSet.digest !== planDigest) {
        const result = planChangedResult(plan, planDigest)
        return toolResult(result, result.reason)
      }
      const confirmation = confirmationForm(plan)
      const signedState = await requestStateCodec.mint({
        accountId: service.accountId,
        confirmationCount: confirmation.fieldCount,
        planDigest,
        selector: requestedSelector,
      }, context)
      return inputRequired({
        inputRequests: {
          [CONFIRMATION_KEY]: inputRequired.elicit({
            message: confirmation.message,
            requestedSchema: confirmation.requestedSchema,
          }),
        },
        requestState: signedState,
      })
    }, secrets),
  )

  server.registerTool(
    "apply_alignments",
    {
      annotations: APPLY_ANNOTATIONS,
      description: "Plan and apply several alignment selectors through one interactive review, one signed batch digest, a fresh composed replan, pending journaling, sequential writes, and scoped verification.",
      inputSchema: batchApplyInputSchema,
      outputSchema: applyOutputSchema,
      title: "Apply reviewed fleet alignment batch",
    },
    safeToolHandler(async ({ selectors: requestedSelectors }, context) => {
      const selectors = normalizeAlignmentSelectors(requestedSelectors)
      const requestState = context.mcpReq.requestState()
      if (requestState !== undefined) {
        const state = batchRequestState(
          requestState,
          service.accountId,
          selectors,
        )
        if (!state) {
          const result = {
            accountId: service.accountId,
            reason: "Signed confirmation state does not match this account or selector batch",
            schemaVersion: FLEET_SERVICE_SCHEMA_VERSION,
            selectors,
            status: "confirmation-invalid",
          }
          return toolResult(result, result.reason, { isError: true })
        }
        const response = inputResponse(
          context.mcpReq.inputResponses,
          CONFIRMATION_KEY,
        )
        if (response.kind === "elicit"
          && ["cancel", "decline"].includes(response.action)) {
          const result = {
            accountId: service.accountId,
            reason: declinedConfirmationReason("Alignment", response.action),
            schemaVersion: FLEET_SERVICE_SCHEMA_VERSION,
            selectors,
            status: "confirmation-declined",
          }
          return toolResult(result, result.reason)
        }
        const confirmation = acceptedConfirmation(
          context.mcpReq.inputResponses,
          state.confirmationCount,
        )
        if (!confirmation) {
          const result = {
            accountId: service.accountId,
            reason: "Alignment confirmation must answer every review field with a valid decision",
            schemaVersion: FLEET_SERVICE_SCHEMA_VERSION,
            selectors,
            status: "confirmation-invalid",
          }
          return toolResult(result, result.reason, { isError: true })
        }
        if (confirmationWasDeclined(confirmation)) {
          const result = {
            accountId: service.accountId,
            reason: declinedConfirmationReason("Alignment", "decline"),
            schemaVersion: FLEET_SERVICE_SCHEMA_VERSION,
            selectors,
            status: "confirmation-declined",
          }
          return toolResult(result, result.reason)
        }
        const result = await service.applyAlignments(
          selectors,
          state.planDigest,
          {
            onProgress: createProgressReporter(
              stderr,
              "[mcp:apply_alignments]",
            ),
            signal: context.mcpReq.signal,
          },
        )
        return toolResult(result, applySummary(result), {
          isError: resultIsExecutionError(result),
        })
      }
      if (context.mcpReq.inputResponses !== undefined) {
        const result = {
          accountId: service.accountId,
          reason: "Alignment confirmation responses require signed request state",
          schemaVersion: FLEET_SERVICE_SCHEMA_VERSION,
          selectors,
          status: "confirmation-invalid",
        }
        return toolResult(result, result.reason, { isError: true })
      }

      const plan = await service.planAlignments(selectors, {
        onProgress: createProgressReporter(
          stderr,
          "[mcp:apply_alignments]",
        ),
        signal: context.mcpReq.signal,
      })
      if (plan.status !== ALIGNMENT_PREPARATION_STATUS.PLANNED) {
        return toolResult(plan, batchPlanSummary(plan))
      }
      const confirmation = batchConfirmationForm(plan)
      const signedState = await requestStateCodec.mint({
        accountId: service.accountId,
        confirmationCount: confirmation.fieldCount,
        planDigest: plan.planSet.digest,
        selectors: requestedSelectors,
      }, context)
      return inputRequired({
        inputRequests: {
          [CONFIRMATION_KEY]: inputRequired.elicit({
            message: confirmation.message,
            requestedSchema: confirmation.requestedSchema,
          }),
        },
        requestState: signedState,
      })
    }, secrets),
  )

  server.registerTool(
    "plan_fleet_change",
    {
      annotations: READ_ONLY_EXTERNAL_ANNOTATIONS,
      description: "Prepare a bounded direct operator change from purpose-built fresh Cloudflare reads and safe dashboard plan builders without writing. Raw HTTP methods and paths are not accepted.",
      inputSchema: changeInputSchema,
      outputSchema: planOutputSchema,
      title: "Plan bounded fleet change",
    },
    safeToolHandler(async ({ change }, context) => {
      const result = await service.planChange(change, {
        onProgress: createProgressReporter(
          stderr,
          "[mcp:plan_fleet_change]",
        ),
        signal: context.mcpReq.signal,
      })
      return toolResult(
        result,
        reviewedPlanSummary(result, "Fleet change"),
      )
    }, secrets),
  )

  server.registerTool(
    "apply_fleet_change",
    {
      annotations: APPLY_ANNOTATIONS,
      description: "Apply only an exact reviewed bounded fleet change after signed interactive confirmation, exclusive locking, fresh scoped replanning, pending journaling, sequential writes, and verification.",
      inputSchema: changeApplyInputSchema,
      outputSchema: applyOutputSchema,
      title: "Apply reviewed bounded fleet change",
    },
    reviewedMutationHandler({
      action: "fleet-change-apply",
      apply: (change, digest, commandOptions) => (
        service.applyChange(change, digest, commandOptions)
      ),
      plan: (change, commandOptions) => (
        service.planChange(change, commandOptions)
      ),
      request: (input) => input.change,
      title: "bounded fleet change",
      toolName: "apply_fleet_change",
    }),
  )

  server.registerTool(
    "list_activity",
    {
      annotations: READ_ONLY_LOCAL_ANNOTATIONS,
      description: "List durable local operation activity newest first without reading or writing Cloudflare.",
      inputSchema: emptyInputSchema,
      outputSchema: activityOutputSchema,
      title: "List fleet operation activity",
    },
    safeToolHandler(async () => {
      const result = await service.listActivity()
      return toolResult(result, activitySummary(result))
    }, secrets),
  )

  server.registerTool(
    "plan_activity_undo",
    {
      annotations: READ_ONLY_EXTERNAL_ANNOTATIONS,
      description: "Prepare a guarded inverse only for a verified reversible activity entry whose recorded post-write state still matches fresh live Cloudflare reads.",
      inputSchema: activityUndoInputSchema,
      outputSchema: planOutputSchema,
      title: "Plan guarded activity undo",
    },
    safeToolHandler(async ({ activityId }, context) => {
      const result = await service.planActivityUndo(activityId, {
        onProgress: createProgressReporter(
          stderr,
          "[mcp:plan_activity_undo]",
        ),
        signal: context.mcpReq.signal,
      })
      return toolResult(
        result,
        reviewedPlanSummary(result, "Guarded activity undo"),
      )
    }, secrets),
  )

  server.registerTool(
    "apply_activity_undo",
    {
      annotations: APPLY_ANNOTATIONS,
      description: "Apply a guarded inverse after signed interactive confirmation, exclusive locking, fresh drift checks before review and execution, pending journaling, sequential writes, and verification. Undo entries never create an implicit redo chain.",
      inputSchema: undoApplyInputSchema,
      outputSchema: applyOutputSchema,
      title: "Apply guarded activity undo",
    },
    reviewedMutationHandler({
      action: "activity-undo-apply",
      apply: (activityId, digest, commandOptions) => (
        service.applyActivityUndo(activityId, digest, commandOptions)
      ),
      plan: (activityId, commandOptions) => (
        service.planActivityUndo(activityId, commandOptions)
      ),
      request: (input) => input.activityId,
      title: "guarded activity undo",
      toolName: "apply_activity_undo",
    }),
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

export async function runFleetMcpMain(options = {}) {
  const argv = options.argv || process.argv.slice(2)
  const environment = options.environment || process.env
  const stderr = options.stderr || process.stderr
  const stdout = options.stdout || process.stdout
  const { fleetMcpUsage, parseFleetArguments } = await import("./cli.mjs")
  const parsed = parseFleetArguments(["mcp", ...argv])
  if (parsed.command === "mcp-help") {
    stdout.write(`${fleetMcpUsage()}\n`)
    return null
  }
  const runServer = options.runServer || runFleetMcpServer
  return runServer({
    environment,
    policyFile: parsed.policyFile,
    stateFile: parsed.stateFile,
    stderr,
  })
}

if (isMainModule(import.meta.url)) {
  runFleetMcpMain().catch((error) => {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`[mcp] ${redact(message, [process.env.CLOUDFLARE_API_TOKEN])}\n`)
    process.exitCode = error?.name === "CliUsageError"
      || error instanceof FleetConfigurationError
      ? FLEET_CLI_EXIT_CODE.USAGE
      : FLEET_CLI_EXIT_CODE.ERROR
  })
}
