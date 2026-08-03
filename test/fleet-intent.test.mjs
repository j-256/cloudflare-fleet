import assert from "node:assert/strict"
import test from "node:test"

import {
  createAuthoredFleetIntentExpected,
  createEmptyFleetIntentDocument,
  evaluateFleetIntent,
  evaluateFleetIntentCoverage,
  FLEET_INTENT_ACKNOWLEDGEMENT_STATUS,
  FLEET_INTENT_ALL_ZONES_GROUP_ID,
  FLEET_INTENT_CELL_STATUS,
  FLEET_INTENT_COVERAGE_EXPECTATION_STATUS,
  FLEET_INTENT_EXPECTED_ORIGIN,
  FLEET_INTENT_GROUP_MODE,
  FLEET_INTENT_MISSING_CANONICAL,
  FLEET_INTENT_SCHEMA_VERSION,
  FLEET_INTENT_VALUE_CONSTRAINT,
  fleetIntentFacetId,
  fleetIntentExpectedIsAuthored,
  fleetIntentPolicyValueConstraint,
  isFleetIntentDocument,
  migrateFleetIntentDocument,
  removeFleetIntentGroup,
  removeFleetIntentPolicy,
  removeFleetIntentCoverageExpectation,
  replaceFleetIntentAcknowledgement,
  replaceFleetIntentCoverageExpectation,
  replaceFleetIntentGroup,
  replaceFleetIntentPolicy,
} from "../src/fleet-intent.mjs"

function fixture() {
  const zones = [
    { meta: { id: "zone-a", name: "a.example" } },
    { meta: { id: "zone-b", name: "b.example" } },
    { meta: { id: "zone-c", name: "c.example" } },
  ]
  const row = {
    category: "Zone settings",
    cells: new Map([
      ["a.example", {
        canonical: '"on"',
        uniquenessCanonical: '"a-value"',
      }],
      ["b.example", {
        canonical: '"off"',
        uniquenessCanonical: '"b-value"',
      }],
    ]),
    different: true,
    key: "always_use_https",
    label: "Always use HTTPS",
  }
  return {
    inventory: {
      account: { id: "account-id" },
      zones,
    },
    matrix: {
      rows: [row],
    },
    row,
  }
}

function policy(row, options = {}) {
  const entry = {
    expected: Object.prototype.hasOwnProperty.call(options, "expected")
      ? options.expected
      : {
        canonical: options.canonical || '"on"',
        display: options.display || "on",
        resolutionCanonical: options.resolutionCanonical || '"on"',
        sourceZoneId: "zone-a",
        sourceZoneName: "a.example",
        value: options.value || "on",
      },
    facet: {
      category: row.category,
      description: "",
      key: row.key,
      label: row.label,
    },
    groupId: options.groupId || FLEET_INTENT_ALL_ZONES_GROUP_ID,
    id: options.id || "policy-one",
  }
  if (options.valueConstraint) entry.valueConstraint = options.valueConstraint
  return entry
}

test("empty fleet intent is valid and includes a dynamic all-zones group", () => {
  const document = createEmptyFleetIntentDocument("account-id")

  assert.equal(isFleetIntentDocument(document, "account-id"), true)
  assert.deepEqual(document.groups, [{
    id: FLEET_INTENT_ALL_ZONES_GROUP_ID,
    members: [],
    mode: FLEET_INTENT_GROUP_MODE.ALL,
    name: "All zones",
  }])
  assert.deepEqual(document.coverageExpectations, [])
})

