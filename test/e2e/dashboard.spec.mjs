import {
  expect,
  test,
} from "./dashboard.fixture.mjs"

const MINIMUM_VISIBLE_FONT_SIZE = 11

async function expectKeyboardTooltip(control) {
  const tooltip = control.locator(":scope > .tooltip")
  await control.focus()
  await expect(tooltip).toHaveCSS("opacity", "1")
  await control.press("Escape")
  await expect(tooltip).toHaveCSS("opacity", "0")
}

async function expectLegibleSurface(surface, options = {}) {
  await expect(surface.locator("[title]")).toHaveCount(0)
  if (options.checkOverflow !== false) {
    expect(await surface.evaluate(
      (node) => node.scrollWidth <= node.clientWidth + 1,
    )).toBe(true)
  }
  const undersized = await surface.locator("*").evaluateAll(
    (nodes, minimumSize) => nodes.filter((node) => {
      const style = getComputedStyle(node)
      return node.getClientRects().length > 0
        && style.display !== "none"
        && style.visibility !== "hidden"
        && Number.parseFloat(style.fontSize) < minimumSize
    }).map((node) => ({
      className: String(node.className),
      fontSize: getComputedStyle(node).fontSize,
      tagName: node.tagName,
    })),
    MINIMUM_VISIBLE_FONT_SIZE,
  )
  expect(undersized).toEqual([])
}

test("loads the cached fleet into a useful review surface", async ({ dashboard }) => {
  const { page } = dashboard

  await expect(page).toHaveTitle("Cloudflare Fleet | Read/write")
  await expect(page.locator("#status-text")).toHaveText("Cached fleet ready")
  await expect(page.locator("#zone-count")).toHaveText("3")
  await expect(page.getByRole("heading", { name: "What do you want to do?" })).toBeVisible()
  await expect(page.locator("#visible-count")).toContainText("facets")
  await expect.poll(() => page.locator("#matrix-body tr").count()).toBeGreaterThan(0)
  await expect(page.locator("#write-readiness")).toHaveText(
    "Writes live-validated before confirmation",
  )
})

test("refresh recovers from a proxied rate limit using the upstream retry delay", async ({ dashboard }) => {
  const { allowBrowserError, page, queueFailure, requests } = dashboard
  allowBrowserError(/429/)
  queueFailure({
    headers: { "Retry-After": "2" },
    method: "GET",
    path: "zones",
    status: 429,
  })
  const rateLimitedResponse = page.waitForResponse((response) => (
    response.status() === 429 && new URL(response.url()).pathname.endsWith("/zones")
  ))

  await page.locator("#refresh").click()

  const response = await rateLimitedResponse
  expect(response.headers()["retry-after"]).toBe("2")
  await expect(page.locator("#status-text")).toHaveText("Fleet loaded")
  await expect(page.locator("#zone-count")).toHaveText("3")
  expect(requests.filter((request) => request.path.startsWith("zones?"))).toHaveLength(2)
  expect(requests.every((request) => request.method === "GET")).toBe(true)
})

test("filters the matrix and preserves the view in the address bar", async ({ dashboard }) => {
  const { page } = dashboard
  const matrixRows = page.locator("#matrix-body tr")
  const initialCount = await matrixRows.count()

  await page.getByPlaceholder("Search facets, values, or zones").fill("always_use_https")

  await expect.poll(() => matrixRows.count()).toBeLessThan(initialCount)
  await expect(matrixRows).toHaveCount(1)
  await expect(matrixRows.locator(".facet-title-value")).toHaveText("always_use_https")
  await expect.poll(() => new URL(page.url()).searchParams.get("q")).toBe(
    "always_use_https",
  )

  await page.getByRole("button", { name: "Reset matrix filters and sort" }).click()

  await expect(matrixRows).toHaveCount(initialCount)
  await expect.poll(() => new URL(page.url()).search).toBe("")
})

test("keeps secondary filters usable on a phone viewport", async ({ dashboard }) => {
  const { page } = dashboard
  await page.setViewportSize({ height: 844, width: 390 })

  const filterToggle = page.getByRole("button", { name: /Filters & sort/ })
  await expect(filterToggle).toBeVisible()
  await expect(page.getByLabel("Filter by fleet coverage")).not.toBeVisible()

  await filterToggle.click()

  await expect(page.getByLabel("Filter by fleet coverage")).toBeVisible()
  await page.getByLabel("Filter by fleet coverage").selectOption("all")
  await expect.poll(() => new URL(page.url()).searchParams.get("scope")).toBe("all")
})

