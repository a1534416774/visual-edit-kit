# VisualEditKit

> 把"页面微调"能力做成一个可以 `git clone` 后直接嵌入**任意前端 + 任意后端**的开源组件。
> 前端：可视化选中元素改文字 / 配色 / 字号 / 隐藏 / 排序 / 删除 / 设计令牌，实时预览，路由级持久化。
> 后端：一个落盘接口收下方案（JSON / CSS），可多人、可团队、可交 AI 直接落地源码。

MIT License · 一键拉取即用。

---

## 0. 它和 Design Mode（designmode.app）是什么关系

Design Mode 是一个**浏览器扩展**，把任意网站变成可视化设计面，再用 **MCP** 把
`selector → property → value` 的 diff 发给外部 AI Agent（Claude Code / Cursor），
**由 Agent 改源码**。它很强，但有两个它**不解决**的痛点：

1. 它不进你的后端——编辑只存在用户浏览器里（`chrome.storage.session`），没有团队/多端/审核流。
2. 它不帮你把改动落到你自己的代码仓库——只是把 diff 交给 Agent 去猜。

VisualEditKit 走的是**内嵌式**（我们之前在 SaaS 里做的那种，被验证最好用的方式），
但把它**抽成框架无关的核心 + 可插拔后端适配器**，于是：

| 维度 | Design Mode | 我们的内嵌方案 | VisualEditKit |
|---|---|---|---|
| 形态 | 浏览器扩展 | 绑死我们 SaaS 的 React 组件 | 框架无关的 core + 薄封装（React/Vue/原生） |
| 作用域 | 任意站点 | 仅我们自己的应用 | 任何引入了它的应用 |
| 元素定位 | `data-dm-id` + 托管 `<style>` | 路由级 `localStorage` | `data-ve-id` + 托管 `<style>`（借鉴 DM 的稳健做法） |
| 持久化 | 单浏览器 `chrome.storage` | 前端 `localStorage` + 我们后端文件 | 前端 `localStorage` **+ 可插拔后端**（文件/PG/你现有库） |
| 编辑能力 | 全套 CSS / 图层 / 令牌 / 评论 | 文字/配色/隐藏/排序 | 文字/配色/字号字重/隐藏/排序/**删除**/**设计令牌**/变更审计/**拖拽移动 + 8 向缩放 + 布局尺寸面板**/**扩展样式(边框圆角透明层级字体对齐行高)**/**图层树(点选+拖拽换位/跨容器搬移)**/**评论便签**/**撤销重做+快捷键**/**一键复制 AI 指令** |
| 改源码 | 不发，交 Agent | 后端落盘 + AI 直接改源码 | 导出 diff + 直连后端，AI 可在你仓库里落地 |
| 后端耦合 | 无 | 强（仅我们） | 弱（适配器模式，挂到任何后端） |

一句话：**Design Mode 适合"设计师在任意站上画给 Agent 看"，
VisualEditKit 适合"产品团队把可视化微调直接做进自家应用并落库"。**

---

## 1. 它是如何去修改前端的（核心机制）

借鉴 Design Mode 最稳的那一招，不依赖内联 style 覆盖，而是：

1. 激活时给页面元素按需打上 `data-ve-id="ve-N"` 标记（轻量、可逆）。
2. 所有编辑写成规则，注入**唯一一个托管 `<style id="ve-applied-styles">`**：
   ```css
   [data-ve-id="ve-12"] { color: #e11d48; font-size: 18px; }
   ```
   设计令牌单独写进 `:root`（`<style id="ve-token-styles">`）。
3. 这套样式 + `data-ve-id` 映射在 **SPA 重渲染 / 整页刷新** 后由 core 自动重放，
   因为幂等（按 id 而不是按易变的 class/路径），不会"刷新就丢"。
