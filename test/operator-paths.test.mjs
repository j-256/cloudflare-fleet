import assert from "node:assert/strict"
import path from "node:path"
import test from "node:test"

import {
  defaultFleetPolicyFile,
  defaultFleetStateFile,
  defaultWranglerConfigurationFile,
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
