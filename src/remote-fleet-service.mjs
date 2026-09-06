import { selectFleetBackend, hostedCredentialPresence } from "./backend-selection.mjs"
import { FleetConfigurationError } from "./cli-contract.mjs"
import { FLEET_COMMAND_VERSION, fleetCommandIsReadOnly } from "./fleet-command.mjs"
import { AlignmentPlanChangedError } from "./write-executor.mjs"

const RESPONSE_LIMIT_BYTES = 8 * 1024 * 1024
const REQUEST_TIMEOUT_MS = 110000
function wireSelector(value) {
  const { kind: _kind, zoneIds, ...selector } = value
  return { ...selector, ...(zoneIds ? { zoneIds } : {}) }
}

function accessHeaders(environment) {
  const present = hostedCredentialPresence(environment)
  if (present.accessToken && (present.clientId || present.clientSecret)) throw new FleetConfigurationError("Select one Fleet Access credential method")
  const headers = { Accept: "application/json", "Content-Type": "application/json" }
  if (present.clientId && present.clientSecret) {
    headers["CF-Access-Client-Id"] = environment.CLOUDFLARE_FLEET_ACCESS_CLIENT_ID
    headers["CF-Access-Client-Secret"] = environment.CLOUDFLARE_FLEET_ACCESS_CLIENT_SECRET
  } else if (present.accessToken && !present.clientId && !present.clientSecret) {
    headers["CF-Access-Token"] = environment.CLOUDFLARE_FLEET_ACCESS_TOKEN
  } else throw new FleetConfigurationError("Hosted Fleet requires an Access service credential pair or CLOUDFLARE_FLEET_ACCESS_TOKEN; no local fallback is permitted")
  return headers
}

export function createRemoteFleetService(options = {}) {
  const environment = options.environment || process.env
  const backend = selectFleetBackend(options)
  if (backend.kind !== "hosted") throw new FleetConfigurationError("Hosted Fleet backend is not selected")
  const headers = accessHeaders(environment)
  const fetchImpl = options.fetchImpl || globalThis.fetch
  async function command(name, input = {}, commandOptions = {}) {
    commandOptions.signal?.throwIfAborted()
    let response
    try {
      response = await fetchImpl(new URL("/api/commands", backend.endpoint), {
        method: "POST", headers, redirect: "error",
        body: JSON.stringify({ version: FLEET_COMMAND_VERSION, accountId: backend.accountId, command: name, input }),
        signal: commandOptions.signal
          ? AbortSignal.any([commandOptions.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
          : AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
    } catch {
      throw new Error(fleetCommandIsReadOnly(name)
        ? "Hosted Fleet could not be reached or Access redirected the request; check authentication. No local fallback was used"
        : "Hosted Fleet write outcome is unknown after a connection failure; inspect hosted activity before taking further action. The request was not retried")
    }
    if ([301, 302, 303, 307, 308, 401, 403].includes(response.status)) {
      await response.body?.cancel()
      throw new Error("Hosted Fleet denied access; check the application-scoped credential and write policy")
    }
    if (!response.headers.get("Content-Type")?.includes("application/json")) {
      await response.body?.cancel()
      throw new Error("Hosted Fleet returned an unexpected response; check the endpoint, Access login, and deployed command API")
    }
    const reader = response.body.getReader()
    const chunks = []
    let size = 0
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > RESPONSE_LIMIT_BYTES) {
        await reader.cancel()
        throw new Error("Hosted Fleet response exceeded the bounded client limit")
      }
      chunks.push(value)
    }
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
    let envelope
    try { envelope = JSON.parse(new TextDecoder().decode(bytes)) } catch { throw new Error("Hosted Fleet returned invalid JSON") }
    if (!response.ok || envelope.success !== true) {
      if (envelope.error?.name === "AlignmentPlanChangedError") throw new AlignmentPlanChangedError(input.planDigest, envelope.error.actualDigest || null)
      throw new Error(`Hosted Fleet command failed (HTTP ${response.status}): ${envelope.errors?.[0]?.message || "Inspect hosted activity and prepare a fresh plan"}`)
    }
    if (envelope.accountId !== backend.accountId || envelope.version !== FLEET_COMMAND_VERSION) throw new Error("Hosted Fleet response account or protocol version does not match the selected backend")
    return envelope.result
  }
  return Object.freeze({
    accountId: backend.accountId, backend, stateFile: null, policyFile: null,
    status: (context) => command("status", {}, context),
    audit: ({ deep = false, ...context } = {}) => command("audit", { deep }, context),
    getIntent: () => command("intent-get"),
    planIntent: (document, context) => command("intent-plan", { document }, context),
    applyIntent: (document, planDigest, context) => command("intent-apply", { document, planDigest }, context),
    listAlignments: (context) => command("alignment-list", {}, context),
    planAlignment: (selector, context) => command("alignment-plan", { selector: wireSelector(selector) }, context),
    applyAlignment: (selector, planDigest, context) => command("alignment-apply", { selector: wireSelector(selector), planDigest }, context),
    planAlignments: (selectors, context) => command("alignments-plan", { selectors: selectors.map(wireSelector) }, context),
    applyAlignments: (selectors, planDigest, context) => command("alignments-apply", { selectors: selectors.map(wireSelector), planDigest }, context),
    planChange: (change, context) => command("change-plan", { change }, context),
    applyChange: (change, planDigest, context) => command("change-apply", { change, planDigest }, context),
    listActivity: () => command("activity-list"),
    planActivityUndo: (activityId, context) => command("undo-plan", { activityId }, context),
    applyActivityUndo: (activityId, planDigest, context) => command("undo-apply", { activityId, planDigest }, context),
    getState: (archiveId) => command("state-get", archiveId ? { archiveId } : {}),
    planState: (input) => command("state-plan", input),
    applyState: (input, planDigest) => command("state-apply", { ...input, planDigest }),
    planRecovery: (input) => command("recovery-plan", input),
    applyRecovery: (input, planDigest) => command("recovery-apply", { ...input, planDigest }),
    workers: {
      inspect: (input, context) => command("worker-inspect", input, context),
      history: (input, context) => command("worker-history", input, context),
      record: (input, context) => command("worker-record", input, context),
      verify: (input, context) => command("worker-verify", input, context),
      planIntent: (input, context) => command("worker-intent-plan", input, context),
      applyIntent: (input, planDigest, context) => command("worker-intent-apply", { input, planDigest }, context),
      planSchedules: (input, context) => command("worker-schedules-plan", input, context),
      applySchedules: (input, planDigest, context) => command("worker-schedules-apply", { input, planDigest }, context),
      planUndo: (activityId, context) => command("worker-undo-plan", { activityId }, context),
      applyUndo: (activityId, planDigest, context) => command("worker-undo-apply", { activityId, planDigest }, context),
    },
  })
}
