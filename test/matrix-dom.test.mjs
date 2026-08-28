import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

const appSource = await readFile(new URL("../src/app.mjs", import.meta.url), "utf8")
const html = await readFile(new URL("../index.html", import.meta.url), "utf8")
const styles = await readFile(new URL("../styles.css", import.meta.url), "utf8")

test("matrix gives sticky priority to zone headings across full-width controls", () => {
  const toolbarRule = styles.match(/\.toolbar \{([^}]*)\}/)?.[1] || ""
  const headingRule = styles.match(/thead th \{([^}]*)\}/)?.[1] || ""
  const focusToolbarRule = styles.match(
    /body\.matrix-focus \.toolbar \{([^}]*)\}/,
  )?.[1] || ""

  assert.match(toolbarRule, /position: relative;/)
  assert.doesNotMatch(toolbarRule, /position: sticky;/)
  assert.match(
    toolbarRule,
    /width: calc\(100% \+ var\(--page-gutter\) \+ var\(--page-gutter\)\);/,
  )
  assert.match(
    toolbarRule,
    /margin-left: calc\(0px - var\(--page-gutter\)\);/,
  )
  assert.match(headingRule, /position: sticky;/)
  assert.match(headingRule, /top: 0;/)
  assert.match(focusToolbarRule, /width: 100%;/)
})

test("matrix keeps filtered rows detached from the live document", () => {
  assert.match(appSource, /let matrixRowElements = \[\]/)
  assert.match(appSource, /elements\.matrixBody\.replaceChildren\(\.\.\.visibleRows\)/)
  assert.match(appSource, /function matrixAwareQuery\(selector\)/)
  assert.doesNotMatch(appSource, /const currentRows = \[\.\.\.elements\.matrixBody\.querySelectorAll\("tr"\)\]/)
})

test("matrix control availability avoids layout reads", () => {
  const availability = appSource.match(
    /function matrixControlIsAvailable\(control\) \{([\s\S]*?)\n\}/,
  )?.[1] || ""

  assert.match(availability, /!control\.isConnected \|\| control\.disabled/)
  assert.match(availability, /\.matrix-column-hidden/)
  assert.match(availability, /inline-editing/)
  assert.doesNotMatch(availability, /getClientRects|getBoundingClientRect|offsetWidth|offsetHeight/)
})

test("matrix uses one roving tab stop for zone selectors and row actions", () => {
  const zoneHeading = appSource.match(
    /function zoneHeading\(zone\) \{([\s\S]*?)\n\}/,
  )?.[1] || ""

  assert.match(
    appSource,
    /const MATRIX_CONTROL_SELECTOR = "\.matrix-zone-select, summary, \.cell-action"/,
  )
  assert.match(zoneHeading, /checkbox\.className = "matrix-zone-select"/)
  assert.match(appSource, /\.\.\.elements\.matrixHead\.querySelectorAll\("tr"\)/)
  assert.match(appSource, /elements\.matrixTable\.addEventListener\("focusin"/)
  assert.match(appSource, /elements\.matrixTable\.addEventListener\("keydown"/)
  assert.match(html, /Press Space to toggle a zone or Enter to activate an action\./)
})

test("workflow drift counts reveal and narrow the matrix", () => {
  assert.match(
    html,
    /<button class="drift-badge" id="email-policy-drift" type="button" disabled>/,
  )
  assert.match(
    html,
    /<button class="drift-badge" id="waf-policy-drift" type="button" disabled>/,
  )
  assert.match(appSource, /function showWorkflowDriftInMatrix\(button, workflow\)/)
  assert.match(appSource, /state\.selectedColumnsOnly = zoneIds\.length < state\.inventory\.zones\.length/)
  assert.match(appSource, /revealMatrixTarget\(\{ zoneIds \}\)/)
})

test("matrix reveal targets have shared row, column, and cell treatment", () => {
  assert.match(appSource, /function revealMatrixTarget\(options\)/)
  assert.match(appSource, /matrixRevealScrollPosition\(\{/)
  assert.match(appSource, /filterRows\(\{ preserveReveal: true \}\)/)
  assert.match(appSource, /function restoreMatrixRevealClasses\(\)/)
  assert.doesNotMatch(appSource, /matrix-navigation-target/)
  assert.match(styles, /\.matrix-reveal-row \{/)
  assert.match(styles, /\.zone-heading\.matrix-reveal-column/)
  assert.match(styles, /\.matrix-cell\.matrix-reveal-cell/)
})

test("category support stays explanatory without a capability pill wall", () => {
  assert.match(html, />View support<\/p>/)
  assert.doesNotMatch(html, /id="category-capability-badges"/)
  assert.doesNotMatch(appSource, /categoryCapabilityBadges|function capabilityBadge/)
  assert.doesNotMatch(styles, /\.category-capability-badges/)
})

test("individual TXT record rows expose flat purpose labels and a contextual filter", () => {
  assert.match(
    html,
    /<select id="txt-purpose" aria-describedby="visible-count" hidden disabled>/,
  )
  assert.match(appSource, /function renderTxtPurposes\(\)/)
  assert.match(appSource, /Limit individual TXT record rows to one purpose/)
  assert.match(appSource, /tr\.dataset\.txtPurposes = row\.txtPurposes\.join\(" "\)/)
  assert.match(appSource, /className: "txt-purpose-label"/)
  assert.match(styles, /\.txt-purpose-label \{[^}]*border-left:/s)
  assert.doesNotMatch(styles, /\.txt-purpose-label \{[^}]*border-radius:/s)
})
