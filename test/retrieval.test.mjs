import assert from "node:assert/strict"
import test from "node:test"
import { createFleetService } from "../src/fleet-service.mjs"
import { createEmptyFleetIntentDocument, createAuthoredFleetIntentExpected, FLEET_INTENT_ALL_ZONES_GROUP_ID, replaceFleetIntentGroup, replaceFleetIntentPolicy, replaceFleetIntentAcknowledgement } from "../src/fleet-intent.mjs"
import { createPendingOperationActivity, completeOperationActivity, createVerificationGuards } from "../src/operation-history.mjs"
import { loadInventory } from "../src/inventory.mjs"
import { CloudflareApiError } from "../src/api.mjs"
import { retrievalOutputSchemas, RETRIEVAL_LIMIT } from "../src/retrieval-schemas.mjs"
import { jsonBytes } from "../src/retrieval-values.mjs"
import { appendHostedOperationActivity, finalizeHostedOperationActivity, queryHostedOperationActivity, getHostedOperationActivity, readHostedOperationActivity } from "../src/hosted/d1-store.mjs"
import { hostedD1Fixture } from "./hosted-d1.fixture.mjs"
import { makeZone, makeInventory, makeRule } from "./fixtures.mjs"

const ACCOUNT = "account-id"
const READ_AT = "2026-09-14T12:00:00.000Z"
const ZONE_ID = "zone-alpha.example"
const silent = () => { throw new Error("Unrequested dependency called") }

export function retrievalActivity(id, options = {}) {
  const startedAt = options.startedAt || READ_AT
  const pending = createPendingOperationActivity("Update HTTPS setting", {
    validatedAt: startedAt,
    plans: [{ id: `plan-${id}`, kind: "setting", summary: "Update HTTPS", zoneId: options.zoneId || ZONE_ID, zoneName: "alpha.example", operations: [{ label: "Enable HTTPS", method: "PATCH", path: `zones/${ZONE_ID}/settings/always_use_https`, currentValue: { value: "off" }, body: { value: "on", padding: options.padding || "" } }] }],
  }, { id, startedAt })
  if (options.pending) return pending
  return completeOperationActivity(pending, { status: options.status || "verified", completedAt: READ_AT, execution: { completed: options.status === "write-failed" ? 0 : 1, total: 1 }, inverse: { available: false, plans: [], reason: "No inverse recorded" }, verification: [], error: options.status ? "Operation failed; inspect live state" : null })
}

function fixture(options = {}) {
  const intent = options.intent || createEmptyFleetIntentDocument(ACCOUNT)
  const activity = options.activity || { entries: [], revision: "a".repeat(64), updatedAt: READ_AT }
  const inventory = options.inventory || makeInventory([makeZone("alpha.example"), makeZone("beta.example")])
  const calls = []
  const service = createFleetService({
    accountId: ACCOUNT, api: options.api || {}, stateFile: "unused-state.json", now: () => Date.parse(READ_AT),
    readState: silent, readPolicy: silent, readIntent: async () => intent, readActivity: async () => activity,
    loadInventory: options.api ? loadInventory : async (_api, requirement) => { calls.push(requirement); return inventory },
    queryActivity: options.queryActivity, getActivity: options.getActivity,
  })
  return { service, intent, activity, inventory, calls, async read(kind, query) {
    const result = await service.retrieve(kind, query)
    retrievalOutputSchemas[kind].parse(result)
    return result
  } }
}

