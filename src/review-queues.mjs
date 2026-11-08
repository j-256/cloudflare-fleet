import { evaluateFleetIntent, evaluateFleetIntentCoverage, fleetIntentFacetId, fleetIntentCoverageTargetKey } from "./fleet-intent.mjs"
import { coverageFor, staticCoverageIssues } from "./inventory.mjs"
import { buildMatrix } from "./matrix.mjs"
import { STATIC_LIMITATIONS } from "./constants.mjs"
import { materializeValue } from "./normalize.mjs"
import { facetReadRequirement } from "./facet-read-requirements.mjs"
import { alignmentCoverage } from "./alignment-coverage.mjs"
import { summarizeReviewValue, VALUE_SUMMARY_LENGTH } from "./review-value-summary.mjs"

export { summarizeReviewValue } from "./review-value-summary.mjs"

export const REVIEW_QUEUE = Object.freeze({ MISALIGNMENTS: "misalignments", DECISIONS: "decisions", READS: "reads" })
export const REVIEW_PAGE_LIMIT = Object.freeze({ DEFAULT: 10, MAX: 50, MAX_OFFSET: 100000 })
export const DEFAULT_REVIEW_REASON = "Observed configuration differs from saved intent"
const ITEM_OBSERVATION_LIMIT = 3

function expectedValue(policy) {
  try { return JSON.parse(policy.expected.canonical) } catch { return policy.expected?.value ?? policy.expected?.display }
}

function expectedSummary(policies, zoneName) {
  return [...new Set(policies.map((policy) => {
    if (policy.presenceConstraint === "forbidden") return "Must be absent"
    const value = expectedValue(policy)
    if (value !== undefined) return summarizeReviewValue(zoneName ? materializeValue(value, zoneName) : value)
    const presence = policy.presenceConstraint === "optional" ? "Optional" : "Required"
    return `${presence}; ${policy.valueConstraint === "may-differ" ? "values may differ" : policy.valueConstraint === "must-differ" ? "distinct value per zone" : "review saved expectation"}`
  }))].join("; ").slice(0, VALUE_SUMMARY_LENGTH) || "Review saved intent"
}

function observations(row, zones, expectedCells) {
  const seen = new Set()
  const representatives = []
  for (const zone of zones) {
    const canonical = row.cells.get(zone.meta.name)?.canonical ?? "not-observed"
    const policies = expectedCells?.get(zone.meta.id)?.policies
    const expectation = policies ? policies.map((policy) => [policy.presenceConstraint, policy.valueConstraint, policy.expected?.canonical]) : null
    const signature = JSON.stringify([canonical, expectation])
    if (zones.length > ITEM_OBSERVATION_LIMIT && seen.has(signature)) continue
    seen.add(signature)
    representatives.push(zone)
    if (representatives.length === ITEM_OBSERVATION_LIMIT) break
  }
  return representatives.map((zone) => {
    const cell = row.cells.get(zone.meta.name)
    return {
      zoneId: zone.meta.id,
      zoneName: zone.meta.name,
      value: summarizeReviewValue(cell ? materializeValue(cell.inspectionValue ?? cell.normalized, zone.meta.name) : undefined),
      ...(expectedCells ? { expected: expectedSummary(expectedCells.get(zone.meta.id)?.policies || [], zone.meta.name) } : {}),
    }
  })
}

function facetItem(row, zones, options = {}) {
  return {
    id: fleetIntentFacetId(row.category, row.key),
    kind: options.kind || "misalignment",
    label: row.label,
    facet: { category: row.category, key: row.key, label: row.label, phase: row.phase || "" },
    observed: observations(row, zones, options.expectedCells),
    zoneCount: zones.length,
    expected: options.expected || "No expected state saved",
    reason: options.reason || DEFAULT_REVIEW_REASON,
    policyId: options.policyId || null,
  }
}

