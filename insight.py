"""运行态势研判 + 服务质量评价：全部由台账计算，每个数字都能追到编号。

- 态势：人群按居住场景（机构入住 / 居家旅居 / 社区嵌入）与客源地分布，事件按场景（机构服务、老年消费、涉诈、出行、边境、居家安全）归类，
  外出与出境行程、安全设备在线情况、应急响应时效。
- 质量评价：按机构汇总事件、投诉、超时未归、呼救接单、设备离线、快筛复核，逐项扣分并附证据编号；
  台账记录不足 3 条的机构不计算，标注“样本不足”，沿用机构填报的参考分，不编造分数。
- 研判要点：规则生成，每条带证据编号，供页面展示，也供 AI 监管参谋调用（只读，不额外调用模型）。
权重为演示规则，需试点校准。
"""
from __future__ import annotations

import re
from typing import Any
import sla
import weather

OPEN = {"待复核", "处置中", "已转派"}
CONSUMER = {"服务投诉", "消费纠纷"}
BORDER_RE = re.compile(r"边境|口岸|东兴|芒街|凭祥|友谊关|越南|出境")
SCENES = ("机构入住", "居家旅居", "社区嵌入")
SLA_SECONDS = 30
MIN_RECORDS = 3
# 客源地按省份归到大区，便于看“候鸟”从哪里来
REGIONS = {
    "东北": ("黑龙江", "吉林", "辽宁"), "华北": ("北京", "天津", "河北", "山西", "内蒙古"), "华东": ("上海", "江苏", "浙江", "安徽", "福建", "江西", "山东"),
    "华中": ("河南", "湖北", "湖南"), "华南": ("广东", "广西", "海南"), "西南": ("重庆", "四川", "贵州", "云南", "西藏"), "西北": ("陕西", "甘肃", "青海", "宁夏", "新疆"),
}
WEIGHTS = "高风险未办结 3 分/件（封顶15）· 投诉未办结 2 分、已办结 1 分（封顶10）· 超时未归 4 分/条 · 呼救超时接单、超时未接单或升级 2 分/单 · 设备离线 1 分/台 · 快筛待复核 0.5 分/人（封顶3）"
SOS_RULE = "接单考核口径：值班人员 30 秒内接单为按时；超过 30 秒仍无人接单计“超时未接单”，即使之后有人接单也计“超时后接单”；30 秒内本人取消视为误触，不计入；仍在 30 秒内等待的工单未到考核时点，暂不计入。整体响应达标率 = 按时接单 ÷（按时 + 超时后接单 + 超时未接单）。"


def _region(source: str) -> str:
    for region, provinces in REGIONS.items():
        if any(p in str(source) for p in provinces):
            return region
    return "其他"


def _grade(score: float) -> str:
    return "优" if score >= 90 else "良" if score >= 80 else "中" if score >= 70 else "需督导"


def event_scene(event: dict[str, Any], residents: dict[str, dict[str, Any]]) -> str:
    """一件事归到一个场景，便于看风险出在哪条链上。"""
    text = f"{event.get('scene', '')}{event.get('location', '')}{event.get('title', '')}"
    if event.get("scene") == "边境" or BORDER_RE.search(text):
        return "边境"
    if event.get("category") == "涉老诈骗风险":
        return "涉诈"
    if event.get("category") in CONSUMER:
        return "老年消费"
    if event.get("category") == "设备告警" or (residents.get(event.get("residentId")) or {}).get("scene") in {"居家旅居", "社区嵌入"}:
        return "居家社区安全"
    if event.get("category") in {"失联风险", "行程变更"}:
        return "出行"
    return "机构服务"


def institution_of(event: dict[str, Any], institutions: list[dict[str, Any]], residents: dict[str, dict[str, Any]]) -> str:
    if event.get("institution"):
        return str(event["institution"])
    text = f"{event.get('location', '')}{event.get('owner', '')}"
    named = next((i["name"] for i in institutions if i.get("name") and i["name"] in text), "")
    return named or str((residents.get(event.get("residentId")) or {}).get("institution", ""))


def sos_rate_text(summary: dict[str, Any], key: str = "overall") -> str:
    """达标率连同分母一起写出来，避免“100%”背后只有一张单。"""
    if key == "overall":
        return f"{summary['on_time']}/{summary['assessed']}（{summary['overall_rate']}%）" if summary["assessed"] else "暂无已到考核时点的工单"
    return f"{summary['on_time']}/{summary['responded']}（{summary['responded_rate']}%）" if summary["responded"] else "暂无已接单工单"


