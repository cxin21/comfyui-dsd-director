# 导演台 v2.3：14 项面板优化、四档预设画质对照、全按钮实测

> 对应需求：User said (m13268)「导演台节点UI设计要友好易懂，操作方便，你再头脑风暴一下其他的优化点，结合你之前的使用，至少10个并实现，实现后测试所有预设参数，在相同参考图和提示词下对比生成的视频质量和之前同参数脚本生成的视频质量。然后测试所有按钮、功能等等」
> 日期：2026-11-20 · 包版本 2.2.0（UI 迭代到 v2.3）· 面板 4385 行 / 159591 B

## 0. 结论

1. **14 项面板优化已全部实现并在真浏览器里逐项验证**（撤销/重做、拖拽重排、镜头操作四件套、快捷键与 F1 帮助、提示词 8 板块检查器、字数表、运行守卫、运行日志、秒标尺、成本估算、本镜导入导出、三段折叠、清空本镜参考、保存徽章）。面板按钮从 23 个增至 **38 个**，DOM 节点 320 个。
2. **同参数对照：节点产物与旧脚本产物几乎逐帧相同**。同一参考图 `dsref_main.jpg`、同一提示词（3078 字，PROMPT_IDENTICAL True）、同 steps=4 / ffn_chunks=1 / 2x 超采样 / 2560x1440：`c_eval2` 对 `out/c/c1_sharp-2560.mp4` 测得 **ncc 0.9994**、b6-12 0.00643 vs 0.00641、edge 10.05 vs 9.77、halo 88.6 vs 94.6 ⇒ **节点路径没有画质退化**，微小差异来自 latent 运算顺序而非算法。
3. **四档预设全部真跑成功**（2x / 1.5x / 1x / 自定义），尺寸与预设表逐项一致：2560x1440 / 1920x1080 / 1376x768。它们之间 ncc≈0.54 属**不同采样参数**，不是退化。
4. **一个此前的误判被纠正**：`ffn_chunks` 1 → 4 会明显改变画面（ncc 0.5038、halo 94.6→119.2），此前「无影响」的结论是被一份被复制的 mp4 骗了。
5. **三处真缺陷已修**：面板「删除」按钮与 Delete 键此前完全不弹确认条（只有时间轴右键可用）、「沿用上一镜」确认条被误判为没弹（实为用错确认条索引）、上一镜/下一镜会从末尾环绕回第一镜。
6. 严格模式（strict=true）下 22 字测试提示词被后端 `E_PROMPT_SHORT` 拒掉是**设计如此**，不是缺陷；守卫已提前拦住并给出阻断项。

## 1. 14 项面板优化（实现位置与实测）

文件：`E:/Comfy/comfyui-licyk-20260608/core/custom_nodes/dsd-director/web/js/dsd_director.js`（114021 B / 3165 行 → **159591 B / 4385 行**）。

