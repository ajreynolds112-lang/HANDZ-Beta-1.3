using UnityEngine;
using System;
using System.Collections.Generic;
using System.Reflection;
[RequireComponent(typeof(Rigidbody2D))]
[RequireComponent(typeof(FighterStats))]
public class AiBrain : MonoBehaviour
{
    public enum AiState
    {
        Approach,
        Maintain,
        Retreat,
        Panic
    }
    public enum DifficultyBand
    {
        Easy,
        Medium,
        Hard,
        Hardcore
    }
    public enum TacticalPhase
    {
        Download,
        Probe,
        Pressure,
        BodyHunt,
        WhiffPunish,
        Finish,
        Counter,
        Panic
    }
    [Header("References")]
    public Transform player;
    public FighterStats playerStats;
    public FighterClass fighterClass;
    [Header("Back-Compat Aliases")]
    public FighterStats enemyStats;
    public FighterStats myStats;
    public Rigidbody2D rb;
    public FighterController myController;
    public FighterController playerController;
    public DefenseController defense;
    public DefenseController playerDefense;
    public RhythmController rhythm;
    public RhythmController playerRhythm;
    public TimeBasedRNG rng;
    public HitstopController hitstop;
    public LevelController levelController;
    private CritController myCrit;
    private FatigueController myFatigue;
    private CritController playerCrit;
    [Header("AI Systems (must exist on AI fighter root)")]
    public AiActionDataBank dataBank;
    public AiComboRunner comboRunner;
    public AiComboLibrary comboLibrary;
    [Header("Fallback Fists (only used if combos disabled/unavailable)")]
    public FistHitbox leftFist;
    public FistHitbox rightFist;
    [Header("Clinch (AI)")]
    public bool enableAiClinch = true;
    public float clinchThinkIntervalSeconds = 0.35f;
    public float clinchAttemptCooldownSeconds = 2.75f;
    public float clinchSuccessExtraCooldownSeconds = 1.25f;
    public bool allowClinchInCounterMode = true;
    public bool allowClinchWhenBehind = true;
    public bool allowClinchWhenAhead = true;
    [Header("Clinch Weights (Reasons -> Chance Adders)")]
    [Range(0f, 1f)] public float clinchBaseChance = 0.06f;
    [Range(0f, 1f)] public float clinchLowStaminaAdd = 0.20f;
    [Range(0f, 1f)] public float clinchJustTookHitAdd = 0.18f;
    [Range(0f, 1f)] public float clinchVsFlurryAdd = 0.20f;
    [Range(0f, 1f)] public float clinchTooCloseAdd = 0.12f;
    [Range(0f, 1f)] public float clinchCounterModeAdd = 0.08f;
    [Range(0f, 1f)] public float clinchWhenWinningAdd = 0.06f;
    [Range(0.05f, 0.95f)] public float clinchMaxChance = 0.55f;
    [Header("Clinch Break / Reaction")]
    public bool enableBreakClinch = true;
    public float clinchMinHoldSeconds = 0.45f;
    public float clinchBreakCheckIntervalSeconds = 0.35f;
    [Range(0f, 1f)] public float clinchBreakBaseChance = 0.10f;
    [Range(0f, 1f)] public float clinchBreakLowStaminaAdd = 0.18f;
    [Range(0f, 1f)] public float clinchBreakVsFlurryAdd = 0.15f;
    [Range(0f, 1f)] public float clinchBreakIfPlayerInitiatedAdd = 0.12f;
    [Range(0.05f, 0.95f)] public float clinchBreakMaxChance = 0.70f;
    public bool clinchCancelsOffense = true;
    public bool clinchForcesGuardShell = true;
    private ClinchController myClinch;
    private ClinchController playerClinch;
    private float nextClinchThinkTime = 0f;
    private float nextClinchAttemptAllowedTime = 0f;
    private bool wasClinchingLastFrame = false;
    private float clinchStartTime = 0f;
    private bool playerInitiatedThisClinch = false;
    private float nextClinchBreakCheckTime = 0f;
    private float lastTimeTookHit = -999f;
    [Header("Seed / Personality")]
    public bool autoSeedFromSystemTime = true;
    public int manualSeed = 0;
    public int activeSeed;
    [Header("Fighter Class Bias (runtime)")]
    [Range(-0.3f, 0.3f)] public float classAggressionBias = 0f;
    [Range(-0.4f, 0.4f)] public float classRangeBias = 0f;
    [Range(-0.3f, 0.3f)] public float classComboBias = 0f;
    [Range(0f, 1f)] public float difficultyScore = 0.5f;
    public DifficultyBand difficultyBand = DifficultyBand.Medium;
    [Range(0f, 1f)] public float personalityAggression = 0.5f;
    [Range(0f, 1f)] public float personalityHeadBias = 0.55f;
    [Range(0f, 1f)] public float personalityGuardParanoia = 0.5f;
    [Range(0f, 1f)] public float personalityFeintiness = 0.35f;
    [Header("Winner Mind")]
    [Range(0f, 1f)] public float winnerMindBase = 0.5f;
    public float winnerMindIntensity = 0.8f;
    [Header("Scorecard Tactics (Round-to-Round)")]
    public bool enableScorecardTactics = true;
    public float scorecardRefreshInterval = 0.50f;
    [Range(0f, 0.25f)] public float aggressionPerPointDown = 0.08f;
    [Range(0f, 0.75f)] public float rangeShiftPerAggressionBias = 0.28f;
    [Range(0f, 1.25f)] public float approachReluctanceBlocksWhenAhead = 0.55f;
    [Range(0f, 1.25f)] public float retreatReluctanceBlocksWhenBehind = 0.35f;
    [Range(0f, 0.40f)] public float commitChancePerAggressionBias = 0.18f;
    [Range(0f, 0.30f)] public float disengageJitterBoostWhenAhead = 0.10f;
    [Range(0f, 0.30f)] public float pressureJitterBoostWhenBehind = 0.08f;
    private FightManager fightManager = null;
    private float nextScorecardRefreshTime = 0f;
    private int cachedCompletedRounds = 0;
    private int cachedPointDeficit_AI = 0;     // + = AI down
    private float cachedScoreAggressionBias = 0f;
    [Header("Ring / Movement")]
    public float moveSpeed = 6f;
    public float ringMinX = -7.5f;
    public float ringMaxX = 7.5f;
    [Header("Range Targets (blocks)")]
    public float idealRangeNeutral = 1.05f;
    public float idealRangePressure = 0.95f;
    public float idealRangeWhiffPunish = 1.20f;
    public float idealRangeSurvival = 1.70f;
    [Header("Counter Mode Range (blocks)")]
    public float idealRangeCounter = 1.55f;
    public float counterRangeWidth = 0.22f;
    public float rangeWidth = 0.35f;
    public float tooCloseRange = 0.55f;
    [Header("Attack Range Gate (blocks)")]
    public float attackRangeMin = 0.4f;
    public float attackRangeMax = 1.8f;
    [Header("Think Intervals (seconds)")]
    public float stateThinkInterval = 0.25f;
    public float moveThinkInterval = 0.16f;
    public float attackThinkInterval = 0.22f;
    public float defenseThinkInterval = 0.18f;
    public float phaseReevalInterval = 0.75f;
    [Header("Stamina Thresholds (fractions)")]
    public float lowStaminaFraction = 0.20f;
    public float survivalFraction = 0.20f;
    public float survivalExitFraction = 0.32f;
    public float deepSurvivalFraction = 0.03f;
    public float playerFinishFraction = 0.15f;
    [Header("Hit Detection (stamina delta)")]
    public float hitDetectThreshold = 0.75f;
    public float patternRangeMax = 2.0f;
    [Header("Survival Mode Overrides (Critical Low Stamina)")]
    public float survivalExtraRange = 0.55f;
    public bool survivalForcesDuckBlock = true;
    public float survivalReactDelaySeconds = 0.03f;
    public bool enableSurvivalPass = true;
    public float survivalPassHoldSeconds = 0.70f;
    public float survivalPassMaxDist = 1.15f;
    public float survivalPassCooldownSeconds = 1.25f;
    private bool survivalPassActive = false;
    private float survivalPassUntil = 0f;
    private float survivalPassNextAllowedTime = 0f;
    [Header("Anti-Overlap (Inside Spacing)")]
    public float overlapHardMinDist = 0.28f;
    public bool enforceAttackMinSpacing = true;
    [Header("Counter Mode (Anti-DuckPunch Cheese)")]
    public bool enableCounterMode = true;
    public float cheeseDetectMaxDistance = 1.35f;
    public float counterModeMinDurationSeconds = 2.25f;
    public float counterModeCooldownSeconds = 1.25f;
    public float cheeseMeterBuildPerSecond = 1.25f;
    public float cheeseMeterDecayPerSecond = 0.85f;
    public float cheeseTriggerThreshold = 1.0f;
    public bool counterModeReducesChasing = true;
    public float counterChaseOnlyIfBeyondBlocks = 0.75f;
    private float cheeseMeter01 = 0f;
    private bool counterModeActive = false;
    private float counterModeUntilTime = 0f;
    private float counterModeNextAllowedTime = 0f;
    [Header("Charge Punch (AI)")]
    public float chargeCheckIntervalSeconds = 0.2f;
    public float chargeHoldASeconds = 0.5f;
    public float chargeGetInRangeWindowSeconds = 2.0f;
    public float chargeRangeToleranceBlocks = 0.2f;
[Header("Charge Start Distance RNG (Difficulty-Based)")]
[Tooltip("Hard cap: AI cannot BEGIN a charge attempt if farther than this distance (blocks).")]
public float chargeStartMaxDistanceBlocks = 1.3f;
[Tooltip("Preferred start distance (blocks) for EASY (75% roll). Higher = farther, less likely to start close.")]
public float chargePreferredStartEasy = 1.15f;
[Tooltip("Preferred start distance (blocks) for MEDIUM (75% roll).")]
public float chargePreferredStartMedium = 1.10f;
[Tooltip("Preferred start distance (blocks) for HARD (75% roll).")]
public float chargePreferredStartHard = 1.05f;
[Tooltip("Preferred start distance (blocks) for HARDCORE (75% roll). Lower = more willing to start close.")]
public float chargePreferredStartHardcore = 0.95f;
[Tooltip("Chance to use the preferred start distance roll. Remaining chance rolls anywhere in [min..max].")]
[Range(0f, 1f)] public float chargePreferredStartWeight = 0.75f;
    [Header("Charge Punch Chance (Inspector, per difficulty)")]
    public float chargeChanceEasy = 0.002f;
    public float chargeChanceMedium = 0.003f;
    public float chargeChanceHard = 0.004f;
    public float chargeChanceHardcore = 0.005f;
    public float chargeChanceMultiplier = 3f;
    [Header("Strategic Charge (Context-Based)")]
    public bool enableStrategicCharge = true;
    public float chargeTriggerDistanceBlocks = 1.15f;
    public float chargeMinStartDistanceBlocks = 0.65f;
    [Range(1f, 6f)] public float chargeClosingMultiplier = 3.0f;
    [Range(0f, 1.0f)] public float chargeBehindMultPerPoint = 0.35f;
    [Range(0f, 1.0f)] public float chargeAheadPenaltyPerPoint = 0.20f;
    [Range(0.05f, 0.50f)] public float kdHuntPlayerStaminaFrac = 0.22f;
    [Range(1f, 6f)] public float kdHuntChanceMultiplier = 2.2f;
    [Range(0f, 0.35f)] public float kdHuntCloserTargetShift = 0.12f;
    [Header("Entry-Tripwire Charge Boost")]
    [Range(1f, 6f)] public float counterEntryChargeMultiplier = 3.0f;
    private float prevDistToPlayer = -1f;
    private float distToPlayerThisFrame = -1f;
    private float distVel = 0f;
    private bool playerIsClosing = false;
    private float nextChargeCheckTime = 0f;
    private bool chargeAttemptActive = false;
    private bool chargeAHeld = false;
    private float chargeHoldUntilTime = 0f;
    private float chargeMoveDeadlineTime = 0f;
    private float chargeTargetDistance = 1.0f;
    private FistHitbox.PunchType chargePlannedPunch = FistHitbox.PunchType.Cross;
    private bool chargeKdHuntMode = false;
    [Header("Evade Player Charge (AI)")]
    public bool enableEvadeOnPlayerCharge = true;
    [Range(0f, 1f)] public float evadeChargeMyStaminaThreshold = 0.90f;
    public float evadeChargeHoldSeconds = 0.35f;
    public float evadeChargeTargetDistance = 2.10f;
    public float evadeChargeCooldownSeconds = 0.55f;
    public bool debugChargeEvade = false;
    private float nextChargeEvadeAllowedTime = 0f;
    private bool chargeEvadeActive = false;
    private float chargeEvadeUntil = 0f;
    private float chargeEvadeDesiredMove = 0f;
    private bool pendingChargeEvade = false;
    private float pendingChargeEvadeExecuteTime = 0f;
    [Header("Perfect Reactions (Difficulty Input-Read Sim)")]
    public bool enablePerfectReactions = true;
    [Range(0f, 1f)] public float perfectReactDuckWeight = 0.33f;
    [Range(0f, 1f)] public float perfectReactStepOutWeight = 0.34f;
    [Range(0f, 1f)] public float perfectReactBlockWeight = 0.33f;
[Header("Perfect Reaction Weighting")]
[Tooltip("If true, the choice weights are treated as ratios and normalized to sum to 1 at selection time (does NOT modify your inspector values). If false, weights are used as raw relative weights (current behavior).")]
public bool perfectReactAutoNormalizeWeights = false;
[Range(0f, 1f)] public float perfectReactWeaveWeight = 0.18f;
[Range(0f, 1f)] public float perfectReactWeaveDuckWeight = 0.12f;
[Range(0.10f, 0.85f)] public float perfectReactWeaveMoveInput = 0.55f;
public float perfectReactWeaveHoldTimeMult = 1.10f;
[Header("Perfect Reaction Block Style")]
[Tooltip("When Perfect Reaction chooses BLOCK, chance to use directional Up/Down block instead of standard guard shell.")]
[Range(0f, 1f)] public float perfectReactPreferUpDownWhenBlocking = 0.88f;
[Tooltip("If we do use Up/Down, chance to follow the read (likelyBody->low, head->high). Remaining chance will intentionally choose the opposite to avoid robot perfection.")]
[Range(0f, 1f)] public float perfectReactDirectionalAccuracy = 0.92f;
    public float stepOutTargetDistance = 2.0f;
    public float perfectReactHoldTime = 0.22f;
    public float perfectReactCooldown = 0.35f;
    public bool allowPerfectReactFallbackWithoutPunchDetect = true;
    public bool debugPerfectReactions = false;
    private float perfectReactBelowFullStaminaTimer = 0f;
    private float perfectReactFadeFrac = 0f;
    private const float perfectReactFadeTickSeconds = 2f;
    private const float perfectReactFadeTickAmount = 0.0003f;
    private float nextPerfectReactTime = 0f;
    private float perfectReactUntil = 0f;
    private bool perfectReactActive = false;
    private float stepOutDesiredMove = 0f;
    private bool forcedGuard = false;
    private bool forcedHigh = false;
    private bool forcedLow = false;
    private bool forcedDuck = false;
private bool forcedWeave = false;
private bool forcedWeaveDuck = false;
private float weaveDesiredMove = 0f;
private float nextWeaveAllowedTime = 0f;
private bool weaveChainActive = false;
private float weaveChainStartTime = 0f;
private float weaveChainChance01 = 0f;
private bool weaveChainChanceInitialized = false;
private float weaveHitPenalty01 = 0f;
private float weaveDecisionWindowStart = 0f;
private int weaveDecisionsThisSecond = 0;
private FistHitbox.PunchType lastReactPunch = FistHitbox.PunchType.Jab;
private bool lastReactLikelyBody = false;
private float lastReactDist = 0f;
private bool lastReactHasPunchInfo = false;
    [Header("Perfect Reaction Conditioning Penalties")]
    public int repeatHitThreshold = 8;
    public float repeatPenaltyStep = 0.02f;
    public float repeatPenaltyCap = 0.25f;
    private Dictionary<string, int> playerLandedPunchCounts = new Dictionary<string, int>(32);
    [Header("Perfect Reaction Speed (Delay)")]
    public bool enablePerfectReactionDelay = true;
    public float minReactionDelaySeconds = 0.02f;
    public float reactDelayEasy = 0.22f;
    public float reactDelayMedium = 0.15f;
    public float reactDelayHard = 0.09f;
    public float reactDelayHardcore = 0.04f;
    [Range(0f, 1f)] public float reactDelayConsistentChance = 0.80f;
    [Range(0f, 1f)] public float reactDelayFasterChance = 0.10f;
    [Range(0f, 1f)] public float reactDelaySlowerChance = 0.10f;
    [Range(0.30f, 1.00f)] public float fasterDelayMult = 0.75f;
    [Range(1.00f, 2.50f)] public float slowerDelayMult = 1.35f;
    public float levelDelayMultAtLevel1 = 1.10f;
    public float levelDelayMultAtLevel100 = 0.85f;
    public AnimationCurve levelDelayCurve = AnimationCurve.Linear(0f, 0f, 1f, 1f);
    public float fatigueDelayMultAtFull = 1.15f;
    public float lowStaminaDelayMultAtZero = 1.08f;
    public bool debugReactionDelay = false;
    private bool pendingPerfectReaction = false;
    private float pendingPerfectReactExecuteTime = 0f;
    private FistHitbox.PunchType pendingPunch = FistHitbox.PunchType.Jab;
    private bool pendingLikelyBody = false;
    private float pendingDist = 0f;
    private bool pendingHasPunchInfo = false;
    [Header("Stun Input-Read Boost")]
    public bool enableStunInputReadBoost = true;
    public float stunBoostDurationSeconds = 8f;
    [Range(0f, 0.25f)] public float stunBoostHardAdd = 0.05f;
    [Range(0f, 0.25f)] public float stunBoostHardcoreAdd = 0.10f;
    private bool wasStunnedLastFrame = false;
    private float stunInputReadBoostUntil = 0f;
    private float stunInputReadBoostAdd = 0f;
    [Header("Conditioning")]
    public bool enableConditioning = true;
    public float headConditionScore = 0f;
    public float bodyConditionScore = 0f;
    public float conditionDecayPerSecond = 0.15f;
    public float headHitConditionValue = 1.0f;
    public float bodyHitConditionValue = 1.0f;
    public float feintConditionWeight = 0.4f;
    public float conditionDamageGateMin = 20f;
    public float conditionDamageGateMax = 60f;
    public float conditionDamageGate;
    public float totalDamageTaken = 0f;
    public float easyHeadConditionThreshold = 4f;
    public float easyBodyConditionThreshold = 4f;
    public float mediumHeadConditionThreshold = 6f;
    public float mediumBodyConditionThreshold = 6f;
    public float hardHeadConditionThreshold = 8f;
    public float hardBodyConditionThreshold = 8f;
    public float hardcoreHeadConditionThreshold = 10f;
    public float hardcoreBodyConditionThreshold = 10f;
    [Header("Combos")]
    public bool enableCombos = true;
    [Range(0f, 1f)] public float baseComboChance = 0.50f;
    [Range(0f, 1f)] public float pressureComboBonus = 0.20f;
    [Range(0f, 1f)] public float finishComboBonus = 0.30f;
    [Range(0f, 1f)] public float panicComboPenalty = 0.45f;
    [Header("Pattern Memory")]
    public float patternWindowSeconds = 2f;
    public float patternForgetInterval = 0.5f;
    public float counterPatternWindowDuration = 0.8f;
    private float nextPatternForgetTime = 0f;
    private int activeCounterPatternIndex = -1;
    private float counterPatternActiveUntil = 0f;
    [Header("Rhythm Control")]
    public bool aiControlsRhythm = true;
    public float rhythmChangeCooldown = 1.0f;
    public float offensiveRhythmChangeChance = 0.25f;
    private float nextRhythmChangeTime = 0f;
[Header("Rhythm Impact Debug (AI -> Player)")]
public bool debugRhythmImpactFrames = true;
[Tooltip("Target 9-frame sway to land impact on. Default = 9 (peak).")]
[Range(1, 9)] public int rhythmImpactTargetFrame = 9;
[Tooltip("Last rhythm frame (1..9) the PLAYER was on when AI damage landed (stamina-delta detection).")]
[Range(1, 9)] public int debugLastAiImpactFrame = 1;
[Tooltip("Player phase01 (0..1) sampled at impact time.")]
[Range(0f, 1f)] public float debugLastAiImpactPhase01 = 0.5f;
[Tooltip("Damage (stamina delta) detected on player for the last AI hit.")]
public float debugLastAiImpactDamage = 0f;
[Tooltip("Time.time when last AI hit was detected.")]
public float debugLastAiImpactTime = 0f;
[Tooltip("Predicted impact frame (1..9) at the moment we committed to the last attack.")]
[Range(1, 9)] public int debugLastPredictedImpactFrameAtCommit = 1;
[Tooltip("Estimated time-to-land (seconds) at commit (delay+extension approx, scaled by level speed).")]
public float debugLastPredictedTimeToLandAtCommit = 0.18f;
[Tooltip("Auto-tuning: adjusts future prediction by this many frames (can be fractional).")]
public float debugAimOffsetFrames = 0f;
[Header("Rhythm Timing Auto-Tune")]
public bool enableRhythmTimingAutotune = true;
[Tooltip("How strongly we correct after a hit. 0.25 = gentle, 0.60 = aggressive.")]
[Range(0f, 1f)] public float rhythmTimingLearnRate = 0.35f;
[Tooltip("Max absolute aim offset in frames (prevents runaway).")]
[Range(0f, 4f)] public float rhythmTimingMaxAimOffsetFrames = 2.0f;
[Tooltip("Small random nudge applied after a landed hit (keeps AI from becoming robotic).")]
[Range(0f, 1f)] public float rhythmTimingRandomNudgeFrames = 0.15f;
[Header("RhythmCut (Player Rhythm Sway Cutting)")]
public bool enableRhythmCut = true;
[Tooltip("RhythmCut only exists on Medium+.")]
public bool rhythmCutMediumPlusOnly = true;
[Tooltip("RhythmCut rolls every X seconds while eligible (independent of ThinkAttack).")]
public float rhythmCutTickSeconds = 0.03f;
[Tooltip("Minimum player aggression required before RhythmCut is allowed to attempt.")]
[Range(0f, 1f)] public float rhythmCutMinOppAggression = 0.38f;
[Tooltip("Short-window player whiffs required to make RhythmCut eligible.")]
[Range(0, 6)] public int rhythmCutWhiffTriggerCount = 2;
[Tooltip("How long a successful RhythmCut window stays open for ThinkAttack to capitalize.")]
public float rhythmCutHoldSeconds = 0.14f;
[Tooltip("Cooldown between successful RhythmCut windows.")]
public float rhythmCutCooldownSeconds = 1.10f;
[Tooltip("Chance per tick to OPEN a RhythmCut window when timing is eligible (Medium).")]
[Range(0f, 1f)] public float rhythmCutAttemptChanceMedium = 0.35f;
[Tooltip("Chance per tick to OPEN a RhythmCut window when timing is eligible (Hard).")]
[Range(0f, 1f)] public float rhythmCutAttemptChanceHard = 0.65f;
[Tooltip("Chance per tick to OPEN a RhythmCut window when timing is eligible (Hardcore).")]
[Range(0f, 1f)] public float rhythmCutAttemptChanceHardcore = 0.90f;
[Tooltip("RhythmCut tries to make IMPACT land inside this zone (wraps past peak).")]
public int rhythmCutZoneStartFrame = 7;   // inclusive (1..9)
public int rhythmCutZoneEndFrame = 11;    // inclusive (10-11 wrap to 1-2)
[Tooltip("Peak frame in the 9-frame sway model.")]
public int rhythmCutPeakFrame = 9;
[Tooltip("Timing precision: allowed frame error at impact (Medium=looser, Hardcore=tight).")]
public int rhythmCutImpactToleranceFramesMedium = 2;
public int rhythmCutImpactToleranceFramesHard = 1;
public int rhythmCutImpactToleranceFramesHardcore = 0;
[Tooltip("Bonus commit chance during an open RhythmCut window.")]
[Range(0f, 0.50f)] public float rhythmCutCommitBonus = 0.12f;
[Tooltip("Bonus combo chance during an open RhythmCut window.")]
[Range(0f, 0.50f)] public float rhythmCutComboBonus = 0.18f;
[Tooltip("Chance to force a rhythm change when RhythmCut opens (tempo cut).")]
[Range(0f, 1f)] public float rhythmCutRhythmChangeChance = 0.65f;
private float rhythmCutUntil = 0f;
private float nextRhythmCutAllowedTime = 0f;
private float nextRhythmCutTickTime = 0f;
    [Header("Clean Hits vs Volume")]
    [Tooltip("0 = volume spammer, 1 = picky counterpuncher. Seeded each run (0.2..0.8).")]
    [Range(0f, 1f)] public float preferCleanHitsOverVolume = 0.50f;
    [Header("Dynamic Combo Chance (Difficulty Bands)")]
    [Tooltip("Target combo chance floor on Easy.")]
    [Range(0f, 1f)] public float dynamicComboMinEasy = 0.25f;
    [Tooltip("Target combo chance ceiling on Hardcore.")]
    [Range(0f, 1f)] public float dynamicComboMaxHardcore = 0.80f;
    [Tooltip("How much Level (1-100) influences combo chance (0 = none, 1 = strong).")]
    [Range(0f, 1f)] public float dynamicComboLevelInfluence = 0.55f;
    [Header("Jab Doctrine")]
    [Tooltip("Extra jab tendency on higher difficulties + higher clean-hit preference.")]
    [Range(0f, 1f)] public float jabDoctrineBase = 0.35f;
    [Tooltip("How much jab doctrine scales by difficulty band.")]
    [Range(0f, 1f)] public float jabDoctrineDifficultyScale = 0.45f;
    [Tooltip("How much jab doctrine scales by Level (1-100).")]
    [Range(0f, 1f)] public float jabDoctrineLevelScale = 0.35f;
    [Tooltip("If true, when clean-hit preference is high, AI avoids hooks/uppers unless very close or KD-hunting.")]
    public bool cleanHitsPreferStraights = true;
[Header("Directional Targeting (Head vs Body)")]
public bool enableDirectionalTargeting = true;
[Tooltip("0 = pure tactical/conditioning decides. 1 = fully governed by the adaptive direction slider.")]
[Range(0f, 1f)] public float directionalTargetingInfluence = 0.55f;
[Tooltip("Read window: if player holds LOW block longer than this, AI will lean to HEAD.")]
public float playerLowBlockHeldSecondsForHeadBait = 1.0f;
[Tooltip("When player is holding HIGH block, AI leans toward BODY by this amount (temporary).")]
[Range(0f, 0.50f)] public float leanBodyWhenPlayerHighBlocking = 0.18f;
[Tooltip("When player holds LOW block longer than threshold, AI leans toward HEAD by this amount (temporary).")]
[Range(0f, 0.50f)] public float leanHeadWhenPlayerLowBlockingLong = 0.22f;
[Tooltip("Higher difficulties bias slightly toward head to force directional blocking (open body).")]
[Range(0f, 0.30f)] public float headBaitBiasMedium = 0.05f;
[Range(0f, 0.30f)] public float headBaitBiasHard = 0.10f;
[Range(0f, 0.30f)] public float headBaitBiasHardcore = 0.15f;
[Header("Directional Switch Step (per blocked-contact)")]
[Tooltip("Each time AI's HEAD shot hits UP-guard, slider moves toward BODY by this amount.")]
[Range(0f, 0.25f)] public float dirStepEasy = 0.01f;
[Range(0f, 0.25f)] public float dirStepMedium = 0.03f;
[Range(0f, 0.25f)] public float dirStepHard = 0.06f;
[Range(0f, 0.25f)] public float dirStepHardcore = 0.10f;
[Header("Directional Target Debug (read-only)")]
[Tooltip("0 = AI favors BODY. 0.5 = 50/50. 1 = AI favors HEAD.")]
[Range(0f, 1f)] public float debugDirectionalSlider01 = 0.50f;
private float directionalSlider01 = 0.50f;
private float playerHighBlockHeldSeconds = 0f;
private float playerLowBlockHeldSeconds = 0f;
private bool wasKdFrozenLastFrame = false;
    [Header("Runtime (read-only)")]
    public AiState currentState = AiState.Maintain;
    public TacticalPhase currentPhase = TacticalPhase.Download;
    private int punchesTakenByAI = 0;     // increments when AI takes a stamina-delta hit
    private int punchesLandedByAI = 0;    // increments when AI causes stamina-delta on player
    private float winnerMindRoll01 = 0.20f;
    private int nextWinnerMindRerollAtTaken = 50;
    private float rhythmCutCommitChanceRoll01 = 0.40f;
    private int nextRhythmCutCommitRerollAtTaken = 30;
    private float jabDoctrineRoll01 = 0.20f;
    private int nextJabDoctrineRerollAtTaken = 20;
    private float clinchBreakIfPlayerInitiatedRollAdd = 0.12f;
    private int nextClinchBreakIfPlayerInitiatedRerollAtTaken = 25;
    private float rhythmCutAggression01 = 0.20f;
    private int nextRhythmCutAggressionDriftAtLanded = 50;
private float rhythmAimOffsetFrames = 0f;
private bool hasCachedCommitPrediction = false;
private int cachedPredictedImpactFrame = 1;
private float cachedPredictedTimeToLand = 0.18f;
    private float desiredMoveInput = 0f;
    private float stateThinkTimer = 0f;
    private float moveThinkTimer = 0f;
    private float attackThinkTimer = 0f;
    private float defenseThinkTimer = 0f;
    private float phaseEvalTimer = 0f;
    private float prevMyStamina = -1f;
    private float prevPlayerStamina = -1f;
    private Transform playerHead;
    private float playerHeadNeutralY;
    private bool playerHeadNeutralSet = false;
    public float playerDuckOffsetThreshold = 0.05f;
    private bool survivalModeActive = false;
    void UpdateSurvivalModeState(float myFrac)
    {
        if (myFrac <= deepSurvivalFraction)
        {
            survivalModeActive = true;
            return;
        }
        float enter = Mathf.Clamp01(survivalFraction);
        float exit = Mathf.Clamp01(Mathf.Max(enter + 0.01f, survivalExitFraction));
        if (!survivalModeActive)
        {
            if (myFrac <= enter) survivalModeActive = true;
        }
        else
        {
            if (myFrac >= exit) survivalModeActive = false;
        }
    }
    void Awake()
    {
        rb = GetComponent<Rigidbody2D>();
        myStats = GetComponent<FighterStats>();
        if (myController == null) myController = GetComponent<FighterController>();
        fighterClass = GetComponent<FighterClass>();
        if (defense == null) defense = GetComponent<DefenseController>();
        if (rng == null) rng = GetComponent<TimeBasedRNG>();
        if (dataBank == null) dataBank = GetComponent<AiActionDataBank>();
        if (rhythm == null) rhythm = GetComponent<RhythmController>();
        hitstop = HitstopController.GetFor(this);
        levelController = LevelController.GetFor(this);
        myCrit = GetComponent<CritController>();
        myFatigue = FatigueController.GetFor(this);
        if (comboRunner == null) comboRunner = GetComponent<AiComboRunner>();
        if (comboLibrary == null) comboLibrary = GetComponent<AiComboLibrary>();
        if (comboLibrary == null) comboLibrary = FindObjectOfType<AiComboLibrary>();
        if (myController != null)
        {
            ringMinX = myController.ringMinX;
            ringMaxX = myController.ringMaxX;
        }
        AutoWireFistsIfNeeded();
        TryAutoWireOpponent();
        SetupPlayerHeadReference();
        AutoSeedAndPersonality();
        myClinch = GetComponent<ClinchController>();
        if (playerController != null) playerClinch = playerController.GetComponent<ClinchController>();
        enemyStats = playerStats;
        conditionDamageGate = UnityEngine.Random.Range(conditionDamageGateMin, conditionDamageGateMax);
        currentPhase = TacticalPhase.Download;
        currentState = AiState.Maintain;
        nextChargeCheckTime = Time.time + chargeCheckIntervalSeconds;
        if (enableScorecardTactics)
        {
            fightManager = FindObjectOfType<FightManager>();
            nextScorecardRefreshTime = Time.time + 0.10f;
        }
        nextClinchThinkTime = Time.time + clinchThinkIntervalSeconds;
        nextClinchAttemptAllowedTime = Time.time + 0.25f;
directionalSlider01 = 0.50f;
debugDirectionalSlider01 = directionalSlider01;
playerHighBlockHeldSeconds = 0f;
playerLowBlockHeldSeconds = 0f;
wasKdFrozenLastFrame = false;
nextWeaveAllowedTime = 0f;
weaveChainActive = false;
weaveChainStartTime = 0f;
weaveChainChance01 = 0f;
weaveChainChanceInitialized = false;
weaveHitPenalty01 = 0f;
weaveDecisionWindowStart = Time.time;
weaveDecisionsThisSecond = 0;
    }
    void Start()
    {
        enemyStats = (playerStats != null) ? playerStats : enemyStats;
        if (myStats != null) prevMyStamina = myStats.currentStamina;
        if (playerStats != null) prevPlayerStamina = playerStats.currentStamina;
        if (playerController != null)
            playerCrit = playerController.GetComponent<CritController>();
        if (playerCrit == null && playerStats != null)
            playerCrit = playerStats.GetComponent<CritController>();
        if (myClinch == null) myClinch = GetComponent<ClinchController>();
        if (playerClinch == null && playerController != null) playerClinch = playerController.GetComponent<ClinchController>();
        if (playerClinch == null && player != null) playerClinch = player.GetComponentInChildren<ClinchController>();
    }
    void Update()
    {
        if (myStats == null || player == null || playerStats == null) return;
        if (enemyStats == null) enemyStats = playerStats;
bool isKdFrozenNow = (myController != null && myController.isFrozenByKD);
if (isKdFrozenNow && !wasKdFrozenLastFrame)
{
    ResetDirectionalTargetingToNeutral();
}
wasKdFrozenLastFrame = isKdFrozenNow;
if (isKdFrozenNow) return;
        if (myStats.IsExhausted) return;
        if (hitstop != null && hitstop.IsInHitstop) return;
        float dt = Time.deltaTime;
UpdatePlayerDirectionalBlockHoldTimers(dt);
if (IsCurrentlyStunned() && !wasStunnedLastFrame)
{
    ResetDirectionalTargetingToNeutral();
}
        UpdateDistanceTracking(dt);
RhythmCutTick();
        RefreshScorecardBiasIfNeeded();
        RefreshClinchReferencesIfNeeded();
        if (HandleClinchOverridesAndReactions(dt))
        {
            prevDistToPlayer = distToPlayerThisFrame;
            return;
        }
        UpdateCounterModeAndCheeseDetection(dt);
        TrackStaminaHitsAndPatterns();
        UpdateConditioning(dt);
        UpdatePerfectReactionLongFightFade(dt);
        UpdateSurvivalModeState(GetMyStaminaFrac());
        if (enableStunInputReadBoost)
            UpdateStunBoostState();
        if (enableEvadeOnPlayerCharge)
        {
            TryChargeEvadeDetectAndQueue();
            TryExecutePendingChargeEvade();
            ApplyChargeEvadeOverridesIfActive();
        }
        TryChargePunchCheckTick();
        if (chargeAttemptActive)
        {
            UpdateChargeAttempt();
        }
        if (Time.time >= nextPatternForgetTime)
        {
            nextPatternForgetTime = Time.time + patternForgetInterval;
            if (dataBank != null)
            {
                float myFrac = GetMyStaminaFrac();
                dataBank.TickPatternForgetting(difficultyBand, myFrac);
            }
        }
        if (activeCounterPatternIndex >= 0 && Time.time > counterPatternActiveUntil)
            activeCounterPatternIndex = -1;
        if (enablePerfectReactions && enablePerfectReactionDelay)
        {
            TryExecutePendingPerfectReaction();
        }
        if (enablePerfectReactions)
        {
            TryPerfectReact();
            ApplyPerfectReactionOverridesIfActive();
        }
        ApplySurvivalOverrides(dt);
        if (ThinkAwake(ref stateThinkTimer, stateThinkInterval, 1f))
            EvaluateState();
        phaseEvalTimer += dt;
        if (phaseEvalTimer >= phaseReevalInterval)
        {
            phaseEvalTimer = 0f;
            EvaluatePhase();
        }
        if (ThinkAwake(ref moveThinkTimer, moveThinkInterval, 1f))
            ThinkMovement();
        if (!chargeAttemptActive)
        {
            if (ThinkAwake(ref attackThinkTimer, attackThinkInterval, GetCognitiveLoadBias()))
                ThinkAttack();
        }
        if (ThinkAwake(ref defenseThinkTimer, defenseThinkInterval, GetCognitiveLoadBias()))
            ThinkDefense();
        TryAiClinchTick();
        prevDistToPlayer = distToPlayerThisFrame;
    }
    void FixedUpdate()
    {
        ApplyMovement();
        HandleFacing();
    }
    void RefreshClinchReferencesIfNeeded()
    {
        if (myClinch == null)
            myClinch = GetComponent<ClinchController>();
        if (playerClinch == null)
        {
            if (playerController != null)
                playerClinch = playerController.GetComponent<ClinchController>();
            if (playerClinch == null && player != null)
                playerClinch = player.GetComponentInChildren<ClinchController>();
        }
    }
    bool HandleClinchOverridesAndReactions(float dt)
    {
        bool isClinchingNow = (myClinch != null && myClinch.IsClinching);
        if (isClinchingNow && !wasClinchingLastFrame)
        {
            clinchStartTime = Time.time;
            nextClinchBreakCheckTime = Time.time + Mathf.Max(0.05f, clinchBreakCheckIntervalSeconds);
            playerInitiatedThisClinch = !(myClinch != null && myClinch.IStartedThisClinch);
        }
        if (!isClinchingNow && wasClinchingLastFrame)
        {
            playerInitiatedThisClinch = false;
        }
        wasClinchingLastFrame = isClinchingNow;
        if (!isClinchingNow)
            return false;
        if (clinchCancelsOffense)
        {
            if (comboRunner != null && comboRunner.IsRunningCombo)
                comboRunner.StopCombo();
            if (chargeAttemptActive)
                CancelChargeAttempt();
            pendingPerfectReaction = false;
            perfectReactActive = false;
            forcedGuard = forcedHigh = forcedLow = forcedDuck = false;
            stepOutDesiredMove = 0f;
        }
        desiredMoveInput = 0f;
        if (clinchForcesGuardShell && defense != null)
        {
            defense.AiSetAutoGuard(true);
            defense.AiSetHighBlock(true);
            defense.AiSetLowBlock(false);
            defense.AiSetDuck(false);
        }
        if (enableBreakClinch && myClinch != null)
        {
            float held = Time.time - clinchStartTime;
            if (held >= Mathf.Max(0f, clinchMinHoldSeconds) && Time.time >= nextClinchBreakCheckTime)
            {
                nextClinchBreakCheckTime = Time.time + Mathf.Max(0.05f, clinchBreakCheckIntervalSeconds);
                float chance = Mathf.Clamp01(clinchBreakBaseChance);
                float myFrac = GetMyStaminaFrac();
                if (myFrac <= lowStaminaFraction)
                    chance += clinchBreakLowStaminaAdd;
                if (IsPlayerInFlurryWindow())
                    chance += clinchBreakVsFlurryAdd;
                if (playerInitiatedThisClinch)
                    chance += clinchBreakIfPlayerInitiatedRollAdd;
                chance = Mathf.Clamp(chance, 0.01f, clinchBreakMaxChance);
                float roll = (rng != null) ? rng.Next01() : UnityEngine.Random.value;
                if (roll <= chance)
                {
                    myClinch.ForceEndClinch();
                    nextClinchAttemptAllowedTime = Time.time + Mathf.Max(0.10f, clinchAttemptCooldownSeconds);
                }
            }
        }
        return true;
    }
    void TryAiClinchTick()
    {
        if (!enableAiClinch) return;
        if (myClinch == null) return;
        if (myClinch.IsClinching) return;
        if (survivalModeActive) return;
        if (chargeEvadeActive) return;
        if (chargeAttemptActive) return;
        if (comboRunner != null && comboRunner.IsRunningCombo) return;
        if (Time.time < nextClinchAttemptAllowedTime) return;
        if (Time.time < nextClinchThinkTime) return;
        nextClinchThinkTime = Time.time + Mathf.Max(0.05f, clinchThinkIntervalSeconds);
        if (currentPhase == TacticalPhase.Counter && !allowClinchInCounterMode)
            return;
        int deficit = GetPointDeficitAI();
        bool behind = deficit > 0;
        bool ahead = deficit < 0;
        if (behind && !allowClinchWhenBehind)
            return;
        if (ahead && !allowClinchWhenAhead)
            return;
        float chance = ComputeAiClinchChance(deficit);
        float roll = (rng != null) ? rng.Next01() : UnityEngine.Random.value;
        if (roll > chance)
            return;
        myClinch.AttemptStartClinchAsInitiator();
        nextClinchAttemptAllowedTime = Time.time + Mathf.Max(0.10f, clinchAttemptCooldownSeconds);
        if (myClinch.IsClinching)
            nextClinchAttemptAllowedTime += Mathf.Max(0f, clinchSuccessExtraCooldownSeconds);
    }
    float ComputeAiClinchChance(int pointDeficitAI)
    {
        float chance = Mathf.Clamp01(clinchBaseChance);
        float myFrac = GetMyStaminaFrac();
        if (myFrac <= lowStaminaFraction)
            chance += clinchLowStaminaAdd;
        if (Time.time - lastTimeTookHit <= 0.90f)
            chance += clinchJustTookHitAdd;
        if (IsPlayerInFlurryWindow())
            chance += clinchVsFlurryAdd;
        float dist = GetDistanceToPlayer();
        if (dist <= Mathf.Max(0.10f, tooCloseRange))
            chance += clinchTooCloseAdd;
        if (currentPhase == TacticalPhase.Counter)
            chance += clinchCounterModeAdd;
        if (pointDeficitAI < 0)
            chance += clinchWhenWinningAdd;
        chance += Mathf.Lerp(-0.02f, 0.06f, Mathf.Clamp01(personalityAggression));
        return Mathf.Clamp(chance, 0.01f, clinchMaxChance);
    }
    bool IsPlayerInFlurryWindow()
    {
        bool playerPunching = TryDetectPlayerPunch(out _, out _);
        int whiffsShort = (dataBank != null) ? dataBank.GetWhiffCount(AiActionDataBank.Actor.Player, 0.8f, true) : 0;
        float agg = (dataBank != null) ? dataBank.GetPlayerAggression(1.2f) : 0f;
        if (playerPunching && agg >= 0.55f) return true;
        if (whiffsShort >= 3) return true;
        return false;
    }
    void ApplySurvivalOverrides(float dt)
    {
        if (!survivalModeActive) { survivalPassActive = false; return; }
        if (defense == null || player == null) return;
        if (chargeEvadeActive) return;
        if (perfectReactActive) return;
        if (comboRunner != null && comboRunner.IsRunningCombo)
            comboRunner.StopCombo();
        if (chargeAttemptActive)
            CancelChargeAttempt();
        float dist = GetDistanceToPlayer();
        float dx = player.position.x - transform.position.x;
        float dirToPlayer = Mathf.Sign(dx);
        if (dirToPlayer == 0f) dirToPlayer = 1f;
        if (survivalForcesDuckBlock)
        {
            defense.AiSetAutoGuard(true);
            defense.AiSetHighBlock(false);
            defense.AiSetLowBlock(true);
            defense.AiSetDuck(true);
        }
if (enableSurvivalPass && Time.time >= survivalPassNextAllowedTime)
{
    float ringWidth = Mathf.Abs(ringMaxX - ringMinX);
    float playerX = player.position.x;
    float spaceBehindPlayer = (dx < 0f) ? (playerX - ringMinX) : (ringMaxX - playerX);
    bool moreThanHalfRingBehind = spaceBehindPlayer > (ringWidth * 0.50f + 0.05f);
    bool closeEnoughToSlip = dist <= Mathf.Max(0.25f, survivalPassMaxDist);
    float myX = transform.position.x;
    bool nearLeftCorner = myX <= (ringMinX + 0.35f);
    bool nearRightCorner = myX >= (ringMaxX - 0.35f);
    bool cornered = nearLeftCorner || nearRightCorner;
    bool closing = playerIsClosing;
    bool cornerPassEligible = cornered && closing && closeEnoughToSlip;
    if (!survivalPassActive && (cornerPassEligible || (moreThanHalfRingBehind && closeEnoughToSlip)))
    {
        survivalPassActive = true;
        survivalPassUntil = Time.time + Mathf.Max(0.10f, survivalPassHoldSeconds);
        survivalPassNextAllowedTime = Time.time + Mathf.Max(0.10f, survivalPassCooldownSeconds);
        float r1 = Next01();
        float r2 = Next01();
        bool doGuard = r1 < 0.70f;
        bool doDuck = r2 < 0.45f;
        if (defense != null)
        {
            defense.AiSetAutoGuard(doGuard);
            if (doGuard)
            {
                bool hasPunch = TryDetectPlayerPunch(out var pp, out bool lb);
                bool wantLow = hasPunch ? lb : true;
                float jig = Next01();
                if (jig < 0.15f) wantLow = !wantLow;
                defense.AiSetHighBlock(!wantLow);
                defense.AiSetLowBlock(wantLow);
            }
            else
            {
                defense.AiSetHighBlock(false);
                defense.AiSetLowBlock(false);
            }
            defense.AiSetDuck(doDuck);
        }
    }
}
        float target = Mathf.Clamp(idealRangeSurvival + Mathf.Max(0f, survivalExtraRange), 0.75f, 2.35f);
        if (survivalPassActive)
        {
            if (Time.time > survivalPassUntil)
            {
                survivalPassActive = false;
            }
            else
            {
                desiredMoveInput = Mathf.Clamp(dirToPlayer, -1f, 1f);
                return;
            }
        }
        if (dist < target)
        {
            desiredMoveInput = Mathf.Clamp(-dirToPlayer, -1f, 1f);
        }
        else
        {
            desiredMoveInput = 0f;
        }
    }
    void RefreshScorecardBiasIfNeeded()
    {
        if (!enableScorecardTactics) return;
        if (Time.time < nextScorecardRefreshTime) return;
        nextScorecardRefreshTime = Time.time + Mathf.Max(0.05f, scorecardRefreshInterval);
        if (fightManager == null)
            fightManager = FindObjectOfType<FightManager>();
        if (fightManager == null)
        {
            cachedCompletedRounds = 0;
            cachedPointDeficit_AI = 0;
            cachedScoreAggressionBias = 0f;
            return;
        }
        Type t = fightManager.GetType();
        object obj = fightManager;
        int currentRound = 1;
        int totalRounds = 3;
        try { totalRounds = fightManager.totalRounds; } catch { totalRounds = 3; }
        int tempInt;
        if (TryGetIntMember(t, obj, "currentRound", out tempInt)) currentRound = tempInt;
        int[] pScores = null;
        int[] eScores = null;
        TryGetIntArrayMember(t, obj, "playerRoundScores", out pScores);
        TryGetIntArrayMember(t, obj, "enemyRoundScores", out eScores);
        if (pScores == null || eScores == null)
        {
            cachedCompletedRounds = 0;
            cachedPointDeficit_AI = 0;
            cachedScoreAggressionBias = 0f;
            return;
        }
        int completed = Mathf.Clamp(currentRound - 1, 0, totalRounds);
        cachedCompletedRounds = completed;
        int pTotal = 0;
        int eTotal = 0;
        for (int i = 0; i < completed && i < pScores.Length && i < eScores.Length; i++)
        {
            if (pScores[i] == 0 && eScores[i] == 0) continue;
            pTotal += pScores[i];
            eTotal += eScores[i];
        }
        int deficitAI = pTotal - eTotal;
        cachedPointDeficit_AI = deficitAI;
        float bias = 0f;
        if (completed > 0)
        {
            bias = deficitAI * aggressionPerPointDown;
            bias = Mathf.Clamp(bias, -1f, 1f);
        }
        cachedScoreAggressionBias = bias;
    }
    float GetScoreAggressionBias()
    {
        if (!enableScorecardTactics) return 0f;
        return cachedScoreAggressionBias;
    }
    int GetPointDeficitAI()
    {
        if (!enableScorecardTactics) return 0;
        return cachedPointDeficit_AI;
    }
    void UpdateDistanceTracking(float dt)
    {
        float dist = GetDistanceToPlayer();
        distToPlayerThisFrame = dist;
        if (prevDistToPlayer < 0f)
            prevDistToPlayer = dist;
        distVel = (dt > 0.0001f) ? ((dist - prevDistToPlayer) / dt) : 0f;
        playerIsClosing = distVel < -0.15f;
    }
    bool DidPlayerEnterDistanceThisFrame(float threshold)
    {
        if (prevDistToPlayer < 0f || distToPlayerThisFrame < 0f) return false;
        return (prevDistToPlayer > threshold && distToPlayerThisFrame <= threshold);
    }
    void UpdateCounterModeAndCheeseDetection(float dt)
    {
        if (!enableCounterMode) { counterModeActive = false; cheeseMeter01 = 0f; return; }
        if (counterModeActive && Time.time >= counterModeUntilTime)
        {
            counterModeActive = false;
            counterModeNextAllowedTime = Time.time + Mathf.Max(0.05f, counterModeCooldownSeconds);
        }
        if (survivalModeActive) { cheeseMeter01 = Mathf.Max(0f, cheeseMeter01 - cheeseMeterDecayPerSecond * dt); return; }
        if (chargeAttemptActive) { cheeseMeter01 = Mathf.Max(0f, cheeseMeter01 - cheeseMeterDecayPerSecond * dt); return; }
        if (chargeEvadeActive) { cheeseMeter01 = Mathf.Max(0f, cheeseMeter01 - cheeseMeterDecayPerSecond * dt); return; }
        float dist = distToPlayerThisFrame >= 0f ? distToPlayerThisFrame : GetDistanceToPlayer();
        bool inCheeseBand = dist <= Mathf.Max(0.25f, cheeseDetectMaxDistance);
        bool playerDucking = IsPlayerDucking();
        bool playerPunching = TryDetectPlayerPunch(out _, out _);
        bool cheeseNow = inCheeseBand && playerDucking && playerPunching;
        if (cheeseNow)
            cheeseMeter01 += Mathf.Max(0f, cheeseMeterBuildPerSecond) * dt;
        else
            cheeseMeter01 -= Mathf.Max(0f, cheeseMeterDecayPerSecond) * dt;
        cheeseMeter01 = Mathf.Clamp01(cheeseMeter01);
        if (counterModeActive) return;
        if (Time.time < counterModeNextAllowedTime) return;
        if (cheeseMeter01 >= Mathf.Clamp01(cheeseTriggerThreshold))
        {
            counterModeActive = true;
            counterModeUntilTime = Time.time + Mathf.Max(0.10f, counterModeMinDurationSeconds);
            cheeseMeter01 = 0f;
            if (comboRunner != null && comboRunner.IsRunningCombo)
                comboRunner.StopCombo();
            if (chargeAttemptActive)
                CancelChargeAttempt();
        }
    }
    bool IsPlayerDucking()
    {
        if (playerDefense != null)
        {
            Type dt = playerDefense.GetType();
            object dobj = playerDefense;
            if (TryGetBoolMember(dt, dobj, "isDuckActive")) return true;
            if (TryGetBoolMember(dt, dobj, "IsDuckActive")) return true;
            if (TryGetBoolMember(dt, dobj, "duckActive")) return true;
            if (TryGetBoolMember(dt, dobj, "DuckActive")) return true;
            if (TryGetBoolMember(dt, dobj, "isDucking")) return true;
            if (TryGetBoolMember(dt, dobj, "IsDucking")) return true;
        }
        if (!playerHeadNeutralSet)
            SetupPlayerHeadReference();
        if (playerHead != null && playerHeadNeutralSet)
        {
            float y = playerHead.localPosition.y;
            float delta = playerHeadNeutralY - y;
            return delta >= Mathf.Max(0.001f, playerDuckOffsetThreshold);
        }
        return false;
    }
    public void NotifyStunnedByCrit()
    {
        if (!enableStunInputReadBoost) return;
        float add = 0f;
        if (difficultyBand == DifficultyBand.Hard) add = stunBoostHardAdd;
        else if (difficultyBand == DifficultyBand.Hardcore) add = stunBoostHardcoreAdd;
        if (add <= 0f) return;
        stunInputReadBoostAdd = add;
        stunInputReadBoostUntil = Time.time + Mathf.Max(0.1f, stunBoostDurationSeconds);
    }
    void UpdateStunBoostState()
    {
        bool isStunnedNow = IsCurrentlyStunned();
        if (isStunnedNow && !wasStunnedLastFrame)
        {
            float add = 0f;
            if (difficultyBand == DifficultyBand.Hard) add = stunBoostHardAdd;
            else if (difficultyBand == DifficultyBand.Hardcore) add = stunBoostHardcoreAdd;
            if (add > 0f)
            {
                stunInputReadBoostAdd = add;
                stunInputReadBoostUntil = Time.time + Mathf.Max(0.1f, stunBoostDurationSeconds);
            }
        }
        wasStunnedLastFrame = isStunnedNow;
        if (Time.time > stunInputReadBoostUntil)
            stunInputReadBoostAdd = 0f;
    }
    bool IsCurrentlyStunned()
    {
        Component scc = GetComponent("StunCritController");
        if (scc != null)
        {
            Type t = scc.GetType();
            object obj = scc;
            if (TryGetBoolMember(t, obj, "IsStunned")) return true;
            if (TryGetBoolMember(t, obj, "isStunned")) return true;
            if (TryGetBoolMember(t, obj, "stunActive")) return true;
            if (TryGetBoolMember(t, obj, "StunActive")) return true;
            if (TryGetBoolMember(t, obj, "BlockOrDuckDisabled")) return true;
            if (TryGetBoolMember(t, obj, "blockOrDuckDisabled")) return true;
            float until;
            if (TryGetFloatMember(t, obj, "stunUntil", out until)) return Time.time < until;
            if (TryGetFloatMember(t, obj, "StunUntil", out until)) return Time.time < until;
        }
        if (defense != null)
        {
            Type dt = defense.GetType();
            object dobj = defense;
            if (TryGetBoolMember(dt, dobj, "BlockOrDuckDisabled")) return true;
            if (TryGetBoolMember(dt, dobj, "blockOrDuckDisabled")) return true;
            float until;
            if (TryGetFloatMember(dt, dobj, "blockOrDuckDisabledUntil", out until)) return Time.time < until;
            if (TryGetFloatMember(dt, dobj, "BlockOrDuckDisabledUntil", out until)) return Time.time < until;
        }
        return false;
    }
    void TryChargeEvadeDetectAndQueue()
    {
        if (!enableEvadeOnPlayerCharge) return;
        if (Time.time < nextChargeEvadeAllowedTime) return;
        if (chargeEvadeActive || pendingChargeEvade) return;
        float myFrac = GetMyStaminaFrac();
        if (myFrac >= evadeChargeMyStaminaThreshold) return;
        if (!IsPlayerChargeTriggered()) return;
        if (chargeAttemptActive)
            CancelChargeAttempt();
        float delay = enablePerfectReactionDelay ? ComputePerfectReactionDelaySeconds() : 0f;
        pendingChargeEvade = true;
        pendingChargeEvadeExecuteTime = Time.time + delay;
        nextChargeEvadeAllowedTime = Time.time + Mathf.Max(0.05f, evadeChargeCooldownSeconds);
        if (debugChargeEvade)
            Debug.Log($"[AI ChargeEvade] Queued evade (myFrac={myFrac:0.00}) delay={delay:0.000}s band={difficultyBand}", this);
    }
    void TryExecutePendingChargeEvade()
    {
        if (!pendingChargeEvade) return;
        if (Time.time < pendingChargeEvadeExecuteTime) return;
        pendingChargeEvade = false;
        if (!IsPlayerChargeTriggered())
            return;
        StartChargeEvade();
    }
    void StartChargeEvade()
    {
        float dx = player.position.x - transform.position.x;
        float dirToPlayer = Mathf.Sign(dx);
        if (dirToPlayer == 0f) dirToPlayer = 1f;
        chargeEvadeDesiredMove = -dirToPlayer;
        chargeEvadeActive = true;
        chargeEvadeUntil = Time.time + Mathf.Max(0.05f, evadeChargeHoldSeconds);
        if (defense != null)
            defense.AiSetDuck(false);
        if (debugChargeEvade)
            Debug.Log($"[AI ChargeEvade] START step-out for {evadeChargeHoldSeconds:0.00}s", this);
    }
    void ApplyChargeEvadeOverridesIfActive()
    {
        if (!chargeEvadeActive) return;
        if (Time.time > chargeEvadeUntil)
        {
            chargeEvadeActive = false;
            chargeEvadeDesiredMove = 0f;
            return;
        }
        float dist = GetDistanceToPlayer();
        if (dist >= evadeChargeTargetDistance)
        {
            chargeEvadeDesiredMove = 0f;
            return;
        }
        desiredMoveInput = Mathf.Clamp(chargeEvadeDesiredMove, -1f, 1f);
    }
    bool IsPlayerChargeTriggered()
    {
        if (playerCrit == null)
        {
            if (playerController != null) playerCrit = playerController.GetComponent<CritController>();
            if (playerCrit == null && playerStats != null) playerCrit = playerStats.GetComponent<CritController>();
        }
        if (playerCrit != null)
        {
            try { return playerCrit.ChargeReady; }
            catch { }
        }
        if (playerCrit != null)
        {
            Type t = playerCrit.GetType();
            object obj = playerCrit;
            if (TryGetBoolMember(t, obj, "ChargeReady")) return true;
            if (TryGetBoolMember(t, obj, "chargeReady")) return true;
            if (TryGetBoolMember(t, obj, "IsChargeReady")) return true;
        }
        return false;
    }
    void TryExecutePendingPerfectReaction()
    {
        if (!pendingPerfectReaction) return;
        if (Time.time < pendingPerfectReactExecuteTime) return;
        pendingPerfectReaction = false;
        TriggerPerfectReaction(pendingPunch, pendingLikelyBody, pendingDist, pendingHasPunchInfo);
        if (debugReactionDelay)
            Debug.Log($"[AI ReactDelay] Executed perfect reaction after delay at t={Time.time:0.000}", this);
    }
    void QueuePerfectReactionWithDelay(FistHitbox.PunchType punch, bool likelyBody, float dist, bool hasPunchInfo)
    {
        float delay = ComputePerfectReactionDelaySeconds();
        pendingPerfectReaction = true;
        pendingPerfectReactExecuteTime = Time.time + delay;
        pendingPunch = punch;
        pendingLikelyBody = likelyBody;
        pendingDist = dist;
        pendingHasPunchInfo = hasPunchInfo;
        if (debugReactionDelay)
            Debug.Log($"[AI ReactDelay] Queued perfect reaction delay={delay:0.000}s (band={difficultyBand}, lvl={(levelController != null ? levelController.level : 1)})", this);
    }
    float ComputePerfectReactionDelaySeconds()
    {
        float baseDelay =
            (difficultyBand == DifficultyBand.Easy) ? reactDelayEasy :
            (difficultyBand == DifficultyBand.Medium) ? reactDelayMedium :
            (difficultyBand == DifficultyBand.Hard) ? reactDelayHard :
            reactDelayHardcore;
        int lvl = (levelController != null) ? Mathf.Clamp(levelController.level, 1, 100) : 1;
        float t = Mathf.Clamp01((lvl - 1) / 99f);
        float c = (levelDelayCurve != null) ? Mathf.Clamp01(levelDelayCurve.Evaluate(t)) : t;
        float levelMult = Mathf.Lerp(levelDelayMultAtLevel1, levelDelayMultAtLevel100, c);
        float fatigueProg = 0f;
        if (myFatigue != null) fatigueProg = Mathf.Clamp01(myFatigue.FatigueProgress);
        float fatigueMult = Mathf.Lerp(1f, Mathf.Max(1f, fatigueDelayMultAtFull), fatigueProg);
        float myFrac = GetMyStaminaFrac();
        float staminaMult = Mathf.Lerp(Mathf.Max(1f, lowStaminaDelayMultAtZero), 1f, myFrac);
        float delay = baseDelay * levelMult * fatigueMult * staminaMult;
        float roll = (rng != null) ? rng.Next01() : UnityEngine.Random.value;
        float fasterP = Mathf.Clamp01(reactDelayFasterChance);
        float slowerP = Mathf.Clamp01(reactDelaySlowerChance);
        float sumFS = Mathf.Clamp01(fasterP + slowerP);
        if (sumFS > 1f)
        {
            fasterP /= sumFS;
            slowerP /= sumFS;
        }
        if (roll < fasterP)
            delay *= Mathf.Clamp(fasterDelayMult, 0.30f, 1.00f);
        else if (roll < fasterP + slowerP)
            delay *= Mathf.Clamp(slowerDelayMult, 1.00f, 2.50f);
        delay = Mathf.Max(minReactionDelaySeconds, delay);
        return delay;
    }
    void TryChargePunchCheckTick()
    {
        if (chargeAttemptActive) return;
        if (Time.time < nextChargeCheckTime) return;
        nextChargeCheckTime = Time.time + Mathf.Max(0.01f, chargeCheckIntervalSeconds);
        if (!IsChargeOffCooldown())
            return;
      float dist = distToPlayerThisFrame >= 0f ? distToPlayerThisFrame : GetDistanceToPlayer();
if (dist > Mathf.Max(chargeMinStartDistanceBlocks, chargeStartMaxDistanceBlocks))
    return;
if (dist < chargeMinStartDistanceBlocks) 
    return;
float startGate = RollChargeStartDistanceGate();
if (dist < startGate)
    return;
        float chance = GetChargeTickChanceByDifficulty();
        if (enableStrategicCharge)
        {
            int deficit = GetPointDeficitAI();
            int pointsDown = Mathf.Max(0, deficit);
            int pointsUp = Mathf.Max(0, -deficit);
            float mult = 1f;
            if (pointsDown > 0)
                mult *= (1f + pointsDown * Mathf.Clamp(chargeBehindMultPerPoint, 0f, 1f));
            if (pointsUp > 0)
                mult *= Mathf.Max(0.20f, 1f - pointsUp * Mathf.Clamp(chargeAheadPenaltyPerPoint, 0f, 1f));
            bool inTriggerBand = (dist <= chargeTriggerDistanceBlocks);
            if (inTriggerBand && playerIsClosing)
                mult *= Mathf.Max(1f, chargeClosingMultiplier);
            bool enteredTrigger = DidPlayerEnterDistanceThisFrame(chargeTriggerDistanceBlocks);
            if (counterModeActive && enteredTrigger)
                mult *= Mathf.Max(1f, counterEntryChargeMultiplier);
            float playerFrac = GetPlayerStaminaFrac();
            bool kdHunt = (pointsDown > 0) && (playerFrac <= kdHuntPlayerStaminaFrac);
            if (kdHunt) mult *= Mathf.Max(1f, kdHuntChanceMultiplier);
            chance = Mathf.Clamp01(chance * mult);
        }
        float roll = (rng != null) ? rng.Next01() : UnityEngine.Random.value;
        if (roll <= chance)
            StartChargeAttemptStrategic();
    }
    float GetChargeTickChanceByDifficulty()
    {
        float baseChance =
            (difficultyBand == DifficultyBand.Easy) ? chargeChanceEasy :
            (difficultyBand == DifficultyBand.Medium) ? chargeChanceMedium :
            (difficultyBand == DifficultyBand.Hard) ? chargeChanceHard :
            chargeChanceHardcore;
        float mult = Mathf.Max(0f, chargeChanceMultiplier);
        return Mathf.Clamp01(baseChance * mult);
    }
float RollChargeStartDistanceGate()
{
    float pref =
        (difficultyBand == DifficultyBand.Easy) ? chargePreferredStartEasy :
        (difficultyBand == DifficultyBand.Medium) ? chargePreferredStartMedium :
        (difficultyBand == DifficultyBand.Hard) ? chargePreferredStartHard :
        chargePreferredStartHardcore;
    float min = Mathf.Max(0f, chargeMinStartDistanceBlocks);
    float max = Mathf.Max(min, chargeStartMaxDistanceBlocks);
    pref = Mathf.Clamp(pref, min, max);
    float w = Mathf.Clamp01(chargePreferredStartWeight);
    float r = (rng != null) ? rng.Next01() : UnityEngine.Random.value;
    if (r <= w)
        return pref;
    float rr = (rng != null) ? rng.Next01() : UnityEngine.Random.value;
    return Mathf.Lerp(min, max, rr);
}
    bool IsChargeOffCooldown()
    {
        if (myCrit != null)
            return myCrit.chargeCooldownRemaining <= 0f;
        return false;
    }
    void StartChargeAttemptStrategic()
    {
        if (!IsChargeOffCooldown())
            return;
        if (comboRunner != null && comboRunner.IsRunningCombo)
            comboRunner.StopCombo();
        float dist = distToPlayerThisFrame >= 0f ? distToPlayerThisFrame : GetDistanceToPlayer();
        int deficit = GetPointDeficitAI();
        int pointsDown = Mathf.Max(0, deficit);
        bool kdHunt = false;
        if (enableStrategicCharge && pointsDown > 0)
        {
            float playerFrac = GetPlayerStaminaFrac();
            float r = (rng != null) ? rng.Next01() : UnityEngine.Random.value;
            if (playerFrac <= kdHuntPlayerStaminaFrac) kdHunt = true;
            else kdHunt = (r < Mathf.Clamp01(0.10f + 0.05f * pointsDown));
        }
        chargeKdHuntMode = kdHunt;
        chargeAttemptActive = true;
        chargeAHeld = true;
        chargeHoldUntilTime = Time.time + Mathf.Max(0.01f, chargeHoldASeconds);
        chargeMoveDeadlineTime = chargeHoldUntilTime + Mathf.Max(0.01f, chargeGetInRangeWindowSeconds);
        chargePlannedPunch = ChooseChargePunchByDistanceStrategic(dist, kdHunt);
        float baseTarget = GetBaseChargeDistanceForPunch(chargePlannedPunch);
        if (kdHunt)
            baseTarget = Mathf.Max(attackRangeMin, baseTarget - Mathf.Clamp(kdHuntCloserTargetShift, 0f, 0.35f));
        float jitter = ((rng != null) ? rng.Next01() : UnityEngine.Random.value) * 0.4f - 0.2f;
        chargeTargetDistance = Mathf.Clamp(baseTarget + jitter, attackRangeMin, attackRangeMax);
        SetAiAInputHeld(true);
        if (defense != null)
            defense.AiSetDuck(false);
    }
    void CancelChargeAttempt()
    {
        chargeAttemptActive = false;
        chargeKdHuntMode = false;
        if (chargeAHeld)
        {
            chargeAHeld = false;
            SetAiAInputHeld(false);
        }
    }
    void UpdateChargeAttempt()
    {
        if (!IsChargeOffCooldown())
        {
            CancelChargeAttempt();
            return;
        }
        if (Time.time > chargeMoveDeadlineTime)
        {
            CancelChargeAttempt();
            return;
        }
        if (Time.time < chargeHoldUntilTime)
        {
            desiredMoveInput = 0f;
            if (!chargeAHeld)
            {
                chargeAHeld = true;
                SetAiAInputHeld(true);
            }
            return;
        }
        if (chargeAHeld)
        {
            chargeAHeld = false;
            SetAiAInputHeld(false);
        }
        float dist = GetDistanceToPlayer();
        float dx = player.position.x - transform.position.x;
        float dirToPlayer = Mathf.Sign(dx);
        if (dirToPlayer == 0f) dirToPlayer = 1f;
        float min = chargeTargetDistance - chargeRangeToleranceBlocks;
        float max = chargeTargetDistance + chargeRangeToleranceBlocks;
        if (dist > max)
        {
            desiredMoveInput = Mathf.Clamp(dirToPlayer, -1f, 1f);
            return;
        }
        else if (dist < min)
        {
            desiredMoveInput = Mathf.Clamp(-dirToPlayer, -1f, 1f);
            return;
        }
        FistHitbox fist = GetFistForPunch(chargePlannedPunch);
        if (fist != null)
            fist.StartPunch(chargePlannedPunch);
        CancelChargeAttempt();
    }
    FistHitbox.PunchType ChooseChargePunchByDistanceStrategic(float dist, bool kdHunt)
    {
        float r = (rng != null) ? rng.Next01() : UnityEngine.Random.value;
        float dx = player.position.x - transform.position.x;
        if (!kdHunt)
            return ChooseChargePunchByDistance(dist);
        if (dist >= 1.20f)
        {
            return (r < 0.25f) ? FistHitbox.PunchType.Jab : FistHitbox.PunchType.Cross;
        }
        else if (dist >= 0.85f)
        {
            if (r < 0.55f) return FistHitbox.PunchType.Cross;
            return (dx > 0f) ? FistHitbox.PunchType.LeftHook : FistHitbox.PunchType.RightHook;
        }
        else
        {
            if (r < 0.45f) return (dx > 0f) ? FistHitbox.PunchType.LeftUppercut : FistHitbox.PunchType.RightUppercut;
            if (r < 0.80f) return (dx > 0f) ? FistHitbox.PunchType.LeftHook : FistHitbox.PunchType.RightHook;
            return FistHitbox.PunchType.Cross;
        }
    }
    FistHitbox.PunchType ChooseChargePunchByDistance(float dist)
    {
        float r = (rng != null) ? rng.Next01() : UnityEngine.Random.value;
        if (dist >= 1.20f)
        {
            return (r < 0.45f) ? FistHitbox.PunchType.Jab : FistHitbox.PunchType.Cross;
        }
        else if (dist >= 0.85f)
        {
            if (r < 0.35f) return FistHitbox.PunchType.Jab;
            if (r < 0.70f) return FistHitbox.PunchType.Cross;
            float dx = player.position.x - transform.position.x;
            return (dx > 0f) ? FistHitbox.PunchType.LeftHook : FistHitbox.PunchType.RightHook;
        }
        else
        {
            float dx = player.position.x - transform.position.x;
            if (r < 0.30f) return (dx > 0f) ? FistHitbox.PunchType.LeftHook : FistHitbox.PunchType.RightHook;
            if (r < 0.70f) return (dx > 0f) ? FistHitbox.PunchType.LeftUppercut : FistHitbox.PunchType.RightUppercut;
            if (r < 0.85f) return FistHitbox.PunchType.Cross;
            return FistHitbox.PunchType.Jab;
        }
    }
    float GetBaseChargeDistanceForPunch(FistHitbox.PunchType p)
    {
        switch (p)
        {
            case FistHitbox.PunchType.LeftUppercut:
            case FistHitbox.PunchType.RightUppercut:
                return 0.70f;
            case FistHitbox.PunchType.LeftHook:
            case FistHitbox.PunchType.RightHook:
                return 0.95f;
            case FistHitbox.PunchType.Jab:
                return 1.25f;
            case FistHitbox.PunchType.Cross:
            default:
                return 1.15f;
        }
    }
    void SetAiAInputHeld(bool held)
    {
        if (myCrit != null)
        {
            myCrit.AiSetChargeHeld(held);
            return;
        }
        if (myController == null) return;
        object obj = myController;
        Type t = obj.GetType();
        if (TryInvokeBoolMethod(t, obj, "AiSetAHeld", held)) return;
        if (TryInvokeBoolMethod(t, obj, "AiHoldA", held)) return;
        if (TryInvokeBoolMethod(t, obj, "SetAInputHeld", held)) return;
        TrySetBoolMember(t, obj, "aiAHeld", held);
        TrySetBoolMember(t, obj, "AiAHeld", held);
        TrySetBoolMember(t, obj, "isAHeld", held);
        TrySetBoolMember(t, obj, "IsAHeld", held);
    }
    void AutoSeedAndPersonality()
    {
        int seed = autoSeedFromSystemTime ? Environment.TickCount ^ GetInstanceID() : manualSeed;
        activeSeed = seed;
        System.Random prng = new System.Random(seed);
        float RandRange(float min, float max) => min + (max - min) * (float)prng.NextDouble();
        personalityAggression = RandRange(0.30f, 1.00f);
        personalityHeadBias = RandRange(0.35f, 0.80f);
        personalityGuardParanoia = RandRange(0.10f, 0.90f);
        personalityFeintiness = RandRange(0.10f, 0.70f);
        preferCleanHitsOverVolume = RandRange(0.20f, 0.80f);
        difficultyScore =
            personalityAggression * 0.28f +
            (1f - personalityGuardParanoia) * 0.18f +
            (0.5f + Mathf.Abs(personalityHeadBias - 0.5f)) * 0.18f +
            personalityFeintiness * 0.14f +
            (preferCleanHitsOverVolume) * 0.12f +
            (personalityAggression > 0.6f ? 0.10f : 0.0f);
        difficultyScore = Mathf.Clamp01(difficultyScore);
        if (difficultyScore < 0.4f) difficultyBand = DifficultyBand.Easy;
        else if (difficultyScore < 0.7f) difficultyBand = DifficultyBand.Medium;
        else if (difficultyScore < 0.9f) difficultyBand = DifficultyBand.Hard;
        else difficultyBand = DifficultyBand.Hardcore;
        InitializeDifficultyScaledRolls_OnSpawn(prng);
        winnerMindIntensity = Mathf.Lerp(0.3f, 1.1f, difficultyScore);
        winnerMindIntensity *= Mathf.Lerp(0.6f, 1.4f, winnerMindBase);
        winnerMindIntensity = Mathf.Clamp(winnerMindIntensity, 0.2f, 1.2f);
        if (rhythm != null && aiControlsRhythm)
        {
            float r = (rng != null) ? rng.Next01() : UnityEngine.Random.value;
            rhythm.rhythmSpeed = (r < 0.33f) ? 1 : (r < 0.66f) ? 2 : 3;
        }
        if (fighterClass != null)
        {
            switch (fighterClass.archetype)
            {
                case FighterClass.Archetype.OutBoxer:
                    classAggressionBias = -0.18f;
                    classRangeBias = +0.30f;
                    classComboBias = -0.10f;
                    break;
                case FighterClass.Archetype.Brawler:
                    classAggressionBias = +0.22f;
                    classRangeBias = -0.18f;
                    classComboBias = +0.12f;
                    break;
                case FighterClass.Archetype.Swarmer:
                    classAggressionBias = +0.15f;
                    classRangeBias = -0.10f;
                    classComboBias = +0.18f;
                    break;
                default:
                    classAggressionBias = 0f;
                    classRangeBias = 0f;
                    classComboBias = 0f;
                    break;
            }
        }
    }
    float Next01()
    {
        return (rng != null) ? rng.Next01() : UnityEngine.Random.value;
    }
    float RollRange01(float min01, float max01)
    {
        float r = Next01();
        return Mathf.Lerp(min01, max01, Mathf.Clamp01(r));
    }
    void InitializeDifficultyScaledRolls_OnSpawn(System.Random seededPrng)
    {
        float seedR = (float)seededPrng.NextDouble();
        clinchCounterModeAdd = Mathf.Lerp(0.10f, 0.60f, Mathf.Clamp01(seedR));
        RollWinnerMindNow();
        RollRhythmCutCommitNow();
        RollJabDoctrineNow();
        RollClinchBreakIfPlayerInitiatedNow();
        SetBaseRhythmCutAggressionByDifficulty();
    }
    void SetBaseRhythmCutAggressionByDifficulty()
    {
        if (difficultyBand == DifficultyBand.Easy)
            rhythmCutAggression01 = 0.00f; // RhythmCut is Medium+ only anyway
        else if (difficultyBand == DifficultyBand.Medium)
            rhythmCutAggression01 = 0.20f;
        else if (difficultyBand == DifficultyBand.Hard)
            rhythmCutAggression01 = 0.50f;
        else
            rhythmCutAggression01 = 0.80f;
        rhythmCutAggression01 = Mathf.Clamp01(rhythmCutAggression01);
        nextRhythmCutAggressionDriftAtLanded = 50;
    }
    void RollWinnerMindNow()
    {
        if (difficultyBand == DifficultyBand.Easy) winnerMindRoll01 = RollRange01(0.05f, 0.30f);
        else if (difficultyBand == DifficultyBand.Medium) winnerMindRoll01 = RollRange01(0.30f, 0.55f);
        else if (difficultyBand == DifficultyBand.Hard) winnerMindRoll01 = RollRange01(0.55f, 0.80f);
        else winnerMindRoll01 = RollRange01(0.80f, 1.00f);
        winnerMindIntensity = winnerMindRoll01;
        nextWinnerMindRerollAtTaken = punchesTakenByAI + 50;
    }
    void RollRhythmCutCommitNow()
    {
        if (difficultyBand == DifficultyBand.Medium) rhythmCutCommitChanceRoll01 = RollRange01(0.10f, 0.40f);
        else if (difficultyBand == DifficultyBand.Hard) rhythmCutCommitChanceRoll01 = RollRange01(0.40f, 0.70f);
        else if (difficultyBand == DifficultyBand.Hardcore) rhythmCutCommitChanceRoll01 = RollRange01(0.70f, 0.95f);
        else rhythmCutCommitChanceRoll01 = 0f; // Easy shouldn't use RhythmCut
        nextRhythmCutCommitRerollAtTaken = punchesTakenByAI + 30;
    }
    void RollJabDoctrineNow()
    {
        if (difficultyBand == DifficultyBand.Easy) jabDoctrineRoll01 = RollRange01(0.05f, 0.15f);
        else if (difficultyBand == DifficultyBand.Medium) jabDoctrineRoll01 = RollRange01(0.15f, 0.25f);
        else if (difficultyBand == DifficultyBand.Hard) jabDoctrineRoll01 = RollRange01(0.25f, 0.35f);
        else jabDoctrineRoll01 = RollRange01(0.35f, 0.45f);
        nextJabDoctrineRerollAtTaken = punchesTakenByAI + 20;
    }
    void RollClinchBreakIfPlayerInitiatedNow()
    {
        if (difficultyBand == DifficultyBand.Easy) clinchBreakIfPlayerInitiatedRollAdd = RollRange01(0.03f, 0.06f);
        else if (difficultyBand == DifficultyBand.Medium) clinchBreakIfPlayerInitiatedRollAdd = RollRange01(0.06f, 0.09f);
        else if (difficultyBand == DifficultyBand.Hard) clinchBreakIfPlayerInitiatedRollAdd = RollRange01(0.09f, 0.12f);
        else clinchBreakIfPlayerInitiatedRollAdd = RollRange01(0.12f, 0.20f);
        nextClinchBreakIfPlayerInitiatedRerollAtTaken = punchesTakenByAI + 25;
    }
    void MaybeHandleRerolls_OnPunchTaken()
    {
        if (punchesTakenByAI >= nextWinnerMindRerollAtTaken) RollWinnerMindNow();
        if (punchesTakenByAI >= nextRhythmCutCommitRerollAtTaken) RollRhythmCutCommitNow();
        if (punchesTakenByAI >= nextJabDoctrineRerollAtTaken) RollJabDoctrineNow();
        if (punchesTakenByAI >= nextClinchBreakIfPlayerInitiatedRerollAtTaken) RollClinchBreakIfPlayerInitiatedNow();
    }
    void MaybeHandleRhythmCutAggressionDrift_OnPunchLanded()
    {
        if (punchesLandedByAI < nextRhythmCutAggressionDriftAtLanded) return;
        float drift = RollRange01(-0.01f, +0.01f);
        rhythmCutAggression01 = Mathf.Clamp01(rhythmCutAggression01 + drift);
        nextRhythmCutAggressionDriftAtLanded += 50;
    }
    void TrackStaminaHitsAndPatterns()
    {
        float myNow = myStats.currentStamina;
        float theirNow = playerStats.currentStamina;
        if (prevMyStamina < 0f) prevMyStamina = myNow;
        if (prevPlayerStamina < 0f) prevPlayerStamina = theirNow;
        float myDelta = prevMyStamina - myNow;
        float theirDelta = prevPlayerStamina - theirNow;
        float absDist = Mathf.Abs(player.position.x - transform.position.x);
        bool inPatternRange = absDist <= patternRangeMax;
        if (myDelta >= hitDetectThreshold)
        {
            punchesTakenByAI++;
            MaybeHandleRerolls_OnPunchTaken();
            totalDamageTaken += myDelta;
            lastTimeTookHit = Time.time;
OnAiTookHitForWeaveLogic();
            if (enableConditioning)
            {
                bool leanHead = true;
                if (dataBank != null)
                {
                    var last3 = dataBank.GetLastHits(AiActionDataBank.Actor.Player, 3);
                    leanHead = last3.headHits >= last3.bodyHits;
                }
                if (leanHead) headConditionScore += headHitConditionValue;
                else bodyConditionScore += bodyHitConditionValue;
                string key = GetBestEffortPlayerPunchKey(leanHead);
                if (!playerLandedPunchCounts.ContainsKey(key)) playerLandedPunchCounts[key] = 0;
                playerLandedPunchCounts[key]++;
            }
            if (dataBank != null)
                dataBank.LogHit(AiActionDataBank.Actor.Player, AiActionDataBank.HitRegion.Head, myDelta, inPatternRange);
        }
        if (theirDelta >= hitDetectThreshold)
        {
            punchesLandedByAI++;
            MaybeHandleRhythmCutAggressionDrift_OnPunchLanded();
            RecordAiImpactFrameOnPlayer(theirDelta);
            if (dataBank != null)
                dataBank.LogHit(AiActionDataBank.Actor.Ai, AiActionDataBank.HitRegion.Head, theirDelta, inPatternRange);
            if (activeCounterPatternIndex >= 0 && Time.time <= counterPatternActiveUntil && dataBank != null)
            {
                dataBank.RegisterCounterSuccess(activeCounterPatternIndex);
                activeCounterPatternIndex = -1;
            }
        }
        prevMyStamina = myNow;
        prevPlayerStamina = theirNow;
    }
    string GetBestEffortPlayerPunchKey(bool leanHead)
    {
        if (TryDetectPlayerPunch(out var punch, out _))
            return "Punch_" + punch.ToString();
        return leanHead ? "HeadHit" : "BodyHit";
    }
    void UpdateConditioning(float dt)
    {
        if (!enableConditioning) return;
        if (headConditionScore > 0f)
            headConditionScore = Mathf.Max(0f, headConditionScore - conditionDecayPerSecond * dt);
        if (bodyConditionScore > 0f)
            bodyConditionScore = Mathf.Max(0f, bodyConditionScore - conditionDecayPerSecond * dt);
    }
    bool ConditioningGateActive()
    {
        if (!enableConditioning) return false;
        if (totalDamageTaken <= conditionDamageGateMin) return false;
        return totalDamageTaken >= conditionDamageGate;
    }
    float GetHeadConditionFraction()
    {
        if (!enableConditioning) return 0f;
        float threshold =
            (difficultyBand == DifficultyBand.Easy) ? easyHeadConditionThreshold :
            (difficultyBand == DifficultyBand.Medium) ? mediumHeadConditionThreshold :
            (difficultyBand == DifficultyBand.Hard) ? hardHeadConditionThreshold :
            hardcoreHeadConditionThreshold;
        if (threshold <= 0f) return 0f;
        float baseFrac = Mathf.Clamp01(headConditionScore / threshold);
        if (!ConditioningGateActive()) baseFrac *= 0.25f;
        float dmgFrac = Mathf.InverseLerp(conditionDamageGateMin, conditionDamageGateMax, totalDamageTaken);
        return Mathf.Clamp01(baseFrac * Mathf.Lerp(0.5f, 1.5f, dmgFrac));
    }
    float GetBodyConditionFraction()
    {
        if (!enableConditioning) return 0f;
        float threshold =
            (difficultyBand == DifficultyBand.Easy) ? easyBodyConditionThreshold :
            (difficultyBand == DifficultyBand.Medium) ? mediumBodyConditionThreshold :
            (difficultyBand == DifficultyBand.Hard) ? hardBodyConditionThreshold :
            hardcoreBodyConditionThreshold;
        if (threshold <= 0f) return 0f;
        float baseFrac = Mathf.Clamp01(bodyConditionScore / threshold);
        if (!ConditioningGateActive()) baseFrac *= 0.25f;
        float dmgFrac = Mathf.InverseLerp(conditionDamageGateMin, conditionDamageGateMax, totalDamageTaken);
        return Mathf.Clamp01(baseFrac * Mathf.Lerp(0.5f, 1.5f, dmgFrac));
    }
    void UpdatePerfectReactionLongFightFade(float dt)
    {
        if (!enablePerfectReactions) return;
        if (myStats == null) return;
        float myFrac = GetMyStaminaFrac();
        bool belowFull = myFrac < 0.999f;
        if (belowFull)
        {
            perfectReactBelowFullStaminaTimer += dt;
            while (perfectReactBelowFullStaminaTimer >= perfectReactFadeTickSeconds)
            {
                perfectReactBelowFullStaminaTimer -= perfectReactFadeTickSeconds;
                perfectReactFadeFrac += perfectReactFadeTickAmount;
                perfectReactFadeFrac = Mathf.Clamp(perfectReactFadeFrac, 0f, 0.15f);
            }
        }
    }
    void TryPerfectReact()
    {
        if (defense == null) return;
        if (pendingPerfectReaction) return;
        if (Time.time < nextPerfectReactTime) return;
        float myFrac = GetMyStaminaFrac();
        if (survivalModeActive) return;
        float dist = GetDistanceToPlayer();
        bool hasPunchInfo = TryDetectPlayerPunch(out var activePunch, out bool likelyBody);
        if (!hasPunchInfo && !allowPerfectReactFallbackWithoutPunchDetect)
            return;
        float maxReactDist = hasPunchInfo ? (attackRangeMax + 0.25f) : (attackRangeMax);
        if (dist > maxReactDist) return;
        float baseChance = GetBasePerfectChanceByDifficulty(myFrac);
        if (baseChance <= 0f) return;
        float chance = baseChance * (1f - perfectReactFadeFrac);
        if (enableStunInputReadBoost && Time.time < stunInputReadBoostUntil)
            chance = Mathf.Clamp01(chance + stunInputReadBoostAdd);
        float headCond = GetHeadConditionFraction();
        float bodyCond = GetBodyConditionFraction();
        float cond = Mathf.Clamp01(Mathf.Max(headCond, bodyCond));
        float condPenaltyPoints = 0.12f * cond;
        chance = Mathf.Max(0f, chance - condPenaltyPoints);
        float repeatPenalty = ComputeRepeatPenalty();
        chance = Mathf.Max(0f, chance - repeatPenalty);
        if (hasPunchInfo) chance = Mathf.Clamp01(chance + 0.04f);
        chance = Mathf.Clamp01(chance + Mathf.Lerp(-0.02f, 0.05f, preferCleanHitsOverVolume));
        float roll = (rng != null) ? rng.Next01() : UnityEngine.Random.value;
        if (roll > Mathf.Clamp01(chance)) return;
        nextPerfectReactTime = Time.time + perfectReactCooldown;
        if (enablePerfectReactionDelay)
            QueuePerfectReactionWithDelay(activePunch, likelyBody, dist, hasPunchInfo);
        else
            TriggerPerfectReaction(activePunch, likelyBody, dist, hasPunchInfo);
    }
    float GetBasePerfectChanceByDifficulty(float myFrac)
    {
        bool above50 = myFrac >= 0.50f;
        switch (difficultyBand)
        {
            case DifficultyBand.Easy: return above50 ? 0.35f : 0.22f;
            case DifficultyBand.Medium: return above50 ? 0.58f : 0.46f;
            case DifficultyBand.Hard: return above50 ? 0.86f : 0.78f;
            case DifficultyBand.Hardcore: return above50 ? 0.95f : 0.85f;
        }
        return 0f;
    }
    float ComputeRepeatPenalty()
    {
        if (playerLandedPunchCounts == null || playerLandedPunchCounts.Count == 0) return 0f;
        int maxCount = 0;
        foreach (var kv in playerLandedPunchCounts)
            maxCount = Mathf.Max(maxCount, kv.Value);
        if (maxCount < repeatHitThreshold) return 0f;
        int over = maxCount - (repeatHitThreshold - 1);
        float pen = over * repeatPenaltyStep;
        return Mathf.Clamp(pen, 0f, repeatPenaltyCap);
    }
void GetPerfectReactChoiceWeights(
    bool weaveAvailable,
    out float wDuck,
    out float wStepOut,
    out float wBlock,
    out float wWeave,
    out float wWeaveDuck,
    out float sum)
{
    // Read inspector weights (allow 0 to disable a choice)
    wDuck = Mathf.Max(0f, perfectReactDuckWeight);
    wStepOut = Mathf.Max(0f, perfectReactStepOutWeight);
    wBlock = Mathf.Max(0f, perfectReactBlockWeight);

    // Weave options only exist when weave is eligible right now
    wWeave = weaveAvailable ? Mathf.Max(0f, perfectReactWeaveWeight) : 0f;
    wWeaveDuck = weaveAvailable ? Mathf.Max(0f, perfectReactWeaveDuckWeight) : 0f;

    sum = wDuck + wStepOut + wBlock + wWeave + wWeaveDuck;

    // Hard fallback: if everything is 0, force BLOCK so selection can't break.
    if (sum <= 0.0001f)
    {
        wDuck = 0f;
        wStepOut = 0f;
        wWeave = 0f;
        wWeaveDuck = 0f;
        wBlock = 1f;
        sum = 1f;
        return;
    }

    // Optional normalization (local only; does NOT rewrite inspector values)
    if (perfectReactAutoNormalizeWeights)
    {
        float inv = 1f / sum;
        wDuck *= inv;
        wStepOut *= inv;
        wBlock *= inv;
        wWeave *= inv;
        wWeaveDuck *= inv;
        sum = 1f;
    }
}
    void TriggerPerfectReaction(FistHitbox.PunchType punch, bool likelyBody, float dist, bool hasPunchInfo)
    {
lastReactPunch = punch;
lastReactLikelyBody = likelyBody;
lastReactDist = dist;
lastReactHasPunchInfo = hasPunchInfo;
        if (comboRunner != null && comboRunner.IsRunningCombo)
            comboRunner.StopCombo();
        perfectReactActive = true;
        perfectReactUntil=Time.time+perfectReactHoldTime;
        forcedGuard = false;
        forcedHigh = false;
        forcedLow = false;
        forcedDuck = false;
        stepOutDesiredMove = 0f;
forcedWeave=false;forcedWeaveDuck=false;weaveDesiredMove=0f;
bool weaveAvailable=IsWeaveAvailableNow();
float wD, wS, wB, wW, wWD, sum;
GetPerfectReactChoiceWeights(weaveAvailable, out wD, out wS, out wB, out wW, out wWD, out sum);
float r=(rng!=null)?rng.Next01():UnityEngine.Random.value;
r*=sum;
float dx=player.position.x-transform.position.x;
float dirToPlayer=Mathf.Sign(dx);
if(dirToPlayer==0f)dirToPlayer=1f;
if(r<wD){forcedDuck=true;forcedGuard=false;forcedWeave=false;forcedWeaveDuck=false;weaveDesiredMove=0f;}
else if(r<wD+wS){stepOutDesiredMove=-dirToPlayer;forcedWeave=false;forcedWeaveDuck=false;weaveDesiredMove=0f;}
else if(r<wD+wS+wW){forcedWeave=true;forcedWeaveDuck=false;forcedGuard=false;forcedDuck=false;stepOutDesiredMove=0f;StartWeaveChain(punch,likelyBody,dirToPlayer);}
else if(r<wD+wS+wW+wWD){forcedWeave=false;forcedWeaveDuck=true;forcedGuard=false;forcedDuck=false;stepOutDesiredMove=0f;StartWeaveChain(punch,likelyBody,dirToPlayer);}
else{forcedGuard=true;forcedWeave=false;forcedWeaveDuck=false;weaveDesiredMove=0f;float dirRoll=(rng!=null)?rng.Next01():UnityEngine.Random.value;bool useUpDown=dirRoll<Mathf.Clamp01(perfectReactPreferUpDownWhenBlocking);if(!useUpDown){forcedHigh=false;forcedLow=false;return;}bool shouldLow;if(hasPunchInfo){shouldLow=likelyBody;}else{float b=GetBodyConditionFraction();float h=GetHeadConditionFraction();shouldLow=b>h;}float accRoll=(rng!=null)?rng.Next01():UnityEngine.Random.value;bool followRead=accRoll<Mathf.Clamp01(perfectReactDirectionalAccuracy);bool finalLow=followRead?shouldLow:!shouldLow;forcedLow=finalLow;forcedHigh=!finalLow;}
}
    void ApplyPerfectReactionOverridesIfActive()
    {
        if (!perfectReactActive) return;
if (Time.time > perfectReactUntil)
{
    if(forcedWeave||forcedWeaveDuck)
    {
        if(TryContinueWeaveOrSwitchDefense())
            return;
    }
    perfectReactActive = false;
    forcedGuard = forcedHigh = forcedLow = forcedDuck = false;
    forcedWeave = false;
    forcedWeaveDuck = false;
    stepOutDesiredMove = 0f;
    weaveDesiredMove = 0f;
    return;
}
       if(defense!=null)
{
    if(forcedGuard)
    {
        defense.AiSetAutoGuard(true);
        defense.AiSetHighBlock(forcedHigh);
        defense.AiSetLowBlock(forcedLow);
        defense.AiSetDuck(false);
    }
    else if(forcedDuck)
    {
        defense.AiSetDuck(true);
    }
    else if(forcedWeave||forcedWeaveDuck)
    {
        defense.AiSetAutoGuard(false);
        defense.AiSetHighBlock(false);
        defense.AiSetLowBlock(false);
        defense.AiSetDuck(forcedWeaveDuck);
    }
}
        if (Mathf.Abs(stepOutDesiredMove) > 0.01f)
        {
            float dist = GetDistanceToPlayer();
            if (dist >= stepOutTargetDistance)
            {
                stepOutDesiredMove = 0f;
                return;
            }
            desiredMoveInput = Mathf.Clamp(stepOutDesiredMove, -1f, 1f);
        }
if((forcedWeave||forcedWeaveDuck)&&Mathf.Abs(weaveDesiredMove)>0.01f)
{
    float m=Mathf.Clamp01(perfectReactWeaveMoveInput);
    desiredMoveInput=Mathf.Clamp(weaveDesiredMove*m,-1f,1f);
}
    }
    bool TryDetectPlayerPunch(out FistHitbox.PunchType punch, out bool likelyBody)
    {
        punch = FistHitbox.PunchType.Jab;
        likelyBody = false;
        if (playerController == null) return false;
        FistHitbox lf = playerController.leftFist;
        FistHitbox rf = playerController.rightFist;
        if (TryReadPunchStateFromFist(lf, out punch))
        {
            likelyBody = IsLikelyBodyPunch(punch);
            return true;
        }
        if (TryReadPunchStateFromFist(rf, out punch))
        {
            likelyBody = IsLikelyBodyPunch(punch);
            return true;
        }
        return false;
    }
    bool IsLikelyBodyPunch(FistHitbox.PunchType p)
    {
        return (p == FistHitbox.PunchType.LeftUppercut ||
                p == FistHitbox.PunchType.RightUppercut);
    }
    bool TryReadPunchStateFromFist(FistHitbox fist, out FistHitbox.PunchType punch)
    {
        punch = FistHitbox.PunchType.Jab;
        if (fist == null) return false;
        object obj = fist;
        Type t = obj.GetType();
        bool punching = TryGetBoolMember(t, obj, "isPunching")
                     || TryGetBoolMember(t, obj, "IsPunching")
                     || TryGetBoolMember(t, obj, "punchActive")
                     || TryGetBoolMember(t, obj, "IsActive")
                     || TryGetBoolMember(t, obj, "isActive")
                     || TryGetBoolMember(t, obj, "isExtending")
                     || TryGetBoolMember(t, obj, "IsExtending");
        if (!punching) return false;
        if (TryGetPunchTypeMember(t, obj, "currentPunchType", out punch)) return true;
        if (TryGetPunchTypeMember(t, obj, "activePunchType", out punch)) return true;
        if (TryGetPunchTypeMember(t, obj, "lastPunchType", out punch)) return true;
        if (TryGetPunchTypeMember(t, obj, "CurrentPunchType", out punch)) return true;
        if (TryGetPunchTypeMember(t, obj, "ActivePunchType", out punch)) return true;
        punch = FistHitbox.PunchType.Jab;
        return true;
    }
    void EvaluateState()
    {
        float myFrac = GetMyStaminaFrac();
        float theirFrac = GetPlayerStaminaFrac();
        float dist = GetDistanceToPlayer();
        if (myFrac <= deepSurvivalFraction)
        {
            currentState = AiState.Panic;
            currentPhase = TacticalPhase.Panic;
            return;
        }
        if (survivalModeActive)
        {
            currentState = AiState.Retreat;
            if (currentPhase != TacticalPhase.Panic) currentPhase = TacticalPhase.Panic;
            return;
        }
        if (theirFrac <= playerFinishFraction)
        {
            currentState = (dist <= attackRangeMax) ? AiState.Maintain : AiState.Approach;
            currentPhase = TacticalPhase.Finish;
            return;
        }
        float ideal = GetIdealRangeForPhase();
        float width = (currentPhase == TacticalPhase.Counter) ? counterRangeWidth : rangeWidth;
        float min = Mathf.Max(0.2f, ideal - width * 0.5f);
        float max = ideal + width * 0.5f;
        float bias = GetScoreAggressionBias();
        float aheadFactor = Mathf.Clamp01(-bias);
        float behindFactor = Mathf.Clamp01(bias);
        float approachReluctance = aheadFactor * Mathf.Max(0f, approachReluctanceBlocksWhenAhead);
        float retreatReluctance = behindFactor * Mathf.Max(0f, retreatReluctanceBlocksWhenBehind);
        float clean = preferCleanHitsOverVolume;
        approachReluctance += Mathf.Lerp(0f, 0.18f, clean);
        retreatReluctance += Mathf.Lerp(0f, 0.08f, clean);
        if (dist > max + 0.08f + approachReluctance) currentState = AiState.Approach;
        else if (dist < (min - 0.08f - retreatReluctance)) currentState = AiState.Retreat;
        else currentState = AiState.Maintain;
    }
    void EvaluatePhase()
    {
        if (myStats == null || playerStats == null) return;
        float myFrac = GetMyStaminaFrac();
        float theirFrac = GetPlayerStaminaFrac();
        if (myFrac <= deepSurvivalFraction || survivalModeActive)
        {
            currentPhase = TacticalPhase.Panic;
            return;
        }
        if (theirFrac <= playerFinishFraction)
        {
            currentPhase = TacticalPhase.Finish;
            return;
        }
        if (counterModeActive)
        {
            currentPhase = TacticalPhase.Counter;
            return;
        }
        float momentum = (dataBank != null) ? dataBank.GetAiMomentum(6f) : 0.5f;
        float playerAgg = (dataBank != null) ? dataBank.GetPlayerAggression(6f) : 0f;
        float headCond = GetHeadConditionFraction();
        float bodyCond = GetBodyConditionFraction();
        float scoreBias = GetScoreAggressionBias();
        float scoreInfluence = Mathf.Clamp(scoreBias * 0.18f, -0.18f, 0.18f);
        float adjustedMomentum = Mathf.Clamp01(momentum - scoreInfluence);
        bool winning = adjustedMomentum > 0.60f;
        bool losing = adjustedMomentum < 0.40f;
        float clean = preferCleanHitsOverVolume;
        if (losing && playerAgg > 0.55f)
        {
            currentPhase = TacticalPhase.WhiffPunish;
            return;
        }
        if (clean > 0.62f && playerAgg > 0.42f)
        {
            currentPhase = TacticalPhase.WhiffPunish;
            return;
        }
        if (bodyCond > headCond + 0.15f && bodyCond > 0.35f)
        {
            currentPhase = TacticalPhase.BodyHunt;
            return;
        }
        if (winning && myFrac > lowStaminaFraction && clean < 0.55f)
        {
            currentPhase = TacticalPhase.Pressure;
            return;
        }
        if (difficultyBand == DifficultyBand.Easy) currentPhase = TacticalPhase.Download;
        else currentPhase = TacticalPhase.Probe;
    }
    float GetIdealRangeForPhase()
    {
        float baseIdeal;
        switch (currentPhase)
        {
            case TacticalPhase.Pressure: baseIdeal = idealRangePressure; break;
            case TacticalPhase.WhiffPunish: baseIdeal = idealRangeWhiffPunish; break;
            case TacticalPhase.Counter: baseIdeal = idealRangeCounter; break;
            case TacticalPhase.Panic: baseIdeal = idealRangeSurvival; break;
            case TacticalPhase.Finish: baseIdeal = idealRangePressure; break;
            case TacticalPhase.BodyHunt: baseIdeal = idealRangeNeutral; break;
            default: baseIdeal = idealRangeNeutral; break;
        }
        float bias = GetScoreAggressionBias();
        float shift = Mathf.Clamp(rangeShiftPerAggressionBias, 0f, 0.75f);
        float ideal = baseIdeal - (bias * shift) + classRangeBias;
        if (currentPhase != TacticalPhase.Pressure && currentPhase != TacticalPhase.Finish && currentPhase != TacticalPhase.Panic)
            ideal += Mathf.Lerp(-0.02f, 0.18f, preferCleanHitsOverVolume);
        return Mathf.Clamp(ideal, 0.35f, 2.25f);
    }
    void ThinkMovement()
    {
        if (chargeEvadeActive) return;
        if (perfectReactActive && Mathf.Abs(stepOutDesiredMove) > 0.01f) return;
        if (chargeAttemptActive) return;
        if (survivalModeActive) return;
        float dx = player.position.x - transform.position.x;
        float dist = Mathf.Abs(dx);
        float dirToPlayer = Mathf.Sign(dx);
        if (dirToPlayer == 0f) dirToPlayer = 1f;
        if (dist <= Mathf.Max(0.10f, overlapHardMinDist))
        {
            desiredMoveInput = Mathf.Clamp(-dirToPlayer, -1f, 1f);
            return;
        }
        if (enforceAttackMinSpacing && dist < attackRangeMin)
        {
            desiredMoveInput = Mathf.Clamp(-dirToPlayer, -1f, 1f);
            return;
        }
        float ideal = GetIdealRangeForPhase();
        float width = (currentPhase == TacticalPhase.Counter) ? counterRangeWidth : rangeWidth;
        float min = Mathf.Max(0.2f, ideal - width * 0.5f);
        float max = ideal + width * 0.5f;
        float move = 0f;
        if (currentPhase == TacticalPhase.Counter)
        {
            if (dist < (min - 0.05f))
            {
                move = -dirToPlayer;
            }
            else if (dist <= max + 0.05f)
            {
                float r = (rng != null) ? rng.Next01() : UnityEngine.Random.value;
                if (r < 0.22f) move = -dirToPlayer;
                else move = 0f;
            }
            else
            {
                if (!counterModeReducesChasing)
                {
                    move = dirToPlayer;
                }
                else
                {
                    float bias = GetScoreAggressionBias();
                    bool behind = bias > 0.10f;
                    if (behind && dist > (max + Mathf.Max(0.10f, counterChaseOnlyIfBeyondBlocks)))
                        move = dirToPlayer;
                    else
                        move = 0f;
                }
            }
            desiredMoveInput = Mathf.Clamp(move, -1f, 1f);
            return;
        }
        switch (currentState)
        {
            case AiState.Approach: move = dirToPlayer; break;
            case AiState.Retreat: move = -dirToPlayer; break;
            case AiState.Panic:
                if (dist < ideal) move = -dirToPlayer;
                else move = 0f;
                break;
            default:
                if (dist > max + 0.05f) move = dirToPlayer;
                else if (dist < min - 0.05f) move = -dirToPlayer;
                else
                {
                    float bias = GetScoreAggressionBias();
                    float ahead = Mathf.Clamp01(-bias);
                    float behind = Mathf.Clamp01(bias);
                    float towardP = 0.12f + behind * pressureJitterBoostWhenBehind - ahead * 0.06f;
                    float awayP = 0.12f + ahead * disengageJitterBoostWhenAhead - behind * 0.05f;
                    float clean = preferCleanHitsOverVolume;
                    towardP = Mathf.Max(0f, towardP - clean * 0.06f);
                    awayP = Mathf.Clamp01(awayP + clean * 0.06f);
                    towardP = Mathf.Clamp01(towardP);
                    awayP = Mathf.Clamp01(awayP);
                    float r = (rng != null) ? rng.Next01() : UnityEngine.Random.value;
                    if (r < towardP) move = dirToPlayer;
                    else if (r < towardP + awayP) move = -dirToPlayer;
                    else move = 0f;
                }
                break;
        }
        desiredMoveInput = Mathf.Clamp(move, -1f, 1f);
    }
    void ApplyMovement()
    {
        if (rb == null) return;
        float move = desiredMoveInput;
        if (myStats != null && myStats.IsExhausted) move = 0f;
        Vector2 pos = rb.position;
        if (Mathf.Approximately(move, 0f))
        {
            pos.x = Mathf.Clamp(pos.x, ringMinX, ringMaxX);
            rb.MovePosition(pos);
            return;
        }
        float speed = moveSpeed;
        if (levelController != null) speed *= levelController.MoveSpeedMult;
        if (myStats != null) speed *= myStats.GetMoveSlowMultiplier();
        if (rhythm != null)
        {
            int dirX = move > 0f ? 1 : -1;
            float facingSign = Mathf.Sign(transform.localScale.x);
            speed *= rhythm.GetMovementMultiplier(dirX, facingSign);
        }
        if (defense != null && defense.IsHandsDownActive())
            speed *= (1f + defense.handsDownMoveSpeedBonus);
        pos.x += move * speed * Time.fixedDeltaTime;
        pos.x = Mathf.Clamp(pos.x, ringMinX, ringMaxX);
        rb.MovePosition(pos);
    }
    void HandleFacing()
    {
        if (player == null) return;
        float dx = player.position.x - transform.position.x;
        Vector3 scale = transform.localScale;
        if (dx > 0f) scale.x = Mathf.Abs(scale.x);
        else if (dx < 0f) scale.x = -Mathf.Abs(scale.x);
        transform.localScale = scale;
    }
    void ThinkAttack()
    {
        if (player == null || playerStats == null || myStats == null) return;
        if (survivalModeActive) return;
        if (currentPhase == TacticalPhase.Panic) return;
        if (currentState == AiState.Panic && GetMyStaminaFrac() <= deepSurvivalFraction) return;
        if (chargeAttemptActive) return;
        if (comboRunner != null && comboRunner.IsRunningCombo) return;
        float dist = GetDistanceToPlayer();
        if (dist < attackRangeMin || dist > attackRangeMax) return;
        float myFrac = GetMyStaminaFrac();
        bool patternCounterOpportunity = false;
        int matchedPatternIndex = -1;
        if (dataBank != null && dist <= patternRangeMax)
        {
            AiActionDataBank.HitPattern matched;
            if (dataBank.TryGetCurrentPatternMatch(patternWindowSeconds, out matchedPatternIndex, out matched))
                patternCounterOpportunity = true;
        }
        float momentum = (dataBank != null) ? dataBank.GetAiMomentum(5f) : 0.5f;
        float playerAgg = (dataBank != null) ? dataBank.GetPlayerAggression(5f) : 0f;
        int playerWhiffsShort = (dataBank != null) ? dataBank.GetWhiffCount(AiActionDataBank.Actor.Player, 0.9f, true) : 0;
bool punishWindow =
    (currentPhase == TacticalPhase.WhiffPunish) ||
    (currentPhase == TacticalPhase.Counter) ||
    patternCounterOpportunity ||
    (playerWhiffsShort >= 2);
bool rhythmCutNow = IsRhythmCutActive();
        float commitChance = Mathf.Lerp(
              0.35f,
              0.85f,
              Mathf.Clamp01(personalityAggression + classAggressionBias)
        );
        float clean = preferCleanHitsOverVolume;
        commitChance = Mathf.Lerp(commitChance, commitChance - 0.12f, clean);
        commitChance = Mathf.Lerp(commitChance - 0.25f, commitChance + 0.25f, momentum);
        commitChance += playerWhiffsShort * 0.12f * winnerMindIntensity;
        commitChance -= Mathf.Clamp01((playerAgg - 0.5f) * 2f) * 0.20f;
        if (currentPhase == TacticalPhase.Pressure) commitChance += 0.10f;
        if (currentPhase == TacticalPhase.Finish) commitChance += 0.20f;
        if (currentPhase == TacticalPhase.Counter) commitChance -= 0.10f;
        if (currentPhase == TacticalPhase.Panic) commitChance -= 0.25f;
if (currentPhase == TacticalPhase.WhiffPunish) commitChance += clean * 0.10f;
if (rhythmCutNow)
{
    float rc = Next01();
    if (rc <= Mathf.Clamp01(rhythmCutCommitChanceRoll01))
        commitChance = Mathf.Clamp01(commitChance + rhythmCutCommitBonus);
}
        if (myFrac < lowStaminaFraction) commitChance *= 0.65f;
        float scoreBias = GetScoreAggressionBias();
        commitChance += scoreBias * Mathf.Clamp(commitChancePerAggressionBias, 0f, 0.40f);
        if (patternCounterOpportunity)
        {
            commitChance = Mathf.Max(commitChance,
                (difficultyBand == DifficultyBand.Hardcore) ? 0.98f :
                (difficultyBand == DifficultyBand.Hard) ? 0.95f :
                (difficultyBand == DifficultyBand.Medium) ? 0.80f : 0.62f);
        }
        commitChance = Mathf.Clamp01(commitChance);
        float roll = (rng != null) ? rng.Next01() : UnityEngine.Random.value;
        if (roll > commitChance) return;
CacheImpactPredictionAtCommit(dist);
        if (patternCounterOpportunity && matchedPatternIndex >= 0)
        {
            activeCounterPatternIndex = matchedPatternIndex;
            counterPatternActiveUntil = Time.time + counterPatternWindowDuration;
        }
        if (aiControlsRhythm && rhythm != null)
{
    float rr = (rng != null) ? rng.Next01() : UnityEngine.Random.value;
    float cutChance = rhythmCutNow ? Mathf.Clamp01(rhythmCutRhythmChangeChance) : Mathf.Clamp01(offensiveRhythmChangeChance);
    if (rr < cutChance)
        MaybeChangeRhythm(1f, true);
}
        bool doCombo = enableCombos && comboRunner != null && comboLibrary != null;
        float comboChance = ComputeDynamicComboChance(myFrac, dist, momentum, playerAgg, punishWindow);
if (rhythmCutNow) comboChance = Mathf.Clamp01(comboChance + rhythmCutComboBonus);
        float cRoll = (rng != null) ? rng.Next01() : UnityEngine.Random.value;
        if (doCombo && cRoll <= comboChance)
        {
            if (defense != null)
            {
                bool wantBody = WantBodyWork(dist);
                defense.AiSetDuck(wantBody);
            }
            AiComboLibrary.ComboContext ctx = BuildComboContextForLibrary(dist, punishWindow);
            var combo = comboLibrary.RequestCombo(ctx);
            comboRunner.StartCombo(combo);
            return;
        }
        ExecuteFallbackSingle(dist);
    }
    float ComputeDynamicComboChance(float myFrac, float dist, float aiMomentum01, float oppAgg01, bool punishWindow)
    {
        float diffT =
            (difficultyBand == DifficultyBand.Easy) ? 0f :
            (difficultyBand == DifficultyBand.Medium) ? 0.45f :
            (difficultyBand == DifficultyBand.Hard) ? 0.75f : 1f;
        float baseTarget = Mathf.Lerp(dynamicComboMinEasy, dynamicComboMaxHardcore, diffT);
        int lvl = (levelController != null) ? Mathf.Clamp(levelController.level, 1, 100) : 1;
        float lvlT = Mathf.Clamp01((lvl - 1) / 99f);
        float lvlBoost = Mathf.Lerp(0.85f, 1.15f, lvlT);
        baseTarget = Mathf.Lerp(baseTarget, baseTarget * lvlBoost, dynamicComboLevelInfluence);
        float comboChance = Mathf.Clamp01(baseTarget + classComboBias);
        if (currentPhase == TacticalPhase.Pressure) comboChance = Mathf.Clamp01(comboChance + pressureComboBonus);
        if (currentPhase == TacticalPhase.Finish) comboChance = Mathf.Clamp01(comboChance + finishComboBonus);
        if (currentPhase == TacticalPhase.Counter) comboChance *= 0.80f;
        if (currentPhase == TacticalPhase.Panic) comboChance = Mathf.Clamp01(comboChance * (1f - panicComboPenalty));
        float clean = preferCleanHitsOverVolume;
        if (!punishWindow)
            comboChance = Mathf.Clamp01(comboChance - clean * 0.18f);
        else
            comboChance = Mathf.Clamp01(comboChance + clean * 0.10f);
        if (myFrac < lowStaminaFraction) comboChance *= 0.7f;
        if (difficultyBand == DifficultyBand.Hard) comboChance = Mathf.Clamp01(comboChance + 0.06f);
        if (difficultyBand == DifficultyBand.Hardcore) comboChance = Mathf.Clamp01(comboChance + 0.10f);
        float scoreBias = GetScoreAggressionBias();
        comboChance = Mathf.Clamp01(comboChance + scoreBias * 0.08f);
        comboChance = Mathf.Clamp01(comboChance + (aiMomentum01 - 0.5f) * 0.10f);
        comboChance = Mathf.Clamp01(comboChance - Mathf.Clamp01(oppAgg01 - 0.55f) * 0.08f);
        return comboChance;
    }
bool WantBodyWork(float dist)
{
    float headCond = GetHeadConditionFraction();
    float bodyCond = GetBodyConditionFraction();
    float bodyScore = 0f;
    if (currentPhase == TacticalPhase.BodyHunt) bodyScore += 0.55f;
    bodyScore += Mathf.Clamp01(bodyCond - headCond) * 0.50f;
    bodyScore += (dist < 1.05f) ? 0.10f : 0f;
    float clean = preferCleanHitsOverVolume;
    if (dist > 1.05f) bodyScore = Mathf.Max(0f, bodyScore - clean * 0.10f);
    float pBody_Tactical = Mathf.Clamp01(bodyScore);
    float headP = GetAdaptiveHeadProbability01();
    float pBody_Directional = 1f - headP;
    float w = enableDirectionalTargeting ? Mathf.Clamp01(directionalTargetingInfluence) : 0f;
    float pBody_Final = Mathf.Lerp(pBody_Tactical, pBody_Directional, w);
    float r = (rng != null) ? rng.Next01() : UnityEngine.Random.value;
    return r < Mathf.Clamp01(pBody_Final);
}
    void ExecuteFallbackSingle(float dist)
    {
        bool wantBody = WantBodyWork(dist);
        if (defense != null)
            defense.AiSetDuck(wantBody);
        float dx = player.position.x - transform.position.x;
        float jabDoctrine = ComputeJabDoctrine01();
        float clean = preferCleanHitsOverVolume;
        FistHitbox.PunchType punch;
        if (!wantBody)
        {
            float r = (rng != null) ? rng.Next01() : UnityEngine.Random.value;
            float jabP = Mathf.Lerp(0.35f, 0.70f, jabDoctrine);
            float crossP = Mathf.Lerp(0.40f, 0.55f, 1f - jabDoctrine);
            if (dist > idealRangeNeutral + 0.1f)
            {
                if (r < jabP) punch = FistHitbox.PunchType.Jab;
                else punch = FistHitbox.PunchType.Cross;
            }
            else
            {
                if (r < jabP) punch = FistHitbox.PunchType.Jab;
                else if (r < jabP + crossP) punch = FistHitbox.PunchType.Cross;
                else
                {
                    if (cleanHitsPreferStraights && clean > 0.60f && dist > 0.80f)
                        punch = FistHitbox.PunchType.Cross;
                    else
                        punch = (dx > 0f) ? FistHitbox.PunchType.LeftHook : FistHitbox.PunchType.RightHook;
                }
            }
        }
        else
        {
            float r = (rng != null) ? rng.Next01() : UnityEngine.Random.value;
            if (clean > 0.60f && dist > 0.85f)
            {
                punch = (dx > 0f) ? FistHitbox.PunchType.LeftHook : FistHitbox.PunchType.RightHook;
            }
            else
            {
                if (r < 0.45f) punch = (dx > 0f) ? FistHitbox.PunchType.LeftHook : FistHitbox.PunchType.RightHook;
                else if (r < 0.85f) punch = (dx > 0f) ? FistHitbox.PunchType.LeftUppercut : FistHitbox.PunchType.RightUppercut;
                else punch = (dx > 0f) ? FistHitbox.PunchType.Jab : FistHitbox.PunchType.Cross;
            }
        }
        float feintChance = Mathf.Clamp01(personalityFeintiness);
        if (currentPhase == TacticalPhase.Download) feintChance *= 1.35f;
        if (currentPhase == TacticalPhase.Probe) feintChance *= 1.15f;
        if (currentPhase == TacticalPhase.Finish) feintChance *= 0.55f;
        if (currentPhase == TacticalPhase.Counter) feintChance *= 1.10f;
        if (difficultyBand == DifficultyBand.Easy) feintChance *= 0.80f;
        if (difficultyBand == DifficultyBand.Hard) feintChance *= 1.10f;
        if (difficultyBand == DifficultyBand.Hardcore) feintChance *= 1.18f;
        feintChance = Mathf.Clamp01(feintChance + clean * 0.12f);
        bool doFeint = ((rng != null) ? rng.Next01() : UnityEngine.Random.value) <= feintChance;
        FistHitbox fist = GetFistForPunch(punch);
        if (fist == null) return;
        if (doFeint) fist.StartFeint(punch);
        else fist.StartPunch(punch);
    }
    float ComputeJabDoctrine01()
    {
        float doctrine = jabDoctrineRoll01;
        if (currentPhase == TacticalPhase.Counter || currentPhase == TacticalPhase.WhiffPunish)
            doctrine += 0.10f;
        if (currentPhase == TacticalPhase.Finish)
            doctrine -= 0.08f;
        return Mathf.Clamp01(doctrine);
    }
    FistHitbox GetFistForPunch(FistHitbox.PunchType punch)
    {
        if (myController != null)
        {
            bool left =
                punch == FistHitbox.PunchType.Jab ||
                punch == FistHitbox.PunchType.LeftHook ||
                punch == FistHitbox.PunchType.LeftUppercut;
            if (left && myController.leftFist != null) return myController.leftFist;
            if (!left && myController.rightFist != null) return myController.rightFist;
            if (myController.leftFist != null) return myController.leftFist;
            if (myController.rightFist != null) return myController.rightFist;
        }
        bool useLeft =
            punch == FistHitbox.PunchType.Jab ||
            punch == FistHitbox.PunchType.LeftHook ||
            punch == FistHitbox.PunchType.LeftUppercut;
        if (useLeft && leftFist != null) return leftFist;
        if (!useLeft && rightFist != null) return rightFist;
        if (leftFist != null) return leftFist;
        if (rightFist != null) return rightFist;
        return null;
    }
    void ThinkDefense()
    {
        if (defense == null) return;
        if (survivalModeActive) return;
        if (perfectReactActive && (forcedGuard || forcedDuck))
            return;
        float myFrac = GetMyStaminaFrac();
        float theirFrac = GetPlayerStaminaFrac();
        float dist = GetDistanceToPlayer();
        float playerAgg = (dataBank != null) ? dataBank.GetPlayerAggression(5f) : 0f;
        var last3 = (dataBank != null) ? dataBank.GetLastHits(AiActionDataBank.Actor.Player, 3)
                                       : new AiActionDataBank.HitSummary();
        bool playerHeadHeavy = last3.headHits >= 2;
        bool playerBodyHeavy = last3.bodyHits >= 2;
        bool tired = myFrac < lowStaminaFraction && theirFrac > playerFinishFraction;
        float guardNeed =
            (tired ? 0.55f : 0.20f) +
            Mathf.Clamp01(playerAgg) * 0.45f +
            Mathf.Clamp01(personalityGuardParanoia) * 0.35f;
        if (currentPhase == TacticalPhase.Counter) guardNeed += 0.08f;
        if (currentPhase == TacticalPhase.Panic) guardNeed += 0.25f;
        if (currentPhase == TacticalPhase.Finish) guardNeed -= 0.10f;
        if (dist < tooCloseRange) guardNeed += 0.10f;
        guardNeed = Mathf.Clamp01(guardNeed + preferCleanHitsOverVolume * 0.10f);
        bool wantGuard = ((rng != null) ? rng.Next01() : UnityEngine.Random.value) < guardNeed;
        bool wantHigh = false;
        bool wantLow = false;
        if (wantGuard)
        {
            if (playerBodyHeavy) wantLow = true;
            else if (playerHeadHeavy) wantHigh = true;
            else
            {
                if (dist < tooCloseRange) wantLow = true;
                else wantHigh = true;
            }
            float jiggle = (rng != null) ? rng.Next01() : UnityEngine.Random.value;
            if (jiggle < 0.10f) { wantHigh = true; wantLow = false; }
            else if (jiggle < 0.20f) { wantLow = true; wantHigh = false; }
        }
        bool wantDuck = false;
        if (currentPhase == TacticalPhase.BodyHunt) wantDuck = true;
        else if (wantGuard && wantLow && playerAgg > 0.35f)
        {
            float r = (rng != null) ? rng.Next01() : UnityEngine.Random.value;
            wantDuck = r < 0.35f;
        }
        if (currentPhase == TacticalPhase.Counter)
            wantDuck = false;
        defense.AiSetAutoGuard(wantGuard);
        if (wantGuard)
        {
            defense.AiSetHighBlock(wantHigh);
            defense.AiSetLowBlock(wantLow);
        }
        else
        {
            defense.AiSetHighBlock(false);
            defense.AiSetLowBlock(false);
        }
        defense.AiSetDuck(wantDuck);
    }
    void MaybeChangeRhythm(float chance, bool offensiveBias)
    {
        if (!aiControlsRhythm || rhythm == null) return;
        if (Time.time < nextRhythmChangeTime) return;
        float r = (rng != null) ? rng.Next01() : UnityEngine.Random.value;
        if (r > chance) return;
        int newSpeed = offensiveBias ? UnityEngine.Random.Range(1, 5) : UnityEngine.Random.Range(0, 4);
        rhythm.rhythmSpeed = newSpeed;
        rhythm.rhythmPhase = (newSpeed == 0) ? 0.5f : UnityEngine.Random.value;
        nextRhythmChangeTime = Time.time + rhythmChangeCooldown;
    }
    AiComboLibrary.Phase MapTacticalPhaseToLibraryPhase(TacticalPhase p)
    {
        switch (p)
        {
            case TacticalPhase.Download: return AiComboLibrary.Phase.Download;
            case TacticalPhase.Probe: return AiComboLibrary.Phase.Probe;
            case TacticalPhase.Pressure: return AiComboLibrary.Phase.Pressure;
            case TacticalPhase.BodyHunt: return AiComboLibrary.Phase.BodyHunt;
            case TacticalPhase.WhiffPunish: return AiComboLibrary.Phase.WhiffPunish;
            case TacticalPhase.Finish: return AiComboLibrary.Phase.Finish;
            case TacticalPhase.Counter: return AiComboLibrary.Phase.WhiffPunish;
            case TacticalPhase.Panic: return AiComboLibrary.Phase.Panic;
        }
        return AiComboLibrary.Phase.Probe;
    }
    AiComboLibrary.OppDefenseProfile EstimateOpponentDefenseProfile()
    {
        if (dataBank == null) return AiComboLibrary.OppDefenseProfile.Unknown;
        var last3 = dataBank.GetLastHits(AiActionDataBank.Actor.Ai, 6);
        if (last3.bodyHits >= last3.headHits + 2)
            return AiComboLibrary.OppDefenseProfile.HighBlockHeavy;
        if (last3.headHits >= last3.bodyHits + 2)
            return AiComboLibrary.OppDefenseProfile.LowBlockHeavy;
        return AiComboLibrary.OppDefenseProfile.Unknown;
    }
    AiComboLibrary.ComboContext BuildComboContextForLibrary(float distanceBlocks, bool punishWindow)
    {
        if (comboLibrary == null)
        {
            AiComboLibrary.ComboContext fallback = new AiComboLibrary.ComboContext();
            fallback.distanceBlocks = distanceBlocks;
            fallback.rangeBucket = AiComboLibrary.RangeBucket.Mid;
            fallback.aiStaminaFrac = GetMyStaminaFrac();
            fallback.oppStaminaFrac = GetPlayerStaminaFrac();
            fallback.aiMomentum01 = (dataBank != null) ? dataBank.GetAiMomentum(5f) : 0.5f;
            fallback.oppAggression01 = (dataBank != null) ? dataBank.GetPlayerAggression(5f) : 0.5f;
            fallback.defenseProfile = AiComboLibrary.OppDefenseProfile.Unknown;
            fallback.phase = AiComboLibrary.Phase.Probe;
            fallback.punishWindow = punishWindow;
            return fallback;
        }
        float aiMom = (dataBank != null) ? dataBank.GetAiMomentum(5f) : 0.5f;
        float oppAgg = (dataBank != null) ? dataBank.GetPlayerAggression(5f) : 0.5f;
        AiComboLibrary.OppDefenseProfile prof = EstimateOpponentDefenseProfile();
        AiComboLibrary.Phase ph = MapTacticalPhaseToLibraryPhase(currentPhase);
        return comboLibrary.BuildContext(
            distanceBlocks: distanceBlocks,
            aiStaminaFrac: GetMyStaminaFrac(),
            oppStaminaFrac: GetPlayerStaminaFrac(),
            aiMomentum01: aiMom,
            oppAggression01: oppAgg,
            defenseProfile: prof,
            phase: ph,
            punishWindow: punishWindow
        );
    }
bool IsRhythmCutActive()
{
    return enableRhythmCut && Time.time < rhythmCutUntil;
}
void CacheImpactPredictionAtCommit(float dist)
{
    if (playerRhythm == null) return;
    float phase01 = GetBestEffortRhythmPhase01(playerRhythm);
    float cycleSeconds = GetBestEffortRhythmCycleSeconds(playerRhythm);
    if (cycleSeconds <= 0.05f) cycleSeconds = 0.60f;
    float tHit = EstimateTimeToLandSeconds(dist);
    float aimSeconds = (rhythmAimOffsetFrames * (cycleSeconds / 9f));
    float tHitWithAim = Mathf.Max(0.02f, tHit + aimSeconds);
    float futurePhase = phase01 + (tHitWithAim / cycleSeconds);
    futurePhase -= Mathf.Floor(futurePhase);
    int impactFrame = PhaseToNineFrame(futurePhase);
    hasCachedCommitPrediction = true;
    cachedPredictedImpactFrame = impactFrame;
    cachedPredictedTimeToLand = tHit;
    debugLastPredictedImpactFrameAtCommit = impactFrame;
    debugLastPredictedTimeToLandAtCommit = tHit;
    debugAimOffsetFrames = rhythmAimOffsetFrames;
}
void RecordAiImpactFrameOnPlayer(float staminaDamage)
{
    if (playerRhythm == null) return;
    float phase01 = GetBestEffortRhythmPhase01(playerRhythm);
    int impactFrame = PhaseToNineFrame(phase01);
    debugLastAiImpactFrame = impactFrame;
    debugLastAiImpactPhase01 = phase01;
    debugLastAiImpactDamage = staminaDamage;
    debugLastAiImpactTime = Time.time;
    if (debugRhythmImpactFrames)
    {
        Debug.Log(
            $"[AI RhythmImpact] HIT landed on playerFrame={impactFrame} (phase01={phase01:0.000}) " +
            $"predFrame={(hasCachedCommitPrediction ? cachedPredictedImpactFrame : -1)} " +
            $"tHit={(hasCachedCommitPrediction ? cachedPredictedTimeToLand : -1f):0.000}s " +
            $"aimOffsetFrames={rhythmAimOffsetFrames:0.00} dmg={staminaDamage:0.00}",
            this
        );
    }
    if (!enableRhythmTimingAutotune) return;
    if (!hasCachedCommitPrediction) return;
    int target = Mathf.Clamp(rhythmImpactTargetFrame, 1, 9);
    int signedDelta = SignedFrameDelta(impactFrame, target);
    float learn = Mathf.Clamp01(rhythmTimingLearnRate);
    float correction = signedDelta * learn;
    float nudge = 0f;
    if (rhythmTimingRandomNudgeFrames > 0f)
    {
        float r = (rng != null) ? rng.Next01() : UnityEngine.Random.value;
        nudge = (r * 2f - 1f) * rhythmTimingRandomNudgeFrames;
    }
    rhythmAimOffsetFrames = Mathf.Clamp(
        rhythmAimOffsetFrames + correction + nudge,
        -Mathf.Abs(rhythmTimingMaxAimOffsetFrames),
        Mathf.Abs(rhythmTimingMaxAimOffsetFrames)
    );
    debugAimOffsetFrames = rhythmAimOffsetFrames;
    hasCachedCommitPrediction = false;
}
int SignedFrameDelta(int fromFrame, int toFrame)
{
    fromFrame = NormalizeFrame1to9(fromFrame);
    toFrame = NormalizeFrame1to9(toFrame);
    int cw = 0;
    int f = fromFrame;
    while (f != toFrame)
    {
        f = NormalizeFrame1to9(f + 1);
        cw++;
        if (cw > 9) break;
    }
    int ccw = 0;
    f = fromFrame;
    while (f != toFrame)
    {
        f = NormalizeFrame1to9(f - 1);
        ccw++;
        if (ccw > 9) break;
    }
    if (cw <= ccw) return +cw;
    return -ccw;
}
void RhythmCutTick()
{
    if (!enableRhythmCut) return;
    if (rhythmCutMediumPlusOnly && difficultyBand == DifficultyBand.Easy) return;
    if (Time.time < nextRhythmCutTickTime) return;
    nextRhythmCutTickTime = Time.time + Mathf.Max(0.005f, rhythmCutTickSeconds);
    if (Time.time < nextRhythmCutAllowedTime) return;
    if (playerRhythm == null) return;
    float dist = distToPlayerThisFrame >= 0f ? distToPlayerThisFrame : GetDistanceToPlayer();
    if (dist < attackRangeMin || dist > (attackRangeMax + 0.20f)) return;
    float oppAgg = (dataBank != null) ? dataBank.GetPlayerAggression(1.2f) : 0f;
    if (oppAgg < rhythmCutMinOppAggression) return;
    int oppWhiffsShort = (dataBank != null) ? dataBank.GetWhiffCount(AiActionDataBank.Actor.Player, 0.9f, true) : 0;
    bool patternCounterOpportunity = false;
    if (dataBank != null && dist <= patternRangeMax)
    {
        int dummyIdx;
        AiActionDataBank.HitPattern dummyPat;
        if (dataBank.TryGetCurrentPatternMatch(patternWindowSeconds, out dummyIdx, out dummyPat))
            patternCounterOpportunity = true;
    }
    bool whiffTrigger = oppWhiffsShort >= rhythmCutWhiffTriggerCount;
    bool closeTrigger = playerIsClosing && dist <= (idealRangeWhiffPunish + 0.15f);
    bool eligibleContext = whiffTrigger || patternCounterOpportunity || closeTrigger;
    if (!eligibleContext) return;
    if (!IsImpactTimingEligibleForRhythmCut(dist))
        return;
    float chance =
        (difficultyBand == DifficultyBand.Medium) ? rhythmCutAttemptChanceMedium :
        (difficultyBand == DifficultyBand.Hard) ? rhythmCutAttemptChanceHard :
        rhythmCutAttemptChanceHardcore;
    float mult = Mathf.Lerp(0.75f, 1.25f, Mathf.Clamp01(rhythmCutAggression01));
    chance = Mathf.Clamp01(chance * mult);
    float r = Next01();
    if (r > Mathf.Clamp01(chance)) return;
    rhythmCutUntil = Time.time + Mathf.Max(0.05f, rhythmCutHoldSeconds);
    nextRhythmCutAllowedTime = Time.time + Mathf.Max(0.05f, rhythmCutCooldownSeconds);
}
bool IsImpactTimingEligibleForRhythmCut(float dist)
{
    if (playerRhythm == null) return false;
    float phase01 = GetBestEffortRhythmPhase01(playerRhythm);
    int currentFrame = PhaseToNineFrame(phase01);
    float tHit = EstimateTimeToLandSeconds(dist);
    float cycleSeconds = GetBestEffortRhythmCycleSeconds(playerRhythm);
    if (cycleSeconds <= 0.05f) cycleSeconds = 0.60f; // safe fallback
    float aimSeconds = (rhythmAimOffsetFrames * (cycleSeconds / 9f));
float futurePhase = phase01 + ((tHit + aimSeconds) / cycleSeconds);
    futurePhase -= Mathf.Floor(futurePhase); // wrap 0..1
    int impactFrame = PhaseToNineFrame(futurePhase);
    int tol =
        (difficultyBand == DifficultyBand.Medium) ? Mathf.Max(0, rhythmCutImpactToleranceFramesMedium) :
        (difficultyBand == DifficultyBand.Hard) ? Mathf.Max(0, rhythmCutImpactToleranceFramesHard) :
        Mathf.Max(0, rhythmCutImpactToleranceFramesHardcore);
    return IsFrameInZoneWithTolerance(impactFrame, rhythmCutZoneStartFrame, rhythmCutZoneEndFrame, tol);
}
int PhaseToNineFrame(float phase01)
{
    float p = Mathf.Clamp01(phase01);
    int idx0 = Mathf.FloorToInt(p * 9f);      // 0..8
    return Mathf.Clamp(idx0 + 1, 1, 9);       // 1..9
}
bool IsFrameInZoneWithTolerance(int frame, int zoneStart, int zoneEnd, int tol)
{
    frame = NormalizeFrame1to9(frame);
    zoneStart = Mathf.Max(1, zoneStart);
    zoneEnd = Mathf.Max(zoneStart, zoneEnd);
    for (int d = -tol; d <= tol; d++)
    {
        int f = NormalizeFrame1to9(frame + d);
        if (IsFrameInZoneRaw(f, zoneStart, zoneEnd)) return true;
    }
    return false;
}
bool IsFrameInZoneRaw(int frame1to9, int zoneStart, int zoneEnd)
{
    frame1to9 = NormalizeFrame1to9(frame1to9);
    if (zoneEnd <= 9)
    {
        return frame1to9 >= zoneStart && frame1to9 <= zoneEnd;
    }
    else
    {
        int wrapEnd = zoneEnd - 9; // 10->1, 11->2
        return (frame1to9 >= zoneStart && frame1to9 <= 9) || (frame1to9 >= 1 && frame1to9 <= wrapEnd);
    }
}
int NormalizeFrame1to9(int f)
{
    int x = f % 9;
    if (x < 0) x += 9;
    if (x == 0) x = 9;
    return x;
}
float GetBestEffortRhythmPhase01(RhythmController rc)
{
    try { return Mathf.Clamp01(rc.rhythmPhase); } catch { }
    Type t = rc.GetType();
    object o = rc;
    float v;
    if (TryGetFloatMember(t, o, "rhythmPhase", out v)) return Mathf.Clamp01(v);
    if (TryGetFloatMember(t, o, "phase", out v)) return Mathf.Clamp01(v);
    if (TryGetFloatMember(t, o, "Phase01", out v)) return Mathf.Clamp01(v);
    return 0.5f;
}
float GetBestEffortRhythmCycleSeconds(RhythmController rc)
{
    Type t = rc.GetType();
    object o = rc;
    float v;
    if (TryGetFloatMember(t, o, "cycleSeconds", out v)) return Mathf.Max(0.01f, v);
    if (TryGetFloatMember(t, o, "rhythmCycleSeconds", out v)) return Mathf.Max(0.01f, v);
    if (TryGetFloatMember(t, o, "secondsPerCycle", out v)) return Mathf.Max(0.01f, v);
    int speed = 1;
    try { speed = rc.rhythmSpeed; } catch { speed = 1; }
    speed = Mathf.Clamp(speed, 0, 4);
    switch (speed)
    {
        case 0: return 0.75f;
        case 1: return 0.66f;
        case 2: return 0.56f;
        case 3: return 0.48f;
        case 4: return 0.42f;
    }
    return 0.60f;
}
float EstimateTimeToLandSeconds(float dist)
{
    float baseHit =
        (dist >= 1.15f) ? 0.20f :
        (dist >= 0.85f) ? 0.18f :
        0.16f;
    float lvlMult = 1f;
    if (levelController != null)
    {
        Type t = levelController.GetType();
        object o = levelController;
        float v;
        if (TryGetFloatMember(t, o, "PunchSpeedMult", out v)) lvlMult = Mathf.Max(0.60f, 1f / Mathf.Max(0.01f, v));
        else if (TryGetFloatMember(t, o, "punchSpeedMult", out v)) lvlMult = Mathf.Max(0.60f, 1f / Mathf.Max(0.01f, v));
    }
    float fatigueMult = 1f;
    if (myFatigue != null)
        fatigueMult = Mathf.Lerp(1.00f, 1.18f, Mathf.Clamp01(myFatigue.FatigueProgress));
    return Mathf.Max(0.08f, baseHit * lvlMult * fatigueMult);
}
void ResetDirectionalTargetingToNeutral()
{
    directionalSlider01 = 0.50f;
    debugDirectionalSlider01 = directionalSlider01;
    playerHighBlockHeldSeconds = 0f;
    playerLowBlockHeldSeconds = 0f;
}
public void NotifyAiPunchContactedHighGuard()
{
    if (!enableDirectionalTargeting) return;
    float step = GetDirectionalStepByDifficulty();
    directionalSlider01 = Mathf.Clamp01(directionalSlider01 - step); // move toward BODY
    debugDirectionalSlider01 = directionalSlider01;
}
public void NotifyAiPunchContactedLowGuard()
{
    if (!enableDirectionalTargeting) return;
    float step = GetDirectionalStepByDifficulty();
    directionalSlider01 = Mathf.Clamp01(directionalSlider01 + step); // move toward HEAD
    debugDirectionalSlider01 = directionalSlider01;
}
float GetDirectionalStepByDifficulty()
{
    switch (difficultyBand)
    {
        case DifficultyBand.Easy: return Mathf.Max(0f, dirStepEasy);
        case DifficultyBand.Medium: return Mathf.Max(0f, dirStepMedium);
        case DifficultyBand.Hard: return Mathf.Max(0f, dirStepHard);
        case DifficultyBand.Hardcore: return Mathf.Max(0f, dirStepHardcore);
    }
    return 0.01f;
}
void UpdatePlayerDirectionalBlockHoldTimers(float dt)
{
    if (!enableDirectionalTargeting) return;
    bool high = IsPlayerHighBlockingDirectional();
    bool low = IsPlayerLowBlockingDirectional();
    if (high)
    {
        playerHighBlockHeldSeconds += dt;
        playerLowBlockHeldSeconds = 0f;
    }
    else if (low)
    {
        playerLowBlockHeldSeconds += dt;
        playerHighBlockHeldSeconds = 0f;
    }
    else
    {
        playerHighBlockHeldSeconds = 0f;
        playerLowBlockHeldSeconds = 0f;
    }
}
bool IsPlayerHighBlockingDirectional()
{
    if (playerDefense == null) return false;
    Type t = playerDefense.GetType();
    object o = playerDefense;
    if (TryGetBoolMember(t, o, "highBlockActive")) return true;
    if (TryGetBoolMember(t, o, "HighBlockActive")) return true;
    if (TryGetBoolMember(t, o, "isHighBlockActive")) return true;
    if (TryGetBoolMember(t, o, "IsHighBlockActive")) return true;
    if (TryGetBoolMember(t, o, "highBlock")) return true;
    if (TryGetBoolMember(t, o, "HighBlock")) return true;
    if (TryGetBoolMember(t, o, "isHighBlock")) return true;
    if (TryGetBoolMember(t, o, "IsHighBlock")) return true;
    return false;
}
bool IsPlayerLowBlockingDirectional()
{
    if (playerDefense == null) return false;
    Type t = playerDefense.GetType();
    object o = playerDefense;
    if (TryGetBoolMember(t, o, "lowBlockActive")) return true;
    if (TryGetBoolMember(t, o, "LowBlockActive")) return true;
    if (TryGetBoolMember(t, o, "isLowBlockActive")) return true;
    if (TryGetBoolMember(t, o, "IsLowBlockActive")) return true;
    if (TryGetBoolMember(t, o, "lowBlock")) return true;
    if (TryGetBoolMember(t, o, "LowBlock")) return true;
    if (TryGetBoolMember(t, o, "isLowBlock")) return true;
    if (TryGetBoolMember(t, o, "IsLowBlock")) return true;
    return false;
}
float GetAdaptiveHeadProbability01()
{
    if (!enableDirectionalTargeting) return 0.50f;
    float headP = Mathf.Clamp01(directionalSlider01);
    if (IsPlayerHighBlockingDirectional())
        headP = Mathf.Clamp01(headP - Mathf.Max(0f, leanBodyWhenPlayerHighBlocking));
    if (IsPlayerLowBlockingDirectional() && playerLowBlockHeldSeconds >= Mathf.Max(0.05f, playerLowBlockHeldSecondsForHeadBait))
        headP = Mathf.Clamp01(headP + Mathf.Max(0f, leanHeadWhenPlayerLowBlockingLong));
    if (difficultyBand == DifficultyBand.Medium) headP = Mathf.Clamp01(headP + headBaitBiasMedium);
    else if (difficultyBand == DifficultyBand.Hard) headP = Mathf.Clamp01(headP + headBaitBiasHard);
    else if (difficultyBand == DifficultyBand.Hardcore) headP = Mathf.Clamp01(headP + headBaitBiasHardcore);
    return headP;
}
bool IsWeaveAvailableNow()
{
    if(Time.time<nextWeaveAllowedTime) return false;
    if(!perfectReactActive&&!pendingPerfectReaction&&Time.time<nextPerfectReactTime) { }
    float now=Time.time;
    if(now-weaveDecisionWindowStart>=1f){weaveDecisionWindowStart=now;weaveDecisionsThisSecond=0;}
    int max=GetMaxWeaveDecisionsPerSecond();
    if(weaveDecisionsThisSecond>=max) return false;
    return true;
}
int GetMaxWeaveDecisionsPerSecond()
{
    if(difficultyBand==DifficultyBand.Easy) return 2;
    if(difficultyBand==DifficultyBand.Medium) return 3;
    if(difficultyBand==DifficultyBand.Hard) return 4;
    return 5;
}
float RollWeaveHoldSeconds(FistHitbox.PunchType punch,bool likelyBody)
{
    float r=Next01();
    float min=0.5f;
    float max=3.1f;
    if(likelyBody)
    {
        min=1.2f;
        max=3.1f;
    }
    else
    {
        if(punch==FistHitbox.PunchType.LeftHook||punch==FistHitbox.PunchType.RightHook)
        {
            min=0.9f;
            max=2.3f;
        }
        else if(punch==FistHitbox.PunchType.LeftUppercut||punch==FistHitbox.PunchType.RightUppercut)
        {
            min=1.2f;
            max=3.1f;
        }
        else
        {
            min=0.5f;
            max=1.4f;
        }
    }
    return Mathf.Lerp(min,max,Mathf.Clamp01(r));
}
void StartWeaveChain(FistHitbox.PunchType punch,bool likelyBody,float dirToPlayer)
{
    weaveChainActive=true;
    if(Time.time-weaveDecisionWindowStart>=1f){weaveDecisionWindowStart=Time.time;weaveDecisionsThisSecond=0;}
    weaveDecisionsThisSecond++;
    float wr=Next01();
    weaveDesiredMove=(wr<0.50f)?-dirToPlayer:+dirToPlayer;
    float hold=RollWeaveHoldSeconds(punch,likelyBody);
    perfectReactUntil=Time.time+hold;
    if(!weaveChainChanceInitialized)
    {
        weaveChainStartTime=Time.time;
        weaveChainChance01=0f;
        weaveChainChanceInitialized=false;
        weaveHitPenalty01=0f;
    }
}
bool TryContinueWeaveOrSwitchDefense()
{
    float myFrac=GetMyStaminaFrac();
    bool below20=myFrac<lowStaminaFraction;
    bool above20=!below20;
    if(above20)
    {
        if(Time.time<nextWeaveAllowedTime){SwitchDefenseAfterWeave();return true;}
    }
    float baseChance=0f;
    float since=Time.time-weaveChainStartTime;
    if(since>=5f)
    {
        if(!weaveChainChanceInitialized)
        {
            weaveChainChance01=RollRange01(0.50f,0.75f);
            weaveChainChanceInitialized=true;
        }
        else
        {
            weaveChainChance01=Mathf.Clamp01(weaveChainChance01+0.02f);
        }
        baseChance=weaveChainChance01;
    }
    float finalChance=baseChance;
    if(below20&&weaveHitPenalty01>0f)
        finalChance=Mathf.Clamp01(finalChance-weaveHitPenalty01);
    int max=GetMaxWeaveDecisionsPerSecond();
    if(Time.time-weaveDecisionWindowStart>=1f){weaveDecisionWindowStart=Time.time;weaveDecisionsThisSecond=0;}
    bool decisionLimited=weaveDecisionsThisSecond>=max;
    if(decisionLimited) finalChance=0f;
    float r=Next01();
    if(r<=finalChance)
    {
        float dx=player.position.x-transform.position.x;
        float dirToPlayer=Mathf.Sign(dx);
        if(dirToPlayer==0f)dirToPlayer=1f;
        forcedGuard=false;
        forcedDuck=false;
        stepOutDesiredMove=0f;
        forcedWeave=true;
        forcedWeaveDuck=false;
        StartWeaveChain(lastReactPunch,lastReactLikelyBody,dirToPlayer);
        return true;
    }
    if(above20)
    {
        nextWeaveAllowedTime=Time.time+Mathf.Lerp(2f,8f,Next01());
        weaveChainActive=false;
        weaveChainChanceInitialized=false;
        weaveChainChance01=0f;
    }
    SwitchDefenseAfterWeave();
    return true;
}
void SwitchDefenseAfterWeave()
{
    forcedWeave=false;
    forcedWeaveDuck=false;
    weaveDesiredMove=0f;
    float dx=player.position.x-transform.position.x;
    float dirToPlayer=Mathf.Sign(dx);
    if(dirToPlayer==0f)dirToPlayer=1f;
    float wD=Mathf.Max(0.01f,perfectReactDuckWeight);
    float wS=Mathf.Max(0.01f,perfectReactStepOutWeight);
    float wB=Mathf.Max(0.01f,perfectReactBlockWeight);
    float sum=wD+wS+wB;
    float r=Next01()*sum;
    forcedGuard=false;forcedHigh=false;forcedLow=false;forcedDuck=false;stepOutDesiredMove=0f;
    if(r<wD)
    {
        forcedDuck=true;
        perfectReactUntil=Time.time+perfectReactHoldTime;
        return;
    }
    if(r<wD+wS)
    {
        stepOutDesiredMove=-dirToPlayer;
        perfectReactUntil=Time.time+perfectReactHoldTime;
        return;
    }
    forcedGuard=true;
    float dirRoll=Next01();
    bool useUpDown=dirRoll<Mathf.Clamp01(perfectReactPreferUpDownWhenBlocking);
    if(!useUpDown){forcedHigh=false;forcedLow=false;perfectReactUntil=Time.time+perfectReactHoldTime;return;}
    bool shouldLow;
    if(lastReactHasPunchInfo){shouldLow=lastReactLikelyBody;}
    else{float b=GetBodyConditionFraction();float h=GetHeadConditionFraction();shouldLow=b>h;}
    float accRoll=Next01();
    bool followRead=accRoll<Mathf.Clamp01(perfectReactDirectionalAccuracy);
    bool finalLow=followRead?shouldLow:!shouldLow;
    forcedLow=finalLow;
    forcedHigh=!finalLow;
    perfectReactUntil=Time.time+perfectReactHoldTime;
}
void OnAiTookHitForWeaveLogic()
{
    if(!(forcedWeave||forcedWeaveDuck)) return;
    float myFrac=GetMyStaminaFrac();
    bool below20=myFrac<lowStaminaFraction;
    if(below20)
    {
        weaveHitPenalty01=Mathf.Clamp01(weaveHitPenalty01+0.05f);
        weaveChainStartTime=Time.time;
        weaveChainChanceInitialized=false;
        weaveChainChance01=0f;
        return;
    }
    float disableChance=
        (difficultyBand==DifficultyBand.Easy)?0.70f:
        (difficultyBand==DifficultyBand.Medium)?0.55f:
        (difficultyBand==DifficultyBand.Hard)?0.40f:
        0.25f;
    float r=Next01();
    if(r<=disableChance)
    {
        nextWeaveAllowedTime=Time.time+Mathf.Lerp(2f,8f,Next01());
        weaveChainActive=false;
        weaveChainChanceInitialized=false;
        weaveChainChance01=0f;
        forcedWeave=false;
        forcedWeaveDuck=false;
        weaveDesiredMove=0f;
        perfectReactUntil=Time.time;
    }
    else
    {
        weaveChainStartTime=Time.time;
        weaveChainChanceInitialized=false;
        weaveChainChance01=0f;
    }
}
    float GetDistanceToPlayer()
    {
        if (player == null) return 999f;
        return Mathf.Abs(player.position.x - transform.position.x);
    }
    float GetMyStaminaFrac()
    {
        return (myStats != null && myStats.maxStamina > 0f)
            ? Mathf.Clamp01(myStats.currentStamina / myStats.maxStamina)
            : 1f;
    }
    float GetPlayerStaminaFrac()
    {
        return (playerStats != null && playerStats.maxStamina > 0f)
            ? Mathf.Clamp01(playerStats.currentStamina / playerStats.maxStamina)
            : 1f;
    }
    float GetCognitiveLoadBias()
    {
        float myFrac = GetMyStaminaFrac();
        if (myFrac <= deepSurvivalFraction) return 1.35f;
        if (survivalModeActive) return 1.25f;
        if (currentPhase == TacticalPhase.Panic) return 1.15f;
        return 1f;
    }
    bool ThinkAwake(ref float timer, float baseInterval, float cognitiveLoadBias = 1f)
    {
        float dt = Time.deltaTime;
        timer += dt;
        float staminaFrac = GetMyStaminaFrac();
        float diff = Mathf.Clamp01(difficultyScore);
        float staminaMult = Mathf.Lerp(1.35f, 0.75f, staminaFrac);
        float diffMult = Mathf.Lerp(1.15f, 0.75f, diff);
        float wmClamped = Mathf.Clamp(winnerMindIntensity, 0.2f, 1.2f);
        float wmNorm = Mathf.InverseLerp(0.2f, 1.2f, wmClamped);
        float winnerMult = Mathf.Lerp(1.05f, 0.85f, wmNorm);
        float interval = baseInterval * staminaMult * diffMult * winnerMult * Mathf.Max(0.1f, cognitiveLoadBias);
        if (timer >= interval)
        {
            timer = 0f;
            return true;
        }
        return false;
    }
    void AutoWireFistsIfNeeded()
    {
        if (leftFist != null && rightFist != null) return;
        FistHitbox[] fists = GetComponentsInChildren<FistHitbox>();
        foreach (var f in fists)
        {
            string n = f.gameObject.name.ToLower();
            if (leftFist == null && n.Contains("left")) leftFist = f;
            else if (rightFist == null && n.Contains("right")) rightFist = f;
        }
        if ((leftFist == null || rightFist == null) && fists.Length > 0)
        {
            if (leftFist == null) leftFist = fists[0];
            if (rightFist == null && fists.Length > 1) rightFist = fists[1];
        }
    }
    void TryAutoWireOpponent()
    {
        if ((player == null || playerStats == null) && myController != null)
        {
            FighterController[] controllers = FindObjectsOfType<FighterController>();
            foreach (var fc in controllers)
            {
                if (fc == myController) continue;
                playerController = fc;
                player = fc.transform;
                playerStats = fc.GetComponent<FighterStats>();
    if (playerRhythm == null)
    {
        playerRhythm = fc.GetComponent<RhythmController>();
        if (playerRhythm == null) playerRhythm = fc.GetComponentInChildren<RhythmController>();
    }
                break;
            }
        }
        if (playerDefense == null)
        {
            DefenseController[] defs = FindObjectsOfType<DefenseController>();
            foreach (var d in defs)
            {
                if (d == defense) continue;
                if (d.isPlayerControlled)
                {
                    playerDefense = d;
                    break;
                }
            }
        }
        if (playerStats != null) enemyStats = playerStats;
        if (playerController != null && playerCrit == null)
            playerCrit = playerController.GetComponent<CritController>();
        if (playerCrit == null && playerStats != null)
            playerCrit = playerStats.GetComponent<CritController>();
        if (playerController != null && playerClinch == null)
            playerClinch = playerController.GetComponent<ClinchController>();
        if (playerClinch == null && player != null)
            playerClinch = player.GetComponentInChildren<ClinchController>();
    }
    void SetupPlayerHeadReference()
    {
        if (playerDefense != null && playerDefense.head != null)
        {
            playerHead = playerDefense.head;
            playerHeadNeutralY = playerHead.localPosition.y;
            playerHeadNeutralSet = true;
            return;
        }
        if (player != null && playerHead == null)
        {
            Transform found = player.Find("Head");
            if (found != null)
            {
                playerHead = found;
                playerHeadNeutralY = playerHead.localPosition.y;
                playerHeadNeutralSet = true;
            }
        }
    }
    bool TryInvokeBoolMethod(Type t, object obj, string name, bool arg)
    {
        var m = t.GetMethod(name, BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);
        if (m == null) return false;
        var pars = m.GetParameters();
        if (pars == null || pars.Length != 1 || pars[0].ParameterType != typeof(bool)) return false;
        try { m.Invoke(obj, new object[] { arg }); return true; }
        catch { return false; }
    }
    bool TrySetBoolMember(Type t, object obj, string name, bool value)
    {
        var f = t.GetField(name, BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);
        if (f != null && f.FieldType == typeof(bool))
        {
            try { f.SetValue(obj, value); return true; } catch { return false; }
        }
        var p = t.GetProperty(name, BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);
        if (p != null && p.PropertyType == typeof(bool) && p.CanWrite)
        {
            try { p.SetValue(obj, value, null); return true; } catch { return false; }
        }
        return false;
    }
    bool TryGetFloatMember(Type t, object obj, string name, out float value)
    {
        value = 0f;
        var f = t.GetField(name, BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);
        if (f != null && f.FieldType == typeof(float))
        {
            try { value = (float)f.GetValue(obj); return true; } catch { return false; }
        }
        var p = t.GetProperty(name, BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);
        if (p != null && p.PropertyType == typeof(float) && p.CanRead)
        {
            try { value = (float)p.GetValue(obj, null); return true; } catch { return false; }
        }
        return false;
    }
    bool TryGetIntMember(Type t, object obj, string name, out int value)
    {
        value = 0;
        var f = t.GetField(name, BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);
        if (f != null && f.FieldType == typeof(int))
        {
            try { value = (int)f.GetValue(obj); return true; } catch { return false; }
        }
        var p = t.GetProperty(name, BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);
        if (p != null && p.PropertyType == typeof(int) && p.CanRead)
        {
            try { value = (int)p.GetValue(obj, null); return true; } catch { return false; }
        }
        return false;
    }
    bool TryGetIntArrayMember(Type t, object obj, string name, out int[] arr)
    {
        arr = null;
        var f = t.GetField(name, BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);
        if (f != null && f.FieldType == typeof(int[]))
        {
            try { arr = (int[])f.GetValue(obj); return true; } catch { return false; }
        }
        var p = t.GetProperty(name, BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);
        if (p != null && p.PropertyType == typeof(int[]) && p.CanRead)
        {
            try { arr = (int[])p.GetValue(obj, null); return true; } catch { return false; }
        }
        return false;
    }
    bool TryGetBoolMember(Type t, object obj, string name)
    {
        var f = t.GetField(name, BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);
        if (f != null && f.FieldType == typeof(bool))
        {
            try { return (bool)f.GetValue(obj); } catch { return false; }
        }
        var p = t.GetProperty(name, BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);
        if (p != null && p.PropertyType == typeof(bool) && p.CanRead)
        {
            try { return (bool)p.GetValue(obj, null); } catch { return false; }
        }
        return false;
    }
    bool TryGetPunchTypeMember(Type t, object obj, string name, out FistHitbox.PunchType punch)
    {
        punch = FistHitbox.PunchType.Jab;
        var f = t.GetField(name, BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);
        if (f != null && f.FieldType == typeof(FistHitbox.PunchType))
        {
            try { punch = (FistHitbox.PunchType)f.GetValue(obj); return true; } catch { return false; }
        }
        var p = t.GetProperty(name, BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);
        if (p != null && p.PropertyType == typeof(FistHitbox.PunchType) && p.CanRead)
        {
            try { punch = (FistHitbox.PunchType)p.GetValue(obj, null); return true; } catch { return false; }
        }
        return false;
    }
}