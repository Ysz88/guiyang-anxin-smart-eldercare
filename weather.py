"""Offline-first simulated weather alerts and resident safety check-ins."""
from __future__ import annotations

import secrets
import time
from typing import Any

ALERT_TYPES = {"台风", "高温"}
ALERT_LEVELS = {"蓝色", "黄色", "橙色", "红色"}
ACTIVE_MOVEMENT = {"待出发", "外出中", "就医中", "在途中", "超时未归"}


def city_name(value: Any) -> str:
    return str(value or "").strip().removesuffix("市")


def affected_residents(state: dict[str, Any], cities: list[str]) -> list[dict[str, Any]]:
    """Match institution/home city or a current/planned trip and sort by care priority."""
    selected = {city_name(city) for city in cities}
    institutions = {item.get("name"): city_name(item.get("city")) for item in state.get("institutions", []) if isinstance(item, dict)}
    result = []
    for resident in state.get("residents", []):
        if not isinstance(resident, dict) or not resident.get("id"):
            continue
        rid = resident["id"]
        movements = [m for m in state.get("movementLogs", []) if isinstance(m, dict) and m.get("residentId") == rid and m.get("status") in ACTIVE_MOVEMENT]
        trip_hit = any(city in str(m.get("destination", "")) for city in selected for m in movements)
        address = str(resident.get("address") or "")
        home_hit = any(city in address for city in selected)
        institution_hit = institutions.get(resident.get("institution")) in selected
        if not (trip_hit or home_hit or institution_hit):
            continue
        outside = any(m.get("status") in {"外出中", "就医中", "在途中", "超时未归"} for m in movements)
        alone = bool(resident.get("livingAlone")) or "独居" in address
        high = resident.get("risk") == "high" or (resident.get("screening") or {}).get("overall") == "high"
        reason = "正在外出" if outside else "独居" if alone else "快筛高风险" if high else "预警城市在住或计划前往"
        result.append({"residentId": rid, "resident": str(resident.get("name", ""))[:40],
                       "institution": str(resident.get("institution", ""))[:80], "priority": 3 if outside else 2 if alone else 1 if high else 0,
                       "reason": reason})
    return sorted(result, key=lambda item: (-item["priority"], item["residentId"]))


def create_alert(state: dict[str, Any], payload: dict[str, Any], issuer: str, now_ms: int | None = None) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    kind, level = payload.get("type"), payload.get("level")
    cities = payload.get("cities")
    known = {city_name(item.get("city")) for item in state.get("institutions", []) if isinstance(item, dict)}
    if kind not in ALERT_TYPES or level not in ALERT_LEVELS or not isinstance(cities, list) or not cities or len(cities) > 6:
        raise ValueError("invalid_weather_alert")
    cities = list(dict.fromkeys(city_name(city) for city in cities))
    if any(not city or city not in known for city in cities):
        raise ValueError("invalid_weather_city")
    try:
        minutes = int(payload.get("deadlineMinutes", 30))
    except (TypeError, ValueError) as error:
        raise ValueError("invalid_deadline") from error
    if not 2 <= minutes <= 120:
        raise ValueError("invalid_deadline")
    now = now_ms if now_ms is not None else int(time.time() * 1000)
    targets = affected_residents(state, cities)
    alert_id = f"WA-{time.strftime('%Y%m%d', time.localtime(now / 1000))}-{secrets.token_hex(3).upper()}"
    default_advice = "请留在室内，远离海边和临时搭建物；如需帮助请立即报平安求助。" if kind == "台风" else "请减少高温时段外出，及时饮水；身体不适请联系工作人员。"
    alert = {"id": alert_id, "type": kind, "level": level, "cities": cities,
             "title": f"{kind}{level}预警 · {'、'.join(cities)}", "advice": default_advice,
             "issuedAt": now, "issuedBy": issuer[:40], "source": "模拟预警（演示）", "status": "生效中",
             "deadlineMinutes": minutes, "deadlineAt": now + minutes * 60_000,
             "affectedResidentIds": [target["residentId"] for target in targets]}
    checkins = [{"id": f"CK-{secrets.token_hex(5).upper()}", "alertId": alert_id,
                 "residentId": target["residentId"], "resident": target["resident"],
                 "institution": target["institution"], "priority": target["priority"], "reason": target["reason"],
                 "status": "pending", "at": "", "by": "", "note": "", "deadlineAt": alert["deadlineAt"], "escalatedAt": ""}
                for target in targets]
    return alert, checkins


def advance_overdue(state: dict[str, Any], now_ms: int | None = None) -> int:
    """Create one in-app manager follow-up marker per unanswered deadline."""
    now = now_ms if now_ms is not None else int(time.time() * 1000)
    active = {a.get("id") for a in state.get("weatherAlerts", []) if a.get("status") == "生效中"}
    changed = 0
    for item in state.get("safetyCheckins", []):
        if item.get("alertId") in active and item.get("status") == "pending" and not item.get("escalatedAt") and now >= int(item.get("deadlineAt") or 0) > 0:
            item["escalatedAt"] = now
            item["note"] = "超时未回应，已进入机构负责人站内待跟进队列"
            changed += 1
    return changed


def checkin_summary(state: dict[str, Any]) -> dict[str, int]:
    active = {a.get("id") for a in state.get("weatherAlerts", []) if a.get("status") == "生效中"}
    items = [item for item in state.get("safetyCheckins", []) if item.get("alertId") in active]
    responded = sum(item.get("status") in {"safe", "help"} for item in items)
    return {"total": len(items), "responded": responded, "pending": len(items) - responded,
            "help": sum(item.get("status") == "help" for item in items),
            "overdue": sum(item.get("status") == "pending" and bool(item.get("escalatedAt")) for item in items),
            "rate": round(100 * responded / len(items)) if items else 0}
