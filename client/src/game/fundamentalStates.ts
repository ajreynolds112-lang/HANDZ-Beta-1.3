/**
 * Fundamental states: situation-keyed parameter memory.
 *
 * A "fundamental state" is one remembered moment where the AI executed a
 * fundamental successfully, stored as (situation it happened in, the parameter
 * values it happened under). At fight time the AI reads the situation it is
 * actually in, finds the nearest remembered one for the fundamental whose
 * opportunity just arose, and adopts the parameters that worked there.
 *
 * Four things in here are worth understanding before changing anything:
 *
 * 1. The parameter -> knob map is derived numerically, never hand-written.
 *    `deriveNeuralState` collapses 218 fundamental parameters into 25 neural
 *    knobs by averaging, and it is affine in the parameters (every term is
 *    either `g(...)` or `1 - g(...)`, and the closing clamp never binds because
 *    an average of values in [0,1] is already in [0,1]). So probing it one
 *    parameter at a time recovers the exact Jacobian. Hand-maintaining that
 *    table would guarantee drift the first time somebody edits a formula.
 *
 * 2. Matching and merging are deliberately different tests. Matching wants a
 *    graceful nearest-neighbour over the whole situation, so it uses a weighted
 *    similarity. Merging wants "is this literally the same situation", and a
 *    weighted average is useless for that: because distance only carries 0.30
 *    of the score, two situations at opposite ends of the ring still score 0.70
 *    together, so an aggregate threshold either merges everything or nothing.
 *    Merging therefore gates each dimension separately.
 *
 * 3. Action sequences compare as recency-weighted bags first, exact positions
 *    second. Five-token sequences drawn from ~20 tokens have millions of
 *    orderings, so positional-only matching is almost always zero, which would
 *    hold every candidate below the activation floor forever.
 *
 * 4. Storage stays readable JSON on disk and is rehydrated into plain objects
 *    once, so the hot path neither parses nor allocates. Parameter keys are
 *    stored bare because the owning fundamental is already the enclosing key.
 */

import { FUNDAMENTALS, paramId, deriveNeuralState, type FundamentalSeed } from "./aiFundamentals";
import type { FighterState } from "./types";

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const clamp01 = (v: number) => clamp(v, 0, 1);

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** Hard cap on remembered states per fundamental. */
export const MAX_STATES_PER_FUND = 50;

/** Trailing window for the averaged distance term, in seconds. */
export const DIST_WINDOW = 3;
/** Trailing window for the averaged stamina terms, in seconds. */
export const STAM_WINDOW = 2;
/** How often the rolling windows take a sample, in seconds. */
const SAMPLE_INTERVAL = 0.1;

/** How many opponent actions form the sequence half of a situation. */
export const OPP_ACTION_MEMORY = 5;

/** Distance in px treated as "as far apart as matters", for normalising. */
const DIST_REFERENCE = 600;

/**
 * Similarity weights for matching. They sum to 1. Distance and the opponent's
 * recent actions carry the most because they are what actually distinguishes
 * one boxing situation from another; stamina and the damage edge describe the
 * shape of the fight rather than the moment.
 */
const W_DIST = 0.30;
const W_STAM = 0.20;
const W_DMG = 0.20;
const W_TOKENS = 0.30;

/** How much of the token score is order-insensitive overlap vs exact position. */
const TOKEN_BAG_SHARE = 0.7;

/**
 * Below this similarity the fundamental does not activate at all. Adopting the
 * parameters from a situation that does not resemble the present one is worse
 * than leaving the brain alone.
 */
export const SIMILARITY_FLOOR = 0.72;

/**
 * Per-dimension tolerances for treating two situations as the same one. Every
 * dimension must agree; see the note at the top of the file for why an
 * aggregate threshold cannot do this job.
 */
const MERGE_DIST = 0.08;
const MERGE_STAM = 0.12;
const MERGE_DMG = 0.15;
const MERGE_TOKENS = 0.60;

