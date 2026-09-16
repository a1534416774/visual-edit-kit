"""回归：导出 CSS / JSON 按钮。

真实场景：微调引擎处于「开启」状态（document 上有捕获态 onPick 拦截点击）。
必须同时满足：
  - 弹窗展示完整内容（复制/重下入口）
  - <a download> 的下载行为**不被 onPick 的 preventDefault 取消**（真实触发 download 事件）
本用例开启引擎后再点导出，正是历史 bug「只弹窗、不下载」的复现场景。
"""
import os
from playwright.sync_api import sync_playwright

EDGE = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
CORE = os.environ.get("VE_CORE", r"D:\Workbuddy\Claw\visual-edit-kit\packages\ve-core\ve-core.js")

fails = []
def check(name, cond):
    print(("  PASS " if cond else "  FAIL ") + name)
    if not cond: fails.append(name)


def open_panel_state(pg):
    return pg.evaluate("""() => {
      var b = [...document.querySelectorAll('[data-ve-ui]')].find(function(e){ return /微调/.test(e.textContent||''); });
      return { toggleFound: !!b, on: !!(b && /微调中/.test(b.textContent||'')) };
    }""")


with sync_playwright() as p:
    b = p.chromium.launch(executable_path=EDGE, args=["--no-sandbox"])
    ctx = b.new_context(accept_downloads=True, viewport={"width":1200,"height":800})
    pg = ctx.new_page()
    errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)))

    pg.set_content('<div id="box" style="width:100px;height:100px">box</div>')
    pg.wait_for_timeout(150)
    with open(CORE, "r", encoding="utf-8") as f:
        core_js = f.read()
    pg.add_script_tag(content=core_js)
    pg.wait_for_timeout(250)

    # 1) 启动引擎
    pg.evaluate("""() => { VisualEditKit.init({ features:["style","text","hide","move","delete","color","layout","comment","tree","variants","token"] }); }""")
    pg.wait_for_timeout(150)

    # 2) 打开微调（engineOn=true → document 上挂捕获态 onPick，复现历史 bug 场景）
    pg.evaluate("""() => {
      var b = [...document.querySelectorAll('[data-ve-ui]')].find(function(e){ return /微调/.test(e.textContent||''); });
      if (b) b.click();
    }""")
    pg.wait_for_timeout(200)
    st = open_panel_state(pg)
    check("微调已开启(onPick 已挂载)", st["toggleFound"] and st["on"])

    # 3) 选中 #box 并改背景色（正式改动路径）
    pg.evaluate("""() => { VisualEditKit.select(document.getElementById('box')); }""")
    pg.wait_for_timeout(200)
    pg.evaluate("""() => {
      var i = document.querySelector('[data-ve-bg]');
      if(!i) return; i.value = '#ff0000'; i.dispatchEvent(new Event('input', {bubbles:true}));
    }""")
    pg.wait_for_timeout(200)

    # 4) 点「导 CSS」→ 弹窗出现 + 真实触发下载
    dls = []
    pg.on("download", lambda d: dls.append(d.suggested_filename))
    pg.evaluate("""() => { document.querySelector('[data-ve-export-css]').click(); }""")
    pg.wait_for_timeout(400)
    css_text = pg.evaluate("""() => { var ta=document.querySelector('[data-ve-out]'); return ta?ta.value:null; }""")
    check("导CSS 弹窗出现", css_text is not None)
    check("导CSS 含 background 改动", bool(css_text) and "background" in css_text)
    check("导CSS 真实触发下载(.css)", any(n.endswith(".css") for n in dls))
    print("   downloads:", dls)

    # 5) 关闭弹窗 -> 点「导 JSON」
    pg.evaluate("""() => { var x=document.querySelector('[data-ve-x]'); if(x) x.click(); }""")
    pg.wait_for_timeout(150)
    dls.clear()
    pg.evaluate("""() => { document.querySelector('[data-ve-export-json]').click(); }""")
    pg.wait_for_timeout(400)
    json_text = pg.evaluate("""() => { var ta=document.querySelector('[data-ve-out]'); return ta?ta.value:null; }""")
    check("导JSON 弹窗出现", json_text is not None)
    check("导JSON 含 changes", bool(json_text) and '"changes"' in json_text and "background" in json_text)
    check("导JSON 真实触发下载(.json)", any(n.endswith(".json") for n in dls))
    print("   downloads:", dls)

    # 6) 弹窗内「复制内容」不报错
    pg.evaluate("""() => { var c=document.querySelector('[data-ve-copy]'); if(c) c.click(); }""")
    pg.wait_for_timeout(200)

    pg.evaluate("""() => { var x=document.querySelector('[data-ve-x]'); if(x) x.click(); }""")
    check("无 pageerror", len(errs) == 0)
    if errs: print("   pageerrors:", errs)

print("\nFAILURES:", fails if fails else "NONE")
print("RESULT:", "ALL_OK" if not fails else "FAILED")
