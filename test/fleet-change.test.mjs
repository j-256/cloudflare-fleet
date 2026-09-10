import assert from "node:assert/strict"
import test from "node:test"

import {
  FLEET_CHANGE_STATUS,
  normalizeFleetChange,
  normalizeFleetChanges,
  prepareFleetChange,
  prepareFleetChanges,
} from "../src/fleet-change.mjs"
import { makeZone } from "./fixtures.mjs"

const ZONE = Object.freeze({
  meta: Object.freeze({ id: "zone-one", name: "one.example" }),
  ruleDetails: Object.freeze([]),
  surfaces: Object.freeze({}),
})

function scopedReads(resources = []) {
  return async () => ({
    inventory: {
      account: {},
      zones: [structuredClone(ZONE)],
    },
    resources: new Map(resources),
    rulePhases: new Map(),
  })
}

test("bounded change schema rejects arbitrary API passthrough fields", () => {
  assert.throws(
    () => normalizeFleetChange({
      desired: "on",
      kind: "zone-setting-update",
      method: "PATCH",
      path: "zones/zone-one/settings/always_use_https",
      settingId: "always_use_https",
      zoneId: "zone-one",
    }),
    /Fleet change is invalid/,
  )
  assert.throws(
    () => normalizeFleetChange({
      kind: "dns-record-copy",
      sourceRecordIds: ["record-one"],
      sourceZoneId: "zone-one",
      targetZoneIds: ["zone-one"],
    }),
    /source zone cannot also be a target zone/,
  )
})

test("zone setting change plans one exact write from a fresh resource read", async () => {
  const result = await prepareFleetChange(
    { accountId: "account-one" },
    {
      desired: "on",
      kind: "zone-setting-update",
      settingId: "always_use_https",
      zoneId: "zone-one",
    },
    {
      executeReadPlan: scopedReads([[
        "setting:zone-one:always_use_https",
        { editable: true, id: "always_use_https", value: "off" },
      ]]),
      readPolicy: async () => ({}),
      validatedAt: "2026-08-28T00:00:00.000Z",
    },
  )

  assert.equal(result.status, FLEET_CHANGE_STATUS.PLANNED)
  assert.match(result.planSet.digest, /^sha256:[a-f0-9]{64}$/)
  assert.deepEqual(result.planSet.preview, [{
    body: { value: "on" },
    currentValue: "off",
    label: "Set always_use_https",
    method: "PATCH",
    path: "zones/zone-one/settings/always_use_https",
    zoneId: "zone-one",
    zoneName: "one.example",
  }])
  assert.equal(Object.hasOwn(result.planSet.request, "method"), false)
  assert.equal(Object.hasOwn(result.planSet.request, "path"), false)
})

test("bounded change planner reports fresh no-ops and builder blockers", async () => {
  const noOp = await prepareFleetChange(
    { accountId: "account-one" },
    {
      desired: "on",
      kind: "zone-setting-update",
      settingId: "always_use_https",
      zoneId: "zone-one",
    },
    {
      executeReadPlan: scopedReads([[
        "setting:zone-one:always_use_https",
        { editable: true, id: "always_use_https", value: "on" },
      ]]),
      readPolicy: async () => ({}),
    },
  )
  const blocked = await prepareFleetChange(
    { accountId: "account-one" },
    {
      desired: "on",
      kind: "zone-setting-update",
      settingId: "always_use_https",
      zoneId: "zone-one",
    },
    {
      executeReadPlan: scopedReads([[
        "setting:zone-one:always_use_https",
        { editable: false, id: "always_use_https", value: "off" },
      ]]),
      readPolicy: async () => ({}),
    },
  )

  assert.equal(noOp.status, FLEET_CHANGE_STATUS.ALIGNED)
  assert.equal(noOp.planSet.preview.length, 0)
  assert.equal(blocked.status, FLEET_CHANGE_STATUS.BLOCKED)
  assert.equal(blocked.planSet, null)
  assert.match(blocked.reason, /read-only/)
})

test("bounded change batch accepts distinct direct requests and rejects unsafe members", () => {
  const changes = [
    {
      desired: "on",
      kind: "zone-setting-update",
      settingId: "always_use_https",
      zoneId: "zone-one",
    },
    {
      desired: "on",
      kind: "zone-setting-update",
      settingId: "early_hints",
      zoneId: "zone-one",
    },
  ]

  assert.deepEqual(normalizeFleetChanges(changes), changes)
  assert.throws(
    () => normalizeFleetChanges([changes[0], changes[0]]),
    /Fleet change requests must be unique/,
  )
  assert.throws(
    () => normalizeFleetChanges([{
      intent: { crons: [], mode: "disabled" },
      kind: "worker-schedules-update",
      worker: "example-worker",
    }]),
    /Fleet change batch is invalid/,
  )
})

