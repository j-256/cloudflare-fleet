import { defineConfig } from "@playwright/test"

import baseConfig from "./playwright.config.mjs"

export default defineConfig({
  ...baseConfig,
  expect: {
    timeout: 15000,
  },
  fullyParallel: false,
  outputDir: "test-results/live-read-only",
  retries: 0,
  testIgnore: [],
  testMatch: "**/*.live.spec.mjs",
  timeout: 300000,
  use: {
    ...baseConfig.use,
    trace: "on",
  },
  workers: 1,
})
