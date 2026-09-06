import {
  API_BASE_URL,
  DEFAULT_PAGE_SIZE,
  HTTP_METHOD,
  ZONE_PAGE_SIZE,
} from "./constants.mjs"

export const BROKER_SESSION_HEADER = "X-Cloudflare-Fleet-Session"
export const FLEET_BOOTSTRAP_ERROR_GLOBAL = "__CLOUDFLARE_FLEET_BOOTSTRAP_ERROR__"
export const RETRY_AFTER_HEADER = "Retry-After"

const API_BASE = new URL(API_BASE_URL)
const DEFAULT_READ_THROTTLE_DELAY_MS = 1000
const MAX_READ_THROTTLE_RETRIES = 3
const SESSION_MONITOR_RETRY_MS = 1000

export function resolveCloudflareApiUrl(path) {
  const relativePath = String(path).replace(/^\/+/, "")
  const url = new URL(relativePath, API_BASE)
  if (url.origin !== API_BASE.origin
    || !url.pathname.startsWith(API_BASE.pathname)) {
    throw new TypeError("Cloudflare path is outside the API boundary")
  }
  return url
}

function apiRelativeUrl(url) {
  return `${url.pathname.slice(API_BASE.pathname.length)}${url.search}`
}

function abortableDelay(delayMs, signal) {
  return new Promise((resolve) => {
    if (delayMs <= 0 || signal?.aborted) {
      resolve()
      return
    }
    let timer
    const finish = () => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", finish)
      resolve()
    }
    timer = setTimeout(finish, delayMs)
    signal?.addEventListener("abort", finish, { once: true })
  })
}

function retryAfterDelay(value) {
  const seconds = typeof value === "string" && value.trim() !== ""
    ? Number(value)
    : Number.NaN
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000
  const date = Date.parse(value)
  if (Number.isFinite(date)) return Math.max(0, date - Date.now())
  return DEFAULT_READ_THROTTLE_DELAY_MS
}

export class CloudflareApiError extends Error {
  constructor(message, options = {}) {
    super(message)
    this.name = "CloudflareApiError"
    this.status = options.status ?? null
    this.errors = options.errors ?? []
    this.messages = options.messages ?? []
    this.path = options.path ?? ""
    this.method = options.method ?? HTTP_METHOD.GET
  }
}

export class FleetIntentApiConflictError extends Error {
  constructor(message, currentDocument) {
    super(message)
    this.name = "FleetIntentApiConflictError"
    this.currentDocument = currentDocument
  }
}

export class CloudflareApi {
  constructor({
    apiToken,
    accountId,
    backendBaseUrl,
    brokerBaseUrl,
    brokerSecret,
    fetchImpl = globalThis.fetch,
  }) {
    if (!apiToken && !backendBaseUrl && !brokerSecret) {
      throw new TypeError("apiToken or backend transport is required")
    }
    if (!accountId) throw new TypeError("accountId is required")
    if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function")

    this.apiToken = apiToken
    this.accountId = accountId
    this.backendBaseUrl = (backendBaseUrl || brokerSecret)
      ? new URL(
          backendBaseUrl || brokerBaseUrl || "./api/",
          globalThis.location?.href || API_BASE_URL,
        )
      : null
    this.brokerSecret = brokerSecret
    this.fetchImpl = fetchImpl.bind(globalThis)
    this.readThrottleUntil = 0
  }

  get usesBroker() {
    return Boolean(this.brokerSecret)
  }

  get usesBackend() {
    return Boolean(this.backendBaseUrl)
  }

  backendHeaders(options = {}) {
    const headers = {
      Accept: "application/json",
    }
    if (options.json) headers["Content-Type"] = "application/json"
    if (this.usesBroker) headers[BROKER_SESSION_HEADER] = this.brokerSecret
    return headers
  }

  async request(path, options = {}) {
    const method = options.method || HTTP_METHOD.GET
    const cloudflareUrl = resolveCloudflareApiUrl(path)
    const url = this.usesBackend
      ? new URL(`cloudflare/${apiRelativeUrl(cloudflareUrl)}`, this.backendBaseUrl)
      : cloudflareUrl
    const headers = {
      Accept: "application/json",
    }
    if (this.usesBroker) headers[BROKER_SESSION_HEADER] = this.brokerSecret
    else if (!this.usesBackend) headers.Authorization = `Bearer ${this.apiToken}`
    if (this.usesBackend && !this.usesBroker && this.executionId && method !== HTTP_METHOD.GET) {
      headers["X-Fleet-Execution"] = this.executionId
    }
    const request = {
      method,
      headers,
      signal: options.signal,
    }

    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json"
      request.body = JSON.stringify(options.body)
    }

