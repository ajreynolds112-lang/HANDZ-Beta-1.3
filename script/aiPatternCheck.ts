/**
 * AI pattern memory assertions.
 *
 * Run: npx tsx script/aiPatternCheck.ts
 *
 * Guards client/src/game/aiPatterns.ts, which is the pure half of the AI's
 * pattern-reading: what it remembers, when it decides it has seen a combination
 * before, how confidently it commits to an answer, and what a career opponent
 * has studied off tape before the bell. Executing a counter lives in ai.ts and
 * needs a running fight, so it is deliberately out of scope here.
 *
 * The failure modes worth catching are quiet ones: a tier that recognizes
 * combinations in the wrong order, a memory that grows without bound into the
 * save file, a counter chance that can reach certainty, and a study draw that
 * stops being the same for the same opponent.
 */

import {
  AI_PATTERN_RANGES,
  AI_PATTERN_STUDY_LADDER,
  DEFAULT_AI_PATTERN_CONFIG,
  PATTERN_HUD_MAX,
  PATTERN_LENGTH,
  PATTERN_TOKEN_CHARGE,
  PATTERN_TOKEN_DUCK,
  describeActionToken,
  describePattern,
  selectRecentArmedPatterns,
  advancePatternScript,
  advanceScriptedCounter,
  armPattern,
  choosePatternAnswer,
  isLowPatternAction,
  patternAnswerWeights,
  type PatternAnswer,
  type PatternAnswerAvailability,
  buildPatternContext,
  clampAiPatternField,
  clearPatternScript,
  clearPatternWindow,
  createAiPatternMemory,
  exportPatternLibrary,
  feintActionToken,
  findArmedPattern,
  isPatternScriptRunning,
  makePatternStudyRng,
  mergePatternLibrary,
  normalizePatternLibrary,
  parseActionToken,
  patternArmedCapacity,
  patternCounterChance,
  patternHoldStatus,
  type PatternHoldInputs,
  patternRecognitionThreshold,
  patternStudyCount,
  punchActionToken,
  punchHand,
  recordPatternAction,
  sanitizeAiPatternConfig,
  seedPatternMemory,
  startPatternScript,
  studiedSeedCount,
  type AiPatternConfig,
  type AiPatternLibraryEntry,
  type AiPatternMemory,
} from "../client/src/game/aiPatterns";
import type { AIDifficulty, PunchType } from "../client/src/game/types";

let failures = 0;
let checks = 0;

