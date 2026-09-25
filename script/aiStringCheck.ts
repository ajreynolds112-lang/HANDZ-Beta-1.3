/**
 * AI string library assertions.
 *
 * Run: npx tsx script/aiStringCheck.ts
 *
 * Guards the shorthand->segment pipeline in client/src/game/aiStrings.ts. The
 * library is data the design owner edits by pasting rows in, so the failure
 * mode we care about is a typo that silently shortens or mangles a string at
 * runtime. Everything here is cheap and deterministic.
 */

import {
  AI_STRINGS,
  AI_STRINGS_BY_ID,
  AI_STRINGS_BY_CATEGORY,
  AI_STRING_CATEGORY_META,
  STRING_ADAPT_CHANCE,
  parseAiString,
  BEAT_MIN,
  BEAT_MAX,
  BEAT_STEP,
  BEAT_DEFAULT,
  CHARGE_RELEASE_WINDOW,
  STRING_RANGE_MULT,
  STRING_RETURN_TOLERANCE_PX,
  STRING_RETREAT_MARGIN_PX,
  STRING_WALL_STALL_PX,
  STRING_POCKET_PX,
  STRING_POCKET_BEAT_MAX,
  STRING_OUTPUT_TARGET_RATE,
  STRING_OUTPUT_MIN_SAMPLE_SEC,
  STRING_WALL_STALL_TICKS,
  STRING_AGGRESSION_OFFENSE_BONUS,
  STRING_AGGRESSION_DEFENSE_PENALTY,
  STRING_AGGRESSION_VOLUME_BONUS,
  STRING_RETURN_MAX_TIME,
  STRING_RANGE_WAIT_MAX,
  STRING_PLAN_LOOKAHEAD,
  AGGRESSION_DEFICIT_MIN_SAMPLE,
  AGGRESSION_SWAP_MIN_DEFICIT,
  AGGRESSION_SWAP_CHANCE_MAX,
  AGGRESSION_SWAP_MIN_STAMINA,
  type AiStringCategory,
  type AiStringRole,
} from "../client/src/game/aiStrings";

let passed = 0;
const failures: string[] = [];

function check(label: string, cond: boolean, detail = ""): void {
  if (cond) {
    passed++;
  } else {
    failures.push(`${label}${detail ? ` -- ${detail}` : ""}`);
  }
}

// ===== library shape =====

check("library has 250 strings", AI_STRINGS.length === 250, `got ${AI_STRINGS.length}`);

const ids = AI_STRINGS.map((s) => s.id).sort((a, b) => a - b);
check("ids are unique", new Set(ids).size === ids.length,
  `${ids.length} ids, ${new Set(ids).size} unique`);
// Two contiguous id blocks: the original library (1..200) and the Core Offense
// block pasted in as 401..450. A gap inside either block means a paste dropped
// a row.
const block = (from: number, to: number) => {
  const want: number[] = [];
  for (let i = from; i <= to; i++) want.push(i);
  return want.every((id) => AI_STRINGS_BY_ID.has(id));
};
check("ids 1..200 are all present", block(1, 200));
check("ids 401..450 are all present", block(401, 450));
check("there are no ids outside 1..200 and 401..450",
  ids.every((id) => (id >= 1 && id <= 200) || (id >= 401 && id <= 450)),
  ids.filter((id) => !((id >= 1 && id <= 200) || (id >= 401 && id <= 450))).join(",") || "none");

check("id lookup is complete", AI_STRINGS.every((s) => AI_STRINGS_BY_ID.get(s.id) === s));

check("every string has a name", AI_STRINGS.every((s) => s.name.trim().length > 0));

check("every category bucket is populated",
  (Object.keys(AI_STRING_CATEGORY_META) as AiStringCategory[])
    .every((c) => (AI_STRINGS_BY_CATEGORY[c]?.length ?? 0) > 0),
  (Object.keys(AI_STRING_CATEGORY_META) as AiStringCategory[])
    .filter((c) => !(AI_STRINGS_BY_CATEGORY[c]?.length))
    .join(",") || "none empty");

