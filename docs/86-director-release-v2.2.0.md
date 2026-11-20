# 86 · 导演台发布件（v2.2.0）

把 `dsd-director` 从「能跑的自用节点」收成「可以交到别人手里」的包。本文件记录发布件的构成、这一轮补的东西、以及发布前仍需人拍板的两件事。

## 0 结论

1. 包内文件从 6 个涨到 15 个：新增 `README.md`（中文，10.8 KB）、`README_EN.md`（8.0 KB）、`CHANGELOG.md`、`pyproject.toml`、`docs/`（5 篇设计文档 + 面板截图）。整包 568 KB。
2. 两处写死的 `E:/Comfy/comfyui-licyk-20260608/core/input` 改成 `_input_dir()`（内部走 `folder_paths.get_input_directory()`），别人的机器上不再是死路径。
3. 旧 `.bak` 全部移出包目录（8 个，共 340 KB），挪到 `film-pipeline/out/bak/dsd-director/`；`__pycache__` 不进发布件。
4. 工作流补了英文文件名别名：`DSD-director-v2-best-2x.json` 与 `DSD-director-v2-quick-1step.json`，中文原名保留，两个别名与原名逐字节相同。
5. 发布后仍需人拍板两件：**许可证**与 **ComfyUI Registry 的 PublisherId**。这两项是法律/账号决定，我没有代填。

## 1 这一轮补的内容

| 项 | 之前 | 现在 |
| --- | --- | --- |
| 说明文档 | 无 | `README.md`（中文 10.8 KB）+ `README_EN.md`（8.0 KB），含安装、9 个模型文件表、快速上手、三层参数、四档预设、面板速查、时间线导出、体检 19 码、已知限制 |
| 变更记录 | 无 | `CHANGELOG.md`，2.2.0 分「数据源 / 面板 / 后端 / 修复」四节，往前追到 1.0.0 |
| 打包元数据 | 无 | `pyproject.toml`（name/version/requires-python/classifiers/`[tool.comfy]` DisplayName + requires-comfyui） |
| 设计文档 | 只在 film-pipeline 的 docs/ | 复制 80/81/83/84/85 五篇进包内 `docs/` |
| 面板截图 | 无 | `docs/panel.png`（1962x1234，真实浏览器截图，非示意图） |
| 输入目录 | 两处硬编码绝对路径 | `_input_dir()` |
| 包内杂项 | 8 个 `.bak` 与 `__pycache__` | 已清理 |

## 2 发布件清单

```
dsd-director/                       568 KB
├── README.md                       10834
├── README_EN.md                     8011
├── CHANGELOG.md                     2909
├── pyproject.toml                    421
├── __init__.py                       757  注册节点 + HTTP 路由 + WEB_DIRECTORY
├── dsd_nodes/
│   ├── __init__.py                    67
│   ├── nodes.py                    43004  5 节点 + 几何 + 锐化 + SRT/EDL
│   └── routes.py                    2914  POST /dsd/preflight
├── web/js/dsd_director.js         114021  自绘面板
└── docs/
    ├── panel.png                  245226
    ├── 80-director-node-redesign.md  20006
    ├── 81-widget-contract.md          3666
    ├── 83-director-v2-verification.md 11270
    ├── 84-director-ui-v2-1.md          9884
    └── 85-director-v2-2-preflight-overrides-export.md 11469
```

## 3 发布前实测（全部通过）

| 项 | 结果 |
| --- | --- |
| `_a_test_assemble.py` | ALL OK（6 用例：单镜/双镜/三路素材/空镜/严格模式/模板覆盖） |
| `_a_test_refs.py` | ALL OK 5 |
| `_a_test_overrides.py` | ALL OK（含 SRT/EDL 17 项） |
| `_a_test_preflight.py` | ALL OK 88 |
| `py_compile nodes.py routes.py` | OK |
| `node --check dsd_director.js` | OK |
| 重启后 `/api/object_info/DSDDirector` | required 8 + optional 31 |
| `/extensions/dsd-director/js/dsd_director.js` | 200 / 114021 B（与磁盘一致） |
| `POST /dsd/preflight`（无参考图） | 200，`ok:false`，1 错 1 警，首行 `[E] shots 全片没有任何参考图…` |
| 浏览器建节点 | 37 widget / 23 按钮 / 15 素材槽 / 1 个覆盖条 / `.dsd-panel` 在 |
| 中英来回切两次 | 切换前后 DOM 节点数都是 208，面板不空（rehost bug 已修） |
| 载入英文工作流 `DSD-director-v2-best-2x.json` | `loadGraphData` 无异常，9 节点，node90 36 widget，`graphToPrompt` 推出 39 输入 |
| 改路径后真跑 | prompt `b90109f2`，wall 120 s，产物 `output/dsd/postpatch_00001-audio.mp4` 704x384 / 124 帧 |
| overrides 真跑（发布前一轮） | prompt `0c5b1c77`，wall 400 s，362 帧；SRT/EDL 逐段写出 s1 `steps=2 shift=6.0/3.0`、s2/s3 `steps=2 shift=12.0/3.0` |

