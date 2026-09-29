/**
 * ===== RL REWARD =====
 *
 * What the RL trainer pays the learning policy for. Every term is read off
 * engine state — a snapshot of the learner's corner taken after each fixed
 * step, diffed against the previous one — using only the fixed constants below
 * and the editable weights. Nothing the policy itself outputs (its picks, its
 * value estimate) ever feeds back into its own reward.
 *
 * No engine imports: the check script builds snapshots by hand.
 */
import type { FighterState, GameState } from "./types";

// ===== TERMS & WEIGHTS =====

export const RL_REWARD_TERMS = [
  "damage",
  "counter",
  "perfectBlock",
  "dodge",
  "lowStamina",
  "chargedWhiff",
  "passiveBehind",
  "outcome",
] as const;
export type RlRewardTerm = (typeof RL_REWARD_TERMS)[number];

export const RL_REWARD_TERM_LABELS: Record<RlRewardTerm, string> = {
  damage: "Damage dealt",
  counter: "Landed on recovery",
  perfectBlock: "Perfect block",
  dodge: "Slip / dodge",
  lowStamina: "Stamina < 15%",
  chargedWhiff: "Whiffed charge",
  passiveBehind: "Passive while behind",
  outcome: "Win / loss",
};

export interface RlRewardWeights {
  /** Per unit of scored damage (one unit = 1% of the opponent's bout-start pool). */
  damage: number;
  /** Per clean punch landed while the opponent was recovering from a punch or whiff. */
  counter: number;
  /** Per perfect block made. */
  perfectBlock: number;
  /** Per opponent punch slipped. */
  dodge: number;
  /** Once per decision interval in which stamina dipped below 15%. */
  lowStamina: number;
  /** Per charged punch that failed to land. */
  chargedWhiff: number;
  /** Per second spent not punching while behind on the scorecard. */
  passiveBehind: number;
  /** End-of-bout bonus for a win. */
  win: number;
  /** End-of-bout bonus for a loss (normally negative). */
  loss: number;
}

export const DEFAULT_RL_REWARD_WEIGHTS: RlRewardWeights = {
  damage: 1.0,
  counter: 2.0,
  perfectBlock: 1.5,
  dodge: 1.5,
  lowStamina: -2.0,
  chargedWhiff: -1.0,
  passiveBehind: -0.1,
  win: 5,
  loss: -5,
};

export const RL_REWARD_WEIGHT_KEYS = Object.keys(DEFAULT_RL_REWARD_WEIGHTS) as (keyof RlRewardWeights)[];

