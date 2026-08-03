import { createHash } from "node:crypto"
import { promises as fs } from "node:fs"
import path from "node:path"

import { isMainModule } from "./entrypoint.mjs"
import {
  createEmptyFleetIntentDocument,
  FLEET_INTENT_DOCUMENT_GLOBAL,
  isFleetIntentDocument,
  migrateFleetIntentDocument,
} from "./fleet-intent.mjs"

const LOCK_ATTEMPTS = 80
const LOCK_RETRY_MS = 25
const STALE_LOCK_MS = 30000

export class FleetIntentRevisionConflictError extends Error {
  constructor(currentDocument) {
    super("Fleet intent changed in another dashboard window")
    this.name = "FleetIntentRevisionConflictError"
    this.currentDocument = currentDocument
  }
}

async function ensureStateParent(stateFile) {
  await fs.mkdir(path.dirname(stateFile), {
    mode: 0o700,
    recursive: true,
  })
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

async function acquireIntentLock(lockPath) {
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
    try {
      await fs.mkdir(lockPath, { mode: 0o700 })
      return async () => {
        await fs.rm(lockPath, {
          force: true,
          recursive: true,
        })
      }
    } catch (error) {
      if (error?.code !== "EEXIST") throw error
      try {
        const status = await fs.stat(lockPath)
        if (Date.now() - status.mtimeMs > STALE_LOCK_MS) {
          const abandonedPath = `${lockPath}.${process.pid}.${Date.now()}.stale`
          try {
            await fs.rename(lockPath, abandonedPath)
          } catch (renameError) {
            if (renameError?.code === "ENOENT") continue
            throw renameError
          }
          await fs.rm(abandonedPath, { recursive: true })
          continue
        }
      } catch (statusError) {
        if (statusError?.code === "ENOENT") continue
        throw statusError
      }
      await wait(LOCK_RETRY_MS)
    }
  }
  throw new Error("Fleet intent store is busy")
}

async function atomicWrite(filePath, content) {
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`
  await fs.writeFile(temporaryPath, content, {
    encoding: "utf8",
    mode: 0o600,
  })
  await fs.rename(temporaryPath, filePath)
  await fs.chmod(filePath, 0o600)
}

async function readExistingIntentFile(filePath, accountId) {
  let raw
  try {
    raw = await fs.readFile(filePath, "utf8")
  } catch (error) {
    if (error?.code === "ENOENT") return null
    throw error
  }
  let document
  try {
    document = JSON.parse(raw)
  } catch {
    throw new Error("Persisted fleet intent is not valid JSON")
  }
  if (typeof document?.accountId === "string"
    && document.accountId !== accountId) {
    throw new Error(
      `Persisted fleet intent belongs to Cloudflare account ${document.accountId}; this session uses ${accountId}`,
    )
  }
  try {
    document = migrateFleetIntentDocument(document, accountId)
  } catch {
    throw new Error("Persisted fleet intent is invalid for this account")
  }
  return document
}

async function readIntentFile(filePath, accountId) {
  const existing = await readExistingIntentFile(filePath, accountId)
  return existing ?? createEmptyFleetIntentDocument(accountId)
}

export async function readFleetIntentDocument(stateFile, accountId) {
  await ensureStateParent(stateFile)
  return readIntentFile(stateFile, accountId)
}

function nextPersistedDocument(document) {
  const updatedAt = new Date().toISOString()
  const content = {
    ...structuredClone(document),
    revision: "",
    updatedAt,
  }
  const revision = createHash("sha256")
    .update(JSON.stringify(content))
    .digest("hex")
  return {
    ...content,
    revision,
  }
}

export async function persistFleetIntentDocument(
  stateFile,
  accountId,
  expectedRevision,
  document,
) {
  if (!isFleetIntentDocument(document, accountId)) {
    throw new TypeError("Fleet intent document is invalid for this account")
  }
  if (document.revision !== expectedRevision) {
    throw new TypeError("Fleet intent revision does not match the expected revision")
  }
  await ensureStateParent(stateFile)
  const lockPath = `${stateFile}.lock`
  const release = await acquireIntentLock(lockPath)
  try {
    const current = await readIntentFile(stateFile, accountId)
    if (current.revision !== expectedRevision) {
      throw new FleetIntentRevisionConflictError(current)
    }
    const next = nextPersistedDocument(document)
    if (!isFleetIntentDocument(next, accountId)) {
      throw new TypeError("Fleet intent could not be serialized")
    }
    await atomicWrite(stateFile, `${JSON.stringify(next, null, 2)}\n`)
    return next
  } finally {
    await release()
  }
}

export async function prepareFleetIntentScript(options) {
  const document = await readFleetIntentDocument(
    options.stateFile,
    options.accountId,
  )
  const payload = JSON.stringify(document)
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029")
  await atomicWrite(
    options.outputPath,
    `window[${JSON.stringify(FLEET_INTENT_DOCUMENT_GLOBAL)}] = ${payload}\n`,
  )
  return document
}

async function main(args) {
  const [command, stateFile, accountId, outputPath] = args
  if (args.length !== 4
    || command !== "prepare" || !stateFile || !accountId || !outputPath) {
    throw new Error("Usage: intent-store.mjs prepare STATE_FILE ACCOUNT_ID OUTPUT_PATH")
  }
  const document = await prepareFleetIntentScript({
    accountId,
    outputPath,
    stateFile,
  })
  process.stdout.write(`${JSON.stringify({
    policies: document.policies.length,
    revision: document.revision,
  })}\n`)
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
