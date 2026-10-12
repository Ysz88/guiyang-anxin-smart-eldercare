"""旅居守护智能体：大模型负责理解与规划，工具负责查证与办事，全程留下可审计的执行轨迹。

流程：安全红线（在 server.py 中先于本模块执行）→ 大模型按需调用工具 → 大模型输出结构化结论
→ 服务端按白名单校正电话、补齐待确认动作。没有配置模型或模型出错时，用同一组工具走本地规则规划，
界面仍能展示完整的执行轨迹，但会标明"未连接大模型"。
"""
from __future__ import annotations

import json
import re
import time
import urllib.request
from datetime import datetime, timedelta
from typing import Any, Callable

import case_radar
from route_risk import PLACES, assess_route

MAX_TOOL_ROUNDS = 5
HOTLINES = {"120": "急救", "110": "报警", "12315": "消费维权", "12345": "政务服务便民热线"}
FRAUD_WORDS = r"免费领|领鸡蛋|送鸡蛋|免费送|送礼品|领礼品|定金|交钱|转账|汇款|投资|返利|高回报|保本|分红|保健品|特效|包治|验证码|包住|包吃包住|免费体检|会员卡|预付|充值(?:返|送|赠|翻倍)|办卡(?:打折|优惠|送|返)|点链接|解冻|手续费|扫码领|领红包|墓地|升值|养老项目|名额有限|今天必须|马上交|稳赚|理财|年化|高息|中奖|领奖|安全账户|刷单|公检法|洗钱"
# 出行的“安全下限”用更严格的说法，避免“买到”“走到”这类字眼被误判为出行
INJECTION = r"忽略.{0,8}(?:规则|指令|设定|要求)|系统提示|提示词|越狱|扮演.{0,6}(?:角色|别人)|prompt"
TRIP_FLOOR = r"想.{0,6}(?:去|爬山|旅游|逛|玩)|出门|外出|游玩|爬山|登山|去.{1,10}(?:玩|逛|走走|看看|旅游|爬山)"
COMPLAINT_WORDS = r"多收|乱收费|收费不对|退款|不退|服务差|态度差|投诉|维权|价格不一致|被坑|强制购物|购物店|玉器店|开光"
# 钱已经付出去：此时“先别交钱”已经晚了，第一步必须是报警和银行止付
PAID_WORDS = r"已经.{0,4}(?:交|付|转|汇|打|给)|(?:交|付|转|汇|打)(?:了|过)(?:钱|款|定金|过去|一万|[0-9一二两三四五六七八九十百千万]+)|(?:钱|款|定金).{0,4}(?:交了|付了|转了|给了|打过去)|被骗了|上当了|钱没了|验证码.{0,6}(?:给|报|告诉|说)(?:[^，。]{0,3})(?:了|过|出去)|(?:给|报|告诉|说)(?:了|过).{0,4}验证码"
PAID_ACTION = "马上打110报警，再打银行客服电话，申请止付、冻结这笔钱"
# 家人要钱：可能是真的（真住院、真借钱），也可能是冒充。没转、也没有冒充迹象时先核实，不报警、不开工单
FAMILY_WORDS = r"儿子|女儿|孙子|孙女|外孙|儿媳|女婿|侄子|侄女|外甥|老伴|亲戚|家里人|孩子"
ASK_MONEY = r"(?:要|让|叫|喊)我.{0,6}(?:转|汇|打|给|借|拿|交)|借.{0,4}钱|要钱|打钱|汇钱|转钱|急需|急用|(?:转|汇)(?:给)?(?:他|她)|保释金|押金|手术费|医药费|住院费|学费|赔偿|罚款|[0-9一二两三四五六七八九十百千万]+(?:块|元)"
FAMILY_GIFT = r"我(?:想|要|打算|准备)(?:给|转|包|随)|随礼|红包|压岁钱|生活费|份子钱"
IMPERSONATION = r"换(?:了)?(?:个)?(?:新)?(?:号|手机号|电话|微信)|新号|新微信|陌生(?:号码|电话|人|账户|账号)|号码(?:变|换)|声音(?:不像|不太像|变了)|别告诉|不让.{0,4}(?:告诉|说)|不要.{0,2}告诉|保密|(?:同学|朋友|别人|老师|领导)的(?:卡|账户|账号)|视频.{0,4}(?:打不开|看不清|接不通)|手机(?:坏|摔|丢|掉)|猜猜.{0,2}是谁|猜.{0,2}是谁|听出.{0,2}是谁|有人.{0,8}(?:说|自称).{0,2}是我|自称是|冒充|车祸|撞(?:了)?人|被(?:抓|拘|扣)|派出所|保释|私了|验证码|加(?:个)?(?:微信|QQ)"
VERIFY_ACTION = "先别转钱。打{who}平常用的那个号码，问清楚是不是真的"
VERIFY_WARN = "对方要是换了号码、催着马上要钱、不让告诉别人，那就是骗子，别转，直接打110"


def family_money(message: str) -> str:
    """paid 已经转了；impersonation 有冒充迹象；gift 老人自己要给家人钱；verify 家人要钱待核实；空串表示不相关。"""
    text = re.sub(r"\s+", "", message)
    if not re.search(FAMILY_WORDS, text):
        return ""
    if re.search(PAID_WORDS, text):
        return "paid"
    if re.search(FAMILY_GIFT, text) and not re.search(IMPERSONATION, text):
        return "gift"
    if not re.search(ASK_MONEY, text):
        return ""
    return "impersonation" if re.search(IMPERSONATION, text) else "verify"


def _relative(message: str, state: dict[str, Any]) -> tuple[str, str]:
    """老人说的是哪位家人；和档案里登记的紧急联系人不是同一人时，另外提示可以请登记的联系人帮忙问。"""
    contact, _ = _contact(state)
    said = re.search(FAMILY_WORDS, re.sub(r"\s+", "", message))
    who = said.group(0) if said else "家里人"
    if who in contact:
        return contact, ""
    return who, f"也可以请{contact}帮您问问"


def _contact(state: dict[str, Any]) -> tuple[str, str]:
    """紧急联系人（档案里登记的子女）：名字去掉括号里的关系，电话保持脱敏。"""
    profile = _profile(state)
    name = str(profile.get("emergencyName") or "")
    relation = re.search(r"[（(](.+?)[）)]", name)
    short = f"{relation.group(1)}{re.sub(r'[（(].*', '', name)}" if relation else (name or "家里人")
    return short, str(profile.get("emergencyPhone") or "")
# 低价团：团费明显低于成本、行程含购物点，常见强制购物
LOW_PRICE_TOUR = r"零团费|低价团|强制购物|购物点|进店|团费(?:才|只要|只)?[0-9一二三四五六七八九十百]{1,4}(?:元|块)|[0-9一二三四五六七八九十百]{2,4}(?:元|块)钱?.{0,10}(?:一日游|团|玩一天|玩两天)"
BORDER_ACTION = "出境前备好护照或通行证，买含境外医疗的意外险，开通国际漫游"
LOW_PRICE_ACTION = "低价团常带进店强制购物，先别交团费，核实旅行社资质和合同"
TRIP_WORDS = r"去|到|想.{0,6}(?:爬山|旅游|逛|玩|散步|看看|走走)|出门|外出|游玩|爬山|登山|明天|后天|周末"


# --------------------------------------------------------------------------- 工具

def _profile(state: dict[str, Any]) -> dict[str, Any]:
    return state.get("profile") if isinstance(state.get("profile"), dict) else {}


def tool_get_resident_profile(state: dict[str, Any], _args: dict[str, Any]) -> dict[str, Any]:
    p = _profile(state)
    screening = p.get("screening") if isinstance(p.get("screening"), dict) else {}
    dims = {d.get("label"): f"{d.get('value')}（{ {'low': '正常', 'medium': '需关注', 'high': '高风险', 'unknown': '缺项'}.get(d.get('level'), '未知') }）" for d in screening.get("dimensions", []) if isinstance(d, dict)}
    consents = p.get("consents") if isinstance(p.get("consents"), dict) else {}
    return {
        "age": p.get("age"),
        "stay_city": p.get("stayCity", "未知"),
        "institution": p.get("institution", "未知"),
        "conditions": p.get("conditions", []),
        "allergy": p.get("allergy", "未知"),
        "mobility": dims.get("肢体活动", "未知"),
        "screening_overall": screening.get("overall", "未评估"),
        "cross_region_consent": bool(consents.get("crossRegion")),
        "emergency_contact": p.get("emergencyName", "未登记"),
        "emergency_phone_registered": bool(p.get("emergencyPhone")),
    }


