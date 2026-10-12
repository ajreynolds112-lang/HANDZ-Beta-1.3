import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription,
} from "@/components/ui/alert-dialog";
import {
  ArrowLeft, ArrowDown, ArrowUp, Bold, Check, Copy, Download, Eye, EyeOff, FlipHorizontal, FlipVertical, Italic,
  Pencil, Plus, Redo2, Save, Trash2, Type, Undo2, Upload, BoxSelect, ChevronDown,
} from "lucide-react";
import type { CustomDecal, CustomDecalFont, CustomDecalLayer, Fighter } from "@shared/schema";
import * as localSaves from "@/lib/localSaves";
import FighterStanceCanvas, { playerBoxingStance } from "@/components/FighterStanceCanvas";
import type { FighterColors } from "@/game/types";
import { cssColorOf } from "@/game/spacialColor";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  BUILTIN_DECAL_FONTS, CUSTOM_DECAL_DIAMOND_COST, DECAL_H, DECAL_SHAPES, DECAL_W, MAX_CUSTOM_DECALS, MAX_DECAL_FONTS,
  MAX_DECAL_FONT_BYTES, bumpDecalDraft, customDecalColor, drawDecal, layerMatrix, measureText, newDecalId,
  parseDecalFile, registerDecalFonts, loadStyledDecalFonts, drawLayer, registerDecalLibrary, setDecalDraft, type DecalFile,
} from "@/game/customDecals";
import { PREMADE_DECALS, PREMADE_DECAL_COST } from "@/game/premadeDecals";
import { filterProfanity } from "@/game/profanity";

/** Margin around the design area on the editing canvas, in design px. */
const PAD = 48;
const VIEW_W = DECAL_W + PAD * 2, VIEW_H = DECAL_H + PAD * 2;
const NAME_MAX = 32;
const HISTORY_MAX = 100;

type Pt = { x: number; y: number };
type Frame = { cx: number; cy: number; hw: number; hh: number; rot: number };
type Drag =
  | { kind: "move"; start: Pt; orig: CustomDecalLayer[] }
  | { kind: "scale"; anchor: Pt; frame: Frame; corner: Pt; orig: CustomDecalLayer[]; uniform: boolean }
  | { kind: "rotate"; center: Pt; startAng: number; orig: CustomDecalLayer[] }
  | { kind: "marquee"; start: Pt; now: Pt; additive: boolean; base: string[] };

const decalsOf = (f: Fighter | undefined): CustomDecal[] => ((f?.customDecals as CustomDecal[] | null) ?? []).filter(d => d?.id);
const fontsOf = (f: Fighter | undefined): CustomDecalFont[] => ((f?.decalFonts as CustomDecalFont[] | null) ?? []).filter(x => x?.id);
const rad = (d: number) => (d * Math.PI) / 180;

function layerCorners(l: CustomDecalLayer): Pt[] {
  const m = layerMatrix(l);
  return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => {
    const p = m.transformPoint(new DOMPoint((sx * l.w) / 2, (sy * l.h) / 2));
    return { x: p.x, y: p.y };
  });
}

function hitLayer(l: CustomDecalLayer, p: Pt, slop: number): boolean {
  if (l.hidden) return false;
  const q = layerMatrix(l).inverse().transformPoint(new DOMPoint(p.x, p.y));
  return Math.abs(q.x) <= l.w / 2 + slop && Math.abs(q.y) <= l.h / 2 + slop;
}

/** Oriented frame of the selection: the layer's own box for one, an upright bounding box for several. */
function selectionFrame(layers: CustomDecalLayer[]): Frame | null {
  if (!layers.length) return null;
  if (layers.length === 1) {
    const l = layers[0];
    return { cx: l.x, cy: l.y, hw: l.w / 2, hh: l.h / 2, rot: l.rotation || 0 };
  }
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const l of layers) for (const c of layerCorners(l)) { x0 = Math.min(x0, c.x); y0 = Math.min(y0, c.y); x1 = Math.max(x1, c.x); y1 = Math.max(y1, c.y); }
  return { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, hw: (x1 - x0) / 2, hh: (y1 - y0) / 2, rot: 0 };
}

function framePoint(f: Frame, lx: number, ly: number): Pt {
  const c = Math.cos(rad(f.rot)), s = Math.sin(rad(f.rot));
  return { x: f.cx + lx * c - ly * s, y: f.cy + lx * s + ly * c };
}
function toFrameLocal(f: Frame, p: Pt, origin: Pt): Pt {
  const c = Math.cos(rad(-f.rot)), s = Math.sin(rad(-f.rot));
  const dx = p.x - origin.x, dy = p.y - origin.y;
  return { x: dx * c - dy * s, y: dx * s + dy * c };
}

/** Font dropdown: every name is drawn in its own font so it can be judged before picking. */
function FontPicker({ value, label, uploads, onPick }: { value?: string; label: string; uploads: CustomDecalFont[]; onPick: (font: string) => void }) {
  const [open, setOpen] = useState(false);
  const family = (f?: string) => (f?.startsWith("upload:") ? `hzdecal_${f.slice(7)}` : f || "Arial");
  const item = (font: string, name: string) => (
    <button key={font} type="button" onClick={() => { onPick(font); setOpen(false); }}
      className={`w-full flex items-center gap-2 px-2 py-1.5 rounded text-left hover:bg-white/10 ${value === font ? "bg-white/10" : ""}`}
      data-testid={`option-decal-font-${name.replace(/\s+/g, "-").toLowerCase()}`}>
      <span className="flex-1 truncate text-lg leading-tight text-white" style={{ fontFamily: `"${family(font)}"` }}>{name}</span>
      {value === font && <Check className="w-3.5 h-3.5 text-yellow-400 shrink-0" />}
    </button>
  );
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" className="flex-1 min-w-0 h-8 flex items-center gap-1 text-sm bg-black/60 border border-white/20 rounded px-2 text-white" data-testid="select-decal-font">
          <span className="flex-1 truncate text-left" style={{ fontFamily: `"${family(value)}"` }}>{label}</span>
          <ChevronDown className="w-3.5 h-3.5 shrink-0 opacity-60" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="z-[60] w-64 p-1 max-h-80 overflow-y-auto bg-zinc-900 border-white/20">
        {BUILTIN_DECAL_FONTS.map(f => item(f, f))}
        {uploads.map(f => item(`upload:${f.id}`, f.name))}
        {value?.startsWith("upload:") && !uploads.some(f => `upload:${f.id}` === value) && item(value, label)}
      </PopoverContent>
    </Popover>
  );
}

