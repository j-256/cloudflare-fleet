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
    return Promise.resolve(new Response(JSON.stringify({
      Answer: [],
      Status: 3,
    }), {
      headers: { "Content-Type": "application/dns-json" },
      status: 200,
    }))
  }
  assert.equal(url.hostname, "app.alpha.example")
  return Promise.resolve(new Response(null, { status: 530 }))
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
    list: async (path) => path.endsWith("/scripts")
      ? [{ handlers: ["fetch"], id: "orphan-worker" }]
      : [],
    request: async (path) => path.endsWith("/subdomain")
      ? { result: { enabled: false } }
      : { result: { schedules: [] } },
  }

  const findings = await collectDeepAuditFindings(
    api,
    makeInventory([zone]),
    {
      fetchImpl: deepFetch,
      now: Date.parse("2026-08-09T18:00:00.000Z"),
    },
  )
  const ids = new Set(findings.map((entry) => entry.id))

  assert.ok(ids.has("deep.dnssec-parent-ds-missing:alpha.example"))
  assert.ok(ids.has("deep.cname-target-nxdomain:missing-target.example"))
  assert.ok(ids.has("deep.endpoint-http-530:app.alpha.example"))
  assert.ok(ids.has("deep.worker-no-discovered-ingress:orphan-worker"))
  assert.equal([...ids].some((id) => id.includes("dcv.cloudflare.com")), false)
})
