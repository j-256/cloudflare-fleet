import assert from "node:assert/strict"
import test from "node:test"

import {
  DEFAULT_MATRIX_FILTERS,
  facetMatchesScope,
  MATRIX_INTENT_FILTER,
  MATRIX_SCOPE,
  MATRIX_SORT,
  matrixColumnIsVisible,
  matrixEmptyMessage,
  matrixFilterChangeCount,
  matrixRowMatchesFilters,
  sortMatrixRows,
} from "../src/matrix-filter.mjs"

test("matrix empty messages distinguish filters from empty inventory", () => {
  assert.equal(matrixEmptyMessage(251, 61), "")
  assert.match(matrixEmptyMessage(251, 0), /current filters/)
  assert.match(matrixEmptyMessage(0, 0), /fleet snapshot/)
})

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
    changeableOnly: true,
    differencesOnly: false,
    phase: "http_config_settings",
    recordType: "TXT",
    redirectType: "dynamic",
  }), 5)
  assert.equal(matrixFilterChangeCount({
    ...DEFAULT_MATRIX_FILTERS,
    sort: MATRIX_SORT.CATEGORY,
  }), 1)
  assert.equal(matrixFilterChangeCount({
    ...DEFAULT_MATRIX_FILTERS,
    intentStatus: MATRIX_INTENT_FILTER.MATCH,
  }), 1)
})

test("matrix sort defaults to phase execution order and offers category A-Z order", () => {
  const rows = [
    { category: "DNS records", defaultOrder: 0, id: "dns", label: "A @", phase: "" },
    { category: "Ruleset rules", defaultOrder: 1, id: "custom", label: "Firewall custom", phase: "http_request_firewall_custom" },
    { category: "Ruleset rules", defaultOrder: 2, id: "config", label: "Configuration settings", phase: "http_config_settings" },
    { category: "Redirects", defaultOrder: 3, id: "redirect", label: "A redirect", phase: "http_request_dynamic_redirect" },
    { category: "Ruleset rules", defaultOrder: 4, id: "response", label: "Response headers", phase: "http_response_headers_transform" },
    { category: "Ruleset rules", defaultOrder: 5, id: "unknown", label: "Future phase", phase: "future_phase" },
    { category: "Redirects", defaultOrder: 6, id: "redirect-child", label: "Z redirect", phase: "http_request_dynamic_redirect" },
  ]

  const phaseOrdered = sortMatrixRows(rows)
  assert.deepEqual(phaseOrdered.map((row) => row.id), [
    "redirect",
    "redirect-child",
    "config",
    "custom",
    "response",
    "unknown",
    "dns",
  ])
  assert.deepEqual(
    sortMatrixRows(phaseOrdered, MATRIX_SORT.CATEGORY).map((row) => row.id),
    [
      "dns",
      "redirect",
      "redirect-child",
      "config",
      "custom",
      "unknown",
      "response",
    ],
  )
})

test("supported-change filtering excludes comparison-only rows", () => {
  const filters = {
    ...DEFAULT_MATRIX_FILTERS,
    changeableOnly: true,
    differencesOnly: false,
    scope: MATRIX_SCOPE.ALL,
    targetZoneIds: new Set(),
    zoneCount: 2,
  }
  const row = {
    category: "TLS",
    changeable: false,
    different: true,
    missingZoneIds: [],
    presentCount: 2,
    recordType: "",
    redirectTypes: [],
    search: "universal ssl",
  }

  assert.equal(matrixRowMatchesFilters(row, filters), false)
  assert.equal(matrixRowMatchesFilters({
    ...row,
    changeable: true,
  }, filters), true)
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

test("matrix filters ruleset facets by exact phase", () => {
  const row = {
    category: "Rulesets",
    different: true,
    missingZoneIds: [],
    phase: "http_config_settings",
    presentCount: 4,
    recordType: "",
    redirectTypes: [],
    search: "configuration settings entrypoint",
  }
  const filters = {
    ...DEFAULT_MATRIX_FILTERS,
    differencesOnly: false,
    phase: "http_config_settings",
    scope: MATRIX_SCOPE.ALL,
    targetZoneIds: new Set(),
    zoneCount: 4,
  }

  assert.equal(matrixRowMatchesFilters(row, filters), true)
  assert.equal(matrixRowMatchesFilters(row, {
    ...filters,
    phase: "http_request_dynamic_redirect",
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

test("matrix filters facets by their composed intent result", () => {
  const filters = {
    ...DEFAULT_MATRIX_FILTERS,
    differencesOnly: false,
    intentStatus: MATRIX_INTENT_FILTER.MATCH,
    scope: MATRIX_SCOPE.ALL,
    targetZoneIds: new Set(),
    zoneCount: 2,
  }
  const row = {
    actionable: false,
    category: "Zone settings",
    different: true,
    intentStatus: MATRIX_INTENT_FILTER.MATCH,
    missingZoneIds: [],
    presentCount: 2,
    recordType: "",
    redirectTypes: [],
    search: "zone settings",
  }

  assert.equal(matrixRowMatchesFilters(row, filters), true)
  assert.equal(matrixRowMatchesFilters({
    ...row,
    intentStatus: MATRIX_INTENT_FILTER.DRIFT,
  }, filters), false)
})
