import assert from "node:assert/strict"
import test from "node:test"

import {
  configureFleetPolicy,
  configuredEmailPolicyExceptions,
  createEmptyFleetPolicyConfiguration,
  emailPolicyExceptionsForZone,
  isFleetPolicyConfiguration,
  normalizeFleetPolicyConfiguration,
} from "../src/fleet-policy.mjs"

const POLICY = Object.freeze({
  emailDnsRecordExceptions: [
    {
      component: "spf",
      expected: {
        content: "v=spf1 include:_spf.example.net -all",
        ttl: 300,
      },
      reason: "Approved sender policy",
      zoneName: "special.example",
    },
  ],
  schemaVersion: 1,
})

test("fleet policy defaults to no operator exceptions", () => {
  const configuration = createEmptyFleetPolicyConfiguration()

  assert.equal(isFleetPolicyConfiguration(configuration), true)
  assert.deepEqual(configuration.emailDnsRecordExceptions, [])
})

test("fleet policy configuration validates and indexes exact exceptions", () => {
  configureFleetPolicy(POLICY)

  assert.equal(configuredEmailPolicyExceptions().length, 1)
  assert.deepEqual(
    emailPolicyExceptionsForZone("special.example").spf.expected,
    POLICY.emailDnsRecordExceptions[0].expected,
  )
  assert.deepEqual(emailPolicyExceptionsForZone("ordinary.example"), {})
})

test("fleet policy rejects malformed and duplicate exceptions", () => {
  assert.equal(isFleetPolicyConfiguration({ schemaVersion: 1 }), false)
  assert.throws(
    () => normalizeFleetPolicyConfiguration({
      emailDnsRecordExceptions: [
        POLICY.emailDnsRecordExceptions[0],
        POLICY.emailDnsRecordExceptions[0],
      ],
      schemaVersion: 1,
    }),
    /Duplicate spf policy exception/,
  )
})
