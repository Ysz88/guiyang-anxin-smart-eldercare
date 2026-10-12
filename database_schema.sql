-- 桂养安心·旅居智管 数据库建表脚本 (schema v2)
-- 补齐说明：2026-08-23 优化源码包缺少本文件，而 database.py 第18行
-- SCHEMA_PATH = ROOT / "database_schema.sql" 在 initialize() 中直接读取，
-- 缺失会导致「启动作品.bat / python server.py」抛 FileNotFoundError 而无法启动。
-- 本文件按 database.py 实际读写的表与字段逆向补齐（含 sos_sessions、sos_revision）。

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
  -- v2 增量字段：可计算的预计返回时间（ISO8601），供前端每15秒比对超时
  expected_return_at TEXT NOT NULL DEFAULT '',
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
  updated_at TEXT NOT NULL,
  -- v3：处置时限由服务器控制（毫秒）。按时 / 超时由 closed_at_ms 与 due_at_ms 比较得出，不再依赖页面文案
  created_at_ms INTEGER,
  due_at_ms INTEGER,
  closed_at_ms INTEGER
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

-- ===== v2 新增：应急呼救（安心应答）只追加台账 =====
-- 与 app_snapshot 解耦：机构端提交整体状态时不会覆盖/删除老人端刚创建的呼救工单。
-- 冲突策略：updated_at_ms last-write-wins（database.py::_upsert_sos 校验旧数据不覆盖新数据）。
CREATE TABLE IF NOT EXISTS sos_sessions (
  id TEXT PRIMARY KEY,
  resident_id TEXT NOT NULL DEFAULT '',
  resident_name TEXT NOT NULL DEFAULT '',
  trigger_source TEXT NOT NULL DEFAULT '',
  risk_level TEXT NOT NULL DEFAULT 'high',
  status TEXT NOT NULL DEFAULT '',
  escalation INTEGER NOT NULL DEFAULT 1,
  callback_status TEXT NOT NULL DEFAULT '',
  callback_attempts INTEGER NOT NULL DEFAULT 0,
  claimed_by TEXT NOT NULL DEFAULT '',
  response_seconds REAL,
  linked_event_id TEXT NOT NULL DEFAULT '',
  created_label TEXT NOT NULL DEFAULT '',
  resolved_label TEXT NOT NULL DEFAULT '',
  payload_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  -- v2 增量字段：毫秒时间戳，用于跨设备轻量轮询的 ?since= 版本比较
  updated_at_ms INTEGER NOT NULL DEFAULT 0
);

-- 呼救台账的单调递增修订号，供 GET /api/sos?since=N 在无变化时只回版本号
CREATE TABLE IF NOT EXISTS sos_revision (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  revision INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS state_revision (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  revision INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_stays_resident ON stays(resident_id);
CREATE INDEX IF NOT EXISTS idx_movements_resident_status ON movement_records(resident_id, movement_status);
CREATE INDEX IF NOT EXISTS idx_movements_regulator ON movement_records(regulator_status);
CREATE INDEX IF NOT EXISTS idx_services_resident ON service_records(resident_id);
CREATE INDEX IF NOT EXISTS idx_events_status_level ON risk_events(status, risk_level);
CREATE INDEX IF NOT EXISTS idx_timeline_event ON event_timeline(event_id, sequence_no);
CREATE INDEX IF NOT EXISTS idx_audit_occurred ON audit_logs(occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_sos_updated ON sos_sessions(updated_at_ms DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_events_due ON risk_events(status, due_at_ms);

INSERT INTO schema_meta(key, value) VALUES ('schema_version', '3')
ON CONFLICT(key) DO UPDATE SET value = excluded.value;
