import assert from "node:assert/strict"
import test from "node:test"
import { CloudflareApiError } from "../src/api.mjs"
import { alignmentCoverage } from "../src/alignment-coverage.mjs"
import { listIntentAlignmentCandidates, prepareIntentAlignment, prepareIntentAlignments } from "../src/alignment-service.mjs"
import { createFleetService } from "../src/fleet-service.mjs"
import { createEmptyFleetIntentDocument, replaceFleetIntentPolicy } from "../src/fleet-intent.mjs"
import { facetCellComparisonValue } from "../src/facet-equivalence.mjs"
import { intentAlignmentReadRequirement } from "../src/intent-alignment.mjs"
import { buildMatrix } from "../src/matrix.mjs"
import { loadInventory } from "../src/inventory.mjs"
import { makeInventory, makeRule, makeZone, ok } from "./fixtures.mjs"

const RATE_PHASE = "http_ratelimit"
const SKIP_PHASE = "http_request_firewall_custom"

function fixture() {
  const rulesets = [RATE_PHASE, SKIP_PHASE].map((phase) => ({
    id: `ruleset-${phase}`, kind: "zone", phase,
    rules: [makeRule(`Guard ${phase}`, { expression: "true" })],
  }))
  const zone = makeZone("alpha.example", { rulesets, ruleDetails: rulesets.map(ok) })
  const inventory = makeInventory([zone, makeZone("bravo.example")])
  const rows = buildMatrix(inventory).rows.filter((row) => row.category === "Ruleset rules")
  let intent = createEmptyFleetIntentDocument(inventory.account.id)
  intent.groups.push({ id: "selected", name: "Selected", nameSource: "custom", mode: "members", members: [{ zoneId: zone.meta.id, zoneName: zone.meta.name }] })
  for (const row of rows) {
    const source = row.cells.get(zone.meta.name)
    intent = replaceFleetIntentPolicy(intent, {
      id: `policy-${row.phase}`, groupId: "selected",
      facet: { category: row.category, key: row.key, label: row.label, description: row.description, phase: row.phase },
      expected: { canonical: source.intentCanonical, display: source.display, origin: "observed", resolutionCanonical: source.resolutionCanonical, sourceZoneId: zone.meta.id, sourceZoneName: zone.meta.name, value: facetCellComparisonValue(source) },
      presenceConstraint: "required", valueConstraint: "exact",
    })
  }
  const calls = []
  const failures = new Set()
  const api = {
    accountId: inventory.account.id,
    async listZones() { calls.push("zones"); return inventory.zones.map((entry) => entry.meta) },
    async request(path, options = {}) {
      assert.equal(options.method || "GET", "GET")
      calls.push(path)
      if (failures.has(path)) throw new CloudflareApiError("Synthetic upstream timeout", {
        path: `/client/v4/${path}`, aborted: true, abortKind: "timeout", elapsedMs: 45000,
      })
      const target = inventory.zones.find((entry) => path.startsWith(`zones/${entry.meta.id}/`))
      assert.ok(target, `Unexpected read: ${path}`)
      if (path === `zones/${target.meta.id}/rulesets`) return target.surfaces.rulesets
      const detail = target.ruleDetails.find((entry) => path.endsWith(`/rulesets/${entry.result.id}`))
      assert.ok(detail, `Unexpected read: ${path}`)
      return detail
    },
  }
  return { api, calls, failures, intent, inventory, rows, zone }
}

const selector = { policyId: `policy-${RATE_PHASE}` }

test("cold policy planning reads only its rule phase, with one fresh account membership read", async () => {
  const f = fixture()
  const result = await prepareIntentAlignment(f.api, f.intent, selector)
  assert.equal(result.status, "aligned")
  assert.deepEqual(f.calls, ["zones", `zones/${f.zone.meta.id}/rulesets`, "zones/zone-bravo.example/rulesets", `zones/${f.zone.meta.id}/rulesets/ruleset-${RATE_PHASE}`])
})

for (const failedSurface of ["listing", "detail"]) {
  test(`failed ruleset ${failedSurface} is incomplete coverage, never absence or alignment`, async () => {
    const f = fixture()
    const failedPath = `zones/${f.zone.meta.id}/rulesets${failedSurface === "detail" ? `/ruleset-${RATE_PHASE}` : ""}`
    f.failures.add(failedPath)
    const result = await prepareIntentAlignment(f.api, f.intent, selector)
    assert.equal(result.status, "blocked")
    assert.equal(result.planSet, null)
    assert.match(result.reason, /incomplete inventory/)
    assert.doesNotMatch(result.reason, /facet is absent|already matches/)
    assert.equal(result.coverage.failureCount, 1)
    assert.equal(result.coverage.failures[0].errorKind, "timeout")
    assert.equal(result.coverage.failures[0].zoneId, f.zone.meta.id)
    assert.equal(result.coverage.failures[0].surfaceId, "rulesets")
  })
}

test("failed and stale candidate inventories cannot short-circuit a fresh alignment read", async () => {
  const f = fixture()
  const baseline = structuredClone(f.inventory)
  baseline.zones[0].ruleDetails = []
  const result = await prepareIntentAlignment(f.api, f.intent, selector, { baselineInventory: baseline })
  assert.equal(result.status, "aligned")
  assert.ok(f.calls.includes(`zones/${f.zone.meta.id}/rulesets/ruleset-${RATE_PHASE}`))
  f.failures.add(`zones/${f.zone.meta.id}/rulesets`)
  const failed = await prepareIntentAlignment(f.api, f.intent, selector, { baselineInventory: f.inventory })
  assert.equal(failed.status, "blocked")
  assert.equal(failed.coverage.complete, false)
})

