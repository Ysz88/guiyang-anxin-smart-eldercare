from e2e_auth import password_for, reset_demo, authorized_open
"""16.0 评阅整改的浏览器验收：小屏呼救入口、打卡必须明确选择、事件时限与办结、类案人工纠错、关掉页面后服务器继续升级。"""
import json
import os
import time

from playwright.sync_api import sync_playwright

BASE = os.environ.get("GY_BASE", "http://127.0.0.1:4173/")
ACCOUNTS = {"elder": "elder", "provider": "center", "regulator": "admin"}
results = []


def check(name, condition, detail=""):
    results.append((name, bool(condition)))
    print(("PASS" if condition else "FAIL"), "-", name, ("· " + detail if detail else ""))


def login(page, role):
    page.goto(BASE)
    page.evaluate("localStorage.clear(); sessionStorage.clear();")
    page.goto(BASE)
    page.wait_for_selector("#login-form")
    page.click(f".role-option[data-role={role}]")
    page.fill("#login-account", ACCOUNTS[role])
    page.fill("#login-password", password_for(role))
    page.click("#login-form button[type=submit]")
    page.wait_for_selector("#logout-btn", state="attached", timeout=8000)
    time.sleep(0.8)


def goto(page, name):
    page.evaluate("(n) => document.querySelector(`[data-page='${n}']`)?.click()", name)
    time.sleep(0.6)


def ledger():
    return json.load(authorized_open(BASE, "api/sos", "regulator"))["sessions"]


def server_state():
    return json.load(authorized_open(BASE, "api/state", "regulator"))["data"]


