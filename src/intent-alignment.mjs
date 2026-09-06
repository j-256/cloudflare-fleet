import {
  EMAIL_ROUTING_ACTION_KIND,
  EMAIL_ROUTING_SETTING,
  HOLE_RESOLUTION_KIND,
  MATRIX_CATEGORY,
  RULESET_KIND,
} from "./constants.mjs"
import {
  dnssecDesiredStatus,
  rowSupportsDnssecIntentCorrection,
} from "./dnssec-intent.mjs"
import {
  FLEET_INTENT_CELL_STATUS,
  FLEET_INTENT_EXPECTED_ORIGIN,
  FLEET_INTENT_PRESENCE_CONSTRAINT,
  FLEET_INTENT_VALUE_CONSTRAINT,
  fleetIntentPolicyPresenceConstraint,
  fleetIntentPolicyValueConstraint,
} from "./fleet-intent.mjs"
import {
  materializeValue,
} from "./normalize.mjs"
import {
  buildDnsRecordCopyPlan,
  buildDnsRecordDeletePlan,
  buildDnsRecordEditPlan,
  buildDnssecStatusPlan,
  buildEmailRoutingRuleEditPlan,
  buildEmailRoutingSettingPlan,
  buildRuleCopyPlans,
  buildRuleDeletePlan,
  buildRuleEditPlan,
  buildZoneSettingPlan,
  editableDnsRecordPayload,
  editableEmailRoutingRulePayload,
  editableRulePayload,
} from "./policies.mjs"
import {
  inventoryRead,
} from "./read-composer.mjs"
import {
  isZoneAliasMatrixRow,
  ZONE_ALIAS_REQUIRED_ACCOUNT_SURFACE_IDS,
  ZONE_ALIAS_REQUIRED_SURFACE_IDS,
} from "./zone-alias-intent.mjs"
import {
  buildZoneAliasAlignmentPlan,
  zoneAliasAlignmentBlocker,
} from "./zone-alias-remediation.mjs"

const DNS_RECORD_CATEGORY = "DNS records"
const EMAIL_CATCH_ALL_KEY = "catch-all"
const EMAIL_CATEGORY = "Email"
const EMAIL_DNS_SPECIFICATION_CATEGORY = "Email DNS specification"
const EMAIL_ROUTE_CATEGORY = "Email routes"
const EMAIL_SETTING_KEY_PREFIX = "settings:"
const ZONE_SETTING_CATEGORY = "Zone settings"
const EMAIL_ROUTING_WRITABLE_SETTINGS = new Set(
  [EMAIL_ROUTING_SETTING.SUPPORT_SUBADDRESS],
)
const RULE_CATEGORIES = new Set([
  MATRIX_CATEGORY.REDIRECTS,
  MATRIX_CATEGORY.RULESET_RULES,
])
const ACTIONABLE_CELL_STATUSES = new Set([
  FLEET_INTENT_CELL_STATUS.CONFLICT,
  FLEET_INTENT_CELL_STATUS.MISSING,
  FLEET_INTENT_CELL_STATUS.VARIANT,
])

export const INTENT_ALIGNMENT_TARGET_KIND = Object.freeze({
  DELETE_DNS_RECORDS: "delete-dns-records",
  DELETE_RULE: "delete-rule",
  EDIT_DNS_RECORDS: "edit-dns-records",
  EDIT_EMAIL_RULE: "edit-email-rule",
  EDIT_EMAIL_SETTING: "edit-email-setting",
  EDIT_RULE: "edit-rule",
  EDIT_SETTING: "edit-setting",
  FILL_DNS_RECORDS: "fill-dns-records",
  FILL_RULE: "fill-rule",
  SET_DNSSEC_STATUS: "set-dnssec-status",
  ZONE_ALIAS: "zone-alias",
})

export class UnsupportedIntentAlignmentFacetError extends Error {
  constructor(message = "This facet has no scoped live read for intent alignment") {
    super(message)
    this.name = "UnsupportedIntentAlignmentFacetError"
  }
}

