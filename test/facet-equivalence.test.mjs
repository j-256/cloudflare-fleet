import assert from "node:assert/strict"
import test from "node:test"

import {
  describeFacetComparisonAccess,
  describeFacetEquivalence,
  FACET_COMPARISON_ACCESS_KIND,
  facetCellComparisonValue,
  facetExpectedComparisonValue,
  facetPhase,
  redirectIntentComparisonValue,
  redirectIntentValueProjection,
  ruleExactComparisonValue,
} from "../src/facet-equivalence.mjs"

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

test("canonical aliases explain their typed resource envelope", () => {
  const description = describeFacetEquivalence({
    category: "Zone aliases",
    key: "canonical-web-passthrough",
  })

  assert.equal(
    description.identitySummary,
    "Zone aliases / canonical passthrough",
  )
  assert.match(description.equivalenceSummary, /empty accumulation envelope/)
  assert.match(description.normalizationSummary, /not substituted/)
  assert.match(description.ignoredSummary, /shared security resources/)
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

test("rule exact comparison excludes API metadata and unsupported fields", () => {
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

  const workspace = describeFacetComparisonAccess({ category: "Ruleset rules" }, {
    parentAction: { kind: "custom" },
  })
  assert.equal(workspace.kind, FACET_COMPARISON_ACCESS_KIND.WORKSPACE)
  assert.match(workspace.reason, /parent ruleset workspace/)

  const managed = describeFacetComparisonAccess({ category: "Ruleset rules" }, {
    parentAction: { kind: "managed" },
  })
  assert.equal(managed.kind, FACET_COMPARISON_ACCESS_KIND.INSPECT)
  assert.match(managed.reason, /read-only/)
})

test("redirect child intent excludes ruleset-local order and display metadata", () => {
  const rule = {
    action: "redirect",
    action_parameters: {
      from_value: {
        status_code: 302,
        target_url: { value: "https://alpha.example/docs" },
      },
    },
    description: "Redirect docs",
    enabled: true,
    expression: "http.host eq \"alpha.example\"",
    id: "generated-id",
    ref: "explicit-ref",
  }

  assert.deepEqual(redirectIntentComparisonValue(rule, "alpha.example"), {
    action: "redirect",
    action_parameters: {
      from_value: {
        status_code: 302,
        target_url: { value: "https://{zone}/docs" },
      },
    },
    enabled: true,
    expression: "http.host eq \"{zone}\"",
  })
  assert.deepEqual(redirectIntentValueProjection({
    position: 7,
    rule: ruleExactComparisonValue(rule, "alpha.example"),
  }), redirectIntentComparisonValue(rule, "alpha.example"))
  const description = describeFacetEquivalence({
    category: "Redirects",
    key: "http_request_dynamic_redirect:docs",
  })
  assert.equal(description.equivalenceSummary, "Behavioral rule fields")
  assert.match(description.ignoredSummary, /Absolute position/)
})
