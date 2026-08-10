import { FLEET_INTENT_ROW_STATUS } from "./fleet-intent.mjs"
import { RULE_PHASE_EXECUTION_ORDER } from "./rule-presentation.mjs"

export const MATRIX_INTENT_FILTER = Object.freeze({
  ALL: "",
  DRIFT: FLEET_INTENT_ROW_STATUS.DRIFT,
  MATCH: FLEET_INTENT_ROW_STATUS.MATCH,
  REVIEW: FLEET_INTENT_ROW_STATUS.REVIEW,
  UNGOVERNED: FLEET_INTENT_ROW_STATUS.UNGOVERNED,
})

export const MATRIX_SCOPE = Object.freeze({
  ALL: "all",
  FLEET_PATTERNS: "fleet-patterns",
  FLEET_WIDE: "fleet-wide",
  ZONE_SPECIFIC: "zone-specific",
})

export const DEFAULT_MATRIX_SCOPE = MATRIX_SCOPE.FLEET_PATTERNS

export const MATRIX_SORT = Object.freeze({
  CATEGORY: "category",
  PHASE_EXECUTION: "phase-execution",
})

export const DEFAULT_MATRIX_SORT = MATRIX_SORT.PHASE_EXECUTION

export const DEFAULT_MATRIX_FILTERS = Object.freeze({
  category: "",
  changeableOnly: false,
  differencesOnly: true,
  intentStatus: MATRIX_INTENT_FILTER.ALL,
  phase: "",
  query: "",
  recordType: "",
  redirectType: "",
  scope: DEFAULT_MATRIX_SCOPE,
  sort: DEFAULT_MATRIX_SORT,
  targetHolesOnly: false,
})

const PHASE_EXECUTION_INDEX = new Map(
  RULE_PHASE_EXECUTION_ORDER.map((phase, index) => [phase, index]),
)

export const DNS_MATRIX_CATEGORIES = Object.freeze([
  "DNS records",
  "Email DNS specification",
])

export function matrixEmptyMessage(totalCount, visibleCount) {
  if (visibleCount > 0) return ""
  if (totalCount > 0) {
    return "No facets match the current filters. Reset filters or broaden the search."
  }
  return "No comparable facets are available in this fleet snapshot."
}

export function matrixVisibleCountText(totalCount, visibleCount, filters = {}) {
  const base = `${visibleCount} of ${totalCount} facet${totalCount === 1 ? "" : "s"}`
  const contexts = []
  const intentStatus = String(filters.intentStatus || "")
  if (intentStatus === MATRIX_INTENT_FILTER.DRIFT) contexts.push("Intent drift")
  else if (intentStatus === MATRIX_INTENT_FILTER.MATCH) contexts.push("Matches intent")
  else if (intentStatus === MATRIX_INTENT_FILTER.REVIEW) contexts.push("Intent needs review")
  else if (intentStatus === MATRIX_INTENT_FILTER.UNGOVERNED) {
    contexts.push(filters.differencesOnly
      ? "Ungoverned differences"
      : "Intent not set")
  } else if (filters.differencesOnly) contexts.push("Needs review")
  if (filters.changeableOnly) contexts.push("Supported changes")
  return contexts.length > 0 ? `${base} | ${contexts.join(" + ")}` : base
}

export function facetMatchesScope(presentCount, zoneCount, scope) {
  if (scope === MATRIX_SCOPE.ALL) return true
  if (scope === MATRIX_SCOPE.FLEET_PATTERNS) return presentCount >= 2
  if (scope === MATRIX_SCOPE.FLEET_WIDE) return zoneCount > 0 && presentCount === zoneCount
  if (scope === MATRIX_SCOPE.ZONE_SPECIFIC) return presentCount === 1
  return false
}

