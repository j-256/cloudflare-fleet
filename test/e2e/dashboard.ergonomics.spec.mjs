import {
  expect,
  test,
} from "./dashboard.fixture.mjs"
import {
  beginErgonomicsJourney,
} from "./ergonomics.mjs"

const SETTING_ID = "always_use_https"
const LARGE_COMPARISON_MINIMUM = 5
const MAX_VALUE_GROUP_PANES = 2

async function reviewSettingChange(page, zoneName, desiredValue) {
  await page.getByPlaceholder("Search facets, values, or zones").fill(SETTING_ID)
  await page.getByRole("button", {
    name: `Edit ${SETTING_ID} on ${zoneName}`,
  }).click()
  const editor = page.locator("form.inline-value-editor")
  await editor.getByLabel("Desired value").fill(desiredValue)
  await editor.getByRole("button", { name: "Review" }).click()
  return page.locator("#confirm-dialog")
}

async function acceptCurrentWrite(page) {
  const confirmation = page.locator("#confirm-dialog")
  await confirmation.getByRole("checkbox", {
    name: "I reviewed the targets, value changes, and API writes above",
  }).check()
  await confirmation.getByRole("button", { name: "Apply and verify" }).click()
  await expect(page.locator("#toast-message")).toContainText(
    "live verification passed",
  )
}

test("cautious reviewer understands a scalar difference without decoding a merged token", async ({ dashboard }, testInfo) => {
  const { page } = dashboard
  const journey = await beginErgonomicsJourney(page, testInfo, {
    persona: "Cautious reviewer",
    task: "Understand one ungoverned scalar difference",
  })
  const review = page.locator("#review-ungoverned-differences")
  await expect(review).toContainText("ungoverned differences")
  await journey.requireInViewport(review, "Ungoverned differences task")
  await journey.click(review, "Review ungoverned differences")
  await journey.click(page.getByRole("button", {
    name: `Compare 2 values: Observed values for ${SETTING_ID}`,
  }), "Compare always_use_https values")

  const comparison = page.getByRole("dialog", { name: SETTING_ID })
  const difference = comparison.locator(".value-comparison-table tbody tr").first()
  await expect(difference.locator("td").nth(0)).toHaveText("on")
  await expect(difference.locator("td").nth(1)).toHaveText("off")
  await journey.capture("scalar-comparison")
  await journey.click(comparison.getByRole("button", { name: "Done" }), "Close comparison")
  await journey.finish({
    automaticHorizontalViewport: 0,
    automaticVerticalViewport: 1.2,
    disclosures: 0,
    manualHorizontalViewport: 0,
    manualVerticalViewport: 0,
    reversals: 0,
    totalInteractions: 3,
  })
})

test("returning operator verifies a known setting change without opening raw JSON", async ({ dashboard }, testInfo) => {
  const { page, settingValue, zoneNames } = dashboard
  const targetZone = zoneNames[1]
  const journey = await beginErgonomicsJourney(page, testInfo, {
    persona: "Returning operator",
    task: "Change always_use_https from off to on",
  })
  const browse = page.getByRole("button", { name: "Browse matrix change paths" })
  await journey.requireInViewport(browse, "Supported changes task")
  await journey.click(browse, "Browse supported changes")
  await journey.fill(
    page.getByPlaceholder("Search facets, values, or zones"),
    SETTING_ID,
    "Find always_use_https",
  )
  await journey.click(page.getByRole("button", {
    name: `Edit ${SETTING_ID} on ${targetZone}`,
  }), "Edit target setting")
  const editor = page.locator("form.inline-value-editor")
  await journey.fill(editor.getByLabel("Desired value"), "on", "Enter desired value")
  await journey.click(editor.getByRole("button", { name: "Review" }), "Review change")

  const confirmation = page.getByRole("dialog", { name: "Update zone setting" })
  const change = confirmation.locator(".operation-change")
  await expect(change.getByText("Before", { exact: true })).toBeVisible()
  await expect(change.getByText("off", { exact: true })).toBeVisible()
  await expect(change.getByText("After", { exact: true })).toBeVisible()
  await expect(change.getByText("on", { exact: true })).toBeVisible()
  await expect(confirmation.locator("details")).not.toHaveAttribute("open", "")
  await journey.capture("friendly-confirmation")
  await journey.click(confirmation.getByRole("checkbox", {
    name: "I reviewed the targets, value changes, and API writes above",
  }), "Acknowledge reviewed change")
  await journey.click(
    confirmation.getByRole("button", { name: "Apply and verify" }),
    "Apply and verify",
  )
  await expect.poll(() => settingValue(targetZone, SETTING_ID)).toBe("on")
  await journey.finish({
    automaticHorizontalViewport: 0,
    automaticVerticalViewport: 1.2,
    disclosures: 0,
    inputs: 2,
    manualHorizontalViewport: 0,
    manualVerticalViewport: 0,
    reversals: 0,
    totalInteractions: 7,
  })
})