def tool_get_current_movement(state: dict[str, Any], _args: dict[str, Any]) -> dict[str, Any]:
    own = _profile(state).get("id")
    logs = [log for log in state.get("movementLogs", []) if isinstance(log, dict) and log.get("residentId") == own]
    active = next((log for log in logs if log.get("status") in {"外出中", "就医中", "在途中", "超时未归", "待出发"}), None)
    if not active:
        return {"outside_now": False, "pending_report": False, "note": "当前在机构内，无进行中的外出报备"}
    return {"outside_now": active.get("status") != "待出发", "pending_report": active.get("status") == "待出发", "destination": active.get("destination"), "status": active.get("status"), "responsible": active.get("responsible")}


def _find_places(query: str) -> list[dict[str, Any]]:
    text = re.sub(r"\s+", "", query or "")
    scored = []
    for place in PLACES:
        hits = sum(1 for alias in place.get("aliases", []) if alias and alias in text)
        if place["match"] in text or place["name"] in text:
            hits += 3
        area_hit = bool(place.get("area")) and place["area"] in text
        if hits or area_hit:
            scored.append((hits + (1 if area_hit else 0), place))
    scored.sort(key=lambda item: -item[0])
    return [place for _, place in scored]


def tool_assess_route(state: dict[str, Any], args: dict[str, Any]) -> dict[str, Any]:
    destination = str(args.get("destination", ""))[:120]
    try:
        hours = max(0.5, min(float(args.get("hours", 3)), 12))
    except (TypeError, ValueError):
        hours = 3
    p = _profile(state)
    resident = {"age": p.get("age"), "conditions": p.get("conditions", []), "screening": p.get("screening")}
    candidates = _find_places(destination)
    if not candidates:
        result = assess_route(resident, destination, hours)
        return {"place": destination, "matched": False, **_compact_assessment(result)}
    place = candidates[0]
    result = assess_route(resident, place["match"], hours)
    same_area = [c for c in PLACES if c.get("area") and c.get("area") == place.get("area") and c["id"] != place["id"]]
    alternatives = []
    for alt in same_area:
        alt_result = assess_route(resident, alt["match"], hours)
        better_level = _rank(alt_result["level"]) < _rank(result["level"])
        better_score = alt_result.get("score") is not None and result.get("score") is not None and alt_result["score"] < result["score"]
        if better_level or better_score:
            alternatives.append({"place": alt["name"], "level": _level_cn(alt_result["level"]), "why": _place_strengths(alt)})
    stay_city = str(p.get("stayCity", "")).replace("市", "")
    return {
        "place": place["name"],
        "city": place["city"],
        "cross_city": bool(stay_city) and place["city"] not in stay_city,
        "matched": True,
        **_compact_assessment(result),
        "safer_alternatives": alternatives[:2],
    }


def _place_strengths(place: dict[str, Any]) -> str:
    notes = []
    if (place.get("slope_score") or 0) >= 4: notes.append("坡度平缓")
    if (place.get("steps_score") or 0) >= 4: notes.append("台阶少")
    if place.get("wheelchair") == 1: notes.append("有无障碍通道")
    if place.get("network_level") == "good": notes.append("手机信号好")
    return "、".join(notes) + "（模拟数据，待踏勘）" if notes else "资料待核验"


def _compact_assessment(result: dict[str, Any]) -> dict[str, Any]:
    compact = {"level": _level_cn(result["level"]), "level_code": result["level"], "score": result.get("score"), "factors": result.get("factors", []), "missing": result.get("missing", []), "advice": result.get("advice", []), "data_source": result.get("source", ""), "verified": False}
    if result.get("border"):
        compact.update({"border": "出境行程" if result["border"] == "cross" else "边境地区", "border_checklist": result.get("border_checklist", [])})
    return compact


def _rank(level: str) -> int:
    return {"low": 0, "unknown": 1, "medium": 2, "high": 3}.get(level, 1)


def _level_cn(level: str) -> str:
    return {"low": "低风险提示", "medium": "需关注", "high": "高风险提示", "unknown": "资料待核验"}.get(level, "资料待核验")


GENERIC_NAME = r"养生|康养|旅居|健康|老年|养老|康复|理疗|保健|投资|理财|项目|训练|食堂|餐厅|机构|基地|中心|公司|会所|公寓|团|讲座|会场|主办方|主办|组织者|推销员|业务员|推销|上门|楼下|摊位|摊子|卖|的人|有人|微信群|群里|导游|旅行社|商家|门店|店|馆|社保局|医保局|公安局|派出所|法院|检察院|银行|政府|社区|居委会|明天|今天|昨天|办|的|这家|那家|一家|某个|某"
# 投诉里涉及钱（多收、退款、购物）才找 12315；态度、饭菜、卫生这类服务问题先找机构，由监管端督办
MONEY_COMPLAINT = r"收费|多收|多扣|扣了|扣钱|价格|价钱|公示|退款|退钱|退费|费用|差价|购物|买了|手镯|玉器|团费|押金|钱"


def tool_check_institution(state: dict[str, Any], args: dict[str, Any]) -> dict[str, Any]:
    name = re.sub(r"\s+", "", str(args.get("name", "")))[:60]
    name = re.sub(r"[（(【\[].*?[）)】\]]", "", name)  # “健康讲座（免费领鸡蛋）”括号里是说明，不是名称
    if not name or len(re.sub(GENERIC_NAME, "", name)) < 2:
        # “养生基地”“康复训练”“食堂”只是泛称，名录里本来就查不到，不能据此说“没登记”
        return {"registered": None, "name": name, "note": "老人没有说出具体名称，无法按登记名录核查（不能说成“没查到”）"}
    registry = [item for item in state.get("institutions", []) if isinstance(item, dict)]
    for item in registry:
        core = re.sub(r"(康养中心|颐养公寓|康养基地|旅居中心|颐养社区|旅居康养中心)$", "", item.get("name", ""))
        if item.get("name") and (item["name"] in name or name in item["name"] or (core and core in name)):
            return {"registered": True, "name": item["name"], "city": item.get("city"), "status": item.get("status"), "note": "在样本登记名录中"}
    return {"registered": False, "name": name, "note": "样本登记名录中查无此机构，需工作人员进一步核实"}


def _bigrams(text: str) -> set[str]:
    clean = re.sub(r"[\s，。！？、,.!?：:；;“”\"']", "", text or "")
    return {clean[i:i + 2] for i in range(len(clean) - 1)}


def tool_search_similar_cases(state: dict[str, Any], args: dict[str, Any]) -> dict[str, Any]:
    query = _bigrams(str(args.get("description", "")))
    if not query:
        return {"count": 0, "cases": []}
    hits = []
    for event in state.get("events", []):
        if not isinstance(event, dict):
            continue
        text = f"{event.get('title', '')}{event.get('summary', '')}"
        grams = _bigrams(text)
        if not grams:
            continue
        score = len(query & grams) / len(query | grams)
        if score >= 0.08:
            hits.append((score, event))
    hits.sort(key=lambda item: -item[0])
    result = {"count": len(hits), "cases": [{"id": e.get("id"), "title": e.get("title"), "category": e.get("category"), "status": e.get("status"), "similarity": round(s, 2)} for s, e in hits[:3]]}
    alert = _matched_alert(state, str(args.get("description", "")))
    if alert:
        result["matched_alert"] = {**alert, "say_to_elder": f"这和{alert['from']}推送的防骗提醒是同一种说法，您先来问是对的"}
    return result


