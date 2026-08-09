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
  FLEET_INTENT_POLICY_CONFLICT_KIND,
  FLEET_INTENT_PRESENCE_CONSTRAINT,
  FLEET_INTENT_SCHEMA_VERSION,
  FLEET_INTENT_VALUE_CONSTRAINT,
  fleetIntentFacetId,
  fleetIntentExpectedIsAuthored,
  fleetIntentPolicyPresenceConstraint,
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
  if (options.presenceConstraint) {
    entry.presenceConstraint = options.presenceConstraint
  }
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

test("version three DNSSEC intent migrates generated configuration to writable status", () => {
  const generatedActive = {
    algorithm: "13",
    digest_algorithm: "SHA256",
    key_type: "ECDSAP256SHA256",
    status: "active",
  }
  const generatedCanonical = JSON.stringify(generatedActive)
  const statusCanonical = '{"status":"active"}'
  const row = {
    category: "DNSSEC",
    cells: new Map([
      ["a.example", {
        canonical: generatedCanonical,
        intentCanonical: statusCanonical,
        uniquenessCanonical: statusCanonical,
      }],
      ["b.example", {
        canonical: JSON.stringify({
          algorithm: "15",
          digest_algorithm: "SHA384",
          key_type: "ED25519",
          status: "active",
        }),
        intentCanonical: statusCanonical,
        uniquenessCanonical: statusCanonical,
      }],
    ]),
    different: true,
    key: "configuration",
    label: "DNSSEC configuration",
  }
  const legacy = createEmptyFleetIntentDocument("account-id")
  legacy.schemaVersion = 3
  legacy.revision = "c".repeat(64)
  legacy.policies.push(policy(row, {
    canonical: generatedCanonical,
    display: "4 fields",
    resolutionCanonical: generatedCanonical,
    value: generatedActive,
    valueConstraint: FLEET_INTENT_VALUE_CONSTRAINT.EXACT,
  }))
  legacy.acknowledgements.push({
    createdAt: "2026-08-04T18:00:00.000Z",
    id: "dnssec-acknowledgement",
    observedCanonical: generatedCanonical,
    policyId: "policy-one",
    reason: "Known generated key variation",
    updatedAt: "2026-08-04T18:00:00.000Z",
    zoneId: "zone-a",
    zoneName: "a.example",
  })

  const migrated = migrateFleetIntentDocument(legacy, "account-id")
  const evaluation = evaluateFleetIntent(
    migrated,
    {
      account: { id: "account-id" },
      zones: [
        { meta: { id: "zone-a", name: "a.example" } },
        { meta: { id: "zone-b", name: "b.example" } },
      ],
    },
    { rows: [row] },
  )

  assert.equal(migrated.schemaVersion, FLEET_INTENT_SCHEMA_VERSION)
  assert.equal(migrated.revision, legacy.revision)
  assert.deepEqual(migrated.policies[0].expected.value, { status: "active" })
  assert.equal(migrated.policies[0].expected.canonical, statusCanonical)
  assert.equal(migrated.policies[0].expected.display, "active")
  assert.equal(migrated.policies[0].expected.resolutionCanonical, statusCanonical)
  assert.equal(migrated.acknowledgements[0].observedCanonical, statusCanonical)
  assert.equal(evaluation.policyStates[0].matchCount, 2)
  assert.equal(evaluation.summary.actionableCells, 0)
  assert.equal(isFleetIntentDocument(migrated, "account-id"), true)
})

test("new DNSSEC policies retain only status as exact intent", () => {
  const row = {
    category: "DNSSEC",
    key: "configuration",
    label: "DNSSEC configuration",
  }
  const generated = {
    algorithm: "13",
    key_type: "ECDSAP256SHA256",
    status: "pending",
  }
  let document = createEmptyFleetIntentDocument("account-id")

  document = replaceFleetIntentPolicy(document, policy(row, {
    canonical: JSON.stringify(generated),
    resolutionCanonical: JSON.stringify(generated),
    value: generated,
    valueConstraint: FLEET_INTENT_VALUE_CONSTRAINT.EXACT,
  }))

  assert.deepEqual(document.policies[0].expected.value, { status: "active" })
  assert.equal(document.policies[0].expected.canonical, '{"status":"active"}')
  assert.equal(document.policies[0].expected.resolutionCanonical, '{"status":"active"}')
})