SRT 实测原文（`output/dsd/exports/inline-20261120-173234.srt`）：

```
1
00:00:00,000 --> 00:00:05,167
s1 | steps=2 shift=6.0/3.0 | subject_definitions: <Subject 1> 是<Picture 1>至参考图中的少女…
```

EDL 实测原文：

```
001  AX       V     C        00:00:00:00 00:00:05:04 00:00:00:00 00:00:05:04
* FROM CLIP NAME: s1
* COMMENT: steps=2 shift=6.0/3.0
```

## 4 仍需人拍板的两件事

### 4.1 许可证

包内没有 `LICENSE`，`pyproject.toml` 里也故意没写 `license` 字段。`film-pipeline` 项目本身没有许可证文件，同目录的 `ComfyUI-DCW` 用的是 GPL-3.0。

这不是我该替用户决定的：选 MIT/Apache-2.0 意味着别人可以闭源商用，选 GPL-3.0 会传染到调用方，选「保留所有权利」则 Manager 里装不了。**填好之前不要发到 Registry。**

### 4.2 ComfyUI Registry 的 PublisherId

`pyproject.toml` 的 `[tool.comfy]` 目前只有 `DisplayName` 与 `requires-comfyui`。要发 Registry 还需要 `PublisherId`（注册后由 registry 分配）。本地安装/手动拷贝不依赖它。

## 5 与 AIMixer 的边界（发布件里已写清）

- 我们的镜头表是节点内联 `timeline_data`，AIMixer 也是内联，这点一致；差异在我们不用 `PackedLayout` 猴补丁（AIMixer 那份与 `ComfyUI-H3-Motion-Context` 硬互斥）。
- 我们不做负面提示词输入框：模型链路里负面条件是死的（AIMixer `nodes/conditioning.py:175` 直接 `return positive, [], latent, hint`），做一个不生效的控件等于骗人。
- `pass2_steps = 0` 是合法降级（只放大不重绘），AIMixer 的 latent_upscale 等价但要求外部接 SIGMAS 否则 `raise ValueError`。
- 我们只有 5 个节点、2 个 optional 口；AIMixer 11 个节点、6 个 `MMX_DIR_*` 包口。

## 6 复现

```bash
# 回归
cd ~/Documents/deepseek-harness/default-workspace/film-pipeline
python src/_a_test_assemble.py && python src/_a_test_refs.py
python src/_a_test_overrides.py && python src/_a_test_preflight.py
cd "E:/Comfy/comfyui-licyk-20260608/core/custom_nodes/dsd-director"
python -m py_compile dsd_nodes/nodes.py dsd_nodes/routes.py
node --check web/js/dsd_director.js

# 重启后探针
curl -s http://127.0.0.1:8188/api/object_info/DSDDirector | python -m json.tool | head
curl -s -X POST http://127.0.0.1:8188/dsd/preflight -H "Content-Type: application/json" \
     -d "{\"timeline\":{\"shots\":[{\"id\":\"s1\",\"seconds\":5.1667,\"prompt\":\"x\",\"refs\":[]}]}}"
```

## 7 文档关系

`docs/80` 解释了为什么把数据源搬进节点，`81` 是 widget 逐位契约，`83` 是 v2 端到端验收，`84` 是面板 2.1 的五项交互，`85` 是体检 / 镜头级覆盖 / SRT+EDL。本文件是发布件清单与发布前实测，属于这五篇之上的收口。

## 8. 内核随包（v2.2.0 最后一项阻塞）

### 8.1 问题

`dsd_nodes/nodes.py:199` 原来的 `DSD_SRC` 只指向 `~/Documents/deepseek-harness/default-workspace/film-pipeline/src`，`_load_dsd()` 靠 `sys.path.insert` 再 `import dsd`。别人只把 `dsd-director` 拷进 `custom_nodes/` 会得到 `ModuleNotFoundError: No module named 'dsd'`，而报错文本完全看不出缺什么、去哪补。

