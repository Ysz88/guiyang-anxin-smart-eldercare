"""AI 监管参谋：监管员用一句话提问，大模型调用只读台账工具，给出带证据编号的结论与督办建议。

与老人端智能体同一套思路：模型负责理解问题、决定查什么、组织语言；
工具只读、数字全部来自工具结果；回答里引用的证据编号由代码核对，查不到的编号一律删除。
未配置大模型时，用关键词路由调用同一组工具，给出模板回答。
"""
from __future__ import annotations

import json
import re
import time
from typing import Any, Callable

import care
import case_radar
import insight
import sla
import weather
from agent import ID_PATTERN, _plain, _post, strip_ids

OPEN = {"待复核", "处置中", "已转派"}
LEVEL = {"high": "高风险", "medium": "需关注", "low": "低风险"}
ID_RE = re.compile(ID_PATTERN)
# 老人档案号也可以作为证据；给老人看的文字仍按 agent.ID_PATTERN 去掉编号
RESIDENT_ID = r"(?<![A-Za-z0-9])GX-[A-Z]{2}-\d{4}-\d{6}"
EVIDENCE_RE = re.compile(f"{ID_PATTERN}|{RESIDENT_ID}")
# 要求修改台账：“把/将……标记为已办结”，或以修改类动词开头
WRITE_RE = re.compile(r"(?:把|将)[^。？?]{0,30}?(?:标记|标成|改成|改为|设为|设置为|修改|删除|删掉|作废|撤销|关闭|关掉|转派|派给|指派|办结掉|直接办结|结案)|^(?:请|帮我|麻烦)?(?:标记|修改|删除|删掉|作废|撤销|关闭|转派|派给|指派|结案)")
# 要求起草文书
DRAFT_RE = re.compile(r"(?:起草|草拟|拟一份|拟个|拟写|写一份|写个|出一份|生成)[^。？?]{0,24}?(?:通知|函|通报|督办单|整改单)")


def _event_row(e: dict[str, Any]) -> dict[str, Any]:
    evidence = e.get("evidence") if isinstance(e.get("evidence"), dict) else {}
    quote_count = len(evidence.get("quotes", [])) if isinstance(evidence.get("quotes"), list) else 0
    check_count = len(evidence.get("checks", [])) if isinstance(evidence.get("checks"), list) else 0
    source = f"老人对话原话 {quote_count} 句 + 查证 {check_count} 项" if evidence else "老人上报，无对话记录"
    due = sla.status(e)  # 时限按服务器记录的创建、截止、办结时间实时计算，不用写死的文字
    return {"id": e.get("id"), "title": e.get("title"), "resident": e.get("resident"), "category": e.get("category"), "level": LEVEL.get(e.get("level"), e.get("level")), "status": e.get("status"), "owner": e.get("owner"), "deadline": due["text"], "承诺时限": e.get("deadline"), "是否超时": due["state"] in {"open_overdue", "closed_late"}, "time": e.get("time"), "location": e.get("location"), "证据来源": source}


def _deadline_clause(e: dict[str, Any]) -> str:
    deadline = str(e.get("deadline") or "")
    if deadline.startswith("剩余"):
        return f"{deadline.replace('剩余', '').strip()}内反馈处置结果。"
    if deadline.startswith("已超时"):
        return f"{deadline}，请立即反馈处置结果并说明超时原因。"
    return f"按“{deadline or '尽快'}”要求反馈处置结果。"


def tool_overview(state: dict[str, Any], _args: dict[str, Any]) -> dict[str, Any]:
    events = state.get("events", [])
    open_events = [e for e in events if e.get("status") in OPEN]
    moves = state.get("movementLogs", [])
    by_category: dict[str, int] = {}
    for e in open_events:
        by_category[e.get("category", "其他")] = by_category.get(e.get("category", "其他"), 0) + 1
    radar = case_radar.radar_events(state)
    clusters = case_radar.find_clusters(radar, features=case_radar.cached_features(radar))
    return {
        "样本老人": len(state.get("residents", [])), "样本机构": len(state.get("institutions", [])),
        "未办结事件": len(open_events), "其中高风险": sum(e.get("level") == "high" for e in open_events), "未办结事件分类": by_category,
        "外出中": sum(m.get("status") == "外出中" for m in moves), "超时未归": sum(m.get("status") == "超时未归" for m in moves),
        "动向待监管确认": sum(m.get("regulatorStatus") == "待确认" for m in moves),
        "进行中的呼救": sum(s.get("status") in {"waiting", "claimed"} for s in state.get("sosSessions", [])),
        "类案": len(clusters), "高风险类案": sum(c["risk"] == "high" for c in clusters),
        "说明": "演示样本台账，不代表全区实际数据",
    }