test("bounded change batch composes reads into one digest-bound plan", async () => {
  let readCalls = 0
  const changes = [
    {
      desired: "on",
      kind: "zone-setting-update",
      settingId: "always_use_https",
      zoneId: "zone-one",
    },
    {
      desired: "on",
      kind: "zone-setting-update",
      settingId: "early_hints",
      zoneId: "zone-one",
    },
  ]
  const result = await prepareFleetChanges(
    { accountId: "account-one" },
    changes,
    {
      async executeReadPlan(_api, requirements) {
        readCalls += 1
        assert.equal(requirements.length, 3)
        return {
          inventory: {
            account: {},
            zones: [structuredClone(ZONE)],
          },
          resources: new Map([
            [
              "setting:zone-one:always_use_https",
              { editable: true, id: "always_use_https", value: "off" },
            ],
            [
              "setting:zone-one:early_hints",
              { editable: true, id: "early_hints", value: "off" },
            ],
          ]),
          rulePhases: new Map(),
        }
      },
      readPolicy: async () => ({}),
      validatedAt: "2026-09-10T00:00:00.000Z",
    },
  )

  assert.equal(readCalls, 1)
  assert.equal(result.status, FLEET_CHANGE_STATUS.PLANNED)
  assert.deepEqual(result.changes.map((entry) => entry.status), [
    FLEET_CHANGE_STATUS.PLANNED,
    FLEET_CHANGE_STATUS.PLANNED,
  ])
  assert.deepEqual(result.planSet.request, { changes })
  assert.deepEqual(
    result.planSet.preview.map((operation) => operation.path),
    [
      "zones/zone-one/settings/always_use_https",
      "zones/zone-one/settings/early_hints",
    ],
  )
  assert.match(result.planSet.digest, /^sha256:[a-f0-9]{64}$/)
})

test("bounded change batch fails closed when one member is blocked", async () => {
  const changes = [
    {
      desired: "on",
      kind: "zone-setting-update",
      settingId: "always_use_https",
      zoneId: "zone-one",
    },
    {
      desired: "on",
      kind: "zone-setting-update",
      settingId: "early_hints",
      zoneId: "zone-one",
    },
  ]
  const result = await prepareFleetChanges(
    { accountId: "account-one" },
    changes,
    {
      executeReadPlan: scopedReads([
        [
          "setting:zone-one:always_use_https",
          { editable: true, id: "always_use_https", value: "off" },
        ],
        [
          "setting:zone-one:early_hints",
          { editable: false, id: "early_hints", value: "off" },
        ],
      ]),
      readPolicy: async () => ({}),
    },
  )

  assert.equal(result.status, FLEET_CHANGE_STATUS.BLOCKED)
  assert.equal(result.planSet, null)
  assert.deepEqual(result.changes.map((entry) => entry.status), [
    FLEET_CHANGE_STATUS.PLANNED,
    FLEET_CHANGE_STATUS.BLOCKED,
  ])
  assert.match(result.reason, /2\. Update zone setting: .*read-only/)
})

test("bounded change batch rejects overlapping operation targets", async () => {
  const result = await prepareFleetChanges(
    { accountId: "account-one" },
    [
      {
        desired: "on",
        kind: "zone-setting-update",
        settingId: "always_use_https",
        zoneId: "zone-one",
      },
      {
        desired: "off",
        kind: "zone-setting-update",
        settingId: "always_use_https",
        zoneId: "zone-one",
      },
    ],
    {
      executeReadPlan: scopedReads([[
        "setting:zone-one:always_use_https",
        { editable: true, id: "always_use_https", value: "flexible" },
      ]]),
      readPolicy: async () => ({}),
    },
  )

  assert.equal(result.status, FLEET_CHANGE_STATUS.BLOCKED)
  assert.equal(result.planSet, null)
  assert.match(result.reason, /changes 1 and 2 produce overlapping writes/)
})

