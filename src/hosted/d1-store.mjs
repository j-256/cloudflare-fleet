import {
  cacheRecordUpdatedAt,
  isCacheRecord,
} from "../cache.mjs"
import {
  createEmptyFleetIntentDocument,
  isFleetIntentDocument,
} from "../fleet-intent.mjs"
import {
  createEmptyOperationActivityDocument,
  isOperationActivityDocument,
  isOperationActivityEntry,
  OPERATION_ACTIVITY_STATUS,
} from "../operation-history.mjs"
import {
  stableString,
} from "../normalize.mjs"

const MAX_CACHE_RECORDS_PER_ACCOUNT = 8
const INSERT_INITIAL_INTENT_SQL = `
  INSERT OR IGNORE INTO fleet_intent (
    account_id,
    document_json,
    revision,
    updated_at
  ) VALUES (?, ?, ?, ?)
`
const INSERT_INITIAL_ACTIVITY_SQL = `
  INSERT OR IGNORE INTO activity_meta (
    account_id,
    revision,
    updated_at
  ) VALUES (?, ?, ?)
`
const READ_INTENT_SQL = `
  SELECT document_json, revision, updated_at
  FROM fleet_intent
  WHERE account_id = ?
`
const UPDATE_INTENT_SQL = `
  UPDATE fleet_intent
  SET document_json = ?, revision = ?, updated_at = ?
  WHERE account_id = ? AND revision = ?
`
const READ_ACTIVITY_META_SQL = `
  SELECT revision, updated_at
  FROM activity_meta
  WHERE account_id = ?
`
const READ_ACTIVITY_ENTRIES_SQL = `
  SELECT payload_json
  FROM operation_activity
  WHERE account_id = ?
  ORDER BY sequence
`
const INSERT_ACTIVITY_SQL = `
  INSERT INTO operation_activity (
    account_id,
    id,
    payload_json,
    status,
    undo_of,
    started_at
  ) VALUES (?, ?, ?, ?, ?, ?)
`
const READ_ACTIVITY_ENTRY_SQL = `
  SELECT payload_json, status
  FROM operation_activity
  WHERE account_id = ? AND id = ?
`
const FINALIZE_ACTIVITY_SQL = `
  UPDATE operation_activity
  SET payload_json = ?, status = ?
  WHERE account_id = ? AND id = ?
`
const UPDATE_ACTIVITY_META_SQL = `
  UPDATE activity_meta
  SET revision = lower(hex(randomblob(32))), updated_at = ?
  WHERE account_id = ?
`
const READ_CACHE_SQL = `
  SELECT record_json
  FROM inventory_cache
  WHERE account_id = ?
  ORDER BY updated_at DESC, loaded_at DESC, created_at DESC
  LIMIT ?
`
const INSERT_CACHE_SQL = `
  INSERT INTO inventory_cache (
    id,
    account_id,
    record_json,
    loaded_at,
    updated_at,
    created_at
  ) VALUES (?, ?, ?, ?, ?, ?)
`
const PRUNE_CACHE_SQL = `
  DELETE FROM inventory_cache
  WHERE account_id = ? AND id IN (
    SELECT id
    FROM inventory_cache
    WHERE account_id = ?
    ORDER BY updated_at DESC, loaded_at DESC, created_at DESC
    LIMIT -1 OFFSET ?
  )
`

export class HostedFleetIntentRevisionConflictError extends Error {
  constructor(currentDocument) {
    super("Fleet intent changed in another dashboard window")
    this.name = "HostedFleetIntentRevisionConflictError"
    this.currentDocument = currentDocument
  }
}

function resultRows(result) {
  return Array.isArray(result?.results) ? result.results : []
}

function changedRows(result) {
  return result?.meta?.changes ?? result?.meta?.rows_written ?? 0
}

function parsedJson(value, label) {
  try {
    return JSON.parse(value)
  } catch {
    throw new Error(`${label} is not valid JSON`)
  }
}

