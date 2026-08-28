import assert from "node:assert/strict"
import test from "node:test"

import {
  buildDnssecStatusPlan,
  buildDnsRecordCopyPlan,
  buildDnsRecordDeletePlan,
  buildDnsRecordEditPlan,
  buildEmailAlignmentPlan,
  buildEmailRoutingRuleEditPlan,
  buildEmailRoutingSettingPlan,
  buildRuleCreatePlan,
  buildRuleCopyPlans,
  buildRuleDeletePlan,
  buildRuleEditPlan,
  buildRuleRenamePlans,
  buildRuleReorderPlan,
  buildRulesetDeletePlan,
  buildRulesetDescriptionPlan,
  buildWafAlignmentPlan,
  buildZoneSettingPlan,
  deriveEmailDestination,
  deriveEmailDnsPolicy,
  deriveFleetWafPolicies,
  dnsRecordCopyCapability,
  dnsRecordEditCapability,
  editableDnsRecordPayload,
  editableEmailRoutingRulePayload,
  editableRulePayload,
  emailRoutingRuleEditCapability,
  emailIssues,
  evaluateEmailPolicyExceptions,
  evaluateFleetEmailPolicyExceptions,
  executePlans,
  portableRulePayload,
  ruleCopyCapability,
  wafIssues,
} from "../src/policies.mjs"
import {
  FLEET_WAF_RULE_DESCRIPTION,
  FLEET_WAF_RULES,
  POLICY_EXCEPTION_STATUS,
  WAF_RULE_ORDER,
} from "../src/constants.mjs"
import {
  configureFleetPolicy,
  configuredEmailPolicyExceptions,
  emailPolicyExceptionsForZone,
} from "../src/fleet-policy.mjs"
import {
  makeInventory,
  makeRule,
  makeZone,
  ok,
} from "./fixtures.mjs"

const BLOCK_RULE = FLEET_WAF_RULE_DESCRIPTION.ANTI_SCANNER
const LOG_RULE = FLEET_WAF_RULE_DESCRIPTION.LOG_ALL_OTHERS
const ANY_RULE = "[fleet] Unconstrained rule"
const LAST_RULE = "[fleet] Trailing rule"
const LAST_RULE_TWO = "[fleet] Final trailing rule"
const FLEET_EMAIL_DNS_POLICY = {
  available: true,
  dmarc: {
    available: true,
    contentTemplate: "v=DMARC1; p=none; rua=mailto:dmarc@{zone};",
    count: 2,
    ttl: 60,
  },
  reason: "",
  spf: {
    available: true,
    content: "v=spf1 include:_spf.google.com include:_spf.mx.cloudflare.net -all",
    count: 2,
    ttl: 60,
  },
}
const EXCEPTION_ZONE = "special.example"
configureFleetPolicy({
  emailDnsRecordExceptions: [
    {
      component: "spf",
      expected: {
        content: "v=spf1 include:_spf.transactional.example -all",
        ttl: 60,
      },
      reason: "This zone uses an approved transactional sender policy",
      zoneName: EXCEPTION_ZONE,
    },
  ],
  schemaVersion: 1,
})
const SPF_EXCEPTION = emailPolicyExceptionsForZone(EXCEPTION_ZONE).spf

function dmarcRecord(zoneName, overrides = {}) {
  return {
    content: `"v=DMARC1; p=none; rua=mailto:dmarc@${zoneName};"`,
    id: `dmarc-${zoneName}`,
    name: `_dmarc.${zoneName}`,
    ttl: 60,
    type: "TXT",
    ...overrides,
  }
}

function exceptionalSpfRecord(overrides = {}) {
  return {
    content: `"${SPF_EXCEPTION.expected.content}"`,
    id: "exception-spf",
    name: EXCEPTION_ZONE,
    ttl: SPF_EXCEPTION.expected.ttl,
    type: "TXT",
    ...overrides,
  }
}

function fleetRuleset(overrides = {}) {
  return {
    id: "ruleset-id",
    kind: "zone",
    name: "default",
    phase: "http_request_firewall_custom",
    rules: [
      makeRule(LOG_RULE, {
        action: "skip",
        action_parameters: { products: ["zoneLockdown"] },
        expression: "(true)",
        logging: { enabled: true },
      }),
      makeRule(BLOCK_RULE),
    ],
    ...overrides,
  }
}

test("DNS record copy materializes the destination zone and creates missing records", () => {
  const source = makeZone("alpha.example", {
    dns: [
      {
        content: "origin.alpha.example",
        id: "source-record",
        locked: false,
        name: "www.alpha.example",
        proxied: true,
        ttl: 300,
        type: "CNAME",
      },
    ],
  })
  const target = makeZone("beta.example", {
    dns: [],
  })

  const plan = buildDnsRecordCopyPlan(source, target, ["source-record"])

  assert.equal(plan.operations.length, 1)
  assert.equal(plan.operations[0].method, "POST")
  assert.equal(plan.operations[0].path, "zones/zone-beta.example/dns_records")
  assert.deepEqual(plan.operations[0].body, {
    content: "origin.beta.example",
    name: "www.beta.example",
    proxied: true,
    ttl: 300,
    type: "CNAME",
  })
})

test("DNS record copy is a no-op when the live destination already matches", () => {
  const sourceRecord = {
    content: "192.0.2.1",
    id: "source-record",
    locked: false,
    name: "alpha.example",
    proxied: true,
    ttl: 1,
    type: "A",
  }
  const source = makeZone("alpha.example", {
    dns: [sourceRecord],
  })
  const target = makeZone("beta.example", {
    dns: [
      {
        ...sourceRecord,
        id: "target-record",
        name: "beta.example",
      },
    ],
  })

  assert.equal(
    buildDnsRecordCopyPlan(source, target, ["source-record"]).operations.length,
    0,
  )
})

test("DNS record copy refuses to overwrite a stale divergent destination", () => {
  const source = makeZone("alpha.example", {
    dns: [
      {
        content: "192.0.2.1",
        id: "source-record",
        locked: false,
        name: "alpha.example",
        ttl: 1,
        type: "A",
      },
    ],
  })
  const target = makeZone("beta.example", {
    dns: [
      {
        content: "192.0.2.2",
        id: "target-record",
        locked: false,
        name: "beta.example",
        ttl: 1,
        type: "A",
      },
    ],
  })

  assert.throws(
    () => buildDnsRecordCopyPlan(source, target, ["source-record"]),
    /no longer missing and differs/,
  )
})

test("DNS copy capability blocks locked records", () => {
  assert.deepEqual(
    dnsRecordCopyCapability({
      content: "192.0.2.1",
      id: "locked-record",
      locked: true,
      name: "alpha.example",
      ttl: 1,
      type: "A",
    }),
    {
      copyable: false,
      reason: "Cloudflare reports that this DNS record is locked",
    },
  )
})

function redirectRule(zoneName, overrides = {}) {
  return makeRule("Redirect docs", {
    action: "redirect",
    action_parameters: {
      from_value: {
        preserve_query_string: true,
        status_code: 301,
        target_url: {
          value: `https://${zoneName}/docs`,
        },
      },
    },
    expression: `http.host eq "${zoneName}"`,
    id: `redirect-${zoneName}`,
    ref: `redirect-${zoneName}`,
    ...overrides,
  })
}

