import { test, expect } from "./dashboard.fixture.mjs"

const VIEWPORTS = [
  { width: 1440, height: 1000 },
  { width: 1920, height: 1080 },
  { width: 768, height: 1024 },
  { width: 390, height: 844 },
  { width: 1280, height: 600 },
]

async function expectWorkspaceBounds(dialog, viewport) {
  const bounds = await dialog.boundingBox()
  expect(bounds.width).toBeCloseTo(Math.min(1680, viewport.width - 24), 0)
  expect(bounds.x).toBeGreaterThanOrEqual(11)
  expect(bounds.y).toBeGreaterThanOrEqual(11)
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width - 11)
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height - 11)
  expect(await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true)
}

test("information-heavy dialogs use available desktop space and stay within smaller viewports", async ({ dashboard }) => {
  const { page } = dashboard
  for (const viewport of VIEWPORTS) {
    await page.setViewportSize(viewport)
    await page.getByRole("button", { name: "Manage fleet intent", exact: true }).click()
    const intent = page.getByRole("dialog", { name: "Fleet intent", exact: true })
    await expectWorkspaceBounds(intent, viewport)
    expect((await intent.boundingBox()).height).toBeGreaterThan(viewport.height - 30)
    await expect(intent.getByRole("button", { name: "Done", exact: true })).toBeInViewport()
    await intent.getByRole("button", { name: "Done", exact: true }).click()

    await page.getByRole("button", { name: /^Activity / }).click()
    const activity = page.getByRole("dialog", { name: "Operation history", exact: true })
    await expectWorkspaceBounds(activity, viewport)
    await activity.getByRole("button", { name: "Close operation history" }).click()

    await page.getByRole("button", { name: "Workers", exact: true }).click()
    const workers = page.getByRole("dialog", { name: "Worker diagnostics", exact: true })
    await workers.getByLabel("Worker name or finding ID").fill("example-worker")
    await workers.getByRole("button", { name: "Inspect Worker", exact: true }).click()
    await expect(workers.getByRole("status")).toContainText("Trigger compatibility: mismatch")
    await expectWorkspaceBounds(workers, viewport)
    await workers.getByRole("button", { name: "Close", exact: true }).click()
  }
})
