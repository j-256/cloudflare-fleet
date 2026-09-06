import { emptyWorkerRecords, isWorkerRecords, revisedWorkerRecords } from "../worker-records.mjs"

const LOCK_LEASE_MS = 120000

export function hostedWorkerStore(db, accountId) {
  async function read() {
    const empty = emptyWorkerRecords()
    await db.prepare("INSERT OR IGNORE INTO worker_diagnostics (account_id, document_json, revision) VALUES (?, ?, ?)").bind(accountId, JSON.stringify(empty), empty.revision).run()
    const row = await db.prepare("SELECT document_json, revision FROM worker_diagnostics WHERE account_id = ?").bind(accountId).first()
    const value = JSON.parse(row.document_json)
    if (!isWorkerRecords(value) || row.revision !== value.revision) throw new Error("Invalid Worker diagnostics state")
    return value
  }
  async function write(expectedRevision, document) {
    await read()
    const next = await revisedWorkerRecords(document)
    const result = await db.prepare("UPDATE worker_diagnostics SET document_json = ?, revision = ? WHERE account_id = ? AND revision = ?").bind(JSON.stringify(next), next.revision, accountId, expectedRevision).run()
    if (result.meta?.changes !== 1) throw new Error("Worker records revision changed")
    return next
  }
  async function withWriteLock(operation) {
    const owner = crypto.randomUUID()
    const now = Date.now()
    const result = await db.prepare("INSERT INTO worker_execution_lock (account_id, owner, expires_at) VALUES (?, ?, ?) ON CONFLICT(account_id) DO UPDATE SET owner = excluded.owner, expires_at = excluded.expires_at WHERE worker_execution_lock.expires_at < ?").bind(accountId, owner, now + LOCK_LEASE_MS, now).run()
    if (result.meta?.changes !== 1) throw new Error("Another Worker operation is in progress")
    try { return await operation() } finally {
      await db.prepare("DELETE FROM worker_execution_lock WHERE account_id = ? AND owner = ?").bind(accountId, owner).run()
    }
  }
  return { read, write, withWriteLock }
}
