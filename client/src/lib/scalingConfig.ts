/**
 * Level / stat-point scaling configuration.
 *
 * Every level-driven ramp in the game runs through `levelScale()` and every
 * stat-point coefficient is read from here, so this module is the single place
 * that decides how a fighter grows. The Neural Network screen edits it live.
 *
 * Two things matter about the storage:
 *  - It is hand-set tuning, not career progress, so the key joins TUNING_KEYS in
 *    localSaves.ts: never cleared by starting a new save, still exported inside
 *    a save file so a career moved to another browser arrives tuned the same.
 *  - Reads happen inside the fight loop, so the parsed config is cached in a
 *    module-level variable and writes refresh that cache synchronously. A tweak
 *    made on the tuning screen is live in the very next fight without a reload.
 */

export const SCALING_LS_KEY = "handz_scaling_config";

export type RampGroup = "Stamina" | "Offense" | "Defense" | "Telegraph" | "Movement" | "AI";

export interface LevelRampDef {
  id: string;
  label: string;
  group: RampGroup;
  /** Value at level 1. */
  min: number;
  /** Value once the ramp tops out (see `rampMaxLevel`). */
  max: number;
  unit: string;
  /** Rendering hint only — some ramps deliberately count down as you level. */
  note?: string;
}

/**
 * Endpoints mirror the call sites in engine.ts / ai.ts. The curve between them
 * is owned by `levelScale`, so changing `rampMaxLevel` re-shapes every one of
 * these at once — that is the knob that makes levels past 100 mean anything.
 */
export const LEVEL_RAMP_DEFS: LevelRampDef[] = [
  { id: "maxStamina",              label: "Gas tank (stamina pool)",     group: "Stamina",   min: 1,    max: 10,   unit: "x" },
  { id: "staminaRegen",            label: "Recovery (stamina per sec)",  group: "Stamina",   min: 1,    max: 1.8,  unit: "x" },
  { id: "staminaCostMult",         label: "Punch stamina cost",          group: "Stamina",   min: 1,    max: 0.8,  unit: "x", note: "lower is better" },
  { id: "fullGuardRegenMult",      label: "Recovery while fully guarding", group: "Stamina", min: 0.75, max: 0.90, unit: "x" },
  { id: "damageMult",              label: "Punching power",              group: "Offense",   min: 1,    max: 3.5,  unit: "x" },
  { id: "critChance",              label: "Crit chance",                 group: "Offense",   min: 1,    max: 1.5,  unit: "x" },
  { id: "defenseMult",             label: "Toughness (damage taken)",    group: "Defense",   min: 1,    max: 0.7,  unit: "x", note: "lower is better" },
  { id: "blockReductionHead",      label: "Head block absorption",       group: "Defense",   min: 0.40, max: 0.70, unit: "frac" },
  { id: "blockReductionBody",      label: "Body block absorption",       group: "Defense",   min: 0.30, max: 0.50, unit: "frac" },
  { id: "maxBlockDuration",        label: "Block stamina (hold time)",   group: "Defense",   min: 20,   max: 180,  unit: "s" },
  { id: "blockRegenPenaltyDuration", label: "Block regen penalty",       group: "Defense",   min: 0.25, max: 0,    unit: "s", note: "lower is better" },
  { id: "autoGuardBase",           label: "Auto-guard base duration",    group: "Defense",   min: 10,   max: 45,   unit: "s" },
  { id: "guardRaiseMs",            label: "Guard raise time",            group: "Defense",   min: 50,   max: 20,   unit: "ms", note: "lower is better" },
  { id: "telegraphBlinkChance",    label: "Telegraph eye-blink chance",  group: "Telegraph", min: 0.75, max: 0.50, unit: "frac", note: "visual only" },
  { id: "feintFailChance",         label: "Feint failure chance",        group: "Telegraph", min: 0.60, max: 0.30, unit: "frac", note: "lower is better" },
  // Share of the gas tank the level curve already gave the AI, not an absolute
  // points figure — see the careerStaminaTier block in startFight. 1.0 is the
  // same tank a sparring partner of that level carries.
  { id: "careerStaminaShareJourneyman", label: "Career AI gas tank — journeyman", group: "AI", min: 0.70, max: 0.80, unit: "frac" },
  { id: "careerStaminaShareContender",  label: "Career AI gas tank — contender",  group: "AI", min: 0.78, max: 0.88, unit: "frac" },
  { id: "careerStaminaShareElite",      label: "Career AI gas tank — elite",      group: "AI", min: 0.86, max: 0.94, unit: "frac" },
  { id: "careerStaminaShareChampion",   label: "Career AI gas tank — champion",   group: "AI", min: 0.92, max: 1.00, unit: "frac" },
  { id: "aiComboBoost",            label: "AI combo-rate boost",         group: "AI",        min: 0.85, max: 1.15, unit: "x" },
  { id: "aiChargeArmTimer",        label: "AI charge arm window",        group: "AI",        min: 2,    max: 4,    unit: "s" },
  { id: "aiAdaptationRate",        label: "AI adaptation rate",          group: "AI",        min: 0.20, max: 0.70, unit: "x" },
];

