import assert from "node:assert/strict"
import test from "node:test"

import {
  buildAdoptionGapsView,
  buildIntentAdoptionCandidates,
  createIntentAdoptionPolicy,
  defaultAdoptionSelection,
  INTENT_ADOPTION_CLASSIFICATION,
  INTENT_ADOPTION_CONFIDENCE,
  intentAdoptionVisibleSummary,
  previewIntentAdoption,
  selectIntentAdoptionGroup,
} from "../src/intent-adoption.mjs"
import {
  createEmptyFleetIntentDocument,
  FLEET_INTENT_ALL_ZONES_GROUP_ID,
  FLEET_INTENT_MISSING_CANONICAL,
  FLEET_INTENT_PRESENCE_CONSTRAINT,
  FLEET_INTENT_VALUE_CONSTRAINT,
  replaceFleetIntentPolicy,
} from "../src/fleet-intent.mjs"

const ZONE_NAMES = [
  "alpha.example",
  "beta.example",
  "gamma.example",
  "delta.example",
]

test("guided adoption summaries retain filtered queue context", () => {
  assert.equal(
    intentAdoptionVisibleSummary(18, 162, 0),
    "18 of 162 suggestions shown | 0 selected",
  )
  assert.equal(
    intentAdoptionVisibleSummary(1, 1, 1),
    "1 suggestion shown | 1 selected",
  )
  assert.equal(
    intentAdoptionVisibleSummary(4, 4, 2),
    "4 suggestions shown | 2 selected",
  )
})

function cell(value, options = {}) {
  const entry = {
    canonical: options.canonical || JSON.stringify(value),
    display: String(value),
    inspectionValue: value,
    intentCanonical: options.intentCanonical,
    resolutionCanonical: options.resolutionCanonical || JSON.stringify(value),
    resolutionSource: options.resolutionSource ?? true,
  }
  if (Object.prototype.hasOwnProperty.call(options, "intentValue")) {
    entry.intentValue = options.intentValue
  }
  return entry
}

function row(key, values, options = {}) {
  const cells = new Map()
  for (const [index, value] of values.entries()) {
    if (value === undefined) continue
    cells.set(ZONE_NAMES[index], cell(value, options.cellOptions?.[index]))
  }
  return {
    category: options.category || "Zone settings",
    cells,
    description: options.description || "",
    different: options.different ?? true,
    key,
    label: options.label || key,
    phase: options.phase || "",
  }
}

function fixture() {
  const inventory = {
    account: { id: "account-id" },
    zones: ZONE_NAMES.map((name, index) => ({
      meta: {
        id: `zone-${index + 1}`,
        name,
      },
    })),
  }
  const rows = [
    row("strong", ["on", "on", "on", "off"]),
    row("tied", ["on", "on", "off", "off"]),
    row("unique", ["one", "two", "three", "four"]),
    row("missing", ["on", undefined, undefined, undefined]),
    row("split", ["on", "on", "off", "other"]),
    row("aligned", ["on", "on", "on", "on"], { different: false }),
  ]
  return {
    document: createEmptyFleetIntentDocument("account-id"),
    inventory,
    matrix: { rows },
  }
}

test("choosing an adoption group selects the suggestion without losing its draft", () => {
  const selection = {
    expectedCanonical: '"on"',
    groupId: FLEET_INTENT_ALL_ZONES_GROUP_ID,
    policyId: "draft-policy",
    selected: false,
    valueConstraint: FLEET_INTENT_VALUE_CONSTRAINT.EXACT,
  }

  const result = selectIntentAdoptionGroup(selection, "mail-zones")

  assert.equal(result, selection)
  assert.equal(selection.groupId, "mail-zones")
  assert.equal(selection.selected, true)
  assert.equal(selection.expectedCanonical, '"on"')
  assert.equal(selection.policyId, "draft-policy")
})

test("choosing an adoption group rejects missing selections and group identifiers", () => {
  assert.throws(
    () => selectIntentAdoptionGroup(null, "mail-zones"),
    /selection is invalid/,
  )
  assert.throws(
    () => selectIntentAdoptionGroup({ selected: false }, ""),
    /requires a zone group/,
  )
})

