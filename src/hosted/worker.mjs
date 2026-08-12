import {
  FLEET_BOOTSTRAP_ERROR_GLOBAL,
} from "../api.mjs"
import {
  CACHE_RECORD_GLOBAL,
} from "../cache.mjs"
import {
  FLEET_INTENT_DOCUMENT_GLOBAL,
} from "../fleet-intent.mjs"
import {
  HTTP_METHOD,
} from "../constants.mjs"
import {
  AccessAuthorizationError,
  verifyAccessRequest,
} from "./access.mjs"
import {
  CloudflareProxyError,
  proxyCloudflareRequest,
} from "./cloudflare-proxy.mjs"
import {
  appendHostedOperationActivity,
  finalizeHostedOperationActivity,
  HostedFleetIntentRevisionConflictError,
  persistHostedCacheRecord,
  persistHostedFleetIntent,
  readHostedCacheRecord,
  readHostedFleetIntent,
  readHostedOperationActivity,
} from "./d1-store.mjs"
import {
  errorResponse,
  InvalidJsonBodyError,
  javascriptResponse,
  jsonResponse,
  mutationIsSameOrigin,
  readJsonBody,
  RequestBodyTooLargeError,
  safeScriptJson,
  withSecurityHeaders,
} from "./http.mjs"

const AUTH_GLOBAL = "__CLOUDFLARE_FLEET_AUTH__"
const DYNAMIC_SCRIPT_PATHS = new Set([
  "/auth.js",
  "/cache.js",
  "/intent.js",
])
const MUTATION_METHODS = new Set([
  HTTP_METHOD.DELETE,
  HTTP_METHOD.PATCH,
  HTTP_METHOD.POST,
  HTTP_METHOD.PUT,
])

function deploymentIsReadOnly(env) {
  return env.FLEET_READ_ONLY === "true"
}

function assertRuntimeBindings(env) {
  if (!env.FLEET_DB || typeof env.FLEET_DB.prepare !== "function") {
    throw new Error("Hosted Fleet D1 binding is unavailable")
  }
  if (!env.ASSETS || typeof env.ASSETS.fetch !== "function") {
    throw new Error("Hosted Fleet static asset binding is unavailable")
  }
  if (typeof env.FLEET_ACCOUNT_ID !== "string" || env.FLEET_ACCOUNT_ID.length === 0) {
    throw new Error("Hosted Fleet account binding is unavailable")
  }
  if (typeof env.CLOUDFLARE_API_TOKEN !== "string"
    || env.CLOUDFLARE_API_TOKEN.length === 0) {
    throw new Error("Hosted Fleet Cloudflare API token is unavailable")
  }
  if (!["true", "false"].includes(env.FLEET_READ_ONLY)) {
    throw new Error("Hosted Fleet read-only binding is invalid")
  }
}

function successResponse(result) {
  return jsonResponse({
    result,
    success: true,
  })
}

function globalAssignment(name, value, options = {}) {
  const serialized = safeScriptJson(value)
  return options.freeze
    ? `window[${safeScriptJson(name)}] = Object.freeze(${serialized})\n`
    : `window[${safeScriptJson(name)}] = ${serialized}\n`
}

function bootstrapFailure(error) {
  const message = error instanceof Error ? error.message : String(error)
  return javascriptResponse(
    globalAssignment(FLEET_BOOTSTRAP_ERROR_GLOBAL, message),
    500,
  )
}

async function handleDynamicScript(pathname, env) {
  try {
    if (pathname === "/auth.js") {
      return javascriptResponse(globalAssignment(AUTH_GLOBAL, {
        accountId: env.FLEET_ACCOUNT_ID,
        backendBaseUrl: "./api/",
        hosted: true,
        readOnly: deploymentIsReadOnly(env),
      }, { freeze: true }))
    }
    if (pathname === "/intent.js") {
      const document = await readHostedFleetIntent(
        env.FLEET_DB,
        env.FLEET_ACCOUNT_ID,
      )
      return javascriptResponse(globalAssignment(
        FLEET_INTENT_DOCUMENT_GLOBAL,
        document,
      ))
    }
    const record = await readHostedCacheRecord(
      env.FLEET_DB,
      env.FLEET_ACCOUNT_ID,
    )
    return javascriptResponse(globalAssignment(CACHE_RECORD_GLOBAL, record))
  } catch (error) {
    console.error(error)
    return bootstrapFailure(error)
  }
}

