import {
  createEmptyMonitorEndpointState,
  createMonitorCloudEvent,
  createMonitorIncident,
  MONITOR_TRANSITION,
  reduceMonitorEndpoint,
  resolveMonitorIncident,
  updateMonitorIncident,
} from "../monitor.mjs"

export const MONITOR_RUN_STATUS = Object.freeze({
  DEGRADED: "degraded",
  FAILED: "failed",
  HEALTHY: "healthy",
  RUNNING: "running",
})

const INSERT_MONITOR_META_SQL = `
  INSERT OR IGNORE INTO monitor_meta (account_id)
  VALUES (?)
`
const ACQUIRE_MONITOR_LEASE_SQL = `
  UPDATE monitor_meta
  SET lease_token = ?, lease_until = ?
  WHERE account_id = ?
    AND (lease_until IS NULL OR lease_until <= ? OR lease_token = ?)
`
const RELEASE_MONITOR_LEASE_SQL = `
  UPDATE monitor_meta
  SET lease_token = NULL, lease_until = NULL
  WHERE account_id = ? AND lease_token = ?
`
const READ_MONITOR_META_SQL = `
  SELECT *
  FROM monitor_meta
  WHERE account_id = ?
`
const START_MONITOR_RUN_SQL = `
  UPDATE monitor_meta
  SET
    last_run_started_at = ?,
    last_run_completed_at = NULL,
    last_run_status = 'running',
    last_error_code = NULL
  WHERE account_id = ?
`
const FINISH_MONITOR_RUN_SQL = `
  UPDATE monitor_meta
  SET
    last_run_completed_at = ?,
    last_run_status = ?,
    last_error_code = ?
  WHERE account_id = ?
`
const BEGIN_CATALOG_REFRESH_SQL = `
  UPDATE monitor_meta
  SET
    catalog_generation = ?,
    catalog_zones_json = ?,
    catalog_zone_cursor = 0,
    catalog_refresh_started_at = ?
  WHERE account_id = ?
`
const ADVANCE_CATALOG_CURSOR_SQL = `
  UPDATE monitor_meta
  SET catalog_zone_cursor = ?
  WHERE account_id = ? AND catalog_generation = ?
`
const UPSERT_MONITOR_ENDPOINT_SQL = `
  INSERT INTO monitor_endpoint (
    account_id,
    zone_id,
    hostname,
    zone_name,
    record_types_json,
    catalog_generation,
    catalog_active,
    discovered_at,
    created_at,
    updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
  ON CONFLICT (account_id, zone_id, hostname) DO UPDATE SET
    zone_name = excluded.zone_name,
    record_types_json = excluded.record_types_json,
    catalog_generation = excluded.catalog_generation,
    catalog_active = 1,
    discovered_at = excluded.discovered_at,
    updated_at = excluded.updated_at
`
const DEACTIVATE_STALE_ENDPOINTS_SQL = `
  UPDATE monitor_endpoint
  SET
    catalog_active = 0,
    selected = 0,
    selection_reason = 'inactive',
    request_count = 0,
    updated_at = ?
  WHERE account_id = ? AND catalog_generation <> ?
`
const COMPLETE_CATALOG_REFRESH_SQL = `
  UPDATE monitor_meta
  SET catalog_refresh_completed_at = ?
  WHERE account_id = ? AND catalog_generation = ?
`
const READ_CATALOG_ENDPOINTS_SQL = `
  SELECT *
  FROM monitor_endpoint
  WHERE account_id = ? AND catalog_active = 1
  ORDER BY zone_name, hostname
`
const UPDATE_ENDPOINT_SELECTION_SQL = `
  UPDATE monitor_endpoint
  SET
    request_count = ?,
    selected = ?,
    selection_reason = ?,
    updated_at = ?
  WHERE account_id = ? AND zone_id = ? AND hostname = ? AND catalog_active = 1
    AND (request_count <> ? OR selected <> ? OR selection_reason <> ?)
`
const UPDATE_ANALYTICS_CURSOR_SQL = `
  UPDATE monitor_meta
  SET analytics_cursor_at = ?
  WHERE account_id = ?
`
const INSERT_ANALYTICS_OBSERVATION_SQL = `
  INSERT OR IGNORE INTO monitor_analytics_observation (
    account_id,
    zone_id,
    hostname,
    status,
    observed_minute,
    request_count,
    recorded_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?)
`
const READ_PENDING_ANALYTICS_SQL = `
  SELECT
    observation.zone_id,
    observation.hostname,
    observation.status,
    observation.observed_minute,
    observation.request_count
  FROM monitor_analytics_observation AS observation
  JOIN monitor_endpoint AS endpoint
    ON endpoint.account_id = observation.account_id
    AND endpoint.zone_id = observation.zone_id
    AND endpoint.hostname = observation.hostname
  WHERE observation.account_id = ?
    AND observation.processed_at IS NULL
    AND endpoint.catalog_active = 1
    AND endpoint.selected = 1
  ORDER BY observation.observed_minute, observation.zone_id, observation.hostname
  LIMIT ?
`
const MARK_ANALYTICS_PROCESSED_SQL = `
  UPDATE monitor_analytics_observation
  SET processed_at = ?
  WHERE account_id = ?
    AND zone_id = ?
    AND hostname = ?
    AND status = ?
    AND observed_minute = ?
    AND processed_at IS NULL
`
const READ_DUE_ENDPOINTS_SQL = `
  SELECT *
  FROM monitor_endpoint
  WHERE account_id = ? AND catalog_active = 1 AND selected = 1
  ORDER BY
    CASE WHEN active_incident_id IS NULL THEN 1 ELSE 0 END,
    CASE WHEN last_probe_at IS NULL THEN 0 ELSE 1 END,
    last_probe_at,
    zone_name,
    hostname
  LIMIT ?
`
const READ_ENDPOINT_SQL = `
  SELECT *
  FROM monitor_endpoint
  WHERE account_id = ? AND zone_id = ? AND hostname = ?
`
const UPDATE_ENDPOINT_OBSERVATION_SQL = `
  UPDATE monitor_endpoint
  SET
    active_incident_id = ?,
    consecutive_failures = ?,
    consecutive_successes = ?,
    last_failure_at = ?,
    last_failure_kind = ?,
    last_failure_status = ?,
    last_observation_at = ?,
    last_probe_at = ?,
    last_probe_error_code = ?,
    last_probe_status = ?,
    updated_at = ?
  WHERE account_id = ? AND zone_id = ? AND hostname = ?
`
const INSERT_INCIDENT_SQL = `
  INSERT INTO monitor_incident (
    id,
    account_id,
    zone_id,
    zone_name,
    hostname,
    status,
    failure_kind,
    error_code,
    first_status,
    latest_status,
    latest_signal,
    request_count,
    first_observed_at,
    last_failure_at,
    opened_at,
    resolved_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`
