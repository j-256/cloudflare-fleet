import {
  MATRIX_CATEGORY,
  RULESET_KIND,
} from "./constants.mjs"
import {
  shortDisplay,
  stableString,
} from "./normalize.mjs"

export const ZONE_ALIAS_CATEGORY = MATRIX_CATEGORY.ZONE_ALIASES
export const ZONE_ALIAS_KEY = "canonical-web-passthrough"
export const ZONE_ALIAS_LABEL = "Canonical web passthrough"
export const ZONE_ALIAS_INTENT_KIND = "canonical-web-passthrough"
export const ZONE_ALIAS_RESOURCE_ENVELOPE = "canonicalization-dns-mail-security-v1"
export const ZONE_ALIAS_REDIRECT_PHASE = "http_request_dynamic_redirect"

export const ZONE_ALIAS_REQUIRED_SURFACE_IDS = Object.freeze([
  "custom-hostnames",
  "dns",
  "healthchecks",
  "load-balancers",
  "rulesets",
  "snippets",
  "waiting-rooms",
  "web3",
  "workers-routes",
])

export const ZONE_ALIAS_REQUIRED_ACCOUNT_SURFACE_IDS = Object.freeze([
  "pages-projects",
  "worker-custom-domains",
])

const EXPECTED_POLICY_ORIGINS = new Set(["authored", "observed"])
const REDIRECT_STATUS_CODES = new Set([301, 302, 307, 308])
const WEB_DNS_RECORD_TYPES = new Set([
  "A",
  "AAAA",
  "CNAME",
  "HTTPS",
  "SVCB",
])
const MAIL_DNS_LABELS = new Set([
  "autoconfig",
  "autodiscover",
  "imap",
  "mail",
  "pop",
  "smtp",
])
const EDITABLE_RULESET_KINDS = new Set([
  RULESET_KIND.CUSTOM,
  RULESET_KIND.ZONE,
])
const SHARED_SECURITY_RULESET_PHASES = new Set([
  "ddos_l7",
  "http_config_settings",
  "http_ratelimit",
  "http_request_firewall_custom",
  "http_request_firewall_managed",
  "http_request_sanitize",
  "http_request_sbfm",
  "http_response_compression",
  "http_response_headers_transform",
])
export const ZONE_ALIAS_RESOURCE_REMEDIATION = Object.freeze({
  DELETE_DNS_RECORD: "delete-dns-record",
  DELETE_RULE: "delete-rule",
  UNSUPPORTED: "unsupported",
})
const TOP_LEVEL_KEYS = Object.freeze([
  "kind",
  "redirect",
  "resourceEnvelope",
  "servingDns",
  "unexpectedResources",
  "unreadSurfaces",
])
const REDIRECT_KEYS = Object.freeze([
  "enabled",
  "includeSubdomains",
  "preservePath",
  "preserveQuery",
  "preserveSubdomains",
  "statusCode",
  "targetHost",
  "targetScheme",
])
const SERVING_DNS_KEYS = Object.freeze([
  "apex",
  "wildcard",
])

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function hasExactKeys(value, keys) {
  if (!isObject(value)) return false
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index])
}

function normalizedHostname(value) {
  const hostname = String(value || "").trim().replace(/\.$/, "").toLowerCase()
  if (!hostname || hostname.includes("/") || hostname.includes(":")) return ""
  try {
    const parsed = new URL(`https://${hostname}`)
    return parsed.hostname === hostname ? hostname : ""
  } catch {
    return ""
  }
}

function normalizedDnsName(value, zoneName) {
  const name = String(value || "").trim().replace(/\.$/, "").toLowerCase()
  return name === "@" ? zoneName.toLowerCase() : name
}

function hostBelongsToZone(hostname, zoneName) {
  const host = normalizedHostname(hostname)
  const zone = normalizedHostname(zoneName)
  return Boolean(host && zone && (host === zone || host.endsWith(`.${zone}`)))
}