test("version four policies migrate to required presence", () => {
  const { row } = fixture()
  const legacy = createEmptyFleetIntentDocument("account-id")
  legacy.schemaVersion = 4
  legacy.revision = "d".repeat(64)
  legacy.policies.push(policy(row, {
    expected: null,
    valueConstraint: FLEET_INTENT_VALUE_CONSTRAINT.MAY_DIFFER,
  }))

  const migrated = migrateFleetIntentDocument(legacy, "account-id")

  assert.equal(migrated.schemaVersion, FLEET_INTENT_SCHEMA_VERSION)
  assert.equal(migrated.revision, legacy.revision)
  assert.equal(
    migrated.policies[0].presenceConstraint,
    FLEET_INTENT_PRESENCE_CONSTRAINT.REQUIRED,
  )
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

test("group policy saves preserve policy targets and identifiers", () => {
  const { row } = fixture()
  let document = createEmptyFleetIntentDocument("account-id")
  document = replaceFleetIntentGroup(document, {
    id: "secondary-zones",
    members: [{ zoneId: "zone-b", zoneName: "b.example" }],
    mode: FLEET_INTENT_GROUP_MODE.MEMBERS,
    name: "Secondary zones",
  })
  document = replaceFleetIntentPolicy(document, policy(row))

  assert.throws(
    () => replaceFleetIntentPolicy(document, policy(row, {
      groupId: "secondary-zones",
    })),
    /cannot be retargeted/,
  )

  document = replaceFleetIntentPolicy(document, policy(row, {
    expected: null,
    groupId: "secondary-zones",
    id: "policy-two",
    presenceConstraint: FLEET_INTENT_PRESENCE_CONSTRAINT.OPTIONAL,
    valueConstraint: FLEET_INTENT_VALUE_CONSTRAINT.MAY_DIFFER,
  }))
  document = replaceFleetIntentPolicy(document, policy(row, {
    expected: createAuthoredFleetIntentExpected("updated"),
  }))

  assert.deepEqual(
    document.policies.map((entry) => ({
      groupId: entry.groupId,
      id: entry.id,
      presenceConstraint: fleetIntentPolicyPresenceConstraint(entry),
      valueConstraint: fleetIntentPolicyValueConstraint(entry),
    })),
    [
      {
        groupId: "secondary-zones",
        id: "policy-two",
        presenceConstraint: FLEET_INTENT_PRESENCE_CONSTRAINT.OPTIONAL,
        valueConstraint: FLEET_INTENT_VALUE_CONSTRAINT.MAY_DIFFER,
      },
      {
        groupId: FLEET_INTENT_ALL_ZONES_GROUP_ID,
        id: "policy-one",
        presenceConstraint: FLEET_INTENT_PRESENCE_CONSTRAINT.REQUIRED,
        valueConstraint: FLEET_INTENT_VALUE_CONSTRAINT.EXACT,
      },
    ],
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

test("optional intent accepts missing zones and evaluates values when present", () => {
  const { inventory, matrix, row } = fixture()
  let document = createEmptyFleetIntentDocument("account-id")
  document = replaceFleetIntentPolicy(document, policy(row, {
    presenceConstraint: FLEET_INTENT_PRESENCE_CONSTRAINT.OPTIONAL,
  }))

  const evaluation = evaluateFleetIntent(document, inventory, matrix)
  const rowState = evaluation.rowStates.get(fleetIntentFacetId(row.category, row.key))

  assert.equal(rowState.cells.get("zone-a").status, FLEET_INTENT_CELL_STATUS.MATCH)
  assert.equal(rowState.cells.get("zone-b").status, FLEET_INTENT_CELL_STATUS.VARIANT)
  assert.equal(rowState.cells.get("zone-c").status, FLEET_INTENT_CELL_STATUS.MATCH)
  assert.equal(evaluation.summary.actionableCells, 1)
})

test("optional may-differ intent accepts presence, absence, and value variation", () => {
  const { inventory, matrix, row } = fixture()
  let document = createEmptyFleetIntentDocument("account-id")
  document = replaceFleetIntentPolicy(document, policy(row, {
    expected: null,
    presenceConstraint: FLEET_INTENT_PRESENCE_CONSTRAINT.OPTIONAL,
    valueConstraint: FLEET_INTENT_VALUE_CONSTRAINT.MAY_DIFFER,
  }))

  const evaluation = evaluateFleetIntent(document, inventory, matrix)
  const rowState = evaluation.rowStates.get(fleetIntentFacetId(row.category, row.key))

  assert.deepEqual(
    [...rowState.cells.values()].map((cell) => cell.status),
    [
      FLEET_INTENT_CELL_STATUS.MATCH,
      FLEET_INTENT_CELL_STATUS.MATCH,
      FLEET_INTENT_CELL_STATUS.MATCH,
    ],
  )
  assert.equal(evaluation.summary.actionableCells, 0)
})

test("forbidden intent accepts absence and flags every present value", () => {
  const { inventory, matrix, row } = fixture()
  let document = createEmptyFleetIntentDocument("account-id")
  document = replaceFleetIntentPolicy(document, policy(row, {
    presenceConstraint: FLEET_INTENT_PRESENCE_CONSTRAINT.FORBIDDEN,
  }))

  assert.equal(
    fleetIntentPolicyPresenceConstraint(document.policies[0]),
    FLEET_INTENT_PRESENCE_CONSTRAINT.FORBIDDEN,
  )
  assert.equal(
    document.policies[0].valueConstraint,
    FLEET_INTENT_VALUE_CONSTRAINT.MAY_DIFFER,
  )
  assert.equal(document.policies[0].expected, null)

  const evaluation = evaluateFleetIntent(document, inventory, matrix)
  const rowState = evaluation.rowStates.get(fleetIntentFacetId(row.category, row.key))
  assert.equal(rowState.cells.get("zone-a").status, FLEET_INTENT_CELL_STATUS.VARIANT)
  assert.equal(rowState.cells.get("zone-b").status, FLEET_INTENT_CELL_STATUS.VARIANT)
  assert.equal(rowState.cells.get("zone-c").status, FLEET_INTENT_CELL_STATUS.MATCH)
  assert.equal(evaluation.summary.actionableCells, 2)
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
    /Remove policies/,
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
  assert.equal(nextEvaluation.summary.actionableZones, 1)
  assert.equal(nextEvaluation.summary.matchingZones, 2)
  assert.equal(nextEvaluation.summary.ungovernedRows, 1)
  assert.equal(nextEvaluation.summary.zones, 3)
})

test("compatible overlapping policies refine optional fleet intent for a required zone", () => {
  const { inventory, matrix, row } = fixture()
  let document = createEmptyFleetIntentDocument("account-id")
  document = replaceFleetIntentGroup(document, {
    id: "required-zone",
    members: [{ zoneId: "zone-a", zoneName: "a.example" }],
    mode: FLEET_INTENT_GROUP_MODE.MEMBERS,
    name: "Required zone",
  })
  document = replaceFleetIntentPolicy(document, policy(row, {
    expected: null,
    id: "policy-fleet",
    presenceConstraint: FLEET_INTENT_PRESENCE_CONSTRAINT.OPTIONAL,
    valueConstraint: FLEET_INTENT_VALUE_CONSTRAINT.MAY_DIFFER,
  }))
  document = replaceFleetIntentPolicy(document, policy(row, {
    groupId: "required-zone",
    id: "policy-required",
  }))

  let evaluation = evaluateFleetIntent(document, inventory, matrix)
  let rowState = evaluation.rowStates.get(fleetIntentFacetId(row.category, row.key))
  assert.equal(rowState.cells.get("zone-a").status, FLEET_INTENT_CELL_STATUS.MATCH)
  assert.equal(rowState.cells.get("zone-a").policies.length, 2)
  assert.deepEqual(rowState.cells.get("zone-a").conflictKinds, [])
  assert.equal(rowState.cells.get("zone-b").status, FLEET_INTENT_CELL_STATUS.MATCH)
  assert.equal(rowState.cells.get("zone-c").status, FLEET_INTENT_CELL_STATUS.MATCH)
  assert.equal(evaluation.summary.actionableCells, 0)

  row.cells.delete("a.example")
  evaluation = evaluateFleetIntent(document, inventory, matrix)
  rowState = evaluation.rowStates.get(fleetIntentFacetId(row.category, row.key))
  assert.equal(rowState.cells.get("zone-a").status, FLEET_INTENT_CELL_STATUS.MISSING)
  assert.equal(evaluation.summary.actionableCells, 1)

  row.cells.set("a.example", {
    canonical: '"off"',
    uniquenessCanonical: '"a-value"',
  })
  evaluation = evaluateFleetIntent(document, inventory, matrix)
  rowState = evaluation.rowStates.get(fleetIntentFacetId(row.category, row.key))
  assert.equal(rowState.cells.get("zone-a").status, FLEET_INTENT_CELL_STATUS.VARIANT)
  assert.equal(evaluation.summary.actionableCells, 1)
})

test("compatible overlap evaluation is independent of policy order", () => {
  const { inventory, matrix, row } = fixture()
  const policyOrders = [
    ["fleet", "required"],
    ["required", "fleet"],
  ]

  for (const order of policyOrders) {
    let document = createEmptyFleetIntentDocument("account-id")
    document = replaceFleetIntentGroup(document, {
      id: "required-zone",
      members: [{ zoneId: "zone-b", zoneName: "b.example" }],
      mode: FLEET_INTENT_GROUP_MODE.MEMBERS,
      name: "Required zone",
    })
    const policies = {
      fleet: policy(row, {
        expected: null,
        id: "policy-fleet",
        presenceConstraint: FLEET_INTENT_PRESENCE_CONSTRAINT.OPTIONAL,
        valueConstraint: FLEET_INTENT_VALUE_CONSTRAINT.MAY_DIFFER,
      }),
      required: policy(row, {
        groupId: "required-zone",
        id: "policy-required",
      }),
    }
    for (const key of order) {
      document = replaceFleetIntentPolicy(document, policies[key])
    }

    const evaluation = evaluateFleetIntent(document, inventory, matrix)
    const rowState = evaluation.rowStates.get(fleetIntentFacetId(row.category, row.key))
    assert.deepEqual(
      [...rowState.cells.values()].map((cell) => cell.status),
      [
        FLEET_INTENT_CELL_STATUS.MATCH,
        FLEET_INTENT_CELL_STATUS.VARIANT,
        FLEET_INTENT_CELL_STATUS.MATCH,
      ],
    )
  }
})

test("overlapping exact policies conflict only when their values differ", () => {
  const { inventory, matrix, row } = fixture()
  let document = createEmptyFleetIntentDocument("account-id")
  document = replaceFleetIntentPolicy(document, policy(row))
  document = replaceFleetIntentGroup(document, {
    id: "secondary-zones",
    members: [{ zoneId: "zone-b", zoneName: "b.example" }],
    mode: FLEET_INTENT_GROUP_MODE.MEMBERS,
    name: "Secondary zones",
  })
  document = replaceFleetIntentPolicy(document, policy(row, {
    canonical: '"off"',
    display: "off",
    groupId: "secondary-zones",
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
  assert.equal(rowState.cells.get("zone-a").status, FLEET_INTENT_CELL_STATUS.MATCH)
  assert.equal(rowState.cells.get("zone-b").status, FLEET_INTENT_CELL_STATUS.CONFLICT)
  assert.deepEqual(rowState.cells.get("zone-b").conflictKinds, [
    FLEET_INTENT_POLICY_CONFLICT_KIND.EXACT_VALUE,
  ])
  assert.equal(rowState.cells.get("zone-c").status, FLEET_INTENT_CELL_STATUS.MISSING)
  assert.equal(evaluation.acknowledgementStates[0].status, FLEET_INTENT_ACKNOWLEDGEMENT_STATUS.STALE)
  assert.match(evaluation.acknowledgementStates[0].reason, /Overlapping policies/)
})

test("required and forbidden overlapping policies remain an explicit conflict", () => {
  const { inventory, matrix, row } = fixture()
  let document = createEmptyFleetIntentDocument("account-id")
  document = replaceFleetIntentPolicy(document, policy(row, {
    expected: null,
    valueConstraint: FLEET_INTENT_VALUE_CONSTRAINT.MAY_DIFFER,
  }))
  document = replaceFleetIntentGroup(document, {
    id: "forbidden-zone",
    members: [{ zoneId: "zone-a", zoneName: "a.example" }],
    mode: FLEET_INTENT_GROUP_MODE.MEMBERS,
    name: "Forbidden zone",
  })
  document = replaceFleetIntentPolicy(document, policy(row, {
    groupId: "forbidden-zone",
    id: "policy-forbidden",
    presenceConstraint: FLEET_INTENT_PRESENCE_CONSTRAINT.FORBIDDEN,
  }))

  const evaluation = evaluateFleetIntent(document, inventory, matrix)
  const rowState = evaluation.rowStates.get(fleetIntentFacetId(row.category, row.key))
  assert.equal(rowState.cells.get("zone-a").status, FLEET_INTENT_CELL_STATUS.CONFLICT)
  assert.deepEqual(rowState.cells.get("zone-a").conflictKinds, [
    FLEET_INTENT_POLICY_CONFLICT_KIND.PRESENCE,
  ])
  assert.equal(rowState.cells.get("zone-b").status, FLEET_INTENT_CELL_STATUS.MATCH)
  assert.equal(rowState.cells.get("zone-c").status, FLEET_INTENT_CELL_STATUS.MISSING)
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
