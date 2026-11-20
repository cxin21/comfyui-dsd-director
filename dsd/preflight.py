# -*- coding: utf-8 -*-
"""导演台提交前的纯函数体检: timeline -> {ok, errors, warnings, info}.

只依赖标准库, 不 import torch / comfy, 不读磁盘 (参考素材是否存在由 input_dir 参数传入).
nodes.py 的 render() 与前端面板都会调用这里: 前者在组 plan 之前拦错, 后者在面板里
把结果渲染成 [E]/[W] 行给用户看.

事实来源 (改常量前先看这些地方):
- window_frames = 17k+5, 且 124 <= window <= 362     (src/dsd/plan.py align17 / MIN/MAX_TRAINED_FRAMES)
- context_frames in {5, 22, 39}                     (src/dsd/plan.py CONTEXT_FRAME_STEPS)
- 画布边长必须是 32 的倍数                          (nodes.py _align32)
- 参考素材上限: 图 9 / 视频 3 / 音频 3              (nodes.py _REF_IMAGE_MAX 等)
- 提示词板块顺序见 src/gen_ab_workflows.py 第 5-60 行
- <Picture N> / <Video K> / <Audio J> 是 MiniMax H3 的 1-based 引用语法
"""

import json
import os
import re

# ---------------------------------------------------------------- 事实常量

FPS = 24
MIN_SHOT_FRAMES = 5
ALIGN_STRIDE = 17
ALIGN_OFFSET = 5
MIN_TRAINED_FRAMES = 124
MAX_TRAINED_FRAMES = 362
CONTEXT_FRAME_STEPS = (5, 22, 39)
CANVAS_STRIDE = 32
CANVAS_MIN = 128
REF_IMAGE_MAX = 9
REF_VIDEO_MAX = 3
REF_AUDIO_MAX = 3
DEFAULT_SECONDS = 124 / 24.0
DUP_PROMPT_PREFIX = 200
TIMELINE_GAP_TOLERANCE = 2

# ---------------------------------------------------------------- issue codes

E_NO_SHOT = "E_NO_SHOT"
E_PROMPT_EMPTY = "E_PROMPT_EMPTY"
E_PROMPT_SHORT = "E_PROMPT_SHORT"
E_SHOT_TOO_SHORT = "E_SHOT_TOO_SHORT"
E_NO_MATERIAL = "E_NO_MATERIAL"
E_TOO_MANY_REFS = "E_TOO_MANY_REFS"
E_PICTURE_MISSING = "E_PICTURE_MISSING"
E_VIDEO_MISSING = "E_VIDEO_MISSING"
E_AUDIO_MISSING = "E_AUDIO_MISSING"
W_PICTURE_UNUSED = "W_PICTURE_UNUSED"
E_CANVAS_STRIDE = "E_CANVAS_STRIDE"
E_FINAL_NOT_BIGGER = "E_FINAL_NOT_BIGGER"
W_FINAL_OFF_GRID = "W_FINAL_OFF_GRID"
E_WINDOW_GRID = "E_WINDOW_GRID"
E_CTX_SET = "E_CTX_SET"
W_TIMELINE_GAP = "W_TIMELINE_GAP"
W_DUP_PROMPT = "W_DUP_PROMPT"
W_REF_NOT_FOUND = "W_REF_NOT_FOUND"
W_SUBJECT_ORDER = "W_SUBJECT_ORDER"

ALL_CODES = (
    E_NO_SHOT, E_PROMPT_EMPTY, E_PROMPT_SHORT, E_SHOT_TOO_SHORT,
    E_NO_MATERIAL, E_TOO_MANY_REFS, E_PICTURE_MISSING, E_VIDEO_MISSING,
    E_AUDIO_MISSING, W_PICTURE_UNUSED, E_CANVAS_STRIDE, E_FINAL_NOT_BIGGER,
    W_FINAL_OFF_GRID, E_WINDOW_GRID, E_CTX_SET, W_TIMELINE_GAP,
    W_DUP_PROMPT, W_REF_NOT_FOUND, W_SUBJECT_ORDER,
)