function normalizedExpression(value) {
  return String(value || "").replace(/\s+/g, " ").trim()
}

function expressionWithoutOuterParentheses(value) {
  const expression = normalizedExpression(value)
  return expression.startsWith("(") && expression.endsWith(")")
    ? expression.slice(1, -1).trim()
    : expression
}

function redirectSourceMatch(expression, sourceHost) {
  const source = normalizedHostname(sourceHost)
  const normalized = expressionWithoutOuterParentheses(expression)
  const apexExpressions = new Set([
    `http.host eq "${source}"`,
    `http.host wildcard "${source}"`,
  ])
  if (apexExpressions.has(normalized)) {
    return {
      includeSubdomains: false,
      matches: true,
    }
  }
  const parts = normalized.split(/\s+or\s+/i).map((entry) => entry.trim())
  const expected = new Set([
    `http.host wildcard "${source}"`,
    `http.host wildcard "*.${source}"`,
  ])
  return {
    includeSubdomains: parts.length === expected.size
      && parts.every((entry) => expected.has(entry)),
    matches: parts.length === expected.size
      && parts.every((entry) => expected.has(entry)),
  }
}

function parsedTargetUrl(value) {
  try {
    const url = new URL(value)
    return {
      host: normalizedHostname(url.hostname) || null,
      scheme: url.protocol.replace(/:$/, "") || null,
    }
  } catch {
    return {
      host: null,
      scheme: null,
    }
  }
}

function parseRedirectTarget(rule, sourceHost) {
  const target = rule?.action_parameters?.from_value?.target_url || {}
  if (typeof target.value === "string") {
    const parsed = parsedTargetUrl(target.value)
    return {
      preservePath: false,
      preserveSubdomains: false,
      targetHost: parsed.host,
      targetScheme: parsed.scheme,
    }
  }
  if (typeof target.expression !== "string") {
    return {
      preservePath: null,
      preserveSubdomains: null,
      targetHost: null,
      targetScheme: null,
    }
  }

  const compact = target.expression.replace(/\s+/g, "")
  const wildcard = compact.match(/^concat\("(https?):\/\/",wildcard_replace\(http\.host,"\*([^"]+)","\$\{1\}([^"]+)"\)(,http\.request\.uri\.path)?\)$/)
  if (wildcard && normalizedHostname(wildcard[2]) === normalizedHostname(sourceHost)) {
    return {
      preservePath: Boolean(wildcard[4]),
      preserveSubdomains: true,
      targetHost: normalizedHostname(wildcard[3]) || null,
      targetScheme: wildcard[1],
    }
  }

  const fixed = compact.match(/^concat\("(https?):\/\/([^"]+)"(,http\.request\.uri\.path)?\)$/)
  if (fixed) {
    return {
      preservePath: Boolean(fixed[3]),
      preserveSubdomains: false,
      targetHost: normalizedHostname(fixed[2]) || null,
      targetScheme: fixed[1],
    }
  }

  if (/^"[^"]+"$/.test(compact)) {
    const parsed = parsedTargetUrl(compact.slice(1, -1))
    return {
      preservePath: false,
      preserveSubdomains: false,
      targetHost: parsed.host,
      targetScheme: parsed.scheme,
    }
  }

  return {
    preservePath: null,
    preserveSubdomains: null,
    targetHost: null,
    targetScheme: null,
  }
}

function aliasRedirectSemantics(rule, sourceHost) {
  if (rule?.action !== "redirect") return null
  const source = redirectSourceMatch(rule.expression, sourceHost)
  if (!source.matches) return null
  const target = parseRedirectTarget(rule, sourceHost)
  const fromValue = rule.action_parameters?.from_value || {}
  return {
    enabled: rule.enabled !== false,
    includeSubdomains: source.includeSubdomains,
    preservePath: target.preservePath,
    preserveQuery: typeof fromValue.preserve_query_string === "boolean"
      ? fromValue.preserve_query_string
      : null,
    preserveSubdomains: target.preserveSubdomains,
    statusCode: Number.isInteger(fromValue.status_code)
      ? fromValue.status_code
      : null,
    targetHost: target.targetHost,
    targetScheme: target.targetScheme,
  }
}

