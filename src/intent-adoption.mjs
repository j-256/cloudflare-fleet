import {
  evaluateFleetIntent,
  FLEET_INTENT_ALL_ZONES_GROUP_ID,
  FLEET_INTENT_CELL_STATUS,
  FLEET_INTENT_EXPECTED_ORIGIN,
  FLEET_INTENT_MISSING_CANONICAL,
  FLEET_INTENT_PRESENCE_CONSTRAINT,
  FLEET_INTENT_VALUE_CONSTRAINT,
  fleetIntentFacetId,
  replaceFleetIntentAcknowledgement,
  replaceFleetIntentPolicy,
} from "./fleet-intent.mjs"
import { facetCellComparisonValue } from "./facet-equivalence.mjs"

const STRONG_CONSENSUS_MINIMUM_COUNT = 2
const STRONG_CONSENSUS_MINIMUM_RATIO = 2 / 3

export const INTENT_ADOPTION_CLASSIFICATION = Object.freeze({
  MISSING_COVERAGE: "missing-coverage",
  SPLIT_CONSENSUS: "split-consensus",
  STRONG_CONSENSUS: "strong-consensus",
  TIED_VARIANTS: "tied-variants",
  ZONE_SPECIFIC: "zone-specific",
})

export const INTENT_ADOPTION_CONFIDENCE = Object.freeze({
  HIGH: "high",
  REVIEW: "review",
})

export function intentAdoptionVisibleSummary(
  visibleCount,
  totalCount,
  selectedCount,
) {
  const visibleSummary = visibleCount === totalCount
    ? `${visibleCount} suggestion${visibleCount === 1 ? "" : "s"} shown`
    : `${visibleCount} of ${totalCount} suggestion${totalCount === 1 ? "" : "s"} shown`
  return `${visibleSummary} | ${selectedCount} selected`
}

export function selectIntentAdoptionGroup(selection, groupId) {
  if (!selection || typeof selection !== "object" || Array.isArray(selection)) {
    throw new TypeError("Intent adoption selection is invalid")
  }
  if (typeof groupId !== "string" || groupId.length === 0) {
    throw new TypeError("Intent adoption requires a zone group")
  }
  selection.groupId = groupId
  selection.selected = true
  return selection
}

function jsonClone(value) {
  const serialized = JSON.stringify(value)
  return serialized === undefined ? null : JSON.parse(serialized)
}

function cellCanonical(cell) {
  return cell.intentCanonical ?? cell.canonical
}

function cellIntentValue(cell) {
  return facetCellComparisonValue(cell)
}

function observedVariants(row, inventory) {
  const variants = new Map()
  for (const zone of inventory.zones) {
    const cell = row.cells.get(zone.meta.name)
    if (!cell) continue
    const canonical = cellCanonical(cell)
    if (!variants.has(canonical)) {
      variants.set(canonical, {
        canonical,
        count: 0,
        display: cell.intentDisplay ?? cell.display,
        inspectionValue: jsonClone(cell.inspectionValue),
        origin: FLEET_INTENT_EXPECTED_ORIGIN.OBSERVED,
        resolutionCanonical: cell.resolutionCanonical || null,
        sourceZoneId: zone.meta.id,
        sourceZoneName: zone.meta.name,
        value: jsonClone(cellIntentValue(cell)),
        zones: [],
      })
    }
    const variant = variants.get(canonical)
    variant.count += 1
    variant.zones.push(zone.meta.name)
    const currentSource = row.cells.get(variant.sourceZoneName)
    if (!currentSource?.resolutionSource && cell.resolutionSource) {
      variant.resolutionCanonical = cell.resolutionCanonical || null
      variant.sourceZoneId = zone.meta.id
      variant.sourceZoneName = zone.meta.name
      variant.inspectionValue = jsonClone(cell.inspectionValue)
      variant.value = jsonClone(cellIntentValue(cell))
    }
  }
  return [...variants.values()].sort(
    (left, right) => right.count - left.count
      || left.sourceZoneName.localeCompare(right.sourceZoneName),
  )
}