function ruleZone(name, ruleset = null, overrides = {}) {
  return makeZone(name, {
    ruleDetails: ruleset ? [ok(ruleset)] : [],
    ...overrides,
  })
}

test("email policy derives a verified consensus destination", () => {
  const inventory = makeInventory([
    makeZone("alpha.example"),
    makeZone("beta.example"),
    makeZone("special.example", { destination: "other@example.com" }),
  ], {
    emailAddresses: [
      { email: "fleet@example.com", verified: "2026-07-01T00:00:00Z" },
      { email: "other@example.com", verified: "2026-07-01T00:00:00Z" },
    ],
  })

  assert.deepEqual(deriveEmailDestination(inventory), {
    available: true,
    count: 2,
    email: "fleet@example.com",
  })
})

test("email alignment plans every missing policy component in safe order", () => {
  const zone = makeZone("new.example", {
    catchAll: {
      actions: [],
      enabled: false,
    },
    email: {
      enabled: false,
      skip_wizard: false,
      status: "locked",
      support_subaddress: false,
    },
  })

  assert.deepEqual(emailIssues(zone, "fleet@example.com", FLEET_EMAIL_DNS_POLICY), [
    "Email Routing is disabled",
    "DNS records are locked",
    "Subaddressing is disabled",
    "Catch-all is disabled",
    "Catch-all does not forward",
  ])

  const plan = buildEmailAlignmentPlan(zone, "fleet@example.com", FLEET_EMAIL_DNS_POLICY)
  assert.deepEqual(
    plan.operations.map((operation) => [operation.method, operation.path]),
    [
      ["POST", "zones/zone-new.example/email/routing/dns"],
      ["PATCH", "zones/zone-new.example/email/routing"],
      ["PUT", "zones/zone-new.example/email/routing/rules/catch_all"],
      ["PATCH", "zones/zone-new.example/email/routing/dns"],
    ],
  )
  assert.deepEqual(plan.operations[1], {
    body: { support_subaddress: true },
    currentValue: { support_subaddress: false },
    label: "Match Email Routing settings",
    method: "PATCH",
    path: "zones/zone-new.example/email/routing",
  })
})

test("email policy treats setup wizard state as inspection-only metadata", () => {
  const zone = makeZone("alpha.example", {
    email: { skip_wizard: false },
  })

  assert.deepEqual(
    emailIssues(zone, "fleet@example.com", FLEET_EMAIL_DNS_POLICY),
    [],
  )
  assert.deepEqual(
    buildEmailAlignmentPlan(zone, "fleet@example.com", FLEET_EMAIL_DNS_POLICY)
      .operations,
    [],
  )
})

test("email policy rejects extra catch-all destinations", () => {
  const zone = makeZone("alpha.example", {
    catchAll: {
      actions: [
        {
          type: "forward",
          value: ["fleet@example.com", "other@example.com"],
        },
      ],
    },
  })

  assert.deepEqual(
    emailIssues(zone, "fleet@example.com", FLEET_EMAIL_DNS_POLICY),
    ["Catch-all uses another destination"],
  )
  assert.equal(buildEmailAlignmentPlan(zone, "fleet@example.com", FLEET_EMAIL_DNS_POLICY).operations.length, 1)
})

test("email alignment fixes a mismatched SPF record even when Email Routing is disabled", () => {
  const zone = makeZone("alpha.example", {
    email: { enabled: false, skip_wizard: true, status: "unlocked", support_subaddress: true },
    dns: [
      {
        content: "\"v=spf1 -all\"",
        id: "spf-id",
        name: "alpha.example",
        ttl: 60,
        type: "TXT",
      },
      dmarcRecord("alpha.example"),
    ],
  })

  // The audit reports SPF drift regardless of whether Email Routing is enabled
  assert.ok(
    emailIssues(zone, "fleet@example.com", FLEET_EMAIL_DNS_POLICY).some((issue) => /SPF/.test(issue)),
  )
  // ...so the alignment plan must actually include the SPF fix, matching the DMARC branch
  const spfFix = buildEmailAlignmentPlan(zone, "fleet@example.com", FLEET_EMAIL_DNS_POLICY)
    .operations.find((operation) => operation.label === "Match the fleet SPF value and TTL")
  assert.ok(spfFix, "expected an SPF fix operation when SPF drifts")
  assert.equal(spfFix.method, "PATCH")
  assert.match(spfFix.path, /\/dns_records\/spf-id$/)
  assert.equal(
    spfFix.body.content,
    "\"v=spf1 include:_spf.google.com include:_spf.mx.cloudflare.net -all\"",
  )
})

test("email policy compares required DNS records using DNS TXT semantics", () => {
  const expectedDkim = "\"v=DKIM1; p=abcdefgh\""
  const zone = makeZone("alpha.example", {
    dns: [
      {
        content: "\"v=spf1 include:_spf.google.com include:_spf.mx.cloudflare.net -all\"",
        id: "spf-id",
        name: "alpha.example",
        ttl: 60,
        type: "TXT",
      },
      {
        content: "\"v=DKIM1; p=abcd\" \"efgh\"",
        name: "selector._domainkey.alpha.example",
        ttl: 1,
        type: "TXT",
      },
      dmarcRecord("alpha.example"),
    ],
    emailDns: [
      {
        content: expectedDkim,
        name: "selector._domainkey.alpha.example",
        ttl: 1,
        type: "TXT",
      },
    ],
  })

  assert.deepEqual(emailIssues(zone, "fleet@example.com", FLEET_EMAIL_DNS_POLICY), [])
  assert.deepEqual(buildEmailAlignmentPlan(zone, "fleet@example.com", FLEET_EMAIL_DNS_POLICY).operations, [])
})

test("email policy repairs missing required DNS records before unlocking", () => {
  const zone = makeZone("alpha.example", {
    emailDns: [
      {
        content: "route1.mx.cloudflare.net.",
        name: "alpha.example",
        priority: 10,
        ttl: 1,
        type: "MX",
      },
    ],
  })

  assert.deepEqual(emailIssues(zone, "fleet@example.com", FLEET_EMAIL_DNS_POLICY), [
    "1 required Email Routing DNS record missing or different",
  ])
  assert.deepEqual(
    buildEmailAlignmentPlan(
      zone,
      "fleet@example.com",
      FLEET_EMAIL_DNS_POLICY,
    ).operations.map((operation) => operation.method),
    ["POST", "PATCH"],
  )
})

test("email DNS policy derives dominant SPF and zone-relative DMARC values", () => {
  const inventory = makeInventory([
    makeZone("alpha.example"),
    makeZone("beta.example"),
    makeZone("special.example", {
      dns: [
        {
          content: "\"v=spf1 include:custom.example ~all\"",
          id: "special-spf",
          name: "special.example",
          ttl: 300,
          type: "TXT",
        },
      ],
    }),
  ])

  assert.deepEqual(deriveEmailDnsPolicy(inventory), {
    available: true,
    dmarc: {
      available: true,
      contentTemplate: FLEET_EMAIL_DNS_POLICY.dmarc.contentTemplate,
      count: 2,
      ttl: 60,
    },
    reason: "",
    spf: {
      available: true,
      content: FLEET_EMAIL_DNS_POLICY.spf.content,
      count: 2,
      ttl: 60,
    },
  })
})