async function handleIntent(request, env) {
  if (request.method === HTTP_METHOD.GET) {
    return successResponse(await readHostedFleetIntent(
      env.FLEET_DB,
      env.FLEET_ACCOUNT_ID,
    ))
  }
  if (request.method !== HTTP_METHOD.PUT) {
    return errorResponse(405, "Fleet intent method is not allowed")
  }
  if (deploymentIsReadOnly(env)) {
    return errorResponse(403, "Fleet intent writes are disabled for this deployment")
  }
  const payload = await readJsonBody(request)
  if (typeof payload?.expectedRevision !== "string" || !payload.document) {
    return errorResponse(400, "Fleet intent body is incomplete")
  }
  try {
    return successResponse(await persistHostedFleetIntent(
      env.FLEET_DB,
      env.FLEET_ACCOUNT_ID,
      payload.expectedRevision,
      payload.document,
    ))
  } catch (error) {
    if (error instanceof HostedFleetIntentRevisionConflictError) {
      return jsonResponse({
        errors: [{ message: error.message }],
        result: error.currentDocument,
        success: false,
      }, 409)
    }
    throw error
  }
}

async function handleActivity(request, env) {
  if (request.method === HTTP_METHOD.GET) {
    return successResponse(await readHostedOperationActivity(
      env.FLEET_DB,
      env.FLEET_ACCOUNT_ID,
    ))
  }
  if (![HTTP_METHOD.POST, HTTP_METHOD.PATCH].includes(request.method)) {
    return errorResponse(405, "Operation activity method is not allowed")
  }
  if (deploymentIsReadOnly(env)) {
    return errorResponse(403, "Operation activity writes are disabled for this deployment")
  }
  const payload = await readJsonBody(request)
  if (!payload?.entry) {
    return errorResponse(400, "Operation activity body is incomplete")
  }
  const document = request.method === HTTP_METHOD.POST
    ? await appendHostedOperationActivity(
        env.FLEET_DB,
        env.FLEET_ACCOUNT_ID,
        payload.entry,
      )
    : await finalizeHostedOperationActivity(
        env.FLEET_DB,
        env.FLEET_ACCOUNT_ID,
        payload.entry,
      )
  return successResponse(document)
}

async function handleCache(request, env) {
  if (request.method !== HTTP_METHOD.POST) {
    return errorResponse(405, "Snapshot method is not allowed")
  }
  const record = await readJsonBody(request)
  await persistHostedCacheRecord(
    env.FLEET_DB,
    env.FLEET_ACCOUNT_ID,
    record,
  )
  return successResponse(null)
}

async function handleApi(request, env) {
  const pathname = new URL(request.url).pathname
  if (pathname === "/api/intent") return handleIntent(request, env)
  if (pathname === "/api/activity") return handleActivity(request, env)
  if (pathname === "/api/cache") return handleCache(request, env)
  if (pathname.startsWith("/api/cloudflare/")) {
    return proxyCloudflareRequest(request, {
      accountId: env.FLEET_ACCOUNT_ID,
      apiToken: env.CLOUDFLARE_API_TOKEN,
      fetchImpl: globalThis.fetch,
      readOnly: deploymentIsReadOnly(env),
    })
  }
  return errorResponse(404, "Hosted Fleet API path not found")
}

async function handleRequest(request, env) {
  try {
    await verifyAccessRequest(request, env)
  } catch (error) {
    if (error instanceof AccessAuthorizationError) {
      return errorResponse(403, error.message)
    }
    throw error
  }
  assertRuntimeBindings(env)
  if (MUTATION_METHODS.has(request.method) && !mutationIsSameOrigin(request)) {
    return errorResponse(403, "Cross-site mutations are not allowed")
  }
  const pathname = new URL(request.url).pathname
  if (DYNAMIC_SCRIPT_PATHS.has(pathname)) {
    if (request.method !== HTTP_METHOD.GET) {
      return errorResponse(405, "Bootstrap script method is not allowed")
    }
    return handleDynamicScript(pathname, env)
  }
  if (pathname.startsWith("/api/")) return handleApi(request, env)
  if (![HTTP_METHOD.GET, "HEAD"].includes(request.method)) {
    return errorResponse(405, "Asset method is not allowed")
  }
  return withSecurityHeaders(await env.ASSETS.fetch(request), {
    cacheControl: "no-cache",
  })
}

export async function fetchHostedFleet(request, env) {
  try {
    return await handleRequest(request, env)
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return errorResponse(413, error.message)
    }
    if (error instanceof InvalidJsonBodyError
      || error instanceof TypeError) {
      return errorResponse(400, error.message)
    }
    if (error instanceof CloudflareProxyError) {
      return errorResponse(error.status, error.message)
    }
    console.error(error)
    return errorResponse(500, "Hosted Fleet request failed")
  }
}

export default {
  fetch: fetchHostedFleet,
}
