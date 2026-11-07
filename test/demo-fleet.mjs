import { makeInventory, makeZone, ok } from "./fixtures.mjs"
import { STATIC_LIMITATIONS, SURFACES, WAF_PHASE } from "../src/constants.mjs"
import {
  createAuthoredFleetIntentExpected,
  createEmptyFleetIntentDocument,
  FLEET_INTENT_ALL_ZONES_GROUP_ID,
  replaceFleetIntentAcknowledgement,
  replaceFleetIntentCoverageExpectation,
  replaceFleetIntentGroup,
  replaceFleetIntentPolicy,
} from "../src/fleet-intent.mjs"
import { staticCoverageIssues } from "../src/inventory.mjs"
import { buildMatrix } from "../src/matrix.mjs"
import { materializeValue } from "../src/normalize.mjs"
import { createHostnameScopedFreeRateLimitIntentValue, RATE_LIMIT_PHASE } from "../src/rate-limit-intent.mjs"
import { buildZoneAliasRedirectRule, createZoneAliasIntentValue, zoneAliasMatrixFacet, ZONE_ALIAS_REDIRECT_PHASE } from "../src/zone-alias-intent.mjs"

const ACCOUNT_ID = "e2e-account"
const FREE_EDGE_CACHE_TTL_SECONDS = 7200
export const DEMO_ZONE = Object.freeze({ PRIMARY: "harbor.example", DRIFT: "harbor-app.example", EXCEPTION: "archive.example" })
const ROLE = Object.freeze({ WEB: "web", APP: "application", ALIAS: "compatibility redirect", MAIL: "mail" })
const ZONES = Object.freeze([
  [DEMO_ZONE.PRIMARY, ROLE.WEB],
  [DEMO_ZONE.DRIFT, ROLE.APP],
  ["harbor-api.example", ROLE.APP],
  ["harbor-docs.example", ROLE.WEB],
  ["orbit.example", ROLE.WEB],
  ["orbit-app.example", ROLE.APP],
  ["orbit-api.example", ROLE.APP],
  ["orbit-status.example", ROLE.WEB],
  ["kiln.example", ROLE.WEB],
  ["service-integration-and-preview.example", ROLE.APP],
  ["kiln-docs.example", ROLE.WEB],
  ["legacy-harbor.example", ROLE.ALIAS],
  ["harbor-compat.example", ROLE.ALIAS],
  ["orbit-compat.example", ROLE.ALIAS],
  ["inbox.example", ROLE.MAIL],
  [DEMO_ZONE.EXCEPTION, ROLE.MAIL],
])
const SETTINGS = Object.freeze({
  "0rtt": "off", advanced_ddos: "on", always_online: "off", always_use_https: "on",
  automatic_https_rewrites: "on", brotli: "on", browser_cache_ttl: 14400, browser_check: "on",
  cache_level: "aggressive", challenge_ttl: 1800, ciphers: [], cname_flattening: "flatten_at_root",
  development_mode: 0, early_hints: "on", ech: "on", edge_cache_ttl: FREE_EDGE_CACHE_TTL_SECONDS,
  email_obfuscation: "on", filter_logs_to_cloudflare: "off", hotlink_protection: "off",
  http2: "on", http3: "on", ip_geolocation: "on", ipv6: "on", log_to_cloudflare: "on",
  long_lived_grpc: "on", max_upload: 100, min_tls_version: "1.2",
  minify: { css: "on", html: "on", js: "off" }, mirage: "off",
  mobile_redirect: { status: "off", mobile_subdomain: "m", strip_uri: false },
  opportunistic_encryption: "on", opportunistic_onion: "on", orange_to_orange: "off",
  origin_error_page_pass_thru: "off", polish: "off", pq_keyex: "on", prefetch_preload: "off",
  privacy_pass: "on", proxy_read_timeout: 100, pseudo_ipv4: "off", replace_insecure_js: "off",
  response_buffering: "off", rocket_loader: "off",
  security_header: { strict_transport_security: { enabled: true, max_age: 15552000, include_subdomains: true, nosniff: true, preload: false } },
  security_level: "medium", server_side_exclude: "off", sort_query_string_for_cache: "off",
  ssl: "strict", tls_1_2_only: "off", tls_1_3: "on", tls_client_auth: "off",
  true_client_ip_header: "off", visitor_ip: "on", waf: "on", webp: "off", websockets: "on",
})
const READ_ONLY_SETTINGS = new Set(["advanced_ddos", "filter_logs_to_cloudflare", "mirage", "orange_to_orange", "polish", "prefetch_preload", "proxy_read_timeout", "response_buffering", "sort_query_string_for_cache", "true_client_ip_header", "webp"])
const BASELINE = Object.freeze({ always_use_https: "on", min_tls_version: "1.2", tls_1_3: "on", automatic_https_rewrites: "on", ipv6: "on", ssl: "strict" })
const ALIAS_TARGET = Object.freeze({ "legacy-harbor.example": DEMO_ZONE.PRIMARY, "harbor-compat.example": DEMO_ZONE.PRIMARY, "orbit-compat.example": "orbit.example" })

