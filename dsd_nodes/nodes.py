"""DSD Director — plan-truth-source nodes for MiniMax H3 video pipelines.
Strategy: nodes never embed or load models; they validate plan JSON, derive window
geometry (17k+5 first window, capacity=window-context afterwards), and expose shot
prompts/resources. References docs/research/dsd-api-ui.md + docs/22.
"""
import io, json, os, math

DEFAULT_MIN_CHARS = 3000

def _first_window_legal(f):
    return f % 17 == 5

def _coverage(plan):
    r = plan["render"]; wf, cf, total = r["window_frames"], r["context_frames"], r["total_frames"]
    idx, produced = 0, 0
    windows = []
    while produced < total and idx < 512:
        cap = wf if idx == 0 else wf - cf
        take = min(cap, total - produced)
        windows.append(take)
        produced += take; idx += 1
    return windows, produced == total

class DSDPlanInspector:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "plan_path": ("STRING", {"default": "out/plan.json"}),
            "min_chars": ("INT", {"default": DEFAULT_MIN_CHARS, "min": 0, "max": 100000}),
            "strict": ("BOOLEAN", {"default": True}),
        }}
    RETURN_TYPES = ("STRING", "INT", "INT", "STRING")
    RETURN_NAMES = ("plan_json", "total_frames", "shot_count", "report")
    FUNCTION = "inspect"
    CATEGORY = "dsd/director"

    def inspect(self, plan_path, min_chars, strict):
        errs, warns = [], []
        base = os.environ.get("DSD_PROJECT_ROOT") or os.path.join(os.path.expanduser("~"), "Documents", "deepseek-harness", "default-workspace", "film-pipeline")
        p = plan_path if os.path.isabs(plan_path) else os.path.join(base, plan_path)
        plan = None
        try:
            with open(p, "r", encoding="utf-8") as f: plan = json.load(f)
        except Exception as e:
            errs.append(f"plan unreadable: {e}")
        if plan:
            schema = plan.get("schema", "")
            if not str(schema).startswith("dsd/"): errs.append(f"schema {schema} not dsd/*")
            r = plan.get("render", {})
            wf, cf, total = r.get("window_frames"), r.get("context_frames"), r.get("total_frames")
            if not all(isinstance(x, int) for x in (wf, cf, total)):
                errs.append("render window/context/total must be ints")
            else:
                if cf not in (5, 22, 39): errs.append(f"context_frames {cf} not in {{5,22,39}}")
                if cf >= wf: errs.append("context_frames must be < window_frames")
                if not _first_window_legal(wf): errs.append(f"window_frames {wf} not on 17k+5 grid")
                if wf < 124: warns.append(f"window_frames {wf} below T8 node min 124 (single-pass ok)")
                wins, ok = _coverage(plan)
                if not ok: errs.append("window coverage does not reach total_frames")
            shots = plan.get("shots", [])
            if not shots: errs.append("plan has no shots")
            for i, s in enumerate(shots):
                pr = s.get("prompt_ref", "")
                if not pr: errs.append(f"shot {i} missing prompt_ref")
                else:
                    fp, _, seg = pr.partition("#")
                    fpp = fp if os.path.isabs(fp) else os.path.join(base, fp)
                    try:
                        with open(fpp, "r", encoding="utf-8") as f: d = json.load(f)
                        segs = d if isinstance(d, list) else d.get("segments", [])
                        k = int(seg or 0)
                        if k >= len(segs): errs.append(f"shot {i} segment {k} out of range")
                        elif len(segs[k]) < min_chars: errs.append(f"shot {i} prompt len {len(segs[k])} < {min_chars}")
                    except Exception as e: errs.append(f"shot {i} prompts unreadable: {e}")
            refs = (plan.get("resources", {}) or {}).get("ref_images", [])
            comfy_in = _input_dir()
            for rp in refs:
                rp2 = rp if os.path.isabs(rp) else os.path.join(comfy_in, rp)
                if not os.path.isfile(rp2): errs.append(f"ref missing: {rp}")
        report = "DSD INSPECT " + ("PASS" if not errs else "FAIL") + ("; " + "; ".join(errs) if errs else "") + ("; warn: " + "; ".join(warns) if warns else "")
        if errs and strict: raise ValueError(report)
        pj = json.dumps(plan, ensure_ascii=False) if plan else "{}"
        total_ok = plan["render"]["total_frames"] if plan and errs == [] else 0
        return (pj, total_ok, len(plan.get("shots", []) or []), report)

class DSDShotPrompt:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "plan_json": ("STRING", {"forceInput": True}),
            "shot_index": ("INT", {"default": 0, "min": 0, "max": 255}),
        }}
    RETURN_TYPES = ("STRING", "FLOAT", "FLOAT")
    RETURN_NAMES = ("prompt", "motion_expect", "seconds")
    FUNCTION = "shot"
    CATEGORY = "dsd/director"

    def shot(self, plan_json, shot_index):
        plan = json.loads(plan_json)
        shots = plan.get("shots", [])
        if shot_index >= len(shots): raise ValueError(f"shot_index {shot_index} >= shots {len(shots)}")
        s = shots[shot_index]
        base = os.environ.get("DSD_PROJECT_ROOT") or os.path.join(os.path.expanduser("~"), "Documents", "deepseek-harness", "default-workspace", "film-pipeline")
        fp, _, seg = s.get("prompt_ref", "").partition("#")
        fpp = fp if os.path.isabs(fp) else os.path.join(base, fp)
        with open(fpp, "r", encoding="utf-8") as f: d = json.load(f)
        segs = d if isinstance(d, list) else d.get("segments", [])
        me = s.get("motion_expect", {})
        m = me.get("ratio", 1.0) if isinstance(me, dict) else float(me)
        return (segs[int(seg or 0)], float(m), float(s.get("seconds", 0)))

