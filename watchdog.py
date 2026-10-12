"""服务器后台值守：超时扫描、状态推进和升级都在服务端完成，页面只负责显示。

页面关闭、电脑休眠或浏览器限制后台计时器时，呼救升级、外出超时未归和报平安超时仍会按服务器时间推进；
服务重启后第一次扫描会补上停机期间错过的推进。每次扫描在一个数据库写事务里“读取—判断—写回”，
状态已经推进过的记录不会再处理，同一件事不会重复生成工单。
"""
from __future__ import annotations

import re
import secrets
import threading
import time
from datetime import datetime
from typing import Any, Callable

import sla
import weather

SOS_RULES = {
    "dial_to_ring_seconds": 3,      # 模拟回拨：拨号后进入响铃
    "callback_ring_seconds": 25,    # 响铃超过该时长视为未接通
    "max_callback_attempts": 2,     # 自动回拨最多尝试次数
    "claim_sla_seconds": sla.SOS_CLAIM_SLA_SECONDS,  # L1 → L2：值班人员接单时限
    "regulator_escalate_seconds": 75,  # L2 → L3：升级监管端联动
}
ACTIVE_MOVEMENT = {"外出中", "就医中", "在途中"}
ACTOR = {"actor_role": "system", "actor_name": "后台值守"}


def clock(now_ms: int) -> str:
    return time.strftime("%H:%M:%S", time.localtime(now_ms / 1000))


def _push(timeline_owner: dict[str, Any], text: str, time_label: str, state_flag: str = "current") -> None:
    timeline = timeline_owner.setdefault("timeline", [])
    for item in timeline:
        if isinstance(item, dict) and item.get("state") == "current":
            item["state"] = "done"
    timeline.append({"time": time_label, "text": text, "state": state_flag})


def parse_local(value: Any) -> int | None:
    """外出报备的预计返回时间（datetime-local 字符串，本机时间）换成毫秒。"""
    text = str(value or "").strip()
    if not text:
        return None
    try:
        return int(datetime.fromisoformat(text).timestamp() * 1000)
    except ValueError:
        return sla.to_ms(value)


def _new_event_id(now_ms: int) -> str:
    return f"EV-{time.strftime('%Y%m%d', time.localtime(now_ms / 1000))}-S{secrets.token_hex(4).upper()}"


def sos_linked_event(state: dict[str, Any], session: dict[str, Any], now_ms: int) -> dict[str, Any]:
    """L3 升级时生成（或复用）监管端联动事件，与页面原有 ensureSosLinkedEvent 同结构。"""
    events = state.setdefault("events", [])
    existing = next((e for e in events if isinstance(e, dict) and e.get("id") == session.get("linkedEventId")), None) if session.get("linkedEventId") else None
    if existing:
        return existing
    trigger = str(session.get("trigger") or "")
    health = re.search(r"急症|健康|分流|跌倒|血压", trigger)
    home = re.search(r"燃气|烟感|烟雾", trigger)
    stamp = sla.label(now_ms)
    event = {
        "id": _new_event_id(now_ms), "residentId": session.get("residentId", ""), "resident": session.get("resident", ""),
        "level": "high", "category": "健康异常" if health else "居家安全" if home else "人身安全",
        "title": f"应急呼救联动：{trigger}"[:60], "source": "应急呼救升级", "location": session.get("location", ""),
        "time": stamp, "status": "处置中", "owner": "属地应急联络组", "deadline": "优先响应",
        "summary": f"{trigger}触发（{'原话：' + session['transcript'] if session.get('transcript') else '无语音转写'}），超时无人接单，平台升级为跨部门联动处置。"[:300],
        "action": "生成位置与最小照护摘要供监管人员核验；外部联动需授权人员确认。",
        "institution": session.get("institution", ""), "sosId": session.get("id", ""),
        "createdAt": now_ms, "dueAt": now_ms + sla.IMMEDIATE_MINUTES * 60_000, "statusChangedAt": now_ms,
        "timeline": [{"time": stamp, "text": f"呼救工单 {session.get('id', '')} 超时未接单，后台值守升级联动", "state": "done"},
                     {"time": stamp, "text": "属地应急联络组接收", "state": "current"}],
    }
    events.insert(0, event)
    session["linkedEventId"] = event["id"]
    return event


