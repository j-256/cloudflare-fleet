import { promises as fs } from "node:fs"
import path from "node:path"

import {
  createEmptyFleetStateDocument,
  isFleetStateDocument,
  migrateFleetStateDocument,
} from "./fleet-state.mjs"

const LOCK_ATTEMPTS = 80
const LOCK_RETRY_MS = 25
const STALE_LOCK_MS = 30000

async function ensureStateParent(stateFile) {
  await fs.mkdir(path.dirname(stateFile), {
    mode: 0o700,
    recursive: true,
  })
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

async function acquireStateLock(lockPath) {
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
  throw new Error("Fleet state store is busy")
}

export async function atomicWriteFile(filePath, content) {
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`
  await fs.writeFile(temporaryPath, content, {
    encoding: "utf8",
    mode: 0o600,
  })
  await fs.rename(temporaryPath, filePath)
  await fs.chmod(filePath, 0o600)
}

async function readExistingStateFile(stateFile, accountId) {
  let raw
  try {
    raw = await fs.readFile(stateFile, "utf8")
  } catch (error) {
    if (error?.code === "ENOENT") return null
    throw error
  }
  let value
  try {
    value = JSON.parse(raw)
  } catch {
    throw new Error("Persisted fleet state is not valid JSON")
  }
  if (typeof value?.accountId === "string" && value.accountId !== accountId) {
    throw new Error(
      `Persisted fleet state belongs to Cloudflare account ${value.accountId}; this session uses ${accountId}`,
    )
  }
  try {
    return migrateFleetStateDocument(value, accountId)
  } catch {
    throw new Error("Persisted fleet state is invalid for this account")
  }
}

export async function readFleetStateDocument(stateFile, accountId) {
  await ensureStateParent(stateFile)
  return (await readExistingStateFile(stateFile, accountId))
    ?? createEmptyFleetStateDocument(accountId)
}

export async function updateFleetStateDocument(
  stateFile,
  accountId,
  update,
) {
  if (typeof update !== "function") {
    throw new TypeError("Fleet state update must be a function")
  }
  await ensureStateParent(stateFile)
  const lockPath = `${stateFile}.lock`
  const release = await acquireStateLock(lockPath)
  try {
    const current = (await readExistingStateFile(stateFile, accountId))
      ?? createEmptyFleetStateDocument(accountId)
    const next = await update(structuredClone(current))
    if (!isFleetStateDocument(next, accountId)) {
      throw new TypeError("Fleet state update returned an invalid document")
    }
    await atomicWriteFile(stateFile, `${JSON.stringify(next, null, 2)}\n`)
    return next
  } finally {
    await release()
  }
}
