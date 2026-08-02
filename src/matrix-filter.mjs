export const MATRIX_SCOPE = Object.freeze({
  ALL: "all",
  FLEET_PATTERNS: "fleet-patterns",
  FLEET_WIDE: "fleet-wide",
  ZONE_SPECIFIC: "zone-specific",
})

export const DEFAULT_MATRIX_SCOPE = MATRIX_SCOPE.FLEET_PATTERNS

export const DEFAULT_MATRIX_FILTERS = Object.freeze({
  category: "",
  differencesOnly: true,
  query: "",
  recordType: "",
  redirectType: "",
  scope: DEFAULT_MATRIX_SCOPE,
  targetHolesOnly: false,
})

export const DNS_MATRIX_CATEGORIES = Object.freeze([
  "DNS records",
  "Email DNS specification",
])

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
    String(filters.scope || "") !== DEFAULT_MATRIX_FILTERS.scope,
    String(filters.recordType || "") !== DEFAULT_MATRIX_FILTERS.recordType,
    String(filters.redirectType || "") !== DEFAULT_MATRIX_FILTERS.redirectType,
    Boolean(filters.differencesOnly) !== DEFAULT_MATRIX_FILTERS.differencesOnly,
    Boolean(filters.targetHolesOnly) !== DEFAULT_MATRIX_FILTERS.targetHolesOnly,
  ].filter(Boolean).length
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
    && (!filters.recordType || row.recordType === filters.recordType)
    && (!filters.redirectType || (row.redirectTypes || []).includes(filters.redirectType))
    && (!filters.differencesOnly || (row.actionable ?? row.different))
    && hasTargetHole
    && facetMatchesScope(
      Number(row.presentCount),
      Number(filters.zoneCount),
      filters.scope,
    )
}