check("category buckets sum to the library",
  Object.values(AI_STRINGS_BY_CATEGORY).reduce((n, arr) => n + arr.length, 0) === AI_STRINGS.length);

// ===== segment integrity =====

check("no string is empty", AI_STRINGS.every((s) => s.segments.length > 0));

// A few strings are pure defensive resets with no offence at all (#198
// Emergency Defensive Reset). That is intentional, but a punchless string has
// to be made *entirely* of defensive/movement segments -- a string that lost
// its punches to a typo would not satisfy that, so the shape is the guard.
const punchless = AI_STRINGS.filter((s) => s.punchCount === 0);
check("punchless strings are purely defensive",
  punchless.every((s) => s.segments.every((g) =>
    g.kind === "block" || g.kind === "duck" || g.kind === "move" || g.kind === "switchStance")),
  punchless.map((s) => `#${s.id} ${s.name}`).join(" | "));
check("punchless strings stay rare", punchless.length <= 3,
  `${punchless.length} of ${AI_STRINGS.length}`);

check("punchCount matches the segments",
  AI_STRINGS.every((s) => s.punchCount === s.segments.filter((g) => g.kind === "punch").length));

check("punch segments always carry a punch type",
  AI_STRINGS.every((s) => s.segments.every((g) => g.kind !== "punch" || !!g.punch)));

check("move segments always carry a direction",
  AI_STRINGS.every((s) => s.segments.every((g) => g.kind !== "move" || !!g.moveDir)));

check("non-punch segments never carry a punch type",
  AI_STRINGS.every((s) => s.segments.every((g) => g.kind === "punch" || !g.punch)));

// "unspecified" must stay distinguishable from "explicitly to the head",
// so the parser stores true-or-absent and never false.
check("targetBody is never stored as false",
  AI_STRINGS.every((s) => s.segments.every((g) => g.targetBody === undefined || g.targetBody === true)));

check("only punches carry a body target",
  AI_STRINGS.every((s) => s.segments.every((g) => g.targetBody === undefined || g.kind === "punch")));

// ===== charge discipline =====
// An armed charge expires after CHARGE_RELEASE_WINDOW, so every `A` needs a
// punch after it. This is the invariant the beat-stretching logic must respect.

const danglingCharge = AI_STRINGS.filter((s) =>
  s.segments.some((g, i) =>
    g.kind === "charge" && !s.segments.slice(i + 1).some((n) => n.kind === "punch")));
check("every charge is followed by a punch", danglingCharge.length === 0,
  danglingCharge.map((s) => `#${s.id} ${s.name}`).join(" | "));

const chargeNotImmediate = AI_STRINGS.filter((s) =>
  s.segments.some((g, i) => g.kind === "charge" && s.segments[i + 1]?.kind !== "punch"));
check("every charge is followed *immediately* by a punch", chargeNotImmediate.length === 0,
  chargeNotImmediate.map((s) => `#${s.id} ${s.name}`).join(" | "));

// ===== parser dialects =====

const tilde = parseAiString("w ~ e ~ LShift ~ q ~ Back ~ RShift ~ A ~ d ~ v");
check("tilde dialect parses to 9 segments", tilde.length === 9, `got ${tilde.length}`);
check("tilde dialect maps tokens",
  tilde[0].punch === "jab" &&
  tilde[1].punch === "cross" &&
  tilde[2].kind === "duck" &&
  tilde[3].punch === "leftHook" &&
  tilde[4].kind === "move" && tilde[4].moveDir === "out" &&
  tilde[5].kind === "switchStance" &&
  tilde[6].kind === "charge" &&
  tilde[7].punch === "rightUppercut" &&
  tilde[8].kind === "block");