/** Largest inheritance jitter, applied when a win was as close as it gets. */
export const MAX_INHERIT_JITTER = 0.03;
/**
 * Success-rate gap at which a win counts as decisive and inherits unperturbed.
 * A narrow win means the parameters were not clearly better, so the next
 * generation should explore around them; a dominant win means leave them be.
 */
export const DECISIVE_MARGIN = 0.25;

// ---------------------------------------------------------------------------
// Parameter -> knob sensitivity, derived by probing deriveNeuralState
// ---------------------------------------------------------------------------

/** Every parameter id, in a fixed order. */
export const ALL_PARAM_IDS: string[] = (() => {
  const out: string[] = [];
  for (const f of FUNDAMENTALS) for (const pr of f.params) out.push(paramId(f.key, pr.key));
  return out;
})();

/** Parameter ids owned by each fundamental. */
export const PARAMS_BY_FUND: Record<string, string[]> = (() => {
  const out: Record<string, string[]> = {};
  for (const f of FUNDAMENTALS) out[f.key] = f.params.map(pr => paramId(f.key, pr.key));
  return out;
})();

/** Bounds for each parameter, so a nudge can be clamped to its declared range. */
export const PARAM_BOUNDS: Record<string, { min: number; max: number; def: number }> = (() => {
  const out: Record<string, { min: number; max: number; def: number }> = {};
  for (const f of FUNDAMENTALS) {
    for (const pr of f.params) out[paramId(f.key, pr.key)] = { min: pr.min, max: pr.max, def: pr.def };
  }
  return out;
})();

function probeSeed(params: Record<string, number>): FundamentalSeed {
  // deriveNeuralState only ever reads `params`; the rest is structural filler.
  return {
    id: -1, name: "probe", gen: 0, params,
    stats: {}, lifetime: {}, wins: 0, losses: 0, bouts: 0, parents: null, salvaged: [],
  };
}

interface Sensitivity {
  /** Knob ids in a fixed order. */
  knobs: string[];
  /** paramId -> d(knob)/d(param) across the parameter's full 0..1 span. */
  byParam: Record<string, Float64Array>;
  /** fundamental key -> knob ids it can actually move. */
  knobsByFund: Record<string, string[]>;
}

/**
 * Recover the exact parameter -> knob Jacobian by probing. One call per
 * parameter plus a baseline: 219 evaluations of a pure function of averages,
 * done once at module load.
 */
export const SENSITIVITY: Sensitivity = (() => {
  const zero: Record<string, number> = {};
  for (const id of ALL_PARAM_IDS) zero[id] = 0;

  const base = deriveNeuralState(probeSeed(zero));
  const knobs = Object.keys(base);
  const byParam: Record<string, Float64Array> = {};

  for (const id of ALL_PARAM_IDS) {
    const probed = deriveNeuralState(probeSeed({ ...zero, [id]: 1 }));
    const row = new Float64Array(knobs.length);
    for (let k = 0; k < knobs.length; k++) row[k] = probed[knobs[k]] - base[knobs[k]];
    byParam[id] = row;
  }

  // A knob a fundamental cannot move is not worth searching. kdRecovery1/2/3
  // are held at champion constants, so they fall out here with no sensitivity
  // to anything, which is the correct answer rather than a bug.
  const knobsByFund: Record<string, string[]> = {};
  for (const f of FUNDAMENTALS) {
    const live = new Set<string>();
    for (const pid of PARAMS_BY_FUND[f.key]) {
      const row = byParam[pid];
      for (let k = 0; k < knobs.length; k++) if (Math.abs(row[k]) > 1e-9) live.add(knobs[k]);
    }
    knobsByFund[f.key] = knobs.filter(k => live.has(k));
  }

  return { knobs, byParam, knobsByFund };
})();

/** Knob ids a given fundamental's parameters can actually influence. */
export function knobsForFundamental(fundKey: string): string[] {
  return SENSITIVITY.knobsByFund[fundKey] ?? [];
}

