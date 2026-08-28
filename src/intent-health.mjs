import { FLEET_INTENT_ROW_STATUS } from "./fleet-intent.mjs"

export const FLEET_INTENT_HEALTH_STATUS = Object.freeze({
  ALIGNED: "aligned",
  DRIFT: "drift",
  EMPTY: "empty",
  REVIEW: "review",
})

export function fleetIntentFacetResultPresentation(rowState = {}) {
  const applicableCount = rowState.applicableCount || 0
  const acknowledgedCount = rowState.acknowledgedCount || 0
  const actionableCount = rowState.actionableCells?.length || 0
  const satisfiedCount = rowState.satisfiedCount || 0
  const status = rowState.status || FLEET_INTENT_ROW_STATUS.UNGOVERNED
  if (status === FLEET_INTENT_ROW_STATUS.MATCH) {
    return {
      label: `Matches intent ${satisfiedCount}/${applicableCount}`,
      status,
      title: `All ${applicableCount} applicable zone${applicableCount === 1 ? "" : "s"} ${applicableCount === 1 ? "satisfies" : "satisfy"} fleet intent${acknowledgedCount > 0 ? `, including ${acknowledgedCount} acknowledged exact state${acknowledgedCount === 1 ? "" : "s"}` : ""}`,
    }
  }
  if (status === FLEET_INTENT_ROW_STATUS.DRIFT) {
    return {
      label: `Intent drift ${actionableCount}/${applicableCount}`,
      status,
      title: `${actionableCount} of ${applicableCount} applicable zone${applicableCount === 1 ? "" : "s"} ${actionableCount === 1 ? "does" : "do"} not satisfy fleet intent; ${satisfiedCount} ${satisfiedCount === 1 ? "satisfies" : "satisfy"} it`,
    }
  }
  if (status === FLEET_INTENT_ROW_STATUS.REVIEW) {
    return {
      label: "Intent needs review",
      status,
      title: "Saved fleet intent cannot be fully evaluated against the loaded zones",
    }
  }
  return {
    label: "Intent not set",
    status: FLEET_INTENT_ROW_STATUS.UNGOVERNED,
    title: "No fleet intent policy governs this facet",
  }
}

function plural(count, singular, pluralValue = `${singular}s`) {
  return count === 1 ? singular : pluralValue
}

function ungovernedDetail(count, prefix = "") {
  if (count === 0) return prefix
  const detail = `${count} observed ${plural(count, "difference")} ${count === 1 ? "has" : "have"} no saved intent and ${count === 1 ? "is" : "are"} not ${plural(count, "failure")}.`
  return [prefix, detail].filter(Boolean).join(" ")
}

function zoneMatchTitle(matchingZones, zones) {
  if (zones === 1) {
    return matchingZones === 1
      ? "The loaded zone matches fleet intent"
      : "The loaded zone does not match fleet intent"
  }
  return matchingZones === zones
    ? `All ${zones} zones match fleet intent`
    : `${matchingZones} of ${zones} zones match fleet intent`
}

export function fleetIntentHealth(summary = {}) {
  const actionableCells = summary.actionableCells || 0
  const actionableZones = summary.actionableZones || 0
  const governedRows = summary.governedRows || 0
  const matchingZones = summary.matchingZones || 0
  const policies = summary.policies || 0
  const unresolvedPolicies = summary.unresolvedPolicies || 0
  const ungovernedRows = summary.ungovernedRows || 0
  const zones = summary.zones || 0

  if (zones === 0) {
    return {
      actionLabel: "View intent",
      detail: "Load fleet inventory before evaluating saved intent.",
      matchMetric: "Waiting",
      status: FLEET_INTENT_HEALTH_STATUS.REVIEW,
      title: "Fleet intent is waiting for zone data",
    }
  }

  if (policies === 0) {
    return {
      actionLabel: "Define intent",
      detail: ungovernedDetail(
        ungovernedRows,
        "No configuration is governed yet.",
      ),
      matchMetric: "Not set",
      status: FLEET_INTENT_HEALTH_STATUS.EMPTY,
      title: "Fleet intent is not defined",
    }
  }

  if (actionableCells > 0) {
    const mismatchDetail = `${actionableZones} ${plural(actionableZones, "zone")} ${actionableZones === 1 ? "has" : "have"} ${actionableCells} actionable ${plural(actionableCells, "mismatch", "mismatches")} across ${governedRows} governed ${plural(governedRows, "facet")}.`
    return {
      actionLabel: "Review intent",
      detail: ungovernedDetail(ungovernedRows, mismatchDetail),
      matchMetric: `${matchingZones} / ${zones}`,
      status: FLEET_INTENT_HEALTH_STATUS.DRIFT,
      title: zoneMatchTitle(matchingZones, zones),
    }
  }

  if (unresolvedPolicies > 0) {
    const unresolvedDetail = `${unresolvedPolicies} saved ${plural(unresolvedPolicies, "policy", "policies")} cannot be evaluated against the loaded fleet.`
    return {
      actionLabel: "Review intent",
      detail: ungovernedDetail(ungovernedRows, unresolvedDetail),
      matchMetric: "Review",
      status: FLEET_INTENT_HEALTH_STATUS.REVIEW,
      title: "Fleet intent cannot be fully evaluated",
    }
  }

  const alignedDetail = `Every loaded zone satisfies the intent that applies to it across ${governedRows} governed ${plural(governedRows, "facet")}.`
  return {
    actionLabel: "View intent",
    detail: ungovernedDetail(ungovernedRows, alignedDetail),
    matchMetric: `${zones} / ${zones}`,
    status: FLEET_INTENT_HEALTH_STATUS.ALIGNED,
    title: zoneMatchTitle(zones, zones),
  }
}
