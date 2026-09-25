/**
 * Roster Generation config — user-editable ranges that drive auto-generation of
 * NPC initial levels, stats and refinements per ranking band.
 *
 * Bands (rank 1 = champion, 704 = worst):
 *   704–700, then 20-rank bands (699–680 … 39–20), then 19–15, 14–10, 9–5, 4–2.
 *   Rank 1 is manually set (level + flat stat value + flat per-skill refinement).
 *
 * When no custom config has been saved, the legacy formulas in careerRoster.ts
 * are used unchanged. Once the user saves from the Roster Generation page, the
 * saved bands take over for all future generation (new careers and regens).
 */

import { CRATE_IDS, isCrateId, type CrateId } from "./cratesConfig";
import {
  clampPunchEndurance, PUNCH_ENDURANCE_MIN,
  clampPunchEnduranceLoss, PUNCH_ENDURANCE_LOSS_MIN, needsPunchEnduranceLossRebase,
} from "./punchEndurance";
import { EQUIPMENT_MAX_LEVEL } from "./equipmentConfig";
import { MAX_ACTIVE_REFINEMENTS } from "@shared/schema";
import { sanitizeRefinementKeys } from "./refinementKeys";

export interface RosterGenBand {
  /** Numerically higher (worse) rank bound, inclusive. */
  hiRank: number;
  /** Numerically lower (better) rank bound, inclusive. */
  loRank: number;
  levelLo: number;
  levelHi: number;
  /** Target-average stat range (each of the 5 stats is generated around a target avg). */
  statLo: number;
  statHi: number;
  /** Per-refinement-skill range (15 skills). */
  refLo: number;
  refHi: number;
  /**
   * How many refinements a fighter in this band is generated with (0–5). The
   * chosen keys are rolled inside refLo/refHi; every other key stays at zero.
   */
  refCount: number;
  /**
   * Refinements every fighter in this band is generated with. They fill
   * `refCount` first — anything left over is still dealt at random per fighter.
   * Empty (the default) means the whole loadout is random.
   */
  refForced?: string[];
  /** Punch Endurance range — punches per point of max stamina lost (20–120). */
  peLo: number;
  peHi: number;
  /**
   * Max stamina a fighter in this band burns each time its punch counter comes
   * round — the "X" in "X max stamina per Y punches" (1–8).
   */
  peLoss: number;
  /**
   * Equipment Upgrade level range. A career opponent carries ONE level, worn in
   * all five slots. 0 = no equipment, which is what every band starts at.
   */
  equipLo: number;
  equipHi: number;
  /** ELO gain/loss multiplier for fighters currently ranked in this band (0.4–10). */
  eloMult: number;
  /**
   * Per-crate chance (%) that a chest won here is that crate. Always sums to
   * 100 — `crateCount` decides whether any chest is handed out at all.
   */
  crateChances: CrateChances;
  /** How many chests a win against this band grants (0–99). */
  crateCount: number;
}

export interface RosterGenConfig {
  bands: RosterGenBand[];
  /** Rank 1 manual values. */
  rank1Level: number;
  rank1Stat: number;
  rank1Ref: number;
  /** How many refinements the champion is generated with (0–5). */
  rank1RefCount: number;
  /** Refinements the champion is always generated with (see {@link RosterGenBand.refForced}). */
  rank1RefForced?: string[];
  /** Punch Endurance the champion fights with (30–120). */
  rank1Pe: number;
  /** Percent of their pool the champion burns per drain (1–20). */
  rank1PeLoss: number;
  /**
   * True once the per-drain costs in this config are percentages of the pool
   * rather than point counts. Absent on a config saved before the switch, whose
   * numbers are re-based on the way in.
   */
  peLossPct?: boolean;
  /** Equipment Upgrade level the champion wears in all five slots (0–1000). */
  rank1Equip: number;
  /** ELO gain/loss multiplier for the champion (0.4–10). */
  rank1EloMult: number;
  /** Crate odds (sums to 100) for beating the rank 1 champion. */
  rank1CrateChances: CrateChances;
  /** How many chests beating the champion grants (0–99). */
  rank1CrateCount: number;
}

/** Percentage odds per crate; the six values always add up to 100. */
export type CrateChances = Record<CrateId, number>;

/** Most chests a single win can hand out. */
export const CRATE_COUNT_MAX = 99;

