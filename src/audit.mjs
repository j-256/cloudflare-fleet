#!/usr/bin/env node

import process from "node:process"

import { CloudflareApi } from "./api.mjs"
import { collectDeepAuditFindings } from "./audit-deep.mjs"
import {
  buildFleetAudit,
  FLEET_AUDIT_SEVERITY,
  renderFleetAuditHtml,
  renderFleetAuditMarkdown,
} from "./audit-report.mjs"
import {
  FLEET_CLI_EXIT_CODE,
  FleetConfigurationError,
} from "./cli-contract.mjs"
import { CliUsageError, parseCliOptions } from "./cli-options.mjs"
import { isMainModule } from "./entrypoint.mjs"
import { readFleetPolicyConfiguration } from "./fleet-policy-store.mjs"
import { loadInventory } from "./inventory.mjs"
import {
  fleetPolicyFileSelection,
  fleetStateFileSelection,
} from "./operator-paths.mjs"
import { readFleetStateDocument } from "./state-store.mjs"

const AUDIT_FORMAT = Object.freeze({
  HTML: "html",
  JSON: "json",
  MARKDOWN: "markdown",
})
export const FLEET_AUDIT_EXIT_CODE = Object.freeze({
  ERROR: FLEET_CLI_EXIT_CODE.ERROR,
  FINDINGS: FLEET_CLI_EXIT_CODE.ATTENTION,
  SUCCESS: FLEET_CLI_EXIT_CODE.SUCCESS,
})
const FLEET_AUDIT_SEVERITY_ORDER = Object.freeze([
  FLEET_AUDIT_SEVERITY.CRITICAL,
  FLEET_AUDIT_SEVERITY.WARNING,
  FLEET_AUDIT_SEVERITY.REVIEW,
  FLEET_AUDIT_SEVERITY.INFO,
])
export function fleetAuditUsage() {
  return [
    "NAME",
    "  cloudflare-fleet audit - inspect live Cloudflare fleet configuration without writing",
    "",
    "SYNOPSIS",
    "  cloudflare-fleet audit [--deep] [--format markdown|json|html] [--fail-on LEVEL] [--policy-file PATH] [--state-file PATH]",
    "",
    "OPTIONS",
    "  -d, --deep              Add delegation, Registrar, Pages, storage, endpoint, and Worker dependency checks",
    "  --fail-on LEVEL         Exit 4 for findings at or above critical, warning, review, or info",
    "  -f, --format FORMAT     Render markdown, JSON, or self-contained HTML (default: markdown)",
    "  -p, --policy-file PATH  Read fleet policy exceptions from PATH",
    "  -s, --state-file PATH   Read fleet intent and coverage expectations from PATH",
    "  -h, --help              Show this help text",
    "",
    "ENVIRONMENT",
    "  CLOUDFLARE_API_TOKEN        Required account-level Cloudflare API token",
    "  CLOUDFLARE_ACCOUNT_ID       Required Cloudflare account identifier",
    "  CLOUDFLARE_FLEET_STATE_FILE Optional absolute fleet-state JSON file",
    "  CLOUDFLARE_FLEET_POLICY_FILE Optional absolute fleet-policy JSON file",
    "  XDG_STATE_HOME                Optional absolute base for default fleet state",
    "  XDG_CONFIG_HOME               Optional absolute base for default fleet policy",
    "",
    "FILES",
    "  State defaults to $XDG_STATE_HOME/cloudflare-fleet/state.json",
    "  Policy defaults to $XDG_CONFIG_HOME/cloudflare-fleet/fleet-policy.json",
    "  Standard user state and config directories are used when XDG values are unset",
    "",
    "EXIT STATUS",
    "  0  Audit completed and the requested threshold was clear",
    "  1  Audit failed",
    "  2  Command usage was invalid",
    "  4  Findings met the requested --fail-on threshold",
  ].join("\n")
}

export function parseFleetAuditArguments(argv) {
  const options = parseCliOptions(argv, [
    { default: false, name: "deep", short: "d", value: false },
    { key: "failOn", name: "fail-on", value: true },
    { default: AUDIT_FORMAT.MARKDOWN, name: "format", short: "f", value: true },
    { default: false, name: "help", short: "h", value: false },
    { key: "policyFile", name: "policy-file", short: "p", value: true },
    { key: "stateFile", name: "state-file", short: "s", value: true },
  ])
  delete options.positionals
  if (!Object.values(AUDIT_FORMAT).includes(options.format)) {
    throw new CliUsageError(`Unsupported audit format: ${options.format}`)
  }
  if (options.failOn !== null
    && !FLEET_AUDIT_SEVERITY_ORDER.includes(options.failOn)) {
    throw new CliUsageError(`Unsupported audit fail threshold: ${options.failOn}`)
  }
  return options
}

