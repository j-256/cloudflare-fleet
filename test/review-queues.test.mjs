import assert from "node:assert/strict"
import test from "node:test"
import { buildReviewQueues, reviewQueuePage, summarizeReviewValue } from "../src/review-queues.mjs"
import { buildMatrix } from "../src/matrix.mjs"
import { createEmptyFleetIntentDocument, createAuthoredFleetIntentExpected, replaceFleetIntentGroup, replaceFleetIntentPolicy, replaceFleetIntentAcknowledgement, FLEET_INTENT_ALL_ZONES_GROUP_ID } from "../src/fleet-intent.mjs"
import { makeInventory, makeZone } from "./fixtures.mjs"
import { createDemoFleet } from "./demo-fleet.mjs"

function fixture() {
  const inventory = makeInventory([
    makeZone("one.example", { settings: [{ id: "always_use_https", value: "on", editable: true }] }),
    makeZone("two.example", { settings: [{ id: "always_use_https", value: "off", editable: true }] }),
  ])
  const matrix = buildMatrix(inventory)
  const row = matrix.rows.find((entry) => entry.key === "always_use_https")
  const cell = row.cells.get("one.example")
  const intent = replaceFleetIntentPolicy(createEmptyFleetIntentDocument(inventory.account.id), {
    id: "https-policy", groupId: FLEET_INTENT_ALL_ZONES_GROUP_ID,
    facet: { category: row.category, key: row.key, label: row.label },
    presenceConstraint: "required", valueConstraint: "exact",
    expected: { canonical: cell.intentCanonical, value: "on", display: "on", origin: "observed", sourceZoneId: "zone-one.example", sourceZoneName: "one.example", resolutionCanonical: cell.resolutionCanonical },
  })
  return { inventory, matrix, intent, coverage: { unexpectedIssues: [], expectedIssues: [] } }
}

test("review queues expose exact mismatching zones and readable before/expected evidence", () => {
  const queues = buildReviewQueues(fixture())
  assert.equal(queues.summary.misalignments, 1)
  assert.equal(queues.summary.mismatchCells, 1)
  const item = queues.misalignments[0]
  assert.equal(item.facet.key, "always_use_https")
  assert.equal(item.observed[0].zoneName, "two.example")
  assert.equal(item.observed[0].value, "off")
  assert.match(item.expected, /on/)
  assert.equal(queues.status, "attention")
})

test("undefined intent and incomplete reads never become an aligned empty queue", () => {
  const input = fixture()
  input.intent = createEmptyFleetIntentDocument(input.inventory.account.id)
  const unconfigured = buildReviewQueues(input)
  assert.equal(unconfigured.status, "not-configured")
  assert.equal(unconfigured.summary.misalignments, 0)
  assert.ok(unconfigured.decisions.some((item) => item.facet.key === "always_use_https"))
  input.coverage.unexpectedIssues.push({ issue: { kind: "surface", subjectId: "dns", subjectLabel: "DNS records", observedCanonical: "failed", detail: "Read failed", zoneId: "zone-two.example", zoneName: "two.example" } })
  assert.equal(buildReviewQueues(input).summary.reads, 1)
})

test("read health retains the evaluated issue's surface, zone and failure evidence", () => {
  const { inventory, intent } = fixture()
  inventory.zones[1].surfaces.dns = { ok: false, status: 403, error: { message: "DNS permission denied" } }
  const queues = buildReviewQueues({ inventory, intent })
  const read = queues.reads.find((item) => item.label === "DNS records")
  assert.ok(read)
  assert.equal(read.observed[0].zoneName, "two.example")
  assert.equal(read.observed[0].zoneId, "zone-two.example")
  assert.match(read.reason, /DNS permission denied/)
})

test("failed and missing custom ruleset details remain read work without governed rules", () => {
  for (const detail of [null, { ok: false, status: 403, error: { message: "Ruleset permission denied" } }]) {
    const { inventory, intent } = fixture()
    inventory.zones[1].surfaces.rulesets.result = [{ id: "custom-firewall", kind: "zone", phase: "http_request_firewall_custom", name: "Custom firewall" }]
    inventory.zones[1].ruleDetails = detail ? [{ ...detail, rulesetId: "custom-firewall" }] : []
    const queues = buildReviewQueues({ inventory, intent })
    const read = queues.reads.find((item) => item.label === "Ruleset detail: Custom firewall")
    assert.ok(read)
    assert.equal(read.observed[0].zoneName, "two.example")
    assert.equal(queues.summary.complete, false)
  }
})

