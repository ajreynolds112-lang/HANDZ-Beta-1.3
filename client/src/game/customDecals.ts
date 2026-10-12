import * as THREE from "three";
import type { CustomDecal, CustomDecalFont, CustomDecalLayer } from "@shared/schema";
import { getFighters } from "@/lib/localSaves";
import { premadeDecal } from "./premadeDecals";
import { filterProfanity } from "./profanity";

/**
 * Custom gear decals: player-drawn designs (shapes + text on an optional
 * background) worn in the Gear Decal patches on the gloves and headgear and the
 * patch on the girdle front.
 *
 * The worn decal rides inside the existing `gearDecal` colour string as
 * `decal:<id>|<hex>` so every path that already copies gear colours (outfits,
 * fights, previews, training) carries it untouched. `<hex>` is the standard
 * decal colour kept for the smaller decal spots the design doesn't cover.
 */

export const DECAL_W = 512;
export const DECAL_H = 288;
export const MAX_CUSTOM_DECALS = 50;
export const CUSTOM_DECAL_DIAMOND_COST = 20;
export const MAX_DECAL_FONTS = 12;
export const MAX_DECAL_FONT_BYTES = 800_000;

const PREFIX = "decal:";

export function isCustomDecalColor(c: string | null | undefined): boolean {
  return typeof c === "string" && c.startsWith(PREFIX);
}
export function parseCustomDecalColor(c: string | null | undefined): { id: string; base: string } | null {
  if (!isCustomDecalColor(c)) return null;
  const body = (c as string).slice(PREFIX.length);
  const bar = body.indexOf("|");
  const id = bar < 0 ? body : body.slice(0, bar);
  const base = bar < 0 ? "#ffffff" : body.slice(bar + 1);
  return id ? { id, base: /^#[0-9a-f]{6}$/i.test(base) ? base : "#ffffff" } : null;
}
export function customDecalColor(id: string, base: string): string {
  return `${PREFIX}${id}|${base}`;
}

export function newDecalId(prefix = "d"): string {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

// ───────────────────────── fonts ─────────────────────────

/** Sports/varsity fonts bundled under /fonts/decal (dafont "100% Free"); loaded on first use. */
export const STYLED_DECAL_FONTS: { name: string; file: string }[] = [
  { name: "Varsity Team", file: "varsity-team.otf" }, { name: "Freshman", file: "freshman.ttf" },
  { name: "College Bold", file: "college-bold.ttf" }, { name: "Sports World", file: "sports-world.ttf" },
  { name: "Sports Jersey", file: "sports-jersey.ttf" }, { name: "College Slab", file: "college-slab.otf" },
  { name: "Jersey Letters", file: "jersey-letters.ttf" }, { name: "Allstar", file: "allstar.ttf" },
  { name: "Graduate Shades", file: "graduate-shades.otf" }, { name: "Pop Warner", file: "pop-warner.ttf" },
  { name: "Nebraska", file: "nebraska.ttf" }, { name: "FM University", file: "fm-university.ttf" },
  { name: "FM College Team", file: "fm-college-team-outline.ttf" }, { name: "Hollywood Hills", file: "hollywood-hills.ttf" },
  { name: "Emilio 20", file: "emilio-20.ttf" }, { name: "Station 232", file: "station-232.ttf" },
  { name: "Dalmation", file: "dalmation.otf" }, { name: "Bascula College", file: "bascula-college.ttf" },
];

export const BUILTIN_DECAL_FONTS = [
  ...STYLED_DECAL_FONTS.map(f => f.name),
  "Arial", "Arial Black", "Impact", "Georgia", "Times New Roman", "Courier New", "Verdana", "Trebuchet MS", "Comic Sans MS",
];

const fontFaces = new Map<string, Promise<void>>();
let fontRev = 0;

/** Load bundled styled fonts (all, or just the named ones); textures redraw as each lands. */
export function loadStyledDecalFonts(names?: Iterable<string | undefined>): void {
  if (typeof FontFace === "undefined") return;
  const want = names ? new Set(names) : null;
  for (const f of STYLED_DECAL_FONTS) {
    const key = `styled:${f.name}`;
    if ((want && !want.has(f.name)) || fontFaces.has(key)) continue;
    const face = new FontFace(f.name, `url(/fonts/decal/${f.file})`);
    fontFaces.set(key, face.load().then(
      loaded => { document.fonts.add(loaded); fontRev++; },
      err => { console.warn("[decal] font failed to load", f.name, err); },
    ));
  }
}

export function fontFamilyOf(font: string | undefined): string {
  if (!font) return "Arial";
  if (font.startsWith("upload:")) return `hzdecal_${font.slice(7)}`;
  return font;
}

/** Load uploaded fonts into the page; textures redraw once each finishes. */
export function registerDecalFonts(fonts: CustomDecalFont[] | null | undefined): void {
  if (!fonts || typeof FontFace === "undefined") return;
  for (const f of fonts) {
    if (!f?.id || !f.data || fontFaces.has(f.id)) continue;
    const face = new FontFace(`hzdecal_${f.id}`, `url(${f.data})`);
    fontFaces.set(f.id, face.load().then(
      loaded => { document.fonts.add(loaded); fontRev++; },
      err => { console.warn("[decal] font failed to load", f.name, err); },
    ));
  }
}

// ───────────────────────── drawing ─────────────────────────

export const DECAL_SHAPES = [
  "rect", "roundRect", "ellipse", "triangle", "diamond", "star", "hexagon", "chevron", "parallelogram", "ring", "heart", "line",
] as const;

function shapePath(ctx: CanvasRenderingContext2D, shape: string, w: number, h: number): void {
  const x0 = -w / 2, y0 = -h / 2;
  ctx.beginPath();
  switch (shape) {
    case "roundRect": {
      const r = Math.min(w, h) * 0.22;
      ctx.moveTo(x0 + r, y0); ctx.arcTo(x0 + w, y0, x0 + w, y0 + h, r); ctx.arcTo(x0 + w, y0 + h, x0, y0 + h, r);
      ctx.arcTo(x0, y0 + h, x0, y0, r); ctx.arcTo(x0, y0, x0 + w, y0, r); break;
    }
    case "ellipse": ctx.ellipse(0, 0, w / 2, h / 2, 0, 0, Math.PI * 2); break;
    case "ring":
      ctx.ellipse(0, 0, w / 2, h / 2, 0, 0, Math.PI * 2);
      ctx.ellipse(0, 0, w * 0.32, h * 0.32, 0, 0, Math.PI * 2, true); break;
    case "triangle": ctx.moveTo(0, y0); ctx.lineTo(x0 + w, y0 + h); ctx.lineTo(x0, y0 + h); break;
    case "diamond": ctx.moveTo(0, y0); ctx.lineTo(x0 + w, 0); ctx.lineTo(0, y0 + h); ctx.lineTo(x0, 0); break;
    case "star":
      for (let i = 0; i < 10; i++) {
        const a = -Math.PI / 2 + (i * Math.PI) / 5, r = i % 2 ? 0.42 : 1;
        const px = Math.cos(a) * r * w / 2, py = Math.sin(a) * r * h / 2;
        if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py);
      }
      break;
    case "hexagon":
      for (let i = 0; i < 6; i++) {
        const a = (i * Math.PI) / 3;
        const px = Math.cos(a) * w / 2, py = Math.sin(a) * h / 2;
        if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py);
      }
      break;
    case "chevron":
      ctx.moveTo(x0, y0); ctx.lineTo(0, y0 + h * 0.55); ctx.lineTo(x0 + w, y0); ctx.lineTo(x0 + w, y0 + h * 0.45);
      ctx.lineTo(0, y0 + h); ctx.lineTo(x0, y0 + h * 0.45); break;
    case "parallelogram":
      ctx.moveTo(x0 + w * 0.25, y0); ctx.lineTo(x0 + w, y0); ctx.lineTo(x0 + w * 0.75, y0 + h); ctx.lineTo(x0, y0 + h); break;
    case "heart":
      ctx.moveTo(0, y0 + h); ctx.bezierCurveTo(x0 - w * 0.1, y0 + h * 0.45, x0 + w * 0.1, y0 - h * 0.1, 0, y0 + h * 0.28);
      ctx.bezierCurveTo(x0 + w * 0.9, y0 - h * 0.1, x0 + w * 1.1, y0 + h * 0.45, 0, y0 + h); break;
    case "line": ctx.rect(x0, -Math.max(1, h) / 2, w, Math.max(1, h)); break;
    default: ctx.rect(x0, y0, w, h);
  }
  ctx.closePath();
}

