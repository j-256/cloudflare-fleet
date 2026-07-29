import {
  displayJson,
  groupBy,
  normalizeText,
  normalizeValue,
  relativeName,
  shortDisplay,
  stableString,
} from "./normalize.mjs"
import {
  FLEET_ACTION_KIND,
  HOLE_RESOLUTION_KIND,
} from "./constants.mjs"
import {
  dnsRecordCopyCapability,
  dnsRecordEditCapability,
  ruleCopyCapability,
} from "./policies.mjs"

const EDITABLE_RULESET_KINDS = new Set([
  "custom",
  "zone",
])
const CATEGORY_ORDER = [
  "Email",
  "Email routes",
  "Email DNS specification",
  "Ruleset rules",
  "Rulesets",
  "Zone settings",
  "DNSSEC",
  "DNS records",
  "Workers routes",
  "Legacy firewall view",
  "Security",
  "TLS",
  "Performance",
  "IP access rules",
  "Health checks",
  "Load balancers",
  "Logpush jobs",
  "Waiting rooms",
  "Web3 hostnames",
  "Snippets",
  "TLS inventory",
  "Zone",
]

function surfaceResult(zone, surfaceId) {
  const surface = zone.surfaces[surfaceId]
  return surface?.ok ? surface.result : undefined
}

function rowId(category, key) {
  return `${category}\u0000${key}`
}

function addCell(rows, category, key, label, zone, value, options = {}) {
  const id = rowId(category, key)
  if (!rows.has(id)) {
    rows.set(id, {
      category,
      descriptions: new Set(),
      key,
      label,
      cells: new Map(),
      duplicateZoneNames: new Set(),
      resolutionKind: options.resolutionKind || null,
    })
  }
  const row = rows.get(id)
  if (options.description) row.descriptions.add(options.description)
  if (options.resolutionKind) {
    if (row.resolutionKind && row.resolutionKind !== options.resolutionKind) {
      throw new Error(`Conflicting resolution kinds for ${category}: ${label}`)
    }
    row.resolutionKind = options.resolutionKind
  }
  if (value === undefined) return

  if (row.cells.has(zone.meta.name)) row.duplicateZoneNames.add(zone.meta.name)
  const normalized = options.normalized ?? normalizeValue(value, zone.meta.name, options)
  row.cells.set(zone.meta.name, {
    action: options.action || null,
    canonical: stableString(normalized),
    capability: options.capability || null,
    display: options.display ?? shortDisplay(normalized),
    full: options.full ?? displayJson(normalized),
    resolutionSource: options.resolutionSource || null,
    secondaryAction: options.secondaryAction || null,
  })
}

function addScalar(rows, inventory, category, key, label, getter, options = {}) {
  for (const zone of inventory.zones) {
    const value = getter(zone)
    if (value !== undefined) addCell(rows, category, key, label, zone, value, options)
  }
}

function addZoneRows(rows, inventory) {
  addScalar(rows, inventory, "Zone", "status", "Status", (zone) => zone.meta.status)
  addScalar(rows, inventory, "Zone", "paused", "Paused", (zone) => zone.meta.paused)
  addScalar(rows, inventory, "Zone", "type", "Zone type", (zone) => zone.meta.type)
  addScalar(rows, inventory, "Zone", "plan", "Plan", (zone) => zone.meta.plan?.name)
  addScalar(rows, inventory, "Zone", "development_mode", "Development mode", (zone) => zone.meta.development_mode)
  addScalar(rows, inventory, "Zone", "setup_step", "Setup step", (zone) => zone.meta.meta?.step)
  addScalar(rows, inventory, "Zone", "phishing_detected", "Phishing detected", (zone) => zone.meta.meta?.phishing_detected)
  addScalar(rows, inventory, "Zone", "page_rule_quota", "Page rule quota", (zone) => zone.meta.meta?.page_rule_quota)
}

