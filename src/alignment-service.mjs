import {
  evaluateFleetIntent,
  fleetIntentFacetId,
} from "./fleet-intent.mjs"
import {
  assessIntentAlignment,
  buildIntentAlignmentPlans,
  intentAlignmentReadRequirement,
} from "./intent-alignment.mjs"
import { loadInventory } from "./inventory.mjs"
import { buildMatrix } from "./matrix.mjs"
import { stableString } from "./normalize.mjs"
import { executeReadPlan } from "./read-composer.mjs"

export const ALIGNMENT_PLAN_SCHEMA_VERSION = 1

export const ALIGNMENT_PREPARATION_STATUS = Object.freeze({
  ALIGNED: "aligned",
  BLOCKED: "blocked",
  PLANNED: "planned",
})

export const ALIGNMENT_SELECTOR_KIND = Object.freeze({
  CELL: "cell",
  POLICY: "policy",
  ROW: "row",
})

function requiredString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label} is required`)
  }
  return value
}

function uniqueStrings(values, label) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new TypeError(`${label} requires at least one value`)
  }
  const unique = [...new Set(values.map((value) => requiredString(value, label)))]
  return unique.sort()
}

export function normalizeAlignmentSelector(selector) {
  if (!selector || typeof selector !== "object" || Array.isArray(selector)) {
    throw new TypeError("Alignment selector is required")
  }
  const policyId = selector.policyId || null
  const category = selector.category || null
  const key = selector.key || null
  const phase = selector.phase || ""
  const zoneIds = selector.zoneIds === null || selector.zoneIds === undefined
    ? null
    : uniqueStrings(selector.zoneIds, "Alignment zone identifier")

  if (policyId) {
    if (category || key || phase || zoneIds) {
      throw new TypeError("Policy alignment cannot include facet or zone fields")
    }
    return {
      kind: ALIGNMENT_SELECTOR_KIND.POLICY,
      policyId: requiredString(policyId, "Alignment policy identifier"),
    }
  }
  if (!category || !key) {
    throw new TypeError("Facet alignment requires category and key")
  }
  return {
    category: requiredString(category, "Alignment facet category"),
    key: requiredString(key, "Alignment facet key"),
    kind: zoneIds
      ? ALIGNMENT_SELECTOR_KIND.CELL
      : ALIGNMENT_SELECTOR_KIND.ROW,
    phase: typeof phase === "string" ? phase : "",
    zoneIds,
  }
}

export function normalizeAlignmentSelectors(selectors) {
  if (!Array.isArray(selectors) || selectors.length === 0) {
    throw new TypeError("Alignment selectors require at least one value")
  }
  const normalized = selectors.map(normalizeAlignmentSelector)
  const keys = normalized.map(stableString)
  if (new Set(keys).size !== keys.length) {
    throw new TypeError("Alignment selectors must be unique")
  }
  return normalized
}

function selectorForPolicy(policy) {
  return normalizeAlignmentSelector({ policyId: policy.id })
}

function selectorForRow(row, zoneIds = null) {
  return normalizeAlignmentSelector({
    category: row.category,
    key: row.key,
    phase: row.phase || "",
    zoneIds,
  })
}

function policyForSelector(intent, selector) {
  if (selector.kind !== ALIGNMENT_SELECTOR_KIND.POLICY) return null
  const policy = intent.policies.find((entry) => entry.id === selector.policyId)
  if (!policy) {
    throw new Error(`Fleet intent policy is unavailable: ${selector.policyId}`)
  }
  return policy
}

function facetForSelector(intent, selector) {
  const policy = policyForSelector(intent, selector)
  return policy
    ? {
        category: policy.facet.category,
        key: policy.facet.key,
        phase: policy.facet.phase || "",
      }
    : {
        category: selector.category,
        key: selector.key,
        phase: selector.phase,
      }
}

function rowForFacet(matrix, facet) {
  return matrix.rows.find((row) => (
    row.category === facet.category
      && row.key === facet.key
      && (row.phase || "") === facet.phase
  )) || null
}

function evaluatedIntent(inventory, intent) {
  const matrix = buildMatrix(inventory)
  const evaluation = evaluateFleetIntent(intent, inventory, matrix)
  const rows = matrix.rows.map((row) => ({
    ...row,
    intentState: evaluation.rowStates.get(
      fleetIntentFacetId(row.category, row.key),
    ),
  }))
  return {
    evaluation,
    matrix: {
      ...matrix,
      rows,
    },
  }
}

function alignmentOptions(selector) {
  return {
    policyId: selector.kind === ALIGNMENT_SELECTOR_KIND.POLICY
      ? selector.policyId
      : null,
    zoneIds: selector.kind === ALIGNMENT_SELECTOR_KIND.CELL
      ? selector.zoneIds
      : null,
  }
}

function assessmentSummary(assessment) {
  return {
    actionableCount: assessment.actionableCount,
    available: assessment.available,
    blockers: assessment.blockers.map((entry) => ({
      reason: entry.reason,
      zoneId: entry.zoneId,
      zoneName: entry.zoneName,
    })),
    reason: assessment.reason,
    targetCount: assessment.targets.length,
    targetZones: assessment.targets.map((entry) => ({
      zoneId: entry.zoneId,
      zoneName: entry.zoneName,
    })),
  }
}

function candidate(row, selector, assessment, options = {}) {
  return {
    assessment: assessmentSummary(assessment),
    facet: {
      category: row.category,
      key: row.key,
      label: row.label,
      phase: row.phase || "",
    },
    policyId: options.policyId || null,
    scope: selector.kind,
    selector,
  }
}

export function listIntentAlignmentCandidates(inventory, intent) {
  const { evaluation, matrix } = evaluatedIntent(inventory, intent)
  const candidates = []
  for (const row of matrix.rows) {
    if (!row.intentState?.governed) continue
    const rowSelector = selectorForRow(row)
    const rowAssessment = assessIntentAlignment(row)
    if (rowAssessment.actionableCount > 0 || row.intentState.unresolved) {
      candidates.push(candidate(row, rowSelector, rowAssessment))
    }
    for (const policy of row.intentState.policies) {
      const policySelector = selectorForPolicy(policy)
      const policyAssessment = assessIntentAlignment(row, {
        policyId: policy.id,
      })
      if (policyAssessment.actionableCount > 0) {
        candidates.push(candidate(row, policySelector, policyAssessment, {
          policyId: policy.id,
        }))
      }
    }
  }
  const representedPolicyIds = new Set(
    candidates.map((entry) => entry.policyId).filter(Boolean),
  )
  for (const policyState of evaluation.policyStates) {
    if (!policyState.unresolved || representedPolicyIds.has(policyState.policy.id)) {
      continue
    }
    candidates.push({
      assessment: {
        actionableCount: 0,
        available: false,
        blockers: [],
        reason: policyState.reason,
        targetCount: 0,
        targetZones: [],
      },
      facet: {
        category: policyState.policy.facet.category,
        key: policyState.policy.facet.key,
        label: policyState.policy.facet.label,
        phase: policyState.policy.facet.phase || "",
      },
      policyId: policyState.policy.id,
      scope: ALIGNMENT_SELECTOR_KIND.POLICY,
      selector: selectorForPolicy(policyState.policy),
    })
  }
  candidates.sort((left, right) => (
    left.facet.category.localeCompare(right.facet.category)
      || left.facet.label.localeCompare(right.facet.label)
      || left.scope.localeCompare(right.scope)
      || String(left.policyId || "").localeCompare(String(right.policyId || ""))
  ))
  return {
    candidates,
    inventory,
    summary: {
      actionableCells: evaluation.summary.actionableCells,
      availableCandidates: candidates.filter(
        (entry) => entry.assessment.available,
      ).length,
      blockedCandidates: candidates.filter(
        (entry) => !entry.assessment.available,
      ).length,
      candidates: candidates.length,
      zones: inventory.zones.length,
    },
  }
}

function assertFleetMembership(baseline, liveInventory) {
  const loaded = new Map(
    baseline.zones.map((zone) => [zone.meta.id, zone.meta.name]),
  )
  const live = new Map(
    liveInventory.zones.map((zone) => [zone.meta.id, zone.meta.name]),
  )
  const unchanged = loaded.size === live.size
    && [...loaded].every(([zoneId, zoneName]) => live.get(zoneId) === zoneName)
  if (!unchanged) {
    throw new Error("Fleet membership changed during live validation. Refresh the full fleet before aligning intent so no zone is omitted or evaluated under a stale name.")
  }
}

function assertSurfaceReads(inventory, surfaceIds) {
  const failures = inventory.zones.flatMap((zone) => surfaceIds
    .filter((surfaceId) => !zone.surfaces[surfaceId]?.ok)
    .map((surfaceId) => `${zone.meta.name}: ${surfaceId}`))
  if (failures.length > 0) {
    throw new Error(`Intent alignment live validation could not read ${failures.join(", ")}`)
  }
}

function assertRuleDetails(inventory, requirement) {
  if (!requirement.includeRuleDetails) return
  const phases = requirement.ruleDetailPhases
    ? new Set(requirement.ruleDetailPhases)
    : null
  const kinds = requirement.ruleDetailKinds
    ? new Set(requirement.ruleDetailKinds)
    : null
  const failures = []
  for (const zone of inventory.zones) {
    const expected = (zone.surfaces.rulesets?.result || []).filter(
      (ruleset) => (phases === null || phases.has(ruleset.phase))
        && (kinds === null || kinds.has(ruleset.kind)),
    )
    const actualIds = new Set(
      zone.ruleDetails
        .filter((detail) => detail.ok)
        .map((detail) => detail.result?.id)
        .filter(Boolean),
    )
    if (zone.ruleDetails.some((detail) => !detail.ok)
      || expected.some((ruleset) => !actualIds.has(ruleset.id))) {
      failures.push(zone.meta.name)
    }
  }
  if (failures.length > 0) {
    throw new Error(`Intent alignment live validation could not read complete ruleset details for ${failures.join(", ")}`)
  }
}

function operationPreview(plans) {
  return plans.flatMap((plan) => plan.operations.map((operation) => {
    const preview = {
      body: operation.body,
      label: operation.label,
      method: operation.method,
      path: operation.path,
      zoneId: plan.zoneId,
      zoneName: plan.zoneName,
    }
    if (Object.hasOwn(operation, "currentValue")) {
      preview.currentValue = operation.currentValue
    }
    return preview
  }))
}

async function sha256(value) {
  const bytes = new TextEncoder().encode(value)
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes)
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
}

function fleetMembership(inventory) {
  return inventory.zones
    .map((zone) => ({ id: zone.meta.id, name: zone.meta.name }))
    .sort((left, right) => left.name.localeCompare(right.name))
}

export async function createAlignmentPlanSet(options) {
  if (typeof options.intentRevision !== "string") {
    throw new TypeError("Alignment intent revision is required")
  }
  const content = {
    accountId: requiredString(options.accountId, "Alignment account identifier"),
    fleet: fleetMembership(options.inventory),
    intentRevision: options.intentRevision,
    plans: structuredClone(options.plans),
    preview: operationPreview(options.plans),
    schemaVersion: ALIGNMENT_PLAN_SCHEMA_VERSION,
    selector: normalizeAlignmentSelector(options.selector),
  }
  const digest = `sha256:${await sha256(stableString(content))}`
  return Object.freeze({
    ...content,
    digest,
    validatedAt: options.validatedAt || new Date().toISOString(),
  })
}

export async function createAlignmentBatchPlanSet(options) {
  if (typeof options.intentRevision !== "string") {
    throw new TypeError("Alignment intent revision is required")
  }
  const content = {
    accountId: requiredString(options.accountId, "Alignment account identifier"),
    fleet: fleetMembership(options.inventory),
    intentRevision: options.intentRevision,
    plans: structuredClone(options.plans),
    preview: operationPreview(options.plans),
    schemaVersion: ALIGNMENT_PLAN_SCHEMA_VERSION,
    selectors: normalizeAlignmentSelectors(options.selectors),
  }
  const digest = `sha256:${await sha256(stableString(content))}`
  return Object.freeze({
    ...content,
    digest,
    validatedAt: options.validatedAt || new Date().toISOString(),
  })
}

function stoppedPreparation(status, selector, row, assessment, reason) {
  return {
    assessment: assessment ? assessmentSummary(assessment) : null,
    facet: row
      ? {
          category: row.category,
          key: row.key,
          label: row.label,
          phase: row.phase || "",
        }
      : null,
    planSet: null,
    reason,
    selector,
    status,
  }
}

function scopedRow(inventory, intent, facet) {
  const { matrix } = evaluatedIntent(inventory, intent)
  return rowForFacet(matrix, facet)
}

function batchAlignmentEntry(row, selector, assessment, status, reason) {
  return {
    assessment: assessment ? assessmentSummary(assessment) : null,
    facet: row
      ? {
          category: row.category,
          key: row.key,
          label: row.label,
          phase: row.phase || "",
        }
      : null,
    reason,
    selector,
    status,
  }
}

function batchReason(entries, status) {
  if (status === ALIGNMENT_PREPARATION_STATUS.ALIGNED) {
    return "Every selected scope already matches fleet intent in fresh live state"
  }
  if (status === ALIGNMENT_PREPARATION_STATUS.BLOCKED) {
    const blocked = entries.filter(
      (entry) => entry.status === ALIGNMENT_PREPARATION_STATUS.BLOCKED,
    )
    return `Batch alignment is blocked. ${blocked.map((entry) => (
      `${entry.facet?.label || "Unknown facet"}: ${entry.reason}`
    )).join("; ")}`
  }
  const planned = entries.filter(
    (entry) => entry.status === ALIGNMENT_PREPARATION_STATUS.PLANNED,
  )
  return `${planned.length} selected scopes are ready for alignment`
}

function overlappingOperation(plansBySelector) {
  const owners = new Map()
  for (const [selectorIndex, plans] of plansBySelector.entries()) {
    for (const plan of plans) {
      for (const operation of plan.operations) {
        const owner = owners.get(operation.path)
        if (owner !== undefined && owner !== selectorIndex) return operation
        owners.set(operation.path, selectorIndex)
      }
    }
  }
  return null
}

export async function prepareIntentAlignments(api, intent, requestedSelectors, options = {}) {
  const selectors = normalizeAlignmentSelectors(requestedSelectors)
  const baseline = options.baselineInventory || await (
    options.loadInventory || loadInventory
  )(api, {
    onProgress: options.onProgress,
    signal: options.signal,
  })
  const { matrix: baselineMatrix } = evaluatedIntent(baseline, intent)
  const contexts = selectors.map((selector) => {
    const facet = facetForSelector(intent, selector)
    const row = rowForFacet(baselineMatrix, facet)
    return {
      facet,
      requirement: row ? intentAlignmentReadRequirement(row) : null,
      row,
      selector,
    }
  })
  const missing = contexts.filter((context) => !context.row)
  if (missing.length > 0) {
    const entries = contexts.map((context) => batchAlignmentEntry(
      context.row,
      context.selector,
      null,
      ALIGNMENT_PREPARATION_STATUS.BLOCKED,
      context.row
        ? "The selected scope was not evaluated because another batch facet is absent"
        : "The selected intent facet is absent from the fleet",
    ))
    return {
      alignments: entries,
      planSet: null,
      reason: batchReason(entries, ALIGNMENT_PREPARATION_STATUS.BLOCKED),
      selectors,
      status: ALIGNMENT_PREPARATION_STATUS.BLOCKED,
    }
  }

  const read = options.executeReadPlan || executeReadPlan
  const liveData = await read(
    api,
    contexts.map((context) => context.requirement),
    {
      onProgress: options.onProgress,
      signal: options.signal,
    },
  )
  const liveInventory = liveData.inventory
  assertFleetMembership(baseline, liveInventory)
  for (const context of contexts) {
    assertSurfaceReads(liveInventory, context.requirement.surfaceIds)
    assertRuleDetails(liveInventory, context.requirement)
  }

  const plansBySelector = []
  const { matrix: liveMatrix } = evaluatedIntent(liveInventory, intent)
  const entries = contexts.map((context) => {
    const row = rowForFacet(liveMatrix, context.facet)
    if (!row) {
      plansBySelector.push([])
      return batchAlignmentEntry(
        null,
        context.selector,
        null,
        ALIGNMENT_PREPARATION_STATUS.BLOCKED,
        "The selected intent facet is absent from the fresh fleet state",
      )
    }
    const assessment = assessIntentAlignment(
      row,
      alignmentOptions(context.selector),
    )
    if (assessment.actionableCount === 0) {
      plansBySelector.push([])
      return batchAlignmentEntry(
        row,
        context.selector,
        assessment,
        ALIGNMENT_PREPARATION_STATUS.ALIGNED,
        "The selected scope already matches fleet intent in fresh live state",
      )
    }
    if (!assessment.available) {
      plansBySelector.push([])
      return batchAlignmentEntry(
        row,
        context.selector,
        assessment,
        ALIGNMENT_PREPARATION_STATUS.BLOCKED,
        assessment.reason,
      )
    }
    plansBySelector.push(buildIntentAlignmentPlans(
      liveInventory,
      row,
      assessment,
    ))
    return batchAlignmentEntry(
      row,
      context.selector,
      assessment,
      ALIGNMENT_PREPARATION_STATUS.PLANNED,
      assessment.reason,
    )
  })
  if (entries.some(
    (entry) => entry.status === ALIGNMENT_PREPARATION_STATUS.BLOCKED,
  )) {
    return {
      alignments: entries,
      planSet: null,
      reason: batchReason(entries, ALIGNMENT_PREPARATION_STATUS.BLOCKED),
      selectors,
      status: ALIGNMENT_PREPARATION_STATUS.BLOCKED,
    }
  }
  if (entries.every(
    (entry) => entry.status === ALIGNMENT_PREPARATION_STATUS.ALIGNED,
  )) {
    return {
      alignments: entries,
      planSet: null,
      reason: batchReason(entries, ALIGNMENT_PREPARATION_STATUS.ALIGNED),
      selectors,
      status: ALIGNMENT_PREPARATION_STATUS.ALIGNED,
    }
  }
  const overlap = overlappingOperation(plansBySelector)
  if (overlap) {
    const reason = `Batch selectors produce overlapping writes to ${overlap.path}`
    return {
      alignments: entries,
      planSet: null,
      reason,
      selectors,
      status: ALIGNMENT_PREPARATION_STATUS.BLOCKED,
    }
  }
  const planSet = await createAlignmentBatchPlanSet({
    accountId: api.accountId,
    intentRevision: intent.revision,
    inventory: liveInventory,
    plans: plansBySelector.flat(),
    selectors,
    validatedAt: options.validatedAt,
  })
  return {
    alignments: entries,
    planSet,
    reason: batchReason(entries, ALIGNMENT_PREPARATION_STATUS.PLANNED),
    selectors,
    status: ALIGNMENT_PREPARATION_STATUS.PLANNED,
  }
}

export async function prepareIntentAlignment(api, intent, requestedSelector, options = {}) {
  const selector = normalizeAlignmentSelector(requestedSelector)
  const baseline = options.baselineInventory || await (
    options.loadInventory || loadInventory
  )(api, {
    onProgress: options.onProgress,
    signal: options.signal,
  })
  const facet = facetForSelector(intent, selector)
  const loadedRow = scopedRow(baseline, intent, facet)
  if (!loadedRow) {
    return stoppedPreparation(
      ALIGNMENT_PREPARATION_STATUS.BLOCKED,
      selector,
      null,
      null,
      "The selected intent facet is absent from the fleet",
    )
  }
  const loadedAssessment = assessIntentAlignment(
    loadedRow,
    alignmentOptions(selector),
  )
  if (loadedAssessment.actionableCount === 0) {
    return stoppedPreparation(
      ALIGNMENT_PREPARATION_STATUS.ALIGNED,
      selector,
      loadedRow,
      loadedAssessment,
      "The selected scope already matches fleet intent",
    )
  }
  if (!loadedAssessment.available) {
    return stoppedPreparation(
      ALIGNMENT_PREPARATION_STATUS.BLOCKED,
      selector,
      loadedRow,
      loadedAssessment,
      loadedAssessment.reason,
    )
  }

  const requirement = intentAlignmentReadRequirement(loadedRow)
  const read = options.executeReadPlan || executeReadPlan
  const liveData = await read(api, [requirement], {
    onProgress: options.onProgress,
    signal: options.signal,
  })
  const liveInventory = liveData.inventory
  assertFleetMembership(baseline, liveInventory)
  assertSurfaceReads(liveInventory, requirement.surfaceIds)
  assertRuleDetails(liveInventory, requirement)
  const liveRow = scopedRow(liveInventory, intent, facet)
  if (!liveRow) {
    return stoppedPreparation(
      ALIGNMENT_PREPARATION_STATUS.BLOCKED,
      selector,
      null,
      null,
      "The selected intent facet is absent from the fresh fleet state",
    )
  }
  const liveAssessment = assessIntentAlignment(
    liveRow,
    alignmentOptions(selector),
  )
  if (liveAssessment.actionableCount === 0) {
    return stoppedPreparation(
      ALIGNMENT_PREPARATION_STATUS.ALIGNED,
      selector,
      liveRow,
      liveAssessment,
      "The selected scope already matches fleet intent in fresh live state",
    )
  }
  if (!liveAssessment.available) {
    return stoppedPreparation(
      ALIGNMENT_PREPARATION_STATUS.BLOCKED,
      selector,
      liveRow,
      liveAssessment,
      liveAssessment.reason,
    )
  }
  const plans = buildIntentAlignmentPlans(
    liveInventory,
    liveRow,
    liveAssessment,
  )
  const planSet = await createAlignmentPlanSet({
    accountId: api.accountId,
    intentRevision: intent.revision,
    inventory: liveInventory,
    plans,
    selector,
    validatedAt: options.validatedAt,
  })
  return {
    assessment: assessmentSummary(liveAssessment),
    facet: {
      category: liveRow.category,
      key: liveRow.key,
      label: liveRow.label,
      phase: liveRow.phase || "",
    },
    planSet,
    reason: liveAssessment.reason,
    selector,
    status: ALIGNMENT_PREPARATION_STATUS.PLANNED,
  }
}
