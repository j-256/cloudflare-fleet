import {
  DNSSEC_STATUS,
  EMAIL_POLICY_COMPONENT,
  EMAIL_ROUTING_ACTION_KIND,
  EMAIL_ROUTING_RULE_IDENTIFIER,
  EMAIL_ROUTING_SETTING,
  FLEET_WAF_RULE_DESCRIPTION,
  FLEET_WAF_RULE_DESCRIPTIONS,
  HTTP_METHOD,
  POLICY_EXCEPTION_STATUS,
  RULESET_KIND,
  WAF_PHASE,
} from "./constants.mjs"
import { dnssecRequestedStatus } from "./dnssec.mjs"
import {
  materializeValue,
  normalizeValue,
  stableString,
  ZONE_PLACEHOLDER,
} from "./normalize.mjs"

const EMAIL_CATCH_ALL_NAME = "Catch-all to Gmail"
const DMARC_NAME = "_dmarc"
const DMARC_PREFIX = "v=dmarc1;"
const EMAIL_ROUTING_ACTION_TYPES = new Set([
  "drop",
  "forward",
  "worker",
])
const EMAIL_ROUTING_MATCHER_TYPES = new Set([
  "all",
  "literal",
])
const EMAIL_ROUTING_RULE_FIELDS = Object.freeze([
  "actions",
  "enabled",
  "matchers",
  "name",
  "priority",
])
const EMAIL_ROUTING_CATCH_ALL_FIELDS = Object.freeze(
  EMAIL_ROUTING_RULE_FIELDS.filter((field) => field !== "priority"),
)
const EMAIL_ROUTING_WRITABLE_SETTINGS = new Set(
  [EMAIL_ROUTING_SETTING.SUPPORT_SUBADDRESS],
)
const RULE_COPY_DEPENDENCY_KEYS = new Set([
  "id",
  "list_id",
  "ruleset_id",
])
const RULE_WRITABLE_FIELDS = Object.freeze([
  "action",
  "action_parameters",
  "categories",
  "description",
  "enabled",
  "exposed_credential_check",
  "expression",
  "logging",
  "ratelimit",
])
const DNS_RECORD_FIELD_ORDER = Object.freeze([
  "type",
  "name",
  "content",
  "data",
  "ttl",
  "proxied",
  "priority",
  "private_routing",
  "comment",
  "tags",
  "settings",
])
const DNS_RECORD_COMMON_FIELDS = Object.freeze([
  "comment",
  "name",
  "proxied",
  "settings",
  "tags",
  "ttl",
  "type",
])
const DNS_RECORD_CONTENT_TYPES = new Set([
  "A",
  "AAAA",
  "CNAME",
  "MX",
  "NS",
  "OPENPGPKEY",
  "PTR",
  "TXT",
])
const DNS_RECORD_DATA_TYPES = new Set([
  "CAA",
  "CERT",
  "DNSKEY",
  "DS",
  "HTTPS",
  "LOC",
  "NAPTR",
  "SMIMEA",
  "SRV",
  "SSHFP",
  "SVCB",
  "TLSA",
  "URI",
])
const DNS_RECORD_PRIORITY_TYPES = new Set([
  "MX",
  "URI",
])
const DNS_RECORD_PRIVATE_ROUTING_TYPES = new Set([
  "A",
  "AAAA",
])
const DNSSEC_WRITABLE_STATUS_SET = new Set([
  DNSSEC_STATUS.ACTIVE,
  DNSSEC_STATUS.DISABLED,
])
const RULESET_PLAN_KIND = Object.freeze({
  CREATE_RULE: "rule-create",
  DELETE_RULE: "rule-delete",
  DELETE_RULESET: "ruleset-delete",
  EDIT_DESCRIPTION: "ruleset-description",
  REORDER_RULE: "rule-reorder",
})
const FREE_PLAN_NAME = "Free Website"
const FREE_RULE_LIMIT_BY_PHASE = Object.freeze({
  http_config_settings: 10,
  http_ratelimit: 1,
  http_request_cache_settings: 10,
  http_request_dynamic_redirect: 10,
  http_request_firewall_custom: 5,
  http_request_late_transform: 10,
  http_request_origin: 10,
  http_request_transform: 10,
  http_response_compression: 10,
  http_response_headers_transform: 10,
})

function resultFor(zone, surfaceId) {
  const surface = zone.surfaces[surfaceId]
  return surface?.ok ? surface.result : null
}

function normalizeEmailDnsRecord(record, zoneName) {
  const type = String(record.type || "").toUpperCase()
  const rawName = record.name === "@" ? zoneName : String(record.name || "")
  let content = String(record.content || "")

  if (type === "TXT") {
    content = content.replace(/"\s+"/g, "").replace(/^"/, "").replace(/"$/, "")
  } else {
    content = content.replace(/\.$/, "").toLowerCase()
  }

  return {
    content,
    name: rawName.replace(/\.$/, "").toLowerCase(),
    priority: record.priority ?? null,
    ttl: record.ttl ?? 1,
    type,
  }
}

export function emailDnsRecordAssociationKey(record, zoneName) {
  const normalized = normalizeEmailDnsRecord(record, zoneName)
  return stableString({
    content: normalized.content,
    name: normalized.name,
    type: normalized.type,
  })
}

function isSpfRecord(record, zoneName) {
  const normalized = normalizeEmailDnsRecord(record, zoneName)
  return normalized.type === "TXT"
    && normalized.name === zoneName.toLowerCase()
    && normalized.content.toLowerCase().startsWith("v=spf1 ")
}

function isDmarcRecord(record, zoneName) {
  const normalized = normalizeEmailDnsRecord(record, zoneName)
  return normalized.type === "TXT"
    && normalized.name === `${DMARC_NAME}.${zoneName}`.toLowerCase()
    && normalized.content.toLowerCase().startsWith(DMARC_PREFIX)
}

function zoneContentTemplate(content, zoneName) {
  const escapedZoneName = zoneName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return content.replace(new RegExp(escapedZoneName, "gi"), ZONE_PLACEHOLDER)
}

function materializeZoneContent(template, zoneName) {
  return template.split(ZONE_PLACEHOLDER).join(zoneName)
}

function requiredEmailDnsState(zone) {
  const required = resultFor(zone, "email-dns")
  const actual = resultFor(zone, "dns")
  if (!Array.isArray(required)) {
    return {
      available: false,
      missing: [],
      reason: "Email DNS specification is unavailable",
    }
  }
  if (!Array.isArray(actual)) {
    return {
      available: false,
      missing: [],
      reason: "DNS records are unavailable",
    }
  }

  const actualCounts = new Map()
  for (const record of actual) {
    const key = stableString(normalizeEmailDnsRecord(record, zone.meta.name))
    actualCounts.set(key, (actualCounts.get(key) || 0) + 1)
  }

  const missing = []
  for (const record of required.filter((entry) => !isSpfRecord(entry, zone.meta.name))) {
    const normalized = normalizeEmailDnsRecord(record, zone.meta.name)
    const key = stableString(normalized)
    const count = actualCounts.get(key) || 0
    if (count === 0) missing.push(normalized)
    else actualCounts.set(key, count - 1)
  }

  return {
    available: true,
    missing,
    reason: "",
  }
}

function spfRecordsFor(zone) {
  const actual = resultFor(zone, "dns")
  if (!Array.isArray(actual)) return null
  return actual.filter((record) => isSpfRecord(record, zone.meta.name))
}

function dmarcRecordsFor(zone) {
  const actual = resultFor(zone, "dns")
  if (!Array.isArray(actual)) return null
  return actual.filter((record) => isDmarcRecord(record, zone.meta.name))
}

function spfState(zone, policy) {
  const records = spfRecordsFor(zone)
  if (!records) {
    return {
      available: false,
      matches: false,
      reason: "DNS records are unavailable",
      records: [],
    }
  }
  if (!policy?.available) {
    return {
      available: false,
      matches: false,
      reason: policy?.reason || "Fleet SPF policy is unavailable",
      records,
    }
  }
  if (records.length !== 1) {
    return {
      available: true,
      matches: false,
      reason: records.length === 0 ? "SPF record is missing" : "Multiple SPF records require manual review",
      records,
    }
  }

  const normalized = normalizeEmailDnsRecord(records[0], zone.meta.name)
  return {
    available: true,
    matches: normalized.content === policy.content && normalized.ttl === policy.ttl,
    reason: "",
    records,
  }
}

function dmarcState(zone, policy) {
  const records = dmarcRecordsFor(zone)
  if (!records) {
    return {
      available: false,
      matches: false,
      reason: "DNS records are unavailable",
      records: [],
    }
  }
  if (!policy?.available) {
    return {
      available: false,
      matches: false,
      reason: policy?.reason || "Fleet DMARC policy is unavailable",
      records,
    }
  }
  if (records.length !== 1) {
    return {
      available: true,
      matches: false,
      reason: records.length === 0 ? "DMARC record is missing" : "Multiple DMARC records require manual review",
      records,
    }
  }

  const normalized = normalizeEmailDnsRecord(records[0], zone.meta.name)
  return {
    available: true,
    matches: zoneContentTemplate(normalized.content, zone.meta.name) === policy.contentTemplate
      && normalized.ttl === policy.ttl,
    reason: "",
    records,
  }
}

