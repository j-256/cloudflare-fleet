import assert from "node:assert/strict"
import test from "node:test"

import { collectDeepAuditFindings } from "../src/audit-deep.mjs"
import { SURFACES } from "../src/constants.mjs"
import {
  makeInventory,
  makeZone,
  ok,
} from "./fixtures.mjs"

function completeSurfaces(zone) {
  for (const surface of SURFACES) {
    if (!zone.surfaces[surface.id]) zone.surfaces[surface.id] = ok([])
  }
  return zone
}

function deepFetch(input) {
  const url = new URL(input)
  if (url.hostname === "cloudflare-dns.com") {
    const type = url.searchParams.get("type")
    const name = url.searchParams.get("name")
    const addressAnswers = {
      "app.alpha.example": ["192.0.2.1"],
      "fallback.alpha.example": ["192.0.2.2", "192.0.2.3"],
      "offline.alpha.example": ["192.0.2.1"],
    }
    const answers = type === "A" && addressAnswers[name]
      ? addressAnswers[name].map((data) => ({ data, type: 1 }))
      : type === "CDS"
      ? [{ data: "2371 13 2 digest", type: 59 }]
      : type === "CDNSKEY"
        ? [{ data: "257 3 13 key", type: 60 }]
        : []
    return Promise.resolve(new Response(JSON.stringify({
      Answer: answers,
      Status: answers.length > 0 ? 0 : 3,
    }), {
      headers: { "Content-Type": "application/dns-json" },
      status: 200,
    }))
  }
  throw new Error(`Unexpected fetch URL: ${url}`)
}

test("deep audit correlates public DNS, endpoints, and Worker ingress", async () => {
  const zone = completeSurfaces(makeZone("alpha.example", {
    dns: [{
      content: "missing-target.example",
      id: "app-cname",
      name: "app.alpha.example",
      proxied: true,
      ttl: 1,
      type: "CNAME",
    }, {
      content: "app.alpha.example.validation.dcv.cloudflare.com",
      id: "dcv-cname",
      name: "_dcv.alpha.example",
      proxied: false,
      ttl: 300,
      type: "CNAME",
    }, {
      content: "192.0.2.1",
      id: "offline-address",
      name: "offline.alpha.example",
      proxied: true,
      ttl: 1,
      type: "A",
    }, {
      content: "192.0.2.2",
      id: "fallback-address",
      name: "fallback.alpha.example",
      proxied: true,
      ttl: 1,
      type: "A",
    }],
    emailRules: [],
    surfaces: {
      dnssec: ok({
        modified_on: "2026-08-01T00:00:00.000Z",
        status: "active",
      }),
      "workers-routes": ok([]),
    },
  }))
  const api = {
    accountId: "account-id",
    graphql: async (query) => query.includes("httpRequestsAdaptiveGroups")
      ? {
          viewer: {
            zones: [{
              rows: [{
                count: 250,
                dimensions: {
                  clientRequestHTTPHost: "app.alpha.example",
                },
              }],
            }],
          },
        }
      : { viewer: { accounts: [{ rows: [] }] } },
    list: async (path) => path.endsWith("/scripts")
      ? [{ handlers: ["fetch"], id: "orphan-worker" }]
      : [],
    request: async (path) => path.endsWith("/pages/projects")
      ? { result: [] }
      : path.endsWith("/r2/buckets")
        ? { result: { buckets: [] } }
        : path.includes("/registrar/registrations")
          ? { result: [], resultInfo: { cursor: "" } }
          : path.endsWith("/subdomain")
            ? { result: { enabled: false } }
            : path.endsWith("/settings")
              ? { result: { bindings: [] } }
              : { result: { schedules: [] } },
  }

  const findings = await collectDeepAuditFindings(
    api,
    makeInventory([zone]),
    {
      endpointProbe: async (target) => {
        if (target.hostname === "offline.alpha.example") {
          assert.equal(target.address, "192.0.2.1")
          throw new Error("connection reset")
        }
        if (target.hostname === "fallback.alpha.example") {
          if (target.address === "192.0.2.2") {
            throw new Error("first address unavailable")
          }
          assert.equal(target.address, "192.0.2.3")
          return { status: 204 }
        }
        assert.equal(target.hostname, "app.alpha.example")
        assert.equal(target.address, "192.0.2.1")
        return { status: 530 }
      },
      fetchImpl: deepFetch,
      now: Date.parse("2026-08-09T18:00:00.000Z"),
    },
  )
  const ids = new Set(findings.map((entry) => entry.id))

  assert.ok(ids.has("deep.dnssec-parent-ds-missing:alpha.example"))
  assert.ok(ids.has("deep.cname-target-nxdomain:missing-target.example"))
  assert.ok(ids.has("deep.endpoint-http-530:app.alpha.example"))
  const failedEndpoint = findings.find(
    (entry) => entry.id === "deep.endpoint-http-530:app.alpha.example",
  )
  assert.equal(failedEndpoint.evidence.traffic.requestCount, 250)
  assert.match(failedEndpoint.recommendation, /Traffic reached/)
  const unreachable = findings.find(
    (entry) => entry.id === "deep.endpoints-unreachable",
  )
  assert.match(unreachable.detail, /could not complete a header-only request/)
  assert.equal([...ids].some((id) => id.includes("fallback.alpha.example")), false)
  assert.ok(ids.has("deep.worker-no-discovered-ingress:orphan-worker"))
  assert.equal([...ids].some((id) => id.includes("dcv.cloudflare.com")), false)
  const parentDs = findings.find(
    (entry) => entry.id === "deep.dnssec-parent-ds-missing:alpha.example",
  )
  assert.deepEqual(parentDs.evidence.childSignals.cds, ["2371 13 2 digest"])
  assert.deepEqual(parentDs.evidence.childSignals.cdnskey, ["257 3 13 key"])
  assert.match(parentDs.recommendation, /child is signaling/i)
})

test("deep audit compares public delegation with assigned full-zone nameservers", async () => {
  const zone = completeSurfaces(makeZone("alpha.example"))
  zone.meta.name_servers = ["maya.ns.cloudflare.com", "tony.ns.cloudflare.com"]
  const api = {
    accountId: "account-id",
    graphql: async () => ({ viewer: { accounts: [{ rows: [] }] } }),
    list: async () => [],
    request: async (path) => path.endsWith("/r2/buckets")
      ? { result: { buckets: [] } }
      : path.includes("/registrar/registrations")
        ? { result: [], resultInfo: { cursor: "" } }
        : { result: {} },
  }
  const fetchImpl = async (input) => {
    const url = new URL(input)
    assert.equal(url.hostname, "cloudflare-dns.com")
    return new Response(JSON.stringify({
      Answer: url.searchParams.get("type") === "NS"
        ? [{ data: "other.ns.example.", type: 2 }]
        : [],
      Status: 0,
    }), {
      headers: { "Content-Type": "application/dns-json" },
      status: 200,
    })
  }

  const findings = await collectDeepAuditFindings(
    api,
    makeInventory([zone]),
    { fetchImpl, now: Date.parse("2026-08-09T18:00:00.000Z") },
  )
  const delegation = findings.find(
    (entry) => entry.id === "deep.delegation-nameserver-mismatch:alpha.example",
  )

  assert.deepEqual(delegation.evidence.assignedNameservers, [
    "maya.ns.cloudflare.com",
    "tony.ns.cloudflare.com",
  ])
  assert.deepEqual(delegation.evidence.publicNameservers, ["other.ns.example"])
})