async function sha256(value) {
  const bytes = new TextEncoder().encode(value)
  const digest = await crypto.subtle.digest("SHA-256", bytes)
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
}

async function nextPersistedIntent(document) {
  const updatedAt = new Date().toISOString()
  const content = {
    ...structuredClone(document),
    revision: "",
    updatedAt,
  }
  return {
    ...content,
    revision: await sha256(JSON.stringify(content)),
  }
}

export async function ensureHostedAccount(db, accountId) {
  const intent = createEmptyFleetIntentDocument(accountId)
  const activity = createEmptyOperationActivityDocument()
  await db.batch([
    db.prepare(INSERT_INITIAL_INTENT_SQL).bind(
      accountId,
      JSON.stringify(intent),
      intent.revision,
      intent.updatedAt,
    ),
    db.prepare(INSERT_INITIAL_ACTIVITY_SQL).bind(
      accountId,
      activity.revision,
      activity.updatedAt,
    ),
  ])
}

function intentFromRow(row, accountId) {
  if (!row) throw new Error("Hosted fleet intent is unavailable")
  const document = parsedJson(row.document_json, "Hosted fleet intent")
  if (!isFleetIntentDocument(document, accountId)
    || document.revision !== row.revision
    || document.updatedAt !== row.updated_at) {
    throw new Error("Hosted fleet intent is invalid for this account")
  }
  return document
}

export async function readHostedFleetIntent(db, accountId) {
  await ensureHostedAccount(db, accountId)
  const row = await db.prepare(READ_INTENT_SQL).bind(accountId).first()
  return intentFromRow(row, accountId)
}

export async function persistHostedFleetIntent(
  db,
  accountId,
  expectedRevision,
  document,
) {
  if (!isFleetIntentDocument(document, accountId)) {
    throw new TypeError("Fleet intent document is invalid for this account")
  }
  if (typeof expectedRevision !== "string"
    || document.revision !== expectedRevision) {
    throw new TypeError("Fleet intent revision does not match the expected revision")
  }
  await ensureHostedAccount(db, accountId)
  const next = await nextPersistedIntent(document)
  const result = await db.prepare(UPDATE_INTENT_SQL).bind(
    JSON.stringify(next),
    next.revision,
    next.updatedAt,
    accountId,
    expectedRevision,
  ).run()
  if (changedRows(result) !== 1) {
    throw new HostedFleetIntentRevisionConflictError(
      await readHostedFleetIntent(db, accountId),
    )
  }
  return next
}

function activityDocument(meta, rows) {
  if (!meta) throw new Error("Hosted operation activity is unavailable")
  const entries = rows.map((row) => parsedJson(
    row.payload_json,
    "Hosted operation activity entry",
  ))
  const document = {
    entries,
    revision: meta.revision,
    updatedAt: meta.updated_at,
  }
  if (!isOperationActivityDocument(document)) {
    throw new Error("Hosted operation activity is invalid")
  }
  return document
}

export async function readHostedOperationActivity(db, accountId) {
  await ensureHostedAccount(db, accountId)
  const [metaResult, entriesResult] = await db.batch([
    db.prepare(READ_ACTIVITY_META_SQL).bind(accountId),
    db.prepare(READ_ACTIVITY_ENTRIES_SQL).bind(accountId),
  ])
  return activityDocument(
    resultRows(metaResult)[0] || null,
    resultRows(entriesResult),
  )
}

function immutableActivityShape(entry) {
  return {
    id: entry.id,
    plans: entry.plans,
    schemaVersion: entry.schemaVersion,
    startedAt: entry.startedAt,
    title: entry.title,
    undoOf: entry.undoOf,
    validatedAt: entry.validatedAt,
  }
}

