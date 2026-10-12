"""SQLite persistence for the local full-service build."""

from __future__ import annotations

import copy
import hashlib
import hmac
import json
import os
import re
import secrets
import sqlite3
import threading
from contextlib import closing
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any, Callable


ROOT = Path(__file__).resolve().parent
DEFAULT_DB_PATH = ROOT / "runtime" / "guiyang_elders.db"
SCHEMA_PATH = ROOT / "database_schema.sql"
SEED_PATH = ROOT / "seed.json"

# 演示口令（2.0）：启动脚本与登录页提示都写着「密码 123456」，此前的实现却随机生成
# 一串 token_urlsafe(12)，只有打开 runtime/demo_credentials.json 才能看到——评审者第一次
# 登录必然失败。现在默认口令与提示一致，仍可用环境变量 GUIYANG_PASSWORD_<ROLE> 覆盖，
# 覆盖值同样会写回 runtime/demo_credentials.json。
DEMO_PASSWORD = "123456"


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


# 演示样本按“锚定日”编写（seed.json 的 anchorDate）。导入数据库或重置演示数据时，把样本里的日期整体平移到当天：
# “今日 09:24”仍是今天 09:24，事件的创建、截止、办结时间换成服务器毫秒时间，打卡记录落在最近几天。
SEED_TIME_FIELDS = ("createdAt", "dueAt", "closedAt", "statusChangedAt")
MONTH_DAY = re.compile(r"(?<![\d.\-])(\d{2})-(\d{2})(?= \d{2}:\d{2})")  # 不匹配完整日期“2026-08-10 09:24”的后半段，避免平移两次
FULL_DATE = re.compile(r"(?<!\d)(\d{4})([-.])(\d{2})\2(\d{2})(?!\d)")


def _shift_text(value: Any, days: int, year: int) -> Any:
    if not isinstance(value, str) or not days:
        return value

    def month_day(match: re.Match[str]) -> str:
        try:
            moved = date(year, int(match.group(1)), int(match.group(2))) + timedelta(days=days)
        except ValueError:
            return match.group(0)
        return moved.strftime("%m-%d")

    def full(match: re.Match[str]) -> str:
        try:
            moved = date(int(match.group(1)), int(match.group(3)), int(match.group(4))) + timedelta(days=days)
        except ValueError:
            return match.group(0)
        sep = match.group(2)
        return moved.strftime(f"%Y{sep}%m{sep}%d")

    return FULL_DATE.sub(full, MONTH_DAY.sub(month_day, value))


def _shift_moment(value: Any, days: int) -> Any:
    if isinstance(value, str) and value.strip():
        try:
            moment = datetime.fromisoformat(value.strip())
        except ValueError:
            return value
        return int((moment + timedelta(days=days)).timestamp() * 1000)
    return value


def anchor_seed(seed: dict[str, Any], today: date | None = None) -> dict[str, Any]:
    """把演示样本平移到今天；没有 anchorDate 的旧样本原样返回。"""
    anchor = seed.get("anchorDate")
    if not anchor:
        return seed
    try:
        origin = date.fromisoformat(str(anchor))
    except ValueError:
        return seed
    today = today or datetime.now().date()
    days = (today - origin).days
    year = origin.year
    data = copy.deepcopy(seed)
    shift = lambda value: _shift_text(value, days, year)  # noqa: E731
    for event in data.get("events", []):
        for field in SEED_TIME_FIELDS:
            if field in event:
                event[field] = _shift_moment(event[field], days)
        event["time"] = shift(event.get("time"))
        for item in event.get("timeline") or []:
            item["time"] = shift(item.get("time"))
        evidence = event.get("evidence") if isinstance(event.get("evidence"), dict) else None
        if evidence:
            evidence["confirmedAt"] = shift(evidence.get("confirmedAt"))
            for quote in evidence.get("quotes") or []:
                quote["time"] = shift(quote.get("time"))
    for log in data.get("movementLogs", []):
        for field in ("departAt", "expectedReturn", "actualReturn"):
            log[field] = shift(log.get(field))
        if log.get("expectedReturnAt"):
            log["expectedReturnAt"] = shift(log["expectedReturnAt"].replace("T", " ")).replace(" ", "T")
        for item in log.get("timeline") or []:
            item["time"] = shift(item.get("time"))
    for log in data.get("serviceLogs", []):
        log["time"] = shift(log.get("time"))
    for resident in data.get("residents", []):
        if re.fullmatch(r"\d{2}-\d{2}", str(resident.get("checkIn") or "")):
            resident["checkIn"] = shift(f"{resident['checkIn']} 00:00")[:5]
    profile = data.get("profile") or {}
    profile["stayRange"] = shift(profile.get("stayRange"))
    for check in data.get("dailyChecks", []):
        check["date"] = shift(check.get("date"))
    for session in data.get("sosSessions", []):
        for field in ("createdLabel", "resolvedLabel"):
            session[field] = shift(session.get(field))
    data["anchoredAt"] = today.isoformat()
    return data


