# docs/80 · DSDDirector 节点重新设计（内联数据源版）

日期：2026-11-20 · 上游：docs/77（实现规格）、docs/78（面板差距 46 项）、docs/79（面板不显示排障）
本轮起因（用户原话 m11506 / m11510）：

> 「plan_json里面是什么东西呢，为什么还有参考图，如果是分段、提示词、参考图、参考视频这种的我希望参考ComfyUI_MiniMaxH3_Director这样的方式，在UI页面处理而不是写文件，对人来说不友好，你可以自己内部组装，此外，最优的一采参数和超采样参数、是否开启应该也是支持UI配置，但是我们预置一个针对当前机器的最优参数」
> 「你先好好分析分析节点到底怎么写，然后重新设计吧」

---

## 0. 结论（七条）

1. **当前节点的根本问题不是面板难看，是数据源放错了位置。** 镜头表住在磁盘 JSON 里（`plan_path` 是 required 第一位），UI 只是它的只读投影。所有「编辑」能力都无从谈起 —— 因为编辑的对象不在一处可写的地方。
2. **重设计的第一原则：`timeline_data` 是唯一真相源，住在节点里。** 它是一个 hidden 的 STRING widget（和 ComfyUI_MiniMaxH3_Director 同款做法），plan dict 由节点在 `render()` 里**内存组装**，运行路径上不再读写任何 plan 文件。
3. **`plan_path` 从 required 降为 optional 模板口**：空 = 纯 UI 模式；给路径 = 把该文件当初始模板读入（导入用），运行不依赖它存在。
4. **参考素材必须真正可传**：图 9 / 视频 3 / 音频 3，走 ComfyUI `input` 目录文件名（前端用现成的 `/upload/image`），节点内用 cv2 解码视频帧、用 comfy 音频加载器读音频，直通 `MiniMaxH3ReferenceToVideo` 的 `ref_images` / `ref_videos` / `ref_audios`。**当前后端只接了 `ref_images` 一路**（`src/dsd/executor.py:553`），必须扩。
5. **参数分三层**：内置常量 9 项（物理约束，UI 上不给假控件，只在灰字里列出）/ 参数可控 24 项（分四个 BDGROUP）/ 预设 4 档（点一下把整套参数写回，当前机器默认就是「本机最优 2x」）。
6. **进度必须是真的**：后端 `PromptServer.send_sync("dsd_progress", …)`，前端按 node id 匹配；「运行全部」必须真的调 `app.queuePrompt`。现在两者都是装饰（`dsd_director.js:646` 只改文字，后端全仓 0 处 `send_sync`）。
7. **widget 顺序是位置契约，这次要一次排定终版并加 `schema_version`**，之后只许在末尾追加。中途插一个 widget 会让所有旧工作流后面每个控件的取值整体错位一格（docs/79 现场踩过：`control_after_generate` 就占一个纯前端槽位）。

---

## 1. 现状诊断：三个结构性问题

### 1.1 数据源倒置

`render()`（`dsd_nodes/nodes.py:343`）的第一件事是：

```python
path = plan_path if os.path.isabs(plan_path) else os.path.join(base, plan_path)
raw = json.load(open(path, "r", encoding="utf-8"))
```

之后的所有 widget 都是**对这份磁盘 JSON 的覆盖层**。后果：

- `inline_prompt` 只能写 `shots[0]["prompt"]`（`nodes.py:356`），**第二镜以后的提示词永远改不了**；
- 镜头的 `seconds` 完全没有 widget；
- 参考图只能改 plan 文件再重启；
- 删掉 plan 文件节点就直接崩（`FileNotFoundError`）。

### 1.2 参考素材是假槽位

`renderRefs()`（`dsd_director.js:537`）把 9 个 div 的文字硬编码成「主角
（plan refs）」。**没有上传、没有缩略图、没有删除**。
后端（`nodes.py:418`）只做一件事：从 input 目录按文件名读图，`Image.open(...).convert("RGB")`，最多 9 张，然后：

```python
images = {"ref_image_%d" % i: f for i, f in enumerate(self.ref_frames)}
out = MiniMaxH3ReferenceToVideo.execute(..., ref_images=images)
```