const READ_INCIDENT_SQL = `
  SELECT *
  FROM monitor_incident
  WHERE account_id = ? AND id = ?
`
const UPDATE_INCIDENT_SQL = `
  UPDATE monitor_incident
  SET
    status = ?,
    failure_kind = ?,
    error_code = ?,
    latest_status = ?,
    latest_signal = ?,
    request_count = ?,
    last_failure_at = ?,
    resolved_at = ?
  WHERE account_id = ? AND id = ? AND status = 'open'
`
const INSERT_OUTBOX_SQL = `
  INSERT INTO monitor_outbox (
    id,
    account_id,
    incident_id,
    transition,
    event_json,
    created_at,
    next_attempt_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?)
`
const READ_DUE_OUTBOX_SQL = `
  SELECT id, event_json, attempts
  FROM monitor_outbox
  WHERE account_id = ?
    AND delivered_at IS NULL
    AND next_attempt_at <= ?
  ORDER BY created_at, id
  LIMIT ?
`
const DELIVER_OUTBOX_SQL = `
  UPDATE monitor_outbox
  SET
    attempts = attempts + 1,
    delivered_at = ?,
    last_attempt_at = ?,
    last_error_code = NULL
  WHERE account_id = ? AND id = ? AND delivered_at IS NULL
`
const FAIL_OUTBOX_SQL = `
  UPDATE monitor_outbox
  SET
    attempts = attempts + 1,
    last_attempt_at = ?,
    last_error_code = ?,
    next_attempt_at = ?
  WHERE account_id = ? AND id = ? AND delivered_at IS NULL
`
const PRUNE_ANALYTICS_SQL = `
  DELETE FROM monitor_analytics_observation
  WHERE account_id = ? AND observed_minute < ?
`
const PRUNE_OUTBOX_SQL = `
  DELETE FROM monitor_outbox
  WHERE account_id = ? AND delivered_at IS NOT NULL AND delivered_at < ?
`
const STATUS_ENDPOINT_COUNTS_SQL = `
  SELECT
    COUNT(*) AS cataloged,
    COALESCE(SUM(selected), 0) AS selected,
    COALESCE(SUM(CASE WHEN active_incident_id IS NULL THEN 0 ELSE 1 END), 0) AS open
  FROM monitor_endpoint
  WHERE account_id = ? AND catalog_active = 1
`
const STATUS_OPEN_INCIDENTS_SQL = `
  SELECT *
  FROM monitor_incident
  WHERE account_id = ? AND status = 'open'
  ORDER BY opened_at DESC
`
const STATUS_RECENT_INCIDENTS_SQL = `
  SELECT *
  FROM monitor_incident
  WHERE account_id = ?
  ORDER BY opened_at DESC
  LIMIT ?
`
const STATUS_OUTBOX_COUNT_SQL = `
  SELECT COUNT(*) AS pending
  FROM monitor_outbox
  WHERE account_id = ? AND delivered_at IS NULL
`

