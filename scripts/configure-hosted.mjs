import { promises as fs } from "node:fs"
import path from "node:path"

import { atomicWriteFile } from "../src/atomic-file.mjs"
import {
  FLEET_CLI_EXIT_CODE,
  FleetConfigurationError,
} from "../src/cli-contract.mjs"
import { CliUsageError, parseCliOptions } from "../src/cli-options.mjs"
import { isMainModule } from "../src/entrypoint.mjs"
import { readFleetPolicyConfiguration } from "../src/fleet-policy-store.mjs"
import {
  defaultFleetPolicyFile,
  defaultWranglerConfigurationFile,
} from "../src/operator-paths.mjs"

const ACCOUNT_ID_PATTERN = /^[a-f0-9]{32}$/i
const ACCESS_AUD_PATTERN = /^[a-f0-9]{64}$/i
const DATABASE_ID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const WORKER_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/

function configuredPolicyFile(environment) {
  const configured = environment.CLOUDFLARE_FLEET_POLICY_FILE
  if (!configured) return defaultFleetPolicyFile(environment)
  if (!path.isAbsolute(configured)) {
    throw new FleetConfigurationError(
      "CLOUDFLARE_FLEET_POLICY_FILE must be an absolute path",
    )
  }
  return path.resolve(configured)
}

export function hostedConfigurationUsage() {
  return [
    "NAME",
    "  cloudflare-fleet hosted configure - create a private hosted deployment configuration",
    "",
    "SYNOPSIS",
    "  cloudflare-fleet hosted configure [OPTIONS]",
    "",
    "OPTIONS",
    "  --access-aud VALUE          Set the Cloudflare Access audience",
    "  --access-team-domain URL    Set the Cloudflare Access team domain",
    "  -a, --account-id ID         Set the Cloudflare account ID",
    "  -d, --database-id ID        Set the D1 database ID",
    "  --hostname HOST             Set the hosted dashboard hostname",
    "  -o, --output FILE           Write Wrangler configuration to FILE",
    "  -p, --policy-file FILE      Read fleet policy from FILE",
    "  --worker-name NAME          Set the Worker name",
    "  -r, --read-only             Configure a read-only deployment",
    "  -w, --write                 Configure a read/write deployment",
    "  -h, --help                  Show this help",
    "",
    "ENVIRONMENT",
    "  CLOUDFLARE_ACCOUNT_ID             Default Cloudflare account ID",
    "  CLOUDFLARE_ACCESS_AUD              Default Cloudflare Access audience",
    "  CLOUDFLARE_ACCESS_TEAM_DOMAIN      Default Cloudflare Access team URL",
    "  CLOUDFLARE_FLEET_D1_DATABASE_ID    Default D1 database ID",
    "  CLOUDFLARE_FLEET_HOSTNAME          Default dashboard hostname",
    "  CLOUDFLARE_FLEET_POLICY_FILE       Default fleet-policy JSON file",
    "  XDG_CONFIG_HOME                    Optional absolute base for default fleet policy",
    "",
    "FILES",
    "  Wrangler configuration defaults to wrangler.jsonc in the working directory",
    "  The generated file is mode 0600 and contains operator-specific deployment data",
    "",
    "EXIT STATUS",
    "  0  Configuration was written",
    "  1  Configuration generation failed",
    "  2  Command usage or configuration values were invalid",
  ].join("\n")
}

export function parseHostedConfigurationArguments(argv, environment = process.env) {
  const options = parseCliOptions(argv, [
    { default: environment.CLOUDFLARE_ACCESS_AUD || "", key: "accessAudience", name: "access-aud", value: true },
    { default: environment.CLOUDFLARE_ACCESS_TEAM_DOMAIN || "", key: "accessTeamDomain", name: "access-team-domain", value: true },
    { default: environment.CLOUDFLARE_ACCOUNT_ID || "", key: "accountId", name: "account-id", short: "a", value: true },
    { default: environment.CLOUDFLARE_FLEET_D1_DATABASE_ID || "", key: "databaseId", name: "database-id", short: "d", value: true },
    { default: environment.CLOUDFLARE_FLEET_HOSTNAME || "", name: "hostname", value: true },
    { default: false, name: "help", short: "h", value: false },
    { default: defaultWranglerConfigurationFile(), key: "outputFile", name: "output", short: "o", value: true },
    { key: "policyFile", name: "policy-file", short: "p", value: true },
    { default: false, key: "readOnlyRequested", name: "read-only", short: "r", value: false },
    { default: false, key: "writeRequested", name: "write", short: "w", value: false },
    { default: "cloudflare-fleet", key: "workerName", name: "worker-name", value: true },
  ])
  if (options.readOnlyRequested && options.writeRequested) {
    throw new CliUsageError("--read-only and --write cannot be used together")
  }
  options.readOnly = !options.writeRequested
  delete options.positionals
  delete options.readOnlyRequested
  delete options.writeRequested
  options.outputFile = path.resolve(options.outputFile)
  options.policyFile = options.help && !options.policyFile
    ? null
    : path.resolve(options.policyFile || configuredPolicyFile(environment))
  return options
}