### 8.2 处置

内核导入面先核实干净：只依赖 `torch` / `comfy.*` / `comfy_extras.*` / 标准库，`executor.py` 用相对导入 `from .handoff` / `from .sampling` / `from .plan`，`__init__.py` 用 `from .plan` / `from .nodes`，没有任何到 `film-pipeline` 的相对路径（docstring 里的 `docs/NN` 只是编号引用）。据此 vendor：

| 文件 | 字节 | 作用 |
| --- | --- | --- |
| `dsd/__init__.py` | 580 | 导出 `PlanError` / `load_plan` / `validate_plan` |
| `dsd/plan.py` | 24680 | `dsd-shots/1` 计划模型、`validate_plan`、`segment_plan`、镜头级 overrides |
| `dsd/executor.py` | 62065 | 分段执行器 |
| `dsd/handoff.py` | 6601 | 段间接力（latent prefix / ramp / anchor） |
| `dsd/sampling.py` | 9556 | 双时钟 Euler / exp2 积分器 |
| `dsd/preflight.py` | 24315 | 19 条提交前检查 |
| `dsd/nodes.py` | 127 | 占位（内核不注册节点） |

合计 127924 B / 2818 行。

解析顺序改为 **`DSD_SRC` 环境变量 > 包内 `dsd/` > `film-pipeline/src`**：

```python
def _bundled_dsd_root():
    here = os.path.dirname(os.path.abspath(__file__))
    root = os.path.dirname(here)
    return root if os.path.isfile(os.path.join(root, "dsd", "__init__.py")) else ""

DSD_SRC = (os.environ.get("DSD_SRC") or _bundled_dsd_root() or os.path.join(
    os.path.expanduser("~"), "Documents", "deepseek-harness",
    "default-workspace", "film-pipeline", "src"))
```

`dsd_nodes/routes.py` 的 `sys.path` 注入用同一套顺序，所以面板的 `/dsd/preflight` 也走包内副本。启动日志新增一行 `[DSD] kernel: <dsd/__init__.py 绝对路径> (resolved from <DSD_SRC>)`。

### 8.3 防漂移

`scripts/sync_kernel.py`：

```bash
python scripts/sync_kernel.py          # 复制并打印 sha256 对照
python scripts/sync_kernel.py --check  # 只比较；不一致退出码 1
```

`VENDOR.md` 记录解析顺序、文件表、为什么 vendor、以及副本漂移的代价。

### 8.4 实测

| 项 | 结果 |
| --- | --- |
| 独立 import（ComfyUI 自带 python，`sys.path` 只加包目录） | 指向 `...custom_nodes/dsd-director/dsd/__init__.py` |
| `DSD_SRC` 实际值 | `E:/Comfy/comfyui-licyk-20260608/core/custom_nodes/dsd-director` |
| `_load_dsd()` 返回的 executor / plan | 都在包内 `dsd/` 下 |
| 7 文件 sha256 前 12 位 | 包内与 `film-pipeline/src/dsd` 逐字节相同 |
| `scripts/sync_kernel.py --check` | 7 行 ok + `in sync`，EXIT=0 |
| 重启后 `/api/object_info/DSDDirector` | required 8 + optional 31 |
| 重启后 `/extensions/dsd-director/js/dsd_director.js` | 200 / 114021 B（与磁盘一致） |
| 重启后 `POST /dsd/preflight` | 200，`ok:false`，`E_NO_MATERIAL` |

### 8.5 包内清单（25 个文件 / 644774 B / 629.7 KB）

| 路径 | 字节 |
| --- | --- |
| `__init__.py` | 757 |
| `pyproject.toml` | 421 |
| `README.md` | 11972 |
| `README_EN.md` | 8737 |
| `CHANGELOG.md` | 3762 |
| `VENDOR.md` | 2282 |
| `dsd_nodes/nodes.py` | 44160 |
| `dsd_nodes/routes.py` | 3976 |
| `dsd_nodes/__init__.py` | 67 |
| `dsd/ (7 kernel files)` | 127924 |
| `web/js/dsd_director.js` | 114021 |
| `scripts/sync_kernel.py` | 1950 |
| `docs/ (6 md files)` | 70871 |
| `docs/panel.png` | 253874 |

### 8.6 路径优先级真 bug（重启后才发现）

vendor 完第一次重启，启动日志实际打印的是：

```
[DSD] kernel: C:\Users\...\film-pipeline\src\dsd\__init__.py (resolved from E:\Comfy\...\custom_nodes\dsd-director)
```