PROMPT_SECTIONS = (
    "subject_definitions",
    "quality_and_style",
    "style_and_color_science",
    "negative_constraints",
    "summary",
    "retention_analysis",
    "detailed_description",
    "camera_and_material",
)

_RE_PICTURE = re.compile(r"<Picture\s*(\d+)>", re.IGNORECASE)
_RE_VIDEO = re.compile(r"<Video\s*(\d+)>", re.IGNORECASE)
_RE_AUDIO = re.compile(r"<Audio\s*(\d+)>", re.IGNORECASE)
_RE_SUBJECT = re.compile(r"<Subject\s*(\d+)>", re.IGNORECASE)


# ---------------------------------------------------------------- 小工具

def _as_dict(timeline):
    """接受 dict 或 JSON 字符串; 解析不了就当空 timeline (随后报 E_NO_SHOT)."""
    if isinstance(timeline, dict):
        return timeline
    if isinstance(timeline, (str, bytes)):
        try:
            obj = json.loads(timeline)
        except Exception:
            return {}
        return obj if isinstance(obj, dict) else {}
    return {}


def _sub(tl, key):
    value = tl.get(key)
    return value if isinstance(value, dict) else {}


def _as_int(value, default=None):
    if value is None or value == "":
        return default
    try:
        return int(value)
    except (TypeError, ValueError):
        try:
            return int(round(float(value)))
        except (TypeError, ValueError):
            return default


def _as_float(value, default=None):
    if value is None or value == "":
        return default
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _pair(value):
    """[w, h] / (w, h) -> (int, int) 或 None."""
    if not isinstance(value, (list, tuple)) or len(value) != 2:
        return None
    w = _as_int(value[0])
    h = _as_int(value[1])
    if w is None or h is None:
        return None
    return (w, h)


def _list(value):
    return list(value) if isinstance(value, (list, tuple)) else []


def _ref_name(entry):
    """refs 里可能是字符串, 也可能是 {name: ...} 之类的对象."""
    if isinstance(entry, dict):
        for key in ("name", "file", "filename", "path"):
            if entry.get(key):
                return str(entry[key])
        return str(entry)
    return str(entry)


def align17(n):
    """最小的 >= n 的 17k+5 值 (与 src/dsd/plan.py align17 一致)."""
    n = int(n)
    if n < ALIGN_OFFSET:
        return ALIGN_OFFSET
    r = n % ALIGN_STRIDE
    return n + (ALIGN_OFFSET - r) % ALIGN_STRIDE


def _window_legal(window):
    if window is None:
        return False
    if (window - ALIGN_OFFSET) % ALIGN_STRIDE != 0:
        return False
    return MIN_TRAINED_FRAMES <= window <= MAX_TRAINED_FRAMES


def _window_neighbours(window):
    """返回 (lower, upper): window 两侧最近的两个 17k+5 值."""
    k = (int(window) - ALIGN_OFFSET) // ALIGN_STRIDE
    lower = ALIGN_STRIDE * k + ALIGN_OFFSET
    upper = lower + ALIGN_STRIDE
    return lower, upper


def _window_hint(window):
    if window is None:
        return "给 render.window_frames, 取 17k+5 且落在 124..362, 例如 124 / 141 / 362"
    lower, upper = _window_neighbours(window)
    legal = [v for v in (lower, upper) if MIN_TRAINED_FRAMES <= v <= MAX_TRAINED_FRAMES]
    if len(legal) == 2:
        return "最近合法值 %d 或 %d (17k+5, 且 124..362)" % (legal[0], legal[1])
    if len(legal) == 1:
        return "最近合法值 %d (17k+5, 且 124..362)" % (legal[0],)
    nearest = max(MIN_TRAINED_FRAMES, min(MAX_TRAINED_FRAMES, align17(window)))
    return "最近合法值 %d (合法区间 %d..%d)" % (nearest, MIN_TRAINED_FRAMES, MAX_TRAINED_FRAMES)


