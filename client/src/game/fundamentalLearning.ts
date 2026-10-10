/**
 * The learning layer of the fundamentals trainer.
 *
 * The sweep used to hand each fundamental to its cycle winner by copying that
 * seed's block whole, and to replace the bottom half of each generation with
 * seeds drawn at random over the whole space. That is random search plus
 * winner-take-all, which is exactly what Neural Networks from Scratch P.9 shows
 * failing: it throws away what every other seed's result says, and a lucky
 * cycle overwrites a good block in one jump.
 *
 * This file replaces it with an evolution-strategies learner. The rules come
 * from the neural-networks skill (NNFS, PPO, RL by the Book):
 *
 *  - Evidence, not raw rates (NNFS P.7: a loss that sees confidence beats raw
 *    accuracy). A rate is shrunk toward the field mean by how little it rests
 *    on, so 1/1 cannot outrank 40/50.
 *  - A baseline (RL principle 8). Seeds are scored by centred rank around the
 *    field's median: only better-than-median seeds pull the champion, in
 *    proportion to their margin. Ranks also make the step blind to the scale
 *    of the rates, which differ wildly between fundamentals.
 *  - Every seed's result is used. The direction is the rank-weighted
 *    difference across the whole population (an ES gradient estimate), not
 *    just the winner's block.
 *  - Adam on that direction, with the PPO-style trust region: no parameter
 *    moves more than STEP_CLIP of its range in one cycle.
 *  - A search distribution with a learned width. New seeds are sampled around
 *    the champion in mirrored (antithetic) pairs, which cancels the noise term
 *    of the estimate; the width per fundamental grows while consecutive steps
 *    agree and shrinks when they flip (cumulative step-size adaptation).
 *  - Exploration is not optional (RL principle 5): one replacement per
 *    generation is still drawn from the whole space.
 *  - Roll back a bad update (PPO notes): the champion is gated at every
 *    generation against the last champion that passed, and is reverted if it
 *    clearly loses to it.
 *
 * Pure maths: no engine imports, so the check script can run it directly.
 */

import {
  FUNDAMENTALS, FUNDAMENTAL_BY_KEY, paramId, makeRandomSeed,
  type Fundamental, type FundamentalSeed,
} from "./aiFundamentals";

// ------------------------------------------------------------- constants

/** Prior strength, in attempts, of the shrink toward the field mean. */
export const EVIDENCE_PRIOR = 6;
/** Adam on normalised (0..1) parameter coordinates. */
export const ADAM_LR = 0.08;
export const ADAM_B1 = 0.9;
export const ADAM_B2 = 0.999;
const ADAM_EPS = 1e-8;
/** Trust region: largest move of one parameter in one cycle, as range share. */
export const STEP_CLIP = 0.12;
/** Search-distribution width, as a share of each parameter's range. */
export const SIGMA_INIT = 0.15;
export const SIGMA_MIN = 0.03;
export const SIGMA_MAX = 0.35;
const SIGMA_GROW = 1.15;
const SIGMA_SHRINK = 0.85;
/** Cosine between consecutive steps that counts as agreeing / flipping. */
const AGREE_COS = 0.3;
/** Frozen past champions kept as league opponents. */
export const LEAGUE_SIZE = 3;
/** Gate: bouts needed before a generation's champion is judged, and the win
 *  rate against the last passed champion below which it is rolled back. With
 *  fewer bouts the tally carries into the next generation undecided. */
export const GATE_MIN_BOUTS = 12;
export const GATE_ROLLBACK_BELOW = 0.4;
/** Gate bouts scheduled into every cycle. */
export const GATE_BOUTS_PER_CYCLE = 2;

// ------------------------------------------------------------- evidence

/**
 * Empirical-Bayes rate: successes and attempts with a Beta prior centred on
 * the field's pooled rate, worth EVIDENCE_PRIOR attempts. No attempts at all
 * returns the prior (the seed says nothing either way).
 */
export function evidenceScore(successes: number, attempts: number, fieldRate: number): number {
  const p = Number.isFinite(fieldRate) ? Math.min(1, Math.max(0, fieldRate)) : 0.5;
  return (successes + EVIDENCE_PRIOR * p) / (Math.max(0, attempts) + EVIDENCE_PRIOR);
}

/** Pooled rate across everyone that had a chance. */
export function fieldRate(stats: { attempts: number; successes: number }[]): number {
  let a = 0, s = 0;
  for (const st of stats) { a += st.attempts; s += st.successes; }
  return a > 0 ? s / a : 0.5;
}

/**
 * Centred-rank utilities: best gets +0.5, worst −0.5, evenly spaced, summing to
 * zero. Ties share their average rank, so identical scores pull nowhere.
 */
export function centredRanks(scores: number[]): number[] {
  const n = scores.length;
  if (n < 2) return scores.map(() => 0);
  const order = scores.map((s, i) => ({ s, i })).sort((x, y) => x.s - y.s);
  const rank = new Array<number>(n);
  for (let k = 0; k < n;) {
    let j = k;
    while (j + 1 < n && order[j + 1].s === order[k].s) j++;
    const avg = (k + j) / 2;
    for (let t = k; t <= j; t++) rank[order[t].i] = avg;
    k = j + 1;
  }
  return rank.map(r => r / (n - 1) - 0.5);
}