def tool_query_events(state: dict[str, Any], args: dict[str, Any]) -> dict[str, Any]:
    items = [e for e in state.get("events", []) if isinstance(e, dict)]
    if args.get("open_only", True):
        items = [e for e in items if e.get("status") in OPEN]
    if args.get("level") in LEVEL:
        items = [e for e in items if e.get("level") == args["level"]]
    for key in ("category", "institution", "keyword"):
        value = str(args.get(key) or "").strip()
        if value:
            residents = {r.get("id"): r for r in state.get("residents", []) if isinstance(r, dict)}
            field = {"category": lambda e: e.get("category", ""), "institution": lambda e: f"{e.get('location', '')}{insight.institution_of(e, state.get('institutions', []), residents)}", "keyword": lambda e: f"{e.get('title', '')}{e.get('summary', '')}{e.get('resident', '')}"}[key]
            items = [e for e in items if value in field(e)]
    items.sort(key=lambda e: ({"high": 0, "medium": 1}.get(e.get("level"), 2), e.get("id", "")))
    return {"count": len(items), "items": [_event_row(e) for e in items[:8]], "note": "只列前 8 条" if len(items) > 8 else ""}


def _resident_row(r: dict[str, Any], state: dict[str, Any]) -> dict[str, Any]:
    """监管查询用的老人概况：不含电话、证件号；居家老人地址只到小区。"""
    rid = r.get("id")
    address = re.sub(r"\d+\s*栋\s*\d+(?:室)?", "", str(r.get("address") or r.get("room") or "")).strip()
    screening = r.get("screening") if isinstance(r.get("screening"), dict) else {}
    moving = next((m for m in state.get("movementLogs", []) if m.get("residentId") == rid and m.get("status") in {"外出中", "超时未归", "待出发", "就医中", "在途中"}), None)
    return {
        "id": rid, "name": r.get("name"), "age": r.get("age"), "居住方式": r.get("scene") or "机构入住", "所属机构": r.get("institution"), "住址": address, "入住日期": r.get("checkIn") or "未登记",
        "客源地": r.get("source"), "独居": {True: "是", False: "否"}.get(r.get("livingAlone"), "未登记"), "风险": LEVEL.get(r.get("risk"), r.get("risk")),
        "快筛": f"{LEVEL.get(screening.get('overall'), '未完成')}（{screening.get('reviewStatus') or '无需复核'}）" if screening else "未完成",
        "网格员": re.sub(r"[（(].*", "", str(r.get("gridWorker") or "")) or "—",
        "紧急联系人": r.get("emergencyName") or "未登记",
        "安全设备": [d.get("id") for d in state.get("devices", []) if d.get("residentId") == rid],
        "未办结事件": [e.get("id") for e in state.get("events", []) if e.get("residentId") == rid and e.get("status") in OPEN],
        "当前动向": f"{moving.get('id')} {moving.get('status')} · {moving.get('destination')}" if moving else "在住",
    }


def tool_query_residents(state: dict[str, Any], args: dict[str, Any]) -> dict[str, Any]:
    items = [r for r in state.get("residents", []) if isinstance(r, dict)]
    name = str(args.get("name") or "").strip()
    if name:
        items = [r for r in items if name in str(r.get("name", "")) or str(r.get("name", "")) in name]
    if isinstance(args.get("living_alone"), bool):
        items = [r for r in items if bool(r.get("livingAlone")) == args["living_alone"]]
    if args.get("scene"):
        items = [r for r in items if (r.get("scene") or "机构入住") == args["scene"]]
    if args.get("risk") in LEVEL:
        items = [r for r in items if r.get("risk") == args["risk"]]
    for key, field in (("institution", "institution"), ("source", "source")):
        value = str(args.get(key) or "").strip()
        if value:
            items = [r for r in items if value in str(r.get(field) or "")]
    tally = lambda key, default: {k: sum((r.get(key) or default) == k for r in items) for k in dict.fromkeys((r.get(key) or default) for r in items)}
    # 统计按全部结果算：列表只列前 10 位时，问“多少人、分布在哪”也不会少算
    return {"count": len(items), "按机构": tally("institution", "未登记"), "按居住方式": tally("scene", "机构入住"), "items": [_resident_row(r, state) for r in items[:10]],
            "note": ("列表只列前 10 位，人数和分布以“按机构”“按居住方式”为准；" if len(items) > 10 else "") + "不含电话和证件号"}


def tool_get_record(state: dict[str, Any], args: dict[str, Any]) -> dict[str, Any]:
    """按编号查一条记录：事件、动向、机构、类案、呼救、设备、天气预警、报平安、老人档案。"""
    rid = str(args.get("id") or "").strip()
    for key, kind in (("events", "事件"), ("movementLogs", "外出动向"), ("sosSessions", "应急呼救"), ("devices", "安全设备"), ("weatherAlerts", "天气预警"), ("safetyCheckins", "报平安")):
        found = next((x for x in state.get(key, []) if isinstance(x, dict) and x.get("id") == rid), None)
        if found:
            record = _event_row(found) if key == "events" else {k: v for k, v in found.items() if not re.search(r"phone|Phone|idCard|transcript|evidence|timeline", k)}
            if key == "events":
                record["处置经过"] = [t.get("text") for t in (found.get("timeline") or [])[-3:] if isinstance(t, dict)]
            return {"found": True, "类型": kind, "record": record}
    if rid.startswith("IN-"):
        rows = [row for row in tool_query_institutions(state, {})["items"] if row["id"] == rid]
        if rows:
            return {"found": True, "类型": "机构", "record": rows[0]}
    if rid.startswith("CL-"):
        rows = [row for row in tool_query_radar(state, {})["items"] if row["id"] == rid]
        if rows:
            return {"found": True, "类型": "类案", "record": rows[0]}
    resident = next((r for r in state.get("residents", []) if isinstance(r, dict) and r.get("id") == rid), None)
    if resident:
        return {"found": True, "类型": "老人档案", "record": _resident_row(resident, state)}
    return {"found": False, "id": rid, "note": "台账中没有这个编号"}


