/**
 * Fundamental-state foundation check.
 *
 * The load-bearing claim in fundamentalStates.ts is that the parameter -> knob
 * map can be recovered numerically instead of hand-written, because
 * deriveNeuralState is affine in the parameters. If that is wrong, every knob
 * nudge writes back to the wrong parameters and the whole search is noise. This
 * verifies it end to end rather than trusting the reasoning.
 */

import { FUNDAMENTALS, paramId, deriveNeuralState, type FundamentalSeed } from "../client/src/game/aiFundamentals";
import {
  SENSITIVITY, ALL_PARAM_IDS, PARAMS_BY_FUND, PARAM_BOUNDS,
  knobsForFundamental, distributeKnobDelta, knobReach,
  SituationTracker, situationSimilarity, type Situation,
  recordState, matchState, mergeStates, emptyStore,
  jitterForMargin, jitterStates,
  serializeStore, deserializeStore,
  MAX_STATES_PER_FUND, SIMILARITY_FLOOR, MAX_INHERIT_JITTER,
} from "../client/src/game/fundamentalStates";
import type { FighterState } from "../client/src/game/types";

let failures = 0;
const fail = (msg: string) => { console.error("  FAIL  " + msg); failures++; };
const ok = (msg: string) => console.log("  ok    " + msg);

const seedOf = (params: Record<string, number>): FundamentalSeed => ({
  id: -1, name: "t", gen: 0, params,
  stats: {}, lifetime: {}, wins: 0, losses: 0, bouts: 0, parents: null, salvaged: [],
});

const defaults = (): Record<string, number> => {
  const p: Record<string, number> = {};
  for (const id of ALL_PARAM_IDS) p[id] = PARAM_BOUNDS[id].def;
  return p;
};

console.log("\n=== 1. registry shape ===");
console.log("  fundamentals: " + FUNDAMENTALS.length + ", params: " + ALL_PARAM_IDS.length + ", knobs: " + SENSITIVITY.knobs.length);
if (FUNDAMENTALS.length === 0) fail("no fundamentals");
if (ALL_PARAM_IDS.length !== new Set(ALL_PARAM_IDS).size) fail("duplicate parameter ids");
else ok("parameter ids unique");

console.log("\n=== 2. affinity of deriveNeuralState ===");
// If the map is affine, the knob values at (a+b)/2 equal the mean of the knob
// values at a and at b. Anything nonlinear breaks this.
{
  const a = defaults();
  const b: Record<string, number> = {};
  for (const id of ALL_PARAM_IDS) b[id] = PARAM_BOUNDS[id].max;
  const mid: Record<string, number> = {};
  for (const id of ALL_PARAM_IDS) mid[id] = (a[id] + b[id]) / 2;

  const ka = deriveNeuralState(seedOf(a));
  const kb = deriveNeuralState(seedOf(b));
  const km = deriveNeuralState(seedOf(mid));

  let worst = 0;
  let worstKnob = "";
  for (const k of SENSITIVITY.knobs) {
    const err = Math.abs((ka[k] + kb[k]) / 2 - km[k]);
    if (err > worst) { worst = err; worstKnob = k; }
  }
  if (worst > 1e-9) fail("not affine, worst knob " + worstKnob + " err " + worst.toExponential(3));
  else ok("affine to " + worst.toExponential(2) + " (probe recovers an exact Jacobian)");
}

console.log("\n=== 3. sensitivity coverage ===");
{
  let dead = 0;
  for (const id of ALL_PARAM_IDS) {
    const row = SENSITIVITY.byParam[id];
    let any = false;
    for (let i = 0; i < row.length; i++) if (Math.abs(row[i]) > 1e-9) { any = true; break; }
    if (!any) dead++;
  }
  console.log("  parameters that move no knob: " + dead + " / " + ALL_PARAM_IDS.length);

  const kd = ["kdRecovery1", "kdRecovery2", "kdRecovery3"];
  for (const k of kd) {
    const ki = SENSITIVITY.knobs.indexOf(k);
    if (ki < 0) { fail("knob " + k + " missing from derived state"); continue; }
    let any = false;
    for (const id of ALL_PARAM_IDS) if (Math.abs(SENSITIVITY.byParam[id][ki]) > 1e-9) { any = true; break; }
    if (any) fail(k + " should be a fixed champion constant but responds to parameters");
  }
  if (failures === 0) ok("kdRecovery1/2/3 correctly inert (held at champion constants)");

  let noKnobs = 0;
  for (const f of FUNDAMENTALS) if (knobsForFundamental(f.key).length === 0) noKnobs++;
  console.log("  fundamentals that can move no knob: " + noKnobs + " / " + FUNDAMENTALS.length);
  if (noKnobs > 0) fail("some fundamentals are unsearchable - their parameters reach nothing");
  else ok("every fundamental can move at least one knob");
}

