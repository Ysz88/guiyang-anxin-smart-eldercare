from e2e_auth import password_for, reset_demo, authorized_open
"""Focused test: L3 auto-escalation to regulator + emergency-form danger path."""
import time
from playwright.sync_api import sync_playwright

import os
BASE = os.environ.get("GY_BASE", "http://127.0.0.1:4173/")
results = []
def check(name, cond, detail=""):
    results.append((name, bool(cond)))
    print(("PASS" if cond else "FAIL"), "-", name, ("· " + detail if detail else ""))



def prepare(page):
    """Clear this browser context before the first login of a run."""
    page.goto(BASE)
    page.evaluate("localStorage.clear(); sessionStorage.clear();")


reset_demo()

with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_context(viewport={"width": 1360, "height": 900}).new_page()
    errs = []
    page.on("pageerror", lambda e: errs.append(str(e)))

    page.goto(BASE)
    # fresh demo state so IDs are predictable
    page.evaluate("localStorage.clear()")
    page.goto(BASE)
    page.wait_for_selector("#login-form")
    page.fill("#login-account", "elder"); page.fill("#login-password", password_for("elder"))
    page.click("#login-form button[type=submit]")

    page.wait_for_selector(".sos-band", timeout=8000)

    # --- 求助表单 danger category → SOS + linked event immediately ---
    page.click("[data-action='emergency-report']")
    page.wait_for_selector("#emergency-form")
    page.click("label.report-type:has(input[value='人身安全'])")
    page.fill("#emergency-description", "陌生人一直跟着我，很害怕")
    page.click("button[form='emergency-form']")
    page.wait_for_selector("[data-sos-modal]", timeout=6000)
    data = page.evaluate("JSON.parse(localStorage.getItem('guiyang-v1-data'))")
    sess = data["sosSessions"][0]
    check("danger form opens SOS loop with linked event", sess["status"] == "waiting" and bool(sess["linkedEventId"]), f"{sess['id']} -> {sess['linkedEventId']}")

    # --- wait through L2 (30s) to L3 (75s) ---
    sid = sess["id"]
    page.click("[data-action='close-modal']")
    page.wait_for_function(
        "id => (JSON.parse(localStorage.getItem('guiyang-v1-data')).sosSessions.find(s=>s.id===id)||{}).escalation >= 3",
        arg=sid, timeout=90000)
    sess = page.evaluate("id => JSON.parse(localStorage.getItem('guiyang-v1-data')).sosSessions.find(s=>s.id===id)", sid)
    check("L3 auto-escalation to regulator", sess["escalation"] == 3 and sess["notified"]["regulator"])
    check("L3 timeline entry", any("监管" in t["text"] and "联动" in t["text"] for t in sess["timeline"]))

    # --- regulator sees it, linked event is 处置中 with 属地应急联络组 ---
    page.click("#logout-btn"); page.wait_for_selector("#login-form")
    page.click(".role-option[data-role='regulator']")
    page.fill("#login-account", "admin"); page.fill("#login-password", password_for("regulator"))
    page.click("#login-form button[type=submit]")
    page.wait_for_selector("[data-page='events']", timeout=8000)
    page.click("[data-page='events']")
    page.wait_for_selector(".sos-queue-item.level-3", timeout=8000)
    check("regulator queue shows level-3 highlighted item", page.locator(".sos-queue-item.level-3").count() >= 1)
    check("联动中 tag replaces manual escalate button", "联动中" in page.locator(".sos-queue-item.level-3").inner_text())
    data = page.evaluate("JSON.parse(localStorage.getItem('guiyang-v1-data'))")
    ev = next((e for e in data["events"] if e["id"] == sess["linkedEventId"]), None)
    check("linked event live for regulator", ev and ev["status"] in ("处置中", "待复核"), ev["owner"] if ev else "missing")

    # --- provider can still resolve as dispatched (联动120/110) ---
    page.click("#logout-btn"); page.wait_for_selector("#login-form")
    page.click(".role-option[data-role='provider']")
    page.fill("#login-account", "center"); page.fill("#login-password", password_for("provider"))
    page.click("#login-form button[type=submit]")
    page.wait_for_selector(".sos-queue-panel", timeout=8000)
    page.locator(f".sos-queue-item [data-action='sos-claim']").first.click()
    page.wait_for_selector(f".sos-queue-item [data-action='sos-resolve'][data-mode='dispatched']", timeout=6000)
    page.locator(f".sos-queue-item [data-action='sos-resolve'][data-mode='dispatched']").first.click()
    page.wait_for_function(
        "id => (JSON.parse(localStorage.getItem('guiyang-v1-data')).sosSessions.find(s=>s.id===id)||{}).status === 'resolved_dispatched'",
        arg=sid, timeout=6000)
    check("dispatched closure (联动120/110)", True)
    js = [e for e in errs if "favicon" not in e]
    check("no JS errors", not js, "; ".join(js[:1]))
    browser.close()

fails = [r for r in results if not r[1]]
print(f"===== {len(results)-len(fails)}/{len(results)} PASSED =====")
if fails: raise SystemExit(1)
