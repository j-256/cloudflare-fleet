import assert from "node:assert/strict"
import { promises as fs } from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import {
  BROKER_SESSION_HEADER,
} from "../src/api.mjs"
import {
  createCacheRecord,
} from "../src/cache.mjs"
import {
  readNewestCacheRecord,
} from "../src/cache-store.mjs"
import {
  readOperationActivityDocument,
} from "../src/activity-store.mjs"
import {
  createEmptyFleetIntentDocument,
  FLEET_INTENT_GROUP_NAME_SOURCE,
} from "../src/fleet-intent.mjs"
import {
  readFleetIntentDocument,
} from "../src/intent-store.mjs"
import {
  completeOperationActivity,
  createPendingOperationActivity,
  OPERATION_ACTIVITY_STATUS,
} from "../src/operation-history.mjs"
import {
  readAndRemoveBrokerConfig,
  startSessionBroker,
  validateBrokerConfig,
} from "../src/session-broker.mjs"
import {
  makeInventory,
  makeZone,
} from "./fixtures.mjs"

async function brokerFixture(options = {}) {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "cloudflare-fleet-broker-test."),
  )
  const runtimeDir = path.join(root, "cloudflare-fleet.runtime")
  const cacheDir = path.join(root, "cache")
  const stateFile = path.join(root, "state.json")
  await fs.mkdir(cacheDir)
  await fs.mkdir(path.join(runtimeDir, "src"), {
    recursive: true,
  })
  await fs.writeFile(
    path.join(runtimeDir, "index.html"),
    "<!doctype html><title>Fleet test</title>\n",
  )
  await fs.writeFile(path.join(runtimeDir, "styles.css"), "\n")
  await fs.writeFile(path.join(runtimeDir, "cache.js"), "\n")
  await fs.writeFile(path.join(runtimeDir, "intent.js"), "\n")
  await fs.writeFile(path.join(runtimeDir, "policy.js"), "\n")
  const calls = []
  const broker = await startSessionBroker({
    accountId: "account-id",
    apiToken: "cloudflare-token",
    cacheDir,
    cloudflareFetch: async (url, request) => {
      calls.push({
        request,
        url: new URL(url),
      })
      return new Response(JSON.stringify({
        result: { value: "on" },
        success: true,
      }), {
        headers: {
          "Content-Type": "application/json",
        },
        status: 200,
      })
    },
    readOnly: false,
    runtimeDir,
    sessionId: "test-session",
    sessionSecret: "session-secret",
    stateFile,
    ...options,
  })
  return {
    broker,
    cacheDir,
    calls,
    root,
    stateFile,
  }
}

test("session broker removes its one-time config before parsing it", async (context) => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "cloudflare-fleet-broker-config-test."),
  )
  context.after(() => fs.rm(root, { force: true, recursive: true }))
  const validPath = path.join(root, "valid.json")
  const invalidPath = path.join(root, "invalid.json")
  await fs.writeFile(validPath, '{"apiToken":"secret"}\n', { mode: 0o600 })
  await fs.writeFile(invalidPath, '{"apiToken":', { mode: 0o600 })

  assert.deepEqual(
    await readAndRemoveBrokerConfig(validPath),
    { apiToken: "secret" },
  )
  await assert.rejects(readAndRemoveBrokerConfig(invalidPath), SyntaxError)
  await assert.rejects(fs.stat(validPath), { code: "ENOENT" })
  await assert.rejects(fs.stat(invalidPath), { code: "ENOENT" })
})

test("session broker binds runtime cleanup to its service session", () => {
  const config = {
    runtimeBase: "/tmp",
    runtimeDir: "/tmp/cloudflare-fleet.abc123",
    serviceTarget: "gui/501/app.cloudflare-fleet.broker.abc123",
    sessionId: "abc123",
  }

  assert.doesNotThrow(() => validateBrokerConfig(config))
  assert.throws(
    () => validateBrokerConfig({
      ...config,
      runtimeDir: "/tmp/cloudflare-fleet.other",
    }),
    /runtime path is invalid/,
  )
  assert.throws(
    () => validateBrokerConfig({
      ...config,
      serviceTarget: "gui/501/app.cloudflare-fleet.broker.other",
    }),
    /service target is invalid/,
  )
})

