export const API_BASE_URL = "https://api.cloudflare.com/client/v4/"
export const DEFAULT_CONCURRENCY = 32
export const DEFAULT_PAGE_SIZE = 100
export const ZONE_PAGE_SIZE = 50

export const HTTP_METHOD = Object.freeze({
  DELETE: "DELETE",
  GET: "GET",
  PATCH: "PATCH",
  POST: "POST",
  PUT: "PUT",
})

export const WAF_PHASE = "http_request_firewall_custom"

export const MATRIX_CATEGORY = Object.freeze({
  REDIRECTS: "Redirects",
  RULESET_RULES: "Ruleset rules",
})

export const EMAIL_ROUTING_ACTION_KIND = Object.freeze({
  RULE_EDIT: "email-routing-rule",
})

export const EMAIL_ROUTING_RULE_IDENTIFIER = Object.freeze({
  CATCH_ALL: "catch_all",
})

export const RULESET_KIND = Object.freeze({
  CUSTOM: "custom",
  MANAGED: "managed",
  ROOT: "root",
  ZONE: "zone",
})

export const RULESET_ACTION_KIND = Object.freeze({
  OPEN: "ruleset-open",
})

export const EMAIL_POLICY_COMPONENT = Object.freeze({
  SPF: "spf",
})

export const POLICY_EXCEPTION_KIND = Object.freeze({
  EMAIL_DNS_RECORD: "email-dns-record",
})

export const POLICY_EXCEPTION_STATUS = Object.freeze({
  ACTIVE: "active",
  ALIGNED: "aligned",
  UNAVAILABLE: "unavailable",
  VIOLATED: "violated",
})

export const HOLE_RESOLUTION_KIND = Object.freeze({
  DNS_RECORDS: "dns-record-copy",
  EMAIL_POLICY: "email-policy",
  RULESET_RULE: "ruleset-rule-copy",
})

export const FLEET_ACTION_KIND = Object.freeze({
  RULE_RENAME: "ruleset-rule-rename",
})

export const SESSION_TITLE = Object.freeze({
  READ_ONLY: "Cloudflare Fleet | Read-only",
  READ_WRITE: "Cloudflare Fleet | Read/write",
})

export const FLEET_WAF_RULE_DESCRIPTIONS = Object.freeze([
  "[fleet] cf-waf-deploy: anti-scanner block",
  "[fleet] Log All Others (Skip No-op)",
])

export const SURFACES = Object.freeze([
  {
    id: "settings",
    label: "Zone settings",
    path: (zoneId) => `zones/${zoneId}/settings`,
  },
  {
    id: "dns",
    label: "DNS records",
    path: (zoneId) => `zones/${zoneId}/dns_records?per_page=5000`,
  },
  {
    id: "dnssec",
    label: "DNSSEC",
    path: (zoneId) => `zones/${zoneId}/dnssec`,
  },
  {
    id: "email",
    label: "Email Routing",
    path: (zoneId) => `zones/${zoneId}/email/routing`,
  },
  {
    id: "email-dns",
    label: "Email Routing DNS",
    path: (zoneId) => `zones/${zoneId}/email/routing/dns`,
  },
  {
    id: "email-rules",
    label: "Email Routing rules",
    path: (zoneId) => `zones/${zoneId}/email/routing/rules?per_page=100`,
  },
  {
    id: "email-catch-all",
    label: "Email catch-all",
    path: (zoneId) => `zones/${zoneId}/email/routing/rules/catch_all`,
  },
  {
    id: "rulesets",
    label: "Rulesets",
    path: (zoneId) => `zones/${zoneId}/rulesets`,
  },
  {
    id: "workers-routes",
    label: "Workers routes",
    path: (zoneId) => `zones/${zoneId}/workers/routes`,
  },
  {
    id: "access-rules",
    label: "IP access rules",
    path: (zoneId) => `zones/${zoneId}/firewall/access_rules/rules?per_page=100`,
  },
  {
    id: "filters",
    label: "Legacy filters",
    path: (zoneId) => `zones/${zoneId}/filters?per_page=100`,
  },
  {
    id: "firewall-rules",
    label: "Legacy firewall rules",
    path: (zoneId) => `zones/${zoneId}/firewall/rules?per_page=100`,
  },
  {
    id: "healthchecks",
    label: "Health checks",
    path: (zoneId) => `zones/${zoneId}/healthchecks?per_page=100`,
  },
  {
    id: "load-balancers",
    label: "Load balancers",
    path: (zoneId) => `zones/${zoneId}/load_balancers?per_page=100`,
  },
  {
    id: "argo-tiered",
    label: "Tiered caching",
    path: (zoneId) => `zones/${zoneId}/argo/tiered_caching`,
  },
  {
    id: "smart-tiered",
    label: "Smart tiered caching",
    path: (zoneId) => `zones/${zoneId}/cache/tiered_cache_smart_topology_enable`,
  },
  {
    id: "bot-management",
    label: "Bot management",
    path: (zoneId) => `zones/${zoneId}/bot_management`,
  },
  {
    id: "universal-ssl",
    label: "Universal SSL",
    path: (zoneId) => `zones/${zoneId}/ssl/universal/settings`,
  },
  {
    id: "certificate-packs",
    label: "Certificate packs",
    path: (zoneId) => `zones/${zoneId}/ssl/certificate_packs?per_page=100`,
  },
  {
    id: "logpush",
    label: "Logpush jobs",
    path: (zoneId) => `zones/${zoneId}/logpush/jobs`,
  },
  {
    id: "waiting-rooms",
    label: "Waiting rooms",
    path: (zoneId) => `zones/${zoneId}/waiting_rooms?per_page=100`,
  },
  {
    id: "web3",
    label: "Web3 hostnames",
    path: (zoneId) => `zones/${zoneId}/web3/hostnames?per_page=100`,
  },
  {
    id: "origin-pq",
    label: "Origin post-quantum encryption",
    path: (zoneId) => `zones/${zoneId}/cache/origin_post_quantum_encryption`,
  },
  {
    id: "snippets",
    label: "Snippets",
    path: (zoneId) => `zones/${zoneId}/snippets`,
  },
])

export const STATIC_LIMITATIONS = Object.freeze([
  {
    label: "Legacy Page Rules",
    detail: "Cloudflare rejects this endpoint for account-owned tokens (API error 1011)",
  },
  {
    label: "Argo Smart Routing",
    detail: "The account token is not authorized to read the smart_routing setting (API error 1015)",
  },
  {
    label: "Spectrum applications",
    detail: "The plan or token rejects this surface with HTTP 403",
  },
  {
    label: "Custom hostnames",
    detail: "No SSL for SaaS quota is allocated to the fleet (API error 1404)",
  },
])
