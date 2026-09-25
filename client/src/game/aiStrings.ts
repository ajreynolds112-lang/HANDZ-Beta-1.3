/**
 * AI STRING LIBRARY
 * =================
 * The 200 canonical attack/defence strings the AI can execute, plus the parser
 * that turns their shorthand notation into executable segments.
 *
 * NOTATION
 * --------
 * Two dialects are accepted so strings can be pasted in from either source
 * format without rewriting them:
 *
 *   punches      w = jab            e = cross
 *                q = left hook      r = right hook
 *                s = left uppercut  d = right uppercut
 *   actions      v = perfect block  A = arm charge
 *   duck         LShift | duck
 *   switch       RShift | sw
 *   movement     Fwd|fwd = step in       Back|bck = step out
 *                Left|sl = circle left   Right|sr = circle right
 *
 * Segments are separated by `~` or `-` (both mean "one beat apart"). A punch
 * may carry an explicit `(body)` target; any other parenthetical is flavour
 * text and is ignored. Anything not listed above fails to parse loudly rather
 * than being silently dropped.
 *
 * THE BEAT
 * --------
 * `~` is the beat: a dynamic inter-segment delay between BEAT_MIN and BEAT_MAX,
 * adjusted in BEAT_STEP increments. It tightens toward the minimum when a
 * segment lands and stretches when it whiffs. Beat timing is runtime state and
 * lives on the brain, not here -- this module is pure data.
 *
 * ADDING STRINGS
 * --------------
 * Append a row to AI_STRING_SOURCE with the next free id and a category from
 * AiStringCategory. `npx tsx script/aiStringCheck.ts` validates the whole
 * library, so a malformed row is caught before it can reach a fight.
 */

import type { PunchType } from "./types";

export type AiSegmentKind =
  | "punch"
  | "block"
  | "charge"
  | "duck"
  | "switchStance"
  | "move";

/** Movement relative to the opponent, not to the ring. */
export type AiMoveDir = "in" | "out" | "left" | "right";

export interface AiSegment {
  kind: AiSegmentKind;
  /** Set when kind === "punch". */
  punch?: PunchType;
  /**
   * true  -> the string explicitly calls for a body shot.
   * undefined -> unspecified; the AI's own head/body read decides at runtime.
   * We deliberately never store `false`, so "not specified" and "explicitly to
   * the head" stay distinguishable.
   */
  targetBody?: boolean;
  /** Set when kind === "move". */
  moveDir?: AiMoveDir;
  /** Original token, kept for debug overlays and logs. */
  token: string;
}

export type AiStringCategory =
  | "CoreOffense"
  | "Fundamentals"
  | "CounterTraps"
  | "InFighting"
  | "Shifting"
  | "ChargeSetups"
  | "DefensiveRetreats"
  | "HighVolume"
  | "EliteIQ"
  | "ExtendedAdaptive"
  | "MasterSequences"
  | "AdvancedPatterns"
  | "EliteHyperAdaptive";

export interface AiStringDef {
  id: number;
  name: string;
  category: AiStringCategory;
  /** Source notation, preserved verbatim for debugging and round-tripping. */
  raw: string;
  segments: AiSegment[];
  /** Count of punch segments -- used by the selector to gauge stamina cost. */
  punchCount: number;
  /**
   * How many of those punches are hooks or uppercuts. The engine pays 1.15x for
   * them inside the pocket and docks straights 0.85x there, and reverses that
   * at range, so the selector reads this to stop the AI running a jab-cross
   * sequence from the one distance where those are the worst thing it owns.
   */
  hookUpperCount: number;
}

// ===== BEAT CONSTANTS =====

/**
 * Tightest a beat can become after repeated hit-confirms. Zero is legal: the
 * next segment then fires on the following tick, which is how a fully learned
 * string runs its punches back to back.
 */
export const BEAT_MIN = 0;
/** Loosest a beat can become after repeated whiffs. */
export const BEAT_MAX = 1.0;
/** Granularity of every beat adjustment. */
export const BEAT_STEP = 0.005;
/** Where an unlearned beat starts. */
export const BEAT_DEFAULT = 0.09;

/**
 * How far outside its own attack range a fighter will still run a string.
 * Beyond this the current segment ends immediately and the string parks with
 * its place kept until the fighter has closed back in. Without this a string
 * full of movement walks the fight apart and the AI never re-engages.
 */
export const STRING_RANGE_MULT = 1.10;

/**
 * How far past its own real punching distance a fighter retreats on an "out"
 * move. A step outside where its punches can land is the whole point of the
 * segment; anything beyond that is walking out of the fight and buys nothing,
 * since the string then spends its next segments trudging back in.
 */
export const STRING_RETREAT_MARGIN_PX = 8;

/**
 * Ground (px) a retreat must make in a tick to count as moving. Below this it
 * is being held up by something -- in practice the ring edge.
 */
export const STRING_WALL_STALL_PX = 0.35;

/**
 * The pocket: the separation a fighter actually touches someone from.
 *
 * Measured off a real bout rather than guessed. Inside 40px the player landed
 * 16 of 20 punches; from 60-80px, where the AI was throwing half of its shots,
 * it landed 2 of 11. Distance was doing more for the player's connect rate than
 * punch choice or targeting ever did, so the strings chase the same number.
 */
export const STRING_POCKET_PX = 42;

/**
 * How far past the pocket an assault will still refuse to give ground. Beyond
 * this the fighter is no longer in a phone-booth exchange and a retreat beat
 * means what it says.
 */
export const STRING_POCKET_HOLD_MULT = 1.6;

/**
 * Beat ceiling for a punch thrown from inside the pocket. Up close a sequence
 * stops being a rhythm and becomes a stream: the same bout has the player at a
 * 186ms median gap with a tenth of the punches under 120ms, which is the
 * animation pacing itself rather than any deliberate spacing. Clamping the beat
 * this low hands that pacing back to the engine.
 */
export const STRING_POCKET_BEAT_MAX = 0.05;

/**
 * Punches per second of in-range time the strings aim to sustain. The player
 * managed 4.0 across the bout that motivated this; the AI managed 1.7. The
 * target sits under the player's so the AI still spends time defending.
 */
export const STRING_OUTPUT_TARGET_RATE = 3.0;

/** In-range seconds before the output rate is worth reading at all. */
export const STRING_OUTPUT_MIN_SAMPLE_SEC = 2.0;

/** Stalled ticks before a retreat gives up on backwards and goes sideways. */
export const STRING_WALL_STALL_TICKS = 3;

/**
 * Selection bias applied outside survival. A fighter with gas in the tank is
 * there to score, so the punching categories carry the pick and the defensive
 * sequences are what it has to be talked into.
 */
export const STRING_AGGRESSION_OFFENSE_BONUS = 2.2;
export const STRING_AGGRESSION_DEFENSE_PENALTY = 0.35;
/**
 * Per-punch preference for volume, scaled by how much gas is left. This is the
 * counterweight to the tiredness penalty further down the same calculation:
 * fresh, the long punching strings win; tired, they stop being affordable.
 */
export const STRING_AGGRESSION_VOLUME_BONUS = 0.10;

/**
 * How hard the pocket read moves selection toward hook/uppercut strings up
 * close, and toward straight-punch ones at range. Deliberately larger than the
 * engine's own +-15% inside modifiers: the point is to change which string gets
 * picked, not to shave a few percent off the weight of the wrong one.
 */
export const STRING_RANGE_PUNCH_BIAS = 0.8;

/** Slack (px) when re-closing to the separation a move segment left from. */
export const STRING_RETURN_TOLERANCE_PX = 6;

