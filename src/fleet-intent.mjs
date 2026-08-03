import {
  shortDisplay,
  stableString,
} from "./normalize.mjs"
import { INVENTORY_COVERAGE_KIND } from "./constants.mjs"

export const FLEET_INTENT_SCHEMA_VERSION = 3
export const FLEET_INTENT_DOCUMENT_GLOBAL = "__CLOUDFLARE_FLEET_INTENT__"
export const FLEET_INTENT_ALL_ZONES_GROUP_ID = "all-zones"
export const FLEET_INTENT_EMPTY_REVISION = ""
export const FLEET_INTENT_MISSING_CANONICAL = "__fleet_intent_missing__"
export const FLEET_INTENT_LABEL_MAX_LENGTH = 240
export const FLEET_INTENT_REASON_MAX_LENGTH = 2000

export const FLEET_INTENT_GROUP_MODE = Object.freeze({
  ALL: "all",
  MEMBERS: "members",
})

export const FLEET_INTENT_CELL_STATUS = Object.freeze({
  ACKNOWLEDGED: "acknowledged",
  CONFLICT: "conflict",
  MATCH: "match",
  MISSING: "missing",
  OUT_OF_SCOPE: "out-of-scope",
  UNGOVERNED: "ungoverned",
  VARIANT: "variant",
})

export const FLEET_INTENT_ACKNOWLEDGEMENT_STATUS = Object.freeze({
  ACTIVE: "active",
  STALE: "stale",
})

export const FLEET_INTENT_COVERAGE_EXPECTATION_STATUS = Object.freeze({
  ACTIVE: "active",
  CHANGED: "changed",
  INACTIVE: "inactive",
})

export const FLEET_INTENT_EXPECTED_ORIGIN = Object.freeze({
  AUTHORED: "authored",
  OBSERVED: "observed",
})

export const FLEET_INTENT_VALUE_CONSTRAINT = Object.freeze({
  EXACT: "exact",
  MAY_DIFFER: "may-differ",
  MUST_DIFFER: "must-differ",
})

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const LEGACY_FLEET_INTENT_SCHEMA_VERSION_ONE = 1
const LEGACY_FLEET_INTENT_SCHEMA_VERSION_TWO = 2
const REVISION_PATTERN = /^[a-f0-9]{64}$/

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function isTimestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value))
}

function isIdentifier(value) {
  return typeof value === "string" && IDENTIFIER_PATTERN.test(value)
}

function isLabel(value, maximum = FLEET_INTENT_LABEL_MAX_LENGTH) {
  return typeof value === "string"
    && value.trim().length > 0
    && value.length <= maximum
}

function isJsonValue(value) {
  if (value === null) return true
  if (["boolean", "string"].includes(typeof value)) return true
  if (typeof value === "number") return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(isJsonValue)
  if (!isObject(value)) return false
  return Object.entries(value).every(
    ([key, entry]) => typeof key === "string" && isJsonValue(entry),
  )
}

function hasUniqueIds(entries) {
  return new Set(entries.map((entry) => entry.id)).size === entries.length
}

function allZonesGroup() {
  return {
    id: FLEET_INTENT_ALL_ZONES_GROUP_ID,
    members: [],
    mode: FLEET_INTENT_GROUP_MODE.ALL,
    name: "All zones",
  }
}

export function createEmptyFleetIntentDocument(accountId) {
  if (!isLabel(accountId)) throw new TypeError("Fleet intent requires an account identifier")
  return {
    accountId,
    acknowledgements: [],
    coverageExpectations: [],
    groups: [allZonesGroup()],
    policies: [],
    revision: FLEET_INTENT_EMPTY_REVISION,
    schemaVersion: FLEET_INTENT_SCHEMA_VERSION,
    updatedAt: null,
  }
}

