#!/usr/bin/env node

import process from "node:process"
import { spawn } from "node:child_process"
import { promises as fs } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import {
  ALIGNMENT_PREPARATION_STATUS,
  normalizeAlignmentSelector,
} from "./alignment-service.mjs"
import { runFleetAuditCommand } from "./audit.mjs"
import {
  FLEET_CLI_EXIT_CODE,
  FleetConfigurationError,
} from "./cli-contract.mjs"
import { CliUsageError, parseCliOptions } from "./cli-options.mjs"
import { isMainModule } from "./entrypoint.mjs"
import { normalizeFleetChange } from "./fleet-change.mjs"
import {
  createLocalFleetService,
  FLEET_SERVICE_SCHEMA_VERSION,
} from "./fleet-service.mjs"
import { OPERATION_ACTIVITY_STATUS } from "./operation-history.mjs"
import { PACKAGE_VERSION } from "./package-metadata.mjs"
import { createProgressReporter } from "./progress.mjs"
import {
  diagnoseFleetRuntime,
  FLEET_RUNTIME_STATUS,
  inspectFleetRuntimeConfiguration,
} from "./runtime-status.mjs"
import { AlignmentPlanChangedError } from "./write-executor.mjs"
import { describeZoneAliasPolicy } from "./zone-alias-intent.mjs"
import { runWorkerCommand, WORKER_COMMANDS } from "./worker-command.mjs"

const CLI_FORMAT = Object.freeze({
  JSON: "json",
  TEXT: "text",
})
const PROJECT_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

export { FLEET_CLI_EXIT_CODE }

const HELP_OPTION = Object.freeze({
  default: false,
  name: "help",
  short: "h",
  value: false,
})
const FORMAT_OPTION = Object.freeze({
  default: CLI_FORMAT.TEXT,
  name: "format",
  short: "f",
  value: true,
})
const STATE_FILE_OPTION = Object.freeze({
  key: "statefile",
  name: "state-file",
  short: "s",
  value: true,
})
const INPUT_OPTION = Object.freeze({
  name: "input",
  short: "i",
  value: true,
})
const POLICY_FILE_OPTION = Object.freeze({
  key: "policyfile",
  name: "policy-file",
  short: "p",
  value: true,
})
const EXPECT_PLAN_OPTION = Object.freeze({
  key: "expectplan",
  name: "expect-plan",
  short: "e",
  value: true,
})
const LIVE_OPTION = Object.freeze({
  default: false,
  name: "live",
  value: false,
})
const COMMON_OPTIONS = Object.freeze([
  FORMAT_OPTION,
  HELP_OPTION,
  STATE_FILE_OPTION,
])
const SELECTOR_OPTIONS = Object.freeze([
  ...COMMON_OPTIONS,
  { name: "category", short: "c", value: true },
  { name: "key", short: "k", value: true },
  { name: "phase", value: true },
  { name: "policy", short: "p", value: true },
  { key: "zoneIds", multiple: true, name: "zone-id", short: "z", value: true },
])
const HELP_COMMAND_BY_TOPIC = Object.freeze({
  activity: "activity-help",
  alignment: "alignment-help",
  change: "change-help",
  config: "config-help",
  doctor: "doctor-help",
  hosted: "hosted-help",
  intent: "intent-help",
  mcp: "mcp-help",
  schema: "schema-help",
  worker: "worker-help",
})

export function fleetUsage() {
  return [
    "NAME",
    "  cloudflare-fleet - inspect and align Cloudflare fleet intent",
    "",
    "SYNOPSIS",
    "  cloudflare-fleet dashboard [DASHBOARD_OPTIONS]",
    "  cloudflare-fleet audit [AUDIT_OPTIONS]",
    "  cloudflare-fleet config show [--format text|json] [--policy-file PATH] [--state-file PATH]",
    "  cloudflare-fleet doctor [--live] [--format text|json] [--policy-file PATH] [--state-file PATH]",
    "  cloudflare-fleet alignment list [--format text|json] [--state-file PATH]",
    "  cloudflare-fleet alignment plan SELECTOR_OPTIONS [--format text|json] [--state-file PATH]",
    "  cloudflare-fleet alignment apply SELECTOR_OPTIONS --expect-plan DIGEST [--format text|json] [--state-file PATH]",
    "  cloudflare-fleet intent aliases|show|plan|apply [OPTIONS]",
    "  cloudflare-fleet change plan|apply --input FILE|- [OPTIONS]",
    "  cloudflare-fleet worker COMMAND --input FILE|- [--expect-plan DIGEST] [OPTIONS]",
    "  cloudflare-fleet activity list [--format text|json] [--state-file PATH]",
    "  cloudflare-fleet activity undo plan|apply --id ID [OPTIONS]",
    "  cloudflare-fleet mcp [--policy-file PATH] [--state-file PATH]",
    "  cloudflare-fleet hosted configure [OPTIONS]",
    "  cloudflare-fleet hosted import-state [OPTIONS] [STATE_FILE]",
    "  cloudflare-fleet schema change|intent",
    "  cloudflare-fleet --version",
    "",
    "SELECTOR OPTIONS",
    "  -p, --policy ID",
    "  -c, --category CATEGORY -k, --key KEY [--phase PHASE] [-z, --zone-id ID ...]",
    "",
    "OPTIONS",
    "  -e, --expect-plan DIGEST  Require the approved plan digest when applying",
    "  -f, --format text|json    Select operator text or structured JSON output",
    "  -p, --policy-file PATH    Select an operator policy profile where supported",
    "  -s, --state-file PATH     Select a fleet state profile",
    "  -h, --help                Show this help",
    "",
    "ENVIRONMENT",
    "  CLOUDFLARE_API_TOKEN        Required account-level Cloudflare API token",
    "  CLOUDFLARE_ACCOUNT_ID       Required Cloudflare account identifier",
    "  CLOUDFLARE_FLEET_STATE_FILE Optional absolute fleet-state JSON file",
    "  CLOUDFLARE_FLEET_POLICY_FILE Optional absolute fleet-policy JSON file",
    "  XDG_STATE_HOME               Optional absolute base for default fleet state",
    "  XDG_CONFIG_HOME              Optional absolute base for default fleet policy",
    "",
    "FILES",
    "  State and policy use standard per-user directories when no profile is selected",
    "",
    "EXIT STATUS",
    "  0  Command completed successfully",
    "  1  Runtime failure",
    "  2  Invalid command usage or configuration precondition",
    "  3  Required local dependency is unavailable",
    "  4  Action is blocked or operator attention is required",
    "  5  The reviewed plan changed before apply",
    "  6  A Cloudflare write failed",
    "  7  Post-write verification failed",
  ].join("\n")
}