/**
 * Spread a desired change in one knob back across the parameters of a single
 * fundamental, least-norm: the smallest parameter movement that produces the
 * requested knob movement.
 *
 * Parameters that hit a bound are frozen and the unmet remainder is
 * redistributed over the ones that still have headroom, so the requested
 * movement is delivered in full whenever the fundamental can deliver it at all,
 * rather than being quietly short by whatever the clamp ate.
 */
export function distributeKnobDelta(
  fundKey: string,
  knob: string,
  delta: number,
  current: Record<string, number>,
): Record<string, number> {
  const ki = SENSITIVITY.knobs.indexOf(knob);
  const out: Record<string, number> = {};
  if (ki < 0 || delta === 0) return out;

  const ids = (PARAMS_BY_FUND[fundKey] ?? []).filter(id => Math.abs(SENSITIVITY.byParam[id][ki]) > 1e-9);
  if (ids.length === 0) return out;

  const value: Record<string, number> = {};
  for (const id of ids) value[id] = current[id] ?? PARAM_BOUNDS[id].def;

  const frozen = new Set<string>();
  let remaining = delta;

  for (let iter = 0; iter < 8 && Math.abs(remaining) > 1e-12; iter++) {
    let norm = 0;
    for (const id of ids) {
      if (frozen.has(id)) continue;
      const s = SENSITIVITY.byParam[id][ki];
      norm += s * s;
    }
    if (norm < 1e-12) break;

    let achieved = 0;
    let clampedAny = false;
    for (const id of ids) {
      if (frozen.has(id)) continue;
      const s = SENSITIVITY.byParam[id][ki];
      const b = PARAM_BOUNDS[id];
      const want = value[id] + (remaining * s) / norm;
      const next = clamp(want, b.min, b.max);
      if (next !== want) { frozen.add(id); clampedAny = true; }
      achieved += (next - value[id]) * s;
      value[id] = next;
    }
    remaining -= achieved;
    if (!clampedAny) break;
  }

  for (const id of ids) {
    const start = current[id] ?? PARAM_BOUNDS[id].def;
    if (value[id] !== start) out[id] = value[id];
  }
  return out;
}

/**
 * How far a knob can be moved through one fundamental's parameters, starting
 * from where they currently sit, in each direction. `up` is >= 0, `down` <= 0.
 *
 * This is the scale the in-bout search has to work in. A knob that averages
 * thirteen parameters gives any single one of them about a thirteenth of its
 * range, and a fundamental may own only one of the thirteen — so a fixed step
 * in knob units is enormous for one fundamental and unreachable for another.
 * Steps should always be requested as a fraction of the reach.
 */
export function knobReach(
  fundKey: string,
  knob: string,
  current: Record<string, number>,
): { up: number; down: number } {
  const ki = SENSITIVITY.knobs.indexOf(knob);
  if (ki < 0) return { up: 0, down: 0 };

  let up = 0;
  let down = 0;
  for (const id of PARAMS_BY_FUND[fundKey] ?? []) {
    const s = SENSITIVITY.byParam[id][ki];
    if (Math.abs(s) <= 1e-9) continue;
    const b = PARAM_BOUNDS[id];
    const cur = current[id] ?? b.def;
    const hi = (b.max - cur) * s;
    const lo = (b.min - cur) * s;
    up += Math.max(hi, lo);
    down += Math.min(hi, lo);
  }
  return { up, down };
}

// ---------------------------------------------------------------------------
// Situations
// ---------------------------------------------------------------------------

export interface Situation {
  /** Mean separation over the trailing window, normalised to [0,1]. */
  dist: number;
  /** Own mean stamina fraction over the trailing window. */
  selfStam: number;
  /** Opponent's mean stamina fraction over the trailing window. */
  oppStam: number;
  /** Signed damage edge in [-1,1]; positive means this corner is ahead. */
  dmgEdge: number;
  /** Opponent's most recent action tokens, oldest first. */
  oppActions: string[];
}

