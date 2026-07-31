import assert from "node:assert/strict"
import test from "node:test"

import {
  presentRedirect,
  redirectSemanticIdentity,
  redirectTargetKindLabel,
  REDIRECT_STATUS_OPTIONS,
} from "../src/redirect-presentation.mjs"

test("redirect presentation distinguishes static and dynamic targets", () => {
  const shared = {
    action: "redirect",
    enabled: true,
    expression: "http.host eq \"www.example.com\"",
  }
  const staticRedirect = presentRedirect({
    ...shared,
    action_parameters: {
      from_value: {
        preserve_query_string: false,
        status_code: 308,
        target_url: {
          value: "https://example.com/",
        },
      },
    },
  })
  const dynamicRedirect = presentRedirect({
    ...shared,
    action_parameters: {
      from_value: {
        preserve_query_string: true,
        status_code: 302,
        target_url: {
          expression: "concat(\"https://example.com\", http.request.uri.path)",
        },
      },
    },
  })

  assert.deepEqual(
    {
      query: staticRedirect.queryLabel,
      response: staticRedirect.responseLabel,
      target: staticRedirect.target,
      type: staticRedirect.targetKindLabel,
    },
    {
      query: "Drop query",
      response: "308 Permanent redirect",
      target: "https://example.com/",
      type: "Static target",
    },
  )
  assert.deepEqual(
    {
      query: dynamicRedirect.queryLabel,
      response: dynamicRedirect.responseLabel,
      target: dynamicRedirect.target,
      type: dynamicRedirect.targetKindLabel,
    },
    {
      query: "Keep query",
      response: "302 Found",
      target: "concat(\"https://example.com\", http.request.uri.path)",
      type: "Dynamic target",
    },
  )
})

test("redirect identity follows matching behavior instead of its mutable name", () => {
  const rule = {
    action: "redirect",
    description: "A mutable display name",
    expression: "http.request.uri.path eq \"/docs\"",
  }

  assert.equal(
    redirectSemanticIdentity(rule),
    "http.request.uri.path eq \"/docs\"",
  )
  assert.equal(redirectTargetKindLabel("future-kind"), "Unknown target")
})

test("redirect presentation covers list-backed and incomplete definitions", () => {
  const listRedirect = presentRedirect({
    action: "redirect",
    action_parameters: {
      from_list: {
        key: "http.request.full_uri",
        name: "fleet_redirects",
      },
    },
    enabled: false,
    expression: "true",
  })
  const incompleteRedirect = presentRedirect({ action: "redirect" })

  assert.deepEqual(
    REDIRECT_STATUS_OPTIONS.map(({ value }) => value),
    [301, 302, 303, 307, 308],
  )
  assert.deepEqual(
    {
      enabled: listRedirect.enabledLabel,
      query: listRedirect.queryLabel,
      response: listRedirect.responseLabel,
      target: listRedirect.target,
      type: listRedirect.targetKindLabel,
    },
    {
      enabled: "Disabled",
      query: "Query behavior unspecified",
      response: "Response code unspecified",
      target: "fleet_redirects",
      type: "List target",
    },
  )
  assert.equal(incompleteRedirect.target, "Target unavailable")
  assert.equal(incompleteRedirect.targetKindLabel, "Unknown target")
})
