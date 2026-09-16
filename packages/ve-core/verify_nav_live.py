"""验收：把用户真实那份"id 已漂移"的方案种进 SaaS 首页，验证顶部菜单栏能正常显示。

方案内容取自用户浏览器 localStorage（Edge leveldb）里 ve_plan::/ 的真实记录。
"""
import json
import urllib.request

from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:5020"
FRONT = "http://127.0.0.1:5122"
LAYOUT = "#root > div.ant-layout.css-dev-only-do-not-override-ry7cab"
HEADER = LAYOUT + " > header.ant-layout-header.css-dev-only-do-not-override-ry7cab"

PLAN = {
    "route": "/",
    "changes": [
        {"id": "ve-2", "path": LAYOUT, "kind": "style", "prop": "transform", "value": "translate(-3px,1px)"},
        {"id": "ve-2", "path": LAYOUT, "kind": "style", "prop": "width", "value": "1304px"},
        {"id": "ve-2", "path": LAYOUT, "kind": "style", "prop": "height", "value": "785px"},
        {"id": "ve-6", "path": "div.ant-table-container > div.ant-table-content > table > tbody.ant-table-tbody > tr.ant-table-row.ant-table-row-level-0:nth-child(1) > td.ant-table-cell:nth-child(8)", "kind": "style", "prop": "transform", "value": "translate(0px,0px)"},
        {"id": "ve-8", "path": HEADER, "kind": "style", "prop": "width", "value": "1703px"},
        {"id": "ve-8", "path": HEADER, "kind": "style", "prop": "height", "value": "48px"},
        {"id": "ve-9", "path": LAYOUT + " > main.ant-layout-content.css-dev-only-do-not-override-ry7cab > div.page-container > div.page-header:nth-child(1)", "kind": "style", "prop": "transform", "value": "translate(4px,-19px)"},
    ],
}


def login():
    req = urllib.request.Request(
        BASE + "/api/v1/auth/login",
        data=json.dumps({"username": "admin", "password": "admin"}).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.loads(r.read().decode())["access_token"]


token = login()
with sync_playwright() as p:
    b = p.chromium.launch(channel="msedge", headless=True)
    pg = b.new_page(viewport={"width": 1600, "height": 900})
    errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.goto(FRONT + "/", wait_until="domcontentloaded")
    pg.evaluate(
        "([t, plan]) => { localStorage.setItem('token', t);"
        " localStorage.setItem('auth-storage', JSON.stringify({state:{token:t,user:null},version:0}));"
        " localStorage.setItem('ve_plan::/', JSON.stringify(plan)); }",
        [token, PLAN],
    )
    pg.goto(FRONT + "/", wait_until="networkidle")
    pg.wait_for_timeout(2500)
    r = pg.evaluate(
        """() => {
          const nav = document.querySelector('.top-nav');
          const hdr = document.querySelector('header.ant-layout-header');
          const nr = nav.getBoundingClientRect(), hr = hdr.getBoundingClientRect();
          const sheet = (document.getElementById('ve-applied-styles')||{}).textContent||'';
          return {
            navVisible: !!(nr.width > 100 && nr.height > 0 && getComputedStyle(nav).display !== 'none'),
            navRect: [Math.round(nr.x), Math.round(nr.y), Math.round(nr.width), Math.round(nr.height)],
            navItems: nav.children.length,
            navItemHeights: [...nav.children].map(c => Math.round(c.getBoundingClientRect().height)),
            headerRect: [Math.round(hr.x), Math.round(hr.y), Math.round(hr.width), Math.round(hr.height)],
            headerStyle: getComputedStyle(hdr).height + ' / ' + getComputedStyle(hdr).width,
            sheet: sheet.trim().split('\\n').slice(0, 8)
          };
        }"""
    )
    print(json.dumps(r, ensure_ascii=False, indent=2))
    print("PAGE_ERRORS:", errs)
    pg.screenshot(path="verify_nav.png")
    ok = r["navVisible"] and all(h < 60 for h in r["navItemHeights"])
    print("[RESULT]", "PASS ✅ 菜单栏恢复正常，变更落在 header 上" if ok else "FAIL ❌")
    b.close()
