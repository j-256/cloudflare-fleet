export const CACHE_SCHEMA_VERSION = 1
export const CACHE_RECORD_GLOBAL = "__CLOUDFLARE_FLEET_CACHE__"
export const CACHE_SNAPSHOT_GLOBAL = "__CLOUDFLARE_FLEET_SNAPSHOT__"

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function isTimestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value))
}

export function isCacheRecord(value, accountId = null) {
  if (!isObject(value)) return false
  if (value.schemaVersion !== CACHE_SCHEMA_VERSION) return false
  if (typeof value.accountId !== "string" || value.accountId.length === 0) return false
  if (accountId !== null && value.accountId !== accountId) return false
  if (!isTimestamp(value.loadedAt)) return false
  if (value.updatedAt !== undefined && !isTimestamp(value.updatedAt)) return false
  if (!isObject(value.inventory)) return false
  if (!Array.isArray(value.inventory.zones)) return false
  if (value.inventory.loadedAt !== value.loadedAt) return false
  if (value.inventory.account?.id !== value.accountId) return false
  return true
}

export function cacheRecordUpdatedAt(record) {
  return record.updatedAt || record.loadedAt
}

export function compareCacheRecordsNewestFirst(left, right) {
  return Date.parse(cacheRecordUpdatedAt(right))
    - Date.parse(cacheRecordUpdatedAt(left))
    || Date.parse(right.loadedAt) - Date.parse(left.loadedAt)
}

export function createCacheRecord(accountId, inventory, options = {}) {
  const record = {
    accountId,
    inventory,
    loadedAt: inventory?.loadedAt,
    schemaVersion: CACHE_SCHEMA_VERSION,
    updatedAt: options.updatedAt ?? new Date().toISOString(),
  }
  if (!isCacheRecord(record, accountId)) throw new TypeError("Inventory cannot be cached")
  return record
}

export function newestCacheRecord(records, accountId) {
  return records
    .filter((record) => isCacheRecord(record, accountId))
    .sort(compareCacheRecordsNewestFirst)[0] || null
}
