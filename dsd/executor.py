"""DSD L2 executor: stateless plan -> frames/audio/report.

Only official ComfyUI surfaces are used (docs/27 sec.7 "copy, do not hang"):

  comfy.sample.sample_custom                   sampling entry point
  comfy.samplers.KSAMPLER                      wraps any sampler function
  comfy.model_sampling.ModelSamplingAV         dual-clock shift parameters
  comfy_extras.nodes_minimax_h3.MiniMaxH3ReferenceToVideo   reference conditioning
  comfy_extras.nodes_minimax_h3.MiniMaxH3AddGuide           keyframe anchor
  comfy_extras.nodes_minimax_h3._empty_av_latent            AV latent allocation
  comfy_extras.nodes_audio.vae_decode_audio                 audio decode

Verified constraint (docs/31 sec.3): official comfy has NO motion-context channel.
The T8 extension injects continuation prefixes through minimax_keyframes with an
extra key t8_long_video_frame_index that only h3_t8/long_video.py reads. Official
PackedLayout (comfy/ldm/minimax/model.py:405-425) consumes only
resolved_frame_index and latent. An officially supported continuation therefore
uses one of two mechanisms:

  keyframe      re-encode the previous segment tail as a keyframe anchor; this is
                exactly what MiniMaxH3AddGuide does (cond rows at frame index 0)
  latent_prefix pin the previous latent prefix as real pixels using the
                KSamplerX0Inpaint algebra (comfy/samplers.py:634):
                    x   = x*mask   + latent_image*(1-mask)
                    out = out*mask + latent_image*(1-mask)
                H3 denoise_mask only pins the per-row timestep label
                (comfy/ldm/minimax/model.py:84), not the pixels.
"""
from __future__ import annotations

import json
import os
import time
from dataclasses import dataclass, field
from typing import Any, Callable

import torch

from .handoff import (HANDOFF_MODES, RAMP_VALUES, audio_latent_t, handoff_spec,
                      video_latent_steps, video_latent_t)
from .sampling import FPS as _AUDIO_FPS  # 24; video frames <-> audio seconds

# A continuation re-renders the overlap span, so its decoded loudness must agree
# with the previous segment's; vae_decode_audio normalises each call on its own
# (comfy_extras/nodes_audio.py:99-113).  Measured disagreement across real seams
# stayed within +/-6 dB, so bound the correction there rather than trusting a
# silent or near-empty overlap.
_GAIN_ALIGN_MIN = 0.5
_GAIN_ALIGN_MAX = 2.0
from .plan import (Plan, PlanError, base_params, override_brief,
                    shot_overrides_effective)

SEAM_RELEASE_TICKS = 8
def _fade(len_: int, curve: str, like):
    """Blend weights for an overlap of len_ samples, as (fade_out, fade_in).

    The two sides of a continuation overlap are the SAME span of time rendered
    twice, so they are strongly correlated.  A linear pair (w, 1-w) reconstructs
    that span exactly when the two renders agree (1.0*(1-w) + 1.0*w == 1.0), which
    is what keeps the level flat.  Equal-power (cos/sin) is offered for
    uncorrelated material, where it preserves RMS instead but would add up to
    +3 dB on correlated content.
    """
    import torch
    t = torch.linspace(0.0, 1.0, len_, device=like.device, dtype=like.dtype)
    if curve == "equal_power":
        half_pi = 1.5707963267948966
        return torch.cos(t * half_pi), torch.sin(t * half_pi)
    return 1.0 - t, t


def stitch_audio(blobs, context_frames: int, fps: float = _AUDIO_FPS,
                 align_gain: bool = True) -> dict | None:
    """Concatenate per-segment audio into ONE {"waveform", "sample_rate"} dict.

    A continuation segment re-renders the previous context_frames of video, so its
    decoded audio repeats that same span of time.  That repeat must not stay in the
    timeline (it would double the seam audio length and drift lip-sync by
    context_frames/fps seconds per seam), and it must not simply be cut either:
    dropping it hard leaves a level step wherever the two renders disagree in gain,
    which measured -7.2 dB across one seam because vae_decode_audio normalises each
    call independently (comfy_extras/nodes_audio.py:99-113).  So the repeated span
    is crossfaded out while the incoming one fades in, keeping the total length
    identical to a hard drop.

    Total samples per segment after the first: len(seg) - drop, where drop =
    round(context_frames / fps * rate).  Callers rely on that for A/V alignment.

    The repeat span is the SAME audio rendered twice, which makes it the one place
    the two segments can be compared directly: differing loudness there is a gain
    disagreement, not content.  So the incoming segment is scaled to match the
    outgoing tail's RMS (bounded by _GAIN_ALIGN_MIN/MAX) before the repeat is cut.

    SaveAudio needs a single dict (comfy_api/latest/_ui.py:286 reads
    audio["waveform"]), not a per-segment list, so the stitching lives here rather
    than in the node.
    """
    if not blobs:
        return None
    import torch
    out = None
    rate = None
    for idx, blob in enumerate(blobs):
        if isinstance(blob, dict):
            wave = blob["waveform"]
            if rate is None:
                rate = int(blob.get("sample_rate", 44100))
        else:
            wave = blob
        if rate is None:
            rate = 44100
        wave = wave.reshape(1, -1) if wave.dim() == 1 else wave
        if out is None:
            out = wave
            continue
        if wave.dim() != out.dim():
            wave = wave.reshape(1, -1)
        # align channel counts (mono segment against a stereo run or vice versa);
        # mixing them would blow up torch.cat on dim -1.
        if int(wave.shape[-2]) != int(out.shape[-2]):
            if int(out.shape[-2]) == 1:
                out = out.expand(-1, int(wave.shape[-2]), -1)
            elif int(wave.shape[-2]) == 1:
                wave = wave.expand(-1, int(out.shape[-2]), -1)
            else:
                ch = min(int(wave.shape[-2]), int(out.shape[-2]))
                wave = wave[..., :ch, :]
                out = out[..., :ch, :]
        drop = int(round(float(context_frames) / float(fps) * float(rate)))
        drop = min(drop, int(wave.shape[-1]), int(out.shape[-1]))
        if drop <= 1:
            out = torch.cat([out, wave], dim=-1)
            continue
        head = wave[..., :drop]
        tail = out[..., out.shape[-1] - drop:]
        if tail.shape != head.shape:
            out = torch.cat([out[..., :out.shape[-1] - drop], wave[..., drop:]], dim=-1)
            continue
        # Gain-align, then drop hard.  Blending the overlap was tried and MEASURABLY
        # WORSE: the two renders of the repeat span are the same content, so a linear
        # crossfade makes them partially cancel and digs a hole (-9.55 dB below both
        # neighbours across the 22-tick overlap, vs -2.63 dB for the plain drop).
        # The real defect is a gain disagreement, so correct that and cut once.
        if align_gain:
            tail_rms = float(tail.to(torch.float32).pow(2).mean().sqrt()) + 1e-9
            head_rms = float(head.to(torch.float32).pow(2).mean().sqrt()) + 1e-9
            ratio = tail_rms / head_rms
            ratio = min(max(ratio, _GAIN_ALIGN_MIN), _GAIN_ALIGN_MAX)
            wave = wave * ratio
        # The repeat lives at the START of the incoming segment, so keep all of
        # `out` and append only what follows it.  Trimming `out` here as well would
        # drop the span twice and break the length contract.
        out = torch.cat([out, wave[..., drop:]], dim=-1)
    return {"waveform": out, "sample_rate": int(rate)}


