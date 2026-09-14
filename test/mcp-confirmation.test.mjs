import assert from "node:assert/strict"
import test from "node:test"

import {
  buildConfirmationForm,
  CONFIRMATION_APPROVAL_MODE,
  CONFIRMATION_PROMPT_LINE_LIMIT,
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

function confirmationForm(operations, options = {}) {
  const planSet = {
    digest: DIGEST,
    preview: operations,
    validatedAt: "2026-09-04T15:54:20.689Z",
  }
  return buildConfirmationForm({
    accountId: "f3172e87e5a2aa609ec184d4c72bd785",
    approvalMode: options.approvalMode,
    heading: "Review bounded fleet change",
    planSet,
    reviewItems: operationReviewItems(operations),
    summaryLines: operations.length > 1 ? [`Operations: ${operations.length}`] : [],
  })
}

function visibleContentLineCount(form, key) {
  const field = form.requestedSchema.properties[key]
  return form.message.split("\n").length
    + 2
    + field.description.split("\n").length
    + field.oneOf.length
}

function assertReadableForm(form) {
  for (const key of form.requestedSchema.required) {
    const field = form.requestedSchema.properties[key]
    assert.ok(visibleContentLineCount(form, key) + 6 <= 24, key)
    assert.ok(
      [form.message, field.title, field.description].join("\n")
        .split("\n").every((line) => line.length <= 76),
      key,
    )
  }
}

function reviewText(form) {
  return Object.values(form.requestedSchema.properties)
    .map((field) => field.description).join("\n")
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

test("MCP confirmation pages a shared-WAF entrypoint while retaining its summarized expression", () => {
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

  const description = reviewText(form)
  assert.ok(form.fieldCount > 1)
  assertReadableForm(form)
  assert.match(description, /rules\[0\]\.action: "skip"/)
  assert.match(
    description,
    /rules\[1\]\.description: "\[fleet\] cf-waf-deploy: anti-scanner block"/,
  )
  assert.match(
    description,
    /rules\[1\]\.expression: <large string, \d+ chars, sha256:[a-f0-9]{12}/,
  )
  assert.doesNotMatch(description, /\.php/)
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
  assertReadableForm(form)
  const description = reviewText(form)
  for (const [key, value] of Object.entries(body)) {
    assert.ok(description.includes(`${key}: "${value}"`))
  }
})

test("MCP batch confirmation keeps every operation visible behind one decision", () => {
  const form = confirmationForm([
    {
      body: { value: "on" },
      currentValue: { value: "off" },
      label: "Enable HTTPS",
      method: "PATCH",
      path: `zones/${ZONE_ID}/settings/always_use_https`,
      zoneId: ZONE_ID,
      zoneName: "j-256.dev",
    },
    {
      body: { value: "on" },
      currentValue: { value: "off" },
      label: "Enable Early Hints",
      method: "PATCH",
      path: `zones/${ZONE_ID}/settings/early_hints`,
      zoneId: ZONE_ID,
      zoneName: "j-256.dev",
    },
  ], { approvalMode: CONFIRMATION_APPROVAL_MODE.BATCH })

  assert.equal(form.fieldCount, 2)
  assert.deepEqual(form.requestedSchema.required, ["review_1", "review_2"])
  const field = form.requestedSchema.properties.review_1
  assert.match(field.description, /1\. Enable HTTPS/)
  assert.match(field.description, /settings\/always_use_https/)
  assert.match(field.description, /2\. Enable Early Hints/)
  assert.match(field.description, /settings\/early_hints/)
  assert.deepEqual(field.oneOf, [
    { const: "decline", title: "Do not apply" },
    { const: "reviewed", title: "Reviewed / Continue" },
  ])
  const final = form.requestedSchema.properties.review_2
  assert.match(final.description, /Apply all 2 reviewed operations/)
  assert.ok(final.description.includes(DIGEST))
  assert.deepEqual(final.oneOf, [
    { const: "decline", title: "Do not apply" },
    { const: "approve", title: "Approve entire batch" },
  ])
  assertReadableForm(form)
})

test("MCP batch review keeps an eight-operation plan reachable in bounded fields", () => {
  const operations = Array.from({ length: 8 }, (_value, index) => ({
    body: { enabled: false },
    currentValue: { enabled: true },
    label: `Disable rule ${index + 1}`,
    method: "PATCH",
    path: `zones/${ZONE_ID}/rulesets/${RULESET_ID}/rules/${String(index + 1).padStart(32, "0")}`,
    zoneId: ZONE_ID,
    zoneName: "example.com",
  }))
  const form = confirmationForm(operations, { approvalMode: CONFIRMATION_APPROVAL_MODE.BATCH })
  const fields = Object.values(form.requestedSchema.properties)
  assert.ok(fields.length > 2)
  assertReadableForm(form)
  for (const field of fields.slice(0, -1)) {
    assert.deepEqual(field.oneOf.map((option) => option.const), ["decline", "reviewed"])
    assert.equal(field.default, undefined)
  }
  assert.deepEqual(fields.at(-1).oneOf.map((option) => option.const), ["decline", "approve"])
  assert.equal(fields.at(-1).default, undefined)
  const description = reviewText(form)
  let previous = -1
  for (let index = 1; index <= operations.length; index += 1) {
    const offset = description.indexOf(`${index}. Disable rule ${index}`)
    assert.ok(offset > previous)
    assert.ok(description.includes(String(index).padStart(32, "0")))
    previous = offset
  }
})

test("MCP review pages long labels and bodies without dropping the last leaf", () => {
  const form = confirmationForm([{
    body: Object.fromEntries(Array.from({ length: 120 }, (_value, index) => [`field_${index}`, index])),
    label: `Large ${"descriptive ".repeat(100)}rule`,
    method: "POST",
    path: `zones/${ZONE_ID}/rulesets`,
    zoneId: ZONE_ID,
    zoneName: "example.com",
  }], { approvalMode: CONFIRMATION_APPROVAL_MODE.BATCH })
  assert.ok(form.fieldCount > 10)
  assertReadableForm(form)
  assert.match(reviewText(form), /field_119: 119/)
  const keys = form.requestedSchema.required
  assert.deepEqual(keys, [...keys].sort())
  assert.equal(form.requestedSchema.properties[keys.at(-1)].title, "Final batch decision")
})

test("MCP confirmation rejects an empty batch and an unpageable heading", () => {
  assert.throws(() => confirmationForm([], { approvalMode: CONFIRMATION_APPROVAL_MODE.BATCH }), /at least one review item/)
  assert.throws(() => buildConfirmationForm({
    accountId: "account",
    heading: "heading\n".repeat(CONFIRMATION_PROMPT_LINE_LIMIT),
    planSet: { digest: DIGEST, validatedAt: "2026-09-14T00:00:00Z" },
    reviewItems: [{ title: "Item", lines: ["value"] }],
    summaryLines: [],
  }), /use the CLI or dashboard/)
})

test("MCP review budgets wide text and escapes controls without splitting surrogate pairs", () => {
  const form = buildConfirmationForm({
    accountId: "account",
    approvalMode: CONFIRMATION_APPROVAL_MODE.BATCH,
    heading: "Review batch",
    planSet: { digest: DIGEST, validatedAt: "2026-09-14T00:00:00Z" },
    reviewItems: [{
      title: `Wide ${"\u4e2d".repeat(80)}${"\u{1f680}".repeat(40)} label`,
      lines: [`${" ".repeat(200)}last leaf\tvalue\u001b[31m`],
    }],
    summaryLines: [],
  })
  for (const field of Object.values(form.requestedSchema.properties)) {
    for (const line of field.description.split("\n")) {
      assert.ok(line.isWellFormed())
      assert.ok(line.replace(/\u4e2d/gu, "xx").length <= 76)
    }
  }
  assert.match(reviewText(form), /last leaf\\u0009value\\u001b\[31m/)
  assertReadableForm(form)
})

test("MCP confirmation field keys retain review order past single digits", () => {
  const keys = confirmationFieldKeys(12)

  assert.deepEqual(keys, [...keys].sort())
  assert.equal(keys[0], "review_01")
  assert.equal(keys.at(-1), "review_12")
})
