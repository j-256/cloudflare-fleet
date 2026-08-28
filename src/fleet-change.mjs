import { emailPolicyExceptionsForZone } from "./fleet-policy.mjs"
import { fleetChangeSchema } from "./interface-schemas.mjs"
import {
  buildDnsRecordCopyPlan,
  buildDnsRecordDeletePlan,
  buildDnsRecordEditPlan,
  buildEmailAlignmentPlan,
  buildEmailRoutingRuleEditPlan,
  buildRuleCopyPlans,
  buildRuleCreatePlan,
  buildRuleDeletePlan,
  buildRuleEditPlan,
  buildRuleRenamePlans,
  buildRuleReorderPlan,
  buildRulesetDeletePlan,
  buildRulesetDescriptionPlan,
  buildWafAlignmentPlan,
  buildZoneSettingPlan,
  deriveEmailDestination,
  deriveEmailDnsPolicy,
  deriveFleetWafPolicies,
} from "./policies.mjs"
import {
  actionResourceId,
  executeReadPlan,
  inventoryRead,
  READ_ACTION,
  readRequirementsForAction,
  rulesetPhaseResourceId,
  rulesetResourceId,
} from "./read-composer.mjs"
import {
  createReviewedPlanSet,
  reviewedPlanOperationCount,
} from "./reviewed-plan.mjs"

export const FLEET_CHANGE_STATUS = Object.freeze({
  ALIGNED: "aligned",
  BLOCKED: "blocked",
  PLANNED: "planned",
})

const EMAIL_SURFACE_IDS = Object.freeze([
  "dns",
  "email",
  "email-dns",
  "email-catch-all",
])
const WAF_SURFACE_IDS = Object.freeze(["rulesets"])

function unique(values) {
  return [...new Set(values)]
}

function assertUnique(values, label) {
  if (unique(values).length !== values.length) {
    throw new TypeError(`${label} must be unique`)
  }
}