class DSDResourceHub:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "plan_json": ("STRING", {"forceInput": True}),
        }}
    RETURN_TYPES = ("STRING", "INT", "STRING")
    RETURN_NAMES = ("ref_paths", "ref_count", "report")
    FUNCTION = "hub"
    CATEGORY = "dsd/director"

    def hub(self, plan_json):
        plan = json.loads(plan_json)
        refs = (plan.get("resources", {}) or {}).get("ref_images", [])
        comfy_in = _input_dir()
        ok, missing = [], []
        for rp in refs:
            rp2 = rp if os.path.isabs(rp) else os.path.join(comfy_in, rp)
            (ok if os.path.isfile(rp2) else missing).append(rp2)
        report = f"DSD HUB {len(ok)} ok" + ("; MISSING " + ",".join(missing) if missing else "")
        if missing: raise ValueError(report)
        return (",".join(ok), len(ok), report)



class DSDDecodeAV:
    """Decode a MiniMax H3 AV latent with tiled video decode to bound peak VRAM.

    Whole-clip decode of a 1280x736 AV latent peaks >5 GiB (measured on 8 GB
    cards, see docs/29); official vae.decode_tiled splits the same latent in
    space and time with no quality change beyond tile seams that the VAE
    overlap-blends. Audio always decodes whole (its latent is tiny).
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "av_latent": ("LATENT",),
            "video_vae": ("VAE",),
            "audio_vae": ("VAE",),
            "tile_size": ("INT", {"default": 512, "min": 64, "max": 4096, "step": 32}),
            "overlap": ("INT", {"default": 64, "min": 0, "max": 4096, "step": 32}),
            "temporal_size": ("INT", {"default": 32, "min": 8, "max": 4096, "step": 4}),
            "temporal_overlap": ("INT", {"default": 8, "min": 4, "max": 4096, "step": 4}),
        }}

    RETURN_TYPES = ("IMAGE", "AUDIO")
    RETURN_NAMES = ("frames", "generated_audio")
    FUNCTION = "decode"
    CATEGORY = "dsd/director"

    def decode(self, av_latent, video_vae, audio_vae, tile_size, overlap, temporal_size, temporal_overlap):
        import torch
        from comfy_extras.nodes_audio import vae_decode_audio
        samples = av_latent["samples"]
        if getattr(samples, "is_nested", False):
            video, audio = samples.unbind()
        else:
            video, audio = samples, None
        if tile_size < overlap * 4:
            overlap = tile_size // 4
        if temporal_size < temporal_overlap * 2:
            temporal_overlap = temporal_overlap // 2
        tc = video_vae.temporal_compression_decode()
        if tc is not None:
            temporal_size = max(2, temporal_size // tc)
            temporal_overlap = max(1, min(temporal_size // 2, temporal_overlap // tc))
        else:
            temporal_size = None
            temporal_overlap = None
        comp = video_vae.spacial_compression_decode()
        images = video_vae.decode_tiled(video, tile_x=tile_size // comp, tile_y=tile_size // comp,
                                        overlap=overlap // comp, tile_t=temporal_size,
                                        overlap_t=temporal_overlap)
        if images.ndim == 5:
            images = images.reshape(-1, *images.shape[-3:])
        if audio is None:
            raise ValueError("DSDDecodeAV needs a nested MiniMax H3 AV latent (video+audio)")
        decoded_audio = vae_decode_audio(audio_vae, {"samples": audio})
        if not bool(torch.isfinite(images).all()):
            raise ValueError("tiled video decode returned nonfinite values")
        return (images, decoded_audio)

# --------------------------------------------------------------------------- #
# DSDDirector — L3 节点层：把 src/dsd 执行器接到 ComfyUI
# --------------------------------------------------------------------------- #

def _bundled_dsd_root():
    """返回包内自带的 dsd 内核根目录；没有就返回空串。"""
    here = os.path.dirname(os.path.abspath(__file__))
    root = os.path.dirname(here)
    return root if os.path.isfile(os.path.join(root, "dsd", "__init__.py")) else ""

_DSD_LOGGED = []

# 内核解析顺序：DSD_SRC 环境变量 > 包内自带的 dsd/ > film-pipeline/src。
# 包内自带是为了让「只把 dsd-director 目录拷进 custom_nodes」也能跑（v2.2.0 起）。
DSD_SRC = (os.environ.get("DSD_SRC") or _bundled_dsd_root() or os.path.join(
    os.path.expanduser("~"), "Documents", "deepseek-harness",
    "default-workspace", "film-pipeline", "src"))


def _load_dsd():
    """导入 dsd 内核（纯 python + torch，不依赖 T8）：包内自带优先。"""
    import sys
    # 已经加载过、但不是 DSD_SRC 那份（早前被别的入口抢先 import）就丢掉缓存重来。
    _prev = sys.modules.get("dsd")
    if _prev is not None:
        _f = os.path.abspath(getattr(_prev, "__file__", "") or "")
        if not _f.startswith(os.path.abspath(DSD_SRC) + os.sep):
            for _k in [k for k in list(sys.modules) if k == "dsd" or k.startswith("dsd.")]:
                sys.modules.pop(_k, None)
    while DSD_SRC in sys.path:
        sys.path.remove(DSD_SRC)
    sys.path.insert(0, DSD_SRC)
    import dsd
    if not _DSD_LOGGED:
        _DSD_LOGGED.append(1)
        print("[DSD] kernel: %s (resolved from %s)" % (getattr(dsd, "__file__", "?"), DSD_SRC or "<empty>"))
    from dsd import executor, handoff, plan as plan_mod
    return executor, handoff, plan_mod


def _align32(v):
    """把像素值按 32 对齐（四舍五入到最近的 32 倍数）。"""
    return int(round(float(v) / 32.0)) * 32


def _unsharp5(frames, amount):
    """5x5 高斯反锐化：out = x + amount*(x - blur)，再 clamp 到 0..1。

    frames 形状 [T,H,W,3]，float。amount <= 0 时原样返回（零成本）。
    逐帧（不做时间维模糊），按帧切块以控制显存。"""
    if amount is None:
        return frames
    amt = float(amount)
    if amt <= 0.0:
        return frames
    import torch
    if frames.ndim != 4:
        return frames
    t, h, w, c = [int(x) for x in frames.shape]
    per_frame = max(1, h * w * c)
    step = max(1, int(64 * 1024 * 1024 // per_frame))
    k = torch.tensor([1.0, 4.0, 6.0, 4.0, 1.0], dtype=frames.dtype, device=frames.device)
    k = k / k.sum()
    kh = k.view(1, 1, 5, 1).expand(c, 1, 5, 1)
    kw = k.view(1, 1, 1, 5).expand(c, 1, 1, 5)
    out = torch.empty_like(frames)
    with torch.no_grad():
        for i in range(0, t, step):
            x = frames[i:i + step].permute(0, 3, 1, 2).contiguous()
            xp = torch.nn.functional.pad(x, (2, 2, 2, 2), mode="replicate")
            b = torch.nn.functional.conv2d(xp, kh, groups=c)
            b = torch.nn.functional.conv2d(b, kw, groups=c)
            y = (x + amt * (x - b)).clamp_(0.0, 1.0)
            out[i:i + step] = y.permute(0, 2, 3, 1)
    return out


# ===========================================================================
# 阶段 A：A1 节点内联数据源 / A2 三路参考素材 / A3 真进度 / A4 docs/81 widget
# ===========================================================================

_UPSCALER = "minimax_h3_latent_upscaler_3d_conv_v1_bf16.safetensors"
_FPS = 24

# --------------------------------------------------------------------------- #
# timeline export: SRT + CMX3600 EDL
# --------------------------------------------------------------------------- #
def _srt_time(seconds):
    """HH:MM:SS,mmm - SRT wants a comma before the milliseconds."""
    ms = int(round(max(0.0, float(seconds)) * 1000.0))
    h, ms = divmod(ms, 3600000)
    m, ms = divmod(ms, 60000)
    sec, ms = divmod(ms, 1000)
    return "%02d:%02d:%02d,%03d" % (h, m, sec, ms)


def _edl_time(frames):
    """HH:MM:SS:FF at _FPS - CMX3600 counts frames, never milliseconds."""
    f = max(0, int(frames))
    resid = f % _FPS
    total = f // _FPS
    return "%02d:%02d:%02d:%02d" % (total // 3600, (total // 60) % 60,
                                    total % 60, resid)


def _cue_text(shot_id, brief, prompt, limit=60):
    """One cue line: which shot, with what settings, saying what."""
    flat = " ".join(str(prompt or "").split())
    if len(flat) > limit:
        flat = flat[:limit] + "..."
    parts = [str(shot_id)]
    if brief:
        parts.append(str(brief))
    if flat:
        parts.append(flat)
    return " | ".join(parts)


def _cue_rows(plan, segments):
    """(start, end, text) per DELIVERED segment.

    A segment ships only its visible frames: the head context and the tail
    trim are dropped before the frames reach the timeline.  Laying those
    delivered counts end to end is what keeps cues in sync - the plan-level
    start_frame would push every cue after the first one late by
    context_frames per seam.
    """
    _, _, plan_mod = _load_dsd()
    base = plan_mod.base_params(plan)
    by_id = {}
    for sh in getattr(plan, "shots", []) or []:
        by_id[str(sh.id)] = sh
    rows = []
    cursor = 0
    for pos, row in enumerate(segments or []):
        n = int(row.get("frames", 0) or 0)
        sid = str(row.get("shot_id") or ("s%d" % (int(row.get("index", pos)) + 1)))
        shot = by_id.get(sid)
        eff = row.get("effective")
        if not eff:
            eff = (plan_mod.shot_overrides_effective(shot, base)
                   if shot is not None else base)
        prompt = getattr(shot, "prompt", "") if shot is not None else ""
        brief = plan_mod.override_brief(eff)
        rows.append({"start": cursor, "end": cursor + n, "shot_id": sid,
                     "brief": brief, "text": _cue_text(sid, brief, prompt)})
        cursor += n
    return rows


def _build_srt(rows):
    out = []
    for i, row in enumerate(rows):
        out.append(str(i + 1))
        out.append("%s --> %s" % (_srt_time(row["start"] / float(_FPS)),
                                  _srt_time(row["end"] / float(_FPS))))
        out.append(row["text"])
        out.append("")
    return chr(10).join(out)


def _build_edl(rows, title="inline"):
    out = ["TITLE   %s" % title, "FCM: NON-DROP FRAME", ""]
    for i, row in enumerate(rows):
        tc_in = _edl_time(row["start"])
        tc_out = _edl_time(row["end"])
        out.append("%03d  AX       V     C        %s %s %s %s"
                   % (i + 1, tc_in, tc_out, tc_in, tc_out))
        out.append("* FROM CLIP NAME: %s" % row["shot_id"])
        out.append("* COMMENT: %s" % row["brief"])
        out.append("")
    return chr(10).join(out)


def _write_timeline_exports(plan, segments):
    """Write SRT + EDL under <output>/dsd/exports; return both absolute paths."""
    import time as _time
    import folder_paths

    out_dir = os.path.join(folder_paths.get_output_directory(), "dsd", "exports")
    os.makedirs(out_dir, exist_ok=True)
    plan_id = str((getattr(plan, "raw", {}) or {}).get("id") or "inline")
    safe = "".join(c if (c.isalnum() or c in "-_") else "_" for c in plan_id) or "inline"
    stamp = _time.strftime("%Y%m%d-%H%M%S")
    stem = "%s-%s" % (safe, stamp)
    rows = _cue_rows(plan, segments)
    if not rows:
        raise ValueError("no segments to export")
    srt_path = os.path.join(out_dir, stem + ".srt")
    edl_path = os.path.join(out_dir, stem + ".edl")
    with io.open(srt_path, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(_build_srt(rows))
    with io.open(edl_path, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(_build_edl(rows, title=plan_id))
    return [srt_path, edl_path]

_REF_IMAGE_MAX = 9
_REF_VIDEO_MAX = 3
_REF_AUDIO_MAX = 3
_REF_VIDEO_FRAMES_MAX = 360
_REF_VIDEO_SHORT_EDGE = 704

# docs/81 optional#2 的默认 timeline_data，逐字一致
_DEFAULT_TIMELINE_JSON = (
    '{"v":2,"fps":24,"shots":[{"id":"s1","seconds":5.1667,"prompt":"",'
    '"refs":[],"refVideos":[],"refAudios":[],"motionExpect":1.0,'
    '"seed":null,"note":""}]}'
)

_DEFAULT_SHOT = {
    "id": "s1",
    "seconds": 124 / 24.0,
    "prompt": "",
    "refs": [],
    "refVideos": [],
    "refAudios": [],
    "motion_expect": 1.0,
    "seed": None,
    "note": "",
}

# docs/81 预设表：gen / upscale / out / unsharp（final 由 gen*upscale 推导）
_PRESETS = {
    "本机最优 2x": {"gen": (1376, 768), "upscale": "2.0", "out": (2560, 1440), "unsharp": 0.8},
    "1.5x 快速": {"gen": (1376, 768), "upscale": "1.5", "out": (1920, 1080), "unsharp": 0.8},
    "1x 原生": {"gen": (1376, 768), "upscale": "1.0", "out": (1376, 768), "unsharp": 0.0},
}
_PRESET_NAMES = ["本机最优 2x", "1.5x 快速", "1x 原生", "自定义"]


def _default_timeline() -> str:
    """默认 timeline JSON 字符串（docs/81 optional#2 的默认值）。"""
    return _DEFAULT_TIMELINE_JSON


