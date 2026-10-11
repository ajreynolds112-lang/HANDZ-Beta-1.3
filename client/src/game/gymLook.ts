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

/** Challenges: the challenger gyms — same equipment, own colours, name and (optionally) floor layout. */
export const AWAY_GYMS: { layout?: number; look: Required<GymLook>; ring: Record<"canvas" | "border" | "ropeLower" | "ropeMiddle" | "ropeUpper" | "posts" | "text", string> }[] = [
  {
    look: { wall: "#4a4f57", name: "IRON FIST GYM", themeDark: "#1b1e24", themeAccent: "#c8302a", themeText: "#e6e6e6", bagPrimary: "#2a2d33", bagSecondary: "#c8302a", mats: "#26292e", lockers: "#7a8088", door: "#5a5f66", doorFrame: "#33373d", woodBench: "#6e6a64", benchPress: "#c8302a", office: "#1f2227", trophyCases: "#3a3d42" },
    ring: { canvas: "#d9dde2", border: "#3a3f46", ropeLower: "#c8302a", ropeMiddle: "#1b1e24", ropeUpper: "#c8302a", posts: "#2a2d33", text: "#c8302a" },
  },
  {
    look: { wall: "#2f5a3a", name: "SOUTHSIDE BOXING", themeDark: "#12241a", themeAccent: "#e0b43a", themeText: "#e0b43a", bagPrimary: "#1f4a2c", bagSecondary: "#e0b43a", mats: "#1a2a20", lockers: "#3f7a4f", door: "#7a5a32", doorFrame: "#5a4024", woodBench: "#a87a42", benchPress: "#e0b43a", office: "#18301f", trophyCases: "#4a3420" },
    ring: { canvas: "#e8efd8", border: "#3a5a32", ropeLower: "#1f6a34", ropeMiddle: "#e0b43a", ropeUpper: "#1f6a34", posts: "#e0b43a", text: "#1f6a34" },
  },
  {
    look: { wall: "#7a1e1e", name: "RED CORNER CLUB", themeDark: "#0e0e10", themeAccent: "#f2f2f2", themeText: "#f2f2f2", bagPrimary: "#111114", bagSecondary: "#b81c1c", mats: "#141416", lockers: "#9a2222", door: "#2a1a1a", doorFrame: "#141010", woodBench: "#5a2a22", benchPress: "#111114", office: "#141416", trophyCases: "#2a1414" },
    ring: { canvas: "#f4ecec", border: "#1a1a1d", ropeLower: "#b81c1c", ropeMiddle: "#111114", ropeUpper: "#b81c1c", posts: "#b81c1c", text: "#b81c1c" },
  },
  {
    look: { wall: "#24345a", name: "BLUE LINE BOXING", themeDark: "#0f1628", themeAccent: "#bfc8d6", themeText: "#bfc8d6", bagPrimary: "#1e3a7a", bagSecondary: "#bfc8d6", mats: "#161e30", lockers: "#2f5cb0", door: "#3a4a6a", doorFrame: "#22304a", woodBench: "#8a7a62", benchPress: "#2f5cb0", office: "#141c30", trophyCases: "#2a3248" },
    ring: { canvas: "#dbe6f5", border: "#22304a", ropeLower: "#1e3a7a", ropeMiddle: "#bfc8d6", ropeUpper: "#1e3a7a", posts: "#bfc8d6", text: "#1e3a7a" },
  },
  {
    look: { wall: "#8a6a3a", name: "GOLDEN GLOVE GYM", themeDark: "#2a1e10", themeAccent: "#f0c84a", themeText: "#f0c84a", bagPrimary: "#b8862a", bagSecondary: "#2a1e10", mats: "#2a2218", lockers: "#c49a3a", door: "#6a4a26", doorFrame: "#4a3218", woodBench: "#c08a4a", benchPress: "#f0c84a", office: "#2a2014", trophyCases: "#6a4622" },
    ring: { canvas: "#f6eed8", border: "#6a4a26", ropeLower: "#f0c84a", ropeMiddle: "#2a1e10", ropeUpper: "#f0c84a", posts: "#f0c84a", text: "#b8862a" },
  },
  {
    layout: 1,
    look: { wall: "#5a3a6a", name: "NIGHT OWL BOXING", themeDark: "#1a1024", themeAccent: "#3ad0c8", themeText: "#e6e0f0", bagPrimary: "#2a1a3a", bagSecondary: "#3ad0c8", mats: "#1e1628", lockers: "#6a4a8a", door: "#3a2a4a", doorFrame: "#22182e", woodBench: "#6a5a6e", benchPress: "#3ad0c8", office: "#1a1224", trophyCases: "#3a2a48" },
    ring: { canvas: "#ece6f4", border: "#2a1a3a", ropeLower: "#3ad0c8", ropeMiddle: "#5a3a6a", ropeUpper: "#3ad0c8", posts: "#2a1a3a", text: "#3ad0c8" },
  },
  {
    layout: 2,
    look: { wall: "#9a4a22", name: "FOUNDRY FIGHT CLUB", themeDark: "#1e1410", themeAccent: "#ff8a2a", themeText: "#f2e2d2", bagPrimary: "#3a2a22", bagSecondary: "#ff8a2a", mats: "#241a14", lockers: "#5a5f66", door: "#4a3a30", doorFrame: "#2a201a", woodBench: "#7a5a40", benchPress: "#ff8a2a", office: "#1e1612", trophyCases: "#3a2a20" },
    ring: { canvas: "#f2e8de", border: "#3a2a22", ropeLower: "#ff8a2a", ropeMiddle: "#1e1410", ropeUpper: "#ff8a2a", posts: "#5a5f66", text: "#ff8a2a" },
  },
];

/** Neural Network → Gym Names: admin renames of the challenger gyms (index-aligned, "" = stock). */
export const AWAY_GYM_NAMES_KEY = "handz_away_gym_names";
const STOCK_AWAY_NAMES = AWAY_GYMS.map(g => g.look.name);
export const stockAwayGymName = (i: number) => STOCK_AWAY_NAMES[i];
export function loadAwayGymNames(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(AWAY_GYM_NAMES_KEY) ?? "[]");
    return Array.isArray(raw) ? raw.map(v => (typeof v === "string" ? v : "")) : [];
  } catch { return []; }
}
/** Writes the overrides straight onto AWAY_GYMS so every reader sees them. */
export function applyAwayGymNames(names: string[]): void {
  AWAY_GYMS.forEach((g, i) => { g.look.name = names[i]?.trim().slice(0, GYM_NAME_MAX) || STOCK_AWAY_NAMES[i]; });
}
export function saveAwayGymNames(names: string[]): void {
  try { localStorage.setItem(AWAY_GYM_NAMES_KEY, JSON.stringify(names)); } catch { /* no storage */ }
  applyAwayGymNames(names);
}
applyAwayGymNames(loadAwayGymNames());

/** A challenger always hosts at the same gym. */
export const awayGymFor = (rosterId: number) => AWAY_GYMS[((rosterId % AWAY_GYMS.length) + AWAY_GYMS.length) % AWAY_GYMS.length];