function normalizedSpfRecord(record, zoneName) {
  const normalized = normalizeEmailDnsRecord(record, zoneName)
  return {
    content: normalized.content,
    ttl: normalized.ttl,
  }
}

function sameEmailDnsValue(left, right) {
  return Boolean(left && right && stableString(left) === stableString(right))
}

function evaluateSpfException(zone, dnsPolicy, exception) {
  const records = spfRecordsFor(zone)
  const baseline = dnsPolicy?.spf?.available
    ? {
        content: dnsPolicy.spf.content,
        ttl: dnsPolicy.spf.ttl,
      }
    : null
  const currentValues = records?.map(
    (record) => normalizedSpfRecord(record, zone.meta.name),
  ) || []
  const common = {
    baseline,
    component: exception.component,
    current: currentValues.length === 1 ? currentValues[0] : currentValues,
    expected: exception.expected,
    kind: exception.kind,
    reason: exception.reason,
    zoneId: zone.meta.id,
    zoneName: zone.meta.name,
  }

  if (records === null) {
    return {
      ...common,
      current: null,
      detail: "DNS records are unavailable",
      status: POLICY_EXCEPTION_STATUS.UNAVAILABLE,
    }
  }
  if (!baseline) {
    return {
      ...common,
      detail: dnsPolicy?.spf?.reason || "Fleet SPF policy is unavailable",
      status: POLICY_EXCEPTION_STATUS.UNAVAILABLE,
    }
  }
  if (records.length === 0) {
    return {
      ...common,
      detail: "SPF record is missing",
      status: POLICY_EXCEPTION_STATUS.VIOLATED,
    }
  }
  if (records.length > 1) {
    return {
      ...common,
      detail: "Multiple SPF records require manual review",
      status: POLICY_EXCEPTION_STATUS.VIOLATED,
    }
  }

  const current = currentValues[0]
  if (sameEmailDnsValue(current, baseline)) {
    return {
      ...common,
      detail: "The zone matches the fleet baseline, so this exception is dormant",
      status: POLICY_EXCEPTION_STATUS.ALIGNED,
    }
  }
  if (sameEmailDnsValue(current, exception.expected)) {
    return {
      ...common,
      detail: "The current record exactly matches the configured exception",
      status: POLICY_EXCEPTION_STATUS.ACTIVE,
    }
  }
  return {
    ...common,
    detail: "The current record matches neither the exception nor the fleet baseline",
    status: POLICY_EXCEPTION_STATUS.VIOLATED,
  }
}

export function evaluateEmailPolicyExceptions(zone, dnsPolicy, exceptions = {}) {
  const statuses = []
  const spfException = exceptions[EMAIL_POLICY_COMPONENT.SPF]
  if (spfException) statuses.push(evaluateSpfException(zone, dnsPolicy, spfException))
  return statuses
}

export function evaluateFleetEmailPolicyExceptions(inventory, dnsPolicy, exceptions = []) {
  const zonesByName = new Map(
    (inventory?.zones || []).map((zone) => [zone.meta.name, zone]),
  )
  return exceptions.flatMap((exception) => {
    const zone = zonesByName.get(exception.zoneName)
    if (zone) {
      return evaluateEmailPolicyExceptions(zone, dnsPolicy, {
        [exception.component]: exception,
      })
    }
    const baseline = exception.component === EMAIL_POLICY_COMPONENT.SPF
      && dnsPolicy?.spf?.available
      ? {
          content: dnsPolicy.spf.content,
          ttl: dnsPolicy.spf.ttl,
        }
      : null
    return [
      {
        baseline,
        component: exception.component,
        current: null,
        detail: "The configured zone is not present in the fleet inventory",
        expected: exception.expected,
        kind: exception.kind,
        reason: exception.reason,
        status: POLICY_EXCEPTION_STATUS.UNAVAILABLE,
        zoneId: "",
        zoneName: exception.zoneName,
      },
    ]
  })
}

function activeSpfException(zone, dnsPolicy, options) {
  return evaluateEmailPolicyExceptions(
    zone,
    dnsPolicy,
    options?.exceptions,
  ).some(
    (exception) => exception.component === EMAIL_POLICY_COMPONENT.SPF
      && exception.status === POLICY_EXCEPTION_STATUS.ACTIVE,
  )
}

function quotedDnsText(content) {
  return `"${content.replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`
}

function verifiedAddresses(inventory) {
  const addresses = inventory.account.emailAddresses
  if (!addresses?.ok) return new Set()
  return new Set(
    addresses.result
      .filter((address) => address.verified)
      .map((address) => address.email),
  )
}

