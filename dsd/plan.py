"""DSD plan validation (dsd-shots/1). Pure stdlib, no torch, no comfy imports.

Every rule here is a hard requirement measured somewhere in docs/26..30:
- window_frames % 17 == 5        (frame_grid.align17, h3_t8/frame_grid.py)
- 124 <= window <= 362           (MIN/MAX_TRAINED_FRAMES, frame_grid.py:4 & core.py:23)
- context_frames in {5,22,39}    (CONTEXT_FRAME_STEPS, long_video.py:58)
- prompt length >= min_chars     (R6, docs/26)
- budget estimate <= max_gib     (R5)
"""
from __future__ import annotations

import json
import math
import sys
from dataclasses import dataclass, field
from typing import Any

from .handoff import HANDOFF_MODES

FPS = 24
MIN_TRAINED_FRAMES = 124
MAX_TRAINED_FRAMES = 362
CONTEXT_FRAME_STEPS = (5, 22, 39)

# VRAM model fitted on measured anchors (docs/30 section 3):
#   peak_gib ~= BASE + K * frames * W * H / 1e6, 1 reference image
VRAM_BASE_GIB = 6.23
VRAM_K_GIB_PER_MPXFRAME = 0.0038
# each additional reference image beyond the first costs this much (measured: 3ref - 1ref = 1.2 GiB)
VRAM_EXTRA_REF_GIB = 0.60


class PlanError(ValueError):
    """Raised for any plan that violates a hard rule. Message carries the code."""

    def __init__(self, code: str, message: str, hint: str = ""):
        self.code = code
        self.hint = hint
        super().__init__(f"{code}: {message}" + (f" (hint: {hint})" if hint else ""))


def align17(n: int) -> int:
    """Smallest value >= n on the 17k+5 grid."""
    n = int(n)
    if n < 5:
        return 5
    r = n % 17
    return n + (5 - r) % 17


def estimate_peak_gib(frames: int, width: int, height: int, ref_count: int) -> float:
    """Rough peak VRAM for one segment (docs/30 section 3). Deliberately conservative."""
    base = VRAM_BASE_GIB + VRAM_K_GIB_PER_MPXFRAME * frames * width * height / 1e6
    return base + VRAM_EXTRA_REF_GIB * max(0, ref_count - 1)


@dataclass
class Shot:
    id: str
    seconds: float
    prompt: str
    refs: list[str] = field(default_factory=list)
    motion_expect: float = 1.0
    seed: int | None = None
    note: str = ""
    # Per-shot sampling overrides.  Only SHOT_OVERRIDE_KEYS may appear; an
    # unknown key or an out-of-range value raises E_SHOT_OVERRIDE instead of
    # being ignored, because a silently dropped typo renders at the wrong cost
    # and nobody notices until the film is out.  {} = inherit the plan/widget
    # value, which is the legacy path and must stay bit-identical.
    overrides: dict[str, Any] = field(default_factory=dict)

    @property
    def visible_frames(self) -> int:
        return align17(round(self.seconds * FPS))