test("reviewed write keeps safety facts visible and tooltips dismissible", async ({ dashboard }) => {
  const { page, zoneNames } = dashboard
  const confirmation = await reviewSettingChange(page, zoneNames[1], "on")
  const facts = confirmation.getByRole("list", {
    name: "Live validation and write summary",
  })
  const factItems = facts.getByRole("listitem")
  await expect(factItems).toHaveCount(4)
  await expect(
    facts.locator('[data-confirm-fact="validated"]'),
  ).toContainText(/^Validated /)
  await expect(
    facts.locator('[data-confirm-fact="scopes"]'),
  ).toContainText("1 resource scope")
  await expect(
    facts.locator('[data-confirm-fact="writes"]'),
  ).toContainText("1 API write")
  await expect(
    facts.locator('[data-confirm-fact="verification"]'),
  ).toContainText("Re-read to verify")

  const validated = facts.locator('[data-confirm-fact="validated"]')
  const tooltip = validated.locator(".tooltip")
  await validated.hover()
  await expect(tooltip).toBeVisible()
  await page.mouse.move(0, 0)
  await expect(tooltip).toBeHidden()
  await validated.focus()
  await expect(tooltip).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(tooltip).toBeHidden()
  await expect(confirmation).toBeVisible()
  await validated.click()
  await expect(tooltip).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(confirmation).toBeVisible()

  const operation = confirmation.locator(".operation").first()
  await expect(operation.locator(".operation-method")).toContainText("PATCH")
  await expect(operation.locator(".operation-target-label")).toHaveText("Target")
  await expect(operation.locator(".operation-path")).toContainText(
    "settings/always_use_https",
  )
  await expect(confirmation.getByRole("button", {
    name: "Close write confirmation",
  }).locator(".icon")).toHaveCount(1)
  await expect(confirmation.getByRole("button", {
    name: "Apply and verify",
  })).toBeDisabled()

  const fontSizes = await confirmation.locator([
    ".confirm-fact",
    ".operation-method code",
    ".operation-target-label",
    ".operation-path",
    ".operation-context",
    ".operation-change-label",
    ".operation-change-content",
    ".operation-change-arrow",
  ].join(", ")).evaluateAll((nodes) => nodes.map(
    (node) => Number.parseFloat(getComputedStyle(node).fontSize),
  ))
  expect(Math.min(...fontSizes)).toBeGreaterThanOrEqual(11)

  await page.setViewportSize({ height: 844, width: 390 })
  await expect(confirmation).toBeInViewport()
  expect(await confirmation.evaluate(
    (node) => node.scrollWidth <= node.clientWidth + 1,
  )).toBe(true)
  expect(await operation.evaluate(
    (node) => node.scrollWidth <= node.clientWidth + 1,
  )).toBe(true)
  await confirmation.getByRole("button", { name: "Cancel" }).click()
})

test("operator finds and undoes a recorded setting change from Start Here", async ({ dashboard }, testInfo) => {
  const { page, settingValue, zoneNames } = dashboard
  const targetZone = zoneNames[1]
  await reviewSettingChange(page, targetZone, "on")
  await acceptCurrentWrite(page)
  await expect.poll(() => settingValue(targetZone, SETTING_ID)).toBe("on")
  await page.evaluate(() => scrollTo({ behavior: "auto", top: 0 }))

  const journey = await beginErgonomicsJourney(page, testInfo, {
    persona: "Recovery operator",
    task: "Understand and undo the most recent setting change",
  })
  const activityTask = page.locator("#review-operation-activity")
  await journey.requireInViewport(activityTask, "Operation activity task")
  await journey.click(activityTask, "Open operation activity")

  const activity = page.getByRole("dialog", { name: "Operation history" })
  const originalEntry = activity.locator(".activity-entry").filter({
    hasText: "Update zone setting",
  }).first()
  const recordedChange = originalEntry.locator(".operation-change")
  await expect(recordedChange.getByText("off", { exact: true })).toBeVisible()
  await expect(recordedChange.getByText("on", { exact: true })).toBeVisible()
  await journey.capture("recorded-change")
  await journey.click(
    originalEntry.getByRole("button", { name: "Review guarded undo" }),
    "Review guarded undo",
  )

  const confirmation = page.locator("#confirm-dialog")
  const inverse = confirmation.locator(".operation-change")
  await expect(inverse.getByText("on", { exact: true })).toBeVisible()
  await expect(inverse.getByText("off", { exact: true })).toBeVisible()
  await journey.capture("guarded-undo-confirmation")
  await journey.click(confirmation.getByRole("checkbox", {
    name: "I reviewed the targets, value changes, and API writes above",
  }), "Acknowledge reviewed undo")
  await journey.click(
    confirmation.getByRole("button", { name: "Apply and verify" }),
    "Apply and verify undo",
  )
  await expect.poll(() => settingValue(targetZone, SETTING_ID)).toBe("off")
  await expect(activity).toContainText("Undone and verified")
  await journey.capture("undo-complete")
  await journey.finish({
    automaticHorizontalViewport: 0,
    automaticVerticalViewport: 0.1,
    disclosures: 0,
    manualHorizontalViewport: 0,
    manualVerticalViewport: 0,
    reversals: 0,
    totalInteractions: 4,
  })
})

