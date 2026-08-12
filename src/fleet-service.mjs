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
} from "./alignment-service.mjs"
import { CloudflareApi } from "./api.mjs"
import { resolveStateFile } from "./audit.mjs"
import { withFleetExecutionLock } from "./execution-lock.mjs"
import { loadInventory } from "./inventory.mjs"
import { readFleetStateDocument } from "./state-store.mjs"
import {
  AlignmentPlanChangedError,
  executeVerifiedPlanSet,
} from "./write-executor.mjs"
import { readWriteVerificationTarget } from "./write-verification.mjs"

export const FLEET_SERVICE_SCHEMA_VERSION = 1

export const FLEET_SERVICE_STATUS = Object.freeze({
  OK: "ok",
  ...ALIGNMENT_PREPARATION_STATUS,
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
  const dependencies = {
    appendActivity: options.appendActivity || appendOperationActivity,
    executePlanSet: options.executePlanSet || executeVerifiedPlanSet,
    finalizeActivity: options.finalizeActivity || finalizeOperationActivity,
    listCandidates: options.listCandidates || listIntentAlignmentCandidates,
    loadInventory: options.loadInventory || loadInventory,
    prepareAlignment: options.prepareAlignment || prepareIntentAlignment,
    readActivity: options.readActivity || readOperationActivityDocument,
    readState: options.readState || readFleetStateDocument,
    readVerificationTarget: options.readVerificationTarget
      || readWriteVerificationTarget,
    withWriteLock: options.withWriteLock
      || ((operation) => withFleetExecutionLock(stateFile, operation)),
  }
  for (const [name, dependency] of Object.entries(dependencies)) {
    requiredFunction(dependency, `Fleet service dependency ${name}`)
  }

  async function listAlignments(commandOptions = {}) {
    const state = await dependencies.readState(stateFile, accountId)
    const inventory = await dependencies.loadInventory(api, {
      onProgress: commandOptions.onProgress,
      signal: commandOptions.signal,
    })
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
    const preparation = await dependencies.prepareAlignment(
      api,
      state.intent,
      selector,
      {
        onProgress: commandOptions.onProgress,
        signal: commandOptions.signal,
        validatedAt: commandOptions.validatedAt,
      },
    )
    return preparationResult(accountId, preparation)
  }

  async function applyAlignment(selector, expectedDigest, commandOptions = {}) {
    requiredString(expectedDigest, "Expected alignment plan digest")
    return dependencies.withWriteLock(async () => {
      const state = await dependencies.readState(stateFile, accountId)
      const preparation = await dependencies.prepareAlignment(
        api,
        state.intent,
        selector,
        {
          onProgress: commandOptions.onProgress,
          signal: commandOptions.signal,
          validatedAt: commandOptions.validatedAt,
        },
      )
      if (preparation.status !== ALIGNMENT_PREPARATION_STATUS.PLANNED) {
        return {
          ...preparationResult(accountId, preparation),
          applied: false,
        }
      }
      if (preparation.planSet.digest !== expectedDigest) {
        throw new AlignmentPlanChangedError(
          expectedDigest,
          preparation.planSet.digest,
        )
      }

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
        title: `Align ${preparation.facet.label} to fleet intent`,
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
        selector: preparation.selector,
        status: outcome.status,
        verification: verificationSummary(outcome.verificationEntries),
      }
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

  return Object.freeze({
    accountId,
    applyAlignment,
    listActivity,
    listAlignments,
    planAlignment,
    stateFile,
  })
}

export function createLocalFleetService(options = {}) {
  const environment = options.environment || process.env
  const accountId = options.accountId
    || options.api?.accountId
    || environment.CLOUDFLARE_ACCOUNT_ID
  requiredString(accountId, "CLOUDFLARE_ACCOUNT_ID")
  let api = options.api
  if (!api) {
    const apiToken = requiredString(
      environment.CLOUDFLARE_API_TOKEN,
      "CLOUDFLARE_API_TOKEN",
    )
    api = new CloudflareApi({ accountId, apiToken })
  }
  return createFleetService({
    ...options,
    accountId,
    api,
    stateFile: resolveStateFile(options.stateFile, environment),
  })
}
