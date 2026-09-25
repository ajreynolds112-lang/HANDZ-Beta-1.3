/**
 * AI STRING RUNNER
 * ================
 * Executes the string library (game/aiStrings.ts) as the AI's offence, and
 * learns from the result.
 *
 * WHAT A STRING IS
 * ----------------
 * A string is an ordered list of segments -- punches, perfect blocks, ducks,
 * charges, stance switches and movement -- separated by "beats". A beat is a
 * dynamic delay in [BEAT_MIN, BEAT_MAX] adjusted in BEAT_STEP increments. The
 * runner walks the segments, applying non-punch segments itself and handing
 * punches back to updateAI (which owns the attemptPunch closure).
 *
 * LEARNING (within-bout)
 * ----------------------
 * On a hit-confirm the beat for that slot tightens toward BEAT_MIN; on a whiff
 * it stretches toward BEAT_MAX. Both are gated on STRING_ADAPT_CHANCE for the
 * fighter's difficulty band, so a Journeyman adapts far more slowly than a
 * Champion. Repeated whiffs additionally cancel the remainder of the string to
 * save stamina, and push the string's selection weight down so it comes up less
 * often. Landing a string pushes its weight up.
 *
 * Learning is intentionally per-bout rather than persisted: an AI should feel
 * like it is solving *you*, this fight, not arriving pre-solved.
 *
 * WHY THE RUNNER DOESN'T THROW PUNCHES ITSELF
 * -------------------------------------------
 * attemptPunch is threaded through updateAI as a closure with per-fight
 * wrapping (reach gating, telemetry, practice-mode suppression). Rather than
 * thread it through here as an eighth call site, the runner returns an
 * AiStringTick describing what it wants to happen and updateAI performs it.
 */

import type {
  AiBrainState,
  FighterState,
  PunchType,
  AiStringRuntime,
  AiStringPlanStep,
  BoxingStance,
} from "./types";
import { aiRNG } from "./engine";
import {
  AI_STRINGS,
  AI_STRINGS_BY_ID,
  AI_STRING_CATEGORY_META,
  type AiStringRole,
  BEAT_MIN,
  BEAT_MAX,
  BEAT_STEP,
  BEAT_DEFAULT,
  CHARGE_RELEASE_WINDOW,
  STRING_ADAPT_CHANCE,
  STRING_RANGE_MULT,
  STRING_RETURN_TOLERANCE_PX,
  STRING_RETREAT_MARGIN_PX,
  STRING_WALL_STALL_PX,
  STRING_POCKET_PX,
  STRING_POCKET_HOLD_MULT,
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
  STRING_RANGE_PUNCH_BIAS,
  AGGRESSION_SWAP_MIN_DEFICIT,
  AGGRESSION_SWAP_CHANCE_MAX,
  AGGRESSION_SWAP_MIN_STAMINA,
  type AiSegment,
  type AiStringDef,
  type AiMoveDir,
} from "./aiStrings";

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Snap to the BEAT_STEP grid so learned beats stay on clean increments. */
function quantizeBeat(v: number): number {
  const stepped = Math.round(v / BEAT_STEP) * BEAT_STEP;
  // Rounding in floating point leaves values like 0.15000000000000002; the
  // library and the check script both compare against clean multiples.
  return clamp(Number(stepped.toFixed(4)), BEAT_MIN, BEAT_MAX);
}

/**
 * Rebuild the lookahead if it no longer describes what is actually next.
 *
 * The plan is deliberately cheap and disposable: the runner reads it to shape
 * the segment it is executing (chiefly, whether a punch is coming up behind a
 * move), and throws it away the moment the string advances, is trimmed by
 * whiff learning, or is cut into by a reactive insert.
 */
function syncStringPlan(rt: AiStringRuntime, def: AiStringDef): void {
  const fresh =
    rt.plan.length > 0 &&
    rt.plan[0].slot === rt.index &&
    rt.plan.every((st) => st.slot < rt.segments.length);
  if (fresh) return;

  rt.plan = [];
  const last = Math.min(rt.segments.length, rt.index + STRING_PLAN_LOOKAHEAD + 1);
  for (let slot = rt.index; slot < last; slot++) {
    const sg = rt.segments[slot];
    if (!sg) break;
    const step: AiStringPlanStep = { slot, kind: sg.kind, beat: getBeat(rt, def, slot) };
    if (sg.punch) step.punch = sg.punch;
    if (sg.targetBody) step.targetBody = true;
    if (sg.moveDir) step.moveDir = sg.moveDir;
    rt.plan.push(step);
  }
}

/**
 * A fighter who is being out-worked should not spend the round executing the
 * quiet half of its script. When it is behind on landed punches and the segment
 * about to run does not throw anything, that segment is rolled against the size
 * of the deficit and replaced by a punch if the roll hits.
 *
 * The replacement is written into the runtime's working copy, so it happens
 * once per slot per run and the rest of the string carries on around it. Charge
 * segments are left alone: the punch behind a charge is already the offence,
 * and swapping the arm out would strip the charge from it.
 *
 * Returns true when the segment was replaced.
 */
/**
 * How far under its target output the fighter is running, 0 (at or above) .. 1
 * (throwing nothing). Being out-landed and being out-worked are different
 * problems: a fighter can be level on the cards while throwing a third of the
 * punches, and no amount of picking better sequences fixes that. This is the
 * second driver of the aggression swap, and the one that answers the round
 * where the AI threw 41 punches to the player's 95.
 */
export function outputDeficit(rt: AiStringRuntime): number {
  if (rt.inRangeTime < STRING_OUTPUT_MIN_SAMPLE_SEC) return 0;
  const rate = rt.throwCount / rt.inRangeTime;
  return clamp(1 - rate / STRING_OUTPUT_TARGET_RATE, 0, 1);
}

function maybeSwapForOffense(
  rt: AiStringRuntime,
  slot: number,
  seg: AiSegment,
  enemy: FighterState,
  ctx: StringSelectContext,
): boolean {
  if (seg.kind === "punch" || seg.kind === "charge") return false;
  if (enemy.chargeArmed) return false;
  const drive = Math.max(ctx.punchDeficit, outputDeficit(rt));
  if (drive < AGGRESSION_SWAP_MIN_DEFICIT) return false;
  if (ctx.myStaminaFrac < AGGRESSION_SWAP_MIN_STAMINA) return false;
  if (!aiRNG.chance(AGGRESSION_SWAP_CHANCE_MAX * drive)) return false;

  // Borrow the string's own next punch so the substitution still sounds like
  // the sequence it interrupted; a jab is the fallback for a punchless string.
  let punch: PunchType = "jab";
  let targetBody: boolean | undefined;
  for (let i = slot + 1; i < rt.segments.length; i++) {
    const later = rt.segments[i];
    if (later.kind === "punch" && later.punch) {
      punch = later.punch;
      targetBody = later.targetBody;
      break;
    }
  }

  const swapped: AiSegment = { kind: "punch", punch, token: `swap:${seg.token}` };
  if (targetBody) swapped.targetBody = true;
  rt.segments[slot] = swapped;
  // The lookahead described the segment that just stopped existing.
  rt.plan = [];
  return true;
}

