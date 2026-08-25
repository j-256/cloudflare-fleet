import {
  CloudflareApi,
} from "../api.mjs"
import {
  normalizeFleetPolicyConfiguration,
} from "../fleet-policy.mjs"
import {
  analyticsFailureObservation,
  catalogEndpointsForZone,
  MONITOR_ERROR_STATUSES,
  MONITOR_OBSERVATION_OUTCOME,
  MONITOR_RESOLUTION_REASON,
  MONITOR_SELECTION_REASON,
  MONITOR_TRANSITION,
  monitorProbeShard,
  normalizeHookrelayUrl,
  probeHttpObservation,
  probeNetworkObservation,
  selectMonitorEndpoints,
  signHookrelayPayload,
} from "../monitor.mjs"
import {
  beginHostedMonitorCatalogRefresh,
  commitHostedMonitorAnalytics,
  completeHostedMonitorCatalogRefresh,
  markHostedMonitorOutboxDelivered,
  markHostedMonitorOutboxFailed,
  persistHostedMonitorCatalogZone,
  persistHostedMonitorSelections,
  pruneHostedMonitorOutbox,
  readDueHostedMonitorOutbox,
  readHostedMonitorCatalogZoneEndpoints,
  readHostedMonitorMeta,
  readHostedMonitorRuntimeEndpoints,
  readHostedMonitorSelectedEndpoints,
  recordHostedMonitorObservation,
  suppressHostedMonitorIncidents,
} from "./monitor-store.mjs"
import {
  HOSTED_MONITOR_CRON,
  HOSTED_MONITOR_LANE,
  HOSTED_MONITOR_PROBE_SLOTS_PER_CYCLE,
  hostedMonitorSchedule,
} from "./monitor-schedule.mjs"

const ACTIVE_TRAFFIC_WINDOW_MS = 24 * 60 * 60 * 1000
const ANALYTICS_INITIAL_LOOKBACK_MS = 30 * 60 * 1000
const ANALYTICS_LAG_MS = 2 * 60 * 1000
const ANALYTICS_ROW_LIMIT = 5000
const CATALOG_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000
const EXTERNAL_SUBREQUEST_BUDGET = 45
const HOOKRELAY_CONTENT_TYPE = "application/cloudevents+json"
const HOOKRELAY_OUTBOX_BATCH_SIZE = 5
const HOOKRELAY_SIGNATURE_HEADER = "X-Hookrelay-Signature-256"
const MAX_PROBES_PER_RUN = 10
const MONITOR_LOG_COMPONENT = "cloudflare-fleet-endpoint-monitor"
const OUTBOX_RETENTION_MS = 30 * 24 * 60 * 60 * 1000
const PROBE_CONCURRENCY = 6
const PROBE_TIMEOUT_MS = 10000

const MONITOR_ANALYTICS_QUERY = `
  query FleetMonitor(
    $accountTag: string
    $activeStart: string
    $errorStart: string
    $end: string
  ) {
    viewer {
      accounts(filter: { accountTag: $accountTag }) {
        errors: httpRequestsAdaptiveGroups(
          limit: ${ANALYTICS_ROW_LIMIT}
          filter: {
            datetime_geq: $errorStart
            datetime_lt: $end
            edgeResponseStatus_in: [${MONITOR_ERROR_STATUSES.join(", ")}]
          }
        ) {
          count
          dimensions {
            clientRequestHTTPHost
            datetimeMinute
            edgeResponseStatus
            zoneTag
          }
        }
        active: httpRequestsAdaptiveGroups(
          limit: ${ANALYTICS_ROW_LIMIT}
          filter: {
            datetime_geq: $activeStart
            datetime_lt: $end
            edgeResponseStatus_geq: 200
            edgeResponseStatus_lt: 400
          }
        ) {
          count
          dimensions { clientRequestHTTPHost edgeResponseStatus zoneTag }
        }
      }
    }
  }
`

