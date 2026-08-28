import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

const html = await readFile(new URL("../index.html", import.meta.url), "utf8")
const appSource = await readFile(new URL("../src/app.mjs", import.meta.url), "utf8")
const styles = await readFile(new URL("../styles.css", import.meta.url), "utf8")

test("activity history keeps controls outside its scrolling records", () => {
  assert.match(
    html,
    /class="activity-scroll-region">[\s\S]+id="activity-load-error"[\s\S]+id="activity-list"[\s\S]+class="dialog-actions"/,
  )
  assert.match(styles, /\.activity-dialog \{[\s\S]+overflow: hidden;/)
  assert.match(styles, /\.activity-workspace \{[\s\S]+grid-template-rows: auto auto minmax\(0, 1fr\) auto;/)
  assert.match(styles, /\.activity-scroll-region \{[\s\S]+min-height: 0;[\s\S]+overflow: auto;/)
})

test("activity summaries stay compact while details retain journal identity", () => {
  assert.match(appSource, /text: "Journal record"/)
  assert.match(appSource, /\["ID", entry\.id\]/)
  assert.match(appSource, /text: formatActivityTime\(entry\.startedAt\)/)
  assert.doesNotMatch(appSource, /formatActivityTime\(entry\.startedAt\)\} \| \$\{entry\.id\}/)
})