function mappedActivityError(error, entry) {
  const message = error instanceof Error ? error.message : String(error)
  if (message.includes("operation_activity.account_id, operation_activity.id")) {
    return new TypeError(`Operation activity ${entry.id} already exists`)
  }
  if (message.includes("operation_activity.account_id, operation_activity.undo_of")) {
    return new TypeError("Guarded undo is already pending or verified")
  }
  if (message.includes("Guarded undo requires a reversible verified operation")) {
    return new TypeError("Guarded undo requires a reversible verified operation")
  }
  if (message.includes("Operation activity is already complete")) {
    return new TypeError(`Operation activity ${entry.id} is already complete`)
  }
  return error
}

export async function appendHostedOperationActivity(db, accountId, entry) {
  if (!isOperationActivityEntry(entry)
    || entry.status !== OPERATION_ACTIVITY_STATUS.PENDING) {
    throw new TypeError("Operation activity must start as a valid pending entry")
  }
  await ensureHostedAccount(db, accountId)
  const updatedAt = new Date().toISOString()
  try {
    await db.batch([
      db.prepare(INSERT_ACTIVITY_SQL).bind(
        accountId,
        entry.id,
        JSON.stringify(entry),
        entry.status,
        entry.undoOf,
        entry.startedAt,
      ),
      db.prepare(UPDATE_ACTIVITY_META_SQL).bind(updatedAt, accountId),
    ])
  } catch (error) {
    throw mappedActivityError(error, entry)
  }
  return readHostedOperationActivity(db, accountId)
}

export async function finalizeHostedOperationActivity(db, accountId, entry) {
  if (!isOperationActivityEntry(entry)
    || entry.status === OPERATION_ACTIVITY_STATUS.PENDING) {
    throw new TypeError("Operation activity must be completed before finalization")
  }
  await ensureHostedAccount(db, accountId)
  const row = await db.prepare(READ_ACTIVITY_ENTRY_SQL)
    .bind(accountId, entry.id)
    .first()
  if (!row) {
    throw new TypeError(`Pending operation activity ${entry.id} is unavailable`)
  }
  const pending = parsedJson(row.payload_json, "Pending operation activity")
  if (row.status !== OPERATION_ACTIVITY_STATUS.PENDING) {
    throw new TypeError(`Operation activity ${entry.id} is already complete`)
  }
  if (stableString(immutableActivityShape(pending))
    !== stableString(immutableActivityShape(entry))) {
    throw new TypeError("Completed operation activity changed its reviewed plan")
  }
  const updatedAt = new Date().toISOString()
  try {
    await db.batch([
      db.prepare(FINALIZE_ACTIVITY_SQL).bind(
        JSON.stringify(entry),
        entry.status,
        accountId,
        entry.id,
      ),
      db.prepare(UPDATE_ACTIVITY_META_SQL).bind(updatedAt, accountId),
    ])
  } catch (error) {
    throw mappedActivityError(error, entry)
  }
  return readHostedOperationActivity(db, accountId)
}

export async function readHostedCacheRecord(db, accountId) {
  const result = await db.prepare(READ_CACHE_SQL)
    .bind(accountId, MAX_CACHE_RECORDS_PER_ACCOUNT)
    .all()
  for (const row of resultRows(result)) {
    const record = parsedJson(row.record_json, "Hosted inventory cache")
    if (isCacheRecord(record, accountId)) return record
  }
  return null
}

export async function persistHostedCacheRecord(db, accountId, record) {
  if (!isCacheRecord(record, accountId)) {
    throw new TypeError("Snapshot record is invalid for this account")
  }
  const createdAt = new Date().toISOString()
  await db.batch([
    db.prepare(INSERT_CACHE_SQL).bind(
      crypto.randomUUID(),
      accountId,
      JSON.stringify(record),
      record.loadedAt,
      cacheRecordUpdatedAt(record),
      createdAt,
    ),
    db.prepare(PRUNE_CACHE_SQL).bind(
      accountId,
      accountId,
      MAX_CACHE_RECORDS_PER_ACCOUNT,
    ),
  ])
}
