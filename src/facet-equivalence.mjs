import {
  MATRIX_CATEGORY,
  RULESET_KIND,
  matrixCategoryLabel,
} from "./constants.mjs"
import {
  normalizeValue,
  stableString,
} from "./normalize.mjs"
import { rulePhaseLabel } from "./rule-presentation.mjs"
import { editableRulePayload } from "./policies.mjs"
import {
  HOSTNAME_SCOPED_RATE_LIMIT_CATEGORY,
} from "./rate-limit-intent.mjs"

const DNS_RECORD_CATEGORY = "DNS records"
const DNSSEC_CATEGORY = "DNSSEC"
const EMAIL_DNS_SPECIFICATION_CATEGORY = "Email DNS specification"
const EMAIL_ROUTE_CATEGORY = "Email routes"
const ZONE_SETTING_CATEGORY = "Zone settings"
const RULE_CATEGORIES = new Set([
  MATRIX_CATEGORY.REDIRECTS,
  MATRIX_CATEGORY.RULESET_RULES,
])
const RULESET_EXACT_NORMALIZATION_OPTIONS = Object.freeze({
  preserveOrder: true,
})
export const FACET_COMPARISON_ACCESS_KIND = Object.freeze({
  DIRECT: "direct",
  INSPECT: "inspect",
  NONE: "none",
  WORKSPACE: "workspace",
})
const EDITABLE_RULESET_KINDS = new Set([
  RULESET_KIND.CUSTOM,
  RULESET_KIND.ZONE,
])

export function ruleExactComparisonValue(rule, zoneName) {
  return normalizeValue(
    editableRulePayload(rule || {}),
    zoneName,
    RULESET_EXACT_NORMALIZATION_OPTIONS,
  )
}

export function redirectIntentValueProjection(value) {
  const source = value
    && typeof value === "object"
    && !Array.isArray(value)
    && value.rule
    && typeof value.rule === "object"
    && !Array.isArray(value.rule)
    ? value.rule
    : value
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    return source
  }
  const projected = structuredClone(source)
  delete projected.description
  delete projected.ref
  return projected
}

export function redirectIntentComparisonValue(rule, zoneName) {
  return redirectIntentValueProjection(
    ruleExactComparisonValue(rule, zoneName),
  )
}

export function canonicalComparisonValue(canonical) {
  try {
    return JSON.parse(canonical)
  } catch {
    return canonical
  }
}

export function facetCellComparisonValue(cell) {
  return canonicalComparisonValue(cell?.intentCanonical ?? cell?.canonical ?? "null")
}

export function facetExpectedComparisonValue(expected) {
  return canonicalComparisonValue(expected?.canonical ?? "null")
}

export function facetValuesDiffer(left, right) {
  return stableString(left) !== stableString(right)
}

function phaseFromFacetKey(facet) {
  const category = String(facet?.category || "")
  const key = String(facet?.key || "")
  if (RULE_CATEGORIES.has(category)) return key.split(":", 1)[0]
  return ""
}

export function facetPhase(facet) {
  return String(facet?.phase || phaseFromFacetKey(facet)).trim()
}

function facetIdentitySummary(facet, phaseLabel) {
  const category = String(facet?.category || "")
  const key = String(facet?.key || "")
  if (category === MATRIX_CATEGORY.ZONE_ALIASES) {
    return "Zone aliases / canonical passthrough"
  }
  if (category === HOSTNAME_SCOPED_RATE_LIMIT_CATEGORY) {
    return "Rate limiting / rate rule and host-scope WAF skip"
  }
  if (category === MATRIX_CATEGORY.REDIRECTS) {
    return `Redirects / ${phaseLabel} / normalized match / occurrence`
  }
  if (category === MATRIX_CATEGORY.RULESET_RULES) {
    return `Ruleset rules / ${phaseLabel} / normalized rule name`
  }
  if (category === DNS_RECORD_CATEGORY || category === EMAIL_DNS_SPECIFICATION_CATEGORY) {
    return `${matrixCategoryLabel(category)} / record type / normalized owner`
  }
  if (category === EMAIL_ROUTE_CATEGORY) {
    return "Email routes / normalized matcher"
  }
  return `${matrixCategoryLabel(category)} / facet key`
}

function facetEquivalenceSummary(facet) {
  const category = String(facet?.category || "")
  if (category === MATRIX_CATEGORY.ZONE_ALIASES) {
    return "Canonical redirect behavior, serving DNS presence, and an exact empty accumulation envelope"
  }
  if (category === HOSTNAME_SCOPED_RATE_LIMIT_CATEGORY) {
    return "Selected hosts, the Free-compatible rate rule, and every custom WAF skip targeting the rate phase"
  }
  if (category === MATRIX_CATEGORY.REDIRECTS) {
    return "Behavioral rule fields"
  }
  if (category === MATRIX_CATEGORY.RULESET_RULES) {
    return "Editable rule fields"
  }
  if (category === ZONE_SETTING_CATEGORY) {
    return "Normalized setting value"
  }
  if (category === DNSSEC_CATEGORY) {
    return "Requested DNSSEC status"
  }
  if (category === DNS_RECORD_CATEGORY || category === EMAIL_DNS_SPECIFICATION_CATEGORY) {
    return "Compared record properties"
  }
  return "Complete normalized compared value"
}

