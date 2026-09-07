import { emptyWorkerRecords, revisedWorkerRecords } from "../src/worker-records.mjs"
import { createWorkerService } from "../src/worker-service.mjs"

export const WORKER_FIXTURE_TIME = Date.parse("2026-09-01T12:00:00Z")
export const WORKER_FIXTURE_SECRET = "PRIVATE-PAYLOAD-MUST-NOT-ESCAPE"

export function workerFixture(options = {}) {
  let now = options.now || WORKER_FIXTURE_TIME
  const state = {
    crons: ["*/2 * * * *"],
    deployment: { id: "deployment-serving", created_on: "2026-09-01T10:00:00Z", versions: [{ version_id: "version-serving", percentage: 100 }] },
    handlers: ["fetch"],
    calls: [],
    logDenied: false,
    schedulesDenied: false,
    ...options,
  }
  const event = (key, type, outcome, version, offset, status) => ({
    $metadata: { id: key, type: "cf-worker-event" },
    $workers: { scriptName: "example-worker", requestId: key, eventType: type, outcome, scriptVersion: { id: version }, event: { response: { status }, request: { headers: { authorization: WORKER_FIXTURE_SECRET }, body: WORKER_FIXTURE_SECRET } } },
    timestamp: now - offset,
    source: { message: WORKER_FIXTURE_SECRET },
  })
  function events() {
    const http = event("http-ok", "fetch", "ok", "version-serving", 1000, 200)
    const cron = event("cron-error", "scheduled", "exception", "version-serving", 2000)
    return state.events || [http, cron, { ...cron, $metadata: { id: "console-error", type: "cf-worker-log", error: `Handler does not export a scheduled() function ${WORKER_FIXTURE_SECRET}` }, $workers: { ...cron.$workers, outcome: undefined } }, event("old-bootstrap", "fetch", "ok", "version-old", 3000, 503), http]
  }
  const api = {
    accountId: options.accountId || "example-account",
    executeOperation: (operation, options = {}) => api.request(operation.path, { method: operation.method, body: operation.body, ...options }),
    async request(path, request = {}) {
      state.calls.push({ path, ...request })
      request.signal?.throwIfAborted()
      const base = `accounts/${api.accountId}/workers/scripts/example-worker/`
      if (path === `${base}schedules`) {
        if (state.schedulesDenied) throw Object.assign(new Error(WORKER_FIXTURE_SECRET), { status: 403 })
        if (request.method === "PUT") {
          if (state.beforeWrite) await state.beforeWrite()
          if (state.writeFailure) throw new Error("Fixture schedule write failed")
          state.crons = request.body.map((entry) => entry.cron)
          if (state.afterWrite) state.afterWrite()
        }
        return { status: 200, result: { schedules: state.crons.map((cron) => ({ cron })) } }
      }
      if (path === `${base}deployments`) return { status: 200, result: { deployments: [state.deployment] } }
      if (path.startsWith(`${base}versions/`)) return { status: 200, result: { id: path.split("/").at(-1), resources: { script: { handlers: state.handlers }, bindings: [{ name: "DB", type: "d1", database_id: "example-database" }, { name: "SECRET", type: "secret_text", text: WORKER_FIXTURE_SECRET }, { name: "CONFIG", type: "plain_text", text: WORKER_FIXTURE_SECRET }] } } }
      if (path === `${base}subdomain`) return { status: 200, result: { enabled: true, previews_enabled: false } }
      if (path === `${base}script-settings`) return { status: 200, result: { observability: { enabled: true, head_sampling_rate: 1, logs: { invocation_logs: true } } } }
      if (path === `accounts/${api.accountId}/workers/domains`) return { status: 200, result: [{ service: "example-worker", hostname: "api.example.com", zone_id: "example-zone" }] }
      if (path === "zones/example-zone") return { status: 200, result: { account: { id: state.routeAccount || api.accountId } } }
      if (path === "zones/example-zone/workers/routes") return { status: 200, result: [{ id: "example-route", script: "example-worker", pattern: "example.com/api/*" }] }
      if (path === `accounts/${api.accountId}/workers/observability/telemetry/query`) {
        if (state.logDenied) throw Object.assign(new Error(WORKER_FIXTURE_SECRET), { status: 403 })
        const filtered = events().filter((entry) => entry.timestamp >= request.body.timeframe.from && entry.timestamp < request.body.timeframe.to)
        const cursor = request.body.offset
        const offset = cursor ? filtered.findIndex((entry) => entry.$metadata.id === cursor) + 1 : 0
        return { status: 200, result: { events: { events: filtered.slice(offset, offset + request.body.limit) } } }
      }
      throw Object.assign(new Error(`Unsupported fixture path: ${path}`), { status: 404 })
    },
  }
  let document = emptyWorkerRecords()
  let activity = { entries: [], revision: "" }
  let locked = false
  const store = {
    read: async () => structuredClone(document),
    async write(revision, next) {
      if (revision !== document.revision) throw new Error("Worker records revision changed")
      document = await revisedWorkerRecords(next)
      return structuredClone(document)
    },
  }
  const activityStore = {
    read: async () => structuredClone(activity),
    async append(entry) {
      if (state.journalFailure) throw new Error("Journal unavailable")
      activity = { revision: String(activity.entries.length + 1), entries: [...activity.entries, entry] }
      return structuredClone(activity)
    },
    async finalize(entry) {
      activity = { revision: String(Number(activity.revision) + 1), entries: activity.entries.map((e) => e.id === entry.id ? entry : e) }
      return structuredClone(activity)
    },
  }
  const withWriteLock = async (operation) => {
    if (locked) throw new Error("Fixture lock already held")
    locked = true
    try { return await operation() } finally { locked = false }
  }
  const service = createWorkerService({ api, store, activityStore, withWriteLock, now: () => now })
  return { api, state, store, service, activityStore, withWriteLock, event, advance: (milliseconds) => { now += milliseconds } }
}

export const disabledWorkerChange = Object.freeze({
  kind: "worker-schedules-update", worker: "example-worker",
  intent: { mode: "disabled", crons: [], owner: "example-project:wrangler.jsonc", reconciliation: "Set triggers.crons to [] in the production configuration before deployment" },
})