function roleSettings(role) {
  return {
    browser_cache_ttl: role === ROLE.APP ? 120 : role === ROLE.MAIL ? 0 : 14400,
    security_level: role === ROLE.APP ? "high" : "medium",
    min_tls_version: role === ROLE.APP ? "1.3" : "1.2",
    ...(role === ROLE.MAIL ? { ssl: "off", http3: "off" } : {}),
  }
}

function zoneSettings(name, role, index) {
  const values = { ...structuredClone(SETTINGS), ...roleSettings(role) }
  if (name === DEMO_ZONE.DRIFT || name === DEMO_ZONE.EXCEPTION) values.always_use_https = "off"
  if (index === 2) values.min_tls_version = "1.0"
  if (index === 3) values.tls_1_3 = "off"
  if (index === 4) values.automatic_https_rewrites = "off"
  if (index === 5) values.ssl = "flexible"
  if (index === 6) values.ipv6 = "off"
  if (index === 7) values.browser_cache_ttl = 86400
  if (index === 8) values.security_level = "essentially_off"
  if (index % 3 === 0) values.early_hints = "off"
  if (index % 4 === 0) values.http3 = "off"
  if (role === ROLE.APP) values.cache_level = "bypass"
  if (index === 9) values.security_header.strict_transport_security.include_subdomains = false
  return Object.entries(values).map(([id, value]) => ({ id, value, editable: !READ_ONLY_SETTINGS.has(id) }))
}

function dnsRecords(name, role, index) {
  if (role === ROLE.ALIAS) return [
    { id: `apex-${name}`, type: "A", name, content: "255.255.255.255", ttl: 1, proxied: true },
    { id: `wildcard-${name}`, type: "A", name: `*.${name}`, content: "255.255.255.255", ttl: 1, proxied: true },
  ]
  const records = [
    { type: "A", name, content: `192.0.2.${index + 10}`, ttl: 1, proxied: role !== ROLE.MAIL },
    { type: "CNAME", name: `www.${name}`, content: name, ttl: 1, proxied: true },
    { type: "TXT", name, content: index % 3 ? "v=spf1 include:_spf.example.net -all" : "v=spf1 include:_spf.secondary.example.net ~all", ttl: 300 },
    { type: "TXT", name: `_dmarc.${name}`, content: `v=DMARC1; p=${index % 4 ? "reject" : "none"}; rua=mailto:reports@${name}`, ttl: 3600 },
    { type: "MX", name, content: "mx1.mail.example.net", priority: 10, ttl: 300 },
    { type: "MX", name, content: "mx2.mail.example.net", priority: 20, ttl: 300 },
    { type: "CAA", name, content: '0 issue "ca.example.net"', ttl: 3600 },
  ]
  if (index % 2 === 0) records.push({ type: "AAAA", name, content: `2001:db8::${index + 1}`, ttl: 1, proxied: true })
  if (role === ROLE.WEB) records.push({ type: "CNAME", name: `docs.${name}`, content: index % 3 ? "documentation.example.net" : "documentation-preview.example.net", ttl: 300, proxied: false })
  if (role === ROLE.APP) records.push(
    { type: "CNAME", name: `api.${name}`, content: `origin-${index}.example.net`, ttl: 1, proxied: true },
    { type: "TXT", name: `_verification.${name}`, content: `synthetic-project-verification-${index}-for-development-and-preview-environments`, ttl: 3600 },
  )
  return records.map((record, offset) => ({ id: `dns-${index}-${offset}`, ...record }))
}

