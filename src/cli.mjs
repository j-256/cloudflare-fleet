#!/usr/bin/env node

import process from "node:process"

import {
  ALIGNMENT_PREPARATION_STATUS,
  normalizeAlignmentSelector,
} from "./alignment-service.mjs"
import { runFleetAuditCommand } from "./audit.mjs"
import { isMainModule } from "./entrypoint.mjs"
import {
  createLocalFleetService,
  FLEET_SERVICE_SCHEMA_VERSION,
} from "./fleet-service.mjs"
import { OPERATION_ACTIVITY_STATUS } from "./operation-history.mjs"
import { AlignmentPlanChangedError } from "./write-executor.mjs"

const CLI_FORMAT = Object.freeze({
  JSON: "json",
  TEXT: "text",
})

export const FLEET_CLI_EXIT_CODE = Object.freeze({
  BLOCKED: 2,
  ERROR: 1,
  PLAN_CHANGED: 3,
  SUCCESS: 0,
  VERIFICATION_FAILED: 5,
  WRITE_FAILED: 4,
})

const OPTION_WITH_VALUE = new Set([
  "category",
  "expect-plan",
  "format",
  "key",
  "phase",
  "policy-file",
  "policy",
  "state-file",
  "zone-id",
])

export function fleetUsage() {
  return [
    "NAME",
    "  cloudflare-fleet - inspect and align Cloudflare fleet intent",
    "",
    "SYNOPSIS",
    "  cloudflare-fleet audit [AUDIT_OPTIONS]",
    "  cloudflare-fleet alignment list [--format text|json] [--state-file PATH]",
    "  cloudflare-fleet alignment plan SELECTOR [--format text|json] [--state-file PATH]",
    "  cloudflare-fleet alignment apply SELECTOR --expect-plan DIGEST [--format text|json] [--state-file PATH]",
    "  cloudflare-fleet activity list [--format text|json] [--state-file PATH]",
    "  cloudflare-fleet mcp [--policy-file PATH] [--state-file PATH]",
    "",
    "SELECTOR",
    "  --policy ID",
    "  --category CATEGORY --key KEY [--phase PHASE] [--zone-id ID ...]",
    "",
    "ENVIRONMENT",
    "  CLOUDFLARE_API_TOKEN        Required account-level Cloudflare API token",
    "  CLOUDFLARE_ACCOUNT_ID       Required Cloudflare account identifier",
    "  CLOUDFLARE_FLEET_STATE_FILE Optional absolute fleet-state JSON file",
  ].join("\n")
}

function splitOption(argument) {
  if (!argument.startsWith("--")) {
    throw new Error(`Unexpected argument: ${argument}`)
  }
  const equals = argument.indexOf("=")
  if (equals === -1) return { name: argument.slice(2), value: null }
  return {
    name: argument.slice(2, equals),
    value: argument.slice(equals + 1),
  }
}

function setSingleOption(options, name, value) {
  const property = name.replaceAll("-", "")
  if (options[property] !== null) {
    throw new Error(`--${name} may only be provided once`)
  }
  options[property] = value
}

function parseOptions(argv, allowed) {
  const options = {
    category: null,
    expectplan: null,
    format: CLI_FORMAT.TEXT,
    help: false,
    key: null,
    phase: null,
    policy: null,
    policyfile: null,
    statefile: null,
    zoneIds: [],
  }
  let formatSeen = false
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === "-h" || argument === "--help") {
      options.help = true
      continue
    }
    const parsed = splitOption(argument)
    if (!allowed.has(parsed.name)) {
      throw new Error(`Unknown option: --${parsed.name}`)
    }
    if (!OPTION_WITH_VALUE.has(parsed.name)) {
      throw new Error(`Unsupported option: --${parsed.name}`)
    }
    let value = parsed.value
    if (value === null) {
      value = argv[index + 1]
      if (!value || value.startsWith("--")) {
        throw new Error(`--${parsed.name} requires a value`)
      }
      index += 1
    }
    if (value.length === 0) {
      throw new Error(`--${parsed.name} requires a value`)
    }
    if (parsed.name === "zone-id") {
      options.zoneIds.push(value)
    } else if (parsed.name === "format") {
      if (formatSeen) throw new Error("--format may only be provided once")
      options.format = value
      formatSeen = true
    } else {
      setSingleOption(options, parsed.name, value)
    }
  }
  if (!Object.values(CLI_FORMAT).includes(options.format)) {
    throw new Error(`Unsupported output format: ${options.format}`)
  }
  return options
}

function selectorFromOptions(options) {
  return normalizeAlignmentSelector({
    category: options.category,
    key: options.key,
    phase: options.phase || "",
    policyId: options.policy,
    zoneIds: options.zoneIds.length > 0 ? options.zoneIds : null,
  })
}

const COMMON_OPTIONS = new Set(["format", "state-file"])
const SELECTOR_OPTIONS = new Set([
  ...COMMON_OPTIONS,
  "category",
  "key",
  "phase",
  "policy",
  "zone-id",
])

