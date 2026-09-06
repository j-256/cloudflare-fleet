import {
  expect,
  test,
} from "./dashboard.fixture.mjs"
import {
  createHostnameScopedFreeRateLimitIntentValue,
} from "../../src/rate-limit-intent.mjs"

async function acceptCurrentWrite(page) {
  const confirmation = page.locator("#confirm-dialog")
  await expect(confirmation).toBeVisible()
  await confirmation.getByRole("checkbox", {
    name: "I reviewed the targets, value changes, and API writes above",
  }).check()
  await confirmation.getByRole("button", { name: "Apply and verify" }).click()
}

async function reviewSettingChange(page, zoneName, desiredValue) {
  await page.getByPlaceholder("Search facets, values, or zones").fill(
    "always_use_https",
  )
  await page.getByRole("button", {
    name: `Edit always_use_https on ${zoneName}`,
  }).click()
  const editor = page.locator("form.inline-value-editor")
  await editor.getByLabel("Desired value").fill(desiredValue)
  await editor.getByRole("button", { name: "Review" }).click()
  return page.locator("#confirm-dialog")
}

async function applySettingChange(page, zoneName, desiredValue) {
  await reviewSettingChange(page, zoneName, desiredValue)
  await acceptCurrentWrite(page)
  await expect(page.locator("#toast-message")).toHaveText(
    "Writes succeeded and live verification passed",
  )
}

test("turns a compared fleet value into persisted intent and undoes it", async ({ dashboard }) => {
  const { page, waitForReady } = dashboard

  await page.getByPlaceholder("Search facets, values, or zones").fill(
    "always_use_https",
  )
  await page.getByRole("button", {
    name: "Compare 2 values: Observed values for always_use_https",
  }).click()

  const comparison = page.getByRole("dialog", { name: "always_use_https" })
  await expect(comparison).toContainText("2 normalized values are present")
  await expect(comparison).toContainText("alpha.example")
  await expect(comparison).toContainText("bravo.example")
  await comparison.getByRole("button", {
    name: "Use as exact intent: Fleet consensus for always_use_https",
  }).click()

  const policy = page.getByRole("dialog", { name: "Set facet intent" })
  await expect(policy.getByRole("radio", { name: /^Required/ })).toBeChecked()
  await expect(policy.getByRole("radio", { name: /^Exact value/ })).toBeChecked()
  await expect(policy.getByRole("radio", { name: /^Fleet consensus/ })).toBeChecked()
  await policy.locator("#intent-policy-save").click()

  await expect(page.locator("#toast-message")).toHaveText(
    "always_use_https intent saved for All zones",
  )
  await expect(page.locator("#review-intent-count")).toHaveText("1")
  await page.getByRole("button", {
    name: /Undo last fleet intent change: always_use_https intent saved/,
  }).click()

  await expect(page.locator("#toast-message")).toHaveText(
    "Fleet intent change undone",
  )
  await expect(page.locator("#review-intent-count")).toHaveText("0")
  await page.reload({ waitUntil: "domcontentloaded" })
  await waitForReady()
  await page.getByPlaceholder("Search facets, values, or zones").fill(
    "always_use_https",
  )
  await expect(page.getByRole("button", {
    name: "Set intent: Set intent for always_use_https",
  })).toBeVisible()
})

test("reviews and applies exact intent alignment from a drifting cell", async ({ dashboard }) => {
  const {
    page,
    requests,
    settingValue,
    zoneNames,
  } = dashboard

  await page.getByPlaceholder("Search facets, values, or zones").fill(
    "always_use_https",
  )
  await page.getByRole("button", {
    name: "Compare 2 values: Observed values for always_use_https",
  }).click()
  const comparison = page.getByRole("dialog", { name: "always_use_https" })
  await comparison.getByRole("button", {
    name: "Use as exact intent: Fleet consensus for always_use_https",
  }).click()
  const policy = page.getByRole("dialog", { name: "Set facet intent" })
  await policy.locator("#intent-policy-save").click()
  await expect(page.locator("#toast-message")).toHaveText(
    "always_use_https intent saved for All zones",
  )

  await expect(page.getByRole("button", {
    name: "Review alignment (1): Align always_use_https with fleet intent",
  })).toBeVisible()
  await page.getByRole("button", { name: "Manage fleet intent" }).click()
  const manager = page.getByRole("dialog", { name: "Fleet intent" })
  await expect(manager.getByRole("button", {
    name: "Review alignment (1): always_use_https for All zones",
  })).toBeVisible()
  await manager.getByRole("button", { name: "Done" }).click()

  await page.getByRole("button", {
    name: `Align to intent: always_use_https on ${zoneNames[1]}`,
  }).click()
  const confirmation = page.locator("#confirm-dialog")
  await expect(confirmation).toContainText(zoneNames[1])
  await expect(confirmation).toContainText("zones/zone-bravo.example/settings/always_use_https")
  await acceptCurrentWrite(page)

  await expect(page.locator("#toast-message")).toHaveText(
    "always_use_https aligned with fleet intent and live verification passed",
  )
  await expect.poll(() => settingValue(
    zoneNames[1],
    "always_use_https",
  )).toBe("on")
  await expect(page.locator("#review-intent-count")).toHaveText("0")
  await page.locator("#intent-status").selectOption("")
  await page.locator("#difference-toggle").click()
  await expect(page.locator(
    `#matrix-body td[data-zone-id="zone-${zoneNames[1]}"]`,
  )).toHaveAttribute("data-intent-status", "match")
  expect(requests.filter((request) => (
    request.method === "GET"
      && /^zones\/[^/]+\/settings$/.test(request.path)
  ))).toHaveLength(zoneNames.length)
})

