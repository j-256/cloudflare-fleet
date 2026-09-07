CREATE TABLE state_reconciliation (
  account_id TEXT NOT NULL,
  id TEXT NOT NULL,
  before_json TEXT NOT NULL CHECK (json_valid(before_json)),
  plan_digest TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (account_id, id)
);
