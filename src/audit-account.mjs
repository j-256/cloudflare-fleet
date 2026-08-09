import {
  auditFinding,
  FLEET_AUDIT_SEVERITY,
} from "./audit-report.mjs"

const ACCOUNT_READ_CONCURRENCY = 8
const CURSOR_PAGE_SIZE = 50
const D1_METRICS_WINDOW_MS = 30 * 24 * 60 * 60 * 1000
const PAGES_DEPLOYMENT_PAGE_SIZE = 25
const PAGES_STALE_REVIEW_MS = 365 * 24 * 60 * 60 * 1000
const REGISTRAR_EXPIRY_WARNING_MS = 90 * 24 * 60 * 60 * 1000
const WORKER_ERROR_RATE_WARNING = 0.05
const WORKER_ERROR_REQUEST_MINIMUM = 10
const WORKER_METRICS_WINDOW_MS = 7 * 24 * 60 * 60 * 1000
const WORKER_READ_ATTEMPTS = 2

const WORKER_METRICS_QUERY = `
  query WorkerTraffic($accountTag: string, $start: string, $end: string) {
    viewer {
      accounts(filter: { accountTag: $accountTag }) {
        rows: workersInvocationsAdaptive(
          limit: 1000
          filter: { datetime_geq: $start, datetime_lt: $end }
        ) {
          sum { requests errors }
          dimensions { scriptName status }
        }
      }
    }
  }
`

const D1_METRICS_QUERY = `
  query D1Activity($accountTag: string, $start: Date, $end: Date) {
    viewer {
      accounts(filter: { accountTag: $accountTag }) {
        rows: d1AnalyticsAdaptiveGroups(
          limit: 10000
          filter: { date_geq: $start, date_leq: $end }
        ) {
          sum { readQueries writeQueries rowsRead rowsWritten }
          dimensions { databaseId }
        }
      }
    }
  }
`

const BINDING_TYPE = Object.freeze({
  D1: "d1",
  DURABLE_OBJECT: "durable_object_namespace",
  KV: "kv_namespace",
  R2: "r2_bucket",
  SERVICE: "service",
})

const REGISTRAR_CRITICAL_STATUS = new Set([
  "expired",
  "pending_delete",
  "redemption_period",
  "suspended",
])

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

async function safeRead(read) {
  try {
    return {
      error: null,
      ok: true,
      value: await read(),
    }
  } catch (error) {
    return {
      error: errorMessage(error),
      ok: false,
      value: null,
    }
  }
}

async function retryRead(read, attempts = WORKER_READ_ATTEMPTS) {
  let failure
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await read()
    } catch (error) {
      failure = error
    }
  }
  throw failure
}

async function mapPool(entries, worker, concurrency, onProgress) {
  const results = new Array(entries.length)
  let cursor = 0
  let completed = 0
  async function consume() {
    while (cursor < entries.length) {
      const index = cursor
      cursor += 1
      results[index] = await worker(entries[index], index)
      completed += 1
      onProgress?.({ completed, total: entries.length })
    }
  }
  const workerCount = Math.min(concurrency, entries.length)
  await Promise.all(Array.from({ length: workerCount }, consume))
  return results
}

async function listCursor(api, path) {
  const entries = []
  const seen = new Set()
  let cursor = ""
  do {
    const url = new URL(path, "https://api.cloudflare.com/client/v4/")
    url.searchParams.set("per_page", String(CURSOR_PAGE_SIZE))
    if (cursor) url.searchParams.set("cursor", cursor)
    const response = await api.request(
      `${url.pathname.replace("/client/v4/", "")}${url.search}`,
    )
    if (!Array.isArray(response.result)) {
      throw new TypeError(`Expected an array from GET ${url.pathname}`)
    }
    entries.push(...response.result)
    const nextCursor = response.resultInfo?.cursor || ""
    if (nextCursor && seen.has(nextCursor)) {
      throw new Error(`Cursor pagination repeated a cursor for ${url.pathname}`)
    }
    if (nextCursor) seen.add(nextCursor)
    cursor = nextCursor
  } while (cursor)
  return entries
}

function addReference(references, identifier, reference) {
  if (!identifier) return
  if (!references.has(identifier)) references.set(identifier, [])
  references.get(identifier).push(reference)
}

function addWorkerReference(references, script, kind, value) {
  addReference(references, script, { kind, value })
}

