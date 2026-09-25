/**
 * AI PATTERN MEMORY
 * =================
 * The AI watches the offensive actions its opponent throws, chunks them into
 * three-action patterns, and remembers the ones it sees repeated. Once a
 * pattern is recognized, seeing its opening action again lets the AI run a
 * prepared answer to all three actions instead of reacting to each one cold.
 *
 * WHAT COUNTS AS AN ACTION
 * ------------------------
 * A punch, a feint, arming a charge, and ducking to work the body. Footwork is
 * deliberately not an action: position is already the context, and there is no
 * prepared answer to a step.
 *
 * A punch is recorded with everything that changes the answer to it: which
 * punch, which glove it comes off, whether it goes upstairs or down, and the
 * stance it was thrown from. Two of those are worth spelling out. The glove is
 * a property of the punch name alone -- a jab is the left hand in this engine
 * whatever the stance -- so it is derived rather than stored. The stance is
 * not: the same hand throwing the same punch from orthodox and from southpaw
 * is a lead hand one way and a rear hand the other, which is a different punch
 * arriving on a different line, and a prepared answer to one is the wrong
 * answer to the other.
 *
 * CONTEXT
 * -------
 * A pattern is only the same pattern if it starts from the same place. The
 * context is the separation between the fighters -- bucketed, because nobody
 * repeats a combination from the exact same pixel -- plus the last punch the
 * AI landed, which is usually what provoked the answer in the first place. A
 * recognized pattern whose context does not match live is not a match.
 *
 * THE TWO GATES
 * -------------
 * Recognizing a pattern does not make it fire. The AI's existing per-difficulty
 * input-read chance is still the first gate and is untouched by this module;
 * only if that passes is the counter chance below rolled. So this layer can
 * never make the AI read more punches than it already did -- it only changes
 * what it does with the reads it wins.
 *
 * THIS MODULE IS PURE
 * -------------------
 * Recording, recognition, eviction and the counter chance live here. Executing
 * a counter -- arming blocks, ducks and slips -- lives in ai.ts, because that
 * is where the defensive primitives are.
 */

import { PUNCH_CONFIGS } from "./types";
import type { AiBrainState, AIDifficulty, BoxingStance, PunchType } from "./types";

// ===== TUNABLE CONFIG =========================================================

export interface AiPatternConfig {
  /** Master switch. Off leaves the AI's reads exactly as they were. */
  enabled: boolean;
  /** Actions thrown from further out than this are not worth remembering, and
   *  a combination being recorded does not survive stepping outside it. */
  observeRangePx: number;
  /** Distinct unrecognized patterns held at once before the weakest is dropped. */
  maxCandidates: number;
  /** Repeats needed before a pattern is armed, best fighters first. */
  recogChampion: number;
  recogElite: number;
  recogContender: number;
  recogJourneyman: number;
  /** How many armed patterns each tier can hold at once. */
  capChampion: number;
  capElite: number;
  capContender: number;
  capJourneyman: number;
  /** Counter chance at the moment of recognition, in percent. */
  baseChancePct: number;
  /** Added per repeat seen beyond the recognition threshold. */
  perRepeatPct: number;
  /** Subtracted per punch the AI has taken this bout without perfect blocking it. */
  perHitTakenPct: number;
  /** Multiplied in once per knockdown the AI itself has suffered. */
  knockdownMult: number;
  /** Ceiling, so a counter is never a certainty. */
  maxChancePct: number;
  /** Percent knocked off the counter chance while the AI is inside a stun window. */
  stunPenaltyPct: number;
  /** How long a scripted guard or duck is held when the punch never arrives. */
  holdSec: number;
  /** How far the step-out answer moves off the punch line. */
  stepOutPx: number;
  /** Scales every rung of the tape-study ladder. 0 switches career study off. */
  studyScale: number;
  /** Percent of a studied pattern's tape repeats the opponent walks in believing. */
  studyCarryPct: number;
  /** Ceiling on those carried repeats, so the heaviest tape still leaves room to build. */
  studyCarryMax: number;
  /** Combinations the career save keeps on the player before the weakest are dropped. */
  libraryMax: number;
}

export const DEFAULT_AI_PATTERN_CONFIG: AiPatternConfig = {
  enabled: true,
  observeRangePx: 95,
  maxCandidates: 50,
  recogChampion: 2,
  recogElite: 3,
  recogContender: 4,
  recogJourneyman: 5,
  capChampion: 10,
  capElite: 8,
  capContender: 7,
  capJourneyman: 6,
  baseChancePct: 75,
  perRepeatPct: 10,
  perHitTakenPct: 0.25,
  knockdownMult: 0.8,
  maxChancePct: 99,
  stunPenaltyPct: 1,
  holdSec: 0.5,
  stepOutPx: 5,
  studyScale: 1,
  studyCarryPct: 25,
  studyCarryMax: 2,
  libraryMax: 150,
};

/** Editable range per numeric field, used by the tuning card and the sanitizer. */
export const AI_PATTERN_RANGES: Record<Exclude<keyof AiPatternConfig, "enabled">, [number, number]> = {
  observeRangePx: [30, 200],
  maxCandidates: [5, 200],
  recogChampion: [1, 12],
  recogElite: [1, 12],
  recogContender: [1, 12],
  recogJourneyman: [1, 12],
  capChampion: [1, 40],
  capElite: [1, 40],
  capContender: [1, 40],
  capJourneyman: [1, 40],
  baseChancePct: [0, 100],
  perRepeatPct: [0, 50],
  perHitTakenPct: [0, 10],
  knockdownMult: [0.1, 1],
  maxChancePct: [0, 100],
  stunPenaltyPct: [0, 100],
  holdSec: [0.1, 2],
  stepOutPx: [1, 60],
  studyScale: [0, 3],
  studyCarryPct: [0, 100],
  studyCarryMax: [0, 20],
  libraryMax: [10, 1000],
};

/** Fields that only make sense as whole numbers. */
const AI_PATTERN_INT_KEYS: (keyof AiPatternConfig)[] = [
  "observeRangePx", "maxCandidates",
  "recogChampion", "recogElite", "recogContender", "recogJourneyman",
  "capChampion", "capElite", "capContender", "capJourneyman",
  "stepOutPx", "studyCarryMax", "libraryMax",
];