function classifyCandidate(variants, presentCount, missingCount) {
  if (presentCount === 1 && missingCount > 0) {
    return INTENT_ADOPTION_CLASSIFICATION.MISSING_COVERAGE
  }
  if (presentCount > 1 && variants.length === presentCount) {
    return INTENT_ADOPTION_CLASSIFICATION.ZONE_SPECIFIC
  }
  const leadingCount = variants[0]?.count || 0
  const runnerUpCount = variants[1]?.count || 0
  if (leadingCount === runnerUpCount) {
    return INTENT_ADOPTION_CLASSIFICATION.TIED_VARIANTS
  }
  if (variants.length === 1
    || (leadingCount >= STRONG_CONSENSUS_MINIMUM_COUNT
      && leadingCount / presentCount >= STRONG_CONSENSUS_MINIMUM_RATIO)) {
    return INTENT_ADOPTION_CLASSIFICATION.STRONG_CONSENSUS
  }
  return INTENT_ADOPTION_CLASSIFICATION.SPLIT_CONSENSUS
}

function recommendedConstraint(classification) {
  if (classification === INTENT_ADOPTION_CLASSIFICATION.TIED_VARIANTS
    || classification === INTENT_ADOPTION_CLASSIFICATION.ZONE_SPECIFIC) {
    return FLEET_INTENT_VALUE_CONSTRAINT.MAY_DIFFER
  }
  return FLEET_INTENT_VALUE_CONSTRAINT.EXACT
}

function recommendationReason(classification, missingCount) {
  const missingSuffix = missingCount > 0
    ? `; preserve optional presence across ${missingCount} missing zone${missingCount === 1 ? "" : "s"}`
    : ""
  if (classification === INTENT_ADOPTION_CLASSIFICATION.STRONG_CONSENSUS) {
    return `Use the clear leading value as exact intent${missingSuffix}`
  }
  if (classification === INTENT_ADOPTION_CLASSIFICATION.SPLIT_CONSENSUS) {
    return `Use the leading value, but review the close split before saving${missingSuffix}`
  }
  if (classification === INTENT_ADOPTION_CLASSIFICATION.TIED_VARIANTS) {
    return `Allow the tied present values to differ${missingSuffix}`
  }
  if (classification === INTENT_ADOPTION_CLASSIFICATION.ZONE_SPECIFIC) {
    return `Preserve each present zone's observed value${missingSuffix}`
  }
  return "Use the only observed value as exact intent while allowing other covered zones to omit it"
}

export function buildIntentAdoptionCandidates(document, inventory, matrix) {
  const governedFacetIds = new Set(document.policies.map(
    (policy) => fleetIntentFacetId(policy.facet.category, policy.facet.key),
  ))
  const candidates = []
  for (const row of matrix.rows) {
    const id = fleetIntentFacetId(row.category, row.key)
    if (governedFacetIds.has(id) || !row.different) continue
    const variants = observedVariants(row, inventory)
    if (variants.length === 0) continue
    const presentCount = variants.reduce((sum, variant) => sum + variant.count, 0)
    const missingCount = Math.max(0, inventory.zones.length - presentCount)
    const presentZones = variants.flatMap((variant) => variant.zones)
    const presentZoneSet = new Set(presentZones)
    const missingZones = inventory.zones
      .map((zone) => zone.meta.name)
      .filter((name) => !presentZoneSet.has(name))
    const classification = classifyCandidate(variants, presentCount, missingCount)
    const presenceConstraint = missingCount > 0
      ? FLEET_INTENT_PRESENCE_CONSTRAINT.OPTIONAL
      : FLEET_INTENT_PRESENCE_CONSTRAINT.REQUIRED
    const valueConstraint = recommendedConstraint(classification)
    const highConfidence = classification
      === INTENT_ADOPTION_CLASSIFICATION.STRONG_CONSENSUS
      && variants[0].count / inventory.zones.length
        >= STRONG_CONSENSUS_MINIMUM_RATIO
    candidates.push({
      category: row.category,
      classification,
      confidence: highConfidence
        ? INTENT_ADOPTION_CONFIDENCE.HIGH
        : INTENT_ADOPTION_CONFIDENCE.REVIEW,
      description: row.description || "",
      id,
      key: row.key,
      label: row.label,
      phase: row.phase || "",
      missingCount,
      missingZones,
      presentCount,
      presentZones,
      recommendation: {
        expectedCanonical: valueConstraint === FLEET_INTENT_VALUE_CONSTRAINT.EXACT
          ? variants[0].canonical
          : null,
        presenceConstraint,
        reason: recommendationReason(classification, missingCount),
        valueConstraint,
      },
      search: [
        row.category,
        row.label,
        row.description,
        ...variants.flatMap((variant) => [
          variant.display,
          variant.sourceZoneName,
        ]),
      ].filter(Boolean).join(" ").toLowerCase(),
      variants,
    })
  }
  return candidates.sort(
    (left, right) => left.category.localeCompare(right.category)
      || left.label.localeCompare(right.label),
  )
}

