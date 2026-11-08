import { test as base, expect, createDashboardSession, closeDashboardSession, waitForDashboard } from "./dashboard.fixture.mjs"
import { createDemoFleet, DEMO_ZONE } from "../demo-fleet.mjs"

const test = base.extend({
  demo: async ({ page }, use) => {
    const { inventory, intent } = createDemoFleet()
    const session = await createDashboardSession({ inventory, intentDocument: intent })
    await page.goto(session.url)
    await waitForDashboard(page)
    try { await use({ ...session, page }) } finally {
      await page.close()
      await closeDashboardSession(session)
    }
  },
})

test("representative demo opens populated queues and pages through distinct work", async ({ demo }) => {
  const { page } = demo
  await expect(page.locator("#zone-count")).toHaveText("16")
  await expect(page.locator("#review-queue-status")).toContainText("alignment review")
  const firstPage = await page.locator(".review-queue-item h3").allTextContents()
  await expect(page.locator("#review-queue-next")).toBeEnabled()
  await page.locator("#review-queue-next").click()
  expect(await page.locator(".review-queue-item h3").allTextContents()).not.toEqual(firstPage)
  await page.locator("#review-queue-previous").click()
  expect(await page.locator(".review-queue-item h3").allTextContents()).toEqual(firstPage)
  await page.setViewportSize({ width: 390, height: 844 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await expect(page.locator(".queue-expected-value").first()).toContainText("on")
})

test("demo refresh preserves seeded intent and specific simulated read failures", async ({ demo }) => {
  const { page } = demo
  await page.getByRole("button", { name: /^Read health/ }).click()
  await expect(page.locator("#review-queue-list")).toContainText("Health checks")
  await expect(page.locator("#review-queue-list")).toContainText("Simulated token lacks")
  await page.locator("#refresh").click()
  await waitForDashboard(page)
  await expect(page.locator("#zone-count")).toHaveText("16")
  await expect(page.locator("#review-queue-list")).toContainText("Simulated token lacks")
  await expect(page.locator("#review-queue-list")).toContainText("temporarily unavailable")
  await page.reload()
  await waitForDashboard(page)
  await page.getByRole("button", { name: /^Read health/ }).click()
  await expect(page.locator("#review-queue-list")).toContainText("Simulated token lacks")
  await expect(page.locator("#review-queue-status")).toContainText("alignment review")
})

test("demo corrects one reviewed mismatch while preserving its acknowledged exception", async ({ demo }) => {
  const { page } = demo
  const item = page.locator(".review-queue-item").filter({ hasText: "always_use_https" })
  await expect(item).toContainText(DEMO_ZONE.DRIFT)
  await expect(item).not.toContainText(DEMO_ZONE.EXCEPTION)
  await item.getByRole("button", { name: /^Review alignment/ }).click()
  const confirmation = page.locator("#confirm-dialog")
  await expect(confirmation).toContainText(DEMO_ZONE.DRIFT)
  await confirmation.getByRole("checkbox", { name: "I reviewed the targets, value changes, and API writes above" }).check()
  await confirmation.getByRole("button", { name: "Apply and verify" }).click()
  await expect(item).toHaveCount(0)
  expect(demo.settingValue(DEMO_ZONE.DRIFT, "always_use_https")).toBe("on")
  expect(demo.settingValue(DEMO_ZONE.EXCEPTION, "always_use_https")).toBe("off")
  const writes = demo.requests.filter((request) => request.method === "PATCH")
  expect(writes).toHaveLength(1)
  expect(writes[0].path).toContain(`zone-${DEMO_ZONE.DRIFT}/settings/always_use_https`)
})

test("queue pairs zone evidence and exposes secondary icons through keyboard tooltips", async ({ demo }) => {
  const { page } = demo
  await page.setViewportSize({ width: 1440, height: 1000 })
  const item = page.locator(".review-queue-item").filter({ hasText: "always_use_https" })
  await expect(item.getByRole("heading", { name: "Always use HTTPS", exact: true })).toBeVisible()
  const table = item.getByRole("table", { name: "Evidence for Always use HTTPS" })
  await expect(table.getByRole("row", { name: /harbor-app.example off on/ })).toBeVisible()
  const before = await item.locator(".queue-observed-value").boundingBox()
  const after = await item.locator(".queue-expected-value").boundingBox()
  expect(Math.abs(before.y - after.y)).toBeLessThan(1)
  const compare = item.getByRole("button", { name: "Compare values: always_use_https", exact: true })
  await expect(compare.locator("svg")).toHaveAttribute("aria-hidden", "true")
  const size = await compare.boundingBox()
  expect(size.width).toBeGreaterThanOrEqual(44)
  expect(size.height).toBeGreaterThanOrEqual(44)
  await compare.focus()
  await expect(compare.locator(".tooltip")).toBeVisible()
  await compare.press("Escape")
  await expect(compare.locator(".tooltip")).toBeHidden()
  await expect(compare).toBeFocused()
  await compare.press("Enter")
  await expect(page.getByRole("dialog", { name: "always_use_https", exact: true })).toBeVisible()
})

test("compound queue values stay readable and contained at narrow widths", async ({ demo }) => {
  const { page } = demo
  const alias = page.locator(".review-queue-item").filter({ hasText: "Canonical web passthrough" })
  await expect(alias.locator(".queue-observed-value")).toContainText("302 to https://harbor.example")
  await expect(alias.locator(".queue-expected-value")).toContainText("307 to https://harbor.example")
  await expect(alias).toContainText("Required reads are incomplete")
  for (const width of [1440, 960, 720, 620, 390, 320]) {
    await page.setViewportSize({ width, height: 900 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    expect(await alias.locator(".queue-evidence-table").evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true)
  }
})

test("long facet names stay contained when an icon tooltip receives keyboard focus", async ({ demo }) => {
  const { page } = demo
  await page.evaluate(async () => {
    const { renderReviewQueue } = await import(new URL("src/review-workspace.mjs", location.href).href)
    const label = `TXT ${"a".repeat(220)}.example`
    renderReviewQueue(document.querySelector("#review-queue-list"), {
      items: [{ id: "long-facet", kind: "misalignment", label, facet: { category: "DNS records", key: label }, zoneCount: 1, expected: "b".repeat(240), observed: [{ zoneName: `${"long-zone-".repeat(10)}.example`, value: "a".repeat(240) }], reason: "Observed configuration differs from saved intent; some saved intent also needs review" }],
    }, () => [{ label: "Compare values", icon: "inspect", iconOnly: true, run() {} }])
  })
  const button = page.locator("#review-queue-list button")
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 900 })
    await expect(page.locator(".queue-item-reason")).toBeVisible()
    await button.focus()
    const tooltip = button.locator(".tooltip")
    await expect(tooltip).toBeVisible()
    expect(await tooltip.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await button.press("Escape")
    await expect(tooltip).toBeHidden()
    await button.blur()
  }
})
