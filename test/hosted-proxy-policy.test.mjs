import assert from "node:assert/strict"
import test from "node:test"

import {
  HTTP_METHOD,
  SURFACES,
} from "../src/constants.mjs"
import {
  resolveCloudflareApiUrl,
} from "../src/api.mjs"
import {
  authorizeCloudflareRequest,
} from "../src/hosted/proxy-policy.mjs"
import {
  CloudflareProxyError,
  proxyCloudflareRequest,
} from "../src/hosted/cloudflare-proxy.mjs"

const ACCOUNT_ID = "account-id"
const ZONE_ID = "zone-id"

function decision(method, path) {
  return authorizeCloudflareRequest(
    method,
    resolveCloudflareApiUrl(path),
    ACCOUNT_ID,
  )
}

test("hosted proxy permits every dashboard inventory read", () => {
  assert.equal(decision(
    HTTP_METHOD.GET,
    `zones?account.id=${ACCOUNT_ID}&page=1&per_page=50`,
  ).allowed, true)
  assert.equal(decision(
    HTTP_METHOD.GET,
    `accounts/${ACCOUNT_ID}/email/routing/addresses?page=1&per_page=100`,
  ).allowed, true)
  assert.equal(decision(
    HTTP_METHOD.GET,
    `accounts/${ACCOUNT_ID}/workers/domains?per_page=1000`,
  ).allowed, true)
  assert.equal(decision(
    HTTP_METHOD.GET,
    `accounts/${ACCOUNT_ID}/pages/projects`,
  ).allowed, true)
  for (const surface of SURFACES) {
    assert.equal(
      decision(HTTP_METHOD.GET, surface.path(ZONE_ID)).allowed,
      true,
      surface.id,
    )
  }
  for (const path of [
    `zones/${ZONE_ID}/settings/always_use_https`,
    `zones/${ZONE_ID}/dns_records/record-id`,
    `zones/${ZONE_ID}/email/routing/rules/rule-id`,
    `zones/${ZONE_ID}/rulesets/ruleset-id`,
  ]) {
    assert.equal(decision(HTTP_METHOD.GET, path).allowed, true, path)
  }
})

test("hosted proxy permits only Fleet write shapes", () => {
  const allowed = [
    [HTTP_METHOD.PATCH, `zones/${ZONE_ID}/settings/always_use_https`],
    [HTTP_METHOD.PATCH, `zones/${ZONE_ID}/dnssec`],
    [HTTP_METHOD.POST, `zones/${ZONE_ID}/dns_records`],
    [HTTP_METHOD.PATCH, `zones/${ZONE_ID}/dns_records/record-id`],
    [HTTP_METHOD.PUT, `zones/${ZONE_ID}/dns_records/record-id`],
    [HTTP_METHOD.DELETE, `zones/${ZONE_ID}/dns_records/record-id`],
    [HTTP_METHOD.POST, `zones/${ZONE_ID}/email/routing/dns`],
    [HTTP_METHOD.PATCH, `zones/${ZONE_ID}/email/routing/dns`],
    [HTTP_METHOD.PATCH, `zones/${ZONE_ID}/email/routing`],
    [HTTP_METHOD.PUT, `zones/${ZONE_ID}/email/routing/rules/catch_all`],
    [HTTP_METHOD.POST, `zones/${ZONE_ID}/rulesets`],
    [HTTP_METHOD.PUT, `zones/${ZONE_ID}/rulesets/ruleset-id`],
    [HTTP_METHOD.DELETE, `zones/${ZONE_ID}/rulesets/ruleset-id`],
    [HTTP_METHOD.POST, `zones/${ZONE_ID}/rulesets/ruleset-id/rules`],
    [HTTP_METHOD.PATCH, `zones/${ZONE_ID}/rulesets/ruleset-id/rules/rule-id`],
    [HTTP_METHOD.DELETE, `zones/${ZONE_ID}/rulesets/ruleset-id/rules/rule-id`],
  ]
  for (const [method, path] of allowed) {
    const result = decision(method, path)
    assert.equal(result.allowed, true, `${method} ${path}`)
    assert.equal(result.zoneId, ZONE_ID)
  }
})

