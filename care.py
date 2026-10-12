"""AI 主动预警：不等老人开口，每天把快筛、服务记录、事件、外出、类案等信号扫一遍，找出今天需要重点关注的老人。

规则层逐条列出每位老人的风险信号（每条带证据编号），算出基础优先级；
DeepSeek 在这些信号上做综合研判：把几条信号联系起来看出单条看不出的风险，写清谁在什么时限内做什么。
模型引用的编号逐一核对；模型不能把规则判定的高危（如超时未归）降级。结果按信号内容缓存，台账不变不重复计费。
"""
from __future__ import annotations

import hashlib
import json
import re
import threading
import time
from typing import Any, Callable

import case_radar
from agent import ID_PATTERN, _plain, _post, strip_ids

OPEN = {"待复核", "处置中", "已转派"}
FOLLOW_UP = "AI预警随访"  # 本功能自己生成的随访任务，不再当作风险信号
RANK = {"low": 0, "medium": 1, "high": 2}
LEVEL_WORD = {"high": "高", "medium": "中", "unknown": "缺项"}
ID_RE = re.compile(ID_PATTERN.replace("SOS|BC", "SOS|BC|SV|GX"))  # ID_PATTERN 已含 DV（安全设备）
# 每日打卡：哪些选项算异常（与页面打卡表单的选项一致）；“较差/低落/行动困难”算重的
DAILY_FIELDS = (("sleep", "睡眠"), ("appetite", "食欲"), ("mood", "心情"), ("mobility", "活动"))
DAILY_ABNORMAL = {"sleep": {"一般", "较差"}, "appetite": {"一般", "较差"}, "mood": {"低落"}, "mobility": {"轻度不适", "行动困难"}}
DAILY_SERIOUS = {"较差", "低落", "行动困难"}


def daily_check_concern(latest: dict[str, Any], previous: dict[str, Any] | None) -> dict[str, Any] | None:
    """今天有重的异常，或连续两次打卡都有异常，就需要机构当天当面看一看。"""
    odd = [f"{label}{latest.get(key)}" for key, label in DAILY_FIELDS if latest.get(key) in DAILY_ABNORMAL[key]]
    if not odd:
        return None
    serious = any(latest.get(key) in DAILY_SERIOUS for key, _ in DAILY_FIELDS)
    repeat = bool(previous) and any(previous.get(key) in DAILY_ABNORMAL[key] for key, _ in DAILY_FIELDS)
    return {"items": odd, "serious": serious, "repeat": repeat, "notify": serious or repeat}


_CACHE: dict[str, list[dict[str, Any]]] = {}
_LOCK = threading.Lock()


def cache_clear() -> None:
    with _LOCK:
        _CACHE.clear()


