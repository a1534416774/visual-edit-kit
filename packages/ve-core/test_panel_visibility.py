import sys, time
from playwright.sync_api import sync_playwright

EDGE = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
PAGES = {
    "harness": "file:///D:/Workbuddy/Claw/visual-edit-kit/packages/ve-core/test-harness.html",
    "saaslike": "file:///D:/Workbuddy/Claw/visual-edit-kit/packages/ve-core/test-repro-saas.html",
}
errors, results = [], []

def check(name, cond):
    results.append((name, bool(cond)))
    print(("  PASS  " if cond else "  FAIL  ") + name)

def panel(page):
    return page.evaluate("""() => {
      const c = document.querySelector('[data-ve-changes]');
      const p = c ? c.closest('[data-ve-ui]') : null;
      if (!p) return { shown: false, why: 'no panel element' };
      const r = p.getBoundingClientRect();
      const visible = Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0));
      return { display: getComputedStyle(p).display, top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height),
               visiblePx: Math.round(visible),
               fullyInViewport: r.top >= -1 && r.bottom <= innerHeight + 1 && r.left >= -1 && r.right <= innerWidth + 1,
               shown: getComputedStyle(p).display !== 'none' && visible > 60 };
    }""")

def act(page):
    return page.evaluate("() => { const a = VisualEditKit.getActive(); return a ? (a.id || a.className || a.tagName) : null; }")

def inside(page, sel):
    return page.evaluate("(s) => { const a = VisualEditKit.getActive(); const t = document.querySelector(s); return !!(a && t && (t === a || t.contains(a))); }", sel)

def mclick(page, selector):
    page.evaluate("(s) => { const e=document.querySelector(s); if (e && e.scrollIntoView) e.scrollIntoView({block:'center'}); }", selector)
    time.sleep(0.25)
    r = page.evaluate("(sel) => { const e=document.querySelector(sel); const b=e.getBoundingClientRect(); return {x:b.x+b.width/2,y:b.y+b.height/2}; }", selector)
    page.mouse.click(r["x"], r["y"]); time.sleep(0.5)

