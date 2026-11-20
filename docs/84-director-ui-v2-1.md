# 84 · 导演台 UI v2.1：预设几何、实体类型提示词、当前镜时长、多镜真跑

日期：2026-11-20 · 节点：DSDDirector（`E:/Comfy/comfyui-licyk-20260608/core/custom_nodes/dsd-director`）

## 0 结论

1. **1.5x 预设的 `final_w 2080 ≠ 2064` 报错是三层原因叠加**：前端用未对齐的 `round(gen*up)` 参与比较、切换预设时 `final_w/final_h` 残留上一档、`out_h` 的 INT step 是 32 导致 1080 被吸附成 1088。三层都已修，实测点完 2x 再点 1.5x 得到 `final 2080x1152 / out 1920x1080`，无告警。
2. **参考图类型（角色/背景/道具/风格/其他）落成镜头级字段 `refTypes`**，选完即在提示词框头部生成 `<Subject N> 是 <Picture K> 参考图中的…` 实体说明块，可一键重写，幂等（重写不会叠加）。
3. **当前镜的帧数/时长/时间码进入摘要条**，并可原地改帧数（写回 `shot.seconds`）。总时长与总帧数仍在同一行。
4. **多镜头真跑通过**：两镜 362 帧在节点内被切成 3 段（124 + 119 + 119），`wall 460 s`，产物 704x384 / 362 帧 / 15.08 s ⇒ timeline_data 多镜 → 多段 handoff 链路端到端成立，且全程没有 plan 文件。
5. 拖拽上传、增删镜、重算分段、真进度条都在浏览器里实测过；面板新增控件没有引入新的 widget（仍是 required 8 + optional 31 = 39，节点 37 个 widget）。

## 1 用户五项需求 → 落地位置

| 需求 | 落地 | 实测 |
| --- | --- | --- |
| UI 友好易懂、操作方便 | 工具栏常驻 6 个动作 + 拖拽上传 + 类型 chips + 当前镜编辑框 | 按钮 18 个，`.dsd-ref-slot` 15 个 |
| 自己添加分段 | 工具栏「新增镜头」按钮（也支持双击轨道末尾、右键轨道切分） | 点一次：shots 2 → 3，total_frames 220 → 344，摘要同步 |
| 参考图选类型 + 自动实体模板 | `ENTITY_KINDS` + `entityLines()` + 「重写实体说明」 | 选 角色 + 背景 → 提示词头部出现两行 `<Subject 1>` / `<Subject 2>` |
| 当前段的时长与帧数 | 摘要条第二行 `.dsd-sum-cur` | 「当前镜 1/3 · 本镜帧 124 · 本镜时长 5.17 s · 时间码 00:00:05:04」 |
| 1.5x 预设报错 | 见 §2 | 2x → 1.5x 无报错 |

## 2 1.5x 预设报错：三层原因与修法

### 2.1 前端算的是未对齐的推算值
`sectionOutput` 原来写 `calcW = Math.round(genW * up)`，1376 × 1.5 = 2064；后端 `_align32` 给的是 2080。容差只允许 1，于是必然报警。
修法：新增 `align32(v) = Math.max(32, Math.round(v / 32) * 32)`（js:409），注释写明「mirrors the backend _align32 so the panel never warns about a final size the node would actually accept」；`calcW/calcH` 改用 `align32(genW * up)`，并把容差从 1 放宽到 2。

### 2.2 final_w 会从上一档预设残留
`applyPreset` 只写 `preset.patch` 里的键。点过 2x（final 2752x1536）再点 1.5x，若 patch 没覆盖到（或用户先手改了 gen），final 仍是上一档。
修法：`applyPreset` 写完 patch 后**按 align32 重算写回** `final_w/final_h`，注释「Derived, never inherited: a stale final_w from the previous preset used to surface as "final_w 2080 != 2064" the moment 1.5x was clicked after 2x.」；后端也加同义校正（`|final - auto| > 32` 时改用推算值并记 warning）。

