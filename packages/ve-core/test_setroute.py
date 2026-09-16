"""setRoute 回归：方案按路由分别存储/还原，切换不重复挂载 UI。

用本机 Edge（playwright-core + msedge），不依赖联网。
"""
import time, os
from playwright.sync_api import sync_playwright

EDGE = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
CORE = r"D:\Workbuddy\Claw\visual-edit-kit\packages\ve-core\ve-core.js"
BASE = "http://127.0.0.1:8731/test_setroute.html"

SEED = ('{"route":"page1","changes":[{"id":"ve-1","path":"#box","kind":"style",'
        '"prop":"background","value":"rgb(255,0,0)","fp":"div"}]}')

fails = []
def check(name, cond):
    print(("  PASS " if cond else "  FAIL ") + name)
    if not cond: fails.append(name)

with sync_playwright() as p:
    b = p.chromium.launch(executable_path=EDGE, args=["--no-sandbox"])
    pg = b.new_page(viewport={"width": 1200, "height": 800})
    errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)))

    pg.goto(BASE)
    pg.wait_for_timeout(150)
    with open(CORE, "r", encoding="utf-8") as f:
        core_js = f.read()
    pg.add_script_tag(content=core_js)
    pg.wait_for_timeout(250)

    # 1) 事先把 page1 的方案种进 localStorage，再 init（模拟"上次在 page1 改过"）
    pg.evaluate("localStorage.setItem('ve_plan::page1', %s)" % repr(SEED))
    pg.evaluate("window.VisualEditKit.init({route:'page1', autoFetch:false})")
    pg.wait_for_timeout(250)

    bg_on_p1 = pg.evaluate("getComputedStyle(document.getElementById('box')).backgroundColor")
    plan_p1 = pg.evaluate("window.VisualEditKit.getPlan()")
    check("init(page1) 后方案含 1 条改动", plan_p1.get("changes", []) and len(plan_p1["changes"]) == 1)
    check("init(page1) 后 #box 背景变红 (rgb(255, 0, 0))", bg_on_p1 == "rgb(255, 0, 0)")

    # 2) 切换到 page2：应清空当前可视改动、方案变为 page2（空），且不重复挂 UI
    pg.evaluate("window.VisualEditKit.setRoute('page2')")
    pg.wait_for_timeout(250)
    bg_p2 = pg.evaluate("getComputedStyle(document.getElementById('box')).backgroundColor")
    plan_p2 = pg.evaluate("window.VisualEditKit.getPlan()")
    toggle_cnt = pg.evaluate("document.querySelectorAll('[data-ve-toggle]').length")
    ls_p1 = pg.evaluate("JSON.parse(localStorage.getItem('ve_plan::page1')||'{}')")
    check("setRoute(page2) 后 #box 背景恢复默认 (非红)", bg_p2 != "rgb(255, 0, 0)")
    check("setRoute(page2) 后当前方案 route=page2 且为空", plan_p2.get("route") == "page2" and not plan_p2.get("changes"))
    check("切换后不重复挂载开关（toggle 数量=1）", toggle_cnt == 1)
    check("page1 的方案在 localStorage 仍保留（未丢失）", ls_p1.get("changes") and len(ls_p1["changes"]) == 1)

    # 3) 切回 page1：方案应重新加载并还原改动
    pg.evaluate("window.VisualEditKit.setRoute('page1')")
    pg.wait_for_timeout(250)
    bg_back = pg.evaluate("getComputedStyle(document.getElementById('box')).backgroundColor")
    plan_back = pg.evaluate("window.VisualEditKit.getPlan()")
    check("切回 page1 后 #box 再次变红", bg_back == "rgb(255, 0, 0)")
    check("切回 page1 后方案含 1 条改动", plan_back.get("changes") and len(plan_back["changes"]) == 1)

    check("无 pageerror（无卡死/异常）", not errs)
    if errs: print("PAGE_ERRORS:", errs)

    b.close()

print("\n[RESULT]", "ALL_PASS ✅" if not fails else f"{len(fails)} FAILED: {fails}")