/**
 * Rolling windows for one corner. Sampled on a fixed interval rather than
 * accumulated per tick so the mean is a true window mean and the memory cost is
 * a couple of dozen numbers. Lives on the fighter's brain, never module scope —
 * module scope is wiped by HMR and shared with the menu fight.
 */
export class SituationTracker {
  private distBuf = new Float32Array(Math.ceil(DIST_WINDOW / SAMPLE_INTERVAL));
  private selfBuf = new Float32Array(Math.ceil(STAM_WINDOW / SAMPLE_INTERVAL));
  private oppBuf = new Float32Array(Math.ceil(STAM_WINDOW / SAMPLE_INTERVAL));
  private distN = 0;
  private stamN = 0;
  private distI = 0;
  private stamI = 0;
  private acc = 0;
  private oppActions: string[] = [];
  private prevOppPunching = false;

  reset(): void {
    this.distN = this.stamN = this.distI = this.stamI = 0;
    this.acc = 0;
    this.oppActions.length = 0;
    this.prevOppPunching = false;
  }

  /** Record the opponent's latest action token. Newest is kept last. */
  pushOpponentAction(token: string): void {
    this.oppActions.push(token);
    if (this.oppActions.length > OPP_ACTION_MEMORY) this.oppActions.shift();
  }

  update(dt: number, self: FighterState, opp: FighterState): void {
    // Edge-triggered, so it sits above the sampling gate: a punch thrown and
    // finished between two samples still happened. Capturing the token here
    // rather than at each call site is what keeps a situation recorded in
    // training comparable with one read at fight time — both sides get the same
    // rule for free.
    const punching = !!opp.isPunching && !!opp.currentPunch;
    if (punching && !this.prevOppPunching) this.pushOpponentAction(String(opp.currentPunch));
    this.prevOppPunching = punching;

    this.acc += dt;
    if (this.acc < SAMPLE_INTERVAL) return;
    this.acc = 0;

    const d = clamp01(Math.abs(self.x - opp.x) / DIST_REFERENCE);
    this.distBuf[this.distI] = d;
    this.distI = (this.distI + 1) % this.distBuf.length;
    if (this.distN < this.distBuf.length) this.distN++;

    this.selfBuf[this.stamI] = self.maxStamina > 0 ? clamp01(self.stamina / self.maxStamina) : 0;
    this.oppBuf[this.stamI] = opp.maxStamina > 0 ? clamp01(opp.stamina / opp.maxStamina) : 0;
    this.stamI = (this.stamI + 1) % this.selfBuf.length;
    if (this.stamN < this.selfBuf.length) this.stamN++;
  }

  private static mean(buf: Float32Array, n: number, fallback: number): number {
    if (n <= 0) return fallback;
    let s = 0;
    for (let i = 0; i < n; i++) s += buf[i];
    return s / n;
  }

  read(self: FighterState, opp: FighterState): Situation {
    const liveDist = clamp01(Math.abs(self.x - opp.x) / DIST_REFERENCE);
    const liveSelf = self.maxStamina > 0 ? clamp01(self.stamina / self.maxStamina) : 0;
    const liveOpp = opp.maxStamina > 0 ? clamp01(opp.stamina / opp.maxStamina) : 0;

    // Damage dealt as a share of what the other corner had to give. The two
    // stamina terms already carry "how much is left", so folding current
    // stamina in here as well would double-count it.
    const mine = self.damageDealt / Math.max(1, opp.maxStamina);
    const theirs = opp.damageDealt / Math.max(1, self.maxStamina);

    return {
      dist: SituationTracker.mean(this.distBuf, this.distN, liveDist),
      selfStam: SituationTracker.mean(this.selfBuf, this.stamN, liveSelf),
      oppStam: SituationTracker.mean(this.oppBuf, this.stamN, liveOpp),
      dmgEdge: clamp(mine - theirs, -1, 1),
      oppActions: this.oppActions.slice(),
    };
  }
}

