/**
 * RL tactical policy assertions.
 *
 * Run: npx tsx script/rlPolicyCheck.ts
 *
 * Guards the pieces of the RL tactical brain that can run outside the browser:
 * the observation vector, the string mask, the network's forward pass and
 * heads, masked sampling and log-probabilities, JSON save/load, and the live
 * hook in the string runner -- including that a brain with no policy picks
 * exactly the strings, in exactly the RNG order, it did before the hook.
 */

import {
  AI_STRINGS,
  AI_STRINGS_BY_ID,
  AI_STRING_CATEGORY_META,
  BEAT_STEP,
  BEAT_MIN,
  BEAT_MAX,
  STRING_POCKET_PX,
  STRING_RANGE_PUNCH_BIAS,
  STRING_AGGRESSION_OFFENSE_BONUS,
  STRING_AGGRESSION_DEFENSE_PENALTY,
  STRING_AGGRESSION_VOLUME_BONUS,
  type AiStringDef,
  type AiStringRole,
} from "../client/src/game/aiStrings";
import {
  createAiStringRuntime,
  selectAiString,
  startAiString,
  cancelAiString,
  attachRlPolicy,
  ensureAiRlState,
  buildRlStringMask,
  takeAiRlUtility,
  settleAiRlUtility,
  peekAiRlUtility,
  updateAiStringRunner,
  RL_MAX_STRING_SEGMENTS,
  type StringSelectContext,
} from "../client/src/game/aiStringRunner";
import { aiRNG } from "../client/src/game/aiRng";
import {
  RL_TEMPO_MIN,
  RL_TEMPO_MAX,
  RL_TEMPO_STEP,
  RL_TEMPO_BIN_COUNT,
  RL_UTILITY_COUNT,
  RL_UTILITIES,
  rlTempoBins,
  createRlPolicy,
  rlAct,
  rlEvaluate,
  maskedLogSoftmax,
  sampleFromLogProbs,
  seededUniform,
  rlPolicyToJson,
  rlPolicyFromJson,
  validateRlPolicyJson,
  bytesToBase64,
  base64ToBytes,
  type RlPolicy,
} from "../client/src/game/rlPolicy";
import { RL_OBS_SIZE, RL_OBS_FEATURES, buildRlObservation } from "../client/src/game/rlObservation";
import type { AiBrainState, FighterState, GameState } from "../client/src/game/types";
import {
  computeGae,
  createAdam,
  adamStep,
  adamToJson,
  adamFromJson,
  runPpoUpdate,
  DEFAULT_PPO_CONFIG,
  type RlTransition,
} from "../client/src/game/rlPpo";
import {
  DEFAULT_RL_REWARD_WEIGHTS,
  RL_REWARD_TERMS,
  emptyRlRewardTerms,
  newRlRewardTracker,
  accumulateRlReward,
  closeRlRewardInterval,
  rlOutcomeReward,
  rlRewardSnapshot,
  isRecoveringFromPunch,
  type RlRewardSnapshot,
  type RlRewardTerm,
} from "../client/src/game/rlReward";
import { createRlRun, foldRlBout, finishRlUpdate, serializeRlRun, deserializeRlRun } from "../client/src/game/rlRun";

let passed = 0;
const failures: string[] = [];

function check(label: string, cond: boolean, detail = ""): void {
  if (cond) {
    passed++;
  } else {
    failures.push(`${label}${detail ? ` -- ${detail}` : ""}`);
  }
}

// aiRNG.next01 is cached for 0.2s of wall time. Drive it off a fake clock that
// jumps a full second per read, so every call is a fresh draw and a reseeded
// run replays exactly.
let fakeMs = 0;
Object.defineProperty(performance, "now", { value: () => (fakeMs += 1000), configurable: true, writable: true });

const rand = seededUniform(20260925);
const between = (a: number, b: number) => a + (b - a) * rand();

// ===== FIXTURES =====

function fakeFighter(over: Record<string, unknown> = {}): FighterState {
  return {
    x: between(100, 700),
    z: between(100, 500),
    stamina: between(-20, 140),
    maxStamina: between(50, 120),
    boutStartMaxStamina: between(0, 130),
    fatigue: rand() < 0.8 ? { sampled: rand() < 0.8, energy: between(-5, 110), maxEnergy: between(0, 100) } : undefined,
    isPunching: rand() < 0.3,
    telegraphPhase: rand() < 0.2 ? "windup" : "none",
    isFeinting: rand() < 0.1,
    telegraphIsFeint: rand() < 0.1,
    defenseState: (["none", "fullGuard", "duck"] as const)[Math.floor(rand() * 3)],
    boxingStance: rand() < 0.5 ? "orthodox" : "southpaw",
    chargeArmed: rand() < 0.2,
    isKnockedDown: rand() < 0.05,
    stunPunchDisableTimer: rand() < 0.1 ? between(0, 2) : 0,
    stunBlockDisableTimer: rand() < 0.1 ? between(0, 2) : 0,
    ...over,
  } as unknown as FighterState;
}

function fakeState(): GameState | null {
  if (rand() < 0.1) return null;
  const left = between(0, 100);
  const top = between(0, 100);
  const roundDuration = rand() < 0.1 ? 0 : 180;
  return {
    ringLeft: left,
    ringRight: left + between(-50, 800),
    ringTop: top,
    ringBottom: top + between(-50, 500),
    currentRound: 1 + Math.floor(rand() * 12),
    totalRounds: Math.floor(rand() * 13),
    roundTimer: between(-10, 200),
    roundDuration,
  } as unknown as GameState;
}

function fakeBrain(over: Partial<AiBrainState> = {}): AiBrainState {
  return {
    strings: createAiStringRuntime(),
    difficultyBand: "Hard",
    gameTime: 0,
    attackRangeMax: between(-10, 160),
    scorecardBias: between(-3, 3),
    ...over,
  } as unknown as AiBrainState;
}

function fakeCtx(over: Partial<StringSelectContext> = {}): StringSelectContext {
  return {
    distPx: between(10, 300),
    attackRangePx: between(60, 140),
    hitRangePx: between(60, 140),
    myStaminaFrac: rand(),
    oppStaminaFrac: rand(),
    oppHurt: rand() < 0.2,
    scoreLead: between(-2, 2),
    punchDeficit: rand() < 0.5 ? 0 : rand(),
    survival: rand() < 0.2,
    difficultyScore: rand(),
    attackIntent: rand() < 0.5 ? 1 : 0,
    blockSyncReady: false,
    blockSyncArmNow: false,
    blockSyncMaxWait: 0.5,
    blockSyncInString: false,
    ...over,
  };
}