def _near32(value):
    """最近的 32 倍数 (与 nodes.py _align32 相同的四舍五入), 且不小于 128."""
    v = int(round(float(value) / float(CANVAS_STRIDE))) * CANVAS_STRIDE
    return max(CANVAS_MIN, v)


def _join_cn(items, last=" 与 "):
    items = [str(x) for x in items]
    if not items:
        return ""
    if len(items) == 1:
        return items[0]
    return "、".join(items[:-1]) + last + items[-1]


def _first_order(pattern, text):
    """按首次出现顺序返回编号 (去重), 例如 [1, 2, 3]."""
    seen = []
    for m in pattern.finditer(text or ""):
        n = int(m.group(1))
        if n not in seen:
            seen.append(n)
    return seen


def _nums(pattern, text):
    return [int(m.group(1)) for m in pattern.finditer(text or "")]


def detect_sections(prompt):
    """返回 (present, missing): 按 PROMPT_SECTIONS 的板块名做包含匹配."""
    low = (prompt or "").lower()
    present = [s for s in PROMPT_SECTIONS if s in low]
    missing = [s for s in PROMPT_SECTIONS if s not in present]
    return present, missing


def _issue(code, level, where, message, hint=""):
    return {"code": code, "level": level, "where": where, "message": message, "hint": hint}


def _section_advice(prompt):
    """补字建议: 优先补还缺的板块, 板块都在就建议加深画面细节两块."""
    _, missing = detect_sections(prompt)
    if missing:
        return _join_cn(missing[:2])
    return _join_cn(["detailed_description", "camera_and_material"])


# ---------------------------------------------------------------- 主入口

