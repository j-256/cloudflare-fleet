import { INTENT_ADOPTION_CONFIDENCE } from "./intent-adoption.mjs"

// DOM-free view-model helpers for the adoption ("Review ungoverned drift")
// screen. They turn sub-project A's gaps view into the summary tier and the
// prioritized rows the dashboard renders, and are pure so they can be unit
// tested without a browser

const DEFAULT_TOP_ZONES = 6
const DEFAULT_OUTLIER_SHOWN = 3

export function topOutlierZones(perZoneOutlierTally, limit = DEFAULT_TOP_ZONES) {
  return Object.entries(perZoneOutlierTally || {})
    .map(([zone, count]) => ({ zone, count }))
    .sort((left, right) => right.count - left.count || left.zone.localeCompare(right.zone))
    .slice(0, limit)
}

export function truncateOutlierZones(zones, limit = DEFAULT_OUTLIER_SHOWN) {
  const list = zones || []
  return { shown: list.slice(0, limit), remaining: Math.max(0, list.length - limit) }
}

function allGaps(result) {
  const gaps = result?.gaps
  return [...(gaps?.presenceGaps || []), ...(gaps?.valueGaps || [])]
}

export function adoptionSummaryModel(result) {
  const gaps = result?.gaps || {}
  const presenceGapCount = (gaps.presenceGaps || []).length
  const valueGapCount = (gaps.valueGaps || []).length
  const highConfidenceGapCount = allGaps(result)
    .filter((entry) => entry.candidate.confidence === INTENT_ADOPTION_CONFIDENCE.HIGH)
    .length
  return {
    presenceGapCount,
    valueGapCount,
    totalGaps: presenceGapCount + valueGapCount,
    highConfidenceGapCount,
    topZones: topOutlierZones(gaps.perZoneOutlierTally),
  }
}

export function adoptionGapRows(result, zoneTotal) {
  return allGaps(result).map((entry) => {
    const candidate = entry.candidate
    return {
      id: candidate.id,
      label: candidate.label,
      category: candidate.category,
      classification: candidate.classification,
      confidence: candidate.confidence,
      gapKind: entry.gapKind,
      presentCount: candidate.presentCount,
      zoneTotal,
      coverageLabel: `${candidate.presentCount}/${zoneTotal} present`,
      outlier: truncateOutlierZones(entry.outlierZones),
      outlierZones: entry.outlierZones,
      suggestion: candidate.recommendation?.reason || "",
    }
  })
}