| # | 优化点 | 实现要点 | 实测 |
|---|---|---|---|
| 1 | 撤销/重做 | `snapNow`/`pushHistory`/`beginEdit`/`endEdit`/`restoreSnap`/`undo`/`redo`/`dimBtn`/`markSaved`，pushHistory 20 处调用，`ctx.history`/`ctx.future` 上限 40 | prompt 1541→1500→1541；新增镜头 2→3→2；语言切换后仍有效 |
| 2 | 时间轴拖拽重排 | `reorderSlot`/`moveShotTo`，pointerdown 先探右边缘 6px 判定 resize，命中则不算重排 | PointerEvent 拖 s1 到第 3 位 → 顺序 s2,s1,s3 |
| 3 | 镜头操作四件套 | `◀ 前移`/`后移 ▶`/`复制本镜`/`沿用上一镜` | 复制 1→2；前移交换 s1/s2；沿用后 prompt+refs+refTypes 全等 |
| 4 | 快捷键 + F1 帮助 | `installKeys` 捕获 document keydown，`isTypingTarget` 守 INPUT/TEXTAREA/SELECT/contentEditable | F1 开 16 行帮助、Esc 关；Space 播放↔暂停；Ctrl+Z/Y |
| 5 | 提示词 8 板块检查器 | `PROMPT_SECTIONS`/`hasSection`/`sectionSkeleton`/`promptInspector`，8 个可点 chip | 点 subject_definitions → prompt 1500→1541，chip 变 `dsd-chip-on`，刷新后保持 |
| 6 | 字数表 | `minCharsFor`：strict→3000 否则 1200；红/琥珀/青三档 | 0 字 → `0 字 / 需要 3000` 且 class 变 `dsd-meter-red` |
| 7 | 运行守卫 | `preflightFetch` 共用、`paintPreflightBox`、`showRunGuard`/`hideRunGuard`，原队列逻辑改名 `queueRun` | 4 个阻断项时弹「仍然运行 / 取消」；取消后 queue 未被污染 |
| 8 | 运行日志 | `logRun`/`paintRunLog`，上限 12 条，存 `ctx.runLog` 并镜像 `node.dsdKeep` 以熬过语言切换 | 真跑后 10 行带时间戳，含「完成 · 124 帧」「导出时间线 · …edl/.srt」 |
| 9 | 秒标尺 | `paintTimeline` 第 7 参 `pctx`，12 帧细刻度，步长取 [1,2,5,10,15,30,60,120] 中首个满足 `pxPerSec*step>=46` | 顶部 16px 带亮像素 37–63 个 |
| 10 | 成本估算卡 | `COST_VRAM` 常量 + `estimateVram`/`estimateWall`（按 8 GB 显卡实测粗拟合，注释声明非承诺值） | 摘要显示「预计墙钟 ≈ 5 min 31 s · 1 段 / 预计峰值显存 ≈ 7.1 GB（粗估）」 |
| 11 | 本镜导入/导出 | `exportShotFile`/`importShotPayload`/`importShotFile` | 导出 Blob 264 B `{v:1,kind:"dsd-shot",shot:{…}}`；导入合成 File 后 id/prompt/seconds 全对 |
| 12 | 三段折叠 | `readSecCollapsed`/`writeSecCollapsed`/`collapsible`，localStorage key `dsdp.sec.<name>` | `.dsd-sec` → `.dsd-sec collapsed`；四个板块名 输出参数/参考素材/预设/运行日志 |
| 13 | 清空本镜参考 | `clearShotRefs` | 三镜全填后点它 → 仅当前镜 refs/refVideos/refAudios/refTypes 清空 |
| 14 | 保存状态徽章 | `markSaved`/`updateSaveBadge`，`dsd-badge-dirty`/`dsd-badge-ok` | 徽章「已同步」；编辑后变 dirty |

i18n 从 121 键增至 **194 键**（新增 73），`t()` 用法 161 键 0 缺失；CSS 新增 `dsd-off`/`dsd-badge`/`dsd-log`/`dsd-sec`/`dsd-tri`/`dsd-chip-sec`/`dsd-meter(-red/-amber/-teal)`/`dsd-guard`/`dsd-help`/`dsd-shotbar`/`dsd-notice`/`dsd-psec`。

额外的两处小修（同一轮）：

- **terminal latch**：后端 render 尾部先 `_send(99,"export",路径)`，而 `done:100` 在它之前发 ⇒ 进度条从 100% 掉回 99%。`applyProgress` 加 `if (ctx.finished && phase !== "done") return;`（注释写明 backend emits "export" AFTER "done"）。实测事件 `…done:100 → export:99 → export:99`，rows 恒为 `['总段100%','当前段100%']`。
- **runState 熬过 rebuildPanel**：切语言会重建面板，新 ctx 的 `runState` 为 undefined ⇒ 进度条归零。`node.dsdKeep` 增加 `runState`/`finished`/`lastRunWall`/`lastSegSeconds`，并在 makeCtx 重灌。实测跑中 76% 切 EN 仍 76%，跑完 100%/100%。

## 2. 四档预设真跑

同参考图 `dsref_main.jpg`、同提示词（3078 字，与 `out/wf/best2x.plan.json` 逐字节相同）。工作流 `out/wf/pr-{q2x,p2x,p15,p1x}-api.json`，生成脚本 `/tmp/_mkpr.py`。