export function clampAiPatternField(key: Exclude<keyof AiPatternConfig, "enabled">, v: number): number {
  const [lo, hi] = AI_PATTERN_RANGES[key];
  if (!Number.isFinite(v)) return DEFAULT_AI_PATTERN_CONFIG[key];
  const clamped = Math.min(hi, Math.max(lo, v));
  return AI_PATTERN_INT_KEYS.includes(key) ? Math.round(clamped) : clamped;
}

export function sanitizeAiPatternConfig(cfg: Partial<AiPatternConfig>): AiPatternConfig {
  const out = { ...DEFAULT_AI_PATTERN_CONFIG };
  out.enabled = cfg.enabled !== false;
  for (const k of Object.keys(AI_PATTERN_RANGES) as (keyof typeof AI_PATTERN_RANGES)[]) {
    const raw = cfg[k];
    out[k] = clampAiPatternField(k, typeof raw === "number" ? raw : DEFAULT_AI_PATTERN_CONFIG[k]);
  }
  return out;
}

export function patternRecognitionThreshold(cfg: AiPatternConfig, difficulty: AIDifficulty): number {
  switch (difficulty) {
    case "champion": return cfg.recogChampion;
    case "elite": return cfg.recogElite;
    case "contender": return cfg.recogContender;
    default: return cfg.recogJourneyman;
  }
}

export function patternArmedCapacity(cfg: AiPatternConfig, difficulty: AIDifficulty): number {
  switch (difficulty) {
    case "champion": return cfg.capChampion;
    case "elite": return cfg.capElite;
    case "contender": return cfg.capContender;
    default: return cfg.capJourneyman;
  }
}

// ===== ACTION TOKENS ==========================================================
//
// One short string per action. Patterns are compared as strings, so the token
// is the whole definition of "the same action" -- a jab to the head and a jab
// to the body are different actions on purpose, because they need different
// answers.

export const PATTERN_TOKEN_CHARGE = "c";
export const PATTERN_TOKEN_DUCK = "d";

const STANCE_CODES: Record<BoxingStance, string> = { orthodox: "o", southpaw: "s" };

function stanceCode(stance: BoxingStance): string {
  return STANCE_CODES[stance] ?? "o";
}

function stanceFromCode(code: string): BoxingStance {
  return code === "s" ? "southpaw" : "orthodox";
}

/**
 * Which glove a punch comes off.
 *
 * Read straight off the punch table rather than mirrored here, because this is
 * the same fact the renderer and hit resolution work from and a second copy of
 * it would be one refactor away from disagreeing with them. Punch names are
 * absolute in this engine: a jab is the left hand and a cross the right, in
 * both stances. What stance changes is which of them is the lead hand, and
 * that rides in the token separately.
 */
export function punchHand(punch: PunchType | null): "left" | "right" | null {
  if (!punch) return null;
  const cfg = PUNCH_CONFIGS[punch];
  return cfg ? (cfg.isLeft ? "left" : "right") : null;
}

export function punchActionToken(punch: PunchType, aimsHead: boolean, stance: BoxingStance): string {
  return `p:${punch}:${aimsHead ? "h" : "b"}:${stanceCode(stance)}`;
}

export function feintActionToken(punch: PunchType, stance: BoxingStance): string {
  return `f:${punch}:${stanceCode(stance)}`;
}

/**
 * A saved token brought up to the current format.
 *
 * Two things joined a punch token after the first careers were written, and an
 * old one has to be read in light of both:
 *
 *   stance   was not recorded at all, so it is read as orthodox -- the default
 *            pose, and the one the large majority of careers box from.
 *   target   came off a flag that only hit resolution's ducking branch ever
 *            consulted, and that the human corner never set. Every punch on
 *            every career tape therefore says "body", whether it was thrown
 *            standing or not. Read back literally, a library would be nothing
 *            but body combinations the player has never thrown -- studied,
 *            taking up armed slots, and unable to match anything live. So an
 *            old punch is re-read as the head shot it almost certainly was,
 *            and the occasional genuine body shot is re-learned during a bout.
 *
 * Charges and ducks carry neither, so they are already current.
 */
function upgradeActionToken(token: string): string {
  if (typeof token !== "string" || token.length === 0) return token;
  if (token === PATTERN_TOKEN_CHARGE || token === PATTERN_TOKEN_DUCK) return token;
  const parts = token.split(":");
  if (parts[0] === "f") return parts.length >= 3 ? token : `f:${parts[1] ?? ""}:o`;
  if (parts[0] === "p") return parts.length >= 4 ? token : `p:${parts[1] ?? ""}:h:o`;
  return token;
}

export interface ParsedAction {
  kind: "punch" | "feint" | "charge" | "duck";
  punch: PunchType | null;
  /** Where it is aimed. A punch thrown out of a duck is body work, so this is
   *  what separates the ducked variation of a punch from the standing one. */
  head: boolean;
  /** Which glove it comes off, derived from the punch. Null for the actions
   *  that are not a punch. */
  hand: "left" | "right" | null;
  /** The pose it was thrown from, which decides whether that glove is the lead
   *  or the rear hand. Null for the actions that are not thrown. */
  stance: BoxingStance | null;
}

/** What kind of action a token is, and the punch behind it where there is one. */
export function parseActionToken(token: string): ParsedAction {
  if (token === PATTERN_TOKEN_CHARGE) return { kind: "charge", punch: null, head: true, hand: null, stance: null };
  if (token === PATTERN_TOKEN_DUCK) return { kind: "duck", punch: null, head: false, hand: null, stance: null };
  const parts = upgradeActionToken(token).split(":");
  const punch = (parts[1] as PunchType) ?? null;
  const hand = punchHand(punch);
  if (parts[0] === "f") {
    return { kind: "feint", punch, head: true, hand, stance: stanceFromCode(parts[2] ?? "o") };
  }
  return { kind: "punch", punch, head: parts[2] !== "b", hand, stance: stanceFromCode(parts[3] ?? "o") };
}

