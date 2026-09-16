"""
VisualEditKit — 可插拔后端适配器（FastAPI）。

职责：接收前端 core 上报的方案 JSON，落盘。存储层是抽象，默认文件，
可通过环境变量 VE_BACKEND=postgres 切到 Postgres（或自己继承 StorageBackend）。

运行（文件版）：
    pip install -r requirements.txt
    uvicorn app:app --port 5055

运行（Postgres 版）：
    pip install -r requirements.txt
    set VE_BACKEND=postgres
    set VE_DATABASE_URL=postgresql://user:pass@host:5432/db
    uvicorn app:app --port 5055

接口：
    POST   /visual-edit/{route:path}              收下方案 JSON，落盘
    GET    /visual-edit/{route:path}              取回方案（前端启动拉取团队方案）
    GET    /visual-edit/{route:path}/export?format=css|json   导出
    GET    /visual-edit                           列出已保存的路由
    GET    /health
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response

app = FastAPI(title="VisualEditKit Server")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# 存储抽象：想接 PG / Redis / 对象存储，只改这一个类
# ---------------------------------------------------------------------------
class StorageBackend:
    """文件版（默认）。每个路由一个 _<route>.json。"""

    def __init__(self) -> None:
        self.root = Path(os.environ.get("VE_STORE_DIR", "./.ve-plans"))
        self.root.mkdir(parents=True, exist_ok=True)

    def _path(self, route: str) -> Path:
        safe = route.replace("/", "_").strip("_") or "root"
        return self.root / f"{safe}.json"

    def save(self, route: str, plan: Dict[str, Any]) -> None:
        self._path(route).write_text(
            json.dumps(plan, ensure_ascii=False, indent=2), encoding="utf-8"
        )

    def load(self, route: str) -> Optional[Dict[str, Any]]:
        p = self._path(route)
        if not p.exists():
            return None
        return json.loads(p.read_text(encoding="utf-8"))

    def list_routes(self) -> List[str]:
        return sorted(p.stem for p in self.root.glob("*.json"))

    def export_css(self, plan: Dict[str, Any]) -> str:
        lines: List[str] = [":root {"]
        tokens = [c for c in plan.get("changes", []) if c.get("kind") == "token"]
        others = [c for c in plan.get("changes", []) if c.get("kind") != "token"]
        for c in tokens:
            lines.append(f'  {c["prop"]}: {c["value"]};')
        lines.append("}")
        for c in others:
            if c.get("kind") == "style":
                lines.append(f'[{c["id"]}] {{ {c["prop"]}: {c["value"]}; }}')
            elif c.get("kind") == "hide":
                lines.append(f'[{c["id"]}] {{ display: none !important; }}')
        return "\n".join(lines) + "\n"


class PostgresStorageBackend(StorageBackend):
    """Postgres 版。表结构极简，复用 SaaS 既有的 PG 连接风格（psycopg 的 ?→%s 由驱动处理）。

    表（首次写入自动创建）：
        CREATE TABLE IF NOT EXISTS visual_edit_plans (
            route   TEXT PRIMARY KEY,
            plan    JSONB NOT NULL,
            updated TIMESTAMPTZ DEFAULT now()
        );
    """

    def __init__(self) -> None:
        import psycopg  # 轻量依赖；缺失时 save/load 会给出清晰报错
        self.dsn = os.environ.get("VE_DATABASE_URL")
        if not self.dsn:
            raise RuntimeError("VE_BACKEND=postgres 需要设置 VE_DATABASE_URL")
        self._pool = psycopg.ConnectionPool(self.dsn, open=False, kwargs={"autocommit": True})
        self._ensured = False

    def _conn(self):
        if not self._ensured:
            with self._pool.connection() as conn:
                conn.execute(
                    "CREATE TABLE IF NOT EXISTS visual_edit_plans ("
                    "route TEXT PRIMARY KEY, plan JSONB NOT NULL, updated TIMESTAMPTZ DEFAULT now())"
                )
            self._ensured = True
        return self._pool.connection()

    def save(self, route: str, plan: Dict[str, Any]) -> None:
        with self._conn() as conn:
            conn.execute(
                "INSERT INTO visual_edit_plans(route, plan) VALUES(%s, %s) "
                "ON CONFLICT (route) DO UPDATE SET plan = EXCLUDED.plan, updated = now()",
                (route, json.dumps(plan, ensure_ascii=False)),
            )

    def load(self, route: str) -> Optional[Dict[str, Any]]:
        with self._conn() as conn:
            row = conn.execute(
                "SELECT plan FROM visual_edit_plans WHERE route = %s", (route,)
            ).fetchone()
        if not row:
            return None
        return row[0] if isinstance(row[0], dict) else json.loads(row[0])

    def list_routes(self) -> List[str]:
        with self._conn() as conn:
            rows = conn.execute("SELECT route FROM visual_edit_plans ORDER BY route").fetchall()
        return [r[0] for r in rows]

    # export_css 复用基类实现（纯内存计算）


def make_store() -> StorageBackend:
    backend = os.environ.get("VE_BACKEND", "file").lower()
    if backend == "postgres":
        return PostgresStorageBackend()
    return StorageBackend()


store: StorageBackend = make_store()


# ---------------------------------------------------------------------------
# 路由
# ---------------------------------------------------------------------------
@app.post("/visual-edit/{route:path}")
async def save_plan(route: str, request: Request):
    plan = await request.json()
    plan["route"] = route
    store.save(route, plan)
    return {"ok": True, "route": route, "changes": len(plan.get("changes", []))}


@app.get("/visual-edit/{route:path}/export")
async def export_plan(route: str, format: str = "css"):
    plan = store.load(route)
    if plan is None:
        raise HTTPException(status_code=404, detail="no plan for route")
    if format == "json":
        return plan
    return Response(store.export_css(plan), media_type="text/css")


@app.get("/visual-edit/{route:path}")
async def get_plan(route: str):
    plan = store.load(route)
    if plan is None:
        raise HTTPException(status_code=404, detail="no plan for route")
    return plan


@app.get("/visual-edit")
async def list_plans():
    return {"routes": store.list_routes()}


@app.get("/health")
async def health():
    return {"ok": True, "backend": type(store).__name__}
