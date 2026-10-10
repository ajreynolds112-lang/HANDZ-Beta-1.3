/**
 * 3D stand height: how far the hips sit down into the knees when standing,
 * as a fraction of leg length (0 = legs straight). Tuned on the Neural Network
 * screen; the pose solver reads it every frame.
 */
const KEY = "handz_stand_height_config";

export interface StandHeightConfig { standSit: number }
export const DEFAULT_STAND_HEIGHT_CONFIG: StandHeightConfig = { standSit: 0.006 };
export const STAND_SIT_MIN = 0;
export const STAND_SIT_MAX = 0.3;

const clampSit = (v: unknown) =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(STAND_SIT_MAX, Math.max(STAND_SIT_MIN, v)) : DEFAULT_STAND_HEIGHT_CONFIG.standSit;

let cache: StandHeightConfig | null = null;

export function getStandHeightConfig(): StandHeightConfig {
  if (cache) return cache;
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(KEY) : null;
    cache = { standSit: clampSit(raw ? JSON.parse(raw).standSit : undefined) };
  } catch {
    cache = { ...DEFAULT_STAND_HEIGHT_CONFIG };
  }
  return cache;
}

export function saveStandHeightConfig(cfg: StandHeightConfig): StandHeightConfig {
  cache = { standSit: clampSit(cfg.standSit) };
  localStorage.setItem(KEY, JSON.stringify(cache));
  return cache;
}

export function invalidateStandHeightCache(): void {
  cache = null;
}
