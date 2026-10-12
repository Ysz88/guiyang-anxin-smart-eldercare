"""16.0 评阅整改回归：跨机构写入、接单达标率分母、事件时限、后台值守、打卡校验、类案人工纠错。

全部使用临时数据库和本机临时接口，不读写演示数据库，不调用大模型。
运行：python scripts/test_review_fixes.py
"""
import copy
import json
import os
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from contextlib import closing
from datetime import date
from http.server import ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import database  # noqa: E402
import insight  # noqa: E402
import server  # noqa: E402
import sla  # noqa: E402
import watchdog  # noqa: E402
from database import BusinessDatabase  # noqa: E402

server.AppHandler.log_message = lambda *args, **kwargs: None  # 测试时不打印每条请求

OTHER_ORG_RESIDENT = "GX-LJ-2026-000405"  # 蒙秀英，防城港滨海颐养社区
OWN_RESIDENT = "GX-LJ-2026-000251"        # 赵秀兰，北海银龄康养中心（演示机构账号所属机构）
OTHER_ORG_EVENT = "EV-20260809-131"       # 蒙秀英的消费纠纷


class ApiCase(unittest.TestCase):
    """每个测试用一个全新的临时数据库，测试之间互不影响。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.original = server.DATABASE
        server.DATABASE = BusinessDatabase(Path(self.tmp.name) / "review.sqlite")
        server.DATABASE.initialize()
        self.http = ThreadingHTTPServer(("127.0.0.1", 0), server.AppHandler)
        self.thread = threading.Thread(target=self.http.serve_forever, daemon=True)
        self.thread.start()
        self.base = f"http://127.0.0.1:{self.http.server_port}"
        self.passwords = json.loads((Path(self.tmp.name) / "demo_credentials.json").read_text())
        self.config = server.load_config
        server.load_config = lambda: {**self.config(), "api_key": ""}  # 不调用真实模型

    def tearDown(self):
        server.load_config = self.config
        self.http.shutdown()
        self.http.server_close()
        self.thread.join(timeout=2)
        server.DATABASE = self.original
        self.tmp.cleanup()

    def request(self, path, token="", payload=None):
        data = json.dumps(payload, ensure_ascii=False).encode() if payload is not None else None
        request = urllib.request.Request(self.base + path, data=data, headers={"Authorization": f"Bearer {token}"} if token else {}, method="POST" if payload is not None else "GET")
        try:
            with urllib.request.urlopen(request, timeout=6) as result:
                return result.status, json.loads(result.read())
        except urllib.error.HTTPError as error:
            body = error.read()
            try:
                return error.code, json.loads(body)
            except ValueError:
                return error.code, {}

    def login(self, role):
        account = {"elder": "elder", "provider": "center", "regulator": "admin"}[role]
        status, result = self.request("/api/login", payload={"role": role, "account": account, "password": self.passwords[role]})
        self.assertEqual(status, 200)
        return result["token"]

    def snapshot(self):
        return server.DATABASE.read_state()

    def write(self, token, state, entity_type, entity_id, action="测试写入"):
        return self.request("/api/state", token, {"state": state, "audit": {"entity_type": entity_type, "entity_id": entity_id, "action": action}})


class CrossInstitutionWrites(ApiCase):
    """P0：机构 A 读不到机构 B 的记录，也不能写；服务端按数据库原记录核对归属。"""

    def test_provider_cannot_modify_other_institution_resident(self):
        provider = self.login("provider")
        _, view = self.request("/api/state", provider)
        self.assertNotIn(OTHER_ORG_RESIDENT, [r["id"] for r in view["data"]["residents"]])  # 读取已被过滤
        before = next(r for r in self.snapshot()["residents"] if r["id"] == OTHER_ORG_RESIDENT)
        forged = view["data"]
        forged["residents"] = [{**before, "name": "被篡改", "risk": "low", "room": "伪造房间"}, *forged["residents"]]
        status, body = self.write(provider, forged, "resident", OTHER_ORG_RESIDENT)
        self.assertEqual(status, 403)
        self.assertEqual(body.get("error"), "institution_scope_forbidden")
        after = next(r for r in self.snapshot()["residents"] if r["id"] == OTHER_ORG_RESIDENT)
        self.assertEqual(after, before)  # 数据库不变

    def test_provider_cannot_move_record_into_own_institution(self):
        provider = self.login("provider")
        data = self.request("/api/state", provider)[1]["data"]
        # 把别家老人的档案“改成”本机构，借此取得写权限
        other = next(r for r in self.snapshot()["residents"] if r["id"] == OTHER_ORG_RESIDENT)
        data["residents"] = [{**other, "institution": "北海银龄康养中心"}, *data["residents"]]
        self.assertEqual(self.write(provider, data, "resident", OTHER_ORG_RESIDENT)[0], 403)
        # 本机构老人的档案也不能改到别的机构
        data = self.request("/api/state", provider)[1]["data"]
        mine = next(r for r in data["residents"] if r["id"] == OWN_RESIDENT)
        mine["institution"] = "防城港滨海颐养社区"
        status, body = self.write(provider, data, "resident", OWN_RESIDENT)
        self.assertEqual((status, body.get("error")), (403, "institution_immutable"))
        self.assertEqual(next(r for r in self.snapshot()["residents"] if r["id"] == OWN_RESIDENT)["institution"], "北海银龄康养中心")

    def test_provider_cannot_add_or_retarget_records_for_other_institution(self):
        provider = self.login("provider")
        data = self.request("/api/state", provider)[1]["data"]
        service = {"id": "SV-cross", "residentId": OTHER_ORG_RESIDENT, "resident": "蒙秀英", "type": "夜间巡查", "staff": "x", "time": "今日", "result": "伪造", "status": "已记录"}
        data["serviceLogs"].insert(0, service)
        self.assertEqual(self.write(provider, data, "service", "SV-cross")[0], 403)
        data = self.request("/api/state", provider)[1]["data"]
        trip = {**data["movementLogs"][0], "id": "MV-cross", "residentId": OTHER_ORG_RESIDENT, "resident": "蒙秀英", "eventId": ""}
        data["movementLogs"].insert(0, trip)
        self.assertEqual(self.write(provider, data, "movement", "MV-cross")[0], 403)
        data = self.request("/api/state", provider)[1]["data"]
        event = {"id": "EV-cross", "residentId": OTHER_ORG_RESIDENT, "resident": "蒙秀英", "category": "服务投诉", "title": "伪造", "status": "待复核", "level": "low", "deadline": "2小时内反馈", "timeline": []}
        data["events"].insert(0, event)
        self.assertEqual(self.write(provider, data, "risk_event", "EV-cross")[0], 403)
        # 改写自己记录的 residentId，把记录“挂”到别家老人名下
        data = self.request("/api/state", provider)[1]["data"]
        own_service = next(s for s in data["serviceLogs"] if s["residentId"] == OWN_RESIDENT)
        own_service["residentId"] = OTHER_ORG_RESIDENT
        status, body = self.write(provider, data, "service", own_service["id"])
        self.assertEqual((status, body.get("error")), (403, "resident_immutable"))
        state = self.snapshot()
        self.assertFalse({"SV-cross", "MV-cross", "EV-cross"} & {x["id"] for key in ("serviceLogs", "movementLogs", "events") for x in state[key]})

    def test_provider_cannot_handle_other_institution_event(self):
        provider = self.login("provider")
        data = self.request("/api/state", provider)[1]["data"]
        other = copy.deepcopy(next(e for e in self.snapshot()["events"] if e["id"] == OTHER_ORG_EVENT))
        other["status"] = "已办结"
        other["timeline"].append({"time": "刚刚", "text": "机构越权办结", "state": "done"})
        data["events"].insert(0, other)
        self.assertEqual(self.write(provider, data, "risk_event", OTHER_ORG_EVENT)[0], 403)
        self.assertNotEqual(next(e for e in self.snapshot()["events"] if e["id"] == OTHER_ORG_EVENT)["status"], "已办结")

    def test_same_institution_writes_still_work(self):
        provider = self.login("provider")
        data = self.request("/api/state", provider)[1]["data"]
        data["serviceLogs"].insert(0, {"id": "SV-own", "residentId": OWN_RESIDENT, "resident": "赵秀兰", "type": "夜间巡查", "staff": "护理员", "time": "今日 21:00", "result": "正常", "status": "已记录"})
        self.assertEqual(self.write(provider, data, "service", "SV-own")[0], 200)
        data = self.request("/api/state", provider)[1]["data"]
        data["residents"].insert(0, {"id": "GX-LJ-NEW-1", "name": "新入住", "age": 70, "source": "湖北武汉", "room": "101", "checkIn": "今日", "risk": "low", "fresh": "刚刚", "status": "在住"})
        self.assertEqual(self.write(provider, data, "resident", "GX-LJ-NEW-1")[0], 200)
        created = next(r for r in self.snapshot()["residents"] if r["id"] == "GX-LJ-NEW-1")
        self.assertEqual((created["institution"], created["scene"]), ("北海银龄康养中心", "机构入住"))  # 新档案归属登录机构

    def test_provider_sos_and_route_risk_scoped(self):
        provider = self.login("provider")
        self.assertEqual(self.request("/api/route-risk", provider, {"residentId": OTHER_ORG_RESIDENT, "destination": "东兴口岸"})[0], 403)
        self.assertEqual(self.request("/api/route-risk", provider, {"residentId": OWN_RESIDENT, "destination": "北海银滩"})[0], 200)
        elder = self.login("elder")
        own_id = self.snapshot()["profile"]["id"]
        status, result = self.request("/api/sos", elder, {"session": {"id": "SOS-scope", "residentId": own_id, "status": "waiting", "riskLevel": "high", "timeline": []}})
        self.assertEqual(status, 200)
        # 机构端看到的呼救只有本机构老人的
        _, ledger = self.request("/api/sos", provider)
        residents = {r["id"]: r for r in self.snapshot()["residents"]}
        self.assertTrue(all(residents[s["residentId"]]["institution"] == "北海银龄康养中心" for s in ledger["sessions"] if s["residentId"] in residents))


class SosResponseRate(unittest.TestCase):
    """P0：接单达标率的分母要包含已经超时却无人接单的工单。"""

    def test_survivor_bias_example_from_review(self):
        now = 1_800_000_000_000
        tickets = [
            {"id": "A", "status": "claimed", "createdAt": now - 60_000, "responseSeconds": 10, "institution": "北海银龄康养中心", "escalation": 1},
            {"id": "B", "status": "waiting", "createdAt": now - 90_000, "responseSeconds": None, "institution": "北海银龄康养中心", "escalation": 3},
            {"id": "C", "status": "waiting", "createdAt": now - 45_000, "responseSeconds": None, "institution": "北海银龄康养中心", "escalation": 2},
        ]
        summary = sla.sos_summary(tickets, now)
        self.assertEqual((summary["on_time"], summary["missed"], summary["assessed"]), (1, 2, 3))
        self.assertEqual(summary["overall_rate"], 33)       # 整体 1/3，不是 100%
        self.assertEqual(summary["responded_rate"], 100)    # “已接单中的按时比例”单列
        seed = json.loads((ROOT / "seed.json").read_text(encoding="utf-8"))
        seed["sosSessions"] = tickets
        row = next(q for q in insight.quality(seed, now) if q["name"] == "北海银龄康养中心")
        self.assertEqual(row["metrics"]["整体响应达标率"], "1/3（33%）")
        self.assertEqual(row["metrics"]["已接单按时率"], "1/1（100%）")
        self.assertEqual(row["metrics"]["超时未接单"], "2单")
        result = insight.analyze(seed, now)
        self.assertEqual(result["sos"]["sla_rate"], 33)
        self.assertTrue(any("仍无人接单" in f["text"] for f in result["findings"]))

    def test_pending_and_mistouch_are_not_in_denominator(self):
        now = 1_800_000_000_000
        tickets = [
            {"id": "P", "status": "waiting", "createdAt": now - 10_000},  # 仍在 30 秒内
            {"id": "X", "status": "cancelled", "createdAt": now - 100_000, "closedAtMs": now - 95_000},  # 5 秒内本人取消
            {"id": "L", "status": "cancelled", "createdAt": now - 200_000, "closedAtMs": now - 100_000},  # 超时无人接单后才取消
            {"id": "S", "status": "resolved_handled", "createdAt": now - 300_000, "responseSeconds": 42},
        ]
        summary = sla.sos_summary(tickets, now)
        self.assertEqual((summary["pending"], summary["excluded"], summary["missed"], summary["late"], summary["assessed"]), (1, 1, 1, 1, 2))
        self.assertEqual(summary["overall_rate"], 0)


class EventDeadlines(ApiCase):
    """P0：时限由服务器按创建、截止、办结时间计算；更新备注不重置截止时间；提前与超时办结显示不同。"""

    def new_event(self, token, event_id, deadline="2小时内反馈"):
        data = self.request("/api/state", token)[1]["data"]
        own_id = data["profile"]["id"]
        event = {"id": event_id, "residentId": own_id, "resident": data["profile"]["name"], "category": "服务投诉", "title": "测试时限", "status": "待复核",
                 "level": "medium", "deadline": deadline, "createdAt": 1, "dueAt": 2, "closedAt": 3, "time": "刚刚", "timeline": [{"time": "刚刚", "text": "老人提交", "state": "current"}]}
        data["events"].insert(0, event)
        status, _ = self.write(token, data, "risk_event", event_id)
        self.assertEqual(status, 200)
        return next(e for e in self.snapshot()["events"] if e["id"] == event_id)

    def update(self, token, event_id, status, note, **extra):
        data = self.request("/api/state", token)[1]["data"]
        event = next(e for e in data["events"] if e["id"] == event_id)
        event.update({"status": status, "deadline": "已按时完成", "dueAt": 9, "createdAt": 9, **extra})
        if note:
            event["timeline"].append({"time": "刚刚", "text": note, "state": "current"})
        return self.write(token, data, "risk_event", event_id)

    def test_server_owns_created_and_due_times(self):
        before = sla.now_ms()
        created = self.new_event(self.login("elder"), "EV-DUE-1")
        self.assertGreaterEqual(created["createdAt"], before)       # 页面传来的 createdAt=1 被忽略
        self.assertEqual(created["dueAt"] - created["createdAt"], 2 * 60 * 60_000)
        self.assertNotIn("closedAt", created)
        self.assertNotEqual(created["timeline"][0]["time"], "刚刚")  # 服务器时间替换“刚刚”
        provider = self.login("provider")
        self.assertEqual(self.update(provider, "EV-DUE-1", "处置中", "已电话联系老人")[0], 200)
        after = next(e for e in self.snapshot()["events"] if e["id"] == "EV-DUE-1")
        self.assertEqual((after["createdAt"], after["dueAt"], after["deadline"]), (created["createdAt"], created["dueAt"], "2小时内反馈"))  # 更新备注不重置

    def test_close_requires_note_and_on_time_vs_late_differ(self):
        self.new_event(self.login("elder"), "EV-DUE-2")
        provider = self.login("provider")
        status, body = self.update(provider, "EV-DUE-2", "已办结", "")
        self.assertEqual(status, 400)  # 办结必须写处置说明
        status, _ = self.update(provider, "EV-DUE-2", "已办结", "已到现场处置并回访", followUp={"result": "已回访，老人认可"})
        self.assertEqual(status, 200)
        on_time = next(e for e in self.snapshot()["events"] if e["id"] == "EV-DUE-2")
        self.assertTrue(on_time["closedOnTime"])
        self.assertEqual(sla.status(on_time)["text"], "按时办结")
        self.assertEqual(on_time["followUp"]["result"], "已回访，老人认可")
        # 另一件事件：把截止时间放到过去，再办结 → 超时办结
        self.new_event(self.login("elder"), "EV-DUE-3")
        state = self.snapshot()
        target = next(e for e in state["events"] if e["id"] == "EV-DUE-3")
        target["dueAt"] = target["createdAt"] - 3 * 60 * 60_000
        server.DATABASE.replace_state(state, {"action": "测试：截止时间已过"})
        self.assertEqual(sla.status(target)["state"], "open_overdue")
        self.assertEqual(self.update(provider, "EV-DUE-3", "已办结", "处置完成，已回访老人", followUp={"result": "无需回访"})[0], 200)
        late = next(e for e in self.snapshot()["events"] if e["id"] == "EV-DUE-3")
        self.assertFalse(late["closedOnTime"])
        self.assertTrue(sla.status(late)["text"].startswith("超时办结"))

    def test_reopen_needs_reason_and_unaccepted_follow_up_blocks_close(self):
        self.new_event(self.login("elder"), "EV-DUE-4")
        provider = self.login("provider")
        status, _ = self.update(provider, "EV-DUE-4", "已办结", "已处置", followUp={"result": "已回访，老人不认可"})
        self.assertEqual(status, 400)  # 老人不认可时不能办结
        self.assertEqual(self.update(provider, "EV-DUE-4", "已办结", "已处置完毕", followUp={"result": "已回访，老人认可"})[0], 200)
        self.assertEqual(self.update(provider, "EV-DUE-4", "处置中", "")[0], 400)  # 重新打开要写原因
        self.assertEqual(self.update(provider, "EV-DUE-4", "处置中", "老人反映问题仍在，重新处理")[0], 200)
        reopened = next(e for e in self.snapshot()["events"] if e["id"] == "EV-DUE-4")
        self.assertEqual((reopened["status"], reopened["reopenCount"]), ("处置中", 1))
        self.assertNotIn("closedAt", reopened)
        self.assertTrue(any("重新打开" in t["text"] for t in reopened["timeline"]))

    def test_timeline_is_append_only(self):
        self.new_event(self.login("elder"), "EV-DUE-5")
        provider = self.login("provider")
        data = self.request("/api/state", provider)[1]["data"]
        event = next(e for e in data["events"] if e["id"] == "EV-DUE-5")
        event["timeline"] = [{"time": "刚刚", "text": "篡改后的唯一一条", "state": "done"}]  # 删除原有记录
        self.assertEqual(self.write(provider, data, "risk_event", "EV-DUE-5")[0], 200)
        stored = next(e for e in self.snapshot()["events"] if e["id"] == "EV-DUE-5")["timeline"]
        self.assertEqual([t["text"] for t in stored], ["老人提交", "篡改后的唯一一条"])  # 原记录保留，只追加

    def test_returned_movement_moves_linked_event_to_review(self):
        provider = self.login("provider")
        data = self.request("/api/state", provider)[1]["data"]
        trip = next(m for m in data["movementLogs"] if m["id"] == "MV-0810-019")
        trip["status"] = "已返回"
        trip["timeline"].append({"time": "刚刚", "text": "护理员确认返回：已当面确认老人安全", "state": "done"})
        self.assertEqual(self.write(provider, data, "movement", "MV-0810-019")[0], 200)
        event = next(e for e in self.snapshot()["events"] if e["id"] == "EV-20260810-015")
        self.assertEqual(event["status"], "待复核")
        self.assertIn("等待监管复核", event["timeline"][-1]["text"])


class DailyCheckValidation(ApiCase):
    def test_check_values_must_be_explicit_choices(self):
        elder = self.login("elder")
        data = self.request("/api/state", elder)[1]["data"]
        bad = {"date": "2099-02-01", "sleep": "", "appetite": "良好", "mood": "愉快", "mobility": "正常"}
        data["dailyChecks"] = [bad, *data["dailyChecks"]]
        self.assertEqual(self.write(elder, data, "daily_check", bad["date"])[0], 400)
        good = {**bad, "sleep": "良好", "status": "伪造状态", "extra": "drop"}
        data["dailyChecks"][0] = good
        self.assertEqual(self.write(elder, data, "daily_check", good["date"])[0], 200)
        stored = self.snapshot()["dailyChecks"][0]
        self.assertEqual(stored["status"], "已完成")
        self.assertNotIn("extra", stored)


class SeedAnchoring(unittest.TestCase):
    def test_seed_dates_follow_today(self):
        seed = database.load_seed(date(2026, 10, 24))
        self.assertEqual(seed["dailyChecks"][0]["date"], "2026-10-23")  # 最近一次打卡是昨天，演示当天可以现场打卡
        event = next(e for e in seed["events"] if e["id"] == "EV-20260810-017")
        self.assertEqual(sla.label(event["createdAt"]), "10-24 08:12")
        self.assertGreater(event["dueAt"], event["createdAt"])
        closed = next(e for e in seed["events"] if e["id"] == "EV-20260809-082")
        self.assertEqual(sla.status(closed)["state"], "closed_on_time")
        old = next(e for e in seed["events"] if e["id"] == "EV-20260808-061")
        self.assertEqual(old["time"], "10-22 18:20")
        self.assertTrue(all(isinstance(e["createdAt"], int) for e in seed["events"]))

    def test_full_date_with_time_is_shifted_once(self):
        seed = {"anchorDate": "2026-08-10",
                "events": [{"id": "E1", "time": "2026-08-10 09:24", "timeline": [{"time": "08-10 09:30"}]}],
                "movementLogs": [{"id": "M1", "departAt": "08-10 08:00", "expectedReturnAt": "2026-08-10T17:30"}]}
        moved = database.anchor_seed(seed, date(2026, 10, 24))
        self.assertEqual(moved["events"][0]["time"], "2026-10-24 09:24")
        self.assertEqual(moved["events"][0]["timeline"][0]["time"], "10-24 09:30")
        self.assertEqual(moved["movementLogs"][0]["departAt"], "10-24 08:00")
        self.assertEqual(moved["movementLogs"][0]["expectedReturnAt"], "2026-10-24T17:30")

    def test_sun_heping_timeline_is_consistent(self):
        seed = json.loads((ROOT / "seed.json").read_text(encoding="utf-8"))
        patrol = next(s for s in seed["serviceLogs"] if s["id"] == "SV-0809-104")
        self.assertNotIn("已休息", patrol["result"])
        scam = next(e for e in seed["events"] if e["id"] == "EV-20260809-126")
        self.assertLess(scam["createdAt"], "2026-08-09T18:30")  # 涉诈来电发生在离院之前，地点才可能是机构


class WatchdogScans(unittest.TestCase):
    """P0：超时升级在服务端推进，不依赖任何浏览器页面。"""

    def setUp(self):
        self.seed = database.load_seed()
        self.now = sla.now_ms()

    def sos(self, seconds_ago, **extra):
        return {"id": f"SOS-T{seconds_ago}", "residentId": "GX-LJ-2026-000318", "resident": "李桂芳", "institution": "北海银龄康养中心", "trigger": "一键呼救",
                "status": "waiting", "escalation": 1, "riskLevel": "high", "createdAt": self.now - seconds_ago * 1000, "notified": {},
                "callback": {"status": "dialing", "attempts": 1, "startedAt": self.now - seconds_ago * 1000}, "contacts": [{"role": "紧急联系人", "name": "李明辉"}],
                "timeline": [], "linkedEventId": "", **extra}

    def test_escalation_levels_and_idempotency(self):
        state = copy.deepcopy(self.seed)
        state["sosSessions"] = [self.sos(31), self.sos(80), self.sos(5, status="claimed", responseSeconds=4)]
        events_before = len(state["events"])
        result = watchdog.tick(state, self.now)
        l2, l3, claimed = state["sosSessions"]
        self.assertEqual((l2["escalation"], l3["escalation"], claimed["escalation"]), (2, 3, 1))
        self.assertTrue(l2["notified"]["manager"] and l2["notified"]["family"])
        self.assertTrue(l3["notified"]["regulator"] and l3["linkedEventId"])
        self.assertEqual(len(state["events"]), events_before + 1)
        linked = state["events"][0]
        self.assertEqual((linked["id"], linked["status"], linked["source"]), (l3["linkedEventId"], "处置中", "应急呼救升级"))
        self.assertTrue(any("后台值守" in t["text"] for t in l2["timeline"]))
        self.assertTrue(result["audits"] and all(a["actor_name"] == "后台值守" for a in result["audits"]))
        again = watchdog.tick(state, self.now)  # 同一时刻再扫一次：不重复升级、不重复生成事件
        self.assertFalse(again["state_changed"])
        self.assertEqual(len(state["events"]), events_before + 1)
        self.assertEqual(len([t for t in l3["timeline"] if "监管端" in t["text"]]), 1)

    def test_existing_linked_event_is_reused(self):
        state = copy.deepcopy(self.seed)
        state["sosSessions"] = [self.sos(90, linkedEventId="EV-20260810-011")]
        before = len(state["events"])
        watchdog.tick(state, self.now)
        self.assertEqual(len(state["events"]), before)
        self.assertEqual(state["sosSessions"][0]["linkedEventId"], "EV-20260810-011")

    def test_callback_simulation_advances(self):
        state = copy.deepcopy(self.seed)
        state["sosSessions"] = [self.sos(4)]
        watchdog.tick(state, self.now)
        self.assertEqual(state["sosSessions"][0]["callback"]["status"], "ringing")
        watchdog.tick(state, self.now + 22_000)
        self.assertEqual(state["sosSessions"][0]["callback"]["attempts"], 2)

    def test_movement_overdue_creates_one_event(self):
        state = copy.deepcopy(self.seed)
        due = time.strftime("%Y-%m-%dT%H:%M", time.localtime((self.now - 5 * 60_000) / 1000))
        state["movementLogs"].insert(0, {"id": "MV-T1", "residentId": "GX-LJ-2026-000251", "resident": "赵秀兰", "status": "外出中", "risk": "low",
                                         "destination": "北海银滩", "expectedReturn": "测试", "expectedReturnAt": due, "eventId": "", "timeline": []})
        state["sosSessions"] = []
        result = watchdog.tick(state, self.now)
        trip = state["movementLogs"][0]
        self.assertTrue(result["state_changed"])
        self.assertEqual(trip["status"], "超时未归")
        event = next(e for e in state["events"] if e["id"] == trip["eventId"])
        self.assertEqual((event["category"], event["movementId"]), ("失联风险", "MV-T1"))
        self.assertFalse(watchdog.tick(state, self.now + 60_000)["state_changed"])  # 不重复生成

    def test_weather_checkin_overdue_moved_off_read_path(self):
        state = copy.deepcopy(self.seed)
        state["sosSessions"] = []
        state["weatherAlerts"] = [{"id": "WA-T", "status": "生效中"}]
        state["safetyCheckins"] = [{"id": "CK-T", "alertId": "WA-T", "residentId": "GX-LJ-2026-000318", "status": "pending", "deadlineAt": self.now - 1000, "escalatedAt": ""}]
        self.assertTrue(watchdog.tick(state, self.now)["state_changed"])
        self.assertTrue(state["safetyCheckins"][0]["escalatedAt"])


class WatchdogWithoutBrowser(ApiCase):
    """验收：关闭所有页面，只保留后台服务，逾期工单仍按配置升级并留下审计；服务重启后补扫遗漏任务。"""

    def test_background_thread_escalates_with_no_page_open(self):
        db = server.DATABASE
        now = sla.now_ms()
        session = {"id": "SOS-NOPAGE", "residentId": "GX-LJ-2026-000318", "resident": "李桂芳", "institution": "北海银龄康养中心", "trigger": "一键呼救",
                   "status": "waiting", "escalation": 1, "riskLevel": "high", "createdAt": now - 80_000, "updatedAtMs": now - 80_000,
                   "callback": {"status": "dialing", "attempts": 1, "startedAt": now - 80_000}, "notified": {}, "timeline": [], "contacts": []}
        db.upsert_sos_session(session, {"action": "测试：页面已关闭"})
        guard = watchdog.Watchdog(lambda: db, interval=0.1).start()  # 相当于服务重启后启动的值守线程
        try:
            deadline = time.time() + 5
            while time.time() < deadline:
                stored = next(s for s in db.sos_snapshot()["sessions"] if s["id"] == "SOS-NOPAGE")
                if stored["escalation"] >= 3:
                    break
                time.sleep(0.1)
        finally:
            guard.stop()
        self.assertEqual(stored["escalation"], 3)
        self.assertTrue(any(e["id"] == stored["linkedEventId"] for e in db.read_state()["events"]))
        logs = db.audit_logs(20)
        self.assertTrue(any(log["actor_name"] == "后台值守" and log["entity_id"] == "SOS-NOPAGE" for log in logs))
        # 再跑一次：不会重复生成联动事件
        linked = [e for e in db.read_state()["events"] if e.get("sosId") == "SOS-NOPAGE"]
        watchdog.run_once(db)
        self.assertEqual(len([e for e in db.read_state()["events"] if e.get("sosId") == "SOS-NOPAGE"]), len(linked))

    def test_stale_page_copy_cannot_roll_back_server_escalation(self):
        elder = self.login("elder")
        provider = self.login("provider")
        own_id = self.snapshot()["profile"]["id"]
        status, result = self.request("/api/sos", elder, {"session": {"id": "SOS-STALE", "residentId": own_id, "status": "waiting", "riskLevel": "high", "timeline": [{"time": "刚刚", "text": "触发呼救（一键呼救）", "state": "done"}]}})
        self.assertEqual(status, 200)
        stale = copy.deepcopy(next(s for s in result["sessions"] if s["id"] == "SOS-STALE"))
        # 服务器在页面不知道的情况下升级到 L2
        state = server.DATABASE.read_state()
        target = next(s for s in state["sosSessions"] if s["id"] == "SOS-STALE")
        target["createdAt"] -= 40_000
        server.DATABASE.upsert_sos_session(target, {"action": "测试：提前创建时间"})
        watchdog.run_once(server.DATABASE)
        # 机构端拿着旧副本（escalation=1、时间线较短）接单
        stale["status"] = "claimed"
        stale["timeline"].append({"time": "刚刚", "text": "白班值班员周敏已接单", "state": "current"})
        status, result = self.request("/api/sos", provider, {"session": stale})
        self.assertEqual(status, 200)
        merged = next(s for s in self.request("/api/sos", provider)[1]["sessions"] if s["id"] == "SOS-STALE")
        self.assertEqual((merged["status"], merged["escalation"]), ("claimed", 2))  # 升级记录没有被旧副本覆盖
        self.assertTrue(merged["notified"]["manager"])
        texts = [t["text"] for t in merged["timeline"]]
        self.assertTrue(any("后台值守" in t for t in texts) and "白班值班员周敏已接单" in texts)
        self.assertEqual(len(texts), len(set(texts)))
        self.assertGreater(merged["responseSeconds"], 30)  # 超时后接单，计为“超时后接单”
        self.assertEqual(sla.sos_outcome(merged), "late")

    def test_state_read_no_longer_mutates(self):
        regulator = self.login("regulator")
        revision = server.DATABASE.state_revision()
        for _ in range(3):
            self.request("/api/state", regulator)
        self.assertEqual(server.DATABASE.state_revision(), revision)


class RadarReview(ApiCase):
    def test_regulator_can_split_and_restore_cluster_member(self):
        regulator = self.login("regulator")
        _, radar = self.request("/api/radar", regulator)
        cluster = max(radar["clusters"], key=lambda c: len(c["event_ids"]))
        target = cluster["event_ids"][-1]
        data = self.request("/api/state", regulator)[1]["data"]
        data["radarReviews"] = [{"eventId": target, "decision": "exclude", "reason": "手法不同，只是用词相近", "clusterId": cluster["id"]}]
        self.assertEqual(self.write(regulator, data, "radar_review", target)[0], 200)
        _, after = self.request("/api/radar", regulator)
        self.assertNotIn(target, [eid for c in after["clusters"] for eid in c["event_ids"]])
        self.assertEqual(after["excluded"][0]["eventId"], target)
        provider = self.login("provider")
        pdata = self.request("/api/state", provider)[1]["data"]
        self.assertEqual(self.write(provider, pdata, "radar_review", target)[0], 403)  # 机构端不能改类案归并
        data = self.request("/api/state", regulator)[1]["data"]
        data["radarReviews"] = []
        self.assertEqual(self.write(regulator, data, "radar_review", target)[0], 200)
        _, restored = self.request("/api/radar", regulator)
        self.assertIn(target, [eid for c in restored["clusters"] for eid in c["event_ids"]])


class PackageHygiene(unittest.TestCase):
    def test_release_package_excludes_private_files(self):
        sys.path.insert(0, str(ROOT / "scripts"))
        import package_release  # noqa: E402
        with tempfile.TemporaryDirectory() as folder:
            target = Path(folder) / "release.zip"
            report = package_release.build(target, "桂养安心_测试包")
            self.assertTrue(target.is_file())
            self.assertEqual(report["problems"], [])
            names = report["files"]
            for forbidden in ("deepseek.env.local", "runtime/", "demo_credentials.json", ".sqlite", ".db", "__pycache__"):
                self.assertFalse([n for n in names if forbidden in n], forbidden)
            self.assertIn("桂养安心_测试包/deepseek.env.example", names)
            self.assertIn("桂养安心_测试包/.gitignore", names)
            self.assertIn("桂养安心_测试包/server.py", names)


class DatabasePathPrecedence(unittest.TestCase):
    def test_explicit_path_wins_over_environment(self):
        """设置了 GUIYANG_DB_PATH（跑 e2e 时）也不影响单元测试：显式传入的临时库优先。"""
        previous = os.environ.get("GUIYANG_DB_PATH")
        with tempfile.TemporaryDirectory() as folder:
            os.environ["GUIYANG_DB_PATH"] = str(Path(folder) / "env.sqlite")
            try:
                self.assertEqual(BusinessDatabase(Path(folder) / "explicit.sqlite").path.name, "explicit.sqlite")
                self.assertEqual(BusinessDatabase().path.name, "env.sqlite")
            finally:
                if previous is None:
                    os.environ.pop("GUIYANG_DB_PATH", None)
                else:
                    os.environ["GUIYANG_DB_PATH"] = previous


if __name__ == "__main__":
    unittest.main(verbosity=1)
