/**
 * Drilled Action upkeep checks — run with `npx tsx script/drilledUpkeepCheck.ts`.
 *
 * The project has no test runner, so this is a self-contained assertion script
 * covering the rehearsal clock that sits alongside sharpness: the stamina
 * ladder a string's closing punch is billed at, the two bars that move it
 * (a full sparring quota improves, a single throw anywhere holds), the grace
 * period before neglect starts costing rungs, and the buffer weeks reps buy.
 *
 * It also guards the five-rung tier ladder the career panel prints -- Rough,
 * Good, Sharp, Effortless, Mastered -- and that the slip window stays a mastery
 * perk rather than drifting back down to a rung of its own.
 *
 * Deliberately imports only `drilledActions`, which is engine-free — anything
 * pulling `engine.ts` drags the audio module's mp3 imports in and can't run
 * under tsx.
 */
import {
  DRILLED_ACTION_CONFIG,
  advanceDrilledWeek,
  createDrilledFightState,
  creditDrilledAction,
  drilledActionKey,
  drilledClosingBuffs,
  drilledDecayBufferWeeks,
  drilledGraceWeeks,
  drilledNextTierAt,
  drilledPowerMult,
  drilledStaminaMultForTier,
  drilledStaminaMultOf,
  drilledTierLabel,
  drilledUpkeepOf,
  noteDrilledThrow,
  normalizeDrilledActions,
  type DrilledActionEntry,
} from "../client/src/game/drilledActions";

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const cfg = DRILLED_ACTION_CONFIG;
const ACTS = ["jab", "cross", "hook"];
const KEY = drilledActionKey(ACTS);
const TOP = cfg.staminaLadder.length - 1;

/** A listed, unrehearsed string with `n` landings behind it. */
function entry(over: Partial<DrilledActionEntry> = {}): DrilledActionEntry {
  return { key: KEY, acts: [...ACTS], n: cfg.listThreshold, st: 0, wt: 0, wu: 0, dw: 0, ...over };
}

/** A bout in progress holding these strings. `recording` is the gym flag. */
function bout(entries: DrilledActionEntry[], recording: boolean) {
  return createDrilledFightState(entries, recording);
}

/** Run one career week, given this week's sparring and career throws. */
function week(e: DrilledActionEntry, sparred: number, careerThrows = 0): DrilledActionEntry {
  const ds = bout([e], true);
  for (let i = 0; i < sparred; i++) noteDrilledThrow(ds, ACTS);
  ds.recording = false;
  for (let i = 0; i < careerThrows; i++) noteDrilledThrow(ds, ACTS);
  return advanceDrilledWeek(ds.entries)[0];
}

console.log("1. the ladder is a descending price list");
{
  check("the ladder starts at full penalty", cfg.staminaLadder[0] === 3, String(cfg.staminaLadder[0]));
  check("and bottoms out at half price", cfg.staminaLadder[TOP] === 0.5, String(cfg.staminaLadder[TOP]));
  let descending = true;
  for (let i = 1; i < cfg.staminaLadder.length; i++) {
    if (cfg.staminaLadder[i] >= cfg.staminaLadder[i - 1]) descending = false;
  }
  check("every rung is cheaper than the one above it", descending, cfg.staminaLadder.join(" > "));
  check("an unrehearsed string sits on the top rung", drilledStaminaMultForTier(0) === 3);
  check("a rung below the ladder still reads the top", drilledStaminaMultForTier(-5) === 3);
  check("a rung past the bottom still reads the floor", drilledStaminaMultForTier(999) === 0.5);
  check("improving takes two sparring throws", cfg.practiceThrowsPerWeek === 2, String(cfg.practiceThrowsPerWeek));
  check("holding takes one throw anywhere", cfg.maintenanceThrowsPerWeek === 1, String(cfg.maintenanceThrowsPerWeek));
  check("neglect is forgiven for three weeks", cfg.decayGraceWeeks === 3, String(cfg.decayGraceWeeks));
}

