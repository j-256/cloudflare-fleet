import assert from "node:assert/strict"
import test from "node:test"

import {
  ALIGNMENT_PREPARATION_STATUS,
  ALIGNMENT_SELECTOR_KIND,
  createAlignmentBatchPlanSet,
  createAlignmentPlanSet,
  listIntentAlignmentCandidates,
  normalizeAlignmentSelector,
  normalizeAlignmentSelectors,
  prepareIntentAlignment,
  prepareIntentAlignments,
} from "../src/alignment-service.mjs"
import {
  FLEET_INTENT_ALL_ZONES_GROUP_ID,
  FLEET_INTENT_EXPECTED_ORIGIN,
  FLEET_INTENT_PRESENCE_CONSTRAINT,
  FLEET_INTENT_VALUE_CONSTRAINT,
  createEmptyFleetIntentDocument,
  replaceFleetIntentPolicy,
} from "../src/fleet-intent.mjs"
import { facetCellComparisonValue } from "../src/facet-equivalence.mjs"
import { buildMatrix } from "../src/matrix.mjs"
import { makeInventory, makeZone } from "./fixtures.mjs"

function settingFixture(options = {}) {
  const alpha = makeZone("alpha.example")
  const bravo = makeZone("bravo.example", {
    settings: [{
      editable: options.bravoEditable !== false,
      id: "always_use_https",
      value: "off",
    }],
  })
  const inventory = makeInventory([alpha, bravo])
  const row = buildMatrix(inventory).rows.find((entry) => (
    entry.category === "Zone settings"
      && entry.key === "always_use_https"
  ))
  const source = row.cells.get(alpha.meta.name)
  const policy = {
    expected: {
      canonical: source.intentCanonical,
      display: source.display,
      origin: FLEET_INTENT_EXPECTED_ORIGIN.OBSERVED,
      resolutionCanonical: source.resolutionCanonical,
      sourceZoneId: alpha.meta.id,
      sourceZoneName: alpha.meta.name,
      value: facetCellComparisonValue(source),
    },
    facet: {
      category: row.category,
      description: row.description,
      key: row.key,
      label: row.label,
    },
    groupId: FLEET_INTENT_ALL_ZONES_GROUP_ID,
    id: "policy-https",
    presenceConstraint: FLEET_INTENT_PRESENCE_CONSTRAINT.REQUIRED,
    valueConstraint: FLEET_INTENT_VALUE_CONSTRAINT.EXACT,
  }
  const intent = replaceFleetIntentPolicy(
    createEmptyFleetIntentDocument(inventory.account.id),
    policy,
  )
  return {
    api: { accountId: inventory.account.id },
    intent,
    inventory,
    policy,
    row,
  }
}

function settingBatchFixture(options = {}) {
  const settingIds = ["always_use_https", "early_hints"]
  const alpha = makeZone("alpha.example", {
    settings: settingIds.map((id) => ({ editable: true, id, value: "on" })),
  })
  const bravo = makeZone("bravo.example", {
    settings: settingIds.map((id) => ({
      editable: id !== "early_hints" || options.earlyHintsEditable !== false,
      id,
      value: "off",
    })),
  })
  const inventory = makeInventory([alpha, bravo])
  const matrix = buildMatrix(inventory)
  let intent = createEmptyFleetIntentDocument(inventory.account.id)
  const policies = settingIds.map((settingId) => {
    const row = matrix.rows.find((entry) => (
      entry.category === "Zone settings" && entry.key === settingId
    ))
    const source = row.cells.get(alpha.meta.name)
    const policy = {
      expected: {
        canonical: source.intentCanonical,
        display: source.display,
        origin: FLEET_INTENT_EXPECTED_ORIGIN.OBSERVED,
        resolutionCanonical: source.resolutionCanonical,
        sourceZoneId: alpha.meta.id,
        sourceZoneName: alpha.meta.name,
        value: facetCellComparisonValue(source),
      },
      facet: {
        category: row.category,
        description: row.description,
        key: row.key,
        label: row.label,
      },
      groupId: FLEET_INTENT_ALL_ZONES_GROUP_ID,
      id: `policy-${settingId}`,
      presenceConstraint: FLEET_INTENT_PRESENCE_CONSTRAINT.REQUIRED,
      valueConstraint: FLEET_INTENT_VALUE_CONSTRAINT.EXACT,
    }
    intent = replaceFleetIntentPolicy(intent, policy)
    return policy
  })
  return {
    api: { accountId: inventory.account.id },
    intent,
    inventory,
    policies,
  }
}

