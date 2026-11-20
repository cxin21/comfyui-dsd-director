# docs/88 · 纯一采直出 1376x768 工作流（pass2 关闭）

> 2026-11-21 · 对应 `user/default/workflows/DSD导演台v2-纯一采直出1376x768.json` 与 `-api.json`

## 0. 结论

1. 新增一件「纯一采直出」工作流：`pass2=false` / `upscale=1.0` / 一采画布 1376x768 / 交付 1376x768 / steps 4 / unsharp 0，导出 `frames+timeline`（同时落 SRT+EDL）。
2. 与既有两件并列（best-2x 走一采+2x 超采样、quick-1step 是 1 步快速验证臂），三件覆盖「最快验证 / 原生直出 / 高质量放大」。
3. 真跑验收：prompt `1b005d24-2fc9-4372-b43f-4522cc5107f1`，`status success`，**wall 700 s**，产物 1376x768 / 124 帧 / 5.1667 s / 4217687 B。
4. 同一次运行落 `exports/inline-20261121-000949.srt`（158 B）与 `.edl`（168 B）—— 导出层在 pass2 关闭时同样工作。

## 1. 为什么需要这件

- 既有 best-2x 是「一采 1376x768 → 潜空间 2x 到 2752x1536 → 交付 2560x1440」，单段约 906 s，3 分钟正片放不进 6 小时。
- quick-1step 是 1 步的快速验证臂（`steps=1` / `upscale=1.25` / `unsharp 0`），画质不是交付级。
- 缺一件「4 步、原生几何、不放大」的臂：它是最省显存与最省时间的**可用**画质基线，也是超采样出问题时的对照件。

## 2. 参数表（与 `DSDDirector` widget 逐位一致）

| widget | 值 | 说明 |
| --- | --- | --- |
| `preset` | 自定义 | 不接管几何，全部按显式值执行 |
| `steps` / `ffn_chunks` | 4 / 4 | 底模是 4 步蒸馏，1 步属分布外（见 docs/87） |
| `gen_w` / `gen_h` | 1376 / 768 | 一采画布，32 的倍数 |
| `pass2` | **false** | 本条核心：不做潜空间超采样 |
| `upscale` / `final_w` / `final_h` | 1.0 / 0 / 0 | final 为空时后端按 `align32(gen*mult)` 推算 = 1376x768 |
| `out_w` / `out_h` | 1376 / 768 | 交付尺寸与一采画布相同，不做 bicubic 缩放 |
| `unsharp` | 0.0 | 1x 原生不锐化（与 1x 预设一致） |
| `export_mode` | frames+timeline | 额外落 SRT/EDL |

## 3. 真跑证据

| 项 | 值 |
| --- | --- |
| prompt id | `1b005d24-2fc9-4372-b43f-4522cc5107f1` |
| 状态 | `success` / `completed True` |
| 墙钟 | **700 s**（面板摘要实测 11 min 28 s） |
| 产物 | `output/dsd/onepass1376_00001-audio.mp4` |
| 规格 | 1376x768 / 124 帧 / 5.166667 s / 24 fps / 4217687 B |
| 导出 | `exports/inline-20261121-000949.srt` 158 B、`.edl` 168 B |

SRT 首条：

```
1
00:00:00,000 --> 00:00:05,167
s1 | steps=4 shift=12.0/3.0 | subject_definitions: <Subject 1> ...
```

EDL 首事件：

```
001  AX       V     C        00:00:00:00 00:00:05:04 00:00:00:00 00:00:05:04
* FROM CLIP NAME: s1
* COMMENT: steps=4 shift=12.0/3.0
```

## 4. 面板与前端核对（浏览器实测）

- 载入 `DSD导演台v2-纯一采直出1376x768.json`：`loadGraphData` 无异常，9 节点，节点标题「DSD 导演台 · 纯一采直出 1376x768」，37 widget / 38 按钮 / 面板在。
- widget 读回：`preset=自定义, steps=4, ffn=4, pass2=false, upscale=1.0, final=[0,0], out=[1376,768], unsharp=0, export_mode=frames+timeline, seed=2609198601, total_frames=124`。
- `graphToPrompt()`：DSD 节点 **39 输入**，`pass2=False` / `out=[1376,768]` / `timelineShots=1`。
- 摘要条：「段数 1 · 每段净增 +119f · 总帧 124 · 时长 5.17 s · 窗口 124/5 · 墙钟 11 min 28 s × 1 段 ≈ 11 min 28 s (实测)」；输出条「推算 1376x768 ×1.0 = 1376x768（final 0x0）」；`.dsd-warn` 为空；两条进度条 100%。

## 5. 三件工作流的分工

| 工作流 | 一采画布 | 超采样 | 交付 | 单段墙钟 | 用途 |
| --- | --- | --- | --- | --- | --- |
| `DSD导演台v2-纯一采直出1376x768.json` | 1376x768 | 关 | 1376x768 | 700 s | 可用画质基线 / 对照件 / 省显存 |
| `DSD导演台v2-最优一采+2x超采样.json` | 1376x768 | 2x | 2560x1440 | 906 s | 主力交付 |
| `DSD导演台v2-快速验证1步.json` | 1376x768 | 1.25x | 1712x960 | 约 120 s | 1 步冒烟，画质不交付 |

## 6. 仍未做

- 这条臂没做「同参考图同提示词」的逐帧对照：它与老脚本 `out/c/c1_sharp-2560.mp4` 的几何不同（1376x768 vs 2560x1440），要做对照得按同一目标尺寸另跑一臂。
- 3 分钟正片的预算裁决仍悬着（docs/87 §6）：1376x768 直出是当前最省的一档，但仍要按段数算总时长。

## 7. 复现

```bash
# 真跑（api 版）
python src/_wf_run.py out/wf/onepass-wf-api.json onepasswf 1800
# 查产物
ffprobe -v error -select_streams v:0 -show_entries stream=width,height,nb_frames -of csv=p=0 \
  E:/Comfy/comfyui-licyk-20260608/core/output/dsd/onepass1376_00001-audio.mp4
```

## 8. 文档关系

- `docs/81-widget-contract.md`：widget 硬合同（36 位顺序）
- `docs/84-director-ui-v2-1.md`：预设与几何分层
- `docs/85-director-v2-2-preflight-overrides-export.md`：SRT/EDL 导出
- `docs/87-director-ui-v2-3-full-sweep.md`：四档预设对照、steps 是画质主因
