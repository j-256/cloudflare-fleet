import {
  DNSSEC_STATUS,
  HTTP_METHOD,
} from "./constants.mjs"
import { dnssecRequestedStatus } from "./dnssec.mjs"
import {
  stableString,
} from "./normalize.mjs"
import {
  editableDnsRecordPayload,
  editableEmailRoutingRulePayload,
  editableRulePayload,
} from "./policies.mjs"
import {
  WRITE_VERIFICATION_KIND,
  WRITE_VERIFICATION_SURFACE,
} from "./write-verification.mjs"

export const OPERATION_ACTIVITY_SCHEMA_VERSION = 1
export const OPERATION_ACTIVITY_EMPTY_REVISION = ""

export const OPERATION_ACTIVITY_STATUS = Object.freeze({
  PENDING: "pending",
  VERIFICATION_FAILED: "verification-failed",
  VERIFIED: "verified",
  WRITE_FAILED: "write-failed",
})

const ACTIVITY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const REVISION_PATTERN = /^[a-f0-9]{64}$/
const TITLE_MAX_LENGTH = 300
const WRITE_METHODS = new Set([
  HTTP_METHOD.DELETE,
  HTTP_METHOD.PATCH,
  HTTP_METHOD.POST,
  HTTP_METHOD.PUT,
])
const DNSSEC_WRITABLE_STATUS_SET = new Set([
  DNSSEC_STATUS.ACTIVE,
  DNSSEC_STATUS.DISABLED,
])

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function isTimestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value))
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

function isActivityId(value) {
  return typeof value === "string" && ACTIVITY_ID_PATTERN.test(value)
}

function isTitle(value) {
  return typeof value === "string"
    && value.trim().length > 0
    && value.length <= TITLE_MAX_LENGTH
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0
}

function isWriteOperation(operation) {
  return isObject(operation)
    && isNonEmptyString(operation.label)
    && WRITE_METHODS.has(operation.method)
    && isNonEmptyString(operation.path)
    && (!Object.hasOwn(operation, "body") || isJsonValue(operation.body))
    && (!Object.hasOwn(operation, "currentValue")
      || isJsonValue(operation.currentValue))
    && isJsonValue(operation)
}

function isOperationPlan(plan) {
  return isObject(plan)
    && isNonEmptyString(plan.id)
    && isNonEmptyString(plan.kind)
    && isNonEmptyString(plan.summary)
    && isNonEmptyString(plan.zoneId)
    && isNonEmptyString(plan.zoneName)
    && Array.isArray(plan.operations)
    && plan.operations.length > 0
    && plan.operations.every(isWriteOperation)
    && isJsonValue(plan)
}

function isVerificationTarget(target) {
  if (!isObject(target) || !isNonEmptyString(target.zoneId)) return false
  if (target.kind === WRITE_VERIFICATION_KIND.SETTING) {
    return isNonEmptyString(target.settingId)
  }
  if (target.kind === WRITE_VERIFICATION_KIND.DNS_RECORD) {
    return isNonEmptyString(target.recordId)
  }
  if (target.kind === WRITE_VERIFICATION_KIND.EMAIL_RULE) {
    return isNonEmptyString(target.ruleIdentifier)
  }
  if ([
    WRITE_VERIFICATION_KIND.RULESET,
    WRITE_VERIFICATION_KIND.RULESET_DELETION,
  ].includes(target.kind)) {
    return isNonEmptyString(target.rulesetId)
  }
  if (target.kind === WRITE_VERIFICATION_KIND.RULESET_PHASE) {
    return isNonEmptyString(target.phase)
      && Array.isArray(target.kinds)
      && target.kinds.length > 0
      && target.kinds.every(isNonEmptyString)
  }
  if (target.kind === WRITE_VERIFICATION_KIND.SURFACE) {
    if (!Object.values(WRITE_VERIFICATION_SURFACE).includes(target.surfaceId)) return false
    return target.surfaceId !== WRITE_VERIFICATION_SURFACE.DNSSEC
      || DNSSEC_WRITABLE_STATUS_SET.has(target.expectedStatus)
  }
  return false
}

