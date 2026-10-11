/**
 * Per-sound 7-band EQ (dB) and fine pitch (semitones) for every recorded sound.
 * Tuned on the Neural Network screen; travels in the parameter file and ships
 * as the published default like every other tunable.
 */
const KEY = "handz_sound_eq";

export const EQ_BANDS = [60, 150, 400, 1000, 2500, 6000, 12000] as const;
export const EQ_DB_MAX = 12;
export const PITCH_MAX = 12;

/** `file`: URL of an uploaded replacement recording (served from data/sounds). */
export interface SoundEq { gains: number[]; pitch: number; file?: string }
export type SoundEqConfig = Record<string, SoundEq>;

const num = (v: unknown, max: number) => (typeof v === "number" && Number.isFinite(v) ? Math.max(-max, Math.min(max, v)) : 0);
export const flatEq = (): SoundEq => ({ gains: EQ_BANDS.map(() => 0), pitch: 0 });
export const isFlat = (e: SoundEq) => !e.file && e.pitch === 0 && e.gains.every(g => g === 0);

function clean(raw: unknown): SoundEqConfig {
  const out: SoundEqConfig = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [id, v] of Object.entries(raw as Record<string, Partial<SoundEq>>)) {
    const e: SoundEq = { gains: EQ_BANDS.map((_, i) => num(Array.isArray(v?.gains) ? v.gains[i] : 0, EQ_DB_MAX)), pitch: num(v?.pitch, PITCH_MAX) };
    if (typeof v?.file === "string" && /^\/sound-files\/[\w.-]+$/.test(v.file)) e.file = v.file;
    if (!isFlat(e)) out[id] = e;
  }
  return out;
}

let cache: SoundEqConfig | null = null;

export function getSoundEqConfig(): SoundEqConfig {
  if (cache) return cache;
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(KEY) : null;
    cache = clean(raw ? JSON.parse(raw) : null);
  } catch {
    cache = {};
  }
  return cache;
}

export function saveSoundEqConfig(cfg: SoundEqConfig): SoundEqConfig {
  cache = clean(cfg);
  localStorage.setItem(KEY, JSON.stringify(cache));
  return cache;
}

export function invalidateSoundEqCache(): void {
  cache = null;
}
