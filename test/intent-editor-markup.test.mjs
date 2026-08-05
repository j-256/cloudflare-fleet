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

test("fleet intent exposes persistent save status and locks every save action", () => {
  assert.equal((html.match(/data-intent-save-status/g) || []).length, 2)
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
})