/**
 * The AI's last landed punch, as one comparable string.
 *
 * Separation used to be the other half of this, rounded into buckets. It is
 * not any more: bucketing split one combination into a row of near-identical
 * entries, so the same three punches thrown a few pixels further out read as
 * something new and had to be learned all over again. Range is a gate now
 * rather than an identity -- `observeRangePx` decides whether an action is
 * close enough to be worth remembering at all, and everything inside it counts
 * as the same combination.
 */
export function buildPatternContext(lastAiLanded: PunchType | null): string {
  return `${lastAiLanded ?? "-"}`;
}

// ===== READOUT ================================================================
//
// The under-the-hood overlay: what the AI has actually memorized, written out
// legibly. Kept here with the tokens themselves so the wording can never drift
// away from what the tokens mean, and so it stays testable without a canvas.

/** Punch names without a side on them: the glove is prefixed from the hand, so
 *  every row reads the same way instead of only the hooks and uppercuts
 *  carrying an L or an R. */
const PUNCH_LABELS: Record<PunchType, string> = {
  jab: "JAB",
  cross: "CROSS",
  leftHook: "HOOK",
  rightHook: "HOOK",
  leftUppercut: "UPPER",
  rightUppercut: "UPPER",
};

/** How many memorized combinations the overlay shows at once. */
export const PATTERN_HUD_MAX = 10;

/**
 * One recorded action in plain words.
 *
 * Two of the three things that separate one punch entry from another are
 * spelled out. The glove leads every punch, because "L.HOOK then R.HOOK" and
 * "R.HOOK then L.HOOK" are different combinations and a readout that could not
 * tell them apart would be describing patterns that look identical and behave
 * differently. The aim is called out only when it is body work, because that
 * is the half of the distinction that changes the answer.
 *
 * The stance is deliberately left off. It is part of the pattern's identity --
 * two entries here really can differ by nothing else -- but it is a property of
 * the whole exchange rather than of any one punch in it, and printing it on
 * every action would double the width of a ten-row overlay to repeat the same
 * word down the line.
 */
export function describeActionToken(token: string): string {
  const act = parseActionToken(token);
  if (act.kind === "charge") return "ARMED CHARGE";
  if (act.kind === "duck") return "DUCK";
  const base = act.punch ? PUNCH_LABELS[act.punch] ?? String(act.punch).toUpperCase() : "?";
  const name = act.hand === "left" ? `L.${base}` : act.hand === "right" ? `R.${base}` : base;
  if (act.kind === "feint") return `${name} FEINT`;
  return act.head ? name : `${name} BODY`;
}

/** The whole combination on one line, in the order it gets thrown. */
export function describePattern(acts: string[]): string {
  return acts.map(describeActionToken).join(" \u203a ");
}

/**
 * The overlay's list: most recently memorized first.
 *
 * Ordered by arming order rather than sighting count, because the question the
 * readout answers is "what has it just picked up on", not "what does it know
 * best". Studied tape arms before the bell, so it settles at the bottom on its
 * own once live learning starts.
 */
export function selectRecentArmedPatterns(mem: AiPatternMemory, limit: number = PATTERN_HUD_MAX): AiArmedPattern[] {
  if (limit <= 0) return [];
  return [...mem.armed].sort((a, b) => b.seq - a.seq).slice(0, limit);
}

// ===== STORE ==================================================================

/** How long a pattern is: three actions, per the design. Not tunable -- the
 *  matching, the counter script and the recognition maths all assume it. */
export const PATTERN_LENGTH = 3;

export interface AiArmedPattern {
  /** Context and actions together; the pattern's identity. */
  key: string;
  ctx: string;
  acts: string[];
  /** Total times this exact pattern has been observed, including the repeats
   *  that armed it. Everything past the threshold raises the counter chance. */
  n: number;
  /** Brain clock reading when this last fired a counter; the LRU half of eviction. */
  lastUsed: number;
  /** Arming order, so eviction ties break the same way every run. */
  seq: number;
  /** True when this came off career tape before the bell rather than being
   *  learned live. Studied work is the last thing dropped when room runs out. */
  studied: boolean;
  /** Difference between the career weight this came in on and the count it was
   *  seeded at, so the tape can be reconstructed on the way back out. Positive
   *  when sightings were held back to leave room to grow, negative when a thin
   *  tape entry had to be lifted to this tier's recognition threshold. */
  tapeOffset: number;
}

/** A pattern flattened for the career save. */
export interface AiPatternLibraryEntry {
  key: string;
  ctx: string;
  acts: string[];
  n: number;
}

export interface AiPatternMemory {
  /** Rolling window of the opponent's last actions, oldest first. */
  window: string[];
  /** Context sampled as each windowed action happened; index 0 is the one that counts. */
  windowCtx: string[];
  /** Unrecognized patterns and how many times each has been seen. */
  candidates: Record<string, number>;
  /** First-seen order per candidate, for deterministic eviction. */
  candidateSeq: Record<string, number>;
  armed: AiArmedPattern[];
  /** Tape offset per studied pattern, kept apart from the armed set so it
   *  survives eviction: a studied pattern the player goes back to after it was
   *  crowded out is re-armed on the same books it walked in with. */
  tape: Record<string, number>;
  seqCounter: number;
  /** The counter script currently running. */
  scriptKey: string | null;
  scriptActs: string[];
  scriptIdx: number;
  /** Brain clock reading past which an unanswered script gives up. */
  scriptExpires: number;
  /** Set while a scripted guard or duck is being held, so it can be released
   *  the moment the punch it was aimed at starts to retract. */
  holdActive: boolean;
  /** Rising-edge detectors for the actions that are states, not events. */
  prevCharge: boolean;
  prevDuck: boolean;
  /** Diagnostics only. */
  statRecognized: number;
  statTriggered: number;
  statSteps: number;
}

export function createAiPatternMemory(): AiPatternMemory {
  return {
    window: [],
    windowCtx: [],
    candidates: {},
    candidateSeq: {},
    armed: [],
    tape: {},
    seqCounter: 0,
    scriptKey: null,
    scriptActs: [],
    scriptIdx: 0,
    scriptExpires: 0,
    holdActive: false,
    prevCharge: false,
    prevDuck: false,
    statRecognized: 0,
    statTriggered: 0,
    statSteps: 0,
  };
}