test("verified matching state empties misalignments while read gaps qualify success", () => {
  const input = fixture()
  input.inventory.zones[1].surfaces.settings.result[0].value = "on"
  input.matrix = buildMatrix(input.inventory)
  assert.equal(buildReviewQueues(input).status, "aligned")
  input.coverage.unexpectedIssues.push({ issue: { kind: "surface", subjectId: "dns", subjectLabel: "DNS records", observedCanonical: "failed", detail: "Read failed", zoneId: "zone-two.example", zoneName: "two.example" } })
  assert.equal(buildReviewQueues(input).status, "incomplete")
})

test("unresolved saved intent stays in outstanding work even without a matrix facet", () => {
  const input = fixture()
  input.intent.policies[0].facet.key = "unavailable_setting"
  const queues = buildReviewQueues(input)
  assert.ok(queues.misalignments.some((item) => item.kind === "unresolved"))
  assert.notEqual(queues.status, "aligned")
})

test("review pages preserve totals and reject unbounded or invalid queries", () => {
  const input = fixture()
  input.intent = createEmptyFleetIntentDocument(input.inventory.account.id)
  input.inventory.zones[0].surfaces.settings.result.push({ id: "early_hints", value: "on" })
  input.inventory.zones[1].surfaces.settings.result.push({ id: "early_hints", value: "off" })
  input.matrix = buildMatrix(input.inventory)
  const queues = buildReviewQueues(input)
  const first = reviewQueuePage(queues, { queue: "decisions", limit: 1, offset: 0 })
  assert.equal(first.items.length, 1)
  assert.equal(first.total, queues.decisions.length)
  assert.equal(first.hasMore, queues.decisions.length > 1)
  const second = reviewQueuePage(queues, { queue: "decisions", limit: 1, offset: 1 })
  assert.notEqual(second.items[0].id, first.items[0].id)
  assert.throws(() => reviewQueuePage(queues, { queue: "decisions", limit: 500 }))
  assert.throws(() => reviewQueuePage(queues, { queue: "unknown" }))
})

test("value summaries expose DNS destinations and keep long evidence bounded", () => {
  assert.match(summarizeReviewValue([{ type: "A", content: "192.0.2.10", proxied: true }]), /192\.0\.2\.10/)
  assert.match(summarizeReviewValue({ action: "block", expression: "http.host eq service.example" }), /service\.example/)
  assert.ok(summarizeReviewValue("x".repeat(10000)).length <= 240)
})

test("sampled expectations belong to the affected zone rather than other policy scopes", () => {
  const queues = buildReviewQueues(createDemoFleet())
  const setting = (key) => queues.misalignments.find((item) => item.facet.key === key)
  assert.equal(setting("min_tls_version").observed[0].expected, "1.3")
  assert.equal(setting("ssl").observed[0].expected, "strict")
  const dns = queues.misalignments.find((item) => item.label === "CNAME www")
  assert.equal(dns.expected, "Must be absent")
  assert.equal(dns.observed[0].expected, "Must be absent")
  const rule = queues.misalignments.find((item) => item.label === "Protect service")
  assert.match(rule.observed[0].expected, /service\.harbor-app\.example/)
})

test("compound evidence exposes redirect and rate differences without raw JSON", () => {
  const queues = buildReviewQueues(createDemoFleet())
  const alias = queues.misalignments.find((item) => item.facet.category === "Zone aliases")
  assert.match(alias.observed[0].value, /302.*harbor\.example/)
  assert.match(alias.observed[0].expected, /307.*harbor\.example/)
  const rate = queues.misalignments.find((item) => item.facet.category === "Rate limiting")
  assert.match(rate.observed[0].value, /100 requests \/ 10s/)
  assert.match(rate.observed[0].expected, /60 requests \/ 10s/)
  for (const item of [...queues.misalignments, ...queues.decisions]) {
    for (const value of [item.expected, ...item.observed.flatMap((sample) => [sample.value, sample.expected].filter(Boolean))]) {
      assert.ok(value.length <= 240)
      assert.ok(!value.startsWith('{"'))
    }
  }
})

test("unsupported redirect expressions preserve unknown target and preservation semantics", () => {
  const input = createDemoFleet()
  const zone = input.inventory.zones.find((entry) => entry.meta.name === "legacy-harbor.example")
  const detail = zone.ruleDetails.find((entry) => entry.result.phase === "http_request_dynamic_redirect")
  const redirect = detail.result.rules[0].action_parameters.from_value
  redirect.target_url.expression = 'concat("https://harbor.example", http.request.uri.path, "?source=alias")'
  delete redirect.preserve_query_string
  const item = buildReviewQueues(input).misalignments.find((entry) => entry.facet.category === "Zone aliases")
  assert.match(item.observed[0].value, /unknown target/)
  assert.match(item.observed[0].value, /path unknown, query unknown, subdomains unknown/)
  assert.doesNotMatch(item.observed[0].value, /null|not preserved/)
})