function ruleset(name, phase, rules) {
  return { id: `${phase}-${name}`, kind: "zone", name: `Demo ${phase}`, phase, rules: rules.map((rule, index) => ({ id: `rule-${phase}-${index}-${name}`, ref: `demo-${phase}-${index}`, enabled: true, ...rule })) }
}

function redirectRule(description, expression, host, statusCode = 307) {
  return {
    description, expression, action: "redirect",
    action_parameters: { from_value: { status_code: statusCode, target_url: { expression: `concat("https://${host}", http.request.uri.path)` }, preserve_query_string: true } },
  }
}

function zoneRules(name, role, index) {
  const custom = [
    { description: "Protect service", action: "block", expression: `http.host eq "service.${name}"`, enabled: name !== DEMO_ZONE.DRIFT },
    { description: "Protect administration", action: index % 4 ? "managed_challenge" : "block", expression: '(http.request.uri.path contains "/admin")' },
  ]
  const result = []
  if (role === ROLE.ALIAS) {
    const value = createZoneAliasIntentValue({ targetHost: ALIAS_TARGET[name], statusCode: index === 11 ? 302 : 307 })
    result.push(ruleset(name, ZONE_ALIAS_REDIRECT_PHASE, [buildZoneAliasRedirectRule(name, value)]))
  } else if (role === ROLE.WEB || role === ROLE.APP) {
    const redirects = [
      redirectRule("Canonical www host", `http.host eq "www.${name}"`, name, 308),
      redirectRule("Documentation host", `http.host eq "docs.${name}"`, "documentation.example.net"),
    ]
    if (role === ROLE.WEB) redirects.push(
      redirectRule("Legacy help paths", 'starts_with(http.request.uri.path, "/help/")', "support.example.net", 308),
      redirectRule("Retired download paths", 'starts_with(http.request.uri.path, "/downloads/")', "archive.example.net"),
    )
    result.push(ruleset(name, ZONE_ALIAS_REDIRECT_PHASE, redirects))
  }
  if (role === ROLE.APP) {
    const value = materializeValue(createHostnameScopedFreeRateLimitIntentValue({
      hosts: [`api.${name}`], rateDescription: "API request budget", skipDescription: "Skip API rate limit on other hosts",
      rateExpression: 'starts_with(http.request.uri.path, "/api/")', requestsPerPeriod: index === 2 ? 100 : 60,
    }), name)
    custom.push(...value.skipRules)
    result.push(ruleset(name, RATE_LIMIT_PHASE, value.rateRules))
  }
  result.push(ruleset(name, WAF_PHASE, custom))
  if (role === ROLE.WEB) result.push(
    ruleset(name, "http_request_cache_settings", [{ description: "Cache public assets", action: "set_cache_settings", expression: 'starts_with(http.request.uri.path, "/assets/")', action_parameters: { cache: true, edge_ttl: { mode: "override_origin", default: FREE_EDGE_CACHE_TTL_SECONDS * (index % 2 ? 1 : 2) } } }]),
    ruleset(name, "http_response_headers_transform", [{ description: "Mark public responses", action: "rewrite", expression: "true", action_parameters: { headers: { "x-demo-service": { operation: "set", value: `web-${index}` } } } }]),
  )
  return result
}

function demoZone([name, role], index) {
  const ruleDetails = zoneRules(name, role, index)
  const zone = makeZone(name, {
    dns: dnsRecords(name, role, index), settings: zoneSettings(name, role, index),
    email: { enabled: role !== ROLE.ALIAS, status: name === DEMO_ZONE.DRIFT ? "misconfigured" : role === ROLE.ALIAS ? "disabled" : "unlocked", support_subaddress: index % 3 !== 0 },
    destination: role === ROLE.MAIL ? "archive@mail.example.net" : "team@mail.example.net",
    emailRules: [{ id: `mail-${index}`, name: "Team mail", enabled: true, matchers: [{ type: "literal", field: "to", value: `team@${name}` }], actions: [{ type: "forward", value: [index % 2 ? "support@mail.example.net" : "team@mail.example.net"] }] }],
    workerRoutes: role === ROLE.APP ? [{ id: `worker-route-${index}`, pattern: `api.${name}/*`, script: "example-worker" }] : [],
    rulesets: ruleDetails.map(({ id, kind, name: label, phase }) => ({ id, kind, name: label, phase })),
    ruleDetails: ruleDetails.map(ok),
  })
  for (const surface of SURFACES) if (!zone.surfaces[surface.id]) zone.surfaces[surface.id] = ok(surface.id === "dnssec" ? { status: index % 3 ? "active" : "disabled" } : [])
  if (index === 10) zone.surfaces.healthchecks = { ok: false, result: [], status: 403, error: { status: 403, message: "Simulated token lacks Health Checks read access" } }
  if (index === 15) zone.surfaces["workers-routes"] = { ok: false, result: [], status: 503, error: { status: 503, message: "Simulated Worker route read temporarily unavailable" } }
  return zone
}

