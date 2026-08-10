import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

const appSource = await readFile(new URL("../src/app.mjs", import.meta.url), "utf8")

test("matrix keeps filtered rows detached from the live document", () => {
  assert.match(appSource, /let matrixRowElements = \[\]/)
  assert.match(appSource, /elements\.matrixBody\.replaceChildren\(\.\.\.visibleRows\)/)
  assert.match(appSource, /function matrixAwareQuery\(selector\)/)
  assert.doesNotMatch(appSource, /const currentRows = \[\.\.\.elements\.matrixBody\.querySelectorAll\("tr"\)\]/)
})

test("matrix tab-stop synchronization avoids layout reads", () => {
  const availability = appSource.match(
    /function matrixActionIsAvailable\(action\) \{([\s\S]*?)\n\}/,
  )?.[1] || ""

  assert.match(availability, /!action\.isConnected \|\| action\.disabled/)
  assert.match(availability, /\.matrix-column-hidden/)
  assert.match(availability, /inline-editing/)
  assert.doesNotMatch(availability, /getClientRects|getBoundingClientRect|offsetWidth|offsetHeight/)
})