test("authored expected values are stable, source-free, and schema-compatible", () => {
  const { row } = fixture()
  const value = {
    ttl: 300,
    enabled: true,
    targets: ["{zone}", "mail.example"],
  }
  const expected = createAuthoredFleetIntentExpected(value)
  value.targets.push("changed-after-copy")

  assert.deepEqual(expected, {
    canonical: "{\"enabled\":true,\"targets\":[\"{zone}\",\"mail.example\"],\"ttl\":300}",
    display: "3 fields",
    origin: FLEET_INTENT_EXPECTED_ORIGIN.AUTHORED,
    resolutionCanonical: null,
    sourceZoneId: null,
    sourceZoneName: null,
    value: {
      ttl: 300,
      enabled: true,
      targets: ["{zone}", "mail.example"],
    },
  })
  assert.equal(fleetIntentExpectedIsAuthored(expected), true)

  let document = createEmptyFleetIntentDocument("account-id")
  document = replaceFleetIntentPolicy(document, policy(row, { expected }))
  assert.equal(isFleetIntentDocument(document, "account-id"), true)
})

test("legacy observed values remain valid while authored values reject fake sources", () => {
  const { row } = fixture()
  let document = createEmptyFleetIntentDocument("account-id")
  document = replaceFleetIntentPolicy(document, policy(row))
  assert.equal(isFleetIntentDocument(document, "account-id"), true)
  assert.equal(
    fleetIntentPolicyValueConstraint(document.policies[0]),
    FLEET_INTENT_VALUE_CONSTRAINT.EXACT,
  )

  const expected = {
    ...createAuthoredFleetIntentExpected("on"),
    sourceZoneId: "zone-a",
    sourceZoneName: "a.example",
  }
  assert.throws(
    () => replaceFleetIntentPolicy(document, policy(row, { expected })),
    /invalid/,
  )
})

test("legacy documents migrate exact policies without changing their revision", () => {
  const { row } = fixture()
  let legacy = createEmptyFleetIntentDocument("account-id")
  legacy = replaceFleetIntentPolicy(legacy, policy(row))
  legacy.schemaVersion = 1
  legacy.revision = "a".repeat(64)

  const migrated = migrateFleetIntentDocument(legacy, "account-id")

  assert.equal(migrated.schemaVersion, FLEET_INTENT_SCHEMA_VERSION)
  assert.equal(migrated.revision, legacy.revision)
  assert.equal(
    migrated.policies[0].valueConstraint,
    FLEET_INTENT_VALUE_CONSTRAINT.EXACT,
  )
  assert.equal(isFleetIntentDocument(migrated, "account-id"), true)
  assert.throws(
    () => migrateFleetIntentDocument({
      ...legacy,
      policies: [{
        ...legacy.policies[0],
        expected: null,
        valueConstraint: FLEET_INTENT_VALUE_CONSTRAINT.MAY_DIFFER,
      }],
    }, "account-id"),
    /cannot be migrated/,
  )
})

test("version two documents gain empty coverage intent without changing revision", () => {
  const legacy = createEmptyFleetIntentDocument("account-id")
  delete legacy.coverageExpectations
  legacy.schemaVersion = 2
  legacy.revision = "b".repeat(64)

  const migrated = migrateFleetIntentDocument(legacy, "account-id")

  assert.equal(migrated.schemaVersion, FLEET_INTENT_SCHEMA_VERSION)
  assert.equal(migrated.revision, legacy.revision)
  assert.deepEqual(migrated.coverageExpectations, [])
  assert.equal(isFleetIntentDocument(migrated, "account-id"), true)
})

test("coverage expectations are unique per inventory target", () => {
  const timestamp = new Date().toISOString()
  const expectation = {
    createdAt: timestamp,
    id: "coverage-one",
    kind: "surface",
    observedCanonical: "{\"status\":403}",
    reason: "The product is not enabled",
    subjectId: "bot-management",
    subjectLabel: "Bot management",
    updatedAt: timestamp,
    zoneId: "zone-a",
    zoneName: "a.example",
  }
  let document = createEmptyFleetIntentDocument("account-id")
  document = replaceFleetIntentCoverageExpectation(document, expectation)

  assert.equal(isFleetIntentDocument(document, "account-id"), true)
  assert.throws(
    () => replaceFleetIntentCoverageExpectation(document, {
      ...expectation,
      id: "coverage-two",
    }),
    /already has an expectation/,
  )
  assert.throws(
    () => replaceFleetIntentCoverageExpectation(document, {
      ...expectation,
      id: "coverage-limitation",
      kind: "limitation",
    }),
    /invalid/,
  )
  document = removeFleetIntentCoverageExpectation(document, expectation.id)
  assert.deepEqual(document.coverageExpectations, [])
})

