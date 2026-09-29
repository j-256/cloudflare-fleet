import { selectFleetBackend, hostedCredentialPresence } from "./backend-selection.mjs"
import { FleetConfigurationError } from "./cli-contract.mjs"
import { FLEET_COMMAND_VERSION, fleetCommandIsReadOnly } from "./fleet-command.mjs"
import { AlignmentPlanChangedError } from "./write-executor.mjs"
import {
  commandDiagnosticsSchema,
  HOSTED_TRANSPORT_DIAGNOSTIC_KIND,
  HOSTED_TRANSPORT_REASON,
  HOSTED_TRANSPORT_STAGE,
} from "./interface-schemas.mjs"

const RESPONSE_LIMIT_BYTES = 8 * 1024 * 1024
const REQUEST_TIMEOUT_MS = 110000
const PRE_CONFIRMATION_REPLAN_MAX_ATTEMPTS = 2
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

function transportDescription(reason) {
  return {
    [HOSTED_TRANSPORT_REASON.ACCESS_DENIED]: "access was denied",
    [HOSTED_TRANSPORT_REASON.CANCELLED]: "the request was cancelled",
    [HOSTED_TRANSPORT_REASON.NETWORK]: "the network connection failed",
    [HOSTED_TRANSPORT_REASON.REDIRECT]: "the request was redirected",
    [HOSTED_TRANSPORT_REASON.TIMEOUT]: "the request timed out",
    [HOSTED_TRANSPORT_REASON.UNEXPECTED_RESPONSE]: "the endpoint returned an unexpected response",
  }[reason]
}

class HostedFleetTransportError extends Error {
  constructor(options) {
    const description = transportDescription(options.reason)
    const guidance = options.stage === HOSTED_TRANSPORT_STAGE.PRE_CONFIRMATION_REPLAN
      ? "The failure occurred during the read-only pre-confirmation replan; no confirmation was requested and no Cloudflare write was attempted"
      : options.readOnly
        ? "This read-only command made no changes; no local fallback was used"
        : "Write outcome may be unknown; inspect hosted activity and affected resources before taking further action. The request was not retried"
    const retry = options.retried ? " The read-only replan was retried once." : "."
    super(`Hosted Fleet request failed because ${description}. ${guidance}${retry}`)
    this.name = "HostedFleetTransportError"
    this.diagnostics = {
      attempts: options.attempts,
      command: options.command,
      httpStatus: options.httpStatus ?? null,
      kind: HOSTED_TRANSPORT_DIAGNOSTIC_KIND,
      readOnly: options.readOnly,
      reason: options.reason,
      retried: options.retried,
      stage: options.stage,
    }
  }
}

function requestFailureReason(error, callerSignal, timeoutSignal) {
  if (callerSignal?.aborted) {
    return callerSignal.reason?.name === "TimeoutError"
      ? HOSTED_TRANSPORT_REASON.TIMEOUT
      : HOSTED_TRANSPORT_REASON.CANCELLED
  }
  if (timeoutSignal?.aborted || error?.name === "TimeoutError") return HOSTED_TRANSPORT_REASON.TIMEOUT
  if (error?.name === "AbortError") return HOSTED_TRANSPORT_REASON.CANCELLED
  return HOSTED_TRANSPORT_REASON.NETWORK
}

async function cancelResponse(response) {
  try { await response.body?.cancel() } catch {}
}