function isVerificationGuard(guard) {
  return isObject(guard)
    && isNonEmptyString(guard.canonical)
    && isNonEmptyString(guard.summary)
    && isVerificationTarget(guard.target)
    && Object.hasOwn(guard, "value")
    && isJsonValue(guard.value)
    && guard.canonical === stableString(guard.value)
}

function operationCount(plans) {
  return plans.reduce((count, plan) => count + plan.operations.length, 0)
}

function isExecution(execution, plans) {
  const total = operationCount(plans)
  return isObject(execution)
    && Number.isInteger(execution.completed)
    && execution.completed >= 0
    && Number.isInteger(execution.total)
    && execution.total === total
    && execution.completed <= execution.total
}

function isInverse(inverse) {
  return isObject(inverse)
    && typeof inverse.available === "boolean"
    && Array.isArray(inverse.plans)
    && inverse.plans.every(isOperationPlan)
    && isNonEmptyString(inverse.reason)
    && (inverse.available
      ? inverse.plans.length > 0
      : inverse.plans.length === 0)
}

function jsonClone(value) {
  return JSON.parse(JSON.stringify(value))
}

export function createEmptyOperationActivityDocument() {
  return {
    entries: [],
    revision: OPERATION_ACTIVITY_EMPTY_REVISION,
    updatedAt: null,
  }
}

export function isOperationActivityEntry(entry) {
  if (!isObject(entry)
    || entry.schemaVersion !== OPERATION_ACTIVITY_SCHEMA_VERSION
    || !isActivityId(entry.id)
    || !isTitle(entry.title)
    || !Object.values(OPERATION_ACTIVITY_STATUS).includes(entry.status)
    || !isTimestamp(entry.startedAt)
    || !isTimestamp(entry.validatedAt)
    || (entry.undoOf !== null && !isActivityId(entry.undoOf))
    || !Array.isArray(entry.plans)
    || entry.plans.length === 0
    || !entry.plans.every(isOperationPlan)
    || !Array.isArray(entry.verification)
    || !entry.verification.every(isVerificationGuard)
    || (entry.inverse !== null && !isInverse(entry.inverse))
    || (entry.execution !== null && !isExecution(entry.execution, entry.plans))
    || (entry.error !== null && typeof entry.error !== "string")) return false

  if (entry.status === OPERATION_ACTIVITY_STATUS.PENDING) {
    return entry.completedAt === null
      && entry.error === null
      && entry.execution === null
      && entry.inverse === null
      && entry.verification.length === 0
  }
  if (!isTimestamp(entry.completedAt)
    || !isExecution(entry.execution, entry.plans)
    || !isInverse(entry.inverse)) return false
  if (entry.status === OPERATION_ACTIVITY_STATUS.VERIFIED) {
    return entry.error === null
      && entry.execution.completed === entry.execution.total
      && (!entry.inverse.available || entry.verification.length > 0)
  }
  if (entry.inverse.available || !isNonEmptyString(entry.error)) return false
  return entry.status !== OPERATION_ACTIVITY_STATUS.VERIFICATION_FAILED
    || entry.execution.completed === entry.execution.total
}

export function isOperationActivityDocument(document) {
  if (!isObject(document)) return false
  if (!Array.isArray(document.entries)
    || !document.entries.every(isOperationActivityEntry)) return false
  const ids = new Set(document.entries.map((entry) => entry.id))
  if (ids.size !== document.entries.length) return false
  const byId = new Map(document.entries.map((entry) => [entry.id, entry]))
  const activeUndoParents = new Set()
  for (const entry of document.entries) {
    if (entry.undoOf === null) continue
    const parent = byId.get(entry.undoOf)
    if (entry.undoOf === entry.id
      || parent?.status !== OPERATION_ACTIVITY_STATUS.VERIFIED
      || parent.inverse?.available !== true) return false
    if ([
      OPERATION_ACTIVITY_STATUS.PENDING,
      OPERATION_ACTIVITY_STATUS.VERIFIED,
    ].includes(entry.status)) {
      if (activeUndoParents.has(entry.undoOf)) return false
      activeUndoParents.add(entry.undoOf)
    }
  }
  return (document.revision === OPERATION_ACTIVITY_EMPTY_REVISION
      || (typeof document.revision === "string"
        && REVISION_PATTERN.test(document.revision)))
    && (document.updatedAt === null || isTimestamp(document.updatedAt))
}