def tool_query_institutions(state: dict[str, Any], args: dict[str, Any]) -> dict[str, Any]:
    name = str(args.get("name") or "").strip()
    events = state.get("events", [])
    residents = {r.get("id"): r for r in state.get("residents", []) if isinstance(r, dict)}
    rows = []
    for inst in state.get("institutions", []):
        if name and name not in inst.get("name", "") and inst.get("name", "") not in name:
            continue
        related = [e for e in events if inst.get("name") and insight.institution_of(e, state.get("institutions", []), residents) == inst["name"]]
        rows.append({"id": inst.get("id"), "name": inst.get("name"), "city": inst.get("city"), "在住老人": inst.get("residents"), "预警数": inst.get("alerts"), "平均响应": inst.get("response"), "办结率": inst.get("closure"), "综合评分": inst.get("score"), "状态": inst.get("status"),
                     "台账事件": len(related), "未办结": sum(e.get("status") in OPEN for e in related), "投诉类": sum(e.get("category") in {"服务投诉", "消费纠纷"} for e in related), "事件编号": [e.get("id") for e in related][:8]})
    return {"count": len(rows), "items": rows}


def tool_query_movements(state: dict[str, Any], args: dict[str, Any]) -> dict[str, Any]:
    status = str(args.get("status") or "").strip()
    items = [m for m in state.get("movementLogs", []) if isinstance(m, dict)]
    if status == "待监管确认":
        items = [m for m in items if m.get("regulatorStatus") == "待确认"]
    elif status:
        items = [m for m in items if m.get("status") == status]
    return {"count": len(items), "items": [{"id": m.get("id"), "resident": m.get("resident"), "status": m.get("status"), "destination": m.get("destination"), "expectedReturn": m.get("expectedReturn"), "responsible": m.get("responsible"), "regulatorStatus": m.get("regulatorStatus"), "eventId": m.get("eventId")} for m in items[:8]]}


def tool_query_radar(state: dict[str, Any], _args: dict[str, Any]) -> dict[str, Any]:
    events = state.get("events", [])
    handled = {b.get("clusterId") for b in state.get("broadcasts") or []} | {e.get("clusterId") for e in events if e.get("clusterId")}
    rows = []
    radar = case_radar.radar_events(state)
    for cluster in case_radar.find_clusters(radar, features=case_radar.cached_features(radar)):
        rows.append({"id": cluster["id"], "类型": "涉老诈骗" if cluster["kind"] == "fraud" else "消费纠纷", "title": case_radar.template_report(cluster)["title"], "risk": LEVEL.get(cluster["risk"]), "老人数": len(cluster["residents"]), "件数": cluster["count"], "共同线索": cluster["clues"][:4], "发现方式": cluster["found_by"], "已处置": "是" if cluster["id"] in handled else "否", "预警后主动求证": cluster.get("intercepted", 0), "个案编号": cluster["event_ids"]})
    return {"count": len(rows), "items": rows}


def tool_query_sos(state: dict[str, Any], args: dict[str, Any]) -> dict[str, Any]:
    items = [s for s in state.get("sosSessions", []) if isinstance(s, dict)]
    if args.get("active_only", True):
        items = [s for s in items if s.get("status") in {"waiting", "claimed"}]
    outcome = {"on_time": "按时接单", "late": "超时后接单", "missed": "超时未接单", "pending": "时限内待接单", "excluded": "时限内本人取消（不计考核）", "unknown": "缺少时间记录"}
    summary = sla.sos_summary([s for s in state.get("sosSessions", []) if isinstance(s, dict)])
    return {"count": len(items), "接单考核": {"已到考核时点": summary["assessed"], "按时接单": summary["on_time"], "超时后接单": summary["late"], "超时未接单": summary["missed"], "整体响应达标率": f"{summary['overall_rate']}%" if summary["overall_rate"] is not None else "暂无", "口径": "分母含已到考核时点仍无人接单的工单"},
            "items": [{"id": s.get("id"), "resident": s.get("resident"), "status": {"waiting": "待接单", "claimed": "已接单", "resolved_safe": "已确认安全", "resolved_handled": "处置完成", "resolved_dispatched": "已联动120/110", "cancelled": "本人取消"}.get(s.get("status"), s.get("status")), "escalation": s.get("escalation"), "responseSeconds": s.get("responseSeconds"), "考核结果": outcome[sla.sos_outcome(s)], "location": s.get("location")} for s in items[:8]]}


