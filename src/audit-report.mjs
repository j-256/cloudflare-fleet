import {
  FLEET_INTENT_ACKNOWLEDGEMENT_STATUS,
  FLEET_INTENT_COVERAGE_EXPECTATION_STATUS,
  evaluateFleetIntent,
  evaluateFleetIntentCoverage,
  fleetIntentFacetId,
} from "./fleet-intent.mjs"
import {
  dnssecTransitionHealth,
  DNSSEC_TRANSITION_STATE,
} from "./dnssec.mjs"
import {
  coverageFor,
  staticCoverageIssues,
} from "./inventory.mjs"
import { buildMatrix } from "./matrix.mjs"
import { stableString } from "./normalize.mjs"
import {
  deriveEmailDestination,
  deriveEmailDnsPolicy,
  deriveFleetWafPolicies,
  editableDnsRecordPayload,
  emailIssues,
  evaluateFleetEmailPolicyExceptions,
  wafIssues,
} from "./policies.mjs"
import {
  configuredEmailPolicyExceptions,
  emailPolicyExceptionsForZone,
} from "./fleet-policy.mjs"
import {
  POLICY_EXCEPTION_STATUS,
  RULESET_KIND,
  STATIC_LIMITATIONS,
} from "./constants.mjs"
import {
  isZoneAliasFacet,
  ZONE_ALIAS_CATEGORY,
  ZONE_ALIAS_KEY,
} from "./zone-alias-intent.mjs"

export const FLEET_AUDIT_SCHEMA_VERSION = 1

export const FLEET_AUDIT_SEVERITY = Object.freeze({
  CRITICAL: "critical",
  WARNING: "warning",
  REVIEW: "review",
  INFO: "info",
})

const AUDIT_SEVERITY_PRIORITY = Object.freeze({
  [FLEET_AUDIT_SEVERITY.CRITICAL]: 0,
  [FLEET_AUDIT_SEVERITY.WARNING]: 1,
  [FLEET_AUDIT_SEVERITY.REVIEW]: 2,
  [FLEET_AUDIT_SEVERITY.INFO]: 3,
})
const DNS_RECORD_TYPE_CNAME = "CNAME"
const DNS_RECORD_TYPE_TXT = "TXT"
const DISABLED_RULE_DORMANT_MS = 365 * 24 * 60 * 60 * 1000
const ARCHIVED_RULE_DESCRIPTION_PATTERN = /^\[ARCHIVED\]\s/i
const PROXIED_WEB_RECORD_TYPES = new Set(["A", "AAAA", "CNAME"])
const LEGACY_MINIMUM_TLS_VERSION = new Set(["1.0", "1.1"])
const EDITABLE_RULESET_KINDS = new Set([
  RULESET_KIND.CUSTOM,
  RULESET_KIND.ZONE,
])
const HTML_ESCAPE = Object.freeze({
  "&": "&amp;",
  "'": "&#39;",
  "<": "&lt;",
  ">": "&gt;",
  "\"": "&quot;",
})

function surfaceResult(zone, surfaceId) {
  const surface = zone.surfaces?.[surfaceId]
  return surface?.ok ? surface.result : null
}

function finding(id, severity, category, title, detail, options = {}) {
  return {
    category,
    detail,
    evidence: options.evidence || {},
    id,
    recommendation: options.recommendation || "Review the live resource before changing it",
    severity,
    title,
    zones: [...new Set((options.zones || []).filter(Boolean))].sort(),
  }
}

function plural(count, singular, pluralValue = `${singular}s`) {
  return count === 1 ? singular : pluralValue
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => HTML_ESCAPE[character])
}

function normalizedDnsName(name) {
  return String(name || "").replace(/\.$/, "").toLowerCase()
}

function normalizedTxtContent(content) {
  return String(content || "")
    .replace(/"\s+"/g, "")
    .replace(/^"/, "")
    .replace(/"$/, "")
}

// Stable, order-independent hash (djb2) used to disambiguate finding
// identifiers when the underlying records carry no server-assigned id
function stableHash(value) {
  let hash = 5381
  const text = String(value)
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) + hash + text.charCodeAt(index)) >>> 0
  }
  return hash.toString(36)
}

function coverageFindings(inventory, intent) {
  const issues = [
    ...coverageFor(inventory).flatMap((surface) => surface.failed),
    ...staticCoverageIssues(STATIC_LIMITATIONS),
  ]
  const evaluation = intent ? evaluateFleetIntentCoverage(intent, issues) : null
  const unexpected = evaluation
    ? evaluation.unexpectedIssues.map((entry) => entry.issue)
    : issues
  const grouped = new Map()
  for (const issue of unexpected) {
    if (!grouped.has(issue.subjectId)) grouped.set(issue.subjectId, [])
    grouped.get(issue.subjectId).push(issue)
  }
  const findings = [...grouped.entries()].map(([surfaceId, entries]) => {
    const fleetWide = entries.every((entry) => entry.zoneName === null)
    return finding(
      `coverage.unexpected:${surfaceId}`,
      FLEET_AUDIT_SEVERITY.WARNING,
      "Coverage",
      fleetWide
        ? `${entries[0].subjectLabel} has an unexpected fleet-wide read limitation`
        : `${entries[0].subjectLabel} could not be read across part of the fleet`,
      fleetWide
        ? entries[0].detail
        : `${entries.length} zone ${plural(entries.length, "read")} failed without a matching saved coverage expectation`,
      {
        evidence: {
          failures: entries.map((entry) => ({
            detail: entry.detail,
            status: entry.error?.status ?? null,
            zone: entry.zoneName,
          })),
        },
        recommendation: "Confirm whether the surface is unsupported by plan or permission, then save an exact coverage expectation only when the gap is intentional",
        zones: entries.map((entry) => entry.zoneName),
      },
    )
  })
  const staleExpectations = evaluation?.expectationStates.filter(
    (entry) => entry.status === FLEET_INTENT_COVERAGE_EXPECTATION_STATUS.CHANGED
      || entry.status === FLEET_INTENT_COVERAGE_EXPECTATION_STATUS.INACTIVE,
  ) || []
  if (staleExpectations.length > 0) {
    findings.push(finding(
      "coverage.expectations-need-review",
      FLEET_AUDIT_SEVERITY.REVIEW,
      "Coverage",
      "Saved coverage expectations no longer match the loaded inventory",
      `${staleExpectations.length} coverage ${plural(staleExpectations.length, "expectation")} ${staleExpectations.length === 1 ? "is" : "are"} changed or inactive`,
      {
        evidence: {
          expectations: staleExpectations.map((entry) => ({
            id: entry.expectation.id,
            status: entry.status,
            subject: entry.expectation.subjectLabel,
            zone: entry.expectation.zoneName,
          })),
        },
        recommendation: "Remove inactive expectations and replace changed expectations only after confirming the new read failure is intentional",
        zones: staleExpectations.map((entry) => entry.expectation.zoneName).filter(Boolean),
      },
    ))
  }
  return findings
}

