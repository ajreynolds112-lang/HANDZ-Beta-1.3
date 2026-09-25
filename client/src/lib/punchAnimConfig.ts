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
  /** Actual gameplay hit range in pixels used by hit detection. Independent of reachMult/distanceMult, which are visual-only. */
  hitRangePx: number;
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

export function loadPunchAnimConfig(): PunchAnimConfig {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return JSON.parse(JSON.stringify(DEFAULT_PUNCH_ANIM_CONFIG));
    const saved = JSON.parse(raw) as Partial<PunchAnimConfig>;
    const result: PunchAnimConfig = JSON.parse(JSON.stringify(DEFAULT_PUNCH_ANIM_CONFIG));
    for (const k of Object.keys(result) as PunchType[]) {
      if (saved[k]) result[k] = { ...DEFAULT_PUNCH_ANIM_CONFIG[k], ...saved[k] };
    }
    return result;
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