export function defaultAdoptionSelection(candidate, overrides = {}) {
  return {
    expectedCanonical: overrides.expectedCanonical
      ?? candidate.recommendation.expectedCanonical,
    groupId: overrides.groupId ?? FLEET_INTENT_ALL_ZONES_GROUP_ID,
    policyId: overrides.policyId,
    presenceConstraint: overrides.presenceConstraint
      ?? FLEET_INTENT_PRESENCE_CONSTRAINT.REQUIRED,
    valueConstraint: overrides.valueConstraint
      ?? candidate.recommendation.valueConstraint,
  }
}

export function createIntentAdoptionPolicy(candidate, selection) {
  const presenceConstraint = selection.presenceConstraint
    ?? FLEET_INTENT_PRESENCE_CONSTRAINT.REQUIRED
  if (!Object.values(FLEET_INTENT_PRESENCE_CONSTRAINT).includes(presenceConstraint)) {
    throw new TypeError(`Choose a presence rule for ${candidate.label}`)
  }
  const valuesApply = presenceConstraint !== FLEET_INTENT_PRESENCE_CONSTRAINT.FORBIDDEN
  const valueConstraint = valuesApply
    ? selection.valueConstraint
    : FLEET_INTENT_VALUE_CONSTRAINT.MAY_DIFFER
  const expectedVariant = valuesApply
    && valueConstraint === FLEET_INTENT_VALUE_CONSTRAINT.EXACT
    ? candidate.variants.find(
        (variant) => variant.canonical === selection.expectedCanonical,
      ) || null
    : null
  if (valuesApply
    && valueConstraint === FLEET_INTENT_VALUE_CONSTRAINT.EXACT
    && !expectedVariant) {
    throw new TypeError(`Choose an observed expected value for ${candidate.label}`)
  }
  return {
    expected: expectedVariant
      ? {
          canonical: expectedVariant.canonical,
          display: expectedVariant.display,
          origin: FLEET_INTENT_EXPECTED_ORIGIN.OBSERVED,
          resolutionCanonical: expectedVariant.resolutionCanonical,
          sourceZoneId: expectedVariant.sourceZoneId,
          sourceZoneName: expectedVariant.sourceZoneName,
          value: jsonClone(expectedVariant.value),
        }
      : null,
    facet: {
      category: candidate.category,
      description: candidate.description,
      key: candidate.key,
      label: candidate.label,
      ...(candidate.phase ? { phase: candidate.phase } : {}),
    },
    groupId: selection.groupId,
    id: selection.policyId,
    presenceConstraint,
    valueConstraint,
  }
}

// Fixed sentinel for acknowledgements built against a base document that has
// never been persisted (updatedAt === null). Any valid ISO string works; the
// epoch keeps the value deterministic so plan and apply hash identically
const ADOPTION_ACKNOWLEDGEMENT_EPOCH = "1970-01-01T00:00:00.000Z"

function buildAdoptionAcknowledgement(exemption, document) {
  // Derive timestamps from the base document's revision, never wall-clock, so a
  // fixed base yields a byte-identical acknowledgement across the plan and apply
  // passes and the reviewed-plan digest stays stable. Preserve an existing
  // acknowledgement's createdAt so re-adoption keeps its honest first-seen time
  const id = `ack-${exemption.policyId}-${exemption.zoneId}`
  const timestamp = document.updatedAt ?? ADOPTION_ACKNOWLEDGEMENT_EPOCH
  const existing = document.acknowledgements.find((entry) => entry.id === id)
  return {
    createdAt: existing?.createdAt ?? timestamp,
    id,
    observedCanonical: exemption.observedCanonical ?? FLEET_INTENT_MISSING_CANONICAL,
    policyId: exemption.policyId,
    reason: exemption.reason,
    updatedAt: timestamp,
    zoneId: exemption.zoneId,
    zoneName: exemption.zoneName,
  }
}

