/**
 * Daily Reward config — the chests a career is handed once per calendar day,
 * decided by the player's current rank.
 *
 * Shape deliberately mirrors the crate-odds model used by fight rewards: six
 * percentage sliders that always total 100, plus a per-band chest count. The
 * count decides how many chests the day pays out; the odds decide which crate
 * each of those chests is.
 *
 * Rank bands are the same bounds as Roster Generation (`buildBandBounds`), so a
 * row here lines up with the row that generates that stretch of the ladder.
 * It lives in its own localStorage key rather than inside the Roster Generation
 * blob because this tab auto-saves on every edit while that one sits behind an
 * explicit Save button — sharing a blob would let one commit the other's
 * half-finished edits.
 */
import { CRATE_IDS, isCrateId, type CrateId } from "./cratesConfig";
import { buildBandBounds } from "./rosterGenConfig";

/** Percentage odds per crate; the six values always add up to 100. */
export type CrateChances = Record<CrateId, number>;

export interface DailyRewardBand {
  /** Numerically higher (worse) rank bound, inclusive. */
  hiRank: number;
  /** Numerically lower (better) rank bound, inclusive. */
  loRank: number;
  /** Per-crate chance (%) that a chest is that crate. Sums to 100. */
  chances: CrateChances;
  /** How many chests this band is handed per day (0–999; 0 = none). */
  count: number;
}

export interface DailyRewardConfig {
  bands: DailyRewardBand[];
  /** Rank 1 champion is configured on its own, exactly like the fight crate odds. */
  rank1Chances: CrateChances;
  rank1Count: number;
}

/** Most chests a single day can hand out. */
export const DAILY_CRATE_COUNT_MAX = 999;

const STORAGE_KEY = "handz_daily_reward_config";

export function clampDailyCrateCount(v: unknown): number {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.round(v) : 0;
  return Math.max(0, Math.min(DAILY_CRATE_COUNT_MAX, n));
}

function zeroChances(): CrateChances {
  return CRATE_IDS.reduce((acc, id) => { acc[id] = 0; return acc; }, {} as CrateChances);
}

/** An even 100-point split across the given crates (remainder to the first). */
export function chancesFromCrateList(list: CrateId[]): CrateChances {
  const out = zeroChances();
  const ids = list.filter(isCrateId);
  if (ids.length === 0) return out;
  const each = Math.floor(100 / ids.length);
  for (const id of ids) out[id] = each;
  out[ids[0]] += 100 - each * ids.length;
  return out;
}

/**
 * Coerce stored/edited odds into six non-negative integers summing to exactly
 * 100. Anything unusable (missing, all zero, NaN) falls back to `fallback`.
 */
export function normalizeCrateChances(raw: unknown, fallback: CrateChances): CrateChances {
  const src = (raw ?? {}) as Record<string, unknown>;
  const vals = zeroChances();
  let total = 0;
  for (const id of CRATE_IDS) {
    const v = src[id];
    const n = typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
    vals[id] = n;
    total += n;
  }
  if (total <= 0) return { ...fallback };
  const out = zeroChances();
  let assigned = 0;
  for (const id of CRATE_IDS) {
    out[id] = Math.round((vals[id] / total) * 100);
    assigned += out[id];
  }
  // Rounding drift lands on the biggest share so the six always total 100.
  if (assigned !== 100) {
    const biggest = CRATE_IDS.reduce((a, b) => (out[b] > out[a] ? b : a), CRATE_IDS[0]);
    out[biggest] = Math.max(0, out[biggest] + (100 - assigned));
  }
  return out;
}

/**
 * Move one crate to `next`% and spread the remaining 100−next across the other
 * five in proportion to what they hold now (evenly when they're all at zero).
 * Largest-remainder allocation, so the six values are always non-negative
 * integers totalling exactly 100 — no intermediate slider state can drift off.
 */
export function rebalanceCrateChances(chances: CrateChances, moved: CrateId, next: number): CrateChances {
  const target = Math.max(0, Math.min(100, Math.round(next)));
  const others = CRATE_IDS.filter(id => id !== moved);
  const otherTotal = others.reduce((sum, id) => sum + Math.max(0, chances?.[id] ?? 0), 0);
  const remainder = 100 - target;

  const exact = others.map(id => (otherTotal > 0
    ? (Math.max(0, chances?.[id] ?? 0) / otherTotal) * remainder
    : remainder / others.length));
  const vals = exact.map(v => Math.floor(v));
  let left = Math.round(remainder - vals.reduce((a, b) => a + b, 0));
  const byFrac = exact
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac);
  for (let k = 0; left > 0; k++, left--) vals[byFrac[k % byFrac.length].i] += 1;

  const out = { ...chances, [moved]: target } as CrateChances;
  others.forEach((id, i) => { out[id] = vals[i]; });
  return out;
}

/** Default crate a rank band's daily chest rolls — richer the higher you climb. */
function defaultDailyCrates(rank: number): CrateId[] {
  if (rank <= 1) return ["goat"];
  if (rank <= 9) return ["undisputed"];
  if (rank <= 49) return ["champion"];
  if (rank <= 199) return ["elite"];
  if (rank <= 499) return ["contender"];
  return ["journeyman"];
}

/**
 * Defaults hand every rank one chest a day of its own tier. The feature is on
 * out of the box — a band set to 0 chests is how you switch it off.
 */
