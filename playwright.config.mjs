import { defineConfig } from "@playwright/test"

export default defineConfig({
  expect: {
    timeout: 5000,
  },
  forbidOnly: Boolean(process.env.CI),
  fullyParallel: true,
  outputDir: "test-results",
  reporter: process.env.CI
    ? [["line"], ["html", { open: "never" }]]
    : "line",
  retries: process.env.CI ? 2 : 0,
  testDir: "test/e2e",
  timeout: 30000,
  use: {
    browserName: "chromium",
    colorScheme: "light",
    locale: "en-US",
    reducedMotion: "reduce",
    screenshot: "only-on-failure",
    timezoneId: "UTC",
    trace: "retain-on-failure",
    video: "retain-on-failure",
    viewport: {
      height: 1000,
      width: 1440,
    },
  },
})