/**
 * Idempotent backfill. Hot reload keeps live brains across a code change and
 * saved brains predate the feature entirely, so this runs before anything reads
 * the memory and repairs field by field rather than all or nothing.
 */
export function ensureAiPatternMemory(brain: AiBrainState): AiPatternMemory {
  if (!brain.patterns || typeof brain.patterns !== "object") {
    brain.patterns = createAiPatternMemory();
  }
  const m = brain.patterns;
  if (!Array.isArray(m.window)) m.window = [];
  if (!Array.isArray(m.windowCtx)) m.windowCtx = [];
  if (!m.candidates || typeof m.candidates !== "object") m.candidates = {};
  if (!m.candidateSeq || typeof m.candidateSeq !== "object") m.candidateSeq = {};
  if (!Array.isArray(m.armed)) m.armed = [];
  if (!m.tape || typeof m.tape !== "object") m.tape = {};
  if (typeof m.seqCounter !== "number") m.seqCounter = 0;
  if (typeof m.scriptKey !== "string" && m.scriptKey !== null) m.scriptKey = null;
  if (!Array.isArray(m.scriptActs)) m.scriptActs = [];
  if (typeof m.scriptIdx !== "number") m.scriptIdx = 0;
  if (typeof m.scriptExpires !== "number") m.scriptExpires = 0;
  if (typeof m.holdActive !== "boolean") m.holdActive = false;
  if (typeof m.prevCharge !== "boolean") m.prevCharge = false;
  if (typeof m.prevDuck !== "boolean") m.prevDuck = false;
  if (typeof m.statRecognized !== "number") m.statRecognized = 0;
  if (typeof m.statTriggered !== "number") m.statTriggered = 0;
  if (typeof m.statSteps !== "number") m.statSteps = 0;
  for (const p of m.armed) {
    if (typeof p.studied !== "boolean") p.studied = false;
    if (typeof p.tapeOffset !== "number" || !Number.isFinite(p.tapeOffset)) p.tapeOffset = 0;
  }
  for (const k of Object.keys(m.tape)) {
    if (!Number.isFinite(m.tape[k])) delete m.tape[k];
  }
  return m;
}

function patternKey(ctx: string, acts: string[]): string {
  return `${ctx}#${acts.join(">")}`;
}

function findArmedByKey(mem: AiPatternMemory, key: string): AiArmedPattern | null {
  for (const p of mem.armed) if (p.key === key) return p;
  return null;
}

/**
 * Weakest first: fewest sightings, then whatever was picked up live rather than
 * studied from tape, then least recently used, then oldest. The tape the
 * opponent came in with is what they prepared for, so it is the last thing they
 * let go of when the armed set runs out of room mid-bout.
 */
function weakestArmedIndex(mem: AiPatternMemory, excludeKey?: string | null): number {
  let worst = -1;
  for (let i = 0; i < mem.armed.length; i++) {
    const a = mem.armed[i];
    if (excludeKey != null && a.key === excludeKey) continue;
    if (worst < 0) { worst = i; continue; }
    const b = mem.armed[worst];
    if (a.n !== b.n) { if (a.n < b.n) worst = i; continue; }
    if (a.studied !== b.studied) { if (!a.studied) worst = i; continue; }
    if (a.lastUsed !== b.lastUsed) { if (a.lastUsed < b.lastUsed) worst = i; continue; }
    if (a.seq < b.seq) worst = i;
  }
  return worst;
}

function evictWeakestCandidate(mem: AiPatternMemory): void {
  let worstKey: string | null = null;
  let worstCount = Infinity;
  let worstSeq = Infinity;
  for (const k of Object.keys(mem.candidates)) {
    const c = mem.candidates[k];
    const s = mem.candidateSeq[k] ?? 0;
    if (c < worstCount || (c === worstCount && s < worstSeq)) {
      worstKey = k; worstCount = c; worstSeq = s;
    }
  }
  if (worstKey !== null) {
    delete mem.candidates[worstKey];
    delete mem.candidateSeq[worstKey];
  }
}

/**
 * Fold one observed action into the memory. The action closes a three-action
 * pattern whose context is the one sampled when the *first* of the three was
 * thrown -- that is the context the AI will be standing in when it next sees
 * the pattern open.
 *
 * The window slides by one, so overlapping patterns are all candidates. Returns
 * true when this sighting armed a pattern that was not armed before.
 */
export function recordPatternAction(
  mem: AiPatternMemory,
  token: string,
  ctx: string,
  threshold: number,
  capacity: number,
  cfg: AiPatternConfig,
): boolean {
  mem.window.push(token);
  mem.windowCtx.push(ctx);
  while (mem.window.length > PATTERN_LENGTH) { mem.window.shift(); mem.windowCtx.shift(); }
  if (mem.window.length < PATTERN_LENGTH) return false;

  const acts = mem.window.slice();
  const openCtx = mem.windowCtx[0];
  const key = patternKey(openCtx, acts);

  // Already armed: keep counting sightings, they are what raise the chance.
  const existing = findArmedByKey(mem, key);
  if (existing) { existing.n++; return false; }

  if (mem.candidates[key] === undefined) {
    if (Object.keys(mem.candidates).length >= Math.max(1, cfg.maxCandidates)) evictWeakestCandidate(mem);
    mem.candidates[key] = 0;
    mem.candidateSeq[key] = mem.seqCounter++;
  }
  const seen = ++mem.candidates[key];
  if (seen < Math.max(1, threshold)) return false;

  delete mem.candidates[key];
  delete mem.candidateSeq[key];
  armPattern(mem, { key, ctx: openCtx, acts, n: seen }, capacity);
  mem.statRecognized++;
  return true;
}

