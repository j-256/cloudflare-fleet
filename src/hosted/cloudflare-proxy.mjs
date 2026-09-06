import {
  HTTP_METHOD,
} from "../constants.mjs"
import {
  RETRY_AFTER_HEADER,
  resolveCloudflareApiUrl,
} from "../api.mjs"
import {
  readBoundedBody,
  withSecurityHeaders,
} from "./http.mjs"
import {
  authorizeCloudflareRequest,
} from "./proxy-policy.mjs"

const CLOUDFLARE_REQUEST_TIMEOUT_MS = 30000
const CLOUDFLARE_REDIRECT_MODE = "manual"
const REDIRECT_STATUS_MAX = 399
const REDIRECT_STATUS_MIN = 300
const MEMBERSHIP_CACHE_MS = 5 * 60 * 1000
const verifiedZoneMemberships = new Map()

export class CloudflareProxyError extends Error {
  constructor(status, message) {
    super(message)
    this.name = "CloudflareProxyError"
    this.status = status
  }
}

function membershipCacheKey(accountId, zoneId) {
  return `${accountId}:${zoneId}`
}

function membershipIsCached(accountId, zoneId, now = Date.now()) {
  const expiresAt = verifiedZoneMemberships.get(membershipCacheKey(accountId, zoneId))
  return Number.isFinite(expiresAt) && expiresAt > now
}

function cacheMembership(accountId, zoneId, now = Date.now()) {
  verifiedZoneMemberships.set(
    membershipCacheKey(accountId, zoneId),
    now + MEMBERSHIP_CACHE_MS,
  )
}

function invokeFetch(fetchImpl, input, init) {
  return fetchImpl(input, init)
}

function responseIsRedirect(response) {
  return response.status >= REDIRECT_STATUS_MIN
    && response.status <= REDIRECT_STATUS_MAX
}

async function verifyZoneMembership(options) {
  const {
    accountId,
    apiToken,
    fetchImpl,
    zoneId,
  } = options
  if (membershipIsCached(accountId, zoneId, options.now?.())) return
  const target = resolveCloudflareApiUrl(`zones/${encodeURIComponent(zoneId)}`)
  let response
  try {
    response = await invokeFetch(fetchImpl, target, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${apiToken}`,
      },
      method: HTTP_METHOD.GET,
      redirect: CLOUDFLARE_REDIRECT_MODE,
      signal: AbortSignal.timeout(CLOUDFLARE_REQUEST_TIMEOUT_MS),
    })
  } catch {
    console.error("Cloudflare zone ownership check failed")
    throw new CloudflareProxyError(502, "Cloudflare zone ownership check failed")
  }
  if (responseIsRedirect(response)) {
    throw new CloudflareProxyError(502, "Cloudflare zone ownership check returned a redirect")
  }
  let envelope
  try {
    envelope = await response.json()
  } catch {
    throw new CloudflareProxyError(502, "Cloudflare zone ownership check returned invalid data")
  }
  if (!response.ok || envelope.success !== true) {
    throw new CloudflareProxyError(502, "Cloudflare zone ownership check was rejected")
  }
  if (envelope.result?.account?.id !== accountId) {
    throw new CloudflareProxyError(403, "Cloudflare zone is outside the configured account")
  }
  cacheMembership(accountId, zoneId, options.now?.())
}

function contentTypeIsJson(request) {
  const contentType = request.headers.get("Content-Type")
  return !contentType || contentType.toLowerCase().startsWith("application/json")
}

export async function proxyCloudflareRequest(request, options) {
  const requestUrl = new URL(request.url)
  const apiPrefix = "/api/cloudflare/"
  if (!requestUrl.pathname.startsWith(apiPrefix)) {
    throw new CloudflareProxyError(404, "Cloudflare proxy path is unavailable")
  }
  const relativePath = `${requestUrl.pathname.slice(apiPrefix.length)}${requestUrl.search}`
  let target
  try {
    target = resolveCloudflareApiUrl(relativePath)
  } catch {
    throw new CloudflareProxyError(400, "Cloudflare path is outside the API boundary")
  }
  const authorization = authorizeCloudflareRequest(
    request.method,
    target,
    options.accountId,
  )
  if (!authorization.allowed) {
    throw new CloudflareProxyError(403, authorization.reason)
  }
  if (request.method !== HTTP_METHOD.GET) {
    if (options.readOnly) {
      throw new CloudflareProxyError(403, "Cloudflare writes are disabled for this deployment")
    }
    if (!contentTypeIsJson(request)) {
      throw new CloudflareProxyError(415, "Cloudflare writes require JSON content")
    }
    await verifyZoneMembership({
      ...options,
      zoneId: authorization.zoneId,
    })
  }
  const body = request.method === HTTP_METHOD.GET
    ? null
    : await readBoundedBody(request)
  const headers = {
    Accept: "application/json",
    Authorization: `Bearer ${options.apiToken}`,
  }
  if (body?.byteLength) headers["Content-Type"] = "application/json"
  let upstream
  try {
    upstream = await invokeFetch(options.fetchImpl, target, {
      body: body?.byteLength ? body : undefined,
      headers,
      method: request.method,
      redirect: CLOUDFLARE_REDIRECT_MODE,
      signal: AbortSignal.timeout(CLOUDFLARE_REQUEST_TIMEOUT_MS),
    })
  } catch (error) {
    console.error("Cloudflare proxy request failed", error)
    if (error?.name === "TimeoutError") {
      throw new CloudflareProxyError(504, "Cloudflare request timed out")
    }
    throw new CloudflareProxyError(502, "Cloudflare request failed")
  }
  if (responseIsRedirect(upstream)) {
    throw new CloudflareProxyError(502, "Cloudflare API redirects are not allowed")
  }
  const responseHeaders = new Headers()
  responseHeaders.set(
    "Content-Type",
    upstream.headers.get("Content-Type") || "application/json; charset=utf-8",
  )
  const retryAfter = upstream.headers.get(RETRY_AFTER_HEADER)
  if (retryAfter !== null) responseHeaders.set(RETRY_AFTER_HEADER, retryAfter)
  return withSecurityHeaders(new Response(await upstream.arrayBuffer(), {
    headers: responseHeaders,
    status: upstream.status,
    statusText: upstream.statusText,
  }))
}
