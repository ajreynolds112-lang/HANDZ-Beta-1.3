import type { CareerRosterState, RosterFighterState } from "@shared/schema";
import { ROSTER_DATA, KEY_FIGHTER_IDS, ACTIVE_ROSTER_SIZE, WEEKLY_FIGHT_COUNT, TOTAL_ROSTER, getRosterDisplayName, type RosterEntry } from "./rosterData";
import type { Archetype, AIDifficulty } from "./types";
import { SKIN_COLOR_PRESETS } from "./types";
import { generateOffenseProfile } from "./offenseProfile";
import { loadCustomRosterGenConfig, getGenBandForRank, getEloMultForRank, getPeRangeForRank, getEquipRangeForRank, getRefCountForRank, getForcedRefinementsForRank, clampEquipLevel, type RosterGenConfig } from "./rosterGenConfig";
import { REFINEMENT_KEYS, sanitizeRefinementKeys } from "./refinementKeys";
import { activeRefinementsOnly, MAX_ACTIVE_REFINEMENTS } from "./engine";
import { grownEquipmentLevel, normalizeEquipmentLevels, postChampEquipmentFloor } from "./equipmentConfig";
import { clampPunchEndurance, punchEnduranceOf, PUNCH_ENDURANCE_MIN, punchEnduranceLossOf, PUNCH_ENDURANCE_LOSS_MAX, PUNCH_ENDURANCE_LOSS_MIN, PUNCH_ENDURANCE_GRACE_WEEKS, PUNCH_ENDURANCE_STEP_WEEKS, needsPunchEnduranceLossRebase } from "./punchEndurance";
import { applySpacialGear, spacialSelectionOf } from "./spacialColor";
import { advanceDrilledWeek } from "./drilledActions";
import { advanceResetTrainingWeek, resetTrainingOf, RESET_SPEED_GRACE_WEEKS, RESET_SPEED_STEP_WEEKS, RESET_SPEED_MAX_STEPS } from "./resetTraining";
import { loadXpConfig } from "@/lib/xpConfig";

/**
 * Backfills the deterministic per-fighter offense/defense execution profile on any
 * roster fighter missing one (older saves, freshly merged fighters). The profile is
 * a pure function of roster id + archetype, so backfilling is idempotent.
 */
export function ensureOffenseProfiles(roster: RosterFighterState[]): void {
  let archetypeById: Map<number, Archetype> | null = null;
  for (const f of roster) {
    if (f.offenseProfile) continue;
    if (!archetypeById) {
      archetypeById = new Map(ROSTER_DATA.map(r => [r.id, r.archetype as Archetype]));
    }
    const archetype = archetypeById.get(f.id);
    if (archetype) f.offenseProfile = generateOffenseProfile(f.id, archetype);
  }
}

const GLOVE_COLORS = ["#cc2222", "#1155cc", "#22aa22", "#ddaa00", "#aa22aa", "#ff6600", "#222222", "#ffffff"];
const TAPE_COLORS = ["#eeeeee", "#cccccc", "#222222"];
const TRUNK_COLORS = ["#222222", "#cc2222", "#1155cc", "#22aa22", "#ddaa00", "#aa22aa", "#ff6600", "#ffffff"];
const SHOE_COLORS = ["#1a1a1a", "#2a1a1a", "#222222", "#333333"];
const SOCK_COLORS = ["#f0f0f0", "#e6e6e6", "#111111", "#cc2222", "#1155cc", "#ddaa00"];

/**
 * Sock colour is derived from the fighter id rather than drawn from the shared
 * generator rng: adding a draw would shift every later rng() call and silently
 * change the rosters and schedules that seed produces.
 */
export function sockColorForFighterId(id: number): string {
  const h = Math.imul(id || 1, 2654435761) >>> 0;
  return SOCK_COLORS[h % SOCK_COLORS.length];
}

/** Returns [min, max] level range for a given roster rank (1 = champion, 700+ = worst). */
function levelRangeForRank(rank: number): [number, number] {
  // Custom Roster Generation config (Neural Network → Roster Generation) takes
  // precedence — it also drives redistributeRosterLevels' rank-base snapping.
  const custom = loadCustomRosterGenConfig();
  if (custom) {
    if (rank <= 1) return [Math.max(1, custom.rank1Level), Math.max(1, custom.rank1Level)];
    const band = getGenBandForRank(custom, rank);
    if (band) {
      const lo = Math.max(1, Math.min(band.levelLo, band.levelHi));
      const hi = Math.max(1, Math.max(band.levelLo, band.levelHi));
      return [lo, hi];
    }
  }
  if (rank <= 1)   return [1000, 1000];
  if (rank <= 9)   return [950,  999];
  if (rank <= 49)  return [750,  950];
  if (rank <= 99)  return [550,  750];
  if (rank <= 199) return [350,  550];
  if (rank <= 299) return [200,  350];
  if (rank <= 399) return [100,  220];
  if (rank <= 499) return [50,   120];
  if (rank <= 599) return [20,    60];
  if (rank <= 649) return [8,     25];
  if (rank <= 674) return [3,     10];
  if (rank <= 699) return [1,      5];
  return [1, 2]; // rank 700+
}

/**
 * Center-biased sample: average two uniform draws so results cluster near the
 * middle of the bracket (triangular distribution). Only a small fraction of
 * fighters land near the bracket maximum, preventing early extreme outliers.
 */
function sampleLevelForRank(rank: number, rng: () => number): number {
  if (rank === 1) {
    const custom = loadCustomRosterGenConfig();
    return custom ? Math.max(1, custom.rank1Level) : 1000;
  }
  const [lo, hi] = levelRangeForRank(rank);
  const span = hi - lo;
  // Two uniform draws averaged → triangular, peak at midpoint
  const raw = (rng() + rng()) / 2;
  return Math.max(lo, Math.min(hi, Math.floor(lo + raw * (span + 1))));
}

function generateFighterColors(rng: () => number, id?: number) {
  return {
    genSocks: sockColorForFighterId(id ?? Math.floor(rng() * 1000) + 1),
    genSkinColor: SKIN_COLOR_PRESETS[Math.floor(rng() * SKIN_COLOR_PRESETS.length)],
    genGloves: GLOVE_COLORS[Math.floor(rng() * GLOVE_COLORS.length)],
    genGloveTape: TAPE_COLORS[Math.floor(rng() * TAPE_COLORS.length)],
    genTrunks: TRUNK_COLORS[Math.floor(rng() * TRUNK_COLORS.length)],
    genShoes: SHOE_COLORS[Math.floor(rng() * SHOE_COLORS.length)],
  };
}

const STYLE_MULTS: Record<Archetype, { power: number; speed: number; defense: number; stamina: number; focus: number }> = {
  BoxerPuncher: { power: 1.05, speed: 1.00, defense: 1.00, stamina: 1.00, focus: 1.00 },
  OutBoxer:     { power: 0.85, speed: 1.20, defense: 1.15, stamina: 1.00, focus: 1.05 },
  Brawler:      { power: 1.25, speed: 0.80, defense: 0.90, stamina: 1.00, focus: 0.95 },
  Swarmer:      { power: 1.10, speed: 1.15, defense: 0.85, stamina: 0.85, focus: 0.95 },
};

// Per-rank-bracket refinement budgets: total = max points across every key,
// lo/hi = allowed per-key range. Every key starts at lo; the remaining budget
// (a random 70-100% of it) is sprinkled one point at a time onto random keys
// still below hi, so both the per-key range and the bracket total are honored.
const REF_BRACKETS: { minRank: number; total: number; lo: number; hi: number }[] = [
  { minRank: 600, total: 10,   lo: 0,  hi: 3 },
  { minRank: 550, total: 20,   lo: 0,  hi: 5 },
  { minRank: 500, total: 30,   lo: 1,  hi: 8 },
  { minRank: 450, total: 45,   lo: 3,  hi: 10 },
  { minRank: 400, total: 70,   lo: 3,  hi: 15 },
  { minRank: 350, total: 100,  lo: 4,  hi: 20 },
  { minRank: 300, total: 130,  lo: 6,  hi: 25 },
  { minRank: 250, total: 250,  lo: 10, hi: 40 },
  { minRank: 200, total: 500,  lo: 22, hi: 50 },
  { minRank: 150, total: 750,  lo: 27, hi: 65 },
  { minRank: 100, total: 850,  lo: 38, hi: 90 },
  { minRank: 50,  total: 1000, lo: 45, hi: 100 },
  { minRank: 20,  total: 1150, lo: 65, hi: 100 },
  { minRank: 10,  total: 1250, lo: 75, hi: 100 },
  { minRank: 2,   total: 1300, lo: 80, hi: 100 },
  { minRank: 1,   total: 1400, lo: 95, hi: 100 },
];

const ZERO_REFINEMENTS = (): Record<string, number> => Object.fromEntries(REFINEMENT_KEYS.map(k => [k, 0]));

/**
 * The refinements a generated fighter actually carries, drawn from their own id
 * rather than a seeded generator so generation, backfills and the band
 * enforcement pass all land on the same keys however many times they run.
 *
 * `forced` are the refinements the band demands every fighter in it carries.
 * They fill the count first; whatever is left over is dealt at random as
 * before, so a band with nothing forced generates exactly the loadouts it
 * always did.
 */
export function pickRefinementKeys(id: number, count: number, forced: readonly string[] = []): string[] {
  const n = Math.max(0, Math.min(REFINEMENT_KEYS.length, Math.round(count)));
  if (n <= 0) return [];
  const keys: string[] = [...REFINEMENT_KEYS];
  for (let i = keys.length - 1; i > 0; i--) {
    const j = Math.floor(hashRand01(id, "refpick", i) * (i + 1));
    [keys[i], keys[j]] = [keys[j], keys[i]];
  }
  if (forced.length === 0) return keys.slice(0, n);
  // Forced picks come off the top of the count; anything past it is dropped
  // rather than pushing the fighter over what it can carry into the ring.
  const out: string[] = sanitizeRefinementKeys(forced).slice(0, n);
  const taken = new Set(out);
  for (const k of keys) {
    if (out.length >= n) break;
    if (!taken.has(k)) out.push(k);
  }
  return out;
}

function generateRosterRefinements(rank: number, rng: () => number, id: number = 0): Record<string, number> {
  const custom = loadCustomRosterGenConfig();
  if (custom) {
    if (rank === 1) {
      const v = Math.max(0, Math.min(100, custom.rank1Ref));
      const vals = ZERO_REFINEMENTS();
      for (const k of pickRefinementKeys(id, getRefCountForRank(custom, 1), getForcedRefinementsForRank(custom, 1))) vals[k] = v;
      return vals;
    }
    const band = getGenBandForRank(custom, rank);
    if (band) {
      const lo = Math.max(0, Math.min(band.refLo, band.refHi));
      const hi = Math.max(0, Math.max(band.refLo, band.refHi));
      const keys = pickRefinementKeys(id, getRefCountForRank(custom, rank), getForcedRefinementsForRank(custom, rank));
      const bracket = { total: Math.round(((lo + hi) / 2) * keys.length), lo, hi };
      return sprinkleRefinements(bracket, rng, keys);
    }
  }
  if (rank > 650) {
    return ZERO_REFINEMENTS();
  }
  const bracket = REF_BRACKETS.find(b => rank >= b.minRank) ?? REF_BRACKETS[REF_BRACKETS.length - 1];
  return sprinkleRefinements(bracket, rng, pickRefinementKeys(id, MAX_ACTIVE_REFINEMENTS));
}

/**
 * Spreads a bracket's budget over `keys` only — every other refinement stays at
 * zero, because a fighter never brings more than its chosen keys into the ring.
 */
function sprinkleRefinements(bracket: { total: number; lo: number; hi: number }, rng: () => number, keys: readonly string[]): Record<string, number> {
  const vals = ZERO_REFINEMENTS();
  if (keys.length === 0) return vals;
  for (const k of keys) vals[k] = bracket.lo;
  let budget = bracket.total - bracket.lo * keys.length;
  if (budget > 0) {
    // Spend a random 70-100% of the leftover budget for roster variety.
    budget = Math.floor(budget * (0.7 + rng() * 0.3));
    while (budget > 0) {
      const open = keys.filter(k => vals[k] < bracket.hi);
      if (open.length === 0) break;
      const k = open[Math.floor(rng() * open.length)];
      const add = Math.min(bracket.hi - vals[k], 1 + Math.floor(rng() * 3), budget);
      vals[k] += add;
      budget -= add;
    }
  }
  return vals;
}

/**
 * Cuts a refinement map down to the handful the fighter brings into the ring —
 * their highest levels — zeroing the rest. Purchased levels are not refunded
 * anywhere else, but a roster opponent has no pick list of its own, so the
 * trim is what its map means.
 */
export function trimRefinementsToActive(ref: Record<string, number> | null | undefined): Record<string, number> {
  const src = ref ?? {};
  const keep = REFINEMENT_KEYS
    .filter(k => (src[k] ?? 0) > 0)
    .sort((a, b) => (src[b] ?? 0) - (src[a] ?? 0))
    .slice(0, MAX_ACTIVE_REFINEMENTS);
  const out = ZERO_REFINEMENTS();
  for (const k of keep) out[k] = src[k];
  return out;
}

/**
 * One-time trim of every roster opponent down to the refinements they bring
 * into the ring. Levels, stats, records and ranks are untouched — only the
 * refinements past the cap are zeroed. Stamped so reloading a save never
 * re-trims a roster whose loadouts have since moved on; a save stamped back
 * when the cap was five keeps the five it was trimmed to.
 */
export function applyRefinementFiveCap(state: CareerRosterState): CareerRosterState {
  if (state.refinementFiveCapApplied) return state;
  const roster = state.roster.map(f => {
    if (!f.customRefinementSkills) return f;
    return { ...f, customRefinementSkills: trimRefinementsToActive(f.customRefinementSkills) };
  });
  return { ...state, roster, refinementFiveCapApplied: true };
}

/**
 * Regenerates every AI roster fighter's level, stats and refinements from the
 * current (custom) roster-generation config, keeping ranks, records, ratings
 * and identity intact. Used by the Roster Generation editor's Save button to
 * overwrite the current career roster with the new NPC numbers.
 */
export function regenerateRosterNumbers(state: CareerRosterState, seed: number): CareerRosterState {
  const rng = seededRandom(Math.abs(seed) + 7717);
  const archetypeById = new Map(ROSTER_DATA.map(r => [r.id, r.archetype as Archetype]));
  const roster = state.roster.map(f => {
    if (f.rank <= 0) return f;
    const archetype = archetypeById.get(f.id) ?? "BoxerPuncher";
    const level = sampleLevelForRank(f.rank, rng);
    const gen = generateFighterStats(f.rank, archetype, rng, undefined, f.id);
    return {
      ...f,
      level,
      statPower: gen.statPower,
      statSpeed: gen.statSpeed,
      statDefense: gen.statDefense,
      statStamina: gen.statStamina,
      statFocus: gen.statFocus,
      overallRating: gen.overallRating,
      customRefinementSkills: gen.generatedRefinements,
    };
  });
  // Snap everything (levels, stats AND the 15 refinements) onto the freshly
  // saved bands, then mark the refinement generations as applied so a later
  // slot load can't re-roll the numbers the user just generated.
  enforceGenConfigBands(roster);
  return { ...state, roster, refinementGenV2Applied: true, refinementGenV3Applied: true };
}

// Sum of the refinements a fighter actually brings into the ring (used to
// compare opponents to the player). A player blob carries its own pick list; a
// roster map has none, so its five highest stand in.
export function refinementTotal(sr: Record<string, number> | null | undefined): number {
  if (!sr) return 0;
  const active = activeRefinementsOnly(sr as unknown as Record<string, unknown>) as Record<string, number>;
  return REFINEMENT_KEYS.reduce((sum, k) => sum + (active[k] ?? 0), 0);
}

// One-time regeneration of every active opponent's refinements using the
// bracket spec above. Runs on slot load and at the start of simulateWeek so
// existing careers pick up the new distribution immediately.
export function applyRefinementGenV3(state: CareerRosterState, seed: number): CareerRosterState {
  if (state.refinementGenV3Applied) return state;
  const rng = seededRandom(Math.abs(seed) + 4241);
  const roster = state.roster.map(f => {
    if (f.id === 204 || !f.active || f.retired || f.rank <= 0) return f;
    return { ...f, customRefinementSkills: generateRosterRefinements(f.rank, rng, f.id) };
  });
  return { ...state, roster, refinementGenV3Applied: true, refinementGenV2Applied: true };
}

/**
 * Fills in refinement keys an existing career's roster was generated without —
 * Life Drain and Bruiser were added after these saves existed, and their one-time
 * regeneration flags stop the whole roster from being re-rolled. Each missing
 * key is seeded from the fighter's own refinement average, so an opponent
 * picks the skill up at the level the rest of their kit sits at instead of a
 * flat zero. Idempotent: a roster that already has every key is returned as-is.
 */
export function backfillMissingRefinements(state: CareerRosterState): CareerRosterState {
  let changed = false;
  const roster = state.roster.map(f => {
    const ref = f.customRefinementSkills as Record<string, number> | null | undefined;
    if (!ref) return f;
    const missing = REFINEMENT_KEYS.filter(k => typeof ref[k] !== "number");
    if (missing.length === 0) return f;
    const known = REFINEMENT_KEYS.filter(k => typeof ref[k] === "number");
    const avg = known.length > 0
      ? Math.round(known.reduce((sum, k) => sum + ref[k], 0) / known.length)
      : 0;
    const seeded = Math.max(0, Math.min(100, avg));
    changed = true;
    return { ...f, customRefinementSkills: { ...ref, ...Object.fromEntries(missing.map(k => [k, seeded])) } };
  });
  return changed ? { ...state, roster } : state;
}

