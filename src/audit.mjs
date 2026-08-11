#!/usr/bin/env node

import path from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"

import { CloudflareApi } from "./api.mjs"
import { collectDeepAuditFindings } from "./audit-deep.mjs"
import {
  buildFleetAudit,
  FLEET_AUDIT_SEVERITY,
  renderFleetAuditHtml,
  renderFleetAuditMarkdown,
} from "./audit-report.mjs"
import { isMainModule } from "./entrypoint.mjs"
import { loadInventory } from "./inventory.mjs"
import { readFleetStateDocument } from "./state-store.mjs"

const AUDIT_FORMAT = Object.freeze({
  HTML: "html",
  JSON: "json",
  MARKDOWN: "markdown",
})
export const FLEET_AUDIT_EXIT_CODE = Object.freeze({
  ERROR: 1,
  FINDINGS: 2,
  SUCCESS: 0,
})
const FLEET_AUDIT_SEVERITY_ORDER = Object.freeze([
  FLEET_AUDIT_SEVERITY.CRITICAL,
  FLEET_AUDIT_SEVERITY.WARNING,
  FLEET_AUDIT_SEVERITY.REVIEW,
  FLEET_AUDIT_SEVERITY.INFO,
])
const DEFAULT_STATE_FILE = fileURLToPath(new URL("../state.json", import.meta.url))

export function fleetAuditUsage() {
  return [
    "NAME",
    "  cloudflare-fleet-audit - inspect live Cloudflare fleet configuration without writing",
    "",
    "SYNOPSIS",
    "  node src/audit.mjs [--deep] [--format markdown|json|html] [--fail-on LEVEL] [--state-file PATH]",
    "",
    "OPTIONS",
    "  --deep             Add delegation, Registrar, Pages, storage, endpoint, and Worker dependency checks",
    "  --fail-on LEVEL    Exit 2 for findings at or above critical, warning, review, or info",
    "  --format FORMAT    Render markdown, JSON, or self-contained HTML (default: markdown)",
    "  --state-file PATH  Read fleet intent and coverage expectations from PATH",
    "  -h, --help         Show this help text",
    "",
    "ENVIRONMENT",
    "  CLOUDFLARE_API_TOKEN        Required account-level Cloudflare API token",
    "  CLOUDFLARE_ACCOUNT_ID       Required Cloudflare account identifier",
    "  CLOUDFLARE_FLEET_STATE_FILE Optional absolute fleet-state JSON file",
  ].join("\n")
}

export function parseFleetAuditArguments(argv) {
  const options = {
    deep: false,
    failOn: null,
    format: AUDIT_FORMAT.MARKDOWN,
    help: false,
    stateFile: null,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === "-h" || argument === "--help") {
      options.help = true
      continue
    }
    if (argument === "--deep") {
      options.deep = true
      continue
    }
    if (["--fail-on", "--format", "--state-file"].includes(argument)) {
      const value = argv[index + 1]
      if (!value || value.startsWith("--")) {
        throw new Error(`${argument} requires a value`)
      }
      index += 1
      if (argument === "--fail-on") options.failOn = value
      else if (argument === "--format") options.format = value
      else options.stateFile = value
      continue
    }
    if (argument.startsWith("--fail-on=")) {
      options.failOn = argument.slice("--fail-on=".length)
      continue
    }
    if (argument.startsWith("--format=")) {
      options.format = argument.slice("--format=".length)
      continue
    }
    if (argument.startsWith("--state-file=")) {
      options.stateFile = argument.slice("--state-file=".length)
      continue
    }
    throw new Error(`Unknown option: ${argument}`)
  }
  if (!Object.values(AUDIT_FORMAT).includes(options.format)) {
    throw new Error(`Unsupported audit format: ${options.format}`)
  }
  if (options.failOn !== null
    && !FLEET_AUDIT_SEVERITY_ORDER.includes(options.failOn)) {
    throw new Error(`Unsupported audit fail threshold: ${options.failOn}`)
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

function resolveStateFile(argument, environment) {
  const configured = argument || environment.CLOUDFLARE_FLEET_STATE_FILE
  if (!configured) return DEFAULT_STATE_FILE
  if (environment.CLOUDFLARE_FLEET_STATE_FILE === configured
    && !path.isAbsolute(configured)) {
    throw new Error("CLOUDFLARE_FLEET_STATE_FILE must be an absolute path")
  }
  return path.resolve(configured)
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
  const apiToken = environment.CLOUDFLARE_API_TOKEN
  const accountId = environment.CLOUDFLARE_ACCOUNT_ID
  if (!apiToken) throw new Error("CLOUDFLARE_API_TOKEN is required")
  if (!accountId) throw new Error("CLOUDFLARE_ACCOUNT_ID is required")
  const api = options.api || new CloudflareApi({ accountId, apiToken })
  const stateFile = resolveStateFile(parsed.stateFile, environment)
  const onProgress = progressReporter(stderr)
  stderr.write("[audit] Reading fleet state and live Cloudflare inventory\n")
  const [state, inventory] = await Promise.all([
    readFleetStateDocument(stateFile, accountId),
    loadInventory(api, { onProgress }),
  ])
  const now = options.now ?? Date.now()
  const deepFindings = parsed.deep
    ? await collectDeepAuditFindings(api, inventory, {
        fetchImpl: options.fetchImpl,
        now,
        onProgress,
      })
    : []
  const report = buildFleetAudit(inventory, {
    deep: parsed.deep,
    deepFindings,
    intent: state.intent,
    now,
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
    process.exitCode = FLEET_AUDIT_EXIT_CODE.ERROR
  })
}