export type PointStat = "Power" | "Speed" | "Defense" | "Stamina" | "Focus";

export interface PointCoefDef {
  id: string;
  label: string;
  stat: PointStat;
  value: number;
  unit: string;
  note?: string;
  /**
   * The resulting effect at a given number of points, so the tuning screen can
   * show what a coefficient actually buys instead of a bare number. Reads the
   * live caps because most stats stop paying out before 1000 points.
   */
  atPoints: (coef: number, pts: number, caps: ScalingCaps) => number;
}

/** Points → ramp fraction, for the stats that top out at `maxSp`. */
const tFull = (pts: number, caps: ScalingCaps) => Math.min(1, pts / caps.maxSp);
/** Speed is soft-capped well below `maxSp`, so its fraction can exceed 1. */
const tSpeed = (pts: number, caps: ScalingCaps) => Math.min(pts, caps.speedSoftCap) / caps.speedDivisor;
/** Stamina regen has its own, lower cap. */
const tRegen = (pts: number, caps: ScalingCaps) => Math.min(caps.staminaRegenCap, pts) / caps.staminaRegenDivisor;

function autoGuardSeconds(coef: number, ramp: number, pts: number, caps: ScalingCaps): number {
  const t = tFull(pts, caps);
  return t * coef * (1 + ramp * Math.min(1, Math.max(0, (t - 0.2) / 0.8)));
}

/** Speed-stat punch ratio: `zero` at 0 pts rising linearly to `cap` at the soft cap, flat beyond. */
export function speedPunchAt(zero: number, cap: number, pts: number, caps: ScalingCaps): number {
  const z = Math.max(0.1, zero);
  const r = Math.max(z, cap);
  return z + (r - z) * Math.min(1, Math.max(0, pts / Math.max(1, caps.speedSoftCap)));
}