const ROLE_SETS: AiStringRole[][] = [["offense", "mixed"], ["offense"], ["defense"], ["offense", "mixed", "defense"]];
const libraryIds = AI_STRINGS.map((d) => d.id);

// ===== TEMPO BINS =====

const bins = rlTempoBins();
check("tempo step matches the string engine's beat step", RL_TEMPO_STEP === BEAT_STEP, `${RL_TEMPO_STEP} vs ${BEAT_STEP}`);
check("tempo range sits inside the engine's beat clamp", RL_TEMPO_MIN >= BEAT_MIN - 1e-9 && RL_TEMPO_MAX <= BEAT_MAX + 1e-9, `${BEAT_MIN}..${BEAT_MAX}`);
check("tempo bin count", bins.length === RL_TEMPO_BIN_COUNT, String(bins.length));
check("first tempo bin is the minimum", Math.abs(bins[0] - RL_TEMPO_MIN) < 1e-9, String(bins[0]));
check("last tempo bin is the maximum", Math.abs(bins[bins.length - 1] - RL_TEMPO_MAX) < 1e-9, String(bins[bins.length - 1]));
check("tempo bins strictly increase", bins.every((b, i) => i === 0 || b > bins[i - 1]), bins.join(","));
check(
  "tempo bins sit on the beat step",
  bins.every((b) => Math.abs(b / RL_TEMPO_STEP - Math.round(b / RL_TEMPO_STEP)) < 1e-6),
  bins.join(","),
);

// ===== OBSERVATION =====

check("observation is 20-24 values", RL_OBS_SIZE >= 20 && RL_OBS_SIZE <= 24, String(RL_OBS_SIZE));
check("feature names are unique", new Set(RL_OBS_FEATURES).size === RL_OBS_FEATURES.length);
const scoreIdx = RL_OBS_FEATURES.indexOf("scoreLead");
let obsBad = "";
for (let n = 0; n < 3000 && !obsBad; n++) {
  const obs = buildRlObservation(fakeState(), fakeFighter(), fakeFighter(), fakeBrain());
  if (obs.length !== RL_OBS_SIZE) obsBad = `length ${obs.length}`;
  for (let i = 0; i < obs.length && !obsBad; i++) {
    const lo = i === scoreIdx ? -1 : 0;
    if (!Number.isFinite(obs[i]) || obs[i] < lo || obs[i] > 1) obsBad = `${RL_OBS_FEATURES[i]} = ${obs[i]}`;
  }
}
check("observation values are finite and in range", !obsBad, obsBad);
{
  const me = fakeFighter({ x: 300, z: 300, defenseState: "none" });
  const opp = fakeFighter({ x: 380, z: 300, defenseState: "duck", isPunching: false, telegraphPhase: "none", isFeinting: false, telegraphIsFeint: false });
  const obs = buildRlObservation(null, me, opp, fakeBrain({ attackRangeMax: 100, scorecardBias: 0.5 } as Partial<AiBrainState>));
  const at = (k: (typeof RL_OBS_FEATURES)[number]) => obs[RL_OBS_FEATURES.indexOf(k)];
  check("observation reads the requested duck", at("oppDucking") === 1 && at("oppGuarding") === 0);
  check("observation idle opponent is not attacking", at("oppAttacking") === 0);
  check("observation distance vs reach", Math.abs(at("distVsReach") - 0.4) < 1e-6, String(at("distVsReach")));
  check("observation score lead passes through", Math.abs(at("scoreLead") - 0.5) < 1e-6, String(at("scoreLead")));
}

// ===== NETWORK SHAPE =====

const policy = createRlPolicy({ obsSize: RL_OBS_SIZE, stringIds: libraryIds, seed: 7 });
check("string head covers the whole library", policy.shape.nStrings === AI_STRINGS.length, String(policy.shape.nStrings));
check("library is 250 strings", AI_STRINGS.length === 250, String(AI_STRINGS.length));
check("utility head width", policy.shape.nUtility === RL_UTILITY_COUNT && RL_UTILITY_COUNT === 5);
check("param vector matches layout", policy.params.length === policy.layout.total);
{
  const obs = buildRlObservation(fakeState(), fakeFighter(), fakeFighter(), fakeBrain());
  const f = policy.forward(obs);
  check("hidden 1 width", f.h1.length === 64, String(f.h1.length));
  check("hidden 2 width", f.h2.length === 64, String(f.h2.length));
  check("string logits width", f.stringLogits.length === AI_STRINGS.length);
  check("tempo logits width", f.tempoLogits.length === RL_TEMPO_BIN_COUNT);
  check("utility logits width", f.utilityLogits.length === RL_UTILITY_COUNT);
  check("value is finite", Number.isFinite(f.value));
  check(
    "forward outputs are finite",
    [...f.stringLogits, ...f.tempoLogits, ...f.utilityLogits].every(Number.isFinite),
  );
  const again = policy.forward(obs);
  check("forward is deterministic", again.stringLogits.every((v, i) => v === f.stringLogits[i]) && again.value === f.value);
}

// ===== MASKING =====

function referenceEligible(def: AiStringDef, ctx: StringSelectContext, roles: readonly AiStringRole[]): boolean {
  const meta = AI_STRING_CATEGORY_META[def.category];
  return roles.includes(meta.role) && ctx.myStaminaFrac >= meta.minStamina && ctx.difficultyScore >= meta.minDifficulty;
}

let maskMismatch = "";
let pickedIneligible = "";
let maskedSamples = 0;
for (let n = 0; n < 600; n++) {
  const ctx = fakeCtx();
  const roles = ROLE_SETS[n % ROLE_SETS.length];
  const mask = buildRlStringMask(policy, ctx, roles);
  for (let i = 0; i < mask.length && !maskMismatch; i++) {
    const def = AI_STRINGS_BY_ID.get(policy.stringIds[i])!;
    if ((mask[i] === 1) !== referenceEligible(def, ctx, roles)) maskMismatch = `id ${def.id} roles ${roles.join("/")}`;
  }
  const obs = buildRlObservation(fakeState(), fakeFighter(), fakeFighter(), fakeBrain());
  for (let k = 0; k < 5; k++) {
    const d = rlAct(policy, obs, mask, { uniform: rand });
    if (!d) continue;
    maskedSamples++;
    if (mask[d.stringIndex] !== 1) pickedIneligible = `index ${d.stringIndex} id ${d.stringId}`;
  }
}
check("mask matches the chooser's role/stamina/difficulty gates", !maskMismatch, maskMismatch);
check("sampling never picks a masked string", !pickedIneligible, pickedIneligible);
check("sampling produced decisions", maskedSamples > 1000, String(maskedSamples));
{
  const obs = new Float32Array(RL_OBS_SIZE);
  check("all-masked returns no decision", rlAct(policy, obs, new Uint8Array(policy.shape.nStrings), { uniform: rand }) === null);
  // Single eligible entry: always chosen, deterministic or not.
  const one = new Uint8Array(policy.shape.nStrings);
  one[17] = 1;
  const a = rlAct(policy, obs, one, { uniform: rand });
  const b = rlAct(policy, obs, one, { deterministic: true });
  check("single eligible string is always chosen", a?.stringIndex === 17 && b?.stringIndex === 17);
  check("single eligible string has log-prob 0", Math.abs(a?.logProbString ?? 1) < 1e-9);
  // Unknown id in the head is never eligible.
  const odd = createRlPolicy({ obsSize: RL_OBS_SIZE, stringIds: [...libraryIds.slice(0, 9), 999999], seed: 3 });
  const oddMask = buildRlStringMask(odd, fakeCtx({ myStaminaFrac: 1, difficultyScore: 1 }), ["offense", "mixed", "defense"]);
  check("an id missing from the library is masked", oddMask[9] === 0);
}

