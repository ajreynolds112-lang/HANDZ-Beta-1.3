/**
 * Every number behind the skill refinements, in one editable registry.
 *
 * Most refinement effects are a straight line from level 1 to level 100, held
 * as a `curve` row (an `atL1` and an `atL100`). The rest are single numbers:
 * unlock levels, tier breakpoints, pixel ranges, per-level coefficients.
 *
 * Three consumers read this and must never hold their own copy of a number:
 * `startFight`'s two corner blocks, `applyRefinementToFighter` (Doghouse and
 * Nightmare opponents built mid-bout), and the effect blurbs on the Skill
 * Refinement screen.
 */
import { REFINEMENT_KEYS, type RefinementKey } from "./refinementKeys";

export type RefRow =
  | { kind: "curve"; field: string; label: string; l1: number; l100: number; step?: number }
  | { kind: "num"; field: string; label: string; value: number; step?: number };

export type RefinementTuning = Record<RefinementKey, Record<string, number>>;

const LS_KEY = "handz_refinement_tuning";

/** The editable surface, grouped the way the refinement screen groups it. */
export const REFINEMENT_TUNING_SPEC: Record<RefinementKey, RefRow[]> = {
  pressureFighter: [
    { kind: "curve", field: "damage", label: "Punch power", l1: 0.05, l100: 1.10 },
    { kind: "num", field: "powerScale", label: "Power payout scale", value: 0.5 },
    { kind: "curve", field: "cutChance", label: "Rhythm cut chance", l1: 0.25, l100: 0.65 },
    { kind: "curve", field: "cutStrength", label: "Rhythm cut strength", l1: 0.60, l100: 0.99 },
    { kind: "num", field: "blockDmgLevel1", label: "Block dmg tier 1 level", value: 50, step: 1 },
    { kind: "num", field: "blockDmgBonus1", label: "Block dmg tier 1", value: 0.20 },
    { kind: "num", field: "blockDmgLevel2", label: "Block dmg tier 2 level", value: 100, step: 1 },
    { kind: "num", field: "blockDmgBonus2", label: "Block dmg tier 2", value: 0.20 },
  ],
  precisionStriker: [
    { kind: "curve", field: "crit", label: "Crit multiplier", l1: 0.02, l100: 0.30 },
    { kind: "curve", field: "staminaCost", label: "Stamina per punch cut", l1: 0.01, l100: 1.00 },
    { kind: "num", field: "staminaCostFloor", label: "Lowest stamina cost mult", value: 0.05 },
    { kind: "curve", field: "dodgeNegate", label: "Opponent dodge cut", l1: 0.0035, l100: 0.35 },
    { kind: "num", field: "rangePerLevels", label: "Levels per +1px range", value: 20, step: 1 },
    { kind: "num", field: "rangeMaxPx", label: "Max range bonus (px)", value: 5, step: 1 },
  ],
  jabPower: [
    { kind: "curve", field: "damage", label: "Straight damage", l1: 0.05, l100: 1.50 },
    { kind: "num", field: "powerScale", label: "Damage payout scale", value: 0.4 },
    { kind: "curve", field: "chargeBypass", label: "Charge block bypass", l1: 0.10, l100: 0.80 },
    { kind: "curve", field: "crit", label: "Crit multiplier", l1: 0.25, l100: 4.00 },
    { kind: "curve", field: "blockIgnore", label: "Ignore-block chance", l1: 0.003, l100: 0.30 },
  ],
  hookPower: [
    { kind: "curve", field: "damage", label: "Hook damage", l1: 0.05, l100: 1.50 },
    { kind: "num", field: "powerScale", label: "Damage payout scale", value: 0.4 },
    { kind: "curve", field: "chargeBypass", label: "Charge block bypass", l1: 0.10, l100: 0.80 },
    { kind: "curve", field: "crit", label: "Crit multiplier", l1: 0.25, l100: 4.00 },
    { kind: "curve", field: "blockIgnore", label: "Ignore-block chance", l1: 0.003, l100: 0.30 },
  ],
  uppercutPower: [
    { kind: "curve", field: "damage", label: "Uppercut damage", l1: 0.05, l100: 1.00 },
    { kind: "num", field: "powerScale", label: "Damage payout scale", value: 0.4 },
    { kind: "curve", field: "chargeBypass", label: "Charge block bypass", l1: 0.10, l100: 0.80 },
    { kind: "curve", field: "crit", label: "Crit multiplier", l1: 0.25, l100: 4.00 },
    { kind: "curve", field: "blockIgnore", label: "Ignore-block chance", l1: 0.003, l100: 0.30 },
  ],
  bruiser: [
    { kind: "curve", field: "blockIgnore", label: "Ignore-block chance", l1: 0.15, l100: 0.65 },
    { kind: "num", field: "swayEdgeLo", label: "Back-foot sway edge", value: 0.25 },
    { kind: "num", field: "swayEdgeHi", label: "Front-foot sway edge", value: 0.75 },
  ],
  koArtist: [
    { kind: "curve", field: "chargePerSec", label: "Charge units/sec", l1: 1, l100: 50, step: 0.5 },
  ],
  ironChin: [
    { kind: "curve", field: "stunResist", label: "Incoming stun cut", l1: 0.003, l100: 0.30 },
    { kind: "curve", field: "damageReduction", label: "Incoming damage cut", l1: 0.0035, l100: 0.35 },
    { kind: "curve", field: "stunDelay", label: "Stun turn delay cut (s)", l1: 0.0075, l100: 0.75 },
  ],
  slippery: [
    // Deliberately flat. The intrinsic slide is quick for everyone now, so this
    // is a trim on top of it rather than the thing that makes slipping viable —
    // maxed out it is ~13% quicker, not the ~2.8x it used to buy back.
    { kind: "curve", field: "slipSpeed", label: "Slip speed", l1: 0.002, l100: 0.15 },
    { kind: "num", field: "proximityPx", label: "Crowding range (px)", value: 95, step: 1 },
    { kind: "num", field: "penaltySeconds", label: "Repunch penalty (s)", value: 0.35 },
    { kind: "num", field: "tier1Level", label: "Tier 1 level", value: 33, step: 1 },
    { kind: "num", field: "tier1Punches", label: "Tier 1 punches", value: 5, step: 1 },
    { kind: "num", field: "tier2Level", label: "Tier 2 level", value: 66, step: 1 },
    { kind: "num", field: "tier2Punches", label: "Tier 2 punches", value: 4, step: 1 },
    { kind: "num", field: "tier3Level", label: "Tier 3 level", value: 100, step: 1 },
    { kind: "num", field: "tier3Punches", label: "Tier 3 punches", value: 3, step: 1 },
  ],
  guardMaster: [
    { kind: "curve", field: "blockMult", label: "Block effectiveness", l1: 0.01, l100: 1.00 },
    { kind: "num", field: "chargeFullBlockLevel", label: "Charge full-block level", value: 50, step: 1 },
    { kind: "num", field: "pbIgnoresVulnLevel", label: "PB beats rhythm vuln level", value: 100, step: 1 },
  ],
  duckRecovery: [
    { kind: "curve", field: "regen", label: "Ducking stamina regen", l1: 0.2, l100: 1.0 },
  ],
  punchRolling: [
    { kind: "curve", field: "damageTaken", label: "Incoming damage cut", l1: 0.05, l100: 0.80 },
    { kind: "curve", field: "repunchBoost", label: "Opponent repunch penalty", l1: 0.05, l100: 0.80 },
    { kind: "curve", field: "bigShotNegate", label: "Big Shot shrug-off", l1: 0.10, l100: 0.20 },
  ],
  fastTwitch: [
    { kind: "curve", field: "telegraph", label: "Telegraph cut", l1: 0.15, l100: 1.00 },
    { kind: "num", field: "movePerLevel", label: "Move speed per level", value: 0.00245, step: 0.0001 },
  ],
  heartRefinement: [
    { kind: "curve", field: "stamina", label: "Stamina pool & regen", l1: 0.10, l100: 1.30 },
    { kind: "curve", field: "repunchPenalty", label: "Own repunch penalty mult", l1: 0.85, l100: 0.10 },
  ],
  chinHitter: [
    { kind: "curve", field: "stun", label: "Stun chance", l1: 0.10, l100: 0.50 },
    { kind: "curve", field: "vuln", label: "Rhythm vuln bonus", l1: 0.01, l100: 0.10 },
    { kind: "num", field: "chargeBreakLevel", label: "Charge dmg breakpoint", value: 50, step: 1 },
    { kind: "num", field: "chargePerLevelLow", label: "Charge dmg/level below", value: 0.01, step: 0.005 },
    { kind: "num", field: "chargePerLevelHigh", label: "Charge dmg/level above", value: 0.02, step: 0.005 },
  ],
  technician: [
    { kind: "curve", field: "rcStun", label: "Rhythm cut stun chance", l1: 0.05, l100: 0.45 },
    { kind: "curve", field: "accuracy", label: "Accuracy boost", l1: 0.05, l100: 0.60 },
    { kind: "num", field: "whiffPerLevels", label: "Levels per free whiff", value: 20, step: 1 },
    { kind: "num", field: "whiffMax", label: "Max free whiffs", value: 5, step: 1 },
    { kind: "num", field: "feintCancelLevel", label: "Feint-cancel level", value: 20, step: 1 },
  ],
  lifeDrain: [
    { kind: "curve", field: "drain", label: "Stamina restored per hit", l1: 0.005, l100: 0.10, step: 0.005 },
  ],
};

