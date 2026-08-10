import { spawnSync } from "node:child_process"
import { promises as fs } from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"

import {
  CACHE_SNAPSHOT_GLOBAL,
  isCacheRecord,
} from "./cache.mjs"
import { persistCacheRecord } from "./cache-store.mjs"
import { isMainModule } from "./entrypoint.mjs"

const CDP_TIMEOUT_MS = 5000
const BROWSER_EXIT_ATTEMPTS = 50
const BROWSER_EXIT_INTERVAL_MS = 100
const DEVTOOLS_EVALUATION_ID = 1
const MISSING_TARGET_LIMIT = 3
const POLL_INTERVAL_MS = 1000
const SERVICE_TARGET_PATTERN = /^gui\/[0-9]+\/com\.j256\.cloudflare-fleet\.[A-Za-z0-9]+$/
const WATCHER_SERVICE_LABEL = "com.j256.cloudflare-fleet."

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

export function parseWatcherOptions(args) {
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
  const parsedPort = Number(port)
  const parsedChromePid = Number(chromePid)
  if (!Number.isSafeInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
    throw new Error("Invalid DevTools port")
  }
  if (!Number.isSafeInteger(parsedChromePid) || parsedChromePid <= 1) {
    throw new Error("Invalid Chrome process identifier")
  }
  if (!/^[A-Za-z0-9]+$/.test(sessionId)) {
    throw new Error("Invalid session identifier")
  }
  if (!SERVICE_TARGET_PATTERN.test(serviceTarget)
    || !serviceTarget.endsWith(`/${WATCHER_SERVICE_LABEL}${sessionId}`)) {
    throw new Error("Invalid launchd service target")
  }
  if (!runtimePathIsSafe(runtimeDir, runtimeBase, sessionId)) {
    throw new Error(`Invalid session runtime path: ${runtimeDir}`)
  }
  let normalizedSessionUrl
  try {
    normalizedSessionUrl = new URL(sessionUrl).href
  } catch {
    throw new Error("Invalid session URL")
  }
  const expectedSessionUrl = pathToFileURL(path.join(runtimeDir, "index.html")).href
  if (normalizedSessionUrl !== expectedSessionUrl) {
    throw new Error("Invalid session URL")
  }
  return {
    cacheDir,
    chromePid: parsedChromePid,
    port: parsedPort,
    runtimeBase,
    runtimeDir,
    serviceTarget,
    sessionId,
    sessionUrl: normalizedSessionUrl,
    targetId,
  }
}

export function runtimePathIsSafe(runtimeDir, runtimeBase, sessionId = null) {
  const resolvedDir = path.resolve(runtimeDir)
  const resolvedBase = path.resolve(runtimeBase)
  const runtimeName = path.basename(resolvedDir)
  return path.dirname(resolvedDir) === resolvedBase
    && /^cloudflare-fleet\.[A-Za-z0-9]+$/.test(runtimeName)
    && (sessionId === null || runtimeName === `cloudflare-fleet.${sessionId}`)
}

async function listTargets(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
    signal: AbortSignal.timeout(CDP_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`DevTools target list returned HTTP ${response.status}`)
  return response.json()
}

