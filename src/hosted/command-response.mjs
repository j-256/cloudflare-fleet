import { redactDiagnostics } from "../command-diagnostics.mjs"
import { jsonResponse } from "./http.mjs"

const MAX_LOGGED_FAILURES = 50

export function commandFailureResponse(error, requestId, env) {
  const diagnostics = redactDiagnostics({ ...error.diagnostics, requestId }, [env.CLOUDFLARE_API_TOKEN])
  const message = `${error.message}. Request ID: ${requestId}`
  console.error({ event: "fleet.command.failed", ...diagnostics })
  return jsonResponse({
    success: false, result: null,
    errors: [{ message }],
    error: { name: error.name, diagnostics },
  }, error.status)
}

export function withIncompleteInventoryDiagnostics(result, context, env) {
  const coverage = [result.coverage, ...(result.alignments || []).map((entry) => entry.coverage), ...(result.candidates || []).map((entry) => entry.coverage)]
    .filter((entry) => entry && !entry.complete)
  if (coverage.length === 0) return result
  const diagnostics = { ...context, kind: "incomplete-inventory" }
  const failures = coverage.flatMap((entry) => entry.failures).slice(0, MAX_LOGGED_FAILURES)
  console.warn(redactDiagnostics({
    event: "fleet.command.incomplete-inventory", ...diagnostics, failures,
    truncated: coverage.some((entry) => entry.truncated)
      || coverage.reduce((total, entry) => total + entry.failureCount, 0) > failures.length,
  }, [env.CLOUDFLARE_API_TOKEN]))
  return { ...result, diagnostics }
}