function intentFindings(evaluation) {
  if (!evaluation) return []
  const findings = []
  if (evaluation.summary.actionableCells > 0) {
    const actionable = [...evaluation.rowStates.values()].flatMap((rowState) => (
      rowState.actionableCells.map((cell) => ({
        facet: rowState.row.label,
        status: cell.status,
        zone: cell.zone.meta.name,
      }))
    ))
    findings.push(finding(
      "intent.actionable-drift",
      FLEET_AUDIT_SEVERITY.WARNING,
      "Fleet intent",
      "Loaded configuration does not fully satisfy saved fleet intent",
      `${evaluation.summary.actionableCells} actionable ${plural(evaluation.summary.actionableCells, "cell")} affect ${evaluation.summary.actionableZones} ${plural(evaluation.summary.actionableZones, "zone")}`,
      {
        evidence: { cells: actionable },
        recommendation: "Review each mismatch in the dashboard and either align it, refine the policy, or acknowledge the exact observed state with a reason",
        zones: actionable.map((entry) => entry.zone),
      },
    ))
  }
  if (evaluation.summary.unresolvedPolicies > 0) {
    const policies = evaluation.policyStates
      .filter((entry) => entry.unresolved)
      .map((entry) => ({
        id: entry.policy.id,
        label: entry.policy.facet.label,
        reason: entry.reason,
      }))
    findings.push(finding(
      "intent.unresolved-policies",
      FLEET_AUDIT_SEVERITY.WARNING,
      "Fleet intent",
      "Saved fleet intent contains policies that cannot be evaluated",
      `${policies.length} saved ${plural(policies.length, "policy", "policies")} need review`,
      {
        evidence: { policies },
        recommendation: "Repair missing facet or group references before treating the fleet as aligned",
      },
    ))
  }
  const stale = evaluation.acknowledgementStates.filter(
    (entry) => entry.status === FLEET_INTENT_ACKNOWLEDGEMENT_STATUS.STALE,
  )
  if (stale.length > 0) {
    findings.push(finding(
      "intent.stale-acknowledgements",
      FLEET_AUDIT_SEVERITY.REVIEW,
      "Fleet intent",
      "Saved fleet intent acknowledgements are stale",
      `${stale.length} ${plural(stale.length, "acknowledgement")} no longer matches its exact saved context`,
      {
        evidence: {
          acknowledgements: stale.map((entry) => ({
            id: entry.acknowledgement.id,
            reason: entry.reason,
            zone: entry.acknowledgement.zoneName,
          })),
        },
        recommendation: "Remove stale acknowledgements or replace them only after reviewing the new observed state",
        zones: stale.map((entry) => entry.acknowledgement.zoneName),
      },
    ))
  }
  return findings
}

function aliasBehaviorValue(value) {
  return {
    redirect: value?.redirect ?? null,
    resourceEnvelope: value?.resourceEnvelope ?? null,
    servingDns: value?.servingDns ?? null,
  }
}

function aliasIntentFindings(evaluation) {
  if (!evaluation) return []
  const rowState = evaluation.rowStates.get(
    fleetIntentFacetId(ZONE_ALIAS_CATEGORY, ZONE_ALIAS_KEY),
  )
  if (!rowState?.governed) return []
  const findings = []
  for (const cell of rowState.cells.values()) {
    const policy = cell.policies?.find((entry) => isZoneAliasFacet(entry.facet))
      || (isZoneAliasFacet(cell.policy?.facet) ? cell.policy : null)
    if (!policy) continue
    const observed = rowState.row.cells.get(cell.zone.meta.name)?.intentValue
    const desired = policy.expected?.value
    const canonicalOwner = desired?.redirect?.targetHost || null
    if (stableString(aliasBehaviorValue(observed))
      !== stableString(aliasBehaviorValue(desired))) {
      findings.push(finding(
        `alias.behavior:${cell.zone.meta.id}`,
        FLEET_AUDIT_SEVERITY.WARNING,
        ZONE_ALIAS_CATEGORY,
        "A compatibility zone does not preserve its canonical passthrough",
        `${cell.zone.meta.name} does not match its saved redirect or serving DNS invariant`,
        {
          evidence: {
            canonicalOwner,
            desired: aliasBehaviorValue(desired),
            observed: aliasBehaviorValue(observed),
          },
          recommendation: "Review a fresh exact alignment plan for the canonical redirect and preserve required serving DNS",
          zones: [cell.zone.meta.name],
        },
      ))
    }
    for (const resource of observed?.unexpectedResources || []) {
      findings.push(finding(
        `alias.unexpected:${cell.zone.meta.id}:${stableHash(stableString(resource))}`,
        FLEET_AUDIT_SEVERITY.WARNING,
        ZONE_ALIAS_CATEGORY,
        "Independent web behavior is attached to a compatibility zone",
        `${cell.zone.meta.name} contains ${resource.label} on ${resource.surface}`,
        {
          evidence: {
            canonicalOwner,
            resource,
          },
          recommendation: resource.remediation === "unsupported"
            ? `Move the behavior to ${canonicalOwner || "the canonical zone"}, then remove it through its product-specific reviewed workflow`
            : `Move any required behavior to ${canonicalOwner || "the canonical zone"}, then review the reversible alias alignment plan`,
          zones: [cell.zone.meta.name],
        },
      ))
    }
    for (const surface of observed?.unreadSurfaces || []) {
      findings.push(finding(
        `alias.unread:${cell.zone.meta.id}:${stableHash(stableString(surface))}`,
        FLEET_AUDIT_SEVERITY.WARNING,
        ZONE_ALIAS_CATEGORY,
        "Compatibility-zone behavior could not be fully inspected",
        `${cell.zone.meta.name} could not prove the ${surface.id} surface is free of independent behavior`,
        {
          evidence: {
            canonicalOwner,
            surface,
          },
          recommendation: "Restore read coverage before treating the alias as aligned or attempting cleanup",
          zones: [cell.zone.meta.name],
        },
      ))
    }
  }
  return findings
}