test("guided adoption classifies every ungoverned drift pattern", () => {
  const { document, inventory, matrix } = fixture()

  const candidates = buildIntentAdoptionCandidates(document, inventory, matrix)
  const byKey = new Map(candidates.map((candidate) => [candidate.key, candidate]))

  assert.equal(candidates.length, 5)
  assert.equal(
    byKey.get("strong").classification,
    INTENT_ADOPTION_CLASSIFICATION.STRONG_CONSENSUS,
  )
  assert.equal(byKey.get("strong").confidence, INTENT_ADOPTION_CONFIDENCE.HIGH)
  assert.equal(
    byKey.get("strong").recommendation.valueConstraint,
    FLEET_INTENT_VALUE_CONSTRAINT.EXACT,
  )
  assert.equal(
    byKey.get("strong").recommendation.presenceConstraint,
    FLEET_INTENT_PRESENCE_CONSTRAINT.REQUIRED,
  )
  assert.equal(
    byKey.get("tied").classification,
    INTENT_ADOPTION_CLASSIFICATION.TIED_VARIANTS,
  )
  assert.equal(
    byKey.get("tied").recommendation.valueConstraint,
    FLEET_INTENT_VALUE_CONSTRAINT.MAY_DIFFER,
  )
  assert.equal(
    byKey.get("unique").classification,
    INTENT_ADOPTION_CLASSIFICATION.ZONE_SPECIFIC,
  )
  assert.equal(
    byKey.get("missing").classification,
    INTENT_ADOPTION_CLASSIFICATION.MISSING_COVERAGE,
  )
  assert.equal(byKey.get("missing").confidence, INTENT_ADOPTION_CONFIDENCE.REVIEW)
  assert.equal(byKey.get("missing").missingCount, 3)
  assert.equal(
    byKey.get("missing").recommendation.presenceConstraint,
    FLEET_INTENT_PRESENCE_CONSTRAINT.OPTIONAL,
  )
  assert.equal(
    byKey.get("split").classification,
    INTENT_ADOPTION_CLASSIFICATION.SPLIT_CONSENSUS,
  )
  assert.equal(byKey.has("aligned"), false)
})

test("guided adoption ignores facets that already have a policy", () => {
  const fixtureData = fixture()
  const candidate = buildIntentAdoptionCandidates(
    fixtureData.document,
    fixtureData.inventory,
    fixtureData.matrix,
  ).find((entry) => entry.key === "strong")
  const policy = createIntentAdoptionPolicy(candidate, {
    expectedCanonical: candidate.recommendation.expectedCanonical,
    groupId: FLEET_INTENT_ALL_ZONES_GROUP_ID,
    policyId: "governed-policy",
    valueConstraint: candidate.recommendation.valueConstraint,
  })
  const governed = replaceFleetIntentPolicy(fixtureData.document, policy)

  const candidates = buildIntentAdoptionCandidates(
    governed,
    fixtureData.inventory,
    fixtureData.matrix,
  )

  assert.equal(candidates.some((entry) => entry.key === "strong"), false)
})

test("exact adoption uses intent-normalized values and a resolution-capable source", () => {
  const { document, inventory } = fixture()
  const normalizedRow = row("normalized", ["a.example", "b.example", undefined, undefined], {
    cellOptions: [
      {
        intentCanonical: '"{zone}"',
        intentValue: "{zone}",
        resolutionSource: false,
      },
      {
        intentCanonical: '"{zone}"',
        intentValue: "{zone}",
        resolutionSource: true,
      },
    ],
  })
  const candidate = buildIntentAdoptionCandidates(
    document,
    inventory,
    { rows: [normalizedRow] },
  )[0]

  const policy = createIntentAdoptionPolicy(candidate, {
    expectedCanonical: candidate.recommendation.expectedCanonical,
    groupId: FLEET_INTENT_ALL_ZONES_GROUP_ID,
    policyId: "normalized-policy",
    valueConstraint: FLEET_INTENT_VALUE_CONSTRAINT.EXACT,
  })

  assert.equal(candidate.variants.length, 1)
  assert.equal(candidate.variants[0].count, 2)
  assert.equal(policy.expected.canonical, '"{zone}"')
  assert.equal(policy.expected.value, "{zone}")
  assert.equal(policy.expected.sourceZoneName, "beta.example")
})

