import type { SituationTracker } from "./fundamentalStates";
import type { AiSegment, AiMoveDir } from "./aiStrings";
import type { AiPatternMemory } from "./aiPatterns";
import type { DrilledClosingBuffs, DrilledFightState } from "./drilledActions";
import type { RingColors } from "./ringColors";
import type { RlPolicy } from "./rlPolicy";

export type Archetype = "BoxerPuncher" | "OutBoxer" | "Brawler" | "Swarmer";

export type AIDifficulty = "journeyman" | "contender" | "elite" | "champion";

export const AI_DIFFICULTY_LABELS: Record<AIDifficulty, string> = {
  journeyman: "Journeyman",
  contender: "Contender",
  elite: "Elite",
  champion: "Champion",
};

export const AI_DIFFICULTY_DESCRIPTIONS: Record<AIDifficulty, string> = {
  journeyman: "A stepping stone. Goes down easier.",
  contender: "Solid opponent. Won't quit without a fight.",
  elite: "Tough as nails. Hard to put away.",
  champion: "The real deal. Almost impossible to stop.",
};

export type AiState = "Approach" | "Maintain" | "Retreat" | "Panic";

export type TacticalPhase = "Probe" | "Download" | "Pressure" | "WhiffPunish" | "Counter" | "BodyHunt" | "Finish" | "Panic";

export type DifficultyBand = "Easy" | "Medium" | "Hard" | "Hardcore";

export const DIFFICULTY_TO_BAND: Record<AIDifficulty, DifficultyBand> = {
  journeyman: "Easy",
  contender: "Medium",
  elite: "Hard",
  champion: "Hardcore",
};

export interface AiPersonality {
  aggression: number;
  guardParanoia: number;
  feintiness: number;
  cleanHitsOverVolume: number;
  headBias: number;
}

export interface AiHitRecord {
  time: number;
  actor: "player" | "ai";
  region: "head" | "body";
  damage: number;
  inRange: boolean;
}

export interface AiWhiffRecord {
  time: number;
  actor: "player" | "ai";
  inRange: boolean;
}

export interface AiHitPattern {
  kind: "punch" | "feint";
  avgInterval: number;
  eventCount: number;
  lastSeenTime: number;
  successfulCounters: number;
  locked: boolean;
}

export interface AiHitSummary {
  headHits: number;
  bodyHits: number;
}

export interface AiDataBank {
  recentHits: AiHitRecord[];
  recentWhiffs: AiWhiffRecord[];
  offensiveEvents: { time: number; isFeint: boolean; inRange: boolean }[];
  hitPatterns: AiHitPattern[];
  maxHitHistory: number;
  maxWhiffHistory: number;
  maxHitPatterns: number;
  patternWindowSeconds: number;
  patternIntervalTolerance: number;
}

export interface AiComboStep {
  punch: PunchType;
  isFeint: boolean;
  delayAfter: number;
  targetBody: boolean;
}

export interface AiCombo {
  steps: AiComboStep[];
  name: string;
}

export interface WhiffSnapshot {
  dist: number;
  playerDucked: boolean;
  playerRhythmLevel: number;
  gameTime: number;
}

/**
 * Runtime state for the string engine (see game/aiStrings.ts and
 * game/aiStringRunner.ts).
 *
 * Deliberately grouped into one object rather than flattened onto the brain:
 * HMR keeps live brains across a reload, so a brain created before this feature
 * existed would be missing every field. One container means the backfill guard
 * in updateAI only has to test a single property to rebuild the whole block.
 */
/** A string suspended by a reactive insert, waiting to be resumed. */
export interface AiStringFrame {
  stringId: number;
  segments: AiSegment[];
  index: number;
  landed: number;
  whiffed: number;
  /** Separation this string owes a walk back to, or -1. See AiStringRuntime. */
  returnDistPx: number;
  /** The suspended run's RL control, restored with it. See AiStringRuntime. */
  rlControlled?: boolean;
  rlTempo?: number;
}

/**
 * One entry of the runner's short lookahead. The runner plans a couple of
 * segments past the one it is executing so a move can already be shaped by the
 * punch that follows it, while still being rebuilt every boundary so late
 * changes (whiff trimming, a reactive insert) are picked up.
 */
export interface AiStringPlanStep {
  slot: number;
  kind: AiSegment["kind"];
  punch?: PunchType;
  targetBody?: boolean;
  moveDir?: AiMoveDir;
  /** The beat that will be waited before this step fires. */
  beat: number;
}

export interface AiStringRuntime {
  /** A string is mid-execution. */
  active: boolean;
  /** id of the running string in AI_STRINGS, or -1 when idle. */
  stringId: number;
  /** Working copy of the running string's segments; learning may trim or reorder these. */
  segments: AiSegment[];
  /** Index of the next segment to fire. */
  index: number;
  /** Countdown to the next segment -- "the beat". */
  beatTimer: number;
  /** A segment that occupies time rather than firing instantly. */
  holdKind: "none" | "duck" | "block" | "move" | "return" | "blockSync";
  holdTimer: number;
  moveDir: AiMoveDir | null;
  /**
   * Which perpendicular a retreat has been deflected onto (-1, 0 or 1). A
   * retreat pinned against the ropes cannot make ground backwards, so it slides
   * along them instead of standing still for the rest of its beat.
   */
  outDeflect: number;
  /** Consecutive ticks the current retreat has failed to make ground. */
  outStallTicks: number;
  /**
   * Where the last retreat tick was issued from, or -1 before the first one.
   * Comparing against it next tick is how a blocked retreat is detected without
   * the runner needing to know the shape of the ring.
   */
  outLastX: number;
  outLastZ: number;
  /**
   * Separation (px) a move segment left from, or -1 when nothing is owed. A
   * string that gives up ground walks exactly that much of it back before it
   * throws, so the punch is fired from the range the string was written for
   * instead of from wherever the retreat happened to end.
   */
  returnDistPx: number;
  /**
   * How long the string has been parked outside striking range. Segments do
   * not run out of range; the string keeps its place and waits. Past a cap it
   * is written off rather than waiting forever on an opponent who has left.
   */
  rangeWaitTimer: number;
  /**
   * Seconds spent inside striking range this bout, and punches the engine has
   * accepted in that time. Together they are the fighter's real output rate --
   * the measure the aggression swap runs off, because being out-landed and
   * being out-worked are different problems.
   */
  inRangeTime: number;
  throwCount: number;
  /**
   * How many times this run has been extended -- a fresh sequence appended onto
   * the working copy at what would have been the end of the string. Capped so
   * one string cannot become the entire round.
   */
  extensions: number;
  /** Lookahead over the next segments. Rebuilt at every boundary. */
  plan: AiStringPlanStep[];
  /**
   * Slot index of a charge segment whose punch has not been thrown yet, or -1.
   * The beat after a charge is clamped so the arm cannot expire mid-string.
   */
  chargeSlot: number;
  /** Learned beat per string: id -> seconds per slot. Within-bout only. */
  beats: Record<number, number[]>;
  /** Per-fighter timing bias per string: id -> multiplier. Rolled lazily on first use. */
  bias: Record<number, number>;
  /** Learned selection weight per string: id -> multiplier. */
  weight: Record<number, number>;
  /**
   * Separation at the last runner tick. Cached so the hit/whiff hooks -- which
   * the engine calls with only the brain in hand -- can judge whether the
   * opponent is leaving range without needing both fighter refs threaded in.
   */
  lastDistPx: number;
  /** Slot whose punch is in flight awaiting a hit/whiff verdict, or -1. */
  pendingSlot: number;
  /**
   * Slot of a punch segment handed to the engine but not yet confirmed thrown.
   * The engine can refuse a throw (telegraph lockout, reach gate), so a string
   * only advances once the punch is actually accepted.
   */
  pendingThrowSlot: number;
  /** Consecutive refused throw attempts on the current segment. */
  throwFailCount: number;
  /**
   * Strings suspended by a reactive insert. When the AI spots an opening
   * mid-string it cuts to a more appropriate one and resumes this stack after.
   */
  stack: AiStringFrame[];
  /** Landed/whiffed punches in the current string. */
  landed: number;
  whiffed: number;
  consecutiveWhiffs: number;
  /** Debug counters. */
  runCount: number;
  cancelCount: number;
  /**
   * The running string was picked by the RL tactical policy. Such a run takes
   * its beat from rlTempo and skips the per-slot beat learning and the per-id
   * selection weights: the policy owns its tempo.
   */
  rlControlled: boolean;
  /** Beat delay (s) the policy chose for every slot of this run, or -1. */
  rlTempo: number;
  /**
   * A utility the policy chose that updateAI has to perform (1 Reset, 3
   * slip-then-counter), or 0. Charge and stance switch are applied as segments.
   */
  rlUtilityPending: number;
}

/** One policy decision, kept while recording is on. The trainer's raw material. */
export interface AiRlDecisionRecord {
  /** brain.gameTime at the decision. */
  t: number;
  obs: Float32Array;
  /** Eligibility per string-head index (1 = allowed). */
  mask: Uint8Array;
  roles: string[];
  stringIndex: number;
  stringId: number;
  tempoIndex: number;
  tempo: number;
  utility: number;
  logProb: number;
  value: number;
  /** Whether the utility actually went ahead; null until it is known. */
  utilityApplied: boolean | null;
}

/** A decision made in selectAiString, waiting for start/insert/extend to apply it. */
export interface AiRlPendingDecision {
  stringId: number;
  tempo: number;
  utility: number;
  /** Arm Charge is possible right now (meter bar available, not already armed). */
  chargeOk: boolean;
  record: AiRlDecisionRecord | null;
}

export interface AiRlState {
  policy: RlPolicy | null;
  /** Append every decision to `log`. Off in normal play; the trainer turns it on. */
  recording: boolean;
  /** Argmax instead of sampling. */
  deterministic: boolean;
  log: AiRlDecisionRecord[];
  /** Decisions dropped because the log was full. */
  dropped: number;
  decisions: number;
  pending: AiRlPendingDecision | null;
  /** Record of a Reset / slip-counter still waiting to be performed. */
  utilityRecord: AiRlDecisionRecord | null;
  /** Most recent decision, for the HUD. */
  last: { stringId: number; tempo: number; utility: number; applied: boolean | null; t: number } | null;
}

/**
 * The brain's own rolled values for every field the neural knobs touch, taken
 * before any of them were applied.
 *
 * Kept because the knobs are re-applied mid-bout when the situation calls for a
 * different fundamental. Each knob blends into a baseline, so blending into an
 * already-blended value would walk the brain further from its roll on every
 * switch instead of moving it somewhere new.
 */
export interface NeuralBaseline {
  stateThinkInterval: number;
  moveThinkInterval: number;
  attackThinkInterval: number;
  rhythmCutCommitChanceRoll01: number;
  rhythmCutAggression01: number;
  execIntensity: number;
  rhythmSwayAdapt01: number | undefined;
  perfectBlockIntent01: number;
  anticipationChance: number;
}