function freshLayer(kind: "shape" | "text", shape = "rect"): CustomDecalLayer {
  const base: CustomDecalLayer = {
    id: newDecalId("l"), kind, x: DECAL_W / 2, y: DECAL_H / 2, w: 140, h: 140, rotation: 0, skewX: 0, skewY: 0,
    color: kind === "text" ? "#ffffff" : "#d4202a", opacity: 1, strokeColor: "#000000", strokeWidth: 0,
  };
  if (kind === "shape") {
    base.shape = shape;
    if (shape === "line") { base.w = 260; base.h = 10; }
    else if (shape === "rect" || shape === "roundRect" || shape === "parallelogram") base.w = 220;
    return base;
  }
  base.text = "TEXT"; base.font = "Arial Black"; base.fontSize = 80; base.arc = 0;
  const m = measureText(base);
  base.w = m.w; base.h = m.h;
  return base;
}

function starterDecal(name: string): CustomDecal {
  const t = freshLayer("text");
  t.text = "HANDZ"; t.color = "#111111";
  const m = measureText(t);
  t.w = m.w; t.h = m.h;
  return { id: newDecalId(), name, background: "#ffffff", layers: [t], updatedAt: Date.now() };
}

function thumbnailOf(d: CustomDecal): string {
  const c = document.createElement("canvas");
  c.width = DECAL_W; c.height = DECAL_H;
  const ctx = c.getContext("2d");
  if (!ctx) return "";
  drawDecal(ctx, d);
  return c.toDataURL("image/png");
}