function resultRows(result) {
  return Array.isArray(result?.results) ? result.results : []
}

function changedRows(result) {
  return result?.meta?.changes ?? result?.meta?.rows_written ?? 0
}

function parsedJson(value, label) {
  try {
    return JSON.parse(value)
  } catch {
    throw new Error(`${label} is not valid JSON`)
  }
}

function monitorMeta(row) {
  if (!row) throw new Error("Hosted monitor state is unavailable")
  return {
    analyticsCursorAt: row.analytics_cursor_at,
    catalogGeneration: row.catalog_generation,
    catalogRefreshCompletedAt: row.catalog_refresh_completed_at,
    catalogRefreshStartedAt: row.catalog_refresh_started_at,
    catalogZoneCursor: Number(row.catalog_zone_cursor),
    catalogZones: row.catalog_zones_json
      ? parsedJson(row.catalog_zones_json, "Hosted monitor catalog zones")
      : [],
    lastErrorCode: row.last_error_code,
    lastRunCompletedAt: row.last_run_completed_at,
    lastRunStartedAt: row.last_run_started_at,
    lastRunStatus: row.last_run_status,
    leaseToken: row.lease_token,
    leaseUntil: row.lease_until,
  }
}

function endpointFromRow(row) {
  return {
    accountId: row.account_id,
    catalogActive: Boolean(row.catalog_active),
    catalogGeneration: row.catalog_generation,
    discoveredAt: row.discovered_at,
    hostname: row.hostname,
    recordTypes: parsedJson(row.record_types_json, "Monitor endpoint record types"),
    requestCount: Number(row.request_count),
    selected: Boolean(row.selected),
    selectionReason: row.selection_reason,
    state: {
      activeIncidentId: row.active_incident_id,
      consecutiveFailures: Number(row.consecutive_failures),
      consecutiveSuccesses: Number(row.consecutive_successes),
      lastFailureAt: row.last_failure_at,
      lastFailureKind: row.last_failure_kind,
      lastFailureStatus: row.last_failure_status === null
        ? null
        : Number(row.last_failure_status),
      lastObservationAt: row.last_observation_at,
      lastProbeAt: row.last_probe_at,
      lastProbeErrorCode: row.last_probe_error_code,
      lastProbeStatus: row.last_probe_status === null
        ? null
        : Number(row.last_probe_status),
    },
    updatedAt: row.updated_at,
    zoneId: row.zone_id,
    zoneName: row.zone_name,
  }
}

function incidentFromRow(row) {
  if (!row) return null
  return {
    errorCode: row.error_code,
    failureKind: row.failure_kind,
    firstObservedAt: row.first_observed_at,
    firstStatus: row.first_status === null ? null : Number(row.first_status),
    hostname: row.hostname,
    id: row.id,
    lastFailureAt: row.last_failure_at,
    latestSignal: row.latest_signal,
    latestStatus: row.latest_status === null ? null : Number(row.latest_status),
    openedAt: row.opened_at,
    requestCount: row.request_count === null ? null : Number(row.request_count),
    resolvedAt: row.resolved_at,
    status: row.status,
    zoneId: row.zone_id,
    zoneName: row.zone_name,
  }
}

function endpointObservationStatement(db, accountId, endpoint, state, updatedAt) {
  return db.prepare(UPDATE_ENDPOINT_OBSERVATION_SQL).bind(
    state.activeIncidentId,
    state.consecutiveFailures,
    state.consecutiveSuccesses,
    state.lastFailureAt,
    state.lastFailureKind,
    state.lastFailureStatus,
    state.lastObservationAt,
    state.lastProbeAt,
    state.lastProbeErrorCode,
    state.lastProbeStatus,
    updatedAt,
    accountId,
    endpoint.zoneId,
    endpoint.hostname,
  )
}

