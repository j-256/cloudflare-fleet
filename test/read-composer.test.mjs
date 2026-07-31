import assert from "node:assert/strict"
import test from "node:test"

import {
  actionResourceId,
  composeActionReadPlan,
  composeReadPlan,
  READ_ACTION,
  executeActionReadPlan,
  executeReadPlan,
  inventoryRead,
  resourceRead,
  rulesetPhaseRead,
} from "../src/read-composer.mjs"

test("read composer merges inventory requirements and deduplicates resources", () => {
  const plan = composeReadPlan([
    inventoryRead({
      includeRuleDetails: true,
      ruleDetailKinds: ["zone"],
      ruleDetailPhases: ["http_request_dynamic_redirect"],
      surfaceIds: ["rulesets"],
      zoneIds: ["zone-alpha"],
    }),
    inventoryRead({
      includeEmailAddresses: true,
      includeRuleDetails: true,
      ruleDetailKinds: ["custom", "zone"],
      ruleDetailPhases: ["http_request_firewall_custom"],
      surfaceIds: ["dns", "rulesets"],
      zoneIds: ["zone-beta"],
    }),
    resourceRead("record", "zones/zone-alpha/dns_records/record-id"),
    resourceRead("record", "zones/zone-alpha/dns_records/record-id"),
  ])

  assert.deepEqual(plan, {
    inventory: {
      includeEmailAddresses: true,
      includeRuleDetails: true,
      ruleDetailKinds: ["zone", "custom"],
      ruleDetailPhases: [
        "http_request_dynamic_redirect",
        "http_request_firewall_custom",
      ],
      surfaceIds: ["rulesets", "dns"],
      zoneIds: ["zone-alpha", "zone-beta"],
    },
    resources: [
      {
        id: "record",
        kind: "resource",
        path: "zones/zone-alpha/dns_records/record-id",
      },
    ],
    rulePhases: [],
  })
})

test("an all-zone or all-phase requirement widens the composed read", () => {
  const plan = composeReadPlan([
    inventoryRead({
      includeRuleDetails: true,
      ruleDetailKinds: ["zone"],
      ruleDetailPhases: ["http_request_dynamic_redirect"],
      surfaceIds: ["rulesets"],
      zoneIds: ["zone-alpha"],
    }),
    inventoryRead({
      includeRuleDetails: true,
      surfaceIds: ["rulesets"],
    }),
  ])

  assert.deepEqual(plan.inventory, {
    includeEmailAddresses: false,
    includeRuleDetails: true,
    surfaceIds: ["rulesets"],
  })
})

test("read composer executes direct and inventory reads together", async () => {
  const requests = []
  const api = {
    accountId: "account-id",
    async listZones() {
      return [
        {
          id: "zone-alpha",
          name: "alpha.example",
        },
      ]
    },
    async request(path) {
      requests.push(path)
      return {
        result: path.endsWith("record-id") ? { id: "record-id" } : [],
        status: 200,
      }
    },
  }

  const result = await executeReadPlan(api, [
    inventoryRead({
      surfaceIds: ["dns"],
      zoneIds: ["zone-alpha"],
    }),
    resourceRead("record", "zones/zone-alpha/dns_records/record-id"),
  ])

  assert.deepEqual(requests.sort(), [
    "zones/zone-alpha/dns_records/record-id",
    "zones/zone-alpha/dns_records?per_page=5000",
  ])
  assert.equal(result.inventory.zones[0].meta.name, "alpha.example")
  assert.deepEqual(result.resources.get("record"), { id: "record-id" })
})

test("read composer rejects conflicting resource identifiers", () => {
  assert.throws(
    () => composeReadPlan([
      resourceRead("record", "zones/a/dns_records/one"),
      resourceRead("record", "zones/a/dns_records/two"),
    ]),
    /maps to multiple resource paths/,
  )
})