4. 方案同时存 `localStorage`（即时预览）与后端（团队/持久/可导出）。
5. 导出时产出结构化 diff：`{ route, changes: [{ id, path, prop, value, kind }] }`，
   既可生成 CSS，也可交给 AI 在你的源码里落地（`path` 字段给 AI 定位源码用）。

> 为什么不用内联 style 直接盖章？——Design Mode 在 CLAUDE.md 里明确禁止
> "inline-style writes for tracked changes"，因为内联会被特异性（specificity）吃掉、
> 难还原、难审计。用托管样式表 + 属性选择器是更干净的做法，我们也沿用。

---

## 2. 目录结构

```
visual-edit-kit/
├── packages/
│   ├── ve-core/            # 框架无关核心（原生 JS，无需构建，<script> 直接引）
│   │   ├── ve-core.js      # 选取/编辑/令牌/结构删除/托管样式/localStorage/导出/上报后端
│   │   └── ve-core.d.ts    # 类型声明
│   ├── ve-react/          # React 薄封装（挂一个浮动按钮 + 注入 core）
│   │   └── VisualEditKit.tsx
│   └── server/            # 可插拔后端适配器（FastAPI，文件 / Postgres 双实现）
│       ├── app.py         # POST/GET /visual-edit/{route} + export + list
│       └── requirements.txt
├── examples/              # 最小可跑示例（前端 + 后端接线说明）
│   ├── index.html
│   └── README.md
└── README.md
```

---

## 3. 一键嵌入：前端

### 3.1 原生 / Vite / 任何框架

```html
<script src="/vendor/ve-core.js"></script>
<script>
  VisualEditKit.init({
    route: location.pathname,           // 方案按路由隔离
    serverUrl: '/api/visual-edit',      // 可选：后端落盘地址
    token: '<optional-auth>',           // 可选
    pickMode: 'click',                  // click | hover
    features: ['text', 'color', 'hide', 'move', 'token', 'delete', 'layout', 'style', 'tree', 'comment'],
  });
</script>
```

### 3.2 React

```tsx
import { VisualEditKit } from 've-react';

<VisualEditKit
  route={location.pathname}
  serverUrl="/api/visual-edit"
  features={['text', 'color', 'hide', 'move', 'token', 'delete', 'layout', 'style', 'tree', 'comment']}
/>
```

右下角出现「🛠 微调」浮动按钮 → 点元素 → 面板改文字/配色/字号/隐藏/上下移/删除 →
实时预览；面板底部有**变更审计列表**（每条可单独 ↺ 撤销），以及「导 CSS / 导 JSON」「保存后端 / 重置本页」。
展开「🎨 设计令牌」可改 `:root` 的 CSS 变量（如主题色、圆角），全站即时生效。

---

## 4. 一键嵌入：后端（适配器）

`packages/server/app.py` 是一个**最小可替换**的 FastAPI 实现：

```bash
pip install -r packages/server/requirements.txt
uvicorn app:app --port 5055          # 默认文件落盘
# 或：VE_BACKEND=postgres VE_DATABASE_URL=postgresql://... uvicorn app:app --port 5055
```

接口：
- `POST   /visual-edit/{route}`  —— 收下方案 JSON，落盘（文件 / Postgres）
- `GET    /visual-edit/{route}`  —— 取回方案（前端启动时可拉取团队方案）
- `GET    /visual-edit/{route}/export?format=css|json` —— 导出
- `GET    /visual-edit`          —— 列出已保存的路由
- `GET    /health`               —— 健康检查（带回 backend 名称）

把 `StorageBackend` 换成你自己的（Redis / 对象存储 / 沿用 SaaS 既有库）即可，
**前端和 core 完全不动**。这就是"拉下来直接嵌入别人后端"的含义。
Postgres 实现通过 `psycopg` 连接池，`visual_edit_plans(route TEXT PK, plan JSONB, updated)` 表首次写入自动创建。

---

## 5. 与 AI 落地源码的衔接