function incidentInsertStatement(db, accountId, incident) {
  return db.prepare(INSERT_INCIDENT_SQL).bind(
    incident.id,
    accountId,
    incident.zoneId,
    incident.zoneName,
    incident.hostname,
    incident.status,
    incident.failureKind,
    incident.errorCode,
    incident.firstStatus,
    incident.latestStatus,
    incident.latestSignal,
    incident.requestCount,
    incident.firstObservedAt,
    incident.lastFailureAt,
    incident.openedAt,
    incident.resolvedAt,
  )
}

function incidentUpdateStatement(db, accountId, incident) {
  return db.prepare(UPDATE_INCIDENT_SQL).bind(
    incident.status,
    incident.failureKind,
    incident.errorCode,
    incident.latestStatus,
    incident.latestSignal,
    incident.requestCount,
    incident.lastFailureAt,
    incident.resolvedAt,
    accountId,
    incident.id,
  )
}

function outboxInsertStatement(db, accountId, incident, transition, createdAt) {
  const event = createMonitorCloudEvent(incident, transition)
  return db.prepare(INSERT_OUTBOX_SQL).bind(
    event.id,
    accountId,
    incident.id,
    transition,
    JSON.stringify(event),
    createdAt,
    createdAt,
  )
}

export async function ensureHostedMonitorAccount(db, accountId) {
  await db.prepare(INSERT_MONITOR_META_SQL).bind(accountId).run()
}

export async function acquireHostedMonitorLease(
  db,
  accountId,
  token,
  now,
  leaseUntil,
) {
  await ensureHostedMonitorAccount(db, accountId)
  const result = await db.prepare(ACQUIRE_MONITOR_LEASE_SQL).bind(
    token,
    leaseUntil,
    accountId,
    now,
    token,
  ).run()
  return changedRows(result) === 1
}

export async function releaseHostedMonitorLease(db, accountId, token) {
  await db.prepare(RELEASE_MONITOR_LEASE_SQL).bind(accountId, token).run()
}

export async function readHostedMonitorMeta(db, accountId) {
  await ensureHostedMonitorAccount(db, accountId)
  return monitorMeta(
    await db.prepare(READ_MONITOR_META_SQL).bind(accountId).first(),
  )
}

export async function startHostedMonitorRun(db, accountId, startedAt) {
  await ensureHostedMonitorAccount(db, accountId)
  await db.prepare(START_MONITOR_RUN_SQL).bind(startedAt, accountId).run()
}

export async function finishHostedMonitorRun(
  db,
  accountId,
  completedAt,
  status,
  errorCode = null,
) {
  if (!Object.values(MONITOR_RUN_STATUS).includes(status)
    || status === MONITOR_RUN_STATUS.RUNNING) {
    throw new TypeError("Monitor completion status is invalid")
  }
  await db.prepare(FINISH_MONITOR_RUN_SQL).bind(
    completedAt,
    status,
    errorCode,
    accountId,
  ).run()
}

export async function beginHostedMonitorCatalogRefresh(
  db,
  accountId,
  generation,
  zones,
  startedAt,
) {
  await ensureHostedMonitorAccount(db, accountId)
  await db.prepare(BEGIN_CATALOG_REFRESH_SQL).bind(
    generation,
    JSON.stringify(zones),
    startedAt,
    accountId,
  ).run()
  return readHostedMonitorMeta(db, accountId)
}

export async function persistHostedMonitorCatalogZone(
  db,
  accountId,
  generation,
  endpoints,
  nextCursor,
  updatedAt,
) {
  const statements = endpoints.map((endpoint) => (
    db.prepare(UPSERT_MONITOR_ENDPOINT_SQL).bind(
      accountId,
      endpoint.zoneId,
      endpoint.hostname,
      endpoint.zoneName,
      JSON.stringify(endpoint.recordTypes),
      generation,
      endpoint.discoveredAt,
      updatedAt,
      updatedAt,
    )
  ))
  statements.push(
    db.prepare(ADVANCE_CATALOG_CURSOR_SQL).bind(
      nextCursor,
      accountId,
      generation,
    ),
  )
  await db.batch(statements)
}

