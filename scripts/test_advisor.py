"""AI 监管参谋回归：只读工具、证据编号核对、规则路由（模拟模型接口，不联网）。"""
import json
import sys
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import advisor  # noqa: E402
import insight  # noqa: E402

STATE = json.loads((ROOT / "seed.json").read_text(encoding="utf-8"))


class FakeModel(BaseHTTPRequestHandler):
    def do_POST(self):  # noqa: N802
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        called = any(m.get("role") == "tool" for m in body["messages"])
        if body.get("response_format"):
            content = json.dumps({"answer": "有 3 件高风险事件（EV-20260810-017）", "findings": [{"text": "血压偏高", "evidence": ["EV-20260810-017", "EV-0000-FAKE"]}, {"text": "编造的事 EV-1234-XYZ", "evidence": []}], "suggestions": ["督办"], "followups": ["还有吗"]}, ensure_ascii=False)
            msg = {"role": "assistant", "content": content}
        elif not called and body.get("tools"):
            msg = {"role": "assistant", "content": "", "tool_calls": [{"id": "a", "type": "function", "function": {"name": "query_events", "arguments": json.dumps({"level": "high"})}}]}
        else:
            msg = {"role": "assistant", "content": "好"}
        out = json.dumps({"choices": [{"message": msg}]}, ensure_ascii=False).encode()
        self.send_response(200); self.send_header("Content-Length", str(len(out))); self.end_headers(); self.wfile.write(out)

    def log_message(self, *args):
        pass


class AdvisorTest(unittest.TestCase):
    def test_tools_are_read_only_and_counted_from_ledger(self):
        before = json.dumps(STATE, ensure_ascii=False, sort_keys=True)
        high = advisor.tool_query_events(STATE, {"level": "high"})
        self.assertEqual(high["count"], sum(e.get("level") == "high" and e.get("status") in advisor.OPEN for e in STATE["events"]))
        inst = advisor.tool_query_institutions(STATE, {"name": "北海银龄"})["items"][0]
        residents = {r["id"]: r for r in STATE["residents"]}  # 事件按“标注机构 > 地点里的机构名 > 老人所属机构”归属，与服务质量评价同一口径
        self.assertEqual(inst["投诉类"], sum(e.get("category") in {"服务投诉", "消费纠纷"} and insight.institution_of(e, STATE["institutions"], residents) == "北海银龄康养中心" for e in STATE["events"]))
        self.assertEqual(inst["投诉类"], 3)  # 含刘志远的边境低价团；防城港机构老人的投诉不计入
        self.assertEqual(json.dumps(STATE, ensure_ascii=False, sort_keys=True), before)

    def test_model_evidence_is_checked_against_tool_results(self):
        server = HTTPServer(("127.0.0.1", 0), FakeModel)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            out = advisor.run_model("有哪些事要督办", STATE, {"api_key": "x", "model": "m"}, f"http://127.0.0.1:{server.server_port}/c", lambda t: t)
        finally:
            server.shutdown(); server.server_close()
        card = out["card"]
        self.assertEqual(card["findings"][0]["evidence"], ["EV-20260810-017"])
        self.assertEqual(card["findings"][1]["evidence"], [])
        self.assertNotIn("EV-1234", card["findings"][1]["text"])
        self.assertEqual(card["dropped_ids"], 2)
        self.assertNotIn("EV-", card["answer"])

    def test_text_evidence_is_not_counted_as_fake_and_ids_next_to_chinese_are_found(self):
        trace = advisor.Trace()
        trace.run(STATE, "query_events", {"level": "high"})
        card = advisor.finalize({"answer": "北海银龄康养中心（IN-04501）需关注", "findings": [{"text": "EV-20260809-103由公安优先响应", "evidence": ["监管总览"]}], "suggestions": ["催复核EV-20260809-103和EV-103，今日内"]}, trace)
        self.assertEqual(card["dropped_ids"], 2)  # IN-04501（本次未查询）与缩写 EV-103，“监管总览”不算
        self.assertEqual(card["answer"], "北海银龄康养中心需关注")
        self.assertEqual(card["findings"][0], {"text": "由公安优先响应", "evidence": ["EV-20260809-103"]})
        self.assertEqual(card["suggestions"], ["催复核EV-20260809-103，今日内"])

    def test_rule_routing(self):
        cases = {"今天哪些老人最需要重点关注": "query_care", "有没有老人外出超时没回来": "query_movements", "北海银龄康养中心最近投诉多吗": "query_institutions", "巴马的诈骗线索怎么样了": "query_radar", "整体情况如何": "overview"}
        for question, tool in cases.items():
            out = advisor.run_rules(question, STATE)
            self.assertIn(tool, [s["tool"] for s in out["trace"]], question)
            for finding in out["card"]["findings"]:
                self.assertTrue(finding["evidence"], question)


