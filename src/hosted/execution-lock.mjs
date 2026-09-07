export const HOSTED_EXECUTION_HEADER = "X-Fleet-Execution"
export const HOSTED_LEASE_MS = 120000

export class HostedExecutionConflictError extends Error {
  constructor(message = "Another Fleet operation is active or has unresolved pending activity") {
    super(message)
    this.name = "HostedExecutionConflictError"
  }
}

export function hostedExecutionLock(db, accountId, options = {}) {
  const now = options.now || Date.now
  async function acquire(owner = crypto.randomUUID(), recoveryActivityId = null) {
    const time = now()
    const result = await db.prepare(`
      INSERT INTO worker_execution_lock (account_id, owner, expires_at)
      SELECT ?, ?, ? WHERE NOT EXISTS (
        SELECT 1 FROM operation_activity WHERE account_id = ? AND status = 'pending'
      ) OR EXISTS (
        SELECT 1 FROM operation_activity WHERE account_id = ? AND id = ? AND status = 'pending'
      )
      ON CONFLICT(account_id) DO UPDATE SET owner = excluded.owner, expires_at = excluded.expires_at
      WHERE worker_execution_lock.expires_at < ?
    `).bind(accountId, owner, time + HOSTED_LEASE_MS, accountId, accountId, recoveryActivityId, time).run()
    if (result.meta?.changes !== 1) throw new HostedExecutionConflictError()
    return owner
  }
  async function renew(owner) {
    if (typeof owner !== "string" || !owner) throw new HostedExecutionConflictError("A reviewed Fleet execution is required")
    const time = now()
    const result = await db.prepare("UPDATE worker_execution_lock SET expires_at = ? WHERE account_id = ? AND owner = ? AND expires_at >= ?")
      .bind(time + HOSTED_LEASE_MS, accountId, owner, time).run()
    if (result.meta?.changes !== 1) throw new HostedExecutionConflictError("Fleet execution lease expired or changed; inspect activity before recovery")
  }
  async function release(owner) {
    await db.prepare("DELETE FROM worker_execution_lock WHERE account_id = ? AND owner = ?").bind(accountId, owner).run()
  }
  async function withWriteLock(operation) {
    const owner = await acquire()
    try { return await operation(owner) } finally { await release(owner) }
  }
  async function assertInactive() {
    const row = await db.prepare("SELECT expires_at FROM worker_execution_lock WHERE account_id = ?").bind(accountId).first()
    if (row && row.expires_at >= now()) throw new HostedExecutionConflictError("The execution lease is still active; stop the old client and wait for expiration before recovery")
  }
  return { acquire, renew, release, withWriteLock, assertInactive }
}
