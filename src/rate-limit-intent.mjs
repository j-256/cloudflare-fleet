import {
  MATRIX_CATEGORY,
  RULESET_KIND,
  WAF_PHASE,
} from "./constants.mjs"
import {
  normalizeValue,
  shortDisplay,
  stableString,
} from "./normalize.mjs"
import { editableRulePayload } from "./policies.mjs"

export const HOSTNAME_SCOPED_RATE_LIMIT_CATEGORY = MATRIX_CATEGORY.RATE_LIMITING
export const HOSTNAME_SCOPED_RATE_LIMIT_KEY = "hostname-scoped-free-rate-limit"
export const HOSTNAME_SCOPED_RATE_LIMIT_LABEL = "Hostname-scoped Free rate limit"
export const HOSTNAME_SCOPED_RATE_LIMIT_KIND = "hostname-scoped-free-rate-limit"
export const RATE_LIMIT_PHASE = "http_ratelimit"
export const RATE_LIMIT_REQUIRED_SURFACE_IDS = Object.freeze(["rulesets"])
export const RATE_LIMIT_REQUIRED_RULE_PHASES = Object.freeze([
  WAF_PHASE,
  RATE_LIMIT_PHASE,
])

const EXPECTED_POLICY_ORIGINS = new Set(["authored", "observed"])
const RATE_CHARACTERISTICS = Object.freeze(["cf.colo.id", "ip.src"])
const RATE_PERIOD_SECONDS = 10
const RATE_LIMIT_WAF_CUSTOM_RULE_COST = 1
const HOST_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
const RATE_RULE_PORTABLE_FIELDS = new Set([
  "action",
  "action_parameters",
  "description",
  "enabled",
  "expression",
  "ratelimit",
  "ref",
])
const SKIP_RULE_PORTABLE_FIELDS = new Set([
  "action",
  "action_parameters",
  "description",
  "enabled",
  "expression",
  "logging",
  "ref",
])
const RATE_EXPRESSION_FIELDS = new Set([
  "cf.bot_management.verified_bot",
  "http.request.uri.path",
])

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function hasExactKeys(value, expected) {
  return isObject(value)
    && stableString(Object.keys(value).sort()) === stableString([...expected].sort())
}

function normalizedHostTemplate(value) {
  if (typeof value !== "string") return ""
  const normalized = value.trim().toLowerCase().replace(/\.$/, "")
  if (!normalized || normalized.includes(":")) return ""
  const tokens = normalized.split(".")
  const zoneIndexes = tokens
    .map((token, index) => token === "{zone}" ? index : -1)
    .filter((index) => index >= 0)
  if (zoneIndexes.length > 1) return ""
  if (zoneIndexes.length === 1 && zoneIndexes[0] !== tokens.length - 1) return ""
  const labels = zoneIndexes.length === 1 ? tokens.slice(0, -1) : tokens
  if (zoneIndexes.length === 0 && labels.length < 2) return ""
  if (labels.some((label) => !HOST_LABEL_PATTERN.test(label))) return ""
  return normalized
}

export function normalizeRateLimitHosts(hosts) {
  if (!Array.isArray(hosts)) throw new TypeError("Rate-limit hosts must be an array")
  const normalized = hosts.map(normalizedHostTemplate)
  if (normalized.some((host) => !host)) {
    throw new TypeError("Rate-limit hosts must be lowercase DNS names or templates ending in {zone}")
  }
  return [...new Set(normalized)].sort((left, right) => left.localeCompare(right))
}

export function buildRateLimitSkipExpression(hosts) {
  const normalized = normalizeRateLimitHosts(hosts)
  if (normalized.length === 0) {
    throw new TypeError("At least one hostname is required for a scoped rate limit")
  }
  const exact = normalized.flatMap((host) => [`\"${host}\"`, `\"${host}.\"`])
  const ports = normalized.flatMap((host) => [
    `starts_with(lower(http.host), \"${host}:\")`,
    `starts_with(lower(http.host), \"${host}.:\")`,
  ])
  return `not (lower(http.host) in {${exact.join(" ")}} or ${ports.join(" or ")})`
}

function quotedStrings(value) {
  const matches = value.match(/"(?:\\.|[^"\\])*"/g) || []
  try {
    return matches.map((entry) => JSON.parse(entry))
  } catch {
    return []
  }
}

