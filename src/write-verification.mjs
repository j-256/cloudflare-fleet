import { DNSSEC_STATUS, HTTP_METHOD, RULESET_KIND } from "./constants.mjs"
import { dnssecStatusRequestSatisfied } from "./dnssec.mjs"

export const WRITE_VERIFICATION_KIND = Object.freeze({
  DNS_RECORD: "dns-record",
  EMAIL_RULE: "email-rule",
  RULESET: "ruleset",
  RULESET_DELETION: "ruleset-deletion",
  RULESET_PHASE: "ruleset-phase",
  SETTING: "setting",
  SURFACE: "surface",
})

export const WRITE_VERIFICATION_SURFACE = Object.freeze({
  DNS: "dns",
  DNSSEC: "dnssec",
  EMAIL: "email",
  EMAIL_DNS: "email-dns",
})

const DNSSEC_WRITABLE_STATUS_SET = new Set([
  DNSSEC_STATUS.ACTIVE,
  DNSSEC_STATUS.DISABLED,
])

function requiredString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label} is required`)
  }
  return value
}

function operationSegments(operation) {
  const path = requiredString(operation?.path, "Write operation path")
  return path
    .split("?", 1)[0]
    .split("/")
    .filter(Boolean)
    .map((segment) => decodeURIComponent(segment))
}

function surfaceTarget(zoneId, surfaceId) {
  return {
    kind: WRITE_VERIFICATION_KIND.SURFACE,
    surfaceId,
    zoneId,
  }
}

function emailDnsTargets(zoneId) {
  return [
    surfaceTarget(zoneId, WRITE_VERIFICATION_SURFACE.DNS),
    surfaceTarget(zoneId, WRITE_VERIFICATION_SURFACE.EMAIL),
    surfaceTarget(zoneId, WRITE_VERIFICATION_SURFACE.EMAIL_DNS),
  ]
}

export function verificationTargetsForOperation(operation) {
  const segments = operationSegments(operation)
  if (segments[0] !== "zones" || !segments[1]) {
    throw new Error(`Unsupported write verification path: ${operation.path}`)
  }
  const zoneId = segments[1]

  if (segments[2] === "dnssec" && segments.length === 3
    && operation.method === HTTP_METHOD.PATCH) {
    const expectedStatus = operation.body?.status
    if (!DNSSEC_WRITABLE_STATUS_SET.has(expectedStatus)) {
      throw new TypeError("DNSSEC verification requires an active or disabled request status")
    }
    return [{
      ...surfaceTarget(zoneId, WRITE_VERIFICATION_SURFACE.DNSSEC),
      expectedStatus,
    }]
  }

  if (segments[2] === "settings" && segments.length === 4) {
    return [{
      kind: WRITE_VERIFICATION_KIND.SETTING,
      settingId: segments[3],
      zoneId,
    }]
  }

  if (segments[2] === "dns_records") {
    if (segments.length === 4 && operation.method !== HTTP_METHOD.DELETE) {
      return [{
        kind: WRITE_VERIFICATION_KIND.DNS_RECORD,
        recordId: segments[3],
        zoneId,
      }]
    }
    if (segments.length === 4 && operation.method === HTTP_METHOD.DELETE) {
      return [surfaceTarget(zoneId, WRITE_VERIFICATION_SURFACE.DNS)]
    }
    if (segments.length === 3) {
      return [surfaceTarget(zoneId, WRITE_VERIFICATION_SURFACE.DNS)]
    }
  }

  if (segments[2] === "email" && segments[3] === "routing") {
    if (segments.length === 4) {
      return [surfaceTarget(zoneId, WRITE_VERIFICATION_SURFACE.EMAIL)]
    }
    if (segments[4] === "dns" && segments.length === 5) {
      return emailDnsTargets(zoneId)
    }
    if (segments[4] === "rules" && segments[5] && segments.length === 6) {
      return [{
        kind: WRITE_VERIFICATION_KIND.EMAIL_RULE,
        ruleIdentifier: segments[5],
        zoneId,
      }]
    }
  }

  if (segments[2] === "rulesets") {
    if (segments.length === 3 && operation.method === HTTP_METHOD.POST) {
      return [{
        kind: WRITE_VERIFICATION_KIND.RULESET_PHASE,
        kinds: [operation.body?.kind || RULESET_KIND.ZONE],
        phase: requiredString(
          operation.body?.phase,
          "Created ruleset phase",
        ),
        zoneId,
      }]
    }
    if (segments[3]) {
      if (segments.length === 4 && operation.method === HTTP_METHOD.DELETE) {
        return [{
          kind: WRITE_VERIFICATION_KIND.RULESET_DELETION,
          rulesetId: segments[3],
          zoneId,
        }]
      }
      return [{
        kind: WRITE_VERIFICATION_KIND.RULESET,
        rulesetId: segments[3],
        zoneId,
      }]
    }
  }

  throw new Error(`Unsupported write verification path: ${operation.path}`)
}

export function assertWriteVerificationResponse(target, response) {
  if (target?.kind !== WRITE_VERIFICATION_KIND.SURFACE
    || target.surfaceId !== WRITE_VERIFICATION_SURFACE.DNSSEC) return
  const actualStatus = response?.result?.status
  if (!dnssecStatusRequestSatisfied(actualStatus, target.expectedStatus)) {
    throw new Error(`DNSSEC verification returned ${actualStatus || "unknown"} instead of requested ${target.expectedStatus}`)
  }
}

function verificationTargetKey(target) {
  if (target.kind === WRITE_VERIFICATION_KIND.SURFACE) {
    return `${target.zoneId}:${target.kind}:${target.surfaceId}`
  }
  if (target.kind === WRITE_VERIFICATION_KIND.SETTING) {
    return `${target.zoneId}:${target.kind}:${target.settingId}`
  }
  if (target.kind === WRITE_VERIFICATION_KIND.DNS_RECORD) {
    return `${target.zoneId}:${target.kind}:${target.recordId}`
  }
  if (target.kind === WRITE_VERIFICATION_KIND.EMAIL_RULE) {
    return `${target.zoneId}:${target.kind}:${target.ruleIdentifier}`
  }
  if (target.kind === WRITE_VERIFICATION_KIND.RULESET_PHASE) {
    return `${target.zoneId}:${target.kind}:${target.phase}:${target.kinds.slice().sort().join(",")}`
  }
  return `${target.zoneId}:${target.kind}:${target.rulesetId}`
}

function deduplicateVerificationTargets(targets) {
  const unique = new Map()
  for (const target of targets) {
    unique.set(verificationTargetKey(target), target)
  }
  for (const target of [...unique.values()]) {
    if (target.kind !== WRITE_VERIFICATION_KIND.DNS_RECORD) continue
    const surfaceKey = verificationTargetKey(
      surfaceTarget(target.zoneId, WRITE_VERIFICATION_SURFACE.DNS),
    )
    if (unique.has(surfaceKey)) unique.delete(verificationTargetKey(target))
  }
  return [...unique.values()]
}

export function verificationTargetsForPlans(plans) {
  if (!Array.isArray(plans)) throw new TypeError("Write plans must be an array")
  const targets = []
  for (const plan of plans) {
    if (!Array.isArray(plan?.operations)) {
      throw new TypeError("Every write plan must contain operations")
    }
    for (const operation of plan.operations) {
      for (const target of verificationTargetsForOperation(operation)) {
        targets.push(target)
      }
    }
  }

  return deduplicateVerificationTargets(targets)
}

export function verificationTargetsForResults(results) {
  if (!Array.isArray(results)) throw new TypeError("Write results must be an array")
  const targets = []
  for (const result of results) {
    const operation = result?.operation
    const segments = operationSegments(operation)
    if (segments[2] === "dns_records"
      && segments.length === 3
      && operation.method === HTTP_METHOD.POST
      && result.response?.result?.id) {
      targets.push({
        kind: WRITE_VERIFICATION_KIND.DNS_RECORD,
        recordId: result.response.result.id,
        zoneId: segments[1],
      })
      continue
    }
    if (segments[2] === "rulesets"
      && segments.length === 3
      && operation.method === HTTP_METHOD.POST
      && result.response?.result?.id) {
      targets.push({
        kind: WRITE_VERIFICATION_KIND.RULESET,
        rulesetId: result.response.result.id,
        zoneId: segments[1],
      })
      continue
    }
    targets.push(...verificationTargetsForOperation(operation))
  }
  return deduplicateVerificationTargets(targets)
}