export const POINT_COEF_DEFS: PointCoefDef[] = [
  { id: "powerDamage", label: "Damage multiplier (quadratic)", stat: "Power", value: 5, unit: "x", note: "both corners, identical",
    atPoints: (c, p, k) => 1 + c * tFull(p, k) ** 2 },
  { id: "speedPunchAtZero", label: "Punch speed at 0 pts (whole punch incl. telegraph)", stat: "Speed", value: 1.3, unit: "x", note: "linear up to the soft-cap value",
    atPoints: (c, p, k) => speedPunchAt(c, pointCoef("speedPunchAtCap", 1.7), p, k) },
  { id: "speedPunchAtCap", label: "Punch speed at the soft cap (whole punch incl. telegraph)", stat: "Speed", value: 1.7, unit: "x", note: "linear from the 0-pt value, flat past the cap",
    atPoints: (c, p, k) => speedPunchAt(pointCoef("speedPunchAtZero", 1.3), c, p, k) },
  { id: "speedMove", label: "Move speed", stat: "Speed", value: 0.15, unit: "x",
    atPoints: (c, p, k) => 1 + tSpeed(p, k) * c },
  { id: "speedDuck", label: "Duck speed", stat: "Speed", value: 0.6, unit: "x",
    atPoints: (c, p, k) => 1 + tSpeed(p, k) * c },
  { id: "speedChaseOnTelegraph", label: "Chase speed while you telegraph", stat: "Speed", value: 0.65, unit: "x", note: "AI only, ignores the soft cap",
    atPoints: (c, p, k) => 1.2 + Math.min(1, p / k.maxSp) * c },
  { id: "defenseBlock", label: "Block strength", stat: "Defense", value: 0.6, unit: "x",
    atPoints: (c, p, k) => 1 + tFull(p, k) * c },
  { id: "defenseCritResist", label: "Crit resistance", stat: "Defense", value: 0.27, unit: "x", note: "lower is better",
    atPoints: (c, p, k) => 1 - tFull(p, k) * c },
  { id: "defenseAutoGuard", label: "Auto-guard seconds added", stat: "Defense", value: 40.5, unit: "s",
    atPoints: (c, p, k) => autoGuardSeconds(c, pointCoef("defenseAutoGuardRamp", 9), p, k) },
  { id: "defenseAutoGuardRamp", label: "Auto-guard late-ramp factor", stat: "Defense", value: 9, unit: "s",
    atPoints: (c, p, k) => autoGuardSeconds(pointCoef("defenseAutoGuard", 40.5), c, p, k) },
  { id: "staminaRegen", label: "Stamina regen", stat: "Stamina", value: 0.6, unit: "x",
    atPoints: (c, p, k) => 1 + tRegen(p, k) * c },
  { id: "staminaPool", label: "Stamina pool", stat: "Stamina", value: 0.24, unit: "x",
    atPoints: (c, p, k) => 1 + tFull(p, k) * c },
  { id: "focusCrit", label: "Crit damage", stat: "Focus", value: 1.8, unit: "x",
    atPoints: (c, p, k) => 1 + tFull(p, k) * c },
  { id: "focusStun", label: "Stun power", stat: "Focus", value: 1.8, unit: "x",
    atPoints: (c, p, k) => 1 + tFull(p, k) * c },
];

/**
 * Every fighter-vs-fighter level-gap effect in the engine, one row each.
 *
 * These are NOT the level ramps: a ramp is how strong a fighter is at their own
 * level, a gap is how much out-levelling the other guy is worth on top of that.
 * The two were previously tangled together as inline magic numbers spread over
 * three engine functions.
 */
export interface LevelGapDef {
  id: string;
  label: string;
  /** Per level of advantage, applied to the higher-level fighter. */
  ahead: number;
  /** Per level of deficit, applied to the lower-level fighter. 0 = that side is off. */
  behind: number;
  unit: string;
  note?: string;
}

export const LEVEL_GAP_DEFS: LevelGapDef[] = [
  { id: "gapDamage",       label: "Punching power",             ahead: 0.025,  behind: 0,      unit: "x/lv",    note: "set at the bell" },
  { id: "gapPowerBypass",  label: "Power-sway guard bypass",    ahead: 0.02,   behind: 0,      unit: "frac/lv" },
  { id: "gapMiniStun",     label: "Off-balance mini-stun",      ahead: 0.005,  behind: 0,      unit: "frac/lv" },
  { id: "gapStanceSwitch", label: "Stance-switch rhythm break", ahead: 0.005,  behind: 0.005,  unit: "frac/lv", note: "player only" },
  { id: "gapFocusWhiff",   label: "Focus miss reduction",       ahead: 0.0025, behind: 0.002,  unit: "frac/lv", note: "player only" },
  { id: "gapFocusBypass",  label: "Focus punch-through block",  ahead: 0.0025, behind: 0.002,  unit: "frac/lv", note: "player only" },
  { id: "gapBlockRoll",    label: "Block / dodge roll",         ahead: 0.0012, behind: 0.0025, unit: "frac/lv" },
  { id: "gapEvade",        label: "Defensive evasion",          ahead: 0.001,  behind: 0.002,  unit: "frac/lv", note: "player only" },
];