test("activity summaries filter before paging, preserve failures and reject changed cursors", async () => {
  const entries = [retrievalActivity("old", { startedAt: "2026-09-13T00:00:00Z" }), retrievalActivity("b", { status: "write-failed" }), retrievalActivity("a", { status: "write-failed", padding: "x".repeat(100000) }), retrievalActivity("foreign", { zoneId: "other" })]
  const { read, activity, calls } = fixture({ activity: { entries, revision: "a".repeat(64), updatedAt: READ_AT } })
  const query = { zoneId: ZONE_ID, status: "write-failed", after: "2026-09-13T00:00:00Z", limit: 1 }
  const first = await read("activity-list", query)
  assert.deepEqual(first.items.map((entry) => entry.id), ["a"])
  assert.equal(first.total, 2)
  assert.equal(first.items[0].execution.completed, 0)
  assert.match(first.items[0].error, /inspect live state/)
  assert.equal(first.items[0].undo.requiresLivePlan, true)
  assert.equal(first.items[0].detail, undefined)
  assert.ok(jsonBytes(first) < 2000)
  const second = await read("activity-list", { ...query, cursor: first.nextCursor })
  assert.deepEqual(second.items.map((entry) => entry.id), ["b"])
  assert.equal(second.nextCursor, null)
  await assert.rejects(read("activity-list", { ...query, status: "verified", cursor: first.nextCursor }), /cursor no longer matches/)
  activity.revision = "b".repeat(64)
  await assert.rejects(read("activity-list", { ...query, cursor: first.nextCursor }), /cursor no longer matches/)
  await assert.rejects(read("activity-list", { cursor: "invalid" }), /Invalid retrieval cursor/)
  assert.equal(calls.length, 0)
})

test("large activity detail is explicit and supports exact child traversal", async () => {
  const { read } = fixture({ activity: { entries: [retrievalActivity("large", { padding: "x".repeat(100000) })], revision: "", updatedAt: null } })
  const full = await read("activity-get", { id: "large" })
  assert.equal(full.detail.truncated, true)
  assert.equal(full.detail.value, null)
  assert.ok(full.detail.childKeys.includes("plans"))
  assert.match(full.detail.digest, /^sha256:/)
  const field = await read("activity-get", { id: "large", path: ["plans", "0", "operations", "0", "currentValue"] })
  assert.deepEqual(field.detail.value, { value: "off" })
  await assert.rejects(read("activity-get", { id: "large", path: ["__proto__"] }), /no value at path/)
  assert.equal((await read("activity-get", { id: "missing" })).status, "not-found")
  const list = await read("activity-list", { view: "full" })
  assert.equal(list.valueTruncated, true)
})

test("byte-limited full pages continue without losing records", async () => {
  const { read } = fixture({ activity: { entries: Array.from({ length: 12 }, (_, index) => retrievalActivity(`activity-${String(index).padStart(2, "0")}`, { padding: "x".repeat(20000) })), revision: "", updatedAt: null } })
  const seen = []
  let cursor
  do {
    const result = await read("activity-list", { view: "full", limit: 100, ...(cursor ? { cursor } : {}) })
    assert.ok(jsonBytes(result.items) <= RETRIEVAL_LIMIT.PAGE_BYTES)
    seen.push(...result.items.map((item) => item.id))
    cursor = result.nextCursor
  } while (cursor)
  assert.equal(seen.length, 12)
  assert.equal(new Set(seen).size, 12)
})

function governedIntent() {
  let intent = createEmptyFleetIntentDocument(ACCOUNT)
  intent = replaceFleetIntentGroup(intent, { id: "selected", name: "Selected", nameSource: "custom", mode: "members", members: [{ zoneId: ZONE_ID, zoneName: "alpha.example" }] })
  const facet = { category: "Zone settings", key: "always_use_https", label: "Always use HTTPS", description: "HTTPS behavior" }
  intent = replaceFleetIntentPolicy(intent, { id: "baseline", groupId: FLEET_INTENT_ALL_ZONES_GROUP_ID, facet, expected: createAuthoredFleetIntentExpected("off") })
  return replaceFleetIntentPolicy(intent, { id: "specific", groupId: "selected", facet, expected: createAuthoredFleetIntentExpected("on") })
}