function addSettingRows(rows, inventory) {
  const settingNames = new Set()
  for (const zone of inventory.zones) {
    for (const setting of surfaceResult(zone, "settings") || []) settingNames.add(setting.id)
  }

  for (const settingName of [...settingNames].sort()) {
    for (const zone of inventory.zones) {
      const setting = (surfaceResult(zone, "settings") || []).find((entry) => entry.id === settingName)
      if (!setting) continue
      addCell(
        rows,
        "Zone settings",
        settingName,
        settingName,
        zone,
        {
          editable: setting.editable,
          value: setting.value,
        },
        {
          action: setting.editable
            ? {
                settingId: settingName,
                type: "zone-setting",
                value: setting.value,
                zoneId: zone.meta.id,
              }
            : null,
          capability: setting.editable
            ? {
                kind: "direct-edit",
                label: "Direct setting edit",
                reason: "Cloudflare reports editable=true for this zone setting",
              }
            : {
                kind: "not-directly-editable",
                label: "No direct setting edit",
                reason: "Cloudflare reports editable=false for this zone setting; another product API may still configure equivalent behavior",
              },
          display: shortDisplay(setting.value),
          full: displayJson({
            directly_editable: setting.editable,
            source: "Zone Settings API",
            value: normalizeValue(setting.value, zone.meta.name),
          }),
        },
      )
    }
  }
}

function addDnssecRows(rows, inventory) {
  addScalar(
    rows,
    inventory,
    "DNSSEC",
    "configuration",
    "DNSSEC configuration",
    (zone) => {
      const dnssec = surfaceResult(zone, "dnssec")
      if (!dnssec) return undefined
      return normalizeValue(dnssec, zone.meta.name, {
        omit: ["digest", "dnskey", "ds", "key_tag", "public_key"],
      })
    },
  )
}

function addEmailRows(rows, inventory) {
  for (const zone of inventory.zones) {
    const settings = surfaceResult(zone, "email")
    if (settings) {
      for (const key of ["enabled", "status", "skip_wizard", "support_subaddress"]) {
        addCell(rows, "Email", `settings:${key}`, key, zone, settings[key], {
          resolutionKind: HOLE_RESOLUTION_KIND.EMAIL_POLICY,
        })
      }
    }

    const catchAll = surfaceResult(zone, "email-catch-all")
    if (catchAll) {
      addCell(
        rows,
        "Email",
        "catch-all",
        "Catch-all rule",
        zone,
        normalizeValue(catchAll, zone.meta.name, { omit: ["priority"] }),
        {
          resolutionKind: HOLE_RESOLUTION_KIND.EMAIL_POLICY,
        },
      )
    }

    for (const rule of surfaceResult(zone, "email-rules") || []) {
      if (rule.matchers?.some((matcher) => matcher.type === "all")) continue
      const matcher = rule.matchers
        ?.map((entry) => normalizeValue(entry, zone.meta.name))
        .map(stableString)
        .join(" + ") || "unnamed"
      addCell(
        rows,
        "Email routes",
        `routing:${matcher}`,
        rule.name || matcher,
        zone,
        normalizeValue(rule, zone.meta.name, { omit: ["priority"] }),
      )
    }

    const requiredRecords = surfaceResult(zone, "email-dns")
    if (Array.isArray(requiredRecords)) {
      const grouped = groupBy(requiredRecords, (record) => `${record.type} ${relativeName(record.name, zone.meta.name)}`)
      for (const [key, records] of grouped) {
        addCell(
          rows,
          "Email DNS specification",
          key,
          key,
          zone,
          records.map((record) => normalizeValue({
            content: record.content,
            priority: record.priority,
            ttl: record.ttl,
          }, zone.meta.name)),
          {
            resolutionKind: HOLE_RESOLUTION_KIND.EMAIL_POLICY,
          },
        )
      }
    }
  }
}

