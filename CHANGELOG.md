# 变更记录

## 2.3.2 — 2026-11-21

- **新增纯一采直出工作流** `DSD导演台v2-纯一采直出1376x768.json`（配套 `-api.json`）：`pass2=false` / `upscale=1.0` / 一采与交付均为 1376x768 / steps 4 / unsharp 0 / `export_mode=frames+timeline`。真跑 wall 700 s，产物 1376x768 / 124 帧 / 5.1667 s，同时落 SRT+EDL。
- README 与 README_EN 的快速上手改成「三件工作流怎么选」，并给出每件的单段墙钟。
- 新增英文别名工作流 `DSD-director-v2-onepass-1376x768.json`。
## 2.3.1 — 2026-11-20

- **修四档预设跑在 1 步上的问题**：三档 patch 现在都显式写 steps: 4, ffn_chunks: 4。之前只写几何与 unsharp，节点会沿用 widget 上残留的 steps，于是 1.5x / 1x 实际在 1 步上渲染，4 步蒸馏 LoRA 出了分布外画面（线条发散）。
- 预设的 wall 换成 4 步实测墙钟：2x 906 s / 1.5x 882 s / 1x 1080 s（704p 124 帧单臂）。
- README 与 README_EN 的预设表补 steps 列与实测墙钟。
- 补 LICENSE（MIT）并在 README 与 README_EN 里写明许可证。
- **align32 与后端对齐**：Python round 遇 .5 取偶、JS Math.round 取上，1376x1.5=2064 这类边界上两边给出 2048 与 2080 两个值；面板现在镜像后端取偶。
- **预设钉住 pass2**：2x / 1.5x 写 pass2: true，1x 写 pass2: false（1x 的 final 不大于 gen，后端会拒并记 warning）。
## 2.3.0

- 面板新增 14 项交互：撤销/重做、时间轴拖拽重排、前移/后移/复制/沿用、快捷键与 F1 帮助、提示词 8 板块检查器、字数表、运行守卫、运行日志、秒标尺、成本估算、本镜导入导出、三段折叠、清空本镜参考、保存徽章。
- 新增「删除本镜」按钮；「删除」按钮与 Delete 键现在都会弹确认条（此前只有时间轴右键可用）。
- 上一镜/下一镜改为夹紧，不再从末尾环绕回第一镜。
- 修 export 事件把进度条从 100% 拉回 99%；修切换语言后面板重建导致进度条与运行日志归零。
- 实体说明模板支持中英双语（随面板语言切换）。

## 2.2.0 — 2026-11-20

首个可对外发布的版本。

### 数据源

- 镜头表从外部 plan JSON 搬进节点内联 `timeline_data`，运行链路不再读写任何 plan 文件。`plan_path` 降级为可选的模板导入口（非空时读一次当模板，widget 覆盖其后）。
- 参考素材三路（图 1–9 / 视频 1–3 / 音频 1–3）按 ComfyUI `input/` 目录里的文件名解析，可在面板里拖拽上传或点击选择。

### 面板

- 九段自绘面板：工具栏 / 预览台 / 播放条 / 时间轴 / 摘要 / 输出条 / 镜头卡 / 预设条 / 状态区。
- 时间轴每镜一块并绘制缩略图，青色实线标段窗口边界，琥珀色播放头；双击任意位置就地切分镜头。
- 预览台两个 tab：「看参考」播当前镜的参考素材，「看成片」播上一次渲染产物。
- 新增镜头 / 在播放头处切分 / 中英切换（真实字典 + `localStorage` 记忆，切换后面板不重建节点）。
- 参考图类型（角色 / 背景 / 道具 / 风格 / 其他）驱动实体说明模板，中英双语，幂等重写不覆盖用户正文。
- 镜头级参数覆盖：steps / solver / shift_video / shift_audio / pass2_steps，留空继承全局。
- 摘要条显示当前镜的帧数、时长与时间码，可直接改帧数。

### 后端

- `DSDDirector` 的 widget 表冻结为 required 8 + optional 31，分六个折叠组（镜头 / 采样 / 几何与窗口 / 解码超采样 / 性能与交付 / 模板与内置常量）。
- 预算式预设：点预设只填表，手改后不被静默覆盖，report 里记 `preset=... (overridden)`。
- 真进度：`dsd_progress` 事件按 `采样步进 / 段开始 / 段完成 / 解码 / 锐化 / 缩放 / 导出` 上报，采样步进精确到每一步。
- `export_mode` 新增 `frames+timeline`，渲染结束写 SRT（每段一条字幕，带段级参数）与 CMX3600 EDL（24 fps 数帧），时间码按已交付帧首尾相接。
- `POST /dsd/preflight` 提交前体检，19 条检查码，不触发渲染。

### 发布

- 渲染内核 vendor 进包（`dsd/`，7 个文件 127924 B / 2818 行），导入顺序 `DSD_SRC` > 包内 `dsd/` > `film-pipeline/src`。此前只拷 `dsd-director` 会 `ModuleNotFoundError: No module named 'dsd'`，且报错文本看不出缺什么。
- `scripts/sync_kernel.py`：`python scripts/sync_kernel.py` 复制并打印 sha256 对照，`--check` 只比较、不一致退出码 1。
- `VENDOR.md` 说明内置内核的解析顺序、文件表与漂移对策。
- 内核解析顺序修正：`sys.path.insert(0, ...)` 两次调用的净效果是**后插的优先**，包内副本一度抢不过工作区那份。改为先摘再按优先级反序插入，并在 `import dsd` 前校验 `sys.modules` 来源。
- 启动日志打一行 `[DSD] kernel: <路径> (resolved from <DSD_SRC>)`，一眼看出实际加载的是哪份内核。
### 修复

- 语言切换后面板空白：`domWidget.element` 就是我们的 host，重新 append 等于把节点插进自己（`HierarchyRequestError`）。
- 点 1.5x 预设报 `final_w 2080 != 2064`：前端按未对齐值比较、切换预设残留上一档 final、`out_h` 被 widget step=32 吸成 1088。三处都已修。
- `out_w` / `out_h` 之前只记进 report 从未真正缩放画面。
- 两处写死的 `E:/Comfy/.../input` 绝对路径改为 `folder_paths.get_input_directory()`。

## 2.1.0

- 面板补齐当前镜帧数 / 时长、新增镜头、参考图类型与实体说明。
- 预设语义从「接管」改成「填表」。

## 2.0.0

- 节点内联 `timeline_data` 取代 plan 文件；面板九段成型；参考素材三路接通。

## 1.0.0

- 初版：DSDDirector 11 个 widget，读外部 plan JSON，无前端。