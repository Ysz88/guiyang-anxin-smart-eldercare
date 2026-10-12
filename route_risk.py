"""Explainable demonstration of place suitability; unknown facts never become zero risk."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

PLACES = json.loads((Path(__file__).parent / "data" / "places.json").read_text(encoding="utf-8"))
# 出境行程的核查清单：境内路线评估之外，证件、境外就医、通信和旅行社资质都要在出发前落实
BORDER_AREA_CHECKLIST = ["随身带身份证，边境管理区可能查验", "不跟陌生人越界购物、换汇或“代购”", "约定报平安时间，山区信号弱时先告知路线"]
BORDER_CHECKLIST = ["本人有效护照或出入境通行证", "含境外医疗的旅游意外险（医保不能在境外直接结算）", "开通国际漫游并约定报平安时间", "旅行社资质与合同（警惕低价团强制购物）"]


def assess_route(resident: dict[str, Any], destination: str, hours: float = 2) -> dict[str, Any]:
    place = next((item for item in PLACES if item["match"] in destination), None)
    if not place:
        return {"level": "unknown", "score": None, "missing": ["该场所尚无踏勘资料"], "factors": [], "advice": ["请机构核验路线、台阶、休息点、通信条件与陪同安排。"], "source": "未收录", "verified": False, "framework": "V+H+E-C（演示规则，权重待试点验证）"}
    missing = [{"slope_score": "坡度", "steps_score": "台阶", "shade_score": "遮阴", "wheelchair": "无障碍通道", "network_level": "通信条件"}[key] for key in ("slope_score", "steps_score", "shade_score", "wheelchair", "network_level") if place.get(key) is None]
    factors: list[tuple[int, str]] = []
    conditions = "、".join(resident.get("conditions") or [])
    mobility = next((item for item in (resident.get("screening") or {}).get("dimensions", []) if item.get("label") == "肢体活动"), None)
    if mobility is None or mobility.get("level") == "unknown": missing.append("本人行动能力")
    if any(word in conditions for word in ("膝", "关节", "骨")): factors.append((25, "关节或行动病史"))
    if "高血压" in conditions: factors.append((10, "高血压史"))
    if int(resident.get("age") or 0) >= 80: factors.append((15, "年龄至少80岁"))
    if mobility and mobility.get("level") in {"medium", "high"}: factors.append((15 if mobility["level"] == "medium" else 30, "行动能力需关注"))
    for key, weight, label in (("slope_score", 6, "坡度"), ("steps_score", 5, "台阶"), ("shade_score", 3, "遮阴")):
        value = place.get(key)
        if value is not None and value <= 2: factors.append(((5 - value) * weight, label + "条件不足（模拟）"))
    if place.get("network_level") in {"weak", "none"}: factors.append((8 if place["network_level"] == "weak" else 15, "通信条件受限（模拟）"))
    if hours >= 3: factors.append((min(int(hours * 4), 20), "预计外出时长较长"))
    if place.get("border") == "cross": factors.append((20, "出境行程（证件、境外就医、通信需提前核实）"))
    elif place.get("border"): factors.append((0, "边境地区（随身带身份证）"))  # 只提醒，不加分：边境城市本身不代表路线更难走
    hard = place.get("wheelchair") == 0 and mobility and mobility.get("level") == "high"
    score = min(100, sum(points for points, _ in factors))
    level = "high" if hard or score >= 65 else "medium" if score >= 40 else "low"
    if missing and level == "low": level = "unknown"
    if place.get("border") == "cross" and level in {"low", "unknown"}: level = "medium"  # 出境行程至少“需关注”：证件、境外就医都要落实
    advice = []
    if place.get("border") == "cross": advice.append("出境前核实证件、境外医疗保险、国际漫游和旅行社资质；低价团警惕强制购物。")
    elif place.get("border"): advice.append("边境地区随身带身份证，不跟陌生人越界购物或换汇。")
    if hard: advice.append("无无障碍通道且行动能力较弱，建议改线并由人员确认。")
    if place.get("steps_score") is not None and place["steps_score"] <= 2: advice.append("建议核验无障碍入口或改用平缓路线。")
    if place.get("network_level") in {"weak", "none"}: advice.append("出发前约定报平安时间与失联后的联系办法。")
    if missing: advice.append("信息待核验：" + "、".join(missing) + "。")
    if not advice: advice.append("由机构核对实际路线和陪同方案后再出行。")
    return {"level": level, "score": score, "factors": [label for _, label in sorted(factors, reverse=True)[:3]], "missing": missing, "advice": advice[:3], "source": place["source"], "verified": False, "border": place.get("border") or "", "border_checklist": BORDER_CHECKLIST if place.get("border") == "cross" else BORDER_AREA_CHECKLIST if place.get("border") else [], "framework": "V+H+E-C（演示规则，权重待试点验证）"}
