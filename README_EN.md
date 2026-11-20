# DSD Director

Cut a long take into segments, attach reference material and prompts shot by shot, and render MiniMax H3 first-pass plus 2x latent decode-oversample in one click — the node delivers a 2560x1440 master and an SRT/EDL timeline itself.

## What it solves

MiniMax H3 generates 124 frames per call (5.17 s at 24 fps), so any long video is a relay of segments. The stock workflow keeps segments, prompts and reference images in the workflow JSON, which means hand-writing a plan file for every edit. This package moves that into inline node data plus a panel: add, split and delete shots in the UI, drag reference images straight onto a slot, and keep parameters in three layers (built-in constants / adjustable / presets) with real progress while rendering.

## Install

1. Drop the whole `dsd-director` folder into `ComfyUI/custom_nodes/`.
2. Restart ComfyUI, then hard-refresh the browser (`Ctrl+Shift+R`) — the panel is injected by `web/js/dsd_director.js` and a stale page will not load it.
3. No extra Python package to install: `torch` / `numpy` / `Pillow` / `opencv-python` all ship with ComfyUI (`cv2` is only used to read reference videos).
4. The render kernel **ships inside the package** (the `dsd/` directory, 127924 B / 2818 lines), so nothing extra to download and no environment variable to set. To use a kernel you are developing elsewhere, point `DSD_SRC` at it — see [VENDOR.md](VENDOR.md).

> Verified on **ComfyUI 0.45.0** (PyTorch 2.12.1 + CUDA 13.0) only. Older builds lack the `BDGROUP` custom widget and Autogrow inputs, and the panel degrades to a bare widget list.

## Models

| Role | File | Folder |
| --- | --- | --- |
| Base | `minimax_h3_hybrid_fl2va_ref2va_b25-49-int8_r.safetensors` | `models/diffusion_models/MiniMax/` |
| 4-step accelerator | `minimax_h3_fl2v_turbo_4step_v1.2_768p_comfyui_bf16.safetensors` | `models/loras/MINIMAX/` |
| Style | `pika_h3_flex_turbo_4step_ref2va.safetensors` | `models/loras/MINIMAX/` |
| Sharpness | `minimax_h3_lms_v1.0_r64.safetensors` | `models/loras/MINIMAX/` |
| Text encoder | `qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors` (type `minimax`) | `models/text_encoders/` |
| Video VAE | `minimax_h3_video_vae_fp16.safetensors` | `models/vae/` |
| Audio VAE | `minimax_h3_audio_vae_fp32.safetensors` | `models/vae/` |
| Latent upscaler | `minimax_h3_latent_upscaler_3d_conv_v1_bf16.safetensors` | `models/latent_upscale_models/` |

About 50 GB total. The LoRA chain is `base -> 4-step -> style -> sharpness -> DSDDirector` and the shipped workflow already wires it.

## Quick start

0. Open one of three shipped workflows (all under `user/default/workflows/`, same node chain and reference slots, only the decode tier differs):
   - `DSD-director-v2-onepass-1376x768.json` — first pass only (4 steps / no oversample / 1376x768 / about 700 s per segment). Cheapest and fastest: use it to lock framing and prompt first.
   - `DSD-director-v2-best-2x.json` — main delivery (4 steps / 2x latent oversample / 2560x1440 / about 906 s per segment).
   - `DSD-director-v2-quick-1step.json` — one-step smoke test (quality is not deliverable; only proves the chain runs).
1. After loading, confirm `pass2` / `upscale` / `out_w` / `out_h` match the tier you want. The preset buttons in the panel switch all of them in one click.
2. Drag a reference image onto reference slot 1 (or click the slot to pick a file). Up to 3 reference videos and 3 reference audios work the same way.
3. Write the shot prompt. Pick a type for each image (character / background / prop / style), then press "Rewrite subjects" to generate `<Subject N> is ... <Picture K> ...` skeleton lines. It is idempotent — pressing again does not stack lines, and your own prose is preserved.
4. Add more shots with "Add shot", or double-click anywhere on the timeline to split in place. Each shot may override steps / solver / shift / refine steps; leave a field empty to inherit the global value.
5. Press "Lint" for a pre-submit check, then "Run all".

## Three parameter layers

**Built-in constants** (read-only in the panel): `24 fps`, `audio 40 Hz`, `5:3 time ratio`, `canvas stride 32`, `window 17k+5`, `vae_tile 0`, `decode_shifts empty`, `partial_start 0`, `seam_min 0.1`. These are not missing controls — changing them breaks things: an off-grid window is rejected outright, a non-zero `vae_tile` burns a 16 px grid and a 17-frame dark pulse into the decode, and `seam_min` is the re-mask floor at segment seams.

**Adjustable**: `seed`, `preset`, `strict`, `budget_gib`, `steps`, `solver`, `shift_video`, `shift_audio`, `handoff`, `gen_w`, `gen_h`, `window_frames`, `context_frames`, `ffn_chunks`, `tile_size`, `pass2`, `upscale`, `final_w`, `final_h`, `pass2_steps`, `pass2_sigma`, `out_w`, `out_h`, `unsharp`, `export_mode`, `plan_path`.