def tool_query_care(state: dict[str, Any], _args: dict[str, Any]) -> dict[str, Any]:
    """AI 主动预警的结果：已有 DeepSeek 研判时直接沿用（缓存），否则用规则信号排序，不在这里另外调用模型。"""
    out = care.analyze(state, allow_model=False)
    rows = [{"resident": i["name"], "priority": LEVEL.get(i["priority"]), "结论": i["headline"], "关联研判": i["insight"], "建议": [f"{a['who']}{a['when']}{a['what']}" for a in i["actions"]],
             "证据编号": [e for e in i["evidence"] if ID_RE.fullmatch(e)], "来源": i["by"]} for i in out["items"] if i["priority"] != "low"]
    return {"count": len(rows), "今日必须处理": out["counts"]["high"], "今日留意": out["counts"]["medium"], "items": rows[:6]}


def tool_query_insight(state: dict[str, Any], _args: dict[str, Any]) -> dict[str, Any]:
    """运行态势与服务质量：由台账计算，研判要点与扣分项都带编号。"""
    out = insight.analyze(state)
    quality = [{"机构": q["name"], "id": q["id"], "计算得分": q["score"] if q["sufficient"] else "样本不足，未计算", "等级": q["grade"], "填报参考分": q["reference_score"],
                "扣分项": [f"{d['item']} {d['count']} 项 −{d['points']}（{'、'.join(d['evidence'][:3])}）" for d in q["deductions"]], "指标": q["metrics"]} for q in out["quality"]]
    scenes = {k: {"事件": v["total"], "未办结": v["open"], "编号": v["ids"][:4]} for k, v in out["events"]["by_scene"].items()}
    return {"说明": out["note"], "人群": {"居住场景": out["population"]["scenes"], "客源地大区": out["population"]["regions"], "独居": out["population"]["living_alone"]},
            "事件按场景": scenes, "外出": {"跨市": out["movements"]["cross_city"], "出境或边境行程": out["movements"]["border"], "超时未归": out["movements"]["overdue"]},
            "安全设备": {"总数": out["devices"]["total"], "在线率": out["devices"]["online_rate"], "离线": out["devices"]["offline"], "低电量": out["devices"]["low_battery"]},
            "报平安": out["weather"], "服务质量评价": quality, "评分规则": out["quality_rule"], "研判要点": [{"text": f["text"], "evidence": f["evidence"]} for f in out["findings"]]}


def tool_query_weather(state: dict[str, Any], _args: dict[str, Any]) -> dict[str, Any]:
    active = [a for a in state.get("weatherAlerts", []) if a.get("status") == "生效中"]
    ids = {a.get("id") for a in active}
    unanswered = [c for c in state.get("safetyCheckins", []) if c.get("alertId") in ids and c.get("status") == "pending"]
    return {"count": len(active), "预警": [{"id": a["id"], "类型": a["type"], "等级": a["level"], "城市": a["cities"], "来源": a["source"]} for a in active],
            "报平安": weather.checkin_summary(state),
            "未回应": [{"id": c["id"], "resident": c["resident"], "institution": c["institution"], "超时": bool(c.get("escalatedAt"))} for c in unanswered[:8]]}


TOOLS: dict[str, tuple[Callable[..., dict[str, Any]], str, str, dict[str, Any]]] = {
    "overview": (tool_overview, "查看监管总览", "全局数字：未办结事件、高风险、外出与超时、呼救、类案。回答“整体情况”类问题先调用。", {"type": "object", "properties": {}}),
    "query_events": (tool_query_events, "查询事件台账", "按类别、风险、机构、关键词筛选事件。", {"type": "object", "properties": {"category": {"type": "string", "enum": ["涉老诈骗风险", "服务投诉", "消费纠纷", "健康异常", "健康提醒", "设施报修", "失联风险", "行程变更"]}, "level": {"type": "string", "enum": ["high", "medium", "low"]}, "institution": {"type": "string"}, "keyword": {"type": "string"}, "open_only": {"type": "boolean", "description": "默认只看未办结"}}}),
    "query_institutions": (tool_query_institutions, "查询机构情况", "查看机构评分、响应、办结率及其台账事件。", {"type": "object", "properties": {"name": {"type": "string", "description": "机构名称，可只写一部分；不填为全部"}}}),
    "query_movements": (tool_query_movements, "查询外出动向", "查看外出中、超时未归或待监管确认的动向。", {"type": "object", "properties": {"status": {"type": "string", "enum": ["外出中", "超时未归", "待出发", "已返回", "待监管确认"]}}}),
    "query_radar": (tool_query_radar, "查询类案雷达", "查看自动归并的类案及处置情况。", {"type": "object", "properties": {}}),
    "query_care": (tool_query_care, "查询主动预警", "查看 AI 主动预警：今天哪些老人需要重点关注、为什么、建议谁做什么。", {"type": "object", "properties": {}}),
    "query_sos": (tool_query_sos, "查询应急呼救", "查看呼救工单与响应情况。", {"type": "object", "properties": {"active_only": {"type": "boolean"}}}),
    "query_insight": (tool_query_insight, "查询运行态势与服务质量", "产业运行态势（人群居住场景、客源地、事件按场景分布、跨市与出境行程、安全设备在线）和按台账计算的机构服务质量评分及扣分依据。问态势、趋势、服务质量评价、居家社区、边境、设备时调用。", {"type": "object", "properties": {}}),
    "query_weather": (tool_query_weather, "查询天气预警与报平安", "查询当前模拟天气预警、报平安率、未回应和超时待跟进名单。", {"type": "object", "properties": {}}),
    "query_residents": (tool_query_residents, "查询老人档案", "按姓名、是否独居、居住方式、机构、风险、客源地查老人概况（不含电话证件号），包括所用安全设备、未办结事件和当前动向。问某位老人或某类老人时调用。", {"type": "object", "properties": {"name": {"type": "string"}, "living_alone": {"type": "boolean"}, "scene": {"type": "string", "enum": ["机构入住", "居家旅居", "社区嵌入"]}, "institution": {"type": "string"}, "risk": {"type": "string", "enum": ["high", "medium", "low"]}, "source": {"type": "string", "description": "客源地，如“北京”“湖南”"}}}),
    "get_record": (tool_get_record, "按编号查记录", "按编号查一条记录（EV/MV/IN/CL/SOS/DV/WA/CK 或老人档案号 GX-…）。", {"type": "object", "properties": {"id": {"type": "string"}}, "required": ["id"]}),
}
TOOL_ICONS = {"query_residents": "contact-round", "get_record": "file-search", "overview": "layout-dashboard", "query_events": "siren", "query_institutions": "building-2", "query_movements": "map-pinned", "query_radar": "radar", "query_sos": "phone-call", "query_care": "heart-pulse", "query_insight": "chart-no-axes-combined", "query_weather": "cloud-lightning"}