/** Adds a pattern to the armed set, making room by dropping the weakest. */
export function armPattern(
  mem: AiPatternMemory,
  entry: AiPatternLibraryEntry,
  capacity: number,
  opts?: { studied?: boolean; tapeOffset?: number },
): void {
  if (findArmedByKey(mem, entry.key)) return;
  const cap = Math.max(1, capacity);
  while (mem.armed.length >= cap) {
    // A pattern currently being countered must not be pulled out from under the
    // script that is running it, so it is skipped and the next weakest goes
    // instead -- unless it is the only thing armed and there is nothing else.
    let idx = weakestArmedIndex(mem, mem.scriptKey);
    if (idx < 0) idx = weakestArmedIndex(mem);
    if (idx < 0) break;
    mem.armed.splice(idx, 1);
  }
  // A pattern that came off tape earlier this bout keeps its books when it is
  // re-armed, so being crowded out does not wipe what the opponent studied.
  const ledger = mem.tape[entry.key];
  const offset = opts?.tapeOffset ?? (Number.isFinite(ledger) ? ledger : 0);
  mem.armed.push({
    key: entry.key,
    ctx: entry.ctx,
    acts: entry.acts.slice(),
    n: entry.n,
    lastUsed: 0,
    seq: mem.seqCounter++,
    studied: opts?.studied === true || ledger !== undefined,
    tapeOffset: Number.isFinite(offset) ? offset : 0,
  });
}

/**
 * The armed pattern that opens with this action from this context, best known
 * first. An exact context match is required: the same combination thrown from
 * a different range is a different problem.
 */
export function findArmedPattern(mem: AiPatternMemory, ctx: string, token: string): AiArmedPattern | null {
  let best: AiArmedPattern | null = null;
  for (const p of mem.armed) {
    if (p.ctx !== ctx || p.acts[0] !== token) continue;
    if (!best || p.n > best.n || (p.n === best.n && p.seq < best.seq)) best = p;
  }
  return best;
}

/**
 * Odds this recognized pattern is actually countered, 0..1.
 *
 * Confident to start with and eroded by the beating the AI is taking: every
 * punch it failed to perfect block shaves the additive total, and each
 * knockdown it has suffered multiplies what is left. The multiplicative
 * knockdown term is applied last so a knocked-down AI degrades by a fraction
 * of whatever it had rather than falling off a cliff.
 */
export function patternCounterChance(
  p: AiArmedPattern,
  threshold: number,
  hitsTakenNotPerfectBlocked: number,
  knockdownsSuffered: number,
  cfg: AiPatternConfig,
  stunned: boolean = false,
): number {
  const beyond = Math.max(0, p.n - Math.max(1, threshold));
  let pct = cfg.baseChancePct + cfg.perRepeatPct * beyond - cfg.perHitTakenPct * Math.max(0, hitsTakenNotPerfectBlocked);
  pct *= Math.pow(cfg.knockdownMult, Math.max(0, knockdownsSuffered));
  pct = Math.min(cfg.maxChancePct, Math.max(0, pct));
  // Being stunned is the one erosion term applied after the ceiling. A pattern
  // the AI has seen twenty times sits pinned at the cap, so a penalty folded in
  // before the clamp would be swallowed whole on exactly the reads that hurt
  // most. Taken afterwards it always bites, which is why the penalty is only a
  // percent: a stun is a nudge to the AI's reads, not a hole in them.
  if (stunned) pct *= Math.max(0, 1 - Math.max(0, cfg.stunPenaltyPct) / 100);
  return Math.max(0, pct) / 100;
}

// ===== COUNTER SCRIPT =========================================================

export function startPatternScript(mem: AiPatternMemory, p: AiArmedPattern, now: number, holdSec: number): void {
  mem.scriptKey = p.key;
  mem.scriptActs = p.acts.slice();
  mem.scriptIdx = 0;
  mem.scriptExpires = now + holdSec;
  mem.holdActive = false;
  p.lastUsed = now;
  mem.statTriggered++;
}

export function clearPatternScript(mem: AiPatternMemory): void {
  mem.scriptKey = null;
  mem.scriptActs = [];
  mem.scriptIdx = 0;
  mem.scriptExpires = 0;
  mem.holdActive = false;
}

export function isPatternScriptRunning(mem: AiPatternMemory): boolean {
  return mem.scriptKey !== null && mem.scriptIdx < mem.scriptActs.length;
}

/** The action the running script is waiting for, if any. */
export function pendingScriptAction(mem: AiPatternMemory): string | null {
  if (!isPatternScriptRunning(mem)) return null;
  return mem.scriptActs[mem.scriptIdx];
}

/**
 * Feed the script the action that just happened.
 *
 *   "step"  it was the expected one; counter it and carry on
 *   "done"  it was the last one; counter it and the script is spent
 *   "abort" the opponent deviated; the script is dropped and the AI reacts cold
 *   "idle"  no script was running
 *
 * Deviating is the whole defence against being read: the moment the opponent
 * throws something else, the prepared answer is gone.
 */
export function advancePatternScript(mem: AiPatternMemory, token: string): "step" | "done" | "abort" | "idle" {
  if (!isPatternScriptRunning(mem)) return "idle";
  if (mem.scriptActs[mem.scriptIdx] !== token) { clearPatternScript(mem); return "abort"; }
  mem.scriptIdx++;
  mem.statSteps++;
  const finished = mem.scriptIdx >= mem.scriptActs.length;
  if (finished) {
    const spent = mem.scriptKey;
    clearPatternScript(mem);
    void spent;
    return "done";
  }
  return "step";
}

/**
 * What a running script does with the action that just happened.
 *
 *   "abort"   the opponent deviated; the prepared answer is gone
 *   "counter" the expected action and the read was won: run the answer
 *   "wait"    the expected action but the read was lost: no answer, script lives
 *   "idle"    no script was running
 *
 * `mayAct` is the caller's already-rolled input read. Knowing what is coming is
 * not the same as seeing it: every action of a scripted combination costs its
 * own read, so a counter can never give the AI more answers than it won reads.
 * Losing one does not break the script -- the opponent is still throwing the
 * combination, so the AI keeps waiting for the next action of it.
 */
export function advanceScriptedCounter(
  mem: AiPatternMemory,
  token: string,
  mayAct: boolean,
): "abort" | "counter" | "wait" | "idle" {
  if (!isPatternScriptRunning(mem)) return "idle";
  if (advancePatternScript(mem, token) === "abort") return "abort";
  return mayAct ? "counter" : "wait";
}

/** Drops the rolling window without touching what has been learned. Used at the
 *  bell and after a knockdown, where a combination cannot span the break. */
export function clearPatternWindow(mem: AiPatternMemory): void {
  mem.window.length = 0;
  mem.windowCtx.length = 0;
}