test("email policy plans an explicit SPF update", () => {
  const zone = makeZone("alpha.example", {
    dns: [
      {
        content: "\"v=spf1 include:other.example ~all\"",
        id: "spf-id",
        name: "alpha.example",
        ttl: 300,
        type: "TXT",
      },
      dmarcRecord("alpha.example"),
    ],
  })

  assert.deepEqual(emailIssues(zone, "fleet@example.com", FLEET_EMAIL_DNS_POLICY), [
    "SPF value or TTL differs from fleet consensus",
  ])
  const plan = buildEmailAlignmentPlan(zone, "fleet@example.com", FLEET_EMAIL_DNS_POLICY)
  assert.deepEqual(plan.operations, [
    {
      body: {
        content: "\"v=spf1 include:_spf.google.com include:_spf.mx.cloudflare.net -all\"",
        ttl: 60,
      },
      currentValue: {
        content: "\"v=spf1 include:other.example ~all\"",
        name: "alpha.example",
        ttl: 300,
        type: "TXT",
      },
      label: "Match the fleet SPF value and TTL",
      method: "PATCH",
      path: "zones/zone-alpha.example/dns_records/spf-id",
    },
  ])
})

test("email policy preserves only the exact configured SPF exception", () => {
  const zone = makeZone(EXCEPTION_ZONE, {
    dns: [
      exceptionalSpfRecord(),
      dmarcRecord(EXCEPTION_ZONE),
    ],
  })
  const options = {
    exceptions: emailPolicyExceptionsForZone(zone.meta.name),
  }

  assert.deepEqual(
    emailIssues(zone, "fleet@example.com", FLEET_EMAIL_DNS_POLICY),
    ["SPF value or TTL differs from fleet consensus"],
  )
  assert.deepEqual(
    emailIssues(zone, "fleet@example.com", FLEET_EMAIL_DNS_POLICY, options),
    [],
  )
  assert.deepEqual(
    buildEmailAlignmentPlan(
      zone,
      "fleet@example.com",
      FLEET_EMAIL_DNS_POLICY,
      options,
    ).operations,
    [],
  )
  assert.deepEqual(
    evaluateEmailPolicyExceptions(
      zone,
      FLEET_EMAIL_DNS_POLICY,
      options.exceptions,
    ).map((exception) => ({
      current: exception.current,
      status: exception.status,
    })),
    [
      {
        current: SPF_EXCEPTION.expected,
        status: POLICY_EXCEPTION_STATUS.ACTIVE,
      },
    ],
  )
})

test("email policy treats unexpected configured SPF content or TTL as drift", () => {
  for (const overrides of [
    {
      content: "\"v=spf1 include:unexpected.example ~all\"",
    },
    {
      ttl: 300,
    },
  ]) {
    const zone = makeZone(EXCEPTION_ZONE, {
      dns: [
        exceptionalSpfRecord(overrides),
        dmarcRecord(EXCEPTION_ZONE),
      ],
    })
    const options = {
      exceptions: emailPolicyExceptionsForZone(zone.meta.name),
    }

    assert.deepEqual(
      emailIssues(zone, "fleet@example.com", FLEET_EMAIL_DNS_POLICY, options),
      ["SPF value or TTL differs from fleet consensus"],
    )
    assert.equal(
      evaluateEmailPolicyExceptions(
        zone,
        FLEET_EMAIL_DNS_POLICY,
        options.exceptions,
      )[0].status,
      POLICY_EXCEPTION_STATUS.VIOLATED,
    )
    assert.equal(
      buildEmailAlignmentPlan(
        zone,
        "fleet@example.com",
        FLEET_EMAIL_DNS_POLICY,
        options,
      ).operations[0].label,
      "Match the fleet SPF value and TTL",
    )
  }
})

test("email policy reports dormant and unavailable configured exceptions", () => {
  const aligned = makeZone(EXCEPTION_ZONE, {
    dns: [
      exceptionalSpfRecord({
        content: `"${FLEET_EMAIL_DNS_POLICY.spf.content}"`,
      }),
      dmarcRecord(EXCEPTION_ZONE),
    ],
  })
  assert.equal(
    evaluateFleetEmailPolicyExceptions(
      makeInventory([aligned]),
      FLEET_EMAIL_DNS_POLICY,
      configuredEmailPolicyExceptions(),
    )[0].status,
    POLICY_EXCEPTION_STATUS.ALIGNED,
  )
  assert.equal(
    evaluateFleetEmailPolicyExceptions(
      makeInventory([]),
      FLEET_EMAIL_DNS_POLICY,
      configuredEmailPolicyExceptions(),
    )[0].status,
    POLICY_EXCEPTION_STATUS.UNAVAILABLE,
  )
})

test("an SPF variation exception does not hide a missing SPF record", () => {
  const zone = makeZone(EXCEPTION_ZONE, {
    dns: [
      dmarcRecord(EXCEPTION_ZONE),
    ],
  })
  const options = {
    exceptions: emailPolicyExceptionsForZone(zone.meta.name),
  }

  assert.deepEqual(
    emailIssues(zone, "fleet@example.com", FLEET_EMAIL_DNS_POLICY, options),
    ["SPF record is missing"],
  )
  assert.equal(
    buildEmailAlignmentPlan(
      zone,
      "fleet@example.com",
      FLEET_EMAIL_DNS_POLICY,
      options,
    ).operations[0].label,
    "Create the fleet SPF record",
  )
})

test("email policy creates a missing zone-relative DMARC record", () => {
  const zone = makeZone("new.example", {
    dns: [
      {
        content: "\"v=spf1 include:_spf.google.com include:_spf.mx.cloudflare.net -all\"",
        id: "spf-id",
        name: "new.example",
        ttl: 60,
        type: "TXT",
      },
    ],
  })

  assert.deepEqual(emailIssues(zone, "fleet@example.com", FLEET_EMAIL_DNS_POLICY), [
    "DMARC record is missing",
  ])
  const plan = buildEmailAlignmentPlan(zone, "fleet@example.com", FLEET_EMAIL_DNS_POLICY)
  assert.deepEqual(plan.operations, [
    {
      body: {
        content: "\"v=DMARC1; p=none; rua=mailto:dmarc@new.example;\"",
        name: "_dmarc.new.example",
        ttl: 60,
        type: "TXT",
      },
      label: "Create the fleet DMARC record",
      method: "POST",
      path: "zones/zone-new.example/dns_records",
    },
  ])
})

