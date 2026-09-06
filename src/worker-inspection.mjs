import { stableString } from "./normalize.mjs"
import { scheduleSet, workerPath, workerTriggerAssessment, WORKER_CRON_PATTERN, WORKER_CRON_MAX_LENGTH } from "./worker-triggers.mjs"

export const WORKER_INSPECTION_LIMITS = Object.freeze({
  defaultWindowMs: 60 * 60 * 1000,
  windowMs: 24 * 60 * 60 * 1000,
  events: 200,
  versions: 10,
  resources: 100,
  zones: 20,
})
const EVENT_TYPES = new Set(["fetch", "scheduled", "alarm", "queue", "email", "tail", "rpc", "jsrpc", "websocket", "workflow"])
const OUTCOMES = new Set(["ok", "exception", "canceled", "exceededCpu", "exceededMemory", "scriptNotFound", "unknown"])
const ID_PATTERN = /^[A-Za-z0-9_-]{1,256}$/
const INVOCATION_TYPE = "cf-worker-event"
const id = (value) => typeof value === "string" && ID_PATTERN.test(value) ? value : null

export function normalizeWorkerInspection(input, now = Date.now()) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError("Worker inspection input is required")
  const allowed = new Set(["worker", "findingId", "start", "end", "limit", "cursor", "zoneIds", "logs"])
  if (Object.keys(input).some((key) => !allowed.has(key))) throw new TypeError("Unknown Worker inspection field")
  const findingWorker = input.findingId?.match(/^deep\.worker-(?:scheduled-handler-missing|trigger-coverage-unknown):([a-z0-9_][a-z0-9_-]{0,127})$/)?.[1]
  if (input.findingId && !findingWorker) throw new TypeError("Unsupported Worker finding identifier")
  const worker = input.worker || findingWorker
  workerPath("account", worker, "schedules")
  if (findingWorker && worker !== findingWorker) throw new TypeError("Worker and finding identity do not match")
  const end = input.end === undefined ? now : Date.parse(input.end)
  const start = input.start === undefined ? end - WORKER_INSPECTION_LIMITS.defaultWindowMs : Date.parse(input.start)
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start >= end
    || end > now || end - start > WORKER_INSPECTION_LIMITS.windowMs) {
    throw new TypeError("Inspection requires a past window of at most 24 hours with start before end")
  }
  const limit = input.limit ?? 50
  if (!Number.isInteger(limit) || limit < 1 || limit > WORKER_INSPECTION_LIMITS.events) throw new TypeError("Evidence limit must be between 1 and 200")
  if (input.cursor && (!id(input.cursor) || !input.start || !input.end)) throw new TypeError("Pagination requires an opaque event cursor and the original start and end")
  const zoneIds = input.zoneIds || []
  if (!Array.isArray(zoneIds) || zoneIds.length > WORKER_INSPECTION_LIMITS.zones
    || zoneIds.some((zoneId) => !id(zoneId))) throw new TypeError("Invalid or excessive route zone identifiers")
  if (input.logs !== undefined && typeof input.logs !== "boolean") throw new TypeError("logs must be a boolean")
  return { worker, start: new Date(start).toISOString(), end: new Date(end).toISOString(), limit, cursor: input.cursor || null, zoneIds: [...new Set(zoneIds)], logs: input.logs !== false }
}

export async function observedRead(read, now = Date.now) {
  try {
    const value = await read()
    return { status: "observed", readAt: new Date(now()).toISOString(), value }
  } catch (error) {
    if (error?.name === "AbortError") throw error
    return {
      status: "unknown",
      readAt: new Date(now()).toISOString(),
      value: null,
      reason: [401, 403].includes(error?.status) ? "Access denied" : "Read failed or returned unsupported metadata",
      httpStatus: Number.isInteger(error?.status) ? error.status : null,
    }
  }
}

export function activeDeployment(result) {
  const deployments = result?.deployments
  if (!Array.isArray(deployments) || deployments.length === 0) throw new TypeError("No deployed version metadata")
  const sorted = [...deployments].sort((a, b) => Date.parse(b.created_on) - Date.parse(a.created_on))
  const active = sorted[0]
  if (!id(active.id) || !Number.isFinite(Date.parse(active.created_on))
    || !Array.isArray(active.versions) || active.versions.length === 0
    || active.versions.length > WORKER_INSPECTION_LIMITS.versions
    || active.versions.some((v) => !id(v.version_id) || !Number.isFinite(v.percentage) || v.percentage < 0 || v.percentage > 100)
    || Math.abs(active.versions.reduce((n, v) => n + v.percentage, 0) - 100) > 0.001) {
    throw new TypeError("Deployment metadata is incomplete")
  }
  return {
    id: active.id,
    createdOn: active.created_on,
    versions: active.versions.map((v) => ({ id: v.version_id, percentage: v.percentage })).sort((a, b) => a.id.localeCompare(b.id)),
  }
}

function bindingProjection(binding) {
  return { name: id(binding?.name), type: id(binding?.type) }
}