export interface AiBrainState {
  currentState: AiState;
  /** String engine state. See AiStringRuntime. */
  strings: AiStringRuntime;
  /**
   * RL tactical policy, when one is attached. null/undefined = the weighted
   * string chooser, exactly as before.
   */
  rl?: AiRlState | null;
  currentPhase: TacticalPhase;
  difficultyBand: DifficultyBand;
  difficultyScore: number;
  isSparring: boolean;
  personality: AiPersonality;
  dataBank: AiDataBank;

  // Think interval timers
  stateThinkTimer: number;
  phaseThinkTimer: number;
  moveThinkTimer: number;
  attackThinkTimer: number;
  defenseThinkTimer: number;

  // Think interval base rates
  stateThinkInterval: number;
  phaseThinkInterval: number;
  moveThinkInterval: number;
  attackThinkInterval: number;
  defenseThinkInterval: number;

  defenseHoldTimer: number;
  playerIdleTime: number;
  playerCornerCamping: boolean;
  playerLastX: number;
  playerLastZ: number;
  playerCornerStallTimer: number;

  // Stamina tracking
  prevMyStamina: number;
  prevPlayerStamina: number;
  punchesTakenByAI: number;
  playerCleanHitsLanded: number;
  punchesLandedByAI: number;
  totalDamageTaken: number;
  lastTimeTookHit: number;

  // Conditioning
  headConditionScore: number;
  bodyConditionScore: number;

  // Survival
  survivalModeActive: boolean;

  // Perfect reactions
  perfectReactActive: boolean;
  perfectReactUntil: number;
  nextPerfectReactTime: number;
  perfectReactFadeFrac: number;
  perfectReactBelowFullStaminaTimer: number;
  forcedGuard: boolean;
  forcedHigh: boolean;
  forcedLow: boolean;
  forcedDuck: boolean;
  stepOutDesiredMove: number;

  // Base defense reaction, step-out half. Optional because HMR keeps live
  // brains: updateAI backfills the block before anything reads it.
  /** 0 idle, 1 stepping out off the punch, 2 walking the same ground back in. */
  baseDefStepPhase?: 0 | 1 | 2;
  /** Pixels left in the current leg, charged against ground actually covered. */
  baseDefStepRemainingPx?: number;
  /** Ground the outward leg actually took, which is exactly what leg two repays. */
  baseDefStepOutX?: number;
  baseDefStepOutZ?: number;
  /** Turn, in radians, applied to the step-out's straight-back direction. Only
   *  the escape from an armed charge asks for one, and never past a quarter
   *  turn, so the step can never carry the AI forward into what is coming. */
  baseDefStepTurn?: number;
  /** Safety expiry, so a step into the ropes cannot hold the feet forever. */
  baseDefStepTimer?: number;

  // Held AI perfect block — mirrors the player's V-key hold: stays open for its
  // whole duration and negates every punch that lands inside it.
  perfectBlockHoldTimer: number;   // seconds of hold left on an armed AI perfect block
  /**
   * How much this fighter blocks on purpose, 0..1. Only a fundamentals seed moves
   * it off the neutral default — everyone else keeps the reflex rates the AI has
   * always used. See `perfectBlockIntent` in aiFundamentals.
   */
  perfectBlockIntent01: number;
  perfectBlockHoldMs: number;      // adaptive hold length, clamped to the Defense-scaled max

  /** Seconds since the last fatigue Reset roll. Rolled once a second, not per tick. */
  resetRollTimer: number;

  // Anticipatory perfect block: armed BEFORE the player commits, off their
  // close-and-fire history. Base chance by difficulty, nudged by career rank.
  careerRank: number | null;       // opponent's career rank; null outside career bouts
  anticipationChance: number;      // adaptive 0..0.99
  nextAnticipationTime: number;    // gameTime gate
  anticipationArmed: boolean;
  timingAdjustLocked: boolean;     // stun freeze: no timing adaptation for the rest of the round

  // Player offense pattern tracking (close-and-fire rate + last 5 bursts)
  playerCloseEvents: number;
  playerCloseAndFireEvents: number;
  playerCloseWatchActive: boolean;
  playerCloseWatchUntil: number;
  playerDistSampleTimer: number;
  playerDistSampleLast: number;
  playerPrevPunching: boolean;
  playerPunchRegistered: boolean;
  playerFeintRolled: boolean;
  playerBurstPunches: number;
  playerBurstStartTime: number;
  playerBurstLastPunchTime: number;
  playerBurstHistory: { punches: number; duration: number }[];

  // Pressure offense: close into the player's fighting band, commit to a combo, follow it
  pressureActive: boolean;
  pressureUntil: number;
  pressureCooldown: number;
  pressureFollowupsLeft: number;
  pressureCounterWindowUntil: number;

  // Combo chase: tracking the player's movement to stay in range mid-combo
  comboChaseChance: number;
  comboChaseActive: boolean;
  comboChaseAdaptTimer: number;

  // Movement
  desiredMoveInput: number;
  desiredMoveZ: number;
  lateralDir: 1 | -1;
  lateralSwitchTimer: number;
  hitReactRetreatTimer: number;
  hitReactLateralDir: 1 | -1;

  // Counter mode
  counterModeActive: boolean;

  // Directional targeting
  directionalSlider01: number;
  playerHighBlockHeldSeconds: number;
  playerLowBlockHeldSeconds: number;

  // Scorecard
  scorecardBias: number;
  /**
   * How far behind on landed punches the AI is this round, 0 (even or ahead)
   * .. 1 (being shut out). Recomputed every tick from the live round stats and
   * read by the string runner, which trades scripted non-punching segments for
   * punches when it is losing the exchange count.
   */
  punchDeficit: number;

  // Archetype biases
  classAggressionBias: number;
  classRangeBias: number;
  classComboBias: number;

  // Winner mind
  winnerMindIntensity: number;
  winnerMindRoll01: number;

  // Rhythm cut
  rhythmCutAggression01: number;
  rhythmCutCommitChanceRoll01: number;
  rhythmCutUntil: number;
  nextRhythmCutAllowedTime: number;

  // Jab doctrine
  jabDoctrineRoll01: number;

  // Reroll thresholds
  nextWinnerMindRerollAtTaken: number;
  nextRhythmCutCommitRerollAtTaken: number;
  nextJabDoctrineRerollAtTaken: number;
  nextRhythmCutAggressionDriftAtLanded: number;

  // Combo runner state
  comboActive: boolean;
  comboSteps: AiComboStep[];
  comboStepIndex: number;
  comboStepTimer: number;
  comboCooldown: number;

  // Stamina-penalty combo limiting: triggered when the AI eats a burst stamina
  // penalty for re-punching too much. Caps future combos to 2-3 punches for a
  // window, with escalating trigger chance for consecutive penalties in-window.
  comboLimitTimer: number;
  comboLimitMax: number;
  staminaPenaltyStreak: number;
  staminaPenaltyCooldown: number;

  // Game time reference
  gameTime: number;

  // Range constants (in pixels, computed from block-to-pixel mapping)
  attackRangeMin: number;
  attackRangeMax: number;
  idealRangeNeutral: number;
  idealRangePressure: number;
  idealRangeWhiffPunish: number;
  idealRangeCounter: number;
  idealRangeSurvival: number;
  rangeWidth: number;
  counterRangeWidth: number;

  // Player landed punch tracking for repeat penalty
  playerLandedPunchCounts: Record<string, number>;

  // AI style system (varied per seed and archetype)
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
  adaptationRate: number;
  engageCycleTimer: number;
  engageCyclePhase: "out" | "in";
  defenseCycleTimer: number;
  playerGuardDropTimer: number;
  playerDuckApproachTimer: number;
  playerBodyAttackRatio: number;
  playerBodyAttackCount: number;
  playerHeadAttackCount: number;
  playerRetreatTimer: number;
  playerSustainedDuckTimer: number;
  playerDuckPunchCount: number;
  playerDuckPunchDecay: number;
  styleSustainedDuckCounter: number;
  stylePostDodgeFollowup: number;
  lastPunchDodgedTimer: number;
  playerCrossCount: number;
  playerTotalPunchCount: number;
  playerLastDefenseSwitch: number;
  playerPrevDefenseState: string;
  recentPlayerPunches: string[];
  playerApproaching: boolean;

  postFeintWindow: number;
  postFeintPlayerDefense: string;
  postFeintFollowupReady: boolean;

  reactionDelayTimer: number;
  reactionDelayBase: number;
  reactionDelayPerHit: number;
  reactionDelayConsecutiveHits: number;
  reactionDelayConsecutiveDecay: number;

  adaptiveMemory: AdaptiveMemory | null;

  // Rhythm timing read: AI learns to time punches to player's rhythm center
  lastKnownPlayerSwaySpeed: number;
  rhythmTimingAccuracy: number;

  // Attack range learning: AI snapshots distance on each landed punch, builds average
  landedPunchDistSnapshots: number[];
  aiLearntRangeAvg: number;

  // AI own rhythm management
  aiRhythmChangeTimer: number;
  aiRhythmTargetLevel: number;
  aiRhythmSpeedMult: number;

  // Attack range forgetting: chance escalates +3% per crit/stun, resets each round
  rangeForgetChance: number;
  // Range-whiff learning: pixel shortfalls from punches that could not reach.
  rangeWhiffDeficits: number[];
  rangeLearnClosePx: number;
  rangeCloseIntentTimer: number;
  lastRangeWhiffPunch: PunchType | null;

  // Duck-aware targeting bias — re-rolled each time player duck state transitions
  duckBodyBias: number;       // body% when player is ducking (0.60–0.90)
  standHeadBias: number;      // head% when player is standing (0.60–0.90)
  prevPlayerDuckState: boolean;

  // Whiff / unclean-shot learning
  whiffSnapshots: WhiffSnapshot[];
  whiffLearnTimer: number;
  whiffLearnRangeNudge: number;    // pixel offset applied to ideal engagement range
  whiffLearnBodyBiasNudge: number; // probability nudge on body/head split
  whiffLearnKdPenalty: number;     // cumulative penalty from KDs this round (5-10% each)

  // Directional guard system
  guardHighProb: number;
  guardReactionTimer: number;
  guardReactionDelay: number;
  guardPendingSwitch: "high" | "low" | null;
  guardConditioningMemory: Array<{ zone: "head" | "body"; damage: number; time: number }>;
  guardConditioningMax: number;
  guardPredictionConfidence: number;
  guardFatigueReactionPenalty: number;

  // Pre-duck uppercut sequence (Elite/Champion proactive duck-then-uppercut)
  preDuckUppercutActive: boolean;
  preDuckUppercutTimer: number;
  preDuckUppercutQueue: string[];
  preDuckUppercutCooldown: number;

  // Pressure Drop Recovery: AI uses PDR when far from player
  aiPdrActive: boolean;
  aiPdrRollTimer: number;

  // Rhythm Cut Timing Autocorrect
  rcDelayTimer: number;
  rcNudgeActive: boolean;
  rcTimingLearntMs: number;
  rcMissOffsetMs: number;

  // Rhythm Cut Drift (stun-induced timing disruption, CPU-only, fires once per eligibility window)
  aiStunCount: number;
  playerStunCount: number;
  rcDriftApplied: boolean;

  // Charge punch bar targeting
  aiChargeTargetBars: number;
  // Delay (seconds) before arming a targeted charge — rolled when target is set
  aiChargeArmDelayTimer: number;