// ===== LOG-PROBS & SAMPLING =====

let lpBad = "";
for (let n = 0; n < 300 && !lpBad; n++) {
  const obs = buildRlObservation(fakeState(), fakeFighter(), fakeFighter(), fakeBrain());
  const mask = buildRlStringMask(policy, fakeCtx(), ROLE_SETS[n % ROLE_SETS.length]);
  const d = rlAct(policy, obs, mask, { uniform: rand });
  if (!d) continue;
  const ev = rlEvaluate(policy, obs, mask, d);
  if (Math.abs(ev.logProb - d.logProb) > 1e-9) lpBad = `evaluate ${ev.logProb} vs act ${d.logProb}`;
  if (Math.abs(d.logProbString + d.logProbTempo + d.logProbUtility - d.logProb) > 1e-9) lpBad = "heads do not sum";
  if (Math.abs(ev.value - d.value) > 1e-9) lpBad = "value mismatch";
  // Independent softmax over the string head.
  const f = policy.forward(obs);
  let max = -Infinity;
  for (let i = 0; i < mask.length; i++) if (mask[i]) max = Math.max(max, f.stringLogits[i]);
  let z = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i]) z += Math.exp(f.stringLogits[i] - max);
  const ref = f.stringLogits[d.stringIndex] - max - Math.log(z);
  if (Math.abs(ref - d.logProbString) > 1e-6) lpBad = `string log-prob ${d.logProbString} vs ${ref}`;
  if (d.tempo !== policy.tempoBins[d.tempoIndex] || d.stringId !== policy.stringIds[d.stringIndex]) lpBad = "index/value mismatch";
  if (!(d.logProb <= 0)) lpBad = `positive log-prob ${d.logProb}`;
}
check("log-probs match the sampled actions", !lpBad, lpBad);
{
  const obs = new Float32Array(RL_OBS_SIZE);
  const mask = new Uint8Array(policy.shape.nStrings).fill(1);
  const masked = rlEvaluate(policy, obs, new Uint8Array(policy.shape.nStrings).fill(0).map((_, i) => (i === 0 ? 1 : 0)), {
    stringIndex: 1, tempoIndex: 0, utility: 0,
  });
  check("a masked action evaluates to -Infinity", masked.logProb === -Infinity);
  // Deterministic mode takes the argmax.
  const d = rlAct(policy, obs, mask, { deterministic: true })!;
  const f = policy.forward(obs);
  const argmax = (a: Float32Array) => a.reduce((bi, v, i) => (v > a[bi] ? i : bi), 0);
  check(
    "deterministic mode takes each head's argmax",
    d.stringIndex === argmax(f.stringLogits) && d.tempoIndex === argmax(f.tempoLogits) && d.utility === argmax(f.utilityLogits),
  );
  // Empirical frequencies follow the probabilities.
  const lp = maskedLogSoftmax([0, 1, 2, -1, 0.5])!;
  const counts = [0, 0, 0, 0, 0];
  const N = 40000;
  for (let i = 0; i < N; i++) counts[sampleFromLogProbs(lp, rand())]++;
  const worst = counts.reduce((w, c, i) => Math.max(w, Math.abs(c / N - Math.exp(lp[i]))), 0);
  check("sampling frequencies follow the probabilities", worst < 0.01, `worst deviation ${worst.toFixed(4)}`);
  check("u at the top edge still returns an allowed entry", sampleFromLogProbs(lp, 1) === 4);
}

// ===== SAVE / LOAD =====

{
  const json = rlPolicyToJson(policy);
  const text = JSON.stringify(json);
  const loaded = rlPolicyFromJson(JSON.parse(text));
  check("save/load keeps the shape", JSON.stringify(loaded.shape) === JSON.stringify(policy.shape));
  check("save/load keeps string ids and tempo bins",
    loaded.stringIds.join() === policy.stringIds.join() && loaded.tempoBins.join() === policy.tempoBins.join());
  check("save/load params are bit-identical", loaded.params.every((v, i) => Object.is(v, policy.params[i])));
  let outBad = "";
  for (let n = 0; n < 50 && !outBad; n++) {
    const obs = buildRlObservation(fakeState(), fakeFighter(), fakeFighter(), fakeBrain());
    const a = policy.forward(obs);
    const b = loaded.forward(obs);
    if (!a.stringLogits.every((v, i) => v === b.stringLogits[i]) || a.value !== b.value ||
        !a.tempoLogits.every((v, i) => v === b.tempoLogits[i]) || !a.utilityLogits.every((v, i) => v === b.utilityLogits[i])) {
      outBad = `obs ${n}`;
    }
    const mask = buildRlStringMask(policy, fakeCtx(), ["offense", "mixed"]);
    const ua = seededUniform(n + 1);
    const ub = seededUniform(n + 1);
    const da = rlAct(policy, obs, mask, { uniform: ua });
    const db = rlAct(loaded, obs, mask, { uniform: ub });
    if (JSON.stringify(da) !== JSON.stringify(db)) outBad = `decision ${n}`;
  }
  check("save/load gives identical outputs and decisions", !outBad, outBad);
  check("saved file carries a version", typeof json.version === "number" && json.version >= 1);
  check("a valid file validates", validateRlPolicyJson(json) === null);
  check("wrong kind is rejected", validateRlPolicyJson({ ...json, kind: "nope" }) !== null);
  check("future version is rejected", validateRlPolicyJson({ ...json, version: json.version + 1 }) !== null);
  check("shape mismatch is rejected", validateRlPolicyJson({ ...json, shape: { ...json.shape, nStrings: 3 } }) !== null);
  check("wrong utility count is rejected", validateRlPolicyJson({ ...json, shape: { ...json.shape, nUtility: 4 } }) !== null);
  let threw = false;
  try { rlPolicyFromJson({ ...json, params: json.params.slice(0, -8) }); } catch { threw = true; }
  check("truncated params are rejected", threw);
  const clone = policy.clone();
  clone.params[0] += 1;
  check("clone does not share params", clone.params[0] !== policy.params[0]);
  let b64Bad = "";
  for (let len = 0; len < 40; len++) {
    const bytes = new Uint8Array(len).map(() => Math.floor(rand() * 256));
    const back = base64ToBytes(bytesToBase64(bytes));
    if (back.length !== len || !back.every((v, i) => v === bytes[i])) b64Bad = `len ${len}`;
  }
  check("base64 round-trips", !b64Bad, b64Bad);
}

