import {
  GameState, FighterState, PunchType, Archetype, DefenseState,
  PUNCH_CONFIGS, ARCHETYPE_STATS, AIDifficulty,
  AiState, TacticalPhase, DifficultyBand, DIFFICULTY_TO_BAND,
  AiPersonality, AiBrainState, AiDataBank, AiHitRecord, AiWhiffRecord,
  AiHitPattern, AiHitSummary, AiComboStep, AiCombo,
  AdaptiveMemory, TimingSlot, ObservedPattern, RingZone, BehaviorProfile,
  WhiffSnapshot, AiDecisionStats, SlipDir, NeuralBaseline,
} from "./types";
import { aiRNG, isFeintEngaged, isPerfectBlockRhythmPaused, isRhythmVulnerable, getPunchReachPx, getBurstPunchExcess, accrueRingMileage, startSlip, isLeadArmPunch, tryReset, aiResetAllowed, AI_SLIP_HOLD } from "./engine";
import { SITUATION_DB, matchSituation, getDifficultyMultiplier, type SituationMatchResult } from "./situationDB";
import { levelScale, pointCoef, getScaling } from "@/lib/scalingConfig";
import { getNeuralOverrides, getRcConfig, getAiRangeConfig, getAiPatternConfig } from "@/components/NeuralNetworkView";
import { isTrainingRosterId, deriveNeuralState } from "./aiFundamentals";
import { SituationTracker } from "./fundamentalStates";
import { getChampionFundamentals, bestFundamentalFor } from "./championStates";
import { generateOffenseProfile, generateFallbackOffenseProfile } from "./offenseProfile";
import {
  createAiStringRuntime, ensureAiStringRuntime, selectAiString, startAiString,
  cancelAiString, updateAiStringRunner, applyAiStringMovement, confirmAiStringPunch,
  holdAiStringThrow,
  notifyAiStringPunchResolved, isAiStringAssault, type StringSelectContext,
  ensureAiRlState, attachRlPolicy, peekAiRlUtility, takeAiRlUtility, settleAiRlUtility,
} from "./aiStringRunner";
import { buildRlObservation } from "./rlObservation";
import { rlPolicyForDifficulty } from "./rlDeploy";
import { AGGRESSION_DEFICIT_MIN_SAMPLE, type AiStringRole } from "./aiStrings";
import {
  createAiPatternMemory, ensureAiPatternMemory, recordPatternAction, findArmedPattern,
  patternCounterChance, patternRecognitionThreshold, patternArmedCapacity,
  startPatternScript, advancePatternScript, clearPatternScript, clearPatternWindow,
  isPatternScriptRunning, advanceScriptedCounter,
  buildPatternContext, punchActionToken, feintActionToken,
  parseActionToken, PATTERN_TOKEN_CHARGE, PATTERN_TOKEN_DUCK,
  choosePatternAnswer, type ParsedAction, patternHoldStatus,
  exportPatternLibrary, mergePatternLibrary, seedPatternMemory,
  makePatternStudyRng, patternStudyCount, type AiPatternLibraryEntry,
} from "./aiPatterns";

const AI_BLOCK_PX = 70;

// Reach gating / range-whiff learning.
// The AI is allowed this much slack past a punch's true reach to account for the
// step-in during its own windup; anything further is rejected before it is thrown.
const AI_PUNCH_REACH_MARGIN_PX = 6;
const RANGE_WHIFF_MAX_SAMPLES = 12;
const RANGE_WHIFF_MAX_CLOSE_PX = 60;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * clamp01(t);
}
function inverseLerp(a: number, b: number, v: number): number {
  if (Math.abs(b - a) < 0.0001) return 0;
  return clamp01((v - a) / (b - a));
}

// ===== RNG & UTILITIES =====

class AiRNG {
  private s: number;
  constructor(seed: number) {
    this.s = seed >>> 0;
    if (this.s === 0) this.s = 1;
  }
  next01(): number {
    this.s = (this.s * 1664525 + 1013904223) & 0xFFFFFFFF;
    return (this.s >>> 0) / 0xFFFFFFFF;
  }
  range(min: number, max: number): number {
    return min + (max - min) * this.next01();
  }
  chance(p: number): boolean {
    return this.next01() < clamp01(p);
  }
  rollRange01(min01: number, max01: number): number {
    return lerp(min01, max01, this.next01());
  }
}

let rng: AiRNG = new AiRNG(Date.now());

const LOW_STAMINA_FRAC = 0.25;
const DEEP_SURVIVAL_FRAC = 0.03;
const PLAYER_FINISH_FRAC = 0.20;
const SURVIVAL_FRAC = 0.04;
const HIT_DETECT_THRESHOLD = 0.5;
const CONDITION_DECAY_PER_SEC = 0.008;
const HEAD_HIT_CONDITION_VALUE = 0.04;
const BODY_HIT_CONDITION_VALUE = 0.04;
const CONDITION_DAMAGE_GATE_MIN = 30;
const CONDITION_DAMAGE_GATE_MAX = 200;
const CONDITION_DAMAGE_GATE = 50;
const REPEAT_HIT_THRESHOLD = 5;
const REPEAT_PENALTY_STEP = 0.03;
const REPEAT_PENALTY_CAP = 0.20;
const PERFECT_REACT_COOLDOWN = 0.8;
const PERFECT_REACT_HOLD_TIME = 0.35;
const PERFECT_REACT_FADE_TICK_SECONDS = 15;
const PERFECT_REACT_FADE_TICK_AMOUNT = 0.01;
const STEP_OUT_TARGET_DISTANCE_PX = 120;

// ── Pressure offense (difficulty-keyed) ──────────────────────────────────────
// Recorded fights: the player commits to bursts at ~42px, the CPU at ~84px.
// Pressure entry closes that gap, commits to a combo, then follows it up.
const PRESSURE_RANGE_PX = 46;
const PRESSURE_RANGE_TOLERANCE_PX = 14;
const PRESSURE_ENTRY_CHANCE: Record<DifficultyBand, number> = {
  Hardcore: 0.70, Hard: 0.50, Medium: 0.30, Easy: 0.15,
};
const PRESSURE_FOLLOWUPS: Record<DifficultyBand, number> = {
  Hardcore: 2, Hard: 2, Medium: 1, Easy: 1,
};
const PRESSURE_COUNTER_WINDOW = 1.2;

// ── Combo chase: walk the player down mid-combo instead of punching at air ───
// Rolled once per combo. The live scorecard nudges it 1% per second while the round
// is being fought: up while the AI is behind (it has to force the action), down while
// it is ahead.
const COMBO_CHASE_BASE_CHANCE = 0.75;
const COMBO_CHASE_MIN_CHANCE = 0.50;
const COMBO_CHASE_MAX_CHANCE = 0.99;
const COMBO_CHASE_SCORE_STEP = 0.01;
const COMBO_CHASE_ADAPT_INTERVAL = 1.0;
const COMBO_CHASE_ADAPT_DEADZONE = 0.05;
const COMBO_CHASE_TOLERANCE_PX = 8;
const COMBO_CHASE_FULL_SPEED_PX = 30;
const COMBO_CHASE_MIN_SPEED = 0.35;

// ── Anticipatory perfect block (difficulty base + career-rank nudge) ─────────
const ANTICIPATION_BASE_CHANCE: Record<DifficultyBand, number> = {
  Hardcore: 0.85, Hard: 0.80, Medium: 0.70, Easy: 0.60,
};
const ANTICIPATION_RANK_BOOST_MAX = 0.10;   // rank 1 sits at the top of the 85–95% band
const ANTICIPATION_RANK_BOOST_SPAN = 100;   // boost fades out across the top 100 ranks
const ANTICIPATION_CHANCE_CAP = 0.99;
const ANTICIPATION_CHANCE_FLOOR = 0.30;

/* Intentional perfect block, driven by a fundamentals seed's defensive params.
 * A seed that never sets the knob sits at NEUTRAL, where every number below
 * cancels out and the AI behaves exactly as it did before. */
/** The value at which a seed changes nothing. */
const PB_INTENT_NEUTRAL = 0.5;
/** Share of the anticipatory chance the seed's intent takes; the rest is difficulty. */
const PB_INTENT_ANTICIPATION_SHARE = 0.7;
/** How far a full-range intent swings the reflex rate: ×0.4 at 0, ×1.6 at 1. */
const PB_INTENT_REFLEX_SPAN = 1.2;
/** The reflex ceiling. Blocking on purpose is a trait, never a certainty. */
const PB_INTENT_MAX_REFLEX = 0.97;

/* Reset (b) under fatigue. Once a CPU fighter has burned this much of its energy
 * it starts hunting for the Reset the way a player is expected to. Rolled once a
 * second rather than once a tick: at 60Hz even a 10% per-tick roll fires inside a
 * couple of frames, which would have every gassed AI resetting the instant it
 * crossed the threshold. */
const AI_RESET_FATIGUE_THRESHOLD = 0.30;
const AI_RESET_ROLL_INTERVAL = 1.0;
const AI_RESET_CHANCE_BY_BAND: Record<DifficultyBand, number> = {
  Easy: 0.10,      // Journeyman
  Medium: 0.15,    // Contender
  Hard: 0.20,      // Elite
  Hardcore: 0.25,  // Champion
};
const ANTICIPATION_CHANCE_UP_MIN = 0.01;
const ANTICIPATION_CHANCE_UP_MAX = 0.03;
const ANTICIPATION_CHANCE_DOWN = 0.01;
const ANTICIPATION_COOLDOWN = 1.2;
const PERFECT_BLOCK_MIN_HOLD_MS = 150;
const PERFECT_BLOCK_HOLD_STEP_MIN_MS = 10;
const PERFECT_BLOCK_HOLD_STEP_MAX_MS = 100;
const PLAYER_BURST_GAP_SECONDS = 0.7;       // gap that ends one attack pattern
const PLAYER_BURST_HISTORY_MAX = 5;
const PLAYER_CLOSE_SAMPLE_SECONDS = 0.5;
const PLAYER_CLOSE_DELTA_PX = 10;
const PLAYER_CLOSE_FIRE_WINDOW = 1.0;
const STUN_TIMING_LOCK_CHANCE = 0.30;
const FEINT_TIMING_ADJUST_BASE = 0.50;
const PATTERN_RANGE_MAX_PX = AI_BLOCK_PX * 1.8;
const PATTERN_WINDOW_SECONDS = 2.0;
const COUNTER_PATTERN_WINDOW_DURATION = 1.5;
const RHYTHM_CUT_HOLD_SECONDS = 0.6;
const RHYTHM_CUT_COOLDOWN_SECONDS = 3.0;
const RHYTHM_CUT_TICK_SECONDS = 0.1;
const RHYTHM_CHANGE_COOLDOWN = 2.0;
const TOO_CLOSE_RANGE_PX = AI_BLOCK_PX * 0.5;
// Flat outward shift on the AI's preferred engagement distance lives on the
// Neural Network screen, under AI Punch Distance.
const OVERLAP_HARD_MIN_DIST_PX = AI_BLOCK_PX * 0.15;

const EASY_HEAD_CONDITION_THRESHOLD = 0.80;
const MEDIUM_HEAD_CONDITION_THRESHOLD = 0.55;
const HARD_HEAD_CONDITION_THRESHOLD = 0.35;
const HARDCORE_HEAD_CONDITION_THRESHOLD = 0.22;
const EASY_BODY_CONDITION_THRESHOLD = 0.90;
const MEDIUM_BODY_CONDITION_THRESHOLD = 0.60;
const HARD_BODY_CONDITION_THRESHOLD = 0.40;
const HARDCORE_BODY_CONDITION_THRESHOLD = 0.25;

// ===== FIGHT-TO-WIN LAYER =====
// Everything here changes what the AI *decides*, never what it hits for. No
// stat, damage figure, reach or hit chance is touched by any of it. Each knob is
// keyed by difficulty band so the lower tiers keep the softer fighter they have
// always been and Champion gets the full treatment.

/** Share of punches aimed downstairs before the posture read moves it. */
const AI_BODY_BIAS_BASE = 0.65;
/** How far the duck-vs-stand read may move that base, either way. */
const AI_BODY_BIAS_SWING = 0.25;
/** Half-life (sec) of the duck/stand posture window, so it tracks the round. */
const AI_POSTURE_WINDOW_SEC = 10;

/** Bands whose defensive reflexes yield to a live assault instead of cutting it. */
const REFLEX_YIELDS_TO_ASSAULT: Record<DifficultyBand, boolean> = {
  Hardcore: true, Hard: true, Medium: false, Easy: false,
};

/** Seconds of hands-up discipline after an exchange, split by who landed. */
const POST_EXCHANGE_GUARD_HIT: Record<DifficultyBand, number> = {
  Hardcore: 1.2, Hard: 1.2, Medium: 1.2, Easy: 1.2,
};
const POST_EXCHANGE_GUARD_LANDED: Record<DifficultyBand, number> = {
  Hardcore: 0.0, Hard: 0.25, Medium: 0.7, Easy: 1.2,
};

/** |swayOffset| / 5 at which the engine treats a punch as thrown from the power zone. */
const AI_POWER_SWAY_NORM = 0.9;
/** Chance the AI holds a shot a beat to land it in its own power zone. */
const AI_POWER_SWAY_HUNT: Record<DifficultyBand, number> = {
  Hardcore: 0.75, Hard: 0.55, Medium: 0.30, Easy: 0.10,
};
/** Longest that wait may hold a punch back. */
const AI_POWER_SWAY_MAX_WAIT = 0.22;
/** Cooldown on the power-sway roll so it cannot be re-rolled at frame rate. */
const AI_POWER_SWAY_ROLL_CD = 0.25;
/** Sway travel already covered before a wait is worth taking at all. */
const AI_POWER_SWAY_MIN_PROGRESS = 0.45;

/** Chance a near-empty fighter answers rather than covering up, by band. */
const SURVIVAL_COUNTER_CHANCE: Record<DifficultyBand, number> = {
  Hardcore: 0.85, Hard: 0.65, Medium: 0.30, Easy: 0.12,
};

// ===== DEFENSIVE TIMING =====
// The rhythm-cut sync watches the player's sway and times a punch into the
// window it opens. This is the same machinery pointed the other way: watch the
// player's *punching* and have the perfect block already up when the shot
// lands. It learns from its own error with the same EMA.
//
// The read is deliberately not a clock average over the fight. It is the last
// five intervals between their punches: enough to call a rhythm, and short
// enough that a fighter who changes pace mid-round moves it inside one
// exchange, where a fight-long mean would still be describing the first minute.
/** Punch starts kept for the rolling read (N starts -> N-1 intervals). */
const PLAYER_PUNCH_WINDOW = 6;
/** Usable intervals needed before the AI will time anything off the read. */
const BLOCK_SYNC_MIN_INTERVALS = 3;
/** A gap outside this band is a pause between exchanges, not a rhythm. */
const BLOCK_SYNC_MIN_INTERVAL = 0.12;
const BLOCK_SYNC_MAX_INTERVAL = 2.5;
/** Chance the AI commits to a predicted block once the window opens, by band. */
const BLOCK_SYNC_CHANCE: Record<DifficultyBand, number> = {
  Hardcore: 0.85, Hard: 0.60, Medium: 0.25, Easy: 0,
};
/** Slack on the learned landing range: how far out still counts as "they can reach me". */
const BLOCK_SYNC_RANGE_SLOP_PX = 16;
/** Guard rise plus commit time -- how early the block has to go up to be up on time. */
const BLOCK_SYNC_LEAD_SEC = 0.10;
/** Longest a string will hold its beat waiting for the punch it predicted. */
const BLOCK_SYNC_MAX_WAIT = 0.55;
/** Gap between predicted blocks, so a bad read cannot become a permanent shell. */
const BLOCK_SYNC_COOLDOWN = 0.90;
/** EMA weight on the timing error. Matches the rhythm-cut sync's 75/25 blend. */
const BLOCK_SYNC_EMA = 0.25;
/** Clamp on the learned correction, seconds either way. */
const BLOCK_SYNC_CORR_MAX_SEC = 0.16;
/** Fallback flight time before a jab windup has been observed. */
const BLOCK_SYNC_DEFAULT_FLIGHT = 0.12;
/**
 * Grace past the predicted impact before a live prediction is written off.
 * Without it a punch that never comes -- the player backs out, the round ends,
 * they stop throwing -- would leave the prediction armed and let some unrelated
 * shot minutes later train the timing against a stale target.
 */
const BLOCK_SYNC_GRACE_SEC = 0.60;

function blocksToPixels(blocks: number): number {
  return blocks * AI_BLOCK_PX;
}

function pixelsToBlocks(px: number): number {
  return px / AI_BLOCK_PX;
}

/** Every career-roster champion fights with the same brain: Wolfgang "Superman"
 *  Aruzenai Jr. (roster id 204, BoxerPuncher). Champion-difficulty roster opponents
 *  build their AI from his identity instead of their own, so they share his neural
 *  tuning, offense profile, archetype biases and style profile.
 *  Only the *brain* is redirected — stats, level, refinements, rank, reach, record and
 *  appearance stay the fighter's own, so champions still hit like themselves. Opponents
 *  with no roster id (quick fight, Nightmare, menu fights) are never redirected.
 *  Set CHAMPION_AI_SOURCE_ID to null to hand champions their individual brains back. */
export const CHAMPION_AI_SOURCE_ID: number | null = 204;
const CHAMPION_AI_SOURCE_ARCHETYPE: Archetype = "BoxerPuncher";

/** The roster identity an AI brain is built from. */
function resolveAiIdentity(
  difficulty: AIDifficulty,
  archetype: Archetype,
  rosterId?: number,
): { rosterId?: number; archetype: Archetype } {
  // Training seeds are all champions but must each think for themselves — the
  // shared-brain redirect would collapse a whole population into one boxer and
  // every seed would score identically.
  if (isTrainingRosterId(rosterId)) return { rosterId, archetype };
  if (CHAMPION_AI_SOURCE_ID != null && difficulty === "champion" && rosterId != null) {
    return { rosterId: CHAMPION_AI_SOURCE_ID, archetype: CHAMPION_AI_SOURCE_ARCHETYPE };
  }
  return { rosterId, archetype };
}

function createPersonality(difficulty: DifficultyBand, archetype: Archetype, rosterId?: number): AiPersonality {
  const base: AiPersonality = {
    aggression: 0.45,
    guardParanoia: 0.35,
    feintiness: 0.15,
    cleanHitsOverVolume: 0.30,
    headBias: 0.50,
  };

  switch (difficulty) {
    case "Easy":
      base.aggression = rng.rollRange01(0.20, 0.46);
      base.guardParanoia = rng.rollRange01(0.15, 0.35);
      base.feintiness = rng.rollRange01(0.05, 0.15);
      base.cleanHitsOverVolume = rng.rollRange01(0.10, 0.30);
      break;
    case "Medium":
      base.aggression = rng.rollRange01(0.46, 0.72);
      base.guardParanoia = rng.rollRange01(0.25, 0.45);
      base.feintiness = rng.rollRange01(0.12, 0.28);
      base.cleanHitsOverVolume = rng.rollRange01(0.25, 0.50);
      break;
    case "Hard":
      base.aggression = rng.rollRange01(0.72, 0.90);
      base.guardParanoia = rng.rollRange01(0.35, 0.55);
      base.feintiness = rng.rollRange01(0.20, 0.38);
      base.cleanHitsOverVolume = rng.rollRange01(0.40, 0.65);
      break;
    case "Hardcore":
      base.aggression = rng.rollRange01(0.85, 1.0);
      base.guardParanoia = rng.rollRange01(0.45, 0.65);
      base.feintiness = rng.rollRange01(0.28, 0.45);
      base.cleanHitsOverVolume = rng.rollRange01(0.55, 0.80);
      break;
  }

  switch (archetype) {
    case "OutBoxer":
      base.aggression -= 0.10;
      base.cleanHitsOverVolume += 0.15;
      base.guardParanoia += 0.05;
      break;
    case "Brawler":
      base.aggression += 0.15;
      base.cleanHitsOverVolume -= 0.10;
      base.guardParanoia -= 0.05;
      break;
    case "Swarmer":
      base.aggression += 0.10;
      base.feintiness -= 0.05;
      base.cleanHitsOverVolume -= 0.05;
      break;
  }

  const neuralDiffKey = difficulty === "Easy" ? "journeyman" : difficulty === "Medium" ? "contender" : difficulty === "Hard" ? "elite" : "champion";
  try {
    const overrides = getNeuralOverrides(rosterId);
    const ns = overrides[neuralDiffKey as keyof typeof overrides];
    if (ns) {
      const bias = 0.20;
      base.aggression = base.aggression * (1 - bias) + (ns.aggression ?? base.aggression) * bias;
      base.guardParanoia = base.guardParanoia * (1 - bias) + (ns.guardParanoia ?? base.guardParanoia) * bias;
      base.feintiness = base.feintiness * (1 - bias) + (ns.feintiness ?? base.feintiness) * bias;
      base.cleanHitsOverVolume = base.cleanHitsOverVolume * (1 - bias) + (ns.cleanHitsVsVolume ?? base.cleanHitsOverVolume) * bias;
    }
  } catch {}

  base.aggression = clamp01(base.aggression);
  base.guardParanoia = clamp01(base.guardParanoia);
  base.feintiness = clamp01(base.feintiness);
  base.cleanHitsOverVolume = clamp01(base.cleanHitsOverVolume);
  base.headBias = clamp01(base.headBias);

  return base;
}

function createDataBank(): AiDataBank {
  return {
    recentHits: [],
    recentWhiffs: [],
    offensiveEvents: [],
    hitPatterns: [],
    maxHitHistory: 200,
    maxWhiffHistory: 120,
    maxHitPatterns: 50,
    patternWindowSeconds: 2.0,
    patternIntervalTolerance: 0.18,
  };
}

function getArchetypeBiases(archetype: Archetype): { aggBias: number; rangeBias: number; comboBias: number } {
  switch (archetype) {
    case "OutBoxer": return { aggBias: -0.18, rangeBias: 0.30, comboBias: -0.10 };
    case "Brawler": return { aggBias: 0.22, rangeBias: -0.18, comboBias: 0.12 };
    case "Swarmer": return { aggBias: 0.15, rangeBias: -0.10, comboBias: 0.18 };
    default: return { aggBias: 0, rangeBias: 0, comboBias: 0 };
  }
}

// ===== STYLE PROFILE =====

interface StyleProfile {
  styleDuckApproach: number;
  styleCrossHeavy: number;
  styleBodyFocus: number;
  styleCounterOffDuck: number;
  styleEngageCycleIn: number;
  styleEngageCycleOut: number;
  styleIdealResetDist: number;
  styleIdealEngageDist: number;
  styleLateralApproach: number;
  styleJabSetup: number;
  stylePatience: number;
  styleDefenseCycling: number;
  styleCounterOffGuardDrop: number;
  styleChargedPunchUsage: number;
  styleDefenseDiscipline: number;
  styleAntiDuckUppercut: number;
  styleRetreatTracking: number;
  styleBodyDefenseAdapt: number;
  styleSustainedDuckCounter: number;
  stylePostDodgeFollowup: number;
}

function createStyleProfile(band: DifficultyBand, archetype: Archetype): StyleProfile {
  const baseDuck = rng.rollRange01(0.10, 0.55);
  const baseCross = rng.rollRange01(0.20, 0.65);
  const baseBody = rng.rollRange01(0.15, 0.55);
  const baseCounter = rng.rollRange01(0.15, 0.60);
  const baseLateral = rng.rollRange01(0.15, 0.45);
  const baseJab = rng.rollRange01(0.20, 0.55);
  const basePatience = rng.rollRange01(0.20, 0.65);
  const baseResetDist = rng.range(90, 125);
  const baseEngageDist = rng.range(55, 80);
  const baseCycleIn = rng.range(2.5, 6.0);
  const baseCycleOut = rng.range(3.0, 7.0);
  const baseDefCycling = rng.rollRange01(0.20, 0.70);
  const baseGuardDropCounter = rng.rollRange01(0.15, 0.60);
  const baseChargePunch = rng.rollRange01(0.10, 0.45);
  const baseDefDiscipline = rng.rollRange01(0.25, 0.70);
  const baseAntiDuckUppercut = rng.rollRange01(0.20, 0.65);
  const baseRetreatTracking = rng.rollRange01(0.15, 0.55);
  const baseBodyDefAdapt = rng.rollRange01(0.20, 0.60);
  const baseSustainedDuckCounter = rng.rollRange01(0.15, 0.55);
  const basePostDodgeFollowup = rng.rollRange01(0.10, 0.50);

  let duck = baseDuck;
  let cross = baseCross;
  let body = baseBody;
  let counter = baseCounter;
  let lateral = baseLateral;
  let jab = baseJab;
  let patience = basePatience;
  let resetDist = baseResetDist;
  let engageDist = baseEngageDist;
  let cycleIn = baseCycleIn;
  let cycleOut = baseCycleOut;
  let defCycling = baseDefCycling;
  let guardDropCounter = baseGuardDropCounter;
  let chargePunch = baseChargePunch;
  let defDiscipline = baseDefDiscipline;
  let antiDuckUppercut = baseAntiDuckUppercut;
  let retreatTracking = baseRetreatTracking;
  let bodyDefAdapt = baseBodyDefAdapt;
  let sustainedDuckCounter = baseSustainedDuckCounter;
  let postDodgeFollowup = basePostDodgeFollowup;

  switch (archetype) {
    case "OutBoxer":
      jab += 0.15;
      patience += 0.12;
      lateral += 0.10;
      resetDist += 12;
      engageDist += 8;
      cross -= 0.08;
      duck -= 0.06;
      defDiscipline += 0.10;
      guardDropCounter += 0.08;
      antiDuckUppercut += 0.06;
      retreatTracking += 0.08;
      bodyDefAdapt += 0.05;
      sustainedDuckCounter += 0.10;
      postDodgeFollowup += 0.05;
      break;
    case "Brawler":
      body += 0.10;
      cross += 0.10;
      counter += 0.08;
      patience -= 0.15;
      cycleIn += 1.5;
      cycleOut -= 1.0;
      resetDist -= 10;
      engageDist -= 8;
      jab -= 0.10;
      defCycling += 0.10;
      chargePunch += 0.10;
      antiDuckUppercut += 0.12;
      bodyDefAdapt += 0.08;
      sustainedDuckCounter += 0.08;
      postDodgeFollowup += 0.10;
      break;
    case "Swarmer":
      patience -= 0.12;
      cycleIn += 2.0;
      cycleOut -= 1.5;
      lateral += 0.08;
      duck += 0.05;
      body += 0.06;
      resetDist -= 8;
      engageDist -= 10;
      defCycling += 0.05;
      retreatTracking += 0.12;
      antiDuckUppercut += 0.05;
      sustainedDuckCounter += 0.06;
      postDodgeFollowup += 0.08;
      break;
    default:
      break;
  }

  let quality: number;
  let duckCap: number;
  switch (band) {
    case "Hardcore":
      quality = 1.0;
      duckCap = 1.0;
      break;
    case "Hard":
      quality = 0.70;
      duckCap = 0.30;
      break;
    case "Medium":
      quality = 0.40;
      duckCap = 0.18;
      break;
    default:
      quality = 0.15;
      duckCap = 0.10;
      break;
  }

  duck = lerp(duck * 0.30, clamp01(duck), quality);
  duck = Math.min(duck, duckCap);
  cross = lerp(cross * 0.40, clamp01(cross), quality);
  body = lerp(body * 0.35, clamp01(body), quality);
  counter = lerp(counter * 0.25, clamp01(counter), quality);
  lateral = lerp(lateral * 0.30, clamp01(lateral), quality);
  jab = lerp(jab * 0.50, clamp01(jab), quality);
  patience = lerp(patience * 0.25, clamp01(patience), quality);
  resetDist = lerp(85, resetDist, quality);
  engageDist = lerp(80, engageDist, quality);
  cycleIn = lerp(cycleIn * 0.6 + 3, cycleIn, quality);
  cycleOut = lerp(cycleOut * 0.4 + 2, cycleOut, quality);
  defCycling = lerp(defCycling * 0.15, clamp01(defCycling), quality);
  guardDropCounter = lerp(guardDropCounter * 0.10, clamp01(guardDropCounter), quality);
  chargePunch = lerp(chargePunch * 0.15, clamp01(chargePunch), quality);
  defDiscipline = lerp(defDiscipline * 0.20, clamp01(defDiscipline), quality);
  antiDuckUppercut = lerp(antiDuckUppercut * 0.10, clamp01(antiDuckUppercut), quality);
  retreatTracking = lerp(retreatTracking * 0.10, clamp01(retreatTracking), quality);
  bodyDefAdapt = lerp(bodyDefAdapt * 0.10, clamp01(bodyDefAdapt), quality);
  sustainedDuckCounter = lerp(sustainedDuckCounter * 0.10, clamp01(sustainedDuckCounter), quality);
  postDodgeFollowup = lerp(postDodgeFollowup * 0.10, clamp01(postDodgeFollowup), quality);

  return {
    styleDuckApproach: clamp01(duck),
    styleCrossHeavy: clamp01(cross),
    styleBodyFocus: clamp01(body),
    styleCounterOffDuck: clamp01(counter),
    styleEngageCycleIn: clamp(cycleIn, 2.0, 8.0),
    styleEngageCycleOut: clamp(cycleOut, 2.0, 9.0),
    styleIdealResetDist: clamp(resetDist, 80, 140),
    styleIdealEngageDist: clamp(engageDist, 45, 90),
    styleLateralApproach: clamp01(lateral),
    styleJabSetup: clamp01(jab),
    stylePatience: clamp01(patience),
    styleDefenseCycling: clamp01(defCycling),
    styleCounterOffGuardDrop: clamp01(guardDropCounter),
    styleChargedPunchUsage: clamp01(chargePunch),
    styleDefenseDiscipline: clamp01(defDiscipline),
    styleAntiDuckUppercut: clamp01(antiDuckUppercut),
    styleRetreatTracking: clamp01(retreatTracking),
    styleBodyDefenseAdapt: clamp01(bodyDefAdapt),
    styleSustainedDuckCounter: clamp01(sustainedDuckCounter),
    stylePostDodgeFollowup: clamp01(postDodgeFollowup),
  };
}

// ===== BRAIN INITIALIZATION =====

/** Starting anticipatory-perfect-block chance: difficulty base, nudged up for high career ranks.
 *  Rank 1 sits at the top of the 85–95% band; the boost fades out across the top 100 ranks.
 *  Bouts with no career rank (quick fight, sparring, Nightmare, Doghouse, menu) use the base alone. */
function computeAnticipationBaseChance(band: DifficultyBand, careerRank: number | null): number {
  const base = ANTICIPATION_BASE_CHANCE[band] ?? 0.60;
  if (careerRank == null || careerRank <= 0) return base;
  const proximity = clamp01((ANTICIPATION_RANK_BOOST_SPAN - careerRank) / (ANTICIPATION_RANK_BOOST_SPAN - 1));
  return clamp(base + ANTICIPATION_RANK_BOOST_MAX * proximity, 0, 0.95);
}

/** The 2x aggression pass folded into the attack interval. Applied inside the
 *  neural write rather than after it, so a mid-bout re-derivation lands on the
 *  same scale as the original roll instead of an unscaled one. */
const ATTACK_INTERVAL_AGGRESSION = 0.167;

/** The knobs that reach the brain. A derived state carries all 25; this is the
 *  eight of them that anything here reads. */
interface NeuralKnobs {
  stateThinkSpeed?: number;
  moveThinkSpeed?: number;
  attackInterval?: number;
  rhythmCutCommit?: number;
  rhythmCutAggression?: number;
  executionIntensity?: number;
  rhythmSwayAdapt?: number;
  perfectBlockIntent?: number;
}

/**
 * Write a neural state onto a brain, computed from the baseline out.
 *
 * Every field is derived from `base` rather than from where the brain currently
 * sits, which makes this idempotent: calling it again with different knobs
 * replaces the previous write instead of compounding with it. That is what lets
 * the Champion change fundamental in the middle of a bout without drifting a
 * little further from its roll every time.
 *
 * `liveSwitch` marks a mid-bout call. Anticipation chance adapts as the bout
 * runs, so a switch leaves it where the fight has taken it; only the intent it
 * was seeded from is rewritten.
 */
function applyNeuralState(
  brain: AiBrainState, base: NeuralBaseline,
  ns: NeuralKnobs | Record<string, number> | undefined | null,
  liveSwitch = false,
) {
  const b = 0.15;
  const mix = (from: number, to: number) => from * (1 - b) + to * b;

  brain.stateThinkInterval = ns?.stateThinkSpeed !== undefined
    ? mix(base.stateThinkInterval, lerp(0.50, 0.15, ns.stateThinkSpeed))
    : base.stateThinkInterval;
  brain.moveThinkInterval = ns?.moveThinkSpeed !== undefined
    ? mix(base.moveThinkInterval, lerp(0.3125, 0.08, ns.moveThinkSpeed))
    : base.moveThinkInterval;
  brain.attackThinkInterval = (ns?.attackInterval !== undefined
    ? mix(base.attackThinkInterval, lerp(0.875, 0.14, ns.attackInterval))
    : base.attackThinkInterval) * ATTACK_INTERVAL_AGGRESSION;
  brain.rhythmCutCommitChanceRoll01 = ns?.rhythmCutCommit !== undefined
    ? mix(base.rhythmCutCommitChanceRoll01, ns.rhythmCutCommit)
    : base.rhythmCutCommitChanceRoll01;
  brain.rhythmCutAggression01 = ns?.rhythmCutAggression !== undefined
    ? mix(base.rhythmCutAggression01, ns.rhythmCutAggression)
    : base.rhythmCutAggression01;
  brain.execIntensity = ns?.executionIntensity !== undefined
    ? clamp01(mix(base.execIntensity, ns.executionIntensity))
    : base.execIntensity;

  // Taken straight rather than blended: this knob has no rolled baseline of its
  // own, it *is* the amount of self-adaptation the tuning asks for.
  brain.rhythmSwayAdapt01 = ns?.rhythmSwayAdapt !== undefined
    ? clamp01(ns.rhythmSwayAdapt)
    : base.rhythmSwayAdapt01;

  // Intentional perfect block. A fundamentals seed is the only thing that sets
  // this field, so an absent knob leaves the difficulty-and-rank baseline exactly
  // as it was. Present, it takes most of the anticipatory chance — the seed's
  // defensive character IS the fighter — while the baseline keeps a share so
  // difficulty still counts for something. Held inside the same band every
  // brain's adaptive chance lives in, so a seed can be a heavy blocker but never
  // an automatic one.
  brain.perfectBlockIntent01 = ns?.perfectBlockIntent !== undefined
    ? clamp01(ns.perfectBlockIntent)
    : base.perfectBlockIntent01;
  if (!liveSwitch) {
    brain.anticipationChance = ns?.perfectBlockIntent !== undefined
      ? clamp(
        base.anticipationChance * (1 - PB_INTENT_ANTICIPATION_SHARE)
          + brain.perfectBlockIntent01 * PB_INTENT_ANTICIPATION_SHARE,
        ANTICIPATION_CHANCE_FLOOR,
        ANTICIPATION_CHANCE_CAP,
      )
      : base.anticipationChance;
  }
}

/** How often the live situation is read, in seconds. Long enough for the
 *  trailing windows to have moved, short enough to catch an exchange. */
const SITUATION_READ_INTERVAL = 0.5;

/**
 * Switch the Champion onto whichever fundamental suits the situation it is in.
 *
 * Training publishes the champion's parameters together with the situations each
 * fundamental was learned in. The live situation is read on an interval and
 * matched against all of them; the closest match above the activation floor
 * names a fundamental, and the champion's parameters with that fundamental's
 * remembered block swapped in are re-derived into knobs and written onto the
 * brain. It stays in effect until some other fundamental matches better.
 *
 * No match at all leaves the current one running. A situation nothing was
 * learned in is not evidence that the fundamental in effect has stopped
 * applying, and dropping back to the base mix every time the fight passes
 * through unfamiliar ground would make this flicker rather than commit.
 */
function updateFundamentalSwitch(brain: AiBrainState, dt: number, self: FighterState, opp: FighterState) {
  if (!brain.fundamentalSwitching || !brain.neuralBase) return;
  const champ = getChampionFundamentals();
  if (!champ) return;

  if (!brain.situationTracker) brain.situationTracker = new SituationTracker();
  brain.situationTracker.update(dt, self, opp);

  brain.situationReadAcc = (brain.situationReadAcc ?? 0) + dt;
  if (brain.situationReadAcc < SITUATION_READ_INTERVAL) return;
  brain.situationReadAcc = 0;

  const hit = bestFundamentalFor(champ.store, brain.situationTracker.read(self, opp));
  if (!hit || hit.fundKey === brain.activeFundKey) return;

  brain.activeFundKey = hit.fundKey;
  // Sound because the parameter -> knob map is affine: swapping one
  // fundamental's block and re-deriving moves exactly the knobs that fundamental
  // feeds, and leaves the other 72 contributing what they always did.
  applyNeuralState(brain, brain.neuralBase,
    deriveNeuralState({ params: { ...champ.params, ...hit.state.p } }), true);
}

export function initAiBrain(difficulty: AIDifficulty, archetype: Archetype, level: number, cpuVsCpu: boolean = false, rosterId?: number, isSparring: boolean = false, careerRank?: number): AiBrainState {
  rng = new AiRNG(Date.now() ^ (level * 7919));
  const band = DIFFICULTY_TO_BAND[difficulty];
  // Champions all share one brain (see CHAMPION_AI_SOURCE_ID); everyone else is themselves.
  const { rosterId: brainRosterId, archetype: brainArchetype } = resolveAiIdentity(difficulty, archetype, rosterId);
  const diffScore = band === "Easy" ? 0.15 : band === "Medium" ? 0.40 : band === "Hard" ? 0.70 : 0.95;
  const personality = createPersonality(band, brainArchetype, brainRosterId);
  const biases = getArchetypeBiases(brainArchetype);

  let winnerMindIntensity = lerp(0.3, 1.1, diffScore);
  const wmBase = rng.rollRange01(0.3, 0.7);
  winnerMindIntensity *= lerp(0.6, 1.4, wmBase);
  winnerMindIntensity = clamp(winnerMindIntensity, 0.2, 1.2);

  const winnerMindRoll01 = rollWinnerMind(band);
  const rhythmCutCommitRoll = rollRhythmCutCommit(band);
  const jabDoctrineRoll = rollJabDoctrine(band);
  const rhythmCutAgg = setBaseRhythmCutAggression(band);

  // Rhythm Attacking: the opening chain's shape. Re-rolled after each whole
  // chain is spent, so a long fight is a run of differently-shaped chains.
  const raBudgetRoll = raRollInt(RA_BUDGET_MIN, RA_BUDGET_MAX);
  const raPerfectBlockTol = raRollInt(RA_PERFECT_BLOCK_TOL_MIN, RA_PERFECT_BLOCK_TOL_MAX);
  const raAvoidedTol = raRollInt(RA_AVOIDED_TOL_MIN, RA_AVOIDED_TOL_MAX);

  const style = createStyleProfile(band, brainArchetype);

  // Per-fighter deterministic offense/defense execution profile. Roster fighters
  // regenerate the exact same profile every time (pure function of id+archetype),
  // matching whatever is persisted in career saves. Non-roster opponents get a
  // stable-within-fight random profile.
  const offense = brainRosterId != null
    ? generateOffenseProfile(brainRosterId, brainArchetype)
    : generateFallbackOffenseProfile(brainArchetype, Date.now() ^ (level * 131));
  const execIntensity = band === "Easy" ? 0.25 : band === "Medium" ? 0.55 : band === "Hard" ? 0.80 : 1.0;

  if (cpuVsCpu) {
    style.stylePatience = clamp01(style.stylePatience * 0.25);
    style.styleEngageCycleIn = clamp(style.styleEngageCycleIn * 1.6, 3.0, 12.0);
    style.styleEngageCycleOut = clamp(style.styleEngageCycleOut * 0.35, 1.0, 3.0);
    style.styleDefenseDiscipline = clamp01(style.styleDefenseDiscipline * 0.5);
    style.styleIdealResetDist = clamp(style.styleIdealResetDist * 0.75, 50, 100);
  }

  const brain: AiBrainState = {
    currentState: "Maintain",
    currentPhase: band === "Easy" ? "Download" : "Probe",
    difficultyBand: band,
    difficultyScore: diffScore,
    isSparring,
    personality,
    dataBank: createDataBank(),

    stateThinkTimer: 0,
    phaseThinkTimer: 0,
    moveThinkTimer: 0,
    attackThinkTimer: 0,
    defenseThinkTimer: 0,

    stateThinkInterval: lerp(0.50, 0.15, diffScore),
    phaseThinkInterval: lerp(1.00, 0.30, diffScore),
    moveThinkInterval: lerp(0.3125, 0.08, diffScore),
    attackThinkInterval: cpuVsCpu ? lerp(0.50, 0.12, diffScore) : lerp(0.875, 0.14, diffScore) / (band === "Easy" ? 3.25 : band === "Medium" ? 2.86 : band === "Hard" ? 2.6 : 1.3),
    defenseThinkInterval: lerp(0.375, 0.08, diffScore),

    defenseHoldTimer: 0,
    playerIdleTime: 0,
    playerCornerCamping: false,
    playerLastX: 0,
    playerLastZ: 0,
    playerCornerStallTimer: 0,

    prevMyStamina: -1,
    prevPlayerStamina: -1,
    punchesTakenByAI: 0,
    playerCleanHitsLanded: 0,
    punchesLandedByAI: 0,
    totalDamageTaken: 0,
    lastTimeTookHit: 0,

    headConditionScore: 0,
    bodyConditionScore: 0,

    survivalModeActive: false,

    perfectReactActive: false,
    perfectReactUntil: 0,
    nextPerfectReactTime: 0,
    perfectReactFadeFrac: 0,
    perfectReactBelowFullStaminaTimer: 0,
    forcedGuard: false,
    forcedHigh: false,
    forcedLow: false,
    forcedDuck: false,
    stepOutDesiredMove: 0,
    baseDefStepPhase: 0,
    baseDefStepRemainingPx: 0,
    baseDefStepOutX: 0,
    baseDefStepOutZ: 0,
    baseDefStepTimer: 0,

    strings: createAiStringRuntime(),
    patterns: createAiPatternMemory(),

    perfectBlockHoldTimer: 0,
    perfectBlockHoldMs: 300,
    perfectBlockIntent01: PB_INTENT_NEUTRAL,
    resetRollTimer: 0,

    careerRank: careerRank != null && careerRank > 0 ? careerRank : null,
    anticipationChance: computeAnticipationBaseChance(band, careerRank != null && careerRank > 0 ? careerRank : null),
    nextAnticipationTime: 0,
    anticipationArmed: false,
    timingAdjustLocked: false,

    playerCloseEvents: 0,
    playerCloseAndFireEvents: 0,
    playerCloseWatchActive: false,
    playerCloseWatchUntil: 0,
    playerDistSampleTimer: 0,
    playerDistSampleLast: -1,
    playerPrevPunching: false,
    playerPunchRegistered: false,
    playerFeintRolled: false,
    playerBurstPunches: 0,
    playerBurstStartTime: 0,
    playerBurstLastPunchTime: -99,
    playerBurstHistory: [],

    pressureActive: false,
    pressureUntil: 0,
    pressureCooldown: 0,
    pressureFollowupsLeft: 0,
    pressureCounterWindowUntil: 0,

    comboChaseChance: COMBO_CHASE_BASE_CHANCE,
    comboChaseActive: false,
    comboChaseAdaptTimer: 0,

    desiredMoveInput: 0,
    desiredMoveZ: 0,
    lateralDir: rng.next01() < 0.5 ? 1 : -1,
    aiPdrActive: false,
    aiPdrRollTimer: 0,
    rcDelayTimer: 0,
    rcNudgeActive: false,
    rcTimingLearntMs: 0,
    rcMissOffsetMs: 0,
    aiStunCount: 0,
    playerStunCount: 0,
    rcDriftApplied: false,
    aiChargeTargetBars: 0,
    aiChargeArmDelayTimer: 0,
    lateralSwitchTimer: 0,
    hitReactRetreatTimer: 0,
    hitReactLateralDir: rng.next01() < 0.5 ? 1 : -1,

    counterModeActive: false,

    directionalSlider01: 0.50,
    playerHighBlockHeldSeconds: 0,
    playerLowBlockHeldSeconds: 0,

    scorecardBias: 0,
    punchDeficit: 0,

    classAggressionBias: biases.aggBias,
    classRangeBias: biases.rangeBias,
    classComboBias: biases.comboBias,

    winnerMindIntensity,
    winnerMindRoll01,

    rhythmCutAggression01: rhythmCutAgg,
    rhythmCutCommitChanceRoll01: rhythmCutCommitRoll,
    rhythmCutUntil: 0,
    nextRhythmCutAllowedTime: 0,

    jabDoctrineRoll01: jabDoctrineRoll,

    raBudgetRoll,
    raPerfectBlockTol,
    raAvoidedTol,
    raSeqBudget: 0,
    raActive: false,
    raPaused: false,
    raPunchesLeft: 0,
    raPerfectBlocks: 0,
    raAvoided: 0,
    raCutStreak: 0,
    raStunTriggerUsed: false,
    statRaSequences: 0,
    statRaChains: 0,

    nextWinnerMindRerollAtTaken: 50,
    nextRhythmCutCommitRerollAtTaken: 30,
    nextJabDoctrineRerollAtTaken: 20,
    nextRhythmCutAggressionDriftAtLanded: 50,

    comboActive: false,
    comboSteps: [],
    comboStepIndex: 0,
    comboStepTimer: 0,
    comboCooldown: 0,

    gameTime: 0,

    attackRangeMin: blocksToPixels(0.30),
    // The engagement band is anchored to real punching distance, matching the
    // player's: a 65" arm lands a jab at ~85px and recorded bouts show the
    // player committing from ~42-80px. Attacking from 1.35 blocks (94px) had
    // the AI opening up from where nothing could land, so its ideal distances
    // now sit inside its own reach.
    attackRangeMax: blocksToPixels(1.20),
    // Base desired punching distance, editable on the Neural Network screen.
    // Defaults to 0.75 blocks (52.5px); every other ideal range below is a
    // deliberate offset from that neutral anchor and stays fixed.
    idealRangeNeutral: getAiRangeConfig().baseDesiredDistancePx,
    idealRangePressure: blocksToPixels(0.55),
    idealRangeWhiffPunish: blocksToPixels(1.05),
    idealRangeCounter: blocksToPixels(0.95),
    idealRangeSurvival: blocksToPixels(1.60),
    rangeWidth: blocksToPixels(0.50),
    counterRangeWidth: blocksToPixels(0.35),

    playerLandedPunchCounts: {},

    ...style,
    adaptationRate: levelScale(level, 0.20, 0.70, "aiAdaptationRate"),
    engageCycleTimer: 0,
    engageCyclePhase: "out",
    defenseCycleTimer: 0,
    playerGuardDropTimer: 0,
    playerDuckApproachTimer: 0,
    playerBodyAttackRatio: 0,
    playerBodyAttackCount: 0,
    playerHeadAttackCount: 0,
    playerRetreatTimer: 0,
    playerSustainedDuckTimer: 0,
    playerDuckPunchCount: 0,
    playerDuckPunchDecay: 0,
    styleSustainedDuckCounter: style.styleSustainedDuckCounter,
    stylePostDodgeFollowup: style.stylePostDodgeFollowup,
    lastPunchDodgedTimer: 0,
    playerCrossCount: 0,
    playerTotalPunchCount: 0,
    playerLastDefenseSwitch: 0,
    playerPrevDefenseState: "none",
    recentPlayerPunches: [],
    playerApproaching: false,

    postFeintWindow: 0,
    postFeintPlayerDefense: "none",
    postFeintFollowupReady: false,

    reactionDelayTimer: 0,
    reactionDelayBase: band === "Easy" ? 0.28 : band === "Medium" ? 0.18 : band === "Hard" ? 0.10 : 0.04,
    reactionDelayPerHit: band === "Easy" ? 0.06 : band === "Medium" ? 0.04 : band === "Hard" ? 0.02 : 0.01,
    reactionDelayConsecutiveHits: 0,
    reactionDelayConsecutiveDecay: 0,

    adaptiveMemory: null,

    lastKnownPlayerSwaySpeed: -1,
    rhythmTimingAccuracy: 0,
    landedPunchDistSnapshots: [],
    aiLearntRangeAvg: 0,
    aiRhythmChangeTimer: 0,
    aiRhythmTargetLevel: 3,
    aiRhythmSpeedMult: 1.0 + (Math.random() * 0.2 - 0.1),
    rangeForgetChance: 0.35,
    rangeWhiffDeficits: [],
    rangeLearnClosePx: 0,
    rangeCloseIntentTimer: 0,
    lastRangeWhiffPunch: null,

    duckBodyBias: rng.rollRange01(0.60, 0.90),
    standHeadBias: rng.rollRange01(0.60, 0.90),
    prevPlayerDuckState: false,

    whiffSnapshots: [],
    whiffLearnTimer: rng.rollRange01(8, 12),
    whiffLearnRangeNudge: 0,
    whiffLearnBodyBiasNudge: 0,
    whiffLearnKdPenalty: 0,

    guardHighProb: 0.75,
    guardReactionTimer: 0,
    guardReactionDelay: band === "Easy" ? rng.rollRange01(0.30, 0.50) : band === "Medium" ? rng.rollRange01(0.20, 0.35) : band === "Hard" ? rng.rollRange01(0.10, 0.22) : rng.rollRange01(0.05, 0.14),
    guardPendingSwitch: null,
    guardConditioningMemory: [],
    guardConditioningMax: 12,
    guardPredictionConfidence: band === "Easy" ? 0.35 : band === "Medium" ? 0.55 : band === "Hard" ? 0.75 : 0.90,
    guardFatigueReactionPenalty: 0,

    preDuckUppercutActive: false,
    preDuckUppercutTimer: 0,
    preDuckUppercutQueue: [],
    preDuckUppercutCooldown: 0,

    comboLimitTimer: 0,
    comboLimitMax: 0,
    staminaPenaltyStreak: 0,
    staminaPenaltyCooldown: 0,

    stanceSwitchChance: 0.10 + Math.random() * 0.20,
    stanceSwitchDuration: 5 + Math.random() * 40,
    stanceSwitchTimer: 0,
    stanceCleanHitStreak: 0,
    stanceCleanStreakTriggers: 0,

    offense,
    execIntensity,
    bodyCampaignActive: false,
    bodyCampaignUntil: 0,
    bodyCampaignCooldown: 0,
    bodyCampaignCashIn: false,
    chargedAmbushCooldown: 3 + rng.next01() * 5,
    chargeRespectCooldown: 0,
    lastLandedPunchType: null,
    lastLandedPunchTime: 0,
    postExchangeGuardUntil: 0,
    headSpamLastPunchTime: 0,
    headSpamIntervals: [],
    headSpamDuckUntil: 0,
    bodySpamDuckUntil: 0,
    bodySpamCounterReadyUntil: 0,
  };

  // Snapshotted before anything is written, because ordinary play re-applies
  // these knobs mid-bout when the situation calls for a different fundamental.
  const neuralBase: NeuralBaseline = {
    stateThinkInterval: brain.stateThinkInterval,
    moveThinkInterval: brain.moveThinkInterval,
    attackThinkInterval: brain.attackThinkInterval,
    rhythmCutCommitChanceRoll01: brain.rhythmCutCommitChanceRoll01,
    rhythmCutAggression01: brain.rhythmCutAggression01,
    execIntensity: brain.execIntensity,
    rhythmSwayAdapt01: brain.rhythmSwayAdapt01,
    perfectBlockIntent01: brain.perfectBlockIntent01,
    anticipationChance: brain.anticipationChance,
  };
  brain.neuralBase = neuralBase;

  const neuralDiffKey = band === "Easy" ? "journeyman" : band === "Medium" ? "contender" : band === "Hard" ? "elite" : "champion";
  try {
    const overrides = getNeuralOverrides(brainRosterId);
    applyNeuralState(brain, neuralBase, overrides[neuralDiffKey as keyof typeof overrides]);
  } catch {
    // No tuning to read. The baseline still has to be written through, because
    // the attack-interval scaling lives inside the same call.
    applyNeuralState(brain, neuralBase, undefined);
  }

  // Only the Champion switches fundamental mid-bout, and never a training seed:
  // a cycle scores one seed's fixed parameters, so a seed that re-derived its
  // knobs part-way through a bout would not be the seed being measured.
  brain.fundamentalSwitching = neuralDiffKey === "champion" && !isTrainingRosterId(brainRosterId);
  brain.situationTracker = null;
  brain.situationReadAcc = 0;
  brain.activeFundKey = null;

  // 2× aggression: less patience, more time pressing, less time backing off. The
  // attack-interval half of this lives inside applyNeuralState, so that a
  // mid-bout re-derivation gets it too.
  brain.stylePatience = clamp01(brain.stylePatience * 0.5);
  brain.styleEngageCycleIn = Math.min(12.0, brain.styleEngageCycleIn * 1.5);
  brain.styleEngageCycleOut = Math.max(1.0, brain.styleEngageCycleOut * 0.5);

  // RL tactical policy, per the Neural Network screen's deployment setting.
  // Never on a training seed: the trainer attaches its own when it wants one.
  brain.rl = null;
  if (!isTrainingRosterId(rosterId) && !isTrainingRosterId(brainRosterId)) {
    try {
      const policy = rlPolicyForDifficulty(difficulty);
      if (policy) attachRlPolicy(brain, policy);
    } catch {
      /* no storage to read: the weighted chooser it is */
    }
  }

  return brain;
}

function rollWinnerMind(band: DifficultyBand): number {
  if (band === "Easy") return rng.rollRange01(0.05, 0.30);
  if (band === "Medium") return rng.rollRange01(0.30, 0.55);
  if (band === "Hard") return rng.rollRange01(0.55, 0.80);
  return rng.rollRange01(0.80, 1.00);
}

function rollRhythmCutCommit(band: DifficultyBand): number {
  if (band === "Medium") return rng.rollRange01(0.10, 0.40);
  if (band === "Hard") return rng.rollRange01(0.40, 0.70);
  if (band === "Hardcore") return rng.rollRange01(0.70, 0.95);
  return 0;
}

function rollJabDoctrine(band: DifficultyBand): number {
  if (band === "Easy") return rng.rollRange01(0.20, 0.30);
  if (band === "Medium") return rng.rollRange01(0.30, 0.40);
  if (band === "Hard") return rng.rollRange01(0.40, 0.50);
  return rng.rollRange01(0.50, 0.60);
}

function setBaseRhythmCutAggression(band: DifficultyBand): number {
  if (band === "Easy") return 0;
  if (band === "Medium") return 0.20;
  if (band === "Hard") return 0.50;
  return 0.80;
}

function getMyStaminaFrac(enemy: FighterState): number {
  return enemy.maxStamina > 0 ? clamp01(enemy.stamina / enemy.maxStamina) : 1;
}

function getPlayerStaminaFrac(player: FighterState): number {
  return player.maxStamina > 0 ? clamp01(player.stamina / player.maxStamina) : 1;
}

function getDistancePx(enemy: FighterState, player: FighterState): number {
  const dx = player.x - enemy.x;
  const dz = player.z - enemy.z;
  return Math.sqrt(dx * dx + dz * dz);
}

// Hard cap on how far away the AI is allowed to throw punches from, per difficulty.
// Below Journeyman's more forgiving reach, higher difficulties demand tighter range discipline.
function getMaxPunchThrowDistPx(band: DifficultyBand): number {
  switch (band) {
    case "Hardcore": return 100; // Champion
    case "Hard": return 105; // Elite
    case "Medium": return 110; // Contender
    default: return 115; // Easy / Journeyman
  }
}

function getDirToPlayer(enemy: FighterState, player: FighterState): number {
  const dx = player.x - enemy.x;
  return dx > 0 ? 1 : dx < 0 ? -1 : 1;
}

function getScoreAggressionBias(brain: AiBrainState): number {
  return clamp(brain.scorecardBias, -1, 1);
}

function getCognitiveLoadBias(brain: AiBrainState, myFrac: number): number {
  if (myFrac <= DEEP_SURVIVAL_FRAC) return 1.35;
  if (brain.survivalModeActive) return 1.25;
  if (brain.currentPhase === "Panic") return 1.15;
  return 1.0;
}

// ===== THINK TIMING =====

function thinkAwake(timer: number, baseInterval: number, brain: AiBrainState, myFrac: number, dt: number): { awake: boolean; timer: number } {
  timer += dt;
  const staminaMult = lerp(1.35, 0.75, myFrac);
  const diffMult = lerp(1.15, 0.75, clamp01(brain.difficultyScore));
  const wmClamped = clamp(brain.winnerMindIntensity, 0.2, 1.2);
  const wmNorm = inverseLerp(0.2, 1.2, wmClamped);
  const winnerMult = lerp(1.05, 0.85, wmNorm);
  const cogBias = getCognitiveLoadBias(brain, myFrac);
  const interval = baseInterval * staminaMult * diffMult * winnerMult * Math.max(0.1, cogBias);
  if (timer >= interval) {
    return { awake: true, timer: 0 };
  }
  return { awake: false, timer };
}

function conditioningGateActive(brain: AiBrainState): boolean {
  if (brain.totalDamageTaken <= CONDITION_DAMAGE_GATE_MIN) return false;
  return brain.totalDamageTaken >= CONDITION_DAMAGE_GATE;
}

function getHeadConditionFraction(brain: AiBrainState): number {
  const threshold = brain.difficultyBand === "Easy" ? EASY_HEAD_CONDITION_THRESHOLD :
    brain.difficultyBand === "Medium" ? MEDIUM_HEAD_CONDITION_THRESHOLD :
    brain.difficultyBand === "Hard" ? HARD_HEAD_CONDITION_THRESHOLD :
    HARDCORE_HEAD_CONDITION_THRESHOLD;
  if (threshold <= 0) return 0;
  let baseFrac = clamp01(brain.headConditionScore / threshold);
  if (!conditioningGateActive(brain)) baseFrac *= 0.25;
  const dmgFrac = inverseLerp(CONDITION_DAMAGE_GATE_MIN, CONDITION_DAMAGE_GATE_MAX, brain.totalDamageTaken);
  return clamp01(baseFrac * lerp(0.5, 1.5, dmgFrac));
}

function getBodyConditionFraction(brain: AiBrainState): number {
  const threshold = brain.difficultyBand === "Easy" ? EASY_BODY_CONDITION_THRESHOLD :
    brain.difficultyBand === "Medium" ? MEDIUM_BODY_CONDITION_THRESHOLD :
    brain.difficultyBand === "Hard" ? HARD_BODY_CONDITION_THRESHOLD :
    HARDCORE_BODY_CONDITION_THRESHOLD;
  if (threshold <= 0) return 0;
  let baseFrac = clamp01(brain.bodyConditionScore / threshold);
  if (!conditioningGateActive(brain)) baseFrac *= 0.25;
  const dmgFrac = inverseLerp(CONDITION_DAMAGE_GATE_MIN, CONDITION_DAMAGE_GATE_MAX, brain.totalDamageTaken);
  return clamp01(baseFrac * lerp(0.5, 1.5, dmgFrac));
}

function getLastHits(db: AiDataBank, actor: "player" | "ai", count: number): AiHitSummary {
  const summary: AiHitSummary = { headHits: 0, bodyHits: 0 };
  let processed = 0;
  for (let i = db.recentHits.length - 1; i >= 0 && processed < count; i--) {
    const rec = db.recentHits[i];
    if (rec.actor !== actor) continue;
    processed++;
    if (rec.region === "head") summary.headHits++;
    else summary.bodyHits++;
  }
  return summary;
}

function getAiMomentum(db: AiDataBank, windowSeconds: number, gameTime: number): number {
  if (windowSeconds <= 0) return 0.5;
  let aiHits = 0, playerHits = 0;
  for (let i = db.recentHits.length - 1; i >= 0; i--) {
    const rec = db.recentHits[i];
    if (gameTime - rec.time > windowSeconds) break;
    if (rec.actor === "ai") aiHits++;
    else playerHits++;
  }
  const total = aiHits + playerHits;
  if (total === 0) return 0.5;
  const raw = (aiHits - playerHits) / total;
  return clamp01(0.5 + 0.5 * raw);
}

function getPlayerAggression(db: AiDataBank, windowSeconds: number, gameTime: number): number {
  if (windowSeconds <= 0) return 0;
  let playerHits = 0;
  for (let i = db.recentHits.length - 1; i >= 0; i--) {
    const rec = db.recentHits[i];
    if (gameTime - rec.time > windowSeconds) break;
    if (rec.actor === "player") playerHits++;
  }
  return clamp01(playerHits / 10);
}

function getWhiffCount(db: AiDataBank, actor: "player" | "ai", windowSeconds: number, inRangeOnly: boolean, gameTime: number): number {
  if (windowSeconds <= 0) return 0;
  let count = 0;
  for (let i = db.recentWhiffs.length - 1; i >= 0; i--) {
    const wr = db.recentWhiffs[i];
    if (gameTime - wr.time > windowSeconds) break;
    if (wr.actor !== actor) continue;
    if (inRangeOnly && !wr.inRange) continue;
    count++;
  }
  return count;
}

// ===== HIT DETECTION & COMBAT TRACKING =====

function logHit(db: AiDataBank, actor: "player" | "ai", region: "head" | "body", damage: number, inRange: boolean, gameTime: number): void {
  db.recentHits.push({ time: gameTime, actor, region, damage, inRange });
  if (db.recentHits.length > db.maxHitHistory) db.recentHits.shift();
  if (actor === "player" && inRange) {
    db.offensiveEvents.push({ time: gameTime, isFeint: false, inRange: true });
    pruneOffensiveEvents(db, gameTime);
    maybeBuildPattern(db, "punch", gameTime);
  }
}

function logWhiff(db: AiDataBank, actor: "player" | "ai", inRange: boolean, gameTime: number): void {
  db.recentWhiffs.push({ time: gameTime, actor, inRange });
  if (db.recentWhiffs.length > db.maxWhiffHistory) db.recentWhiffs.shift();
}

function pruneOffensiveEvents(db: AiDataBank, gameTime: number): void {
  const cutoff = gameTime - (db.patternWindowSeconds + 0.5);
  while (db.offensiveEvents.length > 0 && db.offensiveEvents[0].time < cutoff) {
    db.offensiveEvents.shift();
  }
}

function tryComputeCurrentTempo(db: AiDataBank, wantFeints: boolean, gameTime: number): { success: boolean; avgInterval: number; eventCount: number } {
  const windowStart = gameTime - db.patternWindowSeconds;
  const times: number[] = [];
  for (let i = db.offensiveEvents.length - 1; i >= 0; i--) {
    const e = db.offensiveEvents[i];
    if (e.time < windowStart) break;
    if (!e.inRange) continue;
    if (e.isFeint !== wantFeints) continue;
    times.push(e.time);
  }
  if (times.length < 2) return { success: false, avgInterval: 0, eventCount: 0 };
  times.sort((a, b) => a - b);
  let sum = 0;
  for (let i = 1; i < times.length; i++) sum += times[i] - times[i - 1];
  return { success: true, avgInterval: sum / (times.length - 1), eventCount: times.length };
}

function maybeBuildPattern(db: AiDataBank, kind: "punch" | "feint", gameTime: number): void {
  const { success, avgInterval, eventCount } = tryComputeCurrentTempo(db, kind === "feint", gameTime);
  if (!success) return;
  if (rng.next01() > 0.5) return;
  for (let i = 0; i < db.hitPatterns.length; i++) {
    const p = db.hitPatterns[i];
    if (p.kind !== kind) continue;
    if (Math.abs(p.avgInterval - avgInterval) < db.patternIntervalTolerance * 0.5) {
      db.hitPatterns[i].lastSeenTime = gameTime;
      return;
    }
  }
  db.hitPatterns.push({
    kind, avgInterval, eventCount, lastSeenTime: gameTime, successfulCounters: 0, locked: false,
  });
  if (db.hitPatterns.length > db.maxHitPatterns) {
    let oldestIdx = -1, oldestTime = Infinity;
    for (let i = 0; i < db.hitPatterns.length; i++) {
      if (db.hitPatterns[i].locked) continue;
      if (db.hitPatterns[i].lastSeenTime < oldestTime) {
        oldestTime = db.hitPatterns[i].lastSeenTime;
        oldestIdx = i;
      }
    }
    if (oldestIdx >= 0) db.hitPatterns.splice(oldestIdx, 1);
    else db.hitPatterns.shift();
  }
}

function tryGetCurrentPatternMatch(db: AiDataBank, windowSeconds: number, gameTime: number): { matched: boolean; patternIndex: number } {
  if (db.hitPatterns.length === 0) return { matched: false, patternIndex: -1 };
  const punch = tryComputeCurrentTempo(db, false, gameTime);
  if (!punch.success) return { matched: false, patternIndex: -1 };
  let bestDiff = Infinity, bestIdx = -1;
  for (let i = 0; i < db.hitPatterns.length; i++) {
    const p = db.hitPatterns[i];
    if (p.kind !== "punch") continue;
    const diff = Math.abs(p.avgInterval - punch.avgInterval);
    if (diff > db.patternIntervalTolerance) continue;
    const score = diff * (p.locked ? 0.9 : 1.0);
    if (score < bestDiff) {
      bestDiff = score;
      bestIdx = i;
    }
  }
  if (bestIdx >= 0) {
    db.hitPatterns[bestIdx].lastSeenTime = gameTime;
    return { matched: true, patternIndex: bestIdx };
  }
  return { matched: false, patternIndex: -1 };
}

function updateConditioning(brain: AiBrainState, dt: number): void {
  if (brain.headConditionScore > 0)
    brain.headConditionScore = Math.max(0, brain.headConditionScore - CONDITION_DECAY_PER_SEC * dt);
  if (brain.bodyConditionScore > 0)
    brain.bodyConditionScore = Math.max(0, brain.bodyConditionScore - CONDITION_DECAY_PER_SEC * dt);
}

function trackStaminaHitsAndPatterns(brain: AiBrainState, enemy: FighterState, player: FighterState): void {
  const myNow = enemy.stamina;
  const theirNow = player.stamina;
  if (brain.prevMyStamina < 0) brain.prevMyStamina = myNow;
  if (brain.prevPlayerStamina < 0) brain.prevPlayerStamina = theirNow;

  const myDelta = brain.prevMyStamina - myNow;
  const theirDelta = brain.prevPlayerStamina - theirNow;
  const dist = getDistancePx(enemy, player);
  const inPatternRange = dist <= PATTERN_RANGE_MAX_PX;

  if (myDelta >= HIT_DETECT_THRESHOLD) {
    brain.punchesTakenByAI++;
    brain.playerCleanHitsLanded++;
    brain.totalDamageTaken += myDelta;
    brain.lastTimeTookHit = brain.gameTime;
    brain.reactionDelayConsecutiveHits++;
    brain.reactionDelayConsecutiveDecay = 0;
    const delay = brain.reactionDelayBase + brain.reactionDelayPerHit * brain.reactionDelayConsecutiveHits;
    brain.reactionDelayTimer = Math.max(brain.reactionDelayTimer, delay);

    let hitReactThreshold = brain.difficultyBand === "Easy" ? 18 : brain.difficultyBand === "Medium" ? 14 : 8;
    if (brain.survivalModeActive) hitReactThreshold = Math.max(3, Math.floor(hitReactThreshold * 0.5));
    if (myDelta >= hitReactThreshold) {
      let reactDuration = brain.difficultyBand === "Hardcore" ? 0.35 : brain.difficultyBand === "Hard" ? 0.25 : brain.difficultyBand === "Medium" ? 0.18 : 0.12;
      if (brain.survivalModeActive) reactDuration *= 1.5;
      brain.hitReactRetreatTimer = Math.max(brain.hitReactRetreatTimer, reactDuration);
      brain.hitReactLateralDir = rng.next01() < 0.5 ? 1 : -1;
    }

    const last3 = getLastHits(brain.dataBank, "player", 3);
    const leanHead = last3.headHits >= last3.bodyHits;
    if (leanHead) brain.headConditionScore += HEAD_HIT_CONDITION_VALUE;
    else brain.bodyConditionScore += BODY_HIT_CONDITION_VALUE;

    const region: "head" | "body" = leanHead ? "head" : "body";
    const punchKey = player.currentPunch ? player.currentPunch : (leanHead ? "headHit" : "bodyHit");
    brain.playerLandedPunchCounts[punchKey] = (brain.playerLandedPunchCounts[punchKey] || 0) + 1;

    if (!player.punchAimsHead) {
      brain.playerBodyAttackCount++;
    } else {
      brain.playerHeadAttackCount++;
    }

    if (player.defenseState === "duck") {
      brain.playerDuckPunchCount++;
      brain.playerDuckPunchDecay = 0;
    }

    brain.playerTotalPunchCount = (brain.playerTotalPunchCount || 0) + 1;
    if (punchKey === "cross") brain.playerCrossCount = (brain.playerCrossCount || 0) + 1;
    if (!brain.recentPlayerPunches) brain.recentPlayerPunches = [];
    brain.recentPlayerPunches.push(punchKey);
    if (brain.recentPlayerPunches.length > 10) brain.recentPlayerPunches.shift();

    logHit(brain.dataBank, "player", region, myDelta, inPatternRange, brain.gameTime);

    maybeHandleRerolls(brain);

    // Getting hit disrupts the AI's rhythm plan and erodes its timing read
    if (rng.chance(0.60)) {
      const shift = rng.chance(0.50) ? 1 : -1;
      brain.aiRhythmTargetLevel = clamp(brain.aiRhythmTargetLevel + shift, 1, 5);
      brain.aiRhythmChangeTimer = 0; // apply the shift promptly
    }
    brain.rhythmTimingAccuracy = clamp01(brain.rhythmTimingAccuracy - 0.08);
  }

  if (theirDelta >= HIT_DETECT_THRESHOLD) {
    brain.punchesLandedByAI++;
    logHit(brain.dataBank, "ai", "head", theirDelta, inPatternRange, brain.gameTime);
    maybeHandleRhythmCutDrift(brain);
    // Difficulty-scaled chance to actually learn from this punch
    const learnChanceByBand: Record<DifficultyBand, number> = {
      Easy: 0.35, Medium: 0.50, Hard: 0.65, Hardcore: 0.75,
    };
    if (rng.chance(learnChanceByBand[brain.difficultyBand])) {
      snapLandedPunchRange(brain, enemy, player);
    }
  }

  brain.prevMyStamina = myNow;
  brain.prevPlayerStamina = theirNow;
}

function maybeHandleRerolls(brain: AiBrainState): void {
  if (brain.punchesTakenByAI >= brain.nextWinnerMindRerollAtTaken) {
    brain.winnerMindRoll01 = rollWinnerMind(brain.difficultyBand);
    brain.winnerMindIntensity = brain.winnerMindRoll01;
    brain.nextWinnerMindRerollAtTaken = brain.punchesTakenByAI + 50;
  }
  if (brain.punchesTakenByAI >= brain.nextRhythmCutCommitRerollAtTaken) {
    brain.rhythmCutCommitChanceRoll01 = rollRhythmCutCommit(brain.difficultyBand);
    brain.nextRhythmCutCommitRerollAtTaken = brain.punchesTakenByAI + 30;
  }
  if (brain.punchesTakenByAI >= brain.nextJabDoctrineRerollAtTaken) {
    brain.jabDoctrineRoll01 = rollJabDoctrine(brain.difficultyBand);
    brain.nextJabDoctrineRerollAtTaken = brain.punchesTakenByAI + 20;
  }
}

function maybeHandleRhythmCutDrift(brain: AiBrainState): void {
  if (brain.punchesLandedByAI < brain.nextRhythmCutAggressionDriftAtLanded) return;
  const drift = rng.rollRange01(-0.01, 0.01);
  brain.rhythmCutAggression01 = clamp01(brain.rhythmCutAggression01 + drift);
  brain.nextRhythmCutAggressionDriftAtLanded += 50;
}

function updateSurvivalMode(brain: AiBrainState, myFrac: number): void {
  brain.survivalModeActive = myFrac <= SURVIVAL_FRAC;
}

function evaluateState(brain: AiBrainState, enemy: FighterState, player: FighterState): void {
  const myFrac = getMyStaminaFrac(enemy);
  const theirFrac = getPlayerStaminaFrac(player);
  const dist = getDistancePx(enemy, player);

  if (myFrac <= DEEP_SURVIVAL_FRAC) {
    brain.currentState = "Panic";
    brain.currentPhase = "Panic";
    return;
  }
  if (brain.survivalModeActive) {
    brain.currentState = "Retreat";
    if (brain.currentPhase !== "Panic") brain.currentPhase = "Panic";
    return;
  }
  if (theirFrac <= PLAYER_FINISH_FRAC) {
    brain.currentState = dist <= brain.attackRangeMax ? "Maintain" : "Approach";
    brain.currentPhase = "Finish";
    return;
  }

  const ideal = getIdealRangeForPhase(brain);
  const width = brain.currentPhase === "Counter" ? brain.counterRangeWidth : brain.rangeWidth;
  const min = Math.max(blocksToPixels(0.2), ideal - width * 0.5);
  const max = ideal + width * 0.5;

  const bias = getScoreAggressionBias(brain);
  const aheadFactor = clamp01(-bias);
  const behindFactor = clamp01(bias);
  const clean = brain.personality.cleanHitsOverVolume;

  const approachReluctance = aheadFactor * blocksToPixels(0.25) + lerp(0, blocksToPixels(0.18), clean);
  const retreatReluctance = behindFactor * blocksToPixels(0.15) + lerp(0, blocksToPixels(0.08), clean);

  // Mid-assault the comfort band is suspended on the near side: a string that
  // has walked into punching range is not "too close", it is where it meant to
  // be, and stepping back off it is what turns a sequence into single shots
  // thrown from the edge of reach.
  const assaulting = isAiStringAssault(brain);

  if (dist > max + blocksToPixels(0.08) + approachReluctance) brain.currentState = "Approach";
  else if (dist < min - blocksToPixels(0.08) - retreatReluctance) brain.currentState = assaulting ? "Maintain" : "Retreat";
  else brain.currentState = "Maintain";

  // A punch just came up short on distance: override the comfort band and walk in
  // until the measured gap is closed.
  if ((brain.rangeCloseIntentTimer ?? 0) > 0 && dist > min) brain.currentState = "Approach";

  // Pressure entry overrides the comfortable-range preference: walk into the player's
  // own fighting band and hold there. Panic/survival/finish keep their earlier returns.
  if (brain.pressureActive) {
    brain.currentState = dist > PRESSURE_RANGE_PX + PRESSURE_RANGE_TOLERANCE_PX ? "Approach" : "Maintain";
  }

  // Rhythm Attacking overrides the comfort band outright -- following the player
  // is half of what the behaviour is. It sits last so it wins over the pressure
  // override, but below the Panic/survival/finish early returns above, so a
  // sequence can never march a nearly-out fighter forward.
  if (isRhythmAttackDriving(brain)) {
    brain.currentState = dist > brain.attackRangeMax ? "Approach" : "Maintain";
  }
}

function evaluatePhase(brain: AiBrainState, enemy: FighterState, player: FighterState): void {
  const myFrac = getMyStaminaFrac(enemy);
  const theirFrac = getPlayerStaminaFrac(player);

  if (myFrac <= DEEP_SURVIVAL_FRAC || brain.survivalModeActive) {
    brain.currentPhase = "Panic";
    return;
  }
  if (theirFrac <= PLAYER_FINISH_FRAC) {
    brain.currentPhase = "Finish";
    return;
  }
  if (brain.counterModeActive) {
    brain.currentPhase = "Counter";
    return;
  }

  const momentum = getAiMomentum(brain.dataBank, 6, brain.gameTime);
  const playerAgg = getPlayerAggression(brain.dataBank, 6, brain.gameTime);
  const headCond = getHeadConditionFraction(brain);
  const bodyCond = getBodyConditionFraction(brain);
  const scoreBias = getScoreAggressionBias(brain);
  const scoreInfluence = clamp(scoreBias * 0.18, -0.18, 0.18);
  const adjustedMomentum = clamp01(momentum - scoreInfluence);
  const winning = adjustedMomentum > 0.60;
  const losing = adjustedMomentum < 0.40;
  const clean = brain.personality.cleanHitsOverVolume;

  if (losing && playerAgg > 0.55) { brain.currentPhase = "WhiffPunish"; return; }
  if (clean > 0.62 && playerAgg > 0.42) { brain.currentPhase = "WhiffPunish"; return; }
  if (bodyCond > headCond + 0.15 && bodyCond > 0.35) { brain.currentPhase = "BodyHunt"; return; }
  if (winning && myFrac > LOW_STAMINA_FRAC && clean < 0.55) { brain.currentPhase = "Pressure"; return; }
  if (brain.difficultyBand === "Easy") brain.currentPhase = "Download";
  else brain.currentPhase = "Probe";
}

function getIdealRangeForPhase(brain: AiBrainState): number {
  let baseIdeal: number;
  switch (brain.currentPhase) {
    case "Pressure": baseIdeal = brain.idealRangePressure; break;
    case "WhiffPunish": baseIdeal = brain.idealRangeWhiffPunish; break;
    case "Counter": baseIdeal = brain.idealRangeCounter; break;
    case "Panic": baseIdeal = brain.idealRangeSurvival; break;
    case "Finish": baseIdeal = brain.idealRangePressure; break;
    case "BodyHunt": baseIdeal = brain.idealRangeNeutral; break;
    default: baseIdeal = brain.idealRangeNeutral; break;
  }

  const bias = getScoreAggressionBias(brain);
  const shiftPx = blocksToPixels(clamp(0.35, 0, 0.75));
  let ideal = baseIdeal - bias * shiftPx + brain.classRangeBias * AI_BLOCK_PX;
  const clean = brain.personality.cleanHitsOverVolume;

  if (brain.currentPhase !== "Pressure" && brain.currentPhase !== "Finish" && brain.currentPhase !== "Panic") {
    ideal += lerp(-blocksToPixels(0.02), blocksToPixels(0.18), clean);
  }

  // Blend toward empirically-learnt effective attack range as sample count grows
  if (brain.aiLearntRangeAvg > 0 && brain.landedPunchDistSnapshots.length >= 3) {
    const blendT = clamp01(brain.landedPunchDistSnapshots.length / 8) * 0.55;
    ideal = lerp(ideal, brain.aiLearntRangeAvg, blendT);
  }

  // Whiff-learning range nudge: mid-fight adjustments from missed shot analysis
  ideal += brain.whiffLearnRangeNudge;

  // Range-whiff learning: punches that could not physically reach pull the
  // preferred engagement distance in by the measured pixel shortfall.
  ideal -= brain.rangeLearnClosePx ?? 0;

  // Applied last so the shift lands in full: added before the learnt-range
  // blend above it would be washed out by up to 55%.
  ideal += getAiRangeConfig().standDistanceOffsetPx;

  return clamp(ideal, blocksToPixels(0.35), blocksToPixels(2.25));
}

function updateEngageCycle(brain: AiBrainState, dt: number): void {
  brain.engageCycleTimer += dt;
  const adaptIn = getSlotValue(brain.adaptiveMemory, "engageCycleInBias");
  const adaptOut = getSlotValue(brain.adaptiveMemory, "engageCycleOutBias");
  if (brain.engageCyclePhase === "in") {
    if (brain.engageCycleTimer >= Math.max(0.5, brain.styleEngageCycleIn + adaptIn * 3.0)) {
      brain.engageCyclePhase = "out";
      brain.engageCycleTimer = 0;
    }
  } else {
    if (brain.engageCycleTimer >= Math.max(0.5, brain.styleEngageCycleOut + adaptOut * 2.0)) {
      brain.engageCyclePhase = "in";
      brain.engageCycleTimer = 0;
    }
  }
}

function reactToPlayerTelegraph(brain: AiBrainState, enemy: FighterState, player: FighterState): void {
  if (enemy.isPunching || enemy.isKnockedDown || enemy.stunBlockDisableTimer > 0) return;
  if (player.telegraphPhase === "none") return;

  const telegraphPct = player.telegraphDuration > 0 ? player.telegraphTimer / player.telegraphDuration : 0;
  if (telegraphPct < 0.3) return;

  if (enemy.defenseState === "fullGuard") return;

  const baseChance: Record<DifficultyBand, number> = {
    Hardcore: 0.95,
    Hard: 0.90,
    Medium: 0.85,
    Easy: 0.80,
  };

  const decay = Math.floor(brain.playerCleanHitsLanded / 10) * 0.0025;
  const chance = Math.max(0.40, baseChance[brain.difficultyBand] - decay);

  if (rng.chance(chance)) {
    enemy.defenseState = "fullGuard";
  }
}

// ===== DEFENSE CYCLING & PLAYER TRACKING =====

function updateDefenseCycling(brain: AiBrainState, enemy: FighterState, player: FighterState, dt: number): void {
  brain.defenseCycleTimer += dt;
  const cycling = brain.styleDefenseCycling;
  if (cycling < 0.15) return;

  const dist = getDistancePx(enemy, player);
  if (dist > brain.attackRangeMax * 1.5) return;

  const isChamp = brain.difficultyBand === "Hardcore" || brain.difficultyBand === "Hard";
  const cycleMin = isChamp ? 0.55 : 0.25;
  const cycleInterval = lerp(0.8, cycleMin, cycling);
  if (brain.defenseCycleTimer < cycleInterval) return;
  brain.defenseCycleTimer = 0;

  if (enemy.isPunching || brain.perfectReactActive) return;
  if (enemy.stunBlockDisableTimer > 0) return;

  const current = enemy.defenseState;
  const r = rng.next01();

  const bodyHeavy = brain.playerBodyAttackRatio > 0.6 && brain.styleBodyDefenseAdapt > 0.2 && rng.chance(brain.adaptationRate);
  const playerClose = dist < brain.attackRangeMax * 1.1;
  const playerDangerous = player.isPunching || player.handsDown || player.defenseState === "duck";
  const playerTelegraphing = player.telegraphPhase !== "none";
  const suppressGuardDrop = isChamp && (playerClose && playerDangerous || playerTelegraphing);
  const playerDucked = player.defenseState === "duck";
  const playerUppercutThreat = brain.playerLandedPunchCounts["leftUppercut"] > 0 || brain.playerLandedPunchCounts["rightUppercut"] > 0;
  const suppressDuck = isChamp && playerUppercutThreat && rng.chance(brain.adaptationRate * 0.8);

  const isHardcore = brain.difficultyBand === "Hardcore";
  const champSuppressCycling = isChamp && rng.chance(isHardcore ? 0.60 : 0.50);
  if (champSuppressCycling) return;

  const setAiBlock = (state: DefenseState) => {
    enemy.defenseState = state;
  };

  const cycleRateDown = isChamp ? cycling * 0.20 : cycling * 0.5;
  const cycleRateSwitch = isChamp ? cycling * 0.15 : cycling * 0.4;

  if (current === "none" && r < cycleRateDown) {
    const pick = rng.next01();
    if (bodyHeavy) {
      if (pick < 0.55) setAiBlock("fullGuard");
      else if (pick < 0.80) setAiBlock("fullGuard");
      else setAiBlock(suppressDuck ? "fullGuard" : "duck");
    } else {
      if (pick < 0.30) setAiBlock(suppressDuck ? "fullGuard" : "duck");
      else if (pick < 0.60) setAiBlock("fullGuard");
      else setAiBlock("fullGuard");
    }
    if (isChamp && playerDucked) {
      if (enemy.defenseState === "duck") setAiBlock("fullGuard");
    }
  } else if (current !== "none" && r < cycleRateSwitch) {
    const pick = rng.next01();
    if (current === "duck") {
      if (isChamp) {
        setAiBlock(pick < 0.35 ? "none" : "fullGuard");
      } else {
        setAiBlock(pick < 0.5 ? "fullGuard" : "fullGuard");
      }
    } else if (current === "fullGuard") {
      if (bodyHeavy) {
        const noneChance = suppressGuardDrop ? 0.0 : (isChamp ? 0.15 : 0.2);
        setAiBlock(pick < 0.3 ? "fullGuard" : pick < 0.3 + noneChance ? "none" : "fullGuard");
      } else {
        if (suppressGuardDrop) {
          setAiBlock(pick < 0.5 ? (suppressDuck ? "fullGuard" : "duck") : "fullGuard");
        } else {
          const noneWeight = isChamp ? 0.20 : 0.30;
          setAiBlock(pick < 0.3 ? (suppressDuck ? "fullGuard" : "duck") : pick < 0.3 + noneWeight ? "none" : "fullGuard");
        }
      }
    }
    if (isChamp && playerDucked && enemy.defenseState === "duck") {
      setAiBlock("fullGuard");
    }
  }
}

function updateAiDirectionalGuard(brain: AiBrainState, enemy: FighterState, player: FighterState, dt: number): void {
  if (enemy.isKnockedDown || enemy.isPunching || enemy.defenseState === "duck") return;

  const staminaFrac = enemy.stamina / enemy.maxStamina;
  brain.guardFatigueReactionPenalty = Math.max(0, (1 - staminaFrac) * 0.15);

  const mem = brain.guardConditioningMemory;
  const now = brain.gameTime;
  while (mem.length > 0 && now - mem[0].time > 15) mem.shift();

  let headDmg = 0, bodyDmg = 0;
  for (const m of mem) {
    if (m.zone === "head") headDmg += m.damage;
    else bodyDmg += m.damage;
  }
  const totalDmg = headDmg + bodyDmg;
  if (totalDmg > 0) {
    const headFrac = headDmg / totalDmg;
    const adaptSpeed = brain.difficultyBand === "Hardcore" ? 0.04 : brain.difficultyBand === "Hard" ? 0.03 : brain.difficultyBand === "Medium" ? 0.02 : 0.01;
    const target = 0.50 + headFrac * 0.40;
    brain.guardHighProb += (target - brain.guardHighProb) * adaptSpeed;
  } else {
    brain.guardHighProb += (0.75 - brain.guardHighProb) * 0.005;
  }

  const fatigueNoise = brain.guardFatigueReactionPenalty > 0.05 ? (rng.next01() - 0.5) * brain.guardFatigueReactionPenalty * 0.3 : 0;
  brain.guardHighProb = clamp01(brain.guardHighProb + fatigueNoise);
  brain.guardHighProb = Math.max(0.10, Math.min(0.90, brain.guardHighProb));

  if (player.telegraphPhase !== "none" && player.telegraphPunchType) {
    const telegraphPct = player.telegraphDuration > 0 ? player.telegraphTimer / player.telegraphDuration : 0;
    if (telegraphPct > 0.4) {
      const pType = player.telegraphPunchType;
      const config = PUNCH_CONFIGS[pType];
      const predictHead = config ? config.hitsHead : true;
      const confRoll = rng.next01();
      if (confRoll < brain.guardPredictionConfidence) {
        const desired: "high" | "low" = predictHead ? "high" : "low";
        if (brain.guardPendingSwitch !== desired) {
          brain.guardPendingSwitch = desired;
          const baseDelay = brain.guardReactionDelay + brain.guardFatigueReactionPenalty;
          const jitter = (rng.next01() - 0.5) * baseDelay * 0.3;
          brain.guardReactionTimer = Math.max(0.02, baseDelay + jitter);
        }
      }
    }
  }

  if (brain.guardReactionTimer > 0) {
    brain.guardReactionTimer -= dt;
    if (brain.guardReactionTimer <= 0) {
      brain.guardReactionTimer = 0;
      if (brain.guardPendingSwitch) {
        if (brain.guardPendingSwitch === "high") {
          enemy.defenseState = "fullGuard";
        } else {
          enemy.defenseState = "none";
          enemy.handsDown = false;
        }
        brain.guardPendingSwitch = null;
      }
    }
  }

  if (!brain.guardPendingSwitch) {
    if (rng.chance(0.02)) {
      if (rng.next01() < brain.guardHighProb) {
        enemy.defenseState = "fullGuard";
      } else {
        enemy.defenseState = "none";
        enemy.handsDown = false;
      }
    }
  }
}

function trackPlayerGuardDrop(brain: AiBrainState, player: FighterState, dt: number): void {
  if (player.handsDown && !player.isPunching) {
    brain.playerGuardDropTimer += dt;
  } else {
    brain.playerGuardDropTimer = 0;
  }
}

function trackPlayerDuckApproach(brain: AiBrainState, enemy: FighterState, player: FighterState, dt: number): void {
  const dist = getDistancePx(enemy, player);
  const playerDucked = player.defenseState === "duck";
  const closing = dist < brain.attackRangeMax * 1.8;
  if (playerDucked && closing) {
    brain.playerDuckApproachTimer += dt;
  } else {
    brain.playerDuckApproachTimer = Math.max(0, brain.playerDuckApproachTimer - dt * 2);
  }
}

function trackPlayerRetreat(brain: AiBrainState, enemy: FighterState, player: FighterState, dt: number): void {
  const dist = getDistancePx(enemy, player);
  const movingAway = dist > brain.styleIdealResetDist * 1.2 && player.handsDown && !player.isPunching;
  if (movingAway) {
    brain.playerRetreatTimer += dt;
  } else {
    brain.playerRetreatTimer = Math.max(0, brain.playerRetreatTimer - dt * 1.5);
  }
}

function updatePlayerBodyRatio(brain: AiBrainState): void {
  const total = brain.playerBodyAttackCount + brain.playerHeadAttackCount;
  if (total > 0) {
    brain.playerBodyAttackRatio = brain.playerBodyAttackCount / total;
  }
}

/**
 * Rolling read of how the opponent carries themselves: seconds spent crouched
 * versus standing tall while inside punching range, decayed on a half-life so it
 * describes the round being fought rather than the whole bout.
 *
 * This is what moves the AI off its 65% body base. An opponent who stands tall
 * behind a high guard is leaving the body open, so the downstairs share climbs;
 * one who lives in a crouch keeps putting their head through the AI's punching
 * line, so it drops and the AI works upstairs more.
 */
function updatePlayerPostureWindow(brain: AiBrainState, enemy: FighterState, player: FighterState, dt: number): void {
  if (getDistancePx(enemy, player) <= brain.attackRangeMax * 1.5) {
    if (player.defenseState === "duck") brain.playerDuckWindow = (brain.playerDuckWindow ?? 0) + dt;
    else brain.playerStandWindow = (brain.playerStandWindow ?? 0) + dt;
    brain.statInRangeTime = (brain.statInRangeTime ?? 0) + dt;
  }
  const decay = Math.pow(0.5, dt / AI_POSTURE_WINDOW_SEC);
  brain.playerDuckWindow = (brain.playerDuckWindow ?? 0) * decay;
  brain.playerStandWindow = (brain.playerStandWindow ?? 0) * decay;

  const total = brain.playerDuckWindow + brain.playerStandWindow;
  // Under a second of evidence, the base is still the honest answer.
  if (total < 1.0) { brain.adaptiveBodyBias = AI_BODY_BIAS_BASE; return; }
  const duckRatio = brain.playerDuckWindow / total;
  brain.adaptiveBodyBias = clamp(
    AI_BODY_BIAS_BASE + (1 - 2 * duckRatio) * AI_BODY_BIAS_SWING,
    AI_BODY_BIAS_BASE - AI_BODY_BIAS_SWING,
    AI_BODY_BIAS_BASE + AI_BODY_BIAS_SWING,
  );
}

/** Mirrors the engine's power-zone test: weight transfer at or past its edge. */
function isInPowerSway(f: FighterState): boolean {
  if ((f.swaySpeedLevel ?? 0) <= 0) return false;
  // Stood still the sway is parked on the front foot, which reads as the edge of
  // the transfer without being one. The engine gives it nothing; neither do we.
  if (f.rhythmWalking === false) return false;
  return Math.abs(f.swayOffset ?? 0) / 5 >= AI_POWER_SWAY_NORM;
}

/**
 * Should the AI hold this punch a fraction of a beat so it lands at the edge of
 * its own weight transfer? The engine already pays 1.5x damage and halves the
 * telegraph for anyone who throws from there -- the player exploits it every
 * exchange and the AI had no concept of its own sway at all, which is a large
 * part of the gap between 14 damage a punch and 117. Nothing about the punch
 * changes; only when it leaves.
 */
// Gas awareness.
// Past its burst cap the engine charges 1.5^excess stamina per punch, so one
// unbroken assault empties the bar in about a second -- which is what the
// fight-to-win volume rise started doing. The AI now reads the same numbers the
// engine charges it, pulls out once the penalty has actually bitten, and waits
// the burst window out to the tick rather than guessing at a recovery pause.
/** Escalating punches the AI will eat before it pulls out, by band. */
const AI_GAS_TOLERATED_EXCESS: Partial<Record<DifficultyBand, number>> = {
  Hardcore: 1,
  Hard: 1,
  Medium: 2,
  Easy: 2,
};

/**
 * Live read, never latched. getBurstPunchExcess returns to zero on the exact
 * tick the burst window lapses, so offence resumes the moment the penalty stops
 * applying -- and no early return in updateAI can strand the hold on forever.
 */
function isAiGasHeld(brain: AiBrainState, enemy: FighterState): boolean {
  const tolerated = AI_GAS_TOLERATED_EXCESS[brain.difficultyBand] ?? 2;
  return getBurstPunchExcess(enemy) >= tolerated;
}

/** Recording counters for the hold. Diagnostic only; decides nothing. */
function updateGasHoldStats(brain: AiBrainState, enemy: FighterState, dt: number): void {
  const held = isAiGasHeld(brain, enemy);
  if (held) {
    if (!brain.gasHoldActive) brain.statGasPullouts = (brain.statGasPullouts ?? 0) + 1;
    brain.statGasHoldSec = (brain.statGasHoldSec ?? 0) + dt;
    // A punch the AI queued during post-punch lockout is released by the engine
    // through attemptPunch directly, which never sees attemptPunchFn or its gas
    // veto. The queue is set before the punch that gassed the fighter resolves,
    // so dropping it here is the only place the stale request can be caught.
    enemy.pendingPunchInput = null;
    enemy.pendingPunchInputTimer = 0;
  }
  brain.gasHoldActive = held;
}

// ===== RHYTHM ATTACKING =====
// A timed rhythm cut -- a clean punch landed while the opponent's sway sits in
// the vulnerable window -- is proof their timing is broken *right now*. The AI
// answers by dropping defensive play, chasing, and spending a rolled punch
// budget. Five things call it off. Cuts landed inside the sequence buy a chance
// to run it again immediately at half the length; once a whole chain of those
// is spent, all three tolerances are rolled fresh for the next one.
//
// Deliberately namespaced away from rhythmCut* on the brain (the AI's own
// cut-*attempt* timing layer, which has its own cooldown) and from the
// fighter's rhythmCutPending slow. Nothing here shares their cooldown.
const RA_BUDGET_MIN = 5;
const RA_BUDGET_MAX = 10;
const RA_PERFECT_BLOCK_TOL_MIN = 2;
const RA_PERFECT_BLOCK_TOL_MAX = 10;
const RA_AVOIDED_TOL_MIN = 4;
const RA_AVOIDED_TOL_MAX = 10;
/** Each consecutive cut landed inside a sequence buys this much chain chance. */
const RA_CHAIN_CHANCE_PER_CUT = 0.03;

function raRollInt(min: number, max: number): number {
  return min + Math.floor(rng.next01() * (max - min + 1));
}

/** Fresh tolerances for the next chain: fight start, and after a chain ends. */
function rollRhythmAttackTolerances(brain: AiBrainState): void {
  brain.raBudgetRoll = raRollInt(RA_BUDGET_MIN, RA_BUDGET_MAX);
  brain.raPerfectBlockTol = raRollInt(RA_PERFECT_BLOCK_TOL_MIN, RA_PERFECT_BLOCK_TOL_MAX);
  brain.raAvoidedTol = raRollInt(RA_AVOIDED_TOL_MIN, RA_AVOIDED_TOL_MAX);
}

/** Running *and* spending: a gas-paused sequence must not drive the fighter. */
function isRhythmAttackDriving(brain: AiBrainState): boolean {
  return brain.raActive === true && brain.raPaused !== true;
}

function startRhythmAttack(brain: AiBrainState, chained: boolean): void {
  // A chain link is half the sequence it came from, rounded up, floored at one:
  // a chain burns down (9 -> 5 -> 3 -> 2 -> 1) instead of running forever.
  const budget = chained
    ? Math.max(1, Math.ceil((brain.raSeqBudget ?? RA_BUDGET_MIN) / 2))
    : (brain.raBudgetRoll ?? RA_BUDGET_MIN);
  brain.raActive = true;
  brain.raPaused = false;
  brain.raSeqBudget = budget;
  brain.raPunchesLeft = budget;
  // Every sequence is judged on its own cuts and its own defensive damage; only
  // the budget carries across a chain link.
  brain.raPerfectBlocks = 0;
  brain.raAvoided = 0;
  brain.raCutStreak = 0;
  brain.statRaSequences = (brain.statRaSequences ?? 0) + 1;
  if (chained) brain.statRaChains = (brain.statRaChains ?? 0) + 1;
}

/**
 * The sequence ran its course (endings 1, 2 and 3). Roll the chain chance the
 * consecutive cuts bought; on a miss the whole chain is over, so the next one
 * starts from fresh tolerances and the AI needs a new cut to open it.
 */
function endRhythmAttack(brain: AiBrainState): void {
  if (!brain.raActive) return;
  const chainChance = Math.min(1, RA_CHAIN_CHANCE_PER_CUT * (brain.raCutStreak ?? 0));
  brain.raActive = false;
  brain.raPaused = false;
  brain.raPunchesLeft = 0;
  if (chainChance > 0 && rng.chance(chainChance)) {
    startRhythmAttack(brain, true);
    return;
  }
  brain.raCutStreak = 0;
  brain.raSeqBudget = 0;
  // The whole chain is spent, so a stun may open the next one.
  brain.raStunTriggerUsed = false;
  rollRhythmAttackTolerances(brain);
}

/**
 * Hard stop with no chain roll, for the two endings where carrying on makes no
 * sense: a knockdown (ending 4) and gassing out against a fresher opponent
 * (ending 5). Also the bell and every updateAI early return, so a sequence can
 * never survive into a round it did not start in.
 */
function cancelRhythmAttack(brain: AiBrainState): void {
  if (!brain) return;
  const wasActive = brain.raActive === true;
  brain.raActive = false;
  brain.raPaused = false;
  brain.raPunchesLeft = 0;
  brain.raPerfectBlocks = 0;
  brain.raAvoided = 0;
  brain.raCutStreak = 0;
  brain.raSeqBudget = 0;
  brain.raStunTriggerUsed = false;
  if (wasActive) rollRhythmAttackTolerances(brain);
}

/**
 * Ending 5, plus the pause that precedes it. Read live off the engine's own
 * burst counter rather than latched into a timer, exactly like isAiGasHeld: the
 * pause lifts on the tick the penalty stops applying, so no early return can
 * strand a sequence paused forever. Note this bites earlier than the gas veto --
 * any excess at all pauses, where the veto tolerates one or two by band.
 */
function updateRhythmAttackGas(brain: AiBrainState, enemy: FighterState, player: FighterState): void {
  if (!brain.raActive) return;
  if (getBurstPunchExcess(enemy) <= 0) {
    brain.raPaused = false;
    return;
  }
  brain.raPaused = true;
  // A punch queued during post-punch lockout is released by the engine through
  // attemptPunch directly, so no veto or pause on this side can stop it once it
  // is in the buffer. Dropping it here is what makes the pause real -- the gas
  // hold's own clear sits behind a higher, band-dependent threshold and would
  // let a buffered shot through at the first penalty tier.
  enemy.pendingPunchInput = null;
  enemy.pendingPunchInputTimer = 0;
  // Gassed is survivable while still the fresher man. Gassed *and* behind on the
  // tank is the point where pressing on just hands the round over.
  if (getPlayerStaminaFrac(player) > getMyStaminaFrac(enemy)) cancelRhythmAttack(brain);
}

/**
 * The AI landed a timed rhythm cut. Cold, this opens a sequence; inside one it
 * extends the consecutive-cut streak that buys the end-of-sequence chain roll.
 */
export function notifyAiRhythmCutLanded(brain: AiBrainState): void {
  if (!brain) return;
  if (brain.raActive) {
    brain.raCutStreak = (brain.raCutStreak ?? 0) + 1;
    return;
  }
  startRhythmAttack(brain, false);
}

/** A clean landing that was *not* a cut breaks the consecutive-cut streak. */
export function notifyAiCleanHitNotRhythmCut(brain: AiBrainState): void {
  if (!brain || !brain.raActive) return;
  brain.raCutStreak = 0;
}

/** Ending 1: the player perfect-blocked. Ordinary blocks do not count. */
export function notifyAiPunchPerfectBlocked(brain: AiBrainState): void {
  if (!brain || !brain.raActive) return;
  brain.raPerfectBlocks = (brain.raPerfectBlocks ?? 0) + 1;
  if (brain.raPerfectBlocks >= (brain.raPerfectBlockTol ?? RA_PERFECT_BLOCK_TOL_MAX)) endRhythmAttack(brain);
}

/** Ending 2: a punch that failed to land -- slipped, ducked or plain missed. */
export function notifyAiPunchAvoided(brain: AiBrainState): void {
  if (!brain || !brain.raActive) return;
  brain.raAvoided = (brain.raAvoided ?? 0) + 1;
  if (brain.raAvoided >= (brain.raAvoidedTol ?? RA_AVOIDED_TOL_MAX)) endRhythmAttack(brain);
}

/**
 * Ending 3, and the only place the budget is spent. Called once per non-feint
 * punch the engine *accepted*, from every site that can accept one: the AI's own
 * throw wrapper, and the engine's buffered-input release. That second caller is
 * not optional -- a punch queued during telegraph lockout fires a few frames
 * later without ever passing back through the AI, so accounting only in the
 * wrapper lets a sequence throw more punches than it was ever given.
 */
export function notifyAiPunchThrown(brain: AiBrainState | null | undefined): void {
  if (!brain || !isRhythmAttackDriving(brain)) return;
  brain.raPunchesLeft = (brain.raPunchesLeft ?? 0) - 1;
  if (brain.raPunchesLeft <= 0) endRhythmAttack(brain);
}

/**
 * Second trigger: a landed stun opens a sequence exactly like a timed cut does.
 *
 * Unlike a cut, a stun gets one use per chain. Once it has opened one, no stun
 * can open another until that whole chain has run out -- and a stun landed
 * *inside* a sequence does nothing at all, not even extend the cut streak.
 * Without that, a stun-heavy AI would re-trigger off its own follow-up stuns and
 * hold the player in a single unbroken assault for the rest of the round; the
 * next stun has to come outside a chain to count.
 */
export function notifyAiStunLanded(brain: AiBrainState | null | undefined): void {
  if (!brain) return;
  if (brain.raActive) return;
  if (brain.raStunTriggerUsed) return;
  brain.raStunTriggerUsed = true;
  startRhythmAttack(brain, false);
}

function shouldWaitForPowerSway(brain: AiBrainState, enemy: FighterState, dt: number): boolean {
  if ((brain.powerSwayWaitTimer ?? 0) > 0) {
    brain.powerSwayWaitTimer = Math.max(0, (brain.powerSwayWaitTimer ?? 0) - dt);
    // Peaked, or waited long enough. Either way the shot goes now.
    if (isInPowerSway(enemy)) { brain.powerSwayWaitTimer = 0; return false; }
    return brain.powerSwayWaitTimer > 0;
  }
  if ((brain.powerSwayRollCooldown ?? 0) > 0) {
    brain.powerSwayRollCooldown = Math.max(0, (brain.powerSwayRollCooldown ?? 0) - dt);
    return false;
  }
  if (isInPowerSway(enemy)) return false;            // already there, nothing to wait for
  if ((enemy.swaySpeedLevel ?? 0) <= 0 || enemy.swayFrozen) return false;

  // Rolled once per cooldown rather than per tick: a held decision checked at
  // 60Hz saturates to a certainty, which is not a decision at all.
  brain.powerSwayRollCooldown = AI_POWER_SWAY_ROLL_CD;
  if (!rng.chance(AI_POWER_SWAY_HUNT[brain.difficultyBand] ?? 0)) return false;

  // Only worth waiting when the sway is already travelling toward the edge and
  // most of the way there. Anything else is a long pause for a small bonus.
  const norm = Math.abs(enemy.swayOffset ?? 0) / 5;
  const closingOnEdge = (enemy.swayDir ?? 0) * (enemy.swayOffset ?? 0) >= 0;
  if (!closingOnEdge || norm < AI_POWER_SWAY_MIN_PROGRESS) return false;

  brain.powerSwayWaitTimer = AI_POWER_SWAY_MAX_WAIT;
  return true;
}

/** Book-keeping for a punch the engine accepted: rhythm learning + recording. */
/**
 * Rolling five-interval read of the opponent's punching: when the next shot is
 * due, how long its windup runs, and the separation their punches land from.
 * Every decision the defensive timing layer makes is built off this.
 */
function trackPlayerPunchWindow(brain: AiBrainState, enemy: FighterState, player: FighterState): void {
  brain.lastKnownDistPx = getDistancePx(enemy, player);

  // The jab's windup is observable, so the AI reads it off the player rather
  // than being handed it. This is the flight time a block has to beat.
  if (
    player.telegraphPhase !== "none" &&
    player.telegraphPunchType === "jab" &&
    !player.telegraphIsFeint &&
    player.telegraphDuration > 0
  ) {
    const prev = brain.playerJabFlightSec ?? 0;
    brain.playerJabFlightSec = prev > 0
      ? prev * 0.8 + player.telegraphDuration * 0.2
      : player.telegraphDuration;
  }

  const telegraphing =
    player.telegraphPhase !== "none" &&
    player.telegraphPunchType !== null &&
    !player.telegraphIsLockout;
  const punching = player.isPunching || telegraphing;
  const started = punching && !brain.pbSyncPrevPunching;
  brain.pbSyncPrevPunching = punching;
  if (!started) return;

  const times = brain.playerPunchTimes ?? (brain.playerPunchTimes = []);
  times.push(brain.gameTime);
  while (times.length > PLAYER_PUNCH_WINDOW) times.shift();

  // The mean of the gaps, not of the timestamps. Gaps that are really pauses
  // between exchanges are dropped rather than allowed to stretch the read.
  let sum = 0;
  let n = 0;
  for (let i = 1; i < times.length; i++) {
    const gap = times[i] - times[i - 1];
    if (gap >= BLOCK_SYNC_MIN_INTERVAL && gap <= BLOCK_SYNC_MAX_INTERVAL) {
      sum += gap;
      n++;
    }
  }
  brain.playerPunchIntervalCount = n;
  brain.playerPunchIntervalAvg = n > 0 ? sum / n : 0;
}

/**
 * Seconds until the opponent's next punch is expected to make contact, or -1
 * when there is no rhythm to read. Raw: the learned correction is added by the
 * caller so the error measurement keeps grading the uncorrected predictor,
 * exactly as the rhythm-cut sync grades its own raw miss distance.
 */
function predictPlayerImpactIn(brain: AiBrainState): number {
  const times = brain.playerPunchTimes;
  if (!times || times.length === 0) return -1;
  if ((brain.playerPunchIntervalCount ?? 0) < BLOCK_SYNC_MIN_INTERVALS) return -1;
  const gap = brain.playerPunchIntervalAvg ?? 0;
  if (gap <= 0) return -1;
  const since = brain.gameTime - times[times.length - 1];
  // They have stopped. There is no beat left to catch.
  if (since > gap * 3) return -1;
  let due = gap - since;
  if (due < 0) due = Math.max(0, due + gap);
  return due + (brain.playerJabFlightSec ?? BLOCK_SYNC_DEFAULT_FLIGHT);
}

/** Learned timing correction in seconds, clamped. Positive = predict later. */
function blockSyncCorrSec(brain: AiBrainState): number {
  return clamp((brain.pbTimingLearntMs ?? 0) / 1000, -BLOCK_SYNC_CORR_MAX_SEC, BLOCK_SYNC_CORR_MAX_SEC);
}

/**
 * One commit roll per predicted punch, not one per tick. A per-frame chance
 * saturates to a certainty inside the window and pins the AI behind its gloves.
 */
function rollBlockSyncCommit(brain: AiBrainState): boolean {
  const times = brain.playerPunchTimes;
  const key = times && times.length > 0 ? times[times.length - 1] : -1;
  if (brain.pbSyncRolledFor === key) return brain.pbSyncRollPassed === true;
  brain.pbSyncRolledFor = key;
  brain.pbSyncRollPassed = rng.chance(BLOCK_SYNC_CHANCE[brain.difficultyBand] ?? 0);
  return brain.pbSyncRollPassed;
}

/**
 * "Ready" pauses a string's beat: a punch is close enough to be worth waiting
 * on. "Arm now" is the frame the block actually goes up.
 */
function computeBlockSync(
  brain: AiBrainState,
  enemy: FighterState,
  player: FighterState,
): { ready: boolean; armNow: boolean } {
  const off = { ready: false, armNow: false };
  if ((BLOCK_SYNC_CHANCE[brain.difficultyBand] ?? 0) <= 0) return off;
  if (brain.gameTime < (brain.pbSyncCooldownUntil ?? 0)) return off;
  if (brain.perfectReactActive || brain.anticipationArmed) return off;
  if (enemy.stunBlockDisableTimer > 0 || enemy.isKnockedDown) return off;

  // Judged against the range their punches actually land from, not the AI's own
  // reach and not wherever they happen to be standing this frame.
  const landRange = brain.playerLandRangeAvg ?? 0;
  if (landRange <= 0) return off;
  if (getDistancePx(enemy, player) > landRange + BLOCK_SYNC_RANGE_SLOP_PX) return off;

  const raw = predictPlayerImpactIn(brain);
  if (raw < 0) return off;
  const impactIn = raw + blockSyncCorrSec(brain);
  if (impactIn > BLOCK_SYNC_MAX_WAIT) return off;
  return {
    ready: true,
    armNow: impactIn <= BLOCK_SYNC_LEAD_SEC && rollBlockSyncCommit(brain),
  };
}

/**
 * Commits the predicted block and records what it was aimed at, so the outcome
 * can be graded and the next one moved.
 */
function armBlockSync(brain: AiBrainState, enemy: FighterState, player: FighterState, fromString: boolean): void {
  const raw = predictPlayerImpactIn(brain);
  brain.pbSyncActive = true;
  brain.pbSyncFromString = fromString;
  brain.pbSyncPendingResolve = 0;
  brain.pbSyncPredictedImpact = brain.gameTime + Math.max(0, raw);
  brain.pbSyncExpiresAt = brain.pbSyncPredictedImpact + BLOCK_SYNC_GRACE_SEC;
  brain.pbSyncCooldownUntil = brain.gameTime + BLOCK_SYNC_COOLDOWN;
  brain.statBlockSyncArmed = (brain.statBlockSyncArmed ?? 0) + 1;
  armAiPerfectBlock(brain, enemy, player);
}

/**
 * Notes that the punch the prediction was aimed at has arrived. The outcome is
 * only settled at the end of the tick: a blocked punch fires the hit notifier
 * and then the guard notifier, so grading on the first one in would book every
 * successful timed block as a miss.
 */
function markBlockSyncResolve(brain: AiBrainState, blocked: boolean): void {
  if (!brain.pbSyncActive) return;
  if (!brain.pbSyncPendingResolve) brain.pbSyncPendingAt = brain.gameTime;
  brain.pbSyncPendingResolve = blocked ? 2 : (brain.pbSyncPendingResolve === 2 ? 2 : 1);
}

/** Drops a live prediction without training on it. */
function clearBlockSyncPrediction(brain: AiBrainState): void {
  brain.pbSyncActive = false;
  brain.pbSyncFromString = false;
  brain.pbSyncPendingResolve = 0;
}

/**
 * Settles whatever happened to the prediction this tick, and writes off one
 * whose punch never came. Positive error means the punch arrived later than
 * predicted, so the block went up early and the next one is pushed back.
 */
function flushBlockSyncResolve(brain: AiBrainState): void {
  if (!brain.pbSyncActive) return;
  const pending = brain.pbSyncPendingResolve ?? 0;
  if (pending === 0) {
    if (brain.gameTime > (brain.pbSyncExpiresAt ?? 0)) clearBlockSyncPrediction(brain);
    return;
  }
  const at = brain.pbSyncPendingAt ?? brain.gameTime;
  clearBlockSyncPrediction(brain);
  if (pending === 2) brain.statBlockSyncLanded = (brain.statBlockSyncLanded ?? 0) + 1;
  // Same stun lockout the rhythm-cut sync respects: a rocked AI stops re-tuning
  // its timings for the rest of the round.
  if (brain.timingAdjustLocked) return;
  const errMs = (at - (brain.pbSyncPredictedImpact ?? at)) * 1000;
  brain.pbSyncMissOffsetMs = errMs;
  brain.pbTimingLearntMs = (brain.pbTimingLearntMs ?? 0) * (1 - BLOCK_SYNC_EMA) + errMs * BLOCK_SYNC_EMA;
}

function recordAiThrow(brain: AiBrainState, enemy: FighterState, body: boolean): void {
  const lvl = clamp(Math.round(enemy.swaySpeedLevel ?? 0), 0, 5);
  brain.lastThrowSwayLevel = lvl;
  brain.lastThrowInPowerSway = isInPowerSway(enemy);
  const throws = brain.swayLevelThrows ?? (brain.swayLevelThrows = {});
  throws[lvl] = (throws[lvl] ?? 0) + 1;
  brain.statPunchesThrown = (brain.statPunchesThrown ?? 0) + 1;
  if (body) brain.statBodyPunchesThrown = (brain.statBodyPunchesThrown ?? 0) + 1;
  if (brain.lastThrowInPowerSway) brain.statPowerSwayThrows = (brain.statPowerSwayThrows ?? 0) + 1;
}

/**
 * Which of its own sway speeds the AI has actually been scoring from. A level
 * needs a real sample before it can be named, otherwise the first landed punch
 * of the fight would pin the rhythm for the rest of it.
 */
function bestSwayLevel(brain: AiBrainState): number {
  const throws = brain.swayLevelThrows;
  if (!throws) return 0;
  const landed = brain.swayLevelLanded;
  let bestLvl = 0;
  let bestRate = -1;
  for (let lvl = 1; lvl <= 5; lvl++) {
    const t = throws[lvl] ?? 0;
    if (t < 4) continue;
    const rate = (landed?.[lvl] ?? 0) / t;
    if (rate > bestRate) { bestRate = rate; bestLvl = lvl; }
  }
  return bestLvl;
}

function trackPlayerSustainedDuck(brain: AiBrainState, enemy: FighterState, player: FighterState, dt: number): void {
  const dist = getDistancePx(enemy, player);
  const playerDucked = player.defenseState === "duck";
  const inRange = dist < brain.attackRangeMax * 1.5;
  if (playerDucked && inRange) {
    brain.playerSustainedDuckTimer += dt;
  } else {
    brain.playerSustainedDuckTimer = Math.max(0, brain.playerSustainedDuckTimer - dt * 3);
  }

  brain.playerDuckPunchDecay += dt;
  if (brain.playerDuckPunchDecay >= 3.0) {
    brain.playerDuckPunchCount = Math.max(0, brain.playerDuckPunchCount - 1);
    brain.playerDuckPunchDecay = 0;
  }

  if (brain.lastPunchDodgedTimer > 0) {
    brain.lastPunchDodgedTimer -= dt;
    if (brain.lastPunchDodgedTimer < 0) brain.lastPunchDodgedTimer = 0;
  }
}

function trackPlayerDefenseSwitch(brain: AiBrainState, player: FighterState): void {
  const curDef = player.defenseState;
  if (curDef !== brain.playerPrevDefenseState) {
    if (brain.playerPrevDefenseState === "fullGuard" && curDef === "duck") {
      brain.playerLastDefenseSwitch = brain.gameTime;
    }
    brain.playerPrevDefenseState = curDef;
  }
}

function trackPlayerApproach(brain: AiBrainState, enemy: FighterState, player: FighterState): void {
  const dist = getDistancePx(enemy, player);
  brain.playerApproaching = dist < brain.attackRangeMax * 1.5 && dist > brain.attackRangeMin;
}

// ===== RING CUTOFF (Champion AI) =====

function getPlayerRopeProximity(player: FighterState, ringLeft: number, ringRight: number, ringTop: number, ringBottom: number): number {
  const cx = (ringLeft + ringRight) / 2;
  const cy = (ringTop + ringBottom) / 2;
  const hw = (ringRight - ringLeft) / 2;
  const hh = (ringBottom - ringTop) / 2;
  const dx = Math.abs(player.x - cx) / hw;
  const dz = Math.abs(player.z - cy) / hh;
  return dx + dz;
}

function tryRingCutoff(brain: AiBrainState, enemy: FighterState, player: FighterState, state: GameState): boolean {
  if (brain.playerCornerCamping || brain.playerIdleTime > 1.5) return false;

  const rl = state.ringLeft;
  const rr = state.ringRight;
  const rt = state.ringTop;
  const rb = state.ringBottom;
  const cx = (rl + rr) / 2;
  const cy = (rt + rb) / 2;

  const playerRopeProx = getPlayerRopeProximity(player, rl, rr, rt, rb);
  const adaptRingCut = getSlotValue(brain.adaptiveMemory, "ringCutoffUrgency");
  const threshold = (brain.difficultyBand === "Hardcore" ? 0.58 : 0.66) - adaptRingCut * 0.15 - brain.offense.ringCutting * brain.execIntensity * 0.08;
  if (playerRopeProx < threshold) return false;

  const aiRopeProx = getPlayerRopeProximity(enemy, rl, rr, rt, rb);
  if (aiRopeProx > 0.75) return false;

  const dist = getDistancePx(enemy, player);
  if (dist > brain.attackRangeMax * 3) return false;

  const xDiff = player.x - enemy.x;
  const zDiffFromCenter = enemy.z - cy;
  let moveX = 0;
  let moveZ = 0;

  if (Math.abs(zDiffFromCenter) > 8) {
    moveZ = zDiffFromCenter > 0 ? -0.25 : 0.25;
  }

  if (dist < brain.attackRangeMin) {
    moveX = xDiff > 0 ? -0.25 : 0.25;
  } else if (dist > brain.attackRangeMax * 1.3) {
    const advance = brain.difficultyBand === "Hardcore" ? 0.65 : 0.5;
    moveX = xDiff > 0 ? advance : -advance;
  } else {
    moveX = xDiff > 0 ? 0.12 : -0.12;
  }

  brain.desiredMoveInput = clamp(moveX, -1, 1);
  brain.desiredMoveZ = clamp(moveZ, -1, 1);

  return true;
}

// ===== MOVEMENT =====

function updateLateralDir(brain: AiBrainState, dt: number): void {
  brain.lateralSwitchTimer += dt;
  let switchInterval: number;
  switch (brain.difficultyBand) {
    case "Hardcore": switchInterval = lerp(2.0, 3.0, rng.next01()); break;
    case "Hard": switchInterval = lerp(1.5, 2.5, rng.next01()); break;
    case "Medium": switchInterval = lerp(1.0, 2.0, rng.next01()); break;
    default: switchInterval = lerp(0.6, 1.5, rng.next01()); break;
  }
  if (brain.survivalModeActive) switchInterval *= 0.5;
  if (brain.lateralSwitchTimer >= switchInterval) {
    brain.lateralSwitchTimer = 0;
    brain.lateralDir = (brain.lateralDir === 1 ? -1 : 1) as 1 | -1;
  }
}

function tryRopeEscape(brain: AiBrainState, enemy: FighterState, player: FighterState, state: GameState): boolean {
  if (brain.playerCornerCamping || brain.playerIdleTime > 1.5) return false;

  const rl = state.ringLeft;
  const rr = state.ringRight;
  const rt = state.ringTop;
  const rb = state.ringBottom;
  const cx = (rl + rr) / 2;
  const cy = (rt + rb) / 2;

  const aiRopeProx = getPlayerRopeProximity(enemy, rl, rr, rt, rb);
  let threshold: number;
  switch (brain.difficultyBand) {
    case "Hardcore": threshold = 0.68; break;
    case "Hard": threshold = 0.74; break;
    case "Medium": threshold = 0.80; break;
    default: threshold = 0.86; break;
  }
  if (brain.survivalModeActive) threshold -= 0.15;
  if (aiRopeProx < threshold) return false;

  const toCenterX = cx - enemy.x;
  const toCenterZ = cy - enemy.z;
  const len = Math.sqrt(toCenterX * toCenterX + toCenterZ * toCenterZ);
  if (len < 1) return false;

  const normX = toCenterX / len;
  const normZ = toCenterZ / len;
  const perpX = -normZ;
  const perpZ = normX;

  let lateralStr: number;
  switch (brain.difficultyBand) {
    case "Hardcore": lateralStr = 0.55; break;
    case "Hard": lateralStr = 0.40; break;
    case "Medium": lateralStr = 0.28; break;
    default: lateralStr = 0.15; break;
  }
  if (brain.survivalModeActive) lateralStr += 0.15;
  const centerWeight = brain.difficultyBand === "Easy" ? 0.50 : (brain.survivalModeActive ? 0.85 : 0.70);
  brain.desiredMoveInput = clamp(normX * centerWeight + perpX * brain.lateralDir * lateralStr, -1, 1);
  brain.desiredMoveZ = clamp(normZ * centerWeight + perpZ * brain.lateralDir * lateralStr, -1, 1);
  return true;
}

function thinkMovement(brain: AiBrainState, enemy: FighterState, player: FighterState, state?: GameState): void {
  if (brain.perfectReactActive && Math.abs(brain.stepOutDesiredMove) > 0.01) return;

  const gdx = player.x - enemy.x;
  const gdz = player.z - enemy.z;
  const dist = Math.sqrt(gdx * gdx + gdz * gdz);
  const dirX = dist > 0.01 ? gdx / dist : 1;
  const dirZ = dist > 0.01 ? gdz / dist : 0;
  const perpX = -dirZ;
  const perpZ = dirX;

  const band = brain.difficultyBand;
  const isChampTier = band === "Hardcore" || band === "Hard";
  const lateralBias = brain.lateralDir;
  let lateralStrength = 0;

  if (brain.hitReactRetreatTimer > 0) {
    let retreatLateral: number;
    switch (band) {
      case "Hardcore": retreatLateral = 0.65; break;
      case "Hard": retreatLateral = 0.50; break;
      case "Medium": retreatLateral = 0.35; break;
      default: retreatLateral = 0.20; break;
    }
    // Taking one while throwing is not a reason to leave: the flinch turns into
    // a pivot, keeping the separation the rest of the string needs.
    const retreatRadial = isAiStringAssault(brain) ? 0 : (band === "Easy" ? 0.50 : 0.70);
    brain.desiredMoveInput = clamp(-dirX * retreatRadial + perpX * brain.hitReactLateralDir * retreatLateral, -1, 1);
    brain.desiredMoveZ = clamp(-dirZ * retreatRadial + perpZ * brain.hitReactLateralDir * retreatLateral, -1, 1);
    return;
  }

  if (brain.survivalModeActive) {
    if (state && tryRopeEscape(brain, enemy, player, state)) return;

    const ideal = getIdealRangeForPhase(brain);
    const retreatUrgency = dist < ideal ? 1.0 : dist < ideal * 1.3 ? 0.4 : 0;
    if (retreatUrgency > 0) {
      brain.desiredMoveInput = clamp(-dirX * retreatUrgency, -1, 1);
      brain.desiredMoveZ = clamp(-dirZ * retreatUrgency, -1, 1);
    } else {
      brain.desiredMoveInput = 0;
      brain.desiredMoveZ = 0;
    }
    switch (band) {
      case "Hardcore": lateralStrength = 0.75; break;
      case "Hard": lateralStrength = 0.65; break;
      case "Medium": lateralStrength = 0.50; break;
      default: lateralStrength = 0.35; break;
    }
    brain.desiredMoveInput += perpX * lateralBias * lateralStrength;
    brain.desiredMoveZ += perpZ * lateralBias * lateralStrength;
    return;
  }

  const adaptLateral = getSlotValue(brain.adaptiveMemory, "lateralVsLinear");
  const adaptRopePressure = getSlotValue(brain.adaptiveMemory, "ropePressureDuration");
  const adaptStamConserve = getSlotValue(brain.adaptiveMemory, "staminaConservation");
  const adaptAntiCorner = getSlotValue(brain.adaptiveMemory, "antiCornerPressure");

  if (state) {
    if (tryRopeEscape(brain, enemy, player, state)) return;
    const ringCutAdapt = getSlotValue(brain.adaptiveMemory, "ringCutoffUrgency");
    if (isChampTier || ringCutAdapt > 0.1) {
      const cutoff = tryRingCutoff(brain, enemy, player, state);
      if (cutoff) return;
    }
  }

  if (dist <= Math.max(blocksToPixels(0.10), OVERLAP_HARD_MIN_DIST_PX)) {
    let escapeLateral: number;
    switch (band) {
      case "Hardcore": escapeLateral = 0.45; break;
      case "Hard": escapeLateral = 0.35; break;
      case "Medium": escapeLateral = 0.20; break;
      default: escapeLateral = 0.10; break;
    }
    brain.desiredMoveInput = clamp(-dirX + perpX * lateralBias * escapeLateral, -1, 1);
    brain.desiredMoveZ = clamp(-dirZ + perpZ * lateralBias * escapeLateral, -1, 1);
    return;
  }

  if (dist < brain.attackRangeMin) {
    let escapeLateral: number;
    switch (band) {
      case "Hardcore": escapeLateral = 0.40; break;
      case "Hard": escapeLateral = 0.30; break;
      case "Medium": escapeLateral = 0.18; break;
      default: escapeLateral = 0.08; break;
    }
    brain.desiredMoveInput = clamp(-dirX + perpX * lateralBias * escapeLateral, -1, 1);
    brain.desiredMoveZ = clamp(-dirZ + perpZ * lateralBias * escapeLateral, -1, 1);
    return;
  }

  if ((brain.playerIdleTime > 0.5 || brain.playerCornerCamping) && dist > brain.attackRangeMin) {
    const approachUrgency = brain.playerCornerCamping ? 1.0 : Math.min((brain.playerIdleTime - 0.5) / 1.0, 1.0);
    const radial = lerp(0.5, 1.0, approachUrgency);
    brain.desiredMoveInput = clamp(dirX * radial, -1, 1);
    brain.desiredMoveZ = clamp(dirZ * radial, -1, 1);
    return;
  }

  const patience = brain.stylePatience;
  const useEngageCycle = patience > 0.25 && brain.currentPhase !== "Panic" && brain.currentPhase !== "Finish";

  if (useEngageCycle) {
    const resetDist = brain.styleIdealResetDist;
    const engageDist = brain.styleIdealEngageDist;
    let moveRadial = 0;

    if (brain.engageCyclePhase === "out") {
      if (dist < resetDist - 10) {
        moveRadial = -1;
      } else if (dist > resetDist + 15) {
        moveRadial = rng.chance(0.3) ? 1 : 0;
      } else {
        moveRadial = rng.chance(0.15) ? (rng.chance(0.5) ? 1 : -1) : 0;
      }
      switch (band) {
        case "Hardcore": lateralStrength = lerp(0.40, 0.60, brain.styleLateralApproach); break;
        case "Hard": lateralStrength = lerp(0.35, 0.55, brain.styleLateralApproach); break;
        case "Medium": lateralStrength = lerp(0.28, 0.48, brain.styleLateralApproach); break;
        default: lateralStrength = lerp(0.20, 0.38, brain.styleLateralApproach); break;
      }
      lateralStrength = clamp01(lateralStrength + adaptLateral * 0.15);
    } else {
      if (dist > engageDist + 15) {
        moveRadial = 1;
      } else if (dist < engageDist - 5) {
        moveRadial = rng.chance(0.25) ? -1 : 0;
      } else {
        moveRadial = rng.chance(0.20) ? 1 : 0;
      }
      switch (band) {
        case "Hardcore": lateralStrength = lerp(0.30, 0.50, brain.styleLateralApproach); break;
        case "Hard": lateralStrength = lerp(0.25, 0.45, brain.styleLateralApproach); break;
        case "Medium": lateralStrength = lerp(0.18, 0.38, brain.styleLateralApproach); break;
        default: lateralStrength = lerp(0.12, 0.30, brain.styleLateralApproach); break;
      }
      lateralStrength = clamp01(lateralStrength + adaptLateral * 0.15);
    }

    const disengageAdapt = getSlotValue(brain.adaptiveMemory, "disengageAfterCombo");
    if (disengageAdapt > 0.05 && brain.engageCyclePhase === "in" && brain.engageCycleTimer > 1.5) {
      if (rng.chance(disengageAdapt * 0.3 - adaptStamConserve * 0.1)) {
        moveRadial = -1;
      }
    }
    const staminaAdjust = adaptStamConserve > 0.05 ? adaptStamConserve * 0.2 : 0;
    brain.desiredMoveInput = clamp(dirX * moveRadial + perpX * lateralBias * (lateralStrength + staminaAdjust), -1, 1);
    brain.desiredMoveZ = clamp(dirZ * moveRadial + perpZ * lateralBias * (lateralStrength + staminaAdjust), -1, 1);
    return;
  }

  const ideal = getIdealRangeForPhase(brain);
  const width = brain.currentPhase === "Counter" ? brain.counterRangeWidth : brain.rangeWidth;
  const min = Math.max(blocksToPixels(0.2), ideal - width * 0.5);
  const max = ideal + width * 0.5;

  let moveRadial = 0;

  if (brain.currentPhase === "Counter") {
    if (dist < min - blocksToPixels(0.05)) moveRadial = -1;
    else if (dist <= max + blocksToPixels(0.05)) {
      if (rng.next01() < 0.22) moveRadial = -1;
      else moveRadial = 0;
    } else {
      const bias = getScoreAggressionBias(brain);
      if (bias > 0.10 && dist > max + blocksToPixels(0.10)) moveRadial = 1;
      else moveRadial = 0;
    }
    switch (band) {
      case "Hardcore": lateralStrength = 0.55; break;
      case "Hard": lateralStrength = 0.45; break;
      case "Medium": lateralStrength = 0.35; break;
      default: lateralStrength = 0.25; break;
    }
    brain.desiredMoveInput = clamp(dirX * moveRadial + perpX * lateralBias * lateralStrength, -1, 1);
    brain.desiredMoveZ = clamp(dirZ * moveRadial + perpZ * lateralBias * lateralStrength, -1, 1);
    return;
  }

  switch (brain.currentState) {
    case "Approach": moveRadial = 1; break;
    case "Retreat": moveRadial = -1; break;
    case "Panic":
      if (dist < ideal) moveRadial = -1;
      else moveRadial = 0;
      break;
    default: {
      if (dist > max + blocksToPixels(0.05)) moveRadial = 1;
      else if (dist < min - blocksToPixels(0.05)) moveRadial = -1;
      else {
        const bias = getScoreAggressionBias(brain);
        const ahead = clamp01(-bias);
        const behind = clamp01(bias);
        const clean = brain.personality.cleanHitsOverVolume;
        let towardP = 0.12 + behind * 0.15 - ahead * 0.06;
        let awayP = 0.12 + ahead * 0.12 - behind * 0.05;
        towardP = clamp01(Math.max(0, towardP - clean * 0.06));
        awayP = clamp01(awayP + clean * 0.06);
        const r = rng.next01();
        if (r < towardP) moveRadial = 1;
        else if (r < towardP + awayP) moveRadial = -1;
        else moveRadial = 0;
      }
      break;
    }
  }

  if (brain.currentState === "Retreat" || brain.currentState === "Panic") {
    switch (band) {
      case "Hardcore": lateralStrength = 0.55; break;
      case "Hard": lateralStrength = 0.42; break;
      case "Medium": lateralStrength = 0.30; break;
      default: lateralStrength = 0.20; break;
    }
  } else if (brain.currentState === "Approach") {
    switch (band) {
      case "Hardcore": lateralStrength = 0.30; break;
      case "Hard": lateralStrength = 0.25; break;
      case "Medium": lateralStrength = 0.18; break;
      default: lateralStrength = 0.12; break;
    }
  } else {
    switch (band) {
      case "Hardcore": lateralStrength = 0.45; break;
      case "Hard": lateralStrength = 0.38; break;
      case "Medium": lateralStrength = 0.30; break;
      default: lateralStrength = 0.22; break;
    }
  }

  brain.desiredMoveInput = clamp(dirX * moveRadial + perpX * lateralBias * lateralStrength, -1, 1);
  brain.desiredMoveZ = clamp(dirZ * moveRadial + perpZ * lateralBias * lateralStrength, -1, 1);
}

function clampToDiamondAI(fighter: { x: number; z: number }, ringLeft: number, ringRight: number, ringTop: number, ringBottom: number, margin: number = 20): void {
  const cx = (ringLeft + ringRight) / 2;
  const cy = (ringTop + ringBottom) / 2;
  const hw = (ringRight - ringLeft) / 2 - margin;
  const hh = (ringBottom - ringTop) / 2 - margin;
  const dx = (fighter.x - cx) / hw;
  const dz = (fighter.z - cy) / hh;
  const dist = Math.abs(dx) + Math.abs(dz);
  if (dist > 1) {
    fighter.x = cx + (dx / dist) * hw;
    fighter.z = cy + (dz / dist) * hh;
  }
}

function applyMovement(brain: AiBrainState, enemy: FighterState, player: FighterState, dt: number, ringLeft: number, ringRight: number, ringTop: number, ringBottom: number, state: GameState): void {
  let moveX = brain.desiredMoveInput;
  let moveZ = brain.desiredMoveZ;
  if (enemy.stamina <= 0) { moveX = 0; moveZ = 0; }

  if (brain.perfectReactActive && Math.abs(brain.stepOutDesiredMove) > 0.01) {
    const dist = getDistancePx(enemy, player);
    if (dist >= STEP_OUT_TARGET_DISTANCE_PX) {
      brain.stepOutDesiredMove = 0;
    } else {
      const dx = enemy.x - player.x;
      const dz = enemy.z - player.z;
      const len = Math.sqrt(dx * dx + dz * dz);
      if (len > 0.01) {
        moveX = clamp((dx / len) * Math.abs(brain.stepOutDesiredMove), -1, 1);
        moveZ = clamp((dz / len) * Math.abs(brain.stepOutDesiredMove), -1, 1);
      }
    }
  }

  // Base defense reaction, step-out half. It owns the feet for the two short
  // legs it lasts and leaves everything else alone, which is what lets it
  // interject a planned move without ending whatever produced it.
  if ((brain.baseDefStepPhase ?? 0) > 0) {
    brain.baseDefStepTimer = (brain.baseDefStepTimer ?? 0) - dt;
    if (brain.baseDefStepTimer <= 0) {
      // Out of time. Whatever the step already took still has to be handed back,
      // so a first leg that stalls against the ropes turns into the return
      // instead of stranding the AI further out than its own plan put it.
      if (brain.baseDefStepPhase === 1) startAiBaseDefenseReturn(brain);
      else cancelAiBaseDefenseStep(brain);
    }
  }
  if ((brain.baseDefStepPhase ?? 0) > 0) {
    if (enemy.slipActive || enemy.stunMoveFreezeTimer > 0) {
      cancelAiBaseDefenseStep(brain);
    } else if (brain.baseDefStepPhase === 1) {
      const bdx = enemy.x - player.x;
      const bdz = enemy.z - player.z;
      const bdLen = Math.sqrt(bdx * bdx + bdz * bdz);
      if (bdLen <= 0.01) cancelAiBaseDefenseStep(brain);
      else {
        // Straight back unless a turn was asked for. Only the escape from an
        // armed charge sets one, and never past a quarter, so the step always
        // leaves the opponent behind it. The return leg needs no equivalent:
        // it repays the displacement it recorded, whichever way that went.
        const turn = brain.baseDefStepTurn ?? 0;
        const ux = bdx / bdLen;
        const uz = bdz / bdLen;
        if (turn === 0) { moveX = ux; moveZ = uz; }
        else {
          const c = Math.cos(turn);
          const s = Math.sin(turn);
          moveX = ux * c - uz * s;
          moveZ = ux * s + uz * c;
        }
      }
    } else {
      // The return walks back down the ground the step covered rather than at the
      // opponent, who has moved since: repaying the displacement is what puts the
      // AI back where its own footwork had left it.
      const outX = brain.baseDefStepOutX ?? 0;
      const outZ = brain.baseDefStepOutZ ?? 0;
      const outLen = Math.sqrt(outX * outX + outZ * outZ);
      if (outLen <= 0.01) cancelAiBaseDefenseStep(brain);
      else { moveX = -outX / outLen; moveZ = -outZ / outLen; }
    }
  }

  if (Math.abs(moveX) < 0.01 && Math.abs(moveZ) < 0.01) {
    clampToDiamondAI(enemy, ringLeft, ringRight, ringTop, ringBottom);
    return;
  }

  // The two projections below cancel movement into a feint-touching opponent.
  // The base defense step is exempt: its return leg is by definition aimed back
  // at the ground it just gave up, so projecting it away would leave the step
  // owing a debt it can never walk off and stall it until its timer ran out.
  const inBaseDefStep = (brain.baseDefStepPhase ?? 0) > 0;
  if (player.feintTouchingOpponent && !inBaseDefStep) {
    const toPlayerX = player.x - enemy.x;
    const toPlayerZ = player.z - enemy.z;
    const toPlayerLen = Math.sqrt(toPlayerX * toPlayerX + toPlayerZ * toPlayerZ);
    if (toPlayerLen > 0.01) {
      const dot = (moveX * toPlayerX + moveZ * toPlayerZ) / toPlayerLen;
      if (dot > 0 && enemy.defenseState !== "duck") {
        const nX = toPlayerX / toPlayerLen;
        const nZ = toPlayerZ / toPlayerLen;
        moveX -= dot * nX;
        moveZ -= dot * nZ;
      }
    }
  }
  if (player.feintDuckTouchingOpponent && !inBaseDefStep) {
    const toPlayerX = player.x - enemy.x;
    const toPlayerZ = player.z - enemy.z;
    const toPlayerLen = Math.sqrt(toPlayerX * toPlayerX + toPlayerZ * toPlayerZ);
    if (toPlayerLen > 0.01) {
      const dot = (moveX * toPlayerX + moveZ * toPlayerZ) / toPlayerLen;
      if (dot > 0) {
        const nX = toPlayerX / toPlayerLen;
        const nZ = toPlayerZ / toPlayerLen;
        moveX -= dot * nX;
        moveZ -= dot * nZ;
      }
    }
  }

  let speed = enemy.moveSpeed;
  speed *= enemy.moveSlowMult;
  if (enemy.telegraphSlowTimer > 0) speed *= 0.5;
  if (state.fatigueEnabled) {
    speed *= Math.max(0.5, 1 - Math.floor(enemy.punchesThrown / 50) * 0.0025);
  }
  if (enemy.guardDownSpeedBoost > 0) speed *= (1 + enemy.guardDownSpeedBoost);
  if (player.telegraphPhase !== "none") {
    // Chase burst while the player is winding up. The fraction is speed points
    // against the stat cap: back when points capped at 100 this divided by 100
    // and topped out at ~1.85x, but the cap moved to 1000 and the divisor did
    // not, so a career opponent with 650 speed was sliding away at 5.5x move
    // speed -- the "teleport" whenever you started a punch.
    const chaseT = Math.min(1, (state.careerEnemySkillPoints?.speed ?? 0) / getScaling().caps.maxSp);
    speed *= 1.2 + chaseT * pointCoef("speedChaseOnTelegraph", 0.65);
  }

  // A stun stops the feet outright. Applied last so nothing above -- including
  // the telegraph chase burst -- can multiply movement back in.
  if (enemy.stunMoveFreezeTimer > 0) speed = 0;

  // A slip pins the feet for as long as it is held, same as it does the player's.
  if (enemy.slipActive) speed = 0;

  // A leg of the out-and-back never walks past what it owes: the tick that
  // would overshoot is trimmed to the pixels left in it, so the return lands on
  // the ground the step started from rather than past it.
  if ((brain.baseDefStepPhase ?? 0) > 0 && speed > 0) {
    const stepTickPx = Math.sqrt(moveX * moveX + moveZ * moveZ) * speed * dt;
    const owedPx = brain.baseDefStepRemainingPx ?? 0;
    if (stepTickPx > owedPx) {
      const trim = owedPx / stepTickPx;
      moveX *= trim;
      moveZ *= trim;
    }
  }

  const preStepX = enemy.x;
  const preStepZ = enemy.z;
  enemy.x += moveX * speed * dt;
  enemy.z += moveZ * speed * dt;
  // Ring mileage, same rule as the player's: charged only for footwork the AI
  // actually produced. The early return above already rejects "not really
  // moving", a stun freeze zeroes `speed`, and the touching-opponent projection
  // can cancel the direction outright.
  const walkMag = Math.sqrt(moveX * moveX + moveZ * moveZ);
  if (speed > 0 && walkMag > 0.01) accrueRingMileage(enemy, dt);
  clampToDiamondAI(enemy, ringLeft, ringRight, ringTop, ringBottom);

  // The out-and-back is charged for ground actually covered, measured after the
  // ring clamp: a step into the ropes covers nothing and runs out on its timer
  // instead of waiting forever for a distance it can never walk.
  if ((brain.baseDefStepPhase ?? 0) > 0) {
    const movedX = enemy.x - preStepX;
    const movedZ = enemy.z - preStepZ;
    if (brain.baseDefStepPhase === 1) {
      brain.baseDefStepOutX = (brain.baseDefStepOutX ?? 0) + movedX;
      brain.baseDefStepOutZ = (brain.baseDefStepOutZ ?? 0) + movedZ;
    }
    const left = (brain.baseDefStepRemainingPx ?? 0) - Math.sqrt(movedX * movedX + movedZ * movedZ);
    if (left > 0.01) {
      brain.baseDefStepRemainingPx = left;
    } else if (brain.baseDefStepPhase === 1) {
      startAiBaseDefenseReturn(brain);
    } else {
      cancelAiBaseDefenseStep(brain);
    }
  }

  // Orientation is not set here. Both corners turn through the one rate-limited
  // update in the engine's main tick, so the AI's turn delay shows up in its
  // rendered geometry instead of being overwritten by an instant snap.
}

function getBasePerfectChance(band: DifficultyBand, myFrac: number): number {
  const above50 = myFrac >= 0.50;
  let baseChance: number;
  switch (band) {
    case "Easy": baseChance = above50 ? 0.35 : 0.22; break;
    case "Medium": baseChance = above50 ? 0.58 : 0.46; break;
    case "Hard": baseChance = above50 ? 0.86 : 0.78; break;
    case "Hardcore": baseChance = above50 ? 0.95 : 0.85; break;
    default: baseChance = 0;
  }
  const variance = aiRNG.range(-0.05, 0.05);
  return clamp01(baseChance + variance);
}

function computeRepeatPenalty(brain: AiBrainState): number {
  const counts = brain.playerLandedPunchCounts;
  let maxCount = 0;
  for (const key in counts) {
    if (counts[key] > maxCount) maxCount = counts[key];
  }
  if (maxCount < REPEAT_HIT_THRESHOLD) return 0;
  const over = maxCount - (REPEAT_HIT_THRESHOLD - 1);
  return clamp(over * REPEAT_PENALTY_STEP, 0, REPEAT_PENALTY_CAP);
}

// ===== PERFECT REACTION SYSTEM =====

function tryPerfectReact(brain: AiBrainState, enemy: FighterState, player: FighterState): void {
  if (brain.perfectReactActive) return;
  if (brain.gameTime < brain.nextPerfectReactTime) return;

  const myFrac = getMyStaminaFrac(enemy);
  const dist = getDistancePx(enemy, player);

  const hasPunchInfo = player.isPunching && player.currentPunch !== null;
  if (!hasPunchInfo) return;

  const maxReactDist = brain.attackRangeMax + blocksToPixels(0.25);
  if (dist > maxReactDist) return;

  let baseChance = getBasePerfectChance(brain.difficultyBand, myFrac);
  if (baseChance <= 0) return;

  let chance = baseChance * (1 - brain.perfectReactFadeFrac);

  const headCond = getHeadConditionFraction(brain);
  const bodyCond = getBodyConditionFraction(brain);
  const cond = clamp01(Math.max(headCond, bodyCond));
  chance = Math.max(0, chance - 0.12 * cond);

  const repeatPenalty = computeRepeatPenalty(brain);
  chance = Math.max(0, chance - repeatPenalty);

  chance = clamp01(chance + 0.04);
  chance = clamp01(chance + lerp(-0.02, 0.05, brain.personality.cleanHitsOverVolume));

  if (!rng.chance(chance)) return;

  brain.nextPerfectReactTime = brain.gameTime + PERFECT_REACT_COOLDOWN;
  triggerPerfectReaction(brain, enemy, player);
}

function triggerPerfectReaction(brain: AiBrainState, enemy: FighterState, player: FighterState): void {
  if (brain.comboActive) {
    brain.comboActive = false;
    brain.comboSteps = [];
    brain.comboStepIndex = 0;
  }

  brain.perfectReactActive = true;
  brain.perfectReactUntil = brain.gameTime + PERFECT_REACT_HOLD_TIME;
  brain.forcedGuard = false;
  brain.forcedHigh = false;
  brain.forcedLow = false;
  brain.forcedDuck = false;
  brain.stepOutDesiredMove = 0;

  const dirToPlayer = getDirToPlayer(enemy, player);

  const counterDuck = brain.styleCounterOffDuck;
  // Mid-assault the step-out is off the table entirely -- the reflex has to be
  // something that can be answered from where it stands, so the string resumes
  // in the pocket instead of restarting from range.
  const assaulting = isAiStringAssault(brain);
  let wDuck = 0.25 + counterDuck * 0.45;
  let wStepOut = assaulting ? 0 : 0.25 * lerp(1.0, 0.35, counterDuck);
  let wBlock = 0.50 * lerp(1.0, 0.40, counterDuck);
  const sum = wDuck + wStepOut + wBlock;

  const isChamp = brain.difficultyBand === "Hardcore" || brain.difficultyBand === "Hard";
  const punchIsUppercut = player.currentPunch === "leftUppercut" || player.currentPunch === "rightUppercut";
  if (isChamp && punchIsUppercut) {
    wDuck *= 0.1;
    wBlock += 0.3;
  }
  const adjustedSum = wDuck + wStepOut + wBlock;

  let r = rng.next01() * adjustedSum;
  if (r < wDuck) {
    brain.forcedDuck = true;
  } else if (r < wDuck + wStepOut) {
    brain.stepOutDesiredMove = -dirToPlayer;
  } else {
    brain.forcedGuard = true;
    const likelyBody = player.currentPunch === "leftUppercut" || player.currentPunch === "rightUppercut";
    const dirRoll = rng.next01();
    if (dirRoll < 0.6) {
      if (likelyBody) { brain.forcedLow = true; brain.forcedHigh = false; }
      else { brain.forcedHigh = true; brain.forcedLow = false; }
    }
    // 50% chance to use the perfect block mechanism instead of a regular guard
    // block -- 85% mid-assault, where standing in front of the player with an
    // ordinary guard is the worst of both options. Held for its Defense-scaled
    // duration, same as the player's V-key block.
    // A fundamentals-driven AI scales that base by how much intentional blocking
    // its seed asks for, so the reflex is a trait rather than one fixed rate.
    // A neutral intent reproduces the old numbers exactly, and the ceiling keeps
    // even a maximal seed short of blocking every single punch.
    const pbBase = assaulting ? 0.85 : 0.5;
    const pbChance = Math.min(PB_INTENT_MAX_REFLEX,
      pbBase * (1 + (brain.perfectBlockIntent01 - PB_INTENT_NEUTRAL) * PB_INTENT_REFLEX_SPAN));
    if (rng.next01() < pbChance && !isFeintEngaged(enemy)) {
      const holdSec = getPerfectBlockHoldSec(brain, enemy);
      enemy.perfectBlockActive = !isPerfectBlockRhythmPaused(enemy, player);
      enemy.perfectBlockTimer = holdSec;
      brain.perfectBlockHoldTimer = holdSec;
      brain.perfectReactUntil = Math.max(brain.perfectReactUntil, brain.gameTime + holdSec);
    }
  }
}

function applyPerfectReactionOverrides(brain: AiBrainState, enemy: FighterState, player: FighterState, directional: boolean): void {
  if (!brain.perfectReactActive) return;

  if (brain.gameTime > brain.perfectReactUntil) {
    brain.perfectReactActive = false;
    brain.forcedGuard = false;
    brain.forcedHigh = false;
    brain.forcedLow = false;
    brain.forcedDuck = false;
    brain.stepOutDesiredMove = 0;
    enemy.perfectBlockActive = false;
    enemy.perfectBlockTimer = 0;
    brain.perfectBlockHoldTimer = 0;
    brain.anticipationArmed = false;
    return;
  }

  // Directional perfect block: the window only turns away punches thrown from
  // the posture it is held in, so while one is open the AI re-points its guard
  // to match the attacker's posture every tick instead of committing at arm
  // time. Live rather than once, because hit resolution reads the attacker's
  // duck at impact -- they can drop to the body after the block was armed, and
  // the anticipatory and block-sync arms fire before the punch even exists.
  //
  // Two deliberate exemptions. With the toggle off an open window stops
  // anything, so there is nothing to match and the armed posture stands. And a
  // pattern script holding its duck through the window is answering a punch it
  // has already predicted, which beats reading the posture in front of it.
  if (directional && brain.perfectBlockHoldTimer > 0
      && enemy.stunBlockDisableTimer <= 0 && !brain.patternDuckHoldUntilRetract) {
    const matchDuck = player.defenseState === "duck";
    brain.forcedGuard = !matchDuck;
    brain.forcedDuck = matchDuck;
    if (matchDuck) {
      brain.forcedHigh = false;
      brain.forcedLow = false;
    }
  }

  if (enemy.stunBlockDisableTimer > 0) {
    enemy.defenseState = "none";
    brain.forcedGuard = false;
    brain.forcedDuck = false;
  } else if (brain.forcedGuard) {
    enemy.defenseState = "fullGuard";
  } else if (brain.forcedDuck) {
    enemy.defenseState = "duck";
    enemy.duckTimer = 0.3;
  }
}

function updatePerfectReactionFade(brain: AiBrainState, myFrac: number, dt: number): void {
  if (myFrac < 0.999) {
    brain.perfectReactBelowFullStaminaTimer += dt;
    while (brain.perfectReactBelowFullStaminaTimer >= PERFECT_REACT_FADE_TICK_SECONDS) {
      brain.perfectReactBelowFullStaminaTimer -= PERFECT_REACT_FADE_TICK_SECONDS;
      brain.perfectReactFadeFrac += PERFECT_REACT_FADE_TICK_AMOUNT;
      brain.perfectReactFadeFrac = clamp(brain.perfectReactFadeFrac, 0, 0.15);
    }
  }
}

// ===== HELD PERFECT BLOCK + ANTICIPATION =====

/** Same Defense-scaled ceiling the player's V-key block gets: 450ms at Defense 1 → 900ms at Defense 200. */
function getMaxPerfectBlockHoldSec(fighter: FighterState): number {
  // Equipment Upgrades — Hand Wraps lengthen the hold, matching the player's
  // own ceiling in the engine's V-key block.
  return (0.15 + clamp01(fighter.defenseT ?? 0) * 0.15) * 3 * (fighter.perfectBlockHoldMult ?? 1);
}

/** Registers a player offensive event (real punch, or a feint the AI decided to read as one)
 *  into the burst history and the close-and-fire counter. */
function registerPlayerOffensiveEvent(brain: AiBrainState): void {
  const now = brain.gameTime;
  const gap = now - brain.playerBurstLastPunchTime;
  if (brain.playerBurstPunches > 0 && gap <= PLAYER_BURST_GAP_SECONDS) {
    brain.playerBurstPunches++;
  } else {
    closePlayerBurst(brain);
    brain.playerBurstPunches = 1;
    brain.playerBurstStartTime = now;
  }
  brain.playerBurstLastPunchTime = now;

  if (brain.playerCloseWatchActive && now <= brain.playerCloseWatchUntil) {
    brain.playerCloseAndFireEvents++;
    brain.playerCloseWatchActive = false;
  }
}

function closePlayerBurst(brain: AiBrainState): void {
  if (brain.playerBurstPunches <= 0) return;
  const duration = Math.max(0, brain.playerBurstLastPunchTime - brain.playerBurstStartTime);
  brain.playerBurstHistory.push({ punches: brain.playerBurstPunches, duration });
  while (brain.playerBurstHistory.length > PLAYER_BURST_HISTORY_MAX) brain.playerBurstHistory.shift();
  brain.playerBurstPunches = 0;
}

/** Tracks how often the player closes distance and then fires, plus the shape of their
 *  last few attack patterns. Feints count as offense only when the AI reads them (50% base,
 *  higher when the AI is the more tired fighter, lower when it is the fresher one). */
function trackPlayerOffensePatterns(brain: AiBrainState, enemy: FighterState, player: FighterState, dt: number): void {
  const now = brain.gameTime;
  const dist = getDistancePx(enemy, player);

  brain.playerDistSampleTimer += dt;
  if (brain.playerDistSampleTimer >= PLAYER_CLOSE_SAMPLE_SECONDS) {
    brain.playerDistSampleTimer = 0;
    if (brain.playerDistSampleLast >= 0 && dist <= brain.attackRangeMax * 1.8) {
      const closed = brain.playerDistSampleLast - dist;
      if (closed >= PLAYER_CLOSE_DELTA_PX) {
        brain.playerCloseEvents++;
        brain.playerCloseWatchActive = true;
        brain.playerCloseWatchUntil = now + PLAYER_CLOSE_FIRE_WINDOW;
      }
    }
    brain.playerDistSampleLast = dist;
  }
  if (brain.playerCloseWatchActive && now > brain.playerCloseWatchUntil) {
    brain.playerCloseWatchActive = false;
  }

  const punching = player.isPunching;
  if (punching && !brain.playerPrevPunching) {
    brain.playerPunchRegistered = false;
    brain.playerFeintRolled = false;
    if (!player.isFeinting) {
      registerPlayerOffensiveEvent(brain);
      brain.playerPunchRegistered = true;
    }
  }
  // A punch can turn into a feint mid-flight (feint hold). Roll once per punch for
  // any feint the AI has not already booked as real offense.
  if (punching && player.isFeinting && !brain.playerPunchRegistered && !brain.playerFeintRolled) {
    brain.playerFeintRolled = true;
    const myFrac = getMyStaminaFrac(enemy);
    const theirFrac = getPlayerStaminaFrac(player);
    const readChance = clamp(FEINT_TIMING_ADJUST_BASE + (theirFrac - myFrac) * 0.5, 0.10, 0.90);
    if (rng.chance(readChance)) {
      registerPlayerOffensiveEvent(brain);
      brain.playerPunchRegistered = true;
    }
  }
  if (!punching && brain.playerPrevPunching) {
    brain.playerPunchRegistered = false;
    brain.playerFeintRolled = false;
  }
  brain.playerPrevPunching = punching;

  if (brain.playerBurstPunches > 0 && now - brain.playerBurstLastPunchTime > PLAYER_BURST_GAP_SECONDS) {
    closePlayerBurst(brain);
  }
}

/** Hold length for the next perfect block: adaptive value clamped to the Defense-scaled max. */
function getPerfectBlockHoldSec(brain: AiBrainState, enemy: FighterState): number {
  const maxHold = getMaxPerfectBlockHoldSec(enemy);
  return clamp(brain.perfectBlockHoldMs / 1000, PERFECT_BLOCK_MIN_HOLD_MS / 1000, maxHold);
}

/** Nudges the hold length ±10–100ms toward the player's recent attack patterns:
 *  short bursts shorten the hold, sustained ones lengthen it (never past the max). */
function adaptPerfectBlockHold(brain: AiBrainState, enemy: FighterState): void {
  if (brain.timingAdjustLocked) return;
  const hist = brain.playerBurstHistory;
  if (hist.length === 0) return;
  let totalMs = 0;
  for (const b of hist) totalMs += b.duration * 1000;
  const maxHoldMs = getMaxPerfectBlockHoldSec(enemy) * 1000;
  const targetMs = clamp(totalMs / hist.length, PERFECT_BLOCK_MIN_HOLD_MS, maxHoldMs);
  const gapMs = targetMs - brain.perfectBlockHoldMs;
  if (Math.abs(gapMs) < PERFECT_BLOCK_HOLD_STEP_MIN_MS) return;
  const stepMs = clamp(Math.abs(gapMs) * 0.5, PERFECT_BLOCK_HOLD_STEP_MIN_MS, PERFECT_BLOCK_HOLD_STEP_MAX_MS) * (gapMs > 0 ? 1 : -1);
  brain.perfectBlockHoldMs = clamp(brain.perfectBlockHoldMs + stepMs, PERFECT_BLOCK_MIN_HOLD_MS, maxHoldMs);
}

/** How often the AI answers a punch it read with a slip, by difficulty. This is
 *  the slip's share of the base defense reaction below, kept as the rate it was
 *  tuned at: a champion still slips 40% of the reads it gets. */
const AI_SLIP_CHANCE_BY_DIFFICULTY: Record<AIDifficulty, number> = {
  journeyman: 0.15,
  contender: 0.20,
  elite: 0.35,
  champion: 0.40,
};
/** Landed punches per step of slip-chance erosion, and the size of that step. */
const AI_SLIP_EROSION_HITS = 10;
const AI_SLIP_EROSION_STEP = 0.005;

/**
 * The base defense reaction: how often a punch the AI reads is answered at all,
 * by difficulty. The answer is a slip, a held perfect block, or a short step out
 * of range and straight back in — the slip rates above are this reaction's slip
 * share, and the rest is split between the other two.
 *
 * It has no cooldown because it is not a per-tick roll: it is rolled once per
 * punch, at the read, and it runs alongside everything else the AI has going.
 */
const AI_BASE_DEFENSE_CHANCE_BY_DIFFICULTY: Record<AIDifficulty, number> = {
  journeyman: 0.65,
  contender: 0.75,
  elite: 0.85,
  champion: 0.95,
};
/**
 * Clean punches landed on the AI per step of erosion, the size of that step, and
 * the floor it can never be driven below. Getting through is what buys the
 * openings: the reads never stop, but every tenth clean shot makes the man in
 * front of you a little easier to hit for the rest of the fight.
 */
const AI_BASE_DEFENSE_EROSION_HITS = 10;
const AI_BASE_DEFENSE_EROSION_STEP = 0.03;
const AI_BASE_DEFENSE_MIN_CHANCE = 0.25;
/** Split of the reaction's non-slip share between the block and the step-out. */
const AI_BASE_DEFENSE_BLOCK_WEIGHT = 0.6;
const AI_BASE_DEFENSE_STEP_WEIGHT = 0.4;
/** How far the step-out backs off the punch before walking the same ground back. */
const AI_BASE_DEFENSE_STEP_PX = 15;
/** Abandon an out-and-back that cannot finish: the ropes, a corner, a stun. */
const AI_BASE_DEFENSE_STEP_TIMEOUT = 1.2;
/** How long a read slip has to prove itself before the attempt goes ungraded. */
const AI_SLIP_ATTEMPT_GRADE_WINDOW = 1.5;
/** How much a mistimed slip moves the AI's learned delay, and how far it can go. */
const AI_SLIP_TIMING_STEP = 0.02;
const AI_SLIP_DELAY_MAX = 1.2;

/**
 * The slip answer. Knowing the punch is coming is not the same as slipping it:
 * the delay between the read and the slip is learned over the bout, not
 * calculated off the punch.
 */
function startAiReadSlip(defender: FighterState, attacker: FighterState): void {
  // Mostly straight back off the punch line; the rest split between the two
  // sides, which are also the slips that set up its counter straights.
  const r = rng.next01();
  const dir: SlipDir = r < 0.6 ? "back" : r < 0.8 ? "left" : "right";
  defender.slipReadAttemptTimer = AI_SLIP_ATTEMPT_GRADE_WINDOW;
  defender.slipReadPunchId = attacker.punchesThrown;
  const delay = Math.max(0, defender.slipReadDelay ?? 0);
  if (delay <= 0) {
    startSlip(defender, dir);
    if (defender.slipActive) defender.slipHoldTimer = AI_SLIP_HOLD;
  } else {
    defender.slipPendingTimer = delay;
    defender.slipPendingDir = dir;
  }
}

/**
 * The step-out answer: straight back off the punch, then the same ground back
 * in. It is footwork and nothing else — it interjects the movement planned for
 * the ticks it covers and hands the ground straight back, so the string, combo
 * or attack decision it cut across carries on around it.
 *
 * The distance is a parameter because the pattern layer buys a shorter one: a
 * prepared answer knows what is coming and only needs to be off its line.
 */
function armAiBaseDefenseStep(brain: AiBrainState, px: number = AI_BASE_DEFENSE_STEP_PX, turnRad: number = 0): void {
  brain.baseDefStepPhase = 1;
  brain.baseDefStepRemainingPx = Math.max(1, px);
  brain.baseDefStepOutX = 0;
  brain.baseDefStepOutZ = 0;
  brain.baseDefStepTimer = AI_BASE_DEFENSE_STEP_TIMEOUT;
  brain.baseDefStepTurn = turnRad;
}

/**
 * Which way the escape from an armed charge goes.
 *
 * Measured as a turn off the straight-back vector rather than as a compass
 * heading, so it stays correct as the two fighters move: every option is at
 * most a quarter turn, which puts the escape somewhere in the half of the ring
 * that is not in front of the charge. Straight back, square along either side,
 * and the diagonals between. Forward is the one direction never on the list --
 * walking into a charged punch is the only way to make one worse.
 */
const PATTERN_CHARGE_ESCAPE_TURNS = [0, Math.PI / 4, -Math.PI / 4, Math.PI / 2, -Math.PI / 2];

function pickChargeEscapeTurn(): number {
  const i = Math.floor(rng.next01() * PATTERN_CHARGE_ESCAPE_TURNS.length);
  return PATTERN_CHARGE_ESCAPE_TURNS[i] ?? 0;
}

/** Turn the step around: the second leg owes exactly the ground the first took. */
function startAiBaseDefenseReturn(brain: AiBrainState): void {
  const outX = brain.baseDefStepOutX ?? 0;
  const outZ = brain.baseDefStepOutZ ?? 0;
  const outLen = Math.sqrt(outX * outX + outZ * outZ);
  if (outLen <= 0.01) {
    cancelAiBaseDefenseStep(brain);
    return;
  }
  brain.baseDefStepPhase = 2;
  brain.baseDefStepRemainingPx = outLen;
  brain.baseDefStepTimer = AI_BASE_DEFENSE_STEP_TIMEOUT;
}

function cancelAiBaseDefenseStep(brain: AiBrainState): void {
  brain.baseDefStepPhase = 0;
  brain.baseDefStepRemainingPx = 0;
  brain.baseDefStepOutX = 0;
  brain.baseDefStepOutZ = 0;
  brain.baseDefStepTimer = 0;
  brain.baseDefStepTurn = 0;
}

/**
 * The AI's input read, and its base defense reaction. Called the moment either
 * fighter triggers a punch — this is the only thing the AI is allowed to read
 * inputs for, so the difficulty rates above are the rates actually seen.
 *
 * One roll per punch decides whether the read is answered at all; a second picks
 * the answer from whichever of the three are available. Nothing here is on a
 * cooldown and nothing here cancels the AI's plans: it interjects, and the AI
 * carries on with whatever it was doing.
 */
export function notifyAiPunchTrigger(state: GameState, defender: FighterState, attacker: FighterState): void {
  const brain = defender === state.enemy ? state.aiBrain : state.playerAiBrain;
  if (!brain) return;
  if (defender.isKnockedDown) return;
  // The green zone reads nothing. Catching the AI with its rhythm in its own
  // vulnerability window skips this whole layer -- no slip, no block, no step --
  // which is what makes timing a punch to the marker worth doing.
  if (isRhythmVulnerable(defender, attacker)) return;

  // Gate one: the AI's ordinary input read, unchanged. The pattern layer below
  // is gate two, and may only ever spend a read this roll has already won.
  const readPassed = rollAiReadGate(state, defender);

  // Pattern memory watches the punch either way -- seeing one thrown is not
  // reading an input. If it recognizes the combination and the read landed, its
  // prepared answer replaces the cold reflex below.
  const thrown = attacker.currentPunch;
  if (thrown) {
    // Posture decides the target, not the aim flag on its own. Hit resolution
    // only consults punchAimsHead on a punch thrown out of a duck -- upright,
    // the punch goes upstairs whatever the flag happens to say -- and the human
    // corner never sets that flag true at all. Reading it raw therefore filed
    // every punch the player has ever thrown as body work, which is both wrong
    // about the punch and wrong about the answer to it. Mirroring the engine's
    // own rule is what separates a standing punch from a ducked one here.
    const aimsHead = attacker.defenseState !== "duck" || attacker.punchAimsHead;
    const token = attacker.isFeinting
      ? feintActionToken(thrown, attacker.boxingStance)
      : punchActionToken(thrown, aimsHead, attacker.boxingStance);
    if (observePatternAction(state, brain, defender, attacker, token, readPassed)) return;
  }
  if (!readPassed) return;

  const base = AI_BASE_DEFENSE_CHANCE_BY_DIFFICULTY[state.aiDifficulty] ?? 0;

  // Which answers are on the table this instant. An unavailable one hands its
  // weight to the others rather than wasting the reaction.
  const canSlip = !defender.slipActive && defender.slipDisabledTimer <= 0 && defender.slipPendingTimer <= 0;
  // A block it cannot throw its hands up for, and never at the cost of a combo
  // already running: the reaction interjects the AI's plans, it does not end them.
  const canBlock = !defender.isPunching && !isFeintEngaged(defender) && !brain.comboActive
    && defender.stunBlockDisableTimer <= 0
    && !defender.perfectBlockActive && brain.perfectBlockHoldTimer <= 0;
  // A step already on its way out is not restarted by the next punch: re-arming
  // it would keep resetting the leg and walk the AI backwards indefinitely.
  const canStep = !defender.slipActive && defender.stunMoveFreezeTimer <= 0
    && (brain.baseDefStepPhase ?? 0) === 0;

  const slipWorn = Math.floor((defender.slipReadHitsTaken ?? 0) / AI_SLIP_EROSION_HITS) * AI_SLIP_EROSION_STEP;
  const slipShare = clamp(Math.max(0, (AI_SLIP_CHANCE_BY_DIFFICULTY[state.aiDifficulty] ?? 0) - slipWorn) / base, 0, 1);
  const restShare = 1 - slipShare;
  const answers: Array<{ w: number; run: () => void }> = [];
  if (canSlip) answers.push({ w: slipShare, run: () => startAiReadSlip(defender, attacker) });
  if (canBlock) answers.push({ w: restShare * AI_BASE_DEFENSE_BLOCK_WEIGHT, run: () => armAiPerfectBlock(brain, defender, attacker) });
  if (canStep) answers.push({ w: restShare * AI_BASE_DEFENSE_STEP_WEIGHT, run: () => armAiBaseDefenseStep(brain) });
  let total = 0;
  for (const a of answers) total += a.w;
  if (total <= 0) return;

  let roll = rng.next01() * total;
  // Falls back to the last answer standing rather than off the end of the list,
  // so a roll that lands exactly on the total still picks something available.
  let chosen = answers[answers.length - 1];
  for (const a of answers) {
    if (roll < a.w) { chosen = a; break; }
    roll -= a.w;
  }
  chosen.run();
}

/**
 * A head shot got through a slip the AI read. Nudge the delay between reading a
 * punch and slipping it: still pending means it moved too late, anything else
 * means the window opened and shut before the punch arrived.
 */
export function gradeAiSlipReadTiming(defender: FighterState): void {
  // Late covers both halves of being late: the slip never fired, and the slip
  // fired but the head was still sliding across when the shot arrived. Anything
  // else means the slip had already come and gone, so it went too early.
  const tooLate = defender.slipPendingTimer > 0
    || (defender.slipActive && defender.slipTimer < defender.slipEnterDuration);
  const next = (defender.slipReadDelay ?? 0) + (tooLate ? -AI_SLIP_TIMING_STEP : AI_SLIP_TIMING_STEP);
  defender.slipReadDelay = Math.max(0, Math.min(AI_SLIP_DELAY_MAX, next));
  defender.slipReadAttemptTimer = 0;
}

/**
 * @param chargeAnticipation Whether this block also spends the anticipation
 *   layer's rate limit. True for the heuristic that guesses a punch is coming,
 *   since that is the thing being rationed. False for a prepared answer to a
 *   recognized pattern: that block is not a guess, so it neither waits on the
 *   cooldown nor leaves one behind, and it is not evidence for or against the
 *   anticipation chance the expiry adapts.
 */
function armAiPerfectBlock(brain: AiBrainState, enemy: FighterState, player: FighterState, chargeAnticipation: boolean = true): void {
  // Feinting and perfect blocking are mutually exclusive for the AI too.
  if (isFeintEngaged(enemy)) return;
  if (brain.comboActive) {
    brain.comboActive = false;
    brain.comboSteps = [];
    brain.comboStepIndex = 0;
  }
  const holdSec = getPerfectBlockHoldSec(brain, enemy);
  brain.perfectReactActive = true;
  brain.perfectReactUntil = brain.gameTime + Math.max(PERFECT_REACT_HOLD_TIME, holdSec);
  brain.forcedGuard = true;
  brain.forcedHigh = false;
  brain.forcedLow = false;
  brain.forcedDuck = false;
  brain.stepOutDesiredMove = 0;
  brain.perfectBlockHoldTimer = holdSec;
  enemy.perfectBlockActive = !isPerfectBlockRhythmPaused(enemy, player);
  enemy.perfectBlockTimer = holdSec;
  if (chargeAnticipation) {
    brain.anticipationArmed = true;
    brain.nextAnticipationTime = brain.gameTime + holdSec + ANTICIPATION_COOLDOWN;
  }
}

/** Anticipatory perfect block: armed off the player's close-and-fire history — including
 *  before the AI's own offense — rather than purely as a reaction to a punch in flight. */
function tryAnticipatoryPerfectBlock(brain: AiBrainState, enemy: FighterState, player: FighterState): void {
  if (brain.perfectReactActive || brain.anticipationArmed) return;
  if (brain.gameTime < brain.nextAnticipationTime) return;
  if (enemy.stunBlockDisableTimer > 0 || enemy.isPunching || brain.comboActive) return;

  const dist = getDistancePx(enemy, player);
  if (dist > brain.attackRangeMax + blocksToPixels(0.25)) return;

  const closeAndFireRate = brain.playerCloseEvents > 0
    ? brain.playerCloseAndFireEvents / brain.playerCloseEvents
    : 0;
  const expectsFire = player.isPunching
    || brain.playerCloseWatchActive
    || brain.gameTime < brain.pressureCounterWindowUntil
    || (brain.playerApproaching && closeAndFireRate >= 0.5);
  if (!expectsFire) return;

  if (!rng.chance(brain.anticipationChance)) {
    brain.nextAnticipationTime = brain.gameTime + ANTICIPATION_COOLDOWN;
    return;
  }
  armAiPerfectBlock(brain, enemy, player);
}

/** Ticks the held block and, on expiry, adapts the chance (−1% / +1–3%) and the hold length. */
function updateAiPerfectBlockHold(brain: AiBrainState, enemy: FighterState, player: FighterState, dt: number): void {
  if (brain.perfectBlockHoldTimer <= 0) return;
  // Same hold-and-shut rule the player's V block follows: the AI's rhythm in the
  // green zone freezes its perfect block rather than spending it.
  if (isPerfectBlockRhythmPaused(enemy, player)) {
    enemy.perfectBlockActive = false;
    enemy.perfectBlockTimer = brain.perfectBlockHoldTimer;
    // The reaction override expires on wall-clock time, so push its deadline
    // out by the frozen frame too — otherwise a pause that outlives it throws
    // the unspent block away instead of resuming it.
    brain.perfectReactUntil += dt;
    return;
  }
  brain.perfectBlockHoldTimer -= dt;
  if (brain.perfectBlockHoldTimer > 0) {
    enemy.perfectBlockActive = true;
    enemy.perfectBlockTimer = brain.perfectBlockHoldTimer;
    return;
  }
  brain.perfectBlockHoldTimer = 0;
  enemy.perfectBlockActive = false;
  enemy.perfectBlockTimer = 0;
  if (!brain.anticipationArmed) return;
  brain.anticipationArmed = false;
  if (brain.timingAdjustLocked) return;

  const rate = brain.playerCloseEvents > 0
    ? brain.playerCloseAndFireEvents / brain.playerCloseEvents
    : 0;
  if (rate >= 0.5) {
    const up = ANTICIPATION_CHANCE_UP_MIN +
      (ANTICIPATION_CHANCE_UP_MAX - ANTICIPATION_CHANCE_UP_MIN) * clamp01((rate - 0.5) / 0.5);
    brain.anticipationChance = Math.min(ANTICIPATION_CHANCE_CAP, brain.anticipationChance + up);
  } else {
    brain.anticipationChance = Math.max(ANTICIPATION_CHANCE_FLOOR, brain.anticipationChance - ANTICIPATION_CHANCE_DOWN);
  }
  adaptPerfectBlockHold(brain, enemy);
}

/** Cancels any held AI perfect block (round boundary, KD, etc.) so the window can't survive the bell. */
export function resetAiPerfectBlockHold(brain: AiBrainState, fighter: FighterState): void {
  brain.perfectBlockHoldTimer = 0;
  brain.anticipationArmed = false;
  brain.nextAnticipationTime = 0;
  fighter.perfectBlockActive = false;
  fighter.perfectBlockTimer = 0;
}

// ===== PATTERN COUNTERS =======================================================
//
// The execution half of aiPatterns.ts. That module decides what the AI has
// learned; this one decides what it does about it, because the defensive
// primitives -- slips, guards, perfect blocks -- all live here.
//
// Nothing below can make the AI read more punches than it already did. The
// per-difficulty read chance is rolled exactly once per observed action by
// rollAiReadGate, and a counter can only ever be spent on a roll that already
// passed. What changes is the answer: instead of one reflex to one punch, the
// AI runs a prepared answer to all three actions of a combination it knows.

/**
 * How much longer than one defensive hold the AI will wait for the next action
 * of a pattern before writing the script off. Long enough for a combination
 * thrown at a normal cadence, short enough that backing out of the exchange
 * ends it.
 */
const PATTERN_SCRIPT_GAP_MULT = 3;

/**
 * How far ahead the held duck is pushed each tick while the punch it is
 * answering is still on its way. Short on purpose: it is a rolling extension,
 * so it is also how long the duck outlives a punch that never arrives.
 */
const PATTERN_DUCK_HOLD_STEP = 0.1;

/**
 * The AI's one input read: the per-difficulty chance, eroded by the clean
 * punches it has taken. Rolled once per action observed, never per tick.
 */
function rollAiReadGate(state: GameState, defender: FighterState): boolean {
  const base = AI_BASE_DEFENSE_CHANCE_BY_DIFFICULTY[state.aiDifficulty] ?? 0;
  if (base <= 0) return false;
  const worn = Math.floor((defender.cleanPunchesTakenFight ?? 0) / AI_BASE_DEFENSE_EROSION_HITS) * AI_BASE_DEFENSE_EROSION_STEP;
  return rng.next01() < Math.max(AI_BASE_DEFENSE_MIN_CHANCE, base - worn);
}

/**
 * The prepared answer to one action of a recognized pattern.
 *
 * Picked against what this engine actually rewards rather than what reads well.
 * Ducking makes a head shot miss outright, so it is the strongest answer there
 * -- except against an uppercut, which follows a dropping head up and lands
 * anyway. A body shot is the mirror image: ducking drops the high guard and
 * reclassifies everything as a body shot, so the answer is to stand and cover.
 * A charge is the one punch worth spending a perfect block on.
 */
function runPatternCounter(brain: AiBrainState, defender: FighterState, attacker: FighterState, token: string): void {
  const cfg = getAiPatternConfig();
  const mem = ensureAiPatternMemory(brain);
  const act = parseActionToken(token);

  // Availability here is "is the AI in a state where this answer is a thing it
  // can do at all" -- already punching, already slipping, stunned out of its
  // guard. Refractory periods are deliberately absent: a prepared answer to a
  // combination the AI knows is on a zero cooldown, so the third punch of a
  // pattern gets an answer even when the first two just used the same one.
  const canGuard = !defender.isPunching && !isFeintEngaged(defender) && !brain.comboActive
    && defender.stunBlockDisableTimer <= 0;
  const canPerfect = canGuard && !defender.perfectBlockActive && brain.perfectBlockHoldTimer <= 0;
  // Stun does not take the duck away, so unlike canGuard this has no stun term.
  const canDuck = !isFeintEngaged(defender) && !brain.comboActive;
  const canSlip = !defender.slipActive && defender.slipPendingTimer <= 0;
  const canStep = !defender.slipActive && defender.stunMoveFreezeTimer <= 0
    && (brain.baseDefStepPhase ?? 0) === 0;

  // A counter only works from behind something: the far hand answers while the
  // near one keeps blocking. With no guard and no duck available it is just a
  // trade, so it comes off the table.
  const counterPunches = pickPatternCounterPunches(defender, attacker, act);
  const canCounter = counterPunches.length > 0 && (canGuard || canDuck);

  // Whether a step of this length genuinely carries the AI past what is coming,
  // rather than just spoiling the range it was measured from.
  const incoming = act.punch ?? attacker.currentPunch;
  const stepClears = incoming != null
    && getDistancePx(defender, attacker) + cfg.stepOutPx > getPunchReachPx(attacker, incoming);

  const plan = choosePatternAnswer(act, {
    perfectBlock: canPerfect,
    duck: canDuck,
    guard: canGuard,
    slip: canSlip,
    counterPunch: canCounter,
    stepOut: canStep,
    stepClears,
  }, rng.next01());
  if (!plan) return;

  // A scripted guard rides the same override the reflex layer uses, so it is
  // cancelled by the same expiry and the same stun rules. holdActive marks it
  // as ours so the tick can drop it early once the punch starts to retract.
  const holdGuard = (duck: boolean) => {
    brain.perfectReactActive = true;
    brain.perfectReactUntil = Math.max(brain.perfectReactUntil, brain.gameTime + cfg.holdSec);
    brain.forcedGuard = !duck;
    brain.forcedDuck = duck;
    brain.forcedHigh = !duck && act.head;
    brain.forcedLow = !duck && !act.head;
    brain.stepOutDesiredMove = 0;
    mem.holdActive = true;
  };

  // Whatever was being held for the last action of the script is superseded by
  // this one, so the held duck is dropped here and re-armed below only if this
  // answer is the one that wants it.
  brain.patternDuckHoldUntilRetract = false;
  brain.patternDuckHoldPunchId = -1;
  brain.patternDuckHoldUntil = 0;

  // A charge is the one action answered before the punch it belongs to exists.
  // Everything else the script answers is already in flight, so its hold can be
  // stamped to the punch it is covering; here that punch has not been thrown,
  // so the stamp goes to the NEXT one and the wait is kept alive by the charge
  // still being armed. Left on the ordinary rule the hold would release on the
  // tick it was armed and the AI would stand straight back up, long before a
  // charge sat on for its full arm timer ever arrived.
  //
  // The deadline is the same gap the script already allows between two actions
  // of one combination. A charge is legally holdable for several seconds, and
  // an AI that stayed crouched through all of it would be worse off than one
  // that never read the charge at all.
  const armChargeDuckHold = () => {
    brain.patternDuckHoldUntilRetract = true;
    brain.patternDuckHoldPunchId = attacker.punchesThrown + 1;
    brain.patternDuckHoldUntil = brain.gameTime + cfg.holdSec * PATTERN_SCRIPT_GAP_MULT;
  };

  switch (plan.answer) {
    case "duck":
      holdGuard(true);
      // Ducking a charge means ducking the punch that comes out of it, which is
      // not this instant -- so the crouch waits for it rather than lapsing on
      // the hold clock while the player is still winding up.
      if (act.kind === "charge") armChargeDuckHold();
      break;
    case "guard":
      // Down at their height the high guard is gone, so against low work the
      // duck is the cover rather than something worn on top of it.
      holdGuard(plan.duckWith);
      break;
    case "slip":
      // startSlip refuses outright while the head-shot slip disable is up, so
      // the zero cooldown has to be spent on the field rather than just left
      // out of the availability test above.
      //
      // It cannot be put back afterwards: the engine reads the same field to
      // decide a slip is over, so restoring it would end this one on the tick
      // it began. The cost is that the rest of that window -- up to
      // SLIP_HEAD_HIT_DISABLE after eating a head shot -- is also open to the
      // ordinary reflex slip, not just to the scripted one. Accepted: it only
      // happens on a bout where the AI has already recognized the combination
      // and won the read, and "counters whenever" is the ask.
      defender.slipDisabledTimer = 0;
      startAiReadSlip(defender, attacker);
      break;
    case "stepOut":
      if (plan.duckWith) holdGuard(true);
      // Straight back is the answer to a punch whose line is already known. A
      // charge has no line yet, so the escape goes off in any direction that is
      // not into it.
      armAiBaseDefenseStep(brain, cfg.stepOutPx, act.kind === "charge" ? pickChargeEscapeTurn() : 0);
      break;
    case "perfectBlock":
      armAiPerfectBlock(brain, defender, attacker, false);
      // Postures have to match while the directional toggle is on: a standing
      // perfect block does not turn away a punch thrown out of a duck. Arming
      // one forces the standing guard, so low work re-points it downstairs.
      if (plan.duckWith) {
        brain.forcedGuard = false;
        brain.forcedDuck = true;
        // ...and stays down there. The block window is a fixed length, but the
        // punch it is answering is not: a slow one is still coming when the
        // window lapses, and standing up into it puts the head back where the
        // body shot was never going to reach. So the duck is held on the punch
        // instead of on the clock, until it starts coming back.
        brain.patternDuckHoldUntilRetract = true;
        // Stamped to the punch in flight, not left open-ended. The read hook
        // runs on the tick after the throw, so this is the punch being
        // answered; the moment the count moves on the hold is over, which also
        // keeps it from overriding whatever the next answer -- pattern or cold
        // reflex -- decides to do about the next punch.
        //
        // Against a charge there is no punch in flight to stamp to yet, so the
        // hold waits on the charge instead.
        if (act.kind === "charge") armChargeDuckHold();
        else brain.patternDuckHoldPunchId = attacker.punchesThrown;
      }
      break;
    case "counterPunch":
      holdGuard(plan.duckWith);
      brain.patternPunchQueue = counterPunches;
      brain.patternPunchUntil = brain.gameTime + cfg.holdSec;
      break;
  }
}

/**
 * The counter throw, and which hand it comes off.
 *
 * Throwing opens the guard on the side being thrown from, and only that side.
 * So the answer to a known punch is the other hand: the far glove goes out
 * while the near one stays home and blocks. Same hand and the guard swings open
 * onto a punch that is already on its way.
 *
 * Returned best-first rather than picked here, because the throw handshake
 * refuses anything out of reach and the caller walks the list.
 */
function pickPatternCounterPunches(defender: FighterState, attacker: FighterState, act: ParsedAction): PunchType[] {
  // Mid-punch and mid-feint are states, not cooldowns -- there is no hand free
  // to counter with. Anything refractory is handled by the drain, which clears
  // it: a prepared counter waits on nothing.
  if (defender.isPunching || isFeintEngaged(defender)) return [];
  let wantLeftArm: boolean;
  if (act.punch) {
    const incomingLead = isLeadArmPunch(act.punch, attacker.boxingStance);
    wantLeftArm = !incomingLead === (defender.boxingStance === "orthodox");
  } else {
    // Nothing is on its way yet -- a charge, or they have just dropped -- so
    // there is no side to stay away from. It comes off the rear hand, which is
    // the one that hurts.
    wantLeftArm = defender.boxingStance !== "orthodox";
  }
  // The straight first: it is the longer punch, so it is the one that reaches
  // from where a combination is usually read. The hook is the short fallback.
  return wantLeftArm ? ["jab", "leftHook"] : ["cross", "rightHook"];
}

/**
 * Is this fighter still inside a stun window?
 *
 * There is no stun flag: landing a stun arms a family of independent timers
 * (block weaken and disable, punch slow and disable, duck lockout, foot freeze,
 * turn delay), each with its own length. "Stunned" therefore means any of them
 * is still running -- the fighter is stunned until the last of the damage has
 * worn off, not until some nominal duration expires.
 */
function isInStunWindow(f: FighterState): boolean {
  return f.stunBlockWeakenTimer > 0
    || f.stunBlockDisableTimer > 0
    || f.stunPunchSlowTimer > 0
    || f.stunPunchDisableTimer > 0
    || f.stunMoveFreezeTimer > 0
    || f.stunFacingSlowTimer > 0;
}

/**
 * One offensive action by the opponent, seen by one AI corner.
 *
 * Recording is unconditional -- watching a punch happen is not reading an input
 * -- but acting on it is not. `mayAct` is the caller's already-rolled read gate.
 *
 * Returns true when the pattern layer answered the action, so the caller knows
 * its own reflex should stand down.
 */
function observePatternAction(
  state: GameState,
  brain: AiBrainState,
  defender: FighterState,
  attacker: FighterState,
  token: string,
  mayAct: boolean,
): boolean {
  const cfg = getAiPatternConfig();
  if (!cfg.enabled) return false;
  const mem = ensureAiPatternMemory(brain);
  if (defender.isKnockedDown || attacker.isKnockedDown) return false;

  const dist = getDistancePx(defender, attacker);
  if (dist > cfg.observeRangePx) {
    // Thrown from outside the range anything connects from: not part of a
    // combination worth learning, and a running script cannot be answered from
    // out here either. Range is the whole of what separation decides now --
    // inside it every action is recorded the same way, outside it the
    // combination being built is dropped.
    clearPatternWindow(mem);
    return false;
  }

  const ctx = buildPatternContext(brain.lastLandedPunchType);
  const threshold = patternRecognitionThreshold(cfg, state.aiDifficulty);
  const capacity = patternArmedCapacity(cfg, state.aiDifficulty);
  recordPatternAction(mem, token, ctx, threshold, capacity, cfg);

  // A script already running owns this action: it either continues or it dies.
  // Deviating from the pattern is the whole defence against being read.
  //
  // Continuing still costs a read of its own. A prepared answer is a better
  // answer, not a free one -- the AI that loses the read on the second punch of
  // a combination it knows eats it like anyone else, and picks the script back
  // up on the third.
  const scripted = advanceScriptedCounter(mem, token, mayAct);
  if (scripted !== "idle") {
    if (scripted === "abort") return false;
    mem.scriptExpires = brain.gameTime + cfg.holdSec * PATTERN_SCRIPT_GAP_MULT;
    if (scripted === "wait") return false;
    runPatternCounter(brain, defender, attacker, token);
    return true;
  }

  if (!mayAct) return false;

  const p = findArmedPattern(mem, ctx, token);
  if (!p) return false;

  // Erosion is the beating the AI is taking: every punch it failed to perfect
  // block shaves the total, and each knockdown it has suffered multiplies what
  // is left. Being stunned right now takes its own cut on top: the answer is
  // still there, the fighter just isn't in any state to pull it off.
  const chance = patternCounterChance(p, threshold, defender.slipReadHitsTaken ?? 0, defender.knockdowns ?? 0, cfg, isInStunWindow(defender));
  if (!rng.chance(chance)) return false;

  startPatternScript(mem, p, brain.gameTime, cfg.holdSec * PATTERN_SCRIPT_GAP_MULT);
  advancePatternScript(mem, token);
  runPatternCounter(brain, defender, attacker, token);
  return true;
}

/**
 * Per-tick half of the pattern layer: the two actions that are states rather
 * than events, the early release of a scripted guard, and script expiry.
 */
function updateAiPatternMemory(state: GameState, brain: AiBrainState, defender: FighterState, attacker: FighterState): void {
  const cfg = getAiPatternConfig();
  if (!cfg.enabled) {
    // Switched off mid-bout with a duck still held. Nothing below runs again to
    // release it, so it has to be dropped on the way out or the AI stays
    // crouched for the rest of the round.
    brain.patternDuckHoldUntilRetract = false;
    brain.patternDuckHoldPunchId = -1;
    brain.patternDuckHoldUntil = 0;
    return;
  }
  const mem = ensureAiPatternMemory(brain);

  // A perfect block thrown at body work ducks with it, and the duck outlives
  // the block: the window is a fixed length but the punch is not, so the
  // posture is held on the punch until it starts back. Extended a slice at a
  // time rather than pinned open, so a script that fired at nothing releases on
  // the very next tick instead of camping downstairs.
  // Both release rules below are read off one answer. They disagreed once, and
  // the disagreement was invisible: a charge is answered before its punch
  // exists, so mid-wait the opponent really is not punching, and the guard rule
  // read that as "the action is over" and cut the duck on the tick after it was
  // armed while the hold rule was still extending it.
  const hold = patternHoldStatus({
    holdArmed: !!brain.patternDuckHoldUntilRetract,
    stampedPunchId: brain.patternDuckHoldPunchId ?? -1,
    punchesThrown: attacker.punchesThrown,
    chargeArmed: !!attacker.chargeArmed,
    isPunching: attacker.isPunching,
    retracting: attacker.punchPhase === "retraction",
    now: brain.gameTime,
    chargeWaitUntil: brain.patternDuckHoldUntil ?? 0,
  });

  if (brain.patternDuckHoldUntilRetract) {
    if (hold.holdOwed) {
      brain.perfectReactActive = true;
      brain.forcedGuard = false;
      brain.forcedDuck = true;
      brain.perfectReactUntil = Math.max(brain.perfectReactUntil, brain.gameTime + PATTERN_DUCK_HOLD_STEP);
    } else {
      // Ordinary release. The stamped punch goes with the flag: the two are
      // only ever meaningful together, and a live brain carrying the id of a
      // punch that finished is state waiting to be misread.
      brain.patternDuckHoldUntilRetract = false;
      brain.patternDuckHoldPunchId = -1;
      brain.patternDuckHoldUntil = 0;
    }
  }

  // A scripted guard covers one action, it does not camp. Drop it the moment
  // that action is finished. A perfect block is left alone -- its window is the
  // mechanic, and cutting it short would waste it.
  if (mem.holdActive && hold.guardSpent) {
    mem.holdActive = false;
    if (brain.perfectReactActive && (brain.forcedGuard || brain.forcedDuck) && brain.perfectBlockHoldTimer <= 0) {
      brain.perfectReactUntil = Math.min(brain.perfectReactUntil, brain.gameTime);
    }
  }

  if (isPatternScriptRunning(mem) && brain.gameTime > mem.scriptExpires) clearPatternScript(mem);

  // Nothing spans a knockdown: not the combination being recorded, and not the
  // answer being run.
  if (defender.isKnockedDown || attacker.isKnockedDown) {
    clearPatternWindow(mem);
    clearPatternScript(mem);
    brain.patternPunchQueue = [];
    brain.patternDuckHoldUntilRetract = false;
    brain.patternDuckHoldPunchId = -1;
    brain.patternDuckHoldUntil = 0;
    mem.prevCharge = !!attacker.chargeArmed;
    mem.prevDuck = attacker.defenseState === "duck";
    return;
  }

  // Charging and dropping to the body are held states, so only the rising edge
  // is an action -- otherwise a held charge would be recorded sixty times a
  // second and the read gate rolled just as often.
  const chargeNow = !!attacker.chargeArmed;
  if (chargeNow && !mem.prevCharge) {
    observePatternAction(state, brain, defender, attacker, PATTERN_TOKEN_CHARGE, rollAiReadGate(state, defender));
  }
  mem.prevCharge = chargeNow;

  const duckNow = attacker.defenseState === "duck";
  if (duckNow && !mem.prevDuck) {
    observePatternAction(state, brain, defender, attacker, PATTERN_TOKEN_DUCK, rollAiReadGate(state, defender));
  }
  mem.prevDuck = duckNow;
}

/**
 * Throw the counter a pattern answer asked for.
 *
 * The read happens inside the engine's punch-trigger hook, which can arm a
 * guard or a duck but has no way to make the AI punch. So the throw is queued
 * there and spent here, on the next tick, through the ordinary handshake --
 * which means the reach gate, the gas veto and every other refusal apply to it
 * exactly as they do to any other punch. It keeps trying until the hold it was
 * armed under lapses, because the punch it is answering may not be in range yet.
 */
function drainPatternCounterPunch(
  brain: AiBrainState,
  enemy: FighterState,
  attemptPunchFn: (fighter: FighterState, punchType: PunchType, isFeint?: boolean, isCharged?: boolean) => boolean,
): void {
  const queue = brain.patternPunchQueue;
  if (!queue || queue.length === 0) return;
  if (brain.gameTime > (brain.patternPunchUntil ?? 0)) {
    brain.patternPunchQueue = [];
    return;
  }
  if (enemy.isPunching || enemy.isKnockedDown) return;
  // Zero cooldown. A counter to a combination the AI has memorized is not
  // rationed against the punch it happens to have thrown a moment ago, so the
  // one refractory standing between it and the throw is cleared rather than
  // waited out. Only this one: it is the only cooldown attemptPunch itself
  // tests, and the queue goes straight through attemptPunch rather than the
  // buffered-input release, so clearing anything else would be reaching into
  // timers this throw was never going to consult.
  //
  // Everything that is not a cooldown still applies: the handshake below
  // enforces reach, the gas veto and the aggression budget exactly as it does
  // for any other punch, so this buys timing, not free offense.
  enemy.punchCooldown = 0;
  for (const punch of queue) {
    if (attemptPunchFn(enemy, punch, false, false)) {
      brain.patternPunchQueue = [];
      return;
    }
  }
}

/** Bell or knockdown: a combination cannot span the break and neither can the
 *  answer to one. What has been learned survives; the half-seen chunk does not. */
export function resetAiPatternRound(brain: AiBrainState): void {
  const mem = ensureAiPatternMemory(brain);
  clearPatternWindow(mem);
  clearPatternScript(mem);
  mem.prevCharge = false;
  mem.prevDuck = false;
  brain.patternPunchQueue = [];
  brain.patternPunchUntil = 0;
  brain.patternDuckHoldUntilRetract = false;
  brain.patternDuckHoldPunchId = -1;
  brain.patternDuckHoldUntil = 0;
}

/**
 * Tape study. A ranked career opponent walks in already knowing some of what
 * the player has been caught repeating, instead of having to learn all of it
 * from scratch inside three rounds. They take the heaviest-repeated tape first
 * and keep building on it live, so the combination you lean on hardest is the
 * one they are readiest for and the one that gets harder to land as it goes on.
 *
 * Applied after startFight rather than through its parameter list, the same way
 * item boosts are: the library lives in the career save, which the engine has
 * no business reaching into. Returns how many patterns were studied.
 */
export function applyAiPatternStudy(
  state: GameState,
  library: AiPatternLibraryEntry[] | undefined,
  seedKey: number,
  opponentRank: number | null | undefined,
): number {
  const brain = state.aiBrain;
  if (!brain || !library || library.length === 0) return 0;
  if (opponentRank == null || opponentRank <= 0) return 0;
  const cfg = getAiPatternConfig();
  if (!cfg.enabled) return 0;
  const mem = ensureAiPatternMemory(brain);
  const rand = makePatternStudyRng(seedKey);
  const count = patternStudyCount(opponentRank, cfg, rand);
  return seedPatternMemory(
    mem,
    library,
    count,
    patternArmedCapacity(cfg, state.aiDifficulty),
    rand,
    cfg,
    patternRecognitionThreshold(cfg, state.aiDifficulty),
  );
}

/**
 * Fold what this opponent worked out about the player into the career-long
 * library. Returns null when there is nothing new, so the caller can leave the
 * save untouched rather than writing an identical blob.
 */
export function foldAiPatternLibrary(
  state: GameState,
  existing: AiPatternLibraryEntry[] | undefined,
): AiPatternLibraryEntry[] | null {
  const brain = state.aiBrain;
  if (!brain || !brain.patterns) return null;
  // Gym work never reaches the tape. A sparring partner studies the career
  // library the same way a ranked opponent does, but what they pick up in the
  // gym is not career footage and must not come back the other way — otherwise
  // a session spent drilling one combination would teach the whole roster it.
  // The guard sits here rather than at the call site because the rule is about
  // the bout, and sparringMode is what every non-career bout is flagged with
  // (ordinary sparring, Nightmare and the Doghouse Round alike).
  if (state.sparringMode) return null;
  const learned = exportPatternLibrary(brain.patterns);
  if (learned.length === 0) return null;
  return mergePatternLibrary(existing ?? [], learned, getAiPatternConfig().libraryMax);
}

/**
 * Combo chase: while the combo runs, walk after the player so the remaining
 * punches land instead of falling short when they circle or back out.
 * Only steers when the AI has drifted past its working range.
 */
function applyComboChase(brain: AiBrainState, enemy: FighterState, player: FighterState): void {
  if (!brain.comboChaseActive || enemy.stamina <= 0) return;

  const dx = player.x - enemy.x;
  const dz = player.z - enemy.z;
  const dist = Math.sqrt(dx * dx + dz * dz);
  if (dist < 0.01) return;

  const targetDist = brain.pressureActive ? PRESSURE_RANGE_PX : brain.attackRangeMax * 0.92;
  const overshoot = dist - (targetDist + COMBO_CHASE_TOLERANCE_PX);
  if (overshoot <= 0) {
    brain.desiredMoveInput = 0;
    brain.desiredMoveZ = 0;
    return;
  }

  const speed = COMBO_CHASE_MIN_SPEED +
    (1 - COMBO_CHASE_MIN_SPEED) * Math.min(1, overshoot / COMBO_CHASE_FULL_SPEED_PX);
  brain.desiredMoveInput = clamp((dx / dist) * speed, -1, 1);
  brain.desiredMoveZ = clamp((dz / dist) * speed, -1, 1);
}

/**
 * Live scoring lean, from the AI's side: banked round scores plus the round in
 * progress (damage, landed punches, knockdowns — the same things the judges weigh),
 * so the AI reacts to falling behind while the round is still being fought.
 * Returns -1 (losing badly) .. +1 (winning big).
 */
function getLiveScoreBias(brain: AiBrainState, state: GameState, isPlayerAI: boolean): number {
  const s = state.roundStats;
  const playerLive = s.playerDamageThisRound + s.playerLandedThisRound * 2 + s.playerKDsThisRound * 40;
  const enemyLive = s.enemyDamageThisRound + s.enemyLandedThisRound * 2 + s.enemyKDsThisRound * 40;
  const liveTotal = playerLive + enemyLive;
  if (liveTotal <= 0) return brain.scorecardBias;

  const liveDiff = isPlayerAI ? (playerLive - enemyLive) : (enemyLive - playerLive);
  const liveBias = clamp(liveDiff / liveTotal, -1, 1);
  if (state.roundScores.length === 0) return liveBias;
  return clamp(brain.scorecardBias * 0.5 + liveBias * 0.5, -1, 1);
}

/**
 * Adapts the chase chance mid-round rather than at the bell: one 1% step per second,
 * up while the AI is behind on the live cards, down while it leads.
 */
function updateComboChaseChance(brain: AiBrainState, state: GameState, dt: number, isPlayerAI: boolean): void {
  brain.comboChaseAdaptTimer = (brain.comboChaseAdaptTimer ?? 0) + dt;
  if (brain.comboChaseAdaptTimer < COMBO_CHASE_ADAPT_INTERVAL) return;
  brain.comboChaseAdaptTimer = 0;

  const bias = getLiveScoreBias(brain, state, isPlayerAI);
  if (Math.abs(bias) < COMBO_CHASE_ADAPT_DEADZONE) return;
  const step = bias < 0 ? COMBO_CHASE_SCORE_STEP : -COMBO_CHASE_SCORE_STEP;
  brain.comboChaseChance = clamp(brain.comboChaseChance + step, COMBO_CHASE_MIN_CHANCE, COMBO_CHASE_MAX_CHANCE);
}

function endPressure(brain: AiBrainState): void {
  if (!brain.pressureActive) return;
  brain.pressureActive = false;
  brain.pressureFollowupsLeft = 0;
  brain.pressureCooldown = 3 + rng.next01() * 3;
  brain.pressureCounterWindowUntil = brain.gameTime + PRESSURE_COUNTER_WINDOW;
}

/** Called when the player stuns the AI: 30% chance the AI stops adapting any of its
 *  timings for the rest of the round. */
export function notifyAiStunned(brain: AiBrainState): void {
  if (brain.timingAdjustLocked) return;
  if (rng.chance(STUN_TIMING_LOCK_CHANCE)) brain.timingAdjustLocked = true;
}

function updateDuckTargetBias(brain: AiBrainState, playerDucked: boolean): void {
  if (playerDucked === brain.prevPlayerDuckState) return;
  brain.prevPlayerDuckState = playerDucked;
  if (playerDucked) {
    // Player just ducked — re-roll how body-heavy we aim while they're low
    brain.duckBodyBias = rng.rollRange01(0.60, 0.90);
  } else {
    // Player stood up — re-roll how head-heavy we aim while they're standing
    brain.standHeadBias = rng.rollRange01(0.60, 0.90);
  }
}

function wantBodyWork(brain: AiBrainState, dist: number, playerDucked: boolean): boolean {
  // Duck-aware bias dominates: 80% weight on the pre-rolled duck/stand split,
  // 20% weight on tactical score so conditioning/phase still has a voice.
  // Base 65% downstairs, moved up or down by the round's duck-vs-stand read: a
  // target who never crouches gets worked to the body far harder than one who
  // spends the round underneath the punches. An opponent crouched *right now*
  // still overrides it upward -- their head is out of the line and the body is
  // the only thing there to hit.
  const postureBodyChance = clamp01((brain.adaptiveBodyBias ?? AI_BODY_BIAS_BASE) + brain.whiffLearnBodyBiasNudge);
  const duckAwareBodyChance = playerDucked
    ? clamp01(Math.max(postureBodyChance, brain.duckBodyBias + brain.whiffLearnBodyBiasNudge))
    : postureBodyChance;

  const headCond = getHeadConditionFraction(brain);
  const bodyCond = getBodyConditionFraction(brain);
  let bodyScore = 0;
  if (brain.currentPhase === "BodyHunt") bodyScore += 0.55;
  bodyScore += clamp01(bodyCond - headCond) * 0.50;
  bodyScore += dist < blocksToPixels(1.05) ? 0.10 : 0;
  const clean = brain.personality.cleanHitsOverVolume;
  if (dist > blocksToPixels(1.05)) bodyScore = Math.max(0, bodyScore - clean * 0.10);

  bodyScore += brain.styleBodyFocus * 0.40;
  bodyScore += getSlotValue(brain.adaptiveMemory, "bodyTargetBias");
  bodyScore -= getSlotValue(brain.adaptiveMemory, "headTargetBias");

  const pBody_Tactical = clamp01(bodyScore);
  const headP = getAdaptiveHeadProbability(brain);
  const pBody_Directional = 1 - headP;
  const w = 0.35;
  const pBody_TacticalFinal = lerp(pBody_Tactical, pBody_Directional, w);

  const pBody_Final = lerp(pBody_TacticalFinal, duckAwareBodyChance, 0.80);
  return rng.next01() < clamp01(pBody_Final);
}

function getAdaptiveHeadProbability(brain: AiBrainState): number {
  let headP = clamp01(brain.directionalSlider01);

  if (brain.playerHighBlockHeldSeconds > 0.5)
    headP = clamp01(headP - 0.15);
  if (brain.playerLowBlockHeldSeconds > 0.5)
    headP = clamp01(headP + 0.12);

  if (brain.difficultyBand === "Medium") headP = clamp01(headP + 0.03);
  else if (brain.difficultyBand === "Hard") headP = clamp01(headP + 0.06);
  else if (brain.difficultyBand === "Hardcore") headP = clamp01(headP + 0.09);

  return headP;
}

function updateDirectionalBlockTimers(brain: AiBrainState, player: FighterState, dt: number): void {
  if (player.defenseState === "fullGuard") {
    brain.playerHighBlockHeldSeconds += dt;
  } else {
    brain.playerHighBlockHeldSeconds = 0;
  }
  brain.playerLowBlockHeldSeconds = 0;
}

function notifyAiPunchContactedGuard(brain: AiBrainState, isHigh: boolean): void {
  const step = brain.difficultyBand === "Easy" ? 0.02 :
    brain.difficultyBand === "Medium" ? 0.04 :
    brain.difficultyBand === "Hard" ? 0.06 : 0.08;
  if (isHigh) brain.directionalSlider01 = clamp01(brain.directionalSlider01 - step);
  else brain.directionalSlider01 = clamp01(brain.directionalSlider01 + step);
}

function computeJabDoctrine(brain: AiBrainState): number {
  let doctrine = brain.jabDoctrineRoll01;
  if (brain.currentPhase === "Counter" || brain.currentPhase === "WhiffPunish") doctrine += 0.10;
  if (brain.currentPhase === "Finish") doctrine -= 0.08;
  return clamp01(doctrine);
}

function isRhythmCutActive(brain: AiBrainState): boolean {
  return brain.difficultyBand !== "Easy" && brain.gameTime < brain.rhythmCutUntil;
}

function rhythmCutTick(brain: AiBrainState, enemy: FighterState, player: FighterState): void {
  if (brain.difficultyBand === "Easy") return;
  if (brain.gameTime < brain.nextRhythmCutAllowedTime) return;

  const dist = getDistancePx(enemy, player);
  if (dist < brain.attackRangeMin || dist > brain.attackRangeMax + blocksToPixels(0.20)) return;

  const oppAgg = getPlayerAggression(brain.dataBank, 1.2, brain.gameTime);
  if (oppAgg < 0.25) return;

  const oppWhiffsShort = getWhiffCount(brain.dataBank, "player", 0.9, true, brain.gameTime);
  const whiffTrigger = oppWhiffsShort >= 2;
  const closeTrigger = dist <= brain.idealRangeWhiffPunish + blocksToPixels(0.15);
  if (!whiffTrigger && !closeTrigger) return;

  let chance = brain.difficultyBand === "Medium" ? 0.25 :
    brain.difficultyBand === "Hard" ? 0.45 : 0.65;
  const mult = lerp(0.75, 1.25, clamp01(brain.rhythmCutAggression01));
  chance = clamp01(chance * mult);

  if (!rng.chance(chance)) return;

  brain.rhythmCutUntil = brain.gameTime + RHYTHM_CUT_HOLD_SECONDS;
  brain.nextRhythmCutAllowedTime = brain.gameTime + RHYTHM_CUT_COOLDOWN_SECONDS;
}

// ─── Rhythm timing read ───────────────────────────────────────────────────────
// Every time the player changes their swaySpeedLevel within range, AI has a
// difficulty-scaled chance to improve its timing accuracy.
// Journeyman: 10% chance, up to +50% accuracy gain (crude, rare)
// Champion:   80% chance, up to +10% accuracy gain (precise, frequent)
function checkPlayerRhythmRead(brain: AiBrainState, enemy: FighterState, player: FighterState): void {
  const currentSpeed = player.swaySpeedLevel;
  if (brain.lastKnownPlayerSwaySpeed === currentSpeed) return;
  const prev = brain.lastKnownPlayerSwaySpeed;
  brain.lastKnownPlayerSwaySpeed = currentSpeed;
  if (prev < 0) return;

  const dist = getDistancePx(enemy, player);
  if (dist > brain.attackRangeMax * 2.5) return;

  const chanceByBand: Record<DifficultyBand, number> = {
    Easy: 0.10, Medium: 0.30, Hard: 0.60, Hardcore: 0.80,
  };
  const maxAdjByBand: Record<DifficultyBand, number> = {
    Easy: 0.50, Medium: 0.30, Hard: 0.20, Hardcore: 0.10,
  };

  if (!rng.chance(chanceByBand[brain.difficultyBand])) return;
  const adj = rng.next01() * maxAdjByBand[brain.difficultyBand];
  brain.rhythmTimingAccuracy = clamp01(brain.rhythmTimingAccuracy + adj);
}

// ─── Attack range learning ────────────────────────────────────────────────────
// Snapshot pixel distance each time AI lands a punch; maintain rolling average
// of up to 10 samples; use as preferred engagement distance.
function snapLandedPunchRange(brain: AiBrainState, enemy: FighterState, player: FighterState): void {
  const dist = getDistancePx(enemy, player);
  brain.landedPunchDistSnapshots.push(dist);
  if (brain.landedPunchDistSnapshots.length > 10) brain.landedPunchDistSnapshots.shift();
  if (brain.landedPunchDistSnapshots.length >= 3) {
    const sum = brain.landedPunchDistSnapshots.reduce((a, b) => a + b, 0);
    brain.aiLearntRangeAvg = sum / brain.landedPunchDistSnapshots.length;
  }
  // Something landed from here, so the whiff-driven closing pressure has done its
  // job — bleed it off rather than walking further in forever.
  brain.rangeWhiffDeficits = [];
  brain.rangeLearnClosePx = (brain.rangeLearnClosePx ?? 0) * 0.5;
  if (brain.rangeLearnClosePx < 1) brain.rangeLearnClosePx = 0;
  brain.rangeCloseIntentTimer = 0;
}

// Round boundary for the range-whiff learning above. Deliberately separate from
// onRoundBoundaryAdaptive, which only runs when adaptive AI is switched on — range
// learning is core behaviour and must soft-reset every round regardless.
export function onRoundBoundaryRangeLearning(brain: AiBrainState | null | undefined): void {
  if (!brain) return;
  // Carry a little of the closing pressure into the next round, like whiff learning
  brain.rangeLearnClosePx = (brain.rangeLearnClosePx ?? 0) * 0.30;
  brain.rangeWhiffDeficits = [];
  brain.rangeCloseIntentTimer = 0;
}

// Called when a punch could not physically reach the target — either rejected by the
// reach gate before it was thrown, or thrown and whiffed purely on distance. Samples
// the pixel shortfall and immediately plans to close that exact gap.
export function notifyAiRangeWhiff(brain: AiBrainState | null | undefined, punch: PunchType, deficitPx: number): void {
  if (!brain || !(deficitPx > 0)) return;
  if (brain.rangeWhiffDeficits === undefined) {
    brain.rangeWhiffDeficits = [];
    brain.rangeLearnClosePx = 0;
    brain.rangeCloseIntentTimer = 0;
    brain.lastRangeWhiffPunch = null;
  }
  brain.lastRangeWhiffPunch = punch;
  brain.rangeWhiffDeficits.push(deficitPx);
  if (brain.rangeWhiffDeficits.length > RANGE_WHIFF_MAX_SAMPLES) brain.rangeWhiffDeficits.shift();
  const avg = brain.rangeWhiffDeficits.reduce((a, b) => a + b, 0) / brain.rangeWhiffDeficits.length;
  // Close the average measured shortfall plus a small cushion so the next attempt
  // arrives inside reach rather than exactly on its edge.
  const want = clamp(avg + 4, 0, RANGE_WHIFF_MAX_CLOSE_PX);
  brain.rangeLearnClosePx = clamp(Math.max(brain.rangeLearnClosePx ?? 0, want), 0, RANGE_WHIFF_MAX_CLOSE_PX);
  brain.rangeCloseIntentTimer = Math.max(brain.rangeCloseIntentTimer ?? 0, 1.5);
}

// Called by engine when the AI is hit with a crit or stun (not blocked).
// Rolls the escalating forget chance; on success, wipes learnt attack range.
// +3% each time it triggers; resets to 35% each round.
export function notifyAiRangeDisrupt(brain: AiBrainState): void {
  if (!rng.chance(brain.rangeForgetChance)) return;
  brain.landedPunchDistSnapshots = [];
  brain.aiLearntRangeAvg = 0;
  brain.rangeForgetChance = Math.min(0.95, brain.rangeForgetChance + 0.03);
}

// ─── AI own rhythm management ─────────────────────────────────────────────────
// Picks a phase-appropriate swaySpeedLevel target; steps toward it gradually.
function setAiRhythmTarget(brain: AiBrainState): void {
  let target: number;
  switch (brain.currentPhase) {
    case "Pressure":    target = 4 + (rng.chance(0.40) ? 1 : 0); break;
    case "Finish":      target = 5; break;
    case "Counter":     target = 2 + Math.floor(rng.next01() * 2); break;
    case "Panic":
    case "Survival":    target = 1 + Math.floor(rng.next01() * 2); break;
    case "WhiffPunish": target = 3 + Math.floor(rng.next01() * 2); break;
    case "BodyHunt":    target = 2 + Math.floor(rng.next01() * 3); break;
    case "Download":    target = 1 + Math.floor(rng.next01() * 4); break;
    default:            target = 2 + Math.floor(rng.next01() * 3); break;
  }
  // Neural-tuned self-adaptation. The phase pick above is a guess about the
  // situation; this is a verdict on what has been working. The AI grades every
  // sway speed by the share of punches it landed from that speed and drifts
  // toward the best one, so a fighter scoring on a slow deliberate rhythm stops
  // being dragged up to 5 by phase alone. The blend weight is the tuning value
  // itself, so 0 restores phase-only behaviour exactly.
  const learn = clamp01(brain.rhythmSwayAdapt01 ?? 0);
  if (learn > 0) {
    const best = bestSwayLevel(brain);
    if (best > 0) target = Math.round(lerp(target, best, learn));
  }
  brain.aiRhythmTargetLevel = clamp(target, 1, 5);
}

function rollRhythmChangeInterval(band: DifficultyBand): number {
  switch (band) {
    case "Hardcore": return 1 + rng.next01() * 5;
    case "Hard":     return 5 + rng.next01() * 5;
    case "Medium":   return 8 + rng.next01() * 12;
    case "Easy":     return 15 + rng.next01() * 45;
    default:         return 8 + rng.next01() * 12;
  }
}

function rollRhythmStageShift(): number {
  return 1 + Math.floor(rng.next01() * 3);
}

export function notifyAiStunOrCrit(brain: AiBrainState, enemy: FighterState, attackerFocusT: number = 0): void {
  setAiRhythmTarget(brain);
  const shift = rollRhythmStageShift();
  const dir = rng.chance(0.50) ? 1 : -1;
  brain.aiRhythmTargetLevel = clamp(brain.aiRhythmTargetLevel + dir * shift, 1, 5);
  brain.aiRhythmChangeTimer = 0;
  const current = enemy.swaySpeedLevel;
  const target = brain.aiRhythmTargetLevel;
  if (current !== target) {
    enemy.swaySpeedLevel = current < target ? current + 1 : current - 1;
  }
  brain.rcDelayTimer = 0;
  brain.rcNudgeActive = false;
  brain.aiStunCount++;
  brain.aiChargeTargetBars = 0;
  brain.aiChargeArmDelayTimer = 0;
  // RC Drift: CPU-only, fires at most once per eligibility window (no stacking),
  // active only while AI has been stunned at least once more than the player.
  const driftEligible = !enemy.isPlayer &&
    brain.aiStunCount >= 1 &&
    brain.playerStunCount < brain.aiStunCount &&
    !brain.rcDriftApplied;
  if (driftEligible) {
    // Base drift: inversely scaled by AI's focus resistance (focusT 0→1 maps 0.5s→0.05s)
    const baseDrift_s = Math.max(0.001, 0.5 * Math.pow(0.1, enemy.focusT));
    // Bonus drift: bell-curve on attacker's focus, peaks at focus 100 (focusT≈0.5)
    const af = attackerFocusT * 200;
    const bonusDrift_s = Math.max(0, -0.000055 * af * af + 0.0135 * af + 0.05);
    const totalDriftMs = (baseDrift_s + bonusDrift_s) * 1000;
    brain.rcTimingLearntMs = (rng.chance(0.5) ? 1 : -1) * totalDriftMs;
    brain.rcDriftApplied = true; // lock out further stacking
  } else {
    brain.rcTimingLearntMs = 0;
  }
  brain.rcMissOffsetMs = 0;
}

/** Called when the human player (not the AI) is stunned or critted, so the brain can track stun parity.
 *  When the player has now been stunned as often as the AI, the drift window closes and resets
 *  so it can fire once more if the AI is subsequently stunned again. */
export function notifyAiPlayerStunned(brain: AiBrainState): void {
  brain.playerStunCount++;
  // Drift eligibility resets when player catches up — unlocks one future drift application
  if (brain.playerStunCount >= brain.aiStunCount) {
    brain.rcDriftApplied = false;
  }
}

export function notifyAiRcPunchResolved(brain: AiBrainState, defenderSwayOffset: number, defenderSwaySpeedLevel: number, defenderRhythmLevel: number): void {
  if (!brain.rcNudgeActive) return;
  brain.rcNudgeActive = false;
  // Stun lockout: the AI stops adjusting any of its timings for the rest of the round
  if (brain.timingAdjustLocked) return;
  // Approximate sway velocity: d(swayOffset)/dt ≈ 5 * 4 * (swaySpeedLevel/3) * (rhythmLevel*0.8+1.0) * 0.5
  const bobSpeed = Math.max(1.0, defenderRhythmLevel * 0.8 + 1.0);
  const swayRate = (20.0 / 3.0) * defenderSwaySpeedLevel * bobSpeed * 0.5;
  if (swayRate < 0.01) return;
  // Miss offset in ms: how far from center (0) the defender was when hit
  // Positive = we landed past center (late), negative = before center (early)
  const missOffsetMs = (defenderSwayOffset / swayRate) * 1000.0;
  // Persist raw miss distance for inspection/debugging
  brain.rcMissOffsetMs = missOffsetMs;
  // EMA blend 75% old / 25% new
  brain.rcTimingLearntMs = brain.rcTimingLearntMs * 0.75 + missOffsetMs * 0.25;
}

function updateAiOwnRhythm(brain: AiBrainState, enemy: FighterState, dt: number): void {
  if (enemy.rhythmLevel <= 0) {
    enemy.rhythmLevel = 2;
  }
  if (enemy.swaySpeedLevel <= 0) {
    enemy.swaySpeedLevel = 3;
  }

  brain.aiRhythmChangeTimer -= dt;
  if (brain.aiRhythmChangeTimer > 0) return;

  setAiRhythmTarget(brain);

  const current = enemy.swaySpeedLevel;
  const target = brain.aiRhythmTargetLevel;
  if (current !== target) {
    const shift = rollRhythmStageShift();
    const step = Math.min(shift, Math.abs(target - current));
    enemy.swaySpeedLevel = current < target ? current + step : current - step;
    enemy.swaySpeedLevel = clamp(enemy.swaySpeedLevel, 1, 5);
  }

  brain.aiRhythmChangeTimer = rollRhythmChangeInterval(brain.difficultyBand);
}

function computeDynamicComboChance(brain: AiBrainState, myFrac: number, dist: number, aiMomentum: number, oppAgg: number, punishWindow: boolean, level: number): number {
  const diffT = brain.difficultyBand === "Easy" ? 0 :
    brain.difficultyBand === "Medium" ? 0.45 :
    brain.difficultyBand === "Hard" ? 0.75 : 1;
  const baseTarget = lerp(0.23, 0.70, diffT);
  const lvlBoost = levelScale(level, 0.85, 1.15, "aiComboBoost");
  let comboChance = clamp01(baseTarget * lvlBoost + brain.classComboBias);

  if (brain.currentPhase === "Pressure") comboChance = clamp01(comboChance + 0.08);
  if (brain.currentPhase === "Finish") comboChance = clamp01(comboChance + 0.12);
  if (brain.currentPhase === "Counter") comboChance *= 0.80;
  if (brain.currentPhase === "Panic") comboChance *= 0.6;

  const clean = brain.personality.cleanHitsOverVolume;
  if (!punishWindow) comboChance = clamp01(comboChance - clean * 0.18);
  else comboChance = clamp01(comboChance + clean * 0.10);

  if (myFrac < LOW_STAMINA_FRAC) comboChance *= 0.7;
  if (brain.difficultyBand === "Hard") comboChance = clamp01(comboChance + 0.145);
  if (brain.difficultyBand === "Hardcore") comboChance = clamp01(comboChance + 0.185);

  const scoreBias = getScoreAggressionBias(brain);
  comboChance = clamp01(comboChance + scoreBias * 0.08);
  comboChance = clamp01(comboChance + (aiMomentum - 0.5) * 0.10);
  comboChance = clamp01(comboChance - clamp01(oppAgg - 0.55) * 0.08);

  return comboChance;
}

// ===== COMBO SYSTEM =====

// Champion (Hardcore) uppercut gate: lets through only 15% of uppercut attempts.
// All other bands are unaffected.
function generateCombo(brain: AiBrainState, dist: number, wantBody: boolean): AiCombo {
  const steps: AiComboStep[] = [];
  const comboRoll = aiRNG.range(0, 1);
  let numPunches = brain.difficultyBand === "Easy" ? (comboRoll < 0.6 ? 2 : 3) :
    brain.difficultyBand === "Medium" ? (comboRoll < 0.4 ? 3 : 4) :
    brain.difficultyBand === "Hard" ? (comboRoll < 0.35 ? 3 : comboRoll < 0.7 ? 4 : 5) :
    (comboRoll < 0.2 ? 3 : comboRoll < 0.45 ? 4 : comboRoll < 0.7 ? 5 : comboRoll < 0.9 ? 6 : 7);

  // Stamina-penalty combo limiting: while active, cap combo length to 2-3 punches
  if (brain.comboLimitTimer > 0 && brain.comboLimitMax > 0) {
    numPunches = Math.min(numPunches, brain.comboLimitMax);
  }

  const dirToPlayer = 1;
  for (let i = 0; i < numPunches; i++) {
    const body = i === 0 ? wantBody : rng.chance(wantBody ? 0.6 : 0.2);
    let punch: PunchType;
    if (body) {
      const r = rng.next01();
      if (r < 0.45) punch = rng.chance(0.5) ? "leftHook" : "rightHook";
      else punch = rng.chance(0.5) ? "leftUppercut" : "rightUppercut";
    } else {
      const r = rng.next01();
      if (i === 0 && dist > brain.idealRangeNeutral) {
        punch = r < 0.5 ? "jab" : "cross";
      } else {
        if (r < 0.30) punch = "jab";
        else if (r < 0.55) punch = "cross";
        else punch = rng.chance(0.5) ? "leftHook" : "rightHook";
      }
      // Difficulty-scaled uppercut frequency boost for non-body combo punches
      const comboUpperBoost = brain.difficultyBand === "Hardcore" ? (brain.isSparring ? 0.22 : 0.20) :
        brain.difficultyBand === "Hard" ? 0.12 :
        brain.difficultyBand === "Medium" ? 0.15 : 0;
      if (comboUpperBoost > 0 && punch !== "leftUppercut" && punch !== "rightUppercut" && rng.chance(comboUpperBoost)) {
        punch = rng.chance(0.5) ? "leftUppercut" : "rightUppercut";
      }
    }

    const delay = lerp(0.08, 0.25, rng.next01()) *
      (brain.difficultyBand === "Easy" ? 1.5 : brain.difficultyBand === "Medium" ? 1.2 : 1.0);

    steps.push({ punch, isFeint: false, delayAfter: delay, targetBody: body });
  }

  return { steps, name: `combo_${numPunches}` };
}

// ===== ATTACK DECISIONS =====

interface AttackAction {
  type: "punch" | "feint" | "combo" | "stepBack" | "none";
  punch?: PunchType;
  targetBody?: boolean;
  combo?: AiCombo;
  wantCharge?: boolean;
}

function thinkAttack(brain: AiBrainState, enemy: FighterState, player: FighterState): AttackAction {
  if (brain.currentState === "Panic" && getMyStaminaFrac(enemy) <= DEEP_SURVIVAL_FRAC) return { type: "none" };
  if (brain.comboActive) return { type: "none" };

  const inSurvival = brain.survivalModeActive || brain.currentPhase === "Panic";
  if (inSurvival) {
    const dist = getDistancePx(enemy, player);
    if (dist < brain.attackRangeMin || dist > brain.attackRangeMax) return { type: "none" };

    // A near-empty fighter that only covers up loses the round by default. The
    // top bands answer instead -- not volume, but always something coming back.
    let counterChance = SURVIVAL_COUNTER_CHANCE[brain.difficultyBand] ?? 0.12;

    const playerPunching = player.isPunching;
    if (playerPunching) counterChance *= 2.0;
    if (player.handsDown && dist <= brain.attackRangeMax * 0.9) counterChance *= 1.5;

    if (!rng.chance(counterChance)) return { type: "none" };

    const picks: PunchType[] = ["jab", "cross"];
    if (playerPunching) picks.push("leftHook", "rightHook");
    // From inside, the shots the engine actually rewards at that range.
    if (dist <= brain.attackRangeMax * 0.7) {
      picks.push("leftHook", "rightHook", "leftUppercut", "rightUppercut");
    }
    const punch = picks[Math.floor(rng.next01() * picks.length)];
    return { type: "punch", punch, targetBody: rng.chance(brain.adaptiveBodyBias ?? AI_BODY_BIAS_BASE) };
  }

  const dist = getDistancePx(enemy, player);

  if ((brain.playerIdleTime > 1.5 || brain.playerCornerCamping) && dist <= brain.attackRangeMax * 1.15) {
    const pick = rng.next01();
    const doBody = rng.chance(0.4);
    if (pick < 0.25) return { type: "punch", punch: "jab", targetBody: doBody };
    if (pick < 0.50) return { type: "punch", punch: "cross", targetBody: doBody };
    if (pick < 0.65) return { type: "punch", punch: "leftHook", targetBody: doBody };
    if (pick < 0.80) return { type: "punch", punch: "rightHook", targetBody: doBody };
    const combo = generateCombo(brain, dist, doBody);
    return { type: "combo", combo, targetBody: doBody };
  }

  if (dist < brain.attackRangeMin || dist > brain.attackRangeMax) return { type: "none" };

  // Rhythm timing read: if AI has learnt the player's rhythm cycle, prefer attacking
  // when the player is at their weight-transfer center (swayOffset ≈ 0). Higher accuracy
  // = stronger preference; player punching breaks the hold (counter window stays open).
  if (brain.rhythmTimingAccuracy > 0.25 && player.swaySpeedLevel > 0 && !player.isPunching) {
    const edgeness = Math.abs(player.swayOffset) / 10; // 0 = at center, 0.5 = max edge
    const holdChance = brain.rhythmTimingAccuracy * edgeness * 1.6;
    if (holdChance > 0.50 && rng.next01() < holdChance * 0.65) {
      return { type: "none" }; // wait for player to arrive at their rhythm center
    }
  }

  const sitMatch = matchSituation(
    SITUATION_DB,
    {
      playerDef: player.defenseState,
      enemyDef: enemy.defenseState,
      distFrac: brain.attackRangeMax > 0 ? dist / brain.attackRangeMax : 0,
      playerPunching: player.isPunching,
      recentPunches: (brain.recentPlayerPunches || []) as PunchType[],
      sustainedDuckSec: brain.playerSustainedDuckTimer,
      duckPunchCount: brain.playerDuckPunchCount,
      crossRatio: brain.playerTotalPunchCount > 0 ? brain.playerCrossCount / brain.playerTotalPunchCount : 0,
      bodyRatio: brain.playerBodyAttackRatio,
      guardDropSec: brain.playerGuardDropTimer,
      prevDef: brain.playerPrevDefenseState,
      defSwitchAge: brain.gameTime - brain.playerLastDefenseSwitch,
      approaching: brain.playerApproaching,
      totalPunchCount: brain.playerTotalPunchCount,
    },
    getDifficultyMultiplier(brain.difficultyBand),
    () => rng.next01()
  );

  if (sitMatch) {
    const c = sitMatch.counter;
    if (c.action === "punch" && c.punch) {
      return { type: "punch", punch: c.punch, targetBody: c.targetBody ?? false };
    }
    if (c.action === "stepBack") {
      return { type: "stepBack" };
    }
    if (c.action === "feint") {
      return { type: "feint", punch: c.punch };
    }
    if (c.action === "guardSwitch" && c.forceGuard) {
      if (c.forceGuard === "high") brain.forcedHigh = true;
      else if (c.forceGuard === "low") brain.forcedLow = true;
      else if (c.forceGuard === "duck") brain.forcedDuck = true;
    }
  }

  const myFrac = getMyStaminaFrac(enemy);

  // ===== Execution layer: per-fighter offense profile (no stat boosts, decision-quality only) =====
  const execProf = brain.offense;
  const execInt = brain.execIntensity;
  const adaptBodyBiasExec = getSlotValue(brain.adaptiveMemory, "bodyTargetBias");

  // Opening-window shots: player committed to a power punch → counter into the gap
  // 10% global reduction: this mid-punch combo punish fired too often.
  if (player.isPunching && player.currentPunch && player.currentPunch !== "jab" && rng.chance(execProf.openingShots * execInt * 0.40 * 0.90)) {
    return { type: "punch", punch: rng.chance(0.55) ? "cross" : (rng.chance(0.5) ? "leftHook" : "rightHook"), targetBody: false };
  }
  // Player standing tall after sustained body work → go back upstairs
  if (brain.bodyConditionScore > 25 && player.defenseState !== "duck" && !player.isPunching && rng.chance(execProf.openingShots * execInt * 0.25)) {
    return { type: "punch", punch: rng.chance(0.5) ? "cross" : "rightHook", targetBody: false };
  }

  // Body campaign: sustained downstairs investment at this fighter's preferred range
  if (!brain.bodyCampaignActive && brain.bodyCampaignCooldown <= 0 && dist <= execProf.bodyCampaignRangePx && rng.chance(execProf.bodyCampaign * execInt * 0.25)) {
    brain.bodyCampaignActive = true;
    brain.bodyCampaignCashIn = false;
    brain.bodyCampaignUntil = brain.gameTime + execProf.bodyCampaignDuration;
  }

  // Close-range charged ambush: mask the charge behind a jab, arm via the deferred charge path
  if (brain.chargedAmbushCooldown <= 0 && !enemy.chargeArmed && brain.aiChargeTargetBars === 0 &&
      enemy.chargeMeterBars >= 1 && dist <= execProf.chargedAmbushRangePx &&
      rng.chance(execProf.chargedAmbush * execInt * 0.20)) {
    brain.chargedAmbushCooldown = 8 + rng.next01() * 8;
    return { type: "punch", punch: "jab", targetBody: rng.chance(0.4), wantCharge: true };
  }

  // Double up on the punch that just landed clean
  if (brain.lastLandedPunchType && brain.gameTime - brain.lastLandedPunchTime < 1.5 &&
      rng.chance(execProf.comboLayering * execInt * 0.25)) {
    const repeatPunch = brain.lastLandedPunchType;
    brain.lastLandedPunchType = null;
    return { type: "punch", punch: repeatPunch, targetBody: rng.chance(clamp01(0.35 + adaptBodyBiasExec)) };
  }

  // Body-spam counter cash-in: after ducking under body spam, come back over the top
  if (brain.gameTime < brain.bodySpamCounterReadyUntil && !player.isPunching && rng.chance(execProf.bodySpamCounter * execInt * 0.6)) {
    brain.bodySpamCounterReadyUntil = 0;
    return { type: "punch", punch: rng.chance(0.6) ? "cross" : "rightHook", targetBody: false };
  }

  const playerWhiffsShort = getWhiffCount(brain.dataBank, "player", 0.9, true, brain.gameTime);
  const isDucked = enemy.defenseState === "duck";
  if (isDucked && playerWhiffsShort >= 1 && rng.chance(brain.styleCounterOffDuck)) {
    const doBody = rng.chance(brain.styleBodyFocus);
    return { type: "punch", punch: "cross", targetBody: doBody };
  }

  const playerIsDucked = player.defenseState === "duck";
  updateDuckTargetBias(brain, playerIsDucked);

  const isChampionBand = brain.difficultyBand === "Hardcore" || brain.difficultyBand === "Hard";
  if (isChampionBand && playerIsDucked && brain.playerSustainedDuckTimer > 1.2 && rng.chance(brain.styleSustainedDuckCounter * brain.adaptationRate)) {
    const duckPunchHeavy = brain.playerDuckPunchCount >= 4;
    if (duckPunchHeavy && rng.chance(0.6)) {
      return { type: "punch", punch: rng.chance(0.5) ? "leftUppercut" : "rightUppercut", targetBody: true };
    }
    return { type: "stepBack" };
  }

  const duckPunchThreat = isChampionBand && brain.playerDuckPunchCount >= 3;
  const adaptUppercutDuck = getSlotValue(brain.adaptiveMemory, "uppercutOnDuck");
  if (playerIsDucked && brain.playerDuckApproachTimer > 0.3 && rng.chance((brain.styleAntiDuckUppercut + adaptUppercutDuck) * brain.adaptationRate)) {
    const uppercutBias = duckPunchThreat ? 0.75 : 0.55;
    const pick = rng.next01();
    if (pick < uppercutBias) {
      return { type: "punch", punch: rng.chance(0.5) ? "leftUppercut" : "rightUppercut", targetBody: true };
    } else {
      return { type: "punch", punch: rng.chance(0.5) ? "leftHook" : "rightHook", targetBody: true };
    }
  }

  const adaptPostDodge = getSlotValue(brain.adaptiveMemory, "postDodgeAttack");
  if ((isChampionBand || adaptPostDodge > 0.05) && brain.lastPunchDodgedTimer > 0 && rng.chance((brain.stylePostDodgeFollowup + adaptPostDodge) * brain.adaptationRate)) {
    brain.lastPunchDodgedTimer = 0;
    return { type: "punch", punch: rng.chance(0.6) ? "cross" : (rng.chance(0.5) ? "leftUppercut" : "rightUppercut"), targetBody: true };
  }

  if (isChampionBand && brain.playerTotalPunchCount >= 8) {
    const crossRatio = brain.playerCrossCount / brain.playerTotalPunchCount;
    if (crossRatio >= 0.45 && rng.chance(brain.adaptationRate * 0.7)) {
      brain.forcedLow = true;
      if (dist < brain.attackRangeMax && rng.chance(0.5)) {
        return { type: "punch", punch: rng.chance(0.6) ? "leftUppercut" : "leftHook", targetBody: true };
      }
    }
  }

  if (isChampionBand) {
    const switchAge = brain.gameTime - brain.playerLastDefenseSwitch;
    if (switchAge < 0.4 && switchAge > 0 && playerIsDucked && dist < brain.attackRangeMax) {
      if (rng.chance(brain.adaptationRate * 0.6)) {
        return { type: "punch", punch: rng.chance(0.5) ? "leftUppercut" : "rightUppercut", targetBody: false };
      }
    }
  }

  const adaptChase = getSlotValue(brain.adaptiveMemory, "chaseAfterRetreat");
  if (brain.playerRetreatTimer > 0.5 && (brain.styleRetreatTracking + adaptChase) > 0.3 && rng.chance(brain.adaptationRate)) {
    if (rng.chance((brain.styleRetreatTracking + adaptChase) * 0.4)) {
      return { type: "none" };
    }
  }

  const adaptGuardDrop = getSlotValue(brain.adaptiveMemory, "guardDropExploit");
  if (brain.playerGuardDropTimer > 0.4 && rng.chance(brain.styleCounterOffGuardDrop + adaptGuardDrop)) {
    const punchPick = rng.next01();
    const doBody = rng.chance(brain.styleBodyFocus);
    if (punchPick < 0.35) {
      return { type: "punch", punch: "cross", targetBody: doBody };
    } else if (punchPick < 0.55) {
      return { type: "punch", punch: "rightHook", targetBody: doBody };
    } else if (punchPick < 0.70) {
      return { type: "punch", punch: "leftHook", targetBody: doBody };
    }
  }

  if (isChampionBand && brain.playerGuardDropTimer > 0.8 && dist < brain.attackRangeMax) {
    const openGuardBoost = clamp01(brain.adaptationRate * 0.9);
    if (rng.chance(openGuardBoost)) {
      const doBody = rng.chance(brain.styleBodyFocus);
      const pick = rng.next01();
      if (pick < 0.4) return { type: "punch", punch: "cross", targetBody: doBody };
      else if (pick < 0.6) return { type: "punch", punch: rng.chance(0.5) ? "leftHook" : "rightHook", targetBody: doBody };
      else {
        const combo = generateCombo(brain, dist, doBody);
        return { type: "combo", combo, targetBody: doBody };
      }
    }
  }

  const adaptCommit = getSlotValue(brain.adaptiveMemory, "commitChanceBias");
  const adaptAgg = getSlotValue(brain.adaptiveMemory, "aggression");
  const adaptFeint = getSlotValue(brain.adaptiveMemory, "feintBeforeAttack");
  const adaptPatience = getSlotValue(brain.adaptiveMemory, "patienceBias");

  if (brain.playerIdleTime < 1.0 && !brain.playerCornerCamping) {
    const aiWhiffsRecent = getWhiffCount(brain.dataBank, "ai", 2.0, true, brain.gameTime);
    // Missing is information, not a reason to stop. The old figures had a
    // Champion shutting its own offence down 70% of the time after three
    // whiffs -- against a mobile opponent that is most of the round. The lower
    // bands keep the caution; the top ones adjust range and keep working.
    if (aiWhiffsRecent >= 3) {
      const suppressChance = brain.difficultyBand === "Easy" ? 0.85 :
        brain.difficultyBand === "Medium" ? 0.80 :
        brain.difficultyBand === "Hard" ? 0.50 : 0.30;
      if (rng.chance(suppressChance)) return { type: "stepBack" };
    } else if (aiWhiffsRecent >= 2) {
      const suppressChance = brain.difficultyBand === "Easy" ? 0.60 :
        brain.difficultyBand === "Medium" ? 0.55 :
        brain.difficultyBand === "Hard" ? 0.30 : 0.15;
      if (rng.chance(suppressChance)) return { type: "none" };
    }
  }

  if (brain.engageCyclePhase === "out" && (brain.stylePatience + adaptPatience) > 0.4 && brain.playerIdleTime < 1.0 && !brain.playerCornerCamping) {
    let suppressChance = (brain.stylePatience + adaptPatience) * 0.65;
    // Patience is a between-exchanges idea, not a reason to skip a turn while
    // standing in range of someone who is available to be hit.
    if (isChampionBand) suppressChance *= 0.35;
    if (isChampionBand && brain.playerGuardDropTimer > 0.3) suppressChance *= 0.3;
    if (rng.chance(suppressChance)) return { type: "none" };
  }

  let patternCounterOpportunity = false;
  let matchedPatternIndex = -1;
  if (dist <= PATTERN_RANGE_MAX_PX) {
    const result = tryGetCurrentPatternMatch(brain.dataBank, PATTERN_WINDOW_SECONDS, brain.gameTime);
    if (result.matched) {
      patternCounterOpportunity = true;
      matchedPatternIndex = result.patternIndex;
    }
  }

  const momentum = getAiMomentum(brain.dataBank, 5, brain.gameTime);
  const playerAgg = getPlayerAggression(brain.dataBank, 5, brain.gameTime);

  const punishWindow = brain.currentPhase === "WhiffPunish" || brain.currentPhase === "Counter" ||
    patternCounterOpportunity || playerWhiffsShort >= 2;

  const rhythmCutNow = isRhythmCutActive(brain);
  const clean = brain.personality.cleanHitsOverVolume;

  let commitChance = lerp(0.70, 0.98, clamp01(brain.personality.aggression + brain.classAggressionBias + adaptAgg));
  commitChance = lerp(commitChance, commitChance - 0.12, clean);
  commitChance = lerp(commitChance - 0.25, commitChance + 0.25, momentum);
  commitChance += playerWhiffsShort * 0.12 * brain.winnerMindIntensity;
  commitChance -= clamp01((playerAgg - 0.5) * 2) * 0.20;
  commitChance += adaptCommit;

  if (brain.currentPhase === "Pressure") commitChance += 0.10;
  if (brain.currentPhase === "Finish") commitChance += 0.20;
  if (brain.currentPhase === "Counter") commitChance -= 0.10;
  if ((brain.currentPhase as TacticalPhase) === "Panic") commitChance -= 0.25;
  if (brain.currentPhase === "WhiffPunish") commitChance += clean * 0.10;

  if (rhythmCutNow && rng.chance(clamp01(brain.rhythmCutCommitChanceRoll01))) {
    commitChance = clamp01(commitChance + 0.15);
  }

  if (myFrac < LOW_STAMINA_FRAC) commitChance *= 0.65;

  const scoreBias = getScoreAggressionBias(brain);
  commitChance += scoreBias * clamp(0.15, 0, 0.40);

  if (patternCounterOpportunity) {
    commitChance = Math.max(commitChance,
      brain.difficultyBand === "Hardcore" ? 0.95 :
      brain.difficultyBand === "Hard" ? 0.80 :
      brain.difficultyBand === "Medium" ? 0.45 : 0.25);
  }

  if (isChampionBand) {
    const minCommit = brain.difficultyBand === "Hardcore" ? 0.50 : 0.35;
    commitChance = Math.max(commitChance, minCommit);
  }
  commitChance = clamp01(commitChance);
  if (!rng.chance(commitChance)) return { type: "none" };

  let doBody = wantBodyWork(brain, dist, playerIsDucked);

  // Body campaign in progress: bias downstairs, then cash in upstairs when the guard drops
  // or the campaign runs its course.
  if (brain.bodyCampaignActive) {
    if (brain.bodyCampaignCashIn || brain.playerGuardDropTimer > 0.3) {
      brain.bodyCampaignActive = false;
      brain.bodyCampaignCashIn = false;
      brain.bodyCampaignCooldown = 6 + rng.next01() * 8;
      return { type: "punch", punch: rng.chance(0.5) ? "cross" : (rng.chance(0.5) ? "leftHook" : "rightHook"), targetBody: false };
    }
    if (rng.chance(0.15 + 0.75 * execInt)) doBody = true;
  }

  let comboChance = computeDynamicComboChance(brain, myFrac, dist, momentum, playerAgg, punishWindow, enemy.level);
  if (rhythmCutNow) comboChance = clamp01(comboChance + 0.08);
  comboChance = clamp01(comboChance + execProf.comboLayering * execInt * 0.12);

  if (rng.chance(comboChance)) {
    // Level-change combos: deliberately mix head/body inside one combo
    if (rng.chance(execProf.comboLayering * execInt * 0.5)) {
      const hook: PunchType = rng.chance(0.5) ? "leftHook" : "rightHook";
      const steps: AiComboStep[] = rng.chance(0.5)
        ? [
            { punch: "jab", targetBody: false, isFeint: false, delayAfter: 0.14 },
            { punch: hook, targetBody: true, isFeint: false, delayAfter: 0.16 },
            { punch: "cross", targetBody: false, isFeint: false, delayAfter: 0.15 },
          ]
        : [
            { punch: hook, targetBody: true, isFeint: false, delayAfter: 0.15 },
            { punch: rng.chance(0.5) ? "leftUppercut" : "rightUppercut", targetBody: true, isFeint: false, delayAfter: 0.16 },
            { punch: "cross", targetBody: false, isFeint: false, delayAfter: 0.15 },
          ];
      return { type: "combo", combo: { steps }, targetBody: steps[0].targetBody };
    }
    const combo = generateCombo(brain, dist, doBody);
    return { type: "combo", combo, targetBody: doBody };
  }

  return executeFallbackSingle(brain, dist, doBody, player, myFrac, playerWhiffsShort);
}

function executeFallbackSingle(brain: AiBrainState, dist: number, wantBody: boolean, player: FighterState, myFrac: number, playerWhiffsShort: number): AttackAction {
  const dx = player.x > 0 ? 1 : -1;
  const jabDoctrine = computeJabDoctrine(brain);
  const clean = brain.personality.cleanHitsOverVolume;
  const crossBias = brain.styleCrossHeavy;
  let punch: PunchType;

  const playerDucked = player.defenseState === "duck";
  if (playerDucked && brain.styleAntiDuckUppercut > 0.2 && rng.chance(brain.styleAntiDuckUppercut * 0.7 * brain.adaptationRate)) {
    const r = rng.next01();
    if (r < 0.45) punch = rng.chance(0.5) ? "leftUppercut" : "rightUppercut";
    else punch = rng.chance(0.5) ? "leftHook" : "rightHook";
    return { type: "punch", punch, targetBody: true };
  }

  const adaptJabFreq = getSlotValue(brain.adaptiveMemory, "jabFrequency");
  const adaptHookFreq = getSlotValue(brain.adaptiveMemory, "hookFrequency");
  const adaptCross = getSlotValue(brain.adaptiveMemory, "crossCounterBias");

  if (!wantBody) {
    const r = rng.next01();
    const jabP = lerp(0.35, 0.70, jabDoctrine) * lerp(1.0, 0.55, crossBias) + adaptJabFreq;
    const crossP = lerp(0.40, 0.55, 1 - jabDoctrine) + crossBias * 0.20 + adaptCross;

    if (dist > brain.idealRangeNeutral + blocksToPixels(0.1)) {
      if (rng.chance(brain.styleJabSetup) && crossBias > 0.4) {
        punch = "jab";
      } else {
        punch = r < jabP ? "jab" : "cross";
      }
    } else {
      if (r < jabP) punch = "jab";
      else if (r < jabP + crossP) punch = "cross";
      else {
        if (clean > 0.60 && dist > blocksToPixels(0.80)) punch = "cross";
        else if (rng.chance(0.5 + adaptHookFreq)) punch = rng.chance(0.5) ? "leftHook" : "rightHook";
        else punch = "cross";
      }
    }
  } else {
    const r = rng.next01();
    if (crossBias > 0.4) {
      if (r < crossBias) punch = "cross";
      else if (r < crossBias + 0.20) punch = rng.chance(0.5) ? "leftUppercut" : "rightUppercut";
      else punch = rng.chance(0.5) ? "leftHook" : "rightHook";
    } else if (clean > 0.60 && dist > blocksToPixels(0.85)) {
      punch = rng.chance(0.5) ? "leftHook" : "rightHook";
    } else {
      if (r < 0.45) punch = rng.chance(0.5) ? "leftHook" : "rightHook";
      else if (r < 0.85) punch = rng.chance(0.5) ? "leftUppercut" : "rightUppercut";
      else punch = rng.chance(0.5) ? "jab" : "cross";
    }
  }

  // Difficulty-scaled uppercut frequency boost (head punches only; body punches already have their own selection)
  if (!wantBody) {
    const upperBoost = brain.difficultyBand === "Hardcore" ? (brain.isSparring ? 0.22 : 0.20) :
      brain.difficultyBand === "Hard" ? 0.12 :
      brain.difficultyBand === "Medium" ? 0.15 : 0;
    if (upperBoost > 0 && punch !== "leftUppercut" && punch !== "rightUppercut" && rng.chance(upperBoost)) {
      punch = rng.chance(0.5) ? "leftUppercut" : "rightUppercut";
    }
  }

  const adaptCharged = getSlotValue(brain.adaptiveMemory, "chargedPunchResponse");
  const adaptPowerCommit = getSlotValue(brain.adaptiveMemory, "powerPunchCommit");
  let wantCharge = false;
  if ((brain.styleChargedPunchUsage + adaptCharged) > 0.15 && myFrac > 0.35) {
    const chargeCandidate = (punch === "cross" || punch === "leftHook" || punch === "rightHook");
    const goodOpportunity = brain.playerGuardDropTimer > 0.5 || playerWhiffsShort >= 2 || brain.currentPhase === "WhiffPunish";
    if (chargeCandidate && goodOpportunity && rng.chance(brain.styleChargedPunchUsage + adaptCharged + adaptPowerCommit * 0.5)) {
      wantCharge = true;
    }
  }

  const adaptFeint = getSlotValue(brain.adaptiveMemory, "feintBeforeAttack");
  let feintChance = clamp01(brain.personality.feintiness);
  if (brain.currentPhase === "Download") feintChance *= 1.35;
  if (brain.currentPhase === "Probe") feintChance *= 1.15;
  if (brain.currentPhase === "Finish") feintChance *= 0.55;
  if (brain.currentPhase === "Counter") feintChance *= 1.10;
  if (brain.difficultyBand === "Easy") feintChance *= 0.80;
  if (brain.difficultyBand === "Hard") feintChance *= 1.10;
  if (brain.difficultyBand === "Hardcore") feintChance *= 1.18;
  feintChance = clamp01(feintChance + clean * 0.12 + adaptFeint);

  const doFeint = !wantCharge && rng.chance(feintChance);

  return { type: doFeint ? "feint" : "punch", punch, targetBody: wantBody, wantCharge };
}

interface DefenseDecision {
  wantGuard: boolean;
  wantHigh: boolean;
  wantLow: boolean;
  wantDuck: boolean;
}

// ===== DEFENSE DECISIONS =====

function thinkDefense(brain: AiBrainState, enemy: FighterState, player: FighterState): DefenseDecision {
  const result: DefenseDecision = { wantGuard: false, wantHigh: false, wantLow: false, wantDuck: false };

  if (brain.survivalModeActive) {
    const dist = getDistancePx(enemy, player);
    const inRange = dist <= brain.attackRangeMax * 1.2;

    let duckChance: number;
    switch (brain.difficultyBand) {
      case "Hardcore": duckChance = 0.35; break;
      case "Hard": duckChance = 0.28; break;
      case "Medium": duckChance = 0.18; break;
      default: duckChance = 0.10; break;
    }
    if (player.isPunching) duckChance *= 1.5;

    if (inRange && rng.chance(duckChance)) {
      result.wantDuck = true;
      return result;
    }

    // The bands that counter out of survival only put the gloves up while
    // something is actually coming at them. Guarding every single tick on low
    // stamina is what turned a bad patch into a shut-out round: the attack
    // layer never got a look in, because defence had already returned.
    const fightsOut = (SURVIVAL_COUNTER_CHANCE[brain.difficultyBand] ?? 0) >= 0.5;
    if (fightsOut && !player.isPunching && !player.chargeArmed) return result;

    result.wantGuard = true;
    result.wantHigh = true;
    return result;
  }
  if (brain.perfectReactActive && (brain.forcedGuard || brain.forcedDuck)) return result;

  if (brain.playerIdleTime > 1.5 || brain.playerCornerCamping) {
    return result;
  }

  const myFrac = getMyStaminaFrac(enemy);
  const theirFrac = getPlayerStaminaFrac(player);
  const dist = getDistancePx(enemy, player);
  const playerAgg = getPlayerAggression(brain.dataBank, 5, brain.gameTime);

  const adaptDuck = getSlotValue(brain.adaptiveMemory, "duckApproachBias");
  const adaptGuardVsDodge = getSlotValue(brain.adaptiveMemory, "guardVsDodgePref");
  const duckApproach = brain.styleDuckApproach + adaptDuck;
  const isApproaching = brain.engageCyclePhase === "in" || brain.currentState === "Approach";
  if (isApproaching && brain.playerIdleTime < 0.5 && rng.chance(duckApproach)) {
    result.wantDuck = true;
    return result;
  }

  if (duckApproach > 0.3 && dist < brain.styleIdealResetDist && dist > brain.styleIdealEngageDist && brain.playerIdleTime < 0.5) {
    if (rng.chance(duckApproach * 0.6)) {
      result.wantDuck = true;
      return result;
    }
  }

  const last3 = getLastHits(brain.dataBank, "player", 3);
  const playerHeadHeavy = last3.headHits >= 2;
  const playerBodyHeavy = last3.bodyHits >= 2;
  const tired = myFrac < LOW_STAMINA_FRAC && theirFrac > PLAYER_FINISH_FRAC;

  const adaptGuard = getSlotValue(brain.adaptiveMemory, "guardParanoiaBias");
  const adaptDefDisc = getSlotValue(brain.adaptiveMemory, "defenseDisciplineBias");

  let guardNeed = (tired ? 0.55 : 0.20) +
    clamp01(playerAgg) * 0.45 +
    clamp01(brain.personality.guardParanoia + adaptGuard) * 0.35 +
    (brain.styleDefenseDiscipline + adaptDefDisc) * 0.25;

  if (brain.playerIdleTime > 0.5) {
    const idleSuppression = Math.min(brain.playerIdleTime - 0.5, 2.0) / 2.0;
    guardNeed *= lerp(1.0, 0.05, idleSuppression);
  }

  guardNeed *= lerp(1.0, 0.55, duckApproach);

  if (brain.styleDefenseDiscipline > 0.4 && dist < brain.attackRangeMax * 1.3 && brain.playerIdleTime < 0.5) {
    guardNeed = Math.max(guardNeed, brain.styleDefenseDiscipline * 0.5);
  }

  if (brain.currentPhase === "Counter") guardNeed += 0.08;
  if (brain.currentPhase === "Panic") guardNeed += 0.25;
  if (brain.currentPhase === "Finish") guardNeed -= 0.10;
  if (dist < TOO_CLOSE_RANGE_PX) guardNeed += 0.10;
  guardNeed = clamp01(guardNeed + brain.personality.cleanHitsOverVolume * 0.10 + adaptGuardVsDodge);

  // Post-exchange discipline: keep the hands up for a beat after any exchange instead
  // of instantly relaxing (scaled by profile + difficulty intensity).
  if (brain.gameTime < brain.postExchangeGuardUntil) {
    guardNeed = clamp01(Math.max(guardNeed, 0.30 + brain.offense.postExchangeDiscipline * brain.execIntensity * 0.55));
  }

  result.wantGuard = rng.chance(guardNeed);

  if (result.wantGuard) {
    const bodyAdapt = brain.styleBodyDefenseAdapt;
    const playerBodyHeavyAdapt = brain.playerBodyAttackRatio > 0.6 && bodyAdapt > 0.2 && rng.chance(brain.adaptationRate);

    if (playerBodyHeavy || playerBodyHeavyAdapt) {
      result.wantLow = true;
      if (playerBodyHeavyAdapt && rng.chance(bodyAdapt * 0.6)) {
        result.wantLow = true;
        result.wantHigh = false;
      }
    }
    else if (playerHeadHeavy) result.wantHigh = true;
    else {
      if (dist < TOO_CLOSE_RANGE_PX) result.wantLow = true;
      else result.wantHigh = true;
    }

    const jiggle = rng.next01();
    if (jiggle < 0.10) { result.wantHigh = true; result.wantLow = false; }
    else if (jiggle < 0.20) { result.wantLow = true; result.wantHigh = false; }
  }

  // Pattern defense: slip under detected body spam and prime an over-the-top counter
  if (brain.gameTime < brain.bodySpamDuckUntil && rng.chance(brain.offense.bodySpamCounter * brain.execIntensity * 0.8)) {
    result.wantDuck = true;
    result.wantGuard = false;
    brain.bodySpamCounterReadyUntil = brain.gameTime + 0.9;
    return result;
  }
  // Head-spam rhythm read: timed duck around the player's predicted next punch
  if (brain.headSpamDuckUntil > 0 && brain.gameTime > brain.headSpamDuckUntil - 0.45 && brain.gameTime < brain.headSpamDuckUntil) {
    result.wantDuck = true;
    result.wantGuard = false;
    return result;
  }

  if (brain.currentPhase === "BodyHunt") result.wantDuck = true;
  else if (result.wantGuard && result.wantLow && playerAgg > 0.35) {
    result.wantDuck = rng.chance(0.35);
  }
  if (brain.currentPhase === "Counter") result.wantDuck = false;

  if (brain.playerBodyAttackRatio > 0.65 && brain.styleBodyDefenseAdapt > 0.3 && rng.chance(brain.adaptationRate)) {
    if (result.wantDuck && rng.chance(brain.styleBodyDefenseAdapt * 0.5)) {
      result.wantDuck = false;
      result.wantGuard = true;
      result.wantLow = true;
    }
  }

  const isChamp = brain.difficultyBand === "Hardcore" || brain.difficultyBand === "Hard";
  if (isChamp) {
    const uppercutCount = (brain.playerLandedPunchCounts["leftUppercut"] || 0) + (brain.playerLandedPunchCounts["rightUppercut"] || 0);
    if (uppercutCount >= 2 && result.wantDuck && rng.chance(brain.adaptationRate * 0.7)) {
      result.wantDuck = false;
      result.wantGuard = true;
      result.wantLow = true;
    }

    if (player.defenseState === "duck" && result.wantGuard) {
      result.wantLow = true;
      result.wantHigh = false;
    }

    if (player.isPunching && player.currentPunch) {
      const isBodyPunch = player.currentPunch === "leftUppercut" || player.currentPunch === "rightUppercut";
      if (isBodyPunch && result.wantGuard && rng.chance(brain.adaptationRate)) {
        result.wantLow = true;
        result.wantHigh = false;
        result.wantDuck = false;
      }
    }
  }

  return result;
}

function applyDefenseDecision(decision: DefenseDecision, enemy: FighterState): void {
  if (enemy.stunBlockDisableTimer > 0) {
    enemy.defenseState = "none";
    return;
  }
  if (decision.wantDuck) {
    enemy.defenseState = "duck";
    enemy.duckTimer = 0.3;
  } else if (decision.wantGuard) {
    enemy.defenseState = "fullGuard";
  } else {
    enemy.defenseState = "none";
  }
}

// ===== Execution layer tracking (per-fighter offense/defense profile) =====
function updateExecutionLayerTracking(brain: AiBrainState, enemy: FighterState, player: FighterState, dt: number): void {
  if (brain.bodyCampaignCooldown > 0) brain.bodyCampaignCooldown -= dt;
  if (brain.chargedAmbushCooldown > 0) brain.chargedAmbushCooldown -= dt;

  // Campaign ran its planned duration → flag the upstairs cash-in; hard-expire if never cashed
  if (brain.bodyCampaignActive && !brain.bodyCampaignCashIn && brain.gameTime >= brain.bodyCampaignUntil) {
    brain.bodyCampaignCashIn = true;
  }
  if (brain.bodyCampaignActive && brain.gameTime >= brain.bodyCampaignUntil + 2.5) {
    brain.bodyCampaignActive = false;
    brain.bodyCampaignCashIn = false;
    brain.bodyCampaignCooldown = 8 + rng.next01() * 6;
  }

  // Head-spam rhythm read: log player punch-start intervals; a low-variance cadence from a
  // head-heavy player is predictable → schedule a timed duck around the next expected punch.
  if (player.isPunching && brain.gameTime - brain.headSpamLastPunchTime > 0.2) {
    const interval = brain.gameTime - brain.headSpamLastPunchTime;
    brain.headSpamLastPunchTime = brain.gameTime;
    if (interval < 3.0) {
      brain.headSpamIntervals.push(interval);
      if (brain.headSpamIntervals.length > 6) brain.headSpamIntervals.shift();
    } else {
      brain.headSpamIntervals.length = 0;
    }
    const iv = brain.headSpamIntervals;
    const headHeavy = brain.playerHeadAttackCount >= 4 && brain.playerHeadAttackCount >= brain.playerBodyAttackCount * 2;
    if (iv.length >= 4 && headHeavy) {
      const mean = iv.reduce((a, b) => a + b, 0) / iv.length;
      const variance = iv.reduce((a, b) => a + (b - mean) * (b - mean), 0) / iv.length;
      if (variance < 0.045 && rng.chance(brain.offense.headRhythmRead * brain.execIntensity * 0.6)) {
        brain.headSpamDuckUntil = brain.gameTime + mean + 0.2;
      }
    }
  }

  // Body-spam detection: recent player hits mostly downstairs → open a duck-under window
  if (brain.gameTime >= brain.bodySpamDuckUntil) {
    const last4 = getLastHits(brain.dataBank, "player", 4);
    if (last4.bodyHits >= 3 && rng.chance(clamp01(brain.offense.bodySpamCounter * brain.execIntensity * 2.0) * dt)) {
      brain.bodySpamDuckUntil = brain.gameTime + 0.8;
    }
  }
}

function updateComboRunner(brain: AiBrainState, enemy: FighterState, dt: number): PunchType | null {
  if (!brain.comboActive) return null;
  if (brain.comboStepIndex >= brain.comboSteps.length) {
    brain.comboActive = false;
    brain.comboChaseActive = false;
    brain.comboCooldown = lerp(0.013, 0.053, rng.next01());
    // Pressure follow-up: stay inside and go again instead of resetting to the outside.
    if (brain.pressureActive) {
      if (brain.pressureFollowupsLeft > 0) {
        brain.pressureFollowupsLeft--;
        brain.pressureUntil = brain.gameTime + 1.6;
      } else {
        endPressure(brain);
      }
    }
    return null;
  }

  brain.comboStepTimer -= dt;
  if (brain.comboStepTimer > 0) return null;

  const step = brain.comboSteps[brain.comboStepIndex];

  if (enemy.stamina <= 0 || enemy.isKnockedDown) {
    brain.comboActive = false;
    brain.comboChaseActive = false;
    return null;
  }

  brain.comboStepIndex++;
  if (brain.comboStepIndex < brain.comboSteps.length) {
    brain.comboStepTimer = brain.comboSteps[brain.comboStepIndex - 1].delayAfter;
  }

  return step.punch;
}

function updateScorecard(brain: AiBrainState, state: GameState, isPlayerAI: boolean = false): void {
  if (state.roundScores.length === 0) {
    brain.scorecardBias = 0;
    return;
  }

  let playerTotal = 0, enemyTotal = 0;
  for (const round of state.roundScores) {
    playerTotal += round.player;
    enemyTotal += round.enemy;
  }

  if (playerTotal + enemyTotal === 0) {
    brain.scorecardBias = 0;
    return;
  }

  const diff = isPlayerAI ? (playerTotal - enemyTotal) : (enemyTotal - playerTotal);
  brain.scorecardBias = clamp(diff / Math.max(1, playerTotal + enemyTotal), -1, 1);
}

/**
 * How badly the AI is losing the punch count *this round*.
 *
 * Deliberately separate from the scorecard: judges weigh damage and knockdowns
 * too, so a fighter can be level on the cards while being comprehensively
 * out-worked. Being out-worked is what should push a scripted sequence toward
 * throwing, so this reads landed punches and nothing else. Held at zero until
 * enough punches have landed for the comparison to mean anything.
 */
function updatePunchDeficit(brain: AiBrainState, state: GameState, isPlayerAI: boolean): void {
  const s = state.roundStats;
  const mine = isPlayerAI ? s.playerLandedThisRound : s.enemyLandedThisRound;
  const theirs = isPlayerAI ? s.enemyLandedThisRound : s.playerLandedThisRound;
  const total = mine + theirs;
  brain.punchDeficit =
    total >= AGGRESSION_DEFICIT_MIN_SAMPLE && theirs > mine
      ? clamp((theirs - mine) / total, 0, 1)
      : 0;
}

/**
 * Situational read handed to the string selector. Everything here is already
 * tracked by the brain; the selector just wants it in one place.
 */
/**
 * The GameState updateAI is currently running for. buildStringContext has no
 * state parameter and six callers; the RL observation is the only thing that
 * needs the ring and the clock, so it reads them from here.
 */
let rlObsState: GameState | null = null;

function buildStringContext(
  brain: AiBrainState,
  enemy: FighterState,
  player: FighterState,
): StringSelectContext {
  const oppStam = getPlayerStaminaFrac(player);
  // "Hurt" is what opens the finishing categories, so it is deliberately broad:
  // down, stun-locked out of punching or blocking, or badly gassed.
  const oppHurt =
    player.isKnockedDown ||
    player.stunPunchDisableTimer > 0 ||
    player.stunBlockDisableTimer > 0 ||
    oppStam < 0.22;
  const blockSync = computeBlockSync(brain, enemy, player);
  return {
    // Only built for a brain carrying a policy; its presence routes selection.
    rlObs: brain.rl && brain.rl.policy ? buildRlObservation(rlObsState, enemy, player, brain) : null,
    canArmCharge: !enemy.chargeArmed && enemy.chargeMeterBars >= 1,
    blockSyncReady: blockSync.ready,
    blockSyncArmNow: blockSync.armNow,
    blockSyncMaxWait: BLOCK_SYNC_MAX_WAIT,
    // Only the bands whose reflex layer already yields to their own offence take
    // a defensive beat mid-string. Below that, arming inside a string trips the
    // reflex cancel below and the string dies instead of resuming.
    blockSyncInString: REFLEX_YIELDS_TO_ASSAULT[brain.difficultyBand] === true,
    distPx: getDistancePx(enemy, player),
    attackRangePx: brain.attackRangeMax,
    hitRangePx: getMaxPunchThrowDistPx(brain.difficultyBand),
    myStaminaFrac: getMyStaminaFrac(enemy),
    oppStaminaFrac: oppStam,
    oppHurt,
    survival: brain.survivalModeActive || brain.currentPhase === "Panic",
    scoreLead: brain.scorecardBias,
    punchDeficit: brain.punchDeficit ?? 0,
    difficultyScore: brain.difficultyScore,
    // "There is someone to hit and gas to hit them with." This is what lets the
    // runner cut out of a defensive string the moment offence is back on.
    attackIntent:
      getDistancePx(enemy, player) <= brain.attackRangeMax * 1.10 &&
      getMyStaminaFrac(enemy) > 0.12
        ? 1
        : 0,
  };
}

/**
 * The single door offence goes through.
 *
 * Every situational read that used to throw a punch of its own — the
 * charge-respect stab, the post-feint follow-up, the duck-punish — now calls
 * this instead. The read still decides *when* to attack and still sets the
 * body/head aim first; the string decides *what* comes out. Returns false when
 * a string is already running or nothing was eligible, in which case the
 * caller must not fall back to a direct punch.
 */
function startStringForOffense(
  brain: AiBrainState,
  enemy: FighterState,
  player: FighterState,
  roles: readonly AiStringRole[] = ["offense", "mixed"],
): boolean {
  const rt = ensureAiStringRuntime(brain);
  if (rt.active) return false;
  const def = selectAiString(brain, buildStringContext(brain, enemy, player), roles);
  if (!def) return false;
  startAiString(brain, def);
  // A queued duck-punish would sit armed behind the string and fire against a
  // read that has long since gone stale.
  brain.preDuckUppercutActive = false;
  brain.preDuckUppercutQueue = [];
  return true;
}

/**
 * Perform an RL utility that isn't a segment. 1 = Reset (only where Reset is
 * allowed and not already running — the player may re-press mid-snap, the AI
 * doesn't; tryReset still refuses during a stun lock). 3 = slip, with
 * the string held until the slide lands so its first punch is the counter.
 */
function performRlUtility(
  utility: number,
  brain: AiBrainState,
  enemy: FighterState,
  state: GameState,
  rt: ReturnType<typeof ensureAiStringRuntime>,
): void {
  let applied = false;
  if (utility === 1) {
    applied = aiResetAllowed(state) && !enemy.fatigue?.resetActive && tryReset(enemy, state);
  } else if (utility === 3) {
    if (!enemy.slipActive && enemy.slipDisabledTimer <= 0 && !enemy.isKnockedDown && !enemy.isPunching) {
      const dir: SlipDir = rng.next01() < 0.5 ? "left" : "right";
      startSlip(enemy, dir);
      if (enemy.slipActive) {
        enemy.slipHoldTimer = AI_SLIP_HOLD;
        rt.beatTimer = Math.max(rt.beatTimer, enemy.slipEnterDuration || 0);
        applied = true;
      }
    }
  }
  settleAiRlUtility(brain, applied);
}

// ===== MAIN AI UPDATE LOOP =====

export function updateAI(state: GameState, dt: number, attemptPunchFn: (fighter: FighterState, punchType: PunchType, isFeint?: boolean, isCharged?: boolean) => boolean, isPlayerAI: boolean = false): void {
  const brain = isPlayerAI ? state.playerAiBrain : state.aiBrain;
  if (!brain) return;

  // Idempotent: HMR keeps live brains, which predate this field.
  if (typeof brain.punchDeficit !== "number") brain.punchDeficit = 0;
  if (typeof brain.resetRollTimer !== "number") brain.resetRollTimer = 0;

  // Backfill for the reach-gate / range-whiff learning fields. Idempotent.
  if (brain.rangeWhiffDeficits === undefined) {
    brain.rangeWhiffDeficits = [];
    brain.rangeLearnClosePx = 0;
    brain.rangeCloseIntentTimer = 0;
    brain.lastRangeWhiffPunch = null;
  }
  if (brain.rangeCloseIntentTimer > 0) {
    brain.rangeCloseIntentTimer = Math.max(0, brain.rangeCloseIntentTimer - dt);
  }

  // String-engine state. HMR keeps live brains across a reload and saved states
  // predate the feature entirely, so this is idempotent and runs before anything
  // reads brain.strings.
  ensureAiStringRuntime(brain);
  // RL policy state: same story. null means the weighted chooser.
  ensureAiRlState(brain);
  rlObsState = state;

  // Situation-driven fundamental switching. Idempotent: HMR keeps live brains,
  // and any brain built before this existed has none of these fields.
  if (brain.situationReadAcc === undefined) {
    brain.situationReadAcc = 0;
    brain.situationTracker = null;
    brain.activeFundKey = null;
  }
  updateFundamentalSwitch(brain, dt,
    isPlayerAI ? state.player : state.enemy,
    isPlayerAI ? state.enemy : state.player);


  // Reach gate: a punch is only thrown if it can physically land from here. The
  // decision layer reasons in attackRangeMax multiples, which are far looser than
  // the real hit range — especially for hooks and uppercuts, the shortest punches
  // in the game. Rejected attempts are sampled as range whiffs so the AI closes.
  const rawAttemptPunch = attemptPunchFn;
  attemptPunchFn = (fighter: FighterState, punchType: PunchType, isFeint?: boolean, isCharged?: boolean): boolean => {
    // Feints are meant to be thrown short — they bait, they never score.
    if (!isFeint) {
      const target = fighter.isPlayer ? state.enemy : state.player;
      if (target) {
        const dist = getDistancePx(fighter, target);
        const reach = getPunchReachPx(fighter, punchType) + AI_PUNCH_REACH_MARGIN_PX;
        if (dist > reach) {
          notifyAiRangeWhiff(brain, punchType, dist - reach);
          return false;
        }
      }
    }
    return rawAttemptPunch(fighter, punchType, isFeint, isCharged);
  };

  // Defensive backfill for brains created before the execution layer existed
  // (hot-reload survivors, deserialized states). Idempotent.
  if (!brain.offense) {
    brain.offense = generateFallbackOffenseProfile(brain.archetype, 12345);
    brain.execIntensity = brain.difficultyBand === "Easy" ? 0.25 : brain.difficultyBand === "Medium" ? 0.55 : brain.difficultyBand === "Hard" ? 0.80 : 1.0;
    brain.bodyCampaignActive = false;
    brain.bodyCampaignUntil = 0;
    brain.bodyCampaignCooldown = 0;
    brain.bodyCampaignCashIn = false;
    brain.chargedAmbushCooldown = 5;
    brain.lastLandedPunchType = null;
    brain.lastLandedPunchTime = 0;
    brain.postExchangeGuardUntil = 0;
    brain.headSpamLastPunchTime = 0;
    brain.headSpamIntervals = [];
    brain.headSpamDuckUntil = 0;
    brain.bodySpamDuckUntil = 0;
    brain.bodySpamCounterReadyUntil = 0;
  }

  // Backfill for the pressure-offense / anticipatory-block layer. Idempotent; keeps
  // hot-reloaded and deserialized brains from crashing on the new fields.
  if (brain.anticipationChance === undefined) {
    brain.perfectBlockHoldTimer = 0;
    brain.perfectBlockHoldMs = 300;
    brain.careerRank = null;
    brain.perfectBlockIntent01 = PB_INTENT_NEUTRAL;
    brain.anticipationChance = computeAnticipationBaseChance(brain.difficultyBand, null);
    brain.nextAnticipationTime = 0;
    brain.anticipationArmed = false;
    brain.timingAdjustLocked = false;
    brain.playerCloseEvents = 0;
    brain.playerCloseAndFireEvents = 0;
    brain.playerCloseWatchActive = false;
    brain.playerCloseWatchUntil = 0;
    brain.playerDistSampleTimer = 0;
    brain.playerDistSampleLast = -1;
    brain.playerPrevPunching = false;
    brain.playerPunchRegistered = false;
    brain.playerFeintRolled = false;
    brain.playerBurstPunches = 0;
    brain.playerBurstStartTime = 0;
    brain.playerBurstLastPunchTime = -99;
    brain.playerBurstHistory = [];
    brain.pressureActive = false;
    brain.pressureUntil = 0;
    brain.pressureCooldown = 0;
    brain.pressureFollowupsLeft = 0;
    brain.pressureCounterWindowUntil = 0;
  }
  if (brain.comboChaseChance === undefined) {
    brain.comboChaseChance = COMBO_CHASE_BASE_CHANCE;
    brain.comboChaseActive = false;
    brain.comboChaseAdaptTimer = 0;
  }
  // HMR-surviving brains predate the charge-respect cooldown; backfill it.
  if (brain.chargeRespectCooldown === undefined) brain.chargeRespectCooldown = 0;
  // Fight-to-win layer. Same reason: HMR keeps live brains across a reload and
  // brains built before this layer existed have none of these fields.
  if (typeof brain.playerStandWindow !== "number") {
    brain.playerStandWindow = 0;
    brain.playerDuckWindow = 0;
    brain.adaptiveBodyBias = AI_BODY_BIAS_BASE;
  }
  if (typeof brain.powerSwayWaitTimer !== "number") {
    brain.powerSwayWaitTimer = 0;
    brain.powerSwayRollCooldown = 0;
    brain.lastThrowSwayLevel = 0;
    brain.lastThrowInPowerSway = false;
  }
  if (!brain.swayLevelThrows) brain.swayLevelThrows = {};
  if (!brain.swayLevelLanded) brain.swayLevelLanded = {};
  if (typeof brain.rhythmSwayAdapt01 !== "number") brain.rhythmSwayAdapt01 = 0;
  if (!brain.playerPunchTimes) brain.playerPunchTimes = [];
  if (!brain.playerLandRanges) brain.playerLandRanges = [];
  if (typeof brain.playerPunchIntervalAvg !== "number") {
    brain.playerPunchIntervalAvg = 0;
    brain.playerPunchIntervalCount = 0;
    brain.playerJabFlightSec = 0;
    brain.playerLandRangeAvg = 0;
    brain.lastKnownDistPx = 0;
  }
  if (typeof brain.pbTimingLearntMs !== "number") {
    brain.pbTimingLearntMs = 0;
    brain.pbSyncMissOffsetMs = 0;
    brain.pbSyncActive = false;
    brain.pbSyncFromString = false;
    brain.pbSyncPrevPunching = false;
    brain.pbSyncPredictedImpact = 0;
    brain.pbSyncCooldownUntil = 0;
    brain.pbSyncRolledFor = -1;
    brain.pbSyncRollPassed = false;
    brain.pbSyncExpiresAt = 0;
    brain.pbSyncPendingResolve = 0;
    brain.pbSyncPendingAt = 0;
    brain.statBlockSyncArmed = 0;
    brain.statBlockSyncLanded = 0;
  }
  if (typeof brain.statPunchesThrown !== "number") {
    brain.statPunchesThrown = 0;
    brain.statBodyPunchesThrown = 0;
    brain.statPowerSwayThrows = 0;
    brain.statPowerSwayLanded = 0;
    brain.statOffenseSuppressedTicks = 0;
    brain.statReflexHeldOffTicks = 0;
    brain.statInRangeTime = 0;
  }
  if (typeof brain.statGasPullouts !== "number") {
    brain.gasHoldActive = false;
    brain.statGasPullouts = 0;
    brain.statGasHoldSec = 0;
  }
  if (typeof brain.baseDefStepPhase !== "number") {
    brain.baseDefStepPhase = 0;
    brain.baseDefStepRemainingPx = 0;
    brain.baseDefStepOutX = 0;
    brain.baseDefStepOutZ = 0;
    brain.baseDefStepTimer = 0;
  }
  // Rhythm Attacking. Same reason as every guard above: HMR keeps live brains
  // across a reload, and the menu background fight runs on one of them, so a
  // brain built before this layer existed reaches the sequence checks with the
  // whole block undefined.
  if (typeof brain.raPunchesLeft !== "number") {
    brain.raActive = false;
    brain.raPaused = false;
    brain.raPunchesLeft = 0;
    brain.raSeqBudget = 0;
    brain.raPerfectBlocks = 0;
    brain.raAvoided = 0;
    brain.raCutStreak = 0;
    brain.raStunTriggerUsed = false;
    brain.statRaSequences = 0;
    brain.statRaChains = 0;
    rollRhythmAttackTolerances(brain);
  }

  const enemy = isPlayerAI ? state.player : state.enemy;
  const player = isPlayerAI ? state.enemy : state.player;

  {
    const innerAttemptPunchFn = attemptPunchFn;
    const maxThrowDist = getMaxPunchThrowDistPx(brain.difficultyBand);
    attemptPunchFn = (fighter, punchType, isFeint, isCharged) => {
      if (getDistancePx(enemy, player) > maxThrowDist) return false;
      // Gassed: veto every real throw, whatever path asked for it, until the
      // burst window lapses. Feints are exempt because the engine excludes them
      // from the burst count entirely, so the AI can keep selling shots it is
      // not paying for. Returning false is the existing refuse handshake, so
      // callers unwind the same way they do for an out-of-range throw.
      if (!isFeint && isAiGasHeld(brain, enemy)) return false;
      return innerAttemptPunchFn(fighter, punchType, isFeint, isCharged);
    };
  }

  {
    // Rhythm Attacking, ending 3. The budget is spent on punches the engine
    // actually accepted, never on ones merely requested: the reach gate and the
    // gas veto above both refuse throws, and counting a refusal would drain a
    // whole sequence without a punch ever being thrown. Wrapping last means this
    // sees the final verdict from every gate, and sitting on attemptPunchFn
    // covers every offence path at once -- strings, combos and the situational
    // reads -- rather than needing a decrement at each throw site.
    const beforeBudget = attemptPunchFn;
    attemptPunchFn = (fighter, punchType, isFeint, isCharged) => {
      const thrown = beforeBudget(fighter, punchType, isFeint, isCharged);
      // Feints cost nothing here: a feint is not the aggression, it sets it up.
      if (thrown && !isFeint) notifyAiPunchThrown(brain);
      return thrown;
    };
  }

  if (enemy.isKnockedDown || state.knockdownActive || state.phase !== "fighting") {
    // A held perfect block must not survive a knockdown or the between-rounds gap
    if (brain.perfectBlockHoldTimer > 0 || enemy.perfectBlockActive) resetAiPerfectBlockHold(brain, enemy);
    // Nor may an aggression sequence: ending 4 is a knockdown, and this also
    // catches the bell and every other non-fighting phase.
    cancelRhythmAttack(brain);
    // Neither may a string: its duck/block hold would otherwise carry through the
    // bell and leave the AI crouched at the start of the next round.
    cancelAiString(brain, enemy, false);
    // Nor a base-defense step: nothing moves during a count or between rounds,
    // so a half-finished out-and-back must not resume on the other side of it.
    cancelAiBaseDefenseStep(brain);
    return;
  }

  if (state.practiceMode && !isPlayerAI) {
    if (!state.cpuAttacksEnabled) {
      attemptPunchFn = () => false;
    }
    if (!state.cpuDefenseEnabled) {
      enemy.defenseState = "none";
      enemy.handsDown = true;
    }
  }

  brain.gameTime += dt;

  // Reset (b) once gassed. Only reached on a live fighting tick — the knockdown
  // and non-fighting return above already sits between this and the bell — so
  // the roll cannot fire during a count or between rounds. tryReset does the
  // rest of the refusing and charges the panic penalty for resetting while
  // still rocked, exactly as it does when the player presses the key.
  brain.resetRollTimer += dt;
  // Ordinary sparring and Nightmare are the two rooms where the partner never
  // resets — same gate the stunned/crit Reset uses, so the two cannot drift.
  if (brain.resetRollTimer >= AI_RESET_ROLL_INTERVAL && aiResetAllowed(state)) {
    brain.resetRollTimer -= AI_RESET_ROLL_INTERVAL;
    const fat = enemy.fatigue;
    // A Reset can't be spent while one is already running (even one a punch
    // has stripped); tryReset also refuses during a stun lockout.
    if (fat && fat.maxEnergy > 0 && !fat.resetActive) {
      const spentFrac = 1 - Math.max(0, Math.min(1, fat.energy / fat.maxEnergy));
      const resetChance = AI_RESET_CHANCE_BY_BAND[brain.difficultyBand] ?? AI_RESET_CHANCE_BY_BAND.Easy;
      if (spentFrac >= AI_RESET_FATIGUE_THRESHOLD && rng.chance(resetChance)) {
        tryReset(enemy, state);
      }
    }
  }

  // Pattern memory: the held-state actions (charge, body duck), the early
  // release of a scripted guard, and script expiry. Runs before the decision
  // layers so a counter armed this tick is the guard they see.
  updateAiPatternMemory(state, brain, enemy, player);
  drainPatternCounterPunch(brain, enemy, attemptPunchFn);
  const myFrac = getMyStaminaFrac(enemy);

  if (brain.reactionDelayTimer > 0) brain.reactionDelayTimer -= dt;
  brain.reactionDelayConsecutiveDecay += dt;
  if (brain.reactionDelayConsecutiveDecay > 1.5) {
    brain.reactionDelayConsecutiveHits = Math.max(0, brain.reactionDelayConsecutiveHits - 1);
    brain.reactionDelayConsecutiveDecay = 0;
  }

  trackStaminaHitsAndPatterns(brain, enemy, player);
  updateConditioning(brain, dt);
  updateSurvivalMode(brain, myFrac);
  updatePerfectReactionFade(brain, myFrac, dt);
  updateDirectionalBlockTimers(brain, player, dt);
  updateScorecard(brain, state, isPlayerAI);
  updatePunchDeficit(brain, state, isPlayerAI);
  updateComboChaseChance(brain, state, dt, isPlayerAI);
  updateEngageCycle(brain, dt);
  updateLateralDir(brain, dt);
  if (brain.hitReactRetreatTimer > 0) brain.hitReactRetreatTimer -= dt;
  reactToPlayerTelegraph(brain, enemy, player);
  updateDefenseCycling(brain, enemy, player, dt);
  updateAiDirectionalGuard(brain, enemy, player, dt);
  trackPlayerGuardDrop(brain, player, dt);
  trackPlayerDuckApproach(brain, enemy, player, dt);
  trackPlayerRetreat(brain, enemy, player, dt);
  trackPlayerSustainedDuck(brain, enemy, player, dt);
  trackPlayerDefenseSwitch(brain, player);
  trackPlayerApproach(brain, enemy, player);
  updatePlayerBodyRatio(brain);
  updatePlayerPostureWindow(brain, enemy, player, dt);
  trackPlayerPunchWindow(brain, enemy, player);
  flushBlockSyncResolve(brain);
  updateExecutionLayerTracking(brain, enemy, player, dt);
  rhythmCutTick(brain, enemy, player);
  checkPlayerRhythmRead(brain, enemy, player);
  updateAiOwnRhythm(brain, enemy, dt);
  runWhiffLearning(brain, dt);
  trackPlayerOffensePatterns(brain, enemy, player, dt);
  updateAiPerfectBlockHold(brain, enemy, player, dt);

  if (brain.pressureCooldown > 0) brain.pressureCooldown -= dt;
  if (brain.pressureActive && brain.gameTime > brain.pressureUntil) endPressure(brain);

  if (brain.comboCooldown > 0) brain.comboCooldown -= dt;

  if (brain.comboLimitTimer > 0) {
    brain.comboLimitTimer -= dt;
    if (brain.comboLimitTimer <= 0) {
      brain.comboLimitTimer = 0;
      brain.comboLimitMax = 0;
      brain.staminaPenaltyStreak = 0;
    }
  }
  if (brain.staminaPenaltyCooldown > 0) brain.staminaPenaltyCooldown -= dt;

  if (enemy.staminaPenaltyPending) {
    enemy.staminaPenaltyPending = false;
    const withinWindow = brain.comboLimitTimer > 0;
    brain.staminaPenaltyStreak = withinWindow ? brain.staminaPenaltyStreak + 1 : 0;
    const triggerChance = Math.min(1, 0.65 + brain.staminaPenaltyStreak * 0.10);
    if (rng.chance(triggerChance)) {
      // Overdrawing stamina should cost tempo, not the rest of the round. The
      // old blanket 10-25s combo cap with a 1-3s total offence blackout on top
      // silenced the AI for a third of a bout at every band, and the attack
      // gate below refuses to even think while that blackout runs.
      const _spBand = brain.difficultyBand;
      const _spBase = _spBand === "Hardcore" ? 4 : _spBand === "Hard" ? 7 : 10;
      const _spSpread = _spBand === "Hardcore" ? 4 : _spBand === "Hard" ? 8 : 15;
      const _spBlackout = _spBand === "Hardcore" ? 0.25 : _spBand === "Hard" ? 0.6 : _spBand === "Medium" ? 1.0 : 2.0;
      brain.comboLimitMax = rng.chance(0.5) ? 2 : 3;
      brain.comboLimitTimer = _spBase + rng.next01() * _spSpread;
      brain.staminaPenaltyCooldown = _spBlackout + rng.next01() * _spBlackout;
    }
  }

  updateGasHoldStats(brain, enemy, dt);
  updateRhythmAttackGas(brain, enemy, player);

  const facingToPlayer = player.x > enemy.x ? 1 : -1;
  enemy.facing = facingToPlayer as 1 | -1;

  if (brain.comboActive) {
    const comboPunch = updateComboRunner(brain, enemy, dt);
    if (comboPunch !== null) {
      const step = brain.comboSteps[brain.comboStepIndex - 1];
      if (step && step.targetBody) {
        enemy.defenseState = "duck";
        enemy.duckTimer = 0.15;
        enemy.punchAimsHead = false;
      } else {
        enemy.punchAimsHead = true;
      }
      attemptPunchFn(enemy, comboPunch, step?.isFeint || false, false);
    }
    applyComboChase(brain, enemy, player);
    applyMovement(brain, enemy, player, dt, state.ringLeft, state.ringRight, state.ringTop, state.ringBottom, state);
    return;
  }

  // ===== REFLEX LAYER =====
  // These used to own every tick unconditionally: a perfect react or an
  // anticipatory block re-asserted itself the moment the player threw and
  // cancelled whatever the AI was in the middle of, which is how a recorded
  // round ends with the AI at thirteen punches. From Elite up they now yield to
  // a live assault -- the answer to being punched while punching is to keep
  // punching. Deterministic by band rather than a per-tick roll, so it cannot
  // saturate at frame rate. Survival and an armed player charge are the two
  // things still worth eating a beat for.
  // A rhythm-attacking sequence buys the same right at every band, not just the
  // two that have it standing: "all offence" is meaningless if the reflex layer
  // still cancels the string every time the player throws. Survival and an armed
  // charge remain excluded -- a sequence must not walk the AI into a charged shot.
  const _assaultOwnsTick =
    (REFLEX_YIELDS_TO_ASSAULT[brain.difficultyBand] === true || isRhythmAttackDriving(brain)) &&
    isAiStringAssault(brain) &&
    !brain.survivalModeActive &&
    !player.chargeArmed;

  if (!_assaultOwnsTick) {
    // Defensive timing gets first refusal: it is a read, where the two below are
    // reactions, so letting a reaction fire first would waste the prediction.
    const _bsync = computeBlockSync(brain, enemy, player);
    if (_bsync.armNow) armBlockSync(brain, enemy, player, false);
    tryAnticipatoryPerfectBlock(brain, enemy, player);
    tryPerfectReact(brain, enemy, player);
  } else {
    brain.statReflexHeldOffTicks = (brain.statReflexHeldOffTicks ?? 0) + 1;
  }
  // Always runs: this is also where an active react expires, so skipping it
  // during an assault would leave the flag latched on forever.
  applyPerfectReactionOverrides(brain, enemy, player, state.directionalPerfectBlock);

  // ===== STRING ENGINE =====
  // Strings are the AI's offence, and while one runs it owns the fighter's
  // actions. The reflex layer immediately above has already had its say this
  // tick -- if it fired, it interrupts the string rather than fighting it.
  {
    const _rt = ensureAiStringRuntime(brain);
    // A block the string armed itself is part of the string, not an
    // interruption of it: the beat resumes behind it.
    if (!brain.perfectReactActive) brain.pbSyncFromString = false;
    if (_rt.active && brain.perfectReactActive && !_assaultOwnsTick && !brain.pbSyncFromString) {
      cancelAiString(brain, enemy, false);
    }
    if (_rt.active) {
      // A Reset or slip-counter the RL policy wrapped this string in. Performed
      // here, before the runner's next boundary (which holds while one is
      // owed), through the same engine calls the AI's own Reset roll and
      // read-slip use; refused means standard. A slip waits out a punch still
      // in flight from the previous string rather than being refused by it.
      const _rlUtil = peekAiRlUtility(brain);
      if (_rlUtil !== 0 && !(_rlUtil === 3 && enemy.isPunching)) {
        takeAiRlUtility(brain);
        performRlUtility(_rlUtil, brain, enemy, state, _rt);
      }
      const _sctx = buildStringContext(brain, enemy, player);
      const _stick = updateAiStringRunner(brain, enemy, player, dt, _sctx);

      if (_stick.armPerfectBlock) armBlockSync(brain, enemy, player, true);

      if (_stick.armCharge && !enemy.chargeArmed && enemy.chargeMeterBars >= 1) {
        // Strings arm directly instead of going through aiChargeArmDelayTimer:
        // the notation means "charge now, release on the next beat", and that
        // deferred path's multi-second delay would outlive the whole string.
        enemy.chargeArmed = true;
        enemy.chargeUsesLeft = 2;
        enemy.chargeWhiffForgivenessLeft = enemy.technicianChargeWhiffForgiveness ?? 0;
        enemy.chargeFlashTimer = 0.15;
        enemy.chargeArmTimer = levelScale(enemy.level, 2, 4, "aiChargeArmTimer");
        // Retire any deferred request so the old flow cannot re-arm on top of
        // this one and hand back a fresh chargeUsesLeft after the string spends it.
        brain.aiChargeTargetBars = 0;
        brain.aiChargeArmDelayTimer = 0;
      }

      if (_stick.punch && isAiGasHeld(brain, enemy)) {
        // Hold the beat rather than refuse it: the wait ends on a known tick, and
        // spending retry budget at frame rate would cancel the string in half the
        // time the burst window takes to lapse. Cover up while it waits, so the
        // pause reads as a boxer catching his breath instead of an idle fighter.
        enemy.defenseState = "fullGuard";
        holdAiStringThrow(brain);
      } else if (_stick.punch && shouldWaitForPowerSway(brain, enemy, dt)) {
        // Hold the shot for a fraction of a beat so it leaves at the edge of the
        // AI's own weight transfer, where the engine already pays 1.5x damage
        // and half the telegraph. Held rather than refused: the wait ends on a
        // known tick, and spending retry budget at frame rate cancelled the
        // string long before the sway came round.
        holdAiStringThrow(brain);
      } else if (
        _stick.punch &&
        (enemy.isPunching || enemy.punchCooldown > 0 || enemy.telegraphIsLockout || enemy.miniStunTimer > 0)
      ) {
        // The engine would refuse this throw for a reason that clears on its own
        // — the previous punch is still in flight, cooling down, or locked out.
        // Offering it anyway burnt a retry every frame, so the string was
        // written off mid-sequence for doing nothing worse than punching.
        holdAiStringThrow(brain);
      } else if (_stick.punch) {
        // An explicit "(body)" in the notation wins; otherwise the AI's own
        // head/body read decides, so a string still varies its targeting.
        const _body = _stick.targetBody === true
          ? true
          : wantBodyWork(brain, _sctx.distPx, player.defenseState === "duck");
        if (_body) {
          enemy.defenseState = "duck";
          enemy.duckTimer = 0.15;
          enemy.punchAimsHead = false;
        } else {
          enemy.punchAimsHead = true;
        }
        const _thrown = attemptPunchFn(enemy, _stick.punch, false, _stick.useCharge);
        if (_thrown) recordAiThrow(brain, enemy, _body);
        confirmAiStringPunch(brain, enemy, _thrown);
      }

      // A string can run for seconds, so movement intent is re-thought every
      // tick rather than frozen at entry the way a short combo freezes it.
      if (_rt.active) {
        thinkMovement(brain, enemy, player, state);
        applyAiStringMovement(brain, enemy, player);
        applyMovement(brain, enemy, player, dt, state.ringLeft, state.ringRight, state.ringTop, state.ringBottom, state);
        return;
      }
    }
  }

  {
    const result = thinkAwake(brain.stateThinkTimer, brain.stateThinkInterval, brain, myFrac, dt);
    brain.stateThinkTimer = result.timer;
    if (result.awake) evaluateState(brain, enemy, player);
  }
  {
    const result = thinkAwake(brain.phaseThinkTimer, brain.phaseThinkInterval, brain, myFrac, dt);
    brain.phaseThinkTimer = result.timer;
    if (result.awake) evaluatePhase(brain, enemy, player);
  }
  {
    const result = thinkAwake(brain.moveThinkTimer, brain.moveThinkInterval, brain, myFrac, dt);
    brain.moveThinkTimer = result.timer;
    if (result.awake) thinkMovement(brain, enemy, player, state);
  }

  applyMovement(brain, enemy, player, dt, state.ringLeft, state.ringRight, state.ringTop, state.ringBottom, state);

  if (brain.chargeRespectCooldown > 0) brain.chargeRespectCooldown -= dt;
  // Charge respect used to re-roll every tick, so a held charge pinned the AI
  // in guard/step-out for as long as the player cared to hold it — recorded
  // fights show multi-second offensive silences with a charge armed while the
  // player kept punching. One reaction per beat keeps an armed charge
  // threatening without paralyzing the AI's own offence.
  if (player.chargeArmed && player.chargeArmTimer > 0 && !enemy.isPunching && brain.reactionDelayTimer <= 0 && brain.chargeRespectCooldown <= 0) {
    // Charged-punch respect: capped at 83% so an armed charge always retains threat value.
    let bandBase: number;
    switch (brain.difficultyBand) {
      case "Hardcore": bandBase = 0.78; break;
      case "Hard": bandBase = 0.66; break;
      case "Medium": bandBase = 0.46; break;
      default: bandBase = 0.30; break;
    }
    const adaptChargeResp = getSlotValue(brain.adaptiveMemory, "chargedPunchResponse");
    const chargeRespectChance = Math.min(0.83, bandBase * lerp(0.75, 1.25, brain.offense.chargedRespect) + adaptChargeResp * 0.15);
    brain.chargeRespectCooldown = 0.30;
    if (rng.chance(chargeRespectChance)) {
      const gdx = player.x - enemy.x;
      const gdz = player.z - enemy.z;
      const dist = Math.sqrt(gdx * gdx + gdz * gdz);
      if (dist < brain.attackRangeMax * 1.4) {
        brain.chargeRespectCooldown = 0.85;
        const respRoll = rng.next01();
        // Answering a charge with punches (rather than turtling) carries most
        // of the AI's ability to hurt a charge-heavy player, so the interrupt
        // share is the biggest slice at high difficulty.
        if (respRoll < 0.40 * brain.execIntensity && enemy.punchCooldown <= 0 && dist <= brain.attackRangeMax) {
          // Interrupt: get inside the charge before it fires. The read stays,
          // the punch itself comes from a string like all other offence.
          enemy.punchAimsHead = true;
          startStringForOffense(brain, enemy, player);
        } else if (respRoll < 0.30 + brain.offense.postExchangeDiscipline * 0.3) {
          // Brace: high guard hold instead of running
          brain.forcedGuard = true;
          brain.forcedHigh = true;
          enemy.defenseState = "fullGuard";
          brain.defenseHoldTimer = Math.max(brain.defenseHoldTimer, 0.25);
        } else {
          // Step out of the charge arc
          const dirX = dist > 0.01 ? gdx / dist : 1;
          const dirZ = dist > 0.01 ? gdz / dist : 0;
          const perpX = -dirZ;
          const perpZ = dirX;
          const lateralDodge = rng.chance(0.4) ? brain.lateralDir * 0.5 : 0;
          brain.desiredMoveInput = clamp(-dirX * 0.85 + perpX * lateralDodge, -1, 1);
          brain.desiredMoveZ = clamp(-dirZ * 0.85 + perpZ * lateralDodge, -1, 1);
          applyMovement(brain, enemy, player, dt, state.ringLeft, state.ringRight, state.ringTop, state.ringBottom, state);
        }
      }
    }
  }

  const aiChargeBase: Record<string, number> = {
    "Easy": 0.14, "Medium": 0.21, "Hard": 0.35, "Hardcore": 0.56
  };
  const aiChargeMax: Record<string, number> = {
    "Easy": 0.28, "Medium": 0.35, "Hard": 0.49, "Hardcore": 0.91
  };
  const base = aiChargeBase[brain.difficultyBand] || 0.10;
  const max = aiChargeMax[brain.difficultyBand] || 0.20;
  const losingOnPoints = enemy.damageDealt < player.damageDealt;
  const aiChargeChance = losingOnPoints ? max : base;

  if (!enemy.isPunching && !enemy.chargeArmed && enemy.aiGuardDropTimer <= 0) {
    const playerFrac = player.stamina / player.maxStamina;
    const staminaAdvantage = myFrac - playerFrac;
    const champBand = brain.difficultyBand === "Hardcore" || brain.difficultyBand === "Hard";
    const guardDropDist = getDistancePx(enemy, player);
    const playerCloseAndDangerous = champBand && guardDropDist < brain.attackRangeMax * 1.2 && (player.isPunching || player.handsDown || player.defenseState === "duck");
    if (staminaAdvantage >= 0.2 && myFrac > 0.4 && enemy.aiGuardDropCooldown <= 0 && !playerCloseAndDangerous) {
      if (rng.next01() < 0.15 * dt) {
        enemy.aiGuardDropTimer = 1 + rng.next01() * 2;
        enemy.aiGuardDropCooldown = 5 + rng.next01() * 5;
        enemy.defenseState = "none";
      }
    }
  }

  if (enemy.aiGuardDropTimer > 0) {
    enemy.defenseState = "none";
  }

  if (brain.postFeintWindow > 0) {
    brain.postFeintWindow -= dt;
    if (player.defenseState !== brain.postFeintPlayerDefense && !brain.postFeintFollowupReady) {
      brain.postFeintFollowupReady = true;
    }
    if (brain.postFeintWindow <= 0) {
      brain.postFeintFollowupReady = false;
    }
  }

  if (brain.postFeintFollowupReady && !enemy.isPunching && enemy.punchCooldown <= 0 && brain.comboCooldown <= 0) {
    brain.postFeintFollowupReady = false;
    brain.postFeintWindow = 0;
    const followupChance = brain.difficultyBand === "Easy" ? 0.30 :
      brain.difficultyBand === "Medium" ? 0.50 :
      brain.difficultyBand === "Hard" ? 0.75 : 0.90;
    if (rng.chance(followupChance)) {
      const dist = getDistancePx(enemy, player);
      if (dist <= brain.attackRangeMax + blocksToPixels(0.25)) {
        const playerDucked = player.defenseState === "duck";
        const doBody = playerDucked || rng.chance(brain.styleBodyFocus);
        // The feint bought an opening; the string is what walks into it. Aim is
        // still chosen here because the opponent's posture decides head vs body.
        if (doBody) {
          enemy.defenseState = "duck";
          enemy.duckTimer = 0.15;
          enemy.punchAimsHead = false;
        } else {
          enemy.punchAimsHead = true;
        }
        startStringForOffense(brain, enemy, player);
      }
    }
  }

  // Pre-duck uppercut sequence runner (Elite/Champion proactive duck-then-uppercut)
  if (brain.preDuckUppercutCooldown > 0) {
    brain.preDuckUppercutCooldown -= dt;
  }
  if (brain.preDuckUppercutActive) {
    brain.preDuckUppercutTimer -= dt;
    if (brain.preDuckUppercutTimer <= 0 && !enemy.isPunching && enemy.punchCooldown <= 0) {
      // The duck read still arms here — it is the whole point of the move — but
      // the punish is a string, not a hand-rolled uppercut queue. Drop under the
      // shot, aim at the body, and let the selector pick what comes back up.
      if (brain.preDuckUppercutQueue.length > 0) {
        enemy.defenseState = "duck";
        enemy.duckTimer = 0.15;
        enemy.punchAimsHead = false;
        startStringForOffense(brain, enemy, player);
      }
      brain.preDuckUppercutQueue = [];
      brain.preDuckUppercutActive = false;
      brain.preDuckUppercutCooldown = 2.5 + rng.next01() * 2.0;
    }
  }

  if (!enemy.isPunching && enemy.punchCooldown <= 0 && brain.comboCooldown <= 0 && brain.staminaPenaltyCooldown <= 0 && !brain.preDuckUppercutActive) {
    // Rhythm cut timing delay runner: counts down inside attack guard so it fires when AI can punch
    let rcDelayFired = false;
    if (brain.rcDelayTimer > 0) {
      brain.rcDelayTimer = Math.max(0, brain.rcDelayTimer - dt);
      if (brain.rcDelayTimer === 0) rcDelayFired = true;
    }
    const idleBypass = brain.playerIdleTime > 1.5 || brain.playerCornerCamping;
    // No career handicap here. This used to halve how often the AI was allowed
    // to think about attacking in career mode -- a hidden nerf nothing in the
    // neural tuning set or could see.
    const result = thinkAwake(brain.attackThinkTimer, brain.attackThinkInterval, brain, myFrac, dt);
    brain.attackThinkTimer = result.timer;
    let doRcAttack = result.awake || idleBypass || rcDelayFired;
    // RC timing roll — only on natural fire, not when the RC delay itself fires back
    if (doRcAttack && !rcDelayFired) {
      const rcCfg = getRcConfig();
      const rcChance = brain.difficultyBand === "Hardcore" ? rcCfg.chanceChampion :
        brain.difficultyBand === "Hard" ? rcCfg.chanceElite :
        brain.difficultyBand === "Medium" ? rcCfg.chanceContender : rcCfg.chanceJourneyman;
      // Only attempt RC timing when within effective striking distance (~22–55 px, matching observed RC hit range)
      const _rcDx = enemy.x - player.x;
      const _rcDz = enemy.z - player.z;
      const _rcDist = Math.sqrt(_rcDx * _rcDx + _rcDz * _rcDz);
      if (player.swaySpeedLevel > 0 && player.rhythmWalking !== false && player.defenseState !== "duck" && _rcDist >= 22 && _rcDist <= 55 && rng.chance(rcChance) && brain.rcDelayTimer <= 0) {
        // The cut window sits at the two ENDS of the player's arc, not its
        // middle, so the AI times a turnaround: "approaching" means the weight
        // is heading out to an extreme, not coming back through centre.
        const rcWindowEdge = Math.max(0, 5 - rcCfg.vulnerableWindowHalf);
        const approachingWindow = player.swayDir * player.swayOffset > 0; // swayOffset heading for an extreme
        const atOrNearWindow = Math.abs(player.swayOffset) >= rcWindowEdge;
        // Correction from EMA: positive = we've been landing late (past center) → speedup to fire sooner
        //                       negative = we've been landing early (before center) → add delay
        const corrMs = brain.rcTimingLearntMs;
        let learntCorrSec: number;
        if (corrMs > 0) {
          // Consistently late — apply speedup bounded by [speedupMinSec, speedupMaxSec]
          learntCorrSec = clamp(corrMs / 1000.0, rcCfg.speedupMinSec, rcCfg.speedupMaxSec);
        } else {
          // Consistently early — extra delay bounded by [0, delayMaxSec]
          learntCorrSec = clamp(corrMs / 1000.0, -rcCfg.delayMaxSec, 0);
        }
        if (atOrNearWindow) {
          // Player is in the window right now — fire immediately.
          // Apply speedup: advance next attack timer so the AI can threaten the next window crossing sooner.
          if (corrMs > 0) {
            brain.attackThinkTimer = clamp(learntCorrSec, rcCfg.speedupMinSec, rcCfg.speedupMaxSec);
          }
          brain.rcNudgeActive = true;
        } else if (approachingWindow) {
          // Player heading out to an extreme — set a delay to time the arrival, then subtract speedup correction.
          const distToWindow = rcWindowEdge - Math.abs(player.swayOffset);
          const approxRate = 10.0 + player.swaySpeedLevel * 3.0;
          const rawDelay = distToWindow / approxRate;
          // Subtract learnt correction: positive corrMs (late) reduces delay; negative (early) adds delay
          brain.rcDelayTimer = clamp(rawDelay - learntCorrSec, rcCfg.delayMinSec, rcCfg.delayMaxSec);
          brain.rcNudgeActive = true;
          doRcAttack = false; // defer attack until timer fires
        } else {
          // Player coming back in through the middle / away from a window — fire immediately.
          // Explicit speedup: advance next attack timer by learntCorrSec so next cycle fires sooner,
          // compressing the cadence to catch the next window crossing earlier.
          if (corrMs > 0) {
            brain.attackThinkTimer = clamp(learntCorrSec, rcCfg.speedupMinSec, rcCfg.speedupMaxSec);
          }
          brain.rcNudgeActive = true;
        }
      }
    } else if (rcDelayFired) {
      brain.rcNudgeActive = true; // deferred fire; mark nudge active
    }
    if (doRcAttack) {
      const action = thinkAttack(brain, enemy, player);

      // ===== Pressure offense =====
      // Instead of trading single shots from its own comfortable range, the AI rolls
      // (difficulty-keyed: rare at Journeyman, common at Champion) to walk into the
      // player's inside band and commit to a combo there, then follow it up.
      const _pressDist = getDistancePx(enemy, player);
      if (!brain.pressureActive && brain.pressureCooldown <= 0 && !brain.survivalModeActive &&
          !brain.preDuckUppercutActive && myFrac > 0.25) {
        if (rng.chance(PRESSURE_ENTRY_CHANCE[brain.difficultyBand] ?? 0)) {
          brain.pressureActive = true;
          brain.pressureUntil = brain.gameTime + 2.5 + rng.next01() * 2.0;
          brain.pressureFollowupsLeft = PRESSURE_FOLLOWUPS[brain.difficultyBand] ?? 1;
        } else {
          // Failed roll still burns the opportunity so the entry can't be re-rolled every tick
          brain.pressureCooldown = 1.5 + rng.next01() * 1.5;
        }
      }

      // Duck+uppercut combo: triggered per difficulty, gated by a cooldown so it can't spam
      // In doghouse mode: flat 20% every time the AI decides to punch
      const _duBaseBonus = !state.nightmareMode ? 0.02 : 0;
      const duckUppercutChance = state.doghouseMode ? 0.20 :
        (brain.difficultyBand === "Hardcore" ? 0.15 :
        brain.difficultyBand === "Hard" ? 0.13 :
        brain.difficultyBand === "Medium" ? 0.10 : 0.08) + _duBaseBonus;
      let finalAction = action;
      if (!brain.preDuckUppercutActive && brain.preDuckUppercutCooldown <= 0 && rng.chance(duckUppercutChance)) {
        const queue: PunchType[] = [rng.chance(0.5) ? "leftUppercut" : "rightUppercut"];
        if (rng.chance(0.20)) {
          queue.push(rng.chance(0.5) ? "leftUppercut" : "rightUppercut");
          if (rng.chance(0.50)) {
            queue.push(rng.chance(0.5) ? "leftUppercut" : "rightUppercut");
          }
        }
        const minDelay = brain.difficultyBand === "Hardcore" ? 0.3 : 0.5;
        brain.preDuckUppercutQueue = queue;
        brain.preDuckUppercutTimer = minDelay + rng.next01() * (0.8 - minDelay);
        brain.preDuckUppercutActive = true;
        finalAction = { type: "none" };
      }

      // Inside the pressure band, a single-shot (or idle) decision becomes a real combo.
      if (brain.pressureActive && !brain.preDuckUppercutActive &&
          (finalAction.type === "punch" || finalAction.type === "none") &&
          _pressDist <= PRESSURE_RANGE_PX + PRESSURE_RANGE_TOLERANCE_PX) {
        // The string engine supplies the volume generateCombo used to. Pressure
        // now only forces the commitment: an idle read becomes an offensive one
        // so a string is selected instead of the AI standing off.
        if (finalAction.type === "none") finalAction = { type: "punch", punch: "jab" };
      }

      // Rhythm Attacking forces the commitment the same way pressure does, but
      // without the range gate -- the movement override above is already walking
      // the AI in, and standing off mid-sequence is exactly the reset the
      // behaviour exists to suppress. A stepBack read is also overturned, except
      // against an armed charge, which stays worth respecting.
      if (isRhythmAttackDriving(brain) && !brain.preDuckUppercutActive) {
        if (finalAction.type === "none" || (finalAction.type === "stepBack" && !player.chargeArmed)) {
          finalAction = { type: "punch", punch: "jab" };
        }
      }

      // Tick the pre-arm delay while waiting for bars to accumulate
      if (brain.aiChargeTargetBars > 0 && brain.aiChargeArmDelayTimer > 0) {
        brain.aiChargeArmDelayTimer = Math.max(0, brain.aiChargeArmDelayTimer - dt);
      }

      // Arm a previously-targeted charge once bars have accumulated, the delay has elapsed, and the AI is in range
      if (brain.aiChargeTargetBars > 0 && !enemy.chargeArmed && enemy.chargeMeterBars >= brain.aiChargeTargetBars && brain.aiChargeArmDelayTimer <= 0) {
        const _cdx = player.x - enemy.x;
        const _cdz = player.z - enemy.z;
        const _cDist = Math.sqrt(_cdx * _cdx + _cdz * _cdz);
        if (_cDist <= brain.attackRangeMax * 1.4) {
          enemy.chargeArmed = true;
          enemy.chargeUsesLeft = 2;
          enemy.chargeWhiffForgivenessLeft = enemy.technicianChargeWhiffForgiveness ?? 0;
          enemy.chargeFlashTimer = 0.15;
          enemy.chargeArmTimer = levelScale(enemy.level, 2, 4, "aiChargeArmTimer");
          brain.aiChargeTargetBars = 0;
          brain.aiChargeArmDelayTimer = 0;
        }
      }

      let shouldCharge = rng.next01() < aiChargeChance && !enemy.chargeArmed && enemy.chargeMeterBars >= 1 && brain.aiChargeTargetBars === 0;
      if (finalAction.wantCharge && !enemy.chargeArmed && enemy.chargeMeterBars >= 1 && brain.aiChargeTargetBars === 0) {
        shouldCharge = true;
      }
      if (shouldCharge) {
        // Roll target bar count: 50% = 1 bar, 15% = 2, 15% = 3, 5.5% = 4, 14.5% = 5+
        // Ambush charges (execution layer) use the fighter's own preferred bar count.
        const _cr = rng.next01();
        const targetBars = finalAction.wantCharge
          ? brain.offense.chargedAmbushBars
          : (_cr < 0.50 ? 1 : _cr < 0.65 ? 2 : _cr < 0.80 ? 3 : _cr < 0.855 ? 4 : 5);
        // Roll pre-arm delay: probability of short range scales with difficulty
        // Easy=80% short, Medium=50%, Hard=25%, Hardcore=10%
        const _shortChance: Record<string, number> = { "Easy": 0.80, "Medium": 0.50, "Hard": 0.25, "Hardcore": 0.10 };
        const _useShortRange = rng.next01() < (_shortChance[brain.difficultyBand] ?? 0.50);
        const _armDelay = _useShortRange
          ? 0.25 + rng.next01() * (5.0 - 0.25)
          : 1.0 + rng.next01() * (15.0 - 1.0);
        // Always go through the deferred path so the delay is always respected
        brain.aiChargeTargetBars = targetBars;
        brain.aiChargeArmDelayTimer = _armDelay;
      }

      const useCharge = enemy.chargeArmed;
      if (finalAction.type === "stepBack") {
        const dirToPlayer = getDirToPlayer(enemy, player);
        brain.stepOutDesiredMove = -dirToPlayer;
        brain.perfectReactActive = true;
        brain.perfectReactUntil = brain.gameTime + 0.35;
        brain.forcedGuard = true;
        brain.forcedHigh = true;
        enemy.defenseState = "fullGuard";
      } else if (finalAction.type === "punch" || finalAction.type === "feint" || finalAction.type === "combo") {
        // ===== OFFENCE IS STRINGS =====
        // thinkAttack still runs, and its situational reads still drive tracking
        // state and decide *whether* to engage. What it no longer does is emit
        // the punch: any offensive verdict starts a string, and the string is
        // what actually comes out. Single shots only survive as the fallback
        // inside selectAiString when nothing else is eligible.
        if (isAiGasHeld(brain, enemy)) {
          // Every punch from here costs 1.5^excess until the window lapses, so
          // sit behind the guard rather than feed it. The hold ends on the exact
          // tick the penalty does, and the next read opens a string then.
          enemy.defenseState = "fullGuard";
        } else {
          startStringForOffense(brain, enemy, player);
        }
      } else {
        // A boxer who never commits never throws, and the read comes back empty
        // far more often than it should. When it does, still do *something* —
        // but only when nothing else already owns the fighter. A reflex or a
        // forced-guard hold is a deliberate defensive commitment, and the idle
        // cadence stops a finished string from immediately starting another.
        const _rt = ensureAiStringRuntime(brain);
        const _reflexOwnsMe =
          brain.perfectReactActive || brain.forcedGuard || brain.defenseHoldTimer > 0;
        if (!_rt.active && !_reflexOwnsMe) {
          const _sctx = buildStringContext(brain, enemy, player);
          // Defence is a response to something, not the default for "not
          // attacking". Standing off at range with gas in the tank is a
          // position, and movement already handles it.
          const _defensiveNeed =
            player.isPunching || player.chargeArmed || _sctx.myStaminaFrac < 0.25;
          const _roles: readonly AiStringRole[] | null =
            isAiGasHeld(brain, enemy) ? (_defensiveNeed ? ["defense"] : null)
            : _sctx.attackIntent > 0 ? ["offense", "mixed"]
            : _defensiveNeed ? ["defense"]
            : null;
          if (_roles) {
            const _def = selectAiString(brain, _sctx, _roles);
            if (_def) {
              startAiString(brain, _def);
              brain.preDuckUppercutActive = false;
              brain.preDuckUppercutQueue = [];
            }
          }
        }
      }
      // If the final action didn't result in an actual scoreable punch, clear the RC nudge flag
      // so it can't contaminate the miss-distance EMA via a later unrelated punch resolve.
      // Feints are intentional fakes — their punch animation never resolves as a real hit, so
      // they must not consume the nudge that was set for a real timing-corrected attack.
      if (finalAction.type === "none" || finalAction.type === "stepBack" || finalAction.type === "feint") {
        brain.rcNudgeActive = false;
      }
    }
  }

  if (brain.defenseHoldTimer > 0) brain.defenseHoldTimer -= dt;

  const playerIsIdle = !player.isPunching;
  if (playerIsIdle) {
    brain.playerIdleTime += dt;
  } else {
    brain.playerIdleTime = 0;
  }

  const RING_CX_AI = 400;
  const RING_CY_AI = 260;
  const RING_HALF_H_AI = 180;
  const cornerTopZ = RING_CY_AI - RING_HALF_H_AI + 40;
  const cornerBotZ = RING_CY_AI + RING_HALF_H_AI - 40;
  const nearCorner = player.z <= cornerTopZ || player.z >= cornerBotZ;

  if (nearCorner) {
    const movedX = Math.abs(player.x - brain.playerLastX);
    const movedZ = Math.abs(player.z - brain.playerLastZ);
    const totalMoved = movedX + movedZ;
    if (totalMoved < 10) {
      brain.playerCornerStallTimer += dt;
    } else {
      brain.playerCornerStallTimer = 0;
      brain.playerLastX = player.x;
      brain.playerLastZ = player.z;
    }
    if (brain.playerCornerStallTimer > 0.5) {
      brain.playerLastX = player.x;
      brain.playerLastZ = player.z;
    }
  } else {
    brain.playerCornerStallTimer = 0;
    brain.playerLastX = player.x;
    brain.playerLastZ = player.z;
  }

  const wasCornerCamping = brain.playerCornerCamping;
  brain.playerCornerCamping = nearCorner && brain.playerCornerStallTimer >= 3.0;

  if (brain.playerCornerCamping && (player.isPunching || (!nearCorner))) {
    brain.playerCornerCamping = false;
    brain.playerCornerStallTimer = 0;
  }

  if ((brain.playerIdleTime > 1.5 || brain.playerCornerCamping) && !enemy.isPunching) {
    enemy.defenseState = "none";
    brain.defenseHoldTimer = 0;
  } else if (!enemy.isPunching && enemy.aiGuardDropTimer <= 0) {
    const result = thinkAwake(brain.defenseThinkTimer, brain.defenseThinkInterval, brain, myFrac, dt);
    brain.defenseThinkTimer = result.timer;
    if (result.awake && !brain.perfectReactActive && brain.defenseHoldTimer <= 0 && brain.reactionDelayTimer <= 0) {
      const decision = thinkDefense(brain, enemy, player);
      applyDefenseDecision(decision, enemy);
      if (decision.wantGuard || decision.wantDuck) {
        brain.defenseHoldTimer = lerp(0.18, 0.10, brain.difficultyScore);
      }
    }
  }

  if (state.practiceMode && !isPlayerAI) {
    if (!state.cpuDefenseEnabled) {
      enemy.defenseState = "none";
      enemy.handsDown = true;
      brain.desiredMoveInput = 0;
      brain.desiredMoveZ = 0;
    }
  }
}

// ===== AI NOTIFICATION HANDLERS =====

export function notifyAiHitLanded(brain: AiBrainState, isPlayerPunch: boolean, hitHead: boolean, punchType?: PunchType): void {
  if (!brain) return;
  if (isPlayerPunch) {
    const region: "head" | "body" = hitHead ? "head" : "body";
    logHit(brain.dataBank, "player", region, 5, true, brain.gameTime);
    // The range they land from, over the same rolling window. This is what the
    // defensive timing layer treats as "close enough to be hit from".
    const dist = brain.lastKnownDistPx ?? 0;
    if (dist > 0) {
      const ranges = brain.playerLandRanges ?? (brain.playerLandRanges = []);
      ranges.push(dist);
      while (ranges.length > PLAYER_PUNCH_WINDOW) ranges.shift();
      let rsum = 0;
      for (const r of ranges) rsum += r;
      brain.playerLandRangeAvg = rsum / ranges.length;
    }
    markBlockSyncResolve(brain, false);
  } else if (punchType) {
    // Track what the AI just landed clean so the execution layer can double up on it
    brain.lastLandedPunchType = punchType;
    brain.lastLandedPunchTime = brain.gameTime;
    // Hit-confirm: tighten this slot's beat toward BEAT_MIN.
    notifyAiStringPunchResolved(brain, true);
    // Credit the sway speed this punch was thrown from, so the rhythm layer can
    // work out which of its own tempos is actually scoring.
    const lvl = brain.lastThrowSwayLevel;
    if (typeof lvl === "number") {
      const landedMap = brain.swayLevelLanded ?? (brain.swayLevelLanded = {});
      landedMap[lvl] = (landedMap[lvl] ?? 0) + 1;
    }
    if (brain.lastThrowInPowerSway) brain.statPowerSwayLanded = (brain.statPowerSwayLanded ?? 0) + 1;
  }
  // Getting hit is worth a beat of hands-up discipline. *Landing* one is not:
  // charging the same 1.2s guard for the AI's own clean shots meant that every
  // time it hurt the player it stopped to admire the work, and since it was
  // scheduled on both sides of every exchange that was most of the round spent
  // behind the gloves. The top bands now walk straight back in behind what they
  // just landed.
  const _pegSec = isPlayerPunch
    ? (POST_EXCHANGE_GUARD_HIT[brain.difficultyBand] ?? 1.2)
    : (POST_EXCHANGE_GUARD_LANDED[brain.difficultyBand] ?? 1.2);
  if (_pegSec > 0) {
    brain.postExchangeGuardUntil = Math.max(brain.postExchangeGuardUntil, brain.gameTime + _pegSec);
  }
}

export function notifyAiPunchWhiffed(brain: AiBrainState, isPlayerPunch: boolean, inRange: boolean): void {
  if (!brain) return;
  logWhiff(brain.dataBank, isPlayerPunch ? "player" : "ai", inRange, brain.gameTime);
  if (isPlayerPunch) markBlockSyncResolve(brain, false);
  // Whiff: stretch the beat, and let the runner decide whether the rest of the
  // string is still worth the stamina.
  if (!isPlayerPunch) notifyAiStringPunchResolved(brain, false);
}

/**
 * Snapshot of the decision layer for the fight recording. Read-only: nothing
 * here feeds a decision, it just makes the ones already taken visible.
 */
export function getAiDecisionStats(brain: AiBrainState | null | undefined): AiDecisionStats {
  const empty: AiDecisionStats = {
    punchesThrown: 0, bodyPunchesThrown: 0, powerSwayThrows: 0, powerSwayLanded: 0,
    offenseSuppressedTicks: 0, reflexHeldOffTicks: 0, inRangeTime: 0,
    blockSyncArmed: 0, blockSyncLanded: 0, gasPullouts: 0, gasHoldSec: 0, bodyBias: 0,
    playerPunchIntervalAvg: 0, playerLandRangeAvg: 0, playerJabFlightSec: 0,
    blockTimingLearntMs: 0, rhythmSwayAdapt: 0, bestSwayLevel: 0,
  };
  if (!brain) return empty;
  return {
    punchesThrown: brain.statPunchesThrown ?? 0,
    bodyPunchesThrown: brain.statBodyPunchesThrown ?? 0,
    powerSwayThrows: brain.statPowerSwayThrows ?? 0,
    powerSwayLanded: brain.statPowerSwayLanded ?? 0,
    offenseSuppressedTicks: brain.statOffenseSuppressedTicks ?? 0,
    reflexHeldOffTicks: brain.statReflexHeldOffTicks ?? 0,
    inRangeTime: brain.statInRangeTime ?? 0,
    blockSyncArmed: brain.statBlockSyncArmed ?? 0,
    blockSyncLanded: brain.statBlockSyncLanded ?? 0,
    gasPullouts: brain.statGasPullouts ?? 0,
    gasHoldSec: brain.statGasHoldSec ?? 0,
    bodyBias: brain.adaptiveBodyBias ?? 0,
    playerPunchIntervalAvg: brain.playerPunchIntervalAvg ?? 0,
    playerLandRangeAvg: brain.playerLandRangeAvg ?? 0,
    playerJabFlightSec: brain.playerJabFlightSec ?? 0,
    blockTimingLearntMs: brain.pbTimingLearntMs ?? 0,
    rhythmSwayAdapt: brain.rhythmSwayAdapt01 ?? 0,
    bestSwayLevel: bestSwayLevel(brain) ?? 0,
  };
}

export function notifyAiBlockContact(brain: AiBrainState, isHighGuard: boolean): void {
  if (!brain) return;
  notifyAiPunchContactedGuard(brain, isHighGuard);
  markBlockSyncResolve(brain, true);
}

// ===== ADAPTIVE AI SYSTEM =====

const TIMING_SLOT_DEFS: { id: string; maxNudge: number; riskCost: number; personalityKey?: keyof AiPersonality; personalityScale?: number }[] = [
  { id: "uppercutOnDuck", maxNudge: 0.40, riskCost: 0.3 },
  { id: "bodyAttackVsGuard", maxNudge: 0.35, riskCost: 0.15 },
  { id: "chaseAfterRetreat", maxNudge: 0.30, riskCost: 0.2, personalityKey: "aggression", personalityScale: 0.15 },
  { id: "feintBeforeAttack", maxNudge: 0.30, riskCost: 0.1, personalityKey: "feintiness", personalityScale: 0.12 },
  { id: "disengageAfterCombo", maxNudge: 0.35, riskCost: 0.1, personalityKey: "cleanHitsOverVolume", personalityScale: 0.10 },
  { id: "guardVsDodgePref", maxNudge: 0.30, riskCost: 0.15, personalityKey: "guardParanoia", personalityScale: 0.10 },
  { id: "engageCycleInBias", maxNudge: 0.25, riskCost: 0.2, personalityKey: "aggression", personalityScale: 0.08 },
  { id: "engageCycleOutBias", maxNudge: 0.25, riskCost: 0.1 },
  { id: "jabFrequency", maxNudge: 0.30, riskCost: 0.1 },
  { id: "powerPunchCommit", maxNudge: 0.35, riskCost: 0.35, personalityKey: "aggression", personalityScale: 0.10 },
  { id: "ringCutoffUrgency", maxNudge: 0.30, riskCost: 0.2, personalityKey: "aggression", personalityScale: 0.08 },
  { id: "ropePressureDuration", maxNudge: 0.25, riskCost: 0.25, personalityKey: "aggression", personalityScale: 0.06 },
  { id: "lateralVsLinear", maxNudge: 0.30, riskCost: 0.1 },
  { id: "comboLengthPref", maxNudge: 0.25, riskCost: 0.3, personalityKey: "aggression", personalityScale: 0.08 },
  { id: "counterWaitDuration", maxNudge: 0.30, riskCost: 0.15, personalityKey: "cleanHitsOverVolume", personalityScale: 0.10 },
  { id: "headTargetBias", maxNudge: 0.30, riskCost: 0.15, personalityKey: "headBias", personalityScale: 0.10 },
  { id: "bodyTargetBias", maxNudge: 0.30, riskCost: 0.15 },
  { id: "aggression", maxNudge: 0.25, riskCost: 0.25, personalityKey: "aggression", personalityScale: 0.08 },
  { id: "guardParanoiaBias", maxNudge: 0.25, riskCost: 0.1, personalityKey: "guardParanoia", personalityScale: 0.08 },
  { id: "duckApproachBias", maxNudge: 0.20, riskCost: 0.2 },
  { id: "commitChanceBias", maxNudge: 0.20, riskCost: 0.25, personalityKey: "aggression", personalityScale: 0.06 },
  { id: "patienceBias", maxNudge: 0.25, riskCost: 0.1, personalityKey: "cleanHitsOverVolume", personalityScale: 0.08 },
  { id: "retreatTrackBias", maxNudge: 0.25, riskCost: 0.2, personalityKey: "aggression", personalityScale: 0.06 },
  { id: "antiCornerPressure", maxNudge: 0.30, riskCost: 0.15 },
  { id: "crossCounterBias", maxNudge: 0.25, riskCost: 0.2, personalityKey: "cleanHitsOverVolume", personalityScale: 0.08 },
  { id: "hookFrequency", maxNudge: 0.25, riskCost: 0.25 },
  { id: "guardDropExploit", maxNudge: 0.35, riskCost: 0.15 },
  { id: "postDodgeAttack", maxNudge: 0.30, riskCost: 0.2 },
  { id: "defenseDisciplineBias", maxNudge: 0.20, riskCost: 0.1, personalityKey: "guardParanoia", personalityScale: 0.06 },
  { id: "staminaConservation", maxNudge: 0.25, riskCost: 0.1 },
  { id: "chargedPunchResponse", maxNudge: 0.30, riskCost: 0.2 },
  { id: "sustainedDuckPunish", maxNudge: 0.35, riskCost: 0.25 },
];

export function createAdaptiveMemory(brain: AiBrainState): AdaptiveMemory {
  const p = brain.personality;
  const diffScale = brain.difficultyBand === "Hardcore" ? 1.0 : brain.difficultyBand === "Hard" ? 0.85 : brain.difficultyBand === "Medium" ? 0.60 : 0.35;
  const timingBase: TimingSlot[] = TIMING_SLOT_DEFS.map(def => {
    let base = 0;
    if (def.personalityKey && def.personalityScale) {
      base = (p[def.personalityKey] - 0.5) * def.personalityScale;
    }
    return {
      id: def.id,
      base,
      nudge: 0,
      confidence: 0,
      maxNudge: def.maxNudge * diffScale,
      riskCost: def.riskCost,
    };
  });
  return {
    observations: [],
    timingBase,
    roundsOfData: 0,
    lastReviewTime: 0,
    midRoundReviewTimer: 0,
  };
}

function getLearnChance(band: DifficultyBand): number {
  switch (band) {
    case "Easy": return 0.02;
    case "Medium": return 0.08;
    case "Hard": return 0.18;
    case "Hardcore": return 0.30;
  }
}

function getMaxAdaptFrac(band: DifficultyBand): number {
  switch (band) {
    case "Easy": return 0.30;
    case "Medium": return 0.40;
    case "Hard": return 0.50;
    case "Hardcore": return 0.55;
  }
}

const PATTERN_TO_SLOTS: Record<string, { slotId: string; direction: number }[]> = {
  "duckCounter": [
    { slotId: "uppercutOnDuck", direction: 1 },
    { slotId: "bodyTargetBias", direction: 0.5 },
    { slotId: "sustainedDuckPunish", direction: 0.7 },
  ],
  "jabStep": [
    { slotId: "counterWaitDuration", direction: 0.6 },
    { slotId: "guardParanoiaBias", direction: 0.4 },
    { slotId: "retreatTrackBias", direction: -0.3 },
  ],
  "backstepCounter": [
    { slotId: "chaseAfterRetreat", direction: 1 },
    { slotId: "engageCycleInBias", direction: 0.5 },
    { slotId: "feintBeforeAttack", direction: 0.6 },
  ],
  "pivotPunch": [
    { slotId: "lateralVsLinear", direction: 0.8 },
    { slotId: "ringCutoffUrgency", direction: 0.5 },
    { slotId: "jabFrequency", direction: 0.3 },
  ],
  "blockCounter": [
    { slotId: "feintBeforeAttack", direction: 0.8 },
    { slotId: "guardDropExploit", direction: 0.5 },
    { slotId: "commitChanceBias", direction: -0.3 },
  ],
  "dodgeCounter": [
    { slotId: "postDodgeAttack", direction: 0.7 },
    { slotId: "disengageAfterCombo", direction: 0.5 },
    { slotId: "patienceBias", direction: 0.4 },
  ],
  "exchange": [
    { slotId: "aggression", direction: -0.3 },
    { slotId: "defenseDisciplineBias", direction: 0.5 },
    { slotId: "guardParanoiaBias", direction: 0.4 },
    { slotId: "engageCycleOutBias", direction: 0.3 },
  ],
  "ringCutting": [
    { slotId: "ringCutoffUrgency", direction: -0.6 },
    { slotId: "lateralVsLinear", direction: 0.5 },
    { slotId: "antiCornerPressure", direction: 0.4 },
  ],
  "cornerPressure": [
    { slotId: "antiCornerPressure", direction: 0.8 },
    { slotId: "ropePressureDuration", direction: -0.4 },
    { slotId: "disengageAfterCombo", direction: 0.5 },
  ],
  "ropeEscape": [
    { slotId: "ringCutoffUrgency", direction: 0.6 },
    { slotId: "ropePressureDuration", direction: 0.4 },
    { slotId: "chaseAfterRetreat", direction: 0.5 },
  ],
  "centerControl": [
    { slotId: "lateralVsLinear", direction: 0.4 },
    { slotId: "aggression", direction: -0.3 },
    { slotId: "engageCycleOutBias", direction: 0.4 },
  ],
  "swayFire": [
    { slotId: "lateralVsLinear", direction: 0.6 },
    { slotId: "jabFrequency", direction: 0.4 },
    { slotId: "guardVsDodgePref", direction: -0.3 },
    { slotId: "crossCounterBias", direction: 0.4 },
  ],
  "postPunchRetreat": [
    { slotId: "chaseAfterRetreat", direction: 0.7 },
    { slotId: "retreatTrackBias", direction: 0.5 },
    { slotId: "engageCycleInBias", direction: 0.3 },
    { slotId: "patienceBias", direction: -0.3 },
  ],
};

const ZONE_SLOT_BOOSTS: Partial<Record<RingZone, { slotId: string; bonus: number }[]>> = {
  "cornerNE": [{ slotId: "antiCornerPressure", bonus: 0.3 }],
  "cornerNW": [{ slotId: "antiCornerPressure", bonus: 0.3 }],
  "cornerSE": [{ slotId: "antiCornerPressure", bonus: 0.3 }],
  "cornerSW": [{ slotId: "antiCornerPressure", bonus: 0.3 }],
  "ropeN": [{ slotId: "ringCutoffUrgency", bonus: 0.2 }],
  "ropeS": [{ slotId: "ringCutoffUrgency", bonus: 0.2 }],
  "ropeE": [{ slotId: "ringCutoffUrgency", bonus: 0.2 }],
  "ropeW": [{ slotId: "ringCutoffUrgency", bonus: 0.2 }],
};

// ===== WHIFF / UNCLEAN SHOT LEARNING =====

function getWhiffLearnChanceBase(band: DifficultyBand): number {
  return band === "Easy" ? 0.25 : band === "Medium" ? 0.45 : band === "Hard" ? 0.65 : 0.80;
}

function getWhiffLearnChance(brain: AiBrainState): number {
  return Math.max(0, getWhiffLearnChanceBase(brain.difficultyBand) - brain.whiffLearnKdPenalty);
}

export function notifyAiKnockedDown(brain: AiBrainState): void {
  if (brain) clearBlockSyncPrediction(brain);
  // Interrupt: nothing survives going down.
  cancelAiString(brain, null, false);
  // Ending 4. No chain roll -- whoever went down, the exchange that the sequence
  // was riding is over.
  cancelRhythmAttack(brain);
  if (!brain) return;
  // A queued pattern counter dies here too. Its expiry is measured on the
  // brain clock, which stops for the count -- so left alone it would still be
  // live on the other side of the knockdown and answer something that is no
  // longer being thrown. This is the authoritative path: updateAI returns early
  // for the whole count, so the pattern tick never runs to clear it.
  brain.patternPunchQueue = [];
  brain.patternPunchUntil = 0;
  // Same reasoning for the held duck: its release is driven by the pattern
  // tick, which does not run while a fighter is down.
  brain.patternDuckHoldUntilRetract = false;
  brain.patternDuckHoldPunchId = -1;
  brain.patternDuckHoldUntil = 0;
  // Each KD this round reduces the effective learn chance by 5–10%
  const penalty = 0.05 + rng.next01() * 0.05;
  brain.whiffLearnKdPenalty = Math.min(1, brain.whiffLearnKdPenalty + penalty);
}

function getWhiffAdjustChance(band: DifficultyBand): number {
  return band === "Easy" ? 0.35 : band === "Medium" ? 0.47 : band === "Hard" ? 0.57 : 0.65;
}

export function notifyAiWhiffContext(brain: AiBrainState, dist: number, playerDucked: boolean, playerRhythmLevel: number): void {
  if (!brain) return;
  const snap: WhiffSnapshot = { dist, playerDucked, playerRhythmLevel, gameTime: brain.gameTime };
  brain.whiffSnapshots.push(snap);
  if (brain.whiffSnapshots.length > 20) brain.whiffSnapshots.shift();
}

function runWhiffLearning(brain: AiBrainState, dt: number): void {
  brain.whiffLearnTimer -= dt;
  if (brain.whiffLearnTimer > 0) return;
  // Next review in 8–12 seconds
  brain.whiffLearnTimer = 8 + rng.next01() * 4;

  const snaps = brain.whiffSnapshots;
  if (snaps.length < 2) return;

  // Chance to learn from the snapshot history (reduced by accumulated KD penalty)
  if (!rng.chance(getWhiffLearnChance(brain))) return;

  // Analyse: what fraction of whiffs happened while player was ducking?
  const duckSnaps = snaps.filter(s => s.playerDucked).length;
  const duckFrac = duckSnaps / snaps.length;

  // Analyse average range of whiff contexts
  const avgDist = snaps.reduce((a, s) => a + s.dist, 0) / snaps.length;

  // Decide what to nudge — probabilistic and mild
  if (rng.chance(getWhiffAdjustChance(brain.difficultyBand))) {
    // Body-bias nudge: if mostly ducking → push body bias up; if mostly standing → push down
    const bodyDir = duckFrac > 0.5 ? 1 : -1;
    const bodyNudge = bodyDir * rng.rollRange01(0.02, 0.06);
    brain.whiffLearnBodyBiasNudge = clamp(brain.whiffLearnBodyBiasNudge + bodyNudge, -0.20, 0.20);
  }

  if (rng.chance(getWhiffAdjustChance(brain.difficultyBand))) {
    // Range nudge: if whiffs cluster close → try stepping out; if far → try closing
    const currentIdeal = brain.aiLearntRangeAvg > 0 ? brain.aiLearntRangeAvg : brain.idealRangeNeutral;
    const rangeDir = avgDist < currentIdeal * 0.85 ? 1 : -1; // close whiffs → step out
    const rangeNudge = rangeDir * rng.rollRange01(2, 8);
    brain.whiffLearnRangeNudge = clamp(brain.whiffLearnRangeNudge + rangeNudge, -30, 30);
  }

  // Trim old snapshots after learning
  const cutoff = brain.gameTime - 20;
  brain.whiffSnapshots = brain.whiffSnapshots.filter(s => s.gameTime >= cutoff);
}

export function reviewAdaptiveMemory(brain: AiBrainState, dt: number): void {
  const mem = brain.adaptiveMemory;
  if (!mem) return;
  // Stun lockout: no timing adaptation for the rest of the round
  if (brain.timingAdjustLocked) return;

  mem.midRoundReviewTimer += dt;
  const shouldReview = mem.midRoundReviewTimer >= 10.0;
  if (!shouldReview) return;
  mem.midRoundReviewTimer = 0;

  const learnChance = getLearnChance(brain.difficultyBand);
  const maxFrac = getMaxAdaptFrac(brain.difficultyBand);
  const roundWeight = Math.min(1.0, mem.roundsOfData / 4);
  const riskTolerance = brain.difficultyBand === "Hardcore" ? 0.8 : brain.difficultyBand === "Hard" ? 0.6 : brain.difficultyBand === "Medium" ? 0.4 : 0.2;

  for (const obs of mem.observations) {
    if (obs.confidence < 0.5) continue;

    const isComboObs = obs.kind.startsWith("combo:");
    const lookupKind = isComboObs ? "exchange" : obs.kind;
    const slotMappings = PATTERN_TO_SLOTS[lookupKind];
    if (!slotMappings) continue;

    const comboMultiplier = isComboObs ? 1.5 : (obs.comboSequence ? 1.2 : 1.0);
    const confScale = Math.min(1.0, obs.confidence / 3.0);
    const effectiveChance = learnChance * confScale * comboMultiplier * (0.3 + roundWeight * 0.7);
    if (!rng.chance(effectiveChance)) continue;

    for (const mapping of slotMappings) {
      const slot = mem.timingBase.find(s => s.id === mapping.slotId);
      if (!slot) continue;

      if (slot.riskCost > riskTolerance && !rng.chance(0.15)) continue;

      const nudgeDelta = 0.03 * mapping.direction * confScale * comboMultiplier;
      const maxAbs = slot.maxNudge * maxFrac;
      const riskPenalty = slot.riskCost > riskTolerance ? 0.5 : 1.0;
      slot.nudge = clamp(slot.nudge + nudgeDelta * riskPenalty, -maxAbs, maxAbs);
      slot.confidence += 0.1 * comboMultiplier;
    }

    const zoneBoosts = ZONE_SLOT_BOOSTS[obs.zone];
    if (zoneBoosts) {
      for (const zb of zoneBoosts) {
        const slot = mem.timingBase.find(s => s.id === zb.slotId);
        if (slot) {
          const maxAbs = slot.maxNudge * maxFrac;
          const riskPenalty = slot.riskCost > riskTolerance ? 0.5 : 1.0;
          slot.nudge = clamp(slot.nudge + 0.02 * zb.bonus * confScale * comboMultiplier * riskPenalty, -maxAbs, maxAbs);
        }
      }
    }
  }
}

export function onRoundBoundaryAdaptive(brain: AiBrainState): void {
  if (brain) clearBlockSyncPrediction(brain);
  // Pressure and anticipation state don't carry across the bell
  brain.pressureActive = false;
  brain.pressureCooldown = 0;
  brain.pressureFollowupsLeft = 0;
  brain.pressureCounterWindowUntil = 0;
  // Neither does an aggression sequence: the cut that opened it is two minutes
  // stale by the time the next round starts.
  cancelRhythmAttack(brain);

  // The stun lockout only lasts the round it was triggered in
  const wasTimingLocked = brain.timingAdjustLocked;
  brain.timingAdjustLocked = false;

  const mem = brain.adaptiveMemory;
  if (!mem) return;
  if (wasTimingLocked) return;

  mem.roundsOfData++;

  const learnChance = getLearnChance(brain.difficultyBand);
  const maxFrac = getMaxAdaptFrac(brain.difficultyBand);
  const riskTolerance = brain.difficultyBand === "Hardcore" ? 0.8 : brain.difficultyBand === "Hard" ? 0.6 : brain.difficultyBand === "Medium" ? 0.4 : 0.2;
  const roundWeight = Math.min(1.0, mem.roundsOfData / 4);
  const roundLearnBoost = 1.5;

  for (const obs of mem.observations) {
    if (obs.confidence < 0.3) continue;
    const isComboObs = obs.kind.startsWith("combo:");
    const lookupKind = isComboObs ? "exchange" : obs.kind;
    const slotMappings = PATTERN_TO_SLOTS[lookupKind];
    if (!slotMappings) continue;

    const comboMultiplier = isComboObs ? 1.5 : (obs.comboSequence ? 1.2 : 1.0);
    const confScale = Math.min(1.0, obs.confidence / 2.5);
    const effectiveChance = learnChance * confScale * roundLearnBoost * comboMultiplier * (0.4 + roundWeight * 0.6);
    if (!rng.chance(effectiveChance)) continue;

    for (const mapping of slotMappings) {
      const slot = mem.timingBase.find(s => s.id === mapping.slotId);
      if (!slot) continue;
      if (slot.riskCost > riskTolerance && !rng.chance(0.2)) continue;

      const nudgeDelta = 0.04 * mapping.direction * confScale * comboMultiplier;
      const maxAbs = slot.maxNudge * maxFrac;
      const riskPenalty = slot.riskCost > riskTolerance ? 0.5 : 1.0;
      slot.nudge = clamp(slot.nudge + nudgeDelta * riskPenalty, -maxAbs, maxAbs);
      slot.confidence += 0.15 * comboMultiplier;
    }
  }

  for (const obs of mem.observations) {
    obs.confidence *= 0.85;
  }
  mem.observations = mem.observations.filter(o => o.confidence >= 0.1);

  mem.midRoundReviewTimer = 0;

  // Reset the escalating forget chance each round
  brain.rangeForgetChance = 0.35;

  // Soft-reset whiff learning each round (keep 30% of accumulated nudge for continuity)
  brain.whiffLearnRangeNudge *= 0.30;
  brain.whiffLearnBodyBiasNudge *= 0.30;
  brain.whiffSnapshots = [];
  brain.whiffLearnTimer = 8 + rng.next01() * 4;
  // KD penalty fully resets each round
  brain.whiffLearnKdPenalty = 0;
}

function getSlotValue(mem: AdaptiveMemory | null, slotId: string): number {
  if (!mem) return 0;
  const slot = mem.timingBase.find(s => s.id === slotId);
  if (!slot) return 0;
  const roundWeight = Math.min(1.0, mem.roundsOfData / 4);
  return slot.base + slot.nudge * (0.2 + roundWeight * 0.8);
}