async function closeFixture(fixture) {
  if (fixture.broker.server.listening) {
    fixture.broker.close()
    await fixture.broker.closed
  }
  await fs.rm(fixture.root, {
    force: true,
    recursive: true,
  })
}

test("session broker serves assets and proxies authorized same-origin API calls", async () => {
  const fixture = await brokerFixture()
  try {
    const page = await fetch(fixture.broker.sessionUrl)
    assert.equal(page.status, 200)
    assert.match(await page.text(), /Fleet test/)

    const auth = await fetch(
      new URL("auth.js", fixture.broker.sessionUrl),
      {
        headers: {
          "Sec-Fetch-Site": "same-origin",
        },
      },
    )
    const authBody = await auth.text()
    assert.equal(auth.status, 200)
    assert.match(authBody, /session-secret/)
    assert.equal(authBody.includes("cloudflare-token"), false)

    const crossSiteAuth = await fetch(
      new URL("auth.js", fixture.broker.sessionUrl),
      {
        headers: {
          "Sec-Fetch-Site": "cross-site",
        },
      },
    )
    assert.equal(crossSiteAuth.status, 403)

    const apiUrl = new URL(
      "api/cloudflare/zones/zone-id/settings/always_use_https",
      fixture.broker.sessionUrl,
    )
    const unauthorized = await fetch(apiUrl)
    assert.equal(unauthorized.status, 403)

    const proxied = await fetch(apiUrl, {
      headers: {
        [BROKER_SESSION_HEADER]: "session-secret",
        Origin: fixture.broker.origin,
      },
    })
    assert.equal(proxied.status, 200)
    assert.equal(fixture.calls.length, 1)
    assert.equal(
      fixture.calls[0].url.href,
      "https://api.cloudflare.com/client/v4/zones/zone-id/settings/always_use_https",
    )
    assert.equal(
      fixture.calls[0].request.headers.Authorization,
      "Bearer cloudflare-token",
    )
  } finally {
    await closeFixture(fixture)
  }
})

test("session broker rejects proxy targets outside the Cloudflare API boundary", async () => {
  const fixture = await brokerFixture()
  try {
    const response = await fetch(
      new URL(
        "api/cloudflare/https://attacker.example/collect",
        fixture.broker.sessionUrl,
      ),
      {
        headers: {
          [BROKER_SESSION_HEADER]: "session-secret",
          Origin: fixture.broker.origin,
        },
      },
    )

    assert.equal(response.status, 400)
    assert.match(
      (await response.json()).errors[0].message,
      /outside the API boundary/,
    )
    assert.equal(fixture.calls.length, 0)
  } finally {
    await closeFixture(fixture)
  }
})

test("session broker rejects oversized request bodies explicitly", async () => {
  const fixture = await brokerFixture()
  try {
    const response = await fetch(
      new URL("api/intent", fixture.broker.sessionUrl),
      {
        body: "x".repeat((2 * 1024 * 1024) + 1),
        headers: {
          "Content-Type": "application/json",
          [BROKER_SESSION_HEADER]: "session-secret",
          Origin: fixture.broker.origin,
        },
        method: "PUT",
      },
    )
    const envelope = await response.json()

    assert.equal(response.status, 413)
    assert.equal(envelope.errors[0].message, "Request body is too large")
  } finally {
    await closeFixture(fixture)
  }
})

test("session broker times out stalled Cloudflare requests", async () => {
  let upstreamSignal
  const fixture = await brokerFixture({
    cloudflareFetch: async (_url, request) => {
      upstreamSignal = request.signal
      await new Promise((resolve, reject) => {
        request.signal.addEventListener("abort", () => {
          reject(new Error("aborted"))
        }, { once: true })
      })
    },
    cloudflareRequestTimeoutMs: 20,
  })
  try {
    const response = await fetch(
      new URL("api/cloudflare/zones", fixture.broker.sessionUrl),
      {
        headers: {
          [BROKER_SESSION_HEADER]: "session-secret",
          Origin: fixture.broker.origin,
        },
      },
    )

    assert.equal(response.status, 504)
    assert.match(
      (await response.json()).errors[0].message,
      /Cloudflare request timed out/,
    )
    assert.equal(upstreamSignal.aborted, true)
  } finally {
    await closeFixture(fixture)
  }
})

