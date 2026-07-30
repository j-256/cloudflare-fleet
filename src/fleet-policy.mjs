import {
  EMAIL_POLICY_COMPONENT,
  POLICY_EXCEPTION_KIND,
} from "./constants.mjs"

const EMPTY_EXCEPTIONS = Object.freeze({})

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

const EMAIL_POLICY_EXCEPTIONS = Object.freeze([
  emailDnsRecordException(
    "zone-c.example",
    EMAIL_POLICY_COMPONENT.SPF,
    {
      content: "v=spf1 a:production.support02.dw.demandware.net a:production.support01.dw.demandware.net include:_spf.mx.cloudflare.net include:_spf.google.com ~all",
      ttl: 60,
    },
    "The sandbox uses a storefront-specific sender policy",
  ),
])

const emailPolicyExceptionsByZone = {}
for (const exception of EMAIL_POLICY_EXCEPTIONS) {
  if (emailPolicyExceptionsByZone[exception.zoneName]?.[exception.component]) {
    throw new Error(`Duplicate ${exception.component} policy exception for ${exception.zoneName}`)
  }
  emailPolicyExceptionsByZone[exception.zoneName] = {
    ...(emailPolicyExceptionsByZone[exception.zoneName] || {}),
    [exception.component]: exception,
  }
}
const EMAIL_POLICY_EXCEPTIONS_BY_ZONE = Object.freeze(
  Object.fromEntries(
    Object.entries(emailPolicyExceptionsByZone).map(([zoneName, exceptions]) => [
      zoneName,
      Object.freeze(exceptions),
    ]),
  ),
)

export function configuredEmailPolicyExceptions() {
  return EMAIL_POLICY_EXCEPTIONS
}

export function emailPolicyExceptionsForZone(zoneName) {
  return EMAIL_POLICY_EXCEPTIONS_BY_ZONE[zoneName] || EMPTY_EXCEPTIONS
}
