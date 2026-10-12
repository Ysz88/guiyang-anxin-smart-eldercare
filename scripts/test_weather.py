"""Simulated weather targeting and timeout regression."""
import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import weather  # noqa: E402
import advisor  # noqa: E402
import care  # noqa: E402
import insight  # noqa: E402


class WeatherTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.seed = json.loads((ROOT / "seed.json").read_text(encoding="utf-8"))

    def test_targets_institution_home_and_trip(self):
        north = weather.affected_residents(self.seed, ["北海"])
        ids = {item["residentId"] for item in north}
        self.assertIn("GX-LJ-2026-000318", ids)  # 北海机构且正在外出
        self.assertIn("GX-LJ-2026-000352", ids)  # 北海居家地址
        self.assertNotIn("GX-LJ-2026-000405", ids)  # 防城港机构
        self.assertEqual(north[0]["priority"], 3)
        south = weather.affected_residents(self.seed, ["防城港"])
        self.assertEqual([item["residentId"] for item in south], ["GX-LJ-2026-000405"])
        trip = json.loads(json.dumps(self.seed, ensure_ascii=False))
        trip["movementLogs"].append({"residentId": "GX-LJ-2026-000405", "status": "待出发", "destination": "北海银滩"})
        self.assertIn("GX-LJ-2026-000405", {item["residentId"] for item in weather.affected_residents(trip, ["北海"])})

    def test_publish_and_timeout_once(self):
        state = json.loads(json.dumps(self.seed, ensure_ascii=False))
        alert, checkins = weather.create_alert(state, {"type": "台风", "level": "蓝色", "cities": ["北海"], "deadlineMinutes": 2}, "监管员", now_ms=100_000)
        self.assertEqual(alert["source"], "模拟预警（演示）")
        self.assertEqual(len(checkins), len(alert["affectedResidentIds"]))
        state["weatherAlerts"] = [alert]
        state["safetyCheckins"] = checkins
        self.assertEqual(weather.advance_overdue(state, 219_999), 0)
        self.assertEqual(weather.advance_overdue(state, 220_000), len(checkins))
        self.assertEqual(weather.advance_overdue(state, 230_000), 0)
        checkins[0]["status"] = "safe"
        self.assertEqual(weather.checkin_summary(state)["responded"], 1)

    def test_overdue_flows_into_care_advisor_and_insight(self):
        state = json.loads(json.dumps(self.seed, ensure_ascii=False))
        alert, checkins = weather.create_alert(state, {"type": "高温", "level": "黄色", "cities": ["北海"], "deadlineMinutes": 2}, "监管员", now_ms=100_000)
        state["weatherAlerts"] = [alert]
        state["safetyCheckins"] = checkins
        weather.advance_overdue(state, 220_000)
        target = checkins[0]
        dossier = next(item for item in care.build_dossiers(state) if item["id"] == target["residentId"])
        self.assertTrue(any(signal["kind"] == "天气预警" and target["id"] in signal["evidence"] for signal in dossier["signals"]))
        query = advisor.tool_query_weather(state, {})
        self.assertEqual(query["报平安"]["overdue"], len(checkins))
        self.assertEqual(insight.analyze(state)["weather"]["rate"], 0)


if __name__ == "__main__":
    unittest.main()