function dnssecFindings(inventory, now) {
  const findings = []
  for (const zone of inventory.zones) {
    const dnssec = surfaceResult(zone, "dnssec")
    if (!dnssec) continue
    const health = dnssecTransitionHealth(dnssec, { now })
    if (health.state === DNSSEC_TRANSITION_STATE.COMPLETE) continue
    if (health.state === DNSSEC_TRANSITION_STATE.PROPAGATING) {
      findings.push(finding(
        `dnssec.propagating:${zone.meta.name}`,
        FLEET_AUDIT_SEVERITY.INFO,
        "DNSSEC",
        "DNSSEC transition is propagating",
        `${zone.meta.name} reports ${health.status}${health.modifiedAt ? ` since ${health.modifiedAt}` : " without a usable modification time"}`,
        {
          evidence: health,
          recommendation: "Allow the registrar transition window to complete before intervening",
          zones: [zone.meta.name],
        },
      ))
      continue
    }
    const failed = health.state === DNSSEC_TRANSITION_STATE.FAILED
    findings.push(finding(
      `${failed ? "dnssec.failed" : health.state === DNSSEC_TRANSITION_STATE.STALLED ? "dnssec.stalled" : "dnssec.unknown"}:${zone.meta.name}`,
      failed ? FLEET_AUDIT_SEVERITY.CRITICAL : FLEET_AUDIT_SEVERITY.WARNING,
      "DNSSEC",
      failed
        ? "DNSSEC reports a failed transition"
        : health.state === DNSSEC_TRANSITION_STATE.STALLED
          ? "DNSSEC transition exceeded the propagation window"
          : "DNSSEC reports an unknown status",
      `${zone.meta.name} reports ${health.status || "no status"}${health.modifiedAt ? ` since ${health.modifiedAt}` : ""}`,
      {
        evidence: health,
        recommendation: failed
          ? "Inspect the DNSSEC response and registrar state before retrying"
          : health.state === DNSSEC_TRANSITION_STATE.STALLED
            ? "Inspect parent DS publication and Cloudflare Registrar state instead of repeating the same status write"
            : "Inspect the raw DNSSEC response before deciding whether a change is needed",
        zones: [zone.meta.name],
      },
    ))
  }
  return findings
}

function emailFindings(inventory, policyConfiguration) {
  const findings = []
  const destination = deriveEmailDestination(inventory)
  const dnsPolicy = deriveEmailDnsPolicy(inventory)
  if (!destination.available || !dnsPolicy.available) {
    const reasons = [
      destination.available ? "" : destination.reason,
      dnsPolicy.available ? "" : dnsPolicy.reason,
    ].filter(Boolean)
    findings.push(finding(
      "email.fleet-policy-unavailable",
      FLEET_AUDIT_SEVERITY.WARNING,
      "Email Routing",
      "A unique fleet Email Routing policy could not be derived",
      reasons.join("; "),
      {
        recommendation: "Review forwarding, SPF, and DMARC variants before using fleet alignment",
      },
    ))
  } else {
    for (const zone of inventory.zones) {
      const required = ["dns", "email", "email-catch-all", "email-dns"]
      if (required.some((surfaceId) => !zone.surfaces?.[surfaceId]?.ok)) continue
      const issues = emailIssues(zone, destination.email, dnsPolicy, {
        exceptions: emailPolicyExceptionsForZone(
          zone.meta.name,
          policyConfiguration,
        ),
      })
      if (issues.length === 0) continue
      findings.push(finding(
        `email.policy-drift:${zone.meta.name}`,
        FLEET_AUDIT_SEVERITY.WARNING,
        "Email Routing",
        "Email Routing differs from the derived fleet policy",
        `${zone.meta.name}: ${issues.join("; ")}`,
        {
          evidence: { issues },
          recommendation: "Review the generated Email Routing alignment plan before applying any changes",
          zones: [zone.meta.name],
        },
      ))
    }
  }
  const exceptions = evaluateFleetEmailPolicyExceptions(
    inventory,
    dnsPolicy,
    policyConfiguration
      ? policyConfiguration.emailDnsRecordExceptions
      : configuredEmailPolicyExceptions(),
  ).filter((entry) => entry.status === POLICY_EXCEPTION_STATUS.UNAVAILABLE
    || entry.status === POLICY_EXCEPTION_STATUS.VIOLATED)
  for (const exception of exceptions) {
    findings.push(finding(
      `email.exception-${exception.status}:${exception.zoneName}:${exception.component}`,
      exception.status === POLICY_EXCEPTION_STATUS.VIOLATED
        ? FLEET_AUDIT_SEVERITY.WARNING
        : FLEET_AUDIT_SEVERITY.REVIEW,
      "Email Routing",
      `Configured Email policy exception is ${exception.status}`,
      `${exception.zoneName}: ${exception.detail}`,
      {
        evidence: {
          component: exception.component,
          current: exception.current,
          expected: exception.expected,
        },
        recommendation: "Confirm whether the exception remains intentional and update only its exact durable definition",
        zones: [exception.zoneName],
      },
    ))
  }
  return findings
}