// ===== NO-POLICY BRAINS ARE UNCHANGED =====
//
// The pre-hook weighted chooser, copied verbatim, drawing from the same RNG.
// A brain with no policy -- rl absent, null, attached-but-empty, or a policy
// with no observation in the context -- must pick the identical sequence.

function rangeFitRef(pref: "in" | "mid" | "out" | "any", distPx: number, attackRangePx: number): number {
  if (pref === "any") return 1;
  const ratio = attackRangePx > 0 ? distPx / attackRangePx : 1;
  if (pref === "in") return ratio <= 0.85 ? 1.35 : ratio <= 1.15 ? 0.9 : 0.35;
  if (pref === "mid") return ratio > 0.7 && ratio < 1.5 ? 1.25 : 0.6;
  return ratio >= 1.2 ? 1.3 : 0.55;
}

function legacySelect(ctx: StringSelectContext, roles: readonly AiStringRole[]): AiStringDef | null {
  const eligible: AiStringDef[] = [];
  const weights: number[] = [];
  let total = 0;
  for (const def of AI_STRINGS) {
    const meta = AI_STRING_CATEGORY_META[def.category];
    if (!roles.includes(meta.role)) continue;
    if (ctx.myStaminaFrac < meta.minStamina) continue;
    if (ctx.difficultyScore < meta.minDifficulty) continue;
    let w = meta.baseWeight;
    if (ctx.oppHurt) w *= meta.hurtBonus;
    if (ctx.scoreLead > 0) w *= meta.aheadBonus;
    else if (ctx.scoreLead < 0) w *= meta.behindBonus;
    w *= rangeFitRef(meta.range, ctx.distPx, ctx.attackRangePx);
    const hookFrac = def.punchCount > 0 ? def.hookUpperCount / def.punchCount : 0.5;
    const pocketness =
      ctx.distPx <= STRING_POCKET_PX ? 1
      : ctx.distPx >= STRING_POCKET_PX * 2 ? -1
      : 1 - 2 * ((ctx.distPx - STRING_POCKET_PX) / STRING_POCKET_PX);
    w *= Math.max(0.25, Math.min(2.0, 1 + (hookFrac - 0.5) * 2 * pocketness * STRING_RANGE_PUNCH_BIAS));
    if (!ctx.survival) {
      if (meta.role === "offense") w *= STRING_AGGRESSION_OFFENSE_BONUS;
      else if (meta.role === "defense") w *= STRING_AGGRESSION_DEFENSE_PENALTY;
      w *= 1 + def.punchCount * STRING_AGGRESSION_VOLUME_BONUS * ctx.myStaminaFrac;
    }
    w /= 1 + def.punchCount * 0.05 * (1 - ctx.myStaminaFrac);
    if (w <= 0) continue;
    eligible.push(def);
    weights.push(w);
    total += w;
  }
  if (eligible.length === 0 || total <= 0) return null;
  let roll = aiRNG.next01() * total;
  for (let i = 0; i < eligible.length; i++) {
    roll -= weights[i];
    if (roll <= 0) return eligible[i];
  }
  return eligible[eligible.length - 1];
}

const SEQ_SEED = 4242;
const seqCtxs = Array.from({ length: 400 }, () => fakeCtx());
const seqObs = buildRlObservation(null, fakeFighter(), fakeFighter(), fakeBrain());

function runSequence(pick: (ctx: StringSelectContext, roles: readonly AiStringRole[]) => AiStringDef | null): string {
  aiRNG.reseed(SEQ_SEED);
  const ids: number[] = [];
  seqCtxs.forEach((ctx, i) => ids.push(pick(ctx, ROLE_SETS[i % ROLE_SETS.length])?.id ?? -1));
  ids.push(Math.floor(aiRNG.next01() * 1e9)); // the next draw proves the stream advanced identically
  return ids.join(",");
}

const legacySeq = runSequence(legacySelect);
const noRlBrain = fakeBrain();
delete (noRlBrain as Partial<AiBrainState>).rl;
const nullRlBrain = fakeBrain({ rl: null });
const emptyRlBrain = fakeBrain();
attachRlPolicy(emptyRlBrain, policy);
emptyRlBrain.rl!.policy = null;
const noObsBrain = fakeBrain();
attachRlPolicy(noObsBrain, policy);
check("no-rl brain matches the legacy chooser", runSequence((c, r) => selectAiString(noRlBrain, c, r)) === legacySeq);
check("rl:null brain matches the legacy chooser", runSequence((c, r) => selectAiString(nullRlBrain, c, r)) === legacySeq);
check("policy-less rl state matches the legacy chooser", runSequence((c, r) => selectAiString(emptyRlBrain, c, r)) === legacySeq);
check(
  "a context without an observation matches the legacy chooser",
  runSequence((c, r) => selectAiString(noObsBrain, { ...c, rlObs: null }, r)) === legacySeq,
);
check("no-policy brains record nothing", (noObsBrain.rl?.decisions ?? 0) === 0 && (noObsBrain.rl?.log.length ?? 0) === 0);
check("the legacy sequence is not degenerate", new Set(legacySeq.split(",")).size > 20);
{
  ensureAiRlState(noRlBrain);
  check("backfill sets a missing rl to null", noRlBrain.rl === null);
  const half = fakeBrain();
  (half as unknown as { rl: unknown }).rl = { policy };
  const rl = ensureAiRlState(half)!;
  check("backfill completes a half-built rl state",
    Array.isArray(rl.log) && rl.recording === false && rl.pending === null && rl.decisions === 0 && rl.utilityRecord === null);
  // A no-policy run keeps the library's segments and never goes RL.
  const b = fakeBrain({ rl: null });
  const def = AI_STRINGS_BY_ID.get(libraryIds[0])!;
  startAiString(b, def);
  check("no-policy run is not RL-controlled", b.strings.rlControlled === false && b.strings.rlTempo === -1);
  check("no-policy run keeps the library segments", b.strings.segments.length === def.segments.length);
  cancelAiString(b, null, true);
  check("no-policy cancel still teaches the per-id weight", Math.abs((b.strings.weight[def.id] ?? 0) - 0.85) < 1e-9);
}