function zoneWorkerReferences(inventory) {
  const references = new Map()
  for (const zone of inventory.zones) {
    const routes = zone.surfaces?.["workers-routes"]?.ok
      ? zone.surfaces["workers-routes"].result
      : []
    for (const route of routes || []) {
      addWorkerReference(
        references,
        route.script,
        "zone-route",
        route.pattern || zone.meta.name,
      )
    }
    const rules = zone.surfaces?.["email-rules"]?.ok
      ? zone.surfaces["email-rules"].result
      : []
    for (const rule of rules || []) {
      for (const action of rule.actions || []) {
        if (action.type !== "worker") continue
        for (const script of action.value || []) {
          addWorkerReference(
            references,
            script,
            "email-route",
            `${zone.meta.name}:${rule.name || rule.id || "unnamed"}`,
          )
        }
      }
    }
  }
  return references
}

function pageConfigurations(project) {
  return [
    ["production", project.deployment_configs?.production],
    ["preview", project.deployment_configs?.preview],
  ].filter((entry) => entry[1] && typeof entry[1] === "object")
}

function safeBindingReference(source, scope, bindingName) {
  return {
    binding: bindingName || null,
    kind: source,
    source: scope,
  }
}

function collectBindingReferences(details, projects) {
  const resources = {
    d1: new Map(),
    kv: new Map(),
    r2: new Map(),
  }
  const workers = new Map()
  for (const detail of details) {
    const settings = detail.settings || {}
    for (const binding of settings.bindings || []) {
      const reference = safeBindingReference(
        "worker-binding",
        detail.script.id,
        binding.name,
      )
      if (binding.type === BINDING_TYPE.SERVICE) {
        addWorkerReference(
          workers,
          binding.service,
          "service-binding",
          `${detail.script.id}:${binding.name || "unnamed"}`,
        )
      } else if (binding.type === BINDING_TYPE.DURABLE_OBJECT) {
        addWorkerReference(
          workers,
          binding.script_name,
          "durable-object-binding",
          `${detail.script.id}:${binding.name || "unnamed"}`,
        )
      } else if (binding.type === BINDING_TYPE.KV) {
        addReference(resources.kv, binding.namespace_id, reference)
      } else if (binding.type === BINDING_TYPE.D1) {
        addReference(resources.d1, binding.database_id || binding.id, reference)
      } else if (binding.type === BINDING_TYPE.R2) {
        addReference(resources.r2, binding.bucket_name, reference)
      }
    }
    for (const consumer of settings.tail_consumers || []) {
      addWorkerReference(
        workers,
        consumer.service,
        "tail-consumer",
        detail.script.id,
      )
    }
  }
  for (const project of projects) {
    addWorkerReference(
      workers,
      project.production_script_name,
      "pages-production-script",
      project.name,
    )
    addWorkerReference(
      workers,
      project.preview_script_name,
      "pages-preview-script",
      project.name,
    )
    for (const [environment, configuration] of pageConfigurations(project)) {
      const source = `${project.name}:${environment}`
      for (const [bindingName, binding] of Object.entries(
        configuration.services || {},
      )) {
        addWorkerReference(
          workers,
          binding.service,
          "pages-service-binding",
          `${source}:${bindingName}`,
        )
      }
      for (const [bindingName, binding] of Object.entries(
        configuration.durable_object_namespaces || {},
      )) {
        addWorkerReference(
          workers,
          binding.script_name,
          "pages-durable-object-binding",
          `${source}:${bindingName}`,
        )
      }
      for (const [bindingName, binding] of Object.entries(
        configuration.kv_namespaces || {},
      )) {
        addReference(
          resources.kv,
          binding.namespace_id || binding.id,
          safeBindingReference("pages-binding", source, bindingName),
        )
      }
      for (const [bindingName, binding] of Object.entries(
        configuration.d1_databases || {},
      )) {
        addReference(
          resources.d1,
          binding.database_id || binding.id,
          safeBindingReference("pages-binding", source, bindingName),
        )
      }
      for (const [bindingName, binding] of Object.entries(
        configuration.r2_buckets || {},
      )) {
        addReference(
          resources.r2,
          binding.bucket_name || binding.name,
          safeBindingReference("pages-binding", source, bindingName),
        )
      }
    }
  }
  return { resources, workers }
}

function mergeReferences(target, source) {
  for (const [identifier, references] of source) {
    for (const reference of references) addReference(target, identifier, reference)
  }
}

function zoneDependencyReadsComplete(inventory) {
  return inventory.zones.every((zone) => (
    zone.surfaces?.["email-rules"]?.ok === true
      && zone.surfaces?.["workers-routes"]?.ok === true
  ))
}

