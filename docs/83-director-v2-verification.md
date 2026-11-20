# 83 导演台 v2：内联时间轴、参考素材三路、真进度与面板重做

日期 2026-11-20。承接 docs/80（重新设计）、docs/81（widget 硬合同）、docs/82（阶段 A 报告）。
本文只记录**已经实跑验证**的事实，未验证的一律标注。

## 0 结论

1. **plan 文件已从运行链路里彻底移除**。`plan_path` 只是可选的模板导入口；运行所需的镜头表来自节点内 hidden widget `timeline_data`（JSON 字符串），由 `_assemble_plan()` 在内存里组装成 plan dict，**写盘 0 次**。
2. 参考素材接通三路：图 ≤9 / 视频 ≤3 / 音频 ≤3，全部从 ComfyUI `input/` 目录按文件名加载，槽位在面板里可点选上传（`POST /upload/image`），不用再改 JSON。
3. 一采与解码超采样参数全部 UI 可配（6 个 BDGROUP 分组），并预置四档预设；默认档 = 本机最优 2x（1376x768 → 2.0 → 2752x1536 → 2560x1440 / unsharp 0.8）。
4. 进度条从「永远 0%」变成**每步真实推进**：后端在采样循环里按步发 `dsd_progress`，实测 2 步臂发出 9 条事件，面板两条进度条同步走到 100% 并停在「完成」。
5. 三条端到端真跑全部 `status_str == success`：quick v2（455 s）、best v2（1250 s，2560x1440）、面板点击臂（154 / 140 s，704x384）。
6. 节点内 bicubic+unsharp 交付与旧 ffmpeg lanczos+unsharp 路径 **NCC 0.9994**，两条路径等价。

## 1 数据源搬家：从磁盘 plan 到节点内 timeline_data

### 1.1 改之前为什么是错的

`nodes.py` 旧 `render()` 的第一件事是读文件：`path = plan_path if os.path.isabs(plan_path) else os.path.join(base, plan_path)`，`raw = json.load(open(path))`。之后的 28 个 widget 全部只是对这个 dict 的覆盖层，后果有三：

- `inline_prompt` 只能写 `shots[0]["prompt"]` —— 多镜头时无处安放；
- 镜头的 `seconds` / `refs` 没有任何 widget 能改，只能编辑文件；
- 文件被删/改名，节点直接崩，工作流不可分享。

### 1.2 现在的结构

`timeline_data` 是 hidden 的 STRING widget（JSON 字符串），结构：

```json
{"v": 2, "fps": 24, "shots": [{"id": "s1", "seconds": 5.1667, "prompt": "...", 
  "refs": ["dsref_main.jpg"], "refVideos": [], "refAudios": [], "motionExpect": 1.0}]}
```

运行链路：`_default_timeline()`（空则用默认 1 镜）→ `_assemble_plan(timeline_data, gen_w, gen_h, window_frames, context_frames, ffn_chunks, pass2, upscale, final, pass2_steps, pass2_sigma, steps, solver, shift_video, shift_audio, handoff, strict, tile_size, total_frames, template_raw)` → `executor.run_plan(...)`。

`plan_path` 非空时只作为**模板**读入（`plan_source = "template:%s"`），widget 仍然覆盖模板里的 canvas / render / shots 三块。

### 1.3 self-test（`src/_a_test_assemble.py`，全 PASS）

| 用例 | 输入 | 断言 |
|---|---|---|
| case1 | 1 镜 124 帧 | 段数 = 1 |
| case2 | 2 镜各 124 帧 | 段数 = 3（124 + 119 + 5），visible=[124,124]，capacity=119 |
| case3 | refs + refVideos + refAudios | 1 段且三路透传，motionExpect→motion_expect，seed 透传 |
| case4 | 空 shots | 回退默认 1 镜 |
| case5 | prompt 40 字 | strict=True 报 `E_PROMPT_SHORT: prompt too short: shots[0].id=s1 len=40/3000`；strict=False 放行 |
| case6 | 给模板 | 模板的 shots 与 canvas 都被 widget 覆盖 |

## 2 参考素材三路

| 类型 | 上限 | 加载方式 | 尺寸处理 |
|---|---|---|---|
| 图 `ref_image_` | 9 | `Image.open(input/name).convert("RGB")` → /255 | 原样（`ref_image_size=match`）|
| 视频 `ref_video_` | 3 | `cv2.VideoCapture` → 24fps 重采样 | 短边 ≤704 只缩不放，偶数化，T ≤ 360 |
| 音频 `ref_audio_` | 3 | `comfy_extras.nodes_audio.load` | 32 kHz 单声道由下游处理 |

