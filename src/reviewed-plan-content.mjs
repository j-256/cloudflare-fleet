import { stableString } from "./normalize.mjs"

export function reviewedPlanContent(options) {
  const plans = structuredClone(options.plans)
  return {
    accountId: options.accountId,
    plans,
    preview: plans.flatMap((plan) => plan.operations.map((operation) => ({
      label: operation.label,
      method: operation.method,
      path: operation.path,
      ...(plan.worker ? { accountId: plan.accountId, worker: plan.worker } : { zoneId: plan.zoneId, zoneName: plan.zoneName }),
      ...(Object.hasOwn(operation, "body") ? { body: operation.body } : {}),
      ...(Object.hasOwn(operation, "currentValue") ? { currentValue: operation.currentValue } : {}),
    }))),
    request: structuredClone(options.request),
    schemaVersion: 1,
  }
}

export async function portableReviewedPlanSet(options) {
  const content = reviewedPlanContent(options)
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(stableString(content)))
  const digest = `sha256:${[...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`
  return Object.freeze({ ...content, digest, validatedAt: options.validatedAt || new Date().toISOString() })
}
