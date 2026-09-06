import { auditFinding, FLEET_AUDIT_SEVERITY } from "./audit-report.mjs"

export const WORKER_SCHEDULE_KIND = "worker-schedules-update"
export const CRON_PROPAGATION_MS = 15 * 60 * 1000
export const WORKER_NAME_PATTERN = /^[a-z0-9_][a-z0-9_-]{0,127}$/

export function workerPath(accountId, worker, surface) {
  if (!WORKER_NAME_PATTERN.test(worker)) throw new TypeError("Invalid Worker name")
  return ["accounts", accountId, "workers", "scripts", worker, surface]
    .map(encodeURIComponent).join("/")
}

export function scheduleSet(result) {
  const schedules = Array.isArray(result) ? result : result?.schedules
  if (!Array.isArray(schedules)
    || schedules.some((entry) => typeof entry?.cron !== "string" || !entry.cron.trim())) {
    throw new TypeError("Worker schedule metadata is unavailable or malformed")
  }
  return [...new Set(schedules.map((entry) => entry.cron))].sort()
}

export function workerTriggerAssessment({ accountId, worker, handlers, schedules, readAt }) {
  const handlersKnown = Array.isArray(handlers)
    && handlers.every((entry) => typeof entry === "string")
  const schedulesKnown = Array.isArray(schedules)
    && schedules.every((entry) => typeof entry === "string")
  const coverage = {
    handlers: handlersKnown ? "observed" : "unknown",
    schedules: schedulesKnown ? "observed" : "unknown",
  }
  const unknown = !handlersKnown || !schedulesKnown
  const mismatch = !unknown && schedules.length > 0 && !handlers.includes("scheduled")
  const id = `deep.worker-scheduled-handler-missing:${worker}`
  return {
    confidence: unknown ? "unknown" : "high",
    coverage,
    findingId: id,
    inferredCause: mismatch ? "A Cron trigger targets code without a scheduled handler" : null,
    missingChecks: Object.entries(coverage).filter(([, status]) => status === "unknown").map(([key]) => key),
    observations: {
      accountId,
      handlers: handlersKnown ? [...handlers] : null,
      readAt,
      schedules: schedulesKnown ? [...schedules] : null,
      worker,
    },
    recommendedActions: mismatch
      ? ["Restore the intended scheduled handler", "Review and remove an obsolete trigger through an exact schedule plan"]
      : unknown ? ["Repeat the missing configuration reads before diagnosing a mismatch"] : [],
    status: unknown ? "unknown" : mismatch ? "mismatch" : "consistent",
  }
}

export function workerTriggerFinding(input) {
  const assessment = workerTriggerAssessment(input)
  if (assessment.status === "consistent") return null
  const unknown = assessment.status === "unknown"
  return auditFinding({
    category: "Workers",
    detail: unknown
      ? `${input.worker} has incomplete schedule or handler metadata; trigger compatibility is unknown`
      : `${input.worker} has Cron triggers but does not export a scheduled handler`,
    evidence: assessment,
    id: unknown ? `deep.worker-trigger-coverage-unknown:${input.worker}` : assessment.findingId,
    recommendation: assessment.recommendedActions.join("; "),
    severity: unknown ? FLEET_AUDIT_SEVERITY.REVIEW : FLEET_AUDIT_SEVERITY.WARNING,
    title: unknown ? "Worker trigger coverage is unknown" : "Worker Cron trigger has no scheduled handler",
  })
}