test("policy reads filter stored membership and inspection explains effective precedence", async () => {
  const { read, calls } = fixture({ intent: governedIntent() })
  const policies = await read("policy-list", { zoneId: ZONE_ID })
  assert.deepEqual(policies.items.map((entry) => entry.id), ["baseline", "specific"])
  assert.equal((await read("policy-list", { zoneId: "zone-beta.example" })).total, 1)
  assert.equal((await read("policy-list", { groupId: "selected", search: "https" })).total, 1)
  const policy = await read("policy-get", { id: "specific", path: ["expected", "value"] })
  assert.equal(policy.detail.value, "on")
  assert.equal(policy.group.value.id, "selected")
  assert.equal((await read("policy-get", { id: "absent" })).status, "not-found")
  assert.equal(calls.length, 0)
  const result = await read("facet-inspect", { category: "Zone settings", key: "always_use_https", zoneId: ZONE_ID, limit: 1 })
  assert.equal(result.observed.comparison.value, "on")
  assert.equal(result.intent.status, "match")
  assert.equal(result.items[0].effective, false)
  assert.deepEqual(result.items[0].overriddenBy, ["specific"])
  assert.deepEqual(calls[0].surfaceIds, ["settings"])
  assert.equal(calls[0].zoneIds, undefined)
  assert.ok(result.actions.value.direct)
  const next = await read("facet-inspect", { category: "Zone settings", key: "always_use_https", zoneId: ZONE_ID, limit: 1, cursor: result.nextCursor })
  assert.equal(next.items[0].policy.id, "specific")
  assert.equal(next.items[0].effective, true)
})

test("inspection keeps conflicting policies visible and live cursors ignore read completion order", async () => {
  const original = governedIntent()
  const intent = replaceFleetIntentPolicy(original, { ...original.policies.find((policy) => policy.id === "specific"), id: "conflicting", expected: createAuthoredFleetIntentExpected("off") })
  const { read } = fixture({ intent })
  const conflict = await read("facet-inspect", { category: "Zone settings", key: "always_use_https", zoneId: ZONE_ID })
  assert.equal(conflict.intent.status, "conflict")
  assert.ok(conflict.intent.conflictKinds.length > 0)
  assert.deepEqual(conflict.items.filter((item) => item.effective).map((item) => item.policy.id), ["conflicting", "specific"])
  const phase = "http_request_firewall_custom"
  const rulesets = ["a", "b"].map((id) => ({ id, kind: "zone", phase, name: id }))
  const zone = makeZone("alpha.example", { rulesets, ruleDetails: rulesets.map((ruleset) => ({ ok: true, rulesetId: ruleset.id, result: { ...ruleset, rules: [makeRule(ruleset.id)] } })) })
  const rules = fixture({ inventory: makeInventory([zone]) })
  const query = { category: "Ruleset rules", limit: 1 }
  const first = await rules.read("facet-list", query)
  assert.ok(first.nextCursor)
  zone.ruleDetails.reverse()
  const second = await rules.read("facet-list", { ...query, cursor: first.nextCursor })
  assert.equal(second.returned, 1)
  assert.notEqual(first.items[0].key, second.items[0].key)
})

test("inspection preserves active and stale acknowledgements and fails closed on unread values", async () => {
  let intent = governedIntent()
  intent = replaceFleetIntentAcknowledgement(intent, { id: "accepted", policyId: "baseline", zoneId: "zone-beta.example", zoneName: "beta.example", observedCanonical: '"on"', reason: "Temporary exception", createdAt: READ_AT, updatedAt: READ_AT })
  const { read, inventory } = fixture({ intent })
  const query = { category: "Zone settings", key: "always_use_https", zoneId: "zone-beta.example" }
  const accepted = await read("facet-inspect", query)
  assert.equal(accepted.intent.status, "acknowledged")
  assert.equal(accepted.items[0].acknowledgements.value[0].status, "active")
  inventory.zones[1].surfaces.settings.result[0].value = "off"
  const stale = await read("facet-inspect", query)
  assert.equal(stale.items[0].acknowledgements.value[0].status, "stale")
  inventory.zones[0].surfaces.settings = { ok: false, result: null, status: 403, error: { message: "Unavailable" } }
  const incomplete = await read("facet-inspect", query)
  assert.equal(incomplete.status, "incomplete")
  assert.equal(incomplete.intent.status, "unknown")
  assert.equal(incomplete.observed.status, "unknown")
  assert.equal(incomplete.actions, null)
  assert.deepEqual(incomplete.capabilities, ["compare"])
  assert.equal(incomplete.coverage.failures[0].zoneId, ZONE_ID)
  assert.equal(incomplete.items[0].acknowledgements.value[0].status, "unknown")
})

