import {
  FLEET_INTENT_ALL_ZONES_GROUP_ID,
  FLEET_INTENT_EXPECTED_ORIGIN,
  FLEET_INTENT_GROUP_MODE,
  FLEET_INTENT_GROUP_NAME_SOURCE,
  FLEET_INTENT_PRESENCE_CONSTRAINT,
  FLEET_INTENT_VALUE_CONSTRAINT,
  fleetIntentFacetId,
  fleetIntentGroupZoneIds,
  evaluateFleetIntent,
  replaceFleetIntentGroup,
  replaceFleetIntentPolicy,
  removeFleetIntentPolicy,
} from "./fleet-intent.mjs"
import { alignmentCoverage } from "./alignment-coverage.mjs"
import { facetReadRequirement } from "./facet-read-requirements.mjs"
import { generatedIntentScopeName } from "./intent-scope.mjs"
import { intentIdHash } from "./intent-id.mjs"
import { groupFleetRowIntentValues } from "./value-comparison.mjs"

export const FACET_INTENT_MODE = Object.freeze({ CURRENT: "current", SOURCE: "source", ABSENT: "absent", SAVED: "saved" })
export const FACET_INTENT_LIMIT = 20
export const FACET_INTENT_ZONE_LIMIT = 100

export function facetIntentReadRequirements(request) {
  return request.facets.map((facet) => ({ kind: "inventory", ...facetReadRequirement(facet) }))
}

export function observedFacetExpected(variant) {
  return {
    canonical: variant.canonical,
    display: variant.display,
    value: structuredClone(variant.value),
    origin: FLEET_INTENT_EXPECTED_ORIGIN.OBSERVED,
    sourceZoneId: variant.sourceZoneId,
    sourceZoneName: variant.sourceZoneName,
    resolutionCanonical: variant.resolutionCanonical,
  }
}

