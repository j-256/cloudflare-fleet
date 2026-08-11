import assert from "node:assert/strict"
import test from "node:test"

import {
  materializeValue,
  normalizeText,
  normalizeValue,
  relativeName,
  stableString,
} from "../src/normalize.mjs"

test("stableString sorts object keys recursively", () => {
  assert.equal(
    stableString({ z: 1, a: { y: 2, b: 3 } }),
    "{\"a\":{\"b\":3,\"y\":2},\"z\":1}",
  )
})

test("normalizeValue removes system fields and normalizes zone-specific values", () => {
  const normalized = normalizeValue({
    created_on: "2026-07-29T00:00:00Z",
    id: "opaque-id",
    name: "www.alpha.example",
    records: [
      { content: "b.alpha.example" },
      { content: "a.alpha.example" },
    ],
  }, "alpha.example")

  assert.deepEqual(normalized, {
    name: "www.{zone}",
    records: [
      { content: "a.{zone}" },
      { content: "b.{zone}" },
    ],
  })
})

test("normalizeValue preserves ordered rule lists when requested", () => {
  const normalized = normalizeValue(["second", "first"], "alpha.example", {
    preserveOrder: true,
  })

  assert.deepEqual(normalized, ["second", "first"])
})

test("materializeValue replaces normalized zone placeholders recursively", () => {
  assert.deepEqual(
    materializeValue({
      expression: "http.host eq \"{zone}\"",
      targets: [
        "www.{zone}",
        {
          url: "https://{zone}/docs",
        },
      ],
    }, "beta.example"),
    {
      expression: "http.host eq \"beta.example\"",
      targets: [
        "www.beta.example",
        {
          url: "https://beta.example/docs",
        },
      ],
    },
  )
})

test("relativeName recognizes apex, relative, and external names", () => {
  assert.equal(relativeName("alpha.example", "alpha.example"), "@")
  assert.equal(relativeName("www.alpha.example", "alpha.example"), "www")
  assert.equal(relativeName("external.example", "alpha.example"), "external.example")
})

test("normalizeText only rewrites the zone name at domain-label boundaries", () => {
  // A zone name embedded inside a larger label is a different host and must survive
  assert.equal(
    normalizeText("http.host eq \"myexample.com-alert.net\"", "example.com"),
    "http.host eq \"myexample.com-alert.net\"",
  )
  // A longer label that merely ends with the zone name is not a boundary match
  assert.equal(normalizeText("example.company", "example.com"), "example.company")
  // An identical shared value must normalize the same under any comparison zone
  const shared = "http.host eq \"myexample.com-alert.net\""
  assert.equal(normalizeText(shared, "example.com"), normalizeText(shared, "test.com"))
  // Genuine boundary occurrences are still rewritten
  assert.equal(normalizeText("example.com", "example.com"), "{zone}")
  assert.equal(normalizeText("www.example.com", "example.com"), "www.{zone}")
  assert.equal(normalizeText("example.com.", "example.com"), "{zone}.")
  assert.equal(
    normalizeText("redirect to https://example.com/path", "example.com"),
    "redirect to https://{zone}/path",
  )
  // A hyphen is a separator, not a label character, so generated refs still normalize
  assert.equal(normalizeText("protect-example.com", "example.com"), "protect-{zone}")
})

test("normalizeValue rewrites nested strings only at zone-label boundaries", () => {
  assert.deepEqual(
    normalizeValue({ expression: "ends_with(http.host, \"notexample.com\")" }, "example.com"),
    { expression: "ends_with(http.host, \"notexample.com\")" },
  )
})