def preflight(timeline, *, input_dir=None, min_chars=3000, strict=False):
    """体检一条导演台 timeline. 纯函数: 不读磁盘 (input_dir 只用来 os.path.isfile).

    参数:
      timeline    dict 或 JSON 字符串, 至少含 {"shots": [...]}; 可带 canvas / render.
      input_dir   参考素材目录; 给定时检查 refs / refVideos / refAudios 的文件名是否存在.
      min_chars   每镜提示词的最小字符数 (去空白后).
      strict      True 时提示词过短算 error, 否则只算 warn.

    返回 {"ok": bool, "errors": [...], "warnings": [...], "info": {...}}; ok 只由 errors 决定.
    每条 issue 是 {"code", "level": "error"|"warn", "where", "message", "hint"}.
    """
    errors = []
    warnings = []

    tl = _as_dict(timeline)
    canvas = _sub(tl, "canvas")
    render = _sub(tl, "render")

    shots_raw = tl.get("shots")
    shots = shots_raw if isinstance(shots_raw, list) else []

    need = _as_int(min_chars, 3000)
    if need is None or need < 0:
        need = 0
    strict = bool(strict)

    gen = _pair(canvas.get("gen"))
    final = _pair(canvas.get("final")) or _pair(render.get("pass2_size"))
    window = _as_int(render.get("window_frames", tl.get("window_frames")))
    ctx = _as_int(render.get("context_frames", tl.get("context_frames")))
    total_frames = _as_int(render.get("total_frames", tl.get("total_frames")))
    pass2 = bool(render.get("pass2", tl.get("pass2", False)))

    # ---- 镜头存在性
    if not shots:
        errors.append(_issue(
            E_NO_SHOT, "error", "shots",
            "timeline 里没有镜头（shots 缺失或为空数组）",
            "至少加一个镜头 {id, seconds, prompt, refs}；seconds 默认 5.1667（124 帧）",
        ))

    prompt_chars = []
    sections = []
    img_total = vid_total = aud_total = 0
    timeline_frames = 0

    for i, shot in enumerate(shots):
        where = "shots[%d]" % (i,)
        if not isinstance(shot, dict):
            errors.append(_issue(
                E_PROMPT_EMPTY, "error", where,
                "镜头必须是对象，当前是 %s" % (type(shot).__name__,),
                "写成 {id, seconds, prompt, refs, refVideos, refAudios}",
            ))
            prompt_chars.append(0)
            sections.append({"present": [], "missing": list(PROMPT_SECTIONS)})
            continue

        prompt = str(shot.get("prompt") or "")
        text = prompt.strip()
        n_chars = len(text)
        prompt_chars.append(n_chars)
        present, missing = detect_sections(prompt)
        sections.append({"present": present, "missing": missing})

        # ---- 时长 -> 帧数
        secs = _as_float(shot.get("seconds"), DEFAULT_SECONDS)
        if secs is None or secs <= 0:
            secs = DEFAULT_SECONDS
        raw_frames = int(round(secs * FPS))
        aligned = align17(raw_frames)
        timeline_frames += raw_frames
        if raw_frames < MIN_SHOT_FRAMES:
            errors.append(_issue(
                E_SHOT_TOO_SHORT, "error", where + ".seconds",
                "seconds=%s 只够 %d 帧（对齐后 %d 帧）" % (round(secs, 4), raw_frames, aligned),
                "当前 %d 帧，最少 %d 帧（约 %.2f 秒）；17k+5 网格上最小就是 %d 帧"
                % (raw_frames, MIN_SHOT_FRAMES, MIN_SHOT_FRAMES / float(FPS), MIN_SHOT_FRAMES),
            ))

        refs = [_ref_name(x) for x in _list(shot.get("refs"))]
        vids = [_ref_name(x) for x in _list(shot.get("refVideos"))]
        auds = [_ref_name(x) for x in _list(shot.get("refAudios"))]
        img_total += len(refs)
        vid_total += len(vids)
        aud_total += len(auds)

        # ---- 提示词
        if not text:
            errors.append(_issue(
                E_PROMPT_EMPTY, "error", where + ".prompt",
                "提示词为空",
                "按板块顺序写满：" + " -> ".join(PROMPT_SECTIONS),
            ))
        elif need and n_chars < need:
            bucket = errors if strict else warnings
            bucket.append(_issue(
                E_PROMPT_SHORT, "error" if strict else "warn", where + ".prompt",
                "只有 %d 字（需要 %d）" % (n_chars, need),
                "还差 %d 字。建议补 %s 板块。" % (need - n_chars, _section_advice(prompt)),
            ))

        # ---- 参考素材数量上限
        if len(refs) > REF_IMAGE_MAX:
            errors.append(_issue(
                E_TOO_MANY_REFS, "error", where + ".refs",
                "参考图 %d 张，超过上限 %d 张" % (len(refs), REF_IMAGE_MAX),
                "删到 %d 张以内；H3 的参考图槽位只有 %d 个，多出的会在加载时被静默截断"
                % (REF_IMAGE_MAX, REF_IMAGE_MAX),
            ))
        if len(vids) > REF_VIDEO_MAX:
            errors.append(_issue(
                E_TOO_MANY_REFS, "error", where + ".refVideos",
                "参考视频 %d 段，超过上限 %d 段" % (len(vids), REF_VIDEO_MAX),
                "删到 %d 段以内" % (REF_VIDEO_MAX,),
            ))
        if len(auds) > REF_AUDIO_MAX:
            errors.append(_issue(
                E_TOO_MANY_REFS, "error", where + ".refAudios",
                "参考音频 %d 段，超过上限 %d 段" % (len(auds), REF_AUDIO_MAX),
                "删到 %d 段以内" % (REF_AUDIO_MAX,),
            ))

        # ---- 引用语法 <-> 素材数量（1-based，取最大编号）
        pic = _nums(_RE_PICTURE, prompt)
        vid = _nums(_RE_VIDEO, prompt)
        aud = _nums(_RE_AUDIO, prompt)

        if pic:
            need_pic = max(pic)
            if need_pic > len(refs):
                if refs:
                    hint = "要么把 refs 补到 %d 张，要么把 <Picture %d> 收到 1..%d" % (need_pic, need_pic, len(refs))
                else:
                    hint = "先给这一镜挂上 <Picture 1>..<Picture %d> 对应的 %d 张图" % (need_pic, need_pic)
                errors.append(_issue(
                    E_PICTURE_MISSING, "error", where + ".refs",
                    "提示词引用了 <Picture %d>，但该镜只有 %d 张参考图" % (need_pic, len(refs)),
                    hint,
                ))
        if vid:
            need_vid = max(vid)
            if need_vid > len(vids):
                errors.append(_issue(
                    E_VIDEO_MISSING, "error", where + ".refVideos",
                    "提示词引用了 <Video %d>，但该镜只有 %d 段参考视频" % (need_vid, len(vids)),
                    "把 refVideos 补到 %d 段，或删掉提示词里的 <Video %d>" % (need_vid, need_vid),
                ))
        if aud:
            need_aud = max(aud)
            if need_aud > len(auds):
                errors.append(_issue(
                    E_AUDIO_MISSING, "error", where + ".refAudios",
                    "提示词引用了 <Audio %d>，但该镜只有 %d 段参考音频" % (need_aud, len(auds)),
                    "把 refAudios 补到 %d 段，或删掉提示词里的 <Audio %d>" % (need_aud, need_aud),
                ))

        # ---- 挂了图但提示词没用上
        if refs:
            used = sorted(set(pic))
            unused = [k for k in range(1, len(refs) + 1) if k not in used]
            if unused:
                if used:
                    message = "有 %d 张图但提示词只引用了 %s" % (
                        len(refs),
                        "、".join("<Picture %d>" % (k,) for k in used),
                    )
                else:
                    message = "有 %d 张图但提示词没有引用任何 <Picture N>" % (len(refs),)
                if len(unused) == 1:
                    hint = "建议为第 %d 张加 <Picture %d>" % (unused[0], unused[0])
                else:
                    hint = "建议补上 " + "、".join("<Picture %d>" % (k,) for k in unused)
                warnings.append(_issue(W_PICTURE_UNUSED, "warn", where + ".refs", message, hint))

        # ---- 编号首次出现顺序
        subs = _first_order(_RE_SUBJECT, prompt)
        pics = _first_order(_RE_PICTURE, prompt)
        if len(subs) >= 2 and subs != sorted(subs):
            warnings.append(_issue(
                W_SUBJECT_ORDER, "warn", where + ".prompt",
                "<Subject> 首次出现顺序是 %s，不是递增的" % (subs,),
                "subject_definitions 里按 <Subject 1>..<Subject N> 递增定义，并各自对应 <Picture K>",
            ))
        elif len(pics) >= 2 and pics != sorted(pics):
            warnings.append(_issue(
                W_SUBJECT_ORDER, "warn", where + ".prompt",
                "<Picture> 首次出现顺序是 %s，与 <Subject> 的顺序对不上" % (pics,),
                "按 <Picture 1>..<Picture N> 递增引用，别让后一张图先出场",
            ))

        # ---- 参考文件是否存在（只 stat，不读内容）
        if input_dir:
            for field, names in (("refs", refs), ("refVideos", vids), ("refAudios", auds)):
                for name in names:
                    if not _exists(input_dir, name):
                        warnings.append(_issue(
                            W_REF_NOT_FOUND, "warn", where + "." + field,
                            "input 目录里找不到 %r" % (name,),
                            "把文件放进 %s，或改掉这条引用" % (input_dir,),
                        ))

    # ---- 相邻镜提示词重复（前 200 字完全相同）
    for i in range(1, len(shots)):
        prev = shots[i - 1] if isinstance(shots[i - 1], dict) else {}
        cur = shots[i] if isinstance(shots[i], dict) else {}
        a = str(prev.get("prompt") or "")[:DUP_PROMPT_PREFIX]
        b = str(cur.get("prompt") or "")[:DUP_PROMPT_PREFIX]
        if a.strip() and a == b:
            warnings.append(_issue(
                W_DUP_PROMPT, "warn", "shots[%d].prompt" % (i,),
                "与 shots[%d] 的前 %d 字完全相同" % (i - 1, DUP_PROMPT_PREFIX),
                "两镜描述一样会让模型吐出近似画面；改动作、机位或时间点再提交",
            ))

    # ---- 全片素材
    if img_total == 0 and vid_total == 0:
        errors.append(_issue(
            E_NO_MATERIAL, "error", "shots",
            "全片没有任何参考图（refs）或参考视频（refVideos）",
            "至少给一个镜头挂一张参考图；导演台不支持纯文生视频",
        ))

    # ---- 画布
    if gen is not None:
        bad = []
        for axis, value in (("宽", gen[0]), ("高", gen[1])):
            if value < CANVAS_MIN:
                bad.append("%s=%d 小于 %d" % (axis, value, CANVAS_MIN))
            elif value % CANVAS_STRIDE != 0:
                bad.append("%s=%d 不是 %d 的倍数" % (axis, value, CANVAS_STRIDE))
        if bad:
            errors.append(_issue(
                E_CANVAS_STRIDE, "error", "canvas.gen",
                "%dx%d 不合法：%s" % (gen[0], gen[1], "、".join(bad)),
                "最近合法值 %dx%d（宽高都取 %d 的倍数，且 >= %d）"
                % (_near32(gen[0]), _near32(gen[1]), CANVAS_STRIDE, CANVAS_MIN),
            ))

    # ---- final
    if final is not None:
        if pass2 and gen is not None:
            if not (final[0] > gen[0] and final[1] > gen[1]):
                errors.append(_issue(
                    E_FINAL_NOT_BIGGER, "error", "canvas.final",
                    "pass2 打开时 final 必须两维都大于 gen（gen=%dx%d final=%dx%d）"
                    % (gen[0], gen[1], final[0], final[1]),
                    "把 final 提到 %dx%d 以上，或把 pass2 关掉"
                    % (_near32(max(gen[0] + 1, gen[0] + CANVAS_STRIDE)),
                       _near32(max(gen[1] + 1, gen[1] + CANVAS_STRIDE))),
                ))
        off = [(axis, value) for axis, value in (("宽", final[0]), ("高", final[1]))
               if value % CANVAS_STRIDE != 0]
        if off:
            warnings.append(_issue(
                W_FINAL_OFF_GRID, "warn", "canvas.final",
                "%dx%d 里有 %s" % (final[0], final[1],
                                   "、".join("%s=%d 不是 %d 的倍数" % (ax, v, CANVAS_STRIDE) for ax, v in off)),
                "latent 侧按 //16 取整，非 %d 倍数的 final 会被隐式裁掉一两个 latent 格"
                % (CANVAS_STRIDE,),
            ))

    # ---- window / context
    if window is not None and not _window_legal(window):
        errors.append(_issue(
            E_WINDOW_GRID, "error", "render.window_frames",
            "window_frames=%d 不在 17k+5 网格上，或超出 %d..%d"
            % (window, MIN_TRAINED_FRAMES, MAX_TRAINED_FRAMES),
            _window_hint(window),
        ))

    if ctx is not None:
        if ctx not in CONTEXT_FRAME_STEPS:
            errors.append(_issue(
                E_CTX_SET, "error", "render.context_frames",
                "context_frames=%d 不在 %s 里" % (ctx, list(CONTEXT_FRAME_STEPS)),
                "用 22（默认）；5 省算力，39 接得更稳",
            ))
        elif window is not None and ctx >= window:
            errors.append(_issue(
                E_CTX_SET, "error", "render.context_frames",
                "context_frames=%d >= window_frames=%d，接续没有新帧空间" % (ctx, window),
                "降 context_frames，或把 window_frames 提到 %d 以上" % (align17(ctx + 1),),
            ))

    # ---- 时间线总帧
    if total_frames is not None and shots:
        gap = timeline_frames - total_frames
        if abs(gap) > TIMELINE_GAP_TOLERANCE:
            warnings.append(_issue(
                W_TIMELINE_GAP, "warn", "render.total_frames",
                "各镜 seconds 合计 %d 帧，render.total_frames=%d，差 %+d 帧"
                % (timeline_frames, total_frames, gap),
                "差额超过 %d 帧：改镜头时长，或改 render.total_frames"
                % (TIMELINE_GAP_TOLERANCE,),
            ))

    info = {
        "shots": len(shots),
        "strict": strict,
        "min_chars": need,
        "prompt_chars": prompt_chars,
        "sections": sections,
        "timeline_frames": timeline_frames,
        "duration_s": round(timeline_frames / float(FPS), 3),
        "total_frames": total_frames,
        "canvas": {
            "gen": list(gen) if gen else None,
            "final": list(final) if final else None,
            "pass2": pass2,
        },
        "window_frames": window,
        "context_frames": ctx,
        "refs": {"images": img_total, "videos": vid_total, "audios": aud_total},
        "input_dir": input_dir,
        "checked": [e["code"] for e in errors] + [w["code"] for w in warnings],
    }

    return {"ok": not errors, "errors": errors, "warnings": warnings, "info": info}


