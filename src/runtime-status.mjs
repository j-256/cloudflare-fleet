import { constants as fsConstants, promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import process from "node:process"

import { CloudflareApi } from "./api.mjs"
import {
  fleetPolicyFileSelection,
  fleetStateFileSelection,
} from "./operator-paths.mjs"
import { PACKAGE_VERSION } from "./package-metadata.mjs"

export const FLEET_RUNTIME_SCHEMA_VERSION = 1
export const FLEET_RUNTIME_STATUS = Object.freeze({
  ATTENTION: "attention",
  READY: "ready",
})
export const RUNTIME_CHECK_STATUS = Object.freeze({
  FAIL: "fail",
  PASS: "pass",
  SKIP: "skip",
  WARNING: "warning",
})

const MINIMUM_NODE_MAJOR = 22
const LIVE_PROBE_TIMEOUT_MS = 10000
const DEFAULT_CHROME_APP = "/Applications/Google Chrome.app"
const DEFAULT_CHROME_BINARY = `${DEFAULT_CHROME_APP}/Contents/MacOS/Google Chrome`
const DASHBOARD_COMMANDS = Object.freeze([
  Object.freeze({ id: "jq", label: "jq" }),
  Object.freeze({ id: "curl", label: "curl" }),
  Object.freeze({ id: "plutil", label: "plutil" }),
])

function present(value) {
  return typeof value === "string" && value.length > 0
}

function fileMode(metadata) {
  return `0${(metadata.mode & 0o777).toString(8).padStart(3, "0")}`
}

function pathKind(metadata) {
  if (metadata.isFile()) return "file"
  if (metadata.isDirectory()) return "directory"
  if (metadata.isSymbolicLink()) return "symbolic-link"
  return "other"
}

async function nearestExistingDirectory(directory, fsImpl) {
  let candidate = path.resolve(directory)
  while (true) {
    try {
      const metadata = await fsImpl.stat(candidate)
      if (metadata.isDirectory()) return candidate
    } catch (error) {
      if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") throw error
    }
    const parent = path.dirname(candidate)
    if (parent === candidate) return null
    candidate = parent
  }
}

async function accessStatus(target, mode, fsImpl) {
  try {
    await fsImpl.access(target, mode)
    return true
  } catch {
    return false
  }
}

async function inspectOperatorFile(selection, options) {
  const fsImpl = options.fsImpl
  const desiredParent = path.dirname(selection.path)
  let linkMetadata
  try {
    linkMetadata = await fsImpl.lstat(selection.path)
  } catch (error) {
    if (error?.code !== "ENOENT") throw error
  }

  const existingParent = await nearestExistingDirectory(desiredParent, fsImpl)
  const parentWritable = existingParent
    ? await accessStatus(
        existingParent,
        fsConstants.W_OK | fsConstants.X_OK,
        fsImpl,
      )
    : false
  const parent = {
    desiredPath: desiredParent,
    existingPath: existingParent,
    writable: parentWritable,
  }

  if (!linkMetadata) {
    return {
      ...selection,
      accessible: false,
      exists: false,
      kind: "missing",
      mode: null,
      parent,
      permissionsPrivate: null,
      symbolicLink: false,
    }
  }

  const symbolicLink = linkMetadata.isSymbolicLink()
  let metadata = linkMetadata
  let targetMissing = false
  if (symbolicLink) {
    try {
      metadata = await fsImpl.stat(selection.path)
    } catch (error) {
      if (error?.code !== "ENOENT") throw error
      targetMissing = true
    }
  }
  const kind = targetMissing ? "broken-symbolic-link" : pathKind(metadata)
  const requestedAccess = options.writeRequired
    ? fsConstants.R_OK | fsConstants.W_OK
    : fsConstants.R_OK
  const accessible = targetMissing
    ? false
    : await accessStatus(selection.path, requestedAccess, fsImpl)
  const permissionsPrivate = options.platform === "win32"
    || !metadata.isFile()
    ? null
    : (metadata.mode & 0o077) === 0
  return {
    ...selection,
    accessible,
    exists: true,
    kind,
    mode: targetMissing ? null : fileMode(metadata),
    parent,
    permissionsPrivate,
    symbolicLink,
  }
}

async function executablePath(command, environment, fsImpl) {
  const directories = String(environment.PATH || "")
    .split(path.delimiter)
    .filter(Boolean)
  for (const directory of directories) {
    const candidate = path.join(directory, command)
    if (await accessStatus(candidate, fsConstants.X_OK, fsImpl)) {
      return candidate
    }
  }
  return null
}

async function dashboardBrowser(environment, fsImpl) {
  const configuredApp = environment.CLOUDFLARE_FLEET_CHROME_APP
  const configuredBinary = environment.CLOUDFLARE_FLEET_CHROME
  const application = configuredApp
    || (!configuredBinary || configuredBinary === DEFAULT_CHROME_BINARY
      ? DEFAULT_CHROME_APP
      : null)
  const executable = configuredBinary || DEFAULT_CHROME_BINARY
  const target = application || executable
  try {
    const metadata = await fsImpl.stat(target)
    const available = application
      ? metadata.isDirectory()
      : metadata.isFile()
        && await accessStatus(target, fsConstants.X_OK, fsImpl)
    return {
      available,
      id: "browser",
      label: "Chromium-compatible browser",
      path: target,
    }
  } catch {
    return {
      available: false,
      id: "browser",
      label: "Chromium-compatible browser",
      path: target,
    }
  }
}

async function inspectDashboard(environment, platform, fsImpl) {
  if (platform !== "darwin") {
    return {
      available: false,
      dependencies: [],
      reason: "The local dashboard launcher supports macOS; CLI and MCP workflows remain available",
      status: "unsupported",
    }
  }
  const commandDependencies = await Promise.all(
    DASHBOARD_COMMANDS.map(async (dependency) => {
      const resolvedPath = await executablePath(dependency.id, environment, fsImpl)
      return {
        ...dependency,
        available: Boolean(resolvedPath),
        path: resolvedPath,
      }
    }),
  )
  const absoluteDependencies = await Promise.all([
    ["launchctl", "launchctl", "/bin/launchctl"],
    ["open", "open", "/usr/bin/open"],
  ].map(async ([id, label, target]) => ({
    available: await accessStatus(target, fsConstants.X_OK, fsImpl),
    id,
    label,
    path: target,
  })))
  const browser = await dashboardBrowser(environment, fsImpl)
  const dependencies = [
    ...commandDependencies,
    ...absoluteDependencies,
    browser,
  ]
  const available = dependencies.every((dependency) => dependency.available)
  return {
    available,
    dependencies,
    reason: available
      ? "All local dashboard dependencies are available"
      : "One or more local dashboard dependencies are missing",
    status: available ? "ready" : "unavailable",
  }
}

function runtimeMetadata(options) {
  const nodeVersion = options.nodeVersion || process.versions.node
  const nodeMajor = Number.parseInt(nodeVersion.split(".", 1)[0], 10)
  return {
    architecture: options.architecture || process.arch,
    node: {
      minimumMajor: MINIMUM_NODE_MAJOR,
      supported: Number.isInteger(nodeMajor) && nodeMajor >= MINIMUM_NODE_MAJOR,
      version: nodeVersion,
    },
    packageVersion: PACKAGE_VERSION,
    platform: options.platform || process.platform,
  }
}

function credentialMetadata(environment) {
  return {
    accountId: {
      environmentName: "CLOUDFLARE_ACCOUNT_ID",
      present: present(environment.CLOUDFLARE_ACCOUNT_ID),
    },
    apiToken: {
      environmentName: "CLOUDFLARE_API_TOKEN",
      present: present(environment.CLOUDFLARE_API_TOKEN),
    },
  }
}

export async function inspectFleetRuntimeConfiguration(options = {}) {
  const environment = options.environment || process.env
  const fsImpl = options.fsImpl || fs
  const runtime = runtimeMetadata(options)
  const selectionOptions = {
    homeDirectory: options.homeDirectory || os.homedir(),
    workingDirectory: options.workingDirectory || process.cwd(),
  }
  const stateSelection = fleetStateFileSelection(
    options.stateFile,
    environment,
    selectionOptions,
  )
  const policySelection = fleetPolicyFileSelection(
    options.policyFile,
    environment,
    selectionOptions,
  )
  const [state, policy, dashboard] = await Promise.all([
    inspectOperatorFile(stateSelection, {
      fsImpl,
      platform: runtime.platform,
      writeRequired: true,
    }),
    inspectOperatorFile(policySelection, {
      fsImpl,
      platform: runtime.platform,
      writeRequired: false,
    }),
    inspectDashboard(environment, runtime.platform, fsImpl),
  ])
  return {
    checkedAt: new Date(options.now ?? Date.now()).toISOString(),
    credentials: credentialMetadata(environment),
    dashboard,
    paths: { policy, state },
    runtime,
    schemaVersion: FLEET_RUNTIME_SCHEMA_VERSION,
    status: "ok",
  }
}

function check(id, label, status, detail, remedy) {
  return {
    detail,
    id,
    label,
    ...(remedy ? { remedy } : {}),
    status,
  }
}

function credentialChecks(configuration) {
  return [
    ["account-id", "Cloudflare account ID", configuration.credentials.accountId],
    ["api-token", "Cloudflare API token", configuration.credentials.apiToken],
  ].map(([id, label, credential]) => check(
    `credentials.${id}`,
    label,
    credential.present ? RUNTIME_CHECK_STATUS.PASS : RUNTIME_CHECK_STATUS.FAIL,
    `${credential.environmentName} is ${credential.present ? "set" : "unset"}`,
    credential.present
      ? null
      : `Export ${credential.environmentName} in the shell that launches Cloudflare Fleet`,
  ))
}

function operatorPathChecks(name, label, inspected) {
  const checks = []
  if (!inspected.exists) {
    checks.push(check(
      `paths.${name}`,
      `${label} path`,
      inspected.parent.writable
        ? RUNTIME_CHECK_STATUS.PASS
        : RUNTIME_CHECK_STATUS.FAIL,
      inspected.parent.writable
        ? `${inspected.path} does not exist and can be created through ${inspected.parent.existingPath}`
        : `${inspected.path} does not exist and its nearest existing parent is not writable`,
      inspected.parent.writable
        ? null
        : `Choose a writable --${name}-file path or fix the parent directory permissions`,
    ))
    return checks
  }
  const expectedKind = inspected.kind === "file"
  checks.push(check(
    `paths.${name}`,
    `${label} path`,
    expectedKind && inspected.accessible
      ? RUNTIME_CHECK_STATUS.PASS
      : RUNTIME_CHECK_STATUS.FAIL,
    expectedKind
      ? `${inspected.path} is ${inspected.accessible ? "accessible" : "not accessible"}`
      : `${inspected.path} is a ${inspected.kind}, not a regular file`,
    expectedKind && inspected.accessible
      ? null
      : `Select an accessible regular file with --${name}-file`,
  ))
  if (inspected.symbolicLink) {
    checks.push(check(
      `paths.${name}-symlink`,
      `${label} indirection`,
      RUNTIME_CHECK_STATUS.WARNING,
      `${inspected.path} is a symbolic link`,
      "Verify that the link target is private, durable, and intentionally managed",
    ))
  }
  if (inspected.permissionsPrivate === false) {
    checks.push(check(
      `paths.${name}-permissions`,
      `${label} permissions`,
      RUNTIME_CHECK_STATUS.WARNING,
      `${inspected.path} has mode ${inspected.mode}; operator files should not be accessible to group or other users`,
      `Run chmod 600 ${JSON.stringify(inspected.path)}`,
    ))
  } else if (inspected.permissionsPrivate === true) {
    checks.push(check(
      `paths.${name}-permissions`,
      `${label} permissions`,
      RUNTIME_CHECK_STATUS.PASS,
      `${inspected.path} has private mode ${inspected.mode}`,
    ))
  }
  return checks
}

function dashboardChecks(configuration) {
  if (configuration.dashboard.status === "unsupported") {
    return [check(
      "dashboard.platform",
      "Local dashboard",
      RUNTIME_CHECK_STATUS.SKIP,
      configuration.dashboard.reason,
    )]
  }
  return configuration.dashboard.dependencies.map((dependency) => check(
    `dashboard.${dependency.id}`,
    `Dashboard dependency: ${dependency.label}`,
    dependency.available
      ? RUNTIME_CHECK_STATUS.PASS
      : RUNTIME_CHECK_STATUS.FAIL,
    dependency.available
      ? `${dependency.path} is available`
      : `${dependency.path || dependency.label} is unavailable`,
    dependency.available
      ? null
      : `Install or configure ${dependency.label} before using cloudflare-fleet dashboard`,
  ))
}

function liveProbeSignal(signal, timeoutMs) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
}