test("blocks an alignment review when its fresh surface read fails", async ({ dashboard }) => {
  const { allowBrowserError, page, queueFailure, requests, settingValue, zoneNames } = dashboard
  await page.getByPlaceholder("Search facets, values, or zones").fill("always_use_https")
  await page.getByRole("button", { name: "Compare 2 values: Observed values for always_use_https" }).click()
  await page.getByRole("dialog", { name: "always_use_https" }).getByRole("button", {
    name: "Use as exact intent: Fleet consensus for always_use_https",
  }).click()
  await page.getByRole("dialog", { name: "Set facet intent" }).locator("#intent-policy-save").click()
  await expect(page.locator("#toast-message")).toHaveText("always_use_https intent saved for All zones")
  allowBrowserError(/Failed to load resource: the server responded with a status of 503/)
  queueFailure({ method: "GET", path: `zones/zone-${zoneNames[1]}/settings`, status: 503 })
  await page.getByRole("button", { name: `Align to intent: always_use_https on ${zoneNames[1]}` }).click()
  await expect(page.locator("#toast-message")).toContainText("blocked by incomplete inventory")
  await expect(page.locator("#toast-message")).toContainText(`${zoneNames[1]}: settings`)
  await expect(page.locator("#confirm-dialog")).not.toBeVisible()
  expect(requests.filter((request) => request.method === "PATCH")).toHaveLength(0)
  expect(settingValue(zoneNames[1], "always_use_https")).toBe("off")
})

test("uses the typed alias template and reviewed alignment in the dashboard", async ({ zoneAliasDashboard }) => {
  const {
    page,
    requests,
  } = zoneAliasDashboard

  await page.locator("#category").selectOption("Zone aliases")
  await page.locator("#scope").selectOption("all")
  await page.locator("#difference-toggle").click()
  await page.getByRole("button", {
    name: "Set intent: Set intent for Canonical web passthrough",
  }).click()

  const policy = page.getByRole("dialog", { name: "Set facet intent" })
  await expect(policy.getByRole("radio", { name: /^Required/ })).toBeChecked()
  await expect(policy.getByRole("radio", { name: /^Required/ })).toBeDisabled()
  await expect(policy.getByRole("radio", { name: /^Exact value/ })).toBeChecked()
  await expect(policy.getByRole("radio", { name: /^Exact value/ })).toBeDisabled()
  await expect(policy.getByRole("radio", { name: /^Optional by zone/ })).toBeDisabled()
  await expect(policy.getByRole("radio", { name: /^May differ/ })).toBeDisabled()
  await expect(policy.locator("#intent-policy-constraint-help")).toContainText(
    "built-in j256.dev template",
  )
  await expect(policy.locator("#intent-policy-custom-raw")).toHaveValue(
    /"statusCode": 307/,
  )
  await expect(policy.locator("#intent-policy-custom-raw")).toHaveValue(
    /"targetHost": "j-256.dev"/,
  )
  await policy.locator("#intent-policy-save").click()

  await expect(page.locator("#toast-message")).toHaveText(
    "Canonical web passthrough intent saved for All zones",
  )
  await page.getByRole("button", {
    name: "Review alignment (1): Align Canonical web passthrough with fleet intent",
  }).click()
  const confirmation = page.locator("#confirm-dialog")
  await expect(confirmation).toContainText(
    "zones/zone-j256.dev/rulesets/alias-redirect-ruleset/rules/alias-redirect-rule",
  )
  await acceptCurrentWrite(page)

  await expect(page.locator("#toast-message")).toHaveText(
    "Canonical web passthrough aligned with fleet intent and live verification passed",
  )
  expect(requests.filter((request) => (
    request.method === "PATCH"
      && request.path === "zones/zone-j256.dev/rulesets/alias-redirect-ruleset/rules/alias-redirect-rule"
      && request.body.action_parameters.from_value.status_code === 307
  ))).toHaveLength(1)
})