SYSTEM_PROMPT = """
你是自治区旅居养老监管部门的“AI 监管参谋”，服务对象是监管干部。
1. 先调用工具查台账再回答；数字、名称、时间只能来自工具结果，工具里没有的就说“台账中没有相关记录”，不得编造。
2. 每条发现都要附上证据编号（事件 EV-…、动向 MV-…、机构 IN-…、类案 CL-…、呼救 SOS-…、安全设备 DV-…、天气预警 WA-…、报平安 CK-…），编号必须是工具结果里原样出现过的完整编号，不要缩写；evidence 里只填编号。
   问到数量时，除了看总览，还要用 query_events 等工具把对应记录查出来作为证据。
3. 先给结论再给依据；督办建议要写清找谁、做什么、什么时限，不直接认定违法。
4. 这是演示样本台账，涉及“全区”判断时要注明“样本范围内”。不要泄露老人电话、证件号等隐私。
5. 问到某位老人或某类老人（独居、居家、社区、某地来的、高风险）时，用 query_residents 查；老人档案号 GX-… 也可以作为证据。
6. 你只能查询，不能修改台账。监管员要求标记、办结、转派、删除记录时，answer 第一句写明“AI 参谋只能查询，不能直接修改台账”，再说明这条记录现在的状态、应由谁在哪里办理。
""".strip()

FORMAT_PROMPT = """
根据以上工具结果，只输出一个JSON对象，不要Markdown。字段：
answer（结论，≤120字）、findings（最多4条，每条 {"text": ≤60字, "evidence": [证据编号]}）、
suggestions（督办建议，最多3条，每条≤30字）、followups（监管员接下来可能想问的问题，最多3条，每条≤20字）。
""".strip()

DRAFT_PROMPT = """
监管员要求起草文书，另加字段 draft：一份可以直接修改后印发的督办通知正文（≤500字，用换行分段），依次写：
标题；致送单位（机构全称加冒号）；事由（样本台账查到的问题，引用事件等完整编号）；督办要求（逐条编号，每条写清做什么、什么时限内反馈）；
回复方式（通过平台回传处置结果）；落款“旅居养老监管部门（待审核）”和“年 月 日”。只写台账里查到的事实，不写“违法”“处罚”等定性用语。
写件数时直接用工具结果里的 count，列出的编号个数要和件数一致。
""".strip()


class Trace:
    def __init__(self) -> None:
        self.steps: list[dict[str, Any]] = []
        self.ids: set[str] = set()
        self.results: dict[str, Any] = {}

    def add(self, kind: str, title: str, detail: str, ms: int = 0, tool: str = "") -> None:
        self.steps.append({"kind": kind, "title": title, "detail": detail[:160], "ms": ms, "tool": tool})

    def run(self, state: dict[str, Any], name: str, args: dict[str, Any]) -> dict[str, Any]:
        func, label, _, _ = TOOLS[name]
        started = time.perf_counter()
        try:
            result = func(state, args if isinstance(args, dict) else {})
        except Exception as error:  # 单个工具出错不影响整体回答
            result = {"error": str(error)[:80]}
        self.results[name] = result
        self.ids |= set(EVIDENCE_RE.findall(json.dumps(result, ensure_ascii=False)))
        labels = {"living_alone": "独居", "open_only": "含已办结", "active_only": "含已结束"}
        filters = "、".join(LEVEL.get(v, v) if isinstance(v, str) else labels.get(k, k) for k, v in (args or {}).items() if v not in (None, "", True) or (k == "living_alone" and v is True))
        count = f"共 {result['count']} 条" if "count" in result else ("找到 1 条" if result.get("found") else "没有这个编号") if "found" in result else f"研判要点 {len(result['研判要点'])} 条 · 机构评分 {len(result['服务质量评价'])} 家" if "研判要点" in result else "已汇总全局数字"
        detail = f"{'条件：' + filters + '；' if filters else ''}{count}"
        self.add("tool", label, detail, int((time.perf_counter() - started) * 1000), name)
        return result