def _matched_alert(state: dict[str, Any], text: str) -> dict[str, Any] | None:
    """老人说的话与主管部门已推送的防骗提醒是否同一种说法：至少命中该类案 2 条共同线索。"""
    broadcasts = [b for b in state.get("broadcasts") or [] if isinstance(b, dict) and b.get("clusterId")]
    mine = case_radar._clues(text)
    if not broadcasts or len(mine) < 2:
        return None
    events = case_radar.radar_events(state)
    clusters = {c["id"]: c for c in case_radar.find_clusters(events, features=case_radar.cached_features(events))}
    for notice in broadcasts:
        cluster = clusters.get(notice["clusterId"])
        shared = sorted(mine & set(cluster["clues"])) if cluster else []
        if len(shared) >= 2:
            return {"id": notice.get("id"), "cluster_id": cluster["id"], "from": notice.get("from", "主管部门"), "time": notice.get("time", ""), "shared": shared}
    return None


def _tomorrow_window(message: str) -> tuple[str, str]:
    now = datetime.now()
    day = now + timedelta(days=2 if "后天" in message else 1 if re.search(r"明天|明早|明日", message) else 0)
    start = day.replace(hour=9, minute=0, second=0, microsecond=0)
    if day.date() == now.date():
        start = (now + timedelta(hours=1)).replace(minute=0, second=0, microsecond=0)
    end = start + timedelta(hours=8)
    label = ("明日 " if day.date() != now.date() else "今日 ") + start.strftime("%H:%M")
    if "后天" in message:
        label = "后天 " + start.strftime("%H:%M")
    return label, end.strftime("%Y-%m-%dT%H:%M")


def tool_draft_movement_report(state: dict[str, Any], args: dict[str, Any]) -> dict[str, Any]:
    destination = str(args.get("destination", ""))[:120] or "待老人补充"
    depart_label, return_at = _tomorrow_window(str(args.get("when", "")))
    return {
        "action": "movement_report",
        "requires_confirmation": True,
        "destination": destination,
        "type": "跨市行程" if args.get("cross_city") else "临时外出",
        "reason": str(args.get("reason", "老人通过AI助手提出出行意向"))[:120],
        "departAt": depart_label,
        "expectedReturnAt": return_at,
        "companion": str(args.get("companion", "建议机构陪同"))[:60],
        "risk": args.get("risk") if args.get("risk") in {"low", "medium", "high"} else "medium",
        "note": "草稿需老人确认后推送机构核验，不会自动生效",
    }


def tool_create_ticket(state: dict[str, Any], args: dict[str, Any]) -> dict[str, Any]:
    category = str(args.get("category", "一般咨询"))[:20]
    owner = {"涉老诈骗风险": "属地公安反诈中心（经机构核实后移交）", "服务投诉": "属地市场监管部门", "消费纠纷": "属地市场监管部门", "设施报修": "入住机构"}.get(category, "入住机构值班人员")
    return {"action": "ticket", "requires_confirmation": True, "category": category, "summary": str(args.get("summary", ""))[:200], "suggested_owner": owner, "level": args.get("level") if args.get("level") in {"low", "medium", "high"} else "medium"}


def tool_notify_family(state: dict[str, Any], args: dict[str, Any]) -> dict[str, Any]:
    contact = _profile(state).get("emergencyName") or "紧急联系人"
    return {"action": "notify_family", "requires_confirmation": True, "to": contact, "message": str(args.get("message", ""))[:120]}


TOOLS: dict[str, tuple[Callable[[dict[str, Any], dict[str, Any]], dict[str, Any]], str, str, dict[str, Any]]] = {
    "get_resident_profile": (tool_get_resident_profile, "查询个人档案", "读取老人年龄、慢病、行动能力快筛与授权状态。任何个性化建议前先调用。", {"type": "object", "properties": {}}),
    "get_current_movement": (tool_get_current_movement, "查询当前动向", "读取老人当前是否在机构外、有无进行中的外出报备。", {"type": "object", "properties": {}}),
    "assess_route": (tool_assess_route, "评估路线风险", "按场所踏勘资料与老人身体情况评估目的地/路线风险，并给出同区域更安全的替代路线。", {"type": "object", "properties": {"destination": {"type": "string", "description": "老人说的目的地或路线原话"}, "hours": {"type": "number", "description": "预计外出小时数"}}, "required": ["destination"]}),
    "check_institution": (tool_check_institution, "核查机构登记", "核查老人提到的养老机构、基地或商家是否在登记名录中。", {"type": "object", "properties": {"name": {"type": "string"}}, "required": ["name"]}),
    "search_similar_cases": (tool_search_similar_cases, "检索相似案例", "在已有事件台账中检索相似案例，用于发现同类问题。", {"type": "object", "properties": {"description": {"type": "string"}}, "required": ["description"]}),
    "draft_movement_report": (tool_draft_movement_report, "生成外出报备草稿", "老人表达出行意向时必须调用，生成外出报备草稿（需老人确认后推送机构）。", {"type": "object", "properties": {"destination": {"type": "string"}, "when": {"type": "string", "description": "出行时间原话，如明天"}, "reason": {"type": "string"}, "companion": {"type": "string"}, "cross_city": {"type": "boolean"}, "risk": {"type": "string", "enum": ["low", "medium", "high"]}}, "required": ["destination"]}),
    "create_ticket": (tool_create_ticket, "生成求助工单", "疑似诈骗、多收费、服务或设施问题时必须调用，生成工单草稿（需老人确认后派发）。", {"type": "object", "properties": {"category": {"type": "string", "enum": ["涉老诈骗风险", "服务投诉", "消费纠纷", "设施报修", "一般咨询"]}, "summary": {"type": "string"}, "level": {"type": "string", "enum": ["low", "medium", "high"]}}, "required": ["category", "summary"]}),
    "notify_family": (tool_notify_family, "提醒紧急联系人", "疑似诈骗、涉及付钱或验证码时必须调用，生成给紧急联系人的提醒（需老人确认后发送）。", {"type": "object", "properties": {"message": {"type": "string"}}, "required": ["message"]}),
}


def tool_schemas() -> list[dict[str, Any]]:
    return [{"type": "function", "function": {"name": name, "description": desc, "parameters": params}} for name, (_, _, desc, params) in TOOLS.items()]


def _summarize_result(name: str, result: dict[str, Any]) -> str:
    if name == "get_resident_profile":
        return f"{result.get('age')}岁；{'、'.join(result.get('conditions') or []) or '无慢病记录'}；肢体活动{result.get('mobility')}；跨区域授权{'已开启' if result.get('cross_region_consent') else '未开启'}"
    if name == "get_current_movement":
        return result.get("note") or f"{result.get('status')}：{result.get('destination')}"
    if name == "assess_route":
        alt = result.get("safer_alternatives") or []
        parts = [f"{result.get('place')}：{result.get('level')}"]
        if result.get("factors"):
            parts.append("因素 " + "、".join(result["factors"]))
        if result.get("cross_city"):
            parts.append("跨市行程")
        if alt:
            parts.append("可替代：" + alt[0]["place"])
        return "；".join(parts)
    if name == "check_institution":
        if result.get("registered") is None:
            return "老人没说出具体名称，无法按名录核查"
        return f"{result.get('name', '')}：{'在样本登记名录中' if result.get('registered') else '登记名录中查无此机构'}"
    if name == "search_similar_cases":
        alert = result.get("matched_alert")
        if alert:
            return f"与{alert['from']}{alert['time']}推送的防骗提醒是同一种说法（{'、'.join(alert['shared'][:3])}）"
        return f"找到 {result.get('count', 0)} 条相似记录" + (f"，最相近：{result['cases'][0]['title']}" if result.get("cases") else "")
    if name == "draft_movement_report":
        return f"{result.get('departAt')} 前往 {result.get('destination')}，{result.get('companion')}（待确认）"
    if name == "create_ticket":
        return f"{result.get('category')} → {result.get('suggested_owner')}（待确认）"
    if name == "notify_family":
        return f"提醒 {result.get('to')}（待确认）"
    return json.dumps(result, ensure_ascii=False)[:80]