function facetNormalizationSummary(facet) {
  const category = String(facet?.category || "")
  if (category === MATRIX_CATEGORY.ZONE_ALIASES) {
    return "Hostnames are lowercased; zone names are not substituted"
  }
  if (category === HOSTNAME_SCOPED_RATE_LIMIT_CATEGORY) {
    return "Hosts are lowercased; zone domain becomes {zone}; equivalent one-host skips use the canonical complement expression"
  }
  if (RULE_CATEGORIES.has(category)) {
    return "Zone domain becomes {zone}; array order counts"
  }
  return "Zone domain becomes {zone}"
}

function facetIgnoredSummary(facet) {
  const category = String(facet?.category || "")
  if (category === MATRIX_CATEGORY.ZONE_ALIASES) {
    return "Allowed non-web DNS, mail, DNSSEC, TLS, settings, shared security resources, and serving-record identifiers"
  }
  if (category === HOSTNAME_SCOPED_RATE_LIMIT_CATEGORY) {
    return "Rule IDs, timestamps, versions, generated refs, and custom WAF rules that do not skip rate limiting"
  }
  if (category === MATRIX_CATEGORY.REDIRECTS) {
    return "Absolute position, description, explicit ref, IDs, timestamps, versions, unsupported API fields"
  }
  if (category === MATRIX_CATEGORY.RULESET_RULES) {
    return "Rule IDs, timestamps, versions, generated refs, unsupported API fields"
  }
  if (category === ZONE_SETTING_CATEGORY) return "Editability metadata"
  if (category === DNSSEC_CATEGORY) return "Generated keys and transitions"
  return "Fields absent from the compared value"
}

export function describeFacetEquivalence(facet) {
  const phase = facetPhase(facet)
  const phaseLabel = phase ? rulePhaseLabel(phase) : "phase"
  return {
    categoryLabel: matrixCategoryLabel(String(facet?.category || "")),
    equivalenceSummary: facetEquivalenceSummary(facet),
    identitySummary: facetIdentitySummary(facet, phaseLabel),
    ignoredSummary: facetIgnoredSummary(facet),
    key: String(facet?.key || ""),
    normalizationSummary: facetNormalizationSummary(facet),
    phase,
    phaseLabel: phase ? phaseLabel : "",
    titleSource: String(facet?.labelSource || "Facet definition"),
  }
}

function rulesetActionIsEditable(action) {
  return EDITABLE_RULESET_KINDS.has(action?.kind)
}

export function describeFacetComparisonAccess(facet, cell) {
  if (!cell) {
    return {
      kind: FACET_COMPARISON_ACCESS_KIND.NONE,
      reason: "This zone has no current value to edit",
      secondaryKind: null,
    }
  }

  const category = String(facet?.category || "")
  const workspaceAction = cell.parentAction
  const editableWorkspace = rulesetActionIsEditable(workspaceAction)
  if (cell.action) {
    const hasOrderEditor = category === MATRIX_CATEGORY.REDIRECTS
      && editableWorkspace
    return {
      kind: FACET_COMPARISON_ACCESS_KIND.DIRECT,
      reason: hasOrderEditor
        ? "Edit rule fields directly. Edit order in the parent ruleset."
        : cell.capability?.kind === "direct-edit" && cell.capability.reason
          ? cell.capability.reason
          : "All compared fields are directly editable.",
      secondaryKind: hasOrderEditor
        ? FACET_COMPARISON_ACCESS_KIND.WORKSPACE
        : null,
    }
  }

  if (editableWorkspace) {
    return {
      kind: FACET_COMPARISON_ACCESS_KIND.WORKSPACE,
      reason: "Edit compared rule fields in the parent ruleset workspace.",
      secondaryKind: null,
    }
  }

  if (workspaceAction) {
    return {
      kind: FACET_COMPARISON_ACCESS_KIND.INSPECT,
      reason: workspaceAction.kind === RULESET_KIND.MANAGED
        ? "Managed ruleset: compared fields are read-only."
        : "This ruleset has no zone-level editor.",
      secondaryKind: null,
    }
  }

  if (cell.capability?.kind === "not-directly-editable") {
    return {
      kind: FACET_COMPARISON_ACCESS_KIND.NONE,
      reason: cell.capability.reason || cell.capability.label,
      secondaryKind: null,
    }
  }

  if (category === DNSSEC_CATEGORY) {
    return {
      kind: FACET_COMPARISON_ACCESS_KIND.NONE,
      reason: "Change DNSSEC status through exact fleet intent.",
      secondaryKind: null,
    }
  }

  return {
    kind: FACET_COMPARISON_ACCESS_KIND.NONE,
    reason: "No editor is registered for this inventory surface.",
    secondaryKind: null,
  }
}