def _exists(input_dir, name):
    if not input_dir:
        return True
    try:
        return os.path.isfile(os.path.join(str(input_dir), name))
    except OSError:
        return False


# ---------------------------------------------------------------- 文本渲染（前端按行解析）

def _format_line(prefix, issue):
    body = "%s %s" % (issue.get("where", ""), issue.get("message", ""))
    hint = (issue.get("hint") or "").strip()
    if hint:
        return "[%s] %s：%s" % (prefix, body, hint)
    return "[%s] %s" % (prefix, body)


def preflight_text(timeline_json, **kwargs):
    """把 preflight() 的结果渲染成多行文本.

    每个问题一行，行首是 [E] 或 [W]；末行是统计，例如：
        共 1 个错误、1 个警告。
    前端按行首前缀切分即可，不需要解析 JSON.
    """
    try:
        result = preflight(timeline_json, **kwargs)
    except Exception as exc:
        return "[E] timeline 体检本身失败：%s\n共 1 个错误、0 个警告。" % (exc,)

    lines = []
    for issue in result["errors"]:
        lines.append(_format_line("E", issue))
    for issue in result["warnings"]:
        lines.append(_format_line("W", issue))
    if not lines:
        lines.append("没有发现问题。")
    lines.append("共 %d 个错误、%d 个警告。" % (len(result["errors"]), len(result["warnings"])))
    return "\n".join(lines)


__all__ = [
    "preflight", "preflight_text", "detect_sections", "align17",
    "ALL_CODES", "PROMPT_SECTIONS",
    "E_NO_SHOT", "E_PROMPT_EMPTY", "E_PROMPT_SHORT", "E_SHOT_TOO_SHORT",
    "E_NO_MATERIAL", "E_TOO_MANY_REFS", "E_PICTURE_MISSING", "E_VIDEO_MISSING",
    "E_AUDIO_MISSING", "W_PICTURE_UNUSED", "E_CANVAS_STRIDE", "E_FINAL_NOT_BIGGER",
    "W_FINAL_OFF_GRID", "E_WINDOW_GRID", "E_CTX_SET", "W_TIMELINE_GAP",
    "W_DUP_PROMPT", "W_REF_NOT_FOUND", "W_SUBJECT_ORDER",
]