  // Boxing-stance switch system (pre-rolled before fight, triggers on clean-hit streaks)
  stanceSwitchChance: number;     // 0.10–0.30, pre-rolled
  stanceSwitchDuration: number;   // 5–45 s, pre-rolled
  stanceSwitchTimer: number;      // countdown; 0 = eligible again
  stanceCleanHitStreak: number;   // consecutive clean unblocked punches landed by AI this streak
  stanceCleanStreakTriggers: number; // how many ≥3-streak events have occurred

  // ===== Offense/defense execution layer (per-fighter deterministic profile) =====
  offense: import("@shared/schema").OffenseProfile;
  execIntensity: number;            // difficulty scaling 0..1 (Journeyman minimal → Champion full)
  bodyCampaignActive: boolean;      // currently running a body-work campaign
  bodyCampaignUntil: number;        // gameTime when campaign ends
  bodyCampaignCooldown: number;     // countdown before next campaign may start
  bodyCampaignCashIn: boolean;      // pending head-shot cash-in after campaign
  chargedAmbushCooldown: number;    // countdown between close-range charged ambushes
  chargeRespectCooldown: number;    // min gap between reactions to an armed player charge

  // ── Fight-to-win layer ─────────────────────────────────────────────────────
  // Every field here is optional on purpose: HMR keeps live brains across a
  // reload and brains from an older build predate them entirely, so updateAI
  // backfills the whole block before anything reads it.
  /** Decaying seconds the opponent has spent standing tall / crouched, in range. */
  playerStandWindow?: number;
  playerDuckWindow?: number;
  /** Share of punches aimed downstairs: the base moved by that posture read. */
  adaptiveBodyBias?: number;
  /** Beat held back while the AI waits for its own weight transfer to peak. */
  powerSwayWaitTimer?: number;
  /** Gate on the power-sway roll so it is not re-rolled at frame rate. */
  powerSwayRollCooldown?: number;
  /** Sway speed the last string punch was thrown from, and whether it peaked. */
  lastThrowSwayLevel?: number;
  lastThrowInPowerSway?: boolean;
  /** Per-sway-level throw/land tallies. What the rhythm adaptation grades itself on. */
  swayLevelThrows?: Record<number, number>;
  swayLevelLanded?: Record<number, number>;
  /** 0..1 neural weight: how hard the AI chases its best-scoring sway speed. */
  rhythmSwayAdapt01?: number;
  /** Fight-recording counters. Diagnostic only; nothing reads them to decide. */
  statPowerSwayThrows?: number;
  statPowerSwayLanded?: number;
  statPunchesThrown?: number;
  statBodyPunchesThrown?: number;
  statOffenseSuppressedTicks?: number;
  statReflexHeldOffTicks?: number;
  statInRangeTime?: number;

  // ── Defensive timing ───────────────────────────────────────────────────────
  // The rhythm-cut sync pointed the other way: instead of timing a punch into
  // the opponent's sway window, time a perfect block onto the opponent's punch.
  // The read is a rolling five-interval window over their last punches, never a
  // fight-long clock average -- see the notes above the constants in ai.ts.
  /** Start times of the opponent's recent punches. Gaps between them are the read. */
  playerPunchTimes?: number[];
  /** Mean of the usable gaps in that window, and how many there were. */
  playerPunchIntervalAvg?: number;
  playerPunchIntervalCount?: number;
  /** Observed jab windup: the flight time a block has to beat. */
  playerJabFlightSec?: number;
  /** Separation the opponent's recent punches actually landed from. */
  playerLandRanges?: number[];
  playerLandRangeAvg?: number;
  /** Live separation, so the notifiers can record a landing range without fighters. */
  lastKnownDistPx?: number;
  /** Edge detector for "the opponent started a punch". */
  pbSyncPrevPunching?: boolean;
  /** A predicted block is up and waiting to be graded. */
  pbSyncActive?: boolean;
  /** Latest the live prediction may be graded before it is written off untrained. */
  pbSyncExpiresAt?: number;
  /**
   * Outcome of the punch that resolved the prediction, settled at the end of
   * the tick rather than on first notification: 0 none, 1 got through, 2 blocked.
   * A blocked punch fires both the hit and the guard notifier, in that order.
   */
  pbSyncPendingResolve?: 0 | 1 | 2;
  /** Impact time of that punch, captured when the first notifier fired. */
  pbSyncPendingAt?: number;
  /** Set when a string armed it, so the reflex layer does not cancel that string. */
  pbSyncFromString?: boolean;
  /** Raw (uncorrected) impact time the live block was aimed at. */
  pbSyncPredictedImpact?: number;
  /** One commit roll per predicted punch rather than one per tick. */
  pbSyncRolledFor?: number;
  pbSyncRollPassed?: boolean;
  pbSyncCooldownUntil?: number;
  /** Learned timing error, EMA in ms. Positive = punches arrive later than predicted. */
  pbTimingLearntMs?: number;
  pbSyncMissOffsetMs?: number;
  /** Fight-recording counters. Diagnostic only. */
  statBlockSyncArmed?: number;
  statBlockSyncLanded?: number;

  // -- Gas awareness ----------------------------------------------------------
  // Past its burst cap every extra punch costs 1.5^excess stamina, so an unaware
  // AI can punch a full bar to nothing in about a second. Whether it is gassed is
  // read live off the fighter, never latched -- an early return in updateAI would
  // otherwise strand the hold on forever. These fields are bookkeeping only.
  /** Edge detector so one gassing episode counts as one pull-out, not one a tick. */
  gasHoldActive?: boolean;
  statGasPullouts?: number;
  statGasHoldSec?: number;

  // -- Rhythm Attacking -------------------------------------------------------
  // Landing a timed rhythm cut on the opponent flips the AI into an all-offence
  // pursuit sequence. A "chain" is one cold sequence plus every continuation it
  // rolls into; the three tolerances below are re-rolled once a whole chain ends,
  // so each chain has its own shape. Distinct from rhythmCut* (the AI's own
  // cut-*attempt* timing layer) and from the fighter's rhythmCutPending slow.
  /** Punch budget rolled for the chain's opening sequence. */
  raBudgetRoll?: number;
  /** Perfect blocks the player may land before the sequence breaks off. */
  raPerfectBlockTol?: number;
  /** Punches the player may avoid before the sequence breaks off. */
  raAvoidedTol?: number;
  /** Total budget of the sequence currently running; halves on each chain link. */
  raSeqBudget?: number;
  raActive?: boolean;
  /** Gassed mid-sequence: holds position in the chain without spending it. */
  raPaused?: boolean;
  raPunchesLeft?: number;
  raPerfectBlocks?: number;
  raAvoided?: number;
  /** Consecutive rhythm cuts landed inside this sequence; 3% chain chance each. */
  raCutStreak?: number;
  /** A stun may open a chain only once; cleared when the whole chain runs out. */
  raStunTriggerUsed?: boolean;
  /** Recording counters. Diagnostic only. */
  statRaSequences?: number;
  statRaChains?: number;
  // -- Pattern memory ---------------------------------------------------------
  // Three-action chunks of the opponent's offence, the ones seen often enough to
  // be worth a prepared answer, and the counter script currently running. Lives
  // in aiPatterns.ts; optional because hot-reloaded and saved brains predate it.
  patterns?: AiPatternMemory;
  /** Punches a pattern counter wants thrown back, best first. Queued rather than
   *  thrown on the spot: the read happens inside the engine's punch-trigger hook,
   *  which has no way to make the AI punch, so the next AI tick drains this
   *  through the ordinary throw handshake and every gate that comes with it. */
  patternPunchQueue?: PunchType[];
  /** Brain clock past which an unanswered counter-punch is no longer a counter. */
  patternPunchUntil?: number;
  /** Set while a pattern's perfect block against body work is holding its duck
   *  on the punch rather than on the block window, which is shorter than a slow
   *  punch. Released by the pattern tick the moment the punch starts back, and
   *  cleared outright at a knockdown, where that tick never runs. */
  patternDuckHoldUntilRetract?: boolean;
  /** Which punch that held duck is being held for, so it ends when that punch
   *  does rather than bleeding onto the next one. One PAST the count while the
   *  hold was armed against a charge, whose punch does not exist yet. */
  patternDuckHoldPunchId?: number;
  /** Brain clock past which a duck held against an armed charge stops waiting.
   *  A charge is legally holdable for several seconds; the crouch under it is
   *  not, or reading the charge would be worse than missing it. */
  patternDuckHoldUntil?: number;

  lastLandedPunchType: PunchType | null; // last punch the AI landed clean (for doubling up)
  lastLandedPunchTime: number;
  postExchangeGuardUntil: number;   // gameTime until which post-exchange discipline holds guard
  headSpamLastPunchTime: number;    // rolling player punch-start intervals for rhythm read
  headSpamIntervals: number[];
  headSpamDuckUntil: number;        // timed duck window when a predictable rhythm is read
  bodySpamDuckUntil: number;        // low-defense window while player spams body shots
  bodySpamCounterReadyUntil: number; // window for over-the-top counter after ducking body spam

  // --- situation-driven fundamental switching (Champion only) ---
  /** Whether this brain may re-derive its knobs part-way through a bout. */
  fundamentalSwitching?: boolean;
  /** What the knobs were first blended into. */
  neuralBase?: NeuralBaseline;
  /** Rolling read of the situation this brain is in. */
  situationTracker?: SituationTracker | null;
  situationReadAcc?: number;
  /** Fundamental currently in effect, or null for the champion's own mix. */
  activeFundKey?: string | null;
}

export type RingZone = "center" | "ropeN" | "ropeS" | "ropeE" | "ropeW" | "cornerNE" | "cornerNW" | "cornerSE" | "cornerSW";

export interface ObservedPattern {
  kind: string;
  zone: RingZone;
  round: number;
  fightTime: number;
  playerStaminaDelta: number;
  aiStaminaDelta: number;
  damageToAi: number;
  damageToPlayer: number;
  comboSequence: string | null;
  confidence: number;
  count: number;
  playerStaminaFrac: number;
  aiStaminaFrac: number;
}

export interface TimingSlot {
  id: string;
  base: number;
  nudge: number;
  confidence: number;
  maxNudge: number;
  riskCost: number;
}

export interface AdaptiveMemory {
  observations: ObservedPattern[];
  timingBase: TimingSlot[];
  roundsOfData: number;
  lastReviewTime: number;
  midRoundReviewTimer: number;
}

export interface KnockdownChances {
  kd1: number;
  kd2: number;
  kd3: number;
}

export const AI_KD_CHANCES: Record<AIDifficulty, KnockdownChances> = {
  journeyman: { kd1: 0.80, kd2: 0.50, kd3: 0.20 },
  contender:  { kd1: 0.85, kd2: 0.75, kd3: 0.30 },
  elite:      { kd1: 1.00, kd2: 1.00, kd3: 0.75 },
  champion:   { kd1: 1.00, kd2: 1.00, kd3: 1.00 },
};

export type PunchType = "jab" | "cross" | "leftHook" | "rightHook" | "leftUppercut" | "rightUppercut";