test("email policy updates a divergent DMARC record", () => {
  const zone = makeZone("alpha.example", {
    dns: [
      {
        content: "\"v=spf1 include:_spf.google.com include:_spf.mx.cloudflare.net -all\"",
        id: "spf-id",
        name: "alpha.example",
        ttl: 60,
        type: "TXT",
      },
      dmarcRecord("alpha.example", {
        content: "\"v=DMARC1; p=reject;\"",
        ttl: 300,
      }),
    ],
  })

  assert.deepEqual(emailIssues(zone, "fleet@example.com", FLEET_EMAIL_DNS_POLICY), [
    "DMARC value or TTL differs from fleet consensus",
  ])
  const plan = buildEmailAlignmentPlan(zone, "fleet@example.com", FLEET_EMAIL_DNS_POLICY)
  assert.deepEqual(plan.operations, [
    {
      body: {
        content: "\"v=DMARC1; p=none; rua=mailto:dmarc@alpha.example;\"",
        ttl: 60,
      },
      currentValue: {
        content: "\"v=DMARC1; p=reject;\"",
        name: "_dmarc.alpha.example",
        ttl: 300,
        type: "TXT",
      },
      label: "Match the fleet DMARC value and TTL",
      method: "PATCH",
      path: "zones/zone-alpha.example/dns_records/dmarc-alpha.example",
    },
  ])
})

test("WAF policy builds a new entrypoint from live consensus", () => {
  const consensus = fleetRuleset()
  const inventory = makeInventory([
    makeZone("alpha.example", { ruleDetails: [ok(consensus)] }),
    makeZone("beta.example", { ruleDetails: [ok(consensus)] }),
    makeZone("new.example"),
  ])
  const policies = deriveFleetWafPolicies(inventory)

  assert.deepEqual(FLEET_WAF_RULES, [
    { description: LOG_RULE, order: WAF_RULE_ORDER.FIRST },
    { description: BLOCK_RULE, order: WAF_RULE_ORDER.FIRST },
  ])
  assert.equal(policies.get(BLOCK_RULE).available, true)
  assert.equal(policies.get(LOG_RULE).available, true)
  assert.equal(wafIssues(inventory.zones[2], policies).length, 2)

  const plan = buildWafAlignmentPlan(inventory.zones[2], policies)
  assert.equal(plan.operations.length, 1)
  assert.equal(plan.operations[0].method, "POST")
  assert.equal(plan.operations[0].path, "zones/zone-new.example/rulesets")
  assert.deepEqual(
    plan.operations[0].body.rules.map((rule) => rule.description),
    [LOG_RULE, BLOCK_RULE],
  )
})

test("WAF policy keeps leading rules in canonical order", () => {
  const consensus = fleetRuleset()
  const targetLogRule = makeRule(LOG_RULE, {
    action: "skip",
    action_parameters: { products: ["zoneLockdown"] },
    expression: "(true)",
    logging: { enabled: true },
  })
  const targetRuleset = fleetRuleset({
    rules: [
      makeRule(BLOCK_RULE),
      targetLogRule,
      makeRule("Zone-specific rule"),
    ],
  })
  const inventory = makeInventory([
    makeZone("alpha.example", { ruleDetails: [ok(consensus)] }),
    makeZone("beta.example", { ruleDetails: [ok(consensus)] }),
    makeZone("target.example", { ruleDetails: [ok(targetRuleset)] }),
  ])
  const policies = deriveFleetWafPolicies(inventory)

  assert.deepEqual(wafIssues(inventory.zones[2], policies), [
    `${LOG_RULE}: is not in leading position 1`,
    `${BLOCK_RULE}: is not in leading position 2`,
  ])
  const plan = buildWafAlignmentPlan(inventory.zones[2], policies)
  assert.deepEqual(plan.operations, [
    {
      body: { position: { index: 1 } },
      currentValue: { position: 2 },
      label: `Move ${LOG_RULE} to leading position 1`,
      method: "PATCH",
      path: `zones/zone-target.example/rulesets/ruleset-id/rules/${targetLogRule.id}`,
    },
  ])
})

test("WAF policy inserts a missing rule into its leading position", () => {
  const consensus = fleetRuleset()
  const logRule = makeRule(LOG_RULE, {
    action: "skip",
    action_parameters: { products: ["zoneLockdown"] },
    expression: "(true)",
    logging: { enabled: true },
  })
  const inventory = makeInventory([
    makeZone("alpha.example", { ruleDetails: [ok(consensus)] }),
    makeZone("beta.example", { ruleDetails: [ok(consensus)] }),
    makeZone("target.example", {
      ruleDetails: [ok(fleetRuleset({ rules: [logRule] }))],
    }),
  ])
  const policies = deriveFleetWafPolicies(inventory)

  const plan = buildWafAlignmentPlan(inventory.zones[2], policies)
  assert.equal(plan.operations.length, 1)
  assert.equal(plan.operations[0].method, "POST")
  assert.equal(plan.operations[0].path, "zones/zone-target.example/rulesets/ruleset-id/rules")
  assert.equal(plan.operations[0].body.description, BLOCK_RULE)
  assert.deepEqual(plan.operations[0].body.position, { index: 2 })
})

test("WAF policy supports leading, unconstrained, and trailing rule cohorts", () => {
  const definitions = [
    { description: LOG_RULE, order: WAF_RULE_ORDER.FIRST },
    { description: BLOCK_RULE, order: WAF_RULE_ORDER.FIRST },
    { description: ANY_RULE, order: WAF_RULE_ORDER.ANY },
    { description: LAST_RULE, order: WAF_RULE_ORDER.LAST },
    { description: LAST_RULE_TWO, order: WAF_RULE_ORDER.LAST },
  ]
  const consensus = fleetRuleset({
    rules: [
      makeRule(LOG_RULE, {
        action: "skip",
        action_parameters: { products: ["zoneLockdown"] },
        expression: "(true)",
        logging: { enabled: true },
      }),
      makeRule(BLOCK_RULE),
      makeRule(ANY_RULE),
      makeRule(LAST_RULE),
      makeRule(LAST_RULE_TWO),
    ],
  })
  const targetRuleset = fleetRuleset({
    rules: [
      makeRule(LAST_RULE_TWO),
      makeRule(ANY_RULE),
      makeRule(BLOCK_RULE),
      makeRule(LOG_RULE, {
        action: "skip",
        action_parameters: { products: ["zoneLockdown"] },
        expression: "(true)",
        logging: { enabled: true },
      }),
      makeRule("Zone-specific rule"),
      makeRule(LAST_RULE),
    ],
  })
  const inventory = makeInventory([
    makeZone("alpha.example", { ruleDetails: [ok(consensus)] }),
    makeZone("beta.example", { ruleDetails: [ok(consensus)] }),
    makeZone("target.example", { ruleDetails: [ok(targetRuleset)] }),
  ])
  const policies = deriveFleetWafPolicies(inventory, definitions)

  assert.deepEqual(wafIssues(inventory.zones[2], policies), [
    `${LOG_RULE}: is not in leading position 1`,
    `${BLOCK_RULE}: is not in leading position 2`,
    `${LAST_RULE}: is not in trailing position 1`,
    `${LAST_RULE_TWO}: is not in trailing position 2`,
  ])
  assert.deepEqual(
    buildWafAlignmentPlan(inventory.zones[2], policies).operations.map((operation) => ({
      body: operation.body,
      label: operation.label,
    })),
    [
      {
        body: { position: { index: 1 } },
        label: `Move ${LOG_RULE} to leading position 1`,
      },
      {
        body: { position: { index: 2 } },
        label: `Move ${BLOCK_RULE} to leading position 2`,
      },
      {
        body: { position: { after: "" } },
        label: `Move ${LAST_RULE_TWO} to the trailing rule group`,
      },
    ],
  )
})