export function createPendingOperationActivity(title, planSet, options = {}) {
  if (!isTitle(title)) throw new TypeError("Operation activity requires a title")
  if (!planSet || !Array.isArray(planSet.plans) || !isTimestamp(planSet.validatedAt)) {
    throw new TypeError("Operation activity requires a live-validated plan set")
  }
  const id = options.id || `activity-${globalThis.crypto.randomUUID()}`
  const startedAt = options.startedAt || new Date().toISOString()
  const plans = planSet.plans
    .filter((plan) => Array.isArray(plan.operations) && plan.operations.length > 0)
  const entry = {
    completedAt: null,
    error: null,
    execution: null,
    id,
    inverse: null,
    plans: jsonClone(plans),
    schemaVersion: OPERATION_ACTIVITY_SCHEMA_VERSION,
    startedAt,
    status: OPERATION_ACTIVITY_STATUS.PENDING,
    title: title.trim(),
    undoOf: options.undoOf || null,
    validatedAt: planSet.validatedAt,
    verification: [],
  }
  if (!isOperationActivityEntry(entry)) {
    throw new TypeError("Operation activity could not be serialized")
  }
  return entry
}

export function completeOperationActivity(entry, result) {
  if (!isOperationActivityEntry(entry)
    || entry.status !== OPERATION_ACTIVITY_STATUS.PENDING) {
    throw new TypeError("Only a pending operation activity can be completed")
  }
  const completed = {
    ...jsonClone(entry),
    completedAt: result.completedAt || new Date().toISOString(),
    error: result.error || null,
    execution: jsonClone(result.execution),
    inverse: jsonClone(result.inverse),
    status: result.status,
    verification: jsonClone(result.verification || []),
  }
  if (!isOperationActivityEntry(completed)
    || completed.status === OPERATION_ACTIVITY_STATUS.PENDING) {
    throw new TypeError("Completed operation activity is invalid")
  }
  return completed
}

function operationSegments(operation) {
  return String(operation?.path || "")
    .split("?", 1)[0]
    .split("/")
    .filter(Boolean)
    .map((segment) => decodeURIComponent(segment))
}

function targetKey(target) {
  return stableString(target)
}

function dnsRecordSnapshot(record) {
  return {
    id: record?.id || null,
    ...editableDnsRecordPayload(record),
  }
}

function emailRuleSnapshot(rule, catchAll) {
  return {
    id: rule?.id || null,
    ...editableEmailRoutingRulePayload(rule, { catchAll }),
  }
}

function rulesetSnapshot(ruleset) {
  return {
    description: ruleset?.description || "",
    id: ruleset?.id || null,
    kind: ruleset?.kind || null,
    name: ruleset?.name || null,
    phase: ruleset?.phase || null,
    rules: (ruleset?.rules || []).map((rule) => ({
      id: rule.id || null,
      ...editableRulePayload(rule),
    })),
  }
}

function sortedById(values) {
  return [...values].sort((left, right) => (
    String(left?.id || "").localeCompare(String(right?.id || ""))
  ))
}

function emailSettingsSnapshot(settings) {
  if (!isObject(settings)) return settings
  return Object.fromEntries([
    "enabled",
    "id",
    "name",
    "skip_wizard",
    "status",
    "support_subaddress",
  ].flatMap((key) => (
    settings[key] === undefined ? [] : [[key, settings[key]]]
  )))
}

function emailDnsSnapshot(value) {
  if (!isObject(value)) return value
  const snapshot = jsonClone(value)
  if (Array.isArray(snapshot.record)) {
    snapshot.record = [...snapshot.record].sort(
      (left, right) => stableString(left).localeCompare(stableString(right)),
    )
  }
  if (Array.isArray(snapshot.errors)) {
    snapshot.errors = [...snapshot.errors].sort(
      (left, right) => stableString(left).localeCompare(stableString(right)),
    )
  }
  return snapshot
}

