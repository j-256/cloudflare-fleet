import assert from "node:assert/strict"
import test from "node:test"

import { FLEET_INTENT_VALUE_CONSTRAINT } from "../src/fleet-intent.mjs"
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