/**
 * Is there a punch within the planning horizon, counting the segment about to
 * fire? This is what lets a move segment know it is setting something up
 * rather than just repositioning.
 */
function planHasPunch(rt: AiStringRuntime): boolean {
  if (rt.plan.length > 0) return rt.plan.some((st) => st.kind === "punch");
  // The lookahead plan is only built inside the runner, so a string that was
  // started this tick still has none. Reading that as "no punch coming" is what
  // let the reflex layer cancel every fresh assault in its first frame: the AI
  // opened a string, lost it before a segment ran, opened another, and threw
  // once a second while doing it. With no plan yet, the segments it was started
  // with are the honest answer.
  for (let slot = Math.max(0, rt.index); slot < rt.segments.length; slot++) {
    if (rt.segments[slot]?.kind === "punch") return true;
  }
  return false;
}

// ===== RUNTIME STATE =====

export function createAiStringRuntime(): AiStringRuntime {
  return {
    active: false,
    stringId: -1,
    segments: [],
    index: 0,
    beatTimer: 0,
    stack: [],
    holdKind: "none",
    holdTimer: 0,
    moveDir: null,
    outDeflect: 0,
    outStallTicks: 0,
    outLastX: -1,
    outLastZ: -1,
    returnDistPx: -1,
    rangeWaitTimer: 0,
    inRangeTime: 0,
    throwCount: 0,
    extensions: 0,
    plan: [],
    chargeSlot: -1,
    lastDistPx: 0,
    pendingThrowSlot: -1,
    throwFailCount: 0,
    beats: {},
    bias: {},
    weight: {},
    pendingSlot: -1,
    landed: 0,
    whiffed: 0,
    consecutiveWhiffs: 0,
    runCount: 0,
    cancelCount: 0,
  };
}

/**
 * Idempotent backfill. HMR preserves live brains, and brains deserialised from
 * an older save predate the string engine entirely, so every entry point that
 * touches string state calls this first.
 */
export function ensureAiStringRuntime(brain: AiBrainState): AiStringRuntime {
  if (!brain.strings || typeof brain.strings !== "object") {
    brain.strings = createAiStringRuntime();
  }
  const rt = brain.strings;
  // Field-level backfill too: a brain from a half-upgraded build may have the
  // container but not a field added later.
  if (!rt.beats) rt.beats = {};
  if (!rt.bias) rt.bias = {};
  if (!rt.weight) rt.weight = {};
  if (!Array.isArray(rt.segments)) rt.segments = [];
  if (typeof rt.chargeSlot !== "number") rt.chargeSlot = -1;
  if (typeof rt.pendingSlot !== "number") rt.pendingSlot = -1;
  if (typeof rt.holdKind !== "string") rt.holdKind = "none";
  if (typeof rt.lastDistPx !== "number") rt.lastDistPx = 0;
  if (typeof rt.pendingThrowSlot !== "number") rt.pendingThrowSlot = -1;
  if (typeof rt.throwFailCount !== "number") rt.throwFailCount = 0;
  if (!Array.isArray(rt.stack)) rt.stack = [];
  if (typeof rt.returnDistPx !== "number") rt.returnDistPx = -1;
  if (typeof rt.rangeWaitTimer !== "number") rt.rangeWaitTimer = 0;
  if (typeof rt.inRangeTime !== "number") rt.inRangeTime = 0;
  if (typeof rt.throwCount !== "number") rt.throwCount = 0;
  if (typeof rt.extensions !== "number") rt.extensions = 0;
  if (typeof rt.outDeflect !== "number") rt.outDeflect = 0;
  if (typeof rt.outStallTicks !== "number") rt.outStallTicks = 0;
  if (typeof rt.outLastX !== "number") rt.outLastX = -1;
  if (typeof rt.outLastZ !== "number") rt.outLastZ = -1;
  if (!Array.isArray(rt.plan)) rt.plan = [];
  return rt;
}

/**
 * Forget a retreat's rope-slide state. Called wherever a move segment ends, so
 * the next one starts by trying straight back again rather than inheriting the
 * angle the last one was forced onto.
 */
function clearRetreatDeflect(rt: AiStringRuntime): void {
  rt.outDeflect = 0;
  rt.outStallTicks = 0;
  rt.outLastX = -1;
  rt.outLastZ = -1;
}

/** Per-fight reset. Learning maps are cleared: strings are re-solved each bout. */
export function resetAiStringRuntime(brain: AiBrainState): void {
  brain.strings = createAiStringRuntime();
}

// ===== BEAT ACCESS =====

/**
 * Each fighter leans on certain beats differently. The bias is rolled lazily
 * (not for all 200 strings up front) so an AI that never runs a string never
 * pays for it.
 */
function getBias(rt: AiStringRuntime, stringId: number): number {
  let b = rt.bias[stringId];
  if (b === undefined) {
    b = 0.70 + aiRNG.next01() * 0.75; // 0.70 .. 1.45
    rt.bias[stringId] = b;
  }
  return b;
}

function getBeatTable(rt: AiStringRuntime, def: AiStringDef): number[] {
  let table = rt.beats[def.id];
  if (!table || table.length !== def.segments.length) {
    const bias = getBias(rt, def.id);
    table = def.segments.map(() => quantizeBeat(BEAT_DEFAULT * bias));
    rt.beats[def.id] = table;
  }
  return table;
}

/**
 * Beat before the segment at `slot`. A beat that follows an armed charge is
 * clamped below CHARGE_RELEASE_WINDOW: stretching must never let the arm
 * expire mid-string, which would turn the charge segment into a dead beat.
 */
function getBeat(rt: AiStringRuntime, def: AiStringDef, slot: number): number {
  const table = getBeatTable(rt, def);
  let beat = table[slot] ?? BEAT_DEFAULT;
  if (slot > 0 && def.segments[slot - 1]?.kind === "charge") {
    beat = Math.min(beat, CHARGE_RELEASE_WINDOW * 0.6);
  }
  return clamp(beat, BEAT_MIN, BEAT_MAX);
}

