export const MONITOR_ACTIVE_REQUEST_MINIMUM = 100
export const MONITOR_CONSECUTIVE_FAILURES = 2
export const MONITOR_CONSECUTIVE_SUCCESSES = 2
export const MONITOR_ERROR_STATUSES = Object.freeze([
  520,
  521,
  522,
  523,
  524,
  525,
  526,
  530,
])
export const MONITOR_EVENT_SOURCE = "urn:cloudflare-fleet:monitor"
export const MONITOR_EVENT_TYPE = Object.freeze({
  PROBLEM: "urn:cloudflare-fleet:endpoint:problem:v1",
  RECOVERED: "urn:cloudflare-fleet:endpoint:recovered:v1",
})
export const MONITOR_FAILURE_KIND = Object.freeze({
  HTTP: "http",
  NETWORK: "network",
})
export const MONITOR_OBSERVATION_OUTCOME = Object.freeze({
  FAILURE: "failure",
  SUCCESS: "success",
})
export const MONITOR_OBSERVATION_SOURCE = Object.freeze({
  ANALYTICS: "analytics",
  PROBE: "probe",
})
export const MONITOR_SELECTION_REASON = Object.freeze({
  ACTIVE_TRAFFIC: "active-traffic",
  EXCLUDED: "excluded",
  INCLUDED: "included",
  INACTIVE: "inactive",
  OPEN_INCIDENT: "open-incident",
  ZONE_APEX: "zone-apex",
})
export const MONITOR_TRANSITION = Object.freeze({
  OPENED: "opened",
  RESOLVED: "resolved",
})

const MONITORED_DNS_RECORD_TYPES = new Set(["A", "AAAA", "CNAME"])
const MONITOR_ERROR_STATUS_SET = new Set(MONITOR_ERROR_STATUSES)
const HOOKRELAY_SLUG_PATTERN = /^[A-Za-z0-9_-]{22,}$/

function requiredTimestamp(value, label) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new TypeError(`${label} must be a timestamp`)
  }
  return new Date(value).toISOString()
}

function normalizedHostname(value) {
  if (typeof value !== "string") return ""
  return value.trim().toLowerCase().replace(/\.$/, "")
}

export function catalogEndpointsForZone(zone, records, generation, discoveredAt) {
  if (!zone?.id || !zone?.name || !Array.isArray(records) || !generation) {
    throw new TypeError("Monitor catalog input is incomplete")
  }
  const timestamp = requiredTimestamp(discoveredAt, "Catalog discovery time")
  const byHostname = new Map()
  for (const record of records) {
    const recordType = String(record?.type || "").toUpperCase()
    const hostname = normalizedHostname(record?.name)
    if (!record?.proxied
      || !MONITORED_DNS_RECORD_TYPES.has(recordType)
      || !hostname
      || hostname.startsWith("_")
      || hostname.includes("*")) continue
    if (!byHostname.has(hostname)) byHostname.set(hostname, new Set())
    byHostname.get(hostname).add(recordType)
  }
  return [...byHostname.entries()]
    .map(([hostname, recordTypes]) => ({
      catalogGeneration: generation,
      discoveredAt: timestamp,
      hostname,
      recordTypes: [...recordTypes].sort(),
      zoneId: zone.id,
      zoneName: normalizedHostname(zone.name),
    }))
    .sort((left, right) => left.hostname.localeCompare(right.hostname))
}

function trafficCounts(rows) {
  const counts = new Map()
  for (const row of rows || []) {
    const hostname = normalizedHostname(row?.dimensions?.clientRequestHTTPHost)
    const zoneId = String(row?.dimensions?.zoneTag || "")
    const count = Number(row?.count)
    if (!hostname || !zoneId || !Number.isFinite(count) || count < 0) continue
    const key = JSON.stringify([zoneId, hostname])
    counts.set(key, (counts.get(key) || 0) + count)
  }
  return counts
}