test("action composer derives scoped Cloudflare reads from required actions", () => {
  const settingAction = {
    settingId: "always_use_https",
    type: READ_ACTION.ZONE_SETTING_EDIT,
    zoneId: "zone-alpha",
  }
  const plan = composeActionReadPlan([
    settingAction,
    {
      phase: "http_request_dynamic_redirect",
      rulesetId: "source-ruleset",
      sourceZoneId: "zone-alpha",
      targetZoneIds: ["zone-beta"],
      type: READ_ACTION.RULE_COPY,
    },
  ])

  assert.equal(actionResourceId(settingAction), "setting:zone-alpha:always_use_https")
  assert.deepEqual(plan, {
    inventory: {
      includeEmailAddresses: false,
      includeRuleDetails: false,
      surfaceIds: [],
      zoneIds: ["zone-alpha", "zone-beta"],
    },
    resources: [
      {
        id: "setting:zone-alpha:always_use_https",
        kind: "resource",
        path: "zones/zone-alpha/settings/always_use_https",
      },
      {
        id: "ruleset:zone-alpha:source-ruleset",
        kind: "resource",
        path: "zones/zone-alpha/rulesets/source-ruleset",
      },
    ],
    rulePhases: [
      {
        id: "ruleset-phase:zone-beta:http_request_dynamic_redirect",
        kind: "ruleset-phase",
        kinds: ["zone"],
        phase: "http_request_dynamic_redirect",
        zoneId: "zone-beta",
      },
    ],
  })
})

test("DNS hole resolution reads only source and target DNS surfaces", () => {
  const plan = composeActionReadPlan([
    {
      sourceZoneId: "zone-alpha",
      targetZoneId: "zone-beta",
      type: READ_ACTION.DNS_RECORD_COPY,
    },
  ])

  assert.deepEqual(plan, {
    inventory: {
      includeEmailAddresses: false,
      includeRuleDetails: false,
      surfaceIds: ["dns"],
      zoneIds: ["zone-alpha", "zone-beta"],
    },
    resources: [],
    rulePhases: [],
  })
})

test("DNS target fills merge one source with every selected destination", () => {
  const plan = composeActionReadPlan([
    {
      sourceZoneId: "source-zone",
      targetZoneId: "target-one",
      type: READ_ACTION.DNS_RECORD_COPY,
    },
    {
      sourceZoneId: "source-zone",
      targetZoneId: "target-two",
      type: READ_ACTION.DNS_RECORD_COPY,
    },
  ])

  assert.deepEqual(plan.inventory, {
    includeEmailAddresses: false,
    includeRuleDetails: false,
    surfaceIds: ["dns"],
    zoneIds: ["source-zone", "target-one", "target-two"],
  })
})

test("rule edits compose to the exact live ruleset resource", () => {
  const action = {
    phase: "http_request_sanitize",
    ruleId: "rule-id",
    rulesetId: "ruleset-id",
    type: READ_ACTION.RULE_EDIT,
    zoneId: "zone-alpha",
  }

  assert.equal(actionResourceId(action), "ruleset:zone-alpha:ruleset-id")
  assert.deepEqual(composeActionReadPlan([action]), {
    inventory: null,
    resources: [
      {
        id: "ruleset:zone-alpha:ruleset-id",
        kind: "resource",
        path: "zones/zone-alpha/rulesets/ruleset-id",
      },
    ],
    rulePhases: [],
  })
})

test("existing ruleset workspace actions deduplicate to one exact detail read", () => {
  const actionTypes = [
    READ_ACTION.RULE_DELETE,
    READ_ACTION.RULE_EDIT,
    READ_ACTION.RULE_REORDER,
    READ_ACTION.RULESET_DELETE,
    READ_ACTION.RULESET_EDIT,
    READ_ACTION.RULESET_INSPECT,
  ]
  const plan = composeActionReadPlan(actionTypes.map((type) => ({
    rulesetId: "ruleset-id",
    type,
    zoneId: "zone-alpha",
  })))

  assert.deepEqual(plan, {
    inventory: null,
    resources: [
      {
        id: "ruleset:zone-alpha:ruleset-id",
        kind: "resource",
        path: "zones/zone-alpha/rulesets/ruleset-id",
      },
    ],
    rulePhases: [],
  })
})

test("rule creation reads every quota-bearing ruleset in the target phase", () => {
  const plan = composeActionReadPlan([
    {
      phase: "http_request_firewall_custom",
      rulesetId: "ruleset-id",
      type: READ_ACTION.RULE_CREATE,
      zoneId: "zone-alpha",
    },
  ])

  assert.deepEqual(plan, {
    inventory: {
      includeEmailAddresses: false,
      includeRuleDetails: true,
      ruleDetailKinds: ["zone", "custom"],
      ruleDetailPhases: ["http_request_firewall_custom"],
      surfaceIds: ["rulesets"],
      zoneIds: ["zone-alpha"],
    },
    resources: [],
    rulePhases: [],
  })
})