async function readWorkerDetails(api, accountId, scripts, options) {
  return mapPool(
    scripts,
    async (script) => {
      try {
        const scriptId = encodeURIComponent(script.id)
        const [settings, subdomain, schedules] = await Promise.all([
          retryRead(() => api.request(
            `accounts/${accountId}/workers/scripts/${scriptId}/settings`,
          )),
          retryRead(() => api.request(
            `accounts/${accountId}/workers/scripts/${scriptId}/subdomain`,
          )),
          retryRead(() => api.request(
            `accounts/${accountId}/workers/scripts/${scriptId}/schedules`,
          )),
        ])
        const scheduleResult = schedules.result
        return {
          error: null,
          schedules: Array.isArray(scheduleResult)
            ? scheduleResult
            : scheduleResult?.schedules || [],
          script,
          settings: settings.result || {},
          workersDev: Boolean(subdomain.result?.enabled),
        }
      } catch (error) {
        return {
          error: errorMessage(error),
          schedules: [],
          script,
          settings: null,
          workersDev: null,
        }
      }
    },
    options.concurrency,
    (progress) => options.onProgress?.({
      ...progress,
      message: `Checking Worker dependencies ${progress.completed}/${progress.total}`,
      stage: "workers",
    }),
  )
}

async function readQueueConsumers(api, accountId, queues, options) {
  const results = await mapPool(
    queues,
    async (queue) => {
      const queueId = queue.queue_id || queue.id
      if (!queueId) {
        return {
          consumers: [],
          error: "Queue response did not include an identifier",
          queue,
        }
      }
      try {
        return {
          consumers: await retryRead(() => api.list(
            `accounts/${accountId}/queues/${encodeURIComponent(queueId)}/consumers`,
          )),
          error: null,
          queue,
        }
      } catch (error) {
        return {
          consumers: [],
          error: errorMessage(error),
          queue,
        }
      }
    },
    options.concurrency,
    (progress) => options.onProgress?.({
      ...progress,
      message: `Checking Queue consumers ${progress.completed}/${progress.total}`,
      stage: "queues",
    }),
  )
  return results
}

async function readPageDeployments(api, accountId, projects, options) {
  return mapPool(
    projects,
    async (project) => {
      if (!project.name) {
        return {
          deployments: [],
          error: "Pages project response did not include a name",
          project,
        }
      }
      try {
        return {
          deployments: await retryRead(() => api.list(
            `accounts/${accountId}/pages/projects/${encodeURIComponent(project.name)}/deployments?env=production`,
            { perPage: PAGES_DEPLOYMENT_PAGE_SIZE },
          )),
          error: null,
          project,
        }
      } catch (error) {
        return {
          deployments: [],
          error: errorMessage(error),
          project,
        }
      }
    },
    options.concurrency,
    (progress) => options.onProgress?.({
      ...progress,
      message: `Checking Pages production deployments ${progress.completed}/${progress.total}`,
      stage: "pages-deployments",
    }),
  )
}

async function readWorkerMetrics(api, accountId, now) {
  if (typeof api.graphql !== "function") {
    throw new TypeError("Cloudflare API client does not support GraphQL")
  }
  const end = new Date(now).toISOString()
  const start = new Date(now - WORKER_METRICS_WINDOW_MS).toISOString()
  const data = await api.graphql(WORKER_METRICS_QUERY, {
    accountTag: accountId,
    end,
    start,
  })
  const rows = data.viewer?.accounts?.[0]?.rows
  if (!Array.isArray(rows)) {
    throw new TypeError("Expected Worker invocation metrics rows")
  }
  return { end, rows, start }
}

async function readD1Metrics(api, accountId, now) {
  if (typeof api.graphql !== "function") {
    throw new TypeError("Cloudflare API client does not support GraphQL")
  }
  const end = new Date(now).toISOString().slice(0, 10)
  const start = new Date(now - D1_METRICS_WINDOW_MS)
    .toISOString()
    .slice(0, 10)
  const data = await api.graphql(D1_METRICS_QUERY, {
    accountTag: accountId,
    end,
    start,
  })
  const rows = data.viewer?.accounts?.[0]?.rows
  if (!Array.isArray(rows)) {
    throw new TypeError("Expected D1 activity metrics rows")
  }
  return { end, rows, start }
}

function accountReadFailure(id, category, label, read) {
  return auditFinding({
    category,
    detail: read.error,
    evidence: { surface: id },
    id: `deep.account-read-failed:${id}`,
    recommendation: `Confirm the token can read ${label}, then rerun the audit before drawing cleanup conclusions from that surface`,
    severity: FLEET_AUDIT_SEVERITY.REVIEW,
    title: `${label} could not be read`,
  })
}

