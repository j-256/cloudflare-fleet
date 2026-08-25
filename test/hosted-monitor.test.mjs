import assert from "node:assert/strict"
import { createHmac } from "node:crypto"
import test from "node:test"

import {
  createMonitorFetchBudget,
  hostedMonitorIsEnabled,
  MonitorSubrequestBudgetError,
  runHostedFleetMonitor,
} from "../src/hosted/monitor.mjs"
import {
  HOSTED_MONITOR_CRON,
  HOSTED_MONITOR_LANE,
  hostedMonitorSchedule,
} from "../src/hosted/monitor-schedule.mjs"
import {
  readHostedMonitorStatus,
} from "../src/hosted/monitor-store.mjs"
import {
  hostedD1Fixture,
} from "./hosted-d1.fixture.mjs"

const ACCOUNT_ID = "account-one"
const HOOKRELAY_HMAC = "sender-secret"
const HOOKRELAY_SLUG = "a".repeat(22)
const HOOKRELAY_URL = `https://hooks.example.com/hook/cloudevents/${HOOKRELAY_SLUG}`

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json" },
    status,
  })
}

function environment(context, hookrelayFetch = async () => jsonResponse({ ok: true })) {
  return {
    CLOUDFLARE_API_TOKEN: "api-token",
    FLEET_ACCOUNT_ID: ACCOUNT_ID,
    FLEET_DB: hostedD1Fixture(context),
    FLEET_MONITOR_ENABLED: "true",
    FLEET_MONITOR_HOOKRELAY: { fetch: hookrelayFetch },
    FLEET_MONITOR_HOOKRELAY_HMAC: HOOKRELAY_HMAC,
    FLEET_MONITOR_HOOKRELAY_URL: HOOKRELAY_URL,
    FLEET_POLICY_JSON: JSON.stringify({
      emailDnsRecordExceptions: [],
      endpointMonitoring: {
        excludeHostnames: [],
        includeHostnames: [],
      },
      schemaVersion: 1,
    }),
  }
}

function monitorTransport() {
  const deliveries = []
  const calls = []
  let exampleStatus = 526
  let errorRows = [{
    count: 4,
    dimensions: {
      clientRequestHTTPHost: "example.com",
      datetimeMinute: "2026-08-25T01:55:00.000Z",
      edgeResponseStatus: 526,
      zoneTag: "zone-one",
    },
  }]
  return {
    calls,
    deliveries,
    recover() {
      errorRows = []
      exampleStatus = 200
    },
    async fetch(input, request = {}) {
      const url = new URL(input)
      calls.push({ method: request.method || "GET", url: url.toString() })
      if (url.hostname === "api.cloudflare.com" && url.pathname.endsWith("/zones")) {
        return jsonResponse({
          errors: [],
          messages: [],
          result: [{ id: "zone-one", name: "example.com", status: "active" }],
          result_info: { page: 1, total_pages: 1 },
          success: true,
        })
      }
      if (url.hostname === "api.cloudflare.com"
        && url.pathname.endsWith("/zones/zone-one/dns_records")) {
        return jsonResponse({
          errors: [],
          messages: [],
          result: [
            { name: "example.com", proxied: true, type: "A" },
            { name: "app.example.com", proxied: true, type: "CNAME" },
            { name: "idle.example.com", proxied: true, type: "A" },
          ],
          result_info: { page: 1, total_pages: 1 },
          success: true,
        })
      }
      if (url.hostname === "api.cloudflare.com" && url.pathname.endsWith("/graphql")) {
        const body = JSON.parse(request.body)
        assert.equal(body.variables.accountTag, ACCOUNT_ID)
        assert.match(body.query, /edgeResponseStatus_geq: 200/)
        assert.match(body.query, /edgeResponseStatus_lt: 400/)
        return jsonResponse({
          data: {
            viewer: {
              accounts: [{
                active: [
                  {
                    count: 150,
                    dimensions: {
                      clientRequestHTTPHost: "app.example.com",
                      edgeResponseStatus: 200,
                      zoneTag: "zone-one",
                    },
                  },
                  {
                    count: 1000,
                    dimensions: {
                      clientRequestHTTPHost: "idle.example.com",
                      edgeResponseStatus: 403,
                      zoneTag: "zone-one",
                    },
                  },
                  {
                    count: 10000,
                    dimensions: {
                      clientRequestHTTPHost: "forged.example.com",
                      edgeResponseStatus: 200,
                      zoneTag: "zone-one",
                    },
                  },
                ],
                errors: errorRows,
              }],
            },
          },
          errors: null,
        })
      }
      if (url.toString() === HOOKRELAY_URL) {
        assert.equal(request.redirect, "manual")
        const expected = createHmac("sha256", HOOKRELAY_HMAC)
          .update(request.body)
          .digest("hex")
        assert.equal(
          request.headers["X-Hookrelay-Signature-256"],
          `sha256=${expected}`,
        )
        deliveries.push(JSON.parse(request.body))
        return jsonResponse({ ok: true, eventId: deliveries.at(-1).id })
      }
      if (url.hostname === "example.com") {
        return new Response(null, { status: exampleStatus })
      }
      if (url.hostname === "app.example.com") {
        return new Response(null, { status: 200 })
      }
      throw new Error(`Unexpected monitor request: ${url}`)
    },
  }
}

