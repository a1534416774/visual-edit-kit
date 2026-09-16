/*!
 * VisualEditKit core — 框架无关、免构建的可视化页面微调引擎。
 *
 * 机制（借鉴 Design Mode 最稳的一招）：
 *   1. 激活时给元素按需打 data-ve-id="ve-N" 标记（轻量、可逆）。
 *   2. 所有编辑写成规则，注入唯一托管 <style id="ve-applied-styles">。
 *      样式用属性选择器 [data-ve-id="ve-N"]{prop:val} + !important，按 id 而非易变路径，
 *      因此整页刷新 / SPA 重渲染后由 core 自动重放、不会"刷新就丢"，且能压过原页面 id/class 规则。
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
    route: (typeof location !== "undefined" ? location.pathname : "/"),
    serverUrl: null,
    token: null,
    features: ["text", "color", "hide", "move", "token", "delete", "layout", "style", "tree", "comment"],
    pickMode: "click",
    autoFetch: true,
  };

  var plan = { route: opts.route, changes: [] };
  var counter = 0;
  var activeEl = null;
  var panelEl = null;
  var overlayEl = null;
  var hoverEl = null;
  var treeEl = null;
  var commentLayer = null;
  var engineOn = false;
  var undoStack = [];
  var redoStack = [];

  // ---- 工具 --------------------------------------------------------------
  function nextId() { return PREFIX + (++counter); }
  function isUi(el) { return !!(el && el.closest && el.closest(SKIP)); }
  function isOurNode(n) { return !!(n && n.closest && n.closest("[data-ve-ui]")); }
  function isPickable(el) {
    return el && el.nodeType === 1 && el.closest && el.closest(PICKABLE) && !isUi(el);
  }
  function q(id) { return document.querySelector("[" + DATA_ATTR + '="' + id + '"]'); }
  function getAssignedId(el) { return el.getAttribute(DATA_ATTR); }
  function ensureId(el) {
    var id = getAssignedId(el);
    if (!id) { id = nextId(); el.setAttribute(DATA_ATTR, id); }
    return id;
  }
  function pushHistory() {
    try { undoStack.push(JSON.stringify(plan)); if (undoStack.length > 100) undoStack.shift(); } catch (e) {}
    redoStack.length = 0;
  }
  function undo() {
    if (!undoStack.length) return;
    try { redoStack.push(JSON.stringify(plan)); plan = JSON.parse(undoStack.pop()); } catch (e) { return; }
    renderAll(); if (panelEl) { syncPanelTo(activeEl); }
  }
  function redo() {
    if (!redoStack.length) return;
    try { undoStack.push(JSON.stringify(plan)); plan = JSON.parse(redoStack.pop()); } catch (e) { return; }
    renderAll(); if (panelEl) { syncPanelTo(activeEl); }
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
          sheet.textContent += "[" + DATA_ATTR + '="' + c.id + '"] { ' + c.prop + ": " + c.value + " !important; }\n";
        } else if (c.kind === "hide") {
          sheet.textContent += "[" + DATA_ATTR + '="' + c.id + '"] { display: none !important; }\n';
        } else if (c.kind === "text") {
          var te = q(c.id);
          if (te) setTextOnly(te, c.value);
        } else if (c.kind === "move") {
          var me = q(c.id);
          if (me) moveToIndex(me, c.value);
        } else if (c.kind === "moveTo") {
          var d = q(c.id), t = q(c.targetId);
          if (!t && c.targetPath) t = resolvePath(c.targetPath);
          if (d && t && d !== t && !d.contains(t)) t.parentNode.insertBefore(d, t);
        } else if (c.kind === "delete") {
          var de = q(c.id);
          if (de && de.parentNode) de.parentNode.removeChild(de);
        } else if (c.kind === "comment") {
          /* 评论仅做标记，渲染在 commentLayer */
        } else if (c.kind === "token") {
          tokenSheet.textContent += "  " + c.prop + ": " + c.value + ";\n";
          tokenCount++;
        }
      } catch (e) { /* 元素可能被重渲染移除，忽略 */ }
    });
    tokenSheet.textContent += "}\n";
    if (tokenCount === 0 && tokenSheet.textContent === ":root {\n}\n") tokenSheet.textContent = "";
    if (activeEl && overlayEl && !overlayEl.parentNode) { try { document.body.appendChild(overlayEl); updateOverlay(activeEl); } catch (e) {} }
    if (treeEl && treeEl.style.display !== "none" && engineOn) buildTreeBody();
    positionComments();
  }
  function resolvePath(path) {
    if (!path) return null;
    try { return document.querySelector(path); } catch (e) { return null; }
  }

  // ---- 变更模型 ----------------------------------------------------------
  // change = { id, path, prop, value, kind }
  function upsert(change) {
    var i = plan.changes.findIndex(function (c) { return c.id === change.id && c.kind === change.kind && c.prop === change.prop; });
    if (i >= 0) {
      if (change.value === undefined || change.value === "" || (change.kind === "style" && change.value === "")) { plan.changes.splice(i, 1); }
      else { plan.changes[i] = change; }
    } else { if (change.value !== undefined && change.value !== "") plan.changes.push(change); }
    renderAll();
    persist();
    if (panelEl) renderChangesList();
  }
  function removeChange(c) {
    var i = plan.changes.indexOf(c);
    if (i >= 0) revertAt(i);
  }
  function findChange(id, kind, prop) {
    return plan.changes.find(function (c) { return c.id === id && c.kind === kind && (prop === undefined || c.prop === prop); });
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
      if (c.kind === "style") lines.push("[" + DATA_ATTR + '="' + c.id + '"] { ' + c.prop + ": " + c.value + " !important; }");
      else if (c.kind === "hide") lines.push("[" + DATA_ATTR + '="' + c.id + '"] { display: none !important; }');
      else if (c.kind === "text") lines.push("/* text -> " + c.path + " { content: '" + String(c.value).replace(/'/g, "\\'") + "' } */");
      else if (c.kind === "move") lines.push("/* move -> " + c.path + " { to-index: " + c.value + " } */");
      else if (c.kind === "moveTo") lines.push("/* move -> " + c.path + " { before: " + (c.targetPath || c.targetId) + " } */");
      else if (c.kind === "delete") lines.push("/* delete -> " + c.path + " */");
      else if (c.kind === "comment") lines.push("/* comment on " + c.path + ": " + String(c.value).replace(/\*\//g, "* /") + " */");
    });
    return lines.join("\n") + "\n";
  }
  function exportAI() {
    var L = [];
    L.push("# 页面微调方案（route: " + opts.route + "）");
    L.push("");
    L.push("请对以下元素做修改（路径为 CSS 选择器，可直接定位源码）：");
    L.push("");
    plan.changes.forEach(function (c) {
      if (c.kind === "token") L.push("- 设计令牌 `" + c.prop + "` → `" + c.value + "`");
      else if (c.kind === "text") L.push("- 元素 `" + c.path + "`：文字改为 `" + c.value + "`");
      else if (c.kind === "hide") L.push("- 元素 `" + c.path + "`：隐藏（display:none）");
      else if (c.kind === "delete") L.push("- 元素 `" + c.path + "`：删除");
      else if (c.kind === "move") L.push("- 元素 `" + c.path + "`：在同一父容器内移到第 " + (c.value + 1) + " 位");
      else if (c.kind === "moveTo") L.push("- 元素 `" + c.path + "`：移动到 `" + (c.targetPath || c.targetId) + "` 之前");
      else if (c.kind === "comment") L.push("- 元素 `" + c.path + "`：备注 `" + c.value + "`");
      else if (c.kind === "style") L.push("- 元素 `" + c.path + "`：" + c.prop + " → `" + c.value + "`");
    });
    if (!plan.changes.length) L.push("（暂无改动）");
    L.push("");
    L.push("## 等价 CSS");
    L.push("```css");
    L.push(exportCSS());
    L.push("```");
    return L.join("\n");
  }
  function copyText(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(text); return true; }
    } catch (e) {}
    try {
      var ta = document.createElement("textarea");
      ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.select();
      var ok = document.execCommand("copy"); ta.remove(); return ok;
    } catch (e) { return false; }
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
    showOverlay(el);
    if (treeEl && treeEl.style.display !== "none") buildTreeBody();
  }
  function deselect() {
    activeEl = null;
    if (panelEl) panelEl.style.display = "none";
    if (overlayEl) hideOverlay();
    if (treeEl) treeEl.style.display = "none";
  }
  function highlight(el) {
    if (!el) return;
    el.style.outline = "2px solid #16a34a";
    setTimeout(function () { el.style.outline = el.__veOutline || ""; }, 600);
  }

  // ---- 布局/尺寸：拖拽移动 + 8 向缩放 + 面板输入 -------------------------
  function showOverlay(el) {
    if (!el) return;
    if (!overlayEl) {
      overlayEl = document.createElement("div");
      overlayEl.setAttribute("data-ve-ui", "1");
      overlayEl.setAttribute("data-ve-overlay", "1");
      overlayEl.style.cssText = "position:fixed;z-index:2147483598;pointer-events:none;";
      overlayEl.innerHTML =
        '<div data-ve-move style="position:absolute;inset:0;cursor:move;pointer-events:auto;border:2px solid #16a34a;border-radius:4px;box-sizing:border-box"></div>' +
        handle("nw", "nwse-resize", "left:-7px;top:-7px") +
        handle("n", "ns-resize", "left:50%;top:-7px;margin-left:-7px") +
        handle("ne", "nesw-resize", "right:-7px;top:-7px") +
        handle("e", "ew-resize", "right:-7px;top:50%;margin-top:-7px") +
        handle("se", "nwse-resize", "right:-7px;bottom:-7px") +
        handle("s", "ns-resize", "left:50%;bottom:-7px;margin-left:-7px") +
        handle("sw", "nesw-resize", "left:-7px;bottom:-7px") +
        handle("w", "ew-resize", "left:-7px;top:50%;margin-top:-7px");
      document.body.appendChild(overlayEl);
      bindDragAndResize();
    }
    overlayEl.style.display = "block";
    updateOverlay(el);
  }
  function handle(dir, cursor, pos) {
    return '<div data-ve-resize="' + dir + '" style="position:absolute;width:14px;height:14px;background:#16a34a;border:2px solid #fff;border-radius:3px;cursor:' + cursor + ';pointer-events:auto;' + pos + '"></div>';
  }
  function updateOverlay(el) {
    if (!overlayEl || !el) return;
    var r = el.getBoundingClientRect();
    overlayEl.style.left = r.left + "px";
    overlayEl.style.top = r.top + "px";
    overlayEl.style.width = r.width + "px";
    overlayEl.style.height = r.height + "px";
  }
  function hideOverlay() { if (overlayEl) overlayEl.style.display = "none"; }
  function parseTranslate(el) {
    var mm = /matrix\(([^)]+)\)/.exec(getComputedStyle(el).transform || "");
    if (mm) { var p = mm[1].split(",").map(parseFloat); return { x: p[4] || 0, y: p[5] || 0 }; }
    return { x: 0, y: 0 };
  }
  function curSize(el) {
    var r = el.getBoundingClientRect();
    return { w: r.width, h: r.height };
  }
  function bindDragAndResize() {
    var moveH = overlayEl.querySelector("[data-ve-move]");
    var resizeHs = overlayEl.querySelectorAll("[data-ve-resize]");
    var drag = null;
    function onMove(e) {
      if (!drag) return;
      if (drag.mode === "move") {
        var dx = e.clientX - drag.sx + drag.bx;
        var dy = e.clientY - drag.sy + drag.by;
        drag.el.style.setProperty("transform", "translate(" + dx + "px," + dy + "px)", "important");
      } else {
        var t = parseTranslate(drag.el);
        var w = drag.sw, h = drag.sh, tx = t.x, ty = t.y;
        var ddx = e.clientX - drag.sx, ddy = e.clientY - drag.sy;
        if (drag.dir.indexOf("e") >= 0) w = drag.sw + ddx;
        if (drag.dir.indexOf("s") >= 0) h = drag.sh + ddy;
        if (drag.dir.indexOf("w") >= 0) { w = drag.sw - ddx; tx = t.x + ddx; }
        if (drag.dir.indexOf("n") >= 0) { h = drag.sh - ddy; ty = t.y + ddy; }
        w = Math.max(20, Math.round(w)); h = Math.max(20, Math.round(h));
        drag.el.style.setProperty("width", w + "px", "important");
        drag.el.style.setProperty("height", h + "px", "important");
        drag.el.style.setProperty("transform", "translate(" + Math.round(tx) + "px," + Math.round(ty) + "px)", "important");
      }
      updateOverlay(drag.el);
    }
    function onUp() {
      if (!drag) return;
      var el = drag.el, id = ensureId(el);
      if (drag.mode === "move") {
        var t = parseTranslate(el);
        upsert({ id: id, path: pathOf(el), kind: "style", prop: "transform", value: "translate(" + Math.round(t.x) + "px," + Math.round(t.y) + "px)" });
      } else {
        var r = el.getBoundingClientRect();
        var t2 = parseTranslate(el);
        upsert({ id: id, path: pathOf(el), kind: "style", prop: "transform", value: "translate(" + Math.round(t2.x) + "px," + Math.round(t2.y) + "px)" });
        upsert({ id: id, path: pathOf(el), kind: "style", prop: "width", value: Math.round(r.width) + "px" });
        upsert({ id: id, path: pathOf(el), kind: "style", prop: "height", value: Math.round(r.height) + "px" });
      }
      el.style.removeProperty("width"); el.style.removeProperty("height"); el.style.removeProperty("transform");
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      drag = null;
    }
    moveH.addEventListener("mousedown", function (e) {
      if (!activeEl) return;
      e.preventDefault(); e.stopPropagation();
      pushHistory();
      var b = parseTranslate(activeEl);
      drag = { mode: "move", sx: e.clientX, sy: e.clientY, bx: b.x, by: b.y, el: activeEl };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
    Array.prototype.forEach.call(resizeHs, function (h) {
      h.addEventListener("mousedown", function (e) {
        if (!activeEl) return;
        e.preventDefault(); e.stopPropagation();
        pushHistory();
        var s = curSize(activeEl); var b = parseTranslate(activeEl);
        drag = { mode: "resize", dir: h.getAttribute("data-ve-resize"), sx: e.clientX, sy: e.clientY, sw: s.w, sh: s.h, bx: b.x, by: b.y, el: activeEl };
        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", onUp);
      });
    });
  }

  // 通用样式输入绑定（layout + 扩展样式）
  function bindInputs(p, map) {
    map.forEach(function (pair) {
      var el = p.querySelector("[" + pair[0] + "]");
      if (!el) return;
      var evt = (el.tagName === "SELECT") ? "change" : (pair[2] || "input");
      el.addEventListener(evt, function () {
        if (!activeEl) return;
        var id = ensureId(activeEl);
        var v = el.value.trim();
        if (!v) { var c = findChange(id, "style", pair[1]); if (c) removeChange(c); return; }
        if (pair[3]) pushHistory();
        upsert({ id: id, path: pathOf(activeEl), kind: "style", prop: pair[1], value: v });
      });
    });
  }

  // ---- 面板 --------------------------------------------------------------
  function buildPanel() {
    if (panelEl) { document.body.appendChild(panelEl); return; }
    var p = document.createElement("div");
    p.setAttribute("data-ve-ui", "1");
    p.style.cssText = "position:absolute;z-index:2147483600;width:300px;background:#fff;" +
      "border:1px solid #e5e7eb;border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,.18);" +
      "font:13px/1.4 -apple-system,Segoe UI,Roboto,sans-serif;color:#111;padding:10px;";
    var layoutOn = opts.features.indexOf("layout") >= 0;
    var styleOn = opts.features.indexOf("style") >= 0;
    p.innerHTML =
      '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">' +
        '<b style="font-size:13px">🛠 页面微调</b>' +
        '<span style="cursor:pointer;opacity:.6" data-ve-close>✕</span>' +
      '</div>' +
      '<div style="display:flex;gap:6px;margin-bottom:6px">' +
        '<button data-ve-undo style="flex:1;border:1px solid #d1d5db;border-radius:6px;background:#f9fafb;cursor:pointer">↶ 撤销</button>' +
        '<button data-ve-redo style="flex:1;border:1px solid #d1d5db;border-radius:6px;background:#f9fafb;cursor:pointer">↷ 重做</button>' +
        (opts.features.indexOf("tree") >= 0 ? '<button data-ve-tree style="flex:1;border:1px solid #6366f1;border-radius:6px;background:#eef2ff;color:#4338ca;cursor:pointer">🗂 图层</button>' : '') +
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
      (layoutOn ?
        '<details style="margin-top:8px"><summary style="cursor:pointer;color:#6b7280;font-size:11px">📐 布局 / 尺寸（拖绿框移动，拖 8 个手柄缩放）</summary>' +
          '<div style="margin-top:6px">' +
            veRow('宽', 'data-ve-width', '高', 'data-ve-height') +
            veRow('外边距', 'data-ve-margin', '内边距', 'data-ve-padding') +
            veSelRow('显示', 'data-ve-display', ['block', 'flex', 'inline', 'inline-block', 'grid', 'none']) +
            veSelRow('排列', 'data-ve-flexdir', ['row', 'column']) +
            veSelRow('主轴对齐', 'data-ve-justify', ['flex-start', 'center', 'flex-end', 'space-between', 'space-around']) +
            veSelRow('交叉轴', 'data-ve-align', ['stretch', 'flex-start', 'center', 'flex-end']) +
            veRow('间距', 'data-ve-gap', '定位', 'data-ve-position') +
            veSelRow('浮动', 'data-ve-float', ['none', 'left', 'right']) +
          '</div>' +
        '</details>' : '') +
      (styleOn ?
        '<details style="margin-top:8px"><summary style="cursor:pointer;color:#6b7280;font-size:11px">🎛 扩展样式</summary>' +
          '<div style="margin-top:6px">' +
            veRow('圆角', 'data-ve-radius', '透明度', 'data-ve-opacity') +
            veRow('边框宽', 'data-ve-bw', '边框色', 'data-ve-bc') +
            veSelRow('边框样式', 'data-ve-bs', ['', 'solid', 'dashed', 'dotted', 'double']) +
            veRow('层级z', 'data-ve-z', '行高', 'data-ve-lh') +
            veSelRow('对齐', 'data-ve-ta', ['', 'left', 'center', 'right', 'justify']) +
            veSelRow('字体', 'data-ve-ff', ['', 'sans-serif', 'serif', 'monospace', 'system-ui', '"Microsoft YaHei"', 'Arial']) +
          '</div>' +
        '</details>' : '') +
      (opts.features.indexOf("move") >= 0 || opts.features.indexOf("hide") >= 0 || opts.features.indexOf("delete") >= 0 ?
        '<div style="display:flex;gap:6px;margin-top:8px">' +
          (opts.features.indexOf("move") >= 0 ? '<button data-ve-up style="flex:1;border:1px solid #d1d5db;border-radius:6px;background:#f9fafb;cursor:pointer">↑ 上移</button><button data-ve-down style="flex:1;border:1px solid #d1d5db;border-radius:6px;background:#f9fafb;cursor:pointer">↓ 下移</button>' : '') +
          (opts.features.indexOf("hide") >= 0 ? '<button data-ve-hide style="flex:1;border:1px solid #d1d5db;border-radius:6px;background:#f9fafb;cursor:pointer">隐藏</button>' : '') +
          (opts.features.indexOf("delete") >= 0 ? '<button data-ve-del style="flex:1;border:1px solid #fca5a5;border-radius:6px;background:#fef2f2;color:#b91c1c;cursor:pointer">删除</button>' : '') +
        '</div>' : '') +
      (opts.features.indexOf("comment") >= 0 ?
        '<details style="margin-top:8px"><summary style="cursor:pointer;color:#6b7280;font-size:11px">💬 评论 / 备注（钉在元素上）</summary>' +
          '<div style="margin-top:6px">' +
            '<textarea data-ve-comment rows="2" placeholder="给这个元素写备注，交 AI 时一并导出" style="width:100%;box-sizing:border-box;border:1px solid #d1d5db;border-radius:6px;padding:4px;font:12px sans-serif"></textarea>' +
            '<button data-ve-comment-add style="margin-top:4px;width:100%;border:1px solid #6366f1;border-radius:6px;background:#eef2ff;color:#4338ca;cursor:pointer">📌 钉备注</button>' +
          '</div>' +
        '</details>' : '') +
      (opts.features.indexOf("token") >= 0 ?
        '<details style="margin-top:8px"><summary style="cursor:pointer;color:#6b7280;font-size:11px">🎨 设计令牌(:root)</summary>' +
          '<div data-ve-tokens style="margin-top:6px;max-height:160px;overflow:auto"></div>' +
        '</details>' : '') +
      '<div data-ve-changes style="margin-top:8px;border-top:1px solid #f3f4f6;padding-top:6px;max-height:140px;overflow:auto"></div>' +
      '<div style="display:flex;gap:6px;margin-top:8px">' +
        '<button data-ve-export-css style="flex:1;border:1px solid #6366f1;border-radius:6px;background:#eef2ff;color:#4338ca;cursor:pointer">导 CSS</button>' +
        '<button data-ve-export-json style="flex:1;border:1px solid #6366f1;border-radius:6px;background:#eef2ff;color:#4338ca;cursor:pointer">导 JSON</button>' +
      '</div>' +
      '<button data-ve-ai style="margin-top:6px;width:100%;border:1px solid #0ea5e9;border-radius:6px;background:#f0f9ff;color:#0369a1;cursor:pointer">📋 复制 AI 指令</button>' +
      (opts.serverUrl ? '<div style="display:flex;gap:6px;margin-top:6px">' +
        '<button data-ve-save style="flex:1;border:1px solid #16a34a;border-radius:6px;background:#f0fdf4;color:#15803d;cursor:pointer">保存后端</button>' +
        '<button data-ve-reset style="flex:1;border:1px solid #d1d5db;border-radius:6px;background:#f9fafb;cursor:pointer">重置本页</button>' +
      '</div>' : '<button data-ve-reset style="width:100%;margin-top:6px;border:1px solid #d1d5db;border-radius:6px;background:#f9fafb;cursor:pointer">重置本页</button>');

    // 事件
    p.addEventListener("click", function (e) { e.stopPropagation(); });
    p.querySelector("[data-ve-close]").addEventListener("click", function () { deselect(); });
    if (opts.features.indexOf("tree") >= 0)
      p.querySelector("[data-ve-tree]").addEventListener("click", function () { toggleTree(); });
    p.querySelector("[data-ve-undo]").addEventListener("click", undo);
    p.querySelector("[data-ve-redo]").addEventListener("click", redo);
    if (opts.features.indexOf("text") >= 0) {
      var ta = p.querySelector("[data-ve-text]");
      ta.addEventListener("input", function () {
        if (!activeEl) return;
        var id = ensureId(activeEl);
        upsert({ id: id, path: pathOf(activeEl), kind: "text", prop: "text", value: ta.value });
      });
      ta.addEventListener("focusout", function () { if (activeEl) pushHistory(); });
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
      p.querySelector("[data-ve-bg]").addEventListener("change", function () { if (activeEl) pushHistory(); });
      p.querySelector("[data-ve-fg]").addEventListener("change", function () { if (activeEl) pushHistory(); });
      p.querySelector("[data-ve-bg-clear]").addEventListener("click", function () {
        var id = ensureId(activeEl); var c = findChange(id, "style", "background-color"); if (c) removeChange(c);
      });
      p.querySelector("[data-ve-fs]").addEventListener("change", function (e) {
        var id = ensureId(activeEl); if (!e.target.value) return; pushHistory();
        upsert({ id: id, path: pathOf(activeEl), kind: "style", prop: "font-size", value: e.target.value });
      });
      p.querySelector("[data-ve-fw]").addEventListener("change", function (e) {
        var id = ensureId(activeEl); if (!e.target.value) return; pushHistory();
        upsert({ id: id, path: pathOf(activeEl), kind: "style", prop: "font-weight", value: e.target.value });
      });
    }
    if (opts.features.indexOf("move") >= 0) {
      p.querySelector("[data-ve-up]").addEventListener("click", function () { pushHistory(); moveActive(-1); });
      p.querySelector("[data-ve-down]").addEventListener("click", function () { pushHistory(); moveActive(1); });
    }
    if (opts.features.indexOf("hide") >= 0) {
      p.querySelector("[data-ve-hide]").addEventListener("click", function () {
        pushHistory();
        var id = ensureId(activeEl); var c = findChange(id, "hide");
        if (c) removeChange(c); else upsert({ id: id, path: pathOf(activeEl), kind: "hide", prop: "display", value: "none" });
      });
    }
    if (opts.features.indexOf("delete") >= 0) {
      p.querySelector("[data-ve-del]").addEventListener("click", function () {
        if (!activeEl) return; pushHistory();
        var id = ensureId(activeEl);
        upsert({ id: id, path: pathOf(activeEl), kind: "delete", prop: "remove", value: "1" });
        deselect();
      });
    }
    if (layoutOn) bindInputs(p, [
      ["data-ve-width", "width"], ["data-ve-height", "height"], ["data-ve-margin", "margin"],
      ["data-ve-padding", "padding"], ["data-ve-display", "display"], ["data-ve-flexdir", "flex-direction"],
      ["data-ve-justify", "justify-content"], ["data-ve-align", "align-items"], ["data-ve-gap", "gap"],
      ["data-ve-position", "position"], ["data-ve-float", "float"]
    ]);
    if (styleOn) bindInputs(p, [
      ["data-ve-radius", "border-radius"], ["data-ve-opacity", "opacity"],
      ["data-ve-bw", "border-width"], ["data-ve-bc", "border-color", "input", 1],
      ["data-ve-bs", "border-style"], ["data-ve-z", "z-index"], ["data-ve-lh", "line-height"],
      ["data-ve-ta", "text-align"], ["data-ve-ff", "font-family"]
    ]);
    if (opts.features.indexOf("comment") >= 0) {
      p.querySelector("[data-ve-comment-add]").addEventListener("click", function () {
        if (!activeEl) return;
        var ta = p.querySelector("[data-ve-comment]");
        var v = (ta.value || "").trim(); if (!v) return; pushHistory();
        var id = ensureId(activeEl);
        upsert({ id: id, path: pathOf(activeEl), kind: "comment", prop: "note", value: v });
        ta.value = ""; positionComments();
      });
    }
    if (opts.features.indexOf("token") >= 0) {
      var det = p.querySelector("details");
      if (det) det.addEventListener("toggle", function () { if (det.open) renderTokens(); });
    }
    p.querySelector("[data-ve-export-css]").addEventListener("click", function () { download("visual-edit-" + slug(opts.route) + ".css", exportCSS(), "text/css"); });
    p.querySelector("[data-ve-export-json]").addEventListener("click", function () { download("visual-edit-" + slug(opts.route) + ".json", JSON.stringify(exportJSON(), null, 2), "application/json"); });
    p.querySelector("[data-ve-ai]").addEventListener("click", function () {
      var ok = copyText(exportAI());
      alert(ok ? "AI 指令已复制到剪贴板 ✓\n粘贴给任意编码 Agent 即可落地。" : "复制失败，已为你弹出指令窗口");
      if (!ok) window.prompt("复制下面的指令：", exportAI());
    });
    if (opts.serverUrl) {
      p.querySelector("[data-ve-save]").addEventListener("click", function () {
        saveToServer().then(function (ok) { alert(ok ? "已保存到后端 ✓" : "保存失败，检查 serverUrl / 网络"); });
      });
    }
    p.querySelector("[data-ve-reset]").addEventListener("click", function () {
      pushHistory();
      plan = { route: opts.route, changes: [] };
      persist(); renderAll();
      if (panelEl) { syncPanelTo(activeEl); renderChangesList(); }
    });

    panelEl = p;
    document.body.appendChild(p);
  }

  function moveActive(dir) {
    if (!activeEl) return;
    var id = ensureId(activeEl);
    var kids = activeEl.parentNode ? Array.prototype.slice.call(activeEl.parentNode.children) : [];
    var cur = kids.indexOf(activeEl);
    var target = cur + dir;
    upsert({ id: id, path: pathOf(activeEl), kind: "move", prop: "order", value: target });
  }
  function deleteActive() {
    if (!activeEl) return; pushHistory();
    var id = ensureId(activeEl);
    upsert({ id: id, path: pathOf(activeEl), kind: "delete", prop: "remove", value: "1" });
    deselect();
  }
  function nudge(dx, dy) {
    if (!activeEl) return; pushHistory();
    var el = activeEl; var id = ensureId(el);
    var t = parseTranslate(el);
    upsert({ id: id, path: pathOf(el), kind: "style", prop: "transform", value: "translate(" + Math.round(t.x + dx) + "px," + Math.round(t.y + dy) + "px)" });
  }

  function syncPanelTo(el) {
    if (!panelEl || !el) return;
    if (opts.features.indexOf("text") >= 0) panelEl.querySelector("[data-ve-text]").value = getTextOnly(el);
    if (opts.features.indexOf("color") >= 0) {
      panelEl.querySelector("[data-ve-bg]").value = rgbToHex(getComputedStyle(el).backgroundColor) || "#ffffff";
      panelEl.querySelector("[data-ve-fg]").value = rgbToHex(getComputedStyle(el).color) || "#000000";
    }
    var cs = getComputedStyle(el);
    var sv = function (sel, prop, computed, isColor) {
      var e = panelEl.querySelector(sel);
      if (!e) return;
      var c = findChange(getAssignedId(el) || "", "style", prop);
      if (c) e.value = c.value;
      else if (isColor) e.value = rgbToHex(computed) || "#ffffff";
      else e.value = (computed != null ? String(computed) : "");
    };
    if (opts.features.indexOf("layout") >= 0) {
      sv("[data-ve-width]", "width", cs.width);
      sv("[data-ve-height]", "height", cs.height);
      sv("[data-ve-margin]", "margin", cs.margin);
      sv("[data-ve-padding]", "padding", cs.padding);
      sv("[data-ve-display]", "display", cs.display);
      sv("[data-ve-flexdir]", "flex-direction", cs.flexDirection);
      sv("[data-ve-justify]", "justify-content", cs.justifyContent);
      sv("[data-ve-align]", "align-items", cs.alignItems);
      sv("[data-ve-gap]", "gap", cs.gap === "normal" ? "" : cs.gap);
      sv("[data-ve-position]", "position", cs.position);
      sv("[data-ve-float]", "float", cs.float);
    }
    if (opts.features.indexOf("style") >= 0) {
      sv("[data-ve-radius]", "border-radius", cs.borderRadius);
      sv("[data-ve-opacity]", "opacity", cs.opacity);
      sv("[data-ve-bw]", "border-width", cs.borderWidth);
      sv("[data-ve-bc]", "border-color", cs.borderColor, true);
      sv("[data-ve-bs]", "border-style", cs.borderStyle);
      sv("[data-ve-z]", "z-index", cs.zIndex);
      sv("[data-ve-lh]", "line-height", cs.lineHeight);
      sv("[data-ve-ta]", "text-align", cs.textAlign);
      sv("[data-ve-ff]", "font-family", cs.fontFamily);
    }
    renderChangesList();
  }
  function renderChangesList() {
    if (!panelEl) return;
    var box = panelEl.querySelector("[data-ve-changes]");
    if (!plan.changes.length) { box.innerHTML = '<div style="color:#9ca3af;font-size:11px">暂无变更</div>'; return; }
    box.innerHTML = plan.changes.map(function (c, i) {
      var label = c.kind === "text" ? "文字" : c.kind === "hide" ? "隐藏" : c.kind === "delete" ? "删除" :
        c.kind === "move" ? "排序" : c.kind === "moveTo" ? "移动" : c.kind === "comment" ? "评论" :
        c.kind === "token" ? c.prop : c.prop;
      var val = c.kind === "move" ? "→第" + (c.value + 1) + "位" : c.kind === "hide" || c.kind === "delete" ? "" :
        c.kind === "moveTo" ? "前:" + (c.targetPath || c.targetId || "").slice(0, 20) :
        c.kind === "comment" ? ("" + c.value).slice(0, 20) : ("" + c.value).slice(0, 24);
      return '<div style="display:flex;justify-content:space-between;align-items:center;padding:3px 0;border-bottom:1px dashed #f3f4f6">' +
        '<span style="font-size:11px;color:#374151">' + escapeHtml(label) + ' <span style="color:#9ca3af">' + escapeHtml(val) + '</span></span>' +
        '<span style="cursor:pointer;color:#dc2626;font-size:11px" data-ve-revert="' + i + '">↺</span></div>';
    }).join("");
    Array.prototype.forEach.call(box.querySelectorAll("[data-ve-revert]"), function (b) {
      b.addEventListener("click", function () { removeChange(plan.changes[parseInt(b.getAttribute("data-ve-revert"), 10)]); });
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
    var rootStyle = getComputedStyle(document.documentElement);
    Array.prototype.forEach.call(rootStyle, function (p) {
      if (p.indexOf("--") === 0 && !map[p]) map[p] = rootStyle.getPropertyValue(p).trim();
    });
    return Object.keys(map).map(function (k) { return { name: k, value: map[k] }; });
  }

  function positionPanelNear(el) {
    if (!panelEl || !el) return;
    var r = el.getBoundingClientRect();
    var x = Math.min(window.innerWidth - 310, r.left + window.scrollX);
    var y = r.bottom + window.scrollY + 8;
    if (y + 320 > window.innerHeight + window.scrollY) y = Math.max(window.scrollY, r.top + window.scrollY - 330);
    panelEl.style.left = Math.max(8, x) + "px";
    panelEl.style.top = y + "px";
  }

  // ---- 图层树 ------------------------------------------------------------
  var treeNodes = [];
  function toggleTree() {
    if (!treeEl) buildTree();
    if (treeEl.style.display === "none") { treeEl.style.display = "block"; buildTreeBody(); }
    else treeEl.style.display = "none";
  }
  function buildTree() {
    treeEl = document.createElement("div");
    treeEl.setAttribute("data-ve-ui", "1");
    treeEl.setAttribute("data-ve-tree", "1");
    treeEl.style.cssText = "position:fixed;right:14px;top:14px;z-index:2147483601;width:280px;max-height:78vh;overflow:auto;" +
      "background:#fff;border:1px solid #e5e7eb;border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,.18);" +
      "font:12px/1.4 -apple-system,Segoe UI,Roboto,sans-serif;color:#111;padding:8px;display:none";
    treeEl.innerHTML = '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">' +
      '<b>🗂 图层树</b><span style="cursor:pointer;opacity:.6" data-ve-tree-close>✕</span></div>' +
      '<div style="font-size:11px;color:#9ca3af;margin-bottom:4px">点节点选中；拖节点到另一个节点=移动到它之前（可跨容器）</div>' +
      '<div data-ve-tree-body></div>';
    treeEl.querySelector("[data-ve-tree-close]").addEventListener("click", function () { treeEl.style.display = "none"; });
    document.body.appendChild(treeEl);
    bindTreeDrag();
  }
  function buildTreeBody() {
    if (!treeEl) return;
    var body = treeEl.querySelector("[data-ve-tree-body]");
    treeNodes = [];
    body.innerHTML = treeNode(document.body, 0, 0, 0);
    Array.prototype.forEach.call(body.querySelectorAll("[data-ve-tn]"), function (div) {
      div.addEventListener("click", function (e) {
        e.stopPropagation();
        var idx = parseInt(div.getAttribute("data-ve-tn"), 10);
        var el = treeNodes[idx];
        if (el && el.nodeType === 1 && document.body.contains(el)) select(el);
      });
    });
  }
  function treeNode(node, depth, count, guard) {
    if (depth > 10 || count > 500 || guard > 4000) return "";
    if (node.nodeType !== 1) return "";
    if (isOurNode(node)) return "";
    if (node.tagName === "SCRIPT" || node.tagName === "STYLE" || node.tagName === "LINK" || node.tagName === "META") return "";
    var label = node.tagName.toLowerCase();
    if (node.id) label += "#" + node.id;
    else if (node.classList && node.classList.length) label += "." + Array.prototype.slice.call(node.classList, 0, 2).join(".");
    var txt = getTextOnly(node).trim().replace(/\s+/g, " ").slice(0, 18);
    var idx = treeNodes.length; treeNodes.push(node);
    var active = (node === activeEl) ? "background:#dcfce7;" : "";
    var hasKids = node.children && node.children.length;
    var html = '<div data-ve-tn="' + idx + '" draggable="false" style="padding:2px 0;padding-left:' + (depth * 12 + 4) + 'px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;' + active + '" title="' + escapeHtml(pathOf(node)) + '">' +
      escapeHtml(label) + (txt ? ' <span style="color:#9ca3af">' + escapeHtml(txt) + '</span>' : '') + '</div>';
    if (hasKids) {
      for (var i = 0; i < node.children.length; i++) {
        html += treeNode(node.children[i], depth + 1, count + 1, guard + 1);
      }
    }
    return html;
  }
  var treeDrag = null;
  function bindTreeDrag() {
    var body = treeEl.querySelector("[data-ve-tree-body]");
    body.addEventListener("mousedown", function (e) {
      var div = e.target.closest("[data-ve-tn]");
      if (!div) return;
      treeDrag = { idx: parseInt(div.getAttribute("data-ve-tn"), 10), div: div, target: null };
      div.style.background = "#fde68a";
    });
    body.addEventListener("mouseover", function (e) {
      if (!treeDrag) return;
      var div = e.target.closest("[data-ve-tn]");
      if (!div || div === treeDrag.div) { treeDrag.target = null; return; }
      if (treeDrag.target && treeDrag.target !== div) treeDrag.target.style.outline = "";
      div.style.outline = "1px solid #16a34a";
      treeDrag.target = div;
    });
    document.addEventListener("mouseup", function () {
      if (!treeDrag) return;
      treeDrag.div.style.background = "";
      var targetDiv = treeDrag.target;
      if (targetDiv) targetDiv.style.outline = "";
      if (targetDiv && targetDiv !== treeDrag.div) {
        var dEl = treeNodes[treeDrag.idx], tEl = treeNodes[parseInt(targetDiv.getAttribute("data-ve-tn"), 10)];
        if (dEl && tEl && dEl !== tEl && !dEl.contains(tEl) && tEl.parentNode) {
          pushHistory();
          var dId = ensureId(dEl), tId = ensureId(tEl);
          tEl.parentNode.insertBefore(dEl, tEl);
          upsert({ id: dId, path: pathOf(dEl), kind: "moveTo", prop: "order", value: "0", targetId: tId, targetPath: pathOf(tEl) });
        }
      }
      treeDrag = null;
      buildTreeBody();
    });
  }

  // ---- 评论标记层 --------------------------------------------------------
  function ensureCommentLayer() {
    if (commentLayer) return;
    commentLayer = document.createElement("div");
    commentLayer.setAttribute("data-ve-ui", "1");
    commentLayer.style.cssText = "position:fixed;inset:0;z-index:2147483590;pointer-events:none;";
    document.body.appendChild(commentLayer);
  }
  function positionComments() {
    if (!commentLayer || !engineOn) return;
    ensureCommentLayer();
    var marks = {};
    plan.changes.forEach(function (c) { if (c.kind === "comment") marks[c.id] = (marks[c.id] ? marks[c.id] + " | " : "") + c.value; });
    commentLayer.innerHTML = "";
    Object.keys(marks).forEach(function (id) {
      var el = q(id);
      if (!el) return;
      var r = el.getBoundingClientRect();
      var m = document.createElement("div");
      m.style.cssText = "position:absolute;left:" + (r.right - 18) + "px;top:" + (r.top - 6) + "px;width:18px;height:18px;" +
        "border-radius:50%;background:#f59e0b;color:#fff;font:11px sans-serif;text-align:center;line-height:18px;" +
        "pointer-events:auto;cursor:pointer;box-shadow:0 1px 4px rgba(0,0,0,.3)";
      m.textContent = "💬";
      m.title = marks[id];
      m.addEventListener("click", function (e) { e.stopPropagation(); if (el && document.body.contains(el)) select(el); });
      commentLayer.appendChild(m);
    });
  }

  // ---- SPA 重渲染保护 ----------------------------------------------------
  var mo, pendingRender = false;
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
        if (isOurNode(rec.target)) continue;
        var nodes = Array.prototype.slice.call(rec.addedNodes)
          .concat(Array.prototype.slice.call(rec.removedNodes));
        if (nodes.length && nodes.every(isOurNode)) continue;
        scheduleRender();
        return;
      }
    });
    mo.observe(document.body, { childList: true, subtree: true, attributes: false });
  }

  // ---- 浮动开关 + 键盘 ---------------------------------------------------
  function mountToggle() {
    var b = document.createElement("button");
    b.setAttribute("data-ve-ui", "1");
    b.textContent = "🛠 微调";
    b.style.cssText = "position:fixed;right:14px;bottom:14px;z-index:2147483599;border:1px solid #6366f1;" +
      "background:#6366f1;color:#fff;border-radius:999px;padding:8px 14px;font:13px sans-serif;cursor:pointer;box-shadow:0 4px 14px rgba(99,102,241,.4)";
    b.addEventListener("click", function () {
      engineOn = !engineOn;
      if (engineOn) {
        document.addEventListener("mouseover", onOver, true);
        document.addEventListener("click", onPick, true);
        b.textContent = "✓ 微调中";
        b.style.background = "#16a34a";
        if (commentLayer) commentLayer.style.display = "block";
      } else {
        document.removeEventListener("mouseover", onOver, true);
        document.removeEventListener("click", onPick, true);
        if (hoverEl) { hoverEl.style.outline = hoverEl.__veOutline || ""; hoverEl = null; }
        deselect();
        if (commentLayer) commentLayer.style.display = "none";
        if (treeEl) treeEl.style.display = "none";
        b.textContent = "🛠 微调";
        b.style.background = "#6366f1";
      }
    });
    document.body.appendChild(b);

    document.addEventListener("keydown", function (e) {
      if (!engineOn) return;
      var tag = (e.target.tagName || "").toLowerCase();
      var inField = tag === "input" || tag === "textarea" || tag === "select" || e.target.isContentEditable;
      if (e.key === "Escape") { if (inField && e.target.blur) e.target.blur(); deselect(); return; }
      if (inField) return;
      if ((e.ctrlKey || e.metaKey) && (e.key === "z" || e.key === "Z")) { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
      if ((e.ctrlKey || e.metaKey) && (e.key === "y" || e.key === "Y")) { e.preventDefault(); redo(); return; }
      if (!activeEl) return;
      if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); deleteActive(); return; }
      var step = e.shiftKey ? 10 : 1;
      if (e.key === "ArrowLeft") { e.preventDefault(); nudge(-step, 0); }
      else if (e.key === "ArrowRight") { e.preventDefault(); nudge(step, 0); }
      else if (e.key === "ArrowUp") { e.preventDefault(); nudge(0, -step); }
      else if (e.key === "ArrowDown") { e.preventDefault(); nudge(0, step); }
    });
  }

  // ---- 小工具 ------------------------------------------------------------
  function slug(s) { return (s || "root").replace(/[^a-zA-Z0-9_-]/g, "_").slice(-40); }
  function escapeHtml(s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function rgbToHex(rgb) {
    var m = /rgba?\((\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(rgb || "");
    if (!m) return null;
    return "#" + [m[1], m[2], m[3]].map(function (x) { return ("0" + parseInt(x, 10).toString(16)).slice(-2); }).join("");
  }
  function veRow(label1, attr1, label2, attr2) {
    return '<div style="display:flex;gap:6px;align-items:center;margin:4px 0">' +
      '<span style="width:48px;font-size:11px;color:#6b7280">' + label1 + '</span>' +
      '<input ' + attr1 + ' placeholder="auto" style="flex:1;min-width:0;border:1px solid #d1d5db;border-radius:6px;padding:3px;font:12px sans-serif">' +
      '<span style="width:48px;font-size:11px;color:#6b7280">' + label2 + '</span>' +
      '<input ' + attr2 + ' placeholder="auto" style="flex:1;min-width:0;border:1px solid #d1d5db;border-radius:6px;padding:3px;font:12px sans-serif">' +
      '</div>';
  }
  function veSelRow(label, attr, optsArr) {
    var o = '<option value="">不改</option>' + optsArr.map(function (v) { return '<option value="' + v + '">' + v + '</option>'; }).join("");
    return '<div style="display:flex;gap:6px;align-items:center;margin:4px 0">' +
      '<span style="width:48px;font-size:11px;color:#6b7280">' + label + '</span>' +
      '<select ' + attr + ' style="flex:1;min-width:0;border:1px solid #d1d5db;border-radius:6px;padding:3px;font:12px sans-serif">' + o + '</select>' +
      '</div>';
  }

  // ---- 公共 API ----------------------------------------------------------
  function init(userOpts) {
    Object.assign(opts, userOpts || {});
    plan.route = opts.route;
    loadLocal();
    if (opts.autoFetch) loadRemote().then(renderAll); else renderAll();
    observe();
    mountToggle();
    window.addEventListener("scroll", function () {
      if (activeEl && overlayEl) updateOverlay(activeEl);
      if (engineOn && commentLayer) positionComments();
    }, true);
    window.addEventListener("resize", function () {
      if (activeEl && overlayEl) updateOverlay(activeEl);
      if (engineOn && commentLayer) positionComments();
    });
    return api;
  }
  var api = {
    init: init,
    getPlan: function () { return exportJSON(); },
    exportCSS: exportCSS,
    exportJSON: function () { return JSON.stringify(exportJSON(), null, 2); },
    exportAI: exportAI,
    save: saveToServer,
    reset: function () { pushHistory(); plan = { route: opts.route, changes: [] }; persist(); renderAll(); },
    render: renderAll,
    undo: undo,
    redo: redo,
  };
  return api;
});
