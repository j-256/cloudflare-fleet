import assert from "node:assert/strict"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import {
  diagnoseFleetRuntime,
  FLEET_RUNTIME_STATUS,
  inspectFleetRuntimeConfiguration,
  RUNTIME_CHECK_STATUS,
} from "../src/runtime-status.mjs"

const ACCOUNT_ID = "a".repeat(32)
const API_TOKEN = "runtime-status-secret-token"

async function temporaryRuntime(context) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudflare-fleet-runtime-"))
  context.after(() => fs.rm(root, { force: true, recursive: true }))
  return {
    config: path.join(root, "config"),
    root,
    state: path.join(root, "state"),
  }
}

function configuredEnvironment(paths, overrides = {}) {
  return {
    CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID,
    CLOUDFLARE_API_TOKEN: API_TOKEN,
    PATH: process.env.PATH || "",
    XDG_CONFIG_HOME: paths.config,
    XDG_STATE_HOME: paths.state,
    ...overrides,
  }
}

test("runtime configuration explains effective paths without exposing credential values", async (context) => {
  const paths = await temporaryRuntime(context)
  const configuration = await inspectFleetRuntimeConfiguration({
    environment: configuredEnvironment(paths),
    now: 0,
    platform: "linux",
  })

  assert.equal(configuration.checkedAt, "1970-01-01T00:00:00.000Z")
  assert.equal(configuration.credentials.accountId.present, true)
  assert.equal(configuration.credentials.apiToken.present, true)
  assert.equal(configuration.paths.state.sourceName, "XDG_STATE_HOME")
  assert.equal(configuration.paths.policy.sourceName, "XDG_CONFIG_HOME")
  assert.equal(configuration.paths.state.exists, false)
  assert.equal(configuration.dashboard.status, "unsupported")
  assert.doesNotMatch(JSON.stringify(configuration), new RegExp(API_TOKEN))
  assert.doesNotMatch(JSON.stringify(configuration), new RegExp(ACCOUNT_ID))
})

test("doctor reports a fresh cross-platform CLI configuration as ready", async (context) => {
  const paths = await temporaryRuntime(context)
  const result = await diagnoseFleetRuntime({
    environment: configuredEnvironment(paths),
    platform: "linux",
  })

  assert.equal(result.status, FLEET_RUNTIME_STATUS.READY)
  assert.equal(result.summary.fail, 0)
  assert.equal(result.summary.warning, 0)
  assert.equal(
    result.checks.find((entry) => entry.id === "dashboard.platform").status,
    RUNTIME_CHECK_STATUS.SKIP,
  )
  assert.equal(result.live.status, "skipped")
})

test("doctor makes missing credentials actionable", async (context) => {
  const paths = await temporaryRuntime(context)
  const result = await diagnoseFleetRuntime({
    environment: {
      PATH: process.env.PATH || "",
      XDG_CONFIG_HOME: paths.config,
      XDG_STATE_HOME: paths.state,
    },
    platform: "linux",
  })

  assert.equal(result.status, FLEET_RUNTIME_STATUS.ATTENTION)
  assert.equal(
    result.checks.find((entry) => entry.id === "credentials.account-id").status,
    RUNTIME_CHECK_STATUS.FAIL,
  )
  assert.match(
    result.checks.find((entry) => entry.id === "credentials.api-token").remedy,
    /Export CLOUDFLARE_API_TOKEN/,
  )
})

test("doctor flags non-private operator files", async (context) => {
  const paths = await temporaryRuntime(context)
  await fs.mkdir(paths.state, { recursive: true })
  const stateFile = path.join(paths.state, "shared-state.json")
  await fs.writeFile(stateFile, "{}\n", { mode: 0o644 })
  await fs.chmod(stateFile, 0o644)

  const result = await diagnoseFleetRuntime({
    environment: configuredEnvironment(paths),
    platform: "linux",
    stateFile,
  })

  assert.equal(result.status, FLEET_RUNTIME_STATUS.ATTENTION)
  const permissions = result.checks.find(
    (entry) => entry.id === "paths.state-permissions",
  )
  assert.equal(permissions.status, RUNTIME_CHECK_STATUS.WARNING)
  assert.match(permissions.remedy, /chmod 600/)
})

test("doctor runs one injected live probe and reports bounded success", async (context) => {
  const paths = await temporaryRuntime(context)
  const calls = []
  const result = await diagnoseFleetRuntime({
    environment: configuredEnvironment(paths),
    live: true,
    liveProbe(options) {
      calls.push(options)
      return { httpStatus: 200, returnedZones: 2 }
    },
    platform: "linux",
  })

  assert.equal(calls.length, 1)
  assert.equal(calls[0].accountId, ACCOUNT_ID)
  assert.equal(result.live.status, "ready")
  assert.equal(result.live.returnedZones, 2)
  assert.equal(result.status, FLEET_RUNTIME_STATUS.READY)
})

test("doctor redacts a token from live-probe failures", async (context) => {
  const paths = await temporaryRuntime(context)
  const result = await diagnoseFleetRuntime({
    environment: configuredEnvironment(paths),
    live: true,
    liveProbe() {
      throw new Error(`Rejected ${API_TOKEN}`)
    },
    platform: "linux",
  })

  assert.equal(result.status, FLEET_RUNTIME_STATUS.ATTENTION)
  assert.match(result.live.error, /\[redacted\]/)
  assert.doesNotMatch(JSON.stringify(result), new RegExp(API_TOKEN))
})
