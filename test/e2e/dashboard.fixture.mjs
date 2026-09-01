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
  ACCOUNT_SURFACES,
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
  prepareFleetPolicyScript,
} from "../../src/fleet-policy-store.mjs"
import {
  startSessionBroker,
} from "../../src/session-broker.mjs"
import {
  makeInventory,
  makeRule,
  makeZone,
  ok,
} from "../fixtures.mjs"
import {
  buildZoneAliasRedirectRule,
  createZoneAliasIntentValue,
  ZONE_ALIAS_REDIRECT_PHASE,
} from "../../src/zone-alias-intent.mjs"

const ACCOUNT_ID = "e2e-account"
const API_PATH_PREFIX = "/client/v4/"
const DNS_COLLECTION_PATH_PATTERN = /^zones\/([^/]+)\/dns_records$/
const DNS_RECORD_PATH_PATTERN = /^zones\/([^/]+)\/dns_records\/([^/]+)$/
const EMAIL_SETTINGS_PATH_PATTERN = /^zones\/([^/]+)\/email\/routing$/
const RULESET_PATH_PATTERN = /^zones\/([^/]+)\/rulesets\/([^/]+)$/
const RULESET_RULE_PATH_PATTERN = /^zones\/([^/]+)\/rulesets\/([^/]+)\/rules\/([^/]+)$/
const PROJECT_DIR = fileURLToPath(new URL("../..", import.meta.url))
const SETTINGS_COLLECTION_PATH_PATTERN = /^zones\/([^/]+)\/settings$/
const SETTING_PATH_PATTERN = /^zones\/([^/]+)\/settings\/([^/]+)$/
const SESSION_SECRET = "e2e-session-secret"
const ZONES_PATH = "zones"
const DENSE_RULE_ZONE_COUNT = 12
const DENSE_RULE_PHASE = "http_request_firewall_custom"

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
      content: options.docsTarget || "docs-host.example.net",
      id: `docs-${zoneName}`,
      name: `docs.${zoneName}`,
      proxied: false,
      ttl: 300,
      type: "CNAME",
    })
  }
  return records
}

function dashboardRuleset(zoneName, options = {}) {
  return {
    id: `firewall-${zoneName}`,
    kind: "zone",
    name: "default",
    phase: "http_request_firewall_custom",
    rules: [
      {
        action: "block",
        description: "Protect service",
        enabled: options.enabled !== false,
        expression: `http.host eq "service.${zoneName}"`,
        id: `protect-${zoneName}`,
        ref: `protect-${zoneName}`,
      },
    ],
  }
}

export function dashboardInventory(options = {}) {
  const inventory = makeInventory([
    makeDashboardZone(ZONE_NAMES[0], {
      dns: dnsRecords(ZONE_NAMES[0], {
        apexAddress: "192.0.2.10",
        docsTarget: "docs-primary.example.net",
        includeDocs: true,
        spf: "v=spf1 include:_spf.example.net -all",
      }),
      settings: [
        setting("always_use_https", "on"),
        setting("min_tls_version", "1.2"),
        setting("tls_1_3", "on"),
      ],
      ruleDetails: [ok(dashboardRuleset(ZONE_NAMES[0]))],
    }),
    makeDashboardZone(ZONE_NAMES[1], {
      dns: dnsRecords(ZONE_NAMES[1], {
        apexAddress: "192.0.2.20",
        docsTarget: "docs-secondary.example.net",
        includeDocs: true,
        spf: "v=spf1 include:_spf.example.net -all",
      }),
      settings: [
        setting("always_use_https", "off"),
        setting("min_tls_version", "1.2"),
        setting("tls_1_3", "on"),
      ],
      ruleDetails: [ok(dashboardRuleset(ZONE_NAMES[1], { enabled: false }))],
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
      ruleDetails: [ok(dashboardRuleset(ZONE_NAMES[2]))],
    }),
  ])
  inventory.account.id = ACCOUNT_ID
  inventory.loadedAt = options.loadedAt || new Date().toISOString()
  return inventory
}

