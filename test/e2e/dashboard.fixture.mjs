import { randomUUID } from "node:crypto"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { test as base, expect } from "@playwright/test"

import {
  createCacheRecord,
} from "../../src/cache.mjs"
import {
  SURFACES,
} from "../../src/constants.mjs"
import {
  CACHE_MODE,
  persistCacheRecord,
  prepareCacheScript,
} from "../../src/cache-store.mjs"
import {
  prepareFleetIntentScript,
} from "../../src/intent-store.mjs"
import {
  startSessionBroker,
} from "../../src/session-broker.mjs"
import {
  makeInventory,
  makeZone,
  ok,
} from "../fixtures.mjs"

const ACCOUNT_ID = "e2e-account"
const API_PATH_PREFIX = "/client/v4/"
const PROJECT_DIR = fileURLToPath(new URL("../..", import.meta.url))
const SETTING_PATH_PATTERN = /^zones\/([^/]+)\/settings\/([^/]+)$/
const SESSION_SECRET = "e2e-session-secret"

const ZONE_NAMES = Object.freeze([
  "alpha.example",
  "bravo.example",
  "charlie.example",
])

function setting(id, value) {
  return {
    editable: true,
    id,
    value,
  }
}

function makeDashboardZone(name, options) {
  const zone = makeZone(name, options)
  for (const surface of SURFACES) {
    if (!zone.surfaces[surface.id]) {
      zone.surfaces[surface.id] = ok(surface.id === "dnssec" ? null : [])
    }
  }
  return zone
}

function dnsRecords(zoneName, options = {}) {
  const records = [
    {
      content: options.apexAddress,
      id: `apex-${zoneName}`,
      name: zoneName,
      proxied: true,
      ttl: 1,
      type: "A",
    },
    {
      content: zoneName,
      id: `www-${zoneName}`,
      name: `www.${zoneName}`,
      proxied: true,
      ttl: 1,
      type: "CNAME",
    },
    {
      content: options.spf,
      id: `spf-${zoneName}`,
      name: zoneName,
      ttl: 60,
      type: "TXT",
    },
  ]
  if (options.includeDocs) {
    records.push({
      content: "docs-host.example.net",
      id: `docs-${zoneName}`,
      name: `docs.${zoneName}`,
      proxied: false,
      ttl: 300,
      type: "CNAME",
    })
  }
  return records
}

function dashboardInventory() {
  const inventory = makeInventory([
    makeDashboardZone(ZONE_NAMES[0], {
      dns: dnsRecords(ZONE_NAMES[0], {
        apexAddress: "192.0.2.10",
        includeDocs: true,
        spf: "v=spf1 include:_spf.example.net -all",
      }),
      settings: [
        setting("always_use_https", "on"),
        setting("min_tls_version", "1.2"),
        setting("tls_1_3", "on"),
      ],
    }),
    makeDashboardZone(ZONE_NAMES[1], {
      dns: dnsRecords(ZONE_NAMES[1], {
        apexAddress: "192.0.2.20",
        includeDocs: true,
        spf: "v=spf1 include:_spf.example.net -all",
      }),
      settings: [
        setting("always_use_https", "off"),
        setting("min_tls_version", "1.2"),
        setting("tls_1_3", "on"),
      ],
    }),
    makeDashboardZone(ZONE_NAMES[2], {
      dns: dnsRecords(ZONE_NAMES[2], {
        apexAddress: "192.0.2.30",
        includeDocs: false,
        spf: "v=spf1 include:_spf.other.example -all",
      }),
      settings: [
        setting("always_use_https", "on"),
        setting("min_tls_version", "1.3"),
        setting("tls_1_3", "off"),
      ],
    }),
  ])
  inventory.account.id = ACCOUNT_ID
  inventory.loadedAt = new Date().toISOString()
  return inventory
}

function jsonResponse(status, payload) {
  return new Response(JSON.stringify(payload), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
    },
    status,
  })
}

