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
    features: ["text", "color", "hide", "move", "token", "delete", "layout", "style", "tree", "comment", "add", "duplicate", "variants"],
    pickMode: "click",
    autoFetch: true,
  };

  var plan = { route: opts.route, changes: [] };
  var counter = 0;
  var activeEl = null;
  var lastActiveEl = null;
  var panelUserPos = null;   // 用户手动拖过面板后的位置（记住，不再自动跟随元素）
  var POS_KEY = "ve_panel_pos";
  var panelEl = null;
  var overlayEl = null;
  var hoverEl = null;
  var treeEl = null;
  var commentLayer = null;
  var engineOn = false;
  var undoStack = [];
  var redoStack = [];
  var rendering = false;

  // ---- 工具 --------------------------------------------------------------
  function nextId() { return PREFIX + (++counter); }
  function isUi(el) { return !!(el && el.closest && el.closest(SKIP)); }
  function isOurNode(n) { return !!(n && n.closest && n.closest("[data-ve-ui]")); }
  function isPickable(el) {
    return el && el.nodeType === 1 && el.closest && el.closest(PICKABLE) && !isUi(el);
  }
  // 穿透点选：忽略自家 UI（绿框/面板/吸附线/评论标记），返回命中点下最内层的可拾取元素
  function hitTest(x, y) {
    var stack = [];
    try { stack = document.elementsFromPoint(x, y) || []; } catch (e) { stack = []; }
    for (var i = 0; i < stack.length; i++) {
      var n = stack[i];
      if (!n || n.nodeType !== 1 || isUi(n)) continue;
      var pick = n.closest(PICKABLE);
      if (!pick || isUi(pick)) continue;
      return pick;
    }
    return null;
  }
  function q(id) { return document.querySelector("[" + DATA_ATTR + '="' + id + '"]'); }
  function getAssignedId(el) { return el.getAttribute(DATA_ATTR); }
  function ensureId(el) {
    var id = getAssignedId(el);
    if (!id) { id = nextId(); el.setAttribute(DATA_ATTR, id); }
    return id;
  }
  // 关键：按文档顺序给所有可拾取元素确定性地分配 data-ve-id。
  // 同页面同 DOM 顺序下，每次刷新后分配出的 id 完全一致，
  // 这样 loadLocal/loadRemote 读回的方案才能靠 [data-ve-id=...] 正确重放（否则刷新即丢）。
  // 仅给尚无 id 的元素补号，已分配者保持不变，避免会话内/重渲染时 id 漂移。
  function assignAllIds() {
    try {
      var nodes = document.querySelectorAll(PICKABLE);
      Array.prototype.forEach.call(nodes, function (el) {
        if (isUi(el)) return;
        if (!getAssignedId(el)) el.setAttribute(DATA_ATTR, nextId());
      });
    } catch (e) {}
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
  // ---- 变更目标解析（防"套错元素"）---------------------------------------
  // 方案里的 data-ve-id 是"会话内按需分配"的，跨刷新/跨构建会漂移；path 才是编辑当时
  // 记录的稳定 CSS 路径。所以：**以 path 为准解析元素，id 只做兜底**，再加一道 tag 指纹
  // 校验——解析出的元素结构明显不符时，宁可不应用，也不要把样式/隐藏错套到别的元素上。
  // （历史事故：header 的宽高变更被套到了导航项上，直接把顶部菜单栏搞没了。）
  function fpOf(el) { return el && el.tagName ? el.tagName.toLowerCase() : ""; }
  function targetFor(c) {
    var el = c.path ? resolvePath(c.path) : null;
    if (el && (isUi(el) || (c.fp && fpOf(el) !== c.fp))) el = null;
    if (el) return el;
    var byId = c.id ? q(c.id) : null;
    if (byId && (isUi(byId) || (c.fp && fpOf(byId) !== c.fp))) byId = null;
    return byId;
  }
  // 规则锚点：CSS 规则一律写在"实际解析到的元素"的 id 上，而不是方案里记录的旧 id
  function anchorSel(c) {
    var el = targetFor(c);
    return el ? "[" + DATA_ATTR + '="' + ensureId(el) + '"]' : null;
  }
  function renderAll() {
    rendering = true;
    assignAllIds();            // 先补齐确定性 id，确保方案按 id 重放能命中元素
    var addIds = {};
    plan.changes.forEach(function (c) { if (c.kind === "add") addIds[c.id] = true; });
    try {
      Array.prototype.forEach.call(document.querySelectorAll("[" + DATA_ATTR + "]"), function (el) {
        if (el.__veAdded && !addIds[getAssignedId(el)]) { if (el.parentNode) el.parentNode.removeChild(el); }
      });
    } catch (e) {}
    var sheet = getSheet(STYLE_ID);
    var tokenSheet = getSheet(TOKEN_STYLE_ID);
    sheet.textContent = "";
    tokenSheet.textContent = ":root {\n";
    var tokenCount = 0;
    plan.changes.forEach(function (c) {
      try {
        if (c.kind === "style") {
          var ss = anchorSel(c);
          if (ss) sheet.textContent += ss + " { " + c.prop + ": " + c.value + " !important; }\n";
        } else if (c.kind === "hide") {
          var hs = anchorSel(c);
          if (hs) sheet.textContent += hs + " { display: none !important; }\n";
        } else if (c.kind === "text") {
          var te = targetFor(c);
          if (te) setTextOnly(te, c.value);
        } else if (c.kind === "move") {
          var me = targetFor(c);
          if (me) moveToIndex(me, c.value);
        } else if (c.kind === "moveTo") {
          var d = targetFor(c), t = q(c.targetId);
          if (!t && c.targetPath) t = resolvePath(c.targetPath);
          if (d && t && d !== t && !d.contains(t)) t.parentNode.insertBefore(d, t);
        } else if (c.kind === "add") {
          if (q(c.id)) return;
          var ref = q(c.refId);
          if (!ref && c.path) ref = resolvePath(c.path);
          if (!ref && c.targetPath) ref = resolvePath(c.targetPath);
          if (!ref || !ref.parentNode) return;
          var tmp = document.createElement("div");
          tmp.innerHTML = c.value || "";
          var newEl = tmp.firstElementChild;
          if (!newEl) return;
          newEl.setAttribute(DATA_ATTR, c.id);
          newEl.__veAdded = true;
          if (c.position === "inside") ref.appendChild(newEl);
          else if (c.position === "after") ref.parentNode.insertBefore(newEl, ref.nextSibling);
          else ref.parentNode.insertBefore(newEl, ref);
        } else if (c.kind === "delete") {
          var de = targetFor(c);
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
    if (activeEl && overlayEl && overlayEl.style.display !== "none") { try { updateOverlay(activeEl); } catch (e) {} }
    if (treeEl && treeEl.style.display !== "none" && engineOn) buildTreeBody();
    positionComments();
    rendering = false;
  }
  function resolvePath(path) {
    if (!path) return null;
    try { return document.querySelector(path); } catch (e) { return null; }
  }

  // ---- 变更模型 ----------------------------------------------------------
  // change = { id, path, prop, value, kind }
  function upsert(change) {
    // 记录目标元素 tag 指纹：跨刷新重放时用它校验"path/id 解析出的还是同一类元素"，
    // 避免旧方案里的漂移 id 把某个元素的样式/隐藏套到别的元素上。
    if (change && !change.fp && change.kind !== "token") {
      var pe = (change.id && change.id.charAt(0) === ":") ? null : (q(change.id) || resolvePath(change.path));
      if (pe && pe.tagName) change.fp = pe.tagName.toLowerCase();
    }
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
      var ref = anchorSel(c) || "[" + DATA_ATTR + '="' + c.id + '"]';
      if (c.kind === "style") lines.push(ref + " { " + c.prop + ": " + c.value + " !important; }");
      else if (c.kind === "hide") lines.push(ref + " { display: none !important; }");
      else if (c.kind === "text") lines.push("/* text -> " + c.path + " { content: '" + String(c.value).replace(/'/g, "\\'") + "' } */");
      else if (c.kind === "move") lines.push("/* move -> " + c.path + " { to-index: " + c.value + " } */");
      else if (c.kind === "moveTo") lines.push("/* move -> " + c.path + " { before: " + (c.targetPath || c.targetId) + " } */");
      else if (c.kind === "delete") lines.push("/* delete -> " + c.path + " */");
      else if (c.kind === "add") lines.push("/* add -> " + c.position + " " + (c.path || c.refId || "") + " : " + String(c.value).replace(/\s+/g, " ").slice(0, 50) + " */");
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
      else if (c.kind === "add") L.push("- 在 `" + (c.path || c.refId || "") + "` 的" + (c.position === "inside" ? "内部" : c.position === "after" ? "后面" : "前面") + "插入新元素：" + String(c.value).replace(/\s+/g, " ").slice(0, 60));
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
    // 关键：标记为引擎自身 UI。否则微调开启时 document 上的捕获态 onPick 会把这次
    // 程序化点击当作"拾取元素"，调用 e.preventDefault() 取消 <a download> 的默认下载行为
    // —— 现象就是"点了导出只弹窗、不下载"。
    a.setAttribute("data-ve-ui", "1");
    a.style.display = "none";
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
    lastActiveEl = el;
    var id = ensureId(el);
    buildPanel();
    showPanel();               // 关键：deselect() 会把面板 display:none，再次选中必须显式恢复
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
  function showPanel() {
    if (!panelEl) return;
    panelEl.style.display = "block";
    panelEl.style.visibility = "visible";
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
    var dragged = false;   // 本次交互是否真的发生了拖拽（用于区分"拖拽"与"点选"）
    function onMove(e) {
      if (!drag) return;
      if (Math.abs(e.clientX - drag.sx) + Math.abs(e.clientY - drag.sy) > 3) drag.moved = true;
      if (drag.mode === "move") {
        var dx = e.clientX - drag.sx + drag.bx;
        var dy = e.clientY - drag.sy + drag.by;
        var s = snapMove(drag.el, dx, dy);
        dx = s.dx; dy = s.dy;
        drag.el.style.setProperty("transform", "translate(" + dx + "px," + dy + "px)", "important");
      } else {
        var t = parseTranslate(drag.el);
        var w = drag.sw, h = drag.sh, tx = t.x, ty = t.y;
        var ddx = e.clientX - drag.sx, ddy = e.clientY - drag.sy;
        if (drag.dir.indexOf("e") >= 0) w = drag.sw + ddx;
        if (drag.dir.indexOf("s") >= 0) h = drag.sh + ddy;
        if (drag.dir.indexOf("w") >= 0) { w = drag.sw - ddx; tx = t.x + ddx; }
        if (drag.dir.indexOf("n") >= 0) { h = drag.sh - ddy; ty = t.y + ddy; }
        w = Math.max(20, Math.round(w / 8) * 8); h = Math.max(20, Math.round(h / 8) * 8);
        drag.el.style.setProperty("width", w + "px", "important");
        drag.el.style.setProperty("height", h + "px", "important");
        drag.el.style.setProperty("transform", "translate(" + Math.round(tx) + "px," + Math.round(ty) + "px)", "important");
      }
      updateOverlay(drag.el);
    }
    function onUp() {
      if (!drag) return;
      var el = drag.el, id = ensureId(el);
      dragged = !!drag.moved;
      if (drag.moved) {
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
      }
      el.style.removeProperty("width"); el.style.removeProperty("height"); el.style.removeProperty("transform");
      clearSnapGuides();
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      drag = null;
      if (el === activeEl) { updateOverlay(el); positionPanelNear(el); }
    }
    // 绿框本身不能"吃掉"点击：单击（非拖拽）时做穿透点选，
    // 否则元素一旦被选中，它内部的任何子元素都点不到，看起来就像"点哪儿都没反应、面板再也不出现"。
    moveH.addEventListener("click", function (e) {
      if (dragged) { dragged = false; return; }
      e.preventDefault(); e.stopPropagation();
      var target = hitTest(e.clientX, e.clientY);
      if (target) { if (target !== activeEl) select(target); else showPanel(); }
    });
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
    if (panelEl) { document.body.appendChild(panelEl); showPanel(); return; }
    var p = document.createElement("div");
    p.setAttribute("data-ve-ui", "1");
    p.style.cssText = "position:fixed;z-index:2147483600;width:300px;background:#fff;" +
      "border:1px solid #e5e7eb;border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,.18);" +
      "max-height:calc(100vh - 16px);overflow:auto;overscroll-behavior:contain;" +
      "font:13px/1.4 -apple-system,Segoe UI,Roboto,sans-serif;color:#111;padding:10px;";
    var layoutOn = opts.features.indexOf("layout") >= 0;
    var styleOn = opts.features.indexOf("style") >= 0;
    p.innerHTML =
      '<div data-ve-drag style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;cursor:move;user-select:none" title="拖动此处移动面板；双击恢复自动跟随">' +
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
      (opts.features.indexOf("add") >= 0 ?
        '<details style="margin-top:8px"><summary style="cursor:pointer;color:#6b7280;font-size:11px">➕ 插入元素（先选中参照）</summary>' +
          '<div style="margin-top:6px">' +
            '<div style="display:flex;gap:6px;align-items:center;margin:4px 0">' +
              '<span style="width:48px;font-size:11px;color:#6b7280">类型</span>' +
              '<select data-ve-add-type style="flex:1;min-width:0;border:1px solid #d1d5db;border-radius:6px;padding:3px;font:12px sans-serif">' +
                '<option value="div">容器</option><option value="text">文本</option><option value="button">按钮</option><option value="heading">标题</option><option value="image">图片</option><option value="hr">分隔线</option>' +
              '</select>' +
            '</div>' +
            '<div style="display:flex;gap:6px;align-items:center;margin:4px 0">' +
              '<span style="width:48px;font-size:11px;color:#6b7280">位置</span>' +
              '<select data-ve-add-pos style="flex:1;min-width:0;border:1px solid #d1d5db;border-radius:6px;padding:3px;font:12px sans-serif">' +
                '<option value="before">选中前</option><option value="after">选中后</option><option value="inside">选中内</option>' +
              '</select>' +
            '</div>' +
            '<button data-ve-add style="margin-top:4px;width:100%;border:1px solid #16a34a;border-radius:6px;background:#f0fdf4;color:#15803d;cursor:pointer">➕ 插入</button>' +
          '</div>' +
        '</details>' : '') +
      (opts.features.indexOf("duplicate") >= 0 ?
        '<div style="margin-top:8px"><button data-ve-dup style="width:100%;border:1px solid #d1d5db;border-radius:6px;background:#f9fafb;cursor:pointer">⧉ 复制元素 (Ctrl+D)</button></div>' : '') +
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
      (opts.features.indexOf("variants") >= 0 ?
        '<details style="margin-top:8px"><summary style="cursor:pointer;color:#6b7280;font-size:11px">🗂 方案版本（本地多套可切换）</summary>' +
          '<div style="margin-top:6px">' +
            '<select data-ve-variant style="width:100%;box-sizing:border-box;border:1px solid #d1d5db;border-radius:6px;padding:3px;font:12px sans-serif"></select>' +
            '<div style="display:flex;gap:6px;margin-top:4px">' +
              '<button data-ve-var-save style="flex:1;border:1px solid #16a34a;border-radius:6px;background:#f0fdf4;color:#15803d;cursor:pointer">覆盖保存</button>' +
              '<button data-ve-var-new style="flex:1;border:1px solid #6366f1;border-radius:6px;background:#eef2ff;color:#4338ca;cursor:pointer">另存为</button>' +
              '<button data-ve-var-del style="flex:1;border:1px solid #d1d5db;border-radius:6px;background:#f9fafb;cursor:pointer">删除</button>' +
            '</div>' +
          '</div>' +
        '</details>' : '') +
      '<div data-ve-changes style="margin-top:8px;border-top:1px solid #f3f4f6;padding-top:6px;max-height:140px;overflow:auto"></div>' +
      '<div style="display:flex;gap:6px;margin-top:8px">' +
        '<button data-ve-export-css style="flex:1;border:1px solid #6366f1;border-radius:6px;background:#eef2ff;color:#4338ca;cursor:pointer">导 CSS</button>' +
        '<button data-ve-export-json style="flex:1;border:1px solid #6366f1;border-radius:6px;background:#eef2ff;color:#4338ca;cursor:pointer">导 JSON</button>' +
      '</div>' +
      '<button data-ve-ai style="margin-top:6px;width:100%;border:1px solid #0ea5e9;border-radius:6px;background:#f0f9ff;color:#0369a1;cursor:pointer">📋 复制 AI 指令</button>' +
      (opts.serverUrl ? '<div style="display:flex;gap:6px;margin-top:6px">' +
        '<button data-ve-save style="flex:1;border:1px solid #16a34a;border-radius:6px;background:#f0fdf4;color:#15803d;cursor:pointer">保存后端</button>' +
        '<button data-ve-reset style="flex:1;border:1px solid #fca5a5;border-radius:6px;background:#fef2f2;color:#b91c1c;cursor:pointer">🧹 清空本页</button>' +
      '</div>' : '<button data-ve-reset style="width:100%;margin-top:6px;border:1px solid #fca5a5;border-radius:6px;background:#fef2f2;color:#b91c1c;cursor:pointer">🧹 清空本页改动</button>');

    // 事件
    p.addEventListener("click", function (e) { e.stopPropagation(); });
    p.querySelector("[data-ve-close]").addEventListener("click", function () { deselect(); });
    // 拖动标题栏移动面板；双击恢复"自动跟随选中元素"
    (function bindPanelDrag() {
      var dh = p.querySelector("[data-ve-drag]");
      if (!dh) return;
      dh.addEventListener("mousedown", function (e) {
        if (e.target && e.target.closest && e.target.closest("[data-ve-close]")) return;
        e.preventDefault(); e.stopPropagation();
        var r = p.getBoundingClientRect();
        var ox = e.clientX - r.left, oy = e.clientY - r.top;
        function mv(ev) {
          panelUserPos = {
            x: Math.max(0, Math.min(window.innerWidth - 40, Math.round(ev.clientX - ox))),
            y: Math.max(0, Math.min(window.innerHeight - 20, Math.round(ev.clientY - oy))),
          };
          panelEl.style.left = panelUserPos.x + "px";
          panelEl.style.top = panelUserPos.y + "px";
        }
        function up() {
          document.removeEventListener("mousemove", mv);
          document.removeEventListener("mouseup", up);
          if (panelUserPos) { try { localStorage.setItem(POS_KEY, JSON.stringify(panelUserPos)); } catch (err) {} }
          clampPanel();
        }
        document.addEventListener("mousemove", mv);
        document.addEventListener("mouseup", up);
      });
      dh.addEventListener("dblclick", function () {
        panelUserPos = null;
        try { localStorage.removeItem(POS_KEY); } catch (err) {}
        if (activeEl) positionPanelNear(activeEl);
      });
    })();
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
    if (opts.features.indexOf("add") >= 0) {
      p.querySelector("[data-ve-add]").addEventListener("click", function () {
        if (!activeEl) { alert("先在页面上点选一个元素，作为插入位置的参照。"); return; }
        addElement(p.querySelector("[data-ve-add-type]").value, p.querySelector("[data-ve-add-pos]").value);
      });
    }
    if (opts.features.indexOf("duplicate") >= 0) {
      p.querySelector("[data-ve-dup]").addEventListener("click", duplicateActive);
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
    if (opts.features.indexOf("variants") >= 0) {
      renderVariantSelect();
      p.querySelector("[data-ve-var-save]").addEventListener("click", function () {
        var sel = p.querySelector("[data-ve-variant]");
        var name = sel ? sel.value : "";
        if (!name) { name = window.prompt("方案名称：", "方案" + (listVariants().length + 1)); if (!name) return; }
        saveVariant(name);
      });
      p.querySelector("[data-ve-var-new]").addEventListener("click", function () {
        var name = window.prompt("另存为方案，名称：", "方案" + (listVariants().length + 1));
        if (!name) return; saveVariant(name);
      });
      p.querySelector("[data-ve-var-del]").addEventListener("click", function () {
        var sel = p.querySelector("[data-ve-variant]");
        var name = sel ? sel.value : "";
        if (!name) { alert("请先在上方选择一个方案再删除。"); return; }
        if (window.confirm("确定删除方案「" + name + "」？")) deleteVariant(name);
      });
      p.querySelector("[data-ve-variant]").addEventListener("change", function (e) {
        var name = e.target.value;
        if (name) loadVariant(name);
      });
    }
    function showExportModal(name, content, isCSS) {
      var ov = document.createElement("div");
      ov.setAttribute("data-ve-ui", "1");
      ov.style.cssText = "position:fixed;inset:0;z-index:2147483605;background:rgba(0,0,0,.45);" +
        "display:flex;align-items:center;justify-content:center;font:14px sans-serif";
      ov.innerHTML =
        '<div style="background:#fff;border-radius:12px;width:min(560px,92vw);max-height:84vh;display:flex;flex-direction:column;box-shadow:0 12px 40px rgba(0,0,0,.3)">' +
          '<div style="padding:12px 16px;border-bottom:1px solid #eee;display:flex;justify-content:space-between;align-items:center">' +
            '<b>导出：' + name + '</b><span style="cursor:pointer;opacity:.6" data-ve-x>✕</span>' +
          '</div>' +
          '<div style="padding:10px 16px;color:#6b7280;font-size:12px">文件已尝试保存到浏览器默认下载文件夹（如 此电脑\\下载 / Downloads）。如未找到文件，请在下方复制内容，手动新建 ' + name + ' 保存即可。</div>' +
          '<textarea data-ve-out readonly style="flex:1;min-height:240px;margin:0 16px 10px;box-sizing:border-box;border:1px solid #d1d5db;border-radius:8px;padding:8px;font:12px/1.5 Consolas,monospace;resize:none"></textarea>' +
          '<div style="padding:0 16px 14px;display:flex;gap:8px;justify-content:flex-end">' +
            '<button data-ve-copy style="border:1px solid #0ea5e9;border-radius:6px;background:#f0f9ff;color:#0369a1;cursor:pointer;padding:6px 14px">复制内容</button>' +
            '<button data-ve-dl style="border:1px solid #16a34a;border-radius:6px;background:#f0fdf4;color:#15803d;cursor:pointer;padding:6px 14px">重新下载</button>' +
          '</div>' +
        '</div>';
      document.body.appendChild(ov);
      ov.querySelector("[data-ve-out]").value = content;
      ov.querySelector("[data-ve-x]").addEventListener("click", function () { ov.remove(); });
      ov.addEventListener("click", function (e) { if (e.target === ov) ov.remove(); });
      ov.querySelector("[data-ve-copy]").addEventListener("click", function () {
        var ta = ov.querySelector("[data-ve-out]"); ta.select();
        var done = false;
        try { done = document.execCommand("copy"); } catch (e) {}
        if (!done && navigator.clipboard) { try { navigator.clipboard.writeText(content); done = true; } catch (e) {} }
        toast(done ? "内容已复制到剪贴板 ✓" : "复制失败，请手动框选文本复制");
      });
      ov.querySelector("[data-ve-dl]").addEventListener("click", function () {
        try { download(name, content, isCSS ? "text/css" : "application/json"); toast("已重新尝试下载 " + name); }
        catch (e) { toast("下载仍失败，请用上方复制"); }
      });
    }
    function doExport(kind) {
      if (!plan.changes.length) { toast("本页暂无微调改动，无需导出"); return; }
      var isCSS = kind === "css";
      var name = "visual-edit-" + slug(opts.route) + (isCSS ? ".css" : ".json");
      var content = isCSS ? exportCSS() : JSON.stringify(exportJSON(), null, 2);
      try { download(name, content, isCSS ? "text/css" : "application/json"); } catch (e) {}
      showExportModal(name, content, isCSS);
    }
    p.querySelector("[data-ve-export-css]").addEventListener("click", function () { doExport("css"); });
    p.querySelector("[data-ve-export-json]").addEventListener("click", function () { doExport("json"); });
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
      var ok = true;
      try { ok = window.confirm("清空本页的全部微调改动，恢复页面原样？\n（本机记录" + (opts.serverUrl ? " 与后端方案" : "") + "都会一起清掉）"); } catch (e) { ok = true; }
      if (!ok) return;
      pushHistory();
      plan = { route: opts.route, changes: [] };
      persist(); renderAll();
      if (opts.serverUrl) saveToServer();      // 后端也一起清空，避免刷新后被重新拉回来
      if (panelEl) { syncPanelTo(activeEl); renderChangesList(); }
      toast("已清空本页改动");
    });

    panelEl = p;
    document.body.appendChild(p);
    if (opts.features.indexOf("variants") >= 0) renderVariantSelect();
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

  // ---- 新增元素 / 复制 / 对齐吸附 / 方案版本 ----------------------------
  var SNAP = 6;
  var snapLayer = null;
  function ensureSnapLayer() {
    if (snapLayer) return;
    snapLayer = document.createElement("div");
    snapLayer.setAttribute("data-ve-ui", "1");
    snapLayer.style.cssText = "position:fixed;inset:0;z-index:2147483595;pointer-events:none;";
    document.body.appendChild(snapLayer);
  }
  function clearSnapGuides() { if (snapLayer) snapLayer.innerHTML = ""; }
  function drawSnapGuide(axis, pos) {
    if (!snapLayer) return;
    var d = document.createElement("div");
    if (axis === "v") d.style.cssText = "position:absolute;top:0;bottom:0;left:" + pos + "px;width:1px;background:#ec4899";
    else d.style.cssText = "position:absolute;left:0;right:0;top:" + pos + "px;height:1px;background:#ec4899";
    snapLayer.appendChild(d);
  }
  function candidates(except) {
    var out = [];
    try {
      Array.prototype.forEach.call(document.querySelectorAll(PICKABLE), function (n) {
        if (n === except || !document.body.contains(n) || isUi(n)) return;
        var r = n.getBoundingClientRect();
        if (r.width && r.height) out.push({ el: n, r: r });
      });
    } catch (e) {}
    return out;
  }
  function snapMove(el, dx, dy) {
    try {
      ensureSnapLayer(); clearSnapGuides();
      var r = el.getBoundingClientRect();
      var left = r.left + dx, top = r.top + dy, right = left + r.width, bottom = top + r.height;
      var cx = left + r.width / 2, cy = top + r.height / 2;
      var cands = candidates(el);
      var bestX = null, bestY = null;
      cands.forEach(function (o) {
        var or = o.r, ol = or.left, oR = or.right, ot = or.top, ob = or.bottom, ocx = (ol + oR) / 2, ocy = (ot + ob) / 2;
        [[ol, left], [ol, right], [ol, cx], [oR, left], [oR, right], [oR, cx], [ocx, left], [ocx, cx], [ocx, right]].forEach(function (p) {
          var d = p[0] - p[1];
          if (Math.abs(d) <= SNAP && (bestX === null || Math.abs(d) < Math.abs(bestX[0]))) bestX = [d, p[0]];
        });
        [[ot, top], [ot, bottom], [ot, cy], [ob, top], [ob, bottom], [ob, cy], [ocy, top], [ocy, cy], [ocy, bottom]].forEach(function (p) {
          var d = p[0] - p[1];
          if (Math.abs(d) <= SNAP && (bestY === null || Math.abs(d) < Math.abs(bestY[0]))) bestY = [d, p[0]];
        });
      });
      if (bestX) { dx += bestX[0]; drawSnapGuide("v", bestX[1]); }
      if (bestY) { dy += bestY[0]; drawSnapGuide("h", bestY[1]); }
    } catch (e) {}
    dx = Math.round(dx / 8) * 8; dy = Math.round(dy / 8) * 8;
    return { dx: dx, dy: dy };
  }
  function addElement(type, position) {
    if (!activeEl) return;
    var html;
    switch (type) {
      case "div": html = '<div style="padding:12px;border:1px dashed #cbd5e1;color:#475569">新容器</div>'; break;
      case "text": html = '<p style="margin:0">新文本段落</p>'; break;
      case "button": html = '<button style="padding:6px 14px;border:1px solid #6366f1;background:#eef2ff;color:#4338ca;border-radius:6px;cursor:pointer">新按钮</button>'; break;
      case "heading": html = '<h3 style="margin:0">新标题</h3>'; break;
      case "image": html = '<img src="data:image/svg+xml;utf8,<svg xmlns=\'http://www.w3.org/2000/svg\' width=\'160\' height=\'90\'><rect width=\'160\' height=\'90\' fill=\'#e5e7eb\'/><text x=\'50%\' y=\'50%\' text-anchor=\'middle\' dy=\'.3em\' fill=\'#9ca3af\' font-family=\'sans-serif\'>图片</text></svg>" style="max-width:100%;border:1px solid #e5e7eb;border-radius:6px" alt="图片">'; break;
      case "hr": html = '<hr style="border:none;border-top:1px solid #e5e7eb">'; break;
      default: html = '<div>新元素</div>';
    }
    var refId = getAssignedId(activeEl);
    var id = nextId();
    pushHistory();
    upsert({ id: id, path: pathOf(activeEl), kind: "add", prop: "insert", value: html, position: position, refId: refId });
    var newEl = q(id);
    if (newEl) select(newEl);
  }
  function duplicateActive() {
    if (!activeEl) return;
    var html = (activeEl.outerHTML || "")
      .replace(/\s+data-ve-id="[^"]*"/g, "")
      .replace(/\s+__veAdded="?true"?/g, "")
      .replace(/outline:\s*[^;]+;?/g, "");
    var refId = getAssignedId(activeEl);
    var id = nextId();
    pushHistory();
    upsert({ id: id, path: pathOf(activeEl), kind: "add", prop: "insert", value: html, position: "after", refId: refId });
    var newEl = q(id);
    if (newEl) select(newEl);
  }
  function variantKey(name) { return "ve_var::" + (opts.route || "root") + "::" + name; }
  function listVariants() {
    var out = [];
    try {
      var prefix = "ve_var::" + (opts.route || "root") + "::";
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k && k.indexOf(prefix) === 0) out.push(k.slice(prefix.length));
      }
    } catch (e) {}
    return out;
  }
  function renderVariantSelect() {
    if (!panelEl) return;
    var sel = panelEl.querySelector("[data-ve-variant]");
    if (!sel) return;
    var names = listVariants();
    sel.innerHTML = '<option value="">（当前未命名方案）</option>' +
      names.map(function (n) { return '<option value="' + escapeHtml(n) + '">' + escapeHtml(n) + "</option>"; }).join("");
  }
  function saveVariant(name) {
    if (!name) return;
    try { localStorage.setItem(variantKey(name), JSON.stringify(plan)); } catch (e) {}
    renderVariantSelect();
    var sel = panelEl && panelEl.querySelector("[data-ve-variant]");
    if (sel) sel.value = name;
  }
  function loadVariant(name) {
    if (!name) return;
    try {
      var raw = localStorage.getItem(variantKey(name));
      if (raw) { plan = JSON.parse(raw); plan.route = opts.route; persist(); renderAll(); if (panelEl) syncPanelTo(activeEl); }
    } catch (e) {}
    if (panelEl) { var sel = panelEl.querySelector("[data-ve-variant]"); if (sel) sel.value = name; }
  }
  function deleteVariant(name) {
    try { localStorage.removeItem(variantKey(name)); } catch (e) {}
    renderVariantSelect();
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
        c.kind === "move" ? "排序" : c.kind === "moveTo" ? "移动" : c.kind === "add" ? "新增" : c.kind === "comment" ? "评论" :
        c.kind === "token" ? c.prop : c.prop;
      var val = c.kind === "move" ? "→第" + (c.value + 1) + "位" : c.kind === "hide" || c.kind === "delete" ? "" :
        c.kind === "moveTo" ? "前:" + (c.targetPath || c.targetId || "").slice(0, 20) :
        c.kind === "add" ? "新元素" :
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

  function clampPanel() {
    if (!panelEl) return;
    var M = 8;
    var pw = panelEl.offsetWidth || 300, ph = panelEl.offsetHeight || 320;
    var x = parseFloat(panelEl.style.left || "0"), y = parseFloat(panelEl.style.top || "0");
    x = Math.max(M, Math.min(x, window.innerWidth - Math.min(pw, window.innerWidth - 2 * M) - M));
    y = Math.max(M, Math.min(y, window.innerHeight - Math.min(ph, window.innerHeight - 2 * M) - M));
    panelEl.style.left = Math.round(x) + "px";
    panelEl.style.top = Math.round(y) + "px";
  }
  function positionPanelNear(el) {
    if (!panelEl || !el) return;
    var M = 8;
    // 面板固定定位（position:fixed），全程用视口坐标：
    // 这样即使宿主应用是"body 不滚、内部容器滚"（SaaS 常见外壳），面板也不会被 overflow:hidden 裁掉或跑到视口外。
    panelEl.style.maxHeight = Math.max(180, window.innerHeight - M * 2) + "px";
    showPanel();
    var pw = panelEl.offsetWidth || 300;
    var ph = panelEl.offsetHeight || 320;
    // 用户手动拖过面板 -> 尊重用户的位置（仅夹到视口内），不再自动跟随
    if (panelUserPos) { panelEl.style.left = panelUserPos.x + "px"; panelEl.style.top = panelUserPos.y + "px"; clampPanel(); return; }
    var r = el.getBoundingClientRect();
    var fitsY = function (yy) { return yy >= M && yy + ph <= window.innerHeight - M; };
    var x, y;
    if (fitsY(r.bottom + M)) { x = r.left; y = r.bottom + M; }                       // 1) 元素下方
    else if (fitsY(r.top - ph - M)) { x = r.left; y = r.top - ph - M; }               // 2) 元素上方
    else if (r.right + M + pw <= window.innerWidth - M) { x = r.right + M; y = r.top; } // 3) 元素右侧
    else if (r.left - pw - M >= M) { x = r.left - pw - M; y = r.top; }                // 4) 元素左侧
    else { x = window.innerWidth - pw - M; y = M; }                                   // 5) 贴右上，尽量少挡
    if (x + pw > window.innerWidth - M) x = window.innerWidth - pw - M;
    if (x < M) x = M;
    if (y < M) y = M;
    if (y + ph > window.innerHeight - M) y = Math.max(M, window.innerHeight - ph - M);
    panelEl.style.left = Math.round(x) + "px";
    panelEl.style.top = Math.round(y) + "px";
  }
  // 面板是否真的可见（在视口内、非隐藏）
  function panelVisible() {
    if (!panelEl) return false;
    if (panelEl.style.display === "none") return false;
    var r = panelEl.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < window.innerHeight && r.right > 0 && r.left < window.innerWidth;
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
      if (rendering) return;
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
  function toast(msg) {
    try {
      var t = document.createElement("div");
      t.setAttribute("data-ve-ui", "1");
      t.textContent = msg;
      t.style.cssText = "position:fixed;left:50%;bottom:64px;transform:translateX(-50%);z-index:2147483603;" +
        "background:#111827;color:#fff;padding:8px 14px;border-radius:8px;font:13px sans-serif;" +
        "box-shadow:0 6px 20px rgba(0,0,0,.3);opacity:0;transition:opacity .18s";
      document.body.appendChild(t);
      (window.requestAnimationFrame || function (f) { return setTimeout(f, 16); })(function () { t.style.opacity = "1"; });
      setTimeout(function () {
        t.style.opacity = "0";
        setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 240);
      }, 1800);
    } catch (e) {}
  }
  function selectHint() {
    toast("微调已开启：点击页面上的任意元素即可打开面板");
  }

  // 在没有任何选中时打开面板（摆在右下角、开关上方）——保证「清空本页 / 撤销 / 本页改动列表」
  // 这些救急入口永远够得着：即使把菜单栏等元素隐藏了、选不中也一样能恢复。
  function openPanelAtDefault() {
    buildPanel();
    var pw = panelEl.offsetWidth || 300;
    panelEl.style.left = Math.max(8, window.innerWidth - pw - 14) + "px";
    panelEl.style.top = Math.max(8, window.innerHeight - (panelEl.offsetHeight || 320) - 62) + "px";
    showPanel();
    renderChangesList();
  }

  function mountToggle() {
    var b = document.createElement("button");
    b.setAttribute("data-ve-ui", "1");
    b.setAttribute("data-ve-toggle", "1");
    b.textContent = "🛠 微调";
    // z-index 高于面板：面板浮在右下角时不会把开关按钮压在下面（否则会像"功能入口消失"）
    b.style.cssText = "position:fixed;right:14px;bottom:14px;z-index:2147483602;border:1px solid #6366f1;" +
      "background:#6366f1;color:#fff;border-radius:999px;padding:8px 14px;font:13px sans-serif;cursor:pointer;box-shadow:0 4px 14px rgba(99,102,241,.4)";
    b.addEventListener("click", function () {
      // 开着但面板不可见时，点按钮 = 把面板找回来（而不是把模式关掉，否则会像"功能入口彻底消失"）
      if (engineOn && !panelVisible()) {
        if (lastActiveEl && document.body.contains(lastActiveEl)) { select(lastActiveEl); return; }
        // 没有任何可恢复的选中（比如上次选中的元素已被隐藏/删除）→ 直接开面板，
        // 保证"清空本页""撤销"这些救急入口永远够得着。
        openPanelAtDefault();
        return;
      }
      engineOn = !engineOn;
      if (engineOn) {
        document.addEventListener("mouseover", onOver, true);
        document.addEventListener("click", onPick, true);
        b.textContent = "✓ 微调中";
        b.style.background = "#16a34a";
        if (commentLayer) commentLayer.style.display = "block";
        // 重新打开时恢复上次选中的元素与面板，避免"关掉就再也打不开"
        if (lastActiveEl && document.body.contains(lastActiveEl)) select(lastActiveEl);
        else openPanelAtDefault();   // 首次开启也让面板直接出现，别让人找不着
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
      if ((e.ctrlKey || e.metaKey) && (e.key === "d" || e.key === "D")) { e.preventDefault(); if (activeEl) duplicateActive(); return; }
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
  /** 切换当前路由（页面）：保存旧路由方案、加载新路由方案；不重建监听器/UI，避免重复挂载 */
  function setRoute(route) {
    persist();                                  // upsert 已即时持久化，这里再保一次更稳
    activeEl = null; lastActiveEl = null;
    if (overlayEl) hideOverlay();
    if (treeEl) treeEl.style.display = "none";
    if (panelEl && panelEl.style.display !== "none") panelEl.style.display = "none";
    opts.route = route || "root";
    plan = { route: opts.route, changes: [] };
    loadLocal();                                // 读新路由的本地方案
    assignAllIds();                             // 给新页面 DOM 补确定性 id
    if (opts.autoFetch) loadRemote().then(renderAll); else renderAll();
  }
  function init(userOpts) {
    Object.assign(opts, userOpts || {});
    plan.route = opts.route;
    try {
      var rawPos = localStorage.getItem(POS_KEY);
      if (rawPos) { var pv = JSON.parse(rawPos); if (pv && typeof pv.x === "number" && typeof pv.y === "number") panelUserPos = pv; }
    } catch (e) {}
    loadLocal();
    assignAllIds();            // 首次加载时先给当前 DOM 补齐确定性 id，再重放方案
    if (opts.autoFetch) loadRemote().then(renderAll); else renderAll();
    observe();
    mountToggle();
    window.addEventListener("scroll", function (ev) {
      // 面板内部滚动不要触发重新定位（capture 阶段会收到自家 UI 的 scroll）
      if (ev && ev.target && ev.target.nodeType === 1 && isOurNode(ev.target)) return;
      if (activeEl) {
        if (overlayEl) updateOverlay(activeEl);
        if (panelEl && panelEl.style.display !== "none") positionPanelNear(activeEl);
      }
      if (engineOn && commentLayer) positionComments();
    }, true);
    window.addEventListener("resize", function () {
      if (activeEl) {
        if (overlayEl) updateOverlay(activeEl);
        if (panelEl && panelEl.style.display !== "none") positionPanelNear(activeEl);
      }
      if (engineOn && commentLayer) positionComments();
    });
    return api;
  }
  var api = {
    init: init,
    setRoute: setRoute,
    getPlan: function () { return exportJSON(); },
    exportCSS: exportCSS,
    exportJSON: function () { return JSON.stringify(exportJSON(), null, 2); },
    exportAI: exportAI,
    save: saveToServer,
    reset: function () { pushHistory(); plan = { route: opts.route, changes: [] }; persist(); renderAll(); },
    /** 救急：清空本页所有改动（本机记录 + 可选后端），页面立刻恢复原样 */
    clearPlan: function (alsoRemote) {
      pushHistory();
      plan = { route: opts.route, changes: [] };
      persist(); renderAll();
      if (alsoRemote !== false && opts.serverUrl) saveToServer();
      return true;
    },
    render: renderAll,
    undo: undo,
    redo: redo,
    getActive: function () { return activeEl; },
    select: function (el) { if (el && el.nodeType === 1) select(el); },
    panelVisible: panelVisible,
    isOn: function () { return engineOn; },
    resetPanelPos: function () {
      panelUserPos = null;
      try { localStorage.removeItem(POS_KEY); } catch (e) {}
      if (activeEl) positionPanelNear(activeEl);
    },
    addElement: function (type, position) { addElement(type, position); },
    duplicate: duplicateActive,
    listVariants: listVariants,
    saveVariant: saveVariant,
    loadVariant: loadVariant,
    deleteVariant: deleteVariant,
  };
  return api;
});
