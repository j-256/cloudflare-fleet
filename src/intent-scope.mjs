import {
  FLEET_INTENT_GROUP_MODE,
  FLEET_INTENT_LABEL_MAX_LENGTH,
} from "./fleet-intent.mjs"

const GENERATED_SCOPE_FALLBACK = "Selected zones"

function normalizedZoneIds(zoneIds) {
  return [...new Set(zoneIds)].sort()
}

function sameZoneIds(left, right) {
  if (left.length !== right.length) return false
  return left.every((zoneId, index) => zoneId === right[index])
}

function groupZoneIds(group, loadedZoneIds) {
  return group.mode === FLEET_INTENT_GROUP_MODE.ALL
    ? normalizedZoneIds(loadedZoneIds)
    : normalizedZoneIds(group.members.map((member) => member.zoneId))
}

export function intentGroupMatchesZoneSelection(
  group,
  selectedZoneIds,
  loadedZoneIds,
) {
  if (!group) return false
  return sameZoneIds(
    groupZoneIds(group, loadedZoneIds),
    normalizedZoneIds(selectedZoneIds),
  )
}

export function findIntentGroupForZoneSelection(
  groups,
  selectedZoneIds,
  loadedZoneIds,
) {
  const matches = intentGroupsForZoneSelection(
    groups,
    selectedZoneIds,
    loadedZoneIds,
  )
  const allZonesGroup = matches.find(
    (group) => group.mode === FLEET_INTENT_GROUP_MODE.ALL,
  )
  if (allZonesGroup) return allZonesGroup
  return matches.length === 1 ? matches[0] : null
}

export function intentGroupsForZoneSelection(
  groups,
  selectedZoneIds,
  loadedZoneIds,
) {
  return groups.filter((group) => intentGroupMatchesZoneSelection(
    group,
    selectedZoneIds,
    loadedZoneIds,
  ))
}

function limitedName(value, suffix, maximum) {
  const prefixLength = Math.max(1, maximum - suffix.length)
  return `${value.slice(0, prefixLength).trim() || GENERATED_SCOPE_FALLBACK.slice(0, prefixLength)}${suffix}`
}

export function generatedIntentScopeName(members, groups, options = {}) {
  const names = [...members]
    .map((member) => member.zoneName.trim())
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right))
  const base = names.length === 0
    ? GENERATED_SCOPE_FALLBACK
    : names.length === 1
      ? names[0]
      : `${names[0]} +${names.length - 1} more`
  const maximum = options.maximum || FLEET_INTENT_LABEL_MAX_LENGTH
  const occupiedNames = new Set(groups
    .filter((group) => group.id !== options.excludeGroupId)
    .map((group) => group.name.trim().toLowerCase()))
  let sequence = 1
  let candidate = limitedName(base, "", maximum)
  while (occupiedNames.has(candidate.toLowerCase())) {
    sequence += 1
    candidate = limitedName(base, ` (${sequence})`, maximum)
  }
  return candidate
}
