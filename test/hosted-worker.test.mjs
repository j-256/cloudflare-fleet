import assert from "node:assert/strict"
import test from "node:test"

import {
  fetchHostedFleet,
} from "../src/hosted/worker.mjs"
import {
  hostedD1Fixture,
} from "./hosted-d1.fixture.mjs"

const ACCOUNT_ID = "account-one"
const API_TOKEN = "worker-secret-token"

function environment(context, options = {}) {
  return {
    ACCESS_AUD: "fleet-audience",
    ACCESS_TEAM_DOMAIN: "https://team.cloudflareaccess.com",
    ASSETS: {
      fetch: async () => new Response("<h1>Fleet</h1>", {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      }),
    },
    CLOUDFLARE_API_TOKEN: API_TOKEN,
    FLEET_ACCOUNT_ID: ACCOUNT_ID,
    FLEET_DB: hostedD1Fixture(context),
    FLEET_POLICY_JSON: options.policyJson || "",
    FLEET_READ_ONLY: options.readOnly ? "true" : "false",
  }
}

test("hosted Worker bootstrap exposes configuration without secrets", async (context) => {
  const response = await fetchHostedFleet(
    new Request("http://localhost:8787/auth.js"),
    environment(context),
  )
  const source = await response.text()

  assert.equal(response.status, 200)
  assert.equal(source.includes(ACCOUNT_ID), true)
  assert.equal(source.includes("backendBaseUrl"), true)
  assert.equal(source.includes("hosted"), true)
  assert.equal(source.includes(API_TOKEN), false)
  assert.equal(response.headers.get("Cache-Control"), "no-store")
  assert.equal(response.headers.get("X-Frame-Options"), "DENY")
})

test("hosted Worker serves assets with security headers", async (context) => {
  const response = await fetchHostedFleet(
    new Request("http://localhost:8787/index.html"),
    environment(context),
  )

  assert.equal(response.status, 200)
  assert.equal(await response.text(), "<h1>Fleet</h1>")
  assert.equal(response.headers.get("Cache-Control"), "no-cache")
  assert.match(response.headers.get("Content-Security-Policy"), /frame-ancestors 'none'/)
})

test("hosted Worker serves validated operator policy without credentials", async (context) => {
  const env = environment(context, {
    policyJson: JSON.stringify({
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
    }),
  })
  const response = await fetchHostedFleet(
    new Request("http://localhost:8787/policy.js"),
    env,
  )
  const source = await response.text()

  assert.equal(response.status, 200)
  assert.match(source, /special\.example/)
  assert.equal(source.includes(API_TOKEN), false)
})

test("hosted Worker provides revision-safe intent persistence", async (context) => {
  const env = environment(context)
  const initialResponse = await fetchHostedFleet(
    new Request("http://localhost:8787/api/intent"),
    env,
  )
  const initial = (await initialResponse.json()).result
  const saveResponse = await fetchHostedFleet(
    new Request("http://localhost:8787/api/intent", {
      body: JSON.stringify({
        document: initial,
        expectedRevision: initial.revision,
      }),
      headers: {
        "Content-Type": "application/json",
        Origin: "http://localhost:8787",
        "Sec-Fetch-Site": "same-origin",
      },
      method: "PUT",
    }),
    env,
  )
  const saved = (await saveResponse.json()).result
  const conflictResponse = await fetchHostedFleet(
    new Request("http://localhost:8787/api/intent", {
      body: JSON.stringify({
        document: initial,
        expectedRevision: initial.revision,
      }),
      headers: {
        "Content-Type": "application/json",
        Origin: "http://localhost:8787",
      },
      method: "PUT",
    }),
    env,
  )

  assert.equal(saveResponse.status, 200)
  assert.notEqual(saved.revision, initial.revision)
  assert.equal(conflictResponse.status, 409)
  assert.equal((await conflictResponse.json()).result.revision, saved.revision)
})

test("hosted Worker rejects cross-site and read-only mutations", async (context) => {
  const crossSiteResponse = await fetchHostedFleet(
    new Request("http://localhost:8787/api/cache", {
      body: "{}",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://attacker.example",
      },
      method: "POST",
    }),
    environment(context),
  )
  const readOnlyContext = {
    after: context.after.bind(context),
  }
  const readOnlyEnv = environment(readOnlyContext, { readOnly: true })
  const intent = (await (await fetchHostedFleet(
    new Request("http://localhost:8787/api/intent"),
    readOnlyEnv,
  )).json()).result
  const readOnlyResponse = await fetchHostedFleet(
    new Request("http://localhost:8787/api/intent", {
      body: JSON.stringify({ document: intent, expectedRevision: intent.revision }),
      headers: { "Content-Type": "application/json" },
      method: "PUT",
    }),
    readOnlyEnv,
  )

  assert.equal(crossSiteResponse.status, 403)
  assert.equal(readOnlyResponse.status, 403)
})

test("hosted Worker fails closed when Access does not authorize production", async (context) => {
  const response = await fetchHostedFleet(
    new Request("https://fleet.example/index.html"),
    environment(context),
  )

  assert.equal(response.status, 403)
  assert.match((await response.json()).errors[0].message, /assertion is missing/)
})