function fontCss(l: CustomDecalLayer): string {
  return `${l.italic ? "italic " : ""}${l.bold ? "bold " : ""}${Math.max(4, l.fontSize ?? 64)}px "${fontFamilyOf(l.font)}"`;
}

/** Natural (unstretched) size of a text layer at its font size. */
export function measureText(l: CustomDecalLayer): { w: number; h: number } {
  const c = measureCtx();
  if (!c) return { w: 100, h: 60 };
  c.font = fontCss(l);
  const fs = Math.max(4, l.fontSize ?? 64);
  return { w: Math.max(4, c.measureText(filterProfanity(l.text || " ")).width), h: fs * 1.15 };
}
let mctx: CanvasRenderingContext2D | null = null;
function measureCtx(): CanvasRenderingContext2D | null {
  if (!mctx && typeof document !== "undefined") mctx = document.createElement("canvas").getContext("2d");
  return mctx;
}

/** Layer local → design matrix (centre, rotation, skew, flip). */
export function layerMatrix(l: CustomDecalLayer): DOMMatrix {
  const m = new DOMMatrix().translate(l.x, l.y).rotate(l.rotation || 0);
  if (l.skewX) m.skewXSelf(l.skewX);
  if (l.skewY) m.skewYSelf(l.skewY);
  return m.scale(l.flipX ? -1 : 1, l.flipY ? -1 : 1);
}

