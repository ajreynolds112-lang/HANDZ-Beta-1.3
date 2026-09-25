/**
 * Reset training — the three things a career fighter can buy back from Energy
 * fatigue, each grown by its own work and each decaying on its own clock once
 * that work stops.
 *
 * - Blocking, bought with Weight Lifting sessions. At the ceiling a block
 *   thrown mid-sway is as good as a fresh one.
 * - The sway's damage debuff, bought with charge punches landed in sparring.
 * - Slip speed during your own Reset, bought by slipping inside one.
 *
 * Every value is in percentage points, and each track keeps its own lifetime rep
 * count because that is what buys extra weeks onto its decay clock. Anything
 * without a value — AI opponents, quick fight, menu bouts, careers saved before
 * this existed — fights at zero, which is the untrained behaviour the fatigue
 * rules describe on their own.
 */
import type { CareerRosterState } from "@shared/schema";
import type { GameState } from "./types";

export type ResetTrainKey = "block" | "damage" | "slip";

export interface ResetTrainTrack {
  /** Percentage points one grant is worth. */
  readonly perGrant: number;
  /** Reps that make up a grant, so "1% every 2 charge punches" is a 2 here. */
  readonly repsPerGrant: number;
  /** Ceiling, in percentage points. */
  readonly max: number;
  /**
   * Weeks of grace before the first point comes off, and the cadence it keeps
   * coming off at. One number covers both: "a 1% decay of 2 weeks starting at
   * the 3rd week's beginning" is a grace of two weeks and a step of two weeks.
   */
  readonly weeks: number;
  /** Points lost each time that clock comes round. */
  readonly perDecay: number;
}

export const RESET_TRAIN: Record<ResetTrainKey, ResetTrainTrack> = {
  // Capped at the 90% a sway takes away, so a maxed fighter blocks through the
  // sway exactly as well as they would standing still — never better.
  block: { perGrant: 1, repsPerGrant: 1, max: 90, weeks: 2, perDecay: 1 },
  // Capped at the 50% debuff for the same reason: it can be cancelled, not
  // turned into a bonus.
  damage: { perGrant: 1, repsPerGrant: 2, max: 50, weeks: 4, perDecay: 1 },
  // This one is a genuine bonus rather than a cancellation, so its ceiling is
  // just a ceiling: double-speed slips inside a Reset.
  slip: { perGrant: 1, repsPerGrant: 1, max: 100, weeks: 3, perDecay: 1 },
};

/**
 * Cumulative reps that buy one more week onto a track's decay clock. No ceiling
 * — a fighter who keeps drilling a movement can push its decay out indefinitely.
 */
export const RESET_TRAIN_REPS_PER_WEEK = 50;

export interface ResetTrainTrackState {
  /** Percentage points currently held. */
  value: number;
  /** Reps banked toward the next grant; never reaches a full grant's worth. */
  carry: number;
  /** Lifetime reps, which is what buys the extra decay weeks. */
  reps: number;
  /**
   * Roster week the next point is due off. Zero means the track has never been
   * trained, and an untrained track has nothing to lose.
   */
  due: number;
}

export type ResetTrainingState = Record<ResetTrainKey, ResetTrainTrackState>;

const RESET_TRAIN_KEYS: ResetTrainKey[] = ["block", "damage", "slip"];

function emptyTrack(): ResetTrainTrackState {
  return { value: 0, carry: 0, reps: 0, due: 0 };
}