function wafFindings(inventory) {
  const policies = deriveFleetWafPolicies(inventory)
  const findings = []
  for (const zone of inventory.zones) {
    if (!zone.surfaces?.rulesets?.ok) continue
    const issues = wafIssues(zone, policies)
    if (issues.length === 0) continue
    findings.push(finding(
      `waf.policy-drift:${zone.meta.name}`,
      FLEET_AUDIT_SEVERITY.WARNING,
      "WAF",
      "Fleet WAF rules differ from consensus",
      `${zone.meta.name}: ${issues.join("; ")}`,
      {
        evidence: { issues },
        recommendation: "Review the live WAF alignment plan and preserve intentional zone-specific rules",
        zones: [zone.meta.name],
      },
    ))
  }
  return findings
}

function settingFor(zone, settingId) {
  const settings = surfaceResult(zone, "settings")
  if (!Array.isArray(settings)) return null
  return settings.find((setting) => setting.id === settingId) || null
}

function hasProxiedWebRecord(zone) {
  const records = surfaceResult(zone, "dns")
  return Array.isArray(records) && records.some((record) => (
    record.proxied === true
      && PROXIED_WEB_RECORD_TYPES.has(String(record.type || "").toUpperCase())
  ))
}

function securityPostureFindings(inventory) {
  const webZones = inventory.zones.filter(hasProxiedWebRecord)
  const legacyTls = webZones.flatMap((zone) => {
    const setting = settingFor(zone, "min_tls_version")
    if (!setting || !LEGACY_MINIMUM_TLS_VERSION.has(String(setting.value))) {
      return []
    }
    return [{ value: setting.value, zone: zone.meta.name }]
  })
  const originModes = webZones.flatMap((zone) => {
    const setting = settingFor(zone, "ssl")
    if (!setting || setting.value !== "full") return []
    return [{ value: setting.value, zone: zone.meta.name }]
  })
  const insecureOriginModes = webZones.flatMap((zone) => {
    const setting = settingFor(zone, "ssl")
    if (!setting || (setting.value !== "off" && setting.value !== "flexible")) {
      return []
    }
    return [{ value: setting.value, zone: zone.meta.name }]
  })
  const httpAllowed = webZones.flatMap((zone) => {
    const setting = settingFor(zone, "always_use_https")
    if (!setting || setting.value !== "off") return []
    return [{ value: setting.value, zone: zone.meta.name }]
  })
  const findings = []
  if (legacyTls.length > 0) {
    findings.push(finding(
      "security.legacy-edge-tls",
      FLEET_AUDIT_SEVERITY.WARNING,
      "Security posture",
      "Proxied hostnames accept legacy TLS versions",
      `${legacyTls.length} ${plural(legacyTls.length, "zone")} allow a minimum TLS version older than 1.2`,
      {
        evidence: { settings: legacyTls },
        recommendation: "Validate legacy client requirements, then raise the minimum edge TLS version to 1.2 or newer",
        zones: legacyTls.map((entry) => entry.zone),
      },
    ))
  }
  if (insecureOriginModes.length > 0) {
    findings.push(finding(
      "security.insecure-origin-mode",
      FLEET_AUDIT_SEVERITY.WARNING,
      "Security posture",
      "Origin traffic is not consistently encrypted",
      `${insecureOriginModes.length} ${plural(insecureOriginModes.length, "zone")} use Off or Flexible SSL mode`,
      {
        evidence: { settings: insecureOriginModes },
        recommendation: "Configure origin TLS, then move to Full (strict) after validating certificate coverage",
        zones: insecureOriginModes.map((entry) => entry.zone),
      },
    ))
  }
  if (originModes.length > 0) {
    findings.push(finding(
      "security.origin-certificate-unverified",
      FLEET_AUDIT_SEVERITY.REVIEW,
      "Security posture",
      "Origin certificates are not validated",
      `${originModes.length} ${plural(originModes.length, "zone")} use Full rather than Full (strict) SSL mode`,
      {
        evidence: { settings: originModes },
        recommendation: "Confirm each origin presents a valid matching certificate, then prefer Full (strict) when possible",
        zones: originModes.map((entry) => entry.zone),
      },
    ))
  }
  if (httpAllowed.length > 0) {
    findings.push(finding(
      "security.http-not-redirected",
      FLEET_AUDIT_SEVERITY.REVIEW,
      "Security posture",
      "HTTP requests are not forced to HTTPS at the edge",
      `${httpAllowed.length} ${plural(httpAllowed.length, "zone")} have Always Use HTTPS disabled despite serving proxied web records`,
      {
        evidence: { settings: httpAllowed },
        recommendation: "Confirm no hostname requires HTTP, account for existing redirects, then enable Always Use HTTPS or define equivalent scoped redirects",
        zones: httpAllowed.map((entry) => entry.zone),
      },
    ))
  }
  return findings
}