export type FightPhase = "menu" | "classSelect" | "prefight" | "fighting" | "roundEnd" | "fightEnd" | "levelUp";

export type FightResultType = "KO" | "TKO" | "Decision" | "Draw";

export type DefenseState = "none" | "duck" | "fullGuard";

/**
 * Which way a manual slip takes the head. Aimed with the arrows while the slip
 * key is held, and read back by the counter-punch bonuses: a hook out of a back
 * slip, a left straight out of a left slip, a right straight out of a right one.
 */
export type SlipDir = "left" | "right" | "forward" | "back";

export type StanceType = "frontFoot" | "neutral" | "backFoot";
export type BoxingStance = "orthodox" | "southpaw";

export type PunchPhaseType = "launchDelay" | "armSpeed" | "contact" | "linger" | "retraction";

export type RhythmPhase = "beginning" | "middle" | "end";

export interface Vec2 {
  x: number;
  y: number;
}

export interface FighterColors {
  gloves: string;
  gloveTape: string;
  trunks: string;
  shoes: string;
  skin: string;
  /** Optional torso shirt color (used by the referee); torso renders skin-colored when absent */
  shirt?: string;
  /**
   * Sparring headgear colour. Only the player picks this — a sparring partner's
   * headgear is coloured by the difficulty they were booked at.
   */
  headgear?: string;
  /** Boxing sock colour; falls back to a neutral white when a save predates it. */
  socks?: string;
  /**
   * Shoe lace colour. Optional: when absent the laces keep deriving from the
   * shoe colour, so saves written before this existed look unchanged.
   */
  laces?: string;
  /** Shoe sole colour; derived from the shoe colour when absent. */
  soles?: string;
  /** Stripe across the top of the trunks; derived from the trunks colour when absent. */
  waistStripe?: string;
}

// Duration of the knockdown fall animation (seconds); the referee count only
// starts once the fall has finished.
export const KD_FALL_DURATION = 0.55;

// How long the BIG SHOT banner stays on screen. Shared with the renderer so the
// pop-in/fade animation lines up with the engine's timer.
export const BIG_SHOT_TEXT_DURATION = 1.6;

/**
 * Final gate on a Big Shot. The conjunction that qualifies one — charged, crit,
 * stun and a rhythm cut on the same punch — is already rare; this cuts what is
 * left by a further 90%, so the drop is a genuine once-in-a-career moment
 * rather than the guaranteed payoff of a lucky punch.
 */
export const BIG_SHOT_BASE_CHANCE = 0.10;

export const SKIN_COLOR_PRESETS = [
  "#f5d0b0", "#e8c4a0", "#d4a574", "#c49a6c", "#a87040", "#8d5524", "#6b3a1f", "#3b1f0e",
];

export interface DoghouseOpponentSpec {
  rosterId: number;
  name: string;
  archetype: Archetype;
  armLength: number;
  colors: FighterColors;
  level: number;
  skillPoints?: { power: number; speed: number; defense: number; stamina: number; focus: number };
  refinement?: Record<string, number>;
}

export const DEFAULT_PLAYER_COLORS: FighterColors = {
  gloves: "#cc2222",
  gloveTape: "#eeeeee",
  trunks: "#2244aa",
  shoes: "#1a1a1a",
  skin: "#e8c4a0",
  headgear: "#2244aa",
  socks: "#f0f0f0",
};

export const DEFAULT_ENEMY_COLORS: FighterColors = {
  gloves: "#1155cc",
  gloveTape: "#dddddd",
  trunks: "#222222",
  shoes: "#2a1a1a",
  skin: "#c49a6c",
  headgear: "#8a2222",
  socks: "#e6e6e6",
};

/**
 * Energy fatigue and the Reset action.
 *
 * Energy is a third fatigue axis, separate from stamina and the rhythm meter.
 * Punches taken drain it; a drained fighter's torso and forearms lag behind
 * their footwork in an inertia sway that degrades blocking, punch registration,
 * damage and animation speed. Reset (B) snaps the stance clean and suspends
 * those penalties for a window.
 *
 * Deliberately namespaced away from the `sway*` fields on FighterState: those
 * belong to the RHYTHM sweep, which is a different mechanic entirely. Nothing
 * here is surfaced as text -- the fighter's body is the only readout.
 *
 * Wholly per-bout. startFight builds a fresh one for every corner.
 */
export interface FatigueState {
  /** Current Energy. Falls only; may pass zero, since total loss is uncapped. */
  energy: number;
  /**
   * Energy ceiling, sampled once from the fighter's CURRENT stamina at bout
   * start. A live read would be circular -- Energy loss spends current stamina,
   * so the ceiling would chase a number it is itself lowering.
   */
  maxEnergy: number;
  /**
   * Whether that sample has been taken yet. It happens on the first fighting
   * tick rather than in startFight, because Nightmare, Doghouse and the
   * quick-fight handicap sliders all rescale the stamina pool AFTER the corner
   * is built -- sampling any earlier reads a pool that is about to change.
   */
  sampled: boolean;
  /** Punches taken this bout. The axis every fatigue ramp is measured on. */
  punchesTaken: number;
  /** Punches taken since the last Reset. Drives both cost escalations. */
  consecutiveTaken: number;
  /**
   * Punches taken since the last Reset, counted from the very first one rather
   * than from the end of the free-punch grace. Every hit pushes this fighter's
   * duck a little further behind their input; only a Reset wipes the debt.
   */
  duckLagHits: number;
  /**
   * Punches that have landed on this fighter since their last Reset without
   * being perfect blocked. Each one widens their own rhythm vulnerability
   * window, so a fighter who keeps eating shots rather than resetting is
   * progressively easier to catch in his rhythm. A Reset wipes it.
   */
  vulnStack: number;
  /**
   * Seconds left of the forced rhythm burst a Reset opens with: the sway runs
   * at full speed on a level-1 rhythm whether or not the fighter is walking,
   * then hands back to their own footwork. 0 whenever no Reset burst is live.
   */
  rhythmBurstTimer: number;
  /** Energy spent but not yet converted into stamina (converts in steps of 5). */
  staminaCarry: number;

  /** Elapsed seconds into the current inertia sway, or 0 when idle. */
  swayTimer: number;
  /** Total length of the sway in flight. Ramps with punchesTaken. */
  swayDuration: number;
  /** +1 = the fighter last walked toward the opponent, -1 = away. */
  swayDir: number;
  /** True for the whole sway animation, including the arm's trailing tail. */
  swayActive: boolean;
  /**
   * Stamped when a punch is launched during a sway, and read at contact. The
   * sway can end while the punch is still in flight, so the penalty has to ride
   * the punch rather than be re-tested on arrival.
   */
  swayPunch: boolean;

  /** Reset window is suspending the sway penalties. */
  resetActive: boolean;
  /** Seconds left in the window, which is the length of the snap animation. */
  resetTimer: number;
  /**
   * A punch got through during the window. The Reset keeps running — the air it
   * buys is still paid — but every other benefit it was worth is off until the
   * fighter spends another full Reset.
   */
  resetStaminaOnly: boolean;
  /** Seconds a stun has locked this fighter out of Reset for. */
  resetLockTimer: number;
  /**
   * Career bouts only: punches that have got through since the last Reset and
   * are banked into how much slower the NEXT Reset plays, plus the punches
   * still owed to the grace before banking starts again. Spending a Reset
   * spends the bank. Per-bout state like everything else here — a fighter is
   * built fresh for every bout, so neither can leak into the next one.
   */
  snapSlowPunches: number;
  snapSlowGrace: number;
  /**
   * The slow-down the live snap was actually armed with, kept so the head dip's
   * own curve can be read back against the same length the timer was set from.
   * 1 whenever nothing is banked, which is every bout outside a career fight.
   */
  snapSlowMult: number;
  /** Elapsed seconds into the staggered torso -> lead arm -> rear arm snap. */
  snapTimer: number;
  /** Gap between snap stages. Stretches as current stamina falls. */
  snapStagger: number;
  /**
   * Full length of the snap animation (staggered torso/arms AND the head dip),
   * which is the Reset window. Never shorter than the head dip, so a fully
   * trained stagger of 0 can't collapse the window to a single tick.
   */
  snapDuration?: number;
  snapActive: boolean;
  /**
   * Per-arm sway offsets frozen at the instant of a Reset. The torso snaps
   * straight away; each arm keeps holding its own value until its turn comes
   * round, which is what makes the snap read as staggered rather than instant.
   */
  snapArmHoldLead: number;
  snapArmHoldRear: number;
  /**
   * Torso sway frozen at the same instant. The torso no longer jumps home the
   * moment a Reset is pressed — it eases out of this over the snap's first
   * stage, with each forearm following in its own.
   */
  snapTorsoHold: number;
  /**
   * Career-trained buy-backs, in percentage points: how much of the sway's
   * blocking penalty and damage debuff this fighter has cancelled, and how much
   * faster they slip inside their own Reset. Zero for anyone untrained, which
   * is the plain fatigue behaviour.
   */
  trainBlock: number;
  trainDamage: number;
  trainSlip: number;
  /**
   * Seconds shaved off the Reset's own snap by sparring mileage — the career's
   * lifetime spar count, less whatever has rusted back on from idle weeks.
   * Zero for anyone untrained, which is the plain Reset speed.
   */
  trainSpeed: number;
  /**
   * Gym work toward those buy-backs, tallied for this bout only: charge punches
   * landed clean, and slips started inside an active Reset. Lives here rather
   * than on GameState because a fighter is built fresh for every bout, so these
   * cannot leak across one. Only ever banked out of gym work.
   */
  gymChargeLanded: number;
  gymResetSlips: number;
  /**
   * Debug dial: how hard fatigue bites for this fighter, 1 being the shipped
   * rate. Scales the ramp, so a higher value reaches the same designed maximum
   * off fewer punches rather than pushing any penalty past its ceiling. Only the
   * Neural Network test ring ever moves it.
   */
  strengthMult: number;
  /** Counts down the subtle head dip that opens a Reset. */
  headDuckTimer: number;
  /** Max stamina surrendered to panic Resets this bout, in points. */
  maxStaminaPenalty: number;
}