/**
 * The beat actually used before the segment at `slot`, given where the fighter
 * is standing. Inside the pocket a punch loses its spacing entirely: the string
 * has already earned its position, and holding a rhythm there just hands the
 * opponent time to reset a guard between shots. Everything else keeps its beat.
 */
function nextBeat(
  rt: AiStringRuntime,
  def: AiStringDef,
  slot: number,
  distPx: number,
): number {
  const beat = getBeat(rt, def, slot);
  if (distPx <= STRING_POCKET_PX && rt.segments[slot]?.kind === "punch") {
    return Math.min(beat, STRING_POCKET_BEAT_MAX);
  }
  return beat;
}

function nudgeBeat(rt: AiStringRuntime, def: AiStringDef, slot: number, steps: number): void {
  const table = getBeatTable(rt, def);
  if (slot < 0 || slot >= table.length) return;
  table[slot] = quantizeBeat(table[slot] + steps * BEAT_STEP);
}

function getAdaptChance(brain: AiBrainState): number {
  return STRING_ADAPT_CHANCE[brain.difficultyBand] ?? 0.85;
}

function adapts(brain: AiBrainState): boolean {
  return aiRNG.next01() < getAdaptChance(brain);
}

// ===== SELECTION =====

export interface StringSelectContext {
  /** Current separation in pixels. */
  distPx: number;
  /** Distance the AI considers "in range". */
  attackRangePx: number;
  /**
   * The distance the engine will actually let this fighter throw from -- the
   * real reach gate, not the wider band it thinks in. Retreating segments stop
   * a step outside this.
   */
  hitRangePx: number;
  myStaminaFrac: number;
  oppStaminaFrac: number;
  /** Opponent stunned, rocked, or badly hurt -- opens the finishing categories. */
  oppHurt: boolean;
  /** Positive when the AI is ahead on the cards. */
  scoreLead: number;
  /**
   * 0 (even or ahead) .. 1 (being shut out) on landed punches this round. A
   * losing fighter trades its scripted non-punching segments for punches.
   */
  punchDeficit: number;
  /**
   * The fighter is hurt or gassed enough to be fighting to survive. Everything
   * that biases selection toward volume backs off while this is true.
   */
  survival: boolean;
  /** 0..1 skill scalar already computed by the brain. */
  difficultyScore: number;
  /**
   * 1 when the AI has a target in range and the gas to hit it. Drives cutting
   * out of a defensive string back into offence.
   */
  attackIntent: number;
  /**
   * Defensive timing, read off the opponent's last five punch intervals and the
   * range their punches land from. `ready` means a shot is close enough to be
   * worth stopping the beat for; `armNow` is the frame the block goes up.
   */
  blockSyncReady: boolean;
  blockSyncArmNow: boolean;
  /** Longest the beat may be held waiting for the predicted punch. */
  blockSyncMaxWait: number;
  /** False on bands that would cancel the string the moment it armed a block. */
  blockSyncInString: boolean;
}

/** How well a category's preferred range matches the current separation. */
function rangeFit(
  pref: "in" | "mid" | "out" | "any",
  distPx: number,
  attackRangePx: number,
): number {
  if (pref === "any") return 1;
  const ratio = attackRangePx > 0 ? distPx / attackRangePx : 1;
  if (pref === "in") return ratio <= 0.85 ? 1.35 : ratio <= 1.15 ? 0.9 : 0.35;
  if (pref === "mid") return ratio > 0.7 && ratio < 1.5 ? 1.25 : 0.6;
  // "out"
  return ratio >= 1.2 ? 1.3 : 0.55;
}

/**
 * Weighted pick across every eligible string. Returns null only if the library
 * itself is empty -- Fundamentals is gated at zero stamina and zero difficulty
 * precisely so there is always a legal answer.
 */