/**
 * How alike two action histories are. Mostly an order-insensitive comparison of
 * what the opponent has been doing, with a minority share for having done it in
 * the same order. Both halves weight recent actions above old ones.
 */
export function tokenSimilarity(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 1;
  if (a.length === 0 || b.length === 0) return 0;

  const bag = (xs: string[]): Map<string, number> => {
    const m = new Map<string, number>();
    for (let i = 0; i < xs.length; i++) {
      const w = OPP_ACTION_MEMORY - (xs.length - 1 - i);
      m.set(xs[i], (m.get(xs[i]) ?? 0) + Math.max(1, w));
    }
    return m;
  };

  const ba = bag(a);
  const bb = bag(b);
  let sa = 0;
  let sb = 0;
  let inter = 0;
  ba.forEach(v => { sa += v; });
  bb.forEach(v => { sb += v; });
  ba.forEach((v, k) => { inter += Math.min(v, bb.get(k) ?? 0); });
  const overlap = sa > 0 && sb > 0 ? inter / Math.max(sa, sb) : 0;

  let pScore = 0;
  let pWeight = 0;
  for (let i = 0; i < OPP_ACTION_MEMORY; i++) {
    const wa = a[a.length - 1 - i];
    const wb = b[b.length - 1 - i];
    if (wa === undefined && wb === undefined) continue;
    const w = OPP_ACTION_MEMORY - i;
    pWeight += w;
    if (wa !== undefined && wa === wb) pScore += w;
  }
  const positional = pWeight > 0 ? pScore / pWeight : 1;

  return clamp01(TOKEN_BAG_SHARE * overlap + (1 - TOKEN_BAG_SHARE) * positional);
}

/** Similarity of two situations in [0,1], used for nearest-neighbour matching. */
export function situationSimilarity(a: Situation, b: Situation): number {
  const dist = 1 - Math.abs(a.dist - b.dist);
  const stam = 1 - (Math.abs(a.selfStam - b.selfStam) + Math.abs(a.oppStam - b.oppStam)) / 2;
  const dmg = 1 - Math.abs(a.dmgEdge - b.dmgEdge) / 2;
  const tokens = tokenSimilarity(a.oppActions, b.oppActions);
  return clamp01(W_DIST * dist + W_STAM * stam + W_DMG * dmg + W_TOKENS * tokens);
}

/**
 * Whether two situations are the same situation for storage purposes. Every
 * dimension has to agree independently — an aggregate score cannot express this
 * because a single dimension can only ever move the total by its own weight.
 */
