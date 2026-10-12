from e2e_auth import password_for, reset_demo, authorized_open
"""Two-window realtime test: elder in one window, duty desk in another."""
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


reset_demo()

with sync_playwright() as p:
    browser = p.chromium.launch()
    ctx = browser.new_context(viewport={"width": 1280, "height": 860})
    errs = []
    elder = ctx.new_page()
    elder.on("pageerror", lambda e: errs.append("elder:" + str(e)))
    desk = ctx.new_page()
    desk.on("pageerror", lambda e: errs.append("desk:" + str(e)))

    prepare(elder)
    prepare(desk)
    login(elder, "elder", "elder")
    elder.wait_for_selector(".sos-band", timeout=8000)
    login(desk, "provider", "center")
    desk.wait_for_selector(".sos-queue-panel", timeout=8000)
    check("duty desk opens with an empty active queue", desk.locator(".sos-queue-item").count() == 0)

    elder.click(".sos-big-btn")
    elder.wait_for_selector("[data-action='sos-send-now']")
    elder.click("[data-action='sos-send-now']")
    elder.wait_for_selector("[data-sos-modal]", timeout=6000)
    sid = elder.locator("[data-sos-modal]").get_attribute("data-sos-modal")

    start = time.time()
    desk.wait_for_selector(f".sos-queue-item [data-sos-countdown='{sid}']", timeout=9000)
    latency = time.time() - start
    check("duty desk receives the ticket with no refresh", latency < 6, f"{latency:.1f}s")
    check("toast alert fired on the duty desk", desk.locator(".toast").count() >= 1)

    a1 = elder.locator(f"[data-sos-modal] [data-sos-countdown='{sid}']").inner_text()
    b1 = desk.locator(f".sos-queue-item [data-sos-countdown='{sid}']").inner_text()
    time.sleep(2.2)
    a2 = elder.locator(f"[data-sos-modal] [data-sos-countdown='{sid}']").inner_text()
    b2 = desk.locator(f".sos-queue-item [data-sos-countdown='{sid}']").inner_text()
    check("countdown ticks in both windows", a1 != a2 and b1 != b2, f"elder {a1}->{a2} / desk {b1}->{b2}")

    time.sleep(1.5)
    tl = elder.evaluate(
        "id => (JSON.parse(localStorage.getItem('guiyang-v1-data')).sosSessions.find(s=>s.id===id)||{}).timeline",
        sid)
    texts = [t["text"] for t in tl]
    check("no duplicated timeline rows under two windows", len(texts) == len(set(texts)), texts[-1][:36])

    desk.locator(f".sos-queue-item:has([data-sos-countdown='{sid}']) [data-action='sos-claim']").click()
    start = time.time()
    elder.wait_for_function(
        "id => (JSON.parse(localStorage.getItem('guiyang-v1-data')).sosSessions.find(s=>s.id===id)||{}).status === 'claimed'",
        arg=sid, timeout=9000)
    check("claim pushed back to the elder window", time.time() - start < 6, f"{time.time()-start:.1f}s")
    sess = elder.evaluate("id => JSON.parse(localStorage.getItem('guiyang-v1-data')).sosSessions.find(s=>s.id===id)", sid)
    check("duty shift recorded on claim", bool(sess.get("claimedShift")), f"{sess.get('claimedShift')}·{sess.get('claimedBy')}")
    check("roster-driven contact on the ticket", any(c.get("shift") for c in sess["contacts"]), str(sess["contacts"][0]))

    reg = ctx.new_page()
    reg.on("pageerror", lambda e: errs.append("reg:" + str(e)))
    login(reg, "regulator", "admin")
    reg.wait_for_selector("[data-page='events']", timeout=8000)
    reg.click("[data-page='events']")
    reg.wait_for_selector(".sos-rank-panel", timeout=9000)
    rank = reg.locator(".sos-rank-panel").inner_text()
    check("institution response ranking rendered", "平均接单" in rank and "北海银龄康养中心" in rank)

    desk.click("[data-action='sos-mute']")
    check("chime toggle flips state", desk.locator("[data-action='sos-mute'][aria-pressed='true']").count() == 1)

    elder.click("[data-action='close-modal']")
    elder.wait_for_selector(".sos-live-banner")
    elder.focus(".sos-live-banner")
    elder.keyboard.press("Enter")
    elder.wait_for_selector("[data-sos-modal]", timeout=5000)
    check("live banner reachable by keyboard", True)

    check("no JS errors across three windows", not errs, "; ".join(errs[:2]))
    browser.close()

fails = [r for r in results if not r[1]]
print(f"===== {len(results)-len(fails)}/{len(results)} PASSED =====")
if fails:
    raise SystemExit(1)