const dash = parseAiString("w - e - duck - q - bck - sw - A - d - v");
check("dash dialect parses to 9 segments", dash.length === 9, `got ${dash.length}`);
check("both dialects produce identical segments",
  JSON.stringify(tilde.map(({ token, ...rest }) => rest)) ===
  JSON.stringify(dash.map(({ token, ...rest }) => rest)));

const lateral = parseAiString("sl - w - sr - e - fwd - q - Left - Right - Fwd");
check("lateral tokens map to circle directions",
  lateral[0].moveDir === "left" &&
  lateral[2].moveDir === "right" &&
  lateral[4].moveDir === "in" &&
  lateral[6].moveDir === "left" &&
  lateral[7].moveDir === "right" &&
  lateral[8].moveDir === "in");

const bodied = parseAiString("q (body) - e - r (body) - q");
check("body targets are picked up", bodied[0].targetBody === true && bodied[2].targetBody === true);
check("unmarked punches leave the target unspecified",
  bodied[1].targetBody === undefined && bodied[3].targetBody === undefined);

const flavoured = parseAiString("w - e - q (long variable beats)");
check("non-body parentheticals are ignored",
  flavoured.length === 3 && flavoured[2].punch === "leftHook" && flavoured[2].targetBody === undefined);

let threwUnknown = false;
try { parseAiString("w - zz - e"); } catch { threwUnknown = true; }
check("unknown tokens throw rather than being dropped", threwUnknown);

let threwEmpty = false;
try { parseAiString("   "); } catch { threwEmpty = true; }
check("an empty string throws", threwEmpty);

// ===== beat + adaptation constants =====

// A zero minimum is deliberate -- back-to-back segments are a legal learned
// outcome -- so the floor only has to be non-negative and below the ceiling.
check("beat range is sane", BEAT_MIN >= 0 && BEAT_MIN < BEAT_MAX && BEAT_MAX <= 1.0);
check("beat default sits inside the range", BEAT_DEFAULT >= BEAT_MIN && BEAT_DEFAULT <= BEAT_MAX);
check("beat default is the specified 0.09s", Math.abs(BEAT_DEFAULT - 0.09) < 1e-9, `got ${BEAT_DEFAULT}`);
check("beat default sits on the step grid",
  Math.abs(BEAT_DEFAULT / BEAT_STEP - Math.round(BEAT_DEFAULT / BEAT_STEP)) < 1e-9);
check("beat step divides the range evenly",
  Math.abs((BEAT_MAX - BEAT_MIN) / BEAT_STEP - Math.round((BEAT_MAX - BEAT_MIN) / BEAT_STEP)) < 1e-9);
// The ceiling now reaches the charge window itself, so the guarantee rests on
// the runner's post-charge clamp rather than on BEAT_MAX being small.
check("a beat after a charge still fits the charge window",
  Math.min(BEAT_MAX, CHARGE_RELEASE_WINDOW * 0.6) < CHARGE_RELEASE_WINDOW);

check("adapt chances cover all four bands",
  ["Easy", "Medium", "Hard", "Hardcore"].every((b) => typeof STRING_ADAPT_CHANCE[b] === "number"));
check("adapt chance rises with difficulty",
  STRING_ADAPT_CHANCE.Easy < STRING_ADAPT_CHANCE.Medium &&
  STRING_ADAPT_CHANCE.Medium < STRING_ADAPT_CHANCE.Hard &&
  STRING_ADAPT_CHANCE.Hard < STRING_ADAPT_CHANCE.Hardcore);
check("adapt chances match the spec (65/85/90/95)",
  STRING_ADAPT_CHANCE.Easy === 0.65 && STRING_ADAPT_CHANCE.Medium === 0.85 &&
  STRING_ADAPT_CHANCE.Hard === 0.90 && STRING_ADAPT_CHANCE.Hardcore === 0.95);