@dataclass
class Plan:
    schema: str
    canvas_gen: tuple[int, int]
    canvas_final: tuple[int, int]
    window_frames: int
    context_frames: int
    handoff: str
    seam_min: float
    shots: list[Shot]
    max_gib: float
    max_hours: float
    min_chars: int
    # Number of model evaluations per segment (single pass).  The T8 chain ran
    # coarse 4 + refine 4 = 8 NFE across two model passes; this executor runs
    # ONE pass, so a controlled NFE comparison needs steps=8 here.
    steps: int = 4
    # >1 chunks the SwiGLU FFN over packed tokens (exact, lowers peak VRAM).
    ffn_chunks: int = 1
    # "euler" = the tangent rule (O(dsigma) error).  "exp2" reconstructs x0
    # linearly in sigma across the last two steps and integrates that in
    # closed form: SAME NFE, O(dsigma^2) error.  See sampling.dual_clock_exp2.
    solver: str = "euler"
    # Flow-matching sigma-shift pair.  The distilled 4-step chain was tuned
    # around (12, 3); on a 4-step grid shift=12 spends three of four steps
    # below sigma 0.95 (native_flow_sigmas(4, 12) = 1, .973, .923, .800, 0),
    # so a lower shift re-spends the same NFE at high sigma.  See docs/67.
    shift_video: float = 12.0
    shift_audio: float = 3.0
    pass2: bool = False
    pass2_model: str = ""
    pass2_steps: int = 0
    pass2_sigma: float = 0.0
    partial_start: float = 0.0
    vae_tile: int = 0
    # Multi-phase decode: comma separated 'dx,dy' latent-pixel shifts.
    # Each phase decodes the same latent rolled by (dx,dy) and the decoded
    # frames are rolled back and averaged, which cancels part of the per-token
    # DC step that unpatchify leaves behind (docs/70). Empty = single decode.
    decode_shifts: str = ""
    # Frames dropped from the END of every non-final segment.  A handoff
    # continuation spends its final rows re-encoding the incoming context, so
    # motion decays to 28-43% of the segment median over the last 6-12 frames
    # (docs/64).  Those frames are re-rendered as the head of the next window,
    # so dropping them buys real motion back for tail_trim/(window-ctx)
    # extra segments.
    tail_trim: int = 0
    acceptance: dict[str, Any] = field(default_factory=dict)
    raw: dict[str, Any] = field(default_factory=dict)

    @property
    def segment_capacity(self) -> int:
        """Frames a non-first segment can add: window - context (orchestration.py:266-270)."""
        return self.window_frames - self.context_frames

    def shot_split_report(self) -> dict[str, Any]:
        """Which shots cannot fit in one segment and must therefore be split.

        This matters because the renderer takes ONE prompt per segment: a shot that
        spans two segments gets its prompt truncated at the seam, which is exactly the
        semantic re-start (docs/28 T1) we are trying to avoid. Such a plan is accepted
        but flagged so the caller can shorten the shot or raise window_frames.
        """
        cap = self.segment_capacity
        split = []
        for i, sh in enumerate(self.shots):
            v = sh.visible_frames
            if v > cap:
                n = 1 + math.ceil((v - cap) / cap)
                split.append({
                    "shot_index": i,
                    "shot_id": sh.id,
                    "visible_frames": v,
                    "seconds": round(v / FPS, 3),
                    "capacity": cap,
                    "segments_needed": n,
                })
        return {
            "capacity": cap,
            "max_shot_seconds_for_one_segment": round(cap / FPS, 3),
            "split_shots": split,
        }

    def segment_plan(self) -> list[dict[str, Any]]:
        """Split shots into render segments.

        First segment keeps the full window; every later segment keeps
        window - context (long_video_orchestration.py:266-270).
        """
        out: list[dict[str, Any]] = []
        remaining: list[tuple[int, int]] = []  # (shot_index, frames_left)
        for i, s in enumerate(self.shots):
            remaining.append((i, s.visible_frames))

        timeline = 0
        index = 0
        while remaining:
            base = (self.window_frames if index == 0
                    else self.window_frames - self.context_frames)
            # tail_trim shrinks what a segment KEEPS, not what it renders:
            # the window still has to be built entirely, and the dropped tail
            # frames come back as the head of the next window.
            capacity = max(1, base - int(getattr(self, "tail_trim", 0)))
            new_frames = 0
            parts: list[dict[str, Any]] = []
            while remaining and new_frames < capacity:
                si, left = remaining[0]
                take = min(left, capacity - new_frames)
                parts.append({"shot": si, "take": take})
                new_frames += take
                if take == left:
                    remaining.pop(0)
                else:
                    remaining[0] = (si, left - take)
            out.append({
                "index": index,
                "start_frame": timeline,
                "new_frames": new_frames,
                "render_frames": self.window_frames,
                "context_frames": 0 if index == 0 else self.context_frames,
                "keep_frames": new_frames,
                "parts": parts,
                "is_final": not remaining,
            })
            timeline += new_frames
            index += 1
            if len(out) > 4096:  # runaway guard
                raise PlanError("E_PLAN_SCHEMA", "segment plan exceeded 4096 segments")
        return out


def _req(d: dict, key: str, code: str = "E_PLAN_SCHEMA"):
    if key not in d:
        raise PlanError(code, f"missing required field {key!r}")
    return d[key]