function generateFighterStats(rank: number, _archetype: Archetype, rng: () => number, _totalRanks: number = 704, id: number = 0): { statPower: number; statSpeed: number; statDefense: number; statStamina: number; statFocus: number; overallRating: number; generatedRefinements: Record<string, number> } {
  const STAT_CAP = 1000;
  const custom = loadCustomRosterGenConfig();

  if (rank === 1) {
    if (custom) {
      const v = Math.max(1, Math.min(STAT_CAP, custom.rank1Stat));
      return {
        statPower: v, statSpeed: v, statDefense: v, statStamina: v, statFocus: v,
        overallRating: v,
        generatedRefinements: generateRosterRefinements(1, rng, id),
      };
    }
    const vals: [number, number, number, number, number] = [1000, 1000, 998, 1000, 995];
    for (let i = vals.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [vals[i], vals[j]] = [vals[j], vals[i]];
    }
    return {
      statPower: vals[0], statSpeed: vals[1], statDefense: vals[2], statStamina: vals[3], statFocus: vals[4],
      overallRating: Math.round((vals[0] + vals[1] + vals[2] + vals[3] + vals[4]) / 5),
      generatedRefinements: generateRosterRefinements(1, rng, id),
    };
  }

  let minS: number, maxS: number;
  const customBand = custom ? getGenBandForRank(custom, rank) : null;
  if (customBand) {
    minS = Math.max(1, Math.min(customBand.statLo, customBand.statHi));
    maxS = Math.min(STAT_CAP, Math.max(customBand.statLo, customBand.statHi));
  } else if (rank >= 700) {
    minS = 10; maxS = 20;
  } else if (rank >= 651) {
    const t = (699 - rank) / 48;
    minS = Math.round(20 + t * 5);
    maxS = Math.round(45 + t * 30);
  } else if (rank === 650) {
    minS = 75; maxS = 120;
  } else if (rank >= 550) {
    const t = (649 - rank) / 99;
    minS = Math.round(75 + t * 80);
    maxS = Math.round(120 + t * 105);
  } else if (rank >= 400) {
    const t = (549 - rank) / 149;
    minS = Math.round(155 + t * 130);
    maxS = Math.round(225 + t * 200);
  } else if (rank >= 200) {
    const t = (399 - rank) / 199;
    minS = Math.round(285 + t * 365);
    maxS = Math.round(425 + t * 350);
  } else if (rank >= 100) {
    const t = (199 - rank) / 99;
    minS = Math.round(500 + t * 150);
    maxS = Math.round(700 + t * 100);
  } else if (rank >= 50) {
    const t = (99 - rank) / 49;
    minS = Math.round(650 + t * 100);
    maxS = Math.round(800 + t * 100);
  } else if (rank >= 10) {
    const t = (49 - rank) / 39;
    minS = Math.round(750 + t * 150);
    maxS = Math.round(900 + t * 55);
  } else {
    const t = (9 - rank) / 7;
    minS = Math.round(900 + t * 50);
    maxS = Math.round(955 + t * 44);
  }

  const targetAvg = Math.max(1, Math.min(STAT_CAP, minS + Math.floor(rng() * (maxS - minS + 1))));
  const estTotal = targetAvg * 5;
  const maxGap = estTotal >= 3000 ? 100 : estTotal >= 2000 ? 75 : estTotal >= 1000 ? 60 : 30;
  const halfGap = maxGap / 2;

  const attemptGen = (): [number, number, number, number, number] => {
    const variance = halfGap * 0.8;
    const gen = () => Math.max(1, Math.min(STAT_CAP, Math.round(targetAvg + (rng() * 2 - 1) * variance)));
    return [gen(), gen(), gen(), gen(), gen()];
  };

  let best = attemptGen();
  for (let a = 0; a < 7; a++) {
    const cand = attemptGen();
    const gap = Math.max(...cand) - Math.min(...cand);
    if (gap <= maxGap) { best = cand; break; }
    if (gap < Math.max(...best) - Math.min(...best)) best = cand;
  }

  const curGap = Math.max(...best) - Math.min(...best);
  if (curGap > maxGap) {
    const midVal = Math.round(best.reduce((a, b) => a + b, 0) / 5);
    best = best.map(v => {
      const diff = v - midVal;
      return Math.max(1, Math.min(STAT_CAP, Math.round(midVal + (diff > 0 ? Math.min(diff, halfGap) : Math.max(diff, -halfGap)))));
    }) as [number, number, number, number, number];
  }

  const [statPower, statSpeed, statDefense, statStamina, statFocus] = best;
  const overallRating = Math.round((statPower + statSpeed + statDefense + statStamina + statFocus) / 5);
  return { statPower, statSpeed, statDefense, statStamina, statFocus, overallRating, generatedRefinements: generateRosterRefinements(rank, rng, id) };
}

function growStatsFromLevel(f: RosterFighterState, _endgame: boolean = false): void {
  const cap = 1000;
  const lvl = Math.max(1, f.level);
  let target = Math.min(cap, Math.round(15 + (lvl - 1) * 978 / 999));

  // Custom Roster Generation config: level-based stat growth must never push a
  // fighter's stats above the configured band ceiling for their rank.
  const custom = loadCustomRosterGenConfig();
  if (custom && f.rank > 0) {
    const bandHi = f.rank === 1
      ? Math.max(1, Math.min(cap, custom.rank1Stat))
      : (() => {
          const band = getGenBandForRank(custom, f.rank);
          return band ? Math.max(1, Math.min(cap, Math.max(band.statLo, band.statHi))) : cap;
        })();
    target = Math.min(target, bandHi);
  }

  const cur = f.overallRating ?? Math.round(
    ((f.statPower ?? 0) + (f.statSpeed ?? 0) + (f.statDefense ?? 0) + (f.statStamina ?? 0) + (f.statFocus ?? 0)) / 5
  );
  if (cur >= target) return;

  if (cur <= 0) {
    // Jitter each stat individually (stable per-fighter hash) instead of
    // assigning the same value to all five.
    const jit = (key: string): number => {
      let h = 2166136261 ^ f.id;
      for (let i = 0; i < key.length; i++) { h = Math.imul(h ^ key.charCodeAt(i), 16777619); }
      h ^= h >>> 13; h = Math.imul(h, 1274126177); h ^= h >>> 16;
      const r = (h >>> 0) / 4294967296; // [0,1)
      const spread = Math.max(2, Math.round(target * 0.15));
      return Math.max(1, Math.min(cap, Math.round(target + (r * 2 - 1) * spread)));
    };
    f.statPower = jit("power");
    f.statSpeed = jit("speed");
    f.statDefense = jit("defense");
    f.statStamina = jit("stamina");
    f.statFocus = jit("focus");
  } else {
    const scale = target / cur;
    f.statPower = Math.min(cap, Math.round((f.statPower ?? 0) * scale));
    f.statSpeed = Math.min(cap, Math.round((f.statSpeed ?? 0) * scale));
    f.statDefense = Math.min(cap, Math.round((f.statDefense ?? 0) * scale));
    f.statStamina = Math.min(cap, Math.round((f.statStamina ?? 0) * scale));
    f.statFocus = Math.min(cap, Math.round((f.statFocus ?? 0) * scale));
  }
  f.overallRating = Math.round(
    ((f.statPower ?? 0) + (f.statSpeed ?? 0) + (f.statDefense ?? 0) + (f.statStamina ?? 0) + (f.statFocus ?? 0)) / 5
  );
}

/**
 * Stable per-fighter/per-key pseudo-random in [0,1). Keyed on the fighter's id
 * so the same fighter always lands on the same point of a band no matter how
 * many times generation, enforcement or a backfill runs over them.
 */