test("alignment selectors distinguish policy, row, and cell scopes", () => {
  assert.deepEqual(
    normalizeAlignmentSelector({ policyId: "policy-one" }),
    {
      kind: ALIGNMENT_SELECTOR_KIND.POLICY,
      policyId: "policy-one",
    },
  )
  assert.deepEqual(
    normalizeAlignmentSelector({
      category: "Zone settings",
      key: "always_use_https",
    }),
    {
      category: "Zone settings",
      key: "always_use_https",
      kind: ALIGNMENT_SELECTOR_KIND.ROW,
      phase: "",
      zoneIds: null,
    },
  )
  assert.deepEqual(
    normalizeAlignmentSelector({
      category: "Zone settings",
      key: "always_use_https",
      zoneIds: ["zone-two", "zone-one", "zone-two"],
    }),
    {
      category: "Zone settings",
      key: "always_use_https",
      kind: ALIGNMENT_SELECTOR_KIND.CELL,
      phase: "",
      zoneIds: ["zone-one", "zone-two"],
    },
  )
  assert.throws(
    () => normalizeAlignmentSelector({ policyId: "policy-one", zoneIds: ["zone-one"] }),
    /cannot include facet or zone fields/,
  )
  assert.deepEqual(
    normalizeAlignmentSelectors([
      { policyId: "policy-one" },
      { category: "Zone settings", key: "early_hints" },
    ]).map((selector) => selector.kind),
    [ALIGNMENT_SELECTOR_KIND.POLICY, ALIGNMENT_SELECTOR_KIND.ROW],
  )
  assert.throws(
    () => normalizeAlignmentSelectors([
      { policyId: "policy-one" },
      { policyId: "policy-one" },
    ]),
    /must be unique/,
  )
})

test("alignment candidate listing exposes row and policy review scopes", () => {
  const fixture = settingFixture()
  const result = listIntentAlignmentCandidates(
    fixture.inventory,
    fixture.intent,
  )

  assert.equal(result.summary.actionableCells, 1)
  assert.equal(result.summary.availableCandidates, 2)
  assert.deepEqual(
    result.candidates.map((entry) => [entry.scope, entry.policyId]),
    [
      [ALIGNMENT_SELECTOR_KIND.POLICY, "policy-https"],
      [ALIGNMENT_SELECTOR_KIND.ROW, null],
    ],
  )
  assert.equal(result.candidates[0].assessment.targetZones[0].zoneName, "bravo.example")
})

test("alignment preparation rereads the scoped facet and returns a digest-bound plan", async () => {
  const fixture = settingFixture()
  let reads = 0
  const result = await prepareIntentAlignment(
    fixture.api,
    fixture.intent,
    { policyId: fixture.policy.id },
    {
      baselineInventory: fixture.inventory,
      executeReadPlan: async (_api, requirements) => {
        reads += 1
        assert.deepEqual(requirements[0].surfaceIds, ["settings"])
        assert.equal(requirements[0].zoneIds, undefined)
        return { inventory: fixture.inventory }
      },
      validatedAt: "2026-08-12T00:00:00.000Z",
    },
  )

  assert.equal(reads, 1)
  assert.equal(result.status, ALIGNMENT_PREPARATION_STATUS.PLANNED)
  assert.match(result.planSet.digest, /^sha256:[a-f0-9]{64}$/)
  assert.equal(result.planSet.preview.length, 1)
  assert.deepEqual(result.planSet.preview[0].body, { value: "on" })
  assert.equal(result.planSet.preview[0].zoneName, "bravo.example")
})

test("alignment plan digests ignore validation time and bind exact operations", async () => {
  const fixture = settingFixture()
  const plans = [{
    id: "plan-one",
    kind: "intent-alignment",
    operations: [{
      body: { value: "on" },
      currentValue: "off",
      label: "Set always_use_https",
      method: "PATCH",
      path: "zones/zone-bravo.example/settings/always_use_https",
    }],
    summary: "Align Always Use HTTPS",
    zoneId: "zone-bravo.example",
    zoneName: "bravo.example",
  }]
  const common = {
    accountId: fixture.inventory.account.id,
    intentRevision: fixture.intent.revision,
    inventory: fixture.inventory,
    plans,
    selector: { policyId: fixture.policy.id },
  }
  const first = await createAlignmentPlanSet({
    ...common,
    validatedAt: "2026-08-12T00:00:00.000Z",
  })
  const second = await createAlignmentPlanSet({
    ...common,
    validatedAt: "2026-08-12T00:01:00.000Z",
  })
  const changedPlans = structuredClone(plans)
  changedPlans[0].operations[0].body.value = "off"
  const changed = await createAlignmentPlanSet({
    ...common,
    plans: changedPlans,
  })

  assert.equal(first.digest, second.digest)
  assert.notEqual(first.digest, changed.digest)
})

