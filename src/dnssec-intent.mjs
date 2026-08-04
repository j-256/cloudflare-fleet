import { DNSSEC_STATUS } from "./constants.mjs"
import {
  dnssecRequestedStatus,
  dnssecStatusRequestSatisfied,
} from "./dnssec.mjs"
import {
  FLEET_INTENT_CELL_STATUS,
  FLEET_INTENT_VALUE_CONSTRAINT,
  fleetIntentPolicyValueConstraint,
} from "./fleet-intent.mjs"

const DNSSEC_CATEGORY = "DNSSEC"
const DNSSEC_CONFIGURATION_KEY = "configuration"
const WRITABLE_DNSSEC_STATUS = new Set([
  DNSSEC_STATUS.ACTIVE,
  DNSSEC_STATUS.DISABLED,
])
const DNSSEC_PENDING_STATUS = new Set([
  DNSSEC_STATUS.PENDING,
  DNSSEC_STATUS.PENDING_DISABLED,
])

export function dnssecDesiredStatus(expected) {
  const status = expected?.value?.status
  return WRITABLE_DNSSEC_STATUS.has(status) ? status : null
}

export function rowSupportsDnssecIntentCorrection(row) {
  return row?.category === DNSSEC_CATEGORY
    && row.key === DNSSEC_CONFIGURATION_KEY
}

function cellMatchesPolicy(cell, policyId) {
  if (!policyId) return true
  if (cell.policy?.id === policyId) return true
  return cell.policies?.some((policy) => policy.id === policyId) || false
}

function correctableIntentCell(cell) {
  return cell.status === FLEET_INTENT_CELL_STATUS.MISSING
    || cell.status === FLEET_INTENT_CELL_STATUS.VARIANT
}

export function dnssecIntentCorrection(row, options = {}) {
  if (!rowSupportsDnssecIntentCorrection(row)) {
    return {
      available: false,
      conflicts: [],
      generatedOnly: [],
      reason: "This facet is not backed by the DNSSEC status adapter",
      targets: [],
      waiting: [],
    }
  }

  const conflicts = []
  const generatedOnly = []
  const targets = []
  const waiting = []
  for (const cell of row.intentState?.cells.values() || []) {
    if (!cellMatchesPolicy(cell, options.policyId)) continue
    if (cell.status === FLEET_INTENT_CELL_STATUS.CONFLICT) {
      conflicts.push(cell.zone.meta.name)
      continue
    }
    if (fleetIntentPolicyValueConstraint(cell.policy)
      !== FLEET_INTENT_VALUE_CONSTRAINT.EXACT) continue
    const desiredStatus = dnssecDesiredStatus(cell.policy.expected)
    if (!desiredStatus) continue
    const observed = row.cells.get(cell.zone.meta.name)?.inspectionValue || null
    const currentStatus = observed?.status || null
    if (DNSSEC_PENDING_STATUS.has(currentStatus)
      && dnssecStatusRequestSatisfied(currentStatus, desiredStatus)) {
      waiting.push(cell.zone.meta.name)
      continue
    }
    if (!correctableIntentCell(cell)) continue
    if (dnssecStatusRequestSatisfied(currentStatus, desiredStatus)) {
      generatedOnly.push(cell.zone.meta.name)
      continue
    }
    if (currentStatus && !dnssecRequestedStatus(currentStatus)) {
      generatedOnly.push(cell.zone.meta.name)
      continue
    }
    targets.push({
      desiredStatus,
      policyId: cell.policy.id,
      zoneId: cell.zone.meta.id,
      zoneName: cell.zone.meta.name,
    })
  }

  targets.sort((left, right) => left.zoneName.localeCompare(right.zoneName))
  conflicts.sort()
  generatedOnly.sort()
  waiting.sort()
  const reason = targets.length > 0
    ? "DNSSEC status drift can be corrected through the zone DNSSEC endpoint"
    : waiting.length > 0
      ? "Cloudflare is already processing the requested DNSSEC status"
      : generatedOnly.length > 0
        ? "Only Cloudflare-generated DNSSEC fields differ"
        : conflicts.length > 0
          ? "Overlapping fleet intent policies must be resolved first"
          : "No correctable DNSSEC status drift is present"
  return {
    available: targets.length > 0,
    conflicts,
    generatedOnly,
    reason,
    targets,
    waiting,
  }
}