export function parseFleetArguments(argv) {
  const [resource, action, ...rest] = argv
  if (!resource || resource === "-h" || resource === "--help" || resource === "help") {
    return { command: "help" }
  }
  if (resource === "audit") {
    return { argv: argv.slice(1), command: "audit" }
  }
  if (resource === "mcp") {
    const options = parseOptions(
      argv.slice(1),
      new Set(["policy-file", "state-file"]),
    )
    if (options.help) return { command: "help" }
    return {
      command: "mcp",
      policyFile: options.policyfile,
      stateFile: options.statefile,
    }
  }
  if (resource === "alignment") {
    if (!["list", "plan", "apply"].includes(action)) {
      throw new Error("Alignment command must be list, plan, or apply")
    }
    const allowed = action === "list"
      ? COMMON_OPTIONS
      : action === "apply"
        ? new Set([...SELECTOR_OPTIONS, "expect-plan"])
        : SELECTOR_OPTIONS
    const options = parseOptions(rest, allowed)
    if (options.help) return { command: "help" }
    if (action === "list") {
      return {
        command: "alignment-list",
        format: options.format,
        stateFile: options.statefile,
      }
    }
    const selector = selectorFromOptions(options)
    if (action === "apply" && !options.expectplan) {
      throw new Error("alignment apply requires --expect-plan")
    }
    return {
      command: `alignment-${action}`,
      expectedDigest: options.expectplan,
      format: options.format,
      selector,
      stateFile: options.statefile,
    }
  }
  if (resource === "activity") {
    if (action !== "list") throw new Error("Activity command must be list")
    const options = parseOptions(rest, COMMON_OPTIONS)
    if (options.help) return { command: "help" }
    return {
      command: "activity-list",
      format: options.format,
      stateFile: options.statefile,
    }
  }
  throw new Error(`Unknown command: ${resource}`)
}

function selectorText(selector) {
  if (selector.policyId) return `policy ${selector.policyId}`
  const facet = `${selector.category}/${selector.key}${selector.phase ? `/${selector.phase}` : ""}`
  return selector.zoneIds
    ? `${facet} in ${selector.zoneIds.join(", ")}`
    : facet
}

function alignmentAvailability(candidate) {
  if (!candidate.assessment.available) return "blocked"
  if (candidate.assessment.actionableCount > 0) return "ready"
  return "aligned"
}

function renderAlignmentList(result) {
  const lines = [
    `Alignment candidates for account ${result.accountId}`,
    `${result.summary.candidates} candidates across ${result.summary.zones} zones; ${result.summary.availableCandidates} ready, ${result.summary.blockedCandidates} blocked`,
  ]
  for (const candidate of result.candidates) {
    lines.push(
      `- [${alignmentAvailability(candidate)}] ${candidate.facet.label}: ${selectorText(candidate.selector)}`,
    )
    if (candidate.assessment.reason) {
      lines.push(`  ${candidate.assessment.reason}`)
    }
  }
  if (result.candidates.length === 0) lines.push("No alignment candidates")
  return lines.join("\n")
}

function renderAlignmentPlan(result) {
  const lines = [
    `Alignment ${result.status}: ${result.facet?.label || selectorText(result.selector)}`,
    result.reason,
  ].filter(Boolean)
  if (!result.planSet) return lines.join("\n")
  lines.push(
    `Plan: ${result.planSet.digest}`,
    `Validated: ${result.planSet.validatedAt}`,
    `Intent revision: ${result.planSet.intentRevision || "empty"}`,
    "Operations:",
  )
  for (const operation of result.planSet.preview) {
    lines.push(
      `- ${operation.method} ${operation.path} on ${operation.zoneName}`,
      `  ${operation.label}: ${JSON.stringify(operation.body)}`,
    )
  }
  return lines.join("\n")
}

function renderAlignmentApply(result) {
  if ([
    ALIGNMENT_PREPARATION_STATUS.ALIGNED,
    ALIGNMENT_PREPARATION_STATUS.BLOCKED,
  ].includes(result.status)) {
    return renderAlignmentPlan(result)
  }
  const lines = [
    `Alignment ${result.status} for account ${result.accountId}`,
    `Plan: ${result.planDigest}`,
    `Execution: ${result.execution.completed}/${result.execution.total}`,
    `Verification reads: ${result.verification.length}`,
  ]
  if (result.error) lines.push(`Error: ${result.error}`)
  if (result.historyError) lines.push(`Activity warning: ${result.historyError}`)
  return lines.join("\n")
}

function renderActivity(result) {
  const lines = [
    `Operation activity for account ${result.accountId}`,
    `${result.entries.length} entries`,
  ]
  for (const entry of result.entries) {
    const execution = entry.execution
      ? ` ${entry.execution.completed}/${entry.execution.total}`
      : ""
    lines.push(`- [${entry.status}] ${entry.startedAt} ${entry.title}${execution}`)
    if (entry.error) lines.push(`  ${entry.error}`)
  }
  if (result.entries.length === 0) lines.push("No operation activity")
  return lines.join("\n")
}

