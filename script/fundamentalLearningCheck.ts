/**
 * Fundamentals learning-layer check.
 *
 * The learner replaced "copy the cycle winner" with an evidence-ranked
 * evolution-strategies step. Its claims are checked here on a synthetic
 * problem with a known optimum, where the answer is not in doubt:
 *  - ranks are baseline-subtracted (sum to zero, ties pull nowhere)
 *  - evidence beats raw rate (1/1 < 40/50)
 *  - mirrored sampling really is mirrored
 *  - one step never exceeds the trust region, and fewer than two seeds with a
 *    chance moves nothing
 *  - repeated sample → score → step converges on the optimum
 *  - the gate holds undecided below its bout floor and rolls back below its rate
 */

import { FUNDAMENTALS, paramId, defaultParams, type FundamentalSeed } from "../client/src/game/aiFundamentals";
import {
  centredRanks, evidenceScore, learnFundamental, antitheticPair, sampleReplacements,
  emptyLearner, normalizeLearner, judgeGate, pushLeague,
  STEP_CLIP, SIGMA_MIN, SIGMA_MAX, GATE_MIN_BOUTS, LEAGUE_SIZE,
} from "../client/src/game/fundamentalLearning";

let failures = 0;
const fail = (msg: string) => { console.error("  FAIL  " + msg); failures++; };
const ok = (msg: string) => console.log("  ok    " + msg);
const check = (cond: boolean, msg: string) => (cond ? ok(msg) : fail(msg));

let s = Number(process.env.SEED ?? 12345);
const rand = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

const seedOf = (id: number, params: Record<string, number>): FundamentalSeed => ({
  id, name: `s${id}`, gen: 0, params, stats: {}, lifetime: {}, wins: 0, losses: 0, bouts: 0, parents: null, salvaged: [],
});

// ---- ranks
{
  const u = centredRanks([0.1, 0.9, 0.5, 0.5]);
  check(Math.abs(u.reduce((a, b) => a + b, 0)) < 1e-12, "centred ranks sum to zero");
  check(u[1] === 0.5 && u[0] === -0.5, "best +0.5, worst −0.5");
  check(u[2] === u[3], "tied scores share a rank");
}

// ---- evidence
check(evidenceScore(1, 1, 0.5) < evidenceScore(40, 50, 0.5), "1/1 ranks below 40/50");
check(Math.abs(evidenceScore(0, 0, 0.3) - 0.3) < 1e-12, "no attempts returns the field rate");

const fund = FUNDAMENTALS.find(f => f.params.length >= 2)!;
const ids = fund.params.map(pr => paramId(fund.key, pr.key));
const normOf = (params: Record<string, number>) =>
  fund.params.map((pr, i) => (params[ids[i]] - pr.min) / (pr.max - pr.min));

// ---- antithetic pairs
{
  const champ = { params: defaultParams() };
  const l = emptyLearner();
  l.sigma[fund.key] = 0.05;
  const [p, m] = antitheticPair(champ, l, rand);
  const c = normOf(champ.params), np = normOf(p), nm = normOf(m);
  const mirrored = c.every((v, i) => (np[i] <= 0 || np[i] >= 1 || nm[i] <= 0 || nm[i] >= 1) || Math.abs(np[i] + nm[i] - 2 * v) < 1e-9);
  check(mirrored, "mirrored pair sits symmetrically around the champion");
  const reps = sampleReplacements([{ id: 3, name: "a" }, { id: 4, name: "b" }, { id: 5, name: "c" }], 2, champ, l, rand);
  check(reps.length === 3 && reps.map(r => r.id).join() === "3,4,5", "replacements keep their slot ids");
  const r1 = normOf(reps[1].params), r2 = normOf(reps[2].params);
  check(c.every((v, i) => r1[i] <= 0 || r1[i] >= 1 || r2[i] <= 0 || r2[i] >= 1 || Math.abs(r1[i] + r2[i] - 2 * v) < 1e-9),
    "slots after the explorer come as a mirrored pair");
}

