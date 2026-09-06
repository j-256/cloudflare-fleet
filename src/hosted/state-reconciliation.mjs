import { createEmptyFleetStateDocument, isFleetStateDocument } from "../fleet-state.mjs"
import { planStateReconciliation } from "../state-reconciliation.mjs"
import { revisedWorkerRecords } from "../worker-records.mjs"
import { portableReviewedPlanSet } from "../reviewed-plan-content.mjs"
import { AlignmentPlanChangedError } from "../write-executor.mjs"
import { stableString } from "../normalize.mjs"
import { hostedWorkerStore } from "./worker-store.mjs"
import { hostedExecutionLock } from "./execution-lock.mjs"
import { ensureHostedAccount } from "./d1-store.mjs"

const ARCHIVE_LIST_LIMIT = 100

export function hostedStateReconciliation(db, accountId) {
  async function read(archiveId = null) {
    if (archiveId) {
      const row = await db.prepare("SELECT before_json FROM state_reconciliation WHERE account_id = ? AND id = ?").bind(accountId, archiveId).first()
      if (!row) throw new TypeError("Fleet state recovery archive is unavailable")
      const state = JSON.parse(row.before_json)
      if (!isFleetStateDocument(state, accountId)) throw new TypeError("Fleet state recovery archive is invalid")
      return state
    }
    await Promise.all([
      ensureHostedAccount(db, accountId),
      hostedWorkerStore(db, accountId).read(),
    ])
    const rows = await db.batch([
      db.prepare("SELECT document_json FROM fleet_intent WHERE account_id = ?").bind(accountId),
      db.prepare("SELECT revision, updated_at FROM activity_meta WHERE account_id = ?").bind(accountId),
      db.prepare("SELECT payload_json FROM operation_activity WHERE account_id = ? ORDER BY sequence").bind(accountId),
      db.prepare("SELECT document_json FROM worker_diagnostics WHERE account_id = ?").bind(accountId),
    ])
    const state = {
      ...createEmptyFleetStateDocument(accountId),
      intent: JSON.parse(rows[0].results[0].document_json),
      activity: { revision: rows[1].results[0].revision, updatedAt: rows[1].results[0].updated_at, entries: rows[2].results.map((row) => JSON.parse(row.payload_json)) },
      workers: JSON.parse(rows[3].results[0].document_json),
    }
    if (!isFleetStateDocument(state, accountId)) throw new TypeError("Hosted Fleet state is invalid")
    return state
  }
  async function getState(archiveId) {
    const state = await read(archiveId)
    const archives = await db.prepare("SELECT id, plan_digest, created_at FROM state_reconciliation WHERE account_id = ? ORDER BY created_at DESC LIMIT ?").bind(accountId, ARCHIVE_LIST_LIMIT).all()
    return { schemaVersion: 1, status: "ok", accountId, state, archives: archives.results, archivesLimited: archives.results.length === ARCHIVE_LIST_LIMIT }
  }
  async function planState(input) { return planStateReconciliation(await read(), input) }
  async function applyState(input, digest) {
    return hostedExecutionLock(db, accountId).withWriteLock(async (owner) => {
      const current = await read()
      const plan = await planStateReconciliation(current, input)
      if (plan.planSet.digest !== digest) throw new AlignmentPlanChangedError(digest, plan.planSet.digest)
      const id = crypto.randomUUID()
      const timestamp = new Date().toISOString()
      const revision = (await portableReviewedPlanSet({ accountId, plans: [], request: { id, timestamp, target: plan.target } })).digest.slice(7)
      const intent = { ...plan.target.intent, revision, updatedAt: timestamp }
      const workers = await revisedWorkerRecords(plan.target.workers)
      const archived = "EXISTS (SELECT 1 FROM state_reconciliation WHERE account_id = ? AND id = ?)"
      const statements = [
        db.prepare(`
          INSERT INTO state_reconciliation (account_id, id, before_json, plan_digest, created_at)
          SELECT ?, ?, ?, ?, ? WHERE
            (SELECT revision FROM fleet_intent WHERE account_id = ?) = ?
            AND (SELECT revision FROM activity_meta WHERE account_id = ?) = ?
            AND (SELECT revision FROM worker_diagnostics WHERE account_id = ?) = ?
            AND EXISTS (SELECT 1 FROM worker_execution_lock WHERE account_id = ? AND owner = ? AND expires_at >= ?)
        `).bind(accountId, id, JSON.stringify(current), digest, timestamp,
          accountId, current.intent.revision, accountId, current.activity.revision,
          accountId, current.workers.revision, accountId, owner, Date.now()),
        db.prepare(`UPDATE fleet_intent SET document_json = ?, revision = ?, updated_at = ? WHERE account_id = ? AND ${archived}`)
          .bind(JSON.stringify(intent), revision, timestamp, accountId, accountId, id),
      ]
      const present = new Set(current.activity.entries.map((entry) => entry.id))
      const pending = plan.target.activity.entries.filter((entry) => !present.has(entry.id))
      const ordered = []
      while (pending.length) {
        const index = pending.findIndex((entry) => !entry.undoOf || present.has(entry.undoOf))
        if (index < 0) throw new TypeError("Merged activity contains missing or cyclic undo ancestry")
        const [entry] = pending.splice(index, 1)
        ordered.push(entry)
        present.add(entry.id)
      }
      if (ordered.length) statements.push(db.prepare(`
        INSERT INTO operation_activity (account_id, id, payload_json, status, undo_of, started_at)
        SELECT ?, json_extract(value, '$.id'), value, json_extract(value, '$.status'),
          json_extract(value, '$.undoOf'), json_extract(value, '$.startedAt')
        FROM json_each(?) WHERE ${archived} ORDER BY CAST(key AS INTEGER)
      `).bind(accountId, JSON.stringify(ordered), accountId, id))
      statements.push(
        db.prepare(`UPDATE activity_meta SET revision = ?, updated_at = ? WHERE account_id = ? AND ${archived}`).bind(revision, timestamp, accountId, accountId, id),
        db.prepare(`UPDATE worker_diagnostics SET document_json = ?, revision = ? WHERE account_id = ? AND ${archived}`).bind(JSON.stringify(workers), workers.revision, accountId, accountId, id),
      )
      const results = await db.batch(statements)
      if (results[0].meta?.changes !== 1) throw new AlignmentPlanChangedError(digest, null)
      const state = await read()
      const sortEntries = (entries) => [...entries].sort((a, b) => a.id.localeCompare(b.id))
      if (stableString(state.intent) !== stableString(intent)
        || stableString(state.workers) !== stableString(workers)
        || stableString(sortEntries(state.activity.entries)) !== stableString(sortEntries(plan.target.activity.entries))) {
        throw new Error("State reconciliation committed but persistence verification failed; inspect the saved recovery archive before further changes")
      }
      return { schemaVersion: 1, status: "saved", accountId, applied: true, archiveId: id, planDigest: digest, summary: plan.summary, state }
    })
  }
  return { getState, planState, applyState }
}