console.log("2. only listed strings pay the surcharge");
{
  const unlisted = entry({ n: cfg.listThreshold - 1 });
  check("an unlisted string is never surcharged", drilledStaminaMultOf([unlisted], ACTS) === 1);
  check("a listed one is", drilledStaminaMultOf([entry()], ACTS) === 3);
  check("a string with no entry at all is never surcharged", drilledStaminaMultOf([], ACTS) === 1);
  check("an empty list is never surcharged", drilledStaminaMultOf(null, ACTS) === 1);
  check("a different string is unaffected", drilledStaminaMultOf([entry()], ["jab", "jab", "cross"]) === 1);
  const buffed = entry({ n: cfg.buffSharpness });
  check("a listed-but-unbuffed string is the expensive one", drilledStaminaMultOf([entry()], ACTS) === 3);
  check("reaching the buff tier does not excuse the surcharge", drilledStaminaMultOf([buffed], ACTS) === 3);
}

console.log("3. a full sparring quota walks the string down the ladder");
{
  let e = entry();
  check("it opens at 3x", drilledStaminaMultOf([e], ACTS) === 3);
  e = week(e, 2);
  check("two sparring throws buy a rung", drilledStaminaMultOf([e], ACTS) === 2);
  e = week(e, 2);
  check("another week buys another", drilledStaminaMultOf([e], ACTS) === 1);
  e = week(e, 2);
  check("a third reaches half price", drilledStaminaMultOf([e], ACTS) === 0.5);
  e = week(e, 2);
  check("the ladder stops at half price", drilledStaminaMultOf([e], ACTS) === 0.5);
  check("and the panel says so", drilledUpkeepOf(e).atFloor);
}

console.log("4. the discount lands the week AFTER the work");
{
  const ds = bout([entry()], true);
  noteDrilledThrow(ds, ACTS);
  noteDrilledThrow(ds, ACTS);
  check("the quota is met mid-week", drilledUpkeepOf(ds.entries[0]).improving);
  check("but the bout is still billed at 3x", drilledStaminaMultOf(ds.entries, ACTS) === 3);
  check("the discount arrives at rollover", drilledStaminaMultOf(advanceDrilledWeek(ds.entries), ACTS) === 2);
}

console.log("5. one throw short of the quota improves nothing");
{
  let e = entry();
  e = week(e, 1);
  check("a single sparring throw buys no rung", drilledStaminaMultOf([e], ACTS) === 3);
  check("but it does hold the decay clock at zero", drilledUpkeepOf(e).dryWeeks === 0);
  check("the week's tally is spent, not carried", drilledUpkeepOf(e).sparred === 0);
  const e2 = week(week(entry(), 1), 1);
  check("two lone weeks never add up to a rung", drilledStaminaMultOf([e2], ACTS) === 3);
}

console.log("6. career bouts hold a string but never improve it");
{
  let e = week(week(week(entry(), 2), 2), 2);
  check("three sparring weeks reach half price", drilledStaminaMultOf([e], ACTS) === 0.5);
  const before = e;
  e = week(e, 0, 5);
  check("five career throws buy no rung", drilledStaminaMultOf([e], ACTS) === 0.5, "should not improve");
  check("nor do they slip", drilledStaminaMultOf([e], ACTS) === drilledStaminaMultOf([before], ACTS));
  check("but they park the decay clock", drilledUpkeepOf(e).dryWeeks === 0);
  check("the panel reads it as maintained", drilledUpkeepOf(week(entry(), 0, 1)).maintained === false,
    "maintenance tallies are consumed at rollover");
  const mid = bout([entry()], false);
  noteDrilledThrow(mid, ACTS);
  check("a career throw shows as maintained mid-week", drilledUpkeepOf(mid.entries[0]).maintained);
  check("and does not move the improvement quota", drilledUpkeepOf(mid.entries[0]).sparred === 0);
}