/** Longest a string spends walking back in before it throws from where it is. */
export const STRING_RETURN_MAX_TIME = 0.6;

/** Longest a string waits out of range before it is written off. */
export const STRING_RANGE_WAIT_MAX = 2.5;

/**
 * How many segments past the current one the runner plans. Two is enough to
 * let a move be shaped by the punch behind it while still being cheap to
 * rebuild at every boundary, which is what keeps the plan adjustable.
 */
export const STRING_PLAN_LOOKAHEAD = 2;
/**
 * Landed punches (both sides, this round) before a punch deficit is believed.
 * Early in a round one exchange means nothing; this is what makes the read a
 * mid-round one rather than a reaction to the first shot of the round.
 */
export const AGGRESSION_DEFICIT_MIN_SAMPLE = 4;

/** Deficit below which the AI is close enough to even to keep to the script. */
export const AGGRESSION_SWAP_MIN_DEFICIT = 0.15;

/**
 * Chance, at a total punch deficit, that a non-punching segment is replaced by
 * a punch. Scaled by how far behind the fighter actually is, so a fighter being
 * shut out throws the script away while one narrowly behind mostly keeps it.
 */
export const AGGRESSION_SWAP_CHANCE_MAX = 0.6;

/** No amount of losing makes it worth swapping in punches on an empty tank. */
export const AGGRESSION_SWAP_MIN_STAMINA = 0.15;

/**
 * An armed charge must be released within this window, so a beat that follows
 * an `A` segment is clamped below it no matter how much it has stretched.
 */
export const CHARGE_RELEASE_WINDOW = 1.0;

/**
 * Per-band chance that the AI adapts its beats/segments after a resolved
 * string. Keyed by the engine's internal difficulty bands; the names in the
 * design spec map on as Journeyman/Contender/Elite/Champion.
 */
export const STRING_ADAPT_CHANCE: Record<string, number> = {
  Easy: 0.65,      // Journeyman
  Medium: 0.85,    // Contender
  Hard: 0.90,      // Elite
  Hardcore: 0.95,  // Champion
};

// ===== CATEGORY SELECTION METADATA =====

/**
 * What a category is *for*. The AI attacks with `offense` and `mixed` strings,
 * reacts with `defense` strings, and cuts back out of a defensive string into
 * an offensive one when it decides to throw again.
 */
export type AiStringRole = "offense" | "mixed" | "defense";

export interface AiStringCategoryMeta {
  label: string;
  /** Whether this category is offence, defence, or a blend of both. */
  role: AiStringRole;
  /** Minimum AI stamina fraction required to *start* a string from this category. */
  minStamina: number;
  /** Minimum difficultyScore (0..1) before the category unlocks at all. */
  minDifficulty: number;
  /** Preferred engagement range. */
  range: "in" | "mid" | "out" | "any";
  /** Selection weight multiplier when the opponent is hurt or stunned. */
  hurtBonus: number;
  /** Selection weight multiplier when the AI is ahead on the cards. */
  aheadBonus: number;
  /** Selection weight multiplier when the AI is behind on the cards. */
  behindBonus: number;
  /** Baseline selection weight. */
  baseWeight: number;
}

export const AI_STRING_CATEGORY_META: Record<AiStringCategory, AiStringCategoryMeta> = {
  // The AI's bread-and-butter offence: short, purely offensive punching
  // sequences with effectively no gates, so there is always something to throw
  // and the default answer to "should I punch" is a real combination.
  CoreOffense:        { label: "Core Offense", role: "offense",                  minStamina: 0.02, minDifficulty: 0.00, range: "any", hurtBonus: 1.5, aheadBonus: 1.0, behindBonus: 1.2, baseWeight: 3.00 },
  Fundamentals:       { label: "Fundamentals & Probing", role: "mixed",        minStamina: 0.05, minDifficulty: 0.00, range: "any", hurtBonus: 1.0, aheadBonus: 1.0, behindBonus: 1.0, baseWeight: 1.00 },
  CounterTraps:       { label: "Counter Traps", role: "mixed",                 minStamina: 0.15, minDifficulty: 0.15, range: "mid", hurtBonus: 1.0, aheadBonus: 1.2, behindBonus: 1.2, baseWeight: 0.85 },
  InFighting:         { label: "Infighting & Body Work", role: "mixed",        minStamina: 0.45, minDifficulty: 0.30, range: "in",  hurtBonus: 2.0, aheadBonus: 1.0, behindBonus: 1.3, baseWeight: 0.70 },
  Shifting:           { label: "Shifting & Angle Creation", role: "mixed",     minStamina: 0.25, minDifficulty: 0.40, range: "mid", hurtBonus: 1.0, aheadBonus: 1.1, behindBonus: 1.2, baseWeight: 0.65 },
  ChargeSetups:       { label: "Charge Setups", role: "mixed",                 minStamina: 0.30, minDifficulty: 0.35, range: "mid", hurtBonus: 1.5, aheadBonus: 1.0, behindBonus: 1.4, baseWeight: 0.60 },
  DefensiveRetreats:  { label: "Phased Defensive Retreats", role: "defense",     minStamina: 0.00, minDifficulty: 0.20, range: "out", hurtBonus: 0.4, aheadBonus: 1.8, behindBonus: 0.6, baseWeight: 0.55 },
  HighVolume:         { label: "High-Volume Finishing", role: "offense",         minStamina: 0.50, minDifficulty: 0.30, range: "in",  hurtBonus: 3.0, aheadBonus: 1.1, behindBonus: 1.5, baseWeight: 0.35 },
  EliteIQ:            { label: "Elite Ring Generalship", role: "mixed",        minStamina: 0.30, minDifficulty: 0.60, range: "any", hurtBonus: 1.2, aheadBonus: 1.2, behindBonus: 1.2, baseWeight: 0.50 },
  ExtendedAdaptive:   { label: "Extended Adaptive Sequences", role: "mixed",   minStamina: 0.40, minDifficulty: 0.70, range: "any", hurtBonus: 1.3, aheadBonus: 1.0, behindBonus: 1.3, baseWeight: 0.40 },
  MasterSequences:    { label: "Master Sequences", role: "mixed",              minStamina: 0.55, minDifficulty: 0.85, range: "any", hurtBonus: 1.6, aheadBonus: 1.0, behindBonus: 1.4, baseWeight: 0.30 },
  AdvancedPatterns:   { label: "Advanced Patterns & Ring IQ", role: "mixed",   minStamina: 0.35, minDifficulty: 0.50, range: "any", hurtBonus: 1.3, aheadBonus: 1.1, behindBonus: 1.2, baseWeight: 0.45 },
  EliteHyperAdaptive: { label: "Elite / Hyper-Adaptive", role: "mixed",        minStamina: 0.50, minDifficulty: 0.80, range: "any", hurtBonus: 1.5, aheadBonus: 1.0, behindBonus: 1.3, baseWeight: 0.25 },
};

// ===== PARSER =====

interface TokenSpec {
  kind: AiSegmentKind;
  punch?: PunchType;
  moveDir?: AiMoveDir;
}