function accountReadFindings(reads) {
  const definitions = [
    ["d1", "Developer platform", "D1 databases"],
    ["kv", "Developer platform", "KV namespaces"],
    ["pages", "Pages", "Pages projects"],
    ["queues", "Workers", "Queues"],
    ["r2", "Developer platform", "R2 buckets"],
    ["registrar", "Registrar", "Registrar registrations"],
    ["workflows", "Workers", "Workflows"],
  ]
  const findings = definitions
    .filter(([id]) => !reads[id].ok)
    .map(([id, category, label]) => accountReadFailure(
      id,
      category,
      label,
      reads[id],
    ))
  if (!reads.scripts.ok || !reads.domains.ok) {
    findings.push(auditFinding({
      category: "Workers",
      detail: [reads.scripts.error, reads.domains.error].filter(Boolean).join("; "),
      evidence: {
        customDomains: reads.domains.error,
        scripts: reads.scripts.error,
      },
      id: "deep.workers-inventory-read-failed",
      recommendation: "Confirm the token can read Worker scripts and custom domains, then rerun the audit",
      severity: FLEET_AUDIT_SEVERITY.WARNING,
      title: "Workers dependency inventory could not be completed",
    }))
  }
  return findings
}

function workerFindings(reads, details, queueDetails, inventory) {
  if (!reads.scripts.ok || !reads.domains.ok) return []
  const findings = []
  const failedDetails = details.filter((entry) => entry.error)
  if (failedDetails.length > 0) {
    findings.push(auditFinding({
      category: "Workers",
      detail: `${failedDetails.length} Worker ${failedDetails.length === 1 ? "dependency read failed" : "dependency reads failed"}`,
      evidence: {
        scripts: failedDetails.map((entry) => ({
          error: entry.error,
          script: entry.script.id,
        })),
      },
      id: "deep.workers-ingress-read-failed",
      recommendation: "Retry the read-only audit before treating any affected Worker as unused",
      severity: FLEET_AUDIT_SEVERITY.REVIEW,
      title: "Some Worker dependencies could not be checked",
    }))
  }
  const failedQueues = queueDetails.filter((entry) => entry.error)
  if (failedQueues.length > 0) {
    findings.push(auditFinding({
      category: "Workers",
      detail: `${failedQueues.length} Queue ${failedQueues.length === 1 ? "consumer read failed" : "consumer reads failed"}`,
      evidence: {
        queues: failedQueues.map((entry) => ({
          error: entry.error,
          queue: entry.queue.queue_name || entry.queue.queue_id || entry.queue.id,
        })),
      },
      id: "deep.queue-consumers-read-failed",
      recommendation: "Retry the read-only audit before treating a queue-triggered Worker as unused",
      severity: FLEET_AUDIT_SEVERITY.REVIEW,
      title: "Some Queue consumers could not be checked",
    }))
  }
  const dependenciesComplete = failedDetails.length === 0
    && failedQueues.length === 0
    && reads.pages.ok
    && reads.queues.ok
    && reads.workflows.ok
    && zoneDependencyReadsComplete(inventory)
  if (!dependenciesComplete) return findings

  const references = zoneWorkerReferences(inventory)
  for (const domain of reads.domains.value) {
    addWorkerReference(
      references,
      domain.service,
      "custom-domain",
      domain.hostname || domain.service,
    )
  }
  const bindings = collectBindingReferences(details, reads.pages.value)
  mergeReferences(references, bindings.workers)
  for (const queueDetail of queueDetails) {
    for (const consumer of queueDetail.consumers) {
      addWorkerReference(
        references,
        consumer.script_name,
        "queue-consumer",
        queueDetail.queue.queue_name || queueDetail.queue.queue_id || "unnamed",
      )
    }
  }
  for (const workflow of reads.workflows.value) {
    addWorkerReference(
      references,
      workflow.script_name,
      "workflow",
      workflow.name || workflow.id,
    )
  }
  for (const detail of details) {
    if (detail.workersDev || detail.schedules.length > 0) continue
    if ((references.get(detail.script.id) || []).length > 0) continue
    findings.push(auditFinding({
      category: "Workers",
      detail: `${detail.script.id} has no zone route, Email route, custom domain, workers.dev endpoint, cron schedule, service binding, Durable Object binding, tail consumer, Queue consumer, Workflow, or Pages reference discovered by this audit`,
      evidence: { handlers: detail.script.handlers || [] },
      id: `deep.worker-no-discovered-ingress:${detail.script.id}`,
      recommendation: "Review dispatch namespaces and external callers before treating the script as removable",
      severity: FLEET_AUDIT_SEVERITY.REVIEW,
      title: "Worker has no discovered ingress",
    }))
  }
  return findings
}