export function selectMonitorEndpoints(endpoints, trafficRows, policy) {
  if (!Array.isArray(endpoints)) throw new TypeError("Monitor endpoints must be an array")
  const monitoring = policy?.endpointMonitoring || {}
  const excluded = new Set(monitoring.excludeHostnames || [])
  const included = new Set(monitoring.includeHostnames || [])
  const counts = trafficCounts(trafficRows)
  return endpoints.map((endpoint) => {
    const hostname = normalizedHostname(endpoint.hostname)
    const zoneName = normalizedHostname(endpoint.zoneName)
    const requestCount = counts.get(JSON.stringify([endpoint.zoneId, hostname])) || 0
    let selectionReason = MONITOR_SELECTION_REASON.INACTIVE
    let selected = false
    if (excluded.has(hostname)) {
      selectionReason = MONITOR_SELECTION_REASON.EXCLUDED
    } else if (endpoint.state?.activeIncidentId) {
      selectionReason = MONITOR_SELECTION_REASON.OPEN_INCIDENT
      selected = true
    } else if (included.has(hostname)) {
      selectionReason = MONITOR_SELECTION_REASON.INCLUDED
      selected = true
    } else if (hostname === zoneName) {
      selectionReason = MONITOR_SELECTION_REASON.ZONE_APEX
      selected = true
    } else if (requestCount >= MONITOR_ACTIVE_REQUEST_MINIMUM) {
      selectionReason = MONITOR_SELECTION_REASON.ACTIVE_TRAFFIC
      selected = true
    }
    return {
      ...endpoint,
      requestCount,
      selected,
      selectionReason,
    }
  })
}

export function createEmptyMonitorEndpointState() {
  return {
    activeIncidentId: null,
    consecutiveFailures: 0,
    consecutiveSuccesses: 0,
    lastFailureAt: null,
    lastFailureKind: null,
    lastFailureStatus: null,
    lastObservationAt: null,
    lastProbeAt: null,
    lastProbeErrorCode: null,
    lastProbeStatus: null,
  }
}

export function analyticsFailureObservation(row) {
  const status = Number(row?.dimensions?.edgeResponseStatus)
  if (!MONITOR_ERROR_STATUS_SET.has(status)) {
    throw new TypeError("Analytics observation status is not monitored")
  }
  const observedAt = requiredTimestamp(
    row?.dimensions?.datetimeMinute,
    "Analytics observation time",
  )
  const requestCount = Number(row?.count)
  if (!Number.isFinite(requestCount) || requestCount <= 0) {
    throw new TypeError("Analytics observation count must be positive")
  }
  return Object.freeze({
    errorCode: null,
    failureKind: MONITOR_FAILURE_KIND.HTTP,
    httpStatus: status,
    immediate: true,
    observedAt,
    outcome: MONITOR_OBSERVATION_OUTCOME.FAILURE,
    requestCount,
    source: MONITOR_OBSERVATION_SOURCE.ANALYTICS,
  })
}

export function probeHttpObservation(status, observedAt) {
  if (!Number.isInteger(status) || status < 100 || status > 599) {
    throw new TypeError("Probe HTTP status is invalid")
  }
  const timestamp = requiredTimestamp(observedAt, "Probe observation time")
  if (status < 500) {
    return Object.freeze({
      errorCode: null,
      failureKind: null,
      httpStatus: status,
      immediate: false,
      observedAt: timestamp,
      outcome: MONITOR_OBSERVATION_OUTCOME.SUCCESS,
      requestCount: null,
      source: MONITOR_OBSERVATION_SOURCE.PROBE,
    })
  }
  return Object.freeze({
    errorCode: null,
    failureKind: MONITOR_FAILURE_KIND.HTTP,
    httpStatus: status,
    immediate: MONITOR_ERROR_STATUS_SET.has(status),
    observedAt: timestamp,
    outcome: MONITOR_OBSERVATION_OUTCOME.FAILURE,
    requestCount: null,
    source: MONITOR_OBSERVATION_SOURCE.PROBE,
  })
}

