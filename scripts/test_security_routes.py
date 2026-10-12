"""Cold boot, authorization and route risk regression without external services."""
import json
import os
from contextlib import closing
import sqlite3
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from database import BusinessDatabase  # noqa: E402
import server  # noqa: E402


class SecurityRoutes(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.original = server.DATABASE
        server.DATABASE = BusinessDatabase(Path(cls.tmp.name) / "sample.sqlite")
        server.DATABASE.initialize()
        cls.http = ThreadingHTTPServer(("127.0.0.1", 0), server.AppHandler)
        cls.thread = threading.Thread(target=cls.http.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = f"http://127.0.0.1:{cls.http.server_port}"
        cls.passwords = json.loads((Path(cls.tmp.name) / "demo_credentials.json").read_text())

    @classmethod
    def tearDownClass(cls):
        cls.http.shutdown()
        cls.http.server_close()
        cls.thread.join(timeout=2)
        server.DATABASE = cls.original
        cls.tmp.cleanup()

    def request(self, path, token="", payload=None):
        data = json.dumps(payload, ensure_ascii=False).encode() if payload is not None else None
        request = urllib.request.Request(self.base + path, data=data, headers={"Authorization": f"Bearer {token}"} if token else {}, method="POST" if payload is not None else "GET")
        try:
            with urllib.request.urlopen(request, timeout=4) as result:
                return result.status, json.loads(result.read()) if result.headers.get("Content-Type", "").startswith("application/json") else {}
        except urllib.error.HTTPError as error:
            return error.code, {}

    def raw_post(self, path, payload, headers):
        request = urllib.request.Request(self.base + path, data=json.dumps(payload).encode(), headers=headers, method="POST")
        try:
            with urllib.request.urlopen(request, timeout=4) as result:
                return result.status, json.loads(result.read())
        except urllib.error.HTTPError as error:
            return error.code, {}

    def test_device_alarm_creates_one_sos_ticket(self):
        self.assertEqual(self.request("/api/device-alarm", payload={"deviceId": "DV-0004"})[0], 401)
        self.assertEqual(self.request("/api/device-alarm", self.login("elder", "elder"), {"deviceId": "DV-0004"})[0], 403)
        self.assertEqual(self.request("/api/device-alarm", self.login("regulator", "admin"), {"deviceId": "DV-0004"})[0], 403)
        provider = self.login("provider", "center")
        self.assertEqual(self.request("/api/device-alarm", provider, {"deviceId": "DV-9999"})[0], 404)
        self.assertEqual(self.request("/api/device-alarm", provider, {"deviceId": "DV-0003"})[0], 409)  # 离线设备不能告警
        status, result = self.request("/api/device-alarm", provider, {"deviceId": "DV-0004"})
        self.assertEqual(status, 200)
        self.assertTrue(result["created"])
        session = result["session"]
        self.assertEqual((session["residentId"], session["status"], session["trigger"]), ("GX-LJ-2026-000352", "waiting", "设备告警·跌倒监测雷达"))
        self.assertIn("社区网格员", [c["role"] for c in session["contacts"]])
        again = self.request("/api/device-alarm", provider, {"deviceId": "DV-0004"})[1]
        self.assertFalse(again["created"])
        self.assertEqual(again["session"]["id"], session["id"])  # 重复告警不重复立单
        gas = self.request("/api/device-alarm", provider, {"deviceId": "DV-0005"})[1]
        self.assertEqual(gas["session"]["id"], session["id"])  # 同一老人另一台设备告警：追加到进行中工单
        self.assertIn("燃气", gas["session"]["timeline"][-1]["text"])
        tickets = [s for s in self.request("/api/sos", provider)[1]["sessions"] if s["residentId"] == "GX-LJ-2026-000352"]
        self.assertEqual(len(tickets), 1)
        audit = self.request("/api/audit?limit=5", self.login("regulator", "admin"))[1]["logs"]
        self.assertTrue(any(log["action"] == "设备告警生成呼救工单" for log in audit))

    def test_device_gateway_token(self):
        os.environ[server.DEVICE_TOKEN_ENV] = "gateway-secret"
        try:
            self.assertEqual(self.raw_post("/api/device-alarm", {"deviceId": "DV-0008"}, {"X-Device-Token": "wrong"})[0], 401)
            status, result = self.raw_post("/api/device-alarm", {"deviceId": "DV-0008"}, {"X-Device-Token": "gateway-secret"})
            self.assertEqual(status, 200)
            self.assertEqual(result["session"]["trigger"], "设备告警·独立式烟感")
        finally:
            del os.environ[server.DEVICE_TOKEN_ENV]
        self.assertEqual(self.raw_post("/api/device-alarm", {"deviceId": "DV-0008"}, {"X-Device-Token": "gateway-secret"})[0], 401)  # 未配置令牌时网关入口关闭

    def test_institution_scope_and_insight(self):
        provider = self.login("provider", "center")
        data = self.request("/api/state", provider)[1]["data"]
        self.assertNotIn("GX-LJ-2026-000405", [r["id"] for r in data["residents"]])  # 防城港机构的老人
        self.assertNotIn("EV-20260809-131", [e["id"] for e in data["events"]])
        self.assertIn("EV-20260810-036", [e["id"] for e in data["events"]])  # 本机构老人的边境行程事件
        self.assertEqual(self.request("/api/insight", provider)[0], 403)
        self.assertEqual(self.request("/api/insight")[0], 401)
        status, result = self.request("/api/insight", self.login("regulator", "admin"))
        self.assertEqual(status, 200)
        self.assertIn("边境", result["events"]["by_scene"])
        self.assertEqual(result["population"]["scenes"]["居家旅居"], 1)
        scored = [q for q in result["quality"] if q["sufficient"]]
        self.assertTrue(scored and all(d["evidence"] for q in scored for d in q["deductions"]))
        self.assertTrue(all(q["score"] is None for q in result["quality"] if not q["sufficient"]))

    def login(self, role, account):
        status, result = self.request("/api/login", payload={"role": role, "account": account, "password": self.passwords[role]})
        self.assertEqual(status, 200)
        return result["token"]

    def test_cold_boot_and_authentication(self):
        self.assertEqual(server.DATABASE.status()["counts"]["users"]["count"], 3)
        for method, path in (("GET", "/api/state"), ("GET", "/api/sos"), ("GET", "/api/audit"), ("POST", "/api/state"), ("POST", "/api/sos")):
            self.assertEqual(self.request(path, payload={} if method == "POST" else None)[0], 401)
        self.assertEqual(self.request("/seed.json")[0], 404)
        self.assertEqual(self.request("/runtime/demo_credentials.json")[0], 404)
        self.assertEqual(self.request("/api/login", payload={"role": "regulator", "account": "admin", "password": "bad"})[0], 401)
        token = self.login("elder", "elder")
        status, result = self.request("/api/state", token)
        self.assertEqual(status, 200)
        self.assertNotIn("password", json.dumps(result["data"], ensure_ascii=False))
        self.assertEqual(len(result["data"]["residents"]), 1)
        revision = result["revision"]
        self.assertEqual(self.request(f"/api/state?since={revision}", token)[1]["changed"], False)

    def test_role_scope_and_fake_sos_close(self):
        elder = self.login("elder", "elder")
        status, result = self.request("/api/state", elder)
        data = result["data"]
        self.assertEqual(self.request("/api/audit", elder)[0], 403)
        self.assertEqual(self.request("/api/state", elder, {"state": data, "audit": {"actor_role": "regulator", "entity_type": "database", "entity_id": "seed"}})[0], 403)
        fake = {"id": "SOS-forged", "residentId": data["profile"]["id"], "status": "resolved_safe", "riskLevel": "high"}
        self.assertEqual(self.request("/api/sos", elder, {"session": fake, "audit": {"actor_role": "provider"}})[0], 403)
        other = dict(fake, id="SOS-other", residentId="GX-OTHER", status="waiting")
        self.assertEqual(self.request("/api/sos", elder, {"session": other})[0], 403)
        provider = self.login("provider", "center")
        self.assertEqual(self.request("/api/sos", provider, {"session": fake})[0], 403)

    def test_event_evidence_is_bounded_and_allowlisted(self):
        elder = self.login("elder", "elder")
        _, result = self.request("/api/state", elder)
        data = result["data"]
        event_id = "EV-EVIDENCE-TEST"
        item = {"id": event_id, "residentId": data["profile"]["id"], "resident": data["profile"]["name"],
                "category": "涉老诈骗风险", "title": "测试证据链", "status": "待复核",
                "evidence": {"source": "老人对话主动透露", "secret": "must-drop",
                             "quotes": [{"time": "现在", "text": "话" * 200, "extra": "drop"}] * 8,
                             "checks": [{"tool": "check_institution", "label": "查证", "result": "结果" * 150, "extra": "drop"}] * 10,
                             "rules": ["规则" * 100] * 8, "confirmedAt": "现在"}}
        data["events"].insert(0, item)
        status, _ = self.request("/api/state", elder, {"state": data, "audit": {"entity_type": "risk_event", "entity_id": event_id}})
        self.assertEqual(status, 200)
        stored = next(e for e in server.DATABASE.read_state()["events"] if e["id"] == event_id)["evidence"]
        self.assertEqual(set(stored), {"source", "quotes", "checks", "rules", "movement", "matchedAlert", "provider", "confirmedAt"})
        self.assertEqual((len(stored["quotes"]), len(stored["checks"]), len(stored["rules"])), (3, 6, 3))
        self.assertEqual((len(stored["quotes"][0]["text"]), len(stored["checks"][0]["result"])), (80, 200))
        self.assertNotIn("extra", stored["quotes"][0])

    def test_weather_publish_checkin_and_role_scope(self):
        elder = self.login("elder", "elder")
        provider = self.login("provider", "center")
        regulator = self.login("regulator", "admin")
        request = {"type": "台风", "level": "蓝色", "cities": ["北海", "防城港"], "deadlineMinutes": 2,
                   "title": "伪造标题", "source": "伪造真实天气"}
        self.assertEqual(self.request("/api/weather-alert", payload=request)[0], 401)
        self.assertEqual(self.request("/api/weather-alert", elder, request)[0], 403)
        self.assertEqual(self.request("/api/weather-alert", provider, request)[0], 403)
        status, result = self.request("/api/weather-alert", regulator, request)
        self.assertEqual(status, 200)
        alert = result["alert"]
        self.assertEqual((alert["source"], alert["title"]), ("模拟预警（演示）", "台风蓝色预警 · 北海、防城港"))
        _, elder_view = self.request("/api/state", elder)
        own_id = elder_view["data"]["profile"]["id"]
        self.assertEqual(elder_view["data"]["weatherAlerts"][0]["affectedResidentIds"], [own_id])
        self.assertEqual({c["residentId"] for c in elder_view["data"]["safetyCheckins"]}, {own_id})
        _, provider_view = self.request("/api/state", provider)
        self.assertNotIn("GX-LJ-2026-000405", {c["residentId"] for c in provider_view["data"]["safetyCheckins"]})
        other = {"alertId": alert["id"], "residentId": "GX-LJ-2026-000405", "status": "safe"}
        self.assertEqual(self.request("/api/checkin", elder, other)[0], 403)
        self.assertEqual(self.request("/api/checkin", provider, other)[0], 403)
        self.assertEqual(self.request("/api/checkin", regulator, {**other, "residentId": own_id})[0], 403)
        status, response = self.request("/api/checkin", elder, {"alertId": alert["id"], "residentId": own_id, "status": "safe", "by": "伪造监管员", "extra": "drop"})
        self.assertEqual(status, 200)
        self.assertEqual(response["checkin"]["by"], "本人")
        target = next(c for c in provider_view["data"]["safetyCheckins"] if c["residentId"] != own_id)
        status, response = self.request("/api/checkin", provider, {"alertId": alert["id"], "residentId": target["residentId"], "status": "safe"})
        self.assertEqual(status, 200)
        self.assertEqual(response["checkin"]["by"], "机构代报")
        self.assertEqual(self.request("/api/weather-alert", regulator, {"action": "resolve", "alertId": alert["id"]})[0], 200)

    def test_radar_is_staff_only(self):
        self.assertEqual(self.request("/api/radar")[0], 401)
        self.assertEqual(self.request("/api/radar", self.login("elder", "elder"))[0], 403)
        original = server.load_config
        server.load_config = lambda: {**original(), "api_key": ""}  # 不在测试中调用真实模型
        try:
            status, result = self.request("/api/radar", self.login("regulator", "admin"))
        finally:
            server.load_config = original
        self.assertEqual(status, 200)
        self.assertGreaterEqual(len(result["clusters"]), 1)
        self.assertEqual(result["clusters"][0]["report"]["by"], "模板")

    def test_advisor_is_regulator_only(self):
        self.assertEqual(self.request("/api/advisor", payload={"question": "x"})[0], 401)
        self.assertEqual(self.request("/api/advisor", self.login("elder", "elder"), {"question": "有哪些事要督办"})[0], 403)
        self.assertEqual(self.request("/api/advisor", self.login("provider", "center"), {"question": "有哪些事要督办"})[0], 403)
        original = server.load_config
        server.load_config = lambda: {**original(), "api_key": ""}
        try:
            status, result = self.request("/api/advisor", self.login("regulator", "admin"), {"question": "有哪些事要督办"})
        finally:
            server.load_config = original
        self.assertEqual(status, 200)
        self.assertTrue(result["result"]["answer"])

    def test_care_is_staff_only(self):
        self.assertEqual(self.request("/api/care")[0], 401)
        self.assertEqual(self.request("/api/care", self.login("elder", "elder"))[0], 403)
        original = server.load_config
        server.load_config = lambda: {**original(), "api_key": ""}
        try:
            for role, account in (("provider", "center"), ("regulator", "admin")):
                status, result = self.request("/api/care", self.login(role, account))
                self.assertEqual(status, 200)
                self.assertEqual(result["source"], "规则信号")
                self.assertGreaterEqual(result["counts"]["high"], 1)
        finally:
            server.load_config = original

    def test_place_risk_unknown_and_synthetic(self):
        token = self.login("provider", "center")
        resident_id = server.DATABASE.read_state()["profile"]["id"]
        base = {"residentId": resident_id}
        status, result = self.request("/api/route-risk", token, {**base, "destination": "陌生街巷"})
        self.assertEqual(status, 200)
        self.assertEqual(result["assessment"]["level"], "unknown")
        status, result = self.request("/api/route-risk", token, {**base, "destination": "巴马山地康养路线（模拟）"})
        self.assertEqual(status, 200)
        self.assertFalse(result["assessment"]["verified"])
        self.assertIn("合成案例", result["assessment"]["source"])

    def test_daily_check_concern_notifies_provider_only(self):
        token = self.login("elder", "elder")
        _, data = self.request("/api/state", token)
        state = data["data"]
        entry = {"date": "2099-01-02", "sleep": "较差", "appetite": "一般", "mood": "平稳", "mobility": "正常", "note": "膝盖疼" * 60, "status": "已完成"}
        for attempt in range(2):  # 同一天提交两次
            state["dailyChecks"] = [entry, *state["dailyChecks"]]
            status, _ = self.request("/api/state", token, {"state": state, "audit": {"entity_type": "daily_check", "entity_id": entry["date"]}})
            self.assertEqual(status, 200)
        _, after = self.request("/api/state", token)
        self.assertEqual([c["date"] for c in after["data"]["dailyChecks"]].count("2099-01-02"), 1)
        self.assertLessEqual(len(after["data"]["dailyChecks"][0]["note"]), 120)
        self.assertFalse([n for n in after["data"]["notifications"] if str(n.get("id", "")).startswith("DC-")])  # 老人自己看不到给机构的提醒
        _, provider = self.request("/api/state", self.login("provider", "center"))
        notices = [n for n in provider["data"]["notifications"] if n.get("id") == f"DC-{state['profile']['id']}-2099-01-02"]
        self.assertEqual(len(notices), 1)
        self.assertIn("睡眠较差", notices[0]["detail"])
        _, regulator = self.request("/api/state", self.login("regulator", "admin"))
        self.assertFalse([n for n in regulator["data"]["notifications"] if n.get("audience") == "provider"])

    def test_elder_screening_cannot_self_approve_or_hide_high(self):
        token = self.login("elder", "elder")
        _, data = self.request("/api/state", token)
        state = data["data"]
        own = state["profile"]["id"]
        original = state["residents"][0]
        screen = dict(original["screening"])
        levels = [dict(item) for item in screen["dimensions"]]
        levels[0]["level"] = "high"
        levels[1]["level"] = "unknown"
        screen.update({"overall": "low", "reviewStatus": "已确认", "reviewRequired": False, "dimensions": levels})
        state["residents"][0] = {**original, "screening": screen, "risk": "low"}
        state["profile"]["risk"] = "low"
        status, _ = self.request("/api/state", token, {"state": state, "audit": {"entity_type": "resident_screening", "entity_id": own, "actor_role": "regulator"}})
        self.assertEqual(status, 200)
        _, after = self.request("/api/state", token)
        self.assertEqual(after["data"]["profile"]["risk"], "high")
        self.assertEqual(after["data"]["profile"]["screening"]["reviewStatus"], "缺项待补")
        self.assertEqual(after["data"]["profile"]["screening"]["dataCompleteness"], 0.8)

    def test_seed_upgrade_keeps_a_backup_of_the_old_database(self):
        with tempfile.TemporaryDirectory() as folder:
            db = BusinessDatabase(Path(folder) / "old.sqlite")
            db.initialize()
            with closing(db.connect()) as connection:
                connection.execute("UPDATE app_snapshot SET version = 1 WHERE id = 1")
                connection.commit()
            db.initialize()  # 种子版本更高：重置为新样本，并先备份旧库
            backups = list((Path(folder) / "backups").glob("old_before_v*.sqlite"))
            self.assertEqual(len(backups), 1)
            with closing(sqlite3.connect(backups[0])) as copy:
                self.assertEqual(copy.execute("SELECT version FROM app_snapshot WHERE id = 1").fetchone()[0], 1)

    def test_existing_database_additive_migration(self):
        with tempfile.TemporaryDirectory() as folder:
            target = Path(folder) / "old.sqlite"
            with closing(sqlite3.connect(target)) as connection, connection:  # Windows 删除临时文件前必须先关闭连接
                connection.executescript((ROOT / "database_schema.sql").read_text(encoding="utf-8"))
                connection.execute("DROP INDEX idx_sos_updated")
                connection.execute("ALTER TABLE sos_sessions DROP COLUMN updated_at_ms")
                connection.execute("ALTER TABLE movement_records DROP COLUMN expected_return_at")
            old = BusinessDatabase(target)
            old.initialize()
            old.initialize()
            with closing(old.connect()) as connection:
                self.assertIn("updated_at_ms", [row["name"] for row in connection.execute("PRAGMA table_info(sos_sessions)")])
                self.assertIn("expected_return_at", [row["name"] for row in connection.execute("PRAGMA table_info(movement_records)")])

    def test_provider_movement_visible_and_sos_claim_time_server_owned(self):
        provider = self.login("provider", "center")
        elder = self.login("elder", "elder")
        regulator = self.login("regulator", "admin")
        _, snapshot = self.request("/api/state", provider)
        data = snapshot["data"]
        revision = snapshot["revision"]
        resident_id = data["profile"]["id"]
        trip = {**data["movementLogs"][0], "id": "MV-test-cross-role", "residentId": resident_id, "resident": data["profile"]["name"], "status": "外出中", "regulatorStatus": "待确认", "destination": "巴马山地康养路线（模拟）", "routeAssessment": {"level": "high", "verified": False, "source": "合成案例"}, "eventId": ""}
        data["movementLogs"].insert(0, trip)
        status, result = self.request("/api/state", provider, {"state": data, "audit": {"entity_type": "movement", "entity_id": trip["id"], "actor_role": "regulator"}})
        self.assertEqual(status, 200)
        self.assertGreater(result["revision"], revision)
        for token in (elder, regulator):
            _, result = self.request(f"/api/state?since={revision}", token)
            self.assertTrue(result["changed"])
            self.assertTrue(any(item["id"] == trip["id"] for item in result["data"]["movementLogs"]))
        session = {"id": "SOS-test-server-owned", "residentId": resident_id, "status": "waiting", "riskLevel": "high", "createdAt": 1, "responseSeconds": -999}
        status, result = self.request("/api/sos", elder, {"session": session})
        self.assertEqual(status, 200)
        created = next(item for item in result["sessions"] if item["id"] == session["id"])
        self.assertGreater(created["createdAt"], 1)
        status, result = self.request("/api/sos", provider, {"session": {**created, "status": "claimed", "claimedBy": "伪造人员", "responseSeconds": -999}})
        self.assertEqual(status, 200)
        claimed = next(item for item in result["sessions"] if item["id"] == session["id"])
        self.assertEqual(claimed["claimedBy"], "周敏")
        self.assertGreaterEqual(claimed["responseSeconds"], 0)
        self.assertEqual(self.request("/api/sos", elder, {"session": {**claimed, "status": "resolved_safe"}})[0], 403)
        # 接单后老人仍可报平安取消（与界面一致），接单人和响应用时保持服务器记录
        status, result = self.request("/api/sos", elder, {"session": {**claimed, "status": "cancelled", "claimedBy": "伪造人员"}})
        self.assertEqual(status, 200)
        cancelled = next(item for item in result["sessions"] if item["id"] == session["id"])
        self.assertEqual((cancelled["status"], cancelled["claimedBy"]), ("cancelled", "周敏"))
        self.assertEqual(self.request("/api/sos", elder, {"session": {**cancelled, "status": "waiting"}})[0], 403)

    def test_model_json_validation_and_urgent_routing(self):
        for raw in ("not json", "{}", '{"summary":"只有摘要"}'):
            with self.assertRaises(ValueError):
                server.normalize_result(raw)
        self.assertEqual(server.urgent_guardrail("我胸口疼")["phone"], "120")
        self.assertEqual(server.urgent_guardrail("我被跟踪")["phone"], "110")
        self.assertEqual(server.urgent_guardrail("我找不到机构路了")["phone"], "110")


if __name__ == "__main__":
    unittest.main()