def _slice_audio(blob, frames: int, fps: float = _AUDIO_FPS):
    """Keep the first `frames` video frames worth of a segment audio blob."""
    if blob is None or int(frames) <= 0:
        return blob
    try:
        import torch  # noqa: F401
    except Exception:
        return blob
    wave = blob["waveform"] if isinstance(blob, dict) else blob
    rate = int(blob.get("sample_rate", 44100)) if isinstance(blob, dict) else 44100
    want = int(round(float(frames) / float(fps) * float(rate)))
    have = int(wave.shape[-1])
    if want >= have:
        return blob
    cut = wave[..., :want]
    if isinstance(blob, dict):
        out = dict(blob)
        out["waveform"] = cut
        return out
    return cut

def apply_ffn_chunking(model, chunks: int, seq_threshold: int = 4096):
    """Chunk the H3 SwiGLU feedforward over the packed token dim.

    Why this exists: at 704p the 8-step window OOMs inside
    comfy_kitchen.int8_linear, not inside attention.  fc1 expands the token
    dim by 2*ffn = 28672, so the fp16 fc1 activation of a 175-frame 704p
    window alone is ~2.6 GiB.  Tokens are independent rows and comfy quantizes
    int8 activations per row, so splitting the rows is numerically exact -- the
    fused INT8 kernel still runs, just on smaller batches.  Same mechanism as
    KJNodes minimax_mlp_chunked_forward, reimplemented here so the delivery path
    does not depend on a third-party node pack.
    """
    if int(chunks) <= 1:
        return model
    import types
    import comfy.ops

    def _chunked_forward(self, x):
        if x.shape[0] > seq_threshold:
            out = torch.empty_like(x)
            offset = 0
            for chunk in torch.chunk(x, int(chunks), dim=0):
                out[offset:offset + chunk.shape[0]] = comfy.ops.linear_input_act(
                    self.fc2, self.fc1(chunk), "swiglu")
                offset += chunk.shape[0]
            return out
        return comfy.ops.linear_input_act(self.fc2, self.fc1(x), "swiglu")

    patched = model.clone()
    diffusion = patched.get_model_object("diffusion_model")
    blocks = list(getattr(diffusion, "blocks", []) or [])
    if not blocks:
        return model
    for idx, block in enumerate(blocks):
        mlp = getattr(block, "mlp", None)
        if mlp is None or not hasattr(mlp, "fc1"):
            return model
        patched.add_object_patch(
            "diffusion_model.blocks.%d.mlp.forward" % idx,
            types.MethodType(_chunked_forward, mlp))
    return patched


def free_vram() -> None:
    """Release cached blocks between segments; never raises."""
    try:
        import torch
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:
        pass



# --------------------------------------------------------------------------- #
# pure helpers (unit tested without a GPU)
# --------------------------------------------------------------------------- #

def cosine_release(n: int, ticks: int = SEAM_RELEASE_TICKS) -> torch.Tensor:
    """Cosine soft-release weights for the audio tail of a continuation."""
    w = torch.ones(max(int(n), 0), dtype=torch.float32)
    if n <= 0:
        return w
    k = min(int(ticks), int(n))
    if k == 1:
        w[-1] = 0.0
        return w
    # Endpoints included so the last released tick is exactly 0 (full release).
    tail = torch.linspace(0.0, 1.0, k)
    w[-k:] = 0.5 * (1.0 + torch.cos(torch.pi * tail))
    return w


def prefix_mask(mode: str, window_frames: int, context_frames: int,
                is_first_segment: bool = False):
    """Video-half mask for one continuation: 0 pins to the prefix, 1 generates.

    Delegates to handoff.handoff_spec so the lock width, the ramp values and the
    audio release length have exactly one definition (they used to be computed
    here and in handoff.py with different vocabularies).
    """
    if mode not in HANDOFF_MODES:
        raise PlanError("E_PLAN_SCHEMA", "unknown handoff mode %r" % (mode,),
                        "choose one of %r" % (HANDOFF_MODES,))
    try:
        spec = handoff_spec(mode, context_frames, window_frames, is_first_segment)
    except ValueError as exc:
        raise PlanError("E_CTX_SET", str(exc),
                        "shrink context_frames or grow window_frames") from None
    if spec["lock_video_steps"] <= 0 and not spec["ramp_video"]:
        return None
    mask = torch.ones(video_latent_t(window_frames), dtype=torch.float32)
    steps = int(spec["lock_video_steps"])
    mask[:steps] = 0.0
    for i, v in enumerate(spec["ramp_video"]):
        j = steps + i
        if j < mask.numel():
            mask[j] = float(v)
    return mask


def ramp_at(mask: torch.Tensor, steps: int, values=RAMP_VALUES) -> torch.Tensor:
    """Write progressive unlock values right after a pinned prefix."""
    out = mask.clone()
    for i, v in enumerate(values):
        j = steps + i
        if j < out.numel():
            out[j] = float(v)
    return out