⇒ **视频与音频参考根本没有通路**，尽管 `MiniMaxH3ReferenceToVideo` 本身支持 `ref_videos`（最多 3）/ `ref_video_audios`（最多 3）/ `ref_audios`（最多 3）。

### 1.3 运行与进度是装饰

| 位置 | 现状 | 代码 |
| 「运行全部」 | 只把状态文字改成「待命」并把进度条归零 | `dsd_director.js:646-652` |
| 「EN」 | 只翻转按钮自身文字 | `:643-645` |
| 进度条 | 永远 0% | 后端 0 处 `send_sync` |
| 「每段 720 s」 | 硬编码常量 | `renderSummary()` |
| 输出条 | 同时显示「交付 2560x1440」与「按倍数推算 2752x1536」，不说以谁为准 | `renderOuts()` |

---

## 2. 设计原则（五条，后续所有取舍按此判）

| 编号 | 原则 | 落地含义 |
| P1 | **单一数据源在节点内** | `timeline_data` 是唯一真相源；面板改它，节点读它；磁盘不是真相 |
| P2 | **磁盘只进不出** | 可以导入模板 JSON，但运行链路不写不读 plan 文件（report 可选另存）|
| P3 | **UI 是第一等公民** | 每个能改的参数都要有控件；每个控件都必须写回 widget（不是写进 DOM 的局部状态）|
| P4 | **预设即默认** | 新拖一个节点出来、什么都不改，直接能跑出本机最优成片 |
| P5 | **不可见的不撒谎** | 内置常量在「内置常量（只读）」组里灰字列出**实际生效值**，不摆假控件 |

---

## 3. 数据模型

### 3.1 `timeline_data` 结构（v2）

```json
{
  "v": 2,
  "fps": 24,
  "shots": [
    {
      "id": "s1",
      "seconds": 5.1667,
      "prompt": "<Picture 1> ...",
      "refs": ["dsref_main.jpg"],
      "refVideos": [],
      "refAudios": [],
      "motionExpect": 1.0,
      "seed": null,
      "note": ""
    }
  ]
}
```

规则：

- `shots` 至少 1 项，`seconds > 0`；`align17(round(seconds*24)) >= context_frames`（`plan.py:341-343` 已有校验）；
- `refs` / `refVideos` / `refAudios` 里只能是 **ComfyUI input 目录内的文件名**（不是绝对路径）；
- `prompt` 长度下限：`strict=True` 时用 plan 的 `min_chars`（默认 3000）；`strict=False` 时放行到 0；
- 面板是唯一写者；`onConfigure` 时若 `timeline_data` 为空则用节点默认（单镜 5.1667 s，空提示词）。

### 3.2 内部组装（新增 `_assemble_plan()`）

```python
def _assemble_plan(timeline_data, total_frames, gen, window, ctx, ffn, pass2, upscale,
                   final_wh, pass2_steps, pass2_sigma, steps, solver, shifts, handoff, strict):
    tl = json.loads(timeline_data or "{}")
    shots = tl.get("shots") or [{"id": "s1", "seconds": 124/24.0, "prompt": "", "refs": []}]
    raw = {
        "schema": "dsd-shots/1",
        "id": "inline",
        "canvas": {"gen": [gen_w, gen_h], "final": final_wh},
        "render": {"window_frames": window, "context_frames": ctx, "fps": 24,
                   "handoff": handoff, "seam_min": 0.1, "steps": steps,
                   "vae_tile": 0, "shift_video": sv, "shift_audio": sa,
                   "solver": solver, "ffn_chunks": ffn,
                   "pass2": pass2, "pass2_model": UPSCALER,
                   "pass2_steps": pass2_steps, "pass2_sigma": pass2_sigma,
                   "pass2_size": final_wh},
        "shots": shots,
        "min_chars": 3000 if strict else 0,
    }
    return plan_mod.validate_plan(raw, min_chars=None if strict else 0)
```

`plan_path` 非空时：先 `json.load` 该文件作为模板，再用 `timeline_data` 的 `shots`（若非空）覆盖模板的 `shots`；**widget 永远最后覆盖**（保持现在 `nodes.py` 里那套覆盖顺序）。

