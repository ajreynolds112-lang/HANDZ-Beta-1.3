/**
 * Pure Power — a 0-100% gym meter fed by Weight Lifting.
 *
 * Every Weight Lifting session (played or swept) adds 20%. Two full weeks
 * without one and it sheds 20% a week, on the Punch Endurance step schedule
 * (and paused in fight week like them). In every career
 * bout and gym session the player fights with up to +35% power, scaled by the
 * meter, paid into the additive power pool; the meter also cuts crit and stun
 * chance against the player, and from 60% it costs some max stamina and speed.
 */
import type { CareerRosterState } from "@shared/schema";
import type { GameState } from "./types";

export const PURE_POWER_MAX = 100;
export const PURE_POWER_PER_SESSION = 20;
export const PURE_POWER_DECAY_PER_WEEK = 20;
/** Weeks without Weight Lifting before the meter starts to drop. */
export const PURE_POWER_GRACE_WEEKS = 2;
/** At 0% (career only), crit and stun chance against the player rise by this share. */
export const PURE_POWER_EMPTY_VULN = 0.05;
/** Power bonus at 100% (fraction). */
export const PURE_POWER_MAX_BONUS = 0.35;
/** Crit chance against the player drops by this share per full 20% of meter. */
export const PURE_POWER_CRIT_RESIST_PER_STEP = 0.05;
/** Stun chance against the player drops by this share per full 20% of meter. */
export const PURE_POWER_STUN_RESIST_PER_STEP = 0.03;
/** Max stamina / speed costs (fractions) by meter threshold, highest first. */
const PURE_POWER_PENALTIES: { at: number; stamina: number; speed: number }[] = [
  { at: 100, stamina: 0.10, speed: 0.08 },
  { at: 80, stamina: 0.07, speed: 0.06 },
  { at: 60, stamina: 0.04, speed: 0.02 },
];

/** Max stamina / speed cost (fractions) at this meter value. */
export function purePowerPenaltyOf(pct: number): { stamina: number; speed: number } {
  return PURE_POWER_PENALTIES.find(t => pct >= t.at) ?? { stamina: 0, speed: 0 };
}

export function clampPurePower(v: unknown): number {
  const n = typeof v === "number" && Number.isFinite(v) ? v : 0;
  return Math.max(0, Math.min(PURE_POWER_MAX, n));
}

export function purePowerOf(roster: CareerRosterState | null | undefined): number {
  return clampPurePower(roster?.purePower);
}

/** Power bonus (fraction) the meter is worth right now. */
export function purePowerBonusOf(roster: CareerRosterState | null | undefined): number {
  return (purePowerOf(roster) / PURE_POWER_MAX) * PURE_POWER_MAX_BONUS;
}

/**
 * The player's Pure Power effects; call once per bout setup. Power goes into
 * the additive pool; crit chance against them falls 5% and stun chance 3%
 * (relative) per full 20%; from 60% they also lose max stamina and speed.
 */
export function applyPurePower(state: GameState, roster: CareerRosterState | null | undefined): void {
  const pct = purePowerOf(roster);
  if (pct <= 0) {
    // Empty meter: crit chance against the player rises 5%, and the stun roll
    // reads the same multiplier. No roster = not a career bout = no penalty.
    if (roster) state.player.critResistMult *= 1 + PURE_POWER_EMPTY_VULN;
    return;
  }
  const p = state.player;
  p.powerBonusPct += purePowerBonusOf(roster);
  const steps = Math.floor(pct / PURE_POWER_PER_SESSION);
  if (steps > 0) {
    p.critResistMult = Math.max(0, p.critResistMult * (1 - steps * PURE_POWER_CRIT_RESIST_PER_STEP));
    p.purePowerStunResist = steps * PURE_POWER_STUN_RESIST_PER_STEP;
  }
  const pen = purePowerPenaltyOf(pct);
  if (pen.stamina > 0 || pen.speed > 0) {
    const st = 1 - pen.stamina;
    p.maxStamina *= st;
    p.maxStaminaCap *= st;
    p.stamina = p.maxStamina;
    const sp = 1 - pen.speed;
    p.punchSpeedMult *= sp;
    p.moveSpeed *= sp;
    p.duckSpeedMult *= sp;
  }
}