function isGroup(group) {
  if (!isObject(group) || !isIdentifier(group.id) || !isLabel(group.name)) return false
  if (!Object.values(FLEET_INTENT_GROUP_MODE).includes(group.mode)) return false
  if (!Array.isArray(group.members)) return false
  if (group.mode === FLEET_INTENT_GROUP_MODE.ALL && group.members.length > 0) return false
  const membersValid = group.members.every((member) => (
    isObject(member)
      && isLabel(member.zoneId)
      && isLabel(member.zoneName)
  ))
  return membersValid
    && new Set(group.members.map((member) => member.zoneId)).size === group.members.length
}

function isExpected(expected) {
  const expectedOrigin = expected?.origin
    ?? FLEET_INTENT_EXPECTED_ORIGIN.OBSERVED
  const sourceValid = expectedOrigin === FLEET_INTENT_EXPECTED_ORIGIN.AUTHORED
    ? expected?.sourceZoneId === null
      && expected?.sourceZoneName === null
    : isLabel(expected?.sourceZoneId)
      && isLabel(expected?.sourceZoneName)
  return isObject(expected)
    && Object.values(FLEET_INTENT_EXPECTED_ORIGIN).includes(expectedOrigin)
    && isLabel(expected.canonical, 100000)
    && typeof expected.display === "string"
    && isJsonValue(expected.value)
    && sourceValid
    && (expected.resolutionCanonical === null
      || isLabel(expected.resolutionCanonical, 100000))
}

export function fleetIntentPolicyValueConstraint(policy) {
  return policy?.valueConstraint === undefined
    ? FLEET_INTENT_VALUE_CONSTRAINT.EXACT
    : policy.valueConstraint
}

function isPolicy(policy) {
  const valueConstraint = fleetIntentPolicyValueConstraint(policy)
  const expectedValid = valueConstraint === FLEET_INTENT_VALUE_CONSTRAINT.EXACT
    ? isExpected(policy?.expected)
    : policy?.expected === null
  return isObject(policy)
    && isIdentifier(policy.id)
    && isIdentifier(policy.groupId)
    && isObject(policy.facet)
    && isLabel(policy.facet.category)
    && isLabel(policy.facet.key, 1000)
    && isLabel(policy.facet.label)
    && (policy.facet.description === undefined
      || typeof policy.facet.description === "string")
    && Object.values(FLEET_INTENT_VALUE_CONSTRAINT).includes(valueConstraint)
    && expectedValid
}

export function createAuthoredFleetIntentExpected(value) {
  if (!isJsonValue(value)) {
    throw new TypeError("Fleet intent requires a JSON-compatible expected value")
  }
  return {
    canonical: stableString(value),
    display: shortDisplay(value),
    origin: FLEET_INTENT_EXPECTED_ORIGIN.AUTHORED,
    resolutionCanonical: null,
    sourceZoneId: null,
    sourceZoneName: null,
    value: structuredClone(value),
  }
}

export function fleetIntentExpectedIsAuthored(expected) {
  return expected?.origin === FLEET_INTENT_EXPECTED_ORIGIN.AUTHORED
}

function isAcknowledgement(acknowledgement) {
  return isObject(acknowledgement)
    && isIdentifier(acknowledgement.id)
    && isIdentifier(acknowledgement.policyId)
    && isLabel(acknowledgement.zoneId)
    && isLabel(acknowledgement.zoneName)
    && isLabel(acknowledgement.observedCanonical, 100000)
    && isLabel(acknowledgement.reason, FLEET_INTENT_REASON_MAX_LENGTH)
    && isTimestamp(acknowledgement.createdAt)
    && isTimestamp(acknowledgement.updatedAt)
}

function isCoverageTarget(target) {
  if (!isObject(target)
    || !Object.values(INVENTORY_COVERAGE_KIND).includes(target.kind)
    || !isIdentifier(target.subjectId)
    || !isLabel(target.subjectLabel)
    || !isLabel(target.observedCanonical, 100000)) return false
  if (target.kind === INVENTORY_COVERAGE_KIND.SURFACE) {
    return isLabel(target.zoneId) && isLabel(target.zoneName)
  }
  return target.zoneId === null && target.zoneName === null
}