function resourceLinks(bindings) {
  const keys = { d1: "database_id", kv_namespace: "namespace_id", r2_bucket: "bucket_name", service: "service", durable_object_namespace: "script_name", queue: "queue_name", workflow: "workflow_name" }
  return bindings.flatMap((binding) => {
    const resource = id(binding[keys[binding.type]])
    return resource ? [{ binding: id(binding.name), type: binding.type, resource }] : []
  })
}

export async function readWorkerConfiguration(api, worker, options = {}) {
  const now = options.now || Date.now
  const read = (surface) => api.request(workerPath(api.accountId, worker, surface), { signal: options.signal })
  const [deployment, schedules, ingress, settings] = await Promise.all([
    observedRead(async () => activeDeployment((await read("deployments")).result), now),
    observedRead(async () => scheduleSet((await read("schedules")).result), now),
    observedRead(async () => {
      const value = (await read("subdomain")).result
      if (typeof value?.enabled !== "boolean") throw new TypeError("Missing endpoint metadata")
      return { workersDev: value.enabled, previews: typeof value.previews_enabled === "boolean" ? value.previews_enabled : null }
    }, now),
    observedRead(async () => {
      const logs = (await read("script-settings")).result?.observability
      return {
        enabled: typeof logs?.enabled === "boolean" ? logs.enabled : null,
        invocationLogs: typeof logs?.logs?.invocation_logs === "boolean" ? logs.logs.invocation_logs : null,
        headSamplingRate: typeof logs?.head_sampling_rate === "number" ? logs.head_sampling_rate : null,
      }
    }, now),
  ])
  const versions = deployment.value ? await Promise.all(deployment.value.versions.map(async (version) => ({
    ...version,
    ...await observedRead(async () => {
      const response = await api.request(`${workerPath(api.accountId, worker, "versions")}/${encodeURIComponent(version.id)}`, { signal: options.signal })
      const resources = response.result?.resources
      const handlers = resources?.script?.handlers
      if (!Array.isArray(handlers) || handlers.some((handler) => !id(handler))) throw new TypeError("Missing handler metadata")
      const bindings = Array.isArray(resources.bindings) ? resources.bindings : []
      return {
        handlers: [...handlers].sort(),
        bindings: bindings.slice(0, WORKER_INSPECTION_LIMITS.resources).map(bindingProjection),
        links: resourceLinks(bindings.slice(0, WORKER_INSPECTION_LIMITS.resources)),
        bindingsCoverage: Array.isArray(resources.bindings) ? "observed" : "unknown",
        bindingsLimited: bindings.length > WORKER_INSPECTION_LIMITS.resources,
      }
    }, now),
  }))) : []
  const serving = versions.filter((version) => version.percentage > 0)
  const handlers = serving.length && serving.every((version) => version.status === "observed")
    ? serving.reduce((common, version) => common.filter((handler) => version.value.handlers.includes(handler)), serving[0].value.handlers)
    : null
  const readAt = new Date(now()).toISOString()
  return {
    accountId: api.accountId,
    worker,
    readAt,
    deployment,
    versions,
    schedules,
    ingress,
    logging: settings,
    assessment: workerTriggerAssessment({ accountId: api.accountId, worker, handlers, schedules: schedules.value, readAt }),
  }
}

function errorSignature(event) {
  const text = [event?.$metadata?.error, event?.source?.message, event?.source?.error, event?.source].filter((value) => typeof value === "string").join(" ")
  if (/Handler does not export a scheduled\(\) function/.test(text)) return "missing-scheduled-handler"
  if (/Handler does not export a fetch\(\) function/.test(text)) return "missing-fetch-handler"
  return null
}

export function projectInvocationEvidence(events, input, deployment) {
  if (!Array.isArray(events)) throw new TypeError("Invocation events are unavailable")
  const invocations = new Map()
  const signatures = new Map()
  let ignored = 0
  for (const event of events.slice(0, input.limit)) {
    const workers = event?.$workers
    if (workers?.scriptName !== input.worker || !Number.isFinite(event.timestamp)
      || event.timestamp < Date.parse(input.start) || event.timestamp >= Date.parse(input.end)) { ignored += 1; continue }
    const signature = errorSignature(event)
    if (signature) signatures.set(signature, true)
    if (event.$metadata?.type !== INVOCATION_TYPE || !id(workers.requestId)) { ignored += 1; continue }
    const version = id(workers.scriptVersion?.id)
    const eventType = workers.eventType === "cron" ? "scheduled" : EVENT_TYPES.has(workers.eventType) ? workers.eventType : "unknown"
    const status = workers.event?.response?.status
    const cron = workers.event?.cron
    const serving = deployment?.versions.filter((v) => v.percentage > 0).map((v) => v.id)
    const invocation = {
      id: workers.requestId,
      timestamp: new Date(event.timestamp).toISOString(),
      eventType,
      outcome: OUTCOMES.has(workers.outcome) ? workers.outcome : "unknown",
      version,
      servingVersion: version && serving ? serving.includes(version) : null,
      httpStatus: eventType === "fetch" && Number.isInteger(status) && status >= 100 && status <= 599 ? status : null,
      cron: eventType === "scheduled" && typeof cron === "string" && cron.length <= WORKER_CRON_MAX_LENGTH && WORKER_CRON_PATTERN.test(cron) ? cron : null,
      truncated: workers.truncated === true,
    }
    invocations.set(`${workers.requestId}:${version}`, invocation)
  }
  const samples = [...invocations.values()]
  const groups = new Map()
  const http = new Map()
  for (const sample of samples) {
    const key = stableString([sample.eventType, sample.outcome, sample.version])
    if (!groups.has(key)) groups.set(key, { eventType: sample.eventType, outcome: sample.outcome, version: sample.version, servingVersion: sample.servingVersion, count: 0 })
    groups.get(key).count += 1
    if (sample.eventType === "fetch") {
      const statusKey = stableString([sample.httpStatus, sample.version])
      if (!http.has(statusKey)) http.set(statusKey, { status: sample.httpStatus, version: sample.version, servingVersion: sample.servingVersion, count: 0 })
      http.get(statusKey).count += 1
    }
  }
  return { invocations: samples.length, groups: [...groups.values()], httpStatuses: [...http.values()], samples, errorSignatures: [...signatures.keys()], ignoredRecords: ignored }
}