test("WAF policy orders every cohort when creating an entrypoint", () => {
  const definitions = [
    { description: LAST_RULE, order: WAF_RULE_ORDER.LAST },
    { description: ANY_RULE, order: WAF_RULE_ORDER.ANY },
    { description: LOG_RULE, order: WAF_RULE_ORDER.FIRST },
    { description: LAST_RULE_TWO, order: WAF_RULE_ORDER.LAST },
    { description: BLOCK_RULE, order: WAF_RULE_ORDER.FIRST },
  ]
  const consensus = fleetRuleset({
    rules: definitions.map(({ description }) => makeRule(description)),
  })
  const inventory = makeInventory([
    makeZone("alpha.example", { ruleDetails: [ok(consensus)] }),
    makeZone("beta.example", { ruleDetails: [ok(consensus)] }),
    makeZone("new.example"),
  ])
  const policies = deriveFleetWafPolicies(inventory, definitions)

  assert.deepEqual(
    buildWafAlignmentPlan(inventory.zones[2], policies).operations[0].body.rules
      .map(({ description }) => description),
    [LOG_RULE, BLOCK_RULE, ANY_RULE, LAST_RULE, LAST_RULE_TWO],
  )
})

test("WAF policy creates missing middle and trailing rules in safe order", () => {
  const definitions = [
    { description: LOG_RULE, order: WAF_RULE_ORDER.FIRST },
    { description: ANY_RULE, order: WAF_RULE_ORDER.ANY },
    { description: LAST_RULE, order: WAF_RULE_ORDER.LAST },
    { description: LAST_RULE_TWO, order: WAF_RULE_ORDER.LAST },
  ]
  const consensus = fleetRuleset({
    rules: definitions.map(({ description }) => makeRule(description)),
  })
  const targetRuleset = fleetRuleset({
    rules: [makeRule(LOG_RULE), makeRule(LAST_RULE_TWO)],
  })
  const inventory = makeInventory([
    makeZone("alpha.example", { ruleDetails: [ok(consensus)] }),
    makeZone("beta.example", { ruleDetails: [ok(consensus)] }),
    makeZone("target.example", { ruleDetails: [ok(targetRuleset)] }),
  ])
  const policies = deriveFleetWafPolicies(inventory, definitions)
  const operations = buildWafAlignmentPlan(inventory.zones[2], policies).operations

  assert.deepEqual(
    operations.map(({ body, label }) => ({
      description: body.description,
      label,
      position: body.position,
    })),
    [
      {
        description: ANY_RULE,
        label: `Add ${ANY_RULE}`,
        position: undefined,
      },
      {
        description: LAST_RULE,
        label: `Add ${LAST_RULE}`,
        position: { after: "" },
      },
      {
        description: undefined,
        label: `Move ${LAST_RULE_TWO} to the trailing rule group`,
        position: { after: "" },
      },
    ],
  )
})

test("WAF policy rejects conflicting or unsupported order requirements", () => {
  const inventory = makeInventory([])

  assert.throws(
    () => deriveFleetWafPolicies(inventory, [
      { description: LOG_RULE, order: WAF_RULE_ORDER.FIRST },
      { description: LOG_RULE, order: WAF_RULE_ORDER.LAST },
    ]),
    /conflicting order requirements/,
  )
  assert.throws(
    () => deriveFleetWafPolicies(inventory, [
      { description: LOG_RULE, order: "middle" },
    ]),
    /unsupported order middle/,
  )
})

test("rule copy creates a missing entrypoint with a portable payload", () => {
  const sourceRuleset = {
    id: "source-entrypoint",
    kind: "zone",
    name: "default",
    phase: "http_request_dynamic_redirect",
    rules: [redirectRule("alpha.example")],
  }
  const source = ruleZone("alpha.example", sourceRuleset)
  const target = ruleZone("beta.example")

  const [plan] = buildRuleCopyPlans(source, [target], {
    phase: sourceRuleset.phase,
    ruleId: "redirect-alpha.example",
    rulesetId: sourceRuleset.id,
  })

  assert.equal(plan.operations.length, 1)
  assert.equal(plan.operations[0].method, "POST")
  assert.equal(plan.operations[0].path, "zones/zone-beta.example/rulesets")
  assert.deepEqual(plan.operations[0].body.rules, [
    {
      action: "redirect",
      action_parameters: {
        from_value: {
          preserve_query_string: true,
          status_code: 301,
          target_url: {
            value: "https://beta.example/docs",
          },
        },
      },
      description: "Redirect docs",
      enabled: true,
      expression: "http.host eq \"beta.example\"",
    },
  ])
})

test("DNS record editor exposes only writable fields and plans a live update", () => {
  const zone = makeZone("alpha.example")
  const liveRecord = {
    comment: "old",
    content: "192.0.2.1",
    created_on: "2026-07-01T00:00:00Z",
    id: "record-id",
    locked: false,
    modified_on: "2026-07-01T00:00:00Z",
    name: "alpha.example",
    proxiable: true,
    proxied: true,
    tags: [],
    ttl: 1,
    type: "A",
  }
  const desired = {
    ...editableDnsRecordPayload(liveRecord),
    comment: "new",
    content: "198.51.100.2",
  }
  const plan = buildDnsRecordEditPlan(zone, liveRecord, desired)

  assert.deepEqual(editableDnsRecordPayload(liveRecord), {
    comment: "old",
    content: "192.0.2.1",
    name: "alpha.example",
    proxied: true,
    tags: [],
    ttl: 1,
    type: "A",
  })
  assert.deepEqual(plan.operations, [
    {
      body: desired,
      currentValue: editableDnsRecordPayload(liveRecord),
      label: "Update A alpha.example",
      method: "PATCH",
      path: "zones/zone-alpha.example/dns_records/record-id",
    },
  ])
})

test("DNS record deletion preserves a reversible live definition", () => {
  const zone = makeZone("alpha.example")
  const record = zone.surfaces.dns.result[0]
  const plan = buildDnsRecordDeletePlan(zone, record)

  assert.deepEqual(plan.operations, [{
    currentValue: editableDnsRecordPayload(record),
    label: `Delete ${record.type} ${record.name}`,
    method: "DELETE",
    path: `zones/${zone.meta.id}/dns_records/${record.id}`,
  }])
})

test("DNS record editor returns a no-op and rejects endpoint-foreign fields", () => {
  const zone = makeZone("alpha.example")
  const liveRecord = {
    content: "192.0.2.1",
    id: "record-id",
    name: "alpha.example",
    proxied: true,
    ttl: 1,
    type: "A",
  }

  assert.deepEqual(
    buildDnsRecordEditPlan(zone, liveRecord, editableDnsRecordPayload(liveRecord)).operations,
    [],
  )
  assert.throws(
    () => buildDnsRecordEditPlan(zone, liveRecord, {
      ...editableDnsRecordPayload(liveRecord),
      id: "replacement-id",
    }),
    /unsupported fields: id/,
  )
})