function isCoverageExpectation(expectation) {
  return isCoverageTarget(expectation)
    && isIdentifier(expectation.id)
    && isLabel(expectation.reason, FLEET_INTENT_REASON_MAX_LENGTH)
    && isTimestamp(expectation.createdAt)
    && isTimestamp(expectation.updatedAt)
}

export function fleetIntentCoverageTargetKey(target) {
  if (!isCoverageTarget(target)) {
    throw new TypeError("Fleet intent coverage target is invalid")
  }
  return JSON.stringify([
    target.kind,
    target.subjectId,
    target.zoneId,
  ])
}

function isFleetIntentDocumentVersion(value, accountId, schemaVersion) {
  if (!isObject(value)) return false
  if (value.schemaVersion !== schemaVersion) return false
  if (!isLabel(value.accountId)) return false
  if (accountId !== null && value.accountId !== accountId) return false
  if (value.revision !== FLEET_INTENT_EMPTY_REVISION
    && (typeof value.revision !== "string" || !REVISION_PATTERN.test(value.revision))) return false
  if (value.updatedAt !== null && !isTimestamp(value.updatedAt)) return false
  if (!Array.isArray(value.groups) || !value.groups.every(isGroup)) return false
  if (!Array.isArray(value.policies) || !value.policies.every(isPolicy)) return false
  if (!Array.isArray(value.acknowledgements)
    || !value.acknowledgements.every(isAcknowledgement)) return false
  if (schemaVersion === FLEET_INTENT_SCHEMA_VERSION
    && (!Array.isArray(value.coverageExpectations)
      || !value.coverageExpectations.every(isCoverageExpectation))) return false
  if (!hasUniqueIds(value.groups)
    || !hasUniqueIds(value.policies)
    || !hasUniqueIds(value.acknowledgements)
    || (schemaVersion === FLEET_INTENT_SCHEMA_VERSION
      && !hasUniqueIds(value.coverageExpectations))) return false
  if (schemaVersion === FLEET_INTENT_SCHEMA_VERSION
    && new Set(value.coverageExpectations.map(fleetIntentCoverageTargetKey)).size
      !== value.coverageExpectations.length) return false
  if (new Set(value.groups.map((group) => group.name.trim().toLowerCase())).size
    !== value.groups.length) return false
  const allGroup = value.groups.find(
    (group) => group.id === FLEET_INTENT_ALL_ZONES_GROUP_ID,
  )
  if (!allGroup
    || allGroup.mode !== FLEET_INTENT_GROUP_MODE.ALL
    || allGroup.name !== "All zones") return false
  const groupIds = new Set(value.groups.map((group) => group.id))
  if (value.policies.some((policy) => !groupIds.has(policy.groupId))) return false
  const policyIds = new Set(value.policies.map((policy) => policy.id))
  return value.acknowledgements.every(
    (acknowledgement) => policyIds.has(acknowledgement.policyId),
  )
}

export function isFleetIntentDocument(value, accountId = null) {
  return isFleetIntentDocumentVersion(
    value,
    accountId,
    FLEET_INTENT_SCHEMA_VERSION,
  )
}

export function migrateFleetIntentDocument(value, accountId = null) {
  if (isFleetIntentDocument(value, accountId)) return structuredClone(value)
  const versionOneValid = isFleetIntentDocumentVersion(
    value,
    accountId,
    LEGACY_FLEET_INTENT_SCHEMA_VERSION_ONE,
  ) && value.policies.every((policy) => policy.valueConstraint === undefined)
  const versionTwoValid = isFleetIntentDocumentVersion(
    value,
    accountId,
    LEGACY_FLEET_INTENT_SCHEMA_VERSION_TWO,
  )
  if (!versionOneValid && !versionTwoValid) {
    throw new TypeError("Fleet intent document cannot be migrated")
  }
  const migrated = {
    ...structuredClone(value),
    coverageExpectations: [],
    policies: versionOneValid
      ? value.policies.map((policy) => ({
        ...structuredClone(policy),
        valueConstraint: FLEET_INTENT_VALUE_CONSTRAINT.EXACT,
      }))
      : structuredClone(value.policies),
    schemaVersion: FLEET_INTENT_SCHEMA_VERSION,
  }
  if (!isFleetIntentDocument(migrated, accountId)) {
    throw new TypeError("Fleet intent migration produced an invalid document")
  }
  return migrated
}