const TOKEN_MAP: Record<string, TokenSpec> = {
  w: { kind: "punch", punch: "jab" },
  e: { kind: "punch", punch: "cross" },
  q: { kind: "punch", punch: "leftHook" },
  r: { kind: "punch", punch: "rightHook" },
  s: { kind: "punch", punch: "leftUppercut" },
  d: { kind: "punch", punch: "rightUppercut" },
  v: { kind: "block" },
  a: { kind: "charge" },
  lshift: { kind: "duck" },
  duck: { kind: "duck" },
  rshift: { kind: "switchStance" },
  sw: { kind: "switchStance" },
  fwd: { kind: "move", moveDir: "in" },
  forward: { kind: "move", moveDir: "in" },
  back: { kind: "move", moveDir: "out" },
  bck: { kind: "move", moveDir: "out" },
  left: { kind: "move", moveDir: "left" },
  sl: { kind: "move", moveDir: "left" },
  right: { kind: "move", moveDir: "right" },
  sr: { kind: "move", moveDir: "right" },
};

const PIECE_RE = /^([A-Za-z]+)\s*(?:\(([^)]*)\))?$/;

/**
 * Turn shorthand notation into segments. Throws on an unknown token rather
 * than dropping it, so a typo in the library surfaces in the check script
 * instead of quietly shortening a string at runtime.
 */
export function parseAiString(raw: string, label = ""): AiSegment[] {
  const segments: AiSegment[] = [];
  const pieces = raw.split(/\s*[~-]\s*/);
  for (const piece of pieces) {
    const trimmed = piece.trim();
    if (!trimmed) continue;
    const m = PIECE_RE.exec(trimmed);
    if (!m) throw new Error(`[aiStrings] malformed segment "${trimmed}" in ${label || raw}`);
    const spec = TOKEN_MAP[m[1].toLowerCase()];
    if (!spec) throw new Error(`[aiStrings] unknown token "${m[1]}" in ${label || raw}`);
    const seg: AiSegment = { kind: spec.kind, token: m[1] };
    if (spec.punch) seg.punch = spec.punch;
    if (spec.moveDir) seg.moveDir = spec.moveDir;
    // Only "(body)" carries meaning; everything else is flavour text.
    if (spec.kind === "punch" && m[2] && m[2].trim().toLowerCase() === "body") {
      seg.targetBody = true;
    }
    segments.push(seg);
  }
  if (segments.length === 0) throw new Error(`[aiStrings] empty string ${label || raw}`);
  return segments;
}

// ===== LIBRARY =====

interface AiStringSource {
  id: number;
  name: string;
  category: AiStringCategory;
  raw: string;
}