export function previewIntentAdoption(document, inventory, matrix, entries, exemptions = []) {
  let nextDocument = document
  const policies = entries.map(({ candidate, selection }) => (
    createIntentAdoptionPolicy(candidate, selection)
  ))
  for (const policy of policies) {
    nextDocument = replaceFleetIntentPolicy(nextDocument, policy)
  }
  for (const exemption of exemptions) {
    nextDocument = replaceFleetIntentAcknowledgement(
      nextDocument,
      buildAdoptionAcknowledgement(exemption, document),
    )
  }
  const evaluation = evaluateFleetIntent(nextDocument, inventory, matrix)
  const policyIds = new Set(policies.map((policy) => policy.id))
  const policyStates = evaluation.policyStates.filter(
    (policyState) => policyIds.has(policyState.policy.id),
  )
  const cells = policyStates.flatMap((policyState) => [...policyState.cells.values()])
  const countStatus = (status) => cells.filter((cell) => cell.status === status).length
  const selectedFacetIds = new Set(policies.map(
    (policy) => fleetIntentFacetId(policy.facet.category, policy.facet.key),
  ))
  const conflictCells = [...evaluation.rowStates.entries()]
    .filter(([facetId]) => selectedFacetIds.has(facetId))
    .flatMap(([, rowState]) => [...rowState.cells.values()])
    .filter((cell) => cell.status === FLEET_INTENT_CELL_STATUS.CONFLICT)
    .length
  return {
    document: nextDocument,
    evaluation,
    policies,
    summary: {
      actionableCells: countStatus(FLEET_INTENT_CELL_STATUS.MISSING)
        + countStatus(FLEET_INTENT_CELL_STATUS.VARIANT)
        + conflictCells,
      conflictCells,
      matchingCells: countStatus(FLEET_INTENT_CELL_STATUS.MATCH),
      missingCells: countStatus(FLEET_INTENT_CELL_STATUS.MISSING),
      policiesAdded: policies.length,
      targetedCells: cells.length,
      variantCells: countStatus(FLEET_INTENT_CELL_STATUS.VARIANT),
    },
  }
}

export function buildAdoptionDocument(document, inventory, matrix, request) {
  const byId = new Map(
    buildIntentAdoptionCandidates(document, inventory, matrix)
      .map((candidate) => [candidate.id, candidate]),
  )
  const policyIdByCandidate = new Map()
  const entries = (request.adopt || []).map((item) => {
    const candidate = byId.get(item.candidateId)
    if (!candidate) {
      throw new TypeError(`Unknown adoption candidate: ${item.candidateId}`)
    }
    const policyId = item.policyId || `adopt-${item.candidateId}`
    policyIdByCandidate.set(item.candidateId, policyId)
    return {
      candidate,
      selection: defaultAdoptionSelection(candidate, { ...item.overrides, policyId }),
    }
  })
  const exemptions = (request.exempt || []).flatMap((item) => {
    const policyId = item.policyId || policyIdByCandidate.get(item.candidateId)
    if (!policyId) {
      throw new TypeError(
        `Exemption needs an explicit policyId or a candidateId adopted in the same request`,
      )
    }
    return item.zones.map((zone) => ({
      observedCanonical: FLEET_INTENT_MISSING_CANONICAL,
      policyId,
      reason: item.reason,
      zoneId: zone.id,
      zoneName: zone.name,
    }))
  })
  const preview = previewIntentAdoption(document, inventory, matrix, entries, exemptions)
  return {
    document: preview.document,
    policyIds: [...policyIdByCandidate.values()],
    summary: preview.summary,
  }
}

export function excludeUnreadZones(candidates, coverage) {
  const incompleteZones = new Set(
    coverage.flatMap((entry) => entry.failed || [])
      .map((failure) => failure.zoneName)
      .filter(Boolean),
  )
  if (incompleteZones.size === 0) {
    return { candidates, incompleteZones: [] }
  }
  const adjusted = candidates.map((candidate) => {
    const unreadZones = candidate.missingZones.filter((zone) => incompleteZones.has(zone))
    if (unreadZones.length === 0) return candidate
    return {
      ...candidate,
      missingZones: candidate.missingZones.filter((zone) => !incompleteZones.has(zone)),
      unreadZones,
    }
  })
  return { candidates: adjusted, incompleteZones: [...incompleteZones] }
}

