import { CloudflareApi, resolveCloudflareApiUrl } from "../api.mjs"
import { authorizeCloudflareRequest } from "./proxy-policy.mjs"
import { AlignmentPlanChangedError } from "../write-executor.mjs"
import { prepareFleetIntentChange } from "../intent-plan.mjs"
import { createFleetService } from "../fleet-service.mjs"
import { createEmptyFleetPolicyConfiguration, normalizeFleetPolicyConfiguration } from "../fleet-policy.mjs"
import { loadInventory } from "../inventory.mjs"
import { buildFleetAudit } from "../audit-report.mjs"
import { collectDeepAuditFindings } from "../audit-deep.mjs"
import { hostedWorkerStore } from "./worker-store.mjs"
import { hostedExecutionLock } from "./execution-lock.mjs"
import { hostedStateReconciliation } from "./state-reconciliation.mjs"
import { hostedActivityRecovery } from "./activity-recovery.mjs"
import {
  readHostedFleetIntent, persistHostedFleetIntent, readHostedOperationActivity,
  appendHostedOperationActivity, finalizeHostedOperationActivity,
} from "./d1-store.mjs"
const UPSTREAM_TIMEOUT_MS = 45000

export function createHostedFleetService(env, options = {}) {
  const accountId = env.FLEET_ACCOUNT_ID
  const db = env.FLEET_DB
  const lock = hostedExecutionLock(db, accountId)
  const api = options.api || new CloudflareApi({ accountId, apiToken: env.CLOUDFLARE_API_TOKEN })
  const policy = env.FLEET_POLICY_JSON
    ? normalizeFleetPolicyConfiguration(JSON.parse(env.FLEET_POLICY_JSON))
    : createEmptyFleetPolicyConfiguration()
  let owner = null
  const verifiedZones = new Set()
  const request = api.request.bind(api)
  api.request = async (path, requestOptions = {}) => {
    const url = resolveCloudflareApiUrl(path)
    const parts = url.pathname.slice("/client/v4/".length).split("/").map(decodeURIComponent)
    const method = requestOptions.method || "GET"
    if (parts[0] === "accounts" && parts[1] !== accountId) throw new TypeError("Cloudflare account path is outside the hosted account")
    if (parts[0] === "zones" && !parts[1] && url.searchParams.get("account.id") !== accountId) throw new TypeError("Cloudflare zone listing requires the hosted account")
    if (parts[0] === "zones" && parts[1] && !verifiedZones.has(parts[1])) {
      const membership = await request(`zones/${encodeURIComponent(parts[1])}`, { signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) })
      if (membership.result?.account?.id !== accountId) throw new TypeError("Cloudflare zone is outside the hosted account")
      verifiedZones.add(parts[1])
    }
    const telemetryRead = method === "POST" && url.pathname === `/client/v4/accounts/${encodeURIComponent(accountId)}/workers/observability/telemetry/query` && !url.search
    if (method !== "GET" && !telemetryRead) {
      const scheduleWrite = method === "PUT" && parts.length === 6
        && parts[0] === "accounts" && parts[1] === accountId && parts[2] === "workers"
        && parts[3] === "scripts" && /^[A-Za-z0-9_-]+$/.test(parts[4]) && parts[5] === "schedules" && !url.search
      if (!owner || !scheduleWrite && !authorizeCloudflareRequest(method, url, accountId).allowed) throw new TypeError("Cloudflare write is outside the reviewed hosted capability")
    }
    if (owner) await lock.renew(owner)
    return request(path, {
      ...requestOptions,
      signal: requestOptions.signal
        ? AbortSignal.any([requestOptions.signal, AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)])
        : AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    })
  }
  const withWriteLock = (operation) => lock.withWriteLock(async (leaseOwner) => {
    owner = leaseOwner
    try { return await operation() } finally { owner = null }
  })
  const readState = async () => ({
    accountId, schemaVersion: 1,
    intent: await readHostedFleetIntent(db, accountId),
    activity: await readHostedOperationActivity(db, accountId),
  })
  const service = createFleetService({
    api, accountId, stateFile: "hosted-d1", withWriteLock,
    workerStore: hostedWorkerStore(db, accountId),
    readState,
    readPolicy: async () => policy,
    readIntent: () => readHostedFleetIntent(db, accountId),
    prepareIntentChange: (account, current, document, context) => {
      if (document.revision !== current.revision) throw new AlignmentPlanChangedError(null, null)
      return prepareFleetIntentChange(account, current, document, context)
    },
    persistIntent: async (_file, _account, revision, document) => {
      await lock.renew(owner)
      return persistHostedFleetIntent(db, accountId, revision, document)
    },
    readActivity: () => readHostedOperationActivity(db, accountId),
    appendActivity: async (_file, _account, entry, guard = {}) => {
      await lock.renew(owner)
      if (guard.expectedIntentRevision !== undefined) {
        const intent = await readHostedFleetIntent(db, accountId)
        if (intent.revision !== guard.expectedIntentRevision) throw new Error("Fleet intent changed before execution")
      }
      return appendHostedOperationActivity(db, accountId, entry)
    },
    finalizeActivity: async (_file, _account, entry) => {
      await lock.renew(owner)
      return finalizeHostedOperationActivity(db, accountId, entry)
    },
  })
  return {
    ...service,
    ...hostedStateReconciliation(db, accountId),
    ...hostedActivityRecovery(db, accountId),
    async status() {
      await db.batch([
        db.prepare("SELECT revision FROM fleet_intent WHERE account_id = ?").bind(accountId),
        db.prepare("SELECT revision FROM activity_meta WHERE account_id = ?").bind(accountId),
        db.prepare("SELECT revision FROM worker_diagnostics WHERE account_id = ?").bind(accountId),
        db.prepare("SELECT owner FROM worker_execution_lock WHERE account_id = ?").bind(accountId),
        db.prepare("SELECT id FROM state_reconciliation WHERE account_id = ? LIMIT 1").bind(accountId),
      ])
      return { storage: "d1", schema: "ready" }
    },
    async audit(commandOptions = {}) {
      const [state, inventory] = await Promise.all([
        readState(), loadInventory(api, commandOptions),
      ])
      const deepFindings = commandOptions.deep
        ? await collectDeepAuditFindings(api, inventory, commandOptions)
        : []
      return buildFleetAudit(inventory, {
        intent: state.intent, policyConfiguration: policy,
        now: Date.now(), deep: commandOptions.deep === true, deepFindings,
      })
    },
  }
}