export async function completeHostedMonitorCatalogRefresh(
  db,
  accountId,
  generation,
  completedAt,
) {
  await db.batch([
    db.prepare(DEACTIVATE_STALE_ENDPOINTS_SQL).bind(
      completedAt,
      accountId,
      generation,
    ),
    db.prepare(COMPLETE_CATALOG_REFRESH_SQL).bind(
      completedAt,
      accountId,
      generation,
    ),
  ])
}

export async function readHostedMonitorCatalogEndpoints(db, accountId) {
  const result = await db.prepare(READ_CATALOG_ENDPOINTS_SQL)
    .bind(accountId)
    .all()
  return resultRows(result).map(endpointFromRow)
}

export async function persistHostedMonitorSelections(
  db,
  accountId,
  endpoints,
  updatedAt,
) {
  if (endpoints.length === 0) return
  await db.batch(endpoints.map((endpoint) => (
    db.prepare(UPDATE_ENDPOINT_SELECTION_SQL).bind(
      endpoint.requestCount,
      endpoint.selected ? 1 : 0,
      endpoint.selectionReason,
      updatedAt,
      accountId,
      endpoint.zoneId,
      endpoint.hostname,
      endpoint.requestCount,
      endpoint.selected ? 1 : 0,
      endpoint.selectionReason,
    )
  )))
}

export async function updateHostedMonitorAnalyticsCursor(db, accountId, cursorAt) {
  await db.prepare(UPDATE_ANALYTICS_CURSOR_SQL).bind(cursorAt, accountId).run()
}

export async function ingestHostedMonitorAnalytics(
  db,
  accountId,
  observations,
  recordedAt,
) {
  if (observations.length === 0) return
  await db.batch(observations.map((observation) => (
    db.prepare(INSERT_ANALYTICS_OBSERVATION_SQL).bind(
      accountId,
      observation.zoneId,
      observation.hostname,
      observation.status,
      observation.observedMinute,
      observation.requestCount,
      recordedAt,
    )
  )))
}

export async function readPendingHostedMonitorAnalytics(
  db,
  accountId,
  limit,
) {
  const result = await db.prepare(READ_PENDING_ANALYTICS_SQL)
    .bind(accountId, limit)
    .all()
  return resultRows(result).map((row) => ({
    hostname: row.hostname,
    observedMinute: row.observed_minute,
    requestCount: Number(row.request_count),
    status: Number(row.status),
    zoneId: row.zone_id,
  }))
}

export async function readDueHostedMonitorEndpoints(db, accountId, limit) {
  const result = await db.prepare(READ_DUE_ENDPOINTS_SQL)
    .bind(accountId, limit)
    .all()
  return resultRows(result).map(endpointFromRow)
}

export async function recordHostedMonitorObservation(
  db,
  accountId,
  endpointKey,
  observation,
  options,
) {
  const row = await db.prepare(READ_ENDPOINT_SQL).bind(
    accountId,
    endpointKey.zoneId,
    endpointKey.hostname,
  ).first()
  if (!row) throw new Error("Monitor endpoint is unavailable")
  const endpoint = endpointFromRow(row)
  const incidentId = options.incidentId || null
  const reduced = reduceMonitorEndpoint(endpoint.state, observation, incidentId)
  const statements = [endpointObservationStatement(
    db,
    accountId,
    endpoint,
    reduced.state,
    options.recordedAt,
  )]
  let incident = endpoint.state.activeIncidentId
    ? incidentFromRow(await db.prepare(READ_INCIDENT_SQL).bind(
        accountId,
        endpoint.state.activeIncidentId,
      ).first())
    : null
  if (reduced.transition?.kind === MONITOR_TRANSITION.OPENED) {
    incident = createMonitorIncident(
      endpoint,
      observation,
      reduced.transition.incidentId,
      options.recordedAt,
    )
    statements.push(
      incidentInsertStatement(db, accountId, incident),
      outboxInsertStatement(
        db,
        accountId,
        incident,
        MONITOR_TRANSITION.OPENED,
        options.recordedAt,
      ),
    )
  } else if (reduced.transition?.kind === MONITOR_TRANSITION.RESOLVED) {
    if (!incident || incident.id !== reduced.transition.incidentId) {
      throw new Error("Open monitor incident is unavailable for recovery")
    }
    incident = resolveMonitorIncident(incident, options.recordedAt)
    statements.push(
      incidentUpdateStatement(db, accountId, incident),
      outboxInsertStatement(
        db,
        accountId,
        incident,
        MONITOR_TRANSITION.RESOLVED,
        options.recordedAt,
      ),
    )
  } else if (incident && observation.failureKind) {
    incident = updateMonitorIncident(incident, observation)
    statements.push(incidentUpdateStatement(db, accountId, incident))
  }
  if (options.analyticsKey) {
    statements.push(db.prepare(MARK_ANALYTICS_PROCESSED_SQL).bind(
      options.recordedAt,
      accountId,
      options.analyticsKey.zoneId,
      options.analyticsKey.hostname,
      options.analyticsKey.status,
      options.analyticsKey.observedMinute,
    ))
  }
  await db.batch(statements)
  return {
    incident,
    state: reduced.state,
    transition: reduced.transition,
  }
}