export function fleetWorkerUsage() {
  return [
    "cloudflare-fleet worker COMMAND --input FILE|- [--expect-plan DIGEST] [--format text|json] [--state-file PATH]",
    `Commands: ${WORKER_COMMANDS.join(", ")}`,
    "Options: -i/--input JSON file or stdin; -e/--expect-plan exact approved digest for apply; -f/--format; -s/--state-file; -h/--help",
    'Inspect/record input: {"worker":"example-worker","start":"2026-01-01T00:00:00Z","end":"2026-01-01T01:00:00Z","limit":50}',
    "Inspection also accepts findingId, zoneIds (route scope), logs, and cursor with the original start/end; at most 24 past hours and 200 events",
    'History input: {"worker":"example-worker","offset":0,"limit":20}; limit at most 50',
    'Intent input: {"worker":"example-worker","expectedRevision":"","intent":{"mode":"disabled","crons":[],"owner":"repository:wrangler.jsonc","reconciliation":"Set triggers.crons to [] before the next deployment"}}',
    "Intent modes: disabled (empty crons), exact (nonempty crons), unmanaged (empty crons); managed intent requires owner and reconciliation",
    "Schedule input: worker-schedules-update fleet-change object (cloudflare-fleet schema change); uses the same guarded planner as change plan/apply",
    'Undo input: {"activityId":"activity-ID"}; verify input: {"worker":"example-worker","activityId":"activity-ID"} with optional start/end/limit/zoneIds',
    "Verify saves fresh evidence after the propagation grace period; record appends an incident; intent-apply saves local intent; schedules-apply and undo-apply write Cloudflare",
    "Environment: CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN; optional CLOUDFLARE_FLEET_STATE_FILE selects private persistence",
    "Exit statuses: 0 success, 1 runtime failure, 2 usage/precondition, 3 dependency, 4 blocked, 5 plan changed, 6 write failed, 7 verification failed",
  ].join("\n")
}

export function fleetIntentUsage() {
  return [
    "NAME",
    "  cloudflare-fleet intent - inspect and atomically replace fleet intent",
    "",
    "SYNOPSIS",
    "  cloudflare-fleet intent show [--format text|json] [--state-file PATH]",
    "  cloudflare-fleet intent aliases [--format text|json]",
    "  cloudflare-fleet intent plan --input FILE|- [--format text|json] [--state-file PATH]",
    "  cloudflare-fleet intent apply --input FILE|- --expect-plan DIGEST [--format text|json] [--state-file PATH]",
    "",
    "OPTIONS",
    "  -i, --input FILE|-       Read a complete fleet intent document from FILE or stdin",
    "  -e, --expect-plan DIGEST Require the exact reviewed plan digest before persistence",
    "  -f, --format text|json   Select operator text or structured JSON output",
    "  -s, --state-file PATH    Select a fleet state profile",
    "  -h, --help               Show this help",
    "",
    "WORKFLOW",
    "  aliases emits the strict reusable passthrough facet and initial templates",
    "  intent show emits an editable document in text mode",
    "  plan validates every collection and reports additions, changes, and removals",
    "  apply replans under the shared write lock and persists only an exact digest match",
  ].join("\n")
}

export function fleetConfigUsage() {
  return [
    "NAME",
    "  cloudflare-fleet config - explain effective local operator configuration",
    "",
    "SYNOPSIS",
    "  cloudflare-fleet config show [--format text|json] [--policy-file PATH] [--state-file PATH]",
    "",
    "OPTIONS",
    "  -f, --format text|json Select operator text or structured JSON output",
    "  -p, --policy-file PATH Explain an explicit fleet policy profile",
    "  -s, --state-file PATH  Explain an explicit fleet state profile",
    "  -h, --help             Show this help",
    "",
    "OUTPUT",
    "  Reports path precedence, file state, credential presence, runtime, and dashboard support",
    "  Never prints the Cloudflare account identifier or API token value",
  ].join("\n")
}