export default function DecalEditor({ fighterId, baseColors, wornId, onUse, onClose, onPersist }: {
  fighterId: string;
  /** The editor's current gear colours, for the 3D preview. */
  baseColors: FighterColors;
  /** The decal currently worn, if any. */
  wornId: string | null;
  /** Wear a decal (null = it was deleted and should come off). */
  onUse: (id: string | null) => void;
  onClose: () => void;
  /** Write fields to the fighter record; returns the saved record (undefined on failure). */
  onPersist: (patch: Partial<Fighter>) => Fighter | undefined;
}) {
  const fresh = () => localSaves.getFighter(fighterId);
  const [library, setLibrary] = useState<CustomDecal[]>(() => decalsOf(fresh()));
  const [fonts, setFonts] = useState<CustomDecalFont[]>(() => fontsOf(fresh()));
  const [diamonds, setDiamonds] = useState<number>(() => fresh()?.diamonds ?? 0);
  const [draft, setDraft] = useState<CustomDecal | null>(() => {
    const lib = decalsOf(fresh());
    return lib.find(d => d.id === wornId) ?? lib[0] ?? null;
  });
  const [dirty, setDirty] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState("");
  const [confirm, setConfirm] = useState<null | { title: string; detail?: string; action: string; danger?: boolean; run: () => void }>(null);
  const [error, setError] = useState<string | null>(null);
  const [fontTick, forceDraw] = useState(0);

  const history = useRef<{ past: CustomDecal[]; future: CustomDecal[] }>({ past: [], future: [] });
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drag = useRef<Drag | null>(null);
  /** Undo snapshot for a drag, recorded only once the drag actually changes something. */
  const pendingSnap = useRef<CustomDecal | null>(null);
  /** Centre lines the current move has snapped to. */
  const snapGuides = useRef({ x: false, y: false });
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const selRef = useRef(selected);
  selRef.current = selected;
  const uploadRef = useRef<HTMLInputElement>(null);
  const fontUploadRef = useRef<HTMLInputElement>(null);

  useEffect(() => { registerDecalFonts(fonts); registerDecalLibrary(library, fonts); }, [fonts, library]);
  // Fonts load async; redraw once they're in.
  useEffect(() => {
    const onLoad = () => forceDraw(n => n + 1);
    loadStyledDecalFonts();
    document.fonts?.addEventListener?.("loadingdone", onLoad);
    return () => document.fonts?.removeEventListener?.("loadingdone", onLoad);
  }, []);

  // The 3D preview wears the working copy; it must never outlive the editor.
  useEffect(() => {
    if (!draft) return;
    setDecalDraft(draft.id, draft);
    bumpDecalDraft();
    return () => { setDecalDraft(draft.id, null); bumpDecalDraft(); };
  }, [draft]);

  const persist = (patch: Partial<Fighter>): Fighter | undefined => {
    try {
      const saved = onPersist(patch);
      if (!saved) { setError("Save failed"); return undefined; }
      setLibrary(decalsOf(saved)); setFonts(fontsOf(saved)); setDiamonds(saved.diamonds ?? 0);
      setError(null);
      return saved;
    } catch (e) {
      console.warn("[decal] save failed", e);
      setError("Not enough save space");
      return undefined;
    }
  };

  // ───────── history ─────────
  /** Apply an edit to the draft, recording an undo step (skip for mid-drag frames). */
  const edit = useCallback((fn: (d: CustomDecal) => CustomDecal, record = true) => {
    const cur = draftRef.current;
    if (!cur) return;
    if (record) {
      history.current.past.push(cur);
      if (history.current.past.length > HISTORY_MAX) history.current.past.shift();
      history.current.future = [];
    }
    const next = { ...fn(cur), updatedAt: Date.now() };
    draftRef.current = next;
    setDraft(next);
    setDirty(true);
  }, []);
  const pushHistory = (snap: CustomDecal) => {
    history.current.past.push(snap);
    if (history.current.past.length > HISTORY_MAX) history.current.past.shift();
    history.current.future = [];
  };
  const undo = useCallback(() => {
    const h = history.current, cur = draftRef.current;
    const prev = h.past.pop();
    if (!prev || !cur) return;
    h.future.push(cur);
    setDraft({ ...prev, updatedAt: Date.now() }); setDirty(true);
    setSelected(s => s.filter(id => prev.layers.some(l => l.id === id)));
  }, []);
  const redo = useCallback(() => {
    const h = history.current, cur = draftRef.current;
    const next = h.future.pop();
    if (!next || !cur) return;
    h.past.push(cur);
    setDraft({ ...next, updatedAt: Date.now() }); setDirty(true);
    setSelected(s => s.filter(id => next.layers.some(l => l.id === id)));
  }, []);

  const openDecal = (d: CustomDecal | null) => {
    history.current = { past: [], future: [] };
    setDraft(d); setDirty(false); setSelected([]);
  };
  const guardUnsaved = (then: () => void) => {
    if (!dirty) { then(); return; }
    setConfirm({ title: "Discard unsaved changes?", action: "Discard", danger: true, run: then });
  };

  // ───────── layer edits ─────────
  const patchLayers = (ids: string[], fn: (l: CustomDecalLayer) => CustomDecalLayer, record = true) =>
    edit(d => ({ ...d, layers: d.layers.map(l => (ids.includes(l.id) ? fn(l) : l)) }), record);
  const addLayer = (l: CustomDecalLayer) => { edit(d => ({ ...d, layers: [...d.layers, l] })); setSelected([l.id]); };
  const deleteSelected = useCallback(() => {
    const ids = selRef.current;
    if (!ids.length) return;
    edit(d => ({ ...d, layers: d.layers.filter(l => !ids.includes(l.id)) }));
    setSelected([]);
  }, [edit]);
  const duplicateSelected = useCallback(() => {
    const ids = selRef.current;
    const cur = draftRef.current;
    if (!ids.length || !cur) return;
    const copies = cur.layers.filter(l => ids.includes(l.id)).map(l => ({ ...l, id: newDecalId("l"), x: l.x + 16, y: l.y + 16 }));
    edit(d => ({ ...d, layers: [...d.layers, ...copies] }));
    setSelected(copies.map(c => c.id));
  }, [edit]);
  const moveLayer = (id: string, dir: 1 | -1) => edit(d => {
    const i = d.layers.findIndex(l => l.id === id), j = i + dir;
    if (i < 0 || j < 0 || j >= d.layers.length) return d;
    const layers = [...d.layers];
    [layers[i], layers[j]] = [layers[j], layers[i]];
    return { ...d, layers };
  });
  const selectAll = useCallback(() => setSelected(draftRef.current?.layers.filter(l => !l.hidden).map(l => l.id) ?? []), []);

  // ───────── keyboard ─────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      let handled = true;
      if (mod && k === "z" && !e.shiftKey) undo();
      else if (mod && (k === "y" || (k === "z" && e.shiftKey))) redo();
      else if (mod && k === "a") selectAll();
      else if (mod && k === "d") duplicateSelected();
      else if (k === "delete" || k === "backspace") deleteSelected();
      else if (k === "escape") setSelected([]);
      else if (k.startsWith("arrow") && selRef.current.length) {
        const step = e.shiftKey ? 10 : 1;
        const dx = k === "arrowleft" ? -step : k === "arrowright" ? step : 0;
        const dy = k === "arrowup" ? -step : k === "arrowdown" ? step : 0;
        patchLayers(selRef.current, l => ({ ...l, x: l.x + dx, y: l.y + dy }));
      } else handled = false;
      if (handled) { e.preventDefault(); e.stopPropagation(); }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  // ───────── drawing ─────────
  const cssScale = () => {
    const c = canvasRef.current;
    return c ? VIEW_W / Math.max(1, c.getBoundingClientRect().width) : 1;
  };
  useEffect(() => {
    const c = canvasRef.current;
    const ctx = c?.getContext("2d");
    if (!c || !ctx) return;
    const k = c.width / VIEW_W;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.fillStyle = "#151515";
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.setTransform(k, 0, 0, k, k * PAD, k * PAD);
    // Checkerboard = transparent.
    for (let y = 0; y < DECAL_H; y += 16) for (let x = 0; x < DECAL_W; x += 16) {
      ctx.fillStyle = ((x + y) / 16) % 2 ? "#3a3a3a" : "#2a2a2a";
      ctx.fillRect(x, y, 16, 16);
    }
    if (draft) {
      // Content past the patch edge stays visible (faded) so it can be grabbed.
      ctx.save();
      ctx.beginPath();
      ctx.rect(-PAD, -PAD, VIEW_W, VIEW_H);
      ctx.rect(0, 0, DECAL_W, DECAL_H);
      ctx.clip("evenodd");
      ctx.globalAlpha = 0.3;
      for (const l of draft.layers) drawLayer(ctx, l);
      ctx.restore();
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, DECAL_W, DECAL_H);
      ctx.clip();
      if (draft.background) { ctx.fillStyle = draft.background; ctx.fillRect(0, 0, DECAL_W, DECAL_H); }
      for (const l of draft.layers) drawLayer(ctx, l);
      ctx.restore();
    }
    ctx.strokeStyle = "rgba(255,255,255,0.35)";
    ctx.lineWidth = 1 / k;
    ctx.strokeRect(0, 0, DECAL_W, DECAL_H);

    // Selection.
    if (draft) {
      const sel = draft.layers.filter(l => selected.includes(l.id));
      const s = cssScale();
      ctx.lineWidth = 1.5 * s;
      ctx.strokeStyle = "rgba(250,204,21,0.5)";
      if (sel.length > 1) for (const l of sel) { const cs = layerCorners(l); ctx.beginPath(); cs.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y))); ctx.closePath(); ctx.stroke(); }
      const f = selectionFrame(sel);
      if (f) {
        const cs = [framePoint(f, -f.hw, -f.hh), framePoint(f, f.hw, -f.hh), framePoint(f, f.hw, f.hh), framePoint(f, -f.hw, f.hh)];
        ctx.strokeStyle = "#facc15";
        ctx.beginPath(); cs.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y))); ctx.closePath(); ctx.stroke();
        const top = framePoint(f, 0, -f.hh), rot = framePoint(f, 0, -f.hh - 26 * s);
        ctx.beginPath(); ctx.moveTo(top.x, top.y); ctx.lineTo(rot.x, rot.y); ctx.stroke();
        const hs = 5 * s;
        ctx.fillStyle = "#facc15";
        for (const p of cs) ctx.fillRect(p.x - hs, p.y - hs, hs * 2, hs * 2);
        ctx.beginPath(); ctx.arc(rot.x, rot.y, hs * 1.2, 0, Math.PI * 2); ctx.fill();
      }
      const g = snapGuides.current;
      if (g.x || g.y) {
        ctx.strokeStyle = "#ff3bd4";
        ctx.lineWidth = 1 * s;
        ctx.beginPath();
        if (g.x) { ctx.moveTo(DECAL_W / 2, 0); ctx.lineTo(DECAL_W / 2, DECAL_H); }
        if (g.y) { ctx.moveTo(0, DECAL_H / 2); ctx.lineTo(DECAL_W, DECAL_H / 2); }
        ctx.stroke();
      }
      const d = drag.current;
      if (d?.kind === "marquee") {
        ctx.setLineDash([4 * s, 3 * s]);
        ctx.strokeStyle = "#ffffff";
        ctx.fillStyle = "rgba(255,255,255,0.08)";
        const x = Math.min(d.start.x, d.now.x), y = Math.min(d.start.y, d.now.y);
        ctx.fillRect(x, y, Math.abs(d.now.x - d.start.x), Math.abs(d.now.y - d.start.y));
        ctx.strokeRect(x, y, Math.abs(d.now.x - d.start.x), Math.abs(d.now.y - d.start.y));
        ctx.setLineDash([]);
      }
    }
  });

  // ───────── pointer ─────────
  const toDesign = (e: React.PointerEvent): Pt => {
    const r = canvasRef.current!.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * VIEW_W - PAD, y: ((e.clientY - r.top) / r.height) * VIEW_H - PAD };
  };
  const onPointerDown = (e: React.PointerEvent) => {
    if (!draft) return;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    const p = toDesign(e), s = cssScale();
    const sel = draft.layers.filter(l => selected.includes(l.id));
    const f = selectionFrame(sel);
    const near = (q: Pt, r: number) => Math.hypot(q.x - p.x, q.y - p.y) <= r;
    if (f) {
      const rot = framePoint(f, 0, -f.hh - 26 * s);
      if (near(rot, 10 * s)) {
        drag.current = { kind: "rotate", center: { x: f.cx, y: f.cy }, startAng: Math.atan2(p.y - f.cy, p.x - f.cx), orig: sel };
        pendingSnap.current = draft;
        return;
      }
      for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        const corner = framePoint(f, sx * f.hw, sy * f.hh);
        if (near(corner, 9 * s)) {
          drag.current = { kind: "scale", anchor: framePoint(f, -sx * f.hw, -sy * f.hh), frame: f, corner, orig: sel, uniform: sel.length > 1 };
          pendingSnap.current = draft;
          return;
        }
      }
    }
    const hit = [...draft.layers].reverse().find(l => hitLayer(l, p, 2 * s));
    if (hit) {
      let ids = selected;
      if (e.shiftKey || e.ctrlKey || e.metaKey) {
        ids = selected.includes(hit.id) ? selected.filter(i => i !== hit.id) : [...selected, hit.id];
        setSelected(ids);
        if (!ids.includes(hit.id)) return;
      } else if (!selected.includes(hit.id)) {
        ids = [hit.id];
        setSelected(ids);
      }
      drag.current = { kind: "move", start: p, orig: draft.layers.filter(l => ids.includes(l.id)) };
      pendingSnap.current = draft;
      return;
    }
    const additive = e.shiftKey || e.ctrlKey || e.metaKey;
    drag.current = { kind: "marquee", start: p, now: p, additive, base: additive ? selected : [] };
    if (!additive) setSelected([]);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || !draft) return;
    const p = toDesign(e);
    if (d.kind === "marquee") {
      d.now = p;
      const x0 = Math.min(d.start.x, p.x), x1 = Math.max(d.start.x, p.x), y0 = Math.min(d.start.y, p.y), y1 = Math.max(d.start.y, p.y);
      const inside = draft.layers.filter(l => !l.hidden && layerCorners(l).some(c => c.x >= x0 && c.x <= x1 && c.y >= y0 && c.y <= y1)
        || (!l.hidden && l.x >= x0 && l.x <= x1 && l.y >= y0 && l.y <= y1)).map(l => l.id);
      setSelected(Array.from(new Set([...d.base, ...inside])));
      forceDraw(n => n + 1);
      return;
    }
    if (pendingSnap.current) { pushHistory(pendingSnap.current); pendingSnap.current = null; }
    const byId = new Map(d.orig.map(l => [l.id, l]));
    const apply = (fn: (o: CustomDecalLayer) => CustomDecalLayer) =>
      edit(dd => ({ ...dd, layers: dd.layers.map(l => { const o = byId.get(l.id); return o ? fn(o) : l; }) }), false);
    if (d.kind === "move") {
      let dx = p.x - d.start.x, dy = p.y - d.start.y;
      // Snap the selection's centre to the page centre lines (hold Alt to place freely).
      const f = selectionFrame(d.orig), tol = 8 * cssScale();
      const snapX = !!f && !e.altKey && Math.abs(f.cx + dx - DECAL_W / 2) <= tol;
      const snapY = !!f && !e.altKey && Math.abs(f.cy + dy - DECAL_H / 2) <= tol;
      if (f && snapX) dx = DECAL_W / 2 - f.cx;
      if (f && snapY) dy = DECAL_H / 2 - f.cy;
      snapGuides.current = { x: snapX, y: snapY };
      apply(o => ({ ...o, x: o.x + dx, y: o.y + dy }));
    } else if (d.kind === "rotate") {
      let delta = ((Math.atan2(p.y - d.center.y, p.x - d.center.x) - d.startAng) * 180) / Math.PI;
      if (e.shiftKey) delta = Math.round(delta / 15) * 15;
      const c = Math.cos(rad(delta)), s = Math.sin(rad(delta));
      apply(o => {
        const dx = o.x - d.center.x, dy = o.y - d.center.y;
        return { ...o, x: d.center.x + dx * c - dy * s, y: d.center.y + dx * s + dy * c, rotation: ((o.rotation + delta) % 360 + 360) % 360 };
      });
    } else {
      const f = d.frame;
      const orig = toFrameLocal(f, d.corner, d.anchor), now = toFrameLocal(f, p, d.anchor);
      let sx = Math.abs(orig.x) > 0.01 ? now.x / orig.x : 1, sy = Math.abs(orig.y) > 0.01 ? now.y / orig.y : 1;
      if (d.uniform || e.shiftKey) { const u = Math.max(Math.abs(sx), Math.abs(sy)); sx = u; sy = u; }
      sx = Math.max(0.02, sx); sy = Math.max(0.02, sy);
      const cr = Math.cos(rad(f.rot)), sr = Math.sin(rad(f.rot));
      apply(o => {
        const l = toFrameLocal(f, { x: o.x, y: o.y }, d.anchor);
        const lx = l.x * sx, ly = l.y * sy;
        return {
          ...o,
          x: d.anchor.x + lx * cr - ly * sr, y: d.anchor.y + lx * sr + ly * cr,
          w: Math.max(2, o.w * sx), h: Math.max(2, o.h * sy),
        };
      });
    }
  };
  const onPointerUp = () => {
    pendingSnap.current = null;
    if (snapGuides.current.x || snapGuides.current.y) { snapGuides.current = { x: false, y: false }; forceDraw(n => n + 1); }
    const d = drag.current;
    drag.current = null;
    if (d?.kind === "marquee") forceDraw(n => n + 1);
  };

  // ───────── library ─────────
  const canAfford = diamonds >= CUSTOM_DECAL_DIAMOND_COST;
  const draftPaid = !!(draft && library.find(x => x.id === draft.id)?.purchased);
  const roomLeft = library.length < MAX_CUSTOM_DECALS;
  /** Store a new library entry (free; paid for the first time it's worn). */
  const createDecal = (d: CustomDecal, extraFonts: CustomDecalFont[] = []) => {
    const f = fresh();
    if (!f) return;
    const lib = decalsOf(f), have = fontsOf(f);
    if (lib.length >= MAX_CUSTOM_DECALS) { setLibrary(lib); return; }
    const addFonts = extraFonts.filter(x => !have.some(h => h.id === x.id));
    const saved = persist({
      customDecals: [...lib, { ...d, purchased: false }],
      decalFonts: [...have, ...addFonts].slice(0, Math.max(MAX_DECAL_FONTS, have.length)),
    });
    if (saved) openDecal({ ...d, purchased: false });
  };
  /** Wear the open decal; the first time, it costs diamonds (priced off the save). */
  const wearDecal = () => {
    if (!draft) return;
    if (decalsOf(fresh()).find(x => x.id === draft.id)?.purchased) { onUse(draft.id); return; }
    setConfirm({
      title: "Buy Custom Decal?", detail: `${draft.name} · 💎${CUSTOM_DECAL_DIAMOND_COST}`, action: `Buy 💎${CUSTOM_DECAL_DIAMOND_COST}`,
      run: () => {
        const f = fresh();
        if (!f) return;
        const lib = decalsOf(f), bal = f.diamonds ?? 0;
        if (!lib.some(x => x.id === draft.id)) return;
        if (bal < CUSTOM_DECAL_DIAMOND_COST) { setDiamonds(bal); setError("Not enough diamonds"); return; }
        const saved = persist({
          customDecals: lib.map(x => (x.id === draft.id ? { ...x, purchased: true } : x)),
          diamonds: bal - CUSTOM_DECAL_DIAMOND_COST,
        });
        if (!saved) return;
        setDraft(d => (d && d.id === draft.id ? { ...d, purchased: true } : d));
        onUse(draft.id);
      },
    });
  };
  const saveDraft = () => {
    if (!draft) return;
    const lib = decalsOf(fresh());
    const d = { ...draft, updatedAt: Date.now() };
    if (persist({ customDecals: lib.some(x => x.id === d.id) ? lib.map(x => (x.id === d.id ? { ...d, purchased: !!(x.purchased || d.purchased) } : x)) : lib })) {
      setDraft(d); setDirty(false);
    }
  };
  const renameDecal = (id: string, name: string) => {
    const n = name.trim().slice(0, NAME_MAX);
    setRenaming(null);
    if (!n) return;
    const lib = decalsOf(fresh());
    persist({ customDecals: lib.map(x => (x.id === id ? { ...x, name: n } : x)) });
    if (draft?.id === id) setDraft({ ...draft, name: n });
  };
  const deleteDecal = (id: string) => {
    const lib = decalsOf(fresh());
    if (!persist({ customDecals: lib.filter(x => x.id !== id) })) return;
    if (wornId === id) onUse(null);
    if (draft?.id === id) openDecal(lib.find(x => x.id !== id) ?? null);
  };
  const downloadDecal = (d: CustomDecal) => {
    const used = new Set(d.layers.map(l => l.font).filter((x): x is string => !!x && x.startsWith("upload:")).map(x => x.slice(7)));
    const file: DecalFile = { type: "handz-decal", version: 1, decal: d, fonts: fonts.filter(x => used.has(x.id)) };
    const url = URL.createObjectURL(new Blob([JSON.stringify(file)], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url; a.download = `${d.name.replace(/[^\w\- ]+/g, "").trim() || "decal"}.handzdecal.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const uploadDecal = async (file: File) => {
    const parsed = parseDecalFile(await file.text());
    if (!parsed) { setError("Not a decal file"); return; }
    const d = { ...parsed.decal, id: newDecalId() };
    guardUnsaved(() => createDecal(d, parsed.fonts));
  };
  const uploadFont = async (file: File) => {
    if (file.size > MAX_DECAL_FONT_BYTES) { setError(`Font too large (max ${Math.round(MAX_DECAL_FONT_BYTES / 1000)} KB)`); return; }
    const have = fontsOf(fresh());
    if (have.length >= MAX_DECAL_FONTS) { setError(`Font limit reached (${MAX_DECAL_FONTS})`); return; }
    const data = await new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = rej; r.readAsDataURL(file); });
    const font: CustomDecalFont = { id: newDecalId("f"), name: file.name.replace(/\.[^.]+$/, "").slice(0, 40), data };
    if (!persist({ decalFonts: [...have, font] })) return;
    registerDecalFonts([font]);
    const sel = selRef.current;
    const cur = draftRef.current;
    if (cur && sel.length) patchLayers(sel.filter(id => cur.layers.find(l => l.id === id)?.kind === "text"), l => ({ ...l, font: `upload:${font.id}` }));
  };
  const deleteFont = (id: string) => {
    const have = fontsOf(fresh());
    persist({ decalFonts: have.filter(x => x.id !== id) });
  };

  /** Buy a copy of a premade decal into the library, already paid for. */
  const buyPremade = (p: CustomDecal) => setConfirm({
    title: "Buy Decal?", detail: `${p.name} · 💎${PREMADE_DECAL_COST}`, action: `Buy 💎${PREMADE_DECAL_COST}`,
    run: () => {
      const f = fresh();
      if (!f) return;
      const lib = decalsOf(f), bal = f.diamonds ?? 0;
      if (lib.length >= MAX_CUSTOM_DECALS) { setLibrary(lib); return; }
      if (bal < PREMADE_DECAL_COST) { setDiamonds(bal); setError("Not enough diamonds"); return; }
      const d: CustomDecal = { ...p, id: newDecalId(), updatedAt: Date.now(), purchased: true };
      if (persist({ customDecals: [...lib, d], diamonds: bal - PREMADE_DECAL_COST })) openDecal(d);
    },
  });
  const thumbs = useMemo(() => new Map(library.map(d => [d.id, thumbnailOf(d)])), [library, fonts, fontTick]);
  const premadeThumbs = useMemo(() => new Map(PREMADE_DECALS.map(d => [d.id, thumbnailOf(d)])), [fontTick]);
  const previewColors = useMemo<FighterColors>(
    () => (draft ? { ...baseColors, gearDecal: customDecalColor(draft.id, cssColorOf(baseColors.gearDecal || "#ffffff")) } : baseColors),
    [draft?.id, baseColors],
  );

  // ───────── properties ─────────
  const selLayers = draft?.layers.filter(l => selected.includes(l.id)) ?? [];
  const one = selLayers.length === 1 ? selLayers[0] : null;
  const allText = selLayers.length > 0 && selLayers.every(l => l.kind === "text");
  const setProp = (patch: Partial<CustomDecalLayer>, record = true) => patchLayers(selected, l => ({ ...l, ...patch }), record);
  /** Text box keeps its stretch when the words or size change. */
  const setTextProp = (patch: Partial<CustomDecalLayer>) => patchLayers(selected, l => {
    if (l.kind !== "text") return l;
    const before = measureText(l), next = { ...l, ...patch }, after = measureText(next);
    return { ...next, w: Math.max(2, (l.w / before.w) * after.w), h: Math.max(2, (l.h / before.h) * after.h) };
  });
  // Slider drags record one undo step at the start of the gesture.
  const sliderStart = () => { if (draftRef.current) pushHistory(draftRef.current); };
  const slider = (label: string, value: number, min: number, max: number, step: number, onChange: (v: number) => void, testId: string) => (
    <label className="flex items-center gap-2 text-[10px] text-white/60">
      <span className="w-16 shrink-0 uppercase tracking-wider">{label}</span>
      <input type="range" min={min} max={max} step={step} value={value} onPointerDown={sliderStart} onChange={e => onChange(Number(e.target.value))} className="flex-1 accent-yellow-400" data-testid={testId} />
      <span className="w-9 text-right font-mono">{Math.round(value * 100) / 100}</span>
    </label>
  );
  const fontLabel = (f: string | undefined) => (f?.startsWith("upload:") ? fonts.find(x => x.id === f.slice(7))?.name ?? "Missing font" : f ?? "Arial");

  return (
    <div className="fixed inset-0 z-50 flex bg-[#0d0d0d] text-white" data-testid="screen-decal-editor">
      {/* Library */}
      <div className="w-60 shrink-0 border-r border-white/10 flex flex-col">
        <div className="flex items-center gap-2 p-3 border-b border-white/10">
          <Button variant="ghost" size="icon" onClick={() => guardUnsaved(onClose)} className="text-white/70 hover:text-white" data-testid="button-decal-back">
            <ArrowLeft className="w-5 h-5" />
          </Button>
          <div className="flex-1">
            <h2 className="text-yellow-400 font-black italic uppercase leading-tight">Decal Editor</h2>
            <p className="text-[10px] text-white/50 font-mono">{library.length}/{MAX_CUSTOM_DECALS} · 💎 {diamonds.toLocaleString()}</p>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-1 p-2 border-b border-white/10">
          <Button size="sm" disabled={!roomLeft} onClick={() => guardUnsaved(() => createDecal(starterDecal(`Decal ${library.length + 1}`)))} className="h-8 text-xs bg-yellow-500 hover:bg-yellow-400 text-black font-bold" data-testid="button-decal-new">
            <Plus className="w-3.5 h-3.5 mr-1" />New
          </Button>
          <Button size="sm" variant="outline" disabled={!roomLeft} onClick={() => uploadRef.current?.click()} className="h-8 text-xs bg-black/40 border-white/20 text-white hover:bg-white/10" data-testid="button-decal-upload">
            <Upload className="w-3.5 h-3.5 mr-1" />Upload
          </Button>
          <input ref={uploadRef} type="file" accept=".json,application/json" className="hidden" onChange={e => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void uploadDecal(f); }} />
        </div>
        <div className="flex-1 overflow-y-auto p-2 space-y-1" data-testid="list-decals">
          {library.map(d => (
            <div key={d.id} className={`rounded-lg border p-1.5 ${draft?.id === d.id ? "border-yellow-400/70 bg-yellow-400/5" : "border-white/10 bg-black/30"}`} data-testid={`decal-item-${d.id}`}>
              <button type="button" className="block w-full" onClick={() => draft?.id !== d.id && guardUnsaved(() => openDecal(d))} data-testid={`button-decal-load-${d.id}`}>
                <img src={thumbs.get(d.id)} alt="" className="w-full aspect-[16/9] rounded bg-[repeating-conic-gradient(#3a3a3a_0_25%,#2a2a2a_0_50%)] bg-[length:12px_12px]" />
              </button>
              {renaming === d.id ? (
                <Input autoFocus value={nameDraft} maxLength={NAME_MAX} onChange={e => setNameDraft(e.target.value)} onBlur={() => renameDecal(d.id, nameDraft)}
                  onKeyDown={e => { e.stopPropagation(); if (e.key === "Enter") renameDecal(d.id, nameDraft); else if (e.key === "Escape") setRenaming(null); }}
                  className="h-6 mt-1 text-xs bg-black/60 border-white/20 text-white" data-testid={`input-decal-name-${d.id}`} />
              ) : (
                <div className="flex items-center gap-1 mt-1">
                  <span className="flex-1 truncate text-xs font-semibold">{d.name}{wornId === d.id && <Check className="inline w-3 h-3 ml-1 text-green-400" />}</span>
                  <button type="button" title="Rename" className="p-0.5 text-white/60 hover:text-white" onClick={() => { setNameDraft(d.name); setRenaming(d.id); }} data-testid={`button-decal-rename-${d.id}`}><Pencil className="w-3 h-3" /></button>
                  <button type="button" title="Duplicate" disabled={!roomLeft} className="p-0.5 text-white/60 hover:text-white disabled:opacity-30" onClick={() => guardUnsaved(() => createDecal({ ...d, id: newDecalId(), name: `${d.name} copy`.slice(0, NAME_MAX), updatedAt: Date.now() }))} data-testid={`button-decal-duplicate-${d.id}`}><Copy className="w-3 h-3" /></button>
                  <button type="button" title="Download" className="p-0.5 text-white/60 hover:text-white" onClick={() => downloadDecal(d)} data-testid={`button-decal-download-${d.id}`}><Download className="w-3 h-3" /></button>
                  <button type="button" title="Delete" className="p-0.5 text-red-400/80 hover:text-red-300" onClick={() => setConfirm({ title: "Delete decal?", detail: d.name, action: "Delete", danger: true, run: () => deleteDecal(d.id) })} data-testid={`button-decal-delete-${d.id}`}><Trash2 className="w-3 h-3" /></button>
                </div>
              )}
            </div>
          ))}
          <p className="pt-2 text-[10px] font-bold uppercase tracking-wider text-white/50">Premade</p>
          {PREMADE_DECALS.map(p => (
            <div key={p.id} className="rounded-lg border border-white/10 bg-black/30 p-1.5" data-testid={`premade-decal-${p.id}`}>
              <img src={premadeThumbs.get(p.id)} alt="" className="w-full aspect-[16/9] rounded" />
              <div className="flex items-center gap-1 mt-1">
                <span className="flex-1 truncate text-xs font-semibold">{p.name}</span>
                <Button size="sm" disabled={!roomLeft || diamonds < PREMADE_DECAL_COST} onClick={() => guardUnsaved(() => buyPremade(p))}
                  className="h-6 px-2 text-[10px] bg-yellow-500 hover:bg-yellow-400 text-black font-bold" data-testid={`button-premade-buy-${p.id}`}>
                  💎{PREMADE_DECAL_COST}
                </Button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Canvas */}
      <div className="flex-1 min-w-0 flex flex-col">
        <div className="flex items-center gap-1 p-2 border-b border-white/10 flex-wrap">
          <Button size="icon" variant="ghost" className="h-8 w-8" title="Undo (Ctrl+Z)" disabled={!history.current.past.length} onClick={undo} data-testid="button-decal-undo"><Undo2 className="w-4 h-4" /></Button>
          <Button size="icon" variant="ghost" className="h-8 w-8" title="Redo (Ctrl+Y)" disabled={!history.current.future.length} onClick={redo} data-testid="button-decal-redo"><Redo2 className="w-4 h-4" /></Button>
          <span className="w-px h-6 bg-white/10 mx-1" />
          <Button size="sm" variant="ghost" className="h-8 text-xs" title="Select all (Ctrl+A)" disabled={!draft} onClick={selectAll} data-testid="button-decal-select-all"><BoxSelect className="w-4 h-4 mr-1" />Select All</Button>
          <Button size="icon" variant="ghost" className="h-8 w-8" title="Duplicate (Ctrl+D)" disabled={!selected.length} onClick={duplicateSelected} data-testid="button-decal-dup-layers"><Copy className="w-4 h-4" /></Button>
          <Button size="icon" variant="ghost" className="h-8 w-8 text-red-400" title="Delete (Del)" disabled={!selected.length} onClick={deleteSelected} data-testid="button-decal-delete-layers"><Trash2 className="w-4 h-4" /></Button>
          <div className="flex-1" />
          {error && <span className="text-xs text-red-400 mr-2" data-testid="text-decal-error">{error}</span>}
          <Button size="sm" disabled={!draft || !dirty} onClick={saveDraft} className="h-8 text-xs bg-[#634b3b] hover:bg-[#7a5c4a] text-white" data-testid="button-decal-save"><Save className="w-3.5 h-3.5 mr-1" />Save</Button>
          <Button size="sm" disabled={!draft || dirty || wornId === draft?.id || (!draftPaid && !canAfford)} onClick={wearDecal} className="h-8 text-xs bg-green-700 hover:bg-green-600 text-white" data-testid="button-decal-use">
            <Check className="w-3.5 h-3.5 mr-1" />{wornId === draft?.id ? "Wearing" : draftPaid ? "Wear" : `Wear 💎${CUSTOM_DECAL_DIAMOND_COST}`}
          </Button>
        </div>
        <div className="flex-1 min-h-0 flex items-center justify-center p-4">
          {draft ? (
            <canvas
              ref={canvasRef}
              width={VIEW_W * 2}
              height={VIEW_H * 2}
              className="max-w-full max-h-full touch-none select-none rounded-md"
              style={{ aspectRatio: `${VIEW_W} / ${VIEW_H}`, width: "100%" }}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
              data-testid="canvas-decal"
            />
          ) : (
            <p className="text-white/40 text-sm">No decals yet</p>
          )}
        </div>
        {draft && (
          <div className="border-t border-white/10 p-2 flex flex-wrap items-center gap-1">
            <Button size="sm" variant="outline" onClick={() => addLayer(freshLayer("text"))} className="h-8 text-xs bg-black/40 border-white/20 text-white hover:bg-white/10" data-testid="button-decal-add-text"><Type className="w-3.5 h-3.5 mr-1" />Text</Button>
            {DECAL_SHAPES.map(s => (
              <Button key={s} size="sm" variant="outline" title={s} onClick={() => addLayer(freshLayer("shape", s))} className="h-8 w-9 p-0 bg-black/40 border-white/20 hover:bg-white/10" data-testid={`button-decal-add-${s}`}>
                <ShapeIcon shape={s} />
              </Button>
            ))}
          </div>
        )}
      </div>

      {/* Properties, layers, preview */}
      <div className="w-72 shrink-0 border-l border-white/10 flex flex-col overflow-y-auto">
        <div className="p-2 flex justify-center border-b border-white/10 bg-[#141414]">
          <FighterStanceCanvas colors={previewColors} width={180} height={300} showHeadgear stance={playerBoxingStance()} spinnable />
        </div>
        {draft && (
          <>
            <div className="p-3 space-y-2 border-b border-white/10">
              <p className="text-[10px] text-white/40 font-semibold uppercase tracking-widest">Background</p>
              <div className="flex items-center gap-2">
                <input type="color" value={draft.background ?? "#ffffff"} disabled={draft.background === null} onPointerDown={sliderStart}
                  onChange={e => edit(d => ({ ...d, background: e.target.value }), false)} className="w-8 h-8 rounded bg-transparent disabled:opacity-30" data-testid="input-decal-bg" />
                <label className="flex items-center gap-1.5 text-xs text-white/70 cursor-pointer">
                  <input type="checkbox" checked={draft.background === null} onChange={e => edit(d => ({ ...d, background: e.target.checked ? null : "#ffffff" }))} className="accent-yellow-400" data-testid="toggle-decal-transparent" />
                  Transparent
                </label>
              </div>
            </div>

            {selLayers.length > 0 && (
              <div className="p-3 space-y-2 border-b border-white/10" data-testid="panel-decal-props">
                <p className="text-[10px] text-white/40 font-semibold uppercase tracking-widest">{one ? (one.kind === "text" ? "Text" : one.shape) : `${selLayers.length} selected`}</p>
                {allText && one && (
                  <Input value={one.text ?? ""} maxLength={60} onFocus={sliderStart} onChange={e => patchLayers(selected, l => {
                    const before = measureText(l), next = { ...l, text: filterProfanity(e.target.value) }, after = measureText(next);
                    return { ...next, w: Math.max(2, (l.w / before.w) * after.w) };
                  }, false)} className="h-8 text-sm bg-black/60 border-white/20 text-white" data-testid="input-decal-text" />
                )}
                {allText && (
                  <>
                    <div className="flex items-center gap-1">
                      <FontPicker value={one?.font} label={one ? fontLabel(one.font) : "Font…"} uploads={fonts} onPick={f => setTextProp({ font: f })} />
                      <Button size="icon" variant={selLayers.every(l => l.bold) ? "default" : "ghost"} className="h-8 w-8" onClick={() => setTextProp({ bold: !selLayers.every(l => l.bold) })} data-testid="button-decal-bold"><Bold className="w-4 h-4" /></Button>
                      <Button size="icon" variant={selLayers.every(l => l.italic) ? "default" : "ghost"} className="h-8 w-8" onClick={() => setTextProp({ italic: !selLayers.every(l => l.italic) })} data-testid="button-decal-italic"><Italic className="w-4 h-4" /></Button>
                    </div>
                    <div className="flex items-center gap-1">
                      <Button size="sm" variant="outline" disabled={fonts.length >= MAX_DECAL_FONTS} onClick={() => fontUploadRef.current?.click()} className="h-7 text-[11px] bg-black/40 border-white/20 text-white hover:bg-white/10" data-testid="button-decal-upload-font"><Upload className="w-3 h-3 mr-1" />Upload Font</Button>
                      <input ref={fontUploadRef} type="file" accept=".ttf,.otf,.woff,.woff2" className="hidden" onChange={e => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void uploadFont(f).catch(() => setError("Font failed to load")); }} />
                    </div>
                    {fonts.length > 0 && (
                      <div className="space-y-0.5">
                        {fonts.map(f => (
                          <div key={f.id} className="flex items-center gap-1 text-[11px] text-white/60">
                            <span className="flex-1 truncate" style={{ fontFamily: `hzdecal_${f.id}` }}>{f.name}</span>
                            <button type="button" title="Delete font" className="text-red-400/70 hover:text-red-300" onClick={() => setConfirm({ title: "Delete font?", detail: f.name, action: "Delete", danger: true, run: () => deleteFont(f.id) })} data-testid={`button-decal-delete-font-${f.id}`}><Trash2 className="w-3 h-3" /></button>
                          </div>
                        ))}
                      </div>
                    )}
                    {one && slider("Size", one.fontSize ?? 64, 8, 300, 1, v => setTextProp({ fontSize: v }), "slider-decal-fontsize")}
                    {one && slider("Arc", one.arc ?? 0, -100, 100, 1, v => setProp({ arc: v }, false), "slider-decal-arc")}
                  </>
                )}
                <div className="flex items-center gap-2">
                  <input type="color" value={one?.color ?? selLayers[0].color} onPointerDown={sliderStart} onChange={e => setProp({ color: e.target.value }, false)} className="w-8 h-8 rounded bg-transparent" data-testid="input-decal-color" />
                  <span className="text-[10px] text-white/50 uppercase">Fill</span>
                  <input type="color" value={one?.strokeColor ?? selLayers[0].strokeColor ?? "#000000"} onPointerDown={sliderStart} onChange={e => setProp({ strokeColor: e.target.value }, false)} className="w-8 h-8 rounded bg-transparent ml-2" data-testid="input-decal-stroke-color" />
                  <span className="text-[10px] text-white/50 uppercase">Outline</span>
                </div>
                {slider("Outline", one?.strokeWidth ?? selLayers[0].strokeWidth ?? 0, 0, 30, 0.5, v => setProp({ strokeWidth: v }, false), "slider-decal-stroke")}
                {slider("Opacity", one?.opacity ?? selLayers[0].opacity, 0, 1, 0.01, v => setProp({ opacity: v }, false), "slider-decal-opacity")}
                {one && (
                  <>
                    {slider("Rotate", one.rotation, 0, 360, 1, v => setProp({ rotation: v }, false), "slider-decal-rotation")}
                    {slider("Warp X", one.skewX, -80, 80, 1, v => setProp({ skewX: v }, false), "slider-decal-skewx")}
                    {slider("Warp Y", one.skewY, -80, 80, 1, v => setProp({ skewY: v }, false), "slider-decal-skewy")}
                  </>
                )}
                <div className="flex items-center gap-1">
                  <Button size="icon" variant="ghost" className="h-8 w-8" title="Flip horizontal" onClick={() => setProp({ flipX: !selLayers[0].flipX })} data-testid="button-decal-flipx"><FlipHorizontal className="w-4 h-4" /></Button>
                  <Button size="icon" variant="ghost" className="h-8 w-8" title="Flip vertical" onClick={() => setProp({ flipY: !selLayers[0].flipY })} data-testid="button-decal-flipy"><FlipVertical className="w-4 h-4" /></Button>
                  <Button size="sm" variant="ghost" className="h-8 text-xs" onClick={() => {
                    const f = selectionFrame(selLayers);
                    if (f) patchLayers(selected, l => ({ ...l, x: l.x + DECAL_W / 2 - f.cx, y: l.y + DECAL_H / 2 - f.cy }));
                  }} data-testid="button-decal-center">Center</Button>
                  <Button size="sm" variant="ghost" className="h-8 text-xs" onClick={() => setProp({ skewX: 0, skewY: 0, arc: selLayers[0].kind === "text" ? 0 : undefined })} data-testid="button-decal-unwarp">Unwarp</Button>
                </div>
              </div>
            )}

            <div className="p-3 space-y-1">
              <p className="text-[10px] text-white/40 font-semibold uppercase tracking-widest">Layers</p>
              {[...draft.layers].reverse().map((l, ri) => {
                const i = draft.layers.length - 1 - ri;
                const on = selected.includes(l.id);
                return (
                  <div key={l.id}
                    onClick={e => setSelected(e.shiftKey || e.ctrlKey || e.metaKey ? (on ? selected.filter(x => x !== l.id) : [...selected, l.id]) : [l.id])}
                    className={`flex items-center gap-1 rounded px-1.5 py-1 text-xs cursor-pointer ${on ? "bg-yellow-400/15 border border-yellow-400/50" : "bg-black/30 border border-transparent hover:border-white/15"}`}
                    data-testid={`layer-row-${l.id}`}>
                    <span className="w-3 h-3 rounded-sm border border-white/30 shrink-0" style={{ background: l.color }} />
                    <span className={`flex-1 truncate ${l.hidden ? "text-white/30" : ""}`}>{l.kind === "text" ? `“${filterProfanity(l.text ?? "")}”` : l.shape}</span>
                    <button type="button" className="p-0.5 text-white/50 hover:text-white disabled:opacity-20" disabled={i === draft.layers.length - 1} onClick={e => { e.stopPropagation(); moveLayer(l.id, 1); }} title="Bring forward"><ArrowUp className="w-3 h-3" /></button>
                    <button type="button" className="p-0.5 text-white/50 hover:text-white disabled:opacity-20" disabled={i === 0} onClick={e => { e.stopPropagation(); moveLayer(l.id, -1); }} title="Send back"><ArrowDown className="w-3 h-3" /></button>
                    <button type="button" className="p-0.5 text-white/50 hover:text-white" onClick={e => { e.stopPropagation(); patchLayers([l.id], x => ({ ...x, hidden: !x.hidden })); }} title={l.hidden ? "Show" : "Hide"} data-testid={`button-layer-visibility-${l.id}`}>
                      {l.hidden ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
                    </button>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>

      <AlertDialog open={!!confirm} onOpenChange={o => { if (!o) setConfirm(null); }}>
        <AlertDialogContent className="bg-[#1a1a1a] border-white/15 text-white">
          <AlertDialogHeader>
            <AlertDialogTitle>{confirm?.title}</AlertDialogTitle>
            {confirm?.detail && <AlertDialogDescription className="text-white/60">{confirm.detail}</AlertDialogDescription>}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="bg-transparent border-white/20 text-white hover:bg-white/10" data-testid="button-decal-confirm-cancel">Cancel</AlertDialogCancel>
            <AlertDialogAction className={confirm?.danger ? "bg-red-600 hover:bg-red-500 text-white" : "bg-[#634b3b] hover:bg-[#7a5c4a] text-white"}
              onClick={() => { const c = confirm; setConfirm(null); c?.run(); }} data-testid="button-decal-confirm">
              {confirm?.action}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function ShapeIcon({ shape }: { shape: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current, ctx = c?.getContext("2d");
    if (!c || !ctx) return;
    const l = freshLayer("shape", shape);
    const k = Math.min(36 / l.w, 22 / l.h);
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.save();
    ctx.translate(-DECAL_W / 2 * k + 20, -DECAL_H / 2 * k + 13);
    ctx.scale(k, k);
    drawDecalNoClear(ctx, { id: "", name: "", background: null, layers: [{ ...l, color: "#e5e5e5" }], updatedAt: 0 });
    ctx.restore();
  }, [shape]);
  return <canvas ref={ref} width={40} height={26} className="w-6 h-4" />;
}

/** Layers only, no clear. */
function drawDecalNoClear(ctx: CanvasRenderingContext2D, d: CustomDecal): void {
  for (const l of d.layers) drawLayer(ctx, l);
}