console.log("7. neglect costs a rung a week, once the grace runs out");
{
  const sharp = week(week(week(entry(), 2), 2), 2);
  check("the string is at half price", drilledStaminaMultOf([sharp], ACTS) === 0.5);
  check("with three weeks of grace", drilledGraceWeeks(sharp.n) === 3, String(drilledGraceWeeks(sharp.n)));
  let e = week(sharp, 0);
  check("one idle week costs nothing", drilledStaminaMultOf([e], ACTS) === 0.5);
  check("the panel counts two weeks left", drilledUpkeepOf(e).weeksBeforeDecay === 2);
  e = week(e, 0);
  check("two idle weeks cost nothing", drilledStaminaMultOf([e], ACTS) === 0.5);
  e = week(e, 0);
  check("three idle weeks cost nothing", drilledStaminaMultOf([e], ACTS) === 0.5);
  check("but the grace is spent", drilledUpkeepOf(e).weeksBeforeDecay === 0);
  e = week(e, 0);
  check("the fourth costs a rung", drilledStaminaMultOf([e], ACTS) === 1);
  e = week(e, 0);
  check("the fifth costs another", drilledStaminaMultOf([e], ACTS) === 2);
  e = week(e, 0);
  check("the sixth is back to full price", drilledStaminaMultOf([e], ACTS) === 3);
  for (let i = 0; i < 50; i++) e = week(e, 0);
  check("and it can get no worse", drilledStaminaMultOf([e], ACTS) === 3);
  check("the dry streak is capped", drilledUpkeepOf(e).dryWeeks <= cfg.decayGraceWeeks + TOP + 1,
    String(drilledUpkeepOf(e).dryWeeks));
  check("and the panel knows the figure is only a floor", drilledUpkeepOf(e).dryCapped);
}

console.log("7b. the panel can always say how long ago a string was practised");
{
  const fresh = bout([entry()], true);
  noteDrilledThrow(fresh, ACTS);
  check("a throw this week reads as practised now", drilledUpkeepOf(fresh.entries[0]).maintained);

  // The streak counts weeks that have ALREADY rolled over, so the week just
  // gone reads zero and the panel adds one to phrase it as "1 week ago".
  let e = week(entry(), 2);
  check("the week just gone is not still 'this week'", !drilledUpkeepOf(e).maintained);
  check("and reads as one week ago", drilledUpkeepOf(e).dryWeeks + 1 === 1);
  check("with no plus sign", !drilledUpkeepOf(e).dryCapped);
  e = week(e, 0);
  check("another idle week reads as two ago", drilledUpkeepOf(e).dryWeeks + 1 === 2);
  e = week(e, 0);
  check("then three", drilledUpkeepOf(e).dryWeeks + 1 === 3);
  check("still an exact figure", !drilledUpkeepOf(e).dryCapped);

  // A string that first lands twice in one session banks only the SECOND throw:
  // the first is thrown before the entry it would bank against exists. Walk the
  // real creation path rather than hand-building the entry.
  const born = bout([], true);
  noteDrilledThrow(born, ACTS);
  check("the throw that creates a string banks nothing", born.entries.length === 0);
  born.entries = creditDrilledAction(born.entries, ACTS);
  check("its landing opens an unlisted entry", born.entries[0].n === 1);
  noteDrilledThrow(born, ACTS);
  born.entries = creditDrilledAction(born.entries, ACTS);
  check("the second landing lists it", born.entries[0].n === cfg.listThreshold);
  check("and the second throw was banked", (born.entries[0].wu ?? 0) === cfg.maintenanceThrowsPerWeek);
  const settled = advanceDrilledWeek(born.entries)[0];
  check("so a newly listed string never opens as neglected", drilledUpkeepOf(settled).dryWeeks + 1 === 1);
  check("though one lone throw is short of a rung", drilledStaminaMultOf([settled], ACTS) === 3);
}

console.log("8. a single throw resets the whole streak");
{
  let e = week(week(week(entry(), 2), 2), 2);
  e = week(e, 0);
  e = week(e, 0);
  check("two weeks of dust", drilledUpkeepOf(e).dryWeeks === 2);
  e = week(e, 0, 1);
  check("one career throw wipes the streak", drilledUpkeepOf(e).dryWeeks === 0);
  check("and the string is still at half price", drilledStaminaMultOf([e], ACTS) === 0.5);
  check("the full grace is back", drilledUpkeepOf(e).weeksBeforeDecay === 3);
}