export function verificationObservation(entry) {
  const { response, target } = entry
  let value
  let summary
  if (target.kind === WRITE_VERIFICATION_KIND.SETTING) {
    value = {
      settingId: target.settingId,
      value: response.result?.value,
    }
    summary = `Zone setting ${target.settingId}`
  } else if (target.kind === WRITE_VERIFICATION_KIND.DNS_RECORD) {
    value = dnsRecordSnapshot(response.result)
    summary = `${value.type || "DNS"} ${value.name || target.recordId}`
  } else if (target.kind === WRITE_VERIFICATION_KIND.EMAIL_RULE) {
    const catchAll = target.ruleIdentifier === "catch_all"
    value = emailRuleSnapshot(response.result, catchAll)
    summary = catchAll ? "Email Routing catch-all" : "Email Routing rule"
  } else if (target.kind === WRITE_VERIFICATION_KIND.RULESET) {
    value = rulesetSnapshot(response.result)
    summary = `${value.name || value.phase || "Ruleset"} ruleset`
  } else if (target.kind === WRITE_VERIFICATION_KIND.RULESET_DELETION) {
    value = {
      deleted: !(response.result || []).some(
        (ruleset) => ruleset.id === target.rulesetId,
      ),
      rulesetId: target.rulesetId,
    }
    summary = "Deleted ruleset"
  } else if (target.kind === WRITE_VERIFICATION_KIND.RULESET_PHASE) {
    const kinds = new Set(target.kinds)
    value = sortedById((response.result?.details || [])
      .filter((ruleset) => ruleset.phase === target.phase && kinds.has(ruleset.kind))
      .map(rulesetSnapshot))
    summary = `${target.phase} rulesets`
  } else if (target.kind === WRITE_VERIFICATION_KIND.SURFACE
    && target.surfaceId === WRITE_VERIFICATION_SURFACE.DNS) {
    value = sortedById((response.result || []).map(dnsRecordSnapshot))
    summary = "DNS records"
  } else if (target.kind === WRITE_VERIFICATION_KIND.SURFACE
    && target.surfaceId === WRITE_VERIFICATION_SURFACE.EMAIL) {
    value = emailSettingsSnapshot(response.result)
    summary = "Email Routing settings"
  } else if (target.kind === WRITE_VERIFICATION_KIND.SURFACE
    && target.surfaceId === WRITE_VERIFICATION_SURFACE.EMAIL_DNS) {
    value = emailDnsSnapshot(response.result)
    summary = "Email Routing DNS"
  } else if (target.kind === WRITE_VERIFICATION_KIND.SURFACE
    && target.surfaceId === WRITE_VERIFICATION_SURFACE.DNSSEC) {
    value = { status: dnssecRequestedStatus(response.result?.status) }
    summary = `DNSSEC ${value.status || "unknown"}`
  } else {
    value = jsonClone(response.result)
    summary = target.surfaceId || target.kind
  }
  return {
    canonical: stableString(value),
    summary,
    target: jsonClone(target),
    value,
  }
}

export function createVerificationGuards(entries) {
  return entries.map(verificationObservation)
}

export function compareVerificationGuards(expected, liveEntries) {
  const actual = createVerificationGuards(liveEntries)
  const actualByTarget = new Map(
    actual.map((guard) => [targetKey(guard.target), guard]),
  )
  const differences = []
  for (const guard of expected) {
    const current = actualByTarget.get(targetKey(guard.target))
    if (!current) {
      differences.push({
        actual: null,
        expected: guard,
        reason: "The recorded resource could not be reread",
      })
      continue
    }
    actualByTarget.delete(targetKey(guard.target))
    if (current.canonical !== guard.canonical) {
      differences.push({
        actual: current,
        expected: guard,
        reason: "The live resource changed after this operation",
      })
    }
  }
  for (const current of actualByTarget.values()) {
    differences.push({
      actual: current,
      expected: null,
      reason: "The verification target set changed",
    })
  }
  return {
    actual,
    differences,
    matches: differences.length === 0,
  }
}

