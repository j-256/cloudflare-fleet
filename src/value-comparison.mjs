import { stableString } from "./normalize.mjs"

const MAX_TOKEN_DIFF_MATRIX_CELLS = 250_000
const TOKEN_PATTERN = /\s+|[A-Za-z0-9_$./:{}-]+|./gu

export const VALUE_TEXT_DIFF_KIND = Object.freeze({
  DELETE: "delete",
  EQUAL: "equal",
  INSERT: "insert",
})

function cloneJsonValue(value) {
  const serialized = JSON.stringify(value)
  return serialized === undefined ? null : JSON.parse(serialized)
}

function canonicalValue(canonical) {
  try {
    return JSON.parse(canonical)
  } catch {
    return canonical
  }
}

function compareCanonical(left, right) {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

function comparePath(left, right) {
  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    if (index >= left.length) return -1
    if (index >= right.length) return 1
    const leftPart = left[index]
    const rightPart = right[index]
    if (typeof leftPart === "number" && typeof rightPart === "number") {
      if (leftPart !== rightPart) return leftPart - rightPart
      continue
    }
    const compared = String(leftPart).localeCompare(String(rightPart))
    if (compared !== 0) return compared
  }
  return 0
}

function flattenedValue(value, path = [], flattened = new Map()) {
  if (Array.isArray(value) && value.length > 0) {
    for (const [index, entry] of value.entries()) {
      flattenedValue(entry, [...path, index], flattened)
    }
    return flattened
  }
  if (value && typeof value === "object" && Object.keys(value).length > 0) {
    for (const [key, entry] of Object.entries(value)) {
      flattenedValue(entry, [...path, key], flattened)
    }
    return flattened
  }
  flattened.set(JSON.stringify(path), {
    path,
    value: cloneJsonValue(value),
  })
  return flattened
}

function comparisonFields(variants) {
  const flattened = variants.map((variant) => flattenedValue(variant.value))
  const paths = new Map()
  for (const fields of flattened) {
    for (const [key, field] of fields) paths.set(key, field.path)
  }
  const rows = [...paths.entries()]
    .map(([key, path]) => {
      const values = flattened.map((fields) => {
        const field = fields.get(key)
        return field
          ? { present: true, value: cloneJsonValue(field.value) }
          : { present: false, value: null }
      })
      const distinct = new Set(values.map((entry) => (
        entry.present ? `value:${stableString(entry.value)}` : "missing"
      )))
      return {
        different: distinct.size > 1,
        path,
        values,
      }
    })
    .sort((left, right) => comparePath(left.path, right.path))
  return {
    commonFieldCount: rows.filter((row) => !row.different).length,
    differences: rows.filter((row) => row.different),
    fieldCount: rows.length,
  }
}

function rankedIntentCanonicals(intentCanonicalCounts) {
  return [...intentCanonicalCounts.entries()].sort(
    ([leftCanonical, leftCount], [rightCanonical, rightCount]) =>
      rightCount - leftCount || compareCanonical(leftCanonical, rightCanonical),
  )
}

export function compareFleetValueVariants(values, options = {}) {
  const variants = values
    .map((variant) => ({
      ...variant,
      count: variant.count ?? variant.zones?.length ?? 0,
      value: cloneJsonValue(variant.value),
      zones: [...(variant.zones || [])]
        .sort((left, right) => left.name.localeCompare(right.name)),
    }))
    .sort((left, right) => right.count - left.count
      || compareCanonical(left.canonical, right.canonical))
  const hasUniqueConsensus = variants.length > 0
    && variants[0].count > (variants[1]?.count || 0)
  const consensusCanonical = hasUniqueConsensus
    ? variants[0].canonical
    : null
  const referenceCanonical = consensusCanonical || variants[0]?.canonical || null
  const fields = comparisonFields(variants)
  const missingZones = [...(options.missingZones || [])]
    .sort((left, right) => left.name.localeCompare(right.name))
  const presentCount = variants.reduce((sum, variant) => sum + variant.count, 0)
  return {
    ...fields,
    consensusCanonical,
    consensusCount: hasUniqueConsensus ? variants[0].count : 0,
    hasUniqueConsensus,
    missingZones,
    presentCount,
    referenceCanonical,
    variantCount: variants.length,
    variants,
    zoneCount: options.zoneCount ?? presentCount + missingZones.length,
  }
}

export function groupFleetRowIntentValues(row, zones) {
  const groups = new Map()
  for (const zone of zones) {
    const cell = row.cells.get(zone.meta.name)
    if (!cell) continue
    const canonical = cell.intentCanonical ?? cell.canonical
    const hasIntentValue = Object.prototype.hasOwnProperty.call(cell, "intentValue")
    const hasInspectionValue = Object.prototype.hasOwnProperty.call(
      cell,
      "inspectionValue",
    )
    const value = hasIntentValue
      ? cell.intentValue
      : hasInspectionValue
        ? cell.inspectionValue
        : canonicalValue(canonical)
    if (!groups.has(canonical)) {
      groups.set(canonical, {
        canonical,
        count: 0,
        display: cell.intentDisplay ?? cell.display,
        resolutionCanonical: cell.resolutionCanonical || null,
        sourceZoneId: zone.meta.id,
        sourceZoneName: zone.meta.name,
        value: cloneJsonValue(value),
        zones: [],
      })
    }
    const group = groups.get(canonical)
    group.count += 1
    group.zones.push({ id: zone.meta.id, name: zone.meta.name })
    const sourceCell = row.cells.get(group.sourceZoneName)
    if (!sourceCell?.resolutionSource && cell.resolutionSource) {
      group.resolutionCanonical = cell.resolutionCanonical || null
      group.sourceZoneId = zone.meta.id
      group.sourceZoneName = zone.meta.name
      group.value = cloneJsonValue(value)
    }
  }
  return [...groups.values()]
}

