import {
  auditCnameRecords,
  auditFinding,
  FLEET_AUDIT_SEVERITY,
} from "./audit-report.mjs"
import { DNSSEC_STATUS } from "./constants.mjs"
import {
  dnssecTransitionHealth,
  DNSSEC_TRANSITION_STATE,
} from "./dnssec.mjs"

const DEFAULT_DEEP_AUDIT_CONCURRENCY = 8
const DEFAULT_DNS_TIMEOUT_MS = 10000
const DEFAULT_ENDPOINT_TIMEOUT_MS = 10000
const CLOUDFLARE_DCV_TARGET_SUFFIX = ".dcv.cloudflare.com"
const WORKER_READ_ATTEMPTS = 2
const DNS_ANSWER_TYPE = Object.freeze({
  A: 1,
  AAAA: 28,
  DS: 43,
})
const DNS_RESPONSE_STATUS_NXDOMAIN = 3
const PUBLIC_ENDPOINT_RECORD_TYPES = new Set(["A", "AAAA", "CNAME"])

function surfaceResult(zone, surfaceId) {
  const surface = zone.surfaces?.[surfaceId]
  return surface?.ok ? surface.result : null
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
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

async function dnsQuery(fetchImpl, name, type, timeoutMs) {
  const url = new URL("https://cloudflare-dns.com/dns-query")
  url.searchParams.set("name", name)
  url.searchParams.set("type", type)
  const response = await fetchImpl(url, {
    headers: { Accept: "application/dns-json" },
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) throw new Error(`DNS query returned HTTP ${response.status}`)
  const payload = await response.json()
  if (!Number.isInteger(payload?.Status)) {
    throw new Error("DNS query returned an invalid response")
  }
  return payload
}

function dnsAnswers(payload, type) {
  return (payload.Answer || []).filter((answer) => answer.type === type)
}

async function parentDsFindings(inventory, options) {
  const zones = inventory.zones.filter((zone) => {
    const status = surfaceResult(zone, "dnssec")?.status
    return Object.values(DNSSEC_STATUS).includes(status)
  })
  const findings = await mapPool(
    zones,
    async (zone) => {
      const dnssec = surfaceResult(zone, "dnssec")
      let payload
      try {
        payload = await dnsQuery(
          options.fetchImpl,
          zone.meta.name,
          "DS",
          options.dnsTimeoutMs,
        )
      } catch (error) {
        return [auditFinding({
          category: "DNSSEC",
          detail: `${zone.meta.name}: ${errorMessage(error)}`,
          id: `deep.dnssec-parent-read-failed:${zone.meta.name}`,
          recommendation: "Retry the read-only audit before drawing a conclusion about parent DS state",
          severity: FLEET_AUDIT_SEVERITY.REVIEW,
          title: "Parent DS state could not be read",
          zones: [zone.meta.name],
        })]
      }
      const records = dnsAnswers(payload, DNS_ANSWER_TYPE.DS)
      const parentHasDs = records.length > 0
      const health = dnssecTransitionHealth(dnssec, { now: options.now })
      const shouldHaveDs = dnssec.status === DNSSEC_STATUS.ACTIVE
      const shouldNotHaveDs = dnssec.status === DNSSEC_STATUS.DISABLED
      const stalledEnable = dnssec.status === DNSSEC_STATUS.PENDING
        && health.state === DNSSEC_TRANSITION_STATE.STALLED
      const stalledDisable = dnssec.status === DNSSEC_STATUS.PENDING_DISABLED
        && health.state === DNSSEC_TRANSITION_STATE.STALLED
      if ((shouldHaveDs || stalledEnable) && !parentHasDs) {
        return [auditFinding({
          category: "DNSSEC",
          detail: `${zone.meta.name} reports ${dnssec.status}, but the parent zone publishes no DS answer`,
          evidence: {
            dnsStatus: payload.Status,
            dnssecStatus: dnssec.status,
            modifiedOn: dnssec.modified_on || null,
          },
          id: `deep.dnssec-parent-ds-missing:${zone.meta.name}`,
          recommendation: "Review registrar delegation and CDS/CDNSKEY processing before repeating the Cloudflare DNSSEC status write",
          severity: FLEET_AUDIT_SEVERITY.WARNING,
          title: "Parent DS record is missing",
          zones: [zone.meta.name],
        })]
      }
      if ((shouldNotHaveDs || stalledDisable) && parentHasDs) {
        return [auditFinding({
          category: "DNSSEC",
          detail: `${zone.meta.name} reports ${dnssec.status}, but the parent zone still publishes DS data`,
          evidence: {
            dnssecStatus: dnssec.status,
            modifiedOn: dnssec.modified_on || null,
            records: records.map((record) => record.data),
          },
          id: `deep.dnssec-parent-ds-present:${zone.meta.name}`,
          recommendation: "Review registrar delegation before assuming DNSSEC disablement is complete",
          severity: FLEET_AUDIT_SEVERITY.WARNING,
          title: "Parent DS record remains published",
          zones: [zone.meta.name],
        })]
      }
      return []
    },
    options.concurrency,
    (progress) => options.onProgress?.({
      ...progress,
      message: `Checking parent DS records ${progress.completed}/${progress.total}`,
      stage: "parent-ds",
    }),
  )
  return findings.flat()
}

async function cnameTargetFindings(inventory, options) {
  const records = auditCnameRecords(inventory)
  const byTarget = new Map()
  for (const record of records) {
    if (!record.target || record.target.endsWith(CLOUDFLARE_DCV_TARGET_SUFFIX)) {
      continue
    }
    if (!byTarget.has(record.target)) byTarget.set(record.target, [])
    byTarget.get(record.target).push(record)
  }
  const targets = [...byTarget.keys()].sort()
  const findings = await mapPool(
    targets,
    async (target) => {
      let responses
      try {
        responses = await Promise.all([
          dnsQuery(options.fetchImpl, target, "A", options.dnsTimeoutMs),
          dnsQuery(options.fetchImpl, target, "AAAA", options.dnsTimeoutMs),
        ])
      } catch (error) {
        return auditFinding({
          category: "DNS",
          detail: `${target}: ${errorMessage(error)}`,
          id: `deep.cname-target-read-failed:${target}`,
          recommendation: "Retry the read-only audit before treating the target as unresolved",
          severity: FLEET_AUDIT_SEVERITY.REVIEW,
          title: "CNAME target resolution could not be checked",
          zones: byTarget.get(target).map((record) => record.zoneName),
        })
      }
      const resolved = dnsAnswers(responses[0], DNS_ANSWER_TYPE.A).length > 0
        || dnsAnswers(responses[1], DNS_ANSWER_TYPE.AAAA).length > 0
      if (resolved) return null
      const recordsForTarget = byTarget.get(target)
      const nxdomain = responses.every(
        (response) => response.Status === DNS_RESPONSE_STATUS_NXDOMAIN,
      )
      return auditFinding({
        category: "DNS",
        detail: `${target} has no public A or AAAA answer and is referenced by ${recordsForTarget.length} CNAME ${recordsForTarget.length === 1 ? "record" : "records"}`,
        evidence: {
          references: recordsForTarget.map((record) => ({
            name: record.name,
            proxied: record.proxied,
            zone: record.zoneName,
          })),
          responseStatus: responses.map((response) => response.Status),
        },
        id: `deep.cname-target-${nxdomain ? "nxdomain" : "no-address"}:${target}`,
        recommendation: "Treat this as a review candidate only: Cloudflare for SaaS, validation, and other edge products can intentionally serve a hostname whose configured target has no public address answer",
        severity: FLEET_AUDIT_SEVERITY.REVIEW,
        title: nxdomain
          ? "CNAME target returns NXDOMAIN"
          : "CNAME target has no public address answer",
        zones: recordsForTarget.map((record) => record.zoneName),
      })
    },
    options.concurrency,
    (progress) => options.onProgress?.({
      ...progress,
      message: `Resolving CNAME targets ${progress.completed}/${progress.total}`,
      stage: "cname-targets",
    }),
  )
  return findings.filter(Boolean)
}

function publicEndpointTargets(inventory) {
  const targets = new Map()
  for (const zone of inventory.zones) {
    for (const record of surfaceResult(zone, "dns") || []) {
      if (!record.proxied
        || !PUBLIC_ENDPOINT_RECORD_TYPES.has(String(record.type || "").toUpperCase())) continue
      const name = String(record.name || "").replace(/\.$/, "").toLowerCase()
      if (!name || name.startsWith("_") || name.includes("*")) continue
      if (!targets.has(name)) targets.set(name, new Set())
      targets.get(name).add(zone.meta.name)
    }
  }
  return [...targets.entries()]
    .map(([hostname, zones]) => ({ hostname, zones: [...zones].sort() }))
    .sort((left, right) => left.hostname.localeCompare(right.hostname))
}

async function endpointFindings(inventory, options) {
  const targets = publicEndpointTargets(inventory)
  const results = await mapPool(
    targets,
    async (target) => {
      const { hostname } = target
      try {
        const response = await options.fetchImpl(`https://${hostname}/`, {
          method: "HEAD",
          redirect: "manual",
          signal: AbortSignal.timeout(options.endpointTimeoutMs),
        })
        if (response.status < 500) return null
        return auditFinding({
          category: "Endpoints",
          detail: `https://${hostname}/ returned HTTP ${response.status}`,
          evidence: { status: response.status },
          id: `deep.endpoint-http-${response.status}:${hostname}`,
          recommendation: "Confirm the hostname is still intended, then inspect its Worker route, custom domain, origin, or Cloudflare product binding",
          severity: FLEET_AUDIT_SEVERITY.WARNING,
          title: "Proxied hostname returned a server error",
          zones: target.zones,
        })
      } catch (error) {
        return auditFinding({
          category: "Endpoints",
          detail: `https://${hostname}/ could not be reached: ${errorMessage(error)}`,
          id: `deep.endpoint-unreachable:${hostname}`,
          recommendation: "Confirm the hostname is still intended and distinguish a transient origin failure from abandoned configuration",
          severity: FLEET_AUDIT_SEVERITY.REVIEW,
          title: "Proxied hostname could not be reached",
          zones: target.zones,
        })
      }
    },
    options.concurrency,
    (progress) => options.onProgress?.({
      ...progress,
      message: `Probing proxied HTTPS endpoints ${progress.completed}/${progress.total}`,
      stage: "endpoints",
    }),
  )
  const findings = results.filter(Boolean)
  const unreachable = findings.filter(
    (entry) => entry.id.startsWith("deep.endpoint-unreachable:"),
  )
  if (unreachable.length === 0) return findings
  return [
    ...findings.filter((entry) => !entry.id.startsWith("deep.endpoint-unreachable:")),
    auditFinding({
      category: "Endpoints",
      detail: `${unreachable.length} of ${targets.length} proxied HTTPS endpoints did not return headers within the timeout`,
      evidence: {
        endpoints: unreachable.map((entry) => ({
          detail: entry.detail,
          hostname: entry.id.slice("deep.endpoint-unreachable:".length),
        })),
      },
      id: "deep.endpoints-unreachable",
      recommendation: "Triage the listed hostnames in batches and confirm intent before removing DNS, routes, custom domains, or origin configuration",
      severity: FLEET_AUDIT_SEVERITY.REVIEW,
      title: "Some proxied hostnames could not be reached",
      zones: unreachable.flatMap((entry) => entry.zones),
    }),
  ]
}

function workerRouteReferences(inventory) {
  const references = new Map()
  function add(script, kind, value) {
    if (!script) return
    if (!references.has(script)) references.set(script, [])
    references.get(script).push({ kind, value })
  }
  for (const zone of inventory.zones) {
    for (const route of surfaceResult(zone, "workers-routes") || []) {
      add(route.script, "zone-route", route.pattern || zone.meta.name)
    }
    for (const rule of surfaceResult(zone, "email-rules") || []) {
      for (const action of rule.actions || []) {
        if (action.type !== "worker") continue
        for (const script of action.value || []) {
          add(script, "email-route", `${zone.meta.name}:${rule.name || rule.id || "unnamed"}`)
        }
      }
    }
  }
  return references
}

async function workerFindings(api, inventory, options) {
  const accountId = encodeURIComponent(api.accountId)
  let scripts
  let domains
  try {
    [scripts, domains] = await Promise.all([
      retryRead(() => api.list(`accounts/${accountId}/workers/scripts`)),
      retryRead(() => api.list(`accounts/${accountId}/workers/domains`)),
    ])
  } catch (error) {
    return [auditFinding({
      category: "Workers",
      detail: errorMessage(error),
      id: "deep.workers-inventory-read-failed",
      recommendation: "Confirm the token can read Workers scripts and custom domains, then rerun the audit",
      severity: FLEET_AUDIT_SEVERITY.WARNING,
      title: "Workers dependency inventory could not be completed",
    })]
  }
  const references = workerRouteReferences(inventory)
  for (const domain of domains) {
    if (!domain.service) continue
    if (!references.has(domain.service)) references.set(domain.service, [])
    references.get(domain.service).push({
      kind: "custom-domain",
      value: domain.hostname || domain.service,
    })
  }
  const ingress = await mapPool(
    scripts,
    async (script) => {
      try {
        const [subdomain, schedules] = await Promise.all([
          retryRead(() => api.request(`accounts/${accountId}/workers/scripts/${encodeURIComponent(script.id)}/subdomain`)),
          retryRead(() => api.request(`accounts/${accountId}/workers/scripts/${encodeURIComponent(script.id)}/schedules`)),
        ])
        return {
          error: null,
          schedules: schedules.result?.schedules || [],
          script,
          workersDev: Boolean(subdomain.result?.enabled),
        }
      } catch (error) {
        return {
          error: errorMessage(error),
          schedules: [],
          script,
          workersDev: null,
        }
      }
    },
    options.concurrency,
    (progress) => options.onProgress?.({
      ...progress,
      message: `Checking Worker ingress ${progress.completed}/${progress.total}`,
      stage: "workers",
    }),
  )
  const findings = []
  const failed = ingress.filter((entry) => entry.error)
  if (failed.length > 0) {
    findings.push(auditFinding({
      category: "Workers",
      detail: `${failed.length} Worker ${failed.length === 1 ? "ingress read failed" : "ingress reads failed"}`,
      evidence: {
        scripts: failed.map((entry) => ({
          error: entry.error,
          script: entry.script.id,
        })),
      },
      id: "deep.workers-ingress-read-failed",
      recommendation: "Retry the read-only audit before treating any affected Worker as unused",
      severity: FLEET_AUDIT_SEVERITY.REVIEW,
      title: "Some Worker ingress could not be checked",
    }))
  }
  for (const entry of ingress) {
    if (entry.error || entry.workersDev || entry.schedules.length > 0) continue
    const known = references.get(entry.script.id) || []
    if (known.length > 0) continue
    findings.push(auditFinding({
      category: "Workers",
      detail: `${entry.script.id} has no zone route, Email route, custom domain, workers.dev endpoint, or cron schedule discovered by this audit`,
      evidence: { handlers: entry.script.handlers || [] },
      id: `deep.worker-no-discovered-ingress:${entry.script.id}`,
      recommendation: "Review service bindings, queue consumers, workflows, and external callers before treating the script as removable",
      severity: FLEET_AUDIT_SEVERITY.REVIEW,
      title: "Worker has no discovered ingress",
    }))
  }
  return findings
}

export async function collectDeepAuditFindings(api, inventory, options = {}) {
  if (!api?.accountId || typeof api.list !== "function" || typeof api.request !== "function") {
    throw new TypeError("Deep fleet audit requires a Cloudflare API client")
  }
  const fetchImpl = options.fetchImpl || globalThis.fetch
  if (typeof fetchImpl !== "function") {
    throw new TypeError("Deep fleet audit requires fetch")
  }
  const shared = {
    concurrency: options.concurrency || DEFAULT_DEEP_AUDIT_CONCURRENCY,
    dnsTimeoutMs: options.dnsTimeoutMs || DEFAULT_DNS_TIMEOUT_MS,
    endpointTimeoutMs: options.endpointTimeoutMs || DEFAULT_ENDPOINT_TIMEOUT_MS,
    fetchImpl,
    now: options.now ?? Date.now(),
    onProgress: options.onProgress,
  }
  const findings = []
  findings.push(...await parentDsFindings(inventory, shared))
  findings.push(...await cnameTargetFindings(inventory, shared))
  findings.push(...await workerFindings(api, inventory, shared))
  findings.push(...await endpointFindings(inventory, shared))
  return findings
}