// ===== WHAT DEFENDS WHAT ======================================================
//
// Recognizing a combination is worth nothing if the answer to it is wrong, so
// the choice of answer is made against what this engine actually does rather
// than what reads well. Everything below is a statement about hit resolution:
//
//   duck          a head punch that is not an uppercut misses outright -- the
//                 engine's own canonical dodge, no damage and no block needed.
//                 An uppercut follows the dropping head up and lands anyway.
//                 Ducking also drops the high guard and reclassifies everything
//                 as body work, so it is never a free choice.
//   perfect block negates the damage, and it is the one guard a charged punch of
//                 a matching family cannot bypass -- though rhythm-cut and
//                 Bruiser roll after it and can still go through, so it is the
//                 best answer available and not an absolute one. With the
//                 directional toggle on the postures have to match, which is
//                 why low work is answered from a duck.
//   slip          takes the head off the punch line. Head punches only: it does
//                 nothing at all against body work.
//   guard         an ordinary high guard, partial reduction, and it covers both
//                 heights. Beaten by a matching-side punch (see counterPunch),
//                 by charged bypasses and by focus bypasses.
//   counterPunch  throwing back with the arm OPPOSITE the incoming punch. The
//                 guard only opens on the side being thrown from, so the far
//                 hand answers while the near one keeps blocking -- the one
//                 answer that costs the opponent something.
//   stepOut       a short step off the punch line. Only a defence when it
//                 carries the AI past the reach of what is coming; short of
//                 that it just spoils the range the combination was measured
//                 for, which is worth less.

export type PatternAnswer =
  | "perfectBlock"
  | "duck"
  | "guard"
  | "slip"
  | "counterPunch"
  | "stepOut";

/** What the AI is physically able to do this instant. An answer it cannot run
 *  hands its weight to the ones it can, rather than wasting the read. */
export interface PatternAnswerAvailability {
  perfectBlock: boolean;
  duck: boolean;
  guard: boolean;
  slip: boolean;
  counterPunch: boolean;
  stepOut: boolean;
  /** Whether the step-out is long enough to clear the reach of what is coming. */
  stepClears: boolean;
}

export interface PatternAnswerPlan {
  answer: PatternAnswer;
  /** Drop into a duck while running the answer. Set for low work: the AI meets
   *  it at its own height, which is also what a posture-matched perfect block
   *  needs and what lets a counter come back at the head they have lowered. */
  duckWith: boolean;
}

/** True for the two actions that mean the work is coming downstairs. */
export function isLowPatternAction(act: ParsedAction): boolean {
  return act.kind === "duck" || (act.kind === "punch" && !act.head);
}

/** Weight per answer for one recognized action, before availability. */
export function patternAnswerWeights(act: ParsedAction): Array<{ answer: PatternAnswer; w: number }> {
  const isUppercut = act.punch === "leftUppercut" || act.punch === "rightUppercut";

  if (act.kind === "charge") {
    // Arming a charge is an offensive act -- it is the announcement of a punch,
    // not a pause in front of one -- so it gets answered like one. The punch
    // itself is not chosen yet, so nothing that depends on knowing which punch
    // it will be can be planned, and a charged punch of a matching family goes
    // straight through an ordinary guard, which takes plain guarding off the
    // table outright. That leaves the three things a charge cannot beat:
    // getting under it, the one guard it cannot bypass, and not being there.
    return [
      { answer: "perfectBlock", w: 0.45 },
      { answer: "duck", w: 0.30 },
      { answer: "stepOut", w: 0.25 },
    ];
  }

  if (act.kind === "feint") {
    // A feint is fishing for exactly these reactions. Refusing to buy it is the
    // answer: hands up, feet still, nothing committed.
    return [{ answer: "guard", w: 1 }];
  }

  if (act.kind === "duck") {
    // They have dropped to work the body. Nothing has been thrown yet, so this
    // is the moment to make them pay for being down there.
    return [
      { answer: "counterPunch", w: 0.35 },
      { answer: "perfectBlock", w: 0.30 },
      { answer: "guard", w: 0.20 },
      { answer: "stepOut", w: 0.15 },
    ];
  }

  if (!act.head) {
    // Body work, including everything thrown out of a duck. A slip only moves
    // the head, so it is not on the table down here.
    return [
      { answer: "perfectBlock", w: 0.35 },
      { answer: "counterPunch", w: 0.30 },
      { answer: "guard", w: 0.20 },
      { answer: "stepOut", w: 0.15 },
    ];
  }

  if (isUppercut) {
    // The one head shot ducking does not answer.
    return [
      { answer: "perfectBlock", w: 0.40 },
      { answer: "slip", w: 0.30 },
      { answer: "counterPunch", w: 0.15 },
      { answer: "stepOut", w: 0.15 },
    ];
  }

  // Straight or hooked upstairs: ducking makes it miss outright, which is the
  // cleanest outcome available to a defender in this engine.
  return [
    { answer: "duck", w: 0.30 },
    { answer: "perfectBlock", w: 0.25 },
    { answer: "slip", w: 0.20 },
    { answer: "counterPunch", w: 0.15 },
    { answer: "stepOut", w: 0.10 },
  ];
}

/** Everything that decides whether a scripted posture is still owed. */
export interface PatternHoldInputs {
  /** Whether a duck is being held on a punch at all. */
  holdArmed: boolean;
  /** The punch count the hold was stamped to. One PAST the attacker's count
   *  while it was armed against a charge, whose punch does not exist yet. */
  stampedPunchId: number;
  punchesThrown: number;
  chargeArmed: boolean;
  isPunching: boolean;
  /** True once the punch has started coming back. */
  retracting: boolean;
  /** Brain clock, and the moment a charge wait gives up. */
  now: number;
  chargeWaitUntil: number;
}

export interface PatternHoldStatus {
  /** The hold is waiting on a charge that has not turned into a punch yet. */
  waitingOnCharge: boolean;
  /** The held duck is still owed: keep the posture forced. */
  holdOwed: boolean;
  /** The action a scripted guard was raised against is finished, so the guard
   *  can come down. */
  guardSpent: boolean;
}