**Presets** (fill the form, never silently override):

| Preset | First-pass canvas | Oversample | Delivery | unsharp | Wall time per 124 frames |
| --- | --- | --- | --- | --- | --- |
| Best 2x | 4 | 1376x768 | 2.0 -> 2752x1536 | 2560x1440 | 0.8 | 906 s |
| 1.5x fast | 4 | 1376x768 | 1.5 -> 2048x1152 | 1920x1080 | 0.8 | 882 s |
| 1x native | 1376x768 | off | 1376x768 | 0.0 | about 683 s |
| Custom | manual | manual | manual | manual | — |

Clicking a preset writes those values into the widgets. If you then edit a field, the backend compares instead of overwriting, records `preset=... (overridden)` in the report, and renders what you typed.

## Panel cheat sheet

| Area | What it does |
| --- | --- |
| Toolbar | Run all / Refresh / Add shot / Split at playhead / Lint / Re-split / Import / Export / ZH-EN |
| Stage | "Refs" plays the current shot reference; "Render" plays the last mp4 this node produced |
| Transport | Play / pause / seek / timecode |
| Timeline | One block per shot with a thumbnail; cyan lines are window boundaries, amber is the playhead; double-click to split |
| Summary | Segments / net frames per segment / total frames / duration / window-context / wall clock (measured once you have run it, "estimate" before); the second row is the selected shot frames, duration and timecode, editable |
| Output | Delivery size / first-pass canvas / upscale / derived size / unsharp / fps / groups |
| Shot card | Left: reference images 1-9, videos 1-3, audios 1-3 (drag or click); right: prompt, reference types with subject templates, per-shot overrides, prev/next |
| Presets | Four shortcut buttons |
| Status | Two real progress bars (whole run + current segment); lint output lands here too |

## Timeline export

Set `export_mode` to `frames+timeline` and the render writes:

- `<output>/dsd/exports/<plan-id>-<timestamp>.srt` — one cue per delivered segment, e.g. `s1 | steps=4 shift=12.0/3.0 | [Shot 1] ...`
- a sibling `.edl` — CMX3600, frames at 24 fps, each event carrying a `* COMMENT:` with its segment settings

Cues are laid out on delivered frames end to end, so the 5 context frames per seam never push them late.

## Pre-submit lint

The "Lint" button posts to `POST /dsd/preflight` and never queues a render. 19 checks: `E_NO_SHOT` `E_PROMPT_EMPTY` `E_PROMPT_SHORT` `E_SHOT_TOO_SHORT` `E_NO_MATERIAL` `E_TOO_MANY_REFS` `E_PICTURE_MISSING` `E_VIDEO_MISSING` `E_AUDIO_MISSING` `E_CANVAS_STRIDE` `E_FINAL_NOT_BIGGER` `E_WINDOW_GRID` `E_CTX_SET` (errors) and `W_PICTURE_UNUSED` `W_FINAL_OFF_GRID` `W_TIMELINE_GAP` `W_DUP_PROMPT` `W_REF_NOT_FOUND` `W_SUBJECT_ORDER` (warnings). Prompts are also checked against eight sections: `subject_definitions`, `quality_and_style`, `style_and_color_science`, `negative_constraints`, `summary`, `retention_analysis`, `detailed_description`, `camera_and_material`.

## License

MIT; see `LICENSE` in this package. Commercial use, closed-source redistribution
and modification are allowed as long as the copyright notice is kept.
## Known limits

1. **A three-minute film does not fit in six hours**: 37 segments x ~724 s is about 7.3 h on an 8 GB card. Either drop delivery to the 2080 tier or use fewer segments; that call is still open.
2. **Reference material is resolved by filename** inside the ComfyUI `input/` folder. The panel wraps the upload, but hand-typed paths are easy to get wrong (lint reports `W_REF_NOT_FOUND`).
3. **Reference video audio is not wired**: the model accepts three `ref_video_audio_*` pairs, this node currently takes picture only.
4. **Subject templates ship in Chinese and English only**, and cover five kinds.
5. **The 1x native preset disables unsharp on purpose** — with no oversample it would only amplify compression noise.
6. **The wall-clock estimate extrapolates from one segment**; a long film runs slightly slower because of handoff and cache rebuilds.

## Layout

```
dsd-director/
├── __init__.py              register nodes, mount HTTP routes, declare WEB_DIRECTORY
├── dsd_nodes/
│   ├── nodes.py             5 nodes plus geometry, sharpening and timeline export
│   └── routes.py            POST /dsd/preflight
├── dsd/                     render kernel, vendored (see VENDOR.md)
└── web/js/dsd_director.js   the panel (~2900 lines)
```

The render kernel ships inside the package as `dsd/` (`plan.py`, `executor.py`, `handoff.py`, `sampling.py`, `preflight.py`), so copying `dsd-director` into `custom_nodes/` is enough. Import order is **`DSD_SRC` env var > bundled `dsd/` > `film-pipeline/src`**; point `DSD_SRC` at your working copy to use it instead. After editing the kernel run `python scripts/sync_kernel.py` (`--check` only compares and exits 1 on drift) — see [VENDOR.md](VENDOR.md).