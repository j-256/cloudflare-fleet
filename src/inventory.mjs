import {
  ACCOUNT_SURFACES,
  DEFAULT_CONCURRENCY,
  INVENTORY_COVERAGE_KIND,
  SURFACES,
} from "./constants.mjs"
import {
  CloudflareApiError,
  serializeApiError,
} from "./api.mjs"
import { stableString } from "./normalize.mjs"

async function runPool(tasks, worker, concurrency, onProgress) {
  let cursor = 0
  let completed = 0
  let failure = null

  async function consume() {
    while (cursor < tasks.length && failure === null) {
      const index = cursor
      cursor += 1
      try {
        await worker(tasks[index], index)
      } catch (error) {
        failure ||= error
        throw error
      }
      completed += 1
      onProgress?.({ completed, total: tasks.length })
    }
  }

  const workerCount = Math.min(concurrency, tasks.length)
  const settled = await Promise.allSettled(
    Array.from({ length: workerCount }, consume),
  )
  const rejected = settled.find((entry) => entry.status === "rejected")
  if (rejected) throw rejected.reason
}

function errorMatchesEmptyResult(error, emptyErrorCodes = []) {
  if (!(error instanceof CloudflareApiError)) return false
  const expected = new Set(emptyErrorCodes.map(String))
  return error.errors.some((entry) => expected.has(String(entry?.code)))
}

async function readSurface(api, path, signal, options = {}) {
  try {
    const response = await api.request(path, { signal })
    return {
      ok: true,
      result: response.result,
      status: response.status,
    }
  } catch (error) {
    if (signal?.aborted) throw error
    if (error instanceof CloudflareApiError && error.status === 429) throw error
    if (errorMatchesEmptyResult(error, options.emptyErrorCodes)) {
      return {
        notApplicable: true,
        ok: true,
        result: [],
        status: error.status,
      }
    }
    return {
      ok: false,
      error: serializeApiError(error),
      result: null,
      status: error?.status ?? null,
    }
  }
}

function selectedAccountSurfaces(accountSurfaceIds, surfaceIds) {
  if (accountSurfaceIds === undefined) {
    return surfaceIds === undefined ? ACCOUNT_SURFACES : []
  }
  const requested = new Set(accountSurfaceIds)
  const surfaces = ACCOUNT_SURFACES.filter((surface) => requested.has(surface.id))
  if (surfaces.length !== requested.size) {
    const known = new Set(ACCOUNT_SURFACES.map((surface) => surface.id))
    const unknown = [...requested].filter((surfaceId) => !known.has(surfaceId))
    throw new TypeError(`Unknown account inventory surface: ${unknown.join(", ")}`)
  }
  return surfaces
}

async function readAccountSurfaces(api, surfaces, signal, onProgress) {
  const results = {}
  let completed = 0
  await Promise.all(surfaces.map(async (surface) => {
    results[surface.id] = await readSurface(
      api,
      surface.path(api.accountId),
      signal,
      surface,
    )
    completed += 1
    onProgress?.({
      completed,
      stage: "account-surfaces",
      message: `Reading account surfaces ${completed}/${surfaces.length}`,
      total: surfaces.length,
    })
  }))
  return results
}

async function readEmailAddresses(api, signal) {
  try {
    return {
      ok: true,
      result: await api.listEmailAddresses({ signal }),
    }
  } catch (error) {
    if (signal?.aborted) throw error
    if (error instanceof CloudflareApiError && error.status === 429) throw error
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
  const accountSurfaces = selectedAccountSurfaces(
    options.accountSurfaceIds,
    options.surfaceIds,
  )
  const includeEmailAddresses = options.includeEmailAddresses !== false
  const includeRuleDetails = options.includeRuleDetails
    ?? surfaces.some((surface) => surface.id === "rulesets")
  const signal = options.signal
  const [availableZones, emailAddresses, accountSurfaceResults] = await Promise.all([
    api.listZones({ signal }),
    includeEmailAddresses
      ? readEmailAddresses(api, signal)
      : Promise.resolve({
          ok: false,
          result: [],
          skipped: true,
        }),
    readAccountSurfaces(
      api,
      accountSurfaces,
      signal,
      options.onProgress,
    ),
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
      zone.surfaces[surface.id] = await readSurface(
        api,
        surface.path(zone.meta.id),
        signal,
        surface,
      )
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
        rulesetId: ruleset.id,
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
      surfaces: accountSurfaceResults,
    },
    loadedAt: new Date().toISOString(),
    zones: records,
  }
}

export function coverageFor(inventory) {
  const zoneCoverage = SURFACES.map((surface) => {
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
  const accountCoverage = ACCOUNT_SURFACES.map((surface) => {
    const response = inventory.account?.surfaces?.[surface.id]
    const failed = response?.ok
      ? []
      : [{
          detail: coverageErrorDetail(response?.error || { message: "No response" }),
          error: response?.error || { message: "No response" },
          kind: INVENTORY_COVERAGE_KIND.LIMITATION,
          observedCanonical: coverageIssueCanonical(
            response?.error || { message: "No response" },
          ),
          subjectId: surface.id,
          subjectLabel: surface.label,
          zoneId: null,
          zoneName: null,
        }]
    return {
      detail: failed.length === 0
        ? "Read successfully for the account"
        : "The account request failed",
      failed,
      id: surface.id,
      label: surface.label,
      ok: failed.length === 0,
    }
  })
  return [...zoneCoverage, ...accountCoverage]
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