---

## 4. Widget 表（终版顺序）

### 4.1 required（8 项，前 4 项是连线口）

| # | 名 | 类型 | 默认 | 说明 |
| 1-4 | model / clip / video_vae / audio_vae | MODEL / CLIP / VAE / VAE | — | 连线 |
| 5 | `seed` | INT | 2609198601 | 面板上放「固定 / 随机ize」 |
| 6 | `preset` | COMBO | `本机最优 2x` | **本机最优 2x / 1.5x 快速 / 1x 原生 / 自定义** |
| 7 | `strict` | BOOLEAN | True | 关掉则允许短提示词、跳过 seam 验收 |
| 8 | `budget_gib` | FLOAT | 7.9 | 仅记录进 report（源码里是死参数，`executor.py:414` 后再无读取）|

### 4.2 optional（31 项 = 6 个 BDGROUP 标记 + 25 个参数）

顺序即 `widgets_values` 顺序，与 docs/81 逐位一致。**BDGROUP 必须留在 optional**：放 required 会让缺项直接 400 required_input_missing。

| # | 组 | widget | 类型 | 默认 | 备注 |
| 1 | 镜头 | `bd_grp_shot` | BDGROUP | 镜头 | 分组标记 |
| 2 | 镜头 | `timeline_data` | STRING multiline | `{"v":2,"fps":24,"shots":[...]}` | **前端隐藏，面板写**；镜头真相源 |
| 3 | 镜头 | `total_frames` | INT | 124 | 面板只读显示，由 shots 推算后写回 |
| 4 | 采样 | `bd_grp_s2` | BDGROUP | 采样 | 分组标记 |
| 5 | 采样 | `steps` | INT | 4 | 实测 4 vs 8 在 seed 噪声内（docs/69）|
| 6 | 采样 | `solver` | COMBO | euler | euler / exp2（只有 2 值）|
| 7 | 采样 | `shift_video` | FLOAT | 12.0 | step 0.1 |
| 8 | 采样 | `shift_audio` | FLOAT | 3.0 | step 0.1 |
| 9 | 采样 | `handoff` | COMBO | latent_prefix | 3 值：latent_prefix / latent_prefix_ramp / latent_prefix_anchor |
| 10 | 几何 | `bd_grp_geo` | BDGROUP | 几何与窗口 | 分组标记 |
| 11 | 几何 | `gen_w` | INT | 1376 | step 32，必须 %32 |
| 12 | 几何 | `gen_h` | INT | 768 | step 32，必须 %32 |
| 13 | 几何 | `window_frames` | INT | 124 | step 17，必须 17k+5 且在 [124,362] |
| 14 | 几何 | `context_frames` | COMBO | "5" | **字符串** "5" / "22" / "39"，用前 int() |
| 15 | 几何 | `ffn_chunks` | INT | 4 | 只省显存，不加速（docs/74 §2）|
| 16 | 几何 | `tile_size` | INT | 512 | step 64，落在几何组末尾（VAE 分块解码的 tile）|
| 17 | 超采样 | `bd_grp_decode` | BDGROUP | 解码超采样 | 分组标记 |
| 18 | 超采样 | `pass2` | BOOLEAN | True | **是否开启超采样** |
| 19 | 超采样 | `upscale` | COMBO | "2.0" | "1.0" / "1.25" / "1.5" / "2.0" |
| 20 | 超采样 | `final_w` | INT | 0 | 0 = 按 upscale 自动 |
| 21 | 超采样 | `final_h` | INT | 0 | 0 = 按 upscale 自动 |
| 22 | 超采样 | `pass2_steps` | INT | 0 | 0 = 只放大不重绘（8 GB 上 >0 会 OOM，docs/72）|
| 23 | 超采样 | `pass2_sigma` | FLOAT | 0.0 | max 0.95 |
| 24 | 交付 | `bd_grp_deliver` | BDGROUP | 性能与交付 | 分组标记 |
| 25 | 交付 | `out_w` | INT | 2560 | step 32 |
| 26 | 交付 | `out_h` | INT | 1440 | step 32 |
| 27 | 交付 | `unsharp` | FLOAT | 0.8 | 2752 原生上做，再降采样（docs/72 §5）|
| 28 | 交付 | `export_mode` | COMBO | frames | frames / frames+report |
| 29 | 模板 | `bd_grp_tpl` | BDGROUP | 模板与内置常量 | 分组标记 |
| 30 | 模板 | `plan_path` | STRING | `""` | **空 = 纯内联模式**；非空 = 当模板导入 |
| 31 | 模板 | `builtin_note` | STRING multiline | 见下 | 只读灰字 |