def build_dossiers(state: dict[str, Any]) -> list[dict[str, Any]]:
    """每位老人一份信号清单：text 是给人看的一句话，evidence 是可核对的编号，weight 用于规则优先级。"""
    events = [e for e in state.get("events", []) if isinstance(e, dict)]
    radar = case_radar.radar_events(state)
    clusters = case_radar.find_clusters(radar, features=case_radar.cached_features(radar))
    active_weather = {item.get("id") for item in state.get("weatherAlerts", []) if item.get("status") == "生效中"}
    profile = state.get("profile") or {}
    dossiers = []
    for resident in state.get("residents", []):
        rid, signals = resident.get("id"), []
        for dim in (resident.get("screening") or {}).get("dimensions", []):
            level = dim.get("level")
            if level in {"high", "medium"}:
                signals.append({"kind": "快筛", "text": f"快筛{dim.get('label')}：{dim.get('value')}（{LEVEL_WORD[level]}风险，{dim.get('evidence', '')}）", "evidence": [rid], "weight": 3 if level == "high" else 1})
            elif level == "unknown":
                signals.append({"kind": "快筛", "text": f"快筛缺项：{dim.get('label')}", "evidence": [rid], "weight": 0.5})
        for e in events:
            if e.get("residentId") == rid and e.get("status") in OPEN and not e.get("clusterId"):
                fraud = e.get("category") == "涉老诈骗风险"
                signals.append({"kind": "事件", "fraud": fraud, "short": e.get("title"), "text": f"未办结事件：{e.get('title')}（{e.get('category')}，{LEVEL_WORD.get(e.get('level'), '低')}风险，{e.get('status')}）", "evidence": [e["id"]], "weight": 3 if e.get("level") == "high" else 1.5,
                                **({"floor": "medium"} if fraud else {})})  # 涉诈线索没核实完，骗子常会再联系：至少今天留意
        for m in state.get("movementLogs", []):
            if m.get("residentId") != rid:
                continue
            status = m.get("status")
            weight = {"超时未归": 4, "就医中": 2, "外出中": 1, "待出发": 1}.get(status)
            if weight:
                cross = "→" in str(m.get("destination", "")) or bool(m.get("crossCity"))
                label = status if status.startswith("外出") else f"外出{status}"
                signals.append({"kind": "外出", "short": f"{label}：{m.get('destination')}", "text": f"{label}：{m.get('destination')}（出发 {m.get('departAt')}{'，跨市' if cross else ''}，责任人{m.get('responsible')}）", "evidence": [m["id"]], "weight": weight + (1 if cross else 0)})
        for log in state.get("serviceLogs", []):
            if log.get("residentId") == rid and log.get("type") != FOLLOW_UP and re.search(r"偏高|复测|异常|未返回|拒绝|跌倒|头晕|疼|未进食", str(log.get("result", ""))):
                signals.append({"kind": "服务记录", "text": f"服务记录：{log.get('type')} {log.get('result')}（{log.get('time')}）", "evidence": [log["id"]], "weight": 1.5})
        for checkin in state.get("safetyCheckins", []):
            if checkin.get("residentId") == rid and checkin.get("alertId") in active_weather and checkin.get("status") == "pending" and checkin.get("escalatedAt"):
                signals.append({"kind": "天气预警", "text": "模拟天气预警期间报平安超时未回应，需工作人员主动联系核实", "evidence": [checkin["id"], checkin["alertId"]], "weight": 4})
        for device in state.get("devices", []):
            if device.get("residentId") != rid:
                continue
            if device.get("status") == "离线":
                signals.append({"kind": "设备", "short": f"{device.get('type')}离线", "text": f"安全设备离线：{device.get('type')}（{device.get('location')}，最后在线 {device.get('lastSeen')}）", "evidence": [device["id"]], "weight": 2})
            elif device.get("status") == "低电量":
                signals.append({"kind": "设备", "short": f"{device.get('type')}电量低（{device.get('battery')}%）", "text": f"安全设备低电量：{device.get('type')} 剩余 {device.get('battery')}%", "evidence": [device["id"]], "weight": 0.5})
        if resident.get("livingAlone"):
            signals.append({"kind": "居住", "text": f"{resident.get('scene', '居家')}独居（{resident.get('address', resident.get('room', ''))}）", "evidence": [rid], "weight": 1})
        for cluster in clusters:
            if any(member.get("residentId") == rid for member in cluster["members"]):
                title = case_radar.template_report(cluster)["title"]
                fraud = cluster["kind"] == "fraud"
                signals.append({"kind": "类案", "fraud": fraud, "short": "涉及涉老诈骗类案" if fraud else "涉及消费纠纷类案", "text": f"涉及类案：{title}", "evidence": [cluster["id"]], "weight": 2 if fraud else 1, **({"floor": "medium"} if fraud else {})})
        if re.search(r"昨天|天前", str(resident.get("fresh", ""))):
            signals.append({"kind": "档案", "short": "档案超过 1 天未更新", "text": f"档案最近更新：{resident.get('fresh')}，超过 1 天", "evidence": [rid], "weight": 1})
        if rid == profile.get("id"):
            checks = [c for c in state.get("dailyChecks") or [] if isinstance(c, dict)]
            concern = daily_check_concern(checks[0], checks[1] if len(checks) > 1 else None) if checks else None
            if concern:
                note = str(checks[0].get("note") or "")[:40]
                signals.append({"kind": "打卡", "short": "连续两次打卡异常" if concern["repeat"] else "今日打卡异常",
                                "text": f"最近打卡（{checks[0].get('date')}）：{'、'.join(concern['items'])}{'，上一次打卡也有异常' if concern['repeat'] else ''}{'；本人说明：' + note if note else ''}",
                                "evidence": [rid], "weight": 2 if concern["notify"] else 0.5})
        score = sum(s["weight"] for s in signals)
        # 模型不能降级的下限：超时未归等为高；未办结的涉诈线索、涉诈类案至少为中
        floor = "high" if any(s["weight"] >= 4 for s in signals) else "medium" if any(s.get("floor") == "medium" for s in signals) else None
        by_score = "high" if score >= 8 else "medium" if score >= 3 else "low"
        rule_priority = max(by_score, floor or "low", key=lambda p: RANK[p])
        dossiers.append({"id": rid, "name": resident.get("name"), "age": resident.get("age"), "room": resident.get("room"), "signals": signals,
                         "score": round(score, 1), "rule_priority": rule_priority, "floor": floor})
    return dossiers


