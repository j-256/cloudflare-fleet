import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

const NARROW_PHONE_MEDIA_QUERY = "@media (max-width: 359px)"
const styles = await readFile(new URL("../styles.css", import.meta.url), "utf8")
const narrowPhoneStart = styles.indexOf(NARROW_PHONE_MEDIA_QUERY)
const narrowPhoneEnd = styles.indexOf("@media", narrowPhoneStart + NARROW_PHONE_MEDIA_QUERY.length)
const narrowPhoneStyles = styles.slice(narrowPhoneStart, narrowPhoneEnd)

test("narrow phone header stacks session state below its title", () => {
  assert.notEqual(narrowPhoneStart, -1)
  assert.match(
    narrowPhoneStyles,
    /\.hero \{[^}]*grid-template-columns: minmax\(0, 1fr\);/s,
  )
  assert.match(
    narrowPhoneStyles,
    /\.session-state \{[^}]*grid-column: 1;[^}]*grid-row: 2;/s,
  )
  assert.match(narrowPhoneStyles, /\.summary-grid \{[^}]*grid-row: 3;/s)
  assert.match(narrowPhoneStyles, /\.intent-verdict-main \{[^}]*grid-row: 4;/s)
  assert.match(narrowPhoneStyles, /\.load-progress \{[^}]*grid-row: 5;/s)
})