function cloneJsonValue(value) {
  return value === undefined ? undefined : structuredClone(value)
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

export function applyIntentExpectedValue(current, expected) {
  if (Array.isArray(expected)) {
    const currentArray = Array.isArray(current) ? current : []
    return expected.map((entry, index) => (
      applyIntentExpectedValue(currentArray[index], entry)
    ))
  }
  if (isObject(expected)) {
    const desired = isObject(current) ? cloneJsonValue(current) : {}
    for (const [key, value] of Object.entries(expected)) {
      desired[key] = applyIntentExpectedValue(desired[key], value)
    }
    return desired
  }
  return cloneJsonValue(expected)
}

function cellPolicies(cell) {
  return Array.isArray(cell?.policies)
    ? cell.policies
    : cell?.policy
      ? [cell.policy]
      : []
}

function cellMatchesPolicy(cell, policyId) {
  return !policyId || cellPolicies(cell).some((policy) => policy.id === policyId)
}

function composedExactExpected(cell) {
  const exactPolicies = cellPolicies(cell)
    .filter((policy) => (
      fleetIntentPolicyPresenceConstraint(policy)
        !== FLEET_INTENT_PRESENCE_CONSTRAINT.FORBIDDEN
      && fleetIntentPolicyValueConstraint(policy)
        === FLEET_INTENT_VALUE_CONSTRAINT.EXACT
      && policy.expected
    ))
    .sort((left, right) => left.id.localeCompare(right.id))
  if (exactPolicies.length === 0) return null

  const observed = exactPolicies.filter(
    (policy) => policy.expected.origin !== FLEET_INTENT_EXPECTED_ORIGIN.AUTHORED,
  )
  let value = observed.length > 0
    ? cloneJsonValue(observed[0].expected.value)
    : undefined
  for (const policy of exactPolicies) {
    if (value === undefined) value = cloneJsonValue(policy.expected.value)
    else if (policy.expected.origin === FLEET_INTENT_EXPECTED_ORIGIN.AUTHORED) {
      value = applyIntentExpectedValue(value, policy.expected.value)
    }
  }
  const resolutionCanonicals = new Set(
    exactPolicies
      .map((policy) => policy.expected.resolutionCanonical)
      .filter(Boolean),
  )
  return {
    policies: exactPolicies,
    resolutionCanonical: resolutionCanonicals.size === 1
      ? [...resolutionCanonicals][0]
      : null,
    value,
  }
}

function blocker(cell, reason) {
  return {
    reason,
    zoneId: cell.zone.meta.id,
    zoneName: cell.zone.meta.name,
  }
}

function target(cell, kind, options = {}) {
  return {
    ...options,
    kind,
    zoneId: cell.zone.meta.id,
    zoneName: cell.zone.meta.name,
  }
}

function removalTarget(row, cell, currentCell) {
  if (currentCell?.action?.type === "dns-records"
    && currentCell.action.recordIds.length > 0
    && row.category === DNS_RECORD_CATEGORY) {
    if (!Array.isArray(currentCell.inspectionValue)
      || currentCell.action.recordIds.length !== currentCell.inspectionValue.length) {
      return blocker(
        cell,
        "One or more present DNS records do not have a reversible removal adapter",
      )
    }
    return target(cell, INTENT_ALIGNMENT_TARGET_KIND.DELETE_DNS_RECORDS, {
      action: currentCell.action,
    })
  }
  if (currentCell?.action?.type === "ruleset-rule"
    && RULE_CATEGORIES.has(row.category)) {
    return target(cell, INTENT_ALIGNMENT_TARGET_KIND.DELETE_RULE, {
      action: currentCell.action,
    })
  }
  return blocker(
    cell,
    "Forbidden intent has no reversible removal adapter for this facet",
  )
}

function fillTarget(row, cell, exact) {
  if (!exact.resolutionCanonical) {
    return blocker(
      cell,
      "Exact intent has no portable observed source for this missing facet",
    )
  }
  const resolution = row.missingResolutions.get(cell.zone.meta.name)
  const candidate = resolution?.candidates?.find(
    (entry) => entry.canonical === exact.resolutionCanonical,
  )
  if (!resolution?.available || !candidate) {
    return blocker(
      cell,
      resolution?.reason || "No live fleet source matches the exact intent value",
    )
  }
  if (resolution.kind === HOLE_RESOLUTION_KIND.DNS_RECORDS) {
    return target(cell, INTENT_ALIGNMENT_TARGET_KIND.FILL_DNS_RECORDS, {
      candidate,
      expected: exact,
    })
  }
  if (resolution.kind === HOLE_RESOLUTION_KIND.RULESET_RULE) {
    return target(cell, INTENT_ALIGNMENT_TARGET_KIND.FILL_RULE, {
      candidate,
      expected: exact,
    })
  }
  return blocker(
    cell,
    "This missing facet requires a product-specific workflow instead of exact intent alignment",
  )
}

function emailRoutingSettingId(row) {
  if (row.category !== EMAIL_CATEGORY
    || !row.key.startsWith(EMAIL_SETTING_KEY_PREFIX)) return null
  return row.key.slice(EMAIL_SETTING_KEY_PREFIX.length)
}

function emailRoutingSettingTarget(row, cell, exact) {
  const settingId = emailRoutingSettingId(row)
  if (!settingId) return null
  if (!EMAIL_ROUTING_WRITABLE_SETTINGS.has(settingId)) {
    return blocker(
      cell,
      settingId === "enabled"
        ? "Email Routing enabled state requires the coupled Email alignment workflow"
        : settingId === "status"
          ? "Cloudflare reports Email Routing status as read-only"
          : settingId === EMAIL_ROUTING_SETTING.SKIP_WIZARD
            ? "Cloudflare reports skip_wizard as configuration-wizard metadata; it is inspection-only"
          : `Email Routing setting ${settingId} has no direct alignment adapter`,
    )
  }
  if (typeof exact.value !== "boolean") {
    return blocker(
      cell,
      `Exact Email Routing ${settingId} intent must be a boolean`,
    )
  }
  return target(cell, INTENT_ALIGNMENT_TARGET_KIND.EDIT_EMAIL_SETTING, {
    expected: exact,
    settingId,
  })
}

function editTarget(row, cell, currentCell, exact) {
  if (isZoneAliasMatrixRow(row)) {
    const desiredValue = materializeValue(exact.value, cell.zone.meta.name)
    const reason = zoneAliasAlignmentBlocker(
      currentCell?.alignmentAction,
      currentCell?.intentValue,
      desiredValue,
    )
    return reason
      ? blocker(cell, reason)
      : target(cell, INTENT_ALIGNMENT_TARGET_KIND.ZONE_ALIAS, {
          action: currentCell.alignmentAction,
          expected: exact,
        })
  }
  if (row.category === EMAIL_DNS_SPECIFICATION_CATEGORY) {
    return blocker(
      cell,
      "Email DNS specifications are generated by Cloudflare and require the Email alignment workflow",
    )
  }
  if (rowSupportsDnssecIntentCorrection(row)) {
    const desiredStatus = dnssecDesiredStatus({ value: exact.value })
    return desiredStatus
      ? target(cell, INTENT_ALIGNMENT_TARGET_KIND.SET_DNSSEC_STATUS, {
          desiredStatus,
          expected: exact,
        })
      : blocker(cell, "Exact DNSSEC intent does not contain a writable requested status")
  }
  const emailSetting = emailRoutingSettingTarget(row, cell, exact)
  if (emailSetting) return emailSetting
  const action = currentCell?.action
  if (action?.type === "zone-setting" && row.category === ZONE_SETTING_CATEGORY) {
    return target(cell, INTENT_ALIGNMENT_TARGET_KIND.EDIT_SETTING, {
      action,
      expected: exact,
    })
  }
  if (action?.type === EMAIL_ROUTING_ACTION_KIND.RULE_EDIT) {
    return target(cell, INTENT_ALIGNMENT_TARGET_KIND.EDIT_EMAIL_RULE, {
      action,
      expected: exact,
    })
  }
  if (action?.type === "ruleset-rule" && RULE_CATEGORIES.has(row.category)) {
    return target(cell, INTENT_ALIGNMENT_TARGET_KIND.EDIT_RULE, {
      action,
      expected: exact,
    })
  }
  if (action?.type === "dns-records" && row.category === DNS_RECORD_CATEGORY) {
    const desiredRecords = exact.value
    const currentRecords = currentCell.inspectionValue
    if (!Array.isArray(desiredRecords) || !Array.isArray(currentRecords)) {
      return blocker(cell, "Exact DNS intent does not contain a record set")
    }
    if (action.recordIds.length !== currentRecords.length) {
      return blocker(cell, "One or more present DNS records do not have a direct edit adapter")
    }
    if (desiredRecords.length !== currentRecords.length) {
      return blocker(
        cell,
        "This DNS drift requires mixed record creation or removal and cannot be aligned as a direct edit",
      )
    }
    return target(cell, INTENT_ALIGNMENT_TARGET_KIND.EDIT_DNS_RECORDS, {
      action,
      expected: exact,
    })
  }
  return blocker(cell, "This present facet has no direct exact-value alignment adapter")
}

function alignmentForCell(row, cell) {
  if (cell.status === FLEET_INTENT_CELL_STATUS.CONFLICT) {
    return blocker(cell, "Overlapping fleet intent policies conflict on this cell")
  }
  const policies = cellPolicies(cell)
  if (policies.some((policy) => (
    fleetIntentPolicyValueConstraint(policy)
      === FLEET_INTENT_VALUE_CONSTRAINT.MUST_DIFFER
  ))) {
    return blocker(cell, "Must-differ intent requires a distinct value chosen for this zone")
  }
  const currentCell = row.cells.get(cell.zone.meta.name) || null
  if (policies.some((policy) => (
    fleetIntentPolicyPresenceConstraint(policy)
      === FLEET_INTENT_PRESENCE_CONSTRAINT.FORBIDDEN
  ))) {
    return removalTarget(row, cell, currentCell)
  }
  const exact = composedExactExpected(cell)
  if (!exact) {
    return blocker(
      cell,
      "Required intent allows multiple values, so alignment needs an explicit value choice",
    )
  }
  if (!currentCell) return fillTarget(row, cell, exact)
  return editTarget(row, cell, currentCell, exact)
}

function alignmentReason(targets, blockers, actionableCount, unresolved) {
  if (unresolved) return "One or more policies reference zones or facets outside the loaded fleet"
  if (actionableCount === 0) return "No unacknowledged fleet intent drift is present"
  if (blockers.length > 0) {
    const details = blockers
      .map((entry) => `${entry.zoneName}: ${entry.reason}`)
      .join("; ")
    return `Complete alignment is blocked. ${details}`
  }
  return `${targets.length} drifting ${targets.length === 1 ? "cell is" : "cells are"} ready for live review`
}

export function assessIntentAlignment(row, options = {}) {
  const policyId = options.policyId || null
  const zoneIds = options.zoneIds ? new Set(options.zoneIds) : null
  const actionableCells = [...(row?.intentState?.cells.values() || [])]
    .filter((cell) => ACTIONABLE_CELL_STATUSES.has(cell.status))
    .filter((cell) => cellMatchesPolicy(cell, policyId))
    .filter((cell) => !zoneIds || zoneIds.has(cell.zone.meta.id))
  const results = actionableCells.map((cell) => alignmentForCell(row, cell))
  const blockers = results.filter((entry) => !entry.kind)
  const targets = results.filter((entry) => entry.kind)
  const unresolved = Boolean(row?.intentState?.unresolved)
  return {
    actionableCount: actionableCells.length,
    available: actionableCells.length > 0
      && blockers.length === 0
      && !unresolved,
    blockers,
    policyId,
    reason: alignmentReason(
      targets,
      blockers,
      actionableCells.length,
      unresolved,
    ),
    targets,
    zoneIds: zoneIds ? [...zoneIds] : null,
  }
}

export function intentAlignmentReadRequirement(row) {
  if (isZoneAliasMatrixRow(row)) {
    return inventoryRead({
      accountSurfaceIds: ZONE_ALIAS_REQUIRED_ACCOUNT_SURFACE_IDS,
      includeEmailAddresses: false,
      includeRuleDetails: true,
      ruleDetailKinds: [RULESET_KIND.ZONE, RULESET_KIND.CUSTOM],
      surfaceIds: ZONE_ALIAS_REQUIRED_SURFACE_IDS,
    })
  }
  if (rowSupportsDnssecIntentCorrection(row)) {
    return inventoryRead({
      includeEmailAddresses: false,
      surfaceIds: ["dnssec"],
    })
  }
  if (row.category === ZONE_SETTING_CATEGORY) {
    return inventoryRead({
      includeEmailAddresses: false,
      surfaceIds: ["settings"],
    })
  }
  if (row.category === DNS_RECORD_CATEGORY) {
    return inventoryRead({
      includeEmailAddresses: false,
      surfaceIds: ["dns"],
    })
  }
  if (emailRoutingSettingId(row)) {
    return inventoryRead({
      includeEmailAddresses: false,
      surfaceIds: ["email"],
    })
  }
  if (row.category === EMAIL_ROUTE_CATEGORY) {
    return inventoryRead({
      includeEmailAddresses: false,
      surfaceIds: ["email-rules"],
    })
  }
  if (row.category === EMAIL_CATEGORY && row.key === EMAIL_CATCH_ALL_KEY) {
    return inventoryRead({
      includeEmailAddresses: false,
      surfaceIds: ["email-catch-all"],
    })
  }
  if (RULE_CATEGORIES.has(row.category)) {
    if (!row.phase) throw new UnsupportedIntentAlignmentFacetError("Ruleset intent alignment requires an explicit phase")
    return inventoryRead({
      includeEmailAddresses: false,
      includeRuleDetails: true,
      ruleDetailKinds: [RULESET_KIND.ZONE, RULESET_KIND.CUSTOM],
      ruleDetailPhases: [row.phase],
      surfaceIds: ["rulesets"],
    })
  }
  throw new UnsupportedIntentAlignmentFacetError()
}

function resultFor(zone, surfaceId) {
  const surface = zone.surfaces?.[surfaceId]
  return surface?.ok ? surface.result : null
}

function requiredZone(zonesById, zoneId) {
  const zone = zonesById.get(zoneId)
  if (!zone) throw new Error(`Alignment target zone is unavailable: ${zoneId}`)
  return zone
}

function requiredRuleset(zone, action) {
  const ruleset = zone.ruleDetails
    .filter((detail) => detail.ok)
    .map((detail) => detail.result)
    .find((entry) => entry.id === action.rulesetId)
  if (!ruleset) throw new Error(`Ruleset ${action.rulesetId} is unavailable on ${zone.meta.name}`)
  return ruleset
}

function requiredRule(zone, action) {
  const ruleset = requiredRuleset(zone, action)
  const rule = ruleset.rules?.find((entry) => entry.id === action.ruleId)
  if (!rule) throw new Error(`Rule ${action.ruleId} is unavailable on ${zone.meta.name}`)
  return { rule, ruleset }
}

function requiredEmailRule(zone, action) {
  if (action.catchAll) {
    const catchAll = resultFor(zone, "email-catch-all")
    if (!catchAll) throw new Error(`Catch-all rule is unavailable on ${zone.meta.name}`)
    return catchAll
  }
  const rule = (resultFor(zone, "email-rules") || [])
    .find((entry) => entry.id === action.ruleId)
  if (!rule) throw new Error(`Email Routing rule ${action.ruleId} is unavailable on ${zone.meta.name}`)
  return rule
}

function requiredDnsRecords(zone, recordIds) {
  const records = resultFor(zone, "dns")
  if (!Array.isArray(records)) {
    throw new Error(`DNS records are unavailable on ${zone.meta.name}`)
  }
  return recordIds.map((recordId) => {
    const record = records.find((entry) => entry.id === recordId)
    if (!record) throw new Error(`DNS record ${recordId} is unavailable on ${zone.meta.name}`)
    return record
  })
}

function targetPlans(targetDefinition, zonesById) {
  const zone = requiredZone(zonesById, targetDefinition.zoneId)
  if (targetDefinition.kind === INTENT_ALIGNMENT_TARGET_KIND.ZONE_ALIAS) {
    const desired = materializeValue(
      targetDefinition.expected.value,
      zone.meta.name,
    )
    return [buildZoneAliasAlignmentPlan(
      zone,
      targetDefinition.action,
      desired,
    )]
  }
  if (targetDefinition.kind === INTENT_ALIGNMENT_TARGET_KIND.EDIT_SETTING) {
    const desired = applyIntentExpectedValue(
      targetDefinition.action.value,
      materializeValue(targetDefinition.expected.value, zone.meta.name),
    )
    return [buildZoneSettingPlan(
      zone,
      targetDefinition.action.settingId,
      desired,
    )]
  }
  if (targetDefinition.kind === INTENT_ALIGNMENT_TARGET_KIND.SET_DNSSEC_STATUS) {
    return [buildDnssecStatusPlan(zone, targetDefinition.desiredStatus)]
  }
  if (targetDefinition.kind === INTENT_ALIGNMENT_TARGET_KIND.EDIT_EMAIL_RULE) {
    const liveRule = requiredEmailRule(zone, targetDefinition.action)
    const options = { catchAll: Boolean(targetDefinition.action.catchAll) }
    const current = editableEmailRoutingRulePayload(liveRule, options)
    const desired = applyIntentExpectedValue(
      current,
      materializeValue(targetDefinition.expected.value, zone.meta.name),
    )
    return [buildEmailRoutingRuleEditPlan(zone, liveRule, desired, options)]
  }
  if (targetDefinition.kind === INTENT_ALIGNMENT_TARGET_KIND.EDIT_EMAIL_SETTING) {
    const desired = materializeValue(
      targetDefinition.expected.value,
      zone.meta.name,
    )
    return [buildEmailRoutingSettingPlan(
      zone,
      targetDefinition.settingId,
      desired,
    )]
  }
  if (targetDefinition.kind === INTENT_ALIGNMENT_TARGET_KIND.EDIT_RULE) {
    const { rule } = requiredRule(zone, targetDefinition.action)
    const desired = applyIntentExpectedValue(
      editableRulePayload(rule),
      materializeValue(targetDefinition.expected.value, zone.meta.name),
    )
    return [buildRuleEditPlan(zone, targetDefinition.action, desired)]
  }
  if (targetDefinition.kind === INTENT_ALIGNMENT_TARGET_KIND.DELETE_RULE) {
    const { ruleset } = requiredRule(zone, targetDefinition.action)
    return [buildRuleDeletePlan(
      zone,
      ruleset,
      targetDefinition.action.ruleId,
    )]
  }
  if (targetDefinition.kind === INTENT_ALIGNMENT_TARGET_KIND.EDIT_DNS_RECORDS) {
    const records = requiredDnsRecords(zone, targetDefinition.action.recordIds)
    const expected = materializeValue(
      targetDefinition.expected.value,
      zone.meta.name,
    )
    return records.map((record, index) => buildDnsRecordEditPlan(
      zone,
      record,
      applyIntentExpectedValue(editableDnsRecordPayload(record), expected[index]),
    ))
  }
  if (targetDefinition.kind === INTENT_ALIGNMENT_TARGET_KIND.DELETE_DNS_RECORDS) {
    return requiredDnsRecords(zone, targetDefinition.action.recordIds)
      .map((record) => buildDnsRecordDeletePlan(zone, record))
  }
  if (targetDefinition.kind === INTENT_ALIGNMENT_TARGET_KIND.FILL_DNS_RECORDS) {
    const sourceZone = requiredZone(
      zonesById,
      targetDefinition.candidate.sourceZoneId,
    )
    const copyPlan = buildDnsRecordCopyPlan(
      sourceZone,
      zone,
      targetDefinition.candidate.sourceAction.recordIds,
    )
    const expected = materializeValue(
      targetDefinition.expected.value,
      zone.meta.name,
    )
    if (!Array.isArray(expected)
      || expected.length !== copyPlan.operations.length) {
      throw new Error(`Exact DNS intent cannot be mapped to the source records for ${zone.meta.name}`)
    }
    return [{
      ...copyPlan,
      operations: copyPlan.operations.map((operation, index) => ({
        ...operation,
        body: applyIntentExpectedValue(operation.body, expected[index]),
      })),
    }]
  }
  if (targetDefinition.kind === INTENT_ALIGNMENT_TARGET_KIND.FILL_RULE) {
    const sourceZone = requiredZone(
      zonesById,
      targetDefinition.candidate.sourceZoneId,
    )
    return buildRuleCopyPlans(
      sourceZone,
      [zone],
      targetDefinition.candidate.sourceAction,
    ).map((plan) => ({
      ...plan,
      operations: plan.operations.map((operation) => {
        const expected = materializeValue(
          targetDefinition.expected.value,
          zone.meta.name,
        )
        const body = Array.isArray(operation.body?.rules)
          ? {
              ...operation.body,
              rules: operation.body.rules.map((rule) => (
                applyIntentExpectedValue(rule, expected)
              )),
            }
          : applyIntentExpectedValue(operation.body, expected)
        return {
          ...operation,
          body,
        }
      }),
    }))
  }
  throw new Error(`Unsupported intent alignment target: ${targetDefinition.kind}`)
}

export function buildIntentAlignmentPlans(inventory, row, assessment) {
  if (!assessment?.available) {
    throw new Error(assessment?.reason || "Intent alignment is unavailable")
  }
  const zonesById = new Map(
    inventory.zones.map((zone) => [zone.meta.id, zone]),
  )
  return assessment.targets
    .map((targetDefinition) => {
      const zone = requiredZone(zonesById, targetDefinition.zoneId)
      const plans = targetPlans(targetDefinition, zonesById)
      return {
        id: `intent-alignment:${row.category}:${row.key}:${zone.meta.id}`,
        kind: "intent-alignment",
        operations: plans.flatMap((plan) => plan.operations),
        summary: `Align ${row.label} on ${zone.meta.name}`,
        zoneId: zone.meta.id,
        zoneName: zone.meta.name,
      }
    })
    .sort((left, right) => left.zoneName.localeCompare(right.zoneName))
}