export function fleetDoctorUsage() {
  return [
    "NAME",
    "  cloudflare-fleet doctor - check local readiness and explain remedies",
    "",
    "SYNOPSIS",
    "  cloudflare-fleet doctor [--live] [--format text|json] [--policy-file PATH] [--state-file PATH]",
    "",
    "OPTIONS",
    "  --live                 Make one bounded account-scoped zone-list request",
    "  -f, --format text|json Select operator text or structured JSON output",
    "  -p, --policy-file PATH Check an explicit fleet policy profile",
    "  -s, --state-file PATH  Check an explicit fleet state profile",
    "  -h, --help             Show this help",
    "",
    "EXIT STATUS",
    "  0  Every required check passed; unsupported optional surfaces may be skipped",
    "  2  Command usage or configured path syntax was invalid",
    "  4  One or more checks need operator attention",
  ].join("\n")
}

export function fleetAlignmentUsage() {
  return [
    "NAME",
    "  cloudflare-fleet alignment - inspect, plan, and apply policy alignment",
    "",
    "SYNOPSIS",
    "  cloudflare-fleet alignment list [--format text|json] [--state-file PATH]",
    "  cloudflare-fleet alignment plan SELECTOR_OPTIONS [--format text|json] [--state-file PATH]",
    "  cloudflare-fleet alignment apply SELECTOR_OPTIONS --expect-plan DIGEST [--format text|json] [--state-file PATH]",
    "",
    "SELECTOR OPTIONS",
    "  -p, --policy ID",
    "  -c, --category CATEGORY -k, --key KEY [--phase PHASE] [-z, --zone-id ID ...]",
    "",
    "OPTIONS",
    "  -e, --expect-plan DIGEST Require the exact reviewed plan digest before writes",
    "  -f, --format text|json   Select operator text or structured JSON output",
    "  -s, --state-file PATH    Select a fleet state profile",
    "  -h, --help               Show this help",
  ].join("\n")
}

export function fleetChangeUsage() {
  return [
    "NAME",
    "  cloudflare-fleet change - plan and apply bounded direct operator changes",
    "",
    "SYNOPSIS",
    "  cloudflare-fleet change plan --input FILE|- [--format text|json] [--state-file PATH]",
    "  cloudflare-fleet change apply --input FILE|- --expect-plan DIGEST [--format text|json] [--state-file PATH]",
    "",
    "OPTIONS",
    "  -i, --input FILE|-       Read one bounded change request from FILE or stdin",
    "  -e, --expect-plan DIGEST Require the exact reviewed plan digest before writes",
    "  -f, --format text|json   Select operator text or structured JSON output",
    "  -p, --policy-file PATH   Select an operator policy profile",
    "  -s, --state-file PATH    Select a fleet state profile",
    "  -h, --help               Show this help",
    "",
    "SCHEMA",
    "  Run cloudflare-fleet schema change for the accepted discriminated request types",
    "  Requests describe outcomes and identifiers; HTTP methods and API paths are not accepted",
  ].join("\n")
}

export function fleetActivityUsage() {
  return [
    "NAME",
    "  cloudflare-fleet activity - inspect durable write history and perform guarded undo",
    "",
    "SYNOPSIS",
    "  cloudflare-fleet activity list [--format text|json] [--state-file PATH]",
    "  cloudflare-fleet activity undo plan --id ID [--format text|json] [--state-file PATH]",
    "  cloudflare-fleet activity undo apply --id ID --expect-plan DIGEST [--format text|json] [--state-file PATH]",
    "",
    "OPTIONS",
    "  --id ID                  Select a verified reversible activity entry",
    "  -e, --expect-plan DIGEST Require the exact guarded inverse plan before writes",
    "  -f, --format text|json   Select operator text or structured JSON output",
    "  -s, --state-file PATH    Select a fleet state profile",
    "  -h, --help               Show this help",
  ].join("\n")
}

export function fleetMcpUsage() {
  return [
    "NAME",
    "  cloudflare-fleet mcp - serve bounded Cloudflare Fleet tools over MCP stdio",
    "",
    "SYNOPSIS",
    "  cloudflare-fleet mcp [--policy-file PATH] [--state-file PATH]",
    "",
    "OPTIONS",
    "  -p, --policy-file PATH  Read fleet policy exceptions from PATH",
    "  -s, --state-file PATH   Read and persist local fleet state at PATH",
    "  -h, --help              Show this help",
    "",
    "ENVIRONMENT",
    "  CLOUDFLARE_API_TOKEN         Required account-level Cloudflare API token",
    "  CLOUDFLARE_ACCOUNT_ID        Required Cloudflare account identifier",
    "  CLOUDFLARE_FLEET_STATE_FILE  Optional absolute fleet-state JSON file",
    "  CLOUDFLARE_FLEET_POLICY_FILE Optional absolute fleet-policy JSON file",
    "  XDG_STATE_HOME                Optional absolute base for default fleet state",
    "  XDG_CONFIG_HOME               Optional absolute base for default fleet policy",
    "",
    "FILES",
    "  State and policy use standard per-user directories when no profile is selected",
    "",
    "TRANSPORT",
    "  JSON-RPC messages are read from stdin and written to stdout",
    "  Diagnostics are written to stderr; do not share stdout with logs",
  ].join("\n")
}

export function fleetHostedUsage() {
  return [
    "NAME",
    "  cloudflare-fleet hosted - configure and maintain a hosted dashboard",
    "",
    "SYNOPSIS",
    "  cloudflare-fleet hosted configure [OPTIONS]",
    "  cloudflare-fleet hosted import-state [OPTIONS] [STATE_FILE]",
    "",
    "COMMANDS",
    "  configure     Validate configuration and provision hosted resources",
    "  import-state  Import local fleet intent into the remote D1 database",
    "",
    "HELP",
    "  Run either command with --help for its options, dependencies, and side effects",
  ].join("\n")
}