test("coverage intent separates expected, changed, and inactive failures", () => {
  const timestamp = new Date().toISOString()
  const issue = {
    detail: "Plan does not include Bot Management",
    kind: "surface",
    observedCanonical: "{\"status\":403}",
    subjectId: "bot-management",
    subjectLabel: "Bot management",
    zoneId: "zone-a",
    zoneName: "a.example",
  }
  let document = createEmptyFleetIntentDocument("account-id")
  document = replaceFleetIntentCoverageExpectation(document, {
    ...issue,
    createdAt: timestamp,
    id: "coverage-one",
    reason: "The zone uses the free plan",
    updatedAt: timestamp,
  })

  let evaluation = evaluateFleetIntentCoverage(document, [issue])
  assert.equal(evaluation.expectedIssues.length, 1)
  assert.equal(evaluation.unexpectedIssues.length, 0)
  assert.equal(
    evaluation.expectationStates[0].status,
    FLEET_INTENT_COVERAGE_EXPECTATION_STATUS.ACTIVE,
  )

  const changedIssue = {
    ...issue,
    detail: "Authentication failed",
    observedCanonical: "{\"status\":401}",
  }
  evaluation = evaluateFleetIntentCoverage(document, [changedIssue])
  assert.equal(evaluation.expectedIssues.length, 0)
  assert.equal(evaluation.unexpectedIssues.length, 1)
  assert.equal(
    evaluation.expectationStates[0].status,
    FLEET_INTENT_COVERAGE_EXPECTATION_STATUS.CHANGED,
  )

  evaluation = evaluateFleetIntentCoverage(document, [])
  assert.equal(
    evaluation.expectationStates[0].status,
    FLEET_INTENT_COVERAGE_EXPECTATION_STATUS.INACTIVE,
  )
})

test("non-exact constraints are source-free and reject contradictory expectations", () => {
  const { row } = fixture()
  let document = createEmptyFleetIntentDocument("account-id")
  document = replaceFleetIntentPolicy(document, policy(row, {
    expected: null,
    valueConstraint: FLEET_INTENT_VALUE_CONSTRAINT.MAY_DIFFER,
  }))
  assert.equal(isFleetIntentDocument(document, "account-id"), true)

  assert.throws(
    () => replaceFleetIntentPolicy(document, policy(row, {
      valueConstraint: FLEET_INTENT_VALUE_CONSTRAINT.MUST_DIFFER,
    })),
    /invalid/,
  )
  assert.throws(
    () => replaceFleetIntentPolicy(document, {
      ...policy(row),
      valueConstraint: "sometimes-different",
    }),
    /invalid/,
  )
})

test("may-differ intent accepts every present value and still requires presence", () => {
  const { inventory, matrix, row } = fixture()
  let document = createEmptyFleetIntentDocument("account-id")
  document = replaceFleetIntentPolicy(document, policy(row, {
    expected: null,
    valueConstraint: FLEET_INTENT_VALUE_CONSTRAINT.MAY_DIFFER,
  }))

  const evaluation = evaluateFleetIntent(document, inventory, matrix)
  const rowState = evaluation.rowStates.get(fleetIntentFacetId(row.category, row.key))
  assert.equal(rowState.cells.get("zone-a").status, FLEET_INTENT_CELL_STATUS.MATCH)
  assert.equal(rowState.cells.get("zone-b").status, FLEET_INTENT_CELL_STATUS.MATCH)
  assert.equal(rowState.cells.get("zone-c").status, FLEET_INTENT_CELL_STATUS.MISSING)
  assert.equal(evaluation.summary.actionableCells, 1)
})

