import { loadInventory } from "./inventory.mjs"
import {
  FLEET_ACTION_KIND,
  WAF_PHASE,
} from "./constants.mjs"

const REQUIREMENT_KIND = Object.freeze({
  INVENTORY: "inventory",
  RESOURCE: "resource",
  RULESET_PHASE: "ruleset-phase",
})
export const READ_ACTION = Object.freeze({
  DNS_RECORD_COPY: "dns-record-copy",
  DNS_RECORD_EDIT: "dns-record-edit",
  EMAIL_ALIGNMENT: "email-alignment",
  RULE_COPY: "ruleset-rule-copy",
  RULE_EDIT: "ruleset-rule",
  RULE_RENAME: FLEET_ACTION_KIND.RULE_RENAME,
  WAF_ALIGNMENT: "waf-alignment",
  ZONE_SETTING_EDIT: "zone-setting",
})
const EMAIL_SURFACE_IDS = Object.freeze([
  "dns",
  "email",
  "email-dns",
  "email-catch-all",
])
const RULESET_SURFACE_IDS = Object.freeze([
  "rulesets",
])
export const READ_ACTION_SURFACES = Object.freeze({
  [READ_ACTION.EMAIL_ALIGNMENT]: EMAIL_SURFACE_IDS,
  [READ_ACTION.WAF_ALIGNMENT]: RULESET_SURFACE_IDS,
})

function unique(values = []) {
  return [...new Set(values)]
}

