import {
  appendOperationActivity,
  FleetIntentRevisionConflictError,
  finalizeOperationActivity,
  readOperationActivityDocument,
} from "./activity-store.mjs"
import {
  ALIGNMENT_PREPARATION_STATUS,
  listIntentAlignmentCandidates,
  prepareIntentAlignment,
  prepareIntentAlignments,
} from "./alignment-service.mjs"
import { CloudflareApi } from "./api.mjs"
import { resolvePolicyFile, resolveStateFile } from "./audit.mjs"
import { FleetConfigurationError } from "./cli-contract.mjs"
import { withFleetExecutionLock } from "./execution-lock.mjs"
import {
  FLEET_CHANGE_STATUS,
  prepareFleetChange,
} from "./fleet-change.mjs"
import { createEmptyFleetPolicyConfiguration } from "./fleet-policy.mjs"
import { readFleetPolicyConfiguration } from "./fleet-policy-store.mjs"
import {
  persistFleetIntentDocument,
  readFleetIntentDocument,
} from "./intent-store.mjs"
import {
  FLEET_INTENT_CHANGE_STATUS,
  prepareFleetIntentChange,
} from "./intent-plan.mjs"
import { loadInventory } from "./inventory.mjs"
import {
  compareVerificationGuards,
  OPERATION_ACTIVITY_STATUS,
} from "./operation-history.mjs"
import { createReviewedPlanSet } from "./reviewed-plan.mjs"
import { readFleetStateDocument } from "./state-store.mjs"
import {
  AlignmentPlanChangedError,
  executeVerifiedPlanSet,
} from "./write-executor.mjs"
import { readWriteVerificationTarget } from "./write-verification.mjs"

export const FLEET_SERVICE_SCHEMA_VERSION = 1
const BASELINE_INVENTORY_TTL_MS = 300000

export const FLEET_SERVICE_STATUS = Object.freeze({
  OK: "ok",
  ...ALIGNMENT_PREPARATION_STATUS,
  ...FLEET_CHANGE_STATUS,
  ...FLEET_INTENT_CHANGE_STATUS,
})

export class FleetIntentChangedError extends AlignmentPlanChangedError {
  constructor(expectedDigest) {
    super(expectedDigest, null)
    this.name = "FleetIntentChangedError"
    this.message = "Fleet intent changed after live alignment preparation; prepare and approve a new plan"
  }
}

function requiredFunction(value, label) {
  if (typeof value !== "function") throw new TypeError(`${label} is required`)
  return value
}

