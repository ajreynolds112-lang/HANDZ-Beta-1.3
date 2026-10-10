/**
 * Visual Enhancer settings: the post-processing pass every 3D view renders
 * through (render scale, sharpening, detail, colour, film grain). Device-level
 * graphics config, stored in one global localStorage key. Defaults are on.
 */

export type RenderScale = 0.5 | 0.67 | 0.77 | 1 | 1.5;

export interface VisualSettings {
  enabled: boolean;
  /** Internal render resolution as a fraction of the screen. */
  renderScale: RenderScale;
  /** Contrast-adaptive sharpening, 0–100. */
  sharpness: number;
  /** Local structure / clarity boost, 0–100. */
  detail: number;
  /** Exposure in stops, -2 to 2. */
  exposure: number;
  /** -100 to 100. */
  contrast: number;
  /** -100 to 100. */
  saturation: number;
  /** -100 (cool) to 100 (warm). */
  temperature: number;
  /** Film grain amount, 0–100. */
  grain: number;
  /** Film grain size in pixels, 0.5–4. */
  grainSize: number;
}

export const DEFAULT_VISUAL_SETTINGS: VisualSettings = {
  enabled: true,
  renderScale: 1.5,
  sharpness: 1,
  detail: 1,
  exposure: 0.15,
  contrast: -1,
  saturation: -3,
  temperature: 0,
  grain: 1,
  grainSize: 0.5,
};

export const RENDER_SCALE_OPTIONS: { value: RenderScale; label: string }[] = [
  { value: 0.5, label: "Performance (50%)" },
  { value: 0.67, label: "Balanced (67%)" },
  { value: 0.77, label: "Quality (77%)" },
  { value: 1, label: "Native (100%)" },
  { value: 1.5, label: "Supersample (150%)" },
];

const KEY = "handz_visual_enhancer";
let cached: VisualSettings | null = null;

const clamp = (v: unknown, lo: number, hi: number, d: number) =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d;

function sanitize(raw: Partial<VisualSettings> | null | undefined): VisualSettings {
  const d = DEFAULT_VISUAL_SETTINGS;
  const r = raw ?? {};
  const scale = RENDER_SCALE_OPTIONS.some(o => o.value === r.renderScale) ? (r.renderScale as RenderScale) : d.renderScale;
  return {
    enabled: typeof r.enabled === "boolean" ? r.enabled : d.enabled,
    renderScale: scale,
    sharpness: clamp(r.sharpness, 0, 100, d.sharpness),
    detail: clamp(r.detail, 0, 100, d.detail),
    exposure: clamp(r.exposure, -2, 2, d.exposure),
    contrast: clamp(r.contrast, -100, 100, d.contrast),
    saturation: clamp(r.saturation, -100, 100, d.saturation),
    temperature: clamp(r.temperature, -100, 100, d.temperature),
    grain: clamp(r.grain, 0, 100, d.grain),
    grainSize: clamp(r.grainSize, 0.5, 4, d.grainSize),
  };
}

/** Read every frame by the renderers, so it is cached in memory. */
export function getVisualSettings(): VisualSettings {
  if (cached) return cached;
  let parsed: Partial<VisualSettings> | null = null;
  try {
    const s = typeof localStorage !== "undefined" ? localStorage.getItem(KEY) : null;
    parsed = s ? JSON.parse(s) : null;
  } catch {
    parsed = null;
  }
  cached = sanitize(parsed);
  return cached;
}

export function setVisualSettings(patch: Partial<VisualSettings>): VisualSettings {
  cached = sanitize({ ...getVisualSettings(), ...patch });
  try {
    localStorage.setItem(KEY, JSON.stringify(cached));
  } catch {
    /* storage full or blocked: the setting still applies for this session */
  }
  return cached;
}

export function resetVisualSettings(): VisualSettings {
  cached = { ...DEFAULT_VISUAL_SETTINGS };
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
  return cached;
}
