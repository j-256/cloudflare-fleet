import assert from "node:assert/strict"
import test from "node:test"

import {
  catalogEndpointsForZone,
  probeHttpObservation,
  selectMonitorEndpoints,
} from "../src/monitor.mjs"
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
  readDueHostedMonitorEndpoints,
  readDueHostedMonitorOutbox,
  readHostedMonitorCatalogEndpoints,
  readHostedMonitorMeta,
  readHostedMonitorStatus,
  readPendingHostedMonitorAnalytics,
  recordHostedMonitorObservation,
  releaseHostedMonitorLease,
  startHostedMonitorRun,
  updateHostedMonitorAnalyticsCursor,
} from "../src/hosted/monitor-store.mjs"
import {
  analyticsFailureObservation,
} from "../src/monitor.mjs"
import {
  hostedD1Fixture,
} from "./hosted-d1.fixture.mjs"

const ACCOUNT_ID = "account-one"
const STARTED_AT = "2026-08-25T01:00:00.000Z"

async function seedEndpoint(db) {
  const generation = "catalog-one"
  await beginHostedMonitorCatalogRefresh(
    db,
    ACCOUNT_ID,
    generation,
    [{ id: "zone-one", name: "example.com" }],
    STARTED_AT,
  )
  const endpoints = catalogEndpointsForZone(
    { id: "zone-one", name: "example.com" },
    [{ name: "example.com", proxied: true, type: "A" }],
    generation,
    STARTED_AT,
  )
  await persistHostedMonitorCatalogZone(
    db,
    ACCOUNT_ID,
    generation,
    endpoints,
    1,
    STARTED_AT,
  )
  await completeHostedMonitorCatalogRefresh(
    db,
    ACCOUNT_ID,
    generation,
    STARTED_AT,
  )
  const selected = selectMonitorEndpoints(
    await readHostedMonitorCatalogEndpoints(db, ACCOUNT_ID),
    [],
    { endpointMonitoring: {} },
  )
  await persistHostedMonitorSelections(db, ACCOUNT_ID, selected, STARTED_AT)
  return selected[0]
}

test("hosted monitor lease excludes overlapping runs and expires", async (context) => {
  const db = hostedD1Fixture(context)

  assert.equal(await acquireHostedMonitorLease(
    db,
    ACCOUNT_ID,
    "lease-one",
    STARTED_AT,
    "2026-08-25T01:04:30.000Z",
  ), true)
  assert.equal(await acquireHostedMonitorLease(
    db,
    ACCOUNT_ID,
    "lease-two",
    "2026-08-25T01:01:00.000Z",
    "2026-08-25T01:05:30.000Z",
  ), false)
  assert.equal(await acquireHostedMonitorLease(
    db,
    ACCOUNT_ID,
    "lease-two",
    "2026-08-25T01:05:00.000Z",
    "2026-08-25T01:09:30.000Z",
  ), true)

  await releaseHostedMonitorLease(db, ACCOUNT_ID, "lease-two")
  assert.equal((await readHostedMonitorMeta(db, ACCOUNT_ID)).leaseToken, null)
})

test("hosted monitor catalog preserves endpoint state across generations", async (context) => {
  const db = hostedD1Fixture(context)
  await seedEndpoint(db)

  assert.deepEqual(
    (await readDueHostedMonitorEndpoints(db, ACCOUNT_ID, 10))
      .map((entry) => entry.hostname),
    ["example.com"],
  )

  await beginHostedMonitorCatalogRefresh(
    db,
    ACCOUNT_ID,
    "catalog-two",
    [{ id: "zone-one", name: "example.com" }],
    "2026-08-25T02:00:00.000Z",
  )
  await completeHostedMonitorCatalogRefresh(
    db,
    ACCOUNT_ID,
    "catalog-two",
    "2026-08-25T02:01:00.000Z",
  )

  assert.equal((await readHostedMonitorCatalogEndpoints(db, ACCOUNT_ID)).length, 0)
})

test("hosted monitor leaves unchanged selections untouched", async (context) => {
  const db = hostedD1Fixture(context)
  await seedEndpoint(db)
  const before = (await readHostedMonitorCatalogEndpoints(db, ACCOUNT_ID))[0]
  const selected = selectMonitorEndpoints([before], [], {
    endpointMonitoring: {},
  })

  await persistHostedMonitorSelections(
    db,
    ACCOUNT_ID,
    selected,
    "2026-08-25T01:05:00.000Z",
  )

  const after = (await readHostedMonitorCatalogEndpoints(db, ACCOUNT_ID))[0]
  assert.equal(after.updatedAt, before.updatedAt)
})

