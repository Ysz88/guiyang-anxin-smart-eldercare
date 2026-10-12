"""事件处置时限：由服务器按创建时间和承诺时限计算，页面、监管参谋和态势研判共用。

- createdAt / dueAt / closedAt 都是服务器时间（毫秒）。dueAt 在事件创建时确定，之后更新备注、转派都不会重置。
- 承诺时限文字（如“2小时内反馈”“优先响应”“当天处理”）只用来在创建时推算 dueAt，并保留给老人看。
- “按时 / 超时”一律由 closedAt 与 dueAt 比较得出，不再写死文案。
"""
from __future__ import annotations

import re
import time
from datetime import datetime
from typing import Any

IMMEDIATE_MINUTES = 30
DEFAULT_MINUTES = {"high": 30, "medium": 120, "low": 24 * 60}
CLOSED = "已办结"
STATUSES = {"待复核", "处置中", "已转派", CLOSED}


def now_ms() -> int:
    return int(time.time() * 1000)


def to_ms(value: Any) -> int | None:
    """毫秒数或本地时间 ISO 字符串（种子数据）都换成毫秒；无法识别时返回 None。"""
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return int(value) if value > 0 else None
    if isinstance(value, str) and value.strip():
        text = value.strip()
        if text.isdigit():
            return int(text) or None
        try:
            parsed = datetime.fromisoformat(text)
        except ValueError:
            return None
        return int(parsed.timestamp() * 1000)
    return None


def minutes_from_label(label: Any, level: str = "medium") -> int | None:
    """把承诺时限文字换算成分钟；“当天处理”这类按当天结束计算，返回 None 由调用方处理。"""
    text = re.sub(r"\s+", "", str(label or ""))
    hours = re.search(r"(\d+)小时(?:(\d+)分)?", text)
    if hours:
        return int(hours.group(1)) * 60 + int(hours.group(2) or 0)
    minutes = re.search(r"(\d+)分钟", text)
    if minutes:
        return int(minutes.group(1))
    days = re.search(r"(\d+)个?(?:工作日|天)", text)
    if days:
        return int(days.group(1)) * 24 * 60  # 工作日按自然日近似，试点时接入工作日历
    if re.search(r"优先|马上|立即|立刻|尽快", text):
        return IMMEDIATE_MINUTES
    return DEFAULT_MINUTES.get(level, DEFAULT_MINUTES["medium"])


def due_ms(event: dict[str, Any], created: int) -> int:
    text = re.sub(r"\s+", "", str(event.get("deadline") or ""))
    if re.search(r"当天|今日内|今天内", text):
        end = datetime.fromtimestamp(created / 1000).replace(hour=23, minute=59, second=59, microsecond=0)
        return int(end.timestamp() * 1000)
    minutes = minutes_from_label(text, str(event.get("level") or "medium"))
    return created + int(minutes or DEFAULT_MINUTES["medium"]) * 60_000


def duration_text(ms: int) -> str:
    minutes = max(0, int(ms // 60_000))
    if minutes < 1:
        return "不到1分钟"
    if minutes < 60:
        return f"{minutes}分钟"
    hours, rest = divmod(minutes, 60)
    if hours < 24:
        return f"{hours}小时{rest}分" if rest else f"{hours}小时"
    days, hours = divmod(hours, 24)
    return f"{days}天{hours}小时" if hours else f"{days}天"


def status(event: dict[str, Any], now: int | None = None) -> dict[str, Any]:
    """返回 {state, text}：open_ok / open_overdue / closed_on_time / closed_late / legacy。"""
    now = now if now is not None else now_ms()
    due = to_ms(event.get("dueAt"))
    closed_at = to_ms(event.get("closedAt"))
    if event.get("status") == CLOSED:
        if due and closed_at:
            late = closed_at - due
            return {"state": "closed_late", "text": f"超时办结（超{duration_text(late)}）"} if late > 0 else {"state": "closed_on_time", "text": "按时办结"}
        return {"state": "legacy", "text": "已办结（无办结时间记录）"}
    if due:
        left = due - now
        return {"state": "open_ok", "text": f"剩余 {duration_text(left)}"} if left > 0 else {"state": "open_overdue", "text": f"已超时 {duration_text(-left)}"}
    return {"state": "legacy", "text": str(event.get("deadline") or "未设时限")}


def label(ms: int | None) -> str:
    """服务器写入的时间标签：月-日 时:分（不用“刚刚”“今日”这类会过时的字样）。"""
    if not ms:
        return ""
    return datetime.fromtimestamp(ms / 1000).strftime("%m-%d %H:%M")


# ---------------------------------------------------------------- 呼救接单考核口径
SOS_CLAIM_SLA_SECONDS = 30
SOS_ACTIVE = {"waiting", "claimed"}


def sos_outcome(session: dict[str, Any], now: int | None = None, sla_seconds: int = SOS_CLAIM_SLA_SECONDS) -> str:
    """一张呼救工单的接单考核结果。

    on_time 按时接单 / late 超时后才接单 / missed 超过时限仍无人接单（含超时后本人取消）
    pending 仍在时限内等待（未到考核时点） / excluded 时限内本人取消（误触，不计入考核） / unknown 缺少时间记录
    """
    now = now if now is not None else now_ms()
    response = session.get("responseSeconds")
    if isinstance(response, (int, float)) and not isinstance(response, bool):
        return "on_time" if response <= sla_seconds else "late"
    created = to_ms(session.get("createdAt"))
    limit = sla_seconds * 1000
    if session.get("status") in SOS_ACTIVE:
        if not created:
            return "unknown"
        return "missed" if now - created >= limit else "pending"
    closed = to_ms(session.get("closedAtMs")) or to_ms(session.get("updatedAtMs"))
    if session.get("status") == "cancelled":
        return "missed" if created and closed and closed - created >= limit else "excluded"
    if created and closed:
        return "on_time" if closed - created <= limit else "late"
    return "unknown"


def percent(part: int, whole: int) -> int | None:
    """百分比四舍五入到整数（与页面 Math.round 一致，0.5 进位）。"""
    return int(100 * part / whole + 0.5) if whole else None


def sos_summary(sessions: list[dict[str, Any]], now: int | None = None, sla_seconds: int = SOS_CLAIM_SLA_SECONDS) -> dict[str, Any]:
    """整体响应达标率的分母包含已到考核时点仍无人接单的工单，避免只统计接了单的“幸存者”。"""
    now = now if now is not None else now_ms()
    counts = {key: 0 for key in ("on_time", "late", "missed", "pending", "excluded", "unknown")}
    for item in sessions:
        if isinstance(item, dict):
            counts[sos_outcome(item, now, sla_seconds)] += 1
    responded = counts["on_time"] + counts["late"]
    assessed = responded + counts["missed"]
    times = [float(s["responseSeconds"]) for s in sessions if isinstance(s, dict) and isinstance(s.get("responseSeconds"), (int, float)) and not isinstance(s.get("responseSeconds"), bool)]
    return {
        **counts,
        "total": sum(counts.values()),
        "responded": responded,
        "assessed": assessed,
        "overall_rate": percent(counts["on_time"], assessed),
        "responded_rate": percent(counts["on_time"], responded),
        "avg_response": round(sum(times) / len(times), 1) if times else None,
        "sla_seconds": sla_seconds,
    }