test("session broker aborts Cloudflare work after the browser request closes", async () => {
  let resolveAborted
  let resolveStarted
  const aborted = new Promise((resolve) => {
    resolveAborted = resolve
  })
  const started = new Promise((resolve) => {
    resolveStarted = resolve
  })
  const fixture = await brokerFixture({
    cloudflareFetch: async (_url, request) => {
      resolveStarted()
      await new Promise((resolve, reject) => {
        request.signal.addEventListener("abort", () => {
          resolveAborted()
          reject(new Error("aborted"))
        }, { once: true })
      })
    },
    cloudflareRequestTimeoutMs: 1000,
  })
  const controller = new AbortController()
  try {
    const request = fetch(
      new URL("api/cloudflare/zones", fixture.broker.sessionUrl),
      {
        headers: {
          [BROKER_SESSION_HEADER]: "session-secret",
          Origin: fixture.broker.origin,
        },
        signal: controller.signal,
      },
    ).catch(() => null)
    await started
    controller.abort()
    await Promise.race([
      aborted,
      new Promise((resolve, reject) => {
        setTimeout(() => reject(new Error("Upstream request was not aborted")), 500)
      }),
    ])
    await request
  } finally {
    controller.abort()
    await closeFixture(fixture)
  }
})

test("session broker defaults to the runtime fetch transport", async () => {
  const clientFetch = globalThis.fetch
  let cloudflareCall
  let fixture
  globalThis.fetch = async (url, request) => {
    cloudflareCall = {
      request,
      url: new URL(url),
    }
    return new Response(JSON.stringify({
      result: [{ id: "zone-id", name: "alpha.example" }],
      result_info: {
        page: 1,
        total_pages: 1,
      },
      success: true,
    }), {
      headers: {
        "Content-Type": "application/json",
      },
      status: 200,
    })
  }

  try {
    fixture = await brokerFixture({
      cloudflareFetch: undefined,
    })
    const response = await clientFetch(
      new URL(
        "api/cloudflare/zones?account.id=account-id&page=1&per_page=50",
        fixture.broker.sessionUrl,
      ),
      {
        headers: {
          [BROKER_SESSION_HEADER]: "session-secret",
          Origin: fixture.broker.origin,
        },
      },
    )

    assert.equal(response.status, 200)
    assert.equal(
      cloudflareCall.url.href,
      "https://api.cloudflare.com/client/v4/zones?account.id=account-id&page=1&per_page=50",
    )
    assert.equal(
      cloudflareCall.request.headers.Authorization,
      "Bearer cloudflare-token",
    )
  } finally {
    globalThis.fetch = clientFetch
    if (fixture) await closeFixture(fixture)
  }
})

test("session broker validates and persists completed browser snapshots", async () => {
  const fixture = await brokerFixture()
  try {
    const record = createCacheRecord(
      "account-id",
      makeInventory([makeZone("alpha.example")]),
    )
    const response = await fetch(
      new URL("api/cache", fixture.broker.sessionUrl),
      {
        body: JSON.stringify(record),
        headers: {
          "Content-Type": "application/json",
          [BROKER_SESSION_HEADER]: "session-secret",
          Origin: fixture.broker.origin,
        },
        method: "POST",
      },
    )

    assert.equal(response.status, 200)
    assert.deepEqual(
      await readNewestCacheRecord(fixture.cacheDir, "account-id"),
      record,
    )
  } finally {
    await closeFixture(fixture)
  }
})

