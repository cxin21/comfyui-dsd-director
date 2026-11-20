/**
 * DSD Director - ComfyUI front-end panel.
 * BDGROUP collapsible group headers + one self-drawn DOM panel, styled after the
 * AIMixer director console (cyan computed boundaries, no thumbnails before a run).
 * Every initialisation step is wrapped: a failure logs console.warn and leaves the
 * panel empty, the node itself must stay runnable.
 */
import { app } from "../../../scripts/app.js";

const NODE_NAME = "DSDDirector";
const PANEL_WIDGET_ID = "dsd_director_ui";
const PANEL_MIN_HEIGHT = 900;
const FPS = 24;

/* ------------------------------------------------------------------ utils */

function safe(fn, label) {
  try {
    return fn();
  } catch (err) {
    console.warn("[DSD.DirectorPanel] " + label + " failed:", err);
    return undefined;
  }
}

function findWidget(node, name) {
  try {
    const ws = node && node.widgets;
    if (!ws || !ws.length) return null;
    for (let i = 0; i < ws.length; i++) {
      if (ws[i] && ws[i].name === name) return ws[i];
    }
  } catch (err) {
    console.warn("[DSD.DirectorPanel] findWidget(" + name + ") failed:", err);
  }
  return null;
}

function widgetValue(node, name, fallback) {
  const w = findWidget(node, name);
  if (!w) return fallback;
  const v = w.value;
  if (v === undefined || v === null || v === "") return fallback;
  return v;
}

function numWidget(node, name, fallback) {
  const raw = widgetValue(node, name, fallback);
  const n = typeof raw === "number" ? raw : parseFloat(String(raw));
  return Number.isFinite(n) ? n : fallback;
}

function setWidgetValue(node, name, value) {
  const w = findWidget(node, name);
  if (!w) return false;
  const same = w.value === value;
  w.value = value;
  if (!same) {
    safe(function () {
      if (typeof w.callback === "function") w.callback(value);
    }, "widget callback " + name);
  }
  safe(function () {
    if (node.setDirtyCanvas) node.setDirtyCanvas(true, true);
  }, "setDirtyCanvas");
  return true;
}

/* ------------------------------------------------------- segment geometry */

/**
 * Pure geometry, no side effects.
 * Segment 0 covers window_frames; each later segment adds (window - context)
 * new frames but re-reads the previous context frames.
 */
function computeSegments(windowFrames, contextFrames, totalFrames) {
  const win = Math.max(1, Math.round(Number(windowFrames) || 124));
  const ctxRaw = Math.round(Number(contextFrames) || 0);
  const ctx = Math.max(0, Math.min(ctxRaw, win - 1));
  const total = Math.max(1, Math.round(Number(totalFrames) || win));
  const stride = Math.max(1, win - ctx);
  const segments = [];
  let covered = 0;
  let guard = 0;
  while (covered < total && guard < 100000) {
    guard++;
    const isFirst = segments.length === 0;
    const capacity = isFirst ? win : stride;
    const take = Math.min(capacity, total - covered);
    segments.push({
      index: segments.length,
      start: isFirst ? 0 : covered - ctx,
      end: covered + take,
      capacity: capacity,
      net: take,
      isFirst: isFirst,
      tail: take < capacity,
    });
    covered += take;
  }
  if (!segments.length) {
    segments.push({ index: 0, start: 0, end: total, capacity: total, net: total, isFirst: true, tail: false });
  }
  return {
    window: win,
    context: ctx,
    total: total,
    stride: stride,
    segments: segments,
    seconds: total / FPS,
  };
}

/* --------------------------------------------------------------- BDGROUP */

const GROUP_STATE = new WeakMap();

function getGroupState(node) {
  let st = GROUP_STATE.get(node);
  if (!st) {
    st = { collapsed: Object.create(null) };
    GROUP_STATE.set(node, st);
  }
  return st;
}

function groupMembers(node, fromIdx) {
  const out = [];
  try {
    const ws = (node && node.widgets) || [];
    for (let i = fromIdx + 1; i < ws.length; i++) {
      const w = ws[i];
      if (!w) continue;
      if (w.type === "BDGROUP" || w._bdGroupHeader) break;
      out.push(w);
    }
  } catch (err) {
    console.warn("[DSD.DirectorPanel] groupMembers failed:", err);
  }
  return out;
}

/**
 * Probe-and-degrade hiding. Chain tried per widget:
 *   1. widget.hidden = true          (ComfyUI 0.45 isVisible() honours it)
 *   2. widget.options.hidden = true
 *   3. widget.computeSize -> [0,-4]
 * Any probe that throws is skipped; a widget we cannot touch simply stays visible.
 */
function applyCollapse(node, members, collapsed, registry) {
  for (let i = 0; i < members.length; i++) {
    const w = members[i];
    if (!w) continue;
    if (!registry.has(w)) {
      registry.set(w, {
        hidden: w.hidden,
        computeSize: w.computeSize,
        optionsHidden: w.options ? w.options.hidden : undefined,
      });
    }
    const orig = registry.get(w);
    if (collapsed) {
      safe(function () {
        w.hidden = true;
      }, "collapse hidden");
      safe(function () {
        if (!w.options) w.options = {};
        w.options.hidden = true;
      }, "collapse options.hidden");
      safe(function () {
        if (typeof w.computeSize === "function") w.computeSize = function () { return [0, -4]; };
      }, "collapse computeSize");
    } else {
      safe(function () {
        w.hidden = orig.hidden;
      }, "expand hidden");
      safe(function () {
        if (w.options) w.options.hidden = orig.optionsHidden;
      }, "expand options.hidden");
      safe(function () {
        if (typeof orig.computeSize === "function") w.computeSize = orig.computeSize;
      }, "expand computeSize");
    }
  }
  safe(function () {
    if (node.setSize && node.computeSize) node.setSize([node.size[0], node.computeSize()[1]]);
  }, "resize after collapse");
  safe(function () {
    if (node.setDirtyCanvas) node.setDirtyCanvas(true, true);
  }, "dirty after collapse");
}

function drawGroupHeader(ctx, node, width, y, height, label, collapsed) {
  const margin = 10;
  const barH = 24;
  const barY = y + 2;
  const barW = Math.max(40, width - margin * 2);
  ctx.save();
  try {
    ctx.fillStyle = "#2e2e2e";
    ctx.strokeStyle = "#555";
    ctx.lineWidth = 1;
    ctx.beginPath();
    if (typeof ctx.roundRect === "function") ctx.roundRect(margin, barY, barW, barH, 4);
    else ctx.rect(margin, barY, barW, barH);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#d8dce8";
    ctx.font = "600 11px ui-sans-serif, system-ui, sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(collapsed ? "\u25B8" : "\u25BE", margin + 8, barY + barH / 2);
    ctx.fillText(String(label || ""), margin + 22, barY + barH / 2);
  } catch (err) {
    console.warn("[DSD.DirectorPanel] drawGroupHeader failed:", err);
  }
  ctx.restore();
}

/** Toggle one BDGROUP header: flips state, applies collapse to its members. Never throws. */
function toggleGroupWidget(node, widget) {
  try {
    if (!node || !widget) return false;
    const st = getGroupState(node);
    const key = widget.name;
    const next = !st.collapsed[key];
    st.collapsed[key] = next;
    let idx = -1;
    const ws = node.widgets || [];
    for (let i = 0; i < ws.length; i++) {
      if (ws[i] === widget) {
        idx = i;
        break;
      }
    }
    if (idx < 0) return false;
    const registry = widget._dsdRegistry || new WeakMap();
    widget._dsdRegistry = registry;
    applyCollapse(node, groupMembers(node, idx), next, registry);
    if (node.setDirtyCanvas) node.setDirtyCanvas(true, true);
    return true;
  } catch (err) {
    console.warn("[DSD.DirectorPanel] BDGROUP toggle failed:", err);
    return false;
  }
}

/**
 * Canvas fallback: LiteGraph only dispatches widget.mouse() for legacy widget
 * types, so a custom type may never see its own click. Walk the drawn layout
 * (widget.last_y is written by the canvas during draw) and test the 28px strip.
 * Returns true when the click was consumed by a group header.
 */
function hitTestGroupHeaders(node, pos) {
  try {
    if (!node || !pos || !node.widgets) return false;
    for (let i = 0; i < node.widgets.length; i++) {
      const w = node.widgets[i];
      if (!w || w.type !== "BDGROUP" || typeof w.last_y !== "number") continue;
      const y = w.last_y;
      if (pos[1] >= y && pos[1] <= y + 28) {
        return toggleGroupWidget(node, w);
      }
    }
  } catch (err) {
    console.warn("[DSD.DirectorPanel] header hit test failed:", err);
  }
  return false;
}

/**
 * Another extension (AIMixer / MiniMaxH3 director) registers the same custom
 * widget type "BDGROUP" in the global custom-widget map, so ComfyUI may build
 * the header with *that* factory instead of ours (last registration wins).
 * Re-point every BDGROUP header on this node at our drawing, our 28px hit strip
 * and our collapse registry. Each step is probed; a header we cannot patch keeps
 * its foreign rendering and simply does not collapse - never throws.
 */
function adoptGroupWidgets(node) {
  const adopted = [];
  try {
    const ws = (node && node.widgets) || [];
    for (let i = 0; i < ws.length; i++) {
      const w = ws[i];
      if (!w || w.type !== "BDGROUP" || w._dsdAdopted) continue;
      let label = "";
      try {
        label = (typeof w.value === "string" && w.value) || w._bdGroupLabel || w.name || "";
      } catch (err) {
        label = w.name || "";
      }
      safe(function () {
        w._bdGroupHeader = true;
        w._dsdRegistry = w._dsdRegistry || new WeakMap();
        w.computeSize = function (width) {
          return [width, 28];
        };
        w.mouse = function (event, pos, nodeRef) {
          toggleGroupWidget(nodeRef || node, w);
          return true;
        };
        w.draw = function (ctx, nodeRef, widgetWidth, y, height) {
          const target = nodeRef || node;
          const collapsed = target ? !!getGroupState(target).collapsed[w.name] : false;
          drawGroupHeader(ctx, target, widgetWidth, y, 28, label, collapsed);
        };
        w._dsdAdopted = true;
      }, "adopt BDGROUP " + String(w.name));
      if (w._dsdAdopted) adopted.push(w.name);
    }
  } catch (err) {
    console.warn("[DSD.DirectorPanel] adoptGroupWidgets failed:", err);
  }
  return adopted;
}

function makeGroupHeaderWidget(node, inputName, inputData) {
  const opts = (inputData && inputData[1]) || {};
  const label = opts.default || opts.label || inputName;
  const registry = new WeakMap();

  const widget = {
    name: inputName,
    type: "BDGROUP",
    value: label,
    label: "",
    options: opts,
    _bdGroupHeader: true,
    serialize: true,
    computeSize: function (width) {
      return [width, 28];
    },
    draw: function (ctx, nodeRef, widgetWidth, y, height) {
      const target = nodeRef || node;
      const collapsed = target ? !!getGroupState(target).collapsed[inputName] : false;
      drawGroupHeader(ctx, target, widgetWidth, y, 28, label, collapsed);
    },
    mouse: function (event, pos, nodeRef) {
      toggleGroupWidget(nodeRef || node, widget);
      return true;
    },
    _dsdRegistry: registry,
  };
  return widget;
}

import { api } from "../../../scripts/api.js";

const IMG_SLOTS = 9;
const VID_SLOTS = 3;
const AUD_SLOTS = 3;
const MIN_SHOT_FRAMES = 5;
const DEFAULT_SHOT_SECONDS = 5.1667;
const LANG_KEY = "dsd.panel.lang";

/* Widget names the panel reads or writes (docs/81). A missing one only raises
   a banner; nothing below assumes it exists. */
const CONTRACT_WIDGETS = [
  "timeline_data", "total_frames", "preset", "strict", "budget_gib",
  "steps", "solver", "shift_video", "shift_audio", "handoff",
  "gen_w", "gen_h", "window_frames", "context_frames", "ffn_chunks", "tile_size",
  "pass2", "upscale", "final_w", "final_h", "pass2_steps", "pass2_sigma",
  "out_w", "out_h", "unsharp", "export_mode", "plan_path", "builtin_note",
];

/* Widgets the panel owns and therefore hides on the canvas. */
const HIDDEN_WIDGETS = ["timeline_data", "plan_path", "builtin_note", "pass2_model", "inline_prompt"];

/* Preset table (docs/81). wall = measured seconds for the 124-frame reference
   run; null means "not measured", never a guessed number. */
/* steps/ffn_chunks are pinned by every preset on purpose.  The 4-step turbo LoRA
   is distilled for 4 NFE; measured at the same seed, steps=1 vs steps=4 gives
   ncc 0.61 and a Laplacian variance of 288 vs 514, i.e. visibly softer lines.
   ffn_chunks only changes peak VRAM -- 1 vs 4 is bit-identical (ncc 1.0000). */
const PRESETS = [
  {
    id: "best2x", name: "本机最优 2x", en: "Best 2x", wall: 906,
    patch: {
      preset: "本机最优 2x", steps: 4, ffn_chunks: 4, pass2: true, gen_w: 1376, gen_h: 768, upscale: "2.0",
      final_w: 2752, final_h: 1536, out_w: 2560, out_h: 1440, unsharp: 0.8,
    },
  },
  {
    id: "fast15", name: "1.5x 快速", en: "1.5x fast", wall: 882,
    patch: {
      preset: "1.5x 快速", steps: 4, ffn_chunks: 4, pass2: true, gen_w: 1376, gen_h: 768, upscale: "1.5",
      final_w: 2048, final_h: 1152, out_w: 1920, out_h: 1080, unsharp: 0.8,
    },
  },
  {
    id: "native1x", name: "1x 原生", en: "1x native", wall: 1080,
    patch: {
      preset: "1x 原生", steps: 4, ffn_chunks: 4, pass2: false, gen_w: 1376, gen_h: 768, upscale: "1.0",
      final_w: 1376, final_h: 768, out_w: 1376, out_h: 768, unsharp: 0.0,
    },
  },
  { id: "custom", name: "自定义", en: "Custom", wall: null, patch: { preset: "自定义" } },
];

/* ---------------------------------------------------------------- format */

function pad2(n) {
  const v = Math.max(0, Math.round(Number(n) || 0));
  return v < 10 ? "0" + v : String(v);
}

function clampNum(n, lo, hi) {
  const v = Number(n);
  if (!Number.isFinite(v)) return lo;
  return v < lo ? lo : v > hi ? hi : v;
}

/** Latent geometry rounds to 32px; mirrors the backend _align32 so the panel
 *  never warns about a final size the node would actually accept. */
function align32(v) {
  // Python rounds halves to even while JS Math.round rounds them up: 2064 / 32 = 64.5,
  // so the node picked 2048 while the panel picked 2080 and the two disagreed on every
  // exact .5 boundary (1376 x 1.5 is one). Mirror the backend so both agree.
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 0;
  const q = Math.abs(n) / 32;
  const f = Math.floor(q);
  const d = q - f;
  const r = d > 0.5 ? f + 1 : d < 0.5 ? f : f % 2 === 0 ? f : f + 1;
  return Math.max(32, r * 32);
}

function isArray(v) {
  return Object.prototype.toString.call(v) === "[object Array]";
}

/** Frames -> "HH:MM:SS:FF". */
function fmtTimecode(frames) {
  const f = Math.max(0, Math.round(Number(frames) || 0));
  const totalSec = Math.floor(f / FPS);
  const ss = totalSec % 60;
  const mm = Math.floor(totalSec / 60) % 60;
  const hh = Math.floor(totalSec / 3600);
  return pad2(hh) + ":" + pad2(mm) + ":" + pad2(ss) + ":" + pad2(f % FPS);
}

function fmtSeconds(seconds) {
  const s = Math.max(0, Number(seconds) || 0);
  if (s < 60) return s.toFixed(2) + " s";
  const m = Math.floor(s / 60);
  if (m < 60) return m + " min " + (s - m * 60).toFixed(0) + " s";
  return Math.floor(m / 60) + " h " + (m % 60) + " min";
}

/* -------------------------------------------------------- timeline model */

/* ------------------------------------------------------------ entity kinds */

/**
 * Reference-image kinds, mapped to the Minimax subject_definitions skill
 * (src/gen_ab_workflows.py:5-60): every typed slot becomes one
 * "<Subject N> is <Picture K> ..." line at the head of the prompt, so the
 * identity lock sentence is always present instead of being retyped by hand.
 */
const ENTITY_KINDS = [
  { id: "character", zh: "\u89d2\u8272", en: "Character" },
  { id: "background", zh: "\u80cc\u666f", en: "Background" },
  { id: "prop", zh: "\u9053\u5177", en: "Prop" },
  { id: "style", zh: "\u98ce\u683c", en: "Style" },
  { id: "other", zh: "\u5176\u4ed6", en: "Other" },
];

function entityKindLabel(id) {
  for (let i = 0; i < ENTITY_KINDS.length; i++) {
    if (ENTITY_KINDS[i].id === id) return PANEL_LANG === "en" ? ENTITY_KINDS[i].en : ENTITY_KINDS[i].zh;
  }
  return PANEL_LANG === "en" ? "Other" : "\u5176\u4ed6";
}

function normalizeRefTypes(raw) {
  const out = [];
  const src = isArray(raw) ? raw : [];
  for (let i = 0; i < src.length; i++) out.push(typeof src[i] === "string" ? src[i] : "");
  return out;
}

function refTypeAt(shot, index) {
  if (!shot) return "";
  const list = shot.refTypes || [];
  const v = list[index];
  return typeof v === "string" ? v : "";
}

/** Build the subject lines for every typed + filled image slot. */
const ENTITY_TEMPLATES = {
  zh: {
    character: function (sub, pic) {
      return sub + " 是 " + pic + " 参考图中的主要角色，提供身份、发型、面部特征与服装配色；必须以参考图组为唯一身份基准，全程不得改变五官、发型与主色。";
    },
    background: function (sub, pic) {
      return sub + " 是 " + pic + " 参考图中的场景环境，提供空间结构、材质、光源方向与色调；镜头运动不得破坏该空间的透视与光照逻辑。";
    },
    prop: function (sub, pic) {
      return sub + " 是 " + pic + " 参考图中的关键道具，提供外形、材质与磨损细节；与角色互动时保持尺寸比例与握持方式一致。";
    },
    style: function (sub, pic) {
      return sub + " 取自 " + pic + " 参考图中的画风与调色，提供线条、笔触、对比度与色彩倾向；只继承表现手法，不继承画面内容。";
    },
    other: function (sub, pic) {
      return sub + " 是 " + pic + " 参考图中的补充元素，提供画面中需要跨镜头保持一致的其他细节；不得改变其外形与配色。";
    },
  },
  en: {
    character: function (sub, pic) {
      return sub + " is the main character in " + pic + " and supplies identity, hairstyle, facial features and wardrobe colours; the reference group is the only identity anchor, so facial features, hair and dominant colours must not change at any point.";
    },
    background: function (sub, pic) {
      return sub + " is the environment in " + pic + " and supplies spatial layout, surface materials, light direction and colour grade; camera movement must not break the perspective or lighting logic of that space.";
    },
    prop: function (sub, pic) {
      return sub + " is the key prop in " + pic + " and supplies silhouette, material and wear detail; whenever a character handles it, scale and grip must stay consistent.";
    },
    style: function (sub, pic) {
      return sub + " carries the drawing style and grade of " + pic + " and supplies line quality, brushwork, contrast and colour bias; only the rendering technique is inherited, never the depicted content.";
    },
    other: function (sub, pic) {
      return sub + " is an additional element from " + pic + " and supplies supporting detail that must stay consistent across shots; its shape and colours must not drift.";
    },
  },
};

/** Build the subject lines for every typed + filled image slot. */
function entityLines(shot) {
  const lines = [];
  if (!shot) return lines;
  const table = PANEL_LANG === "en" ? ENTITY_TEMPLATES.en : ENTITY_TEMPLATES.zh;
  const refs = isArray(shot.refs) ? shot.refs : [];
  let subject = 0;
  for (let i = 0; i < refs.length; i++) {
    if (!refs[i]) continue;
    const kind = refTypeAt(shot, i);
    if (!kind) continue;
    subject += 1;
    const pic = "<Picture " + (i + 1) + ">";
    const sub = "<Subject " + subject + ">";
    const fn = table[kind] || table.other;
    lines.push(fn(sub, pic));
  }
  return lines;
}

/** Drop previously generated subject lines so a rewrite is idempotent. */
function stripEntityLines(text) {
  const rows = String(text || "").split(/\r?\n/);
  const keep = [];
  for (let i = 0; i < rows.length; i++) {
    const line = rows[i].trim();
    if (/^<Subject\s+\d+>/.test(line)) continue;
    if (/^<Picture\s+\d+>\s*(\u662f|\u63d0\u4f9b|\u53d6\u81ea)/.test(line)) continue;
    keep.push(rows[i]);
  }
  while (keep.length && !keep[0].trim()) keep.shift();
  return keep.join("\n");
}

/** Rewrite the subject block from the current slots, keep the author's body. */
function rebuildEntities(shot) {
  if (!shot) return "";
  const lines = entityLines(shot);
  const body = stripEntityLines(shot.prompt).replace(/^\n+/, "");
  const head = lines.join("\n");
  shot.prompt = head ? (body ? head + "\n\n" + body : head) : body;
  return shot.prompt;
}

/**
 * One shot = one generated segment. seconds is authoritative (docs/81
 * timeline_data); every number the panel shows is derived from the shots,
 * never from a hard-coded wall clock.
 */
const OVERRIDE_KEYS = ["steps", "solver", "shift_video", "shift_audio", "pass2_steps"];

/** Keep only the keys src/dsd/plan.py honours, dropping empty values. */
function normalizeOverrides(raw) {
  const out = {};
  if (!raw || typeof raw !== "object" || isArray(raw)) return out;
  for (let i = 0; i < OVERRIDE_KEYS.length; i++) {
    const k = OVERRIDE_KEYS[i];
    const v = raw[k];
    if (v === undefined || v === null || v === "") continue;
    out[k] = v;
  }
  return out;
}

