import assert from "node:assert/strict"
import test from "node:test"

import {
  compareFleetValueVariants,
  compareFleetRowValues,
  diffValueText,
  groupFleetRowIntentValues,
  VALUE_TEXT_DIFF_KIND,
} from "../src/value-comparison.mjs"

function zone(name) {
  return {
    meta: {
      id: `zone-${name}`,
      name,
    },
  }
}

function cell(value, options = {}) {
  return {
    canonical: JSON.stringify(value),
    display: options.display || String(value),
    inspectionValue: options.inspectionValue ?? value,
    intentCanonical: options.intentCanonical,
  }
}

test("fleet value comparison groups normalized values with complete zone coverage", () => {
  const zones = [
    zone("alpha.example"),
    zone("beta.example"),
    zone("gamma.example"),
    zone("missing.example"),
  ]
  const comparison = compareFleetRowValues({
    cells: new Map([
      ["alpha.example", cell({ enabled: true, mode: "strict" })],
      ["beta.example", cell({ enabled: true, mode: "strict" })],
      ["gamma.example", cell({ enabled: true, mode: "relaxed" })],
    ]),
  }, zones)

  assert.equal(comparison.variantCount, 2)
  assert.equal(comparison.presentCount, 3)
  assert.equal(comparison.consensusCount, 2)
  assert.equal(comparison.hasUniqueConsensus, true)
  assert.deepEqual(
    comparison.variants[0].zones.map((entry) => entry.name),
    ["alpha.example", "beta.example"],
  )
  assert.deepEqual(
    comparison.missingZones.map((entry) => entry.name),
    ["missing.example"],
  )
})

test("fleet value comparison reports only differing leaf fields", () => {
  const zones = [zone("alpha.example"), zone("beta.example")]
  const comparison = compareFleetRowValues({
    cells: new Map([
      ["alpha.example", cell({
        action: "block",
        expression: "one",
        nested: { shared: true },
      })],
      ["beta.example", cell({
        action: "block",
        expression: "two",
        nested: { shared: true },
      })],
    ]),
  }, zones)

  assert.equal(comparison.fieldCount, 3)
  assert.equal(comparison.commonFieldCount, 2)
  assert.deepEqual(comparison.differences.map((row) => row.path), [
    ["expression"],
  ])
  assert.deepEqual(
    comparison.differences[0].values.map((entry) => entry.value),
    ["one", "two"],
  )
})

test("fleet intent value comparison attributes every variant and exposes only differing fields", () => {
  const zones = [
    zone("alpha.example"),
    zone("beta.example"),
    zone("gamma.example"),
  ]
  const common = {
    action: "block",
    description: "[fleet] scanner block",
  }
  const leadingValue = { ...common, priority: 1000 }
  const alternateValue = { ...common, priority: 2000 }
  const row = {
    cells: new Map([
      ["alpha.example", {
        canonical: '"matrix-alpha"',
        display: "Enabled | block",
        intentCanonical: JSON.stringify(leadingValue),
        intentValue: leadingValue,
      }],
      ["beta.example", {
        canonical: '"matrix-beta"',
        display: "Enabled | block",
        intentCanonical: JSON.stringify(leadingValue),
        intentValue: leadingValue,
        resolutionCanonical: '"resolution-beta"',
        resolutionSource: { kind: "ruleset-rule" },
      }],
      ["gamma.example", {
        canonical: '"matrix-gamma"',
        display: "Enabled | block",
        intentCanonical: JSON.stringify(alternateValue),
        intentValue: alternateValue,
      }],
    ]),
  }

  const variants = groupFleetRowIntentValues(row, zones)
  const comparison = compareFleetValueVariants(variants)

  assert.equal(comparison.variantCount, 2)
  assert.equal(comparison.consensusCount, 2)
  assert.deepEqual(
    comparison.variants[0].zones.map((entry) => entry.name),
    ["alpha.example", "beta.example"],
  )
  assert.equal(comparison.variants[0].sourceZoneName, "beta.example")
  assert.equal(comparison.variants[0].resolutionCanonical, '"resolution-beta"')
  assert.deepEqual(comparison.variants[1].zones, [{
    id: "zone-gamma.example",
    name: "gamma.example",
  }])
  assert.deepEqual(comparison.differences.map((entry) => entry.path), [
    ["priority"],
  ])
  assert.deepEqual(
    comparison.differences[0].values.map((entry) => entry.value),
    [1000, 2000],
  )
})