export function fleetSchemaUsage() {
  return [
    "NAME",
    "  cloudflare-fleet schema - print machine-readable public input schemas",
    "",
    "SYNOPSIS",
    "  cloudflare-fleet schema change",
    "  cloudflare-fleet schema intent",
    "",
    "COMMANDS",
    "  change  Print the bounded direct-change JSON Schema",
    "  intent  Print the complete fleet-intent JSON Schema",
  ].join("\n")
}
function parseOptions(argv, definitions, positionalOptions) {
  const options = parseCliOptions(argv, definitions, positionalOptions)
  if (options.format !== undefined
    && !Object.values(CLI_FORMAT).includes(options.format)) {
    throw new CliUsageError(`Unsupported output format: ${options.format}`)
  }
  return options
}

function isHelpArgument(value) {
  return ["-h", "--help", "help"].includes(value)
}

async function runDashboardCommand(parsed, options) {
  if (options.dashboardRunner) {
    return options.dashboardRunner(parsed.argv, options)
  }
  const child = spawn("/bin/bash", [path.join(PROJECT_ROOT, "launch.sh"), ...parsed.argv], {
    env: {
      ...(options.environment || process.env),
      CLOUDFLARE_FLEET_COMMAND_NAME: "cloudflare-fleet dashboard",
    },
    stdio: "inherit",
  })
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject)
    child.once("exit", (code, signal) => {
      if (signal) reject(new Error(`Dashboard launcher exited on ${signal}`))
      else resolve(code ?? FLEET_CLI_EXIT_CODE.ERROR)
    })
  })
  options.onExitCode?.(exitCode)
  return { exitCode }
}

