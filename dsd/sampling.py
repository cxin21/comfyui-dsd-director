"""DSD dual-clock sampling math (our own implementation).

Depends only on torch. Mirrors the H3 packing contract:
  * video stream is denoised on the video flow clock (shift_video)
  * audio stream is denoised on the audio flow clock (shift_audio)
  * when the two clocks differ the audio must be advanced with its own delta,
    otherwise audio and picture drift apart across steps.

All functions are pure and CPU-testable; the executor imports them.
"""
from __future__ import annotations

import math

import torch

# H3 native grid: 17k + 5 frames -> video latent steps
AUDIO_LATENT_FPS = 40
FPS = 24


def shift_sigma(base_sigma: float, shift: float) -> float:
    """flow-matching sigma shift (matches comfy.model_sampling.time_snr_shift)."""
    if shift == 1.0:
        return base_sigma
    return shift * base_sigma / (1.0 + (shift - 1.0) * base_sigma)


def inv_shift_sigma(sigma: float, shift: float) -> float:
    """invert shift_sigma: recover the base (shift=1) grid value."""
    return sigma / (shift + sigma * (1.0 - shift))


def time_shift_sigma(sigma: float, from_shift: float, to_shift: float) -> float:
    return shift_sigma(inv_shift_sigma(sigma, from_shift), to_shift)


def time_shift_slope(sigma: float, from_shift: float, to_shift: float) -> float:
    base = inv_shift_sigma(sigma, from_shift)
    num = to_shift * (1.0 + (from_shift - 1.0) * base) ** 2
    den = from_shift * (1.0 + (to_shift - 1.0) * base) ** 2
    return num / den


def native_flow_sigmas(steps: int, shift_video: float) -> torch.Tensor:
    base = torch.linspace(1.0, 0.0, steps + 1, dtype=torch.float32)
    return torch.tensor([shift_sigma(float(b), shift_video) for b in base], dtype=torch.float32)


def partial_start_sigmas(steps: int, shift_video: float, sigma_start: float) -> torch.Tensor:
    """Sigma schedule that starts at sigma_start (< 1) instead of 1.

    Refinement stages restart below the noise ceiling; the remaining steps
    are evenly spaced on the *base* grid between sigma_start and 0, then shifted, so
    the video and audio clocks still line up with the schedule the model saw.
    """
    if not 0.0 < sigma_start <= 1.0:
        raise ValueError("sigma_start must be in (0, 1]")
    base_start = inv_shift_sigma(sigma_start, shift_video)
    base = torch.linspace(base_start, 0.0, steps + 1, dtype=torch.float32)
    return torch.tensor([shift_sigma(float(b), shift_video) for b in base], dtype=torch.float32)


def audio_sigmas(video_sigmas, shift_video: float, shift_audio: float) -> torch.Tensor:
    """Audio clock for each video sigma."""
    return torch.tensor(
        [time_shift_sigma(float(s), shift_video, shift_audio) for s in video_sigmas],
        dtype=torch.float32,
    )


def rebase_partial_audio_start(x_audio, latent_audio, sigma_video: float,
                               shift_video: float, shift_audio: float):
    """Re-seat the audio stream on its own clock after a partial restart.

    Comfy's generic sampler initialises every packed stream with sigma_video.
    That is exact only at sigma == 1.  Recover KSAMPLER's scaled-noise term and
    rebuild x_audio at sigma_audio.
    """
    if sigma_video <= 0:
        raise ValueError("partial audio rebase needs a positive initial sigma")
    if latent_audio is not None and torch.is_tensor(latent_audio):
        if latent_audio.device != x_audio.device or latent_audio.dtype != x_audio.dtype:
            latent_audio = latent_audio.to(device=x_audio.device, dtype=x_audio.dtype)
    sigma_a = time_shift_sigma(sigma_video, shift_video, shift_audio)
    if abs(sigma_a - sigma_video) <= 1e-7:
        return x_audio
    sv = torch.as_tensor(sigma_video, dtype=x_audio.dtype, device=x_audio.device)
    sa = torch.as_tensor(sigma_a, dtype=x_audio.dtype, device=x_audio.device)
    scaled_noise = (x_audio - (1.0 - sv) * latent_audio) / sv
    return sa * scaled_noise + (1.0 - sa) * latent_audio


def to_d(x, sigma: float, denoised):
    """ComfyUI's x0 -> derivative conversion (matches comfy/samplers.py to_d)."""
    return (x - denoised) / sigma


