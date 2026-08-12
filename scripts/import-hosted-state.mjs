import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

import {
  isFleetStateDocument,
} from "../src/fleet-state.mjs"

const PROJECT_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const DEFAULT_STATE_FILE = path.join(PROJECT_ROOT, "state.json")
const HOSTED_DATABASE_ID = "00000000-0000-4000-8000-000000000001"
const CLOUDFLARE_API_BASE = "https://api.cloudflare.com/client/v4/"

function argumentsFrom(values) {
  const force = values.includes("--force")
  const paths = values.filter((value) => value !== "--force")
  if (paths.length > 1) {
    throw new Error("Usage: import-hosted-state.mjs [--force] [STATE_FILE]")
  }
  return {
    force,
    stateFile: path.resolve(paths[0] || DEFAULT_STATE_FILE),
  }
}

function requiredEnvironment(name) {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}

async function cloudflareRequest(accountId, apiToken, body) {
  const url = new URL(
    `accounts/${encodeURIComponent(accountId)}/d1/database/${HOSTED_DATABASE_ID}/query`,
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

async function hostedStateCounts(accountId, apiToken) {
  const [query] = await cloudflareRequest(accountId, apiToken, {
    params: [accountId, accountId, accountId],
    sql: `
      SELECT
        (SELECT count(*) FROM fleet_intent WHERE account_id = ?) AS intent_count,
        (SELECT count(*) FROM activity_meta WHERE account_id = ?) AS activity_count,
        (SELECT count(*) FROM operation_activity WHERE account_id = ?) AS entry_count
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
  const accountId = options.accountId || requiredEnvironment("CLOUDFLARE_ACCOUNT_ID")
  const apiToken = options.apiToken || requiredEnvironment("CLOUDFLARE_API_TOKEN")
  const state = await readState(options.stateFile || DEFAULT_STATE_FILE, accountId)
  const counts = await hostedStateCounts(accountId, apiToken)
  const occupied = Object.values(counts).some((count) => Number(count) > 0)
  if (occupied && !options.force) {
    throw new Error("Hosted Fleet state already exists; rerun with --force only after reviewing the remote data")
  }
  await cloudflareRequest(accountId, apiToken, {
    batch: importBatch(state, Boolean(options.force)),
  })
  const imported = await hostedStateCounts(accountId, apiToken)
  if (Number(imported.intent_count) !== 1
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

if (path.resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  let parsed
  try {
    parsed = argumentsFrom(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
  if (parsed) {
    importHostedState(parsed).then((result) => {
      process.stdout.write(`${JSON.stringify(result)}\n`)
    }).catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
      process.exitCode = 1
    })
  }
}
