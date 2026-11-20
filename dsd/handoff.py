"""dsd/handoff.py — 段间交接（handoff）的纯计算部分。

为什么独立成模块：交接参数（锁多少个 latent 单元、ramp 值、音频软释放长度）
是整个零痕设计里唯一真正影响成片观感的旋钮，必须能在没有 GPU、没有 ComfyUI
的情况下被单元测试钉死，否则每次实验都是盲试。节点层只负责把这里算出的
spec 变成 torch mask。

术语（与 docs/28 一致）
  visible   一个段真正要保留的帧数（会向上对齐到 17k+5）
  context   上一段尾部被当作上下文带进下一段的帧数
  sample    实际提交给采样器的窗口帧数 = visible + context（对齐 17k+5）
  trim      解码后要丢弃的前 context 帧

latent 时间轴：frame→latent 的映射是 video_latent_t(n) = 2 if n<=5 else ((n-5)//17)*5+2
（官方 comfy_extras/nodes_minimax_h3.py:56）。所以 context 帧对应的 latent 单元数
不是 context/17，而是查官方表：CONTEXT_FRAME_STEPS = {5:2, 22:7, 39:12}。

前缀锁定语义（官方 model.py:84-93）：noise_mask=0 的行被钉在 VISUAL_COND_TIMESTEP，
即「当作条件行」，不是像素级复制。ramp 值 0.25/0.5/0.75 让该行停在部分去噪状态。
ramp 过多会解码花屏，所以 ramp 长度固定 3，且必须留出足够全生成区。
"""
from __future__ import annotations

# 官方常量（抄自 h3_t8/long_video.py:58 与 comfy_extras/nodes_minimax_h3.py:50-58）
CONTEXT_FRAME_STEPS = {5: 2, 22: 7, 39: 12}
CONTEXT_FRAME_CHOICES = (5, 22, 39)
MIN_TRAINED_FRAMES = 124
MAX_TRAINED_FRAMES = 362
AUDIO_LATENT_FPS = 40
FPS = 24
RAMP_VALUES = (0.25, 0.5, 0.75)

# 词汇表唯一权威：机制名而不是描述名。plan.py / executor.py / 节点层都从这里取，
# 否则三处各写一套就会像 2026-11-17 那次一样互相喂不进去。
#   off                首段或显式关闭：不做任何前缀约束
#   keyframe           把上一段尾帧重编码成 keyframe 条件行（MiniMaxH3AddGuide）
#   latent_prefix      用 KSamplerX0Inpaint 代数把上一段 latent 前缀钉成真实像素
#   latent_prefix_ramp 同上，再在锁定区后面写 0.25/0.5/0.75 三个渐进解锁单元
HANDOFF_MODES = ("off", "keyframe", "latent_prefix", "latent_prefix_ramp",
                 "latent_prefix_anchor")


def align17(n: int) -> int:
    """向上对齐到 17k+5 栅格（官方 align_frame_count 同一算法）。"""
    n = max(5, int(n))
    while n % 17 != 5:
        n += 1
    return n


def video_latent_t(frame_count: int) -> int:
    frame_count = int(frame_count)
    if frame_count <= 5:
        return 2
    return ((frame_count - 5) // 17) * 5 + 2


def audio_latent_t(frame_count: int) -> int:
    """音频 latent 长度：按对齐后帧数的时长 × 40Hz（官方 temporal_shape）。"""
    return int(round((align17(frame_count) / FPS) * AUDIO_LATENT_FPS))


def video_latent_steps(context_frames: int) -> int:
    if context_frames not in CONTEXT_FRAME_STEPS:
        raise ValueError(
            "context_frames %r 不在官方合法集 %s 里（h3_t8/long_video.py:58）"
            % (context_frames, sorted(CONTEXT_FRAME_STEPS)))
    return CONTEXT_FRAME_STEPS[context_frames]


def handoff_spec(mode: str, context_frames: int, window_frames: int,
                 is_first_segment: bool) -> dict:
    """算一个段的 mask 规格。

    返回
      lock_video_steps  被钉住（mask=0）的视频 latent 单元数，首段恒 0
      ramp_video        紧跟锁定区的 ramp 值元组，off 模式为空
      lock_audio_steps  被钉住的音频 latent 单元数（仅 continue 家族非零）
      audio_release     音频尾部余弦软释放的 tick 数
      generated_steps   真正被全权重生成的视频 latent 单元数
    """
    if mode not in HANDOFF_MODES:
        raise ValueError("handoff mode %r 不在 %s 里" % (mode, list(HANDOFF_MODES)))
    window_frames = int(window_frames)
    if window_frames % 17 != 5:
        raise ValueError("window_frames %d 不在 17k+5 栅格上" % window_frames)
    total_steps = video_latent_t(window_frames)
    if is_first_segment or mode == "off":
        return {
            "mode": mode,
            "lock_video_steps": 0,
            "ramp_video": (),
            "lock_audio_steps": 0,
            "audio_release": 0,
            "generated_steps": total_steps,
            "reason": "first_segment" if is_first_segment else "mode_off",
        }
    audio_steps = audio_latent_t(context_frames)
    release = min(8, audio_steps)
    # latent_prefix_anchor 的 latent 侧与 latent_prefix 完全一致（同一份 mask），
    # 只在 _condition 里多挂一条 AddGuide 条件行。所以这里和 latent_prefix 同规格。
    if mode == "keyframe":
        # keyframe 走 cond 行（PackedLayout 的 resolved_frame_index），不需要任何
        # latent 锁定：前缀是「条件行」而不是「被钉住的生成行」，所以视频侧全开。
        return {
            "mode": mode,
            "lock_video_steps": 0,
            "ramp_video": (),
            "lock_audio_steps": 0,
            "audio_release": release,
            "generated_steps": total_steps,
            "reason": "keyframe_cond_rows",
        }
    steps = video_latent_steps(context_frames)
    ramp = RAMP_VALUES if mode == "latent_prefix_ramp" else ()
    # ramp 之后必须留下可生成区，否则整段都被条件行占住，等价于没生成
    if steps + len(ramp) >= total_steps:
        raise ValueError(
            "context %d 帧占 %d 个 latent 单元 + ramp %d，窗口 %d 帧只有 %d 个单元，剩不下生成区"
            % (context_frames, steps, len(ramp), window_frames, total_steps))
    return {
        "mode": mode,
        "lock_video_steps": steps,
        "ramp_video": ramp,
        "lock_audio_steps": audio_steps,
        # 音频不跟着视频一起硬钉——钉住会让接缝处声音突然「接管」；
        # 末端 8 tick 余弦软释放，长度不超过锁定区
        "audio_release": release,
        "generated_steps": total_steps - steps - len(ramp),
        "reason": mode,
    }


def describe(spec: dict) -> str:
    return ("mode=%s lock_v=%d ramp=%s lock_a=%d release=%d gen=%d (%s)"
            % (spec["mode"], spec["lock_video_steps"],
               list(spec["ramp_video"]), spec["lock_audio_steps"],
               spec["audio_release"], spec["generated_steps"], spec["reason"]))