def packed_dims(width: int, height: int, window_frames: int):
    """(video_rows, audio_rows) of the packed AV latent."""
    lat_t = video_latent_t(window_frames)
    hh = (height // 16 + 1) // 2 * 2
    ww = (width // 16 + 1) // 2 * 2
    video = 24 * lat_t * hh * ww
    audio = 32 * 2 * audio_latent_t(window_frames)
    return video, audio


def apply_pixel_pin(x: torch.Tensor, prefix: torch.Tensor, mask: torch.Tensor):
    """KSamplerX0Inpaint algebra on the packed AV latent (video half only)."""
    nv = int(mask.numel())
    vmask = mask.to(device=x.device, dtype=x.dtype).reshape(1, 1, -1)
    keep = x[..., :nv]
    pinned = prefix[..., :nv].to(device=x.device, dtype=x.dtype)
    merged = keep * vmask + pinned * (1.0 - vmask)
    return torch.cat((merged, x[..., nv:]), dim=-1)


# --------------------------------------------------------------------------- #
# results
# --------------------------------------------------------------------------- #

@dataclass
class SegmentResult:
    index: int
    start_frame: int
    frames: int
    images: Any
    audio: Any
    seconds: float
    note: str = ""
    peak_gib: float = 0.0
    # Raw AV latent of this window.  latent_prefix continuations must feed the
    # predecessor's latent back in (see _sample), so run_plan has to carry it.
    latent: Any = None


@dataclass
class RunResult:
    images: Any
    audio: Any
    report: dict = field(default_factory=dict)


# --------------------------------------------------------------------------- #
# sampler bridge: comfy KSAMPLER <-> dsd.sampling.dual_clock_euler
# --------------------------------------------------------------------------- #

def make_dual_clock_sampler(video_values: int, shift_video: float, shift_audio: float,
                            audio_velocity_is_raw: bool = True,
                            solver: str = "euler",
                            audio_latent_clean=None):
    """KSAMPLER backed by our dual-clock integrator; no ComfyUI patching."""
    from comfy.samplers import KSAMPLER

    from .sampling import dual_clock_euler, dual_clock_exp2

    integrate = dual_clock_exp2 if str(solver).lower() == "exp2" else dual_clock_euler

    def sampler_function(model_wrap, x, sigmas, extra_args=None, callback=None,
                         disable=None):
        extra_args = {} if extra_args is None else extra_args
        mask = extra_args.get("denoise_mask")
        last = {"denoised": None}

        def predict_x0(xv, xa, sigma_v):
            packed = torch.cat((xv, xa), dim=-1)
            scale = sigma_v * xv.new_ones([xv.shape[0]])
            denoised = model_wrap(packed, scale, **extra_args)
            # KSAMPLER's own callback wants the packed x0 for previews, but our
            # integrator calls its callback per-step with the split streams.
            last["denoised"] = denoised
            return denoised[..., :video_values], denoised[..., video_values:]

        def step_callback(i, sigma_v, xv, xa):
            # KSAMPLER.sample builds k_callback(x) taking ONE dict
            # (comfy/samplers.py:997-1003: x["i"], x["denoised"], x["x"],
            # x["sigma"], x.get("sigma_hat")), so hand it that shape instead
            # of the four positional args the integrator emits.
            if callback is None:
                return
            packed = torch.cat((xv, xa), dim=-1)
            callback({"i": i, "sigma": sigma_v, "sigma_hat": sigma_v,
                      "denoised": last["denoised"], "x": packed})

        out_v, out_a = integrate(
            x[..., :video_values], x[..., video_values:], sigmas, predict_x0,
            shift_video=shift_video, shift_audio=shift_audio,
            denoise_mask=mask, audio_velocity_is_raw=audio_velocity_is_raw,
            audio_latent_clean=audio_latent_clean,
            callback=step_callback,
        )
        return torch.cat((out_v, out_a), dim=-1)

    return KSAMPLER(sampler_function)


# --------------------------------------------------------------------------- #
# executor
# --------------------------------------------------------------------------- #

class DSDExecutor:
    """Stateless: every call derives everything from plan + resources."""

    def __init__(self, model, clip, video_vae, audio_vae, *,
                 budget_gib: float = 7.9,
                 log: Callable[[str], None] | None = None,
                 ffn_chunks: int = 1,
                 tile_size: int = 512,
                 vae_tile: int = 0,
                 decode_shifts: str = "",
                 tail_trim: int = 0,
                 solver: str = "euler",
                 shift_video: float = 12.0,
                 shift_audio: float = 3.0,
                 pass2: bool = False,
                 pass2_model: str = "",
                 pass2_size=None,
                 pass2_steps: int = 0,
                 pass2_sigma: float = 0.0,
                 partial_start: float = 0.0):
        self.model = model
        self.clip = clip
        self.video_vae = video_vae
        self.audio_vae = audio_vae
        self.budget_gib = float(budget_gib)
        self.log = log or (lambda m: None)
        self.ref_frames = []
        # A2: three reference lanes. ref_images mirrors ref_frames; videos are
        # [T,H,W,C] float32/255 tensors; audios are {"waveform","sample_rate"}.
        self.ref_images = []
        self.ref_videos = []
        self.ref_audios = []
        # A3: run_plan injects callable(dict) here; None keeps the old silence.
        self.progress = None
        self._segs = 0
        self._pct_base = 0.0
        self._pct_span = 100.0
        # >1 chunks the SwiGLU FFN over tokens; exact, lowers peak VRAM.
        self.ffn_chunks = int(ffn_chunks)
        # Tiled VAE decode tile edge in pixels. 512 costs 114-136 s per
        # 158-frame window at 1280x704; worth sweeping against 8 GiB.
        self.tile_size = int(tile_size)
        # vae_tile overrides the minimax VAE spatial tile.  The model decode_tiled
        # discards every tile kwarg (comfy/ldm/minimax/vae.py:988) and always reads
        # self.tile_size, so the attribute is the only real knob: 256 px costs 2.036x
        # redundant decode area at 1280x704, 384 px 1.309x, 704 px 1.100x.
        self.vae_tile = int(vae_tile or 0)
        self.decode_shifts = [tuple(int(v) for v in p.split(","))
                              for p in str(decode_shifts or "").split(";") if p.strip()]
        # Frames dropped from every non-final segment tail. 0 keeps the
        # legacy full-window keep; see docs/64 for the measured knee.
        self.tail_trim = int(tail_trim or 0)
        self.solver = str(solver).strip().lower()
        # Flow-matching sigma-shift pair; the distilled chain assumes (12, 3).
        self.shift_video = float(shift_video)
        self.shift_audio = float(shift_audio)
        # ReferenceToVideo repacks the text encoder + an empty AV latent for the
        # whole geometry; it does not depend on the window index, so every
        # window after the first was paying ~24 s to rebuild the same tensors.
        self._cond_cache = {}
        # Continuation restart sigma.  0 = legacy (always start at 1.0 and
        # let the pinned latent rows fight a full noise draw).  (0,1) restarts
        # the continuation below the noise ceiling, i.e. SDEdit partial
        # denoise, which is what classifies the pinned rows as context.
        self.partial_start = float(getattr(self, "partial_start", 0.0) or 0.0)
        # Second pass: upscale the sampled VIDEO latent to canvas.final
        # with the MiniMax H3 latent upscaler, then decode at the final
        # canvas.  Without it the delivered pixels are canvas.gen only.
        self.pass2 = bool(pass2)
        self.pass2_model = str(pass2_model or
                                "minimax_h3_latent_upscaler_3d_fp16.safetensors")
        self.pass2_size = (int(pass2_size[0]), int(pass2_size[1])) if pass2_size else None
        # pass2_steps > 0 turns the latent upscale into a real second pass: the
        # upscaled latent becomes the init image and the model re-runs a few
        # steps from pass2_sigma.  docs/50 measured that the upscale alone only
        # interpolates (tenengrad 0.43x, hf 0.42x of native), so 1376x768 would
        # otherwise be a smoothed copy of 1280x704.
        self.pass2_steps = int(pass2_steps or 0)
        self.pass2_sigma = float(pass2_sigma or 0.0)
        self.partial_start = float(partial_start or 0.0)
        # Per-shot overrides (plan.SHOT_OVERRIDE_KEYS) for the segment being
        # rendered.  {} means inherit, and every reader below falls back to the
        # instance value, so a film without overrides takes the old path.
        self._seg_ov = {}
        # (shift_video, shift_audio) -> patched model.  A shot that changes the
        # shift needs a differently patched sampling object, but rebuilding it
        # for every window would re-clone and re-patch for nothing.
        self._model_cache = {}
        self._pass2_patcher = None
        # Task-0 instrumentation: per-phase wall clock + per-forward VRAM peaks.
        # Populated only; never read by delivery code paths.
        self.profile: dict = {"segments": []}

    # -- resources -------------------------------------------------------- #

    def attach_references(self, references) -> None:
        """Reference material in plan order.

        Accepts either the legacy list of IMAGE tensors (treated as images) or
        {"images": [...], "videos": [...], "audios": [...]}.
        """
        if isinstance(references, dict):
            images = references.get("images") or []
            videos = references.get("videos") or []
            audios = references.get("audios") or []
        else:
            images, videos, audios = (references or []), [], []
        self.ref_images = [f for f in images if f is not None]
        self.ref_videos = [f for f in videos if f is not None]
        self.ref_audios = [f for f in audios if f is not None]
        self.ref_frames = list(self.ref_images)

    # Fraction of one segment's slice of the progress bar consumed by each phase.
    _PHASE_WEIGHT = {"segment_start": 0.0, "sample_step": 0.0, "sample": 0.85, "pass2": 0.90,
                     "decode": 0.96, "segment_done": 1.0}

    def _emit_progress(self, phase: str, seg: int = 0, note: str = "") -> None:
        """A3: best-effort progress push; never allowed to break a render."""
        cb = self.progress
        if cb is None:
            return
        base = float(getattr(self, "_pct_base", 0.0))
        span = float(getattr(self, "_pct_span", 100.0))
        if phase == "sample_step":
            # inside the sample slice: the bar advances once per sigma step
            _n = max(1, int(getattr(self, "_cur_steps", 1)))
            _i = 0
            try:
                _i = int(str(note).split("/")[0].split()[-1]) - 1
            except Exception:
                _i = 0
            frac = 0.85 * min(1.0, max(0.0, (float(_i) + 0.5) / float(_n)))
        else:
            frac = self._PHASE_WEIGHT.get(phase, 0.5)
        pct = int(round(min(100.0, max(0.0, base + span * frac))))
        try:
            cb({"phase": phase, "seg": int(seg), "segs": int(self._segs),
                "pct": pct, "note": str(note)})
        except Exception:
            pass

    # -- segmentation ----------------------------------------------------- #

    @staticmethod
    def segments(plan: Plan):
        return plan.segment_plan()

    @staticmethod
    def shot_of(plan: Plan, segment: dict):
        return plan.shots[segment["parts"][0]["shot"]]

    # -- one segment ------------------------------------------------------ #

    def render_segment(self, plan: Plan, segment: dict, *,
                       prompt: str, seed: int,
                       prev_frames=None, prev_latent=None,
                       mode: str | None = None) -> SegmentResult:
        started = time.time()
        mode = plan.handoff if mode is None else mode
        if mode not in HANDOFF_MODES:
            raise PlanError("E_PLAN_SCHEMA", "unknown handoff mode %r" % (mode,))
        index = int(segment["index"])
        window = int(plan.window_frames)
        width, height = plan.canvas_gen
        if window % 17 != 5:
            raise PlanError("E_WINDOW_GRID", "window %d is not on the 17k+5 grid" % window)
        if index > 0 and mode != "off" and prev_frames is None and prev_latent is None:
            raise PlanError("E_CTX_SET", "continuation has no context to continue from")
        needs_latent = mode.startswith("latent_prefix")
        if index > 0 and needs_latent and prev_latent is None:
            raise PlanError("E_CTX_SET",
                            "%s needs the predecessor's latent, got none" % mode,
                            "keep the segment latent in run_plan, or switch to keyframe")

        _t_cond0 = time.time()
        positive, latent = self._condition(prompt, width, height, window, mode, index,
                                           prev_frames)
        _t_cond1 = time.time()
        mask = prefix_mask(mode, window, plan.context_frames, is_first_segment=(index == 0))
        images, audio, av_latent = self._sample(latent, positive, mask, seed, index,
                                                width, height, window, mode,
                                                prev_latent, plan.context_frames,
                                                getattr(plan, "steps", 4),
                                                prompt=prompt)
        _t_samp1 = time.time()
        self.profile.setdefault("segments", []).append({
            "index": index,
            "started_at": round(started, 3),
            "ended_at": round(_t_samp1, 3),
            "frames": int(window),
            "width": int(width),
            "height": int(height),
            "condition_s": round(_t_cond1 - _t_cond0, 3),
            "sample_s": round(_t_samp1 - _t_cond1, 3),
            "total_s": round(_t_samp1 - started, 3),
        })
        note = mode if index == 0 else "%s/%df" % (mode, plan.context_frames)
        return SegmentResult(index=index,
                             start_frame=int(segment["start_frame"]),
                             frames=window, images=images, audio=audio,
                             seconds=time.time() - started, note=note,
                             latent=av_latent)

    # -- internals -------------------------------------------------------- #

    def _condition(self, prompt, width, height, window, mode, index, prev_frames):
        from comfy_extras.nodes_minimax_h3 import (
            MiniMaxH3ReferenceToVideo, _empty_av_latent)

        latent, _ = _empty_av_latent(width, height, window)
        # keyframe / latent_prefix_anchor chain AddGuide on top of `positive`,
        # so those paths must always rebuild it; everything else is cacheable.
        cacheable = mode not in ("keyframe", "latent_prefix_anchor")
        key = None
        positive = None
        if cacheable:
            key = (prompt, int(width), int(height), int(window),
                   tuple(id(f) for f in (self.ref_frames or ())),
                   tuple(id(f) for f in (self.ref_videos or ())),
                   tuple(id(f) for f in (self.ref_audios or ())))
            positive = self._cond_cache.get(key)
        if positive is None:
            ref_kwargs = {}
            if self.ref_images:
                ref_kwargs["ref_images"] = {"ref_image_%d" % i: f
                                            for i, f in enumerate(self.ref_images)}
            if self.ref_videos:
                ref_kwargs["ref_videos"] = {"ref_video_%d" % i: f
                                            for i, f in enumerate(self.ref_videos)}
            if self.ref_audios:
                ref_kwargs["ref_audios"] = {"ref_audio_%d" % i: f
                                            for i, f in enumerate(self.ref_audios)}
            out = MiniMaxH3ReferenceToVideo.execute(
                clip=self.clip, prompt=prompt, width=width, height=height, length=window,
                ref_image_size="match", vae=self.video_vae, audio_vae=self.audio_vae,
                **ref_kwargs,
            )
            positive = out[0]
            if cacheable:
                self._cond_cache[key] = positive
        # keyframe: 只挂条件行（AddGuide），视频侧全开。
        # latent_prefix_anchor: 既挂条件行又钉 latent 前缀（I8 双管）。
        if (mode in ("keyframe", "latent_prefix_anchor")
                and index > 0 and prev_frames is not None):
            from comfy_extras.nodes_minimax_h3 import MiniMaxH3AddGuide

            positive = MiniMaxH3AddGuide.execute(
                positive=positive, latent=latent, frame_idx=0,
                vae=self.video_vae, audio_vae=None, image=prev_frames,
            )[0]
        return positive, latent

    def _sample(self, latent, positive, mask, seed, index, width, height, window,
                mode, prev_latent, context_frames, steps=None, prompt=None):
        import comfy.sample
        from comfy_extras.nodes_audio import vae_decode_audio

        # A shot may override these for its own segment only; an empty dict
        # leaves every fallback identical to the pre-override path.
        _ov = getattr(self, "_seg_ov", None) or {}
        shift_v = float(_ov.get("shift_video", getattr(self, "shift_video", 12.0)))
        shift_a = float(_ov.get("shift_audio", getattr(self, "shift_audio", 3.0)))
        solver = str(_ov.get("solver", getattr(self, "solver", "euler")))
        nv, _na = packed_dims(width, height, window)
        # One sampling pass only: the T8 chain's "c4r4" is coarse-4 + refine-4
        # across TWO model passes, so matching its NFE cost here means 8 steps
        # in this single pass.  Anything that compares seams between the two
        # must hold this number equal or the comparison is invalid.
        steps = int(getattr(self, "_steps", 4) if steps is None else steps)
        if "steps" in _ov:
            # Resolved BEFORE sigmas and before the log line so the shot's own
            # NFE count drives the sigma grid, _cur_steps, progress weighting
            # and the printed summary.
            steps = int(_ov["steps"])
        self.log("[DSD] solver=%s steps=%d window=%d shift=(%.2f,%.2f)" % (
            solver, steps, window, float(shift_v), float(shift_a)))
        sampler = make_dual_clock_sampler(nv, shift_v, shift_a, solver=solver)
        _ps = float(getattr(self, "partial_start", 0.0) or 0.0)
        if 0.0 < _ps < 1.0 and index > 0:
            from .sampling import partial_start_sigmas
            sigmas = partial_start_sigmas(steps, shift_v, _ps)
            self.log("[DSD] partial_start=%.3f sigma0=%.4f" % (
                _ps, float(sigmas[0])))
        else:
            sigmas = self._sigmas(shift_v, steps)

        noise = comfy.sample.prepare_noise(latent["samples"], seed)
        video_mask = None
        if mask is not None:
            # comfy.samplers.sample() takes a per-stream denoise mask and only
            # pads the missing streams with ones (comfy/samplers.py:1301-1313),
            # then packs them.  Handing it a flat packed vector would instead be
            # fed to prepare_mask() as if it were already the video stream, so
            # build the real 5-D video mask here and let comfy supply the audio
            # half: audio is never pixel-pinned, only video has a pixel prefix.
            hh = (height // 16 + 1) // 2 * 2
            ww = (width // 16 + 1) // 2 * 2
            video_mask = mask.reshape(1, 1, -1, 1, 1).expand(1, 1, mask.numel(), hh, ww).contiguous()
        if mode.startswith("latent_prefix") and prev_latent is not None:
            # KSAMPLER already wraps the model in KSamplerX0Inpaint
            # (comfy/samplers.py:634), which performs
            #     x   = x*mask   + latent_image*(1-mask)
            #     out = out*mask + latent_image*(1-mask)
            # every step, so the blend must NOT be repeated here.  Handing it
            # the whole predecessor latent would be wrong in a subtle way: the
            # mask only zeroes rows 0..steps-1, so it would pin the
            # predecessor HEAD, not its tail.  T8 assigns the tail to the front
            # (h3_t8/native_masked_context_advanced.py:174 + :252):
            #     tail = video_tail[:, :, -required_steps:]
            #     target[:, :, :required_steps] = tail
            # The new window continues the previous timeline, so the
            # predecessor last steps latent rows belong at the front.
            spec = handoff_spec(mode, context_frames, window, False)
            # NOTE: keep this in its own name.  Reusing `steps` here used to
            # shadow the NFE count and the profile then reported steps=7 for a
            # run that actually took steps=1.
            pin_steps = int(spec["lock_video_steps"])
            cur = latent["samples"]
            if hasattr(cur, "unbind"):
                cur_v, cur_a = cur.unbind()[:2]
            else:
                cur_v, cur_a = cur, None
            if hasattr(prev_latent, "unbind"):
                prev_v = prev_latent.unbind()[0]
            else:
                prev_v = prev_latent
            if int(prev_v.shape[2]) < pin_steps:
                raise PlanError(
                    "E_CTX_SET",
                    "predecessor latent has %d rows but %s needs %d"
                    % (int(prev_v.shape[2]), mode, steps),
                    "keep context_frames within the predecessor window")
            # tail_trim drops frames from the predecessor SHIPPED end, so the
            # last pin_steps rows no longer sit where the new window starts:
            # they are the stall the timeline skipped.  Walk the slice back by
            # the rows that span those dropped frames (5 latent rows per 17
            # video frames), otherwise the new window pins content the film
            # already cut and the seam turns into a jump cut.
            _tt = int(getattr(self, "tail_trim", 0))
            _shift = 0
            if _tt > 0:
                _shift = int(round(float(_tt) * 5.0 / 17.0))
                _shift = min(_shift, max(0, int(prev_v.shape[2]) - pin_steps))
            _end = int(prev_v.shape[2]) - _shift
            tail = prev_v[:, :, _end - pin_steps:_end].to(device=cur_v.device, dtype=cur_v.dtype)
            pinned = cur_v.clone()
            pinned[:, :, :pin_steps] = tail
            latent = dict(latent)
            if cur_a is not None:
                from comfy.nested_tensor import NestedTensor
                latent["samples"] = NestedTensor((pinned, cur_a))
            else:
                latent["samples"] = pinned

        model = self._model_for(shift_v, shift_a)
        self._cur_steps = int(len(sigmas) - 1)
        _t_s0 = time.time()
        _t_sample_begin = _t_s0
        if torch.cuda.is_available():
            torch.cuda.reset_peak_memory_stats()
        # samplers.sample() expects the latent TENSOR (it reads
        # latent_image.is_nested), not comfy's {"samples": ...} dict wrapper.
        _prof = os.environ.get("DSD_PROFILE", "")
        _profiler = None
        if _prof == "2":
            from torch.profiler import ProfilerActivity, profile as _torch_profile

            _profiler = _torch_profile(
                activities=[ProfilerActivity.CPU, ProfilerActivity.CUDA])
            _profiler.__enter__()
        try:
            def _step_cb(_i, _denoised, _x, _total):
                # Per-step progress: without this a 4-step segment emits ONE
                # event at the very end, so the panel bar sits at 0% for the
                # whole 19 min.  KSAMPLER.sample wraps our sampler_function's
                # callback into k_callback(x) and then calls the outer
                # callback(i, denoised, x, total_steps) -- four positional
                # args (comfy/samplers.py:999-1003), not a single dict.
                try:
                    self._emit_progress("sample_step", index,
                                        "step %d/%d" % (int(_i) + 1, int(_total)))
                except Exception:
                    pass

            samples = comfy.sample.sample_custom(
                model, noise, 1.0, sampler, sigmas, positive, positive,
                latent["samples"], noise_mask=video_mask, seed=seed,
                callback=_step_cb,
            )
        finally:
            if _profiler is not None:
                _profiler.__exit__(None, None, None)
                _table = _profiler.key_averages().table(
                    sort_by="self_cuda_time_total", row_limit=18)
                print(_table)
                # Start-Process leaves stdout buffered, so the printed table
                # is routinely lost. Persist it next to the profile dumps.
                _pdir = os.environ.get("DSD_PROFILE_DIR", "")
                if _pdir:
                    try:
                        os.makedirs(_pdir, exist_ok=True)
                        _fp = os.path.join(
                            _pdir, "torchprof-%d-%d.txt" % (index, int(time.time())))
                        with open(_fp, "w", encoding="utf-8") as _fh:
                            _fh.write(_table)
                        print("[DSD] torchprof -> %s" % _fp)
                    except Exception as _exc:
                        print("[DSD] torchprof dump failed: %r" % (_exc,))
        _t_s1 = time.time()
        _peak = (torch.cuda.max_memory_allocated() / 1024 ** 3
                 if torch.cuda.is_available() else 0.0)
        if isinstance(samples, dict):
            samples = samples["samples"]
        if hasattr(samples, "unbind"):
            parts = samples.unbind()
            video, audio = parts[0], parts[1]
        else:
            video, audio = samples, None
        _dump = os.environ.get("DSD_DUMP_LATENT", "")
        if _dump:
            # One render, many decode experiments: the 16px block is produced by
            # the decoder, so the decoded frames alone cannot tell us whether a
            # given post-process is acting on the latent content or on the
            # decode quantisation.  Save the sampled latent to answer that.
            try:
                import torch as _t2
                _p = _dump.replace("%d", str(int(index)))
                _t2.save({"video": video.detach().cpu(), "audio": None if audio is None else audio.detach().cpu(),
                          "index": int(index), "canvas": [int(video.shape[-1]) * 16, int(video.shape[-2]) * 16]}, _p)
                self.log("[DSD] latent -> %s" % _p)
            except Exception as _e:
                self.log("[DSD] latent dump failed: %r" % (_e,))
        self._emit_progress("sample", index, "denoise done")
        if self.pass2:
            video, audio = self._upscale_latent(video, audio)
            self._emit_progress("pass2", index, "latent upscale done")
            _p2 = int(_ov.get("pass2_steps", self.pass2_steps))
            if _p2 > 0 and prompt is not None:
                video, audio = self._refine_latent(
                    prompt, video, audio, seed, index, window,
                    steps2=_p2, shift_video=shift_v, shift_audio=shift_a,
                    solver=solver)
                self._emit_progress("pass2", index, "latent refine done")
        _t_d0 = time.time()
        frames = self._decode_video(video, tile=self.tile_size)
        self._emit_progress("decode", index, "video decoded")
        _t_d1 = time.time()
        decoded = vae_decode_audio(self.audio_vae, {"samples": audio}) if audio is not None else None
        _t_d2 = time.time()
        self.profile.setdefault("sample", []).append({
            "index": index,
            "steps": int(steps),
            "sigmas": [round(float(s), 6) for s in sigmas.tolist()],
            "denoise_s": round(_t_s1 - _t_s0, 3),
            "started_at": round(_t_sample_begin, 3),
            "ended_at": round(_t_s1, 3),
            "video_decode_s": round(_t_d1 - _t_d0, 3),
            "audio_decode_s": round(_t_d2 - _t_d1, 3),
            "peak_gib_denoise": round(_peak, 3),
            "video_latent_shape": list(video.shape),
        })
        # Hand the sampled AV latent back so the next segment can pin it: the
        # KSamplerX0Inpaint path needs a latent, not decoded pixels.
        return frames, decoded, samples

    def _model_for(self, shift_video: float, shift_audio: float):
        """Patched model for one (shift_video, shift_audio) pair, reused.

        A per-shot shift override needs a differently patched sampling
        object, but re-cloning and re-patching the model for every window of
        the same shot is pure overhead.  Keys are rounded to 1e-6 so float
        noise cannot fragment the cache; an un-overridden film now builds the
        patched model once instead of once per segment (same numbers).
        """
        key = (round(float(shift_video), 6), round(float(shift_audio), 6))
        cache = getattr(self, "_model_cache", None)
        if cache is None:
            cache = self._model_cache = {}
        model = cache.get(key)
        if model is None:
            model = self._model_with_shift(shift_video, shift_audio)
            cache[key] = model
        return model

    def _model_with_shift(self, shift_video: float, shift_audio: float):
        """Patch the model sampling so the network sees both clocks.

        audio_shift must stay None: with it set, ModelSamplingAV.audio_scale
        becomes shift/audio_shift (4.0 here) and comfy.ldm.minimax.model.forward
        rescales the audio stream onto the video clock (model.py:676-704), which
        is only correct for a sampler that carries audio at that scale.  Our
        dual-clock integrator advances audio on its own clock, so audio_scale
        must be 1.0 and the raw audio velocity must reach us untouched - the
        same reason T8 uses MiniMaxH3FlowSampling (audio_scale == 1.0) for the
        custom Euler path.  The two shifts still have to be published in
        transformer_options, because that is where the network reads the audio
        clock (model.py:739-740).
        """
        from comfy.model_sampling import CONST, ModelSamplingAV

        # Stock comfy builds this exact composition for ModelType.FLOW_AV
        # (comfy/model_base.py:154-159): class ModelSampling(ModelSamplingAV, CONST).
        # ModelSamplingAV alone has no noise_scaling()/inverse_noise_scaling() -
        # those come from CONST on the MRO - so KSAMPLER.sample() dies at
        # comfy/samplers.py:993 with "'ModelSamplingAV' object has no attribute
        # 'noise_scaling'".  Mirror the stock MRO instead of instantiating the
        # bare class.
        class _AVSampling(ModelSamplingAV, CONST):
            pass

        model = self.model.clone()
        sampling = _AVSampling(model.model.model_config)
        sampling.set_parameters(shift=shift_video, audio_shift=None)
        model.add_object_patch("model_sampling", sampling)

        options = dict(model.model_options.get("transformer_options", {}))
        options["minimax_h3_sigma_shift_video"] = float(shift_video)
        options["minimax_h3_sigma_shift_audio"] = float(shift_audio)
        model.model_options["transformer_options"] = options
        if int(getattr(self, "ffn_chunks", 1)) > 1:
            model = apply_ffn_chunking(model, self.ffn_chunks)
        return model

    @staticmethod
    def _sigmas(shift: float, steps: int = 4):
        from .sampling import native_flow_sigmas

        return native_flow_sigmas(steps, shift)

    def _refine_latent(self, prompt, video, audio, seed, index, window,
                       steps2=None, shift_video=None, shift_audio=None,
                       solver=None):
        """Second pass: re-denoise the upscaled latent.

        The upscale alone only interpolates (docs/50: tenengrad 0.43x, hf
        0.42x of native), so the 1376x768 frame is a smoothed 1280x704
        frame.  Handing that latent to KSAMPLER as latent_image with
        sigmas[0] = pass2_sigma makes CONST.noise_scaling build
            x = sigma*noise + (1-sigma)*latent_image
        (comfy/model_sampling.py:94-97), so the network reconstructs high
        frequencies on the larger grid instead of redrawing from scratch.

        The conditioning is rebuilt for the new geometry: the packed row
        count and the rope tables both depend on the canvas size.
        """
        import comfy.sample
        from comfy.nested_tensor import NestedTensor
        from .sampling import partial_start_sigmas

        # None = inherit the instance value, so an un-overridden film rebuilds
        # exactly the same numbers it always did.
        shift_v = float(getattr(self, "shift_video", 12.0)
                        if shift_video is None else shift_video)
        shift_a = float(getattr(self, "shift_audio", 3.0)
                        if shift_audio is None else shift_audio)
        _solver = str(getattr(self, "solver", "euler") if solver is None else solver)
        fw = int(round(int(video.shape[-1]) * 16))
        fh = int(round(int(video.shape[-2]) * 16))
        steps2 = int(self.pass2_steps if steps2 is None else steps2)
        sig = partial_start_sigmas(steps2, shift_v, float(self.pass2_sigma))
        nv2, _na2 = packed_dims(fw, fh, window)
        positive2, _lat2 = self._condition(prompt, fw, fh, window, "off", 0, None)

        _dev = getattr(self.model, "load_device", None)
        if _dev is not None:
            video = video.to(device=_dev)
            if audio is not None:
                audio = audio.to(device=_dev)
        # The integrator runs on the PACKED stream, so the clean audio it
        # re-seats against must be packed the same way: the upscaler returns a
        # nested latent whose audio half is [1, 32, 2, T], never the flat row.
        clean_audio = None
        if audio is not None:
            import comfy.utils as _cu
            _packed, _ = _cu.pack_latents((video, audio))
            clean_audio = _packed[..., nv2:]
        clean = NestedTensor((video, audio)) if audio is not None else video
        sampler2 = make_dual_clock_sampler(
            nv2, shift_v, shift_a, solver=_solver,
            audio_latent_clean=clean_audio)
        noise2 = comfy.sample.prepare_noise(clean, seed + 7919)
        model2 = self._model_for(shift_v, shift_a)
        self.log("[DSD] pass2 refine steps=%d sigma0=%.4f grid=%dx%d"
                 % (steps2, float(sig[0]), fw, fh))
        _t_r0 = time.time()
        if torch.cuda.is_available():
            torch.cuda.reset_peak_memory_stats()
        out2 = comfy.sample.sample_custom(
            model2, noise2, 1.0, sampler2, sig, positive2, positive2,
            clean, noise_mask=None, seed=seed + 7919,
        )
        _t_r1 = time.time()
        _rpeak = (torch.cuda.max_memory_allocated() / 1024 ** 3
                  if torch.cuda.is_available() else 0.0)
        if isinstance(out2, dict):
            out2 = out2["samples"]
        parts = out2.unbind() if hasattr(out2, "unbind") else (out2,)
        rv = parts[0]
        ra = parts[1] if len(parts) > 1 else audio
        self.profile["pass2_refine"] = {
            "steps": steps2,
            "sigma0": round(float(sig[0]), 6),
            "sigmas": [round(float(s), 6) for s in sig.tolist()],
            "seconds": round(_t_r1 - _t_r0, 3),
            "peak_gib": round(_rpeak, 3),
            "grid": [fw, fh],
            "started_at": round(_t_r0, 3),
            "ended_at": round(_t_r1, 3),
        }
        return rv, ra

    def _upscale_latent(self, video, audio):
        """Second pass: latent upscale to canvas.final (no extra NFE).

        MiniMaxH3LatentUpscaleWithModel keeps the temporal axis and only
        resamples H/W, so the window length and every seam stay put.
        """
        if not self.pass2 or self.pass2_size is None:
            return video, audio
        from comfy.nested_tensor import NestedTensor
        from comfy_extras.nodes_minimax_h3 import MiniMaxH3LatentUpscaleWithModel
        if self._pass2_patcher is None:
            from comfy_extras.nodes_hunyuan import LatentUpscaleModelLoader
            self._pass2_patcher = LatentUpscaleModelLoader.execute(self.pass2_model)[0]
            self.log("[DSD] pass2 upscaler %s" % self.pass2_model)
        fw, fh = self.pass2_size
        src_w = int(video.shape[-1]) * 16
        src_h = int(video.shape[-2]) * 16
        if (fw, fh) == (src_w, src_h):
            return video, audio
        lat = {"samples": NestedTensor((video, audio)) if audio is not None else video}
        _t0 = time.time()
        out = MiniMaxH3LatentUpscaleWithModel.execute(
            model=self._pass2_patcher, samples=lat, width=fw, height=fh)[0]
        s = out.get("samples") if isinstance(out, dict) else out
        if hasattr(s, "unbind"):
            parts = s.unbind()
            video, audio = parts[0], (parts[1] if len(parts) > 1 else audio)
        else:
            video = s
        self.profile.setdefault("pass2", []).append({
            "src": [src_w, src_h], "dst": [fw, fh],
            "seconds": round(time.time() - _t0, 3),
            "shape": list(video.shape)})
        self.log("[DSD] pass2 %dx%d -> %dx%d %.1fs" % (
            src_w, src_h, fw, fh, time.time() - _t0))
        return video, audio

    def _decode_video(self, video, tile: int = 512, overlap: int = 64,
                      temporal: int = 32, temporal_overlap: int = 8):
        """Tiled decode: one-shot decode of a full window needs ~5.5 GiB peak.

        h3_t8/audio_ops.py:26 decodes the whole clip in one call and that is
        exactly what OOM'd the 3 s DSD run (alloc 5.53 GiB + 1.55 GiB request,
        0 free). VAEDecodeTiled divides the same work into tiles with the same
        result shape, so a 158-frame window no longer needs the whole volume
        resident at once.
        """
        # Video latents are [B, C, T, H, W] (minimax vae.py encode/decode
        # docstrings: "normalized latents [B, 24, T_lat, H_lat, W_lat]").  An
        # unconditional movedim(2, 1) turned that into [B, T, C, H, W] and made
        # decode fail with "tensor a (37) must match tensor b (24) at dim 1"
        # where 37 was T_lat and 24 the channel count of latents_std.
        channels = getattr(self.video_vae, "latent_channels", None)
        if video.ndim == 5 and channels and video.shape[1] != channels \
                and video.shape[2] == channels:
            video = video.movedim(2, 1)
        comp = self.video_vae.spacial_compression_decode()
        tcomp = self.video_vae.temporal_compression_decode()
        stage = getattr(self.video_vae, "first_stage_model", None)
        restore_tile = None
        if int(getattr(self, "vae_tile", 0) or 0) > 0 and stage is not None and hasattr(stage, "tile_size"):
            restore_tile = int(stage.tile_size)
            if restore_tile != int(self.vae_tile):
                stage.tile_size = int(self.vae_tile)
                self.log("[DSD] vae tile %d -> %d" % (restore_tile, stage.tile_size))
        try:
            import torch as _torch
            if _torch.cuda.is_available():
                _torch.cuda.reset_peak_memory_stats()
        except Exception:
            pass
        tile = max(int(tile), int(overlap) * 4)
        if tcomp > 1:
            temporal = max(int(temporal) // tcomp, 1)
            temporal_overlap = max(int(temporal_overlap) // tcomp, 1)
        phases = list(getattr(self, "decode_shifts", []) or [])
        try:
            if len(phases) <= 1:
                out = self.video_vae.decode_tiled(
                    video, tile_x=tile // comp, tile_y=tile // comp,
                    overlap=overlap // comp,
                    tile_t=temporal, overlap_t=temporal_overlap,
                )
            else:
                # Same latent, several token-grid phases, averaged.  A roll of
                # (dx,dy) latent pixels moves the content half a token relative to
                # the 16px grid, so each phase quantises a different slice of the
                # picture into its tokens; the DC error is what decorrelates, the
                # picture is what survives the mean.
                acc = None
                for (dx, dy) in phases:
                    src_v = video
                    if dx or dy:
                        src_v = torch.roll(video, (int(dy), int(dx)), dims=(-2, -1))
                    part = self.video_vae.decode_tiled(
                        src_v, tile_x=tile // comp, tile_y=tile // comp,
                        overlap=overlap // comp,
                        tile_t=temporal, overlap_t=temporal_overlap,
                    )
                    if part.ndim == 5:
                        part = part.reshape(-1, *part.shape[-3:])
                    if dx or dy:
                        part = torch.roll(part, (-int(dy) * comp, -int(dx) * comp),
                                          dims=(-2, -1))
                    acc = part if acc is None else acc + part
                out = acc / float(len(phases))
                self.log("[DSD] decode phases %r" % (phases,))
        finally:
            # stage.tile_size is loader state: leaving it mutated would silently
            # change the tile grid (and the decode cost) of every later run.
            if restore_tile is not None and stage is not None:
                stage.tile_size = int(restore_tile)
        try:
            import torch as _torch
            if _torch.cuda.is_available():
                self.profile["vdec_peak_gib"] = round(_torch.cuda.max_memory_allocated() / 2 ** 30, 3)
        except Exception:
            pass
        if out.ndim == 5:
            out = out.reshape(-1, *out.shape[-3:])
        # Keep decoded frames on the host: a plan can own minutes of frames and
        # this box has 8 GiB of VRAM total.
        return out.cpu()


def run_plan(plan: Plan, model, clip, video_vae, audio_vae, *,
             references=None, prompts=None, seed: int = 0,
             budget_gib: float = 7.9,
             log: Callable[[str], None] | None = None,
             tile_size: int = 512,
             vae_tile: int = 0,
             solver: str = "",
             pass2: bool = False,
             pass2_model: str = "",
             pass2_size=None,
             pass2_steps: int = 0,
             pass2_sigma: float = 0.0,
             partial_start: float = None,
             progress=None) -> RunResult:
    executor = DSDExecutor(model, clip, video_vae, audio_vae,
                           budget_gib=budget_gib, log=log,
                           ffn_chunks=int(getattr(plan, "ffn_chunks", 1)),
                           tile_size=int(tile_size),
                           vae_tile=int(vae_tile) or int(getattr(plan, "vae_tile", 0)),
                           decode_shifts=str(getattr(plan, "decode_shifts", "")),
                           tail_trim=int(getattr(plan, "tail_trim", 0)),
                           solver=(solver or str(getattr(plan, "solver", "euler"))),
                           shift_video=float(getattr(plan, "shift_video", 12.0)),
                           shift_audio=float(getattr(plan, "shift_audio", 3.0)),
                           pass2=bool(pass2 or getattr(plan, "pass2", False)),
                           pass2_model=(pass2_model or str(getattr(plan, "pass2_model", ""))),
                           pass2_size=(pass2_size or getattr(plan, "canvas_final", None)),
                           pass2_steps=int(getattr(plan, "pass2_steps", 0) or 0),
                           pass2_sigma=float(getattr(plan, "pass2_sigma", 0.0) or 0.0),
                           partial_start=(partial_start if partial_start is not None
                                          else float(getattr(plan, "partial_start", 0.0))))
    executor.attach_references(references)
    segments = executor.segments(plan)
    executor.progress = progress
    executor._segs = len(segments)
    if progress is not None:
        try:
            progress({"phase": "start", "seg": 0, "segs": len(segments),
                      "pct": 0, "note": "%d segments" % len(segments)})
        except Exception:
            pass
    frames_out, audio_out, rows = [], [], []
    prev_frames = prev_latent = None
    # Plan-level values are the baseline a shot overrides on top of.  Resolved
    # once, so a shot with no overrides produces exactly the old effective set.
    _base = base_params(plan)
    _ov_seen = {}
    for segment in segments:
        idx = int(segment["index"])
        shot = executor.shot_of(plan, segment)
        text = prompts[idx] if prompts and idx < len(prompts) else shot.prompt
        # Effective sampling values for THIS segment; the executor reads them
        # off _seg_ov inside _sample / _refine_latent.
        _sh_ov = dict(getattr(shot, "overrides", None) or {})
        _eff = shot_overrides_effective(shot, _base)
        executor._seg_ov = _sh_ov
        if _sh_ov:
            _ov_seen[str(shot.id)] = {"overrides": _sh_ov, "effective": _eff}
        executor._pct_base = 100.0 * idx / max(1, len(segments))
        executor._pct_span = 100.0 / max(1, len(segments))
        executor._emit_progress("segment_start", idx,
                                "shot %s %s" % (shot.id, override_brief(_eff)))
        result = executor.render_segment(plan, segment, prompt=text, seed=seed + idx,
                                         prev_frames=prev_frames, prev_latent=prev_latent)
        trim = 0 if idx == 0 else int(plan.context_frames)
        body = result.images[trim:]
        # tail_trim: a continuation spends its final rows re-encoding the
        # incoming context, so motion collapses to 28-43% of the segment
        # median over the last 6-12 frames (docs/64).  Those frames are never
        # the timeline any more: the next window pins this window latent tail
        # and re-renders the same span from inside its own window, so they are
        # dropped here rather than shipped as a stall.  The final segment has
        # no successor to cover them and keeps its tail in full.
        drop_tail = 0
        if not segment.get("is_final") and int(getattr(plan, "tail_trim", 0)) > 0:
            drop_tail = min(int(plan.tail_trim), max(0, int(body.shape[0]) - 1))
            if drop_tail:
                body = body[:int(body.shape[0]) - drop_tail]
        frames_out.append(body)
        # Audio must cover exactly the emitted video span, not the whole
        # rendered window: a continuation re-renders its context at the head
        # (dropped by stitch_audio) and a tail_trim stall at the end (dropped
        # here).  Without this the final segment ships `window - needs` extra
        # seconds of audio and A/V drift grows with every seam.
        audio_out.append(_slice_audio(result.audio, trim + int(body.shape[0])))
        prev_frames = (body[-int(plan.context_frames):]
                       if plan.context_frames else None)
        # Pin the predecessor window latent, not the decoded tail: every
        # latent_prefix continuation needs it or it raises E_CTX_SET.
        prev_latent = result.latent
        free_vram()
        rows.append({"index": idx, "frames": int(body.shape[0]), "tail_trim": drop_tail,
                     "start_frame": result.start_frame,
                     "seconds": round(result.seconds, 2), "note": result.note,
                     # Kept for the timeline export: a cue needs the shot id and
                     # the parameters that shot actually rendered with.
                     "shot_id": str(shot.id), "overrides": _sh_ov,
                     "effective": _eff})
        executor._emit_progress("segment_done", idx, "%.1fs" % result.seconds)
        if log:
            log("segment %d done %.1fs" % (idx, result.seconds))
    audio = stitch_audio(audio_out, int(plan.context_frames))
    _report = {"schema": "dsd-report/1", "segments": rows,
               "window_frames": plan.window_frames,
               "context_frames": plan.context_frames,
               "handoff": plan.handoff,
               "steps": int(getattr(plan, "steps", 4)),
               "passes": 2 if executor.pass2 else 1,
               "canvas_final": list(executor.pass2_size) if executor.pass2_size else None,
               "pass2_refine": executor.profile.get("pass2_refine"),
               "partial_start": float(getattr(executor, "partial_start", 0.0)),
               "nfe": len(rows) * int(getattr(plan, "steps", 4)),
               "profile": executor.profile}
    if _ov_seen:
        _report["shot_overrides"] = _ov_seen
    _dump_dir = os.environ.get("DSD_PROFILE_DIR", "")
    if _dump_dir:
        try:
            os.makedirs(_dump_dir, exist_ok=True)
            _name = "%s.json" % (getattr(plan, "id", "plan") or "plan")
            with open(os.path.join(_dump_dir, _name), "w", encoding="utf-8") as fh:
                json.dump(_report, fh, ensure_ascii=False, indent=1)
            print("[DSD] profile -> %s" % os.path.join(_dump_dir, _name))
        except Exception as exc:  # never let instrumentation break a render
            print("[DSD] profile dump failed: %r" % (exc,))

    return RunResult(
        images=torch.cat(frames_out) if frames_out else None,
        audio=audio,
        report=_report,
    )