export function probeNetworkObservation(errorCode, observedAt) {
  if (typeof errorCode !== "string" || !/^[a-z][a-z0-9-]*$/.test(errorCode)) {
    throw new TypeError("Probe error code is invalid")
  }
  return Object.freeze({
    errorCode,
    failureKind: MONITOR_FAILURE_KIND.NETWORK,
    httpStatus: null,
    immediate: false,
    observedAt: requiredTimestamp(observedAt, "Probe observation time"),
    outcome: MONITOR_OBSERVATION_OUTCOME.FAILURE,
    requestCount: null,
    source: MONITOR_OBSERVATION_SOURCE.PROBE,
  })
}

export function reduceMonitorEndpoint(state, observation, incidentId = null) {
  const current = { ...createEmptyMonitorEndpointState(), ...state }
  if (observation.outcome === MONITOR_OBSERVATION_OUTCOME.FAILURE) {
    const consecutiveFailures = Math.min(
      MONITOR_CONSECUTIVE_FAILURES,
      current.consecutiveFailures + 1,
    )
    const shouldOpen = !current.activeIncidentId
      && (observation.immediate
        || consecutiveFailures >= MONITOR_CONSECUTIVE_FAILURES)
    if (shouldOpen && !incidentId) {
      throw new TypeError("Opening a monitor incident requires an ID")
    }
    const next = {
      ...current,
      activeIncidentId: shouldOpen ? incidentId : current.activeIncidentId,
      consecutiveFailures,
      consecutiveSuccesses: 0,
      lastFailureAt: observation.observedAt,
      lastFailureKind: observation.failureKind,
      lastFailureStatus: observation.httpStatus,
      lastObservationAt: observation.observedAt,
    }
    if (observation.source === MONITOR_OBSERVATION_SOURCE.PROBE) {
      next.lastProbeAt = observation.observedAt
      next.lastProbeErrorCode = observation.errorCode
      next.lastProbeStatus = observation.httpStatus
    }
    return {
      state: next,
      transition: shouldOpen
        ? { incidentId, kind: MONITOR_TRANSITION.OPENED }
        : null,
    }
  }
  if (observation.outcome !== MONITOR_OBSERVATION_OUTCOME.SUCCESS
    || observation.source !== MONITOR_OBSERVATION_SOURCE.PROBE) {
    throw new TypeError("Monitor observation is invalid")
  }
  const consecutiveSuccesses = Math.min(
    MONITOR_CONSECUTIVE_SUCCESSES,
    current.consecutiveSuccesses + 1,
  )
  const shouldResolve = Boolean(current.activeIncidentId)
    && consecutiveSuccesses >= MONITOR_CONSECUTIVE_SUCCESSES
  const resolvedIncidentId = shouldResolve ? current.activeIncidentId : null
  return {
    state: {
      ...current,
      activeIncidentId: shouldResolve ? null : current.activeIncidentId,
      consecutiveFailures: 0,
      consecutiveSuccesses,
      lastObservationAt: observation.observedAt,
      lastProbeAt: observation.observedAt,
      lastProbeErrorCode: null,
      lastProbeStatus: observation.httpStatus,
    },
    transition: shouldResolve
      ? { incidentId: resolvedIncidentId, kind: MONITOR_TRANSITION.RESOLVED }
      : null,
  }
}

export function createMonitorIncident(endpoint, observation, incidentId, openedAt) {
  if (!incidentId || observation.outcome !== MONITOR_OBSERVATION_OUTCOME.FAILURE) {
    throw new TypeError("Monitor incident input is invalid")
  }
  return Object.freeze({
    errorCode: observation.errorCode,
    failureKind: observation.failureKind,
    firstObservedAt: observation.observedAt,
    firstStatus: observation.httpStatus,
    hostname: endpoint.hostname,
    id: incidentId,
    lastFailureAt: observation.observedAt,
    latestSignal: observation.source,
    latestStatus: observation.httpStatus,
    openedAt: requiredTimestamp(openedAt, "Incident opening time"),
    requestCount: observation.requestCount,
    resolvedAt: null,
    status: "open",
    zoneId: endpoint.zoneId,
    zoneName: endpoint.zoneName,
  })
}