test("keeps hostname-scoped rate limits and their WAF skip in one reviewed posture", async ({ rateLimitDashboard }) => {
  const {
    page,
    requests,
    zoneNames,
  } = rateLimitDashboard
  const desired = createHostnameScopedFreeRateLimitIntentValue({
    hosts: ["api.{zone}"],
    rateDescription: "[fleet] Limit API requests by source",
    rateExpression: "starts_with(http.request.uri.path, \"/api/\")",
    requestsPerPeriod: 100,
    skipDescription: "[fleet] Skip API rate limit on other hosts",
  })

  await page.locator("#category").selectOption("Rate limiting")
  await page.locator("#scope").selectOption("all")
  await page.locator("#difference-toggle").click()
  await page.getByRole("button", {
    name: "Set intent: Set intent for Hostname-scoped Free rate limit",
  }).click()

  const policy = page.getByRole("dialog", { name: "Set facet intent" })
  await expect(policy.getByRole("radio", { name: /^Required/ })).toBeChecked()
  await expect(policy.getByRole("radio", { name: /^Required/ })).toBeDisabled()
  await expect(policy.getByRole("radio", { name: /^Exact value/ })).toBeChecked()
  await expect(policy.getByRole("radio", { name: /^Exact value/ })).toBeDisabled()
  await expect(policy.locator("#intent-policy-constraint-help")).toContainText(
    "rate rule and its earlier WAF skip are one safety posture",
  )
  await policy.getByRole("radio", { name: /^Custom value/ }).check()
  await policy.locator("#intent-policy-custom-json").evaluate((element) => {
    element.open = true
  })
  await policy.locator("#intent-policy-custom-raw").fill(
    JSON.stringify(desired, null, 2),
  )
  await policy.locator("#intent-policy-save").click()

  await expect(page.locator("#toast-message")).toHaveText(
    "Hostname-scoped Free rate limit intent saved for All zones",
  )
  await page.getByRole("button", {
    name: "Review alignment (1): Align Hostname-scoped Free rate limit with fleet intent",
  }).click()
  const confirmation = page.locator("#confirm-dialog")
  const operations = confirmation.locator("#confirm-operations .operation")
  await expect(operations).toHaveCount(3)
  await expect(operations.nth(0)).toContainText(
    "Disable [fleet] Limit API requests by source before changing host scope",
  )
  await expect(operations.nth(1)).toContainText(
    "rate-limit-skip-ruleset/rules/rate-limit-skip-rule",
  )
  await expect(operations.nth(2)).toContainText(
    "rate-limit-ruleset/rules/rate-limit-rule",
  )
  await acceptCurrentWrite(page)

  await expect(page.locator("#toast-message")).toHaveText(
    "Hostname-scoped Free rate limit aligned with fleet intent and live verification passed",
  )
  const writes = requests.filter((request) => request.method === "PATCH")
  expect(writes.map((request) => [
    request.path,
    request.body.action,
    request.body.enabled,
  ])).toEqual([
    [
      `zones/zone-${zoneNames[0]}/rulesets/rate-limit-ruleset/rules/rate-limit-rule`,
      "block",
      false,
    ],
    [
      `zones/zone-${zoneNames[0]}/rulesets/rate-limit-skip-ruleset/rules/rate-limit-skip-rule`,
      "skip",
      true,
    ],
    [
      `zones/zone-${zoneNames[0]}/rulesets/rate-limit-ruleset/rules/rate-limit-rule`,
      "block",
      true,
    ],
  ])
})