`resolved from` 明明是包目录，加载到的却是工作区那份。根因在 `routes.py`：

```python
for _p in ((_BUNDLED,) if _BUNDLED else ()) + (os.path.join(_SRC, "src"),):
    if os.path.isdir(_p) and _p not in sys.path:
        sys.path.insert(0, _p)   # 先插包内，再插 film-pipeline/src
```

`insert(0)` 两次的净效果是把**后插的那条顶到最前**，于是 `film-pipeline/src` 反而优先，`import dsd` 拿到工作区副本。只在「包内副本与工作区副本行为一致」时看不出来，一旦两边漂移就会静默跑错内核。

两处一起改：

1. `routes.py`：先把目标路径全部从 `sys.path` 摘掉，再按优先级**反序** `insert(0)`，保证包内在前；若 `sys.modules` 里的 `dsd` 不是包内那份就整体清掉。
2. `nodes.py` 的 `_load_dsd()`：同样先摘再插 `DSD_SRC`，并在 `import dsd` 前检查缓存来源，不匹配就清空重来。

复现式验证（把 `film-pipeline/src` 故意先塞进 `sys.path`，再导节点模块并调用 `_load_dsd()`）：

```
DSD_SRC: E:\Comfy\...\custom_nodes\dsd-director
executor: E:\Comfy\...\custom_nodes\dsd-director\dsd\executor.py
plan    : E:\Comfy\...\custom_nodes\dsd-director\dsd\plan.py
BUNDLED_WINS: True
```

重启后真实日志也变成 `[DSD] kernel: ...\custom_nodes\dsd-director\dsd\__init__.py`。

教训：`sys.path.insert(0, ...)` 的**调用顺序与最终优先级相反**；多路径优先级要么只插一条，要么显式排序后反序插入。报告里的 `resolved from` 只能证明字符串算对了，不能证明 `import` 真的走到了那里 —— 要打 `dsd.__file__`。


### 8.7 修完路径优先级后的复验

| 项 | 结果 |
| --- | --- |
| 启动日志 | `[DSD] kernel: ...\custom_nodes\dsd-director\dsd\__init__.py`（全日志 1 条，无第二条） |
| 故意污染 `sys.path` 后调 `_load_dsd()` | `BUNDLED_WINS: True`，executor/plan 都在包内 |
| `/api/object_info/DSDDirector` | required 8 + optional 31 |
| `/extensions/dsd-director/js/dsd_director.js` | 200 / 114021 B |
| 真跑（走包内内核） | prompt `81698e10-b642-4777-b58f-7772a38b01ae`，`DONE success`，**wall 126 s**，`postpatch_00003-audio.mp4` 704×384 / 124 帧 / 5.1667 s，导出 SRT 158 B + EDL 168 B |
| 浏览器面板（硬刷新后） | 5966→5866 类型注册；新建节点 **37 widget / 23 按钮 / 15 素材槽 / 1 个 .dsd-ovr / 1 个 .dsd-pf / .dsd-panel 在** |
| 回归 | assemble ALL OK · refs ALL OK 5 · overrides ALL OK · preflight ALL OK 88 |
### 8.8 净装验收（解压即用）

把发布包打成 `out/dsd-director-2.2.0.zip`（25 条目 / 392427 B），解压到一个**全新的空目录**，再把该目录当 `custom_nodes/dsd-director`，清掉 `DSD_SRC` 与 `DSD_PROJECT_ROOT` 后跑探针：

| 项 | 结果 |
| --- | --- |
| `_bundled_dsd_root()` | 指向解压出来的那份 `dsd-director` |
| `dsd.__file__` | `<fresh>/custom_nodes/dsd-director\dsd\__init__.py` |
| `inside package` | `True`（没有回落到 film-pipeline） |
| `from dsd.preflight import preflight` | 可导入，空 timeline 返回 `ok False`、`codes [E_NO_SHOT, E_NO_MATERIAL]` |
| `from dsd.plan import Plan` | 可导入 |
| `dsd_nodes/nodes.py` 整体 exec | 通过（说明五个节点类的依赖在净环境下齐备） |

⇒ 「只把 dsd-director 拷进 custom_nodes」这条安装路径成立，不需要 clone film-pipeline、也不需要设环境变量。

### 8.9 仍未做

LICENSE 与 ComfyUI Registry 的 `PublisherId` 仍需人拍板（§4）；在那之前只支持「拷目录进 `custom_nodes/`」这一种安装方式。