function monitorRunner(env, transport) {
  let nextId = 0
  return (now, logger = { error() {}, info() {}, warn() {} }) => (
    runHostedFleetMonitor(env, {
      cron: HOSTED_MONITOR_CRON,
      fetchImpl: transport.fetch,
      logger,
      now,
      randomId: () => `id-${nextId += 1}`,
    })
  )
}

async function prepareCatalog(run) {
  const started = await run("2026-08-25T02:02:00.000Z")
  const refreshed = await run("2026-08-25T02:07:00.000Z")
  const completed = await run("2026-08-25T02:12:00.000Z")

  assert.equal(started.catalog.action, "started")
  assert.equal(refreshed.catalog.action, "zone-refreshed")
  assert.equal(completed.catalog.action, "completed")
}

function totalChanges(db) {
  return Number(db.sqlite.prepare("SELECT total_changes() AS count").get().count)
}

test("hosted monitor lanes detect, report, and resolve a 526 incident", async (context) => {
  const transport = monitorTransport()
  const env = environment(context, transport.fetch)
  const run = monitorRunner(env, transport)

  await prepareCatalog(run)
  const detected = await run("2026-08-25T02:15:00.000Z")
  let status = await readHostedMonitorStatus(env.FLEET_DB, ACCOUNT_ID)

  assert.equal(detected.analyticsObservations, 1)
  assert.equal(detected.selected, 2)
  assert.deepEqual(status.endpoints, { cataloged: 3, open: 1, selected: 2 })
  assert.equal(status.pendingDeliveries, 0)
  assert.equal(status.openIncidents[0].hostname, "example.com")
  assert.equal(status.openIncidents[0].latestStatus, 526)
  assert.equal(transport.deliveries.length, 1)
  assert.equal(
    transport.deliveries[0].type,
    "urn:cloudflare-fleet:endpoint:problem:v1",
  )

  transport.recover()
  const probeResults = []
  for (const minute of [16, 18, 19, 21, 23, 24]) {
    probeResults.push(await run(`2026-08-25T02:${minute}:00.000Z`))
  }
  status = await readHostedMonitorStatus(env.FLEET_DB, ACCOUNT_ID)

  assert.equal(probeResults.reduce((sum, result) => sum + result.probes, 0), 4)
  assert.equal(status.endpoints.open, 0)
  assert.equal(status.recentIncidents[0].status, "resolved")
  assert.equal(status.recentIncidents[0].resolutionReason, "recovered")
  assert.equal(transport.deliveries.length, 2)
  assert.equal(
    transport.deliveries[1].type,
    "urn:cloudflare-fleet:endpoint:recovered:v1",
  )

  const zoneReads = transport.calls.filter((entry) => (
    new URL(entry.url).pathname.endsWith("/zones")
  ))
  const graphReads = transport.calls.filter((entry) => (
    new URL(entry.url).pathname.endsWith("/graphql")
  ))
  assert.equal(zoneReads.length, 1)
  assert.equal(graphReads.length, 1)
})

test("hosted monitor suppresses a policy exclusion without recovery delivery", async (context) => {
  const transport = monitorTransport()
  const env = environment(context, transport.fetch)
  const run = monitorRunner(env, transport)

  await prepareCatalog(run)
  await run("2026-08-25T02:15:00.000Z")
  env.FLEET_POLICY_JSON = JSON.stringify({
    emailDnsRecordExceptions: [],
    endpointMonitoring: {
      excludeHostnames: ["example.com"],
      includeHostnames: [],
    },
    schemaVersion: 1,
  })
  const result = await run("2026-08-25T02:20:00.000Z")
  const status = await readHostedMonitorStatus(env.FLEET_DB, ACCOUNT_ID)

  assert.equal(result.suppressed, 1)
  assert.equal(status.openIncidents.length, 0)
  assert.equal(status.recentIncidents[0].resolutionReason, "policy-excluded")
  assert.equal(transport.deliveries.length, 1)
})

