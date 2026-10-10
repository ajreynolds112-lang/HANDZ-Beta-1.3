/**
 * Slip training: every slip the player puts in themselves that makes a punch
 * miss from close range in a gym session adds a sliver of auto slip chance,
 * paid only when the session is won (sparring) or puts someone away (Doghouse).
 */
import type { CareerRosterState } from "@shared/schema";
import type { GameState } from "./types";

/** A slip only counts when the punch came from this close. */
export const SLIP_TRAINING_RANGE_PX = 80;

/** Auto slip percentage points per counted slip, by sparring grade. */
export const SLIP_TRAINING_PCT_PER_SLIP: Record<string, number> = {
  journeyman: 0.001,
  contender: 0.002,
  elite: 0.003,
  champion: 0.004,
};
export const SLIP_TRAINING_PCT_PER_SLIP_DOGHOUSE = 0.001;

/** Percentage points of auto slip chance this career has earned. */
export function autoSlipTrainedOf(rs: CareerRosterState | null | undefined): number {
  return Math.max(0, rs?.autoSlipTrainedPct ?? 0);
}

/** Puts the career's trained auto slip chance on the player corner. */
export function applySlipTraining(state: GameState, pct: number): void {
  state.player.autoSlipTrainedBonus = Math.max(0, pct) / 100;
}

/** Counted slips the player landed this bout. */
export function slipsLandedOf(state: GameState): number {
  return Math.max(0, state.player.inputSlipsLanded ?? 0);
}

/**
 * Adds `gainPct` to the roster blob, starting from the larger of the blob's
 * value and the saved one — payout handlers rebuild the blob from a snapshot
 * a sibling handler may already have moved past.
 */
export function grantSlipTraining(
  rs: CareerRosterState,
  saved: CareerRosterState | null | undefined,
  gainPct: number,
): CareerRosterState {
  if (!(gainPct > 0)) return rs;
  const base = Math.max(autoSlipTrainedOf(rs), autoSlipTrainedOf(saved));
  return { ...rs, autoSlipTrainedPct: base + gainPct };
}

/** Adds this session's counted slips to the career's lifetime tally. */
export function bankSlipsLanded(
  rs: CareerRosterState,
  saved: CareerRosterState | null | undefined,
  slips: number,
): CareerRosterState {
  if (!(slips > 0)) return rs;
  const base = Math.max(rs.slipsLandedTotal ?? 0, saved?.slipsLandedTotal ?? 0);
  return { ...rs, slipsLandedTotal: base + Math.floor(slips) };
}
