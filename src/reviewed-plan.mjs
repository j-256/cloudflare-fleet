import { createHash } from "node:crypto"

import { stableString } from "./normalize.mjs"

export const REVIEWED_PLAN_SCHEMA_VERSION = 1

function operationPreview(plans) {
  return plans.flatMap((plan) => plan.operations.map((operation) => {
    const preview = {
      label: operation.label,
      method: operation.method,
      path: operation.path,
      zoneId: plan.zoneId,
      zoneName: plan.zoneName,
    }
    if (Object.hasOwn(operation, "body")) preview.body = operation.body
    if (Object.hasOwn(operation, "currentValue")) {
      preview.currentValue = operation.currentValue
    }
    return preview
  }))
}

export function createReviewedPlanSet(options) {
  const content = {
    accountId: options.accountId,
    plans: structuredClone(options.plans),
    preview: operationPreview(options.plans),
    request: structuredClone(options.request),
    schemaVersion: REVIEWED_PLAN_SCHEMA_VERSION,
  }
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