test("reviewer reaches unexpected API read issues from Start Here", async ({ dashboard }, testInfo) => {
  const { page } = dashboard
  const journey = await beginErgonomicsJourney(page, testInfo, {
    persona: "Coverage reviewer",
    task: "Inspect unexpected API read issues",
  })
  const review = page.locator("#review-coverage-issues")
  await journey.requireInViewport(review, "Unexpected read issues task")
  await journey.capture("operational-review-entry-points")
  await journey.click(review, "Review unexpected read issues")
  await expect(page.locator("#coverage-unexpected-toggle")).toHaveAttribute(
    "aria-expanded",
    "true",
  )
  await expect(page.locator("#coverage-unexpected-list")).toBeInViewport()
  await journey.capture("unexpected-read-issues")
  await journey.finish({
    automaticHorizontalViewport: 0,
    automaticVerticalViewport: 2,
    disclosures: 0,
    manualHorizontalViewport: 0,
    manualVerticalViewport: 0,
    reversals: 0,
    totalInteractions: 1,
  })
})

test("large-fleet reviewer compares one rule across many zones without horizontal traversal", async ({ denseDashboard }, testInfo) => {
  const { page } = denseDashboard
  const journey = await beginErgonomicsJourney(page, testInfo, {
    persona: "Large fleet reviewer",
    task: "Compare one rule with many fleet variants",
  })
  const review = page.locator("#review-ungoverned-differences")
  await journey.requireInViewport(review, "Ungoverned differences task")
  await journey.click(review, "Review ungoverned differences")
  await journey.select(
    page.locator("#category"),
    "Ruleset rules",
    "Limit review to individual rules",
  )
  await journey.fill(
    page.getByPlaceholder("Search facets, values, or zones"),
    "Protect service",
    "Find the named fleet rule",
  )
  await journey.click(page.getByRole("button", {
    name: /Compare \d+ values: Observed values for Protect service/,
  }), "Compare rule values")

  const comparison = page.getByRole("dialog", { name: "Protect service" })
  const groups = comparison.locator(".value-comparison-group")
  const groupCount = await groups.count()
  expect(groupCount).toBeGreaterThanOrEqual(LARGE_COMPARISON_MINIMUM)
  await expect(comparison.locator(".value-comparison-zone-list li")).toHaveCount(
    groupCount,
  )
  await expect(comparison.locator(
    "#value-comparison-differences-disclosure",
  )).not.toHaveAttribute("open", "")
  const groupPanes = await groups.first().evaluate((group) => (
    group.parentElement.getBoundingClientRect().height / innerHeight
  ))
  expect(groupPanes).toBeLessThan(MAX_VALUE_GROUP_PANES)
  expect(await page.locator("#matrix-shell").evaluate(
    (matrix) => matrix.scrollLeft,
  )).toBe(0)
  expect(await comparison.locator(".value-comparison-table-wrap").evaluate(
    (table) => table.scrollLeft,
  )).toBe(0)
  await journey.capture("individual-rule-variants")
  await journey.finish({
    automaticHorizontalViewport: 0,
    automaticVerticalViewport: 1.2,
    disclosures: 0,
    inputs: 2,
    manualHorizontalViewport: 0,
    manualVerticalViewport: 0,
    reversals: 0,
    totalInteractions: 4,
  })
})