/**
 * When a scripted posture ends.
 *
 * Both halves of that question live here together on purpose. The tick asks it
 * twice -- once for a duck held on a punch, once for the scripted guard that
 * covers one action and does not camp -- and the two answers have to agree
 * about the one case where "the opponent is not punching" does not mean the
 * action is over: a charge. Answering a charge happens before its punch
 * exists, so mid-wait the opponent is genuinely not punching, and a release
 * rule that reads that as "finished" drops the posture on the very tick after
 * it was armed. Derived from one set of inputs so the two can never drift into
 * disagreeing about it again.
 */
export function patternHoldStatus(i: PatternHoldInputs): PatternHoldStatus {
  const waitingOnCharge = i.holdArmed
    && i.stampedPunchId > i.punchesThrown
    && i.chargeArmed
    && i.now <= i.chargeWaitUntil;
  const samePunch = i.punchesThrown === i.stampedPunchId;
  return {
    waitingOnCharge,
    holdOwed: waitingOnCharge || (samePunch && i.isPunching && !i.retracting),
    guardSpent: !waitingOnCharge && (!i.isPunching || i.retracting),
  };
}

/** How much a step-out that does not clear the punch is still worth. */
const PATTERN_SHORT_STEP_WEIGHT = 0.4;

/**
 * Pick the answer to one recognized action.
 *
 * `roll01` is the caller's random draw, so the choice is testable and the
 * module stays free of the engine's RNG.
 */
export function choosePatternAnswer(
  act: ParsedAction,
  avail: PatternAnswerAvailability,
  roll01: number,
): PatternAnswerPlan | null {
  const rows: Array<{ answer: PatternAnswer; w: number }> = [];
  for (const row of patternAnswerWeights(act)) {
    if (!avail[row.answer]) continue;
    const w = row.answer === "stepOut" && !avail.stepClears
      ? row.w * PATTERN_SHORT_STEP_WEIGHT
      : row.w;
    if (w > 0) rows.push({ answer: row.answer, w });
  }
  let total = 0;
  for (const r of rows) total += r.w;
  if (total <= 0) return null;

  let roll = Math.max(0, Math.min(1, roll01)) * total;
  // Falls back to the last row standing rather than off the end of the list, so
  // a roll landing exactly on the total still picks something available.
  let chosen = rows[rows.length - 1].answer;
  for (const r of rows) {
    if (roll < r.w) { chosen = r.answer; break; }
    roll -= r.w;
  }

  // Low work is met at its own height. The duck rides along with whatever the
  // answer is rather than replacing it -- except when ducking IS the answer.
  //
  // An armed charge is the other case that ducks with its block, and for the
  // opposite reason: not because the height is known but because it is not.
  // The punch behind the charge has not been picked yet, so rather than guess
  // which way it is coming the AI takes both answers at once -- under it and
  // behind the one guard it cannot be bypassed through.
  const duckWith = chosen !== "duck" && avail.duck && (
    isLowPatternAction(act) || (act.kind === "charge" && chosen === "perfectBlock")
  );
  return { answer: chosen, duckWith };
}

// ===== CAREER LIBRARY =========================================================

/** A sighting count that survived a JSON round trip. Never zero: a pattern in
 *  the library was seen at least once by definition. */
function safeWeight(n: unknown): number {
  return typeof n === "number" && Number.isFinite(n) ? Math.max(1, Math.floor(n)) : 1;
}

/** Whether a saved entry is complete enough to arm; the script layer indexes
 *  three actions unconditionally, so a short or malformed one cannot be used. */
function isUsableLibraryEntry(e: AiPatternLibraryEntry | null | undefined): boolean {
  return !!e
    && typeof e.key === "string" && e.key.length > 0
    && typeof e.ctx === "string"
    && Array.isArray(e.acts) && e.acts.length === PATTERN_LENGTH
    && e.acts.every(a => typeof a === "string" && a.length > 0);
}

/**
 * A saved entry brought up to the current context format.
 *
 * Careers written while separation was part of the context still hold entries
 * keyed `60|jab`, which can never match a live context again -- they would be
 * studied, take up armed slots and answer nothing. So the distance prefix is
 * stripped on the way in and the entry re-keyed. Several old buckets of the
 * same combination collapse onto one entry, which is the point; the heaviest
 * count wins, the same rule the merge already uses.
 */
function normalizeLibraryCtx(ctx: unknown): string {
  const s = typeof ctx === "string" ? ctx : "";
  const bar = s.indexOf("|");
  return bar >= 0 ? s.slice(bar + 1) : s;
}

/**
 * Every entry re-keyed to the current format, duplicates folded together.
 *
 * The actions are upgraded as well as the context, because the key is derived
 * from both. This is the single gate every saved library passes through --
 * merging on the way out and studying on the way in both come through here --
 * so an old tape is brought forward exactly once, in one place, whichever
 * direction it is travelling.
 */
export function normalizePatternLibrary(entries: AiPatternLibraryEntry[]): AiPatternLibraryEntry[] {
  const byKey = new Map<string, AiPatternLibraryEntry>();
  for (const e of entries) {
    if (!e || !Array.isArray(e.acts)) continue;
    const ctx = normalizeLibraryCtx(e.ctx);
    const acts = e.acts.map(a => upgradeActionToken(typeof a === "string" ? a : ""));
    const key = patternKey(ctx, acts);
    const prev = byKey.get(key);
    if (prev) prev.n = Math.max(prev.n, safeWeight(e.n));
    else byKey.set(key, { key, ctx, acts, n: safeWeight(e.n) });
  }
  return Array.from(byKey.values());
}

/**
 * The armed set, flattened for the career save.
 *
 * Studied patterns went into the bout on an adjusted count, so the difference
 * is put back here: what the player threw tonight lands on top of everything
 * already on the tape rather than being flattened by the merge's
 * keep-the-larger rule, and a thin tape entry that had to be lifted to this
 * tier's threshold goes back at the weight it really had.
 */
export function exportPatternLibrary(mem: AiPatternMemory): AiPatternLibraryEntry[] {
  return mem.armed.map(p => ({
    key: p.key,
    ctx: p.ctx,
    acts: p.acts.slice(),
    n: safeWeight(p.n + (Number.isFinite(p.tapeOffset) ? p.tapeOffset : 0)),
  }));
}

