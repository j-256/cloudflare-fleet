CREATE TABLE fleet_intent (
  account_id TEXT PRIMARY KEY,
  document_json TEXT NOT NULL CHECK (json_valid(document_json)),
  revision TEXT NOT NULL,
  updated_at TEXT
);

CREATE TABLE activity_meta (
  account_id TEXT PRIMARY KEY,
  revision TEXT NOT NULL,
  updated_at TEXT
);

CREATE TABLE operation_activity (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL,
  id TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  status TEXT NOT NULL,
  undo_of TEXT,
  started_at TEXT NOT NULL,
  UNIQUE (account_id, id),
  FOREIGN KEY (account_id) REFERENCES activity_meta(account_id) ON DELETE CASCADE
);

CREATE INDEX operation_activity_account_sequence
  ON operation_activity (account_id, sequence);

CREATE UNIQUE INDEX operation_activity_active_undo
  ON operation_activity (account_id, undo_of)
  WHERE undo_of IS NOT NULL AND status IN ('pending', 'verified');

CREATE TRIGGER operation_activity_validate_undo
BEFORE INSERT ON operation_activity
WHEN NEW.undo_of IS NOT NULL AND NOT EXISTS (
  SELECT 1
  FROM operation_activity
  WHERE account_id = NEW.account_id
    AND id = NEW.undo_of
    AND status = 'verified'
    AND json_extract(payload_json, '$.inverse.available') = 1
)
BEGIN
  SELECT RAISE(ABORT, 'Guarded undo requires a reversible verified operation');
END;

CREATE TRIGGER operation_activity_finalize_pending
BEFORE UPDATE OF payload_json, status ON operation_activity
WHEN OLD.status <> 'pending'
BEGIN
  SELECT RAISE(ABORT, 'Operation activity is already complete');
END;

CREATE TABLE inventory_cache (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  record_json TEXT NOT NULL CHECK (json_valid(record_json)),
  loaded_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX inventory_cache_account_recency
  ON inventory_cache (account_id, updated_at DESC, loaded_at DESC, created_at DESC);