function drawText(ctx: CanvasRenderingContext2D, l: CustomDecalLayer): void {
  const nat = measureText(l);
  ctx.scale(l.w / nat.w, l.h / nat.h);
  ctx.font = fontCss(l);
  ctx.textBaseline = "middle";
  const text = filterProfanity(l.text || "");
  const stroke = (l.strokeWidth ?? 0) > 0;
  if (stroke) { ctx.strokeStyle = l.strokeColor || "#000000"; ctx.lineWidth = l.strokeWidth!; ctx.lineJoin = "round"; }
  const arc = Math.max(-100, Math.min(100, l.arc ?? 0));
  if (Math.abs(arc) < 1) {
    ctx.textAlign = "center";
    if (stroke) ctx.strokeText(text, 0, 0);
    ctx.fillText(text, 0, 0);
    return;
  }
  // Bend along a circle: the total sweep grows with |arc| up to 180°.
  const sweep = (Math.abs(arc) / 100) * Math.PI;
  const r = nat.w / sweep;
  const dir = arc > 0 ? 1 : -1;
  ctx.textAlign = "center";
  let pos = -nat.w / 2;
  for (const ch of text) {
    const cw = ctx.measureText(ch).width;
    const a = (pos + cw / 2) / r;
    ctx.save();
    ctx.translate(Math.sin(a) * r, dir * (r - Math.cos(a) * r) - dir * (r - Math.cos(sweep / 2) * r) / 2);
    ctx.rotate(dir * a);
    if (stroke) ctx.strokeText(ch, 0, 0);
    ctx.fillText(ch, 0, 0);
    ctx.restore();
    pos += cw;
  }
}

export function drawLayer(ctx: CanvasRenderingContext2D, l: CustomDecalLayer): void {
  if (l.hidden) return;
  ctx.save();
  const m = layerMatrix(l);
  ctx.transform(m.a, m.b, m.c, m.d, m.e, m.f);
  ctx.globalAlpha = Math.max(0, Math.min(1, l.opacity ?? 1));
  ctx.fillStyle = l.color || "#ffffff";
  if (l.kind === "text") drawText(ctx, l);
  else {
    shapePath(ctx, l.shape || "rect", l.w, l.h);
    ctx.fill("evenodd");
    if ((l.strokeWidth ?? 0) > 0) { ctx.strokeStyle = l.strokeColor || "#000000"; ctx.lineWidth = l.strokeWidth!; ctx.stroke(); }
  }
  ctx.restore();
}

/** Paint a design onto a DECAL_W × DECAL_H context (cleared first). */
export function drawDecal(ctx: CanvasRenderingContext2D, d: CustomDecal): void {
  ctx.clearRect(0, 0, DECAL_W, DECAL_H);
  if (d.background) { ctx.fillStyle = d.background; ctx.fillRect(0, 0, DECAL_W, DECAL_H); }
  for (const l of d.layers) drawLayer(ctx, l);
}

// ───────────────────────── registry + textures ─────────────────────────

/** Live designs by id: saved library entries, overridden by the editor's draft. */
const designs = new Map<string, CustomDecal>();
const drafts = new Map<string, CustomDecal>();
let scanned = false;

function scanSaves(): void {
  scanned = true;
  try {
    for (const f of getFighters()) {
      registerDecalFonts(f.decalFonts as CustomDecalFont[] | null);
      for (const d of (f.customDecals as CustomDecal[] | null) ?? []) if (d?.id && !designs.has(d.id)) designs.set(d.id, d);
    }
  } catch (e) {
    console.warn("[decal] library scan failed", e);
  }
}

/** Keep the registry in step with a career's saved library. */
export function registerDecalLibrary(decals: CustomDecal[] | null | undefined, fonts?: CustomDecalFont[] | null): void {
  registerDecalFonts(fonts);
  for (const d of decals ?? []) if (d?.id) designs.set(d.id, d);
}

/** The editor's unsaved working copy (null clears it, falling back to the saved one). */
export function setDecalDraft(id: string, d: CustomDecal | null): void {
  if (d) drafts.set(id, d); else drafts.delete(id);
}

