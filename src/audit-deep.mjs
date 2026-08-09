import { request as httpsRequest } from "node:https"
import { isIP } from "node:net"

import {
  auditCnameRecords,
  auditFinding,
  FLEET_AUDIT_SEVERITY,
} from "./audit-report.mjs"
import { collectAccountAuditFindings } from "./audit-account.mjs"
import { DNSSEC_STATUS } from "./constants.mjs"
import {
  dnssecTransitionHealth,
  DNSSEC_TRANSITION_STATE,
} from "./dnssec.mjs"

const DEFAULT_DEEP_AUDIT_CONCURRENCY = 8
const DEFAULT_DNS_TIMEOUT_MS = 10000
const DEFAULT_ENDPOINT_TIMEOUT_MS = 10000
const CLOUDFLARE_DCV_TARGET_SUFFIX = ".dcv.cloudflare.com"
const ENDPOINT_TRAFFIC_ACTIVE_REQUEST_MINIMUM = 100
const ENDPOINT_TRAFFIC_WINDOW_MS = 24 * 60 * 60 * 1000
const ENDPOINT_TRAFFIC_QUERY = `
  query EndpointTraffic(
    $zoneTag: string
    $start: string
    $end: string
    $hostnames: [string]
  ) {
    viewer {
      zones(filter: { zoneTag: $zoneTag }) {
        rows: httpRequestsAdaptiveGroups(
          limit: 1000
          filter: {
            datetime_geq: $start
            datetime_lt: $end
            clientRequestHTTPHost_in: $hostnames
          }
        ) {
          count
          dimensions { clientRequestHTTPHost }
        }
      }
    }
  }
`
const DNS_ANSWER_TYPE = Object.freeze({
  A: 1,
  AAAA: 28,
  CDNSKEY: 60,
  CDS: 59,
  DS: 43,
  NS: 2,
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

function httpsHeadProbe(target) {
  return new Promise((resolve, reject) => {
    const family = isIP(target.address)
    if (family === 0) {
      reject(new Error("Endpoint probe requires an IP address"))
      return
    }
    let settled = false
    const settle = (complete, value) => {
      if (settled) return
      settled = true
      complete(value)
    }
    const request = httpsRequest({
      agent: false,
      headers: {
        Accept: "*/*",
        "User-Agent": "cloudflare-fleet-audit/1",
      },
      hostname: target.hostname,
      lookup: (_hostname, lookupOptions, callback) => {
        queueMicrotask(() => {
          if (lookupOptions?.all) {
            callback(null, [{ address: target.address, family }])
          } else {
            callback(null, target.address, family)
          }
        })
      },
      method: "HEAD",
      path: "/",
      port: 443,
      servername: target.hostname,
    }, (response) => {
      response.resume()
      settle(resolve, { status: response.statusCode || 0 })
    })
    request.setTimeout(target.timeoutMs, () => {
      request.destroy(new Error(`Endpoint probe timed out after ${target.timeoutMs}ms`))
    })
    request.on("error", (error) => settle(reject, error))
    request.end()
  })
}

async function firstSuccessfulEndpointProbe(target, addresses, options) {
  const failures = []
  for (const address of addresses) {
    try {
      return {
        address,
        response: await options.endpointProbe({
          address,
          hostname: target.hostname,
          timeoutMs: options.endpointTimeoutMs,
        }),
      }
    } catch (error) {
      failures.push(`${address}: ${errorMessage(error)}`)
    }
  }
  throw new Error(`all resolved addresses failed (${failures.join("; ")})`)
}

function normalizedDnsName(name) {
  return String(name || "").replace(/\.$/, "").toLowerCase()
}

async function delegationFindings(inventory, options) {
  const zones = inventory.zones.filter((zone) => (
    zone.meta.type === "full"
      && Array.isArray(zone.meta.name_servers)
      && zone.meta.name_servers.length > 0
  ))
  const findings = await mapPool(
    zones,
    async (zone) => {
      let payload
      try {
        payload = await dnsQuery(
          options.fetchImpl,
          zone.meta.name,
          "NS",
          options.dnsTimeoutMs,
        )
      } catch (error) {
        return auditFinding({
          category: "Delegation",
          detail: `${zone.meta.name}: ${errorMessage(error)}`,
          id: `deep.delegation-read-failed:${zone.meta.name}`,
          recommendation: "Retry the public NS lookup before drawing a conclusion about zone delegation",
          severity: FLEET_AUDIT_SEVERITY.REVIEW,
          title: "Public zone delegation could not be read",
          zones: [zone.meta.name],
        })
      }
      const expected = [...new Set(
        zone.meta.name_servers.map(normalizedDnsName).filter(Boolean),
      )].sort()
      const observed = [...new Set(
        dnsAnswers(payload, DNS_ANSWER_TYPE.NS)
          .map((answer) => normalizedDnsName(answer.data))
          .filter(Boolean),
      )].sort()
      if (expected.length === observed.length
        && expected.every((name, index) => name === observed[index])) return null
      return auditFinding({
        category: "Delegation",
        detail: `${zone.meta.name} is assigned ${expected.join(", ")}, but public DNS reports ${observed.join(", ") || "no NS answers"}`,
        evidence: {
          assignedNameservers: expected,
          dnsStatus: payload.Status,
          publicNameservers: observed,
        },
        id: `deep.delegation-nameserver-mismatch:${zone.meta.name}`,
        recommendation: "Correct the registrar delegation or confirm the zone is intentionally moving before relying on its Cloudflare configuration",
        severity: FLEET_AUDIT_SEVERITY.WARNING,
        title: "Public nameservers do not match the loaded zone",
        zones: [zone.meta.name],
      })
    },
    options.concurrency,
    (progress) => options.onProgress?.({
      ...progress,
      message: `Checking public zone delegation ${progress.completed}/${progress.total}`,
      stage: "delegation",
    }),
  )
  return findings.filter(Boolean)
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
        let childSignals = {
          cdnskey: [],
          cds: [],
          error: null,
        }
        try {
          const [cds, cdnskey] = await Promise.all([
            dnsQuery(
              options.fetchImpl,
              zone.meta.name,
              "CDS",
              options.dnsTimeoutMs,
            ),
            dnsQuery(
              options.fetchImpl,
              zone.meta.name,
              "CDNSKEY",
              options.dnsTimeoutMs,
            ),
          ])
          childSignals = {
            cdnskey: dnsAnswers(cdnskey, DNS_ANSWER_TYPE.CDNSKEY)
              .map((answer) => answer.data),
            cds: dnsAnswers(cds, DNS_ANSWER_TYPE.CDS)
              .map((answer) => answer.data),
            error: null,
          }
        } catch (error) {
          childSignals.error = errorMessage(error)
        }
        const childIsSignaling = childSignals.cds.length > 0
          || childSignals.cdnskey.length > 0
        return [auditFinding({
          category: "DNSSEC",
          detail: `${zone.meta.name} reports ${dnssec.status}, but the parent zone publishes no DS answer${childIsSignaling ? " even though the child publishes CDS or CDNSKEY data" : ""}`,
          evidence: {
            childSignals,
            dnsStatus: payload.Status,
            dnssecStatus: dnssec.status,
            modifiedOn: dnssec.modified_on || null,
          },
          id: `deep.dnssec-parent-ds-missing:${zone.meta.name}`,
          recommendation: childIsSignaling
            ? "The child is signaling DNSSEC material; inspect registrar CDS/CDNSKEY processing instead of repeating the Cloudflare status write"
            : "Review registrar delegation and child CDS/CDNSKEY publication before repeating the Cloudflare DNSSEC status write",
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

async function readEndpointTraffic(api, inventory, targets, options) {
  const traffic = new Map()
  if (targets.length === 0) {
    return { end: null, failures: [], start: null, traffic }
  }
  if (typeof api.graphql !== "function") {
    return {
      end: null,
      failures: [{
        error: "Cloudflare API client does not support GraphQL",
        zone: null,
      }],
      start: null,
      traffic,
    }
  }
  const end = new Date(options.now).toISOString()
  const start = new Date(
    new Date(options.now).valueOf() - ENDPOINT_TRAFFIC_WINDOW_MS,
  ).toISOString()
  const targetsByZone = new Map(inventory.zones.map((zone) => [
    zone.meta.name,
    targets.filter((target) => target.zones.includes(zone.meta.name)),
  ]))
  const zones = inventory.zones.filter(
    (zone) => targetsByZone.get(zone.meta.name).length > 0,
  )
  const reads = await mapPool(
    zones,
    async (zone) => {
      const zoneTargets = targetsByZone.get(zone.meta.name)
      try {
        const data = await api.graphql(ENDPOINT_TRAFFIC_QUERY, {
          end,
          hostnames: zoneTargets.map((target) => target.hostname),
          start,
          zoneTag: zone.meta.id,
        })
        const rows = data.viewer?.zones?.[0]?.rows
        if (!Array.isArray(rows)) {
          throw new TypeError("Expected endpoint traffic rows")
        }
        return { error: null, rows, zone }
      } catch (error) {
        return { error: errorMessage(error), rows: [], zone }
      }
    },
    options.concurrency,
    (progress) => options.onProgress?.({
      ...progress,
      message: `Reading endpoint traffic ${progress.completed}/${progress.total}`,
      stage: "endpoint-traffic",
    }),
  )
  for (const read of reads) {
    if (read.error) continue
    for (const target of targetsByZone.get(read.zone.meta.name)) {
      if (!traffic.has(target.hostname)) traffic.set(target.hostname, 0)
    }
    for (const row of read.rows) {
      const hostname = normalizedDnsName(
        row.dimensions?.clientRequestHTTPHost,
      )
      if (!traffic.has(hostname)) continue
      const count = Number(row.count || 0)
      if (Number.isFinite(count)) {
        traffic.set(hostname, traffic.get(hostname) + count)
      }
    }
  }
  return {
    end,
    failures: reads
      .filter((read) => read.error)
      .map((read) => ({ error: read.error, zone: read.zone.meta.name })),
    start,
    traffic,
  }
}

function endpointTrafficEvidence(read, hostname) {
  if (!read.traffic.has(hostname)) return null
  return {
    end: read.end,
    requestCount: read.traffic.get(hostname),
    start: read.start,
  }
}

function endpointTrafficReadFinding(read) {
  if (read.failures.length === 0) return null
  return auditFinding({
    category: "Endpoints",
    detail: `${read.failures.length} endpoint traffic ${read.failures.length === 1 ? "read failed" : "reads failed"}`,
    evidence: { failures: read.failures },
    id: "deep.endpoint-traffic-read-failed",
    recommendation: "Confirm the token can read zone analytics, then rerun the audit before drawing cleanup conclusions from missing endpoint traffic",
    severity: FLEET_AUDIT_SEVERITY.REVIEW,
    title: "Some endpoint traffic could not be read",
    zones: read.failures.map((failure) => failure.zone).filter(Boolean),
  })
}

async function endpointFindings(api, inventory, options) {
  const targets = publicEndpointTargets(inventory)
  const trafficRead = await readEndpointTraffic(
    api,
    inventory,
    targets,
    options,
  )
  const results = await mapPool(
    targets,
    async (target) => {
      const { hostname } = target
      const traffic = endpointTrafficEvidence(trafficRead, hostname)
      let addresses
      try {
        const [ipv4, ipv6] = await Promise.all([
          dnsQuery(options.fetchImpl, hostname, "A", options.dnsTimeoutMs),
          dnsQuery(options.fetchImpl, hostname, "AAAA", options.dnsTimeoutMs),
        ])
        addresses = [...new Set([
          ...dnsAnswers(ipv4, DNS_ANSWER_TYPE.A).map((answer) => answer.data),
          ...dnsAnswers(ipv6, DNS_ANSWER_TYPE.AAAA).map((answer) => answer.data),
        ].filter((address) => isIP(address) !== 0))]
      } catch (error) {
        return auditFinding({
          category: "Endpoints",
          detail: `https://${hostname}/ could not be resolved for probing: ${errorMessage(error)}`,
          evidence: { traffic },
          id: `deep.endpoint-unreachable:${hostname}`,
          recommendation: "Retry public DNS resolution before treating the hostname as abandoned",
          severity: FLEET_AUDIT_SEVERITY.REVIEW,
          title: "Proxied hostname could not be resolved",
          zones: target.zones,
        })
      }
      if (addresses.length === 0) {
        return auditFinding({
          category: "Endpoints",
          detail: `https://${hostname}/ has no public A or AAAA address for the endpoint probe`,
          evidence: { traffic },
          id: `deep.endpoint-unreachable:${hostname}`,
          recommendation: "Confirm the proxied DNS record is still intended before changing its configuration",
          severity: FLEET_AUDIT_SEVERITY.REVIEW,
          title: "Proxied hostname has no public address",
          zones: target.zones,
        })
      }
      try {
        const probe = await firstSuccessfulEndpointProbe(
          target,
          addresses,
          options,
        )
        const { response } = probe
        if (response.status < 500) return null
        return auditFinding({
          category: "Endpoints",
          detail: `https://${hostname}/ returned HTTP ${response.status}`,
          evidence: {
            address: probe.address,
            status: response.status,
            traffic,
          },
          id: `deep.endpoint-http-${response.status}:${hostname}`,
          recommendation: traffic?.requestCount
            >= ENDPOINT_TRAFFIC_ACTIVE_REQUEST_MINIMUM
            ? "Traffic reached this hostname during the analytics window; repair its Worker route, custom domain, origin, or Cloudflare product binding instead of treating the error as evidence that it is unused"
            : "Confirm the hostname is still intended, then inspect its Worker route, custom domain, origin, or Cloudflare product binding",
          severity: FLEET_AUDIT_SEVERITY.WARNING,
          title: "Proxied hostname returned a server error",
          zones: target.zones,
        })
      } catch (error) {
        return auditFinding({
          category: "Endpoints",
          detail: `https://${hostname}/ could not be reached: ${errorMessage(error)}`,
          evidence: { traffic },
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
  const trafficReadFinding = endpointTrafficReadFinding(trafficRead)
  const unreachable = findings.filter(
    (entry) => entry.id.startsWith("deep.endpoint-unreachable:"),
  )
  if (unreachable.length === 0) {
    return trafficReadFinding ? [...findings, trafficReadFinding] : findings
  }
  return [
    ...findings.filter((entry) => !entry.id.startsWith("deep.endpoint-unreachable:")),
    auditFinding({
      category: "Endpoints",
      detail: `${unreachable.length} of ${targets.length} proxied HTTPS endpoints could not complete a header-only request`,
      evidence: {
        endpoints: unreachable.map((entry) => ({
          detail: entry.detail,
          hostname: entry.id.slice("deep.endpoint-unreachable:".length),
          traffic: entry.evidence?.traffic || null,
        })),
      },
      id: "deep.endpoints-unreachable",
      recommendation: "Triage the listed hostnames in batches and confirm intent before removing DNS, routes, custom domains, or origin configuration",
      severity: FLEET_AUDIT_SEVERITY.REVIEW,
      title: "Some proxied hostnames could not be reached",
      zones: unreachable.flatMap((entry) => entry.zones),
    }),
    ...(trafficReadFinding ? [trafficReadFinding] : []),
  ]
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
    endpointProbe: options.endpointProbe || httpsHeadProbe,
    fetchImpl,
    now: options.now ?? Date.now(),
    onProgress: options.onProgress,
  }
  const findings = []
  findings.push(...await delegationFindings(inventory, shared))
  findings.push(...await parentDsFindings(inventory, shared))
  findings.push(...await cnameTargetFindings(inventory, shared))
  findings.push(...await collectAccountAuditFindings(api, inventory, shared))
  findings.push(...await endpointFindings(api, inventory, shared))
  return findings
}