export class MonitorSubrequestBudgetError extends Error {
  constructor() {
    super("Monitor external subrequest budget is exhausted")
    this.name = "MonitorSubrequestBudgetError"
  }
}

export function createMonitorFetchBudget(
  fetchImpl,
  limit = EXTERNAL_SUBREQUEST_BUDGET,
) {
  if (typeof fetchImpl !== "function" || !Number.isInteger(limit) || limit < 1) {
    throw new TypeError("Monitor fetch budget input is invalid")
  }
  let used = 0
  return {
    fetch: async (...args) => {
      if (used >= limit) throw new MonitorSubrequestBudgetError()
      used += 1
      return fetchImpl(...args)
    },
    get remaining() {
      return Math.max(0, limit - used)
    },
    get used() {
      return used
    },
  }
}

function timestamp(value) {
  const date = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(date.getTime())) {
    throw new TypeError("Monitor time is invalid")
  }
  return date.toISOString()
}

function monitorClock(options) {
  if (typeof options.now === "function") return options.now
  if (options.now !== undefined) {
    const fixed = new Date(options.now)
    return () => new Date(fixed)
  }
  return () => new Date()
}

function fixedErrorCode(error, fallback) {
  if (error instanceof MonitorSubrequestBudgetError) return "subrequest-budget"
  return fallback
}

function monitorLog(logger, level, event, fields = {}) {
  logger[level]?.({
    component: MONITOR_LOG_COMPONENT,
    event,
    ...fields,
  })
}

function monitorPolicy(env) {
  let value
  try {
    value = env.FLEET_POLICY_JSON ? JSON.parse(env.FLEET_POLICY_JSON) : undefined
  } catch {
    throw new Error("Hosted Fleet policy configuration is not valid JSON")
  }
  return normalizeFleetPolicyConfiguration(value)
}

export function hostedMonitorIsEnabled(env) {
  if (env.FLEET_MONITOR_ENABLED === undefined
    || env.FLEET_MONITOR_ENABLED === "false") return false
  if (env.FLEET_MONITOR_ENABLED !== "true") {
    throw new Error("Hosted Fleet monitor binding is invalid")
  }
  return true
}

function assertHostedMonitorBindings(env) {
  if (!env.FLEET_DB || typeof env.FLEET_DB.prepare !== "function") {
    throw new Error("Hosted Fleet monitor D1 binding is unavailable")
  }
  if (typeof env.FLEET_ACCOUNT_ID !== "string" || !env.FLEET_ACCOUNT_ID) {
    throw new Error("Hosted Fleet monitor account binding is unavailable")
  }
  if (typeof env.CLOUDFLARE_API_TOKEN !== "string"
    || !env.CLOUDFLARE_API_TOKEN) {
    throw new Error("Hosted Fleet monitor API token is unavailable")
  }
  if (!env.FLEET_MONITOR_HOOKRELAY
    || typeof env.FLEET_MONITOR_HOOKRELAY.fetch !== "function") {
    throw new Error("Hosted Fleet monitor Hookrelay service binding is unavailable")
  }
  if (typeof env.FLEET_MONITOR_HOOKRELAY_HMAC !== "string"
    || !env.FLEET_MONITOR_HOOKRELAY_HMAC) {
    throw new Error("Hosted Fleet monitor Hookrelay HMAC is unavailable")
  }
  if (typeof env.FLEET_MONITOR_HOOKRELAY_URL !== "string") {
    throw new Error("Hosted Fleet monitor Hookrelay URL is unavailable")
  }
  return normalizeHookrelayUrl(env.FLEET_MONITOR_HOOKRELAY_URL)
}

function catalogRefreshIsOpen(meta) {
  const started = Date.parse(meta.catalogRefreshStartedAt)
  const completed = Date.parse(meta.catalogRefreshCompletedAt)
  return Number.isFinite(started)
    && (!Number.isFinite(completed) || started > completed)
}

function catalogIsReady(meta) {
  return Boolean(meta.catalogGeneration)
    && Boolean(meta.catalogRefreshCompletedAt)
}