test("hosted monitor commits problem and recovery events with incident state", async (context) => {
  const db = hostedD1Fixture(context)
  const endpoint = await seedEndpoint(db)
  const analytics = {
    hostname: endpoint.hostname,
    observedMinute: "2026-08-25T01:02:00.000Z",
    requestCount: 4,
    status: 526,
    zoneId: endpoint.zoneId,
  }

  await ingestHostedMonitorAnalytics(db, ACCOUNT_ID, [analytics, analytics], STARTED_AT)
  const pending = await readPendingHostedMonitorAnalytics(db, ACCOUNT_ID, 10)
  assert.equal(pending.length, 1)
  const observation = analyticsFailureObservation({
    count: pending[0].requestCount,
    dimensions: {
      datetimeMinute: pending[0].observedMinute,
      edgeResponseStatus: pending[0].status,
    },
  })
  const opened = await recordHostedMonitorObservation(
    db,
    ACCOUNT_ID,
    endpoint,
    observation,
    {
      analyticsKey: pending[0],
      incidentId: "incident-one",
      recordedAt: "2026-08-25T01:03:00.000Z",
    },
  )

  assert.equal(opened.transition.kind, "opened")
  assert.equal((await readPendingHostedMonitorAnalytics(db, ACCOUNT_ID, 10)).length, 0)
  let status = await readHostedMonitorStatus(db, ACCOUNT_ID)
  assert.equal(status.endpoints.open, 1)
  assert.equal(status.openIncidents[0].latestStatus, 526)
  assert.equal(status.pendingDeliveries, 1)
  let outbox = await readDueHostedMonitorOutbox(
    db,
    ACCOUNT_ID,
    "2026-08-25T01:04:00.000Z",
    10,
  )
  assert.equal(outbox[0].event.id, "incident-one/opened")
  assert.equal(outbox[0].event.data.requestCount, 4)

  const firstSuccess = await recordHostedMonitorObservation(
    db,
    ACCOUNT_ID,
    endpoint,
    probeHttpObservation(200, "2026-08-25T01:05:00.000Z"),
    {
      incidentId: "unused-one",
      recordedAt: "2026-08-25T01:05:00.000Z",
    },
  )
  const recovered = await recordHostedMonitorObservation(
    db,
    ACCOUNT_ID,
    endpoint,
    probeHttpObservation(403, "2026-08-25T01:10:00.000Z"),
    {
      incidentId: "unused-two",
      recordedAt: "2026-08-25T01:10:00.000Z",
    },
  )

  assert.equal(firstSuccess.transition, null)
  assert.equal(recovered.transition.kind, "resolved")
  status = await readHostedMonitorStatus(db, ACCOUNT_ID)
  assert.equal(status.endpoints.open, 0)
  assert.equal(status.openIncidents.length, 0)
  assert.equal(status.recentIncidents[0].status, "resolved")
  outbox = await readDueHostedMonitorOutbox(
    db,
    ACCOUNT_ID,
    "2026-08-25T01:11:00.000Z",
    10,
  )
  assert.deepEqual(
    outbox.map((entry) => entry.event.id),
    ["incident-one/opened", "incident-one/resolved"],
  )

  await markHostedMonitorOutboxDelivered(
    db,
    ACCOUNT_ID,
    "incident-one/opened",
    "2026-08-25T01:12:00.000Z",
  )
  await markHostedMonitorOutboxFailed(
    db,
    ACCOUNT_ID,
    "incident-one/resolved",
    "2026-08-25T01:12:00.000Z",
    "http-503",
    "2026-08-25T01:17:00.000Z",
  )
  assert.equal((await readDueHostedMonitorOutbox(
    db,
    ACCOUNT_ID,
    "2026-08-25T01:13:00.000Z",
    10,
  )).length, 0)
  assert.equal((await readDueHostedMonitorOutbox(
    db,
    ACCOUNT_ID,
    "2026-08-25T01:18:00.000Z",
    10,
  )).length, 1)
})

test("hosted monitor records run health and analytics cursor", async (context) => {
  const db = hostedD1Fixture(context)

  await startHostedMonitorRun(db, ACCOUNT_ID, STARTED_AT)
  await updateHostedMonitorAnalyticsCursor(
    db,
    ACCOUNT_ID,
    "2026-08-25T01:03:00.000Z",
  )
  await finishHostedMonitorRun(
    db,
    ACCOUNT_ID,
    "2026-08-25T01:04:00.000Z",
    MONITOR_RUN_STATUS.DEGRADED,
    "analytics-read",
  )
  const status = await readHostedMonitorStatus(db, ACCOUNT_ID)

  assert.equal(status.analyticsCursorAt, "2026-08-25T01:03:00.000Z")
  assert.equal(status.lastRun.status, "degraded")
  assert.equal(status.lastRun.errorCode, "analytics-read")
})
