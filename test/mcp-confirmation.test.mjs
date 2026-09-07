import assert from "node:assert/strict"
import test from "node:test"

import {
  buildConfirmationForm,
  confirmationFieldKeys,
  operationReviewItems,
} from "../src/mcp-confirmation.mjs"

const DIGEST = `sha256:${"a".repeat(64)}`
const ZONE_ID = "1f096b0340e1f429a172c4ec8919d95d"
const RULESET_ID = "1eb1ea9b08b54e6cbd4885a21cad22cd"
const RULE_ID = "0a7ac0ac9f174abaa63166fb0509210b"
const CURRENT_EXPRESSION = [
  "(http.host wildcard \"*.*.*\"",
  "and not http.host wildcard \"*.*.*.*\"",
  "and not starts_with(http.host, \"www.\")",
  "and not starts_with(http.host, \"app.\")",
  "and not starts_with(http.host, \"mail.\")",
  "and not starts_with(http.host, \"hooks.\")",
  "and not starts_with(http.host, \"openai-d1-r2.\")",
  "and not starts_with(http.host, \"share.\")",
  "and not (http.host eq \"fleet.j-256.dev\")",
  "and not (http.host eq \"repos.j-256.dev\"))",
].join(" ")
const DESIRED_EXPRESSION = CURRENT_EXPRESSION.replace(
  "and not (http.host eq \"repos.j-256.dev\"))",
  "and not (http.host eq \"repos.j-256.dev\") and not (http.host eq \"repos-live.j-256.dev\"))",
)

function confirmationForm(operations) {
  const planSet = {
    digest: DIGEST,
    preview: operations,
    validatedAt: "2026-09-04T15:54:20.689Z",
  }
  return buildConfirmationForm({
    accountId: "f3172e87e5a2aa609ec184d4c72bd785",
    heading: "Review bounded fleet change",
    planSet,
    reviewItems: operationReviewItems(operations),
    summaryLines: [`Operations: ${operations.length}`],
  })
}

function visibleContentLineCount(form, key) {
  const field = form.requestedSchema.properties[key]
  return form.message.split("\n").length
    + 2
    + field.description.split("\n").length
    + field.oneOf.length
}

test("MCP confirmation reduces a long ruleset update to its changed leaf", () => {
  const currentValue = {
    action: "redirect",
    action_parameters: {
      from_value: {
        preserve_query_string: true,
        status_code: 302,
        target_url: {
          expression: "concat(\"https://github.com/j-256/\", wildcard_replace(http.host, r\"*.*.*\", r\"${1}\"), http.request.uri.path)",
        },
      },
    },
    description: "Redirect subdomains to github/j-256",
    enabled: true,
    expression: CURRENT_EXPRESSION,
  }
  const form = confirmationForm([{
    body: { ...currentValue, expression: DESIRED_EXPRESSION },
    currentValue,
    label: "Update Redirect subdomains to github/j-256",
    method: "PATCH",
    path: `zones/${ZONE_ID}/rulesets/${RULESET_ID}/rules/${RULE_ID}`,
    zoneId: ZONE_ID,
    zoneName: "j-256.dev",
  }])

  const field = form.requestedSchema.properties.review_1
  assert.equal(form.fieldCount, 1)
  assert.match(field.description, /Changes:/)
  assert.match(
    field.description,
    /Insert: " and not \(http\.host eq \\\"repos-live\.j-256\.dev\\\"\)"/,
  )
  assert.match(field.description, /After: .*repos\.j-256\.dev/)
  assert.doesNotMatch(field.description, /openai-d1-r2/)
  assert.doesNotMatch(field.description, /Current:|Request:/)
  assert.ok(
    field.description.split("\n").every((line) => line.length <= 76),
  )
  assert.ok(visibleContentLineCount(form, "review_1") <= 20)
})