function requiredCurrentValue(operation, label = operation.label) {
  if (!Object.hasOwn(operation, "currentValue")) {
    throw new Error(`${label} did not preserve its prior state`)
  }
  return operation.currentValue
}

function appendPath(path, identifier) {
  return `${String(path).replace(/\/$/, "")}/${encodeURIComponent(identifier)}`
}

function collectionPath(operation, segmentCount) {
  const segments = operationSegments(operation).slice(0, segmentCount)
  return segments.map(encodeURIComponent).join("/")
}

function inverseOperation(operation, response, createdRuleIds) {
  const segments = operationSegments(operation)
  const undoLabel = `Undo: ${operation.label}`
  if (segments[0] !== "zones" || !segments[1]) {
    throw new Error(`${operation.label} uses an unsupported account-level path`)
  }

  if (segments[2] === "settings" && segments.length === 4) {
    return {
      body: { value: requiredCurrentValue(operation) },
      currentValue: operation.body?.value,
      label: undoLabel,
      method: HTTP_METHOD.PATCH,
      path: operation.path,
    }
  }

  if (segments[2] === "dnssec" && segments.length === 3
    && operation.method === HTTP_METHOD.PATCH) {
    throw new Error(`${operation.label} cannot be automatically undone because DNSSEC rollback depends on parent DS record timing`)
  }

  if (segments[2] === "dns_records") {
    if (segments.length === 3 && operation.method === HTTP_METHOD.POST) {
      const recordId = response?.result?.id
      if (!recordId) throw new Error(`${operation.label} returned no DNS record identifier`)
      return {
        currentValue: operation.body,
        label: undoLabel,
        method: HTTP_METHOD.DELETE,
        path: appendPath(operation.path, recordId),
      }
    }
    if (segments.length === 4
      && [HTTP_METHOD.PATCH, HTTP_METHOD.PUT].includes(operation.method)) {
      return {
        body: requiredCurrentValue(operation),
        currentValue: operation.body,
        label: undoLabel,
        method: operation.method,
        path: operation.path,
      }
    }
    if (segments.length === 4 && operation.method === HTTP_METHOD.DELETE) {
      return {
        body: requiredCurrentValue(operation),
        label: undoLabel,
        method: HTTP_METHOD.POST,
        path: collectionPath(operation, 3),
      }
    }
  }

  if (segments[2] === "email" && segments[3] === "routing") {
    if (segments.length === 4
      && [HTTP_METHOD.PATCH, HTTP_METHOD.PUT].includes(operation.method)) {
      return {
        body: requiredCurrentValue(operation),
        currentValue: operation.body,
        label: undoLabel,
        method: operation.method,
        path: operation.path,
      }
    }
    if (segments[4] === "rules" && segments.length === 6
      && [HTTP_METHOD.PATCH, HTTP_METHOD.PUT].includes(operation.method)) {
      return {
        body: requiredCurrentValue(operation),
        currentValue: operation.body,
        label: undoLabel,
        method: operation.method,
        path: operation.path,
      }
    }
    throw new Error(`${operation.label} changes coupled Email Routing DNS state without a lossless inverse`)
  }

  if (segments[2] === "rulesets") {
    if (segments.length === 3 && operation.method === HTTP_METHOD.POST) {
      const rulesetId = response?.result?.id
      if (!rulesetId) throw new Error(`${operation.label} returned no ruleset identifier`)
      return {
        currentValue: operation.body,
        label: undoLabel,
        method: HTTP_METHOD.DELETE,
        path: appendPath(operation.path, rulesetId),
      }
    }
    if (segments.length === 4 && operation.method === HTTP_METHOD.DELETE) {
      return {
        body: requiredCurrentValue(operation),
        label: undoLabel,
        method: HTTP_METHOD.POST,
        path: collectionPath(operation, 3),
      }
    }
    if (segments.length === 4
      && [HTTP_METHOD.PATCH, HTTP_METHOD.PUT].includes(operation.method)) {
      return {
        body: requiredCurrentValue(operation),
        currentValue: operation.body,
        label: undoLabel,
        method: operation.method,
        path: operation.path,
      }
    }
    if (segments[4] === "rules" && segments.length === 5
      && operation.method === HTTP_METHOD.POST) {
      const ruleId = createdRuleIds.get(operation)
      if (!ruleId) throw new Error(`${operation.label} returned no unambiguous rule identifier`)
      return {
        currentValue: operation.body,
        label: undoLabel,
        method: HTTP_METHOD.DELETE,
        path: appendPath(operation.path, ruleId),
      }
    }
    if (segments[4] === "rules" && segments.length === 6
      && operation.method === HTTP_METHOD.PATCH) {
      const current = requiredCurrentValue(operation)
      let body
      if (isObject(current.rule)) body = current.rule
      else if (Number.isInteger(current.position)) {
        body = { position: { index: current.position } }
      } else {
        body = current
      }
      return {
        body,
        currentValue: operation.body,
        label: undoLabel,
        method: HTTP_METHOD.PATCH,
        path: operation.path,
      }
    }
    if (segments[4] === "rules" && segments.length === 6
      && operation.method === HTTP_METHOD.DELETE) {
      const current = requiredCurrentValue(operation)
      if (!isObject(current.rule) || !Number.isInteger(current.position)) {
        throw new Error(`${operation.label} did not preserve its rule and position`)
      }
      return {
        body: {
          ...current.rule,
          position: { index: current.position },
        },
        label: undoLabel,
        method: HTTP_METHOD.POST,
        path: collectionPath(operation, 5),
      }
    }
  }

  throw new Error(`${operation.label} has no supported inverse adapter`)
}