def load_seed(today: date | None = None) -> dict[str, Any]:
    return anchor_seed(json.loads(SEED_PATH.read_text(encoding="utf-8")), today)


def _ms_or_none(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)) and value > 0:
        return int(value)
    return None


class BusinessDatabase:
    def __init__(self, path: Path | None = None) -> None:
        configured = os.environ.get("GUIYANG_DB_PATH", "").strip()
        # 显式传入的路径优先（测试用临时库），其次是环境变量，最后才是默认的演示数据库；
        # 这样设置了 GUIYANG_DB_PATH 跑 e2e 时，单元测试也不会改到那个库
        self.path = Path(path) if path else Path(configured).expanduser() if configured else DEFAULT_DB_PATH
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
        if not SCHEMA_PATH.is_file():
            raise RuntimeError("缺少 database_schema.sql，无法启动；请使用完整源码包")
        schema = SCHEMA_PATH.read_text(encoding="utf-8")
        with self._lock, closing(self.connect()) as connection:
            # Add legacy columns before CREATE INDEX statements touch those columns.
            self._migrate(connection, verify=False)
            connection.executescript(schema)
            self._migrate(connection)
            exists = connection.execute("SELECT version FROM app_snapshot WHERE id = 1").fetchone()
        seed_version = json.loads(SEED_PATH.read_text(encoding="utf-8")).get("version", 0)
        # 演示样本升级（如新增类案样本）时，旧的本地演示库自动换成新样本；呼救工单另表保存，不受影响。
        if not exists or int(exists["version"] or 0) < int(seed_version or 0):
            if exists:
                self.backup(f"before_v{seed_version}")  # 换成新样本前先留一份旧库，演示时留下的记录可以找回
            seed = load_seed()
            # 样本升级时呼救台账一并换成新样本（旧库已完整备份）：避免旧样本工单与新样本重复，
            # 也避免旧库里没处理完的演示工单被后台值守当作超时工单立即升级
            self.replace_state(
                seed,
                {
                    "actor_role": "system",
                    "actor_name": "系统初始化",
                    "action": "初始化脱敏业务数据库" if not exists else f"演示样本升级到第 {seed.get('version', 0)} 版（旧库已备份）",
                    "entity_type": "database",
                    "entity_id": "sqlite",
                    "detail": {"seed_version": seed.get("version", 0)},
                },
                reset=bool(exists),
            )
        with self._lock, closing(self.connect()) as connection:
            row = connection.execute("SELECT data_json FROM app_snapshot WHERE id=1").fetchone()
            if row:
                state = json.loads(row["data_json"])
                if any(isinstance(item, dict) and "password" in item for item in (state.get("accounts") or {}).values()):
                    for item in state["accounts"].values(): item.pop("password", None)
                    connection.execute("UPDATE app_snapshot SET data_json=? WHERE id=1", (json_text(state),))
                    connection.commit()
        self.bootstrap_users()

    def backup(self, label: str) -> Path:
        """用 SQLite 在线备份把当前库完整复制到同目录的 backups/ 下。"""
        target = self.path.parent / "backups" / f"{self.path.stem}_{label}_{datetime.now().strftime('%Y%m%d_%H%M%S')}.sqlite"
        target.parent.mkdir(parents=True, exist_ok=True)
        with closing(self.connect()) as source, closing(sqlite3.connect(target)) as copy:
            source.backup(copy)
        return target

    @staticmethod
    def _migrate(connection: sqlite3.Connection, verify: bool = True) -> None:
        """Additive migrations so an older runtime database keeps working."""
        movement_columns = {row["name"] for row in connection.execute("PRAGMA table_info(movement_records)")}
        if movement_columns and "expected_return_at" not in movement_columns:
            connection.execute("ALTER TABLE movement_records ADD COLUMN expected_return_at TEXT NOT NULL DEFAULT ''")
        columns = {row["name"] for row in connection.execute("PRAGMA table_info(sos_sessions)")}
        if columns and "updated_at_ms" not in columns:
            connection.execute("ALTER TABLE sos_sessions ADD COLUMN updated_at_ms INTEGER NOT NULL DEFAULT 0")
        event_columns = {row["name"] for row in connection.execute("PRAGMA table_info(risk_events)")}
        for column in ("created_at_ms", "due_at_ms", "closed_at_ms"):
            if event_columns and column not in event_columns:
                connection.execute(f"ALTER TABLE risk_events ADD COLUMN {column} INTEGER")
        expected = {"app_snapshot", "institutions", "users", "residents", "stays", "consents", "movement_records", "service_records", "risk_events", "event_timeline", "audit_logs", "sos_sessions", "sos_revision", "state_revision"}
        found = {row["name"] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        if verify and expected - found:
            raise RuntimeError(f"数据库缺少必要表：{', '.join(sorted(expected - found))}")
        connection.commit()

    def bootstrap_users(self) -> None:
        """Install the demo credentials; never ship passwords in static assets.

        2.0 change: the fallback is the documented demo password (123456) instead of a
        random token, so the password printed by the launchers and hinted on the login
        screen actually works on a fresh install. GUIYANG_PASSWORD_<ROLE> still wins.
        """
        credential_file = self.path.parent / "demo_credentials.json"
        with self._lock, closing(self.connect()) as connection:
            rows = connection.execute("SELECT role, password_hash FROM users").fetchall()
            existing = {row["role"]: row["password_hash"] for row in rows}
            needs = [role for role in ("elder", "provider", "regulator") if not existing.get(role, "").startswith("pbkdf2$")]
            if not needs:
                return
            saved = {}
            if credential_file.exists():
                try:
                    saved = json.loads(credential_file.read_text(encoding="utf-8"))
                except (OSError, ValueError):
                    saved = {}
            accounts = {"elder": "elder", "provider": "center", "regulator": "admin"}
            public = json.loads(SEED_PATH.read_text(encoding="utf-8"))["accounts"]
            for role in needs:
                override = os.environ.get(f"GUIYANG_PASSWORD_{role.upper()}")
                password = override or saved.get(role) or DEMO_PASSWORD
                saved[role] = password
                salt = secrets.token_bytes(16)
                digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, 260000)
                stored = f"pbkdf2$260000${salt.hex()}${digest.hex()}"
                account = public[role]
                connection.execute("INSERT INTO users(role,account,password_hash,display_name,organization,avatar,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(role) DO UPDATE SET password_hash=excluded.password_hash", (role, accounts[role], stored, account["name"], account["org"], account["avatar"], now_iso()))
            connection.commit()
            credential_file.write_text(json.dumps(saved, ensure_ascii=False, indent=2), encoding="utf-8")
            os.chmod(credential_file, 0o600)

    def authenticate(self, role: str, account: str, password: str) -> dict[str, str] | None:
        with self._lock, closing(self.connect()) as connection:
            row = connection.execute("SELECT role,account,password_hash,display_name,organization FROM users WHERE role=? AND account=?", (role, account)).fetchone()
        if row is None:
            return None
        try:
            kind, rounds, salt, digest = row["password_hash"].split("$")
            valid = kind == "pbkdf2" and hmac.compare_digest(hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt), int(rounds)), bytes.fromhex(digest))
        except (ValueError, TypeError):
            valid = False
        # 登录会话绑定账号所属机构：机构端的读写范围以它为准，而不是请求里带来的字段
        return {"role": role, "name": row["display_name"], "account": row["account"], "org": row["organization"] or ""} if valid else None

    def reset_to_seed(self, actor: str = "系统", today: date | None = None) -> None:
        """恢复演示初始数据（日期平移到今天），呼救工单一并清空。"""
        self.replace_state(load_seed(today), {"actor_role": "system", "actor_name": actor, "action": "恢复演示初始数据", "entity_type": "database", "entity_id": "seed"}, reset=True)

    @staticmethod
    def _sos_row(item: dict[str, Any], timestamp: str) -> tuple[Any, ...]:
        callback = item.get("callback") if isinstance(item.get("callback"), dict) else {}
        return (
            text(item.get("id")), text(item.get("residentId")), text(item.get("resident")),
            text(item.get("trigger")), text(item.get("riskLevel"), "high"),
            text(item.get("status")), int(number(item.get("escalation")) or 1),
            text(callback.get("status")), int(number(callback.get("attempts"))),
            text(item.get("claimedBy")),
            number(item.get("responseSeconds")) if item.get("responseSeconds") is not None else None,
            text(item.get("linkedEventId")), text(item.get("createdLabel")),
            text(item.get("resolvedLabel")), json_text(item), timestamp,
            int(number(item.get("updatedAtMs"))),
        )

    @staticmethod
    def _upsert_sos(connection: sqlite3.Connection, item: dict[str, Any], timestamp: str) -> bool:
        """Insert or update one emergency ticket. Older payloads never overwrite newer ones."""
        session_id = text(item.get("id"))
        if not session_id:
            return False
        existing = connection.execute(
            "SELECT updated_at_ms FROM sos_sessions WHERE id = ?", (session_id,)
        ).fetchone()
        incoming_ms = int(number(item.get("updatedAtMs")))
        if existing and incoming_ms and int(existing["updated_at_ms"]) > incoming_ms:
            return False
        connection.execute(
            """INSERT INTO sos_sessions(id, resident_id, resident_name, trigger_source,
               risk_level, status, escalation, callback_status, callback_attempts,
               claimed_by, response_seconds, linked_event_id, created_label,
               resolved_label, payload_json, updated_at, updated_at_ms)
               VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(id) DO UPDATE SET
                 resident_id = excluded.resident_id,
                 resident_name = excluded.resident_name,
                 trigger_source = excluded.trigger_source,
                 risk_level = excluded.risk_level,
                 status = excluded.status,
                 escalation = excluded.escalation,
                 callback_status = excluded.callback_status,
                 callback_attempts = excluded.callback_attempts,
                 claimed_by = excluded.claimed_by,
                 response_seconds = excluded.response_seconds,
                 linked_event_id = excluded.linked_event_id,
                 created_label = excluded.created_label,
                 resolved_label = excluded.resolved_label,
                 payload_json = excluded.payload_json,
                 updated_at = excluded.updated_at,
                 updated_at_ms = excluded.updated_at_ms""",
            BusinessDatabase._sos_row(item, timestamp),
        )
        return True

    @staticmethod
    def _bump_revision(connection: sqlite3.Connection, timestamp: str) -> int:
        connection.execute(
            """INSERT INTO sos_revision(id, revision, updated_at) VALUES(1, 1, ?)
               ON CONFLICT(id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at""",
            (timestamp,),
        )
        row = connection.execute("SELECT revision FROM sos_revision WHERE id = 1").fetchone()
        return int(row["revision"]) if row else 0

    @staticmethod
    def _read_sos(connection: sqlite3.Connection) -> list[dict[str, Any]]:
        rows = connection.execute(
            "SELECT payload_json FROM sos_sessions ORDER BY updated_at_ms DESC, id DESC"
        ).fetchall()
        sessions: list[dict[str, Any]] = []
        for row in rows:
            try:
                payload = json.loads(row["payload_json"])
            except json.JSONDecodeError:
                continue
            if isinstance(payload, dict):
                sessions.append(payload)
        return sessions

    def sos_snapshot(self) -> dict[str, Any]:
        """Emergency ledger plus its revision counter, for lightweight polling."""
        with self._lock, closing(self.connect()) as connection:
            row = connection.execute("SELECT revision FROM sos_revision WHERE id = 1").fetchone()
            return {
                "revision": int(row["revision"]) if row else 0,
                "sessions": self._read_sos(connection),
            }

    def upsert_sos_session(self, session: dict[str, Any], audit: dict[str, Any] | None = None) -> dict[str, Any]:
        """Write a single emergency ticket without touching the rest of the snapshot."""
        if not isinstance(session, dict) or not text(session.get("id")):
            raise ValueError("invalid_sos_session")
        timestamp = now_iso()
        with self._lock, closing(self.connect()) as connection:
            connection.execute("BEGIN IMMEDIATE")
            applied = self._upsert_sos(connection, session, timestamp)
            revision = self._bump_revision(connection, timestamp)
            snapshot_row = connection.execute("SELECT data_json FROM app_snapshot WHERE id = 1").fetchone()
            if snapshot_row:
                try:
                    snapshot = json.loads(snapshot_row["data_json"])
                except json.JSONDecodeError:
                    snapshot = None
                if isinstance(snapshot, dict):
                    snapshot["sosSessions"] = self._read_sos(connection)
                    connection.execute(
                        "UPDATE app_snapshot SET data_json = ?, updated_at = ? WHERE id = 1",
                        (json_text(snapshot), timestamp),
                    )
            audit_data = audit or {}
            connection.execute(
                """INSERT INTO audit_logs(occurred_at, actor_role, actor_name, action,
                   entity_type, entity_id, detail_json) VALUES(?, ?, ?, ?, ?, ?, ?)""",
                (
                    timestamp,
                    text(audit_data.get("actor_role"), "system"),
                    text(audit_data.get("actor_name"), "系统"),
                    text(audit_data.get("action"), "更新应急呼救工单"),
                    text(audit_data.get("entity_type"), "sos_session"),
                    text(audit_data.get("entity_id"), text(session.get("id"))),
                    json_text(audit_data.get("detail") or {"status": text(session.get("status"))}),
                ),
            )
            sessions = self._read_sos(connection)
            connection.commit()
        return {"applied": applied, "revision": revision, "sessions": sessions}

    def read_state(self) -> dict[str, Any]:
        with self._lock, closing(self.connect()) as connection:
            row = connection.execute("SELECT data_json FROM app_snapshot WHERE id = 1").fetchone()
        if not row:
            raise RuntimeError("database is not initialized")
        state = json.loads(row["data_json"])
        if not isinstance(state, dict):
            raise RuntimeError("database state is invalid")
        with self._lock, closing(self.connect()) as connection:
            state["sosSessions"] = self._read_sos(connection)
        return state

    def state_revision(self) -> int:
        with self._lock, closing(self.connect()) as connection:
            row = connection.execute("SELECT revision FROM state_revision WHERE id=1").fetchone()
            return int(row["revision"]) if row else 0

    @staticmethod
    def _insert_audit(connection: sqlite3.Connection, timestamp: str, audit: dict[str, Any] | None, default_action: str = "同步业务状态", default_type: str = "state") -> None:
        audit_data = audit or {}
        connection.execute(
            """INSERT INTO audit_logs(occurred_at, actor_role, actor_name, action,
               entity_type, entity_id, detail_json) VALUES(?, ?, ?, ?, ?, ?, ?)""",
            (
                timestamp,
                text(audit_data.get("actor_role"), "system"),
                text(audit_data.get("actor_name"), "系统"),
                text(audit_data.get("action"), default_action),
                text(audit_data.get("entity_type"), default_type),
                text(audit_data.get("entity_id")),
                json_text(audit_data.get("detail") or {}),
            ),
        )

    def mutate(self, change: Callable[[dict[str, Any]], dict[str, Any]]) -> dict[str, Any]:
        """在一个写事务里读取当前状态和呼救台账，交给 change 修改，再整体写回。

        BEGIN IMMEDIATE 先拿到写锁再读取：同一进程内有 RLock，多个服务进程之间由 SQLite 写锁串行，
        所以后台扫描读到的一定是最新状态，已经推进过的记录不会被第二个扫描者重复处理。
        change 返回 {"state_changed": bool, "sessions": [变化的呼救工单], "audits": [审计记录]}。
        """
        with self._lock, closing(self.connect()) as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute("SELECT data_json FROM app_snapshot WHERE id = 1").fetchone()
            if not row:
                connection.rollback()
                return {"state_changed": False, "sessions": [], "audits": []}
            state = json.loads(row["data_json"])
            state["sosSessions"] = self._read_sos(connection)
            result = change(state) or {}
            sessions = [item for item in result.get("sessions") or [] if isinstance(item, dict)]
            if not result.get("state_changed") and not sessions:
                connection.rollback()
                return {"state_changed": False, "sessions": [], "audits": []}
            timestamp = now_iso()
            for session in sessions:
                self._upsert_sos(connection, session, timestamp)
            if sessions:
                self._bump_revision(connection, timestamp)
            if result.get("state_changed"):
                self._write_state(connection, state, timestamp)
            else:
                snapshot = json.loads(row["data_json"])
                snapshot["sosSessions"] = self._read_sos(connection)
                connection.execute("UPDATE app_snapshot SET data_json = ?, updated_at = ? WHERE id = 1", (json_text(snapshot), timestamp))
            for audit in result.get("audits") or []:
                self._insert_audit(connection, timestamp, audit, "后台值守推进")
            connection.commit()
        return {**result, "sessions": sessions}

    def replace_state(self, state: dict[str, Any], audit: dict[str, Any] | None = None, reset: bool = False) -> None:
        if not isinstance(state, dict) or not isinstance(state.get("residents"), list):
            raise ValueError("state must contain residents")
        timestamp = now_iso()
        with self._lock, closing(self.connect()) as connection:
            connection.execute("BEGIN IMMEDIATE")
            if reset:
                connection.execute("DELETE FROM sos_sessions")
            self._write_state(connection, state, timestamp)
            self._insert_audit(connection, timestamp, audit)
            connection.commit()

    def _write_state(self, connection: sqlite3.Connection, state: dict[str, Any], timestamp: str) -> None:
        """在调用方的事务里写入整份状态和规范化表（调用方负责 BEGIN / COMMIT）。"""
        if not isinstance(state, dict) or not isinstance(state.get("residents"), list):
            raise ValueError("state must contain residents")
        accounts = state.get("accounts") if isinstance(state.get("accounts"), dict) else {}
        institutions = state.get("institutions") if isinstance(state.get("institutions"), list) else []
        residents = state.get("residents") if isinstance(state.get("residents"), list) else []
        movements = state.get("movementLogs") if isinstance(state.get("movementLogs"), list) else []
        services = state.get("serviceLogs") if isinstance(state.get("serviceLogs"), list) else []
        events = state.get("events") if isinstance(state.get("events"), list) else []
        sos_sessions = state.get("sosSessions") if isinstance(state.get("sosSessions"), list) else []
        profile = state.get("profile") if isinstance(state.get("profile"), dict) else {}
        primary_institution_id = next(
            (text(item.get("id")) for item in institutions if item.get("name") == profile.get("institution")),
            text(institutions[0].get("id")) if institutions else "",
        )
        institution_ids = {item.get("name"): text(item.get("id")) for item in institutions}
        institution_cities = {item.get("name"): text(item.get("city")) for item in institutions}

        connection.execute(
            """INSERT INTO app_snapshot(id, version, data_json, updated_at)
               VALUES(1, ?, ?, ?)
               ON CONFLICT(id) DO UPDATE SET version=excluded.version,
                 data_json=excluded.data_json, updated_at=excluded.updated_at""",
            (int(state.get("version", 0)), json_text(state), timestamp),
        )
        connection.execute("INSERT INTO state_revision(id,revision) VALUES(1,1) ON CONFLICT(id) DO UPDATE SET revision=revision+1")

        for table in (
            "event_timeline",
            "risk_events",
            "service_records",
            "movement_records",
            "stays",
            "consents",
            "residents",
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
                    institution_ids.get(item.get("institution"), primary_institution_id) or None,
                    institution_cities.get(item.get("institution")) or text(profile.get("stayCity"), "北海市"),
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
                   risk_level, destination, reason, depart_at, expected_return, expected_return_at, actual_return,
                   responsible_person, responsible_phone, companion, source, institution_status,
                   regulator_status, confirmed_by, confirmed_at, linked_event_id, payload_json, updated_at)
                   VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    text(item.get("id")), text(item.get("residentId")), text(item.get("type")),
                    text(item.get("status")), text(item.get("risk")), text(item.get("destination")),
                    text(item.get("reason")), text(item.get("departAt")), text(item.get("expectedReturn")),
                    text(item.get("expectedReturnAt")),
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
                   payload_json, updated_at, created_at_ms, due_at_ms, closed_at_ms)
                   VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    text(item.get("id")), text(item.get("residentId")), text(item.get("level")),
                    text(item.get("category")), text(item.get("title")), text(item.get("source")),
                    text(item.get("location")), text(item.get("time")), text(item.get("status")),
                    text(item.get("owner")), text(item.get("deadline")), text(item.get("summary")),
                    text(item.get("action")), json_text(item), timestamp,
                    _ms_or_none(item.get("createdAt")), _ms_or_none(item.get("dueAt")), _ms_or_none(item.get("closedAt")),
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

        for item in sos_sessions:
            if isinstance(item, dict):
                self._upsert_sos(connection, item, timestamp)
        self._bump_revision(connection, timestamp)

    def status(self) -> dict[str, Any]:
        tables = {
            "users": "用户角色",
            "residents": "老人档案",
            "stays": "旅居记录",
            "movement_records": "动向记录",
            "service_records": "服务记录",
            "risk_events": "风险事件",
            "sos_sessions": "应急呼救",
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
            schema_row = connection.execute(
                "SELECT value FROM schema_meta WHERE key = 'schema_version'"
            ).fetchone()
            try:
                schema_version = int(schema_row["value"]) if schema_row else 1
            except (TypeError, ValueError):
                schema_version = 1
        return {
            "engine": "SQLite",
            "schema_version": schema_version,
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
