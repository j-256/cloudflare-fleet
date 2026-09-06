const MAX_UPSTREAM_PATH_LENGTH = 1024
const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"])
const STAGES = new Set(["account-surfaces", "surfaces", "rulesets", "writes", "verification"])
const MAX_ERROR_FRAMES = 8
const ERROR_NAMES = new Set(["Error", "CloudflareApiError", "TypeError", "RangeError", "AbortError", "TimeoutError"])

function safeErrorLocation(error) {
  const frames = typeof error?.stack === "string"
    ? error.stack.split("\n").slice(1).flatMap((line) => {
        const match = line.match(/(?:^|[/( ])([A-Za-z0-9_.-]+\.(?:m?js|cjs)):(\d+):(\d+)\)?$/)
        return match ? [{ file: match[1], line: Number(match[2]), column: Number(match[3]) }] : []
      }).slice(0, MAX_ERROR_FRAMES)
    : []
  return { name: ERROR_NAMES.has(error?.name) ? error.name : "Error", frames }
}

export function redactDiagnostics(value, secrets) {
  if (typeof value === "string") {
    for (const secret of secrets) {
      if (typeof secret === "string" && secret.length > 0) value = value.replaceAll(secret, "[redacted]")
    }
    return value
  }
  if (Array.isArray(value)) return value.map((entry) => redactDiagnostics(entry, secrets))
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redactDiagnostics(entry, secrets)]))
  }
  return value
}

export function safeUpstreamDiagnostic(error) {
  if (error?.name !== "CloudflareApiError") return null
  const path = typeof error.path === "string" ? error.path.split(/[?#]/, 1)[0] : ""
  return {
    abortKind: error.aborted ? error.abortKind : null,
    elapsedMs: Number.isFinite(error.elapsedMs) ? Math.max(0, Math.round(error.elapsedMs)) : null,
    method: METHODS.has(error.method) ? error.method : null,
    path: /^\/client\/v4\/(zones|accounts)(\/|$)/.test(path)
      ? path.replace(/[\r\n]/g, "").slice(0, MAX_UPSTREAM_PATH_LENGTH) : null,
    status: Number.isInteger(error.status) ? error.status : null,
  }
}

export function safeCommandProgress(progress) {
  if (!STAGES.has(progress?.stage)) return null
  return {
    stage: progress.stage,
    completed: Number.isInteger(progress.completed) ? progress.completed : null,
    total: Number.isInteger(progress.total) ? progress.total : null,
  }
}

export class FleetCommandError extends Error {
  constructor(error, options) {
    const upstream = safeUpstreamDiagnostic(error)
    const kind = options.signal.aborted
      ? options.signal.reason?.name === "TimeoutError" ? "command-timeout" : "cancelled"
      : upstream?.abortKind === "timeout" ? "upstream-timeout"
        : upstream?.abortKind === "cancelled" ? "cancelled"
          : upstream ? "upstream-error" : "internal-error"
    const description = {
      "command-timeout": "Fleet command deadline exceeded",
      "upstream-timeout": "Cloudflare API request timed out",
      cancelled: "Fleet command was cancelled",
      "upstream-error": "Cloudflare API request failed",
      "internal-error": "Hosted Fleet command failed",
    }[kind]
    const guidance = options.readOnly
      ? "This read-only command made no changes; retry the read after checking the diagnostics"
      : "Write outcome may be unknown; inspect hosted activity and affected resources before taking further action. The command was not retried"
    super(`${description}. ${guidance}`, { cause: error })
    this.name = "FleetCommandError"
    this.diagnostics = {
      command: options.command,
      deadlineMs: options.deadlineMs,
      elapsedMs: Math.max(0, Math.round(options.elapsedMs)),
      error: safeErrorLocation(error),
      kind,
      progress: safeCommandProgress(options.progress),
      readOnly: options.readOnly,
      upstream,
    }
    this.status = kind.endsWith("timeout") ? 504 : kind === "cancelled" ? 408 : upstream ? 502 : 500
  }
}