function settingDriftFindings(inventory, matrix) {
  const zoneNameById = new Map(
    inventory.zones.map((zone) => [zone.meta.id, zone.meta.name]),
  )
  const rows = matrix.rows.filter((row) => row.category === "Zone settings"
    && row.different
    && [...row.cells.values()].some((cell) => cell.action?.type === "zone-setting"))
  if (rows.length === 0) return []
  const facets = rows.map((row) => {
    const variants = new Map()
    for (const [zoneName, cell] of row.cells) {
      const label = cell.display || cell.canonical
      if (!variants.has(label)) variants.set(label, [])
      variants.get(label).push(zoneName)
    }
    if (row.missingCount > 0) {
      variants.set("Missing", row.missingZoneIds.map(
        (zoneId) => zoneNameById.get(zoneId) || zoneId,
      ))
    }
    return {
      key: row.key,
      label: row.label,
      variants: [...variants.entries()].map(([value, zones]) => ({
        value,
        zones: zones.sort(),
      })),
    }
  })
  return [finding(
    "settings.editable-drift",
    FLEET_AUDIT_SEVERITY.REVIEW,
    "Zone settings",
    "Editable zone settings differ across the fleet",
    `${facets.length} editable setting ${plural(facets.length, "facet")} ${facets.length === 1 ? "differs" : "differ"}`,
    {
      evidence: { facets },
      recommendation: "Define fleet intent for settings that should align and leave deliberate differences ungoverned or explicitly scoped",
      zones: facets.flatMap((facet) => facet.variants.flatMap((variant) => variant.zones)),
    },
  )]
}

function dnsRecordFindings(inventory) {
  const findings = []
  for (const zone of inventory.zones) {
    const records = surfaceResult(zone, "dns")
    if (!Array.isArray(records)) continue
    const duplicates = new Map()
    for (const record of records) {
      const canonical = stableString(editableDnsRecordPayload(record))
      if (!duplicates.has(canonical)) duplicates.set(canonical, [])
      duplicates.get(canonical).push(record)
    }
    for (const [canonical, duplicate] of duplicates) {
      if (duplicate.length <= 1) continue
      const record = duplicate[0]
      // Prefer server-assigned record ids; fall back to a hash of the canonical
      // value so two id-less duplicate groups at one host cannot collide
      const idSuffix = duplicate.every((entry) => entry.id)
        ? duplicate.map((entry) => entry.id).sort().join(",")
        : `hash-${stableHash(canonical)}`
      findings.push(finding(
        `dns.exact-duplicate:${zone.meta.name}:${record.type}:${normalizedDnsName(record.name)}:${idSuffix}`,
        FLEET_AUDIT_SEVERITY.WARNING,
        "DNS",
        "Exact duplicate DNS records are present",
        `${zone.meta.name} has ${duplicate.length} equivalent ${record.type} records at ${record.name}`,
        {
          evidence: {
            recordIds: duplicate.map((entry) => entry.id || null).sort(),
            value: editableDnsRecordPayload(record),
          },
          recommendation: "Confirm no external workflow relies on separate record identifiers before removing duplicates",
          zones: [zone.meta.name],
        },
      ))
    }

    const apex = normalizedDnsName(zone.meta.name)
    const spf = records.filter((record) => record.type === DNS_RECORD_TYPE_TXT
      && normalizedDnsName(record.name) === apex
      && normalizedTxtContent(record.content).toLowerCase().startsWith("v=spf1 "))
    if (spf.length > 1) {
      findings.push(finding(
        `dns.multiple-spf:${zone.meta.name}`,
        FLEET_AUDIT_SEVERITY.CRITICAL,
        "DNS",
        "Multiple apex SPF records are published",
        `${zone.meta.name} has ${spf.length} apex SPF records`,
        {
          evidence: { recordIds: spf.map((record) => record.id || null).sort() },
          recommendation: "Merge the intended sender policy into one SPF record after validating every include and sender",
          zones: [zone.meta.name],
        },
      ))
    }
    const dmarcName = `_dmarc.${apex}`
    const dmarc = records.filter((record) => record.type === DNS_RECORD_TYPE_TXT
      && normalizedDnsName(record.name) === dmarcName
      && normalizedTxtContent(record.content).toLowerCase().startsWith("v=dmarc1;"))
    if (dmarc.length > 1) {
      findings.push(finding(
        `dns.multiple-dmarc:${zone.meta.name}`,
        FLEET_AUDIT_SEVERITY.CRITICAL,
        "DNS",
        "Multiple DMARC records are published",
        `${zone.meta.name} has ${dmarc.length} DMARC records`,
        {
          evidence: { recordIds: dmarc.map((record) => record.id || null).sort() },
          recommendation: "Consolidate the intended policy into one DMARC record after reviewing reporting destinations",
          zones: [zone.meta.name],
        },
      ))
    }
    // Publishing SPF declares the domain sends mail, so a DMARC policy should
    // accompany it; without one, receivers get no anti-spoofing instruction or
    // reporting visibility (a missing SPF implies no such declaration)
    if (spf.length > 0 && dmarc.length === 0) {
      findings.push(finding(
        `dns.spf-without-dmarc:${zone.meta.name}`,
        FLEET_AUDIT_SEVERITY.WARNING,
        "DNS",
        "An SPF record is published without a DMARC policy",
        `${zone.meta.name} publishes an apex SPF record but has no ${dmarcName} policy record`,
        {
          evidence: {
            dmarcName,
            spfRecordIds: spf.map((record) => record.id || null).sort(),
          },
          recommendation: "Add a DMARC policy record at the expected name to complete SPF-based email authentication and gain reporting visibility, starting at p=none before enforcing",
          zones: [zone.meta.name],
        },
      ))
    }
  }
  return findings
}