# --------------------------------------------------------------------------- #
# shot-level overrides
# --------------------------------------------------------------------------- #
# The five numbers a shot is allowed to disagree with the rest of the film on.
# Everything else (geometry, handoff, decode plan) is a whole-film decision:
# changing it mid-film changes the packed layout or the seam algebra.
SHOT_OVERRIDE_KEYS = ("steps", "solver", "shift_video", "shift_audio", "pass2_steps")
SHOT_OVERRIDE_SOLVERS = ("euler", "exp2")
# Range table: key -> (lo, hi).  Mirrors the Plan-level rules but with a
# tighter pass2 ceiling (0..16): a per-shot re-denoise above 16 steps costs
# more than the shot itself and is always a typo.
SHOT_OVERRIDE_RANGES = {"steps": (1, 64), "pass2_steps": (0, 16)}


def _ov_int(value: Any, key: str, lo: int, hi: int, where: str) -> int:
    try:
        v = int(value)
    except (TypeError, ValueError):
        raise PlanError("E_SHOT_OVERRIDE",
                        "%s.overrides.%s=%r 不是整数" % (where, key, value),
                        "给整数，例如 %s: %d" % (key, lo))
    if not (lo <= v <= hi):
        raise PlanError("E_SHOT_OVERRIDE",
                        "%s.overrides.%s=%d 超出范围 [%d,%d]" % (where, key, v, lo, hi),
                        "不覆盖就不要写这个键，不要用 0 占位")
    return v


def _ov_shift(value: Any, key: str, where: str) -> float:
    try:
        v = float(value)
    except (TypeError, ValueError):
        raise PlanError("E_SHOT_OVERRIDE",
                        "%s.overrides.%s=%r 不是数字" % (where, key, value),
                        "给 1..64 的浮点数，例如 12.0")
    if not (1.0 <= v <= 64.0):
        raise PlanError("E_SHOT_OVERRIDE",
                        "%s.overrides.%s=%r 超出范围 [1,64]" % (where, key, v),
                        "12 是蒸馏默认；4-8 在高 sigma 段重花 NFE")
    return v


def validate_shot_overrides(raw: Any, where: str = "shot") -> dict[str, Any]:
    """Whitelist + range check one shot's overrides.  {} means 'inherit'."""
    if raw is None:
        return {}
    if not isinstance(raw, dict):
        raise PlanError("E_SHOT_OVERRIDE",
                        "%s.overrides 必须是对象，收到 %s" % (where, type(raw).__name__),
                        '例如 "overrides": {"steps": 8, "shift_video": 8.0}')
    unknown = sorted(str(k) for k in raw if k not in SHOT_OVERRIDE_KEYS)
    if unknown:
        raise PlanError("E_SHOT_OVERRIDE",
                        "%s.overrides 含未知键 %s" % (where, ", ".join(unknown)),
                        "只支持 " + ", ".join(SHOT_OVERRIDE_KEYS))
    out: dict[str, Any] = {}
    for key in SHOT_OVERRIDE_KEYS:
        if key not in raw:
            continue
        val = raw[key]
        if val is None:
            continue          # null = 沿用节点级参数，不写进生效值
        if key in SHOT_OVERRIDE_RANGES:
            lo, hi = SHOT_OVERRIDE_RANGES[key]
            out[key] = _ov_int(val, key, lo, hi, where)
        elif key in ("shift_video", "shift_audio"):
            out[key] = _ov_shift(val, key, where)
        else:  # solver
            sv = str(val).strip().lower()
            if sv not in SHOT_OVERRIDE_SOLVERS:
                raise PlanError("E_SHOT_OVERRIDE",
                                "%s.overrides.solver=%r 不支持" % (where, val),
                                '用 "euler"（基线）或 "exp2"（二阶，同 NFE）')
            out[key] = sv
    return out


def base_params(plan: "Plan") -> dict[str, Any]:
    """The five sampling values a shot inherits from the plan."""
    return {
        "steps": int(getattr(plan, "steps", 4)),
        "solver": str(getattr(plan, "solver", "euler")),
        "shift_video": float(getattr(plan, "shift_video", 12.0)),
        "shift_audio": float(getattr(plan, "shift_audio", 3.0)),
        "pass2_steps": int(getattr(plan, "pass2_steps", 0)),
    }


def shot_overrides_effective(shot: "Shot", base: dict[str, Any]) -> dict[str, Any]:
    """base overlaid with shot.overrides; returns a new dict, never mutates base."""
    eff = dict(base)
    ov = getattr(shot, "overrides", None) or {}
    for key in SHOT_OVERRIDE_KEYS:
        if key in ov:
            eff[key] = ov[key]
    return eff


def _fmt_num(v: Any) -> str:
    f = float(v)
    return ("%.1f" % f) if f.is_integer() else ("%g" % f)