export async function readDueHostedMonitorOutbox(db, accountId, now, limit) {
  const result = await db.prepare(READ_DUE_OUTBOX_SQL)
    .bind(accountId, now, limit)
    .all()
  return resultRows(result).map((row) => ({
    attempts: Number(row.attempts),
    body: row.event_json,
    event: parsedJson(row.event_json, "Monitor outbox event"),
    id: row.id,
  }))
}

export async function markHostedMonitorOutboxDelivered(
  db,
  accountId,
  id,
  deliveredAt,
) {
  await db.prepare(DELIVER_OUTBOX_SQL).bind(
    deliveredAt,
    deliveredAt,
    accountId,
    id,
  ).run()
}

export async function markHostedMonitorOutboxFailed(
  db,
  accountId,
  id,
  attemptedAt,
  errorCode,
  nextAttemptAt,
) {
  await db.prepare(FAIL_OUTBOX_SQL).bind(
    attemptedAt,
    errorCode,
    nextAttemptAt,
    accountId,
    id,
  ).run()
}

export async function pruneHostedMonitorState(
  db,
  accountId,
  observationCutoff,
  outboxCutoff,
) {
  await db.batch([
    db.prepare(PRUNE_ANALYTICS_SQL).bind(accountId, observationCutoff),
    db.prepare(PRUNE_OUTBOX_SQL).bind(accountId, outboxCutoff),
  ])
}

function publicIncident(row) {
  const incident = incidentFromRow(row)
  return {
    errorCode: incident.errorCode,
    failureKind: incident.failureKind,
    firstObservedAt: incident.firstObservedAt,
    firstStatus: incident.firstStatus,
    hostname: incident.hostname,
    id: incident.id,
    lastFailureAt: incident.lastFailureAt,
    latestSignal: incident.latestSignal,
    latestStatus: incident.latestStatus,
    openedAt: incident.openedAt,
    requestCount: incident.requestCount,
    resolvedAt: incident.resolvedAt,
    status: incident.status,
    zoneName: incident.zoneName,
  }
}

export async function readHostedMonitorStatus(db, accountId) {
  const meta = await readHostedMonitorMeta(db, accountId)
  const [countsResult, openResult, recentResult, outboxResult] = await db.batch([
    db.prepare(STATUS_ENDPOINT_COUNTS_SQL).bind(accountId),
    db.prepare(STATUS_OPEN_INCIDENTS_SQL).bind(accountId),
    db.prepare(STATUS_RECENT_INCIDENTS_SQL).bind(accountId, 50),
    db.prepare(STATUS_OUTBOX_COUNT_SQL).bind(accountId),
  ])
  const counts = resultRows(countsResult)[0] || {}
  const outbox = resultRows(outboxResult)[0] || {}
  return {
    analyticsCursorAt: meta.analyticsCursorAt,
    catalog: {
      completedAt: meta.catalogRefreshCompletedAt,
      generation: meta.catalogGeneration,
      inProgress: meta.catalogZones.length > meta.catalogZoneCursor,
      startedAt: meta.catalogRefreshStartedAt,
      zoneCursor: meta.catalogZoneCursor,
      zones: meta.catalogZones.length,
    },
    endpoints: {
      cataloged: Number(counts.cataloged || 0),
      open: Number(counts.open || 0),
      selected: Number(counts.selected || 0),
    },
    lastRun: {
      completedAt: meta.lastRunCompletedAt,
      errorCode: meta.lastErrorCode,
      startedAt: meta.lastRunStartedAt,
      status: meta.lastRunStatus,
    },
    openIncidents: resultRows(openResult).map(publicIncident),
    pendingDeliveries: Number(outbox.pending || 0),
    recentIncidents: resultRows(recentResult).map(publicIncident),
  }
}