export function matrixFilterChangeCount(filters) {
  return [
    String(filters.query || "").trim() !== DEFAULT_MATRIX_FILTERS.query,
    String(filters.category || "") !== DEFAULT_MATRIX_FILTERS.category,
    String(filters.phase || "") !== DEFAULT_MATRIX_FILTERS.phase,
    String(filters.scope || "") !== DEFAULT_MATRIX_FILTERS.scope,
    String(filters.recordType || "") !== DEFAULT_MATRIX_FILTERS.recordType,
    String(filters.redirectType || "") !== DEFAULT_MATRIX_FILTERS.redirectType,
    String(filters.sort || "") !== DEFAULT_MATRIX_FILTERS.sort,
    Boolean(filters.changeableOnly) !== DEFAULT_MATRIX_FILTERS.changeableOnly,
    Boolean(filters.differencesOnly) !== DEFAULT_MATRIX_FILTERS.differencesOnly,
    String(filters.intentStatus || "") !== DEFAULT_MATRIX_FILTERS.intentStatus,
    Boolean(filters.targetHolesOnly) !== DEFAULT_MATRIX_FILTERS.targetHolesOnly,
  ].filter(Boolean).length
}

function sortableDefaultOrder(row, index) {
  const order = Number(row?.defaultOrder)
  return Number.isFinite(order) ? order : index
}

function phaseSortPosition(row) {
  const phase = String(row?.phase || "")
  if (PHASE_EXECUTION_INDEX.has(phase)) {
    return {
      group: 0,
      order: PHASE_EXECUTION_INDEX.get(phase),
      phase,
    }
  }
  return {
    group: phase ? 1 : 2,
    order: 0,
    phase,
  }
}

function compareCategoryRows(left, right) {
  const categoryDifference = String(left.row?.category || "")
    .localeCompare(String(right.row?.category || ""))
  const labelDifference = String(left.row?.label || "")
    .localeCompare(String(right.row?.label || ""))
  return categoryDifference
    || labelDifference
    || left.defaultOrder - right.defaultOrder
    || left.index - right.index
}

export function sortMatrixRows(rows, sort = DEFAULT_MATRIX_SORT) {
  const decorated = [...(rows || [])].map((row, index) => ({
    defaultOrder: sortableDefaultOrder(row, index),
    index,
    phase: phaseSortPosition(row),
    row,
  }))
  decorated.sort((left, right) => {
    if (sort === MATRIX_SORT.PHASE_EXECUTION) {
      const phaseDifference = left.phase.group - right.phase.group
        || left.phase.order - right.phase.order
        || left.phase.phase.localeCompare(right.phase.phase)
      if (phaseDifference !== 0) return phaseDifference
    }
    return compareCategoryRows(left, right)
  })
  return decorated.map((entry) => entry.row)
}

export function matrixColumnIsVisible(zoneId, selectedZoneIds, selectedOnly) {
  if (!selectedOnly) return true
  const selected = selectedZoneIds instanceof Set
    ? selectedZoneIds
    : new Set(selectedZoneIds || [])
  return selected.has(zoneId)
}

export function matrixRowMatchesFilters(row, filters) {
  const terms = String(filters.query || "")
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
  const search = String(row.search || "").toLowerCase()
  const targetZoneIds = filters.targetZoneIds instanceof Set
    ? filters.targetZoneIds
    : new Set(filters.targetZoneIds || [])
  const hasTargetHole = !filters.targetHolesOnly
    || row.missingZoneIds.some((zoneId) => targetZoneIds.has(zoneId))
  return terms.every((term) => search.includes(term))
    && (!filters.category || row.category === filters.category)
    && (!filters.phase || row.phase === filters.phase)
    && (!filters.changeableOnly || row.changeable)
    && (!filters.recordType || row.recordType === filters.recordType)
    && (!filters.redirectType || (row.redirectTypes || []).includes(filters.redirectType))
    && (!filters.intentStatus || row.intentStatus === filters.intentStatus)
    && (!filters.differencesOnly || (row.actionable ?? row.different))
    && hasTargetHole
    && facetMatchesScope(
      Number(row.presentCount),
      Number(filters.zoneCount),
      filters.scope,
    )
}