test("read-only session broker rejects Cloudflare writes", async () => {
  const fixture = await brokerFixture({
    readOnly: true,
  })
  try {
    const response = await fetch(
      new URL(
        "api/cloudflare/zones/zone-id/settings/always_use_https",
        fixture.broker.sessionUrl,
      ),
      {
        body: JSON.stringify({ value: "on" }),
        headers: {
          "Content-Type": "application/json",
          [BROKER_SESSION_HEADER]: "session-secret",
          Origin: fixture.broker.origin,
        },
        method: "PATCH",
      },
    )

    assert.equal(response.status, 403)
    assert.equal(fixture.calls.length, 0)
  } finally {
    await closeFixture(fixture)
  }
})

test("session broker reads and writes authorized fleet intent", async () => {
  const fixture = await brokerFixture()
  try {
    const url = new URL("api/intent", fixture.broker.sessionUrl)
    const headers = {
      "Content-Type": "application/json",
      [BROKER_SESSION_HEADER]: "session-secret",
      Origin: fixture.broker.origin,
    }
    const initialResponse = await fetch(url, { headers })
    const initial = (await initialResponse.json()).result
    assert.deepEqual(initial, createEmptyFleetIntentDocument("account-id"))

    initial.groups.push({
      id: "primary-zones",
      members: [{ zoneId: "zone-a", zoneName: "a.example" }],
      mode: "members",
      name: "Primary zones",
      nameSource: FLEET_INTENT_GROUP_NAME_SOURCE.CUSTOM,
    })
    const savedResponse = await fetch(url, {
      body: JSON.stringify({
        document: initial,
        expectedRevision: initial.revision,
      }),
      headers,
      method: "PUT",
    })
    const saved = (await savedResponse.json()).result

    assert.equal(savedResponse.status, 200)
    assert.deepEqual(
      await readFleetIntentDocument(fixture.stateFile, "account-id"),
      saved,
    )
    assert.equal(
      (await fs.readdir(fixture.cacheDir)).some((entry) => entry.startsWith("intent-")),
      false,
    )
  } finally {
    await closeFixture(fixture)
  }
})

test("session broker starts and finalizes durable operation activity", async () => {
  const fixture = await brokerFixture()
  try {
    const url = new URL("api/activity", fixture.broker.sessionUrl)
    const headers = {
      "Content-Type": "application/json",
      [BROKER_SESSION_HEADER]: "session-secret",
      Origin: fixture.broker.origin,
    }
    const initialResponse = await fetch(url, { headers })
    const initial = (await initialResponse.json()).result
    assert.deepEqual(initial.entries, [])

    const pending = createPendingOperationActivity(
      "Update zone setting",
      {
        plans: [{
          id: "plan-one",
          kind: "setting",
          operations: [{
            body: { value: "on" },
            currentValue: "off",
            label: "Set always_use_https",
            method: "PATCH",
            path: "zones/zone-one/settings/always_use_https",
          }],
          summary: "Update always_use_https on alpha.example",
          zoneId: "zone-one",
          zoneName: "alpha.example",
        }],
        validatedAt: "2026-08-03T03:00:00.000Z",
      },
      {
        id: "activity-one",
        startedAt: "2026-08-03T03:00:00.000Z",
      },
    )
    const malformed = structuredClone(pending)
    malformed.plans[0].operations[0].method = "GET"
    const malformedResponse = await fetch(url, {
      body: JSON.stringify({ entry: malformed }),
      headers,
      method: "POST",
    })
    assert.equal(malformedResponse.status, 400)
    const startResponse = await fetch(url, {
      body: JSON.stringify({ entry: pending }),
      headers,
      method: "POST",
    })
    assert.equal(startResponse.status, 200)

    const completed = completeOperationActivity(pending, {
      completedAt: "2026-08-03T03:01:00.000Z",
      execution: { completed: 1, total: 1 },
      inverse: { available: false, plans: [], reason: "Test" },
      status: OPERATION_ACTIVITY_STATUS.VERIFIED,
      verification: [],
    })
    const finishResponse = await fetch(url, {
      body: JSON.stringify({ entry: completed }),
      headers,
      method: "PATCH",
    })
    assert.equal(finishResponse.status, 200)
    assert.deepEqual(
      (await readOperationActivityDocument(fixture.stateFile, "account-id"))
        .entries[0],
      completed,
    )
  } finally {
    await closeFixture(fixture)
  }
})

