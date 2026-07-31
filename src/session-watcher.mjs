import { spawnSync } from "node:child_process"
import { promises as fs } from "node:fs"
import path from "node:path"

import {
  cacheRecordUpdatedAt,
  CACHE_SNAPSHOT_GLOBAL,
  isCacheRecord,
} from "./cache.mjs"
import { persistCacheRecord } from "./cache-store.mjs"
import { isMainModule } from "./entrypoint.mjs"

const CDP_TIMEOUT_MS = 5000
const BROWSER_EXIT_ATTEMPTS = 50
const BROWSER_EXIT_INTERVAL_MS = 100
const MISSING_TARGET_LIMIT = 3
const POLL_INTERVAL_MS = 1000
const SERVICE_TARGET_PATTERN = /^gui\/[0-9]+\/com\.j256\.cloudflare-fleet\.[A-Za-z0-9]+$/

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function parseOptions(args) {
  const [
    port,
    targetId,
    sessionUrl,
    runtimeDir,
    runtimeBase,
    cacheDir,
    sessionId,
    chromePid,
    serviceTarget,
  ] = args
  if (!port || !targetId || !sessionUrl || !runtimeDir || !runtimeBase || !cacheDir || !sessionId || !chromePid || !serviceTarget) {
    throw new Error("Missing session watcher argument")
  }
  if (!/^[0-9]+$/.test(chromePid)) throw new Error("Invalid Chrome process identifier")
  if (!SERVICE_TARGET_PATTERN.test(serviceTarget)) throw new Error("Invalid launchd service target")
  return {
    cacheDir,
    chromePid: Number(chromePid),
    port,
    runtimeBase,
    runtimeDir,
    serviceTarget,
    sessionId,
    sessionUrl,
    targetId,
  }
}

export function runtimePathIsSafe(runtimeDir, runtimeBase) {
  const resolvedDir = path.resolve(runtimeDir)
  const resolvedBase = path.resolve(runtimeBase)
  return path.dirname(resolvedDir) === resolvedBase
    && path.basename(resolvedDir).startsWith("cloudflare-fleet.")
}

async function listTargets(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
    signal: AbortSignal.timeout(CDP_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`DevTools target list returned HTTP ${response.status}`)
  return response.json()
}

async function evaluate(webSocketUrl, expression) {
  if (typeof WebSocket !== "function") throw new Error("This Node version does not provide WebSocket")

  return new Promise((resolve, reject) => {
    const socket = new WebSocket(webSocketUrl)
    const timeout = setTimeout(() => {
      socket.close()
      reject(new Error("DevTools evaluation timed out"))
    }, CDP_TIMEOUT_MS)

    socket.addEventListener("error", () => {
      clearTimeout(timeout)
      reject(new Error("DevTools WebSocket failed"))
    }, { once: true })
    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({
        id: 1,
        method: "Runtime.evaluate",
        params: {
          expression,
          returnByValue: true,
        },
      }))
    }, { once: true })
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data))
      if (message.id !== 1) return
      clearTimeout(timeout)
      socket.close()
      if (message.error || message.result?.exceptionDetails) {
        reject(new Error(message.error?.message || "DevTools evaluation failed"))
        return
      }
      resolve(message.result?.result?.value ?? null)
    })
  })
}

async function removeRuntime(runtimeDir, runtimeBase) {
  if (!runtimePathIsSafe(runtimeDir, runtimeBase)) {
    throw new Error(`Refusing to remove unexpected runtime path: ${runtimeDir}`)
  }
  await fs.rm(runtimeDir, {
    force: true,
    recursive: true,
  })
}

function processIsRunning(processId) {
  try {
    process.kill(processId, 0)
    return true
  } catch {
    return false
  }
}

async function stopBrowser(processId) {
  if (!processIsRunning(processId)) return true
  try {
    process.kill(processId, "SIGTERM")
  } catch {
    return true
  }

  for (let attempt = 0; attempt < BROWSER_EXIT_ATTEMPTS; attempt += 1) {
    if (!processIsRunning(processId)) return true
    await delay(BROWSER_EXIT_INTERVAL_MS)
  }
  return false
}

function removeLaunchdService(serviceTarget) {
  const result = spawnSync("/bin/launchctl", ["bootout", serviceTarget], {
    stdio: "ignore",
  })
  if (result.error) {
    process.stderr.write(`[WRN][cloudflare-fleet-watcher] Could not remove launchd service ${serviceTarget}: ${result.error.message}\n`)
  }
}

export async function watchSession(options) {
  let lastSavedAt = null
  let missingTargetCount = 0
  let stopped = false
  const stop = () => {
    stopped = true
  }
  process.once("SIGINT", stop)
  process.once("SIGTERM", stop)

  const snapshotExpression = `globalThis[${JSON.stringify(CACHE_SNAPSHOT_GLOBAL)}] ?? null`

  try {
    while (!stopped && missingTargetCount < MISSING_TARGET_LIMIT) {
      try {
        const targets = await listTargets(options.port)
        const target = targets.find(
          (entry) => entry.id === options.targetId && entry.url === options.sessionUrl,
        )
        if (!target?.webSocketDebuggerUrl) {
          missingTargetCount += 1
        } else {
          missingTargetCount = 0
          const serialized = await evaluate(target.webSocketDebuggerUrl, snapshotExpression)
          if (typeof serialized === "string") {
            const record = JSON.parse(serialized)
            if (isCacheRecord(record)
              && cacheRecordUpdatedAt(record) !== lastSavedAt) {
              await persistCacheRecord(options.cacheDir, options.sessionId, record)
              lastSavedAt = cacheRecordUpdatedAt(record)
            }
          }
        }
      } catch (error) {
        missingTargetCount += 1
        process.stderr.write(`[WRN][cloudflare-fleet-watcher] ${error instanceof Error ? error.message : String(error)}\n`)
      }

      if (!stopped && missingTargetCount < MISSING_TARGET_LIMIT) {
        await delay(POLL_INTERVAL_MS)
      }
    }
  } finally {
    process.removeListener("SIGINT", stop)
    process.removeListener("SIGTERM", stop)
    try {
      const browserStopped = await stopBrowser(options.chromePid)
      if (browserStopped) {
        await removeRuntime(options.runtimeDir, options.runtimeBase)
      } else {
        process.stderr.write(`[WRN][cloudflare-fleet-watcher] Chrome ${options.chromePid} did not stop; preserving ${options.runtimeDir}\n`)
      }
    } finally {
      removeLaunchdService(options.serviceTarget)
    }
  }
}

async function main(args) {
  await watchSession(parseOptions(args))
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`[ERR][cloudflare-fleet-watcher] ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