test("exact adoption persists the editable rule projection without inspection metadata", () => {
  const { document, inventory } = fixture()
  const leading = {
    action: "set_config",
    action_parameters: { security_level: "essentially_off" },
    description: "Protect service",
    enabled: true,
    expression: "true",
  }
  const alternate = {
    ...leading,
    action_parameters: { security_level: "low" },
  }
  const inspectionValue = {
    ...leading,
    id: "rule-id",
  }
  const ruleRow = row(
    "http_config_settings:protect service",
    [inspectionValue, inspectionValue, inspectionValue, {
      ...inspectionValue,
      ...alternate,
      id: "alternate-rule-id",
    }],
    {
      category: "Ruleset rules",
      cellOptions: [
        { canonical: JSON.stringify(leading), intentCanonical: JSON.stringify(leading) },
        { canonical: JSON.stringify(leading), intentCanonical: JSON.stringify(leading) },
        { canonical: JSON.stringify(leading), intentCanonical: JSON.stringify(leading) },
        { canonical: JSON.stringify(alternate), intentCanonical: JSON.stringify(alternate) },
      ],
      label: "Protect service",
      phase: "http_config_settings",
    },
  )
  const candidate = buildIntentAdoptionCandidates(
    document,
    inventory,
    { rows: [ruleRow] },
  )[0]
  const policy = createIntentAdoptionPolicy(candidate, {
    expectedCanonical: candidate.recommendation.expectedCanonical,
    groupId: FLEET_INTENT_ALL_ZONES_GROUP_ID,
    policyId: "rule-policy",
    valueConstraint: FLEET_INTENT_VALUE_CONSTRAINT.EXACT,
  })

  assert.deepEqual(candidate.variants[0].value, leading)
  assert.deepEqual(candidate.variants[0].inspectionValue, inspectionValue)
  assert.deepEqual(policy.expected.value, leading)
  assert.equal(policy.facet.phase, "http_config_settings")
})

test("adoption preview reports the policy effect before persistence", () => {
  const { document, inventory, matrix } = fixture()
  const candidates = buildIntentAdoptionCandidates(document, inventory, matrix)
  const strong = candidates.find((candidate) => candidate.key === "strong")
  const tied = candidates.find((candidate) => candidate.key === "tied")

  const preview = previewIntentAdoption(document, inventory, matrix, [
    {
      candidate: strong,
      selection: {
        expectedCanonical: strong.recommendation.expectedCanonical,
        groupId: FLEET_INTENT_ALL_ZONES_GROUP_ID,
        policyId: "strong-policy",
        valueConstraint: FLEET_INTENT_VALUE_CONSTRAINT.EXACT,
      },
    },
    {
      candidate: tied,
      selection: {
        expectedCanonical: null,
        groupId: FLEET_INTENT_ALL_ZONES_GROUP_ID,
        policyId: "tied-policy",
        valueConstraint: FLEET_INTENT_VALUE_CONSTRAINT.MAY_DIFFER,
      },
    },
  ])

  assert.equal(preview.document.policies.length, 2)
  assert.deepEqual(preview.summary, {
    actionableCells: 1,
    conflictCells: 0,
    matchingCells: 7,
    missingCells: 0,
    policiesAdded: 2,
    targetedCells: 8,
    variantCells: 1,
  })
})

test("optional adoption preserves sparse observed coverage without actionable holes", () => {
  const { document, inventory, matrix } = fixture()
  const candidate = buildIntentAdoptionCandidates(document, inventory, matrix)
    .find((entry) => entry.key === "missing")
  const preview = previewIntentAdoption(document, inventory, matrix, [{
    candidate,
    selection: {
      expectedCanonical: candidate.recommendation.expectedCanonical,
      groupId: FLEET_INTENT_ALL_ZONES_GROUP_ID,
      policyId: "optional-policy",
      presenceConstraint: candidate.recommendation.presenceConstraint,
      valueConstraint: candidate.recommendation.valueConstraint,
    },
  }])

  assert.equal(preview.policies[0].presenceConstraint, FLEET_INTENT_PRESENCE_CONSTRAINT.OPTIONAL)
  assert.equal(preview.summary.actionableCells, 0)
  assert.equal(preview.summary.matchingCells, 4)
})