test("missing governed facets remain unresolved and unguided category queries are rejected", async () => {
  const { read, inventory } = fixture({ intent: governedIntent() })
  for (const zone of inventory.zones) zone.surfaces.settings.result = []
  const result = await read("facet-inspect", { category: "Zone settings", key: "always_use_https", zoneId: ZONE_ID })
  assert.equal(result.observed.status, "absent")
  assert.equal(result.intent.status, "unresolved")
  const effective = result.items.filter((item) => item.effective)
  assert.equal(effective.length, 1)
  assert.equal(effective[0].status, "unresolved")
  assert.equal(result.items.some((item) => item.status === "match"), false)
  assert.match(result.items[0].reason, /not present/)
  await assert.rejects(read("facet-list", {}), /Invalid facet-list/)
  await assert.rejects(read("resource-list", { kind: "dns-record", zoneId: ZONE_ID, apiPath: "zones/other" }), /Unrecognized key/)
  await assert.rejects(read("activity-list", { limit: 101 }), /Invalid activity-list/)
})

test("resource discovery pages provider results and restricts zone, surface and rule phase reads", async () => {
  const requests = []
  const phase = "http_request_firewall_custom"
  const api = {
    accountId: ACCOUNT, listZones: async () => [makeZone("alpha.example").meta, makeZone("beta.example").meta], listEmailAddresses: silent,
    async request(path) {
      requests.push(path)
      if (path.includes("dns_records")) {
        const second = path.includes("page=2")
        return { status: 200, result: [{ id: second ? "record-b" : "record-a", name: "alpha.example", type: "TXT", content: "hello", locked: !second }], resultInfo: { page: second ? 2 : 1, total_pages: 2, per_page: 1 } }
      }
      if (path.endsWith("/rulesets")) return { status: 200, result: [{ id: "wanted", kind: "zone", phase }, { id: "unrelated", kind: "zone", phase: "http_ratelimit" }] }
      if (path.endsWith("/rulesets/wanted")) return { status: 200, result: { id: "wanted", kind: "zone", phase, rules: [makeRule("Block scans")] } }
      throw new Error(`Unexpected read ${path}`)
    },
  }
  const { read } = fixture({ api })
  const dns = await read("resource-list", { kind: "dns-record", zoneId: ZONE_ID, type: "TXT", view: "full" })
  assert.equal(dns.total, 2)
  assert.deepEqual(dns.items[0].capabilities, ["inspect"])
  assert.deepEqual(dns.items[1].capabilities, ["inspect", "plan-change"])
  assert.equal(dns.items[1].detail.value.id, "record-b")
  assert.equal(requests.length, 2)
  assert.ok(requests.every((path) => path.startsWith(`zones/${ZONE_ID}/dns_records`)))
  requests.length = 0
  const rules = await read("resource-list", { kind: "ruleset-rule", zoneId: ZONE_ID, phase, view: "full" })
  assert.equal(rules.items[0].rulesetId, "wanted")
  assert.equal(rules.items[0].phase, phase)
  assert.deepEqual(rules.items[0].detail.value, makeRule("Block scans"))
  assert.equal(rules.coverage.complete, true)
  assert.equal(requests.length, 2)
  assert.ok(requests.every((path) => !path.includes("unrelated")))
  requests.length = 0
  const zone = await read("zone-list", { name: "beta.example" })
  assert.equal(zone.items[0].id, "zone-beta.example")
  assert.equal(requests.length, 0)
  await assert.rejects(read("resource-list", { kind: "dns-record", zoneId: "outside-account" }), /Unknown zone/)
  assert.equal(requests.length, 0)
})

