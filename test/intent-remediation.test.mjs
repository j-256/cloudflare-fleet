import assert from "node:assert/strict"
import test from "node:test"

import {
  FLEET_INTENT_PRESENCE_CONSTRAINT,
  FLEET_INTENT_VALUE_CONSTRAINT,
} from "../src/fleet-intent.mjs"
import {
  INTENT_REMEDIATION_KIND,
  INTENT_REMEDIATION_PRESENTATION,
  intentPolicyRemediation,
} from "../src/intent-remediation.mjs"

function row(workspaceKind = null) {
  return {
    category: "Rulesets",
    cells: new Map([
      ["example.com", {
        workspaceAction: workspaceKind ? { kind: workspaceKind } : null,
      }],
    ]),
    key: "zone:http_request_firewall_custom",
    missingResolutions: new Map(),
  }
}

const expected = Object.freeze({
  canonical: '{"kind":"zone","rule_count":1}',
  resolutionCanonical: null,
  value: Object.freeze({
    kind: "zone",
    rule_count: 1,
  }),
})

test("editable ruleset intent advertises manual remediation", () => {
  const remediation = intentPolicyRemediation(row("zone"), expected)

  assert.equal(remediation.className, INTENT_REMEDIATION_KIND.MANUAL)
  assert.equal(
    INTENT_REMEDIATION_PRESENTATION[remediation.className].label,
    "Manual remediation",
  )
  assert.match(remediation.text, /editable ruleset workspace/)
  assert.match(remediation.text, /no automatic whole-ruleset alignment/)
})

test("managed and unavailable ruleset workspaces remain comparison only", () => {
  assert.equal(
    intentPolicyRemediation(row("managed"), expected).className,
    INTENT_REMEDIATION_KIND.COMPARE_ONLY,
  )
  assert.equal(
    intentPolicyRemediation(row(), expected).className,
    INTENT_REMEDIATION_KIND.COMPARE_ONLY,
  )
})

test("editable ruleset workspaces describe manual non-exact remediation", () => {
  const mayDiffer = intentPolicyRemediation(
    row("custom"),
    null,
    FLEET_INTENT_VALUE_CONSTRAINT.MAY_DIFFER,
  )
  const mustDiffer = intentPolicyRemediation(
    row("custom"),
    null,
    FLEET_INTENT_VALUE_CONSTRAINT.MUST_DIFFER,
  )

  assert.equal(mayDiffer.className, INTENT_REMEDIATION_KIND.MANUAL)
  assert.match(mayDiffer.text, /no automatic create flow/)
  assert.equal(mustDiffer.className, INTENT_REMEDIATION_KIND.MANUAL)
  assert.match(mustDiffer.text, /no automatic uniqueness action/)
})

test("optional may-differ intent is presented as allowed variation", () => {
  const remediation = intentPolicyRemediation(
    row("custom"),
    null,
    FLEET_INTENT_VALUE_CONSTRAINT.MAY_DIFFER,
    FLEET_INTENT_PRESENCE_CONSTRAINT.OPTIONAL,
  )

  assert.equal(remediation.className, INTENT_REMEDIATION_KIND.ALLOWANCE)
  assert.equal(
    INTENT_REMEDIATION_PRESENTATION[remediation.className].label,
    "Allowed variation",
  )
  assert.match(remediation.text, /may omit this facet/)
})

test("optional exact intent does not describe missing values as drift", () => {
  const remediation = intentPolicyRemediation(
    row("zone"),
    expected,
    FLEET_INTENT_VALUE_CONSTRAINT.EXACT,
    FLEET_INTENT_PRESENCE_CONSTRAINT.OPTIONAL,
  )

  assert.equal(remediation.className, INTENT_REMEDIATION_KIND.MANUAL)
  assert.match(remediation.text, /Missing values are allowed/)
  assert.doesNotMatch(remediation.text, /fill missing/)
})

test("forbidden intent describes supported removal as manual remediation", () => {
  const remediation = intentPolicyRemediation(
    row("zone"),
    null,
    FLEET_INTENT_VALUE_CONSTRAINT.MAY_DIFFER,
    FLEET_INTENT_PRESENCE_CONSTRAINT.FORBIDDEN,
  )

  assert.equal(remediation.className, INTENT_REMEDIATION_KIND.MANUAL)
  assert.match(remediation.text, /remove present values/)
})