def _input_dir() -> str:
    import folder_paths
    return str(folder_paths.get_input_directory())


def _load_ref_images(names, warnings=None, shot_id="?"):
    """PIL -> RGB -> /255.0 -> [1,H,W,C] float32。"""
    import numpy as np
    import torch
    from PIL import Image

    d = _input_dir()
    out = []
    for name in list(names or [])[:_REF_IMAGE_MAX]:
        p = os.path.join(d, str(name))
        if not os.path.isfile(p):
            raise ValueError("参考图不存在: %s (input 目录 %s)" % (name, d))
        img = Image.open(p).convert("RGB")
        arr = np.array(img).astype(np.float32) / 255.0
        out.append(torch.from_numpy(arr).unsqueeze(0))
    return out


def _load_ref_videos(names, warnings=None, shot_id="?"):
    """cv2 逐帧读 -> 24fps 重采样 -> 短边 <=704(只缩不放) -> [T,H,W,C] /255.0，T<=360。"""
    import cv2
    import numpy as np
    import torch

    d = _input_dir()
    out = []
    for name in list(names or [])[:_REF_VIDEO_MAX]:
        p = os.path.join(d, str(name))
        if not os.path.isfile(p):
            raise ValueError("参考视频不存在: %s (input 目录 %s)" % (name, d))
        cap = cv2.VideoCapture(p)
        if not cap.isOpened():
            raise ValueError("参考视频无法打开: %s (input 目录 %s)" % (name, d))
        src_fps = float(cap.get(cv2.CAP_PROP_FPS) or 0.0) or float(_FPS)
        frames = []
        try:
            while True:
                ok, bgr = cap.read()
                if not ok:
                    break
                frames.append(bgr)
        finally:
            cap.release()
        if not frames:
            raise ValueError("参考视频没有可解码帧: %s (input 目录 %s)" % (name, d))
        total_s = len(frames) / max(1e-6, src_fps)
        n_out = int(round(total_s * _FPS))
        n_out = max(1, min(_REF_VIDEO_FRAMES_MAX, n_out))
        sel = []
        for i in range(n_out):
            idx = int(round(i * src_fps / float(_FPS)))
            sel.append(frames[min(len(frames) - 1, max(0, idx))])
        h0, w0 = sel[0].shape[0], sel[0].shape[1]
        short = min(h0, w0)
        if short > _REF_VIDEO_SHORT_EDGE:
            scale = float(_REF_VIDEO_SHORT_EDGE) / float(short)
            nw = max(2, int(round(w0 * scale)) & ~1)
            nh = max(2, int(round(h0 * scale)) & ~1)
            sel = [cv2.resize(f, (nw, nh), interpolation=cv2.INTER_AREA) for f in sel]
        arr = np.stack([cv2.cvtColor(f, cv2.COLOR_BGR2RGB) for f in sel])
        arr = arr.astype(np.float32) / 255.0
        out.append(torch.from_numpy(arr))
    return out