function overrideCount(shot) {
  const ov = normalizeOverrides(shot && shot.overrides);
  let n = 0;
  for (let i = 0; i < OVERRIDE_KEYS.length; i++) {
    if (ov[OVERRIDE_KEYS[i]] !== undefined) n += 1;
  }
  return n;
}

function cloneShot(raw) {
  const s = raw && typeof raw === "object" ? raw : {};
  const secs = Number(s.seconds);
  return {
    id: typeof s.id === "string" && s.id ? s.id : "",
    seconds: secs > 0 ? secs : DEFAULT_SHOT_SECONDS,
    prompt: typeof s.prompt === "string" ? s.prompt : "",
    refs: isArray(s.refs) ? s.refs.slice() : [],
    refVideos: isArray(s.refVideos) ? s.refVideos.slice() : [],
    refAudios: isArray(s.refAudios) ? s.refAudios.slice() : [],
    motionExpect: s.motionExpect === undefined || s.motionExpect === null ? 1.0 : s.motionExpect,
    refTypes: normalizeRefTypes(s.refTypes),
    overrides: normalizeOverrides(s.overrides),
    seed: s.seed === undefined ? null : s.seed,
    note: typeof s.note === "string" ? s.note : "",
  };
}

function defaultTimeline(fallbackFrames) {
  const frames = Math.max(MIN_SHOT_FRAMES, Math.round(Number(fallbackFrames) || 124));
  const shot = cloneShot(null);
  shot.id = "s1";
  shot.seconds = Math.round((frames / FPS) * 10000) / 10000;
  return { v: 2, fps: FPS, shots: [shot] };
}

function parseTimeline(raw, fallbackFrames) {
  let obj = null;
  try {
    if (typeof raw === "string") obj = raw.trim() ? JSON.parse(raw) : null;
    else if (raw && typeof raw === "object") obj = raw;
  } catch (err) {
    console.warn("[DSD.DirectorPanel] timeline_data is not valid JSON, using default:", err);
    obj = null;
  }
  if (!obj || !isArray(obj.shots) || !obj.shots.length) return defaultTimeline(fallbackFrames);
  const shots = obj.shots.map(cloneShot);
  for (let i = 0; i < shots.length; i++) {
    if (!shots[i].id) shots[i].id = "s" + (i + 1);
  }
  return { v: 2, fps: FPS, shots: shots };
}

function shotFrames(shot) {
  const secs = Number(shot && shot.seconds);
  const frames = Math.round((Number.isFinite(secs) ? secs : DEFAULT_SHOT_SECONDS) * FPS);
  return Math.max(MIN_SHOT_FRAMES, frames);
}

function timelineFrames(tl) {
  if (!tl || !isArray(tl.shots) || !tl.shots.length) return 0;
  let total = 0;
  for (let i = 0; i < tl.shots.length; i++) total += shotFrames(tl.shots[i]);
  return total;
}

/** Model windows needed for one segment of n frames at (window, context). */
function windowsFor(frames, win, ctx) {
  const w = Math.max(1, Math.round(Number(win) || 124));
  const c = Math.max(0, Math.min(Math.round(Number(ctx) || 0), w - 1));
  const n = Math.max(1, Math.round(Number(frames) || w));
  if (n <= w) return 1;
  return 1 + Math.ceil((n - w) / Math.max(1, w - c));
}

function presetWall(name) {
  for (let i = 0; i < PRESETS.length; i++) {
    if (PRESETS[i].name === name) return PRESETS[i].wall;
  }
  return null;
}

/* --------------------------------------------------------- wall clock */

/* Measured per-segment seconds, keyed "<gen_w>x<gen_h>@<upscale>". The panel
   only ever displays a number it either measured from dsd_progress or took
   from the documented 124-frame reference run (labelled as an estimate). */
const WALL_KEY = "dsd.panel.wall.v1";