async function readJsonInput(inputPath, options) {
  let source
  if (options.inputText !== undefined) {
    source = options.inputText
  } else if (inputPath === "-") {
    const chunks = []
    for await (const chunk of options.stdin || process.stdin) chunks.push(chunk)
    source = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8")
  } else {
    source = await fs.readFile(path.resolve(inputPath), "utf8")
  }
  try {
    return JSON.parse(source)
  } catch (error) {
    throw new CliUsageError(
      `Input is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

function selectorFromOptions(options) {
  try {
    return normalizeAlignmentSelector({
      category: options.category,
      key: options.key,
      phase: options.phase || "",
      policyId: options.policy,
      zoneIds: options.zoneIds.length > 0 ? options.zoneIds : null,
    })
  } catch (error) {
    throw new CliUsageError(error instanceof Error ? error.message : String(error))
  }
}

export function parseFleetArguments(argv) {
  const [resource, action, ...rest] = argv
  if (!resource || resource === "-h" || resource === "--help") {
    return { command: "help" }
  }
  if (resource === "help") {
    if (!action) return { command: "help" }
    if (rest.length > 0) throw new CliUsageError("help accepts at most one command")
    if (!Object.hasOwn(HELP_COMMAND_BY_TOPIC, action)) {
      throw new CliUsageError(`Unknown help topic: ${action}`)
    }
    return { command: HELP_COMMAND_BY_TOPIC[action] }
  }
  if (resource === "audit") {
    return { argv: argv.slice(1), command: "audit" }
  }
  if (resource === "--version" || resource === "-V" || resource === "version") {
    if (argv.length !== 1) throw new CliUsageError("--version does not take arguments")
    return { command: "version" }
  }
  if (resource === "dashboard") {
    return { argv: argv.slice(1), command: "dashboard" }
  }
  if (resource === "config") {
    if (!action || isHelpArgument(action)) return { command: "config-help" }
    if (action !== "show") {
      throw new CliUsageError("Config command must be show")
    }
    const options = parseOptions(rest, [
      FORMAT_OPTION,
      HELP_OPTION,
      POLICY_FILE_OPTION,
      STATE_FILE_OPTION,
    ])
    if (options.help) return { command: "config-help" }
    return {
      command: "config-show",
      format: options.format,
      policyFile: options.policyfile,
      stateFile: options.statefile,
    }
  }
  if (resource === "doctor") {
    const options = parseOptions(argv.slice(1), [
      FORMAT_OPTION,
      HELP_OPTION,
      LIVE_OPTION,
      POLICY_FILE_OPTION,
      STATE_FILE_OPTION,
    ])
    if (options.help) return { command: "doctor-help" }
    return {
      command: "doctor",
      format: options.format,
      live: options.live,
      policyFile: options.policyfile,
      stateFile: options.statefile,
    }
  }
  if (resource === "hosted") {
    if (!action || isHelpArgument(action)) return { command: "hosted-help" }
    if (action === "configure") {
      return { argv: rest, command: "hosted-configure" }
    }
    if (action === "import-state") {
      return { argv: rest, command: "hosted-import-state" }
    }
    throw new CliUsageError("Hosted command must be configure or import-state")
  }
  if (resource === "mcp") {
    const options = parseOptions(argv.slice(1), [
      HELP_OPTION,
      POLICY_FILE_OPTION,
      STATE_FILE_OPTION,
    ])
    if (options.help) return { command: "mcp-help" }
    return {
      command: "mcp",
      policyFile: options.policyfile,
      stateFile: options.statefile,
    }
  }
  if (resource === "intent") {
    if (!action || isHelpArgument(action)) return { command: "intent-help" }
    if (!["aliases", "show", "plan", "apply"].includes(action)) {
      throw new CliUsageError("Intent command must be aliases, show, plan, or apply")
    }
    const definitions = action === "aliases"
      ? [FORMAT_OPTION, HELP_OPTION]
      : action === "show"
      ? COMMON_OPTIONS
      : action === "apply"
        ? [...COMMON_OPTIONS, INPUT_OPTION, EXPECT_PLAN_OPTION]
        : [...COMMON_OPTIONS, INPUT_OPTION]
    const options = parseOptions(rest, definitions)
    if (options.help) return { command: "intent-help" }
    if (!["aliases", "show"].includes(action) && !options.input) {
      throw new CliUsageError(`intent ${action} requires --input`)
    }
    if (action === "apply" && !options.expectplan) {
      throw new CliUsageError("intent apply requires --expect-plan")
    }
    return {
      command: `intent-${action}`,
      expectedDigest: options.expectplan || null,
      format: options.format,
      input: options.input || null,
      stateFile: action === "aliases" ? null : options.statefile,
    }
  }
  if (resource === "change") {
    if (!action || isHelpArgument(action)) return { command: "change-help" }
    if (!["plan", "apply"].includes(action)) {
      throw new CliUsageError("Change command must be plan or apply")
    }
    const definitions = action === "apply"
      ? [
          ...COMMON_OPTIONS,
          INPUT_OPTION,
          EXPECT_PLAN_OPTION,
          POLICY_FILE_OPTION,
        ]
      : [...COMMON_OPTIONS, INPUT_OPTION, POLICY_FILE_OPTION]
    const options = parseOptions(rest, definitions)
    if (options.help) return { command: "change-help" }
    if (!options.input) throw new CliUsageError(`change ${action} requires --input`)
    if (action === "apply" && !options.expectplan) {
      throw new CliUsageError("change apply requires --expect-plan")
    }
    return {
      command: `change-${action}`,
      expectedDigest: options.expectplan || null,
      format: options.format,
      input: options.input,
      policyFile: options.policyfile,
      stateFile: options.statefile,
    }
  }
  if (resource === "worker") {
    if (!action || isHelpArgument(action)) return { command: "worker-help" }
    if (!WORKER_COMMANDS.includes(action)) throw new CliUsageError("Unknown Worker command")
    const options = parseOptions(rest, [...COMMON_OPTIONS, INPUT_OPTION, ...(action.endsWith("-apply") ? [EXPECT_PLAN_OPTION] : [])])
    if (options.help) return { command: "worker-help" }
    if (!options.input) throw new CliUsageError("Worker command requires --input")
    if (action.endsWith("-apply") && !options.expectplan) throw new CliUsageError("Worker apply requires --expect-plan")
    return { command: `worker-${action}`, workerCommand: action, input: options.input, expectedDigest: options.expectplan, format: options.format, stateFile: options.statefile }
  }
  if (resource === "alignment") {
    if (!action || isHelpArgument(action)) return { command: "alignment-help" }
    if (!["list", "plan", "apply"].includes(action)) {
      throw new CliUsageError("Alignment command must be list, plan, or apply")
    }
    const definitions = action === "list"
      ? COMMON_OPTIONS
      : action === "apply"
        ? [
            ...SELECTOR_OPTIONS,
            EXPECT_PLAN_OPTION,
          ]
        : SELECTOR_OPTIONS
    const options = parseOptions(rest, definitions)
    if (options.help) return { command: "alignment-help" }
    if (action === "list") {
      return {
        command: "alignment-list",
        format: options.format,
        stateFile: options.statefile,
      }
    }
    const selector = selectorFromOptions(options)
    if (action === "apply" && !options.expectplan) {
      throw new CliUsageError("alignment apply requires --expect-plan")
    }
    return {
      command: `alignment-${action}`,
      expectedDigest: options.expectplan ?? null,
      format: options.format,
      selector,
      stateFile: options.statefile,
    }
  }
  if (resource === "activity") {
    if (!action || isHelpArgument(action)) return { command: "activity-help" }
    if (action === "list") {
      const options = parseOptions(rest, COMMON_OPTIONS)
      if (options.help) return { command: "activity-help" }
      return {
        command: "activity-list",
        format: options.format,
        stateFile: options.statefile,
      }
    }
    if (action !== "undo") {
      throw new CliUsageError("Activity command must be list or undo")
    }
    const [undoAction, ...undoArguments] = rest
    if (!undoAction || isHelpArgument(undoAction)) {
      return { command: "activity-help" }
    }
    if (!["plan", "apply"].includes(undoAction)) {
      throw new CliUsageError("Activity undo command must be plan or apply")
    }
    const definitions = undoAction === "apply"
      ? [...COMMON_OPTIONS, { name: "id", value: true }, EXPECT_PLAN_OPTION]
      : [...COMMON_OPTIONS, { name: "id", value: true }]
    const options = parseOptions(undoArguments, definitions)
    if (options.help) return { command: "activity-help" }
    if (!options.id) throw new CliUsageError(`activity undo ${undoAction} requires --id`)
    if (undoAction === "apply" && !options.expectplan) {
      throw new CliUsageError("activity undo apply requires --expect-plan")
    }
    return {
      activityId: options.id,
      command: `activity-undo-${undoAction}`,
      expectedDigest: options.expectplan || null,
      format: options.format,
      stateFile: options.statefile,
    }
  }
  if (resource === "schema") {
    if (!action || isHelpArgument(action)) return { command: "schema-help" }
    if (rest.length === 1 && isHelpArgument(rest[0])) {
      return { command: "schema-help" }
    }
    if (!["change", "intent"].includes(action) || rest.length > 0) {
      throw new CliUsageError("Schema command must be change or intent")
    }
    return { command: `schema-${action}` }
  }
  throw new CliUsageError(`Unknown command: ${resource}`)
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
      `  ${operation.label}${Object.hasOwn(operation, "body") ? `: ${JSON.stringify(operation.body)}` : ""}`,
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

function renderReviewedPlan(result, label) {
  const lines = [
    `${label} ${result.status}: ${result.reason}`,
  ]
  if (!result.planSet) return lines.join("\n")
  lines.push(
    `Plan: ${result.planSet.digest}`,
    `Validated: ${result.planSet.validatedAt}`,
  )
  if (result.planSet.preview.length === 0) return lines.join("\n")
  lines.push("Operations:")
  for (const operation of result.planSet.preview) {
    lines.push(
      `- ${operation.method} ${operation.path} on ${operation.zoneName}`,
      `  ${operation.label}${Object.hasOwn(operation, "body") ? `: ${JSON.stringify(operation.body)}` : ""}`,
    )
  }
  return lines.join("\n")
}

function renderExecution(result, label) {
  if (!result.execution) return renderReviewedPlan(result, label)
  const lines = [
    `${label} ${result.status} for account ${result.accountId}`,
    `Plan: ${result.planDigest}`,
    `Execution: ${result.execution.completed}/${result.execution.total}`,
    `Verification reads: ${result.verification.length}`,
  ]
  if (result.error) lines.push(`Error: ${result.error}`)
  if (result.historyError) lines.push(`Activity warning: ${result.historyError}`)
  return lines.join("\n")
}

function renderIntentPlan(result) {
  const lines = [
    `Fleet intent ${result.status}: ${result.reason}`,
    `Plan: ${result.planSet.digest}`,
  ]
  for (const [collection, difference] of Object.entries(result.diff)) {
    if (difference.added.length > 0) {
      lines.push(`- ${collection} added: ${difference.added.join(", ")}`)
    }
    if (difference.changed.length > 0) {
      lines.push(`- ${collection} changed: ${difference.changed.join(", ")}`)
    }
    if (difference.removed.length > 0) {
      lines.push(`- ${collection} removed: ${difference.removed.join(", ")}`)
    }
  }
  return lines.join("\n")
}

function operatorFileSummary(file) {
  if (!file.exists) {
    return `missing; nearest existing parent ${file.parent.existingPath || "unavailable"} is ${file.parent.writable ? "writable" : "not writable"}`
  }
  const link = file.symbolicLink ? ", symbolic link" : ""
  const mode = file.mode ? `, mode ${file.mode}` : ""
  return `${file.kind}${link}${mode}, ${file.accessible ? "accessible" : "not accessible"}`
}

function renderRuntimeConfiguration(result) {
  return [
    "Cloudflare Fleet configuration",
    `Package: ${result.runtime.packageVersion}`,
    `Runtime: Node.js ${result.runtime.node.version} on ${result.runtime.platform}-${result.runtime.architecture}`,
    "Credentials:",
    `- ${result.credentials.accountId.environmentName}: ${result.credentials.accountId.present ? "set" : "unset"}`,
    `- ${result.credentials.apiToken.environmentName}: ${result.credentials.apiToken.present ? "set" : "unset"}`,
    "Operator files:",
    `- State: ${result.paths.state.path}`,
    `  Source: ${result.paths.state.sourceName}; ${operatorFileSummary(result.paths.state)}`,
    `- Policy: ${result.paths.policy.path}`,
    `  Source: ${result.paths.policy.sourceName}; ${operatorFileSummary(result.paths.policy)}`,
    `Dashboard: ${result.dashboard.status} - ${result.dashboard.reason}`,
    "Secret values are not displayed",
  ].join("\n")
}

function renderRuntimeDoctor(result) {
  const lines = [
    `Cloudflare Fleet doctor: ${result.status.toUpperCase()}`,
  ]
  for (const entry of result.checks) {
    lines.push(`[${entry.status.toUpperCase()}] ${entry.label}: ${entry.detail}`)
    if (entry.remedy) lines.push(`  Remedy: ${entry.remedy}`)
  }
  lines.push(
    `Summary: ${result.summary.pass} passed, ${result.summary.warning} warnings, ${result.summary.fail} failed, ${result.summary.skip} skipped`,
  )
  return lines.join("\n")
}

function renderResult(command, result) {
  if (command.startsWith("worker-")) return JSON.stringify(result, null, 2)
  if (command === "config-show") return renderRuntimeConfiguration(result)
  if (command === "doctor") return renderRuntimeDoctor(result)
  if (command === "alignment-list") return renderAlignmentList(result)
  if (command === "alignment-plan") return renderAlignmentPlan(result)
  if (command === "alignment-apply") return renderAlignmentApply(result)
  if (command === "activity-list") return renderActivity(result)
  if (command === "intent-show") return JSON.stringify(result.document, null, 2)
  if (command === "intent-aliases") return [
    "Canonical web passthrough fleet intent",
    `Facet: ${result.facet.category}/${result.facet.key}`,
    `Envelope: ${result.resourceEnvelope}`,
    ...result.templates.map((template) => (
      `- ${template.sourceHost} -> ${template.value.redirect.targetHost} (HTTP ${template.value.redirect.statusCode})`
    )),
    ...result.limitations.map((limitation) => `Limitation: ${limitation}`),
  ].join("\n")
  if (command === "intent-plan") return renderIntentPlan(result)
  if (command === "intent-apply") {
    return result.applied
      ? `Fleet intent saved at revision ${result.document.revision}\nPlan: ${result.planDigest}`
      : renderIntentPlan(result)
  }
  if (command === "change-plan") return renderReviewedPlan(result, "Fleet change")
  if (command === "change-apply") return renderExecution(result, "Fleet change")
  if (command === "activity-undo-plan") return renderReviewedPlan(result, "Guarded undo")
  if (command === "activity-undo-apply") return renderExecution(result, "Guarded undo")
  throw new TypeError(`No renderer for ${command}`)
}

function resultExitCode(result) {
  if (result.status === FLEET_RUNTIME_STATUS.ATTENTION) {
    return FLEET_CLI_EXIT_CODE.ATTENTION
  }
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
  if (parsed.command === "version") {
    stdout.write(`${PACKAGE_VERSION}\n`)
    options.onExitCode?.(FLEET_CLI_EXIT_CODE.SUCCESS)
    return PACKAGE_VERSION
  }
  if (parsed.command === "dashboard") {
    return runDashboardCommand(parsed, { ...options, environment, stderr, stdout })
  }
  if (parsed.command === "config-show") {
    const inspectConfiguration = options.inspectRuntimeConfiguration
      || inspectFleetRuntimeConfiguration
    const result = await inspectConfiguration({
      environment,
      homeDirectory: options.homeDirectory,
      now: options.now,
      platform: options.platform,
      policyFile: parsed.policyFile,
      stateFile: parsed.stateFile,
      workingDirectory: options.workingDirectory,
    })
    writeResult(stdout, parsed.format, parsed.command, result)
    options.onExitCode?.(FLEET_CLI_EXIT_CODE.SUCCESS)
    return result
  }
  if (parsed.command === "doctor") {
    const diagnoseRuntime = options.diagnoseRuntime || diagnoseFleetRuntime
    const result = await diagnoseRuntime({
      api: options.api,
      environment,
      homeDirectory: options.homeDirectory,
      live: parsed.live,
      liveProbe: options.liveProbe,
      liveProbeTimeoutMs: options.liveProbeTimeoutMs,
      now: options.now,
      platform: options.platform,
      policyFile: parsed.policyFile,
      signal: options.signal,
      stateFile: parsed.stateFile,
      workingDirectory: options.workingDirectory,
    })
    writeResult(stdout, parsed.format, parsed.command, result)
    const exitCode = resultExitCode(result)
    options.onExitCode?.(exitCode)
    return result
  }
  if (parsed.command === "hosted-configure") {
    const { runHostedConfigurationCommand } = await import("../scripts/configure-hosted.mjs")
    return runHostedConfigurationCommand({
      ...options,
      argv: parsed.argv,
      environment,
      stderr,
      stdout,
    })
  }
  if (parsed.command === "hosted-import-state") {
    const { runImportHostedStateCommand } = await import("../scripts/import-hosted-state.mjs")
    return runImportHostedStateCommand({
      ...options,
      argv: parsed.argv,
      environment,
      stderr,
      stdout,
    })
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
  if (parsed.command === "mcp-help") {
    stdout.write(`${fleetMcpUsage()}\n`)
    options.onExitCode?.(FLEET_CLI_EXIT_CODE.SUCCESS)
    return null
  }
  if (parsed.command === "alignment-help") {
    stdout.write(`${fleetAlignmentUsage()}\n`)
    options.onExitCode?.(FLEET_CLI_EXIT_CODE.SUCCESS)
    return null
  }
  if (parsed.command === "config-help") {
    stdout.write(`${fleetConfigUsage()}\n`)
    options.onExitCode?.(FLEET_CLI_EXIT_CODE.SUCCESS)
    return null
  }
  if (parsed.command === "doctor-help") {
    stdout.write(`${fleetDoctorUsage()}\n`)
    options.onExitCode?.(FLEET_CLI_EXIT_CODE.SUCCESS)
    return null
  }
  if (parsed.command === "intent-help") {
    stdout.write(`${fleetIntentUsage()}\n`)
    options.onExitCode?.(FLEET_CLI_EXIT_CODE.SUCCESS)
    return null
  }
  if (parsed.command === "change-help") {
    stdout.write(`${fleetChangeUsage()}\n`)
    options.onExitCode?.(FLEET_CLI_EXIT_CODE.SUCCESS)
    return null
  }
  if (parsed.command === "worker-help") {
    stdout.write(`${fleetWorkerUsage()}\n`)
    options.onExitCode?.(FLEET_CLI_EXIT_CODE.SUCCESS)
    return null
  }
  if (parsed.command === "activity-help") {
    stdout.write(`${fleetActivityUsage()}\n`)
    options.onExitCode?.(FLEET_CLI_EXIT_CODE.SUCCESS)
    return null
  }
  if (parsed.command === "hosted-help") {
    stdout.write(`${fleetHostedUsage()}\n`)
    options.onExitCode?.(FLEET_CLI_EXIT_CODE.SUCCESS)
    return null
  }
  if (parsed.command === "schema-help") {
    stdout.write(`${fleetSchemaUsage()}\n`)
    options.onExitCode?.(FLEET_CLI_EXIT_CODE.SUCCESS)
    return null
  }
  if (parsed.command.startsWith("schema-")) {
    const [{ z }, schemas] = await Promise.all([
      import("zod"),
      import("./interface-schemas.mjs"),
    ])
    const schema = parsed.command === "schema-change"
      ? schemas.fleetChangeSchema
      : schemas.fleetIntentDocumentSchema
    stdout.write(`${JSON.stringify(z.toJSONSchema(schema), null, 2)}\n`)
    options.onExitCode?.(FLEET_CLI_EXIT_CODE.SUCCESS)
    return schema
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
  if (parsed.command === "intent-aliases") {
    const result = describeZoneAliasPolicy()
    writeResult(stdout, parsed.format, parsed.command, result)
    options.onExitCode?.(FLEET_CLI_EXIT_CODE.SUCCESS)
    return result
  }
  let intentDocument
  let change
  if (["intent-plan", "intent-apply"].includes(parsed.command)) {
    const input = await readJsonInput(parsed.input, options)
    intentDocument = input?.document || input
  } else if (["change-plan", "change-apply"].includes(parsed.command)) {
    try {
      change = normalizeFleetChange(await readJsonInput(parsed.input, options))
    } catch (error) {
      if (error instanceof TypeError) {
        throw new CliUsageError(error.message)
      }
      throw error
    }
  }
  const service = options.service || createLocalFleetService({
    environment,
    policyFile: parsed.policyFile,
    stateFile: parsed.stateFile,
  })
  const commandOptions = {
    onProgress: createProgressReporter(stderr, `[${parsed.command}]`),
    signal: options.signal,
    validatedAt: options.validatedAt,
  }
  let result
  if (parsed.workerCommand) {
    const input = await readJsonInput(parsed.input, options)
    const payload = parsed.workerCommand.endsWith("-apply")
      ? parsed.workerCommand === "undo-apply" ? { ...input, planDigest: parsed.expectedDigest } : { input, planDigest: parsed.expectedDigest }
      : input
    try { result = await runWorkerCommand(service.workers, parsed.workerCommand, payload, commandOptions) }
    catch (error) { if (error instanceof TypeError) throw new CliUsageError(error.message); throw error }
  } else if (parsed.command === "alignment-list") {
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
  } else if (parsed.command === "intent-show") {
    result = await service.getIntent(commandOptions)
  } else if (["intent-plan", "intent-apply"].includes(parsed.command)) {
    try {
      result = parsed.command === "intent-plan"
        ? await service.planIntent(intentDocument, commandOptions)
        : await service.applyIntent(
            intentDocument,
            parsed.expectedDigest,
            commandOptions,
          )
    } catch (error) {
      if (error instanceof TypeError) {
        throw new CliUsageError(error.message)
      }
      throw error
    }
  } else if (["change-plan", "change-apply"].includes(parsed.command)) {
    result = parsed.command === "change-plan"
      ? await service.planChange(change, commandOptions)
      : await service.applyChange(
          change,
          parsed.expectedDigest,
          commandOptions,
        )
  } else if (parsed.command === "activity-undo-plan") {
    result = await service.planActivityUndo(parsed.activityId, commandOptions)
  } else if (parsed.command === "activity-undo-apply") {
    result = await service.applyActivityUndo(
      parsed.activityId,
      parsed.expectedDigest,
      commandOptions,
    )
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
      || argument === "-fjson"
      || (argument === "-f" && argv[index + 1] === "json")
  ))
}

function errorExitCode(error) {
  if (error instanceof AlignmentPlanChangedError) {
    return FLEET_CLI_EXIT_CODE.PLAN_CHANGED
  }
  if (error instanceof CliUsageError
    || error instanceof FleetConfigurationError) {
    return FLEET_CLI_EXIT_CODE.USAGE
  }
  return FLEET_CLI_EXIT_CODE.ERROR
}

function redactedErrorMessage(error, environment) {
  const message = error instanceof Error ? error.message : String(error)
  const secret = environment.CLOUDFLARE_API_TOKEN
  return typeof secret === "string" && secret.length > 0
    ? message.replaceAll(secret, "[redacted]")
    : message
}

function errorResult(error, environment) {
  const status = error instanceof AlignmentPlanChangedError
    ? "plan-changed"
    : error instanceof FleetConfigurationError
      ? "configuration-error"
      : error instanceof CliUsageError
        ? "usage-error"
        : "error"
  const result = {
    error: {
      message: redactedErrorMessage(error, environment),
      name: error instanceof Error ? error.name : "Error",
    },
    schemaVersion: FLEET_SERVICE_SCHEMA_VERSION,
    status,
  }
  if (error instanceof AlignmentPlanChangedError) {
    result.error.actualDigest = error.actualDigest
    result.error.expectedDigest = error.expectedDigest
  }
  return result
}

export async function runFleetCli(options = {}) {
  const argv = options.argv || process.argv.slice(2)
  const environment = options.environment || process.env
  const stdout = options.stdout || process.stdout
  const stderr = options.stderr || process.stderr
  try {
    return await runFleetCommand({ ...options, argv, stderr, stdout })
  } catch (error) {
    const exitCode = errorExitCode(error)
    if (requestedJson(argv)) {
      stdout.write(`${JSON.stringify(errorResult(error, environment), null, 2)}\n`)
    } else {
      stderr.write(`[fleet] ${redactedErrorMessage(error, environment)}\n`)
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
