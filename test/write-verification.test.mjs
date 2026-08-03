import assert from "node:assert/strict"
import test from "node:test"

import { HTTP_METHOD } from "../src/constants.mjs"
import {
  verificationTargetsForOperation,
  verificationTargetsForPlans,
  verificationTargetsForResults,
  WRITE_VERIFICATION_KIND,
} from "../src/write-verification.mjs"

function plan(...operations) {
  return {
    operations,
  }
}

test("write verification targets exact settings and DNS records", () => {
  assert.deepEqual(
    verificationTargetsForPlans([
      plan({
        method: HTTP_METHOD.PATCH,
        path: "zones/zone-alpha/settings/always_use_https",
      }),
      plan({
        method: HTTP_METHOD.PATCH,
        path: "zones/zone-alpha/dns_records/record-alpha",
      }),
    ]),
    [
      {
        kind: WRITE_VERIFICATION_KIND.SETTING,
        settingId: "always_use_https",
        zoneId: "zone-alpha",
      },
      {
        kind: WRITE_VERIFICATION_KIND.DNS_RECORD,
        recordId: "record-alpha",
        zoneId: "zone-alpha",
      },
    ],
  )
})

test("a DNS collection read subsumes exact records in the same zone", () => {
  assert.deepEqual(
    verificationTargetsForPlans([
      plan(
        {
          method: HTTP_METHOD.PATCH,
          path: "zones/zone-alpha/dns_records/record-alpha",
        },
        {
          method: HTTP_METHOD.POST,
          path: "zones/zone-alpha/dns_records",
        },
      ),
    ]),
    [
      {
        kind: WRITE_VERIFICATION_KIND.SURFACE,
        surfaceId: "dns",
        zoneId: "zone-alpha",
      },
    ],
  )
})

test("completed creates narrow verification to returned resource identifiers", () => {
  assert.deepEqual(
    verificationTargetsForResults([
      {
        operation: {
          method: HTTP_METHOD.POST,
          path: "zones/zone-alpha/dns_records",
        },
        response: { result: { id: "record-alpha" } },
      },
      {
        operation: {
          body: { kind: "zone", phase: "http_request_dynamic_redirect" },
          method: HTTP_METHOD.POST,
          path: "zones/zone-beta/rulesets",
        },
        response: { result: { id: "ruleset-beta" } },
      },
    ]),
    [
      {
        kind: WRITE_VERIFICATION_KIND.DNS_RECORD,
        recordId: "record-alpha",
        zoneId: "zone-alpha",
      },
      {
        kind: WRITE_VERIFICATION_KIND.RULESET,
        rulesetId: "ruleset-beta",
        zoneId: "zone-beta",
      },
    ],
  )
})

test("DNS deletion verifies the affected zone collection", () => {
  assert.deepEqual(
    verificationTargetsForOperation({
      method: HTTP_METHOD.DELETE,
      path: "zones/zone-alpha/dns_records/record-alpha",
    }),
    [{
      kind: WRITE_VERIFICATION_KIND.SURFACE,
      surfaceId: "dns",
      zoneId: "zone-alpha",
    }],
  )
})

test("Email Routing DNS writes verify every surface they can mutate", () => {
  assert.deepEqual(
    verificationTargetsForPlans([
      plan(
        {
          method: HTTP_METHOD.POST,
          path: "zones/zone-alpha/email/routing/dns",
        },
        {
          method: HTTP_METHOD.PATCH,
          path: "zones/zone-alpha/email/routing",
        },
        {
          method: HTTP_METHOD.PUT,
          path: "zones/zone-alpha/email/routing/rules/catch_all",
        },
      ),
    ]),
    [
      {
        kind: WRITE_VERIFICATION_KIND.SURFACE,
        surfaceId: "dns",
        zoneId: "zone-alpha",
      },
      {
        kind: WRITE_VERIFICATION_KIND.SURFACE,
        surfaceId: "email",
        zoneId: "zone-alpha",
      },
      {
        kind: WRITE_VERIFICATION_KIND.SURFACE,
        surfaceId: "email-dns",
        zoneId: "zone-alpha",
      },
      {
        kind: WRITE_VERIFICATION_KIND.EMAIL_RULE,
        ruleIdentifier: "catch_all",
        zoneId: "zone-alpha",
      },
    ],
  )
})

test("ruleset mutations verify their exact parent or created phase", () => {
  assert.deepEqual(
    verificationTargetsForPlans([
      plan(
        {
          body: {
            kind: "zone",
            phase: "http_request_dynamic_redirect",
          },
          method: HTTP_METHOD.POST,
          path: "zones/zone-alpha/rulesets",
        },
        {
          method: HTTP_METHOD.PATCH,
          path: "zones/zone-beta/rulesets/ruleset-beta/rules/rule-beta",
        },
        {
          method: HTTP_METHOD.DELETE,
          path: "zones/zone-gamma/rulesets/ruleset-gamma",
        },
      ),
    ]),
    [
      {
        kind: WRITE_VERIFICATION_KIND.RULESET_PHASE,
        kinds: ["zone"],
        phase: "http_request_dynamic_redirect",
        zoneId: "zone-alpha",
      },
      {
        kind: WRITE_VERIFICATION_KIND.RULESET,
        rulesetId: "ruleset-beta",
        zoneId: "zone-beta",
      },
      {
        kind: WRITE_VERIFICATION_KIND.RULESET_DELETION,
        rulesetId: "ruleset-gamma",
        zoneId: "zone-gamma",
      },
    ],
  )
})

test("unsupported write paths fail before verification can silently widen", () => {
  assert.throws(
    () => verificationTargetsForOperation({
      method: HTTP_METHOD.PATCH,
      path: "accounts/account-alpha/unknown",
    }),
    /Unsupported write verification path/,
  )
})