### 2.3 out_h 被 widget 的 step=32 吸附
`("out_h", {"default": 1440, "min": 0, "max": 8192, "step": 32})` ⇒ 预设写的 1080 被吸附成 1088。
修法：`out_w/out_h` 的 step 从 32 改成 **1**（交付尺寸不需要 32 对齐，最终缩放在 `_unsharp5` 之后用 bicubic 自由缩）。实测 object_info 已是 `step: 1`，前端点完 1.5x 读到 `out_h = 1080`。


### 2.4 预设从「接管」改成「填表」（实测）

原来后端 `if preset_name in _PRESETS:` 会**无条件覆盖** gen/upscale/out/unsharp，widget 值被静默丢弃。这在「点预设」的路径上看起来没问题（面板刚把同样的值写进 widget），但在两条路径上会咬人：

1. 手工改完参数却没把 preset 切回「自定义」——改动被吞。
2. API/工作流里写死了小尺寸做探针，preset 名字还是「本机最优 2x」——直接按 2560x1440 跑满。

改成填表语义后：命中预设时只比对、不覆盖；一致则 `applied = preset:<name>`，不一致则 `applied = preset:<name>(overridden)` 并给 warning「preset=X 只是推荐值；当前 gen/upscale/out/unsharp 已被手动改成 …，按手动值执行」。

实测（`out/wf/presetfill-api.json`，preset 名保留「本机最优 2x」但几何写成 704x384 / upscale 1.0 / out 704x384）：

```
DONE success completed True wall 180
presetfill_00001-audio.mp4  704x384  124 帧  5.1667 s
[DSD] dsd: 1 段 124 帧 5.2s 用时 2.8min handoff=latent_prefix steps=2 pass=1
```

⇒ 输出仍是 704x384，没有被覆盖成 2560x1440 ⇒ 填表语义生效。

## 3 实体类型与提示词模板

### 3.1 类型词表（按 MiniMax 提示词技能的实体说明写法）

```
character 角色 · background 背景 · prop 道具 · style 风格 · other 其他
```

### 3.2 生成的句子

| 类型 | 生成文本（`<Picture K>` 的 K 是槽位序号） |
| --- | --- |
| 角色 | `<Subject N> 是 <Picture K> 参考图中的主要角色，提供身份、发型、面部特征与服装配色；必须以参考图组为唯一身份基准，全程不得改变五官、发型与主色。` |
| 背景 | `<Subject N> 是 <Picture K> 参考图中的场景环境，提供空间结构、材质、光源方向与色调；镜头运动不得破坏该空间的透视与光照逻辑。` |
| 道具 / 风格 / 其他 | 同构模板，分别强调「外观与材质」「画风与配色」「关键识别特征」 |

### 3.3 幂等

`rebuildEntities(shot)` 先 `stripEntityLines()`（正则 `^<Subject\s+\d+>` 与 `^<Picture\s+\d+>\s*(是|提供|取自)`）再按当前 `refs + refTypes` 重新 prepend，因此反复点「重写实体说明」不会叠加，改类型也不会残留旧句。

### 3.4 存储位置

`refTypes` 是镜头级数组，和 `refs` 一一对应，写在 `timeline_data` 里（`cloneShot` 增加 `refTypes: normalizeRefTypes(s.refTypes)`，否则 parse/write 会丢）。后端 `_assemble_plan` 重建 shot dict 时只取 id/seconds/prompt/refs/refVideos/refAudios/motion_expect/seed/note，**refTypes 不进 plan**——它只是前端生成提示词的辅助信息，成品靠提示词正文承载。

## 4 当前镜帧数与时长

摘要条改成两行：