test("batch alignment composes shared surface reads and binds every selector", async () => {
  const fixture = settingBatchFixture()
  const selectors = fixture.policies.map((policy) => ({ policyId: policy.id }))
  const requests = []
  let zoneReads = 0
  const api = {
    accountId: fixture.api.accountId,
    async listZones() {
      zoneReads += 1
      return fixture.inventory.zones.map((zone) => zone.meta)
    },
    async request(path) {
      requests.push(path)
      const zone = fixture.inventory.zones.find(
        (entry) => path === `zones/${entry.meta.id}/settings`,
      )
      return {
        result: zone.surfaces.settings.result,
        status: 200,
      }
    },
  }
  const result = await prepareIntentAlignments(
    api,
    fixture.intent,
    selectors,
    {
      baselineInventory: fixture.inventory,
      validatedAt: "2026-08-13T00:00:00.000Z",
    },
  )

  assert.equal(zoneReads, 1)
  assert.deepEqual(requests, [
    "zones/zone-alpha.example/settings",
    "zones/zone-bravo.example/settings",
  ])
  assert.equal(result.status, ALIGNMENT_PREPARATION_STATUS.PLANNED)
  assert.equal(result.alignments.length, 2)
  assert.equal(result.planSet.preview.length, 2)
  assert.deepEqual(result.planSet.selectors, normalizeAlignmentSelectors(selectors))
  assert.match(result.planSet.digest, /^sha256:[a-f0-9]{64}$/)
})

test("batch plan digests bind selector order and exact operations", async () => {
  const fixture = settingBatchFixture()
  const selectors = fixture.policies.map((policy) => ({ policyId: policy.id }))
  const plans = [{
    id: "plan-one",
    kind: "intent-alignment",
    operations: [{
      body: { value: "on" },
      currentValue: "off",
      label: "Set always_use_https",
      method: "PATCH",
      path: "zones/zone-bravo.example/settings/always_use_https",
    }],
    summary: "Align Always Use HTTPS",
    zoneId: "zone-bravo.example",
    zoneName: "bravo.example",
  }]
  const common = {
    accountId: fixture.inventory.account.id,
    intentRevision: fixture.intent.revision,
    inventory: fixture.inventory,
    plans,
  }
  const first = await createAlignmentBatchPlanSet({
    ...common,
    selectors,
  })
  const reordered = await createAlignmentBatchPlanSet({
    ...common,
    selectors: [...selectors].reverse(),
  })

  assert.notEqual(first.digest, reordered.digest)
})

test("one blocked selector blocks the complete alignment batch", async () => {
  const fixture = settingBatchFixture({ earlyHintsEditable: false })
  const result = await prepareIntentAlignments(
    fixture.api,
    fixture.intent,
    fixture.policies.map((policy) => ({ policyId: policy.id })),
    {
      baselineInventory: fixture.inventory,
      executeReadPlan: async () => ({ inventory: fixture.inventory }),
    },
  )

  assert.equal(result.status, ALIGNMENT_PREPARATION_STATUS.BLOCKED)
  assert.equal(result.planSet, null)
  assert.match(result.reason, /early_hints/)
})

test("batch alignment rejects selectors with overlapping write targets", async () => {
  const fixture = settingFixture()
  const result = await prepareIntentAlignments(
    fixture.api,
    fixture.intent,
    [
      { policyId: fixture.policy.id },
      { category: "Zone settings", key: "always_use_https" },
    ],
    {
      baselineInventory: fixture.inventory,
      executeReadPlan: async () => ({ inventory: fixture.inventory }),
    },
  )

  assert.equal(result.status, ALIGNMENT_PREPARATION_STATUS.BLOCKED)
  assert.match(result.reason, /overlapping writes/)
})

test("alignment preparation reports deterministic blockers without a live read", async () => {
  const fixture = settingFixture({ bravoEditable: false })
  let reads = 0
  const result = await prepareIntentAlignment(
    fixture.api,
    fixture.intent,
    { policyId: fixture.policy.id },
    {
      baselineInventory: fixture.inventory,
      executeReadPlan: async () => {
        reads += 1
        return { inventory: fixture.inventory }
      },
    },
  )

  assert.equal(reads, 0)
  assert.equal(result.status, ALIGNMENT_PREPARATION_STATUS.BLOCKED)
  assert.match(result.reason, /no direct exact-value alignment adapter/)
})

test("alignment preparation rejects fleet membership changes", async () => {
  const fixture = settingFixture()
  const changedInventory = makeInventory([
    fixture.inventory.zones[0],
  ])

  await assert.rejects(
    prepareIntentAlignment(
      fixture.api,
      fixture.intent,
      { policyId: fixture.policy.id },
      {
        baselineInventory: fixture.inventory,
        executeReadPlan: async () => ({ inventory: changedInventory }),
      },
    ),
    /Fleet membership changed during live validation/,
  )
})

test("alignment preparation rejects incomplete scoped surface reads", async () => {
  const fixture = settingFixture()
  const incomplete = structuredClone(fixture.inventory)
  incomplete.zones[1].surfaces.settings = {
    error: { message: "Forbidden" },
    ok: false,
    result: null,
    status: 403,
  }

  await assert.rejects(
    prepareIntentAlignment(
      fixture.api,
      fixture.intent,
      { policyId: fixture.policy.id },
      {
        baselineInventory: fixture.inventory,
        executeReadPlan: async () => ({ inventory: incomplete }),
      },
    ),
    /bravo\.example: settings/,
  )
})
