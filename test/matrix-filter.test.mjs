import assert from "node:assert/strict"
import test from "node:test"

import {
  facetMatchesScope,
  MATRIX_SCOPE,
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

test("matrix filters combine coverage, type, category, drift, and search terms", () => {
  const row = {
    category: "DNS records",
    different: true,
    missingZoneIds: ["zone-beta.example"],
    presentCount: 3,
    recordType: "CNAME",
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
