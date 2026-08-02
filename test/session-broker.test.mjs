import assert from "node:assert/strict"
import { promises as fs } from "node:fs"
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
  createEmptyFleetIntentDocument,
} from "../src/fleet-intent.mjs"
import {
  readFleetIntentDocument,
} from "../src/intent-store.mjs"
import {
  startSessionBroker,
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
  const stateDir = path.join(root, "state")
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
    stateDir,
    ...options,
  })
  return {
    broker,
    cacheDir,
    calls,
    root,
    stateDir,
  }
}

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
      await readFleetIntentDocument(fixture.stateDir, "account-id"),
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
  const controller = new AbortController()
  try {
    const response = await fetch(
      new URL("api/liveness", fixture.broker.sessionUrl),
      {
        headers: {
          [BROKER_SESSION_HEADER]: "session-secret",
          Origin: fixture.broker.origin,
        },
        signal: controller.signal,
      },
    )
    const reader = response.body.getReader()
    await reader.read()
    controller.abort()
    await Promise.race([
      fixture.broker.closed,
      new Promise((resolve, reject) => {
        setTimeout(() => reject(new Error("Broker did not stop")), 1000)
      }),
    ])
    assert.equal(fixture.broker.server.listening, false)
  } finally {
    controller.abort()
    await closeFixture(fixture)
  }
})
