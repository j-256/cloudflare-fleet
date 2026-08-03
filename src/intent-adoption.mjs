import {
  evaluateFleetIntent,
  FLEET_INTENT_CELL_STATUS,
  FLEET_INTENT_EXPECTED_ORIGIN,
  FLEET_INTENT_VALUE_CONSTRAINT,
  fleetIntentFacetId,
  replaceFleetIntentPolicy,
} from "./fleet-intent.mjs"

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

function jsonClone(value) {
  const serialized = JSON.stringify(value)
  return serialized === undefined ? null : JSON.parse(serialized)
}

function cellCanonical(cell) {
  return cell.intentCanonical ?? cell.canonical
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
        display: cell.display,
        origin: FLEET_INTENT_EXPECTED_ORIGIN.OBSERVED,
        resolutionCanonical: cell.resolutionCanonical || null,
        sourceZoneId: zone.meta.id,
        sourceZoneName: zone.meta.name,
        value: jsonClone(cell.inspectionValue),
      })
    }
    const variant = variants.get(canonical)
    variant.count += 1
    const currentSource = row.cells.get(variant.sourceZoneName)
    if (!currentSource?.resolutionSource && cell.resolutionSource) {
      variant.resolutionCanonical = cell.resolutionCanonical || null
      variant.sourceZoneId = zone.meta.id
      variant.sourceZoneName = zone.meta.name
      variant.value = jsonClone(cell.inspectionValue)
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
    ? `; ${missingCount} missing zone${missingCount === 1 ? "" : "s"} would become actionable`
    : ""
  if (classification === INTENT_ADOPTION_CLASSIFICATION.STRONG_CONSENSUS) {
    return `Use the clear leading value as exact intent${missingSuffix}`
  }
  if (classification === INTENT_ADOPTION_CLASSIFICATION.SPLIT_CONSENSUS) {
    return `Use the leading value, but review the close split before saving${missingSuffix}`
  }
  if (classification === INTENT_ADOPTION_CLASSIFICATION.TIED_VARIANTS) {
    return `Require presence while allowing the tied values to differ${missingSuffix}`
  }
  if (classification === INTENT_ADOPTION_CLASSIFICATION.ZONE_SPECIFIC) {
    return `Require presence while preserving each zone's observed value${missingSuffix}`
  }
  return "Use the only observed value as exact intent; every other covered zone is missing"
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
    const classification = classifyCandidate(variants, presentCount, missingCount)
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
      missingCount,
      presentCount,
      recommendation: {
        expectedCanonical: valueConstraint === FLEET_INTENT_VALUE_CONSTRAINT.EXACT
          ? variants[0].canonical
          : null,
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

export function createIntentAdoptionPolicy(candidate, selection) {
  const valueConstraint = selection.valueConstraint
  const expectedVariant = valueConstraint === FLEET_INTENT_VALUE_CONSTRAINT.EXACT
    ? candidate.variants.find(
        (variant) => variant.canonical === selection.expectedCanonical,
      ) || null
    : null
  if (valueConstraint === FLEET_INTENT_VALUE_CONSTRAINT.EXACT && !expectedVariant) {
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
    },
    groupId: selection.groupId,
    id: selection.policyId,
    valueConstraint,
  }
}

export function previewIntentAdoption(document, inventory, matrix, entries) {
  let nextDocument = document
  const policies = entries.map(({ candidate, selection }) => (
    createIntentAdoptionPolicy(candidate, selection)
  ))
  for (const policy of policies) {
    nextDocument = replaceFleetIntentPolicy(nextDocument, policy)
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
