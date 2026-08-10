import {
  stableString,
} from "./normalize.mjs"
import { rulesetExactComparisonValue } from "./facet-equivalence.mjs"

const MISSING_GROUP_KEY = "missing"
const RULESET_PARENT_CATEGORY = "Rulesets"

function pluralize(value, singular, plural = `${singular}s`) {
  return `${value} ${value === 1 ? singular : plural}`
}

function countGroupKey(ruleCount) {
  return ruleCount === null ? MISSING_GROUP_KEY : `count:${ruleCount}`
}

function countGroupLabel(ruleCount) {
  return ruleCount === null ? "Missing" : pluralize(ruleCount, "rule")
}

function compareGroups(left, right) {
  if (left.countBaseline !== right.countBaseline) return left.countBaseline ? -1 : 1
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

    const exactValue = rulesetExactComparisonValue(ruleset, zone.meta.name)
    const rules = exactValue.rules
    const canonical = stableString(exactValue)
    if (!group.configurationsByCanonical.has(canonical)) {
      group.configurationsByCanonical.set(canonical, {
        canonical,
        exactValue,
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
  const countBaselineKey = largestGroups.length === 1 ? largestGroups[0].key : null
  const groups = rawGroups.map((group) => {
    const configurations = [...group.configurationsByCanonical.values()]
      .map((configuration) => ({
        ...configuration,
        zoneCount: configuration.zones.length,
      }))
      .sort(compareConfigurations)
    return {
      countBaseline: group.key === countBaselineKey,
      configurations,
      key: group.key,
      label: group.label,
      ruleCount: group.ruleCount,
      zoneCount: group.zones.length,
      zones: group.zones,
    }
  }).sort(compareGroups)
  const countBaseline = groups.find((group) => group.countBaseline) || null
  const configurations = groups.flatMap((group) => group.configurations)
  for (const group of groups) {
    for (const configuration of group.configurations) {
      configuration.ruleCount = group.ruleCount
    }
  }
  configurations.sort(compareConfigurations)
  const largestDefinitionCount = Math.max(
    0,
    ...configurations.map((configuration) => configuration.zoneCount),
  )
  const leadingDefinitions = configurations.filter(
    (configuration) => configuration.zoneCount === largestDefinitionCount,
  )
  const baseline = leadingDefinitions.length === 1
    ? leadingDefinitions[0]
    : null
  for (const configuration of configurations) {
    configuration.baseline = configuration === baseline
  }
  const totalZones = (zones || []).length
  const outlierCount = baseline ? totalZones - baseline.zoneCount : 0
  const hasDefinitionDifferences = groups.some((group) => group.configurations.length > 1)
  const configurationCount = configurations.length
  const distributionText = groups
    .map((group) => `${group.label}: ${group.zoneCount}`)
    .join(" | ")
  const hasMissingGroup = groups.some((group) => group.ruleCount === null)
  const missingGroup = groups.find((group) => group.ruleCount === null) || null
  const missingZones = missingGroup?.zones || []
  const missingZoneCount = missingZones.length
  const presentZoneCount = totalZones - missingZoneCount
  const definitionSummaryText = `${pluralize(configurationCount, "unique ordered definition")} across ${pluralize(totalZones, "zone")}${missingZoneCount > 0 ? `; ${pluralize(missingZoneCount, "zone")} missing this ruleset` : ""}`
  const badgeText = baseline
    ? `Exact value on ${baseline.zoneCount}/${totalZones}`
    : `${pluralize(configurationCount, "exact value")}${hasMissingGroup ? " + missing" : ""}`
  const title = `${definitionSummaryText}. Exact equivalence includes the ruleset description and ordered editable rule fields; rule count is review metadata only.`

  return {
    badgeText,
    baseline,
    configurations,
    countBaseline,
    configurationCount,
    definitionSummaryText,
    distributionText,
    groups,
    hasDefinitionDifferences,
    hasDifferences: groups.length > 1 || hasDefinitionDifferences,
    missingZoneCount,
    missingZones,
    outlierCount,
    presentZoneCount,
    title,
    totalZones,
  }
}