function isExpectedRedirect(value) {
  if (!hasExactKeys(value, REDIRECT_KEYS)) return false
  const booleanKeys = [
    "enabled",
    "includeSubdomains",
    "preservePath",
    "preserveQuery",
    "preserveSubdomains",
  ]
  return booleanKeys.every((key) => typeof value[key] === "boolean")
    && value.enabled === true
    && REDIRECT_STATUS_CODES.has(value.statusCode)
    && normalizedHostname(value.targetHost) === value.targetHost
    && value.targetScheme === "https"
    && (!value.preserveSubdomains || value.includeSubdomains)
}

export function isZoneAliasIntentValue(value) {
  return hasExactKeys(value, TOP_LEVEL_KEYS)
    && value.kind === ZONE_ALIAS_INTENT_KIND
    && value.resourceEnvelope === ZONE_ALIAS_RESOURCE_ENVELOPE
    && isExpectedRedirect(value.redirect)
    && hasExactKeys(value.servingDns, SERVING_DNS_KEYS)
    && value.servingDns.apex === true
    && typeof value.servingDns.wildcard === "boolean"
    && Array.isArray(value.unexpectedResources)
    && value.unexpectedResources.length === 0
    && Array.isArray(value.unreadSurfaces)
    && value.unreadSurfaces.length === 0
}

export function createZoneAliasIntentValue(options) {
  const includeSubdomains = options?.includeSubdomains !== false
  const value = {
    kind: ZONE_ALIAS_INTENT_KIND,
    redirect: {
      enabled: true,
      includeSubdomains,
      preservePath: options?.preservePath !== false,
      preserveQuery: options?.preserveQuery !== false,
      preserveSubdomains: options?.preserveSubdomains ?? includeSubdomains,
      statusCode: options?.statusCode,
      targetHost: normalizedHostname(options?.targetHost),
      targetScheme: "https",
    },
    resourceEnvelope: ZONE_ALIAS_RESOURCE_ENVELOPE,
    servingDns: {
      apex: true,
      wildcard: options?.servingWildcard ?? includeSubdomains,
    },
    unexpectedResources: [],
    unreadSurfaces: [],
  }
  if (!isZoneAliasIntentValue(value)) {
    throw new TypeError("Canonical web passthrough intent is invalid")
  }
  return value
}

export function isZoneAliasFacet(facet) {
  return facet?.category === ZONE_ALIAS_CATEGORY
    && facet?.key === ZONE_ALIAS_KEY
}

export function normalizeZoneAliasIntentPolicy(policy) {
  if (!isZoneAliasFacet(policy?.facet) || !policy?.expected) return policy
  const normalized = structuredClone(policy)
  if (isObject(normalized.expected.value?.redirect)) {
    normalized.expected.value.redirect.targetHost = normalizedHostname(
      normalized.expected.value.redirect.targetHost,
    )
  }
  const canonical = stableString(normalized.expected.value)
  normalized.expected.canonical = canonical
  normalized.expected.display = isExpectedRedirect(normalized.expected.value?.redirect)
    ? `HTTP ${normalized.expected.value.redirect.statusCode} to ${normalized.expected.value.redirect.targetHost}`
    : shortDisplay(normalized.expected.value)
  normalized.expected.resolutionCanonical = null
  return normalized
}

export function zoneAliasIntentPolicyIsValid(policy) {
  if (!isZoneAliasFacet(policy?.facet)) return true
  const expectedOrigin = policy.expected?.origin ?? "observed"
  return policy.presenceConstraint === "required"
    && (policy.valueConstraint === undefined || policy.valueConstraint === "exact")
    && EXPECTED_POLICY_ORIGINS.has(expectedOrigin)
    && isZoneAliasIntentValue(policy.expected?.value)
    && policy.expected.canonical === stableString(policy.expected.value)
    && policy.expected.resolutionCanonical === null
}