export function rateLimitHostsFromSkipExpression(expression) {
  if (typeof expression !== "string") return null
  const simple = /^http\.host ne "([a-z0-9.{}-]+)"$/.exec(expression)
  if (simple) {
    const host = normalizedHostTemplate(simple[1])
    return host ? [host] : null
  }
  const prefix = "not (lower(http.host) in {"
  const separator = "} or starts_with"
  if (!expression.startsWith(prefix)) return null
  const separatorIndex = expression.indexOf(separator, prefix.length)
  if (separatorIndex < 0) return null
  const values = quotedStrings(expression.slice(prefix.length, separatorIndex))
  if (values.length === 0 || values.length % 2 !== 0) return null
  const hosts = []
  for (let index = 0; index < values.length; index += 2) {
    const host = normalizedHostTemplate(values[index])
    if (!host || values[index + 1] !== `${host}.`) return null
    hosts.push(host)
  }
  let normalized
  try {
    normalized = normalizeRateLimitHosts(hosts)
  } catch {
    return null
  }
  return buildRateLimitSkipExpression(normalized) === expression
    ? normalized
    : null
}

function portableRuleIsValid(rule, fields) {
  return isObject(rule)
    && Object.keys(rule).every((key) => fields.has(key))
    && typeof rule.description === "string"
    && rule.description.trim().length > 0
    && typeof rule.expression === "string"
    && rule.expression.trim().length > 0
    && (rule.ref === undefined
      || (typeof rule.ref === "string" && rule.ref.length > 0))
}

function rateExpressionIsFreeCompatible(expression) {
  const withoutStrings = expression.replace(/"(?:\\.|[^"\\])*"/g, "")
  const fields = withoutStrings.match(
    /\b[a-zA-Z][a-zA-Z0-9_]*(?:\.[a-zA-Z0-9_]+)+\b/g,
  ) || []
  return fields.every((field) => RATE_EXPRESSION_FIELDS.has(field))
}

function rateRuleIsValid(rule) {
  if (!portableRuleIsValid(rule, RATE_RULE_PORTABLE_FIELDS)
    || rule.action !== "block"
    || rule.enabled !== true
    || !rateExpressionIsFreeCompatible(rule.expression)
    || (rule.action_parameters !== undefined && !isObject(rule.action_parameters))
    || !hasExactKeys(rule.ratelimit, [
      "characteristics",
      "mitigation_timeout",
      "period",
      "requests_per_period",
    ])) return false
  const characteristics = rule.ratelimit.characteristics
  return Array.isArray(characteristics)
    && stableString(characteristics) === stableString(RATE_CHARACTERISTICS)
    && rule.ratelimit.period === RATE_PERIOD_SECONDS
    && rule.ratelimit.mitigation_timeout === RATE_PERIOD_SECONDS
    && Number.isSafeInteger(rule.ratelimit.requests_per_period)
    && rule.ratelimit.requests_per_period > 0
}

function skipRuleIsValid(rule, hosts) {
  return portableRuleIsValid(rule, SKIP_RULE_PORTABLE_FIELDS)
    && rule.action === "skip"
    && rule.enabled === true
    && hasExactKeys(rule.action_parameters, ["phases"])
    && stableString(rule.action_parameters.phases) === stableString([RATE_LIMIT_PHASE])
    && (rule.logging === undefined
      || (hasExactKeys(rule.logging, ["enabled"])
        && rule.logging.enabled === false))
    && rule.expression === buildRateLimitSkipExpression(hosts)
}

function valueIsEmpty(value) {
  return value.hosts.length === 0
    && value.rateRules.length === 0
    && value.skipRules.length === 0
}

export function isHostnameScopedFreeRateLimitIntentValue(value) {
  if (!hasExactKeys(value, ["hosts", "kind", "rateRules", "skipRules"])
    || value.kind !== HOSTNAME_SCOPED_RATE_LIMIT_KIND
    || !Array.isArray(value.hosts)
    || !Array.isArray(value.rateRules)
    || !Array.isArray(value.skipRules)) return false
  let hosts
  try {
    hosts = normalizeRateLimitHosts(value.hosts)
  } catch {
    return false
  }
  if (stableString(hosts) !== stableString(value.hosts)) return false
  if (valueIsEmpty(value)) return true
  return hosts.length > 0
    && value.rateRules.length === 1
    && value.skipRules.length === 1
    && rateRuleIsValid(value.rateRules[0])
    && skipRuleIsValid(value.skipRules[0], hosts)
}

