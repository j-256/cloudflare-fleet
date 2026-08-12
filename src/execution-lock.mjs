import { randomUUID } from "node:crypto"
import { promises as fs } from "node:fs"
import path from "node:path"

const LOCK_ATTEMPTS = 80
const LOCK_RETRY_MS = 25
const LOCK_STALE_MS = 30000
const OWNER_FILENAME = "owner.json"

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function ownerPath(lockPath) {
  return path.join(lockPath, OWNER_FILENAME)
}

async function readOwner(lockPath) {
  let content
  try {
    content = await fs.readFile(ownerPath(lockPath), "utf8")
  } catch (error) {
    if (error?.code === "ENOENT") return null
    throw error
  }
  try {
    return JSON.parse(content)
  } catch {
    return null
  }
}

function ownerIsRunning(owner) {
  if (!Number.isSafeInteger(owner?.pid) || owner.pid <= 0) return false
  try {
    process.kill(owner.pid, 0)
    return true
  } catch (error) {
    return error?.code !== "ESRCH"
  }
}

async function reclaimAbandonedLock(lockPath) {
  let status
  try {
    status = await fs.stat(lockPath)
  } catch (error) {
    if (error?.code === "ENOENT") return true
    throw error
  }
  if (Date.now() - status.mtimeMs <= LOCK_STALE_MS) return false
  const owner = await readOwner(lockPath)
  if (ownerIsRunning(owner)) return false

  const abandonedPath = `${lockPath}.${process.pid}.${Date.now()}.abandoned`
  try {
    await fs.rename(lockPath, abandonedPath)
  } catch (error) {
    if (error?.code === "ENOENT") return true
    throw error
  }
  await fs.rm(abandonedPath, { recursive: true })
  return true
}

async function acquireExecutionLock(stateFile) {
  const lockPath = `${stateFile}.execution-lock`
  const owner = {
    pid: process.pid,
    token: randomUUID(),
  }
  await fs.mkdir(path.dirname(stateFile), {
    mode: 0o700,
    recursive: true,
  })

  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
    try {
      await fs.mkdir(lockPath, { mode: 0o700 })
      try {
        await fs.writeFile(
          ownerPath(lockPath),
          `${JSON.stringify(owner)}\n`,
          { flag: "wx", mode: 0o600 },
        )
      } catch (error) {
        await fs.rm(lockPath, { force: true, recursive: true })
        throw error
      }
      return async () => {
        const activeOwner = await readOwner(lockPath)
        if (activeOwner?.token !== owner.token) return
        await fs.rm(lockPath, { force: true, recursive: true })
      }
    } catch (error) {
      if (error?.code !== "EEXIST") throw error
      if (await reclaimAbandonedLock(lockPath)) continue
      await wait(LOCK_RETRY_MS)
    }
  }
  throw new Error("Another fleet write is already in progress")
}

export async function withFleetExecutionLock(stateFile, operation) {
  if (typeof stateFile !== "string" || stateFile.length === 0) {
    throw new TypeError("Fleet execution lock requires a state file")
  }
  if (typeof operation !== "function") {
    throw new TypeError("Fleet execution lock requires an operation")
  }
  const release = await acquireExecutionLock(stateFile)
  try {
    return await operation()
  } finally {
    await release()
  }
}