function resource(options) {
  return {
    action: options.action || null,
    id: String(options.id || options.label),
    kind: options.kind,
    label: String(options.label || options.id),
    remediation: options.remediation || ZONE_ALIAS_RESOURCE_REMEDIATION.UNSUPPORTED,
    surface: options.surface,
  }
}

function intentResource(entry) {
  return {
    id: entry.id,
    kind: entry.kind,
    label: entry.label,
    remediation: entry.remediation,
    surface: entry.surface,
  }
}

function mailDnsHostnames(records, zoneName) {
  return new Set(records
    .filter((record) => String(record.type || "").toUpperCase() === "MX")
    .map((record) => normalizedDnsName(record.content, zoneName))
    .filter(Boolean))
}

function dnsNameIsMailOrControl(name, zoneName, mailHostnames) {
  const zone = normalizedHostname(zoneName)
  const relative = name === zone
    ? ""
    : name.endsWith(`.${zone}`)
      ? name.slice(0, -(zone.length + 1))
      : name
  const labels = relative.split(".").filter(Boolean)
  return mailHostnames.has(name)
    || labels.some((label) => label.startsWith("_"))
    || MAIL_DNS_LABELS.has(labels[0])
}

function collectionResult(zone, surfaceId) {
  const response = zone.surfaces?.[surfaceId]
  return response?.ok ? response.result : null
}

function accountCollectionResult(inventory, surfaceId) {
  const response = inventory.account?.surfaces?.[surfaceId]
  return response?.ok ? response.result : null
}

function collectionItems(value, collectionKey = null) {
  if (Array.isArray(value)) return value
  if (collectionKey && Array.isArray(value?.[collectionKey])) {
    return value[collectionKey]
  }
  return []
}

function addDnsEvidence(zone, servingDns, resources) {
  const records = collectionItems(collectionResult(zone, "dns"))
  const mailHostnames = mailDnsHostnames(records, zone.meta.name)
  for (const record of records) {
    const type = String(record.type || "").toUpperCase()
    if (!WEB_DNS_RECORD_TYPES.has(type)) continue
    const name = normalizedDnsName(record.name, zone.meta.name)
    const apex = name === normalizedHostname(zone.meta.name)
    const wildcard = name === `*.${normalizedHostname(zone.meta.name)}`
    if (record.proxied === true && (apex || wildcard)) {
      if (apex) servingDns.apex = true
      if (wildcard) servingDns.wildcard = true
      continue
    }
    if (record.proxied !== true
      && dnsNameIsMailOrControl(name, zone.meta.name, mailHostnames)) continue
    resources.push(resource({
      action: {
        recordId: record.id,
        type: "dns-record",
      },
      id: record.id || stableString({ name, type }),
      kind: "web-dns-record",
      label: `${type || "DNS"} ${name || "unnamed"}`,
      remediation: record.id
        ? ZONE_ALIAS_RESOURCE_REMEDIATION.DELETE_DNS_RECORD
        : ZONE_ALIAS_RESOURCE_REMEDIATION.UNSUPPORTED,
      surface: "dns",
    }))
  }
}

function ruleResource(rule, ruleset, kind) {
  const label = rule.description || rule.ref || rule.expression || rule.id || "Unnamed rule"
  return resource({
    action: {
      phase: ruleset.phase,
      ruleId: rule.id,
      rulesetId: ruleset.id,
      type: "ruleset-rule",
    },
    id: `${ruleset.id}:${rule.id || stableString(rule)}`,
    kind,
    label,
    remediation: rule.id
      ? ZONE_ALIAS_RESOURCE_REMEDIATION.DELETE_RULE
      : ZONE_ALIAS_RESOURCE_REMEDIATION.UNSUPPORTED,
    surface: "rulesets",
  })
}

