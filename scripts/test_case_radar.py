"""类案雷达回归：归并规则、研判报告（模拟模型接口，不联网）、推送与可见范围权限。"""
import copy
import tempfile
import json
import re
import sys
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import case_radar  # noqa: E402
import server  # noqa: E402

STATE = json.loads((ROOT / "seed.json").read_text(encoding="utf-8"))
_TMP = tempfile.TemporaryDirectory()
case_radar.AI_CACHE_PATH = Path(_TMP.name) / "radar_ai_cache.json"  # 测试不写真实缓存


def reset_ai_cache():
    case_radar._AI_CACHE = {}


def event(eid, resident_id, category, text, level="medium"):
    return {"id": eid, "residentId": resident_id, "resident": resident_id, "category": category, "title": text[:12], "summary": text, "level": level, "status": "待复核", "time": "今日"}


class ClusterTest(unittest.TestCase):
    def test_seed_data_finds_fraud_and_fee_clusters(self):
        clusters = case_radar.find_clusters(STATE["events"])
        self.assertEqual([c["kind"] for c in clusters], ["fraud", "consumer", "consumer"])
        fraud = clusters[0]
        fee = next(c for c in clusters if "收费高于公示" in c["common_clues"])
        border = next(c for c in clusters if "低价团/强制购物" in c["common_clues"])
        self.assertEqual(fraud["risk"], "high")
        self.assertEqual(len(fraud["residents"]), 3)
        self.assertIn("巴马长寿养生基地", fraud["entities"])
        self.assertIn("预付/定金", fraud["clues"])
        self.assertEqual(fee["risk"], "medium")
        self.assertEqual(len(fee["residents"]), 2)
        # 边境低价游：北海、防城港两家机构的老人分别上报，归为一类，且不与收费类案混在一起
        self.assertEqual(set(border["event_ids"]), {"EV-20260810-036", "EV-20260809-131"})
        self.assertFalse(set(border["event_ids"]) & set(fee["event_ids"]))
        self.assertEqual(case_radar.template_report(border)["title"], "边境低价游进店强制购物类案")
        self.assertTrue(all(m["residentId"] for c in clusters for m in c["members"]))

    def test_short_live_report_joins_existing_case_and_keeps_id(self):
        before = case_radar.find_clusters(STATE["events"])[0]
        live = event("EV-LIVE", STATE["profile"]["id"], "涉老诈骗风险", "有个养生基地让我今天交一万块定金", "high")
        after = case_radar.find_clusters([live] + STATE["events"])[0]
        self.assertIn("EV-LIVE", after["event_ids"])
        self.assertEqual(after["id"], before["id"])  # 编号稳定，处置记录不丢
        member = next(m for m in after["members"] if m["id"] == "EV-LIVE")
        self.assertIn("预付/定金", member["clues"])

    def test_unrelated_fraud_pattern_is_not_pulled_in(self):
        other = event("EV-FP", "R9", "涉老诈骗风险", "有人打电话说是儿子出车祸要马上转账")
        self.assertNotIn("EV-FP", [i for c in case_radar.find_clusters([other] + STATE["events"]) for i in c["event_ids"]])

    def test_same_resident_twice_is_not_a_cluster(self):
        text = "推销员要求预交巴马养生基地定金，说包吃包住"
        self.assertEqual(case_radar.find_clusters([event("E1", "R1", "涉老诈骗风险", text), event("E2", "R1", "涉老诈骗风险", text)]), [])

    def test_fraud_and_fee_complaints_are_not_mixed(self):
        items = [event("E1", "R1", "涉老诈骗风险", "有人要求预交定金，收费很高"), event("E2", "R2", "服务投诉", "机构预交定金后收费高于公示")]
        self.assertEqual(case_radar.find_clusters(items), [])

    def test_unrelated_reports_stay_separate(self):
        items = [event("E1", "R1", "服务投诉", "午餐太咸了希望少放盐"), event("E2", "R2", "服务投诉", "房间空调遥控器坏了")]
        self.assertEqual(case_radar.find_clusters(items), [])

    def test_entity_names_are_cleaned(self):
        names = case_radar._entities("电话推销巴马养生基地投资项目，有个“长寿村康养旅居团”")
        self.assertIn("巴马养生基地", names)
        self.assertIn("长寿村康养旅居团", names)
        self.assertFalse(any(name.startswith(("电话", "有个")) for name in names))