function defaultsFor(rows: RefRow[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of rows) {
    if (row.kind === "curve") {
      out[`${row.field}L1`] = row.l1;
      out[`${row.field}L100`] = row.l100;
    } else {
      out[row.field] = row.value;
    }
  }
  return out;
}

export function defaultRefinementTuning(): RefinementTuning {
  const out = {} as RefinementTuning;
  for (const key of REFINEMENT_KEYS) out[key] = defaultsFor(REFINEMENT_TUNING_SPEC[key]);
  return out;
}

let cache: RefinementTuning | null = null;

function load(): RefinementTuning {
  const def = defaultRefinementTuning();
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return def;
    const parsed = JSON.parse(raw) ?? {};
    // Field by field, so a key or a field added after a config was saved arrives
    // at its default instead of undefined.
    for (const key of REFINEMENT_KEYS) {
      const saved = parsed[key];
      if (!saved || typeof saved !== "object") continue;
      for (const field of Object.keys(def[key])) {
        const v = saved[field];
        if (typeof v === "number" && Number.isFinite(v)) def[key][field] = v;
      }
    }
  } catch { /* fall through to defaults */ }
  return def;
}

export function getRefinementTuning(): RefinementTuning {
  if (!cache) cache = load();
  return cache;
}

export function saveRefinementTuning(cfg: RefinementTuning) {
  localStorage.setItem(LS_KEY, JSON.stringify(cfg));
  cache = cfg;
}

