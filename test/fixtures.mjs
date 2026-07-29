export function ok(result) {
  return {
    ok: true,
    result,
    status: 200,
  }
}

export function makeRule(description, overrides = {}) {
  return {
    action: "block",
    description,
    enabled: true,
    expression: "(http.request.uri.path contains \"/wp-admin\")",
    id: `id-${description}`,
    version: "1",
    ...overrides,
  }
}

export function makeZone(name, options = {}) {
  const dns = options.dns ?? [
    {
      content: "\"v=spf1 include:_spf.google.com include:_spf.mx.cloudflare.net -all\"",
      id: `spf-${name}`,
      name,
      ttl: 60,
      type: "TXT",
    },
    {
      content: `"v=DMARC1; p=none; rua=mailto:dmarc@${name};"`,
      id: `dmarc-${name}`,
      name: `_dmarc.${name}`,
      ttl: 60,
      type: "TXT",
    },
  ]
  const email = {
    enabled: true,
    skip_wizard: true,
    status: "unlocked",
    support_subaddress: true,
    ...options.email,
  }
  const catchAll = {
    actions: [
      {
        type: "forward",
        value: [options.destination || "fleet@example.com"],
      },
    ],
    enabled: true,
    matchers: [{ type: "all" }],
    name: "Catch-all to Gmail",
    ...options.catchAll,
  }
  const settings = options.settings || [
    {
      editable: true,
      id: "always_use_https",
      value: "on",
    },
  ]

  return {
    meta: {
      created_on: "2026-07-01T00:00:00Z",
      development_mode: 0,
      id: `zone-${name}`,
      meta: {
        page_rule_quota: 3,
        phishing_detected: false,
        step: 4,
      },
      name,
      paused: false,
      plan: { name: "Free Website" },
      status: "active",
      type: "full",
    },
    ruleDetails: options.ruleDetails || [],
    surfaces: {
      dns: ok(dns),
      email: ok(email),
      "email-catch-all": ok(catchAll),
      "email-dns": ok(options.emailDns || []),
      "email-rules": ok(options.emailRules || []),
      rulesets: ok(options.rulesets || []),
      settings: ok(settings),
      ...options.surfaces,
    },
  }
}

export function makeInventory(zones, options = {}) {
  return {
    account: {
      emailAddresses: ok(options.emailAddresses || [
        {
          email: "fleet@example.com",
          verified: "2026-07-01T00:00:00Z",
        },
      ]),
      id: "account-id",
    },
    loadedAt: "2026-07-29T00:00:00Z",
    zones,
  }
}
