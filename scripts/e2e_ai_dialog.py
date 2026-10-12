"""老人端“和小桂说说话”：闲聊只回一句话、每句回复都能“听一遍”、有具体事情才出建议卡。

无头浏览器没有中文语音，这里换成假的朗读接口，只记录念了什么。
没配置大模型时走本地规则智能体，建议卡同样会出现。
"""
import os
import time

from playwright.sync_api import sync_playwright

from e2e_auth import password_for, reset_demo

BASE = os.environ.get("GY_BASE", "http://127.0.0.1:4173/")
FAKE_TTS = """
window.__spoken = [];
window.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
const synth = window.speechSynthesis;
synth.getVoices = () => [{ lang: 'zh-CN', name: 'fake-zh' }];
synth.speak = (u) => { window.__spoken.push(u.text); synth.__cur = u; setTimeout(() => { if (synth.__cur === u && u.onend) u.onend(); }, 4000); };
synth.cancel = () => { const u = synth.__cur; synth.__cur = null; if (u && u.onend) u.onend(); };
"""
results = []


def check(name, condition, detail=""):
    results.append((name, bool(condition), detail))
    print(("PASS" if condition else "FAIL"), "-", name, ("· " + detail if detail else ""))


def send(page, text):
    page.fill("#ai-dialog-input", text)
    page.click("#ai-send-btn")
    page.wait_for_function("!document.getElementById('ai-typing') && !document.getElementById('ai-send-btn').disabled", timeout=60000)
    time.sleep(0.6)


reset_demo()
with sync_playwright() as p:
    browser = p.chromium.launch()
    ctx = browser.new_context(viewport={"width": 1360, "height": 900}, locale="zh-CN")
    ctx.add_init_script(FAKE_TTS)
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(BASE)
    page.evaluate("localStorage.clear(); sessionStorage.clear();")
    page.goto(BASE)
    page.click(".role-option[data-role='elder']")
    page.fill("#login-account", "elder")
    page.fill("#login-password", password_for("elder"))
    page.click("#login-form button[type=submit]")
    page.wait_for_selector(".sos-band", timeout=8000)

    page.click(".assistant-talk[data-action='ai-video']")
    page.wait_for_selector("#ai-chat-log .chat-bubble.assistant")
    check("opening line has a read-aloud button", page.locator("#ai-chat-log .chat-bubble.assistant [data-action='ai-speak']").first.is_visible())
    check("common questions shown inside the conversation", page.locator("#ai-chat-log .ai-suggestions button").count() >= 3)
    check("composer visible without scrolling", page.locator("#ai-send-btn").is_visible() and page.evaluate("document.getElementById('ai-send-btn').getBoundingClientRect().bottom <= innerHeight"))

    send(page, "你好")
    check("greeting gets one bubble, no advice card", page.locator("#ai-result-area").count() == 0)
    check("common questions tucked away after first message", page.locator("#ai-chat-log .ai-suggestions").count() == 0)
    last = page.locator("#ai-chat-log .chat-bubble.assistant").last
    check("greeting reply is read aloud automatically", page.evaluate("window.__spoken.length") >= 1 and last.locator("[data-action='ai-speak']").inner_text().strip() == "停止")

    send(page, "有个养生基地让我今天交一万块定金")
    page.wait_for_selector("#ai-result-area", timeout=60000)
    time.sleep(1)
    info = page.evaluate("""() => {
      const area = document.getElementById('ai-result-area');
      const bubble = area.previousElementSibling;
      const log = document.getElementById('ai-chat-log');
      return {
        afterBubble: !!bubble && bubble.classList.contains('chat-bubble') && bubble.classList.contains('assistant'),
        inLog: area.parentElement === log,
        summaryNotRepeated: (() => { const body = area.cloneNode(true); body.querySelector('.agent-trace')?.remove(); return !body.textContent.includes(bubble.querySelector('p').innerText.slice(0, 12)); })(),
        speakOnBubble: !!bubble.querySelector('[data-action=ai-speak]') && !bubble.querySelector('[data-action=ai-speak]').hidden,
        bubbleTopVisible: bubble.getBoundingClientRect().top >= log.getBoundingClientRect().top - 2,
        hasSteps: area.querySelectorAll('.ai-steps li').length > 0,
        hasPhone: area.innerText.includes('联系电话'),
        speech: bubble.dataset.speech || ''
      };
    }""")
    check("advice card follows the reply bubble inside the conversation", info["afterBubble"] and info["inLog"])
    check("card does not repeat the first sentence", info["summaryNotRepeated"])
    check("read-aloud button sits on the reply bubble", info["speakOnBubble"])
    check("reply scrolled to its first line", info["bubbleTopVisible"])
    check("card lists what to do first and a phone", info["hasSteps"] and info["hasPhone"])
    check("read-aloud covers the steps too", "现在先做" in info["speech"])

    first = page.locator("#ai-chat-log .chat-bubble.assistant").first.locator("[data-action='ai-speak']")
    first.click()
    time.sleep(0.2)
    on = first.inner_text().strip()
    first.click()
    time.sleep(0.2)
    check("tap to hear again, tap again to stop", on == "停止" and first.inner_text().strip() == "听一遍", f"{on} -> {first.inner_text().strip()}")

    send(page, "谢谢")
    check("thanks keeps the earlier card and adds one bubble", page.locator("#ai-result-area").count() == 1 and "不客气" in page.locator("#ai-chat-log .chat-bubble.assistant p").last.inner_text())

    page.click(".va-controls [data-action='speech-toggle']")
    check("auto read-aloud can be switched off in the dialog", "关" in page.locator(".va-controls [data-action='speech-toggle']").inner_text())
    page.click(".va-controls [data-action='speech-toggle']")
    check("no page errors", not errors, " | ".join(errors[:3]))
    browser.close()

failed = [r for r in results if not r[1]]
print(f"\n===== {len(results) - len(failed)}/{len(results)} PASSED =====" if not failed else f"\n===== {len(failed)} FAILED =====")
raise SystemExit(1 if failed else 0)
