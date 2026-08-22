import { promises as fs } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { readFleetPolicyConfiguration } from "../src/fleet-policy-store.mjs"
import { atomicWriteFile } from "../src/atomic-file.mjs"
import { isMainModule } from "../src/entrypoint.mjs"

const PROJECT_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const DEFAULT_OUTPUT_FILE = path.join(PROJECT_ROOT, "wrangler.jsonc")
const DEFAULT_POLICY_FILE = path.join(PROJECT_ROOT, "fleet-policy.json")
const ACCOUNT_ID_PATTERN = /^[a-f0-9]{32}$/i
const ACCESS_AUD_PATTERN = /^[a-f0-9]{64}$/i
const DATABASE_ID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const WORKER_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/

function optionValue(argv, index, argument) {
  const equals = argument.indexOf("=")
  if (equals !== -1) {
    return {
      nextIndex: index,
      value: argument.slice(equals + 1),
    }
  }
  const value = argv[index + 1]
  if (!value || value.startsWith("-")) {
    throw new Error(`${argument} requires a value`)
  }
  return {
    nextIndex: index + 1,
    value,
  }
}

export function hostedConfigurationUsage() {
  return [
    "Usage: configure-hosted.mjs [options]",
    "",
    "Options:",
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
  ].join("\n")
}

export function parseHostedConfigurationArguments(argv, environment = process.env) {
  const options = {
    accessAudience: environment.CLOUDFLARE_ACCESS_AUD || "",
    accessTeamDomain: environment.CLOUDFLARE_ACCESS_TEAM_DOMAIN || "",
    accountId: environment.CLOUDFLARE_ACCOUNT_ID || "",
    databaseId: environment.CLOUDFLARE_FLEET_D1_DATABASE_ID || "",
    hostname: environment.CLOUDFLARE_FLEET_HOSTNAME || "",
    help: false,
    outputFile: DEFAULT_OUTPUT_FILE,
    policyFile: environment.CLOUDFLARE_FLEET_POLICY_FILE || DEFAULT_POLICY_FILE,
    readOnly: true,
    workerName: "cloudflare-fleet",
  }
  const mappings = {
    "-a": "accountId",
    "-d": "databaseId",
    "-o": "outputFile",
    "-p": "policyFile",
    "--access-aud": "accessAudience",
    "--access-team-domain": "accessTeamDomain",
    "--account-id": "accountId",
    "--database-id": "databaseId",
    "--hostname": "hostname",
    "--output": "outputFile",
    "--policy-file": "policyFile",
    "--worker-name": "workerName",
  }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === "-h" || argument === "--help") {
      options.help = true
      continue
    }
    if (argument === "-r" || argument === "--read-only") {
      options.readOnly = true
      continue
    }
    if (argument === "-w" || argument === "--write") {
      options.readOnly = false
      continue
    }
    const name = argument.split("=", 1)[0]
    const property = mappings[name]
    if (!property) throw new Error(`Unknown option: ${argument}`)
    const resolved = optionValue(argv, index, argument)
    options[property] = resolved.value
    index = resolved.nextIndex
  }
  options.outputFile = path.resolve(options.outputFile)
  options.policyFile = path.resolve(options.policyFile)
  return options
}

function requiredPattern(value, pattern, label) {
  if (!pattern.test(value)) throw new Error(`${label} is invalid`)
  return value
}

function normalizedHostname(value) {
  if (!value || value.includes("://") || value.includes("/") || value.includes("*")) {
    throw new Error("Fleet hostname is invalid")
  }
  let url
  try {
    url = new URL(`https://${value}`)
  } catch {
    throw new Error("Fleet hostname is invalid")
  }
  if (url.hostname !== value.toLowerCase() || url.port || url.pathname !== "/") {
    throw new Error("Fleet hostname is invalid")
  }
  return url.hostname
}

function normalizedTeamDomain(value) {
  let url
  try {
    url = new URL(value)
  } catch {
    throw new Error("Access team domain is invalid")
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port
    || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Access team domain is invalid")
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

if (isMainModule(import.meta.url)) {
  let options
  try {
    options = parseHostedConfigurationArguments(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 2
  }
  if (options) {
    if (options.help) {
      process.stdout.write(`${hostedConfigurationUsage()}\n`)
    } else writeHostedWranglerConfiguration(options).then((configuration) => {
      process.stdout.write(`${JSON.stringify({
        hostname: configuration.routes[0].pattern,
        outputFile: options.outputFile,
        readOnly: configuration.vars.FLEET_READ_ONLY === "true",
        workerName: configuration.name,
      })}\n`)
    }).catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
      process.exitCode = 1
    })
  }
}
