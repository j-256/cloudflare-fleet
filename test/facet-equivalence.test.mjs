import assert from "node:assert/strict"
import test from "node:test"

import {
  describeFacetComparisonAccess,
  describeFacetEquivalence,
  FACET_COMPARISON_ACCESS_KIND,
  facetCellComparisonValue,
  facetExpectedComparisonValue,
  facetPhase,
  ruleExactComparisonValue,
  rulesetExactComparisonValue,
} from "../src/facet-equivalence.mjs"

test("ruleset parent equivalence names its phase identity and editable definition", () => {
  const facet = {
    category: "Rulesets",
    key: "zone:http_config_settings",
    label: "Configuration settings entrypoint",
  }
  const description = describeFacetEquivalence(facet)

  assert.equal(facetPhase(facet), "http_config_settings")
  assert.equal(description.phaseLabel, "Configuration settings")
  assert.equal(
    description.identitySummary,
    "Rulesets / zone / Configuration settings",
  )
  assert.equal(
    description.equivalenceSummary,
    "Description + ordered editable rule fields",
  )
  assert.equal(
    description.normalizationSummary,
    "Zone domain becomes {zone}; rule order and custom refs count",
  )
  assert.equal(
    description.ignoredSummary,
    "Immutable name, kind, phase; IDs, timestamps, versions, generated refs, unsupported fields",
  )
})

test("rule equivalence distinguishes facet identity from compared definition", () => {
  const description = describeFacetEquivalence({
    category: "Ruleset rules",
    key: "http_config_settings:exclude s.{zone}",
    label: "exclude s.{zone}",
  })

  assert.equal(description.phase, "http_config_settings")
  assert.equal(
    description.identitySummary,
    "Ruleset rules / Configuration settings / normalized rule name",
  )
  assert.equal(description.equivalenceSummary, "Editable rule fields")
  assert.equal(
    description.normalizationSummary,
    "Zone domain becomes {zone}; array order counts",
  )
  assert.equal(
    description.ignoredSummary,
    "Rule IDs, timestamps, versions, generated refs, unsupported API fields",
  )
})

test("comparison helpers expose the canonical value that controls equality", () => {
  const canonical = JSON.stringify({
    kind: "zone",
    name: "default",
    rules: [{ action: "set_config", enabled: true }],
  })
  const cell = {
    inspectionValue: {
      id: "ruleset-id",
      kind: "zone",
      name: "default",
      rules: [{ id: "rule-id" }],
    },
    intentCanonical: canonical,
  }

  assert.deepEqual(facetCellComparisonValue(cell), {
    kind: "zone",
    name: "default",
    rules: [{ action: "set_config", enabled: true }],
  })
  assert.deepEqual(facetExpectedComparisonValue({ canonical }), {
    kind: "zone",
    name: "default",
    rules: [{ action: "set_config", enabled: true }],
  })
})

test("ruleset exact comparison includes ordered editable rules and excludes API metadata", () => {
  const compared = rulesetExactComparisonValue({
    description: "Ruleset metadata",
    id: "ruleset-id",
    kind: "zone",
    name: "default",
    rules: [{
      action: "set_config",
      description: "exclude s.alpha.example",
      expression: "http.host eq \"s.alpha.example\"",
      id: "rule-id",
      last_updated: "2024-03-11T23:35:27Z",
      ref: "rule-id",
      version: "1",
    }],
    version: "4",
  }, "alpha.example")

  assert.deepEqual(compared, {
    description: "Ruleset metadata",
    rules: [{
      action: "set_config",
      description: "exclude s.{zone}",
      expression: "http.host eq \"s.{zone}\"",
    }],
  })
})

test("ruleset exact comparison excludes immutable identity and unsupported fields", () => {
  const left = rulesetExactComparisonValue({
    description: " Fleet rules ",
    kind: "zone",
    name: "default",
    phase: "http_request_firewall_custom",
    rules: [{
      action: "block",
      categories: ["test"],
      enabled: true,
      expression: "http.host eq \"alpha.example\"",
      unsupported_metadata: "left",
    }],
  }, "alpha.example")
  const right = rulesetExactComparisonValue({
    description: "Fleet rules",
    kind: "custom",
    name: "another-name",
    phase: "another_phase",
    rules: [{
      action: "block",
      categories: ["test"],
      enabled: true,
      expression: "http.host eq \"beta.example\"",
      unsupported_metadata: "right",
    }],
  }, "beta.example")

  assert.deepEqual(left, right)
  assert.deepEqual(ruleExactComparisonValue({
    action: "block",
    categories: ["test"],
    enabled: true,
    expression: "true",
    unsupported_metadata: "ignored",
  }, "alpha.example"), {
    action: "block",
    categories: ["test"],
    enabled: true,
    expression: "true",
  })
})

test("comparison access exposes direct, workspace, and read-only paths", () => {
  const redirectFacet = {
    category: "Redirects",
    key: "http_request_dynamic_redirect:match",
  }
  const direct = describeFacetComparisonAccess(redirectFacet, {
    action: { type: "ruleset-rule" },
    parentAction: { kind: "zone" },
  })
  assert.equal(direct.kind, FACET_COMPARISON_ACCESS_KIND.DIRECT)
  assert.equal(direct.secondaryKind, FACET_COMPARISON_ACCESS_KIND.WORKSPACE)
  assert.match(direct.reason, /Edit order in the parent ruleset/)

  const workspace = describeFacetComparisonAccess({ category: "Rulesets" }, {
    workspaceAction: { kind: "custom" },
  })
  assert.equal(workspace.kind, FACET_COMPARISON_ACCESS_KIND.WORKSPACE)
  assert.match(workspace.reason, /are not compared/)

  const managed = describeFacetComparisonAccess({ category: "Rulesets" }, {
    workspaceAction: { kind: "managed" },
  })
  assert.equal(managed.kind, FACET_COMPARISON_ACCESS_KIND.INSPECT)
  assert.match(managed.reason, /read-only/)
})

test("ruleset exact comparison retains normalized explicit rule refs", () => {
  const compared = rulesetExactComparisonValue({
    description: "",
    kind: "zone",
    name: "default",
    rules: [{
      action: "block",
      id: "generated-id",
      ref: "protect-alpha.example",
    }],
  }, "alpha.example")

  assert.equal(compared.rules[0].ref, "protect-{zone}")
})