function requiredIdentifier(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label} is required`)
  }
  return value
}

function mergeOptionalFilter(current, incoming) {
  if (current === null || incoming === undefined) return null
  return unique([...current, ...incoming])
}

export function inventoryRead(options = {}) {
  return {
    includeEmailAddresses: Boolean(options.includeEmailAddresses),
    includeRuleDetails: Boolean(options.includeRuleDetails),
    kind: REQUIREMENT_KIND.INVENTORY,
    ruleDetailKinds: options.ruleDetailKinds === undefined
      ? undefined
      : unique(options.ruleDetailKinds),
    ruleDetailPhases: options.ruleDetailPhases === undefined
      ? undefined
      : unique(options.ruleDetailPhases),
    surfaceIds: unique(options.surfaceIds),
    zoneIds: options.zoneIds === undefined ? undefined : unique(options.zoneIds),
  }
}

export function resourceRead(id, path) {
  if (typeof id !== "string" || id.length === 0) {
    throw new TypeError("Resource read identifier is required")
  }
  if (typeof path !== "string" || path.length === 0) {
    throw new TypeError("Resource read path is required")
  }
  return {
    id,
    kind: REQUIREMENT_KIND.RESOURCE,
    path,
  }
}

export function rulesetResourceId(zoneId, rulesetId) {
  return `ruleset:${requiredIdentifier(zoneId, "Ruleset zone identifier")}:${requiredIdentifier(rulesetId, "Ruleset identifier")}`
}

export function rulesetPhaseResourceId(zoneId, phase) {
  return `ruleset-phase:${requiredIdentifier(zoneId, "Ruleset phase zone identifier")}:${requiredIdentifier(phase, "Ruleset phase")}`
}

export function rulesetPhaseRead(zoneId, phase, options = {}) {
  requiredIdentifier(zoneId, "Ruleset phase zone identifier")
  requiredIdentifier(phase, "Ruleset phase")
  const kinds = unique(options.kinds || ["zone"])
  if (kinds.length === 0) throw new TypeError("At least one ruleset kind is required")
  return {
    id: rulesetPhaseResourceId(zoneId, phase),
    kind: REQUIREMENT_KIND.RULESET_PHASE,
    kinds,
    phase,
    zoneId,
  }
}

function zoneResourcePath(zoneId, ...segments) {
  return ["zones", zoneId, ...segments].map(encodeURIComponent).join("/")
}

export function actionResourceId(action) {
  if (action.type === READ_ACTION.ZONE_SETTING_EDIT) {
    return `setting:${requiredIdentifier(action.zoneId, "Zone setting zone identifier")}:${requiredIdentifier(action.settingId, "Zone setting identifier")}`
  }
  if (action.type === READ_ACTION.DNS_RECORD_EDIT) {
    return `dns-record:${requiredIdentifier(action.zoneId, "DNS record zone identifier")}:${requiredIdentifier(action.recordId, "DNS record identifier")}`
  }
  if (action.type === READ_ACTION.RULE_EDIT) {
    return rulesetResourceId(action.zoneId, action.rulesetId)
  }
  return null
}

export function readRequirementsForAction(action) {
  if (action.type === READ_ACTION.EMAIL_ALIGNMENT) {
    return [
      inventoryRead({
        includeEmailAddresses: true,
        surfaceIds: EMAIL_SURFACE_IDS,
      }),
    ]
  }
  if (action.type === READ_ACTION.WAF_ALIGNMENT) {
    return [
      inventoryRead({
        includeRuleDetails: true,
        ruleDetailKinds: ["zone", "custom"],
        ruleDetailPhases: [WAF_PHASE],
        surfaceIds: RULESET_SURFACE_IDS,
      }),
    ]
  }
  if (action.type === READ_ACTION.DNS_RECORD_COPY) {
    const sourceZoneId = requiredIdentifier(
      action.sourceZoneId,
      "DNS record copy source zone identifier",
    )
    const targetZoneId = requiredIdentifier(
      action.targetZoneId,
      "DNS record copy target zone identifier",
    )
    return [
      inventoryRead({
        surfaceIds: ["dns"],
        zoneIds: [sourceZoneId, targetZoneId],
      }),
    ]
  }
  if (action.type === READ_ACTION.RULE_COPY) {
    const sourceZoneId = requiredIdentifier(
      action.sourceZoneId || action.zoneId,
      "Rule copy source zone identifier",
    )
    const rulesetId = requiredIdentifier(action.rulesetId, "Rule copy source ruleset identifier")
    const phase = requiredIdentifier(action.phase, "Rule copy phase")
    const targetZoneIds = action.targetZoneIds || []
    const phaseKinds = phase === WAF_PHASE
      ? ["zone", "custom"]
      : ["zone"]
    return [
      inventoryRead({
        surfaceIds: [],
        zoneIds: [sourceZoneId, ...targetZoneIds],
      }),
      resourceRead(
        rulesetResourceId(sourceZoneId, rulesetId),
        zoneResourcePath(sourceZoneId, "rulesets", rulesetId),
      ),
      ...targetZoneIds.map(
        (zoneId) => rulesetPhaseRead(zoneId, phase, { kinds: phaseKinds }),
      ),
    ]
  }
  if (action.type === READ_ACTION.RULE_RENAME) {
    if (!Array.isArray(action.rules) || action.rules.length === 0) {
      throw new TypeError("Fleet rule rename requires at least one rule")
    }
    const rules = action.rules.map((rule) => ({
      phase: requiredIdentifier(rule.phase, "Rule rename phase"),
      ruleId: requiredIdentifier(rule.ruleId, "Rule rename rule identifier"),
      rulesetId: requiredIdentifier(rule.rulesetId, "Rule rename ruleset identifier"),
      zoneId: requiredIdentifier(rule.zoneId, "Rule rename zone identifier"),
    }))
    return [
      inventoryRead({
        surfaceIds: [],
        zoneIds: rules.map((rule) => rule.zoneId),
      }),
      ...rules.map((rule) => resourceRead(
        rulesetResourceId(rule.zoneId, rule.rulesetId),
        zoneResourcePath(rule.zoneId, "rulesets", rule.rulesetId),
      )),
    ]
  }
  if (action.type === READ_ACTION.RULE_EDIT) {
    const id = actionResourceId(action)
    return [
      resourceRead(
        id,
        zoneResourcePath(action.zoneId, "rulesets", action.rulesetId),
      ),
    ]
  }
  if (action.type === READ_ACTION.ZONE_SETTING_EDIT) {
    const id = actionResourceId(action)
    return [
      resourceRead(
        id,
        zoneResourcePath(action.zoneId, "settings", action.settingId),
      ),
    ]
  }
  if (action.type === READ_ACTION.DNS_RECORD_EDIT) {
    const id = actionResourceId(action)
    return [
      resourceRead(
        id,
        zoneResourcePath(action.zoneId, "dns_records", action.recordId),
      ),
    ]
  }
  throw new TypeError(`No read requirements are defined for action: ${action.type}`)
}

export function composeActionReadPlan(actions) {
  return composeReadPlan(actions.flatMap(readRequirementsForAction))
}

export function composeReadPlan(requirements) {
  const resources = new Map()
  const rulePhases = new Map()
  let inventory = null

  for (const requirement of requirements) {
    if (requirement.kind === REQUIREMENT_KIND.RESOURCE) {
      const existing = resources.get(requirement.id)
      if (existing && existing.path !== requirement.path) {
        throw new Error(`Read requirement ${requirement.id} maps to multiple resource paths`)
      }
      resources.set(requirement.id, requirement)
      continue
    }
    if (requirement.kind === REQUIREMENT_KIND.RULESET_PHASE) {
      const existing = rulePhases.get(requirement.id)
      if (existing
        && (existing.zoneId !== requirement.zoneId || existing.phase !== requirement.phase)) {
        throw new Error(`Ruleset phase requirement ${requirement.id} maps to multiple targets`)
      }
      rulePhases.set(requirement.id, existing
        ? {
            ...existing,
            kinds: unique([...existing.kinds, ...requirement.kinds]),
          }
        : requirement)
      continue
    }
    if (requirement.kind !== REQUIREMENT_KIND.INVENTORY) {
      throw new TypeError(`Unknown read requirement kind: ${requirement.kind}`)
    }

    if (inventory === null) {
      inventory = {
        includeEmailAddresses: false,
        includeRuleDetails: false,
        ruleDetailKinds: [],
        ruleDetailPhases: [],
        surfaceIds: [],
        zoneIds: [],
      }
    }
    inventory.includeEmailAddresses ||= requirement.includeEmailAddresses
    inventory.includeRuleDetails ||= requirement.includeRuleDetails
    inventory.surfaceIds = unique([...inventory.surfaceIds, ...requirement.surfaceIds])
    inventory.zoneIds = mergeOptionalFilter(inventory.zoneIds, requirement.zoneIds)
    if (requirement.includeRuleDetails) {
      inventory.ruleDetailKinds = mergeOptionalFilter(
        inventory.ruleDetailKinds,
        requirement.ruleDetailKinds,
      )
      inventory.ruleDetailPhases = mergeOptionalFilter(
        inventory.ruleDetailPhases,
        requirement.ruleDetailPhases,
      )
    }
  }

  if (inventory) {
    if (inventory.zoneIds === null) delete inventory.zoneIds
    if (inventory.ruleDetailKinds === null || !inventory.includeRuleDetails) {
      delete inventory.ruleDetailKinds
    }
    if (inventory.ruleDetailPhases === null || !inventory.includeRuleDetails) {
      delete inventory.ruleDetailPhases
    }
  }

  return {
    inventory,
    resources: [...resources.values()],
    rulePhases: [...rulePhases.values()],
  }
}

async function readRulesetPhase(api, requirement, options = {}) {
  const summariesResponse = await api.request(
    zoneResourcePath(requirement.zoneId, "rulesets"),
    {
      signal: options.signal,
    },
  )
  if (!Array.isArray(summariesResponse.result)) {
    throw new TypeError(`Expected a ruleset list for zone ${requirement.zoneId}`)
  }
  const kinds = new Set(requirement.kinds)
  const summaries = summariesResponse.result.filter(
    (ruleset) => ruleset.phase === requirement.phase && kinds.has(ruleset.kind),
  )
  const details = await Promise.all(summaries.map(async (ruleset) => {
    const response = await api.request(
      zoneResourcePath(requirement.zoneId, "rulesets", ruleset.id),
      {
        signal: options.signal,
      },
    )
    return response.result
  }))
  return [
    requirement.id,
    {
      details,
      kinds: requirement.kinds,
      phase: requirement.phase,
      summaries,
      zoneId: requirement.zoneId,
    },
  ]
}

async function executeComposedReadPlan(api, plan, options = {}) {
  const inventoryPromise = plan.inventory
    ? loadInventory(api, {
        ...plan.inventory,
        onProgress: options.onProgress,
        signal: options.signal,
      })
    : Promise.resolve(null)
  const resourcePromises = plan.resources.map(async (resource) => {
    const response = await api.request(resource.path, {
      signal: options.signal,
    })
    return [resource.id, response.result]
  })
  const rulePhasePromises = plan.rulePhases.map(
    (requirement) => readRulesetPhase(api, requirement, options),
  )
  const [inventory, resourceEntries, rulePhaseEntries] = await Promise.all([
    inventoryPromise,
    Promise.all(resourcePromises),
    Promise.all(rulePhasePromises),
  ])

  return {
    inventory,
    plan,
    resources: new Map(resourceEntries),
    rulePhases: new Map(rulePhaseEntries),
  }
}

export async function executeReadPlan(api, requirements, options = {}) {
  const plan = composeReadPlan(requirements)
  return executeComposedReadPlan(api, plan, options)
}

export function executeActionReadPlan(api, actions, options = {}) {
  return executeComposedReadPlan(api, composeActionReadPlan(actions), options)
}
