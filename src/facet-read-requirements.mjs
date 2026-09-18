import { facetPhase } from "./facet-equivalence.mjs"
import { RATE_LIMIT_REQUIRED_RULE_PHASES, RATE_LIMIT_REQUIRED_SURFACE_IDS } from "./rate-limit-intent.mjs"
import { ZONE_ALIAS_REQUIRED_ACCOUNT_SURFACE_IDS, ZONE_ALIAS_REQUIRED_SURFACE_IDS } from "./zone-alias-intent.mjs"

const CATEGORY_SURFACES = Object.freeze({
  Zone: [], "Zone settings": ["settings"], "DNS records": ["dns", "email-dns"], DNSSEC: ["dnssec"],
  Email: ["email", "email-catch-all"], "Email routes": ["email-rules"], "Email DNS specification": ["email-dns", "dns"],
  Rulesets: ["rulesets"], "Ruleset rules": ["rulesets"], Redirects: ["rulesets"],
  "Rate limiting": RATE_LIMIT_REQUIRED_SURFACE_IDS, "Zone aliases": ZONE_ALIAS_REQUIRED_SURFACE_IDS,
  "Workers routes": ["workers-routes"], "Legacy firewall view": ["firewall-rules"], "IP access rules": ["access-rules"],
  "Health checks": ["healthchecks"], "Load balancers": ["load-balancers"], "Logpush jobs": ["logpush"], "Waiting rooms": ["waiting-rooms"],
  "Web3 hostnames": ["web3"], Performance: ["argo-tiered", "smart-tiered"], Security: ["bot-management"],
  TLS: ["universal-ssl", "origin-pq"], Snippets: ["snippets"], "TLS inventory": ["certificate-packs"],
})
const EDITABLE_RULESET_KINDS = Object.freeze(["zone", "custom"])

export function facetReadRequirement(query) {
  if (!Object.hasOwn(CATEGORY_SURFACES, query.category)) throw new TypeError(`Unsupported facet category: ${query.category}`)
  if (query.phase && !["Rulesets", "Ruleset rules", "Redirects"].includes(query.category)) throw new TypeError("phase requires a Rulesets, Ruleset rules or Redirects category")
  const keyPhase = query.key ? facetPhase({ ...query, phase: undefined }) : null
  if (query.phase && keyPhase && keyPhase !== query.phase) throw new TypeError("Facet phase does not match its key")
  const phase = query.phase || (query.key ? facetPhase(query) : null)
  const requirement = {
    surfaceIds: CATEGORY_SURFACES[query.category], accountSurfaceIds: [], includeEmailAddresses: false,
    includeRuleDetails: ["Rulesets", "Ruleset rules", "Redirects", "Rate limiting", "Zone aliases"].includes(query.category),
    ruleDetailKinds: EDITABLE_RULESET_KINDS,
    ...(phase ? { ruleDetailPhases: [phase] } : {}),
  }
  if (query.category === "Zone aliases") requirement.accountSurfaceIds = ZONE_ALIAS_REQUIRED_ACCOUNT_SURFACE_IDS
  if (query.category === "Rate limiting") {
    requirement.ruleDetailPhases = RATE_LIMIT_REQUIRED_RULE_PHASES
    requirement.ruleDetailKinds = ["zone"]
  }
  if (query.category === "Email" && query.key) requirement.surfaceIds = query.key === "catch-all" ? ["email-catch-all"] : ["email"]
  if (["Performance", "TLS"].includes(query.category) && requirement.surfaceIds.includes(query.key)) requirement.surfaceIds = [query.key]
  return requirement
}