test("fleet rule rename reads live metadata and exact rulesets only", () => {
  const plan = composeActionReadPlan([
    {
      rules: [
        {
          phase: "http_request_dynamic_redirect",
          ruleId: "alpha-rule",
          rulesetId: "alpha-entrypoint",
          zoneId: "zone-alpha",
        },
        {
          phase: "http_request_dynamic_redirect",
          ruleId: "beta-rule",
          rulesetId: "beta-entrypoint",
          zoneId: "zone-beta",
        },
      ],
      type: READ_ACTION.RULE_RENAME,
    },
  ])

  assert.deepEqual(plan, {
    inventory: {
      includeEmailAddresses: false,
      includeRuleDetails: false,
      surfaceIds: [],
      zoneIds: ["zone-alpha", "zone-beta"],
    },
    resources: [
      {
        id: "ruleset:zone-alpha:alpha-entrypoint",
        kind: "resource",
        path: "zones/zone-alpha/rulesets/alpha-entrypoint",
      },
      {
        id: "ruleset:zone-beta:beta-entrypoint",
        kind: "resource",
        path: "zones/zone-beta/rulesets/beta-entrypoint",
      },
    ],
    rulePhases: [],
  })
})

test("ruleset phase reads discover and fetch only matching live details", async () => {
  const requests = []
  const api = {
    async request(path) {
      requests.push(path)
      if (path.endsWith("/rulesets")) {
        return {
          result: [
            {
              id: "redirect-entrypoint",
              kind: "zone",
              phase: "http_request_dynamic_redirect",
            },
            {
              id: "waf-entrypoint",
              kind: "zone",
              phase: "http_request_firewall_custom",
            },
          ],
          status: 200,
        }
      }
      return {
        result: {
          id: "redirect-entrypoint",
          kind: "zone",
          phase: "http_request_dynamic_redirect",
          rules: [],
        },
        status: 200,
      }
    },
  }

  const result = await executeReadPlan(api, [
    rulesetPhaseRead("zone-beta", "http_request_dynamic_redirect"),
  ])
  const phase = result.rulePhases.get(
    "ruleset-phase:zone-beta:http_request_dynamic_redirect",
  )

  assert.deepEqual(requests, [
    "zones/zone-beta/rulesets",
    "zones/zone-beta/rulesets/redirect-entrypoint",
  ])
  assert.deepEqual(phase.details.map((ruleset) => ruleset.id), [
    "redirect-entrypoint",
  ])
})

test("rule copy actions execute metadata, exact source, and target phase reads", async () => {
  const requests = []
  const api = {
    accountId: "account-id",
    async listZones() {
      return [
        {
          id: "zone-alpha",
          name: "alpha.example",
        },
        {
          id: "zone-beta",
          name: "beta.example",
        },
      ]
    },
    async request(path) {
      requests.push(path)
      if (path === "zones/zone-beta/rulesets") {
        return {
          result: [],
          status: 200,
        }
      }
      return {
        result: {
          id: "source-ruleset",
          kind: "zone",
          phase: "http_request_dynamic_redirect",
          rules: [],
        },
        status: 200,
      }
    },
  }

  await executeActionReadPlan(api, [
    {
      phase: "http_request_dynamic_redirect",
      rulesetId: "source-ruleset",
      sourceZoneId: "zone-alpha",
      targetZoneIds: ["zone-beta"],
      type: READ_ACTION.RULE_COPY,
    },
  ])

  assert.deepEqual(requests.sort(), [
    "zones/zone-alpha/rulesets/source-ruleset",
    "zones/zone-beta/rulesets",
  ])
})

test("action composer rejects incomplete action inputs", () => {
  assert.throws(
    () => composeActionReadPlan([
      {
        type: READ_ACTION.DNS_RECORD_EDIT,
        zoneId: "zone-alpha",
      },
    ]),
    /DNS record identifier is required/,
  )
  assert.throws(
    () => composeActionReadPlan([
      {
        phase: "http_request_dynamic_redirect",
        sourceZoneId: "zone-alpha",
        targetZoneIds: ["zone-beta"],
        type: READ_ACTION.RULE_COPY,
      },
    ]),
    /source ruleset identifier is required/,
  )
  assert.throws(
    () => composeActionReadPlan([
      {
        phase: "http_request_firewall_custom",
        type: READ_ACTION.RULE_CREATE,
        zoneId: "zone-alpha",
      },
    ]),
    /Rule create ruleset identifier is required/,
  )
  assert.throws(
    () => composeActionReadPlan([
      {
        rulesetId: "ruleset-id",
        type: READ_ACTION.RULE_CREATE,
        zoneId: "zone-alpha",
      },
    ]),
    /Rule create phase is required/,
  )
})