function workerMetricFindings(read, scripts, details) {
  if (!read.ok) {
    return [auditFinding({
      category: "Workers",
      detail: read.error,
      evidence: { surface: "workers-invocations" },
      id: "deep.worker-metrics-read-failed",
      recommendation: "Confirm the token can read Workers analytics, then rerun the audit before drawing conclusions from missing invocation data",
      severity: FLEET_AUDIT_SEVERITY.REVIEW,
      title: "Worker invocation health could not be read",
    })]
  }
  const scriptNames = new Set(scripts.map((script) => script.id))
  const workerDetails = new Map(
    details.map((detail) => [detail.script.id, detail]),
  )
  const summaries = new Map()
  for (const row of read.value.rows) {
    const script = row.dimensions?.scriptName
    if (!scriptNames.has(script)) continue
    if (!summaries.has(script)) {
      summaries.set(script, { errors: 0, requests: 0, statuses: {} })
    }
    const summary = summaries.get(script)
    const errors = Number(row.sum?.errors || 0)
    const requests = Number(row.sum?.requests || 0)
    if (Number.isFinite(errors)) summary.errors += errors
    if (Number.isFinite(requests)) summary.requests += requests
    const status = row.dimensions?.status
    if (status && Number.isFinite(requests)) {
      summary.statuses[status] = (summary.statuses[status] || 0) + requests
    }
  }
  const findings = []
  for (const [script, summary] of summaries) {
    if (summary.requests <= 0) continue
    const errorRate = summary.errors / summary.requests
    if (summary.errors < WORKER_ERROR_REQUEST_MINIMUM
      || errorRate < WORKER_ERROR_RATE_WARNING) continue
    const detail = workerDetails.get(script)
    const handlers = detail?.script.handlers || []
    const eventOnlyWorkersDev = detail?.workersDev === true
      && !handlers.includes("fetch")
    findings.push(auditFinding({
      category: "Workers",
      detail: eventOnlyWorkersDev
        ? `${script} exposes workers.dev without a fetch handler and reported ${summary.errors} errors across ${summary.requests} invocations (${(errorRate * 100).toFixed(1)}%) during the metrics window; requests to the public endpoint cannot be handled`
        : `${script} reported ${summary.errors} errors across ${summary.requests} invocations (${(errorRate * 100).toFixed(1)}%) during the metrics window`,
      evidence: {
        end: read.value.end,
        errorRate,
        errors: summary.errors,
        handlers,
        requests: summary.requests,
        start: read.value.start,
        statuses: summary.statuses,
        workersDev: detail?.workersDev ?? null,
      },
      id: eventOnlyWorkersDev
        ? `deep.worker-event-only-workers-dev-errors:${script}`
        : `deep.worker-high-error-rate:${script}`,
      recommendation: eventOnlyWorkersDev
        ? "Disable workers.dev if the Worker is event-only, or add a fetch handler if the public HTTP endpoint is intentional"
        : "Inspect Worker logs and deployment history, then verify the failing event path before changing routes or bindings",
      severity: FLEET_AUDIT_SEVERITY.WARNING,
      title: eventOnlyWorkersDev
        ? "Event-only Worker exposes a failing HTTP endpoint"
        : "Worker invocation error rate is elevated",
    }))
  }
  return findings
}

function resourceMetadata(type, resource) {
  if (type === "d1") {
    return {
      createdAt: resource.created_at || null,
      id: resource.uuid,
      name: resource.name || resource.uuid,
    }
  }
  if (type === "kv") {
    return {
      createdAt: null,
      id: resource.id,
      name: resource.title || resource.id,
    }
  }
  return {
    createdAt: resource.creation_date || null,
    id: resource.name,
    name: resource.name,
  }
}

function d1Activity(read, databaseId) {
  if (!read.ok) return null
  const summary = {
    end: read.value.end,
    readQueries: 0,
    rowsRead: 0,
    rowsWritten: 0,
    start: read.value.start,
    writeQueries: 0,
  }
  for (const row of read.value.rows) {
    if (row.dimensions?.databaseId !== databaseId) continue
    for (const field of [
      "readQueries",
      "rowsRead",
      "rowsWritten",
      "writeQueries",
    ]) {
      const value = Number(row.sum?.[field] || 0)
      if (Number.isFinite(value)) summary[field] += value
    }
  }
  return summary
}

function d1MetricFindings(read, databases) {
  if (read.ok || databases.length === 0) return []
  return [auditFinding({
    category: "Developer platform",
    detail: read.error,
    evidence: { surface: "d1-analytics" },
    id: "deep.d1-metrics-read-failed",
    recommendation: "Confirm the token has Analytics Read permission, then rerun the audit before drawing conclusions from missing D1 query activity",
    severity: FLEET_AUDIT_SEVERITY.REVIEW,
    title: "D1 query activity could not be read",
  })]
}

