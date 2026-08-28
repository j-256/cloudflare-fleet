import assert from "node:assert/strict"
import test from "node:test"

import {
  AccessAuthorizationError,
  requestRequiresAccess,
  verifyAccessRequest,
} from "../src/hosted/access.mjs"

const ACCESS_ENV = Object.freeze({
  ACCESS_AUD: "fleet-audience",
  ACCESS_TEAM_DOMAIN: "https://team.cloudflareaccess.com",
})

test("hosted Access verification is skipped only on loopback development", async () => {
  assert.equal(requestRequiresAccess(new Request("http://localhost:8787/")), false)
  assert.equal(requestRequiresAccess(new Request("http://127.0.0.1:8787/")), false)
  assert.equal(requestRequiresAccess(new Request("https://fleet.example/")), true)
  assert.equal(
    await verifyAccessRequest(new Request("http://localhost:8787/"), {}),
    null,
  )
  assert.equal(
    await verifyAccessRequest(
      new Request("https://fleet.example/"),
      { FLEET_LOCAL_DEV: "true" },
    ),
    null,
  )
})

test("hosted Access verification checks the assertion audience and issuer", async () => {
  let captured
  const payload = { email: "operator@example.com" }
  const request = new Request("https://fleet.example/", {
    headers: {
      "Cf-Access-Jwt-Assertion": "signed-token",
    },
  })

  const result = await verifyAccessRequest(request, ACCESS_ENV, {
    jwtVerify: async (token, jwks, options) => {
      captured = { jwks, options, token }
      return { payload }
    },
  })

  assert.deepEqual(result, payload)
  assert.equal(captured.token, "signed-token")
  assert.equal(captured.options.audience, "fleet-audience")
  assert.equal(captured.options.issuer, "https://team.cloudflareaccess.com")
  assert.ok(captured.jwks)
})

test("hosted Access verification fails closed without a valid assertion", async () => {
  await assert.rejects(
    verifyAccessRequest(new Request("https://fleet.example/"), ACCESS_ENV),
    (error) => error instanceof AccessAuthorizationError
      && /assertion is missing/.test(error.message),
  )
  await assert.rejects(
    verifyAccessRequest(new Request("https://fleet.example/", {
      headers: { "Cf-Access-Jwt-Assertion": "invalid" },
    }), ACCESS_ENV, {
      jwtVerify: async () => {
        throw new Error("Rejected")
      },
    }),
    (error) => error instanceof AccessAuthorizationError
      && /assertion is invalid/.test(error.message),
  )
})
