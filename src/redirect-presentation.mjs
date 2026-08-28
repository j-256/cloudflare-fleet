export const REDIRECT_TARGET_KIND = Object.freeze({
  DYNAMIC: "dynamic",
  LIST: "list",
  STATIC: "static",
  UNKNOWN: "unknown",
})

export const REDIRECT_TARGET_KIND_ORDER = Object.freeze([
  REDIRECT_TARGET_KIND.DYNAMIC,
  REDIRECT_TARGET_KIND.STATIC,
  REDIRECT_TARGET_KIND.LIST,
  REDIRECT_TARGET_KIND.UNKNOWN,
])

const REDIRECT_TARGET_KIND_LABELS = Object.freeze({
  [REDIRECT_TARGET_KIND.DYNAMIC]: "Dynamic target",
  [REDIRECT_TARGET_KIND.LIST]: "List target",
  [REDIRECT_TARGET_KIND.STATIC]: "Static target",
  [REDIRECT_TARGET_KIND.UNKNOWN]: "Unknown target",
})

export const REDIRECT_STATUS_OPTIONS = Object.freeze([
  Object.freeze({ label: "301 Moved permanently", value: 301 }),
  Object.freeze({ label: "302 Found", value: 302 }),
  Object.freeze({ label: "303 See other", value: 303 }),
  Object.freeze({ label: "307 Temporary redirect", value: 307 }),
  Object.freeze({ label: "308 Permanent redirect", value: 308 }),
])

const REDIRECT_STATUS_LABELS = Object.freeze(Object.fromEntries(
  REDIRECT_STATUS_OPTIONS.map(({ label, value }) => [value, label]),
))

function stringValue(value) {
  return typeof value === "string" ? value : ""
}

export function isRedirectRule(rule) {
  return rule?.action === "redirect"
}

export function redirectTargetKindLabel(kind) {
  return REDIRECT_TARGET_KIND_LABELS[kind]
    || REDIRECT_TARGET_KIND_LABELS[REDIRECT_TARGET_KIND.UNKNOWN]
}

export function presentRedirect(rule, options = {}) {
  if (!isRedirectRule(rule)) return null
  const parameters = rule.action_parameters || {}
  const fromValue = parameters.from_value
  const fromList = parameters.from_list
  const targetUrl = fromValue?.target_url || {}
  let target = ""
  let targetKind = REDIRECT_TARGET_KIND.UNKNOWN

  if (typeof targetUrl.value === "string") {
    target = targetUrl.value
    targetKind = REDIRECT_TARGET_KIND.STATIC
  } else if (typeof targetUrl.expression === "string") {
    target = targetUrl.expression
    targetKind = REDIRECT_TARGET_KIND.DYNAMIC
  } else if (fromList && typeof fromList === "object") {
    target = stringValue(fromList.name)
      || stringValue(fromList.key)
      || "Bulk redirect list"
    targetKind = REDIRECT_TARGET_KIND.LIST
  }

  const statusCode = Number.isInteger(fromValue?.status_code)
    ? fromValue.status_code
    : null
  const preserveQueryString = typeof fromValue?.preserve_query_string === "boolean"
    ? fromValue.preserve_query_string
    : null

  return {
    enabled: rule.enabled !== false,
    enabledLabel: rule.enabled === false ? "Disabled" : "Enabled",
    match: stringValue(rule.expression),
    preserveQueryString,
    position: Number.isInteger(options.position) && options.position > 0
      ? options.position
      : null,
    queryLabel: preserveQueryString === true
      ? "Keep query"
      : preserveQueryString === false
        ? "Drop query"
        : "Query behavior unspecified",
    responseLabel: statusCode === null
      ? "Response code unspecified"
      : REDIRECT_STATUS_LABELS[statusCode] || `HTTP ${statusCode}`,
    statusCode,
    target: target || "Target unavailable",
    targetKind,
    targetKindLabel: redirectTargetKindLabel(targetKind),
  }
}

export function redirectSemanticIdentity(rule, index = 0) {
  const redirect = presentRedirect(rule)
  if (!redirect) return ""
  const stableRef = rule.ref && rule.ref !== rule.id ? rule.ref : ""
  return redirect.match.trim()
    || stringValue(stableRef).trim()
    || stringValue(rule.description).trim()
    || `redirect rule ${index + 1}`
}