export function deriveEmailDestination(inventory) {
  const verified = verifiedAddresses(inventory)
  const counts = new Map()

  for (const zone of inventory.zones) {
    const catchAll = resultFor(zone, "email-catch-all")
    for (const action of catchAll?.actions || []) {
      if (action.type !== "forward") continue
      for (const destination of action.value || []) {
        counts.set(destination, (counts.get(destination) || 0) + 1)
      }
    }
  }

  const ranked = [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
  if (ranked.length === 0) {
    return {
      available: false,
      reason: "No forwarding destination exists in the fleet",
    }
  }
  if (ranked[1] && ranked[1][1] === ranked[0][1]) {
    return {
      available: false,
      reason: "The fleet has no unique forwarding consensus",
    }
  }

  const [email, count] = ranked[0]
  if (!verified.has(email)) {
    return {
      available: false,
      reason: "The consensus forwarding destination is not verified on the account",
    }
  }

  return {
    available: true,
    count,
    email,
  }
}

function deriveSpfPolicy(inventory) {
  const variants = new Map()

  for (const zone of inventory.zones) {
    const records = spfRecordsFor(zone)
    if (!records || records.length !== 1) continue
    const normalized = normalizeEmailDnsRecord(records[0], zone.meta.name)
    const payload = {
      content: normalized.content,
      ttl: normalized.ttl,
    }
    const canonical = stableString(payload)
    if (!variants.has(canonical)) variants.set(canonical, { count: 0, payload })
    variants.get(canonical).count += 1
  }

  const ranked = [...variants.values()].sort((left, right) => right.count - left.count)
  if (ranked.length === 0) {
    return {
      available: false,
      reason: "No SPF record exists in the fleet",
    }
  }
  if (ranked[1] && ranked[1].count === ranked[0].count) {
    return {
      available: false,
      reason: "The fleet has no unique SPF consensus",
    }
  }

  return {
    available: true,
    count: ranked[0].count,
    ...ranked[0].payload,
  }
}

function deriveDmarcPolicy(inventory) {
  const variants = new Map()

  for (const zone of inventory.zones) {
    const records = dmarcRecordsFor(zone)
    if (!records || records.length !== 1) continue
    const normalized = normalizeEmailDnsRecord(records[0], zone.meta.name)
    const payload = {
      contentTemplate: zoneContentTemplate(normalized.content, zone.meta.name),
      ttl: normalized.ttl,
    }
    const canonical = stableString(payload)
    if (!variants.has(canonical)) variants.set(canonical, { count: 0, payload })
    variants.get(canonical).count += 1
  }

  const ranked = [...variants.values()].sort((left, right) => right.count - left.count)
  if (ranked.length === 0) {
    return {
      available: false,
      reason: "No DMARC record exists in the fleet",
    }
  }
  if (ranked[1] && ranked[1].count === ranked[0].count) {
    return {
      available: false,
      reason: "The fleet has no unique DMARC consensus",
    }
  }

  return {
    available: true,
    count: ranked[0].count,
    ...ranked[0].payload,
  }
}

export function deriveEmailDnsPolicy(inventory) {
  const spf = deriveSpfPolicy(inventory)
  const dmarc = deriveDmarcPolicy(inventory)
  const unavailable = [spf, dmarc].filter((policy) => !policy.available)

  return {
    available: unavailable.length === 0,
    dmarc,
    reason: unavailable.map((policy) => policy.reason).join("; "),
    spf,
  }
}

export function emailIssues(zone, destination, dnsPolicy, options = {}) {
  const issues = []
  const email = resultFor(zone, "email")
  const catchAll = resultFor(zone, "email-catch-all")
  const forward = catchAll?.actions?.find((action) => action.type === "forward")
  const destinations = forward?.value || []
  const dnsState = requiredEmailDnsState(zone)
  const currentSpf = spfState(zone, dnsPolicy?.spf)
  const currentDmarc = dmarcState(zone, dnsPolicy?.dmarc)
  const spfDifferenceAcknowledged = activeSpfException(zone, dnsPolicy, options)

  if (!email?.enabled) issues.push("Email Routing is disabled")
  if (email?.status !== "unlocked") issues.push(`DNS records are ${email?.status || "unknown"}`)
  if (!email?.support_subaddress) issues.push("Subaddressing is disabled")
  if (!catchAll?.enabled) issues.push("Catch-all is disabled")
  if (!forward) issues.push("Catch-all does not forward")
  if (forward && (destinations.length !== 1 || destinations[0] !== destination)) {
    issues.push("Catch-all uses another destination")
  }
  if (!dnsState.available) issues.push(dnsState.reason)
  if (dnsState.missing.length > 0) {
    const count = dnsState.missing.length
    issues.push(`${count} required Email Routing DNS record${count === 1 ? "" : "s"} missing or different`)
  }
  if (!currentSpf.available) issues.push(currentSpf.reason)
  if (currentSpf.available && !currentSpf.matches && !spfDifferenceAcknowledged) {
    issues.push(currentSpf.reason || "SPF value or TTL differs from fleet consensus")
  }
  if (!currentDmarc.available) issues.push(currentDmarc.reason)
  if (currentDmarc.available && !currentDmarc.matches) {
    issues.push(currentDmarc.reason || "DMARC value or TTL differs from fleet consensus")
  }

  return issues
}

export function buildEmailAlignmentPlan(zone, destination, dnsPolicy, options = {}) {
  if (!destination) throw new TypeError("destination is required")
  if (!dnsPolicy?.available) throw new Error(dnsPolicy?.reason || "Fleet email DNS policy is unavailable")

  const zoneId = zone.meta.id
  const zoneName = zone.meta.name
  const email = resultFor(zone, "email")
  const catchAll = resultFor(zone, "email-catch-all")
  const forward = catchAll?.actions?.find((action) => action.type === "forward")
  const destinations = forward?.value || []
  const dnsState = requiredEmailDnsState(zone)
  const currentSpf = spfState(zone, dnsPolicy.spf)
  const currentDmarc = dmarcState(zone, dnsPolicy.dmarc)
  const spfDifferenceAcknowledged = activeSpfException(zone, dnsPolicy, options)
  const operations = []
  const needsDnsEnable = !email?.enabled || (dnsState.available && dnsState.missing.length > 0)

  if (needsDnsEnable) {
    operations.push({
      label: "Enable Email Routing and create required DNS records",
      method: HTTP_METHOD.POST,
      path: `zones/${zoneId}/email/routing/dns`,
    })
  }

  if (!email?.support_subaddress) {
    operations.push({
      currentValue: {
        support_subaddress: Boolean(email?.support_subaddress),
      },
      label: "Match Email Routing settings",
      method: HTTP_METHOD.PATCH,
      path: `zones/${zoneId}/email/routing`,
      body: {
        support_subaddress: true,
      },
    })
  }

  if (!catchAll?.enabled || destinations.length !== 1 || destinations[0] !== destination) {
    const operation = {
      label: "Match catch-all forwarding",
      method: HTTP_METHOD.PUT,
      path: `zones/${zoneId}/email/routing/rules/catch_all`,
      body: {
        actions: [
          {
            type: "forward",
            value: [destination],
          },
        ],
        matchers: [
          {
            type: "all",
          },
        ],
        enabled: true,
        name: EMAIL_CATCH_ALL_NAME,
        source: "api",
      },
    }
    if (catchAll) {
      operation.currentValue = editableEmailRoutingRulePayload(
        catchAll,
        { catchAll: true },
      )
    }
    operations.push(operation)
  }

  if (!currentSpf.matches && !spfDifferenceAcknowledged) {
    if (currentSpf.records.length > 1) {
      throw new Error(`Multiple SPF records on ${zoneName} require manual review`)
    }
    if (currentSpf.records.length === 0) {
      operations.push({
        label: "Create the fleet SPF record",
        method: HTTP_METHOD.POST,
        path: `zones/${zoneId}/dns_records`,
        body: {
          content: quotedDnsText(dnsPolicy.spf.content),
          name: zoneName,
          ttl: dnsPolicy.spf.ttl,
          type: "TXT",
        },
      })
    } else {
      const recordId = currentSpf.records[0].id
      if (!recordId) throw new Error(`The SPF record identifier is unavailable on ${zoneName}`)
      operations.push({
        currentValue: editableDnsRecordPayload(currentSpf.records[0]),
        label: "Match the fleet SPF value and TTL",
        method: HTTP_METHOD.PATCH,
        path: `zones/${zoneId}/dns_records/${recordId}`,
        body: {
          content: quotedDnsText(dnsPolicy.spf.content),
          ttl: dnsPolicy.spf.ttl,
        },
      })
    }
  }

  if (!currentDmarc.matches) {
    if (currentDmarc.records.length > 1) {
      throw new Error(`Multiple DMARC records on ${zoneName} require manual review`)
    }
    const dmarcContent = quotedDnsText(
      materializeZoneContent(dnsPolicy.dmarc.contentTemplate, zoneName),
    )
    if (currentDmarc.records.length === 0) {
      operations.push({
        label: "Create the fleet DMARC record",
        method: HTTP_METHOD.POST,
        path: `zones/${zoneId}/dns_records`,
        body: {
          content: dmarcContent,
          name: `${DMARC_NAME}.${zoneName}`,
          ttl: dnsPolicy.dmarc.ttl,
          type: "TXT",
        },
      })
    } else {
      const recordId = currentDmarc.records[0].id
      if (!recordId) throw new Error(`The DMARC record identifier is unavailable on ${zoneName}`)
      operations.push({
        currentValue: editableDnsRecordPayload(currentDmarc.records[0]),
        label: "Match the fleet DMARC value and TTL",
        method: HTTP_METHOD.PATCH,
        path: `zones/${zoneId}/dns_records/${recordId}`,
        body: {
          content: dmarcContent,
          ttl: dnsPolicy.dmarc.ttl,
        },
      })
    }
  }

  if (email?.status !== "unlocked" || needsDnsEnable) {
    operations.push({
      label: "Unlock Email Routing DNS records",
      method: HTTP_METHOD.PATCH,
      path: `zones/${zoneId}/email/routing/dns`,
    })
  }

  return {
    id: `email:${zoneId}`,
    kind: "email",
    operations,
    summary: operations.length === 0
      ? `${zoneName} already matches the email policy`
      : `Align Email Routing on ${zoneName}`,
    zoneId,
    zoneName,
  }
}

function writeRule(rule) {
  const writable = {}
  for (const key of RULE_WRITABLE_FIELDS) {
    if (rule[key] !== undefined && rule[key] !== null) writable[key] = rule[key]
  }
  return writable
}

function dnsRecordWritableFields(type) {
  const normalizedType = typeof type === "string" ? type.toUpperCase() : ""
  if (!DNS_RECORD_CONTENT_TYPES.has(normalizedType) && !DNS_RECORD_DATA_TYPES.has(normalizedType)) {
    throw new Error(`DNS record type ${normalizedType || "unknown"} is not supported by the edit adapter`)
  }

  const fields = new Set(DNS_RECORD_COMMON_FIELDS)
  fields.add(DNS_RECORD_CONTENT_TYPES.has(normalizedType) ? "content" : "data")
  if (DNS_RECORD_PRIORITY_TYPES.has(normalizedType)) fields.add("priority")
  if (DNS_RECORD_PRIVATE_ROUTING_TYPES.has(normalizedType)) fields.add("private_routing")
  return DNS_RECORD_FIELD_ORDER.filter((field) => fields.has(field))
}

function writeDnsRecord(record) {
  const writable = {}
  for (const key of dnsRecordWritableFields(record.type)) {
    if (record[key] !== undefined && record[key] !== null) writable[key] = record[key]
  }
  return writable
}

function explicitRuleRef(rule) {
  if (typeof rule.ref !== "string" || rule.ref.length === 0 || rule.ref === rule.id) return ""
  return rule.ref
}

function ruleLabel(rule) {
  return rule.description || explicitRuleRef(rule) || `${rule.action || "Ruleset"} rule`
}

function desiredPayload(value, writableFields, requiredFields, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be a JSON object`)
  }
  const writable = new Set(writableFields)
  const unknown = Object.keys(value).filter((key) => !writable.has(key))
  if (unknown.length > 0) {
    throw new Error(`${label} contains unsupported fields: ${unknown.join(", ")}`)
  }
  const missing = requiredFields.filter(
    (key) => value[key] === undefined || value[key] === null || value[key] === "",
  )
  if (missing.length > 0) {
    throw new Error(`${label} requires: ${missing.join(", ")}`)
  }
  return value
}

function emailRoutingRuleFields(options = {}) {
  return options.catchAll
    ? EMAIL_ROUTING_CATCH_ALL_FIELDS
    : EMAIL_ROUTING_RULE_FIELDS
}

function assertEmailRoutingRuleDefinition(definition, options = {}) {
  if (typeof definition.enabled !== "boolean") {
    throw new TypeError("Email Routing rule enabled must be a boolean")
  }
  if (definition.name !== undefined) {
    if (typeof definition.name !== "string") {
      throw new TypeError("Email Routing rule name must be a string")
    }
    if (definition.name.length > 256) {
      throw new RangeError("Email Routing rule name cannot exceed 256 characters")
    }
  }
  if (definition.priority !== undefined) {
    if (!Number.isFinite(definition.priority) || definition.priority < 0) {
      throw new RangeError("Email Routing rule priority must be a non-negative number")
    }
  }
  if (!Array.isArray(definition.actions) || definition.actions.length === 0) {
    throw new TypeError("Email Routing rule actions must contain at least one action")
  }
  for (const [index, action] of definition.actions.entries()) {
    desiredPayload(
      action,
      ["type", "value"],
      ["type"],
      `Email Routing action ${index + 1}`,
    )
    if (!EMAIL_ROUTING_ACTION_TYPES.has(action.type)) {
      throw new Error(`Email Routing action ${index + 1} has unsupported type ${action.type}`)
    }
    if (action.type === "drop") {
      if (action.value !== undefined
        && (!Array.isArray(action.value) || action.value.length > 0)) {
        throw new TypeError("Drop actions cannot contain destination values")
      }
      continue
    }
    if (!Array.isArray(action.value)
      || action.value.length !== 1
      || typeof action.value[0] !== "string"
      || action.value[0].trim().length === 0) {
      throw new TypeError(`${action.type} actions require exactly one destination value`)
    }
  }
  if (!Array.isArray(definition.matchers) || definition.matchers.length === 0) {
    throw new TypeError("Email Routing rule matchers must contain at least one matcher")
  }
  for (const [index, matcher] of definition.matchers.entries()) {
    desiredPayload(
      matcher,
      ["field", "type", "value"],
      ["type"],
      `Email Routing matcher ${index + 1}`,
    )
    if (!EMAIL_ROUTING_MATCHER_TYPES.has(matcher.type)) {
      throw new Error(`Email Routing matcher ${index + 1} has unsupported type ${matcher.type}`)
    }
    if (matcher.type === "all") {
      if (!options.catchAll) {
        throw new Error("Only the dedicated catch-all rule can use an all matcher")
      }
      if (matcher.field !== undefined || matcher.value !== undefined) {
        throw new Error("The catch-all matcher cannot contain field or value")
      }
      continue
    }
    if (options.catchAll) {
      throw new Error("The catch-all rule must use the all matcher")
    }
    if (matcher.field !== "to") {
      throw new Error(`Email Routing matcher ${index + 1} must target the to field`)
    }
    if (typeof matcher.value !== "string" || matcher.value.trim().length === 0) {
      throw new TypeError(`Email Routing matcher ${index + 1} requires an address`)
    }
    if (matcher.value.length > 90) {
      throw new RangeError(`Email Routing matcher ${index + 1} cannot exceed 90 characters`)
    }
  }
  if (options.catchAll
    && (definition.matchers.length !== 1 || definition.matchers[0].type !== "all")) {
    throw new Error("The catch-all rule requires exactly one all matcher")
  }
  return definition
}

export function editableEmailRoutingRulePayload(rule, options = {}) {
  const writable = {}
  for (const field of emailRoutingRuleFields(options)) {
    if (rule?.[field] !== undefined && rule[field] !== null) {
      writable[field] = rule[field]
    }
  }
  return writable
}

export function emailRoutingRuleEditCapability(rule, options = {}) {
  if (!options.catchAll && !rule?.id) {
    return {
      editable: false,
      reason: "Cloudflare did not expose an Email Routing rule identifier",
    }
  }
  if (rule?.source && rule.source !== "api") {
    return {
      editable: false,
      reason: rule.source === "wrangler"
        ? "Wrangler owns this route; edit its Worker configuration instead"
        : `Email Routing source ${rule.source} is not supported by the direct edit adapter`,
    }
  }
  try {
    assertEmailRoutingRuleDefinition(
      editableEmailRoutingRulePayload(rule, options),
      options,
    )
  } catch (error) {
    return {
      editable: false,
      reason: error instanceof Error ? error.message : String(error),
    }
  }
  return {
    editable: true,
    reason: options.catchAll
      ? "The Email Routing Catch-all API supports a type-aware PUT"
      : "The Email Routing Rules API supports a type-aware PUT",
  }
}

export function editableDnsRecordPayload(record) {
  return writeDnsRecord(record)
}

export function dnsRecordEditCapability(record) {
  if (!record?.id) {
    return {
      editable: false,
      reason: "Cloudflare did not expose a DNS record identifier",
    }
  }
  if (record.locked) {
    return {
      editable: false,
      reason: "Cloudflare reports that this DNS record is locked",
    }
  }
  try {
    const fields = dnsRecordWritableFields(record.type)
    const definitionField = fields.includes("content") ? "content" : "data"
    if (record[definitionField] === undefined || record[definitionField] === null) {
      return {
        editable: false,
        reason: `Cloudflare did not expose writable ${definitionField} for this ${record.type} record`,
      }
    }
  } catch (error) {
    return {
      editable: false,
      reason: error instanceof Error ? error.message : String(error),
    }
  }
  return {
    editable: true,
    reason: "The DNS Records API supports a type-aware PATCH for this record",
  }
}

export function dnsRecordCopyCapability(record) {
  const editCapability = dnsRecordEditCapability(record)
  if (!editCapability.editable) {
    return {
      copyable: false,
      reason: editCapability.reason,
    }
  }
  return {
    copyable: true,
    reason: "The DNS Records API supports a type-aware POST for this record",
  }
}

export function editableRulePayload(rule) {
  const payload = writeRule(rule)
  const ref = explicitRuleRef(rule)
  if (ref) payload.ref = ref
  return payload
}

function dependencyPath(value, path = "action_parameters") {
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) {
      const nested = dependencyPath(entry, `${path}[${index}]`)
      if (nested) return nested
    }
    return ""
  }
  if (!value || typeof value !== "object") return ""
  for (const [key, entry] of Object.entries(value)) {
    const nestedPath = `${path}.${key}`
    if (RULE_COPY_DEPENDENCY_KEYS.has(key) && entry !== undefined && entry !== null) {
      return nestedPath
    }
    const nested = dependencyPath(entry, nestedPath)
    if (nested) return nested
  }
  return ""
}

export function ruleCopyCapability(ruleset, rule) {
  if (!ruleset || !rule) {
    return {
      copyable: false,
      reason: "The rule definition is unavailable",
    }
  }
  if (ruleset.kind === RULESET_KIND.MANAGED) {
    return {
      copyable: false,
      reason: "Managed rulesets must be deployed or overridden, not copied",
    }
  }
  if (ruleset.kind === RULESET_KIND.CUSTOM) {
    return {
      copyable: false,
      reason: "Custom rulesets require clone-and-deploy dependency handling",
    }
  }
  if (ruleset.kind !== RULESET_KIND.ZONE) {
    return {
      copyable: false,
      reason: `Ruleset kind ${ruleset.kind || "unknown"} is not a zone entrypoint`,
    }
  }
  if (rule.action === "execute") {
    return {
      copyable: false,
      reason: "Execute rules reference another ruleset and require dependency remapping",
    }
  }
  const dependency = dependencyPath(rule.action_parameters)
  if (dependency) {
    return {
      copyable: false,
      reason: `Rule dependency ${dependency} requires target-specific remapping`,
    }
  }
  if (typeof rule.action !== "string" || rule.action.length === 0) {
    return {
      copyable: false,
      reason: "The rule action is unavailable",
    }
  }
  if (typeof rule.expression !== "string" || rule.expression.length === 0) {
    return {
      copyable: false,
      reason: "The rule expression is unavailable",
    }
  }
  return {
    copyable: true,
    reason: "Self-contained zone entrypoint rule",
  }
}

function normalizedRulePayload(rule, zoneName) {
  const payload = editableRulePayload(rule)
  return normalizeValue(payload, zoneName, { preserveOrder: true })
}

export function portableRulePayload(ruleset, rule, zoneName) {
  const capability = ruleCopyCapability(ruleset, rule)
  if (!capability.copyable) throw new Error(capability.reason)
  return normalizedRulePayload(rule, zoneName)
}

function zoneEntrypoint(zone, phase, rulesetId = null) {
  return zone.ruleDetails
    .filter((entry) => entry.ok)
    .map((entry) => entry.result)
    .find((ruleset) => ruleset.kind === RULESET_KIND.ZONE
      && ruleset.phase === phase
      && (rulesetId === null || ruleset.id === rulesetId)) || null
}

function ruleCopySource(sourceZone, source) {
  const ruleset = zoneEntrypoint(sourceZone, source.phase, source.rulesetId)
  if (!ruleset) {
    throw new Error(`The source ${source.phase} entrypoint is no longer available on ${sourceZone.meta.name}`)
  }
  const rule = ruleset.rules?.find((entry) => entry.id === source.ruleId)
  if (!rule) throw new Error(`The source rule is no longer available on ${sourceZone.meta.name}`)
  const capability = ruleCopyCapability(ruleset, rule)
  if (!capability.copyable) throw new Error(capability.reason)
  return {
    label: ruleLabel(rule),
    normalizedPayload: portableRulePayload(ruleset, rule, sourceZone.meta.name),
    rule,
    ruleset,
  }
}

function normalizedDestinationRules(ruleset, zoneName) {
  return (ruleset?.rules || []).map((rule) => ({
    normalizedPayload: normalizedRulePayload(rule, zoneName),
    rule,
  }))
}

function uniqueCollision(candidates, predicate, label, zoneName) {
  const matches = candidates.filter(predicate)
  if (matches.length > 1) {
    throw new Error(`Multiple ${label} rule collisions on ${zoneName} require manual review`)
  }
  return matches[0] || null
}

function destinationCollision(ruleset, zoneName, normalizedPayload) {
  const candidates = normalizedDestinationRules(ruleset, zoneName)
  const canonical = stableString(normalizedPayload)
  const exact = candidates.find((entry) => stableString(entry.normalizedPayload) === canonical)
  if (exact) return { entry: exact, matchedBy: "exact payload" }

  if (normalizedPayload.ref) {
    const refMatch = uniqueCollision(
      candidates,
      (entry) => entry.normalizedPayload.ref === normalizedPayload.ref,
      "stable-reference",
      zoneName,
    )
    if (refMatch) return { entry: refMatch, matchedBy: "stable reference" }
  }

  if (normalizedPayload.description) {
    const descriptionMatch = uniqueCollision(
      candidates,
      (entry) => entry.normalizedPayload.description === normalizedPayload.description,
      "description",
      zoneName,
    )
    if (descriptionMatch) return { entry: descriptionMatch, matchedBy: "description" }
  }

  return null
}

function knownRuleLimit(zone, phase) {
  if (zone.meta.plan?.name !== FREE_PLAN_NAME) return null
  return FREE_RULE_LIMIT_BY_PHASE[phase] ?? null
}

function knownQuotaRuleCount(zone, phase, entrypoint) {
  if (phase !== WAF_PHASE) return entrypoint?.rules?.length || 0

  const rulesets = new Map()
  for (const detail of zone.ruleDetails.filter((entry) => entry.ok)) {
    const ruleset = detail.result
    if (ruleset.phase !== phase) continue
    if (![RULESET_KIND.ZONE, RULESET_KIND.CUSTOM].includes(ruleset.kind)) continue
    rulesets.set(ruleset.id, ruleset)
  }
  return [...rulesets.values()].reduce(
    (count, ruleset) => count + (ruleset.rules?.length || 0),
    0,
  )
}

function validateRuleAppend(zone, phase, ruleCount) {
  const limit = knownRuleLimit(zone, phase)
  if (limit !== null && ruleCount >= limit) {
    throw new Error(
      `Cannot append a ${phase} rule on ${zone.meta.name}: the ruleset already has ${ruleCount} rules and the known Free plan limit is ${limit}`,
    )
  }
  return limit
}

function buildRuleCopyPlan(sourceZone, sourceRule, targetZone) {
  const phase = sourceRule.ruleset.phase
  const targetRuleset = zoneEntrypoint(targetZone, phase)
  const targetPayload = materializeValue(sourceRule.normalizedPayload, targetZone.meta.name)
  const operations = []

  if (!targetRuleset) {
    const ruleCount = knownQuotaRuleCount(targetZone, phase, targetRuleset)
    const knownPlanRuleLimit = validateRuleAppend(targetZone, phase, ruleCount)
    operations.push({
      currentValue: {
        entrypoint: "missing",
        knownPlanRuleLimit,
        phase,
        ruleCount,
      },
      label: `Create ${phase} entrypoint with ${sourceRule.label}`,
      method: HTTP_METHOD.POST,
      path: `zones/${targetZone.meta.id}/rulesets`,
      body: {
        kind: RULESET_KIND.ZONE,
        name: "default",
        phase,
        rules: [targetPayload],
      },
    })
  } else {
    const collision = destinationCollision(
      targetRuleset,
      targetZone.meta.name,
      sourceRule.normalizedPayload,
    )
    if (collision?.matchedBy === "exact payload") {
      return {
        id: `rule-copy:${sourceZone.meta.id}:${sourceRule.rule.id}:${targetZone.meta.id}`,
        kind: "rule-copy",
        operations,
        sourceZoneName: sourceZone.meta.name,
        summary: `${targetZone.meta.name} already contains ${sourceRule.label}`,
        zoneId: targetZone.meta.id,
        zoneName: targetZone.meta.name,
      }
    }
    if (collision) {
      operations.push({
        currentValue: {
          matchedBy: collision.matchedBy,
          phase,
          rule: writeRule(collision.entry.rule),
          ruleCount: targetRuleset.rules?.length || 0,
        },
        label: `Match ${sourceRule.label} from ${sourceZone.meta.name}`,
        method: HTTP_METHOD.PATCH,
        path: `zones/${targetZone.meta.id}/rulesets/${targetRuleset.id}/rules/${collision.entry.rule.id}`,
        body: targetPayload,
      })
    } else {
      const ruleCount = knownQuotaRuleCount(targetZone, phase, targetRuleset)
      const knownPlanRuleLimit = validateRuleAppend(targetZone, phase, ruleCount)
      operations.push({
        currentValue: {
          knownPlanRuleLimit,
          matchedBy: "none",
          phase,
          ruleCount,
          ruleIds: targetRuleset.rules?.map((rule) => rule.id).filter(Boolean) || [],
        },
        label: `Copy ${sourceRule.label} from ${sourceZone.meta.name}`,
        method: HTTP_METHOD.POST,
        path: `zones/${targetZone.meta.id}/rulesets/${targetRuleset.id}/rules`,
        body: targetPayload,
      })
    }
  }

  return {
    id: `rule-copy:${sourceZone.meta.id}:${sourceRule.rule.id}:${targetZone.meta.id}`,
    kind: "rule-copy",
    operations,
    sourceZoneName: sourceZone.meta.name,
    summary: `Copy ${sourceRule.label} from ${sourceZone.meta.name} to ${targetZone.meta.name}`,
    zoneId: targetZone.meta.id,
    zoneName: targetZone.meta.name,
  }
}

export function buildRuleCopyPlans(sourceZone, targetZones, source) {
  const sourceRule = ruleCopySource(sourceZone, source)
  return targetZones
    .filter((zone) => zone.meta.id !== sourceZone.meta.id)
    .map((targetZone) => buildRuleCopyPlan(sourceZone, sourceRule, targetZone))
}

function dnsRecordsForCopy(zone) {
  const records = resultFor(zone, "dns")
  if (!Array.isArray(records)) {
    throw new Error(`DNS records are unavailable on ${zone.meta.name}`)
  }
  return records
}

function copiedDnsRecordPayload(record, sourceZoneName, targetZoneName) {
  const capability = dnsRecordCopyCapability(record)
  if (!capability.copyable) throw new Error(capability.reason)
  const normalized = normalizeValue(
    editableDnsRecordPayload(record),
    sourceZoneName,
  )
  const materialized = materializeValue(normalized, targetZoneName)
  const writableFields = dnsRecordWritableFields(materialized.type)
  const definitionField = writableFields.includes("content") ? "content" : "data"
  return desiredPayload(
    materialized,
    writableFields,
    [definitionField, "name", "ttl", "type"],
    "DNS record definition",
  )
}

function normalizedDnsName(name) {
  return String(name || "").replace(/\.$/, "").toLowerCase()
}

function dnsPayloadCounts(records) {
  const counts = new Map()
  for (const record of records) {
    const key = stableString(record)
    counts.set(key, (counts.get(key) || 0) + 1)
  }
  return counts
}

export function buildDnsRecordCopyPlan(sourceZone, targetZone, sourceRecordIds) {
  if (!Array.isArray(sourceRecordIds) || sourceRecordIds.length === 0) {
    throw new TypeError("At least one source DNS record identifier is required")
  }
  const requestedIds = new Set(sourceRecordIds)
  const sourceRecords = dnsRecordsForCopy(sourceZone)
    .filter((record) => requestedIds.has(record.id))
  if (sourceRecords.length !== requestedIds.size) {
    throw new Error(`One or more source DNS records are no longer available on ${sourceZone.meta.name}`)
  }

  const desiredRecords = sourceRecords.map(
    (record) => copiedDnsRecordPayload(
      record,
      sourceZone.meta.name,
      targetZone.meta.name,
    ),
  )
  const desiredTypes = new Set(desiredRecords.map((record) => record.type))
  const desiredNames = new Set(desiredRecords.map((record) => normalizedDnsName(record.name)))
  if (desiredTypes.size !== 1 || desiredNames.size !== 1) {
    throw new Error("A missing DNS cell must resolve from one record type and relative name")
  }

  const [desiredType] = desiredTypes
  const [desiredName] = desiredNames
  const targetRecords = dnsRecordsForCopy(targetZone)
  const sameCellRecords = targetRecords.filter(
    (record) => String(record.type || "").toUpperCase() === desiredType
      && normalizedDnsName(record.name) === desiredName,
  )
  const conflictingNameRecords = targetRecords.filter(
    (record) => normalizedDnsName(record.name) === desiredName
      && String(record.type || "").toUpperCase() !== desiredType,
  )
  const hasCnameConflict = desiredType === "CNAME"
    ? conflictingNameRecords.length > 0
    : conflictingNameRecords.some(
        (record) => String(record.type || "").toUpperCase() === "CNAME",
      )
  if (hasCnameConflict) {
    throw new Error(`A CNAME conflict now exists at ${desiredName} on ${targetZone.meta.name}`)
  }

  const currentPayloads = sameCellRecords.map(editableDnsRecordPayload)
  const desiredCounts = dnsPayloadCounts(desiredRecords)
  const currentCounts = dnsPayloadCounts(currentPayloads)
  const unexpectedCurrent = [...currentCounts].find(
    ([key, count]) => count > (desiredCounts.get(key) || 0),
  )
  if (unexpectedCurrent) {
    throw new Error(`The DNS cell on ${targetZone.meta.name} is no longer missing and differs from the selected fleet value`)
  }

  const missingPayloads = []
  for (const desired of desiredRecords) {
    const key = stableString(desired)
    const currentCount = currentCounts.get(key) || 0
    if (currentCount > 0) {
      currentCounts.set(key, currentCount - 1)
    } else {
      missingPayloads.push(desired)
    }
  }
  const operations = missingPayloads.map((body) => ({
    body,
    currentValue: {
      record: "missing",
      sourceZone: sourceZone.meta.name,
    },
    label: `Create ${body.type} ${body.name}`,
    method: HTTP_METHOD.POST,
    path: `zones/${targetZone.meta.id}/dns_records`,
  }))

  return {
    id: `dns-copy:${sourceZone.meta.id}:${sourceRecordIds.join(",")}:${targetZone.meta.id}`,
    kind: "dns-copy",
    operations,
    sourceZoneName: sourceZone.meta.name,
    summary: operations.length === 0
      ? `${targetZone.meta.name} already contains the selected DNS value`
      : `Fill ${desiredType} ${desiredName} on ${targetZone.meta.name} from ${sourceZone.meta.name}`,
    zoneId: targetZone.meta.id,
    zoneName: targetZone.meta.name,
  }
}

export function buildDnsRecordEditPlan(zone, liveRecord, desiredDefinition) {
  const capability = dnsRecordEditCapability(liveRecord)
  if (!capability.editable) throw new Error(capability.reason)
  const desiredType = typeof desiredDefinition?.type === "string"
    ? desiredDefinition.type.toUpperCase()
    : ""
  const writableFields = dnsRecordWritableFields(desiredType)
  const definitionField = writableFields.includes("content") ? "content" : "data"
  const desired = desiredPayload(
    {
      ...desiredDefinition,
      type: desiredType,
    },
    writableFields,
    [definitionField, "name", "ttl", "type"],
    "DNS record definition",
  )
  const current = editableDnsRecordPayload(liveRecord)
  const operations = stableString(current) === stableString(desired)
    ? []
    : [
        {
          body: desired,
          currentValue: current,
          label: `Update ${liveRecord.type} ${liveRecord.name}`,
          method: HTTP_METHOD.PATCH,
          path: `zones/${zone.meta.id}/dns_records/${liveRecord.id}`,
        },
      ]

  return {
    id: `dns-record:${zone.meta.id}:${liveRecord.id}`,
    kind: "dns-record",
    operations,
    summary: operations.length === 0
      ? `${liveRecord.type} ${liveRecord.name} already matches the desired definition`
      : `Update ${liveRecord.type} ${liveRecord.name} on ${zone.meta.name}`,
    zoneId: zone.meta.id,
    zoneName: zone.meta.name,
  }
}

export function buildDnsRecordDeletePlan(zone, liveRecord) {
  const capability = dnsRecordEditCapability(liveRecord)
  if (!capability.editable) throw new Error(capability.reason)
  const current = editableDnsRecordPayload(liveRecord)
  return {
    id: `dns-record-delete:${zone.meta.id}:${liveRecord.id}`,
    kind: "dns-record-delete",
    operations: [
      {
        currentValue: current,
        label: `Delete ${liveRecord.type} ${liveRecord.name}`,
        method: HTTP_METHOD.DELETE,
        path: `zones/${zone.meta.id}/dns_records/${liveRecord.id}`,
      },
    ],
    summary: `Delete ${liveRecord.type} ${liveRecord.name} on ${zone.meta.name}`,
    zoneId: zone.meta.id,
    zoneName: zone.meta.name,
  }
}

export function buildEmailRoutingRuleEditPlan(
  zone,
  liveRule,
  desiredDefinition,
  options = {},
) {
  const capability = emailRoutingRuleEditCapability(liveRule, options)
  if (!capability.editable) throw new Error(capability.reason)
  const desired = assertEmailRoutingRuleDefinition(
    desiredPayload(
      desiredDefinition,
      emailRoutingRuleFields(options),
      ["actions", "enabled", "matchers"],
      "Email Routing rule definition",
    ),
    options,
  )
  const current = editableEmailRoutingRulePayload(liveRule, options)
  const ruleIdentifier = options.catchAll
    ? EMAIL_ROUTING_RULE_IDENTIFIER.CATCH_ALL
    : liveRule.id
  const label = options.catchAll
    ? "Catch-all rule"
    : liveRule.name || liveRule.matchers?.[0]?.value || "Email Routing rule"
  const operations = stableString(current) === stableString(desired)
    ? []
    : [
        {
          body: desired,
          currentValue: current,
          label: `Update ${label}`,
          method: HTTP_METHOD.PUT,
          path: `zones/${zone.meta.id}/email/routing/rules/${ruleIdentifier}`,
        },
      ]

  return {
    id: `email-routing-rule:${zone.meta.id}:${ruleIdentifier}`,
    kind: EMAIL_ROUTING_ACTION_KIND.RULE_EDIT,
    operations,
    summary: operations.length === 0
      ? `${label} already matches the desired definition`
      : `Update ${label} on ${zone.meta.name}`,
    zoneId: zone.meta.id,
    zoneName: zone.meta.name,
  }
}

export function buildEmailRoutingSettingPlan(zone, settingId, value) {
  if (!EMAIL_ROUTING_WRITABLE_SETTINGS.has(settingId)) {
    throw new Error(`Email Routing setting ${settingId} is not directly writable`)
  }
  if (typeof value !== "boolean") {
    throw new TypeError(`Email Routing setting ${settingId} must be a boolean`)
  }
  const settings = resultFor(zone, "email")
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    throw new Error(`Email Routing settings are unavailable on ${zone.meta.name}`)
  }
  const current = settings[settingId]
  if (typeof current !== "boolean") {
    throw new Error(`Email Routing setting ${settingId} is unavailable on ${zone.meta.name}`)
  }
  const operations = current === value
    ? []
    : [
        {
          body: { [settingId]: value },
          currentValue: { [settingId]: current },
          label: `Set Email Routing ${settingId}`,
          method: HTTP_METHOD.PATCH,
          path: `zones/${zone.meta.id}/email/routing`,
        },
      ]

  return {
    id: `email-routing-setting:${zone.meta.id}:${settingId}`,
    kind: EMAIL_ROUTING_ACTION_KIND.SETTING_EDIT,
    operations,
    summary: operations.length === 0
      ? `${settingId} already matches the desired value`
      : `Update Email Routing ${settingId} on ${zone.meta.name}`,
    zoneId: zone.meta.id,
    zoneName: zone.meta.name,
  }
}

function assertEditableRulesetDetail(zone, ruleset) {
  if (!ruleset || typeof ruleset !== "object") {
    throw new Error(`The ruleset is no longer available on ${zone.meta.name}`)
  }
  if (![RULESET_KIND.ZONE, RULESET_KIND.CUSTOM].includes(ruleset.kind)) {
    throw new Error(
      ruleset.kind === RULESET_KIND.MANAGED
        ? "Managed rule definitions cannot be edited directly"
        : `Ruleset kind ${ruleset.kind || "unknown"} is not editable at the zone level`,
    )
  }
  return ruleset
}

function editableRuleset(zone, source) {
  const ruleset = zone.ruleDetails
    .filter((entry) => entry.ok)
    .map((entry) => entry.result)
    .find((entry) => entry.id === source.rulesetId && entry.phase === source.phase)
  if (!ruleset) {
    throw new Error(`The ${source.phase} ruleset is no longer available on ${zone.meta.name}`)
  }
  assertEditableRulesetDetail(zone, ruleset)
  const rule = ruleset.rules?.find((entry) => entry.id === source.ruleId)
  if (!rule) throw new Error(`The rule is no longer available on ${zone.meta.name}`)
  return {
    rule,
    ruleset,
  }
}

export function buildRuleEditPlan(zone, source, desiredDefinition) {
  const { rule, ruleset } = editableRuleset(zone, source)
  const label = ruleLabel(rule)
  const desired = desiredPayload(
    desiredDefinition,
    [...RULE_WRITABLE_FIELDS, "ref"],
    ["action", "enabled", "expression"],
    "Rule definition",
  )
  const current = editableRulePayload(rule)
  const operations = stableString(current) === stableString(desired)
    ? []
    : [
        {
          body: desired,
          currentValue: current,
          label: `Update ${label}`,
          method: HTTP_METHOD.PATCH,
          path: `zones/${zone.meta.id}/rulesets/${ruleset.id}/rules/${rule.id}`,
        },
      ]

  return {
    id: `rule-edit:${zone.meta.id}:${rule.id}`,
    kind: "rule-edit",
    operations,
    summary: operations.length === 0
      ? `${label} already matches the desired definition`
      : `Update ${label} on ${zone.meta.name}`,
    zoneId: zone.meta.id,
    zoneName: zone.meta.name,
  }
}

export function buildRuleCreatePlan(zone, ruleset, desiredDefinition) {
  assertEditableRulesetDetail(zone, ruleset)
  const desired = desiredPayload(
    desiredDefinition,
    [...RULE_WRITABLE_FIELDS, "ref"],
    ["action", "enabled", "expression"],
    "Rule definition",
  )
  const ruleCount = Math.max(
    knownQuotaRuleCount(zone, ruleset.phase, ruleset),
    ruleset.rules?.length || 0,
  )
  validateRuleAppend(zone, ruleset.phase, ruleCount)
  const label = ruleLabel(desired)
  return {
    id: `rule-create:${zone.meta.id}:${ruleset.id}:${label}`,
    kind: RULESET_PLAN_KIND.CREATE_RULE,
    operations: [
      {
        body: desired,
        currentValue: {
          ruleIds: ruleset.rules?.map((rule) => rule.id).filter(Boolean) || [],
        },
        label: `Create ${label}`,
        method: HTTP_METHOD.POST,
        path: `zones/${zone.meta.id}/rulesets/${ruleset.id}/rules`,
      },
    ],
    summary: `Create ${label} on ${zone.meta.name}`,
    zoneId: zone.meta.id,
    zoneName: zone.meta.name,
  }
}

export function buildRuleDeletePlan(zone, ruleset, ruleId) {
  assertEditableRulesetDetail(zone, ruleset)
  const rules = ruleset.rules || []
  const index = rules.findIndex((rule) => rule.id === ruleId)
  if (index === -1) throw new Error(`The rule is no longer available on ${zone.meta.name}`)
  const rule = rules[index]
  const label = ruleLabel(rule)
  return {
    id: `rule-delete:${zone.meta.id}:${rule.id}`,
    kind: RULESET_PLAN_KIND.DELETE_RULE,
    operations: [
      {
        currentValue: {
          position: index + 1,
          rule: editableRulePayload(rule),
        },
        label: `Delete ${label}`,
        method: HTTP_METHOD.DELETE,
        path: `zones/${zone.meta.id}/rulesets/${ruleset.id}/rules/${rule.id}`,
      },
    ],
    summary: `Delete ${label} on ${zone.meta.name}`,
    zoneId: zone.meta.id,
    zoneName: zone.meta.name,
  }
}

export function buildRuleReorderPlan(zone, ruleset, ruleId, targetIndex) {
  assertEditableRulesetDetail(zone, ruleset)
  const rules = ruleset.rules || []
  const currentIndex = rules.findIndex((rule) => rule.id === ruleId)
  if (currentIndex === -1) {
    throw new Error(`The rule is no longer available on ${zone.meta.name}`)
  }
  if (!Number.isInteger(targetIndex) || targetIndex < 0 || targetIndex >= rules.length) {
    throw new RangeError("The desired rule position is unavailable")
  }
  const rule = rules[currentIndex]
  const label = ruleLabel(rule)
  const operations = []
  if (targetIndex !== currentIndex) {
    const anchor = rules[targetIndex]
    operations.push({
      body: {
        position: targetIndex < currentIndex
          ? { before: anchor.id }
          : { after: anchor.id },
      },
      currentValue: {
        position: currentIndex + 1,
      },
      label: `Move ${label} from position ${currentIndex + 1} to ${targetIndex + 1}`,
      method: HTTP_METHOD.PATCH,
      path: `zones/${zone.meta.id}/rulesets/${ruleset.id}/rules/${rule.id}`,
    })
  }
  return {
    id: `rule-reorder:${zone.meta.id}:${rule.id}`,
    kind: RULESET_PLAN_KIND.REORDER_RULE,
    operations,
    summary: operations.length === 0
      ? `${label} is already in position ${currentIndex + 1}`
      : `Reorder ${label} on ${zone.meta.name}`,
    zoneId: zone.meta.id,
    zoneName: zone.meta.name,
  }
}

export function buildRulesetDescriptionPlan(zone, ruleset, desiredDescription) {
  assertEditableRulesetDetail(zone, ruleset)
  if (typeof desiredDescription !== "string") {
    throw new TypeError("Ruleset description must be a string")
  }
  const desired = desiredDescription.trim()
  const current = typeof ruleset.description === "string" ? ruleset.description : ""
  const rules = (ruleset.rules || []).map(editableRulePayload)
  const operations = current === desired
    ? []
    : [
        {
          body: {
            description: desired,
            rules,
          },
          currentValue: {
            description: current,
            rules,
          },
          label: `Update the ruleset description while preserving ${rules.length} ordered rule${rules.length === 1 ? "" : "s"}`,
          method: HTTP_METHOD.PUT,
          path: `zones/${zone.meta.id}/rulesets/${ruleset.id}`,
        },
      ]
  return {
    id: `ruleset-description:${zone.meta.id}:${ruleset.id}`,
    kind: RULESET_PLAN_KIND.EDIT_DESCRIPTION,
    operations,
    summary: operations.length === 0
      ? `${ruleset.name} already has the desired description`
      : `Update ${ruleset.name} on ${zone.meta.name}`,
    zoneId: zone.meta.id,
    zoneName: zone.meta.name,
  }
}

export function buildRulesetDeletePlan(zone, ruleset) {
  assertEditableRulesetDetail(zone, ruleset)
  const rules = ruleset.rules || []
  if (rules.length > 0) {
    throw new Error("Delete every rule before deleting this ruleset")
  }
  return {
    id: `ruleset-delete:${zone.meta.id}:${ruleset.id}`,
    kind: RULESET_PLAN_KIND.DELETE_RULESET,
    operations: [
      {
        currentValue: {
          description: ruleset.description || "",
          kind: ruleset.kind,
          name: ruleset.name,
          phase: ruleset.phase,
        },
        label: `Delete empty ruleset ${ruleset.name}`,
        method: HTTP_METHOD.DELETE,
        path: `zones/${zone.meta.id}/rulesets/${ruleset.id}`,
      },
    ],
    summary: `Delete ${ruleset.name} on ${zone.meta.name}`,
    zoneId: zone.meta.id,
    zoneName: zone.meta.name,
  }
}

export function buildRuleRenamePlans(zones, sources, desiredName) {
  if (!Array.isArray(sources) || sources.length === 0) {
    throw new TypeError("Fleet rule rename requires at least one rule")
  }
  if (typeof desiredName !== "string" || desiredName.trim().length === 0) {
    throw new TypeError("Rule name is required")
  }
  const normalizedName = desiredName.trim()
  const zonesById = new Map(zones.map((zone) => [zone.meta.id, zone]))
  const seenRules = new Set()

  return sources.map((source) => {
    const zone = zonesById.get(source.zoneId)
    if (!zone) throw new Error(`The rule's zone is no longer available: ${source.zoneId}`)
    const targetKey = `${source.zoneId}:${source.rulesetId}:${source.ruleId}`
    if (seenRules.has(targetKey)) {
      throw new Error(`The fleet rename contains a duplicate rule on ${zone.meta.name}`)
    }
    seenRules.add(targetKey)

    const { rule, ruleset } = editableRuleset(zone, source)
    const current = editableRulePayload(rule)
    const materializedName = materializeValue(normalizedName, zone.meta.name)
    const desired = {
      ...current,
      description: materializedName,
    }
    const operations = stableString(current) === stableString(desired)
      ? []
      : [
          {
            body: desired,
            currentValue: current,
            label: `Rename ${ruleLabel(rule)} to ${materializedName}`,
            method: HTTP_METHOD.PATCH,
            path: `zones/${zone.meta.id}/rulesets/${ruleset.id}/rules/${rule.id}`,
          },
        ]

    return {
      id: `rule-rename:${zone.meta.id}:${rule.id}`,
      kind: "rule-rename",
      operations,
      summary: operations.length === 0
        ? `${ruleLabel(rule)} already has the desired name on ${zone.meta.name}`
        : `Rename ${ruleLabel(rule)} on ${zone.meta.name}`,
      zoneId: zone.meta.id,
      zoneName: zone.meta.name,
    }
  })
}