/** Equipment levels are whole numbers between none and the hidden ceiling. */
export function clampEquipLevel(v: unknown): number {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.round(v) : 0;
  return Math.max(0, Math.min(EQUIPMENT_MAX_LEVEL, n));
}

/**
 * The Equipment level range configured for a rank — a single level worn in all
 * five slots. Rank 1 is a flat value rather than a range.
 */
export function getEquipRangeForRank(cfg: RosterGenConfig | null, rank: number): [number, number] {
  if (!cfg) return [0, 0];
  if (rank <= 1) {
    const v = clampEquipLevel(cfg.rank1Equip);
    return [v, v];
  }
  const band = getGenBandForRank(cfg, rank);
  if (!band) return [0, 0];
  const lo = clampEquipLevel(band.equipLo);
  const hi = clampEquipLevel(band.equipHi);
  return [Math.min(lo, hi), Math.max(lo, hi)];
}

/** A fighter brings at most MAX_ACTIVE_REFINEMENTS into the ring, so the count is 0–that. */
export function clampRefCount(v: unknown): number {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.round(v) : MAX_ACTIVE_REFINEMENTS;
  return Math.max(0, Math.min(MAX_ACTIVE_REFINEMENTS, n));
}

/**
 * How many refinements a fighter at this rank is generated with. Rank 1 has its
 * own flat value, the rest read their band.
 */
export function getRefCountForRank(cfg: RosterGenConfig | null, rank: number): number {
  if (!cfg) return MAX_ACTIVE_REFINEMENTS;
  if (rank <= 1) return clampRefCount(cfg.rank1RefCount);
  const band = getGenBandForRank(cfg, rank);
  return band ? clampRefCount(band.refCount) : MAX_ACTIVE_REFINEMENTS;
}

/**
 * The refinements every fighter at this rank is generated with. An empty list —
 * which is what an unconfigured band and a config saved before this existed
 * both read as — leaves the whole loadout to the random draw.
 */
export function getForcedRefinementsForRank(cfg: RosterGenConfig | null | undefined, rank: number): string[] {
  if (!cfg) return [];
  if (rank <= 1) return sanitizeRefinementKeys(cfg.rank1RefForced);
  const band = getGenBandForRank(cfg, rank);
  return band ? sanitizeRefinementKeys(band.refForced) : [];
}

