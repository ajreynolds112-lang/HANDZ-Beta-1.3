/**
 * Defensive Mastery — a 0-100% readout of how complete the player's defence is:
 *   35%  their best Defense-track refinement, toward max level
 *   35%  their Defense stat, toward 1000
 *   30%  their auto slip chance, toward 45%
 * plus a bonus from perfect blocks in gym sparring and the Doghouse.
 * Each share fills in proportion. Every 10% crossed pays diamonds once.
 */
import type { CareerRosterState, Fighter, SkillRefinement } from "@shared/schema";
import { activeRefinementsOnly, autoSlipPotential } from "./engine";
import { autoSlipTrainedOf } from "./slipTraining";
import type { GameState } from "./types";

export const DEFENSIVE_REFINEMENT_KEYS = ["ironChin", "slippery", "guardMaster", "duckRecovery", "punchRolling"] as const;
const REFINEMENT_LEVEL_MAX = 100;
const DEFENSE_LEVEL_MAX = 1000;
/** Auto slip chance that fills the auto slip share. */
export const DEFENSIVE_MASTERY_AUTO_SLIP_TARGET = 0.45;

const SHARE_REFINEMENT = 35;
const SHARE_DEFENSE = 35;
const SHARE_AUTO_SLIP = 30;

/** Defensive Mastery percentage points per perfect block, by sparring grade. */
export const MASTERY_PCT_PER_PERFECT_BLOCK: Record<string, number> = {
  journeyman: 0.0005,
  contender: 0.001,
  elite: 0.0015,
  champion: 0.002,
};
/** Doghouse: 8x journeyman, paid per opponent defeated. */
export const MASTERY_PCT_PER_PERFECT_BLOCK_DOGHOUSE = 0.004;

/** Perfect blocks the player made this bout. */
export function perfectBlocksOf(state: GameState): number {
  return Math.max(0, state.player.perfectBlocksMade ?? 0);
}
/** Doghouse perfect blocks already banked by an opponent going down. */
export function doghousePerfectBlocksBankedOf(state: GameState): number {
  return Math.max(0, state.doghousePerfectBlocksBanked ?? 0);
}

/** Perfect-block Defensive Mastery this career has earned, in percentage points. */
export function defensiveMasteryBonusOf(rs: CareerRosterState | null | undefined): number {
  return Math.max(0, rs?.defensiveMasteryBonusPct ?? 0);
}

/** Adds `gainPct` starting from the larger of the blob's and the saved value. */
export function grantDefensiveMasteryBonus(
  rs: CareerRosterState,
  saved: CareerRosterState | null | undefined,
  gainPct: number,
): CareerRosterState {
  if (!(gainPct > 0)) return rs;
  const base = Math.max(defensiveMasteryBonusOf(rs), defensiveMasteryBonusOf(saved));
  return { ...rs, defensiveMasteryBonusPct: base + gainPct };
}

/** Diamonds paid for reaching tier n (n = 1..10, i.e. 10%..100%). Rises to 300. */
export function defensiveMasteryTierDiamonds(tier: number): number {
  return Math.max(0, Math.min(10, Math.floor(tier))) * 30;
}

export interface DefensiveMastery {
  pct: number;
  refinementPct: number;
  defensePct: number;
  autoSlipPct: number;
  perfectBlockPct: number;
  bestRefinementLevel: number;
  defenseLevel: number;
  autoSlip: number;
}

export function defensiveMasteryOf(fighter: Fighter, roster: CareerRosterState | null | undefined): DefensiveMastery {
  const ref = (fighter.skillRefinement ?? null) as Partial<SkillRefinement> | null;
  const bestRefinementLevel = Math.max(0, ...DEFENSIVE_REFINEMENT_KEYS.map(k => Number(ref?.[k]) || 0));
  const defenseLevel = Math.max(0, Number((fighter.skillPoints as { defense?: number } | null)?.defense) || 0);
  // Slippery only adds auto slip while it is one of the active refinements.
  const active = ref ? activeRefinementsOnly(ref as Record<string, unknown>, true) : null;
  const slipperyLive = Number(active?.slippery) || 0;
  const autoSlip = autoSlipPotential(slipperyLive, defenseLevel, autoSlipTrainedOf(roster));

  const refinementPct = SHARE_REFINEMENT * Math.min(1, bestRefinementLevel / REFINEMENT_LEVEL_MAX);
  const defensePct = SHARE_DEFENSE * Math.min(1, defenseLevel / DEFENSE_LEVEL_MAX);
  const autoSlipPct = SHARE_AUTO_SLIP * Math.min(1, autoSlip / DEFENSIVE_MASTERY_AUTO_SLIP_TARGET);
  const perfectBlockPct = defensiveMasteryBonusOf(roster);
  const pct = Math.max(0, Math.min(100, refinementPct + defensePct + autoSlipPct + perfectBlockPct));
  return { pct, refinementPct, defensePct, autoSlipPct, perfectBlockPct, bestRefinementLevel, defenseLevel, autoSlip };
}

/** 10% tiers reached (0-10). */
export function defensiveMasteryTier(pct: number): number {
  return Math.max(0, Math.min(10, Math.floor(pct / 10 + 1e-9)));
}

/** Tiers already paid on this career. */
export function defensiveMasteryPaidTierOf(roster: CareerRosterState | null | undefined): number {
  return Math.max(0, Math.min(10, Math.floor(roster?.defensiveMasteryPaidTier ?? 0)));
}

/** Lifetime counted slips banked by the gym. */
export function slipsLandedTotalOf(roster: CareerRosterState | null | undefined): number {
  return Math.max(0, Math.floor(roster?.slipsLandedTotal ?? 0));
}
