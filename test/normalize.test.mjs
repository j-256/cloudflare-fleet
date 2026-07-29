import assert from "node:assert/strict"
import test from "node:test"

import {
  materializeValue,
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