def _short(signal: dict[str, Any]) -> str:
    return str(signal.get("short") or signal["text"].split("（")[0]).replace("未办结事件：", "")


def _rule_actions(d: dict[str, Any], priority: str) -> list[dict[str, str]]:
    """没有模型建议时，按最主要的信号给出对口的动作。"""
    actions = []
    if any(s["kind"] == "外出" and "超时未归" in s["text"] for s in d["signals"]):
        actions.append({"who": "机构负责人", "what": "立即组织寻找并联系家属，必要时报警", "when": "立即"})
    if any(s.get("fraud") for s in d["signals"]):
        actions.append({"who": "社工", "what": "当面提醒先别交钱、别转账，核实推销方身份", "when": "今日内"})
    if any(s["kind"] == "设备" and "离线" in s["text"] for s in d["signals"]):
        actions.append({"who": "机构值班员", "what": "联系老人确认安全设备为何离线", "when": "1小时内"})
    elif any(s["kind"] == "设备" for s in d["signals"]):
        actions.append({"who": "责任护理员", "what": "提醒老人给安全设备充电", "when": "今日内"})
    if priority != "low" and not actions:
        actions.append({"who": "责任护理员", "what": "当面查看并记录状态", "when": "今日内"})
    return actions[:2]


def _rule_item(d: dict[str, Any]) -> dict[str, Any]:
    top = sorted(d["signals"], key=lambda s: -s["weight"])[:3]
    return {
        "id": d["id"], "name": d["name"], "age": d["age"], "room": d["room"], "priority": d["rule_priority"], "rule_priority": d["rule_priority"], "score": d["score"],
        "headline": _plain("；".join(dict.fromkeys(_short(s) for s in top[:2])), 40) or "暂无异常信号",
        "insight": "", "actions": _rule_actions(d, d["rule_priority"]),
        "signals": d["signals"], "evidence": sorted({e for s in top for e in s["evidence"]}), "by": "规则",
    }


PROMPT = """你是旅居养老机构的“AI 主动预警”助手。下面是系统从台账里为每位老人列出的风险信号（每条带编号）。
请逐位研判今天谁最需要关注：
1. 只依据给出的信号，不得编造病情、数字或事件；不做医学诊断，只说“需要关注”“建议复测/就医评估”。
2. 重点找“几条信号合起来才看得出的风险”，例如健康异常同时准备外出、涉诈线索同时准备跨市出行、档案久未更新又有异常记录、超时未归同时随身设备离线（无法定位）、独居又行动不便。
3. priority：high=今天必须当面处理；medium=今天留意；low=常规照护。有未办结的涉老诈骗事件或涉及涉诈类案的老人至少为 medium（骗子常会再次联系）。
4. actions 最多 2 条，写清 who（岗位，如责任护理员、值班医生、社工、机构负责人）、what（做什么）、when（时限，如“30分钟内”“今日下班前”）。
5. evidence 只能填这位老人自己信号里〔〕中的编号，不要引用其他老人的编号，也不要自己编编号。
6. priority 为 low 的老人只输出 id 和 priority 两个字段，节省篇幅。
只输出JSON：{"items":[{"id":"老人编号","priority":"high/medium/low","headline":"≤40字的一句话结论","insight":"≤60字，说明多条信号合起来的风险，没有就留空","actions":[{"who":"…","what":"…","when":"…"}],"evidence":["编号"]}]}"""