// ===== LIVE HOOK =====

/** A policy whose utility head is pinned to one choice. */
function pinnedUtility(u: number): RlPolicy {
  const p = createRlPolicy({ obsSize: RL_OBS_SIZE, stringIds: libraryIds, seed: 11 + u });
  p.params[p.layout.bu + u] = 60;
  return p;
}

function hookRun(u: number, ctxOver: Partial<StringSelectContext> = {}) {
  const brain = fakeBrain({ gameTime: 12.5 } as Partial<AiBrainState>);
  attachRlPolicy(brain, pinnedUtility(u), { recording: true });
  const ctx = fakeCtx({ myStaminaFrac: 1, difficultyScore: 1, rlObs: seqObs, canArmCharge: true, ...ctxOver });
  const def = selectAiString(brain, ctx, ["offense", "mixed"])!;
  startAiString(brain, def);
  return { brain, def, ctx };
}

{
  aiRNG.reseed(99);
  const { brain, def, ctx } = hookRun(0);
  const rt = brain.strings;
  const rl = brain.rl!;
  const mask = buildRlStringMask(rl.policy!, ctx, ["offense", "mixed"]);
  const idx = rl.policy!.stringIds.indexOf(def.id);
  check("policy pick is an eligible string", idx >= 0 && mask[idx] === 1);
  check("policy run is RL-controlled", rt.rlControlled === true);
  check("policy run carries a tempo bin", rl.policy!.tempoBins.includes(rt.rlTempo), String(rt.rlTempo));
  check("standard utility leaves the segments alone", rt.segments.length === def.segments.length);
  check("one decision recorded", rl.log.length === 1 && rl.decisions === 1);
  const rec = rl.log[0];
  check("record carries obs, mask and time",
    rec.obs.length === RL_OBS_SIZE && rec.mask.length === rl.policy!.shape.nStrings && rec.t === 12.5);
  check("record obs is a copy", rec.obs !== seqObs && rec.obs.every((v, i) => v === seqObs[i]));
  const ev = rlEvaluate(rl.policy!, rec.obs, rec.mask, rec);
  check("recorded log-prob re-evaluates", Math.abs(ev.logProb - rec.logProb) < 1e-9 && Math.abs(ev.value - rec.value) < 1e-9);
  check("recorded utility is settled", rec.utilityApplied === true && rl.last?.applied === true);
  check("pending is consumed", rl.pending === null);
  cancelAiString(brain, null, true);
  check("policy cancel leaves the per-id weights alone", brain.strings.weight[def.id] === undefined);
  check("cancel clears RL control", brain.strings.rlControlled === false && brain.strings.rlTempo === -1);
}
{
  const { brain, def } = hookRun(RL_UTILITIES.indexOf("charge"));
  const segs = brain.strings.segments;
  const startsCharged = def.segments[0]?.kind === "charge";
  check("charge utility leads with a charge", segs[0]?.kind === "charge");
  check("charge utility adds at most one segment", segs.length === def.segments.length + (startsCharged ? 0 : 1));
  check("charge utility counted as applied", brain.rl!.log[0].utilityApplied === true);
}
{
  const { brain, def } = hookRun(RL_UTILITIES.indexOf("charge"), { canArmCharge: false });
  check("refused charge runs the string as written", brain.strings.segments.length === def.segments.length);
  check("refused charge counted as refused", brain.rl!.log[0].utilityApplied === false && brain.rl!.last?.applied === false);
  check("refused charge still takes the policy tempo", brain.strings.rlControlled === true);
}
{
  const { brain, def } = hookRun(RL_UTILITIES.indexOf("switchStance"));
  check("stance-switch utility leads with a switch", brain.strings.segments[0]?.kind === "switchStance");
  check("stance-switch adds one segment", brain.strings.segments.length === def.segments.length + 1);
}
for (const name of ["reset", "slipCounter"] as const) {
  const u = RL_UTILITIES.indexOf(name);
  const { brain, def } = hookRun(u);
  check(`${name} is left for updateAI`, brain.strings.rlUtilityPending === u && brain.strings.segments.length === def.segments.length);
  check(`${name} is unsettled until performed`, brain.rl!.log[0].utilityApplied === null);
  check(`${name} is taken once`, takeAiRlUtility(brain) === u && takeAiRlUtility(brain) === 0);
  settleAiRlUtility(brain, name === "reset");
  check(`${name} outcome is recorded`, brain.rl!.log[0].utilityApplied === (name === "reset"));
}
{
  // A cancelled run with a Reset still owed settles it as refused.
  const { brain } = hookRun(RL_UTILITIES.indexOf("reset"));
  cancelAiString(brain, null, false);
  check("cancel settles an owed utility as refused", brain.rl!.log[0].utilityApplied === false);
}
{
  // Recording off: decisions still made, nothing logged.
  const brain = fakeBrain();
  attachRlPolicy(brain, policy);
  for (let i = 0; i < 20; i++) {
    const def = selectAiString(brain, fakeCtx({ rlObs: seqObs }), ["offense", "mixed"]);
    if (def) startAiString(brain, def);
  }
  check("recording off keeps the log empty", brain.rl!.log.length === 0 && brain.rl!.decisions === 20);
  // Seeded replay: the policy path draws off aiRNG in a fixed order.
  const replay = () => {
    aiRNG.reseed(77);
    const b = fakeBrain();
    attachRlPolicy(b, policy);
    return seqCtxs.slice(0, 60).map((c, i) => selectAiString(b, { ...c, rlObs: seqObs }, ROLE_SETS[i % 4])?.id ?? -1).join();
  };
  check("policy selection replays under a reseeded RNG", replay() === replay());
  // Every role filter is honoured through the hook.
  let roleBad = "";
  for (const roles of ROLE_SETS) {
    for (let i = 0; i < 100; i++) {
      const ctx = fakeCtx({ rlObs: seqObs });
      const def = selectAiString(brain, ctx, roles);
      if (def && !referenceEligible(def, ctx, roles)) roleBad = `${def.id} for ${roles.join("/")}`;
    }
  }
  check("hook honours every caller's role filter", !roleBad, roleBad);
}