async function defaultLiveProbe(options) {
  const api = options.api || new CloudflareApi({
    accountId: options.accountId,
    apiToken: options.apiToken,
  })
  const response = await api.request(
    `zones?account.id=${encodeURIComponent(options.accountId)}&page=1&per_page=5`,
    { signal: options.signal },
  )
  if (!Array.isArray(response.result)) {
    throw new TypeError("Cloudflare zone-list probe returned an unexpected result")
  }
  return {
    httpStatus: response.status,
    returnedZones: response.result.length,
  }
}

function redactError(error, secret) {
  const message = error instanceof Error ? error.message : String(error)
  return present(secret) ? message.replaceAll(secret, "[redacted]") : message
}

async function liveCheck(configuration, options) {
  if (!options.live) {
    return {
      check: check(
        "cloudflare.live",
        "Cloudflare live access",
        RUNTIME_CHECK_STATUS.SKIP,
        "Not requested; use --live for one bounded zone-list request",
      ),
      result: {
        requested: false,
        status: "skipped",
      },
    }
  }
  const environment = options.environment
  if (!configuration.credentials.accountId.present
    || !configuration.credentials.apiToken.present) {
    return {
      check: check(
        "cloudflare.live",
        "Cloudflare live access",
        RUNTIME_CHECK_STATUS.SKIP,
        "Not attempted because Cloudflare credentials are incomplete",
      ),
      result: {
        requested: true,
        status: "skipped",
      },
    }
  }
  try {
    const probe = options.liveProbe || defaultLiveProbe
    const result = await probe({
      accountId: environment.CLOUDFLARE_ACCOUNT_ID,
      api: options.api,
      apiToken: environment.CLOUDFLARE_API_TOKEN,
      signal: liveProbeSignal(
        options.signal,
        options.liveProbeTimeoutMs || LIVE_PROBE_TIMEOUT_MS,
      ),
    })
    return {
      check: check(
        "cloudflare.live",
        "Cloudflare live access",
        RUNTIME_CHECK_STATUS.PASS,
        "A bounded account-scoped zone-list request succeeded",
      ),
      result: {
        ...result,
        requested: true,
        status: "ready",
      },
    }
  } catch (error) {
    const message = redactError(error, environment.CLOUDFLARE_API_TOKEN)
    return {
      check: check(
        "cloudflare.live",
        "Cloudflare live access",
        RUNTIME_CHECK_STATUS.FAIL,
        message,
        "Verify the account ID, token, network access, and Zone Read permission",
      ),
      result: {
        error: message,
        requested: true,
        status: "failed",
      },
    }
  }
}