def override_brief(eff: dict[str, Any]) -> str:
    """One-line effective-parameter summary for progress / SRT / EDL.

    Always shows steps and both shifts (that is the cost and the look); shows
    solver and pass2_steps only when they moved off their defaults, so the
    common case stays readable in a subtitle cue.
    """
    parts = ["steps=%d" % int(eff.get("steps", 0))]
    sv = str(eff.get("solver", "euler"))
    if sv != "euler":
        parts.append("solver=%s" % sv)
    parts.append("shift=%s/%s" % (_fmt_num(eff.get("shift_video", 0.0)),
                                   _fmt_num(eff.get("shift_audio", 0.0))))
    p2 = int(eff.get("pass2_steps", 0) or 0)
    if p2:
        parts.append("p2=%d" % p2)
    return " ".join(parts)


def validate_plan(raw: dict[str, Any], min_chars: int | None = None) -> Plan:
    if not isinstance(raw, dict):
        raise PlanError("E_PLAN_SCHEMA", "plan must be a JSON object")
    schema = str(raw.get("schema", ""))
    if schema != "dsd-shots/1":
        raise PlanError("E_PLAN_SCHEMA", f"unsupported schema {schema!r}", "expected 'dsd-shots/1'")

    canvas = _req(raw, "canvas")
    gen = tuple(_req(canvas, "gen"))
    final = tuple(_req(canvas, "final"))
    if len(gen) != 2 or len(final) != 2:
        raise PlanError("E_PLAN_SCHEMA", "canvas.gen/final must be [w, h]")

    render = _req(raw, "render")
    window = int(_req(render, "window_frames"))
    ctx = int(_req(render, "context_frames"))

    if align17(window) != window:
        raise PlanError("E_WINDOW_GRID", f"window_frames={window} is not on the 17k+5 grid",
                        f"nearest lower {window - ((window - 5) % 17)}, nearest upper {align17(window)}")
    if not (MIN_TRAINED_FRAMES <= window <= MAX_TRAINED_FRAMES):
        raise PlanError("E_WINDOW_GRID",
                        f"window_frames={window} outside [{MIN_TRAINED_FRAMES}, {MAX_TRAINED_FRAMES}]")
    if ctx not in CONTEXT_FRAME_STEPS:
        raise PlanError("E_CTX_SET", f"context_frames={ctx} not in {CONTEXT_FRAME_STEPS}", "use 22")
    if ctx >= window:
        raise PlanError("E_CTX_SET", f"context_frames={ctx} >= window_frames={window}")

    handoff = str(render.get("handoff", "latent_prefix"))
    if handoff not in HANDOFF_MODES:
        raise PlanError("E_PLAN_SCHEMA", f"handoff={handoff!r} not in {HANDOFF_MODES}",
                        "use latent_prefix (default) or keyframe")
    steps = int(render.get("steps", 4))
    if not (1 <= steps <= 64):
        raise PlanError("E_PLAN_SCHEMA", f"render.steps={steps} must be within [1,64]",
                        "4 is the distilled default; 8 matches the T8 c4r4 NFE budget")
    ffn_chunks = int(render.get("ffn_chunks", 1))
    vae_tile = int(render.get("vae_tile", 0))
    decode_shifts = str(render.get("decode_shifts", "") or "").strip()
    _phases = []
    for _part in [p for p in decode_shifts.replace(";", ",").split(",") if p.strip()]:
        try:
            _v = int(_part.strip())
        except ValueError:
            raise PlanError("E_PLAN_SCHEMA", "render.decode_shifts entries must be integers (latent px)")
        if not (0 <= _v <= 15):
            raise PlanError("E_PLAN_SCHEMA", "render.decode_shifts values must be within [0,15] latent px")
        _phases.append(_v)
    if len(_phases) % 2:
        raise PlanError("E_PLAN_SCHEMA", "render.decode_shifts needs an even number of values (dx,dy pairs)")
    decode_shifts = ";".join("%d,%d" % (_phases[i], _phases[i + 1]) for i in range(0, len(_phases), 2))
    solver = str(render.get("solver", "euler")).strip().lower()
    shift_video = float(render.get("shift_video", 12.0))
    shift_audio = float(render.get("shift_audio", 3.0))
    if not (1.0 <= shift_video <= 64.0):
        raise PlanError("E_PLAN_SCHEMA",
                        "render.shift_video=%r must be within [1,64]" % shift_video,
                        "12 is the distilled default; 4-8 re-spends NFE at high sigma")
    if not (1.0 <= shift_audio <= 64.0):
        raise PlanError("E_PLAN_SCHEMA",
                        "render.shift_audio=%r must be within [1,64]" % shift_audio,
                        "3 is the distilled default")
    if vae_tile > 0:
        sys.stderr.write("[DSD] WARN render.vae_tile=%d overrides the clean default 0; "
                         "tile>0 puts a 16px patch grid and a 17-frame dark flash "
                         "into the decode (docs/66)\n" % vae_tile)
    pass2 = bool(render.get("pass2", False))
    pass2_model = str(render.get("pass2_model", "") or "")
    pass2_steps = int(render.get("pass2_steps", 0))
    pass2_sigma = float(render.get("pass2_sigma", 0.0))
    if not (0 <= pass2_steps <= 32):
        raise PlanError(
            "E_PLAN_SCHEMA",
            "render.pass2_steps=%d must be within [0,32]" % pass2_steps,
            "0 keeps the pure latent upscale; 3-4 re-injects detail")
    if not (0.0 <= pass2_sigma < 1.0):
        raise PlanError(
            "E_PLAN_SCHEMA",
            "render.pass2_sigma=%r must be within [0,1)" % pass2_sigma,
            "0.6-0.8 rebuilds detail without repainting the frame")
    partial_start = float(render.get("partial_start", 0.0))
    if not (0.0 <= partial_start < 1.0):
        raise PlanError("E_PLAN_SCHEMA",
                        "render.partial_start=%.3f must be within [0,1)" % partial_start,
                        "0 keeps the legacy sigma=1 restart; 0.6-0.8 is the SDEdit band")
    if pass2 and not (final[0] > gen[0] and final[1] > gen[1]):
        raise PlanError("E_PLAN_SCHEMA",
                        "render.pass2 needs canvas.final strictly bigger than canvas.gen (gen=%r final=%r)" % (gen, final),
                        "1280x704 gen -> 1376x768 final is the measured pair")
    if solver not in ("euler", "exp2"):
        raise PlanError("E_PLAN_SCHEMA", f"render.solver={solver!r} is not supported",
                        'use "euler" (baseline) or "exp2" (2nd-order, same NFE)')
    if not (0 <= vae_tile <= 2048):
        raise PlanError("E_PLAN_SCHEMA", "render.vae_tile=%d must be within [0,2048]" % vae_tile,
                        "0 keeps the model default (256px); 384 and 704 are the useful values at 1280x704")
    tail_trim = int(render.get("tail_trim", 0))
    if not (0 <= tail_trim <= 32):
        raise PlanError(
            "E_PLAN_SCHEMA",
            "render.tail_trim=%d must be within [0,32]" % tail_trim,
            "8 is the measured knee; 0 keeps the legacy full-window keep")
    if ctx > 0 and tail_trim >= window - ctx:
        raise PlanError(
            "E_PLAN_SCHEMA",
            "render.tail_trim=%d leaves no capacity (window-ctx=%d)" % (tail_trim, window - ctx),
            "keep tail_trim well below window-ctx")
    if not (1 <= ffn_chunks <= 64):
        raise PlanError("E_PLAN_SCHEMA", f"render.ffn_chunks={ffn_chunks} must be within [1,64]",
                        "1 disables chunking; 2-4 is the useful range at 704p")
    seam_min = float(render.get("seam_min", 0.10))
    if not (0.0 <= seam_min <= 1.0):
        raise PlanError("E_PLAN_SCHEMA", f"seam_min={seam_min} must be within [0,1]")

    budget = raw.get("budget", {}) or {}
    max_gib = float(budget.get("max_gib", 7.9))
    max_hours = float(budget.get("max_hours", 12.0))

    accept = raw.get("acceptance", {}) or {}
    need = min_chars if min_chars is not None else int(raw.get("min_chars", 3000))

    shots_raw = _req(raw, "shots")
    if not isinstance(shots_raw, list) or not shots_raw:
        raise PlanError("E_PLAN_SCHEMA", "shots must be a non-empty array")

    shots: list[Shot] = []
    shorts: list[str] = []
    for i, s in enumerate(shots_raw):
        if not isinstance(s, dict):
            raise PlanError("E_PLAN_SCHEMA", f"shots[{i}] must be an object")
        prompt = str(s.get("prompt", "") or "")
        if len(prompt) < need:
            shorts.append(f"shots[{i}].id={s.get('id', '?')} len={len(prompt)}/{need}")
        secs = float(_req(s, "seconds"))
        if secs <= 0:
            raise PlanError("E_PLAN_SCHEMA", f"shots[{i}].seconds must be > 0")
        vis = align17(round(secs * FPS))
        if vis < ctx:
            raise PlanError("E_PLAN_SCHEMA",
                            f"shots[{i}] visible_frames={vis} < context_frames={ctx}",
                            "either lengthen the shot or lower context_frames")

        refs = [str(x) for x in (s.get("refs") or [])]
        g = Shot(
            id=str(s.get("id", f"s{i + 1}")),
            seconds=secs,
            prompt=prompt,
            refs=refs,
            motion_expect=float(s.get("motion_expect", 1.0)),
            seed=None if s.get("seed") is None else int(s["seed"]),
            note=str(s.get("note", "")),
            overrides=validate_shot_overrides(s.get("overrides"), "shots[%d]" % i),
        )
        shots.append(g)
    if shorts:
        raise PlanError("E_PROMPT_SHORT", "prompt too short: " + "; ".join(shorts),
                        f"every shot needs >= {need} characters")

    plan = Plan(
        schema=schema,
        canvas_gen=(int(gen[0]), int(gen[1])),
        canvas_final=(int(final[0]), int(final[1])),
        window_frames=window,
        context_frames=ctx,
        handoff=handoff,
        seam_min=seam_min,
        shots=shots,
        max_gib=max_gib,
        max_hours=max_hours,
        min_chars=need,
        steps=steps,
        ffn_chunks=ffn_chunks,
        solver=solver,
        shift_video=shift_video,
        shift_audio=shift_audio,
        pass2=pass2,
        pass2_model=pass2_model,
        pass2_steps=pass2_steps,
        pass2_sigma=pass2_sigma,
        partial_start=partial_start,
        vae_tile=vae_tile,
        decode_shifts=decode_shifts,
        tail_trim=tail_trim,
        acceptance=accept,
        raw=raw,
    )

    # budget check on the widest segment with the largest ref count in the plan
    ref_max = max((len(s.refs) for s in shots), default=1) or 1
    peak = estimate_peak_gib(window, plan.canvas_gen[0], plan.canvas_gen[1], ref_max)
    if peak > max_gib:
        raise PlanError(
            "E_BUDGET",
            f"estimated peak {peak:.2f} GiB > budget {max_gib:.2f} GiB "
            f"(window={window}, canvas={plan.canvas_gen}, refs={ref_max})",
            "lower canvas.gen, reduce refs, or shorten window_frames",
        )

    # semantic sanity: segments must tile the timeline exactly
    total = sum(s.visible_frames for s in shots)
    tiled = sum(seg["new_frames"] for seg in plan.segment_plan())
    if total != tiled:
        raise PlanError("E_PLAN_SCHEMA", f"segment tiling {tiled} != total visible {total}")
    return plan