def _model_items(dossiers: list[dict[str, Any]], config: dict[str, str], endpoint: str, clean: Callable[[str], str]) -> dict[str, dict[str, Any]]:
    payload = [{"id": d["id"], "老人": f"{d['name']}，{d['age']}岁，{d['room']}", "信号": [f"{s['text']}〔{'、'.join(s['evidence'])}〕" for s in d["signals"]]} for d in dossiers]
    reply = _post(config, {"model": config["model"], "temperature": 0.2, "max_tokens": 4000, "response_format": {"type": "json_object"},
                           "messages": [{"role": "system", "content": PROMPT}, {"role": "user", "content": json.dumps(payload, ensure_ascii=False)}]}, endpoint, timeout=90)
    rows = parse_items(clean(reply["choices"][0]["message"]["content"]))
    return {str(r.get("id")): r for r in rows if isinstance(r, dict)}


def parse_items(text: str) -> list[dict[str, Any]]:
    """老人多时输出可能被截断：完整的 JSON 直接用；截断时保留已经写完整的条目，其余老人沿用规则结果。"""
    try:
        return json.loads(text).get("items", [])
    except json.JSONDecodeError:
        start = text.find("[")
        rows, decoder, index = [], json.JSONDecoder(), start + 1
        while start >= 0 and index < len(text):
            while index < len(text) and text[index] in " \r\n\t,":
                index += 1
            try:
                row, index = decoder.raw_decode(text, index)
            except json.JSONDecodeError:
                break
            rows.append(row)
        if not rows:
            raise
        return rows


def _merge(d: dict[str, Any], row: dict[str, Any] | None) -> dict[str, Any]:
    item = _rule_item(d)
    if not row:
        return item
    allowed = {e for s in d["signals"] for e in s["evidence"]}
    cited = [m for x in row.get("evidence") or [] for m in ID_RE.findall(str(x))]
    cited += ID_RE.findall(f"{row.get('headline', '')}{row.get('insight', '')}")
    priority = row.get("priority") if row.get("priority") in RANK else item["priority"]
    if d["floor"] and RANK[priority] < RANK[d["floor"]]:
        priority = d["floor"]  # 规则判定的高危不允许被模型降级
    actions = []
    for a in (row.get("actions") or [])[:2]:
        if isinstance(a, dict) and a.get("what"):
            actions.append({"who": _plain(a.get("who") or "责任护理员", 12), "what": _plain(strip_ids(a.get("what")), 40), "when": _plain(a.get("when") or "今日内", 12)})
    item.update({
        "priority": priority,
        "headline": _plain(strip_ids(row.get("headline") or item["headline"]), 60),
        "insight": _plain(strip_ids(row.get("insight") or ""), 90),
        "actions": actions or _rule_actions(d, priority),
        "evidence": [x for x in dict.fromkeys(cited) if x in allowed] or item["evidence"],
        "dropped_ids": len({x for x in cited if x not in allowed}),
        "by": "DeepSeek",
    })
    return item


def analyze(state: dict[str, Any], config: dict[str, str] | None = None, endpoint: str = "", clean: Callable[[str], str] = lambda t: t, allow_model: bool = True) -> dict[str, Any]:
    dossiers = build_dossiers(state)
    flagged = [d for d in dossiers if d["signals"]]
    key = hashlib.sha1(json.dumps([(d["id"], [s["text"] for s in d["signals"]]) for d in flagged], ensure_ascii=False).encode()).hexdigest()
    with _LOCK:
        rows = _CACHE.get(key)
    note = "台账信号没有变化，沿用上次 AI 研判" if rows is not None else ""
    if rows is None and allow_model and config and config.get("api_key") and flagged:
        try:  # 调用模型时不持锁，避免“先看规则结果”的请求被卡住
            started = time.perf_counter()
            rows = _model_items(flagged, config, endpoint, clean)
            with _LOCK:
                _CACHE[key] = rows
            note = f"DeepSeek 研判用时 {time.perf_counter() - started:.1f} 秒"
        except Exception as error:  # 模型不可用时仍给出规则结果
            rows, note = None, f"AI 研判暂不可用（{type(error).__name__}），显示规则结果"
    items = [_merge(d, (rows or {}).get(d["id"])) for d in dossiers]
    items.sort(key=lambda i: (-RANK[i["priority"]], -i["score"]))
    return {
        "source": "规则信号 + DeepSeek 综合研判" if rows else "规则信号",
        "note": note,
        "pending_ai": rows is None and allow_model is False and bool(config and config.get("api_key")) and bool(flagged),
        "scanned": len(dossiers),
        "counts": {p: sum(i["priority"] == p for i in items) for p in ("high", "medium", "low")},
        "items": items,
    }