function hashRand01(id: number, key: string, salt: number): number {
  let h = 2166136261 ^ id;
  for (let i = 0; i < key.length; i++) { h = Math.imul(h ^ key.charCodeAt(i), 16777619); }
  h = Math.imul(h ^ salt, 16777619);
  h ^= h >>> 13; h = Math.imul(h, 1274126177); h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/**
 * The Punch Endurance a fighter of this rank is generated with — a stable point
 * inside their Roster Generation band. Drawn from the fighter's id rather than
 * the seeded generator so it can be handed out at generation, backfilled onto an
 * older save and re-enforced later without ever shifting an rng draw order.
 * Falls back to the 20 floor when no band covers them.
 */
export function rollPunchEnduranceForRank(rank: number, id: number, cfg: RosterGenConfig | null = loadCustomRosterGenConfig()): number {
  const [lo, hi] = getPeRangeForRank(cfg, rank);
  if (hi <= lo) return lo;
  return clampPunchEndurance(Math.round(lo + hashRand01(id, "pe", rank) * (hi - lo)));
}

/**
 * The single Equipment Upgrade level a fighter of this rank is generated with,
 * worn in all five slots. Drawn from the fighter's id the same way Punch
 * Endurance is, so it survives regeneration and backfills without ever touching
 * the seeded weekly draw order. 0 when no band covers them or none is configured.
 */
export function rollEquipmentForRank(rank: number, id: number, cfg: RosterGenConfig | null = loadCustomRosterGenConfig()): number {
  const [lo, hi] = getEquipRangeForRank(cfg, rank);
  if (hi <= lo) return lo;
  return clampEquipLevel(Math.round(lo + hashRand01(id, "equip", rank) * (hi - lo)));
}

/**
 * Punch Endurance arrived after these saves existed: every fighter without one
 * is seeded from their band (the 20 floor when no custom config is saved).
 * Idempotent — a roster that already has the field is returned as-is.
 */
/**
 * Drilled Actions arrived after these saves existed. An array — even an empty
 * one — is the stamp, so a career that has simply never drilled anything is
 * never mistaken for one that has not been through here yet. Idempotent.
 */
export function backfillDrilledActions(state: CareerRosterState): CareerRosterState {
  if (Array.isArray(state.drilledActions)) return state;
  return { ...state, drilledActions: [] };
}

export function backfillPunchEndurance(state: CareerRosterState): CareerRosterState {
  const cfg = loadCustomRosterGenConfig();
  let changed = false;
  const roster = state.roster.map(f => {
    if (typeof f.punchEndurance === "number" && Number.isFinite(f.punchEndurance)) return f;
    changed = true;
    return { ...f, punchEndurance: rollPunchEnduranceForRank(f.rank, f.id, cfg) };
  });
  const punchEndurance = punchEnduranceOf(state);
  if (state.punchEndurance !== punchEndurance) changed = true;
  // The per-drain cost is a percentage of the pool now. A career still carrying
  // a point-era number would read as a ruinous percentage — the old 20-point
  // ceiling as a fifth of the tank — so it is re-based to the opening rate once
  // and stamped, and the heavy bag earns it back down from there.
  const rebaseLoss = needsPunchEnduranceLossRebase(state.punchEnduranceLossPct);
  if (rebaseLoss) changed = true;
  if (!changed) return state;
  const next: CareerRosterState = { ...state, roster, punchEndurance };
  if (rebaseLoss) {
    next.punchEnduranceLoss = PUNCH_ENDURANCE_LOSS_MIN;
    next.punchEnduranceLossPct = true;
  }
  return next;
}

/**
 * Hard enforcement of the custom Roster Generation config: clamps every ranked
 * fighter's level, 5 base stats and refinement values into the configured band
 * for their current rank (rank 1 = the manual champion values). No-op when no
 * custom config is saved. This is THE authority on roster numbers — it runs
 * after generation, load-time redistribution and weekly simulation, so no other
 * growth/respawn/merge logic can push numbers outside the user's ranges.
 * Endgame (champion beaten) is exempt: its levels are player-relative by design.
 */
export function enforceGenConfigBands(roster: RosterFighterState[]): void {
  const custom = loadCustomRosterGenConfig();
  if (!custom) return;
  if (isChampBeaten(roster)) return;
  // When a value falls outside its band we re-roll it to a random point INSIDE
  // the band instead of pinning it to the edge (which made whole rank ranges
  // show identical numbers). Hash-based so repeated passes are idempotent.
  const clampOrRoll = (v: number, lo: number, hi: number, id: number, key: string, salt: number): number => {
    if (Number.isFinite(v) && v >= lo && v <= hi) return v;
    return Math.round(lo + hashRand01(id, key, salt) * (hi - lo));
  };
  const clamp = (v: number, lo: number, hi: number) =>
    Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : lo;
  for (const f of roster) {
    if (!f.active || f.retired || f.rank <= 0) continue;
    let levelLo: number, levelHi: number, statLo: number, statHi: number, refLo: number, refHi: number;
    let peLo: number, peHi: number;
    if (f.rank === 1 || f.id === 204) {
      const lv = Math.max(1, custom.rank1Level);
      const st = Math.max(1, Math.min(1000, custom.rank1Stat));
      const rf = Math.max(0, Math.min(100, custom.rank1Ref));
      const pe = clampPunchEndurance(custom.rank1Pe);
      levelLo = lv; levelHi = lv; statLo = st; statHi = st; refLo = rf; refHi = rf;
      peLo = pe; peHi = pe;
    } else {
      const band = getGenBandForRank(custom, f.rank);
      if (!band) continue;
      levelLo = Math.max(1, Math.min(band.levelLo, band.levelHi));
      levelHi = Math.max(1, Math.max(band.levelLo, band.levelHi));
      statLo = Math.max(1, Math.min(band.statLo, band.statHi));
      statHi = Math.min(1000, Math.max(band.statLo, band.statHi));
      refLo = Math.max(0, Math.min(band.refLo, band.refHi));
      refHi = Math.min(100, Math.max(band.refLo, band.refHi));
      [peLo, peHi] = getPeRangeForRank(custom, f.rank);
    }
    f.punchEndurance = (f.rank === 1 || f.id === 204)
      ? clamp(f.punchEndurance ?? peLo, peLo, peHi)
      : clampOrRoll(f.punchEndurance ?? NaN, peLo, peHi, f.id, "pe", f.rank);
    // Equipment is seeded from the band when a fighter has none and lifted when
    // it sits under the band, but never pulled back down: weekly growth is meant
    // to carry an opponent past the range they were generated in.
    {
      const [eqLo, eqHi] = getEquipRangeForRank(custom, f.rank);
      const cur = f.equipmentLevel;
      if (cur == null || !Number.isFinite(cur)) {
        f.equipmentLevel = (f.rank === 1 || f.id === 204)
          ? eqLo
          : clampOrRoll(NaN, eqLo, eqHi, f.id, "equip", f.rank);
      } else {
        f.equipmentLevel = clampEquipLevel(Math.max(cur, eqLo));
      }
    }
    if (f.rank === 1 || f.id === 204) {
      // Manual champion values are exact, not a range.
      f.level = clamp(f.level, levelLo, levelHi);
      f.statPower = clamp(f.statPower ?? statLo, statLo, statHi);
      f.statSpeed = clamp(f.statSpeed ?? statLo, statLo, statHi);
      f.statDefense = clamp(f.statDefense ?? statLo, statLo, statHi);
      f.statStamina = clamp(f.statStamina ?? statLo, statLo, statHi);
      f.statFocus = clamp(f.statFocus ?? statLo, statLo, statHi);
    } else {
      f.level = clampOrRoll(f.level, levelLo, levelHi, f.id, "level", f.rank);
      f.statPower = clampOrRoll(f.statPower ?? -1, statLo, statHi, f.id, "power", f.rank);
      f.statSpeed = clampOrRoll(f.statSpeed ?? -1, statLo, statHi, f.id, "speed", f.rank);
      f.statDefense = clampOrRoll(f.statDefense ?? -1, statLo, statHi, f.id, "defense", f.rank);
      f.statStamina = clampOrRoll(f.statStamina ?? -1, statLo, statHi, f.id, "stamina", f.rank);
      f.statFocus = clampOrRoll(f.statFocus ?? -1, statLo, statHi, f.id, "focus", f.rank);
    }
    f.overallRating = Math.round((f.statPower + f.statSpeed + f.statDefense + f.statStamina + f.statFocus) / 5);
    // Enforcement must be total: fighters entering via merge/respawn paths may
    // lack a refinement map entirely — build it here so bands always apply.
    if (!f.customRefinementSkills) f.customRefinementSkills = {};
    // Only the band's configured number of refinements is filled — everything
    // else is zeroed. Without that this pass would quietly refill all sixteen on
    // every load and undo the five-active cap.
    const chosenRank = (f.rank === 1 || f.id === 204) ? 1 : f.rank;
    const chosen = new Set(pickRefinementKeys(
      f.id,
      getRefCountForRank(custom, chosenRank),
      getForcedRefinementsForRank(custom, chosenRank),
    ));
    for (const k of REFINEMENT_KEYS) {
      if (!chosen.has(k)) { f.customRefinementSkills[k] = 0; continue; }
      f.customRefinementSkills[k] = (f.rank === 1 || f.id === 204)
        ? clamp(f.customRefinementSkills[k] ?? refLo, refLo, refHi)
        : clampOrRoll(f.customRefinementSkills[k] ?? NaN, refLo, refHi, f.id, "ref:" + k, f.rank);
    }
  }
}

function enforceRankingIntegrity(roster: RosterFighterState[]): void {
  // With a custom Roster Generation config the user's band ranges are the source
  // of truth. Bands are ranges, so adjacent fighters legitimately overlap; the
  // monotonic downscale below would compound across 700 fighters and crush the
  // configured stats (e.g. 333-444 bands decaying to ~12 by rank 300). Skip it.
  if (loadCustomRosterGenConfig()) return;
  const active = roster.filter(f => f.active && f.rank > 0).sort((a, b) => a.rank - b.rank);
  for (let i = 1; i < active.length; i++) {
    const prev = active[i - 1];
    const curr = active[i];
    const prevRating = prev.overallRating ?? 0;
    const currRating = curr.overallRating ?? 0;
    if (currRating > prevRating) {
      const scale = prevRating / currRating * 0.98;
      curr.statPower = Math.round((curr.statPower ?? 0) * scale);
      curr.statSpeed = Math.round((curr.statSpeed ?? 0) * scale);
      curr.statDefense = Math.round((curr.statDefense ?? 0) * scale);
      curr.statStamina = Math.round((curr.statStamina ?? 0) * scale);
      curr.statFocus = Math.round((curr.statFocus ?? 0) * scale);
      curr.overallRating = Math.round(((curr.statPower ?? 0) + (curr.statSpeed ?? 0) + (curr.statDefense ?? 0) + (curr.statStamina ?? 0) + (curr.statFocus ?? 0)) / 5);
    }
  }
}

const ROSTER_CUSTOMIZATIONS_KEY = "handz_roster_customizations";
const RANK_EDITS_KEY = "handz_roster_rank_edits";
const RANK_EDITS_PENDING_KEY = "handz_roster_rank_edits_pending";

export function saveRankEdits(roster: RosterFighterState[]): void {
  const rankEdits: Record<number, { customSkillPoints?: RosterFighterState["customSkillPoints"]; customRefinementSkills?: Record<string, number> }> = {};
  for (const f of roster) {
    if (!f.active || f.retired) continue;
    rankEdits[f.rank] = {
      customSkillPoints: f.customSkillPoints,
      customRefinementSkills: f.customRefinementSkills,
    };
  }
  try {
    localStorage.setItem(RANK_EDITS_KEY, JSON.stringify(rankEdits));
    localStorage.setItem(RANK_EDITS_PENDING_KEY, "true");
  } catch {}
}

export function isRankEditsPending(): boolean {
  try { return localStorage.getItem(RANK_EDITS_PENDING_KEY) === "true"; } catch { return false; }
}

export function clearRankEditsPending(): void {
  try { localStorage.removeItem(RANK_EDITS_PENDING_KEY); } catch {}
}

export function applyRankEditsToRoster(roster: RosterFighterState[]): RosterFighterState[] {
  try {
    const raw = localStorage.getItem(RANK_EDITS_KEY);
    if (!raw) return roster;
    const rankEdits: Record<string, { customSkillPoints?: RosterFighterState["customSkillPoints"]; customRefinementSkills?: Record<string, number> }> = JSON.parse(raw);
    return roster.map(f => {
      if (!f.active || f.retired) return f;
      const edit = rankEdits[String(f.rank)];
      if (!edit) return f;
      return { ...f, customSkillPoints: edit.customSkillPoints, customRefinementSkills: edit.customRefinementSkills };
    });
  } catch {
    return roster;
  }
}

/** Colour set handed to the renderer for a roster fighter. */
export interface RosterColorSet {
  skin: string;
  gloves: string;
  gloveTape: string;
  trunks: string;
  shoes: string;
  socks: string;
  laces?: string;
  soles?: string;
  waistStripe?: string;
}

interface RosterCustomization {
  customFirstName?: string;
  customNickname?: string;
  customLastName?: string;
  customSkinColor?: string;
  customGloves?: string;
  customGloveTape?: string;
  customTrunks?: string;
  customShoes?: string;
  customSocks?: string;
  customLaces?: string;
  customSoles?: string;
  customWaistStripe?: string;
  customSpacial?: boolean;
  customSpacialParts?: string[];
  customRefinementSkills?: Record<string, number>;
  customSkillPoints?: { power: number; speed: number; defense: number; stamina: number; focus: number };
  boxingStance?: "orthodox" | "southpaw";
}

export function loadRosterCustomizations(): Record<number, RosterCustomization> {
  try {
    const raw = localStorage.getItem(ROSTER_CUSTOMIZATIONS_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return {};
}

export function saveRosterCustomizations(roster: RosterFighterState[]): void {
  const customizations: Record<number, RosterCustomization> = loadRosterCustomizations();
  for (const f of roster) {
    const c: RosterCustomization = {};
    if (f.customFirstName) c.customFirstName = f.customFirstName;
    if (f.customNickname) c.customNickname = f.customNickname;
    if (f.customLastName) c.customLastName = f.customLastName;
    if (f.customSkinColor) c.customSkinColor = f.customSkinColor;
    if (f.customGloves) c.customGloves = f.customGloves;
    if (f.customGloveTape) c.customGloveTape = f.customGloveTape;
    if (f.customTrunks) c.customTrunks = f.customTrunks;
    if (f.customShoes) c.customShoes = f.customShoes;
    if (f.customSocks) c.customSocks = f.customSocks;
    if (f.customLaces) c.customLaces = f.customLaces;
    if (f.customSoles) c.customSoles = f.customSoles;
    if (f.customWaistStripe) c.customWaistStripe = f.customWaistStripe;
    if (f.customSpacial) c.customSpacial = true;
    if (f.customSpacialParts?.length) c.customSpacialParts = [...f.customSpacialParts];
    if (f.customRefinementSkills && Object.values(f.customRefinementSkills).some(v => v > 0)) {
      c.customRefinementSkills = { ...f.customRefinementSkills };
    }
    if (f.customSkillPoints && Object.values(f.customSkillPoints).some(v => v > 0)) {
      c.customSkillPoints = { ...f.customSkillPoints };
    }
    if (f.boxingStance) c.boxingStance = f.boxingStance;
    if (Object.keys(c).length > 0) {
      customizations[f.id] = c;
    } else {
      delete customizations[f.id];
    }
  }
  localStorage.setItem(ROSTER_CUSTOMIZATIONS_KEY, JSON.stringify(customizations));
}

/**
 * Strips persisted per-fighter generated numbers (refinements / skill points)
 * from the global roster-customizations store, keeping cosmetic edits (names,
 * colors, stance). Called when a career save is deleted so the next career
 * starts purely from the Roster Generation config.
 */
export function clearRosterCustomizationNumbers(): void {
  try {
    const customizations = loadRosterCustomizations();
    let changed = false;
    for (const key of Object.keys(customizations)) {
      const c = customizations[key as unknown as number];
      if (c.customRefinementSkills || c.customSkillPoints) {
        delete c.customRefinementSkills;
        delete c.customSkillPoints;
        changed = true;
      }
      if (Object.keys(c).length === 0) delete customizations[key as unknown as number];
    }
    if (changed) localStorage.setItem(ROSTER_CUSTOMIZATIONS_KEY, JSON.stringify(customizations));
  } catch {}
}

export function applyRosterCustomizations(roster: RosterFighterState[]): RosterFighterState[] {
  const customizations = loadRosterCustomizations();
  return roster.map(f => {
    const c = customizations[f.id];
    if (!c) return f;
    return {
      ...f,
      customFirstName: f.customFirstName ?? c.customFirstName,
      customNickname: f.customNickname ?? c.customNickname,
      customLastName: f.customLastName ?? c.customLastName,
      customSkinColor: f.customSkinColor ?? c.customSkinColor,
      customGloves: f.customGloves ?? c.customGloves,
      customGloveTape: f.customGloveTape ?? c.customGloveTape,
      customTrunks: f.customTrunks ?? c.customTrunks,
      customShoes: f.customShoes ?? c.customShoes,
      customSocks: f.customSocks ?? c.customSocks,
      customLaces: f.customLaces ?? c.customLaces,
      customSoles: f.customSoles ?? c.customSoles,
      customWaistStripe: f.customWaistStripe ?? c.customWaistStripe,
      customSpacial: f.customSpacial ?? c.customSpacial,
      customSpacialParts: f.customSpacialParts ?? c.customSpacialParts,
      customRefinementSkills: f.customRefinementSkills ?? c.customRefinementSkills,
      customSkillPoints: f.customSkillPoints ?? c.customSkillPoints,
      boxingStance: f.boxingStance ?? c.boxingStance,
    };
  });
}

function seededRandom(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

// true = booked (unavailable). Each lifetime camp training session permanently
// shaves 0.35% off every week's booked chance, so dedicated players eventually
// get to pick any prep length they want (including the normally-locked 1 week).
export function getChampionPrepSchedule(fighterId: number, weekNumber: number, campTrainingSessions: number = 0, careerFightsCompleted: number = Infinity): boolean[] {
  // The player's first 2 career fights: opponents have fully open 8-week availability.
  if (careerFightsCompleted < 2) return [false, false, false, false, false, false, false, false];
  const rng = seededRandom(Math.abs(fighterId * 7919 + weekNumber * 2311 + 1337));
  const bonus = Math.max(0, campTrainingSessions) * 0.0035;
  const booked = (base: number) => rng() < Math.max(0, base - bonus);
  // Weeks 2-8 are drawn first, in the same RNG order as always, so schedules
  // for existing saves (bonus = 0) are unchanged.
  const rest: boolean[] = [
    booked(0.75),
    booked(0.75),
    booked(0.5),
    booked(0.5),
    booked(0.5),
    booked(0.5),
    booked(0.5),
  ];
  // Week 1 was historically always booked; it only gets a chance to open up
  // once the player has banked camp training sessions.
  const week1 = bonus > 0 ? booked(1.0) : true;
  const schedule: boolean[] = [week1, ...rest];
  if (!schedule.slice(1).some(b => !b)) {
    const fi = 1 + Math.floor(rng() * 7);
    schedule[fi] = false;
  }
  return schedule;
}

// Which of an opponent's 5 stats are hidden ("?") on the opponent select screen.
// Deterministically seeded by fighter id, so the same 1-3 stats stay hidden week
// after week until the player books a fight against them (scouted = full reveal).
export type HideableStatKey = "power" | "speed" | "defense" | "stamina" | "focus";
const HIDEABLE_STAT_KEYS: HideableStatKey[] = ["power", "speed", "defense", "stamina", "focus"];
export function getHiddenStatKeys(fighterId: number): HideableStatKey[] {
  const rng = seededRandom(Math.abs(fighterId * 6547 + 9973));
  const count = 1 + Math.floor(rng() * 3); // 1-3 hidden stats
  const keys = [...HIDEABLE_STAT_KEYS];
  // Fisher-Yates partial shuffle
  for (let i = keys.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [keys[i], keys[j]] = [keys[j], keys[i]];
  }
  return keys.slice(0, count);
}

const ELO_K_DEFAULT = 20;

const DIFFICULTY_ELO_MULT: Record<string, number> = {
  journeyman: 0.75,
  contender: 1.0,
  elite: 1.25,
  champion: 1.5,
};

function eloExpected(ratingA: number, ratingB: number): number {
  return 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400));
}

type FightMethod = "close" | "dominant" | "ko";

function performanceFactor(method: FightMethod, isWin: boolean): number {
  if (isWin) {
    if (method === "ko") return 1.4;
    if (method === "dominant") return 1.25;
    return 1.0;
  } else {
    if (method === "ko") return 1.25;
    if (method === "dominant") return 1.1;
    return 0.9;
  }
}

function getVariableK(rank: number | undefined, totalFights: number | undefined, isChampFight: boolean): number {
  if (isChampFight) return 18;
  if (totalFights != null && totalFights === 0) return 45;
  if (rank == null) return ELO_K_DEFAULT;
  if (rank <= 15) return 20;
  if (rank <= 50) return 24;
  if (rank <= 100) return 28;
  return 32;
}

// Rank-gap multiplier: amplifies ELO change based on how far apart the two
// fighters sit on the ladder. Bigger gap → bigger reward for the upset winner
// (and bigger penalty for the favored loser). Bounded so a single win can
// never skip half the roster.
export function rankGapMultiplier(rankA?: number, rankB?: number): number {
  if (rankA == null || rankB == null || rankA <= 0 || rankB <= 0) return 1.0;
  const gap = Math.abs(rankA - rankB);
  if (gap <= 10) return 1.05;  // nearby: tiny bonus
  if (gap <= 25) return 1.15;  // small bonus
  if (gap <= 50) return 1.3;   // moderate bonus
  return 1.5;                  // large bonus (capped)
}

/** Highest either victory boost can pay: +400% on top of the normal ELO gain. */
const VICTORY_BOOST_CAP = 4.0;

/** Both victory boosts stop paying out once the player is inside the top 100. */
const VICTORY_BOOST_RANK_CUTOFF = 100;

/**
 * Rank-upset victory boost. Beating a fighter ranked more than 3 spots above
 * the player pays 7.5% extra ELO for every rank past that third one (the
 * original 5% per rank, multiplied by 1.5).
 * Returns a fraction (0.075 = +7.5%), never more than +400%.
 */
const RANK_UPSET_PER_RANK = 0.05 * 1.5;

export function rankUpsetEloBoost(playerRank?: number, opponentRank?: number): number {
  if (playerRank == null || opponentRank == null || playerRank <= 0 || opponentRank <= 0) return 0;
  if (playerRank <= VICTORY_BOOST_RANK_CUTOFF) return 0;
  const ranksAbove = playerRank - opponentRank; // > 0 → opponent sits above the player
  if (ranksAbove <= 3) return 0;
  return Math.min(VICTORY_BOOST_CAP, (ranksAbove - 3) * RANK_UPSET_PER_RANK);
}

/**
 * Level-upset victory boost. Beating a fighter who started the bout more than 4
 * levels above the player — and at least 1 rank above them — pays 10% extra ELO
 * per level of the gap. Stops paying entirely once the player is top 100.
 * Returns a fraction (0.10 = +10%), never more than +400%.
 */
export function levelUpsetEloBoost(
  playerRank?: number,
  opponentRank?: number,
  playerLevel?: number,
  opponentLevel?: number,
): number {
  if (playerRank == null || opponentRank == null || playerRank <= 0 || opponentRank <= 0) return 0;
  if (playerLevel == null || opponentLevel == null) return 0;
  if (playerRank <= VICTORY_BOOST_RANK_CUTOFF) return 0;
  if (opponentRank >= playerRank) return 0;     // opponent must start at least 1 rank above
  const levelGap = opponentLevel - playerLevel;
  if (levelGap <= 4) return 0;
  return Math.min(VICTORY_BOOST_CAP, levelGap * 0.10);
}

export function computeEloChange(
  winnerRating: number,
  loserRating: number,
  method: FightMethod,
  difficultyMult: number,
  isChampionFight: boolean,
  winnerRank?: number,
  loserRank?: number,
  winnerTotalFights?: number,
  loserTotalFights?: number,
): { winnerDelta: number; loserDelta: number } {
  const expectedWin = eloExpected(winnerRating, loserRating);
  const expectedLose = eloExpected(loserRating, winnerRating);
  const winPerf = performanceFactor(method, true);
  const losePerf = performanceFactor(method, false);
  const gapMult = rankGapMultiplier(winnerRank, loserRank);

  const useVariableK = winnerRank != null || winnerTotalFights != null;
  let winnerDelta: number;
  let loserDelta: number;

  if (useVariableK) {
    const kWin = getVariableK(winnerRank, winnerTotalFights, isChampionFight);
    const kLose = getVariableK(loserRank, loserTotalFights, isChampionFight);
    winnerDelta = kWin * (1 - expectedWin) * winPerf * difficultyMult * gapMult;
    loserDelta = kLose * (0 - expectedLose) * losePerf * difficultyMult * gapMult;
  } else {
    const champWeight = isChampionFight ? 2.0 : 1.0;
    winnerDelta = ELO_K_DEFAULT * (1 - expectedWin) * winPerf * difficultyMult * champWeight;
    loserDelta = ELO_K_DEFAULT * (0 - expectedLose) * losePerf * difficultyMult * champWeight;
  }

  return { winnerDelta, loserDelta };
}

// Nonlinear initial-ELO curve keyed by absolute rank (704-fighter roster).
// Band widths deliberately vary so the ladder is NOT evenly spaced; seeded
// in-band randomness keeps fighters from feeling identical.
// The 651+ band starts at 910 so a fresh player (ELO 900) always sits below
// every generated AI fighter and starts at rank 705.
function tieredInitialElo(rankPos: number, _totalSlots: number, rng: () => number): number {
  if (rankPos === 1) return 2400 + Math.floor(rng() * 201);      // 2400–2600 undefeated champ
  if (rankPos <= 10) return 2200 + Math.floor(rng() * 191);      // 2200–2390
  if (rankPos <= 50) return 2000 + Math.floor(rng() * 191);      // 2000–2190
  if (rankPos <= 100) return 1800 + Math.floor(rng() * 191);     // 1800–1990
  if (rankPos <= 200) return 1600 + Math.floor(rng() * 191);     // 1600–1790
  if (rankPos <= 350) return 1400 + Math.floor(rng() * 191);     // 1400–1590
  if (rankPos <= 500) return 1200 + Math.floor(rng() * 191);     // 1200–1390
  if (rankPos <= 650) return 1050 + Math.floor(rng() * 141);     // 1050–1190
  return 910 + Math.floor(rng() * 131);                          // 910–1040
}

function winStreakBonus(streak: number): number {
  if (streak >= 15) return 50;
  if (streak >= 10) return 35;
  if (streak >= 8) return 24;
  if (streak >= 5) return 15;
  if (streak >= 3) return 8;
  return 0;
}

function inactivityRankPenalty(weeks: number): number {
  if (weeks <= 3) return 0;
  if (weeks <= 8) return weeks - 3;
  if (weeks <= 20) return 5 + (weeks - 8) * 2;
  return 29 + (weeks - 20) * 4;
}

function computeRankingScore(f: RosterFighterState): number {
  return (f.ratingScore ?? 1000)
    + (f.momentum ?? 0)
    + winStreakBonus(f.winStreak ?? 0)
    - inactivityRankPenalty(f.weeksSinceLastFight ?? 0);
}

function generateRecordForLevel(rng: () => number, level: number): Pick<RosterFighterState, "wins" | "losses" | "draws" | "knockouts" | "totalFights"> {
  const t = (level - 1) / 99;

  const minFights = Math.floor(t * 25);
  const maxFights = Math.floor(5 + t * 50);
  const totalFights = minFights + Math.floor(rng() * (maxFights - minFights + 1));

  if (totalFights === 0) {
    return { wins: 0, losses: 0, draws: 0, knockouts: 0, totalFights: 0 };
  }

  const baseWinRate = 0.30 + t * 0.55;
  const winRate = Math.max(0.1, Math.min(0.97, baseWinRate + (rng() * 0.10 - 0.05)));

  const wins = Math.round(totalFights * winRate);
  const remaining = totalFights - wins;
  const drawCount = rng() < 0.15 ? Math.floor(rng() * Math.min(3, remaining)) : 0;
  const losses = remaining - drawCount;
  const knockouts = Math.floor(wins * (0.3 + rng() * 0.4));

  return { wins, losses, draws: drawCount, knockouts, totalFights };
}

function generateUndefeatedRecord(rng: () => number, level: number): Pick<RosterFighterState, "wins" | "losses" | "draws" | "knockouts" | "totalFights"> {
  const t = (level - 1) / 99;
  const totalFights = Math.floor(20 + t * 35 + rng() * 10);
  const draws = rng() < 0.2 ? Math.floor(rng() * 2) : 0;
  const wins = totalFights - draws;
  const knockouts = Math.floor(wins * (0.4 + rng() * 0.3));
  return { wins, losses: 0, draws, knockouts, totalFights };
}

function generateHighWinRecord(rng: () => number, _level: number): Pick<RosterFighterState, "wins" | "losses" | "draws" | "knockouts" | "totalFights"> {
  const wins = 15 + Math.floor(rng() * 66); // 15–80
  // Enforce ≥90% win ratio: losses + draws ≤ floor(wins / 9)
  const maxNonWins = Math.max(0, Math.floor(wins / 9));
  const losses = maxNonWins > 0 ? Math.floor(rng() * (maxNonWins + 1)) : 0;
  const remainingNonWins = maxNonWins - losses;
  const draws = remainingNonWins > 0 && rng() < 0.15 ? 1 : 0;
  const knockouts = Math.floor(wins * (0.4 + rng() * 0.3));
  const totalFights = wins + losses + draws;
  return { wins, losses, draws, knockouts, totalFights };
}

function difficultyForLevel(_level: number, careerDifficulty: AIDifficulty, rng: () => number): AIDifficulty {
  const roll = rng();

  if (careerDifficulty === "champion") {
    return roll < 0.15 ? "elite" : "champion";
  } else if (careerDifficulty === "elite") {
    if (roll < 0.15) return "contender";
    if (roll < 0.95) return "elite";
    return "champion";
  } else if (careerDifficulty === "contender") {
    if (roll < 0.10) return "journeyman";
    if (roll < 0.90) return "contender";
    return "elite";
  } else {
    if (roll < 0.25) return "journeyman";
    if (roll < 0.95) return "contender";
    return "elite";
  }
}

export function initRosterState(playerSeed: string, careerDifficulty?: AIDifficulty): CareerRosterState {
  let seed = 0;
  for (let i = 0; i < playerSeed.length; i++) {
    seed = ((seed << 5) - seed + playerSeed.charCodeAt(i)) | 0;
  }
  const rng = seededRandom(Math.abs(seed) + 42);
  const cd: AIDifficulty = careerDifficulty || "contender";

  const keyIds = new Set(KEY_FIGHTER_IDS);
  const keyEntries = ROSTER_DATA.filter(r => keyIds.has(r.id));
  const nonKeyEntries = ROSTER_DATA.filter(r => !keyIds.has(r.id));

  const hardestForDifficulty: Record<AIDifficulty, AIDifficulty> = {
    journeyman: "elite",
    contender: "elite",
    elite: "champion",
    champion: "champion",
  };
  const keyDifficulty = hardestForDifficulty[cd];

  // Spread key fighters within top-50 slots so they always seed at 2100-2400 ELO
  const KEY_TOP_SLOTS = Math.min(50, Math.max(keyEntries.length, 10));
  const keySlots: number[] = [];
  const spreadStep = Math.max(1, Math.floor(KEY_TOP_SLOTS / keyEntries.length));
  for (let i = 0; i < keyEntries.length; i++) {
    const base = 1 + i * spreadStep;
    const jitter = Math.floor(rng() * Math.max(1, Math.floor(spreadStep / 3)));
    keySlots.push(Math.max(1, Math.min(KEY_TOP_SLOTS, base + jitter)));
  }
  keySlots.sort((a, b) => a - b);
  // Deduplicate slots (push collisions forward by 1)
  for (let i = 1; i < keySlots.length; i++) {
    if (keySlots[i] <= keySlots[i - 1]) keySlots[i] = keySlots[i - 1] + 1;
  }
  // Champion (id 204) always gets rank 1
  const wolfIdx = keyEntries.findIndex(e => e.id === 204);
  if (wolfIdx >= 0 && keySlots[wolfIdx] !== 1) {
    // Swap the slot assigned to wolf to position 0 (rank 1)
    const wolfSlot = keySlots[wolfIdx];
    keySlots[wolfIdx] = keySlots[0];
    keySlots[0] = wolfSlot;
    // Now re-sort so rank-1 is first
    keySlots.sort((a, b) => a - b);
  }

  const totalSlots = ACTIVE_ROSTER_SIZE;
  const allRankSlots: { rankPos: number; entry: RosterEntry | null; isKey: boolean }[] = [];
  for (let r = 1; r <= totalSlots; r++) {
    allRankSlots.push({ rankPos: r, entry: null, isKey: false });
  }

  for (let i = 0; i < keyEntries.length; i++) {
    const slot = Math.min(keySlots[i], totalSlots);
    allRankSlots[slot - 1].entry = keyEntries[i];
    allRankSlots[slot - 1].isKey = true;
  }

  // Split non-key entries into priority tiers:
  //   1. always-undefeated new fighters (guaranteed top active slots)
  //   2. original fighters IDs 1–204 (preserve all in active pool as before)
  //   3. new high-win fighters IDs 205+ (fill remaining active slots, roughly half active)
  //   4. new normal fighters IDs 205+ (reserve/bottom of active)
  const tierAlwaysUndefeated = nonKeyEntries.filter(r => r.alwaysUndefeated);
  const tierOriginal = nonKeyEntries.filter(r => r.id < 205 && !r.alwaysUndefeated);
  const tierHighWinNew = nonKeyEntries.filter(r => r.id >= 205 && (r.highWinRatio ?? false) && !r.alwaysUndefeated);
  const tierNormalNew = nonKeyEntries.filter(r => r.id >= 205 && !(r.highWinRatio ?? false) && !r.alwaysUndefeated);

  const shuffleTier = (arr: RosterEntry[]) => {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
  };
  shuffleTier(tierAlwaysUndefeated);
  shuffleTier(tierOriginal);
  shuffleTier(tierHighWinNew);
  shuffleTier(tierNormalNew);

  // Order: always-undefeated → original fighters → new high-win → new normal
  // With ACTIVE_ROSTER_SIZE=450: 7 key + 10 alwaysUndefeated + ~197 originals + ~236 new ≈ 450
  const shuffledNonKey = [...tierAlwaysUndefeated, ...tierOriginal, ...tierHighWinNew, ...tierNormalNew];

  let nkIdx = 0;
  for (let r = 0; r < totalSlots; r++) {
    if (!allRankSlots[r].entry && nkIdx < shuffledNonKey.length) {
      allRankSlots[r].entry = shuffledNonKey[nkIdx++];
    }
  }

  const reserveEntries = shuffledNonKey.slice(nkIdx);

  const roster: RosterFighterState[] = [];

  for (let r = 0; r < allRankSlots.length; r++) {
    const slot = allRankSlots[r];
    if (!slot.entry) continue;
    const entry = slot.entry;
    const rankPos = r + 1;

    // Generation rank: only the champion (id 204) gets rank-1 numbers — he is
    // pinned to rank 1 by the belt after the ELO re-sort. A non-champ fighter
    // that happens to sit in slot 1 is generated from the rank-2 band instead
    // (mirrors the ELO seeding below).
    const genRank = entry.id === 204 ? 1 : Math.max(2, rankPos);
    let level: number;
    if (genRank === 1) {
      const custom = loadCustomRosterGenConfig();
      level = custom ? Math.max(1, custom.rank1Level) : 1000;
    } else {
      level = sampleLevelForRank(genRank, rng);
    }

    let fighterDifficulty: AIDifficulty;
    if (slot.isKey) {
      fighterDifficulty = keyDifficulty;
    } else {
      fighterDifficulty = difficultyForLevel(level, cd, rng);
    }

    let record;
    if (entry.forceUndefeated || entry.alwaysUndefeated) {
      record = generateUndefeatedRecord(rng, level);
    } else if (entry.highWinRatio) {
      record = generateHighWinRecord(rng, level);
    } else {
      record = generateRecordForLevel(rng, level);
    }

    const armLength = Math.round(58 + rng() * 17);
    const { generatedRefinements, ...statFields } = generateFighterStats(genRank, entry.archetype, rng, ACTIVE_ROSTER_SIZE, entry.id);

    // Everyone is seeded from the nonlinear rank-band curve. The champion
    // (id 204) always gets the rank-1 band (2400–2600) since the belt pins him
    // to rank 1; a non-champ fighter that landed in slot 1 is seeded from the
    // rank-2 band instead so only the champ carries a rank-1-band ELO.
    const eloBandRank = entry.id === 204 ? 1 : Math.max(2, rankPos);
    const initialElo = tieredInitialElo(eloBandRank, totalSlots, rng);
    // Always attach the generated refinements — even an all-zero map. Leaving it
    // undefined would let stale global roster customizations (from a previous,
    // deleted save) leak into a fresh career via applyRosterCustomizations.
    const hasRefinements = true;
    roster.push({
      id: entry.id,
      ...record,
      level,
      armLength,
      active: true,
      retired: false,
      rank: rankPos,
      ratingScore: initialElo,
      beatenByPlayer: false,
      ...(entry.alwaysUndefeated ? { alwaysUndefeated: true } : {}),
      fighterDifficulty,
      ...generateFighterColors(rng, entry.id),
      ...statFields,
      ...(hasRefinements ? { customRefinementSkills: generatedRefinements } : {}),
      // Same generation rank the stats use, so the champion draws his manual
      // value and everyone else their own band's.
      punchEndurance: rollPunchEnduranceForRank(genRank, entry.id),
      equipmentLevel: rollEquipmentForRank(genRank, entry.id),
      momentum: 0,
      winStreak: 0,
      loseStreak: 0,
      drawStreak: 0,
      weeksSinceLastFight: 0,
      lastFightResults: [],
      lastOpponentId: undefined,
      lastOpponentWeek: undefined,
      boxingStance: rng() < 0.85 ? "orthodox" : "southpaw",
    });
  }

  for (const entry of reserveEntries) {
    const reserveLevel = Math.floor(1 + rng() * 30);
    const armLength = Math.round(58 + rng() * 17);
    const reserveRank = ACTIVE_ROSTER_SIZE + 1 + roster.length - allRankSlots.length;
    const { generatedRefinements: _resRefs, ...reserveStats } = generateFighterStats(Math.max(701, reserveRank), entry.archetype, rng, ACTIVE_ROSTER_SIZE, entry.id);
    roster.push({
      id: entry.id,
      wins: 0, losses: 0, draws: 0, knockouts: 0, totalFights: 0,
      level: reserveLevel,
      armLength,
      active: false,
      retired: false,
      rank: 0,
      ratingScore: 910,
      beatenByPlayer: false,
      fighterDifficulty: "journeyman",
      ...generateFighterColors(rng, entry.id),
      ...reserveStats,
      punchEndurance: rollPunchEnduranceForRank(Math.max(701, reserveRank), entry.id),
      equipmentLevel: rollEquipmentForRank(Math.max(701, reserveRank), entry.id),
      momentum: 0,
      winStreak: 0,
      loseStreak: 0,
      drawStreak: 0,
      weeksSinceLastFight: 0,
      lastFightResults: [],
      lastOpponentId: undefined,
      lastOpponentWeek: undefined,
      boxingStance: rng() < 0.85 ? "orthodox" : "southpaw",
    });
  }

  // Guarantee: always-undefeated fighters that ended up in reserve must be swapped
  // into an active slot (replace the lowest-rated active normal fighter)
  for (const f of roster) {
    if (!f.alwaysUndefeated || f.active) continue;
    // Find the lowest-rated active fighter that is not key and not alwaysUndefeated
    const keyIdSet = new Set(KEY_FIGHTER_IDS);
    const candidates = roster.filter(c => c.active && !keyIdSet.has(c.id) && !c.alwaysUndefeated);
    candidates.sort((a, b) => a.ratingScore - b.ratingScore);
    if (candidates.length > 0) {
      const swap = candidates[0];
      swap.active = false;
      swap.rank = 0;
      f.active = true;
      f.ratingScore = 1200 + Math.floor(seededRandom(f.id * 6271)() * 150);
    }
  }

  enforceRankingIntegrity(roster);
  updateRankings(roster, 204);

  const customizedRoster = applyRosterCustomizations(roster);
  enforceGenConfigBands(customizedRoster);

  // Player starts dead-last at rank 705: ELO 900 is the low end of the bottom
  // band (900–1040) and below every generated AI fighter (band floor 910) and
  // every reserve (910), so the fresh-career rank is always TOTAL_ROSTER + 1.
  const state: CareerRosterState = {
    roster: customizedRoster,
    weekNumber: 0,
    newsItems: ["Welcome to the boxing world! Your career begins now."],
    selectedOpponentId: null,
    playerRank: TOTAL_ROSTER + 1,
    playerRatingScore: 900,
    trainingsSinceLastWeek: 0,
    rank1HolderId: 204,
    // Nobody in a fresh career has tape on the player yet. Stated outright
    // rather than left undefined so a career started from an existing fighter
    // can never inherit the last one's book on them.
    aiPatternLibrary: [],
    // And nothing drilled yet. Stated for the same reason, and so the load-time
    // backfill has nothing to do on a career that was born with the feature.
    drilledActions: [],
    // Fresh rosters are generated with the current refinement rules (and the
    // custom Roster Generation config, if saved) — mark the migrations applied
    // so the load path never resamples what was just generated.
    refinementGenV2Applied: true,
    refinementGenV3Applied: true,
    // Born with the paid sparring unlocks in place, so this career buys them
    // like everyone else — only saves from before them are grandfathered.
    sparringUnlocksMigrated: true,
    // Every career opens at 1% of max stamina per drain, stamped as a percentage
    // from birth: an unstamped value reads as point-era on the way back in, and
    // the load path would keep re-basing away whatever the weeks and the heavy
    // bag had since moved it to.
    punchEnduranceLoss: PUNCH_ENDURANCE_LOSS_MIN,
    punchEnduranceLossPct: true,
  };

  validateNewRoster(state);

  return state;
}

// Sanity checks for a freshly generated roster. Logs warnings instead of
// throwing so a save is never bricked by a validation edge case.
function validateNewRoster(state: CareerRosterState): void {
  const ranked = state.roster.filter(f => !f.retired && f.rank > 0);
  if (ranked.length !== TOTAL_ROSTER) {
    console.warn(`[roster] expected ${TOTAL_ROSTER} ranked AI fighters, got ${ranked.length}`);
  }
  if (state.playerRank !== TOTAL_ROSTER + 1) {
    console.warn(`[roster] player should start at rank ${TOTAL_ROSTER + 1}, got ${state.playerRank}`);
  }
  const rank1 = ranked.find(f => f.rank === 1);
  if (!rank1 || rank1.id !== 204 || state.rank1HolderId !== 204) {
    console.warn(`[roster] rank 1 must be the protected champion (id 204), got ${rank1?.id}`);
  }
  if (rank1 && rank1.losses > 0) {
    console.warn(`[roster] rank 1 champion must be undefeated (losses=${rank1.losses})`);
  }
  // Nonlinear band monotonicity: average ELO must strictly decrease per band.
  const bands: [number, number][] = [[1, 1], [2, 10], [11, 50], [51, 100], [101, 200], [201, 350], [351, 500], [501, 650], [651, TOTAL_ROSTER]];
  let prevAvg = Infinity;
  for (const [lo, hi] of bands) {
    const inBand = ranked.filter(f => f.rank >= lo && f.rank <= hi);
    if (inBand.length === 0) continue;
    const avg = inBand.reduce((s, f) => s + f.ratingScore, 0) / inBand.length;
    if (avg >= prevAvg) {
      console.warn(`[roster] ELO bands not monotonic: ranks ${lo}-${hi} avg ${Math.round(avg)} >= previous ${Math.round(prevAvg)}`);
    }
    prevAvg = avg;
  }
}

// Rank 1 is a sticky "belt" — whoever currently holds it (Aruzenai Jr initially, id 204)
// stays rank 1 regardless of rating until they lose a fight, at which point the fighter
// (or the player) who beat them takes over rank 1. `rank1HolderId` in CareerRosterState
// tracks the current holder ("player" once the player wins the belt). For older saves that
// predate this field, fall back to inferring a holder: 204 while unbeaten by the player,
// otherwise assume the player (the most common way the champ was beaten historically).
export function resolveRank1Holder(roster: RosterFighterState[], rank1HolderId?: number | "player"): number | "player" {
  // Self-heal: while Aruzenai Jr (204) has not been beaten by the player, no AI fighter
  // can legitimately hold the belt (he wins 100% of simulated fights). Saves from before
  // this rule could have an AI holder — restore the belt to 204. Never touches "player".
  const champUnbeaten = roster.some(f => f.id === 204 && !f.beatenByPlayer);
  if (typeof rank1HolderId === "number" && rank1HolderId !== 204 && champUnbeaten) return 204;
  if (rank1HolderId != null) return rank1HolderId;
  return isChampBeaten(roster) ? "player" : 204;
}

// Retired fighters must never shrink the rank ladder. This resets a retired
// fighter's slot into a fresh debut prospect so the total number of ranked
// fighters stays constant for the whole career. The champion (id 204) is
// left untouched — his lifecycle is managed by the belt-holder logic.
export function respawnRetiredFighters(roster: RosterFighterState[], seed: number): number {
  const rng = seededRandom(Math.abs(seed) * 131 + 7);
  let respawned = 0;
  for (const f of roster) {
    if (!f.retired || f.id === 204) continue;
    f.retired = false;
    f.active = true;
    f.wins = 0;
    f.losses = 0;
    f.draws = 0;
    f.knockouts = 0;
    f.totalFights = 0;
    f.ratingScore = 950;
    f.level = Math.floor(1 + rng() * 5);
    f.fighterDifficulty = "journeyman";
    f.beatenByPlayer = false;
    f.momentum = 0;
    f.winStreak = 0;
    f.loseStreak = 0;
    f.drawStreak = 0;
    f.weeksSinceLastFight = 0;
    f.lastFightResults = [];
    f.lastOpponentId = undefined;
    f.lastOpponentWeek = undefined;
    respawned++;
  }
  return respawned;
}

export function updateRankings(roster: RosterFighterState[], rank1HolderId?: number | "player"): void {
  const holderId = resolveRank1Holder(roster, rank1HolderId);

  // Self-heal: the champion (id 204) must always stay active/unretired while he still holds
  // the belt. This also retroactively repairs saves affected by the earlier bug where he
  // could be marked retired/inactive and disappear from the rankings.
  const wolf = roster.find(f => f.id === 204);
  if (wolf && holderId === 204) {
    wolf.active = true;
    wolf.retired = false;
  }
  // Self-heal: while unbeaten by the player, Aruzenai Jr's record must show no losses.
  // Wipes losses accumulated in saves from before the guaranteed-win rule existed.
  if (wolf && !wolf.beatenByPlayer && wolf.losses > 0) {
    wolf.totalFights = Math.max(wolf.wins + wolf.draws, wolf.totalFights - wolf.losses);
    wolf.losses = 0;
    wolf.loseStreak = 0;
    wolf.lastFightResults = (wolf.lastFightResults ?? []).filter(r => r !== "L");
  }

  // Rank ALL non-retired fighters (active and reserve) by rankingScore
  const active = roster.filter(f => !f.retired);
  active.sort((a, b) => {
    const scoreA = computeRankingScore(a);
    const scoreB = computeRankingScore(b);
    if (Math.abs(scoreA - scoreB) > 0.01) return scoreB - scoreA;
    return b.wins - a.wins;
  });

  if (typeof holderId === "number") {
    const holderIdx = active.findIndex(f => f.id === holderId);
    if (holderIdx > 0) {
      const [holder] = active.splice(holderIdx, 1);
      active.unshift(holder);
    }
  }

  // When the player holds the belt, rank 1 is reserved for the player — the AI roster
  // numbering starts at 2.
  const offset = holderId === "player" ? 1 : 0;
  active.forEach((f, i) => { f.rank = i + 1 + offset; });
  roster.filter(f => f.retired).forEach(f => { f.rank = 0; });
}

export function computePlayerRankFromRating(
  roster: RosterFighterState[],
  playerRatingScore: number,
  rank1HolderId?: number | "player"
): number {
  const holderId = resolveRank1Holder(roster, rank1HolderId);
  if (holderId === "player") return 1;

  // Compare against all non-retired fighters sorted by rankingScore
  const all = roster.filter(f => !f.retired);
  const sorted = [...all].sort((a, b) => computeRankingScore(b) - computeRankingScore(a));

  const holderIdx = sorted.findIndex(f => f.id === holderId);
  if (holderIdx > 0) {
    const [holder] = sorted.splice(holderIdx, 1);
    sorted.unshift(holder);
  }

  let rank = sorted.length + 1;
  for (let i = sorted.length - 1; i >= 0; i--) {
    if (playerRatingScore >= computeRankingScore(sorted[i]) && sorted[i].id !== holderId) {
      rank = i + 1;
    } else {
      break;
    }
  }
  // The player can never outrank the current belt holder purely on rating — the belt
  // only changes hands by beating the holder in a fight.
  return Math.max(2, rank);
}

// Drop the player exactly one rank spot (e.g. as a fight-cancellation penalty).
// Rank is derived from playerRatingScore, so the demotion is done by lowering the
// rating to sit just below the fighter currently one spot beneath the player —
// otherwise the next load-time recompute would undo a direct playerRank edit.
// If the player holds the Rank-1 belt, it passes to the top-rated AI.
export function demotePlayerOneRank(
  roster: RosterFighterState[],
  playerRatingScore: number,
  currentRank: number,
  rank1HolderId?: number | "player"
): { playerRatingScore: number; playerRank: number; rank1HolderId: number | "player" } {
  let holderId = resolveRank1Holder(roster, rank1HolderId);
  const all = roster.filter(f => !f.retired);
  const sorted = [...all].sort((a, b) => computeRankingScore(b) - computeRankingScore(a));
  if (holderId === "player") {
    holderId = sorted[0]?.id ?? 204;
  }
  const hIdx = sorted.findIndex(f => f.id === holderId);
  if (hIdx > 0) {
    const [h] = sorted.splice(hIdx, 1);
    sorted.unshift(h);
  }
  const targetRank = Math.min(sorted.length + 1, Math.max(2, currentRank + 1));
  let newRating: number;
  if (targetRank > sorted.length) {
    newRating = computeRankingScore(sorted[sorted.length - 1]) - 1;
  } else {
    const displaced = computeRankingScore(sorted[targetRank - 1]);
    const above = targetRank >= 2 ? computeRankingScore(sorted[targetRank - 2]) : Infinity;
    newRating = Math.min(displaced, above - 1);
  }
  const playerRank = computePlayerRankFromRating(roster, newRating, holderId);
  return { playerRatingScore: newRating, playerRank, rank1HolderId: holderId };
}

export type FightResultKind = "win" | "loss" | "draw";

/** Growth multiplier applied to the player's ELO gain on a win (not on losses). */
export const PLAYER_WIN_ELO_MULT = 1.5;

// Standard ELO update for the career player, amplified by the rank-gap
// multiplier. Expected = 1/(1+10^((Opp−You)/400)); Win: +K(1−E),
// Loss: +K(0−E), Draw: +K(0.5−E). No minimum-gain floor, no gain divisor.
export function updatePlayerRating(
  currentRating: number,
  opponentRating: number,
  result: FightResultKind,
  method: FightMethod,
  careerDifficulty: AIDifficulty,
  playerRank: number,
  opponentRank: number,
  playerLevel?: number,
  opponentLevel?: number,
): number {
  const diffMult = DIFFICULTY_ELO_MULT[careerDifficulty] || 1.0;
  const isChampFight = opponentRank === 1;
  const expected = eloExpected(currentRating, opponentRating);
  const score = result === "win" ? 1 : result === "draw" ? 0.5 : 0;
  const K = getVariableK(playerRank, undefined, isChampFight);
  const perf = result === "draw" ? 1.0 : performanceFactor(method, result === "win");

  let delta = K * (score - expected) * perf * diffMult;
  // Rank-gap amplification: wins over distant opponents pay more; losses to
  // much lower-ranked opponents hurt more. Losing upward is NOT amplified —
  // losing to a much higher-ranked fighter should hurt little.
  const gapMult = rankGapMultiplier(playerRank, opponentRank);
  if (result === "win") {
    // The player climbs faster than the simulated roster does off the same
    // base ELO maths — losses are untouched, so this only speeds the climb.
    delta *= PLAYER_WIN_ELO_MULT;
    delta *= gapMult;
    // Victory boosts stack on top of the gap multiplier, and only on a win.
    const boost = rankUpsetEloBoost(playerRank, opponentRank)
      + levelUpsetEloBoost(playerRank, opponentRank, playerLevel, opponentLevel);
    if (boost > 0) delta *= 1 + boost;
  } else if (result === "loss" && opponentRank > playerRank) delta *= gapMult;

  return Math.max(800, currentRating + delta);
}

// Rank movement smoothing: after ELO changes and the ELO-implied rank is
// recomputed, cap how far the player may actually move this fight based on
// the rank gap to the opponent. No "winner takes loser's spot".
export function smoothPlayerRankMovement(
  currentRank: number,
  eloRank: number,
  opponentRank: number,
  result: FightResultKind
): number {
  if (result === "win") {
    if (eloRank >= currentRank) return currentRank; // a win never demotes
    const gap = currentRank - opponentRank; // >0 → opponent ranked above player
    let maxUp: number;
    if (gap <= 0) maxUp = 2;                 // beat lower-ranked: 1–2 spots
    else if (gap <= 10) maxUp = 4;           // near-equal: 2–4 spots
    else if (gap <= 25) maxUp = 8;           // higher-ranked: several spots
    else if (gap <= 50) maxUp = 15;          // scaling with the gap
    else maxUp = Math.min(45, 15 + Math.floor((gap - 50) / 4)); // big upset, bounded
    return Math.max(2, Math.max(eloRank, currentRank - maxUp));
  }
  if (result === "loss") {
    if (eloRank <= currentRank) return currentRank; // a loss never promotes
    const gap = opponentRank - currentRank; // >0 → opponent ranked below player
    let maxDown: number;
    if (gap <= 0) maxDown = 2;               // lost upward: barely drop
    else if (gap <= 10) maxDown = 4;
    else if (gap <= 25) maxDown = 10;
    else if (gap <= 50) maxDown = 20;
    else maxDown = Math.min(60, 20 + Math.floor((gap - 50) / 3)); // bad upset loss
    return Math.min(eloRank, currentRank + maxDown);
  }
  // Draw: tiny movement either way.
  return Math.max(Math.min(eloRank, currentRank + 2), Math.max(2, currentRank - 2));
}

function shuffleInPlace<T>(arr: T[], rng: () => number): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export function isChampBeaten(roster: RosterFighterState[]): boolean {
  return roster.some(f => f.id === 204 && f.beatenByPlayer);
}

export function ensureEndgamePool(state: CareerRosterState, playerLevel: number, seed: number): CareerRosterState {
  if (!isChampBeaten(state.roster)) return state;
  if (state.endgamePoolInitialized) return state;
  const rng = seededRandom(seed);
  const ceiling = playerLevel + 30;
  const lo = 85;
  const span = Math.max(1, ceiling - lo + 1);
  const newRoster = state.roster.map(f => {
    if (f.id === 204 || !f.active || f.retired || f.rank <= 0) return f;
    const jumped = lo + Math.floor(rng() * span);
    return { ...f, level: Math.max(f.level, Math.min(ceiling, jumped)) };
  });
  const champGap = 10 + Math.floor(rng() * 3);
  const finalRoster = newRoster.map(f => f.id === 204 ? { ...f, level: Math.min(1000, playerLevel + champGap) } : f);
  return { ...state, roster: finalRoster, endgamePoolInitialized: true };
}

export function redistributeRosterLevels(roster: RosterFighterState[], maxLevelGainPerWeek: number = 1, playerLevel?: number, endgameShownIds?: number[], selectedOpponentId?: number): RosterFighterState[] {
  const result = roster.map(f => ({ ...f }));
  const rng = seededRandom(result.length * 31 + 7);
  const champBeaten = isChampBeaten(result);
  const endgame = playerLevel != null && champBeaten;
  const ceiling = 1000;

  for (const f of result) {
    if (!f.genSkinColor) {
      const colors = generateFighterColors(rng, f.id);
      f.genSkinColor = colors.genSkinColor;
      f.genGloves = colors.genGloves;
      f.genGloveTape = colors.genGloveTape;
      f.genTrunks = colors.genTrunks;
      f.genShoes = colors.genShoes;
    }
    // Socks arrived after gear colours: rosters generated before then have every
    // other colour set, so they need their own idempotent backfill.
    if (!f.genSocks) f.genSocks = sockColorForFighterId(f.id);
  }

  const active = result.filter(f => f.active && !f.retired && f.rank > 0);
  const totalActive = active.length;
  for (const f of active) {
    // Selected opponent: preserve their level exactly — never raise or lower it here.
    // Growth is managed solely by the simulateWeek explicit growth block (gap ≤ 3 rule).
    if (selectedOpponentId != null && f.id === selectedOpponentId) {
      continue;
    }
    if (f.id === 204) {
      // Aruzenai Jr.'s level is set separately below relative to the player.
      continue;
    }
    const oldLevel = f.level;
    const [lo, hi] = levelRangeForRank(f.rank);
    const target = Math.max(1, Math.min(ceiling, Math.floor(lo + rng() * (hi - lo + 1))));
    let newLevel: number;
    if (target > oldLevel) {
      // Gain is rate-limited (slow climb)
      newLevel = Math.min(target, oldLevel + maxLevelGainPerWeek);
    } else {
      // Drop snaps immediately to rank-correct range — prevents level inflation
      newLevel = target;
    }
    if (endgame) {
      newLevel = Math.max(newLevel, Math.min(oldLevel, ceiling));
    }
    f.level = Math.max(1, newLevel);
    growStatsFromLevel(f, endgame);
  }

  const inactive = result.filter(f => !f.active || f.retired);
  for (const f of inactive) {
    const oldLevel = f.level;
    const ratingPct = Math.max(0, Math.min(1, (f.ratingScore - 800) / 800));
    const baseLevel = Math.max(1, Math.min(200, Math.round(ratingPct * 200)));
    const jitter = Math.floor(rng() * 11) - 5;
    let newLevel = Math.max(1, Math.min(ceiling, baseLevel + jitter));
    if (newLevel > oldLevel) {
      newLevel = Math.min(newLevel, oldLevel + maxLevelGainPerWeek);
    }
    if (endgame) {
      newLevel = Math.max(newLevel, Math.min(oldLevel, ceiling));
    }
    // Never lower a fighter's level
    f.level = Math.max(oldLevel, newLevel);
    growStatsFromLevel(f, endgame);
  }

  const champ = result.find(f => f.id === 204);
  if (champ) {
    if (endgame && playerLevel != null) {
      const champGap = 10 + Math.floor(rng() * 3);
      champ.level = Math.min(1000, playerLevel + champGap);
      growStatsFromLevel(champ, true);
    } else {
      const custom = loadCustomRosterGenConfig();
      champ.level = custom ? Math.max(1, custom.rank1Level) : 1000;
      growStatsFromLevel(champ, false);
    }
  }

  enforceGenConfigBands(result);
  return result;
}

/** Career wins that permanently widen the Select Opponent board. */
export const EXPANDED_BOARD_WIN_THRESHOLD = 10;
/** Fighters offered on the Select Opponent screen, before and after the expansion. */
export const BASE_OFFER_COUNT = 7;
export const EXPANDED_OFFER_COUNT = 15;
/** How far above the player (better ranks) a reroll reaches, before and after the expansion. */
const REROLL_ABOVE_REACH = 20;
const REROLL_ABOVE_REACH_EXPANDED = 50;

/**
 * Whether this career has the widened opponent board. It unlocks at
 * EXPANDED_BOARD_WIN_THRESHOLD career wins and is then remembered on the roster
 * state, so it survives download/upload of the save and clears with a new career.
 */
export function isExpandedOpponentBoard(
  rosterState: { expandedOpponentBoardUnlocked?: boolean } | null | undefined,
  playerWins?: number,
): boolean {
  return !!rosterState?.expandedOpponentBoardUnlocked || (playerWins ?? 0) >= EXPANDED_BOARD_WIN_THRESHOLD;
}

/** Career wins before the rank-1 champion can be challenged. */
export const CHAMPION_UNLOCK_WIN_THRESHOLD = 75;

/**
 * Whether this career may *select* the champion (id 204) once he is on the board.
 *
 * This is only half the gate. Seeing him at all is governed separately by rank
 * proximity in getOpponentCandidates: he is not listed until the player's rank
 * has closed to within 10 of his. This win count then decides whether the card
 * that appears is clickable; below the threshold it reads as unavailable, with
 * no hint of what opens it.
 *
 * Both conditions are required, so the belt cannot be taken from deep down the
 * ladder on win count alone.
 *
 * Once he has been beaten the gate stays permanently open, so a career that beat
 * him can never lose access — his post-defeat rematch cadence takes over.
 */
export function isChampionChallengeable(
  roster: RosterFighterState[],
  playerWins?: number,
): boolean {
  return isChampBeaten(roster) || (playerWins ?? 0) >= CHAMPION_UNLOCK_WIN_THRESHOLD;
}

export function getOpponentCandidates(
  roster: RosterFighterState[],
  playerRank: number,
  playerLevel?: number,
  endgameShownIds?: number[],
  /** Gates the title bout — see CHAMPION_UNLOCK_WIN_THRESHOLD. */
  playerWins?: number,
  careerFightsCompleted?: number,
  rerollSeed?: number,
  prevShownIds?: number[],
  expandedBoard: boolean = false
): RosterFighterState[] {
  const allActive = roster.filter(f => f.active && !f.retired && f.rank > 0);
  const champBeaten = isChampBeaten(roster);
  const champFighter = allActive.find(f => f.id === 204);
  // The champion (id 204) is pinned at rank 1 the whole time he's unbeaten, and reaching
  // him takes two separate gates:
  //   1. Visibility — his card is not on the board at all until the player's rank closes
  //      to within 10 of his, matching the board's own ABOVE_CAP reach.
  //   2. Selectability — CHAMPION_UNLOCK_WIN_THRESHOLD career wins. Until then the card
  //      that appears rides as championLocked, which renders as a plain "unavailable this
  //      week" with no stated requirement.
  const champWithinRange = !!champFighter && Math.abs(playerRank - champFighter.rank) <= 10;
  const champChallengeable = isChampionChallengeable(roster, playerWins);
  // Keep him out of the general matching pools below; he's surfaced separately.
  const active = champBeaten ? allActive : allActive.filter(f => f.id !== 204);

  const withChamp = (list: RosterFighterState[]): RosterFighterState[] => {
    if (champBeaten || !champFighter) return list;
    if (list.some(f => f.id === 204)) return list;
    // Out of rank range: he isn't shown at all, locked or otherwise. The win count
    // deliberately does not override this — it only unlocks a card already on the board.
    if (!champWithinRange) return list;
    return [{ ...champFighter, unavailableThisWeek: false, championLocked: !champChallengeable }, ...list];
  };

  if (champBeaten) {
    // Champion defeated: the entire active roster (except Aruzenai Jr. himself) is now
    // permanently selectable.
    const openRoster = active
      .filter(f => f.id !== 204)
      .sort((a, b) => a.rank - b.rank);
    // Aruzenai Jr. resurfaces as a rank-1 selectable opponent once every 25 completed bouts.
    const champEligible = !!champFighter && careerFightsCompleted != null && careerFightsCompleted > 0 && careerFightsCompleted % 25 === 0;
    if (champEligible && champFighter) {
      return [{ ...champFighter, unavailableThisWeek: false, championLocked: false }, ...openRoster];
    }
    return openRoster;
  }

  // How many fighters the board offers — 15 once the expansion is unlocked, 7 before.
  const offerCount = expandedBoard ? EXPANDED_OFFER_COUNT : BASE_OFFER_COUNT;

  // Strict cap: no opponent ranked more than 10 spots better (lower rank #) than the player.
  // A small buffer of 5 ranks below (higher rank #) allows slightly easier matchups.
  // Widen the below-buffer only if we can't fill the board.
  const ABOVE_CAP = 10;
  const BELOW_BUFFER = 5;
  const minRank = Math.max(1, playerRank - ABOVE_CAP);
  let maxRank = playerRank + BELOW_BUFFER;
  let pool = active.filter(f => f.rank >= minRank && f.rank <= maxRank);

  // Widen below-buffer until the board is full, but never let the above-cap grow
  while (pool.length < offerCount && maxRank < active.length + 10) {
    maxRank += 5;
    pool = active.filter(f => f.rank >= minRank && f.rank <= maxRank);
  }

  // Last resort: take the closest by rank if still short
  if (pool.length < offerCount) {
    pool = active
      .slice()
      .sort((a, b) => Math.abs(a.rank - playerRank) - Math.abs(b.rank - playerRank))
      .slice(0, offerCount * 2);
  }

  // Level-gap safety filter (early/mid career only — relaxes once player is level 300+)
  // Capture the pre-filter pool so we can pad back up to 7 if the filter shrinks it.
  const preFilterPool = pool.slice();
  if (playerLevel !== undefined && playerLevel < 300) {
    const hardCap = playerLevel + 30;
    const softCap = playerLevel + 15;
    const safe = pool.filter(f => f.level <= hardCap);
    const preferred = safe.filter(f => f.level <= softCap);
    // Use preferred subset if it has at least 4 fighters; otherwise fall back to safe
    pool = preferred.length >= 4 ? preferred : safe.length >= 1 ? safe : pool;
  }

  // Always guarantee a full board in the pool. If the level filter shrank it, pad back
  // from the pre-filter pool (already rank-bounded), then from all active fighters.
  if (pool.length < offerCount) {
    const inPool = new Set(pool.map(f => f.id));
    const extras = preFilterPool
      .filter(f => !inPool.has(f.id))
      .sort((a, b) => Math.abs(a.rank - playerRank) - Math.abs(b.rank - playerRank));
    for (const e of extras) {
      if (pool.length >= offerCount) break;
      pool = [...pool, e];
    }
  }
  if (pool.length < offerCount) {
    const inPool = new Set(pool.map(f => f.id));
    const extras = active
      .filter(f => !inPool.has(f.id))
      .sort((a, b) => Math.abs(a.rank - playerRank) - Math.abs(b.rank - playerRank));
    for (const e of extras) {
      if (pool.length >= offerCount) break;
      pool = [...pool, e];
    }
  }

  let result: RosterFighterState[];
  if (rerollSeed && rerollSeed > 0) {
    // Reroll (rank-targeted): pick one target rank per board slot, centered on the
    // player's rank — the better half above (smaller rank numbers, reaching up to
    // 20 ranks normally and 50 once the board is expanded), the easier half below
    // (playerRank+5..playerRank+20) — then take whichever active fighter currently
    // holds the rank closest to each target.
    const normalShownIds = new Set(
      pool
        .slice()
        .sort((a, b) => Math.abs(a.rank - playerRank) - Math.abs(b.rank - playerRank))
        .slice(0, offerCount)
        .map(f => f.id)
    );
    const rng = seededRandom(rerollSeed * 9973 + 1337);
    // Build the target ranks: jitter each pick inside its own segment of the band.
    const targets: number[] = [];
    const segTargets = (side: 1 | -1, count: number, bandHi: number) => {
      const bandLo = 5;
      const segSize = (bandHi - bandLo + 1) / count;
      for (let i = 0; i < count; i++) {
        const lo = bandLo + i * segSize;
        const off = Math.round(lo + rng() * (segSize - 1));
        targets.push(playerRank + side * Math.min(bandHi, Math.max(bandLo, off)));
      }
    };
    const aboveCount = Math.floor(offerCount * 3 / 7);
    const aboveReach = expandedBoard ? REROLL_ABOVE_REACH_EXPANDED : REROLL_ABOVE_REACH;
    segTargets(-1, aboveCount, aboveReach);                 // better-ranked opponents
    segTargets(1, offerCount - aboveCount, REROLL_ABOVE_REACH); // easier opponents

    const chosen = new Set<number>();
    const prevShown = new Set(prevShownIds ?? []);
    const pickClosestTo = (targetRank: number, allowPrevShown: boolean): RosterFighterState | undefined => {
      let best: RosterFighterState | undefined;
      let bestDist = Infinity;
      for (const f of active) {
        if (chosen.has(f.id) || normalShownIds.has(f.id)) continue;
        if (!allowPrevShown && prevShown.has(f.id)) continue;
        const d = Math.abs(f.rank - targetRank);
        if (d < bestDist) { best = f; bestDist = d; }
      }
      return best;
    };

    let rerollPool: RosterFighterState[] = [];
    let repeatsUsed = 0;
    for (const t of targets) {
      // Prefer fresh faces; allow at most 2 repeats from the previous roll when
      // a fresh pick would land much farther from the target.
      const fresh = pickClosestTo(t, false);
      const any = pickClosestTo(t, true);
      let pick = fresh;
      if (any && (!fresh || Math.abs(any.rank - t) + 3 < Math.abs(fresh.rank - t)) && repeatsUsed < 2) {
        if (fresh === undefined || prevShown.has(any.id)) repeatsUsed++;
        pick = any;
      }
      if (pick) {
        chosen.add(pick.id);
        rerollPool.push(pick);
      }
    }
    // Safety: if somehow short of a full board (tiny rosters), pad with the closest remaining.
    if (rerollPool.length < offerCount) {
      const extras = active
        .filter(f => !chosen.has(f.id))
        .sort((a, b) => Math.abs(a.rank - playerRank) - Math.abs(b.rank - playerRank));
      for (const e of extras) {
        if (rerollPool.length >= offerCount) break;
        rerollPool.push(e);
      }
    }
    result = rerollPool.slice(0, offerCount);
  } else {
    // Normal: the fighters closest in rank to the player, sorted by rank for display
    result = pool
      .slice()
      .sort((a, b) => Math.abs(a.rank - playerRank) - Math.abs(b.rank - playerRank))
      .slice(0, offerCount);
  }

  result.sort((a, b) => a.rank - b.rank);
  // Availability was retired — clear any stale flag left on older saves so every
  // listed opponent is selectable without waiting for the next week simulation.
  return withChamp(result).map(f => (f.unavailableThisWeek || f.wasUnavailableLast
    ? { ...f, unavailableThisWeek: false, wasUnavailableLast: false }
    : f));
}

export function getRosterEntryById(id: number): RosterEntry | undefined {
  return ROSTER_DATA.find(r => r.id === id);
}

export function getAIDifficultyForRank(rank: number, totalActive: number): AIDifficulty {
  const pct = rank / totalActive;
  if (pct <= 0.05) return "champion";
  if (pct <= 0.20) return "elite";
  if (pct <= 0.55) return "contender";
  return "journeyman";
}

export interface SimulatedFightResult {
  winnerId: number;
  loserId: number;
  winnerName: string;
  loserName: string;
  isKO: boolean;
  isDraw: boolean;
}

function winProbFromRating(ratingA: number, ratingB: number): number {
  const diff = ratingA - ratingB;
  const absDiff = Math.abs(diff);
  let prob: number;
  if (absDiff <= 50) prob = 0.55;
  else if (absDiff <= 100) prob = 0.60;
  else if (absDiff <= 200) prob = 0.70;
  else prob = 0.80;
  prob = Math.min(prob, 0.85);
  return diff >= 0 ? prob : 1 - prob;
}

export function mergeNewFightersIntoRoster(state: CareerRosterState): CareerRosterState {
  const existingIds = new Set(state.roster.map(f => f.id));
  const missingEntries = ROSTER_DATA.filter(r => !existingIds.has(r.id));
  if (missingEntries.length === 0) return state;

  // Track how many active slots are already filled so we don't exceed ACTIVE_ROSTER_SIZE
  let activeCount = state.roster.filter(f => f.active && !f.retired).length;

  const newFighters: RosterFighterState[] = [];

  for (const entry of missingEntries) {
    // Each fighter gets its own deterministic RNG seeded by fighter ID so results
    // are stable regardless of when migration runs or in what week.
    const idRng = seededRandom(entry.id * 7919 + 42);
    const colorRng = seededRandom(entry.id * 3571 + 17);
    const statsRng = seededRandom(entry.id * 1291 + 99);

    const isAlwaysUndefeated = entry.alwaysUndefeated ?? false;
    const isHighWin = entry.highWinRatio ?? false;

    if (isAlwaysUndefeated) {
      // Always-undefeated fighters are always active; they bypass the cap check.
      const level = 80 + Math.floor(idRng() * 15);
      const record = generateUndefeatedRecord(idRng, level);
      const stats = generateFighterStats(10, entry.archetype, statsRng, ACTIVE_ROSTER_SIZE, entry.id);
      activeCount++;
      newFighters.push({
        id: entry.id,
        ...record,
        level,
        armLength: Math.round(58 + idRng() * 17),
        active: true,
        retired: false,
        rank: 0,
        ratingScore: 1200 + Math.floor(idRng() * 150),
        beatenByPlayer: false,
        alwaysUndefeated: true,
        fighterDifficulty: "elite",
        ...generateFighterColors(colorRng, entry.id),
        ...stats,
        momentum: 0, winStreak: 0, loseStreak: 0, drawStreak: 0,
        weeksSinceLastFight: 0, lastFightResults: [],
        lastOpponentId: undefined, lastOpponentWeek: undefined,
      });
    } else if (isHighWin) {
      const level = 50 + Math.floor(idRng() * 45);
      const record = generateHighWinRecord(idRng, level);
      const stats = generateFighterStats(50, entry.archetype, statsRng, ACTIVE_ROSTER_SIZE, entry.id);
      const canBeActive = activeCount < ACTIVE_ROSTER_SIZE;
      if (canBeActive) activeCount++;
      newFighters.push({
        id: entry.id,
        ...record,
        level,
        armLength: Math.round(58 + idRng() * 17),
        active: canBeActive,
        retired: false,
        rank: 0,
        ratingScore: canBeActive ? 1050 + Math.floor(idRng() * 200) : 900,
        beatenByPlayer: false,
        fighterDifficulty: "contender",
        ...generateFighterColors(colorRng, entry.id),
        ...stats,
        momentum: 0, winStreak: 0, loseStreak: 0, drawStreak: 0,
        weeksSinceLastFight: 0, lastFightResults: [],
        lastOpponentId: undefined, lastOpponentWeek: undefined,
      });
    } else {
      const level = Math.floor(1 + idRng() * 25);
      const stats = generateFighterStats(200, entry.archetype, statsRng, ACTIVE_ROSTER_SIZE, entry.id);
      newFighters.push({
        id: entry.id,
        wins: 0, losses: 0, draws: 0, knockouts: 0, totalFights: 0,
        level,
        armLength: Math.round(58 + idRng() * 17),
        active: false,
        retired: false,
        rank: 0,
        ratingScore: 900,
        beatenByPlayer: false,
        fighterDifficulty: "journeyman",
        ...generateFighterColors(colorRng, entry.id),
        ...stats,
        momentum: 0, winStreak: 0, loseStreak: 0, drawStreak: 0,
        weeksSinceLastFight: 0, lastFightResults: [],
        lastOpponentId: undefined, lastOpponentWeek: undefined,
      });
    }
  }

  const newRoster = [...state.roster, ...newFighters];
  ensureOffenseProfiles(newRoster);
  updateRankings(newRoster, state.rank1HolderId);
  enforceGenConfigBands(newRoster);
  return { ...state, roster: newRoster };
}

/**
 * The weekly simulation, expressed as a generator that yields a human-readable
 * phase label between each block of work. Yielding lets the loading screen paint
 * between phases; the blocks themselves are untouched and run in the same order,
 * so every seeded rng() draw happens exactly as it always did.
 */
export function* simulateWeekSteps(incomingState: CareerRosterState, weekSeed: number, careerDifficulty?: string, playerLevel?: number, applyOpponentGrowth: boolean = true, playerRefinementTotal?: number, playerEquipment?: Record<string, number> | null): Generator<string, CareerRosterState, void> {
  // Migrate old saves that have fewer fighters than the current roster
  const state = applyRefinementGenV3(
    incomingState.roster.length < ROSTER_DATA.length
      ? mergeNewFightersIntoRoster(incomingState)
      : incomingState,
    weekSeed,
  );
  const rng = seededRandom(Math.abs(weekSeed) + state.weekNumber * 9973);
  const newRoster = state.roster.map(f => ({ ...f }));
  ensureOffenseProfiles(newRoster);

  for (const f of newRoster) {
    if (f.ratingScore == null) {
      f.ratingScore = f.active ? 1000 + Math.max(0, 151 - f.rank) * 5 : 900;
    }
    f.momentum = f.momentum ?? 0;
    f.winStreak = f.winStreak ?? 0;
    f.loseStreak = f.loseStreak ?? 0;
    f.drawStreak = f.drawStreak ?? 0;
    f.weeksSinceLastFight = Math.min(f.weeksSinceLastFight ?? 0, 20);
    f.lastFightResults = f.lastFightResults ?? [];
    // lastOpponentId / lastOpponentWeek default to undefined (old saves handled gracefully)
  }

  // Start-of-week: momentum decay only.
  // Inactivity increment + ELO decay are applied POST-simulation, only to fighters who did NOT fight.
  for (const f of newRoster) {
    if (f.retired) continue;
    if (f.momentum !== 0) {
      f.momentum = Math.max(-100, Math.min(100, (f.momentum ?? 0) * 0.90));
      if (Math.abs(f.momentum) < 0.1) f.momentum = 0;
    }
  }

  const newNews: string[] = [];
  const keyIds = new Set(KEY_FIGHTER_IDS);
  const currentWeek = state.weekNumber;
  // Track the rank-1 belt through this week's simulated fights: if the current holder
  // (an AI fighter — the player never appears in these simulated bouts) loses, the winner
  // takes over the belt.
  let currentHolderId = resolveRank1Holder(state.roster, state.rank1HolderId);

  const preEndgameChampBeaten = isChampBeaten(state.roster);
  const endgame = playerLevel != null && preEndgameChampBeaten;
  if (applyOpponentGrowth && !endgame && state.selectedOpponentId != null && careerDifficulty && playerLevel != null) {
    const opp = newRoster.find(f => f.id === state.selectedOpponentId);
    if (opp) {
      const growth = loadXpConfig();
      // Frozen while the opponent sits further than the configured gap above
      // the player, so they cannot run away from a career that has stalled.
      const levelDiff = opp.level - playerLevel;
      if (levelDiff <= growth.careerOppGrowthFreezeGap) {
        const levelUpChance = careerDifficulty === "champion" ? growth.careerOppGrowthChanceChampion
          : careerDifficulty === "elite" ? growth.careerOppGrowthChanceElite
          : careerDifficulty === "contender" ? growth.careerOppGrowthChanceContender
          : growth.careerOppGrowthChanceJourneyman;
        // Tracks the player wherever they are — with the pre-champion level 100
        // ceiling gone, a flat 100 here would strand the opponent below them.
        const effectiveCap = Math.min(playerLevel + growth.careerOppGrowthCapOverPlayer, 1000);
        if (rng() < levelUpChance && opp.level < effectiveCap) {
          opp.level++;
          growStatsFromLevel(opp, false);
        }
      }
      // else: opponent is further above than the gap — frozen until the player catches up
    }
  }

  yield "Matchmaking";
  const activeFighters = newRoster.filter(f => f.active && !f.retired);
  activeFighters.sort((a, b) => a.rank - b.rank);

  const excluded = new Set<number>();
  if (state.selectedOpponentId) excluded.add(state.selectedOpponentId);
  for (const f of activeFighters) {
    if (f.lastFightWeek != null && f.lastFightWeek >= currentWeek - 1) {
      excluded.add(f.id);
    }
  }

  const eligible = activeFighters.filter(f => !excluded.has(f.id));
  const shuffled = [...eligible];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const pool = shuffled.slice(0, Math.min(WEEKLY_FIGHT_COUNT, shuffled.length));

  const paired = new Set<number>();
  const pairs: [RosterFighterState, RosterFighterState][] = [];

  const champ = activeFighters.find(f => f.rank === 1);
  if (champ && currentWeek > 0 && currentWeek % 4 === 0) {
    const lastFought = champ.lastFightWeek ?? -999;
    if (currentWeek - lastFought >= 4) {
      const challengers = activeFighters.filter(f =>
        f.id !== champ.id && !excluded.has(f.id) && f.rank >= 2 && f.rank <= 6
      );
      if (challengers.length > 0) {
        challengers.sort((a, b) => a.rank - b.rank);
        const challenger = challengers[0];
        pairs.push([champ, challenger]);
        paired.add(champ.id);
        paired.add(challenger.id);
      }
    }
  }

  const totalRanked = activeFighters.length;
  const poolByRank = pool.filter(f => !paired.has(f.id)).sort((a, b) => a.rank - b.rank);
  for (const f of poolByRank) {
    if (paired.has(f.id)) continue;
    const r = f.rank > 0 ? f.rank : totalRanked;
    let winMin: number, winMax: number;
    if (r <= 10) { winMin = 1; winMax = Math.min(totalRanked, 20); }
    else if (r <= 25) { winMin = 1; winMax = Math.min(totalRanked, 40); }
    else if (r <= 50) { winMin = Math.max(1, r - 25); winMax = Math.min(totalRanked, r + 25); }
    else if (r <= 100) { winMin = Math.max(1, r - 50); winMax = Math.min(totalRanked, r + 50); }
    else { winMin = Math.max(1, r - 60); winMax = Math.min(totalRanked, r + 60); }

    // Rematch guard: skip fighters who fought each other within the last 8 weeks
    const rematchBlocked = (g: RosterFighterState) => {
      const fBlockedByG = f.lastOpponentId === g.id && currentWeek - (f.lastOpponentWeek ?? -999) < 8;
      const gBlockedByF = g.lastOpponentId === f.id && currentWeek - (g.lastOpponentWeek ?? -999) < 8;
      return fBlockedByG || gBlockedByF;
    };

    const isUpsetMatchup = rng() < 0.15;
    let candidates: RosterFighterState[];
    if (isUpsetMatchup) {
      const upMin = Math.max(1, r - 80);
      const upMax = Math.min(totalRanked, r + 80);
      candidates = poolByRank.filter(g =>
        g.id !== f.id && !paired.has(g.id) && !rematchBlocked(g) &&
        g.rank >= upMin && g.rank <= upMax &&
        (g.rank < winMin || g.rank > winMax)
      );
      if (candidates.length === 0) {
        candidates = poolByRank.filter(g =>
          g.id !== f.id && !paired.has(g.id) && !rematchBlocked(g) &&
          g.rank >= winMin && g.rank <= winMax
        );
      }
    } else {
      candidates = poolByRank.filter(g =>
        g.id !== f.id && !paired.has(g.id) && !rematchBlocked(g) &&
        g.rank >= winMin && g.rank <= winMax
      );
    }
    if (candidates.length === 0) {
      // Fallback: relax rematch guard if no fresh opponents are available
      candidates = poolByRank.filter(g =>
        g.id !== f.id && !paired.has(g.id) && Math.abs(g.rank - r) <= 100
      );
    }
    if (candidates.length === 0) continue;
    candidates.sort((a, b) => Math.abs(a.rank - r) - Math.abs(b.rank - r));
    const opp = candidates[0];
    pairs.push([f, opp]);
    paired.add(f.id);
    paired.add(opp.id);
  }

  yield "Simulating fights";
  const results: SimulatedFightResult[] = [];
  const foughtIds = new Set<number>(); // track who fought this week for post-sim inactivity

  // Read the Custom Roster Generation config once for the whole simulation: it
  // used to be re-read (and its JSON re-checked) inside every simulated fight
  // and again for every inactive fighter, which is hundreds of lookups a week.
  const genCfg = loadCustomRosterGenConfig();

  for (const [a, b] of pairs) {
    a.lastFightWeek = currentWeek;
    b.lastFightWeek = currentWeek;

    const aAlwaysUndef = !!a.alwaysUndefeated && !a.beatenByPlayer;
    const bAlwaysUndef = !!b.alwaysUndefeated && !b.beatenByPlayer;
    const aKeyProt = keyIds.has(a.id) && !a.beatenByPlayer;
    const bKeyProt = keyIds.has(b.id) && !b.beatenByPlayer;

    // Determine win probability using ELO + probabilistic protection bias.
    // alwaysUndefeated fighters get 97% win bias (rare upsets possible).
    // key-only fighters get 85% win bias.
    // Both same type (or neither): pure ELO expectation.
    const baseWinProbForA = winProbFromRating(a.ratingScore, b.ratingScore);
    // Top priority: Aruzenai Jr (204) never loses a simulated fight until the player
    // beats him — overrides alwaysUndefeated (97%) and key-fighter (85%) protection.
    const aChampProt = a.id === 204 && !a.beatenByPlayer;
    const bChampProt = b.id === 204 && !b.beatenByPlayer;
    let winProbForA: number;
    if (aChampProt) winProbForA = 1;
    else if (bChampProt) winProbForA = 0;
    else if (aAlwaysUndef && !bAlwaysUndef) winProbForA = 0.97;
    else if (bAlwaysUndef && !aAlwaysUndef) winProbForA = 0.03;
    else if (aKeyProt && !bKeyProt) winProbForA = Math.max(0.85, baseWinProbForA);
    else if (bKeyProt && !aKeyProt) winProbForA = Math.min(0.15, baseWinProbForA);
    else winProbForA = baseWinProbForA;

    const aWins = rng() < winProbForA;
    const winner = aWins ? a : b;
    const loser = aWins ? b : a;

    const methodRoll = rng();
    let method: FightMethod;
    if (methodRoll < 0.05) method = "ko";
    else if (methodRoll < 0.15) method = "dominant";
    else if (methodRoll < 0.40) method = "close";
    else method = "close";

    const isChampFight = winner.rank === 1 || loser.rank === 1;
    const preWinnerRating = winner.ratingScore;
    const preLoserRating = loser.ratingScore;
    const { winnerDelta, loserDelta } = computeEloChange(
      winner.ratingScore, loser.ratingScore, method, 1.0, isChampFight,
      winner.rank, loser.rank, winner.totalFights, loser.totalFights
    );
    // Custom Roster Generation config: per-band ELO multiplier (0.4x–10x)
    // scales each fighter's own rating change by their current rank band.
    const winnerMult = genCfg ? getEloMultForRank(genCfg, winner.rank) : 1;
    const loserMult = genCfg ? getEloMultForRank(genCfg, loser.rank) : 1;
    winner.ratingScore = Math.max(800, winner.ratingScore + winnerDelta * winnerMult);
    loser.ratingScore = Math.max(800, loser.ratingScore + loserDelta * loserMult);

    const isKO = method === "ko";
    winner.wins++;
    winner.totalFights++;
    if (isKO) winner.knockouts++;
    loser.losses++;
    loser.totalFights++;

    // Record last opponent for rematch avoidance (all paths)
    winner.lastOpponentId = loser.id;
    winner.lastOpponentWeek = currentWeek;
    loser.lastOpponentId = winner.id;
    loser.lastOpponentWeek = currentWeek;

    // Track fought this week (for post-sim inactivity)
    foughtIds.add(winner.id);
    foughtIds.add(loser.id);

    // Momentum updates (use pre-fight ratings for correct upset detection)
    const isUpsetWin = preLoserRating > preWinnerRating + 200;
    winner.momentum = Math.min(100, (winner.momentum ?? 0) + (isKO ? 2 : 1) + (isUpsetWin ? 10 : 0));
    loser.momentum = Math.max(-100, (loser.momentum ?? 0) + (isKO ? -4 : -2));

    // Inactivity counter reset for fighters who fought this week
    winner.weeksSinceLastFight = 0;
    loser.weeksSinceLastFight = 0;

    // Update streaks and last fight results
    winner.winStreak = (winner.winStreak ?? 0) + 1;
    winner.loseStreak = 0;
    winner.drawStreak = 0;
    winner.lastFightResults = [isKO ? "KO" : "W", ...((winner.lastFightResults ?? []).slice(0, 4))];
    loser.loseStreak = (loser.loseStreak ?? 0) + 1;
    loser.winStreak = 0;
    loser.drawStreak = 0;
    loser.lastFightResults = ["L", ...((loser.lastFightResults ?? []).slice(0, 4))];

    if (loser.id === currentHolderId) {
      currentHolderId = winner.id;
    }

    const wEntry = getRosterEntryById(winner.id);
    const lEntry = getRosterEntryById(loser.id);
    const wName = wEntry ? getRosterDisplayName(wEntry, winner) : `Fighter ${winner.id}`;
    const lName = lEntry ? getRosterDisplayName(lEntry, loser) : `Fighter ${loser.id}`;

    if (isKO) {
      newNews.push(`${wName} stops ${lName} by ${rng() < 0.5 ? "KO" : "TKO"}`);
    } else if (method === "dominant") {
      newNews.push(`${wName} dominates ${lName} by decision`);
    } else {
      newNews.push(`${wName} defeats ${lName} by decision`);
    }

    if (keyIds.has(winner.id) && winner.losses === 0 && !winner.beatenByPlayer) {
      newNews.push(`${wName} remains undefeated after a battle with ${lName}`);
    }

    results.push({
      winnerId: winner.id,
      loserId: loser.id,
      winnerName: wName,
      loserName: lName,
      isKO,
      isDraw: false,
    });
  }

  // During fight camp the selected opponent is fully frozen — skip ELO decay and
  // inactivity increment so their ratingScore (and thus rank) cannot drift at all.
  const campFrozenOppId = (!endgame && state.selectedOpponentId != null && (state.prepWeeksRemaining ?? 0) > 0)
    ? state.selectedOpponentId : null;

  yield "Updating rankings";
  // Post-simulation: apply inactivity increment + ELO decay only to fighters who did NOT fight
  for (const f of newRoster) {
    if (f.retired || foughtIds.has(f.id)) continue;
    if (f.id === campFrozenOppId) continue; // frozen during camp — no decay, no inactivity
    f.weeksSinceLastFight = (f.weeksSinceLastFight ?? 0) + 1;
    const wsf = f.weeksSinceLastFight;
    let eloDecay = 0;
    if (wsf >= 20) eloDecay = 4;
    else if (wsf >= 9) eloDecay = 2;
    else if (wsf >= 4) eloDecay = 1;
    if (eloDecay > 0) {
      const decayMult = genCfg && f.rank > 0 ? getEloMultForRank(genCfg, f.rank) : 1;
      f.ratingScore = Math.max(800, f.ratingScore - eloDecay * decayMult);
    }
  }

  // Fighters never retire: the rank ladder always keeps its full size.

  updateRankings(newRoster, currentHolderId);

  // Fight-camp rank freeze: if the player is in prep weeks with a selected opponent,
  // restore that opponent's pre-simulation rank so it doesn't drift due to other
  // fighters' ELO shifts. Swap the fighter that absorbed the old rank to keep contiguous.
  if (!endgame && state.selectedOpponentId != null && (state.prepWeeksRemaining ?? 0) > 0) {
    const frozenId = state.selectedOpponentId;
    const frozenOrigRank = state.roster.find(f => f.id === frozenId)?.rank;
    const frozenFighter = newRoster.find(f => f.id === frozenId);
    if (frozenFighter && frozenOrigRank != null && frozenOrigRank > 0 && frozenFighter.rank !== frozenOrigRank) {
      const postSimRank = frozenFighter.rank;
      const squatter = newRoster.find(f => f.rank === frozenOrigRank && f.id !== frozenId);
      if (squatter) squatter.rank = postSimRank;
      frozenFighter.rank = frozenOrigRank;
    }
  }

  yield "Opponent growth";
  const postActive = newRoster.filter(f => f.active && !f.retired && f.rank > 0);
  const postTotalActive = postActive.length;
  const weekRng = seededRandom(Math.abs(weekSeed) + state.weekNumber * 3331);
  // Selected opponent is always excluded from rank-normalization — their level is managed
  // solely by the explicit growth block above (grow by 1/week when gap ≤ 3, capped at playerLevel+4).
  // Rank-normalization can jump levels by many at once and must never touch them.
  const frozenOppId = (!endgame && state.selectedOpponentId != null) ? state.selectedOpponentId : null;
  const customGenCfg = genCfg;
  for (const f of postActive) {
    if (f.id === frozenOppId) continue;
    let newLevel: number;
    if (customGenCfg) {
      // Custom Roster Generation config: normalize toward the configured band
      // range for the fighter's rank instead of the legacy linear ladder.
      const [lo, hi] = levelRangeForRank(f.rank);
      newLevel = Math.max(lo, Math.min(hi, f.level));
    } else {
      const baseLevel = Math.max(1, Math.min(1000, Math.round(1000 - (f.rank - 1) * 999 / Math.max(1, postTotalActive - 1))));
      const jitter = Math.floor(weekRng() * 11) - 5;
      newLevel = Math.max(1, Math.min(1000, baseLevel + jitter));
    }
    f.level = Math.max(f.level, newLevel);
    growStatsFromLevel(f, preEndgameChampBeaten);
  }
  const wolf = newRoster.find(f => f.id === 204);
  if (wolf && wolf.active) {
    const champBase = customGenCfg ? Math.max(1, customGenCfg.rank1Level) : 1000;
    wolf.level = endgame ? Math.max(wolf.level, champBase) : champBase;
    growStatsFromLevel(wolf, endgame);
  }

  // Equipment Upgrades: an opponent who already owns gear keeps buying it —
  // a 30% chance each week of 1–5 more levels. Rolled off the fighter id and
  // week number rather than the seeded weekly generator, so adding this can't
  // shift the draw order an existing save's schedule was built from.
  for (const f of newRoster) {
    if (!f.active || f.retired || f.rank <= 0) continue;
    const curEquip = f.equipmentLevel ?? 0;
    if (curEquip <= 0) continue;
    f.equipmentLevel = grownEquipmentLevel(
      curEquip,
      hashRand01(f.id, "equipGrow", state.weekNumber),
      hashRand01(f.id, "equipGrowAmt", state.weekNumber),
    );
  }

  // Once the champion has fallen the roster keeps pace with the player's own
  // gear: anyone under 75% of the player's average level is pulled up to it.
  if (preEndgameChampBeaten) {
    const equipFloor = postChampEquipmentFloor(normalizeEquipmentLevels(playerEquipment));
    if (equipFloor > 0) {
      for (const f of newRoster) {
        if (!f.active || f.retired || f.rank <= 0) continue;
        if ((f.equipmentLevel ?? 0) < equipFloor) f.equipmentLevel = equipFloor;
      }
    }
  }

  // Weekly opponent availability was removed: every listed opponent is always
  // bookable. The 8-week camp selection already paces matchmaking, so a second
  // gate only stalled career progress. Flags are kept on the type but pinned false.
  for (const f of newRoster) {
    if (!f.active || f.retired) continue;
    f.unavailableThisWeek = false;
    f.wasUnavailableLast = false;
  }

  let newEndgameShownIds = state.endgameShownIds;
  let endgameRefFloorApplied = state.endgameRefFloorApplied ?? false;
  if (endgame && playerLevel != null) {
    // Endgame weekly growth: 70-85% of the active roster (excluding the champ and the
    // currently selected opponent, whose level is managed by the growth block above)
    // gains 0-3 levels this week. Growth is throttled as an opponent's gap to the
    // player nears the hard +30 cap so fighters don't perpetually overshoot it.
    const oppIdToExclude = state.selectedOpponentId ?? null;
    const growthProb = 0.70 + rng() * 0.15;
    const cap = playerLevel + 30;
    for (const f of newRoster) {
      if (f.id === 204 || f.id === oppIdToExclude) continue;
      if (!f.active || f.retired || f.rank <= 0) continue;
      if (rng() >= growthProb) continue;
      let growth = Math.floor(rng() * 4); // 0-3
      const gap = f.level - playerLevel;
      if (gap >= 29) growth = Math.min(growth, 1);
      else if (gap === 28) growth = Math.min(growth, 2);
      else if (gap === 27) growth = Math.min(growth, 3);
      if (growth > 0) {
        f.level = Math.min(1000, Math.min(cap, f.level + growth));
        growStatsFromLevel(f, true);
      }
    }
    // Aruzenai Jr. is always 10-12 levels above the player, clamped so he never exceeds 1000
    // (his gap naturally shrinks as the player approaches the level cap).
    const champInRoster = newRoster.find(f => f.id === 204);
    if (champInRoster) {
      const champGap = 10 + Math.floor(rng() * 3);
      champInRoster.level = Math.min(1000, playerLevel + champGap);
      growStatsFromLevel(champInRoster, true);
    }

    // Endgame selected opponent level growth: 60% chance per week, 1-7 levels,
    // frozen when already more than 19 levels above player (cap = playerLevel + 20).
    if (state.selectedOpponentId != null) {
      const endgameOpp = newRoster.find(f => f.id === state.selectedOpponentId);
      if (endgameOpp) {
        const egLevelDiff = endgameOpp.level - playerLevel;
        if (egLevelDiff <= 19) {
          const egCap = Math.min(playerLevel + 20, 1000);
          if (endgameOpp.level < egCap && rng() < 0.50) {
            endgameOpp.level = Math.min(egCap, endgameOpp.level + Math.floor(rng() * 7) + 1);
            growStatsFromLevel(endgameOpp, true);
          }
        }
      }
    }

    // Flat per-stat weekly growth: every active non-retired fighter (except id 204)
    // gains an independent random 10-30 on each of the five base stats.
    for (const f of newRoster) {
      if (f.id === 204) continue;
      if (!f.active || f.retired || f.rank <= 0) continue;
      f.statPower   = Math.min(1000, (f.statPower   ?? 0) + Math.floor(rng() * 21) + 10);
      f.statSpeed   = Math.min(1000, (f.statSpeed   ?? 0) + Math.floor(rng() * 21) + 10);
      f.statDefense = Math.min(1000, (f.statDefense ?? 0) + Math.floor(rng() * 21) + 10);
      f.statStamina = Math.min(1000, (f.statStamina ?? 0) + Math.floor(rng() * 21) + 10);
      f.statFocus   = Math.min(1000, (f.statFocus   ?? 0) + Math.floor(rng() * 21) + 10);
      f.overallRating = Math.round(((f.statPower ?? 0) + (f.statSpeed ?? 0) + (f.statDefense ?? 0) + (f.statStamina ?? 0) + (f.statFocus ?? 0)) / 5);
    }

    const _refKeys = ["pressureFighter","precisionStriker","jabPower","hookPower","uppercutPower","ironChin","slippery","guardMaster","duckRecovery","punchRolling","fastTwitch","heartRefinement","chinHitter","technician","lifeDrain","bruiser","koArtist"] as const;

    // One-time postgame refinement jump: every opponent whose refinement total is
    // below 80% of the player's total jumps to a random 80-85% of the player's total
    // (scaled proportionally across keys, each capped at 100).
    if (!endgameRefFloorApplied && playerRefinementTotal != null && playerRefinementTotal > 0) {
      for (const f of newRoster) {
        if (f.id === 204) continue;
        if (!f.active || f.retired || f.rank <= 0) continue;
        if (!f.customRefinementSkills) f.customRefinementSkills = {};
        const cur = refinementTotal(f.customRefinementSkills);
        if (cur >= playerRefinementTotal * 0.8) continue;
        const target = Math.round(playerRefinementTotal * (0.80 + rng() * 0.05));
        // The budget goes into the refinements this fighter already brings into
        // the ring rather than across every key, so it concentrates instead of
        // resurrecting the eleven they are not carrying.
        const held = _refKeys.filter(k => (f.customRefinementSkills![k] ?? 0) > 0);
        if (cur <= 0 || held.length === 0) {
          // Nothing held yet: open a loadout of the configured size and split evenly.
          const freshCfg = loadCustomRosterGenConfig();
          const fresh = pickRefinementKeys(f.id, getRefCountForRank(freshCfg, f.rank), getForcedRefinementsForRank(freshCfg, f.rank));
          if (fresh.length === 0) continue;
          const per = Math.min(100, Math.round(target / fresh.length));
          for (const key of fresh) f.customRefinementSkills[key] = per;
        } else {
          const scale = target / cur;
          for (const key of held) {
            f.customRefinementSkills[key] = Math.min(100, Math.round((f.customRefinementSkills[key] ?? 0) * scale));
          }
        }
      }
      endgameRefFloorApplied = true;
    }

    // Weekly refinement growth: each active non-retired opponent (except id 204)
    // gains 1-5 total refinement points, sprinkled onto random keys (capped at 100).
    for (const f of newRoster) {
      if (f.id === 204) continue;
      if (!f.active || f.retired || f.rank <= 0) continue;
      if (!f.customRefinementSkills) f.customRefinementSkills = {};
      let gain = 1 + Math.floor(rng() * 5); // 1-5 total
      // Growth pours into the refinements this fighter already brings into the
      // ring; one with none stays at none. The draw is made either way so the
      // seeded stream — and every schedule downstream of it — stays put.
      const held = _refKeys.filter(k => (f.customRefinementSkills![k] ?? 0) > 0);
      while (gain > 0) {
        const open = held.filter(k => (f.customRefinementSkills![k] ?? 0) < 100);
        const pick = Math.floor(rng() * Math.max(1, open.length));
        if (open.length > 0) {
          const key = open[pick];
          f.customRefinementSkills[key] = Math.min(100, (f.customRefinementSkills[key] ?? 0) + 1);
        }
        gain--;
      }
    }
  }

  const rankRefDefaults: Record<number, number> = (() => {
    try {
      if (typeof localStorage === "undefined") return {};
      const raw = localStorage.getItem("handz_ranking_ref_defaults");
      return raw ? JSON.parse(raw) : {};
    } catch { return {}; }
  })();

  const MAX_REF = 1400;
  for (const f of postActive) {
    if (f.refPoints === undefined || f.refPoints === null) {
      if (f.customRefPoints !== undefined && f.customRefPoints !== null) {
        f.refPoints = f.customRefPoints;
      } else {
        f.refPoints = rankRefDefaults[f.rank] ?? Math.round(100 * (204 - f.rank) / 203);
      }
    }
    const growth = Math.floor(rng() * 6);
    f.refPoints = Math.min(MAX_REF, (f.refPoints ?? 0) + growth);
  }

  yield "Filing the results";
  // Dedup: each fighter name may appear in at most one news item.
  // Build a lookup of all display names so we can detect which fighters are named in each item.
  const allRosterDisplayNames = newRoster.map(f => {
    const entry = getRosterEntryById(f.id);
    return entry ? getRosterDisplayName(entry, f) : `Fighter ${f.id}`;
  });
  const seenNewsNames = new Set<string>();
  const dedupedNews: string[] = [];
  for (const item of newNews) {
    const namesInItem = allRosterDisplayNames.filter(n => item.includes(n));
    if (namesInItem.some(n => seenNewsNames.has(n))) continue;
    namesInItem.forEach(n => seenNewsNames.add(n));
    dedupedNews.push(item);
  }

  const displayNews = dedupedNews.slice(0, 12);

  let newPrepWeeks = state.prepWeeksRemaining;
  if (newPrepWeeks != null && newPrepWeeks > 0) {
    newPrepWeeks = newPrepWeeks - 1;
  }

  const newIdleWeeks = state.selectedOpponentId != null ? 0 : (state.idleWeeks ?? 0) + 1;

  // Fight week is a bye for both Punch Endurance clocks. A booked bout sitting
  // at zero prep locks the player out of the gym entirely, so billing them for
  // the idle week would punish the schedule rather than their habits. Read off
  // the prep counter *after* this week's decrement, because that is the week
  // being entered — the same predicate the hub uses to light up the Fight
  // button. The post-fight simulation clears the selection before it runs, so
  // the week that follows the bout is an ordinary week and decays normally.
  const peFightWeekBye = state.selectedOpponentId != null && (newPrepWeeks ?? 0) === 0;

  // Punch Endurance rots out of the gym: three full weeks without a sparring
  // session of any kind buy a grace period, then it sheds a point a week down
  // to the floor. The anchor is the week the next point is due, so a session —
  // which stamps lastSparWeek with the week it happened — restarts the clock
  // simply by overtaking it, and can never be decayed on the same advance that
  // recorded it (that week is only one week behind the week being entered).
  // This runs the identical shape and the identical constants as the cost side
  // below; the two are meant to stay in lockstep.
  const peNextWeek = state.weekNumber + 1;
  const peFirstDecay = (state.lastSparWeek ?? 0) + PUNCH_ENDURANCE_GRACE_WEEKS;
  // The stored anchor used to mean "the week the last point came off"; it now
  // means "the week the next point is due". No version marker is needed to tell
  // them apart, because this block always leaves the anchor strictly past the
  // week it just entered while the old loop always left it at or before that
  // week — so an anchor that has not overtaken weekNumber was written under the
  // old meaning and converts by one step. The cost side needs no equivalent:
  // its anchor already meant "next due", and a due week is cadence-agnostic.
  const peStoredDecay = state.punchEnduranceDecayWeek;
  const peDueFromStore = peStoredDecay == null
    ? null
    : peStoredDecay > state.weekNumber
      ? peStoredDecay
      : peStoredDecay + PUNCH_ENDURANCE_STEP_WEEKS;
  let punchEndurance = punchEnduranceOf(state);
  let peDecayWeek = Math.max(peFirstDecay, peDueFromStore ?? peFirstDecay);
  if (peFightWeekBye) {
    // A bye waives the point due in the fight week itself — not the schedule
    // behind it. Anything already overdue when the bye starts is still owed and
    // is charged first; that backlog is only reachable on a legacy save
    // carrying no anchor, and forgiving it would make a career's timing depend
    // on whether its first advance after the update happened to be a bout.
    const peOverdue = peNextWeek > peDecayWeek
      ? Math.ceil((peNextWeek - peDecayWeek) / PUNCH_ENDURANCE_STEP_WEEKS)
      : 0;
    if (peOverdue > 0) {
      punchEndurance = Math.max(PUNCH_ENDURANCE_MIN, punchEndurance - peOverdue);
      peDecayWeek += peOverdue * PUNCH_ENDURANCE_STEP_WEEKS;
    }
    // Then carry the due week across the paused week. Skipping only the payout
    // would leave the anchor behind and the next advance would bill for both
    // weeks, deferring the point rather than waiving it. Slide by one week, not
    // one step, so the schedule tracks paused real time whatever the cadence.
    // Clearing the backlog first means this lands past the week just entered on
    // its own, which is what keeps the anchor readable as a "next due" value.
    peDecayWeek += 1;
  } else if (peNextWeek >= peDecayWeek) {
    const peDrops = Math.floor((peNextWeek - peDecayWeek) / PUNCH_ENDURANCE_STEP_WEEKS) + 1;
    punchEndurance = Math.max(PUNCH_ENDURANCE_MIN, punchEndurance - peDrops);
    peDecayWeek += peDrops * PUNCH_ENDURANCE_STEP_WEEKS;
  }

  // The cost side of Punch Endurance answers to the heavy bag rather than
  // sparring, and it slips the other way: three full weeks off the bag buy the
  // same grace period, then it climbs a point a week back toward the 8 ceiling.
  // The anchor is the week the next point is due, so a bag session — which
  // stamps lastHBWeek with the week it happened — restarts the clock simply by
  // overtaking it, and can never rise on the same advance that recorded it.
  // Counted arithmetically rather than a week-at-a-time loop: a career saved
  // before this field existed carries no anchor, so its first advance has to
  // account for every week already on the clock — which on an old or imported
  // save can be an arbitrarily large number of iterations to reach a ceiling it
  // would hit in the first eight. Same result, one step.
  const peLossFirstRise = (state.lastHBWeek ?? 0) + PUNCH_ENDURANCE_GRACE_WEEKS;
  let punchEnduranceLoss = punchEnduranceLossOf(state);
  let peLossRiseWeek = Math.max(peLossFirstRise, state.punchEnduranceLossRiseWeek ?? peLossFirstRise);
  if (peFightWeekBye) {
    // Same bye, same backlog rule, same one-week slide. Pausing only one of the
    // two clocks would reopen the asymmetry they are kept in lockstep to avoid.
    const peLossOverdue = peNextWeek > peLossRiseWeek
      ? Math.ceil((peNextWeek - peLossRiseWeek) / PUNCH_ENDURANCE_STEP_WEEKS)
      : 0;
    if (peLossOverdue > 0) {
      punchEnduranceLoss = Math.min(PUNCH_ENDURANCE_LOSS_MAX, punchEnduranceLoss + peLossOverdue);
      peLossRiseWeek += peLossOverdue * PUNCH_ENDURANCE_STEP_WEEKS;
    }
    peLossRiseWeek += 1;
  } else if (peNextWeek >= peLossRiseWeek) {
    const peLossRises = Math.floor((peNextWeek - peLossRiseWeek) / PUNCH_ENDURANCE_STEP_WEEKS) + 1;
    punchEnduranceLoss = Math.min(PUNCH_ENDURANCE_LOSS_MAX, punchEnduranceLoss + peLossRises);
    peLossRiseWeek += peLossRises * PUNCH_ENDURANCE_STEP_WEEKS;
  }

  // Reset speed rusts back on the same way, off the same sparring stamp: three
  // full weeks without a session of any kind, then one session's worth of the
  // snap comes back every week until the player spars again. Banked as steps
  // against the lifetime spar count rather than taken off it, so going back to
  // the gym buys the time back a session at a time. Counted arithmetically for
  // the same reason as the two clocks above.
  const rsFirstRise = (state.lastSparWeek ?? 0) + RESET_SPEED_GRACE_WEEKS;
  const rsStoredRise = state.resetSpeedRiseWeek;
  const rsDueFromStore = rsStoredRise == null
    ? null
    : rsStoredRise > state.weekNumber
      ? rsStoredRise
      : rsStoredRise + RESET_SPEED_STEP_WEEKS;
  let resetSpeedDecaySteps = Math.max(0, Math.floor(state.resetSpeedDecaySteps ?? 0));
  let rsRiseWeek = Math.max(rsFirstRise, rsDueFromStore ?? rsFirstRise);
  if (peNextWeek >= rsRiseWeek) {
    const rsRises = Math.floor((peNextWeek - rsRiseWeek) / RESET_SPEED_STEP_WEEKS) + 1;
    // Capped at the whole allowance: there is nothing past a fighter having lost
    // all of it, and letting the counter run would make a long layoff take weeks
    // of sparring before the first session showed up again.
    resetSpeedDecaySteps = Math.min(RESET_SPEED_MAX_STEPS, resetSpeedDecaySteps + rsRises);
    rsRiseWeek += rsRises * RESET_SPEED_STEP_WEEKS;
  }

  // Custom Roster Generation config is the final authority on NPC numbers:
  // clamp everything the weekly simulation just grew back into the bands.
  enforceGenConfigBands(newRoster);

  // Drilled strings settle up for the week: whatever the player rehearsed gets
  // cheaper to throw from here, whatever they neglected past its grace gets
  // dearer. Stepped once per simulated week, which is the only rate this
  // function ever runs at.
  const nextDrilled = advanceDrilledWeek(state.drilledActions);

  // The three Reset training tracks settle up on their own clocks. Each one is
  // independent — a week on the weights holds the blocking buy-back up without
  // doing a thing for the two that answer to sparring.
  const nextResetTraining = advanceResetTrainingWeek(resetTrainingOf(state), peNextWeek);

  return {
    ...state,
    roster: newRoster,
    weekNumber: state.weekNumber + 1,
    drilledActions: nextDrilled,
    resetTraining: nextResetTraining,
    newsItems: displayNews,
    selectedOpponentId: state.selectedOpponentId,
    playerRank: state.playerRank,
    playerRatingScore: state.playerRatingScore ?? 1000,
    trainingsSinceLastWeek: state.trainingsSinceLastWeek ?? 0,
    rank1HolderId: currentHolderId,
    prepWeeksRemaining: newPrepWeeks,
    endgameShownIds: newEndgameShownIds,
    idleWeeks: newIdleWeeks,
    punchEndurance,
    punchEnduranceDecayWeek: peDecayWeek,
    punchEnduranceLoss,
    punchEnduranceLossRiseWeek: peLossRiseWeek,
    resetSpeedDecaySteps,
    resetSpeedRiseWeek: rsRiseWeek,
    endgameRefFloorApplied,
    refinementGenV2Applied: true,
    refinementGenV3Applied: true,
  };
}

/**
 * Synchronous weekly simulation. Drains simulateWeekSteps in one go — identical
 * behaviour and identical rng draw order to the phased version.
 */
export function simulateWeek(incomingState: CareerRosterState, weekSeed: number, careerDifficulty?: string, playerLevel?: number, applyOpponentGrowth: boolean = true, playerRefinementTotal?: number, playerEquipment?: Record<string, number> | null): CareerRosterState {
  const steps = simulateWeekSteps(incomingState, weekSeed, careerDifficulty, playerLevel, applyOpponentGrowth, playerRefinementTotal, playerEquipment);
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value;
}


export interface CareerOpponentFromRoster {
  rosterId: number;
  name: string;
  level: number;
  archetype: Archetype;
  aiDifficulty: AIDifficulty;
  armLength: number;
  rank: number;
  wins: number;
  losses: number;
  draws: number;
  knockouts: number;
  statPower?: number;
  statSpeed?: number;
  statDefense?: number;
  statStamina?: number;
  statFocus?: number;
  overallRating?: number;
}

export function getRandomQuickFightOpponent(difficulty: AIDifficulty): CareerOpponentFromRoster {
  const idx = Math.floor(Math.random() * ROSTER_DATA.length);
  const entry = ROSTER_DATA[idx];
  const name = entry.nickname
    ? `${entry.firstName} "${entry.nickname}" ${entry.lastName}`
    : `${entry.firstName} ${entry.lastName}`;
  const armLength = Math.round(58 + Math.random() * 17);
  return {
    rosterId: entry.id,
    name,
    level: 0,
    archetype: entry.archetype,
    aiDifficulty: difficulty,
    armLength,
    rank: 0,
    wins: 0,
    losses: 0,
    draws: 0,
    knockouts: 0,
  };
}

export function getRosterFighterColors(f: RosterFighterState): RosterColorSet {
  // The Spacial finish paints over every gear colour but leaves the saved ones
  // underneath, so unticking it restores the fighter's own look.
  return applySpacialGear({
    skin: f.customSkinColor || f.genSkinColor || "#e8c4a0",
    gloves: f.customGloves || f.genGloves || "#1155cc",
    gloveTape: f.customGloveTape || f.genGloveTape || "#eeeeee",
    trunks: f.customTrunks || f.genTrunks || "#222222",
    shoes: f.customShoes || f.genShoes || "#1a1a1a",
    socks: f.customSocks || f.genSocks || sockColorForFighterId(f.id),
    // Left undefined unless edited, so untouched fighters keep deriving their
    // laces/soles/stripe from the shoe and trunk colours.
    laces: f.customLaces,
    soles: f.customSoles,
    waistStripe: f.customWaistStripe,
  }, spacialSelectionOf({ spacialColors: f.customSpacial, spacialParts: f.customSpacialParts }));
}

export function getQuickFightColorsForRosterId(rosterId: number): RosterColorSet {
  const customizations = loadRosterCustomizations();
  const c = customizations[rosterId];

  const rng = seededRandom(rosterId * 7919 + 31);
  const gen = generateFighterColors(rng, rosterId);

  return applySpacialGear({
    skin: c?.customSkinColor || gen.genSkinColor,
    gloves: c?.customGloves || gen.genGloves,
    gloveTape: c?.customGloveTape || gen.genGloveTape,
    trunks: c?.customTrunks || gen.genTrunks,
    shoes: c?.customShoes || gen.genShoes,
    socks: c?.customSocks || gen.genSocks,
    laces: c?.customLaces,
    soles: c?.customSoles,
    waistStripe: c?.customWaistStripe,
  }, spacialSelectionOf({ spacialColors: c?.customSpacial, spacialParts: c?.customSpacialParts }));
}

export function buildOpponentFromRoster(f: RosterFighterState): CareerOpponentFromRoster | null {
  const entry = getRosterEntryById(f.id);
  if (!entry) return null;
  const totalActive = ACTIVE_ROSTER_SIZE;
  return {
    rosterId: f.id,
    name: getRosterDisplayName(entry, f),
    level: f.level,
    archetype: entry.archetype,
    aiDifficulty: f.fighterDifficulty || getAIDifficultyForRank(f.rank, totalActive),
    armLength: f.armLength,
    rank: f.rank,
    wins: f.wins,
    losses: f.losses,
    draws: f.draws,
    knockouts: f.knockouts,
    statPower: f.statPower,
    statSpeed: f.statSpeed,
    statDefense: f.statDefense,
    statStamina: f.statStamina,
    statFocus: f.statFocus,
    overallRating: f.overallRating,
  };
}
