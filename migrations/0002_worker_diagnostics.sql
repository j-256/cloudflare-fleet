CREATE TABLE IF NOT EXISTS worker_diagnostics (
  account_id TEXT PRIMARY KEY,
  document_json TEXT NOT NULL,
  revision TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS worker_execution_lock (
  account_id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