export function clampCrateCount(v: unknown): number {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.round(v) : 1;
  return Math.max(0, Math.min(CRATE_COUNT_MAX, n));
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

export const ELO_MULT_MIN = 0.4;
export const ELO_MULT_MAX = 10;

export function clampEloMult(v: number): number {
  if (!Number.isFinite(v)) return 1;
  return Math.max(ELO_MULT_MIN, Math.min(ELO_MULT_MAX, v));
}

/**
 * Punch Endurance range for a rank under this config — the champion's manual
 * value as a one-wide range, and the floor for anything the config doesn't
 * cover. Backwards ranges are read either way round.
 */
export function getPeRangeForRank(cfg: RosterGenConfig | null | undefined, rank: number): [number, number] {
  if (!cfg) return [PUNCH_ENDURANCE_MIN, PUNCH_ENDURANCE_MIN];
  if (rank === 1) { const v = clampPunchEndurance(cfg.rank1Pe); return [v, v]; }
  const band = getGenBandForRank(cfg, rank);
  if (!band) return [PUNCH_ENDURANCE_MIN, PUNCH_ENDURANCE_MIN];
  const lo = clampPunchEndurance(band.peLo);
  const hi = clampPunchEndurance(band.peHi);
  return lo <= hi ? [lo, hi] : [hi, lo];
}

/** ELO multiplier for a fighter's current rank under this config (1 when unset). */
export function getEloMultForRank(cfg: RosterGenConfig, rank: number): number {
  if (rank === 1) return clampEloMult(cfg.rank1EloMult ?? 1);
  const band = getGenBandForRank(cfg, rank);
  return clampEloMult(band?.eloMult ?? 1);
}

/**
 * Percent of their pool a fighter at this rank burns per drain — the champion's
 * manual value, otherwise the band's. Anything the config doesn't cover pays the
 * opening rate, which is what any fighter without a value of their own pays.
 */
export function getPeLossForRank(cfg: RosterGenConfig | null | undefined, rank: number): number {
  if (!cfg) return PUNCH_ENDURANCE_LOSS_MIN;
  if (rank === 1) return clampPunchEnduranceLoss(cfg.rank1PeLoss);
  const band = getGenBandForRank(cfg, rank);
  return clampPunchEnduranceLoss(band?.peLoss);
}

/**
 * Percent of their pool an AI corner burns per drain, read live at fight start. Pass the
 * opponent's roster rank; gym, Doghouse and Nightmare partners have no entry of
 * their own, so their caller passes the player's rank and they fight at the
 * cost the player's own division pays.
 */
export function getAiPunchEnduranceLossForRank(rank: number | null | undefined): number {
  const cfg = loadCustomRosterGenConfig();
  if (!cfg || rank == null || !Number.isFinite(rank)) return PUNCH_ENDURANCE_LOSS_MIN;
  return getPeLossForRank(cfg, rank);
}

const STORAGE_KEY = "handz_roster_gen_config";

// ---- legacy default formulas (mirrors careerRoster.ts) ----

function legacyLevelRange(rank: number): [number, number] {
  if (rank <= 1) return [1000, 1000];
  if (rank <= 9) return [950, 999];
  if (rank <= 49) return [750, 950];
  if (rank <= 99) return [550, 750];
  if (rank <= 199) return [350, 550];
  if (rank <= 299) return [200, 350];
  if (rank <= 399) return [100, 220];
  if (rank <= 499) return [50, 120];
  if (rank <= 599) return [20, 60];
  if (rank <= 649) return [8, 25];
  if (rank <= 674) return [3, 10];
  if (rank <= 699) return [1, 5];
  return [1, 2];
}

function legacyStatRange(rank: number): [number, number] {
  if (rank >= 700) return [10, 20];
  if (rank >= 651) {
    const t = (699 - rank) / 48;
    return [Math.round(20 + t * 5), Math.round(45 + t * 30)];
  }
  if (rank === 650) return [75, 120];
  if (rank >= 550) {
    const t = (649 - rank) / 99;
    return [Math.round(75 + t * 80), Math.round(120 + t * 105)];
  }
  if (rank >= 400) {
    const t = (549 - rank) / 149;
    return [Math.round(155 + t * 130), Math.round(225 + t * 200)];
  }
  if (rank >= 200) {
    const t = (399 - rank) / 199;
    return [Math.round(285 + t * 365), Math.round(425 + t * 350)];
  }
  if (rank >= 100) {
    const t = (199 - rank) / 99;
    return [Math.round(500 + t * 150), Math.round(700 + t * 100)];
  }
  if (rank >= 50) {
    const t = (99 - rank) / 49;
    return [Math.round(650 + t * 100), Math.round(800 + t * 100)];
  }
  if (rank >= 10) {
    const t = (49 - rank) / 39;
    return [Math.round(750 + t * 150), Math.round(900 + t * 55)];
  }
  const t = (9 - rank) / 7;
  return [Math.round(900 + t * 50), Math.round(955 + t * 44)];
}

function legacyRefRange(rank: number): [number, number] {
  if (rank > 650) return [0, 0];
  const brackets: { minRank: number; lo: number; hi: number }[] = [
    { minRank: 600, lo: 0, hi: 3 }, { minRank: 550, lo: 0, hi: 5 },
    { minRank: 500, lo: 1, hi: 8 }, { minRank: 450, lo: 3, hi: 10 },
    { minRank: 400, lo: 3, hi: 15 }, { minRank: 350, lo: 4, hi: 20 },
    { minRank: 300, lo: 6, hi: 25 }, { minRank: 250, lo: 10, hi: 40 },
    { minRank: 200, lo: 22, hi: 50 }, { minRank: 150, lo: 27, hi: 65 },
    { minRank: 100, lo: 38, hi: 90 }, { minRank: 50, lo: 45, hi: 100 },
    { minRank: 20, lo: 65, hi: 100 }, { minRank: 10, lo: 75, hi: 100 },
    { minRank: 2, lo: 80, hi: 100 }, { minRank: 1, lo: 95, hi: 100 },
  ];
  const b = brackets.find(x => rank >= x.minRank) ?? brackets[brackets.length - 1];
  return [b.lo, b.hi];
}

/** Band boundaries per spec: 704–700, 20-wide bands to rank 20, then 19–15, 14–10, 9–5, 4–2. */
export function buildBandBounds(): { hiRank: number; loRank: number }[] {
  const bounds: { hiRank: number; loRank: number }[] = [{ hiRank: 704, loRank: 700 }];
  for (let hi = 699; hi >= 39; hi -= 20) {
    bounds.push({ hiRank: hi, loRank: hi - 19 });
  }
  bounds.push({ hiRank: 19, loRank: 15 });
  bounds.push({ hiRank: 14, loRank: 10 });
  bounds.push({ hiRank: 9, loRank: 5 });
  bounds.push({ hiRank: 4, loRank: 2 });
  return bounds;
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
  // Hand the leftover whole points to the biggest fractional parts first.
  let left = Math.round(remainder - vals.reduce((a, b) => a + b, 0));
  const byFrac = exact
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac);
  for (let k = 0; left > 0; k++, left--) vals[byFrac[k % byFrac.length].i] += 1;

  const out = { ...chances, [moved]: target } as CrateChances;
  others.forEach((id, i) => { out[id] = vals[i]; });
  return out;
}

