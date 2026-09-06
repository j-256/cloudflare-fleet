import { z } from "zod"
import {
  fleetChangeSchema, fleetIntentDocumentSchema, digestSchema, identifierSchema, activityRecoverySchema,
  workerInspectionSchema, workerHistorySchema, workerIntentInputSchema, workerVerificationSchema,
} from "./interface-schemas.mjs"
import { normalizeAlignmentSelector, normalizeAlignmentSelectors } from "./alignment-service.mjs"
import { runWorkerCommand, WORKER_COMMANDS, WORKER_READ_COMMANDS } from "./worker-command.mjs"
import { FleetCommandError } from "./command-diagnostics.mjs"

export const FLEET_COMMAND_VERSION = 1
export const FLEET_COMMAND_TIMEOUT_MS = 90000
const empty = z.strictObject({})
const selector = z.union([
  z.strictObject({ policyId: identifierSchema }),
  z.strictObject({ category: identifierSchema, key: identifierSchema, phase: z.string().max(256).optional(), zoneIds: z.array(identifierSchema).min(1).max(100).optional() }),
])
const schemas = {
  status: empty,
  "intent-get": empty,
  "intent-plan": z.strictObject({ document: fleetIntentDocumentSchema }),
  "intent-apply": z.strictObject({ document: fleetIntentDocumentSchema, planDigest: digestSchema }),
  "alignment-list": empty,
  "alignment-plan": z.strictObject({ selector }),
  "alignment-apply": z.strictObject({ selector, planDigest: digestSchema }),
  "alignments-plan": z.strictObject({ selectors: z.array(selector).min(1).max(20) }),
  "alignments-apply": z.strictObject({ selectors: z.array(selector).min(1).max(20), planDigest: digestSchema }),
  "change-plan": z.strictObject({ change: fleetChangeSchema }),
  "change-apply": z.strictObject({ change: fleetChangeSchema, planDigest: digestSchema }),
  "activity-list": empty,
  "undo-plan": z.strictObject({ activityId: identifierSchema }),
  "undo-apply": z.strictObject({ activityId: identifierSchema, planDigest: digestSchema }),
  audit: z.strictObject({ deep: z.boolean().optional() }),
  "state-get": z.strictObject({ archiveId: identifierSchema.optional() }),
  "state-plan": z.strictObject({ state: z.json(), intentSource: z.enum(["incoming", "hosted"]) }),
  "state-apply": z.strictObject({ state: z.json(), intentSource: z.enum(["incoming", "hosted"]), planDigest: digestSchema }),
  "recovery-plan": activityRecoverySchema,
  "recovery-apply": activityRecoverySchema.extend({ planDigest: digestSchema }),
}
const workerSchemas = {
  inspect: workerInspectionSchema,
  record: workerInspectionSchema,
  history: workerHistorySchema,
  verify: workerVerificationSchema,
  "intent-plan": workerIntentInputSchema,
  "intent-apply": z.strictObject({ input: workerIntentInputSchema, planDigest: digestSchema }),
  "schedules-plan": fleetChangeSchema,
  "schedules-apply": z.strictObject({ input: fleetChangeSchema, planDigest: digestSchema }),
  "undo-plan": z.strictObject({ activityId: identifierSchema }),
  "undo-apply": z.strictObject({ activityId: identifierSchema, planDigest: digestSchema }),
}
export const FLEET_READ_COMMANDS = Object.freeze(Object.keys(schemas).filter((name) => !name.endsWith("-apply")))

export function fleetCommandIsReadOnly(command) {
  return FLEET_READ_COMMANDS.includes(command)
    || command.startsWith("worker-") && WORKER_READ_COMMANDS.includes(command.slice(7))
}