function customFirewallRuleset(zone) {
  return zone.ruleDetails
    .filter((entry) => entry.ok)
    .map((entry) => entry.result)
    .find((ruleset) => ruleset.phase === WAF_PHASE) || null
}

export function deriveFleetWafPolicies(inventory) {
  const policies = new Map()

  for (const description of FLEET_WAF_RULE_DESCRIPTIONS) {
    const variants = new Map()
    for (const zone of inventory.zones) {
      const rule = customFirewallRuleset(zone)?.rules?.find((entry) => entry.description === description)
      if (!rule) continue
      const payload = writeRule(rule)
      const canonical = stableString(normalizeValue(payload, zone.meta.name, { preserveOrder: true }))
      if (!variants.has(canonical)) variants.set(canonical, { count: 0, payload })
      variants.get(canonical).count += 1
    }

    const ranked = [...variants.entries()].sort((left, right) => right[1].count - left[1].count)
    if (ranked.length === 0 || (ranked[1] && ranked[1][1].count === ranked[0][1].count)) {
      policies.set(description, {
        available: false,
        reason: ranked.length === 0 ? "Rule is absent from the fleet" : "Rule has no unique fleet consensus",
      })
      continue
    }

    policies.set(description, {
      available: true,
      canonical: ranked[0][0],
      count: ranked[0][1].count,
      payload: ranked[0][1].payload,
    })
  }

  return policies
}