export function situationsMergeable(a: Situation, b: Situation): boolean {
  return Math.abs(a.dist - b.dist) <= MERGE_DIST
    && Math.abs(a.selfStam - b.selfStam) <= MERGE_STAM
    && Math.abs(a.oppStam - b.oppStam) <= MERGE_STAM
    && Math.abs(a.dmgEdge - b.dmgEdge) <= MERGE_DMG
    && tokenSimilarity(a.oppActions, b.oppActions) >= MERGE_TOKENS;
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

export interface FundamentalState {
  /** The situation this was learned in. */
  s: Situation;
  /** Values for the owning fundamental's parameters only. */
  p: Record<string, number>;
  /** How many successes back this entry — its weight as evidence. */
  n: number;
}

/** Fundamental key -> remembered states. */
export type FundamentalStateStore = Record<string, FundamentalState[]>;

export function emptyStore(): FundamentalStateStore {
  return {};
}

function blendInto(target: FundamentalState, s: Situation, p: Record<string, number>, weight: number): void {
  for (const k of Object.keys(p)) target.p[k] = (target.p[k] ?? p[k]) * (1 - weight) + p[k] * weight;
  target.s.dist = target.s.dist * (1 - weight) + s.dist * weight;
  target.s.selfStam = target.s.selfStam * (1 - weight) + s.selfStam * weight;
  target.s.oppStam = target.s.oppStam * (1 - weight) + s.oppStam * weight;
  target.s.dmgEdge = target.s.dmgEdge * (1 - weight) + s.dmgEdge * weight;
}

/**
 * Fold one success into the store. An observation in the same situation as an
 * existing entry merges into it — averaging by evidence weight — rather than
 * consuming a slot, so the 50 entries converge on genuinely distinct situations
 * instead of thrashing over near-duplicates.
 */
export function recordState(
  store: FundamentalStateStore,
  fundKey: string,
  situation: Situation,
  params: Record<string, number>,
): void {
  const list = (store[fundKey] ??= []);

  let bestI = -1;
  let bestSim = -1;
  for (let i = 0; i < list.length; i++) {
    if (!situationsMergeable(situation, list[i].s)) continue;
    const sim = situationSimilarity(situation, list[i].s);
    if (sim > bestSim) { bestSim = sim; bestI = i; }
  }

  if (bestI >= 0) {
    const e = list[bestI];
    blendInto(e, situation, params, 1 / (e.n + 1));
    e.s.oppActions = situation.oppActions.slice();
    e.n++;
    return;
  }

  list.push({ s: { ...situation, oppActions: situation.oppActions.slice() }, p: { ...params }, n: 1 });

  if (list.length > MAX_STATES_PER_FUND) {
    let worst = 0;
    for (let i = 1; i < list.length; i++) if (list[i].n < list[worst].n) worst = i;
    list.splice(worst, 1);
  }
}

/**
 * Nearest remembered state for a fundamental, or null when nothing resembles
 * the present situation closely enough to be worth adopting.
 */
export function matchState(
  store: FundamentalStateStore,
  fundKey: string,
  situation: Situation,
): FundamentalState | null {
  const list = store[fundKey];
  if (!list || list.length === 0) return null;

  let best: FundamentalState | null = null;
  let bestSim = SIMILARITY_FLOOR;
  for (let i = 0; i < list.length; i++) {
    const sim = situationSimilarity(situation, list[i].s);
    if (sim >= bestSim) { bestSim = sim; best = list[i]; }
  }
  return best;
}

/**
 * Union two corners' memories for one fundamental and prune back to the cap,
 * using the same merge rule that governs recording so the result is shaped like
 * a memory that learned all of it first-hand.
 */
export function mergeStates(a: FundamentalState[], b: FundamentalState[]): FundamentalState[] {
  const out: FundamentalState[] = a.map(e => ({
    s: { ...e.s, oppActions: e.s.oppActions.slice() }, p: { ...e.p }, n: e.n,
  }));

  for (const e of b) {
    let bestI = -1;
    let bestSim = -1;
    for (let i = 0; i < out.length; i++) {
      if (!situationsMergeable(e.s, out[i].s)) continue;
      const sim = situationSimilarity(e.s, out[i].s);
      if (sim > bestSim) { bestSim = sim; bestI = i; }
    }
    if (bestI >= 0) {
      const t = out[bestI];
      const total = t.n + e.n;
      blendInto(t, e.s, e.p, e.n / total);
      t.n = total;
    } else {
      out.push({ s: { ...e.s, oppActions: e.s.oppActions.slice() }, p: { ...e.p }, n: e.n });
    }
  }

  out.sort((x, y) => y.n - x.n);
  return out.slice(0, MAX_STATES_PER_FUND);
}

// ---------------------------------------------------------------------------
// Inheritance
// ---------------------------------------------------------------------------

/**
 * How hard to perturb an inherited state, from the margin the win was taken by.
 * A dead-even win inherits at the full jitter because the parameters were not
 * demonstrably better than the runner-up's; a win by `DECISIVE_MARGIN` or more
 * inherits untouched.
 */
export function jitterForMargin(margin: number): number {
  const closeness = 1 - clamp01(Math.abs(margin) / DECISIVE_MARGIN);
  return MAX_INHERIT_JITTER * closeness;
}

/**
 * Apply inheritance jitter to every parameter of every state. Each parameter
 * gets its own roll in [-frac, +frac] so a state drifts as a cloud rather than
 * sliding bodily in one direction.
 */
export function jitterStates(
  states: FundamentalState[],
  frac: number,
  rand: () => number,
): FundamentalState[] {
  if (frac <= 0) return states;
  return states.map(e => {
    const p: Record<string, number> = {};
    for (const k of Object.keys(e.p)) {
      const b = PARAM_BOUNDS[k];
      const scale = b ? b.max - b.min : 1;
      const moved = e.p[k] + (rand() * 2 - 1) * frac * scale;
      p[k] = b ? clamp(moved, b.min, b.max) : moved;
    }
    return { s: { ...e.s, oppActions: e.s.oppActions.slice() }, p, n: e.n };
  });
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

const R3 = (v: number) => Math.round(v * 1e3) / 1e3;

/**
 * Readable JSON, rounded to three places. Parameter keys are written bare — the
 * owning fundamental is already the enclosing key, so repeating it on all 218
 * parameters would roughly double the file for no information.
 */
export function serializeStore(store: FundamentalStateStore): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(store)) {
    const list = store[key];
    if (!list || list.length === 0) continue;
    const prefix = key + ".";
    out[key] = list.map(e => ({
      s: {
        dist: R3(e.s.dist), selfStam: R3(e.s.selfStam), oppStam: R3(e.s.oppStam),
        dmgEdge: R3(e.s.dmgEdge), oppActions: e.s.oppActions.slice(),
      },
      p: Object.fromEntries(Object.keys(e.p).map(k => [
        k.startsWith(prefix) ? k.slice(prefix.length) : k,
        R3(e.p[k]),
      ])),
      n: e.n,
    }));
  }
  return out;
}