test("adoption candidates name present and missing zones", () => {
  const { document, inventory, matrix } = fixture()
  const byKey = new Map(
    buildIntentAdoptionCandidates(document, inventory, matrix)
      .map((candidate) => [candidate.key, candidate]),
  )

  assert.deepEqual(byKey.get("missing").presentZones, ["alpha.example"])
  assert.deepEqual(byKey.get("missing").missingZones, [
    "beta.example",
    "gamma.example",
    "delta.example",
  ])
  assert.deepEqual(byKey.get("strong").missingZones, [])

  const strongVariants = new Map(
    byKey.get("strong").variants.map((variant) => [variant.display, variant.zones]),
  )
  assert.deepEqual(strongVariants.get("on"), [
    "alpha.example",
    "beta.example",
    "gamma.example",
  ])
  assert.deepEqual(strongVariants.get("off"), ["delta.example"])
})

test("adoption gaps view splits presence/value gaps, ranks them, tallies outliers", () => {
  const { document, inventory, matrix } = fixture()
  const view = buildAdoptionGapsView(
    buildIntentAdoptionCandidates(document, inventory, matrix),
  )

  // "missing" is the only presence gap; "tied"/"unique" are excluded.
  assert.deepEqual(view.presenceGaps.map((gap) => gap.candidate.key), ["missing"])
  assert.deepEqual(view.presenceGaps[0].outlierZones, [
    "beta.example",
    "gamma.example",
    "delta.example",
  ])

  // value gaps ranked by majority ratio: strong (3/4) before split (2/4).
  assert.deepEqual(view.valueGaps.map((gap) => gap.candidate.key), ["strong", "split"])

  // delta is an outlier in missing+strong+split, gamma in missing+split, beta in missing.
  assert.deepEqual(view.perZoneOutlierTally, {
    "delta.example": 3,
    "gamma.example": 2,
    "beta.example": 1,
  })
})

test("adoption selection defaults presence to required", () => {
  const { document, inventory, matrix } = fixture()
  const missing = buildIntentAdoptionCandidates(document, inventory, matrix)
    .find((candidate) => candidate.key === "missing")

  // the engine's own recommendation for a missing-on-most facet is optional
  assert.equal(
    missing.recommendation.presenceConstraint,
    FLEET_INTENT_PRESENCE_CONSTRAINT.OPTIONAL,
  )

  const selection = defaultAdoptionSelection(missing, { policyId: "gap-policy" })
  assert.equal(selection.presenceConstraint, FLEET_INTENT_PRESENCE_CONSTRAINT.REQUIRED)
  assert.equal(selection.groupId, FLEET_INTENT_ALL_ZONES_GROUP_ID)
  assert.equal(selection.policyId, "gap-policy")
  assert.equal(selection.expectedCanonical, missing.recommendation.expectedCanonical)
})

test("adopting a missing facet as required surfaces gaps that exemptions acknowledge", () => {
  const { document, inventory, matrix } = fixture()
  const missing = buildIntentAdoptionCandidates(document, inventory, matrix)
    .find((candidate) => candidate.key === "missing")
  const selection = defaultAdoptionSelection(missing, { policyId: "gap-policy" })
  const entries = [{ candidate: missing, selection }]

  const surfaced = previewIntentAdoption(document, inventory, matrix, entries)
  assert.equal(surfaced.summary.actionableCells, 3)
  assert.equal(surfaced.summary.missingCells, 3)

  const exemptions = ["beta.example", "gamma.example", "delta.example"].map((zoneName) => ({
    policyId: "gap-policy",
    zoneName,
    zoneId: inventory.zones.find((zone) => zone.meta.name === zoneName).meta.id,
    reason: "No mail on this zone",
    observedCanonical: FLEET_INTENT_MISSING_CANONICAL,
  }))
  const exempted = previewIntentAdoption(document, inventory, matrix, entries, exemptions)
  assert.equal(exempted.summary.actionableCells, 0)
  assert.equal(exempted.summary.missingCells, 0)
  assert.equal(exempted.document.acknowledgements.length, 3)
})
