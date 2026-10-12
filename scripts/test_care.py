"""AI 主动预警回归：规则信号、模型不能降级高危、编号核对、结果缓存（模拟模型接口，不联网）。"""
import copy
import json
import sys
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import care  # noqa: E402

STATE = json.loads((ROOT / "seed.json").read_text(encoding="utf-8"))
SUN, WANG, CHEN, ZHAO = "GX-LJ-2026-000189", "GX-LJ-2026-000267", "GX-LJ-2026-000205", "GX-LJ-2026-000251"
CALLS = []


class FakeModel(BaseHTTPRequestHandler):
    def do_POST(self):  # noqa: N802
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        CALLS.append(body)
        items = [
            {"id": SUN, "priority": "low", "headline": "孙和平一切正常", "insight": "", "actions": [], "evidence": [SUN]},  # 试图把超时未归降级
            {"id": CHEN, "priority": "high", "headline": "陈美华涉诈又要跨市出行（EV-20260809-103）", "insight": "推销人可能约她去南宁当面交钱",
             "actions": [{"who": "社工", "what": "当面核实去南宁的目的 EV-20260809-103", "when": "今日下班前"}], "evidence": ["EV-20260809-103", "MV-0810-020", "EV-2026-FAKE"]},
        ]
        out = json.dumps({"choices": [{"message": {"role": "assistant", "content": json.dumps({"items": items}, ensure_ascii=False)}}]}, ensure_ascii=False).encode()
        self.send_response(200); self.send_header("Content-Length", str(len(out))); self.end_headers(); self.wfile.write(out)

    def log_message(self, *args):
        pass


class CareTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = HTTPServer(("127.0.0.1", 0), FakeModel)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.endpoint = f"http://127.0.0.1:{cls.server.server_port}/chat/completions"
        cls.config = {"api_key": "test", "model": "deepseek-chat"}

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown(); cls.server.server_close()

    def setUp(self):
        care._CACHE.clear(); CALLS.clear()

    def test_rule_signals_and_priorities(self):
        dossiers = {d["id"]: d for d in care.build_dossiers(STATE)}
        self.assertEqual(dossiers[SUN]["floor"], "high")  # 超时未归
        self.assertIn("MV-0810-019", [e for s in dossiers[SUN]["signals"] for e in s["evidence"]])
        kinds = {s["kind"] for s in dossiers[CHEN]["signals"]}
        self.assertTrue({"事件", "外出", "类案"} <= kinds)
        out = care.analyze(STATE, allow_model=False)
        pri = {i["id"]: i["priority"] for i in out["items"]}
        self.assertEqual((pri[SUN], pri[WANG]), ("high", "high"))
        self.assertNotEqual(pri[ZHAO], "high")
        self.assertEqual(out["source"], "规则信号")
        self.assertEqual(sum(out["counts"].values()), len(STATE["residents"]))

    def test_open_fraud_lead_cannot_be_downgraded(self):
        huang = {d["id"]: d for d in care.build_dossiers(STATE)}["GX-LJ-2026-000143"]
        self.assertEqual(huang["floor"], "medium")
        item = care._merge(huang, {"id": huang["id"], "priority": "low"})  # 模型给了 low，也要升回“今天留意”
        self.assertEqual(item["priority"], "medium")
        self.assertTrue(any("先别交钱" in a["what"] for a in item["actions"]))
        self.assertNotIn("外出外出", json.dumps(care.build_dossiers(STATE), ensure_ascii=False))

    def test_daily_check_concern_rule(self):
        ok = {"sleep": "良好", "appetite": "良好", "mood": "平稳", "mobility": "正常"}
        self.assertIsNone(care.daily_check_concern(ok, None))
        self.assertFalse(care.daily_check_concern({**ok, "sleep": "一般"}, ok)["notify"])  # 偶尔一次一般：只记下
        self.assertTrue(care.daily_check_concern({**ok, "sleep": "一般"}, {**ok, "appetite": "一般"})["notify"])  # 连续两次
        self.assertTrue(care.daily_check_concern({**ok, "mobility": "行动困难"}, None)["notify"])  # 重的一次就提醒

    def test_device_and_living_alone_signals(self):
        dossiers = {d["id"]: d for d in care.build_dossiers(STATE)}
        sun = [s for s in dossiers[SUN]["signals"] if s["kind"] == "设备"]
        self.assertEqual([s["evidence"] for s in sun], [["DV-0003"]])  # 超时未归的老人手环也离线
        self.assertIn("DV-0003", care.ID_RE.findall("证据 DV-0003"))  # 设备编号能通过引用核对
        wu = dossiers["GX-LJ-2026-000352"]
        self.assertIn("居住", {s["kind"] for s in wu["signals"]})  # 居家独居
        ma = [s for s in dossiers["GX-LJ-2026-000366"]["signals"] if s["kind"] == "设备"]
        self.assertTrue(ma and "低电量" in ma[0]["text"])

    def test_truncated_model_output_keeps_complete_rows(self):
        cut = '{"items":[{"id":"%s","priority":"high","headline":"超时未归且手环离线"},\n {"id":"%s","priority":"low"},{"id":"%s","headline":"写到一半' % (SUN, ZHAO, WANG)
        rows = care.parse_items(cut)
        self.assertEqual([r["id"] for r in rows], [SUN, ZHAO])  # 王建国那条没写完，交给规则结果
        with self.assertRaises(json.JSONDecodeError):
            care.parse_items("not json")

    def test_model_merge_floor_evidence_and_cache(self):
        out = care.analyze(STATE, self.config, self.endpoint)
        items = {i["id"]: i for i in out["items"]}
        self.assertEqual(items[SUN]["priority"], "high")  # 模型不能降级
        chen = items[CHEN]
        self.assertEqual((chen["priority"], chen["rule_priority"], chen["by"]), ("high", "medium", "DeepSeek"))
        self.assertEqual(chen["evidence"], ["EV-20260809-103", "MV-0810-020"])
        self.assertEqual(chen["dropped_ids"], 1)
        self.assertNotIn("EV-", chen["headline"] + chen["actions"][0]["what"])  # 编号只放在证据里
        self.assertEqual(items[WANG]["by"], "规则")  # 模型没提到的老人仍给规则结果
        self.assertIn("DeepSeek", out["source"])
        again = care.analyze(STATE, self.config, self.endpoint)
        self.assertEqual(len(CALLS), 1)  # 台账没变不重复调用
        self.assertIn("沿用", again["note"])

    def test_rules_mode_marks_pending_and_follow_up_is_not_a_signal(self):
        out = care.analyze(STATE, self.config, self.endpoint, allow_model=False)
        self.assertTrue(out["pending_ai"]); self.assertEqual(CALLS, [])
        state = copy.deepcopy(STATE)
        state["serviceLogs"].insert(0, {"id": "SV-X", "residentId": ZHAO, "resident": "赵秀兰", "type": care.FOLLOW_UP, "time": "今日", "result": "今日内：午后复测血压", "status": "待执行"})
        before = [s["text"] for d in care.build_dossiers(STATE) if d["id"] == ZHAO for s in d["signals"]]
        after = [s["text"] for d in care.build_dossiers(state) if d["id"] == ZHAO for s in d["signals"]]
        self.assertEqual(before, after)

    def test_model_failure_falls_back(self):
        out = care.analyze(STATE, self.config, "http://127.0.0.1:9/chat/completions")
        self.assertEqual(out["source"], "规则信号")
        self.assertIn("暂不可用", out["note"])


if __name__ == "__main__":
    unittest.main()