function storageFindings(reads, details, d1Metrics) {
  if (!reads.scripts.ok || !reads.pages.ok || details.some((entry) => entry.error)) {
    return []
  }
  const references = collectBindingReferences(details, reads.pages.value).resources
  const definitions = [
    ["d1", "D1 database", reads.d1],
    ["kv", "KV namespace", reads.kv],
    ["r2", "R2 bucket", reads.r2],
  ]
  const findings = []
  for (const [type, label, read] of definitions) {
    if (!read.ok) continue
    for (const resource of read.value) {
      const metadata = resourceMetadata(type, resource)
      if (!metadata.id || (references[type].get(metadata.id) || []).length > 0) {
        continue
      }
      const activity = type === "d1"
        ? d1Activity(d1Metrics, metadata.id)
        : null
      const noRecentD1Queries = activity
        && activity.readQueries === 0
        && activity.writeQueries === 0
      findings.push(auditFinding({
        category: "Developer platform",
        detail: activity
          ? `${metadata.name} is not referenced by any loaded Worker or Pages binding; query analytics report ${activity.readQueries} reads and ${activity.writeQueries} writes during the activity window`
          : `${metadata.name} is not referenced by any loaded Worker or Pages binding`,
        evidence: { ...metadata, activity },
        id: `deep.storage-no-discovered-binding:${type}:${metadata.id}`,
        recommendation: noRecentD1Queries
          ? "Review direct API clients, local Wrangler configurations, and activity older than the metrics window before treating the database as removable"
          : "Review direct API clients, local Wrangler configurations, and historical usage before treating the resource as removable",
        severity: FLEET_AUDIT_SEVERITY.REVIEW,
        title: noRecentD1Queries
          ? `${label} has no discovered binding or recent queries`
          : `${label} has no discovered binding`,
      }))
    }
  }
  return findings
}

function zonesForDomains(inventory, domains) {
  return inventory.zones
    .filter((zone) => domains.some((domain) => (
      domain === zone.meta.name || domain.endsWith(`.${zone.meta.name}`)
    )))
    .map((zone) => zone.meta.name)
}

function deploymentEvidence(deployment) {
  if (!deployment) return null
  const trigger = deployment.deployment_trigger
  return {
    createdOn: deployment.created_on || null,
    environment: deployment.environment || null,
    id: deployment.id || null,
    stage: deployment.latest_stage
      ? {
          endedOn: deployment.latest_stage.ended_on || null,
          name: deployment.latest_stage.name || null,
          status: deployment.latest_stage.status || null,
        }
      : null,
    trigger: trigger
      ? {
          branch: trigger.metadata?.branch || null,
          commitHash: trigger.metadata?.commit_hash || null,
          commitMessage: trigger.metadata?.commit_message || null,
          type: trigger.type || null,
        }
      : null,
    url: deployment.url || null,
  }
}

function pagesFindings(reads, pageDetails, inventory, now) {
  if (!reads.pages.ok) return []
  const findings = []
  const failedReads = pageDetails.filter((entry) => entry.error)
  if (failedReads.length > 0) {
    findings.push(auditFinding({
      category: "Pages",
      detail: `${failedReads.length} Pages production deployment ${failedReads.length === 1 ? "read failed" : "reads failed"}`,
      evidence: {
        projects: failedReads.map((entry) => ({
          error: entry.error,
          project: entry.project.name || null,
        })),
      },
      id: "deep.pages-deployments-read-failed",
      recommendation: "Retry the read-only audit before drawing conclusions about Pages deployment health",
      severity: FLEET_AUDIT_SEVERITY.REVIEW,
      title: "Some Pages production deployments could not be checked",
    }))
  }
  for (const pageDetail of pageDetails) {
    const { project } = pageDetail
    const domains = project.domains || []
    const zones = zonesForDomains(inventory, domains)
    const canonical = project.canonical_deployment
    const canonicalHealthy = canonical?.latest_stage?.status === "success"
    if (!canonicalHealthy) {
      findings.push(auditFinding({
        category: "Pages",
        detail: `${project.name} has no successful canonical production deployment`,
        evidence: { canonical: deploymentEvidence(canonical), domains },
        id: `deep.pages-no-healthy-production:${project.name}`,
        recommendation: "Inspect the latest production build and deployment logs before changing project domains or deleting the project",
        severity: FLEET_AUDIT_SEVERITY.WARNING,
        title: "Pages project has no healthy production deployment",
        zones,
      }))
      continue
    }
    if (pageDetail.error) continue
    const productionDeployments = pageDetail.deployments
      .filter((deployment) => deployment.environment === "production")
      .sort((left, right) => (
        Date.parse(right.created_on || "") - Date.parse(left.created_on || "")
      ))
    const latest = productionDeployments[0]
    const latestStage = latest?.latest_stage
    if (latestStage?.status === "failure") {
      const consecutiveFailures = productionDeployments.findIndex(
        (deployment) => deployment.latest_stage?.status !== "failure",
      )
      findings.push(auditFinding({
        category: "Pages",
        detail: `${project.name} failed its newest production ${latestStage.name || "deployment"} stage while an older successful deployment remains canonical`,
        evidence: {
          canonical: deploymentEvidence(canonical),
          consecutiveFailures: consecutiveFailures === -1
            ? productionDeployments.length
            : consecutiveFailures,
          latest: deploymentEvidence(latest),
        },
        id: `deep.pages-latest-production-failed:${project.name}`,
        recommendation: "Review the failed deployment logs and either repair the production branch or confirm the older canonical deployment is intentionally retained",
        severity: FLEET_AUDIT_SEVERITY.WARNING,
        title: "Newest Pages production deployment failed",
        zones,
      }))
    }
    const customDomains = domains.filter(
      (domain) => !String(domain).toLowerCase().endsWith(".pages.dev"),
    )
    const latestCreatedAt = typeof latest?.created_on === "string"
      && Number.isFinite(Date.parse(latest.created_on))
      ? latest.created_on
      : null
    if (customDomains.length === 0
      && latestCreatedAt
      && now - Date.parse(latestCreatedAt) > PAGES_STALE_REVIEW_MS) {
      findings.push(auditFinding({
        category: "Pages",
        detail: `${project.name} has no custom domain and its newest production deployment dates to ${latestCreatedAt}`,
        evidence: {
          domains,
          latest: deploymentEvidence(latest),
        },
        id: `deep.pages-old-without-custom-domain:${project.name}`,
        recommendation: "Check direct pages.dev traffic and the source repository before deciding whether to retain or remove the project",
        severity: FLEET_AUDIT_SEVERITY.REVIEW,
        title: "Pages project has no custom domain and an old deployment",
        zones,
      }))
    }
  }
  return findings
}