test("a completely read but missing facet retains an explicit absence result", async () => {
  const f = fixture()
  f.zone.surfaces.rulesets.result = []
  const result = await prepareIntentAlignment(f.api, f.intent, selector)
  assert.equal(result.status, "blocked")
  assert.match(result.reason, /facet is absent from the fresh fleet state/)
  assert.equal(result.coverage, undefined)
})

test("omitted details block coverage, while an unrelated phase failure does not", () => {
  const f = fixture()
  const requirement = intentAlignmentReadRequirement(f.rows.find((row) => row.phase === RATE_PHASE))
  f.zone.ruleDetails = f.zone.ruleDetails.filter((entry) => entry.result.phase === RATE_PHASE)
  f.zone.ruleDetails.push({ ok: false, rulesetId: `ruleset-${SKIP_PHASE}`, phase: SKIP_PHASE })
  assert.equal(alignmentCoverage(f.inventory, requirement).complete, true)
  f.zone.ruleDetails = []
  const coverage = alignmentCoverage(f.inventory, requirement)
  assert.equal(coverage.complete, false)
  assert.equal(coverage.failures[0].errorKind, "not-read")
})

test("candidate listing exposes failed coverage even when no rule row survives", async () => {
  const f = fixture()
  f.failures.add(`zones/${f.zone.meta.id}/rulesets/ruleset-${RATE_PHASE}`)
  const inventory = await loadInventory(f.api, intentAlignmentReadRequirement(f.rows.find((row) => row.phase === RATE_PHASE)))
  const result = listIntentAlignmentCandidates(inventory, f.intent)
  const candidate = result.candidates.find((entry) => entry.policyId === selector.policyId)
  assert.equal(candidate.assessment.available, false)
  assert.equal(candidate.assessment.actionableCount, 0)
  assert.match(candidate.assessment.reason, /incomplete inventory/)
  assert.equal(candidate.coverage.complete, false)
})

test("batch planning merges phase reads and withholds the whole plan on partial coverage", async () => {
  const f = fixture()
  f.failures.add(`zones/${f.zone.meta.id}/rulesets/ruleset-${RATE_PHASE}`)
  const result = await prepareIntentAlignments(f.api, f.intent, f.intent.policies.map((policy) => ({ policyId: policy.id })))
  assert.equal(result.status, "blocked")
  assert.equal(result.planSet, null)
  assert.equal(f.calls.filter((path) => path === "zones").length, 1)
  assert.equal(f.calls.filter((path) => path === `zones/${f.zone.meta.id}/rulesets`).length, 1)
  assert.equal(result.alignments.find((entry) => entry.selector.policyId === selector.policyId).coverage.complete, false)
  assert.equal(result.alignments.find((entry) => entry.selector.policyId !== selector.policyId).status, "aligned")
})

test("service planning and apply use scoped reads and never execute incomplete preparation", async () => {
  const f = fixture()
  const service = createFleetService({
    api: f.api, stateFile: "unused-test-state", readState: async () => ({ intent: f.intent }),
    withWriteLock: (operation) => operation(), executePlanSet: () => assert.fail("Must not execute incomplete reads"),
  })
  assert.equal((await service.planAlignment(selector)).status, "aligned")
  f.failures.add(`zones/${f.zone.meta.id}/rulesets/ruleset-${RATE_PHASE}`)
  const result = await service.applyAlignment(selector, `sha256:${"a".repeat(64)}`)
  assert.equal(result.status, "blocked")
  assert.equal(result.applied, false)
  assert.equal(result.coverage.complete, false)
  assert.equal(f.calls.filter((path) => path === "zones").length, 2)
})

test("coverage reports remain bounded without hiding the number of missing reads", () => {
  const zones = Array.from({ length: 60 }, (_, index) => makeZone(`zone-${index}.example`))
  for (const zone of zones) delete zone.surfaces.settings
  const coverage = alignmentCoverage(makeInventory(zones), { surfaceIds: ["settings"] })
  assert.equal(coverage.failureCount, 60)
  assert.equal(coverage.failures.length, 50)
  assert.equal(coverage.truncated, true)
})

test("an unresolved group cannot be reported aligned after complete surface reads", async () => {
  const f = fixture()
  f.intent.groups.find((group) => group.id === "selected").members.push({ zoneId: "departed-zone", zoneName: "departed.example" })
  for (const prepare of [
    () => prepareIntentAlignment(f.api, f.intent, selector),
    () => prepareIntentAlignments(f.api, f.intent, [selector]),
  ]) {
    const result = await prepare()
    assert.equal(result.status, "blocked")
    assert.match(result.reason, /outside the loaded fleet/)
    assert.equal(result.planSet, null)
  }
})

test("unsupported facets block before requesting unrelated inventory", async () => {
  const f = fixture()
  const unsupported = { category: "Unsupported", key: "facet" }
  assert.equal((await prepareIntentAlignment(f.api, f.intent, unsupported)).status, "blocked")
  assert.equal((await prepareIntentAlignments(f.api, f.intent, [selector, unsupported])).status, "blocked")
  assert.deepEqual(f.calls, [])
})