export const INTENT_ADOPTION_GAP_KIND = Object.freeze({
  PRESENCE: "presence",
  VALUE: "value",
})

function presenceConsensusRatio(candidate) {
  const total = candidate.presentCount + candidate.missingCount
  return total === 0 ? 0 : candidate.presentCount / total
}

export function buildAdoptionGapsView(candidates) {
  const perZoneOutlierTally = {}
  const presenceGaps = []
  const valueGaps = []
  const tally = (zones) => {
    for (const zone of zones) {
      perZoneOutlierTally[zone] = (perZoneOutlierTally[zone] || 0) + 1
    }
  }
  for (const candidate of candidates) {
    if (candidate.classification === INTENT_ADOPTION_CLASSIFICATION.ZONE_SPECIFIC
      || candidate.classification === INTENT_ADOPTION_CLASSIFICATION.TIED_VARIANTS) {
      continue
    }
    if (candidate.missingZones.length > 0) {
      presenceGaps.push({
        candidate,
        gapKind: INTENT_ADOPTION_GAP_KIND.PRESENCE,
        outlierZones: candidate.missingZones,
      })
      tally(candidate.missingZones)
      continue
    }
    const outlierZones = candidate.variants.slice(1).flatMap((variant) => variant.zones)
    if (outlierZones.length === 0) continue
    valueGaps.push({
      candidate,
      gapKind: INTENT_ADOPTION_GAP_KIND.VALUE,
      outlierZones,
    })
    tally(outlierZones)
  }
  presenceGaps.sort((left, right) => (
    presenceConsensusRatio(right.candidate) - presenceConsensusRatio(left.candidate)
    || right.candidate.presentCount - left.candidate.presentCount
    || left.candidate.label.localeCompare(right.candidate.label)
  ))
  valueGaps.sort((left, right) => (
    (right.candidate.variants[0].count / right.candidate.presentCount)
    - (left.candidate.variants[0].count / left.candidate.presentCount)
    || left.candidate.label.localeCompare(right.candidate.label)
  ))
  return { perZoneOutlierTally, presenceGaps, valueGaps }
}

export function applyAdoptionFilters(result, filters = {}) {
  const lens = filters.lens || "gaps"
  let candidates = result.candidates
  if (lens === "gaps") {
    const gapIds = new Set([
      ...result.gaps.presenceGaps.map((gap) => gap.candidate.id),
      ...result.gaps.valueGaps.map((gap) => gap.candidate.id),
    ])
    candidates = candidates.filter((candidate) => gapIds.has(candidate.id))
  }
  candidates = candidates.filter((candidate) => {
    if (filters.category && candidate.category !== filters.category) return false
    if (filters.confidence && candidate.confidence !== filters.confidence) return false
    if (filters.classification && candidate.classification !== filters.classification) return false
    if (filters.zone
      && !candidate.missingZones.includes(filters.zone)
      && !candidate.presentZones.includes(filters.zone)) return false
    if (filters.search && !candidate.search.includes(filters.search.toLowerCase())) return false
    return true
  })
  if (filters.limit) candidates = candidates.slice(0, filters.limit)
  const survivingIds = new Set(candidates.map((candidate) => candidate.id))
  const presenceGaps = result.gaps.presenceGaps.filter(
    (gap) => survivingIds.has(gap.candidate.id),
  )
  const valueGaps = result.gaps.valueGaps.filter(
    (gap) => survivingIds.has(gap.candidate.id),
  )
  const perZoneOutlierTally = {}
  for (const gap of [...presenceGaps, ...valueGaps]) {
    for (const zone of gap.outlierZones) {
      perZoneOutlierTally[zone] = (perZoneOutlierTally[zone] || 0) + 1
    }
  }
  const summary = {
    ...result.summary,
    candidates: candidates.length,
    presenceGaps: presenceGaps.length,
    valueGaps: valueGaps.length,
  }
  return {
    ...result,
    candidates,
    gaps: { perZoneOutlierTally, presenceGaps, valueGaps },
    summary,
  }
}
