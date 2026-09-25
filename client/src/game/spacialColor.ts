/**
 * Spacial Color — the endgame gear finish: deep-space black with drifting
 * purple stars.
 *
 * It is not a hex colour, so it cannot live in the same slots as one. Instead
 * every gear colour field can carry the sentinel string `"spacial"`, and the
 * renderer paints those surfaces with an animated star pattern instead of a
 * flat fill. Three rules keep that from leaking:
 *
 *  1. Anything that *parses* a colour (shading, contrast ink, gradients) reads
 *     the sentinel as `SPACIAL_BASE_HEX`, so derived strokes and shadows stay
 *     sane instead of producing NaN.
 *  2. Anything that *paints* a colour goes through the canvas `fillStyle`
 *     interception installed by `enableSpacialFills`, which swaps the sentinel
 *     for the live pattern. That one choke point covers every gear surface,
 *     including the knocked-down poses and the preview canvases.
 *  3. Anything outside canvas (SVG previews, `<input type="color">`) uses
 *     `cssColorOf`, which falls back to the base hex.
 *
 * The animation runs off its own clock inside the pattern builder rather than a
 * frame parameter, so the stars keep flowing whether or not the fighter (or the
 * game) is moving — and that clock can be sped up while the wearer moves.
 */

/** Sentinel stored in gear colour fields. Never a valid CSS colour on purpose. */
export const SPACIAL_COLOR = "spacial";

/** What the sentinel reads as wherever a real hex is required. */
export const SPACIAL_BASE_HEX = "#0b0616";

/**
 * Force price of the finish, charged once **per gear piece**.
 *
 * It used to be a single unlock covering the whole kit; that is now legacy and
 * survives only as a grandfather rule in `spacialOwnedOf`.
 */
export const SPACIAL_PRICE_PER_GEAR_FORCE = 500_000_000;

export function isSpacial(color: string | null | undefined): boolean {
  return color === SPACIAL_COLOR;
}

/** The sentinel as something CSS will actually accept. */
export function cssColorOf(color: string | null | undefined): string {
  return isSpacial(color) ? SPACIAL_BASE_HEX : (color ?? SPACIAL_BASE_HEX);
}

/** Gear fields the finish can cover. Skin is deliberately left alone. */
export const SPACIAL_GEAR_KEYS = [
  "gloves", "gloveTape", "trunks", "shoes", "headgear", "socks", "laces", "soles", "waistStripe",
] as const;

export type SpacialGearKey = typeof SPACIAL_GEAR_KEYS[number];

/** Which pieces wear the finish: every piece (`true`), a chosen list, or none. */
export type SpacialSelection = boolean | readonly string[] | null | undefined;

/**
 * Read a fighter's selection. The per-piece list wins; the older whole-kit
 * boolean is the fallback so a save written before per-piece picking still
 * shows the finish.
 */
export function spacialSelectionOf(
  f: { spacialColors?: boolean | null; spacialParts?: unknown } | null | undefined,
): SpacialSelection {
  if (!f) return null;
  if (Array.isArray(f.spacialParts)) return f.spacialParts as string[];
  return f.spacialColors ? true : null;
}

/**
 * Which pieces the finish has been *bought* for, as opposed to worn.
 *
 * A career that paid the old whole-kit price owns every piece: grandfathering it
 * here rather than migrating the save means there is no one-shot upgrade step to
 * get wrong, and no way for an existing player to silently lose the finish.
 */
export function spacialOwnedOf(
  f: { spacialUnlocked?: boolean | null; spacialOwned?: unknown } | null | undefined,
): SpacialGearKey[] {
  if (!f) return [];
  if (f.spacialUnlocked) return [...SPACIAL_GEAR_KEYS];
  const owned = f.spacialOwned;
  if (!Array.isArray(owned)) return [];
  return SPACIAL_GEAR_KEYS.filter(k => (owned as unknown[]).includes(k));
}

/**
 * Paint the selected gear fields of a colour set with the finish. Returns the
 * set untouched when nothing is selected, so callers can wrap unconditionally.
 */
export function applySpacialGear<T extends Record<string, unknown>>(colors: T, on: SpacialSelection): T {
  if (!on) return colors;
  const wanted: readonly string[] = on === true ? SPACIAL_GEAR_KEYS : on;
  const out: Record<string, unknown> = { ...colors };
  let touched = false;
  for (const key of SPACIAL_GEAR_KEYS) {
    if (!wanted.includes(key)) continue;
    out[key] = SPACIAL_COLOR;
    touched = true;
  }
  return touched ? (out as T) : colors;
}