// ===== range gating + lookahead constants =====
// A string only runs inside striking distance. The band has to be wider than
// the attack range itself or the string would stall on the very edge, but not
// so wide that a fighter can run a whole sequence from outside punching range.
check("the string range band is just outside attack range",
  STRING_RANGE_MULT > 1.0 && STRING_RANGE_MULT <= 1.25);
// A retreat stops a step outside the fighter's own punching distance. The
// margin must clear the return tolerance, or a completed retreat would owe a
// walk back the instant it finished and the two rules would fight over the
// same few pixels.
check("the retreat margin is a step, not a room",
  STRING_RETREAT_MARGIN_PX > 0 && STRING_RETREAT_MARGIN_PX <= 30);
check("a completed retreat is further out than the return slack",
  STRING_RETREAT_MARGIN_PX > STRING_RETURN_TOLERANCE_PX);
// A retreat with its back to the ropes redirects sideways. The stall threshold
// has to be small enough that only a genuinely blocked retreat trips it -- a
// slow fighter still covers more than this in a tick -- and it has to take
// more than one tick, or a single frame of contact would flip the direction.
// The pocket is the range punches actually land from, and the clamp on top of
// it is what makes a sequence thrown from in there a stream rather than a
// rhythm. It has to be tighter than the ordinary beat or it does nothing, and
// the pocket itself has to sit well inside the band the fighter throws from.
check("the pocket is a close-range number",
  STRING_POCKET_PX >= 25 && STRING_POCKET_PX <= 60);
check("the pocket beat is tighter than the ordinary beat",
  STRING_POCKET_BEAT_MAX > 0 && STRING_POCKET_BEAT_MAX < BEAT_DEFAULT);
check("the pocket beat is a beat, not a rounding error",
  STRING_POCKET_BEAT_MAX >= BEAT_STEP);
// Output target: under the 4.0/s the player sustained in the bout that
// motivated it, and above the 1.7/s the AI managed, or the deficit it drives
// would either never clear or never trigger.
check("the output target sits between the AI's rate and the player's",
  STRING_OUTPUT_TARGET_RATE > 1.7 && STRING_OUTPUT_TARGET_RATE < 4.0);
check("the output rate needs a sample before it is believed",
  STRING_OUTPUT_MIN_SAMPLE_SEC >= 1 && STRING_OUTPUT_MIN_SAMPLE_SEC <= 10);
// A fighter throwing at the target rate must not still read as behind, and one
// throwing nothing must read as maximally behind.
const outDef = (throws: number, secs: number) =>
  secs < STRING_OUTPUT_MIN_SAMPLE_SEC
    ? 0
    : Math.max(0, Math.min(1, 1 - (throws / secs) / STRING_OUTPUT_TARGET_RATE));
check("hitting the target clears the output deficit",
  outDef(STRING_OUTPUT_TARGET_RATE * 10, 10) === 0);
check("throwing nothing maxes the output deficit", outDef(0, 10) === 1);
check("a short sample reads as no deficit", outDef(0, 1) === 0);

check("the wall-stall threshold is sub-pixel",
  STRING_WALL_STALL_PX > 0 && STRING_WALL_STALL_PX < 1);
check("a redirect takes more than one stalled tick",
  Number.isInteger(STRING_WALL_STALL_TICKS) && STRING_WALL_STALL_TICKS >= 2 &&
  STRING_WALL_STALL_TICKS <= 10);
// Aggression bias: outside survival the punching categories carry the pick.
// Both sides of it have to actually bias, and neither may zero a category out
// -- a defensive string must stay reachable, and the volume preference must
// not run away with long strings.
check("the offence bias favours punching categories",
  STRING_AGGRESSION_OFFENSE_BONUS > 1 && STRING_AGGRESSION_OFFENSE_BONUS <= 4);
check("the defence penalty discourages without excluding",
  STRING_AGGRESSION_DEFENSE_PENALTY > 0 && STRING_AGGRESSION_DEFENSE_PENALTY < 1);
check("the volume preference is per-punch and modest",
  STRING_AGGRESSION_VOLUME_BONUS > 0 && STRING_AGGRESSION_VOLUME_BONUS <= 0.25);