// ------------------------------------------------------------- learner state

export interface AdamMoment { m: number; v: number; }

export interface LearnerState {
  /** Param id -> Adam moments. */
  adam: Record<string, AdamMoment>;
  /** Fundamental key -> Adam steps taken (for bias correction). */
  steps: Record<string, number>;
  /** Fundamental key -> search width, share of range. */
  sigma: Record<string, number>;
  /** Fundamental key -> last normalised step, for step-size adaptation. */
  lastStep: Record<string, number[]>;
  /** Fundamental key -> size (L∞, share of range) of the last step. */
  lastStepSize: Record<string, number>;
}

export function emptyLearner(): LearnerState {
  return { adam: {}, steps: {}, sigma: {}, lastStep: {}, lastStepSize: {} };
}

/** Repairs a learner restored from a save (missing maps, non-finite values). */
export function normalizeLearner(src: unknown): LearnerState {
  const l = emptyLearner();
  if (!src || typeof src !== "object") return l;
  const s = src as Partial<LearnerState>;
  const fin = (v: unknown) => typeof v === "number" && Number.isFinite(v);
  for (const [k, mo] of Object.entries(s.adam ?? {})) {
    if (mo && fin(mo.m) && fin(mo.v) && mo.v >= 0) l.adam[k] = { m: mo.m, v: mo.v };
  }
  for (const [k, v] of Object.entries(s.steps ?? {})) if (fin(v) && v >= 0) l.steps[k] = Math.floor(v);
  for (const [k, v] of Object.entries(s.sigma ?? {})) {
    if (fin(v)) l.sigma[k] = Math.min(SIGMA_MAX, Math.max(SIGMA_MIN, v));
  }
  for (const [k, v] of Object.entries(s.lastStep ?? {})) {
    if (Array.isArray(v) && v.every(fin)) l.lastStep[k] = v.slice();
  }
  for (const [k, v] of Object.entries(s.lastStepSize ?? {})) if (fin(v)) l.lastStepSize[k] = v;
  return l;
}

export const sigmaFor = (l: LearnerState, fundKey: string) => l.sigma[fundKey] ?? SIGMA_INIT;

const norm = (v: number, min: number, max: number) => (max > min ? (v - min) / (max - min) : 0);
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

// ------------------------------------------------------------- the update

export interface LearnInput {
  seed: FundamentalSeed;
  successes: number;
  attempts: number;
}

export interface LearnResult {
  /** False when fewer than two seeds had a chance: nothing is moved. */
  stepped: boolean;
  /** Largest single-parameter move, share of range. */
  stepSize: number;
  sigma: number;
  /** Seed id -> evidence score used for the ranking. */
  scores: Record<number, number>;
}

/**
 * One learning step on one fundamental's block of the champion.
 *
 * direction = Σ₊ uᵢ·(xᵢ − x_champ) / Σ₊ uᵢ over the seeds ranked above the
 * field's median, with uᵢ the centred ranks of their evidence scores and xᵢ
 * their normalised parameters. The median is the baseline: only seeds that beat
 * it pull, in proportion to how far they beat it (CMA-style weighted
 * recombination). Below-median seeds do not push — a far-off explorer that did
 * badly says nothing about which way is uphill from where the champion is.
 * Adam turns the direction into a step, the trust region caps it.
 * Mutates `champion.params` and `learner`.
 */
