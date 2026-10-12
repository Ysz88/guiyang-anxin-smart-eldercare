"""页面巡检：三端每个页面在电脑和手机宽度下各打开一遍，并打开常用的只读弹窗。

检查：控制台报错、页面横向溢出、主区域空白、界面上漏出 undefined / NaN / [object Object] / Invalid Date、图片加载失败。
只点查看类按钮（详情、审计、表单弹窗打开后直接关闭），不提交、不改数据。
"""
import os
import re
import time

from playwright.sync_api import sync_playwright

from e2e_auth import password_for, reset_demo

BASE = os.environ.get("GY_BASE", "http://127.0.0.1:4173/")
ACCOUNTS = {"elder": "elder", "provider": "center", "regulator": "admin"}
PAGES = {
    "elder": ["dashboard", "profile", "check", "requests"],
    "provider": ["dashboard", "care", "residents", "services", "devices", "alerts"],
    "regulator": ["dashboard", "radar", "advisor", "insight", "care", "monitoring", "movements", "institutions", "events"],
}
# 只打开、不提交的弹窗
VIEW_ACTIONS = ["event-detail", "institution-detail", "movement-detail", "resident-detail", "sos-detail", "view-audit", "demo-guide",
                "edit-profile", "movement-report", "register-resident", "record-service", "weather-publish", "ai-video"]
VIEWPORTS = {"desktop": {"width": 1440, "height": 900}, "phone": {"width": 390, "height": 844}}
LEAK = re.compile(r"\bundefined\b|\bNaN\b|\[object Object\]|Invalid Date|\bnull\b")

results = []


def check(name, condition, detail=""):
    results.append((name, bool(condition), detail))
    print(("PASS" if condition else "FAIL"), "-", name, ("· " + detail if detail else ""))


# 找出真正撑宽页面的元素（祖先没有裁切的）
OVERFLOW_JS = """() => {
  const vw = document.documentElement.clientWidth;
  if (document.documentElement.scrollWidth <= vw + 1) return [];
  const clipped = (el) => { for (let p = el.parentElement; p; p = p.parentElement) { const s = getComputedStyle(p); if (/(hidden|auto|scroll|clip)/.test(s.overflowX)) return p !== document.body && p !== document.documentElement; } return false; };
  const out = [];
  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect();
    if (r.width && r.right > vw + 1 && !clipped(el)) {
      out.push((el.id ? '#' + el.id : el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.') : '')) + ' → ' + Math.round(r.right) + 'px');
      if (out.length >= 4) break;
    }
  }
  return out;
}"""

TEXT_JS = """(root) => {
  const el = root ? document.querySelector(root) : document.getElementById('main-content');
  if (!el) return '';
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const parts = [];
  while (walker.nextNode()) { const node = walker.currentNode; const p = node.parentElement; if (p && p.offsetParent !== null && !['SCRIPT', 'STYLE'].includes(p.tagName)) parts.push(node.textContent); }
  return parts.join(' ');
}"""


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


def goto_page(page, name):
    page.evaluate("(name) => { const b = document.querySelector(`[data-page='${name}']`); if (b) b.click(); return !!b; }", name)
    time.sleep(0.7)


def leaks(text):
    return sorted({m.group(0) for m in LEAK.finditer(text)})


def close_modal(page):
    page.evaluate("document.querySelector('[data-action=close-modal]')?.click()")
    time.sleep(0.3)
    if page.locator(".modal-layer").count():
        page.keyboard.press("Escape")
        time.sleep(0.3)


reset_demo()
with sync_playwright() as p:
    browser = p.chromium.launch()
    for vp_name, viewport in VIEWPORTS.items():
        ctx = browser.new_context(viewport=viewport, locale="zh-CN", is_mobile=vp_name == "phone", has_touch=vp_name == "phone")
        page = ctx.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        for role, pages in PAGES.items():
            login(page, role)
            opened = set()
            for name in pages:
                errors.clear()
                goto_page(page, name)
                tag = f"{vp_name} {role}/{name}"
                text = page.evaluate(TEXT_JS, None)
                check(f"{tag} 有内容", len(text.strip()) > 40, f"{len(text.strip())} 字")
                check(f"{tag} 无横向溢出", not (bad := page.evaluate(OVERFLOW_JS)), "；".join(bad))
                check(f"{tag} 无漏出的占位值", not (found := leaks(text)), "、".join(found))
                broken = page.evaluate("[...document.querySelectorAll('#main-content img')].filter(i => i.complete && !i.naturalWidth).map(i => i.getAttribute('src'))")
                check(f"{tag} 图片正常", not broken, "、".join(broken))
                for action in VIEW_ACTIONS:
                    if action in opened:
                        continue
                    if not page.evaluate("(a) => { const b = [...document.querySelectorAll(`#main-content [data-action='${a}'], .topbar-actions [data-action='${a}']`)].find(x => !x.disabled); if (b) b.click(); return !!b; }", action):
                        continue
                    opened.add(action)
                    time.sleep(0.8)
                    mtag = f"{tag} 弹窗 {action}"
                    if not page.locator(".modal").count():
                        check(f"{mtag} 能打开", False, "点击后没有弹窗")
                        continue
                    mtext = page.evaluate(TEXT_JS, ".modal")
                    check(f"{mtag} 无漏出的占位值", not (found := leaks(mtext)), "、".join(found))
                    check(f"{mtag} 无横向溢出", not (bad := page.evaluate(OVERFLOW_JS)), "；".join(bad))
                    close_modal(page)
                check(f"{tag} 控制台无报错", not errors, " | ".join(errors[:3]))
        ctx.close()
    browser.close()

failed = [r for r in results if not r[1]]
print(f"\n{len(results) - len(failed)}/{len(results)} 通过")
raise SystemExit(1 if failed else 0)
