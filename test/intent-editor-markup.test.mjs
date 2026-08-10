import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

const html = await readFile(new URL("../index.html", import.meta.url), "utf8")
const appSource = await readFile(new URL("../src/app.mjs", import.meta.url), "utf8")
const styles = await readFile(new URL("../styles.css", import.meta.url), "utf8")

test("intent editor exposes exact comparison values and their observed sources", () => {
  assert.match(html, /<fieldset[^>]+id="intent-policy-observed-fields"/)
  assert.match(html, /id="intent-policy-values"/)
  assert.match(html, /id="intent-policy-differences"/)
  assert.match(html, /id="intent-policy-equivalence"/)
  assert.match(html, /Compared value that controls equivalence/)
  assert.match(html, /id="intent-policy-source-value"/)
  assert.match(html, /Representative observed source value/)
  assert.doesNotMatch(html, /<select id="intent-policy-value"/)
})

test("intent views render shared facet identity and equivalence explanations", () => {
  assert.match(html, /id="intent-acknowledgement-equivalence"/)
  assert.match(appSource, /createFacetEquivalencePanel\(row\)/)
  assert.match(appSource, /facetExpectedComparisonValue\(policy\.expected\)/)
})

test("matrix opens compared and observed values in a dedicated equivalence modal", () => {
  assert.match(html, /id="facet-equivalence-dialog"/)
  assert.match(html, /id="facet-equivalence-zone"/)
  assert.match(html, /id="facet-equivalence-compared"/)
  assert.match(html, /id="facet-equivalence-observed"/)
  assert.match(html, /id="facet-equivalence-access"/)
  assert.match(html, /id="facet-equivalence-title-source"/)
  assert.match(appSource, /function openFacetEquivalence\(/)
  assert.match(appSource, /function renderFacetEquivalenceAccess\(/)
  assert.match(appSource, /"Edit compared fields"/)
  assert.match(appSource, /text: "Not compared"/)
  assert.match(appSource, /className: "facet-label-source"/)
  assert.match(appSource, /className: "facet-title-value"/)
  assert.match(appSource, /className: "cell-action inspect-facet-value"/)
  assert.match(appSource, /text: "Same facet"/)
  assert.match(appSource, /text: "Exact match"/)
  assert.doesNotMatch(appSource, /Facet identity and exact equivalence/)
  assert.doesNotMatch(appSource, /details\.className = "cell-value-details"/)
})

test("ruleset parent review leads with exact definitions instead of count buckets", () => {
  assert.match(html, /Rule count appears on each definition as review metadata/)
  assert.match(appSource, /const reviewLabel = "Compare rule sets"/)
  assert.match(appSource, /text: rulesetComparison\.definitionSummaryText/)
  assert.doesNotMatch(appSource, /Most common count/)
})

test("matrix exposes phase as a filter and a stacked badge", () => {
  assert.match(html, /<select id="phase"/)
  assert.match(html, /<select id="matrix-sort"/)
  assert.match(html, /<option value="phase-execution" selected>Sort: Phase execution order<\/option>/)
  assert.match(html, /<option value="category">Sort: Category A-Z<\/option>/)
  assert.match(appSource, /function renderPhases\(\)/)
  assert.match(appSource, /sortMatrixRows\(/)
  assert.match(appSource, /className: "facet-phase-friendly"/)
  assert.match(appSource, /phase\.dataset\.phase = description\.phase/)
})

test("matrix exposes facet-level intent results and filtering", () => {
  assert.match(html, /<select id="intent-status"/)
  assert.match(html, /<option value="match">Matches intent<\/option>/)
  assert.match(appSource, /function facetIntentStatus\(row\)/)
  assert.match(appSource, /fleetIntentFacetResultPresentation\(row\.intentState\)/)
  assert.match(appSource, /className: `facet-intent-status \$\{presentation\.status\}`/)
  assert.match(appSource, /intentStatus: row\.dataset\.intentStatus/)
})

test("review hub separates intent drift from ungoverned differences", () => {
  assert.match(html, /id="review-intent-drift"/)
  assert.match(html, /id="review-ungoverned-differences"/)
  assert.match(appSource, /function showIntentDrift\(\)/)
  assert.match(appSource, /function showUngovernedDifferences\(\)/)
  assert.match(appSource, /`Review \$\{driftRows\} drifted facets`/)
  assert.match(appSource, /`\$\{actionableCells\} intent mismatch/)
  assert.doesNotMatch(html, /id="review-needs-attention"/)
})

test("intent manager explains baseline and refinement composition", () => {
  assert.match(
    html,
    /Contained groups refine broader baselines; partial overlaps remain peers\./,
  )
  assert.doesNotMatch(appSource, /allowed variation/i)
})

test("matching controls retain their visible label in the accessible name", () => {
  assert.match(
    appSource,
    /contextualActionLabel\(\s*"How matching works",\s*row\.label/,
  )
  assert.match(
    appSource,
    /contextualActionLabel\(\s*visibleLabel,\s*`\$\{state\.filterPanelExpanded/,
  )
})

test("intent manager is sectioned, filterable, and compact by default", () => {
  for (const section of [
    "policies",
    "groups",
    "coverage",
    "acknowledgements",
  ]) {
    assert.match(html, new RegExp(`data-intent-manager-section="${section}"`))
    assert.match(html, new RegExp(`data-intent-manager-panel="${section}"`))
  }
  for (const id of [
    "intent-policy-search",
    "intent-policy-status-filter",
    "intent-policy-category-filter",
    "intent-policy-group-filter",
    "intent-policy-visible-count",
  ]) {
    assert.match(html, new RegExp(`id="${id}"`))
  }
  assert.match(appSource, /function filterIntentPolicies\(\)/)
  assert.match(appSource, /matchingDetails\.className = "intent-item-details"/)
})

test("intent manager keeps navigation and exit controls outside its scrolling section", () => {
  assert.match(styles, /\.intent-dialog \{[\s\S]+overflow: hidden;/)
  assert.match(
    styles,
    /\.intent-workspace \{[\s\S]+grid-template-rows: auto auto auto minmax\(0, 1fr\) auto;/,
  )
  assert.match(
    styles,
    /\.intent-workspace > \.intent-section \{[\s\S]+min-height: 0;[\s\S]+overflow: auto;/,
  )
  assert.match(
    styles,
    /@media \(max-height: 640px\), \(max-width: 359px\), \(max-width: 420px\) and \(max-height: 760px\) \{[\s\S]+\.intent-manager-nav \{[\s\S]+grid-template-columns: repeat\(4, max-content\);/,
  )
})

test("facet intent actions stay in the focused policy editor", () => {
  assert.doesNotMatch(appSource, /showManager/)
  assert.match(
    appSource,
    /function activateIntentPolicyRow\(button\)[\s\S]+openIntentPolicyEditor\(action\.row, action\.policy\)/,
  )
  assert.match(appSource, /openIntentPolicyEditor\(row, preferredIntentPolicy\(policies\), options\)/)
})

test("policy and group editors preview impact and support focused shortcuts", () => {
  for (const id of [
    "intent-policy-impact",
    "intent-policy-inactive-preset",
    "intent-group-impact",
    "intent-group-search",
    "intent-group-selected-only",
    "intent-group-visible",
  ]) {
    assert.match(html, new RegExp(`id="${id}"`))
  }
  assert.match(appSource, /function renderIntentPolicyImpact\(\)/)
  assert.match(appSource, /function renderIntentGroupImpact\(\)/)
  assert.match(appSource, /function applyInactiveOrAbsentIntentPreset\(\)/)
})

test("facet intent can build an arbitrary zone scope without requiring a name", () => {
  for (const id of [
    "intent-policy-zone-picker",
    "intent-policy-zone-search",
    "intent-policy-zone-selected-only",
    "intent-policy-zone-select-all",
    "intent-policy-zone-clear",
    "intent-policy-zone-members",
    "intent-policy-scope-name",
    "intent-policy-use-zone-selection",
  ]) {
    assert.match(html, new RegExp(`id="${id}"`))
  }
  assert.match(html, /Saved scope shortcut/)
  assert.match(html, /Scope name <span class="optional-field">\(optional\)<\/span>/)
  assert.doesNotMatch(html, /id="intent-group-name"[^>]+required/)
  assert.doesNotMatch(html, /id="intent-policy-add-group"/)
  assert.match(appSource, /findIntentGroupForZoneSelection\(/)
  assert.match(appSource, /generatedIntentScopeName\(/)
  assert.match(
    appSource,
    /document = replaceFleetIntentGroup\(document, group\)[\s\S]+document = replaceFleetIntentPolicy\(document, policy\)/,
  )
})

test("intent health is prominent and policy review precedes group administration", () => {
  assert.match(html, /id="intent-verdict"/)
  assert.match(html, /id="intent-dialog-verdict"/)
  assert.ok(html.indexOf("id=\"intent-verdict\"") < html.indexOf("id=\"start-here\""))
  assert.ok(html.indexOf("id=\"intent-policies-title\"") < html.indexOf("id=\"intent-groups-title\""))
  assert.match(appSource, /INTENT_POLICY_STATUS_PRIORITY/)
})

test("fleet intent exposes persistent save status and locks every save action", () => {
  assert.equal((html.match(/data-intent-save-status/g) || []).length, 2)
  assert.equal((html.match(/data-intent-undo/g) || []).length, 2)
  assert.match(
    html,
    /data-intent-save-status[^>]+role="status"[^>]+aria-live="polite"/,
  )
  for (const id of [
    "coverage-intent-save",
    "intent-group-save",
    "intent-policy-save",
    "intent-acknowledgement-save",
    "intent-delete-apply",
  ]) {
    assert.match(
      html,
      new RegExp(`<button[^>]+id="${id}"[^>]+data-intent-write`),
    )
  }
  assert.match(html, /data-intent-undo disabled>Undo<\/button>/)
  assert.match(appSource, /button\.addEventListener\("click", undoIntentChange\)/)
})