function requiredPattern(value, pattern, label) {
  if (!pattern.test(value)) {
    throw new FleetConfigurationError(`${label} is invalid`)
  }
  return value
}

function normalizedHostname(value) {
  if (!value || value.includes("://") || value.includes("/") || value.includes("*")) {
    throw new FleetConfigurationError("Fleet hostname is invalid")
  }
  let url
  try {
    url = new URL(`https://${value}`)
  } catch {
    throw new FleetConfigurationError("Fleet hostname is invalid")
  }
  if (url.hostname !== value.toLowerCase() || url.port || url.pathname !== "/") {
    throw new FleetConfigurationError("Fleet hostname is invalid")
  }
  return url.hostname
}

function normalizedTeamDomain(value) {
  let url
  try {
    url = new URL(value)
  } catch {
    throw new FleetConfigurationError("Access team domain is invalid")
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port
    || url.pathname !== "/" || url.search || url.hash) {
    throw new FleetConfigurationError("Access team domain is invalid")
  }
  return url.origin
}

export async function hostedWranglerConfiguration(options) {
  const accountId = requiredPattern(
    options.accountId,
    ACCOUNT_ID_PATTERN,
    "Cloudflare account ID",
  )
  const databaseId = requiredPattern(
    options.databaseId,
    DATABASE_ID_PATTERN,
    "D1 database ID",
  )
  const accessAudience = requiredPattern(
    options.accessAudience,
    ACCESS_AUD_PATTERN,
    "Access audience",
  )
  const workerName = requiredPattern(
    options.workerName,
    WORKER_NAME_PATTERN,
    "Worker name",
  )
  const policy = await readFleetPolicyConfiguration(options.policyFile)
  return {
    $schema: "node_modules/wrangler/config-schema.json",
    name: workerName,
    main: "src/hosted/worker.mjs",
    compatibility_date: "2026-08-11",
    workers_dev: false,
    preview_urls: false,
    routes: [{
      pattern: normalizedHostname(options.hostname),
      custom_domain: true,
    }],
    build: {
      command: "npm run build:hosted",
    },
    assets: {
      binding: "ASSETS",
      directory: ".worker-assets",
      run_worker_first: true,
    },
    d1_databases: [{
      binding: "FLEET_DB",
      database_name: "cloudflare-fleet",
      database_id: databaseId,
      migrations_dir: "migrations",
    }],
    services: [],
    triggers: {
      crons: [],
    },
    vars: {
      FLEET_ACCOUNT_ID: accountId,
      FLEET_READ_ONLY: String(options.readOnly),
      FLEET_POLICY_JSON: JSON.stringify(policy),
      ACCESS_AUD: accessAudience,
      ACCESS_TEAM_DOMAIN: normalizedTeamDomain(options.accessTeamDomain),
    },
    observability: {
      logs: {
        enabled: true,
        invocation_logs: true,
      },
    },
    secrets: {
      required: ["CLOUDFLARE_API_TOKEN"],
    },
  }
}

export async function writeHostedWranglerConfiguration(options) {
  const configuration = await hostedWranglerConfiguration(options)
  await atomicWriteFile(
    options.outputFile,
    `${JSON.stringify(configuration, null, 2)}\n`,
  )
  await fs.chmod(options.outputFile, 0o600)
  return configuration
}

export async function runHostedConfigurationCommand(options = {}) {
  const argv = options.argv || process.argv.slice(2)
  const environment = options.environment || process.env
  const stdout = options.stdout || process.stdout
  const parsed = parseHostedConfigurationArguments(argv, environment)
  if (parsed.help) {
    stdout.write(`${hostedConfigurationUsage()}\n`)
    options.onExitCode?.(FLEET_CLI_EXIT_CODE.SUCCESS)
    return null
  }
  const configuration = await writeHostedWranglerConfiguration(parsed)
  const result = {
    hostname: configuration.routes[0].pattern,
    outputFile: parsed.outputFile,
    readOnly: configuration.vars.FLEET_READ_ONLY === "true",
    workerName: configuration.name,
  }
  stdout.write(`${JSON.stringify(result)}\n`)
  options.onExitCode?.(FLEET_CLI_EXIT_CODE.SUCCESS)
  return result
}

if (isMainModule(import.meta.url)) {
  runHostedConfigurationCommand({
    onExitCode(exitCode) {
      process.exitCode = exitCode
    },
  }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = error instanceof CliUsageError
      || error instanceof FleetConfigurationError
      ? FLEET_CLI_EXIT_CODE.USAGE
      : FLEET_CLI_EXIT_CODE.ERROR
  })
}