test("aligns Email Routing settings and shows unsupported reasons", async ({ emailIntentDashboard }) => {
  const {
    emailSettingValue,
    page,
    requests,
    zoneNames,
  } = emailIntentDashboard

  await page.locator("#category").selectOption("Email")
  await page.getByPlaceholder("Search facets, values, or zones").fill(
    "support_subaddress",
  )
  await page.getByRole("button", {
    name: "Compare 2 values: Observed values for support_subaddress",
  }).click()
  let comparison = page.getByRole("dialog", { name: "support_subaddress" })
  await comparison.getByRole("button", {
    name: "Use as exact intent: Fleet consensus for support_subaddress",
  }).click()
  let policy = page.getByRole("dialog", { name: "Set facet intent" })
  await policy.locator("#intent-policy-save").click()

  const supportRow = page.locator(
    '#matrix-body tr[data-facet-key="settings:support_subaddress"]',
  )
  const matchingCell = supportRow.locator(
    `td[data-zone-id="zone-${zoneNames[0]}"]`,
  )
  await expect(matchingCell.locator(".cell-comparison-status")).toHaveText(
    "Consensus",
  )
  await expect(matchingCell.locator(".cell-intent-status")).toHaveText(
    "Intent match",
  )
  const verticalLayout = await matchingCell.evaluate((cell) => {
    const statuses = [...cell.querySelectorAll(
      ".cell-comparison-status, .cell-intent-status",
    )].map((element) => element.getBoundingClientRect())
    const value = cell.querySelector(".cell-display").getBoundingClientRect()
    return {
      statusBottom: Math.max(...statuses.map((status) => status.bottom)),
      valueTop: value.top,
    }
  })
  expect(verticalLayout.valueTop).toBeGreaterThanOrEqual(
    verticalLayout.statusBottom,
  )

  await page.getByRole("button", {
    name: `Align to intent: support_subaddress on ${zoneNames[1]}`,
  }).click()
  const confirmation = page.locator("#confirm-dialog")
  await expect(confirmation).toContainText(
    `zones/zone-${zoneNames[1]}/email/routing`,
  )
  await expect(confirmation).toContainText("support_subaddress")
  await acceptCurrentWrite(page)

  await expect(page.locator("#toast-message")).toHaveText(
    "support_subaddress aligned with fleet intent and live verification passed",
  )
  await expect.poll(() => emailSettingValue(
    zoneNames[1],
    "support_subaddress",
  )).toBe(true)
  const emailReads = requests.filter((request) => (
    request.method === "GET"
      && /^zones\/[^/]+\/email\/routing$/.test(request.path)
  ))
  expect(new Set(emailReads.map((request) => request.path))).toEqual(new Set(
    zoneNames.map((zoneName) => `zones/zone-${zoneName}/email/routing`),
  ))
  expect(requests.filter((request) => (
    request.method === "PATCH"
      && request.path === `zones/zone-${zoneNames[1]}/email/routing`
      && request.body.support_subaddress === true
      && Object.keys(request.body).length === 1
  ))).toHaveLength(1)

  await page.getByPlaceholder("Search facets, values, or zones").fill("status")
  await page.getByRole("button", {
    name: "Compare 2 values: Observed values for status",
  }).click()
  comparison = page.getByRole("dialog", { name: "status" })
  await comparison.getByRole("button", {
    name: "Use as exact intent: Fleet consensus for status",
  }).click()
  policy = page.getByRole("dialog", { name: "Set facet intent" })
  await policy.locator("#intent-policy-save").click()

  const statusRow = page.locator(
    '#matrix-body tr[data-facet-key="settings:status"]',
  )
  await expect(statusRow.getByRole("button", {
    name: "Alignment blocked (1): Align status with fleet intent",
  })).toBeDisabled()
  await expect(statusRow.locator(
    ".facet-cell [data-alignment-blocked-reason]",
  )).toHaveText("Cloudflare reports Email Routing status as read-only")
  await expect(statusRow.locator(
    `td[data-zone-id="zone-${zoneNames[1]}"] [data-alignment-blocked-reason]`,
  )).toHaveText("Cloudflare reports Email Routing status as read-only")

  await page.getByRole("button", { name: "Manage fleet intent" }).click()
  const manager = page.getByRole("dialog", { name: "Fleet intent" })
  const blockedPolicy = manager.locator("[data-intent-policy-card]").filter({
    hasText: "Cloudflare reports Email Routing status as read-only",
  })
  await expect(blockedPolicy).toBeVisible()
  await expect(blockedPolicy.getByRole("button", {
    name: "Alignment blocked (1): status for All zones",
  })).toBeDisabled()
})