test("read-only session broker rejects operation activity writes", async () => {
  const fixture = await brokerFixture({
    readOnly: true,
  })
  try {
    const url = new URL("api/activity", fixture.broker.sessionUrl)
    const headers = {
      "Content-Type": "application/json",
      [BROKER_SESSION_HEADER]: "session-secret",
      Origin: fixture.broker.origin,
    }
    for (const method of ["POST", "PATCH"]) {
      const response = await fetch(url, {
        body: JSON.stringify({}),
        headers,
        method,
      })

      assert.equal(response.status, 403)
    }
  } finally {
    await closeFixture(fixture)
  }
})

test("session broker returns the latest intent on revision conflict", async () => {
  const fixture = await brokerFixture()
  try {
    const url = new URL("api/intent", fixture.broker.sessionUrl)
    const headers = {
      "Content-Type": "application/json",
      [BROKER_SESSION_HEADER]: "session-secret",
      Origin: fixture.broker.origin,
    }
    const original = createEmptyFleetIntentDocument("account-id")
    const firstResponse = await fetch(url, {
      body: JSON.stringify({
        document: original,
        expectedRevision: "",
      }),
      headers,
      method: "PUT",
    })
    const saved = (await firstResponse.json()).result
    const conflictResponse = await fetch(url, {
      body: JSON.stringify({
        document: original,
        expectedRevision: "",
      }),
      headers,
      method: "PUT",
    })
    const conflict = await conflictResponse.json()

    assert.equal(conflictResponse.status, 409)
    assert.deepEqual(conflict.result, saved)
    assert.match(conflict.errors[0].message, /another dashboard window/)
  } finally {
    await closeFixture(fixture)
  }
})

test("read-only session broker rejects fleet intent writes", async () => {
  const fixture = await brokerFixture({
    readOnly: true,
  })
  try {
    const document = createEmptyFleetIntentDocument("account-id")
    const response = await fetch(
      new URL("api/intent", fixture.broker.sessionUrl),
      {
        body: JSON.stringify({
          document,
          expectedRevision: document.revision,
        }),
        headers: {
          "Content-Type": "application/json",
          [BROKER_SESSION_HEADER]: "session-secret",
          Origin: fixture.broker.origin,
        },
        method: "PUT",
      },
    )

    assert.equal(response.status, 403)
  } finally {
    await closeFixture(fixture)
  }
})

test("session broker forwards delete operations without a request body", async () => {
  const fixture = await brokerFixture()
  try {
    const response = await fetch(
      new URL(
        "api/cloudflare/zones/zone-id/rulesets/ruleset-id/rules/rule-id",
        fixture.broker.sessionUrl,
      ),
      {
        headers: {
          [BROKER_SESSION_HEADER]: "session-secret",
          Origin: fixture.broker.origin,
        },
        method: "DELETE",
      },
    )

    assert.equal(response.status, 200)
    assert.equal(fixture.calls.length, 1)
    assert.equal(fixture.calls[0].request.method, "DELETE")
    assert.equal(fixture.calls[0].request.body, undefined)
  } finally {
    await closeFixture(fixture)
  }
})

test("session broker exits after its last dashboard connection closes", async () => {
  const fixture = await brokerFixture({
    shutdownGraceMs: 20,
  })
  let request
  try {
    await new Promise((resolve, reject) => {
      request = http.get(
        new URL("api/liveness", fixture.broker.sessionUrl),
        {
          headers: {
            [BROKER_SESSION_HEADER]: "session-secret",
            Origin: fixture.broker.origin,
          },
        },
        (response) => {
          try {
            assert.equal(response.statusCode, 200)
          } catch (error) {
            reject(error)
            return
          }
          response.once("data", () => {
            response.destroy()
            resolve()
          })
        },
      )
      request.once("error", reject)
    })
    await Promise.race([
      fixture.broker.closed,
      new Promise((resolve, reject) => {
        setTimeout(() => reject(new Error("Broker did not stop")), 1000)
      }),
    ])
    assert.equal(fixture.broker.server.listening, false)
  } finally {
    request?.destroy()
    await closeFixture(fixture)
  }
})
