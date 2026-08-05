import {
  FLEET_INTENT_GROUP_MODE,
  fleetIntentPolicyFacetId,
} from "./fleet-intent.mjs"

export const FLEET_INTENT_POLICY_LAYER_ROLE = Object.freeze({
  BASELINE: "baseline",
  OVERLAP: "overlap",
  REFINEMENT: "refinement",
  STANDALONE: "standalone",
})

export const FLEET_INTENT_POLICY_LAYER_PRESENTATION = Object.freeze({
  [FLEET_INTENT_POLICY_LAYER_ROLE.BASELINE]: Object.freeze({
    label: "Fleet baseline",
    status: "baseline",
  }),
  [FLEET_INTENT_POLICY_LAYER_ROLE.OVERLAP]: Object.freeze({
    label: "Shared overlap",
    status: "layered",
  }),
  [FLEET_INTENT_POLICY_LAYER_ROLE.REFINEMENT]: Object.freeze({
    label: "Group refinement",
    status: "refinement",
  }),
  [FLEET_INTENT_POLICY_LAYER_ROLE.STANDALONE]: Object.freeze({
    label: "",
    status: "",
  }),
})

function groupZoneIds(group, loadedZoneIds) {
  if (!group) return null
  if (group.mode === FLEET_INTENT_GROUP_MODE.ALL) {
    return new Set(loadedZoneIds)
  }
  return new Set(group.members.map((member) => member.zoneId))
}

function setsOverlap(left, right) {
  for (const value of left) {
    if (right.has(value)) return true
  }
  return false
}

function isProperSubset(left, right) {
  if (left.size >= right.size) return false
  for (const value of left) {
    if (!right.has(value)) return false
  }
  return true
}

function groupNames(entries) {
  return [...new Set(entries.map((entry) => entry.group.name))]
    .sort((left, right) => left.localeCompare(right))
}

export function fleetIntentPolicyLayers(policies, groups, loadedZoneIds) {
  const groupsById = new Map(groups.map((group) => [group.id, group]))
  const entries = policies.map((policy) => {
    const group = groupsById.get(policy.groupId) || null
    return {
      group,
      policy,
      scope: groupZoneIds(group, loadedZoneIds),
    }
  })
  const layers = new Map()
  for (const entry of entries) {
    const broader = []
    const narrower = []
    const overlapping = []
    if (entry.scope) {
      for (const candidate of entries) {
        if (candidate.policy.id === entry.policy.id
          || !candidate.scope
          || fleetIntentPolicyFacetId(candidate.policy)
            !== fleetIntentPolicyFacetId(entry.policy)) continue
        if (isProperSubset(entry.scope, candidate.scope)) {
          broader.push(candidate)
        } else if (isProperSubset(candidate.scope, entry.scope)) {
          narrower.push(candidate)
        } else if (setsOverlap(entry.scope, candidate.scope)) {
          overlapping.push(candidate)
        }
      }
    }
    const role = broader.length > 0
      ? FLEET_INTENT_POLICY_LAYER_ROLE.REFINEMENT
      : narrower.length > 0
        ? FLEET_INTENT_POLICY_LAYER_ROLE.BASELINE
        : overlapping.length > 0
          ? FLEET_INTENT_POLICY_LAYER_ROLE.OVERLAP
          : FLEET_INTENT_POLICY_LAYER_ROLE.STANDALONE
    layers.set(entry.policy.id, {
      broaderGroupNames: groupNames(broader),
      narrowerGroupNames: groupNames(narrower),
      overlappingGroupNames: groupNames(overlapping),
      role,
    })
  }
  return layers
}
