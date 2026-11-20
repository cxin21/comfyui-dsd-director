import os, sys
_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)
try:
    from .dsd_nodes import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS
except Exception:
    from dsd_nodes import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS
try:
    from .dsd_nodes.routes import register_routes
except Exception:  # pragma: no cover
    from dsd_nodes.routes import register_routes
try:
    register_routes()
except Exception as _exc:  # pragma: no cover
    print("[DSD] routes register failed: %r" % (_exc,))

WEB_DIRECTORY = "./web"  # dsd-director 前端面板（fe-panel 创建；目录缺失时 ComfyUI 只告警）
__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