已删除：`inline_prompt`（并入 `timeline_data.shots[i].prompt`）、`pass2_model`（内置常量 `_UPSCALER`）、`bd_grp_builtin`（改名 `bd_grp_tpl`）。

| 组 | widget | 类型 | 默认 | 备注 |
| 镜头 | `timeline_data` | STRING multiline | `{"v":2,"shots":[...]}` | **hidden**，面板写 |
| 镜头 | `total_frames` | INT | 124 | 面板只读显示，由 shots 推算后写回 |
| 采样 | `steps` | INT | 4 | 实测 4 vs 8 在 seed 噪声内（docs/69）|
| 采样 | `solver` | COMBO | euler | euler / exp2 |
| 采样 | `shift_video` | FLOAT | 12.0 | |
| 采样 | `shift_audio` | FLOAT | 3.0 | |
| 采样 | `handoff` | COMBO | latent_prefix | 6 值，暴露前 3 个即可 |
| 几何 | `gen_w` | INT | 1376 | step 32 |
| 几何 | `gen_h` | INT | 768 | step 32 |
| 几何 | `window_frames` | INT | 124 | 必须 17k+5 |
| 几何 | `context_frames` | COMBO | 5 | 5 / 22 / 39（56 待验）|
| 几何 | `ffn_chunks` | INT | 4 | 只省显存，不加速（docs/74 §2）|
| 超采样 | `pass2` | BOOLEAN | True | **是否开启超采样** |
| 超采样 | `upscale` | COMBO | `2.0` | 1.0 / 1.25 / 1.5 / 2.0 |
| 超采样 | `final_w` / `final_h` | INT | 0 / 0 | 0 = 按 upscale 自动 |
| 超采样 | `pass2_steps` | INT | 0 | 0 = 只放大不重绘（8 GB 上 >0 会 OOM，docs/72）|
| 超采样 | `pass2_sigma` | FLOAT | 0.0 | |
| 交付 | `out_w` / `out_h` | INT | 2560 / 1440 | |
| 交付 | `unsharp` | FLOAT | 0.8 | 2752 原生上做，再降采样（docs/72 §5）|
| 交付 | `export_mode` | COMBO | frames | frames / frames+report |
| 模板 | `plan_path` | STRING | `""` | **空 = 纯 UI 模式** |
| 内置 | `builtin_note` | STRING | 见下 | 只读灰字 |

`builtin_note` 的内容（面板与节点里同一份常量，不允许两处各写一份）：

```
24 fps | 音频 40 Hz 时钟 | 帧时间比 5:3 | canvas 必须 %32 | window 必须 17k+5
vae_tile 恒 0（tile>0 会打进 16px 网格与 17 帧暗闪，docs/66）
decode_shifts 恒空 | partial_start 恒 0 | seam_min 0.1
```

### 4.3 预设表（`preset` 的取值 → 写回哪些 widget）

| preset | gen | upscale | final | out | unsharp | 实测墙钟 |
| 本机最优 2x | 1376x768 | 2.0 | 2752x1536 | 2560x1440 | 0.8 | 724 s / 124 帧（ffn1，docs/74）<br>1085 s（节点内 bicubic 路径，本轮实测）|
| 1.5x 快速 | 1376x768 | 1.5 | 2080x1152 | 1920x1080 | 0.8 | 621 s / 124 帧 |
| 1x 原生 | 1376x768 | 1.0 | 1376x768 | 1376x768 | 0.0 | 683 s / 124 帧 |
| 自定义 | —— 不改动任何值 —— |

