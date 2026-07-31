import { timingSafeEqual } from "node:crypto"
import { spawnSync } from "node:child_process"
import { promises as fs } from "node:fs"
import http from "node:http"
import path from "node:path"

import {
  API_BASE_URL,
  HTTP_METHOD,
} from "./constants.mjs"
import {
  BROKER_SESSION_HEADER,
} from "./api.mjs"
import {
  isCacheRecord,
} from "./cache.mjs"
import { isMainModule } from "./entrypoint.mjs"
import {
  persistCacheRecord,
} from "./cache-store.mjs"
import {
  runtimePathIsSafe,
} from "./session-watcher.mjs"

const BODY_LIMIT_BYTES = 2 * 1024 * 1024
const DEFAULT_SHUTDOWN_GRACE_MS = 15000
const LIVENESS_PING_INTERVAL_MS = 20000
const LOOPBACK_HOST = "127.0.0.1"
const MIME_TYPES = Object.freeze({
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
})
const PROXY_METHODS = new Set([
  HTTP_METHOD.DELETE,
  HTTP_METHOD.GET,
  HTTP_METHOD.PATCH,
  HTTP_METHOD.POST,
  HTTP_METHOD.PUT,
])
const SERVICE_TARGET_PATTERN = /^gui\/[0-9]+\/com\.j256\.cloudflare-fleet\.broker\.[A-Za-z0-9]+$/

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ""))
  const rightBuffer = Buffer.from(String(right || ""))
  return leftBuffer.length === rightBuffer.length
    && timingSafeEqual(leftBuffer, rightBuffer)
}

function jsonResponse(response, status, body) {
  const serialized = JSON.stringify(body)
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(serialized),
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
  })
  response.end(serialized)
}

function errorResponse(response, status, message) {
  jsonResponse(response, status, {
    errors: [{ message }],
    messages: [],
    result: null,
    success: false,
  })
}

async function requestBody(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > BODY_LIMIT_BYTES) throw new Error("Request body is too large")
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

function authorized(request, sessionSecret, origin) {
  const supplied = request.headers[BROKER_SESSION_HEADER.toLowerCase()]
  if (!safeEqual(supplied, sessionSecret)) return false
  if (request.headers.origin && request.headers.origin !== origin) return false
  const fetchSite = request.headers["sec-fetch-site"]
  return !fetchSite || fetchSite === "same-origin"
}

function staticFileFor(runtimeDir, relativePath) {
  if (relativePath === "/" || relativePath === "/index.html") {
    return path.join(runtimeDir, "index.html")
  }
  if (relativePath === "/styles.css" || relativePath === "/cache.js") {
    return path.join(runtimeDir, relativePath.slice(1))
  }
  if (/^\/src\/[A-Za-z0-9._-]+\.mjs$/.test(relativePath)) {
    return path.join(runtimeDir, relativePath.slice(1))
  }
  return null
}

async function serveStatic(response, filePath) {
  try {
    const body = await fs.readFile(filePath)
    response.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Length": body.length,
      "Content-Type": MIME_TYPES[path.extname(filePath)] || "application/octet-stream",
      "Cross-Origin-Resource-Policy": "same-origin",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
    })
    response.end(body)
  } catch (error) {
    if (error?.code === "ENOENT") {
      errorResponse(response, 404, "Session asset not found")
      return
    }
    throw error
  }
}

function authScript(options) {
  const payload = JSON.stringify({
    accountId: options.accountId,
    brokerBaseUrl: "./api/",
    brokerSecret: options.sessionSecret,
    readOnly: options.readOnly,
  })
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029")
  return `window.__CLOUDFLARE_FLEET_AUTH__ = Object.freeze(${payload})\n`
}

function serveAuth(response, options) {
  const body = authScript(options)
  response.writeHead(200, {
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body),
    "Content-Type": MIME_TYPES[".js"],
    "Cross-Origin-Resource-Policy": "same-origin",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  })
  response.end(body)
}

