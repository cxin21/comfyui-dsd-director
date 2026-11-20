# 85 · 导演台 v2.2：体检、镜头级参数、时间线导出、缩略图与切分

日期：2026-11-20。承接 docs/84（面板 v2.1）。本轮把上一轮「仍未做」清单里除三分钟正片预算之外的项目全部实现并真跑验证。

## 0 结论

1. **提交前体检**已落地：`src/dsd/preflight.py`（613 行，19 个检查码，纯标准库）+ HTTP 路由 `POST /dsd/preflight`。浏览器实测点「体检」按钮，面板状态区出现两行红色 `[E]` 与末行统计；补齐参考图并加长提示词后再点，显示「没有发现问题。共 0 个错误、0 个警告。」
2. **镜头级参数覆盖**已落地并真跑：`shots[i].overrides` 支持 `steps` / `solver` / `shift_video` / `shift_audio` / `pass2_steps`。真跑 `ovr2`（两镜、362 帧）里第 1 镜 steps=4、第 2 镜 steps=1，导出文件逐段写明 `steps=4` 与 `steps=1`，证明覆盖在段级真的生效。
3. **时间线导出**：`export_mode = frames+timeline` 时节点写 `<output>/dsd/exports/<plan_id>-<stamp>.srt|.edl`。实测两份文件都落盘，SRT 每条含 `s1 | steps=4 shift=12.0/3.0 | …`，EDL 以 `* COMMENT:` 带同样摘要，24 fps 时间码 `00:00:05:04` 正确。
4. **时间轴缩略图**：`paintTimeline` 现在用 `refs[0]` 的图（或 `refVideos[0]` 的第 0.1 秒帧）画中心裁切缩略图；实测 4 个镜头块都出现照片底色（1024x109 的 canvas 上 102 个颜色桶），选中块用 `#8ef7ef` 描边。
5. **任意位置切分**：双击轨道按 `canvasX` 算帧切分，两半都守 `MIN_SHOT_FRAMES`。实测两镜时间线双击 25% 处 → `s1` 变 `2.5833s + 2.5833s`、总帧 248→248 不变；再双击 60% 处得 4 镜、无重复 id、总帧仍 248。
6. **预览台播上一次成片**：`executed` 事件 + localStorage 记忆，面板重建后仍能「看成片」。实测存在 `<video>` 元素且 tab 可切。
7. **墙钟改实测**：`segment_done` 的 `note`（如 `168.5s`）被 `parseFloat` 收下，摘要显示 `墙钟 1 min 40 s × 4 段 ≈ 6 min 40 s (实测)`；没有实测值时退回预设常量并标 `(估算)`。

## 1 体检（preflight）

### 1.1 模块

`src/dsd/preflight.py`：

```python
preflight(timeline, *, input_dir=None, min_chars=3000, strict=False)
    -> {"ok": bool, "errors": [...], "warnings": [...], "info": {...}}
preflight_text(timeline_json, **kwargs) -> str   # 给人和前端看的多行文本
detect_sections(prompt) -> (present, missing)
align17(n)
```

每条 issue 是 `{code, level, where, message, hint}`。19 个检查码：

| 级别 | code | 含义 |
| E | `E_NO_SHOT` | 时间线没有镜头或 JSON 坏 |
| E | `E_PROMPT_EMPTY` | 提示词为空 |
| W | `E_PROMPT_SHORT` | 提示词短于 `min_chars`（strict 时 3000，否则 1200） |
| E | `E_SHOT_TOO_SHORT` | 对齐后帧数不足一段窗口 |
| E | `E_NO_MATERIAL` | 无参考图也无参考视频 |
| E | `E_TOO_MANY_REFS` | 图 > 9 / 视频 > 3 / 音频 > 3 |
| E | `E_PICTURE_MISSING` | 用了 `<Picture K>` 但没有第 K 张 |
| E | `E_VIDEO_MISSING` | 同上，`<Video K>` |
| E | `E_AUDIO_MISSING` | 同上，`<Audio J>` |
| W | `W_PICTURE_UNUSED` | 有图但提示词没引用 |
| E | `E_CANVAS_STRIDE` | 画布不是 32 的倍数且 >= 128 |
| E | `E_FINAL_NOT_BIGGER` | 开 pass2 但 final 没严格大于 gen |
| W | `W_FINAL_OFF_GRID` | final 不是 16 的倍数 |
| E | `E_WINDOW_GRID` | `window_frames` 不在 17k+5 或超出 124..362 |
| E | `E_CTX_SET` | `context_frames` 不在 5/22/39 |
| W | `W_TIMELINE_GAP` | 段与镜头时长对不上（多出尾巴） |
| W | `W_DUP_PROMPT` | 两镜提示词完全相同 |
| W | `W_REF_NOT_FOUND` | 引用文件在 input 目录里不存在 |
| W | `W_SUBJECT_ORDER` | `<Subject N>` 编号不连续 |

