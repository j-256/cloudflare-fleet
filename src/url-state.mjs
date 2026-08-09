import {
  DEFAULT_MATRIX_FILTERS,
  DEFAULT_MATRIX_SCOPE,
  DEFAULT_MATRIX_SORT,
  MATRIX_SCOPE,
  MATRIX_SORT,
} from "./matrix-filter.mjs"

export const DEFAULT_VIEW_STATE = Object.freeze({
  query: DEFAULT_MATRIX_FILTERS.query,
  category: DEFAULT_MATRIX_FILTERS.category,
  phase: DEFAULT_MATRIX_FILTERS.phase,
  scope: DEFAULT_MATRIX_SCOPE,
  sort: DEFAULT_MATRIX_SORT,
  recordType: DEFAULT_MATRIX_FILTERS.recordType,
  redirectType: DEFAULT_MATRIX_FILTERS.redirectType,
  changeableOnly: DEFAULT_MATRIX_FILTERS.changeableOnly,
  targetHolesOnly: DEFAULT_MATRIX_FILTERS.targetHolesOnly,
  differencesOnly: DEFAULT_MATRIX_FILTERS.differencesOnly,
  selectedZoneIds: Object.freeze([]),
  selectedColumnsOnly: false,
})

const TRUE = "1"
const FALSE = "0"

// Canonical key order; each entry maps a URL param to how it reads and writes
// (scope and sort carry an allowed set: their selects have no empty option, so
// an unrecognized value would read back as "" and hide the whole matrix)
const FIELDS = [
  { key: "q", field: "query", kind: "string" },
  { key: "category", field: "category", kind: "string" },
  { key: "phase", field: "phase", kind: "string" },
  { key: "scope", field: "scope", kind: "string", allowed: new Set(Object.values(MATRIX_SCOPE)) },
  { key: "sort", field: "sort", kind: "string", allowed: new Set(Object.values(MATRIX_SORT)) },
  { key: "type", field: "recordType", kind: "string" },
  { key: "redirect", field: "redirectType", kind: "string" },
  { key: "changeable", field: "changeableOnly", kind: "bool-off" },
  { key: "holes", field: "targetHolesOnly", kind: "bool-off" },
  { key: "review", field: "differencesOnly", kind: "bool-on" },
  { key: "zones", field: "selectedZoneIds", kind: "list" },
  { key: "cols", field: "selectedColumnsOnly", kind: "bool-off" },
]

function freshDefault() {
  return { ...DEFAULT_VIEW_STATE, selectedZoneIds: [] }
}

export function encodeViewState(view) {
  const params = new URLSearchParams()
  for (const { key, field, kind } of FIELDS) {
    const value = view[field]
    if (kind === "string") {
      const text = String(value ?? "")
      if (text !== DEFAULT_VIEW_STATE[field]) params.set(key, text)
    } else if (kind === "bool-off") {
      if (value) params.set(key, TRUE)
    } else if (kind === "bool-on") {
      if (!value) params.set(key, FALSE)
    } else if (kind === "list") {
      const ids = [...(value || [])].map(String).filter(Boolean).sort()
      if (ids.length > 0) params.set(key, ids.join(","))
    }
  }
  return params.toString()
}

export function decodeViewState(search) {
  const params = new URLSearchParams(String(search || ""))
  const view = freshDefault()
  for (const { key, field, kind, allowed } of FIELDS) {
    if (!params.has(key)) continue
    const raw = params.get(key)
    if (kind === "string") {
      view[field] = allowed && !allowed.has(raw) ? DEFAULT_VIEW_STATE[field] : raw
    } else if (kind === "bool-off") {
      view[field] = raw !== "" && raw !== FALSE
    } else if (kind === "bool-on") {
      view[field] = raw !== FALSE
    } else if (kind === "list") {
      view[field] = raw.split(",").map((id) => id.trim()).filter(Boolean)
    }
  }
  return view
}