function rulesetFindings(inventory, now) {
  const findings = []
  for (const zone of inventory.zones) {
    for (const detail of zone.ruleDetails || []) {
      if (!detail.ok || !EDITABLE_RULESET_KINDS.has(detail.result?.kind)) continue
      const ruleset = detail.result
      const rules = Array.isArray(ruleset.rules) ? ruleset.rules : []
      if (rules.length === 0) {
        const lastUpdated = typeof ruleset.last_updated === "string"
          && Number.isFinite(Date.parse(ruleset.last_updated))
          ? ruleset.last_updated
          : null
        findings.push(finding(
          `ruleset.empty:${zone.meta.name}:${ruleset.id}`,
          FLEET_AUDIT_SEVERITY.REVIEW,
          "Rulesets",
          "An editable ruleset is empty",
          `${zone.meta.name}: ${ruleset.name || ruleset.phase || ruleset.id} has no rules`,
          {
            evidence: {
              kind: ruleset.kind,
              lastUpdated,
              phase: ruleset.phase,
              rulesetId: ruleset.id,
            },
            recommendation: "Confirm the empty entrypoint is not retained for an external deployment before deleting it",
            zones: [zone.meta.name],
          },
        ))
      }
      const disabled = rules.filter((rule) => rule.enabled === false)
      if (disabled.length > 0) {
        const disabledEvidence = disabled.map((rule) => {
          const lastUpdated = typeof rule.last_updated === "string"
            && Number.isFinite(Date.parse(rule.last_updated))
            ? rule.last_updated
            : null
          const cleanupReason = ARCHIVED_RULE_DESCRIPTION_PATTERN.test(
            rule.description || "",
          )
            ? "archived-description"
            : lastUpdated && now - Date.parse(lastUpdated) > DISABLED_RULE_DORMANT_MS
              ? "unchanged-over-one-year"
              : null
          return {
            cleanupReason,
            description: rule.description || "",
            id: rule.id || null,
            lastUpdated,
          }
        })
        const cleanupCandidates = disabledEvidence.filter(
          (rule) => rule.cleanupReason !== null,
        )
        findings.push(finding(
          `ruleset.disabled-rules:${zone.meta.name}:${ruleset.id}`,
          FLEET_AUDIT_SEVERITY.REVIEW,
          "Rulesets",
          "Disabled rules remain in an editable ruleset",
          `${zone.meta.name}: ${disabled.length} disabled ${plural(disabled.length, "rule")} in ${ruleset.name || ruleset.phase || ruleset.id}${cleanupCandidates.length > 0 ? `; ${cleanupCandidates.length} ${cleanupCandidates.length === 1 ? "is" : "are"} explicitly archived or dormant` : ""}`,
          {
            evidence: {
              phase: ruleset.phase,
              rules: disabledEvidence,
              rulesetId: ruleset.id,
            },
            recommendation: cleanupCandidates.length > 0
              ? "Prioritize explicitly archived and long-dormant rules for removal after confirming no rollback workflow still needs them"
              : "Confirm whether each rule is intentionally parked, should be re-enabled, or can be removed",
            zones: [zone.meta.name],
          },
        ))
      }
      const descriptions = new Map()
      for (const rule of rules) {
        const description = String(rule.description || "").trim()
        if (!description) continue
        if (!descriptions.has(description)) descriptions.set(description, [])
        descriptions.get(description).push(rule.id || null)
      }
      for (const [description, ruleIds] of descriptions) {
        if (ruleIds.length < 2) continue
        findings.push(finding(
          `ruleset.duplicate-description:${zone.meta.name}:${ruleset.id}:${description}`,
          FLEET_AUDIT_SEVERITY.REVIEW,
          "Rulesets",
          "Rules in one ruleset share a description",
          `${zone.meta.name}: ${ruleIds.length} rules are named ${description}`,
          {
            evidence: { description, ruleIds: ruleIds.sort(), rulesetId: ruleset.id },
            recommendation: "Give independently managed rules unique descriptions so fleet identity and manual review remain unambiguous",
            zones: [zone.meta.name],
          },
        ))
      }
    }
  }
  return findings
}

function tlsFindings(inventory) {
  const findings = []
  for (const zone of inventory.zones) {
    const universal = surfaceResult(zone, "universal-ssl")
    if (universal && universal.enabled !== true) {
      findings.push(finding(
        `tls.universal-disabled:${zone.meta.name}`,
        FLEET_AUDIT_SEVERITY.WARNING,
        "TLS",
        "Universal SSL is disabled",
        `${zone.meta.name} reports Universal SSL enabled=${String(universal.enabled)}`,
        {
          evidence: { enabled: universal.enabled },
          recommendation: "Confirm another certificate path covers every hostname before leaving Universal SSL disabled",
          zones: [zone.meta.name],
        },
      ))
    }
    const packs = surfaceResult(zone, "certificate-packs")
    if (Array.isArray(packs) && !packs.some((pack) => pack.status === "active")) {
      findings.push(finding(
        `tls.no-active-certificate-pack:${zone.meta.name}`,
        FLEET_AUDIT_SEVERITY.WARNING,
        "TLS",
        "No active certificate pack is visible",
        `${zone.meta.name} has ${packs.length} certificate ${plural(packs.length, "pack")} and none reports active`,
        {
          evidence: { statuses: packs.map((pack) => pack.status || null) },
          recommendation: "Confirm edge certificate issuance and hostname coverage before changing TLS settings",
          zones: [zone.meta.name],
        },
      ))
    }
  }
  return findings
}