test("keeps dense matrix controls legible and self-explanatory", async ({ dashboard }) => {
  const { page, zoneNames } = dashboard
  const capability = page.locator(".capability-key .capability-chip.observe")
  await expect(capability.locator(":scope > .icon")).toHaveCount(1)
  await capability.focus()
  await expect(capability.locator(":scope > .tooltip")).toHaveCSS("opacity", "1")
  await capability.press("Escape")
  await expect(capability.locator(":scope > .tooltip")).toHaveCSS("opacity", "0")

  await expect(page.locator(".category-capability-fact")).toHaveCount(4)
  const edit = page.getByRole("button", {
    name: `Edit always_use_https on ${zoneNames[0]}`,
  })
  await expect(edit).toHaveClass(/matrix-icon-action/)
  await expect(edit.locator(":scope > .icon")).toHaveCount(1)
  await expect(edit.locator(":scope > .control-label")).toHaveCount(0)
  await edit.hover()
  await expect(edit.locator(":scope > .tooltip")).toHaveCSS("opacity", "1")

  const comparisonStatus = page.locator("#matrix .cell-comparison-status").first()
  await expect(comparisonStatus.locator(":scope > .icon")).toHaveCount(1)
  await expect(page.locator(".configuration-explorer [title]")).toHaveCount(0)

  await page.setViewportSize({ height: 844, width: 390 })
  const undersized = await page.locator(".configuration-explorer *").evaluateAll(
    (nodes, minimumSize) => nodes.filter((node) => {
      const style = getComputedStyle(node)
      return node.getClientRects().length > 0
        && style.display !== "none"
        && style.visibility !== "hidden"
        && Number.parseFloat(style.fontSize) < minimumSize
    }).map((node) => ({
      className: String(node.className),
      fontSize: getComputedStyle(node).fontSize,
      tagName: node.tagName,
    })),
    MINIMUM_VISIBLE_FONT_SIZE,
  )
  expect(undersized).toEqual([])
  expect(await page.evaluate(
    () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
  )).toBe(true)
})

test("selects target zones and restores the selection after reload", async ({ dashboard }) => {
  const { page, waitForReady, zoneNames } = dashboard

  await page.locator("#matrix-choose-targets").click()
  const dialog = page.getByRole("dialog", { name: "Choose zones" })
  await expect(dialog).toBeVisible()
  await expect(dialog.locator("#target-scope-fact > .icon")).toHaveCount(1)
  await expect(dialog.locator(".target-option-status > .icon")).toHaveCount(3)
  const selectAll = dialog.getByRole("button", { name: "Select all" })
  await expect(selectAll.locator(":scope > .icon")).toHaveCount(1)
  await expectKeyboardTooltip(selectAll)
  await expect(dialog).toBeVisible()
  await expectLegibleSurface(dialog)
  await dialog.getByRole("checkbox", { name: new RegExp(zoneNames[0]) }).check()
  await dialog.getByRole("checkbox", { name: new RegExp(zoneNames[1]) }).check()
  await dialog.getByRole("button", { name: "Done" }).click()

  await expect(page.locator("#selection-count")).toHaveText("2")
  await page.locator("#selected-columns-only").click()
  await expect(
    page.locator(`.zone-heading[data-zone-id="zone-${zoneNames[2]}"]`),
  ).toHaveClass(/matrix-column-hidden/)
  await expect.poll(() => new URL(page.url()).searchParams.get("cols")).toBe("1")

  await page.reload({ waitUntil: "domcontentloaded" })
  await waitForReady()

  await expect(page.locator("#selection-count")).toHaveText("2")
  await expect(page.locator("#selected-columns-only")).toHaveAttribute(
    "aria-pressed",
    "true",
  )
})

test("persists a saved intent scope and lets browser Back exit the workspace", async ({ dashboard }) => {
  const { page, waitForReady, zoneNames } = dashboard

  await page.getByRole("button", { name: "Manage fleet intent" }).click()
  const intentDialog = page.getByRole("dialog", { name: "Fleet intent" })
  await expect(intentDialog).toBeVisible()
  await expect.poll(() => new URL(page.url()).searchParams.get("panel")).toBe("intent")
  await intentDialog.getByRole("button", { name: /^Groups/ }).click()
  await intentDialog.getByRole("button", { name: "Create saved scope" }).click()

  const scopeDialog = page.getByRole("dialog", { name: "New saved scope" })
  await expect(
    scopeDialog.locator("#intent-group-membership-fact > .icon"),
  ).toHaveCount(1)
  await expect(
    scopeDialog.getByRole("button", { name: "Select visible" })
      .locator(":scope > .icon"),
  ).toHaveCount(1)
  await expect(scopeDialog.locator(
    "#intent-group-selection-summary .intent-zone-scope-row > strong > .icon",
  )).toHaveCount(2)
  await expectLegibleSurface(scopeDialog)
  await scopeDialog.getByRole("checkbox", { name: zoneNames[0] }).check()
  await scopeDialog.getByRole("checkbox", { name: zoneNames[1] }).check()
  await scopeDialog.getByRole("textbox", { name: /Custom name/ }).fill("Primary sites")
  await scopeDialog.getByRole("button", { name: "Save scope" }).click()

  await expect(intentDialog).toBeVisible()
  await expect(intentDialog).toContainText("Primary sites")
  await page.goBack()
  await expect(intentDialog).not.toBeVisible()
  await expect.poll(() => new URL(page.url()).searchParams.get("panel")).toBeNull()

  await page.reload({ waitUntil: "domcontentloaded" })
  await waitForReady()
  await page.getByRole("button", { name: "Manage fleet intent" }).click()
  await intentDialog.getByRole("button", { name: /^Groups/ }).click()
  await expect(intentDialog).toContainText("Primary sites")
})

