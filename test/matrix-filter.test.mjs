import assert from "node:assert/strict"
import test from "node:test"

import {
  DEFAULT_MATRIX_FILTERS,
  facetMatchesScope,
  MATRIX_SCOPE,
  matrixColumnIsVisible,
  matrixFilterChangeCount,
  matrixRowMatchesFilters,
} from "../src/matrix-filter.mjs"

test("fleet pattern scope separates shared and zone-specific facets", () => {
  assert.equal(facetMatchesScope(1, 14, MATRIX_SCOPE.FLEET_PATTERNS), false)
  assert.equal(facetMatchesScope(2, 14, MATRIX_SCOPE.FLEET_PATTERNS), true)
  assert.equal(facetMatchesScope(14, 14, MATRIX_SCOPE.FLEET_PATTERNS), true)
  assert.equal(facetMatchesScope(14, 14, MATRIX_SCOPE.FLEET_WIDE), true)
  assert.equal(facetMatchesScope(13, 14, MATRIX_SCOPE.FLEET_WIDE), false)
  assert.equal(facetMatchesScope(1, 14, MATRIX_SCOPE.ZONE_SPECIFIC), true)
  assert.equal(facetMatchesScope(1, 14, MATRIX_SCOPE.ALL), true)
})

test("matrix filter changes count only deviations from the initial view", () => {
  assert.equal(matrixFilterChangeCount(DEFAULT_MATRIX_FILTERS), 0)
  assert.equal(matrixFilterChangeCount({
    ...DEFAULT_MATRIX_FILTERS,
    query: "  cname  ",
    scope: MATRIX_SCOPE.ALL,
    targetHolesOnly: true,
  }), 3)
  assert.equal(matrixFilterChangeCount({
    ...DEFAULT_MATRIX_FILTERS,
    differencesOnly: false,
    recordType: "TXT",
    redirectType: "dynamic",
  }), 3)
})

test("selected-only presentation hides unselected columns without changing selection", () => {
  const selected = new Set(["zone-a", "zone-c"])

  assert.equal(matrixColumnIsVisible("zone-b", selected, false), true)
  assert.equal(matrixColumnIsVisible("zone-a", selected, true), true)
  assert.equal(matrixColumnIsVisible("zone-b", selected, true), false)
  assert.deepEqual([...selected], ["zone-a", "zone-c"])
})

test("matrix filters combine coverage, type, category, drift, and search terms", () => {
  const row = {
    category: "DNS records",
    different: true,
    missingZoneIds: ["zone-beta.example"],
    presentCount: 3,
    recordType: "CNAME",
    redirectTypes: [],
    search: "dns records cname cc-dev zone-d.example",
  }
  const filters = {
    category: "DNS records",
    differencesOnly: true,
    query: "strangelasers cc-dev",
    recordType: "CNAME",
    scope: MATRIX_SCOPE.FLEET_PATTERNS,
    targetHolesOnly: true,
    targetZoneIds: new Set(["zone-beta.example"]),
    zoneCount: 14,
  }

  assert.equal(matrixRowMatchesFilters(row, filters), true)
  assert.equal(matrixRowMatchesFilters(row, {
    ...filters,
    query: "strangelasers missing-token",
  }), false)
  assert.equal(matrixRowMatchesFilters(row, {
    ...filters,
    recordType: "TXT",
  }), false)
  assert.equal(matrixRowMatchesFilters(row, {
    ...filters,
    scope: MATRIX_SCOPE.FLEET_WIDE,
  }), false)
  assert.equal(matrixRowMatchesFilters(row, {
    ...filters,
    targetZoneIds: new Set(["zone-alpha.example"]),
  }), false)
})

test("matrix filters redirects by destination type", () => {
  const row = {
    category: "Redirects",
    different: true,
    missingZoneIds: [],
    presentCount: 4,
    recordType: "",
    redirectTypes: ["dynamic"],
    search: "redirects dynamic target concat",
  }
  const filters = {
    category: "Redirects",
    differencesOnly: false,
    query: "",
    recordType: "",
    redirectType: "dynamic",
    scope: MATRIX_SCOPE.ALL,
    targetHolesOnly: false,
    targetZoneIds: new Set(),
    zoneCount: 14,
  }

  assert.equal(matrixRowMatchesFilters(row, filters), true)
  assert.equal(matrixRowMatchesFilters(row, {
    ...filters,
    redirectType: "static",
  }), false)
})

test("matrix drift filter prefers actionable intent over raw difference", () => {
  const filters = {
    category: "",
    differencesOnly: true,
    query: "",
    recordType: "",
    redirectType: "",
    scope: MATRIX_SCOPE.ALL,
    targetHolesOnly: false,
    targetZoneIds: new Set(),
    zoneCount: 2,
  }
  const row = {
    actionable: false,
    category: "Zone settings",
    different: true,
    missingZoneIds: [],
    presentCount: 2,
    recordType: "",
    redirectTypes: [],
    search: "zone settings",
  }

  assert.equal(matrixRowMatchesFilters(row, filters), false)
  assert.equal(matrixRowMatchesFilters({
    ...row,
    actionable: true,
    different: false,
  }, filters), true)
})