function rulesetDetailById(zone) {
  return new Map((zone.ruleDetails || []).map((detail) => [
    detail.rulesetId || detail.result?.id,
    detail,
  ]).filter(([rulesetId]) => Boolean(rulesetId)))
}

function addRulesetEvidence(zone, resources, unreadSurfaces) {
  const summaries = collectionItems(collectionResult(zone, "rulesets"))
  const details = rulesetDetailById(zone)
  const candidates = []

  for (const summary of summaries) {
    if (summary.kind === RULESET_KIND.MANAGED) continue
    const phase = String(summary.phase || "")
    const editable = EDITABLE_RULESET_KINDS.has(summary.kind)
    const relevant = phase === ZONE_ALIAS_REDIRECT_PHASE
      || !SHARED_SECURITY_RULESET_PHASES.has(phase)
    if (!relevant) continue
    const detail = details.get(summary.id)
    if (editable && !detail?.ok) {
      unreadSurfaces.push({
        id: `rulesets:${summary.id}`,
        scope: "zone",
      })
      continue
    }
    if (!editable) {
      resources.push(resource({
        id: summary.id || stableString(summary),
        kind: phase === ZONE_ALIAS_REDIRECT_PHASE
          ? "redirect-ruleset"
          : "application-ruleset",
        label: summary.name || phase || "Unnamed ruleset",
        surface: "rulesets",
      }))
      continue
    }

    const ruleset = detail.result
    for (const rule of collectionItems(ruleset.rules)) {
      if (phase !== ZONE_ALIAS_REDIRECT_PHASE) {
        resources.push(ruleResource(rule, ruleset, "application-rule"))
        continue
      }
      const semantics = aliasRedirectSemantics(rule, zone.meta.name)
      if (!semantics) {
        resources.push(ruleResource(rule, ruleset, "redirect-rule"))
        continue
      }
      candidates.push({
        action: {
          phase,
          ruleId: rule.id,
          rulesetId: ruleset.id,
          type: "ruleset-rule",
        },
        rule,
        ruleset,
        semantics,
      })
    }
  }

  const canonical = candidates.shift() || null
  for (const candidate of candidates) {
    resources.push(ruleResource(
      candidate.rule,
      candidate.ruleset,
      "redirect-rule",
    ))
  }
  return canonical
}

function addZoneCollectionResources(zone, resources, definition) {
  const items = collectionItems(
    collectionResult(zone, definition.surface),
    definition.collectionKey,
  )
  for (const [index, item] of items.entries()) {
    const label = definition.label(item, index)
    resources.push(resource({
      id: item.id || item.name || item.hostname || label,
      kind: definition.kind,
      label,
      surface: definition.surface,
    }))
  }
}

function addAccountEvidence(inventory, zone, resources) {
  const workerDomains = collectionItems(
    accountCollectionResult(inventory, "worker-custom-domains"),
  )
  for (const domain of workerDomains) {
    if (domain.zone_id !== zone.meta.id
      && !hostBelongsToZone(domain.hostname, zone.meta.name)) continue
    resources.push(resource({
      id: domain.id || domain.hostname,
      kind: "worker-custom-domain",
      label: domain.hostname || domain.id || "Unnamed Workers custom domain",
      surface: "worker-custom-domains",
    }))
  }

  const projects = collectionItems(
    accountCollectionResult(inventory, "pages-projects"),
  )
  for (const project of projects) {
    for (const domain of collectionItems(project.domains)) {
      if (!hostBelongsToZone(domain, zone.meta.name)) continue
      resources.push(resource({
        id: `${project.name || project.id || "pages"}:${domain}`,
        kind: "pages-domain",
        label: `${domain} on ${project.name || project.id || "Pages"}`,
        surface: "pages-projects",
      }))
    }
  }
}

