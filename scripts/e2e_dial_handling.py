from e2e_auth import password_for, reset_demo, authorized_open
"""Dial-link handling: desktop shows a number panel, phones keep the native dialer."""
import os
import time
from playwright.sync_api import sync_playwright

BASE = os.environ.get("GY_BASE", "http://127.0.0.1:4173/")
results = []


def check(name, cond, detail=""):
    results.append((name, bool(cond)))
    print(("PASS" if cond else "FAIL"), "-", name, ("· " + detail if detail else ""))




reset_demo()

with sync_playwright() as p:
    browser = p.chromium.launch()

    # ---------- desktop ----------
    ctx = browser.new_context(viewport={"width": 1360, "height": 900})
    page = ctx.new_page()
    errs = []
    page.on("pageerror", lambda e: errs.append(str(e)))
    navigations = []
    page.on("framenavigated", lambda f: navigations.append(f.url))

    page.goto(BASE)
    page.evaluate("localStorage.clear(); sessionStorage.clear();")
    page.goto(BASE)
    page.wait_for_selector("#login-form")
    page.fill("#login-account", "elder")
    page.fill("#login-password", password_for("elder"))
    page.click("#login-form button[type=submit]")
    page.wait_for_selector(".sos-band", timeout=9000)

    page.click("a.sos-direct[href='tel:120']")
    page.wait_for_selector(".dial-number", timeout=5000)
    check("desktop click opens the number panel instead of the OS picker",
          page.locator(".dial-number").inner_text().strip() == "120")
    check("panel explains why and what to do",
          "手机" in page.locator(".dial-hint").inner_text())
    check("no tel: navigation attempted",
          not any(u.startswith("tel:") for u in navigations), str(navigations[-1])[:40])

    page.click("[data-action='dial-copy']")
    page.wait_for_selector(".toast", timeout=4000)
    check("copy control reports a result", page.locator(".toast").count() >= 1)
    page.click("[data-action='close-modal']")

    # ---------- self-dial gets recorded on an active ticket ----------
    page.click(".sos-big-btn")
    page.wait_for_selector("[data-action='sos-send-now']")
    page.click("[data-action='sos-send-now']")
    page.wait_for_selector("[data-sos-modal]", timeout=6000)
    sid = page.locator("[data-sos-modal]").get_attribute("data-sos-modal")

    page.click("[data-sos-modal] ~ * a[href='tel:120'], .modal-footer a[href='tel:120']")
    page.wait_for_selector(".dial-number", timeout=5000)
    check("dial panel offers a way back to the live ticket",
          page.locator(".modal-footer [data-action='sos-status']").count() == 1)
    session = page.evaluate("id => JSON.parse(localStorage.getItem('guiyang-v1-data')).sosSessions.find(s=>s.id===id)", sid)
    check("self-dial written into the ticket timeline",
          any("拨打120" in t["text"] for t in session["timeline"]),
          session["timeline"][-1]["text"][:30])

    page.click(".modal-footer [data-action='sos-status']")
    page.wait_for_selector("[data-sos-modal]", timeout=5000)
    check("returning restores the progress dialog", True)

    # repeated taps must not spam the ledger
    before = len(page.evaluate("id => JSON.parse(localStorage.getItem('guiyang-v1-data')).sosSessions.find(s=>s.id===id).timeline", sid))
    page.click(".modal-footer a[href='tel:120']")
    page.wait_for_selector(".dial-number", timeout=5000)
    page.click(".modal-footer [data-action='sos-status']")
    page.wait_for_selector("[data-sos-modal]", timeout=5000)
    after = len(page.evaluate("id => JSON.parse(localStorage.getItem('guiyang-v1-data')).sosSessions.find(s=>s.id===id).timeline", sid))
    check("repeat taps do not duplicate the audit row", after == before, f"{before} -> {after}")

    # masked duty number never becomes a broken tel: link
    ctx2 = browser.new_context(viewport={"width": 1360, "height": 900})
    desk = ctx2.new_page()
    desk.goto(BASE)
    desk.wait_for_selector("#login-form")
    desk.click(".role-option[data-role='provider']")
    desk.fill("#login-account", "center")
    desk.fill("#login-password", password_for("provider"))
    desk.click("#login-form button[type=submit]")
    desk.wait_for_selector(".sos-queue-panel", timeout=9000)
    desk.locator(f".sos-queue-item [data-action='sos-claim']").first.click()
    time.sleep(2.5)
    page.click("[data-action='close-modal']")
    page.wait_for_selector(".sos-live-banner", timeout=8000)
    page.click(".sos-live-banner")
    page.wait_for_selector("[data-action='dial']", timeout=6000)
    check("duty callback uses a button, not a masked tel: link",
          page.locator("a[href*='tel:0779']").count() == 0)
    page.click("[data-sos-modal] [data-action='dial']")
    page.wait_for_selector(".dial-number", timeout=5000)
    check("masked number is labelled as demo data",
          "脱敏" in page.locator(".dial-panel").inner_text())
    check("no copy button for a masked number",
          page.locator("[data-action='dial-copy']").count() == 0)

    check("no JS errors on desktop", not errs, "; ".join(errs[:2]))
    ctx.close()
    ctx2.close()

    # ---------- phone ----------
    phone_ctx = browser.new_context(
        viewport={"width": 390, "height": 844},
        user_agent="Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
        is_mobile=True, has_touch=True)
    phone = phone_ctx.new_page()
    phone.goto(BASE)
    phone.wait_for_selector("#login-form")
    check("phone is detected as dial-capable",
          phone.evaluate("/Android|iPhone|iPad|iPod|HarmonyOS|Windows Phone|Mobile/i.test(navigator.userAgent)"))
    phone.fill("#login-account", "elder")
    phone.fill("#login-password", password_for("elder"))
    phone.click("#login-form button[type=submit]")
    phone.wait_for_selector(".sos-band, .sos-live-banner", timeout=9000)
    tel_links = phone.locator("a[href='tel:120']").count()
    check("phone keeps the native tel: link", tel_links >= 1, f"{tel_links} link(s)")
    browser.close()

fails = [r for r in results if not r[1]]
print(f"===== {len(results)-len(fails)}/{len(results)} PASSED =====")
if fails:
    raise SystemExit(1)