class Trace:
    def __init__(self) -> None:
        self.steps: list[dict[str, Any]] = []
        self.actions: list[dict[str, Any]] = []
        self.results: dict[str, dict[str, Any]] = {}
        self.alert: dict[str, Any] | None = None

    def add(self, kind: str, title: str, detail: str, ms: int = 0, tool: str = "") -> None:
        self.steps.append({"kind": kind, "title": title, "detail": detail[:160], "ms": ms, "tool": tool})

    def run_tool(self, state: dict[str, Any], name: str, args: dict[str, Any]) -> dict[str, Any]:
        func, label, _, _ = TOOLS[name]
        started = time.perf_counter()
        try:
            result = func(state, args if isinstance(args, dict) else {})
        except Exception as error:  # 工具失败不能让整个流程崩溃
            result = {"error": str(error)[:80]}
        ms = int((time.perf_counter() - started) * 1000)
        self.add("tool", label, _summarize_result(name, result) if "error" not in result else f"调用失败：{result['error']}", ms, name)
        self.results[name] = result
        if name == "search_similar_cases" and result.get("matched_alert"):
            self.alert = result["matched_alert"]
        if result.get("action") == "ticket" and self.alert:
            result["alert_id"] = self.alert["id"]  # 工单记下命中的提醒，监管端据此统计“预警后主动求证”
        if result.get("requires_confirmation"):
            self.actions.append(result)
        return result


# --------------------------------------------------------------------------- 结论校正

# 内部编号：前面可以紧挨汉字，编号本身只含字母数字和连字符（不能把后面的汉字吞进去）
ID_PATTERN = r"(?<![A-Za-z0-9])(?:EV|MV|IN|CL|SOS|BC|DV|WA|CK)-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*"


def strip_ids(text: Any, keep: set[str] | None = None) -> str:
    """删去内部编号（keep 中的保留），并清理留下的空括号和多余标点。"""
    text = re.sub(ID_PATTERN, lambda m: m.group(0) if keep and m.group(0) in keep else "", str(text or ""))
    text = re.sub(r"([（(])\s*[，、,；]\s*", r"\1", text)
    text = re.sub(r"\s*[，、,；]\s*([）)])", r"\1", text)
    text = re.sub(r"[（(]\s*[）)]", "", text)
    text = re.sub(r"(?:和|及|与|、)\s*(?=[，。；）)]|$)", "", text)
    text = re.sub(r"([，、；。])\s*[，、；]+", r"\1", text)
    return re.sub(r"^[\s，、；。]+", "", text)


