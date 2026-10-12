"""类案雷达：把不同老人分别上报的相似事件归并为"类案"，并生成研判报告。

归并只用可解释的特征（文本二元组相似度 + 共同关键线索 + 事件类别），不依赖大模型；
大模型（如已配置）只负责把已归并的证据写成研判报告，结果按事件集合缓存，避免重复计费。
"""
from __future__ import annotations

import hashlib
import json
import re
import threading
import urllib.request
from pathlib import Path
from typing import Any, Callable

WATCH_CATEGORIES = {"涉老诈骗风险", "服务投诉", "消费纠纷"}
CLUES = {
    "预付/定金": r"定金|预付|先交|预交|锁定",
    "包住包吃": r"包住|包吃|包吃包住",
    "免费体检": r"免费体检|送体检|全身体检",
    "高回报投资": r"投资|返\d+%|年返|回报|收益",
    "限时催促": r"今天截止|当天交|今天交|今天就交|名额有限|今天必须|马上",
    "索要验证码": r"验证码",
    "转个人账户": r"个人账户|私人账户",
    "巴马/长寿村": r"巴马|长寿村|长寿",
    "养生基地/康养团": r"养生基地|康养旅居团|康养团|养生项目",
    "会员卡": r"会员卡|会员",
    "收费高于公示": r"公示|收费|多收|差额",
    "低价团/强制购物": r"低价|低于成本|零团费|购物点|玉器|强制购物|进店",
}
REPORT_CACHE: dict[str, dict[str, Any]] = {}
UNVERIFIED_FACTS = r"未登记|无登记|没有登记|未在登记|登记名录|无资质|没有资质|未备案|无执照|无证经营|未取得许可"
DEFINITIVE = r"已构成|属于违法|违法行为|诈骗团伙|犯罪|骗子"


def _bigrams(text: str) -> set[str]:
    clean = re.sub(r"[\s，。！？、,.!?：:；;“”\"'（）()]", "", text or "")
    return {clean[i:i + 2] for i in range(len(clean) - 1)}


def _clues(text: str) -> set[str]:
    return {name for name, pattern in CLUES.items() if re.search(pattern, text or "")}


def _group(category: str) -> str:
    return "fraud" if category == "涉老诈骗风险" else "consumer"


def _entities(text: str) -> list[str]:
    found = re.findall(r"[“\"]([^”\"]{2,16})[”\"]", text or "")
    found += re.findall(r"([一-龥]{2,8}(?:基地|旅居团|康养团|公司|会所))", text or "")
    cleaned = []
    for item in found:
        item = re.sub(r"^.*?(?:推销|介绍|自称|名为|叫做)", "", item)
        item = item.lstrip("推销介绍绍要求预交提前说有个一的了在向给让去到")
        if item and item not in cleaned:
            cleaned.append(item)
    return cleaned[:4]


AI_CACHE_PATH = Path(__file__).resolve().parent / "runtime" / "radar_ai_cache.json"
_AI_CACHE: dict[str, dict[str, Any]] | None = None
_AI_LOCK = threading.Lock()
EXTRACT_PROMPT = """你是涉老诈骗与消费纠纷线索分析员。对每条老人上报事件，只依据原文抽取：
- scheme：问题手法的简短名称（4～10字），例如“养生基地预付款”“冒充亲属借钱”“保健品高价推销”“收费高于公示”。
  与“已有类型”是同一种手法时必须原样沿用已有名称；确实是新手法才新起名称。
- subject：原文中出现的机构、项目或冒充的身份（如“巴马长寿养生基地”“孙子”），原文没有就留空。
- tactics：对方用的具体话术或手段，最多4条，每条不超过8字，如“先交定金”“冒充儿子”“换了新号码”“限时催促”。
- money：对方是否要求老人付钱或转账（true/false）。
不得编造原文没有的内容。只输出JSON：{"items":[{"id":"…","scheme":"…","subject":"…","tactics":["…"],"money":true}]}"""


def _text(e: dict[str, Any]) -> str:
    return f"{e.get('title', '')}。{e.get('summary', '')}"


def _cache_key(e: dict[str, Any]) -> str:
    return f"{e.get('id')}:{hashlib.sha1(_text(e).encode()).hexdigest()[:8]}"