`PROMPT_SECTIONS` 八板块：`subject_definitions` / `quality_and_style` / `style_and_color_science` / `negative_constraints` / `summary` / `retention_analysis` / `detailed_description` / `camera_and_material`，与 `src/gen_ab_workflows.py` 的正文结构一致。

### 1.2 路由与按钮

`dsd_nodes/routes.py` 注册 `POST /dsd/preflight`。启动日志打 `[DSD] routes: /dsd/preflight`。

坑：ComfyUI 的 `server.PromptServer.routes` 是 `aiohttp.web.RouteTableDef`，**没有 `__getattr__`**，第一版写成 `routes.__getattr__(method)(path)(handler)` 直接 `AttributeError`，日志里是 `[DSD] routes register failed: AttributeError("'RouteTableDef' object has no attribute '__getattr__'")`，路由 405。正确写法 `getattr(routes, method.lower())(path)(handler)`。

前端 `runPreflight(ctx, btn)`：`api.fetchApi("/dsd/preflight", {method:"POST", body: JSON.stringify({timeline, strict, min_chars: strict ? 3000 : 1200})})`，把返回的 `text` 按行拆，`[E]` 红 `[W]` 黄渲染进 `.dsd-pf`，同时把汇总写进 notice。

### 1.3 实测

HTTP 直连（`src/_t_pf_http.py`）：`STATUS 200 / ok False`，文本：

```
[E] canvas.gen 1377x768 不合法：宽=1377 不是 32 的倍数：最近合法值 1376x768（宽高都取 32 的倍数，且 >= 128）
[E] render.window_frames window_frames=130 不在 17k+5 网格上，或超出 124..362：最近合法值 124 或 141 (17k+5, 且 124..362)
[W] shots[0].prompt 只有 5 字（需要 3000）：还差 2995 字。建议补 subject_definitions 与 quality_and_style 板块。
[W] shots[0].refs 有 1 张图但提示词没有引用任何 <Picture N>：建议为第 1 张加 <Picture 1>
[W] shots[0].refs input 目录里找不到 'a.jpg'：把文件放进 E:\Comfy\comfyui-licyk-20260608\core\input，或改掉这条引用
共 2 个错误、3 个警告。
```

浏览器里点按钮：先看到 `[E] shots[0].refs 提示词引用了 <Picture 2>，但该镜只有 1 张参考图`，补齐第二张并把提示词加长后变「没有发现问题。」（截图 `out/wf/panel-preflight.png`）。

## 2 镜头级参数覆盖（overrides）

### 2.1 数据与校验

`plan.py` 的 `Shot` 加 `overrides: dict[str, Any] = field(default_factory=dict)`。合法键：

```python
SHOT_OVERRIDE_KEYS = ("steps", "solver", "shift_video", "shift_audio", "pass2_steps")
```

`validate_shot_overrides(raw, where)`：未知键、类型不对、超出范围（`SHOT_OVERRIDE_RANGES` / `SHOT_OVERRIDE_SOLVERS`）都抛 `PlanError("E_SHOT_OVERRIDE")`。`shot_overrides_effective(shot, base)` 把覆盖叠加到 `base_params(plan)` 上，`override_brief(eff)` 给 `steps=N shift=V/A` 这种一行摘要（SRT/EDL 用它）。

### 2.2 执行侧

`executor.py` 在段循环里把该段的 effective 参数放进 `self._seg_ov`，`_sample()` 段首读它：

- `steps` 的解析**必须放在 sigmas 计算之前**，否则 sigmas 先按基线的 4 步算好、覆盖就白写；它同时驱动 `native_flow_sigmas` / `partial_start_sigmas` / `self._cur_steps` / `profile["sample"]["steps"]` / 日志；
- `solver` 走 `make_dual_clock_sampler(..., solver=...)`，内部就是 `integrate = dual_clock_exp2 if solver=="exp2" else dual_clock_euler`，换积分器不动 sigmas/NFE；
- `shift_video`/`shift_audio` 走 `_model_for()`，按 `(round(sv,6), round(sa,6))` 记忆化，相同 shift 的相邻段复用同一个 clone（避免每段重新加载 20 GB 底模）；
- `pass2_steps` 走 `_refine_latent(..., steps2=, shift_video=, shift_audio=, solver=)`。

`run_plan` 的 report 里每段多 `shot_id` / `overrides` / `effective` 三个字段，`_report["shot_overrides"]` 只在真的有覆盖时写，避免污染无覆盖的报告。

### 2.3 真跑

`out/wf/ovr2-api.json`：两镜各 5.1667 s（232 帧），第 1 镜 `{"steps":4,"shift_video":12.0}`，第 2 镜 `{"steps":1,"shift_video":12.0}`，704x384 / pass2 关 / seed 2609198740。