console.log("\n=== 4. knob delta writes back exactly ===");
{
  const odd = ALL_PARAM_IDS.filter(id => PARAM_BOUNDS[id].min < 0 || PARAM_BOUNDS[id].max > 1);
  if (odd.length > 0) console.log("  parameters declared outside [0,1]: " + odd.length + " e.g. " + odd.slice(0, 3).join(", "));

  let pairs = 0;
  let worstErr = 0;
  let worstWhat = "";
  let overshoot = 0;
  let wrongWay = 0;
  const reaches: { what: string; reach: number }[] = [];

  for (const f of FUNDAMENTALS) {
    for (const knob of knobsForFundamental(f.key)) {
      const params = defaults();
      const reach = knobReach(f.key, knob, params);
      const what = f.key + " -> " + knob;
      reaches.push({ what, reach: reach.up });
      pairs++;

      const before = deriveNeuralState(seedOf(params))[knob];

      // A request inside the reachable range must land exactly.
      const want = reach.up * 0.25;
      if (want > 1e-9) {
        const after = deriveNeuralState(seedOf({ ...params, ...distributeKnobDelta(f.key, knob, want, params) }))[knob];
        const err = Math.abs((after - before) - want);
        if (err > worstErr) { worstErr = err; worstWhat = what; }
      }

      // A request beyond it must saturate cleanly: no overshoot, no reversal.
      const greedy = Math.max(reach.up * 4, 0.05);
      const after2 = deriveNeuralState(seedOf({ ...params, ...distributeKnobDelta(f.key, knob, greedy, params) }))[knob];
      const moved = after2 - before;
      if (moved > reach.up + 1e-6) overshoot++;
      if (moved < -1e-9) wrongWay++;
    }
  }

  console.log("  (fundamental, knob) pairs exercised: " + pairs);
  if (worstErr > 1e-6) fail("in-reach request inexact, worst " + worstErr.toExponential(3) + " at " + worstWhat);
  else ok("in-reach requests land exactly (worst " + worstErr.toExponential(2) + ")");
  if (overshoot > 0) fail(overshoot + " pair(s) overshot their reachable range");
  else ok("out-of-reach requests saturate without overshooting");
  if (wrongWay > 0) fail(wrongWay + " pair(s) moved the knob the wrong way");
  else ok("every request moved the knob in the requested direction");

  reaches.sort((a, b) => a.reach - b.reach);
  const weak = reaches.filter(r => r.reach < 0.01).length;
  console.log("  authority: median " + reaches[Math.floor(reaches.length / 2)].reach.toFixed(4)
    + ", weakest " + reaches[0].reach.toFixed(4) + " (" + reaches[0].what + ")"
    + ", strongest " + reaches[reaches.length - 1].reach.toFixed(4));
  console.log("  pairs with under 0.01 knob authority: " + weak + " / " + pairs
    + "  <- search must step as a fraction of reach, not in knob units");
}