function catalogRefreshIsDue(meta, nowMs) {
  if (catalogRefreshIsOpen(meta)) return true
  const completed = Date.parse(meta.catalogRefreshCompletedAt)
  return !Number.isFinite(completed)
    || nowMs - completed >= CATALOG_REFRESH_INTERVAL_MS
}

function analyticsWindow(meta, now) {
  const endMs = now.getTime() - ANALYTICS_LAG_MS
  const cursorMs = Date.parse(meta.analyticsCursorAt)
  const boundedCursor = Number.isFinite(cursorMs)
    ? Math.min(endMs, Math.max(endMs - ACTIVE_TRAFFIC_WINDOW_MS, cursorMs))
    : endMs - ANALYTICS_INITIAL_LOOKBACK_MS
  return {
    activeStart: new Date(endMs - ACTIVE_TRAFFIC_WINDOW_MS).toISOString(),
    end: new Date(endMs).toISOString(),
    errorStart: new Date(boundedCursor).toISOString(),
  }
}

async function readAnalytics(api, accountId, meta, now) {
  const window = analyticsWindow(meta, now)
  const data = await api.graphql(MONITOR_ANALYTICS_QUERY, {
    accountTag: accountId,
    ...window,
  })
  const account = data.viewer?.accounts?.[0]
  if (!Array.isArray(account?.errors) || !Array.isArray(account?.active)) {
    throw new TypeError("Expected Fleet monitor analytics rows")
  }
  return {
    active: account.active,
    end: window.end,
    errors: account.errors,
    truncated: account.active.length >= ANALYTICS_ROW_LIMIT
      || account.errors.length >= ANALYTICS_ROW_LIMIT,
  }
}

function selectedEndpointMap(endpoints) {
  return new Map(endpoints
    .filter((endpoint) => endpoint.selected)
    .map((endpoint) => [
      JSON.stringify([endpoint.zoneId, endpoint.hostname]),
      endpoint,
    ]))
}

function analyticsEntries(rows, endpoints) {
  const selected = selectedEndpointMap(endpoints)
  const collapsed = new Map()
  for (const row of rows) {
    const zoneId = String(row?.dimensions?.zoneTag || "")
    const hostname = String(row?.dimensions?.clientRequestHTTPHost || "")
      .trim()
      .toLowerCase()
      .replace(/\.$/, "")
    const key = JSON.stringify([zoneId, hostname])
    const endpoint = selected.get(key)
    if (!endpoint) continue
    const status = Number(row?.dimensions?.edgeResponseStatus)
    const requestCount = Number(row?.count)
    const observedAt = row?.dimensions?.datetimeMinute
    if (!MONITOR_ERROR_STATUSES.includes(status)
      || !Number.isFinite(requestCount)
      || requestCount <= 0
      || !Number.isFinite(Date.parse(observedAt))) continue
    const previous = collapsed.get(key)
    const latest = !previous
      || Date.parse(observedAt) >= Date.parse(previous.observedAt)
    collapsed.set(key, {
      endpoint,
      observedAt: latest ? observedAt : previous.observedAt,
      requestCount: requestCount + (previous?.requestCount || 0),
      status: latest ? status : previous.status,
    })
  }
  return [...collapsed.values()].map((entry) => ({
    endpoint: entry.endpoint,
    observation: analyticsFailureObservation({
      count: entry.requestCount,
      dimensions: {
        datetimeMinute: entry.observedAt,
        edgeResponseStatus: entry.status,
      },
    }),
  }))
}

function selectionChanges(previous, next) {
  return next.filter((endpoint, index) => (
    previous[index].selected !== endpoint.selected
    || previous[index].selectionReason !== endpoint.selectionReason
  ))
}

async function mapPool(entries, worker, concurrency) {
  const results = new Array(entries.length)
  let cursor = 0
  async function consume() {
    while (cursor < entries.length) {
      const index = cursor
      cursor += 1
      results[index] = await worker(entries[index], index)
    }
  }
  const consumers = await Promise.allSettled(
    Array.from({ length: Math.min(concurrency, entries.length) }, consume),
  )
  const failed = consumers.find((entry) => entry.status === "rejected")
  if (failed) throw failed.reason
  return results
}