function sortedFindings(findings) {
  const unique = new Map()
  for (const entry of findings) {
    if (unique.has(entry.id)) {
      throw new TypeError(`Duplicate fleet audit finding identifier: ${entry.id}`)
    }
    unique.set(entry.id, entry)
  }
  return [...unique.values()].sort((left, right) => (
    AUDIT_SEVERITY_PRIORITY[left.severity] - AUDIT_SEVERITY_PRIORITY[right.severity]
      || left.category.localeCompare(right.category)
      || left.id.localeCompare(right.id)
  ))
}

export function buildFleetAudit(inventory, options = {}) {
  if (!inventory?.account?.id || !Array.isArray(inventory.zones)) {
    throw new TypeError("Fleet audit requires a loaded inventory")
  }
  const now = options.now instanceof Date ? options.now.valueOf() : options.now ?? Date.now()
  if (!Number.isFinite(now)) throw new TypeError("Fleet audit requires a valid generation time")
  const matrix = buildMatrix(inventory)
  const intent = options.intent || null
  const evaluation = intent ? evaluateFleetIntent(intent, inventory, matrix) : null
  const findings = sortedFindings([
    ...coverageFindings(inventory, intent),
    ...intentFindings(evaluation),
    ...aliasIntentFindings(evaluation),
    ...dnssecFindings(inventory, now),
    ...emailFindings(inventory, options.policyConfiguration),
    ...wafFindings(inventory),
    ...securityPostureFindings(inventory),
    ...settingDriftFindings(inventory, matrix),
    ...dnsRecordFindings(inventory),
    ...rulesetFindings(inventory, now),
    ...tlsFindings(inventory),
    ...(options.deepFindings || []),
  ])
  const severity = Object.fromEntries(
    Object.values(FLEET_AUDIT_SEVERITY).map((level) => [
      level,
      findings.filter((entry) => entry.severity === level).length,
    ]),
  )
  return {
    accountId: inventory.account.id,
    findings,
    generatedAt: new Date(now).toISOString(),
    inventoryLoadedAt: inventory.loadedAt || null,
    mode: options.deep ? "deep" : "core",
    schemaVersion: FLEET_AUDIT_SCHEMA_VERSION,
    summary: {
      findings: findings.length,
      intent: evaluation?.summary || null,
      matrix: matrix.summary,
      severity,
      zones: inventory.zones.length,
    },
  }
}

export function renderFleetAuditMarkdown(report) {
  const lines = [
    "# Cloudflare Fleet audit",
    "",
    `Generated: ${report.generatedAt}`,
    `Mode: ${report.mode}`,
    `Account: ${report.accountId}`,
    "",
    "## Summary",
    "",
    `Zones: ${report.summary.zones}`,
    `Matrix facets: ${report.summary.matrix.facets}`,
    `Raw matrix differences: ${report.summary.matrix.differences}`,
    `Findings: ${report.summary.findings} (${report.summary.severity.critical} critical, ${report.summary.severity.warning} warning, ${report.summary.severity.review} review, ${report.summary.severity.info} info)`,
  ]
  if (report.summary.intent) {
    lines.push(
      `Intent: ${report.summary.intent.actionableCells} actionable cells, ${report.summary.intent.unresolvedPolicies} unresolved policies, ${report.summary.intent.staleAcknowledgements} stale acknowledgements`,
    )
  }
  if (report.findings.length === 0) {
    lines.push("", "No findings.")
    return `${lines.join("\n")}\n`
  }
  for (const severity of Object.values(FLEET_AUDIT_SEVERITY)) {
    const entries = report.findings.filter((entry) => entry.severity === severity)
    if (entries.length === 0) continue
    lines.push("", `## ${severity[0].toUpperCase()}${severity.slice(1)} (${entries.length})`, "")
    for (const entry of entries) {
      lines.push(
        `### ${entry.title}`,
        "",
        `ID: \`${entry.id}\``,
        `Category: ${entry.category}`,
        entry.zones.length > 0 ? `Zones: ${entry.zones.join(", ")}` : "",
        "",
        entry.detail,
        "",
        `Recommendation: ${entry.recommendation}`,
        "",
      )
    }
  }
  return `${lines.filter((line, index) => line !== "" || lines[index - 1] !== "").join("\n").trimEnd()}\n`
}

