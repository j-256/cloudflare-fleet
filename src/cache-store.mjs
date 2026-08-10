import { promises as fs } from "node:fs"
import path from "node:path"

import { atomicWriteFile } from "./atomic-file.mjs"
import {
  CACHE_MAX_AGE_HOURS,
  CACHE_RECORD_GLOBAL,
  cacheRecordIsFresh,
  compareCacheRecordsNewestFirst,
  isCacheRecord,
  newestCacheRecord,
} from "./cache.mjs"
import { isMainModule } from "./entrypoint.mjs"

export const CACHE_MODE = Object.freeze({
  CLEAR: "clear",
  FRESH: "fresh",
  USE: "use",
})

const CACHE_FILE_PATTERN = /^snapshot-[A-Za-z0-9_-]+\.json$/
const MAX_CACHE_FILES_PER_ACCOUNT = 8

function cacheFilename(sessionId) {
  if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) throw new TypeError("Invalid cache session identifier")
  return `snapshot-${sessionId}.json`
}

async function ensureCacheDirectory(cacheDir) {
  await fs.mkdir(cacheDir, {
    mode: 0o700,
    recursive: true,
  })
  await fs.chmod(cacheDir, 0o700)
}

async function readCacheEntries(cacheDir) {
  let names
  try {
    names = await fs.readdir(cacheDir)
  } catch (error) {
    if (error?.code === "ENOENT") return []
    throw error
  }

  const entries = []
  for (const name of names.filter((entry) => CACHE_FILE_PATTERN.test(entry))) {
    const filePath = path.join(cacheDir, name)
    try {
      const record = JSON.parse(await fs.readFile(filePath, "utf8"))
      entries.push({
        filePath,
        name,
        record,
      })
    } catch {
      entries.push({
        filePath,
        name,
        record: null,
      })
    }
  }
  return entries
}

async function pruneCacheFiles(cacheDir) {
  const entries = await readCacheEntries(cacheDir)
  const groups = new Map()

  for (const entry of entries) {
    if (!isCacheRecord(entry.record)) {
      await fs.rm(entry.filePath, { force: true })
      continue
    }
    if (!groups.has(entry.record.accountId)) groups.set(entry.record.accountId, [])
    groups.get(entry.record.accountId).push(entry)
  }

  for (const group of groups.values()) {
    group.sort((left, right) => (
      compareCacheRecordsNewestFirst(left.record, right.record)
    ))
    for (const entry of group.slice(MAX_CACHE_FILES_PER_ACCOUNT)) {
      await fs.rm(entry.filePath, { force: true })
    }
  }
}

export async function readNewestCacheRecord(cacheDir, accountId) {
  const entries = await readCacheEntries(cacheDir)
  return newestCacheRecord(entries.map((entry) => entry.record), accountId)
}

export async function clearCacheRecords(cacheDir, accountId) {
  const entries = await readCacheEntries(cacheDir)
  for (const entry of entries) {
    if (!isCacheRecord(entry.record) || entry.record.accountId === accountId) {
      await fs.rm(entry.filePath, { force: true })
    }
  }
}

export async function persistCacheRecord(cacheDir, sessionId, record) {
  if (!isCacheRecord(record)) throw new TypeError("Invalid cache record")
  await ensureCacheDirectory(cacheDir)
  const filePath = path.join(cacheDir, cacheFilename(sessionId))
  await atomicWriteFile(filePath, `${JSON.stringify(record)}\n`)
  await pruneCacheFiles(cacheDir)
  return filePath
}

export async function prepareCacheScript(options) {
  const {
    accountId,
    cacheDir,
    mode,
    outputPath,
  } = options

  if (!Object.values(CACHE_MODE).includes(mode)) throw new TypeError(`Invalid cache mode: ${mode}`)
  await ensureCacheDirectory(cacheDir)
  if (mode === CACHE_MODE.CLEAR) await clearCacheRecords(cacheDir, accountId)

  const record = mode === CACHE_MODE.USE
    ? await readNewestCacheRecord(cacheDir, accountId)
    : null
  const payload = JSON.stringify(record)
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029")
  await atomicWriteFile(
    outputPath,
    `window[${JSON.stringify(CACHE_RECORD_GLOBAL)}] = ${payload}\n`,
  )

  return {
    cacheFresh: record !== null && cacheRecordIsFresh(record, options.now),
    cacheHit: record !== null,
    loadedAt: record?.loadedAt || null,
    maxAgeHours: CACHE_MAX_AGE_HOURS,
  }
}

async function main(args) {
  const [command, cacheDir, accountId, outputPath, mode] = args
  if (command !== "prepare" || !cacheDir || !accountId || !outputPath || !mode) {
    throw new Error("Usage: cache-store.mjs prepare CACHE_DIR ACCOUNT_ID OUTPUT_PATH MODE")
  }
  const result = await prepareCacheScript({
    accountId,
    cacheDir,
    mode,
    outputPath,
  })
  process.stdout.write(`${JSON.stringify(result)}\n`)
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