export function learnFundamental(
  fund: Fundamental,
  inputs: LearnInput[],
  champion: { params: Record<string, number> },
  learner: LearnerState,
): LearnResult {
  const sigma = sigmaFor(learner, fund.key);
  const chances = inputs.filter(i => i.attempts > 0);
  const field = fieldRate(chances);
  const scores: Record<number, number> = {};
  for (const i of chances) scores[i.seed.id] = evidenceScore(i.successes, i.attempts, field);
  if (chances.length < 2 || fund.params.length === 0) {
    return { stepped: false, stepSize: 0, sigma, scores };
  }

  const u = centredRanks(chances.map(i => scores[i.seed.id]));
  const pos = u.reduce((a, v) => a + (v > 0 ? v : 0), 0);
  if (pos <= 0) return { stepped: false, stepSize: 0, sigma, scores };

  const t = (learner.steps[fund.key] ?? 0) + 1;
  learner.steps[fund.key] = t;
  const step: number[] = [];
  let size = 0;
  fund.params.forEach(pr => {
    const id = paramId(fund.key, pr.key);
    const xc = norm(champion.params[id] ?? pr.def, pr.min, pr.max);
    let d = 0;
    chances.forEach((c, k) => {
      if (u[k] > 0) d += u[k] * (norm(c.seed.params[id] ?? pr.def, pr.min, pr.max) - xc);
    });
    d /= pos;
    const mo = learner.adam[id] ?? { m: 0, v: 0 };
    mo.m = ADAM_B1 * mo.m + (1 - ADAM_B1) * d;
    mo.v = ADAM_B2 * mo.v + (1 - ADAM_B2) * d * d;
    learner.adam[id] = mo;
    const mHat = mo.m / (1 - Math.pow(ADAM_B1, t));
    const vHat = mo.v / (1 - Math.pow(ADAM_B2, t));
    let s = ADAM_LR * mHat / (Math.sqrt(vHat) + ADAM_EPS);
    s = Math.max(-STEP_CLIP, Math.min(STEP_CLIP, s));
    const x = clamp01(xc + s);
    champion.params[id] = pr.min + x * (pr.max - pr.min);
    step.push(s);
    size = Math.max(size, Math.abs(s));
  });

  // Cumulative step-size adaptation: agreeing steps mean the search is still
  // walking somewhere (widen), flipping steps mean it is oscillating around an
  // optimum (narrow).
  const prev = learner.lastStep[fund.key];
  let next = sigma;
  if (prev && prev.length === step.length) {
    let dot = 0, a = 0, b = 0;
    for (let i = 0; i < step.length; i++) { dot += step[i] * prev[i]; a += step[i] ** 2; b += prev[i] ** 2; }
    const cos = a > 0 && b > 0 ? dot / Math.sqrt(a * b) : 0;
    if (cos > AGREE_COS) next = sigma * SIGMA_GROW;
    else if (cos < -AGREE_COS) next = sigma * SIGMA_SHRINK;
  }
  next = Math.min(SIGMA_MAX, Math.max(SIGMA_MIN, next));
  learner.sigma[fund.key] = next;
  learner.lastStep[fund.key] = step;
  learner.lastStepSize[fund.key] = size;
  return { stepped: true, stepSize: size, sigma: next, scores };
}

// ------------------------------------------------------------- sampling

function gaussian(rand: () => number): number {
  let u = 0;
  while (u <= 1e-12) u = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

/**
 * A mirrored pair around the champion: one noise draw ε per parameter, scaled
 * by that fundamental's width, added to one child and subtracted from the
 * other. Clamped to the parameter's range.
 */
export function antitheticPair(
  champion: { params: Record<string, number> },
  learner: LearnerState,
  rand: () => number,
): [Record<string, number>, Record<string, number>] {
  const plus: Record<string, number> = {};
  const minus: Record<string, number> = {};
  for (const f of FUNDAMENTALS) {
    const sg = sigmaFor(learner, f.key);
    for (const pr of f.params) {
      const id = paramId(f.key, pr.key);
      const c = norm(champion.params[id] ?? pr.def, pr.min, pr.max);
      const e = gaussian(rand) * sg;
      plus[id] = pr.min + clamp01(c + e) * (pr.max - pr.min);
      minus[id] = pr.min + clamp01(c - e) * (pr.max - pr.min);
    }
  }
  return [plus, minus];
}

/**
 * Fresh seeds for the slots a generation cut empties. The first is an explorer
 * drawn from the whole space; the rest come in mirrored pairs around the
 * champion (an odd one out takes the "+" half of a pair). Salvaged blocks are
 * laid on afterwards by the caller.
 */
export function sampleReplacements(
  slots: { id: number; name: string }[],
  gen: number,
  champion: { params: Record<string, number> },
  learner: LearnerState,
  rand: () => number,
): FundamentalSeed[] {
  const out: FundamentalSeed[] = [];
  let pending: Record<string, number> | null = null;
  slots.forEach((slot, k) => {
    const seed = makeRandomSeed(slot.id, slot.name, gen, rand);
    if (k > 0) {
      if (pending) { seed.params = pending; pending = null; }
      else {
        const [p, m] = antitheticPair(champion, learner, rand);
        seed.params = p;
        pending = m;
      }
    }
    out.push(seed);
  });
  return out;
}

// ------------------------------------------------------------- league & gate

export interface GateTally { wins: number; losses: number; bouts: number; }

export interface GateDecision {
  decided: boolean;
  rolledBack: boolean;
  rate: number;
  bouts: number;
}

/** The champion's showing against the last passed champion. Draws count as
 *  half. Undecided below GATE_MIN_BOUTS. */
export function judgeGate(t: GateTally): GateDecision {
  const draws = Math.max(0, t.bouts - t.wins - t.losses);
  const rate = t.bouts > 0 ? (t.wins + draws * 0.5) / t.bouts : 0.5;
  if (t.bouts < GATE_MIN_BOUTS) return { decided: false, rolledBack: false, rate, bouts: t.bouts };
  return { decided: true, rolledBack: rate < GATE_ROLLBACK_BELOW, rate, bouts: t.bouts };
}

/** Newest first, capped at LEAGUE_SIZE. */
export function pushLeague(league: Record<string, number>[], params: Record<string, number>): Record<string, number>[] {
  return [{ ...params }, ...league].slice(0, LEAGUE_SIZE);
}

/** Only the blocks of the given fundamentals, for snapshot comparisons. */
export function blockOf(params: Record<string, number>, fundKey: string): number[] {
  const f = FUNDAMENTAL_BY_KEY[fundKey];
  return f ? f.params.map(pr => params[paramId(fundKey, pr.key)] ?? pr.def) : [];
}
