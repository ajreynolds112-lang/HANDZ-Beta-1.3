/**
 * Punch Endurance — how many real punches a fighter gets for every slice of max
 * stamina their own work burns off for the rest of a bout. The slice is a
 * percentage of the pool they walked into the bout with, not a point count.
 *
 * A career fighter grows it in the gym (regular sparring, the Doghouse and
 * Nightmare) and loses it to idle weeks; AI opponents carry a value handed out
 * by the Roster Generation bands. Anything without a value — old saves, gym
 * partners, quick fight, menu bouts — fights at the floor.
 */
import type { CareerRosterState } from "@shared/schema";
import type { GameState } from "./types";

/** Floor, and the value every fighter without one fights at. */
export const PUNCH_ENDURANCE_MIN = 30;
/** Ceiling — no fighter ever gets more punches per point than this. */
export const PUNCH_ENDURANCE_MAX = 120;
/**
 * Full weeks of inactivity before a conditioning clock starts slipping — three
 * without sparring for the punch count, three off the heavy bag for the stamina
 * cost.
 *
 * Measured from the week the session was logged in, and the penalty fires on
 * the advance *into* that week plus this many, so a fighter gets one fewer
 * whole idle week than the number reads like: 3 is what buys two clean weeks.
 */
export const PUNCH_ENDURANCE_GRACE_WEEKS = 3;
/**
 * Full weeks per point once a clock has started slipping. Deliberately shared
 * by both halves — the punch count and the stamina cost run identical
 * schedules, and separate constants would let them drift apart again.
 */
export const PUNCH_ENDURANCE_STEP_WEEKS = 1;
/** Nightmare kills inside a single run that earn one point. */
export const NIGHTMARE_KILLS_PER_PUNCH_ENDURANCE = 15;
// The charged-punch surcharge and the charged crit/stun refund used to live here
// as constants. They are Max Stamina Events like any other now, editable in the
// Neural Network tuning screen alongside the rest.

/**
 * Ceiling on the cost — twenty idle weeks off the heavy bag, and every punch
 * cycle is taking a fifth of the tank.
 */
export const PUNCH_ENDURANCE_LOSS_MAX = 20;
/**
 * The cost every career starts at, and what any fighter without a value pays:
 * the "1" in "1% of max stamina every 30 punches". The number is a *percentage
 * of the pool the fighter walked into the bout with*, so it costs the same in
 * round 12 as in round 1, and one decay cycle off the bag adds another point of
 * it.
 */
export const PUNCH_ENDURANCE_LOSS_MIN = 1;
/**
 * Points a single heavy bag session takes off the cost, applied the moment the
 * session ends. Sessions are never rate-limited: the grace period governs only
 * the climb back up.
 */
export const PUNCH_ENDURANCE_LOSS_PER_BAG_SESSION = 1;

/** Coerce anything stored or typed by the user into the legal 20–120 range. */
export function clampPunchEndurance(v: unknown): number {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.round(v) : PUNCH_ENDURANCE_MIN;
  return Math.max(PUNCH_ENDURANCE_MIN, Math.min(PUNCH_ENDURANCE_MAX, n));
}

/** The player's career Punch Endurance — the floor for saves that predate it. */
export function punchEnduranceOf(roster: CareerRosterState | null | undefined): number {
  return clampPunchEndurance(roster?.punchEndurance);
}

/**
 * Coerce a stored cost into the legal 1–20 (percent) range. Anything missing
 * reads as the floor, which is where every career starts — a fighter with no
 * value of their own pays the opening rate, not the ceiling.
 *
 * The cost used to be a flat point count. A number stored under the old unit is
 * re-based rather than converted (see {@link needsPunchEnduranceLossRebase});
 * there is no honest exchange rate between "3 points" and "3% of the pool".
 */
export function clampPunchEnduranceLoss(v: unknown): number {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.round(v) : PUNCH_ENDURANCE_LOSS_MIN;
  return Math.max(PUNCH_ENDURANCE_LOSS_MIN, Math.min(PUNCH_ENDURANCE_LOSS_MAX, n));
}

/**
 * True while a stored cost is still a point-era number. Point values read as
 * ruinous percentages — a career sitting at the old 20-point ceiling would be
 * shedding a fifth of its tank every punch cycle — so the callers that own a
 * stored value re-base it to the floor once and stamp that they have.
 */
export function needsPunchEnduranceLossRebase(stamp: unknown): boolean {
  return stamp !== true;
}

/** The player's career cost per drain — the ceiling for saves that predate it. */
export function punchEnduranceLossOf(roster: CareerRosterState | null | undefined): number {
  return clampPunchEnduranceLoss(roster?.punchEnduranceLoss);
}

/**
 * Hand a corner its Punch Endurance for one bout. Applied right after
 * `startFight` the way item boosts are, rather than through that function's
 * already enormous argument list. A side left out keeps the engine's floor.
 */
export function applyPunchEndurance(
  state: GameState,
  values: {
    player?: number | null; enemy?: number | null;
    playerLoss?: number | null; enemyLoss?: number | null;
  },
): void {
  if (values.player != null) state.player.punchEndurance = clampPunchEndurance(values.player);
  if (values.enemy != null) state.enemy.punchEndurance = clampPunchEndurance(values.enemy);
  if (values.playerLoss != null) state.player.punchEnduranceLoss = clampPunchEnduranceLoss(values.playerLoss);
  if (values.enemyLoss != null) state.enemy.punchEnduranceLoss = clampPunchEnduranceLoss(values.enemyLoss);
}