export function updateMonitorIncident(incident, observation) {
  if (incident?.status !== "open"
    || observation.outcome !== MONITOR_OBSERVATION_OUTCOME.FAILURE) {
    throw new TypeError("Open monitor incident and failure observation are required")
  }
  return Object.freeze({
    ...incident,
    errorCode: observation.errorCode,
    failureKind: observation.failureKind,
    lastFailureAt: observation.observedAt,
    latestSignal: observation.source,
    latestStatus: observation.httpStatus,
    requestCount: observation.requestCount ?? incident.requestCount,
  })
}

export function resolveMonitorIncident(incident, resolvedAt) {
  if (incident?.status !== "open") {
    throw new TypeError("Only an open monitor incident can be resolved")
  }
  return Object.freeze({
    ...incident,
    resolvedAt: requiredTimestamp(resolvedAt, "Incident resolution time"),
    status: "resolved",
  })
}

function incidentFailureLabel(incident) {
  return incident.latestStatus
    ? `HTTP ${incident.latestStatus}`
    : "a network failure"
}

export function createMonitorCloudEvent(incident, transition) {
  if (![MONITOR_TRANSITION.OPENED, MONITOR_TRANSITION.RESOLVED].includes(transition)) {
    throw new TypeError("Monitor event transition is invalid")
  }
  const opened = transition === MONITOR_TRANSITION.OPENED
  const eventTime = opened ? incident.openedAt : incident.resolvedAt
  if (!eventTime) throw new TypeError("Monitor event transition time is unavailable")
  return Object.freeze({
    data: Object.freeze({
      errorCode: incident.errorCode,
      failureKind: incident.failureKind,
      firstObservedAt: incident.firstObservedAt,
      firstStatus: incident.firstStatus,
      hostname: incident.hostname,
      incidentId: incident.id,
      lastFailureAt: incident.lastFailureAt,
      latestSignal: incident.latestSignal,
      latestStatus: incident.latestStatus,
      openedAt: incident.openedAt,
      requestCount: incident.requestCount,
      resolvedAt: incident.resolvedAt,
      schemaVersion: 1,
      state: opened ? "problem" : "recovered",
      zoneId: incident.zoneId,
      zoneName: incident.zoneName,
    }),
    id: `${incident.id}/${transition}`,
    severity: opened ? "error" : "info",
    source: MONITOR_EVENT_SOURCE,
    specversion: "1.0",
    subject: incident.hostname,
    time: eventTime,
    title: opened
      ? `${incident.hostname} returned ${incidentFailureLabel(incident)}`
      : `${incident.hostname} recovered from ${incidentFailureLabel(incident)}`,
    type: opened ? MONITOR_EVENT_TYPE.PROBLEM : MONITOR_EVENT_TYPE.RECOVERED,
    url: `https://${incident.hostname}/`,
  })
}

export function normalizeHookrelayUrl(value) {
  if (typeof value !== "string") {
    throw new TypeError("Hookrelay URL is invalid")
  }
  let url
  try {
    url = new URL(value)
  } catch {
    throw new TypeError("Hookrelay URL is invalid")
  }
  const segments = url.pathname.split("/")
  if (value !== value.trim()
    || url.protocol !== "https:"
    || url.username
    || url.password
    || url.port
    || url.search
    || url.hash
    || segments.length !== 4
    || segments[1] !== "hook"
    || segments[2] !== "cloudevents"
    || !HOOKRELAY_SLUG_PATTERN.test(segments[3])) {
    throw new TypeError("Hookrelay URL is invalid")
  }
  return url.toString()
}

export async function signHookrelayPayload(body, secret) {
  if (typeof body !== "string" || typeof secret !== "string" || !secret) {
    throw new TypeError("Hookrelay signing input is invalid")
  }
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"],
  )
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(body))
  return [...new Uint8Array(signature)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
}
