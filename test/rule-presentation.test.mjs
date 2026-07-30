import assert from "node:assert/strict"
import test from "node:test"

import {
  humanizeRuleField,
  presentRule,
  ruleActionLabel,
  rulePhaseLabel,
} from "../src/rule-presentation.mjs"

test("rule presentation gives fleet actions and phases readable labels", () => {
  assert.equal(ruleActionLabel("set_config"), "Set configuration")
  assert.equal(ruleActionLabel("execute"), "Execute ruleset")
  assert.equal(rulePhaseLabel("http_request_firewall_custom"), "Custom firewall")
  assert.equal(rulePhaseLabel("future_phase"), "Future phase")
})

test("rule field labels preserve common technical initialisms", () => {
  assert.equal(humanizeRuleField("target_url"), "Target URL")
  assert.equal(humanizeRuleField("host_header"), "Host header")
  assert.equal(humanizeRuleField("new_field_name"), "New field name")
})

test("rule presentation separates common facts from nested configuration", () => {
  const presentation = presentRule({
    action: "redirect",
    action_parameters: {
      from_value: {
        preserve_query_string: true,
        status_code: 301,
      },
    },
    description: "Redirect docs",
    enabled: true,
    expression: "http.request.uri.path eq \"/docs\"",
    logging: {
      enabled: true,
    },
    ref: "redirect-docs",
  }, "http_request_dynamic_redirect")

  assert.deepEqual(
    presentation.fields.map(({ key, value }) => [key, value]),
    [
      ["description", "Redirect docs"],
      ["enabled", "Enabled"],
      ["action", "Redirect"],
      ["phase", "Dynamic redirects"],
      ["expression", "http.request.uri.path eq \"/docs\""],
      ["ref", "redirect-docs"],
    ],
  )
  assert.deepEqual(
    presentation.sections.map(({ key }) => key),
    ["action_parameters", "logging"],
  )
})
