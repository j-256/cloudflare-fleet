const SYSTEM_FIELDS = new Set([
  "id",
  "tag",
  "zone_id",
  "created",
  "created_on",
  "modified",
  "modified_on",
  "last_updated",
])
export const ZONE_PLACEHOLDER = "{zone}"

export function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue)
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stableValue(value[key])]),
    )
  }
  return value
}

export function stableString(value) {
  return JSON.stringify(stableValue(value))
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

// Rewrite the zone name to {zone} only where it is not glued to an adjacent
// alphanumeric, so an unrelated host that merely contains the zone name as a
// substring (myexample.com, example.company) is left intact and an identical
// value compares equal across zones. A hyphen is deliberately treated as a
// separator, not a label character, so generated rule refs like
// "protect-alpha.example" still normalize to "protect-{zone}"
export function normalizeText(value, zoneName) {
  if (!zoneName) return String(value)
  const pattern = new RegExp(
    `(?<![A-Za-z0-9])${escapeRegExp(zoneName)}(?![A-Za-z0-9])`,
    "g",
  )
  return String(value).replace(pattern, ZONE_PLACEHOLDER)
}

export function materializeText(value, zoneName) {
  return String(value).split(ZONE_PLACEHOLDER).join(zoneName)
}

export function normalizeValue(value, zoneName, options = {}) {
  if (typeof value === "string") return normalizeText(value, zoneName)
  if (Array.isArray(value)) {
    const normalized = value.map((entry) => normalizeValue(entry, zoneName, options))
    return options.preserveOrder
      ? normalized
      : normalized.sort((left, right) => stableString(left).localeCompare(stableString(right)))
  }
  if (value && typeof value === "object") {
    const omitted = new Set(options.omit || [])
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !SYSTEM_FIELDS.has(key))
        .filter(([key]) => !omitted.has(key))
        .map(([key, entry]) => [key, normalizeValue(entry, zoneName, options)]),
    )
  }
  return value
}

export function materializeValue(value, zoneName) {
  if (typeof value === "string") return materializeText(value, zoneName)
  if (Array.isArray(value)) return value.map((entry) => materializeValue(entry, zoneName))
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, materializeValue(entry, zoneName)]),
    )
  }
  return value
}

export function relativeName(name, zoneName) {
  if (!name || name === zoneName) return "@"
  if (name.endsWith(`.${zoneName}`)) return name.slice(0, -(zoneName.length + 1))
  return normalizeText(name, zoneName)
}

export function groupBy(values, keyFor) {
  const grouped = new Map()
  for (const value of values) {
    const key = keyFor(value)
    if (!grouped.has(key)) grouped.set(key, [])
    grouped.get(key).push(value)
  }
  return grouped
}

export function displayJson(value) {
  if (typeof value === "string") return value
  if (value === null) return "null"
  if (typeof value !== "object") return String(value)
  return JSON.stringify(stableValue(value), null, 2)
}

export function shortDisplay(value) {
  if (typeof value === "boolean") return value ? "On" : "Off"
  if (value === null) return "null"
  if (typeof value === "number") return String(value)
  if (typeof value === "string") return value
  if (Array.isArray(value)) {
    if (value.length === 0) return "None"
    if (value.every((entry) => typeof entry !== "object")) return value.join(", ")
    return `${value.length} item${value.length === 1 ? "" : "s"}`
  }
  const keys = Object.keys(value)
  if (keys.length === 0) return "None"
  if (keys.length <= 3 && keys.every((key) => typeof value[key] !== "object")) {
    return keys.map((key) => `${key}: ${String(value[key])}`).join(" | ")
  }
  return `${keys.length} fields`
}