切换 preset 时前端**只写 widget、不跑渲染**；用户可再手改任一值（改完自动回落到「自定义」）。

---

## 5. 参考素材管线（三段，全部要真做）

### 5.1 图（最多 9）

`input/<name>` → `PIL.Image.open().convert("RGB")` → `/255.0` → `[1,H,W,C]`。现状已实现（`nodes.py:420-427`）。

### 5.2 视频（最多 3）

`input/<name>` → `cv2.VideoCapture` 逐帧读 → 按 24 fps 重采样 → 短边缩到 ≤704（保持比例，只缩不放）→ `[T,H,W,C]`，`T` 取 `min(总帧, 15*24)`。

参考实现：本机已装的 `ComfyUI_MiniMaxH3_Director/lib/video_io.py:184` 就是 `cv2.VideoCapture` 路线，可直接照抄参数。

### 5.3 音频（最多 3）

`comfy_extras.nodes_audio.load(path)` → `{"waveform": [1,C,N], "sample_rate": 44100}`。`LoadAudio` 的 `options` 用的是 `filter_files_content_types(..., ["audio","video"])`，**mp4 也能读**。

### 5.4 送进条件（唯一必须动后端的地方）

`executor.py:553` 现在只组 `ref_images`：

```python
images = {"ref_image_%d" % i: f for i, f in enumerate(self.ref_frames)}
out = MiniMaxH3ReferenceToVideo.execute(..., ref_images=images)
```

改成：

```python
kwargs = {}
if self.ref_images:  kwargs["ref_images"]  = {"ref_image_%d"  % i: f for i, f in enumerate(self.ref_images)}
if self.ref_videos:  kwargs["ref_videos"]  = {"ref_video_%d"  % i: f for i, f in enumerate(self.ref_videos)}
if self.ref_audios:  kwargs["ref_audios"]  = {"ref_audio_%d"  % i: f for i, f in enumerate(self.ref_audios)}
out = MiniMaxH3ReferenceToVideo.execute(..., **kwargs)
```

`attach_references()` 从「list of tensors」改成接受 dict（向后兼容：传 list 时落到 `ref_images`）。

---

## 6. 面板重设计（九段）

| # | 段 | 内容 | 关键交互 |
| 1 | 工具栏 | 运行全部 / 刷新面板 / 重算分段 / 导入模板 / 导出模板 / EN | **运行全部 → `app.queuePrompt(0)`**（不是改文字）|
| 2 | 预览台 | `<video>` + 海报 `<img>` | 点「上传」走 `/upload/image`，落进 input 目录后写回当前镜的 `refs` |
| 3 | 播放条 | 播放 / 暂停 / 帧号 / 跳转输入 | 与时间轴播放头联动 |
| 4 | 时间轴 | canvas 自绘：段边界、播放头、刻度 | **拖动分割点改 shots[].seconds**；双击加分割点 |
| 5 | 摘要条 | 段数 / 每段净增 / 总帧 / 时长 | 数字全部从 shots 推算，删掉硬编码 720 s |
| 6 | 输出条 | 交付尺寸 / 一采画布 / 放大 / unsharp / 实测墙钟 | 前四项**可编辑**，写回 out_w/out_h/gen/upscale |
| 7 | 镜头卡 | 左：图 9 槽 + 视频 3 槽 + 音频 3 槽；右：提示词 textarea | 上一组 / 下一组切换；槽位可拖入文件、可点 × 删除 |
| 8 | 预设条 | 四个 preset 按钮 | 点一下写回 §4.3 的整套参数 |
| 9 | 运行状态 | 两条进度条（总段 / 当前段）+ 阶段文字 | 由 `dsd_progress` 消息驱动，不伪造 |

配色沿用现有克制风格（`#2e2e2e` 底 / `#555` 描边 / `#29d3c9` 段边界 / `#ffb020` 播放头），**不改成 AIMixer 的亮色工具条**：用户要的是能力对齐，不是像素复刻。

---

## 7. 进度协议

后端（`nodes.py`，在 `run_plan` 的 log 回调里解析 + 直接在 executor 里插入 hook）：