`executor.attach_references()` 接受 dict（三路）或 list（旧调用向后兼容）；`_condition()` 的缓存 key 扩到三路，避免只改视频时命中旧缓存。

面板侧：15 个 `.dsd-ref-slot`，点「上传」走 `POST /upload/image`（FormData: image / type=input / overwrite=false），成功后把返回文件名写回 `timeline_data` 的对应数组。

## 3 参数分层与预设

| 层 | 内容 | 可改性 |
|---|---|---|
| 内置常量 | 17k+5 栅格、32px stride、24fps、40Hz 音频时钟、vae_tile 恒 0、partial_start 恒 0、seam_min 0.1、decode_shifts 恒空 | 不可改，只在 `builtin_note` 里列出 |
| 参数（6 组）| `bd_grp_shot` 镜头 / `bd_grp_s2` 采样 / `bd_grp_geo` 几何与窗口 / `bd_grp_decode` 解码超采样 / `bd_grp_deliver` 性能与交付 / `bd_grp_tpl` 模板与内置常量 | UI 可改，写回 widget |
| 外部 | 镜头表（`timeline_data`）、参考素材（input 目录文件）、`plan_path` 模板 | 面板里操作 |

预设四档（面板底部按钮，点一下写回整套参数，不触发渲染）：

| 预设 | 一采画布 | 放大 | 交付 | unsharp | 每段墙钟 |
|---|---|---|---|---|---|
| 本机最优 2x | 1376x768 | 2.0 | 2560x1440 | 0.8 | ~720 s |
| 1.5x 快速 | 1376x768 | 1.5 | 2560x1440 | 0.8 | ~621 s（按 docs/72 §4 比例推算，未单跑）|
| 1x 原生 | 1376x768 | 1.0 | 2560x1440 | 0.8 | ~683 s |
| 自定义 | 手填 | 手填 | 手填 | 手填 | 未实测 |

`preset != "自定义"` 时 gen / upscale / out / unsharp 被预设接管并在 report 里记 warning —— 这是刻意的，避免「选了预设却被残留 widget 值污染」。

## 4 真进度协议

后端（`src/dsd/executor.py`）：

- `_PHASE_WEIGHT = {"segment_start": 0.0, "sample_step": 0.0, "sample": 0.85, "pass2": 0.90, ...}`（:496）；
- `_emit_progress` 的 `sample_step` 分支按步算 `frac = 0.85 * (i + 0.5) / n`（:506-516）；
- `_sample` 里 `self._cur_steps = int(len(sigmas) - 1)`（:731），并给 `comfy.sample.sample_custom(..., callback=_step_cb)`（:763）；
- `def _step_cb(_i, _denoised, _x, _total)` **必须四个位置参数** —— `KSAMPLER.sample`（`core/comfy/samplers.py:997-1003`）内部就是 `callback(x["i"], x["denoised"], x["x"], total_steps)`。写成单参数直接 `TypeError: ... takes 1 positional argument but 4 were given`。

节点侧 `render()` 把 `_progress(info)` 缩放到 0–90%，交付层再补 `unsharp` 90% 与 `resize` 95%，最后 `done` 100%。

实测事件序列（704x384 / 2 步 / probe 臂）：

```
{pct:0,  start,         note:"plan 1 镜"}
{pct:0,  start,         note:"1 segments"}
{pct:0,  segment_start, note:"shot s1"}
{pct:19, sample_step,   note:"step 1/2"}
{pct:58, sample_step,   note:"step 2/2"}
{pct:76, sample,        note:"denoise done"}
{pct:86, decode,        note:"video decoded"}
{pct:90, segment_done,  note:"168.5s"}
{pct:100, done,         note:"124 帧"}
```

前端（`web/js/dsd_director.js`）：`api.addEventListener("dsd_progress", ...)` 按 `String(detail.node) !== String(node.id)` 过滤，`applyProgress()` 更新两条进度条；`phase === "done"` 时把 `runState` 钉在满格而不是置 null（旧写法置 null，updater 见 null 就画 0%，跑完看起来像没跑）。

**注册是必需的**：ComfyUI 的 `api` 只把注册过的事件类型派发出去，未注册的当未知类型丢弃（控制台 `Unknown message type ...`）。
**缓存会让进度事件消失**：同参数重复提交命中 ComfyUI 缓存时整段 20 s 返回、0 条 `dsd_progress`。验证进度必须换 seed。

## 5 面板九段（实测）