// ---- no chance, no step
{
  const champ = { params: defaultParams() };
  const before = { ...champ.params };
  const r = learnFundamental(fund, [
    { seed: seedOf(0, defaultParams()), attempts: 10, successes: 9 },
    { seed: seedOf(1, defaultParams()), attempts: 0, successes: 0 },
  ], champ, emptyLearner());
  check(!r.stepped && ids.every(id => champ.params[id] === before[id]), "one seed with a chance moves nothing");
}

// ---- convergence on a known optimum
{
  const target = fund.params.map(() => 0.15 + 0.7 * rand());
  const dist = (x: number[]) => Math.sqrt(x.reduce((a, v, i) => a + (v - target[i]) ** 2, 0) / x.length);
  const champ = { params: defaultParams() };
  // Start far away: the opposite corner from the target.
  fund.params.forEach((pr, i) => { champ.params[ids[i]] = pr.min + (target[i] > 0.5 ? 0.02 : 0.98) * (pr.max - pr.min); });
  const learner = emptyLearner();
  const d0 = dist(normOf(champ.params));
  let maxStep = 0;
  for (let gen = 0; gen < 120; gen++) {
    const slots = Array.from({ length: 6 }, (_, i) => ({ id: i, name: `s${i}` }));
    const pop = sampleReplacements(slots, gen, champ, learner, rand);
    const inputs = pop.map(seed => {
      const p = Math.max(0, 1 - 2 * dist(normOf(seed.params)));
      let succ = 0;
      const att = 30;
      for (let k = 0; k < att; k++) if (rand() < p) succ++;
      return { seed, attempts: att, successes: succ };
    });
    const r = learnFundamental(fund, inputs, champ, learner);
    maxStep = Math.max(maxStep, r.stepSize);
    const sg = learner.sigma[fund.key];
    if (sg < SIGMA_MIN - 1e-12 || sg > SIGMA_MAX + 1e-12) fail(`sigma ${sg} left its bounds`);
  }
  const d1 = dist(normOf(champ.params));
  console.log(`        distance to optimum ${d0.toFixed(3)} -> ${d1.toFixed(3)}`);
  check(d1 < d0 * 0.3, "sample → score → step converges toward the optimum");
  check(maxStep <= STEP_CLIP + 1e-12, `no step exceeds the trust region (max ${maxStep.toFixed(3)})`);
  const restored = normalizeLearner(JSON.parse(JSON.stringify(learner)));
  check(JSON.stringify(restored) === JSON.stringify(learner), "learner survives a save round-trip");
  check(JSON.stringify(normalizeLearner({ adam: { x: { m: NaN, v: 1 } }, sigma: { y: 9 } })) ===
    JSON.stringify({ adam: {}, steps: {}, sigma: { y: SIGMA_MAX }, lastStep: {}, lastStepSize: {} }),
    "restore drops non-finite moments and clamps widths");
}

// ---- gate & league
{
  check(!judgeGate({ wins: 0, losses: GATE_MIN_BOUTS - 1, bouts: GATE_MIN_BOUTS - 1 }).decided, "gate undecided below its bout floor");
  const lose = judgeGate({ wins: 3, losses: 9, bouts: 12 });
  check(lose.decided && lose.rolledBack, "clear loss rolls back");
  const pass = judgeGate({ wins: 5, losses: 5, bouts: 12 });
  check(pass.decided && !pass.rolledBack && Math.abs(pass.rate - 0.5) < 1e-12, "draws count half; even record passes");
  let league: Record<string, number>[] = [];
  for (let i = 0; i < LEAGUE_SIZE + 2; i++) league = pushLeague(league, { a: i });
  check(league.length === LEAGUE_SIZE && league[0].a === LEAGUE_SIZE + 1, "league keeps the newest, capped");
}

console.log(failures === 0 ? "\nAll learning checks passed." : `\n${failures} learning check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
