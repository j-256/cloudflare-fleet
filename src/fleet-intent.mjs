import {
  shortDisplay,
  stableString,
} from "./normalize.mjs"
import {
  INVENTORY_COVERAGE_KIND,
  MATRIX_CATEGORY,
} from "./constants.mjs"
import { dnssecRequestedStatus } from "./dnssec.mjs"
import { editableEmailRoutingRulePayload } from "./policies.mjs"
import { redirectIntentValueProjection } from "./facet-equivalence.mjs"

export const FLEET_INTENT_SCHEMA_VERSION = 7
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

export const FLEET_INTENT_ROW_STATUS = Object.freeze({
  DRIFT: "drift",
  MATCH: "match",
  REVIEW: "review",
  UNGOVERNED: "ungoverned",
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

export const FLEET_INTENT_PRESENCE_CONSTRAINT = Object.freeze({
  FORBIDDEN: "forbidden",
  OPTIONAL: "optional",
  REQUIRED: "required",
})

export const FLEET_INTENT_POLICY_CONFLICT_KIND = Object.freeze({
  EXACT_VALUE: "exact-value",
  PRESENCE: "presence",
})

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const DNSSEC_INTENT_CATEGORY = "DNSSEC"
const DNSSEC_INTENT_CONFIGURATION_KEY = "configuration"
const EMAIL_INTENT_CATEGORY = "Email"
const EMAIL_INTENT_CATCH_ALL_KEY = "catch-all"
const EMAIL_ROUTE_INTENT_CATEGORY = "Email routes"
const LEGACY_FLEET_INTENT_SCHEMA_VERSION_ONE = 1
const LEGACY_FLEET_INTENT_SCHEMA_VERSION_TWO = 2
const LEGACY_FLEET_INTENT_SCHEMA_VERSION_THREE = 3
const LEGACY_FLEET_INTENT_SCHEMA_VERSION_FOUR = 4
const LEGACY_FLEET_INTENT_SCHEMA_VERSION_FIVE = 5
const LEGACY_FLEET_INTENT_SCHEMA_VERSION_SIX = 6
const REVISION_PATTERN = /^[a-f0-9]{64}$/
const COMPOSED_CELL_STATUS_PRIORITY = Object.freeze({
  [FLEET_INTENT_CELL_STATUS.MATCH]: 0,
  [FLEET_INTENT_CELL_STATUS.ACKNOWLEDGED]: 1,
  [FLEET_INTENT_CELL_STATUS.VARIANT]: 2,
  [FLEET_INTENT_CELL_STATUS.MISSING]: 3,
})
const COMPOSED_CELL_UNACKNOWLEDGED_STATUS_PRIORITY = Object.freeze({
  [FLEET_INTENT_CELL_STATUS.MATCH]: 0,
  [FLEET_INTENT_CELL_STATUS.VARIANT]: 1,
  [FLEET_INTENT_CELL_STATUS.MISSING]: 2,
})

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

export function fleetIntentPolicyPresenceConstraint(policy) {
  return policy?.presenceConstraint === undefined
    ? FLEET_INTENT_PRESENCE_CONSTRAINT.REQUIRED
    : policy.presenceConstraint
}

function isDnssecIntentPolicy(policy) {
  return policy?.facet?.category === DNSSEC_INTENT_CATEGORY
    && policy.facet.key === DNSSEC_INTENT_CONFIGURATION_KEY
}

function isRedirectIntentPolicy(policy) {
  return policy?.facet?.category === MATRIX_CATEGORY.REDIRECTS
}

function dnssecStatusExpectedIsNormalized(expected) {
  if (!isObject(expected?.value)) return false
  const keys = Object.keys(expected.value)
  if (keys.length !== 1 || keys[0] !== "status") return false
  if (typeof expected.value.status !== "string" || expected.value.status.length === 0) {
    return false
  }
  const canonical = stableString(expected.value)
  return expected.canonical === canonical
    && (expected.resolutionCanonical === null
      || expected.resolutionCanonical === canonical)
}

function emailRoutingIntentOptions(policy) {
  if (policy?.facet?.category === EMAIL_ROUTE_INTENT_CATEGORY) {
    return { catchAll: false }
  }
  if (policy?.facet?.category === EMAIL_INTENT_CATEGORY
    && policy.facet.key === EMAIL_INTENT_CATCH_ALL_KEY) {
    return { catchAll: true }
  }
  return null
}

function emailRoutingIntentProjection(policy, value) {
  const options = emailRoutingIntentOptions(policy)
  if (!options) return null
  const projected = editableEmailRoutingRulePayload(value, options)
  if (!options.catchAll) delete projected.priority
  return projected
}

function normalizeObservedEmailRoutingIntentPolicy(policy) {
  const expectedOrigin = policy?.expected?.origin
    ?? FLEET_INTENT_EXPECTED_ORIGIN.OBSERVED
  if (fleetIntentPolicyValueConstraint(policy)
      !== FLEET_INTENT_VALUE_CONSTRAINT.EXACT
    || expectedOrigin !== FLEET_INTENT_EXPECTED_ORIGIN.OBSERVED) return policy
  const value = emailRoutingIntentProjection(policy, policy.expected?.value)
  if (value === null) return policy
  const canonical = stableString(value)
  return {
    ...policy,
    expected: {
      ...policy.expected,
      canonical,
      display: shortDisplay(value),
      resolutionCanonical: policy.expected.resolutionCanonical === null
        ? null
        : canonical,
      value,
    },
  }
}

function emailRoutingIntentExpectedIsNormalized(policy) {
  const normalized = normalizeObservedEmailRoutingIntentPolicy(
    structuredClone(policy),
  )
  return stableString(normalized) === stableString(policy)
}

function normalizeRedirectIntentPolicy(policy) {
  if (!isRedirectIntentPolicy(policy)
    || fleetIntentPolicyValueConstraint(policy)
      !== FLEET_INTENT_VALUE_CONSTRAINT.EXACT
    || !policy.expected) return policy
  const value = redirectIntentValueProjection(policy.expected.value)
  const canonical = stableString(value)
  return {
    ...policy,
    expected: {
      ...policy.expected,
      canonical,
      display: shortDisplay(value),
      value,
    },
  }
}

function redirectIntentExpectedIsNormalized(policy) {
  const normalized = normalizeRedirectIntentPolicy(
    structuredClone(policy),
  )
  return stableString(normalized) === stableString(policy)
}

function normalizeFleetIntentPolicy(policy) {
  let normalized = structuredClone(policy)
  normalized.presenceConstraint = fleetIntentPolicyPresenceConstraint(normalized)
  if (normalized.presenceConstraint === FLEET_INTENT_PRESENCE_CONSTRAINT.FORBIDDEN) {
    normalized.expected = null
    normalized.valueConstraint = FLEET_INTENT_VALUE_CONSTRAINT.MAY_DIFFER
    return normalized
  }
  if (isDnssecIntentPolicy(normalized)
    && fleetIntentPolicyValueConstraint(normalized)
      === FLEET_INTENT_VALUE_CONSTRAINT.EXACT) {
    const observedStatus = normalized.expected?.value?.status
    const status = dnssecRequestedStatus(observedStatus) ?? observedStatus
    if (typeof status === "string" && status.length > 0) {
      const value = { status }
      const canonical = stableString(value)
      normalized.expected = {
        ...normalized.expected,
        canonical,
        display: status,
        resolutionCanonical: normalized.expected.resolutionCanonical === null
          ? null
          : canonical,
        value,
      }
    }
  }
  normalized = normalizeObservedEmailRoutingIntentPolicy(normalized)
  normalized = normalizeRedirectIntentPolicy(normalized)
  return normalized
}

function isPolicy(policy, options = {}) {
  const presenceConstraint = fleetIntentPolicyPresenceConstraint(policy)
  const valueConstraint = fleetIntentPolicyValueConstraint(policy)
  const expectedValid = presenceConstraint === FLEET_INTENT_PRESENCE_CONSTRAINT.FORBIDDEN
    ? valueConstraint === FLEET_INTENT_VALUE_CONSTRAINT.MAY_DIFFER
      && policy?.expected === null
    : valueConstraint === FLEET_INTENT_VALUE_CONSTRAINT.EXACT
      ? isExpected(policy?.expected)
      : policy?.expected === null
  return isObject(policy)
    && isIdentifier(policy.id)
    && isIdentifier(policy.groupId)
    && isObject(policy.facet)
    && isLabel(policy.facet.category)
    && isLabel(policy.facet.key, 1000)
    && isLabel(policy.facet.label)
    && (policy.facet.phase === undefined || isLabel(policy.facet.phase))
    && (policy.facet.description === undefined
      || typeof policy.facet.description === "string")
    && Object.values(FLEET_INTENT_PRESENCE_CONSTRAINT).includes(presenceConstraint)
    && Object.values(FLEET_INTENT_VALUE_CONSTRAINT).includes(valueConstraint)
    && expectedValid
    && (!options.requireNormalizedPresence
      || policy.presenceConstraint === presenceConstraint)
    && (!options.requireNormalizedDnssec
      || !isDnssecIntentPolicy(policy)
      || valueConstraint !== FLEET_INTENT_VALUE_CONSTRAINT.EXACT
      || dnssecStatusExpectedIsNormalized(policy.expected))
    && (!options.requireNormalizedEmailRouting
      || emailRoutingIntentExpectedIsNormalized(policy))
    && (!options.requireNormalizedRedirect
      || redirectIntentExpectedIsNormalized(policy))
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
  const supportsCoverageIntent = schemaVersion === FLEET_INTENT_SCHEMA_VERSION
    || schemaVersion === LEGACY_FLEET_INTENT_SCHEMA_VERSION_THREE
    || schemaVersion === LEGACY_FLEET_INTENT_SCHEMA_VERSION_FOUR
    || schemaVersion === LEGACY_FLEET_INTENT_SCHEMA_VERSION_FIVE
    || schemaVersion === LEGACY_FLEET_INTENT_SCHEMA_VERSION_SIX
  if (!isObject(value)) return false
  if (value.schemaVersion !== schemaVersion) return false
  if (!isLabel(value.accountId)) return false
  if (accountId !== null && value.accountId !== accountId) return false
  if (value.revision !== FLEET_INTENT_EMPTY_REVISION
    && (typeof value.revision !== "string" || !REVISION_PATTERN.test(value.revision))) return false
  if (value.updatedAt !== null && !isTimestamp(value.updatedAt)) return false
  if (!Array.isArray(value.groups) || !value.groups.every(isGroup)) return false
  if (!Array.isArray(value.policies) || !value.policies.every(
    (policy) => isPolicy(policy, {
      requireNormalizedDnssec: schemaVersion === FLEET_INTENT_SCHEMA_VERSION
        || schemaVersion === LEGACY_FLEET_INTENT_SCHEMA_VERSION_FOUR
        || schemaVersion === LEGACY_FLEET_INTENT_SCHEMA_VERSION_FIVE
        || schemaVersion === LEGACY_FLEET_INTENT_SCHEMA_VERSION_SIX,
      requireNormalizedEmailRouting: schemaVersion === FLEET_INTENT_SCHEMA_VERSION
        || schemaVersion === LEGACY_FLEET_INTENT_SCHEMA_VERSION_SIX,
      requireNormalizedPresence: schemaVersion === FLEET_INTENT_SCHEMA_VERSION
        || schemaVersion === LEGACY_FLEET_INTENT_SCHEMA_VERSION_FIVE
        || schemaVersion === LEGACY_FLEET_INTENT_SCHEMA_VERSION_SIX,
      requireNormalizedRedirect: schemaVersion === FLEET_INTENT_SCHEMA_VERSION,
    }),
  )) return false
  if (!Array.isArray(value.acknowledgements)
    || !value.acknowledgements.every(isAcknowledgement)) return false
  if (supportsCoverageIntent
    && (!Array.isArray(value.coverageExpectations)
      || !value.coverageExpectations.every(isCoverageExpectation))) return false
  if (!hasUniqueIds(value.groups)
    || !hasUniqueIds(value.policies)
    || !hasUniqueIds(value.acknowledgements)
    || (supportsCoverageIntent
      && !hasUniqueIds(value.coverageExpectations))) return false
  if (supportsCoverageIntent
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
  const versionThreeValid = isFleetIntentDocumentVersion(
    value,
    accountId,
    LEGACY_FLEET_INTENT_SCHEMA_VERSION_THREE,
  )
  const versionFourValid = isFleetIntentDocumentVersion(
    value,
    accountId,
    LEGACY_FLEET_INTENT_SCHEMA_VERSION_FOUR,
  )
  const versionFiveValid = isFleetIntentDocumentVersion(
    value,
    accountId,
    LEGACY_FLEET_INTENT_SCHEMA_VERSION_FIVE,
  )
  const versionSixValid = isFleetIntentDocumentVersion(
    value,
    accountId,
    LEGACY_FLEET_INTENT_SCHEMA_VERSION_SIX,
  )
  if (!versionOneValid && !versionTwoValid && !versionThreeValid
    && !versionFourValid && !versionFiveValid && !versionSixValid) {
    throw new TypeError("Fleet intent document cannot be migrated")
  }
  const legacyPolicies = versionOneValid
    ? value.policies.map((policy) => ({
      ...structuredClone(policy),
      valueConstraint: FLEET_INTENT_VALUE_CONSTRAINT.EXACT,
    }))
    : structuredClone(value.policies)
  const policies = legacyPolicies.map(normalizeFleetIntentPolicy)
  const dnssecPolicyIds = new Set(
    policies.filter(isDnssecIntentPolicy).map((policy) => policy.id),
  )
  const policiesById = new Map(policies.map((policy) => [policy.id, policy]))
  const acknowledgements = value.acknowledgements.map((acknowledgement) => {
    const normalized = structuredClone(acknowledgement)
    try {
      const observed = JSON.parse(normalized.observedCanonical)
      if (dnssecPolicyIds.has(normalized.policyId)) {
        const status = dnssecRequestedStatus(observed?.status) ?? observed?.status
        if (typeof status === "string" && status.length > 0) {
          normalized.observedCanonical = stableString({ status })
        }
        return normalized
      }
      const projected = emailRoutingIntentProjection(
        policiesById.get(normalized.policyId),
        observed,
      )
      if (projected !== null) {
        normalized.observedCanonical = stableString(projected)
        return normalized
      }
      if (isRedirectIntentPolicy(policiesById.get(normalized.policyId))) {
        normalized.observedCanonical = stableString(
          redirectIntentValueProjection(observed),
        )
      }
    } catch {
      return normalized
    }
    return normalized
  })
  const migrated = {
    ...structuredClone(value),
    acknowledgements,
    coverageExpectations: versionThreeValid || versionFourValid || versionFiveValid
      || versionSixValid
      ? structuredClone(value.coverageExpectations)
      : [],
    policies,
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

function fleetIntentPoliciesShareTarget(left, right) {
  return left.groupId === right.groupId
    && fleetIntentPolicyFacetId(left) === fleetIntentPolicyFacetId(right)
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
    throw new TypeError("Remove policies that use this group first")
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
  const normalizedPolicy = normalizeFleetIntentPolicy(policy)
  if (!isPolicy(normalizedPolicy, {
    requireNormalizedDnssec: true,
    requireNormalizedEmailRouting: true,
    requireNormalizedPresence: true,
    requireNormalizedRedirect: true,
  })) {
    throw new TypeError("Fleet intent policy is invalid")
  }
  if (!next.groups.some((group) => group.id === normalizedPolicy.groupId)) {
    throw new TypeError("Fleet intent policy group was not found")
  }
  const existingPolicy = next.policies.find(
    (entry) => entry.id === normalizedPolicy.id,
  )
  if (existingPolicy && !fleetIntentPoliciesShareTarget(
    existingPolicy,
    normalizedPolicy,
  )) {
    throw new TypeError("Fleet intent policy identifiers cannot be retargeted")
  }
  next.policies = [
    ...next.policies.filter((entry) => entry.id !== normalizedPolicy.id),
    normalizedPolicy,
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

function groupIsStrictlyNarrower(candidate, baseline) {
  if (candidate.mode === FLEET_INTENT_GROUP_MODE.ALL) return false
  if (baseline.mode === FLEET_INTENT_GROUP_MODE.ALL) return true
  const candidateIds = new Set(candidate.members.map((member) => member.zoneId))
  const baselineIds = new Set(baseline.members.map((member) => member.zoneId))
  if (candidateIds.size >= baselineIds.size) return false
  return [...candidateIds].every((zoneId) => baselineIds.has(zoneId))
}

function effectivePolicyScopes(document, inventory, groupsById) {
  const loadedZoneIds = new Set(
    inventory.zones.map((zone) => zone.meta.id),
  )
  const entries = document.policies.map((policy) => {
    const group = groupsById.get(policy.groupId)
    const targetedZoneIds = fleetIntentGroupZoneIds(group, inventory)
    return {
      group,
      loadedTargetZoneIds: targetedZoneIds.filter(
        (zoneId) => loadedZoneIds.has(zoneId),
      ),
      policy,
      targetedZoneIds,
      unavailableZoneIds: targetedZoneIds.filter(
        (zoneId) => !loadedZoneIds.has(zoneId),
      ),
    }
  })
  const scopes = new Map()
  for (const entry of entries) {
    const effectiveZoneIds = []
    const overriddenByZone = new Map()
    for (const zoneId of entry.loadedTargetZoneIds) {
      const overridingPolicies = entries.filter((candidate) => (
        candidate.policy.id !== entry.policy.id
          && fleetIntentPolicyFacetId(candidate.policy)
            === fleetIntentPolicyFacetId(entry.policy)
          && candidate.loadedTargetZoneIds.includes(zoneId)
          && groupIsStrictlyNarrower(candidate.group, entry.group)
      )).map((candidate) => candidate.policy)
        .sort((left, right) => left.id.localeCompare(right.id))
      if (overridingPolicies.length > 0) {
        overriddenByZone.set(zoneId, overridingPolicies)
      } else {
        effectiveZoneIds.push(zoneId)
      }
    }
    scopes.set(entry.policy.id, {
      ...entry,
      effectiveZoneIds,
      overriddenByZone,
      overriddenZoneIds: [...overriddenByZone.keys()],
    })
  }
  return scopes
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

function jsonValueStructurallyMatches(expected, observed) {
  if (Array.isArray(expected)) {
    return Array.isArray(observed)
      && expected.length === observed.length
      && expected.every((entry, index) => (
        jsonValueStructurallyMatches(entry, observed[index])
      ))
  }
  if (isObject(expected)) {
    if (!isObject(observed)) return false
    return Object.entries(expected).every(([key, entry]) => (
      Object.prototype.hasOwnProperty.call(observed, key)
        && jsonValueStructurallyMatches(entry, observed[key])
    ))
  }
  return expected === observed
}

function exactExpectedMatches(expected, observedValue) {
  if (!fleetIntentExpectedIsAuthored(expected)) {
    return observedValue.observedCanonical === expected.canonical
  }
  try {
    return jsonValueStructurallyMatches(
      expected.value,
      JSON.parse(observedValue.observedCanonical),
    )
  } catch {
    return false
  }
}

function authoredValuesCompatible(left, right) {
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((entry, index) => (
        authoredValuesCompatible(entry, right[index])
      ))
  }
  if (isObject(left) || isObject(right)) {
    if (!isObject(left) || !isObject(right)) return false
    const sharedKeys = Object.keys(left).filter(
      (key) => Object.prototype.hasOwnProperty.call(right, key),
    )
    return sharedKeys.every(
      (key) => authoredValuesCompatible(left[key], right[key]),
    )
  }
  return left === right
}

function exactExpectationsCompatible(left, right) {
  const leftAuthored = fleetIntentExpectedIsAuthored(left)
  const rightAuthored = fleetIntentExpectedIsAuthored(right)
  if (!leftAuthored && !rightAuthored) return left.canonical === right.canonical
  if (leftAuthored && rightAuthored) {
    return authoredValuesCompatible(left.value, right.value)
  }
  const authored = leftAuthored ? left : right
  const observed = leftAuthored ? right : left
  return exactExpectedMatches(authored, {
    observedCanonical: observed.canonical,
  })
}

function basePolicyCellStatus(
  presenceConstraint,
  valueConstraint,
  expected,
  observation,
  duplicateCount,
) {
  if (observation.observedCanonical === FLEET_INTENT_MISSING_CANONICAL) {
    return presenceConstraint === FLEET_INTENT_PRESENCE_CONSTRAINT.REQUIRED
      ? FLEET_INTENT_CELL_STATUS.MISSING
      : FLEET_INTENT_CELL_STATUS.MATCH
  }
  if (presenceConstraint === FLEET_INTENT_PRESENCE_CONSTRAINT.FORBIDDEN) {
    return FLEET_INTENT_CELL_STATUS.VARIANT
  }
  if (valueConstraint === FLEET_INTENT_VALUE_CONSTRAINT.MAY_DIFFER) {
    return FLEET_INTENT_CELL_STATUS.MATCH
  }
  if (valueConstraint === FLEET_INTENT_VALUE_CONSTRAINT.MUST_DIFFER) {
    return duplicateCount > 1
      ? FLEET_INTENT_CELL_STATUS.VARIANT
      : FLEET_INTENT_CELL_STATUS.MATCH
  }
  return exactExpectedMatches(expected, observation)
    ? FLEET_INTENT_CELL_STATUS.MATCH
    : FLEET_INTENT_CELL_STATUS.VARIANT
}

function policyEvaluation(
  policy,
  row,
  inventory,
  acknowledgements,
  scope,
) {
  const zoneById = new Map(inventory.zones.map((zone) => [zone.meta.id, zone]))
  const presenceConstraint = fleetIntentPolicyPresenceConstraint(policy)
  const valueConstraint = fleetIntentPolicyValueConstraint(policy)
  const observations = scope.effectiveZoneIds
    .map((zoneId) => zoneById.get(zoneId))
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
      presenceConstraint,
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
  const unresolvedReasons = [
    !row ? "Its facet is not present in the loaded matrix" : "",
    scope.unavailableZoneIds.length > 0
      ? "Its group contains zones outside the loaded inventory"
      : "",
  ].filter(Boolean)
  return {
    acknowledgementCount: statuses.filter(
      (status) => status === FLEET_INTENT_CELL_STATUS.ACKNOWLEDGED,
    ).length,
    actionableCount: statuses.filter(
      (status) => status === FLEET_INTENT_CELL_STATUS.MISSING
        || status === FLEET_INTENT_CELL_STATUS.VARIANT,
    ).length,
    cells,
    effectiveCount: cells.size,
    loadedTargetZoneIds: scope.loadedTargetZoneIds,
    matchCount: statuses.filter(
      (status) => status === FLEET_INTENT_CELL_STATUS.MATCH,
    ).length,
    overriddenByZone: scope.overriddenByZone,
    overriddenCount: scope.overriddenZoneIds.length,
    overriddenZoneIds: scope.overriddenZoneIds,
    policy,
    reason: unresolvedReasons.join("; "),
    targetCount: scope.loadedTargetZoneIds.length,
    targetedZoneIds: scope.targetedZoneIds,
    unavailableZoneIds: scope.unavailableZoneIds,
    unresolved: unresolvedReasons.length > 0,
  }
}

function applicablePolicyConflictKinds(policyStates) {
  const presenceConstraints = new Set(policyStates.map(
    (policyState) => fleetIntentPolicyPresenceConstraint(policyState.policy),
  ))
  const conflicts = []
  if (presenceConstraints.has(FLEET_INTENT_PRESENCE_CONSTRAINT.REQUIRED)
    && presenceConstraints.has(FLEET_INTENT_PRESENCE_CONSTRAINT.FORBIDDEN)) {
    conflicts.push(FLEET_INTENT_POLICY_CONFLICT_KIND.PRESENCE)
  }
  if (presenceConstraints.has(FLEET_INTENT_PRESENCE_CONSTRAINT.FORBIDDEN)) {
    return conflicts
  }
  const exactExpectations = policyStates
    .filter((policyState) => fleetIntentPolicyValueConstraint(policyState.policy)
      === FLEET_INTENT_VALUE_CONSTRAINT.EXACT)
    .map((policyState) => policyState.policy.expected)
  const exactConflict = exactExpectations.some((expected, index) => (
    exactExpectations.slice(index + 1).some(
      (candidate) => !exactExpectationsCompatible(expected, candidate),
    )
  ))
  if (exactConflict) {
    conflicts.push(FLEET_INTENT_POLICY_CONFLICT_KIND.EXACT_VALUE)
  }
  return conflicts
}

function composedCellStatus(policyCells, priority) {
  return policyCells.reduce((selected, cell) => (
    priority[cell.status] > priority[selected]
      ? cell.status
      : selected
  ), FLEET_INTENT_CELL_STATUS.MATCH)
}

function composedPolicyCell(policyStates, zone) {
  const policyCells = policyStates.map(
    (policyState) => policyState.cells.get(zone.meta.id),
  )
  const conflictKinds = applicablePolicyConflictKinds(policyStates)
  if (conflictKinds.length > 0) {
    return {
      acknowledgement: null,
      conflictKinds,
      observedCanonical: policyCells[0].observedCanonical,
      policies: policyStates.map((policyState) => policyState.policy),
      policyCells,
      status: FLEET_INTENT_CELL_STATUS.CONFLICT,
      zone,
    }
  }
  const status = composedCellStatus(policyCells, COMPOSED_CELL_STATUS_PRIORITY)
  const statusWithoutAcknowledgement = composedCellStatus(
    policyCells.map((cell) => ({ status: cell.statusWithoutAcknowledgement })),
    COMPOSED_CELL_UNACKNOWLEDGED_STATUS_PRIORITY,
  )
  const representative = [...policyCells].sort((left, right) => (
    COMPOSED_CELL_STATUS_PRIORITY[right.status]
      - COMPOSED_CELL_STATUS_PRIORITY[left.status]
      || left.policy.id.localeCompare(right.policy.id)
  ))[0]
  return {
    ...representative,
    acknowledgement: status === FLEET_INTENT_CELL_STATUS.ACKNOWLEDGED
      ? representative.acknowledgement
      : null,
    acknowledgements: policyCells
      .map((cell) => cell.acknowledgement)
      .filter(Boolean),
    conflictKinds: [],
    duplicateZoneNames: [...new Set(policyCells.flatMap(
      (cell) => cell.duplicateZoneNames,
    ))].sort((left, right) => left.localeCompare(right)),
    policies: policyStates.map((policyState) => policyState.policy),
    policyCells,
    status,
    statusWithoutAcknowledgement,
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
  else if (!policyState.targetedZoneIds.includes(zone.meta.id)) {
    reason = "Its zone is no longer targeted by the policy"
  }
  else if (policyState.overriddenByZone.has(zone.meta.id)) {
    reason = "A narrower group policy overrides this policy on the zone"
  }
  else if (!policyState.cells.has(zone.meta.id)) {
    reason = "Its policy is not effective on the zone"
  }
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
  const policyScopes = effectivePolicyScopes(document, inventory, groupsById)
  const policyStates = document.policies.map((policy) => {
    const row = rowsByFacet.get(fleetIntentPolicyFacetId(policy)) || null
    return policyEvaluation(
      policy,
      row,
      inventory,
      document.acknowledgements,
      policyScopes.get(policy.id),
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
      cells.set(zone.meta.id, composedPolicyCell(targeting, zone))
    }
    const actionableCells = [...cells.values()].filter(
      (cell) => cell.status === FLEET_INTENT_CELL_STATUS.CONFLICT
        || cell.status === FLEET_INTENT_CELL_STATUS.MISSING
        || cell.status === FLEET_INTENT_CELL_STATUS.VARIANT,
    )
    const applicableCells = [...cells.values()].filter(
      (cell) => cell.status !== FLEET_INTENT_CELL_STATUS.OUT_OF_SCOPE
        && cell.status !== FLEET_INTENT_CELL_STATUS.UNGOVERNED,
    )
    const acknowledgedCount = applicableCells.filter(
      (cell) => cell.status === FLEET_INTENT_CELL_STATUS.ACKNOWLEDGED,
    ).length
    const matchCount = applicableCells.filter(
      (cell) => cell.status === FLEET_INTENT_CELL_STATUS.MATCH,
    ).length
    const unresolved = matchingPolicies.some(
      (policyState) => policyState.unresolved,
    )
    const status = matchingPolicies.length === 0
      ? FLEET_INTENT_ROW_STATUS.UNGOVERNED
      : actionableCells.length > 0
        ? FLEET_INTENT_ROW_STATUS.DRIFT
        : unresolved
          ? FLEET_INTENT_ROW_STATUS.REVIEW
          : FLEET_INTENT_ROW_STATUS.MATCH
    rowStates.set(facetId, {
      actionable: matchingPolicies.length > 0
        ? actionableCells.length > 0
        : row.different,
      actionableCells,
      acknowledgedCount,
      applicableCount: applicableCells.length,
      cells,
      governed: matchingPolicies.length > 0,
      matchCount,
      policies: matchingPolicies.map((policyState) => policyState.policy),
      row,
      satisfiedCount: matchCount + acknowledgedCount,
      status,
      unresolved,
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
  const actionableZoneIds = new Set(
    actionableCells.map((cell) => cell.zone.meta.id),
  )
  const actionableRows = [...rowStates.values()].filter(
    (rowState) => rowState.actionable,
  )
  const driftRows = actionableRows.filter(
    (rowState) => rowState.governed,
  )
  const ungovernedRows = actionableRows.filter(
    (rowState) => !rowState.governed,
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
      actionableRows: actionableRows.length,
      actionableZones: actionableZoneIds.size,
      driftRows: driftRows.length,
      governedRows: [...rowStates.values()].filter((rowState) => rowState.governed).length,
      matchingZones: inventory.zones.length - actionableZoneIds.size,
      policies: policyStates.length,
      staleAcknowledgements: staleAcknowledgements.length,
      ungovernedRows: ungovernedRows.length,
      unresolvedPolicies: policyStates.filter((policyState) => policyState.unresolved).length,
      zones: inventory.zones.length,
    },
  }
}
