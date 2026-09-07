import { stableString } from "./normalize.mjs"
import { WORKER_NAME_PATTERN, WORKER_CRON_PATTERN, WORKER_CRON_MAX_LENGTH } from "./worker-triggers.mjs"

export const WORKER_INTENT_MODES = Object.freeze(["disabled", "exact", "unmanaged"])
export const WORKER_RECORD_PAGE_LIMIT = 50

export function emptyWorkerRecords() {
  return { schemaVersion: 1, revision: "", intents: {}, records: [] }
}

export function normalizeWorkerIntent(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some((key) => !["mode", "crons", "owner", "reconciliation"].includes(key))
    || !WORKER_INTENT_MODES.includes(value.mode)) throw new TypeError("Invalid Worker schedule intent")
  const crons = value.crons || []
  if (!Array.isArray(crons) || crons.length > 10
    || crons.some((cron) => typeof cron !== "string" || cron.length > WORKER_CRON_MAX_LENGTH
      || !WORKER_CRON_PATTERN.test(cron))
    || new Set(crons).size !== crons.length) throw new TypeError("Expected unique five-field Cron expressions")
  if ((value.mode === "exact") !== (crons.length > 0)) throw new TypeError("Exact intent requires schedules; disabled and unmanaged require an empty set")
  const owner = value.owner ?? null
  const reconciliation = value.reconciliation ?? null
  if (value.mode !== "unmanaged" && (!owner || !reconciliation)) throw new TypeError("Managed schedules require the owning deployment configuration and reviewed reconciliation step")
  for (const text of [owner, reconciliation]) {
    if (text !== null && (typeof text !== "string" || !text.trim() || text.length > 1000)) throw new TypeError("Invalid deployment configuration review")
  }
  return { mode: value.mode, crons: [...crons].sort(), owner, reconciliation }
}

export function isWorkerRecords(value) {
  if (!value || value.schemaVersion !== 1 || typeof value.revision !== "string"
    || !value.intents || typeof value.intents !== "object" || Array.isArray(value.intents)
    || !Array.isArray(value.records)) return false
  try {
    for (const [worker, intent] of Object.entries(value.intents)) {
      if (!WORKER_NAME_PATTERN.test(worker) || stableString(normalizeWorkerIntent(intent)) !== stableString(intent)) return false
    }
    return value.records.every((record) => typeof record.id === "string"
      && WORKER_NAME_PATTERN.test(record.worker) && Number.isFinite(Date.parse(record.recordedAt))
      && typeof record.findingId === "string" && record.report?.worker === record.worker)
  } catch { return false }
}

export async function revisedWorkerRecords(document) {
  const next = { ...structuredClone(document), revision: "" }
  if (!isWorkerRecords(next)) throw new TypeError("Invalid Worker records document")
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(stableString(next)))
  next.revision = [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("")
  return next
}