export function selectAiString(
  brain: AiBrainState,
  ctx: StringSelectContext,
  roles: readonly AiStringRole[] = ["offense", "mixed"],
): AiStringDef | null {
  const rt = ensureAiStringRuntime(brain);

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
    w *= rangeFit(meta.range, ctx.distPx, ctx.attackRangePx);
    w *= rt.weight[def.id] ?? 1;

    // Punch-shape fit. The engine pays 1.15x for hooks and uppercuts inside the
    // pocket and docks straights 0.85x there, and the relationship inverts as
    // the separation opens up. Two thirds of the AI's recorded output was jabs
    // and crosses thrown from inside the phone booth -- the worst punches it
    // owned at the range it was standing in. This is what fixes that, and it
    // fixes it at selection time so the whole sequence suits the range.
    const hookFrac = def.punchCount > 0 ? def.hookUpperCount / def.punchCount : 0.5;
    const pocketness =
      ctx.distPx <= STRING_POCKET_PX ? 1
      : ctx.distPx >= STRING_POCKET_PX * 2 ? -1
      : 1 - 2 * ((ctx.distPx - STRING_POCKET_PX) / STRING_POCKET_PX);
    w *= clamp(1 + (hookFrac - 0.5) * 2 * pocketness * STRING_RANGE_PUNCH_BIAS, 0.25, 2.0);

    // Aggression bias. Outside survival the fighter is looking to score, so the
    // punching categories carry the pick and the punch-dense strings inside
    // them are preferred while there is gas to run them. In survival the
    // library is left exactly as written -- that is when the defensive
    // sequences are the correct answer, not a handicap.
    if (!ctx.survival) {
      if (meta.role === "offense") w *= STRING_AGGRESSION_OFFENSE_BONUS;
      else if (meta.role === "defense") w *= STRING_AGGRESSION_DEFENSE_PENALTY;
      w *= 1 + def.punchCount * STRING_AGGRESSION_VOLUME_BONUS * ctx.myStaminaFrac;
    }

    // Long strings are expensive. The tireder the AI, the more a high punch
    // count counts against a string.
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

// ===== EXECUTION =====

export interface AiStringTick {
  /** Punch to throw this tick, if any. */
  punch: PunchType | null;
  /** Explicit body target from the notation; undefined means "AI decides". */
  targetBody: boolean | undefined;
  /** Release an armed charge with this punch. */
  useCharge: boolean;
  /** Arm a perfect block this tick (updateAI owns armAiPerfectBlock). */
  armPerfectBlock: boolean;
  /** Arm a charge this tick. */
  armCharge: boolean;
  /** The string ended this tick. */
  finished: boolean;
}

/** Beat the guard is held for behind a timed block before the string carries on. */
const BLOCK_SYNC_GUARD_BEAT = 0.18;

const IDLE_TICK: AiStringTick = {
  punch: null,
  targetBody: undefined,
  useCharge: false,
  armPerfectBlock: false,
  armCharge: false,
  finished: false,
};

function tick(partial: Partial<AiStringTick>): AiStringTick {
  return { ...IDLE_TICK, ...partial };
}

/** Role of the string currently running, or null when idle. */
export function currentStringRole(brain: AiBrainState): AiStringRole | null {
  const rt = ensureAiStringRuntime(brain);
  if (!rt.active) return null;
  const def = AI_STRINGS_BY_ID.get(rt.stringId);
  return def ? AI_STRING_CATEGORY_META[def.category].role : null;
}

/** Only one level of nesting: an insert may not itself be interrupted. */
const MAX_INSERT_DEPTH = 1;
/**
 * Per-boundary chance of cutting out of a defensive string into offence, by
 * band. Defensive sequences are worth running -- they are how the AI survives a
 * burst -- but at the top bands they are a beat inside an attack rather than a
 * place to live, so Champion leaves one almost as soon as there is a target.
 */
const INSERT_CHANCE_FROM_DEFENSE: Record<string, number> = {
  Easy: 0.20, Medium: 0.30, Hard: 0.55, Hardcore: 0.75,
};
/** Per-boundary chance of cutting a running string short to jump a hurt opponent. */
const INSERT_CHANCE_ON_OPENING = 0.10;

/**
 * Cut into the running string with a different one, resuming the original
 * afterwards. Refused mid-throw, since the outer string would come back owning
 * a punch it never threw.
 */
/**
 * True while the fighter is mid-assault: an offence-role string is running and
 * it still has a punch to throw.
 *
 * Everything that would ordinarily give ground -- the too-close retreat, the
 * step-out reaction, the flinch after being hit -- reads this and holds
 * position instead. Backing out of an assault is how a sequence ends up thrown
 * from the edge of reach, where nothing lands; the answer to being punched
 * while punching is a block or a slip, not a walk backwards.
 */
export function isAiStringAssault(brain: AiBrainState): boolean {
  const rt = ensureAiStringRuntime(brain);
  if (!rt.active) return false;
  if (currentStringRole(brain) === "defense") return false;
  return planHasPunch(rt);
}

export function insertAiString(
  brain: AiBrainState,
  enemy: FighterState,
  def: AiStringDef,
): boolean {
  const rt = ensureAiStringRuntime(brain);
  if (!rt.active || rt.stack.length >= MAX_INSERT_DEPTH) return false;
  // Never cut while a punch is unresolved. pendingThrowSlot is a throw waiting
  // on the engine's accept/refuse; pendingSlot is an accepted punch still
  // waiting on its hit/whiff verdict. Suspending the outer string in either
  // state would hand its result to whatever is running when the verdict lands.
  if (rt.pendingThrowSlot >= 0 || rt.pendingSlot >= 0) return false;

  // Release the outer string's hold before suspending it.
  if (rt.holdKind === "duck" && enemy.defenseState === "duck") {
    enemy.defenseState = "none";
  }

  rt.stack.push({
    stringId: rt.stringId,
    segments: rt.segments,
    index: rt.index,
    landed: rt.landed,
    whiffed: rt.whiffed,
    returnDistPx: rt.returnDistPx,
  });

  rt.stringId = def.id;
  rt.segments = def.segments.map((sg) => ({ ...sg }));
  rt.index = 0;
  rt.beatTimer = 0;
  rt.holdKind = "none";
  rt.holdTimer = 0;
  rt.moveDir = null;
  rt.returnDistPx = -1;
  rt.rangeWaitTimer = 0;
  rt.plan = [];
  rt.chargeSlot = -1;
  rt.pendingSlot = -1;
  rt.pendingThrowSlot = -1;
  rt.throwFailCount = 0;
  rt.landed = 0;
  rt.whiffed = 0;
  rt.consecutiveWhiffs = 0;
  rt.extensions = 0;
  rt.runCount++;
  return true;
}

/**
 * Sequences the AI will chain onto the end of a running string instead of
 * stopping there, by band.
 */
const STRING_EXTEND_CHANCE: Record<string, number> = {
  Easy: 0.05, Medium: 0.18, Hard: 0.40, Hardcore: 0.65,
};
/** Ceiling on chained extensions, so one string cannot become the whole round. */
const STRING_MAX_EXTENSIONS = 3;

/**
 * ===== EXTENSION =====
 * A string that has run out of segments while the fighter is still in the
 * pocket, with gas and someone to hit, has finished a sentence rather than a
 * thought. Dropping back to idle there hands the initiative straight back --
 * the attack-think cadence then makes the AI wait before it may start again,
 * which is most of the dead air in the recorded rounds.
 *
 * Instead the next sequence is appended onto the working copy and the same run
 * carries on into it. The library definition is untouched, so the appended
 * slots fall back to the default beat and the run is still scored and weighted
 * against the string that started it.
 */
function tryExtendAiString(
  brain: AiBrainState,
  rt: AiStringRuntime,
  ctx: StringSelectContext,
): boolean {
  // An insert has a parent waiting underneath it; that is its continuation.
  if (rt.stack.length > 0) return false;
  if (rt.extensions >= STRING_MAX_EXTENSIONS) return false;
  if (ctx.survival || ctx.attackIntent <= 0) return false;
  if (ctx.myStaminaFrac < 0.20) return false;
  if (ctx.distPx > ctx.attackRangePx) return false;

  let chance = STRING_EXTEND_CHANCE[brain.difficultyBand] ?? 0;
  chance += Math.max(ctx.punchDeficit, outputDeficit(rt)) * 0.35;
  if (ctx.oppHurt) chance += 0.25;
  if (!aiRNG.chance(clamp(chance, 0, 0.95))) return false;

  const next = selectAiString(brain, ctx, ["offense", "mixed"]);
  if (!next) return false;
  for (const sg of next.segments) rt.segments.push({ ...sg });
  rt.extensions++;
  rt.plan = [];
  return true;
}

export function isAiStringActive(brain: AiBrainState): boolean {
  const rt = ensureAiStringRuntime(brain);
  return rt.active;
}

export function startAiString(brain: AiBrainState, def: AiStringDef): void {
  const rt = ensureAiStringRuntime(brain);
  rt.active = true;
  rt.stringId = def.id;
  // Copy the segments: learning trims and reorders the working list, and the
  // library definition must stay pristine for every other fighter.
  rt.segments = def.segments.map((s) => ({ ...s }));
  rt.index = 0;
  rt.beatTimer = 0;
  rt.holdKind = "none";
  rt.holdTimer = 0;
  rt.moveDir = null;
  rt.returnDistPx = -1;
  rt.rangeWaitTimer = 0;
  rt.plan = [];
  rt.chargeSlot = -1;
  rt.pendingSlot = -1;
  rt.pendingThrowSlot = -1;
  rt.throwFailCount = 0;
  rt.landed = 0;
  rt.whiffed = 0;
  rt.consecutiveWhiffs = 0;
  rt.extensions = 0;
  rt.runCount++;
}

/**
 * Stop the current string. `saveStamina` marks it as a deliberate bail-out
 * (repeated whiffs, opponent out of range) rather than a natural finish, which
 * feeds the selection-weight update.
 */
export function cancelAiString(
  brain: AiBrainState,
  enemy: FighterState | null,
  saveStamina: boolean,
): void {
  const rt = ensureAiStringRuntime(brain);
  if (!rt.active) return;

  // Release any hold this string was maintaining, or the AI stays crouched or
  // blocking after the string that asked for it is gone. When called without a
  // fighter ref the crouch simply expires on its own duckTimer instead.
  if (enemy && rt.holdKind === "duck" && enemy.defenseState === "duck") {
    enemy.defenseState = "none";
  }
  rt.holdKind = "none";
  rt.holdTimer = 0;
  rt.moveDir = null;
  rt.returnDistPx = -1;
  rt.rangeWaitTimer = 0;
  rt.plan = [];

  if (saveStamina && rt.stringId >= 0) {
    rt.cancelCount++;
    // A string that keeps getting bailed out of is a string that is not working.
    const prev = rt.weight[rt.stringId] ?? 1;
    rt.weight[rt.stringId] = clamp(prev * 0.85, 0.15, 4);
  }

  rt.active = false;
  rt.stringId = -1;
  rt.segments = [];
  rt.index = 0;
  // A cancel abandons the whole nest, not just the string on top of it.
  rt.stack = [];
  rt.pendingSlot = -1;
  rt.pendingThrowSlot = -1;
  rt.throwFailCount = 0;
  rt.chargeSlot = -1;
  clearRetreatDeflect(rt);
}

function finishAiString(brain: AiBrainState, enemy: FighterState): AiStringTick {
  const rt = ensureAiStringRuntime(brain);
  const id = rt.stringId;

  if (id >= 0 && (rt.landed > 0 || rt.whiffed > 0)) {
    // Weight the string by how well it actually worked this bout.
    const hitRate = rt.landed / Math.max(1, rt.landed + rt.whiffed);
    const prev = rt.weight[id] ?? 1;
    const target = 0.5 + hitRate * 1.3; // 0.5 (all whiffs) .. 1.8 (all landed)
    rt.weight[id] = clamp(prev * 0.7 + target * 0.3, 0.15, 4);
  }

  if (rt.holdKind === "duck" && enemy.defenseState === "duck") {
    enemy.defenseState = "none";
  }
  rt.holdKind = "none";
  rt.holdTimer = 0;
  rt.moveDir = null;
  clearRetreatDeflect(rt);
  rt.returnDistPx = -1;
  rt.rangeWaitTimer = 0;
  rt.plan = [];
  rt.pendingSlot = -1;
  rt.pendingThrowSlot = -1;
  rt.throwFailCount = 0;
  rt.chargeSlot = -1;

  // If this string was inserted into another, pick the outer one back up where
  // it was interrupted rather than dropping out of offence entirely.
  const parent = rt.stack.pop();
  if (parent) {
    rt.stringId = parent.stringId;
    rt.segments = parent.segments;
    rt.index = parent.index;
    rt.beatTimer = 0;
    rt.landed = parent.landed;
    rt.whiffed = parent.whiffed;
    rt.consecutiveWhiffs = 0;
    // The outer string picks its own debts back up, and re-plans from where it
    // was interrupted rather than from the inserted string's horizon.
    rt.returnDistPx = parent.returnDistPx ?? -1;
    rt.plan = [];
    return tick({});
  }

  rt.active = false;
  rt.stringId = -1;
  rt.segments = [];
  rt.index = 0;
  return tick({ finished: true });
}

/**
 * Advance the running string by dt. Non-punch segments are applied here;
 * punches are described in the returned tick for updateAI to execute.
 */
export function updateAiStringRunner(
  brain: AiBrainState,
  enemy: FighterState,
  player: FighterState,
  dt: number,
  ctx: StringSelectContext,
): AiStringTick {
  const rt = ensureAiStringRuntime(brain);
  rt.lastDistPx = ctx.distPx;

  // Output is measured against time spent in range, not wall-clock: a fighter
  // that cannot reach anyone is not being out-worked, it is being out-moved,
  // and that is the movement layer's problem rather than the strings'.
  if (ctx.distPx <= ctx.attackRangePx * STRING_RANGE_MULT) rt.inRangeTime += dt;

  if (!rt.active) return IDLE_TICK;

  // A punch already went out this tick and nobody has told us whether the
  // engine took it. Idle until confirmAiStringPunch resolves it rather than
  // re-issuing the same segment every frame.
  if (rt.pendingThrowSlot >= 0) return IDLE_TICK;

  // Hard stops. A knocked-down or gassed fighter has no business continuing.
  if (enemy.isKnockedDown || enemy.stamina <= 0 || enemy.stunPunchDisableTimer > 0) {
    cancelAiString(brain, enemy, false);
    return IDLE_TICK;
  }

  let def = AI_STRINGS_BY_ID.get(rt.stringId);
  if (!def) {
    cancelAiString(brain, enemy, false);
    return IDLE_TICK;
  }

  syncStringPlan(rt, def);

  // ===== RANGE GATE =====
  // Nothing runs from outside striking distance. The moment the fighter leaves
  // it the current segment ends -- which is what stops a movement-heavy string
  // from walking the fight apart -- and the string parks with its place, its
  // beat and its lookahead intact until the fighter has closed back in. This is
  // also what a freshly started string waits on before its first segment.
  if (ctx.distPx > ctx.attackRangePx * STRING_RANGE_MULT) {
    if (rt.holdKind !== "none") {
      if (rt.holdKind === "duck" && enemy.defenseState === "duck") {
        enemy.defenseState = "none";
      }
      rt.holdKind = "none";
      rt.holdTimer = 0;
      rt.moveDir = null;
      clearRetreatDeflect(rt);
    }
    rt.rangeWaitTimer += dt;
    // The opponent has simply left. Write the string off rather than shadowing
    // them around the ring holding a sequence that will never fire.
    if (rt.rangeWaitTimer > STRING_RANGE_WAIT_MAX) {
      cancelAiString(brain, enemy, true);
    }
    return IDLE_TICK;
  }
  rt.rangeWaitTimer = 0;

  // A defensive beat. The string stops where it is and waits with its hands
  // rather than walking onto the punch it can see coming; the beat is paused,
  // not spent, so the remaining segments run untouched once this clears.
  if (rt.holdKind === "blockSync") {
    rt.holdTimer -= dt;
    if (ctx.blockSyncArmNow) {
      // Hold the guard for a beat behind the block rather than punching out of
      // it on the very next tick.
      rt.holdKind = "block";
      rt.holdTimer = BLOCK_SYNC_GUARD_BEAT;
      return tick({ armPerfectBlock: true });
    }
    // The read expired, or the opponent backed off it. Give the beat back.
    if (rt.holdTimer > 0 && ctx.blockSyncReady) return IDLE_TICK;
    rt.holdKind = "none";
    rt.holdTimer = 0;
  }

  // Maintain an active hold (duck / block / movement) for its beat.
  if (rt.holdKind !== "none") {
    rt.holdTimer -= dt;
    if (rt.holdKind === "duck" && !enemy.isPunching) {
      // Re-assert each tick: the defence layer overwrites defenseState freely.
      enemy.defenseState = "duck";
      enemy.duckTimer = Math.max(enemy.duckTimer, 0.1);
    }

    if (rt.holdKind === "return") {
      // Walking back the ground a move segment gave up. Ends on arrival, or on
      // the safety timer when the opponent keeps backing away.
      const arrived = ctx.distPx <= rt.returnDistPx + STRING_RETURN_TOLERANCE_PX;
      if (!arrived && rt.holdTimer > 0) return IDLE_TICK;
      rt.holdKind = "none";
      rt.moveDir = null;
      clearRetreatDeflect(rt);
      rt.returnDistPx = -1;
    } else {
      // A retreat is done the moment it is out of the fighter's own punching
      // distance. Running the rest of the beat just puts ground between them
      // that the string has to give back before it can throw again.
      if (
        rt.holdKind === "move" &&
        rt.holdTimer > 0 &&
        rt.moveDir === "out" &&
        ctx.hitRangePx > 0 &&
        ctx.distPx >= ctx.hitRangePx + STRING_RETREAT_MARGIN_PX
      ) {
        rt.holdTimer = 0;
      }
      // Momentum: a move that is setting up a punch has nothing left to gain
      // once the fighter is already inside striking range, so it gives the rest
      // of its time back to the punch instead of drifting through it.
      if (
        rt.holdKind === "move" &&
        rt.holdTimer > 0 &&
        planHasPunch(rt) &&
        ctx.distPx <= ctx.attackRangePx * 0.95
      ) {
        rt.holdTimer = 0;
      }
      if (rt.holdTimer > 0) return IDLE_TICK;
      if (rt.holdKind === "duck" && enemy.defenseState === "duck") {
        enemy.defenseState = "none";
      }
      const wasMove = rt.holdKind === "move";
      rt.holdKind = "none";
      rt.moveDir = null;
      clearRetreatDeflect(rt);

      // A move that gave up ground and has a punch coming behind it closes back
      // to the exact separation it left from before the string carries on, so
      // the punch is thrown from a range it can actually land at. Planning two
      // segments ahead is what lets this start now rather than after whatever
      // duck or charge sits between the move and the punch.
      if (
        wasMove &&
        rt.returnDistPx >= 0 &&
        planHasPunch(rt) &&
        ctx.distPx > rt.returnDistPx + STRING_RETURN_TOLERANCE_PX
      ) {
        rt.holdKind = "return";
        rt.moveDir = "in";
        rt.holdTimer = STRING_RETURN_MAX_TIME;
        return IDLE_TICK;
      }
    }
  }

  rt.beatTimer -= dt;
  if (rt.beatTimer > 0) return IDLE_TICK;

  // ===== REACTIVE INSERTION =====
  // A segment boundary is the only safe place to cut. The main case is bailing
  // out of a defensive string the moment the AI wants to throw again; it will
  // also cut a longer sequence short to jump on a hurt opponent.
  if (rt.stack.length < MAX_INSERT_DEPTH && rt.index > 0 && rt.index < rt.segments.length) {
    const role = AI_STRING_CATEGORY_META[def.category].role;
    const wantsOffense = ctx.attackIntent > 0 && ctx.myStaminaFrac > 0.12;
    const fromDefense = INSERT_CHANCE_FROM_DEFENSE[brain.difficultyBand] ?? 0.35;
    // Being out-worked is as good a reason to cut into offence as a hurt
    // opponent is: both mean the script the AI is running is not the answer.
    const openingNow = ctx.oppHurt || ctx.punchDeficit > 0.2;
    const chance = role === "defense" && wantsOffense
      ? fromDefense
      : (wantsOffense && openingNow ? INSERT_CHANCE_ON_OPENING : 0);

    if (chance > 0 && aiRNG.chance(chance)) {
      const cut = selectAiString(brain, ctx, ["offense"]);
      if (cut && cut.id !== rt.stringId && insertAiString(brain, enemy, cut)) {
        def = cut;
      }
    }
  }

  // ===== DEFENSIVE SEGMENT =====
  // The offensive read is the rhythm-cut sync; this is the same read pointed at
  // defence. The opponent's last five punch intervals say when the next one is
  // due, and the range their punches land from says whether it can reach. When
  // both line up, the string spends this boundary on a block instead of a shot.
  if (
    ctx.blockSyncInString &&
    ctx.blockSyncReady &&
    rt.holdKind === "none" &&
    !enemy.isPunching &&
    rt.index < rt.segments.length &&
    planHasPunch(rt)
  ) {
    if (ctx.blockSyncArmNow) {
      rt.holdKind = "block";
      rt.holdTimer = BLOCK_SYNC_GUARD_BEAT;
      return tick({ armPerfectBlock: true });
    }
    rt.holdKind = "blockSync";
    rt.holdTimer = ctx.blockSyncMaxWait;
    return IDLE_TICK;
  }

  if (rt.index >= rt.segments.length) {
    // Offence meshes into the string rather than stopping at its last segment.
    if (!tryExtendAiString(brain, rt, ctx)) return finishAiString(brain, enemy);
    syncStringPlan(rt, def);
  }

  const slot = rt.index;
  let seg = rt.segments[slot];

  // Losing the exchange count turns quiet segments into punches.
  if (maybeSwapForOffense(rt, slot, seg, enemy, ctx)) {
    seg = rt.segments[slot];
    syncStringPlan(rt, def);
  }

  switch (seg.kind) {
    case "punch": {
      // Don't overwrite a punch already in flight -- wait rather than drop the
      // segment, so a fast string paces itself against the animation instead of
      // silently losing shots.
      if (enemy.isPunching) return IDLE_TICK;

      // Last chance to pay back ground given up earlier in the string. The
      // hold-completion path covers the usual case; this catches a move that
      // was cut short by the range gate, where no hold was left to expire.
      if (rt.returnDistPx >= 0) {
        if (ctx.distPx > rt.returnDistPx + STRING_RETURN_TOLERANCE_PX) {
          rt.holdKind = "return";
          rt.moveDir = "in";
          rt.holdTimer = STRING_RETURN_MAX_TIME;
          return IDLE_TICK;
        }
        rt.returnDistPx = -1;
      }

      // The engine may refuse this throw (telegraph lockout, reach gate), so the
      // segment is only consumed once confirmAiStringPunch reports it accepted.
      // Advancing here would silently drop shots out of the middle of a string.
      const releasingCharge = rt.chargeSlot >= 0 && enemy.chargeArmed;
      rt.pendingThrowSlot = slot;
      return tick({
        punch: seg.punch ?? "jab",
        targetBody: seg.targetBody,
        useCharge: releasingCharge,
      });
    }

    case "charge": {
      rt.chargeSlot = slot;
      rt.index++;
      rt.beatTimer = rt.index < rt.segments.length ? nextBeat(rt, def, rt.index, ctx.distPx) : 0;
      return tick({ armCharge: true });
    }

    case "block": {
      rt.index++;
      rt.holdKind = "block";
      rt.holdTimer = getBeat(rt, def, slot);
      rt.beatTimer = rt.index < rt.segments.length ? nextBeat(rt, def, rt.index, ctx.distPx) : 0;
      return tick({ armPerfectBlock: true });
    }

    case "duck": {
      rt.index++;
      rt.holdKind = "duck";
      rt.holdTimer = getBeat(rt, def, slot);
      rt.beatTimer = rt.index < rt.segments.length ? nextBeat(rt, def, rt.index, ctx.distPx) : 0;
      if (!enemy.isPunching) {
        enemy.defenseState = "duck";
        enemy.duckTimer = Math.max(enemy.duckTimer, rt.holdTimer);
      }
      return IDLE_TICK;
    }

    case "switchStance": {
      rt.index++;
      rt.beatTimer = rt.index < rt.segments.length ? nextBeat(rt, def, rt.index, ctx.distPx) : 0;
      const next: BoxingStance = enemy.boxingStance === "orthodox" ? "southpaw" : "orthodox";
      enemy.boxingStance = next;
      // Keep the automatic clean-hit-streak switcher from immediately flipping
      // back on top of a switch the string asked for.
      brain.stanceSwitchTimer = brain.stanceSwitchDuration || 20;
      brain.stanceCleanHitStreak = 0;
      return IDLE_TICK;
    }

    case "move": {
      rt.index++;
      rt.holdKind = "move";
      rt.moveDir = seg.moveDir ?? "in";
      clearRetreatDeflect(rt);
      rt.holdTimer = getBeat(rt, def, slot);
      rt.beatTimer = rt.index < rt.segments.length ? nextBeat(rt, def, rt.index, ctx.distPx) : 0;
      // Remember where this move is leaving from. Every direction is recorded,
      // including "in": the debt is only collected if the fighter actually ends
      // up further out than it started, so closing costs nothing.
      rt.returnDistPx = ctx.distPx;
      return IDLE_TICK;
    }
  }

  return IDLE_TICK;
}

/**
 * Override the brain's movement intent while a movement segment is held.
 * Called after thinkMovement, which writes desiredMoveInput/desiredMoveZ every
 * tick and would otherwise stomp the string's instruction.
 */
export function applyAiStringMovement(
  brain: AiBrainState,
  enemy: FighterState,
  player: FighterState,
): void {
  const rt = ensureAiStringRuntime(brain);
  if (!rt.active) return;

  const dx = player.x - enemy.x;
  const dz = player.z - enemy.z;
  const len = Math.sqrt(dx * dx + dz * dz);
  if (len < 0.001) return;

  // An offensive sequence with a punch still to come keeps walking in until it
  // is in the pocket. Standing off at the edge of reach and throwing anyway is
  // what produced a round of punches that never touched anyone: the shots that
  // land are the ones thrown from inside, and the string has to go and get
  // there rather than settle for the range the fight happened to be at.
  const wantsPocket =
    rt.holdKind === "none" &&
    len > STRING_POCKET_PX &&
    planHasPunch(rt) &&
    currentStringRole(brain) !== "defense";

  // Parked outside range, or walking back to the separation a move gave up:
  // both mean "close", whatever the string's own movement was doing.
  const closing = rt.rangeWaitTimer > 0 || rt.holdKind === "return" || wantsPocket;
  if (!closing && (rt.holdKind !== "move" || !rt.moveDir)) return;
  const dirX = dx / len;
  const dirZ = dz / len;
  // Perpendicular, for circling.
  const perpX = -dirZ;
  const perpZ = dirX;

  // A retreat that stops making ground is pinned -- against the ropes, or into
  // a corner. Rather than spend the rest of the beat walking into the wall, the
  // segment keeps retreating along it: the first stall picks a side, each
  // further stall (a corner, or the wrong side chosen) tries the other one.
  if (!closing && rt.moveDir === "out") {
    if (rt.outLastX >= 0) {
      const movedX = enemy.x - rt.outLastX;
      const movedZ = enemy.z - rt.outLastZ;
      if (Math.sqrt(movedX * movedX + movedZ * movedZ) < STRING_WALL_STALL_PX) {
        rt.outStallTicks++;
        if (rt.outStallTicks >= STRING_WALL_STALL_TICKS) {
          rt.outDeflect = rt.outDeflect === 0
            ? (aiRNG.chance(0.5) ? 1 : -1)
            : -rt.outDeflect;
          rt.outStallTicks = 0;
        }
      } else {
        rt.outStallTicks = 0;
      }
    }
    rt.outLastX = enemy.x;
    rt.outLastZ = enemy.z;
  }

  // An "out" beat inside an assault is an angle change, not an exit: the string
  // gave up the pocket it just walked into, and the punches still queued behind
  // it would come out from range. Pivot around the opponent instead and keep
  // the separation the sequence was written for.
  const pocketHold =
    rt.moveDir === "out" &&
    len <= STRING_POCKET_PX * STRING_POCKET_HOLD_MULT &&
    isAiStringAssault(brain);
  if (pocketHold && rt.outDeflect === 0) rt.outDeflect = aiRNG.chance(0.5) ? 1 : -1;

  let mx = 0;
  let mz = 0;
  switch (closing ? "in" : rt.moveDir) {
    case "in":    mx = dirX;   mz = dirZ;   break;
    case "out":
      if (rt.outDeflect !== 0) { mx = perpX * rt.outDeflect;  mz = perpZ * rt.outDeflect; }
      else                     { mx = -dirX;                  mz = -dirZ; }
      break;
    case "left":  mx = perpX;  mz = perpZ;  break;
    case "right": mx = -perpX; mz = -perpZ; break;
  }

  brain.desiredMoveInput = clamp(mx, -1, 1);
  brain.desiredMoveZ = clamp(mz, -1, 1);
}

// ===== LEARNING =====

/**
 * Verdict on the punch thrown by the current string segment.
 *
 * Hit  -> tighten this slot's beat toward BEAT_MIN. The timing worked; run it
 *         closer together next time.
 * Whiff -> stretch it toward BEAT_MAX, and reconsider the rest of the string.
 *
 * Both are gated on the band's adapt chance, which is what separates a
 * Champion (95%) from a Journeyman (65%).
 */
/**
 * How many consecutive refused throws before a string is written off. At 60fps
 * this is about half a second of being unable to throw, which in practice means
 * the opponent has walked out of range or the fighter is locked out.
 */
const MAX_THROW_RETRIES = 30;

/**
 * Report whether the engine accepted the punch the runner just handed over.
 * Only an accepted throw consumes the segment: the engine legitimately refuses
 * throws during telegraph lockout and outside the reach gate, and advancing on
 * a refusal would silently drop shots out of the middle of a string.
 */
/**
 * Decline the offered throw without spending retry budget, for a wait whose end
 * is known rather than hoped for. The gas hold lapses exactly when the burst
 * window does -- up to a full second -- while MAX_THROW_RETRIES is only about
 * half that at 60fps, so confirming a refusal every tick would cancel the string
 * part-way through instead of letting it pick the beat back up on the far side.
 */
export function holdAiStringThrow(brain: AiBrainState): void {
  const rt = ensureAiStringRuntime(brain);
  if (!rt.active || rt.pendingThrowSlot < 0) return;
  rt.pendingThrowSlot = -1;
}

export function confirmAiStringPunch(
  brain: AiBrainState,
  enemy: FighterState,
  accepted: boolean,
): void {
  const rt = ensureAiStringRuntime(brain);
  if (!rt.active || rt.pendingThrowSlot < 0) return;
  // Counted here, behind the guard: the output rate is the *string engine's*
  // throughput. A punch thrown by anything else -- a reflex, a legacy path, a
  // late confirmation for a string that has already ended -- would inflate it
  // and hide exactly the idle runner the measure exists to catch.
  if (accepted) rt.throwCount++;

  const slot = rt.pendingThrowSlot;
  rt.pendingThrowSlot = -1;

  if (!accepted) {
    rt.throwFailCount++;
    if (rt.throwFailCount >= MAX_THROW_RETRIES) cancelAiString(brain, enemy, true);
    return;
  }

  rt.throwFailCount = 0;
  // The charge is only spent once a punch actually goes out behind it.
  rt.chargeSlot = -1;
  rt.index = slot + 1;
  rt.pendingSlot = slot;

  const def = AI_STRINGS_BY_ID.get(rt.stringId);
  // A zero beat at the tail lets the next tick run the natural finish path.
  rt.beatTimer = def && rt.index < rt.segments.length ? nextBeat(rt, def, rt.index, rt.lastDistPx) : 0;
}

export function notifyAiStringPunchResolved(
  brain: AiBrainState,
  landed: boolean,
): void {
  const rt = ensureAiStringRuntime(brain);
  if (!rt.active || rt.pendingSlot < 0) return;

  const def = AI_STRINGS_BY_ID.get(rt.stringId);
  const slot = rt.pendingSlot;
  rt.pendingSlot = -1;
  rt.pendingThrowSlot = -1;
  rt.throwFailCount = 0;
  if (!def) return;

  if (landed) {
    rt.landed++;
    rt.consecutiveWhiffs = 0;
    if (adapts(brain)) nudgeBeat(rt, def, slot, -1);
    return;
  }

  rt.whiffed++;
  rt.consecutiveWhiffs++;
  if (adapts(brain)) nudgeBeat(rt, def, slot, +1);

  // Recalculate: is the opponent simply leaving? Continuing a long string at a
  // retreating target burns stamina for nothing, which is the exact failure the
  // spec calls out.
  const outOfRange = rt.lastDistPx > brain.attackRangeMax * 1.35;
  const remaining = rt.segments.length - rt.index;

  if (rt.consecutiveWhiffs >= 2 && (outOfRange || remaining >= 3) && adapts(brain)) {
    cancelAiString(brain, null, true);
    return;
  }

  // Otherwise trim the tail: drop the last segment so a string that is running
  // long against a moving target gets shorter the next time it is chosen.
  if (rt.consecutiveWhiffs >= 3 && remaining > 1 && adapts(brain)) {
    rt.segments.splice(rt.segments.length - 1, 1);
  }
}

/** Debug snapshot for the tuning UI / logs. */
export function describeAiStringState(brain: AiBrainState): string {
  const rt = ensureAiStringRuntime(brain);
  if (!rt.active) {
    return `idle (ran ${rt.runCount}, cancelled ${rt.cancelCount})`;
  }
  const def = AI_STRINGS_BY_ID.get(rt.stringId);
  const name = def ? `#${def.id} ${def.name}` : `#${rt.stringId}`;
  const waiting = rt.rangeWaitTimer > 0 ? ` waitRange=${rt.rangeWaitTimer.toFixed(2)}s` : "";
  const owed = rt.returnDistPx >= 0 ? ` returnTo=${rt.returnDistPx.toFixed(0)}px` : "";
  const plan = rt.plan.map((st) => st.kind).join(">") || "-";
  return `${name} [${rt.index}/${rt.segments.length}] beat=${rt.beatTimer.toFixed(3)} hold=${rt.holdKind}${waiting}${owed} plan=${plan} landed=${rt.landed} whiffed=${rt.whiffed}`;
}
