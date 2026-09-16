import time, threading, http.server, socketserver, os, sys
from playwright.sync_api import sync_playwright

EDGE = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
PORT = 8731
ROOT = os.path.dirname(os.path.abspath(__file__))

# 起一个本地静态服务器提供 harness + ve-core.js
handler = http.server.SimpleHTTPRequestHandler
httpd = socketserver.TCPServer(("127.0.0.1", PORT), handler)
httpd.timeout = 1
t = threading.Thread(target=httpd.serve_forever, daemon=True)
t.start()
URL = f"http://127.0.0.1:{PORT}/test-harness.html"

errors = []
with sync_playwright() as p:
    b = p.chromium.launch(executable_path=EDGE, args=["--no-sandbox"])
    pg = b.new_page(viewport={"width": 1440, "height": 900})
    pg.on("pageerror", lambda e: errors.append(str(e)))

    pg.goto(URL, wait_until="domcontentloaded")
    pg.wait_for_selector("#btn1")
    pg.wait_for_function("() => document.querySelector('#btn1') && document.querySelector('#btn1').getAttribute('data-ve-id')")
    print("[1] 初始: btn1 id =", pg.evaluate("() => document.querySelector('#btn1').getAttribute('data-ve-id')"))

    # 开启微调
    pg.wait_for_selector("[data-ve-toggle]")
    pg.click("[data-ve-toggle]"); time.sleep(0.3)
    print("[2] 微调开关点击, engineOn =", pg.evaluate("() => window.VisualEditKit.isOn()"))

    # 选中 btn1（点坐标，引擎开启时 click 即拾取）
    box = pg.evaluate("""() => { const e=document.querySelector('#btn1'); const r=e.getBoundingClientRect(); return {x:r.x+r.width/2, y:r.y+r.height/2}; }""")
    pg.mouse.click(box["x"], box["y"]); time.sleep(0.4)
    print("[3] 选中 btn1, 面板可见 =", pg.evaluate("() => window.VisualEditKit.panelVisible()"),
          "| active =", pg.evaluate("() => { const a=window.VisualEditKit.getActive(); return a?a.tagName+'#'+a.id:null }"))

    # 通过面板背景色输入框改红色（真实代码路径：upsert -> persist -> renderAll）
    pg.wait_for_selector("[data-ve-bg]")
    pg.evaluate("""() => { const i=document.querySelector('[data-ve-bg]'); i.value='#ff0000'; i.dispatchEvent(new Event('input',{bubbles:true})); }""")
    time.sleep(0.3)

    bg_before = pg.evaluate("() => getComputedStyle(document.querySelector('#btn1')).backgroundColor")
    ls_before = pg.evaluate("() => localStorage.getItem('ve_plan::/test-harness')")
    print("[4] 改色后 btn1 背景 =", bg_before)
    print("[4] localStorage 方案 =", (ls_before or 'null'))

    # 关键：刷新页面（模拟用户“重新刷新页面”）
    pg.reload(wait_until="domcontentloaded")
    pg.wait_for_selector("#btn1")
    pg.wait_for_function("() => document.querySelector('#btn1') && document.querySelector('#btn1').getAttribute('data-ve-id')")
    bg_after = pg.evaluate("() => getComputedStyle(document.querySelector('#btn1')).backgroundColor")
    id_after = pg.evaluate("() => document.querySelector('#btn1').getAttribute('data-ve-id')")
    print("[5] 刷新后 btn1 背景 =", bg_after, "| id =", id_after)

    ok = (bg_before.strip() == "rgb(255, 0, 0)") and (bg_after.strip() == "rgb(255, 0, 0)")
    print("[RESULT]", "PASS ✅ 改动在刷新后保留" if ok else "FAIL ❌ 刷新后丢失")
    print("PAGE_ERRORS:", errors)
    b.close()

httpd.shutdown()
sys.exit(0 if ok else 1)