export function createHostnameScopedFreeRateLimitIntentValue(options = {}) {
  if (options.enabled === false) {
    return {
      hosts: [],
      kind: HOSTNAME_SCOPED_RATE_LIMIT_KIND,
      rateRules: [],
      skipRules: [],
    }
  }
  const hosts = normalizeRateLimitHosts(options.hosts)
  const rateDescription = String(options.rateDescription || "").trim()
  const skipDescription = String(options.skipDescription || "").trim()
  const rateExpression = String(options.rateExpression || "").trim()
  const requestsPerPeriod = Number(options.requestsPerPeriod)
  const rateRule = {
    action: "block",
    ...(options.actionParameters === undefined
      ? {}
      : { action_parameters: structuredClone(options.actionParameters) }),
    description: rateDescription,
    enabled: true,
    expression: rateExpression,
    ratelimit: {
      characteristics: [...RATE_CHARACTERISTICS],
      mitigation_timeout: RATE_PERIOD_SECONDS,
      period: RATE_PERIOD_SECONDS,
      requests_per_period: requestsPerPeriod,
    },
  }
  const skipRule = {
    action: "skip",
    action_parameters: { phases: [RATE_LIMIT_PHASE] },
    description: skipDescription,
    enabled: true,
    expression: buildRateLimitSkipExpression(hosts),
    logging: { enabled: false },
  }
  const value = {
    hosts,
    kind: HOSTNAME_SCOPED_RATE_LIMIT_KIND,
    rateRules: [rateRule],
    skipRules: [skipRule],
  }
  if (!isHostnameScopedFreeRateLimitIntentValue(value)) {
    throw new TypeError("Hostname-scoped Free rate-limit intent is invalid")
  }
  return value
}

export function hostnameScopedFreeRateLimitMatrixFacet() {
  return {
    category: HOSTNAME_SCOPED_RATE_LIMIT_CATEGORY,
    description: "One Free-plan-compatible rate rule paired with the custom WAF skip that confines it to selected hosts",
    key: HOSTNAME_SCOPED_RATE_LIMIT_KEY,
    label: HOSTNAME_SCOPED_RATE_LIMIT_LABEL,
  }
}

export function isHostnameScopedFreeRateLimitFacet(facet) {
  return facet?.category === HOSTNAME_SCOPED_RATE_LIMIT_CATEGORY
    && facet?.key === HOSTNAME_SCOPED_RATE_LIMIT_KEY
}

export function isHostnameScopedFreeRateLimitMatrixRow(row) {
  return isHostnameScopedFreeRateLimitFacet(row)
}

function normalizedRule(rule, zoneName, phase) {
  const normalized = normalizeValue(editableRulePayload(rule), zoneName, {
    preserveOrder: true,
  })
  if (phase === RATE_LIMIT_PHASE
    && Array.isArray(normalized.ratelimit?.characteristics)) {
    normalized.ratelimit.characteristics = [
      ...normalized.ratelimit.characteristics,
    ].sort((left, right) => left.localeCompare(right))
  }
  return normalized
}

function ruleIdentity(rule) {
  return `${rule.ref || ""}\u0000${rule.description || ""}\u0000${stableString(rule)}`
}

function sortedRules(entries) {
  return entries
    .map((entry) => entry.normalized)
    .sort((left, right) => ruleIdentity(left).localeCompare(ruleIdentity(right)))
}

function phaseRuleEntries(zone, phase, predicate = () => true) {
  const entries = []
  for (const detail of zone.ruleDetails || []) {
    if (!detail.ok) continue
    const ruleset = detail.result
    if (ruleset.phase !== phase || ruleset.kind !== RULESET_KIND.ZONE) continue
    for (const rule of ruleset.rules || []) {
      if (!predicate(rule)) continue
      entries.push({
        action: {
          phase,
          ruleId: rule.id,
          rulesetId: ruleset.id,
          type: "ruleset-rule",
          zoneId: zone.meta.id,
        },
        normalized: normalizedRule(rule, zone.meta.name, phase),
        rule: structuredClone(rule),
        ruleset: {
          id: ruleset.id,
          kind: ruleset.kind,
          name: ruleset.name,
          phase: ruleset.phase,
        },
      })
    }
  }
  return entries.sort((left, right) => (
    ruleIdentity(left.normalized).localeCompare(ruleIdentity(right.normalized))
  ))
}

function skipsRateLimit(rule) {
  return rule.action === "skip"
    && Array.isArray(rule.action_parameters?.phases)
    && rule.action_parameters.phases.includes(RATE_LIMIT_PHASE)
}

function canonicalizeSkipRule(rule) {
  const hosts = rateLimitHostsFromSkipExpression(rule.expression)
  return hosts
    ? { ...rule, expression: buildRateLimitSkipExpression(hosts) }
    : rule
}

