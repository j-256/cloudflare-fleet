import { alignmentCoverage } from "./alignment-coverage.mjs"
import { matrixRowCapabilities } from "./capabilities.mjs"
import { evaluateFleetIntent, fleetIntentFacetId } from "./fleet-intent.mjs"
import { facetCellComparisonValue, facetPhase } from "./facet-equivalence.mjs"
import { buildMatrix } from "./matrix.mjs"
import { dnsRecordEditCapability, emailRoutingRuleEditCapability } from "./policies.mjs"
import { RATE_LIMIT_REQUIRED_RULE_PHASES, RATE_LIMIT_REQUIRED_SURFACE_IDS } from "./rate-limit-intent.mjs"
import { ZONE_ALIAS_REQUIRED_ACCOUNT_SURFACE_IDS, ZONE_ALIAS_REQUIRED_SURFACE_IDS } from "./zone-alias-intent.mjs"
import { SURFACES } from "./constants.mjs"
import { activityMatches, activitySummary, compareActivity, policyMatches, policySummary } from "./state-retrieval.mjs"
import { parseRetrievalInput, RETRIEVAL_LIMIT } from "./retrieval-schemas.mjs"
import { boundedValue, compareIds, COMPLETE_READ, cursorOffset, matchesSearch, retrievalDigest, retrievalPage, valueAtPath } from "./retrieval-values.mjs"

const CATEGORY_SURFACES = Object.freeze({
  Zone: [], "Zone settings": ["settings"], "DNS records": ["dns", "email-dns"], DNSSEC: ["dnssec"],
  Email: ["email", "email-catch-all"], "Email routes": ["email-rules"], "Email DNS specification": ["email-dns", "dns"],
  Rulesets: ["rulesets"], "Ruleset rules": ["rulesets"], Redirects: ["rulesets"],
  "Rate limiting": RATE_LIMIT_REQUIRED_SURFACE_IDS, "Zone aliases": ZONE_ALIAS_REQUIRED_SURFACE_IDS,
  "Workers routes": ["workers-routes"], "Legacy firewall view": ["firewall-rules"], "IP access rules": ["access-rules"],
  "Health checks": ["healthchecks"], "Load balancers": ["load-balancers"], "Logpush jobs": ["logpush"], "Waiting rooms": ["waiting-rooms"],
  "Web3 hostnames": ["web3"], Performance: ["argo-tiered", "smart-tiered"], Security: ["bot-management"],
  TLS: ["universal-ssl", "origin-pq"], Snippets: ["snippets"], "TLS inventory": ["certificate-packs"],
})
const RESOURCE_SURFACES = Object.freeze({ "dns-record": "dns", "zone-setting": "settings", ruleset: "rulesets", "ruleset-rule": "rulesets", "email-rule": "email-rules" })
const EDITABLE_RULESET_KINDS = Object.freeze(["zone", "custom"])
const facetIdentity = (row) => ({ category: row.category, key: row.key, label: row.label || row.key, phase: row.phase || null })

export function facetReadRequirement(query) {
  if (query.phase && !["Rulesets", "Ruleset rules", "Redirects"].includes(query.category)) throw new TypeError("phase requires a Rulesets, Ruleset rules or Redirects category")
  const keyPhase = query.key ? facetPhase({ ...query, phase: undefined }) : null
  if (query.phase && keyPhase && keyPhase !== query.phase) throw new TypeError("Facet phase does not match its key")
  const phase = query.phase || (query.key ? facetPhase(query) : null)
  const requirement = {
    surfaceIds: CATEGORY_SURFACES[query.category], accountSurfaceIds: [], includeEmailAddresses: false,
    includeRuleDetails: ["Rulesets", "Ruleset rules", "Redirects", "Rate limiting", "Zone aliases"].includes(query.category),
    ruleDetailKinds: EDITABLE_RULESET_KINDS,
    ...(phase ? { ruleDetailPhases: [phase] } : {}),
  }
  if (query.category === "Zone aliases") requirement.accountSurfaceIds = ZONE_ALIAS_REQUIRED_ACCOUNT_SURFACE_IDS
  if (query.category === "Rate limiting") {
    requirement.ruleDetailPhases = RATE_LIMIT_REQUIRED_RULE_PHASES
    requirement.ruleDetailKinds = ["zone"]
  }
  if (query.category === "Email" && query.key) requirement.surfaceIds = query.key === "catch-all" ? ["email-catch-all"] : ["email"]
  if (["Performance", "TLS"].includes(query.category) && requirement.surfaceIds.includes(query.key)) requirement.surfaceIds = [query.key]
  return requirement
}