function unreadAliasSurfaces(inventory, zone) {
  const unread = ZONE_ALIAS_REQUIRED_SURFACE_IDS.flatMap((surfaceId) => (
    zone.surfaces?.[surfaceId]?.ok
      ? []
      : [{ id: surfaceId, scope: "zone" }]
  ))
  for (const surfaceId of ZONE_ALIAS_REQUIRED_ACCOUNT_SURFACE_IDS) {
    if (!inventory.account?.surfaces?.[surfaceId]?.ok) {
      unread.push({ id: surfaceId, scope: "account" })
    }
  }
  return unread
}

export function observeZoneAliasIntent(inventory, zone) {
  const resources = []
  const unreadSurfaces = unreadAliasSurfaces(inventory, zone)
  const servingDns = {
    apex: false,
    wildcard: false,
  }
  addDnsEvidence(zone, servingDns, resources)
  const canonicalRule = addRulesetEvidence(zone, resources, unreadSurfaces)

  const collectionDefinitions = [
    {
      kind: "worker-route",
      label: (item) => item.pattern || item.id || "Unnamed Worker route",
      surface: "workers-routes",
    },
    {
      kind: "ssl-for-saas-custom-hostname",
      label: (item) => item.hostname || item.id || "Unnamed custom hostname",
      surface: "custom-hostnames",
    },
    {
      kind: "health-check",
      label: (item) => item.name || item.address || item.id || "Unnamed health check",
      surface: "healthchecks",
    },
    {
      kind: "load-balancer",
      label: (item) => item.name || item.hostname || item.id || "Unnamed load balancer",
      surface: "load-balancers",
    },
    {
      kind: "waiting-room",
      label: (item) => item.name || item.host || item.id || "Unnamed waiting room",
      surface: "waiting-rooms",
    },
    {
      kind: "web3-hostname",
      label: (item) => item.name || item.hostname || item.id || "Unnamed Web3 hostname",
      surface: "web3",
    },
    {
      collectionKey: "snippets",
      kind: "snippet",
      label: (item) => item.snippet_name || item.name || item.id || "Unnamed snippet",
      surface: "snippets",
    },
  ]
  for (const definition of collectionDefinitions) {
    addZoneCollectionResources(zone, resources, definition)
  }
  addAccountEvidence(inventory, zone, resources)

  resources.sort((left, right) => (
    left.surface.localeCompare(right.surface)
      || left.kind.localeCompare(right.kind)
      || left.id.localeCompare(right.id)
  ))
  unreadSurfaces.sort((left, right) => (
    left.scope.localeCompare(right.scope) || left.id.localeCompare(right.id)
  ))

  const value = {
    kind: ZONE_ALIAS_INTENT_KIND,
    redirect: canonicalRule?.semantics || null,
    resourceEnvelope: ZONE_ALIAS_RESOURCE_ENVELOPE,
    servingDns,
    unexpectedResources: resources.map(intentResource),
    unreadSurfaces,
  }
  return {
    action: {
      canonicalRule: canonicalRule
        ? {
            ...canonicalRule.action,
            rule: structuredClone(canonicalRule.rule),
          }
        : null,
      resources: structuredClone(resources),
      observedValue: structuredClone(value),
      type: "zone-alias",
      zoneId: zone.meta.id,
    },
    display: canonicalRule?.semantics?.targetHost
      ? `HTTP ${canonicalRule.semantics.statusCode || "?"} to ${canonicalRule.semantics.targetHost}`
      : "Canonical redirect missing",
    inspectionValue: {
      ...structuredClone(value),
      canonicalRule: canonicalRule
        ? {
            ruleId: canonicalRule.action.ruleId,
            rulesetId: canonicalRule.action.rulesetId,
          }
        : null,
    },
    value,
  }
}