test("failed and stalled provider pages never establish collection absence", async () => {
  for (const stalled of [false, true]) {
    let requests = 0
    const { read } = fixture({ api: { accountId: ACCOUNT, listZones: async () => [makeZone("alpha.example").meta], async request() {
      requests += 1
      if (requests > 1 && !stalled) throw new CloudflareApiError("Provider failed", { status: 503 })
      return { status: 200, result: [{ id: "one", name: "alpha.example", type: "TXT", content: "x" }], resultInfo: { page: 1, total_pages: 2 } }
    } } })
    const result = await read("resource-list", { kind: "dns-record", zoneId: ZONE_ID })
    assert.equal(result.status, "incomplete")
    assert.equal(result.coverage.complete, false)
    assert.equal(result.coverage.failures[0].reasonCode, stalled ? "inventory-pagination-stalled" : "inventory-page-failed")
    assert.equal(result.total, 0)
    assert.ok(requests <= 2)
  }
})

test("pagination retains advertised totals and does not treat a later absent-feature error as empty", async () => {
  const requests = []
  const inventory = await loadInventory({ accountId: ACCOUNT, listZones: async () => [makeZone("alpha.example").meta], async request(path) {
    requests.push(path)
    return { status: 200, result: [{ id: `record-${requests.length}` }], ...(requests.length === 1 ? { resultInfo: { page: 1, total_pages: 3, per_page: 1 } } : {}) }
  } }, { surfaceIds: ["dns"], includeEmailAddresses: false })
  assert.equal(inventory.zones[0].surfaces.dns.result.length, 3)
  let page = 0
  const unavailable = await loadInventory({ accountId: ACCOUNT, listZones: async () => [makeZone("alpha.example").meta], async request() {
    page += 1
    if (page > 1) throw new CloudflareApiError("No quota", { status: 400, errors: [{ code: 1404 }] })
    return { status: 200, result: [{ id: "custom-host" }], resultInfo: { page: 1, total_pages: 2 } }
  } }, { surfaceIds: ["custom-hostnames"], includeEmailAddresses: false })
  assert.equal(unavailable.zones[0].surfaces["custom-hostnames"].ok, false)
  assert.equal(unavailable.zones[0].surfaces["custom-hostnames"].notApplicable, undefined)
})

test("collection reads continue full pages without totals and follow cursor pagination", async () => {
  for (const cursorMode of [false, true]) {
    const paths = []
    const inventory = await loadInventory({ accountId: ACCOUNT, listZones: async () => [makeZone("alpha.example").meta], async request(path) {
      paths.push(path)
      if (cursorMode) return { status: 200, result: [{ id: `rule-${paths.length}` }], resultInfo: { cursors: { after: paths.length === 1 ? "next-token" : null } } }
      return { status: 200, result: paths.length === 1 ? Array.from({ length: 100 }, (_, index) => ({ id: `rule-${index}` })) : [] }
    } }, { surfaceIds: ["email-rules"], includeEmailAddresses: false })
    assert.equal(paths.length, 2)
    assert.match(paths[1], cursorMode ? /cursor=next-token/ : /page=2/)
    assert.equal(inventory.zones[0].surfaces["email-rules"].ok, true)
  }
})