async function probeEndpoint(fetchImpl, endpoint, observedAt) {
  try {
    const response = await fetchImpl(`https://${endpoint.hostname}/`, {
      headers: { Accept: "application/json" },
      method: "HEAD",
      redirect: "manual",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
    const observation = probeHttpObservation(response.status, observedAt)
    try {
      await response.body?.cancel()
    } catch {}
    return observation
  } catch (error) {
    if (error instanceof MonitorSubrequestBudgetError) throw error
    return probeNetworkObservation(
      error?.name === "TimeoutError" ? "timeout" : "network",
      observedAt,
    )
  }
}

function outboxRetryAt(attempts, attemptedAt) {
  const delaySeconds = Math.min(3600, 60 * (2 ** Math.min(attempts, 6)))
  return new Date(Date.parse(attemptedAt) + delaySeconds * 1000).toISOString()
}

async function deliverOutbox(env, hookrelayUrl, attemptedAt, logger) {
  const rows = await readDueHostedMonitorOutbox(
    env.FLEET_DB,
    env.FLEET_ACCOUNT_ID,
    attemptedAt,
    HOOKRELAY_OUTBOX_BATCH_SIZE,
  )
  let failed = 0
  for (const row of rows) {
    let errorCode = null
    try {
      const signature = await signHookrelayPayload(
        row.body,
        env.FLEET_MONITOR_HOOKRELAY_HMAC,
      )
      const response = await env.FLEET_MONITOR_HOOKRELAY.fetch(
        hookrelayUrl,
        {
          body: row.body,
          headers: {
            "Content-Type": HOOKRELAY_CONTENT_TYPE,
            [HOOKRELAY_SIGNATURE_HEADER]: `sha256=${signature}`,
          },
          method: "POST",
          redirect: "manual",
          signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        },
      )
      try {
        await response.body?.cancel()
      } catch {}
      if (response.ok) {
        await markHostedMonitorOutboxDelivered(
          env.FLEET_DB,
          env.FLEET_ACCOUNT_ID,
          row.id,
          attemptedAt,
        )
        continue
      }
      errorCode = `http-${response.status}`
    } catch (error) {
      errorCode = error?.name === "TimeoutError" ? "timeout" : "network"
    }
    failed += 1
    monitorLog(logger, "error", "delivery-failed", {
      errorCode,
      outboxId: row.id,
    })
    await markHostedMonitorOutboxFailed(
      env.FLEET_DB,
      env.FLEET_ACCOUNT_ID,
      row.id,
      attemptedAt,
      errorCode,
      outboxRetryAt(row.attempts, attemptedAt),
    )
  }
  return { attempted: rows.length, failed }
}

function monitorApi(env, budget, options) {
  return options.api || new CloudflareApi({
    accountId: env.FLEET_ACCOUNT_ID,
    apiToken: env.CLOUDFLARE_API_TOKEN,
    fetchImpl: budget.fetch,
  })
}

async function runProbeLane(context) {
  const {
    budget,
    env,
    hookrelayUrl,
    logger,
    probeSequence,
    randomId,
    startedAt,
  } = context
  const selected = await readHostedMonitorSelectedEndpoints(
    env.FLEET_DB,
    env.FLEET_ACCOUNT_ID,
  )
  const shard = monitorProbeShard(selected, startedAt, {
    baseShardCount: HOSTED_MONITOR_PROBE_SLOTS_PER_CYCLE,
    maximumPerShard: MAX_PROBES_PER_RUN,
    sequence: probeSequence,
  })
  let transitions = 0
  let stateChanges = 0
  await mapPool(shard.endpoints, async (endpoint) => {
    const observation = await probeEndpoint(
      budget.fetch,
      endpoint,
      startedAt,
    )
    if (observation.outcome === MONITOR_OBSERVATION_OUTCOME.FAILURE) {
      monitorLog(logger, "warn", "probe-failure", {
        errorCode: observation.errorCode,
        hostname: endpoint.hostname,
        httpStatus: observation.httpStatus,
        zoneName: endpoint.zoneName,
      })
    }
    const recorded = await recordHostedMonitorObservation(
      env.FLEET_DB,
      env.FLEET_ACCOUNT_ID,
      endpoint,
      observation,
      {
        endpoint,
        incidentId: randomId,
        recordedAt: startedAt,
      },
    )
    if (recorded.changed) stateChanges += 1
    if (recorded.changed && !recorded.transition) {
      monitorLog(logger, "info", "candidate-state-changed", {
        consecutiveFailures: recorded.state.consecutiveFailures,
        consecutiveSuccesses: recorded.state.consecutiveSuccesses,
        hostname: endpoint.hostname,
      })
    }
    if (recorded.transition) {
      transitions += 1
      const level = recorded.transition.kind === MONITOR_TRANSITION.OPENED
        ? "warn"
        : "info"
      monitorLog(logger, level, "incident-transition", {
        hostname: endpoint.hostname,
        incidentId: recorded.transition.incidentId,
        transition: recorded.transition.kind,
      })
    }
  }, PROBE_CONCURRENCY)
  const deliveries = transitions > 0
    ? await deliverOutbox(env, hookrelayUrl, startedAt, logger)
    : { attempted: 0, failed: 0 }
  return {
    deliveriesAttempted: deliveries.attempted,
    deliveryFailures: deliveries.failed,
    probes: shard.endpoints.length,
    selected: selected.length,
    shardCount: shard.shardCount,
    shardIndex: shard.shardIndex,
    stateChanges,
    transitions,
  }
}

async function runAnalyticsLane(context) {
  const {
    api,
    env,
    hookrelayUrl,
    logger,
    randomId,
    started,
    startedAt,
  } = context
  const meta = await readHostedMonitorMeta(
    env.FLEET_DB,
    env.FLEET_ACCOUNT_ID,
  )
  const [analytics, endpoints] = await Promise.all([
    readAnalytics(api, env.FLEET_ACCOUNT_ID, meta, started),
    readHostedMonitorRuntimeEndpoints(env.FLEET_DB, env.FLEET_ACCOUNT_ID),
  ])
  if (analytics.truncated) {
    throw new Error("Hosted Fleet monitor analytics result is truncated")
  }
  const selected = selectMonitorEndpoints(
    endpoints,
    analytics.active,
    monitorPolicy(env),
  )
  const changedSelections = selectionChanges(endpoints, selected)
  await persistHostedMonitorSelections(
    env.FLEET_DB,
    env.FLEET_ACCOUNT_ID,
    changedSelections,
    startedAt,
  )
  const excluded = selected.filter((endpoint) => (
    endpoint.selectionReason === MONITOR_SELECTION_REASON.EXCLUDED
    && endpoint.state.activeIncidentId
  ))
  const suppressed = await suppressHostedMonitorIncidents(
    env.FLEET_DB,
    env.FLEET_ACCOUNT_ID,
    excluded,
    startedAt,
    MONITOR_RESOLUTION_REASON.POLICY_EXCLUDED,
  )
  for (const entry of suppressed) {
    monitorLog(logger, "warn", "incident-suppressed", {
      hostname: entry.endpoint.hostname,
      incidentId: entry.incident.id,
      resolutionReason: entry.incident.resolutionReason,
    })
  }
  let analyticsObservations = 0
  let transitions = []
  if (catalogIsReady(meta)) {
    const entries = analyticsEntries(analytics.errors, selected)
    analyticsObservations = entries.length
    for (const entry of entries) {
      monitorLog(logger, "warn", "analytics-failure", {
        hostname: entry.endpoint.hostname,
        httpStatus: entry.observation.httpStatus,
        requestCount: entry.observation.requestCount,
        zoneName: entry.endpoint.zoneName,
      })
    }
    const committed = await commitHostedMonitorAnalytics(
      env.FLEET_DB,
      env.FLEET_ACCOUNT_ID,
      entries,
      analytics.end,
      startedAt,
      randomId,
    )
    transitions = committed.transitions
    for (const entry of transitions) {
      monitorLog(logger, "warn", "incident-transition", {
        hostname: entry.endpoint.hostname,
        incidentId: entry.incident.id,
        transition: entry.kind,
      })
    }
  }
  const deliveries = await deliverOutbox(
    env,
    hookrelayUrl,
    startedAt,
    logger,
  )
  return {
    analyticsObservations,
    catalogReady: catalogIsReady(meta),
    deliveriesAttempted: deliveries.attempted,
    deliveryFailures: deliveries.failed,
    selected: selected.filter((endpoint) => endpoint.selected).length,
    selectionChanges: changedSelections.length,
    suppressed: suppressed.length,
    transitions: transitions.length,
  }
}

function removedCatalogEndpoints(current, discovered) {
  const hostnames = new Set(discovered.map((endpoint) => endpoint.hostname))
  return current.filter((endpoint) => !hostnames.has(endpoint.hostname))
}

async function startCatalogRefresh(context) {
  const { api, env, randomId, startedAt } = context
  const zones = (await api.listZones())
    .filter((zone) => zone?.status === "active")
    .map((zone) => ({ id: zone.id, name: zone.name }))
    .sort((left, right) => left.name.localeCompare(right.name))
  await beginHostedMonitorCatalogRefresh(
    env.FLEET_DB,
    env.FLEET_ACCOUNT_ID,
    randomId(),
    zones,
    startedAt,
  )
  return { action: "started", changed: 0, suppressed: 0, zones: zones.length }
}

async function refreshCatalogZone(context, meta) {
  const { api, env, logger, startedAt } = context
  const zone = meta.catalogZones[meta.catalogZoneCursor]
  const [records, current] = await Promise.all([
    api.list(`zones/${encodeURIComponent(zone.id)}/dns_records`, {
      perPage: 5000,
    }),
    readHostedMonitorCatalogZoneEndpoints(
      env.FLEET_DB,
      env.FLEET_ACCOUNT_ID,
      zone.id,
    ),
  ])
  const discovered = catalogEndpointsForZone(
    zone,
    records,
    meta.catalogGeneration,
    startedAt,
  )
  const removed = removedCatalogEndpoints(current, discovered)
  const suppressed = await suppressHostedMonitorIncidents(
    env.FLEET_DB,
    env.FLEET_ACCOUNT_ID,
    removed,
    startedAt,
    MONITOR_RESOLUTION_REASON.CATALOG_REMOVED,
  )
  const persisted = await persistHostedMonitorCatalogZone(
    env.FLEET_DB,
    env.FLEET_ACCOUNT_ID,
    meta.catalogGeneration,
    discovered,
    meta.catalogZoneCursor + 1,
    startedAt,
    zone.id,
    removed.map((endpoint) => endpoint.hostname),
  )
  for (const entry of suppressed) {
    monitorLog(logger, "warn", "incident-suppressed", {
      hostname: entry.endpoint.hostname,
      incidentId: entry.incident.id,
      resolutionReason: entry.incident.resolutionReason,
    })
  }
  if (persisted.changed > 0) {
    monitorLog(logger, "info", "catalog-zone-changed", {
      changed: persisted.changed,
      zoneName: zone.name,
    })
  }
  return {
    action: "zone-refreshed",
    changed: persisted.changed,
    suppressed: suppressed.length,
    zoneName: zone.name,
    zones: meta.catalogZones.length,
  }
}

async function completeCatalogRefresh(context, meta) {
  const { env, logger, started, startedAt } = context
  const activeZoneIds = meta.catalogZones.map((zone) => zone.id)
  const activeZoneSet = new Set(activeZoneIds)
  const current = await readHostedMonitorRuntimeEndpoints(
    env.FLEET_DB,
    env.FLEET_ACCOUNT_ID,
  )
  const removed = current.filter((endpoint) => !activeZoneSet.has(endpoint.zoneId))
  const suppressed = await suppressHostedMonitorIncidents(
    env.FLEET_DB,
    env.FLEET_ACCOUNT_ID,
    removed,
    startedAt,
    MONITOR_RESOLUTION_REASON.CATALOG_REMOVED,
  )
  const completed = await completeHostedMonitorCatalogRefresh(
    env.FLEET_DB,
    env.FLEET_ACCOUNT_ID,
    meta.catalogGeneration,
    startedAt,
    removed,
  )
  const pruned = await pruneHostedMonitorOutbox(
    env.FLEET_DB,
    env.FLEET_ACCOUNT_ID,
    new Date(started.getTime() - OUTBOX_RETENTION_MS).toISOString(),
  )
  for (const entry of suppressed) {
    monitorLog(logger, "warn", "incident-suppressed", {
      hostname: entry.endpoint.hostname,
      incidentId: entry.incident.id,
      resolutionReason: entry.incident.resolutionReason,
    })
  }
  return {
    action: "completed",
    changed: completed.changed,
    pruned,
    suppressed: suppressed.length,
    zones: meta.catalogZones.length,
  }
}

async function runMaintenanceLane(context) {
  const {
    env,
    hookrelayUrl,
    logger,
    started,
    startedAt,
  } = context
  const meta = await readHostedMonitorMeta(
    env.FLEET_DB,
    env.FLEET_ACCOUNT_ID,
  )
  let catalog = { action: "idle", changed: 0, suppressed: 0, zones: 0 }
  if (catalogRefreshIsDue(meta, started.getTime())) {
    if (!catalogRefreshIsOpen(meta)) {
      catalog = await startCatalogRefresh(context)
    } else if (meta.catalogZoneCursor < meta.catalogZones.length) {
      catalog = await refreshCatalogZone(context, meta)
    } else {
      catalog = await completeCatalogRefresh(context, meta)
    }
  }
  const deliveries = await deliverOutbox(
    env,
    hookrelayUrl,
    startedAt,
    logger,
  )
  return {
    catalog,
    deliveriesAttempted: deliveries.attempted,
    deliveryFailures: deliveries.failed,
  }
}

export async function runHostedFleetMonitor(env, options = {}) {
  if (!hostedMonitorIsEnabled(env)) return { enabled: false, skipped: true }
  const hookrelayUrl = assertHostedMonitorBindings(env)
  const clock = monitorClock(options)
  const started = clock()
  const startedAt = timestamp(started)
  const cron = options.cron || HOSTED_MONITOR_CRON
  const schedule = hostedMonitorSchedule(cron, startedAt)
  const lane = schedule.lane
  const logger = options.logger || console
  const budget = createMonitorFetchBudget(
    options.fetchImpl || globalThis.fetch,
    options.subrequestBudget || EXTERNAL_SUBREQUEST_BUDGET,
  )
  const context = {
    api: monitorApi(env, budget, options),
    budget,
    env,
    hookrelayUrl,
    logger,
    probeSequence: schedule.probeSequence,
    randomId: options.randomId || (() => crypto.randomUUID()),
    started,
    startedAt,
  }
  try {
    let result
    if (lane === HOSTED_MONITOR_LANE.PROBE) {
      result = await runProbeLane(context)
    } else if (lane === HOSTED_MONITOR_LANE.ANALYTICS) {
      result = await runAnalyticsLane(context)
    } else {
      result = await runMaintenanceLane(context)
    }
    const summary = {
      enabled: true,
      cycleIndex: schedule.cycleIndex,
      lane,
      skipped: false,
      subrequests: budget.used,
      ...result,
    }
    monitorLog(logger, "info", "lane-completed", summary)
    return summary
  } catch (error) {
    monitorLog(logger, "error", "lane-failed", {
      errorCode: fixedErrorCode(error, `${lane}-failed`),
      lane,
      subrequests: budget.used,
    })
    throw error
  }
}