export function fleetIntentFacetId(category, key) {
  return JSON.stringify([String(category), String(key)])
}

export function fleetIntentPolicyFacetId(policy) {
  return fleetIntentFacetId(policy.facet.category, policy.facet.key)
}

export function cloneFleetIntentDocument(document) {
  if (!isFleetIntentDocument(document)) throw new TypeError("Fleet intent document is invalid")
  return structuredClone(document)
}

export function replaceFleetIntentGroup(document, group) {
  const next = cloneFleetIntentDocument(document)
  if (!isGroup(group)) throw new TypeError("Fleet intent group is invalid")
  if (group.id === FLEET_INTENT_ALL_ZONES_GROUP_ID) {
    throw new TypeError("The all-zones group cannot be replaced")
  }
  const normalizedName = group.name.trim().toLowerCase()
  if (next.groups.some((entry) => entry.id !== group.id
    && entry.name.trim().toLowerCase() === normalizedName)) {
    throw new TypeError("Zone group names must be unique")
  }
  next.groups = [
    ...next.groups.filter((entry) => entry.id !== group.id),
    structuredClone(group),
  ]
  if (!isFleetIntentDocument(next)) throw new TypeError("Fleet intent group produced an invalid document")
  return next
}

export function removeFleetIntentGroup(document, groupId) {
  if (groupId === FLEET_INTENT_ALL_ZONES_GROUP_ID) {
    throw new TypeError("The all-zones group cannot be removed")
  }
  if (document.policies.some((policy) => policy.groupId === groupId)) {
    throw new TypeError("Remove or retarget policies that use this group first")
  }
  const next = cloneFleetIntentDocument(document)
  next.groups = next.groups.filter((group) => group.id !== groupId)
  if (next.groups.length === document.groups.length) {
    throw new TypeError("Fleet intent group was not found")
  }
  return next
}

export function replaceFleetIntentPolicy(document, policy) {
  const next = cloneFleetIntentDocument(document)
  if (!isPolicy(policy)) throw new TypeError("Fleet intent policy is invalid")
  if (!next.groups.some((group) => group.id === policy.groupId)) {
    throw new TypeError("Fleet intent policy group was not found")
  }
  next.policies = [
    ...next.policies.filter((entry) => entry.id !== policy.id),
    structuredClone(policy),
  ]
  if (!isFleetIntentDocument(next)) throw new TypeError("Fleet intent policy produced an invalid document")
  return next
}

export function removeFleetIntentPolicy(document, policyId) {
  const next = cloneFleetIntentDocument(document)
  next.policies = next.policies.filter((policy) => policy.id !== policyId)
  if (next.policies.length === document.policies.length) {
    throw new TypeError("Fleet intent policy was not found")
  }
  next.acknowledgements = next.acknowledgements.filter(
    (acknowledgement) => acknowledgement.policyId !== policyId,
  )
  return next
}

export function replaceFleetIntentAcknowledgement(document, acknowledgement) {
  const next = cloneFleetIntentDocument(document)
  if (!isAcknowledgement(acknowledgement)) {
    throw new TypeError("Fleet intent acknowledgement is invalid")
  }
  if (!next.policies.some((policy) => policy.id === acknowledgement.policyId)) {
    throw new TypeError("Fleet intent acknowledgement policy was not found")
  }
  next.acknowledgements = [
    ...next.acknowledgements.filter((entry) => entry.id !== acknowledgement.id),
    structuredClone(acknowledgement),
  ]
  if (!isFleetIntentDocument(next)) {
    throw new TypeError("Fleet intent acknowledgement produced an invalid document")
  }
  return next
}