function emailIntentInventory() {
  const inventory = dashboardInventory()
  const zone = inventory.zones.find(
    (entry) => entry.meta.name === ZONE_NAMES[1],
  )
  zone.surfaces.email.result = {
    ...zone.surfaces.email.result,
    status: "misconfigured",
    support_subaddress: false,
  }
  return inventory
}

function zoneAliasIntentInventory() {
  const sourceHost = "j256.dev"
  const observed = createZoneAliasIntentValue({
    statusCode: 302,
    targetHost: "j-256.dev",
  })
  const ruleset = {
    id: "alias-redirect-ruleset",
    kind: "zone",
    name: "default",
    phase: ZONE_ALIAS_REDIRECT_PHASE,
    rules: [{
      id: "alias-redirect-rule",
      ...buildZoneAliasRedirectRule(sourceHost, observed),
    }],
  }
  const zone = makeDashboardZone(sourceHost, {
    dns: [
      {
        content: "255.255.255.255",
        id: "alias-apex",
        name: sourceHost,
        proxied: true,
        ttl: 1,
        type: "A",
      },
      {
        content: "255.255.255.255",
        id: "alias-wildcard",
        name: `*.${sourceHost}`,
        proxied: true,
        ttl: 1,
        type: "A",
      },
    ],
    ruleDetails: [ok(ruleset)],
    rulesets: [{
      id: ruleset.id,
      kind: ruleset.kind,
      name: ruleset.name,
      phase: ruleset.phase,
    }],
  })
  const inventory = makeInventory([zone])
  inventory.account.id = ACCOUNT_ID
  inventory.loadedAt = new Date().toISOString()
  return inventory
}

