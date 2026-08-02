import {
  normalizeValue,
  stableString,
} from "./normalize.mjs"

const MISSING_GROUP_KEY = "missing"
const RULESET_PARENT_CATEGORY = "Rulesets"
const RULE_NORMALIZATION_OPTIONS = Object.freeze({
  omit: ["last_updated", "ref", "version"],
  preserveOrder: true,
})

function pluralize(value, singular, plural = `${singular}s`) {
  return `${value} ${value === 1 ? singular : plural}`
}

function countGroupKey(ruleCount) {
  return ruleCount === null ? MISSING_GROUP_KEY : `count:${ruleCount}`
}

function countGroupLabel(ruleCount) {
  return ruleCount === null ? "Missing" : pluralize(ruleCount, "rule")
}

function normalizedRules(ruleset, zoneName) {
  return (ruleset.rules || []).map((rule) => (
    normalizeValue(rule, zoneName, RULE_NORMALIZATION_OPTIONS)
  ))
}

function compareGroups(left, right) {
  if (left.baseline !== right.baseline) return left.baseline ? -1 : 1
  if (left.ruleCount === null) return 1
  if (right.ruleCount === null) return -1
  return right.zoneCount - left.zoneCount || left.ruleCount - right.ruleCount
}

function compareConfigurations(left, right) {
  return right.zoneCount - left.zoneCount || left.canonical.localeCompare(right.canonical)
}

export function rulesetParentRowIsReviewable(row) {
  return row?.category === RULESET_PARENT_CATEGORY
    && [...(row.cells?.values?.() || [])].some((cell) => (
      Array.isArray(cell.inspectionValue?.rules)
        && Boolean(cell.workspaceAction)
    ))
}

export function rulesetRowPhase(row) {
  for (const cell of row?.cells?.values?.() || []) {
    if (cell.workspaceAction?.phase) return cell.workspaceAction.phase
  }
  return ""
}

export function compareDetailedRulesetRow(row, zones) {
  if (!rulesetParentRowIsReviewable(row)) return null
  const groupsByCount = new Map()

  for (const zone of zones || []) {
    const cell = row.cells.get(zone.meta.name)
    const ruleset = Array.isArray(cell?.inspectionValue?.rules)
      ? cell.inspectionValue
      : null
    const ruleCount = ruleset ? ruleset.rules.length : null
    const key = countGroupKey(ruleCount)
    if (!groupsByCount.has(key)) {
      groupsByCount.set(key, {
        configurationsByCanonical: new Map(),
        key,
        label: countGroupLabel(ruleCount),
        ruleCount,
        zones: [],
      })
    }
    const group = groupsByCount.get(key)
    const zoneEntry = {
      id: zone.meta.id,
      name: zone.meta.name,
      workspaceAction: cell?.workspaceAction || null,
    }
    group.zones.push(zoneEntry)
    if (!ruleset) continue

    const rules = normalizedRules(ruleset, zone.meta.name)
    const canonical = stableString(rules)
    if (!group.configurationsByCanonical.has(canonical)) {
      group.configurationsByCanonical.set(canonical, {
        canonical,
        rules,
        zones: [],
      })
    }
    group.configurationsByCanonical.get(canonical).zones.push(zoneEntry)
  }

  const rawGroups = [...groupsByCount.values()]
  const presentRawGroups = rawGroups.filter((group) => group.ruleCount !== null)
  const largestZoneCount = Math.max(
    0,
    ...presentRawGroups.map((group) => group.zones.length),
  )
  const largestGroups = presentRawGroups.filter(
    (group) => group.zones.length === largestZoneCount,
  )
  const baselineKey = largestGroups.length === 1 ? largestGroups[0].key : null
  const groups = rawGroups.map((group) => {
    const configurations = [...group.configurationsByCanonical.values()]
      .map((configuration) => ({
        ...configuration,
        zoneCount: configuration.zones.length,
      }))
      .sort(compareConfigurations)
    return {
      baseline: group.key === baselineKey,
      configurations,
      key: group.key,
      label: group.label,
      ruleCount: group.ruleCount,
      zoneCount: group.zones.length,
      zones: group.zones,
    }
  }).sort(compareGroups)
  const baseline = groups.find((group) => group.baseline) || null
  const totalZones = (zones || []).length
  const outlierCount = baseline ? totalZones - baseline.zoneCount : 0
  const hasDefinitionDifferences = groups.some((group) => group.configurations.length > 1)
  const configurationCount = groups.reduce(
    (total, group) => total + group.configurations.length,
    0,
  )
  const distributionText = groups
    .map((group) => `${group.label}: ${group.zoneCount}`)
    .join(" | ")
  const presentGroups = groups.filter((group) => group.ruleCount !== null)
  const hasMissingGroup = groups.some((group) => group.ruleCount === null)
  const badgeText = baseline
    ? `${baseline.label} on ${baseline.zoneCount}/${totalZones}`
    : `${pluralize(presentGroups.length, "rule count")}${hasMissingGroup ? " + missing" : ""}`
  const title = `${groups.map((group) => {
    if (group.ruleCount === null) {
      return `${pluralize(group.zoneCount, "zone")} ${group.zoneCount === 1 ? "is" : "are"} missing the entrypoint`
    }
    return `${pluralize(group.zoneCount, "zone")} ${group.zoneCount === 1 ? "has" : "have"} ${group.label}`
  }).join("; ")}. This parent summary compares entrypoint presence and rule count, not individual rule definitions.`

  return {
    badgeText,
    baseline,
    configurationCount,
    distributionText,
    groups,
    hasDefinitionDifferences,
    hasDifferences: groups.length > 1 || hasDefinitionDifferences,
    outlierCount,
    title,
    totalZones,
  }
}