/** Any missing or non-finite weight falls back to its default. */
export function sanitizeRlRewardWeights(w: unknown): RlRewardWeights {
  const src = (w && typeof w === "object" ? w : {}) as Record<string, unknown>;
  const out = { ...DEFAULT_RL_REWARD_WEIGHTS };
  for (const k of RL_REWARD_WEIGHT_KEYS) {
    const v = src[k];
    if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

// ===== FIXED CONSTANTS =====

/** Below this fraction of max stamina the learner is charged the low-stamina term. */
export const RL_LOW_STAMINA_FRAC = 0.15;
/** Seconds without throwing before the learner counts as passive. */
export const RL_PASSIVE_IDLE_SEC = 1.0;
/** One damage unit, as a fraction of the opponent's bout-start max stamina. */
export const RL_DAMAGE_UNIT_FRAC = 0.01;

// ===== SNAPSHOT =====

/** The learner-side reading of one engine step. */
export interface RlRewardSnapshot {
  /** Scored (judged) damage the learner has dealt this round. */
  scoredDamage: number;
  /** Damage the cards are decided on, both sides. */
  damageDealt: number;
  oppDamageDealt: number;
  cleanLanded: number;
  /** The opponent is in the linger/retraction of a punch, or slowed by a whiff. */
  oppRecovering: boolean;
  perfectBlocks: number;
  /** Opponent punches the learner slipped this round. */
  dodges: number;
  chargedMisses: number;
  punchesThrown: number;
  stamina: number;
  maxStamina: number;
  /** Opponent's max stamina at the bell, for the damage unit. */
  oppPoolStart: number;
  /** Both fighters up and the round running. */
  live: boolean;
}

/** Opponent is exposed: finishing a punch, or slowed down by a whiffed one. */
export function isRecoveringFromPunch(f: FighterState): boolean {
  if (f.isPunching && (f.punchPhase === "linger" || f.punchPhase === "retraction")) return true;
  return (f.moveSlowTimer ?? 0) > 0 && (f.moveSlowMult ?? 1) < 1 && !f.isPunching;
}

export function rlRewardSnapshot(state: GameState, side: "player" | "enemy"): RlRewardSnapshot {
  const me = side === "player" ? state.player : state.enemy;
  const opp = side === "player" ? state.enemy : state.player;
  const rs = state.roundStats;
  return {
    scoredDamage: (side === "player" ? rs?.playerDamageThisRound : rs?.enemyDamageThisRound) ?? 0,
    damageDealt: me.damageDealt ?? 0,
    oppDamageDealt: opp.damageDealt ?? 0,
    cleanLanded: me.cleanPunchesLanded ?? 0,
    oppRecovering: isRecoveringFromPunch(opp),
    perfectBlocks: me.perfectBlocksMade ?? 0,
    dodges: (side === "player" ? rs?.playerPunchesDodged : rs?.enemyPunchesDodged) ?? 0,
    chargedMisses: me.chargedPunchesMissed ?? 0,
    punchesThrown: me.punchesThrown ?? 0,
    stamina: me.stamina,
    maxStamina: me.maxStamina,
    oppPoolStart: opp.boutStartMaxStamina || opp.maxStamina || 100,
    live: state.phase === "fighting" && !me.isKnockedDown && !opp.isKnockedDown,
  };
}

// ===== ACCUMULATION =====

export type RlRewardTerms = Record<RlRewardTerm, number>;

export function emptyRlRewardTerms(): RlRewardTerms {
  const t = {} as RlRewardTerms;
  for (const k of RL_REWARD_TERMS) t[k] = 0;
  return t;
}

export function sumRlRewardTerms(t: RlRewardTerms): number {
  let s = 0;
  for (const k of RL_REWARD_TERMS) s += t[k];
  return s;
}

export function addRlRewardTerms(into: RlRewardTerms, from: RlRewardTerms): void {
  for (const k of RL_REWARD_TERMS) into[k] += from[k];
}

/** Running state between steps that a single diff can't carry. */
export interface RlRewardTracker {
  /** Seconds since the learner last threw. */
  idle: number;
  /** Stamina dipped under the threshold at some step of the open interval. */
  lowSeen: boolean;
}

export function newRlRewardTracker(): RlRewardTracker {
  return { idle: 0, lowSeen: false };
}

/** Growth of a counter that may be reset at a round boundary. */
const grew = (prev: number, cur: number) => (cur >= prev ? cur - prev : Math.max(0, cur));

/**
 * Add one step's reward (weighted, per term) into `acc`. The low-stamina term
 * is not paid here — it is noted on the tracker and charged once when the
 * decision interval closes (closeRlRewardInterval).
 */
export function accumulateRlReward(
  acc: RlRewardTerms,
  prev: RlRewardSnapshot,
  cur: RlRewardSnapshot,
  dt: number,
  w: RlRewardWeights,
  track: RlRewardTracker,
): void {
  const unit = Math.max(1e-6, cur.oppPoolStart * RL_DAMAGE_UNIT_FRAC);
  const dmg = grew(prev.scoredDamage, cur.scoredDamage);
  if (dmg > 0) acc.damage += w.damage * (dmg / unit);

  const landed = grew(prev.cleanLanded, cur.cleanLanded);
  if (landed > 0 && (prev.oppRecovering || cur.oppRecovering)) acc.counter += w.counter * landed;

  const pb = grew(prev.perfectBlocks, cur.perfectBlocks);
  if (pb > 0) acc.perfectBlock += w.perfectBlock * pb;

  const dodged = grew(prev.dodges, cur.dodges);
  if (dodged > 0) acc.dodge += w.dodge * dodged;

  const cw = grew(prev.chargedMisses, cur.chargedMisses);
  if (cw > 0) acc.chargedWhiff += w.chargedWhiff * cw;

  if (cur.maxStamina > 0 && cur.stamina / cur.maxStamina < RL_LOW_STAMINA_FRAC) track.lowSeen = true;

  if (cur.punchesThrown !== prev.punchesThrown) track.idle = 0;
  else track.idle += dt;
  if (cur.live && track.idle >= RL_PASSIVE_IDLE_SEC && cur.damageDealt < cur.oppDamageDealt) {
    acc.passiveBehind += w.passiveBehind * dt;
  }
}

/** Close a decision interval: charge the low-stamina term once if it applied. */
export function closeRlRewardInterval(acc: RlRewardTerms, w: RlRewardWeights, track: RlRewardTracker): void {
  if (track.lowSeen) acc.lowStamina += w.lowStamina;
  track.lowSeen = false;
}

/** End-of-bout bonus. A draw pays nothing. */
export function rlOutcomeReward(won: boolean | null, w: RlRewardWeights): number {
  if (won === null) return 0;
  return won ? w.win : w.loss;
}