export interface ScalingCaps {
  /** Stat points at which Power / Defense / Focus / stamina-pool reach full effect. */
  maxSp: number;
  /** Stamina points past this add no regen. */
  staminaRegenCap: number;
  /** Divisor turning stamina points into the regen fraction. */
  staminaRegenDivisor: number;
  /** Speed points past this stop helping (expressed as a relative handicap instead). */
  speedSoftCap: number;
  /** Divisor turning speed points into the speed fraction. */
  speedDivisor: number;
  /**
   * How hard a past-soft-cap opponent drags a slower fighter down. 1 = the full
   * relative handicap, 0 = none (the soft cap alone still applies), >1 widens it.
   */
  speedHandicapStrength: number;
}

export const DEFAULT_CAPS: ScalingCaps = {
  maxSp: 1000,
  staminaRegenCap: 250,
  staminaRegenDivisor: 200,
  speedSoftCap: 220,
  speedDivisor: 200,
  speedHandicapStrength: 1,
};

/** Caps that are meaningful at 0; every other cap must stay positive. */
const CAPS_ALLOWING_ZERO = new Set<keyof ScalingCaps>(["speedHandicapStrength"]);

export interface ScalingConfig {
  /** Level at which every ramp reaches its end value. 100 = the historical curve. */
  rampMaxLevel: number;
  /** Per-effect level-gap coefficients, keyed by LEVEL_GAP_DEFS id. */
  gaps: Record<string, { ahead: number; behind: number }>;
  ramps: Record<string, { min: number; max: number }>;
  points: Record<string, number>;
  caps: ScalingCaps;
}