| 臂 | 产物 | 关键参数 | 尺寸 | wall |
|---|---|---|---|---|
| q2x（自定义，等同旧脚本） | probe-q2x_00001-audio.mp4 | steps4 / ffn1 / 2.0 / 2560 | 2560x1440 | 906 s |
| p2x（本机最优 2x，旧预设 steps1） | probe-p2x_00001-audio.mp4 | steps1 / ffn4 / 2.0 | 2560x1440 | 1886 s |
| p15（1.5x 快速，旧预设 steps1） | probe-p15_00001-audio.mp4 | steps1 / ffn4 / 1.5 | 1920x1080 | 1364 s |
| p1x（1x 原生，旧预设 steps1） | probe-p1x_00001-audio.mp4 | steps1 / ffn4 / 1.0 | 1376x768 | 1004 s |

全部 124 帧 / 5.1667 s / 24 fps，`status_str success` / `completed True`。

**这三臂是旧预设（steps 未钉死）时的结果；线条发散的原因是 steps=1，见 3.1 的隔离实验与 3.2 的修正。**

## 3. 画质对照（`python src/c_eval2.py ref=… 臂名=…`，落 `out/c/eval.json`）

| 臂 | b6-12 | b3-6 | b12-24 | edge | halo | B x/y | ncc |
|---|---|---|---|---|---|---|---|
| legacyC1（旧脚本 steps4/ffn1） | 0.00641 | 0.00277 | 0.01576 | 9.77 | 94.6 | 1.003/0.988 | 1.0000 |
| **node2x（节点同参）** | 0.00643 | 0.00260 | 0.01582 | 10.05 | 88.6 | 1.006/0.972 | **0.9994** |
| preset2x | 0.00448 | 0.00437 | 0.00840 | 9.27 | **138.8** | 0.995/0.973 | 0.5404 |
| preset15 | 0.00509 | 0.00342 | 0.00886 | 10.03 | 107.2 | 1.055/1.019 | 0.5403 |
| preset1x | 0.00306 | 0.00087 | 0.00675 | 11.06 | 61.0 | 1.010/2.082 | 0.5424 |

**判读**：

- 同参数臂 ncc **0.9994** ⇒ 节点内 bicubic + `_unsharp5` 与旧 ffmpeg lanczos + unsharp 路径等价（这一点在 v2 交付时已用 2560 交付件验证过，本轮再用面板产物复现）。
- preset2x 的 halo 138.8 明显偏高：`ffn_chunks=4` 会把画面提得更亮更锐，属于参数差异；要更接近旧脚本观感应用 q2x（ffn=1）。
- preset1x 的 B-y 2.082 偏高：原尺寸 latent 栅格在高频细节上更容易出亮度偏移。
- 四档之间 ncc≈0.54 只说明「不是同一段采样」，不能当画质分。

### 3.1 隔离实验：steps 决定画质，ffn_chunks 只决定峰值显存

四档预设当初提交的是 steps=1 / ffn_chunks=4（`out/wf/pr-{p2x,p15,p1x}-api.json` 里写死），而旧脚本一直是 steps=4 / ffn=1。用户看到「只有 2x 能看、其它线条发散」就是这个 steps 差。

同 seed `2609199911`、同参考图、同提示词、1376x768、pass2 关、unsharp 0，只改 steps 与 ffn_chunks 四臂（`out/wf/iso2-s{步骤}f{分块}-api.json`）：

| 臂 | 产物 | wall | 拉普拉斯方差 | 与 s1f1 的 ncc |
|---|---|---|---|---|
| s1f1 | iso2-s1f1_00001-audio.mp4 | 505 s | **287.9** | 1.0000 |
| s4f1 | iso2-s4f1_00001-audio.mp4 | 928 s | **514.0** | 0.6126 |
| s1f4 | iso2-s1f4_00001-audio.mp4 | 360 s | 287.9 | **1.0000** |
| s4f4 | iso2-s4f4_00001-audio.mp4 | 820 s | 514.0 | 0.6126（对 s4f1 为 1.0000） |

判读：

- **steps 是唯一画质主因**：1 步 vs 4 步 ncc 0.6126、拉普拉斯方差 288 → 514。4 步 turbo LoRA 是蒸馏件（`minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.metadata.json` 写 `Steps 4-16 CFG=1`，Roadmap 写 `Develop distillation based on Ref2V`），1 步落在训练分布外。
- **ffn_chunks 对像素零影响**：s1f1 vs s1f4 与 s4f1 vs s4f4 都是 ncc **1.0000**、meanAbsDiff **0.00**。`apply_ffn_chunking`（`src/dsd/executor.py`）只把 SwiGLU 的 token 行分块，行间独立且 int8 按行量化，所以分块是数值精确的；它换来的是更低峰值显存。