test("confirms rules individually without exposing a parent ruleset facet", async ({ dashboard }) => {
  const { page, zoneNames } = dashboard

  await expect(page.locator('#category option[value="Rulesets"]')).toHaveCount(0)
  await page.locator("#category").selectOption("Ruleset rules")

  const rows = page.locator("#matrix-body tr")
  await expect(rows).toHaveCount(1)
  await expect(rows.locator(".facet-title-value")).toHaveText("Protect service")
  await expect(page.getByRole("button", {
    name: /^Open the parent ruleset for Protect service on /,
  })).toHaveCount(3)

  await page.getByRole("button", {
    name: "Set intent: Set intent for Protect service",
  }).click()
  const policy = page.getByRole("dialog", { name: "Set facet intent" })
  await expect(policy).toContainText("Ruleset rules | Protect service")
  await expect(policy.getByRole("radio", { name: /^Required/ })).toBeChecked()
  await policy.getByRole("radio", { name: /^Exact value/ }).check()
  await policy.locator("#intent-policy-save").click()

  await expect(page.locator("#toast-message")).toHaveText(
    "Protect service intent saved for All zones",
  )
  await page.getByRole("button", {
    name: `Acknowledge Protect service on ${zoneNames[1]}`,
  }).click()

  const acknowledgement = page.getByRole("dialog", {
    name: "Acknowledge exact state",
  })
  await acknowledgement.getByLabel("Reason").fill("Intentionally disabled")
  await acknowledgement.getByRole("button", {
    name: "Acknowledge state",
  }).click()

  await expect(page.locator("#toast-message")).toHaveText(
    `Protect service acknowledged on ${zoneNames[1]}`,
  )
  await page.locator("#difference-toggle").click()
  await expect(
    rows.locator(`td[data-zone-id="zone-${zoneNames[1]}"]`),
  ).toHaveAttribute("data-intent-status", "acknowledged")
})

test("protects a dirty saved scope from accidental workflow dismissal", async ({ dashboard }) => {
  const { page, zoneNames } = dashboard

  await page.getByRole("button", { name: "Manage fleet intent" }).click()
  const manager = page.getByRole("dialog", { name: "Fleet intent" })
  await manager.getByRole("button", { name: /^Groups/ }).click()
  await manager.getByRole("button", { name: "Create saved scope" }).click()

  const scope = page.getByRole("dialog", { name: "New saved scope" })
  await scope.getByRole("checkbox", { name: zoneNames[0] }).check()

  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toBe(
      "Discard unsaved changes in Fleet intent / Saved scope?",
    )
    await dialog.dismiss()
  })
  await scope.getByRole("button", { name: "Close saved scope editor" }).click()
  await expect(scope).toBeVisible()

  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toBe(
      "Discard unsaved changes in Fleet intent / Saved scope?",
    )
    await dialog.accept()
  })
  await scope.getByRole("button", { name: "Close saved scope editor" }).click()
  await expect(scope).not.toBeVisible()
  await expect(manager).not.toBeVisible()
  await expect.poll(() => new URL(page.url()).searchParams.get("panel")).toBeNull()
})

test("restores focus after inspecting facet equivalence", async ({ dashboard }) => {
  const { page, zoneNames } = dashboard

  await page.getByPlaceholder("Search facets, values, or zones").fill("TXT @")
  const opener = page.getByRole("button", { name: "How matching works: TXT @" })
  await opener.focus()
  await opener.click()

  const inspector = page.getByRole("dialog", { name: "TXT @" })
  await expect(inspector).toBeVisible()
  await expect(inspector.locator("#facet-equivalence-identity")).toContainText(
    "record type / normalized owner",
  )
  await inspector.getByLabel("Show value from zone").selectOption(zoneNames[2])
  await expect(inspector.locator("#facet-equivalence-observed")).toContainText(
    "_spf.other.example",
  )
  await page.keyboard.press("Escape")

  await expect(inspector).not.toBeVisible()
  await expect(opener).toBeFocused()
})

test("supports keyboard search and two-dimensional matrix navigation", async ({ dashboard }) => {
  const { page } = dashboard
  const search = page.getByPlaceholder("Search facets, values, or zones")

  await page.locator("body").press("/")
  await expect(search).toBeFocused()
  await search.fill("temporary filter")
  await search.press("Escape")
  await expect(search).toHaveValue("")

  const alwaysMatch = page.getByRole("button", {
    name: "How matching works: always_use_https",
  })
  const minimumTlsMatch = page.getByRole("button", {
    name: "How matching works: min_tls_version",
  })
  const minimumTlsCompare = page.getByRole("button", {
    name: "Compare 2 values: Observed values for min_tls_version",
  })
  const minimumTlsLastEdit = page.getByRole("button", {
    name: "Edit min_tls_version on charlie.example",
  })

  await alwaysMatch.focus()
  await alwaysMatch.press("ArrowDown")
  await expect(minimumTlsMatch).toBeFocused()
  await minimumTlsMatch.press("ArrowRight")
  await expect(minimumTlsCompare).toBeFocused()
  await minimumTlsCompare.press("End")
  await expect(minimumTlsLastEdit).toBeFocused()
  await minimumTlsLastEdit.press("Home")
  await expect(minimumTlsMatch).toBeFocused()
})