function denseRuleInventory() {
  const zones = Array.from({ length: DENSE_RULE_ZONE_COUNT }, (_, index) => {
    const ordinal = String(index + 1).padStart(2, "0")
    const name = `review-${ordinal}.example`
    const ruleset = {
      description: "",
      id: `dense-ruleset-${ordinal}`,
      kind: "zone",
      name: "default",
      phase: DENSE_RULE_PHASE,
      rules: [makeRule("Protect service", {
        expression: `(http.request.uri.path contains "/variant-${ordinal}")`,
        ref: "protect-service",
      })],
      version: "1",
    }
    return makeDashboardZone(name, {
      ruleDetails: [{
        ...ok(ruleset),
        phase: DENSE_RULE_PHASE,
      }],
      rulesets: [{
        id: ruleset.id,
        kind: ruleset.kind,
        name: ruleset.name,
        phase: ruleset.phase,
        version: ruleset.version,
      }],
    })
  })
  const inventory = makeInventory(zones)
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

function fakeCloudflareTransport(inventory) {
  const requests = []
  const dnsByZone = new Map()
  const emailSettings = new Map()
  const failures = []
  const settings = new Map()
  const rulesets = new Map()
  let createdDnsRecord = 0
  for (const zone of inventory.zones) {
    dnsByZone.set(
      zone.meta.id,
      structuredClone(zone.surfaces.dns.result),
    )
    emailSettings.set(
      zone.meta.id,
      structuredClone(zone.surfaces.email.result),
    )
    for (const entry of zone.surfaces.settings.result) {
      settings.set(`${zone.meta.id}:${entry.id}`, structuredClone(entry))
    }
    rulesets.set(zone.meta.id, new Map(
      zone.ruleDetails
        .filter((detail) => detail.ok)
        .map((detail) => [detail.result.id, structuredClone(detail.result)]),
    ))
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

    const failureIndex = failures.findIndex((failure) => (
      failure.method === method
      && (!failure.path || failure.path === relativePath)
    ))
    if (failureIndex !== -1) {
      const [failure] = failures.splice(failureIndex, 1)
      return jsonResponse(failure.status, {
        errors: [{ message: failure.message }],
        success: false,
      })
    }

    if (relativePath === ZONES_PATH && method === "GET") {
      return jsonResponse(200, {
        result: inventory.zones.map((zone) => structuredClone(zone.meta)),
        result_info: { total_pages: 1 },
        success: true,
      })
    }

    if (method === "GET") {
      const accountSurface = ACCOUNT_SURFACES.find(
        (surface) => surface.path(ACCOUNT_ID).split("?", 1)[0] === relativePath,
      )
      if (accountSurface) {
        return jsonResponse(200, {
          result: structuredClone(
            inventory.account.surfaces[accountSurface.id]?.result || [],
          ),
          success: true,
        })
      }
    }

    const dnsCollectionMatch = relativePath.match(DNS_COLLECTION_PATH_PATTERN)
    if (dnsCollectionMatch) {
      const zoneId = decodeURIComponent(dnsCollectionMatch[1])
      const records = dnsByZone.get(zoneId)
      if (!records) {
        return jsonResponse(404, {
          errors: [{ message: "Zone not found" }],
          success: false,
        })
      }
      if (method === "GET") {
        return jsonResponse(200, {
          result: structuredClone(records),
          success: true,
        })
      }
      if (method === "POST") {
        createdDnsRecord += 1
        const created = {
          ...body,
          id: `created-dns-${createdDnsRecord}`,
        }
        records.push(created)
        return jsonResponse(200, {
          result: structuredClone(created),
          success: true,
        })
      }
    }

    const dnsRecordMatch = relativePath.match(DNS_RECORD_PATH_PATTERN)
    if (dnsRecordMatch) {
      const zoneId = decodeURIComponent(dnsRecordMatch[1])
      const recordId = decodeURIComponent(dnsRecordMatch[2])
      const records = dnsByZone.get(zoneId)
      const recordIndex = records?.findIndex((record) => record.id === recordId) ?? -1
      if (!records || recordIndex === -1) {
        return jsonResponse(404, {
          errors: [{ message: "DNS record not found" }],
          success: false,
        })
      }
      if (method === "GET") {
        return jsonResponse(200, {
          result: structuredClone(records[recordIndex]),
          success: true,
        })
      }
      if (method === "PATCH") {
        records[recordIndex] = {
          ...records[recordIndex],
          ...body,
        }
        return jsonResponse(200, {
          result: structuredClone(records[recordIndex]),
          success: true,
        })
      }
      if (method === "DELETE") {
        const [deleted] = records.splice(recordIndex, 1)
        return jsonResponse(200, {
          result: { id: deleted.id },
          success: true,
        })
      }
    }

    const emailSettingsMatch = relativePath.match(
      EMAIL_SETTINGS_PATH_PATTERN,
    )
    if (emailSettingsMatch) {
      const zoneId = decodeURIComponent(emailSettingsMatch[1])
      const current = emailSettings.get(zoneId)
      if (!current) {
        return jsonResponse(404, {
          errors: [{ message: "Email Routing settings not found" }],
          success: false,
        })
      }
      if (method === "GET") {
        return jsonResponse(200, {
          result: structuredClone(current),
          success: true,
        })
      }
      if (method === "PATCH") {
        const updated = {
          ...current,
          ...body,
        }
        emailSettings.set(zoneId, updated)
        return jsonResponse(200, {
          result: structuredClone(updated),
          success: true,
        })
      }
    }

    const settingsCollectionMatch = relativePath.match(
      SETTINGS_COLLECTION_PATH_PATTERN,
    )
    if (settingsCollectionMatch && method === "GET") {
      const zoneId = decodeURIComponent(settingsCollectionMatch[1])
      return jsonResponse(200, {
        result: [...settings.entries()]
          .filter(([key]) => key.startsWith(`${zoneId}:`))
          .map(([, value]) => structuredClone(value)),
        success: true,
      })
    }

    const rulesetRuleMatch = relativePath.match(RULESET_RULE_PATH_PATTERN)
    if (rulesetRuleMatch && method === "PATCH") {
      const zoneId = decodeURIComponent(rulesetRuleMatch[1])
      const rulesetId = decodeURIComponent(rulesetRuleMatch[2])
      const ruleId = decodeURIComponent(rulesetRuleMatch[3])
      const ruleset = rulesets.get(zoneId)?.get(rulesetId)
      const ruleIndex = ruleset?.rules.findIndex((rule) => rule.id === ruleId) ?? -1
      if (!ruleset || ruleIndex === -1) {
        return jsonResponse(404, {
          errors: [{ message: "Ruleset rule not found" }],
          success: false,
        })
      }
      ruleset.rules[ruleIndex] = {
        id: ruleId,
        ...body,
      }
      return jsonResponse(200, {
        result: structuredClone(ruleset.rules[ruleIndex]),
        success: true,
      })
    }

    const rulesetMatch = relativePath.match(RULESET_PATH_PATTERN)
    if (rulesetMatch && method === "GET") {
      const zoneId = decodeURIComponent(rulesetMatch[1])
      const rulesetId = decodeURIComponent(rulesetMatch[2])
      const ruleset = rulesets.get(zoneId)?.get(rulesetId)
      if (ruleset) {
        return jsonResponse(200, {
          result: structuredClone(ruleset),
          success: true,
        })
      }
    }

    if (method === "GET") {
      for (const zone of inventory.zones) {
        const surface = SURFACES.find(
          (candidate) => candidate.path(zone.meta.id).split("?", 1)[0]
            === relativePath,
        )
        if (!surface) continue
        const result = surface.id === "rulesets"
          ? [...(rulesets.get(zone.meta.id)?.values() || [])].map((ruleset) => ({
              id: ruleset.id,
              kind: ruleset.kind,
              name: ruleset.name,
              phase: ruleset.phase,
            }))
          : zone.surfaces[surface.id]?.result
        return jsonResponse(200, {
          result: structuredClone(result ?? []),
          success: true,
        })
      }
    }

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
    dnsRecords(zoneName) {
      return structuredClone(
        dnsByZone.get(`zone-${zoneName}`) || [],
      )
    },
    emailSettingValue(zoneName, settingId) {
      return emailSettings.get(`zone-${zoneName}`)?.[settingId]
    },
    queueFailure(failure) {
      failures.push({
        message: failure.message || "Simulated upstream failure",
        method: failure.method,
        path: failure.path || "",
        status: failure.status || 500,
      })
    },
    setSettingValue(zoneName, settingId, value) {
      const key = `zone-${zoneName}:${settingId}`
      const current = settings.get(key)
      if (!current) {
        throw new Error(`Setting ${settingId} does not exist on ${zoneName}`)
      }
      settings.set(key, {
        ...current,
        value,
      })
    },
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

export async function createDashboardSession(options = {}) {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "cloudflare-fleet-e2e."),
  )
  const cacheDir = path.join(root, "cache")
  const runtimeDir = path.join(root, "runtime")
  const stateFile = path.join(root, "state.json")
  const policyFile = path.join(root, "fleet-policy.json")
  const inventory = options.inventory
    ?? (options.seedCache === false ? null : dashboardInventory())
  const accountId = options.accountId || inventory?.account.id
  if (!accountId) {
    throw new TypeError("A dashboard session account identifier is required")
  }
  if (!options.cloudflareFetch && !inventory) {
    throw new TypeError("A dashboard session inventory or transport is required")
  }
  const transport = options.cloudflareFetch
    ? {
        fetch: options.cloudflareFetch,
        requests: options.requests || [],
      }
    : fakeCloudflareTransport(inventory)
  await copyRuntimeAssets(runtimeDir)
  if (options.stateSourceFile) {
    await fs.copyFile(options.stateSourceFile, stateFile)
  }
  if (options.policyConfiguration) {
    await fs.writeFile(
      policyFile,
      `${JSON.stringify(options.policyConfiguration, null, 2)}\n`,
      { mode: 0o600 },
    )
  }
  if (options.seedCache !== false) {
    await persistCacheRecord(
      cacheDir,
      "seed",
      createCacheRecord(accountId, inventory, {
        updatedAt: inventory.loadedAt,
      }),
    )
  }
  await prepareCacheScript({
    accountId,
    cacheDir,
    mode: options.seedCache === false ? CACHE_MODE.FRESH : CACHE_MODE.USE,
    outputPath: path.join(runtimeDir, "cache.js"),
  })
  await prepareFleetIntentScript({
    accountId,
    outputPath: path.join(runtimeDir, "intent.js"),
    stateFile,
  })
  await prepareFleetPolicyScript({
    outputPath: path.join(runtimeDir, "policy.js"),
    policyFile,
  })
  const broker = await startSessionBroker({
    accountId,
    apiToken: options.apiToken || "e2e-api-token",
    cacheDir,
    cloudflareFetch: transport.fetch,
    now: options.now,
    readOnly: Boolean(options.readOnly),
    runtimeDir,
    sessionId: `e2e-${process.pid}-${randomUUID()}`,
    sessionSecret: SESSION_SECRET,
    stateFile,
  })

  return {
    broker,
    dnsRecords: transport.dnsRecords,
    queueFailure: transport.queueFailure,
    requests: transport.requests,
    root,
    sessionSecret: SESSION_SECRET,
    setSettingValue: transport.setSettingValue,
    emailSettingValue: transport.emailSettingValue,
    settingValue: transport.settingValue,
    stateFile,
    url: broker.sessionUrl,
    zoneNames: inventory
      ? inventory.zones.map((zone) => zone.meta.name)
      : ZONE_NAMES,
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

export async function waitForDashboard(page) {
  await page.locator("#application").waitFor({ state: "visible" })
  await page.waitForFunction(() => (
    document.querySelector("#application")?.dataset.initializing === "false"
  ))
}

async function useDashboard(page, use, testInfo, options = {}) {
  const allowedBrowserErrors = []
  const browserErrors = []
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text())
  })
  page.on("pageerror", (error) => browserErrors.push(error.stack || error.message))
  const session = await createDashboardSession(options)
  await page.goto(session.url, { waitUntil: "domcontentloaded" })
  await waitForDashboard(page)
  await use({
    ...session,
    allowBrowserError: (matcher) => allowedBrowserErrors.push(matcher),
    page,
    waitForReady: () => waitForDashboard(page),
  })
  await page.close()
  await closeDashboardSession(session)
  const unexpectedBrowserErrors = browserErrors.filter((message) => (
    !allowedBrowserErrors.some((matcher) => (
      matcher instanceof RegExp
        ? matcher.test(message)
        : message.includes(String(matcher))
    ))
  ))
  if (unexpectedBrowserErrors.length > 0) {
    await testInfo.attach("browser-errors", {
      body: unexpectedBrowserErrors.join("\n"),
      contentType: "text/plain",
    })
    if (testInfo.status === testInfo.expectedStatus) {
      throw new Error(`Unexpected browser errors:\n${unexpectedBrowserErrors.join("\n")}`)
    }
  }
}

export const test = base.extend({
  dashboard: async ({ page }, use, testInfo) => {
    await useDashboard(page, use, testInfo)
  },
  denseDashboard: async ({ page }, use, testInfo) => {
    await useDashboard(page, use, testInfo, {
      inventory: denseRuleInventory(),
    })
  },
  emailIntentDashboard: async ({ page }, use, testInfo) => {
    await useDashboard(page, use, testInfo, {
      inventory: emailIntentInventory(),
    })
  },
  zoneAliasDashboard: async ({ page }, use, testInfo) => {
    await useDashboard(page, use, testInfo, {
      inventory: zoneAliasIntentInventory(),
    })
  },
  readOnlyDashboard: async ({ page }, use, testInfo) => {
    await useDashboard(page, use, testInfo, { readOnly: true })
  },
})

export { expect }
