import { expect, test } from "./dashboard.fixture.mjs"

test("starts with qualified review queues and readable concrete decisions", async ({ dashboard }) => {
  const { page } = dashboard
  await expect(page.getByRole("heading", { name: "Review queues", exact: true })).toBeInViewport()
  await expect(page.locator("#review-queue-status")).toContainText("Define intent")
  await page.getByRole("button", { name: /^Decisions needed/ }).click()
  const item = page.locator(".review-queue-item").filter({ hasText: "always_use_https" })
  await expect(item).toContainText("on")
  await expect(item).toContainText("off")
  await expect(item).toContainText("No expected state saved")
  const size = await item.locator(".queue-observed-value").first().evaluate((node) => parseFloat(getComputedStyle(node).fontSize))
  expect(size).toBeGreaterThanOrEqual(14)
  await item.getByRole("button", { name: /^Compare/ }).click()
  await expect(page.getByRole("dialog", { name: "always_use_https", exact: true })).toBeVisible()
})

test("saved intent creates work that clears only after a reviewed verified correction", async ({ dashboard }) => {
  const { page } = dashboard
  await page.getByRole("button", { name: /^Decisions needed/ }).click()
  const decision = page.locator(".review-queue-item").filter({ hasText: "always_use_https" })
  await decision.getByRole("button", { name: /^Compare/ }).click()
  const comparison = page.getByRole("dialog", { name: "always_use_https", exact: true })
  await comparison.getByRole("button", { name: "Use as exact intent: Fleet consensus for always_use_https" }).click()
  await page.locator("#intent-policy-save").click()
  await page.getByRole("button", { name: /^Misalignments/ }).click()
  const item = page.locator(".review-queue-item").filter({ hasText: "always_use_https" })
  await expect(item).toContainText("bravo.example")
  await item.getByRole("button", { name: /^Review alignment/ }).click()
  const review = page.locator("#confirm-dialog")
  await expect(review).toBeVisible()
  const size = await review.locator(".operation-change-content").first().evaluate((node) => parseFloat(getComputedStyle(node).fontSize))
  expect(size).toBeGreaterThanOrEqual(14)
  await review.getByRole("checkbox", { name: "I reviewed the targets, value changes, and API writes above" }).check()
  await review.getByRole("button", { name: "Apply and verify" }).click()
  await expect(item).toHaveCount(0)
  await expect(page.locator("#review-queue-status")).toContainText("Read gaps")
  await expect(page.locator("#review-queue-list")).toContainText("No misalignments")
})

test("read-only queues preserve comparison without offering intent or alignment writes", async ({ readOnlyDashboard }) => {
  const { page } = readOnlyDashboard
  await page.getByRole("button", { name: /^Decisions needed/ }).click()
  await expect(page.locator("#review-queue-list").getByRole("button", { name: /^Set intent|^Review alignment/ })).toHaveCount(0)
  await page.locator(".review-queue-item").filter({ hasText: "always_use_https" }).getByRole("button", { name: /^Compare/ }).click()
  await expect(page.getByRole("dialog", { name: "always_use_https", exact: true })).toBeVisible()
})

test("a shared wrong value still opens useful evidence from its misalignment", async ({ dashboard }) => {
  const { page, setSettingValue, zoneNames } = dashboard
  await page.locator(".review-queue-item").filter({ hasText: "always_use_https" }).getByRole("button", { name: /^Compare/ }).click()
  await page.getByRole("button", { name: "Use as exact intent: Fleet consensus for always_use_https" }).click()
  await page.locator("#intent-policy-save").click()
  for (const zone of zoneNames) setSettingValue(zone, "always_use_https", "off")
  await page.locator("#refresh").click()
  await dashboard.waitForReady()
  await page.getByRole("button", { name: /^Misalignments/ }).click()
  const item = page.locator(".review-queue-item").filter({ hasText: "always_use_https" })
  await expect(item).toContainText("3 zones")
  await item.getByRole("button", { name: /^Compare/ }).click()
  const comparison = page.getByRole("dialog", { name: "always_use_https", exact: true })
  await expect(comparison).toBeVisible()
  await expect(comparison).toContainText("1 normalized value is present")
  await expect(comparison).toContainText("off")
})

test("mobile matrix focus contains controls and keeps its exit reachable", async ({ dashboard }) => {
  const { page } = dashboard
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole("navigation", { name: "Fleet sections" }).getByRole("link", { name: "Configuration", exact: true }).click()
  await page.locator("#mobile-matrix-focus").click()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await expect(page.locator("#mobile-matrix-focus")).toBeInViewport()
  await page.locator("#mobile-matrix-focus").click()
  await expect(page.getByRole("heading", { name: "Review queues", exact: true })).toBeVisible()
})

test("phone comparison presents differing fields without horizontal table traversal", async ({ dashboard }) => {
  const { page } = dashboard
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole("button", { name: /^Decisions needed/ }).click()
  await page.locator(".review-queue-item").filter({ hasText: "always_use_https" }).getByRole("button", { name: /^Compare/ }).click()
  const comparison = page.getByRole("dialog", { name: "always_use_https", exact: true })
  const fields = comparison.locator(".value-comparison-table")
  await expect(fields).toBeVisible()
  await expect(fields).toContainText("on")
  await expect(fields).toContainText("off")
  expect(await fields.evaluate((node) => node.getBoundingClientRect().width <= node.closest(".value-comparison-table-wrap").clientWidth)).toBe(true)
})

test("read-health rows retain specific evidence rather than generic failure placeholders", async ({ dashboard }) => {
  const { page } = dashboard
  await page.getByRole("button", { name: /^Read health/ }).click()
  await expect(page.locator("#review-queue-list")).toContainText("Legacy Page Rules")
  await expect(page.locator("#review-queue-list")).toContainText("account-owned tokens")
})

test("narrow queues put actionable evidence in the initial viewport", async ({ dashboard }) => {
  const { page } = dashboard
  await page.locator(".review-queue-item").filter({ hasText: "always_use_https" }).getByRole("button", { name: /^Compare/ }).click()
  await page.getByRole("button", { name: "Use as exact intent: Fleet consensus for always_use_https" }).click()
  await page.locator("#intent-policy-save").click()
  await page.getByRole("button", { name: /^Misalignments/ }).click()
  await page.setViewportSize({ width: 320, height: 720 })
  await page.evaluate(() => scrollTo(0, 0))
  const item = page.locator(".review-queue-item").filter({ hasText: "always_use_https" })
  await expect(item.locator(".queue-observed-value")).toBeInViewport({ ratio: 1 })
  await expect(item.getByRole("button", { name: /^Review alignment/ })).toBeInViewport({ ratio: 1 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})