    let response
    let throttleRetries = 0
    while (true) {
      try {
        if (method === HTTP_METHOD.GET) {
          while (this.readThrottleUntil > Date.now() && !options.signal?.aborted) {
            await abortableDelay(
              this.readThrottleUntil - Date.now(),
              options.signal,
            )
          }
        }
        options.signal?.throwIfAborted()
        response = await this.fetchImpl(url, request)
      } catch (error) {
        throw new CloudflareApiError(`Network request failed for ${method} ${cloudflareUrl.pathname}`, {
          method,
          path: cloudflareUrl.pathname,
          errors: [{ message: error instanceof Error ? error.message : String(error) }],
        })
      }
      if (method !== HTTP_METHOD.GET || response.status !== 429) break
      const retryAt = Date.now()
        + retryAfterDelay(response.headers.get(RETRY_AFTER_HEADER))
      this.readThrottleUntil = Math.max(this.readThrottleUntil, retryAt)
      if (throttleRetries >= MAX_READ_THROTTLE_RETRIES) break
      throttleRetries += 1
      try {
        await response.body?.cancel()
      } catch {}
    }

    if (response.ok && response.status === 204) {
      return {
        result: null,
        resultInfo: null,
        status: response.status,
      }
    }

    let envelope
    try {
      envelope = await response.json()
    } catch {
      throw new CloudflareApiError(`Cloudflare returned non-JSON data for ${method} ${cloudflareUrl.pathname}`, {
        method,
        path: cloudflareUrl.pathname,
        status: response.status,
      })
    }

    if (!response.ok || envelope.success !== true) {
      const firstError = envelope.errors?.[0]
      const detail = firstError?.message || response.statusText || "Unknown Cloudflare API error"
      throw new CloudflareApiError(`${method} ${cloudflareUrl.pathname}: ${detail}`, {
        method,
        path: cloudflareUrl.pathname,
        status: response.status,
        errors: envelope.errors,
        messages: envelope.messages,
      })
    }

