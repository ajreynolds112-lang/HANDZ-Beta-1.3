using UnityEngine;
using UnityEngine.SceneManagement;
using System;
using System.Collections;
using System.Collections.Generic;
using System.Reflection;
[RequireComponent(typeof(BoxCollider2D))]
public class FistHitbox : MonoBehaviour
{
    public enum PunchType { Jab, Cross, LeftHook, RightHook, LeftUppercut, RightUppercut }
    private const float CLEAN_HIT_BLOCK_THRESHOLD = 0.25f;
    private const float DEFAULT_LEFT_HAND_Y = 0.138f;
    private const float DEFAULT_RIGHT_HAND_Y = 0.164f;
    [Header("Punch Distances (in blocks)")]
    public float straightPunchDistance = 0.3f;
    public float hookPunchDistance = 0.25f;
    public float uppercutDistance = 0.2f;
    [Header("Arc Heights")]
    public float hookArcHeight = 0.18f;
    public float uppercutDipHeight = 0.20f;
    [Header("Dynamic Punch Distance (Launch Snapshot)")]
    public bool enableDynamicDistance = true;
    public Transform distanceOriginOverride;
    public float worldUnitsPerBlock = 1f;
    public float referenceDistanceBlocks = 0.9f;
    public float minDistanceScale = 0.75f;
    public float maxDistanceScale = 1.6f;
    [Range(0f, 1f)] public float distanceScaleStrength = 1.0f;
    public float distanceScaleExponent = 1.25f;
    public float distanceScaleDeadzone = 0.05f;
    public bool scaleArcWithDistance = true;
    public bool debugDynamicDistance = false;
    [Header("Dynamic Contact Landing")]
    [Range(-0.5f, 0.5f)] public float punchCorrectionOffsetBlocks = 0f;
    public bool dynamicLandOnOpponentHead = true;
    public bool retractImmediatelyWhenInRange = true;
    [Header("Timing (seconds)")]
    public float launchDelay = 0.08f;
    public float extendTime = 0.10f;
    public float lingerTime = 0.04f;
    public float retractTime = 0.12f;
    [Header("Feint Settings")]
    public float feintDistanceMult = 0.75f;
    public float feintRetractMult = 0.75f;
    [Header("Punch-To-Feint (Hold Punch Key)")]
    public bool enablePunchToFeint = true;
    public float punchToFeintCounterPauseSeconds = 1.5f;
    [Header("Feint Conditioning Range")]
    public float feintInRangeMin = 0.7f;
    public float feintInRangeMax = 1.4f;
    public float feintBodyRangeThreshold = 0.9f;
    [Header("Damage Settings")]
    public float jabDamage = 10f;
    public float crossDamage = 15f;
    public float hookDamage = 12f;
    public float uppercutDamage = 20f;
    [Header("Stamina Costs")]
    public float jabStaminaCost = 12f;
    public float crossStaminaCost = 24f;
    public float hookStaminaCost = 16f;
    public float uppercutStaminaCost = 28f;
    [Header("Combo Stamina Penalty")]
    public float comboWindowSeconds = 5f;
    public float comboCooldownSeconds = 1f;
    public int freePunchesAtLevel1 = 3;
    public int freePunchesAtLevel100 = 10;
    public float comboExponentialBase = 1.3f;
    [Header("Hit Settings")]
    public LayerMask targetLayers;
    [Header("Accuracy")]
    [Range(0f, 1f)] public float baseAccuracy = 0.75f;
    [Header("Vertical Punch Offsets")]
    public float standingPunchYOffset = 0f;
    public float duckBodyPunchYOffset = -0.25f;
    public float duckHighPunchYOffset = 0.45f;
    [Header("Stamina Regen Interaction")]
    [Range(0f, 1f)] public float regenSlowPerActivePunch = 0.10f;
    [Header("Charge Punch Interrupt (Stuffed Charge)")]
    public bool chargePunchCanBeInterrupted = true;
    public float chargeInterruptStaminaLossThreshold = 0.75f;
    [Header("Charge Punch Tunables (Inspector)")]
    public bool overrideCritControllerChargeTunables = true;
    public float chargeCooldownSeconds = 2.5f;
    public float chargePunchDamageMultiplier = 3.0f;
    [Range(0f, 1f)] public float chargePunchBaseAccuracy = 0.60f;
    public float chargeStaminaCostMultiplier = 1.0f;
    [Header("Charge Punch Timing Multipliers")]
    public float chargeLaunchDelayMult = 1.25f;
    public float chargeExtendTimeMult = 1.00f;
    public float chargeLingerTimeMult = 1.00f;
    public float chargeRetractTimeMult = 1.35f;
    [Header("Charge Punch Local Fallback (optional)")]
    public bool allowLocalChargeFallback = true;
    [Header("Fight / Scoring (optional)")]
    public FightManager fightManager;
    [Header("External Punch Disable (Stun / Effects)")]
    [SerializeField] private float punchDisabledUntil = 0f;
    public bool cancelCurrentPunchWhenDisabled = true;
    public bool debugPunchDisable = false;
    [Header("CLINCH - Punch Fail / Struggle")]
    public bool enableClinchPunchFail = true;
    [Range(0f, 1f)] public float clinchFailChanceLevel1 = 0.75f;
    [Range(0f, 1f)] public float clinchFailChanceLevel100 = 0.50f;
    [Range(0f, 1f)] public float clinchStruggleMaxFailReduction = 0.50f;
    [Range(0f, 5f)] public float clinchStarterPunchLockSeconds = 1.5f;
    [Range(0f, 1f)] public float clinchStarterBypassStruggleThreshold = 0.35f;
    public float clinchStruggleDecayPerSecond = 1.6f;
    [Range(0.01f, 1f)] public float clinchStruggleGainPerKeyDown = 0.18f;
    public bool clinchStruggleUsesPlayerKeyboard = true;
    [Header("CLINCH - Damage Multipliers")]
    public float clinchStraightDamageMult = 0.5f;
    public float clinchPowerDamageMult = 1.5f;
    [Header("CLINCH - Optional Debug")]
    public bool debugClinch = false;
    public float PunchDisabledUntil
    {
        get => punchDisabledUntil;
        set => punchDisabledUntil = Mathf.Max(punchDisabledUntil, value);
    }
    public bool punchDisabled = false;
    private BoxCollider2D col;
    private FighterStats ownerStats;
    private CritController ownerCrit;
    private TimeBasedRNG rng;
    private RhythmController rhythm;
    private FighterController ownerController;
    private DefenseController ownerDefense;
    private DefenseController snapTargetDefenseAtLaunch = null;
    private ClinchController ownerClinch;
    private HitstopController ownerHitstop;
    private LevelController levelController;
    private FatigueController ownerFatigue;
    private Vector3 neutralLocalPosition;
    private Vector3 currentIdleLocalPosition;
    private bool canStartNewPunch = true;
    private bool hasHitThisPunch = false;
    private bool inDamagePhase = false;
    private bool isPunching = false;
    private bool isFeint = false;
    private bool isChargePunch = false;
    private bool whiffRegisteredThisPunch = false;
    private bool isPunchToFeintHold = false;
    private PunchType currentPunchType;
    private Coroutine punchRoutine;
    private Coroutine idleMoveRoutine;
    private int headLayer;
    private int torsoLayer;
    private int bodyLayer;
    private static AiActionDataBank cachedAiDataBank;
    private static Transform cachedAiTransform;
    private bool hasAccuracyRoll = false;
    private bool accuracyRollResult = true;
    private float lastAccuracyValue = 1f;
    private bool duckHighPunchActive = false;
    private float chargeWindupBaselineStamina = 0f;
    private bool chargeWindupActive = false;
    private float externalExtendSpeedMult = 1f;
    private float externalExtendMultTimer = 0f;
    private float localChargeReadyAtTime = 0f;
    private float snapStraightDist;
    private float snapHookDist;
    private float snapUpperDist;
    private float snapHookArc;
    private float snapUpperDip;
    private float punchMaxDistSnap;
    private float punchReachDistSnap;
    private float punchReachRatioSnap;
    private bool punchAnticipatedContactSnap;
    private float straightPunchThroughDelaySnap = 0f;
    private float straightPunchThroughDamageMultSnap = 1f;
    private bool straightPunchThroughEligibleSnap = false;
    private KeyCode currentPunchKey = KeyCode.None;
    private bool wasClinchingLastFrame = false;
    private float clinchEnterTime = -999f;
    private float clinchStruggle01 = 0f;
    private bool isLeftHand = false;
    public bool IsPunchToFeintActive => isPunchToFeintHold;
    public bool IsLeftHand => isLeftHand;
    public bool IsPunchingNow => isPunching;
    private FighterController cachedTargetController;
    public void ApplyExtendSpeedMultiplier(float mult, float duration)
    {
        mult = Mathf.Clamp(mult, 0.1f, 1f);
        duration = Mathf.Max(0f, duration);
        externalExtendSpeedMult = Mathf.Min(externalExtendSpeedMult, mult);
        externalExtendMultTimer = Mathf.Max(externalExtendMultTimer, duration);
    }
    public void DisablePunchingForSeconds(float duration)
    {
        duration = Mathf.Max(0f, duration);
        float until = Time.time + duration;
        punchDisabledUntil = Mathf.Max(punchDisabledUntil, until);
        punchDisabled = true;
        if (debugPunchDisable) Debug.Log($"[FistHitbox] Punching disabled until t={punchDisabledUntil:0.00} (+{duration:0.00}s)", this);
        if (cancelCurrentPunchWhenDisabled && isPunching) CancelCurrentPunchImmediate();
    }
    bool IsPunchingDisabledNow()
    {
        bool timed = Time.time < punchDisabledUntil;
        bool flag = punchDisabled;
        return timed || flag;
    }
    void Update()
    {
        if (externalExtendMultTimer > 0f)
        {
            externalExtendMultTimer -= Time.deltaTime;
            if (externalExtendMultTimer <= 0f)
            {
                externalExtendMultTimer = 0f;
                externalExtendSpeedMult = 1f;
            }
        }
        if (punchDisabled && Time.time >= punchDisabledUntil)
        {
            punchDisabled = false;
            if (debugPunchDisable) Debug.Log("[FistHitbox] Punching disable expired", this);
        }
        UpdateClinchStateAndStruggle(Time.deltaTime);
    }
    bool IsOwnerClinchingNow()
    {
        bool viaClinch = (ownerClinch != null && ownerClinch.IsClinching);
        bool viaDefense = (ownerDefense != null && ownerDefense.IsClinchActive());
        return viaClinch || viaDefense;
    }
    static bool IsTargetClinchingNow(FighterStats targetStats)
    {
        if (targetStats == null) return false;
        DefenseController d = targetStats.GetComponentInParent<DefenseController>();
        if (d != null && d.IsClinchActive()) return true;
        ClinchController c = targetStats.GetComponentInParent<ClinchController>();
        if (c != null && c.IsClinching) return true;
        return false;
    }
    void UpdateClinchStateAndStruggle(float dt)
    {
        bool clinchingNow = IsOwnerClinchingNow();
        if (clinchchingNowSafe(clinchingNow) && !wasClinchingLastFrame)
        {
            clinchEnterTime = Time.time;
            clinchStruggle01 = 0f;
            if (debugClinch) Debug.Log($"[Clinch] {name} ENTER clinch. iStarted={(ownerClinch != null && ownerClinch.IStartedThisClinch)}", this);
        }
        else if (!clinchchingNowSafe(clinchingNow) && wasClinchingLastFrame)
        {
            clinchStruggle01 = 0f;
            if (debugClinch) Debug.Log($"[Clinch] {name} EXIT clinch.", this);
        }
        if (clinchStruggle01 > 0f)
        {
            clinchStruggle01 -= dt * Mathf.Max(0f, clinchStruggleDecayPerSecond);
            clinchStruggle01 = Mathf.Clamp01(clinchStruggle01);
        }
        if (clinchStruggleUsesPlayerKeyboard && clinchingNow && ownerController != null && ownerController.isPlayerControlled)
        {
            bool anyRelevantDown =
                Input.GetKeyDown(KeyCode.LeftArrow) ||
                Input.GetKeyDown(KeyCode.RightArrow) ||
                Input.GetKeyDown(KeyCode.UpArrow) ||
                Input.GetKeyDown(KeyCode.DownArrow) ||
                Input.GetKeyDown(KeyCode.Space) ||
                Input.GetKeyDown(KeyCode.W) ||
                Input.GetKeyDown(KeyCode.E) ||
                Input.GetKeyDown(KeyCode.Q) ||
                Input.GetKeyDown(KeyCode.R) ||
                Input.GetKeyDown(KeyCode.S) ||
                Input.GetKeyDown(KeyCode.D) ||
                Input.GetKeyDown(KeyCode.T);
            if (anyRelevantDown)
                clinchStruggle01 = Mathf.Clamp01(clinchStruggle01 + Mathf.Max(0.01f, clinchStruggleGainPerKeyDown));
        }
        wasClinchingLastFrame = clinchingNow;
    }
    bool clinchchingNowSafe(bool v) => v;
    bool CanAttemptPunchDuringClinchNow()
    {
        if (!IsOwnerClinchingNow()) return true;
        bool iStarted = (ownerClinch != null && ownerClinch.IsClinching && ownerClinch.IStartedThisClinch);
        if (iStarted)
        {
            float elapsed = Time.time - clinchEnterTime;
            if (elapsed < Mathf.Max(0f, clinchStarterPunchLockSeconds))
            {
                if (clinchStruggle01 < Mathf.Clamp01(clinchStarterBypassStruggleThreshold))
                {
                    if (debugClinch) Debug.Log($"[Clinch] Starter punch locked. elapsed={elapsed:0.00}s struggle={clinchStruggle01:0.00}", this);
                    return false;
                }
            }
        }
        return true;
    }
    float GetClinchFailChance()
    {
        int lvl = 1;
        if (levelController != null) lvl = Mathf.Clamp(levelController.level, 1, 100);
        float t = (lvl - 1) / 99f;
        float baseFail = Mathf.Lerp(clinchFailChanceLevel1, clinchFailChanceLevel100, t);
        baseFail = Mathf.Clamp01(baseFail);
        float reduction = Mathf.Clamp01(clinchStruggle01) * Mathf.Clamp01(clinchStruggleMaxFailReduction);
        float finalFail = baseFail * (1f - reduction);
        finalFail = Mathf.Clamp(finalFail, 0.02f, 0.99f);
        return finalFail;
    }
    bool RollClinchPunchFail()
    {
        float failChance = GetClinchFailChance();
        float roll = (rng != null) ? rng.Next01() : UnityEngine.Random.value;
        bool failed = (roll <= failChance);
        if (debugClinch) Debug.Log($"[Clinch] Punch FAIL roll={roll:0.00} failChance={failChance:0.00} struggle={clinchStruggle01:0.00}", this);
        return failed;
    }
    public void AddClinchStruggle(float amount01)
    {
        clinchStruggle01 = Mathf.Clamp01(clinchStruggle01 + Mathf.Abs(amount01));
    }
    private class ComboState
    {
        public int comboPunchCount;
        public float comboStartTime;
        public float lastPunchTime;
    }
    private static readonly Dictionary<FighterController, ComboState> comboStates = new Dictionary<FighterController, ComboState>();
    ComboState GetComboStateForOwner()
    {
        if (ownerController == null) return null;
        if (!comboStates.TryGetValue(ownerController, out var state))
        {
            state = new ComboState { comboPunchCount = 0, comboStartTime = -999f, lastPunchTime = -999f };
            comboStates.Add(ownerController, state);
        }
        return state;
    }
    private static readonly HashSet<FighterController> globalPunchLockedOwners = new HashSet<FighterController>();
    private static readonly HashSet<FighterController> guardContactLockedOwners = new HashSet<FighterController>();
    private bool ownsGlobalPunchLock = false;
    private bool feintGuardLockEngaged = false;
    private float feintGuardContactTimer = 0f;
    private FighterController feintGuardLockedOpponent;
    private DefenseController feintGuardOpponentDefense;
    private const float FEINT_GUARD_LOCK_DELAY = 0.3f;
    private bool feintTouchingBlockingGuard = false;
    private bool feintRegenSlowed = false;
    private float feintBaseRegenPerSecond = 0f;
    void Awake()
    {
        col = GetComponent<BoxCollider2D>();
        col.isTrigger = true;
        ownerStats = GetComponentInParent<FighterStats>();
        ownerCrit = GetComponentInParent<CritController>();
        rng = GetComponentInParent<TimeBasedRNG>();
        rhythm = GetComponentInParent<RhythmController>();
        ownerController = GetComponentInParent<FighterController>();
        ownerDefense = GetComponentInParent<DefenseController>();
        ownerClinch = GetComponentInParent<ClinchController>();
        levelController = LevelController.GetFor(this);
        ownerFatigue = FatigueController.GetFor(this);
        ownerHitstop = HitstopController.GetFor(this);
        neutralLocalPosition = transform.localPosition;
        currentIdleLocalPosition = neutralLocalPosition;
        headLayer = LayerMask.NameToLayer("Head");
        torsoLayer = LayerMask.NameToLayer("Torso");
        bodyLayer = LayerMask.NameToLayer("Body");
        if (ownerController != null && ownerController.isPlayerControlled)
        {
            if (cachedAiDataBank == null) cachedAiDataBank = FindObjectOfType<AiActionDataBank>();
            if (cachedAiDataBank != null && cachedAiTransform == null) cachedAiTransform = cachedAiDataBank.transform;
        }
        if (ownerStats != null) feintBaseRegenPerSecond = ownerStats.staminaRegenPerSecond;
        if (fightManager == null) fightManager = FindObjectOfType<FightManager>();
        if (ownerController != null) isLeftHand = (ownerController.leftFist == this);
        ForceDefaultNeutralHandY();
        SyncChargeTunablesToCritController();
        SceneManager.sceneLoaded += OnSceneLoaded;
    }
    void OnDestroy()
    {
        SceneManager.sceneLoaded -= OnSceneLoaded;
    }
    void OnSceneLoaded(Scene scene, LoadSceneMode mode)
    {
        ForceDefaultNeutralHandY();
        ResetToStartPose();
    }
    void ForceDefaultNeutralHandY()
    {
        float y = isLeftHand ? DEFAULT_LEFT_HAND_Y : DEFAULT_RIGHT_HAND_Y;
        neutralLocalPosition = new Vector3(neutralLocalPosition.x, y, neutralLocalPosition.z);
        currentIdleLocalPosition = neutralLocalPosition;
        if (!isPunching) transform.localPosition = neutralLocalPosition;
    }
    void OnValidate()
    {
        chargeCooldownSeconds = Mathf.Max(0.01f, chargeCooldownSeconds);
        chargePunchDamageMultiplier = Mathf.Max(1f, chargePunchDamageMultiplier);
        chargeStaminaCostMultiplier = Mathf.Max(0.1f, chargeStaminaCostMultiplier);
        chargeLaunchDelayMult = Mathf.Max(0.01f, chargeLaunchDelayMult);
        chargeExtendTimeMult = Mathf.Max(0.01f, chargeExtendTimeMult);
        chargeLingerTimeMult = Mathf.Max(0.01f, chargeLingerTimeMult);
        chargeRetractTimeMult = Mathf.Max(0.01f, chargeRetractTimeMult);
        worldUnitsPerBlock = Mathf.Max(0.0001f, worldUnitsPerBlock);
        referenceDistanceBlocks = Mathf.Max(0.01f, referenceDistanceBlocks);
        minDistanceScale = Mathf.Max(0.01f, minDistanceScale);
        maxDistanceScale = Mathf.Max(minDistanceScale, maxDistanceScale);
        distanceScaleExponent = Mathf.Max(0.01f, distanceScaleExponent);
        distanceScaleDeadzone = Mathf.Max(0f, distanceScaleDeadzone);
        clinchFailChanceLevel1 = Mathf.Clamp01(clinchFailChanceLevel1);
        clinchFailChanceLevel100 = Mathf.Clamp01(clinchFailChanceLevel100);
        clinchStruggleMaxFailReduction = Mathf.Clamp01(clinchStruggleMaxFailReduction);
        punchToFeintCounterPauseSeconds = Mathf.Max(0f, punchToFeintCounterPauseSeconds);
        if (!Application.isPlaying)
        {
            ownerCrit = GetComponentInParent<CritController>();
            SyncChargeTunablesToCritController();
        }
    }
    void OnDisable()
    {
        ReleaseGlobalPunchLockIfOwned();
        ReleaseGuardLockFromOpponent();
        ClearFeintRegenSlow();
        isPunchToFeintHold = false;
        chargeWindupActive = false;
        isChargePunch = false;
        isPunching = false;
        inDamagePhase = false;
        punchRoutine = null;
    }
    public void ResetToStartPose()
    {
        if (punchRoutine != null)
        {
            StopCoroutine(punchRoutine);
            punchRoutine = null;
        }
        if (idleMoveRoutine != null)
        {
            StopCoroutine(idleMoveRoutine);
            idleMoveRoutine = null;
        }
        ReleaseGuardLockFromOpponent();
        ReleaseGlobalPunchLockIfOwned();
        ClearFeintRegenSlow();
        canStartNewPunch = true;
        hasHitThisPunch = false;
        inDamagePhase = false;
        isPunching = false;
        isFeint = false;
        isChargePunch = false;
        isPunchToFeintHold = false;
        chargeWindupActive = false;
        chargeWindupBaselineStamina = 0f;
        hasAccuracyRoll = false;
        accuracyRollResult = true;
        lastAccuracyValue = 1f;
        currentPunchKey = KeyCode.None;
        externalExtendSpeedMult = 1f;
        externalExtendMultTimer = 0f;
        currentIdleLocalPosition = neutralLocalPosition;
        transform.localPosition = neutralLocalPosition;
    }
    bool IsOwnerHitstopped() => ownerHitstop != null && ownerHitstop.IsInHitstop;
    bool IsOwnerGloballyLocked()
    {
        if (ownerController == null) return false;
        return globalPunchLockedOwners.Contains(ownerController);
    }
    bool IsOwnerGuardLocked()
    {
        if (ownerController == null) return false;
        return guardContactLockedOwners.Contains(ownerController);
    }
    void AcquireGlobalPunchLock()
    {
        if (ownerController == null) return;
        if (IsOwnerGloballyLocked()) return;
        globalPunchLockedOwners.Add(ownerController);
        ownsGlobalPunchLock = true;
    }
    void ReleaseGlobalPunchLockIfOwned()
    {
        if (!ownsGlobalPunchLock) return;
        if (ownerController == null) return;
        globalPunchLockedOwners.Remove(ownerController);
        ownsGlobalPunchLock = false;
    }
    void ApplyGuardLockToOpponent(FighterController opp)
    {
        if (opp == null) return;
        guardContactLockedOwners.Add(opp);
    }
    void ClearGuardLock(FighterController opp)
    {
        if (opp == null) return;
        if (guardContactLockedOwners.Contains(opp)) guardContactLockedOwners.Remove(opp);
    }
    void ReleaseGuardLockFromOpponent()
    {
        if (feintGuardLockedOpponent != null)
        {
            ClearGuardLock(feintGuardLockedOpponent);
            feintGuardLockedOpponent = null;
        }
        feintGuardLockEngaged = false;
        feintGuardContactTimer = 0f;
        feintGuardOpponentDefense = null;
        feintTouchingBlockingGuard = false;
        ClearFeintRegenSlow();
    }
    int GetDynamicFreePunches()
    {
        int lvl = 1;
        if (levelController != null) lvl = Mathf.Clamp(levelController.level, 1, 100);
        if (lvl <= 1) return freePunchesAtLevel1;
        if (lvl >= 100) return freePunchesAtLevel100;
        float t = (lvl - 1) / 99f;
        float raw = freePunchesAtLevel1 + (freePunchesAtLevel100 - freePunchesAtLevel1) * t;
        return Mathf.RoundToInt(raw);
    }
    public void StartPunch(PunchType type) => StartPunch(type, KeyCode.None);
    public void StartFeint(PunchType type) => StartFeint(type, KeyCode.None);
    public void StartPunch(PunchType type, KeyCode punchKey)
    {
        if (IsPunchingDisabledNow()) return;
        if (!canStartNewPunch) return;
        if (IsOwnerGloballyLocked()) return;
        if (IsOwnerGuardLocked()) return;
        if (IsOwnerClinchingNow())
        {
            if (!CanAttemptPunchDuringClinchNow()) return;
            if (enableClinchPunchFail && RollClinchPunchFail()) return;
        }
        isFeint = false;
        isPunchToFeintHold = false;
        currentPunchKey = punchKey;
        BeginPunch(type);
    }
    public void StartFeint(PunchType type, KeyCode punchKey)
    {
        if (IsPunchingDisabledNow()) return;
        if (!canStartNewPunch) return;
        if (IsOwnerGloballyLocked()) return;
        if (IsOwnerGuardLocked()) return;
        isFeint = true;
        isPunchToFeintHold = false;
        currentPunchKey = punchKey;
        BeginPunch(type);
    }
    void BeginPunch(PunchType type)
    {
        if (IsPunchingDisabledNow()) return;
        currentPunchType = type;
        feintTouchingBlockingGuard = false;
        ClearFeintRegenSlow();
        duckHighPunchActive = false;
        if (ownerDefense != null && ownerDefense.IsDucking())
        {
            bool upHeld = Input.GetKey(KeyCode.UpArrow);
            bool downHeld = Input.GetKey(KeyCode.DownArrow);
            if (upHeld && downHeld) duckHighPunchActive = true;
        }
        if (isFeint && ownerController != null && ownerController.isPlayerControlled) LogFeintForConditioning();
        SyncChargeTunablesToCritController();
        isChargePunch = false;
        if (!isFeint && IsChargeReadyNow())
        {
            isChargePunch = true;
            PutChargeOnCooldownNow();
        }
        bool attackerIsPlayer = (ownerController != null && ownerController.isPlayerControlled);
        if (!isFeint)
        {
            hasAccuracyRoll = false;
            RollAccuracyForCurrentPunch();
            if (!TrySpendStaminaForCurrentPunch())
            {
                isChargePunch = false;
                chargeWindupActive = false;
                return;
            }
            if (fightManager != null)
            {
                fightManager.OnPunchThrown(attackerIsPlayer);
                if (isChargePunch) fightManager.RegisterChargePunchThrown(attackerIsPlayer);
            }
        }
        else
        {
            hasAccuracyRoll = false;
        }
        if (isChargePunch && ownerStats != null)
        {
            chargeWindupBaselineStamina = ownerStats.currentStamina;
            chargeWindupActive = true;
        }
        else chargeWindupActive = false;
        SnapshotDynamicDistancesAtLaunch();
        SnapshotDynamicReachAtLaunch();
        snapTargetDefenseAtLaunch = null;
        if (ownerController != null && ownerController.opponent != null)
            snapTargetDefenseAtLaunch = ownerController.opponent.GetComponentInParent<DefenseController>();
        AcquireGlobalPunchLock();
        if (punchRoutine != null) StopCoroutine(punchRoutine);
        punchRoutine = StartCoroutine(PunchRoutine());
    }
    void SnapshotDynamicDistancesAtLaunch()
    {
        snapStraightDist = straightPunchDistance;
        snapHookDist = hookPunchDistance;
        snapUpperDist = uppercutDistance;
        snapHookArc = hookArcHeight;
        snapUpperDip = uppercutDipHeight;
        if (!enableDynamicDistance) return;
        if (ownerController == null) return;
        if (ownerController.opponent == null) return;
        Transform origin = distanceOriginOverride != null ? distanceOriginOverride : ownerController.transform;
        float dxWorld = Mathf.Abs(ownerController.opponent.position.x - origin.position.x);
        float distanceBlocks = dxWorld / Mathf.Max(0.0001f, worldUnitsPerBlock);
        float rawScale = distanceBlocks / Mathf.Max(0.01f, referenceDistanceBlocks);
        rawScale = Mathf.Max(0.01f, rawScale);
        rawScale = Mathf.Pow(rawScale, Mathf.Max(0.01f, distanceScaleExponent));
        float scale = Mathf.Lerp(1f, rawScale, Mathf.Clamp01(distanceScaleStrength));
        if (Mathf.Abs(scale - 1f) < distanceScaleDeadzone) scale = 1f;
        scale = Mathf.Clamp(scale, minDistanceScale, maxDistanceScale);
        snapStraightDist *= scale;
        snapHookDist *= scale;
        snapUpperDist *= scale;
        if (scaleArcWithDistance)
        {
            snapHookArc *= scale;
            snapUpperDip *= scale;
        }
        if (debugDynamicDistance)
        {
            Debug.Log($"[FistHitbox DynamicDistance] {name} type={currentPunchType} feint={isFeint} dxWorld={dxWorld:0.00} blocks={distanceBlocks:0.00} rawScale={rawScale:0.00} finalScale={scale:0.00} snapStraight={snapStraightDist:0.00} snapHook={snapHookDist:0.00} snapUpper={snapUpperDist:0.00}", this);
        }
    }
    Transform FindOpponentHeadTarget()
    {
        if (ownerController == null || ownerController.opponent == null) return null;
        var cols = ownerController.opponent.GetComponentsInChildren<Collider2D>(true);
        for (int i = 0; i < cols.Length; i++)
        {
            if (cols[i] == null) continue;
            if (!cols[i].enabled) continue;
            if (cols[i].gameObject.layer == headLayer) return cols[i].transform;
        }
        return ownerController.opponent;
    }
    float QuantizePunchThrough(float v)
    {
        v = Mathf.Clamp(v, 0.01f, 0.05f);
        float q = Mathf.Round(v / 0.01f) * 0.01f;
        return Mathf.Clamp(q, 0.01f, 0.05f);
    }
    float PunchThroughDamageMult(float q)
    {
        if (q <= 0.0101f) return 0.96f;
        if (q <= 0.0201f) return 0.98f;
        if (q <= 0.0301f) return 1.00f;
        if (q <= 0.0401f) return 1.02f;
        return 1.10f;
    }
    void SnapshotDynamicReachAtLaunch()
    {
        punchMaxDistSnap = 0f;
        switch (currentPunchType)
        {
            case PunchType.Jab:
            case PunchType.Cross:
                punchMaxDistSnap = snapStraightDist;
                break;
            case PunchType.LeftHook:
            case PunchType.RightHook:
                punchMaxDistSnap = snapHookDist;
                break;
            default:
                punchMaxDistSnap = snapUpperDist;
                break;
        }
        float maxDist = Mathf.Max(0.0001f, punchMaxDistSnap);
        if (isFeint) maxDist *= Mathf.Max(0.01f, feintDistanceMult);
        Transform target = null;
        if (dynamicLandOnOpponentHead) target = FindOpponentHeadTarget();
        else if (ownerController != null) target = ownerController.opponent;
        float reach = maxDist;
        if (target != null)
        {
            float dxWorld = Mathf.Abs(target.position.x - transform.position.x);
            float distBlocks = dxWorld / Mathf.Max(0.0001f, worldUnitsPerBlock);
            distBlocks += punchCorrectionOffsetBlocks;
            reach = Mathf.Clamp(distBlocks, 0f, maxDist);
        }
        punchMaxDistSnap = maxDist;
        punchReachDistSnap = reach;
        punchReachRatioSnap = (maxDist <= 0.0001f) ? 1f : Mathf.Clamp01(reach / maxDist);
        punchAnticipatedContactSnap = (reach < maxDist - 0.0005f);
        bool straight = (currentPunchType == PunchType.Jab || currentPunchType == PunchType.Cross);
        straightPunchThroughDelaySnap = 0f;
        straightPunchThroughDamageMultSnap = 1f;
        straightPunchThroughEligibleSnap = false;
        if (!isFeint && straight && retractImmediatelyWhenInRange && punchAnticipatedContactSnap)
        {
            float roll = (rng != null) ? rng.Next01() : UnityEngine.Random.value;
            float raw = Mathf.Lerp(0.01f, 0.05f, roll);
            float q = QuantizePunchThrough(raw);
            straightPunchThroughDelaySnap = q;
            straightPunchThroughDamageMultSnap = PunchThroughDamageMult(q);
            straightPunchThroughEligibleSnap = true;
        }
    }
    void CancelCurrentPunchBecauseChargeStuffed()
    {
        inDamagePhase = false;
        isPunching = false;
        isPunchToFeintHold = false;
        transform.localPosition = currentIdleLocalPosition;
        ReleaseGuardLockFromOpponent();
        ReleaseGlobalPunchLockIfOwned();
        canStartNewPunch = true;
        isChargePunch = false;
        chargeWindupActive = false;
        punchRoutine = null;
    }
    void CancelCurrentPunchImmediate()
    {
        if (punchRoutine != null)
        {
            StopCoroutine(punchRoutine);
            punchRoutine = null;
        }
        inDamagePhase = false;
        isPunching = false;
        hasHitThisPunch = false;
        isPunchToFeintHold = false;
        transform.localPosition = currentIdleLocalPosition;
        ReleaseGuardLockFromOpponent();
        ReleaseGlobalPunchLockIfOwned();
        canStartNewPunch = true;
        isChargePunch = false;
        chargeWindupActive = false;
    }
    IEnumerator PunchRoutine()
    {
        canStartNewPunch = false;
        hasHitThisPunch = false;
        whiffRegisteredThisPunch = false;
        inDamagePhase = false;
        isPunching = true;
        isPunchToFeintHold = false;
        ReleaseGuardLockFromOpponent();
        bool attackerIsPlayer = (ownerController != null && ownerController.isPlayerControlled);
        float speedMult = 1f;
        if (levelController != null) speedMult *= Mathf.Max(0.01f, levelController.PunchSpeedMult);
        if (ownerFatigue != null) speedMult *= Mathf.Max(0.01f, ownerFatigue.PunchSpeedFatigueMult);
        float launchDelayLocal = launchDelay;
        float extendTimeLocal = extendTime;
        float lingerTimeLocal = lingerTime;
        float retractTimeLocal = retractTime;
        if (isChargePunch)
        {
            launchDelayLocal *= Mathf.Max(0.01f, chargeLaunchDelayMult);
            extendTimeLocal *= Mathf.Max(0.01f, chargeExtendTimeMult);
            lingerTimeLocal *= Mathf.Max(0.01f, chargeLingerTimeMult);
            retractTimeLocal *= Mathf.Max(0.01f, chargeRetractTimeMult);
        }
        if (!isFeint && launchDelayLocal > 0f)
        {
            float launchDuration = (launchDelayLocal / speedMult);
            float launchTimer = 0f;
            while (launchTimer < launchDuration)
            {
                if (!IsOwnerHitstopped())
                {
                    if (IsPunchingDisabledNow())
                    {
                        CancelCurrentPunchImmediate();
                        yield break;
                    }
                    if (isChargePunch && chargePunchCanBeInterrupted && chargeWindupActive && ownerStats != null)
                    {
                        float lost = (chargeWindupBaselineStamina - ownerStats.currentStamina);
                        if (lost >= Mathf.Max(0.01f, chargeInterruptStaminaLossThreshold))
                        {
                            CancelCurrentPunchBecauseChargeStuffed();
                            yield break;
                        }
                    }
                    launchTimer += Time.deltaTime;
                }
                yield return null;
            }
        }
        chargeWindupActive = false;
        float t = 0f;
        inDamagePhase = true;
        Vector3 idleAtPunchStart = currentIdleLocalPosition;
        float extendDuration = Mathf.Max((extendTimeLocal / speedMult) / Mathf.Max(0.01f, externalExtendSpeedMult), 0.0001f);
        if (!isFeint && snapTargetDefenseAtLaunch != null) snapTargetDefenseAtLaunch.NotifyOpponentPunchExtensionStart(extendDuration);
        bool straight = (currentPunchType == PunchType.Jab || currentPunchType == PunchType.Cross);
        bool stopAtContact = (!isFeint && straight && straightPunchThroughEligibleSnap);
        float contactT = Mathf.Clamp01(punchReachRatioSnap);
        float punchThroughTimer = 0f;
        while (t < 1f)
        {
            if (!IsOwnerHitstopped())
            {
                if (IsPunchingDisabledNow())
                {
                    CancelCurrentPunchImmediate();
                    yield break;
                }
                if (stopAtContact && t >= contactT)
                {
                    t = contactT;
                    Vector3 offC = GetPunchOffset(currentPunchType, t);
                    transform.localPosition = idleAtPunchStart + offC;
                    punchThroughTimer += Time.deltaTime;
                    if (punchThroughTimer >= straightPunchThroughDelaySnap) break;
                }
                else
                {
                    t += Time.deltaTime / extendDuration;
                    t = Mathf.Clamp01(t);
                    Vector3 offset = GetPunchOffset(currentPunchType, t);
                    transform.localPosition = idleAtPunchStart + offset;
                }
            }
            yield return null;
        }
        Vector3 endExtendPos = idleAtPunchStart + GetPunchOffset(currentPunchType, Mathf.Clamp01(t));
        transform.localPosition = endExtendPos;
        bool allowHoldAfterContact =
            enablePunchToFeint &&
            ownerController != null &&
            ownerController.isPlayerControlled &&
            currentPunchKey != KeyCode.None &&
            Input.GetKey(currentPunchKey);
        if (!isFeint && allowHoldAfterContact)
        {
            isPunchToFeintHold = true;
            Vector3 fullExtension = idleAtPunchStart + GetPunchOffset(currentPunchType, 1f);
            while (Input.GetKey(currentPunchKey))
            {
                if (!IsOwnerHitstopped())
                {
                    if (IsPunchingDisabledNow())
                    {
                        CancelCurrentPunchImmediate();
                        yield break;
                    }
                    if (ownerStats != null && !feintTouchingBlockingGuard)
                        ownerStats.PauseRegen(0.11f);
                    transform.localPosition = fullExtension;
                }
                yield return null;
            }
            isPunchToFeintHold = false;
            ClearFeintRegenSlow();
            feintTouchingBlockingGuard = false;
        }
        else if (isFeint && ownerController != null && ownerController.isPlayerControlled)
        {
            Vector3 fullExtension = idleAtPunchStart + GetPunchOffset(currentPunchType, 1f);
            while (Input.GetKey(KeyCode.F))
            {
                if (!IsOwnerHitstopped())
                {
                    if (IsPunchingDisabledNow())
                    {
                        CancelCurrentPunchImmediate();
                        yield break;
                    }
                    if (ownerStats != null && !feintTouchingBlockingGuard)
                        ownerStats.PauseRegen(0.11f);
                    transform.localPosition = fullExtension;
                }
                yield return null;
            }
            ClearFeintRegenSlow();
            feintTouchingBlockingGuard = false;
        }
        else
        {
            float lingerDuration = 0f;
            bool shouldSkipLinger = (!isFeint && retractImmediatelyWhenInRange && punchAnticipatedContactSnap && !stopAtContact);
            if (!shouldSkipLinger) lingerDuration = Mathf.Max(lingerTimeLocal / speedMult, 0.0001f);
            float lingerTimer = 0f;
            while (lingerTimer < lingerDuration)
            {
                if (!IsOwnerHitstopped())
                {
                    if (IsPunchingDisabledNow())
                    {
                        CancelCurrentPunchImmediate();
                        yield break;
                    }
                    lingerTimer += Time.deltaTime;
                }
                yield return null;
            }
        }
        inDamagePhase = false;
        ReleaseGuardLockFromOpponent();
        Vector3 startPos = transform.localPosition;
        Vector3 idleTarget = currentIdleLocalPosition;
        float rt = 0f;
        bool unlockGiven = false;
        bool globalUnlockGiven = false;
        float baseRetractDuration = retractTimeLocal / speedMult;
        if (isFeint || isPunchToFeintHold) baseRetractDuration *= Mathf.Max(0.01f, feintRetractMult);
        bool whiffForTiming = (!isFeint && !isPunchToFeintHold && !hasHitThisPunch);
        if (whiffForTiming) baseRetractDuration *= 1.25f;
        if (whiffForTiming)
        {
            DefenseController td = snapTargetDefenseAtLaunch;
            if (td == null && ownerController != null && ownerController.opponent != null)
                td = ownerController.opponent.GetComponentInParent<DefenseController>();
            if (td != null && td.IsWeaveDuckActive())
            {
                baseRetractDuration += 0.8f;
                if (ownerStats != null)
                    ownerStats.PauseRegen(1.5f);
            }
        }
        baseRetractDuration = Mathf.Max(baseRetractDuration, 0.0001f);
        while (rt < 1f)
        {
            if (!IsOwnerHitstopped())
            {
                rt += Time.deltaTime / baseRetractDuration;
                rt = Mathf.Clamp01(rt);
                transform.localPosition = Vector3.Lerp(startPos, idleTarget, rt);
                if (!globalUnlockGiven && rt >= 0.60f)
                {
                    ReleaseGlobalPunchLockIfOwned();
                    globalUnlockGiven = true;
                }
                if (!unlockGiven && rt >= 0.60f)
                {
                    canStartNewPunch = true;
                    unlockGiven = true;
                }
            }
            yield return null;
        }
        transform.localPosition = idleTarget;
        if (!unlockGiven) canStartNewPunch = true;
        if (!globalUnlockGiven) ReleaseGlobalPunchLockIfOwned();
        ReleaseGuardLockFromOpponent();
        if (!isFeint && !hasHitThisPunch && !whiffRegisteredThisPunch && fightManager != null)
        {
            fightManager.RegisterWhiff(attackerIsPlayer);
            whiffRegisteredThisPunch = true;
        }
        if (!isFeint && !isPunchToFeintHold && !hasHitThisPunch)
        {
            bool attackerDucking = (ownerDefense != null && ownerDefense.IsDucking());
            bool isHeadPunchAttempt = !(attackerDucking && !duckHighPunchActive);
            DefenseController td = snapTargetDefenseAtLaunch;
            if (td == null && ownerController != null && ownerController.opponent != null)
                td = ownerController.opponent.GetComponentInParent<DefenseController>();
            if (isHeadPunchAttempt && td != null && td.IsWeavingActive() && ownerDefense != null)
            {
                int lvl = 1;
                if (levelController != null) lvl = Mathf.Clamp(levelController.level, 1, 100);
                float dur = 1.0f + 0.02f * lvl;
                ownerDefense.ApplySeenPunchDebuff(dur);
            }
        }
        isChargePunch = false;
        isPunching = false;
        isPunchToFeintHold = false;
        punchRoutine = null;
    }
    Vector3 GetPunchOffset(PunchType type, float t)
    {
        float x = 0f;
        float y = 0f;
        float maxStraight = snapStraightDist;
        float maxHook = snapHookDist;
        float maxUpper = snapUpperDist;
        float hookArc = snapHookArc;
        float upperDip = snapUpperDip;
        float reach = punchReachDistSnap;
        float max = Mathf.Max(0.0001f, punchMaxDistSnap);
        float arcScale = Mathf.Clamp01(reach / max);
        if (isFeint)
        {
            maxStraight *= feintDistanceMult;
            maxHook *= feintDistanceMult;
            maxUpper *= feintDistanceMult;
            if (scaleArcWithDistance)
            {
                hookArc *= feintDistanceMult;
                upperDip *= feintDistanceMult;
            }
        }
        if (scaleArcWithDistance)
        {
            hookArc *= arcScale;
            upperDip *= arcScale;
        }
        float straight = (type == PunchType.Jab || type == PunchType.Cross) ? reach : maxStraight;
        float hookDist = (type == PunchType.LeftHook || type == PunchType.RightHook) ? reach : maxHook;
        float upperDist = (type == PunchType.LeftUppercut || type == PunchType.RightUppercut) ? reach : maxUpper;
        switch (type)
        {
            case PunchType.Jab:
            case PunchType.Cross:
                x = straight * t;
                break;
            case PunchType.LeftHook:
            case PunchType.RightHook:
                x = hookDist * t;
                y = hookArc * (4f * t * (1f - t));
                break;
            case PunchType.LeftUppercut:
            case PunchType.RightUppercut:
                x = upperDist * t;
                y = upperDip * (-4f * t * (1f - t));
                break;
        }
        float extraY = 0f;
        if (ownerDefense != null && ownerDefense.IsDucking())
            extraY = duckHighPunchActive ? duckHighPunchYOffset : duckBodyPunchYOffset;
        else
            extraY = standingPunchYOffset;
        y += extraY;
        return new Vector3(x, y, 0f);
    }
    float GetStaminaCostForCurrentPunch()
    {
        if (isFeint) return 0f;
        float cost = 0f;
        switch (currentPunchType)
        {
            case PunchType.Jab: cost = jabStaminaCost; break;
            case PunchType.Cross: cost = crossStaminaCost; break;
            case PunchType.LeftHook:
            case PunchType.RightHook: cost = hookStaminaCost; break;
            case PunchType.LeftUppercut:
            case PunchType.RightUppercut: cost = uppercutStaminaCost; break;
        }
        if (isChargePunch && cost > 0f) cost *= Mathf.Max(0.1f, chargeStaminaCostMultiplier);
        return cost;
    }
    bool TrySpendStaminaForCurrentPunch()
    {
        if (ownerStats == null) return true;
        float baseCost = GetStaminaCostForCurrentPunch();
        if (baseCost <= 0f) return true;
        ComboState state = GetComboStateForOwner();
        if (state == null) return ownerStats.TrySpendStamina(baseCost);
        float now = Time.time;
        bool comboExpiredByCooldown = (now - state.lastPunchTime) > comboCooldownSeconds;
        bool comboExpiredByWindow = (now - state.comboStartTime) > comboWindowSeconds;
        if (state.comboPunchCount == 0 || comboExpiredByCooldown || comboExpiredByWindow)
        {
            state.comboPunchCount = 0;
            state.comboStartTime = now;
        }
        int dynamicFreePunches = Mathf.Max(0, GetDynamicFreePunches());
        int nextPunchIndex = state.comboPunchCount + 1;
        float comboMult = 1f;
        if (nextPunchIndex > dynamicFreePunches)
        {
            int over = nextPunchIndex - dynamicFreePunches;
            float baseVal = comboExponentialBase <= 0f ? 1f : comboExponentialBase;
            comboMult = Mathf.Pow(baseVal, over);
        }
        float finalCost = baseCost * comboMult;
        bool spent = ownerStats.TrySpendStamina(finalCost);
        if (spent)
        {
            state.comboPunchCount = nextPunchIndex;
            state.lastPunchTime = now;
        }
        return spent;
    }
    bool RollAccuracyForCurrentPunch()
    {
        float baseAcc = baseAccuracy;
        if (isChargePunch) baseAcc = chargePunchBaseAccuracy;
        float acc = Mathf.Clamp01(baseAcc);
        if (levelController != null) acc *= levelController.AccuracyMult;
        if (rhythm != null) acc *= rhythm.GetAccuracyMultiplier();
        acc = Mathf.Clamp01(acc);
        lastAccuracyValue = acc;
        float roll = (rng != null) ? rng.Next01() : UnityEngine.Random.value;
        accuracyRollResult = (roll <= acc);
        hasAccuracyRoll = true;
        return accuracyRollResult;
    }
    bool CheckAccuracy()
    {
        if (!hasAccuracyRoll) RollAccuracyForCurrentPunch();
        return accuracyRollResult;
    }
    void TryApplyPunchToFeintCounterPenalty(FighterStats targetStats, float actualTaken)
    {
        if (actualTaken <= 0f) return;
        if (targetStats == null) return;
        FighterController targetFC = targetStats.GetComponentInParent<FighterController>();
        if (targetFC == null) return;
        bool targetLeftHeld = (targetFC.leftFist != null && targetFC.leftFist.IsPunchToFeintActive);
        bool targetRightHeld = (targetFC.rightFist != null && targetFC.rightFist.IsPunchToFeintActive);
        if (!targetLeftHeld && !targetRightHeld) return;
        bool attackerIsLeftHand = this.isLeftHand;
        bool qualifies =
            (targetLeftHeld && !attackerIsLeftHand) ||
            (targetRightHeld && attackerIsLeftHand);
        if (!qualifies) return;
        float dur = Mathf.Max(0f, punchToFeintCounterPauseSeconds);
        if (dur > 0f) targetStats.PauseRegen(dur);
    }
    void TryTriggerTargetFlash(FighterStats targetStats, bool wasCrit, float taken)
    {
        if (taken <= 0f) return;
        if (targetStats == null) return;
        FighterController fc = cachedTargetController;
        if (fc == null || fc.gameObject != targetStats.gameObject)
        {
            fc = targetStats.GetComponent<FighterController>();
            if (fc == null) fc = targetStats.GetComponentInParent<FighterController>();
            cachedTargetController = fc;
        }
        if (fc != null) fc.TriggerHitFlash(wasCrit);
    }
    void OnTriggerEnter2D(Collider2D other)
    {
        if (!inDamagePhase) return;
        if (hasHitThisPunch) return;
        if (isFeint) return;
        if (targetLayers.value != 0)
        {
            if (((1 << other.gameObject.layer) & targetLayers.value) == 0) return;
        }
        FighterStats targetStats = other.GetComponentInParent<FighterStats>();
        if (targetStats == null) return;
        if (!CheckAccuracy())
        {
            if (!whiffRegisteredThisPunch && fightManager != null)
            {
                bool attackerIsPlayer = (ownerController != null && ownerController.isPlayerControlled);
                fightManager.RegisterWhiff(attackerIsPlayer);
                whiffRegisteredThisPunch = true;
            }
            hasHitThisPunch = true;
            return;
        }
        DefenseController targetDefenseEarly = other.GetComponentInParent<DefenseController>();
        if (targetDefenseEarly != null && targetDefenseEarly.IsWeaveWhiffEligibleNow())
        {
            LevelController targetLevelControllerEarly = LevelController.GetFor(targetStats);
            int lvl = 1;
            if (targetLevelControllerEarly != null) lvl = Mathf.Clamp(targetLevelControllerEarly.level, 1, 100);
            float p = targetDefenseEarly.GetWeaveWhiffChanceProbability(lastAccuracyValue, lvl);
            float r = (rng != null) ? rng.Next01() : UnityEngine.Random.value;
            if (r <= p)
            {
                if (!whiffRegisteredThisPunch && fightManager != null)
                {
                    bool attackerIsPlayer = (ownerController != null && ownerController.isPlayerControlled);
                    fightManager.RegisterWhiff(attackerIsPlayer);
                    whiffRegisteredThisPunch = true;
                }
                targetDefenseEarly.NotifyWeaveResult(true);
                hasHitThisPunch = true;
                return;
            }
        }
        float damage = 0f;
        switch (currentPunchType)
        {
            case PunchType.Jab: damage = jabDamage; break;
            case PunchType.Cross: damage = crossDamage; break;
            case PunchType.LeftHook:
            case PunchType.RightHook: damage = hookDamage; break;
            case PunchType.LeftUppercut:
            case PunchType.RightUppercut: damage = uppercutDamage; break;
        }
        if (damage <= 0f)
        {
            hasHitThisPunch = true;
            return;
        }
        bool ownerClinched = IsOwnerClinchingNow();
        bool targetClinched = IsTargetClinchingNow(targetStats);
        bool anyClinch = ownerClinched || targetClinched;
        if (!anyClinch && !isFeint)
        {
            bool straight = (currentPunchType == PunchType.Jab || currentPunchType == PunchType.Cross);
            if (punchReachRatioSnap < 0.5f)
            {
                if (straight) damage *= 0.70f;
                else damage *= 1.30f;
            }
        }
        bool isStraight = (currentPunchType == PunchType.Jab || currentPunchType == PunchType.Cross);
        if (!anyClinch && isStraight && !isPunchToFeintHold && straightPunchThroughEligibleSnap)
            damage *= straightPunchThroughDamageMultSnap;
        if (ownerDefense != null && ownerDefense.IsWeavingActive())
        {
            damage *= ownerDefense.GetWeaveDamageMultiplier(currentPunchType);
        }
        if (!isChargePunch && ownerDefense != null)
        {
            damage *= ownerDefense.GetSeenPunchNonChargeDamageMultiplier();
        }
        if (levelController != null) damage *= levelController.DamageMult;
        LevelController targetLevelController = LevelController.GetFor(targetStats);
        if (levelController != null && targetLevelController != null)
            damage *= Mathf.Max(0f, levelController.GetDamageDiscrepancyMult(targetLevelController));
        if (isChargePunch)
        {
            float chargeMult = Mathf.Max(1f, chargePunchDamageMultiplier);
            if (levelController != null) chargeMult *= Mathf.Max(0f, levelController.ChargeDamageMult);
            damage *= chargeMult;
        }
        if (ownerStats != null)
        {
            float classMult = Mathf.Max(0f, ownerStats.GetDamageDealtMult());
            damage *= classMult;
        }
        bool isHeadHit = true;
        int hitLayer = other.gameObject.layer;
        if (hitLayer == torsoLayer || hitLayer == bodyLayer) isHeadHit = false;
        else if (hitLayer == headLayer) isHeadHit = true;
        DefenseController targetDefense = targetDefenseEarly;
        bool defAuto = false;
        bool defHigh = false;
        bool defLow = false;
        bool defDuck = false;
        bool defDuckUp = false;
        if (targetDefense != null)
        {
            defAuto = targetDefense.IsAutoGuardActive();
            defHigh = targetDefense.IsHighBlockActive();
            defLow = targetDefense.IsLowBlockActive();
            defDuck = targetDefense.IsDucking();
            defDuckUp = defDuck && defHigh;
        }
        float critChanceMult = 1f;
        if (!isHeadHit && defHigh) critChanceMult *= 2f;
        if (isHeadHit && defLow) critChanceMult *= 2f;
        if (!isHeadHit && defDuckUp) critChanceMult *= 2f;
        bool wasCrit = false;
        if (ownerCrit != null)
        {
            float beforeCrit = damage;
            ownerCrit.TryApplyCrit(targetStats, isHeadHit, ref damage, critChanceMult);
            if (damage > beforeCrit + 0.01f) wasCrit = true;
        }
        float blockedFraction = 0f;
        if (targetDefense != null && defAuto)
        {
            blockedFraction = targetDefense.fullGuardBlockFraction;
            if (defDuckUp)
            {
                if (isHeadHit) blockedFraction = Mathf.Max(blockedFraction, 0.95f);
                else blockedFraction = 0f;
            }
            else
            {
                if (isHeadHit && defHigh) blockedFraction = targetDefense.highBlockFraction;
                else if (!isHeadHit && defLow) blockedFraction = targetDefense.lowBlockFraction;
                if (!isHeadHit && defDuck) blockedFraction = Mathf.Max(blockedFraction, 0.90f);
            }
            blockedFraction = Mathf.Clamp01(blockedFraction);
            if (wasCrit)
            {
                bool ignoreBlock = (rng != null) ? rng.Chance(0.5f) : (UnityEngine.Random.value <= 0.5f);
                if (ignoreBlock) blockedFraction = 0f;
            }
            if (blockedFraction > 0f)
            {
                AiBrain brain = GetComponentInParent<AiBrain>();
                if (brain != null)
                {
                    if (isHeadHit) brain.NotifyAiPunchContactedHighGuard();
                    else brain.NotifyAiPunchContactedLowGuard();
                }
            }
            damage *= (1f - blockedFraction);
            if (!isHeadHit && defDuckUp && blockedFraction <= 0f) damage *= 1.20f;
        }
        bool bothClinched = ownerClinched && targetClinched;
        if (bothClinched)
        {
            bool straight2 = (currentPunchType == PunchType.Jab || currentPunchType == PunchType.Cross);
            if (straight2) damage *= clinchStraightDamageMult;
            else damage *= clinchPowerDamageMult;
        }
        if (damage > 0f)
        {
            bool cleanHit = blockedFraction < CLEAN_HIT_BLOCK_THRESHOLD;
            bool isBlockedHit = blockedFraction > 0f;
            FatigueController targetFatigue = FatigueController.GetFor(targetStats);
            if (targetFatigue != null)
            {
                if (cleanHit) targetFatigue.RegisterCleanHit();
                else targetFatigue.RegisterBlockedHit();
            }
            float taken = targetStats.ApplyDamageAndGetTaken(damage);
            if (taken > 0f && targetDefense != null && targetDefense.IsWeavingActive() && isHeadHit)
            {
                targetDefense.ApplyWeaveHeadHitPenalty();
            }
            TryTriggerTargetFlash(targetStats, wasCrit, taken);
            TryApplyPunchToFeintCounterPenalty(targetStats, taken);
            if (ownerCrit != null) ownerCrit.TryRollAndApplyStun(targetStats, isChargePunch);
            if (bothClinched)
            {
                targetStats.OnHitTakenDuringClinch();
                ClinchController targetClinch = targetStats.GetComponentInParent<ClinchController>();
                if (targetClinch != null)
                {
                    TryInvokeFloatMethod(targetClinch, "OnClinchPunchLanded", 1f);
                    TryInvokeNoArg(targetClinch, "NotifyClinchHit");
                }
                if (ownerClinch != null)
                {
                    TryInvokeFloatMethod(ownerClinch, "OnClinchPunchLanded", 1f);
                    TryInvokeNoArg(ownerClinch, "NotifyClinchHit");
                }
            }
            if (fightManager != null && taken > 0f)
            {
                bool attackerIsPlayer2 = (ownerController != null && ownerController.isPlayerControlled);
                fightManager.RegisterHit(attackerIsPlayer2, cleanHit, isBlockedHit, taken);
            }
            if (cleanHit)
            {
                RhythmController targetRhythm = targetStats.GetComponent<RhythmController>();
                if (targetRhythm == null) targetRhythm = targetStats.GetComponentInParent<RhythmController>();
                if (targetRhythm != null) targetRhythm.OnCleanHitTaken();
                HitstopController defenderHitstop = HitstopController.GetFor(targetStats);
                HitstopController sourceHitstop = ownerHitstop != null ? ownerHitstop : defenderHitstop;
                if (sourceHitstop != null)
                {
                    float baseDuration = sourceHitstop.GetBaseHitstopForPunch(currentPunchType);
                    float finalDuration = sourceHitstop.ApplyCritChargeModifiers(baseDuration, wasCrit, isChargePunch);
                    if (finalDuration > 0f)
                    {
                        if (ownerHitstop != null) ownerHitstop.TriggerHitstop(finalDuration, 0f, false);
                        if (defenderHitstop != null)
                        {
                            float extra = defenderHitstop.defenderExtraFreezeAfterHitstop;
                            defenderHitstop.TriggerHitstop(finalDuration, extra, true);
                        }
                    }
                }
            }
        }
        hasHitThisPunch = true;
    }
    void OnTriggerStay2D(Collider2D other)
    {
        if (!(isFeint || isPunchToFeintHold) || !isPunching) return;
        DefenseController targetDefense = other.GetComponentInParent<DefenseController>();
        if (targetDefense == null) return;
        if (targetDefense == ownerDefense) return;
        bool fullGuard = targetDefense.IsAutoGuardActive() && !targetDefense.IsLowBlockActive();
        bool upBlock = targetDefense.IsHighBlockActive();
        if (!(fullGuard || upBlock))
        {
            if (feintGuardOpponentDefense == targetDefense)
            {
                feintGuardContactTimer = 0f;
                if (feintGuardLockEngaged) ReleaseGuardLockFromOpponent();
            }
            feintTouchingBlockingGuard = false;
            ClearFeintRegenSlow();
            return;
        }
        if (feintGuardOpponentDefense != targetDefense)
        {
            feintGuardOpponentDefense = targetDefense;
            feintGuardContactTimer = 0f;
            feintGuardLockEngaged = false;
            feintGuardLockedOpponent = null;
        }
        feintGuardContactTimer += Time.deltaTime;
        feintTouchingBlockingGuard = true;
        if (ownerStats != null && regenSlowPerActivePunch > 0f && !feintRegenSlowed)
        {
            feintBaseRegenPerSecond = ownerStats.staminaRegenPerSecond;
            float mult = Mathf.Clamp01(1f - regenSlowPerActivePunch);
            ownerStats.staminaRegenPerSecond = feintBaseRegenPerSecond * mult;
            feintRegenSlowed = true;
        }
        if (!feintGuardLockEngaged && feintGuardContactTimer >= FEINT_GUARD_LOCK_DELAY)
        {
            FighterController oppController = targetDefense.GetComponentInParent<FighterController>();
            if (oppController != null)
            {
                ApplyGuardLockToOpponent(oppController);
                feintGuardLockedOpponent = oppController;
                feintGuardLockEngaged = true;
            }
        }
    }
    void OnTriggerExit2D(Collider2D other)
    {
        if (!(isFeint || isPunchToFeintHold) || !isPunching) return;
        DefenseController targetDefense = other.GetComponentInParent<DefenseController>();
        if (targetDefense == null) return;
        if (targetDefense == feintGuardOpponentDefense)
        {
            feintGuardContactTimer = 0f;
            if (feintGuardLockEngaged) ReleaseGuardLockFromOpponent();
            feintTouchingBlockingGuard = false;
            ClearFeintRegenSlow();
        }
    }
    void ClearFeintRegenSlow()
    {
        if (feintRegenSlowed && ownerStats != null)
            ownerStats.staminaRegenPerSecond = feintBaseRegenPerSecond;
        feintRegenSlowed = false;
    }
    void LogFeintForConditioning()
    {
        if (cachedAiDataBank == null || cachedAiTransform == null || ownerController == null) return;
        if (!ownerController.isPlayerControlled) return;
        float dx = cachedAiTransform.position.x - ownerController.transform.position.x;
        float distance = Mathf.Abs(dx);
        bool inRange = (distance >= feintInRangeMin && distance <= feintInRangeMax);
        AiActionDataBank.HitRegion region = (distance < feintBodyRangeThreshold) ? AiActionDataBank.HitRegion.Body : AiActionDataBank.HitRegion.Head;
        cachedAiDataBank.LogFeint(inRange, region);
    }
    public void SetGuardActive(bool active, float guardYOffset, float transitionTime)
    {
        Vector3 targetIdle = neutralLocalPosition + (active ? new Vector3(0f, guardYOffset, 0f) : Vector3.zero);
        SetIdlePosition(targetIdle, transitionTime);
    }
    public void SetHandsDownActive(bool active, float handsDownYOffset, float transitionTime)
    {
        Vector3 targetIdle = neutralLocalPosition + (active ? new Vector3(0f, handsDownYOffset, 0f) : Vector3.zero);
        SetIdlePosition(targetIdle, transitionTime);
    }
    public void SetDuckActive(bool active, float duckYOffset, float transitionTime)
    {
        Vector3 targetIdle = neutralLocalPosition + (active ? new Vector3(0f, duckYOffset, 0f) : Vector3.zero);
        SetIdlePosition(targetIdle, transitionTime);
    }
    void SetIdlePosition(Vector3 targetIdle, float transitionTime)
    {
        currentIdleLocalPosition = targetIdle;
        if (!isPunching)
        {
            if (idleMoveRoutine != null) StopCoroutine(idleMoveRoutine);
            idleMoveRoutine = StartCoroutine(MoveIdlePositionRoutine(targetIdle, transitionTime));
        }
    }
    IEnumerator MoveIdlePositionRoutine(Vector3 target, float duration)
    {
        Vector3 start = transform.localPosition;
        if (duration <= 0f)
        {
            transform.localPosition = target;
            yield break;
        }
        float t = 0f;
        while (t < 1f)
        {
            t += Time.deltaTime / duration;
            t = Mathf.Clamp01(t);
            transform.localPosition = Vector3.Lerp(start, target, t);
            yield return null;
        }
        transform.localPosition = target;
    }
    bool IsChargeReadyNow()
    {
        if (ownerCrit != null)
        {
            try { return ownerCrit.ChargeReady; }
            catch { }
            if (TryGetBoolMember(ownerCrit, "ChargeReady")) return true;
            if (TryGetBoolMember(ownerCrit, "chargeReady")) return true;
        }
        if (!allowLocalChargeFallback) return false;
        return Time.time >= localChargeReadyAtTime;
    }
    void PutChargeOnCooldownNow()
    {
        if (ownerCrit != null)
        {
            try
            {
                ownerCrit.PutChargeOnCooldown();
                SyncChargeTunablesToCritController();
                return;
            }
            catch
            {
                if (TryInvokeNoArg(ownerCrit, "PutChargeOnCooldown"))
                {
                    SyncChargeTunablesToCritController();
                    return;
                }
            }
        }
        if (!allowLocalChargeFallback) return;
        localChargeReadyAtTime = Time.time + Mathf.Max(0.01f, chargeCooldownSeconds);
    }
    void SyncChargeTunablesToCritController()
    {
        if (!overrideCritControllerChargeTunables) return;
        if (ownerCrit == null) return;
        TrySetFloatMember(ownerCrit, "chargeCooldownSeconds", chargeCooldownSeconds);
        TrySetFloatMember(ownerCrit, "ChargeCooldownSeconds", chargeCooldownSeconds);
        TrySetFloatMember(ownerCrit, "chargePunchDamageMultiplier", chargePunchDamageMultiplier);
        TrySetFloatMember(ownerCrit, "ChargePunchDamageMultiplier", chargePunchDamageMultiplier);
        TrySetFloatMember(ownerCrit, "chargePunchBaseAccuracy", chargePunchBaseAccuracy);
        TrySetFloatMember(ownerCrit, "ChargePunchBaseAccuracy", chargePunchBaseAccuracy);
        TrySetFloatMember(ownerCrit, "chargeStaminaCostMultiplier", chargeStaminaCostMultiplier);
        TrySetFloatMember(ownerCrit, "ChargeStaminaCostMultiplier", chargeStaminaCostMultiplier);
    }
    static bool TryInvokeNoArg(object obj, string methodName)
    {
        if (obj == null) return false;
        var t = obj.GetType();
        var m = t.GetMethod(methodName, BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);
        if (m == null) return false;
        if (m.GetParameters().Length != 0) return false;
        try { m.Invoke(obj, null); return true; } catch { return false; }
    }
    static bool TryInvokeFloatMethod(object obj, string methodName, float arg)
    {
        if (obj == null) return false;
        var t = obj.GetType();
        var m = t.GetMethod(methodName, BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);
        if (m == null) return false;
        var pars = m.GetParameters();
        if (pars == null || pars.Length != 1) return false;
        if (pars[0].ParameterType != typeof(float)) return false;
        try { m.Invoke(obj, new object[] { arg }); return true; } catch { return false; }
    }
    static bool TryGetBoolMember(object obj, string name)
    {
        if (obj == null) return false;
        var t = obj.GetType();
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
    static bool TrySetFloatMember(object obj, string name, float value)
    {
        if (obj == null) return false;
        var t = obj.GetType();
        var f = t.GetField(name, BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);
        if (f != null && f.FieldType == typeof(float))
        {
            try { f.SetValue(obj, value); return true; } catch { return false; }
        }
        var p = t.GetProperty(name, BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);
        if (p != null && p.PropertyType == typeof(float) && p.CanWrite)
        {
            try { p.SetValue(obj, value, null); return true; } catch { return false; }
        }
        return false;
    }
}