function ok(cond: boolean, label: string, detail?: string) {
  checks++;
  if (!cond) {
    failures++;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function eq(a: unknown, b: unknown, label: string) {
  ok(a === b, label, `got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`);
}

function near(a: number, b: number, label: string, tol = 1e-9) {
  ok(Math.abs(a - b) <= tol, label, `got ${a}, expected ${b}`);
}

function section(name: string) {
  console.log(`\n${name}`);
}

const CFG = DEFAULT_AI_PATTERN_CONFIG;
const TIERS: AIDifficulty[] = ["journeyman", "contender", "elite", "champion"];
const ALL_PUNCHES: PunchType[] = ["jab", "cross", "leftHook", "rightHook", "leftUppercut", "rightUppercut"];

/** Feeds a memory a whole pattern, one action at a time, from one context. */
function throwPattern(
  mem: AiPatternMemory,
  acts: string[],
  ctx: string,
  threshold: number,
  capacity: number,
  cfg: AiPatternConfig = CFG,
): boolean {
  let armed = false;
  for (const a of acts) {
    if (recordPatternAction(mem, a, ctx, threshold, capacity, cfg)) armed = true;
  }
  return armed;
}

const JAB = punchActionToken("jab" as PunchType, true, "orthodox");
const CROSS = punchActionToken("cross" as PunchType, true, "orthodox");
const HOOK = punchActionToken("leftHook" as PunchType, true, "orthodox");
const BODY_HOOK = punchActionToken("leftHook" as PunchType, false, "orthodox");

// ============================================================================
section("config");

for (const key of Object.keys(AI_PATTERN_RANGES) as (keyof typeof AI_PATTERN_RANGES)[]) {
  const [lo, hi] = AI_PATTERN_RANGES[key];
  const v = CFG[key];
  ok(lo < hi, `range ${key} is ordered`, `[${lo}, ${hi}]`);
  ok(v >= lo && v <= hi, `default ${key} sits inside its range`, `${v} not in [${lo}, ${hi}]`);
  eq(clampAiPatternField(key, v), v, `default ${key} survives clamping unchanged`);
  eq(clampAiPatternField(key, lo - 1000), lo, `clamp ${key} to the floor`);
  eq(clampAiPatternField(key, hi + 1000), hi, `clamp ${key} to the ceiling`);
  eq(clampAiPatternField(key, NaN), CFG[key], `clamp ${key} falls back on NaN`);
}

{
  const junk = sanitizeAiPatternConfig({ baseChancePct: 9999, holdSec: -5, recogChampion: 0 } as Partial<AiPatternConfig>);
  eq(junk.baseChancePct, AI_PATTERN_RANGES.baseChancePct[1], "sanitize clamps a wild percentage");
  eq(junk.holdSec, AI_PATTERN_RANGES.holdSec[0], "sanitize clamps a negative hold");
  eq(junk.recogChampion, AI_PATTERN_RANGES.recogChampion[0], "sanitize clamps a zero threshold");
  eq(junk.enabled, true, "sanitize defaults enabled on");
  eq(sanitizeAiPatternConfig({ enabled: false }).enabled, false, "sanitize keeps an explicit off");
  const empty = sanitizeAiPatternConfig({});
  for (const key of Object.keys(AI_PATTERN_RANGES) as (keyof typeof AI_PATTERN_RANGES)[]) {
    eq(empty[key], CFG[key], `sanitize fills missing ${key} from the default`);
  }
}

// A better fighter must never need MORE repeats, or hold FEWER patterns, than a
// worse one. This is the ordering the whole difficulty curve rests on.
{
  let prevRecog = Infinity;
  let prevCap = -Infinity;
  for (const t of ["champion", "elite", "contender", "journeyman"] as AIDifficulty[]) {
    const r = patternRecognitionThreshold(CFG, t);
    const c = patternArmedCapacity(CFG, t);
    ok(r >= 1, `${t} needs at least one sighting`);
    ok(r >= (prevRecog === Infinity ? 0 : prevRecog), `${t} needs no fewer repeats than the tier above`, `${r} vs ${prevRecog}`);
    ok(c <= (prevCap === -Infinity ? Infinity : prevCap), `${t} holds no more patterns than the tier above`, `${c} vs ${prevCap}`);
    prevRecog = r;
    prevCap = c;
  }
  // Unknown tiers fall back rather than returning undefined.
  ok(Number.isFinite(patternRecognitionThreshold(CFG, "nonsense" as AIDifficulty)), "unknown tier still gets a threshold");
  ok(Number.isFinite(patternArmedCapacity(CFG, "nonsense" as AIDifficulty)), "unknown tier still gets a capacity");
}

// ============================================================================
section("action tokens");

{
  eq(parseActionToken(JAB).kind, "punch", "a punch token reads as a punch");
  eq(parseActionToken(JAB).punch, "jab", "a punch token carries its punch");
  eq(parseActionToken(JAB).head, true, "a head punch reads as head");
  eq(parseActionToken(BODY_HOOK).head, false, "a body punch reads as body");
  ok(HOOK !== BODY_HOOK, "the same punch to head and body are different actions");
  eq(parseActionToken(feintActionToken("cross" as PunchType, "orthodox")).kind, "feint", "a feint token reads as a feint");
  eq(parseActionToken(feintActionToken("cross" as PunchType, "orthodox")).punch, "cross", "a feint token carries its punch");
  ok(feintActionToken("cross" as PunchType, "orthodox") !== CROSS, "a feint is not the punch it sells");
  eq(parseActionToken(PATTERN_TOKEN_CHARGE).kind, "charge", "the charge token reads as a charge");
  eq(parseActionToken(PATTERN_TOKEN_DUCK).kind, "duck", "the duck token reads as a duck");
  ok(!JAB.includes("#") && !JAB.includes(">"), "tokens avoid the pattern key separators");

  // ---- the glove -----------------------------------------------------------
  // Punch names are absolute in this engine: a jab is the left hand in both
  // stances, and what stance changes is which hand is the lead. So the glove is
  // carried by the punch name rather than stored a second time, and the two
  // must never disagree.
  eq(punchHand("jab"), "left", "a jab is the left hand");
  eq(punchHand("leftHook"), "left", "so is a left hook");
  eq(punchHand("leftUppercut"), "left", "and a left uppercut");
  eq(punchHand("cross"), "right", "a cross is the right hand");
  eq(punchHand("rightHook"), "right", "so is a right hook");
  eq(punchHand("rightUppercut"), "right", "and a right uppercut");
  eq(punchHand(null), null, "an action with no punch behind it has no glove");
  for (const p of ALL_PUNCHES) {
    eq(parseActionToken(punchActionToken(p, true, "orthodox")).hand, punchHand(p), `${p} parses back to the hand it comes off`);
    eq(parseActionToken(feintActionToken(p, "southpaw")).hand, punchHand(p), `a feinted ${p} sells the same hand`);
  }
  // The glove does not move when the stance does.
  for (const p of ALL_PUNCHES) {
    eq(
      parseActionToken(punchActionToken(p, true, "southpaw")).hand,
      parseActionToken(punchActionToken(p, true, "orthodox")).hand,
      `${p} comes off the same glove in either stance`,
    );
  }

  // ---- the stance ----------------------------------------------------------
  // The stance is stored, because it is the thing that decides whether that
  // fixed glove is the lead hand or the rear one -- a different punch on a
  // different line, and the wrong prepared answer if the two were pooled.
  eq(parseActionToken(punchActionToken("jab", true, "orthodox")).stance, "orthodox", "a token carries the stance it was thrown from");
  eq(parseActionToken(punchActionToken("jab", true, "southpaw")).stance, "southpaw", "either stance");
  eq(parseActionToken(feintActionToken("jab", "southpaw")).stance, "southpaw", "and a feint carries it too");
  ok(
    punchActionToken("jab", true, "orthodox") !== punchActionToken("jab", true, "southpaw"),
    "the same punch from the two stances is two different actions",
  );
  ok(
    feintActionToken("jab", "orthodox") !== feintActionToken("jab", "southpaw"),
    "and so are the two feints",
  );
  eq(parseActionToken(PATTERN_TOKEN_CHARGE).stance, null, "a charge is not thrown from a stance");
  eq(parseActionToken(PATTERN_TOKEN_DUCK).stance, null, "and neither is a drop");

  // Every one of the four axes is separating: 6 punches x 2 heights x 2 stances,
  // all distinct, all round-tripping.
  const seen = new Set<string>();
  for (const p of ALL_PUNCHES) {
    for (const head of [true, false]) {
      for (const st of ["orthodox", "southpaw"] as const) {
        const t = punchActionToken(p, head, st);
        seen.add(t);
        const parsed = parseActionToken(t);
        eq(parsed.punch, p, `${t} round-trips its punch`);
        eq(parsed.head, head, `${t} round-trips its target`);
        eq(parsed.stance, st, `${t} round-trips its stance`);
        ok(!t.includes("#") && !t.includes(">"), `${t} avoids the pattern key separators`);
      }
    }
  }
  eq(seen.size, ALL_PUNCHES.length * 4, "punch, target and stance are each their own axis");
}

// ============================================================================
section("old tokens brought forward");

{
  // A career written before the stance and target joined the token has to be
  // re-keyed on the way in, or the entries can never match a live action again:
  // they would be studied, take up armed slots and answer nothing.
  const oldHeadJab = "p:jab:h";
  const oldBodyJab = "p:jab:b";
  const oldFeint = "f:cross";

  eq(parseActionToken(oldHeadJab).stance, "orthodox", "an old punch is read as orthodox");
  eq(parseActionToken(oldFeint).stance, "orthodox", "and so is an old feint");
  eq(parseActionToken(oldHeadJab).punch, "jab", "an old punch still carries its punch");
  eq(parseActionToken(oldFeint).kind, "feint", "and an old feint is still a feint");
  eq(parseActionToken(oldHeadJab).hand, "left", "the glove comes off the punch name, so old tokens have one too");

  // The target is the one field that is not read literally. It came off a flag
  // the human corner never set, so every punch on every existing tape says
  // "body" whether it was thrown standing or not -- taken at face value the
  // whole library would be body combinations the player has never thrown.
  eq(parseActionToken(oldBodyJab).head, true, "an old body-shot punch is re-read as the head shot it almost certainly was");
  eq(parseActionToken(oldHeadJab).head, true, "and an old head shot stays a head shot");

  const ctx = buildPatternContext(null);
  const cur = punchActionToken("jab", true, "orthodox");
  const migrated = normalizePatternLibrary([
    { key: "stale-a", ctx, acts: [oldHeadJab, oldBodyJab, oldFeint], n: 4 },
  ]);
  eq(migrated.length, 1, "an old entry survives the trip");
  eq(migrated[0].acts[0], cur, "its punches come out in the current format");
  eq(migrated[0].acts[2], feintActionToken("cross", "orthodox"), "its feints too");
  eq(migrated[0].n, 4, "and it keeps the count it was earned with");
  ok(migrated[0].key !== "stale-a", "and it is re-keyed off the upgraded actions, not the key it was saved under");
  eq(
    migrated[0].key,
    libKey(ctx, [cur, cur, feintActionToken("cross", "orthodox")]),
    "onto the key the current spelling of that combination would produce",
  );

  // The two old spellings of the same punch collapse onto the one entry rather
  // than sitting alongside it as a duplicate, and the heavier count wins --
  // the same rule the merge already uses.
  const folded = normalizePatternLibrary([
    { key: "old-h", ctx, acts: [oldHeadJab, oldHeadJab, oldHeadJab], n: 3 },
    { key: "old-b", ctx, acts: [oldBodyJab, oldBodyJab, oldBodyJab], n: 7 },
    { key: "new", ctx, acts: [cur, cur, cur], n: 2 },
  ]);
  eq(folded.length, 1, "old and current spellings of one combination fold together");
  eq(folded[0].n, 7, "and the heaviest count is the one kept");

  // Upgrading is idempotent: a library that has already been through comes out
  // byte-identical, so studying and merging a save repeatedly cannot drift it.
  const once = normalizePatternLibrary([{ key: "x", ctx, acts: [oldHeadJab, oldBodyJab, oldFeint], n: 5 }]);
  const twice = normalizePatternLibrary(once);
  eq(JSON.stringify(twice), JSON.stringify(once), "running the upgrade twice changes nothing");

  // A genuine body shot recorded from here on is still its own entry -- the
  // re-read applies to the old format only, not to the current one.
  ok(
    punchActionToken("jab", false, "orthodox") !== punchActionToken("jab", true, "orthodox"),
    "a body shot recorded today is still separate from the head shot",
  );
  eq(parseActionToken(punchActionToken("jab", false, "orthodox")).head, false, "and still reads as body work");
}

// ============================================================================
section("context");

{
  // Separation is a gate, not an identity. The context is the AI's last landed
  // punch and nothing else, so the same three punches are the same pattern
  // wherever inside the watch range they were thrown.
  ok(
    buildPatternContext(null) !== buildPatternContext("cross" as PunchType),
    "the AI's last landed punch is the context",
  );
  eq(
    buildPatternContext("jab" as PunchType),
    buildPatternContext("jab" as PunchType),
    "and it is the whole of it",
  );
  ok(!buildPatternContext(null).includes("|"), "no separation is carried in the context any more");
  ok(CFG.observeRangePx === 95, "the watch range is the 95px gate", `${CFG.observeRangePx}`);
}

// ============================================================================
section("recognition");

{
  const mem = createAiPatternMemory();
  const ctx = buildPatternContext(null);
  const threshold = 3;
  const combo = [JAB, CROSS, HOOK];

  eq(throwPattern(mem, combo, ctx, threshold, 10), false, "first sighting arms nothing");
  eq(mem.armed.length, 0, "nothing armed after one sighting");
  eq(throwPattern(mem, combo, ctx, threshold, 10), false, "second sighting arms nothing");
  eq(mem.armed.length, 0, "nothing armed after two sightings");
  eq(throwPattern(mem, combo, ctx, threshold, 10), true, "the third sighting arms it");
  eq(mem.armed.length, 1, "exactly one pattern armed");
  eq(mem.statRecognized, 1, "recognition is counted once");

  const found = findArmedPattern(mem, ctx, JAB);
  ok(found !== null, "the armed pattern is findable by its opening action");
  eq(found?.acts.join(">"), combo.join(">"), "the armed pattern is the one thrown");
  eq(findArmedPattern(mem, ctx, CROSS), null, "it is not found by a middle action");
  ok(
    findArmedPattern(mem, buildPatternContext("cross" as PunchType), JAB) === null,
    "it is not found off a different last landed punch",
  );

  // Sightings past the threshold keep counting; that is what raises the chance.
  // The armed set can legitimately grow here: throwing the same three punches
  // on a loop is also throwing their rotations on a loop, and those are real
  // patterns too. What must not happen is the same pattern arming twice.
  throwPattern(mem, combo, ctx, threshold, 10);
  eq(mem.armed.filter(p => p.key === found?.key).length, 1, "a repeat does not arm a duplicate");
  ok((found?.n ?? 0) > threshold, "sightings keep accruing after arming", `n=${found?.n}`);
}

{
  // The window slides by one, so a longer string contains overlapping patterns.
  const mem = createAiPatternMemory();
  const ctx = buildPatternContext(null);
  for (let i = 0; i < 4; i++) {
    for (const a of [JAB, CROSS, HOOK, JAB, CROSS, HOOK]) recordPatternAction(mem, a, ctx, 2, 20, CFG);
  }
  ok(mem.armed.length >= 2, "overlapping patterns are all learnable", `armed=${mem.armed.length}`);
  eq(mem.window.length, PATTERN_LENGTH, "the window never grows past a pattern");
  eq(mem.windowCtx.length, PATTERN_LENGTH, "the context window tracks the action window");
}

{
  // Candidates must not grow without bound while the player throws junk.
  const cfg: AiPatternConfig = { ...CFG, maxCandidates: 8 };
  const mem = createAiPatternMemory();
  const lastLanded: (PunchType | null)[] = [null, "jab" as PunchType, "cross" as PunchType, "leftHook" as PunchType];
  for (let i = 0; i < 400; i++) {
    const ctx = buildPatternContext(lastLanded[i % lastLanded.length]);
    recordPatternAction(mem, `p:jab:${i % 11}`, ctx, 5, 10, cfg);
  }
  ok(
    Object.keys(mem.candidates).length <= cfg.maxCandidates,
    "candidates stay inside the cap",
    `${Object.keys(mem.candidates).length} > ${cfg.maxCandidates}`,
  );
  eq(
    Object.keys(mem.candidateSeq).length,
    Object.keys(mem.candidates).length,
    "the eviction order table does not leak entries",
  );
}

{
  // Armed capacity, and eviction taking the least-seen rather than the newest.
  const mem = createAiPatternMemory();
  const cap = 3;
  for (let i = 0; i < 10; i++) {
    armPattern(mem, { key: `k${i}`, ctx: "c", acts: [JAB, CROSS, HOOK], n: i + 1 }, cap);
  }
  eq(mem.armed.length, cap, "the armed set stays inside its capacity");
  const kept = mem.armed.map(p => p.n).sort((a, b) => a - b);
  ok(kept[0] > 1, "the least-seen patterns were the ones dropped", `kept n=${kept.join(",")}`);
  armPattern(mem, { key: mem.armed[0].key, ctx: "c", acts: [JAB, CROSS, HOOK], n: 99 }, cap);
  eq(mem.armed.length, cap, "re-arming a known pattern does not duplicate it");
}

{
  // The pattern a script is currently answering must survive an eviction.
  const mem = createAiPatternMemory();
  const cap = 2;
  armPattern(mem, { key: "scripted", ctx: "c", acts: [JAB, CROSS, HOOK], n: 1 }, cap);
  armPattern(mem, { key: "other", ctx: "c", acts: [CROSS, HOOK, JAB], n: 9 }, cap);
  const scripted = mem.armed.find(p => p.key === "scripted")!;
  startPatternScript(mem, scripted, 0, CFG.holdSec);
  armPattern(mem, { key: "newcomer", ctx: "c", acts: [HOOK, JAB, CROSS], n: 5 }, cap);
  ok(
    mem.armed.some(p => p.key === "scripted"),
    "the pattern being countered is not evicted mid-script",
  );
  eq(mem.armed.length, cap, "capacity still holds while protecting the scripted pattern");
  clearPatternScript(mem);
}

{
  // Protecting the scripted pattern must not turn into evicting whichever
  // pattern happens to sit at the front of the list.
  const mem = createAiPatternMemory();
  const cap = 3;
  armPattern(mem, { key: "strong", ctx: "c", acts: [JAB, CROSS, HOOK], n: 40 }, cap);
  armPattern(mem, { key: "scripted", ctx: "c", acts: [CROSS, HOOK, JAB], n: 1 }, cap);
  armPattern(mem, { key: "weak", ctx: "c", acts: [HOOK, JAB, CROSS], n: 2 }, cap);
  startPatternScript(mem, mem.armed.find(p => p.key === "scripted")!, 0, CFG.holdSec);
  armPattern(mem, { key: "newcomer", ctx: "c", acts: [JAB, JAB, CROSS], n: 9 }, cap);
  ok(mem.armed.some(p => p.key === "strong"), "the best-known pattern is not collateral damage");
  ok(!mem.armed.some(p => p.key === "weak"), "the actual next-weakest pattern is the one dropped");
  clearPatternScript(mem);
}

// ============================================================================
section("counter chance");

{
  const base = { key: "k", ctx: "c", acts: [JAB, CROSS, HOOK], lastUsed: 0, seq: 0, studied: false, tapeOffset: 0 };
  const threshold = 3;

  near(patternCounterChance({ ...base, n: 3 }, threshold, 0, 0, CFG), CFG.baseChancePct / 100, "at the threshold it is the base chance");
  near(
    patternCounterChance({ ...base, n: 5 }, threshold, 0, 0, CFG),
    Math.min(CFG.maxChancePct, CFG.baseChancePct + CFG.perRepeatPct * 2) / 100,
    "two repeats past the threshold add twice the per-repeat bonus",
  );
  near(
    patternCounterChance({ ...base, n: 3 }, threshold, 20, 0, CFG),
    (CFG.baseChancePct - CFG.perHitTakenPct * 20) / 100,
    "punches taken clean shave the chance",
  );
  near(
    patternCounterChance({ ...base, n: 3 }, threshold, 0, 2, CFG),
    (CFG.baseChancePct * CFG.knockdownMult * CFG.knockdownMult) / 100,
    "each knockdown suffered multiplies what is left",
  );

  const capped = patternCounterChance({ ...base, n: 500 }, threshold, 0, 0, CFG);
  near(capped, CFG.maxChancePct / 100, "the chance is capped");
  ok(capped < 1, "a counter is never a certainty");
  eq(patternCounterChance({ ...base, n: 3 }, threshold, 100000, 0, CFG), 0, "the chance floors at zero, never negative");
  // A pattern seen fewer times than the threshold cannot borrow a bonus.
  near(patternCounterChance({ ...base, n: 1 }, threshold, 0, 0, CFG), CFG.baseChancePct / 100, "below-threshold sightings add nothing");
  // Guard the ordering: knockdowns multiply AFTER the hits-taken subtraction.
  const both = patternCounterChance({ ...base, n: 3 }, threshold, 20, 1, CFG);
  near(both, ((CFG.baseChancePct - CFG.perHitTakenPct * 20) * CFG.knockdownMult) / 100, "knockdowns scale the eroded total, not the base");

  // Stun penalty. It is the one term taken after the ceiling, so it has to bite
  // even on a read that is already pinned at the cap.
  const stunMult = 1 - CFG.stunPenaltyPct / 100;
  near(
    patternCounterChance({ ...base, n: 3 }, threshold, 0, 0, CFG, true),
    (CFG.baseChancePct * stunMult) / 100,
    "being stunned takes its cut off the counter chance",
  );
  near(
    patternCounterChance({ ...base, n: 3 }, threshold, 0, 0, CFG, false),
    CFG.baseChancePct / 100,
    "an unstunned AI pays nothing",
  );
  near(
    patternCounterChance({ ...base, n: 500 }, threshold, 0, 0, CFG, true),
    (CFG.maxChancePct * stunMult) / 100,
    "the stun cut lands after the ceiling, so a capped read still pays it",
  );
  ok(
    patternCounterChance({ ...base, n: 500 }, threshold, 0, 0, CFG, true) < capped,
    "a stunned AI counters a pinned pattern less often than a fresh one",
  );
  eq(
    patternCounterChance({ ...base, n: 3 }, threshold, 100000, 0, CFG, true),
    0,
    "the stun cut cannot push an already-floored chance below zero",
  );
  near(
    patternCounterChance({ ...base, n: 3 }, threshold, 0, 0, { ...CFG, stunPenaltyPct: 0 }, true),
    CFG.baseChancePct / 100,
    "a zero penalty switches the stun cut off",
  );
  eq(
    patternCounterChance({ ...base, n: 3 }, threshold, 0, 0, { ...CFG, stunPenaltyPct: 100 }, true),
    0,
    "a full penalty stops the counter outright while stunned",
  );
}

// ============================================================================
section("counter script");

{
  const mem = createAiPatternMemory();
  const combo = [JAB, CROSS, HOOK];
  armPattern(mem, { key: "k", ctx: "c", acts: combo, n: 5 }, 5);
  const p = mem.armed[0];

  eq(advancePatternScript(mem, JAB), "idle", "nothing to advance with no script running");

  startPatternScript(mem, p, 10, CFG.holdSec);
  eq(isPatternScriptRunning(mem), true, "the script is running once started");
  near(mem.scriptExpires, 10 + CFG.holdSec, "the script expires a hold after it starts");
  eq(p.lastUsed, 10, "firing stamps the pattern for LRU eviction");
  eq(advancePatternScript(mem, JAB), "step", "the first expected action steps the script");
  eq(advancePatternScript(mem, CROSS), "step", "the second expected action steps the script");
  eq(advancePatternScript(mem, HOOK), "done", "the last expected action finishes the script");
  eq(isPatternScriptRunning(mem), false, "a finished script is no longer running");
  eq(mem.statSteps, 3, "every step is counted");

  startPatternScript(mem, p, 20, CFG.holdSec);
  eq(advancePatternScript(mem, JAB), "step", "a fresh script steps again");
  eq(advancePatternScript(mem, BODY_HOOK), "abort", "deviating aborts the prepared answer");
  eq(isPatternScriptRunning(mem), false, "an aborted script stops running");
  eq(mem.holdActive, false, "aborting releases any held guard");
  eq(mem.scriptKey, null, "aborting forgets which pattern was being answered");
}

{
  // A running script does not hand the AI free answers. Every action of a
  // combination it knows still costs the read it would have needed anyway --
  // one won read must never buy three defensive reactions.
  const mem = createAiPatternMemory();
  const combo = [JAB, CROSS, HOOK];
  armPattern(mem, { key: "k", ctx: "c", acts: combo, n: 5 }, 5);

  eq(advanceScriptedCounter(mem, JAB, true), "idle", "with no script running the caller is left to its own reflex");

  startPatternScript(mem, mem.armed[0], 10, CFG.holdSec);
  eq(advanceScriptedCounter(mem, JAB, true), "counter", "a won read on the expected action runs the prepared answer");
  eq(advanceScriptedCounter(mem, CROSS, false), "wait", "a lost read answers nothing, even mid-script");
  eq(isPatternScriptRunning(mem), true, "but the script survives the punch it could not answer");
  eq(mem.scriptIdx, 2, "and the missed action is still consumed, so the script stays in step");
  eq(advanceScriptedCounter(mem, HOOK, true), "counter", "the script picks back up on the next action it reads");
  eq(isPatternScriptRunning(mem), false, "and finishes on the last action of the combination");

  // Deviating still ends it whether or not the read landed.
  startPatternScript(mem, mem.armed[0], 20, CFG.holdSec);
  eq(advanceScriptedCounter(mem, BODY_HOOK, true), "abort", "a deviation aborts on a won read");
  startPatternScript(mem, mem.armed[0], 30, CFG.holdSec);
  eq(advanceScriptedCounter(mem, BODY_HOOK, false), "abort", "and on a lost one");

  // The whole combination thrown against an AI that reads nothing.
  startPatternScript(mem, mem.armed[0], 40, CFG.holdSec);
  const answers = combo.filter(t => advanceScriptedCounter(mem, t, false) === "counter").length;
  eq(answers, 0, "an AI that wins no reads produces no counters at all");
}

{
  // The bell clears the half-seen combination without unlearning anything.
  const mem = createAiPatternMemory();
  const ctx = buildPatternContext(null);
  throwPattern(mem, [JAB, CROSS, HOOK], ctx, 1, 10);
  eq(mem.armed.length, 1, "a one-repeat tier arms immediately");
  recordPatternAction(mem, JAB, ctx, 1, 10, CFG);
  const learnedBeforeBell = mem.armed.length;
  clearPatternWindow(mem);
  eq(mem.window.length, 0, "the bell empties the window");
  eq(mem.armed.length, learnedBeforeBell, "the bell does not unlearn anything");
}

// ============================================================================
section("what defends what");

{
  const ALL: PatternAnswerAvailability = {
    perfectBlock: true, duck: true, guard: true, slip: true,
    counterPunch: true, stepOut: true, stepClears: true,
  };
  const act = (token: string) => parseActionToken(token);
  // Every answer the table can return for an action, availability permitting.
  const offered = (token: string, avail: PatternAnswerAvailability = ALL) => {
    const seen = new Set<PatternAnswer>();
    for (let i = 0; i <= 100; i++) {
      const plan = choosePatternAnswer(act(token), avail, i / 100);
      if (plan) seen.add(plan.answer);
    }
    return seen;
  };

  const headJab = punchActionToken("jab", true, "orthodox");
  const bodyJab = punchActionToken("jab", false, "orthodox");
  const headUpper = punchActionToken("rightUppercut", true, "orthodox");
  const bodyHook = punchActionToken("leftHook", false, "orthodox");

  // The engine's rules, stated as assertions.
  ok(offered(headJab).has("duck"), "a head punch can be ducked -- it misses outright");
  ok(!offered(headUpper).has("duck"), "an uppercut is never ducked: it follows the head up and lands anyway");
  ok(offered(headUpper).has("perfectBlock") && offered(headUpper).has("slip"), "an uppercut is perfect blocked or slipped instead");
  ok(!offered(bodyJab).has("slip"), "body work is never slipped -- a slip only moves the head");
  ok(!offered(bodyJab).has("duck"), "and ducking is not itself the answer to a body shot");
  ok(offered(headJab).has("slip"), "a head punch can be slipped");
  for (const t of [headJab, bodyJab, headUpper, bodyHook]) {
    ok(offered(t).has("counterPunch"), `every punch can be answered with the opposite hand (${t})`);
    ok(offered(t).has("perfectBlock"), `every punch can be perfect blocked (${t})`);
    ok(offered(t).has("stepOut"), `every punch can be stepped away from (${t})`);
  }

  const feint = offered(feintActionToken("cross", "orthodox"));
  eq(feint.size, 1, "a feint has exactly one answer");
  ok(feint.has("guard"), "and it is hands up, feet still");

  // An armed charge is an offensive action, and gets the three answers a charge
  // cannot beat. Plain guarding is not one of them: a charged punch of a
  // matching family goes straight through an ordinary guard.
  const charge = offered(PATTERN_TOKEN_CHARGE);
  ok(charge.has("perfectBlock"), "a charge is answered with the one block it cannot bypass");
  ok(charge.has("duck"), "or by getting under the punch that comes out of it");
  ok(charge.has("stepOut"), "or by not being there when it lands");
  ok(!charge.has("guard"), "but never with an ordinary guard, which a charge bypasses");
  ok(!charge.has("slip") && !charge.has("counterPunch"), "and never with something that needs to know the punch");
  // The block ducks with itself against a charge: the height is unknown, so the
  // AI takes both answers rather than guessing which one it needs.
  let chargeBlockDucked = 0;
  let chargeBlocks = 0;
  for (let i = 0; i <= 100; i++) {
    const plan = choosePatternAnswer(act(PATTERN_TOKEN_CHARGE), ALL, i / 100)!;
    if (plan.answer === "perfectBlock") { chargeBlocks++; if (plan.duckWith) chargeBlockDucked++; }
  }
  ok(chargeBlocks > 0 && chargeBlockDucked === chargeBlocks, "a perfect block against a charge always ducks with it");
  for (let i = 0; i <= 100; i++) {
    const plan = choosePatternAnswer(act(PATTERN_TOKEN_CHARGE), { ...ALL, duck: false }, i / 100)!;
    ok(!plan.duckWith, "and an AI that cannot duck answers the charge standing up rather than not at all");
  }

  // Low work is met at its own height.
  eq(choosePatternAnswer(act(bodyJab), ALL, 0)!.duckWith, true, "the AI drops with a body shot");
  eq(choosePatternAnswer(act(PATTERN_TOKEN_DUCK), ALL, 0)!.duckWith, true, "and when they drop to set one up");
  eq(choosePatternAnswer(act(headJab), ALL, 0)!.duckWith, false, "but not against head work");
  eq(isLowPatternAction(act(bodyHook)), true, "a punch thrown out of a duck is low work");
  eq(isLowPatternAction(act(headJab)), false, "a standing head punch is not");
  const noDuck = { ...ALL, duck: false };
  for (let i = 0; i <= 20; i++) {
    const plan = choosePatternAnswer(act(bodyJab), noDuck, i / 20)!;
    ok(!plan.duckWith, "a stunned or committed AI answers low work standing up rather than not at all");
  }

  // Availability is respected, and an answer it cannot run hands its weight over.
  const onlyStep: PatternAnswerAvailability = {
    perfectBlock: false, duck: false, guard: false, slip: false,
    counterPunch: false, stepOut: true, stepClears: true,
  };
  eq(choosePatternAnswer(act(headJab), onlyStep, 0.99)!.answer, "stepOut", "the last answer standing is the one taken");
  const nothing: PatternAnswerAvailability = { ...onlyStep, stepOut: false };
  eq(choosePatternAnswer(act(headJab), nothing, 0.5), null, "an AI that can do nothing answers nothing");
  eq(choosePatternAnswer(act(feintActionToken("jab", "orthodox")), { ...ALL, guard: false }, 0.5), null, "and a feint with no guard available is left alone");

  // A step that does not clear the punch is worth less than one that does.
  const clears = { ...ALL, stepClears: true };
  const short = { ...ALL, stepClears: false };
  const rate = (avail: PatternAnswerAvailability) => {
    let n = 0;
    for (let i = 0; i < 1000; i++) if (choosePatternAnswer(act(headJab), avail, i / 1000)!.answer === "stepOut") n++;
    return n / 1000;
  };
  ok(rate(short) < rate(clears), "a step too short to clear the punch is chosen less often", `short=${rate(short).toFixed(3)} clears=${rate(clears).toFixed(3)}`);
  ok(rate(short) > 0, "but it is still worth doing -- it spoils the range the rest was measured from");

  // Nothing outside the availability set is ever returned, for any action.
  const tokens = [headJab, bodyJab, headUpper, bodyHook, PATTERN_TOKEN_CHARGE, PATTERN_TOKEN_DUCK, feintActionToken("jab", "orthodox")];
  let leaked = 0;
  for (const t of tokens) {
    for (const key of ["perfectBlock", "duck", "guard", "slip", "counterPunch", "stepOut"] as PatternAnswer[]) {
      const avail = { ...ALL, [key]: false } as PatternAnswerAvailability;
      for (let i = 0; i <= 40; i++) {
        const plan = choosePatternAnswer(act(t), avail, i / 40);
        if (plan && plan.answer === key) leaked++;
        if (plan && plan.duckWith && !avail.duck) leaked++;
      }
    }
  }
  eq(leaked, 0, "an answer the AI cannot run is never chosen");

  // The weights are a table, not a guess: they must be positive and finite.
  for (const t of tokens) {
    const rows = patternAnswerWeights(act(t));
    ok(rows.length > 0, `every action has at least one answer (${t})`);
    ok(rows.every(r => Number.isFinite(r.w) && r.w > 0), `every weight is a real positive number (${t})`);
  }
}

// ============================================================================
section("career library");

{
  const mem = createAiPatternMemory();
  armPattern(mem, { key: "a", ctx: "c", acts: [JAB, CROSS, HOOK], n: 4 }, 10);
  armPattern(mem, { key: "b", ctx: "c", acts: [CROSS, HOOK, JAB], n: 2 }, 10);
  const lib = exportPatternLibrary(mem);
  eq(lib.length, 2, "the armed set exports whole");
  ok(lib.every(e => Array.isArray(e.acts) && e.acts.length === PATTERN_LENGTH), "every exported entry is a full pattern");
  lib[0].acts.push("tampered");
  eq(mem.armed[0].acts.length, PATTERN_LENGTH, "the export is a copy, not a live handle");
}

/** The library's own key format, mirrored so the tests name real entries. */
function libKey(ctx: string, acts: string[]): string {
  return `${ctx}#${acts.join(">")}`;
}


/**
 * The i-th distinct three-action combination.
 *
 * A pattern's identity is its context and its actions, so a fixture library
 * cannot fake variety with different key strings over the same three punches --
 * those are one pattern under forty names and get folded into one on load.
 */
function comboAt(i: number): string[] {
  return [
    punchActionToken(ALL_PUNCHES[i % 6], true, "orthodox"),
    punchActionToken(ALL_PUNCHES[Math.floor(i / 6) % 6], true, "orthodox"),
    punchActionToken(ALL_PUNCHES[Math.floor(i / 36) % 6], i % 2 === 0, "orthodox"),
  ];
}

{
  const C = buildPatternContext(null);
  const A = [JAB, CROSS, HOOK];
  const B = [CROSS, HOOK, JAB];
  const Z = [HOOK, JAB, CROSS];
  const existing: AiPatternLibraryEntry[] = [
    { key: libKey(C, A), ctx: C, acts: A, n: 5 },
    { key: libKey(C, B), ctx: C, acts: B, n: 3 },
  ];
  const incoming: AiPatternLibraryEntry[] = [
    { key: libKey(C, A), ctx: C, acts: A, n: 2 },
    { key: libKey(C, Z), ctx: C, acts: Z, n: 9 },
  ];
  const merged = mergePatternLibrary(existing, incoming, 100);
  eq(merged.length, 3, "merging dedupes by pattern");
  eq(merged.find(e => e.key === libKey(C, A))?.n, 5, "the higher sighting count wins a collision");
  eq(merged[0].key, libKey(C, Z), "the most-seen pattern sorts first");

  const trimmed = mergePatternLibrary(existing, incoming, 2);
  eq(trimmed.length, 2, "the library trims to its cap");
  ok(trimmed.every(e => e.key !== libKey(C, B)), "trimming drops the least-seen");

  eq(mergePatternLibrary(existing, incoming, 0).length, 0, "a zero cap keeps nothing");
  const dirty = mergePatternLibrary(
    [null as unknown as AiPatternLibraryEntry, { key: "x", ctx: C, acts: "nope" as unknown as string[], n: 1 }],
    incoming,
    10,
  );
  ok(dirty.every(e => e && Array.isArray(e.acts)), "a corrupt saved entry is dropped rather than crashing");

  // Determinism: the same inputs must produce the same save blob every time.
  eq(
    JSON.stringify(mergePatternLibrary(existing, incoming, 100)),
    JSON.stringify(mergePatternLibrary(existing, incoming, 100)),
    "merging is deterministic",
  );
}

{
  // Careers written while separation was part of the context. Those keys can
  // never match a live one again, so they are re-keyed on the way in and the
  // buckets of one combination fold into the single pattern they always were.
  const acts = [JAB, CROSS, HOOK];
  const legacy: AiPatternLibraryEntry[] = [
    { key: `55|-#${acts.join(">")}`, ctx: "55|-", acts, n: 4 },
    { key: `60|-#${acts.join(">")}`, ctx: "60|-", acts, n: 7 },
    { key: `65|-#${acts.join(">")}`, ctx: "65|-", acts, n: 2 },
    { key: `60|jab#${acts.join(">")}`, ctx: "60|jab", acts, n: 3 },
  ];
  const fixed = normalizePatternLibrary(legacy);
  eq(fixed.length, 2, "distance buckets of one combination collapse together");
  const merged = fixed.find(e => e.ctx === buildPatternContext(null));
  eq(merged?.n, 7, "the heaviest bucket's count carries");
  eq(merged?.key, libKey(buildPatternContext(null), acts), "and the entry is re-keyed to the live format");
  ok(
    fixed.some(e => e.ctx === buildPatternContext("jab" as PunchType)),
    "a different last landed punch is still a different pattern",
  );
  ok(fixed.every(e => !e.ctx.includes("|")), "no separation survives the migration");

  // Idempotent: a save already migrated must come back out unchanged.
  eq(
    JSON.stringify(normalizePatternLibrary(fixed)),
    JSON.stringify(fixed),
    "migrating an already-migrated library changes nothing",
  );

  // And it happens on the paths the game actually uses.
  ok(
    mergePatternLibrary(legacy, [], 100).every(e => !e.ctx.includes("|")),
    "the save fold migrates on write",
  );
  const studied = createAiPatternMemory();
  seedPatternMemory(studied, legacy, 5, 10, makePatternStudyRng(4), CFG, 3);
  ok(
    studied.armed.length > 0 && studied.armed.every(e => !e.ctx.includes("|")),
    "tape study migrates on read",
    `armed=${studied.armed.length}`,
  );
  ok(
    findArmedPattern(studied, buildPatternContext(null), JAB) !== null,
    "and what was studied off an old save is findable from a live context",
  );
}

// ============================================================================
section("career tape study");

{
  for (let i = 1; i < AI_PATTERN_STUDY_LADDER.length; i++) {
    ok(
      AI_PATTERN_STUDY_LADDER[i].maxRank > AI_PATTERN_STUDY_LADDER[i - 1].maxRank,
      "the ladder is ordered from the top rank down",
    );
    ok(
      AI_PATTERN_STUDY_LADDER[i].max <= AI_PATTERN_STUDY_LADDER[i - 1].max,
      "a worse rank never studies more than a better one",
    );
  }
  for (const band of AI_PATTERN_STUDY_LADDER) {
    ok(band.min >= 0 && band.min <= band.max, `band ${band.maxRank} is a sane range`, `${band.min}..${band.max}`);
  }
  eq(AI_PATTERN_STUDY_LADDER[AI_PATTERN_STUDY_LADDER.length - 1].maxRank, Infinity, "the last band is the catch-all");

  // Every rank a career can produce must land in a band. A fresh career sits
  // below the whole roster, so the bottom end matters as much as the top.
  for (const rank of [1, 2, 50, 51, 120, 250, 400, 600, 705, 5000]) {
    const rand = makePatternStudyRng(rank);
    const n = patternStudyCount(rank, CFG, rand);
    ok(Number.isFinite(n) && n >= 0, `rank ${rank} gets a real study count`, `${n}`);
  }
  eq(patternStudyCount(1, CFG, makePatternStudyRng(7)), 10, "the champion has watched all ten");
  ok(patternStudyCount(705, CFG, makePatternStudyRng(7)) <= 2, "the bottom of the ladder has barely watched anything");
  eq(patternStudyCount(1, { ...CFG, studyScale: 0 }, makePatternStudyRng(7)), 0, "a zero study multiplier switches tape study off");
  ok(patternStudyCount(1, { ...CFG, studyScale: 2 }, makePatternStudyRng(7)) > 10, "the study multiplier scales the ladder");
}

{
  const THRESH = patternRecognitionThreshold(CFG, "champion");
  const CTX = buildPatternContext(null);
  const library: AiPatternLibraryEntry[] = [];
  for (let i = 0; i < 40; i++) {
    const acts = comboAt(i);
    library.push({ key: libKey(CTX, acts), ctx: CTX, acts, n: 40 - i });
  }
  /** The heaviest `count` entries, in tape order: what a study card should be. */
  const heaviestKeys = (count: number) => library.slice(0, count).map(e => e.key).join(",");

  const runStudy = (seed: number, count: number, cap: number, lib = library, threshold = THRESH) => {
    const mem = createAiPatternMemory();
    const n = seedPatternMemory(mem, lib, count, cap, makePatternStudyRng(seed), CFG, threshold);
    return { mem, n };
  };

  const a = runStudy(1234, 6, 10);
  const b = runStudy(1234, 6, 10);
  eq(a.n, 6, "the requested number of patterns is studied");
  eq(
    a.mem.armed.map(p => p.key).join(","),
    b.mem.armed.map(p => p.key).join(","),
    "the same opponent studies the same card every time",
  );
  eq(new Set(a.mem.armed.map(p => p.key)).size, a.mem.armed.length, "no pattern is studied twice");
  ok(a.mem.armed.every(p => p.studied), "everything off the tape is marked as studied");

  // The whole point of the priority rule: the heaviest-repeated combinations go
  // first, whoever is doing the studying.
  eq(a.mem.armed.map(p => p.key).join(","), heaviestKeys(6), "the heaviest tape is studied first");
  for (const seed of [1, 99, 4242, 777777]) {
    eq(
      runStudy(seed, 6, 10).mem.armed.map(p => p.key).join(","),
      heaviestKeys(6),
      `seed ${seed} still studies the heaviest six`,
    );
  }
  // A shorter card is a shallower cut of the same list, never a different sample.
  const shallow = runStudy(555, 3, 10).mem.armed.map(p => p.key);
  eq(shallow.join(","), a.mem.armed.slice(0, 3).map(p => p.key).join(","), "a shorter study card is the top of the same list");

  // Only genuinely tied weights are left to the opponent's own draw.
  const tied: AiPatternLibraryEntry[] = [];
  for (let i = 0; i < 12; i++) {
    const acts = comboAt(i);
    tied.push({ key: libKey(CTX, acts), ctx: CTX, acts, n: 7 });
  }
  const cards = new Set([1, 2, 3, 4, 5, 6].map(s => runStudy(s, 4, 10, tied).mem.armed.map(p => p.key).join(",")));
  ok(cards.size > 1, "equally repeated combinations are not always studied in the same order", `${cards.size} distinct cards`);

  const capped = runStudy(1234, 30, 4);
  eq(capped.n, 4, "study never exceeds what the tier can hold");
  eq(capped.mem.armed.length, 4, "and never over-fills the armed set");
  eq(capped.mem.armed.map(p => p.key).join(","), heaviestKeys(4), "a small armed set still gets the heaviest tape");

  eq(runStudy(1234, 0, 10).n, 0, "studying nothing arms nothing");
  eq(runStudy(1234, -5, 10).n, 0, "a negative count is not a request for patterns");
  eq(
    seedPatternMemory(createAiPatternMemory(), [], 5, 10, makePatternStudyRng(1), CFG, THRESH),
    0,
    "an empty tape teaches nothing",
  );
  eq(
    seedPatternMemory(createAiPatternMemory(), library, 500, 10, makePatternStudyRng(1), CFG, THRESH),
    10,
    "asking for more than the tier holds still terminates",
  );

  // Entries that are not full patterns must never reach the armed set: the
  // script layer indexes three actions unconditionally.
  const junkLib: AiPatternLibraryEntry[] = [
    { key: libKey(CTX, [JAB]), ctx: CTX, acts: [JAB], n: 100 },
    { key: libKey(CTX, [JAB, CROSS, HOOK]), ctx: CTX, acts: [JAB, CROSS, HOOK], n: 50 },
  ];
  const junkMem = createAiPatternMemory();
  seedPatternMemory(junkMem, junkLib, 2, 10, makePatternStudyRng(3), CFG, THRESH);
  ok(junkMem.armed.every(p => p.acts.length === PATTERN_LENGTH), "a malformed tape entry is never studied");
  eq(junkMem.armed.length, 1, "and the rest of the tape is still studied around it");

  // A studied pattern has to be usable the moment the bell rings.
  const live = runStudy(1234, 3, 10);
  const first = live.mem.armed[0];
  ok(findArmedPattern(live.mem, first.ctx, first.acts[0]) !== null, "a studied pattern is live from the first bell");
}

// ============================================================================
section("studied patterns keep building");

{
  const THRESH = patternRecognitionThreshold(CFG, "champion");

  // What comes off tape is compressed: recognized, surer the heavier it is, and
  // still short of the ceiling so the bout itself can add to it.
  eq(studiedSeedCount(1, THRESH, CFG), THRESH, "a pattern seen once opens at the recognition threshold");
  eq(studiedSeedCount(0, THRESH, CFG), THRESH, "so does a nonsense weight");
  ok(studiedSeedCount(999, THRESH, CFG) <= THRESH + CFG.studyCarryMax, "the carry is capped however heavy the tape is");
  let prev = 0;
  for (const libN of [1, 2, 4, 8, 16, 32, 64, 128]) {
    const seeded = studiedSeedCount(libN, THRESH, CFG);
    ok(seeded >= prev, `a heavier tape never opens lower (${libN})`, `${seeded} < ${prev}`);
    ok(seeded >= THRESH, `${libN} still opens recognized`);
    prev = seeded;
  }
  eq(studiedSeedCount(500, THRESH, { ...CFG, studyCarryPct: 0 }), THRESH, "a zero carry opens everyone at the threshold");
  eq(
    studiedSeedCount(500, THRESH, { ...CFG, studyCarryPct: 100, studyCarryMax: 4 }),
    THRESH + 4,
    "a full carry is still held to the ceiling",
  );

  const heaviest = studiedSeedCount(40, THRESH, CFG);
  const atBell = patternCounterChance(
    { key: "k", ctx: "c", acts: [JAB, CROSS, HOOK], n: heaviest, lastUsed: 0, seq: 0, studied: true, tapeOffset: 0 },
    THRESH, 0, 0, CFG,
  );
  ok(atBell < CFG.maxChancePct / 100, "even the heaviest studied pattern has room left to build", `${atBell}`);

  // Build on it: seed from tape, then run the combination again during the bout.
  const ctx = buildPatternContext(null);
  const acts = [JAB, CROSS, HOOK];
  const key = `${ctx}#${acts.join(">")}`;
  const lib: AiPatternLibraryEntry[] = [{ key, ctx, acts, n: 30 }];
  const mem = createAiPatternMemory();
  eq(seedPatternMemory(mem, lib, 1, 10, makePatternStudyRng(11), CFG, THRESH), 1, "the tape entry is studied");
  const armed = mem.armed[0];
  const openedOn = armed.n;
  const openingChance = patternCounterChance(armed, THRESH, 0, 0, CFG);

  // Rotations of a repeated combination are learnable in their own right, so the
  // armed set legitimately grows here; what must not happen is a second copy of
  // the studied pattern itself sitting alongside the one that came off tape.
  for (let i = 0; i < 3; i++) throwPattern(mem, acts, ctx, THRESH, 10);
  eq(mem.armed.filter(p => p.key === key).length, 1, "running a studied combination again does not arm a second copy");
  eq(armed.n, openedOn + 3, "every repeat during the bout is counted on top of the tape");
  ok(
    patternCounterChance(armed, THRESH, 0, 0, CFG) > openingChance,
    "and the counter gets surer as the bout goes on",
  );
  ok(armed.studied, "the pattern is still marked as studied afterwards");

  // Back onto the tape: the bout's sightings land on top of the career weight
  // rather than being swallowed by the compression.
  const exported = exportPatternLibrary(mem);
  eq(exported.find(e => e.key === key)?.n, 33, "the tape weight comes back out with the bout's repeats added");
  eq(mergePatternLibrary(lib, exported, 100).find(e => e.key === key)?.n, 33, "and the merge keeps the grown weight");

  // A bout where the studied pattern is never thrown must not shrink the tape.
  const quiet = createAiPatternMemory();
  seedPatternMemory(quiet, lib, 1, 10, makePatternStudyRng(11), CFG, THRESH);
  eq(
    mergePatternLibrary(lib, exportPatternLibrary(quiet), 100).find(e => e.key === key)?.n,
    30,
    "an unused studied pattern leaves the tape as it was",
  );

  // Room runs out mid-bout: the prepared work is the last thing let go of.
  const tight = createAiPatternMemory();
  const entry = (k: string, n: number): AiPatternLibraryEntry => ({ key: k, ctx: "c", acts, n });
  armPattern(tight, entry("studied", 3), 2, { studied: true, tapeOffset: 9 });
  armPattern(tight, entry("live", 3), 2);
  armPattern(tight, entry("newer", 3), 2);
  eq(tight.armed.length, 2, "capacity still holds");
  ok(tight.armed.some(p => p.key === "studied"), "tape study survives an eviction tie");
  ok(!tight.armed.some(p => p.key === "live"), "the live-learned pattern is the one dropped");

  // A weaker studied pattern is still evicted first: sightings outrank tape.
  const outranked = createAiPatternMemory();
  armPattern(outranked, entry("studied", 2), 2, { studied: true });
  armPattern(outranked, entry("live", 6), 2);
  armPattern(outranked, entry("newer", 6), 2);
  ok(!outranked.armed.some(p => p.key === "studied"), "a rarely seen studied pattern still loses to a well-seen live one");

  // Crowded out and then gone back to: the books it came in on must come back
  // with it, or the bout's repeats vanish into the merge's keep-the-larger rule.
  const crowded = createAiPatternMemory();
  seedPatternMemory(crowded, lib, 1, 1, makePatternStudyRng(5), CFG, THRESH);
  const seededAt = crowded.armed[0].n;
  armPattern(crowded, { key: "bully", ctx: "c", acts, n: 99 }, 1);
  ok(!crowded.armed.some(p => p.key === key), "a studied pattern can be crowded out mid-bout");
  armPattern(crowded, { key, ctx, acts, n: seededAt + 4 }, 4);
  const back = crowded.armed.find(p => p.key === key)!;
  ok(back.studied, "and it is still known to have come off tape when it returns");
  eq(back.tapeOffset, 30 - seededAt, "its tape books come back with it");
  eq(
    mergePatternLibrary(lib, exportPatternLibrary(crowded), 100).find(e => e.key === key)?.n,
    34,
    "so the repeats it earned after being crowded out still reach the tape",
  );

  // A tape entry thinner than this tier's threshold is lifted to be usable, and
  // that lift must not be mistaken for sightings the player never threw.
  const thinLib: AiPatternLibraryEntry[] = [{ key, ctx, acts, n: 1 }];
  const thin = createAiPatternMemory();
  seedPatternMemory(thin, thinLib, 1, 10, makePatternStudyRng(2), CFG, 5);
  eq(thin.armed[0].n, 5, "a thin tape entry is lifted to the threshold so it can be countered");
  eq(exportPatternLibrary(thin)[0].n, 1, "but it goes back onto the tape at the weight it really had");
  eq(
    mergePatternLibrary(thinLib, exportPatternLibrary(thin), 100)[0].n,
    1,
    "a quiet bout never inflates a thin tape entry",
  );

  // Nothing from a save file is trusted to be a number.
  const junk = [
    { key: libKey(ctx, comboAt(0)), ctx, acts: comboAt(0), n: NaN },
    { key: libKey(ctx, comboAt(1)), ctx, acts: comboAt(1), n: "12" as unknown as number },
    { key: libKey(ctx, comboAt(2)), ctx, acts: comboAt(2), n: undefined as unknown as number },
  ];
  const junkMem = createAiPatternMemory();
  eq(seedPatternMemory(junkMem, junk, 3, 10, makePatternStudyRng(8), CFG, THRESH), 3, "junk weights still study");
  ok(junkMem.armed.every(p => Number.isFinite(p.n) && Number.isFinite(p.tapeOffset)), "and never arm a NaN count");
  ok(
    exportPatternLibrary(junkMem).every(e => Number.isFinite(e.n) && e.n >= 1),
    "a junk weight never reaches the save file",
  );
  ok(
    mergePatternLibrary(junk, exportPatternLibrary(junkMem), 100).every(e => Number.isFinite(e.n) && e.n >= 1),
    "and the merge cleans what is already on the tape",
  );
}

// ============================================================================
section("tier sanity across the roster");

{
  // Walk every tier through a plausible bout and confirm nothing runs away.
  for (const tier of TIERS) {
    const threshold = patternRecognitionThreshold(CFG, tier);
    const capacity = patternArmedCapacity(CFG, tier);
    const mem = createAiPatternMemory();
    const combos = [
      [JAB, JAB, CROSS],
      [JAB, CROSS, HOOK],
      [CROSS, HOOK, BODY_HOOK],
      [JAB, BODY_HOOK, CROSS],
      [PATTERN_TOKEN_CHARGE, JAB, CROSS],
      [PATTERN_TOKEN_DUCK, BODY_HOOK, HOOK],
    ];
    // Three contexts in rotation, so each pattern is only seen a third as
    // often as it is thrown -- the AI's own last landed punch is part of a
    // pattern's identity, and it changing genuinely does slow the AI down.
    // Enough rounds that even the slowest tier clears its threshold.
    const ctxRotation = [null, "jab" as PunchType, "cross" as PunchType];
    const rounds = Math.max(12, threshold * 3 + 3);
    for (let round = 0; round < rounds; round++) {
      for (const combo of combos) {
        const ctx = buildPatternContext(ctxRotation[round % ctxRotation.length]);
        throwPattern(mem, combo, ctx, threshold, capacity);
      }
      clearPatternWindow(mem);
    }
    ok(mem.armed.length <= capacity, `${tier} respects its capacity over a long bout`, `${mem.armed.length} > ${capacity}`);
    ok(mem.armed.length > 0, `${tier} learns something over a long bout`);
    ok(
      Object.keys(mem.candidates).length <= CFG.maxCandidates,
      `${tier} keeps its candidate list bounded`,
      `${Object.keys(mem.candidates).length}`,
    );
    const exported = exportPatternLibrary(mem);
    ok(exported.length <= capacity, `${tier} exports no more than it holds`);
  }

  // The champion must not be slower to catch on than a journeyman.
  const champMem = createAiPatternMemory();
  const jmanMem = createAiPatternMemory();
  const ctx = buildPatternContext(null);
  let champAt = -1;
  let jmanAt = -1;
  for (let i = 0; i < 12; i++) {
    if (throwPattern(champMem, [JAB, CROSS, HOOK], ctx, patternRecognitionThreshold(CFG, "champion"), 10) && champAt < 0) champAt = i;
    if (throwPattern(jmanMem, [JAB, CROSS, HOOK], ctx, patternRecognitionThreshold(CFG, "journeyman"), 10) && jmanAt < 0) jmanAt = i;
  }
  ok(champAt >= 0 && jmanAt >= 0, "both tiers eventually catch on", `champ=${champAt} jman=${jmanAt}`);
  ok(champAt <= jmanAt, "the champion catches on no later than the journeyman", `champ=${champAt} jman=${jmanAt}`);
}

// ============================================================================
section("held postures");

{
  // The lifecycle of a duck armed against an armed charge, tick by tick. It is
  // stamped to a punch that does not exist yet -- one past the count -- and
  // carried by the charge until it turns into that punch.
  const DEADLINE = 1.5;
  const base: PatternHoldInputs = {
    holdArmed: true,
    stampedPunchId: 5,
    punchesThrown: 4,
    chargeArmed: true,
    isPunching: false,
    retracting: false,
    now: 0,
    chargeWaitUntil: DEADLINE,
  };
  const at = (over: Partial<PatternHoldInputs>) => patternHoldStatus({ ...base, ...over });

  // Armed: the charge is being sat on and nothing is being thrown.
  ok(at({}).waitingOnCharge, "a duck armed against a charge is waiting on it");
  ok(at({}).holdOwed, "and the crouch is owed while it waits");
  ok(
    !at({}).guardSpent,
    "the scripted guard is not spent merely because no punch is out -- during a charge wait that means not yet, not finished",
  );

  // Still waiting, ticks later, inside the deadline.
  for (const t of [0.1, 0.5, 1.0, DEADLINE]) {
    ok(at({ now: t }).holdOwed, `the crouch survives to t=${t}`);
    ok(!at({ now: t }).guardSpent, `and the guard is not dropped at t=${t}`);
  }

  // The charge is thrown: the count reaches the stamp and the charge disarms on
  // the same frame, so the hold hands over to the punch itself without a gap.
  const thrown = at({ punchesThrown: 5, chargeArmed: false, isPunching: true, now: 0.8 });
  ok(!thrown.waitingOnCharge, "once thrown it is no longer waiting on a charge");
  ok(thrown.holdOwed, "and the same crouch now rides the punch that came out of it");
  ok(!thrown.guardSpent, "with the guard still up for it");

  // It starts coming back: both rules end together, which is the whole point of
  // deriving them from one answer.
  const back = at({ punchesThrown: 5, chargeArmed: false, isPunching: true, retracting: true, now: 1.0 });
  ok(!back.holdOwed, "the crouch ends when the punch starts back");
  ok(back.guardSpent, "and the guard comes down with it");

  // Dropped without ever being thrown.
  const dropped = at({ chargeArmed: false, now: 0.4 });
  ok(!dropped.waitingOnCharge && !dropped.holdOwed, "a charge dropped unthrown releases the crouch");
  ok(dropped.guardSpent, "and stands the AI back up");

  // Sat on past the deadline. A charge is legally holdable for several seconds;
  // an AI crouched through all of it is worse off than one that never read it.
  ok(at({ now: DEADLINE }).holdOwed, "the deadline itself is still inside the wait");
  ok(!at({ now: DEADLINE + 0.001 }).holdOwed, "a charge held past it stops being waited on");
  ok(at({ now: DEADLINE + 0.001 }).guardSpent, "and the AI stands back up rather than camping");

  // ---- the ordinary case, which none of this may have moved ------------------
  const inFlight: PatternHoldInputs = {
    holdArmed: true, stampedPunchId: 7, punchesThrown: 7, chargeArmed: false,
    isPunching: true, retracting: false, now: 0, chargeWaitUntil: 0,
  };
  const flight = (over: Partial<PatternHoldInputs> = {}) => patternHoldStatus({ ...inFlight, ...over });
  ok(flight().holdOwed, "a duck held on a punch already in flight is owed");
  ok(!flight().waitingOnCharge, "and is not a charge wait");
  ok(!flight().guardSpent, "the guard stays up for the punch");
  ok(!flight({ retracting: true }).holdOwed, "it ends on retraction");
  ok(flight({ retracting: true }).guardSpent, "and so does the guard");
  ok(!flight({ punchesThrown: 8 }).holdOwed, "the count moving on to the next punch ends it");
  ok(!flight({ isPunching: false }).holdOwed, "and so does a punch that never materializes");

  // No hold armed: the guard rule has to reduce to exactly what it always was,
  // so an ordinary scripted guard is untouched by any of this.
  const noHold: PatternHoldInputs = {
    ...inFlight, holdArmed: false, stampedPunchId: -1, punchesThrown: 0, isPunching: false,
  };
  ok(!patternHoldStatus(noHold).waitingOnCharge, "with no hold armed there is no charge wait");
  ok(!patternHoldStatus(noHold).holdOwed, "and nothing owed");
  ok(patternHoldStatus(noHold).guardSpent, "a guard raised at nothing comes straight down");
  ok(
    patternHoldStatus({ ...noHold, chargeArmed: true, chargeWaitUntil: 99 }).guardSpent,
    "even mid-charge -- the wait belongs to the hold, and an unstamped guard has nothing to wait for",
  );
  ok(
    !patternHoldStatus({ ...base, holdArmed: false }).waitingOnCharge,
    "and clearing the flag ends the wait whatever stamp is left behind",
  );
}

// ============================================================================
section("under-the-hood readout");

{
  eq(PATTERN_HUD_MAX, 10, "the overlay shows ten combinations");

  eq(describeActionToken(PATTERN_TOKEN_CHARGE), "ARMED CHARGE", "a charge reads as an armed charge");
  eq(describeActionToken(PATTERN_TOKEN_DUCK), "DUCK", "and a drop as a duck");
  eq(describeActionToken(punchActionToken("jab", true, "orthodox")), "L.JAB", "a head punch is the glove and the punch");
  eq(describeActionToken(feintActionToken("cross", "orthodox")), "R.CROSS FEINT", "a feint says so, off the hand selling it");

  // The one distinction the readout must never lose: the ducked variation of a
  // punch is a different pattern entry with a different answer, so it cannot
  // read the same as the standing one.
  const punches = ["jab", "cross", "leftHook", "rightHook", "leftUppercut", "rightUppercut"] as const;
  for (const p of punches) {
    const head = describeActionToken(punchActionToken(p, true, "orthodox"));
    const body = describeActionToken(punchActionToken(p, false, "orthodox"));
    ok(head.length > 0 && !head.includes("?"), `${p} to the head has a name`, head);
    ok(head !== body, `${p} to the body does not read as ${p} to the head`, `${head} vs ${body}`);
  }
  // ...and no two distinct punches share a label either.
  const labels = new Set(punches.map(p => describeActionToken(punchActionToken(p, true, "orthodox"))));
  eq(labels.size, punches.length, "every punch has its own name on the overlay");

  const acts = [punchActionToken("jab", true, "orthodox"), punchActionToken("cross", true, "orthodox"), punchActionToken("leftHook", false, "orthodox")];
  const line = describePattern(acts);
  for (const a of acts) ok(line.includes(describeActionToken(a)), `the combination line contains ${a}`, line);
  ok(line.includes("BODY"), "and still calls out the body shot inside a combination", line);
  eq(describePattern([]), "", "an empty combination is an empty line");

  // Most recently memorized first, bounded, and non-destructive: the overlay
  // reads the live brain every frame and must never reorder what it is showing.
  const hudMem = createAiPatternMemory();
  const hudCtx = buildPatternContext(null);
  for (let i = 0; i < PATTERN_HUD_MAX + 5; i++) {
    const acts3 = [punchActionToken("jab", true, "orthodox"), punchActionToken("cross", true, "orthodox"), punchActionToken("leftHook", i % 2 === 0, "orthodox")];
    armPattern(hudMem, { key: `hud${i}`, ctx: hudCtx, acts: acts3, n: 2 + i }, 100);
  }
  const before = hudMem.armed.map(p => p.key).join(",");
  const shown = selectRecentArmedPatterns(hudMem);
  eq(shown.length, PATTERN_HUD_MAX, "no more than ten rows");
  eq(hudMem.armed.map(p => p.key).join(","), before, "reading the overlay does not reorder the AI's memory");
  let descending = true;
  for (let i = 1; i < shown.length; i++) if (shown[i].seq > shown[i - 1].seq) descending = false;
  ok(descending, "the most recently memorized combination is on top");
  eq(shown[0].seq, Math.max(...hudMem.armed.map(p => p.seq)), "and it really is the newest one");
  eq(selectRecentArmedPatterns(hudMem, 0).length, 0, "asking for none returns none");
  eq(selectRecentArmedPatterns(createAiPatternMemory()).length, 0, "an AI that has learned nothing shows nothing");
}

// ============================================================================
console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.error(`${failures} FAILED`);
  process.exit(1);
}
console.log("ai pattern check OK");