export interface FighterState {
  name: string;
  archetype: Archetype;
  level: number;
  x: number;
  z: number;
  y: number;
  prevX: number;
  prevZ: number;
  currentMoveDir: "forward" | "backward" | "none";
  punchMoveDir: "forward" | "backward" | "none";
  /**
   * Last non-none currentMoveDir, retained after the fighter stops. The inertia
   * sway travels the way the fighter last walked, so it still needs a direction
   * once the feet have already settled.
   */
  lastWalkDir: "forward" | "backward" | "none";
  fatigue: FatigueState;
  stamina: number;
  maxStamina: number;
  maxStaminaCap: number;
  /**
   * Rounded max stamina the HUD has already acknowledged for THIS fighter.
   * Undefined means "never tracked" -- the pool watcher snapshots it on first
   * sight rather than reporting the whole pool as a loss. Lives on the fighter
   * so corner swaps can't misattribute one fighter's pool to another.
   */
  poolShown?: number;
  staminaRegen: number;
  facing: 1 | -1;
  facingAngle: number;
  headOffset: Vec2;
  leftGloveOffset: Vec2;
  rightGloveOffset: Vec2;
  bodyOffset: Vec2;
  bobPhase: number;
  bobSpeed: number;
  baseBobSpeed: number;
  defenseState: DefenseState;
  preDuckBlockState: DefenseState | null;
  guardBlend: number;
  isPunching: boolean;
  currentPunch: PunchType | null;
  currentPunchStaminaCost: number;
  punchProgress: number;
  punchCooldown: number;
  isHit: boolean;
  hitTimer: number;
  critHitTimer: number;
  cleanHitEyeTimer: number;
  regenPauseTimer: number;
  moveSpeed: number;
  punchSpeedMult: number;
  damageMult: number;
  defenseMult: number;
  staminaCostMult: number;
  knockdowns: number;
  knockdownsGiven: number;
  punchesThrown: number;
  jabThrown?: number;
  hookThrown?: number;
  uppercutThrown?: number;
  punchesLanded: number;
  cleanPunchesLanded: number;
  feintBaits: number;
  damageDealt: number;
  /** Perfect blocks this fighter made this bout (RL reward tally). */
  perfectBlocksMade?: number;
  /** Charged punches this fighter threw that failed to land this bout (RL reward tally). */
  chargedPunchesMissed?: number;
  timeSinceLastLanded: number;
  timeSinceLastDamageTaken: number;
  damageTakenRegenPauseFired: boolean;
  kdRegenBoostActive: boolean;
  unansweredStreak: number;
  momentumRegenBoost: number;
  momentumRegenTimer: number;
  isPlayer: boolean;
  isKnockedDown: boolean;
  knockdownTimer: number;
  duckTimer: number;
  /**
   * Seconds this fighter has been holding the current duck. Distinct from
   * duckTimer, which the AI pre-seeds to fake a crouch already in progress —
   * this one only ever counts real elapsed time, which is what the duck lag
   * has to be measured against.
   */
  duckHoldTime: number;
  colors: FighterColors;
  isFeinting: boolean;
  isCharging: boolean;
  chargeTimer: number;
  stance: StanceType;
  handsDown: boolean;
  halfGuardPunch: boolean;
  rhythmLevel: number;
  rhythmProgress: number;
  /** Set once per tick: is this fighter actually walking? No footwork, no rhythm. */
  rhythmWalking?: boolean;
  rhythmDirection: number;
  punchPhase: PunchPhaseType | null;
  punchPhaseTimer: number;
  /** The punch in flight has already reached the target's hitbox and been resolved. */
  punchHitResolved?: boolean;
  isRePunch: boolean;
  retractionProgress: number;
  earlyRepunchPenaltyTimer: number;
  staminaPauseFromRhythm: number;
  staminaPenaltyPending: boolean;
  speedBoostTimer: number;
  punchAimsHead: boolean;
  blockTimer: number;
  maxBlockDuration: number;
  blockRegenPenaltyTimer: number;
  blockRegenPenaltyDuration: number;
  punchingWhileBlocking: boolean;
  burstPunchCount: number;
  burstPunchTimer: number;
  duckHoldTimer: number;
  duckDrainCooldown: number;
  duckProgress: number;
  backLegDrive: number;
  frontLegDrive: number;
  moveSlowMult: number;
  moveSlowTimer: number;
  pushbackVx: number;
  pushbackVz: number;
  guardDownTimer: number;
  guardDownSpeedBoost: number;
  guardDownBoostTimer: number;
  guardDownBoostMax: number;
  stunBlockDisableTimer: number;
  stunBlockWeakenTimer: number;
  stunPunchDisableTimer: number;
  stunPunchSlowMult: number;
  stunPunchSlowTimer: number;
  /** Stun stops the feet dead for a beat. Separate from moveSlowMult, which only scales. */
  stunMoveFreezeTimer: number;
  chargeCooldownTimer: number;
  chargeReadyWindowTimer: number;
  chargeReady: boolean;
  chargeArmed: boolean;
  chargeUsesLeft: number;
  /** Refunds still available for whiffed charged punches, reset on every arm. */
  chargeWhiffForgivenessLeft?: number;
  /** chargeArmTimer as it stood when the current charged punch was thrown, so a
   *  forgiven whiff can put the armed window back exactly as it was. */
  chargeArmTimerAtThrow?: number;
  chargeArmTimer: number;
  chargeMeterCounters: number;
  chargeMeterBars: number;
  chargeEmpoweredTimer: number;
  chargeEmpoweredDuration: number;
  chargeMeterLockoutTimer: number;
  chargeHoldTimer: number;
  chargeFlashTimer: number;
  chargeHeadOffset: number;
  blockFlashTimer: number;
  rhythmHitFlashTimer: number;
  punchTravelStartTime: number;
  consecutiveChargeTimer: number;
  consecutiveChargeCount: number;
  feintWhiffPenaltyCooldown: number;
  retractionPenaltyMult: number;
  armLength: number;
  aiGuardDropTimer: number;
  aiGuardDropCooldown: number;
  telegraphPhase: "none" | "down" | "up" | "duckDown" | "duckUp";
  telegraphTimer: number;
  telegraphDuration: number;
  telegraphPunchType: PunchType | null;
  telegraphIsFeint: boolean;
  telegraphIsCharged: boolean;
  telegraphRhythmPaused: boolean;
  telegraphIsLockout: boolean;
  postPunchLockoutTimer: number;
  postPunchLockoutDuration: number;
  fastTwitchRank: number;
  pendingPunchInput: PunchType | null;
  pendingPunchInputTimer: number;
  pendingPunchCharged: boolean;
  pendingPunchBody: boolean;
  timeSinceLastPunch: number;
  timeSinceGuardRaised: number;
  perfectBlockActive: boolean;
  perfectBlockTimer: number;
  perfectBlockFlashTimer: number;
  perfectBlockState: "idle" | "rising" | "active" | "cooldown";
  perfectBlockRiseTimer: number;
  perfectBlockHoldTimer: number;
  perfectBlockCooldownTimer: number;
  perfectBlockGloveYOffset: number;
  perfectBlockKeyWasUp: boolean;
  /**
   * Manual slip: the head slides off the punch line and the torso tilts with it.
   * The head is only actually off the line once that slide finishes, and only for
   * a short window after it — a head shot arriving while the fighter is still
   * moving, or after they have sat in the slipped position too long, lands. Body
   * shots are untouched throughout. Holding pins the fighter in place, the hold is
   * capped, and nothing locks the next slip out — but every slip costs stamina,
   * consecutive ones more, and eating a head shot mid-slip locks it out briefly.
   */
  slipActive: boolean;
  slipDir: SlipDir;
  /**
   * Seconds since this slip started. Both the slide and the dodge window that
   * follows it are measured off this.
   */
  slipTimer: number;
  /** Seconds this slip takes to slide into position, stamped when it starts. */
  slipEnterDuration: number;
  /** Seconds of hold left before the slip lapses on its own. */
  slipHoldTimer: number;
  /** Lockout left after being caught in the head mid-slip. */
  slipDisabledTimer: number;
  /**
   * Slip chain: how long is left for the next slip to still count as consecutive,
   * and how many consecutive ones have been paid for so far. Every slip re-arms
   * the window and charges a step more stamina than the one before it.
   */
  slipChainTimer: number;
  slipChainCount: number;
  /** The slip key has to be released before another slip can start. */
  slipKeyWasUp: boolean;
  /** 0..1 eased lean. Outlives the slip itself so the torso snaps back. */
  slipLean: number;
  /** Lean the current slip started its slide from, so a re-slip does not pop. */
  slipLeanStart: number;
  /** Direction the visible lean is in — held through the snap-back. */
  slipLeanDir: SlipDir;
  /** Mid-slip crossover: the side the head is travelling away from, else null. */
  slipSwitchFrom: SlipDir | null;
  /** Slip direction latched when the current punch was thrown, for the counter bonuses. */
  slipDirAtPunch: SlipDir | null;
  /** Scheduled slip: seconds until it fires, and the direction it will take. */
  slipPendingTimer: number;
  slipPendingDir: SlipDir | null;
  /**
   * Time left to grade the AI's current read-slip. Runs from the moment the slip
   * is scheduled until it dodges something, gets caught, or simply lapses — the
   * verdict is what moves the AI's learned slip delay.
   */
  slipReadAttemptTimer: number;
  /** The opponent punch that read-slip was scheduled against; only it can grade it. */
  slipReadPunchId: number;
  /**
   * How long this fighter's AI waits after reading a punch before it slips.
   * Learned over the bout: reading the punch is free, timing the slip off that
   * read is not.
   */
  slipReadDelay: number;
  /**
   * Punches landed on this fighter this bout that it did not perfect block.
   * Every ten of them wear its slip chance down, and the count runs for the whole
   * bout rather than the round.
   */
  slipReadHitsTaken: number;
  /** Raised on the throw so the AI's input read can be taken on the next tick. */
  punchInputUnread: boolean;
  turnPunchPenaltyActive: boolean;
  blinkTimer: number;
  blinkDuration: number;
  isBlinking: boolean;
  /** Blinks still owed and the countdown to the next one — the stun lockout's double tell. */
  blinkQueued: number;
  blinkQueueTimer: number;
  /** While this runs the eyes stay open no matter what — see onResetFullyPlayed. */
  blinkQuietTimer: number;
  /** Reaction flinch: the live animation, its length, travel and vertical sign. */
  flinchTimer: number;
  flinchDuration: number;
  flinchMag: number;
  flinchDirY: number;
  /** Flinches reacted to this bout — each one takes 5% off the next. */
  flinchReactions: number;
  /** A Reset owes the next flinch a pass for this long. */
  flinchNegateTimer: number;
  /** Edge detector for "this fighter's crouch went live" as a flinch trigger. */
  flinchDuckSeen: boolean;
  /** Feints sold per punch-and-stance since that punch was last thrown for real in range. */
  feintFlinchCounts: Record<string, number>;
  /** Non-perfect-blocked shots taken upstairs and down — decides which way the hands slide. */
  shotsTakenHead: number;
  shotsTakenBody: number;
  feintTelegraphDisableTimer: number;
  feintedTelegraphBoost: number;
  telegraphKdMult: number;
  telegraphRoundBonus: number;
  telegraphFeintRoundPenalty: number;
  telegraphSlowTimer: number;
  telegraphSlowDuration: number;
  /**
   * Telegraph tell — the rhythm lift, 0..1. Eases to 1 while this fighter is
   * winding a punch up and back to 0 once it fires; scales their own rhythm
   * sweep by that much of TELEGRAPH_RHYTHM_SPEEDUP. Advanced by `advanceSway`,
   * so it only ever moves on a tick the marker itself moves on.
   */
  telegraphRhythmBoost: number;
  duckSpeedMult: number;
  blockMult: number;
  critResistMult: number;
  /**
   * Equipment Upgrades — Hand Wraps. Multiplier on how long a perfect block can
   * be held before it drops. Absent = 1.
   */
  perfectBlockHoldMult?: number;
  /**
   * Equipment Upgrades — Mouthguard. Share of a crit's BONUS damage this
   * fighter shrugs off, 0–1. Absent = none. Distinct from `critResistMult`,
   * which moves how often a crit lands rather than what it costs.
   */
  critDamageResistPct?: number;
  /**
   * Equipment Upgrades — Mouthguard. Chance any single max-stamina loss is
   * negated outright, 0–1. Knockdown-attributed losses are exempt.
   */
  maxStaminaNegateChance?: number;
  rhythmCritVulnStack: number;
  /**
   * Iron Chin. Share of an incoming punch's stun chance this fighter shrugs off,
   * 0–1. Applied on top of `critResistMult`, which the defense stat owns.
   */
  ironChinStunResist: number;
  /**
   * Iron Chin. Share of incoming punch damage this fighter absorbs, 0–1. Adds
   * with Punch Rolling's reduction rather than multiplying against it.
   */
  ironChinDamageReduction: number;
  critMult: number;
  stunMult: number;
  focusT: number;
  defenseT: number;
  speedT: number;
  facingLockTimer: number;
  facingTurnDelay: number;
  facingPendingTimer: number;
  /**
   * Set the moment this fighter makes contact with a punch (a blocked or
   * perfect-blocked punch counts; a slipped one does not) and cleared the moment
   * the opponent makes contact back. While it is set the fighter has no turn
   * delay at all — the body tracks the opponent instantly.
   */
  turnDelayCancelled: boolean;
  /**
   * Running total, in seconds, of every turn-delay event this fighter has set
   * off so far this round (landing, being hit, perfect blocks, crits, slips,
   * knockdowns). Signed, added on top of the base turn delay, and reset at the
   * bell. Never banks more reduction than would take the base delay to zero.
   */
  turnDelayAdjust: number;
  /**
   * Seconds left on a window where this fighter has no turn delay at all,
   * whatever the base delay and their accumulated adjustment say. Opened by
   * landing a perfect block.
   */
  turnDelayZeroTimer: number;
  stunFacingSlowTimer: number;
  stunFacingTurnDelay: number;
  ironChinStunSlowReduction: number;
  telegraphSpeedMult: number;
  punchLaunchDamageMult: number;
  rawPower: number;
  rawStamina: number;
  /** Raw speed stat points, for rules that outrun the soft-capped speedT. */
  rawSpeed: number;
  handsDownTimer: number;
  handsDownCooldown: number;
  feintHoldTimer: number;
  feintTouchingOpponent: boolean;
  feintDuckTouchingOpponent: boolean;
  /** Limbs are touching and this fighter's rhythm is the more exposed of the
   *  two: no walking toward the opponent and no jabs. Recomputed every tick. */
  limbContactPinned?: boolean;
  /** Roster id whose assigned punch-animation profiles this fighter wears (3D
   *  view only). Unset → the per-punch default profile. */
  punchProfileRosterId?: number;
  /** Pinned AND the opponent is holding a feint into the contact: jab and
   *  cross inputs fail outright. Recomputed every tick. */
  limbContactStraightsLocked?: boolean;
  /** F was tapped: the next punch launched while feintArmTimer runs goes out as
   *  a feint. Launching it spends the arm immediately, with no cooldown. */
  feintArmed?: boolean;
  feintArmTimer?: number;
  autoGuardActive: boolean;
  autoGuardTimer: number;
  autoGuardDuration: number;
  lastSpacePressTime: number;
  spaceWasUp: boolean;

