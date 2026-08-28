import os from "node:os"
import path from "node:path"

import { FleetConfigurationError } from "./cli-contract.mjs"

const APPLICATION_DIRECTORY = "cloudflare-fleet"
const POLICY_FILENAME = "fleet-policy.json"
const STATE_FILENAME = "state.json"
const WRANGLER_FILENAME = "wrangler.jsonc"

function absoluteConfiguredDirectory(value, fallback, name) {
  if (!value) return fallback
  if (!path.isAbsolute(value)) {
    throw new FleetConfigurationError(`${name} must be an absolute path`)
  }
  return path.resolve(value)
}

export function defaultFleetStateFile(
  environment = process.env,
  homeDirectory = os.homedir(),
) {
  const stateDirectory = absoluteConfiguredDirectory(
    environment.XDG_STATE_HOME,
    path.join(homeDirectory, ".local", "state"),
    "XDG_STATE_HOME",
  )
  return path.join(stateDirectory, APPLICATION_DIRECTORY, STATE_FILENAME)
}

export function defaultFleetPolicyFile(
  environment = process.env,
  homeDirectory = os.homedir(),
) {
  const configurationDirectory = absoluteConfiguredDirectory(
    environment.XDG_CONFIG_HOME,
    path.join(homeDirectory, ".config"),
    "XDG_CONFIG_HOME",
  )
  return path.join(
    configurationDirectory,
    APPLICATION_DIRECTORY,
    POLICY_FILENAME,
  )
}

export function defaultWranglerConfigurationFile(
  workingDirectory = process.cwd(),
) {
  return path.resolve(workingDirectory, WRANGLER_FILENAME)
}