export function defaultScalingConfig(): ScalingConfig {
  const ramps: Record<string, { min: number; max: number }> = {};
  for (const d of LEVEL_RAMP_DEFS) ramps[d.id] = { min: d.min, max: d.max };
  const points: Record<string, number> = {};
  for (const p of POINT_COEF_DEFS) points[p.id] = p.value;
  const gaps: Record<string, { ahead: number; behind: number }> = {};
  for (const g of LEVEL_GAP_DEFS) gaps[g.id] = { ahead: g.ahead, behind: g.behind };
  return { rampMaxLevel: 100, gaps, ramps, points, caps: { ...DEFAULT_CAPS } };
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * Point-coefficient defaults that shipped and were later changed in code. The
 * whole config is persisted on any edit, so a stored value equal to one of
 * these is the old default riding along, and the new default should win.
 */
const RETIRED_POINT_DEFAULTS: Record<string, number[]> = {
  speedPunchAtCap: [1.904],
};

/** The gap effects the retired single master scale used to multiply. Migration only. */
const LEGACY_MASTER_SCALE_IDS = [
  "gapPowerBypass", "gapMiniStun", "gapStanceSwitch", "gapCrit",
  "gapFocusWhiff", "gapFocusBypass", "gapBlockRoll", "gapEvade",
];

/**
 * Merges saved values over the defaults one field at a time. A config written
 * before a new ramp existed simply picks up that ramp's default rather than
 * collapsing it to zero.
 */
function mergeConfig(raw: unknown): ScalingConfig {
  const base = defaultScalingConfig();
  if (!raw || typeof raw !== "object") return base;
  const src = raw as Partial<ScalingConfig>;
  if (isNum(src.rampMaxLevel) && src.rampMaxLevel >= 2) base.rampMaxLevel = src.rampMaxLevel;
  // Legacy shape: a single master gap scale shipped briefly before the per-effect
  // registry replaced it. Fold a saved value into the defaults so anyone who had
  // dialled it keeps the fight they tuned. Only the effects that scale actually
  // reached are migrated — move speed and punching power were never under it, so
  // multiplying them here would retune a bout the player never changed.
  const legacyScale = (raw as { levelDiffScale?: unknown }).levelDiffScale;
  if (!src.gaps && isNum(legacyScale) && legacyScale >= 0) {
    for (const id of LEGACY_MASTER_SCALE_IDS) {
      const g = base.gaps[id];
      if (!g) continue;
      g.ahead *= legacyScale;
      g.behind *= legacyScale;
    }
  }
  if (src.gaps && typeof src.gaps === "object") {
    for (const g of LEVEL_GAP_DEFS) {
      const o = (src.gaps as Record<string, unknown>)[g.id];
      if (o && typeof o === "object") {
        const { ahead, behind } = o as { ahead?: unknown; behind?: unknown };
        if (isNum(ahead)) base.gaps[g.id].ahead = ahead;
        if (isNum(behind)) base.gaps[g.id].behind = behind;
      }
    }
  }
  if (src.ramps && typeof src.ramps === "object") {
    for (const d of LEVEL_RAMP_DEFS) {
      const o = (src.ramps as Record<string, unknown>)[d.id];
      if (o && typeof o === "object") {
        const { min, max } = o as { min?: unknown; max?: unknown };
        if (isNum(min)) base.ramps[d.id].min = min;
        if (isNum(max)) base.ramps[d.id].max = max;
      }
    }
  }
  if (src.points && typeof src.points === "object") {
    for (const p of POINT_COEF_DEFS) {
      const v = (src.points as Record<string, unknown>)[p.id];
      // A saved copy of a since-retuned default is the old default, not a choice.
      if (isNum(v) && !RETIRED_POINT_DEFAULTS[p.id]?.includes(v)) base.points[p.id] = v;
    }
  }
  if (src.caps && typeof src.caps === "object") {
    const rawCaps = src.caps as unknown as Record<string, unknown>;
    for (const k of Object.keys(base.caps) as (keyof ScalingCaps)[]) {
      const v = rawCaps[k];
      if (isNum(v) && (v > 0 || (v === 0 && CAPS_ALLOWING_ZERO.has(k)))) base.caps[k] = v;
    }
  }
  return base;
}

let cache: ScalingConfig | null = null;

/** Cached, synchronous read — safe to call from inside the fight loop. */
export function getScaling(): ScalingConfig {
  if (cache) return cache;
  let raw: unknown = null;
  try {
    const s = localStorage.getItem(SCALING_LS_KEY);
    if (s) raw = JSON.parse(s);
  } catch {}
  cache = mergeConfig(raw);
  return cache;
}

function persist(cfg: ScalingConfig): void {
  cache = cfg;
  try { localStorage.setItem(SCALING_LS_KEY, JSON.stringify(cfg)); } catch {}
}

/** Re-read from storage — used after a save file is imported. */
export function reloadScaling(): ScalingConfig {
  cache = null;
  return getScaling();
}

export function setRampMaxLevel(level: number): void {
  if (!isNum(level) || level < 2) return;
  persist({ ...getScaling(), rampMaxLevel: level });
}

export function setGapField(id: string, field: "ahead" | "behind", value: number): void {
  if (!isNum(value)) return;
  const cfg = getScaling();
  const cur = cfg.gaps[id];
  if (!cur) return;
  const v = Math.min(GAP_COEF_LIMIT, Math.max(-GAP_COEF_LIMIT, value));
  persist({ ...cfg, gaps: { ...cfg.gaps, [id]: { ...cur, [field]: v } } });
}

export function setRampField(id: string, field: "min" | "max", value: number): void {
  if (!isNum(value)) return;
  const cfg = getScaling();
  const cur = cfg.ramps[id];
  if (!cur) return;
  persist({ ...cfg, ramps: { ...cfg.ramps, [id]: { ...cur, [field]: value } } });
}

export function setPointCoef(id: string, value: number): void {
  if (!isNum(value)) return;
  const cfg = getScaling();
  if (!(id in cfg.points)) return;
  persist({ ...cfg, points: { ...cfg.points, [id]: value } });
}

export function setCap(key: keyof ScalingCaps, value: number): void {
  if (!isNum(value)) return;
  if (value < 0 || (value === 0 && !CAPS_ALLOWING_ZERO.has(key))) return;
  const cfg = getScaling();
  persist({ ...cfg, caps: { ...cfg.caps, [key]: value } });
}

export function resetScaling(): void {
  persist(defaultScalingConfig());
}

/**
 * The one level curve. Passing a ramp id lets the tuning screen override the
 * endpoints; the `min`/`max` arguments stay as the in-code default so the
 * engine still reads correctly on its own.
 */
export function levelScale(level: number, min: number, max: number, id?: string): number {
  const cfg = getScaling();
  if (id) {
    const o = cfg.ramps[id];
    if (o) { min = o.min; max = o.max; }
  }
  const top = Math.max(2, cfg.rampMaxLevel);
  const t = Math.max(0, Math.min(1, (level - 1) / (top - 1)));
  return min + (max - min) * t;
}

/** Progress along the level ramp, 0 at level 1 and 1 once it tops out. */
export function levelT(level: number): number {
  const top = Math.max(2, getScaling().rampMaxLevel);
  return Math.max(0, Math.min(1, (level - 1) / (top - 1)));
}

/**
 * Hard limit on a single gap coefficient. 1.0 already means "100% per level of
 * gap", so this only exists to swallow a typo (100 instead of 0.100) rather than
 * to express a balance opinion. Negatives stay legal: a negative Behind is a
 * deliberate comeback bonus for the lower-level fighter.
 */
export const GAP_COEF_LIMIT = 1;

/**
 * Bounds on a start-of-fight gap multiplier.
 *
 * Move speed and punching power are the only two gap effects that feed straight
 * into the physics instead of into an already-clamped probability, so they are
 * the only two where an editable coefficient can produce a genuinely broken
 * fight rather than merely a strong one. A signed coefficient over a large gap
 * compounds fast in both directions, hence a ceiling as well as a floor.
 */
export const GAP_MULT_MIN = 0.05;
export const GAP_MULT_MAX = 10;
export const clampGapMult = (v: number): number =>
  Math.min(GAP_MULT_MAX, Math.max(GAP_MULT_MIN, v));

const GAP_FALLBACK = new Map(LEVEL_GAP_DEFS.map(d => [d.id, { ahead: d.ahead, behind: d.behind }]));

/**
 * The signed level-gap adjustment for one effect.
 *
 * Pass the raw difference from the point of view of the fighter being scored
 * (`mine - theirs`). Positive uses the `ahead` coefficient, negative the
 * `behind` one, so an effect can reward a level advantage harder than it
 * punishes a deficit. A `behind` of 0 leaves that side switched off, which is
 * where five of the rows start.
 *
 * Every engine expression that reads one fighter's level *against the other's*
 * must come through here — that is what keeps the whole axis tunable and lets
 * a row be zeroed out to remove that effect from the game.
 */
export function levelGapAdj(id: string, diff: number): number {
  const g = getScaling().gaps[id] ?? GAP_FALLBACK.get(id);
  if (!g) return 0;
  return diff >= 0 ? diff * g.ahead : diff * g.behind;
}

/** Stat-point coefficient lookup with the in-code default as the fallback. */
export function pointCoef(id: string, fallback: number): number {
  const v = getScaling().points[id];
  return isNum(v) ? v : fallback;
}