function expectedFromCell(row, zone) {
  const cell = row.cells.get(zone.meta.name)
  return {
    canonical: cell.intentCanonical, display: cell.display, origin: "observed",
    resolutionCanonical: cell.resolutionCanonical, sourceZoneId: zone.meta.id, sourceZoneName: zone.meta.name,
    value: structuredClone(cell.intentValue ?? cell.inspectionValue),
  }
}

function demoIntent(inventory) {
  const matrix = buildMatrix(inventory)
  let intent = createEmptyFleetIntentDocument(inventory.account.id)
  function addPolicy(id, row, groupId, options = {}) {
    if (!row) throw new Error(`Demo policy ${id} requires an observed facet`)
    intent = replaceFleetIntentPolicy(intent, {
      id, groupId, facet: { category: row.category, key: row.key, label: row.label, ...(row.phase ? { phase: row.phase } : {}) },
      presenceConstraint: options.presence || "required", valueConstraint: options.constraint || "exact",
      expected: options.expected ?? null,
    })
  }
  const settingRow = (key) => matrix.rows.find((row) => row.category === "Zone settings" && row.key === key)
  for (const [id, value] of Object.entries(BASELINE)) addPolicy(`baseline-${id}`, settingRow(id), FLEET_INTENT_ALL_ZONES_GROUP_ID, { expected: createAuthoredFleetIntentExpected(value) })
  for (const key of ["browser_cache_ttl", "security_level"]) addPolicy(`varied-${key}`, settingRow(key), FLEET_INTENT_ALL_ZONES_GROUP_ID, { constraint: "may-differ" })
  const dnsRow = (label) => matrix.rows.find((row) => row.category === "DNS records" && row.label === label)
  for (const [index, zone] of inventory.zones.entries()) {
    const role = ZONES[index][1]
    const groupId = `demo-zone-${index}`
    intent = replaceFleetIntentGroup(intent, { id: groupId, name: `${zone.meta.name} / ${role}`, mode: "members", nameSource: "custom", members: [{ zoneId: zone.meta.id, zoneName: zone.meta.name }] })
    const dnsLabels = ["A @", ...(role === ROLE.ALIAS ? [] : ["TXT @"]), ...([ROLE.WEB, ROLE.APP].includes(role) ? ["CNAME www"] : [])]
    for (const [offset, label] of dnsLabels.entries()) addPolicy(`dns-${index}-${offset}`, dnsRow(label), groupId, { presence: "optional", constraint: "may-differ" })
    const settings = roleSettings(role)
    if (role === ROLE.APP) addPolicy(`setting-${index}-tls`, settingRow("min_tls_version"), groupId, { expected: createAuthoredFleetIntentExpected(settings.min_tls_version) })
    if (role === ROLE.MAIL) {
      addPolicy(`mail-${index}-ssl`, settingRow("ssl"), groupId, { expected: createAuthoredFleetIntentExpected("off") })
      addPolicy(`mail-${index}-no-www`, dnsRow("CNAME www"), groupId, { presence: "forbidden", constraint: "may-differ" })
    }
    if (role === ROLE.ALIAS) {
      const facet = zoneAliasMatrixFacet()
      const row = matrix.rows.find((entry) => entry.category === facet.category && entry.key === facet.key)
      addPolicy(`alias-${index}`, row, groupId, { expected: createAuthoredFleetIntentExpected(createZoneAliasIntentValue({ targetHost: ALIAS_TARGET[zone.meta.name], statusCode: 307 })) })
      addPolicy(`alias-${index}-no-docs`, matrix.rows.find((entry) => entry.category === "DNS records" && entry.label === "CNAME docs"), groupId, { presence: "forbidden", constraint: "may-differ" })
    }
    for (const [offset, row] of matrix.rows.filter((entry) => entry.category === "Redirects" && entry.cells.has(zone.meta.name)).entries()) addPolicy(`redirect-${index}-${offset}`, row, groupId, { expected: expectedFromCell(row, zone) })
    if (index < 6) {
      const row = matrix.rows.find((entry) => entry.category === "Ruleset rules" && entry.label === "Protect administration")
      addPolicy(`administration-${index}`, row, groupId, { expected: expectedFromCell(row, zone) })
    }
    if (role === ROLE.APP && index !== 9) {
      const row = matrix.rows.find((entry) => entry.category === "Rate limiting")
      const value = structuredClone(row.cells.get(zone.meta.name).intentValue)
      value.rateRules[0].ratelimit.requests_per_period = 60
      addPolicy(`rate-${index}`, row, groupId, { expected: createAuthoredFleetIntentExpected(value) })
    }
  }
  const protect = matrix.rows.find((row) => row.category === "Ruleset rules" && row.label === "Protect service")
  addPolicy("protect-service", protect, FLEET_INTENT_ALL_ZONES_GROUP_ID, { expected: expectedFromCell(protect, inventory.zones[0]) })
  for (const key of ["settings:enabled", "settings:status", "settings:support_subaddress"]) addPolicy(`email-${key.replace(":", "-")}`, matrix.rows.find((row) => row.category === "Email" && row.key === key), FLEET_INTENT_ALL_ZONES_GROUP_ID, { presence: "optional", constraint: "may-differ" })
  for (const key of ["paused", "status"]) {
    const row = matrix.rows.find((entry) => entry.category === "Zone" && entry.key === key)
    addPolicy(`zone-${key}`, row, FLEET_INTENT_ALL_ZONES_GROUP_ID, { expected: expectedFromCell(row, inventory.zones[0]) })
  }
  addPolicy("dnssec-availability", matrix.rows.find((row) => row.category === "DNSSEC"), FLEET_INTENT_ALL_ZONES_GROUP_ID, { presence: "optional", constraint: "may-differ" })
  intent = replaceFleetIntentAcknowledgement(intent, {
    id: "legacy-https-exception", policyId: "baseline-always_use_https", zoneId: `zone-${DEMO_ZONE.EXCEPTION}`, zoneName: DEMO_ZONE.EXCEPTION,
    observedCanonical: settingRow("always_use_https").cells.get(DEMO_ZONE.EXCEPTION).intentCanonical,
    reason: "Synthetic legacy mail domain retains HTTP during an explicitly reviewed migration", createdAt: inventory.loadedAt, updatedAt: inventory.loadedAt,
  })
  for (const [index, issue] of staticCoverageIssues(STATIC_LIMITATIONS).entries()) intent = replaceFleetIntentCoverageExpectation(intent, {
    ...issue, id: `expected-static-${index}`, reason: "Known demo API limitation recorded separately from unexpected read failures", createdAt: inventory.loadedAt, updatedAt: inventory.loadedAt,
  })
  return intent
}

export function createDemoFleet(options = {}) {
  const zones = ZONES.map(demoZone)
  const inventory = makeInventory(zones, {
    pagesProjects: [{ name: "harbor-docs", subdomain: "docs-host.example.net", domains: ["docs.harbor.example"], production_branch: "main" }],
    workerCustomDomains: [{ id: "demo-worker-domain", hostname: "edge.harbor.example", service: "example-worker", environment: "production", zone_id: zones[0].meta.id, zone_name: zones[0].meta.name }],
    emailAddresses: [{ email: "team@mail.example.net", verified: "2026-07-01T00:00:00Z" }, { email: "support@mail.example.net", verified: "2026-07-01T00:00:00Z" }, { email: "archive@mail.example.net", verified: null }],
  })
  inventory.account.id = ACCOUNT_ID
  inventory.loadedAt = options.loadedAt || new Date().toISOString()
  return { inventory, intent: demoIntent(inventory) }
}
