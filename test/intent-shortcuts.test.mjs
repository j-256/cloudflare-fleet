import assert from "node:assert/strict"
import test from "node:test"
import { buildFacetIntentDocument } from "../src/intent-shortcuts.mjs"
import { createEmptyFleetIntentDocument, createAuthoredFleetIntentExpected, evaluateFleetIntent, fleetIntentFacetId, replaceFleetIntentGroup, replaceFleetIntentPolicy } from "../src/fleet-intent.mjs"
import { createFleetService } from "../src/fleet-service.mjs"
import { buildMatrix } from "../src/matrix.mjs"
import { makeInventory, makeZone } from "./fixtures.mjs"

const FACET = Object.freeze({ category: "Zone settings", key: "always_use_https" })

function fixture() {
  const inventory = makeInventory([
    makeZone("alpha.example"),
    makeZone("bravo.example", { settings: [{ id: "always_use_https", value: "off", editable: true }] }),
    makeZone("charlie.example", { settings: [] }),
    makeZone("delta.example"),
  ])
  const matrix = buildMatrix(inventory)
  const ids = inventory.zones.map((zone) => zone.meta.id)
  let document = createEmptyFleetIntentDocument(inventory.account.id)
  for (const [id, indexes] of [["first", [0, 1]], ["second", [1, 2]], ["third", [2, 3]]]) {
    document = replaceFleetIntentGroup(document, {
      id, name: id, nameSource: "custom", mode: "members",
      members: indexes.map((index) => ({ zoneId: ids[index], zoneName: inventory.zones[index].meta.name })),
    })
  }
  return { inventory, matrix, document, ids }
}

function cellStates(document, inventory, matrix) {
  return evaluateFleetIntent(document, inventory, matrix).rowStates.get(fleetIntentFacetId(FACET.category, FACET.key)).cells
}

test("accepting current state preserves distinct values and proven absence and is repeatable", () => {
  const { inventory, matrix, document, ids } = fixture()
  const request = { facets: [FACET], mode: "current", zoneIds: ids.slice(0, 3) }
  const result = buildFacetIntentDocument(document, inventory, matrix, request)
  const cells = cellStates(result.document, inventory, matrix)
  for (const id of ids.slice(0, 3)) assert.equal(cells.get(id).status, "match")
  assert.equal(cells.get(ids[3]).status, "out-of-scope")
  assert.equal(result.document.policies.find((policy) => policy.expected?.value === "off").presenceConstraint, "required")
  assert.equal(result.document.policies.filter((policy) => policy.presenceConstraint === "forbidden").length, 1)
  assert.deepEqual(buildFacetIntentDocument(result.document, inventory, matrix, request).document, result.document)
  assert.equal(document.policies.length, 0)
})

test("one source can govern overlapping groups together and replace narrower exceptions", () => {
  const { inventory, matrix, document, ids } = fixture()
  const accepted = buildFacetIntentDocument(document, inventory, matrix, { facets: [FACET], mode: "current", zoneIds: ids }).document
  const result = buildFacetIntentDocument(accepted, inventory, matrix, {
    facets: [FACET], mode: "source", groupIds: ["first", "second"], sourceZoneId: ids[0],
  })
  const cells = cellStates(result.document, inventory, matrix)
  assert.equal(cells.get(ids[0]).status, "match")
  assert.equal(cells.get(ids[1]).status, "variant")
  assert.equal(cells.get(ids[2]).status, "missing")
  assert.equal(cells.get(ids[3]).status, "match")
  assert.deepEqual(result.document.policies.filter((policy) => ["first", "second"].includes(policy.groupId)).map((policy) => policy.expected.value), ["on", "on"])
  for (const id of ids.slice(0, 3)) assert.ok(cells.get(id).policies.every((policy) => ["first", "second"].includes(policy.groupId)))
})

test("editing part of an overlapping scope preserves its outside intent", () => {
  const { inventory, matrix, document, ids } = fixture()
  const previous = buildFacetIntentDocument(document, inventory, matrix, { facets: [FACET], mode: "source", groupIds: ["second"], sourceZoneId: ids[1] }).document
  const result = buildFacetIntentDocument(previous, inventory, matrix, { facets: [FACET], mode: "source", groupIds: ["first"], sourceZoneId: ids[0] })
  const cells = cellStates(result.document, inventory, matrix)
  assert.equal(cells.get(ids[1]).policies[0].expected.value, "on")
  assert.equal(cells.get(ids[2]).policies[0].expected.value, "off")
  assert.notEqual(cells.get(ids[1]).status, "conflict")
})

