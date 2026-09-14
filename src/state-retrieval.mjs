import { fleetIntentPolicyPresenceConstraint, fleetIntentPolicyValueConstraint } from "./fleet-intent.mjs"
import { boundedValue, compareIds, matchesSearch } from "./retrieval-values.mjs"
import { RETRIEVAL_LIMIT } from "./retrieval-schemas.mjs"

const SUMMARY_TEXT_LIMIT = 1000
const text = (value) => typeof value === "string" ? value.slice(0, SUMMARY_TEXT_LIMIT) : null
const unique = (values) => [...new Set(values.filter(Boolean))].sort(compareIds)

export function activityMatches(entry, query) {
  return (!query.zoneId || entry.plans.some((plan) => plan.zoneId === query.zoneId))
    && (!query.status || entry.status === query.status)
    && (!query.after || Date.parse(entry.startedAt) > Date.parse(query.after))
    && (!query.before || Date.parse(entry.startedAt) < Date.parse(query.before))
}
export function compareActivity(left, right) {
  return Date.parse(right.startedAt) - Date.parse(left.startedAt) || compareIds(left.id, right.id)
}
export async function activitySummary(entry, view = "summary") {
  const zoneIds = unique(entry.plans.map((plan) => plan.zoneId))
  const zoneNames = unique(entry.plans.map((plan) => plan.zoneName))
  const workers = unique(entry.plans.map((plan) => plan.worker))
  return {
    id: entry.id, title: entry.title, status: entry.status, startedAt: entry.startedAt,
    completedAt: entry.completedAt, validatedAt: entry.validatedAt,
    zoneIds: zoneIds.slice(0, RETRIEVAL_LIMIT.MAX), zoneNames: zoneNames.slice(0, RETRIEVAL_LIMIT.MAX).map(text), workers: workers.slice(0, RETRIEVAL_LIMIT.MAX).map(text),
    targetsTruncated: Math.max(zoneIds.length, zoneNames.length, workers.length) > RETRIEVAL_LIMIT.MAX,
    summaryTruncated: [entry.error, entry.inverse?.reason, ...zoneNames, ...workers].some((value) => typeof value === "string" && value.length > SUMMARY_TEXT_LIMIT),
    planCount: entry.plans.length, execution: entry.execution,
    verificationCount: entry.verificationCount ?? entry.verification.length, undoOf: entry.undoOf,
    undo: { recordedAvailable: entry.inverse?.available === true, reason: text(entry.inverse?.reason) || "No inverse has been recorded", requiresLivePlan: true },
    error: text(entry.error),
    ...(view === "full" ? { detail: await boundedValue(entry) } : {}),
  }
}
export function policyMatches(policy, document, query) {
  const group = document.groups.find((entry) => entry.id === policy.groupId)
  return (!query.groupId || policy.groupId === query.groupId)
    && (!query.category || policy.facet.category === query.category)
    && (!query.zoneId || group?.mode === "all" || group?.members?.some((member) => member.zoneId === query.zoneId))
    && matchesSearch(query.search, policy.id, policy.name, policy.facet.category, policy.facet.key, policy.facet.label)
}
export async function policySummary(policy, document, view = "summary") {
  return {
    id: policy.id, name: policy.name || policy.facet.label || policy.id, groupId: policy.groupId,
    facet: { category: policy.facet.category, key: policy.facet.key, ...(policy.facet.label ? { label: policy.facet.label } : {}), ...(policy.facet.phase ? { phase: policy.facet.phase } : {}) }, presence: fleetIntentPolicyPresenceConstraint(policy), valueConstraint: fleetIntentPolicyValueConstraint(policy),
    expected: await boundedValue(policy.expected?.value),
    acknowledgementCount: document.acknowledgements.filter((entry) => entry.policyId === policy.id).length,
    ...(view === "full" ? { detail: await boundedValue(policy) } : {}),
  }
}