class ReportTest(unittest.TestCase):
    calls = 0
    reply = "{}"

    class Mock(BaseHTTPRequestHandler):
        def do_POST(self):  # noqa: N802
            self.rfile.read(int(self.headers["Content-Length"]))
            ReportTest.calls += 1
            out = json.dumps({"choices": [{"message": {"content": ReportTest.reply}}]}, ensure_ascii=False).encode()
            self.send_response(200); self.send_header("Content-Length", str(len(out))); self.end_headers(); self.wfile.write(out)

        def log_message(self, *args):
            pass

    def setUp(self):
        reset_ai_cache()
        case_radar.REPORT_CACHE.clear()
        ReportTest.calls = 0
        self.http = HTTPServer(("127.0.0.1", 0), self.Mock)
        threading.Thread(target=self.http.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.http.server_port}/chat/completions"
        self.config = {"api_key": "x", "model": "deepseek-chat"}

    def tearDown(self):
        self.http.shutdown(); self.http.server_close()
        case_radar.REPORT_CACHE.clear()

    def test_model_report_is_trimmed_and_cached(self):
        ReportTest.reply = json.dumps({"title": "长" * 80, "pattern": "同一话术", "judgement": "符合预付款骗局特征", "actions": ["推送提醒", "核查资质", "移交公安", "多余一条"]}, ensure_ascii=False)
        first = case_radar.analyze(STATE["events"], self.config, self.url)
        self.assertEqual(first["source"], "规则归并 + DeepSeek研判")
        report = first["clusters"][0]["report"]
        self.assertEqual(report["by"], "DeepSeek")
        self.assertLessEqual(len(report["title"]), 30)
        self.assertEqual(len(report["actions"]), 3)
        calls = ReportTest.calls
        case_radar.analyze(STATE["events"], self.config, self.url)
        self.assertEqual(ReportTest.calls, calls)  # 同一组证据不重复调用模型

    def test_unsupported_registration_claim_is_rejected(self):
        ReportTest.reply = json.dumps({"pattern": "多名老人被要求交定金", "judgement": "涉事机构均未在登记名录中查到，已构成诈骗", "actions": ["核查"]}, ensure_ascii=False)
        result = case_radar.analyze(STATE["events"], self.config, self.url)
        report = result["clusters"][0]["report"]
        self.assertEqual(report["by"], "模板")
        self.assertIn("note", report)

    def test_model_cannot_change_title(self):
        ReportTest.reply = json.dumps({"title": "随意改写的标题", "pattern": "同一话术", "judgement": "符合预付款骗局特征", "actions": ["推送提醒"]}, ensure_ascii=False)
        cluster = case_radar.analyze(STATE["events"], self.config, self.url)["clusters"][0]
        self.assertEqual(cluster["report"]["title"], case_radar.template_report(cluster)["title"])

    def test_invalid_model_output_falls_back_to_template(self):
        ReportTest.reply = "不是JSON"
        result = case_radar.analyze(STATE["events"], self.config, self.url)
        self.assertEqual(result["source"], "规则归并 + 模板研判")
        self.assertTrue(all(c["report"]["by"] == "模板" for c in result["clusters"]))

    def test_no_key_never_calls_model(self):
        case_radar.analyze(STATE["events"], {"api_key": "", "model": "deepseek-chat"}, self.url)
        self.assertEqual(ReportTest.calls, 0)


