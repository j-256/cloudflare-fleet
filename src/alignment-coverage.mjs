const MAX_COVERAGE_FAILURES = 50

export function alignmentCoverage(inventory, requirement) {
  const failures = []
  let failureCount = 0
  function failed(response, context) {
    failureCount += 1
    if (failures.length >= MAX_COVERAGE_FAILURES) return
    failures.push({
      ...context,
      errorKind: response?.error?.aborted
        ? response.error.abortKind === "timeout" ? "timeout" : "cancelled"
        : response?.error ? "read-failed" : "not-read",
      status: response?.status ?? response?.error?.status ?? null,
    })
  }
  for (const surfaceId of requirement.accountSurfaceIds || []) {
    const response = inventory.account?.surfaces?.[surfaceId]
    if (!response?.ok) failed(response, { surfaceId, zoneId: null, zoneName: null })
  }
  for (const zone of inventory.zones) {
    for (const surfaceId of requirement.surfaceIds) {
      const response = zone.surfaces[surfaceId]
      if (!response?.ok) failed(response, { surfaceId, zoneId: zone.meta.id, zoneName: zone.meta.name })
    }
    if (!requirement.includeRuleDetails || !zone.surfaces.rulesets?.ok) continue
    const expected = (zone.surfaces.rulesets.result || []).filter((ruleset) => (
      (!requirement.ruleDetailPhases || requirement.ruleDetailPhases.includes(ruleset.phase))
        && (!requirement.ruleDetailKinds || requirement.ruleDetailKinds.includes(ruleset.kind))
    ))
    for (const ruleset of expected) {
      const detail = zone.ruleDetails.find((entry) => (
        (entry.rulesetId || entry.result?.id) === ruleset.id
      ))
      if (!detail?.ok || detail.result?.id !== ruleset.id) {
        failed(detail, {
          phase: ruleset.phase,
          rulesetId: ruleset.id,
          surfaceId: "rulesets",
          zoneId: zone.meta.id,
          zoneName: zone.meta.name,
        })
      }
    }
  }
  return { complete: failureCount === 0, failureCount, failures, truncated: failureCount > failures.length }
}

export function incompleteAlignmentReason(coverage) {
  const subjects = coverage.failures.map((entry) => (
    `${entry.zoneName || "account"}: ${entry.surfaceId}${entry.rulesetId ? `/${entry.rulesetId}` : ""} (${entry.errorKind}${entry.status ? `, HTTP ${entry.status}` : ""})`
  ))
  return `Intent alignment is blocked by incomplete inventory: ${subjects.join(", ")}${coverage.truncated ? "; additional failed reads omitted" : ""}. Retry the read before assessing absence, drift, or alignment.`
}