    return {
      result: envelope.result,
      resultInfo: envelope.result_info || null,
      status: response.status,
    }
  }

  async graphql(query, variables = {}, options = {}) {
    if (typeof query !== "string" || query.trim() === "") {
      throw new TypeError("GraphQL query is required")
    }
    if (!variables || typeof variables !== "object" || Array.isArray(variables)) {
      throw new TypeError("GraphQL variables must be an object")
    }
    const cloudflareUrl = new URL("graphql", API_BASE_URL)
    const url = this.usesBackend
      ? new URL("cloudflare/graphql", this.backendBaseUrl)
      : cloudflareUrl
    const headers = {
      Accept: "application/json",
      "Content-Type": "application/json",
    }
    if (this.usesBroker) headers[BROKER_SESSION_HEADER] = this.brokerSecret
    else if (!this.usesBackend) headers.Authorization = `Bearer ${this.apiToken}`
    let response
    try {
      response = await this.fetchImpl(url, {
        body: JSON.stringify({ query, variables }),
        headers,
        method: HTTP_METHOD.POST,
        signal: options.signal,
      })
    } catch (error) {
      throw new CloudflareApiError("Network request failed for POST /client/v4/graphql", {
        errors: [{ message: error instanceof Error ? error.message : String(error) }],
        method: HTTP_METHOD.POST,
        path: cloudflareUrl.pathname,
      })
    }
    let envelope
    try {
      envelope = await response.json()
    } catch {
      throw new CloudflareApiError("Cloudflare returned non-JSON data for POST /client/v4/graphql", {
        method: HTTP_METHOD.POST,
        path: cloudflareUrl.pathname,
        status: response.status,
      })
    }
    if (!response.ok || (Array.isArray(envelope.errors) && envelope.errors.length > 0)) {
      const detail = envelope.errors?.[0]?.message
        || response.statusText
        || "Unknown Cloudflare GraphQL error"
      throw new CloudflareApiError(`POST /client/v4/graphql: ${detail}`, {
        errors: envelope.errors || [],
        method: HTTP_METHOD.POST,
        path: cloudflareUrl.pathname,
        status: response.status,
      })
    }
    if (!envelope.data || typeof envelope.data !== "object") {
      throw new CloudflareApiError("Cloudflare returned invalid GraphQL data", {
        method: HTTP_METHOD.POST,
        path: cloudflareUrl.pathname,
        status: response.status,
      })
    }
    return envelope.data
  }

  async persistSnapshot(serializedSnapshot, options = {}) {
    if (!this.usesBackend) return
    const response = await this.fetchImpl(new URL("cache", this.backendBaseUrl), {
      body: serializedSnapshot,
      headers: this.backendHeaders({ json: true }),
      method: HTTP_METHOD.POST,
      signal: options.signal,
    })
    if (!response.ok) {
      throw new Error(`Snapshot persistence returned HTTP ${response.status}`)
    }
  }

  async loadFleetIntent(options = {}) {
    if (!this.usesBackend) {
      throw new Error("Fleet intent persistence requires a protected backend")
    }
    const response = await this.fetchImpl(new URL("intent", this.backendBaseUrl), {
      headers: this.backendHeaders(),
      signal: options.signal,
    })
    const envelope = await response.json()
    if (!response.ok || envelope.success !== true) {
      throw new Error(envelope.errors?.[0]?.message || `Fleet intent returned HTTP ${response.status}`)
    }
    return envelope.result
  }

  async workerCommand(command, payload, options = {}) {
    if (!this.usesBackend) throw new Error("Worker diagnostics require a protected backend")
    const response = await this.fetchImpl(new URL(`workers/${encodeURIComponent(command)}`, this.backendBaseUrl), {
      headers: this.backendHeaders({ json: true }),
      method: HTTP_METHOD.POST,
      body: JSON.stringify(payload),
      signal: options.signal,
    })
    const envelope = await response.json()
    if (!response.ok || envelope.success !== true) throw new Error(envelope.errors?.[0]?.message || `Worker operation returned HTTP ${response.status}`)
    return envelope.result
  }

  async persistFleetIntent(document, options = {}) {
    if (!this.usesBackend) {
      throw new Error("Fleet intent persistence requires a protected backend")
    }
    const response = await this.fetchImpl(new URL("intent", this.backendBaseUrl), {
      body: JSON.stringify({
        document,
        expectedRevision: document.revision,
      }),
      headers: this.backendHeaders({ json: true }),
      method: HTTP_METHOD.PUT,
      signal: options.signal,
    })
    const envelope = await response.json()
    if (response.status === 409 && envelope.result) {
      throw new FleetIntentApiConflictError(
        envelope.errors?.[0]?.message || "Fleet intent changed in another dashboard window",
        envelope.result,
      )
    }
    if (!response.ok || envelope.success !== true) {
      throw new Error(envelope.errors?.[0]?.message || `Fleet intent persistence returned HTTP ${response.status}`)
    }
    return envelope.result
  }

  async loadOperationActivity(options = {}) {
    if (!this.usesBackend) {
      throw new Error("Operation history requires a protected backend")
    }
    const response = await this.fetchImpl(new URL("activity", this.backendBaseUrl), {
      headers: this.backendHeaders(),
      signal: options.signal,
    })
    const envelope = await response.json()
    if (!response.ok || envelope.success !== true) {
      throw new Error(envelope.errors?.[0]?.message || `Operation history returned HTTP ${response.status}`)
    }
    return envelope.result
  }

  async appendOperationActivity(entry, options = {}) {
    const document = await this.persistOperationActivity(entry, HTTP_METHOD.POST, options)
    this.executionId = entry.id
    return document
  }

  async finalizeOperationActivity(entry, options = {}) {
    const document = await this.persistOperationActivity(entry, HTTP_METHOD.PATCH, options)
    if (this.executionId === entry.id) this.executionId = null
    return document
  }

  async persistOperationActivity(entry, method, options = {}) {
    if (!this.usesBackend) {
      throw new Error("Operation history requires a protected backend")
    }
    const response = await this.fetchImpl(new URL("activity", this.backendBaseUrl), {
      body: JSON.stringify({ entry }),
      headers: {
        ...this.backendHeaders({ json: true }),
        ...(!this.usesBroker && method === HTTP_METHOD.PATCH && this.executionId ? { "X-Fleet-Execution": this.executionId } : {}),
      },
      method,
      signal: options.signal,
    })
    const envelope = await response.json()
    if (!response.ok || envelope.success !== true) {
      throw new Error(envelope.errors?.[0]?.message || `Operation history persistence returned HTTP ${response.status}`)
    }
    return envelope.result
  }

  startSessionMonitor(handlers = {}) {
    if (!this.usesBroker) return () => {}
    const controller = new AbortController()
    const retryMs = Number.isFinite(handlers.retryMs) && handlers.retryMs >= 0
      ? handlers.retryMs
      : SESSION_MONITOR_RETRY_MS
    let activeReader = null
    let connected = null
    const updateConnection = (next) => {
      if (connected === next) return
      connected = next
      if (next) handlers.onConnected?.()
      else handlers.onDisconnected?.()
    }
    const monitor = async () => {
      while (!controller.signal.aborted) {
        try {
          const response = await this.fetchImpl(new URL("liveness", this.backendBaseUrl), {
            headers: {
              Accept: "text/event-stream",
              [BROKER_SESSION_HEADER]: this.brokerSecret,
            },
            signal: controller.signal,
          })
          if (!response.ok || !response.body) {
            throw new Error(`Session liveness returned HTTP ${response.status}`)
          }
          updateConnection(true)
          activeReader = response.body.getReader()
          while (!controller.signal.aborted) {
            const { done } = await activeReader.read()
            if (done) break
          }
        } catch {
          if (controller.signal.aborted) return
        } finally {
          activeReader = null
        }
        if (controller.signal.aborted) return
        updateConnection(false)
        await abortableDelay(retryMs, controller.signal)
      }
    }
    void monitor()
    return () => {
      controller.abort()
      if (activeReader) void activeReader.cancel().catch(() => {})
    }
  }

  async list(path, options = {}) {
    const perPage = options.perPage || DEFAULT_PAGE_SIZE
    const url = resolveCloudflareApiUrl(path)
    const combined = []
    let page = 1
    let totalPages = 1

    do {
      url.searchParams.set("page", String(page))
      url.searchParams.set("per_page", String(perPage))
      const response = await this.request(apiRelativeUrl(url), {
        signal: options.signal,
      })

      if (!Array.isArray(response.result)) {
        throw new CloudflareApiError(`Expected an array from GET ${url.pathname}`, {
          method: HTTP_METHOD.GET,
          path: url.pathname,
          status: response.status,
        })
      }

      combined.push(...response.result)
      totalPages = response.resultInfo?.total_pages || (response.result.length < perPage ? page : page + 1)
      page += 1
    } while (page <= totalPages)

    return combined
  }

  listZones(options = {}) {
    const accountId = encodeURIComponent(this.accountId)
    return this.list(`zones?account.id=${accountId}`, {
      perPage: ZONE_PAGE_SIZE,
      signal: options.signal,
    })
  }

  listEmailAddresses(options = {}) {
    return this.list(`accounts/${encodeURIComponent(this.accountId)}/email/routing/addresses`, {
      signal: options.signal,
    })
  }

  async getZoneSetting(zoneId, settingId, options = {}) {
    const response = await this.request(
      `zones/${encodeURIComponent(zoneId)}/settings/${encodeURIComponent(settingId)}`,
      {
        signal: options.signal,
      },
    )
    return response.result
  }

  async getDnsRecord(zoneId, recordId, options = {}) {
    const response = await this.request(
      `zones/${encodeURIComponent(zoneId)}/dns_records/${encodeURIComponent(recordId)}`,
      {
        signal: options.signal,
      },
    )
    return response.result
  }

  updateZoneSetting(zoneId, settingId, value, options = {}) {
    return this.request(`zones/${zoneId}/settings/${encodeURIComponent(settingId)}`, {
      method: HTTP_METHOD.PATCH,
      body: { value },
      signal: options.signal,
    })
  }

  executeOperation(operation, options = {}) {
    return this.request(operation.path, {
      method: operation.method,
      body: operation.body,
      signal: options.signal,
    })
  }
}

export function serializeApiError(error) {
  if (!(error instanceof CloudflareApiError)) {
    return {
      message: error instanceof Error ? error.message : String(error),
      status: null,
      errors: [],
    }
  }

  return {
    message: error.message,
    status: error.status,
    errors: error.errors,
    messages: error.messages,
    path: error.path,
    method: error.method,
  }
}