def _load_cache() -> dict[str, dict[str, Any]]:
    global _AI_CACHE
    if _AI_CACHE is None:
        try:
            _AI_CACHE = json.loads(AI_CACHE_PATH.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            _AI_CACHE = {}
    return _AI_CACHE


def _norm(scheme: str) -> str:
    """手法名称归一；“其他”“未知”这类泛称不参与归并，避免把不相干的上报混在一起。"""
    name = re.sub(r"[\s“”\"'，,、。（）()·-]", "", scheme or "")
    return "" if name in {"其他", "其它", "未知", "无", "不明", "一般咨询", "其他诈骗", "其他问题"} else name


def cached_features(events: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    """只读已有的 AI 抽取结果，不调用模型（供参谋、守护智能体等只读场景使用）。"""
    cache = _load_cache()
    return {e["id"]: cache[_cache_key(e)] for e in events if isinstance(e, dict) and _cache_key(e) in cache}


def ai_features(events: list[dict[str, Any]], config: dict[str, str], endpoint: str, clean: Callable[[str], str]) -> tuple[dict[str, dict[str, Any]], int]:
    """让大模型逐条抽取手法、名义、话术。每条事件只抽取一次（按文本指纹缓存），多条合并成一次调用。"""
    items = [e for e in events if isinstance(e, dict) and e.get("category") in WATCH_CATEGORIES]
    extracted = 0
    with _AI_LOCK:
        cache = _load_cache()
        pending = [e for e in items if _cache_key(e) not in cache]
        for start in range(0, len(pending), 12):
            batch = pending[start:start + 12]
            known = sorted({v["scheme"] for v in cache.values() if v.get("scheme")})
            body = {
                "model": config["model"], "temperature": 0.1, "max_tokens": 1500, "response_format": {"type": "json_object"},
                "messages": [{"role": "system", "content": EXTRACT_PROMPT}, {"role": "user", "content": json.dumps({"已有类型": known, "事件": [{"id": e["id"], "类别": e.get("category"), "标题": e.get("title"), "描述": e.get("summary")} for e in batch]}, ensure_ascii=False)}],
            }
            request = urllib.request.Request(endpoint, data=json.dumps(body, ensure_ascii=False).encode("utf-8"), method="POST", headers={"Authorization": f"Bearer {config['api_key']}", "Content-Type": "application/json"})
            with urllib.request.urlopen(request, timeout=60) as response:
                content = json.loads(response.read().decode("utf-8"))["choices"][0]["message"]["content"]
            rows = {str(r.get("id")): r for r in json.loads(clean(content)).get("items", []) if isinstance(r, dict)}
            for e in batch:
                row = rows.get(e["id"])
                if not row:
                    cache[_cache_key(e)] = {"scheme": "", "subject": "", "tactics": [], "money": False}  # 模型漏掉的也记下，不反复计费
                    extracted += 1
                    continue
                subject = str(row.get("subject") or "")[:16]
                cache[_cache_key(e)] = {
                    "scheme": str(row.get("scheme") or "")[:12],
                    "subject": subject if subject and subject in _text(e) else "",  # 名义必须在原文里出现
                    "tactics": [str(t)[:10] for t in (row.get("tactics") or []) if str(t).strip()][:4],
                    "money": bool(row.get("money")),
                }
                extracted += 1
        if extracted:
            try:
                AI_CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
                AI_CACHE_PATH.write_text(json.dumps(cache, ensure_ascii=False, indent=1), encoding="utf-8")
            except OSError:
                pass
    return cached_features(items), extracted


def radar_events(state: dict[str, Any]) -> list[dict[str, Any]]:
    """参与类案归并的事件：监管员人工判定“不属于类案”的个案不再参与归并（雷达、主动预警、参谋口径一致）。"""
    excluded = {item.get("eventId") for item in state.get("radarReviews") or [] if isinstance(item, dict) and item.get("decision") == "exclude"}
    return [e for e in state.get("events", []) if isinstance(e, dict) and e.get("id") not in excluded]


def find_clusters(events: list[dict[str, Any]], threshold: float = 0.2, features: dict[str, dict[str, Any]] | None = None) -> list[dict[str, Any]]:
    items = [e for e in events if isinstance(e, dict) and e.get("category") in WATCH_CATEGORIES]
    texts = {e["id"]: f"{e.get('title', '')}。{e.get('summary', '')}" for e in items}
    grams = {eid: _bigrams(text) for eid, text in texts.items()}
    clues = {eid: _clues(text) for eid, text in texts.items()}
    parent = {e["id"]: e["id"] for e in items}

    def root(x: str) -> str:
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    for i, a in enumerate(items):
        for b in items[i + 1:]:
            if _group(a["category"]) != _group(b["category"]):
                continue
            ga, gb = grams[a["id"]], grams[b["id"]]
            jaccard = len(ga & gb) / len(ga | gb) if ga and gb else 0
            shared = clues[a["id"]] & clues[b["id"]]
            score = jaccard + 0.12 * len(shared)
            if score >= threshold and shared:
                parent[root(a["id"])] = root(b["id"])

    rule_root = {e["id"]: root(e["id"]) for e in items}  # 只靠规则时的分组，用来标注类案由谁发现
    features = features or {}
    for i, a in enumerate(items):
        for b in items[i + 1:]:
            fa, fb = features.get(a["id"]), features.get(b["id"])
            if fa and fb and _group(a["category"]) == _group(b["category"]) and _norm(fa.get("scheme")) and _norm(fa.get("scheme")) == _norm(fb.get("scheme")):
                parent[root(a["id"])] = root(b["id"])  # AI 判断为同一手法

    groups: dict[str, list[dict[str, Any]]] = {}
    for e in items:
        groups.setdefault(root(e["id"]), []).append(e)
    clusters = []
    for members in groups.values():
        residents = {m.get("residentId") for m in members}
        if len(members) < 2 or len(residents) < 2:
            continue
        common = set.intersection(*(clues[m["id"]] for m in members))
        frequent = sorted({c for m in members for c in clues[m["id"]]}, key=lambda c: -sum(c in clues[m["id"]] for m in members))
        tactics = {m["id"]: (features.get(m["id"]) or {}).get("tactics", []) for m in members}
        ai_tactics = [t for t in sorted({t for ts in tactics.values() for t in ts}, key=lambda t: -sum(t in ts for ts in tactics.values())) if t not in frequent]
        schemes = [(features.get(m["id"]) or {}).get("scheme") for m in members if (features.get(m["id"]) or {}).get("scheme")]
        rule_groups = {rule_root[m["id"]] for m in members}
        found_by = "规则" if len(rule_groups) == 1 else "AI" if len(rule_groups) == len(members) else "规则+AI"
        combined = (frequent[:4] + ai_tactics)[:6] if frequent else ai_tactics[:6]
        fraud = _group(members[0]["category"]) == "fraud"
        entities = []
        for m in sorted(members, key=lambda item: item["id"]):  # 以最早上报的名称为主，标题不随新成员变化
            for ent in _entities(texts[m["id"]]):
                if ent not in entities:
                    entities.append(ent)
        ids = sorted(m["id"] for m in members)
        clusters.append({
            # 以最早的个案定编号：有新老人加入时编号不变，处置记录继续有效
            "id": "CL-" + hashlib.sha1(ids[0].encode()).hexdigest()[:8].upper(),
            "kind": "fraud" if fraud else "consumer",
            "category": members[0]["category"],
            "risk": "high" if fraud and (len(residents) >= 3 or any(m.get("level") == "high" for m in members)) else "medium",
            "event_ids": ids,
            "residents": sorted({m.get("resident", "") for m in members}),
            "count": len(members),
            "common_clues": sorted(common) or frequent[:3] or ai_tactics[:3],
            "clues": combined,
            "rule_clues": frequent[:6],
            "ai_clues": [t for t in combined if t in ai_tactics],
            "ai_scheme": max(set(schemes), key=schemes.count) if schemes else "",
            "found_by": found_by,
            # 被最多老人提到的名称排在前面（并列时取最早出现的），标题不随新成员变化
            "entities": sorted([e for e in entities if not any(e != o and e in o for o in entities)], key=lambda e: (-sum(e in texts[m["id"]] for m in members), -len(e)))[:4],
            "open": sum(1 for m in members if m.get("status") != "已办结"),
            "intercepted": sum(1 for m in members if m.get("interceptedBy")),
            "members": [{"id": m["id"], "residentId": m.get("residentId"), "resident": m.get("resident"), "clues": sorted(clues[m["id"]]) + [t for t in tactics[m["id"]] if t in combined], "scheme": (features.get(m["id"]) or {}).get("scheme", ""), "source": m.get("source", ""), "intercepted": bool(m.get("interceptedBy")), "time": m.get("time"), "title": m.get("title"), "status": m.get("status"), "level": m.get("level")} for m in members],
        })
    clusters.sort(key=lambda c: ({"high": 0, "medium": 1}.get(c["risk"], 2), -c["count"]))
    return clusters


def template_report(cluster: dict[str, Any]) -> dict[str, Any]:
    names = "、".join(cluster["residents"])
    subject = cluster["entities"][0] if cluster["entities"] else ("同类推销" if cluster["kind"] == "fraud" else "同一机构")
    if cluster["kind"] == "fraud" and cluster.get("found_by") == "AI" and cluster.get("ai_scheme"):
        # AI 识别出的新手法（如冒充亲属借钱）：没有机构名义，按手法命名
        return {
            "title": f"疑似“{cluster['ai_scheme']}”手法的涉老诈骗类案",
            "pattern": f"{len(cluster['residents'])} 位旅居老人（{names}）分别遇到相似手法：" + "、".join(cluster["clues"][:4]) + "。",
            "judgement": "多名老人分别遇到相似手法，符合涉老诈骗常见特征；是否同一主体待核实，需提醒老人，不直接定性。",
            "actions": ["向旅居老人推送防骗提醒", "提醒老人用原号码向亲属核实", "证据汇总后移交属地公安反诈中心"],
        }
    if cluster["kind"] == "fraud":
        return {
            "title": f"疑似以“{subject}”名义收取预付款的类案",
            "pattern": f"{len(cluster['residents'])} 位旅居老人（{names}）分别报告相似话术：" + "、".join(cluster["clues"][:4]) + "。",
            "judgement": "多名老人、多个渠道出现相似话术，符合涉老预付款骗局常见特征；是否同一主体需核实资质，不直接定性。",
            "actions": ["向同区域旅居老人推送防骗提醒", "核查该主体登记与经营资质", "证据汇总后移交属地公安反诈中心"],
        }
    if "低价团/强制购物" in cluster.get("common_clues", []):
        return {
            "title": "边境低价游进店强制购物类案",
            "pattern": f"{len(cluster['residents'])} 位旅居老人（{names}）分别反映低价跟团游被带进购物店：" + "、".join(cluster["clues"][:4]) + "。",
            "judgement": "不同机构的老人反映同一类低价团进店购物问题，提示旅行社经营可能不规范，需核实旅行社资质与合同，不直接定性。",
            "actions": ["向旅居老人推送低价团提醒", "通报文旅、市场监管部门核查旅行社资质", "协助已购物老人保留凭证、申请退货"],
        }
    return {
        "title": f"{subject}收费高于公示价格的类案",
        "pattern": f"{len(cluster['residents'])} 位老人（{names}）反映实际收费高于公示价格。",
        "judgement": "同一机构多项服务收费争议，提示价格公示或收费管理可能存在系统性问题。",
        "actions": ["要求机构自查收费记录与公示价格", "对已多收部分督促退还", "纳入机构服务质量评价"],
    }


REPORT_PROMPT = """你是旅居养老监管部门的研判助手。下面是系统按相似度自动归并的一组老人上报事件（已脱敏）。
请只依据这些事件写一份简短研判：
- 不得编造事件中没有的机构名称、金额或人数；
- 事件里没有登记、资质、备案、执照的核查结果，就不能写"未登记""无资质"等结论，只能建议"核查登记与资质"；
- 不直接认定违法或诈骗，只写"符合……特征"。
只输出JSON：pattern（共同话术或问题，≤60字）、judgement（研判结论，≤60字）、actions（最多3条监管建议，每条≤20字）。"""


def model_report(cluster: dict[str, Any], events: list[dict[str, Any]], config: dict[str, str], endpoint: str, clean: Callable[[str], str]) -> dict[str, Any]:
    evidence = [{"老人": e.get("resident"), "时间": e.get("time"), "事项": e.get("title"), "描述": e.get("summary")} for e in events if e.get("id") in cluster["event_ids"]]
    body = {
        "model": config["model"],
        "messages": [{"role": "system", "content": REPORT_PROMPT}, {"role": "user", "content": json.dumps({"类别": cluster["category"], "AI识别的手法": cluster.get("ai_scheme", ""), "共同线索": cluster["clues"], "事件": evidence}, ensure_ascii=False)}],
        "temperature": 0.2,
        "max_tokens": 400,
        "response_format": {"type": "json_object"},
    }
    request = urllib.request.Request(endpoint, data=json.dumps(body, ensure_ascii=False).encode("utf-8"), method="POST", headers={"Authorization": f"Bearer {config['api_key']}", "Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=40) as response:
        content = json.loads(response.read().decode("utf-8"))["choices"][0]["message"]["content"]
    data = json.loads(clean(content))
    base = template_report(cluster)
    evidence_text = "".join(f"{e.get('title', '')}{e.get('summary', '')}" for e in events if e.get("id") in cluster["event_ids"])
    claims = f"{data.get('pattern', '')}{data.get('judgement', '')}"
    if (re.search(UNVERIFIED_FACTS, claims) and not re.search(UNVERIFIED_FACTS, evidence_text)) or re.search(DEFINITIVE, claims):
        raise ValueError("unsupported_claim")  # 含证据里没有的核查结论或直接定性，退回模板
    return {
        "title": base["title"],  # 标题由归并结果确定，有新成员加入时不随模型改写
        "pattern": str(data.get("pattern") or base["pattern"])[:90],
        "judgement": str(data.get("judgement") or base["judgement"])[:90],
        "actions": [str(a)[:24] for a in (data.get("actions") or base["actions"])][:3],
    }


def analyze(events: list[dict[str, Any]], config: dict[str, str] | None = None, endpoint: str = "", clean: Callable[[str], str] = lambda t: t) -> dict[str, Any]:
    features, extracted, ai_note = {}, 0, ""
    if config and config.get("api_key"):
        try:
            features, extracted = ai_features(events, config, endpoint, clean)
        except Exception:  # 抽取失败不影响规则归并
            features, ai_note = cached_features(events), "AI 线索抽取暂不可用，已使用缓存结果和规则"
    else:
        features = cached_features(events)
    features = {k: v for k, v in features.items() if v.get("scheme")}  # 抽取失败的不算
    clusters = find_clusters(events, features=features)
    source = ("AI 线索抽取 + " if features else "") + "规则归并 + 模板研判"
    for cluster in clusters:
        key = cluster["id"] + ":" + str(len(cluster["event_ids"]))
        report = REPORT_CACHE.get(key)
        if report is None and config and config.get("api_key"):
            try:
                report = {**model_report(cluster, events, config, endpoint, clean), "by": "DeepSeek"}
                REPORT_CACHE[key] = report
            except ValueError as error:
                report = {**template_report(cluster), "by": "模板", "note": "模型研判含证据中没有的结论，已改用模板"} if str(error) == "unsupported_claim" else None
                if report:
                    REPORT_CACHE[key] = report
            except Exception:  # 模型不可用时退回模板，不影响归并结果
                report = None
        if report is None:
            report = {**template_report(cluster), "by": "模板"}
        cluster["report"] = report
        if report["by"] == "DeepSeek":
            source = ("AI 线索抽取 + " if features else "") + "规则归并 + DeepSeek研判"
    watched = [e for e in events if isinstance(e, dict) and e.get("category") in WATCH_CATEGORIES]
    return {
        "source": source,
        "scanned": len(watched),
        "clusters": clusters,
        "residents": len({r for c in clusters for r in c["residents"]}),
        "high": sum(1 for c in clusters if c["risk"] == "high"),
        "intercepted": sum(c["intercepted"] for c in clusters),
        "ai": {"features": len(features), "extracted": extracted, "note": ai_note, "found": sum(c["found_by"] != "规则" for c in clusters)},
    }