// ===== UTILITIES AT RUNNER BOUNDARIES =====
//
// Extensions and reactive inserts are picked inside updateAiStringRunner. A
// Reset / slip-counter chosen there must hold the boundary so updateAI can
// perform it before the new string's first segment -- a punch must never go
// out ahead of the slip it was meant to counter from.

const punchFirst = AI_STRINGS.find((d) => {
  const m = AI_STRING_CATEGORY_META[d.category];
  return m.role === "offense" && d.segments[0]?.kind === "punch" && d.segments.length >= 2;
})!;
const defenseDef = AI_STRINGS.find((d) => AI_STRING_CATEGORY_META[d.category].role === "defense" && d.segments.length >= 3)!;
check("fixture: a punch-first offence string exists", !!punchFirst);
check("fixture: a defensive string exists", !!defenseDef);

/** Policy pinned to one string and one utility. */
function pinned(stringId: number, u: number): RlPolicy {
  const p = createRlPolicy({ obsSize: RL_OBS_SIZE, stringIds: libraryIds, seed: 900 + u });
  p.params[p.layout.bs + libraryIds.indexOf(stringId)] = 80;
  p.params[p.layout.bu + u] = 80;
  return p;
}

const runnerEnemy = () => fakeFighter({ isPunching: false, isKnockedDown: false, stamina: 100, maxStamina: 100,
  stunPunchDisableTimer: 0, chargeArmed: false, defenseState: "none" });
const runnerCtx = (over: Partial<StringSelectContext> = {}) => fakeCtx({
  distPx: 50, attackRangePx: 100, hitRangePx: 100, myStaminaFrac: 1, difficultyScore: 1, survival: false,
  attackIntent: 1, oppHurt: true, punchDeficit: 1, blockSyncInString: false, blockSyncReady: false,
  rlObs: seqObs, canArmCharge: true, ...over,
});

type BoundaryResult = { reached: boolean; firstTickPunch: unknown; pendingAfter: number; nextPunch: unknown; expected: unknown; applied: boolean | null };

function boundaryRun(kind: "extend" | "insert", u: number): BoundaryResult {
  for (let attempt = 0; attempt < 200; attempt++) {
    aiRNG.reseed(5000 + attempt);
    const brain = fakeBrain({ difficultyBand: "Hardcore" } as Partial<AiBrainState>);
    attachRlPolicy(brain, pinned(punchFirst.id, u), { recording: true });
    const base = kind === "extend" ? AI_STRINGS_BY_ID.get(libraryIds[0])! : defenseDef;
    startAiString(brain, base); // no pending decision: a legacy run
    const rt = brain.strings;
    rt.index = kind === "extend" ? rt.segments.length : 1;
    rt.beatTimer = 0;
    rt.holdKind = "none";
    const enemy = runnerEnemy();
    const player = runnerEnemy();
    const t1 = updateAiStringRunner(brain, enemy, player, 1 / 60, runnerCtx());
    if (rt.stringId !== punchFirst.id && !(kind === "extend" && rt.segments.length > base.segments.length)) continue;
    if (brain.rl!.log.length === 0) continue;
    const pendingAfter = peekAiRlUtility(brain);
    const firstTickPunch = t1.punch;
    // What updateAI does next tick: perform the utility, then run the string.
    takeAiRlUtility(brain);
    settleAiRlUtility(brain, true);
    const t2 = updateAiStringRunner(brain, enemy, player, 1 / 60, runnerCtx());
    return { reached: true, firstTickPunch, pendingAfter, nextPunch: t2.punch, expected: punchFirst.segments[0].punch ?? "jab",
      applied: brain.rl!.log[brain.rl!.log.length - 1].utilityApplied };
  }
  return { reached: false, firstTickPunch: null, pendingAfter: 0, nextPunch: null, expected: null, applied: null };
}

for (const kind of ["extend", "insert"] as const) {
  for (const name of ["reset", "slipCounter"] as const) {
    const u = RL_UTILITIES.indexOf(name);
    const r = boundaryRun(kind, u);
    check(`${kind}: policy pick reached (${name})`, r.reached);
    if (!r.reached) continue;
    check(`${kind}: no punch before the ${name}`, r.firstTickPunch === null, String(r.firstTickPunch));
    check(`${kind}: ${name} left owed at the boundary`, r.pendingAfter === u, String(r.pendingAfter));
    check(`${kind}: first punch follows the ${name}`, r.nextPunch === r.expected, `${String(r.nextPunch)} vs ${String(r.expected)}`);
    check(`${kind}: ${name} outcome recorded`, r.applied === true);
  }
  // Standard utility: nothing owed, the boundary does not hold.
  const std = boundaryRun(kind, RL_UTILITIES.indexOf("standard"));
  check(`${kind}: standard utility does not hold the boundary`, std.reached && std.firstTickPunch === std.expected,
    String(std.firstTickPunch));
}

// ===== SEGMENT CAP =====

check("segment cap matches the library's longest string", RL_MAX_STRING_SEGMENTS === Math.max(...AI_STRINGS.map((d) => d.segments.length)));
{
  const longest = AI_STRINGS.filter((d) => d.segments.length >= RL_MAX_STRING_SEGMENTS && d.segments[0]?.kind !== "charge")
    .find((d) => {
      const m = AI_STRING_CATEGORY_META[d.category];
      return m.role === "offense" || m.role === "mixed";
    });
  check("fixture: a full-length string exists", !!longest);
  if (longest) {
    for (const name of ["charge", "switchStance"] as const) {
      const brain = fakeBrain();
      attachRlPolicy(brain, pinned(longest.id, RL_UTILITIES.indexOf(name)), { recording: true });
      const def = selectAiString(brain, runnerCtx(), ["offense", "mixed"]);
      check(`cap fixture picked (${name})`, def?.id === longest.id, String(def?.id));
      if (!def) continue;
      startAiString(brain, def);
      check(`${name} never grows a string past the cap`, brain.strings.segments.length <= RL_MAX_STRING_SEGMENTS,
        String(brain.strings.segments.length));
      check(`${name} on a full-length string is refused`, brain.rl!.log[0].utilityApplied === false);
    }
  }
}

// ===== PPO TRAINER =====

const near = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) <= eps;

