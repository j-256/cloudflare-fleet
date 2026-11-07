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