// ---------------------------------------------------------------------------
// The starfield itself
// ---------------------------------------------------------------------------

/** Offscreen tile resolution — supersampled so small stars stay crisp. */
const TILE_PX = 96;
/** How wide the tile repeats on the canvas, in canvas pixels. */
const TILE_SCREEN_PX = 110;
/** Canvas pixels per second the field drifts sideways and upwards. */
const SPACIAL_DRIFT_X = 6;
const SPACIAL_DRIFT_Y = 14;
/** How much faster the whole field runs while the wearer is on the move. */
const SPACIAL_MOTION_MULT = 2;
/**
 * The boost has to be re-armed every frame. Anything that stops updating —
 * pause, the end of a round, backing out to a menu — lets it lapse on its own
 * instead of leaving the field stuck at double speed.
 */
const BOOST_TTL_MS = 250;

let boostUntilRealMs = -1;

/**
 * Called by the game loop while the player is walking the ring. The starfield
 * runs at double speed for as long as this keeps being re-armed.
 */
export function setSpacialMotionBoost(active: boolean): void {
  boostUntilRealMs = active ? Date.now() + BOOST_TTL_MS : -1;
}

let clockMs = 0;
let clockRealMs = -1;

/**
 * The animation clock. It advances with real time, but at double rate while
 * boosted, so changing speed shifts the *rate* and never jumps the phase — the
 * stars accelerate smoothly instead of teleporting.
 */
function spacialNow(): number {
  const real = Date.now();
  if (clockRealMs < 0) {
    clockRealMs = real;
    return clockMs;
  }
  // Clamped so a backgrounded tab doesn't fast-forward the field on return.
  const dt = Math.min(100, Math.max(0, real - clockRealMs));
  clockRealMs = real;
  clockMs += dt * (real < boostUntilRealMs ? SPACIAL_MOTION_MULT : 1);
  return clockMs;
}

interface Star {
  x: number;
  y: number;
  r: number;
  phase: number;
  speed: number;
  color: string;
}

let stars: Star[] | null = null;

function buildStars(): Star[] {
  // Fixed seed: the field is the same every session, only the twinkle moves.
  let s = 20260807;
  const rng = () => {
    s = (s * 1664525 + 1013904223) & 0x7fffffff;
    return s / 0x7fffffff;
  };
  const palette = ["#ffffff", "#e9d5ff", "#c084fc", "#a855f7", "#7c3aed"];
  const out: Star[] = [];
  for (let i = 0; i < 52; i++) {
    out.push({
      x: rng() * TILE_PX,
      y: rng() * TILE_PX,
      r: 0.5 + rng() * rng() * 2.4,
      phase: rng() * Math.PI * 2,
      speed: 1.1 + rng() * 2.6,
      color: palette[Math.floor(rng() * palette.length)],
    });
  }
  return out;
}

let tile: HTMLCanvasElement | null = null;
let tileDrawnAt = -1;

/** Redraw the tile at most ~25 times a second; the twinkle needs no more. */
function getTile(nowMs: number): HTMLCanvasElement | null {
  if (typeof document === "undefined") return null;
  if (!tile) {
    tile = document.createElement("canvas");
    tile.width = TILE_PX;
    tile.height = TILE_PX;
  }
  if (tileDrawnAt >= 0 && nowMs - tileDrawnAt < 40) return tile;
  const tctx = tile.getContext("2d");
  if (!tctx) return null;
  if (!stars) stars = buildStars();

  tctx.clearRect(0, 0, TILE_PX, TILE_PX);
  tctx.fillStyle = "#07030f";
  tctx.fillRect(0, 0, TILE_PX, TILE_PX);

  // Two slow nebula blooms so the black is never flat.
  const nebula = (cx: number, cy: number, r: number, color: string, alpha: number) => {
    const g = tctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    g.addColorStop(0, color);
    g.addColorStop(1, "rgba(0,0,0,0)");
    tctx.globalAlpha = alpha;
    tctx.fillStyle = g;
    tctx.fillRect(0, 0, TILE_PX, TILE_PX);
    tctx.globalAlpha = 1;
  };
  const swirl = nowMs / 4200;
  nebula(TILE_PX * (0.32 + 0.05 * Math.sin(swirl)), TILE_PX * 0.3, TILE_PX * 0.55, "#4c1d95", 0.55);
  nebula(TILE_PX * 0.74, TILE_PX * (0.72 + 0.05 * Math.cos(swirl * 0.8)), TILE_PX * 0.45, "#6d28d9", 0.4);

  for (const star of stars) {
    const twinkle = 0.45 + 0.55 * (0.5 + 0.5 * Math.sin(nowMs / 1000 * star.speed + star.phase));
    tctx.globalAlpha = twinkle;
    tctx.fillStyle = star.color;
    tctx.beginPath();
    tctx.arc(star.x, star.y, star.r, 0, Math.PI * 2);
    tctx.fill();
    // The brighter stars get a soft halo and a faint cross flare.
    if (star.r > 1.6) {
      tctx.globalAlpha = twinkle * 0.35;
      tctx.beginPath();
      tctx.arc(star.x, star.y, star.r * 2.6, 0, Math.PI * 2);
      tctx.fill();
      tctx.globalAlpha = twinkle * 0.5;
      tctx.strokeStyle = star.color;
      tctx.lineWidth = 0.5;
      tctx.beginPath();
      tctx.moveTo(star.x - star.r * 3, star.y);
      tctx.lineTo(star.x + star.r * 3, star.y);
      tctx.moveTo(star.x, star.y - star.r * 3);
      tctx.lineTo(star.x, star.y + star.r * 3);
      tctx.stroke();
    }
  }
  tctx.globalAlpha = 1;
  tileDrawnAt = nowMs;
  return tile;
}