function addDnsRows(rows, inventory) {
  const dnsKeys = new Set()
  for (const zone of inventory.zones) {
    for (const record of surfaceResult(zone, "dns") || []) {
      dnsKeys.add(`${record.type} ${relativeName(record.name, zone.meta.name)}`)
    }
  }

  for (const key of [...dnsKeys].sort()) {
    for (const zone of inventory.zones) {
      const records = (surfaceResult(zone, "dns") || []).filter(
        (record) => `${record.type} ${relativeName(record.name, zone.meta.name)}` === key,
      )
      if (records.length === 0) continue
      const capabilities = new Map(
        records.map((record) => [record, dnsRecordEditCapability(record)]),
      )
      const copyCapabilities = new Map(
        records.map((record) => [record, dnsRecordCopyCapability(record)]),
      )
      const editableRecords = records.filter(
        (record) => capabilities.get(record).editable,
      )
      const copyable = records.every(
        (record) => copyCapabilities.get(record).copyable,
      )
      const blockedReasons = records
        .filter((record) => !capabilities.get(record).editable)
        .map((record) => capabilities.get(record).reason)
      addCell(
        rows,
        "DNS records",
        key,
        key,
        zone,
        records.map((record) => normalizeValue({
          comment: record.comment,
          content: record.content,
          data: record.data,
          priority: record.priority,
          proxied: record.proxied,
          settings: record.settings,
          tags: record.tags,
          ttl: record.ttl,
        }, zone.meta.name)),
        {
          action: editableRecords.length > 0
            ? {
                recordIds: editableRecords.map((record) => record.id),
                type: "dns-records",
                zoneId: zone.meta.id,
              }
            : null,
          capability: editableRecords.length > 0
            ? {
                kind: "direct-edit",
                label: "Direct DNS edit",
                reason: blockedReasons.length === 0
                  ? "Every record in this cell has a type-aware DNS Records API adapter"
                  : `${editableRecords.length} record${editableRecords.length === 1 ? "" : "s"} can be edited; ${blockedReasons.join("; ")}`,
              }
            : {
                kind: "not-directly-editable",
                label: "No direct DNS edit",
                reason: [...new Set(blockedReasons)].join("; "),
              },
          resolutionKind: HOLE_RESOLUTION_KIND.DNS_RECORDS,
          resolutionSource: copyable
            ? {
                recordIds: records.map((record) => record.id),
                sourceZoneId: zone.meta.id,
                type: HOLE_RESOLUTION_KIND.DNS_RECORDS,
              }
            : null,
        },
      )
    }
  }
}

function addRulesetRows(rows, inventory) {
  for (const zone of inventory.zones) {
    const managed = (surfaceResult(zone, "rulesets") || [])
      .filter((ruleset) => ruleset.kind === "managed")
      .map((ruleset) => ({
        name: ruleset.name,
        phase: ruleset.phase,
        version: ruleset.version,
      }))
    addCell(rows, "Rulesets", "managed", "Managed rulesets", zone, managed)

    for (const detail of zone.ruleDetails.filter((entry) => entry.ok)) {
      const ruleset = detail.result
      const phase = ruleset.phase
      addCell(
        rows,
        "Rulesets",
        `phase:${phase}`,
        `${phase} entrypoint`,
        zone,
        {
          kind: ruleset.kind,
          name: ruleset.name,
          rule_count: ruleset.rules?.length || 0,
        },
      )

      for (const [index, rule] of (ruleset.rules || []).entries()) {
        const normalizedRule = normalizeValue(rule, zone.meta.name, {
          omit: ["last_updated", "ref", "version"],
          preserveOrder: true,
        })
        const capability = ruleCopyCapability(ruleset, rule)
        const stableRef = rule.ref && rule.ref !== rule.id ? rule.ref : ""
        const identity = normalizeText(
          rule.description || stableRef || `${rule.action || "rule"} rule ${index + 1} | ${(rule.expression || "").slice(0, 80)}`,
          zone.meta.name,
        )
        addCell(
          rows,
          "Ruleset rules",
          `${phase}:${identity}`,
          identity,
          zone,
          normalizedRule,
          {
            action: EDITABLE_RULESET_KINDS.has(ruleset.kind)
              ? {
                  phase,
                  ruleId: rule.id,
                  rulesetId: ruleset.id,
                  type: "ruleset-rule",
                  zoneId: zone.meta.id,
                }
              : null,
            capability: {
              kind: capability.copyable ? "copy-to-zones" : "not-copyable",
              label: capability.copyable ? "Copy to selected zones" : "Copy unavailable",
              reason: capability.reason,
            },
            description: `${rule.action || "unknown"} | ${phase}`,
            display: rule.enabled === false ? "Disabled" : "Enabled",
            full: displayJson({
              copy_capability: capability.copyable ? "copy to selected zones" : capability.reason,
              rule: normalizedRule,
            }),
            secondaryAction: capability.copyable
              ? {
                  phase,
                  ruleId: rule.id,
                  rulesetId: ruleset.id,
                  sourceZoneId: zone.meta.id,
                  type: "ruleset-rule-copy",
                }
              : null,
            resolutionKind: HOLE_RESOLUTION_KIND.RULESET_RULE,
            resolutionSource: capability.copyable
              ? {
                  phase,
                  ruleId: rule.id,
                  rulesetId: ruleset.id,
                  sourceZoneId: zone.meta.id,
                  type: HOLE_RESOLUTION_KIND.RULESET_RULE,
                }
              : null,
          },
        )
      }
    }
  }
}