export function removeFleetIntentAcknowledgement(document, acknowledgementId) {
  const next = cloneFleetIntentDocument(document)
  next.acknowledgements = next.acknowledgements.filter(
    (acknowledgement) => acknowledgement.id !== acknowledgementId,
  )
  if (next.acknowledgements.length === document.acknowledgements.length) {
    throw new TypeError("Fleet intent acknowledgement was not found")
  }
  return next
}

export function replaceFleetIntentCoverageExpectation(document, expectation) {
  const next = cloneFleetIntentDocument(document)
  if (!isCoverageExpectation(expectation)) {
    throw new TypeError("Fleet intent coverage expectation is invalid")
  }
  const targetKey = fleetIntentCoverageTargetKey(expectation)
  if (next.coverageExpectations.some(
    (entry) => entry.id !== expectation.id
      && fleetIntentCoverageTargetKey(entry) === targetKey,
  )) {
    throw new TypeError("Fleet intent coverage target already has an expectation")
  }
  next.coverageExpectations = [
    ...next.coverageExpectations.filter((entry) => entry.id !== expectation.id),
    structuredClone(expectation),
  ]
  if (!isFleetIntentDocument(next)) {
    throw new TypeError("Fleet intent coverage expectation produced an invalid document")
  }
  return next
}

export function removeFleetIntentCoverageExpectation(document, expectationId) {
  const next = cloneFleetIntentDocument(document)
  next.coverageExpectations = next.coverageExpectations.filter(
    (expectation) => expectation.id !== expectationId,
  )
  if (next.coverageExpectations.length === document.coverageExpectations.length) {
    throw new TypeError("Fleet intent coverage expectation was not found")
  }
  return next
}

export function evaluateFleetIntentCoverage(document, issues) {
  if (!isFleetIntentDocument(document)) {
    throw new TypeError("Fleet intent document is invalid")
  }
  if (!Array.isArray(issues) || !issues.every(isCoverageTarget)) {
    throw new TypeError("Fleet intent coverage issues are invalid")
  }
  const issuesByTarget = new Map()
  for (const issue of issues) {
    const targetKey = fleetIntentCoverageTargetKey(issue)
    if (issuesByTarget.has(targetKey)) {
      throw new TypeError("Fleet intent coverage issues contain duplicate targets")
    }
    issuesByTarget.set(targetKey, issue)
  }
  const expectationsByTarget = new Map(document.coverageExpectations.map(
    (expectation) => [fleetIntentCoverageTargetKey(expectation), expectation],
  ))
  const issueStates = issues.map((issue) => {
    const expectation = expectationsByTarget.get(
      fleetIntentCoverageTargetKey(issue),
    ) || null
    return {
      expectation,
      expected: expectation?.observedCanonical === issue.observedCanonical,
      issue,
    }
  })
  const expectationStates = document.coverageExpectations.map((expectation) => {
    const issue = issuesByTarget.get(
      fleetIntentCoverageTargetKey(expectation),
    ) || null
    return {
      expectation,
      issue,
      status: !issue
        ? FLEET_INTENT_COVERAGE_EXPECTATION_STATUS.INACTIVE
        : issue.observedCanonical === expectation.observedCanonical
          ? FLEET_INTENT_COVERAGE_EXPECTATION_STATUS.ACTIVE
          : FLEET_INTENT_COVERAGE_EXPECTATION_STATUS.CHANGED,
    }
  })
  return {
    expectationStates,
    expectedIssues: issueStates.filter((entry) => entry.expected),
    issueStates,
    summary: {
      active: expectationStates.filter(
        (entry) => entry.status === FLEET_INTENT_COVERAGE_EXPECTATION_STATUS.ACTIVE,
      ).length,
      changed: expectationStates.filter(
        (entry) => entry.status === FLEET_INTENT_COVERAGE_EXPECTATION_STATUS.CHANGED,
      ).length,
      inactive: expectationStates.filter(
        (entry) => entry.status === FLEET_INTENT_COVERAGE_EXPECTATION_STATUS.INACTIVE,
      ).length,
      unexpected: issueStates.filter((entry) => !entry.expected).length,
    },
    unexpectedIssues: issueStates.filter((entry) => !entry.expected),
  }
}