/** A clean slate — what a new career and every untrained fighter reads as. */
export function emptyResetTraining(): ResetTrainingState {
  return { block: emptyTrack(), damage: emptyTrack(), slip: emptyTrack() };
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/**
 * Coerce anything stored into a legal state. Careers saved before this existed
 * carry nothing and read as a clean slate, which is the untrained behaviour.
 */
export function normalizeResetTraining(raw: unknown): ResetTrainingState {
  const src = (raw ?? {}) as Partial<Record<ResetTrainKey, Partial<ResetTrainTrackState>>>;
  const out = emptyResetTraining();
  for (const key of RESET_TRAIN_KEYS) {
    const cfg = RESET_TRAIN[key];
    const t = src[key];
    out[key] = {
      value: Math.max(0, Math.min(cfg.max, num(t?.value))),
      // A carry at or past a full grant would be a grant that never landed.
      carry: Math.max(0, Math.min(cfg.repsPerGrant - 1, Math.floor(num(t?.carry)))),
      reps: Math.max(0, Math.floor(num(t?.reps))),
      due: Math.max(0, Math.floor(num(t?.due))),
    };
  }
  return out;
}

/** The player's career Reset training — a clean slate for saves that predate it. */
export function resetTrainingOf(roster: CareerRosterState | null | undefined): ResetTrainingState {
  return normalizeResetTraining(roster?.resetTraining);
}

/**
 * The fourth Reset buy-back, and the only one kept outside the three-track
 * shape above: how much quicker the Reset itself plays.
 *
 * It is bought with ring time rather than reps — a sparring session shaves
 * RESET_SPEED_PER_SPAR off the snap, so it reads straight off the career's
 * lifetime spar count and needs no counter of its own. It rusts back on out of
 * the gym: after RESET_SPEED_GRACE_WEEKS without a session, one session's worth
 * comes back every week until the player spars again. Those weeks are banked as
 * steps rather than subtracted from the spar count, so going back to the gym
 * earns the time back a session at a time instead of handing back everything
 * the layoff took.
 *
 * Every mode pays into that same count, which is why the count is fractional:
 * the rates below are converted to session-equivalents rather than being given
 * clocks and caps of their own.
 */
export const RESET_SPEED_PER_SPAR = 0.0005;
/**
 * What an ordinary sparring session is worth against each grade of partner, as
 * a multiple of the base rate above. Sharper work is worth more ring time, and
 * the gym's own difficulty picker is the whole scale.
 */
export const SPAR_RESET_SPEED_TIER_MULT: Record<string, number> = {
  journeyman: 1,
  contender: 1.2,
  elite: 1.5,
  champion: 2,
};
/**
 * Nightmare and the Doghouse pay by the body instead: seconds off the snap for
 * each opponent actually put away, so the reward is the work done rather than a
 * flat fee for showing up. A run that puts nobody away buys no snap time — it
 * still counts as a session for the rust clock, which the week stamp handles.
 */
export const RESET_SPEED_PER_NIGHTMARE_WIN = 0.0001;
export const RESET_SPEED_PER_DOGHOUSE_WIN = 0.001;
export const RESET_SPEED_MAX = 0.1;
export const RESET_SPEED_GRACE_WEEKS = 3;
export const RESET_SPEED_STEP_WEEKS = 1;
/** Spars (and decay steps) it takes to cover the whole cap. */
export const RESET_SPEED_MAX_STEPS = Math.round(RESET_SPEED_MAX / RESET_SPEED_PER_SPAR);

/**
 * Seconds off the Reset snap for this career, after the layoff is counted.
 * Zero for anyone who has never sparred, and for every save that predates it.
 */
export function resetSpeedBonusOf(roster: CareerRosterState | null | undefined): number {
  // Not floored: a session is worth a fraction of a step in every mode that
  // pays by grade or by opponent, and flooring would throw those fractions away
  // rather than banking them towards the next step.
  const spars = Math.min(RESET_SPEED_MAX_STEPS, Math.max(0, roster?.totalSpars ?? 0));
  const rusted = Math.max(0, Math.floor(roster?.resetSpeedDecaySteps ?? 0));
  const steps = Math.max(0, Math.min(RESET_SPEED_MAX_STEPS, spars - rusted));
  return steps * RESET_SPEED_PER_SPAR;
}

/** Session-equivalents an ordinary sparring session against this grade is worth. */
export function sparSessionsForDifficulty(difficulty: string | null | undefined): number {
  return SPAR_RESET_SPEED_TIER_MULT[difficulty ?? ""] ?? 1;
}

/**
 * Session-equivalents for a mode that pays a flat number of seconds rather than
 * a session — Nightmare and the Doghouse, both by the opponent. Converted here
 * so the cap, the rust clock and the stored count all keep working off the one
 * number they always have.
 */
export function sparSessionsForSeconds(seconds: number): number {
  return Math.max(0, seconds) / RESET_SPEED_PER_SPAR;
}

/**
 * Weeks between decay steps on a track, once its lifetime reps are counted.
 * Reps only ever push the clock further out, so this never drops below the
 * track's own base.
 */
export function resetTrainDecayWeeks(key: ResetTrainKey, reps: number): number {
  return RESET_TRAIN[key].weeks + Math.floor(Math.max(0, reps) / RESET_TRAIN_REPS_PER_WEEK);
}

/**
 * Log reps against a track. Whole grants are paid out immediately, the
 * remainder is banked, and the decay clock restarts from the current week — so
 * doing the work is all it takes to keep a value alive.
 */
export function growResetTraining(
  rt: ResetTrainingState,
  key: ResetTrainKey,
  reps: number,
  currentWeek: number,
): ResetTrainingState {
  const add = Math.floor(reps);
  if (add <= 0) return rt;
  const cfg = RESET_TRAIN[key];
  const cur = rt[key];
  const banked = cur.carry + add;
  const grants = Math.floor(banked / cfg.repsPerGrant);
  const totalReps = cur.reps + add;
  return {
    ...rt,
    [key]: {
      value: Math.min(cfg.max, cur.value + grants * cfg.perGrant),
      carry: banked % cfg.repsPerGrant,
      reps: totalReps,
      // The grace is counted from the week the work happened, and the first
      // point comes off at the *beginning* of the week after it runs out —
      // hence the extra week on top of the cadence.
      due: currentWeek + resetTrainDecayWeeks(key, totalReps) + 1,
    },
  };
}

/**
 * Step every clock into `nextWeek`. Counted arithmetically rather than a week
 * at a time: an imported or long-idle save can be an arbitrary number of weeks
 * behind, and walking it would be a loop to reach a floor it hits almost
 * immediately. A track that has never been trained has no clock to run.
 */
export function advanceResetTrainingWeek(
  rt: ResetTrainingState,
  nextWeek: number,
): ResetTrainingState {
  const out: ResetTrainingState = { ...rt };
  for (const key of RESET_TRAIN_KEYS) {
    const cfg = RESET_TRAIN[key];
    const cur = out[key];
    if (cur.due <= 0 || nextWeek < cur.due) continue;
    const step = Math.max(1, resetTrainDecayWeeks(key, cur.reps));
    const drops = Math.floor((nextWeek - cur.due) / step) + 1;
    out[key] = {
      ...cur,
      value: Math.max(0, cur.value - drops * cfg.perDecay),
      due: cur.due + drops * step,
    };
  }
  return out;
}

/**
 * Hand a corner its Reset training for one bout. Applied right after
 * `startFight` the way item boosts and Punch Endurance are, rather than through
 * that function's already enormous argument list. A side left out keeps the
 * engine's untrained zeroes.
 */
export function applyResetTraining(
  state: GameState,
  values: {
    player?: ResetTrainingState | null;
    enemy?: ResetTrainingState | null;
    /** Reset-speed seconds, which live on the roster rather than in the tracks. */
    playerSpeed?: number;
    enemySpeed?: number;
  },
): void {
  if (values.playerSpeed != null) state.player.fatigue.trainSpeed = Math.max(0, values.playerSpeed);
  if (values.enemySpeed != null) state.enemy.fatigue.trainSpeed = Math.max(0, values.enemySpeed);
  if (values.player) {
    const t = normalizeResetTraining(values.player);
    state.player.fatigue.trainBlock = t.block.value;
    state.player.fatigue.trainDamage = t.damage.value;
    state.player.fatigue.trainSlip = t.slip.value;
  }
  if (values.enemy) {
    const t = normalizeResetTraining(values.enemy);
    state.enemy.fatigue.trainBlock = t.block.value;
    state.enemy.fatigue.trainDamage = t.damage.value;
    state.enemy.fatigue.trainSlip = t.slip.value;
  }
}
