import assert from "node:assert/strict"
import test from "node:test"

import {
  createAuthoredFleetIntentExpected,
  createEmptyFleetIntentDocument,
  evaluateFleetIntent,
  FLEET_INTENT_ACKNOWLEDGEMENT_STATUS,
  FLEET_INTENT_ALL_ZONES_GROUP_ID,
  FLEET_INTENT_CELL_STATUS,
  FLEET_INTENT_EXPECTED_ORIGIN,
  FLEET_INTENT_GROUP_MODE,
  FLEET_INTENT_MISSING_CANONICAL,
  fleetIntentFacetId,
  fleetIntentExpectedIsAuthored,
  isFleetIntentDocument,
  removeFleetIntentGroup,
  removeFleetIntentPolicy,
  replaceFleetIntentAcknowledgement,
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
      ["a.example", { canonical: '"on"' }],
      ["b.example", { canonical: '"off"' }],
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
  return {
    expected: options.expected || {
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