test("DNS record editor preserves MX priority in the update plan", () => {
  const zone = makeZone("alpha.example")
  const liveRecord = {
    content: "route1.mx.cloudflare.net",
    id: "mx-record-id",
    locked: false,
    name: "alpha.example",
    priority: 10,
    ttl: 1,
    type: "MX",
  }
  const desired = {
    ...editableDnsRecordPayload(liveRecord),
    priority: 20,
  }
  const plan = buildDnsRecordEditPlan(zone, liveRecord, desired)

  assert.equal(plan.operations.length, 1)
  assert.equal(plan.operations[0].method, "PATCH")
  assert.equal(plan.operations[0].body.priority, 20)
  assert.equal(plan.operations[0].path, "zones/zone-alpha.example/dns_records/mx-record-id")
})

test("DNS record editor uses data instead of computed content for structured records", () => {
  const zone = makeZone("alpha.example")
  const liveRecord = {
    content: "0 issue letsencrypt.org",
    data: {
      flags: 0,
      tag: "issue",
      value: "letsencrypt.org",
    },
    id: "caa-record-id",
    name: "alpha.example",
    proxied: false,
    ttl: 1,
    type: "CAA",
  }
  const current = editableDnsRecordPayload(liveRecord)

  assert.deepEqual(current, {
    type: "CAA",
    name: "alpha.example",
    data: {
      flags: 0,
      tag: "issue",
      value: "letsencrypt.org",
    },
    ttl: 1,
    proxied: false,
  })
  assert.equal(Object.hasOwn(current, "content"), false)
  assert.deepEqual(buildDnsRecordEditPlan(zone, liveRecord, current).operations, [])
  assert.throws(
    () => buildDnsRecordEditPlan(zone, liveRecord, {
      ...current,
      content: liveRecord.content,
    }),
    /unsupported fields: content/,
  )
})

test("DNS record edit capability blocks locked and schema-unknown records", () => {
  assert.deepEqual(dnsRecordEditCapability({
    content: "192.0.2.1",
    id: "locked-record",
    locked: true,
    type: "A",
  }), {
    editable: false,
    reason: "Cloudflare reports that this DNS record is locked",
  })
  assert.deepEqual(dnsRecordEditCapability({
    content: "opaque",
    id: "future-record",
    type: "FUTURE",
  }), {
    editable: false,
    reason: "DNS record type FUTURE is not supported by the edit adapter",
  })
})

test("Email Routing rule editor strips server fields and plans a live PUT", () => {
  const zone = makeZone("alpha.example")
  const liveRule = {
    actions: [
      {
        type: "worker",
        value: ["email-worker"],
      },
    ],
    enabled: true,
    id: "route-id",
    matchers: [
      {
        field: "to",
        type: "literal",
        value: "worker@alpha.example",
      },
    ],
    name: "Worker route",
    priority: 0,
    source: "api",
    tag: "deprecated-tag",
  }
  const current = editableEmailRoutingRulePayload(liveRule)
  const desired = {
    ...current,
    name: "Renamed worker route",
  }
  const plan = buildEmailRoutingRuleEditPlan(zone, liveRule, desired)

  assert.deepEqual(current, {
    actions: liveRule.actions,
    enabled: true,
    matchers: liveRule.matchers,
    name: "Worker route",
    priority: 0,
  })
  assert.equal(emailRoutingRuleEditCapability(liveRule).editable, true)
  assert.equal(plan.operations[0].method, "PUT")
  assert.equal(
    plan.operations[0].path,
    "zones/zone-alpha.example/email/routing/rules/route-id",
  )
  assert.deepEqual(plan.operations[0].body, desired)
  assert.deepEqual(
    buildEmailRoutingRuleEditPlan(zone, liveRule, current).operations,
    [],
  )
  assert.throws(
    () => buildEmailRoutingRuleEditPlan(zone, liveRule, {
      ...desired,
      tag: "server-field",
    }),
    /unsupported fields: tag/,
  )
  assert.match(
    emailRoutingRuleEditCapability({
      ...liveRule,
      source: "wrangler",
    }).reason,
    /Wrangler owns this route/,
  )
})

test("Email Routing setting plans patch only the governed boolean", () => {
  const zone = makeZone("alpha.example", {
    email: {
      skip_wizard: false,
      support_subaddress: false,
    },
  })
  const plan = buildEmailRoutingSettingPlan(
    zone,
    "support_subaddress",
    true,
  )

  assert.deepEqual(plan.operations, [{
    body: { support_subaddress: true },
    currentValue: { support_subaddress: false },
    label: "Set Email Routing support_subaddress",
    method: "PATCH",
    path: "zones/zone-alpha.example/email/routing",
  }])
  assert.deepEqual(
    buildEmailRoutingSettingPlan(zone, "support_subaddress", false).operations,
    [],
  )
  assert.throws(
    () => buildEmailRoutingSettingPlan(zone, "status", true),
    /not directly writable/,
  )
  assert.throws(
    () => buildEmailRoutingSettingPlan(zone, "skip_wizard", true),
    /not directly writable/,
  )
})

test("Email Routing catch-all editor preserves its dedicated schema", () => {
  const zone = makeZone("alpha.example")
  const liveRule = {
    actions: [
      {
        type: "forward",
        value: ["fleet@example.com"],
      },
    ],
    enabled: true,
    id: "catch-all-id",
    matchers: [
      {
        type: "all",
      },
    ],
    name: "Catch all",
    priority: 2147483647,
    source: "api",
  }
  const current = editableEmailRoutingRulePayload(liveRule, {
    catchAll: true,
  })
  const plan = buildEmailRoutingRuleEditPlan(
    zone,
    liveRule,
    {
      ...current,
      enabled: false,
    },
    {
      catchAll: true,
    },
  )

  assert.equal(Object.hasOwn(current, "priority"), false)
  assert.equal(
    plan.operations[0].path,
    "zones/zone-alpha.example/email/routing/rules/catch_all",
  )
  assert.throws(
    () => buildEmailRoutingRuleEditPlan(
      zone,
      liveRule,
      {
        ...current,
        matchers: [
          {
            field: "to",
            type: "literal",
            value: "route@alpha.example",
          },
        ],
      },
      {
        catchAll: true,
      },
    ),
    /catch-all rule must use the all matcher/,
  )
})

test("rule copy treats an exact destination payload as a no-op", () => {
  const phase = "http_request_dynamic_redirect"
  const sourceRuleset = {
    id: "source-entrypoint",
    kind: "zone",
    name: "default",
    phase,
    rules: [redirectRule("alpha.example")],
  }
  const targetRuleset = {
    id: "target-entrypoint",
    kind: "zone",
    name: "default",
    phase,
    rules: [redirectRule("beta.example")],
  }

  const [plan] = buildRuleCopyPlans(
    ruleZone("alpha.example", sourceRuleset),
    [ruleZone("beta.example", targetRuleset)],
    {
      phase,
      ruleId: "redirect-alpha.example",
      rulesetId: sourceRuleset.id,
    },
  )

  assert.deepEqual(plan.operations, [])
  assert.match(plan.summary, /already contains Redirect docs/)
})

