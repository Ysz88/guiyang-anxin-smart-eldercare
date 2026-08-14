PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS app_snapshot (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL,
  data_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS institutions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  city TEXT NOT NULL,
  residents_count INTEGER NOT NULL DEFAULT 0,
  alerts_count INTEGER NOT NULL DEFAULT 0,
  response_time TEXT NOT NULL DEFAULT '',
  closure_rate REAL NOT NULL DEFAULT 0,
  quality_score REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT '正常',
  payload_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  role TEXT PRIMARY KEY,
  account TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  display_name TEXT NOT NULL,
  organization TEXT NOT NULL,
  avatar TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS residents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  age INTEGER NOT NULL,
  source_region TEXT NOT NULL,
  room TEXT NOT NULL,
  check_in TEXT NOT NULL,
  risk_level TEXT NOT NULL,
  freshness TEXT NOT NULL,
  status TEXT NOT NULL,
  screening_json TEXT,
  payload_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS stays (
  id TEXT PRIMARY KEY,
  resident_id TEXT NOT NULL REFERENCES residents(id) ON DELETE CASCADE,
  institution_id TEXT REFERENCES institutions(id) ON DELETE SET NULL,
  city TEXT NOT NULL,
  room TEXT NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  source TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS movement_records (
  id TEXT PRIMARY KEY,
  resident_id TEXT NOT NULL REFERENCES residents(id) ON DELETE CASCADE,
  movement_type TEXT NOT NULL,
  movement_status TEXT NOT NULL,
  risk_level TEXT NOT NULL,
  destination TEXT NOT NULL,
  reason TEXT NOT NULL,
  depart_at TEXT NOT NULL,
  expected_return TEXT NOT NULL,
  actual_return TEXT NOT NULL DEFAULT '',
  responsible_person TEXT NOT NULL,
  responsible_phone TEXT NOT NULL,
  companion TEXT NOT NULL,
  source TEXT NOT NULL,
  institution_status TEXT NOT NULL,
  regulator_status TEXT NOT NULL,
  confirmed_by TEXT NOT NULL DEFAULT '',
  confirmed_at TEXT NOT NULL DEFAULT '',
  linked_event_id TEXT NOT NULL DEFAULT '',
  payload_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS service_records (
  id TEXT PRIMARY KEY,
  resident_id TEXT NOT NULL REFERENCES residents(id) ON DELETE CASCADE,
  service_type TEXT NOT NULL,
  staff TEXT NOT NULL,
  service_time TEXT NOT NULL,
  result TEXT NOT NULL,
  status TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS risk_events (
  id TEXT PRIMARY KEY,
  resident_id TEXT NOT NULL REFERENCES residents(id) ON DELETE CASCADE,
  risk_level TEXT NOT NULL,
  category TEXT NOT NULL,
  title TEXT NOT NULL,
  source TEXT NOT NULL,
  location TEXT NOT NULL,
  event_time TEXT NOT NULL,
  status TEXT NOT NULL,
  owner TEXT NOT NULL,
  deadline TEXT NOT NULL,
  summary TEXT NOT NULL,
  recommended_action TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS event_timeline (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL REFERENCES risk_events(id) ON DELETE CASCADE,
  sequence_no INTEGER NOT NULL,
  event_time TEXT NOT NULL,
  content TEXT NOT NULL,
  state TEXT NOT NULL,
  UNIQUE(event_id, sequence_no)
);

CREATE TABLE IF NOT EXISTS consents (
  resident_id TEXT NOT NULL REFERENCES residents(id) ON DELETE CASCADE,
  consent_type TEXT NOT NULL,
  granted INTEGER NOT NULL CHECK (granted IN (0, 1)),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (resident_id, consent_type)
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  occurred_at TEXT NOT NULL,
  actor_role TEXT NOT NULL,
  actor_name TEXT NOT NULL,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  detail_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_stays_resident ON stays(resident_id);
CREATE INDEX IF NOT EXISTS idx_movements_resident_status ON movement_records(resident_id, movement_status);
CREATE INDEX IF NOT EXISTS idx_movements_regulator ON movement_records(regulator_status);
CREATE INDEX IF NOT EXISTS idx_services_resident ON service_records(resident_id);
CREATE INDEX IF NOT EXISTS idx_events_status_level ON risk_events(status, risk_level);
CREATE INDEX IF NOT EXISTS idx_timeline_event ON event_timeline(event_id, sequence_no);
CREATE INDEX IF NOT EXISTS idx_audit_occurred ON audit_logs(occurred_at DESC);

INSERT INTO schema_meta(key, value) VALUES ('schema_version', '1')
ON CONFLICT(key) DO UPDATE SET value = excluded.value;
