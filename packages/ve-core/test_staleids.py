"""回归：旧方案里的 data-ve-id 已漂移（会话内按需分配），重放时必须按 path 解析目标，
绝不能把样式/隐藏错套到别的元素上 —— 事故现象是"顶部菜单栏被搞没"。

覆盖：
  [A] path 优先：header 的宽高变更必须落在 header 上，导航项不受影响
  [B] tag 指纹守卫：path 解析不到 + id 命中的元素结构不符时，宁可不应用（不误伤）
  [C] 救急入口：无选中也能点开关打开面板，并一键「清空本页」恢复原样
"""
import http.server
import os
import socketserver
import sys
import threading
import time

from playwright.sync_api import sync_playwright

EDGE = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
PORT = 8741
ROOT = os.path.dirname(os.path.abspath(__file__))
os.chdir(ROOT)

httpd = socketserver.TCPServer(("127.0.0.1", PORT), http.server.SimpleHTTPRequestHandler)
httpd.timeout = 1
threading.Thread(target=httpd.serve_forever, daemon=True).start()
URL = f"http://127.0.0.1:{PORT}/test-staleids.html"

HEADER_SEL = "#root > div.app > header.hdr"
NAV_SEL = "#root > div.app > header.hdr > nav.nav"


def seed(page, changes):
    import json

    page.evaluate(
        "(plan) => localStorage.setItem('ve_plan::/', JSON.stringify(plan))",
        {"route": "/", "changes": changes},
    )


def state(page):
    return page.evaluate(
        """() => {
          const h = document.querySelector('header.hdr');
          const nav = document.querySelector('nav.nav');
          const items = [...document.querySelectorAll('.nav-item')];
          const hs = getComputedStyle(h), ns = getComputedStyle(nav);
          const r = nav.getBoundingClientRect();
          return {
            headerH: hs.height, headerW: hs.width,
            navDisplay: ns.display, navW: r.width, navPos: [r.x, r.y],
            itemH: items.map(i => getComputedStyle(i).height),
            itemW: items.map(i => Math.round(i.getBoundingClientRect().width)),
            ids: { header: h.getAttribute('data-ve-id'), nav: nav.getAttribute('data-ve-id'),
                   item0: items[0] && items[0].getAttribute('data-ve-id'),
                   item2: items[2] && items[2].getAttribute('data-ve-id') },
            sheet: (document.getElementById('ve-applied-styles') || {}).textContent || ''
          };
        }"""
    )


fails = []
checks = 0


def check(label, cond, extra=""):
    global checks
    checks += 1
    print(("  PASS " if cond else "  FAIL ") + label + ((" | " + str(extra)) if extra else ""))
    if not cond:
        fails.append(label)


errors = []
with sync_playwright() as p:
    b = p.chromium.launch(executable_path=EDGE, args=["--no-sandbox"])
    pg = b.new_page(viewport={"width": 1440, "height": 900})
    pg.on("pageerror", lambda e: errors.append(str(e)))
    pg.on("dialog", lambda d: d.accept())

    # ---------- A. path 优先 ----------
    print("[A] 旧方案 id 已漂移，但 path 正确 → 必须按 path 命中 header")
    pg.goto(URL, wait_until="domcontentloaded")
    pg.wait_for_selector("[data-ve-toggle]")
    seed(pg, [
        # 编辑时 header 是 ve-8；修复确定性 id 后 ve-8 落到了第 3 个导航项上
        {"id": "ve-8", "path": HEADER_SEL, "fp": "header", "kind": "style", "prop": "height", "value": "48px"},
        {"id": "ve-8", "path": HEADER_SEL, "fp": "header", "kind": "style", "prop": "width", "value": "1200px"},
    ])
    pg.reload(wait_until="domcontentloaded")
    pg.wait_for_selector("[data-ve-toggle]")
    pg.wait_for_timeout(400)
    a = state(pg)
    print("     ", {k: a[k] for k in ("headerH", "headerW", "navDisplay", "navW", "itemH", "ids")})
    check("header 高度按方案变成 48px", a["headerH"] == "48px", a["headerH"])
    check("header 宽度按方案变成 1200px", a["headerW"] == "1200px", a["headerW"])
    check("导航项没被误套 48px（仍是 36px）", all(h == "36px" for h in a["itemH"]), a["itemH"])
    check("菜单栏仍可见（display flex + 有宽度）", a["navDisplay"] == "flex" and a["navW"] > 100, (a["navDisplay"], a["navW"]))
    check("规则锚点写在 header 自己的 id 上", f'[data-ve-id="{a["ids"]["header"]}"]' in a["sheet"], a["sheet"].strip().replace("\n", " "))

    # ---------- B. 指纹守卫 ----------
    print("[B] path 解析不到 + id 命中的元素结构不符（fp=header vs 实际 div）→ 跳过不应用")
    seed(pg, [
        {"id": "ve-8", "path": "#root > div.app > header.hdr > div.不存在的幽灵节点", "fp": "header",
         "kind": "style", "prop": "height", "value": "999px"},
    ])
    pg.reload(wait_until="domcontentloaded")
    pg.wait_for_selector("[data-ve-toggle]")
    pg.wait_for_timeout(400)
    bst = state(pg)
    print("     ", {k: bst[k] for k in ("headerH", "itemH", "ids")})
    check("没有元素被套上 999px（导航项安全）", all(h == "36px" for h in bst["itemH"]), bst["itemH"])
    check("header 保持原样 64px", bst["headerH"] == "64px", bst["headerH"])
    check("未产生错误的 999px 规则", "999px" not in bst["sheet"], bst["sheet"])

    # ---------- C. 救急：无选中也能开面板 + 一键清空本页 ----------
    print("[C] 用户手动隐藏了菜单栏后，要能一键找回（无选中也能打开面板）")
    seed(pg, [
        {"id": "ve-5", "path": NAV_SEL, "fp": "nav", "kind": "hide"},
    ])
    pg.reload(wait_until="domcontentloaded")
    pg.wait_for_selector("[data-ve-toggle]")
    pg.wait_for_timeout(400)
    c1 = state(pg)
    check("菜单栏确实被隐藏（复现用户现象）", c1["navDisplay"] == "none", c1["navDisplay"])
    pg.click("[data-ve-toggle]")
    pg.wait_for_timeout(400)
    check("点微调开关后面板可见（即使没有任何选中）", pg.evaluate("() => window.VisualEditKit.panelVisible()"))
    pg.click("[data-ve-reset]")
    pg.wait_for_timeout(500)
    c2 = state(pg)
    check("「清空本页」后菜单栏恢复显示", c2["navDisplay"] == "flex" and c2["navW"] > 100, (c2["navDisplay"], c2["navW"]))
    check("清空后方案为空", pg.evaluate("() => (window.VisualEditKit.getPlan().changes || []).length") == 0)

    print("PAGE_ERRORS:", errors)
    check("无 pageerror（无卡死/异常）", not errors, errors)
    b.close()

httpd.shutdown()
print(f"\n[RESULT] {checks - len(fails)}/{checks} " + ("PASS ✅" if not fails else f"FAIL ❌ {fails}"))
sys.exit(0 if not fails else 1)
