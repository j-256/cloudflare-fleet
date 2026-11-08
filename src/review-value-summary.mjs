import { presentRedirect, REDIRECT_TARGET_KIND } from "./redirect-presentation.mjs"

export const VALUE_SUMMARY_LENGTH = 240
const SUMMARY_ENTRY_LIMIT = 3
const STRUCTURED_FIELD_LIMIT = 4

function words(value) {
  return value.replace(/([a-z])([A-Z])/g, "$1 $2").replaceAll("_", " ")
}

function counted(count, label) {
  return `${count} ${label}${count === 1 ? "" : "s"}`
}

function fields(value, prefix = "") {
  return Object.entries(value).flatMap(([key, entry]) => {
    const label = `${prefix}${words(key)}`
    return entry && typeof entry === "object" && !Array.isArray(entry)
      ? fields(entry, `${label} / `)
      : [`${label}: ${summarizeReviewValue(entry)}`]
  })
}

function aliasSummary(value) {
  const redirect = value.redirect
  const unread = value.unreadSurfaces || []
  const dnsUnread = unread.some((surface) => surface.scope === "zone" && surface.id === "dns")
  const rulesUnread = unread.some((surface) => surface.scope === "zone" && (surface.id === "rulesets" || surface.id.startsWith("rulesets:")))
  const parts = unread.length ? [counted(unread.length, "unread surface")] : []
  parts.push(redirect
    ? `${redirect.statusCode ?? "Unknown status"} to ${redirect.targetScheme && redirect.targetHost ? `${redirect.targetScheme}://${redirect.targetHost}` : "unknown target"}${redirect.enabled === false ? " (disabled)" : ""}`
    : rulesUnread ? "Canonical redirect unknown" : "No canonical redirect")
  if (redirect) {
    const scope = redirect.includeSubdomains === true ? "Apex + subdomains" : redirect.includeSubdomains === false ? "Apex only" : "Subdomain scope unknown"
    parts.push(`${scope}; ${["Path", "Query", "Subdomains"].map((name) => {
      const preserved = redirect[`preserve${name}`]
      return `${name.toLowerCase()} ${preserved === true ? "preserved" : preserved === false ? "not preserved" : "unknown"}`
    }).join(", ")}`)
  }
  if (value.servingDns) {
    const presence = (observed) => observed === true ? "present" : dnsUnread || observed !== false ? "unknown" : "missing"
    parts.push(`DNS: apex ${presence(value.servingDns.apex)}, wildcard ${presence(value.servingDns.wildcard)}`)
  }
  if (value.unexpectedResources?.length) parts.push(counted(value.unexpectedResources.length, "unexpected resource"))
  return parts.join("\n")
}

function rateSummary(value) {
  const rules = value.rateRules || []
  const limits = rules.slice(0, SUMMARY_ENTRY_LIMIT).map((rule) => `${rule.ratelimit?.requests_per_period ?? "?"} requests / ${rule.ratelimit?.period ?? "?"}s; ${rule.action}${rule.enabled === false ? " (disabled)" : ""}`)
  return [limits.join("; ") || "No rate rule", (value.hosts || []).join(", ") || "No host scope", `${counted(rules.length, "rate rule")}; ${counted((value.skipRules || []).length, "host-scope skip rule")}`].join("\n")
}

export function summarizeReviewValue(value) {
  let text
  if (value === undefined || value === null) text = "Not observed"
  else if (Array.isArray(value)) {
    text = value.length ? value.slice(0, SUMMARY_ENTRY_LIMIT).map(summarizeReviewValue).join("; ") : "None observed"
    if (value.length > SUMMARY_ENTRY_LIMIT) text += `; +${value.length - SUMMARY_ENTRY_LIMIT} more entries`
  } else if (typeof value === "object") {
    if (value.kind === "canonical-web-passthrough") text = aliasSummary(value)
    else if (value.kind === "hostname-scoped-free-rate-limit") text = rateSummary(value)
    else if (Object.hasOwn(value, "content")) text = `${value.type || ""} ${value.content}${typeof value.proxied === "boolean" ? value.proxied ? " (proxied)" : " (DNS only)" : ""}`.trim()
    else if (value.action === "redirect") {
      const redirect = presentRedirect(value)
      const target = redirect.targetKind === REDIRECT_TARGET_KIND.DYNAMIC
        ? "Dynamic target"
        : redirect.targetKind === REDIRECT_TARGET_KIND.STATIC
          ? redirect.target
          : `${redirect.targetKindLabel}: ${redirect.target}`
      text = `${redirect.statusCode ?? "Unknown status"} redirect${redirect.enabled ? "" : " (disabled)"}\n${target}; ${redirect.queryLabel.toLowerCase()}`
    }
    else if (value.expression) {
      text = `${words(value.action || "Rule")}: ${value.expression}${value.enabled === false ? " (disabled)" : ""}`
      if (value.action_parameters) text += `\n${summarizeReviewValue(value.action_parameters)}`
      if (value.ratelimit) text += `\n${value.ratelimit.requests_per_period} requests / ${value.ratelimit.period}s`
    } else {
      const entries = fields(value)
      text = entries.slice(0, STRUCTURED_FIELD_LIMIT).join("\n") || "No fields"
      if (entries.length > STRUCTURED_FIELD_LIMIT) text += `\n+${entries.length - STRUCTURED_FIELD_LIMIT} more fields`
    }
  } else text = String(value)
  return text.length > VALUE_SUMMARY_LENGTH ? `${text.slice(0, VALUE_SUMMARY_LENGTH - 1)}\u2026` : text
}