function addRouteAndLegacyRows(rows, inventory) {
  for (const zone of inventory.zones) {
    for (const route of surfaceResult(zone, "workers-routes") || []) {
      const pattern = normalizeText(route.pattern, zone.meta.name)
      addCell(rows, "Workers routes", pattern, pattern, zone, normalizeValue(route, zone.meta.name), {
        display: route.script || route.script_name || "No script",
      })
    }

    for (const rule of surfaceResult(zone, "firewall-rules") || []) {
      const identity = normalizeText(rule.description || rule.ref || rule.id || "unnamed", zone.meta.name)
      addCell(
        rows,
        "Legacy firewall view",
        identity,
        identity,
        zone,
        normalizeValue({
          action: rule.action,
          description: rule.description,
          filter: rule.filter?.expression,
          paused: rule.paused,
          priority: rule.priority,
        }, zone.meta.name),
        {
          display: `${rule.paused ? "Paused" : "Enabled"} | ${rule.action}`,
        },
      )
    }
  }
}

function addAdditionalRows(rows, inventory) {
  const collections = [
    ["IP access rules", "access-rules", (item) => item.notes || `${item.configuration?.target || "rule"}:${item.configuration?.value || item.id}`],
    ["Health checks", "healthchecks", (item) => item.name || item.address || item.id],
    ["Load balancers", "load-balancers", (item) => item.name || item.hostname || item.id],
    ["Logpush jobs", "logpush", (item) => item.name || item.destination_conf || item.id],
    ["Waiting rooms", "waiting-rooms", (item) => item.name || item.host || item.id],
    ["Web3 hostnames", "web3", (item) => item.name || item.hostname || item.id],
  ]
  for (const [category, surfaceId, identityFor] of collections) {
    for (const zone of inventory.zones) {
      for (const [index, item] of (surfaceResult(zone, surfaceId) || []).entries()) {
        const identity = normalizeText(String(identityFor(item) || `${surfaceId}-${index + 1}`), zone.meta.name)
        addCell(rows, category, identity, identity, zone, normalizeValue(item, zone.meta.name))
      }
    }
  }

  const scalars = [
    ["Performance", "argo-tiered", "Tiered caching"],
    ["Performance", "smart-tiered", "Smart tiered caching"],
    ["Security", "bot-management", "Bot management"],
    ["TLS", "universal-ssl", "Universal SSL"],
    ["TLS", "origin-pq", "Origin post-quantum encryption"],
    ["Snippets", "snippets", "Snippets"],
  ]
  for (const [category, surfaceId, label] of scalars) {
    for (const zone of inventory.zones) {
      const value = surfaceResult(zone, surfaceId)
      if (value === undefined) continue
      addCell(rows, category, surfaceId, label, zone, normalizeValue(value, zone.meta.name))
    }
  }

  for (const zone of inventory.zones) {
    const packs = (surfaceResult(zone, "certificate-packs") || []).map((pack) => normalizeValue({
      certificate_authority: pack.certificate_authority,
      hosts: pack.hosts,
      status: pack.status,
      type: pack.type,
      validation_method: pack.validation_method,
      validity_days: pack.validity_days,
    }, zone.meta.name))
    addCell(rows, "TLS inventory", "certificate-packs", "Certificate packs", zone, packs)
  }
}

