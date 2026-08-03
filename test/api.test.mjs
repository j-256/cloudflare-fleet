import assert from "node:assert/strict"
import test from "node:test"

import {
  BROKER_SESSION_HEADER,
  CloudflareApi,
  CloudflareApiError,
  FleetIntentApiConflictError,
  serializeApiError,
} from "../src/api.mjs"

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    headers: {
      "Content-Type": "application/json",
    },
    status,
  })
}

test("listZones paginates and keeps auth out of the URL", async () => {
  const calls = []
  const fetchImpl = async (url, request) => {
    calls.push({ request, url: new URL(url) })
    const page = Number(url.searchParams.get("page"))
    return jsonResponse({
      result: [{ id: `zone-${page}`, name: `zone-${page}.example` }],
      result_info: {
        total_pages: 2,
      },
      success: true,
    })
  }
  const api = new CloudflareApi({
    accountId: "account id",
    apiToken: "secret-token",
    fetchImpl,
  })

  const zones = await api.listZones()

  assert.deepEqual(zones.map((zone) => zone.id), ["zone-1", "zone-2"])
  assert.equal(calls.length, 2)
  assert.equal(calls[0].url.pathname, "/client/v4/zones")
  assert.equal(calls[0].url.searchParams.get("account.id"), "account id")
  assert.equal(calls[0].url.searchParams.get("per_page"), "50")
  assert.equal(calls[1].url.searchParams.get("page"), "2")
  assert.equal(calls[0].request.headers.Authorization, "Bearer secret-token")
  assert.equal(calls[0].url.href.includes("secret-token"), false)
})

test("broker transport keeps the Cloudflare token out of browser requests", async () => {
  let captured
  const api = new CloudflareApi({
    accountId: "account-id",
    brokerBaseUrl: "http://127.0.0.1:43123/session/test/api/",
    brokerSecret: "session-secret",
    fetchImpl: async (url, request) => {
      captured = {
        request,
        url: new URL(url),
      }
      return jsonResponse({
        result: { value: "on" },
        success: true,
      })
    },
  })

  await api.getZoneSetting("zone-id", "always_use_https")

  assert.equal(
    captured.url.href,
    "http://127.0.0.1:43123/session/test/api/cloudflare/zones/zone-id/settings/always_use_https",
  )
  assert.equal(captured.request.headers[BROKER_SESSION_HEADER], "session-secret")
  assert.equal(Object.hasOwn(captured.request.headers, "Authorization"), false)
})

test("broker monitor reports connection and terminal disconnection", async () => {
  let closeStream
  const stream = new ReadableStream({
    start(controller) {
      closeStream = () => controller.close()
    },
  })
  const api = new CloudflareApi({
    accountId: "account-id",
    brokerBaseUrl: "http://127.0.0.1:43123/session/test/api/",
    brokerSecret: "session-secret",
    fetchImpl: async () => new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
      },
    }),
  })
  const events = []
  let connected
  let disconnected
  const connectedPromise = new Promise((resolve) => {
    connected = resolve
  })
  const disconnectedPromise = new Promise((resolve) => {
    disconnected = resolve
  })

  const stop = api.startSessionMonitor({
    onConnected() {
      events.push("connected")
      connected()
    },
    onDisconnected() {
      events.push("disconnected")
      disconnected()
    },
  })

  await connectedPromise
  closeStream()
  await disconnectedPromise
  stop()
  assert.deepEqual(events, ["connected", "disconnected"])
})

test("broker transport loads and persists fleet intent", async () => {
  const calls = []
  const document = {
    accountId: "account-id",
    acknowledgements: [],
    groups: [],
    policies: [],
    revision: "revision-one",
    schemaVersion: 1,
    updatedAt: null,
  }
  const api = new CloudflareApi({
    accountId: "account-id",
    brokerBaseUrl: "http://127.0.0.1:43123/session/test/api/",
    brokerSecret: "session-secret",
    fetchImpl: async (url, request) => {
      calls.push({ request, url: new URL(url) })
      return jsonResponse({
        result: document,
        success: true,
      })
    },
  })

  assert.deepEqual(await api.loadFleetIntent(), document)
  assert.deepEqual(await api.persistFleetIntent(document), document)
  assert.equal(calls[0].url.pathname, "/session/test/api/intent")
  assert.equal(calls[0].request.headers[BROKER_SESSION_HEADER], "session-secret")
  assert.equal(calls[1].request.method, "PUT")
  assert.deepEqual(JSON.parse(calls[1].request.body), {
    document,
    expectedRevision: "revision-one",
  })
})

test("fleet intent persistence exposes revision conflicts", async () => {
  const latest = { revision: "latest" }
  const api = new CloudflareApi({
    accountId: "account-id",
    brokerBaseUrl: "http://127.0.0.1:43123/session/test/api/",
    brokerSecret: "session-secret",
    fetchImpl: async () => jsonResponse({
      errors: [{ message: "Fleet intent changed in another dashboard window" }],
      result: latest,
      success: false,
    }, 409),
  })

  await assert.rejects(
    api.persistFleetIntent({ revision: "stale" }),
    (error) => {
      assert.ok(error instanceof FleetIntentApiConflictError)
      assert.deepEqual(error.currentDocument, latest)
      return true
    },
  )
})