def tool_schemas() -> list[dict[str, Any]]:
    return [{"type": "function", "function": {"name": name, "description": spec[2], "parameters": spec[3]}} for name, spec in TOOLS.items()]


def _tool_names(text: Any) -> str:
    """回答里偶尔会带出英文工具名，换成中文说法（如 query_residents → 查询老人档案）。"""
    text = str(text or "")
    for name, spec in TOOLS.items():
        text = text.replace(name, spec[1])
    return text


def _no_ids(text: Any) -> str:
    text = strip_ids(re.sub(RESIDENT_ID, "", _tool_names(text)))
    return re.sub(r"([。，；：！？、])\s+", r"\1", text)  # 删掉编号后留下的空格


def _draft_text(text: Any, keep: set[str]) -> str:
    """文书保留换行和核对过的编号，其余编号删去。"""
    text = re.sub(r"[*#`>]+", "", str(text or ""))
    text = EVIDENCE_RE.sub(lambda m: m.group(0) if m.group(0) in keep else "", text)
    text = re.sub(r"[（(]\s*[，、,；]?\s*[）)]", "", text)
    text = re.sub(r"[ \t]+\n", "\n", re.sub(r"\n{3,}", "\n\n", text)).strip()
    return text[:800]


def finalize(card: dict[str, Any], trace: Trace) -> dict[str, Any]:
    """证据编号逐一核对：只保留工具结果里真实出现过的编号。"""
    findings, fake = [], set()
    for item in (card.get("findings") or [])[:4]:
        if not isinstance(item, dict):
            continue
        cited = [m for x in item.get("evidence") or [] if isinstance(x, (str, int)) for m in EVIDENCE_RE.findall(str(x))]  # evidence 里的非编号文字直接忽略
        cited += EVIDENCE_RE.findall(str(item.get("text", "")))
        valid = [x for x in dict.fromkeys(cited) if x in trace.ids]
        fake |= {x for x in cited if x not in trace.ids}
        findings.append({"text": _plain(_no_ids(item.get("text", "")), 70), "evidence": valid[:6]})
    for field in ("answer", "suggestions", "draft"):
        values = card.get(field) if isinstance(card.get(field), list) else [card.get(field)]
        fake |= {x for v in values for x in EVIDENCE_RE.findall(str(v or "")) if x not in trace.ids}
    dropped = len(fake)
    if dropped:
        trace.add("note", "证据核对", f"删去 {dropped} 个台账中不存在的编号")
    out = {
        "answer": _plain(_no_ids(card.get("answer") or "已查询台账，请看下方发现。"), 140),
        "findings": findings,
        "suggestions": [_plain(_tool_names(s), 48, keep=trace.ids) for s in (card.get("suggestions") or []) if str(s).strip()][:3],
        "followups": [_plain(s, 24) for s in (card.get("followups") or []) if str(s).strip()][:3],
        "dropped_ids": dropped,
    }
    if str(card.get("draft") or "").strip():
        out["draft"] = _draft_text(card["draft"], trace.ids)
    return out