const patternCache = new WeakMap<CanvasRenderingContext2D, { pattern: CanvasPattern; drawnAt: number }>();

/**
 * The paint to use wherever a gear surface is spacial. Falls back to the base
 * hex if patterns are unavailable, so a surface is never left unpainted.
 */
export function spacialPaint(ctx: CanvasRenderingContext2D): CanvasPattern | string {
  const now = spacialNow();
  const img = getTile(now);
  if (!img) return SPACIAL_BASE_HEX;

  let cached = patternCache.get(ctx);
  // A pattern snapshots its source, so a redrawn tile needs a fresh pattern.
  if (!cached || cached.drawnAt !== tileDrawnAt) {
    const pattern = ctx.createPattern(img, "repeat");
    if (!pattern) return SPACIAL_BASE_HEX;
    cached = { pattern, drawnAt: tileDrawnAt };
    patternCache.set(ctx, cached);
  }

  // The starfield is anchored to the canvas, not to the fighter: it reads as a
  // cutout onto space, so the stars keep flowing the same way no matter which
  // direction the wearer faces, moves, leans or is knocked to. Every gear
  // surface is drawn under some translate/rotate/scale, so the pattern matrix
  // undoes the live transform first and then lays the tile out in canvas
  // pixels.
  const scale = TILE_SCREEN_PX / TILE_PX;
  const dx = (now / 1000 * SPACIAL_DRIFT_X) % TILE_SCREEN_PX;
  const dy = -((now / 1000 * SPACIAL_DRIFT_Y) % TILE_SCREEN_PX);
  try {
    const canvasSpace = new DOMMatrix().translateSelf(dx, dy).scaleSelf(scale);
    const toUserSpace = ctx.getTransform().inverse();
    cached.pattern.setTransform(toUserSpace.multiply(canvasSpace));
  } catch {
    /* No DOMMatrix / getTransform: the tile just paints in local space. */
  }
  return cached.pattern;
}

/**
 * Teach a canvas context to understand the sentinel: assigning `"spacial"` to
 * `fillStyle`/`strokeStyle` paints the starfield instead. Idempotent, and a
 * no-op where the property descriptors can't be read.
 */
export function enableSpacialFills(ctx: CanvasRenderingContext2D): void {
  const patched = ctx as CanvasRenderingContext2D & { __spacialPatched?: boolean };
  if (patched.__spacialPatched) return;
  if (typeof CanvasRenderingContext2D === "undefined") return;
  const proto = CanvasRenderingContext2D.prototype;
  const fill = Object.getOwnPropertyDescriptor(proto, "fillStyle");
  const stroke = Object.getOwnPropertyDescriptor(proto, "strokeStyle");
  if (!fill?.set || !fill.get || !stroke?.set || !stroke.get) return;

  Object.defineProperty(ctx, "fillStyle", {
    configurable: true,
    get(this: CanvasRenderingContext2D) { return fill.get!.call(this); },
    set(this: CanvasRenderingContext2D, v: unknown) {
      fill.set!.call(this, v === SPACIAL_COLOR ? spacialPaint(this) : v);
    },
  });
  Object.defineProperty(ctx, "strokeStyle", {
    configurable: true,
    get(this: CanvasRenderingContext2D) { return stroke.get!.call(this); },
    set(this: CanvasRenderingContext2D, v: unknown) {
      stroke.set!.call(this, v === SPACIAL_COLOR ? spacialPaint(this) : v);
    },
  });
  patched.__spacialPatched = true;
}