function lookup(id: string): CustomDecal | null {
  const d = drafts.get(id) ?? designs.get(id) ?? premadeDecal(id);
  if (d) return d;
  if (!scanned) { scanSaves(); return designs.get(id) ?? null; }
  return null;
}

const texCache = new Map<string, { tex: THREE.CanvasTexture; ctx: CanvasRenderingContext2D; drawn: unknown; fonts: number }>();

/**
 * Texture for a worn decal, redrawn whenever its design object or the loaded
 * fonts change. Null when the design isn't in this browser (shows plain).
 */
export function customDecalTexture(id: string): THREE.Texture | null {
  const d = lookup(id);
  if (!d || typeof document === "undefined") return null;
  let e = texCache.get(id);
  if (!e) {
    const canvas = document.createElement("canvas");
    canvas.width = DECAL_W; canvas.height = DECAL_H;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    e = { tex, ctx, drawn: null, fonts: -1 };
    texCache.set(id, e);
  }
  if (e.drawn !== d || e.fonts !== fontRev) {
    loadStyledDecalFonts(d.layers.map(l => l.font));
    drawDecal(e.ctx, d);
    e.drawn = d; e.fonts = fontRev;
    e.tex.needsUpdate = true;
  }
  return e.tex;
}

/** Changes whenever the worn decal's picture would (cheap; read every frame). */
export function customDecalRenderKey(id: string): string {
  const d = lookup(id);
  return d ? `${id}:${d.updatedAt}:${drafts.has(id) ? "draft" : "saved"}:${d.layers.length}:${fontRev}:${draftRev}` : `${id}:missing`;
}
let draftRev = 0;
/** Call after every draft edit so renderers pick it up. */
export function bumpDecalDraft(): void { draftRev++; }

// ───────────────────────── file format ─────────────────────────

export interface DecalFile {
  type: "handz-decal";
  version: 1;
  decal: CustomDecal;
  fonts: CustomDecalFont[];
}

const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
const str = (v: unknown, d: string) => (typeof v === "string" ? v : d);

/** Validate untrusted layer data (uploads, old saves). */
export function sanitizeLayer(raw: unknown): CustomDecalLayer | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const kind = r.kind === "text" ? "text" : r.kind === "shape" ? "shape" : null;
  if (!kind) return null;
  return {
    id: str(r.id, newDecalId("l")),
    kind,
    shape: kind === "shape" ? str(r.shape, "rect") : undefined,
    text: kind === "text" ? str(r.text, "TEXT").slice(0, 60) : undefined,
    font: kind === "text" ? str(r.font, "Arial") : undefined,
    fontSize: kind === "text" ? Math.max(4, Math.min(400, num(r.fontSize, 64))) : undefined,
    bold: !!r.bold, italic: !!r.italic,
    arc: kind === "text" ? Math.max(-100, Math.min(100, num(r.arc, 0))) : undefined,
    x: num(r.x, DECAL_W / 2), y: num(r.y, DECAL_H / 2),
    w: Math.max(1, num(r.w, 100)), h: Math.max(1, num(r.h, 100)),
    rotation: num(r.rotation, 0), skewX: Math.max(-80, Math.min(80, num(r.skewX, 0))), skewY: Math.max(-80, Math.min(80, num(r.skewY, 0))),
    flipX: !!r.flipX, flipY: !!r.flipY,
    color: str(r.color, "#ffffff"),
    opacity: Math.max(0, Math.min(1, num(r.opacity, 1))),
    strokeColor: str(r.strokeColor, "#000000"),
    strokeWidth: Math.max(0, Math.min(40, num(r.strokeWidth, 0))),
    hidden: !!r.hidden,
  };
}

export function parseDecalFile(text: string): DecalFile | null {
  try {
    const j = JSON.parse(text) as Record<string, unknown>;
    if (j.type !== "handz-decal" || !j.decal || typeof j.decal !== "object") return null;
    const d = j.decal as Record<string, unknown>;
    const layers = (Array.isArray(d.layers) ? d.layers : []).map(sanitizeLayer).filter(Boolean) as CustomDecalLayer[];
    const fonts = (Array.isArray(j.fonts) ? j.fonts : [])
      .filter((f): f is CustomDecalFont => !!f && typeof f.id === "string" && typeof f.data === "string" && f.data.startsWith("data:"))
      .map(f => ({ id: f.id, name: str(f.name, "Font").slice(0, 40), data: f.data }));
    return {
      type: "handz-decal", version: 1,
      decal: {
        id: str(d.id, newDecalId()), name: str(d.name, "Decal").slice(0, 32),
        background: typeof d.background === "string" ? d.background : null,
        layers, updatedAt: Date.now(),
      },
      fonts,
    };
  } catch {
    return null;
  }
}