function renderResult(command, result) {
  if (command === "alignment-list") return renderAlignmentList(result)
  if (command === "alignment-plan") return renderAlignmentPlan(result)
  if (command === "alignment-apply") return renderAlignmentApply(result)
  if (command === "activity-list") return renderActivity(result)
  throw new TypeError(`No renderer for ${command}`)
}

function resultExitCode(result) {
  if (result.status === ALIGNMENT_PREPARATION_STATUS.BLOCKED) {
    return FLEET_CLI_EXIT_CODE.BLOCKED
  }
  if (result.status === OPERATION_ACTIVITY_STATUS.WRITE_FAILED) {
    return FLEET_CLI_EXIT_CODE.WRITE_FAILED
  }
  if (result.status === OPERATION_ACTIVITY_STATUS.VERIFICATION_FAILED) {
    return FLEET_CLI_EXIT_CODE.VERIFICATION_FAILED
  }
  return FLEET_CLI_EXIT_CODE.SUCCESS
}

function progressReporter(stderr, topic) {
  let lastMessage = ""
  return (progress) => {
    const message = progress.message || `${progress.stage || "working"} ${progress.completed}/${progress.total}`
    if (message === lastMessage) return
    lastMessage = message
    stderr.write(`[${topic}] ${message}\n`)
  }
}

function writeResult(stdout, format, command, result) {
  const output = format === CLI_FORMAT.JSON
    ? JSON.stringify(result, null, 2)
    : renderResult(command, result)
  stdout.write(`${output}\n`)
}

export async function runFleetCommand(options = {}) {
  const argv = options.argv || process.argv.slice(2)
  const environment = options.environment || process.env
  const stdout = options.stdout || process.stdout
  const stderr = options.stderr || process.stderr
  const parsed = parseFleetArguments(argv)
  if (parsed.command === "help") {
    stdout.write(`${fleetUsage()}\n`)
    options.onExitCode?.(FLEET_CLI_EXIT_CODE.SUCCESS)
    return null
  }
  if (parsed.command === "audit") {
    return runFleetAuditCommand({
      ...options,
      argv: parsed.argv,
      environment,
      stderr,
      stdout,
    })
  }
  if (parsed.command === "mcp") {
    const { runFleetMcpServer } = await import("./mcp.mjs")
    return runFleetMcpServer({
      environment,
      policyFile: parsed.policyFile,
      stateFile: parsed.stateFile,
      stderr,
    })
  }
  const service = options.service || createLocalFleetService({
    environment,
    stateFile: parsed.stateFile,
  })
  const commandOptions = {
    onProgress: progressReporter(stderr, parsed.command),
    signal: options.signal,
  }
  let result
  if (parsed.command === "alignment-list") {
    result = await service.listAlignments(commandOptions)
  } else if (parsed.command === "alignment-plan") {
    result = await service.planAlignment(parsed.selector, commandOptions)
  } else if (parsed.command === "alignment-apply") {
    result = await service.applyAlignment(
      parsed.selector,
      parsed.expectedDigest,
      commandOptions,
    )
  } else if (parsed.command === "activity-list") {
    result = await service.listActivity(commandOptions)
  } else {
    throw new TypeError(`Unsupported fleet command: ${parsed.command}`)
  }
  writeResult(stdout, parsed.format, parsed.command, result)
  const exitCode = resultExitCode(result)
  options.onExitCode?.(exitCode)
  return result
}

function requestedJson(argv) {
  return argv.some((argument, index) => (
    argument === "--format=json"
      || (argument === "--format" && argv[index + 1] === "json")
  ))
}

function errorExitCode(error) {
  return error instanceof AlignmentPlanChangedError
    ? FLEET_CLI_EXIT_CODE.PLAN_CHANGED
    : FLEET_CLI_EXIT_CODE.ERROR
}

function errorResult(error) {
  const result = {
    error: {
      message: error instanceof Error ? error.message : String(error),
      name: error instanceof Error ? error.name : "Error",
    },
    schemaVersion: FLEET_SERVICE_SCHEMA_VERSION,
    status: error instanceof AlignmentPlanChangedError
      ? "plan-changed"
      : "error",
  }
  if (error instanceof AlignmentPlanChangedError) {
    result.error.actualDigest = error.actualDigest
    result.error.expectedDigest = error.expectedDigest
  }
  return result
}

export async function runFleetCli(options = {}) {
  const argv = options.argv || process.argv.slice(2)
  const stdout = options.stdout || process.stdout
  const stderr = options.stderr || process.stderr
  try {
    return await runFleetCommand({ ...options, argv, stderr, stdout })
  } catch (error) {
    const exitCode = errorExitCode(error)
    if (requestedJson(argv)) {
      stdout.write(`${JSON.stringify(errorResult(error), null, 2)}\n`)
    } else {
      stderr.write(`[fleet] ${error instanceof Error ? error.message : String(error)}\n`)
    }
    options.onExitCode?.(exitCode)
    return null
  }
}

if (isMainModule(import.meta.url)) {
  runFleetCli({
    onExitCode(exitCode) {
      process.exitCode = exitCode
    },
  })
}
