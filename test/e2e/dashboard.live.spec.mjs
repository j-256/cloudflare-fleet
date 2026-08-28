import { promises as fs } from "node:fs"
import { fileURLToPath } from "node:url"

import { test, expect } from "@playwright/test"

import {
  closeDashboardSession,
  createDashboardSession,
  waitForDashboard,
} from "./dashboard.fixture.mjs"
import { HTTP_METHOD } from "../../src/constants.mjs"

const CLOUDFLARE_PROXY_PATH = "/api/cloudflare/"
const LARGE_COMPARISON_MINIMUM = 5
const MAX_VALUE_GROUP_PANES = 3
const LIVE_READ_ONLY_ENABLED = process.env.CLOUDFLARE_FLEET_RUN_LIVE_READ_ONLY
  === "1"
const PROJECT_STATE_FILE = fileURLToPath(
  new URL("../../state.json", import.meta.url),
)

function requiredEnvironment(name) {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required for live read-only testing`)
  return value
}

function statusSummary(requests) {
  const statuses = {}
  for (const request of requests) {
    statuses[request.status] = (statuses[request.status] || 0) + 1
  }
  return statuses
}

test.skip(
  !LIVE_READ_ONLY_ENABLED,
  "Run through npm run test:e2e:live:read-only",
)

test("loads the real account through a GET-only dashboard session", async ({ page }, testInfo) => {
  const accountId = requiredEnvironment("CLOUDFLARE_ACCOUNT_ID")
  const apiToken = requiredEnvironment("CLOUDFLARE_API_TOKEN")
  const browserCloudflareRequests = []
  const browserErrors = []
  const upstreamRequests = []
  let ruleComparisonLayout = null
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text())
  })
  page.on("pageerror", (error) => {
    browserErrors.push(error.stack || error.message)
  })
  page.on("request", (request) => {
    const target = new URL(request.url())
    if (target.pathname.includes(CLOUDFLARE_PROXY_PATH)) {
      browserCloudflareRequests.push({ method: request.method() })
    }
  })

  const cloudflareFetch = async (url, request = {}) => {
    const method = String(request.method || HTTP_METHOD.GET).toUpperCase()
    if (method !== HTTP_METHOD.GET) {
      throw new Error(`Live read-only transport blocked ${method}`)
    }
    const response = await globalThis.fetch(url, request)
    upstreamRequests.push({
      method,
      status: response.status,
    })
    return response
  }

  let session
  try {
    session = await createDashboardSession({
      accountId,
      apiToken,
      cloudflareFetch,
      readOnly: true,
      requests: upstreamRequests,
      seedCache: false,
      stateSourceFile: PROJECT_STATE_FILE,
    })
    await page.goto(session.url, {
      timeout: 30000,
      waitUntil: "domcontentloaded",
    })
    await waitForDashboard(page)

    await expect(page).toHaveTitle("Cloudflare Fleet | Read-only")
    await expect(page.locator("#status-text")).toHaveText("Fleet loaded")
    await expect(page.locator("#session-mode")).toHaveText("Read-only session")
    await expect(page.locator("#write-readiness")).toHaveText(
      "Read-only session; relaunch with write access to apply changes",
    )

    const zoneCount = Number(await page.locator("#zone-count").textContent())
    const matrixRowCount = await page.locator("#matrix-body tr").count()
    expect(zoneCount).toBeGreaterThan(0)
    expect(matrixRowCount).toBeGreaterThan(0)
    await expect(page.locator("#visible-count")).toContainText("facets")
    await expect(page.locator("#coverage-groups")).toBeVisible()

    await page.locator("#matrix-choose-targets").click()
    const targets = page.getByRole("dialog", { name: "Choose zones" })
    await targets.locator("#target-options input").first().check()
    await targets.getByRole("button", { name: "Done" }).click()
    await expect(page.locator("#selection-count")).toHaveText("1")

    const equivalenceOpener = page.locator(
      "#matrix-body tr:not(.hidden-row) .facet-equivalence-open",
    ).first()
    await equivalenceOpener.click()
    const equivalence = page.locator("#facet-equivalence-dialog")
    await expect(equivalence).toBeVisible()
    await expect(equivalence.locator("#facet-equivalence-identity")).toContainText(
      "Exact match",
    )
    await equivalence.getByRole("button", {
      name: "Close facet equivalence inspector",
    }).click()
    await expect(equivalenceOpener).toBeFocused()

    const ruleCategory = page.locator('#category option[value="Ruleset rules"]')
    if (await ruleCategory.count() > 0) {
      await page.locator("#category").selectOption("Ruleset rules")
    }
    const ruleComparisonOpener = page.locator(
      '#matrix-body tr[data-category="Ruleset rules"]:not(.hidden-row) .compare-values',
    ).first()
    if (await ruleComparisonOpener.count() > 0) {
      await ruleComparisonOpener.click()
      const comparison = page.locator("#value-comparison-dialog")
      await expect(comparison).toBeVisible()
      const groups = comparison.locator(".value-comparison-group")
      const valueCount = await groups.count()
      const fieldTableExpanded = await comparison.locator(
        "#value-comparison-differences-disclosure",
      ).getAttribute("open") !== null
      const groupPanes = await groups.first().evaluate((group) => (
        group.parentElement.getBoundingClientRect().height / innerHeight
      ))
      ruleComparisonLayout = {
        fieldTableExpanded,
        groupPanes,
        valueCount,
      }
      if (valueCount >= LARGE_COMPARISON_MINIMUM) {
        expect(fieldTableExpanded).toBe(false)
        expect(groupPanes).toBeLessThan(MAX_VALUE_GROUP_PANES)
      }
      const comparisonScreenshot = testInfo.outputPath(
        "live-rule-comparison.png",
      )
      await page.screenshot({ path: comparisonScreenshot })
      await testInfo.attach("live-rule-comparison", {
        contentType: "image/png",
        path: comparisonScreenshot,
      })
      await comparison.getByRole("button", { name: "Done" }).click()
    }

    await page.getByRole("button", { name: "View fleet intent" }).click()
    const intent = page.getByRole("dialog", { name: "Fleet intent" })
    await expect(intent).toContainText(
      "This read-only session can inspect intent but cannot change it",
    )
    await expect(intent.locator("#intent-add-group")).toBeDisabled()
    await intent.getByRole("button", { name: "Done" }).click()

    await page.locator("#show-activity").click()
    const activity = page.getByRole("dialog", { name: "Operation history" })
    await expect(activity).toBeVisible()
    await expect(activity.locator(".activity-undo")).toHaveCount(0)
    await activity.getByRole("button", { name: "Done" }).click()

    await expect(page.locator(
      ".edit-cell, .fill-hole, .bulk-fill, .copy-rule, .rename-rule",
    )).toHaveCount(0)
    await expect(page.locator("#align-email")).toBeHidden()
    await expect(page.locator("#align-waf")).toBeHidden()
    await expect(page.locator("#confirm-dialog")).not.toBeVisible()

    expect(upstreamRequests.length).toBeGreaterThan(0)
    expect(upstreamRequests.every(
      (request) => request.method === HTTP_METHOD.GET,
    )).toBe(true)
    expect(browserCloudflareRequests.length).toBeGreaterThan(0)
    expect(browserCloudflareRequests.every(
      (request) => request.method === HTTP_METHOD.GET,
    )).toBe(true)
    expect(browserErrors).toEqual([])

    const summaryPath = testInfo.outputPath("live-read-only-summary.json")
    await fs.writeFile(summaryPath, JSON.stringify({
      browserCloudflareRequests: browserCloudflareRequests.length,
      matrixRows: matrixRowCount,
      upstreamRequests: upstreamRequests.length,
      upstreamStatuses: statusSummary(upstreamRequests),
      ruleComparison: ruleComparisonLayout,
      zones: zoneCount,
    }, null, 2), { mode: 0o600 })
    await testInfo.attach("live-read-only-summary", {
      contentType: "application/json",
      path: summaryPath,
    })
  } finally {
    if (!page.isClosed()) await page.close()
    if (session) await closeDashboardSession(session)
  }
})