export function buildDefaultDailyRewardConfig(): DailyRewardConfig {
  const bands: DailyRewardBand[] = buildBandBounds().map(({ hiRank, loRank }) => {
    const mid = Math.round((hiRank + loRank) / 2);
    return { hiRank, loRank, chances: chancesFromCrateList(defaultDailyCrates(mid)), count: 1 };
  });
  return {
    bands,
    rank1Chances: chancesFromCrateList(defaultDailyCrates(1)),
    rank1Count: 1,
  };
}

// Parsed-config cache keyed on the raw string, so the daily check doesn't
// re-parse while a save from the editor is still picked up immediately.
let cachedRaw: string | null = null;
let cachedCfg: DailyRewardConfig | null = null;

/** The saved config, rebuilt against the current band layout. */
export function loadDailyRewardConfig(): DailyRewardConfig {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(STORAGE_KEY) : null;
    if (!raw) { cachedRaw = null; cachedCfg = null; return buildDefaultDailyRewardConfig(); }
    if (raw === cachedRaw && cachedCfg) return cachedCfg;
    const parsed = JSON.parse(raw) as Partial<DailyRewardConfig>;
    const defaults = buildDefaultDailyRewardConfig();
    if (!parsed || !Array.isArray(parsed.bands) || parsed.bands.length === 0) return defaults;
    // Rebuild off the canonical band list so a stored config from an older band
    // layout can never drop or duplicate a rank range.
    const saved = new Map(parsed.bands.map(b => [`${b.hiRank}-${b.loRank}`, b]));
    const bands = defaults.bands.map(def => {
      const b = saved.get(`${def.hiRank}-${def.loRank}`);
      if (!b) return def;
      return {
        hiRank: def.hiRank,
        loRank: def.loRank,
        chances: normalizeCrateChances(b.chances, def.chances),
        count: clampDailyCrateCount(b.count),
      };
    });
    const cfg: DailyRewardConfig = {
      bands,
      rank1Chances: normalizeCrateChances(parsed.rank1Chances, defaults.rank1Chances),
      rank1Count: clampDailyCrateCount(parsed.rank1Count),
    };
    cachedRaw = raw;
    cachedCfg = cfg;
    return cfg;
  } catch {
    return buildDefaultDailyRewardConfig();
  }
}

export function saveDailyRewardConfig(cfg: DailyRewardConfig): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
  } catch {}
  cachedRaw = null;
  cachedCfg = null;
}

export function clearDailyRewardConfig(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {}
  cachedRaw = null;
  cachedCfg = null;
}

/**
 * The band covering a rank, or the closest one when the rank sits outside every
 * band. A brand-new career starts one place below the whole roster — off the
 * bottom of the ladder the bands describe — so an exact-match-only lookup would
 * hand day one nothing at all. Falling back to the nearest band means the
 * bottom rung's chest is what a fresh save is handed.
 */
function bandForRank(bands: DailyRewardBand[], rank: number): DailyRewardBand | null {
  if (bands.length === 0) return null;
  let best: DailyRewardBand | null = null;
  let bestGap = Number.POSITIVE_INFINITY;
  for (const b of bands) {
    const gap = rank > b.hiRank ? rank - b.hiRank : rank < b.loRank ? b.loRank - rank : 0;
    if (gap === 0) return b;
    if (gap < bestGap) { best = b; bestGap = gap; }
  }
  return best;
}

/** Crate odds + chest count configured for a player sitting at this rank. */
export function getDailyRewardForRank(
  rank: number,
  cfg: DailyRewardConfig = loadDailyRewardConfig(),
): { chances: CrateChances; count: number } {
  // A rank that isn't a real number can't be placed on the ladder at all —
  // NaN would otherwise slip through every comparison in the band search.
  if (!Number.isFinite(rank)) return { chances: zeroChances(), count: 0 };
  if (rank <= 1) {
    return {
      chances: normalizeCrateChances(cfg.rank1Chances, chancesFromCrateList(defaultDailyCrates(1))),
      count: clampDailyCrateCount(cfg.rank1Count),
    };
  }
  const band = bandForRank(cfg.bands, rank);
  if (!band) return { chances: zeroChances(), count: 0 };
  return {
    chances: normalizeCrateChances(band.chances, chancesFromCrateList(defaultDailyCrates(rank))),
    count: clampDailyCrateCount(band.count),
  };
}

/** Weighted pick of one crate from a set of odds. */
function pickFromChances(chances: CrateChances, rng: () => number): CrateId | null {
  const total = CRATE_IDS.reduce((sum, id) => sum + Math.max(0, chances[id] ?? 0), 0);
  if (total <= 0) return null;
  let roll = rng() * total;
  for (const id of CRATE_IDS) {
    roll -= Math.max(0, chances[id] ?? 0);
    if (roll <= 0) return id;
  }
  return CRATE_IDS[CRATE_IDS.length - 1];
}

/**
 * The chests today pays out at this rank — one weighted draw per configured
 * chest, so a band set to 5 chests can roll five different crates.
 */
export function pickDailyCrates(
  rank: number,
  rng: () => number = Math.random,
  cfg: DailyRewardConfig = loadDailyRewardConfig(),
): CrateId[] {
  const { chances, count } = getDailyRewardForRank(rank, cfg);
  const out: CrateId[] = [];
  for (let i = 0; i < count; i++) {
    const pick = pickFromChances(chances, rng);
    if (!pick) break;
    out.push(pick);
  }
  return out;
}

export { CRATE_IDS };
export type { CrateId };