export function fleetIntentGroupZoneIds(group, inventory) {
  if (group.mode === FLEET_INTENT_GROUP_MODE.ALL) {
    return inventory.zones.map((zone) => zone.meta.id)
  }
  return group.members.map((member) => member.zoneId)
}

function observedCanonical(row, zoneName) {
  const cell = row?.cells.get(zoneName)
  return cell?.intentCanonical
    ?? cell?.canonical
    ?? FLEET_INTENT_MISSING_CANONICAL
}

function uniquenessCanonical(row, zoneName) {
  const cell = row?.cells.get(zoneName)
  return cell?.uniquenessCanonical
    ?? cell?.intentCanonical
    ?? cell?.canonical
    ?? FLEET_INTENT_MISSING_CANONICAL
}

function basePolicyCellStatus(valueConstraint, expected, observation, duplicateCount) {
  if (observation.observedCanonical === FLEET_INTENT_MISSING_CANONICAL) {
    return FLEET_INTENT_CELL_STATUS.MISSING
  }
  if (valueConstraint === FLEET_INTENT_VALUE_CONSTRAINT.MAY_DIFFER) {
    return FLEET_INTENT_CELL_STATUS.MATCH
  }
  if (valueConstraint === FLEET_INTENT_VALUE_CONSTRAINT.MUST_DIFFER) {
    return duplicateCount > 1
      ? FLEET_INTENT_CELL_STATUS.VARIANT
      : FLEET_INTENT_CELL_STATUS.MATCH
  }
  return observation.observedCanonical === expected.canonical
    ? FLEET_INTENT_CELL_STATUS.MATCH
    : FLEET_INTENT_CELL_STATUS.VARIANT
}

function policyEvaluation(policy, group, row, inventory, acknowledgements) {
  const zoneById = new Map(inventory.zones.map((zone) => [zone.meta.id, zone]))
  const targetedZoneIds = fleetIntentGroupZoneIds(group, inventory)
  const valueConstraint = fleetIntentPolicyValueConstraint(policy)
  const observations = targetedZoneIds
    .map((zoneId) => zoneById.get(zoneId))
    .filter(Boolean)
    .map((zone) => ({
      observedCanonical: observedCanonical(row, zone.meta.name),
      uniquenessCanonical: uniquenessCanonical(row, zone.meta.name),
      zone,
    }))
  const uniquenessCounts = new Map()
  for (const observation of observations) {
    if (observation.observedCanonical === FLEET_INTENT_MISSING_CANONICAL) continue
    uniquenessCounts.set(
      observation.uniquenessCanonical,
      (uniquenessCounts.get(observation.uniquenessCanonical) || 0) + 1,
    )
  }
  const cells = new Map()
  for (const observation of observations) {
    const duplicateCount = uniquenessCounts.get(observation.uniquenessCanonical) || 0
    const statusWithoutAcknowledgement = basePolicyCellStatus(
      valueConstraint,
      policy.expected,
      observation,
      duplicateCount,
    )
    const acknowledgement = acknowledgements.find(
      (entry) => entry.policyId === policy.id
        && entry.zoneId === observation.zone.meta.id
        && entry.observedCanonical === observation.observedCanonical,
    ) || null
    const actionable = statusWithoutAcknowledgement === FLEET_INTENT_CELL_STATUS.MISSING
      || statusWithoutAcknowledgement === FLEET_INTENT_CELL_STATUS.VARIANT
    const duplicateZoneNames = valueConstraint === FLEET_INTENT_VALUE_CONSTRAINT.MUST_DIFFER
      && statusWithoutAcknowledgement === FLEET_INTENT_CELL_STATUS.VARIANT
      ? observations
          .filter((candidate) => candidate.zone.meta.id !== observation.zone.meta.id
            && candidate.uniquenessCanonical === observation.uniquenessCanonical)
          .map((candidate) => candidate.zone.meta.name)
      : []
    cells.set(observation.zone.meta.id, {
      acknowledgement,
      duplicateZoneNames,
      observedCanonical: observation.observedCanonical,
      policy,
      status: acknowledgement && actionable
        ? FLEET_INTENT_CELL_STATUS.ACKNOWLEDGED
        : statusWithoutAcknowledgement,
      statusWithoutAcknowledgement,
      uniquenessCanonical: observation.uniquenessCanonical,
      zone: observation.zone,
    })
  }
  const statuses = [...cells.values()].map((cell) => cell.status)
  const unavailableZoneIds = targetedZoneIds.filter((zoneId) => !zoneById.has(zoneId))
  return {
    acknowledgementCount: statuses.filter(
      (status) => status === FLEET_INTENT_CELL_STATUS.ACKNOWLEDGED,
    ).length,
    actionableCount: statuses.filter(
      (status) => status === FLEET_INTENT_CELL_STATUS.MISSING
        || status === FLEET_INTENT_CELL_STATUS.VARIANT,
    ).length,
    cells,
    matchCount: statuses.filter(
      (status) => status === FLEET_INTENT_CELL_STATUS.MATCH,
    ).length,
    policy,
    targetCount: cells.size,
    unavailableZoneIds,
    unresolved: !row || unavailableZoneIds.length > 0,
  }
}

