import {
  API_BASE_URL,
  HTTP_METHOD,
} from "../constants.mjs"

const API_BASE = new URL(API_BASE_URL)
const IDENTIFIER_PATTERN = /^[A-Za-z0-9_-]{1,128}$/
const PAGINATION_KEYS = new Set([
  "page",
  "per_page",
])
const READ_PATTERNS = Object.freeze([
  ["zones", "*", "settings"],
  ["zones", "*", "settings", "*"],
  ["zones", "*", "dns_records"],
  ["zones", "*", "dns_records", "*"],
  ["zones", "*", "dnssec"],
  ["zones", "*", "email", "routing"],
  ["zones", "*", "email", "routing", "dns"],
  ["zones", "*", "email", "routing", "rules"],
  ["zones", "*", "email", "routing", "rules", "*"],
  ["zones", "*", "rulesets"],
  ["zones", "*", "rulesets", "*"],
  ["zones", "*", "workers", "routes"],
  ["zones", "*", "firewall", "access_rules", "rules"],
  ["zones", "*", "filters"],
  ["zones", "*", "firewall", "rules"],
  ["zones", "*", "healthchecks"],
  ["zones", "*", "load_balancers"],
  ["zones", "*", "argo", "tiered_caching"],
  ["zones", "*", "cache", "tiered_cache_smart_topology_enable"],
  ["zones", "*", "bot_management"],
  ["zones", "*", "ssl", "universal", "settings"],
  ["zones", "*", "ssl", "certificate_packs"],
  ["zones", "*", "logpush", "jobs"],
  ["zones", "*", "waiting_rooms"],
  ["zones", "*", "web3", "hostnames"],
  ["zones", "*", "cache", "origin_post_quantum_encryption"],
  ["zones", "*", "snippets"],
])
const WRITE_PATTERNS = Object.freeze({
  [HTTP_METHOD.DELETE]: [
    ["zones", "*", "dns_records", "*"],
    ["zones", "*", "rulesets", "*"],
    ["zones", "*", "rulesets", "*", "rules", "*"],
  ],
  [HTTP_METHOD.PATCH]: [
    ["zones", "*", "settings", "*"],
    ["zones", "*", "dnssec"],
    ["zones", "*", "dns_records", "*"],
    ["zones", "*", "email", "routing"],
    ["zones", "*", "email", "routing", "dns"],
    ["zones", "*", "rulesets", "*", "rules", "*"],
  ],
  [HTTP_METHOD.POST]: [
    ["zones", "*", "dns_records"],
    ["zones", "*", "email", "routing", "dns"],
    ["zones", "*", "rulesets"],
    ["zones", "*", "rulesets", "*", "rules"],
  ],
  [HTTP_METHOD.PUT]: [
    ["zones", "*", "dns_records", "*"],
    ["zones", "*", "email", "routing", "rules", "*"],
    ["zones", "*", "rulesets", "*"],
  ],
})

function safeSegments(url) {
  if (url.origin !== API_BASE.origin || !url.pathname.startsWith(API_BASE.pathname)) {
    return null
  }
  const relativePath = url.pathname.slice(API_BASE.pathname.length)
  const encoded = relativePath.split("/").filter(Boolean)
  const segments = []
  for (const value of encoded) {
    let decoded
    try {
      decoded = decodeURIComponent(value)
    } catch {
      return null
    }
    if (!IDENTIFIER_PATTERN.test(decoded)) return null
    segments.push(decoded)
  }
  return segments
}

function patternMatches(segments, pattern) {
  return segments.length === pattern.length
    && pattern.every((expected, index) => (
      expected === "*" || expected === segments[index]
    ))
}

function matchesAny(segments, patterns) {
  return patterns.some((pattern) => patternMatches(segments, pattern))
}

function paginationIsSafe(searchParams) {
  for (const [key, value] of searchParams) {
    if (!PAGINATION_KEYS.has(key) || !/^[1-9][0-9]*$/.test(value)) return false
  }
  return true
}

function zoneListIsSafe(url, accountId) {
  const accountValues = url.searchParams.getAll("account.id")
  if (accountValues.length !== 1 || accountValues[0] !== accountId) return false
  for (const [key, value] of url.searchParams) {
    if (key === "account.id") continue
    if (!PAGINATION_KEYS.has(key) || !/^[1-9][0-9]*$/.test(value)) return false
  }
  return true
}

export function authorizeCloudflareRequest(method, url, accountId) {
  const segments = safeSegments(url)
  if (!segments) return { allowed: false, reason: "Cloudflare path is invalid" }
  if (method === HTTP_METHOD.GET) {
    if (segments.length === 1 && segments[0] === "zones") {
      return zoneListIsSafe(url, accountId)
        ? { allowed: true, zoneId: null }
        : { allowed: false, reason: "Zone listing is not scoped to the configured account" }
    }
    if (patternMatches(segments, ["accounts", "*", "email", "routing", "addresses"])) {
      if (segments[1] !== accountId) {
        return { allowed: false, reason: "Account path does not match the configured account" }
      }
      return paginationIsSafe(url.searchParams)
        ? { allowed: true, zoneId: null }
        : { allowed: false, reason: "Cloudflare query is not allowed" }
    }
    if (!matchesAny(segments, READ_PATTERNS)) {
      return { allowed: false, reason: "Cloudflare read path is not supported by Fleet" }
    }
    return paginationIsSafe(url.searchParams)
      ? { allowed: true, zoneId: segments[1] }
      : { allowed: false, reason: "Cloudflare query is not allowed" }
  }
  const patterns = WRITE_PATTERNS[method]
  if (!patterns || !matchesAny(segments, patterns)) {
    return { allowed: false, reason: "Cloudflare write path is not supported by Fleet" }
  }
  if ([...url.searchParams].length > 0) {
    return { allowed: false, reason: "Cloudflare write queries are not allowed" }
  }
  return {
    allowed: true,
    zoneId: segments[1],
  }
}
