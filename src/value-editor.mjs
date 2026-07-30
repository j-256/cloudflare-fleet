export const JSON_VALUE_KIND = Object.freeze({
  ARRAY: "array",
  BOOLEAN: "boolean",
  NULL: "null",
  NUMBER: "number",
  OBJECT: "object",
  STRING: "string",
})

const FIELD_LABELS = Object.freeze({
  action_parameters: "Action parameters",
  api: "API",
  caa: "CAA",
  cname: "CNAME",
  css: "CSS",
  dns: "DNS",
  exposed_credential_check: "Exposed credential check",
  from_value: "Redirect settings",
  host_header: "Host header",
  hotlink_protection: "Hotlink protection",
  html: "HTML",
  http: "HTTP",
  https: "HTTPS",
  id: "ID",
  ip: "IP",
  js: "JS",
  json: "JSON",
  logging: "Logging",
  mx: "MX",
  preserve_query_string: "Preserve query string",
  ratelimit: "Rate limit",
  request_fields: "Request fields",
  response: "Custom response",
  response_fields: "Response fields",
  security_level: "Security level",
  spf: "SPF",
  ssl: "SSL",
  status_code: "Status code",
  target_url: "Target URL",
  tls: "TLS",
  ttl: "TTL",
  uri: "URI",
  url: "URL",
  waf: "WAF",
})

const MULTILINE_FIELD_NAMES = new Set([
  "expression",
  "query",
  "script",
  "template",
])
const MULTILINE_TEXT_LENGTH = 80
const VALUE_FIELD_ORDER = Object.freeze([
  "description",
  "enabled",
  "type",
  "name",
  "action",
  "expression",
  "ref",
  "content",
  "data",
  "ttl",
  "proxied",
  "priority",
  "private_routing",
  "comment",
  "tags",
  "settings",
  "action_parameters",
  "logging",
  "ratelimit",
  "exposed_credential_check",
])
const VALUE_FIELD_PRIORITY = new Map(
  VALUE_FIELD_ORDER.map((field, index) => [field, index]),
)

function sentenceCase(words) {
  if (words.length === 0) return ""
  const [first, ...rest] = words
  const initial = `${first.charAt(0).toUpperCase()}${first.slice(1)}`
  return rest.length === 0 ? initial : `${initial} ${rest.join(" ")}`
}

function assertPath(path) {
  if (!Array.isArray(path)) throw new TypeError("A JSON value path must be an array")
  for (const segment of path) {
    if (typeof segment !== "string" && !Number.isInteger(segment)) {
      throw new TypeError("JSON value path segments must be strings or integers")
    }
  }
}

export function jsonValueKind(value) {
  if (value === null) return JSON_VALUE_KIND.NULL
  if (Array.isArray(value)) return JSON_VALUE_KIND.ARRAY
  if (typeof value === "boolean") return JSON_VALUE_KIND.BOOLEAN
  if (typeof value === "number" && Number.isFinite(value)) return JSON_VALUE_KIND.NUMBER
  if (typeof value === "string") return JSON_VALUE_KIND.STRING
  if (value && typeof value === "object") return JSON_VALUE_KIND.OBJECT
  throw new TypeError(`Unsupported JSON value type: ${typeof value}`)
}

export function humanizeValueField(field) {
  const normalized = String(field ?? "").trim()
  if (!normalized) return "Value"
  if (FIELD_LABELS[normalized]) return FIELD_LABELS[normalized]
  const words = normalized
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((word) => FIELD_LABELS[word.toLowerCase()] || word.toLowerCase())
  return sentenceCase(words)
}

export function valueControlDescriptor(value, field = "") {
  const kind = jsonValueKind(value)
  if (kind !== JSON_VALUE_KIND.STRING) return { kind, multiline: false }
  return {
    kind,
    multiline: value.includes("\n")
      || value.length >= MULTILINE_TEXT_LENGTH
      || MULTILINE_FIELD_NAMES.has(String(field).toLowerCase()),
  }
}

export function orderedValueEntries(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Ordered JSON fields require an object")
  }
  return Object.entries(value)
    .map((entry, index) => ({ entry, index }))
    .sort((left, right) => {
      const leftPriority = VALUE_FIELD_PRIORITY.get(left.entry[0])
      const rightPriority = VALUE_FIELD_PRIORITY.get(right.entry[0])
      if (leftPriority === undefined && rightPriority === undefined) {
        return left.index - right.index
      }
      if (leftPriority === undefined) return 1
      if (rightPriority === undefined) return -1
      return leftPriority - rightPriority
    })
    .map(({ entry }) => entry)
}

export function valueAtPath(root, path) {
  assertPath(path)
  let value = root
  for (const segment of path) {
    if (value === null || typeof value !== "object") {
      throw new TypeError(`Cannot read JSON value path at ${String(segment)}`)
    }
    value = value[segment]
  }
  return value
}

export function replaceValueAtPath(root, path, replacement) {
  assertPath(path)
  jsonValueKind(replacement)
  if (path.length === 0) return replacement
  const [segment, ...rest] = path
  if (root === null || typeof root !== "object") {
    throw new TypeError(`Cannot replace JSON value path at ${String(segment)}`)
  }
  const copy = Array.isArray(root) ? [...root] : { ...root }
  copy[segment] = replaceValueAtPath(root[segment], rest, replacement)
  return copy
}

export function removeArrayItemAtPath(root, path, index) {
  const array = valueAtPath(root, path)
  if (!Array.isArray(array)) throw new TypeError("The selected JSON value is not an array")
  if (!Number.isInteger(index) || index < 0 || index >= array.length) {
    throw new RangeError("The selected array item is unavailable")
  }
  return replaceValueAtPath(
    root,
    path,
    array.filter((_, itemIndex) => itemIndex !== index),
  )
}

export function defaultValueForKind(kind) {
  if (kind === JSON_VALUE_KIND.ARRAY) return []
  if (kind === JSON_VALUE_KIND.BOOLEAN) return false
  if (kind === JSON_VALUE_KIND.NULL) return null
  if (kind === JSON_VALUE_KIND.NUMBER) return 0
  if (kind === JSON_VALUE_KIND.OBJECT) return {}
  if (kind === JSON_VALUE_KIND.STRING) return ""
  throw new TypeError(`Unsupported JSON value kind: ${kind}`)
}

export function appendArrayItemAtPath(root, path) {
  const array = valueAtPath(root, path)
  if (!Array.isArray(array)) throw new TypeError("The selected JSON value is not an array")
  const itemKind = array.length === 0
    ? JSON_VALUE_KIND.STRING
    : jsonValueKind(array[array.length - 1])
  return replaceValueAtPath(
    root,
    path,
    [...array, defaultValueForKind(itemKind)],
  )
}

export function parseScalarControl(kind, value, checked = false) {
  if (kind === JSON_VALUE_KIND.BOOLEAN) return Boolean(checked)
  if (kind === JSON_VALUE_KIND.STRING) return String(value)
  if (kind === JSON_VALUE_KIND.NUMBER) {
    if (String(value).trim() === "") throw new TypeError("Enter a number")
    const parsed = Number(value)
    if (!Number.isFinite(parsed)) throw new TypeError("Enter a finite number")
    return parsed
  }
  throw new TypeError(`No scalar control parser exists for ${kind}`)
}