test("fleet intent values expose the compared ruleset projection separately from inspection data", () => {
  const zones = [zone("alpha.example")]
  const comparedValue = {
    description: "",
    rules: [{
      action: "set_config",
      enabled: true,
      expression: "true",
    }],
  }
  const inspectionValue = {
    id: "ruleset-id",
    kind: "zone",
    name: "default",
    phase: "http_config_settings",
    rules: [{
      action: "set_config",
      enabled: true,
      expression: "true",
      id: "rule-id",
    }],
  }
  const variants = groupFleetRowIntentValues({
    cells: new Map([["alpha.example", {
      canonical: JSON.stringify(comparedValue),
      display: "1 rule",
      inspectionValue,
      intentCanonical: JSON.stringify(comparedValue),
    }]]),
  }, zones)

  assert.deepEqual(variants[0].value, comparedValue)
  assert.deepEqual(variants[0].inspectionValue, inspectionValue)
})

test("fleet value comparison preserves missing array and object paths", () => {
  const zones = [zone("alpha.example"), zone("beta.example")]
  const comparison = compareFleetRowValues({
    cells: new Map([
      ["alpha.example", cell({ rules: [{ action: "block" }, { action: "skip" }] })],
      ["beta.example", cell({ rules: [{ action: "block" }] })],
    ]),
  }, zones)

  assert.deepEqual(comparison.differences.map((row) => row.path), [
    ["rules", 1, "action"],
  ])
  assert.equal(comparison.differences[0].values[0].present, true)
  assert.equal(comparison.differences[0].values[1].present, false)
})

test("tied fleet values retain a neutral comparison reference", () => {
  const zones = [zone("alpha.example"), zone("beta.example")]
  const comparison = compareFleetRowValues({
    cells: new Map([
      ["alpha.example", cell("left")],
      ["beta.example", cell("right")],
    ]),
  }, zones)

  assert.equal(comparison.hasUniqueConsensus, false)
  assert.equal(comparison.consensusCanonical, null)
  assert.equal(comparison.referenceCanonical, comparison.variants[0].canonical)
})

test("comparison values come from matrix canonicals rather than inspection metadata", () => {
  const zones = [zone("alpha.example"), zone("beta.example")]
  const comparison = compareFleetRowValues({
    cells: new Map([
      ["alpha.example", cell({ enabled: true }, {
        inspectionValue: { enabled: true, id: "alpha-id" },
      })],
      ["beta.example", cell({ enabled: false }, {
        inspectionValue: { enabled: false, id: "beta-id" },
      })],
    ]),
  }, zones)

  assert.deepEqual(comparison.variants.map((variant) => variant.value), [
    { enabled: false },
    { enabled: true },
  ])
  assert.equal(comparison.differences.some((row) => row.path.includes("id")), false)
})

test("a matrix value exposes intent selection only when its intent value is unambiguous", () => {
  const zones = [zone("alpha.example"), zone("beta.example")]
  const comparison = compareFleetRowValues({
    cells: new Map([
      ["alpha.example", cell("same", { intentCanonical: '"intent-a"' })],
      ["beta.example", cell("same", { intentCanonical: '"intent-b"' })],
    ]),
  }, zones)

  assert.equal(comparison.variants[0].intentCanonical, null)
})

test("text comparison highlights case-only expression changes", () => {
  const reference = 'http.user_agent contains "tlm-audit" or "scrapy/"'
  const candidate = 'http.user_agent contains "TLM-Audit" or "Scrapy/"'
  const segments = diffValueText(reference, candidate)
  const before = segments
    .filter((segment) => segment.kind !== VALUE_TEXT_DIFF_KIND.INSERT)
    .map((segment) => segment.text)
    .join("")
  const after = segments
    .filter((segment) => segment.kind !== VALUE_TEXT_DIFF_KIND.DELETE)
    .map((segment) => segment.text)
    .join("")

  assert.equal(before, reference)
  assert.equal(after, candidate)
  assert.deepEqual(
    segments.filter((segment) => segment.kind !== VALUE_TEXT_DIFF_KIND.EQUAL),
    [
      { kind: VALUE_TEXT_DIFF_KIND.DELETE, text: "tlm-audit" },
      { kind: VALUE_TEXT_DIFF_KIND.INSERT, text: "TLM-Audit" },
      { kind: VALUE_TEXT_DIFF_KIND.DELETE, text: "scrapy/" },
      { kind: VALUE_TEXT_DIFF_KIND.INSERT, text: "Scrapy/" },
    ],
  )
})
