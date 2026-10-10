/**
 * Pure Power — a 0-100% gym meter fed by Weight Lifting.
 *
 * Every Weight Lifting session (played or swept) adds 20%. Three full weeks
 * without one and it sheds 20% a week, on the same grace/step schedule as the
 * Punch Endurance clocks (and paused in fight week like them). In every career
 * bout and gym session the player fights with up to +35% power, scaled by the
 * meter, paid into the additive power pool; the meter also cuts crit chance
 * against the player, and a full meter costs some max stamina and speed.
 */
import type { CareerRosterState } from "@shared/schema";
import type { GameState } from "./types";

export const PURE_POWER_MAX = 100;
export const PURE_POWER_PER_SESSION = 20;
export const PURE_POWER_DECAY_PER_WEEK = 20;
/** Power bonus at 100% (fraction). */
export const PURE_POWER_MAX_BONUS = 0.35;
/** Crit chance against the player drops by this share per full 20% of meter. */
export const PURE_POWER_CRIT_RESIST_PER_STEP = 0.05;
/** Costs that only apply at a full meter (fractions). */
export const PURE_POWER_FULL_STAMINA_PENALTY = 0.05;
export const PURE_POWER_FULL_SPEED_PENALTY = 0.03;

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
 * the additive pool; crit chance against them falls 5% (relative) per full 20%;
 * at 100% they also lose 5% max stamina and 3% speed.
 */
export function applyPurePower(state: GameState, roster: CareerRosterState | null | undefined): void {
  const pct = purePowerOf(roster);
  if (pct <= 0) return;
  const p = state.player;
  p.powerBonusPct += purePowerBonusOf(roster);
  const steps = Math.floor(pct / PURE_POWER_PER_SESSION);
  if (steps > 0) p.critResistMult = Math.max(0, p.critResistMult * (1 - steps * PURE_POWER_CRIT_RESIST_PER_STEP));
  if (pct >= PURE_POWER_MAX) {
    const st = 1 - PURE_POWER_FULL_STAMINA_PENALTY;
    p.maxStamina *= st;
    p.maxStaminaCap *= st;
    p.stamina = p.maxStamina;
    const sp = 1 - PURE_POWER_FULL_SPEED_PENALTY;
    p.punchSpeedMult *= sp;
    p.moveSpeed *= sp;
    p.duckSpeedMult *= sp;
  }
}