test("outside absence is explicit and unchecking a group removes only this facet's policy", () => {
  const { inventory, matrix, document, ids } = fixture()
  const result = buildFacetIntentDocument(document, inventory, matrix, {
    facets: [FACET], mode: "source", groupIds: ["first"], sourceZoneId: ids[0], absentOutside: true,
  })
  const cells = cellStates(result.document, inventory, matrix)
  assert.equal(cells.get(ids[2]).status, "match")
  assert.equal(cells.get(ids[3]).status, "variant")
  const changed = buildFacetIntentDocument(result.document, inventory, matrix, {
    facets: [FACET], mode: "source", groupIds: ["second"], sourceZoneId: ids[0], removeGroupIds: ["first"],
  })
  assert.ok(changed.document.policies.every((policy) => policy.groupId !== "first"))
})

test("partial overlap edits preserve conflicting outside policies and their precedence", () => {
  const { inventory, matrix, document, ids } = fixture()
  let previous = document
  for (const [groupId, value] of [["second", "off"], ["third", "on"]]) previous = replaceFleetIntentPolicy(previous, {
    id: `prior-${groupId}`, groupId, facet: { ...FACET, label: "HTTPS", description: "" },
    expected: createAuthoredFleetIntentExpected(value), presenceConstraint: "required", valueConstraint: "exact",
  })
  const before = cellStates(previous, inventory, matrix)
  const result = buildFacetIntentDocument(previous, inventory, matrix, { facets: [FACET], mode: "source", groupIds: ["first"], sourceZoneId: ids[0] })
  const after = cellStates(result.document, inventory, matrix)
  assert.notEqual(after.get(ids[1]).status, "conflict")
  assert.equal(before.get(ids[2]).status, "conflict")
  for (const id of ids.slice(2)) {
    assert.equal(after.get(id).status, before.get(id).status)
    assert.deepEqual(after.get(id).policies, before.get(id).policies)
  }
})

test("failed reads, unknown zones, phase mismatches and missing facets cannot be accepted", () => {
  const { inventory, matrix, document, ids } = fixture()
  const request = { facets: [FACET], mode: "current", zoneIds: ids }
  inventory.zones[2].surfaces.settings = { ok: false, status: 403 }
  assert.throws(() => buildFacetIntentDocument(document, inventory, matrix, request), /required reads are incomplete/)
  assert.throws(() => buildFacetIntentDocument(document, inventory, matrix, { ...request, zoneIds: ["unknown"] }), /Zone is unavailable/)
  assert.throws(() => buildFacetIntentDocument(document, inventory, matrix, { ...request, facets: [{ ...FACET, key: "unknown" }] }), /Facet is unavailable/)
  assert.throws(() => buildFacetIntentDocument(document, inventory, matrix, { ...request, facets: [{ ...FACET, phase: "invalid" }] }), /phase/)
})

test("editing coverage keeps a saved custom expectation even when no live zone matches it", () => {
  const { inventory, matrix, document } = fixture()
  const expected = createAuthoredFleetIntentExpected("custom-value")
  const saved = replaceFleetIntentPolicy(document, {
    id: "saved-custom", groupId: "first", facet: { ...FACET, label: "HTTPS", description: "" },
    expected, presenceConstraint: "optional", valueConstraint: "exact",
  })
  const result = buildFacetIntentDocument(saved, inventory, matrix, {
    facets: [FACET], mode: "saved", policyId: "saved-custom", groupIds: ["first", "third"],
  })
  assert.equal(result.document.policies.length, 2)
  for (const policy of result.document.policies) {
    assert.deepEqual(policy.expected, expected)
    assert.equal(policy.presenceConstraint, "optional")
  }
})

test("facet intent service replans live under its write lock and rejects changed observations", async () => {
  const { inventory, document, ids } = fixture()
  let saved = document
  let locked = false
  let writes = 0
  const reads = []
  const service = createFleetService({
    accountId: inventory.account.id, api: { accountId: inventory.account.id }, stateFile: "test-state.json",
    readIntent: async () => structuredClone(saved),
    loadInventory: async (_api, options) => { reads.push({ locked, options }); return structuredClone(inventory) },
    persistIntent: async (_file, _account, revision, next) => {
      assert.equal(locked, true)
      assert.equal(revision, saved.revision)
      writes += 1
      saved = { ...next, revision: String(writes).repeat(64) }
      return saved
    },
    withWriteLock: async (operation) => { locked = true; try { return await operation() } finally { locked = false } },
  })
  const request = { facets: [FACET], mode: "current", zoneIds: ids.slice(0, 2) }
  const plan = await service.planFacetIntent(request)
  assert.equal(writes, 0)
  inventory.zones[0].surfaces.settings.result[0].value = "off"
  await assert.rejects(service.applyFacetIntent(request, plan.planSet.digest), { name: "AlignmentPlanChangedError" })
  assert.equal(writes, 0)
  const fresh = await service.planFacetIntent(request)
  assert.equal((await service.applyFacetIntent(request, fresh.planSet.digest)).status, "saved")
  assert.equal(writes, 1)
  assert.deepEqual(reads.map((read) => read.locked), [false, true, false, true])
  assert.ok(reads.every((read) => JSON.stringify(read.options.surfaceIds) === '["settings"]'))
})
