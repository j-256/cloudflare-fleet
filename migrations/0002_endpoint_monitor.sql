CREATE TABLE monitor_meta (
  account_id TEXT PRIMARY KEY,
  catalog_generation TEXT,
  catalog_zones_json TEXT CHECK (
    catalog_zones_json IS NULL OR json_valid(catalog_zones_json)
  ),
  catalog_zone_cursor INTEGER NOT NULL DEFAULT 0 CHECK (catalog_zone_cursor >= 0),
  catalog_refresh_started_at TEXT,
  catalog_refresh_completed_at TEXT,
  analytics_cursor_at TEXT,
  last_run_started_at TEXT,
  last_run_completed_at TEXT,
  last_run_status TEXT CHECK (
    last_run_status IS NULL OR last_run_status IN ('running', 'healthy', 'degraded', 'failed')
  ),
  last_error_code TEXT,
  lease_token TEXT,
  lease_until TEXT
);

CREATE TABLE monitor_endpoint (
  account_id TEXT NOT NULL,
  zone_id TEXT NOT NULL,
  hostname TEXT NOT NULL,
  zone_name TEXT NOT NULL,
  record_types_json TEXT NOT NULL CHECK (json_valid(record_types_json)),
  catalog_generation TEXT NOT NULL,
  catalog_active INTEGER NOT NULL DEFAULT 1 CHECK (catalog_active IN (0, 1)),
  selected INTEGER NOT NULL DEFAULT 0 CHECK (selected IN (0, 1)),
  selection_reason TEXT NOT NULL DEFAULT 'inactive' CHECK (
    selection_reason IN (
      'active-traffic',
      'excluded',
      'included',
      'inactive',
      'open-incident',
      'zone-apex'
    )
  ),
  request_count INTEGER NOT NULL DEFAULT 0 CHECK (request_count >= 0),
  discovered_at TEXT NOT NULL,
  last_observation_at TEXT,
  last_probe_at TEXT,
  last_probe_status INTEGER,
  last_probe_error_code TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  consecutive_successes INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_successes >= 0),
  last_failure_at TEXT,
  last_failure_kind TEXT CHECK (
    last_failure_kind IS NULL OR last_failure_kind IN ('http', 'network')
  ),
  last_failure_status INTEGER,
  active_incident_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (account_id, zone_id, hostname)
);

CREATE INDEX monitor_endpoint_probe_order
  ON monitor_endpoint (
    account_id,
    catalog_active,
    active_incident_id,
    last_probe_at,
    hostname
  );

CREATE TABLE monitor_analytics_observation (
  account_id TEXT NOT NULL,
  zone_id TEXT NOT NULL,
  hostname TEXT NOT NULL,
  status INTEGER NOT NULL,
  observed_minute TEXT NOT NULL,
  request_count INTEGER NOT NULL CHECK (request_count > 0),
  recorded_at TEXT NOT NULL,
  processed_at TEXT,
  PRIMARY KEY (account_id, zone_id, hostname, status, observed_minute),
  FOREIGN KEY (account_id, zone_id, hostname)
    REFERENCES monitor_endpoint(account_id, zone_id, hostname)
    ON DELETE CASCADE
);

CREATE INDEX monitor_analytics_pending
  ON monitor_analytics_observation (account_id, processed_at, observed_minute);

CREATE TABLE monitor_incident (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  zone_id TEXT NOT NULL,
  zone_name TEXT NOT NULL,
  hostname TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open', 'resolved')),
  failure_kind TEXT NOT NULL CHECK (failure_kind IN ('http', 'network')),
  error_code TEXT,
  first_status INTEGER,
  latest_status INTEGER,
  latest_signal TEXT NOT NULL CHECK (latest_signal IN ('analytics', 'probe')),
  request_count INTEGER,
  first_observed_at TEXT NOT NULL,
  last_failure_at TEXT NOT NULL,
  opened_at TEXT NOT NULL,
  resolved_at TEXT,
  FOREIGN KEY (account_id, zone_id, hostname)
    REFERENCES monitor_endpoint(account_id, zone_id, hostname)
    ON DELETE RESTRICT
);

CREATE UNIQUE INDEX monitor_incident_one_open_per_endpoint
  ON monitor_incident (account_id, zone_id, hostname)
  WHERE status = 'open';

CREATE INDEX monitor_incident_account_recency
  ON monitor_incident (account_id, opened_at DESC);

CREATE TABLE monitor_outbox (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  incident_id TEXT NOT NULL,
  transition TEXT NOT NULL CHECK (transition IN ('opened', 'resolved')),
  event_json TEXT NOT NULL CHECK (json_valid(event_json)),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  created_at TEXT NOT NULL,
  next_attempt_at TEXT NOT NULL,
  last_attempt_at TEXT,
  last_error_code TEXT,
  delivered_at TEXT,
  UNIQUE (incident_id, transition),
  FOREIGN KEY (incident_id) REFERENCES monitor_incident(id) ON DELETE CASCADE
);

CREATE INDEX monitor_outbox_due
  ON monitor_outbox (account_id, delivered_at, next_attempt_at, created_at);