export function normalizeFleetChange(value) {
  const parsed = fleetChangeSchema.safeParse(value)
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "change"}: ${issue.message}`)
      .join("; ")
    throw new TypeError(`Fleet change is invalid: ${detail}`)
  }
  const change = parsed.data
  if (change.targetZoneIds) {
    assertUnique(change.targetZoneIds, "Target zone identifiers")
    if (change.sourceZoneId
      && change.targetZoneIds.includes(change.sourceZoneId)) {
      throw new TypeError("A source zone cannot also be a target zone")
    }
  }
  if (change.sourceRecordIds) {
    assertUnique(change.sourceRecordIds, "Source DNS record identifiers")
  }
  if (change.rules) {
    const targets = change.rules.map((rule) => (
      `${rule.zoneId}:${rule.rulesetId}:${rule.ruleId}`
    ))
    assertUnique(targets, "Ruleset rule targets")
  }
  return change
}

function changeReadActions(change) {
  if (change.kind === "zone-setting-update") {
    return [{
      settingId: change.settingId,
      type: READ_ACTION.ZONE_SETTING_EDIT,
      zoneId: change.zoneId,
    }]
  }
  if (["dns-record-update", "dns-record-delete"].includes(change.kind)) {
    return [{
      recordId: change.recordId,
      type: READ_ACTION.DNS_RECORD_EDIT,
      zoneId: change.zoneId,
    }]
  }
  if (change.kind === "email-routing-rule-update") {
    return [{
      ruleIdentifier: change.ruleIdentifier,
      type: READ_ACTION.EMAIL_RULE_EDIT,
      zoneId: change.zoneId,
    }]
  }
  if (change.kind.startsWith("ruleset-rule-")
    && !["ruleset-rule-copy", "ruleset-rule-rename"].includes(change.kind)) {
    const type = {
      "ruleset-rule-create": READ_ACTION.RULE_CREATE,
      "ruleset-rule-delete": READ_ACTION.RULE_DELETE,
      "ruleset-rule-reorder": READ_ACTION.RULE_REORDER,
      "ruleset-rule-update": READ_ACTION.RULE_EDIT,
    }[change.kind]
    return [{ ...change, type }]
  }
  if (["ruleset-delete", "ruleset-description-update"].includes(change.kind)) {
    return [{
      ...change,
      type: change.kind === "ruleset-delete"
        ? READ_ACTION.RULESET_DELETE
        : READ_ACTION.RULESET_EDIT,
    }]
  }
  if (change.kind === "dns-record-copy") {
    return change.targetZoneIds.map((targetZoneId) => ({
      sourceZoneId: change.sourceZoneId,
      targetZoneId,
      type: READ_ACTION.DNS_RECORD_COPY,
    }))
  }
  if (change.kind === "ruleset-rule-copy") {
    return [{
      ...change,
      type: READ_ACTION.RULE_COPY,
    }]
  }
  if (change.kind === "ruleset-rule-rename") {
    return [{
      rules: change.rules,
      type: READ_ACTION.RULE_RENAME,
    }]
  }
  if (change.kind === "email-routing-align") {
    return [{ type: READ_ACTION.EMAIL_ALIGNMENT }]
  }
  if (change.kind === "shared-waf-align") {
    return [{ type: READ_ACTION.WAF_ALIGNMENT }]
  }
  throw new TypeError(`No read plan is defined for ${change.kind}`)
}

function changeZoneIds(change) {
  if (change.zoneId) return [change.zoneId]
  if (change.rules) return unique(change.rules.map((rule) => rule.zoneId))
  if (change.sourceZoneId) {
    return unique([change.sourceZoneId, ...change.targetZoneIds])
  }
  return change.zoneIds
}

function selectedLiveZones(inventory, zoneIds) {
  const byId = new Map(inventory.zones.map((zone) => [zone.meta.id, zone]))
  const missing = zoneIds.filter((zoneId) => !byId.has(zoneId))
  if (missing.length > 0) {
    throw new Error(`One or more selected zones no longer exist: ${missing.join(", ")}`)
  }
  return zoneIds.map((zoneId) => byId.get(zoneId))
}

function assertSurfaceReads(inventory, surfaceIds, label) {
  const failures = inventory.zones.flatMap((zone) => surfaceIds
    .filter((surfaceId) => !zone.surfaces[surfaceId]?.ok)
    .map((surfaceId) => `${zone.meta.name}: ${surfaceId}`))
  if (failures.length > 0) {
    throw new Error(`${label} live validation could not read ${failures.join(", ")}`)
  }
}

function rulesetZone(reads, change) {
  const zone = selectedLiveZones(reads.inventory, [change.zoneId])[0]
  if (change.kind === "ruleset-rule-create") {
    const detail = zone.ruleDetails.find(
      (entry) => entry.ok && entry.result?.id === change.rulesetId,
    )
    if (!detail) throw new Error("Live validation returned no target ruleset detail")
    return { ruleset: detail.result, zone }
  }
  const ruleset = reads.resources.get(
    rulesetResourceId(change.zoneId, change.rulesetId),
  )
  if (!ruleset) throw new Error("Live validation returned no target ruleset detail")
  return {
    ruleset,
    zone: {
      ...zone,
      ruleDetails: [{ ok: true, result: ruleset }],
    },
  }
}

async function buildChangePlans(change, reads, options) {
  const zones = selectedLiveZones(reads.inventory, changeZoneIds(change))
  const zonesById = new Map(zones.map((zone) => [zone.meta.id, zone]))
  if (change.kind === "zone-setting-update") {
    const readAction = changeReadActions(change)[0]
    const setting = reads.resources.get(actionResourceId(readAction))
    const zone = zonesById.get(change.zoneId)
    return [buildZoneSettingPlan({
      ...zone,
      surfaces: {
        ...zone.surfaces,
        settings: { ok: true, result: [setting], status: 200 },
      },
    }, change.settingId, change.desired)]
  }
  if (["dns-record-update", "dns-record-delete"].includes(change.kind)) {
    const record = reads.resources.get(actionResourceId(changeReadActions(change)[0]))
    const zone = zonesById.get(change.zoneId)
    return [change.kind === "dns-record-update"
      ? buildDnsRecordEditPlan(zone, record, change.desired)
      : buildDnsRecordDeletePlan(zone, record)]
  }
  if (change.kind === "email-routing-rule-update") {
    const liveRule = reads.resources.get(actionResourceId(changeReadActions(change)[0]))
    return [buildEmailRoutingRuleEditPlan(
      zonesById.get(change.zoneId),
      liveRule,
      change.desired,
      { catchAll: change.catchAll },
    )]
  }
  if ([
    "ruleset-rule-create",
    "ruleset-rule-update",
    "ruleset-rule-delete",
    "ruleset-rule-reorder",
    "ruleset-description-update",
    "ruleset-delete",
  ].includes(change.kind)) {
    const { ruleset, zone } = rulesetZone(reads, change)
    if (change.kind === "ruleset-rule-create") {
      return [buildRuleCreatePlan(zone, ruleset, change.desired)]
    }
    if (change.kind === "ruleset-rule-update") {
      return [buildRuleEditPlan(zone, change, change.desired)]
    }
    if (change.kind === "ruleset-rule-delete") {
      return [buildRuleDeletePlan(zone, ruleset, change.ruleId)]
    }
    if (change.kind === "ruleset-rule-reorder") {
      return [buildRuleReorderPlan(
        zone,
        ruleset,
        change.ruleId,
        change.position - 1,
      )]
    }
    if (change.kind === "ruleset-description-update") {
      return [buildRulesetDescriptionPlan(zone, ruleset, change.description)]
    }
    return [buildRulesetDeletePlan(zone, ruleset)]
  }
  if (change.kind === "dns-record-copy") {
    const source = zonesById.get(change.sourceZoneId)
    return change.targetZoneIds.map((zoneId) => buildDnsRecordCopyPlan(
      source,
      zonesById.get(zoneId),
      change.sourceRecordIds,
    ))
  }
  if (change.kind === "ruleset-rule-copy") {
    const sourceRuleset = reads.resources.get(
      rulesetResourceId(change.sourceZoneId, change.rulesetId),
    )
    if (!sourceRuleset) throw new Error("Live validation returned no source ruleset detail")
    const sourceZone = {
      ...zonesById.get(change.sourceZoneId),
      ruleDetails: [{ ok: true, result: sourceRuleset }],
    }
    const targetZones = change.targetZoneIds.map((zoneId) => {
      const phase = reads.rulePhases.get(
        rulesetPhaseResourceId(zoneId, change.phase),
      )
      if (!phase) throw new Error(`Live validation returned no ${change.phase} target detail`)
      return {
        ...zonesById.get(zoneId),
        ruleDetails: phase.details.map((ruleset) => ({ ok: true, result: ruleset })),
      }
    })
    return buildRuleCopyPlans(sourceZone, targetZones, change)
  }
  if (change.kind === "ruleset-rule-rename") {
    const rulesByZone = new Map()
    for (const rule of change.rules) {
      if (!rulesByZone.has(rule.zoneId)) rulesByZone.set(rule.zoneId, [])
      rulesByZone.get(rule.zoneId).push(rule)
    }
    const liveZones = zones.map((zone) => ({
      ...zone,
      ruleDetails: unique(
        rulesByZone.get(zone.meta.id).map((rule) => rule.rulesetId),
      ).map((rulesetId) => {
        const ruleset = reads.resources.get(
          rulesetResourceId(zone.meta.id, rulesetId),
        )
        if (!ruleset) throw new Error(`Live validation returned no ruleset ${rulesetId}`)
        return { ok: true, result: ruleset }
      }),
    }))
    return buildRuleRenamePlans(liveZones, change.rules, change.desiredName)
  }
  if (change.kind === "email-routing-align") {
    assertSurfaceReads(reads.inventory, EMAIL_SURFACE_IDS, "Email Routing")
    if (!reads.inventory.account.emailAddresses.ok) {
      throw new Error("Email Routing live validation could not read verified account addresses")
    }
    const destination = deriveEmailDestination(reads.inventory)
    const dnsPolicy = deriveEmailDnsPolicy(reads.inventory)
    if (!destination.available) throw new Error(destination.reason)
    if (!dnsPolicy.available) throw new Error(dnsPolicy.reason)
    const policy = await options.readPolicy()
    return change.zoneIds.map((zoneId) => {
      const zone = zonesById.get(zoneId)
      return buildEmailAlignmentPlan(zone, destination.email, dnsPolicy, {
        exceptions: emailPolicyExceptionsForZone(zone.meta.name, policy),
      })
    })
  }
  if (change.kind === "shared-waf-align") {
    assertSurfaceReads(reads.inventory, WAF_SURFACE_IDS, "Shared WAF")
    const detailFailures = reads.inventory.zones.flatMap((zone) => zone.ruleDetails
      .filter((detail) => !detail.ok)
      .map(() => zone.meta.name))
    if (detailFailures.length > 0) {
      throw new Error(`Shared WAF live validation could not read rule details for ${detailFailures.join(", ")}`)
    }
    const policies = deriveFleetWafPolicies(reads.inventory)
    const unavailable = [...policies.values()].find((policy) => !policy.available)
    if (unavailable) throw new Error(unavailable.reason)
    return change.zoneIds.map((zoneId) => (
      buildWafAlignmentPlan(zonesById.get(zoneId), policies)
    ))
  }
  throw new TypeError(`No plan builder is defined for ${change.kind}`)
}

function changeTitle(change) {
  return {
    "dns-record-copy": "Copy DNS records",
    "dns-record-delete": "Delete DNS record",
    "dns-record-update": "Update DNS record",
    "email-routing-align": "Align Email Routing",
    "email-routing-rule-update": "Update Email Routing rule",
    "ruleset-delete": "Delete empty ruleset",
    "ruleset-description-update": "Update ruleset description",
    "ruleset-rule-copy": "Copy ruleset rule",
    "ruleset-rule-create": "Create ruleset rule",
    "ruleset-rule-delete": "Delete ruleset rule",
    "ruleset-rule-rename": "Rename ruleset rules",
    "ruleset-rule-reorder": "Reorder ruleset rule",
    "ruleset-rule-update": "Update ruleset rule",
    "shared-waf-align": "Align shared WAF rules",
    "zone-setting-update": "Update zone setting",
  }[change.kind]
}

export async function prepareFleetChange(api, value, options = {}) {
  const change = normalizeFleetChange(value)
  const actions = changeReadActions(change)
  const requirements = [
    inventoryRead({
      surfaceIds: [],
      zoneIds: changeZoneIds(change),
    }),
    ...actions.flatMap(readRequirementsForAction),
  ]
  const reads = await (options.executeReadPlan || executeReadPlan)(
    api,
    requirements,
    {
      onProgress: options.onProgress,
      signal: options.signal,
    },
  )
  let plans
  try {
    plans = await buildChangePlans(change, reads, options)
  } catch (error) {
    return {
      change,
      planSet: null,
      reason: error instanceof Error ? error.message : String(error),
      status: FLEET_CHANGE_STATUS.BLOCKED,
      title: changeTitle(change),
    }
  }
  const planSet = createReviewedPlanSet({
    accountId: api.accountId,
    plans,
    request: change,
    validatedAt: options.validatedAt,
  })
  const operationCount = reviewedPlanOperationCount(planSet)
  return {
    change,
    planSet,
    reason: operationCount === 0
      ? "Fresh live state already matches the requested outcome"
      : `${operationCount} bounded Cloudflare write${operationCount === 1 ? "" : "s"} prepared from fresh reads`,
    status: operationCount === 0
      ? FLEET_CHANGE_STATUS.ALIGNED
      : FLEET_CHANGE_STATUS.PLANNED,
    title: changeTitle(change),
  }
}