export function wafIssues(zone, policies) {
  const issues = []
  const ruleset = customFirewallRuleset(zone)
  const rules = ruleset?.rules || []

  for (const description of FLEET_WAF_RULE_DESCRIPTIONS) {
    const policy = policies.get(description)
    if (!policy?.available) {
      issues.push(`${description}: ${policy?.reason || "policy unavailable"}`)
      continue
    }
    const rule = ruleset?.rules?.find((entry) => entry.description === description)
    if (!rule) {
      issues.push(`${description}: missing`)
      continue
    }
    const current = stableString(normalizeValue(writeRule(rule), zone.meta.name, { preserveOrder: true }))
    if (current !== policy.canonical) issues.push(`${description}: differs from consensus`)
  }

  const logRule = rules.find((rule) => rule.description === FLEET_WAF_RULE_DESCRIPTION.LOG_ALL_OTHERS)
  if (logRule && rules[rules.length - 1]?.id !== logRule.id) {
    issues.push(`${FLEET_WAF_RULE_DESCRIPTION.LOG_ALL_OTHERS}: is not last`)
  }

  return issues
}

export function buildWafAlignmentPlan(zone, policies) {
  const zoneId = zone.meta.id
  const zoneName = zone.meta.name
  const ruleset = customFirewallRuleset(zone)
  const policyPayloads = FLEET_WAF_RULE_DESCRIPTIONS.map((description) => {
    const policy = policies.get(description)
    if (!policy?.available) throw new Error(`${description}: ${policy?.reason || "policy unavailable"}`)
    return policy.payload
  })
  const operations = []

  if (!ruleset) {
    operations.push({
      label: "Create the custom firewall entrypoint with fleet rules",
      method: HTTP_METHOD.POST,
      path: `zones/${zoneId}/rulesets`,
      body: {
        name: "default",
        kind: "zone",
        phase: WAF_PHASE,
        rules: policyPayloads,
      },
    })
  } else {
    const rules = ruleset.rules || []
    const logRule = rules.find((rule) => rule.description === FLEET_WAF_RULE_DESCRIPTION.LOG_ALL_OTHERS)
    const logRuleIndex = logRule ? rules.findIndex((rule) => rule.id === logRule.id) : -1
    if (logRule && logRuleIndex !== rules.length - 1) {
      operations.push({
        body: { position: { after: "" } },
        currentValue: { position: logRuleIndex + 1 },
        label: `Move ${FLEET_WAF_RULE_DESCRIPTION.LOG_ALL_OTHERS} to the end`,
        method: HTTP_METHOD.PATCH,
        path: `zones/${zoneId}/rulesets/${ruleset.id}/rules/${logRule.id}`,
      })
    }

    for (const [index, description] of FLEET_WAF_RULE_DESCRIPTIONS.entries()) {
      const policy = policies.get(description)
      const existing = rules.find((rule) => rule.description === description)
      if (!existing) {
        const body = logRule && description !== FLEET_WAF_RULE_DESCRIPTION.LOG_ALL_OTHERS
          ? { ...policyPayloads[index], position: { before: logRule.id } }
          : policyPayloads[index]
        operations.push({
          currentValue: {
            ruleIds: rules.map((rule) => rule.id).filter(Boolean),
          },
          label: `Add ${description}`,
          method: HTTP_METHOD.POST,
          path: `zones/${zoneId}/rulesets/${ruleset.id}/rules`,
          body,
        })
        continue
      }

      const current = stableString(normalizeValue(writeRule(existing), zoneName, { preserveOrder: true }))
      if (current !== policy.canonical) {
        operations.push({
          currentValue: writeRule(existing),
          label: `Update ${description}`,
          method: HTTP_METHOD.PATCH,
          path: `zones/${zoneId}/rulesets/${ruleset.id}/rules/${existing.id}`,
          body: policyPayloads[index],
        })
      }
    }
  }

  return {
    id: `waf:${zoneId}`,
    kind: "waf",
    operations,
    summary: operations.length === 0
      ? `${zoneName} already matches the fleet WAF policy`
      : `Align shared WAF rules on ${zoneName}`,
    zoneId,
    zoneName,
  }
}