test("applies and safely undoes a setting write from durable activity", async ({ dashboard }) => {
  const { page, requests, settingValue, zoneNames } = dashboard
  const targetZone = zoneNames[1]

  await applySettingChange(page, targetZone, "on")
  await expect.poll(() => settingValue(targetZone, "always_use_https")).toBe("on")

  await page.getByRole("button", { name: /Activity 1:/ }).click()
  const activity = page.getByRole("dialog", { name: "Operation history" })
  await activity.getByRole("button", { name: "Review guarded undo" }).click()

  const confirmation = page.locator("#confirm-dialog")
  await expect(confirmation).toContainText("Undo Update zone setting")
  await expect(confirmation).toContainText("PATCH")
  await acceptCurrentWrite(page)

  await expect(page.locator("#toast-message")).toHaveText(
    "Undo succeeded and live verification passed",
  )
  await expect.poll(() => settingValue(targetZone, "always_use_https")).toBe("off")
  await expect(page.getByRole("button", { name: /Activity 2:/ })).toBeVisible()
  await expect(activity).toContainText("Undone and verified")
  expect(requests.filter((request) => request.method === "PATCH")).toHaveLength(2)
})

test("fills a missing DNS cell through live validation and guarded undo", async ({ dashboard }) => {
  const { dnsRecords, page, requests, zoneNames } = dashboard
  const targetZone = zoneNames[2]
  const targetName = `docs.${targetZone}`
  const targetRecords = () => dnsRecords(targetZone).filter(
    (record) => record.type === "CNAME" && record.name === targetName,
  )

  expect(targetRecords()).toHaveLength(0)
  await page.getByRole("button", {
    name: `Fill CNAME docs on ${targetZone}`,
  }).click()

  const chooser = page.locator("#hole-dialog")
  await expect(chooser).toBeVisible()
  await expect(chooser.locator("#hole-source option")).toHaveCount(2)
  const sourceValue = await chooser.locator("#hole-source option")
    .filter({ hasText: zoneNames[0] })
    .getAttribute("value")
  await chooser.locator("#hole-source").selectOption(sourceValue)
  await expect(chooser.locator("#hole-preview")).toContainText(
    "docs-primary.example.net",
  )
  await chooser.getByRole("button", { name: "Build live preview" }).click()

  const confirmation = page.locator("#confirm-dialog")
  await expect(confirmation).toContainText(`Fill CNAME docs on ${targetZone}`)
  await expect(confirmation).toContainText("POST")
  const change = confirmation.locator(".operation-change")
  await expect(change.getByText("Record", { exact: true })).toBeVisible()
  await expect(change.getByText("missing", { exact: true })).toBeVisible()
  await expect(change).toContainText(
    "docs-primary.example.net",
  )
  await acceptCurrentWrite(page)

  await expect(page.locator("#toast-message")).toHaveText(
    "Writes succeeded and live verification passed",
  )
  expect(targetRecords()).toHaveLength(1)
  expect(targetRecords()[0].content).toBe("docs-primary.example.net")
  await expect(page.getByRole("button", {
    name: `Fill CNAME docs on ${targetZone}`,
  })).toHaveCount(0)

  await page.getByRole("button", { name: /Activity 1:/ }).click()
  const activity = page.getByRole("dialog", { name: "Operation history" })
  await activity.getByRole("button", { name: "Review guarded undo" }).click()
  await expect(confirmation).toContainText("DELETE")
  await expect(change.getByText("Removed", { exact: true })).toBeVisible()
  await acceptCurrentWrite(page)

  await expect(page.locator("#toast-message")).toHaveText(
    "Undo succeeded and live verification passed",
  )
  expect(targetRecords()).toHaveLength(0)
  await expect(page.getByRole("button", {
    name: `Fill CNAME docs on ${targetZone}`,
  })).toBeVisible()
  expect(requests.filter((request) => request.method === "POST")).toHaveLength(1)
  expect(requests.filter((request) => request.method === "DELETE")).toHaveLength(1)
})

