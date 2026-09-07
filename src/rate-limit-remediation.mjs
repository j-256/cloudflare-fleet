import {
  HTTP_METHOD,
  RULESET_KIND,
  WAF_PHASE,
} from "./constants.mjs"
import {
  materializeValue,
  normalizeValue,
  stableString,
} from "./normalize.mjs"
import {
  buildRuleCreatePlan,
  buildRuleDeletePlan,
  editableRulePayload,
} from "./policies.mjs"
import {
  HOSTNAME_SCOPED_RATE_LIMIT_KIND,
  isHostnameScopedFreeRateLimitIntentValue,
  RATE_LIMIT_PHASE,
} from "./rate-limit-intent.mjs"

const FREE_PLAN_NAME = "Free Website"
const FREE_WAF_CUSTOM_RULE_LIMIT = 5

function entrypointRulesets(zone, phase) {
  return (zone.ruleDetails || [])
    .filter((detail) => detail.ok)
    .map((detail) => detail.result)
    .filter((ruleset) => (
      ruleset.kind === RULESET_KIND.ZONE && ruleset.phase === phase
    ))
}

function requiredEntrypoint(zone, phase) {
  const rulesets = entrypointRulesets(zone, phase)
  if (rulesets.length > 1) {
    throw new Error(`Multiple ${phase} zone entrypoints on ${zone.meta.name} require manual review`)
  }
  return rulesets[0] || null
}

function wafCustomRuleCount(zone) {
  return (zone.ruleDetails || [])
    .filter((detail) => detail.ok)
    .map((detail) => detail.result)
    .filter((ruleset) => (
      ruleset.phase === WAF_PHASE
      && [RULESET_KIND.ZONE, RULESET_KIND.CUSTOM].includes(ruleset.kind)
    ))
    .reduce((count, ruleset) => count + (ruleset.rules?.length || 0), 0)
}

function validEntry(entry, phase) {
  return entry?.action?.phase === phase
    && typeof entry.action.ruleId === "string"
    && entry.action.ruleId.length > 0
    && typeof entry.action.rulesetId === "string"
    && entry.action.rulesetId.length > 0
    && entry.rule
    && typeof entry.rule === "object"
}

function alreadyHasActionParameters(entries, desiredRule) {
  if (desiredRule?.action_parameters === undefined) return true
  return entries.some((entry) => (
    stableString(editableRulePayload(entry.rule).action_parameters)
      === stableString(desiredRule.action_parameters)
  ))
}

function desiredRuleForZone(rule, zoneName) {
  return materializeValue(rule, zoneName)
}

function normalizedDesiredRule(rule, zoneName) {
  return normalizeValue(desiredRuleForZone(rule, zoneName), zoneName, {
    preserveOrder: true,
  })
}

function matchingEntry(entries, desired, zoneName) {
  const normalized = normalizedDesiredRule(desired, zoneName)
  const exact = entries.filter(
    (entry) => stableString(entry.normalized) === stableString(normalized),
  )
  if (exact.length > 1) throw new Error("Multiple exact rules match the desired rate-limit posture")
  if (exact.length === 1) return exact[0]
  if (normalized.ref) {
    const references = entries.filter((entry) => entry.normalized.ref === normalized.ref)
    if (references.length > 1) throw new Error(`Multiple rules use reference ${normalized.ref}`)
    if (references.length === 1) return references[0]
  }
  const descriptions = entries.filter(
    (entry) => entry.normalized.description === normalized.description,
  )
  if (descriptions.length > 1) {
    throw new Error(`Multiple rules use description ${normalized.description}`)
  }
  return descriptions[0] || null
}

function editOperation(zone, entry, desired, currentValue, label) {
  return {
    body: structuredClone(desired),
    currentValue: structuredClone(currentValue),
    label,
    method: HTTP_METHOD.PATCH,
    path: `zones/${zone.meta.id}/rulesets/${entry.action.rulesetId}/rules/${entry.action.ruleId}`,
  }
}

function deleteOperations(zone, entries) {
  return entries.flatMap((entry) => {
    const ruleset = requiredEntrypoint(zone, entry.action.phase)
    if (!ruleset || ruleset.id !== entry.action.rulesetId) {
      throw new Error(`The ${entry.action.phase} entrypoint changed on ${zone.meta.name}`)
    }
    return buildRuleDeletePlan(
      zone,
      ruleset,
      entry.action.ruleId,
    ).operations
  })
}

function createRuleOperations(zone, phase, desired) {
  const ruleset = requiredEntrypoint(zone, phase)
  if (ruleset) return buildRuleCreatePlan(zone, ruleset, desired).operations
  return [{
    body: {
      kind: RULESET_KIND.ZONE,
      name: "default",
      phase,
      rules: [structuredClone(desired)],
    },
    currentValue: {
      entrypoint: "missing",
      phase,
      ruleCount: 0,
    },
    label: `Create ${phase} entrypoint with ${desired.description}`,
    method: HTTP_METHOD.POST,
    path: `zones/${zone.meta.id}/rulesets`,
  }]
}

function skipPostureChanges(action, desired, zoneName) {
  const observed = action.observedValue
  const normalizedDesired = normalizeValue(desired, zoneName, {
    preserveOrder: true,
  })
  return stableString(observed.hosts) !== stableString(normalizedDesired.hosts)
    || stableString(observed.skipRules) !== stableString(normalizedDesired.skipRules)
}