def _load_ref_audios(names, warnings=None, shot_id="?"):
    """comfy_extras.nodes_audio.load -> {"waveform": [1,C,N], "sample_rate": int}。"""
    from comfy_extras.nodes_audio import load as _audio_load

    d = _input_dir()
    out = []
    for name in list(names or [])[:_REF_AUDIO_MAX]:
        p = os.path.join(d, str(name))
        if not os.path.isfile(p):
            raise ValueError("参考音频不存在: %s (input 目录 %s)" % (name, d))
        waveform, sample_rate = _audio_load(p)
        if waveform.dim() == 2:
            waveform = waveform.unsqueeze(0)
        out.append({"waveform": waveform, "sample_rate": int(sample_rate)})
    return out


def _assemble_plan(timeline_data, gen_w, gen_h, window_frames, context_frames, ffn_chunks,
                   pass2, upscale, final_wh, pass2_steps, pass2_sigma, steps, solver,
                   shift_video, shift_audio, handoff, strict, tile_size=512,
                   total_frames=124, template_raw=None):
    """docs/80 §3.2：内存里组 plan dict 并 validate，全程不落盘。"""
    _, _, plan_mod = _load_dsd()
    try:
        tl = json.loads(timeline_data or "{}")
    except Exception as exc:
        raise ValueError("timeline_data 不是合法 JSON: %s" % (exc,))
    if not isinstance(tl, dict):
        raise ValueError("timeline_data 必须是 JSON 对象")
    tl_shots = tl.get("shots") or []
    if not isinstance(tl_shots, list):
        raise ValueError("timeline_data.shots 必须是数组")

    if template_raw is not None:
        raw = json.loads(json.dumps(template_raw))
    else:
        raw = {}
    raw.setdefault("schema", "dsd-shots/1")
    raw["id"] = "inline"

    canvas = raw.setdefault("canvas", {})
    canvas["gen"] = [int(gen_w), int(gen_h)]
    canvas["final"] = [int(final_wh[0]), int(final_wh[1])]

    render = raw.setdefault("render", {})
    render["window_frames"] = int(window_frames)
    render["context_frames"] = int(context_frames)
    render["fps"] = _FPS
    render["handoff"] = str(handoff)
    render["seam_min"] = 0.1
    render["steps"] = int(steps)
    render["vae_tile"] = 0
    render["decode_shifts"] = ""
    render["shift_video"] = float(shift_video)
    render["shift_audio"] = float(shift_audio)
    render["solver"] = str(solver)
    render["ffn_chunks"] = int(ffn_chunks)
    render["pass2"] = bool(pass2)
    render["pass2_model"] = _UPSCALER
    render["pass2_steps"] = int(pass2_steps)
    render["pass2_sigma"] = float(pass2_sigma)
    render["pass2_size"] = [int(final_wh[0]), int(final_wh[1])]
    render["total_frames"] = int(total_frames)
    render["tile_size"] = int(tile_size)
    render["upscale"] = str(upscale)

    if tl_shots:
        shots = []
        for i, s in enumerate(tl_shots):
            if not isinstance(s, dict):
                raise ValueError("timeline_data.shots[%d] 必须是对象" % i)
            sid = str(s.get("id") or ("s%d" % (i + 1)))
            refs = [str(x) for x in (s.get("refs") or [])]
            vids = [str(x) for x in (s.get("refVideos") or [])]
            auds = [str(x) for x in (s.get("refAudios") or [])]
            if len(refs) > _REF_IMAGE_MAX:
                raise ValueError("shots[%s].refs 最多 %d 张，收到 %d" % (sid, _REF_IMAGE_MAX, len(refs)))
            if len(vids) > _REF_VIDEO_MAX:
                raise ValueError("shots[%s].refVideos 最多 %d 段，收到 %d" % (sid, _REF_VIDEO_MAX, len(vids)))
            if len(auds) > _REF_AUDIO_MAX:
                raise ValueError("shots[%s].refAudios 最多 %d 段，收到 %d" % (sid, _REF_AUDIO_MAX, len(auds)))
            secs = s.get("seconds")
            secs = (124 / 24.0) if secs in (None, "") else float(secs)
            me = s.get("motionExpect", s.get("motion_expect", 1.0))
            shot = {
                "id": sid,
                "seconds": secs,
                "prompt": str(s.get("prompt") or ""),
                "refs": refs,
                "refVideos": vids,
                "refAudios": auds,
                "motion_expect": float(1.0 if me is None else me),
                "seed": None if s.get("seed") is None else int(s["seed"]),
                "note": str(s.get("note") or ""),
            }
            # Per-shot sampling overrides ride through untouched: the whitelist
            # and the range check belong to plan.validate_shot_overrides, so a
            # bad value fails there with E_SHOT_OVERRIDE instead of a bare
            # ValueError here.  A shot without overrides gains no key at all,
            # which keeps every existing plan dict byte-identical.
            _ovr = s.get("overrides")
            if _ovr:
                shot["overrides"] = _ovr
            shots.append(shot)
        raw["shots"] = shots
    else:
        if not raw.get("shots"):
            raw["shots"] = [dict(_DEFAULT_SHOT)]

    raw["min_chars"] = 3000 if strict else 0
    return plan_mod.validate_plan(raw, min_chars=None if strict else 0)