async function proxyCloudflare(
  request,
  response,
  options,
  cloudflareFetch,
  apiRelativePath,
) {
  if (!PROXY_METHODS.has(request.method)) {
    errorResponse(response, 405, "Cloudflare method is not allowed")
    return
  }
  if (options.readOnly && request.method !== HTTP_METHOD.GET) {
    errorResponse(response, 403, "Cloudflare writes are disabled for this session")
    return
  }
  const target = new URL(apiRelativePath, API_BASE_URL)
  const apiBase = new URL(API_BASE_URL)
  if (target.origin !== apiBase.origin || !target.pathname.startsWith(apiBase.pathname)) {
    errorResponse(response, 400, "Cloudflare path is outside the API boundary")
    return
  }

  const body = request.method === HTTP_METHOD.GET
    ? undefined
    : await requestBody(request)
  const headers = {
    Accept: "application/json",
    Authorization: `Bearer ${options.apiToken}`,
  }
  if (body?.length) headers["Content-Type"] = "application/json"

  let upstream
  try {
    upstream = await cloudflareFetch(target, {
      body: body?.length ? body : undefined,
      headers,
      method: request.method,
    })
  } catch (error) {
    errorResponse(
      response,
      502,
      `Cloudflare request failed: ${error instanceof Error ? error.message : String(error)}`,
    )
    return
  }
  const responseBody = Buffer.from(await upstream.arrayBuffer())
  response.writeHead(upstream.status, {
    "Cache-Control": "no-store",
    "Content-Length": responseBody.length,
    "Content-Type": upstream.headers.get("content-type") || "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
  })
  response.end(responseBody)
}

async function persistSnapshot(request, response, options) {
  if (request.method !== HTTP_METHOD.POST) {
    errorResponse(response, 405, "Snapshot method is not allowed")
    return
  }
  let record
  try {
    record = JSON.parse((await requestBody(request)).toString("utf8"))
  } catch {
    errorResponse(response, 400, "Snapshot body is not valid JSON")
    return
  }
  if (!isCacheRecord(record) || record.accountId !== options.accountId) {
    errorResponse(response, 400, "Snapshot record is invalid for this account")
    return
  }
  await persistCacheRecord(options.cacheDir, options.sessionId, record)
  jsonResponse(response, 200, {
    success: true,
  })
}

export async function startSessionBroker(options) {
  if (!options.accountId || !options.apiToken || !options.cacheDir || !options.runtimeDir
    || !options.sessionId || !options.sessionSecret) {
    throw new TypeError("Session broker options are incomplete")
  }
  const cloudflareFetch = options.cloudflareFetch ?? globalThis.fetch
  if (typeof cloudflareFetch !== "function") {
    throw new TypeError("The session broker requires a Cloudflare fetch transport")
  }
  const shutdownGraceMs = options.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS
  const livenessResponses = new Set()
  let clientSeen = false
  let origin = ""
  let shutdownTimer = null
  let resolveClosed
  const closed = new Promise((resolve) => {
    resolveClosed = resolve
  })

  const clearShutdown = () => {
    if (!shutdownTimer) return
    clearTimeout(shutdownTimer)
    shutdownTimer = null
  }
  const server = http.createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url, origin)
      const basePath = `/session/${encodeURIComponent(options.sessionId)}`
      if (!requestUrl.pathname.startsWith(`${basePath}/`)
        && requestUrl.pathname !== basePath) {
        errorResponse(response, 404, "Session path not found")
        return
      }
      const relativePath = requestUrl.pathname.slice(basePath.length) || "/"
      const apiPrefix = "/api/"

      if (!relativePath.startsWith(apiPrefix)) {
        if (request.method !== HTTP_METHOD.GET) {
          errorResponse(response, 405, "Asset method is not allowed")
          return
        }
        if (relativePath === "/auth.js") {
          const fetchSite = request.headers["sec-fetch-site"]
          if (fetchSite && fetchSite !== "same-origin") {
            errorResponse(response, 403, "Session bootstrap is same-origin only")
            return
          }
          serveAuth(response, options)
          return
        }
        const filePath = staticFileFor(options.runtimeDir, relativePath)
        if (!filePath) {
          errorResponse(response, 404, "Session asset not found")
          return
        }
        await serveStatic(response, filePath)
        return
      }

      if (!authorized(request, options.sessionSecret, origin)) {
        errorResponse(response, 403, "Session authorization failed")
        return
      }
      const apiPath = relativePath.slice(apiPrefix.length)
      if (apiPath === "liveness") {
        if (request.method !== HTTP_METHOD.GET) {
          errorResponse(response, 405, "Liveness method is not allowed")
          return
        }
        clearShutdown()
        clientSeen = true
        response.writeHead(200, {
          "Cache-Control": "no-store",
          Connection: "keep-alive",
          "Content-Type": "text/event-stream; charset=utf-8",
          "X-Accel-Buffering": "no",
          "X-Content-Type-Options": "nosniff",
        })
        response.write(": connected\n\n")
        livenessResponses.add(response)
        options.onClientConnected?.()
        const ping = setInterval(() => {
          response.write(": keepalive\n\n")
        }, LIVENESS_PING_INTERVAL_MS)
        response.on("close", () => {
          clearInterval(ping)
          livenessResponses.delete(response)
          if (clientSeen && livenessResponses.size === 0 && !shutdownTimer) {
            shutdownTimer = setTimeout(() => {
              server.close()
              server.closeIdleConnections?.()
            }, shutdownGraceMs)
          }
        })
        return
      }
      if (apiPath === "cache") {
        await persistSnapshot(request, response, options)
        return
      }
      const cloudflarePrefix = "cloudflare/"
      if (apiPath.startsWith(cloudflarePrefix)) {
        const relative = `${apiPath.slice(cloudflarePrefix.length)}${requestUrl.search}`
        await proxyCloudflare(
          request,
          response,
          options,
          cloudflareFetch,
          relative,
        )
        return
      }
      errorResponse(response, 404, "Session API path not found")
    } catch (error) {
      errorResponse(
        response,
        500,
        error instanceof Error ? error.message : String(error),
      )
    }
  })

  server.on("close", () => {
    clearShutdown()
    for (const response of livenessResponses) response.end()
    livenessResponses.clear()
    resolveClosed()
  })
  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, LOOPBACK_HOST, () => {
      server.removeListener("error", reject)
      resolve()
    })
  })
  const address = server.address()
  origin = `http://${LOOPBACK_HOST}:${address.port}`
  const basePath = `/session/${encodeURIComponent(options.sessionId)}`
  return {
    close: () => server.close(),
    closed,
    origin,
    server,
    sessionUrl: `${origin}${basePath}/index.html`,
  }
}

