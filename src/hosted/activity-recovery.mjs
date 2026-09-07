import { activityRecoverySchema } from "../interface-schemas.mjs"
import { portableReviewedPlanSet } from "../reviewed-plan-content.mjs"
import { completeOperationActivity, OPERATION_ACTIVITY_STATUS } from "../operation-history.mjs"
import { AlignmentPlanChangedError } from "../write-executor.mjs"
import { stableString } from "../normalize.mjs"
import { readHostedOperationActivity, finalizeHostedOperationActivity } from "./d1-store.mjs"
import { hostedExecutionLock } from "./execution-lock.mjs"

export function hostedActivityRecovery(db, accountId) {
  const lock = hostedExecutionLock(db, accountId)
  async function prepare(value) {
    const parsed = activityRecoverySchema.safeParse(value)
    if (!parsed.success) throw new TypeError("Recovery requires an activity ID, a reason, and confirmation that clients are stopped and affected resources inspected")
    const input = parsed.data
    const activity = await readHostedOperationActivity(db, accountId)
    const entry = activity.entries.find((candidate) => candidate.id === input.activityId)
    if (entry?.status !== OPERATION_ACTIVITY_STATUS.PENDING) throw new TypeError("Recovery requires an unresolved pending activity")
    const planSet = await portableReviewedPlanSet({
      accountId, plans: [],
      request: { kind: "interrupted-activity-recovery", input, entry },
    })
    return {
      schemaVersion: 1, status: "planned", accountId, activityId: entry.id, entry, planSet,
      reviewItems: [{
        title: "Close interrupted activity with an unknown outcome",
        lines: [
          entry.title, `Reason: ${input.reason}`,
          "I stopped the old clients and independently inspected all affected resources",
          "Cloudflare writes may have completed; this does not retry, reverse, or verify them",
          "Retain the original plan, record zero confirmed completions, disable automatic undo, and unblock subsequent reviewed writes",
          `Original plans: ${stableString(entry.plans)}`,
        ],
      }],
    }
  }
  async function planRecovery(input) {
    await lock.assertInactive()
    return prepare(input)
  }
  async function applyRecovery(input, digest) {
    const parsed = activityRecoverySchema.parse(input)
    await lock.assertInactive()
    const owner = await lock.acquire(crypto.randomUUID(), parsed.activityId)
    try {
      const plan = await prepare(parsed)
      if (plan.planSet.digest !== digest) throw new AlignmentPlanChangedError(digest, plan.planSet.digest)
      const entry = completeOperationActivity(plan.entry, {
        status: OPERATION_ACTIVITY_STATUS.WRITE_FAILED,
        execution: { completed: 0, total: plan.entry.plans.reduce((sum, item) => sum + item.operations.length, 0) },
        error: `Interrupted execution; outcome unknown, not zero applied writes. Old clients stopped and affected resources inspected. Operator recovery: ${parsed.reason}`,
        inverse: { available: false, plans: [], reason: "Interrupted execution has no verified result or safe automatic inverse" },
      })
      await lock.renew(owner)
      const activity = await finalizeHostedOperationActivity(db, accountId, entry)
      if (stableString(activity.entries.find((item) => item.id === entry.id)) !== stableString(entry)) throw new Error("Recovered activity failed persistence verification")
      return { schemaVersion: 1, status: "saved", accountId, applied: true, activityId: entry.id, entry, planDigest: digest, outcome: "unknown" }
    } finally { await lock.release(owner) }
  }
  return { planRecovery, applyRecovery }
}
