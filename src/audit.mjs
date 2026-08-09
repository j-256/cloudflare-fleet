#!/usr/bin/env node

import path from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"

import { CloudflareApi } from "./api.mjs"
import { collectDeepAuditFindings } from "./audit-deep.mjs"
import {
  buildFleetAudit,
  renderFleetAuditMarkdown,
} from "./audit-report.mjs"
import { isMainModule } from "./entrypoint.mjs"
import { loadInventory } from "./inventory.mjs"
import { readFleetStateDocument } from "./state-store.mjs"

const AUDIT_FORMAT = Object.freeze({
  JSON: "json",
  MARKDOWN: "markdown",
})
const DEFAULT_STATE_FILE = fileURLToPath(new URL("../state.json", import.meta.url))

export function fleetAuditUsage() {
  return [
    "NAME",
    "  cloudflare-fleet-audit - inspect live Cloudflare fleet configuration without writing",
    "",
    "SYNOPSIS",
    "  node src/audit.mjs [--deep] [--format markdown|json] [--state-file PATH]",
    "",
    "OPTIONS",
    "  --deep             Add delegation, Registrar, Pages, storage, endpoint, and Worker dependency checks",
    "  --format FORMAT    Render markdown or JSON (default: markdown)",
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
    if (argument === "--format" || argument === "--state-file") {
      const value = argv[index + 1]
      if (!value || value.startsWith("--")) {
        throw new Error(`${argument} requires a value`)
      }
      index += 1
      if (argument === "--format") options.format = value
      else options.stateFile = value
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
  return options
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
  stdout.write(parsed.format === AUDIT_FORMAT.JSON
    ? `${JSON.stringify(report, null, 2)}\n`
    : renderFleetAuditMarkdown(report))
  stderr.write(`[audit] Complete: ${report.summary.findings} findings across ${report.summary.zones} zones\n`)
  return report
}

if (isMainModule(import.meta.url)) {
  runFleetAuditCommand().catch((error) => {
    process.stderr.write(`[audit] ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