console.log("9. reps buy buffer weeks");
{
  check("fifty reps buy one week", drilledDecayBufferWeeks(50) === 1);
  check("forty-nine buy none", drilledDecayBufferWeeks(49) === 0);
  check("a hundred buy two", drilledDecayBufferWeeks(100) === 2);
  check("the buffer is capped", drilledDecayBufferWeeks(10_000_000) === cfg.decayBufferWeeksMax,
    String(drilledDecayBufferWeeks(10_000_000)));
  check("the cap is 999", cfg.decayBufferWeeksMax === 999, String(cfg.decayBufferWeeksMax));
  check("no reps still means three weeks of grace", drilledGraceWeeks(0) === 3);
  check("fifty reps mean four", drilledGraceWeeks(50) === 4);
  check("the cap holds at the ceiling", drilledGraceWeeks(cfg.sharpnessCap) === 3 + drilledDecayBufferWeeks(cfg.sharpnessCap));

  let e = week(week(week(entry({ n: 50 }), 2), 2), 2);
  check("a 50-rep string reaches half price", drilledStaminaMultOf([e], ACTS) === 0.5);
  for (let i = 0; i < 4; i++) e = week(e, 0);
  check("and survives a fourth idle week the raw string would not", drilledStaminaMultOf([e], ACTS) === 0.5);
  e = week(e, 0);
  check("the fifth finally costs it", drilledStaminaMultOf([e], ACTS) === 1);
}

console.log("10. the sharpness cap and the mastery tier agree");
{
  check("the cap is 3000", cfg.sharpnessCap === 3000, String(cfg.sharpnessCap));
  check("mastery sits exactly on the cap", cfg.masterySharpness === cfg.sharpnessCap,
    `${cfg.masterySharpness} vs ${cfg.sharpnessCap}`);
  check("so mastery is reachable", cfg.masterySharpness <= cfg.sharpnessCap);
  const ordered = cfg.listThreshold <= cfg.buffSharpness
    && cfg.buffSharpness <= cfg.sharpTierSharpness
    && cfg.sharpTierSharpness <= cfg.freeStaminaSharpness
    && cfg.freeStaminaSharpness <= cfg.masterySharpness;
  check("the tiers climb in order", ordered,
    `${cfg.listThreshold}/${cfg.buffSharpness}/${cfg.sharpTierSharpness}/${cfg.freeStaminaSharpness}/${cfg.masterySharpness}`);
  check("every tier is still reachable under the cap",
    cfg.masterySharpness <= cfg.sharpnessCap && cfg.dodgeSharpness <= cfg.sharpnessCap,
    `${cfg.dodgeSharpness}/${cfg.masterySharpness} vs ${cfg.sharpnessCap}`);
}

console.log("10b. the five tiers are named in ascending order");
{
  // The labels are what the career panel prints, so their order IS the ladder
  // the player sees. Walk it rung by rung rather than trusting the constants.
  check("below the buffs it is Rough", drilledTierLabel(cfg.buffSharpness - 1) === "Rough",
    drilledTierLabel(cfg.buffSharpness - 1));
  check("the buffs switching on makes it Good", drilledTierLabel(cfg.buffSharpness) === "Good",
    drilledTierLabel(cfg.buffSharpness));
  check("it stays Good until the next rung", drilledTierLabel(cfg.sharpTierSharpness - 1) === "Good");
  check("then Sharp", drilledTierLabel(cfg.sharpTierSharpness) === "Sharp",
    drilledTierLabel(cfg.sharpTierSharpness));
  check("it stays Sharp until the closing punch goes free",
    drilledTierLabel(cfg.freeStaminaSharpness - 1) === "Sharp");
  check("a free closing punch is Effortless", drilledTierLabel(cfg.freeStaminaSharpness) === "Effortless",
    drilledTierLabel(cfg.freeStaminaSharpness));
  check("it stays Effortless right up to the cap",
    drilledTierLabel(cfg.masterySharpness - 1) === "Effortless");
  check("and the cap is Mastered", drilledTierLabel(cfg.masterySharpness) === "Mastered",
    drilledTierLabel(cfg.masterySharpness));
  check("Evasive is gone", ![0, 20, 100, 200, 300, 1000, 3000].some(n => drilledTierLabel(n) === "Evasive"));

  // next-tier arrows must walk the same five rungs, in the same order
  check("Rough points at Good", drilledNextTierAt(0) === cfg.buffSharpness, String(drilledNextTierAt(0)));
  check("Good points at Sharp", drilledNextTierAt(cfg.buffSharpness) === cfg.sharpTierSharpness);
  check("Sharp points at Effortless",
    drilledNextTierAt(cfg.sharpTierSharpness) === cfg.freeStaminaSharpness);
  check("Effortless points at Mastered",
    drilledNextTierAt(cfg.freeStaminaSharpness) === cfg.masterySharpness);
  check("Mastered points nowhere", drilledNextTierAt(cfg.masterySharpness) === null);
}

