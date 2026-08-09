import {
  FLEET_INTENT_ACKNOWLEDGEMENT_STATUS,
  FLEET_INTENT_COVERAGE_EXPECTATION_STATUS,
  evaluateFleetIntent,
  evaluateFleetIntentCoverage,
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
const EDITABLE_RULESET_KINDS = new Set([
  RULESET_KIND.CUSTOM,
  RULESET_KIND.ZONE,
])

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

function normalizedDnsName(name) {
  return String(name || "").replace(/\.$/, "").toLowerCase()
}

function normalizedTxtContent(content) {
  return String(content || "")
    .replace(/"\s+"/g, "")
    .replace(/^"/, "")
    .replace(/"$/, "")
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

function emailFindings(inventory) {
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
        exceptions: emailPolicyExceptionsForZone(zone.meta.name),
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
    configuredEmailPolicyExceptions(),
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
    for (const duplicate of [...duplicates.values()].filter((entries) => entries.length > 1)) {
      const record = duplicate[0]
      findings.push(finding(
        `dns.exact-duplicate:${zone.meta.name}:${record.type}:${normalizedDnsName(record.name)}:${duplicate.map((entry) => entry.id || "unknown").sort().join(",")}`,
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
  }
  return findings
}

function rulesetFindings(inventory) {
  const findings = []
  for (const zone of inventory.zones) {
    for (const detail of zone.ruleDetails || []) {
      if (!detail.ok || !EDITABLE_RULESET_KINDS.has(detail.result?.kind)) continue
      const ruleset = detail.result
      const rules = Array.isArray(ruleset.rules) ? ruleset.rules : []
      if (rules.length === 0) {
        findings.push(finding(
          `ruleset.empty:${zone.meta.name}:${ruleset.id}`,
          FLEET_AUDIT_SEVERITY.REVIEW,
          "Rulesets",
          "An editable ruleset is empty",
          `${zone.meta.name}: ${ruleset.name || ruleset.phase || ruleset.id} has no rules`,
          {
            evidence: {
              kind: ruleset.kind,
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
        findings.push(finding(
          `ruleset.disabled-rules:${zone.meta.name}:${ruleset.id}`,
          FLEET_AUDIT_SEVERITY.REVIEW,
          "Rulesets",
          "Disabled rules remain in an editable ruleset",
          `${zone.meta.name}: ${disabled.length} disabled ${plural(disabled.length, "rule")} in ${ruleset.name || ruleset.phase || ruleset.id}`,
          {
            evidence: {
              phase: ruleset.phase,
              rules: disabled.map((rule) => ({
                description: rule.description || "",
                id: rule.id || null,
              })),
              rulesetId: ruleset.id,
            },
            recommendation: "Confirm whether each rule is intentionally parked, should be re-enabled, or can be removed",
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
    ...dnssecFindings(inventory, now),
    ...emailFindings(inventory),
    ...wafFindings(inventory),
    ...settingDriftFindings(inventory, matrix),
    ...dnsRecordFindings(inventory),
    ...rulesetFindings(inventory),
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