function registrarFindings(reads, inventory, now) {
  if (!reads.registrar.ok) return []
  const zoneNames = new Set(inventory.zones.map((zone) => zone.meta.name))
  const findings = []
  for (const registration of reads.registrar.value) {
    const domain = String(registration.domain_name || "").toLowerCase()
    if (!domain) continue
    const zones = zoneNames.has(domain) ? [domain] : []
    const expiresAt = typeof registration.expires_at === "string"
      && Number.isFinite(Date.parse(registration.expires_at))
      ? registration.expires_at
      : null
    const expiresInMs = expiresAt === null ? null : Date.parse(expiresAt) - now
    const status = registration.status || "unknown"
    if (REGISTRAR_CRITICAL_STATUS.has(status) || (expiresInMs !== null && expiresInMs <= 0)) {
      findings.push(auditFinding({
        category: "Registrar",
        detail: `${domain} reports registration status ${status} and expiration ${expiresAt || "unknown"}`,
        evidence: { expiresAt, status },
        id: `deep.registrar-unhealthy:${domain}`,
        recommendation: "Review the Registrar registration immediately before the registry state becomes unrecoverable",
        severity: FLEET_AUDIT_SEVERITY.CRITICAL,
        title: "Domain registration is unhealthy",
        zones,
      }))
    } else if (status !== "active") {
      findings.push(auditFinding({
        category: "Registrar",
        detail: `${domain} reports registration status ${status}`,
        evidence: { expiresAt, status },
        id: `deep.registrar-status:${domain}`,
        recommendation: "Review the Registrar workflow status and confirm the registration reaches active state",
        severity: FLEET_AUDIT_SEVERITY.WARNING,
        title: "Domain registration is not active",
        zones,
      }))
    }
    if (registration.auto_renew === false) {
      const closeToExpiry = expiresInMs !== null
        && expiresInMs <= REGISTRAR_EXPIRY_WARNING_MS
      findings.push(auditFinding({
        category: "Registrar",
        detail: `${domain} has auto-renew disabled and expires ${expiresAt || "at an unknown time"}`,
        evidence: { autoRenew: false, expiresAt },
        id: `deep.registrar-auto-renew-disabled:${domain}`,
        recommendation: "Confirm manual expiration is intentional or enable auto-renew after reviewing billing and ownership",
        severity: closeToExpiry
          ? FLEET_AUDIT_SEVERITY.WARNING
          : FLEET_AUDIT_SEVERITY.REVIEW,
        title: "Domain registration auto-renew is disabled",
        zones,
      }))
    }
    if (registration.locked === false) {
      findings.push(auditFinding({
        category: "Registrar",
        detail: `${domain} is not locked against transfer`,
        evidence: { locked: false },
        id: `deep.registrar-unlocked:${domain}`,
        recommendation: "Confirm a transfer is in progress or re-enable the registrar lock",
        severity: FLEET_AUDIT_SEVERITY.REVIEW,
        title: "Domain registration is unlocked",
        zones,
      }))
    }
    if (!zoneNames.has(domain)) {
      findings.push(auditFinding({
        category: "Registrar",
        detail: `${domain} is registered in the account but has no corresponding loaded Cloudflare zone`,
        evidence: { expiresAt, status },
        id: `deep.registrar-zone-missing:${domain}`,
        recommendation: "Confirm the domain intentionally uses another DNS provider or restore the missing Cloudflare zone",
        severity: FLEET_AUDIT_SEVERITY.REVIEW,
        title: "Registered domain has no loaded zone",
      }))
    }
  }
  return findings
}