test("cancels a reviewed setting change without writing", async ({ dashboard }) => {
  const { page, requests, settingValue, zoneNames } = dashboard
  const targetZone = zoneNames[1]

  const confirmation = await reviewSettingChange(page, targetZone, "on")
  await expect(confirmation).toBeVisible()
  await expect(confirmation.getByRole("button", {
    name: "Apply and verify",
  })).toBeDisabled()
  await confirmation.getByRole("button", { name: "Cancel" }).click()

  await expect(confirmation).not.toBeVisible()
  expect(settingValue(targetZone, "always_use_https")).toBe("off")
  expect(requests.filter((request) => request.method === "PATCH")).toHaveLength(0)
  await expect(page.getByRole("button", { name: /Activity 0:/ })).toBeVisible()
})

test("records an upstream write failure without changing live state", async ({ dashboard }) => {
  const {
    allowBrowserError,
    page,
    queueFailure,
    requests,
    settingValue,
    zoneNames,
  } = dashboard
  const targetZone = zoneNames[1]

  allowBrowserError(
    /Failed to load resource: the server responded with a status of 500/,
  )
  queueFailure({
    message: "Simulated write failure",
    method: "PATCH",
    path: `zones/zone-${targetZone}/settings/always_use_https`,
    status: 500,
  })
  await reviewSettingChange(page, targetZone, "on")
  await acceptCurrentWrite(page)

  await expect(page.locator("#toast-message")).toContainText(
    "Simulated write failure",
  )
  expect(settingValue(targetZone, "always_use_https")).toBe("off")
  expect(requests.filter((request) => request.method === "PATCH")).toHaveLength(1)

  await page.getByRole("button", { name: /Activity 1:/ }).click()
  const activity = page.getByRole("dialog", { name: "Operation history" })
  await expect(activity.locator(".activity-status.write-failed")).toHaveText(
    "Write failed",
  )
  await expect(activity.locator(".activity-error")).toContainText(
    "Simulated write failure",
  )
  await expect(activity.locator(".activity-undo")).toHaveCount(0)
  await activity.getByLabel("Show").selectOption({ label: "Needs attention" })
  await expect(activity.locator("#activity-visible-count")).toHaveText("1 operation")
})

test("blocks guarded undo after live state drifts", async ({ dashboard }) => {
  const {
    page,
    requests,
    setSettingValue,
    zoneNames,
  } = dashboard
  const targetZone = zoneNames[1]

  await applySettingChange(page, targetZone, "on")
  setSettingValue(targetZone, "always_use_https", "off")
  await page.getByRole("button", { name: /Activity 1:/ }).click()
  const activity = page.getByRole("dialog", { name: "Operation history" })
  await activity.getByRole("button", { name: "Review guarded undo" }).click()

  await expect(page.locator("#toast-message")).toContainText(
    "Live state no longer matches the recorded verified result",
  )
  await expect(activity).toBeVisible()
  await expect(activity.locator(".activity-undo-state")).toContainText(
    "Undo blocked",
  )
  await expect(page.locator("#confirm-dialog")).not.toBeVisible()
  expect(requests.filter((request) => request.method === "PATCH")).toHaveLength(1)
})

test("keeps the loaded matrix usable when the broker disconnects", async ({ dashboard }) => {
  const {
    allowBrowserError,
    broker,
    page,
    zoneNames,
  } = dashboard
  const rows = page.locator("#matrix-body tr")
  const initialRowCount = await rows.count()

  allowBrowserError(/Failed to load resource: net::ERR_CONNECTION_REFUSED/)
  allowBrowserError(
    /Failed to load resource: net::ERR_INCOMPLETE_CHUNKED_ENCODING/,
  )
  broker.close()
  broker.server.closeAllConnections()
  await broker.closed

  await expect(page.locator("#status-text")).toHaveText(
    "Session broker offline",
  )
  await expect(page.locator("#refresh-detail")).toContainText(
    "The loaded matrix remains available",
  )
  await expect(page.locator("#refresh")).toBeDisabled()
  const edit = page.getByRole("button", {
    name: `Edit always_use_https on ${zoneNames[1]}`,
  })
  await expect(edit).toBeDisabled()
  await expect(edit.locator("xpath=ancestor::td[1]")).toHaveAttribute(
    "title",
    /Session broker offline/,
  )
  await expect(rows).toHaveCount(initialRowCount)
})