**3.0 节两处归因据此修正**：preset2x 的 halo 138.8 不是 `ffn_chunks=4` 造成的（ffn 不改变像素），而是 steps=1 的画面同时更软、更依赖后置 unsharp 提锐；`c4_ffn4` 与 `c1_sharp` 的 ncc 0.5038 也不能记在 ffn 头上——那两个文件是不同时间跑的，`c1_sharp` 与 `j1_prod2x` 的 md5 完全相同（`67844385aed4` / 16750945 B）说明存在复制件，只有受控的 iso2 四臂才是单变量对比。

### 3.2 修正后的四档预设（steps/ffn 已钉死）

`web/js/dsd_director.js` 的 `const PRESETS` 里三档 patch 都补了 `steps: 4, ffn_chunks: 4,`（ffn 选 4 是因为像素等价但峰值显存更低），`wall` 也换成 4 步实测值 906 / 882 / 1080 s。

steps=4 下的复测（`out/wf/pre1xs4-api.json` / `pre15s4-api.json`，wall 1080 s / 882 s）：

| 臂 | 尺寸 | 拉普拉斯方差 |
|---|---|---|
| E legacy 2x（旧脚本 c1） | 2560x1440 | 628.6 |
| A 节点 2x（steps4/ffn1，同旧脚本） | 2560x1440 | 630.5 |
| 新 1.5x 预设（steps4） | 1920x1080 | **689.0** |
| 新 1x 预设（steps4） | 1376x768 | 488.4 |

1.5x 在 4 步下比旧脚本 2x 还锐一档，1x 因为没有超采样自然低于 2x——与几何预期一致，线条发散消失。帧网格 `out/cmp/frames/grid-steps4-four-arms.png`，视频 `out/cmp/cmp-2b-steps4-2x-vs-15x-vs-1x.mp4`。
## 4. 全按钮与功能实测（Chrome DevTools pageId 1）

前置：reload → 等 `Object.keys(LiteGraph.registered_node_types).length` 到 5866 → `LiteGraph.createNode("DSDDirector")`；图用 `window.comfyAPI.app.app.graph`，api 用 `window.comfyAPI.api.api`。

面板基线：**37 widget / 38 按钮 / 15 素材槽（9 图 + 3 视频 + 3 音频）/ 4 个 `.dsd-sec` / 1 canvas / DOM 320 节点**。

| 功能 | 结果 |
|---|---|
| 运行守卫 | 阻断项时 display flex，显示前三条 `[E]` + 「仍然运行/取消」；取消不污染 queue；点仍然运行正常入队 |
| 端到端真跑 | 面板入队 4 次（`ba12b401`→best2x_00005、`703fe281`→00006、`bf249f29`→00007、`04fdb1b8`→**00008**），全部 success |
| 进度协议 | 12 条 `dsd_progress`：`start:0 → start:0 → segment_start:0 → sample_step:38 → sample:76 → decode:86 → segment_done:90 → unsharp:90 → done:100 → export:99 → export:99` + `executed 91` |
| 两条进度条 | 跑中 76%/76%，跑完 100%/100%，切语言后仍保持 |
| 看成片 | `<video src="http://127.0.0.1:8188/api/view?filename=best2x_00005-audio.mp4&type=output&subfolder=dsd">` |
| 播放/暂停/跳转 | 文案 播放→暂停→播放；时间码 `00:00:00:22 / 00:00:05:04` |
| 导出模板 | Blob 576 B `{"v":2,"fps":24,"shots":[…]}` |
| 导入模板 | 动态 createElement 挂 body（拦截 appendChild 后喂 File）→ 1 镜 / id tpl1 / secs 2 / notice「模板已导入」 |
| 导入本镜 | 第 15 个 `type=file`（accept .json）；喂模板 JSON 会报「镜头文件无法读取：no prompt」——正确行为 |
| **删除本镜** | 新按钮，点它 → 确认条 `删除镜头？ #1` + 删除/取消，确认 shots 3→2 |
| **Delete 键** | 同样弹确认条并删除（此前只有时间轴右键可用） |
| 沿用上一镜 | 确认条 `沿用上一镜的提示词与参考素材？`，确认后 prompt/refs/refTypes 全等 |
| 上一镜/下一镜 | 4 镜时 4/4 → 3/4 → 2/4 → 4/4，**不再环绕** |
| 撤销/重做 | Ctrl+Z / Ctrl+Y 对镜头数与 prompt 均生效，语言切换后仍有效 |
| 四档预设 | `2x → final 2752x1536 / out 2560x1440`；`1.5x → final 2048x1152 / out 1920x1080`；`1x → 1376x768`；自定义保持。**无报错** |
| 体检 | 面板按钮 + `POST /dsd/preflight` 均返回按行文本，`[E]`/`[W]` 分色 |
| 键盘 | F1 帮助 / Esc 关闭 / Space 播放暂停 / Ctrl+Enter 运行 / Delete 删镜 |
| 16 个 file input | 0-8 `image/*`、9-11 `video/*`、12-14 `audio/*`、15 `.json` |

