import {
  DEFAULT_CONCURRENCY,
  INVENTORY_COVERAGE_KIND,
  SURFACES,
} from "./constants.mjs"
import { serializeApiError } from "./api.mjs"
import { stableString } from "./normalize.mjs"

async function runPool(tasks, worker, concurrency, onProgress) {
  let cursor = 0
  let completed = 0

  async function consume() {
    while (cursor < tasks.length) {
      const index = cursor
      cursor += 1
      await worker(tasks[index], index)
      completed += 1
      onProgress?.({ completed, total: tasks.length })
    }
  }

  const workerCount = Math.min(concurrency, tasks.length)
  await Promise.all(Array.from({ length: workerCount }, consume))
}

async function readSurface(api, path, signal) {
  try {
    const response = await api.request(path, { signal })
    return {
      ok: true,
      result: response.result,
      status: response.status,
    }
  } catch (error) {
    if (signal?.aborted) throw error
    return {
      ok: false,
      error: serializeApiError(error),
      result: null,
      status: error?.status ?? null,
    }
  }
}

async function readEmailAddresses(api, signal) {
  try {
    return {
      ok: true,
      result: await api.listEmailAddresses({ signal }),
    }
  } catch (error) {
    if (signal?.aborted) throw error
    return {
      ok: false,
      error: serializeApiError(error),
      result: [],
    }
  }
}

function selectedSurfaces(surfaceIds) {
  if (surfaceIds === undefined) return SURFACES
  const requested = new Set(surfaceIds)
  const surfaces = SURFACES.filter((surface) => requested.has(surface.id))
  if (surfaces.length !== requested.size) {
    const known = new Set(SURFACES.map((surface) => surface.id))
    const unknown = [...requested].filter((surfaceId) => !known.has(surfaceId))
    throw new TypeError(`Unknown inventory surface: ${unknown.join(", ")}`)
  }
  return surfaces
}

function selectedZones(zones, zoneIds) {
  if (zoneIds === undefined) return zones
  const requested = new Set(zoneIds)
  const selected = zones.filter((zone) => requested.has(zone.id))
  if (selected.length !== requested.size) {
    const found = new Set(selected.map((zone) => zone.id))
    const missing = [...requested].filter((zoneId) => !found.has(zoneId))
    throw new Error(`Unknown zone identifier: ${missing.join(", ")}`)
  }
  return selected
}

export async function loadInventory(api, options = {}) {
  const concurrency = options.concurrency || DEFAULT_CONCURRENCY
  const surfaces = selectedSurfaces(options.surfaceIds)
  const includeEmailAddresses = options.includeEmailAddresses !== false
  const includeRuleDetails = options.includeRuleDetails
    ?? surfaces.some((surface) => surface.id === "rulesets")
  const signal = options.signal
  const [availableZones, emailAddresses] = await Promise.all([
    api.listZones({ signal }),
    includeEmailAddresses
      ? readEmailAddresses(api, signal)
      : Promise.resolve({
          ok: false,
          result: [],
          skipped: true,
        }),
  ])
  const zones = selectedZones(availableZones, options.zoneIds)
  const records = zones
    .slice()
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((zone) => ({
      meta: zone,
      ruleDetails: [],
      surfaces: {},
    }))

  const surfaceTasks = records.flatMap((zone) => surfaces.map((surface) => ({ zone, surface })))

  await runPool(
    surfaceTasks,
    async ({ zone, surface }) => {
      zone.surfaces[surface.id] = await readSurface(api, surface.path(zone.meta.id), signal)
    },
    concurrency,
    (progress) => options.onProgress?.({
      ...progress,
      stage: "surfaces",
      message: `Reading zone surfaces ${progress.completed}/${progress.total}`,
    }),
  )

  const rulesetTasks = includeRuleDetails
    ? records.flatMap((zone) => {
        const rulesets = zone.surfaces.rulesets?.ok ? zone.surfaces.rulesets.result : []
        const phases = options.ruleDetailPhases ? new Set(options.ruleDetailPhases) : null
        const kinds = options.ruleDetailKinds ? new Set(options.ruleDetailKinds) : null
        return rulesets
          .filter((ruleset) => ruleset.kind === "zone" || ruleset.kind === "custom")
          .filter((ruleset) => phases === null || phases.has(ruleset.phase))
          .filter((ruleset) => kinds === null || kinds.has(ruleset.kind))
          .map((ruleset) => ({ zone, ruleset }))
      })
    : []

  await runPool(
    rulesetTasks,
    async ({ zone, ruleset }) => {
      const result = await readSurface(api, `zones/${zone.meta.id}/rulesets/${ruleset.id}`, signal)
      zone.ruleDetails.push({
        phase: ruleset.phase,
        ...result,
      })
    },
    concurrency,
    (progress) => options.onProgress?.({
      ...progress,
      stage: "rulesets",
      message: `Reading zone rules ${progress.completed}/${progress.total}`,
    }),
  )

  return {
    account: {
      emailAddresses,
      id: api.accountId,
    },
    loadedAt: new Date().toISOString(),
    zones: records,
  }
}

export function coverageFor(inventory) {
  return SURFACES.map((surface) => {
    const failed = inventory.zones.filter((zone) => !zone.surfaces[surface.id]?.ok)
    return {
      id: surface.id,
      label: surface.label,
      ok: failed.length === 0,
      failed: failed.map((zone) => {
        const error = zone.surfaces[surface.id]?.error || { message: "No response" }
        return {
          detail: coverageErrorDetail(error),
          error,
          kind: INVENTORY_COVERAGE_KIND.SURFACE,
          observedCanonical: coverageIssueCanonical(error),
          subjectId: surface.id,
          subjectLabel: surface.label,
          zoneId: zone.meta.id,
          zoneName: zone.meta.name,
        }
      }),
      detail: failed.length === 0
        ? `Read successfully for all ${inventory.zones.length} zones`
        : `${failed.length} zone request${failed.length === 1 ? "" : "s"} failed`,
    }
  })
}

export function coverageErrorDetail(error) {
  const firstApiError = error?.errors?.find(
    (entry) => typeof entry?.message === "string" && entry.message.trim(),
  )
  return firstApiError?.message || error?.message || "No response"
}

export function coverageIssueCanonical(error) {
  const codes = [...new Set((error?.errors || [])
    .map((entry) => entry?.code)
    .filter((code) => typeof code === "number" || typeof code === "string"))]
    .sort((left, right) => String(left).localeCompare(String(right)))
  return stableString({
    codes,
    message: codes.length === 0 ? coverageErrorDetail(error) : null,
    status: error?.status ?? null,
  })
}

export function staticCoverageIssues(limitations) {
  return limitations.map((limitation) => ({
    detail: limitation.detail,
    kind: INVENTORY_COVERAGE_KIND.LIMITATION,
    observedCanonical: stableString({ detail: limitation.detail }),
    subjectId: limitation.id,
    subjectLabel: limitation.label,
    zoneId: null,
    zoneName: null,
  }))
}
