import { migrateFleetStateDocument, isFleetStateDocument } from "./fleet-state.mjs"
import { emptyWorkerRecords } from "./worker-records.mjs"
import { portableReviewedPlanSet } from "./reviewed-plan-content.mjs"
import { stableString } from "./normalize.mjs"

export const MAX_IMPORTED_ACTIVITIES = 500
const MAX_RECONCILED_DOCUMENT_BYTES = 1900000

function assertArchiveCapacity(state) {
  if (new TextEncoder().encode(JSON.stringify(state)).byteLength > MAX_RECONCILED_DOCUMENT_BYTES) {
    throw new TypeError("Fleet state exceeds the bounded recovery archive capacity; preserve a private export before arranging a larger-state migration")
  }
}

function mergeEntries(first, second, label) {
  const merged = new Map()
  for (const entry of [...first, ...second]) {
    if (merged.has(entry.id) && stableString(merged.get(entry.id)) !== stableString(entry)) {
      throw new TypeError(`Conflicting ${label} identity: ${entry.id}`)
    }
    merged.set(entry.id, structuredClone(entry))
  }
  return [...merged.values()]
}

function validateIncidentLinks(records, activity, accountId) {
  const byId = new Map(records.map((record) => [record.id, record]))
  const activityIds = new Set(activity.map((entry) => entry.id))
  for (const record of records) {
    if (record.report.accountId && record.report.accountId !== accountId) throw new TypeError("Worker incident report belongs to another account")
    if (record.activityId && !activityIds.has(record.activityId)) throw new TypeError("Worker incident references missing operation activity")
    const visited = new Set([record.id])
    let previous = record.supersedes
    while (previous) {
      const parent = byId.get(previous)
      if (!parent || parent.worker !== record.worker || visited.has(previous)) throw new TypeError("Worker incident supersession is missing, cyclic, or cross-Worker")
      visited.add(previous)
      previous = parent.supersedes
    }
  }
}

export async function planStateReconciliation(hostedState, input) {
  if (!input || Object.keys(input).some((key) => !["state", "intentSource"].includes(key))
    || !["incoming", "hosted"].includes(input.intentSource)) {
    throw new TypeError("State reconciliation requires state and explicit intentSource: incoming or hosted")
  }
  const hosted = migrateFleetStateDocument(hostedState)
  const incoming = migrateFleetStateDocument(input.state, hosted.accountId)
  if ([...hosted.activity.entries, ...incoming.activity.entries].some((entry) => entry.status === "pending")) {
    throw new TypeError("Resolve pending activity before reconciling Fleet state")
  }
  const entries = mergeEntries(hosted.activity.entries, incoming.activity.entries, "activity")
  const a = hosted.workers || emptyWorkerRecords()
  const b = incoming.workers || emptyWorkerRecords()
  const records = mergeEntries(a.records, b.records, "Worker incident")
    .sort((left, right) => Date.parse(left.recordedAt) - Date.parse(right.recordedAt) || left.id.localeCompare(right.id))
  validateIncidentLinks(records, entries, hosted.accountId)
  const preferred = input.intentSource === "incoming" ? b : a
  const other = input.intentSource === "incoming" ? a : b
  const workers = { ...a, intents: { ...other.intents, ...preferred.intents }, records }
  const intent = structuredClone(input.intentSource === "incoming" ? incoming.intent : hosted.intent)
  intent.revision = hosted.intent.revision
  const target = { ...hosted, intent, activity: { ...hosted.activity, entries }, workers }
  if (!isFleetStateDocument(target, hosted.accountId)) throw new TypeError("Merged Fleet state is invalid")
  if (entries.length - hosted.activity.entries.length > MAX_IMPORTED_ACTIVITIES) throw new TypeError("Reconcile history in bounded batches of at most 500 additional activities")
  assertArchiveCapacity(hosted)
  assertArchiveCapacity(target)
  const diff = ["groups", "policies", "acknowledgements", "coverageExpectations"].flatMap((collection) => {
    const before = new Map(hosted.intent[collection].map((entry) => [entry.id, entry]))
    const after = new Map(intent[collection].map((entry) => [entry.id, entry]))
    return [...new Set([...before.keys(), ...after.keys()])].filter((id) => stableString(before.get(id) ?? null) !== stableString(after.get(id) ?? null))
      .map((id) => ({ collection, id, before: before.get(id) ?? null, after: after.get(id) ?? null }))
  })
  const summary = {
    intentSource: input.intentSource,
    intentChanges: diff.length,
    addedActivities: entries.length - hosted.activity.entries.length,
    addedIncidents: records.length - a.records.length,
    changedWorkerIntents: [...new Set([...Object.keys(a.intents), ...Object.keys(workers.intents)])]
      .filter((worker) => stableString(a.intents[worker] ?? null) !== stableString(workers.intents[worker] ?? null)),
    preservesHostedHistory: true,
    archivesPreviousState: true,
  }
  const planSet = await portableReviewedPlanSet({
    accountId: hosted.accountId, plans: [],
    request: { kind: "state-reconciliation", hosted, incoming, intentSource: input.intentSource },
  })
  return {
    accountId: hosted.accountId, schemaVersion: 1, status: "planned", planSet,
    summary, diff, target,
    reviewItems: [
      { title: "State authority", lines: [`Use ${input.intentSource} intent; preserve all distinct operation and incident records`, "Archive the previous hosted state before persistence"] },
      ...diff.map((entry) => ({ title: `${entry.collection}: ${entry.id}`, lines: [`Before: ${stableString(entry.before)}`, `After: ${stableString(entry.after)}`] })),
      ...summary.changedWorkerIntents.map((worker) => ({ title: `Worker intent: ${worker}`, lines: [`Before: ${stableString(a.intents[worker] ?? null)}`, `After: ${stableString(workers.intents[worker] ?? null)}`] })),
      { title: "History merge", lines: [`Additional activities: ${summary.addedActivities}`, `Additional incidents: ${summary.addedIncidents}`, `Changed Worker intent: ${summary.changedWorkerIntents.join(", ") || "none"}`] },
    ],
  }
}