{
  // Hand-worked: r = [1, 0, 2], V = [.5, .4, .3], episode ends after step 2.
  //   δ2 = 2 − .3 = 1.7                         A2 = 1.7
  //   δ1 = 0 + .9·.3 − .4 = −.13                A1 = −.13 + .72·1.7 = 1.094
  //   δ0 = 1 + .9·.4 − .5 = .86                 A0 = .86 + .72·1.094 = 1.64768
  const g = computeGae([1, 0, 2], [0.5, 0.4, 0.3], [0, 0, 1], 99, 0.9, 0.8);
  const adv = [1.64768, 1.094, 1.7];
  const ret = [2.14768, 1.494, 2.0];
  for (let i = 0; i < 3; i++) {
    check(`GAE advantage[${i}]`, near(g.advantages[i], adv[i], 1e-9), `${g.advantages[i]} vs ${adv[i]}`);
    check(`GAE return[${i}]`, near(g.returns[i], ret[i], 1e-9), `${g.returns[i]} vs ${ret[i]}`);
  }
  // An episode boundary mid-buffer stops bootstrapping; the final step
  // bootstraps off lastValue when it is not terminal.
  const g2 = computeGae([1, 1], [0, 0], [1, 0], 10, 1, 1);
  check("GAE done cuts the bootstrap", near(g2.advantages[0], 1), String(g2.advantages[0]));
  check("GAE bootstraps a non-terminal tail", near(g2.advantages[1], 11), String(g2.advantages[1]));
}

{
  // Synthetic rollout: one observation, two actions. The good one is paid +1,
  // the bad one −1. After an update the good action must be more likely and
  // the bad one less.
  const small = createRlPolicy({ obsSize: 6, stringIds: [11, 22, 33, 44], hidden1: 8, hidden2: 8, seed: 7 });
  const obs = new Float32Array([0.3, -0.2, 0.9, 0.1, -0.5, 0.4]);
  const mask = new Uint8Array([1, 1, 1, 0]);
  const good = { stringIndex: 1, tempoIndex: 2, utility: 0 };
  const bad = { stringIndex: 2, tempoIndex: 0, utility: 3 };
  const before = rlEvaluate(small, obs, mask, good);
  const beforeBad = rlEvaluate(small, obs, mask, bad);
  const data: RlTransition[] = [];
  for (let i = 0; i < 32; i++) {
    const a = i % 2 === 0 ? good : bad;
    const ev = a === good ? before : beforeBad;
    data.push({ obs, mask, ...a, logProb: ev.logProb, value: ev.value, reward: a === good ? 1 : -1, done: true });
  }
  const adam = createAdam(small.params.length);
  const cfg = { ...DEFAULT_PPO_CONFIG, learningRate: 1e-2, minibatch: 8, epochs: 4 };
  const st = runPpoUpdate(small, adam, data, cfg, 3);
  const after = rlEvaluate(small, obs, mask, good);
  const afterBad = rlEvaluate(small, obs, mask, bad);
  check("PPO raises the probability of the positive-advantage action", after.logProb > before.logProb,
    `${before.logProb.toFixed(4)} -> ${after.logProb.toFixed(4)}`);
  check("PPO lowers the probability of the negative-advantage action", afterBad.logProb < beforeBad.logProb,
    `${beforeBad.logProb.toFixed(4)} -> ${afterBad.logProb.toFixed(4)}`);
  check("PPO update ran every minibatch", st.minibatches === 4 * 4 && adam.t === 16, `${st.minibatches} / t=${adam.t}`);
  check("PPO stats are finite", [st.policyLoss, st.valueLoss, st.entropy, st.approxKl].every(Number.isFinite));
  check("PPO never picks a masked-out string", rlEvaluate(small, obs, mask, { ...good, stringIndex: 3 }).logProb === -Infinity);
}

{
  // Adam survives a save/load round trip bit for bit, and carries on identically.
  const n = 50;
  const pA = new Float32Array(n).map((_, i) => Math.sin(i));
  const st = createAdam(n);
  for (let k = 0; k < 5; k++) adamStep(pA, Array.from({ length: n }, (_, i) => Math.cos(i * k + 1)), st, 1e-3);
  const restored = adamFromJson(JSON.parse(JSON.stringify(adamToJson(st))), n);
  check("Adam round trip keeps t", restored.t === st.t, `${restored.t} vs ${st.t}`);
  check("Adam round trip keeps m", restored.m.every((v, i) => v === st.m[i]));
  check("Adam round trip keeps v", restored.v.every((v, i) => v === st.v[i]));
  const pB = new Float32Array(pA);
  const grad = Array.from({ length: n }, (_, i) => 0.3 - i / n);
  adamStep(pA, grad, st, 1e-3);
  adamStep(pB, grad, restored, 1e-3);
  check("Adam resumes identically after reload", pA.every((v, i) => v === pB[i]));
  let threw = false;
  try { adamFromJson(adamToJson(st), n + 1); } catch { threw = true; }
  check("Adam refuses state sized for another network", threw);

  // The whole run checkpoint round-trips too: weights, optimiser, buffer, stats.
  const run = createRlRun(12345);
  const tr: RlTransition = {
    obs: new Float32Array(RL_OBS_SIZE).map((_, i) => (i % 7) / 7),
    mask: new Uint8Array(run.policy.shape.nStrings).fill(1),
    stringIndex: 3, tempoIndex: 1, utility: 2, logProb: -4.2, value: 0.25, reward: 1.5, done: true,
  };
  foldRlBout(run, { won: true, opponent: "champion", side: "player", outcome: "cards", reward: 1.5,
    terms: { ...emptyRlRewardTerms(), damage: 1.5 }, decisions: 1 }, [tr], 777);
  for (let k = 0; k < 3; k++) adamStep(run.policy.params, new Float32Array(run.policy.params.length).fill(0.01 * (k + 1)), run.adam, 1e-3);
  const back = deserializeRlRun(JSON.parse(JSON.stringify(serializeRlRun(run))));
  check("checkpoint keeps weights", back.policy.params.every((v, i) => v === run.policy.params[i]));
  check("checkpoint keeps Adam", back.adam.t === 3 && back.adam.m.every((v, i) => v === run.adam.m[i]) && back.adam.v.every((v, i) => v === run.adam.v[i]));
  check("checkpoint keeps the buffer", back.buffer.length === 1 && back.buffer[0].obs.every((v, i) => v === tr.obs[i])
    && back.buffer[0].reward === 1.5 && back.buffer[0].done === true);
  check("checkpoint keeps counters and seed stream", back.totalSteps === 1 && back.boutsPlayed === 1 && back.rngState === 777);
  check("checkpoint keeps pick counts", back.picks.n === 1 && back.picks.strings[run.policy.stringIds[3]] === 1);
  finishRlUpdate(run, { policyLoss: 0, valueLoss: 0, entropy: 1, approxKl: 0, clipFrac: 0, gradNorm: 0, samples: 1, minibatches: 1 });
  check("an update clears the buffer", run.buffer.length === 0 && run.updates === 1 && run.lastPicks?.n === 1);
}

// ===== REWARD OBSERVER =====

