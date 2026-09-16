"""诊断：SaaS 页面顶部菜单栏消失的真因。
用 admin/admin 拿 token -> 种子 localStorage -> 打开首页 -> 导出
  .top-nav 的可见性/计算样式、ve 托管样式表内容、ve 相关 localStorage 计划。
"""
import json
import urllib.request
import urllib.error

from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:5020"
FRONT = "http://127.0.0.1:5122"


def login():
    req = urllib.request.Request(
        BASE + "/api/v1/auth/login",
        data=json.dumps({"username": "admin", "password": "admin"}).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.loads(r.read().decode())


def main():
    info = login()
    token = info.get("access_token") or info.get("token")
    print("token ok:", bool(token), "| keys:", list(info.keys()))

    with sync_playwright() as p:
        b = p.chromium.launch(channel="msedge", headless=True)
        pg = b.new_page(viewport={"width": 1600, "height": 900})
        errs = []
        pg.on("pageerror", lambda e: errs.append(str(e)))

        pg.goto(FRONT + "/", wait_until="domcontentloaded")
        pg.evaluate(
            "(t) => { localStorage.setItem('token', t); "
            "localStorage.setItem('auth-storage', JSON.stringify({state:{token:t,user:null},version:0})); }",
            token,
        )
        pg.goto(FRONT + "/", wait_until="networkidle")
        pg.wait_for_timeout(2500)

        out = pg.evaluate(
            """() => {
              const res = {};
              const nav = document.querySelector('.top-nav');
              res.pathname = location.pathname;
              res.navExists = !!nav;
              if (nav) {
                const cs = getComputedStyle(nav);
                const r = nav.getBoundingClientRect();
                res.navDisplay = cs.display;
                res.navWidth = cs.width;
                res.navHeight = cs.height;
                res.navRect = [r.x, r.y, r.width, r.height];
                res.navVisible = !!(r.width && r.height);
                res.navInline = nav.getAttribute('style');
                res.navItemCount = nav.children.length;
                res.navParentStyle = nav.parentElement.getAttribute('style');
                res.navParentDisplay = getComputedStyle(nav.parentElement).display;
                res.navParentRect = (() => { const q = nav.parentElement.getBoundingClientRect(); return [q.x,q.y,q.width,q.height]; })();
              }
              // 托管样式表
              const sheets = [];
              for (const id of ['ve-managed-style','ve-token-style','ve-style','ve-core-style','ve-managed-tokens']) {
                const el = document.getElementById(id);
                if (el) sheets.push([id, el.textContent]);
              }
              res.sheets = sheets;
              // 所有 ve 相关 style 标签
              res.allStyleIds = [...document.querySelectorAll('style[id]')].map(s => s.id);
              // 应用在 nav 上的匹配规则来源（逐条测试）
              res.veLs = {};
              for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                if (k && k.indexOf('ve_') === 0) res.veLs[k] = localStorage.getItem(k);
              }
              res.navDataVe = nav ? nav.getAttribute('data-ve-id') : null;
              res.headerHTML = nav && nav.parentElement ? nav.parentElement.outerHTML.slice(0, 600) : null;
              return res;
            }"""
        )
        print(json.dumps(out, ensure_ascii=False, indent=2))
        print("pageerrors:", errs)
        pg.screenshot(path="diag_nav.png", full_page=False)
        b.close()


if __name__ == "__main__":
    main()