class ExtractModel(BaseHTTPRequestHandler):
    """模拟 AI 抽取：按描述给出手法名称（真实评测用 DeepSeek，见 scripts/deepseek_eval.py）。"""
    calls = 0

    def do_POST(self):  # noqa: N802
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        ExtractModel.calls += 1
        data = json.loads(body["messages"][1]["content"])
        items = []
        for e in data["事件"]:
            text = e["标题"] + e["描述"]
            scheme = "冒充亲属借钱" if re.search("孙子|儿子|叫爸", text) else "养生基地预付款" if re.search("巴马|长寿", text) else "收费高于公示" if "收费" in text else "其他"
            items.append({"id": e["id"], "scheme": scheme, "subject": "孙子" if "孙子" in text else "", "tactics": ["冒充亲属", "催促转账"] if scheme == "冒充亲属借钱" else ["先交定金"], "money": True})
        out = json.dumps({"choices": [{"message": {"content": json.dumps({"items": items}, ensure_ascii=False)}}]}, ensure_ascii=False).encode()
        self.send_response(200); self.send_header("Content-Length", str(len(out))); self.end_headers(); self.wfile.write(out)

    def log_message(self, *args):
        pass


class AIClueTest(unittest.TestCase):
    def setUp(self):
        reset_ai_cache()
        ExtractModel.calls = 0
        self.http = HTTPServer(("127.0.0.1", 0), ExtractModel)
        threading.Thread(target=self.http.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.http.server_port}/c"

    def tearDown(self):
        self.http.shutdown(); self.http.server_close()

    def test_ai_finds_cluster_rules_miss_and_caches(self):
        rule_only = case_radar.find_clusters(STATE["events"])
        self.assertFalse(any("EV-20260810-031" in c["event_ids"] for c in rule_only))
        features, extracted = case_radar.ai_features(STATE["events"], {"api_key": "x", "model": "m"}, self.url, lambda t: t)
        self.assertGreater(extracted, 0)
        clusters = case_radar.find_clusters(STATE["events"], features=features)
        imp = next(c for c in clusters if "EV-20260810-031" in c["event_ids"])
        self.assertEqual(imp["found_by"], "AI")
        self.assertIn("EV-20260809-126", imp["event_ids"])
        self.assertIn("冒充亲属借钱", case_radar.template_report(imp)["title"])
        self.assertIn("冒充亲属", imp["clues"])
        bama = next(c for c in clusters if "EV-20260810-024" in c["event_ids"])
        self.assertNotIn("EV-20260810-031", bama["event_ids"])  # 不同手法不混在一起
        calls = ExtractModel.calls
        case_radar.ai_features(STATE["events"], {"api_key": "x", "model": "m"}, self.url, lambda t: t)
        self.assertEqual(ExtractModel.calls, calls)  # 每条事件只抽取一次
        self.assertIn("EV-20260810-031", case_radar.cached_features(STATE["events"]))


class BroadcastPermissionTest(unittest.TestCase):
    def notice(self, **extra):
        return {"id": "BC-CL-1", "title": "防骗提醒", "text": "请不要预付款" * 40, "clusterId": "CL-1", "time": "今日", "from": "主管部门", "secret": "x", **extra}

    def test_regulator_broadcast_is_trimmed_to_known_fields(self):
        merged = server.merge_authorized(STATE, {"broadcasts": [self.notice()]}, "regulator", "broadcast", "BC-CL-1")
        item = merged["broadcasts"][0]
        self.assertNotIn("secret", item)
        self.assertLessEqual(len(item["text"]), 160)

    def test_only_regulator_can_broadcast(self):
        for role in ("elder", "provider"):
            with self.assertRaises(PermissionError):
                server.merge_authorized(STATE, {"broadcasts": [self.notice()]}, role, "broadcast", "BC-CL-1")
        with self.assertRaises(ValueError):
            server.merge_authorized(STATE, {"broadcasts": []}, "regulator", "broadcast", "BC-CL-1")

    def test_class_case_record_is_hidden_from_elder(self):
        raw = copy.deepcopy(STATE)
        own = raw["profile"]["id"]
        raw["events"].insert(0, {"id": "EV-CLUSTER", "residentId": own, "clusterId": "CL-1", "summary": "周桂英、陈美华等"})
        self.assertNotIn("EV-CLUSTER", [e["id"] for e in server.public_state(raw, "elder")["events"]])
        self.assertIn("EV-CLUSTER", [e["id"] for e in server.public_state(raw, "provider")["events"]])


if __name__ == "__main__":
    unittest.main()