/**
 * Fold a bout's recognized patterns into the career-long library, keeping the
 * highest sighting count per pattern and the most-seen entries when trimming.
 */
export function mergePatternLibrary(
  existing: AiPatternLibraryEntry[],
  incoming: AiPatternLibraryEntry[],
  maxEntries: number,
): AiPatternLibraryEntry[] {
  const byKey = new Map<string, AiPatternLibraryEntry>();
  for (const e of normalizePatternLibrary(existing)) byKey.set(e.key, e);
  for (const e of normalizePatternLibrary(incoming)) {
    const prev = byKey.get(e.key);
    if (prev) prev.n = Math.max(prev.n, e.n);
    else byKey.set(e.key, e);
  }
  const all = Array.from(byKey.values());
  all.sort((a, b) => (b.n - a.n) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return all.slice(0, Math.max(0, maxEntries));
}

/**
 * How much of the player's tape an opponent has watched before the bell, by
 * their career rank. Nobody scraping the bottom of the ladder is studying
 * anyone; by the time you are fighting for the belt they know the lot.
 *
 * Read as "the first band whose maxRank covers this rank", so the last row is
 * the catch-all -- a rank past the end of the ladder still lands somewhere.
 */
export const AI_PATTERN_STUDY_LADDER: ReadonlyArray<{ maxRank: number; min: number; max: number }> = [
  { maxRank: 1,        min: 10, max: 10 },
  { maxRank: 50,       min: 8,  max: 10 },
  { maxRank: 120,      min: 6,  max: 8 },
  { maxRank: 250,      min: 4,  max: 6 },
  { maxRank: 400,      min: 2,  max: 5 },
  { maxRank: 600,      min: 1,  max: 3 },
  { maxRank: Infinity, min: 0,  max: 2 },
];

/**
 * A tiny LCG so an opponent's study card is the same every time you face them.
 * Deliberately separate from the AI's own rng, which is reseeded per bout.
 */
export function makePatternStudyRng(seed: number): () => number {
  let s = (seed >>> 0) || 1;
  return () => {
    s = (s * 1664525 + 1013904223) & 0xFFFFFFFF;
    return (s >>> 0) / 0xFFFFFFFF;
  };
}

/** How many patterns this rank studies, drawn from its band. */
export function patternStudyCount(rank: number, cfg: AiPatternConfig, rand: () => number): number {
  const band = AI_PATTERN_STUDY_LADDER.find(b => rank <= b.maxRank) ?? AI_PATTERN_STUDY_LADDER[AI_PATTERN_STUDY_LADDER.length - 1];
  const raw = band.min + Math.floor(rand() * (band.max - band.min + 1));
  return Math.max(0, Math.round(raw * Math.max(0, cfg.studyScale)));
}

/**
 * The in-bout sighting count a studied pattern opens on.
 *
 * A combination the player has gone to fifty times would otherwise walk in
 * pinned at the counter-chance ceiling, and nothing the opponent saw during the
 * bout could add to it. So the tape weight is compressed: the opponent starts
 * recognized, a little more sure of itself the heavier the pattern is on tape,
 * and with room left to build on that as the player keeps going back to it.
 */
export function studiedSeedCount(libN: number, threshold: number, cfg: AiPatternConfig): number {
  const base = Math.max(1, Math.floor(threshold));
  const beyond = Math.max(0, (Number.isFinite(libN) ? libN : 0) - base);
  const pct = Math.max(0, Math.min(100, cfg.studyCarryPct));
  const carry = Math.min(Math.max(0, Math.floor(cfg.studyCarryMax)), Math.round(beyond * pct / 100));
  return base + Math.max(0, carry);
}

/**
 * Pre-arm an opponent with patterns studied from tape before the bell.
 *
 * They take the heaviest end of the tape first, in order: what a fighter is
 * known for is the first thing anyone watches, so a shorter study card is a
 * strictly shallower cut of the same list rather than a different sample of it.
 * Ties are settled by the opponent's own draw, which is deterministic for a
 * given seed -- the same opponent has studied the same things every time you
 * face them.
 *
 * What they arrive with is a floor, not a finished job: every studied pattern
 * stays live in the armed set, so each time the player runs it again during the
 * bout the count climbs on top of what was studied and the counter gets surer.
 * The books each one came in on are kept on the memory rather than on the armed
 * entry, so being crowded out mid-bout does not erase what was studied.
 */
export function seedPatternMemory(
  mem: AiPatternMemory,
  library: AiPatternLibraryEntry[],
  count: number,
  capacity: number,
  rand: () => number,
  cfg: AiPatternConfig,
  threshold: number,
): number {
  const pool: { e: AiPatternLibraryEntry; weight: number; tie: number }[] = [];
  // Normalized first: an old save's distance-keyed entries are folded onto the
  // combination they really are before the study card is cut, so a pattern the
  // player threw across four buckets is studied once at its true weight rather
  // than four times at a quarter of it.
  for (const e of normalizePatternLibrary(library)) {
    if (!isUsableLibraryEntry(e)) continue;
    pool.push({ e, weight: e.n, tie: rand() });
  }

  const want = Math.min(Math.max(0, Math.floor(count)), Math.max(0, capacity), pool.length);
  if (want <= 0) return 0;

  pool.sort((a, b) =>
    (b.weight - a.weight) ||
    (a.tie - b.tie) ||
    (a.e.key < b.e.key ? -1 : a.e.key > b.e.key ? 1 : 0),
  );

  let studied = 0;
  for (const { e, weight } of pool) {
    if (studied >= want) break;
    if (findArmedByKey(mem, e.key)) continue;
    const seedN = studiedSeedCount(weight, threshold, cfg);
    // Signed: positive when sightings are held back, negative when a thin tape
    // entry had to be lifted to this tier's threshold. Either way the career
    // weight comes back out of the bout as it went in, plus what was added.
    mem.tape[e.key] = weight - seedN;
    armPattern(mem, { key: e.key, ctx: e.ctx, acts: e.acts, n: seedN }, capacity, {
      studied: true,
      tapeOffset: weight - seedN,
    });
    studied++;
  }
  return studied;
}