def load_plan(path: str, min_chars: int | None = None) -> Plan:
    with open(path, "r", encoding="utf-8") as f:
        raw = json.load(f)
    return validate_plan(raw, min_chars=min_chars)


def plan_summary(plan: Plan) -> dict[str, Any]:
    segs = plan.segment_plan()
    out = {
        "shots": len(plan.shots),
        "total_frames": sum(s.visible_frames for s in plan.shots),
        "duration_s": round(sum(s.visible_frames for s in plan.shots) / FPS, 3),
        "segments": len(segs),
        "window_frames": plan.window_frames,
        "context_frames": plan.context_frames,
        "handoff": plan.handoff,
        "peak_gib": round(estimate_peak_gib(
            plan.window_frames, plan.canvas_gen[0], plan.canvas_gen[1],
            max((len(s.refs) for s in plan.shots), default=1) or 1), 2),
        "estimated_hours": round(
            sum(s["new_frames"] for s in segs) / plan.window_frames * 0.27, 2),
        "max_shot_seconds_one_segment": plan.shot_split_report()["max_shot_seconds_for_one_segment"],
        "split_shots": plan.shot_split_report()["split_shots"],
    }
    _ov = {sh.id: sh.overrides for sh in plan.shots if sh.overrides}
    if _ov:
        out["shot_overrides"] = _ov
    return out
