import { readFile } from "node:fs/promises"
import path from "node:path"

import {
  isFleetStateDocument,
} from "../src/fleet-state.mjs"
import {
  FLEET_CLI_EXIT_CODE,
  FleetConfigurationError,
} from "../src/cli-contract.mjs"
import { CliUsageError, parseCliOptions } from "../src/cli-options.mjs"
import { isMainModule } from "../src/entrypoint.mjs"
import { emptyWorkerRecords } from "../src/worker-records.mjs"
import {
  defaultFleetStateFile,
  defaultWranglerConfigurationFile,
} from "../src/operator-paths.mjs"

const CLOUDFLARE_API_BASE = "https://api.cloudflare.com/client/v4/"

function configuredStateFile(environment) {
  const configured = environment.CLOUDFLARE_FLEET_STATE_FILE
  if (!configured) return defaultFleetStateFile(environment)
  if (!path.isAbsolute(configured)) {
    throw new FleetConfigurationError(
      "CLOUDFLARE_FLEET_STATE_FILE must be an absolute path",
    )
  }
  return path.resolve(configured)
}

export function importHostedStateUsage() {
  return [
    "NAME",
    "  cloudflare-fleet hosted import-state - import local fleet state into hosted D1",
    "",
    "SYNOPSIS",
    "  cloudflare-fleet hosted import-state [OPTIONS] [STATE_FILE]",
    "",
    "OPTIONS",
    "  -f, --force         Delete and replace existing hosted state after review",
    "  -c, --config FILE   Read the D1 database identifier from Wrangler FILE",
    "  -h, --help          Show this help",
    "",
    "ENVIRONMENT",
    "  CLOUDFLARE_ACCOUNT_ID          Required Cloudflare account identifier",
    "  CLOUDFLARE_API_TOKEN           Required account-level Cloudflare API token",
    "  CLOUDFLARE_FLEET_D1_DATABASE_ID Optional D1 database identifier",
    "  CLOUDFLARE_FLEET_STATE_FILE    Optional absolute fleet-state JSON file",
    "  XDG_STATE_HOME                 Optional absolute base for default fleet state",
    "",
    "FILES",
    "  STATE_FILE defaults to the Fleet file in the standard user state directory",
    "  Wrangler configuration defaults to wrangler.jsonc in the working directory",
    "  The command sends the validated document to the configured remote D1 database",
    "",
    "EXIT STATUS",
    "  0  State was imported and verified",
    "  1  Import or verification failed",
    "  2  Command usage was invalid",
  ].join("\n")
}

export function parseImportHostedStateArguments(
  values,
  environment = process.env,
) {
  const options = parseCliOptions(values, [
    { default: defaultWranglerConfigurationFile(), key: "configFile", name: "config", short: "c", value: true },
    { default: false, name: "force", short: "f", value: false },
    { default: false, name: "help", short: "h", value: false },
  ], { maxPositionals: 1 })
  return {
    configFile: path.resolve(options.configFile),
    force: options.force,
    help: options.help,
    stateFile: options.help && !options.positionals[0]
      ? null
      : path.resolve(
          options.positionals[0]
            || configuredStateFile(environment),
        ),
  }
}

function requiredEnvironment(name, environment) {
  const value = environment[name]
  if (!value) throw new FleetConfigurationError(`${name} is required`)
  return value
}

export async function databaseIdFromWrangler(configFile) {
  let configuration
  try {
    configuration = JSON.parse(await readFile(configFile, "utf8"))
  } catch (error) {
    throw new Error(`Could not read Wrangler configuration: ${error instanceof Error ? error.message : String(error)}`)
  }
  const database = configuration.d1_databases?.find((entry) => (
    entry?.binding === "FLEET_DB"
  ))
  if (typeof database?.database_id !== "string" || !database.database_id) {
    throw new Error("Wrangler configuration does not define the FLEET_DB database ID")
  }
  return database.database_id
}

async function cloudflareRequest(accountId, apiToken, databaseId, body) {
  const url = new URL(
    `accounts/${encodeURIComponent(accountId)}/d1/database/${encodeURIComponent(databaseId)}/query`,
    CLOUDFLARE_API_BASE,
  )
  const response = await fetch(url, {
    body: JSON.stringify(body),
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json",
    },
    method: "POST",
  })
  let envelope
  try {
    envelope = await response.json()
  } catch {
    throw new Error(`Hosted D1 request returned HTTP ${response.status} with invalid JSON`)
  }
  const failed = !response.ok
    || envelope.success !== true
    || envelope.result?.some((result) => result.success === false)
  if (failed) {
    const detail = envelope.errors?.[0]?.message
      || envelope.result?.find((result) => result.success === false)?.error
      || response.statusText
      || "Unknown D1 error"
    throw new Error(`Hosted D1 request failed: ${detail}`)
  }
  return envelope.result
}

