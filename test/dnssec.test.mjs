import assert from "node:assert/strict"
import test from "node:test"

import {
  DNSSEC_PENDING_GRACE_MS,
  dnssecTransitionHealth,
  DNSSEC_TRANSITION_STATE,
} from "../src/dnssec.mjs"

const NOW = Date.parse("2026-08-09T18:00:00.000Z")

test("DNSSEC transition health separates complete, failed, and unknown states", () => {
  assert.equal(
    dnssecTransitionHealth({ status: "active" }, { now: NOW }).state,
    DNSSEC_TRANSITION_STATE.COMPLETE,
  )
  assert.equal(
    dnssecTransitionHealth({ status: "disabled" }, { now: NOW }).state,
    DNSSEC_TRANSITION_STATE.COMPLETE,
  )
  assert.equal(
    dnssecTransitionHealth({ status: "error" }, { now: NOW }).state,
    DNSSEC_TRANSITION_STATE.FAILED,
  )
  assert.equal(
    dnssecTransitionHealth({ status: "unexpected" }, { now: NOW }).state,
    DNSSEC_TRANSITION_STATE.UNKNOWN,
  )
})

test("DNSSEC pending transitions become stalled after the grace window", () => {
  const boundary = new Date(NOW - DNSSEC_PENDING_GRACE_MS).toISOString()
  const overdue = new Date(NOW - DNSSEC_PENDING_GRACE_MS - 1).toISOString()

  assert.equal(
    dnssecTransitionHealth({
      modified_on: boundary,
      status: "pending",
    }, { now: NOW }).state,
    DNSSEC_TRANSITION_STATE.PROPAGATING,
  )
  assert.equal(
    dnssecTransitionHealth({
      modified_on: overdue,
      status: "pending-disabled",
    }, { now: NOW }).state,
    DNSSEC_TRANSITION_STATE.STALLED,
  )
})

test("DNSSEC pending transitions without a usable timestamp remain propagating", () => {
  const health = dnssecTransitionHealth({
    modified_on: "not-a-date",
    status: "pending",
  }, { now: NOW })

  assert.equal(health.ageMs, null)
  assert.equal(health.modifiedAt, null)
  assert.equal(health.state, DNSSEC_TRANSITION_STATE.PROPAGATING)
})
