# 最小可跑示例

## 1) 纯前端（无需后端）

直接用浏览器打开 `index.html` 即可：

- 点右下角「🛠 微调」激活；
- 点页面元素 → 面板里改文字 / 配色 / 字号 / 隐藏 / 排序 / 删除 / 设计令牌；
- 「导 CSS / 导 JSON」下载方案（方案也会存进浏览器 localStorage，刷新仍在）。

## 2) 接后端落盘（团队 / 可导出）

另开一个终端跑 FastAPI 后端：

```bash
cd packages/server
pip install -r requirements.txt
uvicorn app:app --port 5055
```

然后打开：`index.html?server`（脚本会探测 `?server` 并把 `serverUrl` 指到 `http://localhost:5055/visual-edit`），
此时面板出现「保存后端」按钮，点它把方案 POST 落盘；后端可用 `GET /visual-edit/{route}/export?format=css` 导出。

## 3) 接 Postgres

```bash
set VE_BACKEND=postgres
set VE_DATABASE_URL=postgresql://user:pass@host:5432/db
uvicorn app:app --port 5055
```

表在首次写入时自动创建（`visual_edit_plans(route TEXT PK, plan JSONB, updated)`）。
切到 Postgres 后，**前端 core 与 ve-react 完全不用改**——这就是适配器模式的用意。