const AI_STRING_SOURCE: AiStringSource[] = [
  { id: 1, name: "1-2 Retreat", category: "Fundamentals", raw: "w ~ e ~ Back" },
  { id: 2, name: "Double Jab Cross", category: "Fundamentals", raw: "Fwd ~ w ~ w ~ e" },
  { id: 3, name: "Jab, Duck, Cross", category: "Fundamentals", raw: "w ~ LShift ~ e ~ Back" },
  { id: 4, name: "Circling Jab", category: "Fundamentals", raw: "Left ~ w ~ w ~ Back" },
  { id: 5, name: "Block & Jab", category: "Fundamentals", raw: "v ~ w ~ Fwd" },
  { id: 6, name: "Double Jab, Lead Hook", category: "Fundamentals", raw: "w ~ w ~ q ~ Right" },
  { id: 7, name: "Step In, Hooks", category: "Fundamentals", raw: "Fwd ~ r ~ q ~ Back" },
  { id: 8, name: "Duck to Lead Hook", category: "Fundamentals", raw: "LShift ~ q ~ e ~ Back" },
  { id: 9, name: "Uppercut Probe", category: "Fundamentals", raw: "w ~ d ~ q ~ Back" },
  { id: 10, name: "The Classic 1-2-3", category: "Fundamentals", raw: "Fwd ~ w ~ e ~ q ~ Back" },
  { id: 11, name: "Mayweather Pull-Counter", category: "CounterTraps", raw: "Back ~ e ~ Fwd ~ w" },
  { id: 12, name: "Slip & Rip", category: "CounterTraps", raw: "LShift ~ q ~ r ~ Back" },
  { id: 13, name: "Block & Uppercut", category: "CounterTraps", raw: "v ~ d ~ q ~ Fwd" },
  { id: 14, name: "Duck & Cross Counter", category: "CounterTraps", raw: "LShift ~ e ~ w ~ Back" },
  { id: 15, name: "Bait Block & Charge", category: "CounterTraps", raw: "Back ~ v ~ A ~ e" },
  { id: 16, name: "Whiff Punish Hook", category: "CounterTraps", raw: "Back ~ q ~ e ~ Fwd" },
  { id: 17, name: "Perfect Block Retaliation", category: "CounterTraps", raw: "v ~ s ~ r ~ Back" },
  { id: 18, name: "Circle & Duck Counter", category: "CounterTraps", raw: "Right ~ LShift ~ r ~ Left" },
  { id: 19, name: "Bait Jab to Charge Uppercut", category: "CounterTraps", raw: "w ~ LShift ~ A ~ d" },
  { id: 20, name: "Stance Confusion Counter", category: "CounterTraps", raw: "RShift ~ e ~ q ~ Back" },
  { id: 21, name: "Peek-a-Boo Entry", category: "InFighting", raw: "LShift ~ Fwd ~ LShift ~ Fwd ~ q ~ r" },
  { id: 22, name: "Inside Uppercut Flurry", category: "InFighting", raw: "Fwd ~ s ~ d ~ s ~ q" },
  { id: 23, name: "Crash the Pocket", category: "InFighting", raw: "v ~ Fwd ~ q ~ r ~ LShift" },
  { id: 24, name: "Duck & Dig", category: "InFighting", raw: "LShift ~ q ~ d ~ e ~ Fwd" },
  { id: 25, name: "Charged Inside Hook", category: "InFighting", raw: "Fwd ~ A ~ q ~ e ~ Back" },
  { id: 26, name: "Smothering Pressure", category: "InFighting", raw: "Fwd ~ w ~ v ~ Fwd ~ q ~ r" },
  { id: 27, name: "Bob and Weave Hooks", category: "InFighting", raw: "LShift ~ r ~ q ~ LShift ~ Fwd" },
  { id: 28, name: "Shift to Inside Uppercut", category: "InFighting", raw: "RShift ~ Fwd ~ s ~ e ~ Left" },
  { id: 29, name: "Brawl Combination", category: "InFighting", raw: "Fwd ~ q ~ d ~ s ~ r ~ LShift" },
  { id: 30, name: "Block to Charged Inside", category: "InFighting", raw: "v ~ A ~ r ~ s ~ Fwd" },
  { id: 31, name: "Lomachenko Pivot", category: "Shifting", raw: "w ~ Left ~ RShift ~ e ~ q" },
  { id: 32, name: "Step-Through Cross", category: "Shifting", raw: "Fwd ~ e ~ RShift ~ q ~ Back" },
  { id: 33, name: "Shift Jab to Cross", category: "Shifting", raw: "RShift ~ w ~ e ~ Right" },
  { id: 34, name: "Duck & Shift Combo", category: "Shifting", raw: "LShift ~ RShift ~ r ~ Fwd" },
  { id: 35, name: "Circling Stance Shift", category: "Shifting", raw: "w ~ Left ~ RShift ~ e ~ Back" },
  { id: 36, name: "The Hagler Shift", category: "Shifting", raw: "w ~ e ~ RShift ~ q ~ r ~ Fwd" },
  { id: 37, name: "Block & Switch Counter", category: "Shifting", raw: "v ~ RShift ~ d ~ Back" },
  { id: 38, name: "Retreating Shift Trap", category: "Shifting", raw: "Back ~ RShift ~ e ~ w ~ Back" },
  { id: 39, name: "Double Jab Shift", category: "Shifting", raw: "w ~ w ~ RShift ~ s ~ Left" },
  { id: 40, name: "Circle to Charged Hook", category: "Shifting", raw: "Right ~ RShift ~ A ~ q ~ Back" },
  { id: 41, name: "Double Jab Charge", category: "ChargeSetups", raw: "w ~ w ~ A ~ e ~ Back" },
  { id: 42, name: "Duck & Charge Hook", category: "ChargeSetups", raw: "LShift ~ A ~ q ~ r ~ Fwd" },
  { id: 43, name: "Perfect Block Uppercut", category: "ChargeSetups", raw: "v ~ A ~ d ~ q ~ Back" },
  { id: 44, name: "Shift & Charge", category: "ChargeSetups", raw: "RShift ~ A ~ q ~ e ~ Left" },
  { id: 45, name: "Step In Charge Bait", category: "ChargeSetups", raw: "Fwd ~ w ~ A ~ r ~ LShift" },
  { id: 46, name: "Jab, Duck, Execute", category: "ChargeSetups", raw: "w ~ LShift ~ A ~ e ~ Back" },
  { id: 47, name: "Pull Charged Uppercut", category: "ChargeSetups", raw: "Back ~ A ~ s ~ e ~ Fwd" },
  { id: 48, name: "Double Hook Finisher", category: "ChargeSetups", raw: "q ~ r ~ A ~ d ~ Back" },
  { id: 49, name: "Block, Cross, Charge", category: "ChargeSetups", raw: "v ~ e ~ A ~ q ~ Fwd" },
  { id: 50, name: "Feint to Charge", category: "ChargeSetups", raw: "w ~ A ~ e ~ q ~ Back" },
  { id: 51, name: "Jab, Block, Retreat", category: "DefensiveRetreats", raw: "w ~ Back ~ v ~ Back" },
  { id: 52, name: "Retreat, Duck, Hook", category: "DefensiveRetreats", raw: "Back ~ LShift ~ q ~ Back" },
  { id: 53, name: "Uppercut Check, Retreat", category: "DefensiveRetreats", raw: "w ~ d ~ v ~ Back" },
  { id: 54, name: "Shift, Retreat, Cross", category: "DefensiveRetreats", raw: "RShift ~ Back ~ e ~ Back" },
  { id: 55, name: "Duck, Circle, Jab", category: "DefensiveRetreats", raw: "LShift ~ Back ~ Left ~ w" },
  { id: 56, name: "Perfect Block Reset", category: "DefensiveRetreats", raw: "v ~ Back ~ Back ~ w" },
  { id: 57, name: "Circle, Block, Hook", category: "DefensiveRetreats", raw: "Right ~ v ~ Back ~ q" },
  { id: 58, name: "1-2, Retreat, Duck", category: "DefensiveRetreats", raw: "w ~ e ~ Back ~ LShift ~ Back" },
  { id: 59, name: "Retreat Switch Uppercut", category: "DefensiveRetreats", raw: "Back ~ RShift ~ v ~ d" },
  { id: 60, name: "Double Piston Retreat", category: "DefensiveRetreats", raw: "Back ~ w ~ Back ~ w ~ Left" },
  { id: 61, name: "8-Punch Blitz", category: "HighVolume", raw: "Fwd ~ w ~ e ~ q ~ e ~ s ~ d ~ q ~ e ~ Back" },
  { id: 62, name: "Stance Shift Flurry", category: "HighVolume", raw: "w ~ e ~ RShift ~ q ~ r ~ LShift ~ s ~ d ~ e ~ q ~ Back" },
  { id: 63, name: "Inside Destruction", category: "HighVolume", raw: "Fwd ~ LShift ~ q ~ r ~ d ~ s ~ LShift ~ r ~ q ~ Fwd ~ s" },
  { id: 64, name: "Multi-Angle Swarm", category: "HighVolume", raw: "Fwd ~ w ~ w ~ e ~ Left ~ q ~ e ~ Right ~ r ~ q ~ Back" },
  { id: 65, name: "Block & Retaliate", category: "HighVolume", raw: "v ~ w ~ e ~ q ~ r ~ s ~ d ~ A ~ q ~ e ~ Back" },
  { id: 66, name: "Up/Down Power Chain", category: "HighVolume", raw: "Fwd ~ w ~ LShift ~ e ~ Fwd ~ q ~ r ~ LShift ~ A ~ d ~ Back" },
  { id: 67, name: "Switch Hitter Relentless", category: "HighVolume", raw: "w ~ e ~ RShift ~ e ~ w ~ RShift ~ w ~ e ~ q ~ r ~ Fwd" },
  { id: 68, name: "Cornering Combo", category: "HighVolume", raw: "Fwd ~ w ~ Left ~ e ~ Right ~ q ~ Fwd ~ s ~ d ~ r ~ LShift" },
  { id: 69, name: "Jab to Charged Finisher", category: "HighVolume", raw: "w ~ w ~ e ~ w ~ q ~ r ~ v ~ A ~ e ~ q ~ Back" },
  { id: 70, name: "Counter-Swarm", category: "HighVolume", raw: "v ~ q ~ e ~ w ~ Fwd ~ s ~ s ~ d ~ q ~ e ~ Back" },
  { id: 71, name: "Philly Shell Check (Mayweather)", category: "EliteIQ", raw: "v ~ e ~ LShift ~ q ~ Back ~ Back" },
  { id: 72, name: "Gazelle Punch Setup (Tyson)", category: "EliteIQ", raw: "LShift ~ Fwd ~ LShift ~ Fwd ~ A ~ q ~ r ~ Back" },
  { id: 73, name: "Anchor Punch (Ali)", category: "EliteIQ", raw: "Back ~ Left ~ A ~ e ~ Right ~ w ~ Back" },
  { id: 74, name: "Lead Hook Burst (Roy Jones)", category: "EliteIQ", raw: "Right ~ LShift ~ A ~ q ~ e ~ q ~ Back" },
  { id: 75, name: "Inside Grind (Duran)", category: "EliteIQ", raw: "Fwd ~ v ~ r ~ s ~ LShift ~ q ~ d ~ v ~ Fwd" },
  { id: 76, name: "Switch-Trap (Crawford)", category: "EliteIQ", raw: "RShift ~ w ~ Back ~ RShift ~ A ~ e ~ q ~ Left" },
  { id: 77, name: "Distance Management (Usyk)", category: "EliteIQ", raw: "w ~ w ~ Back ~ Right ~ w ~ Fwd ~ q ~ e ~ Back" },
  { id: 78, name: "High Guard Counter (Canelo)", category: "EliteIQ", raw: "v ~ v ~ A ~ s ~ q ~ e ~ LShift ~ Fwd" },
  { id: 79, name: "Clinch/Smother (Fury)", category: "EliteIQ", raw: "w ~ e ~ Fwd ~ Fwd ~ v ~ LShift ~ r ~ Back" },
  { id: 80, name: "Bob-and-Weave (Frazier)", category: "EliteIQ", raw: "LShift ~ Fwd ~ LShift ~ Fwd ~ LShift ~ A ~ q ~ r" },
  { id: 81, name: "Prolonged Outside Boxing", category: "ExtendedAdaptive", raw: "w ~ Back ~ Left ~ w ~ e ~ Back ~ Right ~ w ~ w ~ Fwd ~ q ~ e ~ Back ~ v ~ Back ~ w" },
  { id: 82, name: "Relentless Inside Combo", category: "ExtendedAdaptive", raw: "Fwd ~ LShift ~ q ~ r ~ d ~ s ~ v ~ Fwd ~ LShift ~ A ~ q ~ e ~ r ~ s ~ d ~ LShift ~ Back" },
  { id: 83, name: "Multi-Phase Stance Trap", category: "ExtendedAdaptive", raw: "w ~ e ~ Back ~ RShift ~ w ~ w ~ Fwd ~ q ~ e ~ LShift ~ d ~ q ~ RShift ~ e ~ w ~ Back ~ Left" },
  { id: 84, name: "Block, Evade, Counter, Swarm", category: "ExtendedAdaptive", raw: "v ~ LShift ~ Back ~ Right ~ w ~ e ~ Fwd ~ q ~ r ~ s ~ d ~ A ~ e ~ q ~ Fwd ~ v ~ Back" },
  { id: 85, name: "Double Charge Setup", category: "ExtendedAdaptive", raw: "Fwd ~ w ~ v ~ A ~ q ~ e ~ LShift ~ A ~ d ~ r ~ q ~ e ~ Back ~ Left ~ w" },
  { id: 86, name: "Ultimate Pressure Walker", category: "ExtendedAdaptive", raw: "Fwd ~ v ~ Fwd ~ LShift ~ q ~ Fwd ~ v ~ Fwd ~ RShift ~ e ~ q ~ r ~ Fwd ~ s ~ d ~ q ~ Back" },
  { id: 87, name: "Evasive Masterclass", category: "ExtendedAdaptive", raw: "Back ~ Left ~ LShift ~ Right ~ Back ~ w ~ LShift ~ q ~ Back ~ Left ~ v ~ RShift ~ e ~ w ~ Back" },
  { id: 88, name: "Body to Head Demolition", category: "ExtendedAdaptive", raw: "Fwd ~ LShift ~ e ~ q ~ r ~ Fwd ~ s ~ d ~ A ~ q ~ e ~ LShift ~ r ~ q ~ Back ~ v ~ Back" },
  { id: 89, name: "Endless Jab Engine", category: "ExtendedAdaptive", raw: "w ~ Left ~ w ~ w ~ Right ~ w ~ LShift ~ w ~ e ~ Back ~ w ~ Fwd ~ w ~ q ~ e ~ Back" },
  { id: 90, name: "Switch-Stance Flurry & Retreat", category: "ExtendedAdaptive", raw: "RShift ~ Fwd ~ e ~ w ~ q ~ r ~ RShift ~ s ~ d ~ q ~ e ~ Back ~ LShift ~ Back ~ v ~ RShift" },
  { id: 91, name: "The 30-Segment Championship Swarm", category: "MasterSequences", raw: "Fwd ~ w ~ e ~ q ~ Fwd ~ v ~ LShift ~ s ~ d ~ r ~ q ~ Back ~ Left ~ w ~ e ~ RShift ~ Fwd ~ A ~ q ~ e ~ d ~ s ~ LShift ~ r ~ q ~ Fwd ~ v ~ LShift ~ A ~ e" },
  { id: 92, name: "Unpredictable Ghost Movement", category: "MasterSequences", raw: "Back ~ Left ~ LShift ~ Back ~ Right ~ v ~ RShift ~ Fwd ~ w ~ e ~ q ~ Back ~ LShift ~ RShift ~ Right ~ Fwd ~ s ~ d ~ q ~ e ~ A ~ r ~ v ~ Back ~ Left ~ w ~ w ~ Back" },
  { id: 93, name: "Absolute Inside Destruction", category: "MasterSequences", raw: "Fwd ~ LShift ~ q ~ Fwd ~ v ~ r ~ s ~ d ~ LShift ~ q ~ e ~ RShift ~ Fwd ~ A ~ d ~ q ~ r ~ s ~ v ~ Fwd ~ LShift ~ A ~ q ~ e ~ r ~ LShift ~ Fwd ~ s ~ d ~ Back" },
  { id: 94, name: "The 12-Round Cardio Test (Stamina Drainer)", category: "MasterSequences", raw: "w ~ Back ~ w ~ Back ~ Fwd ~ q ~ e ~ LShift ~ Back ~ Left ~ RShift ~ w ~ w ~ Back ~ Right ~ v ~ Fwd ~ s ~ d ~ q ~ RShift ~ Back ~ LShift ~ Back ~ w ~ e ~ q ~ Back" },
  { id: 95, name: "Infinite Shift Engine", category: "MasterSequences", raw: "RShift ~ Fwd ~ e ~ w ~ RShift ~ q ~ r ~ LShift ~ Fwd ~ RShift ~ s ~ d ~ RShift ~ A ~ q ~ e ~ Back ~ Left ~ RShift ~ Fwd ~ w ~ e ~ RShift ~ LShift ~ r ~ q ~ Back" },
  { id: 96, name: "The Ultimate Counter-Puncher Matrix", category: "MasterSequences", raw: "Back ~ v ~ LShift ~ Fwd ~ A ~ e ~ q ~ Back ~ Right ~ LShift ~ RShift ~ Fwd ~ A ~ q ~ r ~ Back ~ Left ~ v ~ Fwd ~ s ~ d ~ q ~ e ~ LShift ~ Back ~ v ~ A ~ r ~ Back" },
  { id: 97, name: "Perfect Defense into Maximum Offense", category: "MasterSequences", raw: "v ~ v ~ LShift ~ Right ~ Back ~ Left ~ LShift ~ Fwd ~ w ~ e ~ q ~ r ~ s ~ d ~ A ~ q ~ e ~ LShift ~ RShift ~ Fwd ~ A ~ d ~ q ~ r ~ Back ~ v ~ Back ~ w ~ e ~ Back" },
  { id: 98, name: "Peek-a-boo Final Form", category: "MasterSequences", raw: "LShift ~ Fwd ~ LShift ~ Fwd ~ q ~ r ~ LShift ~ Fwd ~ d ~ s ~ v ~ Fwd ~ LShift ~ A ~ q ~ e ~ RShift ~ Fwd ~ LShift ~ r ~ q ~ d ~ s ~ LShift ~ Back ~ LShift ~ Back ~ v" },
  { id: 99, name: "The \"Charge\" Juggle", category: "MasterSequences", raw: "Fwd ~ w ~ A ~ e ~ q ~ LShift ~ A ~ q ~ r ~ Back ~ v ~ Fwd ~ A ~ s ~ d ~ RShift ~ LShift ~ A ~ r ~ q ~ e ~ Back ~ Left ~ Right ~ Fwd ~ A ~ e ~ q ~ Back" },
  { id: 100, name: "The Master Boxer-Puncher Algorithm", category: "MasterSequences", raw: "w ~ w ~ e ~ Back ~ Left ~ LShift ~ Fwd ~ q ~ e ~ RShift ~ Back ~ v ~ Right ~ Fwd ~ A ~ e ~ q ~ r ~ s ~ d ~ LShift ~ Back ~ RShift ~ Left ~ w ~ e ~ Fwd ~ A ~ q ~ Back" },
  { id: 101, name: "Full Classic Combination", category: "AdvancedPatterns", raw: "w - e - q - e - q - e" },
  { id: 102, name: "Jab-Feint-Cross-Feint-Hook", category: "AdvancedPatterns", raw: "w - e - q (long variable beats)" },
  { id: 103, name: "Pull-Counter into Pressure", category: "AdvancedPatterns", raw: "bck - e - fwd - w - e - q" },
  { id: 104, name: "Duck Series + Uppercuts", category: "AdvancedPatterns", raw: "duck - s - duck - d - q" },
  { id: 105, name: "Block-Counter-Pressure", category: "AdvancedPatterns", raw: "v - w - e - fwd - q - e" },
  { id: 106, name: "Circle Left while Punching", category: "AdvancedPatterns", raw: "sl - w - sl - e - sl - q" },
  { id: 107, name: "Circle Right while Punching", category: "AdvancedPatterns", raw: "sr - e - sr - q - sr - e" },
  { id: 108, name: "Mayweather Shoulder-Roll Style", category: "AdvancedPatterns", raw: "bck - e - bck - q - bck - e" },
  { id: 109, name: "Tyson-style Peekaboo Burst", category: "AdvancedPatterns", raw: "duck - s - q - d - e - q" },
  { id: 110, name: "Stance Switch Angle Change", category: "AdvancedPatterns", raw: "w - e - sw - q - e - r" },
  { id: 111, name: "Charge Power Sequence", category: "AdvancedPatterns", raw: "w - w - A - e - A - q" },
  { id: 112, name: "Body-Head-Body-Head", category: "AdvancedPatterns", raw: "q (body) - e - r (body) - q" },
  { id: 113, name: "Long Feint then Explode", category: "AdvancedPatterns", raw: "w - w - A - d - q - e" },
  { id: 114, name: "Defensive Shell then Counter", category: "AdvancedPatterns", raw: "v - v - duck - e - q - e" },
  { id: 115, name: "Forward Pressure 8-punch", category: "AdvancedPatterns", raw: "fwd - w - e - w - e - q - e - w - e" },
  { id: 116, name: "Retreat + Re-engage", category: "AdvancedPatterns", raw: "bck - w - bck - e - fwd - q - e" },
  { id: 117, name: "Lateral then Straight", category: "AdvancedPatterns", raw: "sl - sr - w - e - q" },
  { id: 118, name: "Uppercut Heavy Inside", category: "AdvancedPatterns", raw: "fwd - s - d - s - q - d" },
  { id: 119, name: "Perfect Block + Full Reply", category: "AdvancedPatterns", raw: "v - w - e - q - e - s" },
  { id: 120, name: "Switch + New Lead Combo", category: "AdvancedPatterns", raw: "sw - w - e - q - r - e" },
  { id: 121, name: "Double Pull-Counter", category: "AdvancedPatterns", raw: "bck - e - bck - q - e" },
  { id: 122, name: "Duck-Block-Duck-Uppercut", category: "AdvancedPatterns", raw: "duck - v - duck - s - d" },
  { id: 123, name: "Jab-Cross-Hook-Uppercut-Hook", category: "AdvancedPatterns", raw: "w - e - q - s - q" },
  { id: 124, name: "Step-in Body then Head", category: "AdvancedPatterns", raw: "fwd - q (body) - e - q - r" },
  { id: 125, name: "Outfighter Cycle", category: "AdvancedPatterns", raw: "w - bck - w - e - bck - q" },
  { id: 126, name: "Pressure Fighter Cycle", category: "AdvancedPatterns", raw: "fwd - w - e - fwd - q - e - fwd - s" },
  { id: 127, name: "Counter-Puncher Cycle", category: "AdvancedPatterns", raw: "bck - e - q - bck - e - w" },
  { id: 128, name: "Feint-Charge-Feint-Charge", category: "AdvancedPatterns", raw: "w - A - e - w - A - d" },
  { id: 129, name: "Side-step + Switch + Combo", category: "AdvancedPatterns", raw: "sl - sw - w - e - q" },
  { id: 130, name: "Full Ring Cut-off", category: "AdvancedPatterns", raw: "fwd - sl - w - e - sr - q - e" },
  { id: 131, name: "10-punch Pressure String", category: "AdvancedPatterns", raw: "fwd - w - e - q - e - w - e - q - e - w - e" },
  { id: 132, name: "Defensive then Explosive", category: "AdvancedPatterns", raw: "v - duck - bck - A - e - q - e" },
  { id: 133, name: "Continuous Lateral Attack", category: "AdvancedPatterns", raw: "sl - w - sr - e - sl - q - sr - e" },
  { id: 134, name: "Inside Control", category: "AdvancedPatterns", raw: "fwd - s - q - d - s - q - e" },
  { id: 135, name: "Long Range Control", category: "AdvancedPatterns", raw: "w - w - e - bck - w - e - q" },
  { id: 136, name: "Adaptive Pull after Whiff", category: "AdvancedPatterns", raw: "bck - e - bck - q - e - w" },
  { id: 137, name: "Stance Switch twice mid-fight", category: "AdvancedPatterns", raw: "w - e - sw - q - e - sw - r" },
  { id: 138, name: "Charge after Opponent Fatigue", category: "AdvancedPatterns", raw: "w - e - A - d - q" },
  { id: 139, name: "Body Attack to Set up Head", category: "AdvancedPatterns", raw: "q (body) - r (body) - e - q - s" },
  { id: 140, name: "Full Counter after Opponent Combo", category: "AdvancedPatterns", raw: "v - duck - e - q - e - s" },
  { id: 141, name: "12-segment Pressure", category: "AdvancedPatterns", raw: "fwd - w - e - w - e - q - e - w - e - q - e - s - e" },
  { id: 142, name: "Circle + Pull + Counter", category: "AdvancedPatterns", raw: "sl - bck - e - sr - q - e" },
  { id: 143, name: "Peekaboo to Outside", category: "AdvancedPatterns", raw: "duck - s - q - bck - e - w" },
  { id: 144, name: "Switch + Body-Head Mix", category: "AdvancedPatterns", raw: "sw - q (body) - e - r - q" },
  { id: 145, name: "Double Charge Setup", category: "AdvancedPatterns", raw: "w - A - e - w - A - q" },
  { id: 146, name: "High-volume Jab then Power", category: "AdvancedPatterns", raw: "w - w - w - w - e - q - e" },
  { id: 147, name: "Defensive Movement + Counter", category: "AdvancedPatterns", raw: "bck - sl - v - e - q" },
  { id: 148, name: "Forward Uppercut Barrage", category: "AdvancedPatterns", raw: "fwd - s - d - s - d - q" },
  { id: 149, name: "Retreat to Center then Attack", category: "AdvancedPatterns", raw: "bck - bck - w - e - fwd - q - e" },
  { id: 150, name: "Complex Feint String", category: "AdvancedPatterns", raw: "w - e - w - A - d - q - e" },
  { id: 151, name: "Extended Classic", category: "EliteHyperAdaptive", raw: "w - e - q - e - q - e - w - e - q - e" },
  { id: 152, name: "Full Mayweather Cycle", category: "EliteHyperAdaptive", raw: "bck - e - bck - q - bck - e - w - bck - q - e" },
  { id: 153, name: "Tyson Peekaboo Pressure", category: "EliteHyperAdaptive", raw: "duck - s - q - d - e - q - duck - s - d - q - e" },
  { id: 154, name: "Ring-cutting Sequence", category: "EliteHyperAdaptive", raw: "fwd - sl - w - e - fwd - sr - q - e - fwd - w - e - q" },
  { id: 155, name: "High-volume Outfighter", category: "EliteHyperAdaptive", raw: "w - w - e - bck - w - w - e - bck - q - e - w" },
  { id: 156, name: "Inside Control 12", category: "EliteHyperAdaptive", raw: "fwd - s - q - d - s - q - e - s - d - q - r - e" },
  { id: 157, name: "Defensive Mastery then Counter", category: "EliteHyperAdaptive", raw: "v - duck - bck - v - e - q - e - s - q" },
  { id: 158, name: "Stance-Switch Angle Attack", category: "EliteHyperAdaptive", raw: "w - e - sw - q - e - r - sw - w - e - q" },
  { id: 159, name: "Double Charge Power", category: "EliteHyperAdaptive", raw: "w - w - A - e - q - A - d - e - q" },
  { id: 160, name: "Lateral Dominance", category: "EliteHyperAdaptive", raw: "sl - w - sr - e - sl - q - sr - e - sl - w - e" },
  { id: 161, name: "Pull-Counter into Pressure (14)", category: "EliteHyperAdaptive", raw: "bck - e - q - fwd - w - e - q - e - w - e - q - e" },
  { id: 162, name: "Body Destruction then Head", category: "EliteHyperAdaptive", raw: "q (body) - r (body) - q (body) - e - q - r - e - s" },
  { id: 163, name: "15-punch Pressure Storm", category: "EliteHyperAdaptive", raw: "fwd - w - e - w - e - q - e - w - e - q - e - w - e - s - e" },
  { id: 164, name: "Adaptive Whiff Punishment", category: "EliteHyperAdaptive", raw: "bck - e - bck - q - e - fwd - w - e - q" },
  { id: 165, name: "Full Circle Left Attack", category: "EliteHyperAdaptive", raw: "sl - w - sl - e - sl - q - sl - e - sl - w - e - q" },
  { id: 166, name: "Full Circle Right Attack", category: "EliteHyperAdaptive", raw: "sr - e - sr - q - sr - e - sr - w - sr - e - q" },
  { id: 167, name: "Peekaboo to Outside to Inside", category: "EliteHyperAdaptive", raw: "duck - s - q - bck - e - fwd - s - d - q" },
  { id: 168, name: "Switch-heavy Unorthodox", category: "EliteHyperAdaptive", raw: "sw - w - e - sw - q - e - sw - r - e - q" },
  { id: 169, name: "Long Feint then Kill Shot", category: "EliteHyperAdaptive", raw: "w - e - w - e - A - d - q - e" },
  { id: 170, name: "Defensive Shell  to Explosive Finish", category: "EliteHyperAdaptive", raw: "v - v - duck - bck - A - e - q - e - s" },
  { id: 171, name: "18-segment Ring General", category: "EliteHyperAdaptive", raw: "fwd - w - e - sl - w - e - sr - q - e - bck - e - q - fwd - w - e - q - e - s" },
  { id: 172, name: "Continuous Lateral + Straight", category: "EliteHyperAdaptive", raw: "sl - w - sr - e - sl - q - sr - e - sl - w - sr - e - q" },
  { id: 173, name: "Inside Uppercut Factory", category: "EliteHyperAdaptive", raw: "fwd - s - d - s - q - d - s - e - q - d" },
  { id: 174, name: "Counter-Puncher Mastery", category: "EliteHyperAdaptive", raw: "bck - e - q - bck - e - w - bck - q - e - bck - e" },
  { id: 175, name: "Pressure + Reset + Pressure", category: "EliteHyperAdaptive", raw: "fwd - w - e - q - e - bck - w - e - fwd - q - e - s" },
  { id: 176, name: "20-punch High Output", category: "EliteHyperAdaptive", raw: "fwd - w - e - w - e - q - e - w - e - q - e - w - e - q - e - w - e - s - e - q" },
  { id: 177, name: "Complex Pull + Switch + Attack", category: "EliteHyperAdaptive", raw: "bck - e - sw - q - e - bck - r - e - q" },
  { id: 178, name: "Duck Series Heavy", category: "EliteHyperAdaptive", raw: "duck - s - duck - d - duck - q - duck - e - s - d" },
  { id: 179, name: "Charge after Long Setup", category: "EliteHyperAdaptive", raw: "w - e - w - e - q - A - d - e - q - A - e" },
  { id: 180, name: "Full Defensive to Offensive Transition", category: "EliteHyperAdaptive", raw: "v - duck - bck - sl - v - e - q - e - fwd - s - d" },
  { id: 181, name: "22-segment Adaptive Pattern", category: "EliteHyperAdaptive", raw: "w - e - bck - e - q - fwd - w - e - sl - q - e - sr - w - e - q - e - bck - e - q - fwd - s - e" },
  { id: 182, name: "Body-Head Oscillation", category: "EliteHyperAdaptive", raw: "q (body) - e - r (body) - q - e - q (body) - r - e - s" },
  { id: 183, name: "Stance Switch + Lateral + Power", category: "EliteHyperAdaptive", raw: "sw - sl - w - e - sr - q - A - d - e" },
  { id: 184, name: "Ring Cut + Finish", category: "EliteHyperAdaptive", raw: "fwd - sl - w - e - fwd - sr - q - e - fwd - A - e - q" },
  { id: 185, name: "25-segment Hyper Pattern (rhythm breaker)", category: "EliteHyperAdaptive", raw: "w - e - w - e - q - e - bck - e - q - fwd - w - e - sl - q - e - sr - w - e - q - e - duck - s - d - q - e" },
  { id: 186, name: "Elite Pull-Counter Library", category: "EliteHyperAdaptive", raw: "bck - e - bck - q - e - bck - w - e - q - bck - e - q - e" },
  { id: 187, name: "Elite Pressure Library", category: "EliteHyperAdaptive", raw: "fwd - w - e - fwd - q - e - fwd - s - d - fwd - w - e - q - e" },
  { id: 188, name: "Elite Counter Library", category: "EliteHyperAdaptive", raw: "v - e - q - duck - s - e - bck - e - q - v - e" },
  { id: 189, name: "Mixed Range Control (26)", category: "EliteHyperAdaptive", raw: "w - e - bck - w - e - fwd - q - e - sl - w - e - sr - q - e - bck - e - q - fwd - s - d - q - e - w - e" },
  { id: 190, name: "Long Feint + Multiple Charges", category: "EliteHyperAdaptive", raw: "w - e - w - A - e - w - e - A - d - q - e - A - e" },
  { id: 191, name: "28-segment Comprehensive", category: "EliteHyperAdaptive", raw: "fwd - w - e - q - e - bck - e - q - fwd - w - e - sl - q - e - sr - w - e - duck - s - d - q - e - sw - q - e - r - e" },
  { id: 192, name: "Defensive Mastery  (long)", category: "EliteHyperAdaptive", raw: "v - duck - bck - v - sl - v - e - q - e - bck - duck - e - q" },
  { id: 193, name: "Offensive Mastery (long)", category: "EliteHyperAdaptive", raw: "fwd - w - e - w - e - q - e - s - d - q - e - w - e - q - e - A - e" },
  { id: 194, name: "Hybrid Adaptive 29", category: "EliteHyperAdaptive", raw: "w - e - bck - e - q - fwd - w - e - sl - q - e - sr - w - e - duck - s - d - q - e - sw - e - q - r - e - bck - e" },
  { id: 195, name: "Full Cycle Outfighter to Pressure", category: "EliteHyperAdaptive", raw: "w - w - e - bck - w - e - q - fwd - w - e - q - e - s - e" },
  { id: 196, name: "Full Cycle Pressure to Counter", category: "EliteHyperAdaptive", raw: "fwd - w - e - q - e - bck - e - q - v - e - q - e" },
  { id: 197, name: "30-segment Maximum Complexity String (rhythm destroyer + finish)", category: "EliteHyperAdaptive", raw: "w - e - w - e - q - e - bck - e - q - fwd - w - e - sl - q - e - sr - w - e - duck - s - d - q - e - sw - q - e - A - d - e - q" },
  { id: 198, name: "Emergency Defensive Reset", category: "EliteHyperAdaptive", raw: "v - duck - bck - bck - v - sl - sr - v" },
  { id: 199, name: "Emergency Finishing Burst", category: "EliteHyperAdaptive", raw: "fwd - A - e - q - A - d - e - s - q" },
  { id: 200, name: "Ultimate Adaptive String (reads scorecard + stamina + patterns)", category: "EliteHyperAdaptive", raw: "bck - e - q - fwd - w - e - sl - q - e - sr - w - e - duck - s - d - v - e - q - sw - e - A - d - q - e - fwd - s - e" },

  // ===== CORE OFFENCE (401-450) =====
  // Short offensive sequences. These are what the AI actually leads with.
  { id: 401, name: "Jab-Cross", category: "CoreOffense", raw: "w - e" },
  { id: 402, name: "Jab-Hook", category: "CoreOffense", raw: "w - q" },
  { id: 403, name: "Cross-Hook", category: "CoreOffense", raw: "e - q" },
  { id: 404, name: "Lead Hook-Cross", category: "CoreOffense", raw: "q - e" },
  { id: 405, name: "Uppercut-Hook", category: "CoreOffense", raw: "s - q" },
  { id: 406, name: "Cross-Uppercut", category: "CoreOffense", raw: "e - d" },
  { id: 407, name: "Charge Cross", category: "CoreOffense", raw: "A - e" },
  { id: 408, name: "Charge Hook", category: "CoreOffense", raw: "A - q" },
  { id: 409, name: "Double Jab", category: "CoreOffense", raw: "w - w" },
  { id: 410, name: "Step-in Jab", category: "CoreOffense", raw: "fwd - w" },
  { id: 411, name: "1-2-3", category: "CoreOffense", raw: "w - e - q" },
  { id: 412, name: "Jab-Cross-Uppercut", category: "CoreOffense", raw: "w - e - s" },
  { id: 413, name: "Double Jab-Cross", category: "CoreOffense", raw: "w - w - e" },
  { id: 414, name: "Hook-Cross-Hook", category: "CoreOffense", raw: "q - e - r" },
  { id: 415, name: "Step-in 1-2", category: "CoreOffense", raw: "fwd - w - e" },
  { id: 416, name: "Jab-Charge Cross", category: "CoreOffense", raw: "w - A - e" },
  { id: 417, name: "Cross-Left Hook-Right Hook", category: "CoreOffense", raw: "e - q - r" },
  { id: 418, name: "Uppercut-Cross-Hook", category: "CoreOffense", raw: "s - e - q" },
  { id: 419, name: "Forward Pressure Jab", category: "CoreOffense", raw: "fwd - w - w" },
  { id: 420, name: "Lead Uppercut-Cross", category: "CoreOffense", raw: "s - e - d" },
  { id: 421, name: "Classic 1-2-3-2", category: "CoreOffense", raw: "w - e - q - e" },
  { id: 422, name: "Double Jab-Cross-Hook", category: "CoreOffense", raw: "w - w - e - q" },
  { id: 423, name: "Step-in 1-2-Hook", category: "CoreOffense", raw: "fwd - w - e - q" },
  { id: 424, name: "Jab-Cross-Body-Head", category: "CoreOffense", raw: "w - e - q (body) - q" },
  { id: 425, name: "Charge Setup", category: "CoreOffense", raw: "w - w - A - e" },
  { id: 426, name: "Hook-Cross-Uppercut-Hook", category: "CoreOffense", raw: "q - e - s - q" },
  { id: 427, name: "Forward 1-2-1-2", category: "CoreOffense", raw: "fwd - w - e - w" },
  { id: 428, name: "Jab-Cross-Hook-Uppercut", category: "CoreOffense", raw: "w - e - q - s" },
  { id: 429, name: "Power Sequence", category: "CoreOffense", raw: "e - q - A - d" },
  { id: 430, name: "Pressure Uppercuts", category: "CoreOffense", raw: "fwd - s - d - q" },
  { id: 431, name: "1-2-3-2-3", category: "CoreOffense", raw: "w - e - q - e - q" },
  { id: 432, name: "Step-in Full Combo", category: "CoreOffense", raw: "fwd - w - e - q - e" },
  { id: 433, name: "Double Jab-Cross-Hook-Cross", category: "CoreOffense", raw: "w - w - e - q - e" },
  { id: 434, name: "Body-Head Pressure", category: "CoreOffense", raw: "q (body) - e - q - r - e" },
  { id: 435, name: "Charge after Setup", category: "CoreOffense", raw: "w - e - A - d - q" },
  { id: 436, name: "Forward Volume", category: "CoreOffense", raw: "fwd - w - e - w - e" },
  { id: 437, name: "Uppercut Heavy", category: "CoreOffense", raw: "s - d - q - e - s" },
  { id: 438, name: "Angle Pressure Left", category: "CoreOffense", raw: "fwd - sl - w - e - q" },
  { id: 439, name: "Angle Pressure Right", category: "CoreOffense", raw: "fwd - sr - e - q - e" },
  { id: 440, name: "Power Hook Series", category: "CoreOffense", raw: "q - e - r - q - e" },
  { id: 441, name: "Extended Classic", category: "CoreOffense", raw: "w - e - q - e - q - e" },
  { id: 442, name: "Step-in Pressure 6", category: "CoreOffense", raw: "fwd - w - e - q - e - w" },
  { id: 443, name: "High Volume Jab into Power", category: "CoreOffense", raw: "w - w - w - e - q - e" },
  { id: 444, name: "Charge Double Power", category: "CoreOffense", raw: "w - A - e - q - A - d" },
  { id: 445, name: "Inside Pressure", category: "CoreOffense", raw: "fwd - s - q - d - e - q" },
  { id: 446, name: "Continuous 1-2 Cycle", category: "CoreOffense", raw: "w - e - w - e - w - e" },
  { id: 447, name: "Body to Head Assault", category: "CoreOffense", raw: "q (body) - r (body) - e - q - e - r" },
  { id: 448, name: "Forward Uppercut Barrage", category: "CoreOffense", raw: "fwd - s - d - s - q - e" },
  { id: 449, name: "Full Pressure Combo", category: "CoreOffense", raw: "fwd - w - e - q - e - w - e" },
  { id: 450, name: "Advanced Power Sequence", category: "CoreOffense", raw: "w - e - q - A - d - e - q" },
];