export function buildFacetIntentDocument(document, inventory, matrix, request) {
  if (!Object.values(FACET_INTENT_MODE).includes(request.mode)) throw new TypeError("Choose how to set intent")
  if (!Array.isArray(request.facets) || !request.facets.length || request.facets.length > FACET_INTENT_LIMIT) throw new TypeError(`Choose between 1 and ${FACET_INTENT_LIMIT} facets`)
  const facetIds = request.facets.map((facet) => fleetIntentFacetId(facet.category, facet.key))
  if (new Set(facetIds).size !== facetIds.length) throw new TypeError("Choose each facet only once")
  facetIntentReadRequirements(request)
  const byZone = new Map(inventory.zones.map((zone) => [zone.meta.id, zone]))
  const byGroup = new Map(document.groups.map((group) => [group.id, group]))
  if (Boolean(request.groupIds?.length) === Boolean(request.zoneIds?.length)) throw new TypeError("Choose groups or zones")
  const groups = (request.groupIds || []).map((id) => {
    if (!byGroup.has(id)) throw new TypeError(`Zone group is unavailable: ${id}`)
    return byGroup.get(id)
  })
  const zoneIds = [...new Set(request.zoneIds || groups.flatMap((group) => fleetIntentGroupZoneIds(group, inventory)))].sort()
  if (!zoneIds.length || zoneIds.length > FACET_INTENT_ZONE_LIMIT) throw new TypeError(`Choose between 1 and ${FACET_INTENT_ZONE_LIMIT} zones`)
  for (const id of zoneIds) if (!byZone.has(id)) throw new TypeError(`Zone is unavailable: ${id}`)
  if (request.mode === FACET_INTENT_MODE.SOURCE && !byZone.has(request.sourceZoneId)) throw new TypeError("Choose an available source zone")
  if (request.mode !== FACET_INTENT_MODE.SOURCE && request.sourceZoneId) throw new TypeError("A source zone requires source mode")
  if (request.absentOutside && ![FACET_INTENT_MODE.SOURCE, FACET_INTENT_MODE.SAVED].includes(request.mode)) throw new TypeError("Outside absence requires source or saved mode")
  const savedPolicy = document.policies.find((policy) => policy.id === request.policyId)
  if (request.mode === FACET_INTENT_MODE.SAVED && (!savedPolicy || request.facets.length !== 1 || !facetIds.includes(fleetIntentFacetId(savedPolicy.facet.category, savedPolicy.facet.key)))) throw new TypeError("Choose a saved policy for this facet")
  if (request.mode !== FACET_INTENT_MODE.SAVED && request.policyId) throw new TypeError("A policy identifier requires saved mode")
  for (const id of request.removeGroupIds || []) {
    if (!byGroup.has(id)) throw new TypeError(`Zone group is unavailable: ${id}`)
    if (request.groupIds?.includes(id)) throw new TypeError("A group cannot be selected and removed together")
  }

  let next = structuredClone(document)
  const summaries = []
  function scopeFor(ids) {
    const sorted = [...ids].sort()
    const existing = next.groups.find((group) => group.mode === FLEET_INTENT_GROUP_MODE.MEMBERS
      && group.members.length === sorted.length && group.members.every((member) => sorted.includes(member.zoneId)))
    if (existing) return existing
    const members = sorted.map((zoneId) => ({ zoneId, zoneName: byZone.get(zoneId)?.meta.name
      || document.groups.flatMap((group) => group.members).find((member) => member.zoneId === zoneId)?.zoneName || zoneId }))
    const group = {
      id: `scope-${intentIdHash(JSON.stringify(sorted))}`,
      name: generatedIntentScopeName(members, next.groups),
      nameSource: FLEET_INTENT_GROUP_NAME_SOURCE.AUTOMATIC,
      mode: FLEET_INTENT_GROUP_MODE.MEMBERS,
      members,
    }
    next = replaceFleetIntentGroup(next, group)
    return group
  }
  function putPolicy(facet, group, expected, existing = null) {
    const matches = next.policies.filter((policy) => policy.groupId === group.id
      && fleetIntentFacetId(policy.facet.category, policy.facet.key) === fleetIntentFacetId(facet.category, facet.key))
    const policy = {
      id: matches[0]?.id || `intent-${intentIdHash(JSON.stringify([facet.category, facet.key, group.id]))}`,
      groupId: group.id,
      facet,
      presenceConstraint: expected ? FLEET_INTENT_PRESENCE_CONSTRAINT.REQUIRED : FLEET_INTENT_PRESENCE_CONSTRAINT.FORBIDDEN,
      valueConstraint: expected ? FLEET_INTENT_VALUE_CONSTRAINT.EXACT : FLEET_INTENT_VALUE_CONSTRAINT.MAY_DIFFER,
      expected,
      ...(existing ? { presenceConstraint: existing.presenceConstraint, valueConstraint: existing.valueConstraint } : {}),
    }
    for (const match of matches.slice(1)) next = removeFleetIntentPolicy(next, match.id)
    next = replaceFleetIntentPolicy(next, policy)
    next.acknowledgements = next.acknowledgements.filter((entry) => entry.policyId !== policy.id)
  }

  for (const selectedFacet of request.facets) {
    const row = matrix.rows.find((entry) => entry.category === selectedFacet.category && entry.key === selectedFacet.key)
    if (!row) throw new TypeError(`Facet is unavailable: ${selectedFacet.key}. Refresh before accepting its state.`)
    const facet = { category: row.category, key: row.key, label: row.label, description: row.description || "", ...(row.phase ? { phase: row.phase } : {}) }
    const observedZoneIds = new Set([...zoneIds, ...(request.mode === FACET_INTENT_MODE.SOURCE ? [request.sourceZoneId] : [])])
    const coverage = alignmentCoverage({ ...inventory, zones: inventory.zones.filter((zone) => observedZoneIds.has(zone.meta.id)) }, facetReadRequirement(facet))
    if (!coverage.complete) {
      const error = new Error(`Cannot set intent for ${facet.label}: required reads are incomplete (${coverage.failures.map((failure) => `${failure.zoneName || "account"}: ${failure.surfaceId}`).join(", ")}). Refresh and retry.`)
      error.coverage = coverage
      throw error
    }
    const matchesFacet = (policy) => policy.facet.category === facet.category && policy.facet.key === facet.key
    for (const policy of next.policies.filter((policy) => matchesFacet(policy) && request.removeGroupIds?.includes(policy.groupId))) {
      next = removeFleetIntentPolicy(next, policy.id)
    }
    const variants = groupFleetRowIntentValues(row, inventory.zones)
    if (request.mode === FACET_INTENT_MODE.CURRENT) {
      for (const zoneId of zoneIds) {
        const variant = variants.find((entry) => entry.zones.some((zone) => zone.id === zoneId))
        putPolicy(facet, scopeFor([zoneId]), variant ? observedFacetExpected(variant) : null)
      }
    } else {
      const variant = variants.find((entry) => entry.zones.some((zone) => zone.id === request.sourceZoneId))
      if (request.mode === FACET_INTENT_MODE.SOURCE && !variant) throw new TypeError(`The source does not contain ${facet.label}`)
      const expected = request.mode === FACET_INTENT_MODE.SAVED ? savedPolicy.expected : request.mode === FACET_INTENT_MODE.SOURCE ? observedFacetExpected(variant) : null
      const targetGroups = groups.length ? groups : [scopeFor(zoneIds)]
      // Retain broader defaults while replacing conflicting exceptions inside the selected scope
      for (const policy of [...next.policies].filter(matchesFacet)) {
        if (targetGroups.some((group) => group.id === policy.groupId)) continue
        const group = next.groups.find((entry) => entry.id === policy.groupId)
        const ids = fleetIntentGroupZoneIds(group, inventory)
        const intersects = ids.some((id) => zoneIds.includes(id))
        const broader = targetGroups.every((target) => target.mode !== FLEET_INTENT_GROUP_MODE.ALL
          && (group.mode === FLEET_INTENT_GROUP_MODE.ALL || ids.length > fleetIntentGroupZoneIds(target, inventory).length)
          && fleetIntentGroupZoneIds(target, inventory).every((id) => ids.includes(id)))
        if (intersects && !broader && ids.every((id) => zoneIds.includes(id))) next = removeFleetIntentPolicy(next, policy.id)
      }
      if (request.absentOutside) {
        for (const policy of [...next.policies].filter(matchesFacet)) next = removeFleetIntentPolicy(next, policy.id)
        putPolicy(facet, byGroup.get(FLEET_INTENT_ALL_ZONES_GROUP_ID), null)
      }
      for (const group of targetGroups) putPolicy(facet, group, expected, request.mode === FACET_INTENT_MODE.SAVED ? savedPolicy : null)
      // Resolve partial overlaps inside the selection without changing an outside group's membership or precedence
      const signature = (policy) => JSON.stringify([policy.presenceConstraint, policy.valueConstraint, policy.expected?.origin, policy.expected?.canonical])
      const targetPolicy = next.policies.find((policy) => matchesFacet(policy) && policy.groupId === targetGroups[0].id)
      const cells = evaluateFleetIntent(next, inventory, { rows: [row] }).rowStates.get(fleetIntentFacetId(facet.category, facet.key)).cells
      for (const zoneId of zoneIds) {
        if (!cells.get(zoneId)?.policies.some((policy) => signature(policy) !== signature(targetPolicy))) continue
        if (targetPolicy.valueConstraint === FLEET_INTENT_VALUE_CONSTRAINT.MUST_DIFFER) throw new TypeError("Overlapping uniqueness scopes require the Advanced editor; their group relationships cannot be replaced with individual zone overrides")
        putPolicy(facet, scopeFor([zoneId]), expected, targetPolicy)
      }
    }
    const present = zoneIds.filter((id) => row.cells.has(byZone.get(id).meta.name)).length
    summaries.push({ facet, zoneCount: zoneIds.length, present, absent: zoneIds.length - present })
  }
  return { document: next, summaries, zoneIds }
}