async function readState(stateFile, accountId) {
  let value
  try {
    value = JSON.parse(await readFile(stateFile, "utf8"))
  } catch (error) {
    throw new Error(`Could not read Fleet state: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!isFleetStateDocument(value, accountId)) {
    throw new Error("Fleet state is invalid or belongs to another Cloudflare account")
  }
  return value
}

async function hostedStateCounts(accountId, apiToken, databaseId) {
  const [query] = await cloudflareRequest(accountId, apiToken, databaseId, {
    params: [accountId, accountId, accountId, accountId],
    sql: `
      SELECT
        (SELECT count(*) FROM fleet_intent WHERE account_id = ?) AS intent_count,
        (SELECT count(*) FROM activity_meta WHERE account_id = ?) AS activity_count,
        (SELECT count(*) FROM operation_activity WHERE account_id = ?) AS entry_count,
        (SELECT count(*) FROM worker_diagnostics WHERE account_id = ?) AS worker_count
    `,
  })
  return query.results?.[0] || {
    activity_count: 0,
    entry_count: 0,
    intent_count: 0,
  }
}

function importBatch(state, force) {
  const batch = []
  if (force) {
    batch.push(
      {
        params: [state.accountId],
        sql: "DELETE FROM operation_activity WHERE account_id = ?",
      },
      {
        params: [state.accountId],
        sql: "DELETE FROM activity_meta WHERE account_id = ?",
      },
      {
        params: [state.accountId],
        sql: "DELETE FROM fleet_intent WHERE account_id = ?",
      },
      {
        params: [state.accountId],
        sql: "DELETE FROM worker_diagnostics WHERE account_id = ?",
      },
    )
  }
  batch.push(
    {
      params: [
        state.accountId,
        JSON.stringify(state.intent),
        state.intent.revision,
        state.intent.updatedAt,
      ],
      sql: `
        INSERT INTO fleet_intent (
          account_id,
          document_json,
          revision,
          updated_at
        ) VALUES (?, ?, ?, ?)
      `,
    },
    {
      params: [
        state.accountId,
        state.activity.revision,
        state.activity.updatedAt,
      ],
      sql: `
        INSERT INTO activity_meta (
          account_id,
          revision,
          updated_at
        ) VALUES (?, ?, ?)
      `,
    },
  )
  const workers = state.workers || emptyWorkerRecords()
  batch.push({ params: [state.accountId, JSON.stringify(workers), workers.revision], sql: "INSERT INTO worker_diagnostics (account_id, document_json, revision) VALUES (?, ?, ?)" })
  for (const entry of state.activity.entries) {
    batch.push({
      params: [
        state.accountId,
        entry.id,
        JSON.stringify(entry),
        entry.status,
        entry.undoOf,
        entry.startedAt,
      ],
      sql: `
        INSERT INTO operation_activity (
          account_id,
          id,
          payload_json,
          status,
          undo_of,
          started_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `,
    })
  }
  return batch
}

export async function importHostedState(options = {}) {
  const environment = options.environment || process.env
  const accountId = options.accountId
    || requiredEnvironment("CLOUDFLARE_ACCOUNT_ID", environment)
  const apiToken = options.apiToken
    || requiredEnvironment("CLOUDFLARE_API_TOKEN", environment)
  const databaseId = options.databaseId
    || environment.CLOUDFLARE_FLEET_D1_DATABASE_ID
    || await databaseIdFromWrangler(
      options.configFile || defaultWranglerConfigurationFile(),
    )
  const state = await readState(
    options.stateFile || configuredStateFile(environment),
    accountId,
  )
  const counts = await hostedStateCounts(accountId, apiToken, databaseId)
  const occupied = Object.values(counts).some((count) => Number(count) > 0)
  if (occupied && !options.force) {
    throw new Error("Hosted Fleet state already exists; rerun with --force only after reviewing the remote data")
  }
  await cloudflareRequest(accountId, apiToken, databaseId, {
    batch: importBatch(state, Boolean(options.force)),
  })
  const imported = await hostedStateCounts(accountId, apiToken, databaseId)
  if (Number(imported.intent_count) !== 1
    || Number(imported.worker_count) !== 1
    || Number(imported.activity_count) !== 1
    || Number(imported.entry_count) !== state.activity.entries.length) {
    throw new Error("Hosted Fleet state verification did not match the source document")
  }
  return {
    accountId,
    activityEntries: state.activity.entries.length,
    intentRevision: state.intent.revision,
  }
}

export async function runImportHostedStateCommand(options = {}) {
  const argv = options.argv || process.argv.slice(2)
  const environment = options.environment || process.env
  const stdout = options.stdout || process.stdout
  const parsed = parseImportHostedStateArguments(argv, environment)
  if (parsed.help) {
    stdout.write(`${importHostedStateUsage()}\n`)
    options.onExitCode?.(FLEET_CLI_EXIT_CODE.SUCCESS)
    return null
  }
  const result = await importHostedState({ ...parsed, environment })
  stdout.write(`${JSON.stringify(result)}\n`)
  options.onExitCode?.(FLEET_CLI_EXIT_CODE.SUCCESS)
  return result
}

if (isMainModule(import.meta.url)) {
  runImportHostedStateCommand({
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