def run_model(question: str, state: dict[str, Any], config: dict[str, str], endpoint: str, clean: Callable[[str], str]) -> dict[str, Any]:
    trace = Trace()
    trace.add("perceive", "理解监管问题", f"“{question[:60]}”")
    messages: list[dict[str, Any]] = [{"role": "system", "content": SYSTEM_PROMPT}, {"role": "user", "content": question}]
    mentioned = list(dict.fromkeys(EVIDENCE_RE.findall(question)))[:3]
    if mentioned:  # 问题里直接给了编号：先把这几条记录查出来，模型不用猜
        trace.add("note", "先查问题里的编号", "、".join(mentioned))
        found = {rid: trace.run(state, "get_record", {"id": rid}) for rid in mentioned}
        messages.append({"role": "user", "content": "问题里提到的编号，台账查询结果：" + json.dumps(found, ensure_ascii=False)})
    if WRITE_RE.search(re.sub(r"\s+", "", question)):
        trace.add("guard", "只读保护", "AI 参谋不修改台账：说明记录现状和办理途径，由承办人在系统中操作")
        messages.append({"role": "system", "content": "监管员要求修改台账。你只能查询，不能修改：按规则 6 回答。"})
    drafting = bool(DRAFT_RE.search(question))
    for _ in range(4):
        started = time.perf_counter()
        reply = _post(config, {"model": config["model"], "messages": messages, "tools": tool_schemas(), "tool_choice": "auto", "temperature": 0.2, "max_tokens": 600}, endpoint)
        choice = reply["choices"][0]["message"]
        calls = [c for c in choice.get("tool_calls") or [] if c.get("function", {}).get("name") in TOOLS]
        if not calls:
            break
        trace.add("plan", "规划查询", "决定查询：" + "、".join(TOOLS[c["function"]["name"]][1] for c in calls), int((time.perf_counter() - started) * 1000))
        messages.append({"role": "assistant", "content": choice.get("content") or "", "tool_calls": calls})
        for call in calls:
            try:
                args = json.loads(call["function"].get("arguments") or "{}")
            except json.JSONDecodeError:
                args = {}
            result = trace.run(state, call["function"]["name"], args)
            messages.append({"role": "tool", "tool_call_id": call.get("id", ""), "content": json.dumps(result, ensure_ascii=False)})
    if not trace.results:  # 模型一个工具都没查：先补查总览，避免凭空回答
        trace.add("note", "规则补全", "模型未查询台账，先补查监管总览")
        result = trace.run(state, "overview", {})
        messages.append({"role": "user", "content": "台账总览：" + json.dumps(result, ensure_ascii=False)})
    messages.append({"role": "user", "content": FORMAT_PROMPT + ("\n" + DRAFT_PROMPT if drafting else "")})
    started = time.perf_counter()
    reply = _post(config, {"model": config["model"], "messages": messages, "temperature": 0.1, "max_tokens": 1400 if drafting else 700, "response_format": {"type": "json_object"}}, endpoint)
    card = json.loads(clean(reply["choices"][0]["message"]["content"]))
    trace.add("decide", "形成研判", "核对证据编号，生成督办建议", int((time.perf_counter() - started) * 1000))
    return {"card": finalize(card, trace), "trace": trace.steps}