```python
PromptServer.instance.send_sync("dsd_progress", {
    "node": str(unique_id),      # 必须，前端按它匹配节点
    "phase": "sample|decode|pass2|unsharp|resize|done",
    "seg": i, "segs": n, "pct": 0-100,
    "note": "…"
})
```

前端：

```js
window.api.addEventListener("dsd_progress", (e) => {
  const d = e.detail;
  if (String(d.node) !== String(node.id)) return;
  setBar(d.pct, d.note);
});
```

进度源：`executor.run_plan` 的 `log=` 回调已经在每段开始打 `"[DSD] ... 段 k/n ..."`；只需在 `executor.py` 里加一个可选的 `progress=` kwarg，在段首/段尾/解码前后各打一次，**不改采样逻辑**。

---

## 8. 迁移与兼容

| 项 | 处理 |
| widget 顺序 | 本版一次排定（§4），加 `schema_version` 隐含在 `timeline_data.v`；之后**只许追加** |
| 旧工作流 | 载入后 widget 数量不符 → 面板在 `onConfigure` 里检测到 `timeline_data` 缺失就补默认；不静默错位 |
| 旧 plan 文件 | `plan_path` 非空仍可跑（模板模式）|
| 两份 workflow JSON | 重新生成（`src/_mk_bestwf.py`）|
| `DSDDirectorRefine` 等其它 4 个节点 | 本轮不动 |

---

## 9. 实现计划（四阶段，每阶段可独立验收）

| 阶段 | 内容 | 验收 | 估时 |
| A 后端 | `_assemble_plan` + 参考素材三路 + `progress` kwarg + `send_sync` + widget 重排 | `python -c` 单测：给定 timeline_data 能组出可 validate 的 plan；`/object_info` 的 39 项与设计表逐位一致 | 1 天 |
| B 前端骨架 | 预览台 / 播放器 / 时间轴拖拽 / 镜头卡槽位 / 预设条 | DevTools 断言：`videoCount:1`、按钮 ≥ 12、槽位可写、拖分割点后 `timeline_data` 变了 | 1 天 |
| C 运行闭环 | 运行全部真提交 + 两条进度条 + 错误回显 | 点「运行全部」→ `/queue` 出现任务 → 进度条从 0 走到 100 | 0.5 天 |
| D 验收 | quick 臂 124 帧真跑 + 交付对比 | 产出 mp4；与 `out/c/c1_sharp-2560.mp4` 走同一评测（NCC / b6-12 / B）| 0.5 天 |

---

## 10. 明确不做（避免范围失控）

1. **不做五种任务类型**（t2v / i2v / fl2v / r2v / v2v）——只做 ref2va 一条链，它们各自需要的条件分支是另一个量级。
2. **不做导演包 zip**（`*.mmxpack.zip`）——改成单文件 JSON 模板（导入/导出）。
3. **不做分段 LoRA**（它是 AIMixer 里 46845 B 的独立模块）。
4. **不做脸修 / SelfLift / 语义桥**——我们连包都没实现。
5. **不做负面提示词输入框**（AIMixer 的 `nodes/conditioning.py:175` 硬 `return positive, [], latent, hint`，UI 是死参数；我们不摆假控件）。
6. **不提供 `context_frames=56`**，除非先在 124/362 窗口上验过 seam 质量（`plan.py` 的 `CONTEXT_FRAME_STEPS` 目前只有 5/22/39）。

---

## 11. 文档关系

| 文档 | 关系 |
| docs/77 | 本版实现的**上一版规格**（28 个 optional 追加 + 覆盖层）。本版 §4 取代它的 widget 表 |
| docs/78 | 面板 46 项缺口清单。本版 §6 九段 + §9 阶段 B/C 就是它们的落地表 |
| docs/79 | 面板不显示的排障结论（硬刷新即可）。本版 §8 「旧工作流」承接它 |
| docs/74 | 权重与 seed 结论。§4.3 预设里的墙钟数字来自这里 |
| docs/72 | 2x 解码超采样与 unsharp 0.8 的依据。§4.3 「本机最优 2x」就是它的配置 |
