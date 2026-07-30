import assert from "node:assert/strict"
import test from "node:test"

import {
  appendArrayItemAtPath,
  defaultValueForKind,
  humanizeValueField,
  JSON_VALUE_KIND,
  jsonValueKind,
  orderedValueEntries,
  parseScalarControl,
  removeArrayItemAtPath,
  replaceValueAtPath,
  valueAtPath,
  valueControlDescriptor,
} from "../src/value-editor.mjs"

test("JSON value kinds distinguish every supported control shape", () => {
  assert.equal(jsonValueKind(null), JSON_VALUE_KIND.NULL)
  assert.equal(jsonValueKind([]), JSON_VALUE_KIND.ARRAY)
  assert.equal(jsonValueKind(false), JSON_VALUE_KIND.BOOLEAN)
  assert.equal(jsonValueKind(42), JSON_VALUE_KIND.NUMBER)
  assert.equal(jsonValueKind({}), JSON_VALUE_KIND.OBJECT)
  assert.equal(jsonValueKind("value"), JSON_VALUE_KIND.STRING)
  assert.throws(() => jsonValueKind(undefined), /Unsupported JSON value type/)
  assert.throws(() => jsonValueKind(Number.POSITIVE_INFINITY), /Unsupported JSON value type/)
})

test("value field labels preserve common infrastructure initialisms", () => {
  assert.equal(humanizeValueField("min_tls_version"), "Min TLS version")
  assert.equal(humanizeValueField("target_url"), "Target URL")
  assert.equal(humanizeValueField("dns_record_id"), "DNS record ID")
  assert.equal(humanizeValueField("include_subdomains"), "Include subdomains")
})

test("control descriptors reserve multiline controls for long or semantic text", () => {
  assert.deepEqual(
    valueControlDescriptor("http.host eq \"example.com\"", "expression"),
    {
      kind: JSON_VALUE_KIND.STRING,
      multiline: true,
    },
  )
  assert.deepEqual(
    valueControlDescriptor("strict", "value"),
    {
      kind: JSON_VALUE_KIND.STRING,
      multiline: false,
    },
  )
  assert.equal(
    valueControlDescriptor("route1.mx.cloudflare.net", "content").multiline,
    false,
  )
  assert.equal(
    valueControlDescriptor("v=spf1 ".repeat(16), "content").multiline,
    true,
  )
  assert.deepEqual(
    valueControlDescriptor(300, "ttl"),
    {
      kind: JSON_VALUE_KIND.NUMBER,
      multiline: false,
    },
  )
})

test("common rule and DNS fields receive a readable editor order", () => {
  assert.deepEqual(
    orderedValueEntries({
      action: "redirect",
      action_parameters: {},
      description: "Redirect docs",
      enabled: true,
      expression: "true",
    }).map(([key]) => key),
    [
      "description",
      "enabled",
      "action",
      "expression",
      "action_parameters",
    ],
  )
  assert.deepEqual(
    orderedValueEntries({
      comment: "",
      content: "192.0.2.1",
      name: "example.com",
      proxied: true,
      ttl: 1,
      type: "A",
    }).map(([key]) => key),
    [
      "type",
      "name",
      "content",
      "ttl",
      "proxied",
      "comment",
    ],
  )
})

test("nested replacements preserve the original JSON value", () => {
  const original = {
    security: {
      enabled: false,
      max_age: 0,
    },
  }
  const replaced = replaceValueAtPath(
    original,
    ["security", "enabled"],
    true,
  )

  assert.equal(valueAtPath(replaced, ["security", "enabled"]), true)
  assert.equal(valueAtPath(original, ["security", "enabled"]), false)
  assert.notEqual(replaced, original)
  assert.notEqual(replaced.security, original.security)
})

test("array helpers add a matching item type and remove exact indexes", () => {
  const original = {
    tags: ["fleet"],
  }
  const appended = appendArrayItemAtPath(original, ["tags"])
  assert.deepEqual(appended, {
    tags: ["fleet", ""],
  })
  assert.deepEqual(
    removeArrayItemAtPath(appended, ["tags"], 0),
    {
      tags: [""],
    },
  )
  assert.deepEqual(original, {
    tags: ["fleet"],
  })
})

test("scalar controls preserve JSON types and reject invalid numbers", () => {
  assert.equal(parseScalarControl(JSON_VALUE_KIND.STRING, "125"), "125")
  assert.equal(parseScalarControl(JSON_VALUE_KIND.NUMBER, "125"), 125)
  assert.equal(parseScalarControl(JSON_VALUE_KIND.BOOLEAN, "", true), true)
  assert.throws(
    () => parseScalarControl(JSON_VALUE_KIND.NUMBER, ""),
    /Enter a number/,
  )
})

test("null type choices produce valid empty JSON values", () => {
  assert.equal(defaultValueForKind(JSON_VALUE_KIND.NULL), null)
  assert.equal(defaultValueForKind(JSON_VALUE_KIND.STRING), "")
  assert.equal(defaultValueForKind(JSON_VALUE_KIND.NUMBER), 0)
  assert.equal(defaultValueForKind(JSON_VALUE_KIND.BOOLEAN), false)
  assert.deepEqual(defaultValueForKind(JSON_VALUE_KIND.ARRAY), [])
  assert.deepEqual(defaultValueForKind(JSON_VALUE_KIND.OBJECT), {})
})