def _plain(text: Any, limit: int, keep: set[str] | None = None) -> str:
    """去掉模型回复里的 Markdown 符号和内部编号，按句子截断，界面上不出现 ** 或半截话。"""
    text = re.sub(r"[*#`>]+|^\s*[-•]\s*", "", str(text or ""), flags=re.M)
    text = strip_ids(text, keep)
    text = re.sub(r"\s*\n\s*", "；", text).strip("；").strip()
    text = re.sub(r"([。：；，])；+", r"\1", text)
    text = re.sub(r"\s{2,}", " ", text)
    if len(text) <= limit:
        return text
    cut = text[:limit]
    stop = max(cut.rfind(mark) for mark in "。；，")
    return (cut[:stop] if stop > limit // 2 else cut) + "…"


def _honorific(state: dict[str, Any]) -> str:
    profile = state.get("profile") or {}
    name = str(profile.get("name") or "")
    return f"{name[:1]}{'阿姨' if profile.get('gender') == '女' else '叔叔'}" if name else "您"


# 打招呼、道谢这类话不用查证、不出建议卡，直接回一句（页面 app.js 里有同样的判断，改动时两边一起改）
SMALL_TALK = [
    ("who", r"你是谁|你叫什么(?:名字)?|你能做什么|你会做?什么|你能干什么|你能帮我(?:做|干)?什么|你有什么用"),
    ("bye", r"再见|拜拜|回头见|晚安|先这样"),
    ("thanks", r"谢谢(?:你|您)?|谢了|多谢|感谢(?:你|您)?|辛苦(?:你|您)?了|麻烦(?:你|您)了"),
    ("greet", r"你好|您好|哈喽|嗨|在吗|在不在|早上好|上午好|中午好|下午好|晚上好|早安|早"),
    ("ack", r"好的|好嘞|好|嗯嗯|嗯|哦|行|可以|收到|没问题|没事了|没事|没有了|没了|我?知道了|我?明白了|我?懂了"),
]
SMALL_TALK_ONLY = re.compile(r"^(?:(?:" + "|".join(pattern for _, pattern in SMALL_TALK) + r")[啊呀啦哈呢吧哦喔]*)+$")


def small_talk_kind(message: str) -> str:
    text = re.sub(r"小桂", "", re.sub(r"[\s，。！？、,.!?~…～]+", "", str(message or "")))
    if not text:
        return "greet"
    if len(text) > 14 or not SMALL_TALK_ONLY.match(text):
        return ""
    return next(kind for kind, pattern in SMALL_TALK if re.search(pattern, text))


def small_talk_card(kind: str, state: dict[str, Any]) -> dict[str, Any]:
    name = _honorific(state)
    summary = {
        "who": "我是小桂，帮您办事的助手。想出门、有人让您交钱、收费和说的不一样，都可以问我，我先帮您查清楚，再告诉您怎么做。",
        "greet": f"{name}好呀，我在呢！您想问点什么？",
        "thanks": f"不客气，{name}。还有什么事，随时叫我。",
        "ack": "好嘞，有事随时跟我说。",
        "bye": f"{name}再见，有事随时叫我。",
    }[kind]
    return {"summary": summary, "immediate_actions": [], "place_route": "", "price": "", "phone": "", "risk_level": "low", "escalate": False, "rationale": [], "matched_alert": None, "intent": "chat", "mode": "chat", "urgent": False}


def _tool_labels(text: str) -> str:
    for name, spec in TOOLS.items():
        text = text.replace(name, spec[1])
    return text


CONTACT_NUMBER = re.compile(r"(?<!\d)(?:1\d{10}|0\d{2,3}-?\d{7,8}|\d{3,6})(?!\d)")
NON_PHONE_UNITS = "元块%万岁天小时点月日号分楼层年个"


def _safe_contact_text(value: Any, allowed: set[str], limit: int) -> str:
    """Remove contact numbers outside the platform's verified list from every visible card field."""
    plain = _plain(value, 1000)
    plain = re.sub(r"(?<!\d)\d{2,4}-?\d{2,8}\*{2,}\d*", "机构值班电话", plain)

    def replace(match: re.Match[str]) -> str:
        number = match.group(0)
        suffix = plain[match.end():match.end() + 1]
        if (suffix and suffix in NON_PHONE_UNITS) or number.replace("-", "") in allowed:
            return number
        return "机构值班电话"

    return _plain(CONTACT_NUMBER.sub(replace, plain), limit)


def finalize_card(card: dict[str, Any], trace: Trace, state: dict[str, Any], message: str = "") -> dict[str, Any]:
    """统一字段、电话白名单与长度约束：模型只能从已知号码中选择。"""
    roster = state.get("dutyRoster") or []
    duty_phone = roster[0].get("phone") if roster and isinstance(roster[0], dict) else ""
    contact_name, contact_phone = _contact(state)
    allowed = set(HOTLINES) | ({duty_phone.replace("-", "")} if duty_phone else set()) | ({contact_phone} if contact_phone else set())
    phone = str(card.get("phone", "")).strip()
    digits = re.search(r"120|110|12315|12345", phone)
    if phone not in allowed:
        phone = digits.group(0) if digits else (duty_phone or "12345")
    intent = card.get("intent")
    high = card.get("risk_level") == "high"
    # 电话按场景固定，不交给模型临场挑选：同一类问题每次给同一个号码
    fixed = {"fraud": "110", "safety": "110", "lost": "110"}.get(intent)
    if intent == "complaint" and (not message or re.search(MONEY_COMPLAINT, message)):
        fixed = "12315"
    if intent == "health" and high:
        fixed = "120"  # 急症已由安全红线先处理；这里只有判为高风险的健康问题才给 120
    if fixed:
        phone = fixed
    elif intent == "verify" and contact_phone:
        phone = contact_phone  # 家人要钱先核实：打给档案里登记的子女
    elif duty_phone and not (phone == "120" and high):
        phone = duty_phone  # 出行、日常求助、服务投诉、一般身体不适：先找机构值班员
    actions = card.get("immediate_actions") if isinstance(card.get("immediate_actions"), list) else []
    rationale = card.get("rationale") if isinstance(card.get("rationale"), list) else []
    # 闲聊、倾诉心情、没听明白：页面只回一句话；一旦生成了待确认动作或判为高风险，仍出建议卡
    chat = (card.get("mode") == "chat" or intent in {"chat", "emotion"}) and not trace.actions and card.get("risk_level") != "high"
    return {
        "summary": _safe_contact_text(card.get("summary") or "已整理您的情况，请看下方建议。", allowed, 80),
        "immediate_actions": [] if chat else [_safe_contact_text(item, allowed, 60) for item in actions if str(item).strip()][:3] or ["请联系机构值班人员进一步确认"],
        "place_route": _safe_contact_text(card.get("place_route") or "", allowed, 100),  # 与这件事无关时留空，页面不显示这一格
        "price": _safe_contact_text(card.get("price") or "", allowed, 80),
        "phone": phone,
        "risk_level": card.get("risk_level") if card.get("risk_level") in {"low", "medium", "high"} else "medium",
        "escalate": bool(card.get("escalate")),
        "rationale": [_safe_contact_text(_tool_labels(str(item)), allowed, 80) for item in rationale][:3],
        # 命中已推送的防骗提醒时由代码写入，界面单独显示，不依赖模型措辞
        "matched_alert": {"from": trace.alert.get("from", "主管部门"), "time": trace.alert.get("time", ""), "shared": trace.alert.get("shared", [])[:3]} if trace.alert and intent == "fraud" else None,
        "intent": card.get("intent") if card.get("intent") in {"trip", "fraud", "complaint", "health", "safety", "lost", "facility", "service", "consult", "emotion", "medication", "chat", "verify"} else "consult",
        "contact": {"name": contact_name, "phone": contact_phone} if intent == "verify" and contact_phone else None,
        "mode": "chat" if chat else "card",
        "urgent": False,
    }


# --------------------------------------------------------------------------- 大模型规划

SYSTEM_PROMPT = """
你是"小桂"，广西旅居养老平台的守护智能体。你的工作不是聊天，而是：听懂老人的一句话 → 调用工具查证事实 → 给出简短可执行的建议，并准备需要人工确认的动作。
工作规则：
1. 老人说了具体的事，先调用 get_resident_profile；涉及出行必须调用 get_current_movement 与 assess_route；涉及收钱、投资、保健品、会员卡、机构或商家必须调用 check_institution 与 search_similar_cases。
2. 结论只能来自工具结果。工具没查到的信息写"待核验"，不得编造地址、价格、电话、天气或机构资质。
3. 出行场景：路线为"高风险提示"或"需关注"时，优先推荐工具给出的更安全替代路线；路线结果带 border（出境行程/边境地区）时，按 border_checklist 提醒证件、境外就医保险、通信；团费明显偏低或含购物点时提醒强制购物风险、先别交团费；跨市行程且未开启跨区域授权时，提醒先开启授权；有出行意向时调用 draft_movement_report 生成报备草稿（哪怕只是去超市、公园，只要离开机构就要登记；草稿要老人确认才发出）。
4. 疑似诈骗或消费纠纷：老人说钱已经交了、转了时，第一条建议必须是马上打110报警并联系银行止付冻结，不要只说“保留证据”；不直接定性诈骗，写"符合常见骗局特征"；工具结果里有 matched_alert 时，按其中 say_to_elder 告诉老人；没有就不要提“提醒”二字；机构核查结果为“无法核查”时，不能说“登记名单里没查到”；提醒暂缓付款、保留证据；调用 create_ticket，风险较高时再调用 notify_family。工单和提醒家属都只是草稿，要老人点“确认”才会发出，所以符合条件就直接调用，不要先问老人要不要。
5. 你不负责急症判断；急症已由安全规则先行处理。
6. 说话像一位耐心、靠得住的晚辈：用称呼开头（如"李阿姨"），先用半句话安抚或肯定，再说结论和先做什么。
   不说术语和系统用语：不说"查无登记""跨区域授权""风险提示"，改说"登记名单里没查到这家""去外市前要先在系统里点个同意"。
   每条建议写成一句完整的话，讲清做什么、怎么做，不要只写四五个字的短语。
7. 建议排序：第一条必须是最直接保障安全的动作（如改走平缓路线、暂停付款、原地等待）；开授权、报备等手续放在后面。
8. 电话按场景选：出行、服务求助、一般身体不适、服务态度和饭菜等投诉选机构值班电话；收费、退款等消费纠纷选12315；疑似诈骗选110；只有政务咨询才选12345。
9. 老人的话可能是在接着前面的对话追问（如“那我要是已经交了怎么办”），要结合前面的对话理解，继续用工具查证，回答针对追问本身。
10. 家人（儿子、女儿、孙子等）说急用钱、让老人转账，钱还没转、也没有换号码、催促保密、用别人账户等可疑说法时：
    这可能是真的，也可能是冒充，不要直接定性诈骗，也不要让老人马上报警。intent 填 verify，先让老人打家人平常用的号码核实，调用 notify_family 请家人回电，不调用 create_ticket。
    有换号、陌生账户、让保密、“猜猜我是谁”、视频打不开等说法，或钱已经转了，才按第 4 条处理。
11. 另一种例外：老人自己主动要给家人钱（红包、随礼、生活费），而且没提到有人催促、换号、陌生账号或让保密，这不算诈骗，intent 填 consult，只提醒转账前打家人常用的电话核对账号。
    推销、保健品、投资、陌生人或自称家人的人来要钱，仍按第 4 条处理，必须调用 create_ticket。
12. 老人只是打招呼、道谢、闲聊，没有具体要办的事：不调用工具，intent 填 chat，像平常聊天一样回一两句（不超过40字），可以顺口问一句要不要帮忙；不列建议，不提老人的病情，不说“先别急着出门”这类没头没尾的提醒。
    老人只是想说说心情（想家、闷得慌、睡不好）：intent 填 emotion，先接住情绪，再轻轻给一个小建议（如给家里打个电话、找工作人员聊聊），不超过60字。
""".strip()

FORMAT_PROMPT = """
根据以上工具结果，只输出一个JSON对象，不要Markdown。字段：
summary（对老人说的第一句话：称呼 + 安抚 + 结论 + 先做什么，30～60字）、immediate_actions（最多3条，每条是一句完整、具体的话，≤35字）、
place_route（出行、就医、迷路或需要当面找人时，写具体去哪里、找谁陪同，≤40字；和地点无关就给空字符串）、
price（涉及花钱、收费、转账、买东西时写费用提醒，如"先别交任何定金"，≤30字；和钱无关就给空字符串，不要写"不用花钱"凑数）、
phone（只能从 120/110/12315/12345/机构值班电话 中选一个）、risk_level（low/medium/high）、escalate（布尔）、
rationale（最多3条，每条用中文说明引用了哪项查证结果，不要写英文工具名）、intent（trip/fraud/verify/complaint/service/consult/emotion/chat 之一）。
intent 为 chat 或 emotion 时，summary 就是完整的回话，像聊天一样说，不套“称呼+结论+先做什么”的格式；immediate_actions 给空数组。
""".strip()


def _post(config: dict[str, str], body: dict[str, Any], endpoint: str, timeout: int = 40) -> dict[str, Any]:
    request = urllib.request.Request(
        endpoint,
        data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
        method="POST",
        headers={"Authorization": f"Bearer {config['api_key']}", "Content-Type": "application/json", "Accept": "application/json", "User-Agent": "GuangxiEldercareAgent/1.0"},
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def run_model_agent(message: str, state: dict[str, Any], config: dict[str, str], endpoint: str, clean: Callable[[str], str], history: list[dict[str, str]] | None = None) -> dict[str, Any]:
    trace = Trace()
    trace.add("perceive", "理解老人诉求", f"“{message[:60]}”")
    history = history or []
    if history:
        trace.add("perceive", "结合前面的对话", f"带上最近 {len(history)} 条对话，理解“{message[:20]}”指的是什么")
    messages: list[dict[str, Any]] = [
        {"role": "system", "content": SYSTEM_PROMPT},
        *history,
        {"role": "user", "content": f"今天是{datetime.now().strftime('%Y年%m月%d日')}。称呼：{_honorific(state)}。老人说：{message}"},
    ]
    for _ in range(MAX_TOOL_ROUNDS):
        started = time.perf_counter()
        reply = _post(config, {"model": config["model"], "messages": messages, "tools": tool_schemas(), "tool_choice": "auto", "temperature": 0.2, "max_tokens": 800}, endpoint)
        choice = reply["choices"][0]["message"]
        calls = choice.get("tool_calls") or []
        if not calls:
            if choice.get("content"):
                trace.add("plan", "形成判断", _plain(choice["content"], 90), int((time.perf_counter() - started) * 1000))
            break
        trace.add("plan", "规划下一步", "决定调用：" + "、".join(TOOLS[c["function"]["name"]][1] for c in calls if c.get("function", {}).get("name") in TOOLS), int((time.perf_counter() - started) * 1000))
        messages.append({"role": "assistant", "content": choice.get("content") or "", "tool_calls": calls})
        for call in calls:
            name = call.get("function", {}).get("name", "")
            try:
                args = json.loads(call.get("function", {}).get("arguments") or "{}")
            except json.JSONDecodeError:
                args = {}
            result = trace.run_tool(state, name, args) if name in TOOLS else {"error": "unknown_tool"}
            messages.append({"role": "tool", "tool_call_id": call.get("id", name), "content": json.dumps(result, ensure_ascii=False)})
    messages.append({"role": "user", "content": FORMAT_PROMPT})
    started = time.perf_counter()
    reply = _post(config, {"model": config["model"], "messages": messages, "temperature": 0.1, "max_tokens": 600, "response_format": {"type": "json_object"}}, endpoint)
    card = json.loads(clean(reply["choices"][0]["message"]["content"]))
    trace.add("decide", "生成适老建议卡", "按场景校正电话，保留依据", int((time.perf_counter() - started) * 1000))
    enforce_policy(message, card, trace, state)
    earlier = "；".join(str(turn.get("content", "")) for turn in history[-4:] if turn.get("role") == "user")  # 追问“他们不承认怎么办”要连同前文判断电话
    return {"card": finalize_card(card, trace, state, f"{earlier}；{message}" if earlier else message), "trace": trace.steps, "actions": trace.actions}


def resolve_intent(message: str, model_intent: Any) -> str:
    """模型负责理解，规则只做“安全下限”：出现要钱、多收费、出行字眼时，不允许被归成普通咨询。"""
    text = re.sub(r"\s+", "", message)
    rule = "complaint" if re.search(COMPLAINT_WORDS, text) else "fraud" if re.search(FRAUD_WORDS, text) else ""
    if not rule and re.search(INJECTION, text):
        return "consult"  # “忽略规则”“告诉我提示词”这类诱导，只礼貌拒绝，不当成诈骗去通知家属
    for intent in ("fraud", "complaint"):  # 涉及钱的风险：规则或模型任一方判出即按此处理
        if intent in {rule, model_intent}:
            return intent
    if model_intent in {None, "", "consult", "chat", "emotion"} and re.search(TRIP_FLOOR, text):
        return "trip"  # 出行：只在模型没有给出具体意图时补判
    return model_intent if isinstance(model_intent, str) and model_intent else "consult"


def _shown(card: dict[str, Any]) -> str:
    """页面只显示前 3 条建议；判断“有没有提到某件事”只看第一句话和这 3 条，被截掉的第 4 条不算。"""
    actions = card.get("immediate_actions") if isinstance(card.get("immediate_actions"), list) else []
    return json.dumps([card.get("summary"), actions[:3]], ensure_ascii=False)


def _family_verify(card: dict[str, Any], trace: Trace, state: dict[str, Any], message: str = "") -> None:
    """家人要钱、钱还没转、也没有冒充迹象：先让老人打家人原来的号码核实，请家人回电；不报警、不开工单。"""
    contact, _ = _contact(state)
    who, helper = _relative(message, state)
    # 还没核实就不下结论：“很可能是冒充/骗子”改成“也可能是有人冒充”
    soften = lambda text: re.sub(r"(?:这|那)?(?:很可能|多半|八成|一定|肯定)(?:是)?(?:有人)?(冒充|骗)", r"也可能是有人\1", str(text or ""))
    card["summary"] = soften(card.get("summary"))
    if isinstance(card.get("immediate_actions"), list):
        card["immediate_actions"] = [soften(item) for item in card["immediate_actions"]]
    now = r"110|报警|止付|冻结"
    conditional = r"如果|要是|万一|已经|一旦|假如"
    if re.search(now, str(card.get("summary") or "")) and not re.search(conditional, str(card.get("summary") or "")):
        card["summary"] = f"{_honorific(state)}，先别急着转钱，这事不一定是假的，也可能是骗子冒充。先打{who}平常用的号码问问，确认了再说。"
        trace.add("note", "规则校正说法", "钱还没转：不让老人马上报警，先核实")
    actions = [a for a in (card.get("immediate_actions") if isinstance(card.get("immediate_actions"), list) else []) if not (re.search(now, str(a)) and not re.search(conditional, str(a)))]
    verify = VERIFY_ACTION.format(who=who) + (f"，{helper}" if helper else "")
    if not any(re.search(r"打.{0,8}(?:电话|号码)|问问|核实|确认", str(a)) for a in actions):
        actions.insert(0, verify)
    if not re.search(r"先别转|别急着转|先不转|暂时别转|先别给", json.dumps(actions, ensure_ascii=False)):
        actions.insert(0, "先别转钱，钱转出去就很难追回来")
    card["immediate_actions"] = [*actions[:2], VERIFY_WARN]
    before = len(trace.actions)
    trace.actions = [a for a in trace.actions if a.get("action") != "ticket"]
    if len(trace.actions) != before:
        trace.add("note", "规则判断", "家人要钱但还没转、没有冒充迹象：先核实，不生成报案工单")
    if not any(a.get("action") == "notify_family" for a in trace.actions):
        trace.add("note", "规则补全", f"请{contact}直接给老人回电话核实（需老人确认）")
        trace.run_tool(state, "notify_family", {"message": f"{_profile(state).get('name', '老人')}收到说是您要用钱的消息，钱还没转。请您直接给老人回个电话，说清楚是不是您本人。"})
    card["risk_level"] = "medium"
    card["escalate"] = False


def enforce_policy(message: str, card: dict[str, Any], trace: Trace, state: dict[str, Any]) -> None:
    """模型漏掉的关键动作由规则补齐，并在执行过程中如实标出“规则补全”。动作仍需老人确认。"""
    money = family_money(message)
    if money == "verify":
        if card.get("intent") != "verify":
            trace.add("note", "规则校正意图", f"模型判断为“{card.get('intent') or '未给出'}”：家人要钱、钱还没转、没有冒充迹象，改为“先核实”")
        card["intent"] = "verify"
        _family_verify(card, trace, state, message)
    if money == "verify":
        intent = "verify"
    elif money in {"impersonation", "paid"}:
        intent = "fraud"
    elif money == "gift":  # 老人自己给家人随礼、生活费：不按“转账”字眼判成诈骗
        intent = card.get("intent") if card.get("intent") not in {None, "", "fraud"} else "consult"
    else:
        intent = resolve_intent(message, card.get("intent"))
    if intent != card.get("intent"):
        trace.add("note", "规则校正意图", f"模型判断为“{card.get('intent') or '未给出'}”，按关键词安全下限改为“{ {'fraud': '疑似诈骗', 'complaint': '消费投诉', 'trip': '出行'}.get(intent, intent) }”")
    card["intent"] = intent
    kinds = {action.get("action") for action in trace.actions}

    def fill(tool: str, args: dict[str, Any], why: str) -> dict[str, Any]:
        trace.add("note", "规则补全", why)
        return trace.run_tool(state, tool, args)

    if intent == "fraud":
        if "search_similar_cases" not in trace.results:
            fill("search_similar_cases", {"description": message}, "补查相似案例与已推送的防骗提醒")
        if "ticket" not in kinds:
            fill("create_ticket", {"category": "涉老诈骗风险", "summary": message[:120], "level": "high"}, "模型未生成工单，按规则补齐涉老诈骗风险工单（需老人确认）")
        if "notify_family" not in kinds:
            fill("notify_family", {"message": "老人遇到要求预先付款的推销，请尽快电话确认并提醒暂缓付款。"}, "按规则补齐提醒家属（需老人确认）")
        if re.search(PAID_WORDS, re.sub(r"\s+", "", message)):
            if not re.search(r"110|报警|止付|冻结", _shown(card)):
                actions = card.get("immediate_actions") if isinstance(card.get("immediate_actions"), list) else []
                card["immediate_actions"] = [PAID_ACTION, *actions][:3]
                trace.add("note", "规则补全", "老人说钱已付出，模型建议里没有报警和止付，按规则把“打110、银行止付冻结”放在第一条")
        card["risk_level"] = "high"
        card["escalate"] = True
    elif intent == "complaint":
        if "ticket" not in kinds:
            fill("create_ticket", {"category": "服务投诉", "summary": message[:120], "level": "medium"}, "模型未生成工单，按规则补齐投诉工单（需老人确认）")
        if card.get("risk_level") not in {"medium", "high"}:
            card["risk_level"] = "medium"
    elif intent == "trip":
        route = trace.results.get("assess_route") or fill("assess_route", {"destination": message}, "补做路线风险评估")
        movement = trace.results.get("get_current_movement") or {}
        core = lambda name: re.sub(r"[（(].*?[）)]", "", str(name or ""))
        already_there = movement.get("outside_now") and core(route.get("place")) and core(movement.get("destination")) and (core(route.get("place")) in core(movement.get("destination")) or core(movement.get("destination")) in core(route.get("place")))
        text_now = _shown(card)
        must = []
        if route.get("border") == "出境行程" and not re.search(r"护照|通行证|证件", text_now):
            must.append((BORDER_ACTION, "出境行程：补充证件、境外医疗保险与国际漫游提醒"))
        if re.search(LOW_PRICE_TOUR, re.sub(r"\s+", "", message)) and not re.search(r"强制购物|购物点|团费|资质", text_now):
            must.append((LOW_PRICE_ACTION, "低价团：补充强制购物风险提醒"))
        if must:
            actions = card.get("immediate_actions") if isinstance(card.get("immediate_actions"), list) else []
            card["immediate_actions"] = [actions[0], *[a for a, _ in must], *actions[1:]][:3] if actions else [a for a, _ in must]
            for _, why in must:
                trace.add("note", "规则补全", why)
            card["risk_level"] = "high" if route.get("level_code") == "high" else card.get("risk_level")
        if already_there:
            trace.add("note", "规则判断", "老人正在该地点外出途中，不重复生成报备")
        elif "movement_report" not in kinds:
            alt = (route.get("safer_alternatives") or [None])[0]
            risky = route.get("level_code") in {"high", "medium"}
            fill("draft_movement_report", {"destination": alt["place"] if (risky and alt) else route.get("place", message[:40]), "when": message, "reason": f"老人表达出行意向：{message[:40]}", "companion": "机构人员陪同" if risky else "结伴出行并按时报平安", "cross_city": route.get("cross_city"), "risk": "high" if route.get("level_code") == "high" else "medium" if risky else "low"}, "模型未生成报备草稿，按规则补齐（需老人确认）")
    if intent != "trip":
        # 按诈骗/投诉处理的低价出境团：先别交钱仍是第一条，强制购物和证件、境外就医提醒也不能少
        must = []
        if intent == "fraud" and re.search(LOW_PRICE_TOUR, re.sub(r"\s+", "", message)) and not re.search(r"强制购物|购物点|购物店|团费|资质", _shown(card)):
            must.append((LOW_PRICE_ACTION, "低价团：补充强制购物风险提醒"))
        if re.search(r"越南|芒街|出境|出国|过境", message) and not re.search(r"护照|通行证|证件", _shown(card)):
            must.append((BORDER_ACTION, "涉及出境：补充证件、境外医疗保险与国际漫游提醒"))
        if must:
            actions = card.get("immediate_actions") if isinstance(card.get("immediate_actions"), list) else []
            card["immediate_actions"] = [*actions[:3 - len(must)], *[action for action, _ in must]]
            for _, why in must:
                trace.add("note", "规则补全", why)
    for action in trace.actions:
        if action.get("action") == "ticket" and trace.alert:
            action["alert_id"] = trace.alert["id"]  # 工具调用先后顺序不影响关联
    registry = trace.results.get("check_institution") or {}
    unsupported = []
    if not trace.alert:
        unsupported.append(r"防骗提醒|主管部门.{0,6}发")
    if registry.get("registered") is not False:
        unsupported.append(r"登记.{0,6}(?:没|未|查无|查不到|找不到)|(?:没|未|查不到|找不到).{0,6}登记|查无")
    if unsupported and _drop_claims(card, "|".join(unsupported)):
        trace.add("note", "规则校正说法", "删去没有查证依据的说法（如“登记名单里没查到”“和防骗提醒同一种说法”）")


def _drop_claims(card: dict[str, Any], pattern: str) -> bool:
    """按逗号、句号拆开，删掉命中无依据说法的分句；保留称呼开头。"""
    changed = False
    summary = str(card.get("summary") or "")
    parts = [p for p in re.split(r"(?<=[，。；！])", summary) if p]
    kept = [p for i, p in enumerate(parts) if i == 0 or not re.search(pattern, p)]
    if len(kept) != len(parts):
        card["summary"] = re.sub(r"[，；]$", "。", "".join(kept))
        changed = True
    for key in ("immediate_actions", "rationale"):
        items = card.get(key) if isinstance(card.get(key), list) else []
        clean = [item for item in items if not re.search(pattern, str(item))]
        if len(clean) != len(items):
            card[key] = clean
            changed = True
    return changed


# --------------------------------------------------------------------------- 本地规则规划（无模型时）

def run_rule_agent(message: str, state: dict[str, Any]) -> dict[str, Any]:
    trace = Trace()
    text = re.sub(r"\s+", "", message)
    trace.add("perceive", "理解老人诉求", f"“{message[:60]}”")
    profile = trace.run_tool(state, "get_resident_profile", {})
    money = family_money(text)
    is_fraud = bool(re.search(FRAUD_WORDS, text)) and money != "gift" or money in {"impersonation", "paid"}
    is_complaint = bool(re.search(COMPLAINT_WORDS, text))
    is_medication = bool(re.search(r"药|处方", text) and re.search(r"快吃完|用完|买|续|没有|药店", text))
    places = _find_places(text)
    is_trip = not is_fraud and not is_complaint and not is_medication and (bool(places) or bool(re.search(TRIP_WORDS, text)) and bool(re.search(r"去|爬山|登山|旅游|逛|游玩|散步", text)))
    if money == "verify":
        trace.add("plan", "规划下一步", "家人要钱、钱还没转、没有冒充迹象：先让老人打家人原来的号码核实，请家人回电")
        who, _ = _relative(text, state)
        card = {"summary": f"{_honorific(state)}，先别急着转钱，这事不一定是假的，也可能是骗子冒充。先打{who}平常用的号码问问，确认了再说。",
                "immediate_actions": [], "place_route": "", "price": "钱先别转，核实清楚再说", "risk_level": "medium", "escalate": False,
                "rationale": ["家人要钱但钱还没转，也没有换号码、让保密等冒充迹象", f"档案里登记了紧急联系人{_contact(state)[0]}"], "intent": "verify"}
        _family_verify(card, trace, state, text)
    elif money == "gift":
        trace.add("plan", "规划下一步", "老人自己要给家人钱：不是诈骗，提醒转账前核对账号")
        who, _ = _relative(text, state)
        card = {"summary": f"{_honorific(state)}，给家里人钱是好事。转之前打{who}平常用的号码核对一下账号，别按陌生短信或新号码发来的账号转。", "immediate_actions": [], "place_route": "", "price": "",
                "risk_level": "low", "escalate": False, "rationale": ["老人主动给家人钱，没有催促、换号等可疑说法"], "intent": "consult", "mode": "chat"}
    elif is_medication and not is_fraud and not is_complaint:
        trace.add("plan", "规划下一步", "识别为续药求助：先联系机构工作人员，核对原处方与药品信息")
        card = {
            "summary": f"{_honorific(state)}，药快吃完了先别着急，请联系机构工作人员，带上原药盒或处方核对后再买。",
            "immediate_actions": ["请把原药盒或处方给机构工作人员看，请他们协助联系正规药店或医生。", "买药前让药师核对药名和剂量，不要自己换药或停药。"],
            "place_route": "就近正规药店的位置待工作人员核实",
            "price": "药价以药店公示为准",
            "phone": (state.get("dutyRoster") or [{}])[0].get("phone", "12345"),
            "risk_level": "medium", "escalate": False,
            "rationale": ["老人提出药品续购需求；附近药店及库存尚未核实"],
            "intent": "medication",
        }
    elif is_trip:
        trace.add("plan", "规划下一步", "识别为出行意向：查询当前动向 → 评估路线风险 → 生成报备草稿")
        movement = trace.run_tool(state, "get_current_movement", {})
        route = trace.run_tool(state, "assess_route", {"destination": text})
        alt = (route.get("safer_alternatives") or [None])[0]
        level_code = route.get("level_code", "unknown")
        risky = level_code in {"high", "medium"}
        consent_needed = route.get("cross_city") and not profile.get("cross_region_consent")
        trace.run_tool(state, "draft_movement_report", {"destination": alt["place"] if (risky and alt) else route.get("place", text), "when": text, "reason": f"老人表达出行意向：{message[:40]}", "companion": "机构人员陪同" if risky else "结伴出行并按时报平安", "cross_city": route.get("cross_city"), "risk": "high" if level_code == "high" else "medium" if risky else "low"})
        actions = []
        border_cross = route.get("border") == "出境行程"
        if risky and alt:
            actions.append(f"这次先别出境，改去{alt['place'].replace('（境内，模拟）', '').replace('（模拟）', '')}，境内好走也好照应" if border_cross else f"这次先别爬山，改去{alt['place'].replace('（模拟）', '')}，路平好走")
        elif risky:
            actions.append("这条路不要一个人去，请工作人员陪您一起")
        if re.search(LOW_PRICE_TOUR, text):
            actions.append(LOW_PRICE_ACTION)
        if border_cross:
            actions.append(BORDER_ACTION)
        if consent_needed:
            actions.append("去外市前，先在“我的档案”里点同意跨区域授权")
        actions = actions[:2] + ["点下面“确认报备”，机构会安排人陪同并提醒您报平安"]
        card = {
            "summary": (f"{_honorific(state)}，您想出去走走是好事。不过出境一日游路程长、境外看病不方便，建议先在境内走走。" if (risky and border_cross) else f"{_honorific(state)}，您想出去走走是好事。不过这条路坡陡台阶多，对膝盖负担大，建议换条平路。" if (risky and re.search(r"坡度|台阶", "".join(route.get("factors") or []))) else f"{_honorific(state)}，您想出去走走是好事。这条路线要多留意{'、'.join(f.split('（')[0] for f in (route.get('factors') or [])[:2])}，请工作人员陪您一起去。" if risky else f"{_honorific(state)}，这条路线比较平缓，可以去，记得结伴出行、按时报平安。"),
            "immediate_actions": actions,
            "place_route": (alt["place"] if (risky and alt) else route.get("place", "待核验")),
            "price": "团费明显偏低的先别交，核实旅行社后再说" if re.search(LOW_PRICE_TOUR, text) else "步道不收费；景区门票以现场公示为准",
            "phone": (state.get("dutyRoster") or [{}])[0].get("phone", "12345"),
            "risk_level": "high" if level_code == "high" else "medium" if risky or consent_needed else "low",
            "escalate": risky,
            "rationale": [f"路线评估：{route.get('level')}（{'、'.join(route.get('factors') or []) or '资料待核验'}）", f"档案：{'、'.join(profile.get('conditions') or [])}；肢体活动{profile.get('mobility')}", "跨市行程且跨区域授权未开启" if consent_needed else ("当前无进行中外出" if not movement.get("outside_now") else "当前已有外出记录")],
            "intent": "trip",
        }
    elif is_fraud or is_complaint:
        trace.add("plan", "规划下一步", "识别为收钱/消费风险：核查机构登记 → 检索相似案例 → 生成工单")
        name_match = re.search(r"([一-龥]{2,12}(?:基地|中心|公司|会所|养生馆|机构|公寓|旅行社))", text)
        name = re.sub(r"^(?:有个|有一个|一个|那个|这个|有家|一家|说|去)+", "", name_match.group(1)) if name_match else ""
        registry = trace.run_tool(state, "check_institution", {"name": name}) if name else {"registered": None, "note": "老人未提到具体机构名称"}
        similar = trace.run_tool(state, "search_similar_cases", {"description": message})
        category = "涉老诈骗风险" if is_fraud else "服务投诉"
        paid = is_fraud and bool(re.search(PAID_WORDS, text))
        high = is_fraud and (paid or registry.get("registered") is not True)
        alert = similar.get("matched_alert")
        trace.run_tool(state, "create_ticket", {"category": category, "summary": message[:120], "level": "high" if high else "medium"})
        if high:
            trace.run_tool(state, "notify_family", {"message": "老人遇到要求预先付款的推销，请尽快电话确认并提醒暂缓付款。"})
        card = {
            "summary": f"{_honorific(state)}，您别慌，钱已经付出去也有办法，越快报警、越快找银行止付，追回的机会越大。" if paid else f"{_honorific(state)}，您问得太及时了！这和{alert['from']}刚发的防骗提醒是同一种说法，千万先别交钱，我马上报给工作人员。" if (is_fraud and alert) else f"{_honorific(state)}，您先问一声是对的。这种要先交钱的说法和常见骗局很像，先别交钱，我帮您报给工作人员核实。" if is_fraud else f"{_honorific(state)}，别着急，多收的钱可以要回来。我已经帮您整理好投诉，先把凭证留好。",
            "immediate_actions": ([PAID_ACTION, "把转账记录、收款账号和聊天记录都留好，别删", "点下面“确认提交”，工作人员会协助您报案"] if paid else ["先别交定金、别转账，也别把验证码告诉任何人", "把对方电话、宣传单和聊天记录拍照留好", "点下面“确认提交”，工作人员会来帮您核实"] if is_fraud else ["把收费单据和价目表拍照留好", "点下面“确认提交”，工作人员会跟机构核对", "核实多收后，差额可以申请退还"]),
            "place_route": "留在机构内，由工作人员核实",
            "price": "任何定金、预付款、会员费都先别交" if is_fraud else "按机构公示价格收费，多收部分可以退",
            "phone": "110" if high else "12315",
            "risk_level": "high" if high else "medium",
            "escalate": True,
            "rationale": [f"机构核查：{registry.get('note')}" if registry.get("registered") is not None else "未提到具体机构，需工作人员核实", f"命中防骗提醒：{'、'.join(alert['shared'][:3])}" if alert else f"相似案例：{similar.get('count', 0)} 条", "出现预付款/高回报/限时等话术" if is_fraud else "涉及收费与服务质量争议"],
            "intent": "fraud" if is_fraud else "complaint",
        }
    else:
        trace.add("plan", "规划下一步", "诉求不明确：请老人补充时间、地点或遇到的事")
        card = {"summary": f"{_honorific(state)}，我没太听明白，您能再说说想去哪里，或者遇到了什么事吗？", "immediate_actions": ["比如说“明天想去某个地方”，或“有人让我交钱”", "说不清也没关系，可以直接找工作人员帮忙"], "place_route": "留在当前位置", "price": "—", "phone": (state.get("dutyRoster") or [{}])[0].get("phone", "12345"), "risk_level": "low", "escalate": False, "rationale": ["未识别到出行、收费或求助意图"], "intent": "consult", "mode": "chat"}
    trace.add("decide", "生成适老建议卡", "按白名单校正电话，保留依据")
    return {"card": finalize_card(card, trace, state, message), "trace": trace.steps, "actions": trace.actions}