function reconcileSkipOperations(zone, entries, desiredRule) {
  if (!desiredRule) return deleteOperations(zone, entries)
  const desired = desiredRuleForZone(desiredRule, zone.meta.name)
  let target = matchingEntry(entries, desiredRule, zone.meta.name)
  if (!target && entries.length > 0) target = entries[0]
  const operations = []
  if (target) {
    const current = editableRulePayload(target.rule)
    if (stableString(normalizeValue(current, zone.meta.name, { preserveOrder: true }))
      !== stableString(normalizedDesiredRule(desiredRule, zone.meta.name))) {
      operations.push(editOperation(
        zone,
        target,
        desired,
        current,
        `Update ${current.description || "rate-limit host-scope skip"}`,
      ))
    }
  } else {
    operations.push(...createRuleOperations(zone, WAF_PHASE, desired))
  }
  operations.push(...deleteOperations(
    zone,
    entries.filter((entry) => entry !== target),
  ))
  return operations
}

function finalRateOperations(zone, entries, desiredRule, disabledRuleIds) {
  if (!desiredRule) return []
  const desired = desiredRuleForZone(desiredRule, zone.meta.name)
  let target = matchingEntry(entries, desiredRule, zone.meta.name)
  if (!target && entries.length === 1) target = entries[0]
  if (!target) return createRuleOperations(zone, RATE_LIMIT_PHASE, desired)
  const original = editableRulePayload(target.rule)
  const current = disabledRuleIds.has(target.action.ruleId)
    ? { ...original, enabled: false }
    : original
  if (stableString(current) === stableString(desired)) return []
  return [editOperation(
    zone,
    target,
    desired,
    current,
    `Set ${desired.description}`,
  )]
}

export function hostnameScopedFreeRateLimitAlignmentBlocker(
  zone,
  action,
  desiredValue,
) {
  if (!isHostnameScopedFreeRateLimitIntentValue(desiredValue)) {
    return "Exact rate-limit intent must use the hostname-scoped Free rate-limit schema"
  }
  if (zone.meta.plan?.name !== FREE_PLAN_NAME) {
    return `Hostname-scoped Free rate-limit intent requires ${FREE_PLAN_NAME}`
  }
  if (action?.type !== HOSTNAME_SCOPED_RATE_LIMIT_KIND) {
    return "Hostname-scoped rate-limit evidence is unavailable"
  }
  if (!Array.isArray(action.rateEntries) || !Array.isArray(action.skipEntries)) {
    return "Hostname-scoped rate-limit rule evidence is unavailable"
  }
  if (action.rateEntries.length > 1) {
    return "More than one zone rate rule exists and requires manual review"
  }
  if (action.rateEntries.some((entry) => !validEntry(entry, RATE_LIMIT_PHASE))) {
    return "A rate rule lacks stable identifiers for reversible alignment"
  }
  if (action.skipEntries.some((entry) => !validEntry(entry, WAF_PHASE))) {
    return "A rate-limit skip lacks stable identifiers for reversible alignment"
  }
  if (!alreadyHasActionParameters(action.rateEntries, desiredValue.rateRules[0])) {
    return "Cloudflare documents custom rate-limit responses as Pro and above; Free alignment will preserve an identical existing response but will not introduce one"
  }
  if (desiredValue.skipRules.length > 0
    && action.skipEntries.length === 0
    && wafCustomRuleCount(zone) >= FREE_WAF_CUSTOM_RULE_LIMIT) {
    return `The custom WAF ruleset has no capacity for the required rate-limit skip; the known Free plan limit is ${FREE_WAF_CUSTOM_RULE_LIMIT}`
  }
  try {
    requiredEntrypoint(zone, RATE_LIMIT_PHASE)
    requiredEntrypoint(zone, WAF_PHASE)
    const desiredRate = desiredValue.rateRules[0]
    const desiredSkip = desiredValue.skipRules[0]
    if (desiredRate) matchingEntry(action.rateEntries, desiredRate, zone.meta.name)
    if (desiredSkip) matchingEntry(action.skipEntries, desiredSkip, zone.meta.name)
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  return ""
}

export function buildHostnameScopedFreeRateLimitAlignmentPlan(
  zone,
  action,
  desiredValue,
) {
  const blocker = hostnameScopedFreeRateLimitAlignmentBlocker(
    zone,
    action,
    desiredValue,
  )
  if (blocker) throw new Error(blocker)

  const rateEntries = action.rateEntries
  const skipEntries = action.skipEntries
  const desiredRate = desiredValue.rateRules[0] || null
  const desiredSkip = desiredValue.skipRules[0] || null
  const operations = []
  const disabledRuleIds = new Set()

  if (!desiredRate) {
    operations.push(...deleteOperations(zone, rateEntries))
    operations.push(...reconcileSkipOperations(zone, skipEntries, desiredSkip))
  } else {
    if (skipPostureChanges(action, desiredValue, zone.meta.name)) {
      for (const entry of rateEntries) {
        const current = editableRulePayload(entry.rule)
        if (current.enabled === false) continue
        operations.push(editOperation(
          zone,
          entry,
          { ...current, enabled: false },
          current,
          `Disable ${current.description || "rate rule"} before changing host scope`,
        ))
        disabledRuleIds.add(entry.action.ruleId)
      }
    }
    operations.push(...reconcileSkipOperations(zone, skipEntries, desiredSkip))
    operations.push(...finalRateOperations(
      zone,
      rateEntries,
      desiredRate,
      disabledRuleIds,
    ))
  }

  return {
    id: `${HOSTNAME_SCOPED_RATE_LIMIT_KIND}:${zone.meta.id}`,
    kind: HOSTNAME_SCOPED_RATE_LIMIT_KIND,
    operations,
    summary: operations.length === 0
      ? `Hostname-scoped Free rate limit already matches intent on ${zone.meta.name}`
      : `Align hostname-scoped Free rate limit on ${zone.meta.name}`,
    zoneId: zone.meta.id,
    zoneName: zone.meta.name,
  }
}