export function renderFleetAuditHtml(report) {
  const severityMetrics = Object.values(FLEET_AUDIT_SEVERITY).map((severity) => (
    `<article class="metric severity-${severity}"><strong>${report.summary.severity[severity]}</strong><span>${escapeHtml(severity)}</span></article>`
  )).join("\n          ")
  const findingSections = Object.values(FLEET_AUDIT_SEVERITY).map((severity) => {
    const entries = report.findings.filter((entry) => entry.severity === severity)
    if (entries.length === 0) return ""
    const findings = entries.map((entry) => {
      const zones = entry.zones.length > 0
        ? `<p><strong>Zones:</strong> ${escapeHtml(entry.zones.join(", "))}</p>`
        : ""
      return `
        <article class="finding severity-${severity}">
          <header>
            <span class="severity-label">${escapeHtml(severity)}</span>
            <span class="category">${escapeHtml(entry.category)}</span>
          </header>
          <h3>${escapeHtml(entry.title)}</h3>
          <p class="finding-id"><strong>ID:</strong> <code>${escapeHtml(entry.id)}</code></p>
          ${zones}
          <p>${escapeHtml(entry.detail)}</p>
          <p><strong>Recommendation:</strong> ${escapeHtml(entry.recommendation)}</p>
          <details>
            <summary>Evidence</summary>
            <pre>${escapeHtml(JSON.stringify(entry.evidence, null, 2))}</pre>
          </details>
        </article>`
    }).join("\n")
    const label = `${severity[0].toUpperCase()}${severity.slice(1)}`
    return `
      <section aria-labelledby="severity-${severity}">
        <h2 id="severity-${severity}">${escapeHtml(label)} <span>${entries.length}</span></h2>
        <div class="finding-list">${findings}
        </div>
      </section>`
  }).filter(Boolean).join("\n")
  const intentSummary = report.summary.intent
    ? `<p><strong>Intent:</strong> ${report.summary.intent.actionableCells} actionable cells, ${report.summary.intent.unresolvedPolicies} unresolved policies, ${report.summary.intent.staleAcknowledgements} stale acknowledgements</p>`
    : ""
  const findings = findingSections || "<p class=\"empty\">No findings.</p>"

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
  <title>Cloudflare Fleet audit</title>
  <style>
    :root { color-scheme: light dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; background: #07111f; color: #dce7f5; }
    main { width: min(1120px, calc(100% - 32px)); margin: 0 auto; padding: 48px 0 72px; }
    .eyebrow { margin: 0 0 8px; color: #70d8ff; font-size: .78rem; font-weight: 800; letter-spacing: .12em; text-transform: uppercase; }
    h1 { margin: 0; color: #fff; font-size: clamp(2rem, 5vw, 3.75rem); letter-spacing: -.045em; }
    h2 { display: flex; align-items: center; gap: 10px; margin: 40px 0 16px; color: #fff; font-size: 1.3rem; }
    h2 span { border-radius: 999px; padding: 3px 9px; background: #1a2a3e; color: #a8bad0; font-size: .78rem; }
    h3 { margin: 12px 0 8px; color: #fff; font-size: 1.05rem; }
    p { line-height: 1.55; }
    code, pre { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }
    code { overflow-wrap: anywhere; color: #b9e7ff; }
    .metadata { display: flex; flex-wrap: wrap; gap: 10px 18px; margin: 18px 0 28px; color: #9fb1c7; }
    .metadata span { white-space: nowrap; }
    .summary { padding: 22px; border: 1px solid #263a52; border-radius: 18px; background: #0d1a2a; box-shadow: 0 22px 70px rgb(0 0 0 / .22); }
    .metrics { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 10px; }
    .metric { padding: 14px; border: 1px solid #263a52; border-radius: 12px; background: #101f31; }
    .metric strong, .metric span { display: block; }
    .metric strong { color: #fff; font-size: 1.65rem; }
    .metric span { margin-top: 3px; color: #9fb1c7; font-size: .78rem; font-weight: 800; letter-spacing: .08em; text-transform: uppercase; }
    .finding-list { display: grid; min-width: 0; gap: 14px; }
    .finding { min-width: 0; padding: 20px; border: 1px solid #263a52; border-left-width: 4px; border-radius: 14px; background: #0d1a2a; }
    .finding header { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
    .severity-label, .category { border-radius: 999px; padding: 4px 9px; font-size: .72rem; font-weight: 800; letter-spacing: .06em; text-transform: uppercase; }
    .severity-label { color: #07111f; }
    .category { background: #1a2a3e; color: #b7c8dc; }
    .severity-critical { border-left-color: #ff5c7a; }
    .severity-warning { border-left-color: #ffbd59; }
    .severity-review { border-left-color: #70d8ff; }
    .severity-info { border-left-color: #8e9db0; }
    .severity-critical .severity-label { background: #ff5c7a; }
    .severity-warning .severity-label { background: #ffbd59; }
    .severity-review .severity-label { background: #70d8ff; }
    .severity-info .severity-label { background: #aab8c8; }
    .finding-id { color: #9fb1c7; }
    details { min-width: 0; margin-top: 16px; border-top: 1px solid #263a52; padding-top: 12px; }
    summary { width: fit-content; cursor: pointer; color: #70d8ff; font-weight: 700; }
    pre { overflow: auto; max-width: 100%; margin: 12px 0 0; padding: 14px; border-radius: 10px; background: #07111f; color: #bdd0e5; font-size: .82rem; line-height: 1.5; }
    .empty { padding: 24px; border: 1px solid #263a52; border-radius: 14px; background: #0d1a2a; }
    @media (max-width: 600px) { main { width: min(100% - 20px, 1120px); padding-top: 28px; } .summary, .finding { padding: 16px; } }
  </style>
</head>
<body>
  <main>
    <header>
      <p class="eyebrow">Read-only configuration review</p>
      <h1>Cloudflare Fleet audit</h1>
      <div class="metadata">
        <span><strong>Generated:</strong> ${escapeHtml(report.generatedAt)}</span>
        <span><strong>Mode:</strong> ${escapeHtml(report.mode)}</span>
        <span><strong>Account:</strong> <code>${escapeHtml(report.accountId)}</code></span>
      </div>
    </header>
    <section class="summary" aria-labelledby="summary-heading">
      <h2 id="summary-heading">Summary</h2>
      <div class="metrics">
        <article class="metric"><strong>${report.summary.zones}</strong><span>zones</span></article>
        <article class="metric"><strong>${report.summary.matrix.facets}</strong><span>matrix facets</span></article>
        <article class="metric"><strong>${report.summary.findings}</strong><span>findings</span></article>
          ${severityMetrics}
      </div>
      <p><strong>Raw matrix differences:</strong> ${report.summary.matrix.differences}</p>
      ${intentSummary}
    </section>
    ${findings}
  </main>
</body>
</html>
`
}

export function auditFinding(options) {
  return finding(
    options.id,
    options.severity,
    options.category,
    options.title,
    options.detail,
    options,
  )
}

export function auditCnameRecords(inventory) {
  return inventory.zones.flatMap((zone) => (
    (surfaceResult(zone, "dns") || [])
      .filter((record) => String(record.type || "").toUpperCase() === DNS_RECORD_TYPE_CNAME)
      .map((record) => ({
        name: normalizedDnsName(record.name),
        proxied: Boolean(record.proxied),
        target: normalizedDnsName(record.content),
        zoneName: zone.meta.name,
      }))
  ))
}