def quality(state: dict[str, Any], now: int | None = None) -> list[dict[str, Any]]:
    now = now if now is not None else sla.now_ms()
    institutions = [i for i in state.get("institutions", []) if isinstance(i, dict)]
    residents = {r.get("id"): r for r in state.get("residents", []) if isinstance(r, dict)}
    events = [e for e in state.get("events", []) if isinstance(e, dict)]
    rows = []
    for inst in institutions:
        name = inst.get("name", "")
        members = {rid for rid, r in residents.items() if r.get("institution") == name}
        ev = [e for e in events if institution_of(e, institutions, residents) == name]
        moves = [m for m in state.get("movementLogs", []) if m.get("residentId") in members]
        sos = [s for s in state.get("sosSessions", []) if isinstance(s, dict) and s.get("institution") == name]
        devices = [d for d in state.get("devices", []) if d.get("residentId") in members]
        records = len(ev) + len(moves) + len(sos)
        base = {"id": inst.get("id"), "name": name, "city": inst.get("city"), "reference_score": inst.get("score"), "records": records}
        if records < MIN_RECORDS:
            rows.append({**base, "sufficient": False, "score": None, "grade": "样本不足", "deductions": [], "metrics": {}, "note": f"台账记录 {records} 条，不足 {MIN_RECORDS} 条，不计算；参考分为机构填报"})
            continue
        deductions = []

        def deduct(item: str, per: float, found: list[dict[str, Any]], cap: float | None = None, points: float | None = None) -> None:
            if not found:
                return
            value = points if points is not None else per * len(found)
            value = min(value, cap) if cap else value
            deductions.append({"item": item, "count": len(found), "points": round(value, 1), "evidence": [x.get("id") for x in found][:6]})

        high_open = [e for e in ev if e.get("level") == "high" and e.get("status") in OPEN]
        complaints = [e for e in ev if e.get("category") in CONSUMER]
        overdue = [m for m in moves if m.get("status") == "超时未归"]
        slow = [s for s in sos if sla.sos_outcome(s, now, SLA_SECONDS) in {"late", "missed"} or int(s.get("escalation") or 1) >= 2]
        offline = [d for d in devices if d.get("status") == "离线"]
        review = [r for rid, r in residents.items() if rid in members and (r.get("screening") or {}).get("reviewRequired")]
        deduct("高风险事件未办结", 3, high_open, cap=15)
        deduct("服务投诉 / 消费纠纷", 0, complaints, cap=10, points=sum(2 if e.get("status") in OPEN else 1 for e in complaints))
        deduct("外出超时未归", 4, overdue)
        deduct("呼救超时接单、超时未接单或升级", 2, slow)
        deduct("安全设备离线", 1, offline)
        deduct("快筛待人工复核", 0.5, review, cap=3)
        score = round(max(0, 100 - sum(d["points"] for d in deductions)), 1)
        summary = sla.sos_summary(sos, now, SLA_SECONDS)
        closed = [e for e in ev if e.get("status") == sla.CLOSED]
        timed = [e for e in closed if sla.status(e, now)["state"] in {"closed_on_time", "closed_late"}]
        metrics = {
            "事件办结率": f"{round(100 * len(closed) / len(ev))}%" if ev else "—",
            "按时办结": f"{sum(sla.status(e, now)['state'] == 'closed_on_time' for e in timed)}/{len(timed)}" if timed else "—",
            "当前超时未办结": f"{sum(sla.status(e, now)['state'] == 'open_overdue' for e in ev)}件",
            "平均接单": f"{summary['avg_response']}秒" if summary["avg_response"] is not None else "—",
            "整体响应达标率": sos_rate_text(summary),
            "已接单按时率": sos_rate_text(summary, "responded"),
            "超时未接单": f"{summary['missed']}单",
            "投诉发生率": f"每百位建档老人 {round(100 * len(complaints) / len(members), 1)} 件（{len(complaints)}件/{len(members)}人）" if members else "—",
            "动向监管确认率": f"{round(100 * sum(m.get('regulatorStatus') != '待确认' for m in moves) / len(moves))}%" if moves else "—",
            "设备在线率": f"{round(100 * sum(d.get('status') != '离线' for d in devices) / len(devices))}%" if devices else "—",
        }
        rows.append({**base, "sufficient": True, "score": score, "grade": _grade(score), "deductions": deductions, "metrics": metrics, "note": "按台账计算（演示权重，待试点校准）"})
    rows.sort(key=lambda r: (not r["sufficient"], r["score"] if r["score"] is not None else 999))
    return rows


