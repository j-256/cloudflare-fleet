import { emailPolicyExceptionsForZone } from "./fleet-policy.mjs"
import {
  fleetChangeSchema,
  fleetChangesSchema,
} from "./interface-schemas.mjs"
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
import { createReviewedPlanSet } from "./reviewed-plan.mjs"
import { stableString } from "./normalize.mjs"

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
const FLEET_CHANGE_BATCH_TITLE = "Apply bounded fleet change batch"

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

export function normalizeFleetChanges(value) {
  const parsed = fleetChangesSchema.safeParse(value)
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "changes"}: ${issue.message}`)
      .join("; ")
    throw new TypeError(`Fleet change batch is invalid: ${detail}`)
  }
  const changes = parsed.data.map(normalizeFleetChange)
  assertUnique(changes.map(stableString), "Fleet change requests")
  return changes
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

function operationCount(plans) {
  return plans.reduce(
    (total, plan) => total + plan.operations.length,
    0,
  )
}

async function prepareChangePlans(change, reads, options) {
  let plans
  try {
    plans = await buildChangePlans(change, reads, options)
  } catch (error) {
    return {
      change,
      plans: [],
      reason: error instanceof Error ? error.message : String(error),
      status: FLEET_CHANGE_STATUS.BLOCKED,
      title: changeTitle(change),
    }
  }
  const count = operationCount(plans)
  return {
    change,
    plans,
    reason: count === 0
      ? "Fresh live state already matches the requested outcome"
      : `${count} bounded Cloudflare write${count === 1 ? "" : "s"} prepared from fresh reads`,
    status: count === 0
      ? FLEET_CHANGE_STATUS.ALIGNED
      : FLEET_CHANGE_STATUS.PLANNED,
    title: changeTitle(change),
  }
}

function readRequirements(changes) {
  return [
    inventoryRead({
      surfaceIds: [],
      zoneIds: unique(changes.flatMap(changeZoneIds)),
    }),
    ...changes.flatMap(changeReadActions).flatMap(readRequirementsForAction),
  ]
}

function publicBatchEntry(entry) {
  const { plans: _plans, ...publicEntry } = entry
  return publicEntry
}

function operationPathOverlap(left, right) {
  const leftPath = left.split("?", 1)[0].replace(/\/$/u, "")
  const rightPath = right.split("?", 1)[0].replace(/\/$/u, "")
  return leftPath === rightPath
    || leftPath.startsWith(`${rightPath}/`)
    || rightPath.startsWith(`${leftPath}/`)
}

function overlappingBatchOperation(plansByChange) {
  const previous = []
  for (const [changeIndex, plans] of plansByChange.entries()) {
    const current = []
    for (const plan of plans) {
      for (const operation of plan.operations) {
        const overlap = previous.find((entry) => (
          operationPathOverlap(entry.operation.path, operation.path)
        ))
        if (overlap) return { changeIndex, operation, previous: overlap }
        current.push({ changeIndex, operation })
      }
    }
    previous.push(...current)
  }
  return null
}

function batchReason(entries, status) {
  if (status === FLEET_CHANGE_STATUS.ALIGNED) {
    return "Every requested change already matches fresh live state"
  }
  if (status === FLEET_CHANGE_STATUS.BLOCKED) {
    return `Fleet change batch is blocked. ${entries
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => entry.status === FLEET_CHANGE_STATUS.BLOCKED)
      .map(({ entry, index }) => `${index + 1}. ${entry.title}: ${entry.reason}`)
      .join("; ")}`
  }
  const planned = entries.filter(
    (entry) => entry.status === FLEET_CHANGE_STATUS.PLANNED,
  )
  const count = operationCount(planned.flatMap((entry) => entry.plans))
  return `${planned.length} requested change${planned.length === 1 ? "" : "s"} prepared as ${count} bounded Cloudflare write${count === 1 ? "" : "s"}`
}

export async function prepareFleetChange(api, value, options = {}) {
  const change = normalizeFleetChange(value)
  const reads = await (options.executeReadPlan || executeReadPlan)(
    api,
    readRequirements([change]),
    {
      onProgress: options.onProgress,
      signal: options.signal,
    },
  )
  const preparation = await prepareChangePlans(change, reads, options)
  if (preparation.status === FLEET_CHANGE_STATUS.BLOCKED) {
    return publicBatchEntry({ ...preparation, planSet: null })
  }
  const planSet = createReviewedPlanSet({
    accountId: api.accountId,
    plans: preparation.plans,
    request: change,
    validatedAt: options.validatedAt,
  })
  return {
    change: preparation.change,
    planSet,
    reason: preparation.reason,
    status: preparation.status,
    title: preparation.title,
  }
}

export async function prepareFleetChanges(api, value, options = {}) {
  const changes = normalizeFleetChanges(value)
  const reads = await (options.executeReadPlan || executeReadPlan)(
    api,
    readRequirements(changes),
    {
      onProgress: options.onProgress,
      signal: options.signal,
    },
  )
  let policyPromise
  const batchOptions = {
    ...options,
    readPolicy() {
      policyPromise ||= Promise.resolve().then(options.readPolicy)
      return policyPromise
    },
  }
  const entries = []
  for (const change of changes) {
    entries.push(await prepareChangePlans(change, reads, batchOptions))
  }
  if (entries.some((entry) => entry.status === FLEET_CHANGE_STATUS.BLOCKED)) {
    return {
      changes: entries.map(publicBatchEntry),
      planSet: null,
      reason: batchReason(entries, FLEET_CHANGE_STATUS.BLOCKED),
      status: FLEET_CHANGE_STATUS.BLOCKED,
      title: FLEET_CHANGE_BATCH_TITLE,
    }
  }
  if (entries.every((entry) => entry.status === FLEET_CHANGE_STATUS.ALIGNED)) {
    return {
      changes: entries.map(publicBatchEntry),
      planSet: null,
      reason: batchReason(entries, FLEET_CHANGE_STATUS.ALIGNED),
      status: FLEET_CHANGE_STATUS.ALIGNED,
      title: FLEET_CHANGE_BATCH_TITLE,
    }
  }
  const overlap = overlappingBatchOperation(
    entries.map((entry) => entry.plans),
  )
  if (overlap) {
    const path = overlap.operation.path
    return {
      changes: entries.map(publicBatchEntry),
      planSet: null,
      reason: `Fleet change batch is blocked because changes ${overlap.previous.changeIndex + 1} and ${overlap.changeIndex + 1} produce overlapping writes at ${path}`,
      status: FLEET_CHANGE_STATUS.BLOCKED,
      title: FLEET_CHANGE_BATCH_TITLE,
    }
  }
  const plans = entries
    .flatMap((entry) => entry.plans)
    .filter((plan) => plan.operations.length > 0)
  const planSet = createReviewedPlanSet({
    accountId: api.accountId,
    plans,
    request: { changes },
    validatedAt: options.validatedAt,
  })
  return {
    changes: entries.map(publicBatchEntry),
    planSet,
    reason: batchReason(entries, FLEET_CHANGE_STATUS.PLANNED),
    status: FLEET_CHANGE_STATUS.PLANNED,
    title: FLEET_CHANGE_BATCH_TITLE,
  }
}