class DSDDirector:
    """导演台一键长片：数据源在节点内联（timeline_data），不落盘 plan。

    与 T8 双采链的区别：不经过任何 T8 节点，采样用官方
    comfy.sample.sample_custom + 本包的双时钟 Euler，条件用官方
    MiniMaxH3ReferenceToVideo，解码用分块 VAE。

    widget 表见 docs/81-widget-contract.md（required 8 + optional 31，逐位冻结）。
    timeline_data 是镜头真相源（docs/80 §3.1）；plan_path 非空时只当模板导入。
    参考素材三路（图/视频/音频）都按 ComfyUI input 目录里的文件名解析。
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "model": ("MODEL",),
                "clip": ("CLIP",),
                "video_vae": ("VAE",),
                "audio_vae": ("VAE",),
                "seed": ("INT", {"default": 2609198601, "min": 0, "max": 0xFFFFFFFF,
                                 "control_after_generate": True}),
                "preset": (_PRESET_NAMES, {"default": "本机最优 2x"}),
                "strict": ("BOOLEAN", {"default": True}),
                "budget_gib": ("FLOAT", {"default": 7.9, "min": 1.0, "max": 16.0, "step": 0.1}),
            },
            "optional": {
                "bd_grp_shot": ("BDGROUP", {"default": "镜头"}),
                "timeline_data": ("STRING", {"default": _default_timeline(), "multiline": True}),
                "total_frames": ("INT", {"default": 124, "min": 5, "max": 100000}),
                "bd_grp_s2": ("BDGROUP", {"default": "采样"}),
                "steps": ("INT", {"default": 4, "min": 1, "max": 64}),
                "solver": (["euler", "exp2"], {"default": "euler"}),
                "shift_video": ("FLOAT", {"default": 12.0, "min": 1.0, "max": 64.0, "step": 0.1}),
                "shift_audio": ("FLOAT", {"default": 3.0, "min": 1.0, "max": 64.0, "step": 0.1}),
                "handoff": (["latent_prefix", "latent_prefix_ramp", "latent_prefix_anchor"],
                            {"default": "latent_prefix"}),
                "bd_grp_geo": ("BDGROUP", {"default": "几何与窗口"}),
                "gen_w": ("INT", {"default": 1376, "min": 128, "max": 8192, "step": 32}),
                "gen_h": ("INT", {"default": 768, "min": 128, "max": 8192, "step": 32}),
                "window_frames": ("INT", {"default": 124, "min": 124, "max": 362, "step": 17}),
                "context_frames": (["5", "22", "39"], {"default": "5"}),
                "ffn_chunks": ("INT", {"default": 4, "min": 1, "max": 64}),
                "tile_size": ("INT", {"default": 512, "min": 128, "max": 1024, "step": 64}),
                "bd_grp_decode": ("BDGROUP", {"default": "解码超采样"}),
                "pass2": ("BOOLEAN", {"default": True}),
                "upscale": (["1.0", "1.25", "1.5", "2.0"], {"default": "2.0"}),
                "final_w": ("INT", {"default": 0, "min": 0, "max": 8192, "step": 32}),
                "final_h": ("INT", {"default": 0, "min": 0, "max": 8192, "step": 32}),
                "pass2_steps": ("INT", {"default": 0, "min": 0, "max": 32}),
                "pass2_sigma": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 0.95, "step": 0.01}),
                "bd_grp_deliver": ("BDGROUP", {"default": "性能与交付"}),
                "out_w": ("INT", {"default": 2560, "min": 0, "max": 8192, "step": 1}),
                "out_h": ("INT", {"default": 1440, "min": 0, "max": 8192, "step": 1}),
                "unsharp": ("FLOAT", {"default": 0.8, "min": 0.0, "max": 2.0, "step": 0.05}),
                "export_mode": (["frames", "frames+report", "frames+timeline"],
                                {"default": "frames"}),
                "bd_grp_tpl": ("BDGROUP", {"default": "模板与内置常量"}),
                "plan_path": ("STRING", {"default": ""}),
                "builtin_note": ("STRING", {
                    "default": ("24fps | audio 40Hz | time ratio 5:3 | canvas %32 | "
                                "window 17k+5 | vae_tile 0 | decode_shifts empty | "
                                "partial_start 0 | seam_min 0.1"),
                    "multiline": True}),
            },
            "hidden": {"unique_id": "UNIQUE_ID"},
        }

    RETURN_TYPES = ("IMAGE", "AUDIO", "STRING", "FLOAT", "STRING")
    RETURN_NAMES = ("images", "audio", "report_json", "seconds", "summary")
    FUNCTION = "render"
    CATEGORY = "dsd/director"

    def render(self, model, clip, video_vae, audio_vae, seed, preset, strict, budget_gib,
               bd_grp_shot="镜头", timeline_data=None, total_frames=124,
               bd_grp_s2="采样", steps=4, solver="euler",
               shift_video=12.0, shift_audio=3.0, handoff="latent_prefix",
               bd_grp_geo="几何与窗口", gen_w=1376, gen_h=768,
               window_frames=124, context_frames="5", ffn_chunks=4, tile_size=512,
               bd_grp_decode="解码超采样", pass2=True,
               upscale="2.0", final_w=0, final_h=0,
               pass2_steps=0, pass2_sigma=0.0,
               bd_grp_deliver="性能与交付", out_w=2560, out_h=1440,
               unsharp=0.8, export_mode="frames",
               bd_grp_tpl="模板与内置常量", plan_path="", builtin_note="",
               unique_id=None):
        import time
        executor, handoff_mod, plan_mod = _load_dsd()

        warnings, logs, applied = [], [], []
        if timeline_data is None or str(timeline_data).strip() == "":
            timeline_data = _default_timeline()

        # ---- A3：进度回调（render 段占 0-90%，交付段 90-100%）----
        node_id = str(unique_id) if unique_id not in (None, "", "None") else "0"
        if node_id == "0":
            warnings.append("unique_id 不可用，dsd_progress 事件以 node=0 发出")
        try:
            from server import PromptServer
            _srv = PromptServer.instance
        except Exception as exc:
            _srv = None
            warnings.append("PromptServer 不可用（%s），本次不发送 dsd_progress" % (exc,))

        def _send(pct, phase, seg, segs, note):
            if _srv is None:
                return
            try:
                _srv.send_sync("dsd_progress", {
                    "node": node_id, "pct": int(pct), "phase": str(phase),
                    "seg": int(seg), "segs": int(segs), "note": str(note),
                })
            except Exception:
                pass

        def _progress(info):
            try:
                pct = int(round(float(info.get("pct", 0.0)) * 0.9))
                _send(pct, info.get("phase", "sample"), info.get("seg", 0),
                      info.get("segs", 0), info.get("note", ""))
            except Exception:
                pass

        # ---- 预设（docs/81 预设表）----
        preset_name = str(preset)
        gw, gh = int(gen_w), int(gen_h)
        up = str(upscale)
        ow, oh = int(out_w), int(out_h)
        sharp = float(unsharp)
        # 预设是「一键填表」而不是「锁死」：widget 才是唯一真相源。
        # 面板点预设时会把整套参数写进 widget，所以这里只做两件事——
        # 记录命中的是哪个预设（给墙钟估算用），以及提醒用户预设与当前值已不一致。
        if preset_name in _PRESETS:
            p = _PRESETS[preset_name]
            same = ((int(gen_w), int(gen_h)) == (int(p["gen"][0]), int(p["gen"][1]))
                    and str(upscale) == str(p["upscale"])
                    and (int(out_w), int(out_h)) == (int(p["out"][0]), int(p["out"][1]))
                    and abs(float(unsharp) - float(p["unsharp"])) < 1e-6)
            applied.append("preset:%s%s" % (preset_name, "" if same else "(overridden)"))
            if not same:
                warnings.append("preset=%s 只是推荐值；当前 gen/upscale/out/unsharp 已被手动改成 "
                                "gen=%dx%d upscale=%s out=%dx%d unsharp=%.2f，按手动值执行"
                                % (preset_name, int(gen_w), int(gen_h), str(upscale),
                                   int(out_w), int(out_h), float(unsharp)))
        elif preset_name != "自定义":
            warnings.append("未知 preset=%r，按自定义处理" % preset_name)

        if gw % 32 or gh % 32:
            raise ValueError("gen_w/gen_h 必须是 32 的倍数，收到 %dx%d" % (gw, gh))

        mult = float(up)
        if int(final_w) > 0 and int(final_h) > 0:
            final = [int(final_w), int(final_h)]
            final_src = "explicit"
        else:
            final = [_align32(gw * mult), _align32(gh * mult)]
            final_src = "auto(gen*%s, align32)" % up

        # 预设是整套几何，final 也必须跟着走：否则切换预设后会留下上一档的
        # final（例如 2x 的 2752x1536）配 1.5x 的 gen，画布被放大 2 倍。
        if preset_name in _PRESETS:
            auto = [_align32(gw * mult), _align32(gh * mult)]
            if abs(final[0] - auto[0]) > 32 or abs(final[1] - auto[1]) > 32:
                warnings.append("preset=%s 的 final %r 与按倍数推算的 %r 相差超过 32px，"
                                "已改用推算值（避免切换预设后残留上一档几何）"
                                % (preset_name, list(final), list(auto)))
                final = auto
                final_src = "auto(preset*%s, align32)" % up
        if final[0] % 32 or final[1] % 32:
            warnings.append("final %dx%d 不是 32 的倍数，latent 上采样会按 //16 取整，"
                            "实际尺寸可能偏离（建议改成 %dx%d）"
                            % (final[0], final[1], _align32(final[0]), _align32(final[1])))

        ctx = int(str(context_frames))
        if int(pass2) and not (final[0] > gw and final[1] > gh):
            warnings.append("pass2=True 要求 canvas.final 严格大于 canvas.gen，"
                            "已自动关闭 pass2（final=%r gen=%r）" % (final, [gw, gh]))
            pass2 = False

        if str(solver) not in ("euler", "exp2"):
            raise ValueError("solver %r 不在 ['euler','exp2'] 里" % (solver,))
        if str(handoff) not in handoff_mod.HANDOFF_MODES:
            raise ValueError("handoff %r 不在 %s 里" % (handoff, handoff_mod.HANDOFF_MODES))

        # ---- A1：模板（plan_path 非空）或纯内联 ----
        template_raw = None
        pp = str(plan_path or "").strip()
        if pp:
            base = os.environ.get("DSD_PROJECT_ROOT") or os.path.join(
                os.path.expanduser("~"), "Documents", "deepseek-harness",
                "default-workspace", "film-pipeline")
            path = pp if os.path.isabs(pp) else os.path.join(base, pp)
            if not os.path.isfile(path):
                raise ValueError("plan_path 指向的模板不存在: %s" % path)
            with open(path, "r", encoding="utf-8") as fh:
                template_raw = json.load(fh)
            plan_source = "template:%s" % path
        else:
            path = ""
            plan_source = "inline"

        plan = _assemble_plan(
            timeline_data, gw, gh, int(window_frames), ctx, int(ffn_chunks),
            bool(pass2), up, final, int(pass2_steps), float(pass2_sigma),
            int(steps), str(solver), float(shift_video), float(shift_audio),
            str(handoff), bool(strict), tile_size=int(tile_size),
            total_frames=int(total_frames), template_raw=template_raw,
        )

        # ---- 提交前体检（src/dsd/preflight.py）：只提示、不阻断渲染 ----
        _pf = None
        _pf_txt = ""
        try:
            from dsd.preflight import preflight as _pf_run, preflight_text as _pf_text
            try:
                _pf_dir = _input_dir()
            except Exception:
                _pf_dir = None
            _pf = _pf_run(plan.raw, input_dir=_pf_dir, strict=True)
            for _it in (_pf.get("errors") or []):
                warnings.append("preflight[E] %s %s（%s）" % (
                    _it.get("where", "?"), _it.get("message", ""), _it.get("code", "?")))
            for _it in (_pf.get("warnings") or []):
                warnings.append("preflight[W] %s %s（%s）" % (
                    _it.get("where", "?"), _it.get("message", ""), _it.get("code", "?")))
            try:
                _pf_txt = _pf_text(plan.raw, input_dir=_pf_dir, strict=True)
            except Exception:
                _pf_txt = ""
        except Exception as _exc:
            warnings.append("preflight 体检失败（不影响渲染）: %r" % (_exc,))
        # ---- A2：三路参考素材，全部按 ComfyUI input 目录文件名解析 ----
        shot_raws = plan.raw.get("shots") or []
        img_names, vid_names, aud_names = [], [], []
        for s in shot_raws:
            for n in (s.get("refs") or []):
                if n not in img_names:
                    img_names.append(n)
            for n in (s.get("refVideos") or []):
                if n not in vid_names:
                    vid_names.append(n)
            for n in (s.get("refAudios") or []):
                if n not in aud_names:
                    aud_names.append(n)

        ref_images = _load_ref_images(img_names, warnings)
        ref_videos = _load_ref_videos(vid_names, warnings)
        ref_audios = _load_ref_audios(aud_names, warnings)
        if not (ref_images or ref_videos or ref_audios):
            raise ValueError("至少需要一张参考图或一段参考视频")
        references = {"images": ref_images, "videos": ref_videos, "audios": ref_audios}

        started = time.time()
        _send(0, "start", 0, 0, "plan %d 镜" % len(plan.shots))
        result = executor.run_plan(
            plan, model, clip, video_vae, audio_vae,
            references=references, seed=seed, budget_gib=budget_gib,
            log=lambda m: logs.append(m),
            tile_size=int(tile_size),
            progress=_progress,
        )
        frames = result.images
        nseg = len(result.report.get("segments", []))

        # ---- 交付层：只在节点内做，不写 plan ----
        if sharp > 0.0:
            _send(90, "unsharp", 0, nseg, "unsharp %.2f" % sharp)
            frames = _unsharp5(frames, sharp)
        tw, th = int(ow), int(oh)
        if tw > 0 and th > 0:
            h0, w0 = int(frames.shape[1]), int(frames.shape[2])
            if (tw, th) != (w0, h0):
                _send(95, "resize", 0, nseg, "%dx%d -> %dx%d" % (w0, h0, tw, th))
                import torch.nn.functional as _F
                _x = frames.permute(0, 3, 1, 2)
                _x = _F.interpolate(_x, size=(th, tw), mode="bicubic",
                                    align_corners=False, antialias=True)
                frames = _x.permute(0, 2, 3, 1).contiguous().clamp_(0.0, 1.0)
        _send(100, "done", 0, nseg, "%d 帧" % int(frames.shape[0]))

        elapsed = time.time() - started
        report = dict(result.report)
        report["seconds"] = round(elapsed, 1)
        report["plan_source"] = plan_source
        report["plan_path"] = path
        report["handoff"] = plan.handoff
        report["logs"] = logs[-40:]
        report["warnings"] = warnings
        report["refs"] = {"images": len(ref_images), "videos": len(ref_videos),
                          "audios": len(ref_audios)}
        report["override"] = {
            "plan_written": False,
            "plan_source": plan_source,
            "preset": preset_name,
            "total_frames": int(total_frames),
            "solver": str(solver),
            "shift_video": float(shift_video),
            "shift_audio": float(shift_audio),
            "gen": [gw, gh],
            "final": [int(x) for x in final],
            "final_source": final_src,
            "upscale": mult,
            "window_frames": int(window_frames),
            "context_frames": ctx,
            "ffn_chunks": int(ffn_chunks),
            "pass2": bool(pass2),
            "pass2_model": _UPSCALER,
            "pass2_steps": int(pass2_steps),
            "pass2_sigma": float(pass2_sigma),
            "steps": int(getattr(plan, "steps", 4)),
            "tile_size": int(tile_size),
            "out": [int(ow), int(oh)],
            "unsharp": sharp,
            "export_mode": str(export_mode),
            "node_only": ["out_w", "out_h", "unsharp", "export_mode"],
            "applied": applied,
            "preflight": {"ok": bool(_pf.get("ok")) if isinstance(_pf, dict) else None,
                            "text": _pf_txt},
        }
        # ---- 时间线导出：只在 frames+timeline 时落盘，失败不影响成片 ----
        if str(export_mode) == "frames+timeline":
            try:
                _exp = _write_timeline_exports(plan, report.get("segments") or [])
                report["exports"] = list(_exp)
                for _pth in _exp:
                    _send(99, "export", 0, nseg, _pth)
                logs.append("[DSD] timeline export -> " + ", ".join(_exp))
            except Exception as _exc:
                warnings.append("时间线导出失败: %r" % (_exc,))
                print("[DSD] timeline export failed: %r" % (_exc,))
            report["logs"] = logs[-40:]

        summary = "dsd: %d 段 %d 帧 %.1fs 用时 %.1fmin handoff=%s steps=%d pass=%d" % (
            nseg, int(frames.shape[0]),
            int(frames.shape[0]) / 24.0, elapsed / 60.0, plan.handoff,
            int(getattr(plan, "steps", 4)), 1)
        print("[DSD] " + summary)
        return (frames, result.audio, json.dumps(report, ensure_ascii=False),
                float(elapsed), summary)


NODE_CLASS_MAPPINGS = {"DSDPlanInspector": DSDPlanInspector, "DSDShotPrompt": DSDShotPrompt, "DSDResourceHub": DSDResourceHub, "DSDDecodeAV": DSDDecodeAV, "DSDDirector": DSDDirector}
NODE_DISPLAY_NAME_MAPPINGS = {"DSDPlanInspector": "DSD Plan Inspector (导演台·计划校验)", "DSDShotPrompt": "DSD Shot Prompt (导演台·镜头提示词)", "DSDResourceHub": "DSD Resource Hub (导演台·资源引用)", "DSDDecodeAV": "DSD AV Decode Tiled (导演台·分块解码)", "DSDDirector": "DSD Director (导演台·一键长片)"}
