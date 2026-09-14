import { CloudflareApiError, resolveCloudflareApiUrl } from "./api.mjs"
import { stableString } from "./normalize.mjs"
import { INVENTORY_READ_REASON } from "./constants.mjs"

export const INVENTORY_PAGE_LIMIT = 100
export const INVENTORY_ITEM_LIMIT = 100000

export async function readInventoryPages(api, path, signal) {
  let response = await api.request(path, { signal })
  if (!Array.isArray(response.result)) return response
  const result = [...response.result]
  const seen = new Set()
  const url = resolveCloudflareApiUrl(path)
  let pages = 1
  let expectedPages = 1
  let expectedItems = 0
  let knownEnd = false
  while (true) {
    const info = response.resultInfo
    const page = Number(info?.page || url.searchParams.get("page") || pages)
    expectedPages = Math.max(expectedPages, Number(info?.total_pages) || 1)
    expectedItems = Math.max(expectedItems, Number(info?.total_count) || 0)
    knownEnd ||= info?.total_pages !== undefined || info?.total_count !== undefined || info?.cursors !== undefined || info && Object.hasOwn(info, "cursor")
    const cursor = info?.cursors?.after || info?.cursor
    const perPage = Number(info?.per_page || url.searchParams.get("per_page"))
    const possiblyMore = !knownEnd && perPage > 0 && response.result.length >= perPage
    if (result.length > INVENTORY_ITEM_LIMIT) throw paginationError("Inventory collection exceeded its bounded item limit", INVENTORY_READ_REASON.ITEM_LIMIT, url, response)
    const more = cursor || expectedPages > page || expectedItems > result.length || possiblyMore
    if (!more) break
    const signature = stableString(response.result)
    if (pages >= INVENTORY_PAGE_LIMIT || result.length >= INVENTORY_ITEM_LIMIT || seen.has(signature) || response.result.length === 0) {
      const reason = pages >= INVENTORY_PAGE_LIMIT ? INVENTORY_READ_REASON.PAGE_LIMIT : result.length >= INVENTORY_ITEM_LIMIT ? INVENTORY_READ_REASON.ITEM_LIMIT : INVENTORY_READ_REASON.STALLED
      throw paginationError("Inventory pagination did not complete within its bounded read; retry or narrow the requested scope", reason, url, response)
    }
    seen.add(signature)
    if (cursor) url.searchParams.set("cursor", String(cursor))
    else {
      url.searchParams.set("page", String(page + 1))
      if (info?.per_page) url.searchParams.set("per_page", String(info.per_page))
    }
    try {
      response = await api.request(`${url.pathname.slice("/client/v4/".length)}${url.search}`, { signal })
    } catch (error) {
      throw new CloudflareApiError("A later inventory page failed; collection coverage is incomplete", {
        path: url.pathname, status: error.status, aborted: error.aborted, abortKind: error.abortKind, elapsedMs: error.elapsedMs,
        errors: [{ code: INVENTORY_READ_REASON.PAGE_FAILED }],
      })
    }
    if (!Array.isArray(response.result)) throw paginationError("Inventory pagination returned an invalid collection", INVENTORY_READ_REASON.INVALID_PAGE, url, response)
    result.push(...response.result)
    pages += 1
  }
  return { ...response, result }
}

function paginationError(message, code, url, response) {
  return new CloudflareApiError(message, { path: url.pathname, status: response.status, errors: [{ code }] })
}