def dual_clock_euler(x_video, x_audio, sigmas, predict_x0, *, shift_video: float,
                     shift_audio: float, denoise_mask=None, audio_velocity_is_raw: bool = True,
                     audio_latent_clean=None, callback=None):
    """Dual-clock Euler integrator (structure verified against T8's proven sampler).

    predict_x0(x_video, x_audio, sigma_video) -> (denoised_video, denoised_audio)

    Both streams share one noise schedule for the *video* clock.  The audio
    stream must be advanced with its own clock delta; using the video delta for
    both makes audio drift progressively faster than picture (T8 sampling.py
    sample_minimax_h3_dual_clock_euler is the reference this mirrors).

    denoise_mask: packed AV mask (1 = generate, 0 = locked prefix).  Its audio
    half blends the audio step between the free audio delta and the video delta,
    so a locked prefix stays pinned to the previous segment instead of being
    re-advanced on the audio clock.

    audio_latent_clean: clean AV latent used to re-seat the audio stream on its own
    clock when sigmas[0] < 1 (partial restart).  Pass None when starting at
    sigma == 1, where both clocks coincide and no rebase is needed.
    """
    xv, xa = x_video, x_audio
    audio_mask = None
    if denoise_mask is not None:
        nv = x_video.shape[-1]
        if denoise_mask.shape[-1] > nv:
            audio_mask = denoise_mask[..., nv:]
        elif denoise_mask.shape[-1] == xa.shape[-1]:
            audio_mask = denoise_mask

    # A partial restart seeds both streams with the video sigma; reseat audio.
    if audio_latent_clean is not None:
        xa = rebase_partial_audio_start(xa, audio_latent_clean, float(sigmas[0]),
                                        shift_video, shift_audio)

    n = len(sigmas) - 1
    for i in range(n):
        sv, sv_next = float(sigmas[i]), float(sigmas[i + 1])
        sa = time_shift_sigma(sv, shift_video, shift_audio)
        sa_next = time_shift_sigma(sv_next, shift_video, shift_audio)
        slope_a = time_shift_slope(sv, shift_video, shift_audio)
        x0v, x0a = predict_x0(xv, xa, sv)
        dv = sv_next - sv
        da = sa_next - sa
        if not audio_velocity_is_raw:
            da = da / slope_a
        if audio_mask is not None:
            da = dv + audio_mask * (da - dv)
        xv = xv + to_d(xv, sv, x0v) * dv
        xa = xa + to_d(xa, sv, x0a) * da
        if callback is not None:
            callback(i, sv, xv, xa)
    return xv, xa


def dual_clock_exp2(x_video, x_audio, sigmas, predict_x0, *, shift_video: float,
                    shift_audio: float, denoise_mask=None,
                    audio_velocity_is_raw: bool = True, audio_latent_clean=None,
                    callback=None):
    """Second-order exponential-integrator Euler (same NFE count as Euler).

    Why this exists: dual_clock_euler advances video with the tangent form
        x <- x + (x - x0)/sigma * dsigma
    which is only first order.  For flow matching the exact ODE in sigma is
        dx/dsigma = (x - x0(sigma)) / sigma
    and with u = x/sigma it becomes
        d(x/sigma)/dsigma = -x0(sigma) / sigma^2
    whose integral is closed form for any *linear-in-sigma* reconstruction of
    x0.  Reconstructing x0 from the two most recent predictions (sigma_{i-1},
    x0_{i-1}) and (sigma_i, x0_i) therefore gives a second-order update at
    exactly one model call per step -- the previous x0 is reused, nothing extra
    is evaluated.  Step 0 has no predecessor, so it falls back to a constant-x0
    reconstruction, which is the exact solution for constant x0 (it is what
    k-diffusion calls DPM-Solver-1 and is already better than tangent Euler).

    Audio keeps the first-order dual-clock delta on purpose: the audio half is
    ~0.6% of the packed rows, so changing its order buys nothing measurable and
    would confound the A/B.
    """
    xv, xa = x_video, x_audio
    audio_mask = None
    if denoise_mask is not None:
        nv = x_video.shape[-1]
        if denoise_mask.shape[-1] > nv:
            audio_mask = denoise_mask[..., nv:]
        elif denoise_mask.shape[-1] == xa.shape[-1]:
            audio_mask = denoise_mask

    if audio_latent_clean is not None:
        xa = rebase_partial_audio_start(xa, audio_latent_clean, float(sigmas[0]),
                                        shift_video, shift_audio)

    n = len(sigmas) - 1
    prev_s = None
    prev_x0 = None
    for i in range(n):
        sv, sv_next = float(sigmas[i]), float(sigmas[i + 1])
        sa = time_shift_sigma(sv, shift_video, shift_audio)
        sa_next = time_shift_sigma(sv_next, shift_video, shift_audio)
        slope_a = time_shift_slope(sv, shift_video, shift_audio)
        x0v, x0a = predict_x0(xv, xa, sv)

        if sv_next <= 0.0:
            xv = x0v
        elif prev_s is None or prev_x0 is None or prev_s <= sv:
            xv = x0v + (sv_next / sv) * (xv - x0v)
        else:
            a = (x0v - prev_x0) / (sv - prev_s)
            b = x0v - a * sv
            ratio = sv_next / sv
            xv = b + ratio * (xv - b) - sv_next * a * math.log(ratio)

        dv = sv_next - sv
        da = sa_next - sa
        if not audio_velocity_is_raw:
            da = da / slope_a
        if audio_mask is not None:
            da = dv + audio_mask * (da - dv)
        xa = xa + to_d(xa, sv, x0a) * da

        prev_s, prev_x0 = sv, x0v
        if callback is not None:
            callback(i, sv, xv, xa)
    return xv, xa