async function readAccountSurfaces(api, accountId, options) {
  const definitions = {
    d1: () => api.list(`accounts/${accountId}/d1/database`),
    domains: () => api.list(`accounts/${accountId}/workers/domains`),
    kv: () => api.list(`accounts/${accountId}/storage/kv/namespaces`),
    pages: async () => {
      const response = await api.request(`accounts/${accountId}/pages/projects`)
      if (!Array.isArray(response.result)) {
        throw new TypeError("Expected an array of Pages projects")
      }
      return response.result
    },
    queues: () => api.list(`accounts/${accountId}/queues`),
    r2: async () => {
      const response = await api.request(`accounts/${accountId}/r2/buckets`)
      if (!Array.isArray(response.result?.buckets)) {
        throw new TypeError("Expected an array of R2 buckets")
      }
      return response.result.buckets
    },
    registrar: () => listCursor(
      api,
      `accounts/${accountId}/registrar/registrations`,
    ),
    scripts: () => api.list(`accounts/${accountId}/workers/scripts`),
    workflows: () => api.list(`accounts/${accountId}/workflows`),
  }
  const definitionsCount = Object.keys(definitions).length
  const reads = {}
  let completed = 0
  await Promise.all(Object.entries(definitions).map(async ([id, read]) => {
    reads[id] = await safeRead(read)
    completed += 1
    options.onProgress?.({
      completed,
      message: `Reading account resources ${completed}/${definitionsCount}`,
      stage: "account-resources",
      total: definitionsCount,
    })
  }))
  return reads
}

export async function collectAccountAuditFindings(api, inventory, options = {}) {
  if (!api?.accountId || typeof api.list !== "function" || typeof api.request !== "function") {
    throw new TypeError("Account fleet audit requires a Cloudflare API client")
  }
  const now = options.now instanceof Date
    ? options.now.valueOf()
    : options.now ?? Date.now()
  if (!Number.isFinite(now)) {
    throw new TypeError("Account fleet audit requires a valid generation time")
  }
  const shared = {
    concurrency: options.concurrency || ACCOUNT_READ_CONCURRENCY,
    onProgress: options.onProgress,
  }
  const accountId = encodeURIComponent(api.accountId)
  const reads = await readAccountSurfaces(api, accountId, shared)
  const scripts = reads.scripts.ok ? reads.scripts.value : []
  const queues = reads.queues.ok ? reads.queues.value : []
  const pages = reads.pages.ok ? reads.pages.value : []
  const [
    details,
    queueDetails,
    pageDetails,
    workerMetrics,
    d1Metrics,
  ] = await Promise.all([
    readWorkerDetails(api, accountId, scripts, shared),
    readQueueConsumers(api, accountId, queues, shared),
    readPageDeployments(api, accountId, pages, shared),
    scripts.length > 0
      ? safeRead(() => readWorkerMetrics(api, api.accountId, now))
      : safeRead(async () => ({
          end: new Date(now).toISOString(),
          rows: [],
          start: new Date(now - WORKER_METRICS_WINDOW_MS).toISOString(),
        })),
    reads.d1.ok && reads.d1.value.length > 0
      ? safeRead(() => readD1Metrics(api, api.accountId, now))
      : safeRead(async () => ({
          end: new Date(now).toISOString().slice(0, 10),
          rows: [],
          start: new Date(now - D1_METRICS_WINDOW_MS)
            .toISOString()
            .slice(0, 10),
        })),
  ])
  return [
    ...accountReadFindings(reads),
    ...workerFindings(reads, details, queueDetails, inventory),
    ...workerMetricFindings(workerMetrics, scripts, details),
    ...d1MetricFindings(d1Metrics, reads.d1.ok ? reads.d1.value : []),
    ...storageFindings(reads, details, d1Metrics),
    ...pagesFindings(reads, pageDetails, inventory, now),
    ...registrarFindings(reads, inventory, now),
  ]
}