test("MCP confirmation keeps a DNS deletion readable on one review field", () => {
  const form = confirmationForm([{
    currentValue: {
      type: "CNAME",
      name: "repos-live.j-256.dev.fad.bz",
      content: "727a0214-66bd-4162-9535-6dcbe351ad34.cfargotunnel.com",
      ttl: 1,
      proxied: true,
      tags: [],
      settings: { flatten_cname: false },
    },
    label: "Delete CNAME repos-live.j-256.dev.fad.bz",
    method: "DELETE",
    path: "zones/f46a6b3057b4ad43cbda0d514c9961fc/dns_records/0030d5129152b4071953c9b773cd41d5",
    zoneId: "f46a6b3057b4ad43cbda0d514c9961fc",
    zoneName: "fad.bz",
  }])

  const field = form.requestedSchema.properties.review_1
  assert.equal(form.fieldCount, 1)
  assert.equal(field.title, "1. Delete CNAME repos-live.j-256.dev.fad.bz")
  assert.equal(field.description.split("\n").length, 10)
  assert.match(field.description, /API: DELETE dns_records\/0030d512/)
  assert.match(field.description, /content: .*cfargotunnel\.com/)
  assert.match(field.description, /settings\.flatten_cname: false/)
  assert.deepEqual(field.oneOf, [
    { const: "decline", title: "Do not apply" },
    { const: "approve", title: "Approve this change" },
  ])
  assert.ok(visibleContentLineCount(form, "review_1") <= 20)
})

test("MCP confirmation summarizes an oversized operation value onto one review field", () => {
  const expression = `(${"x".repeat(3000)})`
  const form = confirmationForm([{
    body: {
      action: "block",
      description: "oversized rule",
      enabled: true,
      expression,
    },
    label: "Create a large rule",
    method: "POST",
    path: `zones/${ZONE_ID}/rulesets/${RULESET_ID}/rules`,
    zoneId: ZONE_ID,
    zoneName: "j-256.dev",
  }])

  const field = form.requestedSchema.properties.review_1
  assert.equal(form.fieldCount, 1)
  assert.equal(form.requestedSchema.required.length, 1)
  assert.match(field.description, /action: "block"/)
  assert.match(
    field.description,
    new RegExp(`expression: <large string, ${expression.length} chars, sha256:[a-f0-9]{12}`),
  )
  assert.match(field.description, /head:/)
  assert.doesNotMatch(field.description, /x{200}/)
  assert.ok(field.description.split("\n").every((line) => line.length <= 76))
})

test("MCP confirmation keeps a shared-WAF entrypoint create on one field with the rule expression summarized", () => {
  const antiScanner = "( ( lower(http.request.uri.path) contains \"/.\" )"
    + " or lower(http.request.uri.path) contains \".php\"".repeat(80)
    + ")"
  const form = confirmationForm([{
    body: {
      kind: "zone",
      name: "default",
      phase: "http_request_firewall_custom",
      rules: [
        {
          action: "skip",
          action_parameters: { products: ["zoneLockdown"] },
          description: "[fleet] Log All Others (Skip No-op)",
          enabled: true,
          expression: "(http.request.uri.path contains \"/\")",
          logging: { enabled: true },
        },
        {
          action: "block",
          description: "[fleet] cf-waf-deploy: anti-scanner block",
          enabled: true,
          expression: antiScanner,
        },
      ],
    },
    label: "Create the custom firewall entrypoint with fleet rules",
    method: "POST",
    path: `zones/${ZONE_ID}/rulesets`,
    zoneId: ZONE_ID,
    zoneName: "j256.dev",
  }])

  const field = form.requestedSchema.properties.review_1
  assert.equal(form.fieldCount, 1)
  assert.match(field.description, /rules\[0\]\.action: "skip"/)
  assert.match(
    field.description,
    /rules\[1\]\.description: "\[fleet\] cf-waf-deploy: anti-scanner block"/,
  )
  assert.match(
    field.description,
    /rules\[1\]\.expression: <large string, \d+ chars, sha256:[a-f0-9]{12}/,
  )
  assert.doesNotMatch(field.description, /\.php/)
  assert.ok(field.description.split("\n").every((line) => line.length <= 76))
})

test("MCP confirmation paginates an operation with many small leaves", () => {
  const body = Object.fromEntries(
    Array.from({ length: 90 }, (_value, index) => [
      `field_${String(index).padStart(2, "0")}`,
      `value-${index}`,
    ]),
  )
  const form = confirmationForm([{
    body,
    label: "Create a rule with many fields",
    method: "POST",
    path: `zones/${ZONE_ID}/rulesets/${RULESET_ID}/rules`,
    zoneId: ZONE_ID,
    zoneName: "j-256.dev",
  }])

  assert.ok(form.fieldCount > 1)
  assert.equal(form.requestedSchema.required.length, form.fieldCount)
  for (const field of Object.values(form.requestedSchema.properties)) {
    assert.ok(field.description.split("\n").length <= 40)
  }
})

test("MCP confirmation field keys retain review order past single digits", () => {
  const keys = confirmationFieldKeys(12)

  assert.deepEqual(keys, [...keys].sort())
  assert.equal(keys[0], "review_01")
  assert.equal(keys.at(-1), "review_12")
})