test("bounded change batch allows repeated operation paths within one member", async () => {
  const source = makeZone("alpha.example", {
    dns: [
      {
        content: "route1.mx.cloudflare.net",
        id: "mx-one",
        locked: false,
        name: "alpha.example",
        priority: 10,
        ttl: 1,
        type: "MX",
      },
      {
        content: "route2.mx.cloudflare.net",
        id: "mx-two",
        locked: false,
        name: "alpha.example",
        priority: 20,
        ttl: 1,
        type: "MX",
      },
    ],
  })
  const target = makeZone("beta.example", { dns: [] })
  const result = await prepareFleetChanges(
    { accountId: "account-one" },
    [{
      kind: "dns-record-copy",
      sourceRecordIds: ["mx-one", "mx-two"],
      sourceZoneId: source.meta.id,
      targetZoneIds: [target.meta.id],
    }],
    {
      executeReadPlan: async () => ({
        inventory: { account: {}, zones: [source, target] },
        resources: new Map(),
        rulePhases: new Map(),
      }),
      readPolicy: async () => ({}),
    },
  )

  assert.equal(result.status, FLEET_CHANGE_STATUS.PLANNED)
  assert.equal(result.planSet.preview.length, 2)
  assert.deepEqual(new Set(
    result.planSet.preview.map((operation) => operation.path),
  ), new Set([`zones/${target.meta.id}/dns_records`]))
})

test("bounded change batch retains aligned members without empty write plans", async () => {
  const changes = [
    {
      desired: "on",
      kind: "zone-setting-update",
      settingId: "always_use_https",
      zoneId: "zone-one",
    },
    {
      desired: "on",
      kind: "zone-setting-update",
      settingId: "early_hints",
      zoneId: "zone-one",
    },
  ]
  const result = await prepareFleetChanges(
    { accountId: "account-one" },
    changes,
    {
      executeReadPlan: scopedReads([
        [
          "setting:zone-one:always_use_https",
          { editable: true, id: "always_use_https", value: "on" },
        ],
        [
          "setting:zone-one:early_hints",
          { editable: true, id: "early_hints", value: "off" },
        ],
      ]),
      readPolicy: async () => ({}),
    },
  )

  assert.equal(result.status, FLEET_CHANGE_STATUS.PLANNED)
  assert.deepEqual(result.changes.map((entry) => entry.status), [
    FLEET_CHANGE_STATUS.ALIGNED,
    FLEET_CHANGE_STATUS.PLANNED,
  ])
  assert.equal(result.planSet.plans.length, 1)
  assert.equal(result.planSet.preview.length, 1)
  assert.match(result.reason, /1 requested change prepared as 1 bounded/)
})

test("bounded change batch prepares repeated expression edits across rules", async () => {
  const hostnameClause = " and not (http.host eq \"repos-live.j-256.dev\")"
  const ruleset = {
    id: "ruleset-one",
    kind: "zone",
    name: "default",
    phase: "http_request_firewall_custom",
    rules: [
      {
        action: "block",
        description: "Block non-hook paths",
        enabled: true,
        expression: `not (http.host eq \"share.j-256.dev\")${hostnameClause}`,
        id: "rule-one",
      },
      {
        action: "skip",
        description: "Skip admin paths",
        enabled: true,
        expression: `(http.host eq \"admin.j-256.dev\")${hostnameClause}`,
        id: "rule-two",
      },
    ],
  }
  const changes = ruleset.rules.map((rule) => ({
    desired: {
      action: rule.action,
      description: rule.description,
      enabled: rule.enabled,
      expression: rule.expression.replace(hostnameClause, ""),
    },
    kind: "ruleset-rule-update",
    phase: ruleset.phase,
    ruleId: rule.id,
    rulesetId: ruleset.id,
    zoneId: "zone-one",
  }))
  const result = await prepareFleetChanges(
    { accountId: "account-one" },
    changes,
    {
      executeReadPlan: scopedReads([[
        "ruleset:zone-one:ruleset-one",
        ruleset,
      ]]),
      readPolicy: async () => ({}),
    },
  )

  assert.equal(result.status, FLEET_CHANGE_STATUS.PLANNED)
  assert.deepEqual(
    result.planSet.preview.map((operation) => operation.path),
    [
      "zones/zone-one/rulesets/ruleset-one/rules/rule-one",
      "zones/zone-one/rulesets/ruleset-one/rules/rule-two",
    ],
  )
  assert.equal(result.planSet.preview.every(
    (operation) => !operation.body.expression.includes("repos-live.j-256.dev"),
  ), true)
})