/** Re-read from storage — used after a parameter bundle is uploaded. */
export function reloadRefinementTuning(): RefinementTuning {
  cache = null;
  return getRefinementTuning();
}

export function resetRefinementTuning(): RefinementTuning {
  const def = defaultRefinementTuning();
  saveRefinementTuning(def);
  return def;
}

/** Linear from `atL1` at level 1 to `atL100` at level 100; nothing below 1. */
export function refScale(level: number, atL1: number, atL100: number): number {
  if (level <= 0) return 0;
  const t = (Math.min(100, level) - 1) / 99;
  return atL1 + t * (atL100 - atL1);
}

/** One tuned single number. */
export function refNum(key: RefinementKey, field: string): number {
  return getRefinementTuning()[key][field];
}

/** One tuned curve, read at a level. */
export function refCurve(key: RefinementKey, field: string, level: number): number {
  const t = getRefinementTuning()[key];
  return refScale(level, t[`${field}L1`], t[`${field}L100`]);
}

// --- Shaped effects: the ones that aren't a straight line. Shared by the ---
// --- engine and the refinement screen so a tuned number can't read two ways. --

/** Precision Striker's hit-range bonus, in px. */
export function precisionStrikerRangeBonus(level: number): number {
  const per = refNum("precisionStriker", "rangePerLevels");
  const max = refNum("precisionStriker", "rangeMaxPx");
  if (per <= 0) return 0;
  return Math.max(0, Math.min(max, Math.floor(Math.max(0, level) / per)));
}

/** How many punches an opponent can crowd Slippery with before self-penalty. */
export function slipperyRepunchThreshold(level: number): number | undefined {
  const t = getRefinementTuning().slippery;
  if (level >= t.tier3Level) return t.tier3Punches;
  if (level >= t.tier2Level) return t.tier2Punches;
  if (level >= t.tier1Level) return t.tier1Punches;
  return undefined;
}

/** Chin Hitter's charge-punch damage multiplier — two slopes, joined. */
export function chinHitterChargeMult(level: number): number {
  const t = getRefinementTuning().chinHitter;
  const lv = Math.max(0, Math.min(100, level));
  const bp = t.chargeBreakLevel;
  return lv <= bp ? 1 + lv * t.chargePerLevelLow : 1 + bp * t.chargePerLevelLow + (lv - bp) * t.chargePerLevelHigh;
}

/** Technician's free charge whiffs. */
export function technicianWhiffForgiveness(level: number): number {
  const t = getRefinementTuning().technician;
  if (t.whiffPerLevels <= 0) return 0;
  return Math.max(0, Math.min(t.whiffMax, Math.floor(Math.max(0, level) / t.whiffPerLevels)));
}