export function buildZoneAliasRedirectRule(sourceHost, desiredValue) {
  if (!isZoneAliasIntentValue(desiredValue)) {
    throw new TypeError("Canonical web passthrough intent is invalid")
  }
  const source = normalizedHostname(sourceHost)
  if (!source) throw new TypeError("Canonical web passthrough source host is invalid")
  const redirect = desiredValue.redirect
  const expression = redirect.includeSubdomains
    ? `(http.host wildcard "${source}" or http.host wildcard "*.${source}")`
    : `http.host eq "${source}"`
  let targetUrl
  if (redirect.preserveSubdomains) {
    const path = redirect.preservePath ? ", http.request.uri.path" : ""
    targetUrl = {
      expression: `concat("${redirect.targetScheme}://", wildcard_replace(http.host, "*${source}", "\${1}${redirect.targetHost}")${path})`,
    }
  } else if (redirect.preservePath) {
    targetUrl = {
      expression: `concat("${redirect.targetScheme}://${redirect.targetHost}", http.request.uri.path)`,
    }
  } else {
    targetUrl = {
      value: `${redirect.targetScheme}://${redirect.targetHost}`,
    }
  }
  return {
    action: "redirect",
    action_parameters: {
      from_value: {
        preserve_query_string: redirect.preserveQuery,
        status_code: redirect.statusCode,
        target_url: targetUrl,
      },
    },
    description: `[fleet] Canonical alias to ${redirect.targetHost}`,
    enabled: redirect.enabled,
    expression,
    ref: "fleet-canonical-web-passthrough",
  }
}

export function zoneAliasMatrixFacet() {
  return {
    category: ZONE_ALIAS_CATEGORY,
    description: "One canonical redirect plus only serving DNS, mail, and shared security resources",
    key: ZONE_ALIAS_KEY,
    label: ZONE_ALIAS_LABEL,
  }
}

export function isZoneAliasMatrixRow(row) {
  return row?.category === ZONE_ALIAS_CATEGORY && row?.key === ZONE_ALIAS_KEY
}

export function zoneAliasPolicyTemplates() {
  return [
    {
      id: "j256-dev",
      sourceHost: "j256.dev",
      value: createZoneAliasIntentValue({
        statusCode: 307,
        targetHost: "j-256.dev",
      }),
    },
    {
      id: "strangelaser-com",
      sourceHost: "strangelaser.com",
      value: createZoneAliasIntentValue({
        statusCode: 308,
        targetHost: "strangelasers.com",
      }),
    },
    {
      id: "strangelasers-net",
      sourceHost: "strangelasers.net",
      value: createZoneAliasIntentValue({
        statusCode: 307,
        targetHost: "strangelasers.com",
      }),
    },
  ]
}

export function zoneAliasPolicyTemplateForSourceHost(sourceHost) {
  const normalized = normalizedHostname(sourceHost)
  const template = zoneAliasPolicyTemplates().find(
    (candidate) => candidate.sourceHost === normalized,
  )
  return template ? structuredClone(template) : null
}

export function describeZoneAliasPolicy() {
  return {
    allowedResources: [
      "Proxied apex and wildcard DNS used to receive redirect traffic",
      "Mail, ownership-verification, DNSSEC, and security DNS",
      "One canonical dynamic redirect",
      "Cloudflare-managed and shared security rulesets",
      "Ordinary TLS, settings, DNSSEC, and email security posture",
    ],
    facet: zoneAliasMatrixFacet(),
    limitations: [
      "Legacy Page Rules remain an explicit coverage limitation because Cloudflare rejects that endpoint for account-owned tokens",
    ],
    requiredConstraints: {
      presenceConstraint: "required",
      valueConstraint: "exact",
    },
    resourceEnvelope: ZONE_ALIAS_RESOURCE_ENVELOPE,
    templates: zoneAliasPolicyTemplates(),
    unexpectedResources: [
      "Additional redirect or application rules",
      "Additional or unproxied web-serving DNS",
      "Worker routes and custom domains",
      "Pages domains and SSL for SaaS custom hostnames",
      "Load balancers, health checks, waiting rooms, Web3 hostnames, and snippets",
    ],
  }
}