export function buildReviewQueues({ inventory, intent, matrix = buildMatrix(inventory), evaluation = evaluateFleetIntent(intent, inventory, matrix), coverage }) {
  coverage ||= evaluateFleetIntentCoverage(intent, [
    ...coverageFor(inventory).flatMap((entry) => entry.failed),
    ...staticCoverageIssues(STATIC_LIMITATIONS),
  ])
  const misalignments = []
  const decisions = []
  let incompleteFacetCount = 0
  let decisionsAwaitingReads = 0
  for (const row of matrix.rows) {
    const rowState = evaluation.rowStates.get(fleetIntentFacetId(row.category, row.key))
    if (!rowState) continue
    const readable = alignmentCoverage(inventory, facetReadRequirement({ category: row.category, key: row.key })).complete
    if (!readable && rowState.governed) incompleteFacetCount += 1
    if (rowState.actionableCells.length) {
      misalignments.push(facetItem(row, rowState.actionableCells.map((cell) => cell.zone), {
        kind: readable ? "misalignment" : "unresolved",
        expected: expectedSummary([...new Map(rowState.actionableCells.flatMap((cell) => cell.policies).map((policy) => [policy.id, policy])).values()]),
        expectedCells: rowState.cells,
        ...(readable ? {} : { reason: "Required reads are incomplete; absence and full-facet alignment cannot be established" }),
      }))
    } else if (!rowState.governed && rowState.actionable) {
      if (readable || row.variantCount > 1) decisions.push(facetItem(row, readable ? inventory.zones : inventory.zones.filter((zone) => row.cells.has(zone.meta.name)), {
        kind: "decision", reason: readable
          ? "Observed differences have no saved intent; they are not failures"
          : "Known values differ; additional reads are incomplete",
      }))
      else decisionsAwaitingReads += 1
    }
  }
  const seenUnresolved = new Set()
  for (const policyState of evaluation.policyStates.filter((entry) => entry.unresolved)) {
    const policy = policyState.policy
    const id = fleetIntentFacetId(policy.facet.category, policy.facet.key)
    if (seenUnresolved.has(id)) continue
    seenUnresolved.add(id)
    const existing = misalignments.find((entry) => entry.id === id)
    if (existing) {
      existing.reason += "; some saved intent also needs review"
      continue
    }
    const row = matrix.rows.find((entry) => fleetIntentFacetId(entry.category, entry.key) === id)
      || { ...policy.facet, label: policy.facet.label || policy.facet.key, cells: new Map() }
    misalignments.push(facetItem(row, [], {
      kind: "unresolved", policyId: policy.id,
      expected: expectedSummary([policy]),
      reason: policyState.reason || "Saved intent cannot be fully evaluated against the loaded inventory",
    }))
  }
  const reads = coverage.unexpectedIssues.map(({ issue }) => ({
    id: fleetIntentCoverageTargetKey(issue), kind: "read", label: issue.subjectLabel,
    facet: null, policyId: null,
    observed: issue.zoneName ? [{ zoneId: issue.zoneId || "", zoneName: issue.zoneName, value: "Read incomplete" }] : [],
    zoneCount: issue.zoneName ? 1 : 0, expected: "A successful read",
    reason: String(issue.detail || issue.message || issue.reason || "Read coverage is incomplete").slice(0, VALUE_SUMMARY_LENGTH),
  }))
  for (const items of [misalignments, decisions, reads]) items.sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id))
  const configured = intent.policies.length > 0
  const status = misalignments.length ? "attention" : !configured ? "not-configured" : reads.length || incompleteFacetCount ? "incomplete" : "aligned"
  return {
    status,
    loadedAt: inventory.loadedAt,
    summary: {
      misalignments: misalignments.length,
      mismatchCells: misalignments.reduce((total, item) => total + (item.kind === "misalignment" ? item.zoneCount : 0), 0),
      decisions: decisions.length,
      ungovernedFacets: decisions.length + decisionsAwaitingReads,
      decisionsAwaitingReads,
      reads: reads.length,
      unresolvedPolicies: evaluation.summary.unresolvedPolicies,
      acknowledgedCells: evaluation.summary.acknowledgedCells,
      expectedReadGaps: coverage.expectedIssues.length,
      configured,
      complete: reads.length === 0 && incompleteFacetCount === 0 && evaluation.summary.unresolvedPolicies === 0,
    },
    misalignments, decisions, reads,
  }
}

export function reviewQueuePage(queues, { queue = REVIEW_QUEUE.MISALIGNMENTS, limit = REVIEW_PAGE_LIMIT.DEFAULT, offset = 0 } = {}) {
  if (!Object.values(REVIEW_QUEUE).includes(queue)) throw new TypeError("Unknown review queue")
  if (!Number.isInteger(limit) || limit < 1 || limit > REVIEW_PAGE_LIMIT.MAX) throw new TypeError("Review queue limit must be between 1 and 50")
  if (!Number.isInteger(offset) || offset < 0 || offset > REVIEW_PAGE_LIMIT.MAX_OFFSET) throw new TypeError("Invalid review queue offset")
  const items = queues[queue]
  return {
    status: queues.status, loadedAt: queues.loadedAt, summary: queues.summary,
    queue, items: items.slice(offset, offset + limit), total: items.length,
    limit, offset, hasMore: offset + limit < items.length,
  }
}
