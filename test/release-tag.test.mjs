import assert from "node:assert/strict"
import test from "node:test"

import { checkReleaseTag } from "../scripts/check-release-tag.mjs"

test("release tag must exactly match the package version", () => {
  assert.deepEqual(checkReleaseTag("v1.2.3", "1.2.3"), {
    tag: "v1.2.3",
    version: "1.2.3",
  })
  assert.throws(
    () => checkReleaseTag("v1.2.4", "1.2.3"),
    /Release tag must be v1\.2\.3/,
  )
  assert.throws(
    () => checkReleaseTag("1.2.3", "1.2.3"),
    /Release tag must be v1\.2\.3/,
  )
})