function requiredString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label} is required`)
  }
  return value
}

function operationTotal(planSet) {
  return planSet.plans.reduce(
    (total, plan) => total + plan.operations.length,
    0,
  )
}

function preparationResult(accountId, preparation) {
  return {
    accountId,
    assessment: preparation.assessment,
    facet: preparation.facet,
    planSet: preparation.planSet,
    reason: preparation.reason,
    schemaVersion: FLEET_SERVICE_SCHEMA_VERSION,
    selector: preparation.selector,
    status: preparation.status,
  }
}

function batchPreparationResult(accountId, preparation) {
  return {
    accountId,
    alignments: preparation.alignments,
    planSet: preparation.planSet,
    reason: preparation.reason,
    schemaVersion: FLEET_SERVICE_SCHEMA_VERSION,
    selectors: preparation.selectors,
    status: preparation.status,
  }
}

function publicPreparationResult(accountId, preparation) {
  return Array.isArray(preparation.selectors)
    ? batchPreparationResult(accountId, preparation)
    : preparationResult(accountId, preparation)
}

function changePreparationResult(accountId, preparation) {
  return {
    accountId,
    change: preparation.change,
    planSet: preparation.planSet,
    reason: preparation.reason,
    schemaVersion: FLEET_SERVICE_SCHEMA_VERSION,
    status: preparation.status,
    title: preparation.title,
  }
}

function intentPreparationResult(accountId, preparation) {
  return {
    accountId,
    diff: preparation.diff,
    planSet: preparation.planSet,
    reason: preparation.reason,
    schemaVersion: FLEET_SERVICE_SCHEMA_VERSION,
    status: preparation.status,
  }
}

function verificationSummary(entries) {
  return entries.map((entry) => ({
    status: entry.response?.status ?? null,
    target: entry.target,
  }))
}

function activityStore(
  stateFile,
  accountId,
  expectedDigest,
  expectedIntentRevision,
  dependencies,
) {
  return {
    async append(entry) {
      try {
        return await dependencies.appendActivity(
          stateFile,
          accountId,
          entry,
          { expectedIntentRevision },
        )
      } catch (error) {
        if (error instanceof FleetIntentRevisionConflictError) {
          throw new FleetIntentChangedError(expectedDigest)
        }
        throw error
      }
    },
    finalize(entry) {
      return dependencies.finalizeActivity(stateFile, accountId, entry)
    },
  }
}

async function verifyTargets(api, targets, options, dependencies) {
  const reads = targets.map((target) => (
    dependencies.readVerificationTarget(api, target, {
      signal: options.signal,
    })
  ))
  if (!options.bestEffort) return Promise.all(reads)
  const settled = await Promise.allSettled(reads)
  return settled
    .filter((entry) => entry.status === "fulfilled")
    .map((entry) => entry.value)
}

export function createFleetService(options) {
  if (!options || typeof options !== "object") {
    throw new TypeError("Fleet service options are required")
  }
  const accountId = requiredString(
    options.accountId || options.api?.accountId,
    "Cloudflare account identifier",
  )
  const api = options.api
  if (!api || typeof api !== "object") {
    throw new TypeError("Cloudflare API transport is required")
  }
  const stateFile = requiredString(options.stateFile, "Fleet state file")
  const policyFile = options.policyFile || null
  const dependencies = {
    appendActivity: options.appendActivity || appendOperationActivity,
    executePlanSet: options.executePlanSet || executeVerifiedPlanSet,
    finalizeActivity: options.finalizeActivity || finalizeOperationActivity,
    listCandidates: options.listCandidates || listIntentAlignmentCandidates,
    loadInventory: options.loadInventory || loadInventory,
    persistIntent: options.persistIntent || persistFleetIntentDocument,
    prepareAlignment: options.prepareAlignment || prepareIntentAlignment,
    prepareAlignments: options.prepareAlignments || prepareIntentAlignments,
    prepareChange: options.prepareChange || prepareFleetChange,
    prepareIntentChange: options.prepareIntentChange || prepareFleetIntentChange,
    readActivity: options.readActivity || readOperationActivityDocument,
    readIntent: options.readIntent || readFleetIntentDocument,
    readPolicy: options.readPolicy || (() => (
      policyFile
        ? readFleetPolicyConfiguration(policyFile)
        : createEmptyFleetPolicyConfiguration()
    )),
    readState: options.readState || readFleetStateDocument,
    readVerificationTarget: options.readVerificationTarget
      || readWriteVerificationTarget,
    withWriteLock: options.withWriteLock
      || ((operation) => withFleetExecutionLock(stateFile, operation)),
  }
  for (const [name, dependency] of Object.entries(dependencies)) {
    requiredFunction(dependency, `Fleet service dependency ${name}`)
  }
  const baselineInventoryTtlMs = Number.isFinite(options.baselineInventoryTtlMs)
    && options.baselineInventoryTtlMs >= 0
    ? options.baselineInventoryTtlMs
    : BASELINE_INVENTORY_TTL_MS
  const now = options.now || Date.now
  let baselineInventoryCache = null

  function cacheBaseline(inventory, intentRevision) {
    baselineInventoryCache = {
      expiresAt: now() + baselineInventoryTtlMs,
      intentRevision,
      inventory,
    }
    return inventory
  }

  async function baselineInventory(state, commandOptions) {
    if (baselineInventoryCache
      && baselineInventoryCache.intentRevision === state.intent.revision
      && baselineInventoryCache.expiresAt > now()) {
      return baselineInventoryCache.inventory
    }
    const inventory = await dependencies.loadInventory(api, {
      onProgress: commandOptions.onProgress,
      signal: commandOptions.signal,
    })
    return cacheBaseline(inventory, state.intent.revision)
  }

  function invalidateBaseline() {
    baselineInventoryCache = null
  }

  async function getIntent() {
    const document = await dependencies.readIntent(stateFile, accountId)
    return {
      accountId,
      document,
      schemaVersion: FLEET_SERVICE_SCHEMA_VERSION,
      status: FLEET_SERVICE_STATUS.OK,
    }
  }

  async function planIntent(document, commandOptions = {}) {
    const current = await dependencies.readIntent(stateFile, accountId)
    const preparation = await dependencies.prepareIntentChange(
      accountId,
      current,
      document,
      { validatedAt: commandOptions.validatedAt },
    )
    return intentPreparationResult(accountId, preparation)
  }

  async function applyIntent(document, expectedDigest, commandOptions = {}) {
    requiredString(expectedDigest, "Expected fleet intent plan digest")
    return dependencies.withWriteLock(async () => {
      const current = await dependencies.readIntent(stateFile, accountId)
      const preparation = await dependencies.prepareIntentChange(
        accountId,
        current,
        document,
        { validatedAt: commandOptions.validatedAt },
      )
      if (preparation.planSet.digest !== expectedDigest) {
        throw new AlignmentPlanChangedError(
          expectedDigest,
          preparation.planSet.digest,
        )
      }
      if (preparation.status === FLEET_INTENT_CHANGE_STATUS.UNCHANGED) {
        return {
          ...intentPreparationResult(accountId, preparation),
          applied: false,
          document: current,
        }
      }
      let persisted
      try {
        persisted = await dependencies.persistIntent(
          stateFile,
          accountId,
          current.revision,
          preparation.desired,
        )
      } catch (error) {
        if (error?.name === "FleetIntentRevisionConflictError") {
          throw new FleetIntentChangedError(expectedDigest)
        }
        throw error
      }
      invalidateBaseline()
      return {
        accountId,
        applied: true,
        diff: preparation.diff,
        document: persisted,
        planDigest: preparation.planSet.digest,
        schemaVersion: FLEET_SERVICE_SCHEMA_VERSION,
        status: "saved",
      }
    })
  }

  async function prepareChange(change, commandOptions = {}) {
    return dependencies.prepareChange(api, change, {
      onProgress: commandOptions.onProgress,
      readPolicy: dependencies.readPolicy,
      signal: commandOptions.signal,
      validatedAt: commandOptions.validatedAt,
    })
  }

  async function planChange(change, commandOptions = {}) {
    const preparation = await prepareChange(change, commandOptions)
    return changePreparationResult(accountId, preparation)
  }

  async function listAlignments(commandOptions = {}) {
    const state = await dependencies.readState(stateFile, accountId)
    const inventory = await dependencies.loadInventory(api, {
      onProgress: commandOptions.onProgress,
      signal: commandOptions.signal,
    })
    cacheBaseline(inventory, state.intent.revision)
    const result = dependencies.listCandidates(inventory, state.intent)
    return {
      accountId,
      candidates: result.candidates,
      intentRevision: state.intent.revision,
      schemaVersion: FLEET_SERVICE_SCHEMA_VERSION,
      status: FLEET_SERVICE_STATUS.OK,
      summary: result.summary,
    }
  }

  async function planAlignment(selector, commandOptions = {}) {
    const state = await dependencies.readState(stateFile, accountId)
    const baseline = await baselineInventory(state, commandOptions)
    const preparation = await dependencies.prepareAlignment(
      api,
      state.intent,
      selector,
      {
        baselineInventory: baseline,
        onProgress: commandOptions.onProgress,
        signal: commandOptions.signal,
        validatedAt: commandOptions.validatedAt,
      },
    )
    return preparationResult(accountId, preparation)
  }

  async function planAlignments(selectors, commandOptions = {}) {
    const state = await dependencies.readState(stateFile, accountId)
    const baseline = await baselineInventory(state, commandOptions)
    const preparation = await dependencies.prepareAlignments(
      api,
      state.intent,
      selectors,
      {
        baselineInventory: baseline,
        onProgress: commandOptions.onProgress,
        signal: commandOptions.signal,
        validatedAt: commandOptions.validatedAt,
      },
    )
    return batchPreparationResult(accountId, preparation)
  }

  async function executeAlignment(
    state,
    preparation,
    expectedDigest,
    commandOptions,
  ) {
    if (preparation.status !== ALIGNMENT_PREPARATION_STATUS.PLANNED) {
      return {
        ...publicPreparationResult(accountId, preparation),
        applied: false,
      }
    }
    if (preparation.planSet.digest !== expectedDigest) {
      throw new AlignmentPlanChangedError(
        expectedDigest,
        preparation.planSet.digest,
      )
    }

    invalidateBaseline()
    const outcome = await dependencies.executePlanSet({
      activityStore: activityStore(
        stateFile,
        accountId,
        expectedDigest,
        preparation.planSet.intentRevision,
        dependencies,
      ),
      api,
      async beforeExecute() {
        const current = await dependencies.readState(stateFile, accountId)
        if (current.intent.revision !== preparation.planSet.intentRevision) {
          throw new FleetIntentChangedError(expectedDigest)
        }
      },
      expectedDigest,
      onProgress(progress) {
        commandOptions.onProgress?.({
          ...progress,
          message: progress.operation
            ? `Applying ${progress.completed + 1}/${progress.total}: ${progress.operation.label}`
            : `Applied ${progress.completed}/${progress.total} operations`,
          stage: "writes",
        })
      },
      planSet: preparation.planSet,
      signal: commandOptions.signal,
      title: preparation.facet
        ? `Align ${preparation.facet.label} to fleet intent`
        : `Align ${preparation.alignments.length} fleet intent scopes`,
      verify(targets, verificationOptions = {}) {
        commandOptions.onProgress?.({
          completed: 0,
          message: `Verifying ${targets.length} affected resources`,
          stage: "verification",
          total: targets.length,
        })
        return verifyTargets(api, targets, {
          bestEffort: verificationOptions.bestEffort === true,
          signal: commandOptions.signal,
        }, dependencies)
      },
    })
    return {
      accountId,
      activity: outcome.activity,
      applied: outcome.executionResults.length > 0,
      error: outcome.error instanceof Error
        ? outcome.error.message
        : outcome.error || null,
      execution: outcome.activity?.execution || {
        completed: outcome.executionResults.length,
        total: operationTotal(preparation.planSet),
      },
      historyError: outcome.historyError instanceof Error
        ? outcome.historyError.message
        : outcome.historyError || null,
      inverse: outcome.inverse,
      planDigest: preparation.planSet.digest,
      schemaVersion: FLEET_SERVICE_SCHEMA_VERSION,
      ...(preparation.selector
        ? { selector: preparation.selector }
        : { selectors: preparation.selectors }),
      status: outcome.status,
      verification: verificationSummary(outcome.verificationEntries),
    }
  }

  async function executeChange(
    preparation,
    expectedDigest,
    commandOptions,
  ) {
    if (preparation.status !== FLEET_CHANGE_STATUS.PLANNED) {
      return {
        ...changePreparationResult(accountId, preparation),
        applied: false,
      }
    }
    if (preparation.planSet.digest !== expectedDigest) {
      throw new AlignmentPlanChangedError(
        expectedDigest,
        preparation.planSet.digest,
      )
    }
    invalidateBaseline()
    const outcome = await dependencies.executePlanSet({
      activityStore: activityStore(
        stateFile,
        accountId,
        expectedDigest,
        undefined,
        dependencies,
      ),
      api,
      expectedDigest,
      onProgress(progress) {
        commandOptions.onProgress?.({
          ...progress,
          message: progress.operation
            ? `Applying ${progress.completed + 1}/${progress.total}: ${progress.operation.label}`
            : `Applied ${progress.completed}/${progress.total} operations`,
          stage: "writes",
        })
      },
      planSet: preparation.planSet,
      signal: commandOptions.signal,
      title: preparation.title,
      verify(targets, verificationOptions = {}) {
        commandOptions.onProgress?.({
          completed: 0,
          message: `Verifying ${targets.length} affected resources`,
          stage: "verification",
          total: targets.length,
        })
        return verifyTargets(api, targets, {
          bestEffort: verificationOptions.bestEffort === true,
          signal: commandOptions.signal,
        }, dependencies)
      },
    })
    return {
      accountId,
      activity: outcome.activity,
      applied: outcome.executionResults.length > 0,
      change: preparation.change,
      error: outcome.error instanceof Error
        ? outcome.error.message
        : outcome.error || null,
      execution: outcome.activity?.execution || {
        completed: outcome.executionResults.length,
        total: operationTotal(preparation.planSet),
      },
      historyError: outcome.historyError instanceof Error
        ? outcome.historyError.message
        : outcome.historyError || null,
      inverse: outcome.inverse,
      planDigest: preparation.planSet.digest,
      schemaVersion: FLEET_SERVICE_SCHEMA_VERSION,
      status: outcome.status,
      title: preparation.title,
      verification: verificationSummary(outcome.verificationEntries),
    }
  }

  async function applyChange(change, expectedDigest, commandOptions = {}) {
    requiredString(expectedDigest, "Expected fleet change plan digest")
    return dependencies.withWriteLock(async () => {
      const preparation = await prepareChange(change, commandOptions)
      return executeChange(preparation, expectedDigest, commandOptions)
    })
  }

  async function applyAlignment(selector, expectedDigest, commandOptions = {}) {
    requiredString(expectedDigest, "Expected alignment plan digest")
    return dependencies.withWriteLock(async () => {
      const state = await dependencies.readState(stateFile, accountId)
      const baseline = await baselineInventory(state, commandOptions)
      const preparation = await dependencies.prepareAlignment(
        api,
        state.intent,
        selector,
        {
          baselineInventory: baseline,
          onProgress: commandOptions.onProgress,
          signal: commandOptions.signal,
          validatedAt: commandOptions.validatedAt,
        },
      )
      return executeAlignment(
        state,
        preparation,
        expectedDigest,
        commandOptions,
      )
    })
  }

  async function applyAlignments(selectors, expectedDigest, commandOptions = {}) {
    requiredString(expectedDigest, "Expected alignment plan digest")
    return dependencies.withWriteLock(async () => {
      const state = await dependencies.readState(stateFile, accountId)
      const baseline = await baselineInventory(state, commandOptions)
      const preparation = await dependencies.prepareAlignments(
        api,
        state.intent,
        selectors,
        {
          baselineInventory: baseline,
          onProgress: commandOptions.onProgress,
          signal: commandOptions.signal,
          validatedAt: commandOptions.validatedAt,
        },
      )
      return executeAlignment(
        state,
        preparation,
        expectedDigest,
        commandOptions,
      )
    })
  }

  async function listActivity() {
    const document = await dependencies.readActivity(stateFile, accountId)
    return {
      accountId,
      entries: [...document.entries].sort((left, right) => (
        String(right.startedAt).localeCompare(String(left.startedAt))
      )),
      revision: document.revision,
      schemaVersion: FLEET_SERVICE_SCHEMA_VERSION,
      status: FLEET_SERVICE_STATUS.OK,
      updatedAt: document.updatedAt,
    }
  }

  function blockedUndo(entry, reason, options = {}) {
    return {
      accountId,
      activityId: entry?.id || options.activityId,
      differences: options.differences || [],
      entry: entry || null,
      planSet: null,
      reason,
      schemaVersion: FLEET_SERVICE_SCHEMA_VERSION,
      status: FLEET_SERVICE_STATUS.BLOCKED,
    }
  }

  function eligibleUndoEntry(document, activityId) {
    const entry = document.entries.find((candidate) => candidate.id === activityId)
    if (!entry) return blockedUndo(null, "Operation activity was not found", { activityId })
    if (entry.status !== OPERATION_ACTIVITY_STATUS.VERIFIED) {
      return blockedUndo(entry, "Only a verified operation can be undone")
    }
    if (entry.inverse?.available !== true) {
      return blockedUndo(
        entry,
        entry.inverse?.reason || "The operation has no lossless inverse",
      )
    }
    const activeUndo = document.entries.find((candidate) => (
      candidate.undoOf === entry.id
        && [
          OPERATION_ACTIVITY_STATUS.PENDING,
          OPERATION_ACTIVITY_STATUS.VERIFIED,
        ].includes(candidate.status)
    ))
    if (activeUndo) {
      return blockedUndo(entry, "A guarded undo is already pending or verified")
    }
    if (entry.verification.length === 0) {
      return blockedUndo(entry, "The operation has no recorded verification guard")
    }
    return { entry }
  }

  async function readUndoGuard(entry, commandOptions = {}) {
    const liveEntries = await verifyTargets(
      api,
      entry.verification.map((guard) => guard.target),
      { signal: commandOptions.signal },
      dependencies,
    )
    return compareVerificationGuards(entry.verification, liveEntries)
  }

  async function prepareActivityUndo(activityId, commandOptions = {}) {
    requiredString(activityId, "Operation activity identifier")
    const document = await dependencies.readActivity(stateFile, accountId)
    const eligibility = eligibleUndoEntry(document, activityId)
    if (!eligibility.entry || eligibility.status === FLEET_SERVICE_STATUS.BLOCKED) {
      return eligibility
    }
    const comparison = await readUndoGuard(eligibility.entry, commandOptions)
    if (!comparison.matches) {
      return blockedUndo(
        eligibility.entry,
        "Live state no longer matches the recorded verified result",
        { differences: comparison.differences },
      )
    }
    const planSet = createReviewedPlanSet({
      accountId,
      plans: eligibility.entry.inverse.plans,
      request: {
        activityId,
        activityRevision: document.revision,
        kind: "activity-undo",
      },
      validatedAt: commandOptions.validatedAt,
    })
    return {
      accountId,
      activityId,
      differences: [],
      entry: eligibility.entry,
      planSet,
      reason: "Recorded post-write state still matches live Cloudflare state",
      schemaVersion: FLEET_SERVICE_SCHEMA_VERSION,
      status: FLEET_SERVICE_STATUS.PLANNED,
    }
  }

  async function planActivityUndo(activityId, commandOptions = {}) {
    return prepareActivityUndo(activityId, commandOptions)
  }

  async function applyActivityUndo(
    activityId,
    expectedDigest,
    commandOptions = {},
  ) {
    requiredString(expectedDigest, "Expected activity undo plan digest")
    return dependencies.withWriteLock(async () => {
      const preparation = await prepareActivityUndo(activityId, commandOptions)
      if (preparation.status !== FLEET_SERVICE_STATUS.PLANNED) {
        return { ...preparation, applied: false }
      }
      if (preparation.planSet.digest !== expectedDigest) {
        throw new AlignmentPlanChangedError(
          expectedDigest,
          preparation.planSet.digest,
        )
      }
      invalidateBaseline()
      const outcome = await dependencies.executePlanSet({
        activityStore: activityStore(
          stateFile,
          accountId,
          expectedDigest,
          undefined,
          dependencies,
        ),
        api,
        async beforeExecute() {
          const comparison = await readUndoGuard(
            preparation.entry,
            commandOptions,
          )
          if (!comparison.matches) {
            throw new Error(
              "Live state changed after guarded undo review; prepare a new undo plan",
            )
          }
        },
        expectedDigest,
        onProgress(progress) {
          commandOptions.onProgress?.({
            ...progress,
            message: progress.operation
              ? `Undoing ${progress.completed + 1}/${progress.total}: ${progress.operation.label}`
              : `Undid ${progress.completed}/${progress.total} operations`,
            stage: "writes",
          })
        },
        planSet: preparation.planSet,
        recordInverse: false,
        signal: commandOptions.signal,
        title: `Undo ${preparation.entry.title}`,
        undoOf: preparation.entry.id,
        verify(targets, verificationOptions = {}) {
          return verifyTargets(api, targets, {
            bestEffort: verificationOptions.bestEffort === true,
            signal: commandOptions.signal,
          }, dependencies)
        },
      })
      return {
        accountId,
        activity: outcome.activity,
        activityId,
        applied: outcome.executionResults.length > 0,
        error: outcome.error instanceof Error
          ? outcome.error.message
          : outcome.error || null,
        execution: outcome.activity?.execution || {
          completed: outcome.executionResults.length,
          total: operationTotal(preparation.planSet),
        },
        historyError: outcome.historyError instanceof Error
          ? outcome.historyError.message
          : outcome.historyError || null,
        planDigest: preparation.planSet.digest,
        schemaVersion: FLEET_SERVICE_SCHEMA_VERSION,
        status: outcome.status,
        verification: verificationSummary(outcome.verificationEntries),
      }
    })
  }

  return Object.freeze({
    accountId,
    applyActivityUndo,
    applyAlignment,
    applyAlignments,
    applyChange,
    applyIntent,
    getIntent,
    listActivity,
    listAlignments,
    planActivityUndo,
    planAlignment,
    planAlignments,
    planChange,
    planIntent,
    policyFile,
    stateFile,
  })
}

export function createLocalFleetService(options = {}) {
  const environment = options.environment || process.env
  const accountId = options.accountId
    || options.api?.accountId
    || environment.CLOUDFLARE_ACCOUNT_ID
  if (typeof accountId !== "string" || accountId.length === 0) {
    throw new FleetConfigurationError("CLOUDFLARE_ACCOUNT_ID is required")
  }
  let api = options.api
  if (!api) {
    const apiToken = environment.CLOUDFLARE_API_TOKEN
    if (typeof apiToken !== "string" || apiToken.length === 0) {
      throw new FleetConfigurationError("CLOUDFLARE_API_TOKEN is required")
    }
    api = new CloudflareApi({ accountId, apiToken })
  }
  return createFleetService({
    ...options,
    accountId,
    api,
    policyFile: resolvePolicyFile(options.policyFile, environment),
    stateFile: resolveStateFile(options.stateFile, environment),
  })
}