export function buildZoneSettingPlan(zone, settingId, value) {
  const settings = resultFor(zone, "settings") || []
  const setting = settings.find((entry) => entry.id === settingId)
  if (!setting) throw new Error(`Setting ${settingId} is unavailable on ${zone.meta.name}`)
  if (!setting.editable) throw new Error(`Setting ${settingId} is read-only on ${zone.meta.name}`)
  const operations = stableString(setting.value) === stableString(value)
    ? []
    : [
        {
          currentValue: setting.value,
          label: `Set ${settingId}`,
          method: HTTP_METHOD.PATCH,
          path: `zones/${zone.meta.id}/settings/${encodeURIComponent(settingId)}`,
          body: { value },
        },
      ]

  return {
    id: `setting:${zone.meta.id}:${settingId}`,
    kind: "setting",
    operations,
    summary: operations.length === 0
      ? `${settingId} already matches the desired value`
      : `Update ${settingId} on ${zone.meta.name}`,
    zoneId: zone.meta.id,
    zoneName: zone.meta.name,
  }
}

export function buildDnssecStatusPlan(zone, desiredStatus) {
  if (!DNSSEC_WRITABLE_STATUS_SET.has(desiredStatus)) {
    throw new TypeError("DNSSEC status must be active or disabled")
  }
  const dnssec = resultFor(zone, "dnssec")
  if (!dnssec || typeof dnssec !== "object") {
    throw new Error(`DNSSEC is unavailable on ${zone.meta.name}`)
  }
  const currentStatus = dnssecRequestedStatus(dnssec.status)
  if (!currentStatus) {
    throw new Error(`DNSSEC status ${dnssec.status || "unknown"} cannot be changed safely on ${zone.meta.name}`)
  }
  const operations = currentStatus === desiredStatus
    ? []
    : [
        {
          body: { status: desiredStatus },
          currentValue: { status: currentStatus },
          label: desiredStatus === DNSSEC_STATUS.ACTIVE
            ? "Enable DNSSEC"
            : "Disable DNSSEC",
          method: HTTP_METHOD.PATCH,
          path: `zones/${zone.meta.id}/dnssec`,
        },
      ]

  return {
    id: `dnssec:${zone.meta.id}`,
    kind: "dnssec",
    operations,
    summary: operations.length === 0
      ? `DNSSEC already has the requested status on ${zone.meta.name}`
      : `${desiredStatus === DNSSEC_STATUS.ACTIVE ? "Enable" : "Disable"} DNSSEC on ${zone.meta.name}`,
    zoneId: zone.meta.id,
    zoneName: zone.meta.name,
  }
}

export async function executePlans(api, plans, options = {}) {
  const results = []
  const operations = plans.flatMap((plan) => plan.operations.map((operation) => ({ operation, plan })))

  for (const [index, entry] of operations.entries()) {
    options.onProgress?.({
      completed: index,
      total: operations.length,
      operation: entry.operation,
      plan: entry.plan,
    })
    const response = await api.executeOperation(entry.operation, { signal: options.signal })
    const result = {
      operation: entry.operation,
      plan: entry.plan,
      response,
    }
    results.push(result)
    options.onResult?.(result)
  }

  options.onProgress?.({
    completed: operations.length,
    total: operations.length,
  })

  return results
}