test("unread alias DNS and redirect surfaces do not become confirmed absence in summaries", () => {
  for (const surface of ["dns", "rulesets", "redirect-detail"]) {
    const input = createDemoFleet()
    const zone = input.inventory.zones.find((entry) => entry.meta.name === "legacy-harbor.example")
    if (surface === "redirect-detail") {
      const detail = zone.ruleDetails.find((entry) => entry.result.phase === "http_request_dynamic_redirect")
      const summary = zone.surfaces.rulesets.result.find((entry) => entry.id === detail.result.id)
      summary.id = "alias-redirect-ruleset"
      detail.rulesetId = summary.id
      Object.assign(detail, { ok: false, status: 403, error: { message: "Denied" } })
      delete detail.result
    } else zone.surfaces[surface] = { ok: false, status: 403, error: { message: "Denied" } }
    const item = buildReviewQueues(input).misalignments.find((entry) => entry.facet.category === "Zone aliases")
    const summary = item.observed[0].value
    assert.match(summary, /unread surface/)
    if (surface === "dns") assert.match(summary, /DNS: apex unknown, wildcard unknown/)
    else assert.match(summary, /Canonical redirect unknown/)
    assert.doesNotMatch(summary, /missing|No canonical redirect/)
  }
})

test("equal observed values with distinct expected states remain separate samples", () => {
  const input = fixture()
  input.intent.policies = []
  for (const [index, zone] of input.inventory.zones.entries()) {
    zone.surfaces.settings.result[0].value = "unknown"
    const groupId = `scope-${index}`
    input.intent = replaceFleetIntentGroup(input.intent, { id: groupId, name: groupId, mode: "members", nameSource: "custom", members: [{ zoneId: zone.meta.id, zoneName: zone.meta.name }] })
    input.intent = replaceFleetIntentPolicy(input.intent, {
      id: `https-${index}`, groupId, facet: { category: "Zone settings", key: "always_use_https", label: "always_use_https" },
      presenceConstraint: "required", valueConstraint: "exact", expected: createAuthoredFleetIntentExpected(index ? "off" : "on"),
    })
  }
  input.matrix = buildMatrix(input.inventory)
  const samples = buildReviewQueues(input).misalignments[0].observed
  assert.equal(samples.length, 2)
  assert.deepEqual(samples.map((sample) => sample.value), ["unknown", "unknown"])
  assert.deepEqual(samples.map((sample) => sample.expected), ["on", "off"])
})

test("an acknowledged exact exception stays out of the misalignment queue", () => {
  const input = fixture()
  input.intent = replaceFleetIntentAcknowledgement(input.intent, {
    id: "https-exception", policyId: "https-policy", zoneId: "zone-two.example", zoneName: "two.example",
    observedCanonical: '"off"', reason: "Deliberate exception",
    createdAt: "2026-11-06T00:00:00.000Z", updatedAt: "2026-11-06T00:00:00.000Z",
  })
  const queues = buildReviewQueues(input)
  assert.equal(queues.summary.misalignments, 0)
  assert.equal(queues.summary.acknowledgedCells, 1)
})

test("unread settings are unknown work rather than confirmed missing configuration", () => {
  const input = fixture()
  input.inventory.zones[1].surfaces.settings = { ok: false, status: 403 }
  input.matrix = buildMatrix(input.inventory)
  const queues = buildReviewQueues(input)
  assert.ok(queues.misalignments.every((item) => item.kind === "unresolved"))
  assert.equal(queues.summary.mismatchCells, 0)
  assert.notEqual(queues.status, "aligned")
})

test("an empty account cannot establish that saved intent is aligned", () => {
  const input = fixture()
  input.inventory = makeInventory([])
  input.matrix = buildMatrix(input.inventory)
  assert.notEqual(buildReviewQueues(input).status, "aligned")
})

test("bounded observed evidence includes an outlier beyond the first zones", () => {
  const inventory = makeInventory(["one", "two", "three", "four"].map((name) => makeZone(`${name}.example`, {
    settings: [{ id: "always_use_https", value: name === "four" ? "off" : "on" }],
  })))
  const queues = buildReviewQueues({ inventory, intent: createEmptyFleetIntentDocument(inventory.account.id) })
  const decision = queues.decisions.find((item) => item.facet.key === "always_use_https")
  assert.ok(decision.observed.some((value) => value.value === "off"))
  assert.ok(decision.observed.length <= 3)
})
