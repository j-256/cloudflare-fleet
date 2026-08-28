import {
  buildInversePlans,
  completeOperationActivity,
  createPendingOperationActivity,
  createVerificationGuards,
  OPERATION_ACTIVITY_STATUS,
} from "./operation-history.mjs"
import { executePlans } from "./policies.mjs"
import {
  verificationTargetsForPlans,
  verificationTargetsForResults,
} from "./write-verification.mjs"

export class AlignmentPlanChangedError extends Error {
  constructor(expectedDigest, actualDigest) {
    super(`Live alignment plan ${actualDigest || "is unavailable"} does not match approved plan ${expectedDigest}`)
    this.name = "AlignmentPlanChangedError"
    this.actualDigest = actualDigest || null
    this.expectedDigest = expectedDigest
  }
}

function operationCount(plans) {
  return plans.reduce(
    (count, plan) => count + plan.operations.length,
    0,
  )
}

function validateExecutionOptions(options) {
  if (!options?.planSet || !Array.isArray(options.planSet.plans)) {
    throw new TypeError("Verified execution requires a prepared plan set")
  }
  if (typeof options.planSet.validatedAt !== "string"
    || !Number.isFinite(Date.parse(options.planSet.validatedAt))) {
    throw new TypeError("Verified execution requires a live validation time")
  }
  if (typeof options.title !== "string" || options.title.trim() === "") {
    throw new TypeError("Verified execution requires a title")
  }
  if (typeof options.verify !== "function") {
    throw new TypeError("Verified execution requires a verification reader")
  }
  const total = operationCount(options.planSet.plans)
  if (total === 0) throw new Error("The prepared plan has no API writes")
  verificationTargetsForPlans(options.planSet.plans)
  if (options.expectedDigest !== undefined) {
    if (typeof options.expectedDigest !== "string"
      || options.expectedDigest.length === 0) {
      throw new TypeError("Expected alignment plan digest is required")
    }
    if (options.planSet.digest !== options.expectedDigest) {
      throw new AlignmentPlanChangedError(
        options.expectedDigest,
        options.planSet.digest,
      )
    }
  }
  if (options.activityStore
    && (typeof options.activityStore.append !== "function"
      || typeof options.activityStore.finalize !== "function")) {
    throw new TypeError("Activity store requires append and finalize operations")
  }
  return total
}

function unavailableInverse(reason) {
  return {
    available: false,
    plans: [],
    reason,
  }
}

async function persistCompletion(options, pending, result) {
  if (!pending) return {
    document: null,
    entry: null,
    error: null,
  }
  const entry = completeOperationActivity(pending, result)
  try {
    const document = await options.activityStore.finalize(entry)
    options.onActivity?.({ document, entry, phase: "complete" })
    return {
      document,
      entry,
      error: null,
    }
  } catch (error) {
    return {
      document: null,
      entry,
      error,
    }
  }
}

export async function executeVerifiedPlanSet(options) {
  const total = validateExecutionOptions(options)
  await options.beforeExecute?.()

  const executionResults = []
  let pending = null
  if (options.activityStore) {
    pending = createPendingOperationActivity(
      options.title,
      options.planSet,
      { undoOf: options.undoOf || null },
    )
    const document = await options.activityStore.append(pending)
    options.onActivity?.({ document, entry: pending, phase: "pending" })
  }

  let writesCompleted = false
  try {
    await executePlans(options.api, options.planSet.plans, {
      onProgress: options.onProgress,
      onResult(result) {
        executionResults.push(result)
        options.onResult?.(result)
      },
      signal: options.signal,
    })
    writesCompleted = true
    options.onWritesComplete?.()
    const targets = verificationTargetsForResults(executionResults)
    const verificationEntries = await options.verify(targets)
    const inverse = options.recordInverse === false
      ? unavailableInverse(
          "Undo operations are recorded as final to avoid an implicit redo chain",
        )
      : buildInversePlans(executionResults)
    const completion = await persistCompletion(options, pending, {
      execution: {
        completed: executionResults.length,
        total,
      },
      inverse,
      status: OPERATION_ACTIVITY_STATUS.VERIFIED,
      verification: createVerificationGuards(verificationEntries),
    })
    return {
      activity: completion.entry,
      error: null,
      executionResults,
      historyError: completion.error,
      inverse,
      ok: true,
      status: OPERATION_ACTIVITY_STATUS.VERIFIED,
      verificationEntries,
      writesCompleted,
    }
  } catch (error) {
    let verificationEntries = []
    try {
      if (executionResults.length > 0) {
        const targets = verificationTargetsForResults(executionResults)
        verificationEntries = await options.verify(targets, {
          bestEffort: true,
        })
      }
    } catch {
      verificationEntries = []
    }
    const status = writesCompleted
      ? OPERATION_ACTIVITY_STATUS.VERIFICATION_FAILED
      : OPERATION_ACTIVITY_STATUS.WRITE_FAILED
    const completion = await persistCompletion(options, pending, {
      error: error instanceof Error ? error.message : String(error),
      execution: {
        completed: executionResults.length,
        total,
      },
      inverse: unavailableInverse(
        writesCompleted
          ? "Live verification did not complete, so no safe undo guard exists"
          : "The write sequence did not complete, so a batch inverse would be unsafe",
      ),
      status,
      verification: createVerificationGuards(verificationEntries),
    })
    return {
      activity: completion.entry,
      error,
      executionResults,
      historyError: completion.error,
      inverse: completion.entry?.inverse || null,
      ok: false,
      status,
      verificationEntries,
      writesCompleted,
    }
  }
}