/** Reads the pre-odds `rewardCrates` list off an old saved config, if present. */
function legacyCrateList(src: object, key = "rewardCrates"): CrateId[] | null {
  const raw = (src as Record<string, unknown>)[key];
  return Array.isArray(raw) ? raw.filter(isCrateId) : null;
}

/** Default crate a win in this rank band awards — richer crates the higher you climb. */
function defaultRewardCrates(rank: number): CrateId[] {
  if (rank <= 1) return ["goat"];
  if (rank <= 9) return ["undisputed"];
  if (rank <= 49) return ["champion"];
  if (rank <= 199) return ["elite"];
  if (rank <= 499) return ["contender"];
  return ["journeyman"];
}

export function buildDefaultRosterGenConfig(): RosterGenConfig {
  const bands: RosterGenBand[] = buildBandBounds().map(({ hiRank, loRank }) => {
    const mid = Math.round((hiRank + loRank) / 2);
    const [levelLo, levelHi] = legacyLevelRange(mid);
    const [statLo, statHi] = legacyStatRange(mid);
    const [refLo, refHi] = legacyRefRange(mid);
    return {
      hiRank, loRank, levelLo, levelHi, statLo, statHi, refLo, refHi,
      // A full loadout until the bands are tuned — the same five a fighter can
      // carry into the ring, every one of them dealt at random.
      refCount: MAX_ACTIVE_REFINEMENTS,
      refForced: [],
      // Opponents sit at the floor until the bands are tuned, which is also what
      // every fighter without a value fights at.
      peLo: PUNCH_ENDURANCE_MIN, peHi: PUNCH_ENDURANCE_MIN,
      // The opening rate, which is what every career and every untuned fighter
      // pays: one percent of the pool per drain.
      peLoss: PUNCH_ENDURANCE_LOSS_MIN,
      // Nobody is generated with equipment until the bands are tuned — an
      // existing career must not wake up to a roster wearing gear it never had.
      equipLo: 0, equipHi: 0,
      eloMult: 1,
      crateChances: chancesFromCrateList(defaultRewardCrates(mid)),
      crateCount: 1,
    };
  });
  return {
    bands, rank1Level: 1000, rank1Stat: 1000, rank1Ref: 100, rank1RefCount: MAX_ACTIVE_REFINEMENTS,
    rank1RefForced: [],
    rank1Pe: PUNCH_ENDURANCE_MIN, rank1Equip: 0, rank1EloMult: 1,
    rank1PeLoss: PUNCH_ENDURANCE_LOSS_MIN, peLossPct: true,
    rank1CrateChances: chancesFromCrateList(defaultRewardCrates(1)),
    rank1CrateCount: 1,
  };
}

// Cache the parsed config keyed on the raw string so repeated generation loops
// don't re-parse, while saves from any tab are picked up immediately.
let cachedRaw: string | null = null;
let cachedCfg: RosterGenConfig | null = null;