  // Pressure Drop Recovery
  pressureDropTimer: number;
  pdRecoveryActive: boolean;
  pdPrevX: number;
  pdPrevZ: number;

  swayPhase: number;
  swayDir: 1 | -1;
  swayOffset: number;
  swaySpeedLevel: number;
  swayFrozen: boolean;
  swayZone: "power" | "offBalance" | "neutral";
  swayDamageMult: number;
  swayTelegraphMult: number;
  miniStunTimer: number;
  rhythmPauseTimer: number;
  rhythmCutHitsLanded: number;
  precisionStrikerRangeBonus?: number;
  precisionStrikerDodgeNegate?: number;
  /** Item-granted flat dodge chance. The Slippery refinement no longer feeds it. */
  slipperyDodgeBonus?: number;
  /** Slippery refinement: multiplier on how fast the fighter slides into a slip. */
  slipperySpeedMult?: number;
  dodgePenalty?: number;
  /**
   * The fighter-wide additive power pool, as a fraction. Every "more power"
   * source the fighter carries — the Pressure Fighter refinement, Fight Gloves,
   * item boosts — ADDS its percentage here rather than multiplying `damageMult`.
   * At hit time it is summed with the per-punch bonuses below and applied to the
   * base stat exactly once. Two +50% sources are +100%, never +125%.
   */
  powerBonusPct: number;
  /**
   * Per-punch-family power from the Straight/Hook/Uppercut refinements, as
   * BONUSES (0.4 means +40%), not multipliers. Only the family matching the
   * punch being thrown joins the sum.
   */
  refJabBonus?: number;
  refHookBonus?: number;
  refUppercutBonus?: number;
  refJabCritMult?: number;
  refHookCritMult?: number;
  refUppercutCritMult?: number;
  duckStaminaRegenMult?: number;
  punchRollingMult?: number;
  chinHitterVulnBonus?: number;
  chinHitterChargeDamageMult?: number;
  pressureBlockDmgMult?: number;
  chargePunchFullBlock?: boolean;
  /** Guard Master 100: perfect block keeps working through rhythm vulnerability. */
  pbIgnoresRhythmVuln?: boolean;
  /**
   * Perfect block is on hold because this fighter's rhythm went through the cut
   * window. Latched: it arms the moment the marker reaches the cut range at
   * either end of the arc, and only clears once the marker is back outside the
   * (wider) vulnerability window — so the hold outlasts the cut itself.
   */
  pbRhythmCutLatched?: boolean;
  chargeJabBlockBypass?: number;
  chargeHookBlockBypass?: number;
  chargeUppercutBlockBypass?: number;
  /** Straight/Hook/Uppercut refinement at level 100: flat chance for that punch
   *  family to ignore a normal block. Never applies to a perfect block. */
  straightBlockIgnoreChance?: number;
  hookBlockIgnoreChance?: number;
  uppercutBlockIgnoreChance?: number;
  /** Bruiser: chance for any punch thrown from an outer quarter of the thrower's
   *  own sway to ignore the guard. Unlike the three above, this one also beats a
   *  perfect block. */
  bruiserBlockIgnoreChance?: number;
  /** The thrower's own rhythm position (0-1) captured the moment the current punch
   *  was thrown, or null if their sway wasn't sweeping. Bruiser is graded on this,
   *  never on the live value at contact. */
  punchThrowRhythmProgress?: number | null;
  /** Chance a landed rhythm cut stuns outright (L1 5% → L100 45%). This is the
   *  whole of Technician's rhythm-cut effect; it replaced an older pause/slow
   *  debuff package, so there is no lingering sway-slow state any more. */
  technicianRcStunChance?: number;
  /** Technician: whiffed charged punches this arm may be refunded, +1 per 20 levels (max 5). */
  technicianChargeWhiffForgiveness?: number;
  technicianFeintCancelUnlocked?: boolean;
  technicianAccuracyBoost?: number;
  feintCancelActive?: boolean;
  feintCancelTimer?: number;
  feintCancelDuration?: number;
  feintCancelPunchType?: PunchType | null;
  feintCancelCharged?: boolean;
  feintCancelBody?: boolean;
  repunchPenaltyMult?: number;
  /** Life Drain — fraction of max stamina given back 1s after a clean punch lands. */
  lifeDrainPct?: number;
  /** KO Artist — charge meter units gained per second (100 units = one of the six
   *  bars) while the fight is live and nobody is on the canvas. */
  koArtistChargeRate?: number;
  /**
   * The refinement levels this fighter was built with, kept so the Bout Details
   * panel can show the right numbers when the primary opponent is swapped
   * mid-fight (Nightmare cycles through several).
   */
  refinementLevels?: Record<string, number>;
  // Value this fighter's rhythm stamina pause held *before* the punch being
  // resolved sapped it, so an on-hit effect can tell a pre-existing debuff
  // apart from the one its own punch just caused.
  selfRhythmSapPrevPause?: number;
  // Clean punches this fighter has taken this fight (every 10 shrinks the pool).
  cleanPunchesTakenFight?: number;
  /**
   * Max stamina this fighter has lost to rhythm cuts so far this bout, in
   * points. Kept so the rule can stop at half the pool they walked in with.
   */
  rhythmCutPoolLost?: number;
  /**
   * Punch Endurance: real punches this fighter gets per slice of max stamina
   * burned off for the rest of the bout (30 when nothing sets it), and how many
   * they have thrown since the last slice went.
   */
  punchEndurance?: number;
  punchesSincePoolDrain?: number;
  /**
   * PERCENT of the pool this fighter walked in with, taken each time that
   * counter comes round — the "1" in "1% of max stamina every 30 punches". 1 when
   * nothing sets it, which is where every career and every AI corner starts; a
   * decay cycle away from the heavy bag adds a point, a bag session takes one off.
   * The loss is permanent for the bout: it lowers {@link maxStaminaHardCeiling}.
   */
  punchEnduranceLoss?: number;
  /**
   * Max stamina this fighter walked into the bout with, snapshotted on the first
   * tick once every setup multiplier has landed. The ceiling a charged crit/stun
   * refund can restore the pool to.
   */
  boutStartMaxStamina?: number;
  /**
   * The bar the pool can never climb back past for the rest of the bout, lowered
   * by every permanent loss (Punch Endurance) this fighter has paid. Undefined
   * until the first one lands, at which point it replaces the bout-start pool as
   * the ceiling a refund restores to.
   */
  maxStaminaHardCeiling?: number;
  /**
   * Seconds this fighter has spent moving in the current ROUND, in any
   * direction. Reset at every round boundary, and rolls over each time it buys a
   * max-stamina drain so only the remainder within the round is kept.
   */
  movingTime?: number;
  /** Guards against one tick being charged mileage twice -- see accrueRingMileage. */
  mileageChargedThisTick?: boolean;
  /**
   * Life Drain heals still counting down. Each clean landed punch pushes one
   * entry; the fight loop fires and drops it when its timer runs out.
   */
  slipperyRepunchThreshold?: number;
  slipperyCloseRangeStreak?: number;
  punchRollingRepunchBoost?: number;
  /**
   * Chance to shrug off a BIG SHOT — the punch still lands for its full
   * multiplied damage, it just doesn't drop this fighter on the spot.
   */
  punchRollingBigShotNegate?: number;
  /** The mouthguard's share of the same save — stacks with the one above. */
  equipmentBigShotNegate?: number;
  /**
   * Drilled Actions: the player's live drilling context for this bout — the
   * career list, the three-link window in progress, and whether counters may
   * move. Attached to the player after startFight in any career-linked bout and
   * absent everywhere else. It rides the fighter rather than the game state
   * because the throw path has to stamp the closing bundle before the punch's
   * stamina is charged, and it has the fighter in hand and no ambient state.
   */
  drilled?: DrilledFightState | null;
  /**
   * What the punch currently in flight is worth from drilling. Stamped when the
   * throw is accepted, because the stamina and animation halves are decided
   * then while the power/crit/stun halves are spent later in hit resolution.
   */
  drilledPunch?: DrilledPunchStamp | null;
  /** Post-string dodge window (Mastered strings only), counting down. */
  drilledDodgeTimer?: number;
  /** Burst stamina-penalty count paused by a landed free closing punch. */
  drilledBurstPauseTimer?: number;
  boxingStance: BoxingStance;
}