{
  const W = DEFAULT_RL_REWARD_WEIGHTS;
  const base: RlRewardSnapshot = {
    scoredDamage: 10, damageDealt: 10, oppDamageDealt: 10, cleanLanded: 3, oppRecovering: false,
    perfectBlocks: 0, dodges: 0, chargedMisses: 0, punchesThrown: 5, stamina: 80, maxStamina: 100,
    oppPoolStart: 200, live: true,
  };
  const only = (term: RlRewardTerm, prev: RlRewardSnapshot, cur: RlRewardSnapshot, dt = 1 / 60, idle = 0) => {
    const acc = emptyRlRewardTerms();
    const track = newRlRewardTracker();
    track.idle = idle;
    accumulateRlReward(acc, prev, cur, dt, W, track);
    closeRlRewardInterval(acc, W, track);
    const others = RL_REWARD_TERMS.filter((k) => k !== term && acc[k] !== 0);
    return { value: acc[term], others };
  };
  const expectTerm = (label: string, term: RlRewardTerm, want: number, prev: RlRewardSnapshot, cur: RlRewardSnapshot, dt?: number, idle?: number) => {
    const r = only(term, prev, cur, dt, idle);
    check(`reward: ${label}`, near(r.value, want, 1e-9), `${r.value} vs ${want}`);
    check(`reward: ${label} fires alone`, r.others.length === 0, r.others.join(","));
  };
  const nothing = only("damage", base, { ...base, punchesThrown: 6 });
  check("reward: a quiet step pays nothing", RL_REWARD_TERMS.every((k) => nothing.value === 0 && nothing.others.length === 0));

  // 4 scored damage on a 200 pool = 2 units.
  expectTerm("damage dealt", "damage", 2 * W.damage, base, { ...base, scoredDamage: 14, punchesThrown: 6 });
  const counter = only("counter", { ...base, oppRecovering: true }, { ...base, cleanLanded: 4, punchesThrown: 6 });
  check("reward: landing on a recovering opponent", near(counter.value, W.counter), String(counter.value));
  const plain = only("counter", base, { ...base, cleanLanded: 4, punchesThrown: 6 });
  check("reward: landing on a set opponent is no counter", plain.value === 0, String(plain.value));
  expectTerm("perfect block", "perfectBlock", W.perfectBlock, base, { ...base, perfectBlocks: 1, punchesThrown: 6 });
  expectTerm("slip / dodge", "dodge", 2 * W.dodge, base, { ...base, dodges: 2, punchesThrown: 6 });
  expectTerm("whiffed charge", "chargedWhiff", W.chargedWhiff, base, { ...base, chargedMisses: 1, punchesThrown: 6 });
  expectTerm("low stamina", "lowStamina", W.lowStamina, base, { ...base, stamina: 10, punchesThrown: 6 });
  // Charged once per decision interval, not per tick.
  {
    const acc = emptyRlRewardTerms();
    const track = newRlRewardTracker();
    const low = { ...base, stamina: 5 };
    for (let i = 0; i < 30; i++) accumulateRlReward(acc, low, { ...low, punchesThrown: low.punchesThrown + i + 1 }, 1 / 60, W, track);
    closeRlRewardInterval(acc, W, track);
    check("reward: low stamina charged once per interval", near(acc.lowStamina, W.lowStamina), String(acc.lowStamina));
    closeRlRewardInterval(acc, W, track);
    check("reward: low-stamina flag clears with the interval", near(acc.lowStamina, W.lowStamina), String(acc.lowStamina));
  }
  // Passive while behind: one full second idle, behind on the cards.
  expectTerm("passive while behind", "passiveBehind", W.passiveBehind * 0.5, base, { ...base, oppDamageDealt: 20 }, 0.5, 1.0);
  const ahead = only("passiveBehind", base, { ...base, damageDealt: 30 }, 0.5, 1.0);
  check("reward: passive while ahead is free", ahead.value === 0, String(ahead.value));
  const busy = only("passiveBehind", base, { ...base, oppDamageDealt: 20, punchesThrown: 6 }, 0.5, 1.0);
  check("reward: throwing resets the passive clock", busy.value === 0, String(busy.value));
  check("reward: win / loss / draw bonus", rlOutcomeReward(true, W) === W.win && rlOutcomeReward(false, W) === W.loss && rlOutcomeReward(null, W) === 0);
  // Round-reset counters never pay negative.
  const reset = only("damage", base, { ...base, scoredDamage: 0, punchesThrown: 6 });
  check("reward: a round reset is not negative damage", reset.value === 0, String(reset.value));

  // Snapshot reads the right side of the state.
  const mk = (over: Record<string, unknown>) => ({
    stamina: 50, maxStamina: 100, boutStartMaxStamina: 100, damageDealt: 0, cleanPunchesLanded: 0,
    punchesThrown: 0, isPunching: false, isKnockedDown: false, ...over,
  }) as unknown as FighterState;
  const gs = {
    phase: "fighting",
    player: mk({ damageDealt: 7, perfectBlocksMade: 2, chargedPunchesMissed: 1 }),
    enemy: mk({ isPunching: true, punchPhase: "retraction", boutStartMaxStamina: 150 }),
    roundStats: { playerDamageThisRound: 5, enemyDamageThisRound: 9, playerPunchesDodged: 3, enemyPunchesDodged: 4 },
  } as unknown as GameState;
  const snP = rlRewardSnapshot(gs, "player");
  const snE = rlRewardSnapshot(gs, "enemy");
  check("snapshot: player side", snP.scoredDamage === 5 && snP.dodges === 3 && snP.perfectBlocks === 2
    && snP.chargedMisses === 1 && snP.oppRecovering && snP.oppPoolStart === 150 && snP.live);
  check("snapshot: enemy side", snE.scoredDamage === 9 && snE.dodges === 4 && snE.perfectBlocks === 0 && !snE.oppRecovering);
  check("recovering: a whiff slow counts", isRecoveringFromPunch(mk({ moveSlowTimer: 0.3, moveSlowMult: 0.6 })));
  check("recovering: a windup does not", !isRecoveringFromPunch(mk({ isPunching: true, punchPhase: "windup" })));
}

// ===== REPORT =====

console.log("");
console.log(`RL policy: obs ${RL_OBS_SIZE}, hidden ${policy.shape.hidden1}x${policy.shape.hidden2}, ` +
  `${policy.shape.nStrings} strings, ${policy.shape.nTempo} tempo bins, ${policy.shape.nUtility} utilities, ` +
  `${policy.layout.total} params`);
console.log(`Tempo bins (s): ${bins.join(", ")}`);
console.log("");

if (failures.length > 0) {
  console.error(`FAILED ${failures.length} check(s):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`All ${passed} assertions passed.`);