export function validateFleetCommand(value) {
  const envelope = z.strictObject({
    version: z.literal(FLEET_COMMAND_VERSION),
    accountId: identifierSchema,
    command: z.string().max(64),
    input: z.record(z.string(), z.unknown()),
  }).safeParse(value)
  if (!envelope.success) throw new TypeError("Invalid Fleet command envelope")
  const command = envelope.data.command
  if (command.startsWith("worker-") && WORKER_COMMANDS.includes(command.slice(7))) {
    const input = workerSchemas[command.slice(7)].safeParse(envelope.data.input)
    if (!input.success) throw new TypeError(`Invalid input for ${command}`)
    return { ...envelope.data, input: input.data }
  }
  if (!Object.hasOwn(schemas, command)) throw new TypeError("Unsupported Fleet command")
  const input = schemas[command].safeParse(envelope.data.input)
  if (!input.success) throw new TypeError(`Invalid input for ${command}`)
  return { ...envelope.data, input: input.data }
}

export async function runFleetServiceCommand(service, value, options = {}) {
  const { command, accountId, input } = validateFleetCommand(value)
  if (accountId !== service.accountId) throw new TypeError("Fleet command account does not match the hosted account")
  if (options.readOnly && !fleetCommandIsReadOnly(command)) throw new Error("Hosted Fleet writes are disabled")
  const startedAt = Date.now()
  const deadlineMs = options.timeoutMs ?? FLEET_COMMAND_TIMEOUT_MS
  const deadline = AbortSignal.timeout(deadlineMs)
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline
  let progress = null
  const context = { signal, onProgress(value) { progress = value; options.onProgress?.(value) } }
  try {
    signal.throwIfAborted()
    return await dispatchFleetServiceCommand(service, command, accountId, input, context, options)
  } catch (error) {
    if (error instanceof TypeError || ["AlignmentPlanChangedError", "FleetIntentChangedError", "HostedExecutionConflictError"].includes(error?.name)) throw error
    throw new FleetCommandError(error, {
      command, deadlineMs, elapsedMs: Date.now() - startedAt, progress,
      readOnly: fleetCommandIsReadOnly(command), signal,
    })
  }
}

async function dispatchFleetServiceCommand(service, command, accountId, input, context, options) {
  if (command.startsWith("worker-")) return runWorkerCommand(service.workers, command.slice(7), input, { ...context, readOnly: options.readOnly })
  switch (command) {
    case "status": return { ...(await service.status()), schemaVersion: 1, status: "ok", accountId, backend: "hosted", commandVersion: FLEET_COMMAND_VERSION, readOnly: options.readOnly === true }
    case "intent-get": return service.getIntent()
    case "intent-plan": return service.planIntent(input.document, context)
    case "intent-apply": return service.applyIntent(input.document, input.planDigest, context)
    case "alignment-list": return service.listAlignments(context)
    case "alignment-plan": return service.planAlignment(normalizeAlignmentSelector(input.selector), context)
    case "alignment-apply": return service.applyAlignment(normalizeAlignmentSelector(input.selector), input.planDigest, context)
    case "alignments-plan": return service.planAlignments(normalizeAlignmentSelectors(input.selectors), context)
    case "alignments-apply": return service.applyAlignments(normalizeAlignmentSelectors(input.selectors), input.planDigest, context)
    case "change-plan": return service.planChange(input.change, context)
    case "change-apply": return service.applyChange(input.change, input.planDigest, context)
    case "activity-list": return service.listActivity()
    case "undo-plan": return service.planActivityUndo(input.activityId, context)
    case "undo-apply": return service.applyActivityUndo(input.activityId, input.planDigest, context)
    case "audit": return service.audit({ ...context, deep: input.deep === true })
    case "state-get": return service.getState(input.archiveId)
    case "state-plan": return service.planState(input)
    case "recovery-plan": return service.planRecovery(input)
    case "recovery-apply": {
      const { planDigest, ...request } = input
      return service.applyRecovery(request, planDigest)
    }
    case "state-apply": {
      const { planDigest, ...request } = input
      return service.applyState(request, planDigest)
    }
  }
}