```
DONE success completed True wall 403
ovr2_00001-audio.mp4  704x384  362 帧  15.0833 s  24 fps
[DSD] dsd: 3 段 362 帧 15.1s 用时 6.6min handoff=latent_prefix steps=2 pass=1
```

3 段 = 124 + 119 + 119。导出文件逐段写的 `steps` 是 `4` / `1` / `1`，即第 1 镜吃 4 步、第 2 镜吃 1 步。`[DSD]` 汇总行的 `steps=2` 是节点 widget 的基线值，不是段级实际值 —— 段级值只在 report 与导出件里。

## 3 时间线导出（SRT + EDL）

`export_mode` 现在是 `frames` / `frames+report` / **`frames+timeline`**。选最后一项时 `render()` 尾部调 `_write_timeline_exports()`，写 `<output>/dsd/exports/<plan_id>-<stamp>.srt` 与 `.edl`（`newline="\n"`）。plan_id 是从内存里的 timeline 取，没有任何 plan 文件时就是 `inline`。

实测（`inline-20261120-170718.srt`）：

```
1
00:00:00,000 --> 00:00:05,167
s1 | steps=4 shift=12.0/3.0 | [Shot 1] 0至2秒：镜头缓慢推进…

2
00:00:05,167 --> 00:00:10,125
s2 | steps=1 shift=12.0/3.0 | [Shot 1] 0至2秒：镜头缓慢推进…
```

EDL 用 24 fps 时间码（`00:00:05:04` = 第 125 帧）并带 `* COMMENT: steps=1 shift=12.0/3.0`。两份文件都能直接被剪映/Premiere/DaVinci 导入当参考轨。

## 4 面板交互补齐

| 能力 | 实现位置 | 实测 |
| 时间轴缩略图 | `thumbCache` / `thumbSource` / `drawCover` / `drawShotThumb`，`paintTimeline` 块循环内 | canvas 1024x109 有 102 个颜色桶，4 个块都是照片底色 |
| 任意位置切分 | `shotStartFrame` / `splitShotAt` / `splitAtPlayhead`，canvas `dblclick` | 两镜切 25% 处 → 3 镜；再切 60% 处 → 4 镜，无 id 重复，总帧不变 |
| 预览台播成片 | `sectionStage` 两个 tab + `executed` 监听 + localStorage | `<video>` 存在，tab 可切 |
| 墙钟实测 | `recordSegmentSeconds` / `finishWallClock`，挂 `segment_done` 与 `done` | 摘要显示 `1 min 40 s × 4 段 ≈ 6 min 40 s (实测)` |
| 体检按钮 | `runPreflight` + `.dsd-pf` 结果区 | 见 §1.3 |

## 5 本轮修掉的 bug

1. **路由注册 `AttributeError`**：`RouteTableDef` 没有 `__getattr__`，见 §1.2。
2. **JS 里出现字面换行**：给 i18n 批量插 key 时把 `\n` 写成了真换行，文件里出现 `String(...).split("` + 换行 + `")`，`node --check` 能过（它只查语法）但浏览器 `import` 报 `SyntaxError: Invalid or unexpected token`，整个扩展不执行、节点 36 widget 无面板。定位手法：页面里 `await import("/extensions/dsd-director/js/<file>.js?bust=...")` 拿 `e.name/e.message`，再 `python -c` 打印 `repr(片段)` 看真实字节。
3. **`evaluate_script` 里 await 超约 60 s 报 `Request timed out`**：长轮询必须拆成多次短调用。

## 6 复现

```bash
python src/_a_test_preflight.py          # 88 checks
python src/_a_test_overrides.py          # 23 checks
python src/_a_test_assemble.py && python src/_a_test_refs.py
python src/_t_pf_http.py                 # 打 /dsd/preflight
python src/_mk_ovr2.py                   # 造两镜 overrides 工作流
python src/_wf_run.py out/wf/ovr2-api.json ovr2 1200
```

## 7 仍未做

1. 三分钟正片仍未整跑（2x 交付 720–910 s/段 × 37 段 = 7.4–9.3 h，超 6 h 上限）。
2. 实体说明模板只有中文；英文界面下生成的中文模板不翻译。
3. overrides 目前没有面板入口，只能写 timeline_data 的 JSON（后端已就绪，缺 5 个输入框）。
4. `preflight` 的 `input_dir` 只在显式传时检查文件存在，面板调用没传，所以 `W_REF_NOT_FOUND` 在面板里不会出现。

## 8 文档关系

docs/84（v2.1 面板）→ **docs/85（本文，v2.2）**。相关：docs/80（重设计）、docs/81（widget 合同）、docs/83（v2 验收）、docs/78（与 AIMixer 的缺口清单）。