console.log("\n=== 5. rolling situation windows ===");
{
  const mk = (x: number, stam: number, dmg: number) =>
    ({ x, stamina: stam, maxStamina: 100, damageDealt: dmg } as unknown as FighterState);

  const t = new SituationTracker();
  // Hold a steady 300px apart at full stamina for four seconds.
  for (let i = 0; i < 40; i++) t.update(0.1, mk(0, 100, 0), mk(300, 100, 0));
  const s = t.read(mk(0, 100, 0), mk(300, 100, 0));
  if (Math.abs(s.dist - 0.5) > 1e-3) fail("steady 300px should read 0.5, got " + s.dist);
  else ok("distance window averages correctly");
  if (Math.abs(s.selfStam - 1) > 1e-3 || Math.abs(s.oppStam - 1) > 1e-3) fail("stamina window wrong");
  else ok("stamina windows average correctly");

  const t2 = new SituationTracker();
  for (let i = 0; i < 40; i++) t2.update(0.1, mk(0, 100, 60), mk(300, 40, 10));
  const s2 = t2.read(mk(0, 100, 60), mk(300, 40, 10));
  if (!(s2.dmgEdge > 0.4 && s2.dmgEdge < 0.6)) fail("damage edge should favour the corner dealing more, got " + s2.dmgEdge);
  else ok("damage edge signed correctly (" + s2.dmgEdge.toFixed(3) + ")");

  t2.pushOpponentAction("a"); t2.pushOpponentAction("b"); t2.pushOpponentAction("c");
  t2.pushOpponentAction("d"); t2.pushOpponentAction("e"); t2.pushOpponentAction("f");
  const s3 = t2.read(mk(0, 100, 60), mk(300, 40, 10));
  if (s3.oppActions.length !== 5 || s3.oppActions[4] !== "f" || s3.oppActions[0] !== "b") {
    fail("action memory should keep the newest five, got " + JSON.stringify(s3.oppActions));
  } else ok("opponent action memory keeps the newest five");
}

console.log("\n=== 6. similarity ===");
{
  const base: Situation = { dist: 0.5, selfStam: 0.8, oppStam: 0.6, dmgEdge: 0.2, oppActions: ["a", "b", "c", "d", "e"] };
  if (Math.abs(situationSimilarity(base, base) - 1) > 1e-9) fail("self-similarity should be 1");
  else ok("identical situations score 1");

  const far: Situation = { dist: 0.0, selfStam: 0.1, oppStam: 0.1, dmgEdge: -0.9, oppActions: ["z", "y", "x", "w", "v"] };
  const sim = situationSimilarity(base, far);
  if (sim >= SIMILARITY_FLOOR) fail("wholly different situations scored " + sim + ", above the floor");
  else ok("dissimilar situations fall below the activation floor (" + sim.toFixed(3) + ")");

  // The newest action should matter more than the oldest.
  const newestDiff = situationSimilarity(base, { ...base, oppActions: ["a", "b", "c", "d", "Z"] });
  const oldestDiff = situationSimilarity(base, { ...base, oppActions: ["Z", "b", "c", "d", "e"] });
  if (!(newestDiff < oldestDiff)) fail("newest action is not weighted above the oldest");
  else ok("recent actions weigh more than old ones");
}

console.log("\n=== 7. store: record, merge, evict, match ===");
{
  const fund = FUNDAMENTALS[0].key;
  const pids = PARAMS_BY_FUND[fund];
  const store = emptyStore();
  const params = Object.fromEntries(pids.map(id => [id, PARAM_BOUNDS[id].def]));

  const sit = (d: number): Situation =>
    ({ dist: d, selfStam: 0.8, oppStam: 0.8, dmgEdge: 0, oppActions: ["a", "b", "c", "d", "e"] });

  // Near-identical situations must consolidate rather than consume slots.
  for (let i = 0; i < 10; i++) recordState(store, fund, sit(0.5), params);
  if (store[fund].length !== 1) fail("near-identical situations should merge, got " + store[fund].length + " entries");
  else ok("near-identical situations consolidate into one entry (n=" + store[fund][0].n + ")");

  // Distinct situations must occupy their own slots, capped.
  for (let i = 0; i < 120; i++) recordState(store, fund, sit(i / 120), params);
  if (store[fund].length > MAX_STATES_PER_FUND) fail("cap exceeded: " + store[fund].length);
  else ok("slot cap held at " + store[fund].length + " / " + MAX_STATES_PER_FUND);

  const hit = matchState(store, fund, sit(0.5));
  if (!hit) fail("a situation that was recorded should match");
  else ok("recorded situation matches");

  const miss = matchState(store, fund, { dist: 0.5, selfStam: 0.0, oppStam: 1.0, dmgEdge: -1, oppActions: ["q", "q", "q", "q", "q"] });
  if (miss) console.log("  note  distant situation still matched (floor may be loose)");
  else ok("distant situation correctly declines to activate");

  const merged = mergeStates(store[fund], store[fund]);
  if (merged.length > MAX_STATES_PER_FUND) fail("merge exceeded cap: " + merged.length);
  else ok("merge of two memories respects the cap (" + merged.length + ")");
}