`buildPanel` 自上而下：工具栏（运行全部 / 刷新面板 / 重算分段 / 导入模板 / 导出模板 / EN）→ 预览台（`<video>` + 参考图）→ 播放条（播放 / 帧 / 跳转 / 时间码）→ canvas 时间轴（青色段边界 + 琥珀播放头）→ 摘要（段数 / 每段净增 / 总帧 / 时长 / 窗口 / 墙钟 / 交付推导）→ 输出条（交付 704 交付高 384 一采 704 一采高 384 放大 1 锐化 0）→ 镜头卡（9 图槽 / 3 视频槽 / 3 音频槽 + 提示词 textarea 双向绑定 `shots[i].prompt`）→ 预设条（四档 + 自定义）→ 状态（两条进度条 + 一行 phase 文案）。

实测 DOM：`{videos:1, slots:15, buttons:16, inputs:22, textareas:1}`；节点 37 widget，hidden 三个（`timeline_data` / `plan_path` / `builtin_note`），六个分组头「镜头 / 采样 / 几何与窗口 / 解码超采样 / 性能与交付 / 模板与内置常量」。

i18n 70 条中英字典，切换走 `rebuildPanel`（不 reload 页面），语言存 `localStorage['dsd.panel.lang']`。

## 6 端到端真跑

| 臂 | 触发方式 | prompt id | 墙钟 | 产物 | 分辨率 |
|---|---|---|---|---|---|
| quick v2 | `src/_wf_run.py` | `69fd0d62` | 455 s | `output/dsd/quickv2_00001-audio.mp4` | 1712x960 |
| best v2 | `src/_wf_run.py` | `16f84568` | 1250 s | `output/dsd/best2x_00002-audio.mp4` | **2560x1440** |
| 面板点「运行全部」臂 1 | 面板按钮 → `appObj.queuePrompt(0)` | `7e9715f3` | 154.2 s | `output/dsd/panelprobe_00002-audio.mp4` | 704x384 |
| 面板点「运行全部」臂 2 | 同上 | `f88d1e91` | 139.7 s | `output/dsd/panelprobe_00001-audio.mp4` | 704x384 |

best v2 裁 73 帧交付 `out/wf/wfv2-best2x-2560-3s.mp4`（12948218 B / 2560x1440 / 3.041667 s）；与旧路径产物 `out/c/c1_sharp-2560.mp4` 的 **NCC 0.9994**（b6-12 都是 0.00641），确认节点内 bicubic+unsharp 与 ffmpeg lanczos+unsharp 等价。

## 7 已知限制

1. **旧 v1 工作流会炸**：v1 的 `widgets_values` 是 36 项旧顺序且缺 `control_after_generate` 槽，载入后 widget 整体错位并弹 `TypeError: Cannot read properties of undefined (reading 'setGraph')`。已把 `DSD导演台-最优一采+2x超采样.json` 与 `-api.json` 移进 `workflows/_旧版勿用/`。**v2 三件套载入正常**（实测 `srcHead [2609198601, "randomize", "自定义", true, 7.9]` == `liveHead`）。
2. 参考视频自带音轨（`ref_video_audios` 配对）未接。
3. 拖拽文件进槽位未做，只能点「上传」选文件。
4. 双击只会在轨道末尾加镜，不能在任意位置切分。
5. 摘要里「墙钟」在未测量时显示「未实测」，不会编一个数字。
6. 3 分钟正片仍未用该节点整跑；按 720 s/段 x 37 段 = 7.4 h，超过 6 h 预算，待裁决。

## 8 复现命令

```bash
# 1) 自检
python src/_a_test_assemble.py     # ALL OK 6
python src/_a_test_refs.py         # ALL OK 5
# 2) 真跑（api 形式）
python src/_wf_run.py out/wf/wfv2-quick-api.json quickv2 1500
python src/_wf_run.py out/wf/wfv2-best2x-api.json bestv2 3600
# 3) 面板真跑：浏览器里载入 workflows/DSD导演台v2-最优一采+2x超采样.json，点「运行全部」
# 4) 交付裁切
ffmpeg -i SRC -vf "trim=start_frame=0:end_frame=73,setpts=PTS-STARTPTS,format=yuv420p" \
  -af "atrim=0:3.0417,asetpts=PTS-STARTPTS" -c:v libx264 -crf 14 -preset slow \
  -c:a aac -b:a 192k -movflags +faststart -shortest out.mp4
```

## 9 文档关系

- docs/80 是为什么改（诊断 + 五条原则）；docs/81 是 widget 硬合同；docs/82 是阶段 A 的代码清单。
- 本文是**验收**：把上面三份的设计落到「跑通了什么、数字是多少、还剩什么不能做」。
- docs/74 是权重与画质的实测基线，本文不重复；本节点默认档就是 docs/74 §11.4 的那套。
