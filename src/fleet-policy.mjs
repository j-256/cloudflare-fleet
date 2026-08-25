import {
  EMAIL_POLICY_COMPONENT,
  POLICY_EXCEPTION_KIND,
} from "./constants.mjs"

export const FLEET_POLICY_CONFIG_GLOBAL = "__CLOUDFLARE_FLEET_POLICY_CONFIG__"
export const FLEET_POLICY_CONFIG_SCHEMA_VERSION = 1

const EMPTY_EXCEPTIONS = Object.freeze({})
const EMPTY_ENDPOINT_MONITORING = Object.freeze({
  excludeHostnames: Object.freeze([]),
  includeHostnames: Object.freeze([]),
})

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function emailDnsRecordException(zoneName, component, expected, reason) {
  if (!zoneName || !component || !reason) {
    throw new TypeError("Email DNS policy exceptions require a zone, component, and reason")
  }
  if (!Object.values(EMAIL_POLICY_COMPONENT).includes(component)) {
    throw new TypeError(`Unsupported email policy component: ${component}`)
  }
  if (!expected || typeof expected.content !== "string" || !Number.isFinite(expected.ttl)) {
    throw new TypeError("Email DNS policy exceptions require exact content and TTL")
  }
  return Object.freeze({
    component,
    expected: Object.freeze({
      content: expected.content,
      ttl: expected.ttl,
    }),
    kind: POLICY_EXCEPTION_KIND.EMAIL_DNS_RECORD,
    reason,
    zoneName,
  })
}

function endpointHostname(value) {
  if (typeof value !== "string" || value !== value.trim() || value.includes("*")) {
    throw new TypeError("Endpoint monitoring hostnames must be exact DNS names")
  }
  const hostname = value.toLowerCase().replace(/\.$/, "")
  let url
  try {
    url = new URL(`https://${hostname}/`)
  } catch {
    throw new TypeError("Endpoint monitoring hostnames must be exact DNS names")
  }
  if (!hostname || url.hostname !== hostname || url.port || url.pathname !== "/") {
    throw new TypeError("Endpoint monitoring hostnames must be exact DNS names")
  }
  return hostname
}

function endpointHostnameList(value, label) {
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    throw new TypeError(`Endpoint monitoring ${label} must be an array`)
  }
  const hostnames = value.map(endpointHostname)
  if (new Set(hostnames).size !== hostnames.length) {
    throw new TypeError(`Endpoint monitoring ${label} contains duplicates`)
  }
  return hostnames.sort()
}

function endpointMonitoringPolicy(value) {
  if (value === undefined) return EMPTY_ENDPOINT_MONITORING
  if (!isObject(value)) {
    throw new TypeError("Endpoint monitoring policy is invalid")
  }
  const excludeHostnames = endpointHostnameList(
    value.excludeHostnames,
    "exclusions",
  )
  const includeHostnames = endpointHostnameList(
    value.includeHostnames,
    "inclusions",
  )
  const excluded = new Set(excludeHostnames)
  if (includeHostnames.some((hostname) => excluded.has(hostname))) {
    throw new TypeError("Endpoint monitoring inclusions and exclusions overlap")
  }
  return Object.freeze({
    excludeHostnames: Object.freeze(excludeHostnames),
    includeHostnames: Object.freeze(includeHostnames),
  })
}

export function createEmptyFleetPolicyConfiguration() {
  return {
    emailDnsRecordExceptions: [],
    endpointMonitoring: {
      excludeHostnames: [],
      includeHostnames: [],
    },
    schemaVersion: FLEET_POLICY_CONFIG_SCHEMA_VERSION,
  }
}

export function normalizeFleetPolicyConfiguration(value) {
  const candidate = value ?? createEmptyFleetPolicyConfiguration()
  if (!isObject(candidate)
    || candidate.schemaVersion !== FLEET_POLICY_CONFIG_SCHEMA_VERSION
    || !Array.isArray(candidate.emailDnsRecordExceptions)) {
    throw new TypeError("Fleet policy configuration is invalid")
  }
  const emailDnsRecordExceptions = candidate.emailDnsRecordExceptions.map((entry) => {
    if (!isObject(entry) || !isObject(entry.expected)) {
      throw new TypeError("Fleet policy configuration contains an invalid exception")
    }
    return emailDnsRecordException(
      entry.zoneName,
      entry.component,
      entry.expected,
      entry.reason,
    )
  })
  indexEmailPolicyExceptions(emailDnsRecordExceptions)
  const endpointMonitoring = endpointMonitoringPolicy(candidate.endpointMonitoring)
  return Object.freeze({
    emailDnsRecordExceptions: Object.freeze(emailDnsRecordExceptions),
    endpointMonitoring,
    schemaVersion: FLEET_POLICY_CONFIG_SCHEMA_VERSION,
  })
}

export function isFleetPolicyConfiguration(value) {
  try {
    normalizeFleetPolicyConfiguration(value)
    return true
  } catch {
    return false
  }
}

function indexEmailPolicyExceptions(exceptions) {
  const byZone = {}
  for (const exception of exceptions) {
    if (byZone[exception.zoneName]?.[exception.component]) {
      throw new Error(
        `Duplicate ${exception.component} policy exception for ${exception.zoneName}`,
      )
    }
    byZone[exception.zoneName] = {
      ...(byZone[exception.zoneName] || {}),
      [exception.component]: exception,
    }
  }
  return Object.freeze(
    Object.fromEntries(
      Object.entries(byZone).map(([zoneName, zoneExceptions]) => [
        zoneName,
        Object.freeze(zoneExceptions),
      ]),
    ),
  )
}

let activeConfiguration
let emailPolicyExceptionsByZone

export function configureFleetPolicy(value = null) {
  activeConfiguration = normalizeFleetPolicyConfiguration(value)
  emailPolicyExceptionsByZone = indexEmailPolicyExceptions(
    activeConfiguration.emailDnsRecordExceptions,
  )
  return activeConfiguration
}

export function configuredFleetPolicy() {
  return activeConfiguration
}

export function configuredEmailPolicyExceptions() {
  return activeConfiguration.emailDnsRecordExceptions
}

export function emailPolicyExceptionsForZone(
  zoneName,
  configuration = activeConfiguration,
) {
  const byZone = configuration === activeConfiguration
    ? emailPolicyExceptionsByZone
    : indexEmailPolicyExceptions(
        normalizeFleetPolicyConfiguration(configuration).emailDnsRecordExceptions,
      )
  return byZone[zoneName] || EMPTY_EXCEPTIONS
}

configureFleetPolicy(globalThis[FLEET_POLICY_CONFIG_GLOBAL])