console.log("\n=== 8. inheritance jitter scales with margin ===");
{
  const dead = jitterForMargin(0);
  const decisive = jitterForMargin(1);
  const mid = jitterForMargin(0.125);
  if (Math.abs(dead - MAX_INHERIT_JITTER) > 1e-9) fail("a dead-even win should inherit at full jitter, got " + dead);
  else ok("dead-even win jitters at " + (dead * 100).toFixed(1) + "%");
  if (decisive > 1e-9) fail("a decisive win should inherit untouched, got " + decisive);
  else ok("decisive win inherits untouched");
  if (!(mid > 0 && mid < dead)) fail("intermediate margin should fall between");
  else ok("narrow win jitters at " + (mid * 100).toFixed(1) + "%, between the two");

  const fund = FUNDAMENTALS[0].key;
  const pids = PARAMS_BY_FUND[fund];
  const states = [{
    s: { dist: 0.5, selfStam: 0.5, oppStam: 0.5, dmgEdge: 0, oppActions: ["a"] },
    p: Object.fromEntries(pids.map(id => [id, PARAM_BOUNDS[id].def])), n: 3,
  }];
  let rs = 1;
  const rand = () => (rs = (rs * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const jittered = jitterStates(states, MAX_INHERIT_JITTER, rand);
  let moved = 0;
  for (const id of pids) {
    const b = PARAM_BOUNDS[id];
    const d = Math.abs(jittered[0].p[id] - states[0].p[id]);
    if (d > 1e-9) moved++;
    if (jittered[0].p[id] < b.min - 1e-9 || jittered[0].p[id] > b.max + 1e-9) fail("jitter escaped bounds on " + id);
    if (d > MAX_INHERIT_JITTER * (b.max - b.min) + 1e-9) fail("jitter exceeded the cap on " + id);
  }
  if (moved === 0) fail("jitter moved nothing");
  else ok("jitter moved " + moved + "/" + pids.length + " parameters, all within bounds and cap");
}

console.log("\n=== 9. serialize round trip ===");
{
  const fund = FUNDAMENTALS[0].key;
  const pids = PARAMS_BY_FUND[fund];
  const store = emptyStore();
  for (let i = 0; i < 20; i++) {
    recordState(store, fund, { dist: i / 20, selfStam: 0.7, oppStam: 0.6, dmgEdge: 0.1, oppActions: ["a", "b"] },
      Object.fromEntries(pids.map(id => [id, PARAM_BOUNDS[id].def])));
  }
  const json = JSON.stringify(serializeStore(store));
  const back = deserializeStore(JSON.parse(json));
  if ((back[fund]?.length ?? 0) !== store[fund].length) fail("round trip lost entries");
  else ok("round trip preserved " + back[fund].length + " entries");

  if (Object.keys(deserializeStore({ nonsense_key: [1, 2, 3] })).length !== 0) fail("unknown keys should be dropped");
  else ok("unknown keys dropped on load");
  if (Object.keys(deserializeStore(null)).length !== 0) fail("null should deserialize to an empty store");
  else ok("malformed input yields an empty store");

  // Project the full storage cost at capacity.
  const perState = json.length / store[fund].length;
  const projected = perState * MAX_STATES_PER_FUND * FUNDAMENTALS.length;
  console.log("  projected size at full capacity: ~" + Math.round(projected / 1024) + " KB");
}

console.log("");
if (failures > 0) { console.error(failures + " check(s) failed\n"); process.exit(1); }
console.log("all fundamental-state checks passed\n");
