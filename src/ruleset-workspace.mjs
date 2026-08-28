import {
  RULESET_KIND,
  WAF_PHASE,
} from "./constants.mjs"
import { editableRulePayload } from "./policies.mjs"
import {
  ruleActionLabel,
  rulePhaseLabel,
} from "./rule-presentation.mjs"

export const RULESET_RULE_PAGE_SIZE = 25
export const SAFE_DISABLED_RULE_EXPRESSION = "(http.host eq \"cloudflare-fleet.invalid\")"

const EMPTY_RULE_TEMPLATES = Object.freeze({
  http_config_settings: Object.freeze({
    action: "set_config",
    action_parameters: {
      security_level: "essentially_off",
    },
  }),
  http_request_dynamic_redirect: Object.freeze({
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
  }),
  http_response_headers_transform: Object.freeze({
    action: "rewrite",
    action_parameters: {
      headers: {
        "X-Cloudflare-Fleet-Draft": {
          operation: "set",
          value: "replace-me",
        },
      },
    },
  }),
  [WAF_PHASE]: Object.freeze({
    action: "block",
  }),
})

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value))
}

export function rulesetKindLabel(kind) {
  if (kind === RULESET_KIND.CUSTOM) return "Custom"
  if (kind === RULESET_KIND.MANAGED) return "Managed"
  if (kind === RULESET_KIND.ROOT) return "Account entrypoint"
  if (kind === RULESET_KIND.ZONE) return "Zone entrypoint"
  return "Unknown"
}

export function rulesetIsEditable(ruleset) {
  return [RULESET_KIND.CUSTOM, RULESET_KIND.ZONE].includes(ruleset?.kind)
}

export function normalizeRulesetDetail(ruleset) {
  if (!rulesetIsEditable(ruleset) || Array.isArray(ruleset.rules)) return ruleset
  return {
    ...ruleset,
    rules: [],
  }
}

export function rulesetRuleLabel(rule, index = 0) {
  return rule?.description
    || (rule?.ref && rule.ref !== rule.id ? rule.ref : "")
    || `${ruleActionLabel(rule?.action)} rule ${index + 1}`
}

export function rulesetSummary(ruleset) {
  const count = Array.isArray(ruleset?.rules) ? ruleset.rules.length : null
  return {
    description: ruleset?.description || "",
    kind: rulesetKindLabel(ruleset?.kind),
    phase: rulePhaseLabel(ruleset?.phase),
    ruleCount: count,
    version: ruleset?.version || "",
  }
}

export function duplicateRuleDefinition(rule, index = 0) {
  const copy = editableRulePayload(rule)
  delete copy.ref
  return {
    ...copy,
    description: `${rulesetRuleLabel(rule, index)} copy`,
    enabled: false,
  }
}

export function newRuleDefinition(ruleset) {
  const first = ruleset?.rules?.[0]
  if (first) {
    const template = editableRulePayload(first)
    delete template.ref
    return {
      ...template,
      description: "New rule",
      enabled: false,
      expression: SAFE_DISABLED_RULE_EXPRESSION,
    }
  }
  const template = EMPTY_RULE_TEMPLATES[ruleset?.phase]
  if (!template) return null
  return {
    ...cloneJson(template),
    description: "New rule",
    enabled: false,
    expression: SAFE_DISABLED_RULE_EXPRESSION,
  }
}

export function findManagedDeployment(managedRuleset, rulesets) {
  if (managedRuleset?.kind !== RULESET_KIND.MANAGED) return null
  for (const ruleset of rulesets || []) {
    if (!rulesetIsEditable(ruleset) || ruleset.phase !== managedRuleset.phase) continue
    const rules = ruleset.rules || []
    const index = rules.findIndex(
      (rule) => rule.action === "execute"
        && rule.action_parameters?.id === managedRuleset.id,
    )
    if (index !== -1) {
      return {
        index,
        rule: rules[index],
        ruleset,
      }
    }
  }
  return null
}

function ruleSearchText(rule, index) {
  return [
    rulesetRuleLabel(rule, index),
    rule?.action,
    ruleActionLabel(rule?.action),
    rule?.expression,
    JSON.stringify(rule?.action_parameters || {}),
    ...(rule?.categories || []),
  ].join(" ").toLowerCase()
}

export function filterRulesetRules(rules, options = {}) {
  const query = String(options.query || "").trim().toLowerCase()
  const status = options.status || "all"
  return (rules || []).filter((rule, index) => {
    if (status === "enabled" && rule.enabled === false) return false
    if (status === "disabled" && rule.enabled !== false) return false
    return !query || ruleSearchText(rule, index).includes(query)
  })
}

export function rulesetRulePage(rules, options = {}) {
  const filtered = filterRulesetRules(rules, options)
  const limit = Number.isInteger(options.limit) && options.limit > 0
    ? options.limit
    : RULESET_RULE_PAGE_SIZE
  return {
    filteredCount: filtered.length,
    hasMore: filtered.length > limit,
    totalCount: (rules || []).length,
    visible: filtered.slice(0, limit),
  }
}