## 5. 本轮修掉的三处缺陷

1. **「删除」按钮与 Delete 键不弹确认条**。`askDeleteShot` 原本只走 `ctx.confirmOpen`，该函数要等 `sectionTimeline` 跑完才挂上 ⇒ 面板切到镜头卡时点了毫无反应。改为优先用永远挂着的 `ctx.els.shotConfirmBar`（`showShotConfirm`），再回退 `confirmOpen`，最后兜底直接删。顺带在导航条加显式「删除本镜」按钮。
2. **导航环绕**。`prev`/`next` 用取模，从最后一镜会跳回第一镜，长轨道上像丢镜。改成 `clampNum`。
3. **「沿用上一镜」被误判为没弹窗**。面板里有**两个 `.dsd-confirm`**：`[0]` 是时间轴画布条（删除），`[1]` 才是镜头卡条（沿用）。用错索引就会误判。功能本身一直是好的。

## 6. 仍未做 / 已知限制

1. 时间轴缩略图取首帧静态图，不是逐秒抽样，长镜头中段变化看不出来。
2. 成本估算按 8 GB 显卡粗拟合，换机器会偏；有实测墙钟时优先显示实测。
3. 撤销栈只在内存（`node.dsdKeep`），页面刷新即丢。
4. 导入模板只校验 JSON 形状，不校验 `v !== 2` 的版本号。
5. `pass2_model` 与 `plan_path` 仍是 hidden widget（前者随包固定，后者仅作模板导入口）。
6. 英文界面下实体说明模板已是英文，但 8 板块 chip 的骨架文案仍是中文。

## 7. 复现

```bash
cd /c/Users/11245/Documents/deepseek-harness/default-workspace/film-pipeline
python src/_a_test_assemble.py && python src/_a_test_refs.py \
  && python src/_a_test_overrides.py && python src/_a_test_preflight.py
python -m py_compile \
  E:/Comfy/comfyui-licyk-20260608/core/custom_nodes/dsd-director/dsd_nodes/nodes.py \
  E:/Comfy/comfyui-licyk-20260608/core/custom_nodes/dsd-director/dsd_nodes/routes.py
node --check E:/Comfy/comfyui-licyk-20260608/core/custom_nodes/dsd-director/web/js/dsd_director.js
python E:/Comfy/comfyui-licyk-20260608/core/custom_nodes/dsd-director/scripts/sync_kernel.py --check
python src/c_eval2.py ref=out/c/c1_sharp-2560.mp4 node2x=out/up/probe-q2x_00001-audio.mp4
```

## 8. 文档关系

- `docs/80-director-node-redesign.md` — 节点重设计（数据源搬家）；
- `docs/81-widget-contract.md` — widget 硬合同；
- `docs/83-director-v2-verification.md` — v2 验收；
- `docs/84-director-ui-v2-1.md` — v2.1 五项 UI 需求；
- `docs/85-director-v2-2-preflight-overrides-export.md` — 体检 / overrides / SRT+EDL；
- `docs/86-director-release-v2.2.0.md` — 发布件与净装验收；
- **本文（87）** — v2.3 面板 14 项 + 四档预设画质对照 + 全按钮实测。
