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
        return jsonResponse({
          data: {
            viewer: {
              accounts: [{
                active: [
                  {
                    count: 150,
                    dimensions: {
                      clientRequestHTTPHost: "app.example.com",
                      zoneTag: "zone-one",
                    },
                  },
                  {
                    count: 10000,
                    dimensions: {
                      clientRequestHTTPHost: "forged.example.com",
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

test("hosted monitor detects, reports, and resolves a 526 incident", async (context) => {
  const transport = monitorTransport()
  const env = environment(context, transport.fetch)
  let nextId = 0
  const options = {
    fetchImpl: transport.fetch,
    logger: { error() {}, warn() {} },
    randomId: () => `id-${nextId += 1}`,
  }

  const first = await runHostedFleetMonitor(env, {
    ...options,
    now: "2026-08-25T02:00:00.000Z",
  })
  let status = await readHostedMonitorStatus(env.FLEET_DB, ACCOUNT_ID)

  assert.equal(first.errors.length, 0)
  assert.equal(first.analyticsObservations, 1)
  assert.equal(first.probes, 2)
  assert.equal(first.subrequests, 5)
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
  const second = await runHostedFleetMonitor(env, {
    ...options,
    now: "2026-08-25T02:05:00.000Z",
  })
  status = await readHostedMonitorStatus(env.FLEET_DB, ACCOUNT_ID)
  assert.equal(second.probes, 2)
  assert.equal(status.endpoints.open, 1)
  assert.equal(transport.deliveries.length, 1)

  const third = await runHostedFleetMonitor(env, {
    ...options,
    now: "2026-08-25T02:10:00.000Z",
  })
  status = await readHostedMonitorStatus(env.FLEET_DB, ACCOUNT_ID)
  assert.equal(third.probes, 2)
  assert.equal(status.endpoints.open, 0)
  assert.equal(status.recentIncidents[0].status, "resolved")
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
  assert.equal(graphReads.length, 3)
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

test("hosted monitor does not advance analytics before its catalog is ready", async (context) => {
  const env = environment(context)
  const result = await runHostedFleetMonitor(env, {
    fetchImpl: async (input) => {
      const url = new URL(input)
      if (url.pathname.endsWith("/zones")) {
        return jsonResponse({
          errors: [{ message: "unavailable" }],
          messages: [],
          result: null,
          success: false,
        }, 503)
      }
      if (url.pathname.endsWith("/graphql")) {
        return jsonResponse({
          data: {
            viewer: {
              accounts: [{ active: [], errors: [] }],
            },
          },
          errors: null,
        })
      }
      throw new Error(`Unexpected monitor request: ${url}`)
    },
    logger: { error() {}, warn() {} },
    now: "2026-08-25T02:00:00.000Z",
    randomId: () => "fixed-id",
  })
  const status = await readHostedMonitorStatus(env.FLEET_DB, ACCOUNT_ID)

  assert.deepEqual(result.errors, ["catalog-read"])
  assert.equal(status.analyticsCursorAt, null)
  assert.equal(status.catalog.completedAt, null)
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
