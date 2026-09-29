/**
 * ===== RL OBSERVATION =====
 *
 * The normalized vector the tactical policy reads when it picks a string. Every
 * entry is in [0, 1] except the scorecard lead, which is in [-1, 1].
 *
 * The game has no separate health bar — the stamina bar is what a punch takes
 * away and what a stoppage reads — so "health" and "stamina" are stood in for
 * by the bar fraction, the pool against the pool the bout started with, and the
 * fatigue (Energy) spent.
 *
 * Opponent defence is read off the *requested* defence state, not the delayed
 * physical crouch: the AI reacts to what the fighter has asked for, the same
 * way the tokenizer and every other AI read does.
 *
 * Type-only imports, so the check script can load this under plain Node.
 */
import type { AiBrainState, FighterState, GameState } from "./types";

export const RL_OBS_FEATURES = [
  "distRing",        // separation / ring width
  "distVsReach",     // separation / (2 x attack range): 0.5 = edge of range
  "myRopeRoom",      // own distance to the nearest rope, / half the ring
  "oppRopeRoom",
  "myStamina",       // bar fraction
  "oppStamina",
  "myPool",          // max stamina / bout-start max stamina
  "oppPool",
  "myFatigue",       // share of Energy spent
  "oppFatigue",
  "oppAttacking",
  "oppGuarding",
  "oppDucking",
  "oppFeinting",
  "mySouthpaw",
  "oppSouthpaw",
  "myChargeArmed",
  "oppChargeArmed",
  "oppHurt",
  "oppStunned",
  "roundProgress",   // 0 first round .. 1 last round
  "roundTimeLeft",   // roundTimer / roundDuration
  "scoreLead",       // brain.scorecardBias, -1 .. 1
  "myStunned",
] as const;

export const RL_OBS_SIZE = RL_OBS_FEATURES.length;

const clamp01 = (v: number) => (Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0);
const clampPm1 = (v: number) => (Number.isFinite(v) ? Math.max(-1, Math.min(1, v)) : 0);
const bit = (b: unknown) => (b ? 1 : 0);

function ropeRoom(f: FighterState, state: GameState | null): number {
  if (!state) return 1;
  const w = state.ringRight - state.ringLeft;
  const h = state.ringBottom - state.ringTop;
  if (!(w > 0) || !(h > 0)) return 1;
  const nearest = Math.min(f.x - state.ringLeft, state.ringRight - f.x, f.z - state.ringTop, state.ringBottom - f.z);
  return clamp01(nearest / (0.5 * Math.min(w, h)));
}

function staminaFrac(f: FighterState): number {
  return f.maxStamina > 0 ? clamp01(f.stamina / f.maxStamina) : 1;
}

function poolFrac(f: FighterState): number {
  const start = f.boutStartMaxStamina;
  return start && start > 0 ? clamp01(f.maxStamina / start) : 1;
}

function fatigueSpent(f: FighterState): number {
  const fat = f.fatigue;
  if (!fat || !fat.sampled || !(fat.maxEnergy > 0)) return 0;
  return clamp01(1 - fat.energy / fat.maxEnergy);
}

function isStunned(f: FighterState): boolean {
  return f.isKnockedDown || f.stunPunchDisableTimer > 0 || f.stunBlockDisableTimer > 0;
}

/**
 * @param me   the fighter the brain drives
 * @param opp  the fighter it is facing
 */
export function buildRlObservation(
  state: GameState | null,
  me: FighterState,
  opp: FighterState,
  brain: AiBrainState,
): Float32Array {
  const obs = new Float32Array(RL_OBS_SIZE);
  const dist = Math.hypot(opp.x - me.x, opp.z - me.z);
  const ringW = state && state.ringRight - state.ringLeft > 0 ? state.ringRight - state.ringLeft : 800;
  const reach = brain.attackRangeMax > 0 ? brain.attackRangeMax : 100;
  const oppStam = staminaFrac(opp);
  const oppHurt = isStunned(opp) || oppStam < 0.22;

  let i = 0;
  obs[i++] = clamp01(dist / ringW);
  obs[i++] = clamp01(dist / (2 * reach));
  obs[i++] = ropeRoom(me, state);
  obs[i++] = ropeRoom(opp, state);
  obs[i++] = staminaFrac(me);
  obs[i++] = oppStam;
  obs[i++] = poolFrac(me);
  obs[i++] = poolFrac(opp);
  obs[i++] = fatigueSpent(me);
  obs[i++] = fatigueSpent(opp);
  obs[i++] = bit((opp.isPunching || opp.telegraphPhase !== "none") && !opp.isFeinting && !opp.telegraphIsFeint);
  obs[i++] = bit(opp.defenseState === "fullGuard");
  obs[i++] = bit(opp.defenseState === "duck");
  obs[i++] = bit(opp.isFeinting || opp.telegraphIsFeint);
  obs[i++] = bit(me.boxingStance === "southpaw");
  obs[i++] = bit(opp.boxingStance === "southpaw");
  obs[i++] = bit(me.chargeArmed);
  obs[i++] = bit(opp.chargeArmed);
  obs[i++] = bit(oppHurt);
  obs[i++] = bit(isStunned(opp));
  obs[i++] = state && state.totalRounds > 1
    ? clamp01((state.currentRound - 1) / (state.totalRounds - 1))
    : 0;
  obs[i++] = state && state.roundDuration > 0 ? clamp01(state.roundTimer / state.roundDuration) : 1;
  obs[i++] = clampPm1(brain.scorecardBias ?? 0);
  obs[i++] = bit(isStunned(me));
  return obs;
}