test("must-differ intent flags every duplicate while accepting distinct values", () => {
  const { inventory, matrix, row } = fixture()
  let document = createEmptyFleetIntentDocument("account-id")
  document = replaceFleetIntentPolicy(document, policy(row, {
    expected: null,
    valueConstraint: FLEET_INTENT_VALUE_CONSTRAINT.MUST_DIFFER,
  }))

  let evaluation = evaluateFleetIntent(document, inventory, matrix)
  let rowState = evaluation.rowStates.get(fleetIntentFacetId(row.category, row.key))
  assert.equal(rowState.cells.get("zone-a").status, FLEET_INTENT_CELL_STATUS.MATCH)
  assert.equal(rowState.cells.get("zone-b").status, FLEET_INTENT_CELL_STATUS.MATCH)
  assert.equal(rowState.cells.get("zone-c").status, FLEET_INTENT_CELL_STATUS.MISSING)

  row.cells.get("b.example").uniquenessCanonical = '"a-value"'
  evaluation = evaluateFleetIntent(document, inventory, matrix)
  rowState = evaluation.rowStates.get(fleetIntentFacetId(row.category, row.key))
  assert.equal(rowState.cells.get("zone-a").status, FLEET_INTENT_CELL_STATUS.VARIANT)
  assert.equal(rowState.cells.get("zone-b").status, FLEET_INTENT_CELL_STATUS.VARIANT)
  assert.deepEqual(rowState.cells.get("zone-a").duplicateZoneNames, ["b.example"])
  assert.deepEqual(rowState.cells.get("zone-b").duplicateZoneNames, ["a.example"])
  assert.equal(evaluation.summary.actionableCells, 3)
})

test("must-differ intent preserves literal zone-relative uniqueness", () => {
  const { inventory, matrix, row } = fixture()
  row.cells.set("a.example", {
    canonical: '"{zone}"',
    intentCanonical: '"{zone}"',
    uniquenessCanonical: '"a.example"',
  })
  row.cells.set("b.example", {
    canonical: '"{zone}"',
    intentCanonical: '"{zone}"',
    uniquenessCanonical: '"b.example"',
  })
  let document = createEmptyFleetIntentDocument("account-id")
  document = replaceFleetIntentPolicy(document, policy(row, {
    expected: null,
    valueConstraint: FLEET_INTENT_VALUE_CONSTRAINT.MUST_DIFFER,
  }))

  const evaluation = evaluateFleetIntent(document, inventory, matrix)
  const rowState = evaluation.rowStates.get(fleetIntentFacetId(row.category, row.key))
  assert.equal(rowState.cells.get("zone-a").status, FLEET_INTENT_CELL_STATUS.MATCH)
  assert.equal(rowState.cells.get("zone-b").status, FLEET_INTENT_CELL_STATUS.MATCH)
})

test("must-differ acknowledgements stay local and become stale when a collision clears", () => {
  const { inventory, matrix, row } = fixture()
  row.cells.get("b.example").uniquenessCanonical = '"a-value"'
  let document = createEmptyFleetIntentDocument("account-id")
  document = replaceFleetIntentPolicy(document, policy(row, {
    expected: null,
    valueConstraint: FLEET_INTENT_VALUE_CONSTRAINT.MUST_DIFFER,
  }))
  const timestamp = new Date().toISOString()
  document = replaceFleetIntentAcknowledgement(document, {
    createdAt: timestamp,
    id: "ack-duplicate",
    observedCanonical: '"off"',
    policyId: "policy-one",
    reason: "Migration overlap",
    updatedAt: timestamp,
    zoneId: "zone-b",
    zoneName: "b.example",
  })

  let evaluation = evaluateFleetIntent(document, inventory, matrix)
  let rowState = evaluation.rowStates.get(fleetIntentFacetId(row.category, row.key))
  assert.equal(rowState.cells.get("zone-a").status, FLEET_INTENT_CELL_STATUS.VARIANT)
  assert.equal(rowState.cells.get("zone-b").status, FLEET_INTENT_CELL_STATUS.ACKNOWLEDGED)

  row.cells.get("b.example").uniquenessCanonical = '"new-b-value"'
  evaluation = evaluateFleetIntent(document, inventory, matrix)
  rowState = evaluation.rowStates.get(fleetIntentFacetId(row.category, row.key))
  assert.equal(rowState.cells.get("zone-b").status, FLEET_INTENT_CELL_STATUS.MATCH)
  assert.equal(
    evaluation.acknowledgementStates[0].status,
    FLEET_INTENT_ACKNOWLEDGEMENT_STATUS.STALE,
  )
  assert.match(evaluation.acknowledgementStates[0].reason, /satisfies intent/)
})