console.log("10c. the slip window is a mastery perk");
{
  check("the dodge threshold sits exactly on mastery", cfg.dodgeSharpness === cfg.masterySharpness,
    `${cfg.dodgeSharpness} vs ${cfg.masterySharpness}`);
  check("no window one rep short", !drilledClosingBuffs(cfg.masterySharpness - 1).opensDodgeWindow);
  check("nor at the old 300 threshold", !drilledClosingBuffs(300).opensDodgeWindow);
  check("nor anywhere in the Effortless band",
    !drilledClosingBuffs(cfg.freeStaminaSharpness).opensDodgeWindow);
  check("but a mastered string opens it", drilledClosingBuffs(cfg.masterySharpness).opensDodgeWindow);
  check("so the window and mastery arrive together",
    drilledClosingBuffs(cfg.masterySharpness).opensDodgeWindow
      && drilledTierLabel(cfg.masterySharpness) === "Mastered");
  check("the closing punch is still free up there",
    drilledClosingBuffs(cfg.masterySharpness).freeStamina);
  check("the chance is still half", cfg.dodgeChance === 0.5, String(cfg.dodgeChance));
}

console.log("10d. drilled damage is a flat mastery perk with no ramp");
{
  const mastered = drilledClosingBuffs(cfg.masterySharpness);
  const oneShort = drilledClosingBuffs(cfg.masterySharpness - 1);
  const mid = drilledClosingBuffs(cfg.freeStaminaSharpness);
  const light = drilledClosingBuffs(cfg.buffSharpness);
  const none = drilledClosingBuffs(0);

  check("the opener bonus is +20%, i.e. 1.2x", cfg.masteryOpenerPowerBonus === 0.2,
    String(cfg.masteryOpenerPowerBonus));
  check("the closer bonus is +50%, i.e. 1.5x", cfg.masteryCloserPowerBonus === 0.5,
    String(cfg.masteryCloserPowerBonus));
  check("the closer is the bigger of the two",
    cfg.masteryCloserPowerBonus > cfg.masteryOpenerPowerBonus);
  check("nothing drilled is plain damage", drilledPowerMult(null, false) === 1);

  // No ramp: every sharpness below mastery is worth exactly zero extra damage.
  check("a blunt string adds no damage", none.powerBonus === 0, String(none.powerBonus));
  check("nor a freshly listed one", light.powerBonus === 0, String(light.powerBonus));
  check("nor one at the Effortless rung", mid.powerBonus === 0, String(mid.powerBonus));
  check("nor one rep short of mastery", oneShort.powerBonus === 0, String(oneShort.powerBonus));
  check("so they all punch at 1x", [none, light, mid, oneShort]
    .every(b => drilledPowerMult(b, false) === 1));

  // The jump happens exactly at mastery, and it is flat.
  check("mastery makes the closer 1.5x", Math.abs(drilledPowerMult(mastered, false) - 1.5) < 1e-9,
    String(drilledPowerMult(mastered, false)));
  check("and the opener 1.2x", Math.abs(drilledPowerMult(null, true) - 1.2) < 1e-9,
    String(drilledPowerMult(null, true)));
  check("a punch that is BOTH takes the better one, not the sum",
    Math.abs(drilledPowerMult(mastered, true) - 1.5) < 1e-9,
    String(drilledPowerMult(mastered, true)));

  // 1.5x is the ceiling of the whole drilled system. Nothing may exceed it.
  const everySharpness = [0, 1, 19, 20, 99, 100, 199, 200, 299, 300, 999, 2999, 3000, 999999];
  check("1.5x is the ceiling at every sharpness, mastered or not", everySharpness.every(n => {
    const b = drilledClosingBuffs(n);
    return drilledPowerMult(b, false) <= 1.5 + 1e-9 && drilledPowerMult(b, true) <= 1.5 + 1e-9;
  }));
  check("damage never decreases as a string sharpens", everySharpness.every((n, i) =>
    i === 0 || drilledPowerMult(drilledClosingBuffs(n), false)
      >= drilledPowerMult(drilledClosingBuffs(everySharpness[i - 1]), false)));

  // Stun and crit are the halves that DO still ramp -- the contrast is the point.
  check("stun still ramps to its cap", Math.abs(mastered.stunBonus - cfg.stunBonusCap) < 1e-9);
  check("crit still ramps to its cap", Math.abs(mastered.critBonus - cfg.critBonusCap) < 1e-9);
  check("and they are already climbing well below mastery",
    mid.stunBonus > light.stunBonus && mid.critBonus > light.critBonus);

  // The per-rep rate and the ceiling, pinned. Both were cut deliberately; a
  // silent revert to the old +0.25%/+100% would sail past every check above.
  check("stun is +0.05% per rep", cfg.stunPerSuccess === 0.0005, String(cfg.stunPerSuccess));
  check("crit is +0.05% per rep", cfg.critPerSuccess === 0.0005, String(cfg.critPerSuccess));
  check("stun caps at +30%", cfg.stunBonusCap === 0.30, String(cfg.stunBonusCap));
  check("crit caps at +30%", cfg.critBonusCap === 0.30, String(cfg.critBonusCap));
  check("so the caps land at 600 reps, well short of mastery",
    Math.abs(cfg.stunBonusCap / cfg.stunPerSuccess - 600) < 1e-6
      && cfg.stunBonusCap / cfg.stunPerSuccess < cfg.masterySharpness);
  check("nothing exceeds the caps at any sharpness", everySharpness.every(n => {
    const b = drilledClosingBuffs(n);
    return b.stunBonus <= cfg.stunBonusCap + 1e-9 && b.critBonus <= cfg.critBonusCap + 1e-9;
  }));
}