test("broker transport loads, starts, and finalizes operation activity", async () => {
  const calls = []
  const document = {
    entries: [],
    revision: "",
    updatedAt: null,
  }
  const entry = { id: "activity-one" }
  const api = new CloudflareApi({
    accountId: "account-id",
    brokerBaseUrl: "http://127.0.0.1:43123/session/test/api/",
    brokerSecret: "session-secret",
    fetchImpl: async (url, request) => {
      calls.push({ request, url: new URL(url) })
      return jsonResponse({
        result: document,
        success: true,
      })
    },
  })

  assert.deepEqual(await api.loadOperationActivity(), document)
  assert.deepEqual(await api.appendOperationActivity(entry), document)
  assert.deepEqual(await api.finalizeOperationActivity(entry), document)
  assert.deepEqual(calls.map((call) => call.request.method), [undefined, "POST", "PATCH"])
  assert.equal(calls[0].url.pathname, "/session/test/api/activity")
  assert.deepEqual(JSON.parse(calls[1].request.body), { entry })
  assert.equal(calls[2].request.headers[BROKER_SESSION_HEADER], "session-secret")
})

test("direct browser transport keeps fleet intent view-only", async () => {
  const api = new CloudflareApi({
    accountId: "account-id",
    apiToken: "token",
    fetchImpl: async () => {
      throw new Error("Unexpected request")
    },
  })

  await assert.rejects(api.loadFleetIntent(), /requires the loopback session broker/)
  await assert.rejects(
    api.persistFleetIntent({ revision: "" }),
    /requires the loopback session broker/,
  )
  await assert.rejects(
    api.loadOperationActivity(),
    /requires the loopback session broker/,
  )
  await assert.rejects(
    api.appendOperationActivity({}),
    /requires the loopback session broker/,
  )
})

test("broker monitor reports an initial connection failure", async () => {
  const api = new CloudflareApi({
    accountId: "account-id",
    brokerBaseUrl: "http://127.0.0.1:43123/session/test/api/",
    brokerSecret: "session-secret",
    fetchImpl: async () => {
      throw new Error("offline")
    },
  })
  let disconnected
  const disconnectedPromise = new Promise((resolve) => {
    disconnected = resolve
  })

  const stop = api.startSessionMonitor({
    onDisconnected: disconnected,
  })

  await disconnectedPromise
  stop()
})

test("executeOperation serializes a write body", async () => {
  let captured
  const api = new CloudflareApi({
    accountId: "account-id",
    apiToken: "secret-token",
    fetchImpl: async function (url, request) {
      assert.equal(this, globalThis)
      captured = { request, url }
      return jsonResponse({
        result: { value: "on" },
        success: true,
      })
    },
  })

  await api.executeOperation({
    body: { value: "on" },
    method: "PATCH",
    path: "zones/zone-id/settings/always_use_https",
  })

  assert.equal(captured.request.method, "PATCH")
  assert.equal(captured.request.headers["Content-Type"], "application/json")
  assert.equal(captured.request.body, "{\"value\":\"on\"}")
  assert.equal(captured.url.pathname, "/client/v4/zones/zone-id/settings/always_use_https")
})

test("request accepts an empty successful delete response", async () => {
  const api = new CloudflareApi({
    accountId: "account-id",
    apiToken: "secret-token",
    fetchImpl: async () => new Response(null, {
      status: 204,
    }),
  })

  assert.deepEqual(
    await api.request("zones/zone-id/rulesets/ruleset-id", {
      method: "DELETE",
    }),
    {
      result: null,
      resultInfo: null,
      status: 204,
    },
  )
})

test("getZoneSetting reads one live setting", async () => {
  let captured
  const api = new CloudflareApi({
    accountId: "account-id",
    apiToken: "secret-token",
    fetchImpl: async (url, request) => {
      captured = { request, url }
      return jsonResponse({
        result: {
          editable: true,
          id: "always_use_https",
          value: "on",
        },
        success: true,
      })
    },
  })

  const setting = await api.getZoneSetting("zone/id", "setting id")

  assert.equal(setting.value, "on")
  assert.equal(captured.request.method, "GET")
  assert.equal(captured.url.pathname, "/client/v4/zones/zone%2Fid/settings/setting%20id")
})

test("getDnsRecord reads one live record", async () => {
  let captured
  const api = new CloudflareApi({
    accountId: "account-id",
    apiToken: "secret-token",
    fetchImpl: async (url, request) => {
      captured = { request, url }
      return jsonResponse({
        result: {
          content: "192.0.2.1",
          id: "record-id",
          name: "alpha.example",
          ttl: 1,
          type: "A",
        },
        success: true,
      })
    },
  })

  const record = await api.getDnsRecord("zone/id", "record id")

  assert.equal(record.content, "192.0.2.1")
  assert.equal(captured.request.method, "GET")
  assert.equal(captured.url.pathname, "/client/v4/zones/zone%2Fid/dns_records/record%20id")
})

test("request exposes Cloudflare errors without leaking auth", async () => {
  const api = new CloudflareApi({
    accountId: "account-id",
    apiToken: "secret-token",
    fetchImpl: async () => jsonResponse({
      errors: [{ code: 1000, message: "Rejected" }],
      messages: [],
      result: null,
      success: false,
    }, 403),
  })

  await assert.rejects(
    api.request("zones/zone-id/settings"),
    (error) => {
      assert.equal(error instanceof CloudflareApiError, true)
      assert.equal(error.status, 403)
      assert.equal(error.message.includes("Rejected"), true)
      assert.equal(error.message.includes("secret-token"), false)
      assert.deepEqual(serializeApiError(error).errors, [{ code: 1000, message: "Rejected" }])
      return true
    },
  )
})
