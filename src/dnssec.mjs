import { DNSSEC_STATUS } from "./constants.mjs"

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
