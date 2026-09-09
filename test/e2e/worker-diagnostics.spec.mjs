import { test, expect } from "./dashboard.fixture.mjs"

test("Worker incident journey reviews a schedule-only remedy and keeps recoverable history", async ({ dashboard }) => {
  const { page } = dashboard
  const opener = page.getByRole("button", { name: "Diagnose Worker", exact: true })
  await expect(opener.locator(".icon")).toHaveCount(1)
  await opener.hover()
  await expect(opener.locator(".tooltip")).toContainText("after an alert or unexpected runtime behavior")
  await opener.click()
  const dialog = page.getByRole("dialog", { name: "Diagnose a Worker", exact: true })
  await expect(dialog).toContainText("Use this after an alert, failed request, or unexpected scheduled behavior")
  const scope = dialog.locator(".worker-scope-disclosure")
  await expect(scope).not.toHaveAttribute("open", "")
  await scope.getByText("Evidence scope", { exact: true }).click()
  await expect(dialog.getByLabel("Window start (UTC ISO, optional)")).toBeVisible()
  await scope.getByText("Evidence scope", { exact: true }).click()
  await dialog.getByLabel("Worker name or finding ID").fill("example-worker")
  const inspect = dialog.getByRole("button", { name: "Inspect Worker", exact: true })
  await expect(inspect.locator(".icon")).toHaveCount(1)
  await inspect.hover()
  await expect(inspect.locator(".tooltip")).toHaveCSS("opacity", "1")
  await dialog.getByRole("button", { name: "Inspect Worker", exact: true }).click()
  await expect(inspect.locator(".tooltip")).toHaveCSS("opacity", "0")
  await expect(dialog.getByRole("status")).toHaveText("Inspection complete")
  await expect(dialog.locator(".worker-report .worker-fact-label")).toHaveText([
    "3 invocations",
    "1 h window",
    /Read \d{2}:\d{2}:\d{2} UTC/,
    "Logs observed",
  ])
  const invocationFact = dialog.locator(".worker-fact").filter({ hasText: "3 invocations" })
  await invocationFact.focus()
  await page.keyboard.press("Tab")
  await page.keyboard.press("Shift+Tab")
  await expect(invocationFact).toBeFocused()
  await expect(invocationFact.locator(".tooltip")).toHaveCSS("opacity", "1")
  await invocationFact.press("Escape")
  await expect(invocationFact.locator(".tooltip")).toHaveCSS("opacity", "0")
  await expect(dialog).toBeVisible()
  for (const selector of [".dialog-kicker", ".worker-fact", "th", "td", ".worker-json-details summary"]) {
    const sizes = await dialog.locator(selector).evaluateAll((nodes) => (
      nodes.map((node) => Number.parseFloat(getComputedStyle(node).fontSize))
    ))
    expect(sizes.every((size) => size >= 11)).toBe(true)
  }
  await expect(dialog.getByRole("heading", { name: "HTTP responses on this page" })).toBeVisible()
  await expect(dialog.getByRole("region", {
    name: "Invocation outcomes on this page table",
  })).toHaveAttribute("tabindex", "0")
  await expect(dialog.getByRole("region", {
    name: "HTTP responses on this page table",
  })).toHaveAttribute("tabindex", "0")
  await expect(dialog.getByText(
    "Known error signatures: missing-scheduled-handler",
    { exact: true },
  )).toBeVisible()
  await expect(dialog.locator(".worker-supporting-details > details")).toHaveCount(3)
  await expect(dialog).not.toContainText("PRIVATE-PAYLOAD-MUST-NOT-ESCAPE")
  await dialog.getByRole("button", { name: "Record incident", exact: true }).click()
  await expect(dialog.getByRole("status")).toContainText("Saved incident-")
  await dialog.getByText("Schedule intent, reviewed changes and recovery", { exact: true }).click()
  await dialog.getByRole("combobox", { name: "Schedule intent", exact: true }).selectOption("disabled")
  await dialog.getByLabel("Owning deployment configuration").fill("example-project:wrangler.jsonc")
  await dialog.getByLabel("Reviewed configuration reconciliation step").fill("Set triggers.crons to [] before deployment")
  await dialog.getByRole("button", { name: "Review intent save", exact: true }).click()
  await expect(dialog.getByRole("button", { name: "Apply reviewed change" })).toBeDisabled()
  await dialog.getByRole("checkbox").check()
  await dialog.getByRole("button", { name: "Apply reviewed change" }).click()
  await expect(dialog.getByRole("status")).toHaveText("saved")
  await dialog.getByRole("button", { name: "Review schedule change", exact: true }).click()
  await expect(dialog.getByRole("button", { name: "Apply reviewed change" })).toBeDisabled()
  expect(dashboard.requests.filter((request) => request.method === "PUT" && request.path.endsWith("/schedules"))).toHaveLength(0)
  await dialog.getByRole("checkbox").check()
  await dialog.getByRole("button", { name: "Apply reviewed change" }).click()
  await expect(dialog.getByRole("status")).toHaveText("propagation-pending")
  expect(dashboard.requests.filter((request) => request.method === "PUT" && request.path.endsWith("/schedules"))).toHaveLength(1)
  await dialog.getByRole("button", { name: "Verify after change" }).click()
  await expect(dialog.getByRole("status")).toHaveText("propagation-pending")
  await dialog.getByRole("button", { name: "Load history and intent" }).click()
  await expect(dialog.getByText(/supersedes incident-/)).toBeVisible()
  await dialog.getByRole("button", { name: "Review guarded undo" }).click()
  await dialog.getByRole("checkbox").check()
  await dialog.getByRole("button", { name: "Apply reviewed change" }).click()
  await expect(dialog.getByRole("status")).toHaveText("propagation-pending")
})

test("read-only dashboard exposes Worker inspection without mutation controls", async ({ readOnlyDashboard }) => {
  const { page } = readOnlyDashboard
  await page.getByRole("button", { name: "Diagnose Worker", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: "Diagnose a Worker", exact: true })
  await dialog.getByLabel("Worker name or finding ID").fill("example-worker")
  await dialog.getByRole("button", { name: "Inspect Worker", exact: true }).click()
  await expect(dialog.getByRole("status")).toHaveText("Inspection complete")
  await expect(dialog.getByRole("button", { name: "Record incident" })).toBeDisabled()
  await dialog.getByText("Schedule intent, reviewed changes and recovery", { exact: true }).click()
  await dialog.getByRole("combobox", { name: "Schedule intent", exact: true }).selectOption("disabled")
  await dialog.getByLabel("Owning deployment configuration").fill("example-project:wrangler.jsonc")
  await dialog.getByLabel("Reviewed configuration reconciliation step").fill("Set triggers.crons to [] before deployment")
  await dialog.getByRole("button", { name: "Review schedule change", exact: true }).click()
  await dialog.getByRole("checkbox").check()
  await expect(dialog.getByRole("button", { name: "Apply reviewed change" })).toBeDisabled()
})