test("persists an expected coverage decision and reverses it", async ({ dashboard }) => {
  const { page, waitForReady } = dashboard

  await page.getByRole("button", {
    name: "Mark expected: Legacy Page Rules | Fleet-wide limitation",
  }).click()
  const editor = page.getByRole("dialog", { name: "Mark gap as expected" })
  await editor.getByLabel("Why is this unavailable by design?").fill(
    "Account tokens cannot read this legacy endpoint",
  )
  await editor.getByRole("button", { name: "Mark expected" }).click()

  await expect(page.locator("#toast-message")).toHaveText(
    "Expected coverage saved for Legacy Page Rules | Fleet-wide limitation",
  )
  await expect(page.getByRole("button", { name: /Expected read gaps 1 current/ })).toBeVisible()
  await page.reload({ waitUntil: "domcontentloaded" })
  await waitForReady()
  await page.getByRole("button", { name: /Expected read gaps 1 current/ }).click()
  await expect(page.locator("#coverage-expected-list")).toContainText(
    "Account tokens cannot read this legacy endpoint",
  )
  await page.getByRole("button", {
    name: "Edit expectation: Legacy Page Rules | Fleet-wide limitation",
  }).click()
  const persistedEditor = page.getByRole("dialog", { name: "Edit expected gap" })
  await persistedEditor.getByRole("button", { name: "Remove expectation" }).click()
  await page.getByRole("dialog", { name: "Remove expected coverage" })
    .getByRole("button", { name: "Remove" }).click()
  await expect(page.locator("#toast-message")).toHaveText(
    "Expected coverage removed for Legacy Page Rules | Fleet-wide limitation",
  )
  await expect(page.getByRole("button", { name: /Expected read gaps 0 current/ })).toBeVisible()
})

test("keeps target selection and matrix focus usable on a phone", async ({ dashboard }) => {
  const { page, zoneNames } = dashboard
  await page.setViewportSize({ height: 844, width: 390 })

  await page.locator("#matrix-choose-targets").click()
  const targets = page.getByRole("dialog", { name: "Choose zones" })
  const bounds = await targets.boundingBox()
  expect(bounds).not.toBeNull()
  expect(bounds.x).toBeGreaterThanOrEqual(0)
  expect(bounds.y).toBeGreaterThanOrEqual(0)
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(390)
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(844)
  await targets.getByRole("checkbox", { name: new RegExp(zoneNames[0]) }).check()
  await targets.getByRole("button", { name: "Done" }).click()
  await expect(page.locator("#selection-count")).toHaveText("1")

  await page.getByRole("button", { name: "Focus matrix" }).click()
  await expect(page.locator("body")).toHaveClass(/matrix-focus/)
  const exit = page.getByRole("button", { name: "Exit focus" }).first()
  await expect(exit).toBeVisible()
  await exit.click()
  await expect(page.locator("body")).not.toHaveClass(/matrix-focus/)
})

test("removes write affordances and rejects broker mutation in read-only mode", async ({ readOnlyDashboard }) => {
  const { page, requests, sessionSecret, url, zoneNames } = readOnlyDashboard

  await expect(page).toHaveTitle("Cloudflare Fleet | Read-only")
  await expect(page.locator("#session-mode")).toHaveText("Read-only session")
  await expect(page.locator("#write-readiness")).toHaveText(
    "Read-only session; relaunch with write access to apply changes",
  )
  await expect(page.locator(".edit-cell, .fill-hole, .bulk-fill")).toHaveCount(0)
  await expect(page.getByRole("button", { name: "View fleet intent" })).toBeVisible()

  await page.getByRole("button", { name: "View fleet intent" }).click()
  const intent = page.getByRole("dialog", { name: "Fleet intent" })
  await expect(intent).toContainText(
    "This read-only session can inspect intent but cannot change it",
  )
  await intent.getByRole("button", { name: /^Groups/ }).click()
  await expect(intent.getByRole("button", { name: "Create saved scope" })).toBeDisabled()
  await intent.getByRole("button", { name: "Done" }).click()

  const mutationUrl = new URL(
    `api/cloudflare/zones/zone-${zoneNames[0]}/settings/always_use_https`,
    url,
  )
  const mutationResponse = await fetch(mutationUrl, {
    body: JSON.stringify({ value: "off" }),
    headers: {
      "Content-Type": "application/json",
      "X-Cloudflare-Fleet-Session": sessionSecret,
    },
    method: "PATCH",
  })
  const response = {
    body: await mutationResponse.json(),
    status: mutationResponse.status,
  }

  expect(response.status).toBe(403)
  expect(response.body.errors[0].message).toBe(
    "Cloudflare writes are disabled for this session",
  )
  expect(requests).toHaveLength(0)
})