function acknowledgementEvaluation(
  acknowledgement,
  policyState,
  row,
  rowState,
  inventory,
) {
  const policy = policyState?.policy || null
  const zone = inventory.zones.find(
    (candidate) => candidate.meta.id === acknowledgement.zoneId,
  ) || null
  let reason = ""
  if (!policy) reason = "Its policy no longer exists"
  else if (!row) reason = "Its facet is not present in the loaded matrix"
  else if (!zone) reason = "Its zone is not present in the loaded inventory"
  else if (!policyState.cells.has(zone.meta.id)) reason = "Its zone is no longer targeted by the policy"
  else if (rowState?.cells.get(zone.meta.id)?.status === FLEET_INTENT_CELL_STATUS.CONFLICT) {
    reason = "Overlapping policies conflict on this cell"
  }
  else {
    const observed = observedCanonical(row, zone.meta.name)
    const policyCell = policyState.cells.get(zone.meta.id)
    if (policyCell?.statusWithoutAcknowledgement === FLEET_INTENT_CELL_STATUS.MATCH) {
      reason = "The cell now satisfies intent"
    }
    else if (observed !== acknowledgement.observedCanonical) reason = "The observed state changed"
  }
  return {
    acknowledgement,
    reason,
    status: reason
      ? FLEET_INTENT_ACKNOWLEDGEMENT_STATUS.STALE
      : FLEET_INTENT_ACKNOWLEDGEMENT_STATUS.ACTIVE,
  }
}