class AdvisorLedgerTest(unittest.TestCase):
    def test_residents_query_hides_phone_and_unit_number(self):
        out = advisor.tool_query_residents(STATE, {"living_alone": True})
        self.assertEqual([r["name"] for r in out["items"]], ["吴秀珍"])
        text = json.dumps(out, ensure_ascii=False)
        self.assertNotIn("502", text)
        self.assertNotIn("0779", text)
        self.assertNotIn("135", text)

    def test_resident_tally_counts_everyone_even_when_list_is_cut(self):
        out = advisor.tool_query_residents(STATE, {})
        self.assertEqual(out["count"], len(STATE["residents"]))
        self.assertEqual(sum(out["按机构"].values()), len(STATE["residents"]))
        self.assertIn("防城港滨海颐养社区", out["按机构"])
        self.assertIn("入住日期", out["items"][0])

    def test_get_record_by_any_id(self):
        self.assertEqual(advisor.tool_get_record(STATE, {"id": "EV-20260810-015"})["record"]["status"], "处置中")
        self.assertEqual(advisor.tool_get_record(STATE, {"id": "GX-LJ-2026-000352"})["类型"], "老人档案")
        self.assertFalse(advisor.tool_get_record(STATE, {"id": "EV-19990101-000"})["found"])

    def test_write_and_draft_requests_are_recognised(self):
        for q in ["把EV-20260810-015标记为已办结", "将孙和平的事件转派给公安", "删除EV-20260810-015"]:
            self.assertTrue(advisor.WRITE_RE.search(q), q)
        for q in ["帮我看看哪些事件还没关闭", "哪些机构需要修改收费公示", "这周有哪些事要督办？"]:
            self.assertFalse(advisor.WRITE_RE.search(q), q)
        self.assertTrue(advisor.DRAFT_RE.search("帮我起草一份给北海银龄康养中心的督办通知"))
        self.assertFalse(advisor.DRAFT_RE.search("北海银龄康养中心收到督办通知了吗"))

    def test_rules_refuse_to_modify_and_draft_notice(self):
        out = advisor.run_rules("把EV-20260810-015标记为已办结", STATE)["card"]
        self.assertTrue(out["answer"].startswith("AI 参谋只能查询"))
        self.assertIn("处置中", out["answer"])
        draft = advisor.run_rules("帮我起草一份给北海银龄康养中心的督办通知", STATE)["card"]["draft"]
        self.assertIn("北海银龄康养中心：", draft)
        self.assertIn("EV-20260810-015", draft)
        self.assertNotIn("违法", draft)

    def test_tool_names_are_not_shown(self):
        card = advisor.finalize({"answer": "query_residents 按来源返回 0 条", "findings": [{"text": "get_record 查到 1 条", "evidence": []}], "suggestions": ["再用 query_events 查一次"]}, advisor.Trace())
        text = card["answer"] + "".join(f["text"] for f in card["findings"]) + "".join(card["suggestions"])
        self.assertNotRegex(text, "[a-z]+_[a-z]+")
        self.assertIn("查询老人档案", card["answer"])

    def test_answer_keeps_no_gap_after_removed_id(self):
        card = advisor.finalize({"answer": "AI 参谋只能查询。EV-20260810-015 现状态为处置中", "findings": [], "suggestions": []}, advisor.Trace())
        self.assertIn("查询。现状态", card["answer"])


if __name__ == "__main__":
    unittest.main()