export async function evaluateDevToolsExpression(webSocketUrl, expression, options = {}) {
  const createSocket = options.createSocket ?? ((url) => {
    if (typeof WebSocket !== "function") {
      throw new Error("This Node version does not provide WebSocket")
    }
    return new WebSocket(url)
  })
  const timeoutMs = options.timeoutMs ?? CDP_TIMEOUT_MS

  return new Promise((resolve, reject) => {
    let socket
    try {
      socket = createSocket(webSocketUrl)
    } catch (error) {
      reject(error)
      return
    }
    let settled = false
    const settle = (callback, value) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      try {
        socket.close()
      } catch {}
      callback(value)
    }
    const timeout = setTimeout(() => {
      settle(reject, new Error("DevTools evaluation timed out"))
    }, timeoutMs)

    socket.addEventListener("error", () => {
      settle(reject, new Error("DevTools WebSocket failed"))
    }, { once: true })
    socket.addEventListener("close", () => {
      settle(reject, new Error("DevTools WebSocket closed before evaluation completed"))
    }, { once: true })
    socket.addEventListener("open", () => {
      try {
        socket.send(JSON.stringify({
          id: DEVTOOLS_EVALUATION_ID,
          method: "Runtime.evaluate",
          params: {
            expression,
            returnByValue: true,
          },
        }))
      } catch {
        settle(reject, new Error("DevTools evaluation could not be sent"))
      }
    }, { once: true })
    socket.addEventListener("message", (event) => {
      let message
      try {
        message = JSON.parse(String(event.data))
      } catch {
        settle(reject, new Error("DevTools returned an invalid evaluation response"))
        return
      }
      if (message.id !== DEVTOOLS_EVALUATION_ID) return
      if (message.error || message.result?.exceptionDetails) {
        settle(reject, new Error(message.error?.message || "DevTools evaluation failed"))
        return
      }
      settle(resolve, message.result?.result?.value ?? null)
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

function processIsRunning(processId, sendSignal) {
  try {
    sendSignal(processId, 0)
    return true
  } catch {
    return false
  }
}

export async function stopBrowser(processId, dependencies = {}) {
  const sendSignal = dependencies.sendSignal ?? process.kill.bind(process)
  const wait = dependencies.delay ?? delay
  if (!processIsRunning(processId, sendSignal)) return true
  try {
    sendSignal(processId, "SIGTERM")
  } catch {
    return true
  }

  for (let attempt = 0; attempt < BROWSER_EXIT_ATTEMPTS; attempt += 1) {
    if (!processIsRunning(processId, sendSignal)) return true
    await wait(BROWSER_EXIT_INTERVAL_MS)
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

export async function watchSession(options, dependencies = {}) {
  const evaluateTarget = dependencies.evaluate ?? evaluateDevToolsExpression
  const listSessionTargets = dependencies.listTargets ?? listTargets
  const persistSnapshot = dependencies.persistCacheRecord ?? persistCacheRecord
  const removeService = dependencies.removeLaunchdService ?? removeLaunchdService
  const removeSessionRuntime = dependencies.removeRuntime ?? removeRuntime
  const signalTarget = dependencies.signalTarget ?? process
  const stderr = dependencies.stderr ?? process.stderr
  const stopSessionBrowser = dependencies.stopBrowser ?? stopBrowser
  const wait = dependencies.delay ?? delay
  let lastSavedSnapshot = null
  let lastSnapshotWarning = null
  let missingTargetCount = 0
  let stopped = false
  const stop = () => {
    stopped = true
  }
  const warn = (error) => {
    stderr.write(`[WRN][cloudflare-fleet-watcher] ${error instanceof Error ? error.message : String(error)}\n`)
  }
  signalTarget.once("SIGINT", stop)
  signalTarget.once("SIGTERM", stop)

  const snapshotExpression = `globalThis[${JSON.stringify(CACHE_SNAPSHOT_GLOBAL)}] ?? null`

  try {
    while (!stopped && missingTargetCount < MISSING_TARGET_LIMIT) {
      let target = null
      try {
        const targets = await listSessionTargets(options.port)
        target = targets.find(
          (entry) => entry.id === options.targetId && entry.url === options.sessionUrl,
        )
      } catch (error) {
        missingTargetCount += 1
        warn(error)
      }

      if (target?.webSocketDebuggerUrl) {
        missingTargetCount = 0
        try {
          const serialized = await evaluateTarget(target.webSocketDebuggerUrl, snapshotExpression)
          if (typeof serialized === "string") {
            if (serialized !== lastSavedSnapshot) {
              const record = JSON.parse(serialized)
              if (!isCacheRecord(record)) throw new TypeError("Dashboard snapshot is invalid")
              await persistSnapshot(options.cacheDir, options.sessionId, record)
              lastSavedSnapshot = serialized
            }
          }
          lastSnapshotWarning = null
        } catch (error) {
          const warning = error instanceof Error ? error.message : String(error)
          if (warning !== lastSnapshotWarning) warn(error)
          lastSnapshotWarning = warning
        }
      } else if (target !== null) {
        missingTargetCount += 1
      }

      if (!stopped && missingTargetCount < MISSING_TARGET_LIMIT) {
        await wait(POLL_INTERVAL_MS)
      }
    }
  } finally {
    signalTarget.removeListener("SIGINT", stop)
    signalTarget.removeListener("SIGTERM", stop)
    try {
      const browserStopped = await stopSessionBrowser(options.chromePid)
      if (browserStopped) {
        await removeSessionRuntime(options.runtimeDir, options.runtimeBase)
      } else {
        warn(`Chrome ${options.chromePid} did not stop; preserving ${options.runtimeDir}`)
      }
    } finally {
      removeService(options.serviceTarget)
    }
  }
}

async function main(args) {
  await watchSession(parseWatcherOptions(args))
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`[ERR][cloudflare-fleet-watcher] ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
