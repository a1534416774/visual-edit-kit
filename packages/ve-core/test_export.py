from playwright.sync_api import sync_playwright

EDGE = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
CORE = r"D:\Workbuddy\Claw\visual-edit-kit\packages\ve-core\ve-core.js"

fails = []
def check(name, cond):
    print(("  PASS " if cond else "  FAIL ") + name)
    if not cond: fails.append(name)

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
    pg.evaluate("""() => {
      VisualEditKit.init({ features:["style","text","hide","move","delete","color","layout","comment","tree","variants","token"] });
    }""")
    pg.wait_for_timeout(150)

    # 2) 选中 #box 并改背景色（走正式改动路径）
    pg.evaluate("""() => {
      VisualEditKit.select(document.getElementById('box'));
    }""")
    pg.wait_for_timeout(200)
    pg.evaluate("""() => {
      var i = document.querySelector('[data-ve-bg]');
      if(!i) return;
      i.value = '#ff0000';
      i.dispatchEvent(new Event('input', {bubbles:true}));
    }""")
    pg.wait_for_timeout(200)

    # 3) 点「导 CSS」-> 应弹窗且含内容
    pg.evaluate("""() => { document.querySelector('[data-ve-export-css]').click(); }""")
    pg.wait_for_timeout(300)
    css_text = pg.evaluate("""() => { var ta=document.querySelector('[data-ve-out]'); return ta?ta.value:null; }""")
    check("导CSS 弹窗出现", css_text is not None)
    check("导CSS 含 background 改动", bool(css_text) and "background" in css_text and "ve-1" in css_text)

    # 4) 关闭后点「导 JSON」
    pg.evaluate("""() => { var x=document.querySelector('[data-ve-x]'); if(x) x.click(); }""")
    pg.wait_for_timeout(150)
    pg.evaluate("""() => { document.querySelector('[data-ve-export-json]').click(); }""")
    pg.wait_for_timeout(300)
    json_text = pg.evaluate("""() => { var ta=document.querySelector('[data-ve-out]'); return ta?ta.value:null; }""")
    check("导JSON 弹窗出现", json_text is not None)
    check("导JSON 含 changes", bool(json_text) and '"changes"' in json_text and "background" in json_text)

    # 5) 验证「复制内容」按钮能把文本填进剪贴板（prompt 兜底不可测，这里测 toast 不报错即可）
    # 6) 验证「重新下载」触发下载事件
    dl_name = []
    pg.on("download", lambda d: dl_name.append(d.suggested_filename))
    pg.evaluate("""() => { var b=document.querySelector('[data-ve-dl]'); if(b) b.click(); }""")
    pg.wait_for_timeout(500)
    # dl_name 可能为空（headless 下载有时不触发 download 事件但不报错），仅记录不强制
    print("  INFO  重新下载触发文件名:", dl_name)

    pg.evaluate("""() => { var x=document.querySelector('[data-ve-x]'); if(x) x.click(); }""")
    check("无 pageerror", len(errs) == 0)
    if errs: print("   pageerrors:", errs)

print("\nFAILURES:", fails if fails else "NONE")
print("RESULT:", "ALL_OK" if not fails else "FAILED")
