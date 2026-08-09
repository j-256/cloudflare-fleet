import { DNSSEC_STATUS } from "./constants.mjs"

export const DNSSEC_PENDING_GRACE_MS = 2 * 24 * 60 * 60 * 1000

export const DNSSEC_TRANSITION_STATE = Object.freeze({
  COMPLETE: "complete",
  FAILED: "failed",
  PROPAGATING: "propagating",
  STALLED: "stalled",
  UNKNOWN: "unknown",
})

export function dnssecRequestedStatus(status) {
  if (status === DNSSEC_STATUS.ACTIVE || status === DNSSEC_STATUS.PENDING) {
    return DNSSEC_STATUS.ACTIVE
  }
  if (status === DNSSEC_STATUS.DISABLED
    || status === DNSSEC_STATUS.PENDING_DISABLED) {
    return DNSSEC_STATUS.DISABLED
  }
  return null
}

export function dnssecStatusRequestSatisfied(status, desiredStatus) {
  return dnssecRequestedStatus(status) === desiredStatus
}

export function dnssecTransitionHealth(dnssec, options = {}) {
  const status = dnssec?.status ?? null
  const modifiedAt = typeof dnssec?.modified_on === "string"
    && Number.isFinite(Date.parse(dnssec.modified_on))
    ? dnssec.modified_on
    : null
  const now = options.now instanceof Date
    ? options.now.valueOf()
    : options.now ?? Date.now()
  const graceMs = options.graceMs ?? DNSSEC_PENDING_GRACE_MS
  const ageMs = modifiedAt === null || !Number.isFinite(now)
    ? null
    : Math.max(0, now - Date.parse(modifiedAt))

  if (status === DNSSEC_STATUS.ACTIVE || status === DNSSEC_STATUS.DISABLED) {
    return {
      ageMs,
      modifiedAt,
      state: DNSSEC_TRANSITION_STATE.COMPLETE,
      status,
    }
  }
  if (status === DNSSEC_STATUS.ERROR) {
    return {
      ageMs,
      modifiedAt,
      state: DNSSEC_TRANSITION_STATE.FAILED,
      status,
    }
  }
  if (status === DNSSEC_STATUS.PENDING
    || status === DNSSEC_STATUS.PENDING_DISABLED) {
    return {
      ageMs,
      modifiedAt,
      state: ageMs !== null && ageMs > graceMs
        ? DNSSEC_TRANSITION_STATE.STALLED
        : DNSSEC_TRANSITION_STATE.PROPAGATING,
      status,
    }
  }
  return {
    ageMs,
    modifiedAt,
    state: DNSSEC_TRANSITION_STATE.UNKNOWN,
    status,
  }
}
