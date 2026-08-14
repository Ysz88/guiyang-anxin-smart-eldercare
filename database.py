"""SQLite persistence for the local full-service build."""

from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import threading
from contextlib import closing
from datetime import datetime
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parent
DEFAULT_DB_PATH = ROOT / "runtime" / "guiyang_elders.db"
SCHEMA_PATH = ROOT / "database_schema.sql"
SEED_PATH = ROOT / "seed.json"


def now_iso() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def json_text(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def text(value: Any, default: str = "") -> str:
    return str(value if value is not None else default)


def number(value: Any, default: float = 0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


class BusinessDatabase:
    def __init__(self, path: Path | None = None) -> None:
        configured = os.environ.get("GUIYANG_DB_PATH", "").strip()
        self.path = Path(configured).expanduser() if configured else (path or DEFAULT_DB_PATH)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()

    def connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path, timeout=10)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("PRAGMA journal_mode = WAL")
        connection.execute("PRAGMA busy_timeout = 5000")
        return connection

    def initialize(self) -> None:
        schema = SCHEMA_PATH.read_text(encoding="utf-8")
        with self._lock, closing(self.connect()) as connection:
            connection.executescript(schema)
            exists = connection.execute("SELECT 1 FROM app_snapshot WHERE id = 1").fetchone()
        if not exists:
            seed = json.loads(SEED_PATH.read_text(encoding="utf-8"))
            self.replace_state(
                seed,
                {
                    "actor_role": "system",
                    "actor_name": "系统初始化",
                    "action": "初始化脱敏业务数据库",
                    "entity_type": "database",
                    "entity_id": "sqlite",
                    "detail": {"seed_version": seed.get("version", 0)},
                },
            )

    def read_state(self) -> dict[str, Any]:
        with self._lock, closing(self.connect()) as connection:
            row = connection.execute("SELECT data_json FROM app_snapshot WHERE id = 1").fetchone()
        if not row:
            raise RuntimeError("database is not initialized")
        state = json.loads(row["data_json"])
        if not isinstance(state, dict):
            raise RuntimeError("database state is invalid")
        return state

    def replace_state(self, state: dict[str, Any], audit: dict[str, Any] | None = None) -> None:
        if not isinstance(state, dict) or not isinstance(state.get("residents"), list):
            raise ValueError("state must contain residents")
        timestamp = now_iso()
        accounts = state.get("accounts") if isinstance(state.get("accounts"), dict) else {}
        institutions = state.get("institutions") if isinstance(state.get("institutions"), list) else []
        residents = state.get("residents") if isinstance(state.get("residents"), list) else []
        movements = state.get("movementLogs") if isinstance(state.get("movementLogs"), list) else []
        services = state.get("serviceLogs") if isinstance(state.get("serviceLogs"), list) else []
        events = state.get("events") if isinstance(state.get("events"), list) else []
        profile = state.get("profile") if isinstance(state.get("profile"), dict) else {}
        primary_institution_id = next(
            (text(item.get("id")) for item in institutions if item.get("name") == profile.get("institution")),
            text(institutions[0].get("id")) if institutions else "",
        )

        with self._lock, closing(self.connect()) as connection:
            connection.execute("BEGIN IMMEDIATE")
            connection.execute(
                """INSERT INTO app_snapshot(id, version, data_json, updated_at)
                   VALUES(1, ?, ?, ?)
                   ON CONFLICT(id) DO UPDATE SET version=excluded.version,
                     data_json=excluded.data_json, updated_at=excluded.updated_at""",
                (int(state.get("version", 0)), json_text(state), timestamp),
            )

            for table in (
                "event_timeline",
                "risk_events",
                "service_records",
                "movement_records",
                "stays",
                "consents",
                "residents",
                "users",
                "institutions",
            ):
                connection.execute(f"DELETE FROM {table}")

            for item in institutions:
                connection.execute(
                    """INSERT INTO institutions VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (
                        text(item.get("id")),
                        text(item.get("name")),
                        text(item.get("city")),
                        int(number(item.get("residents"))),
                        int(number(item.get("alerts"))),
                        text(item.get("response")),
                        number(item.get("closure")),
                        number(item.get("score")),
                        text(item.get("status"), "正常"),
                        json_text(item),
                        timestamp,
                    ),
                )

            for role, item in accounts.items():
                password = text(item.get("password"))
                connection.execute(
                    """INSERT INTO users(role, account, password_hash, display_name, organization, avatar, updated_at)
                       VALUES(?, ?, ?, ?, ?, ?, ?)""",
                    (
                        text(role),
                        text(item.get("account")),
                        hashlib.sha256(password.encode("utf-8")).hexdigest(),
                        text(item.get("name")),
                        text(item.get("org")),
                        text(item.get("avatar")),
                        timestamp,
                    ),
                )

            for item in residents:
                connection.execute(
                    """INSERT INTO residents(id, name, age, source_region, room, check_in, risk_level,
                       freshness, status, screening_json, payload_json, updated_at)
                       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (
                        text(item.get("id")),
                        text(item.get("name")),
                        int(number(item.get("age"))),
                        text(item.get("source")),
                        text(item.get("room")),
                        text(item.get("checkIn")),
                        text(item.get("risk"), "low"),
                        text(item.get("fresh")),
                        text(item.get("status"), "在住"),
                        json_text(item.get("screening")) if item.get("screening") is not None else None,
                        json_text(item),
                        timestamp,
                    ),
                )
                connection.execute(
                    """INSERT INTO stays(id, resident_id, institution_id, city, room, start_date,
                       end_date, status, source, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (
                        f"STAY-{text(item.get('id'))}",
                        text(item.get("id")),
                        primary_institution_id or None,
                        text(profile.get("stayCity"), "北海市"),
                        text(item.get("room")),
                        text(item.get("checkIn")),
                        text(profile.get("stayRange")) if item.get("id") == profile.get("id") else "",
                        text(item.get("status"), "在住"),
                        "智能建档",
                        timestamp,
                    ),
                )

            for key, granted in (profile.get("consents") or {}).items():
                if profile.get("id"):
                    connection.execute(
                        "INSERT INTO consents(resident_id, consent_type, granted, updated_at) VALUES(?, ?, ?, ?)",
                        (text(profile.get("id")), text(key), 1 if granted else 0, timestamp),
                    )

            for item in movements:
                connection.execute(
                    """INSERT INTO movement_records(id, resident_id, movement_type, movement_status,
                       risk_level, destination, reason, depart_at, expected_return, actual_return,
                       responsible_person, responsible_phone, companion, source, institution_status,
                       regulator_status, confirmed_by, confirmed_at, linked_event_id, payload_json, updated_at)
                       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (
                        text(item.get("id")), text(item.get("residentId")), text(item.get("type")),
                        text(item.get("status")), text(item.get("risk")), text(item.get("destination")),
                        text(item.get("reason")), text(item.get("departAt")), text(item.get("expectedReturn")),
                        text(item.get("actualReturn")), text(item.get("responsible")),
                        text(item.get("responsiblePhone")), text(item.get("companion")), text(item.get("source")),
                        text(item.get("institutionStatus")), text(item.get("regulatorStatus")),
                        text(item.get("confirmedBy")), text(item.get("confirmedAt")), text(item.get("eventId")),
                        json_text(item), timestamp,
                    ),
                )

            for item in services:
                connection.execute(
                    """INSERT INTO service_records(id, resident_id, service_type, staff, service_time,
                       result, status, payload_json, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (
                        text(item.get("id")), text(item.get("residentId")), text(item.get("type")),
                        text(item.get("staff")), text(item.get("time")), text(item.get("result")),
                        text(item.get("status")), json_text(item), timestamp,
                    ),
                )

            for item in events:
                connection.execute(
                    """INSERT INTO risk_events(id, resident_id, risk_level, category, title, source,
                       location, event_time, status, owner, deadline, summary, recommended_action,
                       payload_json, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (
                        text(item.get("id")), text(item.get("residentId")), text(item.get("level")),
                        text(item.get("category")), text(item.get("title")), text(item.get("source")),
                        text(item.get("location")), text(item.get("time")), text(item.get("status")),
                        text(item.get("owner")), text(item.get("deadline")), text(item.get("summary")),
                        text(item.get("action")), json_text(item), timestamp,
                    ),
                )
                for sequence, timeline_item in enumerate(item.get("timeline") or [], start=1):
                    connection.execute(
                        """INSERT INTO event_timeline(event_id, sequence_no, event_time, content, state)
                           VALUES(?, ?, ?, ?, ?)""",
                        (
                            text(item.get("id")), sequence, text(timeline_item.get("time")),
                            text(timeline_item.get("text")), text(timeline_item.get("state")),
                        ),
                    )

            audit_data = audit or {}
            connection.execute(
                """INSERT INTO audit_logs(occurred_at, actor_role, actor_name, action,
                   entity_type, entity_id, detail_json) VALUES(?, ?, ?, ?, ?, ?, ?)""",
                (
                    timestamp,
                    text(audit_data.get("actor_role"), "system"),
                    text(audit_data.get("actor_name"), "系统"),
                    text(audit_data.get("action"), "同步业务状态"),
                    text(audit_data.get("entity_type"), "state"),
                    text(audit_data.get("entity_id")),
                    json_text(audit_data.get("detail") or {}),
                ),
            )
            connection.commit()

    def status(self) -> dict[str, Any]:
        tables = {
            "users": "用户角色",
            "residents": "老人档案",
            "stays": "旅居记录",
            "movement_records": "动向记录",
            "service_records": "服务记录",
            "risk_events": "风险事件",
            "event_timeline": "处置节点",
            "consents": "授权记录",
            "audit_logs": "审计日志",
        }
        with self._lock, closing(self.connect()) as connection:
            counts = {
                key: {
                    "label": label,
                    "count": connection.execute(f"SELECT COUNT(*) FROM {key}").fetchone()[0],
                }
                for key, label in tables.items()
            }
            snapshot = connection.execute("SELECT version, updated_at FROM app_snapshot WHERE id = 1").fetchone()
        return {
            "engine": "SQLite",
            "schema_version": 1,
            "state_version": snapshot["version"] if snapshot else 0,
            "updated_at": snapshot["updated_at"] if snapshot else "",
            "counts": counts,
            "file": self.path.name,
        }

    def audit_logs(self, limit: int = 20) -> list[dict[str, Any]]:
        safe_limit = max(1, min(int(limit), 100))
        with self._lock, closing(self.connect()) as connection:
            rows = connection.execute(
                """SELECT id, occurred_at, actor_role, actor_name, action,
                   entity_type, entity_id, detail_json
                   FROM audit_logs ORDER BY id DESC LIMIT ?""",
                (safe_limit,),
            ).fetchall()
        return [
            {
                "id": row["id"],
                "occurred_at": row["occurred_at"],
                "actor_role": row["actor_role"],
                "actor_name": row["actor_name"],
                "action": row["action"],
                "entity_type": row["entity_type"],
                "entity_id": row["entity_id"],
                "detail": json.loads(row["detail_json"] or "{}"),
            }
            for row in rows
        ]