test("authored expected values participate in exact intent evaluation", () => {
  const { inventory, matrix, row } = fixture()
  let document = createEmptyFleetIntentDocument("account-id")
  document = replaceFleetIntentPolicy(document, policy(row, {
    expected: createAuthoredFleetIntentExpected("off"),
  }))

  const evaluation = evaluateFleetIntent(document, inventory, matrix)
  const rowState = evaluation.rowStates.get(fleetIntentFacetId(row.category, row.key))
  assert.equal(rowState.cells.get("zone-a").status, FLEET_INTENT_CELL_STATUS.VARIANT)
  assert.equal(rowState.cells.get("zone-b").status, FLEET_INTENT_CELL_STATUS.MATCH)
  assert.equal(rowState.cells.get("zone-c").status, FLEET_INTENT_CELL_STATUS.MISSING)
})

test("group and policy mutations preserve references and remove dependent acknowledgements", () => {
  const { row } = fixture()
  let document = createEmptyFleetIntentDocument("account-id")
  document = replaceFleetIntentGroup(document, {
    id: "mail-zones",
    members: [{ zoneId: "zone-a", zoneName: "a.example" }],
    mode: FLEET_INTENT_GROUP_MODE.MEMBERS,
    name: "Mail zones",
  })
  document = replaceFleetIntentPolicy(document, policy(row, {
    groupId: "mail-zones",
  }))
  const timestamp = new Date().toISOString()
  document = replaceFleetIntentAcknowledgement(document, {
    createdAt: timestamp,
    id: "ack-one",
    observedCanonical: '"off"',
    policyId: "policy-one",
    reason: "Intentional test",
    updatedAt: timestamp,
    zoneId: "zone-b",
    zoneName: "b.example",
  })

  assert.throws(
    () => removeFleetIntentGroup(document, "mail-zones"),
    /Remove or retarget policies/,
  )
  document = removeFleetIntentPolicy(document, "policy-one")
  assert.equal(document.acknowledgements.length, 0)
  document = removeFleetIntentGroup(document, "mail-zones")
  assert.equal(document.groups.length, 1)
})

test("zone group names are unique regardless of case", () => {
  let document = createEmptyFleetIntentDocument("account-id")
  document = replaceFleetIntentGroup(document, {
    id: "primary-zones",
    members: [{ zoneId: "zone-a", zoneName: "a.example" }],
    mode: FLEET_INTENT_GROUP_MODE.MEMBERS,
    name: "Primary zones",
  })

  assert.throws(
    () => replaceFleetIntentGroup(document, {
      id: "duplicate-zones",
      members: [{ zoneId: "zone-b", zoneName: "b.example" }],
      mode: FLEET_INTENT_GROUP_MODE.MEMBERS,
      name: "primary ZONES",
    }),
    /must be unique/,
  )
})