function buildLibrary(): AiStringDef[] {
  const seen = new Set<number>();
  return AI_STRING_SOURCE.map((src) => {
    if (seen.has(src.id)) throw new Error(`[aiStrings] duplicate id ${src.id}`);
    seen.add(src.id);
    const segments = parseAiString(src.raw, `#${src.id} ${src.name}`);
    return {
      id: src.id,
      name: src.name,
      category: src.category,
      raw: src.raw,
      segments,
      punchCount: segments.reduce((n, s) => n + (s.kind === "punch" ? 1 : 0), 0),
      hookUpperCount: segments.reduce(
        (n, s) => n + (s.kind === "punch" && s.punch && s.punch !== "jab" && s.punch !== "cross" ? 1 : 0),
        0,
      ),
    };
  });
}

export const AI_STRINGS: AiStringDef[] = buildLibrary();

export const AI_STRINGS_BY_ID: Map<number, AiStringDef> = new Map(
  AI_STRINGS.map((s) => [s.id, s]),
);

export const AI_STRINGS_BY_CATEGORY: Record<AiStringCategory, AiStringDef[]> =
  AI_STRINGS.reduce((acc, s) => {
    (acc[s.category] ||= []).push(s);
    return acc;
  }, {} as Record<AiStringCategory, AiStringDef[]>);