def advance_sos(state: dict[str, Any], session: dict[str, Any], now_ms: int) -> list[str]:
    """推进一张进行中的呼救工单，返回本次做了哪些动作（空列表表示没有变化）。"""
    if session.get("status") not in sla.SOS_ACTIVE:
        return []
    done: list[str] = []
    stamp = clock(now_ms)
    created = sla.to_ms(session.get("createdAt")) or now_ms
    callback = session.get("callback") if isinstance(session.get("callback"), dict) else None
    if callback is None:
        callback = session["callback"] = {"status": "dialing", "attempts": 1, "startedAt": created}
    started = sla.to_ms(callback.get("startedAt")) or created
    attempts = int(callback.get("attempts") or 1)
    if callback.get("status") == "dialing" and now_ms - started >= SOS_RULES["dial_to_ring_seconds"] * 1000:
        callback["status"] = "ringing"
        _push(session, f"模拟回拨已进入响铃阶段（第{attempts}次），等待接听", stamp)
        done.append("模拟回拨进入响铃")
    elif callback.get("status") == "ringing" and now_ms - started >= SOS_RULES["callback_ring_seconds"] * 1000:
        if attempts < SOS_RULES["max_callback_attempts"]:
            callback.update({"status": "dialing", "attempts": attempts + 1, "startedAt": now_ms})
            _push(session, f"第{attempts}次回拨未接通，自动发起第{attempts + 1}次回拨", stamp)
            done.append("模拟回拨重拨")
        else:
            callback["status"] = "no_answer"
            _push(session, f"{SOS_RULES['max_callback_attempts']}次自动回拨均未接通", stamp)
            done.append("模拟回拨未接通")
    if session.get("status") == "waiting":
        elapsed = (now_ms - created) / 1000
        level = int(session.get("escalation") or 1)
        notified = session.setdefault("notified", {})
        if (elapsed >= SOS_RULES["claim_sla_seconds"] or callback.get("status") == "no_answer") and level < 2:
            session["escalation"] = level = 2
            notified["manager"] = notified["family"] = True
            family = next((c for c in session.get("contacts", []) if isinstance(c, dict) and c.get("role") == "紧急联系人"), {})
            _push(session, f"后台值守：超{SOS_RULES['claim_sla_seconds']}秒未接单，已在站内生成机构负责人和紧急联系人通知提醒，电话需人工联系{family.get('name', '')}", stamp)
            done.append("超时未接单升级通知负责人与家属")
        if elapsed >= SOS_RULES["regulator_escalate_seconds"] and level < 3:
            session["escalation"] = 3
            notified["regulator"] = True
            sos_linked_event(state, session, now_ms)
            _push(session, "后台值守：超时未接单，已在监管端生成联动工单和最小档案摘要，外部调度由授权人员确认", stamp)
            done.append("超时未接单升级监管联动")
    if done:
        session["updatedAtMs"] = now_ms
    return done


def movement_event(log: dict[str, Any], now_ms: int) -> dict[str, Any]:
    stamp = sla.label(now_ms)
    responsible = log.get("responsible") or "机构责任人"
    route = log.get("routeAssessment") if isinstance(log.get("routeAssessment"), dict) else {}
    route_label = {"high": "高风险提示", "medium": "需关注", "low": "低风险提示"}.get(route.get("level"), "资料待核验")
    return {
        "id": _new_event_id(now_ms), "residentId": log.get("residentId", ""), "resident": log.get("resident", ""),
        "level": "high" if log.get("risk") == "high" else "medium", "category": "失联风险", "title": "旅居动向超时未归",
        "source": "动向台账规则（后台值守）", "location": log.get("destination", ""), "time": stamp, "status": "待复核",
        "owner": responsible, "deadline": "立即核验",
        "summary": f"{log.get('resident', '')}预计{log.get('expectedReturn', '')}返回，目前仍未完成返回核验。",
        "action": f"立即联系{responsible}核实位置；无法联系时按失联流程升级并报告最后已知地点。",
        "movementId": log.get("id", ""), "locationScope": "outside",
        "rationale": ["预计返回时间已过", f"最后记录地点：{log.get('destination', '')}；场所风险{route_label}（资料须复核）", f"责任人：{log.get('responsible') or '未填写'}"],
        "createdAt": now_ms, "dueAt": now_ms + sla.IMMEDIATE_MINUTES * 60_000, "statusChangedAt": now_ms,
        "timeline": [{"time": stamp, "text": "后台值守检测到预计返回时间已过，自动转入失联风险复核", "state": "current"}],
    }


