import { test } from "node:test"
import assert from "node:assert/strict"
import { INTENT_ADOPTION_CONFIDENCE } from "../src/intent-adoption.mjs"
import {
  topOutlierZones,
  truncateOutlierZones,
  adoptionSummaryModel,
  adoptionGapRows,
} from "../src/intent-adoption-view.mjs"

function gap(overrides = {}) {
  return {
    candidate: {
      id: JSON.stringify(["dns", overrides.key || "spf"]),
      label: overrides.label || "SPF record",
      category: overrides.category || "dns",
      classification: overrides.classification || "strong-consensus",
      confidence: overrides.confidence || INTENT_ADOPTION_CONFIDENCE.HIGH,
      presentCount: overrides.presentCount ?? 10,
      missingCount: overrides.missingCount ?? 1,
      recommendation: { reason: overrides.reason || "Present on 10 of 11 zones" },
    },
    gapKind: overrides.gapKind || "presence",
    outlierZones: overrides.outlierZones || ["z1"],
  }
}

test("topOutlierZones ranks by count desc then zone asc and caps", () => {
  assert.deepEqual(topOutlierZones({ alpha: 1, bravo: 3, charlie: 3, delta: 2 }, 3), [
    { zone: "bravo", count: 3 },
    { zone: "charlie", count: 3 },
    { zone: "delta", count: 2 },
  ])
})

test("topOutlierZones tolerates an empty or missing tally", () => {
  assert.deepEqual(topOutlierZones(undefined), [])
  assert.deepEqual(topOutlierZones({}), [])
})

test("truncateOutlierZones splits shown and remaining", () => {
  assert.deepEqual(truncateOutlierZones(["a", "b", "c", "d", "e"], 3), {
    shown: ["a", "b", "c"],
    remaining: 2,
  })
  assert.deepEqual(truncateOutlierZones(["a"], 3), { shown: ["a"], remaining: 0 })
  assert.deepEqual(truncateOutlierZones([], 3), { shown: [], remaining: 0 })
})

test("adoptionSummaryModel counts gaps, high-confidence, and top zones", () => {
  const result = {
    gaps: {
      presenceGaps: [
        gap({ confidence: INTENT_ADOPTION_CONFIDENCE.HIGH, outlierZones: ["z1"] }),
        gap({ key: "dmarc", confidence: INTENT_ADOPTION_CONFIDENCE.REVIEW, outlierZones: ["z2"] }),
      ],
      valueGaps: [gap({ key: "hsts", gapKind: "value", confidence: INTENT_ADOPTION_CONFIDENCE.HIGH, outlierZones: ["z1"] })],
      perZoneOutlierTally: { z1: 2, z2: 1 },
    },
  }
  assert.deepEqual(adoptionSummaryModel(result), {
    presenceGapCount: 2,
    valueGapCount: 1,
    totalGaps: 3,
    highConfidenceGapCount: 2,
    topZones: [{ zone: "z1", count: 2 }, { zone: "z2", count: 1 }],
  })
})

test("adoptionSummaryModel tolerates a result without gaps", () => {
  assert.deepEqual(adoptionSummaryModel({}), {
    presenceGapCount: 0,
    valueGapCount: 0,
    totalGaps: 0,
    highConfidenceGapCount: 0,
    topZones: [],
  })
})

test("adoptionGapRows keeps presence-before-value order and builds the row model", () => {
  const result = {
    gaps: {
      presenceGaps: [gap({ key: "spf", presentCount: 10, outlierZones: ["z1", "z2", "z3", "z4"] })],
      valueGaps: [gap({ key: "hsts", gapKind: "value", presentCount: 11, outlierZones: ["z9"] })],
    },
  }
  const rows = adoptionGapRows(result, 11)
  assert.equal(rows.length, 2)
  assert.equal(rows[0].gapKind, "presence")
  assert.equal(rows[0].coverageLabel, "10/11 present")
  assert.deepEqual(rows[0].outlier, { shown: ["z1", "z2", "z3"], remaining: 1 })
  assert.equal(rows[1].gapKind, "value")
  assert.equal(rows[1].suggestion, "Present on 10 of 11 zones")
})