test("rule editor plans a direct update independently of copy portability", () => {
  const phase = "http_request_sanitize"
  const rule = makeRule("Run sanitizer", {
    action: "execute",
    action_parameters: {
      id: "managed-ruleset-id",
    },
    expression: "true",
    ref: "stable-sanitizer",
  })
  const ruleset = {
    id: "sanitize-entrypoint",
    kind: "zone",
    name: "default",
    phase,
    rules: [rule],
  }
  const zone = ruleZone("alpha.example", ruleset)
  const desired = {
    ...editableRulePayload(rule),
    enabled: false,
  }
  const plan = buildRuleEditPlan(zone, {
    phase,
    ruleId: rule.id,
    rulesetId: ruleset.id,
  }, desired)

  assert.equal(ruleCopyCapability(ruleset, rule).copyable, false)
  assert.equal(plan.operations[0].method, "PATCH")
  assert.equal(
    plan.operations[0].path,
    `zones/zone-alpha.example/rulesets/sanitize-entrypoint/rules/${rule.id}`,
  )
  assert.deepEqual(plan.operations[0].body, desired)
})

test("rule editor strips server fields and rejects endpoint-foreign fields", () => {
  const rule = makeRule("Block scanners", {
    ref: "stable-scanners",
  })

  assert.deepEqual(editableRulePayload(rule), {
    action: "block",
    description: "Block scanners",
    enabled: true,
    expression: "(http.request.uri.path contains \"/wp-admin\")",
    ref: "stable-scanners",
  })

  const ruleset = fleetRuleset({
    rules: [rule],
  })
  const zone = ruleZone("alpha.example", ruleset)
  assert.throws(
    () => buildRuleEditPlan(zone, {
      phase: ruleset.phase,
      ruleId: rule.id,
      rulesetId: ruleset.id,
    }, {
      ...editableRulePayload(rule),
      version: "2",
    }),
    /unsupported fields: version/,
  )
})

test("fleet rule rename preserves each live rule payload and materializes zone names", () => {
  const phase = "http_request_dynamic_redirect"
  const alphaRule = redirectRule("alpha.example", {
    description: "alpha.example docs",
    enabled: false,
  })
  const betaRule = redirectRule("beta.example", {
    action_parameters: {
      from_value: {
        preserve_query_string: false,
        status_code: 302,
        target_url: {
          value: "https://beta.example/handbook",
        },
      },
    },
    description: "beta.example docs",
  })
  const alphaRuleset = {
    id: "alpha-entrypoint",
    kind: "zone",
    name: "default",
    phase,
    rules: [alphaRule],
  }
  const betaRuleset = {
    id: "beta-entrypoint",
    kind: "zone",
    name: "default",
    phase,
    rules: [betaRule],
  }
  const sources = [
    {
      phase,
      ruleId: alphaRule.id,
      rulesetId: alphaRuleset.id,
      zoneId: "zone-alpha.example",
    },
    {
      phase,
      ruleId: betaRule.id,
      rulesetId: betaRuleset.id,
      zoneId: "zone-beta.example",
    },
  ]

  const plans = buildRuleRenamePlans([
    ruleZone("alpha.example", alphaRuleset),
    ruleZone("beta.example", betaRuleset),
  ], sources, "{zone} handbook")

  assert.equal(plans.length, 2)
  assert.deepEqual(plans.map((plan) => plan.operations[0].method), ["PATCH", "PATCH"])
  assert.deepEqual(plans[0].operations[0].body, {
    ...editableRulePayload(alphaRule),
    description: "alpha.example handbook",
  })
  assert.deepEqual(plans[1].operations[0].body, {
    ...editableRulePayload(betaRule),
    description: "beta.example handbook",
  })
})

test("fleet rule rename returns live no-op plans and rejects blank names", () => {
  const phase = "http_request_firewall_custom"
  const rule = makeRule("Shared rule")
  const ruleset = {
    id: "entrypoint",
    kind: "zone",
    name: "default",
    phase,
    rules: [rule],
  }
  const source = {
    phase,
    ruleId: rule.id,
    rulesetId: ruleset.id,
    zoneId: "zone-alpha.example",
  }

  assert.equal(
    buildRuleRenamePlans(
      [ruleZone("alpha.example", ruleset)],
      [source],
      "Shared rule",
    )[0].operations.length,
    0,
  )
  assert.throws(
    () => buildRuleRenamePlans(
      [ruleZone("alpha.example", ruleset)],
      [source],
      " ",
    ),
    /Rule name is required/,
  )
})

test("rule copy updates a unique description collision", () => {
  const phase = "http_request_dynamic_redirect"
  const sourceRuleset = {
    id: "source-entrypoint",
    kind: "zone",
    name: "default",
    phase,
    rules: [redirectRule("alpha.example")],
  }
  const targetRuleset = {
    id: "target-entrypoint",
    kind: "zone",
    name: "default",
    phase,
    rules: [
      redirectRule("beta.example", {
        expression: "http.host eq \"old.beta.example\"",
        id: "old-rule",
        ref: "old-rule",
      }),
    ],
  }

  const [plan] = buildRuleCopyPlans(
    ruleZone("alpha.example", sourceRuleset),
    [ruleZone("beta.example", targetRuleset)],
    {
      phase,
      ruleId: "redirect-alpha.example",
      rulesetId: sourceRuleset.id,
    },
  )

  assert.equal(plan.operations[0].method, "PATCH")
  assert.equal(
    plan.operations[0].path,
    "zones/zone-beta.example/rulesets/target-entrypoint/rules/old-rule",
  )
  assert.equal(plan.operations[0].currentValue.matchedBy, "description")
})

test("rule copy blocks execute dependencies that require remapping", () => {
  const ruleset = {
    id: "sanitize-entrypoint",
    kind: "zone",
    name: "default",
    phase: "http_request_sanitize",
    rules: [
      makeRule("Run sanitizer", {
        action: "execute",
        action_parameters: {
          id: "managed-ruleset-id",
        },
        expression: "true",
      }),
    ],
  }
  const capability = ruleCopyCapability(ruleset, ruleset.rules[0])

  assert.equal(capability.copyable, false)
  assert.match(capability.reason, /dependency remapping/)
  assert.throws(
    () => portableRulePayload(ruleset, ruleset.rules[0], "alpha.example"),
    /dependency remapping/,
  )
})

test("rule copy rejects an append at the known Free plan limit", () => {
  const phase = "http_request_firewall_custom"
  const sourceRuleset = {
    id: "source-entrypoint",
    kind: "zone",
    name: "default",
    phase,
    rules: [makeRule("Source rule")],
  }
  const targetRuleset = {
    id: "target-entrypoint",
    kind: "zone",
    name: "default",
    phase,
    rules: Array.from({ length: 5 }, (_, index) => makeRule(`Existing ${index}`)),
  }

  assert.throws(
    () => buildRuleCopyPlans(
      ruleZone("alpha.example", sourceRuleset),
      [ruleZone("beta.example", targetRuleset)],
      {
        phase,
        ruleId: "id-Source rule",
        rulesetId: sourceRuleset.id,
      },
    ),
    /known Free plan limit is 5/,
  )
})