export function evaluateFleetIntent(document, inventory, matrix) {
  if (!isFleetIntentDocument(document, inventory.account?.id)) {
    throw new TypeError("Fleet intent document is invalid for this inventory")
  }
  const rowsByFacet = new Map(
    matrix.rows.map((row) => [fleetIntentFacetId(row.category, row.key), row]),
  )
  const groupsById = new Map(document.groups.map((group) => [group.id, group]))
  const policyStates = document.policies.map((policy) => {
    const row = rowsByFacet.get(fleetIntentPolicyFacetId(policy)) || null
    return policyEvaluation(
      policy,
      groupsById.get(policy.groupId),
      row,
      inventory,
      document.acknowledgements,
    )
  })
  const policyStatesById = new Map(
    policyStates.map((policyState) => [policyState.policy.id, policyState]),
  )
  const policyStatesByFacet = new Map()
  for (const policyState of policyStates) {
    const facetId = fleetIntentPolicyFacetId(policyState.policy)
    if (!policyStatesByFacet.has(facetId)) policyStatesByFacet.set(facetId, [])
    policyStatesByFacet.get(facetId).push(policyState)
  }

  const rowStates = new Map()
  for (const row of matrix.rows) {
    const facetId = fleetIntentFacetId(row.category, row.key)
    const matchingPolicies = policyStatesByFacet.get(facetId) || []
    const cells = new Map()
    for (const zone of inventory.zones) {
      const targeting = matchingPolicies.filter(
        (policyState) => policyState.cells.has(zone.meta.id),
      )
      if (targeting.length === 0) {
        cells.set(zone.meta.id, {
          acknowledgement: null,
          observedCanonical: observedCanonical(row, zone.meta.name),
          policies: [],
          status: matchingPolicies.length === 0
            ? FLEET_INTENT_CELL_STATUS.UNGOVERNED
            : FLEET_INTENT_CELL_STATUS.OUT_OF_SCOPE,
          zone,
        })
        continue
      }
      if (targeting.length > 1) {
        cells.set(zone.meta.id, {
          acknowledgement: null,
          observedCanonical: observedCanonical(row, zone.meta.name),
          policies: targeting.map((policyState) => policyState.policy),
          status: FLEET_INTENT_CELL_STATUS.CONFLICT,
          zone,
        })
        continue
      }
      const policyCell = targeting[0].cells.get(zone.meta.id)
      cells.set(zone.meta.id, {
        ...policyCell,
        policies: [policyCell.policy],
      })
    }
    const actionableCells = [...cells.values()].filter(
      (cell) => cell.status === FLEET_INTENT_CELL_STATUS.CONFLICT
        || cell.status === FLEET_INTENT_CELL_STATUS.MISSING
        || cell.status === FLEET_INTENT_CELL_STATUS.VARIANT,
    )
    rowStates.set(facetId, {
      actionable: matchingPolicies.length > 0
        ? actionableCells.length > 0
        : row.different,
      actionableCells,
      cells,
      governed: matchingPolicies.length > 0,
      policies: matchingPolicies.map((policyState) => policyState.policy),
      row,
    })
  }

  const acknowledgementStates = document.acknowledgements.map((acknowledgement) => {
    const policyState = policyStatesById.get(acknowledgement.policyId) || null
    const row = policyState
      ? rowsByFacet.get(fleetIntentPolicyFacetId(policyState.policy)) || null
      : null
    const rowState = policyState
      ? rowStates.get(fleetIntentPolicyFacetId(policyState.policy)) || null
      : null
    return acknowledgementEvaluation(
      acknowledgement,
      policyState,
      row,
      rowState,
      inventory,
    )
  })
  const activeAcknowledgements = acknowledgementStates.filter(
    (entry) => entry.status === FLEET_INTENT_ACKNOWLEDGEMENT_STATUS.ACTIVE,
  )
  const staleAcknowledgements = acknowledgementStates.filter(
    (entry) => entry.status === FLEET_INTENT_ACKNOWLEDGEMENT_STATUS.STALE,
  )
  const actionableCells = [...rowStates.values()].flatMap(
    (rowState) => rowState.actionableCells,
  )
  return {
    acknowledgementStates,
    activeAcknowledgements,
    policyStates,
    rowStates,
    staleAcknowledgements,
    summary: {
      acknowledgedCells: activeAcknowledgements.length,
      actionableCells: actionableCells.length,
      actionableRows: [...rowStates.values()].filter((rowState) => rowState.actionable).length,
      governedRows: [...rowStates.values()].filter((rowState) => rowState.governed).length,
      policies: policyStates.length,
      staleAcknowledgements: staleAcknowledgements.length,
      unresolvedPolicies: policyStates.filter((policyState) => policyState.unresolved).length,
    },
  }
}