def run(page, url, label):
    print(f"=== {label} ===")
    page.goto(url)
    page.wait_for_selector("button[data-ve-ui]", timeout=8000)
    page.click("button[data-ve-ui]"); time.sleep(0.4)

    mclick(page, "#card1")
    s = panel(page)
    check(f"{label}:选中后面板出现", s.get("shown"))
    check(f"{label}:选中落在 card1 内", inside(page, "#card1"))

    # 拖拽移动
    b = page.evaluate("() => { const h=document.querySelector('[data-ve-move]'); const r=h.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; }")
    page.mouse.move(b["x"], b["y"]); page.mouse.down()
    page.mouse.move(b["x"] + 40, b["y"] + 50, steps=8); page.mouse.up(); time.sleep(0.4)
    s = panel(page)
    check(f"{label}:拖拽移动后面板仍在", s.get("shown"))

    # 右下角缩放
    h = page.evaluate("() => { const h=document.querySelector('[data-ve-resize=\"se\"]'); const r=h.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; }")
    page.mouse.move(h["x"], h["y"]); page.mouse.down()
    page.mouse.move(h["x"] + 60, h["y"] + 40, steps=8); page.mouse.up(); time.sleep(0.4)
    s = panel(page)
    check(f"{label}:缩放后面板仍在", s.get("shown"))
    check(f"{label}:面板完整在视口内", s.get("fullyInViewport"))
    check(f"{label}:缩放后选中仍在 card1 内", inside(page, "#card1"))

    # 穿透点选：在绿框内、面板之外的空白处点一下 -> 应命中绿框下方真正被盖住的元素
    probe = page.evaluate("""() => {
      const ov = document.querySelector('[data-ve-overlay]');
      const r = ov.getBoundingClientRect();
      const PICK = 'button,a,.card,h1,h2,h3,h4,h5,h6,p,label,th,td,li,span,div,section,article,header,footer,nav,main';
      const xs = [0.75, 0.6, 0.5, 0.9, 0.35, 0.2], ys = [0.5, 0.7, 0.3, 0.8];
      for (const fy of ys) for (const fx of xs) {
        const x = Math.round(r.left + r.width * fx), y = Math.round(r.top + r.height * fy);
        if (x < 5 || y < 5 || x > innerWidth - 5 || y > innerHeight - 5) continue;
        const top = document.elementFromPoint(x, y);
        if (!top || !top.hasAttribute || !top.hasAttribute('data-ve-move')) continue;  // 必须能点到绿框（而非面板）
        const stack = document.elementsFromPoint(x, y);
        for (const n of stack) {
          if (n.closest && n.closest('[data-ve-ui]')) continue;
          const pick = n.closest(PICK);
          if (pick) { window.__probeEl = pick; return { x: x, y: y, tag: pick.tagName, id: pick.id || null }; }
        }
      }
      window.__probeEl = null; return null;
    }""")
    print("   probe point:", probe)
    if probe:
        page.mouse.click(probe["x"], probe["y"]); time.sleep(0.5)
        hit = page.evaluate("() => VisualEditKit.getActive() === window.__probeEl")
        s = panel(page)
        print(f"   after click-through: active={act(page)} hitExpected={hit}")
        check(f"{label}:绿框穿透点选到被盖住的元素", hit and s.get("shown"))
    else:
        check(f"{label}:绿框穿透点选到被盖住的元素", False)

    # ★核心回归：关闭面板后再点另一个元素，面板必须回来
    page.evaluate("() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); }")
    page.keyboard.press("Escape"); time.sleep(0.3)
    check(f"{label}:Esc 后面板隐藏", not panel(page).get("shown"))
    mclick(page, "#card2")
    s = panel(page)
    print("   after re-pick card2:", s, "active=", act(page))
    check(f"{label}:★关闭后再次点选面板恢复", s.get("shown") and inside(page, "#card2"))

    # ★开关：面板隐藏时点开关应"找回面板"，而不是把模式关掉；面板可见时才是关模式
    page.evaluate("() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); }")
    page.keyboard.press("Escape"); time.sleep(0.3)
    page.click("button[data-ve-ui]"); time.sleep(0.5)   # 面板隐藏 -> 找回
    check(f"{label}:★面板隐藏时点开关=找回面板", panel(page).get("shown") and page.evaluate("() => window.VisualEditKit.isOn()"))
    page.click("button[data-ve-ui]"); time.sleep(0.4)   # 面板可见 -> 关模式
    check(f"{label}:面板可见时点开关=关模式", (not page.evaluate("() => window.VisualEditKit.isOn()")) and not panel(page).get("shown"))
    page.click("button[data-ve-ui]"); time.sleep(0.5)   # 再开 -> 恢复上次选中
    check(f"{label}:★开关重开后恢复上次选中", page.evaluate("() => window.VisualEditKit.isOn()") and panel(page).get("shown"))

    # 内部容器滚动后选底部元素 -> 面板仍完整可见
    page.evaluate("() => { const c=document.getElementById('content') || document.scrollingElement; c.scrollTop = c.scrollHeight; }")
    time.sleep(0.3)
    mclick(page, "#card2")
    s = panel(page)
    print("   after scroll+pick bottom card2:", s)
    check(f"{label}:滚动后面板完整可见", s.get("shown") and s.get("fullyInViewport"))

    try:
        ok = page.evaluate("3*3") == 9
    except Exception as e:
        ok = False; errors.append("freeze: " + str(e))
    check(f"{label}:无卡死", ok)
    print()

with sync_playwright() as p:
    br = p.chromium.launch(executable_path=EDGE, args=["--no-sandbox"])
    page = br.new_page(viewport={"width": 1100, "height": 700})
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("dialog", lambda d: d.accept("方案A"))
    run(page, PAGES["harness"], "HARNESS")
    run(page, PAGES["saaslike"], "SAASLIKE")
    print("PAGE_ERRORS:", errors)
    br.close()

failed = [n for n, ok in results if not ok]
print("TOTAL:", len(results), "FAILED:", failed)
allok = not failed and not errors
print("ALL_OK:", allok)
sys.exit(0 if allok else 1)
