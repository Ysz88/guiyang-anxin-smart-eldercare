from e2e_auth import password_for, reset_demo, authorized_open
"""End-to-end UI test of the SOS closed loop across all three roles."""
import time
from playwright.sync_api import sync_playwright

import os
BASE = os.environ.get("GY_BASE", "http://127.0.0.1:4173/")
results = []

def check(name, condition, detail=""):
    results.append((name, bool(condition), detail))
    print(("PASS" if condition else "FAIL"), "-", name, ("· " + detail if detail else ""))



def prepare(page):
    """Clear this browser context before the first login of a run."""
    page.goto(BASE)
    page.evaluate("localStorage.clear(); sessionStorage.clear();")


reset_demo()

with sync_playwright() as p:
    browser = p.chromium.launch()
    ctx = browser.new_context(viewport={"width": 1360, "height": 900}, locale="zh-CN")
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)

    # ---------- Elder: login ----------
    prepare(page)
    page.goto(BASE)
    page.wait_for_selector("#login-form")
    page.fill("#login-account", "elder")
    page.fill("#login-password", password_for("elder"))
    page.click("#login-form button[type=submit]")

    page.wait_for_selector(".sos-band", timeout=8000)
    check("elder dashboard shows SOS band", page.locator(".sos-big-btn").count() == 1)
    check("120 self-dial stays visible", page.locator("a.sos-direct[href='tel:120']").count() == 1)

    # ---------- Elder: one-touch SOS with anti-mistouch countdown ----------
    page.click(".sos-big-btn")
    page.wait_for_selector("#sos-launch-count")
    check("launch countdown modal opens", page.locator("#sos-launch-count").inner_text().strip() in {"5", "4"})
    page.click("[data-action='sos-abort-launch']")
    page.wait_for_selector("#sos-launch-count", state="detached")
    time.sleep(6.5)  # ensure aborted timer does NOT fire a ghost SOS
    ghost = page.evaluate("JSON.parse(localStorage.getItem('guiyang-v1-data')).sosSessions.filter(s => ['waiting','claimed'].includes(s.status)).length")
    check("abort leaves no ghost session after timer window", ghost == 0)

    page.click(".sos-big-btn")
    page.wait_for_selector("[data-action='sos-send-now']")
    page.click("[data-action='sos-send-now']")
    page.wait_for_selector("[data-sos-modal]", timeout=6000)
    sos_id = page.locator("[data-sos-modal]").get_attribute("data-sos-modal")
    check("SOS session created + live status modal", bool(sos_id and sos_id.startswith("SOS-")), sos_id or "")
    check("status modal keeps 120 button", page.locator(".modal-footer a[href='tel:120'], footer a[href='tel:120'], a.btn-danger[href='tel:120']").count() >= 1)
    cd1 = page.locator(f"[data-sos-modal] [data-sos-countdown='{sos_id}']").inner_text()
    time.sleep(2.2)
    cd2 = page.locator(f"[data-sos-modal] [data-sos-countdown='{sos_id}']").inner_text()
    check("claim-SLA countdown ticking", cd1 != cd2, f"{cd1} -> {cd2}")

    # callback simulation: dialing -> ringing after ~3s
    page.wait_for_function(
        "id => (JSON.parse(localStorage.getItem('guiyang-v1-data')).sosSessions.find(s=>s.id===id)||{}).callback.status === 'ringing'",
        arg=sos_id, timeout=8000)
    check("auto-callback advanced to ringing", True)

    # close modal, elder dashboard shows live banner
    page.click("[data-sos-modal] ~ * [data-action='close-modal'], [data-action='close-modal']")
    page.wait_for_selector(".sos-live-banner", timeout=5000)
    check("elder dashboard live banner", page.locator(".sos-live-banner").count() == 1)

    # ---------- Escalation L2 at 30s (SLA breach) ----------
    page.wait_for_function(
        "id => (JSON.parse(localStorage.getItem('guiyang-v1-data')).sosSessions.find(s=>s.id===id)||{}).escalation >= 2",
        arg=sos_id, timeout=40000)
    sess = page.evaluate("id => JSON.parse(localStorage.getItem('guiyang-v1-data')).sosSessions.find(s=>s.id===id)", sos_id)
    check("L2 escalation at SLA breach", sess["escalation"] >= 2)
    check("L2 notified manager+family", sess["notified"]["manager"] and sess["notified"]["family"])
    check("timeline records escalation", any("负责人" in t["text"] for t in sess["timeline"]))

    # ---------- Provider: queue, claim, callback outcome, resolve ----------
    page.click("#logout-btn")
    page.wait_for_selector("#login-form")
    page.click(".role-option[data-role='provider']")
    page.fill("#login-account", "center")
    page.fill("#login-password", password_for("provider"))
    page.click("#login-form button[type=submit]")
    page.wait_for_selector(".sos-queue-panel", timeout=8000)
    check("provider dashboard SOS queue panel", page.locator(".sos-queue-panel").count() >= 1)
    item = page.locator(f".sos-queue-item:has([data-sos-countdown='{sos_id}'])")
    check("live session visible in provider queue", item.count() == 1)
    check("button trigger surfaced to duty staff", sos_id in item.inner_text() and "一键呼救" in item.inner_text())
    item.locator("[data-action='sos-claim']").click()
    page.wait_for_function(
        "id => (JSON.parse(localStorage.getItem('guiyang-v1-data')).sosSessions.find(s=>s.id===id)||{}).status === 'claimed'",
        arg=sos_id, timeout=6000)
    sess = page.evaluate("id => JSON.parse(localStorage.getItem('guiyang-v1-data')).sosSessions.find(s=>s.id===id)", sos_id)
    check("claim records staff + response seconds", sess["claimedBy"] == "周敏" and isinstance(sess["responseSeconds"], (int, float)), f"{sess['claimedBy']} / {sess['responseSeconds']}s")

    page.locator(f".sos-queue-item:has([data-sos-countdown='{sos_id}']) [data-action='sos-callback']").click()
    page.wait_for_selector(".sos-outcome-btn")
    page.locator("[data-outcome='answered_danger']").click()
    page.wait_for_function(
        "id => (JSON.parse(localStorage.getItem('guiyang-v1-data')).sosSessions.find(s=>s.id===id)||{}).callback.status === 'answered_danger'",
        arg=sos_id, timeout=6000)
    sess = page.evaluate("id => JSON.parse(localStorage.getItem('guiyang-v1-data')).sosSessions.find(s=>s.id===id)", sos_id)
    check("danger callback creates linked high event", bool(sess["linkedEventId"]))

    page.locator(f".sos-queue-item:has([data-sos-countdown='{sos_id}']) [data-action='sos-resolve'][data-mode='handled']").click()
    page.wait_for_function(
        "id => (JSON.parse(localStorage.getItem('guiyang-v1-data')).sosSessions.find(s=>s.id===id)||{}).status === 'resolved_handled'",
        arg=sos_id, timeout=6000)
    data = page.evaluate("JSON.parse(localStorage.getItem('guiyang-v1-data'))")
    sess = next(s for s in data["sosSessions"] if s["id"] == sos_id)
    ev = next((e for e in data["events"] if e["id"] == sess["linkedEventId"]), None)
    check("resolve closes loop", sess["status"] == "resolved_handled")
    check("linked event auto-closed", ev and ev["status"] == "已办结", ev["status"] if ev else "missing")

    # ---------- Voice-SOS path via AI assistant (text input triggers same triage) ----------
    page.click("#logout-btn"); page.wait_for_selector("#login-form")
    page.click(".role-option[data-role='elder']")
    page.fill("#login-account", "elder"); page.fill("#login-password", password_for("elder"))
    page.click("#login-form button[type=submit]")
    page.wait_for_selector(".sos-band", timeout=8000)
    page.click("[data-action='ai-video']")
    page.wait_for_selector("#ai-dialog-input")
    page.fill("#ai-dialog-input", "救命，快来人")
    page.click("#ai-send-btn")
    page.wait_for_selector(".sos-inline", timeout=15000)
    check("voice/text 救命 auto-starts platform response (no bare 120 link)", page.locator(".sos-inline").count() == 1)
    banner = page.locator(".ai-urgent-banner").inner_text()
    check("urgent banner keeps 120 first + platform responding", "120" in banner and "回拨" in banner, banner[:60])
    sos2 = page.evaluate("JSON.parse(localStorage.getItem('guiyang-v1-data')).sosSessions[0]")
    check("second session waiting w/ transcript", sos2["status"] == "waiting" and "救命" in sos2["transcript"], sos2["id"])

    # dedupe: sending 救命 again must not create a third session
    page.fill("#ai-dialog-input", "救命")
    page.click("#ai-send-btn")
    time.sleep(2.5)
    n_active = page.evaluate("JSON.parse(localStorage.getItem('guiyang-v1-data')).sosSessions.filter(s=>['waiting','claimed'].includes(s.status)).length")
    check("duplicate cries deduped to one active session", n_active == 1, f"active={n_active}")

    # ---------- Elder cancel path (误触留痕) ----------
    page.click("[data-action='close-modal']")  # close AI modal
    page.wait_for_selector(".sos-live-banner")
    page.click(".sos-live-banner")
    page.wait_for_selector("[data-sos-modal]")
    page.click("[data-action='sos-cancel']")
    page.wait_for_selector("[data-action='sos-cancel-confirm']")
    page.click("[data-action='sos-cancel-confirm']")
    page.wait_for_function(
        "() => !JSON.parse(localStorage.getItem('guiyang-v1-data')).sosSessions.some(s=>['waiting','claimed'].includes(s.status))",
        timeout=6000)
    last = page.evaluate("JSON.parse(localStorage.getItem('guiyang-v1-data')).sosSessions[0]")
    check("elder cancel leaves audit trail", last["status"] == "cancelled" and any("留痕" in t["text"] for t in last["timeline"]))

    # ---------- Regulator: metrics + queue history ----------
    page.click("#logout-btn"); page.wait_for_selector("#login-form")
    page.click(".role-option[data-role='regulator']")
    page.fill("#login-account", "admin"); page.fill("#login-password", password_for("regulator"))
    page.click("#login-form button[type=submit]")
    page.wait_for_selector(".sos-metrics", timeout=8000)
    metrics = page.locator(".sos-metrics").first.inner_text()
    check("regulator response-time metrics", "平均接单" in metrics and "秒" in metrics, metrics.replace("\n", " ")[:70])
    page.click("[data-page='events']")
    page.wait_for_selector(".sos-queue-panel")
    check("regulator events page SOS panel + history", page.locator(".sos-recent-row").count() >= 2)

    # server-side persistence of the whole run
    import urllib.request, json as _json
    db = _json.load(urllib.request.urlopen(BASE + "api/status"))["database"]["counts"]
    check("SQLite persisted all sessions", db["sos_sessions"]["count"] >= 4, f"rows={db['sos_sessions']['count']}")

    js_errors = [e for e in errors if "favicon" not in e and "lucide" not in e.lower()]
    check("no JS errors during full run", not js_errors, "; ".join(js_errors[:2]))

    browser.close()

fails = [r for r in results if not r[1]]
print(f"\n===== {len(results)-len(fails)}/{len(results)} PASSED =====")
if fails:
    raise SystemExit(1)
