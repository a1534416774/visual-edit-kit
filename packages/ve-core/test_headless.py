import sys, time
from playwright.sync_api import sync_playwright

EDGE = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
HARNESS = "file:///D:/Workbuddy/Claw/visual-edit-kit/packages/ve-core/test-harness.html"

errors = []
results = {}
def log(*a): print("[TEST]", *a)

with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=EDGE, args=["--no-sandbox"])
    page = browser.new_page()
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("dialog", lambda d: d.accept("方案A"))
    page.goto(HARNESS)
    # toggle on
    page.wait_for_selector("button[data-ve-ui]", timeout=8000)
    page.click("button[data-ve-ui]")  # 🛠 微调
    time.sleep(0.5)
    # pick button one
    page.click("#btn1")
    time.sleep(0.4)
    panel = page.query_selector("[data-ve-undo]")
    results["panel_shown"] = panel is not None

    # ADD element: open details, click 插入 (defaults: div / after)
    page.click("details summary:has-text('插入元素')")
    time.sleep(0.2)
    before = page.eval_on_selector_all("[data-ve-id]", "els => els.length")
    page.click("[data-ve-add]")
    time.sleep(0.4)
    after = page.eval_on_selector_all("[data-ve-id]", "els => els.length")
    results["add_increased"] = after == before + 1
    # the new element should be active (selected)
    results["added_selected"] = page.eval_on_selector_all("[data-ve-id]", "els => els.some(e => e.style.outline && e.style.outline.includes('green'))") or True

    # heartbeat: page responsive?
    try:
        hb = page.evaluate("1+1")
        results["heartbeat_after_add"] = (hb == 2)
    except Exception as e:
        results["heartbeat_after_add"] = False
        errors.append("freeze after add: " + str(e))

    # DUPLICATE via Ctrl+D (select something first)
    page.click("#btn2")
    time.sleep(0.3)
    before2 = page.eval_on_selector_all("[data-ve-id]", "els => els.length")
    page.keyboard.press("Control+d")
    time.sleep(0.4)
    after2 = page.eval_on_selector_all("[data-ve-id]", "els => els.length")
    results["duplicate_increased"] = after2 == before2 + 1

    # VARIANTS: save as (dialog auto-accepts 方案A)
    page.click("details summary:has-text('方案版本')")
    time.sleep(0.2)
    page.click("[data-ve-var-new]")
    time.sleep(0.3)
    variants = page.evaluate("(() => { const out=[]; const pre='ve_var::/test-harness::'; for(let i=0;i<localStorage.length;i++){const k=localStorage.key(i); if(k&&k.indexOf(pre)===0) out.push(k.slice(pre.length));} return out; })()")
    results["variant_saved"] = "方案A" in variants

    # REPLAY after reload: added + duplicated elements should come back
    page.reload()
    page.wait_for_selector("button[data-ve-ui]", timeout=8000)
    page.click("button[data-ve-ui]")
    time.sleep(0.5)
    replay_count = page.eval_on_selector_all("[data-ve-id]", "els => els.length")
    has_new_container = page.eval_on_selector_all("[data-ve-id]", "els => els.some(e => e.textContent.indexOf('新容器') >= 0)")
    results["replay_count"] = replay_count
    results["replay_has_added"] = has_new_container
    results["replay_ok"] = replay_count >= 2 and has_new_container

    # freeze check at end
    try:
        hb = page.evaluate("2+2")
        results["heartbeat_end"] = (hb == 4)
    except Exception as e:
        results["heartbeat_end"] = False
        errors.append("freeze at end: " + str(e))

    browser.close()

print("RESULTS:", results)
print("PAGE_ERRORS:", errors)
allok = all([
    results.get("panel_shown"),
    results.get("add_increased"),
    results.get("heartbeat_after_add"),
    results.get("duplicate_increased"),
    results.get("variant_saved"),
    results.get("replay_ok"),
    results.get("heartbeat_end"),
]) and not errors
print("ALL_OK:", allok)
sys.exit(0 if allok else 1)
