# 示例工作流

全部 8 件都可直接拖进 ComfyUI 打开。中文名与英文名是**逐字节相同的同一份文件**，只是方便不同界面语言查找；`-api.json` 是给脚本提交用的（`POST /prompt` 的 payload 形状），UI 里打开会看到裸 JSON。

## 选哪一件

| 文件 | 一采 | 超采样 | 交付 | 单段墙钟 | 用途 |
|---|---|---|---|---|---|
| `DSD导演台v2-纯一采直出1376x768.json` | 1376×768 | 关 | 1376×768 | 约 700 s | 画质基线、超采样出问题时的对照件、显存紧时首选 |
| `DSD导演台v2-最优一采+2x超采样.json` | 1376×768 | 2x | 2560×1440 | 约 906 s | 主力交付 |
| `DSD导演台v2-快速验证1步.json` | 1376×768 | 1.25x | 1712×960 | 约 120 s | 1 步冒烟，只验证链路是否通，画质不交付 |

单段 = 124 帧 = 5.1667 秒。3 分钟的片子约 37 段。

## 三件的具体参数

| 参数 | 纯一采直出 | 最优一采+2x | 快速验证1步 |
|---|---|---|---|
| `pass2` | false | true | true |
| `upscale` | `1.0` | `2.0` | `1.25` |
| `gen_w × gen_h` | 1376×768 | 1376×768 | 1376×768 |
| `final_w × final_h` | 0×0（按倍数推算） | 2752×1536 | 按倍数推算 |
| `out_w × out_h` | 1376×768 | 2560×1440 | 1712×960 |
| `steps` | 4 | 4 | 1 |
| `ffn_chunks` | 4 | 4 | 4 |
| `unsharp` | 0 | 0.8 | 0 |
| `export_mode` | frames+timeline | frames | frames |
| `VHS_VideoCombine.filename_prefix` | `dsd/onepass1376` | `dsd/best2x` | `dsd/quickv2` |

`final_w` / `final_h` 写 0 表示交给后端按 `gen × upscale` 推算并做 32 对齐（`_align32`，遇 .5 取偶）。手写死值在切换预设后会残留上一档几何，这正是早期「final_w 2080 ≠ 2064」报错的来源。

## 载入即报错怎么办

`loadGraphData` 抛 `TypeError: Cannot read properties of undefined (reading 'setGraph')` 时，先确认用的是本目录这批文件（v2 契约：widgets_values 36 项，含 `randomize` 槽）。早期 36 项旧顺序的文件会让新节点的 widget 整体错位，表现为 `seed` 读成 `plan_path`、`preset` 读成 `randomize`。

## 跑之前

1. 参考图放进 `ComfyUI/input/`，面板里拖进槽位并给每张图选类型；
2. 提示词 ≥ 3000 字（`strict=true` 时是硬约束），或把 `strict` 关掉降到 1200；
3. 点「体检」；4. 点「运行全部」。