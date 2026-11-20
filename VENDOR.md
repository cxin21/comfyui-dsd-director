# 内置内核（vendored kernel）

`dsd/` 目录是 `film-pipeline/src/dsd/` 的逐字节副本，随包一起发布，让「只把 `dsd-director` 拷进 `custom_nodes/`」也能直接跑。

## 解析顺序

`dsd_nodes/nodes.py` 里：

```python
DSD_SRC = (os.environ.get("DSD_SRC") or _bundled_dsd_root() or os.path.join(
    os.path.expanduser("~"), "Documents", "deepseek-harness",
    "default-workspace", "film-pipeline", "src"))
```

即：**`DSD_SRC` 环境变量 > 包内 `dsd/` > `film-pipeline/src`**。`dsd_nodes/routes.py` 的 `sys.path` 注入用同一套顺序，所以面板的 `/dsd/preflight` 也走包内副本。

想用工作区里正在开发的内核，就把 `DSD_SRC` 指向它 —— 环境变量优先，覆盖包内副本。

## 文件清单

| 文件 | 大小 | 作用 |
| --- | --- | --- |
| `dsd/__init__.py` | 580 | 导出 `PlanError` / `load_plan` / `validate_plan` |
| `dsd/plan.py` | 24680 | `dsd-shots/1` 计划模型、`validate_plan`、`segment_plan`、镜头级 overrides |
| `dsd/executor.py` | 62065 | 分段执行器：条件、采样、解码、二采、进度上报 |
| `dsd/handoff.py` | 6601 | 段间接力（latent prefix / ramp / anchor） |
| `dsd/sampling.py` | 9556 | 双时钟 Euler / exp2 积分器 |
| `dsd/preflight.py` | 24315 | 19 条提交前检查 |
| `dsd/nodes.py` | 127 | 占位（内核不注册节点，节点在 `dsd_nodes/`） |

合计 127924 B / 2818 行。依赖面只有 `torch` / `comfy.*` / `comfy_extras.*` / 标准库，没有到 `film-pipeline` 的相对路径（docstring 里出现的 `docs/NN` 只是引用编号）。

## 同步方式

改完 `film-pipeline/src/dsd/` 后跑：

```bash
python scripts/sync_kernel.py          # 复制并打印 sha256 对照
python scripts/sync_kernel.py --check  # 只比较，不一致时退出码 1
```

`--check` 适合放进发布前检查清单；两边不一致说明包里的副本过期了。

## 为什么 vendor 而不是要求装两份

不做 vendor 的话，使用者要么自己去 clone `film-pipeline`（一个只有作者需要的仓库），要么被 `ModuleNotFoundError: No module named 'dsd'` 卡在启动阶段、且报错文本完全看不出缺什么。

vendor 的代价是副本会漂移，所以配了 `--check` 与 CI 友好的退出码。