test("hosted proxy rejects broader account and API access", () => {
  const blocked = [
    [HTTP_METHOD.GET, "graphql"],
    [HTTP_METHOD.POST, "graphql"],
    [HTTP_METHOD.GET, `accounts/${ACCOUNT_ID}/workers/scripts`],
    [HTTP_METHOD.GET, "zones?account.id=another-account"],
    [HTTP_METHOD.GET, `zones/${ZONE_ID}/settings?direction=desc`],
    [HTTP_METHOD.DELETE, `zones/${ZONE_ID}/dns_records`],
    [HTTP_METHOD.PATCH, `zones/${ZONE_ID}/workers/routes/route-id`],
    [HTTP_METHOD.POST, `zones/${ZONE_ID}/rulesets?unsafe=true`],
    [HTTP_METHOD.GET, `zones/${ZONE_ID}/%2e%2e/accounts`],
  ]
  for (const [method, path] of blocked) {
    assert.equal(decision(method, path).allowed, false, `${method} ${path}`)
  }
})

test("hosted proxy invokes Worker fetch without a foreign receiver", async () => {
  let receiver
  const response = await proxyCloudflareRequest(new Request(
    `https://fleet.example/api/cloudflare/zones?account.id=${ACCOUNT_ID}`,
  ), {
    accountId: ACCOUNT_ID,
    apiToken: "secret-token",
    fetchImpl(input) {
      receiver = this
      assert.equal(input.href, `https://api.cloudflare.com/client/v4/zones?account.id=${ACCOUNT_ID}`)
      return Promise.resolve(new Response(JSON.stringify({
        result: [],
        success: true,
      }), {
        headers: { "Content-Type": "application/json" },
      }))
    },
    readOnly: false,
  })

  assert.equal(response.status, 200)
  assert.equal(receiver, undefined)
})

test("hosted proxy rejects upstream redirects explicitly", async () => {
  await assert.rejects(
    proxyCloudflareRequest(new Request(
      `https://fleet.example/api/cloudflare/zones?account.id=${ACCOUNT_ID}`,
    ), {
      accountId: ACCOUNT_ID,
      apiToken: "secret-token",
      fetchImpl: async () => new Response(null, {
        headers: { Location: "https://attacker.example/" },
        status: 302,
      }),
      readOnly: false,
    }),
    (error) => error instanceof CloudflareProxyError
      && error.status === 502
      && /redirects are not allowed/.test(error.message),
  )
})

test("hosted proxy preserves Retry-After without forwarding unrelated upstream headers", async () => {
  const body = JSON.stringify({ errors: [{ message: "Rate limited" }], success: false })
  for (const retryAfter of ["30", "Sun, 06 Sep 2026 12:00:00 GMT", null]) {
    const response = await proxyCloudflareRequest(new Request(
      `https://fleet.example/api/cloudflare/zones?account.id=${ACCOUNT_ID}`,
    ), {
      accountId: ACCOUNT_ID,
      apiToken: "secret-token",
      fetchImpl: async () => new Response(body, {
        headers: {
          "Content-Type": "application/json",
          ...(retryAfter === null ? {} : { "Retry-After": retryAfter }),
          "Set-Cookie": "upstream-session=private",
          "X-Upstream-Private": "private",
        },
        status: 429,
      }),
      readOnly: true,
    })

    assert.equal(response.status, 429)
    assert.equal(response.headers.get("Retry-After"), retryAfter)
    assert.equal(response.headers.get("Set-Cookie"), null)
    assert.equal(response.headers.get("X-Upstream-Private"), null)
    assert.equal(response.headers.get("Cache-Control"), "no-store")
    assert.equal(await response.text(), body)
  }
})
