import assert from "node:assert/strict"
import test from "node:test"

import {
  compareDetailedRulesetRow,
  rulesetParentRowIsReviewable,
  rulesetRowPhase,
} from "../src/ruleset-comparison.mjs"

function zone(name) {
  return {
    meta: {
      id: `zone-${name}`,
      name,
    },
  }
}

function cell(name, rules) {
  return {
    inspectionValue: {
      kind: "zone",
      name: "default",
      phase: "http_request_firewall_custom",
      rules,
    },
    workspaceAction: {
      phase: "http_request_firewall_custom",
      rulesetId: `ruleset-${name}`,
      zoneId: `zone-${name}`,
    },
  }
}

function rule(description, expression = "true") {
  return {
    action: "block",
    description,
    enabled: true,
    expression,
    id: `id-${description}`,
    last_updated: "2026-08-02T00:00:00Z",
    ref: `ref-${description}`,
    version: "4",
  }
}

function row(entries) {
  return {
    category: "Rulesets",
    cells: new Map(entries),
    label: "Custom firewall entrypoint",
  }
}

test("ruleset comparison makes the dominant rule-count distribution explicit", () => {
  const zones = [zone("a.example"), zone("b.example"), zone("c.example")]
  const compared = compareDetailedRulesetRow(row([
    ["a.example", cell("a.example", [rule("Fleet")])],
    ["b.example", cell("b.example", [rule("Fleet")])],
    ["c.example", cell("c.example", [rule("Fleet"), rule("Local")])],
  ]), zones)

  assert.equal(compared.badgeText, "1 rule on 2/3")
  assert.equal(compared.distributionText, "1 rule: 2 | 2 rules: 1")
  assert.equal(compared.outlierCount, 1)
  assert.equal(compared.groups[0].baseline, true)
  assert.deepEqual(compared.groups.map((group) => group.ruleCount), [1, 2])
})

test("ruleset comparison reveals different definitions with the same rule count", () => {
  const zones = [zone("a.example"), zone("b.example")]
  const compared = compareDetailedRulesetRow(row([
    ["a.example", cell("a.example", [rule("Host rule", "http.host eq \"a.example\"")])],
    ["b.example", cell("b.example", [rule("Host rule", "http.host eq \"b.example\"")])],
  ]), zones)

  assert.equal(compared.badgeText, "1 rule on 2/2")
  assert.equal(compared.configurationCount, 1)
  assert.equal(compared.hasDefinitionDifferences, false)
  assert.equal(compared.groups[0].configurations[0].zones.length, 2)

  const changed = compareDetailedRulesetRow(row([
    ["a.example", cell("a.example", [rule("First")])],
    ["b.example", cell("b.example", [rule("Second")])],
  ]), zones)
  assert.equal(changed.groups[0].configurations.length, 2)
  assert.equal(changed.hasDefinitionDifferences, true)
  assert.equal(changed.hasDifferences, true)
})

test("ruleset comparison retains missing zones and rejects summary-only rows", () => {
  const zones = [zone("a.example"), zone("b.example")]
  const detailed = row([
    ["a.example", cell("a.example", [rule("Fleet")])],
  ])
  const compared = compareDetailedRulesetRow(detailed, zones)

  assert.equal(rulesetParentRowIsReviewable(detailed), true)
  assert.equal(rulesetRowPhase(detailed), "http_request_firewall_custom")
  assert.equal(compared.badgeText, "1 rule on 1/2")
  assert.equal(compared.groups[0].baseline, true)
  assert.equal(compared.groups[1].ruleCount, null)
  assert.equal(compared.groups[1].zones[0].name, "b.example")
  assert.equal(rulesetParentRowIsReviewable({
    category: "Rulesets",
    cells: new Map([["a.example", { inspectionValue: { kind: "managed" } }]]),
  }), false)
})

test("ruleset comparison does not call every zone an outlier when counts tie", () => {
  const zones = [zone("a.example"), zone("b.example")]
  const compared = compareDetailedRulesetRow(row([
    ["a.example", cell("a.example", [rule("One")])],
    ["b.example", cell("b.example", [rule("One"), rule("Two")])],
  ]), zones)

  assert.equal(compared.baseline, null)
  assert.equal(compared.badgeText, "2 rule counts")
  assert.equal(compared.outlierCount, 0)
  assert.equal(compared.hasDifferences, true)
})