export function observeHostnameScopedFreeRateLimitIntent(zone) {
  const rateEntries = phaseRuleEntries(zone, RATE_LIMIT_PHASE)
  const skipEntries = phaseRuleEntries(zone, WAF_PHASE, skipsRateLimit)
    .map((entry) => ({
      ...entry,
      normalized: canonicalizeSkipRule(entry.normalized),
    }))
  const rateRules = sortedRules(rateEntries)
  const skipRules = sortedRules(skipEntries)
  const hosts = skipRules.length === 1
    ? rateLimitHostsFromSkipExpression(skipRules[0].expression) || []
    : []
  const value = {
    hosts,
    kind: HOSTNAME_SCOPED_RATE_LIMIT_KIND,
    rateRules,
    skipRules,
  }
  const healthy = isHostnameScopedFreeRateLimitIntentValue(value)
  const display = valueIsEmpty(value)
    ? "Unused"
    : healthy
      ? `${rateRules[0].ratelimit.requests_per_period} requests / 10s on ${hosts.join(", ")}`
      : `${rateRules.length} rate rules / ${skipRules.length} host-scope skips`
  return {
    action: {
      observedValue: structuredClone(value),
      rateEntries: structuredClone(rateEntries),
      skipEntries: structuredClone(skipEntries),
      type: HOSTNAME_SCOPED_RATE_LIMIT_KIND,
      zoneId: zone.meta.id,
    },
    display,
    inspectionValue: {
      ...structuredClone(value),
      rateRuleIds: rateEntries.map((entry) => entry.action.ruleId),
      skipRuleIds: skipEntries.map((entry) => entry.action.ruleId),
    },
    value,
  }
}

export function normalizeHostnameScopedFreeRateLimitIntentPolicy(policy) {
  if (!isHostnameScopedFreeRateLimitFacet(policy?.facet) || !policy?.expected) return policy
  const normalized = structuredClone(policy)
  const value = normalized.expected.value
  if (isObject(value) && Array.isArray(value.hosts)) {
    try {
      value.hosts = normalizeRateLimitHosts(value.hosts)
    } catch {}
  }
  if (isObject(value) && Array.isArray(value.skipRules)) {
    value.skipRules = value.skipRules.map(canonicalizeSkipRule)
  }
  const canonical = stableString(value)
  normalized.expected.canonical = canonical
  normalized.expected.display = isHostnameScopedFreeRateLimitIntentValue(value)
    ? valueIsEmpty(value)
      ? "Unused"
      : `${value.rateRules[0].ratelimit.requests_per_period} requests / 10s on ${value.hosts.join(", ")}`
    : shortDisplay(value)
  normalized.expected.resolutionCanonical = null
  return normalized
}

export function hostnameScopedFreeRateLimitIntentPolicyIsValid(policy) {
  if (!isHostnameScopedFreeRateLimitFacet(policy?.facet)) return true
  const expectedOrigin = policy.expected?.origin ?? "observed"
  return policy.presenceConstraint === "required"
    && (policy.valueConstraint === undefined || policy.valueConstraint === "exact")
    && EXPECTED_POLICY_ORIGINS.has(expectedOrigin)
    && isHostnameScopedFreeRateLimitIntentValue(policy.expected?.value)
    && policy.expected.canonical === stableString(policy.expected.value)
    && policy.expected.resolutionCanonical === null
}

export function describeHostnameScopedFreeRateLimitPolicy() {
  return {
    facet: hostnameScopedFreeRateLimitMatrixFacet(),
    freePlanLimits: {
      action: "block",
      characteristics: [...RATE_CHARACTERISTICS],
      mitigationTimeoutSeconds: RATE_PERIOD_SECONDS,
      periodSeconds: RATE_PERIOD_SECONDS,
      rulesPerZone: 1,
      ruleExpressionFields: ["Path", "Verified Bot"],
      wafCustomRulesConsumed: RATE_LIMIT_WAF_CUSTOM_RULE_COST,
    },
    relationship: {
      firstPhase: WAF_PHASE,
      ratePhase: RATE_LIMIT_PHASE,
      safety: "The custom WAF skip must exclude every host outside the intended set before the rate rule is enabled",
    },
    portability: {
      customResponse: "Fleet preserves an identical existing response but does not introduce one on Free; Cloudflare documents custom responses as Pro and above",
    },
    requiredConstraints: {
      presenceConstraint: "required",
      valueConstraint: "exact",
    },
    templates: [
      {
        id: "unused",
        value: createHostnameScopedFreeRateLimitIntentValue({ enabled: false }),
      },
      {
        id: "api-subdomain",
        value: createHostnameScopedFreeRateLimitIntentValue({
          hosts: ["api.{zone}"],
          rateDescription: "[fleet] Limit API requests by source",
          rateExpression: "starts_with(http.request.uri.path, \"/api/\")",
          requestsPerPeriod: 100,
          skipDescription: "[fleet] Skip API rate limit on other hosts",
        }),
      },
    ],
  }
}

export function hostnameScopedFreeRateLimitSearchValue(value) {
  return [
    ...value.hosts,
    ...value.rateRules.flatMap((rule) => [rule.description, rule.expression]),
    ...value.skipRules.flatMap((rule) => [rule.description, rule.expression]),
    MATRIX_CATEGORY.RULESET_RULES,
    RATE_LIMIT_PHASE,
    WAF_PHASE,
  ].join(" ")
}
