/**
 * Shared plumbing for unrendered CPU-vs-CPU bouts: how one is started, stepped
 * and resolved. Both trainers on the AI Training screen run on this — the
 * fundamentals sweep and the RL policy trainer — so a bout means the same thing
 * to both: the same fixed 60 Hz step, the same one-minute round, the same
 * resolution rules.
 *
 * What differs between the trainers is only who sits in each corner, which is
 * why a corner is described by a brain factory rather than a seed. The caller
 * owns its own seed stream and hands in the draw; nothing here draws from it,
 * so each trainer's bout sequence stays independent of the other's.
 */
import type { GameState, Archetype, AiBrainState } from "./types";
import { createInitialState, startFight, updateGame } from "./engine";

/** Fixed timestep. Bouts must not vary with frame rate or results stop comparing. */
export const SIM_DT = 1 / 60;
export const ROUND_SECONDS = 60;
/** Hard ceiling so a stalemate can never wedge a run. */
export const MAX_TICKS = Math.ceil((ROUND_SECONDS + 12) / SIM_DT);
/** A bout is won by draining the opponent to this. */
export const STAMINA_FLOOR = 1;

export const HEADLESS_ARCHETYPES: Archetype[] = ["BoxerPuncher", "OutBoxer", "Brawler", "Swarmer"];

export type HeadlessOutcome = "drain" | "knockdown" | "cards" | "draw";

export interface HeadlessResult {
  /** 0 for corner A (the player slot), 1 for corner B, null for a draw. */
  winner: 0 | 1 | null;
  outcome: HeadlessOutcome;
}

/** One corner of a headless bout. */
export interface CornerSetup {
  name: string;
  /** Roster id handed to startFight for corner B (ignored for corner A). */
  rosterId?: number;
  /** Builds the brain that drives this corner, after the fight has started. */
  buildBrain: (archetype: Archetype, level: number) => AiBrainState;
}

/** The archetypes a bout draw assigns to the two corners. */
export function headlessArchetypes(r: number): [Archetype, Archetype] {
  return [
    HEADLESS_ARCHETYPES[r % HEADLESS_ARCHETYPES.length],
    HEADLESS_ARCHETYPES[(r >> 3) % HEADLESS_ARCHETYPES.length],
  ];
}

/**
 * Start a headless bout from one draw of the caller's seed stream.
 *
 * startFight gives the player corner a brain with no roster id, so neither a
 * neural override nor a trainee identity would be found for it. Both brains are
 * rebuilt afterwards from the corner factories instead of widening startFight's
 * argument list — corner B first, then corner A, which is the order the sweep
 * has always built them in and must keep for its results to stay comparable.
 */
export function startHeadlessBout(r: number, level: number, a: CornerSetup, b: CornerSetup): GameState {
  const [archA, archB] = headlessArchetypes(r);

  const state = startFight(
    createInitialState(),
    archA, level, level,
    a.name, undefined,
    true, "champion",
    1, ROUND_SECONDS, "normal",
    65, 65,
    archB, b.name,
    undefined,
    false, false, false, false,
    true,                 // cpuVsCpu
    undefined,
    false, undefined,
    1, 1, 1,
    undefined, undefined,
    false,
    b.rosterId,
  );

  state.aiBrain = b.buildBrain(archB, level);
  state.playerAiBrain = a.buildBrain(archA, level);

  state.phase = "fighting";
  state.countdownTimer = 0;
  state.introAnimActive = false;
  state.introAnimTimer = 0;
  state.playerIntroPlaying = false;
  state.enemyIntroPlaying = false;
  return state;
}

/**
 * Resolve a bout the moment it is decided, or null while it is still live. A
 * win means draining the opponent to the floor while staying off it; a
 * knockdown loses outright; anything still standing at the bell goes to the
 * cards on damage dealt, and an exact tie is a draw.
 */
export function resolveHeadless(state: GameState, ticks: number): HeadlessResult | null {
  const { player: a, enemy: b } = state;

  if (a.isKnockedDown && !b.isKnockedDown) return { winner: 1, outcome: "knockdown" };
  if (b.isKnockedDown && !a.isKnockedDown) return { winner: 0, outcome: "knockdown" };

  const aOut = a.stamina <= STAMINA_FLOOR;
  const bOut = b.stamina <= STAMINA_FLOOR;
  if (aOut || bOut) {
    if (aOut && bOut) return { winner: null, outcome: "draw" };
    return { winner: aOut ? 1 : 0, outcome: "drain" };
  }

  if (ticks >= MAX_TICKS || state.phase === "fightEnd" || state.phase === "roundEnd" || state.roundTimer <= 0) {
    if (a.damageDealt === b.damageDealt) return { winner: null, outcome: "draw" };
    return { winner: a.damageDealt > b.damageDealt ? 0 : 1, outcome: "cards" };
  }
  return null;
}

/** The part of a bout the stepper needs; trainers extend it with their own fields. */
export interface HeadlessBoutCore {
  state: GameState;
  ticks: number;
  done: boolean;
  winner: 0 | 1 | null;
  outcome: HeadlessOutcome;
}

/**
 * Advance a bout by up to `maxTicks` fixed steps, calling `onTick` after each
 * engine step and before resolution. Returns ticks consumed.
 */
export function stepHeadless(
  bout: HeadlessBoutCore,
  maxTicks: number,
  onTick?: (state: GameState, dt: number) => void,
): number {
  let n = 0;
  while (n < maxTicks && !bout.done) {
    bout.state = updateGame({ ...bout.state }, SIM_DT);
    if (onTick) onTick(bout.state, SIM_DT);
    bout.ticks++;
    n++;
    const res = resolveHeadless(bout.state, bout.ticks);
    if (res) {
      bout.winner = res.winner;
      bout.outcome = res.outcome;
      bout.done = true;
      break;
    }
  }
  return n;
}
