const BODY_LIMIT_BYTES = 2 * 1024 * 1024
const CONTENT_SECURITY_POLICY = "default-src 'none'; connect-src 'self' https://api.cloudflare.com; script-src 'self'; style-src 'self'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'"

const SECURITY_HEADERS = Object.freeze({
  "Content-Security-Policy": CONTENT_SECURITY_POLICY,
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy": "camera=(), geolocation=(), microphone=(), payment=(), usb=()",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
})

export class RequestBodyTooLargeError extends Error {
  constructor() {
    super("Request body is too large")
    this.name = "RequestBodyTooLargeError"
  }
}

export class InvalidJsonBodyError extends Error {
  constructor(message = "Request body is not valid JSON") {
    super(message)
    this.name = "InvalidJsonBodyError"
  }
}

export function withSecurityHeaders(response, options = {}) {
  const headers = new Headers(response.headers)
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    headers.set(name, value)
  }
  headers.set("Cache-Control", options.cacheControl || "no-store")
  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  })
}

export function jsonResponse(body, status = 200) {
  return withSecurityHeaders(new Response(JSON.stringify(body), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
    },
    status,
  }))
}

export function errorResponse(status, message) {
  return jsonResponse({
    errors: [{ message }],
    messages: [],
    result: null,
    success: false,
  }, status)
}

export function safeScriptJson(value) {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029")
}

export function javascriptResponse(source, status = 200) {
  return withSecurityHeaders(new Response(source, {
    headers: {
      "Content-Type": "text/javascript; charset=utf-8",
    },
    status,
  }))
}

export async function readJsonBody(request) {
  const declaredLength = Number(request.headers.get("Content-Length"))
  if (Number.isFinite(declaredLength) && declaredLength > BODY_LIMIT_BYTES) {
    throw new RequestBodyTooLargeError()
  }
  const body = await request.arrayBuffer()
  if (body.byteLength > BODY_LIMIT_BYTES) throw new RequestBodyTooLargeError()
  try {
    return JSON.parse(new TextDecoder().decode(body))
  } catch {
    throw new InvalidJsonBodyError()
  }
}

export async function readBoundedBody(request) {
  const declaredLength = Number(request.headers.get("Content-Length"))
  if (Number.isFinite(declaredLength) && declaredLength > BODY_LIMIT_BYTES) {
    throw new RequestBodyTooLargeError()
  }
  const body = await request.arrayBuffer()
  if (body.byteLength > BODY_LIMIT_BYTES) throw new RequestBodyTooLargeError()
  return body
}

export function mutationIsSameOrigin(request) {
  const requestUrl = new URL(request.url)
  const origin = request.headers.get("Origin")
  if (origin && origin !== requestUrl.origin) return false
  const fetchSite = request.headers.get("Sec-Fetch-Site")
  return !fetchSite || fetchSite === "same-origin"
}