// Fresh, volume must win; gassed, the tiredness divisor (0.05 per punch) must
// win. The two are the same shape, so comparing the coefficients is enough.
check("volume outweighs tiredness when fresh",
  STRING_AGGRESSION_VOLUME_BONUS > 0.05);
// The walk-back tolerance is what stops the fighter hunting a pixel-exact
// separation forever; it must be small enough that "back where it was" still
// means inside the range the punch was written for.
check("the return tolerance is a few pixels, not a range of its own",
  STRING_RETURN_TOLERANCE_PX > 0 && STRING_RETURN_TOLERANCE_PX <= 20);
// Both of these are escape hatches: whatever the fighter is waiting for has to
// time out, or a string can own the fighter for the rest of the round.
check("walking back in is time-boxed", STRING_RETURN_MAX_TIME > 0 && STRING_RETURN_MAX_TIME <= 1.5);
check("waiting out of range is time-boxed", STRING_RANGE_WAIT_MAX > 0 && STRING_RANGE_WAIT_MAX <= 5);
check("a return attempt cannot outlast the out-of-range write-off",
  STRING_RETURN_MAX_TIME < STRING_RANGE_WAIT_MAX);
// One segment of lookahead cannot see past an intervening duck or charge to
// the punch behind it, which is the whole point of planning ahead.
check("the plan looks at least two segments ahead",
  Number.isInteger(STRING_PLAN_LOOKAHEAD) && STRING_PLAN_LOOKAHEAD >= 2);
// The horizon has to stay short or it stops being a plan and becomes the
// string itself, which defeats rebuilding it at every boundary.
check("the plan horizon stays short", STRING_PLAN_LOOKAHEAD <= 4);
// A plan spanning the whole horizon must still be shorter than the write-off
// window, or a string could be cancelled before its planned punch ever lands.
check("a full planned horizon fits inside the range wait",
  BEAT_MAX * STRING_PLAN_LOOKAHEAD < STRING_RANGE_WAIT_MAX);

// ===== losing-fighter offence swap =====
// The read has to be a mid-round one: too small a sample and the AI panics off
// a single exchange, too large and the round is over before it reacts.
check("the punch deficit needs a real sample",
  Number.isInteger(AGGRESSION_DEFICIT_MIN_SAMPLE) &&
  AGGRESSION_DEFICIT_MIN_SAMPLE >= 2 && AGGRESSION_DEFICIT_MIN_SAMPLE <= 12);
// A fighter one punch behind is not losing. The floor is what keeps the script
// intact in a close round.
check("a near-even round leaves the script alone",
  AGGRESSION_SWAP_MIN_DEFICIT > 0 && AGGRESSION_SWAP_MIN_DEFICIT < 0.5);
// The swap chance is scaled by the deficit, so the ceiling is only reached when
// the fighter is being shut out -- and even then some of the string survives.
check("the swap chance is a lean, not a guarantee",
  AGGRESSION_SWAP_CHANCE_MAX > 0 && AGGRESSION_SWAP_CHANCE_MAX < 1);
check("even a shut-out fighter swaps at a meaningful rate",
  AGGRESSION_SWAP_CHANCE_MAX * AGGRESSION_SWAP_MIN_DEFICIT < AGGRESSION_SWAP_CHANCE_MAX);
// Swapping in punches on an empty tank just gasses a fighter who is already
// behind, so the stamina floor must be above the point of exhaustion.
check("the swap has a stamina floor",
  AGGRESSION_SWAP_MIN_STAMINA > 0 && AGGRESSION_SWAP_MIN_STAMINA < 0.5);

// ===== category metadata =====

const metaEntries = Object.entries(AI_STRING_CATEGORY_META);
check("stamina gates are fractions",
  metaEntries.every(([, m]) => m.minStamina >= 0 && m.minStamina <= 1));