export function createFleetRetrievalService({ accountId, api, readActivity, readIntent, loadInventory, now = Date.now, queryActivity, getActivity }) {
  const storedBase = (document) => ({
    accountId, schemaVersion: 1, status: "ok", coverage: COMPLETE_READ,
    freshness: { source: "stored", readAt: new Date(now()).toISOString(), revision: document.revision, storedAt: document.updatedAt },
  })
  async function page(kind, query, revision, items, project = (value) => value) {
    const { offset } = await cursorOffset(accountId, kind, query, revision)
    const selected = await Promise.all(items.slice(offset, offset + query.limit).map(project))
    return retrievalPage({ accountId, kind, query, revision, items: selected, total: items.length, offset })
  }
  async function stored(kind, query) {
    if (kind === "activity-list") {
      if (queryActivity) {
        const result = await queryActivity(query)
        const items = await Promise.all(result.entries.map((entry) => activitySummary(entry, query.view)))
        return { ...storedBase(result), ...await retrievalPage({ accountId, kind, query, revision: result.revision, items, total: result.total, offset: result.offset }) }
      }
      const document = await readActivity()
      const entries = document.entries.filter((entry) => activityMatches(entry, query)).sort(compareActivity)
      return { ...storedBase(document), ...await page(kind, query, document.revision, entries, (entry) => activitySummary(entry, query.view)) }
    }
    if (kind === "activity-get") {
      const document = getActivity ? await getActivity(query.id) : await readActivity()
      const entry = document.entries.find((item) => item.id === query.id)
      return { ...storedBase(document), status: entry ? "ok" : "not-found", id: query.id, path: query.path, summary: entry ? await activitySummary(entry) : null, detail: entry ? await boundedValue(valueAtPath(entry, query.path)) : null }
    }
    const document = await readIntent()
    if (kind === "policy-list") {
      const policies = document.policies.filter((policy) => policyMatches(policy, document, query)).sort((left, right) => compareIds(left.id, right.id))
      return { ...storedBase(document), ...await page(kind, query, document.revision, policies, (policy) => policySummary(policy, document, query.view)) }
    }
    const policy = document.policies.find((item) => item.id === query.id)
    return { ...storedBase(document), status: policy ? "ok" : "not-found", id: query.id, path: query.path, summary: policy ? await policySummary(policy, document) : null, detail: policy ? await boundedValue(valueAtPath(policy, query.path)) : null, group: policy ? await boundedValue(document.groups.find((group) => group.id === policy.groupId)) : null }
  }
  async function liveInventory(requirement, context, transport = api) {
    const inventory = await loadInventory(transport, { ...requirement, ...context, includeEmailAddresses: false })
    const coverage = alignmentCoverage(inventory, requirement)
    const revision = await retrievalDigest({ account: inventory.account, zones: inventory.zones.map((zone) => ({ ...zone, ruleDetails: [...zone.ruleDetails].sort((left, right) => compareIds(left.rulesetId || left.result?.id || "", right.rulesetId || right.result?.id || "")) })) })
    return {
      inventory,
      base: {
        accountId, schemaVersion: 1, status: coverage.complete ? "ok" : "incomplete", coverage,
        freshness: { source: "live", readAt: inventory.loadedAt, revision },
        scope: { zoneIds: inventory.zones.map((zone) => zone.meta.id).sort(compareIds).slice(0, RETRIEVAL_LIMIT.MAX), zoneCount: inventory.zones.length, zoneIdsTruncated: inventory.zones.length > RETRIEVAL_LIMIT.MAX, surfaceIds: requirement.surfaceIds, accountSurfaceIds: requirement.accountSurfaceIds || [], phases: requirement.ruleDetailPhases || [], membership: "account" },
      },
    }
  }
  async function resources(kind, query, context) {
    const requirement = kind === "zone-list"
      ? { surfaceIds: [], accountSurfaceIds: [], includeRuleDetails: false }
      : { surfaceIds: [RESOURCE_SURFACES[query.kind]], accountSurfaceIds: [], zoneIds: [query.zoneId], includeRuleDetails: query.kind === "ruleset-rule" || query.kind === "ruleset" && query.view === "full", ruleDetailKinds: EDITABLE_RULESET_KINDS, ...(query.phase ? { ruleDetailPhases: [query.phase] } : {}) }
    const { inventory, base } = await liveInventory(requirement, context, kind === "resource-list" ? resourceTransport(api, query) : api)
    if (kind === "zone-list") {
      const zones = inventory.zones.map(({ meta }) => ({ id: meta.id, name: meta.name, status: meta.status || null, paused: meta.paused === true, plan: meta.plan?.name || null }))
        .filter((zone) => (!query.name || zone.name === query.name) && matchesSearch(query.search, zone.id, zone.name))
        .sort((left, right) => compareIds(left.name, right.name) || compareIds(left.id, right.id))
      return { ...base, ...await page(kind, query, base.freshness.revision, zones) }
    }
    base.scope.resource = { kind: query.kind, id: query.id || null, rulesetId: query.rulesetId || null }
    const items = inventory.zones.flatMap((zone) => resourceItems(zone, query))
      .filter((item) => (!query.id || item.id === query.id) && (!query.name || item.name === query.name) && (!query.type || item.type === query.type) && (!query.phase || item.phase === query.phase) && matchesSearch(query.search, item.id, item.name, item.type, item.phase))
      .sort((left, right) => compareIds(left.rulesetId || "", right.rulesetId || "") || compareIds(left.id, right.id))
    return { ...base, kind: query.kind, ...await page(kind, query, base.freshness.revision, items, async ({ raw, ...item }) => ({ ...item, ...(query.view === "full" ? { detail: await boundedValue(valueAtPath(raw, query.path)) } : {}) })) }
  }
  async function facets(kind, query, context) {
    const requirement = facetReadRequirement(query)
    if (kind === "facet-list" && query.zoneId) requirement.zoneIds = [query.zoneId]
    const { inventory, base } = await liveInventory(requirement, context)
    const matrix = buildMatrix(inventory)
    if (kind === "facet-list") {
      const rows = matrix.rows.filter((row) => row.category === query.category && (!query.phase || row.phase === query.phase) && matchesSearch(query.search, row.key, row.label))
        .sort((left, right) => compareIds(left.key, right.key))
      return { ...base, ...await page(kind, query, base.freshness.revision, rows, (row) => ({ ...facetIdentity(row), capabilities: base.coverage.complete ? matrixRowCapabilities(row) : ["compare"], observedZones: row.cells.size })) }
    }
    const zone = inventory.zones.find((entry) => entry.meta.id === query.zoneId)
    if (!zone) throw new TypeError(`Unknown zone identifier: ${query.zoneId}`)
    const document = await readIntent()
    const evaluation = evaluateFleetIntent(document, inventory, matrix)
    const facetId = fleetIntentFacetId(query.category, query.key)
    const row = matrix.rows.find((entry) => entry.category === query.category && entry.key === query.key && (!query.phase || entry.phase === query.phase))
    const rowState = evaluation.rowStates.get(facetId)
    const cell = row?.cells.get(zone.meta.name)
    const intentCell = rowState?.cells.get(query.zoneId)
    const policyStates = evaluation.policyStates.filter((entry) => entry.policy.facet.category === query.category && entry.policy.facet.key === query.key && (!query.phase || facetPhase(entry.policy.facet) === query.phase))
      .sort((left, right) => compareIds(left.policy.id, right.policy.id))
    const acknowledgements = evaluation.acknowledgementStates.filter((entry) => entry.acknowledgement.zoneId === query.zoneId && policyStates.some((state) => state.policy.id === entry.acknowledgement.policyId))
    const revision = await retrievalDigest({ live: base.freshness.revision, intent: document.revision })
    const complete = base.coverage.complete
    const scopedRow = row ? { ...row, cells: new Map(cell ? [[zone.meta.name, cell]] : []), missingResolutions: new Map(row.missingResolutions?.has(zone.meta.name) ? [[zone.meta.name, row.missingResolutions.get(zone.meta.name)]] : []) } : null
    return {
      ...base, freshness: { ...base.freshness, source: "live-and-stored", revision, storedAt: document.updatedAt },
      ...await page(kind, query, revision, policyStates, async (state) => ({
        policy: await policySummary(state.policy, document), targeted: state.targetedZoneIds.includes(query.zoneId), effective: state.effectiveZoneIds.includes(query.zoneId),
        overriddenBy: (state.overriddenByZone.get(query.zoneId) || []).map((policy) => typeof policy === "string" ? policy : policy.id),
        status: !complete ? "unknown" : !row && state.effectiveZoneIds.includes(query.zoneId) ? "unresolved" : state.cells.get(query.zoneId)?.status || null, reason: state.reason || null,
        acknowledgements: await boundedValue(acknowledgements.filter((entry) => entry.acknowledgement.policyId === state.policy.id).map((entry) => complete ? entry : { ...entry, status: "unknown", reason: "Required live reads are incomplete" })),
      })),
      facet: facetIdentity(row || query), zoneId: query.zoneId, zoneName: zone.meta.name,
      observed: { status: !complete ? "unknown" : cell ? "present" : "absent", comparison: cell ? await boundedValue(facetCellComparisonValue(cell)) : null, inspection: cell ? await boundedValue(cell.inspectionValue) : null },
      capabilities: complete && scopedRow ? matrixRowCapabilities(scopedRow) : ["compare"],
      actions: complete && cell ? await boundedValue({ direct: cell.action, workspace: cell.parentAction, copy: cell.secondaryAction, alignment: cell.alignmentAction }) : null,
      intent: { revision: document.revision, status: !complete ? "unknown" : rowState?.unresolved || !row && policyStates.length > 0 ? "unresolved" : intentCell?.status || "ungoverned", reason: !complete ? "Required live reads are incomplete; absence and intent alignment cannot be determined" : !row && policyStates.length > 0 ? "The policy facet is not present in the loaded matrix" : rowState?.unresolved ? "One or more policies for this facet could not be resolved; inspect the policy reasons" : null, conflictKinds: intentCell?.conflictKinds || [], acknowledgementCount: acknowledgements.length },
    }
  }
  return async function retrieve(kind, input = {}, context = {}) {
    const query = parseRetrievalInput(kind, input)
    context.signal?.throwIfAborted()
    if (kind.startsWith("activity-") || kind.startsWith("policy-")) return stored(kind, query)
    if (kind.startsWith("facet-")) return facets(kind, query, context)
    return resources(kind, query, context)
  }
}

