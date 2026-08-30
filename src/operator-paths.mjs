import os from "node:os"
import path from "node:path"

import { FleetConfigurationError } from "./cli-contract.mjs"

const APPLICATION_DIRECTORY = "cloudflare-fleet"
const POLICY_FILENAME = "fleet-policy.json"
const STATE_FILENAME = "state.json"
const WRANGLER_FILENAME = "wrangler.jsonc"

export const OPERATOR_PATH_SOURCE = Object.freeze({
  ARGUMENT: "argument",
  DEFAULT: "default",
  ENVIRONMENT: "environment",
  XDG: "xdg",
})

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

function configuredFileSelection({
  argument,
  argumentName,
  defaultFile,
  environment,
  environmentName,
  workingDirectory,
  xdgName,
}) {
  if (argument) {
    return {
      path: path.resolve(workingDirectory, argument),
      source: OPERATOR_PATH_SOURCE.ARGUMENT,
      sourceName: argumentName,
    }
  }
  const configured = environment[environmentName]
  if (configured) {
    if (!path.isAbsolute(configured)) {
      throw new FleetConfigurationError(`${environmentName} must be an absolute path`)
    }
    return {
      path: path.resolve(configured),
      source: OPERATOR_PATH_SOURCE.ENVIRONMENT,
      sourceName: environmentName,
    }
  }
  return {
    path: defaultFile(),
    source: environment[xdgName]
      ? OPERATOR_PATH_SOURCE.XDG
      : OPERATOR_PATH_SOURCE.DEFAULT,
    sourceName: environment[xdgName] ? xdgName : "per-user default",
  }
}

export function fleetStateFileSelection(
  argument,
  environment = process.env,
  options = {},
) {
  const homeDirectory = options.homeDirectory || os.homedir()
  const workingDirectory = options.workingDirectory || process.cwd()
  return configuredFileSelection({
    argument,
    argumentName: "--state-file",
    defaultFile: () => defaultFleetStateFile(environment, homeDirectory),
    environment,
    environmentName: "CLOUDFLARE_FLEET_STATE_FILE",
    workingDirectory,
    xdgName: "XDG_STATE_HOME",
  })
}

export function fleetPolicyFileSelection(
  argument,
  environment = process.env,
  options = {},
) {
  const homeDirectory = options.homeDirectory || os.homedir()
  const workingDirectory = options.workingDirectory || process.cwd()
  return configuredFileSelection({
    argument,
    argumentName: "--policy-file",
    defaultFile: () => defaultFleetPolicyFile(environment, homeDirectory),
    environment,
    environmentName: "CLOUDFLARE_FLEET_POLICY_FILE",
    workingDirectory,
    xdgName: "XDG_CONFIG_HOME",
  })
}