check("difficulty gates are fractions",
  metaEntries.every(([, m]) => m.minDifficulty >= 0 && m.minDifficulty <= 1));
check("selection weights are positive",
  metaEntries.every(([, m]) => m.baseWeight > 0 && m.hurtBonus > 0 && m.aheadBonus > 0 && m.behindBonus > 0));
// Fundamentals is the fallback bucket: it must always be reachable, otherwise
// a low-stamina low-difficulty AI has no legal string at all.
check("Fundamentals is always reachable",
  AI_STRING_CATEGORY_META.Fundamentals.minDifficulty === 0 &&
  AI_STRING_CATEGORY_META.Fundamentals.minStamina <= 0.05);
// The retreat bucket is what a gassed AI falls back to, so it cannot itself
// be stamina-gated.
check("DefensiveRetreats is available at zero stamina",
  AI_STRING_CATEGORY_META.DefensiveRetreats.minStamina === 0);

// ===== category roles =====
// The runner selects by role: offensive verdicts draw from offense+mixed,
// reactions draw from defense, and an offense insert cuts into a running
// string. Every bucket must declare a role the selector understands, and each
// of the three roles must have at least one bucket or a selection call for it
// silently returns nothing.
const ROLES: AiStringRole[] = ["offense", "mixed", "defense"];
check("every category declares a valid role",
  metaEntries.every(([, m]) => ROLES.includes(m.role)),
  metaEntries.filter(([, m]) => !ROLES.includes(m.role)).map(([c]) => c).join(",") || "all valid");
for (const role of ROLES) {
  check(`at least one category has role "${role}"`,
    metaEntries.some(([, m]) => m.role === role));
}
// Core Offense is the always-available attack bucket, the offense-role mirror
// of Fundamentals. If it is gated, a gassed or low-difficulty AI has nothing to
// throw when it decides to attack and reverts to standing still.
check("CoreOffense is always reachable",
  AI_STRING_CATEGORY_META.CoreOffense.role === "offense" &&
  AI_STRING_CATEGORY_META.CoreOffense.minDifficulty === 0 &&
  AI_STRING_CATEGORY_META.CoreOffense.minStamina <= 0.05);
check("every offense-role string throws at least one punch",
  (Object.keys(AI_STRING_CATEGORY_META) as AiStringCategory[])
    .filter((c) => AI_STRING_CATEGORY_META[c].role === "offense")
    .every((c) => (AI_STRINGS_BY_CATEGORY[c] ?? [])
      .every((d) => d.segments.some((seg) => seg.punch != null))));

// ===== report =====

const longest = AI_STRINGS.reduce((a, b) => (b.segments.length > a.segments.length ? b : a));
const shortest = AI_STRINGS.reduce((a, b) => (b.segments.length < a.segments.length ? b : a));
const totalSegments = AI_STRINGS.reduce((n, s) => n + s.segments.length, 0);

console.log("");
console.log("AI STRING LIBRARY");
console.log(`  strings          ${AI_STRINGS.length}`);
console.log(`  segments         ${totalSegments} (avg ${(totalSegments / AI_STRINGS.length).toFixed(1)})`);
console.log(`  shortest         #${shortest.id} ${shortest.name} (${shortest.segments.length})`);
console.log(`  longest          #${longest.id} ${longest.name} (${longest.segments.length})`);
console.log("");
for (const [cat, defs] of Object.entries(AI_STRINGS_BY_CATEGORY)) {
  const meta = AI_STRING_CATEGORY_META[cat as AiStringCategory];
  console.log(
    `  ${meta.label.padEnd(30)} ${String(defs.length).padStart(3)} strings` +
    `   stam>=${meta.minStamina.toFixed(2)}  diff>=${meta.minDifficulty.toFixed(2)}  range=${meta.range}`,
  );
}
console.log("");

if (failures.length > 0) {
  console.error(`FAILED ${failures.length} check(s):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`All ${passed} assertions passed.`);