reset_demo()
with sync_playwright() as p:
    browser = p.chromium.launch()
    errors = []

    # ---------- 老人端手机小屏：一键呼救与 120 在首屏 ----------
    ctx = browser.new_context(viewport={"width": 375, "height": 667}, locale="zh-CN", is_mobile=True, has_touch=True)
    page = ctx.new_page()
    page.on("pageerror", lambda e: errors.append(str(e)))
    login(page, "elder")
    sos_box = page.locator(".sos-big-btn").bounding_box()
    dial_box = page.locator("a.sos-direct[href='tel:120']").first.bounding_box()
    check("375×667 首屏能看到一键呼救", sos_box and sos_box["y"] + sos_box["height"] <= 667, str(sos_box and round(sos_box["y"] + sos_box["height"])))
    check("375×667 首屏能看到直接拨打120", dial_box and dial_box["y"] + dial_box["height"] <= 667)
    check("呼救按钮不再承诺“30秒内有人回拨”", "回拨" not in page.locator(".sos-big-btn").inner_text())
    check("首页不显示顶栏呼救（已有大按钮）", page.locator("#topbar-sos").is_hidden())
    goto(page, "check")
    check("其他页面顶栏保留一键呼救", page.locator("#topbar-sos").is_visible())

    # ---------- 打卡：四项都不预选，未选择不能提交 ----------
    check("打卡四项默认都没有选中", page.locator("#daily-check-form input[type=radio]:checked").count() == 0)
    before = len(server_state()["dailyChecks"])
    page.click("#daily-check-form button[type=submit]")
    time.sleep(1.2)
    check("一项都没选时不能提交", len(server_state()["dailyChecks"]) == before)
    for name, value in (("sleep", "良好"), ("appetite", "一般"), ("mood", "平稳"), ("mobility", "正常")):
        page.locator(f"#daily-check-form label.choice:has(input[name={name}][value='{value}'])").click()
    page.click("#daily-check-form button[type=submit]")
    time.sleep(1.5)
    today = page.evaluate("new Date().toLocaleDateString('sv-SE')")
    saved = server_state()["dailyChecks"][0]
    check("选完四项后保存的是本人选择", saved["date"] == today and saved["appetite"] == "一般", json.dumps(saved, ensure_ascii=False)[:80])
    stat = page.locator(".panel:has(h3:text('近 7 天打卡')) .stat-value strong").inner_text()
    check("近7天打卡天数按真实日期统计", stat.strip() in {"2", "3", "4"}, stat)
    ctx.close()

    # ---------- 机构端：时限按服务器时间；办结要说明和回访；更新备注不重置截止时间 ----------
    ctx = browser.new_context(viewport={"width": 1360, "height": 900}, locale="zh-CN")
    page = ctx.new_page()
    page.on("pageerror", lambda e: errors.append(str(e)))
    login(page, "provider")
    goto(page, "alerts")
    target = "EV-20260809-088"
    due_before = next(e for e in server_state()["events"] if e["id"] == target)["dueAt"]
    page.click(f"[data-action='handle-event'][data-id='{target}']")
    page.wait_for_selector("#event-handle-form")
    page.select_option("#event-handle-form select[name=status]", "处置中")
    page.click("#event-handle-form [data-action='note-chip']")
    page.click("button[form='event-handle-form']")
    time.sleep(1.5)
    after = next(e for e in server_state()["events"] if e["id"] == target)
    check("更新备注不重置截止时间", after["dueAt"] == due_before and after["status"] == "处置中")
    page.click(f"[data-action='handle-event'][data-id='{target}']")
    page.wait_for_selector("#event-handle-form")
    page.select_option("#event-handle-form select[name=status]", "已办结")
    page.fill("#event-handle-form textarea[name=note]", "已电话联系老人并退还多收费用")
    check("选择办结时出现回访结果", page.locator(".follow-up-field").is_visible())
    page.select_option("#event-handle-form select[name=followUp]", "已回访，老人不认可")
    page.click("button[form='event-handle-form']")
    time.sleep(1.0)
    check("老人不认可时不能办结", next(e for e in server_state()["events"] if e["id"] == target)["status"] != "已办结")
    page.select_option("#event-handle-form select[name=followUp]", "已回访，老人认可")
    page.click("button[form='event-handle-form']")
    time.sleep(1.5)
    closed = next(e for e in server_state()["events"] if e["id"] == target)
    check("办结时间由服务器写入", closed["status"] == "已办结" and isinstance(closed.get("closedAt"), int))
    goto(page, "dashboard")
    goto(page, "alerts")
    page.evaluate("document.querySelector('[data-action=refresh-data]')?.click()")
    time.sleep(1.2)
    check("待处置队列显示服务器计算的时限", page.locator(".sla-text").count() >= 3)

    # ---------- 服务器拒绝写入时：提示没保存，页面恢复为服务器记录（不显示一份没保存的数据） ----------
    events_now = {e["id"]: e for e in server_state()["events"]}
    shown = page.eval_on_selector_all("[data-action='handle-event']", "els => els.map((el) => el.dataset.id)")
    victim = next(eid for eid in shown if events_now.get(eid, {}).get("status") not in (None, "已办结"))
    original = events_now[victim]["status"]
    is_state_post = lambda url: url.endswith("/api/state")  # noqa: E731

    def reject_state(route):
        if route.request.method == "POST":
            route.fulfill(status=403, content_type="application/json", body='{"error":"institution_scope_forbidden"}')
        else:
            route.continue_()

    page.route(is_state_post, reject_state)
    page.click(f"[data-action='handle-event'][data-id='{victim}']")
    page.wait_for_selector("#event-handle-form")
    page.select_option("#event-handle-form select[name=status]", "已转派" if original != "已转派" else "处置中")
    page.click("#event-handle-form [data-action='note-chip']")
    page.click("button[form='event-handle-form']")
    page.wait_for_selector(".toast[data-title='这次修改没有保存']", timeout=5000)
    page.unroute(is_state_post, reject_state)
    page.wait_for_function("([id, status]) => { const row = document.querySelector(`[data-action='handle-event'][data-id='${id}']`)?.closest('tr'); return Boolean(row) && row.cells[4].innerText.trim() === status; }", arg=[victim, original], timeout=8000)
    check("服务器拒绝写入时提示没保存，页面恢复为服务器上的状态", next(e for e in server_state()["events"] if e["id"] == victim)["status"] == original, f"{victim} {original}")
    ctx.close()

    # ---------- 监管端：类案人工纠错 ----------
    ctx = browser.new_context(viewport={"width": 1360, "height": 900}, locale="zh-CN")
    page = ctx.new_page()
    page.on("pageerror", lambda e: errors.append(str(e)))
    login(page, "regulator")
    goto(page, "radar")
    page.wait_for_selector(".radar-card", timeout=10000)
    caption = page.locator(".radar-graph figcaption").first.inner_text()
    check("关系图不再写“互不相识”“指向同一对象”", "互不相识" not in caption and "同一对象" not in caption, caption[:40])
    member = page.locator("[data-action='radar-exclude']").first
    event_id = member.get_attribute("data-id")
    member.click()
    page.wait_for_selector("#radar-exclude-form")
    page.select_option("#radar-exclude-form select[name=reason]", "手法不同，只是用词相近")
    page.click("button[form='radar-exclude-form']")
    page.wait_for_selector(".radar-excluded", timeout=8000)
    in_cluster = page.evaluate("(id) => [...document.querySelectorAll('.radar-card [data-action=radar-exclude]')].some(b => b.dataset.id === id)", event_id)
    check("移出的个案不再出现在类案里", not in_cluster, event_id)
    page.click(f".radar-excluded [data-action='radar-restore'][data-id='{event_id}']")
    page.wait_for_function("(id) => [...document.querySelectorAll('.radar-card [data-action=radar-exclude]')].some(b => b.dataset.id === id)", arg=event_id, timeout=8000)
    check("撤销移出后个案回到类案", True)
    ctx.close()

    # ---------- 关掉所有页面后，服务器仍按时升级 ----------
    ctx = browser.new_context(viewport={"width": 1280, "height": 860}, locale="zh-CN")
    page = ctx.new_page()
    login(page, "elder")
    page.click(".sos-big-btn")
    page.wait_for_selector("[data-action='sos-send-now']")
    page.click("[data-action='sos-send-now']")
    page.wait_for_selector("[data-sos-modal]", timeout=6000)
    sid = page.locator("[data-sos-modal]").get_attribute("data-sos-modal")
    time.sleep(1.5)  # 等工单写入服务器
    ctx.close()
    check("呼救发出后关闭了所有页面", len(browser.contexts) == 0)
    time.sleep(33)
    session = next((s for s in ledger() if s["id"] == sid), {})
    check("没有任何页面打开时，服务器按时升级到 L2", session.get("escalation", 0) >= 2, f"escalation={session.get('escalation')}")
    check("升级留痕写明由后台值守执行", any("后台值守" in t.get("text", "") for t in session.get("timeline", [])))
    audit = json.load(authorized_open(BASE, "api/audit?limit=40", "regulator"))["logs"]
    check("审计日志里有后台值守的记录", any(log["actor_name"] == "后台值守" and log["entity_id"] == sid for log in audit))

    # ---------- 呼救改动被服务器拒绝（如已被他人接单）：同步回服务器记录，不再反复补传 ----------
    ctx = browser.new_context(viewport={"width": 1360, "height": 900}, locale="zh-CN")
    page = ctx.new_page()
    page.on("pageerror", lambda e: errors.append(str(e)))
    login(page, "provider")
    goto(page, "alerts")
    claim_button = f"[data-action='sos-claim'][data-id='{sid}']"
    page.wait_for_selector(claim_button, timeout=8000)
    posts = []
    is_sos_post = lambda url: url.endswith("/api/sos")  # noqa: E731

    def reject_sos(route):
        if route.request.method == "POST":
            posts.append(route.request.url)
            route.fulfill(status=409, content_type="application/json", body='{"error":"sos_already_claimed"}')
        else:
            route.continue_()

    page.route(is_sos_post, reject_sos)
    page.click(claim_button)
    page.wait_for_selector(".toast[data-title='工单状态已变化']", timeout=5000)
    page.wait_for_selector(claim_button, timeout=8000)
    time.sleep(4.5)  # 两轮以上轮询：被拒绝的改动不应再反复补传
    check("呼救改动被拒绝后同步回服务器记录、不再反复补传", len(posts) == 1, f"posts={len(posts)}")
    page.unroute(is_sos_post, reject_sos)
    page.click(claim_button)
    time.sleep(1.5)
    claimed = next((s for s in ledger() if s["id"] == sid), {})
    check("同步后可以正常接单", claimed.get("status") == "claimed" and bool(claimed.get("claimedBy")), str(claimed.get("claimedBy", "")))
    ctx.close()

    check("全程没有页面脚本报错", not errors, " | ".join(errors[:2]))
    browser.close()

fails = [r for r in results if not r[1]]
print(f"\n===== {len(results) - len(fails)}/{len(results)} PASSED =====")
if fails:
    raise SystemExit(1)
