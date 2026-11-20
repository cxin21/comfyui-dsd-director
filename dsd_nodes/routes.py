"""dsd-director 的轻量 HTTP 路由：只给面板做提交前体检，不碰渲染。

注册方式与 AIMixer 一致：server.PromptServer.instance.routes 上挂 aiohttp handler，
由包 __init__.py 在导入时调用 register_routes()。失败只打印告警，不影响节点加载。
"""
from __future__ import annotations

import json
import os
import sys


def _add(path, handler, method="POST"):
    from server import PromptServer
    routes = PromptServer.instance.routes
    getattr(routes, method.lower())(path)(handler)  # RouteTableDef: routes.post(...) returns a decorator


def register_routes():
    from aiohttp import web

    _HERE = os.path.dirname(os.path.abspath(__file__))
    _PKG = os.path.dirname(_HERE)
    _BUNDLED = _PKG if os.path.isfile(os.path.join(_PKG, "dsd", "__init__.py")) else ""
    _SRC = os.environ.get("DSD_PROJECT_ROOT") or os.path.join(
        os.path.expanduser("~"), "Documents", "deepseek-harness",
        "default-workspace", "film-pipeline")
    # 优先级顺序：包内 dsd/ 在前，film-pipeline/src 在后。
    # 顺序靠「先全部摘掉、再按优先级反序 insert(0)」保证 —— 两次 insert(0) 会把后一个顶到前面，
    # 一旦 sys.path 里已有旧路径、或另一个入口先插过，包内副本就抢不过工作区那份。
    _paths = [p for p in (((_BUNDLED,) if _BUNDLED else ()) + (os.path.join(_SRC, "src"),))
              if os.path.isdir(p)]
    for _p in _paths:
        while _p in sys.path:
            sys.path.remove(_p)
    for _p in reversed(_paths):
        sys.path.insert(0, _p)
    # 若 dsd 已被别的路径抢先导入，丢掉缓存，让下面的 import 走到包内副本。
    _want = os.path.abspath(_BUNDLED) if _BUNDLED else ""
    _mod = sys.modules.get("dsd")
    if _want and _mod is not None:
        _f = os.path.abspath(getattr(_mod, "__file__", "") or "")
        if not _f.startswith(_want + os.sep):
            for _k in [k for k in list(sys.modules) if k == "dsd" or k.startswith("dsd.")]:
                sys.modules.pop(_k, None)

    async def preflight_handler(request):
        try:
            body = await request.json()
        except Exception:
            return web.json_response({"ok": False, "text": "[E] 请求体不是合法 JSON"}, status=400)
        timeline = body.get("timeline") if isinstance(body, dict) else None
        if timeline is None and isinstance(body, dict):
            timeline = body.get("timeline_data")
        try:
            from dsd.preflight import preflight, preflight_text
        except Exception as exc:  # pragma: no cover - 仅环境缺失时
            return web.json_response(
                {"ok": False, "text": "[E] 预检模块不可用：%r" % (exc,)}, status=500)
        try:
            input_dir = None
            try:
                import folder_paths
                input_dir = str(folder_paths.get_input_directory())
            except Exception:
                input_dir = None
            res = preflight(
                timeline,
                input_dir=input_dir,
                min_chars=int(body.get("min_chars", 3000) or 0),
                strict=bool(body.get("strict", False)),
            )
            txt = preflight_text(
                timeline,
                input_dir=input_dir,
                min_chars=int(body.get("min_chars", 3000) or 0),
                strict=bool(body.get("strict", False)),
            )
            return web.json_response({
                "ok": bool(res.get("ok")),
                "text": txt,
                "errors": res.get("errors") or [],
                "warnings": res.get("warnings") or [],
                "info": res.get("info") or {},
            })
        except Exception as exc:
            return web.json_response(
                {"ok": False, "text": "[E] 预检执行失败：%r" % (exc,)}, status=500)

    _add("/dsd/preflight", preflight_handler)
    print("[DSD] routes: /dsd/preflight")
