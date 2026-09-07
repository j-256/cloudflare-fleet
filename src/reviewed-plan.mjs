import { createHash } from "node:crypto"

import { stableString } from "./normalize.mjs"
import { reviewedPlanContent } from "./reviewed-plan-content.mjs"

export const REVIEWED_PLAN_SCHEMA_VERSION = 1

export function createReviewedPlanSet(options) {
  const content = reviewedPlanContent(options)
  const digest = `sha256:${createHash("sha256")
    .update(stableString(content))
    .digest("hex")}`
  return Object.freeze({
    ...content,
    digest,
    validatedAt: options.validatedAt || new Date().toISOString(),
  })
}

export function reviewedPlanOperationCount(planSet) {
  return planSet.plans.reduce(
    (total, plan) => total + plan.operations.length,
    0,
  )
}
