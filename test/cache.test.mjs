import assert from "node:assert/strict"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import {
  cacheRecordUpdatedAt,
  CACHE_RECORD_GLOBAL,
  CACHE_SCHEMA_VERSION,
  createCacheRecord,
  isCacheRecord,
  newestCacheRecord,
} from "../src/cache.mjs"
import {
  CACHE_MODE,
  clearCacheRecords,
  persistCacheRecord,
  prepareCacheScript,
  readNewestCacheRecord,
} from "../src/cache-store.mjs"
import { runtimePathIsSafe } from "../src/session-watcher.mjs"
import {
  makeInventory,
  makeZone,
} from "./fixtures.mjs"

function inventoryAt(timestamp, accountId = "account-id") {
  const inventory = makeInventory([makeZone("alpha.example")])
  inventory.account.id = accountId
  inventory.loadedAt = timestamp
  return inventory
}

test("cache records are account-scoped and schema-versioned", () => {
  const record = createCacheRecord("account-id", inventoryAt("2026-07-29T01:00:00Z"))
  const legacyRecord = {
    ...record,
  }
  delete legacyRecord.updatedAt

  assert.equal(record.schemaVersion, CACHE_SCHEMA_VERSION)
  assert.equal(isCacheRecord(record, "account-id"), true)
  assert.equal(isCacheRecord(legacyRecord, "account-id"), true)
  assert.equal(cacheRecordUpdatedAt(legacyRecord), legacyRecord.loadedAt)
  assert.equal(isCacheRecord(record, "another-account"), false)
  assert.equal(isCacheRecord({ ...record, schemaVersion: 0 }), false)
  assert.equal(isCacheRecord({ ...record, updatedAt: "invalid" }), false)
})

test("cache records contain inventory but not launcher credentials", () => {
  const record = createCacheRecord("account-id", inventoryAt("2026-07-29T01:00:00Z"))
  const serialized = JSON.stringify(record)

  assert.equal(serialized.includes("apiToken"), false)
  assert.equal(serialized.includes("Authorization"), false)
})

test("newestCacheRecord ignores invalid and older records", () => {
  const older = createCacheRecord(
    "account-id",
    inventoryAt("2026-07-29T01:00:00Z"),
    {
      updatedAt: "2026-07-29T01:05:00Z",
    },
  )
  const newer = createCacheRecord(
    "account-id",
    inventoryAt("2026-07-29T02:00:00Z"),
    {
      updatedAt: "2026-07-29T02:05:00Z",
    },
  )

  assert.equal(
    newestCacheRecord([null, newer, older], "account-id").loadedAt,
    "2026-07-29T02:00:00Z",
  )
})

test("newestCacheRecord prefers a later scoped update over its older audit", () => {
  const newerAudit = createCacheRecord(
    "account-id",
    inventoryAt("2026-07-29T02:00:00Z"),
    {
      updatedAt: "2026-07-29T02:05:00Z",
    },
  )
  const patchedOlderAudit = createCacheRecord(
    "account-id",
    inventoryAt("2026-07-29T01:00:00Z"),
    {
      updatedAt: "2026-07-29T02:10:00Z",
    },
  )

  assert.equal(
    newestCacheRecord(
      [newerAudit, patchedOlderAudit],
      "account-id",
    ),
    patchedOlderAudit,
  )
  assert.equal(
    cacheRecordUpdatedAt(patchedOlderAudit),
    "2026-07-29T02:10:00Z",
  )
})

test("cache store persists independent sessions and injects the newest snapshot", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cloudflare-fleet-cache-test-"))
  context.after(() => fs.rm(directory, { force: true, recursive: true }))
  const outputPath = path.join(directory, "cache.js")
  const older = createCacheRecord("account-id", inventoryAt("2026-07-29T01:00:00Z"))
  const newer = createCacheRecord("account-id", inventoryAt("2026-07-29T02:00:00Z"))

  await persistCacheRecord(directory, "first", older)
  await persistCacheRecord(directory, "second", newer)
  assert.equal((await readNewestCacheRecord(directory, "account-id")).loadedAt, newer.loadedAt)

  const result = await prepareCacheScript({
    accountId: "account-id",
    cacheDir: directory,
    mode: CACHE_MODE.USE,
    outputPath,
  })
  const script = await fs.readFile(outputPath, "utf8")

  assert.deepEqual(result, {
    cacheHit: true,
    loadedAt: newer.loadedAt,
  })
  assert.equal(script.startsWith(`window[${JSON.stringify(CACHE_RECORD_GLOBAL)}] = `), true)
  assert.equal(script.includes(newer.loadedAt), true)
})

test("fresh bypasses cache and clear removes account snapshots", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cloudflare-fleet-cache-test-"))
  context.after(() => fs.rm(directory, { force: true, recursive: true }))
  const outputPath = path.join(directory, "cache.js")
  const record = createCacheRecord("account-id", inventoryAt("2026-07-29T01:00:00Z"))
  const other = createCacheRecord(
    "other-account",
    inventoryAt("2026-07-29T01:00:00Z", "other-account"),
  )

  await persistCacheRecord(directory, "first", record)
  await persistCacheRecord(directory, "other", other)
  const fresh = await prepareCacheScript({
    accountId: "account-id",
    cacheDir: directory,
    mode: CACHE_MODE.FRESH,
    outputPath,
  })
  assert.equal(fresh.cacheHit, false)
  assert.equal((await fs.readFile(outputPath, "utf8")).includes(" = null"), true)

  await clearCacheRecords(directory, "account-id")
  assert.equal(await readNewestCacheRecord(directory, "account-id"), null)
  assert.equal((await readNewestCacheRecord(directory, "other-account")).accountId, "other-account")
})

test("runtime cleanup accepts only direct cloudflare-fleet children", () => {
  assert.equal(
    runtimePathIsSafe("/tmp/cloudflare-fleet.abc123", "/tmp"),
    true,
  )
  assert.equal(
    runtimePathIsSafe("/tmp/other.abc123", "/tmp"),
    false,
  )
  assert.equal(
    runtimePathIsSafe("/tmp/nested/cloudflare-fleet.abc123", "/tmp"),
    false,
  )
})