/** Parse a stored blob back into a store, dropping anything malformed. */
export function deserializeStore(raw: unknown): FundamentalStateStore {
  const out: FundamentalStateStore = {};
  if (!raw || typeof raw !== "object") return out;
  const known = new Set(FUNDAMENTALS.map(f => f.key));

  for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
    if (!known.has(key) || !Array.isArray(val)) continue;
    const owned = new Set(PARAMS_BY_FUND[key] ?? []);
    const list: FundamentalState[] = [];

    for (const item of val) {
      if (!item || typeof item !== "object") continue;
      const e = item as { s?: unknown; p?: unknown; n?: unknown };
      const s = e.s as Partial<Situation> | undefined;
      if (!s || typeof s.dist !== "number") continue;

      const p: Record<string, number> = {};
      if (e.p && typeof e.p === "object") {
        for (const [pk, pv] of Object.entries(e.p as Record<string, unknown>)) {
          if (typeof pv !== "number") continue;
          // Accept both the bare form written above and the fully qualified
          // form, so a hand-edited or older file still loads.
          const full = pk.includes(".") ? pk : paramId(key, pk);
          if (owned.has(full)) p[full] = pv;
        }
      }

      list.push({
        s: {
          dist: clamp01(s.dist),
          selfStam: clamp01(typeof s.selfStam === "number" ? s.selfStam : 0),
          oppStam: clamp01(typeof s.oppStam === "number" ? s.oppStam : 0),
          dmgEdge: clamp(typeof s.dmgEdge === "number" ? s.dmgEdge : 0, -1, 1),
          oppActions: Array.isArray(s.oppActions)
            ? s.oppActions.filter(t => typeof t === "string").slice(-OPP_ACTION_MEMORY)
            : [],
        },
        p,
        n: typeof e.n === "number" && e.n > 0 ? e.n : 1,
      });
      if (list.length >= MAX_STATES_PER_FUND) break;
    }
    if (list.length > 0) out[key] = list;
  }
  return out;
}