def reconcile(state: dict[str, Any]) -> dict[str, Any]:
    """机构填报在住人数与平台已建档人数分开列示：不去重、不核对范围就算“覆盖率”会误导，这里只给差额和待核对清单。"""
    residents = [r for r in state.get("residents", []) if isinstance(r, dict)]
    rows = []
    for inst in state.get("institutions", []):
        if not isinstance(inst, dict):
            continue
        filed = int(inst.get("residents") or 0)
        members = [r for r in residents if r.get("institution") == inst.get("name")]
        rows.append({"id": inst.get("id"), "name": inst.get("name"), "city": inst.get("city"), "reported": filed, "registered": len(members),
                     "scenes": {scene: sum((r.get("scene") or "机构入住") == scene for r in members) for scene in SCENES},
                     "gap": max(0, filed - len(members)), "status": "待核对" if filed != len(members) else "一致"})
    return {"reported": sum(r["reported"] for r in rows), "registered": len(residents), "pending": sum(r["status"] == "待核对" for r in rows),
            "gap": sum(r["gap"] for r in rows), "rows": rows,
            "note": "填报数来自机构自报，平台建档数来自 OneID 档案；差额需逐家核对是否重复填报、是否含非旅居老人，核对前不计算覆盖率。"}


def analyze(state: dict[str, Any], now: int | None = None) -> dict[str, Any]:
    now = now if now is not None else sla.now_ms()
    residents_list = [r for r in state.get("residents", []) if isinstance(r, dict)]
    residents = {r.get("id"): r for r in residents_list}
    events = [e for e in state.get("events", []) if isinstance(e, dict)]
    open_events = [e for e in events if e.get("status") in OPEN]
    moves = [m for m in state.get("movementLogs", []) if isinstance(m, dict)]
    devices = [d for d in state.get("devices", []) if isinstance(d, dict)]
    sos = [s for s in state.get("sosSessions", []) if isinstance(s, dict)]

    scenes = {s: [r["id"] for r in residents_list if r.get("scene", "机构入住") == s] for s in SCENES}
    regions: dict[str, list[str]] = {}
    for r in residents_list:
        regions.setdefault(_region(r.get("source", "")), []).append(r.get("id"))
    event_scenes: dict[str, dict[str, Any]] = {}
    for e in events:
        bucket = event_scenes.setdefault(event_scene(e, residents), {"total": 0, "open": 0, "high_open": 0, "ids": []})
        bucket["total"] += 1
        bucket["open"] += e.get("status") in OPEN
        bucket["high_open"] += e.get("status") in OPEN and e.get("level") == "high"
        bucket["ids"].append(e.get("id"))
    border_moves = [m for m in moves if m.get("border") or BORDER_RE.search(str(m.get("destination", "")))]
    cross_moves = [m for m in moves if m.get("crossCity") or "→" in str(m.get("destination", "")) or m.get("type") in {"跨市行程", "出境行程"}]
    offline = [d for d in devices if d.get("status") == "离线"]
    low_battery = [d for d in devices if d.get("status") == "低电量"]
    sos_summary = sla.sos_summary(sos, now, SLA_SECONDS)
    device_alarms = [s for s in sos if str(s.get("trigger", "")).startswith("设备告警")]
    q = quality(state, now)
    overdue_events = [e for e in open_events if sla.status(e, now)["state"] == "open_overdue"]

    findings = []
    fraud_open = [e for e in open_events if e.get("category") == "涉老诈骗风险"]
    if fraud_open:
        findings.append({"level": "high" if any(e.get("level") == "high" for e in fraud_open) else "medium", "text": f"未办结的 {len(open_events)} 件事件中，涉老诈骗 {len(fraud_open)} 件（{round(100 * len(fraud_open) / len(open_events))}%），是当前最集中的风险", "evidence": [e["id"] for e in fraud_open][:5]})
    border = event_scenes.get("边境")
    if border or border_moves:
        pending = [m for m in border_moves if m.get("regulatorStatus") == "待确认"]
        findings.append({"level": "medium", "text": f"边境相关事件 {border['total'] if border else 0} 件、出境或边境行程 {len(border_moves)} 条（{len(pending)} 条待确认），低价团进店购物是主要问题", "evidence": ((border or {}).get("ids", []) + [m["id"] for m in border_moves])[:5]})
    home = scenes["居家旅居"] + scenes["社区嵌入"]
    if home:
        home_devices = [d for d in devices if d.get("residentId") in home]
        findings.append({"level": "medium" if offline or low_battery else "low", "text": f"居家、社区旅居老人 {len(home)} 位，接入安全设备 {len(home_devices)} 台；全部设备中离线 {len(offline)} 台、低电量 {len(low_battery)} 台", "evidence": [d["id"] for d in offline + low_battery][:5] or home[:3]})
    lost_with_offline = [m for m in moves if m.get("status") == "超时未归" and any(d.get("residentId") == m.get("residentId") and d.get("status") == "离线" for d in devices)]
    if lost_with_offline:
        findings.append({"level": "high", "text": f"{len(lost_with_offline)} 位超时未归老人的随身设备同时离线，无法定位，需人工寻找", "evidence": [m["id"] for m in lost_with_offline] + [d["id"] for d in offline if any(d.get("residentId") == m.get("residentId") for m in lost_with_offline)]})
    scored = [r for r in q if r["sufficient"]]
    if scored:
        worst = scored[0]
        top = sorted(worst["deductions"], key=lambda d: -d["points"])[:2]
        findings.append({"level": "high" if worst["score"] < 70 else "medium" if worst["score"] < 85 else "low", "text": f"{worst['name']}按台账计算 {worst['score']} 分（{worst['grade']}），主要扣分：{'、'.join(d['item'] for d in top) or '无'}", "evidence": [worst["id"], *[x for d in top for x in d["evidence"]][:4]]})
    if overdue_events:
        findings.append({"level": "high" if any(e.get("level") == "high" for e in overdue_events) else "medium",
                         "text": f"{len(overdue_events)} 件事件已超过处置时限仍未办结（时限按服务器记录的创建与截止时间计算）",
                         "evidence": [e["id"] for e in sorted(overdue_events, key=lambda e: (e.get("level") != "high", sla.to_ms(e.get("dueAt")) or 0))][:5]})
    if sos_summary["missed"]:
        findings.append({"level": "high", "text": f"{sos_summary['missed']} 张呼救工单超过 {SLA_SECONDS} 秒仍无人接单，整体响应达标 {sos_rate_text(sos_summary)}",
                         "evidence": [s.get("id") for s in sos if sla.sos_outcome(s, now, SLA_SECONDS) == "missed"][:5]})
    insufficient = [r for r in q if not r["sufficient"]]
    if insufficient:
        findings.append({"level": "low", "text": f"{len(insufficient)} 家机构台账记录不足，暂不计算质量评分，评分沿用机构填报的参考分，需试点接入真实台账", "evidence": [r["id"] for r in insufficient][:6]})

    return {
        "note": "演示样本台账计算，不代表全区实际数据；权重为演示规则，待试点校准",
        "population": {"total": len(residents_list), "scenes": {k: len(v) for k, v in scenes.items()}, "regions": {k: len(v) for k, v in sorted(regions.items(), key=lambda kv: -len(kv[1]))},
                       "age_80_plus": sum(int(r.get("age") or 0) >= 80 for r in residents_list), "living_alone": sum(bool(r.get("livingAlone")) for r in residents_list)},
        "institutions": {"count": len(state.get("institutions", [])), "watch": [i.get("name") for i in state.get("institutions", []) if i.get("status") != "正常"],
                         "reported_residents": sum(int(i.get("residents") or 0) for i in state.get("institutions", []))},
        "reconcile": reconcile(state),
        "events": {"total": len(events), "open": len(open_events), "high_open": sum(e.get("level") == "high" for e in open_events), "by_scene": event_scenes,
                   "overdue": [e["id"] for e in overdue_events]},
        "movements": {"total": len(moves), "outside": sum(m.get("status") in {"外出中", "就医中", "超时未归"} for m in moves), "overdue": [m["id"] for m in moves if m.get("status") == "超时未归"],
                      "cross_city": len(cross_moves), "border": [m["id"] for m in border_moves]},
        "devices": {"total": len(devices), "online_rate": round(100 * sum(d.get("status") != "离线" for d in devices) / len(devices)) if devices else None,
                    "offline": [d["id"] for d in offline], "low_battery": [d["id"] for d in low_battery], "alarms": len(device_alarms)},
        "sos": {**sos_summary, "avg_claim": sos_summary["avg_response"], "sla_rate": sos_summary["overall_rate"], "rule": SOS_RULE},
        "weather": weather.checkin_summary(state),
        "quality": q,
        "quality_rule": WEIGHTS,
        "findings": findings,
    }
