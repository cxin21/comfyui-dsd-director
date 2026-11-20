# docs/81 导演台 widget 契约（阶段 A/B 共用硬合同）

本轮重做的 widget 表。**逐位不许改名字、顺序、类型、默认值**。后端 `INPUT_TYPES` 与前端面板读值都必须按此表。

```
required 8 项（前 4 项是连线口）
1 model MODEL
2 clip CLIP
3 video_vae VAE
4 audio_vae VAE
5 seed INT default 2609198601 min 0 max 0xFFFFFFFF extra {"control_after_generate": True}
6 preset COMBO ["本机最优 2x","1.5x 快速","1x 原生","自定义"] default "本机最优 2x"
7 strict BOOLEAN default True
8 budget_gib FLOAT default 7.9 min 1.0 max 16.0 step 0.1

optional 31 项（6 个 BDGROUP 标记 + 25 个参数），顺序即 widgets_values 顺序
1  bd_grp_shot      BDGROUP default 镜头
2  timeline_data    STRING default {"v":2,"fps":24,"shots":[{"id":"s1","seconds":5.1667,"prompt":"","refs":[],"refVideos":[],"refAudios":[],"motionExpect":1.0,"seed":null,"note":""}]} multiline True   【前端隐藏，面板写】
3  total_frames     INT default 124 min 5 max 100000
4  bd_grp_s2        BDGROUP default 采样
5  steps            INT default 4 min 1 max 64
6  solver           COMBO ["euler","exp2"] default euler
7  shift_video      FLOAT default 12.0 min 1.0 max 64.0 step 0.1
8  shift_audio      FLOAT default 3.0 min 1.0 max 64.0 step 0.1
9  handoff          COMBO ["latent_prefix","latent_prefix_ramp","latent_prefix_anchor"] default latent_prefix
10 bd_grp_geo       BDGROUP default 几何与窗口
11 gen_w            INT default 1376 min 128 max 8192 step 32
12 gen_h            INT default 768 min 128 max 8192 step 32
13 window_frames    INT default 124 min 124 max 362 step 17
14 context_frames   COMBO ["5","22","39"] default "5"
15 ffn_chunks       INT default 4 min 1 max 64
16 tile_size        INT default 512 min 128 max 1024 step 64
17 bd_grp_decode    BDGROUP default 解码超采样
18 pass2            BOOLEAN default True
19 upscale          COMBO ["1.0","1.25","1.5","2.0"] default "2.0"
20 final_w          INT default 0 min 0 max 8192 step 32
21 final_h          INT default 0 min 0 max 8192 step 32
22 pass2_steps      INT default 0 min 0 max 32
23 pass2_sigma      FLOAT default 0.0 min 0.0 max 0.95 step 0.01
24 bd_grp_deliver   BDGROUP default 性能与交付
25 out_w            INT default 2560 min 0 max 8192 step 32
26 out_h            INT default 1440 min 0 max 8192 step 32
27 unsharp          FLOAT default 0.8 min 0.0 max 2.0 step 0.05
28 export_mode      COMBO ["frames","frames+report"] default frames
29 bd_grp_tpl       BDGROUP default 模板与内置常量
30 plan_path        STRING default ""    【空 = 纯 UI 模式；非空 = 当模板导入】
31 builtin_note     STRING default 24fps | audio 40Hz | time ratio 5:3 | canvas %32 | window 17k+5 | vae_tile 0 | decode_shifts empty | partial_start 0 | seam_min 0.1 multiline True
```

## 与旧版的差异
- 删除 `inline_prompt`（并入 `timeline_data.shots[i].prompt`）
- `plan_path` 从 required 第一位挪到 optional 第 30 位，默认空串
- `solver` 从 ["plan","euler","exp2"] 变 ["euler","exp2"]
- `context_frames` 从 INT 变 COMBO 字符串 ["5","22","39"]
- `handoff` 从 required 挪到 optional，只剩 3 值
- 新增 `preset`（required 第 6 位）、`tile_size`（第 16 位）、`builtin_note`（第 31 位）、`timeline_data`（第 2 位）

## 预设表
| preset | gen | upscale | final | out | unsharp | 实测墙钟 |
| 本机最优 2x | 1376x768 | 2.0 | 2752x1536 | 2560x1440 | 0.8 | 724 s / 124 帧 |
| 1.5x 快速 | 1376x768 | 1.5 | 2080x1152 | 1920x1080 | 0.8 | 621 s / 124 帧 |
| 1x 原生 | 1376x768 | 1.0 | 1376x768 | 1376x768 | 0.0 | 683 s / 124 帧 |
| 自定义 | 不改动 |
