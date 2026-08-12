import { promises as fs } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { chromium } from "@playwright/test"

import { isMainModule } from "../src/entrypoint.mjs"
import {
  closeDashboardSession,
  createDashboardSession,
  dashboardInventory,
  waitForDashboard,
} from "../test/e2e/dashboard.fixture.mjs"

const PROJECT_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const DEFAULT_OUTPUT_DIRECTORY = path.join(PROJECT_ROOT, "docs", "screenshots")
const FIXED_TIME = "2026-08-12T12:00:00.000Z"
const DESKTOP_VIEWPORT = Object.freeze({ height: 1000, width: 1440 })
const MOBILE_VIEWPORT = Object.freeze({ height: 844, width: 390 })

function parseArguments(argv) {
  let outputDirectory = DEFAULT_OUTPUT_DIRECTORY
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === "--output" || argument.startsWith("--output=")) {
      const value = argument.startsWith("--output=")
        ? argument.slice("--output=".length)
        : argv[index + 1]
      if (!value || value.startsWith("--")) {
        throw new Error("--output requires a directory")
      }
      outputDirectory = path.resolve(value)
      if (argument === "--output") index += 1
      continue
    }
    throw new Error(`Unknown option: ${argument}`)
  }
  return { outputDirectory }
}

async function openDashboardPage(context, session, viewport, browserErrors) {
  const page = await context.newPage()
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text())
  })
  page.on("pageerror", (error) => browserErrors.push(error.message))
  await page.setViewportSize(viewport)
  await page.clock.setFixedTime(FIXED_TIME)
  await page.goto(session.url, { waitUntil: "domcontentloaded" })
  await waitForDashboard(page)
  await page.evaluate(() => document.fonts.ready)
  return page
}

async function capture(page, outputDirectory, filename) {
  const outputPath = path.join(outputDirectory, filename)
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
  })
  await page.screenshot({
    animations: "disabled",
    path: outputPath,
  })
  return outputPath
}

export async function capturePublicationScreenshots(options = {}) {
  const outputDirectory = path.resolve(
    options.outputDirectory || DEFAULT_OUTPUT_DIRECTORY,
  )
  await fs.mkdir(outputDirectory, { recursive: true })
  const browserErrors = []
  const screenshots = []
  let browser
  let session
  try {
    const inventory = dashboardInventory({ loadedAt: FIXED_TIME })
    const statusDriftZone = inventory.zones.find(
      (zone) => zone.meta.name === "bravo.example",
    )
    statusDriftZone.surfaces.email.result = {
      ...statusDriftZone.surfaces.email.result,
      status: "misconfigured",
    }
    session = await createDashboardSession({ inventory })
    browser = await chromium.launch({ headless: true })
    const context = await browser.newContext({
      colorScheme: "light",
      deviceScaleFactor: 1,
      locale: "en-US",
      reducedMotion: "reduce",
      timezoneId: "UTC",
      viewport: DESKTOP_VIEWPORT,
    })

    const overview = await openDashboardPage(
      context,
      session,
      DESKTOP_VIEWPORT,
      browserErrors,
    )
    screenshots.push(await capture(
      overview,
      outputDirectory,
      "dashboard-overview.png",
    ))

    await overview.getByPlaceholder("Search facets, values, or zones").fill(
      "always_use_https",
    )
    await overview.getByRole("button", {
      name: "Compare 2 values: Observed values for always_use_https",
    }).click()
    const comparison = overview.getByRole("dialog", {
      name: "always_use_https",
    })
    await comparison.getByRole("button", {
      name: "Use as exact intent: Fleet consensus for always_use_https",
    }).click()
    const policy = overview.getByRole("dialog", { name: "Set facet intent" })
    await policy.locator("#intent-policy-save").click()
    await overview.locator("#toast-dismiss").click()

    await overview.getByRole("button", { name: "Manage fleet intent" }).click()
    await overview.getByRole("dialog", { name: "Fleet intent" }).waitFor()
    screenshots.push(await capture(
      overview,
      outputDirectory,
      "fleet-intent.png",
    ))
    await overview.getByRole("button", { name: "Close fleet intent" }).click()

    await overview.getByRole("button", {
      name: "Review alignment (1): Align always_use_https with fleet intent",
    }).click()
    const alignmentReview = overview.getByRole("dialog", {
      name: "Align always_use_https with fleet intent",
    })
    await alignmentReview.waitFor()
    screenshots.push(await capture(
      overview,
      outputDirectory,
      "intent-alignment.png",
    ))
    await alignmentReview.getByRole("button", { name: "Cancel" }).click()

    await overview.locator("#category").selectOption("Email")
    await overview.getByPlaceholder("Search facets, values, or zones").fill(
      "status",
    )
    await overview.getByRole("button", {
      name: "Compare 2 values: Observed values for status",
    }).click()
    const statusComparison = overview.getByRole("dialog", { name: "status" })
    await statusComparison.getByRole("button", {
      name: "Use as exact intent: Fleet consensus for status",
    }).click()
    const statusPolicy = overview.getByRole("dialog", { name: "Set facet intent" })
    await statusPolicy.locator("#intent-policy-save").click()
    await overview.locator("#toast-dismiss").click()
    screenshots.push(await capture(
      overview,
      outputDirectory,
      "alignment-blocked.png",
    ))

    await overview.locator("#category").selectOption("")
    await overview.getByPlaceholder("Search facets, values, or zones").fill(
      "always_use_https",
    )
    await overview.getByRole("button", {
      name: "Edit always_use_https on bravo.example",
    }).click()
    const editor = overview.locator("form.inline-value-editor")
    await editor.getByLabel("Desired value").fill("on")
    await editor.getByRole("button", { name: "Review" }).click()
    await overview.getByRole("dialog", { name: "Update zone setting" }).waitFor()
    screenshots.push(await capture(
      overview,
      outputDirectory,
      "reviewed-write.png",
    ))

    const mobile = await openDashboardPage(
      context,
      session,
      MOBILE_VIEWPORT,
      browserErrors,
    )
    await mobile.getByRole("button", { name: /Filters & sort/ }).click()
    screenshots.push(await capture(
      mobile,
      outputDirectory,
      "mobile-dashboard.png",
    ))

    await context.close()
  } finally {
    if (browser) await browser.close()
    if (session) await closeDashboardSession(session)
  }
  if (browserErrors.length > 0) {
    throw new Error(`Dashboard emitted browser errors:\n${browserErrors.join("\n")}`)
  }
  return screenshots
}

if (isMainModule(import.meta.url)) {
  let options
  try {
    options = parseArguments(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 2
  }
  if (options) {
    capturePublicationScreenshots(options).then((screenshots) => {
      process.stdout.write(`${JSON.stringify({ screenshots })}\n`)
    }).catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
      process.exitCode = 1
    })
  }
}
