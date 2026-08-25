import assert from "node:assert/strict"
import { createHmac } from "node:crypto"
import test from "node:test"

import {
  analyticsFailureObservation,
  catalogEndpointsForZone,
  createEmptyMonitorEndpointState,
  createMonitorCloudEvent,
  createMonitorIncident,
  MONITOR_SELECTION_REASON,
  MONITOR_TRANSITION,
  normalizeHookrelayUrl,
  probeHttpObservation,
  probeNetworkObservation,
  reduceMonitorEndpoint,
  resolveMonitorIncident,
  selectMonitorEndpoints,
  signHookrelayPayload,
} from "../src/monitor.mjs"

const OBSERVED_AT = "2026-08-25T01:02:00.000Z"

function endpoint(hostname = "app.example.com") {
  return {
    hostname,
    zoneId: "zone-one",
    zoneName: "example.com",
  }
}

test("monitor catalog keeps exact proxied HTTP record names", () => {
  const endpoints = catalogEndpointsForZone(
    { id: "zone-one", name: "Example.COM" },
    [
      { name: "example.com", proxied: true, type: "A" },
      { name: "example.com.", proxied: true, type: "AAAA" },
      { name: "app.example.com", proxied: true, type: "CNAME" },
      { name: "mail.example.com", proxied: false, type: "A" },
      { name: "*.example.com", proxied: true, type: "CNAME" },
      { name: "_dcv.example.com", proxied: true, type: "CNAME" },
      { name: "example.com", proxied: true, type: "MX" },
    ],
    "generation-one",
    OBSERVED_AT,
  )

  assert.deepEqual(endpoints, [
    {
      catalogGeneration: "generation-one",
      discoveredAt: OBSERVED_AT,
      hostname: "app.example.com",
      recordTypes: ["CNAME"],
      zoneId: "zone-one",
      zoneName: "example.com",
    },
    {
      catalogGeneration: "generation-one",
      discoveredAt: OBSERVED_AT,
      hostname: "example.com",
      recordTypes: ["A", "AAAA"],
      zoneId: "zone-one",
      zoneName: "example.com",
    },
  ])
})

test("monitor selection favors apex, active traffic, and explicit policy", () => {
  const endpoints = [
    endpoint("example.com"),
    endpoint("active.example.com"),
    endpoint("included.example.com"),
    endpoint("excluded.example.com"),
    {
      ...endpoint("recovering.example.com"),
      state: { activeIncidentId: "incident-one" },
    },
    endpoint("idle.example.com"),
  ]
  const selected = selectMonitorEndpoints(endpoints, [
    {
      count: 100,
      dimensions: {
        clientRequestHTTPHost: "active.example.com",
        zoneTag: "zone-one",
      },
    },
    {
      count: 200,
      dimensions: {
        clientRequestHTTPHost: "excluded.example.com",
        zoneTag: "zone-one",
      },
    },
  ], {
    endpointMonitoring: {
      excludeHostnames: ["excluded.example.com"],
      includeHostnames: ["included.example.com"],
    },
  })

  assert.deepEqual(
    selected.map((entry) => [entry.hostname, entry.selected, entry.selectionReason]),
    [
      ["example.com", true, MONITOR_SELECTION_REASON.ZONE_APEX],
      ["active.example.com", true, MONITOR_SELECTION_REASON.ACTIVE_TRAFFIC],
      ["included.example.com", true, MONITOR_SELECTION_REASON.INCLUDED],
      ["excluded.example.com", false, MONITOR_SELECTION_REASON.EXCLUDED],
      ["recovering.example.com", true, MONITOR_SELECTION_REASON.OPEN_INCIDENT],
      ["idle.example.com", false, MONITOR_SELECTION_REASON.INACTIVE],
    ],
  )
})

test("Cloudflare edge failures open immediately and require two successes to resolve", () => {
  const failure = analyticsFailureObservation({
    count: 3,
    dimensions: {
      datetimeMinute: OBSERVED_AT,
      edgeResponseStatus: 526,
    },
  })
  const opened = reduceMonitorEndpoint(
    createEmptyMonitorEndpointState(),
    failure,
    "incident-one",
  )
  const firstSuccess = reduceMonitorEndpoint(
    opened.state,
    probeHttpObservation(200, "2026-08-25T01:05:00.000Z"),
  )
  const resolved = reduceMonitorEndpoint(
    firstSuccess.state,
    probeHttpObservation(403, "2026-08-25T01:10:00.000Z"),
  )

  assert.deepEqual(opened.transition, {
    incidentId: "incident-one",
    kind: MONITOR_TRANSITION.OPENED,
  })
  assert.equal(firstSuccess.transition, null)
  assert.deepEqual(resolved.transition, {
    incidentId: "incident-one",
    kind: MONITOR_TRANSITION.RESOLVED,
  })
  assert.equal(resolved.state.activeIncidentId, null)
})

test("generic HTTP and network failures require consecutive observations", () => {
  const first = reduceMonitorEndpoint(
    createEmptyMonitorEndpointState(),
    probeHttpObservation(502, OBSERVED_AT),
  )
  const second = reduceMonitorEndpoint(
    first.state,
    probeNetworkObservation("network", "2026-08-25T01:07:00.000Z"),
    "incident-two",
  )

  assert.equal(first.transition, null)
  assert.deepEqual(second.transition, {
    incidentId: "incident-two",
    kind: MONITOR_TRANSITION.OPENED,
  })
})

test("monitor CloudEvents describe problem and recovery transitions", () => {
  const failure = analyticsFailureObservation({
    count: 7,
    dimensions: {
      datetimeMinute: OBSERVED_AT,
      edgeResponseStatus: 526,
    },
  })
  const incident = createMonitorIncident(
    endpoint("status.example.com"),
    failure,
    "incident-three",
    "2026-08-25T01:03:00.000Z",
  )
  const problem = createMonitorCloudEvent(incident, MONITOR_TRANSITION.OPENED)
  const recovered = createMonitorCloudEvent(
    resolveMonitorIncident(incident, "2026-08-25T01:13:00.000Z"),
    MONITOR_TRANSITION.RESOLVED,
  )

  assert.equal(problem.id, "incident-three/opened")
  assert.equal(problem.severity, "error")
  assert.match(problem.title, /HTTP 526/)
  assert.equal(problem.data.requestCount, 7)
  assert.equal(recovered.id, "incident-three/resolved")
  assert.equal(recovered.severity, "info")
  assert.equal(recovered.data.state, "recovered")
})

test("Hookrelay URL validation and signing match the sender contract", async () => {
  const slug = "a".repeat(22)
  const url = `https://hooks.example.com/hook/cloudevents/${slug}`
  const body = JSON.stringify({ id: "event-one" })
  const secret = "sender-secret"

  assert.equal(normalizeHookrelayUrl(url), `${url}`)
  assert.throws(
    () => normalizeHookrelayUrl(`http://hooks.example.com/hook/cloudevents/${slug}`),
    /invalid/,
  )
  assert.throws(() => normalizeHookrelayUrl(null), /invalid/)
  assert.equal(
    await signHookrelayPayload(body, secret),
    createHmac("sha256", secret).update(body).digest("hex"),
  )
})