test("healthy probe shards perform no D1 writes", async (context) => {
  const transport = monitorTransport()
  transport.recover()
  const env = environment(context, transport.fetch)
  const run = monitorRunner(env, transport)
  const records = []
  const logger = {
    error(record) { records.push(record) },
    info(record) { records.push(record) },
    warn(record) { records.push(record) },
  }

  await prepareCatalog(run)
  await run("2026-08-25T02:15:00.000Z")
  const beforeAnalytics = totalChanges(env.FLEET_DB)
  await run("2026-08-25T02:20:00.000Z")
  assert.equal(totalChanges(env.FLEET_DB) - beforeAnalytics, 1)
  const before = totalChanges(env.FLEET_DB)
  const results = []
  for (const minute of [21, 23, 24]) {
    results.push(await run(
      `2026-08-25T02:${minute}:00.000Z`,
      logger,
    ))
  }

  assert.equal(results.reduce((sum, result) => sum + result.probes, 0), 2)
  assert.equal(totalChanges(env.FLEET_DB), before)
  assert.equal(records.some((record) => record.event === "probe-failure"), false)
  assert.equal(
    records.every((record) => (
      record.component === "cloudflare-fleet-endpoint-monitor"
    )),
    true,
  )
  const logged = JSON.stringify(records)
  for (const secret of [
    env.CLOUDFLARE_API_TOKEN,
    HOOKRELAY_HMAC,
    HOOKRELAY_SLUG,
    HOOKRELAY_URL,
  ]) {
    assert.equal(logged.includes(secret), false)
  }
})

test("analytics does not advance before the catalog is ready", async (context) => {
  const transport = monitorTransport()
  const env = environment(context, transport.fetch)
  const run = monitorRunner(env, transport)

  const result = await run("2026-08-25T02:00:00.000Z")
  const status = await readHostedMonitorStatus(env.FLEET_DB, ACCOUNT_ID)

  assert.equal(result.catalogReady, false)
  assert.equal(status.analyticsCursorAt, null)
  assert.equal(status.catalog.completedAt, null)
})

test("hosted monitor schedule time-slices one lane per minute", () => {
  const schedules = Array.from({ length: 10 }, (_value, minute) => (
    hostedMonitorSchedule(
      HOSTED_MONITOR_CRON,
      `2026-08-25T02:${String(minute).padStart(2, "0")}:00.000Z`,
    )
  ))

  assert.deepEqual(
    schedules.map((schedule) => schedule.lane),
    [
      HOSTED_MONITOR_LANE.ANALYTICS,
      HOSTED_MONITOR_LANE.PROBE,
      HOSTED_MONITOR_LANE.MAINTENANCE,
      HOSTED_MONITOR_LANE.PROBE,
      HOSTED_MONITOR_LANE.PROBE,
      HOSTED_MONITOR_LANE.ANALYTICS,
      HOSTED_MONITOR_LANE.PROBE,
      HOSTED_MONITOR_LANE.MAINTENANCE,
      HOSTED_MONITOR_LANE.PROBE,
      HOSTED_MONITOR_LANE.PROBE,
    ],
  )
  assert.deepEqual(
    schedules
      .filter((schedule) => schedule.lane === HOSTED_MONITOR_LANE.PROBE)
      .map((schedule) => schedule.probeSequence),
    Array.from({ length: 6 }, (_value, index) => (
      schedules[1].probeSequence + index
    )),
  )
  assert.throws(
    () => hostedMonitorSchedule("*/5 * * * *", "2026-08-25T02:00:00.000Z"),
    /Cron is unsupported/,
  )
})

test("hosted monitor can be disabled without monitor bindings", async () => {
  assert.equal(hostedMonitorIsEnabled({}), false)
  assert.deepEqual(await runHostedFleetMonitor({}), {
    enabled: false,
    skipped: true,
  })
  assert.throws(
    () => hostedMonitorIsEnabled({ FLEET_MONITOR_ENABLED: "yes" }),
    /binding is invalid/,
  )
})

test("hosted monitor requires its Hookrelay service binding", async (context) => {
  const env = environment(context)
  delete env.FLEET_MONITOR_HOOKRELAY

  await assert.rejects(
    runHostedFleetMonitor(env),
    /Hookrelay service binding is unavailable/,
  )
})

test("monitor fetch budget refuses excess external requests", async () => {
  const budget = createMonitorFetchBudget(
    async () => new Response(null, { status: 204 }),
    1,
  )

  assert.equal((await budget.fetch("https://example.com")).status, 204)
  await assert.rejects(
    budget.fetch("https://example.com"),
    (error) => error instanceof MonitorSubrequestBudgetError,
  )
  assert.equal(budget.used, 1)
})