export function compareFleetRowValues(row, zones) {
  const groups = new Map()
  const missingZones = []
  for (const zone of zones) {
    const cell = row.cells.get(zone.meta.name)
    if (!cell) {
      missingZones.push({ id: zone.meta.id, name: zone.meta.name })
      continue
    }
    if (!groups.has(cell.canonical)) {
      groups.set(cell.canonical, {
        canonical: cell.canonical,
        display: cell.display,
        intentCanonicalCounts: new Map(),
        value: canonicalValue(cell.canonical),
        zones: [],
      })
    }
    const group = groups.get(cell.canonical)
    const intentCanonical = cell.intentCanonical ?? cell.canonical
    group.intentCanonicalCounts.set(
      intentCanonical,
      (group.intentCanonicalCounts.get(intentCanonical) || 0) + 1,
    )
    group.zones.push({ id: zone.meta.id, name: zone.meta.name })
  }

  const variants = [...groups.values()].map((group) => {
    const intentCanonicals = rankedIntentCanonicals(group.intentCanonicalCounts)
    return {
      canonical: group.canonical,
      count: group.zones.length,
      display: group.display,
      intentCanonical: intentCanonicals.length === 1
        ? intentCanonicals[0][0]
        : null,
      value: group.value,
      zones: group.zones,
    }
  })
  return compareFleetValueVariants(variants, {
    missingZones,
    zoneCount: zones.length,
  })
}

function appendSegment(segments, kind, text) {
  if (!text) return
  const previous = segments.at(-1)
  if (previous?.kind === kind) previous.text += text
  else segments.push({ kind, text })
}

function sharedEdgeDiff(reference, candidate) {
  let prefixLength = 0
  while (prefixLength < reference.length
    && prefixLength < candidate.length
    && reference[prefixLength] === candidate[prefixLength]) {
    prefixLength += 1
  }
  let suffixLength = 0
  while (suffixLength < reference.length - prefixLength
    && suffixLength < candidate.length - prefixLength
    && reference[reference.length - suffixLength - 1]
      === candidate[candidate.length - suffixLength - 1]) {
    suffixLength += 1
  }
  const segments = []
  appendSegment(segments, VALUE_TEXT_DIFF_KIND.EQUAL, reference.slice(0, prefixLength))
  appendSegment(
    segments,
    VALUE_TEXT_DIFF_KIND.DELETE,
    reference.slice(prefixLength, reference.length - suffixLength),
  )
  appendSegment(
    segments,
    VALUE_TEXT_DIFF_KIND.INSERT,
    candidate.slice(prefixLength, candidate.length - suffixLength),
  )
  appendSegment(
    segments,
    VALUE_TEXT_DIFF_KIND.EQUAL,
    suffixLength > 0 ? reference.slice(reference.length - suffixLength) : "",
  )
  return segments
}

export function diffValueText(reference, candidate) {
  const referenceText = String(reference)
  const candidateText = String(candidate)
  if (referenceText === candidateText) {
    return [{ kind: VALUE_TEXT_DIFF_KIND.EQUAL, text: referenceText }]
  }
  const referenceTokens = referenceText.match(TOKEN_PATTERN) || []
  const candidateTokens = candidateText.match(TOKEN_PATTERN) || []
  if (referenceTokens.length * candidateTokens.length
    > MAX_TOKEN_DIFF_MATRIX_CELLS) {
    return sharedEdgeDiff(referenceText, candidateText)
  }

  const lengths = Array.from(
    { length: referenceTokens.length + 1 },
    () => new Uint32Array(candidateTokens.length + 1),
  )
  for (let left = referenceTokens.length - 1; left >= 0; left -= 1) {
    for (let right = candidateTokens.length - 1; right >= 0; right -= 1) {
      lengths[left][right] = referenceTokens[left] === candidateTokens[right]
        ? lengths[left + 1][right + 1] + 1
        : Math.max(lengths[left + 1][right], lengths[left][right + 1])
    }
  }

  const segments = []
  let left = 0
  let right = 0
  while (left < referenceTokens.length || right < candidateTokens.length) {
    if (left < referenceTokens.length
      && right < candidateTokens.length
      && referenceTokens[left] === candidateTokens[right]) {
      appendSegment(segments, VALUE_TEXT_DIFF_KIND.EQUAL, referenceTokens[left])
      left += 1
      right += 1
    } else if (right < candidateTokens.length
      && (left >= referenceTokens.length
        || lengths[left][right + 1] > lengths[left + 1][right])) {
      appendSegment(segments, VALUE_TEXT_DIFF_KIND.INSERT, candidateTokens[right])
      right += 1
    } else {
      appendSegment(segments, VALUE_TEXT_DIFF_KIND.DELETE, referenceTokens[left])
      left += 1
    }
  }
  return segments
}