test("applies and verifies a setting change through the reviewed write flow", async ({ dashboard }) => {
  const { page, requests, settingValue, zoneNames } = dashboard
  const targetZone = zoneNames[1]

  await page.getByPlaceholder("Search facets, values, or zones").fill("always_use_https")
  await page.getByRole("button", {
    name: `Edit always_use_https on ${targetZone}`,
  }).click()
  const inlineEditor = page.locator("form.inline-value-editor")
  const inlineReview = inlineEditor.getByRole("button", { name: "Review" })
  await expect(inlineReview.locator(":scope > .icon")).toHaveCount(1)
  await expectKeyboardTooltip(inlineReview)
  await expectLegibleSurface(inlineEditor, { checkOverflow: false })
  await inlineEditor.getByLabel("Desired value").fill("on")
  await inlineReview.click()

  const confirmation = page.getByRole("dialog", { name: "Update zone setting" })
  await expect(confirmation).toBeVisible()
  await expect(confirmation).toContainText("PATCH")
  await expect(confirmation).toContainText(
    `zones/zone-${targetZone}/settings/always_use_https`,
  )
  await confirmation.getByRole("checkbox", {
    name: "I reviewed the targets, value changes, and API writes above",
  }).check()
  await confirmation.getByRole("button", { name: "Apply and verify" }).click()

  await expect(page.locator("#toast-message")).toHaveText(
    "Writes succeeded and live verification passed",
  )
  await expect.poll(() => settingValue(targetZone, "always_use_https")).toBe("on")
  expect(requests.filter((request) => request.method === "PATCH")).toHaveLength(1)
  expect(requests.filter((request) => (
    request.method === "GET"
      && request.path.endsWith("settings/always_use_https")
  )).length).toBeGreaterThanOrEqual(2)

  await page.getByRole("button", { name: /Activity 1:/ }).click()
  const activity = page.getByRole("dialog", { name: "Operation history" })
  await expect(activity).toContainText("Update zone setting")
  await expect(activity).toContainText("Verified")
  const refreshHistory = activity.getByRole("button", { name: "Refresh history" })
  await expect(refreshHistory.locator(":scope > .icon")).toHaveCount(1)
  await expectKeyboardTooltip(refreshHistory)
  const guardedUndo = activity.getByRole("button", { name: "Review guarded undo" })
  await expect(guardedUndo.locator(":scope > .icon")).toHaveCount(1)
  await expectLegibleSurface(activity)
})

test("keeps the ruleset workspace and desired-state editor legible", async ({ dashboard }) => {
  const { page } = dashboard

  await page.locator("#category").selectOption("Ruleset rules")
  await page.getByRole("button", {
    name: /^Open the parent ruleset for Protect service on /,
  }).first().click()

  const ruleset = page.locator("#ruleset-dialog")
  await expect(ruleset).toBeVisible()
  await expect(ruleset.locator(".ruleset-metadata-badge > .icon"))
    .toHaveCount(3)
  await expect(ruleset.locator(".rule-card-badge > .icon")).toHaveCount(2)
  const edit = ruleset.getByRole("button", { name: "Edit Protect service" })
  await expect(edit).toHaveClass(/ruleset-icon-action/)
  await expect(edit.locator(":scope > .icon")).toHaveCount(1)
  await expect(edit.locator(":scope > .control-label")).toHaveCount(0)
  await expectKeyboardTooltip(edit)
  await expect(ruleset).toBeVisible()
  await expectLegibleSurface(ruleset)

  await edit.click()
  const editor = page.locator("#editor-dialog")
  await expect(editor).toBeVisible()
  await expect(editor.locator("#editor-target .dialog-context-fact > .icon"))
    .toHaveCount(1)
  const review = editor.getByRole("button", { name: "Review desired state" })
  await expect(review.locator(":scope > .icon")).toHaveCount(1)
  await expectKeyboardTooltip(review)
  await expect(editor).toBeVisible()
  await expectLegibleSurface(editor)
})