export function createRemoteFleetService(options = {}) {
  const environment = options.environment || process.env
  const backend = selectFleetBackend(options)
  if (backend.kind !== "hosted") throw new FleetConfigurationError("Hosted Fleet backend is not selected")
  const headers = accessHeaders(environment)
  const fetchImpl = options.fetchImpl || globalThis.fetch
  async function command(name, input = {}, commandOptions = {}) {
    const readOnly = fleetCommandIsReadOnly(name)
    const stage = readOnly && Object.values(HOSTED_TRANSPORT_STAGE).includes(commandOptions.transportStage)
      ? commandOptions.transportStage
      : HOSTED_TRANSPORT_STAGE.COMMAND
    const retryNetworkFailure = readOnly
      && stage === HOSTED_TRANSPORT_STAGE.PRE_CONFIRMATION_REPLAN
      && commandOptions.retryReadOnlyNetworkFailure === true
    const maxAttempts = retryNetworkFailure ? PRE_CONFIRMATION_REPLAN_MAX_ATTEMPTS : 1
    let attempts = 0
    let response
    let envelope
    while (attempts < maxAttempts) {
      if (commandOptions.signal?.aborted) {
        throw new HostedFleetTransportError({
          attempts,
          command: name,
          readOnly,
          reason: requestFailureReason(null, commandOptions.signal),
          retried: attempts > 1,
          stage,
        })
      }
      const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      const signal = commandOptions.signal
        ? AbortSignal.any([commandOptions.signal, timeoutSignal])
        : timeoutSignal
      attempts += 1
      try {
        response = await fetchImpl(new URL("/api/commands", backend.endpoint), {
          method: "POST", headers, redirect: "manual",
          body: JSON.stringify({ version: FLEET_COMMAND_VERSION, accountId: backend.accountId, command: name, input }),
          signal,
        })
        if (response.status >= 300 && response.status < 400) {
          await cancelResponse(response)
          throw new HostedFleetTransportError({ attempts, command: name, httpStatus: response.status, readOnly, reason: HOSTED_TRANSPORT_REASON.REDIRECT, retried: attempts > 1, stage })
        }
        if ([401, 403].includes(response.status)) {
          await cancelResponse(response)
          throw new HostedFleetTransportError({ attempts, command: name, httpStatus: response.status, readOnly, reason: HOSTED_TRANSPORT_REASON.ACCESS_DENIED, retried: attempts > 1, stage })
        }
        if (!response.headers.get("Content-Type")?.includes("application/json") || !response.body) {
          await cancelResponse(response)
          throw new HostedFleetTransportError({ attempts, command: name, httpStatus: response.status, readOnly, reason: HOSTED_TRANSPORT_REASON.UNEXPECTED_RESPONSE, retried: attempts > 1, stage })
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
            throw new HostedFleetTransportError({ attempts, command: name, httpStatus: response.status, readOnly, reason: HOSTED_TRANSPORT_REASON.UNEXPECTED_RESPONSE, retried: attempts > 1, stage })
          }
          chunks.push(value)
        }
        const bytes = new Uint8Array(size)
        let offset = 0
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
        try {
          envelope = JSON.parse(new TextDecoder().decode(bytes))
        } catch {
          throw new HostedFleetTransportError({ attempts, command: name, httpStatus: response.status, readOnly, reason: HOSTED_TRANSPORT_REASON.UNEXPECTED_RESPONSE, retried: attempts > 1, stage })
        }
        break
      } catch (error) {
        if (error instanceof HostedFleetTransportError) throw error
        const reason = requestFailureReason(error, commandOptions.signal, timeoutSignal)
        if (reason === HOSTED_TRANSPORT_REASON.NETWORK && attempts < maxAttempts) continue
        throw new HostedFleetTransportError({ attempts, command: name, readOnly, reason, retried: attempts > 1, stage })
      }
    }
    if (!response.ok || envelope.success !== true) {
      if (response.status === 400 && name.startsWith("retrieval-")) throw new TypeError(envelope.errors?.[0]?.message || "Invalid Fleet retrieval query")
      if (envelope.error?.name === "AlignmentPlanChangedError") throw new AlignmentPlanChangedError(input.planDigest, envelope.error.actualDigest || null)
      const diagnostics = commandDiagnosticsSchema.safeParse(envelope.error?.diagnostics)
      if (envelope.error?.name === "FleetCommandError" && diagnostics.success) {
        const error = new Error(`Hosted Fleet command failed (HTTP ${response.status}): ${envelope.errors?.[0]?.message || "Inspect hosted diagnostics"}`)
        error.name = "FleetCommandError"
        error.diagnostics = diagnostics.data
        throw error
      }
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
    planFacetIntent: (request, context) => command("facet-intent-plan", { request }, context),
    applyFacetIntent: (request, planDigest, context) => command("facet-intent-apply", { request, planDigest }, context),
    listAlignments: (context) => command("alignment-list", {}, context),
    planAlignment: (selector, context) => command("alignment-plan", { selector: wireSelector(selector) }, context),
    applyAlignment: (selector, planDigest, context) => command("alignment-apply", { selector: wireSelector(selector), planDigest }, context),
    planAlignments: (selectors, context) => command("alignments-plan", { selectors: selectors.map(wireSelector) }, context),
    applyAlignments: (selectors, planDigest, context) => command("alignments-apply", { selectors: selectors.map(wireSelector), planDigest }, context),
    planChange: (change, context) => command("change-plan", { change }, context),
    applyChange: (change, planDigest, context) => command("change-apply", { change, planDigest }, context),
    planChanges: (changes, context) => command("changes-plan", { changes }, context),
    applyChanges: (changes, planDigest, context) => command("changes-apply", { changes, planDigest }, context),
    listActivity: () => command("activity-list"),
    retrieve: (kind, input, context) => command(`retrieval-${kind}`, input, context),
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