async function atomicWrite(filePath, content) {
  const temporaryPath = `${filePath}.${process.pid}.tmp`
  await fs.writeFile(temporaryPath, content, {
    encoding: "utf8",
    mode: 0o600,
  })
  await fs.rename(temporaryPath, filePath)
  await fs.chmod(filePath, 0o600)
}

async function main(args) {
  const [configPath] = args
  if (!configPath) throw new Error("Usage: session-broker.mjs CONFIG_PATH")
  const config = JSON.parse(await fs.readFile(configPath, "utf8"))
  await fs.rm(configPath, { force: true })
  const apiToken = config.apiToken
  delete config.apiToken
  if (!apiToken) throw new Error("CLOUDFLARE_API_TOKEN is unavailable to the session broker")
  if (!SERVICE_TARGET_PATTERN.test(config.serviceTarget || "")) {
    throw new Error("Session broker service target is invalid")
  }

  let pageReadyWritten = false
  const broker = await startSessionBroker({
    ...config,
    apiToken,
    onClientConnected: () => {
      if (pageReadyWritten) return
      pageReadyWritten = true
      atomicWrite(
        path.join(config.runtimeDir, "page-ready.json"),
        `${JSON.stringify({ connected: true })}\n`,
      ).catch((error) => {
        process.stderr.write(`[WRN][cloudflare-fleet-broker] ${error instanceof Error ? error.message : String(error)}\n`)
      })
    },
  })
  await atomicWrite(
    path.join(config.runtimeDir, "broker-ready.json"),
    `${JSON.stringify({
      origin: broker.origin,
      pid: process.pid,
      sessionUrl: broker.sessionUrl,
    })}\n`,
  )
  await broker.closed
  if (!runtimePathIsSafe(config.runtimeDir, config.runtimeBase)) {
    throw new Error(`Refusing to remove unexpected runtime path: ${config.runtimeDir}`)
  }
  await fs.rm(config.runtimeDir, {
    force: true,
    recursive: true,
  })
  spawnSync("/bin/launchctl", ["bootout", config.serviceTarget], {
    stdio: "ignore",
  })
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`[ERR][cloudflare-fleet-broker] ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
