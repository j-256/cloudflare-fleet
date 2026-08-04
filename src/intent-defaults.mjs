import {
  FLEET_INTENT_PRESENCE_CONSTRAINT,
  FLEET_INTENT_VALUE_CONSTRAINT,
  fleetIntentPolicyPresenceConstraint,
  fleetIntentPolicyValueConstraint,
} from "./fleet-intent.mjs"

function observedCanonical(row, zoneName) {
  const cell = row?.cells.get(zoneName)
  return cell?.intentCanonical ?? cell?.canonical ?? null
}

export function firstFleetIntentObservedCanonical(row, scopeZones) {
  for (const zone of scopeZones) {
    if (zone.unavailable) continue
    const canonical = observedCanonical(row, zone.zoneName)
    if (canonical !== null) return canonical
  }
  return null
}

export function defaultFleetIntentPolicyConstraints(row, scopeZones) {
  const availableZones = scopeZones.filter((zone) => !zone.unavailable)
  const presentCanonicals = availableZones
    .map((zone) => observedCanonical(row, zone.zoneName))
    .filter((canonical) => canonical !== null)
  return {
    presenceConstraint: presentCanonicals.length === availableZones.length
      && availableZones.length > 0
      ? FLEET_INTENT_PRESENCE_CONSTRAINT.REQUIRED
      : FLEET_INTENT_PRESENCE_CONSTRAINT.OPTIONAL,
    valueConstraint: presentCanonicals.length > 0
      && new Set(presentCanonicals).size === 1
      ? FLEET_INTENT_VALUE_CONSTRAINT.EXACT
      : FLEET_INTENT_VALUE_CONSTRAINT.MAY_DIFFER,
  }
}

export function fleetIntentPolicyForGroup(policies, groupId) {
  return policies.find((policy) => policy.groupId === groupId) || null
}

export function fleetIntentPolicyGroupSelection(
  row,
  scopeZones,
  policies,
  groupId,
) {
  const policy = fleetIntentPolicyForGroup(policies, groupId)
  if (policy) {
    return {
      expectedCanonical: policy.expected?.canonical || null,
      policy,
      presenceConstraint: fleetIntentPolicyPresenceConstraint(policy),
      valueConstraint: fleetIntentPolicyValueConstraint(policy),
    }
  }
  const defaults = defaultFleetIntentPolicyConstraints(row, scopeZones)
  return {
    expectedCanonical: defaults.valueConstraint === FLEET_INTENT_VALUE_CONSTRAINT.EXACT
      ? firstFleetIntentObservedCanonical(row, scopeZones)
      : null,
    policy: null,
    ...defaults,
  }
}
