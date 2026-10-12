from e2e_auth import password_for, reset_demo, authorized_open
"""Cross-device test: isolated browser contexts share nothing but the server."""
import time
from playwright.sync_api import sync_playwright

import os
BASE = os.environ.get("GY_BASE", "http://127.0.0.1:4173/")
results = []


def check(name, cond, detail=""):
    results.append((name, bool(cond)))
    print(("PASS" if cond else "FAIL"), "-", name, ("· " + detail if detail else ""))


def login(page, role, account):
    page.goto(BASE)
    page.wait_for_selector("#login-form")
    page.click(f".role-option[data-role='{role}']")
    page.fill("#login-account", account)
    page.fill("#login-password", password_for(role))
    page.click("#login-form button[type=submit]")




def prepare(page):
    """Clear this browser context before the first login of a run."""
    page.goto(BASE)
    page.evaluate("localStorage.clear(); sessionStorage.clear();")


def session_of(page, sid):
    return page.evaluate(
        "id => JSON.parse(localStorage.getItem('guiyang-v1-data')).sosSessions.find(s=>s.id===id)", sid)


reset_demo()

with sync_playwright() as p:
    browser = p.chromium.launch()
    errs = []
    # two isolated contexts == two devices: separate localStorage, no BroadcastChannel between them
    phone_ctx = browser.new_context(viewport={"width": 420, "height": 900})
    desk_ctx = browser.new_context(viewport={"width": 1280, "height": 860})
    phone = phone_ctx.new_page()
    phone.on("pageerror", lambda e: errs.append("phone:" + str(e)))
    desk = desk_ctx.new_page()
    desk.on("pageerror", lambda e: errs.append("desk:" + str(e)))

    prepare(phone)
    prepare(desk)
    login(phone, "elder", "elder")
    phone.wait_for_selector(".sos-band", timeout=9000)
    login(desk, "provider", "center")
    desk.wait_for_selector(".sos-queue-panel", timeout=9000)

    isolated = phone.evaluate("sessionStorage.getItem('guiyang-v2-token')") != desk.evaluate(
        "sessionStorage.getItem('guiyang-v2-token')")
    check("contexts are storage-isolated (simulating two devices)", isolated)

    phone.click(".sos-big-btn")
    phone.wait_for_selector("[data-action='sos-send-now']")
    phone.click("[data-action='sos-send-now']")
    phone.wait_for_selector("[data-sos-modal]", timeout=6000)
    sid = phone.locator("[data-sos-modal]").get_attribute("data-sos-modal")

    start = time.time()
    desk.wait_for_selector(f".sos-queue-item [data-sos-countdown='{sid}']", timeout=10000)
    check("ticket reaches the other device through the server", True, f"{time.time()-start:.1f}s poll latency")

    # let both devices run their own state machines through the 30s SLA escalation
    phone.wait_for_function(
        "id => (JSON.parse(localStorage.getItem('guiyang-v1-data')).sosSessions.find(s=>s.id===id)||{}).escalation >= 2",
        arg=sid, timeout=45000)
    time.sleep(3)
    a = session_of(phone, sid)
    b = session_of(desk, sid)
    texts_a = [t["text"] for t in a["timeline"]]
    texts_b = [t["text"] for t in b["timeline"]]
    check("no duplicated rows on device A", len(texts_a) == len(set(texts_a)), f"{len(texts_a)} rows")
    check("no duplicated rows on device B", len(texts_b) == len(set(texts_b)), f"{len(texts_b)} rows")
    check("both devices converge on the same escalation level", a["escalation"] == b["escalation"], f"A={a['escalation']} B={b['escalation']}")

    # server holds one authoritative copy
    import json
    import urllib.request
    ledger = json.load(authorized_open(BASE, "api/sos"))
    server_copy = next(s for s in ledger["sessions"] if s["id"] == sid)
    server_texts = [t["text"] for t in server_copy["timeline"]]
    check("server ledger has no duplicates", len(server_texts) == len(set(server_texts)), f"{len(server_texts)} rows")

    desk.locator(f".sos-queue-item:has([data-sos-countdown='{sid}']) [data-action='sos-claim']").click()
    phone.wait_for_function(
        "id => (JSON.parse(localStorage.getItem('guiyang-v1-data')).sosSessions.find(s=>s.id===id)||{}).status === 'claimed'",
        arg=sid, timeout=10000)
    check("claim crosses the device boundary", True)

    # offline resilience: kill network on the elder device, cancel, then come back
    phone.context.set_offline(True)
    phone.click("[data-action='close-modal']")
    phone.wait_for_selector(".sos-live-banner")
    phone.click(".sos-live-banner")
    phone.wait_for_selector("[data-action='sos-cancel']")
    phone.click("[data-action='sos-cancel']")
    phone.wait_for_selector("[data-action='sos-cancel-confirm']")
    phone.click("[data-action='sos-cancel-confirm']")
    time.sleep(1)
    offline_state = session_of(phone, sid)
    check("offline cancel still recorded locally", offline_state["status"] == "cancelled")
    import json
    import urllib.request as _req
    before = next(s for s in json.load(authorized_open(BASE, "api/sos"))["sessions"] if s["id"] == sid)
    check("server has not seen the offline cancel yet", before["status"] != "cancelled", before["status"])

    phone.context.set_offline(False)
    deadline = time.time() + 15
    synced = False
    while time.time() < deadline:
        remote = next(s for s in json.load(authorized_open(BASE, "api/sos"))["sessions"] if s["id"] == sid)
        if remote["status"] == "cancelled":
            synced = True
            break
        time.sleep(1)
    check("offline record is backfilled after reconnect", synced)
    check("no crash after reconnect", not errs, "; ".join(errs[:2]))

    browser.close()

fails = [r for r in results if not r[1]]
print(f"===== {len(results)-len(fails)}/{len(results)} PASSED =====")
if fails:
    raise SystemExit(1)
