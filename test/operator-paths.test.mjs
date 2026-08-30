import assert from "node:assert/strict"
import path from "node:path"
import test from "node:test"

import {
  defaultFleetPolicyFile,
  defaultFleetStateFile,
  defaultWranglerConfigurationFile,
  fleetPolicyFileSelection,
  fleetStateFileSelection,
  OPERATOR_PATH_SOURCE,
} from "../src/operator-paths.mjs"

test("operator files default to durable per-user state and configuration", () => {
  assert.equal(
    defaultFleetStateFile({}, "/users/operator"),
    path.join(
      "/users/operator",
      ".local",
      "state",
      "cloudflare-fleet",
      "state.json",
    ),
  )
  assert.equal(
    defaultFleetPolicyFile({}, "/users/operator"),
    path.join(
      "/users/operator",
      ".config",
      "cloudflare-fleet",
      "fleet-policy.json",
    ),
  )
})

test("operator files honor absolute XDG bases and reject relative bases", () => {
  assert.equal(
    defaultFleetStateFile({ XDG_STATE_HOME: "/state" }, "/unused"),
    "/state/cloudflare-fleet/state.json",
  )
  assert.equal(
    defaultFleetPolicyFile({ XDG_CONFIG_HOME: "/config" }, "/unused"),
    "/config/cloudflare-fleet/fleet-policy.json",
  )
  assert.throws(
    () => defaultFleetStateFile({ XDG_STATE_HOME: "state" }, "/unused"),
    /XDG_STATE_HOME must be an absolute path/,
  )
})

test("Wrangler configuration remains local to the deployment checkout", () => {
  assert.equal(
    defaultWranglerConfigurationFile("/project"),
    "/project/wrangler.jsonc",
  )
})

test("operator file selections explain explicit, environment, XDG, and default sources", () => {
  assert.deepEqual(
    fleetStateFileSelection("profiles/state.json", {}, {
      homeDirectory: "/users/operator",
      workingDirectory: "/work",
    }),
    {
      path: "/work/profiles/state.json",
      source: OPERATOR_PATH_SOURCE.ARGUMENT,
      sourceName: "--state-file",
    },
  )
  assert.deepEqual(
    fleetPolicyFileSelection(undefined, {
      CLOUDFLARE_FLEET_POLICY_FILE: "/profiles/policy.json",
    }),
    {
      path: "/profiles/policy.json",
      source: OPERATOR_PATH_SOURCE.ENVIRONMENT,
      sourceName: "CLOUDFLARE_FLEET_POLICY_FILE",
    },
  )
  assert.equal(
    fleetStateFileSelection(undefined, { XDG_STATE_HOME: "/state" }).source,
    OPERATOR_PATH_SOURCE.XDG,
  )
  assert.equal(
    fleetPolicyFileSelection(undefined, {}, {
      homeDirectory: "/users/operator",
    }).source,
    OPERATOR_PATH_SOURCE.DEFAULT,
  )
})

test("operator file selection rejects relative environment paths even with a custom working directory", () => {
  assert.throws(
    () => fleetPolicyFileSelection(undefined, {
      CLOUDFLARE_FLEET_POLICY_FILE: "profiles/policy.json",
    }, {
      workingDirectory: "/work",
    }),
    /CLOUDFLARE_FLEET_POLICY_FILE must be an absolute path/,
  )
})