function mockCloudflareTransport(inventory) {
  const requests = []
  const settings = new Map()
  for (const zone of inventory.zones) {
    for (const entry of zone.surfaces.settings.result) {
      settings.set(`${zone.meta.id}:${entry.id}`, structuredClone(entry))
    }
  }

  const fetch = async (url, request = {}) => {
    const target = new URL(url)
    const method = request.method || "GET"
    const relativePath = target.pathname.startsWith(API_PATH_PREFIX)
      ? target.pathname.slice(API_PATH_PREFIX.length)
      : target.pathname.replace(/^\/+/, "")
    const body = request.body ? JSON.parse(String(request.body)) : null
    requests.push({
      body,
      method,
      path: `${relativePath}${target.search}`,
    })

    const match = relativePath.match(SETTING_PATH_PATTERN)
    if (match) {
      const zoneId = decodeURIComponent(match[1])
      const settingId = decodeURIComponent(match[2])
      const key = `${zoneId}:${settingId}`
      const current = settings.get(key)
      if (!current) {
        return jsonResponse(404, {
          errors: [{ message: "Setting not found" }],
          success: false,
        })
      }
      if (method === "PATCH") {
        const updated = {
          ...current,
          value: body.value,
        }
        settings.set(key, updated)
        return jsonResponse(200, {
          result: updated,
          success: true,
        })
      }
      if (method === "GET") {
        return jsonResponse(200, {
          result: current,
          success: true,
        })
      }
    }

    return jsonResponse(404, {
      errors: [{ message: `No E2E response is defined for ${method} ${relativePath}` }],
      success: false,
    })
  }

  return {
    fetch,
    requests,
    settingValue(zoneName, settingId) {
      return settings.get(`zone-${zoneName}:${settingId}`)?.value
    },
  }
}

async function copyRuntimeAssets(runtimeDir) {
  await fs.mkdir(runtimeDir, {
    mode: 0o700,
    recursive: true,
  })
  await Promise.all([
    fs.copyFile(
      path.join(PROJECT_DIR, "index.html"),
      path.join(runtimeDir, "index.html"),
    ),
    fs.copyFile(
      path.join(PROJECT_DIR, "styles.css"),
      path.join(runtimeDir, "styles.css"),
    ),
    fs.cp(
      path.join(PROJECT_DIR, "src"),
      path.join(runtimeDir, "src"),
      { recursive: true },
    ),
  ])
}

export async function createDashboardSession() {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "cloudflare-fleet-e2e."),
  )
  const cacheDir = path.join(root, "cache")
  const runtimeDir = path.join(root, "runtime")
  const stateFile = path.join(root, "state.json")
  const inventory = dashboardInventory()
  const transport = mockCloudflareTransport(inventory)
  await copyRuntimeAssets(runtimeDir)
  await persistCacheRecord(
    cacheDir,
    "seed",
    createCacheRecord(ACCOUNT_ID, inventory, {
      updatedAt: inventory.loadedAt,
    }),
  )
  await prepareCacheScript({
    accountId: ACCOUNT_ID,
    cacheDir,
    mode: CACHE_MODE.USE,
    outputPath: path.join(runtimeDir, "cache.js"),
  })
  await prepareFleetIntentScript({
    accountId: ACCOUNT_ID,
    outputPath: path.join(runtimeDir, "intent.js"),
    stateFile,
  })
  const broker = await startSessionBroker({
    accountId: ACCOUNT_ID,
    apiToken: "e2e-api-token",
    cacheDir,
    cloudflareFetch: transport.fetch,
    readOnly: false,
    runtimeDir,
    sessionId: `e2e-${process.pid}-${randomUUID()}`,
    sessionSecret: SESSION_SECRET,
    stateFile,
  })

  return {
    broker,
    requests: transport.requests,
    root,
    settingValue: transport.settingValue,
    url: broker.sessionUrl,
    zoneNames: ZONE_NAMES,
  }
}

export async function closeDashboardSession(session) {
  if (session.broker.server.listening) {
    session.broker.close()
    await session.broker.closed
  }
  await fs.rm(session.root, {
    force: true,
    recursive: true,
  })
}

async function waitForDashboard(page) {
  await page.locator("#application").waitFor({ state: "visible" })
  await page.waitForFunction(() => (
    document.querySelector("#application")?.dataset.initializing === "false"
  ))
}

export const test = base.extend({
  dashboard: async ({ page }, use, testInfo) => {
    const browserErrors = []
    page.on("console", (message) => {
      if (message.type() === "error") browserErrors.push(message.text())
    })
    page.on("pageerror", (error) => browserErrors.push(error.stack || error.message))
    const session = await createDashboardSession()
    await page.goto(session.url, { waitUntil: "domcontentloaded" })
    await waitForDashboard(page)
    await use({
      ...session,
      page,
      waitForReady: () => waitForDashboard(page),
    })
    await page.close()
    await closeDashboardSession(session)
    if (browserErrors.length > 0) {
      await testInfo.attach("browser-errors", {
        body: browserErrors.join("\n"),
        contentType: "text/plain",
      })
      if (testInfo.status === testInfo.expectedStatus) {
        throw new Error(`Unexpected browser errors:\n${browserErrors.join("\n")}`)
      }
    }
  },
})

export { expect }
