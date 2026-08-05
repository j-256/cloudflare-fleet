import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

const html = await readFile(new URL("../index.html", import.meta.url), "utf8")
const appSource = await readFile(new URL("../src/app.mjs", import.meta.url), "utf8")

test("intent editor exposes observed values as a comparison-backed radio group", () => {
  assert.match(html, /<fieldset[^>]+id="intent-policy-observed-fields"/)
  assert.match(html, /id="intent-policy-values"/)
  assert.match(html, /id="intent-policy-differences"/)
  assert.match(html, /Show complete selected value/)
  assert.doesNotMatch(html, /<select id="intent-policy-value"/)
})

test("intent manager explains baseline and refinement composition", () => {
  assert.match(
    html,
    /Broader groups form baselines; narrower overlapping groups refine them\./,
  )
  assert.doesNotMatch(appSource, /allowed variation/i)
})