/** The drilled bonuses riding on one in-flight punch. */
export interface DrilledPunchStamp {
  /** Everything the closed string is worth, or null when it closes nothing. */
  closing: DrilledClosingBuffs | null;
  /** This punch is the mastered opener of some fully drilled string. */
  mastered: boolean;
}

export interface PunchConfig {
  damage: number;
  staminaCost: number;
  speed: number;
  range: number;
  isLeft: boolean;
  hitsHead: boolean;
}

export interface JudgeScore {
  player: number;
  enemy: number;
}

export interface RoundScore {
  player: number;
  enemy: number;
  judges: [JudgeScore, JudgeScore, JudgeScore];
  playerKDsThisRound: number;
  enemyKDsThisRound: number;
  playerLandedPct: number;
  enemyLandedPct: number;
  playerDamage: number;
  enemyDamage: number;
  playerLandedThisRound: number;
  enemyLandedThisRound: number;
}

export type TimerSpeed = "normal" | "double";

export type PauseAction = "resume" | "restart" | "quit" | null;

export interface GameState {
  phase: FightPhase;
  player: FighterState;
  enemy: FighterState;
  currentRound: number;
  totalRounds: number;
  roundTimer: number;
  roundDuration: number;
  roundScores: RoundScore[];
  fightResult: FightResultType | null;
  fightWinner: "player" | "enemy" | null;
  xpGained: number;
  countdownTimer: number;
  knockdownCountdown: number;
  knockdownMashCount: number;
  knockdownMashRequired: number;
  knockdownMashTimer: number;
  knockdownRefCount: number;
  knockdownActive: boolean;
  ringWidth: number;
  ringLeft: number;
  ringRight: number;
  ringTop: number;
  ringBottom: number;
  ringDepth: number;
  selectedArchetype: Archetype;
  playerLevel: number;
  enemyLevel: number;
  enemyName: string;
  isPaused: boolean;
  pauseSelectedIndex: number;
  pauseAction: PauseAction;
  pauseSoundTab: boolean;
  pauseControlsTab: boolean;
  pauseBoutDetailsTab?: boolean;
  isQuickFight: boolean;
  fatigueEnabled: boolean;
  aiDifficulty: AIDifficulty;
  cornerWalkActive: boolean;
  cornerWalkTimer: number;
  aiKdGetUpTime: number;
  aiKdWillGetUp: boolean;
  /** Career-only: opponent dropped twice in the first 45s of round 1 → forced ref-stoppage KO. */
  earlyBlitzKoActive: boolean;
  /** Ref count (4-9) at which the early-blitz stoppage fires. */
  earlyBlitzStopCount: number;
  aiKdChancePenalty: number;
  refereeVisible: boolean;
  standingFighterTargetX: number;
  standingFighterTargetZ: number;
  savedDefenseState: DefenseState;
  savedHandsDown: boolean;
  savedBlockTimer: number;
  savedStandingIsPlayer: boolean;
  kdSavedKnockedRhythmLevel: number;
  kdSavedStandingRhythmLevel: number;
  shakeIntensity: number;
  shakeTimer: number;
  hitEffects: HitEffect[];
  maxStaminaDeltaTexts: MaxStaminaDeltaText[];
  playerColors: FighterColors;
  roundStats: {
    /** Damage the punches dealt — what the judges score. Ignores the stamina floor. */
    playerDamageThisRound: number;
    enemyDamageThisRound: number;
    /** Stamina the punches actually took off the bar. Drives the towel stoppage. */
    playerActualDamageThisRound: number;
    enemyActualDamageThisRound: number;
    playerPunchesThisRound: number;
    enemyPunchesThisRound: number;
    playerLandedThisRound: number;
    enemyLandedThisRound: number;
    playerKDsThisRound: number;
    enemyKDsThisRound: number;
    playerAggressionTime: number;
    enemyAggressionTime: number;
    playerRingControlTime: number;
    enemyRingControlTime: number;
    playerPunchesDodged: number;
    enemyPunchesDodged: number;
    playerPunchesBlocked: number;
    enemyPunchesBlocked: number;
    playerDuckDodges: number;
    playerComboCount: number;
    playerConsecutiveLanded: number;
  };
  timerSpeed: TimerSpeed;
  aiBrain: AiBrainState | null;
  fightTotalDuckDodges: number;
  fightTotalCombos: number;
  fightFastTwitchBonus: number;
  kdIsBodyShot: boolean;
  kdTakeKnee: boolean;
  /** Counts up from 0 while the fall animation plays; ref count starts at KD_FALL_DURATION */
  kdFallTimer: number;
  kdFaceRefActive: boolean;
  kdFaceRefTimer: number;
  refStoppageActive: boolean;
  refStoppageTimer: number;
  refStoppageType: "mercy" | "towel" | null;
  mercyStoppageEnabled: boolean;
  towelStoppageEnabled: boolean;
  practiceMode: boolean;
  cpuAttacksEnabled: boolean;
  cpuDefenseEnabled: boolean;
  sparringMode: boolean;
  doghouseMode: boolean;
  /**
   * An Import Ticket session: the player spars a roster fighter at their real
   * level. Purely cosmetic on the state — the gym renders with its lights out,
   * the way fight week does.
   */
  importSparring?: boolean;
  /**
   * Neural Network toggle, snapshotted per fight: when on, a perfect block only
   * turns away punches thrown from the same posture the blocker is in.
   */
  directionalPerfectBlock: boolean;
  doghouseOpponentsDefeated: number;
  doghouseStaminaMult: number;
  doghousePowerMult: number;
  doghouseOpponentPool: DoghouseOpponentSpec[];
  careerFightMode: boolean;
  careerEnemySkillPoints?: { power: number; speed: number; defense: number; stamina: number; focus?: number };
  playerRefinement?: { offenseUnlocked?: boolean; defenseUnlocked?: boolean; fightIqUnlocked?: boolean; pressureFighter?: number; precisionStriker?: number; jabPower?: number; hookPower?: number; uppercutPower?: number; bruiser?: number; koArtist?: number; ironChin?: number; slippery?: number; guardMaster?: number; duckRecovery?: number; punchRolling?: number; fastTwitch?: number; heartRefinement?: number; chinHitter?: number; technician?: number; lifeDrain?: number };
  careerEnemyRefinement?: { jabPower?: number; hookPower?: number; uppercutPower?: number; bruiser?: number; koArtist?: number; ironChin?: number; slippery?: number; guardMaster?: number; duckRecovery?: number; punchRolling?: number; fastTwitch?: number; heartRefinement?: number; chinHitter?: number; technician?: number; lifeDrain?: number; pressureFighter?: number; precisionStriker?: number };
  enemyWhiffBonus: number;
  towelActive: boolean;
  towelTimer: number;
  towelStartX: number;
  towelStartY: number;
  towelEndX: number;
  towelEndY: number;
  refX: number;
  refZ: number;
  enemyColors: FighterColors;
  ringCanvasColor: string;
  /**
   * Optional ring palette. Absent on every path that has not opted in, and each
   * renderer helper falls back to its original literal, so setting it on the hub
   * repaints the hub alone and leaves bouts untouched.
   */
  ringColors?: RingColors | null;
  totalEnemyKDs: number;
  kdSequence: ("player" | "enemy")[];
  towelImmunityUsed: boolean;
  enemyRank?: number;
  fightElapsedTime: number;
  kdTimerExpired: boolean;
  koDelayTimer: number;
  // A KO'd AI stays down while the referee counts; the result is only declared
  // once knockdownCountdown passes aiKoStopTime (rolled at 2-10s).
  aiKoStopTime: number;
  aiKoPendingResult: "KO" | "TKO" | null;
  bigShotTextTimer: number;
  kdEarlyStopCheckedCount: number;
  introAnimActive: boolean;
  introAnimTimer: number;
  introAnimPhase: number;
  playerIntroPlaying: boolean;
  enemyIntroPlaying: boolean;
  playerSavedRhythmLevel: number;
  enemySavedRhythmLevel: number;
  swarmerPunchQueue: PunchType[];
  swarmerPunchIndex: number;
  swarmerPunchDelay: number;
  swarmerIsPlayer: boolean;
  recordInputs: boolean;
  inputRecording: InputRecording | null;
  cpuVsCpu: boolean;
  playerAiBrain: AiBrainState | null;
  telegraphMult: number;
  hitstopTimer: number;
  hitstopDuration: number;
  crowdBobTime: number;
  crowdKdBounceTimer: number;
  crowdExciteTimer: number;
  crowdKdSpeedTimer: number;
  cleanHitStreak: number;
  playerCurrentXp: number;
  midFightLevelUps: number;
  careerXpMult?: number;
  canSurpassLevel100?: boolean;
  /** 2088 Mouthguard: chance an incoming knockdown is shrugged off. */
  itemKdAvoidChance: number;
  /** Footwork Laces: chance an opponent's rhythm cut fails outright. */
  itemRhythmCutFailChance: number;
  /** Same mouthguard save, for an AI opponent carrying Item Distribution gear. */
  opponentItemKdAvoidChance: number;
  /** Item-id → stacks the AI opponent walked in with (drives its mods and the fight HUD). */
  opponentItems?: Record<string, number>;
  /**
   * Equipment Upgrade levels each corner walked in with, slot → level.
   *
   * Kept on the state as well as applied to the fighters so the corners the
   * engine builds mid-fight — the Nightmare ladder and the Doghouse pool — can
   * be handed the same equipment their predecessor wore. Null outside career.
   */
  playerEquipment?: Record<string, number> | null;
  opponentEquipment?: Record<string, number> | null;
  midFightLevelUpTimer: number;
  adaptiveAiEnabled: boolean;
  behaviorProfile: BehaviorProfile | null;
  tutorialMode: boolean;
  tutorialStage: number;
  tutorialStep: number;
  tutorialPrompt: string;
  tutorialPromptTimer: number;
  tutorialAiIdle: boolean;
  tutorialTracking: TutorialTracking;
  tutorialShowContinueButton: boolean;
  tutorialFightUnlocked: boolean;
  tutorialDelayTimer: number;
  tutorialCareerMode: boolean;
  menuBackground?: boolean;
  staticCamera?: boolean;
  nightmareMode: boolean;
  nightmareEnemies: FighterState[];
  nightmareAiBrains: (AiBrainState | null)[];
  nightmareKillCount: number;
  nightmareSpawnTimer: number;
  nightmareSpawnDelay: number;
  nightmareEnemyDefeated: boolean;
  nightmareLevel: number;
  nightmareDifficulty: AIDifficulty;
  nightmareTimeSurvived: number;
  nightmareRegenBoostTimer: number;
  nightmareCurrentSpawnInterval: number;
  nightmareEnemyActiveSince: number;
  nightmareQuickKOs: number;
  nightmareVeryQuickKOs: number;
  nightmareRegenBoostMult: number;
  nightmareStaminaDrainTimer: number;
  /**
   * Refinement points the first Nightmare opponent walked in with — one step of
   * the ladder (see NIGHTMARE_REFINEMENT_STEP_PCT) of what the player has
   * spent, rounded up.
   */
  nightmareRefinementBudget: number;
  /**
   * Everything the player has spent on refinement — the 100% the Nightmare
   * ladder climbs toward. Zero when refinement is still locked.
   */
  nightmareRefinementPlayerTotal: number;
  /** Nightmare opponents spawned after the first; each one is one ladder step deeper. */
  nightmareSpawnIndex: number;
  boutPlayerStaminaMult?: number;
  boutPlayerPowerMult?: number;
  boutPlayerSpeedMult?: number;
  showExpBar?: boolean;
  fightLiveXp?: number;
}

