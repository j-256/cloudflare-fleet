import { inspectWorker, normalizeWorkerInspection, readWorkerConfiguration } from "./worker-inspection.mjs"
import { normalizeWorkerIntent, WORKER_RECORD_PAGE_LIMIT } from "./worker-records.mjs"
import { CRON_PROPAGATION_MS, WORKER_SCHEDULE_KIND, workerPath } from "./worker-triggers.mjs"
import { stableString } from "./normalize.mjs"
import { portableReviewedPlanSet } from "./reviewed-plan-content.mjs"
import { executeVerifiedPlanSet, AlignmentPlanChangedError } from "./write-executor.mjs"
import { compareVerificationGuards } from "./operation-history.mjs"
import { readWriteVerificationTarget } from "./write-verification.mjs"

const PLANNED = "planned"

function checkDigest(plan, digest) {
  if (!/^sha256:[a-f0-9]{64}$/.test(digest) || plan?.digest !== digest) throw new AlignmentPlanChangedError(digest, plan?.digest)
}

function exactInput(input, fields) {
  if (!input || typeof input !== "object" || Array.isArray(input)
    || Object.keys(input).some((key) => !fields.includes(key))) throw new TypeError("Unsupported Worker operation fields")
}

export function createWorkerService({ api, store, activityStore, withWriteLock, now = Date.now }) {
  const accountId = api.accountId
  const envelope = (result) => ({ accountId, schemaVersion: 1, ...result })
  const basePlan = (worker, kind, operations, extra = {}) => ({ accountId, worker, id: `${kind}:${worker}`, kind, summary: `${kind} for ${worker}`, operations, ...extra })

  async function inspect(input, options = {}) {
    const report = await inspectWorker(api, input, { ...options, now })
    const document = await store.read()
    return { ...report, intent: Object.hasOwn(document.intents, report.worker) ? document.intents[report.worker] : normalizeWorkerIntent({ mode: "unmanaged" }) }
  }

  async function history(input) {
    exactInput(input, ["worker", "offset", "limit"])
    workerPath(accountId, input.worker, "schedules")
    const offset = input.offset ?? 0
    const limit = input.limit ?? 20
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > WORKER_RECORD_PAGE_LIMIT) throw new TypeError("Invalid incident page bounds")
    const document = await store.read()
    const records = document.records.filter((entry) => entry.worker === input.worker).reverse()
    const page = records.slice(offset, offset + limit)
    return envelope({ status: "ok", worker: input.worker, revision: document.revision, records: page, nextOffset: offset + page.length < records.length ? offset + page.length : null, intent: Object.hasOwn(document.intents, input.worker) ? document.intents[input.worker] : normalizeWorkerIntent({ mode: "unmanaged" }) })
  }

  async function saveReport(report, activityId = null) {
    return withWriteLock(async () => {
      const document = await store.read()
      const prior = [...document.records].reverse().find((entry) => entry.findingId === report.assessment.findingId && entry.worker === report.worker)
      const record = { id: `incident-${crypto.randomUUID()}`, worker: report.worker, findingId: report.assessment.findingId, recordedAt: new Date(now()).toISOString(), supersedes: prior?.id || null, activityId, report }
      await store.write(document.revision, { ...document, records: [...document.records, record] })
      return envelope({ status: "saved", record })
    })
  }

  async function record(input, options = {}) { return saveReport(await inspect(input, options)) }

  async function planIntent(input, options = {}) {
    exactInput(input, ["worker", "intent", "expectedRevision"])
    workerPath(accountId, input.worker, "schedules")
    const intent = normalizeWorkerIntent(input.intent)
    const document = await store.read()
    if (input.expectedRevision !== document.revision) throw new Error("Worker records revision changed; read and review again")
    const current = Object.hasOwn(document.intents, input.worker) ? document.intents[input.worker] : normalizeWorkerIntent({ mode: "unmanaged" })
    const operations = stableString(current) === stableString(intent) ? [] : [{ label: "Save explicit schedule intent and deployment reconciliation review", method: "PUT", path: `fleet/worker-intent/${input.worker}`, currentValue: current, body: intent }]
    const planSet = await portableReviewedPlanSet({ accountId, plans: operations.length ? [basePlan(input.worker, "worker-schedule-intent", operations)] : [], request: { ...input, intent }, validatedAt: options.validatedAt })
    return envelope({ status: operations.length ? PLANNED : "aligned", planSet, reason: "Local intent only; deployment configuration remains authoritative and must be reconciled by its owner", title: "Worker schedule intent" })
  }

  async function applyIntent(input, digest, options = {}) {
    return withWriteLock(async () => {
      const preparation = await planIntent(input, options)
      checkDigest(preparation.planSet, digest)
      const document = await store.read()
      const intents = { ...document.intents, [input.worker]: normalizeWorkerIntent(input.intent) }
      const saved = await store.write(input.expectedRevision, { ...document, intents })
      return envelope({ status: "saved", applied: true, planDigest: digest, revision: saved.revision, intent: intents[input.worker] })
    })
  }

  async function planSchedules(input, options = {}) {
    exactInput(input, ["worker", "kind", "intent", "findingId"])
    if (input.kind !== WORKER_SCHEDULE_KIND) throw new TypeError("Expected a Worker schedules change")
    workerPath(accountId, input.worker, "schedules")
    if (input.findingId) normalizeWorkerInspection({ worker: input.worker, findingId: input.findingId }, now())
    const intent = normalizeWorkerIntent(input.intent)
    if (intent.mode === "unmanaged") throw new TypeError("Unmanaged intent cannot authorize a schedule change")
    const config = await readWorkerConfiguration(api, input.worker, { ...options, now })
    const document = await store.read()
    const savedIntent = Object.hasOwn(document.intents, input.worker) ? document.intents[input.worker] : null
    if (savedIntent && stableString(savedIntent) !== stableString(intent)) return envelope({ status: "blocked", planSet: null, reason: "Saved schedule intent differs; review and persist the new intent first" })
    if (config.schedules.status !== "observed" || config.deployment.status !== "observed") return envelope({ status: "blocked", planSet: null, reason: "Schedules and active deployment must both be observed before planning" })
    if (intent.crons.length && (config.assessment.coverage.handlers === "unknown" || config.versions.some((v) => v.percentage > 0 && !v.value?.handlers.includes("scheduled")))) {
      return envelope({ status: "blocked", planSet: null, reason: "Every serving version must export scheduled before adding or retaining Cron triggers" })
    }
    const operation = { label: "Replace only this Worker's exact Cron schedule set", method: "PUT", path: workerPath(accountId, input.worker, "schedules"), body: intent.crons.map((cron) => ({ cron })), currentValue: config.schedules.value.map((cron) => ({ cron })), deployment: config.deployment.value }
    const changed = stableString(intent.crons) !== stableString(config.schedules.value)
    const plans = changed ? [basePlan(input.worker, WORKER_SCHEDULE_KIND, [operation], { intent, findingId: config.assessment.findingId, intentRevision: document.revision })] : []
    const planSet = await portableReviewedPlanSet({ accountId, plans, request: { ...input, intent, intentRevision: document.revision, deployment: config.deployment.value, schedules: config.schedules.value }, validatedAt: options.validatedAt })
    return envelope({ status: changed ? PLANNED : "aligned", change: { ...input, intent }, title: "Worker Cron schedules", planSet, reason: changed ? "Schedule-only change; reconcile the reviewed owning deployment configuration and allow up to 15 minutes for propagation" : "Live schedules match the requested configuration", assessment: config.assessment })
  }

  async function execute(preparation, digest, options, undoOf = null) {
    checkDigest(preparation.planSet, digest)
    if (preparation.status !== PLANNED) return { ...preparation, applied: false }
    const outcome = await executeVerifiedPlanSet({
      api, activityStore, expectedDigest: digest, planSet: preparation.planSet, title: preparation.title,
      undoOf, recordInverse: !undoOf, signal: options.signal,
      beforeExecute: options.beforeExecute,
      verify: (targets) => Promise.all(targets.map((target) => readWriteVerificationTarget(api, target, options))),
    })
    return envelope({ status: outcome.status, activity: outcome.activity, applied: outcome.executionResults.length > 0, execution: outcome.activity?.execution, inverse: outcome.inverse, planDigest: digest, error: outcome.error ? "Schedule execution or verification failed; inspect activity before retrying" : null, historyError: outcome.historyError ? "Activity finalization failed" : null, verification: outcome.verificationEntries.map((entry) => ({ target: entry.target, status: entry.response.status })), health: { configuration: outcome.ok ? "accepted" : "unknown", status: outcome.ok ? "propagation-pending" : "unknown", earliestEvidenceAt: outcome.activity?.completedAt ? new Date(Date.parse(outcome.activity.completedAt) + CRON_PROPAGATION_MS).toISOString() : null } })
  }

  async function applySchedules(input, digest, options = {}) {
    return withWriteLock(async () => {
      const preparation = await planSchedules(input, options)
      checkDigest(preparation.planSet, digest)
      return execute(preparation, digest, { ...options, beforeExecute: async () => checkDigest((await planSchedules(input, options)).planSet, digest) })
    })
  }

  async function planUndo(activityId, options = {}) {
    const document = await activityStore.read()
    const entry = document.entries.find((candidate) => candidate.id === activityId)
    const blocked = (reason) => envelope({ status: "blocked", activityId, planSet: null, reason })
    if (!entry || entry.status !== "verified" || !entry.inverse?.available
      || entry.plans.some((plan) => plan.kind !== WORKER_SCHEDULE_KIND || plan.accountId !== accountId)) return blocked("No verified, recoverable Worker schedule change found")
    if (document.entries.some((candidate) => candidate.undoOf === activityId && ["pending", "verified"].includes(candidate.status))) return blocked("Undo is already pending or verified")
    try {
      const live = await Promise.all(entry.verification.map((guard) => readWriteVerificationTarget(api, guard.target, options)))
      if (!live.length || !compareVerificationGuards(entry.verification, live).matches) return blocked("Live schedule state changed")
    } catch { return blocked("Live schedule or deployment drifted or could not be read") }
    const records = await store.read()
    const configurationReview = entry.plans.map((plan) => ({ worker: plan.worker, owner: plan.intent?.owner || null, savedIntent: Object.hasOwn(records.intents, plan.worker) ? records.intents[plan.worker] : null, recovery: "Review the owning deployment configuration and saved intent against the inverse schedule set; neither is changed by this undo" }))
    const planSet = await portableReviewedPlanSet({ accountId, plans: entry.inverse.plans, request: { activityId, activityRevision: document.revision, intentRevision: records.revision, configurationReview }, validatedAt: options.validatedAt })
    return envelope({ status: PLANNED, activityId, planSet, title: `Undo ${entry.title}`, reason: "Live schedule and deployment still match the preserved post-change state; also reconcile the owning configuration" })
  }

  async function applyUndo(activityId, digest, options = {}) {
    return withWriteLock(async () => execute(await planUndo(activityId, options), digest, { ...options, beforeExecute: async () => checkDigest((await planUndo(activityId, options)).planSet, digest) }, activityId))
  }

  async function verify(input, options = {}) {
    exactInput(input, ["worker", "activityId", "start", "end", "limit", "zoneIds"])
    const document = await activityStore.read()
    const entry = document.entries.find((candidate) => candidate.id === input.activityId)
    if (!entry || entry.status !== "verified" || !entry.plans.every((plan) => plan.worker === input.worker && plan.accountId === accountId)
      || !entry.verification.every((guard) => guard.target.kind === "worker-schedules")) throw new TypeError("Verification requires this Worker's verified schedule activity")
    const earliest = Date.parse(entry.completedAt) + CRON_PROPAGATION_MS
    const end = input.end ? Date.parse(input.end) : now()
    if (!Number.isFinite(end) || end > now()) throw new TypeError("Invalid verification end time")
    const pending = end <= earliest
    const requestedStart = input.start ? Date.parse(input.start) : end - 60 * 60 * 1000
    const start = pending ? end - 1 : Math.max(earliest, requestedStart)
    const report = await inspect({ worker: input.worker, start: new Date(start).toISOString(), end: new Date(end).toISOString(), limit: input.limit, zoneIds: input.zoneIds, logs: !pending }, options)
    const guard = entry.verification[0]?.target
    const matches = stableString(report.schedules.value) === stableString(guard?.expectedSchedules) && stableString(report.deployment.value) === stableString(guard?.deployment)
    const samples = report.logs.value?.samples || []
    const fresh = samples.filter((sample) => sample.servingVersion === true)
    const failures = fresh.some((sample) => !["ok", "unknown"].includes(sample.outcome) || sample.httpStatus >= 500)
    const known = fresh.length > 0 && fresh.every((sample) => sample.eventType !== "unknown" && sample.outcome === "ok" && !sample.truncated && (sample.eventType !== "fetch" || sample.httpStatus !== null))
    const scheduledRequired = guard?.expectedSchedules.length > 0
    const scheduledSeen = guard?.expectedSchedules.every((cron) => fresh.some((sample) => sample.eventType === "scheduled" && sample.cron === cron))
    const disabledStillFiring = !scheduledRequired && fresh.some((sample) => sample.eventType === "scheduled")
    report.verification = { activityId: entry.id, configuration: matches ? "accepted" : "drifted-or-unknown", earliestEvidenceAt: new Date(earliest).toISOString(), status: !matches ? "configuration-drift" : pending ? "propagation-pending" : failures || disabledStillFiring ? "observed-failures" : known && (!scheduledRequired || scheduledSeen) && !report.logs.value?.limitReached ? "observed-healthy" : "awaiting-evidence", caveat: "Healthy describes only fresh observed invocations; sampling and missing logs cannot prove that all traffic succeeded or that a removed trigger will never fire" }
    return saveReport(report, entry.id)
  }

  return Object.freeze({ inspect, record, history, planIntent, applyIntent, planSchedules, applySchedules, planUndo, applyUndo, verify })
}