def run_rules(question: str, state: dict[str, Any]) -> dict[str, Any]:
    """无模型时：关键词决定查询哪些工具，按模板组织回答。"""
    trace = Trace()
    text = re.sub(r"\s+", "", question)
    trace.add("perceive", "理解监管问题", f"“{question[:60]}”")
    mentioned = list(dict.fromkeys(EVIDENCE_RE.findall(question)))[:3]
    if mentioned:
        trace.add("plan", "规划查询", "问题里有编号：按编号查记录")
        found = [(rid, trace.run(state, "get_record", {"id": rid})) for rid in mentioned]
        described = [f"{r['类型']}“{r['record'].get('title') or r['record'].get('name') or r['record'].get('resident') or rid}”当前状态：{r['record'].get('status') or r['record'].get('状态') or '—'}" if r["found"] else f"台账中没有编号 {rid} 的记录" for rid, r in found]
        answer = "；".join(described) + "。"
        if WRITE_RE.search(text):
            trace.add("guard", "只读保护", "AI 参谋不修改台账")
            answer = "AI 参谋只能查询，不能直接修改台账。" + answer + "请由承办人在事件详情中处置并留痕。"
        card = {"answer": answer, "findings": [{"text": d[:60], "evidence": [rid]} for (rid, r), d in zip(found, described) if r["found"]], "suggestions": [], "followups": ["这周有哪些事要督办？"]}
        trace.add("decide", "形成研判", "按编号给出记录现状")
        return {"card": finalize(card, trace), "trace": trace.steps}
    institution = next((i["name"] for i in state.get("institutions", []) if i.get("name") and (i["name"] in text or re.sub(r"(康养中心|颐养公寓|康养基地|旅居中心|颐养社区)$", "", i["name"]) in text)), "")
    findings: list[dict[str, Any]] = []
    if institution:
        trace.add("plan", "规划查询", f"问题涉及机构“{institution}”：查机构情况与相关事件")
        inst = trace.run(state, "query_institutions", {"name": institution})["items"][0]
        ev = trace.run(state, "query_events", {"institution": institution})
        answer = f"{institution}：综合评分 {inst['综合评分']}，办结率 {inst['办结率']}%，台账相关事件 {inst['台账事件']} 件，其中未办结 {inst['未办结']} 件、投诉类 {inst['投诉类']} 件。"
        findings = [{"text": f"{e['title']}（{e['level']}，{e['status']}）", "evidence": [e["id"]]} for e in ev["items"][:4]]
    elif re.search(r"台风|高温|天气|报平安", text):
        trace.add("plan", "规划查询", "问题涉及天气预警与报平安：查询模拟预警和回执")
        view = trace.run(state, "query_weather", {})
        summary = view["报平安"]
        answer = f"当前生效的模拟天气预警 {view['count']} 条；报平安率 {summary['rate']}%，未回应 {summary['pending']} 位，其中超时待跟进 {summary['overdue']} 位、请求帮助 {summary['help']} 位。"
        findings = [{"text": f"{c['resident']}报平安未回应{'且已超时' if c['超时'] else ''}", "evidence": [c["id"]]} for c in view["未回应"][:4]]
    elif re.search(r"态势|趋势|运行|质量评价|服务质量|评分|居家|社区|边境|出境|设备", text):
        trace.add("plan", "规划查询", "问题涉及运行态势或服务质量：查态势研判与质量评价")
        view = trace.run(state, "query_insight", {})
        scored = [q for q in view["服务质量评价"] if isinstance(q["计算得分"], (int, float))]
        answer = f"样本范围内居住场景：{'、'.join(f'{k}{v}人' for k, v in view['人群']['居住场景'].items())}；安全设备在线率 {view['安全设备']['在线率']}%。" + (f"按台账计算，{scored[0]['机构']} {scored[0]['计算得分']} 分（{scored[0]['等级']}）。" if scored else "")
        findings = [{"text": f["text"][:60], "evidence": f["evidence"]} for f in view["研判要点"]][:4]
    elif re.search(r"超时|外出|没回|报备|走失", text):
        trace.add("plan", "规划查询", "问题涉及外出动向：查超时未归与待确认动向")
        late = trace.run(state, "query_movements", {"status": "超时未归"})
        pending = trace.run(state, "query_movements", {"status": "待监管确认"})
        answer = f"当前超时未归 {late['count']} 人，待监管确认的外出报备 {pending['count']} 条。"
        findings = [{"text": f"{m['resident']} 前往{m['destination']}，{m['status']}，责任人{m['responsible']}", "evidence": [m["id"]] + ([m["eventId"]] if m.get("eventId") else [])} for m in (late["items"] + pending["items"])[:4]]
    elif re.search(r"类案|诈骗|骗|预付|定金", text):
        trace.add("plan", "规划查询", "问题涉及涉老诈骗：查类案雷达与诈骗事件")
        radar = trace.run(state, "query_radar", {})
        ev = trace.run(state, "query_events", {"category": "涉老诈骗风险"})
        answer = f"类案雷达发现 {radar['count']} 类类案；未办结涉老诈骗风险事件 {ev['count']} 件。"
        findings = [{"text": f"{c['title']}：{c['老人数']} 位老人，{'已处置' if c['已处置'] else '待处置'}", "evidence": [c["id"]] + c["个案编号"][:3]} for c in radar["items"] if c["类型"] == "涉老诈骗"][:2]
    elif re.search(r"投诉|收费|多收", text):
        trace.add("plan", "规划查询", "问题涉及投诉：查投诉类事件")
        ev = trace.run(state, "query_events", {"category": "服务投诉"})
        answer = f"未办结服务投诉 {ev['count']} 件。"
        findings = [{"text": f"{e['title']}（{e['resident']}，{e['status']}）", "evidence": [e["id"]]} for e in ev["items"][:4]]
    elif re.search(r"呼救|sos|急救", text, re.I):
        trace.add("plan", "规划查询", "问题涉及应急呼救：查进行中的呼救")
        sos = trace.run(state, "query_sos", {})
        answer = f"进行中的呼救 {sos['count']} 起。"
        findings = [{"text": f"{s['resident']}：{s['status']}", "evidence": [s["id"]]} for s in sos["items"][:4]]
    elif re.search(r"关注|重点|预警|哪些老人|谁最", text):
        trace.add("plan", "规划查询", "问题涉及重点关注老人：查 AI 主动预警")
        watch = trace.run(state, "query_care", {})
        answer = f"今天需要当面处理 {watch['今日必须处理']} 位老人，需要留意 {watch['今日留意']} 位。"
        findings = [{"text": f"{c['resident']}：{c['结论']}", "evidence": c["证据编号"][:3]} for c in watch["items"] if c["证据编号"]][:4]
    else:
        trace.add("plan", "规划查询", "问题较宽泛：先看总览，再列高风险未办结事件")
        ov = trace.run(state, "overview", {})
        ev = trace.run(state, "query_events", {"level": "high"})
        answer = f"样本范围内未办结事件 {ov['未办结事件']} 件（高风险 {ov['其中高风险']} 件），超时未归 {ov['超时未归']} 人，高风险类案 {ov['高风险类案']} 类。"
        findings = [{"text": f"{e['title']}（{e['resident']}，{e['status']}，{e['deadline']}）", "evidence": [e["id"]]} for e in ev["items"][:4]]
    card = {"answer": answer, "findings": findings, "suggestions": ["高风险事件按时限逐件督办", "超时未归由机构责任人当日回复", "类案线索汇总移交属地部门"], "followups": ["这周有哪些事要督办？", "有没有老人外出超时没回来？", "北海银龄康养中心情况怎么样？"]}
    if DRAFT_RE.search(question) and institution:
        items = trace.results.get("query_events", {}).get("items", [])[:5]
        card["draft"] = "\n".join([f"关于督促{institution}限期处置旅居老人风险事项的通知", "", f"{institution}：",
                                    f"经查询监管台账（样本范围内），你单位现有未办结事件 {inst['未办结']} 件，其中投诉类 {inst['投诉类']} 件。请按以下要求办理：",
                                    *[f"{i}. {e['title']}（{e['id']}，{e['level']}，{e['status']}）：" + _deadline_clause(e) for i, e in enumerate(items, 1)],
                                    "", "请通过平台回传处置结果和佐证材料。", "", "旅居养老监管部门（待审核）", "年  月  日"])
    trace.add("decide", "形成研判", "按模板组织回答，证据编号来自查询结果")
    return {"card": finalize(card, trace), "trace": trace.steps}