test("evaluation separates intent matches, variants, and missing cells", () => {
  const { inventory, matrix, row } = fixture()
  let document = createEmptyFleetIntentDocument("account-id")
  document = replaceFleetIntentPolicy(document, policy(row))

  const evaluation = evaluateFleetIntent(document, inventory, matrix)
  const rowState = evaluation.rowStates.get(fleetIntentFacetId(row.category, row.key))

  assert.equal(rowState.cells.get("zone-a").status, FLEET_INTENT_CELL_STATUS.MATCH)
  assert.equal(rowState.cells.get("zone-b").status, FLEET_INTENT_CELL_STATUS.VARIANT)
  assert.equal(rowState.cells.get("zone-c").status, FLEET_INTENT_CELL_STATUS.MISSING)
  assert.equal(rowState.actionable, true)
  assert.equal(evaluation.summary.actionableCells, 2)
  assert.equal(evaluation.summary.actionableRows, 1)
})

test("exact acknowledgement suppresses one observed state and becomes stale after change", () => {
  const { inventory, matrix, row } = fixture()
  let document = createEmptyFleetIntentDocument("account-id")
  document = replaceFleetIntentPolicy(document, policy(row))
  const timestamp = new Date().toISOString()
  document = replaceFleetIntentAcknowledgement(document, {
    createdAt: timestamp,
    id: "ack-one",
    observedCanonical: '"off"',
    policyId: "policy-one",
    reason: "Legacy origin requires HTTP",
    updatedAt: timestamp,
    zoneId: "zone-b",
    zoneName: "b.example",
  })

  let evaluation = evaluateFleetIntent(document, inventory, matrix)
  let rowState = evaluation.rowStates.get(fleetIntentFacetId(row.category, row.key))
  assert.equal(rowState.cells.get("zone-b").status, FLEET_INTENT_CELL_STATUS.ACKNOWLEDGED)
  assert.equal(evaluation.acknowledgementStates[0].status, FLEET_INTENT_ACKNOWLEDGEMENT_STATUS.ACTIVE)
  assert.equal(evaluation.summary.actionableCells, 1)

  row.cells.get("b.example").canonical = '"legacy"'
  evaluation = evaluateFleetIntent(document, inventory, matrix)
  rowState = evaluation.rowStates.get(fleetIntentFacetId(row.category, row.key))
  assert.equal(rowState.cells.get("zone-b").status, FLEET_INTENT_CELL_STATUS.VARIANT)
  assert.equal(evaluation.acknowledgementStates[0].status, FLEET_INTENT_ACKNOWLEDGEMENT_STATUS.STALE)
  assert.match(evaluation.acknowledgementStates[0].reason, /observed state changed/)
})

test("missing acknowledgements are exact and automatically stale when the value appears", () => {
  const { inventory, matrix, row } = fixture()
  let document = createEmptyFleetIntentDocument("account-id")
  document = replaceFleetIntentPolicy(document, policy(row))
  const timestamp = new Date().toISOString()
  document = replaceFleetIntentAcknowledgement(document, {
    createdAt: timestamp,
    id: "ack-missing",
    observedCanonical: FLEET_INTENT_MISSING_CANONICAL,
    policyId: "policy-one",
    reason: "Provisioning is scheduled",
    updatedAt: timestamp,
    zoneId: "zone-c",
    zoneName: "c.example",
  })

  let evaluation = evaluateFleetIntent(document, inventory, matrix)
  let rowState = evaluation.rowStates.get(fleetIntentFacetId(row.category, row.key))
  assert.equal(rowState.cells.get("zone-c").status, FLEET_INTENT_CELL_STATUS.ACKNOWLEDGED)

  row.cells.set("c.example", { canonical: '"off"' })
  evaluation = evaluateFleetIntent(document, inventory, matrix)
  rowState = evaluation.rowStates.get(fleetIntentFacetId(row.category, row.key))
  assert.equal(rowState.cells.get("zone-c").status, FLEET_INTENT_CELL_STATUS.VARIANT)
  assert.equal(evaluation.acknowledgementStates[0].status, FLEET_INTENT_ACKNOWLEDGEMENT_STATUS.STALE)
})