function resourceTransport(api, query) {
  const id = query.kind === "ruleset-rule" ? query.rulesetId : query.id
  if (!id) return api
  const surface = SURFACES.find((entry) => entry.id === RESOURCE_SURFACES[query.kind])
  const collectionPath = surface.path(query.zoneId)
  const detailPath = `${collectionPath.split("?")[0]}/${encodeURIComponent(id)}`
  let detailRead
  return {
    accountId: api.accountId,
    listZones: (options) => api.listZones(options),
    request: async (path, options) => {
      if (path !== collectionPath && path !== detailPath) return api.request(path, options)
      detailRead ||= api.request(detailPath, options)
      const response = await detailRead
      if (!response.result || (response.result.id || response.result.tag) !== id) throw new Error("Exact resource read returned a different or missing identifier")
      return path === collectionPath ? { ...response, result: [response.result], resultInfo: null } : response
    },
  }
}

function resourceItems(zone, query) {
  const result = zone.surfaces[RESOURCE_SURFACES[query.kind]]
  if (!result?.ok) return []
  if (!Array.isArray(result.result)) throw new Error(`Unexpected ${query.kind} collection`)
  const values = query.kind === "ruleset-rule"
    ? zone.ruleDetails.filter((detail) => detail.ok).flatMap((detail) => (detail.result.rules || []).map((raw) => ({ raw, parent: detail.result })))
    : result.result.map((raw) => ({ raw, parent: null }))
  return values.map(({ raw, parent }) => {
    const id = raw.id || raw.tag
    if (typeof id !== "string" || id.length === 0) throw new Error(`Provider omitted a ${query.kind} identifier`)
    let editable = false
    if (query.kind === "dns-record") editable = dnsRecordEditCapability(raw).editable === true
    if (query.kind === "email-rule") editable = emailRoutingRuleEditCapability(raw).editable === true
    if (query.kind === "zone-setting") editable = raw.editable === true
    if (["ruleset", "ruleset-rule"].includes(query.kind)) editable = EDITABLE_RULESET_KINDS.includes(parent?.kind || raw.kind)
    const detail = query.kind === "ruleset" ? zone.ruleDetails.find((entry) => entry.ok && entry.result.id === raw.id)?.result || raw : raw
    return { id, zoneId: zone.meta.id, kind: query.kind, name: raw.name || raw.description || id, type: raw.type || parent?.kind || raw.kind || null, phase: parent?.phase || raw.phase || null, rulesetId: parent?.id || null, capabilities: editable ? ["inspect", "plan-change"] : ["inspect"], raw: detail }
  })
}