export interface TutorialTracking {
  movedLeft: boolean;
  movedRight: boolean;
  movedUp: boolean;
  movedDown: boolean;
  threwJab: boolean;
  threwCross: boolean;
  threwLeftHook: boolean;
  threwRightHook: boolean;
  threwLeftUppercut: boolean;
  threwRightUppercut: boolean;
  punchesBlocked: number;
  duckCount: number;
  autoGuardActivated: boolean;
  guardToggled: boolean;
  perfectBlockCount: number;
  rhythmChangeCount: number;
  chargeUsed: boolean;
  feintCount: number;
  punchFeintCount: number;
  rhythmHits: number;
}

export interface SequenceTracker {
  kind: string;
  startTime: number;
  startPlayerStamina: number;
  startAiStamina: number;
  startPlayerDamageDealt: number;
  startAiDamageDealt: number;
  phase: number;
  zone: RingZone;
  comboKeys: string[];
}

export interface BehaviorProfile {
  activeSequences: SequenceTracker[];
  recentPlayerMoveX: number[];
  recentPlayerMoveZ: number[];
  recentPlayerPunchTimes: number[];
  playerLastPunchTime: number;
  playerLastDuckTime: number;
  playerLastBlockTime: number;
  playerLastDodgeTime: number;
  playerLastRetreatTime: number;
  playerWasMovingForward: boolean;
  playerWasMovingBackward: boolean;
  playerWasMovingLateral: boolean;
  playerPrevX: number;
  playerPrevZ: number;
  playerPrevStamina: number;
  aiPrevStamina: number;
  exchangeStartTime: number;
  exchangeActive: boolean;
  exchangePlayerDmgStart: number;
  exchangeAiDmgStart: number;
  exchangePlayerStamStart: number;
  exchangeAiStamStart: number;
  exchangeZone: RingZone;
  exchangeComboKeys: string[];
  lastExchangeEnd: number;
  ringCutTimer: number;
  ringCutStartStamina: number;
  ringCutStartAiStamina: number;
  ringCutStartDmg: number;
  ringCutStartAiDmg: number;
  ringCutZone: RingZone;
  cornerPressureTimer: number;
  cornerPressureStartStamina: number;
  cornerPressureStartAiStamina: number;
  cornerPressureStartDmg: number;
  cornerPressureStartAiDmg: number;
  ropeEscapeTimer: number;
  ropeEscapeStartStamina: number;
  ropeEscapeStartAiStamina: number;
  ropeEscapeStartDmg: number;
  ropeEscapeStartAiDmg: number;
  centerControlTimer: number;
  centerControlStartStamina: number;
  centerControlStartAiStamina: number;
  centerControlStartDmg: number;
  centerControlStartAiDmg: number;
  lastMacroCheckTime: number;
  playerLastPunchEndTime: number;
  postPunchRetreatDetected: boolean;
  swayFireTimer: number;
}

export interface RecordedEvent {
  t: number;
  type: "move" | "punch" | "defense" | "knockdown" | "hit" | "block" | "dodge" | "stance" | "rhythm" | "charge" | "feint" | "pos" | "rhythmCutHit";
  actor: "player" | "enemy";
  data: Record<string, unknown>;
  px: number;
  pz: number;
  ex: number;
  ez: number;
  dist: number;
  pStam: number;
  eStam: number;
}

export interface InputRecording {
  fightSettings: {
    playerArchetype: Archetype;
    enemyArchetype: Archetype;
    playerLevel: number;
    enemyLevel: number;
    aiDifficulty: AIDifficulty;
    roundDuration: number;
    timerSpeed: TimerSpeed;
    totalRounds: number;
    playerArmLength: number;
    enemyArmLength: number;
    practiceMode: boolean;
    cpuVsCpu: boolean;
    playerName: string;
    enemyName: string;
  };
  rounds: RecordedRound[];
}

export interface RecordedRound {
  roundNumber: number;
  startTime: number;
  events: RecordedEvent[];
  summary: RoundRecordSummary;
  /**
   * AI counters as they stood when the round opened. They are cumulative on the
   * brain, so the dump reports the difference. Held per round rather than in a
   * module variable: that would be reset by HMR and shared between a menu
   * background fight and the real one.
   */
  aiStatsAtStart?: AiDecisionStats;
}

export interface RoundRecordSummary {
  playerPunches: Record<string, { thrown: number; landed: number; feinted: number; charged: number; body: number }>;
  enemyPunches: Record<string, { thrown: number; landed: number; feinted: number; charged: number; body: number }>;
  playerMovement: { totalDistance: number; avgDistFromEnemy: number; timeInRange: number; timeOutRange: number };
  enemyMovement: { totalDistance: number; avgDistFromEnemy: number; timeInRange: number; timeOutRange: number };
  playerDefense: { ducks: number; duckTime: number; fullGuards: number; blocksLanded: number; dodges: number };
  enemyDefense: { ducks: number; duckTime: number; fullGuards: number; blocksLanded: number; dodges: number };
  knockdowns: { player: number; enemy: number };
  /** What the AI decided, not just what landed. Absent on recordings predating it. */
  aiDecisions?: AiDecisionStats;
  duration: number;
}

/**
 * Diagnostic read-out of the AI's decision layer for a round. Counters are
 * per-round deltas; the gauges below them are the values the round ended on.
 */
export interface AiDecisionStats {
  punchesThrown: number;
  bodyPunchesThrown: number;
  powerSwayThrows: number;
  powerSwayLanded: number;
  offenseSuppressedTicks: number;
  reflexHeldOffTicks: number;
  inRangeTime: number;
  blockSyncArmed: number;
  blockSyncLanded: number;
  gasPullouts: number;
  gasHoldSec: number;
  bodyBias: number;
  playerPunchIntervalAvg: number;
  playerLandRangeAvg: number;
  playerJabFlightSec: number;
  blockTimingLearntMs: number;
  rhythmSwayAdapt: number;
  bestSwayLevel: number;
}

export interface HitEffect {
  x: number;
  y: number;
  timer: number;
  type: "normal" | "crit" | "block" | "perfectBlock" | "feint";
  text: string;
  attackerColor?: string;
  /** A landed hit that stunned or crit (the 3D view only sprays sweat on these). */
  stunOrCrit?: boolean;
}

/**
 * A tick rising out of one fighter's stamina bar when their max stamina moves.
 * `delta` is signed: negative prints an orange "-N", positive prints a green
 * "+N".
 */
export interface MaxStaminaDeltaText {
  side: "player" | "enemy";
  delta: number;
  timer: number;
}

export const MAX_STAMINA_DELTA_TEXT_LIFETIME = 1.1;

export const PUNCH_CONFIGS: Record<PunchType, PunchConfig> = {
  jab: { damage: 4.01, staminaCost: 1.36, speed: 1.26, range: 65, isLeft: true, hitsHead: true },
  cross: { damage: 5.17, staminaCost: 2.04, speed: 0.9, range: 70, isLeft: false, hitsHead: true },
  leftHook: { damage: 4.59, staminaCost: 1.7, speed: 0.81, range: 50, isLeft: true, hitsHead: true },
  rightHook: { damage: 5.74, staminaCost: 2.72, speed: 0.81, range: 50, isLeft: false, hitsHead: true },
  leftUppercut: { damage: 6.89, staminaCost: 3.74, speed: 0.675, range: 42.25, isLeft: true, hitsHead: false },
  rightUppercut: { damage: 8.04, staminaCost: 4.42, speed: 0.675, range: 42.25, isLeft: false, hitsHead: false },
};

export const ARCHETYPE_STATS: Record<Archetype, {
  maxStaminaMult: number;
  regenMult: number;
  punchCostMult: number;
  damageMult: number;
  speedMult: number;
  description: string;
}> = {
  BoxerPuncher: {
    maxStaminaMult: 1.0,
    regenMult: 1.0,
    punchCostMult: 1.0,
    damageMult: 1.0,
    speedMult: 1.0,
    description: "Balanced fighter with solid fundamentals in all areas.",
  },
  OutBoxer: {
    maxStaminaMult: 1.0,
    regenMult: 1.0075,
    punchCostMult: 0.985,
    damageMult: 0.95,
    speedMult: 1.1,
    description: "Fast and efficient. Controls distance with quick jabs.",
  },
  Brawler: {
    maxStaminaMult: 1.015,
    regenMult: 1.0,
    punchCostMult: 1.022,
    damageMult: 1.15,
    speedMult: 0.9,
    description: "Heavy hitter. Takes and dishes out big damage.",
  },
  Swarmer: {
    maxStaminaMult: 0.99,
    regenMult: 1.005,
    punchCostMult: 0.99,
    damageMult: 1.05,
    speedMult: 1.15,
    description: "Relentless pressure fighter. Overwhelms with volume.",
  },
};

export const ENEMY_NAMES = [
  "Iron Mike", "Sugar Ray", "The Hammer", "Lightning", "Stone Fist",
  "Red Glove", "The Bull", "Phantom", "Knockout Kid", "The Viper",
  "Bone Crusher", "Flash", "The Mauler", "Steel Jaw", "Cyclone",
];

export const COLOR_PRESETS = {
  gloves: ["#cc2222", "#1155cc", "#22aa22", "#ddaa00", "#aa22aa", "#ffffff", "#111111", "#ff6600"],
  gloveTape: ["#eeeeee", "#cccccc", "#222222", "#cc2222", "#1155cc", "#ddaa00"],
  trunks: ["#2244aa", "#222222", "#cc2222", "#22aa22", "#ddaa00", "#ffffff", "#aa22aa", "#ff6600"],
  shoes: ["#1a1a1a", "#2a1a1a", "#ffffff", "#cc2222", "#1155cc", "#222222"],
  laces: ["#f0ece0", "#26262a", "#cc2222", "#1155cc", "#ddaa00", "#22aa22"],
  soles: ["#e4e0d6", "#2a2a2c", "#ffffff", "#cc2222", "#1155cc", "#ddaa00"],
  waistStripe: ["#ffffff", "#111111", "#cc2222", "#1155cc", "#ddaa00", "#22aa22"],
  headgear: ["#2244aa", "#cc2222", "#22aa22", "#ddaa00", "#aa22aa", "#ffffff", "#111111", "#ff6600"],
  socks: ["#f0f0f0", "#111111", "#cc2222", "#1155cc", "#ddaa00", "#22aa22"],
};