function resolutionCandidates(row, inventory) {
  const grouped = new Map()
  for (const zone of inventory.zones) {
    const cell = row.cells.get(zone.meta.name)
    if (!cell) continue
    if (!grouped.has(cell.canonical)) {
      grouped.set(cell.canonical, {
        canonical: cell.canonical,
        count: 0,
        display: cell.display,
        full: cell.full,
        sources: [],
      })
    }
    const variant = grouped.get(cell.canonical)
    variant.count += 1
    if (cell.resolutionSource) {
      variant.sources.push({
        action: cell.resolutionSource,
        zoneId: zone.meta.id,
        zoneName: zone.meta.name,
      })
    }
  }

  return [...grouped.values()]
    .filter((variant) => variant.sources.length > 0)
    .map((variant) => ({
      canonical: variant.canonical,
      count: variant.count,
      display: variant.display,
      full: variant.full,
      sourceAction: variant.sources[0].action,
      sourceZoneId: variant.sources[0].zoneId,
      sourceZoneName: variant.sources[0].zoneName,
    }))
    .sort(
      (left, right) => right.count - left.count
        || left.sourceZoneName.localeCompare(right.sourceZoneName),
    )
    .map((candidate, index) => ({
      ...candidate,
      id: `variant-${index + 1}`,
    }))
}

function emailResolutionCoverage(zone, inventory) {
  const required = [
    "dns",
    "email",
    "email-dns",
    "email-catch-all",
  ]
  if (!inventory.account.emailAddresses?.ok) {
    return "Verified account email addresses were not readable"
  }
  const failed = required.find((surfaceId) => !zone.surfaces[surfaceId]?.ok)
  return failed ? `${failed} was not readable for this zone` : ""
}

function rulesetResolutionCoverage(zone, candidates) {
  if (!zone.surfaces.rulesets?.ok) return "Rulesets were not readable for this zone"
  const phases = new Set(candidates.map((candidate) => candidate.sourceAction.phase))
  for (const phase of phases) {
    const summaries = (zone.surfaces.rulesets.result || []).filter(
      (ruleset) => ruleset.phase === phase
        && (ruleset.kind === "zone" || ruleset.kind === "custom"),
    )
    if (summaries.length === 0) continue
    const details = zone.ruleDetails.filter((detail) => detail.phase === phase)
    if (details.length < summaries.length || details.some((detail) => !detail.ok)) {
      return `${phase} rule details were not readable for this zone`
    }
  }
  return ""
}

function missingResolution(row, zone, inventory, candidates) {
  if (!row.resolutionKind) {
    return {
      available: false,
      reason: "No fill adapter is registered for this surface",
    }
  }
  if (row.resolutionKind === HOLE_RESOLUTION_KIND.EMAIL_POLICY) {
    const reason = emailResolutionCoverage(zone, inventory)
    return reason
      ? { available: false, reason }
      : {
          available: true,
          candidates: [],
          kind: row.resolutionKind,
          recommendedCandidateId: null,
          targetZoneId: zone.meta.id,
          targetZoneName: zone.meta.name,
        }
  }

  const surfaceId = row.resolutionKind === HOLE_RESOLUTION_KIND.DNS_RECORDS
    ? "dns"
    : "rulesets"
  if (!zone.surfaces[surfaceId]?.ok) {
    return {
      available: false,
      reason: `${surfaceId} was not readable for this zone`,
    }
  }
  if (candidates.length === 0) {
    return {
      available: false,
      reason: "No existing fleet variant is portable through this surface's write adapter",
    }
  }
  if (row.resolutionKind === HOLE_RESOLUTION_KIND.RULESET_RULE) {
    const reason = rulesetResolutionCoverage(zone, candidates)
    if (reason) return { available: false, reason }
  }
  const recommended = candidates.length === 1
    || candidates[0].count > candidates[1].count
    ? candidates[0]
    : null
  return {
    available: true,
    candidates,
    kind: row.resolutionKind,
    recommendedCandidateId: recommended?.id || null,
    targetZoneId: zone.meta.id,
    targetZoneName: zone.meta.name,
  }
}

function fleetRuleRenameCapability(row, inventory, duplicateZoneNames) {
  if (row.category !== "Ruleset rules" || row.cells.size === 0) {
    return {
      action: null,
      reason: "",
    }
  }
  if (duplicateZoneNames.size > 0) {
    return {
      action: null,
      reason: `Duplicate rule identities on ${[...duplicateZoneNames].sort().join(", ")} require individual review`,
    }
  }
  const rules = []
  for (const zone of inventory.zones) {
    const cell = row.cells.get(zone.meta.name)
    if (!cell) continue
    if (cell.action?.type !== "ruleset-rule") {
      return {
        action: null,
        reason: `At least one present instance of ${row.label} is not directly editable`,
      }
    }
    rules.push({
      phase: cell.action.phase,
      ruleId: cell.action.ruleId,
      rulesetId: cell.action.rulesetId,
      zoneId: cell.action.zoneId,
    })
  }
  return {
    action: {
      currentName: row.label,
      missingZoneCount: inventory.zones.length - rules.length,
      rules,
      type: FLEET_ACTION_KIND.RULE_RENAME,
    },
    reason: "",
  }
}