test("custom group limits policy scope while raw ungoverned rows retain drift", () => {
  const { inventory, matrix, row } = fixture()
  let document = createEmptyFleetIntentDocument("account-id")
  document = replaceFleetIntentGroup(document, {
    id: "primary-zones",
    members: [
      { zoneId: "zone-a", zoneName: "a.example" },
      { zoneId: "zone-b", zoneName: "b.example" },
    ],
    mode: FLEET_INTENT_GROUP_MODE.MEMBERS,
    name: "Primary zones",
  })
  document = replaceFleetIntentPolicy(document, policy(row, {
    groupId: "primary-zones",
  }))

  const evaluation = evaluateFleetIntent(document, inventory, matrix)
  const rowState = evaluation.rowStates.get(fleetIntentFacetId(row.category, row.key))
  assert.equal(rowState.cells.get("zone-c").status, FLEET_INTENT_CELL_STATUS.OUT_OF_SCOPE)
  assert.equal(evaluation.summary.actionableCells, 1)

  const ungovernedRow = {
    category: "Zone",
    cells: new Map(),
    different: true,
    key: "status",
    label: "Status",
  }
  matrix.rows.push(ungovernedRow)
  const nextEvaluation = evaluateFleetIntent(document, inventory, matrix)
  assert.equal(
    nextEvaluation.rowStates.get(fleetIntentFacetId("Zone", "status")).actionable,
    true,
  )
})

test("overlapping policies produce an explicit conflict", () => {
  const { inventory, matrix, row } = fixture()
  let document = createEmptyFleetIntentDocument("account-id")
  document = replaceFleetIntentPolicy(document, policy(row))
  document = replaceFleetIntentPolicy(document, policy(row, {
    canonical: '"off"',
    display: "off",
    id: "policy-two",
    value: "off",
  }))
  const timestamp = new Date().toISOString()
  document = replaceFleetIntentAcknowledgement(document, {
    createdAt: timestamp,
    id: "ack-conflict",
    observedCanonical: '"off"',
    policyId: "policy-one",
    reason: "This would be active without the overlap",
    updatedAt: timestamp,
    zoneId: "zone-b",
    zoneName: "b.example",
  })

  const evaluation = evaluateFleetIntent(document, inventory, matrix)
  const rowState = evaluation.rowStates.get(fleetIntentFacetId(row.category, row.key))
  assert.equal(rowState.cells.get("zone-a").status, FLEET_INTENT_CELL_STATUS.CONFLICT)
  assert.equal(rowState.cells.get("zone-b").status, FLEET_INTENT_CELL_STATUS.CONFLICT)
  assert.equal(rowState.cells.get("zone-c").status, FLEET_INTENT_CELL_STATUS.CONFLICT)
  assert.equal(evaluation.acknowledgementStates[0].status, FLEET_INTENT_ACKNOWLEDGEMENT_STATUS.STALE)
  assert.match(evaluation.acknowledgementStates[0].reason, /Overlapping policies/)
})

test("unresolved policies and unavailable group members stay visible", () => {
  const { inventory, matrix, row } = fixture()
  let document = createEmptyFleetIntentDocument("account-id")
  document = replaceFleetIntentGroup(document, {
    id: "retired-zone",
    members: [{ zoneId: "zone-missing", zoneName: "missing.example" }],
    mode: FLEET_INTENT_GROUP_MODE.MEMBERS,
    name: "Retired zone",
  })
  document = replaceFleetIntentPolicy(document, policy(row, {
    groupId: "retired-zone",
  }))

  let evaluation = evaluateFleetIntent(document, inventory, matrix)
  assert.equal(evaluation.summary.unresolvedPolicies, 1)
  assert.deepEqual(evaluation.policyStates[0].unavailableZoneIds, ["zone-missing"])

  matrix.rows = []
  evaluation = evaluateFleetIntent(document, inventory, matrix)
  assert.equal(evaluation.summary.unresolvedPolicies, 1)
})
