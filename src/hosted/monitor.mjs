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
  normalizeHookrelayUrl,
  probeHttpObservation,
  probeNetworkObservation,
  selectMonitorEndpoints,
  signHookrelayPayload,
} from "../monitor.mjs"
import {
  acquireHostedMonitorLease,
  beginHostedMonitorCatalogRefresh,
  completeHostedMonitorCatalogRefresh,
  finishHostedMonitorRun,
  ingestHostedMonitorAnalytics,
  markHostedMonitorOutboxDelivered,
  markHostedMonitorOutboxFailed,
  MONITOR_RUN_STATUS,
  persistHostedMonitorCatalogZone,
  persistHostedMonitorSelections,
  pruneHostedMonitorState,
  readDueHostedMonitorEndpoints,
  readDueHostedMonitorOutbox,
  readHostedMonitorCatalogEndpoints,
  readHostedMonitorMeta,
  readPendingHostedMonitorAnalytics,
  recordHostedMonitorObservation,
  releaseHostedMonitorLease,
  startHostedMonitorRun,
  updateHostedMonitorAnalyticsCursor,
} from "./monitor-store.mjs"

const ACTIVE_TRAFFIC_WINDOW_MS = 24 * 60 * 60 * 1000
const ANALYTICS_INITIAL_LOOKBACK_MS = 30 * 60 * 1000
const ANALYTICS_LAG_MS = 2 * 60 * 1000
const ANALYTICS_OVERLAP_MS = 5 * 60 * 1000
const ANALYTICS_ROW_LIMIT = 5000
const CATALOG_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000
const CATALOG_ZONE_BATCH_SIZE = 8
const EXTERNAL_SUBREQUEST_BUDGET = 45
const HOOKRELAY_CONTENT_TYPE = "application/cloudevents+json"
const HOOKRELAY_OUTBOX_BATCH_SIZE = 5
const HOOKRELAY_SIGNATURE_HEADER = "X-Hookrelay-Signature-256"
const MAX_ANALYTICS_OBSERVATIONS_PER_RUN = 1000
const MAX_PROBES_PER_RUN = 35
const MONITOR_LEASE_MS = 4 * 60 * 1000
const OBSERVATION_RETENTION_MS = 2 * 24 * 60 * 60 * 1000
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
          }
        ) {
          count
          dimensions { clientRequestHTTPHost zoneTag }
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

export function createMonitorFetchBudget(fetchImpl, limit = EXTERNAL_SUBREQUEST_BUDGET) {
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

function timestamp(date) {
  const value = date instanceof Date ? date : new Date(date)
  if (!Number.isFinite(value.getTime())) throw new TypeError("Monitor time is invalid")
  return value.toISOString()
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
  if (typeof env.CLOUDFLARE_API_TOKEN !== "string" || !env.CLOUDFLARE_API_TOKEN) {
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

function catalogRefreshInProgress(meta) {
  return meta.catalogZones.length > meta.catalogZoneCursor
}

function catalogIsReady(meta) {
  return Boolean(meta.catalogGeneration)
    && Boolean(meta.catalogRefreshCompletedAt)
    && !catalogRefreshInProgress(meta)
}

function catalogRefreshIsDue(meta, nowMs) {
  if (catalogRefreshInProgress(meta)) return true
  const completedMs = Date.parse(meta.catalogRefreshCompletedAt)
  return !Number.isFinite(completedMs)
    || nowMs - completedMs >= CATALOG_REFRESH_INTERVAL_MS
}

async function refreshCatalog(api, db, accountId, meta, now, randomId) {
  let activeMeta = meta
  if (!catalogRefreshInProgress(activeMeta)) {
    if (!catalogRefreshIsDue(activeMeta, now.getTime())) {
      return { attempted: false, completed: true }
    }
    const zones = (await api.listZones())
      .filter((zone) => zone?.status === "active")
      .map((zone) => ({ id: zone.id, name: zone.name }))
      .sort((left, right) => left.name.localeCompare(right.name))
    activeMeta = await beginHostedMonitorCatalogRefresh(
      db,
      accountId,
      randomId(),
      zones,
      timestamp(now),
    )
  }
  const generation = activeMeta.catalogGeneration
  const end = Math.min(
    activeMeta.catalogZones.length,
    activeMeta.catalogZoneCursor + CATALOG_ZONE_BATCH_SIZE,
  )
  for (let index = activeMeta.catalogZoneCursor; index < end; index += 1) {
    const zone = activeMeta.catalogZones[index]
    const records = await api.list(
      `zones/${encodeURIComponent(zone.id)}/dns_records`,
      { perPage: 5000 },
    )
    const discoveredAt = timestamp(now)
    await persistHostedMonitorCatalogZone(
      db,
      accountId,
      generation,
      catalogEndpointsForZone(zone, records, generation, discoveredAt),
      index + 1,
      discoveredAt,
    )
  }
  const completed = end >= activeMeta.catalogZones.length
  if (completed) {
    await completeHostedMonitorCatalogRefresh(
      db,
      accountId,
      generation,
      timestamp(now),
    )
  }
  return { attempted: true, completed }
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
    errorStart: new Date(Math.max(
      endMs - ACTIVE_TRAFFIC_WINDOW_MS,
      boundedCursor - ANALYTICS_OVERLAP_MS,
    )).toISOString(),
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

function analyticsForSelectedEndpoints(rows, endpoints) {
  const selected = selectedEndpointMap(endpoints)
  return rows.flatMap((row) => {
    const zoneId = String(row?.dimensions?.zoneTag || "")
    const hostname = String(row?.dimensions?.clientRequestHTTPHost || "")
      .trim()
      .toLowerCase()
      .replace(/\.$/, "")
    const endpoint = selected.get(JSON.stringify([zoneId, hostname]))
    if (!endpoint) return []
    const status = Number(row?.dimensions?.edgeResponseStatus)
    const requestCount = Number(row?.count)
    const observedMinute = row?.dimensions?.datetimeMinute
    if (!MONITOR_ERROR_STATUSES.includes(status)
      || !Number.isFinite(requestCount)
      || requestCount <= 0
      || !Number.isFinite(Date.parse(observedMinute))) return []
    return [{
      hostname,
      observedMinute: new Date(observedMinute).toISOString(),
      requestCount,
      status,
      zoneId,
    }]
  })
}

async function processPendingAnalytics(db, accountId, recordedAt, randomId) {
  const rows = await readPendingHostedMonitorAnalytics(
    db,
    accountId,
    MAX_ANALYTICS_OBSERVATIONS_PER_RUN,
  )
  for (const row of rows) {
    const observation = analyticsFailureObservation({
      count: row.requestCount,
      dimensions: {
        datetimeMinute: row.observedMinute,
        edgeResponseStatus: row.status,
      },
    })
    await recordHostedMonitorObservation(
      db,
      accountId,
      row,
      observation,
      {
        analyticsKey: row,
        incidentId: randomId(),
        recordedAt,
      },
    )
  }
  return rows.length
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

async function probeEndpoints(
  db,
  accountId,
  budget,
  observedAt,
  randomId,
) {
  const limit = Math.min(
    MAX_PROBES_PER_RUN,
    budget.remaining,
  )
  if (limit === 0) return 0
  const endpoints = await readDueHostedMonitorEndpoints(db, accountId, limit)
  await mapPool(endpoints, async (endpoint) => {
    const observation = await probeEndpoint(budget.fetch, endpoint, observedAt)
    await recordHostedMonitorObservation(
      db,
      accountId,
      endpoint,
      observation,
      { incidentId: randomId(), recordedAt: observedAt },
    )
  }, PROBE_CONCURRENCY)
  return endpoints.length
}

function outboxRetryAt(attempts, attemptedAt) {
  const delaySeconds = Math.min(3600, 60 * (2 ** Math.min(attempts, 6)))
  return new Date(Date.parse(attemptedAt) + delaySeconds * 1000).toISOString()
}

async function deliverOutbox(
  db,
  accountId,
  fetchImpl,
  hookrelayUrl,
  hookrelayHmac,
  attemptedAt,
) {
  const rows = await readDueHostedMonitorOutbox(
    db,
    accountId,
    attemptedAt,
    HOOKRELAY_OUTBOX_BATCH_SIZE,
  )
  let failed = 0
  for (const row of rows) {
    let errorCode = null
    try {
      const signature = await signHookrelayPayload(row.body, hookrelayHmac)
      const response = await fetchImpl(hookrelayUrl, {
        body: row.body,
        headers: {
          "Content-Type": HOOKRELAY_CONTENT_TYPE,
          [HOOKRELAY_SIGNATURE_HEADER]: `sha256=${signature}`,
        },
        method: "POST",
        redirect: "manual",
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      })
      try {
        await response.body?.cancel()
      } catch {}
      if (response.ok) {
        await markHostedMonitorOutboxDelivered(
          db,
          accountId,
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
    await markHostedMonitorOutboxFailed(
      db,
      accountId,
      row.id,
      attemptedAt,
      errorCode,
      outboxRetryAt(row.attempts, attemptedAt),
    )
  }
  return { attempted: rows.length, failed }
}

function previousTrafficRows(endpoints) {
  return endpoints
    .filter((endpoint) => endpoint.requestCount > 0)
    .map((endpoint) => ({
      count: endpoint.requestCount,
      dimensions: {
        clientRequestHTTPHost: endpoint.hostname,
        zoneTag: endpoint.zoneId,
      },
    }))
}

export async function runHostedFleetMonitor(env, options = {}) {
  if (!hostedMonitorIsEnabled(env)) return { enabled: false, skipped: true }
  const hookrelayUrl = assertHostedMonitorBindings(env)
  const clock = monitorClock(options)
  const started = clock()
  const startedAt = timestamp(started)
  const randomId = options.randomId || (() => crypto.randomUUID())
  const logger = options.logger || console
  const budget = createMonitorFetchBudget(
    options.fetchImpl || globalThis.fetch,
    options.subrequestBudget || EXTERNAL_SUBREQUEST_BUDGET,
  )
  const api = options.api || new CloudflareApi({
    accountId: env.FLEET_ACCOUNT_ID,
    apiToken: env.CLOUDFLARE_API_TOKEN,
    fetchImpl: budget.fetch,
  })
  const leaseToken = randomId()
  const leaseUntil = new Date(started.getTime() + MONITOR_LEASE_MS).toISOString()
  const acquired = await acquireHostedMonitorLease(
    env.FLEET_DB,
    env.FLEET_ACCOUNT_ID,
    leaseToken,
    startedAt,
    leaseUntil,
  )
  if (!acquired) return { enabled: true, skipped: true }
  const errorCodes = []
  const result = {
    analyticsObservations: 0,
    catalogCompleted: false,
    deliveriesAttempted: 0,
    enabled: true,
    probes: 0,
    skipped: false,
  }
  try {
    await startHostedMonitorRun(env.FLEET_DB, env.FLEET_ACCOUNT_ID, startedAt)
    let meta = await readHostedMonitorMeta(env.FLEET_DB, env.FLEET_ACCOUNT_ID)
    try {
      const catalog = await refreshCatalog(
        api,
        env.FLEET_DB,
        env.FLEET_ACCOUNT_ID,
        meta,
        started,
        randomId,
      )
      result.catalogCompleted = catalog.completed
    } catch (error) {
      const code = fixedErrorCode(error, "catalog-read")
      errorCodes.push(code)
      logger.warn?.(`Cloudflare Fleet monitor degraded: ${code}`)
    }
    meta = await readHostedMonitorMeta(env.FLEET_DB, env.FLEET_ACCOUNT_ID)
    let analytics = null
    try {
      analytics = await readAnalytics(
        api,
        env.FLEET_ACCOUNT_ID,
        meta,
        started,
      )
      if (analytics.truncated) {
        errorCodes.push("analytics-truncated")
        logger.warn?.("Cloudflare Fleet monitor degraded: analytics-truncated")
      }
    } catch (error) {
      const code = fixedErrorCode(error, "analytics-read")
      errorCodes.push(code)
      logger.warn?.(`Cloudflare Fleet monitor degraded: ${code}`)
    }
    let endpoints = await readHostedMonitorCatalogEndpoints(
      env.FLEET_DB,
      env.FLEET_ACCOUNT_ID,
    )
    const policy = monitorPolicy(env)
    const selections = selectMonitorEndpoints(
      endpoints,
      analytics && !analytics.truncated
        ? analytics.active
        : previousTrafficRows(endpoints),
      policy,
    )
    await persistHostedMonitorSelections(
      env.FLEET_DB,
      env.FLEET_ACCOUNT_ID,
      selections,
      startedAt,
    )
    endpoints = selections
    if (analytics) {
      const observations = analyticsForSelectedEndpoints(
        analytics.errors,
        endpoints,
      )
      await ingestHostedMonitorAnalytics(
        env.FLEET_DB,
        env.FLEET_ACCOUNT_ID,
        observations,
        startedAt,
      )
      result.analyticsObservations = await processPendingAnalytics(
        env.FLEET_DB,
        env.FLEET_ACCOUNT_ID,
        startedAt,
        randomId,
      )
      if (!analytics.truncated && catalogIsReady(meta)) {
        await updateHostedMonitorAnalyticsCursor(
          env.FLEET_DB,
          env.FLEET_ACCOUNT_ID,
          analytics.end,
        )
      }
    }
    result.probes = await probeEndpoints(
      env.FLEET_DB,
      env.FLEET_ACCOUNT_ID,
      budget,
      startedAt,
      randomId,
    )
    const deliveries = await deliverOutbox(
      env.FLEET_DB,
      env.FLEET_ACCOUNT_ID,
      (input, init) => env.FLEET_MONITOR_HOOKRELAY.fetch(input, init),
      hookrelayUrl,
      env.FLEET_MONITOR_HOOKRELAY_HMAC,
      startedAt,
    )
    result.deliveriesAttempted = deliveries.attempted
    if (deliveries.failed > 0) errorCodes.push("hookrelay-delivery")
    await pruneHostedMonitorState(
      env.FLEET_DB,
      env.FLEET_ACCOUNT_ID,
      new Date(started.getTime() - OBSERVATION_RETENTION_MS).toISOString(),
      new Date(started.getTime() - OUTBOX_RETENTION_MS).toISOString(),
    )
    const completedAt = timestamp(clock())
    await finishHostedMonitorRun(
      env.FLEET_DB,
      env.FLEET_ACCOUNT_ID,
      completedAt,
      errorCodes.length > 0
        ? MONITOR_RUN_STATUS.DEGRADED
        : MONITOR_RUN_STATUS.HEALTHY,
      errorCodes.length > 0 ? [...new Set(errorCodes)].sort().join(",") : null,
    )
    return {
      ...result,
      errors: [...new Set(errorCodes)].sort(),
      subrequests: budget.used,
    }
  } catch (error) {
    try {
      await finishHostedMonitorRun(
        env.FLEET_DB,
        env.FLEET_ACCOUNT_ID,
        timestamp(clock()),
        MONITOR_RUN_STATUS.FAILED,
        fixedErrorCode(error, "monitor-run"),
      )
    } catch {}
    logger.error?.("Cloudflare Fleet monitor failed: monitor-run")
    throw error
  } finally {
    try {
      await releaseHostedMonitorLease(
        env.FLEET_DB,
        env.FLEET_ACCOUNT_ID,
        leaseToken,
      )
    } catch {}
  }
}
