import { promises as fs } from "node:fs"

import { expect } from "@playwright/test"

const DEFAULT_SCROLL_TARGETS = Object.freeze([
  "#matrix-shell",
  ".activity-scroll-region",
  "#value-comparison-dialog",
  ".value-comparison-table-wrap",
])

function slug(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
}

async function settleLayout(page, selectors) {
  await page.evaluate((targets) => new Promise((resolve) => {
    let prior = ""
    let stableFrames = 0
    let frames = 0
    const sample = () => JSON.stringify([
      document.scrollingElement.scrollLeft,
      document.scrollingElement.scrollTop,
      ...targets.flatMap((selector) => {
        const element = document.querySelector(selector)
        return element ? [element.scrollLeft, element.scrollTop] : []
      }),
    ])
    const check = () => {
      frames += 1
      const next = sample()
      stableFrames = next === prior ? stableFrames + 1 : 0
      prior = next
      if (stableFrames >= 3 || frames >= 90) {
        resolve()
        return
      }
      requestAnimationFrame(check)
    }
    requestAnimationFrame(check)
  }), selectors)
}

async function scrollSnapshot(page, selectors) {
  return page.evaluate((targets) => {
    const entries = [{
      id: "page",
      left: document.scrollingElement.scrollLeft,
      top: document.scrollingElement.scrollTop,
    }]
    for (const selector of targets) {
      const element = document.querySelector(selector)
      if (!element) continue
      entries.push({
        id: selector,
        left: element.scrollLeft,
        top: element.scrollTop,
      })
    }
    return {
      entries,
      viewport: {
        height: innerHeight,
        width: innerWidth,
      },
    }
  }, selectors)
}

function scrollTravel(before, after) {
  const previous = new Map(before.entries.map((entry) => [entry.id, entry]))
  const movements = []
  for (const entry of after.entries) {
    const prior = previous.get(entry.id)
    if (!prior) continue
    const horizontal = entry.left - prior.left
    const vertical = entry.top - prior.top
    if (horizontal === 0 && vertical === 0) continue
    movements.push({
      horizontal,
      target: entry.id,
      vertical,
    })
  }
  return movements
}

function metricTotals(interactions, viewport) {
  const totals = {
    automaticHorizontalViewport: 0,
    automaticVerticalViewport: 0,
    disclosures: 0,
    inputs: 0,
    manualHorizontalViewport: 0,
    manualVerticalViewport: 0,
    reversals: 0,
    totalInteractions: interactions.length,
  }
  const directions = new Map()
  for (const interaction of interactions) {
    if (interaction.category === "disclosure") totals.disclosures += 1
    if (interaction.category === "input") totals.inputs += 1
    for (const movement of interaction.scroll) {
      const horizontal = Math.abs(movement.horizontal) / viewport.width
      const vertical = Math.abs(movement.vertical) / viewport.height
      if (interaction.category === "manual-scroll") {
        totals.manualHorizontalViewport += horizontal
        totals.manualVerticalViewport += vertical
      } else {
        totals.automaticHorizontalViewport += horizontal
        totals.automaticVerticalViewport += vertical
      }
      for (const [axis, amount] of [
        ["horizontal", movement.horizontal],
        ["vertical", movement.vertical],
      ]) {
        if (amount === 0) continue
        const key = `${movement.target}:${axis}`
        const direction = Math.sign(amount)
        const prior = directions.get(key)
        if (prior && prior !== direction) totals.reversals += 1
        directions.set(key, direction)
      }
    }
  }
  return totals
}

export async function beginErgonomicsJourney(page, testInfo, options) {
  const interactions = []
  const screenshots = []
  const selectors = options.scrollTargets || DEFAULT_SCROLL_TARGETS
  let initial = await scrollSnapshot(page, selectors)

  async function perform(category, label, action) {
    const before = await scrollSnapshot(page, selectors)
    await action()
    await settleLayout(page, selectors)
    const after = await scrollSnapshot(page, selectors)
    interactions.push({
      category,
      label,
      scroll: scrollTravel(before, after),
    })
  }

  return {
    async capture(name, captureOptions = {}) {
      const filename = `ergonomics-${slug(options.persona)}-${slug(name)}.png`
      const path = testInfo.outputPath(filename)
      const target = captureOptions.locator || page
      await target.screenshot({ path })
      screenshots.push(filename)
      await testInfo.attach(filename, {
        contentType: "image/png",
        path,
      })
    },
    click(locator, label, clickOptions) {
      return perform("click", label, () => locator.click(clickOptions))
    },
    disclose(locator, label) {
      return perform("disclosure", label, () => locator.click())
    },
    fill(locator, value, label) {
      return perform("input", label, () => locator.fill(value))
    },
    select(locator, value, label) {
      return perform("input", label, () => locator.selectOption(value))
    },
    async finish(budgets) {
      const final = await scrollSnapshot(page, selectors)
      const metrics = metricTotals(interactions, final.viewport)
      const report = {
        budgets,
        interactions,
        metrics,
        persona: options.persona,
        screenshots,
        startScroll: initial.entries,
        task: options.task,
        viewport: final.viewport,
      }
      const reportPath = testInfo.outputPath("ergonomics-report.json")
      await fs.writeFile(
        reportPath,
        `${JSON.stringify(report, null, 2)}\n`,
        { mode: 0o600 },
      )
      await testInfo.attach("ergonomics-report", {
        contentType: "application/json",
        path: reportPath,
      })
      for (const [metric, maximum] of Object.entries(budgets)) {
        expect(
          metrics[metric],
          `${options.persona}: ${metric} should be at most ${maximum}`,
        ).toBeLessThanOrEqual(maximum)
      }
      return report
    },
    async manualScroll(target, direction, pixels, label) {
      await perform("manual-scroll", label, async () => {
        await target.evaluate((element, movement) => {
          element.scrollBy({
            behavior: "auto",
            left: movement.direction === "horizontal" ? movement.pixels : 0,
            top: movement.direction === "vertical" ? movement.pixels : 0,
          })
        }, { direction, pixels })
      })
    },
    async reset() {
      interactions.length = 0
      screenshots.length = 0
      initial = await scrollSnapshot(page, selectors)
      return initial
    },
    async requireInViewport(locator, label) {
      await expect(locator, `${label} should be rendered`).toBeVisible()
      await expect(locator, `${label} should be discoverable without scrolling`).toBeInViewport()
    },
  }
}