- 上行（全局）：段数 / 每段净增 / 总帧 / 总时长 / 窗口 / 墙钟
- 下行（当前镜，琥珀色 `.dsd-sum-cur`）：当前镜 i/n / 本镜帧 / 本镜时长 / 时间码，外加一个 number input 可原地改帧数（写回 `shot.seconds = round(v / FPS, 4)` 后 commit）

实测：`段数 3 · 每段净增 +119f · 总帧 344 · 时长 14.33 s · 窗口 124/5 · 墙钟 9 min 34 s × 3 ≈ 28 min 43 s` / `当前镜 1/3 · 本镜帧 124 · 本镜时长 5.17 s · 时间码 00:00:05:04`。

## 5 交互补齐

- **新增镜头**：工具栏按钮，插在「刷新面板」与「重算分段」之间；id 用 `s{n}-{Date.now().toString(36)}`，push 后选中新镜并 commit。
- **拖拽上传**：`refSlot` 的上传抽成内部 `doUpload(file)`，槽位加 `dragover`（加 `.dsd-drop` 描边）/ `dragleave` / `drop` 三监听；点击选文件的老路保留。
- **类型 chips**：仅在当前镜已有参考图时出现，每个 chip 是 `<Picture i>` + 下拉 + 序号，无图时提示「先上传参考图，再选类型」。

## 6 多镜真跑证据

`out/wf/multishot-api.json`（两镜 362 帧 / strict False / seed 2609198711 / 704x384 / steps 2 / pass2 关）

```
SUBMIT 0d47fc3e-0a34-4c86-89cb-0c4fb1fe47de
DONE success completed True wall 460
multishot_00001-audio.mp4  704x384  362 帧  15.0833 s  24 fps
[DSD] dsd: 3 段 362 帧 15.1s 用时 7.3min handoff=latent_prefix steps=2 pass=1
```

⇒ 两镜被切成 3 段（124 + 119 + 119），段间 handoff 正常，时长与 `total_frames` 一致。这是 timeline_data 多镜路径的第一次端到端真跑。

## 7 仍未做（诚实清单）

1. 预览台播的是**参考图/参考视频**，不是上次渲染结果；后端没有把产物回传给面板。
2. 时间轴缩略图未做（AIMixer 用前端抽帧，我方刻意不画以省内存）。
3. 双击只在轨道末尾加镜，不能在任意位置切分。
4. 实体模板只有中文一版；英文界面下提示词仍是中文。
5. 墙钟是预设常量（2x 724 s / 1.5x 621 s / 1x 683 s，均为 124 帧单段），自定义预设显示「未实测」。
6. `pass2_model` 与 `plan_path` 仍是 hidden widget，只能通过模板导入间接改。

## 8 复现

```bash
# 前端语法检查
node --check "E:/Comfy/comfyui-licyk-20260608/core/custom_nodes/dsd-director/web/js/dsd_director.js"
# 后端语法检查
cd "E:/Comfy/comfyui-licyk-20260608/core/custom_nodes/dsd-director" && python -m py_compile dsd_nodes/nodes.py
# 多镜探针
cd <project> && ( nohup python src/_wf_run.py out/wf/multishot-api.json multishot 2400 > logs/multishot.out 2>&1 & )
```

浏览器验收（Chrome DevTools）：轮询 `Object.keys(LiteGraph.registered_node_types).length > 100` 后 `LiteGraph.createNode("DSDDirector")`，用 `A.graph.add(n)` 挂到当前图，读 `n.dsdPanelRoot`。

## 9 文档关系

- docs/80-director-node-redesign.md：数据源从 plan 文件搬到 timeline_data 的设计依据。
- docs/81-widget-contract.md：required 8 + optional 31 的 widget 硬合同（本次未改 widget 表，只把 out_w/out_h 的 step 由 32 改成 1）。
- docs/83-director-v2-verification.md：v2 阶段的真跑与进度条验证；本文是 v2.1 的增量。
- docs/72、73、74：一采画质与 2x 解码超采样的证据链，本机的默认预设值来源于它们。