function summarizeChecks(checks) {
  const summary = {
    fail: 0,
    pass: 0,
    skip: 0,
    warning: 0,
  }
  for (const entry of checks) summary[entry.status] += 1
  return summary
}

export async function diagnoseFleetRuntime(options = {}) {
  const environment = options.environment || process.env
  const configuration = await inspectFleetRuntimeConfiguration({
    ...options,
    environment,
  })
  const checks = [
    check(
      "runtime.node",
      "Node.js runtime",
      configuration.runtime.node.supported
        ? RUNTIME_CHECK_STATUS.PASS
        : RUNTIME_CHECK_STATUS.FAIL,
      `Node.js ${configuration.runtime.node.version} is installed; version ${configuration.runtime.node.minimumMajor} or newer is required`,
      configuration.runtime.node.supported
        ? null
        : `Install Node.js ${configuration.runtime.node.minimumMajor} or newer`,
    ),
    ...credentialChecks(configuration),
    ...operatorPathChecks("state", "Fleet state", configuration.paths.state),
    ...operatorPathChecks("policy", "Fleet policy", configuration.paths.policy),
    ...dashboardChecks(configuration),
  ]
  const live = await liveCheck(configuration, {
    ...options,
    environment,
  })
  checks.push(live.check)
  const summary = summarizeChecks(checks)
  const status = summary.fail > 0 || summary.warning > 0
    ? FLEET_RUNTIME_STATUS.ATTENTION
    : FLEET_RUNTIME_STATUS.READY
  return {
    ...configuration,
    checks,
    live: live.result,
    status,
    summary,
  }
}
