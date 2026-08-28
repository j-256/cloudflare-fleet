import assert from "node:assert/strict"
import test from "node:test"

import {
  RULESET_KIND,
  WAF_PHASE,
} from "../src/constants.mjs"
import {
  duplicateRuleDefinition,
  filterRulesetRules,
  findManagedDeployment,
  newRuleDefinition,
  normalizeRulesetDetail,
  SAFE_DISABLED_RULE_EXPRESSION,
  RULESET_RULE_PAGE_SIZE,
  rulesetIsEditable,
  rulesetKindLabel,
  rulesetRuleLabel,
  rulesetRulePage,
  rulesetSummary,
} from "../src/ruleset-workspace.mjs"
import { makeRule } from "./fixtures.mjs"

test("ruleset kinds distinguish editable and managed workspaces", () => {
  assert.equal(rulesetKindLabel(RULESET_KIND.ZONE), "Zone entrypoint")
  assert.equal(rulesetKindLabel(RULESET_KIND.CUSTOM), "Custom")
  assert.equal(rulesetKindLabel(RULESET_KIND.MANAGED), "Managed")
  assert.equal(rulesetKindLabel(RULESET_KIND.ROOT), "Account entrypoint")
  assert.equal(rulesetIsEditable({ kind: RULESET_KIND.ZONE }), true)
  assert.equal(rulesetIsEditable({ kind: RULESET_KIND.CUSTOM }), true)
  assert.equal(rulesetIsEditable({ kind: RULESET_KIND.MANAGED }), false)
  assert.equal(rulesetIsEditable({ kind: RULESET_KIND.ROOT }), false)
})

test("ruleset summaries make phase and rule count readable", () => {
  assert.deepEqual(
    rulesetSummary({
      description: "Fleet firewall",
      kind: RULESET_KIND.ZONE,
      phase: WAF_PHASE,
      rules: [makeRule("Block scanners")],
      version: "7",
    }),
    {
      description: "Fleet firewall",
      kind: "Zone entrypoint",
      phase: "Custom firewall",
      ruleCount: 1,
      version: "7",
    },
  )
})

test("editable rulesets normalize an omitted rules collection to empty", () => {
  assert.deepEqual(
    normalizeRulesetDetail({
      id: "empty-entrypoint",
      kind: "zone",
    }),
    {
      id: "empty-entrypoint",
      kind: "zone",
      rules: [],
    },
  )
  assert.deepEqual(
    normalizeRulesetDetail({
      id: "managed-summary",
      kind: "managed",
    }),
    {
      id: "managed-summary",
      kind: "managed",
    },
  )
})

test("new and duplicate rules are disabled safe drafts", () => {
  const original = makeRule("Block scanners", {
    action_parameters: {
      response: {
        content: "blocked",
      },
    },
    ref: "stable-ref",
  })
  assert.deepEqual(
    duplicateRuleDefinition(original),
    {
      action: "block",
      action_parameters: {
        response: {
          content: "blocked",
        },
      },
      description: "Block scanners copy",
      enabled: false,
      expression: "(http.request.uri.path contains \"/wp-admin\")",
    },
  )
  assert.deepEqual(
    newRuleDefinition({
      phase: WAF_PHASE,
      rules: [original],
    }),
    {
      action: "block",
      action_parameters: {
        response: {
          content: "blocked",
        },
      },
      description: "New rule",
      enabled: false,
      expression: SAFE_DISABLED_RULE_EXPRESSION,
    },
  )
  assert.deepEqual(
    newRuleDefinition({
      phase: "http_request_dynamic_redirect",
      rules: [],
    }),
    {
      action: "redirect",
      action_parameters: {
        from_value: {
          preserve_query_string: true,
          status_code: 302,
          target_url: {
            value: "https://example.com",
          },
        },
      },
      description: "New rule",
      enabled: false,
      expression: SAFE_DISABLED_RULE_EXPRESSION,
    },
  )
  assert.deepEqual(
    newRuleDefinition({
      phase: "http_response_headers_transform",
      rules: [],
    }),
    {
      action: "rewrite",
      action_parameters: {
        headers: {
          "X-Cloudflare-Fleet-Draft": {
            operation: "set",
            value: "replace-me",
          },
        },
      },
      description: "New rule",
      enabled: false,
      expression: SAFE_DISABLED_RULE_EXPRESSION,
    },
  )
  assert.equal(newRuleDefinition({ phase: "unknown", rules: [] }), null)
})

test("managed deployments resolve through editable execute rules", () => {
  const managed = {
    id: "managed-id",
    kind: RULESET_KIND.MANAGED,
    phase: "http_request_sanitize",
  }
  const deployment = findManagedDeployment(managed, [
    {
      id: "entrypoint-id",
      kind: RULESET_KIND.ZONE,
      phase: "http_request_sanitize",
      rules: [
        makeRule("", {
          action: "execute",
          action_parameters: {
            id: "managed-id",
            overrides: {
              rules: [{ enabled: false, id: "managed-rule-id" }],
            },
          },
          id: "deployment-rule-id",
        }),
      ],
    },
  ])
  assert.equal(deployment.ruleset.id, "entrypoint-id")
  assert.equal(deployment.rule.id, "deployment-rule-id")
  assert.equal(findManagedDeployment(managed, []), null)
})

test("ruleset search, status filters, and paging compose", () => {
  const rules = Array.from({ length: RULESET_RULE_PAGE_SIZE + 2 }, (_, index) => (
    makeRule(`Rule ${index + 1}`, {
      action: index % 2 === 0 ? "block" : "skip",
      enabled: index % 3 !== 0,
      expression: index === 4 ? "http.host eq \"special.example\"" : "true",
    })
  ))
  assert.equal(filterRulesetRules(rules, { query: "special" }).length, 1)
  assert.equal(filterRulesetRules(rules, { status: "disabled" }).length, 9)
  const page = rulesetRulePage(rules)
  assert.equal(page.totalCount, RULESET_RULE_PAGE_SIZE + 2)
  assert.equal(page.visible.length, RULESET_RULE_PAGE_SIZE)
  assert.equal(page.hasMore, true)
  assert.equal(rulesetRuleLabel({ action: "block" }, 2), "Block rule 3")
})
