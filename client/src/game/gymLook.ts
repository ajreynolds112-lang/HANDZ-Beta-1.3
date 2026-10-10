/**
 * Career gym customisation, saved on the fighter record (`gymLook`). Every
 * field is optional: an absent field means the stock look, so an untouched
 * career renders exactly as before.
 */
export interface GymLook {
  /** Brick colour for the walls. */
  wall?: string;
  /** Banner text. */
  name?: string;
  /** The theme's dark colour (banner/sign background, wall dado). */
  themeDark?: string;
  /** The theme's accent colour (banner border, dado stripe). */
  themeAccent?: string;
  /** Banner and office-sign lettering. */
  themeText?: string;
  /** Hanging bag body. */
  bagPrimary?: string;
  /** Hanging bag tape bands. */
  bagSecondary?: string;
  /** Rubber floor mats in the training corners. */
  mats?: string;
  lockers?: string;
  /** Door leaf. */
  door?: string;
  doorFrame?: string;
  /** The wooden bench behind the player. */
  woodBench?: string;
  /** The bench press's painted frame. */
  benchPress?: string;
  /** The glass office booth's frame and lower panels. */
  office?: string;
  /** The trophy cases' outer wood. */
  trophyCases?: string;
}

export const GYM_LOOK_DEFAULTS = {
  wall: "#6b3526",
  name: "HANDZ BOXING GYM",
  themeDark: "#16161c",
  themeAccent: "#deb345",
  themeText: "#deb345",
  bagPrimary: "#8a1f1a",
  bagSecondary: "#1a1a1d",
  mats: "#1d1d20",
  lockers: "#3a8ee0",
  door: "#9a6a45",
  doorFrame: "#9a6a45",
  woodBench: "#b07a3e",
  benchPress: "#d8301c",
  office: "#2b2b30",
  trophyCases: "#5a3a22",
} as const satisfies Required<GymLook>;

/** Force to rename the gym. */
export const GYM_RENAME_FORCE = 50_000;
export const GYM_NAME_MAX = 20;

const HEX = /^#[0-9a-fA-F]{6}$/;
const KEYS = ["wall", "name", "themeDark", "themeAccent", "themeText", "bagPrimary", "bagSecondary", "mats", "lockers", "door", "doorFrame", "woodBench", "benchPress", "office", "trophyCases"] as const;

/** Read a fighter's saved look, dropping anything malformed. */
export function gymLookOf(f: { gymLook?: Record<string, string> | null } | null | undefined): GymLook {
  const raw = f?.gymLook;
  if (!raw || typeof raw !== "object") return {};
  const out: GymLook = {};
  for (const k of KEYS) {
    const v = raw[k];
    if (typeof v !== "string") continue;
    if (k === "name") { const n = v.slice(0, GYM_NAME_MAX); if (n.trim()) out.name = n; }
    else if (HEX.test(v)) out[k] = v;
  }
  return out;
}

/** Stable key for change detection. */
export function gymLookKey(l: GymLook): string {
  return KEYS.map(k => l[k] ?? "").join("|");
}
