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

const DNS_RECORD_CATEGORY = "DNS records"
const DNSSEC_CATEGORY = "DNSSEC"
const EMAIL_DNS_SPECIFICATION_CATEGORY = "Email DNS specification"
const EMAIL_ROUTE_CATEGORY = "Email routes"
const RULESET_CATEGORY = "Rulesets"
const ZONE_SETTING_CATEGORY = "Zone settings"
const MANAGED_RULESET_KEY_PREFIX = "managed:"
const ZONE_RULESET_KEY_PREFIX = "zone:"
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

export function rulesetExactComparisonValue(ruleset, zoneName) {
  return {
    description: normalizeValue(
      typeof ruleset?.description === "string" ? ruleset.description.trim() : "",
      zoneName,
    ),
    rules: Array.isArray(ruleset?.rules)
      ? ruleset.rules.map((rule) => ruleExactComparisonValue(rule, zoneName))
      : [],
  }
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
  if (category !== RULESET_CATEGORY || key.startsWith(MANAGED_RULESET_KEY_PREFIX)) {
    return ""
  }
  return key.split(":")[1] || ""
}

export function facetPhase(facet) {
  return String(facet?.phase || phaseFromFacetKey(facet)).trim()
}

function facetIdentitySummary(facet, phaseLabel) {
  const category = String(facet?.category || "")
  const key = String(facet?.key || "")
  if (category === MATRIX_CATEGORY.REDIRECTS) {
    return `Redirects / ${phaseLabel} / normalized match / occurrence`
  }
  if (category === MATRIX_CATEGORY.RULESET_RULES) {
    return `Ruleset rules / ${phaseLabel} / normalized rule name`
  }
  if (category === RULESET_CATEGORY && key.startsWith(MANAGED_RULESET_KEY_PREFIX)) {
    return "Rulesets / managed ruleset ID"
  }
  if (category === RULESET_CATEGORY && key.startsWith(ZONE_RULESET_KEY_PREFIX)) {
    return `Rulesets / zone / ${phaseLabel}`
  }
  if (category === RULESET_CATEGORY) {
    const kind = key.split(":", 1)[0] || "ruleset"
    return `Rulesets / ${kind} / ${phaseLabel} / normalized name`
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
  const key = String(facet?.key || "")
  if (category === RULESET_CATEGORY && key.startsWith(MANAGED_RULESET_KEY_PREFIX)) {
    return "Kind + phase + version"
  }
  if (category === RULESET_CATEGORY) {
    return "Description + ordered editable rule fields"
  }
  if (category === MATRIX_CATEGORY.REDIRECTS) {
    return "Order + editable rule fields"
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
  const key = String(facet?.key || "")
  if (category === RULESET_CATEGORY && !key.startsWith(MANAGED_RULESET_KEY_PREFIX)) {
    return "Zone domain becomes {zone}; rule order and custom refs count"
  }
  if (RULE_CATEGORIES.has(category)) {
    return "Zone domain becomes {zone}; array order counts"
  }
  return "Zone domain becomes {zone}"
}

function facetIgnoredSummary(facet) {
  const category = String(facet?.category || "")
  const key = String(facet?.key || "")
  if (category === RULESET_CATEGORY && !key.startsWith(MANAGED_RULESET_KEY_PREFIX)) {
    return "Immutable name, kind, phase; IDs, timestamps, versions, generated refs, unsupported fields"
  }
  if (RULE_CATEGORIES.has(category)) {
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
  const workspaceAction = cell.workspaceAction || cell.parentAction
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
      reason: category === RULESET_CATEGORY
        ? "Edit description, rule fields, and order in the ruleset workspace. Immutable name, kind, and phase are not compared."
        : "Edit compared rule fields in the parent ruleset workspace.",
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
