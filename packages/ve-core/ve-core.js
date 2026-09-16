/*!
 * VisualEditKit core — 框架无关、免构建的可视化页面微调引擎。
 *
 * 机制（借鉴 Design Mode 最稳的一招）：
 *   1. 激活时给元素按需打 data-ve-id="ve-N" 标记（轻量、可逆）。
 *   2. 所有编辑写成规则，注入唯一托管 <style id="ve-applied-styles">。
 *      样式用属性选择器 [data-ve-id="ve-N"]{prop:val}，按 id 而非易变路径，
 *      因此整页刷新 / SPA 重渲染后由 core 自动重放、不会"刷新就丢"。
 *   3. 方案同时存 localStorage（即时预览）与可选后端（团队/持久/可导出）。
 *   4. 导出结构化 diff：{route,changes:[{id,path,prop,value,kind}]}，可喂 AI 落地源码。
 *
 * MIT License. UMD：<script> 直接引，或 require/import 均可。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else if (typeof define === "function" && define.amd) define(factory);
  else root.VisualEditKit = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // ---- 常量 --------------------------------------------------------------
  var STYLE_ID = "ve-applied-styles";
  var TOKEN_STYLE_ID = "ve-token-styles";
  var DATA_ATTR = "data-ve-id";
  var PREFIX = "ve-";
  // 自己的 UI / 弹层 / 不可拾取节点
  var SKIP = "[data-ve-ui],.ant-modal,.ant-dropdown,.ant-select-dropdown," +
    ".ant-picker-panel,.ant-popover,.ant-tooltip,script,style,link,meta,title,svg";
  // 可拾取的标签（命中即选中最近的该祖先）
  var PICKABLE = "button,a,.card,h1,h2,h3,h4,h5,h6,p,label,th,td,li,span,div," +
    "section,article,header,footer,nav,main";

  var opts = {
    route: location.pathname,
    serverUrl: null,
    token: null,
    features: ["text", "color", "hide", "move", "token", "delete"],
    pickMode: "click",
    autoFetch: true,
  };

  var plan = { route: opts.route, changes: [] };
  var counter = 0;
  var activeEl = null;
  var panelEl = null;
  var hoverEl = null;

  // ---- 工具 --------------------------------------------------------------
  function nextId() { return PREFIX + (++counter); }
  function isUi(el) { return !!(el && el.closest && el.closest(SKIP)); }
  function isPickable(el) {
    return el && el.nodeType === 1 && el.closest && el.closest(PICKABLE) && !isUi(el);
  }
  function getAssignedId(el) { return el.getAttribute(DATA_ATTR); }
  function ensureId(el) {
    var id = getAssignedId(el);
    if (!id) { id = nextId(); el.setAttribute(DATA_ATTR, id); }
    return id;
  }

  // 生成供 AI 落地源码用的稳定 CSS 路径（最多 6 段）
  function pathOf(el) {
    if (!el || el.nodeType !== 1) return "";
    if (el.id) return "#" + cssEscape(el.id);
    var parts = [];
    var cur = el;
    while (cur && cur.nodeType === 1 && parts.length < 6 && cur.tagName !== "HTML" && cur.tagName !== "BODY") {
      var tag = cur.tagName.toLowerCase();
      if (cur.id) { parts.unshift("#" + cssEscape(cur.id)); break; }
      var sibs = Array.prototype.filter.call(cur.parentNode ? cur.parentNode.children : [], function (c) { return c.tagName === cur.tagName; });
      var sel = tag;
      if (cur.classList && cur.classList.length) sel += "." + Array.prototype.slice.call(cur.classList, 0, 2).map(cssEscape).join(".");
      if (sibs.length > 1) sel += ":nth-child(" + (Array.prototype.indexOf.call(cur.parentNode.children, cur) + 1) + ")";
      parts.unshift(sel);
      cur = cur.parentNode;
    }
    return parts.join(" > ");
  }
  function cssEscape(s) { return String(s).replace(/([^a-zA-Z0-9_-])/g, "\\$1"); }

  // 仅替换首个文本节点（保留子元素）。与 SaaS 版一致，更稳。
  function setTextOnly(el, text) {
    var first = null;
    for (var i = 0; i < el.childNodes.length; i++) {
      if (el.childNodes[i].nodeType === 3) { first = el.childNodes[i]; break; }
    }
    if (first) first.nodeValue = text;
    else el.insertBefore(document.createTextNode(text), el.firstChild);
  }
  function getTextOnly(el) {
    for (var i = 0; i < el.childNodes.length; i++) {
      if (el.childNodes[i].nodeType === 3) return el.childNodes[i].nodeValue;
    }
    return el.textContent || "";
  }

  function moveToIndex(el, idx) {
    var parent = el.parentNode;
    if (!parent) return;
    var kids = Array.prototype.slice.call(parent.children);
    var curIdx = kids.indexOf(el);
    if (curIdx === -1) return;
    if (idx < 0) idx = 0;
    if (idx >= kids.length) idx = kids.length - 1;
    if (idx === curIdx) return;
    var ref = parent.children[idx] || null;
    if (ref === el) ref = parent.children[idx + 1] || null;
    parent.insertBefore(el, ref);
  }

  // ---- 样式 / token 重放 ------------------------------------------------
  function getSheet(id) {
    var s = document.getElementById(id);
    if (!s) { s = document.createElement("style"); s.id = id; document.head.appendChild(s); }
    return s;
  }
  function renderAll() {
    var sheet = getSheet(STYLE_ID);
    var tokenSheet = getSheet(TOKEN_STYLE_ID);
    sheet.textContent = "";
    tokenSheet.textContent = ":root {\n";
    var tokenCount = 0;
    plan.changes.forEach(function (c) {
      try {
        if (c.kind === "style") {
          sheet.textContent += "[" + DATA_ATTR + '="' + c.id + '"] { ' + c.prop + ": " + c.value + "; }\n";
        } else if (c.kind === "hide") {
          sheet.textContent += "[" + DATA_ATTR + '="' + c.id + '"] { display: none !important; }\n';
        } else if (c.kind === "text") {
          var te = document.querySelector("[" + DATA_ATTR + '="' + c.id + '"]');
          if (te) setTextOnly(te, c.value);
        } else if (c.kind === "move") {
          var me = document.querySelector("[" + DATA_ATTR + '="' + c.id + '"]');
          if (me) moveToIndex(me, c.value);
        } else if (c.kind === "delete") {
          var de = document.querySelector("[" + DATA_ATTR + '="' + c.id + '"]');
          if (de && de.parentNode) de.parentNode.removeChild(de);
        } else if (c.kind === "token") {
          tokenSheet.textContent += "  " + c.prop + ": " + c.value + ";\n";
          tokenCount++;
        }
      } catch (e) { /* 元素可能被重渲染移除，忽略 */ }
    });
    tokenSheet.textContent += "}\n";
    if (tokenCount === 0 && tokenSheet.textContent === ":root {\n}\n") tokenSheet.textContent = "";
  }

  // ---- 变更模型 ----------------------------------------------------------
  // change = { id, path, prop, value, kind }
  function upsert(change) {
    var i = plan.changes.findIndex(function (c) { return c.id === change.id && c.kind === change.kind && c.prop === change.prop; });
    if (i >= 0) { if (change.value === undefined || change.value === "" || (change.kind === "style" && change.value === "")) { plan.changes.splice(i, 1); } else { plan.changes[i] = change; } }
    else { if (change.value !== undefined && change.value !== "" ) plan.changes.push(change); }
    if (change.kind === "delete") { /* delete 不依赖 value */ }
    renderAll();
    persist();
    if (panelEl) renderChangesList();
  }

  function findChange(id, kind, prop) {
    return plan.changes.find(function (c) { return c.id === id && c.kind === kind && c.prop === prop; });
  }
  function revertAt(i) {
    plan.changes.splice(i, 1);
    renderAll(); persist();
    if (panelEl) { syncPanelTo(activeEl); renderChangesList(); }
  }

  // ---- 持久化 ------------------------------------------------------------
  function lsKey() { return "ve_plan::" + (opts.route || "root"); }
  function persist() {
    try { localStorage.setItem(lsKey(), JSON.stringify(plan)); } catch (e) {}
  }
  function loadLocal() {
    try {
      var raw = localStorage.getItem(lsKey());
      if (raw) { var p = JSON.parse(raw); if (p && p.changes) plan = p; }
    } catch (e) {}
  }
  function loadRemote() {
    if (!opts.serverUrl) return Promise.resolve();
    return fetch(opts.serverUrl.replace(/\/$/, "") + "/" + encodeURIComponent(opts.route), {
      headers: opts.token ? { Authorization: "Bearer " + opts.token } : {},
    }).then(function (r) { if (r.ok) return r.json(); throw 0; }).then(function (p) {
      if (p && p.changes) { plan = p; renderAll(); }
    }).catch(function () {});
  }

  // ---- 导出 --------------------------------------------------------------
  function exportJSON() { return JSON.parse(JSON.stringify(plan)); }
  function exportCSS() {
    var lines = [":root {"];
    var tokens = plan.changes.filter(function (c) { return c.kind === "token"; });
    var others = plan.changes.filter(function (c) { return c.kind !== "token"; });
    tokens.forEach(function (c) { lines.push("  " + c.prop + ": " + c.value + ";"); });
    lines.push("}");
    others.forEach(function (c) {
      if (c.kind === "style") lines.push("[" + DATA_ATTR + '="' + c.id + '"] { ' + c.prop + ": " + c.value + "; }");
      else if (c.kind === "hide") lines.push("[" + DATA_ATTR + '="' + c.id + '"] { display: none !important; }');
      else if (c.kind === "text") lines.push("/* text -> " + c.path + " { content: '" + String(c.value).replace(/'/g, "\\'") + "' } */");
      else if (c.kind === "move") lines.push("/* move -> " + c.path + " { to-index: " + c.value + " } */");
      else if (c.kind === "delete") lines.push("/* delete -> " + c.path + " */");
    });
    return lines.join("\n") + "\n";
  }
  function download(name, content, type) {
    var blob = new Blob([content], { type: type || "text/plain" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  }

  function saveToServer() {
    if (!opts.serverUrl) { alert("未配置 serverUrl，无法上报后端。"); return Promise.resolve(false); }
    return fetch(opts.serverUrl.replace(/\/$/, "") + "/" + encodeURIComponent(opts.route), {
      method: "POST",
      headers: Object.assign({ "Content-Type": "application/json" }, opts.token ? { Authorization: "Bearer " + opts.token } : {}),
      body: JSON.stringify(plan),
    }).then(function (r) { return r.ok; }).catch(function () { return false; });
  }

  // ---- 选取交互 ----------------------------------------------------------
  function onOver(e) {
    if (!hoverEl && opts.pickMode === "hover") return;
    var t = e.target;
    if (!isPickable(t)) return;
    if (hoverEl) hoverEl.style.outline = hoverEl.__veOutline || "";
    hoverEl = t.closest(PICKABLE);
    if (hoverEl) { hoverEl.__veOutline = hoverEl.style.outline; hoverEl.style.outline = "2px dashed #8b5cf6"; }
  }
  function onOut() {
    if (hoverEl) { hoverEl.style.outline = hoverEl.__veOutline || ""; hoverEl = null; }
  }
  function onPick(e) {
    var t = e.target;
    if (!isPickable(t)) return;
    var el = t.closest(PICKABLE);
    if (!el || isUi(el)) return;
    e.preventDefault(); e.stopPropagation();
    select(el);
  }
  function select(el) {
    activeEl = el;
    var id = ensureId(el);
    buildPanel();
    syncPanelTo(el);
    positionPanelNear(el);
    highlight(el);
  }
  function highlight(el) {
    if (!el) return;
    el.style.outline = "2px solid #16a34a";
    setTimeout(function () { el.style.outline = el.__veOutline || ""; }, 600);
  }

  // ---- 面板 --------------------------------------------------------------
  function buildPanel() {
    if (panelEl) { document.body.appendChild(panelEl); return; }
    var p = document.createElement("div");
    p.setAttribute("data-ve-ui", "1");
    p.style.cssText = "position:absolute;z-index:2147483600;width:280px;background:#fff;" +
      "border:1px solid #e5e7eb;border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,.18);" +
      "font:13px/1.4 -apple-system,Segoe UI,Roboto,sans-serif;color:#111;padding:10px;";
    p.innerHTML =
      '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">' +
        '<b style="font-size:13px">🛠 页面微调</b>' +
        '<span style="cursor:pointer;opacity:.6" data-ve-close>✕</span>' +
      '</div>' +
      (opts.features.indexOf("text") >= 0 ?
        '<label style="display:block;font-size:11px;color:#6b7280;margin:6px 0 2px">文字</label>' +
        '<textarea data-ve-text rows="2" style="width:100%;box-sizing:border-box;border:1px solid #d1d5db;border-radius:6px;padding:4px;font:12px sans-serif"></textarea>' : '') +
      (opts.features.indexOf("color") >= 0 ?
        '<label style="display:block;font-size:11px;color:#6b7280;margin:6px 0 2px">背景色 / 文字色</label>' +
        '<div style="display:flex;gap:6px">' +
          '<input data-ve-bg type="color" style="width:36px;height:30px;border:none;background:none">' +
          '<input data-ve-fg type="color" style="width:36px;height:30px;border:none;background:none">' +
          '<button data-ve-bg-clear style="flex:1;border:1px solid #d1d5db;border-radius:6px;background:#f9fafb;cursor:pointer">清背景</button>' +
        '</div>' : '') +
      (opts.features.indexOf("color") >= 0 ?
        '<label style="display:block;font-size:11px;color:#6b7280;margin:6px 0 2px">字号 / 字重</label>' +
        '<div style="display:flex;gap:6px">' +
          '<select data-ve-fs style="flex:1;border:1px solid #d1d5db;border-radius:6px;padding:3px"><option value="">不改</option><option>12px</option><option>14px</option><option>16px</option><option>18px</option><option>20px</option><option>24px</option><option>28px</option></select>' +
          '<select data-ve-fw style="flex:1;border:1px solid #d1d5db;border-radius:6px;padding:3px"><option value="">不改</option><option value="400">常规</option><option value="500">中黑</option><option value="700">粗体</option></select>' +
        '</div>' : '') +
      (opts.features.indexOf("move") >= 0 || opts.features.indexOf("hide") >= 0 || opts.features.indexOf("delete") >= 0 ?
        '<div style="display:flex;gap:6px;margin-top:8px">' +
          (opts.features.indexOf("move") >= 0 ? '<button data-ve-up style="flex:1;border:1px solid #d1d5db;border-radius:6px;background:#f9fafb;cursor:pointer">↑ 上移</button><button data-ve-down style="flex:1;border:1px solid #d1d5db;border-radius:6px;background:#f9fafb;cursor:pointer">↓ 下移</button>' : '') +
          (opts.features.indexOf("hide") >= 0 ? '<button data-ve-hide style="flex:1;border:1px solid #d1d5db;border-radius:6px;background:#f9fafb;cursor:pointer">隐藏</button>' : '') +
          (opts.features.indexOf("delete") >= 0 ? '<button data-ve-del style="flex:1;border:1px solid #fca5a5;border-radius:6px;background:#fef2f2;color:#b91c1c;cursor:pointer">删除</button>' : '') +
        '</div>' : '') +
      (opts.features.indexOf("token") >= 0 ?
        '<details style="margin-top:8px"><summary style="cursor:pointer;color:#6b7280;font-size:11px">🎨 设计令牌(:root)</summary>' +
          '<div data-ve-tokens style="margin-top:6px;max-height:160px;overflow:auto"></div>' +
        '</details>' : '') +
      '<div data-ve-changes style="margin-top:8px;border-top:1px solid #f3f4f6;padding-top:6px;max-height:140px;overflow:auto"></div>' +
      '<div style="display:flex;gap:6px;margin-top:8px">' +
        '<button data-ve-export-css style="flex:1;border:1px solid #6366f1;border-radius:6px;background:#eef2ff;color:#4338ca;cursor:pointer">导 CSS</button>' +
        '<button data-ve-export-json style="flex:1;border:1px solid #6366f1;border-radius:6px;background:#eef2ff;color:#4338ca;cursor:pointer">导 JSON</button>' +
      '</div>' +
      (opts.serverUrl ? '<div style="display:flex;gap:6px;margin-top:6px">' +
        '<button data-ve-save style="flex:1;border:1px solid #16a34a;border-radius:6px;background:#f0fdf4;color:#15803d;cursor:pointer">保存后端</button>' +
        '<button data-ve-reset style="flex:1;border:1px solid #d1d5db;border-radius:6px;background:#f9fafb;cursor:pointer">重置本页</button>' +
      '</div>' : '<button data-ve-reset style="width:100%;margin-top:6px;border:1px solid #d1d5db;border-radius:6px;background:#f9fafb;cursor:pointer">重置本页</button>');

    // 事件
    p.addEventListener("click", function (e) { e.stopPropagation(); });
    p.querySelector("[data-ve-close]").addEventListener("click", function () { p.style.display = "none"; });
    if (opts.features.indexOf("text") >= 0) {
      var ta = p.querySelector("[data-ve-text]");
      ta.addEventListener("input", function () {
        if (!activeEl) return;
        var id = ensureId(activeEl);
        upsert({ id: id, path: pathOf(activeEl), kind: "text", prop: "text", value: ta.value });
      });
    }
    if (opts.features.indexOf("color") >= 0) {
      p.querySelector("[data-ve-bg]").addEventListener("input", function (e) {
        var id = ensureId(activeEl);
        upsert({ id: id, path: pathOf(activeEl), kind: "style", prop: "background-color", value: e.target.value });
      });
      p.querySelector("[data-ve-fg]").addEventListener("input", function (e) {
        var id = ensureId(activeEl);
        upsert({ id: id, path: pathOf(activeEl), kind: "style", prop: "color", value: e.target.value });
      });
      p.querySelector("[data-ve-bg-clear]").addEventListener("click", function () {
        var id = ensureId(activeEl);
        var c = findChange(id, "style", "background-color");
        if (c) revertChange(c);
      });
      p.querySelector("[data-ve-fs]").addEventListener("change", function (e) {
        var id = ensureId(activeEl);
        if (!e.target.value) return;
        upsert({ id: id, path: pathOf(activeEl), kind: "style", prop: "font-size", value: e.target.value });
      });
      p.querySelector("[data-ve-fw]").addEventListener("change", function (e) {
        var id = ensureId(activeEl);
        if (!e.target.value) return;
        upsert({ id: id, path: pathOf(activeEl), kind: "style", prop: "font-weight", value: e.target.value });
      });
    }
    if (opts.features.indexOf("move") >= 0) {
      p.querySelector("[data-ve-up]").addEventListener("click", function () { moveActive(-1); });
      p.querySelector("[data-ve-down]").addEventListener("click", function () { moveActive(1); });
    }
    if (opts.features.indexOf("hide") >= 0) {
      p.querySelector("[data-ve-hide]").addEventListener("click", function () {
        var id = ensureId(activeEl);
        var c = findChange(id, "hide");
        if (c) revertChange(c); else upsert({ id: id, path: pathOf(activeEl), kind: "hide", prop: "display", value: "none" });
      });
    }
    if (opts.features.indexOf("delete") >= 0) {
      p.querySelector("[data-ve-del]").addEventListener("click", function () {
        if (!activeEl) return;
        var id = ensureId(activeEl);
        upsert({ id: id, path: pathOf(activeEl), kind: "delete", prop: "remove", value: "1" });
        p.style.display = "none"; activeEl = null;
      });
    }
    p.querySelector("[data-ve-export-css]").addEventListener("click", function () { download("visual-edit-" + slug(opts.route) + ".css", exportCSS(), "text/css"); });
    p.querySelector("[data-ve-export-json]").addEventListener("click", function () { download("visual-edit-" + slug(opts.route) + ".json", JSON.stringify(exportJSON(), null, 2), "application/json"); });
    if (opts.serverUrl) {
      p.querySelector("[data-ve-save]").addEventListener("click", function () {
        saveToServer().then(function (ok) { alert(ok ? "已保存到后端 ✓" : "保存失败，检查 serverUrl / 网络"); });
      });
    }
    p.querySelector("[data-ve-reset]").addEventListener("click", function () {
      plan = { route: opts.route, changes: [] };
      persist(); renderAll();
      if (panelEl) { syncPanelTo(activeEl); renderChangesList(); }
    });

    // 设计令牌懒加载：仅在展开「🎨 设计令牌」时扫描样式表，
    // 避免每次选中元素都做全量 :root 变量扫描（大项目上很重）。
    if (opts.features.indexOf("token") >= 0) {
      var det = p.querySelector("details");
      if (det) det.addEventListener("toggle", function () { if (det.open) renderTokens(); });
    }

    panelEl = p;
    document.body.appendChild(p);
  }

  function revertChange(c) {
    var i = plan.changes.indexOf(c);
    if (i >= 0) revertAt(i);
  }
  function moveActive(dir) {
    if (!activeEl) return;
    var id = ensureId(activeEl);
    var kids = activeEl.parentNode ? Array.prototype.slice.call(activeEl.parentNode.children) : [];
    var cur = kids.indexOf(activeEl);
    var target = cur + dir;
    upsert({ id: id, path: pathOf(activeEl), kind: "move", prop: "order", value: target });
  }

  function syncPanelTo(el) {
    if (!panelEl || !el) return;
    if (opts.features.indexOf("text") >= 0) panelEl.querySelector("[data-ve-text]").value = getTextOnly(el);
    if (opts.features.indexOf("color") >= 0) {
      var bg = findChange(getAssignedId(el) || "", "style", "background-color");
      var fg = findChange(getAssignedId(el) || "", "style", "color");
      panelEl.querySelector("[data-ve-bg]").value = rgbToHex(getComputedStyle(el).backgroundColor) || "#ffffff";
      panelEl.querySelector("[data-ve-fg]").value = rgbToHex(getComputedStyle(el).color) || "#000000";
    }
    renderChangesList();
  }
  function renderChangesList() {
    if (!panelEl) return;
    var box = panelEl.querySelector("[data-ve-changes]");
    if (!plan.changes.length) { box.innerHTML = '<div style="color:#9ca3af;font-size:11px">暂无变更</div>'; return; }
    box.innerHTML = plan.changes.map(function (c, i) {
      var label = c.kind === "text" ? "文字" : c.kind === "hide" ? "隐藏" : c.kind === "delete" ? "删除" :
        c.kind === "move" ? "排序" : c.kind === "token" ? c.prop : c.prop;
      var val = c.kind === "move" ? "→第" + (c.value + 1) + "位" : c.kind === "hide" ? "" : ("" + c.value).slice(0, 24);
      return '<div style="display:flex;justify-content:space-between;align-items:center;padding:3px 0;border-bottom:1px dashed #f3f4f6">' +
        '<span style="font-size:11px;color:#374151">' + escapeHtml(label) + ' <span style="color:#9ca3af">' + escapeHtml(val) + '</span></span>' +
        '<span style="cursor:pointer;color:#dc2626;font-size:11px" data-ve-revert="' + i + '">↺</span></div>';
    }).join("");
    Array.prototype.forEach.call(box.querySelectorAll("[data-ve-revert]"), function (b) {
      b.addEventListener("click", function () { revertAt(parseInt(b.getAttribute("data-ve-revert"), 10)); });
    });
  }
  function renderTokens() {
    if (!panelEl) return;
    var box = panelEl.querySelector("[data-ve-tokens]");
    var vars = collectTokens();
    box.innerHTML = vars.map(function (v) {
      return '<div style="display:flex;align-items:center;gap:6px;margin:4px 0">' +
        '<input type="color" data-ve-token-color="' + escapeHtml(v.name) + '" value="' + (rgbToHex(v.value) || "#ffffff") + '" style="width:30px;height:26px;border:none;background:none">' +
        '<span style="flex:1;font:11px monospace;color:#374151">' + escapeHtml(v.name) + '</span>' +
        '</div>';
    }).join("");
    Array.prototype.forEach.call(box.querySelectorAll("[data-ve-token-color]"), function (inp) {
      inp.addEventListener("input", function (e) {
        upsert({ id: ":root", path: ":root", kind: "token", prop: e.target.getAttribute("data-ve-token-color"), value: e.target.value });
      });
    });
  }

  // 收集 :root / :host 声明的 CSS 变量
  function collectTokens() {
    var map = {};
    try {
      Array.prototype.forEach.call(document.styleSheets, function (ss) {
        var rules;
        try { rules = ss.cssRules; } catch (e) { return; }
        Array.prototype.forEach.call(rules, function (r) {
          if (r.selectorText === ":root" || r.selectorText === ":host" || (r.selectorText && r.selectorText.indexOf(":root") >= 0)) {
            Array.prototype.forEach.call(r.style, function (p) {
              if (p.indexOf("--") === 0) map[p] = r.style.getPropertyValue(p).trim();
            });
          }
        });
      });
    } catch (e) {}
    // 补充当前 computed 中确实生效的变量
    var rootStyle = getComputedStyle(document.documentElement);
    Array.prototype.forEach.call(rootStyle, function (p) {
      if (p.indexOf("--") === 0 && !map[p]) map[p] = rootStyle.getPropertyValue(p).trim();
    });
    return Object.keys(map).map(function (k) { return { name: k, value: map[k] }; });
  }

  function positionPanelNear(el) {
    if (!panelEl || !el) return;
    var r = el.getBoundingClientRect();
    var x = Math.min(window.innerWidth - 290, r.left + window.scrollX);
    var y = r.bottom + window.scrollY + 8;
    if (y + 300 > window.innerHeight + window.scrollY) y = Math.max(window.scrollY, r.top + window.scrollY - 290);
    panelEl.style.left = Math.max(8, x) + "px";
    panelEl.style.top = y + "px";
  }

  // ---- SPA 重渲染保护 ----------------------------------------------------
  var mo, pendingRender = false;
  function isOurUi(node) {
    if (!node) return false;
    var el = node.nodeType === 1 ? node : node.parentNode;
    return !!(el && el.closest && el.closest("[data-ve-ui]"));
  }
  // 合并同帧内的多次变更，且只重放"页面真实节点"的增删。
  function scheduleRender() {
    if (pendingRender) return;
    pendingRender = true;
    var raf = window.requestAnimationFrame || function (fn) { return setTimeout(fn, 16); };
    raf(function () { pendingRender = false; renderAll(); });
  }
  function observe() {
    if (mo) mo.disconnect();
    mo = new MutationObserver(function (records) {
      for (var i = 0; i < records.length; i++) {
        var rec = records[i];
        // 1) 变更发生在我们自己的 UI（面板/浮动按钮）内部 → 忽略
        if (isOurUi(rec.target)) continue;
        // 2) 增删的节点全部是我们自己的 UI → 忽略
        var nodes = Array.prototype.slice.call(rec.addedNodes)
          .concat(Array.prototype.slice.call(rec.removedNodes));
        if (nodes.length && nodes.every(isOurUi)) continue;
        // 3) 其余（页面真实节点被 SPA 重渲染）→ 合并后重放一次
        scheduleRender();
        return;
      }
    });
    mo.observe(document.body, { childList: true, subtree: true, attributes: false });
  }

  // ---- 浮动开关 ----------------------------------------------------------
  function mountToggle() {
    var b = document.createElement("button");
    b.setAttribute("data-ve-ui", "1");
    b.textContent = "🛠 微调";
    b.style.cssText = "position:fixed;right:14px;bottom:14px;z-index:2147483599;border:1px solid #6366f1;" +
      "background:#6366f1;color:#fff;border-radius:999px;padding:8px 14px;font:13px sans-serif;cursor:pointer;box-shadow:0 4px 14px rgba(99,102,241,.4)";
    var on = false;
    b.addEventListener("click", function () {
      on = !on;
      if (on) {
        document.addEventListener("mouseover", onOver, true);
        document.addEventListener("click", onPick, true);
        b.textContent = "✓ 微调中";
        b.style.background = "#16a34a";
      } else {
        document.removeEventListener("mouseover", onOver, true);
        document.removeEventListener("click", onPick, true);
        if (hoverEl) { hoverEl.style.outline = hoverEl.__veOutline || ""; hoverEl = null; }
        if (panelEl) panelEl.style.display = "none";
        b.textContent = "🛠 微调";
        b.style.background = "#6366f1";
      }
    });
    document.body.appendChild(b);
  }

  // ---- 小工具 ------------------------------------------------------------
  function slug(s) { return (s || "root").replace(/[^a-zA-Z0-9_-]/g, "_").slice(-40); }
  function escapeHtml(s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function rgbToHex(rgb) {
    var m = /rgba?\((\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(rgb || "");
    if (!m) return null;
    return "#" + [m[1], m[2], m[3]].map(function (x) { return ("0" + parseInt(x, 10).toString(16)).slice(-2); }).join("");
  }

  // ---- 公共 API ----------------------------------------------------------
  function init(userOpts) {
    Object.assign(opts, userOpts || {});
    plan.route = opts.route;
    loadLocal();
    if (opts.autoFetch) loadRemote().then(renderAll); else renderAll();
    observe();
    mountToggle();
    return api;
  }
  var api = {
    init: init,
    getPlan: function () { return exportJSON(); },
    exportCSS: exportCSS,
    exportJSON: function () { return JSON.stringify(exportJSON(), null, 2); },
    save: saveToServer,
    reset: function () { plan = { route: opts.route, changes: [] }; persist(); renderAll(); },
    render: renderAll,
  };
  return api;
});
