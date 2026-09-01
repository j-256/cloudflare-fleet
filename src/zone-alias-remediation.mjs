import {
  HTTP_METHOD,
  RULESET_KIND,
} from "./constants.mjs"
import {
  buildDnsRecordDeletePlan,
  buildRuleCreatePlan,
  buildRuleDeletePlan,
  buildRuleEditPlan,
  editableRulePayload,
} from "./policies.mjs"
import { stableString } from "./normalize.mjs"
import {
  buildZoneAliasRedirectRule,
  isZoneAliasIntentValue,
  ZONE_ALIAS_REDIRECT_PHASE,
  ZONE_ALIAS_RESOURCE_REMEDIATION,
} from "./zone-alias-intent.mjs"

function resultFor(zone, surfaceId) {
  const surface = zone.surfaces?.[surfaceId]
  return surface?.ok ? surface.result : null
}

function requiredRuleset(zone, rulesetId) {
  const ruleset = (zone.ruleDetails || [])
    .filter((detail) => detail.ok)
    .map((detail) => detail.result)
    .find((entry) => entry.id === rulesetId)
  if (!ruleset) {
    throw new Error(`Ruleset ${rulesetId} is unavailable on ${zone.meta.name}`)
  }
  return ruleset
}

function requiredDnsRecord(zone, recordId) {
  const records = resultFor(zone, "dns")
  if (!Array.isArray(records)) {
    throw new Error(`DNS records are unavailable on ${zone.meta.name}`)
  }
  const record = records.find((entry) => entry.id === recordId)
  if (!record) {
    throw new Error(`DNS record ${recordId} is unavailable on ${zone.meta.name}`)
  }
  return record
}

function editableRedirectRuleset(zone) {
  return (zone.ruleDetails || [])
    .filter((detail) => detail.ok)
    .map((detail) => detail.result)
    .find((ruleset) => ruleset.phase === ZONE_ALIAS_REDIRECT_PHASE
      && [RULESET_KIND.ZONE, RULESET_KIND.CUSTOM].includes(ruleset.kind))
    || null
}

function desiredRedirectRule(currentRule, zone, desiredValue) {
  const canonical = buildZoneAliasRedirectRule(zone.meta.name, desiredValue)
  if (!currentRule) return canonical
  return {
    ...editableRulePayload(currentRule),
    ...canonical,
    description: currentRule.description || canonical.description,
    ref: currentRule.ref && currentRule.ref !== currentRule.id
      ? currentRule.ref
      : canonical.ref,
  }
}

function createRedirectPlan(zone, desiredValue) {
  const desired = desiredRedirectRule(null, zone, desiredValue)
  const ruleset = editableRedirectRuleset(zone)
  if (ruleset) return buildRuleCreatePlan(zone, ruleset, desired)
  return {
    id: `zone-alias-rule-create:${zone.meta.id}`,
    kind: "zone-alias-rule-create",
    operations: [{
      body: {
        kind: RULESET_KIND.ZONE,
        name: "default",
        phase: ZONE_ALIAS_REDIRECT_PHASE,
        rules: [desired],
      },
      label: `Create canonical alias redirect to ${desiredValue.redirect.targetHost}`,
      method: HTTP_METHOD.POST,
      path: `zones/${zone.meta.id}/rulesets`,
    }],
    summary: `Create the canonical alias redirect on ${zone.meta.name}`,
    zoneId: zone.meta.id,
    zoneName: zone.meta.name,
  }
}

function canonicalRedirectPlan(zone, action, desiredValue) {
  if (!action.canonicalRule) return createRedirectPlan(zone, desiredValue)
  const source = action.canonicalRule
  const ruleset = requiredRuleset(zone, source.rulesetId)
  const currentRule = ruleset.rules?.find((rule) => rule.id === source.ruleId)
  if (!currentRule) {
    throw new Error(`Canonical redirect rule ${source.ruleId} is unavailable on ${zone.meta.name}`)
  }
  return buildRuleEditPlan(
    zone,
    source,
    desiredRedirectRule(currentRule, zone, desiredValue),
  )
}

function resourceDeletePlan(zone, resource) {
  if (resource.remediation === ZONE_ALIAS_RESOURCE_REMEDIATION.DELETE_DNS_RECORD) {
    return buildDnsRecordDeletePlan(
      zone,
      requiredDnsRecord(zone, resource.action.recordId),
    )
  }
  if (resource.remediation === ZONE_ALIAS_RESOURCE_REMEDIATION.DELETE_RULE) {
    return buildRuleDeletePlan(
      zone,
      requiredRuleset(zone, resource.action.rulesetId),
      resource.action.ruleId,
    )
  }
  throw new Error(`${resource.label} has no reversible alias cleanup adapter`)
}

export function zoneAliasAlignmentBlocker(action, observedValue, desiredValue) {
  if (!isZoneAliasIntentValue(desiredValue)) {
    return "Exact alias intent must use the canonical web passthrough schema"
  }
  if (!action || action.type !== "zone-alias") {
    return "Canonical alias evidence is unavailable"
  }
  if (!observedValue || typeof observedValue !== "object") {
    return "Canonical alias observation is unavailable"
  }
  if (observedValue.unreadSurfaces?.length > 0) {
    return `Alias cleanup requires readable surfaces: ${observedValue.unreadSurfaces.map((surface) => surface.id).join(", ")}`
  }
  if (stableString(observedValue.servingDns) !== stableString(desiredValue.servingDns)) {
    return "Serving DNS differs from alias intent and requires an explicit DNS plan that cannot remove required passthrough records"
  }
  const unsupported = (action.resources || []).filter(
    (resource) => resource.remediation === ZONE_ALIAS_RESOURCE_REMEDIATION.UNSUPPORTED,
  )
  if (unsupported.length > 0) {
    return `Complete alias cleanup is blocked by unsupported resources: ${unsupported.map((resource) => resource.label).join(", ")}`
  }
  if (action.canonicalRule
    && (!action.canonicalRule.ruleId || !action.canonicalRule.rulesetId)) {
    return "The canonical redirect lacks stable identifiers for reversible alignment"
  }
  return ""
}

export function buildZoneAliasAlignmentPlan(zone, action, desiredValue) {
  const blocker = zoneAliasAlignmentBlocker(
    action,
    action.observedValue,
    desiredValue,
  )
  if (blocker) throw new Error(blocker)

  const plans = [canonicalRedirectPlan(zone, action, desiredValue)]
  for (const resource of action.resources || []) {
    plans.push(resourceDeletePlan(zone, resource))
  }
  return {
    id: `zone-alias-alignment:${zone.meta.id}`,
    kind: "zone-alias-alignment",
    operations: plans.flatMap((plan) => plan.operations),
    summary: `Align canonical web passthrough on ${zone.meta.name}`,
    zoneId: zone.meta.id,
    zoneName: zone.meta.name,
  }
}
