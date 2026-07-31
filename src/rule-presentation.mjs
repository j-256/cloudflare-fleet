import { humanizeValueField } from "./value-editor.mjs"

const RULE_ACTION_LABELS = Object.freeze({
  block: "Block",
  challenge: "Challenge",
  compress_response: "Compress response",
  ddos_dynamic: "DDoS dynamic",
  execute: "Execute ruleset",
  force_connection_close: "Close connection",
  js_challenge: "JavaScript challenge",
  log: "Log",
  managed_challenge: "Managed challenge",
  redirect: "Redirect",
  rewrite: "Rewrite",
  route: "Route",
  score: "Score",
  set_cache_settings: "Set cache settings",
  set_config: "Set configuration",
  skip: "Skip",
})

const RULE_PHASE_LABELS = Object.freeze({
  ddos_l7: "DDoS L7",
  http_config_settings: "Configuration settings",
  http_ratelimit: "Rate limiting",
  http_request_cache_settings: "Cache settings",
  http_request_dynamic_redirect: "Dynamic redirects",
  http_request_firewall_custom: "Custom firewall",
  http_request_firewall_managed: "Managed firewall",
  http_request_late_transform: "Late request transforms",
  http_request_origin: "Origin rules",
  http_request_sanitize: "Request sanitization",
  http_request_transform: "Request transforms",
  http_response_compression: "Response compression",
  http_response_firewall_managed: "Managed response firewall",
  http_response_headers_transform: "Response header transforms",
})

const PRIMARY_RULE_FIELDS = new Set([
  "action",
  "description",
  "enabled",
  "expression",
  "ref",
])

const RULE_SECTION_FIELDS = Object.freeze([
  "action_parameters",
  "logging",
  "ratelimit",
  "exposed_credential_check",
])

export function humanizeRuleField(field) {
  return humanizeValueField(field)
}

export function ruleActionLabel(action) {
  const normalized = String(action || "").trim()
  return RULE_ACTION_LABELS[normalized] || humanizeRuleField(normalized || "unknown action")
}

export function rulePhaseLabel(phase) {
  const normalized = String(phase || "").trim()
  return RULE_PHASE_LABELS[normalized] || humanizeRuleField(normalized || "unknown phase")
}

export function presentRule(rule, phase = "") {
  const definition = rule && typeof rule === "object" && !Array.isArray(rule)
    ? rule
    : {}
  const fields = [
    {
      key: "description",
      label: "Name",
      value: definition.description || "Unnamed rule",
    },
    {
      key: "enabled",
      label: "Status",
      value: definition.enabled === false ? "Disabled" : "Enabled",
    },
    {
      key: "action",
      label: "Action",
      token: definition.action || "",
      value: ruleActionLabel(definition.action),
    },
  ]
  if (phase) {
    fields.push({
      key: "phase",
      label: "Phase",
      token: phase,
      value: rulePhaseLabel(phase),
    })
  }
  if (definition.expression !== undefined) {
    fields.push({
      key: "expression",
      kind: "code",
      label: "Matching expression",
      value: definition.expression,
    })
  }
  if (definition.ref) {
    fields.push({
      key: "ref",
      kind: "code",
      label: "Reference",
      value: definition.ref,
    })
  }

  const sections = []
  for (const key of RULE_SECTION_FIELDS) {
    if (definition[key] === undefined || definition[key] === null) continue
    sections.push({
      key,
      label: humanizeRuleField(key),
      value: definition[key],
    })
  }

  const additional = Object.fromEntries(
    Object.entries(definition).filter(
      ([key]) => !PRIMARY_RULE_FIELDS.has(key) && !RULE_SECTION_FIELDS.includes(key),
    ),
  )
  if (Object.keys(additional).length > 0) {
    sections.push({
      key: "additional",
      label: "Additional fields",
      value: additional,
    })
  }

  return {
    fields,
    sections,
  }
}