export async function inspectWorker(api, value, options = {}) {
  const now = options.now || Date.now
  const input = normalizeWorkerInspection(value, now())
  const config = await readWorkerConfiguration(api, input.worker, options)
  const domains = await observedRead(async () => {
    const response = await api.request(`accounts/${encodeURIComponent(api.accountId)}/workers/domains`, { signal: options.signal })
    if (!Array.isArray(response.result)) throw new TypeError("Missing custom domains")
    const matches = response.result.filter((entry) => entry.service === input.worker)
    return { items: matches.slice(0, WORKER_INSPECTION_LIMITS.resources).map((entry) => ({ hostname: String(entry.hostname).slice(0, 253), zoneId: id(entry.zone_id) })), limited: matches.length > WORKER_INSPECTION_LIMITS.resources, paginationIncomplete: response.resultInfo?.total_pages > 1 }
  }, now)
  const routes = await Promise.all(input.zoneIds.map(async (zoneId) => ({
    zoneId,
    ...await observedRead(async () => {
      const zone = await api.request(`zones/${encodeURIComponent(zoneId)}`, { signal: options.signal })
      if (zone.result?.account?.id !== api.accountId) throw new TypeError("Route zone is outside the configured account or ownership is unknown")
      const response = await api.request(`zones/${encodeURIComponent(zoneId)}/workers/routes`, { signal: options.signal })
      if (!Array.isArray(response.result)) throw new TypeError("Missing route metadata")
      const matches = response.result.filter((entry) => entry.script === input.worker)
      return { items: matches.slice(0, WORKER_INSPECTION_LIMITS.resources).map((entry) => ({ id: id(entry.id), pattern: String(entry.pattern).slice(0, 500) })), limited: matches.length > WORKER_INSPECTION_LIMITS.resources }
    }, now),
  })))
  const logs = input.logs ? await observedRead(async () => {
    const response = await api.request(`accounts/${encodeURIComponent(api.accountId)}/workers/observability/telemetry/query`, {
      method: "POST",
      signal: options.signal,
      body: {
        queryId: "fleet-worker-diagnostics",
        dry: true,
        view: "events",
        limit: input.limit,
        ...(input.cursor ? { offset: input.cursor, offsetDirection: "next" } : {}),
        timeframe: { from: Date.parse(input.start), to: Date.parse(input.end) },
        parameters: { filters: [{ key: "$workers.scriptName", operation: "eq", type: "string", value: input.worker }], filterCombination: "and" },
      },
    })
    const events = response.result?.events?.events
    const projected = projectInvocationEvidence(events, input, config.deployment.value)
    return {
      ...projected,
      nextCursor: events.length >= input.limit ? id(events[input.limit - 1]?.$metadata?.id) : null,
      limitReached: events.length >= input.limit,
    }
  }, now) : { status: "not-requested", value: null }
  return {
    schemaVersion: 1,
    status: "ok",
    ...config,
    selector: input,
    domains,
    routes,
    logs,
    summary: `${input.worker}: trigger compatibility ${config.assessment.status}; ${logs.value?.invocations ?? "unknown"} observed invocations on this evidence page`,
    limitations: [
      "Evidence counts cover this page only; invocation records are counted once and console records do not increase invocation totals",
      "Retention, sampling, disabled invocation logging, ingestion delay and query limits can omit events; absence of events does not establish health",
      "Serving-version labels compare with the configuration read; an old-version HTTP status does not establish a serving-version failure or prove bootstrap as its cause",
      "Handler compatibility requires every serving version to export the handler; per-version metadata identifies partial deployment mismatches",
      "Only fixed known error signatures are exposed; unrecognized error payloads are omitted, not guaranteed to be redactable",
      "Ingress covers custom domains, workers.dev and requested route zones; other Workers, Email, Queues and external callers are not exhaustively searched",
    ],
  }
}
