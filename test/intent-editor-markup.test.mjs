import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

const html = await readFile(new URL("../index.html", import.meta.url), "utf8")
const appSource = await readFile(new URL("../src/app.mjs", import.meta.url), "utf8")

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

test("intent manager explains baseline and refinement composition", () => {
  assert.match(
    html,
    /Broader groups form baselines; narrower overlapping groups refine them\./,
  )
  assert.doesNotMatch(appSource, /allowed variation/i)
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