export function fleetAuditExitCode(report, failOn) {
  if (!failOn) return FLEET_AUDIT_EXIT_CODE.SUCCESS
  const threshold = FLEET_AUDIT_SEVERITY_ORDER.indexOf(failOn)
  if (threshold < 0) throw new TypeError(`Unsupported audit fail threshold: ${failOn}`)
  const thresholdMet = (report?.findings || []).some((entry) => {
    const severity = FLEET_AUDIT_SEVERITY_ORDER.indexOf(entry.severity)
    if (severity < 0) {
      throw new TypeError(`Unsupported audit finding severity: ${entry.severity}`)
    }
    return severity <= threshold
  })
  return thresholdMet
    ? FLEET_AUDIT_EXIT_CODE.FINDINGS
    : FLEET_AUDIT_EXIT_CODE.SUCCESS
}

function progressReporter(stderr) {
  let lastStage = ""
  return (progress) => {
    const shouldReport = progress.stage !== lastStage
      || progress.completed === progress.total
      || progress.completed % 25 === 0
    lastStage = progress.stage
    if (shouldReport) stderr.write(`[audit] ${progress.message}\n`)
  }
}

export function resolveStateFile(argument, environment) {
  return fleetStateFileSelection(argument, environment).path
}

export function resolvePolicyFile(argument, environment) {
  return fleetPolicyFileSelection(argument, environment).path
}

export async function collectFleetAudit(options = {}) {
  const environment = options.environment || process.env
  const apiToken = environment.CLOUDFLARE_API_TOKEN
  const accountId = options.accountId || options.api?.accountId
    || environment.CLOUDFLARE_ACCOUNT_ID
  if (!options.api && !apiToken) {
    throw new FleetConfigurationError("CLOUDFLARE_API_TOKEN is required")
  }
  if (!accountId) {
    throw new FleetConfigurationError("CLOUDFLARE_ACCOUNT_ID is required")
  }
  const api = options.api || new CloudflareApi({ accountId, apiToken })
  const stateFile = resolveStateFile(options.stateFile, environment)
  const policyFile = resolvePolicyFile(options.policyFile, environment)
  const [state, policy, inventory] = await Promise.all([
    readFleetStateDocument(stateFile, accountId),
    readFleetPolicyConfiguration(policyFile),
    loadInventory(api, {
      onProgress: options.onProgress,
      signal: options.signal,
    }),
  ])
  const now = options.now ?? Date.now()
  const deepFindings = options.deep
    ? await collectDeepAuditFindings(api, inventory, {
        fetchImpl: options.fetchImpl,
        now,
        onProgress: options.onProgress,
      })
    : []
  return buildFleetAudit(inventory, {
    deep: options.deep === true,
    deepFindings,
    intent: state.intent,
    now,
    policyConfiguration: policy,
  })
}

export async function runFleetAuditCommand(options = {}) {
  const argv = options.argv || process.argv.slice(2)
  const environment = options.environment || process.env
  const stdout = options.stdout || process.stdout
  const stderr = options.stderr || process.stderr
  const parsed = parseFleetAuditArguments(argv)
  if (parsed.help) {
    stdout.write(`${fleetAuditUsage()}\n`)
    return null
  }
  const onProgress = progressReporter(stderr)
  stderr.write("[audit] Reading fleet state and live Cloudflare inventory\n")
  const report = await collectFleetAudit({
    ...options,
    deep: parsed.deep,
    environment,
    onProgress,
    policyFile: parsed.policyFile,
    stateFile: parsed.stateFile,
  })
  const output = parsed.format === AUDIT_FORMAT.JSON
    ? `${JSON.stringify(report, null, 2)}\n`
    : parsed.format === AUDIT_FORMAT.HTML
      ? renderFleetAuditHtml(report)
      : renderFleetAuditMarkdown(report)
  stdout.write(output)
  stderr.write(`[audit] Complete: ${report.summary.findings} findings across ${report.summary.zones} zones\n`)
  const exitCode = fleetAuditExitCode(report, parsed.failOn)
  if (parsed.failOn) {
    stderr.write(`[audit] Fail threshold ${parsed.failOn}: ${exitCode === FLEET_AUDIT_EXIT_CODE.FINDINGS ? "met" : "clear"} (exit ${exitCode})\n`)
  }
  options.onExitCode?.(exitCode)
  return report
}

if (isMainModule(import.meta.url)) {
  runFleetAuditCommand({
    onExitCode(exitCode) {
      process.exitCode = exitCode
    },
  }).catch((error) => {
    process.stderr.write(`[audit] ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = error instanceof CliUsageError
      || error instanceof FleetConfigurationError
      ? FLEET_CLI_EXIT_CODE.USAGE
      : FLEET_AUDIT_EXIT_CODE.ERROR
  })
}