test("hosted detail can read an undo entry without fetching its entire history", async (context) => {
  const db = hostedD1Fixture(context)
  const pending = retrievalActivity("parent", { pending: true })
  await appendHostedOperationActivity(db, ACCOUNT, pending)
  await finalizeHostedOperationActivity(db, ACCOUNT, completeOperationActivity(pending, {
    status: "verified", completedAt: READ_AT, execution: { completed: 1, total: 1 },
    inverse: { available: true, plans: pending.plans, reason: "Fresh guard required" },
    verification: createVerificationGuards([{ response: { result: { id: "always_use_https", value: "on" } }, target: { kind: "setting", settingId: "always_use_https", zoneId: ZONE_ID } }]),
  }))
  const undo = { ...retrievalActivity("undo", { pending: true }), undoOf: "parent" }
  await appendHostedOperationActivity(db, ACCOUNT, undo)
  const { read } = fixture({ getActivity: (id) => getHostedOperationActivity(db, ACCOUNT, id) })
  const result = await read("activity-get", { id: "undo" })
  assert.equal(result.detail.value.undoOf, "parent")
  assert.equal(result.summary.status, "pending")
})

test("retrieval rejects mismatched phases and stops cancelled reads before dispatch", async () => {
  const { service, read, calls } = fixture()
  await assert.rejects(read("facet-inspect", { category: "Ruleset rules", key: "http_ratelimit:some-rule", phase: "http_request_firewall_custom", zoneId: ZONE_ID }), /phase does not match/)
  await assert.rejects(read("facet-list", { category: "Zone settings", phase: "http_ratelimit" }), /phase requires/)
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(service.retrieve("zone-list", {}, { signal: controller.signal }), { name: "AbortError" })
  assert.equal(calls.length, 0)
})

test("hosted SQL activity reads match local filters, order, detail and cursors", async (context) => {
  const db = hostedD1Fixture(context)
  for (const entry of [retrievalActivity("b"), retrievalActivity("a"), retrievalActivity("failed", { status: "write-failed" }), retrievalActivity("pending", { pending: true, zoneId: "other" }), retrievalActivity("old", { startedAt: "2026-09-12T13:00:00+01:00" })]) {
    await appendHostedOperationActivity(db, ACCOUNT, { ...entry, status: "pending", completedAt: null, error: null, execution: null, inverse: null, verification: [] })
    if (entry.status !== "pending") await finalizeHostedOperationActivity(db, ACCOUNT, entry)
  }
  await appendHostedOperationActivity(db, "another-account", retrievalActivity("unrelated", { pending: true }))
  const document = await readHostedOperationActivity(db, ACCOUNT)
  const local = fixture({ activity: document })
  const hosted = fixture({ queryActivity: (query) => queryHostedOperationActivity(db, ACCOUNT, query), getActivity: (id) => getHostedOperationActivity(db, ACCOUNT, id) })
  for (const query of [{}, { zoneId: ZONE_ID, limit: 1 }, { status: "write-failed" }, { after: "2026-09-12T12:00:00Z" }, { before: "2026-09-14T12:00:00Z" }, { view: "full", limit: 2 }]) {
    const expected = await local.read("activity-list", query)
    const actual = await hosted.read("activity-list", query)
    assert.deepEqual(actual, expected)
    if (actual.nextCursor) assert.deepEqual(await hosted.read("activity-list", { ...query, cursor: actual.nextCursor }), await local.read("activity-list", { ...query, cursor: actual.nextCursor }))
  }
  assert.deepEqual(await hosted.read("activity-get", { id: "failed" }), await local.read("activity-get", { id: "failed" }))
  assert.equal((await hosted.read("activity-get", { id: "unrelated" })).status, "not-found")
  const first = await hosted.read("activity-list", { limit: 1 })
  await appendHostedOperationActivity(db, ACCOUNT, retrievalActivity("new", { pending: true }))
  await assert.rejects(hosted.read("activity-list", { limit: 1, cursor: first.nextCursor }), /cursor no longer matches/)
})