function nowMs() {
  if (typeof performance !== "undefined" && performance && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
}

/** Metrics the measured run used: "<gen_w>x<gen_h>@<upscale>". */
function wallStoreKey(node) {
  const gw = Math.round(numWidget(node, "gen_w", 0));
  const gh = Math.round(numWidget(node, "gen_h", 0));
  return gw + "x" + gh + "@" + String(widgetValue(node, "upscale", "") || "");
}

function readWallStore() {
  try {
    if (!window.localStorage) return {};
    const raw = window.localStorage.getItem(WALL_KEY);
    if (!raw) return {};
    const obj = JSON.parse(raw);
    return obj && typeof obj === "object" ? obj : {};
  } catch (err) {
    console.warn("[DSD.DirectorPanel] wall store unreadable:", err);
    return {};
  }
}

function writeWallStore(store) {
  try {
    if (window.localStorage) window.localStorage.setItem(WALL_KEY, JSON.stringify(store));
  } catch (err) {
    console.warn("[DSD.DirectorPanel] wall store not writable:", err);
  }
}

/** Measured seconds per segment for this geometry; null means "not measured". */
function measuredWall(node) {
  const entry = readWallStore()[wallStoreKey(node)];
  const secs = entry ? Number(entry.seg_s) : NaN;
  return Number.isFinite(secs) && secs > 0 ? secs : null;
}

/** segment_done carries note "168.5s"; only a parsed number is persisted. */
function recordSegmentSeconds(ctx, note) {
  const secs = parseFloat(String(note === undefined || note === null ? "" : note));
  if (!Number.isFinite(secs) || secs <= 0) return null;
  ctx.lastSegSeconds = secs;
  const store = readWallStore();
  const key = wallStoreKey(ctx.node);
  const prev = store[key] || null;
  const entry = { seg_s: Math.round(secs * 10) / 10, updated: Date.now() };
  if (prev && Number(prev.wall_s) > 0) entry.wall_s = prev.wall_s;
  store[key] = entry;
  writeWallStore(store);
  return entry;
}

/** Whole-run wall clock, measured from the run button to the "done" event. */
function finishWallClock(ctx) {
  if (!ctx || !ctx.runT0) return null;
  const secs = Math.max(0, (nowMs() - ctx.runT0) / 1000);
  ctx.runT0 = 0;
  ctx.lastRunWall = secs;
  const store = readWallStore();
  const key = wallStoreKey(ctx.node);
  const entry = store[key] || {};
  entry.wall_s = Math.round(secs * 10) / 10;
  entry.updated = Date.now();
  store[key] = entry;
  writeWallStore(store);
  return secs;
}

/** Persist the timeline into timeline_data (+ total_frames). */
function writeTimeline(node, tl) {
  const total = timelineFrames(tl);
  const wrote = setWidgetValue(node, "timeline_data", JSON.stringify(tl));
  setWidgetValue(node, "total_frames", total);
  if (!wrote) {
    // Backend node is older than this panel (B0): keep editing in memory so the
    // UI stays usable, and let the banner explain why nothing is persisted.
    node.dsdTimelineCache = JSON.stringify(tl);
  }
  return { total: total, wrote: wrote };
}

/* ------------------------------------------------- history (undo / redo) */

/* Per-panel undo stacks. A snapshot is the whole timeline plus the selection,
   stored as the exact JSON that would have been written to the widget, so a
   restore cannot drift from what the node last saw. Capped at HIST_MAX so a
   long editing session cannot grow without bound. */
const HIST_MAX = 40;

function snapNow(ctx) {
  return JSON.stringify({ tl: ctx.tl, cur: ctx.cur });
}

function pushHistory(ctx) {
  if (!ctx || !isArray(ctx.history)) return;
  ctx.history.push(snapNow(ctx));
  while (ctx.history.length > HIST_MAX) ctx.history.shift();
  if (isArray(ctx.future)) ctx.future.length = 0;
}

/** Snapshot before a focus-driven edit (typing in the prompt textarea). */
function beginEdit(ctx) {
  ctx.editSnap = snapNow(ctx);
}

/** Only a real change between focus and blur becomes an undo step. */
function endEdit(ctx) {
  if (!ctx || !ctx.editSnap) return;
  if (ctx.editSnap !== snapNow(ctx)) {
    if (!isArray(ctx.history)) ctx.history = [];
    ctx.history.push(ctx.editSnap);
    while (ctx.history.length > HIST_MAX) ctx.history.shift();
    if (isArray(ctx.future)) ctx.future.length = 0;
  }
  ctx.editSnap = null;
}

function restoreSnap(ctx, raw) {
  let obj = null;
  try {
    obj = JSON.parse(raw);
  } catch (err) {
    obj = null;
  }
  if (!obj) return false;
  ctx.tl = parseTimeline(obj.tl || {}, numWidget(ctx.node, "total_frames", 124));
  ctx.cur = clampNum(obj.cur, 0, Math.max(0, ctx.tl.shots.length - 1));
  ctx.playFrame = shotStartFrame(ctx.tl, ctx.cur);
  commit(ctx);
  return true;
}

function undo(ctx) {
  if (!isArray(ctx.history) || !ctx.history.length) {
    setNotice(ctx, t("undoEmpty"));
    return false;
  }
  if (!isArray(ctx.future)) ctx.future = [];
  ctx.future.push(snapNow(ctx));
  const raw = ctx.history.pop();
  restoreSnap(ctx, raw);
  setNotice(ctx, t("undoDone"));
  return true;
}

function redo(ctx) {
  if (!isArray(ctx.future) || !ctx.future.length) {
    setNotice(ctx, t("redoEmpty"));
    return false;
  }
  if (!isArray(ctx.history)) ctx.history = [];
  ctx.history.push(snapNow(ctx));
  const raw = ctx.future.pop();
  restoreSnap(ctx, raw);
  setNotice(ctx, t("redoDone"));
  return true;
}

/** Grey out a toolbar button whose stack is empty. */
function dimBtn(btn, empty) {
  if (!btn) return;
  btn.classList.toggle("dsd-off", !!empty);
  btn.setAttribute("aria-disabled", empty ? "true" : "false");
}

/* ------------------------------------------------------ save-state badge */

function markSaved(ctx) {
  ctx.lastSaved = JSON.stringify(ctx.tl);
}

function updateSaveBadge(ctx) {
  const badge = ctx.els && ctx.els.saveBadge;
  if (!badge) return;
  let dirty = false;
  try {
    dirty = JSON.stringify(ctx.tl) !== ctx.lastSaved;
  } catch (err) {
    dirty = true;
  }
  badge.textContent = dirty ? t("saveDirty") : t("saveClean");
  badge.classList.toggle("dsd-badge-dirty", dirty);
  badge.classList.toggle("dsd-badge-ok", !dirty);
}

/* ------------------------------------------------------- cost estimate */

/* Rough peak-VRAM model. NOT a measurement of the model itself: a linear fit
   over a handful of runs on the user's 8 GB card, kept in one place so the
   numbers can be re-fitted without touching the UI. It exists to warn "this
   will not fit", never to promise a number. */
const COST_VRAM = {
  baseGb: 3.20,           // transformer weights + text encoder resident
  perGenMpGb: 1.15,       // first-pass latent / VAE cost per output megapixel
  perPass2MpGb: 0.55,     // refine model resident, per final megapixel
  alignOverheadGb: 0.35,  // 32-px padding plus decode buffers
};

function estimateVram(node) {
  const gw = Math.max(1, numWidget(node, "gen_w", 1376));
  const gh = Math.max(1, numWidget(node, "gen_h", 768));
  const up = Math.max(1, Number(widgetValue(node, "upscale", "1.0")) || 1);
  const pass2 = !!widgetValue(node, "pass2", true);
  const genMp = (gw * gh) / 1000000;
  const finW = align32(gw * up) || gw;
  const finH = align32(gh * up) || gh;
  const finMp = (finW * finH) / 1000000;
  const v = COST_VRAM.baseGb + COST_VRAM.perGenMpGb * genMp +
    (pass2 ? COST_VRAM.perPass2MpGb * finMp : 0) + COST_VRAM.alignOverheadGb;
  return Math.round(v * 10) / 10;
}

/** Wall clock for the whole timeline: measured beats the preset table. */
function estimateWall(node, tl) {
  const segs = Math.max(1, (tl && tl.shots ? tl.shots.length : 1));
  const frames = timelineFrames(tl);
  const measured = measuredWall(node);
  if (measured !== null) return { seconds: measured * segs, segs: segs, measured: true };
  const each = presetWall(String(widgetValue(node, "preset", "")));
  if (each === null) return { seconds: null, segs: segs, measured: false };
  return { seconds: (each / 124) * frames, segs: segs, measured: false };
}

/* ----------------------------------------------------------- run log */

const RUNLOG_MAX = 12;

/** One line per distinct progress event; a duplicate inside 300 ms is a
 *  repaint of the same event and is dropped. */
function logRun(ctx, phase, note, seg) {
  if (!isArray(ctx.runLog)) ctx.runLog = [];
  const key = String(phase || "");
  const noteText = String(note === undefined || note === null ? "" : note);
  const last = ctx.runLog[0];
  if (last && last.phase === key && last.note === noteText && last.seg === seg &&
    nowMs() - last.ms < 300) return;
  ctx.runLog.unshift({ ms: nowMs(), phase: key, note: noteText, seg: seg });
  while (ctx.runLog.length > RUNLOG_MAX) ctx.runLog.pop();
  paintRunLog(ctx);
}

function paintRunLog(ctx) {
  const box = ctx.els && ctx.els.logBox;
  if (!box) return;
  clearNode(box);
  if (!isArray(ctx.runLog) || !ctx.runLog.length) {
    box.appendChild(el("div", "dsd-log-empty", t("logEmpty")));
    return;
  }
  for (let i = 0; i < ctx.runLog.length; i++) {
    const it = ctx.runLog[i];
    const d = new Date(it.ms);
    const hh = pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + ":" + pad2(d.getSeconds());
    let line = hh + "  " + phaseLabel(it.phase);
    if (it.note) line += " \u00b7 " + it.note;
    box.appendChild(el("div", "dsd-log-line", line));
  }
}

/* ------------------------------------------------ prompt section chips */

const PROMPT_SECTIONS = [
  "subject_definitions",
  "quality_and_style",
  "style_and_color_science",
  "negative_constraints",
  "summary",
  "retention_analysis",
  "detailed_description",
  "camera_and_material",
];

const PROMPT_SECTION_HINT = {
  subject_definitions: "secHintSubject",
  quality_and_style: "secHintQuality",
  style_and_color_science: "secHintColor",
  negative_constraints: "secHintNegative",
  summary: "secHintSummary",
  retention_analysis: "secHintRetention",
  detailed_description: "secHintDetail",
  camera_and_material: "secHintCamera",
};

/** A section counts as present when its name appears anywhere, any case. */
function hasSection(prompt, name) {
  const p = String(prompt || "").toLowerCase();
  return p.indexOf(String(name).toLowerCase()) >= 0;
}

function sectionSkeleton(name) {
  const hint = t(PROMPT_SECTION_HINT[name] || "secLine");
  return String(name) + ":\n    " + hint + "\n";
}

function minCharsFor(node) {
  return widgetValue(node, "strict", false) ? 3000 : 1200;
}

/* ------------------------------------------------------ collapsible secs */

function secStoreKey(name) {
  return "dsdp.sec." + name;
}

function readSecCollapsed(name) {
  let v = null;
  safe(function () {
    v = window.localStorage ? window.localStorage.getItem(secStoreKey(name)) : null;
  }, "read section state");
  return v === "1";
}

function writeSecCollapsed(name, collapsed) {
  safe(function () {
    if (window.localStorage) window.localStorage.setItem(secStoreKey(name), collapsed ? "1" : "0");
  }, "write section state");
}

/** Header + body wrapper; clicking the header toggles and persists. */
function collapsible(ctx, name, titleText, body, opts) {
  const o = opts || {};
  const box = el("div", "dsd-sec" + (o.cls ? " " + o.cls : ""));
  const head = el("div", "dsd-sec-head");
  const tri = el("span", "dsd-tri", "\u25b8");
  head.appendChild(tri);
  head.appendChild(el("span", null, titleText));
  box.appendChild(head);
  const inner = el("div", "dsd-sec-body");
  inner.appendChild(body);
  box.appendChild(inner);
  const start = readSecCollapsed(name);
  box.classList.toggle("collapsed", start);
  head.onclick = function () {
    const next = !box.classList.contains("collapsed");
    box.classList.toggle("collapsed", next);
    writeSecCollapsed(name, next);
  };
  return box;
}

/* --------------------------------------------------- inline confirm bar */

/** Generic two-button confirm used by the shot card (never alert/confirm). */
function showShotConfirm(ctx, text, label, fn) {
  const bar = ctx.els && ctx.els.shotConfirmBar;
  if (!bar) {
    safe(fn, "confirm without bar");
    return;
  }
  ctx.shotConfirmFn = fn;
  if (ctx.els.shotConfirmText) ctx.els.shotConfirmText.textContent = text;
  if (ctx.els.shotConfirmYes) ctx.els.shotConfirmYes.textContent = label;
  bar.classList.add("show");
}

function hideShotConfirm(ctx) {
  ctx.shotConfirmFn = null;
  if (ctx.els && ctx.els.shotConfirmBar) ctx.els.shotConfirmBar.classList.remove("show");
}

/* --------------------------------------------- shot move / dup / copy */

function newShotId(ctx, index) {
  return "s" + (index + 1) + "-" + Date.now().toString(36);
}

function moveShot(ctx, delta) {
  const shots = ctx.tl.shots;
  const i = clampNum(ctx.cur, 0, shots.length - 1);
  const j = i + delta;
  if (j < 0) {
    setNotice(ctx, t("moveFirst"));
    return false;
  }
  if (j >= shots.length) {
    setNotice(ctx, t("moveLast"));
    return false;
  }
  pushHistory(ctx);
  const moved = shots.splice(i, 1)[0];
  shots.splice(j, 0, moved);
  ctx.cur = j;
  ctx.playFrame = shotStartFrame(ctx.tl, j);
  commit(ctx);
  setNotice(ctx, t("moveDone"));
  return true;
}

function duplicateShot(ctx) {
  const shots = ctx.tl.shots;
  const i = clampNum(ctx.cur, 0, shots.length - 1);
  const src = shots[i];
  if (!src) return null;
  pushHistory(ctx);
  const copy = cloneShot(src);
  copy.id = newShotId(ctx, i + 1);
  shots.splice(i + 1, 0, copy);
  ctx.cur = i + 1;
  ctx.playFrame = shotStartFrame(ctx.tl, i + 1);
  commit(ctx);
  setNotice(ctx, t("dupDone"));
  return copy;
}

function copyPrevShot(ctx) {
  const shots = ctx.tl.shots;
  const i = clampNum(ctx.cur, 0, shots.length - 1);
  if (i <= 0) {
    setNotice(ctx, t("usePrevFirst"));
    return false;
  }
  const prev = shots[i - 1];
  const shot = shots[i];
  if (!prev || !shot) return false;
  pushHistory(ctx);
  shot.prompt = prev.prompt;
  shot.refs = isArray(prev.refs) ? prev.refs.slice() : [];
  shot.refVideos = isArray(prev.refVideos) ? prev.refVideos.slice() : [];
  shot.refAudios = isArray(prev.refAudios) ? prev.refAudios.slice() : [];
  shot.refTypes = isArray(prev.refTypes) ? prev.refTypes.slice() : [];
  commit(ctx);
  setNotice(ctx, t("usePrevDone"));
  return true;
}

function clearShotRefs(ctx) {
  const shot = ctxShot(ctx);
  if (!shot) return false;
  pushHistory(ctx);
  shot.refs = [];
  shot.refVideos = [];
  shot.refAudios = [];
  shot.refTypes = [];
  commit(ctx);
  setNotice(ctx, t("clearRefsDone"));
  return true;
}

/* ------------------------------------------------ per-shot import/export */

function exportShotFile(ctx) {
  const shot = ctxShot(ctx);
  if (!shot) return false;
  const i = clampNum(ctx.cur, 0, ctx.tl.shots.length - 1);
  const payload = JSON.stringify({ v: 1, kind: "dsd-shot", shot: shot }, null, 2);
  const name = "dsd-shot-" + (i + 1) + "-" + (shot.id || "shot") + ".json";
  const blob = new Blob([payload], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  setTimeout(function () {
    safe(function () {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, "revoke shot blob");
  }, 0);
  setNotice(ctx, t("shotOutDone"));
  return true;
}

function importShotPayload(ctx, text) {
  let obj = null;
  try {
    obj = JSON.parse(String(text || ""));
  } catch (err) {
    setNotice(ctx, t("shotInFail") + String((err && err.message) || err));
    return false;
  }
  const raw = obj && obj.shot ? obj.shot : obj;
  if (!raw || typeof raw !== "object" || isArray(raw) || typeof raw.prompt !== "string") {
    setNotice(ctx, t("shotInFail") + "no prompt");
    return false;
  }
  const shot = ctxShot(ctx);
  if (!shot) return false;
  pushHistory(ctx);
  const keepId = shot.id;
  const next = cloneShot(raw);
  next.id = keepId;
  const i = clampNum(ctx.cur, 0, ctx.tl.shots.length - 1);
  ctx.tl.shots[i] = next;
  commit(ctx);
  setNotice(ctx, t("shotInDone"));
  return true;
}

function importShotFile(ctx) {
  const picker = ctx.els && ctx.els.shotPicker;
  if (!picker) return;
  picker.value = "";
  picker.click();
}

/* ------------------------------------------------------ drag to reorder */

/** Insertion slot (0..n) for a pointer x over the shot blocks. */
function reorderSlot(bounds, x) {
  let slot = 0;
  for (let i = 0; i < bounds.length; i++) {
    const mid = (bounds[i].x0 + bounds[i].x1) / 2;
    if (x > mid) slot = i + 1;
    else break;
  }
  return slot;
}

function moveShotTo(ctx, from, slot) {
  const shots = ctx.tl.shots;
  if (from < 0 || from >= shots.length) return false;
  let to = slot;
  if (to > from) to -= 1;
  to = clampNum(to, 0, shots.length - 1);
  if (to === from) return false;
  pushHistory(ctx);
  const item = shots.splice(from, 1)[0];
  shots.splice(to, 0, item);
  ctx.cur = to;
  ctx.playFrame = shotStartFrame(ctx.tl, to);
  commit(ctx);
  setNotice(ctx, t("moveDone"));
  return true;
}

/* ------------------------------------------------------------------ i18n */

const I18N = {
  runAll: ["运行全部", "Run all"],
  refresh: ["刷新面板", "Refresh"],
  reseg: ["重算分段", "Re-split"],
  importTpl: ["导入模板", "Import"],
  exportTpl: ["导出模板", "Export"],
  stageEmpty: ["预览台：本镜还没有参考素材", "Stage: no reference for this shot yet"],
  notPlaying: ["暂停", "Paused"],
  playing: ["播放中", "Playing"],
  play: ["播放", "Play"],
  pause: ["暂停", "Pause"],
  goto: ["跳转", "Go"],
  frameLbl: ["帧", "Frame"],
  tcLbl: ["时间码", "Timecode"],
  tlHint: ["拖青色分割点改本镜时长 · 双击镜头块在此切分 · 右键镜头删镜", "Drag a cyan boundary to retime · double-click a shot to split it there · right-click a shot to delete"],
  delTitle: ["删除镜头？", "Delete shot?"],
  delBody: ["该镜的提示词与参考素材会一起移除。", "Its prompt and reference assets are removed too."],
  del: ["删除", "Delete"],
  cancel: ["取消", "Cancel"],
  addDone: ["已新增一镜，共 ", "Added a shot, total "],
  shortShot: ["镜头太短，无法再分。", "Shot too short to split."],
  segLbl: ["段数", "Segments"],
  netLbl: ["每段净增", "Net / seg"],
  framesLbl: ["总帧", "Frames"],
  durLbl: ["时长", "Duration"],
  wallLbl: ["墙钟", "Wall"],
  wallUnknown: ["未实测", "not measured"],
  winLbl: ["窗口", "Window"],
  ctxLbl: ["上下文", "Context"],
  outLbl: ["交付", "Delivery"],
  genLbl: ["一采", "First pass"],
  upLbl: ["放大", "Upscale"],
  unsharpLbl: ["锐化", "Unsharp"],
  derivedLbl: ["推算", "derived"],
  shotLbl: ["镜", "Shot"],
  prevShot: ["上一镜", "Prev"],
  nextShot: ["下一镜", "Next"],
  imgTitle: ["参考图 1-9", "Refs 1-9"],
  vidTitle: ["参考视频 1-3", "Video 1-3"],
  audTitle: ["参考音频 1-3", "Audio 1-3"],
  promptLbl: ["提示词 → shots[i].prompt", "Prompt -> shots[i].prompt"],
  promptHint: ["写本镜画面描述，可用 <Picture 1> 这样的引用", "Describe this shot; <Picture 1> references are allowed"],
  slotEmpty: ["上传", "Upload"],
  uploading: ["上传中…", "Uploading..."],
  removeLbl: ["移除", "Remove"],
  outHLbl: ["交付高", "Delivery H"],
  genHLbl: ["一采高", "First-pass H"],
  presetLbl: ["预设", "Preset"],
  presetNote: ["点一下写回整套参数，不触发渲染", "Writes the full parameter set; never queues a run"],
  statusIdle: ["待命", "Idle"],
  statusQueued: ["已入队，等后端回报进度", "Queued - waiting for backend progress"],
  statusRunning: ["运行中", "Running"],
  statusDone: ["完成", "Done"],
  overallLbl: ["总段", "Overall"],
  segBarLbl: ["当前段", "Segment"],
  errLbl: ["错误", "Error"],
  bannerA: ["后端节点版本较旧（缺 ", "Backend node is older than this panel (missing "],
  bannerB: ["），请重启 ComfyUI", ") - restart ComfyUI"],
  tplIn: ["模板已导入", "Template imported"],
  tplInFail: ["模板导入失败：", "Template import failed: "],
  tplOut: ["模板已导出", "Template exported"],
  upFail: ["上传失败：", "Upload failed: "],
  queueFail: ["入队失败：", "Queue failed: "],
  noQueue: ["找不到 app.queuePrompt，无法入队", "app.queuePrompt is unavailable"],
  resegDone: ["已按 total_frames 重算", "Re-split from total_frames"],
  warn32: ["不是 32 的倍数", "not a multiple of 32"],
  warnFinal: ["final 与 gen×放大 不一致", "final does not match gen x upscale"],
  warnPass2: ["pass2 关闭，放大不生效", "pass2 is off, upscale has no effect"],
  phaseSample: ["采样", "sample"],
  phaseDecode: ["解码", "decode"],
  phaseStart: ["准备", "start"],
  phaseSegmentStart: ["分段开始", "segment start"],
  phaseSampleStep: ["采样步进", "sampling"],
  phaseSegmentDone: ["分段完成", "segment done"],
  phasePass2: ["超分", "pass2"],
  phaseUnsharp: ["锐化", "unsharp"],
  phaseResize: ["缩放", "resize"],
  phaseDone: ["完成", "done"],
  addShot: ["新增镜头", "Add shot"],
  addShotHint: ["在时间轴末尾追加一镜，新镜自带一套参考与提示词槽", "Append a shot with its own refs and prompt"],
  typeLbl: ["参考图类型", "Ref kind"],
  typeNone: ["未选", "none"],
  typeEmpty: ["先上传参考图，再选类型", "Upload a reference image first"],
  typeHint: ["类型决定写进提示词的 <Subject N> 实体说明句式", "The kind decides which <Subject N> line is written"],
  regenEntities: ["重写实体说明", "Rewrite subjects"],
  entitiesDone: ["实体说明已写入提示词", "Subject lines written into the prompt"],
  curLbl: ["当前镜", "Current"],
  curFramesLbl: ["本镜帧", "Shot frames"],
  curDurLbl: ["本镜时长", "Shot duration"],
  curTcLbl: ["时间码", "Timecode"],
  curFramesEdit: ["改本镜帧数后回车", "Edit the shot frame count"],
  warnFix: ["（建议点预设重算）", "(click a preset to fix)"],
  splitShot: ["在播放头处切分", "Split at playhead"],
  splitDone: ["已切分镜头", "Shot split"],
  stageRef: ["看参考", "Refs"],
  stageRender: ["看成片", "Render"],
  noRenderYet: ["还没有跑过", "No render yet"],
  wallSegSuffix: [" 段", " seg"],
  preflightBtn: ["体检", "Lint"],  preflightHint: ["提交前检查提示词与时间线（不触发渲染）", "Lint prompts and timeline before rendering"],  pfRunning: ["体检中...", "Linting..."],  pfNoApi: ["面板未连上 ComfyUI API，无法体检", "Panel is not connected to the ComfyUI API"],  pfClean: ["体检通过：没有发现问题", "Lint passed: no issues"],  pfHasErr: ["体检发现错误", "Lint found errors"],  pfHasWarn: ["警告", "warnings"],  pfBlocked: ["体检通过，但仍有阻断项（strict 时会在渲染报错）", "Lint passed but blocking issues remain"],  pfFail: ["体检请求失败：", "Lint request failed: "],  phaseExport: ["导出时间线", "export timeline"],
  wallMeasured: ["实测", "measured"],
  ovrLbl: ["镜头参数覆盖", "Per-shot overrides"],
  ovrHint: ["留空 = 继承全局值；改动只影响本镜", "Blank inherits the global value; changes apply to this shot only"],
  ovrSteps: ["步数", "steps"],
  ovrSolver: ["求解器", "solver"],
  ovrSv: ["视频 shift", "video shift"],
  ovrSa: ["音频 shift", "audio shift"],
  ovrP2: ["二采步数", "refine steps"],
  ovrInherit: ["继承", "inherit"],
  ovrClear: ["清除本镜覆盖", "Clear overrides"],
  ovrDone: ["已清除本镜覆盖", "Overrides cleared"],
  ovrHas: ["已覆盖", "set"],
  ovrNone: ["全部继承全局", "everything inherited"],
  wallEst: ["估算", "estimate"],
  undo: ["撤销", "Undo"],
  redo: ["重做", "Redo"],
  undoEmpty: ["没有可撤销的操作", "Nothing to undo"],
  redoEmpty: ["没有可重做的操作", "Nothing to redo"],
  undoDone: ["已撤销", "Undone"],
  redoDone: ["已重做", "Redone"],
  saveDirty: ["未保存", "Unsaved"],
  saveClean: ["已同步", "Synced"],
  movePrev: ["\u25c0 前移", "\u25c0 Up"],
  moveNext: ["后移 \u25b6", "Down \u25b6"],
  moveFirst: ["已经是第一镜", "Already the first shot"],
  moveLast: ["已经是最后一镜", "Already the last shot"],
  moveDone: ["已移动镜头", "Shot moved"],
  dupShot: ["复制本镜", "Duplicate"],
  dupDone: ["已复制本镜", "Shot duplicated"],
  usePrev: ["沿用上一镜", "Copy previous"],
  usePrevAsk: ["沿用上一镜的提示词与参考素材？", "Copy the previous shot prompt and references?"],
  usePrevYes: ["沿用", "Copy"],
  usePrevDone: ["已沿用上一镜", "Copied from the previous shot"],
  delShot: ["删除本镜", "Delete shot"],
  delShotHint: ["删除当前镜头，会先要求确认", "Delete the current shot after a confirm"],
  usePrevFirst: ["已是第一镜，没有上一镜可沿用", "First shot; nothing to copy"],
  clearRefs: ["清空本镜参考", "Clear references"],
  clearRefsAsk: ["清空本镜的参考图、视频、音频？", "Remove this shot reference images, videos and audio?"],
  clearRefsYes: ["清空", "Clear"],
  clearRefsDone: ["已清空本镜参考", "Shot references cleared"],
  exportShot: ["导出本镜", "Export shot"],
  importShot: ["导入本镜", "Import shot"],
  shotOutDone: ["已导出本镜 JSON", "Shot exported"],
  shotInDone: ["已导入本镜", "Shot imported"],
  shotInFail: ["镜头文件无法读取：", "Cannot read shot file: "],
  logTitle: ["运行日志", "Run log"],
  logEmpty: ["还没有进度事件", "No progress events yet"],
  secLine: ["在这里补充该段内容", "fill this section in"],
  secHintSubject: ["逐个描述主体外观与固定特征", "describe each subject and its fixed traits"],
  secHintQuality: ["画质与整体风格关键词", "quality and overall style keywords"],
  secHintColor: ["色彩科学与影调倾向", "color science and tonal bias"],
  secHintNegative: ["不要出现的元素", "what must not appear"],
  secHintSummary: ["一句话概括本镜", "one-line summary of this shot"],
  secHintRetention: ["需要保持一致的细节", "details that must stay consistent"],
  secHintDetail: ["镜头内动作与画面的详细描述", "detailed action and framing"],
  secHintCamera: ["机位运动与材质表现", "camera movement and materials"],
  secChipsLbl: ["提示词结构", "Prompt sections"],
  secChipOn: ["这一段已出现", "this section is present"],
  secChipOff: ["点击补上这一段骨架", "click to append this section skeleton"],
  secCountSuffix: ["/8", "/8"],
  meterUnit: ["字", "chars"],
  meterNeed: ["需要", "need"],
  guardFound: ["体检发现", "Lint found"],
  guardBlockers: ["个阻断项", "blocking issue(s)"],
  guardRun: ["仍然运行", "Run anyway"],
  guardCancel: ["取消", "Cancel"],
  guardEst: ["预计耗时", "Est. wall"],
  guardNoApi: ["体检连不上后端，已直接运行：", "Lint unreachable, running anyway: "],
  guardChecking: ["正在体检…", "Linting..."],
  helpTitle: ["快捷键", "Shortcuts"],
  helpClose: ["关闭", "Close"],
  helpKeys: ["按键", "Key"],
  helpActs: ["作用", "Action"],
  scPlay: ["播放 / 暂停", "Play / pause"],
  scStep: ["前后一帧", "Step one frame"],
  scStepSec: ["前后一秒", "Step one second"],
  scDel: ["删除当前镜头", "Delete the current shot"],
  scRun: ["运行全部", "Run all"],
  scUndo: ["撤销", "Undo"],
  scRedo: ["重做", "Redo"],
  scHelp: ["打开 / 关闭本表", "Toggle this help"],
  secRefsHdr: ["参考素材", "References"],
  secOutputHdr: ["输出参数", "Output"],
  secPresetHdr: ["预设", "Preset"],
  costWall: ["预计墙钟", "Est. wall"],
  costVram: ["预计峰值显存", "Peak VRAM"],
  costSegs: ["段", "segs"],
  costRough: ["粗估：按 8 GB 显卡实测拟合，不是承诺值", "rough: fitted on the 8 GB card, not a promise"],
  shotImportFail: ["导入失败：", "Import failed: "],
};


let PANEL_LANG = "zh";
safe(function () {
  const saved = window.localStorage ? window.localStorage.getItem(LANG_KEY) : null;
  if (saved === "en" || saved === "zh") PANEL_LANG = saved;
}, "read language");

function t(key) {
  const pair = I18N[key];
  if (!pair) return key;
  return PANEL_LANG === "en" ? pair[1] : pair[0];
}

function setLang(lang, node) {
  PANEL_LANG = lang === "en" ? "en" : "zh";
  safe(function () {
    window.localStorage.setItem(LANG_KEY, PANEL_LANG);
  }, "persist language");
  // Rebuild the panel in place so the whole surface switches language without
  // a full page reload (a reload would drop the unsaved graph).
  if (node) {
    safe(function () {
      rebuildPanel(node);
    }, "relabel panel");
  }
}

function el(tag, cls, text) {
  const d = document.createElement(tag);
  if (cls) d.className = cls;
  if (text !== undefined && text !== null) d.textContent = String(text);
  return d;
}

/** Remove every child without touching innerHTML (user prompts may contain "<"). */
function clearNode(node) {
  if (!node) return;
  while (node.firstChild) node.removeChild(node.firstChild);
}

/** Append "<i>label</i><b>value</b>" to a container, replacing its content. */
function kv(container, labelText, valueText, tagName) {
  clearNode(container);
  container.appendChild(el("i", null, labelText + " "));
  container.appendChild(el(tagName || "b", null, valueText));
}

/* --------------------------------------------------------------- styling */

const CSS = [
  ".dsd-panel{display:flex;flex-direction:column;gap:5px;width:100%;height:100%;box-sizing:border-box;",
  "font-family:ui-sans-serif,system-ui,-apple-system,sans-serif;color:#d8dce8;font-size:11px;",
  "background:#242424;border:1px solid #3a3a3a;border-radius:6px;padding:7px;overflow:hidden}",
  ".dsd-banner{background:#4a3a10;border:1px solid #b8860b;color:#ffd24a;border-radius:4px;",
  "padding:4px 7px;line-height:1.4}",
  ".dsd-bar{display:flex;align-items:center;gap:5px;background:#1a1a1a;border-radius:4px;padding:4px 5px;flex-wrap:wrap}",
  ".dsd-btn{background:#333;border:1px solid #454545;color:#d8dce8;border-radius:3px;padding:3px 7px;",
  "font-size:11px;cursor:pointer;line-height:1.35;font-family:inherit}",
  ".dsd-btn:hover{border-color:#29d3c9}",
  ".dsd-btn.dsd-primary{background:#1f6f5c;border-color:#29d3c9}",
  ".dsd-btn.dsd-on{background:#2b4f7a;border-color:#4a9eff;color:#eaf3ff}",
  ".dsd-spacer{flex:1 1 auto}",
  ".dsd-stage{position:relative;background:#101010;border:1px solid #333;border-radius:4px;height:150px;",
  "display:flex;align-items:center;justify-content:center;overflow:hidden;flex:0 0 auto}",
  ".dsd-stage video,.dsd-stage img{max-width:100%;max-height:100%;object-fit:contain;display:none}",
  ".dsd-stage.has-media video,.dsd-stage.has-media img{display:block}",
  ".dsd-stage.has-media .dsd-stage-empty{display:none}",
  ".dsd-stage-empty{color:#6f7787;font-size:11px;text-align:center;padding:0 12px;line-height:1.5}",
  ".dsd-stage-cap{position:absolute;left:6px;top:5px;color:#8b93a7;font-size:10px;letter-spacing:.3px}",
  ".dsd-transport{display:flex;align-items:center;gap:6px;background:#1e1e1e;border-radius:4px;padding:4px 6px;",
  "font-variant-numeric:tabular-nums}",
  ".dsd-num{width:58px;background:#262626;border:1px solid #454545;color:#d8dce8;border-radius:3px;",
  "padding:2px 4px;font-size:11px;font-family:inherit}",
  ".dsd-tc{margin-left:auto;color:#29d3c9;font-variant-numeric:tabular-nums;letter-spacing:.5px}",
  ".dsd-canvas{width:100%;display:block;background:#1d1d1d;border-radius:4px;cursor:pointer}",
  ".dsd-summary{display:flex;flex-direction:column;gap:3px;background:#1e1e1e;border-radius:4px;",
  "padding:4px 7px;font-variant-numeric:tabular-nums}",
  ".dsd-sum-row{display:flex;gap:12px;align-items:center;flex-wrap:wrap}",
  ".dsd-sum-cur{color:#ffb020}",
  ".dsd-sum-cur b{color:#ffb020}",
  ".dsd-types{display:flex;gap:4px;align-items:center;flex-wrap:wrap;background:#191919;",
  "border-radius:3px;padding:3px 4px}",
  ".dsd-types>label{color:#8b93a7;font-size:10px}",
  ".dsd-chips{display:flex;gap:4px;flex-wrap:wrap;align-items:center}",
  ".dsd-chip{display:flex;gap:3px;align-items:center;background:#242424;border:1px solid #3a3a3a;",
  "border-radius:3px;padding:1px 4px}",
  ".dsd-chip b{color:#9fe8e1;font-weight:500;font-size:10px}",
  ".dsd-sel{background:#262626;border:1px solid #454545;color:#d8dce8;border-radius:3px;",
  "font-size:10px;padding:1px 2px;font-family:inherit}",
  ".dsd-ovr{display:flex;flex-wrap:wrap;gap:5px;align-items:center;margin-top:6px;border-top:1px solid #333;padding-top:6px}",
  ".dsd-ovr>label{color:#7a8296;font-size:10px}",
  ".dsd-ovr .dsd-oi{display:flex;align-items:center;gap:3px}",
  ".dsd-ovr .dsd-oi span{color:#7a8296;font-size:10px}",
  ".dsd-ovr input,.dsd-ovr select{width:52px;background:#141414;border:1px solid #3a3a3a;color:#d8dce8;border-radius:3px;font-size:10px;padding:1px 3px}",
  ".dsd-ovr select{width:74px}",
  ".dsd-ovr input.dsd-set,.dsd-ovr select.dsd-set{border-color:#29d3c9;color:#9fe8e1}",
  ".dsd-slot.dsd-drop{border-color:#29d3c9;background:#20302e}",
  ".dsd-summary b{color:#29d3c9;font-weight:600}",
  ".dsd-summary i{color:#7a8296;font-style:normal;font-size:10px}",
  ".dsd-outs{display:flex;flex-wrap:wrap;gap:4px 10px;background:#1e1e1e;border-radius:4px;padding:4px 7px;",
  "align-items:center;font-variant-numeric:tabular-nums}",
  ".dsd-out-item{display:flex;gap:4px;align-items:center}",
  ".dsd-out-item>span{color:#8b93a7}",
  ".dsd-out-item input{width:56px;background:#262626;border:1px solid #454545;color:#d8dce8;",
  "border-radius:3px;padding:2px 4px;font-size:11px;font-family:inherit}",
  ".dsd-derived{color:#7a8296;font-size:10px;line-height:1.45;flex:1 1 100%}",
  ".dsd-derived b{color:#d8dce8;font-weight:500}",
  ".dsd-warn{color:#ff6b6b}",
  ".dsd-pf{display:none;max-height:130px;overflow:auto;background:#141414;border:1px solid #3a3a3a;border-radius:4px;padding:4px 6px;margin-top:4px}",  ".dsd-pf-line{font-size:10px;line-height:1.45;white-space:pre-wrap;color:#b9c0cf}",  ".dsd-pf-err{color:#ff8f8f}",  ".dsd-pf-warn{color:#ffd24a}",
  ".dsd-cards{display:flex;gap:6px;flex:1 1 auto;min-height:132px;overflow:hidden}",
  ".dsd-left{width:46%;display:flex;flex-direction:column;gap:4px;background:#1e1e1e;border-radius:4px;",
  "padding:5px;overflow:auto}",
  ".dsd-right{flex:1 1 auto;display:flex;flex-direction:column;gap:4px;background:#1e1e1e;",
  "border-radius:4px;padding:5px;overflow:hidden}",
  ".dsd-grp{display:flex;flex-wrap:wrap;gap:3px;align-items:center}",
  ".dsd-grp>label{width:100%;color:#8b93a7;font-size:10px;margin-bottom:1px}",
  ".dsd-slot{position:relative;width:46px;height:46px;border:1px dashed #454545;border-radius:3px;",
  "display:flex;align-items:center;justify-content:center;cursor:pointer;overflow:hidden;",
  "color:#6f7787;font-size:9px;text-align:center;flex:0 0 auto}",
  ".dsd-slot:hover{border-color:#29d3c9}",
  ".dsd-slot.filled{border-style:solid;border-color:#3d6b64}",
  ".dsd-slot img{width:100%;height:100%;object-fit:cover;display:block}",
  ".dsd-slot .dsd-x{position:absolute;right:0;top:0;width:13px;height:13px;line-height:12px;",
  "text-align:center;background:rgba(20,20,20,.82);color:#ff8080;font-size:11px;cursor:pointer;",
  "border-bottom-left-radius:3px}",
  ".dsd-slot .dsd-tag{position:absolute;left:1px;bottom:0;font-size:8px;color:#9fe8e1;",
  "background:rgba(10,10,10,.7);padding:0 2px;border-radius:2px}",
  ".dsd-prompt{width:100%;flex:1 1 auto;min-height:78px;resize:none;box-sizing:border-box;",
  "background:#262626;border:1px solid #454545;color:#dfe3ee;border-radius:3px;padding:5px;",
  "font-size:11px;line-height:1.45;font-family:inherit}",
  ".dsd-nav{display:flex;gap:4px;align-items:center}",
  ".dsd-nav .dsd-shotno{color:#29d3c9;font-variant-numeric:tabular-nums;margin:0 auto}",
  ".dsd-presets{display:flex;gap:5px;align-items:center;background:#1e1e1e;border-radius:4px;padding:4px 6px;flex-wrap:wrap}",
  ".dsd-presets>span:first-child{color:#8b93a7}",
  ".dsd-presets .dsd-note{color:#7a8296;font-size:10px}",
  ".dsd-status{display:flex;flex-direction:column;gap:4px;background:#1e1e1e;border-radius:4px;padding:5px 7px;flex:0 0 auto}",
  ".dsd-row{display:flex;align-items:center;gap:6px}",
  ".dsd-row>span:first-child{color:#8b93a7;width:44px;flex:0 0 auto}",
  ".dsd-track{flex:1 1 auto;height:7px;background:#2b2b2b;border-radius:4px;overflow:hidden;",
  "border:1px solid #383838}",
  ".dsd-fill{height:100%;width:0%;background:#29d3c9;transition:width .18s linear}",
  ".dsd-fill.dsd-fill-seg{background:#ffb020}",
  ".dsd-pct{width:38px;text-align:right;color:#8b93a7;font-variant-numeric:tabular-nums;flex:0 0 auto}",
  ".dsd-phase{display:flex;gap:8px;align-items:center;color:#d8dce8;font-variant-numeric:tabular-nums}",
  ".dsd-phase .dsd-lamp{width:7px;height:7px;border-radius:50%;background:#555;flex:0 0 auto}",
  ".dsd-phase.running .dsd-lamp{background:#ffb020}",
  ".dsd-phase.done .dsd-lamp{background:#29d3c9}",
  ".dsd-err{color:#ff6b6b;white-space:pre-wrap;line-height:1.4;display:none}",
  ".dsd-notice{font-size:11px;line-height:1.45;color:#9aa3b5;white-space:pre-wrap}",
  ".dsd-confirm{display:none;gap:6px;align-items:center;background:#3a2a10;border:1px solid #b8860b;",
  "color:#ffd24a;border-radius:4px;padding:4px 7px}",
  ".dsd-confirm.show{display:flex}",
  ".dsd-hint{color:#7a8296;font-size:10px}",
  ".dsd-stage-tabs{display:flex;gap:4px;align-items:center;flex:0 0 auto}",
  ".dsd-stage-meta{color:#8b93a7;font-size:10px;line-height:1.4;padding:0 2px;",
  "font-variant-numeric:tabular-nums}",
  ".dsd-btn.dsd-tiny{padding:1px 5px;font-size:10px}",
  ".dsd-off{opacity:.45;pointer-events:none}",
  ".dsd-badge{font-size:10px;padding:1px 6px;border-radius:9px;border:1px solid #454545;",
  "color:#7a8296;flex:0 0 auto}",
  ".dsd-badge.dsd-badge-dirty{color:#ffd24a;border-color:#b8860b;background:#3a2a10}",
  ".dsd-badge.dsd-badge-ok{color:#7cf3e8;border-color:#2a6b64;background:#16302d}",
  ".dsd-log{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:10px;",
  "line-height:1.45;max-height:120px;overflow:auto;background:#1a1a1a;border-radius:3px;",
  "padding:3px 5px;color:#9aa3b5;white-space:pre-wrap}",
  ".dsd-log-empty{color:#6f7787}",
  ".dsd-log-line{font-variant-numeric:tabular-nums}",
  ".dsd-sec{display:flex;flex-direction:column;gap:3px;flex:0 0 auto}",
  ".dsd-sec-head{display:flex;gap:5px;align-items:center;cursor:pointer;color:#8b93a7;",
  "font-size:10px;user-select:none;padding:1px 0}",
  ".dsd-sec-head:hover{color:#29d3c9}",
  ".dsd-sec .dsd-tri{display:inline-block;transition:transform .12s linear;font-size:9px}",
  ".dsd-sec.collapsed .dsd-tri{transform:rotate(90deg)}",
  ".dsd-sec.collapsed .dsd-sec-body{display:none}",
  ".dsd-sec-body{display:flex;flex-direction:column;gap:4px}",
  ".dsd-psec{display:flex;flex-wrap:wrap;gap:3px;align-items:center}",
  ".dsd-chip-sec{font-size:9px;padding:1px 5px;border-radius:8px;border:1px solid #454545;",
  "cursor:pointer;user-select:none}",
  ".dsd-chip-on{color:#7cf3e8;border-color:#2a6b64;background:#16302d}",
  ".dsd-chip-off{color:#6f7787;border-color:#3a3a3a;background:#222}",
  ".dsd-chip-off:hover{border-color:#29d3c9;color:#9fe8e1}",
  ".dsd-meter{font-size:10px;font-variant-numeric:tabular-nums;padding:1px 6px;",
  "border-radius:9px;border:1px solid #454545}",
  ".dsd-meter-red{color:#ff6b6b;border-color:#7a2a2a;background:#2a1414}",
  ".dsd-meter-amber{color:#ffd24a;border-color:#b8860b;background:#3a2a10}",
  ".dsd-meter-teal{color:#7cf3e8;border-color:#2a6b64;background:#16302d}",
  ".dsd-guard{display:none;flex-direction:column;gap:3px;background:#3a2a10;",
  "border:1px solid #b8860b;color:#ffd24a;border-radius:4px;padding:4px 7px;font-size:10px}",
  ".dsd-guard.show{display:flex}",
  ".dsd-guard-lines{white-space:pre-wrap;line-height:1.4;color:#e8c68a;",
  "font-family:ui-monospace,SFMono-Regular,Consolas,monospace}",
  ".dsd-guard-btns{display:flex;gap:6px;align-items:center}",
  ".dsd-help{position:absolute;right:10px;top:34px;z-index:40;display:none;",
  "background:#141414;border:1px solid #454545;border-radius:6px;padding:8px 10px;",
  "box-shadow:0 6px 24px rgba(0,0,0,.6);max-width:420px}",
  ".dsd-help.show{display:block}",
  ".dsd-help h4{margin:0 0 6px;font-size:11px;color:#29d3c9;font-weight:600}",
  ".dsd-help table{border-collapse:collapse;font-size:10px}",
  ".dsd-help td{padding:1px 8px 1px 0;color:#c9cfdd;vertical-align:top}",
  ".dsd-help td.dsd-help-k{color:#ffd24a;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;",
  "white-space:nowrap}",
  ".dsd-help-x{position:absolute;right:6px;top:4px;cursor:pointer;color:#8b93a7;font-size:12px}",
  ".dsd-shotbar{display:flex;gap:3px;flex-wrap:wrap;align-items:center}",
  // The shortcuts overlay is positioned absolutely: give the panel its
  // own containing block so it cannot escape into ComfyUI chrome.
  ".dsd-panel{position:relative}",
].join("");

/* --------------------------------------------------------- asset helpers */

/** Upload a File through ComfyUI /upload/image; returns {name, subfolder, type}. */
async function uploadToInput(file) {
  const body = new FormData();
  body.append("image", file, (file && file.name) || "upload.bin");
  body.append("type", "input");
  body.append("overwrite", "false");
  const resp = await api.fetchApi("/upload/image", { method: "POST", body: body });
  if (!resp.ok) {
    let detail = "";
    try {
      detail = await resp.text();
    } catch (err) {
      detail = "";
    }
    throw new Error(detail || "upload failed (" + resp.status + ")");
  }
  return resp.json();
}

/** Stored reference path for an upload: "subfolder/name" when the server used one. */
function refPath(upload) {
  const name = (upload && (upload.name || upload.filename)) || "";
  const sub = (upload && upload.subfolder) || "";
  if (!name) return "";
  return sub ? String(sub).replace(/\/+$/, "") + "/" + name : String(name);
}

/** /view URL for a stored reference path (name or subfolder/name). */
function viewURL(path) {
  const raw = String(path || "");
  const cut = raw.lastIndexOf("/");
  const sub = cut >= 0 ? raw.slice(0, cut) : "";
  const name = cut >= 0 ? raw.slice(cut + 1) : raw;
  const query = "filename=" + encodeURIComponent(name) + "&type=input" +
    (sub ? "&subfolder=" + encodeURIComponent(sub) : "");
  try {
    if (api && typeof api.apiURL === "function") return api.apiURL("/view?" + query);
  } catch (err) {
    console.warn("[DSD.DirectorPanel] apiURL failed:", err);
  }
  return "/view?" + query;
}

const IMAGE_EXT = /\.(png|jpe?g|webp|gif|bmp|tiff?)$/i;
const VIDEO_EXT = /\.(mp4|webm|mov|mkv|avi|m4v)$/i;
const AUDIO_EXT = /\.(wav|mp3|flac|ogg|m4a|aac|opus)$/i;

function isImagePath(path) {
  return IMAGE_EXT.test(String(path || ""));
}

/* ------------------------------------------------------- thumbnails */

/* One decoded thumbnail per input path. The Image/Video is created once and
   reused, so a repaint never restarts the network fetch or flickers. */
const thumbCache = new Map();
const THUMB_MAX = 96;
const LIVE_CTX = new Set();

function repaintPanels() {
  LIVE_CTX.forEach(function (ctx) {
    if (ctx && typeof ctx.repaint === "function") ctx.repaint();
  });
}

/** First still for a shot: uploaded image, else the reference video first frame. */
function thumbSource(shot) {
  if (!shot) return null;
  const refs = isArray(shot.refs) ? shot.refs : [];
  if (refs[0]) return { kind: "img", path: String(refs[0]) };
  const vids = isArray(shot.refVideos) ? shot.refVideos : [];
  if (vids[0]) return { kind: "video", path: String(vids[0]) };
  return null;
}

function thumbEntry(src) {
  const key = src.kind + ":" + src.path;
  const hit = thumbCache.get(key);
  if (hit) return hit;
  const entry = { kind: src.kind, ready: false, failed: false, img: null, video: null };
  thumbCache.set(key, entry);
  if (src.kind === "video") {
    const v = document.createElement("video");
    v.muted = true;
    v.preload = "auto";
    v.playsInline = true;
    v.onloadedmetadata = function () {
      safe(function () { v.currentTime = 0.1; }, "thumb video seek");
    };
    v.onloadeddata = function () {
      entry.video = v;
      entry.ready = true;
      repaintPanels();
    };
    v.onerror = function () {
      entry.failed = true;
    };
    v.src = viewURL(src.path);
    safe(function () { v.load(); }, "thumb video load");
    return entry;
  }
  const img = new Image();
  img.onload = function () {
    entry.ready = true;
    repaintPanels();
  };
  img.onerror = function () {
    entry.failed = true;
  };
  entry.img = img;
  img.src = viewURL(src.path);
  return entry;
}

/** Aspect-preserving cover crop of a ready thumbnail into (dx,dy,dw,dh). */
function drawCover(g, entry, dx, dy, dw, dh) {
  if (!entry || !entry.ready) return false;
  const src = entry.kind === "video" ? entry.video : entry.img;
  if (!src) return false;
  const sw0 = entry.kind === "video" ? src.videoWidth : src.naturalWidth;
  const sh0 = entry.kind === "video" ? src.videoHeight : src.naturalHeight;
  if (!sw0 || !sh0) return false;
  const scale = Math.max(dw / sw0, dh / sh0);
  const sw = Math.min(sw0, dw / scale);
  const sh = Math.min(sh0, dh / scale);
  const sx = (sw0 - sw) / 2;
  const sy = (sh0 - sh) / 2;
  try {
    g.drawImage(src, sx, sy, sw, sh, dx, dy, dw, dh);
  } catch (err) {
    console.warn("[DSD.DirectorPanel] thumbnail draw failed:", err);
    return false;
  }
  return true;
}

/** Paint one shot block: base fill, then its thumbnail when one is ready. */
function drawShotThumb(g, shot, x0, y, w, h, ctx) {
  const src = thumbSource(shot);
  if (!src) return false;
  // Kick the load here; the onload/onloadeddata callback repaints once.
  const entry = thumbEntry(src);
  if (!entry || entry.failed || !entry.ready) return false;
  const inset = 1;
  const dw = Math.max(1, w - inset * 2);
  const dh = Math.max(1, h - inset * 2);
  const drawn = drawCover(g, entry, x0 + inset, y + inset, dw, dh);
  if (drawn) {
    // A faint plate keeps the shot number readable over a bright still.
    g.fillStyle = "rgba(12,14,16,.62)";
    g.fillRect(x0 + inset, y + inset, Math.min(dw, 34), 13);
  }
  return drawn;
}

/* ------------------------------------------------------- timeline paint */

const TL_COLORS = {
  bg: "#1d1d1d",
  shotA: "#262a2a",
  shotB: "#222626",
  shotCur: "#2c3b39",
  edge: "#29d3c9",
  edgeBright: "#8ef7ef",
  window: "rgba(41,211,201,.34)",
  playhead: "#ffb020",
  text: "#c9cfdd",
  dim: "#7a8296",
};

/**
 * Paints the whole timeline. Layout: shots are laid out proportionally to their
 * frame counts; cyan dividers are the draggable shot boundaries, amber is the
 * playhead, faint cyan ticks are model-window boundaries inside each shot.
 */
function paintTimeline(canvas, tl, curIndex, playFrame, win, ctx, pctx) {
  const dpr = window.devicePixelRatio || 1;
  const cssW = Math.max(120, canvas.clientWidth || 320);
  const cssH = 62;
  if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
  }
  canvas.style.height = cssH + "px";
  const g = canvas.getContext("2d");
  if (!g) return null;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, cssW, cssH);
  g.fillStyle = TL_COLORS.bg;
  g.fillRect(0, 0, cssW, cssH);

  const total = timelineFrames(tl) || 1;
  const trackY = 12;
  const trackH = 30;
  const bounds = [];
  let acc = 0;
  for (let i = 0; i < tl.shots.length; i++) {
    const f = shotFrames(tl.shots[i]);
    const x0 = (acc / total) * cssW;
    acc += f;
    const x1 = (acc / total) * cssW;
    bounds.push({ i: i, x0: x0, x1: x1, frames: f, start: acc - f });
    const bw = Math.max(1, x1 - x0);
    g.fillStyle = i === curIndex ? TL_COLORS.shotCur : (i % 2 ? TL_COLORS.shotB : TL_COLORS.shotA);
    g.fillRect(x0, trackY, bw, trackH);
    drawShotThumb(g, tl.shots[i], x0, trackY, bw, trackH, ctx);
    // model-window boundaries inside this shot
    const wins = windowsFor(f, win, ctx);
    if (wins > 1) {
      g.strokeStyle = TL_COLORS.window;
      g.lineWidth = 1;
      for (let k = 1; k < wins; k++) {
        const fx = x0 + ((x1 - x0) * k) / wins;
        g.beginPath();
        g.moveTo(fx, trackY + 1);
        g.lineTo(fx, trackY + trackH - 1);
        g.stroke();
      }
    }
    if (x1 - x0 > 22) {
      g.fillStyle = TL_COLORS.text;
      g.font = "10px ui-sans-serif,system-ui,sans-serif";
      g.textBaseline = "top";
      g.fillText("#" + (i + 1), x0 + 4, trackY + 3);
      if (x1 - x0 > 44) {
        g.fillStyle = TL_COLORS.dim;
        g.fillText(shotFrames(tl.shots[i]) + "f", x0 + 4, trackY + 15);
      }
      // Start/end frame numbers, but only where the block is wide enough to
      // hold both without the two labels colliding.
      if (x1 - x0 >= 60) {
        g.fillStyle = TL_COLORS.dim;
        g.textBaseline = "alphabetic";
        g.fillText(bounds[i].start + "f", x0 + 4, trackY + trackH - 3);
        const endTxt = (bounds[i].start + f) + "f";
        const endW = g.measureText(endTxt).width;
        g.fillText(endTxt, x1 - endW - 4, trackY + trackH - 3);
      }
    }
  }

  // Selected shot gets a brighter outline than the plain shot boundaries so
  // the current shot stays obvious even when a thumbnail fills the block.
  if (curIndex >= 0 && curIndex < bounds.length) {
    const sel = bounds[curIndex];
    g.strokeStyle = TL_COLORS.edgeBright;
    g.lineWidth = 2;
    g.strokeRect(sel.x0 + 1, trackY + 1, Math.max(1, sel.x1 - sel.x0 - 2), trackH - 2);
  }

  // draggable shot boundaries
  g.strokeStyle = TL_COLORS.edge;
  g.lineWidth = 2;
  for (let i = 1; i < bounds.length; i++) {
    const x = bounds[i].x0;
    g.beginPath();
    g.moveTo(x, trackY - 4);
    g.lineTo(x, trackY + trackH + 4);
    g.stroke();
  }

  // playhead
  const ph = clampNum(playFrame, 0, total);
  const px = (ph / total) * cssW;
  g.strokeStyle = TL_COLORS.playhead;
  g.lineWidth = 1.5;
  g.beginPath();
  g.moveTo(px, 4);
  g.lineTo(px, trackY + trackH + 6);
  g.stroke();
  g.fillStyle = TL_COLORS.playhead;
  g.beginPath();
  g.moveTo(px - 4, 4);
  g.lineTo(px + 4, 4);
  g.lineTo(px, 10);
  g.closePath();
  g.fill();

  // ruler: a tick every 12 frames plus second labels at a zoom-aware spacing
  const fps = FPS || 24;
  const pxPerSec = (cssW / total) * fps;
  g.strokeStyle = "rgba(122,130,150,.42)";
  g.lineWidth = 1;
  for (let mf = 12; mf < total; mf += 12) {
    const tx = Math.round((mf / total) * cssW) + 0.5;
    g.beginPath();
    g.moveTo(tx, cssH - 5);
    g.lineTo(tx, cssH - 1);
    g.stroke();
  }
  const STEPS = [1, 2, 5, 10, 15, 30, 60, 120];
  let step = STEPS[STEPS.length - 1];
  for (let si = 0; si < STEPS.length; si++) {
    if (pxPerSec * STEPS[si] >= 46) {
      step = STEPS[si];
      break;
    }
  }
  g.fillStyle = TL_COLORS.dim;
  g.font = "9px ui-sans-serif,system-ui,sans-serif";
  g.textBaseline = "bottom";
  const totalSec = total / fps;
  // Leave room on the right for the total-frames label.
  const rightGuard = cssW - 30;
  for (let s = 0; s <= totalSec + 0.0001; s += step) {
    const tx = (s * fps / total) * cssW;
    if (tx > rightGuard) break;
    const lab = (Math.round(s * 100) / 100) + "s";
    g.fillText(lab, Math.max(2, tx + 1), cssH - 2);
    g.strokeStyle = "rgba(122,130,150,.75)";
    g.beginPath();
    g.moveTo(Math.round(tx) + 0.5, cssH - 8);
    g.lineTo(Math.round(tx) + 0.5, cssH - 5);
    g.stroke();
  }
  const endLabel = total + "f";
  g.fillStyle = TL_COLORS.dim;
  g.fillText(endLabel, cssW - g.measureText(endLabel).width - 2, cssH - 2);

  // insertion marker while a shot is being dragged to a new position
  if (pctx && pctx.reorder && pctx.reorder.slot !== null && pctx.reorder.slot !== undefined) {
    const slot = clampNum(pctx.reorder.slot, 0, bounds.length);
    const mx = slot <= 0 ? 1 : slot >= bounds.length ? cssW - 2 : bounds[slot].x0;
    g.fillStyle = TL_COLORS.playhead;
    g.fillRect(Math.round(mx) - 1, trackY - 6, 3, trackH + 12);
  }

  return { bounds: bounds, width: cssW, height: cssH, total: total };
}

/* ----------------------------------------------------------- panel state */

function makeCtx(node, host) {
  const o = {
    node: node,
    host: host,
    tl: parseTimeline(widgetValue(node, "timeline_data", "") || node.dsdTimelineCache || "", numWidget(node, "total_frames", 124)),
    cur: 0,
    playFrame: 0,
    playing: false,
    timer: 0,
    bounds: [],
    updaters: [],
    els: {},
    stage: { type: "", path: "" },
    stageKey: "",
    stageMode: "ref",
    stageSeconds: 0,
    lastVideo: "",
    lastVideoName: "",
    runT0: 0,
    lastSegSeconds: 0,
    lastRunWall: 0,
    repaint: null,
    notice: null,
    busy: false,
    history: [],
    future: [],
    editSnap: null,
    runLog: [],
    shotConfirmFn: null,
    confirmOpen: null,
    guardFn: null,
    secRefs: {},
    reorder: null,
    helpOpen: false,
    runState: null,
    finished: false,
  };
  o.lastSaved = JSON.stringify(o.tl);
  // Undo stacks and the run log belong to the panel, not the DOM, so they
  // are mirrored onto the node and re-seeded when rebuildPanel makes a new
  // ctx (language switch, relayout).
  if (node && node.dsdKeep) {
    o.history = node.dsdKeep.history.slice(0);
    o.future = node.dsdKeep.future.slice(0);
    o.runLog = node.dsdKeep.runLog.slice(0);
    o.runState = node.dsdKeep.runState || null;
    o.finished = !!node.dsdKeep.finished;
    o.lastRunWall = Number(node.dsdKeep.lastRunWall) || 0;
    o.lastSegSeconds = Number(node.dsdKeep.lastSegSeconds) || 0;
  }
  return o;
}

function ctxShot(ctx) {
  if (!ctx.tl || !ctx.tl.shots.length) return null;
  const i = clampNum(ctx.cur, 0, ctx.tl.shots.length - 1);
  return ctx.tl.shots[i] || null;
}

/** Push the whole timeline back into the node and repaint every section. */
function commit(ctx) {
  const res = writeTimeline(ctx.node, ctx.tl);
  if (!res || res.wrote !== false) markSaved(ctx);
  refreshAll(ctx);
}

function refreshAll(ctx) {
  for (let i = 0; i < ctx.updaters.length; i++) {
    safe(ctx.updaters[i], "updater " + i);
  }
  safe(function () {
    updateSaveBadge(ctx);
  }, "save badge");
}

function setNotice(ctx, text) {
  if (!ctx.els.notice) return;
  ctx.els.notice.textContent = text || "";
  ctx.els.notice.style.display = text ? "block" : "none";
}

/* ------------------------------------------------------- help overlay */

/** Every shortcut the panel installs, in one place so the overlay and the
 *  key handler cannot drift apart. */
function helpRows() {
  return [
    ["Space", t("scPlay")],
    ["\u2190 / \u2192", t("scStep")],
    ["Shift+\u2190 / \u2192", t("scStepSec")],
    ["Delete", t("scDel")],
    ["Ctrl+Enter", t("scRun")],
    ["Ctrl+Z", t("scUndo")],
    ["Ctrl+Shift+Z / Ctrl+Y", t("scRedo")],
    ["F1 / ?", t("scHelp")],
  ];
}

/** Two-column cheatsheet docked inside the panel host. */
function helpOverlay(ctx) {
  const box = el("div", "dsd-help");
  const x = el("span", "dsd-help-x", "\u00d7");
  x.onclick = function () {
    box.classList.remove("show");
  };
  box.appendChild(x);
  box.appendChild(el("h4", null, t("helpTitle")));
  const table = document.createElement("table");
  const rows = helpRows();
  for (let i = 0; i < rows.length; i++) {
    const tr = document.createElement("tr");
    tr.appendChild(el("td", "dsd-help-k", rows[i][0]));
    tr.appendChild(el("td", null, rows[i][1]));
    table.appendChild(tr);
  }
  box.appendChild(table);
  ctx.els.help = box;
  return box;
}

function toggleHelp(ctx) {
  const box = ctx.els && ctx.els.help;
  if (!box) return false;
  const show = !box.classList.contains("show");
  box.classList.toggle("show", show);
  ctx.helpOpen = show;
  return show;
}

function closeHelp(ctx) {
  const box = ctx.els && ctx.els.help;
  if (!box || !box.classList.contains("show")) return false;
  box.classList.remove("show");
  ctx.helpOpen = false;
  return true;
}

/* ---------------------------------------------------- keyboard plumbing */

function isTypingTarget(node) {
  if (!node || !node.tagName) return false;
  const tag = String(node.tagName).toUpperCase();
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return !!node.isContentEditable;
}

/** Move the playhead and keep the selected shot in step with it. */
function setPlayFrame(ctx, frame) {
  const total = timelineFrames(ctx.tl) || 1;
  const f = clampNum(Math.round(frame), 0, total);
  ctx.playFrame = f;
  if (isArray(ctx.bounds)) {
    for (let i = 0; i < ctx.bounds.length; i++) {
      if (f >= ctx.bounds[i].start && f < ctx.bounds[i].start + ctx.bounds[i].frames) {
        ctx.cur = i;
        break;
      }
    }
  }
  refreshAll(ctx);
}

function stepFrame(ctx, delta) {
  const total = timelineFrames(ctx.tl) || 1;
  setPlayFrame(ctx, clampNum(ctx.playFrame + delta, 0, Math.max(0, total - 1)));
}

/** Reuse the timeline's own inline confirm bar instead of a modal. */
function askDeleteShot(ctx, index) {
  if (!ctx.tl || !ctx.tl.shots.length) return false;
  if (ctx.tl.shots.length <= 1) {
    setNotice(ctx, t("shortShot"));
    return false;
  }
  const i = clampNum(index, 0, ctx.tl.shots.length - 1);
  // Two confirm bars exist: the timeline canvas one (ctx.confirmOpen, only
  // wired once sectionTimeline has run) and the shot card one, which is always
  // mounted. Prefer the shot card bar and fall back to the canvas bar, so a
  // rebuild that leaves confirmOpen unset can never silently skip the confirm.
  const doDelete = function () {
    pushHistory(ctx);
    ctx.tl.shots.splice(i, 1);
    if (!ctx.tl.shots.length) ctx.tl.shots.push(cloneShot(null));
    ctx.cur = clampNum(ctx.cur, 0, ctx.tl.shots.length - 1);
    commit(ctx);
  };
  if (ctx.els && ctx.els.shotConfirmBar) {
    showShotConfirm(ctx, t("delTitle") + " #" + (i + 1), t("del"), doDelete);
    return true;
  }
  if (typeof ctx.confirmOpen === "function") {
    ctx.confirmOpen(i);
    return true;
  }
  doDelete();
  return true;
}

/** One document-level keydown per node; rebuilding the panel rebinds it. */
function installKeys(node, ctx) {
  safe(function () {
    if (node.dsdKeyHandler) document.removeEventListener("keydown", node.dsdKeyHandler, true);
  }, "unbind keys");
  const handler = function (ev) {
    if (!ev || !node.dsdPanelApi || node.dsdPanelApi.ctx !== ctx) return;
    const key = String(ev.key || "");
    if (key === "F1" || (key === "?" && !isTypingTarget(ev.target))) {
      ev.preventDefault();
      toggleHelp(ctx);
      return;
    }
    if (key === "Escape") {
      if (closeHelp(ctx)) {
        ev.preventDefault();
        return;
      }
    }
    if (isTypingTarget(ev.target)) return;
    const mod = !!ev.ctrlKey || !!ev.metaKey;
    if (mod && (key === "z" || key === "Z")) {
      ev.preventDefault();
      if (ev.shiftKey) redo(ctx);
      else undo(ctx);
      return;
    }
    if (mod && (key === "y" || key === "Y")) {
      ev.preventDefault();
      redo(ctx);
      return;
    }
    if (mod && key === "Enter") {
      ev.preventDefault();
      runAll(ctx, ctx.els.runBtn);
      return;
    }
    if (key === " ") {
      ev.preventDefault();
      togglePlay(ctx);
      return;
    }
    if (key === "ArrowLeft" || key === "ArrowRight") {
      ev.preventDefault();
      const dir = key === "ArrowRight" ? 1 : -1;
      stepFrame(ctx, ev.shiftKey ? dir * FPS : dir);
      return;
    }
    if (key === "Delete") {
      ev.preventDefault();
      askDeleteShot(ctx, ctx.cur);
    }
  };
  document.addEventListener("keydown", handler, true);
  node.dsdKeyHandler = handler;
}

/* ------------------------------------------------------- section 1: bar */

function sectionToolbar(ctx) {
  const bar = el("div", "dsd-bar");
  ctx.els.banner = el("div", "dsd-banner");
  ctx.els.banner.style.display = "none";

  const runBtn = el("button", "dsd-btn dsd-primary", t("runAll"));
  runBtn.title = t("runAll");
  runBtn.onclick = function () {
    runAll(ctx, runBtn);
  };

  const refreshBtn = el("button", "dsd-btn", t("refresh"));
  refreshBtn.onclick = function () {
    reloadFromWidgets(ctx);
    commit(ctx);
    setNotice(ctx, "");
  };

  const resegBtn = el("button", "dsd-btn", t("reseg"));
  resegBtn.onclick = function () {
    resegment(ctx);
  };

  const addBtn = el("button", "dsd-btn", t("addShot"));
  addBtn.title = t("addShotHint");
  addBtn.onclick = function () {
    addShot(ctx);
  };

  const splitBtn = el("button", "dsd-btn", t("splitShot"));
  splitBtn.title = t("splitShot");
  splitBtn.onclick = function () {
    splitAtPlayhead(ctx);
  };

  const pfBtn = el("button", "dsd-btn", t("preflightBtn"));
  pfBtn.title = t("preflightHint");
  pfBtn.onclick = function () {
    runPreflight(ctx, pfBtn);
  };

  const importBtn = el("button", "dsd-btn", t("importTpl"));
  importBtn.onclick = function () {
    importTemplate(ctx);
  };

  const exportBtn = el("button", "dsd-btn", t("exportTpl"));
  exportBtn.onclick = function () {
    exportTemplate(ctx);
  };

  const langBtn = el("button", "dsd-btn", PANEL_LANG === "en" ? "中" : "EN");
  langBtn.title = "language";
  langBtn.onclick = function () {
    setLang(PANEL_LANG === "en" ? "zh" : "en", ctx.node);
  };
  ctx.els.langBtn = langBtn;

  const undoBtn = el("button", "dsd-btn", t("undo"));
  undoBtn.title = t("undo") + " (Ctrl+Z)";
  undoBtn.onclick = function () {
    undo(ctx);
  };
  ctx.els.undoBtn = undoBtn;

  const redoBtn = el("button", "dsd-btn", t("redo"));
  redoBtn.title = t("redo") + " (Ctrl+Shift+Z)";
  redoBtn.onclick = function () {
    redo(ctx);
  };
  ctx.els.redoBtn = redoBtn;

  const helpBtn = el("button", "dsd-btn", "?");
  helpBtn.title = t("helpTitle") + " (F1)";
  helpBtn.onclick = function () {
    toggleHelp(ctx);
  };
  ctx.els.helpBtn = helpBtn;

  const saveBadge = el("span", "dsd-badge", t("saveClean"));
  saveBadge.title = t("saveDirty") + " / " + t("saveClean");
  ctx.els.saveBadge = saveBadge;

  ctx.els.runBtn = runBtn;
  bar.appendChild(runBtn);
  bar.appendChild(undoBtn);
  bar.appendChild(redoBtn);
  bar.appendChild(refreshBtn);
  bar.appendChild(addBtn);
  bar.appendChild(splitBtn);
  bar.appendChild(pfBtn);
  bar.appendChild(resegBtn);
  bar.appendChild(importBtn);
  bar.appendChild(exportBtn);
  bar.appendChild(helpBtn);
  bar.appendChild(saveBadge);
  bar.appendChild(el("div", "dsd-spacer"));
  bar.appendChild(langBtn);

  const wrap = el("div");
  wrap.style.cssText = "display:flex;flex-direction:column;gap:4px;flex:0 0 auto;position:relative;";
  wrap.appendChild(ctx.els.banner);
  wrap.appendChild(bar);

  ctx.els.notice = el("div", "dsd-notice");
  ctx.els.notice.style.display = "none";
  wrap.appendChild(ctx.els.notice);
  wrap.appendChild(helpOverlay(ctx));

  ctx.updaters.push(function () {
    dimBtn(undoBtn, !(isArray(ctx.history) && ctx.history.length));
    dimBtn(redoBtn, !(isArray(ctx.future) && ctx.future.length));
    updateSaveBadge(ctx);
    if (ctx.els.notice) ctx.els.notice.style.display = ctx.els.notice.textContent ? "block" : "none";
    if (ctx.els.saveBadge) ctx.els.saveBadge.title = t("saveDirty") + " / " + t("saveClean");
  });
  return wrap;
}

/** Re-read timeline/total_frames from the node (source of truth is the widget). */
function reloadFromWidgets(ctx) {
  const node = ctx.node;
  ctx.tl = parseTimeline(widgetValue(node, "timeline_data", "") || node.dsdTimelineCache || "", numWidget(node, "total_frames", 124));
  ctx.cur = clampNum(ctx.cur, 0, ctx.tl.shots.length - 1);
  ctx.playFrame = clampNum(ctx.playFrame, 0, timelineFrames(ctx.tl));
}

/** Rebuild the shot list from total_frames using the current window geometry. */
function resegment(ctx) {
  const node = ctx.node;
  const total = Math.max(MIN_SHOT_FRAMES, numWidget(node, "total_frames", timelineFrames(ctx.tl)));
  const win = numWidget(node, "window_frames", 124);
  const ctxFrames = numWidget(node, "context_frames", 20);
  const segs = windowsFor(total, win, ctxFrames);
  const per = Math.max(MIN_SHOT_FRAMES, Math.round(total / Math.max(1, segs)));
  const shots = [];
  let left = total;
  for (let i = 0; i < segs; i++) {
    const take = i === segs - 1 ? left : Math.min(left, per);
    left -= take;
    const prev = ctx.tl.shots[i];
    const shot = cloneShot(prev || null);
    shot.id = "s" + (i + 1);
    shot.seconds = Math.round((take / FPS) * 10000) / 10000;
    shots.push(shot);
    if (left <= 0) break;
  }
  pushHistory(ctx);
  ctx.tl.shots = shots.length ? shots : [cloneShot(null)];
  ctx.cur = clampNum(ctx.cur, 0, ctx.tl.shots.length - 1);
  commit(ctx);
  setNotice(ctx, t("resegDone") + " · " + ctx.tl.shots.length + " × " + (FPS ? Math.round(per) : per) + "f");
}

function importTemplate(ctx) {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".json,application/json";
  input.style.display = "none";
  document.body.appendChild(input);
  input.onchange = function () {
    const file = input.files && input.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = function () {
      try {
        const parsed = parseTimeline(String(reader.result || ""), numWidget(ctx.node, "total_frames", 124));
        ctx.tl = parsed;
        ctx.cur = 0;
        ctx.playFrame = 0;
        commit(ctx);
        setNotice(ctx, t("tplIn"));
      } catch (err) {
        setNotice(ctx, t("tplInFail") + String(err && err.message ? err.message : err));
      }
      safe(function () {
        document.body.removeChild(input);
      }, "remove file input");
    };
    reader.readAsText(file);
  };
  input.click();
}

function exportTemplate(ctx) {
  try {
    const blob = new Blob([JSON.stringify(ctx.tl, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "dsd-timeline.json";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(function () {
      URL.revokeObjectURL(url);
    }, 2000);
    setNotice(ctx, t("tplOut") + " · dsd-timeline.json");
  } catch (err) {
    setNotice(ctx, t("tplInFail") + String(err && err.message ? err.message : err));
  }
}

/* ----------------------------------------------------- section 2: stage */

/* ------------------------------------------------------ last render */

const LAST_RENDER_KEY = "dsd.panel.lastRender.v1";

/** /view URL for a VHS output entry ({filename, subfolder, type}). */
function renderFileURL(item) {
  const name = String((item && (item.filename || item.name)) || "");
  if (!name) return "";
  const sub = String((item && item.subfolder) || "");
  const type = String((item && item.type) || "output");
  const query = "filename=" + encodeURIComponent(name) + "&type=" + encodeURIComponent(type) +
    (sub ? "&subfolder=" + encodeURIComponent(sub) : "");
  try {
    if (api && typeof api.apiURL === "function") return api.apiURL("/view?" + query);
  } catch (err) {
    console.warn("[DSD.DirectorPanel] apiURL failed:", err);
  }
  return "/view?" + query;
}

/**
 * The finished clip from an "executed" event. VHS nodes report gifs; some
 * versions put the same entries under images, so both are inspected and only
 * a video-looking name is accepted (a preview still is not a finished render).
 */
function pickRenderFile(detail) {
  const out = (detail && (detail.output || detail)) || {};
  const groups = ["gifs", "videos", "images"];
  for (let g = 0; g < groups.length; g++) {
    const list = out[groups[g]];
    if (!isArray(list) || !list.length) continue;
    for (let i = list.length - 1; i >= 0; i--) {
      const item = list[i];
      const name = String((item && (item.filename || item.name)) || "");
      if (!name) continue;
      if (g === groups.length - 1 && !VIDEO_EXT.test(name)) continue;
      return { item: item, name: name };
    }
  }
  return null;
}

function rememberRender(ctx, url, name) {
  ctx.lastVideo = url;
  ctx.lastVideoName = name;
  ctx.stageKey = "";
  try {
    if (window.localStorage) {
      window.localStorage.setItem(LAST_RENDER_KEY, JSON.stringify({ url: url, name: name }));
    }
  } catch (err) {
    console.warn("[DSD.DirectorPanel] last render not persisted:", err);
  }
  safe(function () {
    refreshAll(ctx);
  }, "stage render refresh");
}

function restoreRender(ctx) {
  try {
    if (!window.localStorage) return;
    const raw = window.localStorage.getItem(LAST_RENDER_KEY);
    if (!raw) return;
    const obj = JSON.parse(raw);
    if (obj && typeof obj.url === "string" && obj.url) {
      ctx.lastVideo = obj.url;
      ctx.lastVideoName = typeof obj.name === "string" ? obj.name : "";
    }
  } catch (err) {
    console.warn("[DSD.DirectorPanel] last render unreadable:", err);
  }
}

function sectionStage(ctx) {
  const wrap = el("div");
  wrap.style.cssText = "display:flex;flex-direction:column;gap:4px;flex:0 0 auto;";

  const tabs = el("div", "dsd-stage-tabs");
  const refBtn = el("button", "dsd-btn dsd-tiny", t("stageRef"));
  const renderBtn = el("button", "dsd-btn dsd-tiny", t("stageRender"));
  const meta = el("div", "dsd-stage-meta", "");
  tabs.appendChild(refBtn);
  tabs.appendChild(renderBtn);
  tabs.appendChild(el("div", "dsd-spacer"));
  tabs.appendChild(meta);

  const stage = el("div", "dsd-stage");
  const cap = el("div", "dsd-stage-cap", t("shotLbl") + " 1");
  const empty = el("div", "dsd-stage-empty", t("stageEmpty"));
  const video = document.createElement("video");
  video.className = "dsd-stage-video";
  video.controls = true;
  video.muted = true;
  video.loop = true;
  video.preload = "metadata";
  video.onloadedmetadata = function () {
    safe(function () {
      const dur = Number(video.duration);
      ctx.stageSeconds = Number.isFinite(dur) && dur > 0 ? dur : 0;
      refreshAll(ctx);
    }, "stage duration");
  };
  const img = document.createElement("img");
  img.className = "dsd-stage-img";
  img.alt = "";

  stage.appendChild(cap);
  stage.appendChild(empty);
  stage.appendChild(video);
  stage.appendChild(img);

  ctx.els.stage = stage;
  ctx.els.stageCap = cap;
  ctx.els.stageMeta = meta;
  ctx.els.stageRefBtn = refBtn;
  ctx.els.stageRenderBtn = renderBtn;

  const setMode = function (mode) {
    const next = mode === "render" ? "render" : "ref";
    if (next === "render" && !ctx.lastVideo) {
      setNotice(ctx, t("noRenderYet"));
      return;
    }
    ctx.stageMode = next;
    refreshAll(ctx);
  };
  refBtn.onclick = function () {
    setMode("ref");
  };
  renderBtn.onclick = function () {
    setMode("render");
  };

  ctx.updaters.push(function () {
    const shot = ctxShot(ctx);
    const idx = clampNum(ctx.cur, 0, ctx.tl.shots.length - 1) + 1;
    const playRender = ctx.stageMode === "render" && !!ctx.lastVideo;
    cap.textContent = t("shotLbl") + " " + idx + " / " + ctx.tl.shots.length +
      (playRender ? " \u00b7 " + t("stageRender") : "");

    refBtn.classList.toggle("dsd-on", !playRender);
    renderBtn.classList.toggle("dsd-on", playRender);
    renderBtn.disabled = !ctx.lastVideo;
    renderBtn.title = ctx.lastVideo ? (ctx.lastVideoName || t("stageRender")) : t("noRenderYet");

    const vPath = shot && shot.refVideos ? String(shot.refVideos[0] || "") : "";
    const iPath = shot && shot.refs ? String(shot.refs[0] || "") : "";
    const render = playRender ? String(ctx.lastVideo || "") : "";
    const useVideo = render ? render : vPath;
    const useImage = render ? "" : (vPath ? "" : iPath);
    const signature = (render ? "r:" : "ref:") + (useVideo || useImage);

    if (signature !== ctx.stageKey) {
      ctx.stageKey = signature;
      video.muted = !render;
      video.controls = true;
      video.loop = true;
      if (useVideo) {
        video.src = render ? render : viewURL(useVideo);
        img.removeAttribute("src");
      } else if (useImage) {
        img.src = viewURL(useImage);
        video.removeAttribute("src");
      } else {
        video.removeAttribute("src");
        img.removeAttribute("src");
      }
      stage.classList.toggle("has-media", !!(useVideo || useImage));
    }
    empty.style.display = useVideo || useImage ? "none" : "block";

    if (playRender) {
      const dur = ctx.stageSeconds ? fmtSeconds(ctx.stageSeconds) : "";
      meta.textContent = (ctx.lastVideoName || "") + (dur ? " \u00b7 " + dur : "");
    } else {
      meta.textContent = "";
    }
  });

  wrap.appendChild(tabs);
  wrap.appendChild(stage);
  return wrap;
}

/* ------------------------------------------------- section 3: transport */

function sectionTransport(ctx) {
  const row = el("div", "dsd-transport");
  const playBtn = el("button", "dsd-btn", t("play"));
  playBtn.onclick = function () {
    togglePlay(ctx);
  };
  const frameInput = document.createElement("input");
  frameInput.className = "dsd-num";
  frameInput.type = "number";
  frameInput.min = "0";
  frameInput.step = "1";
  frameInput.value = "0";
  frameInput.title = t("frameLbl");
  frameInput.onchange = function () {
    const total = timelineFrames(ctx.tl);
    ctx.playFrame = clampNum(parseFloat(frameInput.value), 0, total);
    refreshAll(ctx);
  };
  const goBtn = el("button", "dsd-btn", t("goto"));
  goBtn.onclick = function () {
    const total = timelineFrames(ctx.tl);
    ctx.playFrame = clampNum(parseFloat(frameInput.value), 0, total);
    refreshAll(ctx);
  };
  const tc = el("span", "dsd-tc", fmtTimecode(0));

  row.appendChild(playBtn);
  row.appendChild(el("span", "dsd-hint", t("frameLbl")));
  row.appendChild(frameInput);
  row.appendChild(goBtn);
  row.appendChild(tc);

  ctx.els.playBtn = playBtn;
  ctx.els.frameInput = frameInput;
  ctx.els.timecode = tc;

  ctx.updaters.push(function () {
    const total = timelineFrames(ctx.tl);
    ctx.playFrame = clampNum(ctx.playFrame, 0, total);
    if (document.activeElement !== frameInput) frameInput.value = String(Math.round(ctx.playFrame));
    tc.textContent = fmtTimecode(ctx.playFrame) + " / " + fmtTimecode(total);
    playBtn.textContent = ctx.playing ? t("pause") : t("play");
  });
  return row;
}

function togglePlay(ctx) {
  if (ctx.playing) {
    stopPlay(ctx);
    return;
  }
  const total = timelineFrames(ctx.tl);
  if (ctx.playFrame >= total) ctx.playFrame = 0;
  ctx.playing = true;
  ctx.timer = setInterval(function () {
    const max = timelineFrames(ctx.tl);
    ctx.playFrame += 1;
    if (ctx.playFrame >= max) {
      ctx.playFrame = max;
      stopPlay(ctx);
      return;
    }
    refreshAll(ctx);
  }, 1000 / FPS);
  refreshAll(ctx);
}

function stopPlay(ctx) {
  ctx.playing = false;
  if (ctx.timer) {
    clearInterval(ctx.timer);
    ctx.timer = 0;
  }
  refreshAll(ctx);
}

/* -------------------------------------------------- section 4: timeline */

/**
 * Map a pointer event to canvas-local x. The canvas is CSS-stretched to the
 * panel width, so hit tests must use the layout size, not the painted bitmap.
 */
function canvasX(canvas, ev) {
  const rect = canvas.getBoundingClientRect();
  const cssW = canvas.clientWidth || rect.width || 1;
  return ((ev.clientX - rect.left) * cssW) / (rect.width || cssW);
}

/** Append one shot, select it, persist. Shared by the canvas and the toolbar. */
function addShot(ctx) {
  pushHistory(ctx);
  const shot = cloneShot(null);
  shot.id = "s" + (ctx.tl.shots.length + 1) + "-" + Date.now().toString(36);
  ctx.tl.shots.push(shot);
  ctx.cur = ctx.tl.shots.length - 1;
  ctx.playFrame = 0;
  commit(ctx);
  setNotice(ctx, t("addDone") + String(ctx.tl.shots.length));
  return shot;
}

/** Frames of every shot before index i: the frame a shot starts on. */
function shotStartFrame(tl, index) {
  let acc = 0;
  for (let i = 0; i < tl.shots.length && i < index; i++) acc += shotFrames(tl.shots[i]);
  return acc;
}

/**
 * Split shots[index] at `frame`, a frame offset INSIDE that shot. Both halves
 * keep the prompt and every reference slot; only seconds and id change. A cut
 * that would leave a half below MIN_SHOT_FRAMES is refused instead of clamped,
 * because a silently widened shot would no longer match what was dragged.
 */
function splitShotAt(ctx, index, frame) {
  const shots = ctx.tl && ctx.tl.shots;
  if (!shots) return null;
  const i = clampNum(index, 0, shots.length - 1);
  const shot = shots[i];
  if (!shot) return null;
  const total = shotFrames(shot);
  const cut = Math.round(Number(frame) || 0);
  if (!(cut >= MIN_SHOT_FRAMES && total - cut >= MIN_SHOT_FRAMES)) {
    setNotice(ctx, t("shortShot"));
    return null;
  }
  pushHistory(ctx);
  const head = cloneShot(shot);
  const tail = cloneShot(shot);
  const stamp = Date.now().toString(36);
  head.id = "s" + (i + 1) + "-" + stamp;
  tail.id = "s" + (i + 2) + "-" + stamp;
  head.seconds = Math.round((cut / FPS) * 10000) / 10000;
  tail.seconds = Math.round(((total - cut) / FPS) * 10000) / 10000;
  shots.splice(i, 1, head, tail);
  ctx.cur = i + 1;
  ctx.playFrame = shotStartFrame(ctx.tl, i + 1);
  commit(ctx);
  setNotice(ctx, t("splitDone") + " \u00b7 " + cut + "f / " + (total - cut) + "f");
  return tail;
}

/** Toolbar entry: split the current shot at the playhead. */
function splitAtPlayhead(ctx) {
  const i = clampNum(ctx.cur, 0, ctx.tl.shots.length - 1);
  const shot = ctx.tl.shots[i];
  if (!shot) return null;
  const local = Math.round(ctx.playFrame - shotStartFrame(ctx.tl, i));
  return splitShotAt(ctx, i, local);
}

function sectionTimeline(ctx) {
  const wrap = el("div");
  wrap.style.cssText = "display:flex;flex-direction:column;gap:4px;flex:0 0 auto;";

  const canvas = document.createElement("canvas");
  canvas.className = "dsd-canvas";
  const hint = el("div", "dsd-hint", t("tlHint"));

  // inline confirm banner (never alert/confirm)
  const confirmBar = el("div", "dsd-confirm");
  const confirmText = el("span");
  const yesBtn = el("button", "dsd-btn", t("del"));
  const noBtn = el("button", "dsd-btn", t("cancel"));
  confirmBar.appendChild(confirmText);
  confirmBar.appendChild(el("div", "dsd-spacer"));
  confirmBar.appendChild(yesBtn);
  confirmBar.appendChild(noBtn);

  yesBtn.onclick = function () {
    if (ctx.notice === null) return;
    pushHistory(ctx);
    ctx.tl.shots.splice(ctx.notice, 1);
    if (!ctx.tl.shots.length) ctx.tl.shots.push(cloneShot(null));
    ctx.cur = clampNum(ctx.cur, 0, ctx.tl.shots.length - 1);
    hideConfirm(ctx);
    commit(ctx);
  };
  noBtn.onclick = function () {
    hideConfirm(ctx);
  };

  function showConfirm(index) {
    ctx.notice = index;
    ctx.confirmOpen = showConfirm;
    confirmText.textContent = t("delTitle") + " #" + (index + 1);
    confirmBar.classList.add("show");
  }

  ctx.els.timelineCanvas = canvas;
  ctx.els.confirmBar = confirmBar;

  // Pointer ownership: this ONE pointerdown decides between the resize drag
  // (pointer within 6 px of a block edge, i >= 1) and the reorder drag
  // (pointer anywhere inside a block body). The reorder drag only arms on
  // bodies, so the 6 px edge band still belongs exclusively to resize; the
  // click handler below skips its select step when a reorder actually moved.
  let drag = null;
  let reorder = null;
  canvas.addEventListener("pointerdown", function (ev) {
    if (ev.button !== 0) return;
    const x = canvasX(canvas, ev);
    const width = canvas.clientWidth || canvas.getBoundingClientRect().width || 1;
    let best = -1;
    let bestD = 6;
    for (let i = 1; i < ctx.bounds.length; i++) {
      const d = Math.abs(ctx.bounds[i].x0 - x);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    if (best < 0) {
      // Not on an edge: arm a possible reorder drag on the block body.
      for (let i = 0; i < ctx.bounds.length; i++) {
        if (x >= ctx.bounds[i].x0 && x <= ctx.bounds[i].x1) {
          reorder = { from: i, x0: x, moved: false };
          safe(function () {
            canvas.setPointerCapture(ev.pointerId);
          }, "reorder capture");
          break;
        }
      }
      return;
    }
    ev.preventDefault();
    pushHistory(ctx);
    const total = timelineFrames(ctx.tl) || 1;
    drag = { index: best, baseFrames: shotFrames(ctx.tl.shots[best - 1]), total: total, width: width };
    safe(function () {
      canvas.setPointerCapture(ev.pointerId);
    }, "pointer capture");
  });
  canvas.addEventListener("pointermove", function (ev) {
    if (reorder) {
      const rx = canvasX(canvas, ev);
      if (!reorder.moved && Math.abs(rx - reorder.x0) < 5) return;
      reorder.moved = true;
      ctx.reorder = { from: reorder.from, slot: reorderSlot(ctx.bounds, rx) };
      refreshAll(ctx);
      return;
    }
    if (!drag) return;
    const dx = canvasX(canvas, ev) - ctx.bounds[drag.index].x0;
    const delta = Math.round((dx / (drag.width || 1)) * drag.total);
    const next = Math.max(MIN_SHOT_FRAMES, drag.baseFrames + delta);
    const shot = ctx.tl.shots[drag.index - 1];
    if (!shot) return;
    shot.seconds = Math.round((next / FPS) * 10000) / 10000;
    refreshAll(ctx);
  });
  canvas.addEventListener("pointerup", function (ev) {
    if (reorder) {
      const done = reorder;
      const state = ctx.reorder;
      reorder = null;
      ctx.reorder = null;
      safe(function () {
        canvas.releasePointerCapture(ev.pointerId);
      }, "reorder release");
      if (done.moved && state) {
        // Suppress the click that follows this mouseup: it would re-select
        // whatever now sits under the pointer, not the shot that was moved.
        ctx.suppressClick = true;
        moveShotTo(ctx, done.from, state.slot);
      } else {
        refreshAll(ctx);
      }
      return;
    }
    if (!drag) return;
    drag = null;
    safe(function () {
      canvas.releasePointerCapture(ev.pointerId);
    }, "pointer release");
    commit(ctx);
  });

  // ---- seek by clicking a shot
  canvas.addEventListener("click", function (ev) {
    if (ctx.suppressClick) {
      ctx.suppressClick = false;
      return;
    }
    const x = canvasX(canvas, ev);
    for (let i = 0; i < ctx.bounds.length; i++) {
      if (x >= ctx.bounds[i].x0 && x <= ctx.bounds[i].x1) {
        ctx.cur = i;
        ctx.playFrame = ctx.bounds[i].start;
        refreshAll(ctx);
        return;
      }
    }
  });

  // ---- double-click inside a shot splits it there; past the last shot it
  // appends one (the old behaviour), and a boundary hit never edits anything.
  canvas.addEventListener("dblclick", function (ev) {
    const x = canvasX(canvas, ev);
    for (let i = 1; i < ctx.bounds.length; i++) {
      if (Math.abs(ctx.bounds[i].x0 - x) <= 6) return;
    }
    const total = timelineFrames(ctx.tl) || 1;
    const width = canvas.clientWidth || canvas.getBoundingClientRect().width || 1;
    const frame = clampNum((x / width) * total, 0, total);
    for (let i = 0; i < ctx.bounds.length; i++) {
      const b = ctx.bounds[i];
      if (x >= b.x0 && x <= b.x1) {
        ctx.cur = i;
        splitShotAt(ctx, i, frame - b.start);
        return;
      }
    }
    addShot(ctx);
  });

  // ---- right-click a shot opens the confirm banner
  canvas.addEventListener("contextmenu", function (ev) {
    ev.preventDefault();
    const x = canvasX(canvas, ev);
    for (let i = 0; i < ctx.bounds.length; i++) {
      if (x >= ctx.bounds[i].x0 && x <= ctx.bounds[i].x1) {
        if (ctx.tl.shots.length <= 1) {
          setNotice(ctx, t("shortShot"));
          return;
        }
        showConfirm(i);
        return;
      }
    }
  });

  ctx.updaters.push(function () {
    const win = numWidget(ctx.node, "window_frames", 124);
    const ctxFrames = numWidget(ctx.node, "context_frames", 20);
    const painted = paintTimeline(canvas, ctx.tl, ctx.cur, ctx.playFrame, win, ctxFrames, ctx);
    if (painted) ctx.bounds = painted.bounds;
  });

  wrap.appendChild(canvas);
  wrap.appendChild(confirmBar);
  wrap.appendChild(hint);
  return wrap;
}

function hideConfirm(ctx) {
  ctx.notice = null;
  ctx.confirmOpen = null;
  if (ctx.els.confirmBar) ctx.els.confirmBar.classList.remove("show");
}

/* --------------------------------------------------- section 5: summary */

function sectionSummary(ctx) {
  const box = el("div", "dsd-summary");
  const top = el("div", "dsd-sum-row");
  const bottom = el("div", "dsd-sum-row dsd-sum-cur");
  ctx.els.sumSegs = el("span");
  ctx.els.sumNet = el("span");
  ctx.els.sumFrames = el("span");
  ctx.els.sumDur = el("span");
  ctx.els.sumWin = el("span");
  ctx.els.sumWall = el("span");
  top.appendChild(ctx.els.sumSegs);
  top.appendChild(ctx.els.sumNet);
  top.appendChild(ctx.els.sumFrames);
  top.appendChild(ctx.els.sumDur);
  top.appendChild(ctx.els.sumWin);
  top.appendChild(ctx.els.sumWall);

  ctx.els.sumCur = el("span");
  ctx.els.sumCurFrames = el("span");
  ctx.els.sumCurDur = el("span");
  ctx.els.sumCurTc = el("span");
  bottom.appendChild(ctx.els.sumCur);
  bottom.appendChild(ctx.els.sumCurFrames);
  bottom.appendChild(ctx.els.sumCurDur);
  bottom.appendChild(ctx.els.sumCurTc);

  const framesInput = document.createElement("input");
  framesInput.type = "number";
  framesInput.className = "dsd-num";
  framesInput.min = String(MIN_SHOT_FRAMES);
  framesInput.step = "1";
  framesInput.title = t("curFramesEdit");
  framesInput.onchange = function () {
    const shot = ctxShot(ctx);
    if (!shot) return;
    const v = Math.max(MIN_SHOT_FRAMES, Math.round(Number(framesInput.value) || MIN_SHOT_FRAMES));
    pushHistory(ctx);
    shot.seconds = Math.round((v / FPS) * 10000) / 10000;
    commit(ctx);
  };
  bottom.appendChild(el("span", "dsd-hint", t("curFramesEdit")));
  bottom.appendChild(framesInput);

  const costRow = el("div", "dsd-sum-row");
  const costText = el("span", "dsd-hint", "");
  const vramText = el("span", "dsd-hint", "");
  costRow.appendChild(costText);
  costRow.appendChild(vramText);
  ctx.els.costRow = costRow;
  ctx.els.costText = costText;
  ctx.els.costVramText = vramText;
  box.appendChild(top);
  box.appendChild(bottom);

  ctx.updaters.push(function () {
    const node = ctx.node;
    const win = numWidget(node, "window_frames", 124);
    const ctxFrames = numWidget(node, "context_frames", 20);
    const total = timelineFrames(ctx.tl);
    const stride = Math.max(1, Math.round(win) - Math.round(ctxFrames));
    kv(ctx.els.sumSegs, t("segLbl"), String(ctx.tl.shots.length));
    kv(ctx.els.sumNet, t("netLbl"), "+" + stride + "f");
    kv(ctx.els.sumFrames, t("framesLbl"), String(total));
    kv(ctx.els.sumDur, t("durLbl"), fmtSeconds(total / FPS));
    kv(ctx.els.sumWin, t("winLbl"), Math.round(win) + "/" + Math.round(ctxFrames));

    // Measured beats assumed: a number parsed from segment_done for this
    // geometry is the only "real" wall clock the panel can show; the preset
    // table is a 124-frame reference run and is labelled as an estimate.
    const segs = Math.max(1, ctx.tl.shots.length);
    const measured = measuredWall(node);
    const wallEach = presetWall(String(widgetValue(node, "preset", "")));
    if (measured !== null) {
      kv(ctx.els.sumWall, t("wallLbl"),
        fmtSeconds(measured) + " \u00d7 " + segs + t("wallSegSuffix") + " \u2248 " +
        fmtSeconds(measured * segs) + " (" + t("wallMeasured") + ")");
    } else if (wallEach === null) {
      kv(ctx.els.sumWall, t("wallLbl"), t("wallUnknown"));
    } else {
      const perShot = (wallEach / 124) * (total / segs);
      const all = (wallEach / 124) * total;
      kv(ctx.els.sumWall, t("wallLbl"),
        fmtSeconds(perShot) + " \u00d7 " + segs + t("wallSegSuffix") + " \u2248 " +
        fmtSeconds(all) + " (" + t("wallEst") + ")");
    }

    // Current shot: its own frames, duration, timecode and which model segments
    // it will need, so a long timeline still answers "how long is this one".
    const idx = clampNum(ctx.cur, 0, ctx.tl.shots.length - 1);
    const shot = ctx.tl.shots[idx];
    const frames = shot ? shotFrames(shot) : 0;
    kv(ctx.els.sumCur, t("curLbl"), (idx + 1) + "/" + ctx.tl.shots.length);
    kv(ctx.els.sumCurFrames, t("curFramesLbl"), String(frames));
    kv(ctx.els.sumCurDur, t("curDurLbl"), fmtSeconds(frames / FPS));
    kv(ctx.els.sumCurTc, t("curTcLbl"), fmtTimecode(frames));
    if (document.activeElement !== framesInput) framesInput.value = String(frames);

    // Cost card: wall from presetWall() scaled by the segment count, VRAM from
    // gen_w/gen_h/pass2/upscale through the COST_VRAM fit above.
    const wall = estimateWall(node, ctx.tl);
    costText.textContent = t("costWall") + ": " +
      (wall.seconds === null ? t("wallUnknown") : "≈ " + fmtSeconds(wall.seconds)) +
      " · " + wall.segs + " " + t("costSegs");
    vramText.textContent = t("costVram") + ": ≈ " + estimateVram(node).toFixed(1) + " GB · " + t("costRough");
    if (costRow.parentNode !== box) box.appendChild(costRow);
  });
  return box;
}

/* ----------------------------------------------------- section 6: output */

/**
 * One editable output field. Reads through numWidget with a fallback, writes
 * through setWidgetValue so a missing widget simply does nothing.
 */
function outField(ctx, labelText, name, opts) {
  const o = opts || {};
  const item = el("div", "dsd-out-item");
  const input = document.createElement("input");
  input.type = "number";
  input.step = o.step || "1";
  if (o.min !== undefined) input.min = String(o.min);
  if (o.max !== undefined) input.max = String(o.max);
  input.setAttribute("data-widget", name);
  const read = function () {
    return o.float ? numWidget(ctx.node, name, o.fallback || 0)
      : numWidget(ctx.node, name, o.fallback || 0);
  };
  const write = function (v) {
    setWidgetValue(ctx.node, name, o.float ? v : Math.round(v));
  };
  input.value = String(read());
  input.onchange = function () {
    const v = parseFloat(input.value);
    if (!Number.isFinite(v)) {
      input.value = String(read());
      return;
    }
    const clamped = clampNum(v, o.min === undefined ? -1e6 : o.min, o.max === undefined ? 1e6 : o.max);
    if (o.float) setWidgetValue(ctx.node, name, clamped);
    else setWidgetValue(ctx.node, name, Math.round(clamped));
    refreshAll(ctx);
  };
  item.appendChild(el("span", null, labelText));
  item.appendChild(input);
  ctx.updaters.push(function () {
    if (document.activeElement !== input) input.value = String(read());
  });
  return item;
}

function sectionOutput(ctx) {
  const wrap = el("div", "dsd-outs");
  wrap.appendChild(outField(ctx, t("outLbl"), "out_w", { min: 16, fallback: 0 }));
  wrap.appendChild(outField(ctx, t("outHLbl"), "out_h", { min: 16, fallback: 0 }));
  wrap.appendChild(outField(ctx, t("genLbl"), "gen_w", { min: 32, fallback: 1376 }));
  wrap.appendChild(outField(ctx, t("genHLbl"), "gen_h", { min: 32, fallback: 768 }));
  wrap.appendChild(outField(ctx, t("upLbl"), "upscale", {
    step: "0.1", min: 1, max: 4, float: true, fallback: 1,
  }));
  wrap.appendChild(outField(ctx, t("unsharpLbl"), "unsharp", {
    step: "0.1", min: 0, max: 2, float: true, fallback: 0,
  }));

  const derived = el("div", "dsd-derived");
  wrap.appendChild(derived);
  ctx.els.derived = derived;

  ctx.updaters.push(function () {
    const node = ctx.node;
    const genW = numWidget(node, "gen_w", 0);
    const genH = numWidget(node, "gen_h", 0);
    const up = numWidget(node, "upscale", 1);
    const finW = numWidget(node, "final_w", 0);
    const finH = numWidget(node, "final_h", 0);
    const pass2 = !!widgetValue(node, "pass2", true);
    const calcW = align32(genW * up);
    const calcH = align32(genH * up);
    const warns = [];
    if (genW && genW % 32 !== 0) warns.push("gen_w " + genW + " " + t("warn32"));
    if (genH && genH % 32 !== 0) warns.push("gen_h " + genH + " " + t("warn32"));
    if (finW && calcW && Math.abs(finW - calcW) > 2) warns.push("final_w " + finW + " \u2260 " + calcW + " " + t("warnFix"));
    if (finH && calcH && Math.abs(finH - calcH) > 2) warns.push("final_h " + finH + " \u2260 " + calcH + " " + t("warnFix"));
    if (!pass2 && up > 1) warns.push(t("warnPass2"));

    clearNode(derived);
    derived.appendChild(el("span", null, t("derivedLbl") + " "));
    derived.appendChild(el("b", null,
      genW + "\u00d7" + genH + " \u00d7" + up.toFixed(1) + " = " + calcW + "\u00d7" + calcH +
      " \uff08final " + finW + "\u00d7" + finH + "\uff09"));
    if (warns.length) {
      derived.appendChild(document.createElement("br"));
      derived.appendChild(el("span", "dsd-warn", warns.join(" \u00b7 ")));
    }
  });
  return collapsible(ctx, "output", t("secOutputHdr"), wrap);
}

/* ------------------------------------------------------- section 7: shot */

function refSlot(ctx, kind, index) {
  const slot = el("div", "dsd-slot dsd-ref-slot");
  slot.setAttribute("data-kind", kind);
  slot.setAttribute("data-index", String(index));
  slot.title = t("slotEmpty") + " " + kind + " " + (index + 1);

  const picker = document.createElement("input");
  picker.type = "file";
  picker.style.display = "none";
  picker.accept = kind === "video" ? "video/*" : kind === "audio" ? "audio/*" : "image/*";

  function listKey() {
    return kind === "video" ? "refVideos" : kind === "audio" ? "refAudios" : "refs";
  }

  function currentPath() {
    const shot = ctxShot(ctx);
    if (!shot) return "";
    const list = shot[listKey()];
    return list && list[index] ? list[index] : "";
  }

  function paint() {
    // build: media | label | remove
    while (slot.firstChild) slot.removeChild(slot.firstChild);
    const path = currentPath();
    slot.classList.toggle("filled", !!path);
    if (path) {
      if (kind === "video") {
        const v = document.createElement("video");
        v.src = viewURL(path);
        v.muted = true;
        v.preload = "metadata";
        v.style.cssText = "width:100%;height:100%;object-fit:cover";
        slot.appendChild(v);
      } else if (kind === "audio") {
        slot.appendChild(el("span", null, "♪"));
      } else {
        const im = document.createElement("img");
        im.src = viewURL(path);
        im.alt = "";
        im.onerror = function () {
          im.style.display = "none";
          slot.appendChild(el("span", null, "✕"));
        };
        slot.appendChild(im);
      }
      const tag = el("span", "dsd-tag", String(index + 1));
      slot.appendChild(tag);
      const x = el("span", "dsd-x", "×");
      x.title = t("removeLbl");
      x.onclick = function (ev) {
        ev.stopPropagation();
        const shot = ctxShot(ctx);
        if (!shot) return;
                pushHistory(ctx);
shot[listKey()].splice(index, 1);
        // refTypes is index-parallel with the media list; dropping a file must
        // drop its type too, otherwise every later slot keeps the wrong label.
        if (isArray(shot.refTypes) && shot.refTypes.length > index) {
          shot.refTypes.splice(index, 1);
        }
        commit(ctx);
      };
      slot.appendChild(x);
    } else {
      slot.appendChild(el("span", null, t("slotEmpty") + "\n" + (index + 1)));
    }
  }

  slot.onclick = function (ev) {
    if (ev.target && ev.target.classList && ev.target.classList.contains("dsd-x")) return;
    picker.value = "";
    picker.click();
  };

  async function doUpload(file) {
    if (!file) return;
    slot.classList.add("filled");
    slot.textContent = t("uploading");
    try {
      const res = await uploadToInput(file);
      const path = refPath(res);
      const shot = ctxShot(ctx);
      if (shot && path) {
                pushHistory(ctx);
const key = listKey();
        while (shot[key].length < index) shot[key].push("");
        shot[key][index] = path;
        // A fresh slot starts untyped; the kind chips below stay in charge of
        // which subject line gets written, so no template is forced here.
        if (!isArray(shot.refTypes)) shot.refTypes = [];
        while (shot.refTypes.length <= index) shot.refTypes.push("");
        commit(ctx);
      }
      setNotice(ctx, "");
    } catch (err) {
      setNotice(ctx, t("upFail") + String(err && err.message ? err.message : err));
      paint();
    }
  }

  picker.onchange = function () {
    doUpload(picker.files && picker.files[0]);
  };

  slot.addEventListener("dragover", function (ev) {
    ev.preventDefault();
    slot.classList.add("dsd-drop");
  });
  slot.addEventListener("dragleave", function () {
    slot.classList.remove("dsd-drop");
  });
  slot.addEventListener("drop", function (ev) {
    ev.preventDefault();
    ev.stopPropagation();
    slot.classList.remove("dsd-drop");
    const files = ev.dataTransfer && ev.dataTransfer.files;
    doUpload(files && files[0]);
  });

  ctx.updaters.push(paint);
  slot._dsdPicker = picker;
  slot._dsdPaint = paint;

  const holder = el("span");
  holder.style.display = "none";
  holder.appendChild(picker);
  return { slot: slot, picker: picker };
}

/** Per-shot parameter overrides: blank means "inherit the global widget". */
function overrideBar(ctx) {
  const box = el("div", "dsd-ovr");
  box.appendChild(el("label", null, t("ovrLbl")));
  const refs = [];

  function ov() {
    const shot = ctxShot(ctx);
    if (!shot) return null;
    if (!shot.overrides || typeof shot.overrides !== "object" || isArray(shot.overrides)) shot.overrides = {};
    return shot.overrides;
  }

  function put(k, v) {
    pushHistory(ctx);
    const target = ov();
    if (!target) return;
    if (v === "" || v === null || v === undefined) delete target[k];
    else target[k] = v;
    commit(ctx);
  }

  function numField(k, labelText, step, min, max) {
    const wrap = el("div", "dsd-oi");
    wrap.appendChild(el("span", null, labelText));
    const input = document.createElement("input");
    input.type = "number";
    input.step = String(step);
    input.min = String(min);
    input.max = String(max);
    input.placeholder = t("ovrInherit");
    input.setAttribute("data-ovr", k);
    input.onchange = function () {
      const raw = input.value.trim();
      if (!raw) { put(k, ""); return; }
      const v = parseFloat(raw);
      if (!Number.isFinite(v)) { input.value = ""; put(k, ""); return; }
      const c = clampNum(v, min, max);
      put(k, step >= 1 ? Math.round(c) : c);
    };
    wrap.appendChild(input);
    box.appendChild(wrap);
    refs.push({ key: k, input: input });
  }

  function selField(k, labelText, options) {
    const wrap = el("div", "dsd-oi");
    wrap.appendChild(el("span", null, labelText));
    const sel = document.createElement("select");
    sel.setAttribute("data-ovr", k);
    const blank = document.createElement("option");
    blank.value = "";
    blank.textContent = t("ovrInherit");
    sel.appendChild(blank);
    for (let i = 0; i < options.length; i++) {
      const op = document.createElement("option");
      op.value = options[i];
      op.textContent = options[i];
      sel.appendChild(op);
    }
    sel.onchange = function () {
      put(k, sel.value);
    };
    wrap.appendChild(sel);
    box.appendChild(wrap);
    refs.push({ key: k, input: sel });
  }

  numField("steps", t("ovrSteps"), 1, 1, 64);
  selField("solver", t("ovrSolver"), ["euler", "exp2"]);
  numField("shift_video", t("ovrSv"), 0.5, 1, 64);
  numField("shift_audio", t("ovrSa"), 0.5, 1, 64);
  numField("pass2_steps", t("ovrP2"), 1, 0, 64);

  const clearBtn = el("button", "dsd-btn", t("ovrClear"));
  clearBtn.title = t("ovrHint");
  clearBtn.onclick = function () {
    const shot = ctxShot(ctx);
    if (!shot) return;
        pushHistory(ctx);
shot.overrides = {};
    commit(ctx);
    setNotice(ctx, t("ovrDone"));
  };
  box.appendChild(el("div", "dsd-spacer"));
  const count = el("span", "dsd-hint", "");
  box.appendChild(count);
  box.appendChild(clearBtn);

  ctx.updaters.push(function () {
    const shot = ctxShot(ctx);
    const data = normalizeOverrides(shot && shot.overrides);
    for (let i = 0; i < refs.length; i++) {
      const f = refs[i];
      if (document.activeElement === f.input) continue;
      const v = data[f.key];
      f.input.value = v === undefined ? "" : String(v);
      f.input.classList.toggle("dsd-set", v !== undefined);
    }
    const n = overrideCount(shot);
    count.textContent = n ? t("ovrHas") + " " + n + "/5" : t("ovrNone");
  });
  return box;
}
/* ------------------------------------------- prompt sections + meter */

/**
 * Chip row for the eight canonical prompt sections plus the length meter.
 * A section counts as present as soon as its name appears anywhere in the
 * prompt (see hasSection); clicking a missing chip appends a skeleton so the
 * writer only has to fill it in. Both read the live textarea value so they
 * react to oninput, not just to a refresh.
 */
function promptInspector(ctx, ta) {
  const box = el("div", "dsd-psec");
  const row = el("div", "dsd-psec");
  const count = el("span", "dsd-hint", "");
  const meter = el("span", "dsd-meter", "");
  box.appendChild(row);
  box.appendChild(count);
  box.appendChild(meter);

  const chips = [];
  for (let i = 0; i < PROMPT_SECTIONS.length; i++) {
    const name = PROMPT_SECTIONS[i];
    const chip = el("span", "dsd-chip-sec dsd-chip-off", name);
    chip.title = name;
    chip.setAttribute("data-sec", name);
    chip.onclick = function () {
      const shot = ctxShot(ctx);
      if (!shot) return;
      if (hasSection(ta.value, name)) {
        setNotice(ctx, t("secChipOn") + " " + name);
        return;
      }
      pushHistory(ctx);
      const base = ta.value.replace(/\s+$/, "");
      const add = sectionSkeleton(name);
      ta.value = base ? base + (/(\n\n)$/.test(base) ? "" : "\n\n") + add : add;
      shot.prompt = ta.value;
      commit(ctx);
      setNotice(ctx, t("secChipOff") + " " + name);
    };
    row.appendChild(chip);
    chips.push({ name: name, chip: chip });
  }

  function paint() {
    const shot = ctxShot(ctx);
    const text = String((shot && shot.prompt) || ta.value || "");
    let present = 0;
    for (let i = 0; i < chips.length; i++) {
      const on = hasSection(text, chips[i].name);
      if (on) present += 1;
      chips[i].chip.classList.toggle("dsd-chip-on", on);
      chips[i].chip.classList.toggle("dsd-chip-off", !on);
    }
    count.textContent = present + t("secCountSuffix");
    const need = minCharsFor(ctx.node);
    const n = text.length;
    meter.textContent = n + " " + t("meterUnit") + " / " + t("meterNeed") + " " + need;
    meter.classList.toggle("dsd-meter-red", n < need);
    meter.classList.toggle("dsd-meter-amber", n >= need && n < need * 1.15);
    meter.classList.toggle("dsd-meter-teal", n >= need * 1.15);
  }

  ctx.updaters.push(paint);
  ctx.els.promptChips = row;
  ctx.els.promptMeter = meter;
  safe(paint, "chip paint");
  return box;
}

function sectionShot(ctx) {
  const wrap = el("div", "dsd-cards");
  const left = el("div", "dsd-left");
  const right = el("div", "dsd-right");

  function group(labelText, kind, count) {
    const g = el("div", "dsd-grp");
    g.appendChild(el("label", null, labelText));
    const slots = [];
    for (let i = 0; i < count; i++) {
      const made = refSlot(ctx, kind, i);
      slots.push(made.slot);
      g.appendChild(made.slot);
      g.appendChild(made.picker);
    }
    return g;
  }

  const leftInner = el("div");
  leftInner.style.cssText = "display:flex;flex-direction:column;gap:4px;";
  left.appendChild(collapsible(ctx, "refs", t("secRefsHdr"), leftInner));
  leftInner.appendChild(group(t("imgTitle"), "image", IMG_SLOTS));

  const typeBar = el("div", "dsd-types");
  typeBar.appendChild(el("label", null, t("typeLbl")));
  const chipRow = el("div", "dsd-chips");
  typeBar.appendChild(chipRow);
  const regenBtn = el("button", "dsd-btn", t("regenEntities"));
  regenBtn.title = t("typeHint");
  regenBtn.onclick = function () {
    const shot = ctxShot(ctx);
    if (!shot) return;
    rebuildEntities(shot);
    commit(ctx);
    setNotice(ctx, t("entitiesDone"));
  };
  typeBar.appendChild(el("div", "dsd-spacer"));
  typeBar.appendChild(regenBtn);
  leftInner.appendChild(typeBar);

  ctx.updaters.push(function () {
    const shot = ctxShot(ctx);
    clearNode(chipRow);
    const refs = shot && isArray(shot.refs) ? shot.refs : [];
    let typed = 0;
    for (let i = 0; i < refs.length; i++) {
      if (!refs[i]) continue;
      typed += 1;
      const chip = el("span", "dsd-chip");
      chip.appendChild(el("b", null, "<Picture " + (i + 1) + ">"));
      const sel = document.createElement("select");
      sel.className = "dsd-sel";
      sel.setAttribute("data-type-slot", String(i));
      const blank = document.createElement("option");
      blank.value = "";
      blank.textContent = t("typeNone");
      sel.appendChild(blank);
      for (let k = 0; k < ENTITY_KINDS.length; k++) {
        const op = document.createElement("option");
        op.value = ENTITY_KINDS[k].id;
        op.textContent = entityKindLabel(ENTITY_KINDS[k].id);
        sel.appendChild(op);
      }
      sel.value = refTypeAt(shot, i);
      sel.onchange = function () {
        const target = ctxShot(ctx);
        if (!target) return;
        if (!isArray(target.refTypes)) target.refTypes = [];
        while (target.refTypes.length <= i) target.refTypes.push("");
        target.refTypes[i] = sel.value;
        rebuildEntities(target);
        commit(ctx);
      };
      chip.appendChild(sel);
      chipRow.appendChild(chip);
    }
    if (!typed) chipRow.appendChild(el("span", "dsd-hint", t("typeEmpty")));
  });

  leftInner.appendChild(group(t("vidTitle"), "video", VID_SLOTS));
  leftInner.appendChild(group(t("audTitle"), "audio", AUD_SLOTS));

  const nav = el("div", "dsd-nav");
  const prev = el("button", "dsd-btn", t("prevShot"));
  const shotNo = el("span", "dsd-shotno", "1 / 1");
  const next = el("button", "dsd-btn", t("nextShot"));
  // Clamp, do not wrap. The old modulo navigation jumped from the last shot
  // back to the first, which reads as a lost shot when the timeline is long
  // and made Prev/Next useless as a walk-through while reviewing prompts.
  prev.onclick = function () {
    ctx.cur = clampNum(ctx.cur - 1, 0, Math.max(0, ctx.tl.shots.length - 1));
    ctx.playFrame = 0;
    refreshAll(ctx);
  };
  next.onclick = function () {
    ctx.cur = clampNum(ctx.cur + 1, 0, Math.max(0, ctx.tl.shots.length - 1));
    ctx.playFrame = 0;
    refreshAll(ctx);
  };
  nav.appendChild(prev);
  nav.appendChild(shotNo);
  nav.appendChild(next);

  const movePrev = el("button", "dsd-btn", t("movePrev"));
  movePrev.onclick = function () {
    moveShot(ctx, -1);
  };
  const moveNext = el("button", "dsd-btn", t("moveNext"));
  moveNext.onclick = function () {
    moveShot(ctx, 1);
  };
  const dupBtn = el("button", "dsd-btn", t("dupShot"));
  dupBtn.onclick = function () {
    duplicateShot(ctx);
  };
  // The panel had no visible delete affordance: the only button lived inside
  // the inline confirm bar, so deleting required discovering right-click on the
  // timeline. Put a labelled delete next to the shot navigation.
  const delShotBtn = el("button", "dsd-btn", t("delShot"));
  delShotBtn.title = t("delShotHint");
  delShotBtn.onclick = function () {
    askDeleteShot(ctx, ctx.cur);
  };
  const usePrev = el("button", "dsd-btn", t("usePrev"));
  usePrev.onclick = function () {
    const i = clampNum(ctx.cur, 0, ctx.tl.shots.length - 1);
    if (i <= 0) {
      setNotice(ctx, t("usePrevFirst"));
      return;
    }
    showShotConfirm(ctx, t("usePrevAsk"), t("usePrevYes"), function () {
      copyPrevShot(ctx);
    });
  };
  nav.appendChild(movePrev);
  nav.appendChild(moveNext);
  nav.appendChild(dupBtn);
  nav.appendChild(usePrev);
  nav.appendChild(delShotBtn);

  const promptLabel = el("label", "dsd-hint", t("promptLbl"));
  const ta = document.createElement("textarea");
  ta.className = "dsd-prompt";
  ta.setAttribute("data-slot", "prompt");
  ta.placeholder = t("promptHint");
  ta.oninput = function () {
    const shot = ctxShot(ctx);
    if (!shot) return;
    shot.prompt = ta.value;
    writeTimeline(ctx.node, ctx.tl);
    // Chips and meter follow typing without waiting for a full repaint.
    refreshAll(ctx);
  };
  // Typing is one undo step per focus session: the snapshot is taken on the
  // first focus and only kept if the text really changed by blur.
  ta.onfocus = function () {
    beginEdit(ctx);
  };
  ta.onblur = function () {
    endEdit(ctx);
  };

  right.appendChild(promptLabel);
  right.appendChild(ta);
  right.appendChild(promptInspector(ctx, ta));
  right.appendChild(nav);
  right.appendChild(overrideBar(ctx));
  ctx.els.prompt = ta;
  ctx.els.shotNo = shotNo;

  ctx.updaters.push(function () {
    const shot = ctxShot(ctx);
    shotNo.textContent = (clampNum(ctx.cur, 0, ctx.tl.shots.length - 1) + 1) + " / " + ctx.tl.shots.length;
    if (document.activeElement !== ta) ta.value = shot ? shot.prompt : "";
  });

  // ---- shot tools: per-shot export/import and a clear-references confirm
  const tools = el("div", "dsd-shotbar");
  const exportBtn = el("button", "dsd-btn", t("exportShot"));
  exportBtn.onclick = function () {
    exportShotFile(ctx);
  };
  const importBtn = el("button", "dsd-btn", t("importShot"));
  importBtn.onclick = function () {
    importShotFile(ctx);
  };
  const clearBtn = el("button", "dsd-btn", t("clearRefs"));
  clearBtn.onclick = function () {
    showShotConfirm(ctx, t("clearRefsAsk"), t("clearRefsYes"), function () {
      clearShotRefs(ctx);
    });
  };
  tools.appendChild(exportBtn);
  tools.appendChild(importBtn);
  tools.appendChild(clearBtn);

  const picker = document.createElement("input");
  picker.type = "file";
  picker.accept = ".json,application/json";
  picker.style.display = "none";
  picker.onchange = function () {
    const file = picker.files && picker.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = function () {
      importShotPayload(ctx, String(reader.result || ""));
      picker.value = "";
    };
    reader.readAsText(file);
  };
  ctx.els.shotPicker = picker;

  const shotConfirm = el("div", "dsd-confirm");
  const shotConfirmText = el("span");
  const shotConfirmYes = el("button", "dsd-btn dsd-primary", t("usePrevYes"));
  const shotConfirmNo = el("button", "dsd-btn", t("cancel"));
  shotConfirm.appendChild(shotConfirmText);
  shotConfirm.appendChild(el("div", "dsd-spacer"));
  shotConfirm.appendChild(shotConfirmYes);
  shotConfirm.appendChild(shotConfirmNo);
  shotConfirmYes.onclick = function () {
    const fn = ctx.shotConfirmFn;
    hideShotConfirm(ctx);
    safe(fn, "shot confirm");
  };
  shotConfirmNo.onclick = function () {
    hideShotConfirm(ctx);
  };
  ctx.els.shotConfirmBar = shotConfirm;
  ctx.els.shotConfirmText = shotConfirmText;
  ctx.els.shotConfirmYes = shotConfirmYes;

  wrap.appendChild(left);
  wrap.appendChild(right);
  wrap.appendChild(tools);
  wrap.appendChild(shotConfirm);
  wrap.appendChild(picker);
  return wrap;
}

/* ----------------------------------------------------- section 8: preset */

function sectionPreset(ctx) {
  const row = el("div", "dsd-presets");
  row.appendChild(el("span", null, t("presetLbl")));
  for (let i = 0; i < PRESETS.length; i++) {
    const p = PRESETS[i];
    const btn = el("button", "dsd-btn", PANEL_LANG === "en" ? p.en : p.name);
    btn.setAttribute("data-preset", p.id);
    btn.onclick = function () {
      applyPreset(ctx, p);
    };
    row.appendChild(btn);
  }
  row.appendChild(el("span", "dsd-note", t("presetNote")));
  ctx.els.presetRow = row;
  ctx.updaters.push(function () {
    const cur = String(widgetValue(ctx.node, "preset", ""));
    const kids = row.querySelectorAll("button[data-preset]");
    for (let i = 0; i < kids.length; i++) {
      const id = kids[i].getAttribute("data-preset");
      let match = false;
      for (let k = 0; k < PRESETS.length; k++) {
        if (PRESETS[k].id === id && PRESETS[k].name === cur) match = true;
      }
      kids[i].classList.toggle("dsd-on", match);
    }
  });
  return collapsible(ctx, "preset", t("secPresetHdr"), row);
}

/** Write one preset's full parameter set. Never queues a run. */
function applyPreset(ctx, preset) {
  pushHistory(ctx);
  const node = ctx.node;
  const keys = Object.keys(preset.patch);
  for (let i = 0; i < keys.length; i++) {
    setWidgetValue(node, keys[i], preset.patch[keys[i]]);
  }
  // Derived, never inherited: a stale final_w from the previous preset used to
  // surface as "final_w 2080 != 2064" the moment 1.5x was clicked after 2x.
  const gw = numWidget(node, "gen_w", 1376);
  const gh = numWidget(node, "gen_h", 768);
  const up = Number(widgetValue(node, "upscale", "1.0")) || 1;
  setWidgetValue(node, "final_w", align32(gw * up));
  setWidgetValue(node, "final_h", align32(gh * up));
  refreshAll(ctx);
  setNotice(ctx, "");
}

/* ----------------------------------------------------- section 9: status */

function sectionStatus(ctx) {
  const box = el("div", "dsd-status");

  function bar(labelText, fillClass) {
    const row = el("div", "dsd-row");
    const label = el("span", null, labelText);
    const track = el("div", "dsd-track");
    const fill = el("div", "dsd-fill" + (fillClass ? " " + fillClass : ""));
    const pct = el("span", "dsd-pct", "0%");
    track.appendChild(fill);
    row.appendChild(label);
    row.appendChild(track);
    row.appendChild(pct);
    return { row: row, fill: fill, pct: pct };
  }

  const overall = bar(t("overallLbl"), "");
  const seg = bar(t("segBarLbl"), "dsd-fill-seg");
  const phaseRow = el("div", "dsd-phase");
  const lamp = el("span", "dsd-lamp");
  const phaseText = el("span", null, t("statusIdle"));
  phaseRow.appendChild(lamp);
  phaseRow.appendChild(phaseText);
  const errBox = el("div", "dsd-err");
  // Preflight results land here: one line per issue, [E] red / [W] amber.
  const pfBox = el("div", "dsd-pf");
  pfBox.style.display = "none";

  // Run guard: only shown when preflight reported a blocking [E] line.
  const guardBar = el("div", "dsd-guard");
  const guardHead = el("div", null, "");
  const guardLines = el("div", "dsd-guard-lines", "");
  const guardEst = el("span", "dsd-hint", "");
  const guardBtns = el("div", "dsd-guard-btns");
  const guardGo = el("button", "dsd-btn dsd-primary", t("guardRun"));
  const guardNo = el("button", "dsd-btn", t("guardCancel"));
  guardGo.onclick = function () {
    const fn = ctx.guardFn;
    hideRunGuard(ctx);
    safe(fn, "guarded run");
  };
  guardNo.onclick = function () {
    hideRunGuard(ctx);
    setNotice(ctx, t("guardCancel"));
  };
  guardBtns.appendChild(guardGo);
  guardBtns.appendChild(guardNo);
  guardBtns.appendChild(guardEst);
  guardBar.appendChild(guardHead);
  guardBar.appendChild(guardLines);
  guardBar.appendChild(guardBtns);

  // Run log: lives on ctx.runLog, so a rebuildPanel / language switch keeps it.
  const logBox = el("div", "dsd-log", "");
  const logSec = collapsible(ctx, "runlog", t("logTitle"), logBox);

  box.appendChild(overall.row);
  box.appendChild(seg.row);
  box.appendChild(phaseRow);
  box.appendChild(errBox);
  box.appendChild(pfBox);
  box.appendChild(guardBar);
  box.appendChild(logSec);

  ctx.els.overallFill = overall.fill;
  ctx.els.overallPct = overall.pct;
  ctx.els.segFill = seg.fill;
  ctx.els.segPct = seg.pct;
  ctx.els.phaseRow = phaseRow;
  ctx.els.phaseText = phaseText;
  ctx.els.errBox = errBox;
  ctx.els.pfBox = pfBox;
  ctx.els.guardBar = guardBar;
  ctx.els.guardHead = guardHead;
  ctx.els.guardLines = guardLines;
  ctx.els.guardEst = guardEst;
  ctx.els.logBox = logBox;
  ctx.els.logSec = logSec;
  safe(function () { paintRunLog(ctx); }, "first run log paint");

  ctx.updaters.push(function () {
    const shots = ctx.tl.shots.length || 1;
    if (!ctx.runState) {
      overall.fill.style.width = "0%";
      seg.fill.style.width = "0%";
      overall.pct.textContent = "0%";
      seg.pct.textContent = "0%";
      return;
    }
    const rs = ctx.runState;
    // Overall = the run-level pct the backend sends (docs/80 §7: 0-100 for the whole run);
    // Segment = position in the segment list, so the two bars never mirror each other.
    const totalSegs = Math.max(1, Math.round(rs.segs || shots));
    const overallPct = Math.round(clampNum(rs.pct, 0, 100));
    // Segment bar = progress inside the CURRENT segment, not its position
    // in the list: pct is run-level and segments share it evenly, so the
    // within-segment fraction is pct*totalSegs - segIndex.
    let frac = (clampNum(rs.pct, 0, 100) / 100) * totalSegs - (rs.seg || 0);
    if (!Number.isFinite(frac)) frac = 0;
    const segPct = Math.round(clampNum(frac, 0, 1) * 100);
    overall.fill.style.width = overallPct + "%";
    seg.fill.style.width = segPct + "%";
    overall.pct.textContent = overallPct + "%";
    seg.pct.textContent = segPct + "%";
  });
  return box;
}

/** Update the run state + status texts from a progress event. */
function applyProgress(ctx, detail) {
  const d = detail || {};
  const phase = String(d.phase || "");
    safe(function () { logRun(ctx, phase, d.note, Number(d.seg)); }, "run log");
  // Terminal latch: the backend emits "export" AFTER "done", so a late
  // export event (pct 99) used to drag the finished bars back from 100%.
  // Anything arriving after the terminal phase is logged above and then
  // ignored, so the panel keeps showing the completed run.
  if (ctx.finished && phase !== "done") return;
if (phase === "segment_done") {
    // note is "%0.1fs" from the backend; only a parsed number is persisted.
    safe(function () {
      recordSegmentSeconds(ctx, d.note);
    }, "record segment seconds");
  }
  if (phase === "done") {
    safe(function () {
      finishWallClock(ctx);
    }, "record run wall clock");
    // Keep the bars at 100% instead of nulling runState: null makes the
    // updater below paint 0%, so a finished run looked like it never ran.
    const _segs = Math.max(1, Number(d.segs) || ctx.tl.shots.length || 1);
    ctx.runState = { seg: _segs - 1, segs: _segs, pct: 100, phase: "done" };
    ctx.finished = true;
    if (ctx.els.phaseRow) {
      ctx.els.phaseRow.classList.remove("running");
      ctx.els.phaseRow.classList.add("done");
    }
    if (ctx.els.phaseText) ctx.els.phaseText.textContent = t("statusDone");
    if (ctx.els.errBox) {
      ctx.els.errBox.style.display = "none";
      ctx.els.errBox.textContent = "";
    }
    refreshAll(ctx);
    return;
  }
  const segNo = Number(d.seg);
  const segsTotal = Number(d.segs);
  ctx.runState = {
    seg: Number.isFinite(segNo) ? Math.max(0, segNo) : 0,
    segs: Number.isFinite(segsTotal) ? segsTotal : ctx.tl.shots.length,
    pct: Number.isFinite(Number(d.pct)) ? Number(d.pct) : 0,
    phase: phase,
  };
  if (phase === "error" && d.note && ctx.els.errBox) {
    ctx.els.errBox.style.display = "block";
    ctx.els.errBox.textContent = t("errLbl") + ": " + String(d.note);
  }
  if (ctx.els.phaseRow) {
    ctx.els.phaseRow.classList.add("running");
    ctx.els.phaseRow.classList.remove("done");
  }
  if (ctx.els.phaseText) {
    const label = t("statusRunning") + " · " + phaseLabel(phase) +
      (Number.isFinite(segNo) && Number.isFinite(segsTotal)
        ? " · " + (segNo + 1) + "/" + segsTotal
        : "");
    ctx.els.phaseText.textContent = label + (d.note ? " · " + String(d.note) : "");
  }
  refreshAll(ctx);
}

/* --------------------------------------------------- preflight (体检) */

/**
 * Ask the backend to lint the CURRENT timeline before a long render. The
 * route /dsd/preflight is registered by dsd_nodes/routes.py; strict=false so
 * short prompts are warnings here (the node still renders).
 */
function runPreflight(ctx, btn) {
  const box = ctx.els.pfBox;
  if (btn) {
    btn.disabled = true;
    btn.textContent = t("pfRunning");
  }
  const done = function () {
    if (btn) {
      btn.disabled = false;
      btn.textContent = t("preflightBtn");
    }
  };
  preflightFetch(ctx).then(function (r) {
    if (!r.ok) {
      setNotice(ctx, t("pfFail") + r.error);
      return;
    }
    paintPreflightBox(box, r.lines);
    if (r.errs.length) {
      setNotice(ctx, t("pfHasErr") + " " + r.errs.length + " / " + t("pfHasWarn") + " " + r.warns.length);
    } else {
      setNotice(ctx, t("pfClean"));
    }
  }).then(function () {
    done();
  });
}

/**
 * The one preflight round trip. The 体检 button and the run guard share it, so
 * an [E] line means the same thing on both paths. It never rejects: a dead
 * route comes back as {ok:false, error} and the caller decides what to do.
 */
function preflightFetch(ctx) {
  const node = ctx.node;
  const api = (window.comfyAPI && window.comfyAPI.api && window.comfyAPI.api.api) || null;
  const strict = !!widgetValue(node, "strict", false);
  if (!api || typeof api.fetchApi !== "function") {
    return Promise.resolve({ ok: false, error: t("pfNoApi"), lines: [], errs: [], warns: [] });
  }
  ctx.tl.fps = FPS;
  return Promise.resolve(api.fetchApi("/dsd/preflight", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      timeline: ctx.tl,
      strict: strict,
      min_chars: strict ? 3000 : 1200,
    }),
  })).then(function (res) {
    return res.json();
  }).then(function (data) {
    const lines = String((data && data.text) || "").split("\n");
    return {
      ok: true,
      lines: lines,
      errs: lines.filter(function (l) { return l.indexOf("[E] ") === 0; }),
      warns: lines.filter(function (l) { return l.indexOf("[W] ") === 0; }),
    };
  }).catch(function (err) {
    return { ok: false, error: String((err && err.message) || err), lines: [], errs: [], warns: [] };
  });
}

/** Paint preflight text into a box, one line per issue. */
function paintPreflightBox(box, lines) {
  if (!box) return;
  clearNode(box);
  const list = isArray(lines) ? lines : [];
  box.style.display = list.length ? "block" : "none";
  for (let i = 0; i < list.length; i++) {
    const line = String(list[i]);
    if (!line.trim()) continue;
    let cls = "dsd-pf-line";
    if (line.indexOf("[E] ") === 0) cls += " dsd-pf-err";
    else if (line.indexOf("[W] ") === 0) cls += " dsd-pf-warn";
    box.appendChild(el("div", cls, line));
  }
}

function phaseLabel(phase) {
  const map = {
    start: "phaseStart", segment_start: "phaseSegmentStart",
    sample_step: "phaseSampleStep", segment_done: "phaseSegmentDone",
    sample: "phaseSample", decode: "phaseDecode", pass2: "phasePass2",
    unsharp: "phaseUnsharp", resize: "phaseResize", export: "phaseExport",
    done: "phaseDone",
  };
  return map[phase] ? t(map[phase]) : phase;
}

/* --------------------------------------------------------- run plumbing */

/**
 * Queue the graph through the real ComfyUI entry point. Stage B defect #1 was
 * a button that only changed its own caption; this one asks the app to queue
 * and re-enables itself on failure.
 */
/**
 * Toolbar entry. Preflight runs first: a blocking [E] line turns the run into
 * an explicit confirm instead of silently spending the GPU for minutes. A
 * preflight that cannot reach the server never blocks, but its error is shown
 * inline so it is never swallowed.
 */
function runAll(ctx, btn) {
  if (ctx.guardBusy) return;
  ctx.guardBusy = true;
  if (btn) btn.textContent = t("guardChecking");
  preflightFetch(ctx).then(function (r) {
    ctx.guardBusy = false;
    if (btn) btn.textContent = t("runAll");
    paintPreflightBox(ctx.els.pfBox, r.ok ? r.lines : []);
    if (!r.ok) {
      setNotice(ctx, t("pfFail") + r.error);
      logRun(ctx, "preflight", r.error, -1);
      queueRun(ctx, btn);
      return;
    }
    if (!r.errs.length) {
      queueRun(ctx, btn);
      return;
    }
    showRunGuard(ctx, r.errs, btn);
  });
}

/** Blocking-confirm bar: count, first three blocking lines, wall estimate. */
function showRunGuard(ctx, errs, btn) {
  const bar = ctx.els.guardBar;
  if (!bar) {
    queueRun(ctx, btn);
    return;
  }
  const est = estimateWall(ctx.node, ctx.tl);
  const estTxt = t("guardEst") + " " +
    (est.seconds === null ? t("wallUnknown") : "≈ " + fmtSeconds(est.seconds));
  if (ctx.els.guardHead) {
    ctx.els.guardHead.textContent = t("guardFound") + " " + errs.length + " " + t("guardBlockers");
  }
  if (ctx.els.guardLines) ctx.els.guardLines.textContent = errs.slice(0, 3).join(String.fromCharCode(10));
  if (ctx.els.guardEst) ctx.els.guardEst.textContent = estTxt;
  ctx.guardFn = function () {
    queueRun(ctx, btn);
  };
  bar.classList.add("show");
}

function hideRunGuard(ctx) {
  ctx.guardFn = null;
  if (ctx.els.guardBar) ctx.els.guardBar.classList.remove("show");
}

/** The queue path itself, unchanged apart from the name. */
function queueRun(ctx, btn) {
  const node = ctx.node;
  const appRef = (window.comfyAPI && window.comfyAPI.app && window.comfyAPI.app.app) || null;
  const appObj = appRef || (typeof app !== "undefined" ? app : null);
  if (!appObj || typeof appObj.queuePrompt !== "function") {
    setNotice(ctx, t("noQueue"));
    return;
  }
  ctx.runState = { seg: 0, segs: ctx.tl.shots.length, pct: 0, phase: "sample" };
  ctx.finished = false;
    logRun(ctx, "start", t("statusQueued"), 0);
ctx.runT0 = nowMs();
  ctx.lastSegSeconds = 0;
  if (ctx.els.phaseRow) {
    ctx.els.phaseRow.classList.add("running");
    ctx.els.phaseRow.classList.remove("done");
  }
  if (ctx.els.phaseText) ctx.els.phaseText.textContent = t("statusQueued");
  if (ctx.els.errBox) {
    ctx.els.errBox.style.display = "none";
    ctx.els.errBox.textContent = "";
  }
  refreshAll(ctx);
  const prevText = btn && btn.textContent;
  safe(function () {
    if (btn) {
      btn.disabled = true;
      btn.textContent = t("statusQueued");
    }
  }, "run button busy");
  Promise.resolve()
    .then(function () {
      return appObj.queuePrompt(0);
    })
    .then(function () {
      safe(function () {
        if (btn) {
          btn.disabled = false;
          btn.textContent = prevText;
        }
      }, "run button restore");
    })
    .catch(function (err) {
      setNotice(ctx, t("queueFail") + String(err && err.message ? err.message : err));
      ctx.runState = null;
      refreshAll(ctx);
      safe(function () {
        if (btn) {
          btn.disabled = false;
          btn.textContent = prevText;
        }
      }, "run button restore");
    });
}

/** Subscribe to the backend progress protocol (api event, per node id). */
function bindProgress(node, ctx) {
  if (typeof api.addEventListener !== "function") return;
  const handler = function (event) {
    const detail = event && event.detail;
    if (!detail) return;
    if (String(detail.node) !== String(node.id)) return;
    safe(function () {
      applyProgress(ctx, detail);
    }, "applyProgress");
  };
  api.addEventListener("dsd_progress", handler);

  // The preview stage can replay the last finished clip. ComfyUI emits
  // "executed" per node with a {node, output} detail; only a video entry
  // counts as a finished clip, and the node id is not required to match
  // because the VHS save node is a different node than the director.
  const execHandler = function (event) {
    const detail = event && event.detail;
    if (!detail) return;
    safe(function () {
      const found = pickRenderFile(detail);
      if (!found) return;
      const url = renderFileURL(found.item);
      if (!url) return;
      rememberRender(ctx, url, found.name);
    }, "executed handler");
  };
  api.addEventListener("executed", execHandler);

  const prevRemoved = node.onRemoved;
  node.onRemoved = function () {
    safe(function () {
      api.removeEventListener("dsd_progress", handler);
      api.removeEventListener("executed", execHandler);
      // Thumbnail loads call back into this ctx; drop it so a deleted node
      // cannot keep repainting (or keep the panel alive) after removal.
      LIVE_CTX.delete(ctx);
    }, "remove progress listener");
    return prevRemoved ? prevRemoved.apply(this, arguments) : undefined;
  };
}

/* -------------------------------------------------------------- assemble */

function collectMissing(node) {
  const missing = [];
  for (let i = 0; i < CONTRACT_WIDGETS.length; i++) {
    if (!findWidget(node, CONTRACT_WIDGETS[i])) missing.push(CONTRACT_WIDGETS[i]);
  }
  return missing;
}

/** Tear the current panel down and rebuild it (used by the language switch). */
function rebuildPanel(node) {
  const old = PANELS.get(node);
  const host = old && old.ctx ? old.ctx.host : node.dsdPanelHost;
  if (!host) return null;
  if (old && old.ctx && old.ctx.timer) clearInterval(old.ctx.timer);
  if (old && old.ctx) {
    node.dsdKeep = {
      history: isArray(old.ctx.history) ? old.ctx.history : [],
      future: isArray(old.ctx.future) ? old.ctx.future : [],
      runLog: isArray(old.ctx.runLog) ? old.ctx.runLog : [],
      // Run progress outlives a panel rebuild too: a language switch in
      // the middle of (or right after) a render must not blank the bars.
      runState: old.ctx.runState || null,
      finished: !!old.ctx.finished,
      lastRunWall: Number(old.ctx.lastRunWall) || 0,
      lastSegSeconds: Number(old.ctx.lastSegSeconds) || 0,
    };
  }
  clearNode(host);
  const api = buildPanel(node, host);
  safe(function () {
    const dw = findWidget(node, PANEL_WIDGET_ID);
    // domWidget.element IS host when ComfyUI accepts the div we handed it, so
    // re-appending it would ask the DOM to move a node inside itself
    // (HierarchyRequestError) and leave the panel empty. Only re-home when the
    // widget really wraps our host in an outer container.
    if (dw && dw.element && dw.element !== host && dw.element.firstChild !== host) {
      clearNode(dw.element);
      dw.element.appendChild(host);
    }
  }, "rehost panel");
  return api;
}

function buildPanel(node, host) {
  const ctx = makeCtx(node, host);
  const root = el("div", "dsd-panel");

  root.appendChild(sectionToolbar(ctx));
  root.appendChild(sectionStage(ctx));
  root.appendChild(sectionTransport(ctx));
  root.appendChild(sectionTimeline(ctx));
  root.appendChild(sectionSummary(ctx));
  root.appendChild(sectionOutput(ctx));
  root.appendChild(sectionShot(ctx));
  root.appendChild(sectionPreset(ctx));
  root.appendChild(sectionStatus(ctx));

  const missing = collectMissing(node);
  if (missing.length) {
    ctx.els.banner.textContent = t("bannerA") + missing.join(", ") + t("bannerB");
    ctx.els.banner.style.display = "block";
  }

  host.appendChild(root);
  node.dsdPanelHost = host;

  // Thumbnails load asynchronously: they call back into this ctx, not into
  // whichever panel happened to paint last.
  ctx.repaint = function () {
    safe(function () {
      refreshAll(ctx);
    }, "thumbnail repaint");
  };
  LIVE_CTX.add(ctx);
  restoreRender(ctx);

  bindProgress(node, ctx);
  installKeys(node, ctx);

  const api = {
    ctx: ctx,
    root: root,
    refresh: function () {
      safe(function () {
        reloadFromWidgets(ctx);
        refreshAll(ctx);
      }, "panel refresh");
    },
    relayout: function () {
      refreshAll(ctx);
    },
    progress: function (detail) {
      applyProgress(ctx, detail);
    },
    addShot: function () {
      return addShot(ctx);
    },
    setLang: function (lang) {
      return setLang(lang, node);
    },
  };
  api.refresh();
  node.dsdPanelApi = api;
  node.dsdPanelRoot = root;
  return api;
}

/* ------------------------------------------------------------ extension */

const PANELS = new WeakMap();

function hideWidgetSafe(node, name) {
  const w = findWidget(node, name);
  if (!w) return "missing";
  const used = [];
  if (safe(function () { w.hidden = true; return true; }, "hide " + name + " hidden")) used.push("hidden");
  if (safe(function () { if (!w.options) w.options = {}; w.options.hidden = true; return true; },
    "hide " + name + " options.hidden")) used.push("options.hidden");
  if (safe(function () { w.computeSize = function () { return [0, -4]; }; return true; },
    "hide " + name + " computeSize")) used.push("computeSize");
  safe(function () { if (w.element && w.element.style) w.element.style.display = "none"; },
    "hide " + name + " element");
  return used.length ? used.join("+") : "none";
}

function initPanel(node) {
  if (PANELS.has(node)) return;
  const host = document.createElement("div");
  host.style.cssText = "width:100%;height:100%;box-sizing:border-box;overflow:hidden;";

  if (!document.getElementById("dsd-director-panel-css")) {
    const style = document.createElement("style");
    style.id = "dsd-director-panel-css";
    style.textContent = CSS;
    document.head.appendChild(style);
  }

  safe(function () {
    adoptGroupWidgets(node);
  }, "adopt BDGROUP headers");

  const panel = safe(function () {
    return buildPanel(node, host);
  }, "buildPanel");

  const domWidget = node.addDOMWidget(PANEL_WIDGET_ID, "director", host, {
    hideOnZoom: false,
    serialize: false,
    getMinHeight: function () {
      return PANEL_MIN_HEIGHT;
    },
    getValue: function () {
      return "";
    },
    setValue: function () {},
  });
  safe(function () {
    domWidget.serialize = false;
  }, "domWidget.serialize");

  if (panel) PANELS.set(node, panel);

  safe(function () {
    for (let i = 0; i < HIDDEN_WIDGETS.length; i++) {
      hideWidgetSafe(node, HIDDEN_WIDGETS[i]);
    }
  }, "hide internal widgets");

  safe(function () {
    const prev = node.onWidgetChanged;
    node.onWidgetChanged = function (name) {
      const out = prev ? prev.apply(this, arguments) : undefined;
      const self = this;
      safe(function () {
        const p = PANELS.get(self);
        if (!p) return;
        const watched = [
          "timeline_data", "total_frames", "window_frames", "context_frames",
          "gen_w", "gen_h", "final_w", "final_h", "out_w", "out_h",
          "upscale", "unsharp", "pass2", "preset", "ffn_chunks", "inline_prompt",
        ];
        if (watched.indexOf(name) >= 0) p.refresh();
      }, "onWidgetChanged refresh");
      return out;
    };
  }, "onWidgetChanged hook");

  safe(function () {
    const prevDown = node.onMouseDown;
    node.onMouseDown = function (ev, pos) {
      let consumed = false;
      safe(function () {
        consumed = hitTestGroupHeaders(this, pos);
      }.bind(this), "onMouseDown hit test");
      if (consumed) return true;
      return prevDown ? prevDown.apply(this, arguments) : false;
    };
  }, "onMouseDown hook");

  safe(function () {
    setTimeout(function () {
      safe(function () {
        if (panel) panel.refresh();
      }, "deferred refresh");
    }, 0);
  }, "deferred refresh schedule");

  safe(function () {
    const ro = new ResizeObserver(function () {
      if (panel) panel.relayout();
    });
    ro.observe(host);
  }, "ResizeObserver");

  const prevResize = node.onResize;
  node.onResize = function () {
    const out = prevResize ? prevResize.apply(this, arguments) : undefined;
    safe(function () {
      const p = PANELS.get(this);
      if (p) p.relayout();
    }.bind(this), "onResize relayout");
    return out;
  };
}

app.registerExtension({
  name: "DSD.DirectorPanel",

  async getCustomWidgets() {
    return {
      BDGROUP(node, inputName, inputData) {
        const widget = makeGroupHeaderWidget(node, inputName, inputData);
        if (!node.widgets) node.widgets = [];
        node.widgets.push(widget);
        return widget;
      },
    };
  },

  async beforeRegisterNodeDef(nodeType, nodeData) {
    try {
      if (!nodeData || nodeData.name !== NODE_NAME) return;
      const onNodeCreated = nodeType.prototype.onNodeCreated;
      nodeType.prototype.onNodeCreated = function () {
        const r = onNodeCreated ? onNodeCreated.apply(this, arguments) : undefined;
        const node = this;
        safe(function () {
          initPanel(node);
        }, "onNodeCreated initPanel");
        return r;
      };
      const onConfigure = nodeType.prototype.onConfigure;
      nodeType.prototype.onConfigure = function () {
        const r = onConfigure ? onConfigure.apply(this, arguments) : undefined;
        safe(function () {
          const p = PANELS.get(this);
          if (p) p.refresh();
        }, "onConfigure refresh");
        return r;
      };
    } catch (err) {
      console.warn("[DSD.DirectorPanel] beforeRegisterNodeDef failed:", err);
    }
  },
});