export function buildMatrix(inventory) {
  const rows = new Map()

  addZoneRows(rows, inventory)
  addSettingRows(rows, inventory)
  addDnssecRows(rows, inventory)
  addEmailRows(rows, inventory)
  addDnsRows(rows, inventory)
  addRulesetRows(rows, inventory)
  addRouteAndLegacyRows(rows, inventory)
  addAdditionalRows(rows, inventory)

  const rendered = [...rows.values()].map((row) => {
    const {
      descriptions,
      duplicateZoneNames,
      ...rowDefinition
    } = row
    const description = [...descriptions].sort().join(" / ")
    const canonicalValues = inventory.zones.map((zone) => row.cells.get(zone.meta.name)?.canonical ?? "__missing__")
    const variants = [...new Set(canonicalValues)]
    const nonMissing = [...new Set(canonicalValues.filter((value) => value !== "__missing__"))]
    const candidates = resolutionCandidates(rowDefinition, inventory)
    const fleetRename = fleetRuleRenameCapability(
      rowDefinition,
      inventory,
      duplicateZoneNames,
    )
    const missingResolutions = new Map()
    for (const zone of inventory.zones) {
      if (row.cells.has(zone.meta.name)) continue
      missingResolutions.set(
        zone.meta.name,
        missingResolution(rowDefinition, zone, inventory, candidates),
      )
    }
    return {
      ...rowDefinition,
      description,
      different: variants.length > 1,
      fleetAction: fleetRename.action,
      fleetActionReason: fleetRename.reason,
      missingResolutions,
      missingCount: canonicalValues.filter((value) => value === "__missing__").length,
      search: [
        row.category,
        row.label,
        description,
        ...[...row.cells.values()].map((cell) => cell.full),
      ].join(" ").toLowerCase(),
      variantIndexes: new Map(nonMissing.map((value, index) => [value, index % 6])),
    }
  })

  rendered.sort((left, right) => {
    const leftCategory = CATEGORY_ORDER.indexOf(left.category)
    const rightCategory = CATEGORY_ORDER.indexOf(right.category)
    const leftOrder = leftCategory === -1 ? CATEGORY_ORDER.length : leftCategory
    const rightOrder = rightCategory === -1 ? CATEGORY_ORDER.length : rightCategory
    return leftOrder - rightOrder || left.label.localeCompare(right.label)
  })

  return {
    categories: [...new Set(rendered.map((row) => row.category))],
    rows: rendered,
    summary: {
      differences: rendered.filter((row) => row.different).length,
      facets: rendered.length,
      missingCells: rendered.reduce((sum, row) => sum + row.missingCount, 0),
      zones: inventory.zones.length,
    },
  }
}

export function matrixRenderKey(inventory, matrix) {
  return stableString({
    rows: matrix.rows.map((row) => ({
      category: row.category,
      cells: inventory.zones.map((zone) => {
        const cell = row.cells.get(zone.meta.name)
        if (!cell) return null
        return {
          action: cell.action,
          canonical: cell.canonical,
          capability: cell.capability,
          display: cell.display,
          full: cell.full,
          resolutionSource: cell.resolutionSource,
          secondaryAction: cell.secondaryAction,
        }
      }),
      description: row.description,
      different: row.different,
      fleetAction: row.fleetAction,
      fleetActionReason: row.fleetActionReason,
      key: row.key,
      label: row.label,
      missingCount: row.missingCount,
      missingResolutions: inventory.zones.map(
        (zone) => row.missingResolutions.get(zone.meta.name) || null,
      ),
    })),
    zones: inventory.zones.map((zone) => ({
      createdOn: zone.meta.created_on,
      id: zone.meta.id,
      name: zone.meta.name,
    })),
  })
}