test("WAF rule copy counts zone custom rulesets toward the plan limit", () => {
  const phase = "http_request_firewall_custom"
  const sourceRuleset = {
    id: "source-entrypoint",
    kind: "zone",
    name: "default",
    phase,
    rules: [makeRule("Source rule")],
  }
  const targetCustomRuleset = {
    id: "target-custom-ruleset",
    kind: "custom",
    name: "shared",
    phase,
    rules: Array.from({ length: 5 }, (_, index) => makeRule(`Existing ${index}`)),
  }

  assert.throws(
    () => buildRuleCopyPlans(
      ruleZone("alpha.example", sourceRuleset),
      [ruleZone("beta.example", targetCustomRuleset)],
      {
        phase,
        ruleId: "id-Source rule",
        rulesetId: sourceRuleset.id,
      },
    ),
    /known Free plan limit is 5/,
  )
})

test("unrelated dependency-backed destination rules do not block an append", () => {
  const phase = "http_request_dynamic_redirect"
  const sourceRuleset = {
    id: "source-entrypoint",
    kind: "zone",
    name: "default",
    phase,
    rules: [redirectRule("alpha.example")],
  }
  const targetRuleset = {
    id: "target-entrypoint",
    kind: "zone",
    name: "default",
    phase,
    rules: [
      makeRule("Dependency-backed rule", {
        action: "execute",
        action_parameters: {
          id: "dependency-id",
        },
        expression: "true",
      }),
    ],
  }

  const [plan] = buildRuleCopyPlans(
    ruleZone("alpha.example", sourceRuleset),
    [ruleZone("beta.example", targetRuleset)],
    {
      phase,
      ruleId: "redirect-alpha.example",
      rulesetId: sourceRuleset.id,
    },
  )

  assert.equal(plan.operations[0].method, "POST")
  assert.equal(
    plan.operations[0].path,
    "zones/zone-beta.example/rulesets/target-entrypoint/rules",
  )
})

test("zone setting plans reject read-only settings", () => {
  const zone = makeZone("alpha.example", {
    settings: [
      {
        editable: false,
        id: "readonly",
        value: "on",
      },
    ],
  })

  assert.throws(
    () => buildZoneSettingPlan(zone, "readonly", "off"),
    /read-only/,
  )
})

test("DNSSEC status plans preserve the requested state without copying generated key fields", () => {
  const zone = makeZone("alpha.example", {
    surfaces: {
      dnssec: ok({
        algorithm: null,
        digest: null,
        status: "disabled",
      }),
    },
  })

  const plan = buildDnssecStatusPlan(zone, "active")

  assert.equal(plan.operations.length, 1)
  assert.equal(plan.operations[0].method, "PATCH")
  assert.equal(plan.operations[0].path, "zones/zone-alpha.example/dnssec")
  assert.deepEqual(plan.operations[0].body, { status: "active" })
  assert.deepEqual(plan.operations[0].currentValue, { status: "disabled" })
})

test("DNSSEC status plans treat an in-flight request as already requested", () => {
  const zone = makeZone("alpha.example", {
    surfaces: {
      dnssec: ok({ status: "pending" }),
    },
  })

  assert.deepEqual(buildDnssecStatusPlan(zone, "active").operations, [])
  assert.throws(
    () => buildDnssecStatusPlan(zone, "pending"),
    /must be active or disabled/,
  )
})

test("zone setting plans preserve the live current value for confirmation", () => {
  const zone = makeZone("alpha.example")
  const plan = buildZoneSettingPlan(zone, "always_use_https", "off")

  assert.equal(plan.operations[0].currentValue, "on")
  assert.deepEqual(plan.operations[0].body, { value: "off" })
})

test("zone setting planner returns a no-op for the live desired value", () => {
  const zone = makeZone("alpha.example")

  assert.deepEqual(
    buildZoneSettingPlan(zone, "always_use_https", "on").operations,
    [],
  )
})

test("ruleset rule lifecycle planners preserve live definitions and order", () => {
  const ruleset = fleetRuleset()
  const zone = makeZone("alpha.example", {
    ruleDetails: [ok(ruleset)],
  })
  const desired = {
    action: "block",
    description: "Temporary disabled rule",
    enabled: false,
    expression: "false",
  }

  const create = buildRuleCreatePlan(zone, ruleset, desired)
  assert.equal(create.operations[0].method, "POST")
  assert.equal(
    create.operations[0].path,
    "zones/zone-alpha.example/rulesets/ruleset-id/rules",
  )
  assert.deepEqual(create.operations[0].body, desired)

  const reorder = buildRuleReorderPlan(
    zone,
    ruleset,
    ruleset.rules[1].id,
    0,
  )
  assert.equal(reorder.operations[0].method, "PATCH")
  assert.deepEqual(reorder.operations[0].body, {
    position: {
      before: ruleset.rules[0].id,
    },
  })
  assert.deepEqual(
    buildRuleReorderPlan(zone, ruleset, ruleset.rules[0].id, 0).operations,
    [],
  )

  const deletion = buildRuleDeletePlan(zone, ruleset, ruleset.rules[0].id)
  assert.equal(deletion.operations[0].method, "DELETE")
  assert.deepEqual(deletion.operations[0].currentValue, {
    position: 1,
    rule: editableRulePayload(ruleset.rules[0]),
  })
})

test("ruleset description updates preserve every writable live rule", () => {
  const ruleset = fleetRuleset({
    description: "Old description",
  })
  const zone = makeZone("alpha.example", {
    ruleDetails: [ok(ruleset)],
  })
  const plan = buildRulesetDescriptionPlan(zone, ruleset, "New description")

  assert.equal(plan.operations[0].method, "PUT")
  assert.deepEqual(plan.operations[0].body, {
    description: "New description",
    rules: ruleset.rules.map(editableRulePayload),
  })
  assert.equal(
    buildRulesetDescriptionPlan(zone, ruleset, "Old description").operations.length,
    0,
  )
})

test("whole ruleset deletion requires an editable empty ruleset", () => {
  const empty = fleetRuleset({
    rules: [],
  })
  const zone = makeZone("alpha.example", {
    ruleDetails: [ok(empty)],
  })
  const plan = buildRulesetDeletePlan(zone, empty)

  assert.equal(plan.operations[0].method, "DELETE")
  assert.equal(
    plan.operations[0].path,
    "zones/zone-alpha.example/rulesets/ruleset-id",
  )
  assert.throws(
    () => buildRulesetDeletePlan(zone, fleetRuleset()),
    /Delete every rule/,
  )
  assert.throws(
    () => buildRuleCreatePlan(zone, {
      ...empty,
      kind: "managed",
    }, {
      action: "block",
      enabled: false,
      expression: "false",
    }),
    /Managed rule definitions/,
  )
  assert.throws(
    () => buildRulesetDeletePlan(zone, {
      ...empty,
      kind: "root",
    }),
    /not editable at the zone level/,
  )
})

test("executePlans preserves plan and operation order", async () => {
  const calls = []
  const api = {
    async executeOperation(operation) {
      calls.push(operation.label)
      return { result: operation.label }
    },
  }
  const plans = [
    {
      operations: [
        { label: "first", method: "PATCH", path: "one" },
        { label: "second", method: "PATCH", path: "two" },
      ],
      zoneName: "alpha.example",
    },
  ]

  const results = await executePlans(api, plans)

  assert.deepEqual(calls, ["first", "second"])
  assert.deepEqual(results.map((entry) => entry.response.result), ["first", "second"])
})
