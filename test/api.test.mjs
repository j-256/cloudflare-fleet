import assert from "node:assert/strict"
import test from "node:test"

import {
  BROKER_SESSION_HEADER,
  CloudflareApi,
  CloudflareApiError,
  FleetIntentApiConflictError,
  serializeApiError,
} from "../src/api.mjs"

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
    status,
  })
}

function throttledResponse(retryAfter = "0") {
  return jsonResponse({
    errors: [{ message: "Please wait and consider throttling your request speed" }],
    result: null,
    success: false,
  }, 429, {
    "Retry-After": retryAfter,
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

test("read requests honor Retry-After and recover from throttling", async () => {
  let calls = 0
  const api = new CloudflareApi({
    accountId: "account-id",
    apiToken: "secret-token",
    fetchImpl: async () => {
      calls += 1
      return calls === 1
        ? throttledResponse()
        : jsonResponse({ result: { value: "on" }, success: true })
    },
  })

  const response = await api.request("zones/zone-one/settings/always_use_https")

  assert.equal(calls, 2)
  assert.deepEqual(response.result, { value: "on" })
})

test("read requests stop after the bounded throttle retry budget", async () => {
  let calls = 0
  const api = new CloudflareApi({
    accountId: "account-id",
    apiToken: "secret-token",
    fetchImpl: async () => {
      calls += 1
      return throttledResponse()
    },
  })

  await assert.rejects(
    api.request("zones/zone-one/settings"),
    (error) => error instanceof CloudflareApiError && error.status === 429,
  )
  assert.equal(calls, 4)
})

test("mutating requests are not retried after throttling", async () => {
  let calls = 0
  const api = new CloudflareApi({
    accountId: "account-id",
    apiToken: "secret-token",
    fetchImpl: async () => {
      calls += 1
      return throttledResponse()
    },
  })

  await assert.rejects(
    api.request("zones/zone-one/settings/always_use_https", {
      body: { value: "on" },
      method: "PATCH",
    }),
    (error) => error instanceof CloudflareApiError && error.status === 429,
  )
  assert.equal(calls, 1)
})

test("graphql sends variables securely and returns the data envelope", async () => {
  let captured
  const api = new CloudflareApi({
    accountId: "account-id",
    apiToken: "secret-token",
    fetchImpl: async (url, request) => {
      captured = { request, url: new URL(url) }
      return jsonResponse({
        data: { viewer: { accounts: [] } },
        errors: null,
      })
    },
  })
  const query = "query Audit($accountTag: string) { viewer { accounts { id } } }"
  const variables = { accountTag: "account-id" }

  const data = await api.graphql(query, variables)

  assert.deepEqual(data, { viewer: { accounts: [] } })
  assert.equal(captured.url.pathname, "/client/v4/graphql")
  assert.equal(captured.url.href.includes("secret-token"), false)
  assert.equal(captured.request.method, "POST")
  assert.equal(captured.request.headers.Authorization, "Bearer secret-token")
  assert.deepEqual(JSON.parse(captured.request.body), { query, variables })
})

test("graphql exposes Cloudflare errors without leaking auth", async () => {
  const api = new CloudflareApi({
    accountId: "account-id",
    apiToken: "secret-token",
    fetchImpl: async () => jsonResponse({
      data: null,
      errors: [{ message: "Analytics permission denied" }],
    }),
  })

  await assert.rejects(
    api.graphql("query Audit { viewer { accounts { id } } }"),
    (error) => {
      assert.ok(error instanceof CloudflareApiError)
      assert.match(error.message, /Analytics permission denied/)
      assert.equal(error.message.includes("secret-token"), false)
      return true
    },
  )
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

test("hosted transport uses the same-origin backend without browser credentials", async () => {
  const calls = []
  const api = new CloudflareApi({
    accountId: "account-id",
    backendBaseUrl: "https://fleet.example/api/",
    fetchImpl: async (url, request) => {
      calls.push({ request, url: new URL(url) })
      return jsonResponse({
        result: { revision: "revision-one" },
        success: true,
      })
    },
  })

  await api.getZoneSetting("zone-id", "always_use_https")
  await api.loadFleetIntent()

  assert.equal(
    calls[0].url.href,
    "https://fleet.example/api/cloudflare/zones/zone-id/settings/always_use_https",
  )
  assert.equal(calls[1].url.href, "https://fleet.example/api/intent")
  assert.equal(api.usesBackend, true)
  assert.equal(api.usesBroker, false)
  for (const call of calls) {
    assert.equal(Object.hasOwn(call.request.headers, "Authorization"), false)
    assert.equal(Object.hasOwn(call.request.headers, BROKER_SESSION_HEADER), false)
  }
})

test("request rejects paths outside the Cloudflare API boundary before sending auth", async () => {
  let calls = 0
  const api = new CloudflareApi({
    accountId: "account-id",
    apiToken: "secret-token",
    fetchImpl: async () => {
      calls += 1
      throw new Error("Unexpected request")
    },
  })

  for (const path of [
    "https://attacker.example/collect",
    "../user/tokens/verify",
    "%2e%2e/user/tokens/verify",
    "\\\\attacker.example/collect",
  ]) {
    await assert.rejects(
      api.request(path),
      /Cloudflare path is outside the API boundary/,
    )
  }

  assert.equal(calls, 0)
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

test("broker monitor reconnects after a transient liveness disconnect", async () => {
  let closeFirstStream
  let fetchCount = 0
  const api = new CloudflareApi({
    accountId: "account-id",
    brokerBaseUrl: "http://127.0.0.1:43123/session/test/api/",
    brokerSecret: "session-secret",
    fetchImpl: async () => {
      fetchCount += 1
      const attempt = fetchCount
      const stream = new ReadableStream({
        start(controller) {
          if (attempt === 1) closeFirstStream = () => controller.close()
        },
      })
      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
        },
      })
    },
  })
  const events = []
  let firstConnected
  let reconnected
  const firstConnectedPromise = new Promise((resolve) => {
    firstConnected = resolve
  })
  const reconnectedPromise = new Promise((resolve) => {
    reconnected = resolve
  })

  const stop = api.startSessionMonitor({
    onConnected() {
      events.push("connected")
      if (events.length === 1) firstConnected()
      else reconnected()
    },
    onDisconnected() {
      events.push("disconnected")
    },
    retryMs: 0,
  })

  await firstConnectedPromise
  closeFirstStream()
  await reconnectedPromise
  stop()
  assert.equal(fetchCount, 2)
  assert.deepEqual(events, ["connected", "disconnected", "connected"])
})

test("broker monitor cancels its active stream without reporting a failure", async () => {
  let cancelStream
  let fetchCount = 0
  const cancelled = new Promise((resolve) => {
    cancelStream = resolve
  })
  const stream = new ReadableStream({
    cancel() {
      cancelStream()
    },
  })
  const api = new CloudflareApi({
    accountId: "account-id",
    brokerBaseUrl: "http://127.0.0.1:43123/session/test/api/",
    brokerSecret: "session-secret",
    fetchImpl: async () => {
      fetchCount += 1
      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
        },
      })
    },
  })
  const events = []
  let connected
  const connectedPromise = new Promise((resolve) => {
    connected = resolve
  })

  const stop = api.startSessionMonitor({
    onConnected() {
      events.push("connected")
      connected()
    },
    onDisconnected() {
      events.push("disconnected")
    },
  })

  await connectedPromise
  stop()
  await cancelled
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(fetchCount, 1)
  assert.deepEqual(events, ["connected"])
})

test("broker monitor stops cleanly from its initial retry boundary", async () => {
  let fetchCount = 0
  let stop
  let disconnected
  const disconnectedPromise = new Promise((resolve) => {
    disconnected = resolve
  })
  const api = new CloudflareApi({
    accountId: "account-id",
    brokerBaseUrl: "http://127.0.0.1:43123/session/test/api/",
    brokerSecret: "session-secret",
    fetchImpl: async () => {
      fetchCount += 1
      throw new Error("offline")
    },
  })

  stop = api.startSessionMonitor({
    onDisconnected() {
      stop()
      disconnected()
    },
    retryMs: 1000,
  })

  await disconnectedPromise
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(fetchCount, 1)
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

  await assert.rejects(api.loadFleetIntent(), /requires a protected backend/)
  await assert.rejects(
    api.persistFleetIntent({ revision: "" }),
    /requires a protected backend/,
  )
  await assert.rejects(
    api.loadOperationActivity(),
    /requires a protected backend/,
  )
  await assert.rejects(
    api.appendOperationActivity({}),
    /requires a protected backend/,
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
