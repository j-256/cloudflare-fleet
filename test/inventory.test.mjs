import assert from "node:assert/strict"
import test from "node:test"

import {
  coverageFor,
  coverageIssueCanonical,
  loadInventory,
  staticCoverageIssues,
} from "../src/inventory.mjs"
import { CloudflareApiError } from "../src/api.mjs"
import { STATIC_LIMITATIONS } from "../src/constants.mjs"

function zone(name) {
  return {
    id: `zone-${name}`,
    name,
  }
}

test("scoped inventory reads only requested surfaces", async () => {
  const requests = []
  const api = {
    accountId: "account-id",
    async listEmailAddresses() {
      throw new Error("Email addresses should not be read")
    },
    async listZones() {
      return [
        zone("alpha.example"),
        zone("beta.example"),
      ]
    },
    async request(path) {
      requests.push(path)
      return {
        result: [],
        status: 200,
      }
    },
  }

  const inventory = await loadInventory(api, {
    includeEmailAddresses: false,
    surfaceIds: [
      "dns",
      "settings",
    ],
  })

  assert.equal(inventory.account.emailAddresses.skipped, true)
  assert.equal(requests.length, 4)
  assert.deepEqual(
    inventory.zones.map((entry) => Object.keys(entry.surfaces).sort()),
    [
      ["dns", "settings"],
      ["dns", "settings"],
    ],
  )
  assert.equal(requests.every((path) => /\/(dns_records|settings)/.test(path)), true)
})

test("ruleset-scoped inventory includes live rule details", async () => {
  const requests = []
  const api = {
    accountId: "account-id",
    async listZones() {
      return [zone("alpha.example")]
    },
    async request(path) {
      requests.push(path)
      if (path === "zones/zone-alpha.example/rulesets") {
        return {
          result: [
            {
              id: "ruleset-id",
              kind: "zone",
              phase: "http_request_firewall_custom",
            },
          ],
          status: 200,
        }
      }
      return {
        result: {
          id: "ruleset-id",
          kind: "zone",
          phase: "http_request_firewall_custom",
          rules: [],
        },
        status: 200,
      }
    },
  }

  const inventory = await loadInventory(api, {
    includeEmailAddresses: false,
    surfaceIds: ["rulesets"],
  })

  assert.deepEqual(requests, [
    "zones/zone-alpha.example/rulesets",
    "zones/zone-alpha.example/rulesets/ruleset-id",
  ])
  assert.equal(inventory.zones[0].ruleDetails[0].ok, true)
  assert.equal(inventory.zones[0].ruleDetails[0].result.id, "ruleset-id")
})

test("zone-scoped inventory reads only the requested zones", async () => {
  const requests = []
  const api = {
    accountId: "account-id",
    async listZones() {
      return [
        zone("alpha.example"),
        zone("beta.example"),
      ]
    },
    async request(path) {
      requests.push(path)
      return {
        result: [],
        status: 200,
      }
    },
  }

  const inventory = await loadInventory(api, {
    includeEmailAddresses: false,
    includeRuleDetails: false,
    surfaceIds: ["rulesets"],
    zoneIds: ["zone-beta.example"],
  })

  assert.deepEqual(requests, [
    "zones/zone-beta.example/rulesets",
  ])
  assert.deepEqual(
    inventory.zones.map((entry) => entry.meta.name),
    ["beta.example"],
  )
})

test("rule detail filters read only matching zone entrypoints", async () => {
  const requests = []
  const api = {
    accountId: "account-id",
    async listZones() {
      return [zone("alpha.example")]
    },
    async request(path) {
      requests.push(path)
      if (path === "zones/zone-alpha.example/rulesets") {
        return {
          result: [
            {
              id: "wanted",
              kind: "zone",
              phase: "http_request_dynamic_redirect",
            },
            {
              id: "other-phase",
              kind: "zone",
              phase: "http_request_firewall_custom",
            },
            {
              id: "custom",
              kind: "custom",
              phase: "http_request_dynamic_redirect",
            },
          ],
          status: 200,
        }
      }
      return {
        result: {
          id: "wanted",
          kind: "zone",
          phase: "http_request_dynamic_redirect",
          rules: [],
        },
        status: 200,
      }
    },
  }

  const inventory = await loadInventory(api, {
    includeEmailAddresses: false,
    ruleDetailKinds: ["zone"],
    ruleDetailPhases: ["http_request_dynamic_redirect"],
    surfaceIds: ["rulesets"],
  })

  assert.deepEqual(requests, [
    "zones/zone-alpha.example/rulesets",
    "zones/zone-alpha.example/rulesets/wanted",
  ])
  assert.deepEqual(
    inventory.zones[0].ruleDetails.map((detail) => detail.result.id),
    ["wanted"],
  )
})

test("scoped inventory rejects unknown surfaces", async () => {
  const api = {
    accountId: "account-id",
  }

  await assert.rejects(
    loadInventory(api, {
      surfaceIds: ["not-a-surface"],
    }),
    /Unknown inventory surface/,
  )
})

test("inventory fails closed when a surface remains throttled", async () => {
  const api = {
    accountId: "account-id",
    async listZones() {
      return [zone("alpha.example")]
    },
    async request() {
      throw new CloudflareApiError("Cloudflare read throttled", {
        status: 429,
      })
    },
  }

  await assert.rejects(
    loadInventory(api, {
      includeEmailAddresses: false,
      surfaceIds: ["settings"],
    }),
    (error) => error instanceof CloudflareApiError && error.status === 429,
  )
})

test("zone-scoped inventory rejects unknown zone identifiers", async () => {
  const api = {
    accountId: "account-id",
    async listEmailAddresses() {
      return []
    },
    async listZones() {
      return [zone("alpha.example")]
    },
  }

  await assert.rejects(
    loadInventory(api, {
      zoneIds: ["zone-missing.example"],
    }),
    /Unknown zone identifier/,
  )
})

test("coverage failures expose stable intent targets and friendly details", () => {
  const error = {
    errors: [{ code: 1001, message: "Product is not enabled" }],
    message: "GET /bot_management failed",
    status: 403,
  }
  const inventory = {
    zones: [{
      meta: {
        id: "zone-alpha",
        name: "alpha.example",
      },
      surfaces: {
        "bot-management": {
          error,
          ok: false,
        },
      },
    }],
  }

  const coverage = coverageFor(inventory).find(
    (entry) => entry.id === "bot-management",
  )
  assert.equal(coverage.ok, false)
  assert.deepEqual(coverage.failed[0], {
    detail: "Product is not enabled",
    error,
    kind: "surface",
    observedCanonical: "{\"codes\":[1001],\"message\":null,\"status\":403}",
    subjectId: "bot-management",
    subjectLabel: "Bot management",
    zoneId: "zone-alpha",
    zoneName: "alpha.example",
  })
  assert.equal(
    coverageIssueCanonical({
      ...error,
      errors: [{ code: 1001, message: "Wording changed" }],
    }),
    coverage.failed[0].observedCanonical,
  )
  assert.notEqual(
    coverageIssueCanonical({ ...error, status: 401 }),
    coverage.failed[0].observedCanonical,
  )
})

test("static limitations have stable fleet-wide coverage targets", () => {
  const issues = staticCoverageIssues(STATIC_LIMITATIONS)

  assert.equal(
    new Set(issues.map((issue) => issue.subjectId)).size,
    STATIC_LIMITATIONS.length,
  )
  assert.equal(issues.every((issue) => (
    issue.kind === "limitation"
      && issue.zoneId === null
      && issue.zoneName === null
      && issue.observedCanonical.length > 0
  )), true)
})
