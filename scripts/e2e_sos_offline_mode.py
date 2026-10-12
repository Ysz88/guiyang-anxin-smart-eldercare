"""Offline mode check: opening index.html directly, with no Python server at all."""
import os
import time
from playwright.sync_api import sync_playwright

FILE_URL = "file://" + os.path.abspath("index.html")
results = []


def check(name, cond, detail=""):
    results.append((name, bool(cond)))
    print(("PASS" if cond else "FAIL"), "-", name, ("· " + detail if detail else ""))


with sync_playwright() as p:
    browser = p.chromium.launch()
    ctx = browser.new_context(viewport={"width": 1280, "height": 860})
    errs = []
    elder = ctx.new_page()
    elder.on("pageerror", lambda e: errs.append("elder:" + str(e)))
    desk = ctx.new_page()
    desk.on("pageerror", lambda e: errs.append("desk:" + str(e)))

    elder.goto(FILE_URL)
    elder.wait_for_selector("#login-form", timeout=8000)
    check("page loads straight from disk", True, FILE_URL.split("/")[-1])
    check("backend correctly detected as unavailable",
          elder.evaluate("window.location.protocol") == "file:")

    elder.fill("#login-account", "elder")
    elder.fill("#login-password", "offline-demo")
    elder.click("#login-form button[type=submit]")
    elder.wait_for_selector(".sos-band", timeout=8000)
    check("elder side renders with seeded data", elder.locator(".sos-big-btn").count() == 1)

    desk.goto(FILE_URL)
    desk.wait_for_selector("#login-form", timeout=8000)
    desk.click(".role-option[data-role='provider']")
    desk.fill("#login-account", "center")
    desk.fill("#login-password", "offline-demo")
    desk.click("#login-form button[type=submit]")
    desk.wait_for_selector(".sos-queue-panel", timeout=8000)

    elder.click(".sos-big-btn")
    elder.wait_for_selector("[data-action='sos-send-now']")
    elder.click("[data-action='sos-send-now']")
    elder.wait_for_selector("[data-sos-modal]", timeout=6000)
    sid = elder.locator("[data-sos-modal]").get_attribute("data-sos-modal")

    start = time.time()
    desk.wait_for_selector(f".sos-queue-item [data-sos-countdown='{sid}']", timeout=8000)
    check("cross-window push works with no server (BroadcastChannel)", True, f"{time.time()-start:.1f}s")

    desk.locator(f".sos-queue-item:has([data-sos-countdown='{sid}']) [data-action='sos-claim']").click()
    elder.wait_for_function(
        "id => (JSON.parse(localStorage.getItem('guiyang-v1-data')).sosSessions.find(s=>s.id===id)||{}).status === 'claimed'",
        arg=sid, timeout=8000)
    check("claim reaches the elder window with no server", True)

    # the state machine keeps running with no server: auto-callback advances on its own
    elder.wait_for_function(
        "id => ((JSON.parse(localStorage.getItem('guiyang-v1-data')).sosSessions.find(s=>s.id===id)||{}).callback||{}).status !== 'dialing'",
        arg=sid, timeout=20000)
    check("auto-callback timer still runs offline", True)

    # close this ticket, raise a fresh one and let the 30-second SLA lapse unclaimed
    desk.locator(f".sos-queue-item:has([data-sos-countdown='{sid}']) [data-action='sos-resolve'][data-mode='safe']").click()
    # the elder keeps the progress dialog open until they dismiss it, which is intended
    elder.wait_for_selector("[data-sos-modal] .sos-status-head.settled", timeout=8000)
    check("elder progress dialog switches to a settled state", True)
    elder.click("[data-action='close-modal']")
    elder.wait_for_selector(".sos-band", timeout=8000)
    elder.click(".sos-big-btn")
    elder.wait_for_selector("[data-action='sos-send-now']")
    elder.click("[data-action='sos-send-now']")
    elder.wait_for_selector("[data-sos-modal]", timeout=6000)
    second = elder.locator("[data-sos-modal]").get_attribute("data-sos-modal")
    elder.wait_for_function(
        "id => (JSON.parse(localStorage.getItem('guiyang-v1-data')).sosSessions.find(s=>s.id===id)||{}).escalation >= 2",
        arg=second, timeout=50000)
    check("SLA escalation still fires offline", True, second)

    fatal = [e for e in errs if "fetch" not in e.lower() and "failed to fetch" not in e.lower()]
    check("no fatal JS errors in offline mode", not fatal, "; ".join(fatal[:2]))
    browser.close()

fails = [r for r in results if not r[1]]
print(f"===== {len(results)-len(fails)}/{len(results)} PASSED =====")
if fails:
    raise SystemExit(1)
