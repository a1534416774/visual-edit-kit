import time, sys
from playwright.sync_api import sync_playwright

EDGE = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
URL = "http://127.0.0.1:5122/"
errors = []

with sync_playwright() as p:
    b = p.chromium.launch(executable_path=EDGE, args=["--no-sandbox"])
    pg = b.new_page(viewport={"width": 1440, "height": 900})
    pg.on("pageerror", lambda e: errors.append(str(e)))
    pg.goto(URL, wait_until="domcontentloaded")
    time.sleep(6)
    print("BODY:", (pg.evaluate("() => document.body ? document.body.innerText.slice(0,300) : 'NO BODY'") or '').replace(chr(10), ' | '))
    print("HTMLHEAD:", pg.content()[:400].replace(chr(10), ' '))
    print("url:", pg.url, "| title:", pg.title())
    print("has toggle:", pg.evaluate("() => !!document.querySelector('[data-ve-toggle]')"))
    # vendor 是否为新版（含 showPanel / hitTest）
    print("core new?", pg.evaluate("() => document.querySelector('script[src*=\"ve-core\"]') ? true : 'no script tag'"))
    print("core api:", pg.evaluate("() => (window.VisualEditKit ? Object.keys(window.VisualEditKit).join(',') : 'not loaded')"))

    if pg.evaluate("() => !!document.querySelector('[data-ve-toggle]')"):
        pg.click("[data-ve-toggle]"); time.sleep(0.4)
        # 点页面上的第一个可点元素（登录页/项目页都行）
        r = pg.evaluate("""() => {
          const cands = ['h1','h2','button','a','.card','input','div'];
          for (const sel of cands) { const e = document.querySelector(sel); if (e) { const b=e.getBoundingClientRect(); if (b.width>4&&b.height>4&&b.y>0&&b.y<innerHeight-10&&b.x>0&&b.x<innerWidth-10) return {x:b.x+b.width/2,y:b.y+b.height/2,sel:sel}; } }
          return null;
        }""")
        print("pick target:", r)
        if r:
            pg.mouse.click(r["x"], r["y"]); time.sleep(0.5)
            st = pg.evaluate("""() => {
              const p = document.querySelector('[data-ve-changes]') ? document.querySelector('[data-ve-changes]').closest('[data-ve-ui]') : null;
              if (!p) return 'no panel';
              const b = p.getBoundingClientRect();
              return { display: getComputedStyle(p).display, top: Math.round(b.top), bottom: Math.round(b.bottom), h: Math.round(b.height), inView: b.top>=0 && b.bottom<=innerHeight };
            }""")
            print("panel after pick:", st)
            # 关闭 -> 再点一下别的 -> 面板必须回来
            pg.evaluate("() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); }")
            pg.keyboard.press("Escape"); time.sleep(0.3)
            print("after ESC panelVisible:", pg.evaluate("() => window.VisualEditKit.panelVisible()"))
            r2 = pg.evaluate("""() => { const els=document.querySelectorAll('button,a,h3,td,div'); for (const e of els){ const b=e.getBoundingClientRect(); if (b.width>30&&b.height>12&&b.y>10&&b.y<innerHeight-20&&b.x>10&&b.x<innerWidth-20) return {x:b.x+b.width/2,y:b.y+b.height/2, tag:e.tagName}; } return null; }""")
            print("second target:", r2)
            if r2:
                pg.mouse.click(r2["x"], r2["y"]); time.sleep(0.5)
                print("panel visible after re-pick:", pg.evaluate("() => window.VisualEditKit.panelVisible()"))
                print("active:", pg.evaluate("() => { const a=window.VisualEditKit.getActive(); return a? (a.tagName+'.'+(a.className||'').toString().slice(0,20)) : null }"))
    print("PAGE_ERRORS:", errors)
    b.close()
