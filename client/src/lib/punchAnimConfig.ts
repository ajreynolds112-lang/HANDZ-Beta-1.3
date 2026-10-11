import { PUNCH_CONFIGS } from "@/game/types";

export type PunchType = "jab" | "cross" | "leftHook" | "rightHook" | "leftUppercut" | "rightUppercut";

export interface PunchAnimParams {
  launchDelayMult: number;
  armSpeedMult: number;
  lingerMult: number;
  retractionMult: number;
  lockoutMs: number;
  angle: number;
  reachMult: number;
  arcAmplitude: number;
  hookReachMult: number;
  dropDepth: number;
  riseHeight: number;
  dropPhase: number;
  riseArcFactor: number;
  distanceMult: number;
  /** 3D: how far the body leans/steps forward into this punch (×default; 0 = upright). Visual only. */
  leanMult: number;
  /** 3D shoulder-joint rotation (degrees about the body's x/y/z) eased in when the punch starts, out after retraction. */
  shoulderX: number;
  shoulderY: number;
  shoulderZ: number;
  /** Uppercuts: how far (degrees) the shoulder tilts the arm up approaching the peak — the U's rising wall. */
  uLiftDeg: number;
  /** Actual gameplay hit range in pixels used by hit detection. Independent of reachMult/distanceMult, which are visual-only. */
  hitRangePx: number;
  /** 3D: how close (cm) the glove's surface must get to the opponent's head or torso surface to land. */
  hitBoxCm: number;
  /** Per-face hit box extensions (cm), in the glove's bind frame: x forward, y up, z lateral. */
  hitBoxPX: number;
  hitBoxNX: number;
  hitBoxPY: number;
  hitBoxNY: number;
  hitBoxPZ: number;
  hitBoxNZ: number;
  /** Hit box rotation (degrees) about the glove's x/y/z. */
  hitBoxRotX: number;
  hitBoxRotY: number;
  hitBoxRotZ: number;
  /** Base damage dealt by this punch before any fighter/archetype/refinement multipliers. */
  damage: number;
  /** Base stamina cost of throwing this punch before any fighter multipliers. */
  staminaCost: number;
}

export type PunchAnimConfig = Record<PunchType, PunchAnimParams>;

export const DEFAULT_PARAMS: Omit<PunchAnimParams, "hitRangePx" | "damage" | "staminaCost"> = {
  launchDelayMult: 1.0,
  armSpeedMult: 1.0,
  lingerMult: 1.0,
  retractionMult: 1.0,
  lockoutMs: 200,
  angle: -13,
  reachMult: 1.0,
  arcAmplitude: 15,
  hookReachMult: 0.8,
  dropDepth: 9,
  riseHeight: 22,
  dropPhase: 0.32,
  riseArcFactor: 0.85,
  distanceMult: 1.0,
  leanMult: 1.0,
  shoulderX: 0,
  shoulderY: 0,
  shoulderZ: 0,
  uLiftDeg: 15,
  hitBoxCm: 10,
  hitBoxPX: 0, hitBoxNX: 0, hitBoxPY: 0, hitBoxNY: 0, hitBoxPZ: 0, hitBoxNZ: 0,
  hitBoxRotX: 0, hitBoxRotY: 0, hitBoxRotZ: 0,
};

export const DEFAULT_PUNCH_ANIM_CONFIG: PunchAnimConfig = {
  jab: { ...DEFAULT_PARAMS, hitRangePx: PUNCH_CONFIGS.jab.range, damage: PUNCH_CONFIGS.jab.damage, staminaCost: PUNCH_CONFIGS.jab.staminaCost },
  cross: { ...DEFAULT_PARAMS, hitRangePx: PUNCH_CONFIGS.cross.range, damage: PUNCH_CONFIGS.cross.damage, staminaCost: PUNCH_CONFIGS.cross.staminaCost },
  leftHook: { ...DEFAULT_PARAMS, hitRangePx: PUNCH_CONFIGS.leftHook.range, damage: PUNCH_CONFIGS.leftHook.damage, staminaCost: PUNCH_CONFIGS.leftHook.staminaCost },
  rightHook: { ...DEFAULT_PARAMS, hitRangePx: PUNCH_CONFIGS.rightHook.range, damage: PUNCH_CONFIGS.rightHook.damage, staminaCost: PUNCH_CONFIGS.rightHook.staminaCost },
  leftUppercut: { ...DEFAULT_PARAMS, hitRangePx: PUNCH_CONFIGS.leftUppercut.range, damage: PUNCH_CONFIGS.leftUppercut.damage, staminaCost: PUNCH_CONFIGS.leftUppercut.staminaCost },
  rightUppercut: { ...DEFAULT_PARAMS, hitRangePx: PUNCH_CONFIGS.rightUppercut.range, damage: PUNCH_CONFIGS.rightUppercut.damage, staminaCost: PUNCH_CONFIGS.rightUppercut.staminaCost },
};

const LS_KEY = "handz_punch_anim";

export type HitBoxKey = "hitBoxCm" | "hitBoxPX" | "hitBoxNX" | "hitBoxPY" | "hitBoxNY" | "hitBoxPZ" | "hitBoxNZ" | "hitBoxRotX" | "hitBoxRotY" | "hitBoxRotZ";
/** Set a hit box field: size (hitBoxCm) is shared by all six punches (jab's copy canonical); face drags and rotation are per punch. */
export function withHitBoxField(c: PunchAnimConfig, punch: PunchType, key: HitBoxKey, v: number): PunchAnimConfig {
  const next = { ...c };
  for (const k of key === "hitBoxCm" ? Object.keys(next) as PunchType[] : [punch]) next[k] = { ...next[k], [key]: v };
  return next;
}
function shareHitBox(c: PunchAnimConfig): PunchAnimConfig {
  for (const k of Object.keys(c) as PunchType[]) c[k].hitBoxCm = c.jab.hitBoxCm;
  return c;
}

export function loadPunchAnimConfig(): PunchAnimConfig {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return JSON.parse(JSON.stringify(DEFAULT_PUNCH_ANIM_CONFIG));
    const saved = JSON.parse(raw) as Partial<PunchAnimConfig>;
    const result: PunchAnimConfig = JSON.parse(JSON.stringify(DEFAULT_PUNCH_ANIM_CONFIG));
    for (const k of Object.keys(result) as PunchType[]) {
      if (saved[k]) result[k] = { ...DEFAULT_PUNCH_ANIM_CONFIG[k], ...saved[k] };
    }
    return shareHitBox(result);
  } catch {
    return JSON.parse(JSON.stringify(DEFAULT_PUNCH_ANIM_CONFIG));
  }
}

export function savePunchAnimConfig(config: PunchAnimConfig): void {
  localStorage.setItem(LS_KEY, JSON.stringify(config));
  _cache = null;
}

export function resetPunchAnimConfig(): void {
  localStorage.removeItem(LS_KEY);
  _cache = null;
}

export function hasSavedPunchAnimConfig(): boolean {
  return localStorage.getItem(LS_KEY) !== null;
}

let _cache: PunchAnimConfig | null = null;

export function getActivePunchAnimConfig(): PunchAnimConfig {
  if (!_cache) _cache = loadPunchAnimConfig();
  return _cache;
}

export function invalidatePunchAnimCache(): void {
  _cache = null;
}