/** Returns the saved custom config, or null if the user never saved one. */
export function loadCustomRosterGenConfig(): RosterGenConfig | null {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(STORAGE_KEY) : null;
    if (!raw) { cachedRaw = null; cachedCfg = null; return null; }
    if (raw === cachedRaw) return cachedCfg;
    const parsed = JSON.parse(raw) as RosterGenConfig;
    if (!parsed || !Array.isArray(parsed.bands) || parsed.bands.length === 0) {
      cachedRaw = raw; cachedCfg = null;
      return null;
    }
    // Backfill fields added after the user first saved a config. Configs saved
    // before per-crate odds existed carry a `rewardCrates` list instead: an even
    // split across the listed crates, one chest per win (none listed = no chest).
    // The per-drain cost started life as one roster-wide number. Where that key
    // survives it seeds every band, so a config saved against the old shape keeps
    // the cost it was saved with instead of snapping back to the ceiling.
    const legacyLoss = (parsed as { aiPunchEnduranceLoss?: unknown }).aiPunchEnduranceLoss;
    const seedLoss = typeof legacyLoss === "number" && Number.isFinite(legacyLoss)
      ? clampPunchEnduranceLoss(legacyLoss)
      : undefined;
    // The cost is a percentage of the pool now. A config saved in points would
    // put every AI on a ruinous percentage, so a config without the stamp is
    // re-based to the opening rate and left for the user to re-tune.
    const rebaseLoss = needsPunchEnduranceLossRebase(parsed.peLossPct);
    for (const b of parsed.bands) {
      if (typeof b.eloMult !== "number" || !Number.isFinite(b.eloMult)) b.eloMult = 1;
      // Punch Endurance arrived after the bands did — configs saved without it
      // hand out the floor, which is what an opponent with no value fights at.
      b.peLo = clampPunchEndurance(b.peLo);
      b.peHi = clampPunchEndurance(b.peHi);
      b.peLoss = rebaseLoss ? PUNCH_ENDURANCE_LOSS_MIN : clampPunchEnduranceLoss(b.peLoss ?? seedLoss);
      // Equipment arrived after the bands did. A config saved without it hands
      // out nothing, so an existing roster keeps fighting bare.
      b.equipLo = clampEquipLevel(b.equipLo);
      b.equipHi = clampEquipLevel(b.equipHi);
      // The five-active cap arrived after the bands did. A config saved without
      // a count reads as a full loadout, which is what it generated back then.
      b.refCount = clampRefCount(b.refCount);
      // Forced refinements arrived later still — an absent list is an all-random
      // loadout, so an existing roster keeps the picks it was generated with.
      b.refForced = sanitizeRefinementKeys(b.refForced);
      const mid = Math.round((b.hiRank + b.loRank) / 2);
      const legacy = legacyCrateList(b);
      const fallback = chancesFromCrateList(legacy ?? defaultRewardCrates(mid));
      b.crateChances = normalizeCrateChances(b.crateChances, fallback);
      b.crateCount = b.crateCount === undefined
        ? (legacy ? (legacy.length > 0 ? 1 : 0) : 1)
        : clampCrateCount(b.crateCount);
      delete (b as { rewardCrates?: unknown }).rewardCrates;
    }
    if (typeof parsed.rank1EloMult !== "number" || !Number.isFinite(parsed.rank1EloMult)) parsed.rank1EloMult = 1;
    parsed.rank1Pe = clampPunchEndurance(parsed.rank1Pe);
    parsed.rank1Equip = clampEquipLevel(parsed.rank1Equip);
    parsed.rank1RefCount = clampRefCount(parsed.rank1RefCount);
    parsed.rank1RefForced = sanitizeRefinementKeys(parsed.rank1RefForced);
    // Configs saved before the per-drain cost existed read as the opening rate,
    // which is what every fighter without a value of their own pays.
    parsed.rank1PeLoss = rebaseLoss ? PUNCH_ENDURANCE_LOSS_MIN : clampPunchEnduranceLoss(parsed.rank1PeLoss ?? seedLoss);
    parsed.peLossPct = true;
    delete (parsed as { aiPunchEnduranceLoss?: unknown }).aiPunchEnduranceLoss;
    const legacyRank1 = legacyCrateList(parsed, "rank1RewardCrates");
    parsed.rank1CrateChances = normalizeCrateChances(
      parsed.rank1CrateChances,
      chancesFromCrateList(legacyRank1 ?? defaultRewardCrates(1)),
    );
    parsed.rank1CrateCount = parsed.rank1CrateCount === undefined
      ? (legacyRank1 ? (legacyRank1.length > 0 ? 1 : 0) : 1)
      : clampCrateCount(parsed.rank1CrateCount);
    delete (parsed as { rank1RewardCrates?: unknown }).rank1RewardCrates;
    cachedRaw = raw;
    cachedCfg = parsed;
    return parsed;
  } catch {
    return null;
  }
}

export function saveRosterGenConfig(cfg: RosterGenConfig): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
  cachedRaw = null;
  cachedCfg = null;
}