导出的方案是结构化 diff，可直接喂给 Agent：
- 走 Design Mode 式 MCP（你已有 Agent）→ 让它按 `selector/prop/value` 改源码；
- 或在我们这种内嵌场景里，后端收到方案后，由 AI 在你的仓库对应文件里落地，
  再由 CI 校验——比"扩展发 diff 让 Agent 盲猜"更可控，因为方案始终带着路由与选择器及 `path`。

---

## 6. 许可与扩展

MIT。可 fork、可商用、可嵌入闭源产品。

后续可加：方案版本/分支、审核流、结构级 DOM **增**（当前支持删 + 拖拽**搬移**，
增待补）、测量/标注、截图导出。

## 7. 布局 / 尺寸（layout 特性）

开启 `features` 含 `'layout'` 后，选中元素会浮出一层绿色描边浮层：

- **拖绿框移动**：在元素上按住拖动，整体平移（写入 `transform: translate(...)`）。
- **拖 8 个手柄缩放**：四角 + 四边共 8 个绿色手柄，分别改变 `width` / `height`（从顶部/左侧缩放时会同步平移 `transform`，保持对角不动）。
- **布局面板**（面板内「📐 布局 / 尺寸」折叠区）：直接填 宽/高/外边距/内边距、
  选 显示(display)/排列(flex-direction)/主轴对齐/交叉轴/间距(gap)/定位(position)/浮动(float)。

所有布局改动都走与样式相同的托管样式表（带 `!important`，**确保压过原页面的 id/class 规则**），
刷新 / SPA 重渲染后由 core 自动重放，不会丢失；也进入「变更审计」可逐条撤销，并随方案导出 CSS / 保存到后端。

> 说明：拖拽移动本质是视觉平移（`transform`），并不改变元素在 DOM 流里的兄弟顺序；
> 若要调整"在同一容器里的先后位置"，用面板里的「↑ 上移 / ↓ 下移」（sibling reorder）。

## 8. 新增能力（style / tree / comment / 撤销重做 / AI 指令）

这些特性默认均已开启（见上方 `features` 默认值）。

- **扩展样式 `style`**：面板「🎛 扩展样式」折叠区可改 圆角 / 透明度 / 边框(宽·色·样式) /
  层级 z-index / 行高 / 文字对齐 / 字体。同样走 `!important` 托管样式表。
- **图层树 `tree`**：点面板「🗂 图层」打开浮层树。
  - 点任意节点 = 选中该元素（与在页面上点选等价）。
  - **拖一个节点到另一个节点上 = 把它移动到目标节点之前**（可跨容器搬移，"把功能区换个位置"就靠它）。
  - 树随 DOM 变化自动刷新（SPA 重渲染后依然准确）。
- **评论 `comment`**：面板「💬 评论 / 备注」里写文字 → 点「📌 钉备注」，会在元素右上角钉一个 💬 标记；
  评论随方案导出（CSS 里作为注释、AI 指令里作为一条备注），方便把"为什么这样改"一并交给 AI。
- **撤销 / 重做**：面板「↶ 撤销 / ↷ 重做」按钮，或快捷键 `Ctrl/Cmd+Z` / `Ctrl/Cmd+Shift+Z`（或 `Ctrl+Y`）。
  快捷键：
  - `Esc` 取消选中 / 关闭面板
  - `Delete` / `Backspace` 删除选中元素（与面板"删除"等价）
  - 方向键 `←↑↓→` 微调位置（按住 `Shift` 步长 10px）
  - 注意：焦点在输入框/下拉时，方向键与删除键作用于文本，不会误触元素。
- **一键复制 AI 指令**：面板「📋 复制 AI 指令」生成一段 Markdown——先列出每条改动（路径为可直接定位源码的 CSS 选择器），
  再附等价 CSS——复制到剪贴板，粘贴给任意编码 Agent 即可落地。

> 所有改动都实时进入右下角「变更审计」列表，可逐条 `↺` 撤销；也可「导 CSS / 导 JSON」「保存后端」「重置本页」。