function createdRuleIdsForResults(results) {
  const resolved = new Map()
  const claimedByRuleset = new Map()
  for (const result of results) {
    const { operation, response } = result
    const segments = operationSegments(operation)
    if (!(segments[2] === "rulesets"
      && segments[4] === "rules"
      && segments.length === 5
      && operation.method === HTTP_METHOD.POST)) continue
    const rulesetKey = segments.slice(0, 4).join("/")
    if (!claimedByRuleset.has(rulesetKey)) claimedByRuleset.set(rulesetKey, new Set())
    const claimed = claimedByRuleset.get(rulesetKey)
    const priorIds = new Set(operation.currentValue?.ruleIds || [])
    const candidates = (response?.result?.rules || []).filter(
      (rule) => rule.id && !priorIds.has(rule.id) && !claimed.has(rule.id),
    )
    let created = candidates.length === 1 ? candidates[0] : null
    if (!created) {
      const desired = {
        ...operation.body,
      }
      delete desired.position
      const matching = candidates.filter(
        (rule) => stableString(editableRulePayload(rule)) === stableString(desired),
      )
      if (matching.length === 1) created = matching[0]
    }
    if (created) {
      claimed.add(created.id)
      resolved.set(operation, created.id)
    }
  }
  return resolved
}

export function buildInversePlans(results) {
  if (!Array.isArray(results) || results.length === 0) {
    return {
      available: false,
      plans: [],
      reason: "No completed writes were available to reverse",
    }
  }
  const createdRuleIds = createdRuleIdsForResults(results)
  const inverseEntries = []
  try {
    for (const result of [...results].reverse()) {
      inverseEntries.push({
        operation: inverseOperation(
          result.operation,
          result.response,
          createdRuleIds,
        ),
        plan: result.plan,
      })
    }
  } catch (error) {
    return {
      available: false,
      plans: [],
      reason: error instanceof Error ? error.message : String(error),
    }
  }

  const plans = []
  const byPlan = new Map()
  for (const entry of inverseEntries) {
    if (!byPlan.has(entry.plan.id)) {
      const plan = {
        id: `undo:${entry.plan.id}`,
        kind: "operation-undo",
        operations: [],
        summary: `Undo ${entry.plan.summary}`,
        zoneId: entry.plan.zoneId,
        zoneName: entry.plan.zoneName,
      }
      byPlan.set(entry.plan.id, plan)
      plans.push(plan)
    }
    byPlan.get(entry.plan.id).operations.push(entry.operation)
  }
  return {
    available: true,
    plans,
    reason: "Live state must still match the recorded verified result",
  }
}