console.log("11. old saves read back clean");
{
  const legacy = normalizeDrilledActions([{ key: KEY, acts: ACTS, n: 40 }]);
  check("a save with no clock reads as unrehearsed", legacy[0].st === 0);
  check("with an empty week", legacy[0].wt === 0 && legacy[0].wu === 0);
  check("and no dry streak", legacy[0].dw === 0);
  check("so it is billed at full price", drilledStaminaMultOf(legacy, ACTS) === 3);
  check("and its reps still count toward the buffer", drilledGraceWeeks(legacy[0].n) === 3);

  const junk = normalizeDrilledActions([
    { key: KEY, acts: ACTS, n: 40, st: -3, wt: -1, wu: -1, dw: -9 } as DrilledActionEntry,
  ]);
  check("a negative rung clamps to the top", junk[0].st === 0);
  check("negative tallies clamp to zero", junk[0].wt === 0 && junk[0].wu === 0);
  check("a negative streak clamps to zero", junk[0].dw === 0);

  const over = normalizeDrilledActions([
    { key: KEY, acts: ACTS, n: 40, st: 99, wt: 99, wu: 99, dw: 4 } as DrilledActionEntry,
  ]);
  check("a rung past the floor clamps to the floor", over[0].st === TOP, String(over[0].st));
  check("an inflated sparring tally clamps to the quota", over[0].wt === cfg.practiceThrowsPerWeek);
  check("an inflated maintenance tally clamps to its bar", over[0].wu === cfg.maintenanceThrowsPerWeek);
}

console.log("12. banking a throw is idempotent past the bar");
{
  const ds = bout([entry()], true);
  for (let i = 0; i < 20; i++) noteDrilledThrow(ds, ACTS);
  check("the sparring tally stops at the quota", ds.entries[0].wt === cfg.practiceThrowsPerWeek, String(ds.entries[0].wt));
  check("the maintenance tally stops at its bar", ds.entries[0].wu === cfg.maintenanceThrowsPerWeek, String(ds.entries[0].wu));

  const unknown = bout([], true);
  noteDrilledThrow(unknown, ACTS);
  check("a string with no entry is not created by throwing it", unknown.entries.length === 0);
  check("and nothing is marked dirty", !unknown.dirty);

  const full = bout([entry({ wt: cfg.practiceThrowsPerWeek, wu: cfg.maintenanceThrowsPerWeek })], true);
  noteDrilledThrow(full, ACTS);
  check("a throw with both bars met writes nothing", !full.dirty);
}

console.log(failures === 0 ? "\nAll drilled upkeep checks passed.\n" : `\n${failures} drilled upkeep check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