def advance_movements(state: dict[str, Any], now_ms: int) -> list[tuple[str, str]]:
    changed = []
    for log in state.get("movementLogs", []):
        if not isinstance(log, dict) or log.get("status") not in ACTIVE_MOVEMENT:
            continue
        due = parse_local(log.get("expectedReturnAt"))
        if not due or due > now_ms:
            continue
        log["status"] = "超时未归"
        log["risk"] = "high" if log.get("risk") == "high" else "medium"
        _push(log, "后台值守：已过预计返回时间，自动标记为超时未归", sla.label(now_ms))
        if not log.get("eventId"):
            event = movement_event(log, now_ms)
            state.setdefault("events", []).insert(0, event)
            log["eventId"] = event["id"]
        notice_id = f"MO-{log.get('id', '')}"
        state["notifications"] = [{"id": notice_id, "audience": "staff", "residentId": log.get("residentId", ""), "title": "动向超时未归",
                                   "detail": f"{log.get('resident', '')}在{log.get('destination', '')}尚未完成返回核验", "time": sla.label(now_ms), "level": "danger", "read": False},
                                  *[n for n in state.get("notifications", []) if not (isinstance(n, dict) and n.get("id") == notice_id)]][:80]
        changed.append((str(log.get("id", "")), str(log.get("resident", ""))))
    return changed


def tick(state: dict[str, Any], now_ms: int | None = None) -> dict[str, Any]:
    """扫描一次。state 里需要带上 sosSessions；直接在 state 上修改，返回本次变化。"""
    now_ms = now_ms if now_ms is not None else sla.now_ms()
    audits: list[dict[str, Any]] = []
    sessions: list[dict[str, Any]] = []
    events_before = len(state.get("events", []))
    for session in state.get("sosSessions", []):
        if not isinstance(session, dict):
            continue
        actions = advance_sos(state, session, now_ms)
        if actions:
            sessions.append(session)
            audits.append({**ACTOR, "action": "；".join(actions), "entity_type": "sos_session", "entity_id": str(session.get("id", ""))})
    moved = advance_movements(state, now_ms)
    for movement_id, resident in moved:
        audits.append({**ACTOR, "action": f"{resident}超时未归，自动生成失联风险事件", "entity_type": "movement", "entity_id": movement_id})
    overdue = weather.advance_overdue(state, now_ms)
    if overdue:
        audits.append({**ACTOR, "action": f"{overdue}位老人超时未回应报平安，通知机构负责人站内跟进", "entity_type": "safety_checkin", "entity_id": "overdue"})
    state_changed = bool(moved or overdue or len(state.get("events", [])) != events_before)
    return {"state_changed": state_changed, "sessions": sessions, "audits": audits}


def run_once(database: Any, now_ms: int | None = None) -> dict[str, Any]:
    return database.mutate(lambda state: tick(state, now_ms))


class Watchdog:
    """后台线程：每秒扫描一次。启动时立即扫描，补上停机期间错过的推进。"""

    def __init__(self, database_getter: Callable[[], Any], interval: float = 1.0) -> None:
        self.database_getter = database_getter
        self.interval = interval
        self.stop_event = threading.Event()
        self.thread: threading.Thread | None = None
        self.last_error = ""
        self.last_run = 0.0

    def start(self) -> "Watchdog":
        if self.thread and self.thread.is_alive():
            return self
        self.thread = threading.Thread(target=self._loop, name="gy-watchdog", daemon=True)
        self.thread.start()
        return self

    def stop(self) -> None:
        self.stop_event.set()
        if self.thread:
            self.thread.join(timeout=3)

    def _loop(self) -> None:
        while not self.stop_event.is_set():
            try:
                run_once(self.database_getter())
                self.last_error = ""
            except Exception as error:  # 值守线程不能因为一次异常退出；下一轮继续
                self.last_error = f"{type(error).__name__}: {error}"[:200]
            self.last_run = time.time()
            self.stop_event.wait(self.interval)