export function clearRosterGenConfig(): void {
  localStorage.removeItem(STORAGE_KEY);
  cachedRaw = null;
  cachedCfg = null;
}

export function getGenBandForRank(cfg: RosterGenConfig, rank: number): RosterGenBand | null {
  return cfg.bands.find(b => rank <= b.hiRank && rank >= b.loRank) ?? null;
}

/** Crate odds + chest count configured for wins at this rank (saved config or defaults). */
export function getCrateRewardForRank(rank: number): { chances: CrateChances; count: number } {
  const cfg = loadCustomRosterGenConfig() ?? buildDefaultRosterGenConfig();
  if (rank <= 1) {
    return {
      chances: normalizeCrateChances(cfg.rank1CrateChances, chancesFromCrateList(defaultRewardCrates(1))),
      count: clampCrateCount(cfg.rank1CrateCount),
    };
  }
  const band = getGenBandForRank(cfg, rank);
  return {
    chances: normalizeCrateChances(band?.crateChances, chancesFromCrateList(defaultRewardCrates(rank))),
    count: clampCrateCount(band?.crateCount),
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

/** An opponent must sit more than this many ranks above the player to skew the odds. */
export const CRATE_UPSET_RANK_THRESHOLD = 3;
/** Percentage points moved from the commonest chests to the rarest, per rank past the threshold. */
export const CRATE_UPSET_SHIFT_PER_RANK = 2;

/**
 * Upset wins pay rarer chests. Beating someone more than 3 ranks above shifts
 * 2 percentage points per extra rank out of the commonest chests and into the
 * rarest ones — the two rarest gain and the two commonest lose when three or
 * more chest rarities can drop here, otherwise it is a straight swap from the
 * commoner of the two available chests to the rarer one. A single available
 * chest rarity has nothing to trade, so its odds stand.
 *
 * Only chests the band can actually roll (odds above 0) take part, and the
 * commonest group can never give up more than it holds, so the row still totals
 * what it did before.
 */
export function applyUpsetCrateBoost(
  chances: CrateChances,
  opponentRank: number,
  playerRank: number | null | undefined,
): CrateChances {
  if (playerRank == null || !Number.isFinite(playerRank) || !Number.isFinite(opponentRank)) return chances;
  const ranksAbove = playerRank - opponentRank;
  if (ranksAbove <= CRATE_UPSET_RANK_THRESHOLD) return chances;

  // CRATE_IDS runs commonest → rarest, so the tail is the rare end.
  const present = CRATE_IDS.filter(id => (chances[id] ?? 0) > 0);
  if (present.length < 2) return chances;

  const groupSize = present.length >= 3 ? 2 : 1;
  const rarest = present.slice(-groupSize);
  const commonest = present.slice(0, groupSize);

  const commonTotal = commonest.reduce((sum, id) => sum + chances[id], 0);
  const rareTotal = rarest.reduce((sum, id) => sum + chances[id], 0);
  if (commonTotal <= 0 || rareTotal <= 0) return chances;

  const wanted = CRATE_UPSET_SHIFT_PER_RANK * (ranksAbove - CRATE_UPSET_RANK_THRESHOLD);
  const moved = Math.min(wanted, commonTotal);

  const out = { ...chances };
  // Each side splits its share of the move in proportion to its own odds, so a
  // chest can never be pushed below 0 and the rare end gains exactly what the
  // common end gave up.
  for (const id of commonest) out[id] -= moved * (chances[id] / commonTotal);
  for (const id of rarest) out[id] += moved * (chances[id] / rareTotal);
  for (const id of CRATE_IDS) out[id] = Math.max(0, out[id]);
  return out;
}

/**
 * The chests a win at this rank hands out — one weighted draw per configured
 * chest, so a band set to 5 chests can roll five different crates. Pass the
 * player's pre-fight rank to let an upset win skew the odds toward the rarer
 * chests (see applyUpsetCrateBoost).
 */
export function pickRewardCrates(
  rank: number,
  rng: () => number = Math.random,
  playerRank?: number | null,
): CrateId[] {
  const { chances, count } = getCrateRewardForRank(rank);
  const odds = applyUpsetCrateBoost(chances, rank, playerRank);
  const out: CrateId[] = [];
  for (let i = 0; i < count; i++) {
    const pick = pickFromChances(odds, rng);
    if (!pick) break;
    out.push(pick);
  }
  return out;
}

export { CRATE_IDS };
export type { CrateId };
