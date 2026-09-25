using System;
using System.Collections;
using System.Reflection;
using UnityEngine;
public class DefenseController : MonoBehaviour
{
    [Header("Control Mode")]
    public bool isPlayerControlled = true;
    [Header("References")]
    public FistHitbox leftFist;
    public FistHitbox rightFist;
    public Transform head;
    [Header("Auto Guard Settings")]
    public float guardYOffset = 0.15f;
    public float guardTransitionTime = 0.12f;
    [Tooltip("Kept for inspector compatibility, but AutoGuard no longer activates by hold. It toggles on Space tap (press+release).")]
    public float holdToAutoGuardSeconds = 0.30f;
    [Header("High / Low Block Y Offsets")]
    public float highBlockGuardYOffset = 0.20f;
    public float lowBlockGuardYOffset = 0.10f;
    [Header("Duck / Head Dodge Settings")]
    public float duckDistance = 0.1f;
    public float duckTransitionTime = 0.08f;
    [Header("Duck Fist Offset")]
    public float fistDuckYOffset = -0.2f;
    [Header("Duck Stamina Penalty")]
    public float duckPenaltyDelay = 2f;
    public float duckMaxStaminaDrainPerSecond = 0.015f;
    [Header("Hands Down Mode")]
    public float handsDownDropAmount = 0.5f;
    public float handsDownHoldTime = 0.3f;
    [Header("Hands Down Buffs (while active)")]
    [Range(0f, 1f)] public float handsDownMoveSpeedBonus = 0.20f;
    [Range(0f, 1f)] public float handsDownPunchSpeedBonus = 0.20f;
    [Range(0f, 1f)] public float handsDownAccuracyBonus = 0.20f;
    [Range(0f, 1f)] public float handsDownRegenBonus = 0.20f;
    [Header("Hands Down Penalties ON HIT")]
    [Range(0f, 1f)] public float handsDownHitStaminaPercent = 0.05f;
    [Range(0f, 1f)] public float handsDownHitSlowMultiplier = 0.5f;
    public float handsDownHitSlowDuration = 0.75f;
    public float handsDownHitRegenPause = 1.0f;
    [Header("Block Damage Reduction")]
    [Range(0f, 1f)] public float fullGuardBlockFraction = 0.75f;
    [Range(0f, 1f)] public float highBlockFraction = 0.95f;
    [Range(0f, 1f)] public float lowBlockFraction = 0.95f;
    [Header("Over-Hold Guard Penalty")]
    public float overHoldDrainMaxStaminaPerSecond = 0.01f;
    [Header("Standing Directional Block Regen Penalty")]
    [Range(0f, 0.99f)] public float standingDirectionalBlockRegenSlowPercent = 0.90f;
    [Header("Up-Block Standing Duck Transition Slowdown")]
    [Range(0f, 1f)] public float upBlockStandingDuckSlowPercent = 0.15f;
    [Header("Weave (Shift + Space + Left/Right)")]
    public float weaveDistance = 0.12f;
    [Tooltip("Lower = snappier. Hands-down makes this 50% faster.")]
    public float weaveTransitionTime = 0.06f;
    [Range(0.01f, 1f)] public float weaveMoveSpeedMultiplier = 0.5f;
    [Range(0.01f, 2f)] public float weaveStraightUpperDamageMult = 0.75f;
    [Range(0.01f, 2f)] public float weaveUppercutDamageMult = 0.85f;
    [Range(0.01f, 5f)] public float weaveHookDamageMult = 2.0f;
    [Range(0.01f, 1f)] public float weaveHeadHitMoveSpeedMultiplier = 0.1f;
    public float weaveHeadHitSlowDuration = 0.5f;
    public float weaveHeadHitRegenPause = 0.5f;
    [Header("Weave Hands Follow")]
    [Tooltip("Hands follow the weave laterally. 1.0 = same as head, 0.6 = subtler.")]
    [Range(0f, 1.25f)] public float weaveFistXMultiplier = 0.75f;
    [Header("Weave-Duck (Down while weaving)")]
    [Tooltip("Head drops this amount (blocks) while weave-ducking.")]
    public float weaveDuckHeadDrop = 0.4f;
    [Header("Weave Whiff Chance (attacker misses more if defender weaves inside extend window)")]
    public bool enableWeaveWhiffChance = true;
    public float weaveWhiffExtraWindowSeconds = 0.1f;
    [Tooltip("Legacy (unused now). Kept for inspector compatibility.")]
    public float weaveWhiffMultiplierLevel1 = 1.5f;
    [Tooltip("Legacy (unused now). Kept for inspector compatibility.")]
    public float weaveWhiffMultiplierPerLevel = 0.005f;
    [Tooltip("Legacy (unused now). Kept for inspector compatibility.")]
    public float weaveWhiffMultiplierMax = 999f;
    [Range(0f, 1f)] public float weaveWhiffAdjustedMissCap = 1f;
    [Range(0f, 1f)] public float weaveWhiffBaseChanceSameLevel = 0.50f;
    [Tooltip("Signed chance per level gap (defenderLevel - attackerLevel). 0.0025 = 0.25% per level.")]
    public float weaveWhiffChancePerLevelDiscrepancy = 0.0025f;
    [Tooltip("Additional chance per defender level above 1. 0.00125 = 0.125% per level.")]
    public float weaveWhiffChancePerDefenderLevel = 0.00125f;
    [Header("Weave Stamina Reward")]
    [Tooltip("If you succeed this many weaves in a row and stamina% <= cap, gain stamina% (cooldown applies).")]
    public int weaveStaminaRewardStreakNeeded = 3;
    [Range(0f, 1f)] public float weaveStaminaRewardMaxStaminaPercentCap = 0.95f;
    [Range(0f, 1f)] public float weaveStaminaRewardGainPercent = 0.05f;
    public float weaveStaminaRewardCooldownSeconds = 10f;
    [Header("Weave Hold Penalty")]
    [Tooltip("After holding active weave this long (Shift+Space+Dir), penalties start.")]
    public float weaveHoldPenaltyStartSeconds = 3f;
    [Tooltip("Drain percent of max stamina per second after threshold. 0.01 = 1%/sec.")]
    [Range(0f, 1f)] public float weaveHoldPenaltyDrainPercentPerSecond = 0.01f;
    [Tooltip("Reduce hitbox disable chance by this amount per second after threshold. 0.05 = -5%/sec.")]
    [Range(0f, 1f)] public float weaveHoldPenaltyHitboxChanceDownPerSecond = 0.05f;
    [Header("Seen-Punch Debuff (whiff vs weaving defender)")]
    [Range(0.01f, 1f)] public float seenPunchNonChargeDamageMultiplier = 0.20f;
    [Header("Weave Readout (runtime)")]
    [SerializeField] private string weaveReadout = "Fail Weave";
    [SerializeField] private float weaveRegenBoostTimer = 0f;
    [SerializeField] private bool weaveRegenBoostActive = false;
    private float weaveRegenBoostOriginalRegen = 0f;
    public string WeaveReadout => weaveReadout;
    [Header("Stun Lockouts (runtime)")]
    [SerializeField] private bool blockOrDuckDisabled = false;
    private float blockOrDuckDisabledTimer = 0f;
    public bool BlockOrDuckDisabled => blockOrDuckDisabled;
    [Header("Clinch Overrides (runtime)")]
    [SerializeField] private bool clinchActive = false;
    [SerializeField] private bool duckDisabledByClinch = false;
    [SerializeField] private float clinchBlockEffectivenessMult = 1f;
    private float clinchHeadDownLocal = 0f;
    private float clinchForwardLocal = 0f;
    private Vector3 headNeutralLocalPos;
    private Vector3 leftFistNeutralLocalPos;
    private Vector3 rightFistNeutralLocalPos;
    public bool IsClinchActive() => clinchActive;
    public float GetClinchBlockEffectivenessMult() => Mathf.Max(0.01f, clinchBlockEffectivenessMult);
    private bool autoGuardActive = false;
    private float autoGuardTimer = 0f;
    private bool highBlockActive = false;
    private bool lowBlockActive = false;
    private bool isDucking = false;
    private bool isWeaveDucking = false;
    private bool weaveDuckForceNeutralX = false;
    private Coroutine headMoveRoutine;
    private float duckTimer = 0f;
    private bool isPunchingForHitblock = false;
    private bool handsDownActive = false;
    private float handsDownHoldTimer = 0f;
    private FighterStats ownerStats;
    private LevelController levelController;
    private bool spacePressed = false;
    private bool spacePressBeganWeave = false;
    private FighterController ownerController;
    private bool isWeaving = false;
    private int weaveDir = 0;
    private Vector3 weaveBaseHeadLocalPos;
    private Coroutine weaveRoutine;
    private bool weaveFrozen = false;
    private float weaveHeadHitSlowTimer = 0f;
    private bool weaveTempUpGuardHeld = false;
    private float seenPunchDebuffTimer = 0f;
    private bool duckForcedFromLowBlock = false;
    private float oppPunchExtendStartTime = -999f;
    private float oppPunchExtendWindowEndTime = -999f;
    private float weaveStartTime = -999f;
    private Collider2D[] headHitColliders;
    private bool weaveHitboxDisabled = false;
    private float weaveHitboxTickAccum = 0f;
    private const float weaveHitboxTick = 0.01f;
    private const float weaveHitboxBaseChance = 0.50f;
    private const float weaveHitboxChancePerLevelAbove = 0.0045f;
    private const float weaveHitboxChancePerLevelBelow = 0.0020f;
    private int weaveHitboxRollSalt = 0;
    [SerializeField] private string weaveHitboxChanceReadout = "WeaveHitbox: 0%";
    public string WeaveHitboxChanceReadout => weaveHitboxChanceReadout;
    private int weaveSuccessStreak = 0;
    private float weaveStaminaRewardCooldownTimer = 0f;
    private float weaveHoldActiveTimer = 0f;
    private float weaveHoldHitboxChanceMult = 1f;
    public float GetWeaveWhiffChanceProbability(float attackerAccuracy01, int defenderLevel)
    {
        if (!enableWeaveWhiffChance) return 0f;
        float acc = Mathf.Clamp01(attackerAccuracy01);
        float miss = 1f - acc;
        int defLvl = Mathf.Max(1, defenderLevel);
        int atkLvl = 1;
        Transform opp = (ownerController != null) ? ownerController.opponent : null;
        if (opp != null)
        {
            LevelController oppLC = LevelController.GetFor(opp);
            if (oppLC != null) atkLvl = Mathf.Clamp(oppLC.level, 1, 100);
        }
        int gap = defLvl - atkLvl;
        float pLevel = Mathf.Clamp01(weaveWhiffBaseChanceSameLevel + weaveWhiffChancePerLevelDiscrepancy * gap + weaveWhiffChancePerDefenderLevel * (defLvl - 1));
        float targetMiss = Mathf.Clamp01(Mathf.Max(miss, pLevel));
        targetMiss = Mathf.Min(targetMiss, Mathf.Clamp01(weaveWhiffAdjustedMissCap));
        float adjAcc = 1f - targetMiss;
        float p = (acc > 0.0001f) ? Mathf.Clamp01(1f - (adjAcc / acc)) : 1f;
        return p;
    }
    public void NotifyOpponentPunchExtensionStart(float extendDurationSeconds)
    {
        oppPunchExtendStartTime = Time.time;
        oppPunchExtendWindowEndTime = oppPunchExtendStartTime + Mathf.Max(0f, extendDurationSeconds) + Mathf.Max(0f, weaveWhiffExtraWindowSeconds);
    }
    public bool IsWeaveWhiffEligibleNow()
    {
        if (!enableWeaveWhiffChance) return false;
        if (!isWeaving) return false;
        if (weaveStartTime <= -998f) return false;
        if (oppPunchExtendWindowEndTime <= -998f) return false;
        return weaveStartTime >= oppPunchExtendStartTime && weaveStartTime <= oppPunchExtendWindowEndTime;
    }
    void Awake()
    {
        if (leftFist == null || rightFist == null)
        {
            FistHitbox[] fists = GetComponentsInChildren<FistHitbox>();
            if (fists.Length > 0 && leftFist == null) leftFist = fists[0];
            if (fists.Length > 1 && rightFist == null) rightFist = fists[1];
        }
        if (head == null)
        {
            Transform[] children = GetComponentsInChildren<Transform>(true);
            foreach (var t in children)
            {
                if (t.name.ToLower().Contains("head"))
                {
                    head = t;
                    break;
                }
            }
        }
        if (head != null) headNeutralLocalPos = head.localPosition;
        else Debug.LogWarning("DefenseController: Head reference not set; Ducking/Weaving head motion will do nothing.");
        if (leftFist != null) leftFistNeutralLocalPos = leftFist.transform.localPosition;
        if (rightFist != null) rightFistNeutralLocalPos = rightFist.transform.localPosition;
        ownerStats = GetComponent<FighterStats>();
        levelController = LevelController.GetFor(this);
        ownerController = GetComponent<FighterController>();
        if (head != null) headHitColliders = head.GetComponentsInChildren<Collider2D>(true);
        ApplyCurrentGuardOffsets();
        ApplyClinchForwardOffsetIfNeeded();
    }
    void Update()
    {
        TickBlockDisableTimer();
        TickWeaveRegenBoost();
        TickWeaveStaminaRewardCooldown();
        TickWeaveHoldPenalty();
        TickWeaveHitboxDisable();
        if (weaveHeadHitSlowTimer > 0f)
        {
            weaveHeadHitSlowTimer -= Time.deltaTime;
            if (weaveHeadHitSlowTimer < 0f) weaveHeadHitSlowTimer = 0f;
        }
        if (seenPunchDebuffTimer > 0f)
        {
            seenPunchDebuffTimer -= Time.deltaTime;
            if (seenPunchDebuffTimer < 0f) seenPunchDebuffTimer = 0f;
        }
        if (isPlayerControlled)
        {
            HandleHandsDownInput();
            HandleSpaceInput_TapOnly();
            HandleHighLowBlockInput_HoldBased();
            HandleWeaveInput_New();
            HandleWeaveTempUpGuardPose();
            HandleDuckInput();
            HandleWeaveDuckNeutralXRule();
        }
        UpdateAutoGuardTimerAndOverHoldPenalty();
        UpdateDuckEffects();
        MaintainGuardVisualWhileNotDucking();
    }
    void LateUpdate()
    {
        EnforceWeaveFistXOffsets();
    }
    void TickWeaveStaminaRewardCooldown()
    {
        if (weaveStaminaRewardCooldownTimer > 0f)
        {
            weaveStaminaRewardCooldownTimer -= Time.deltaTime;
            if (weaveStaminaRewardCooldownTimer < 0f) weaveStaminaRewardCooldownTimer = 0f;
        }
    }
    void TickWeaveHoldPenalty()
    {
        weaveHoldHitboxChanceMult = 1f;
        if (!isPlayerControlled) { weaveHoldActiveTimer = 0f; return; }
        if (!isWeaving || blockOrDuckDisabled || clinchActive) { weaveHoldActiveTimer = 0f; return; }
        bool spaceHeld = Input.GetKey(KeyCode.Space);
        bool shiftHeld = Input.GetKey(KeyCode.LeftShift) || Input.GetKey(KeyCode.RightShift);
        int dirHeld = GetWeaveDesiredDirFromInput();
        bool holdActive = spaceHeld && shiftHeld && dirHeld != 0 && !weaveFrozen && !isWeaveDucking;
        if (!holdActive) { weaveHoldActiveTimer = 0f; return; }
        weaveHoldActiveTimer += Time.deltaTime;
        float start = Mathf.Max(0f, weaveHoldPenaltyStartSeconds);
        if (weaveHoldActiveTimer <= start) return;
        float over = weaveHoldActiveTimer - start;
        float hitboxDownPerSec = Mathf.Max(0f, weaveHoldPenaltyHitboxChanceDownPerSecond);
        weaveHoldHitboxChanceMult = Mathf.Clamp01(1f - hitboxDownPerSec * over);
        if (ownerStats == null || ownerStats.maxStamina <= 0.0001f) return;
        float drainPctPerSec = Mathf.Max(0f, weaveHoldPenaltyDrainPercentPerSecond);
        if (drainPctPerSec <= 0f) return;
        float amount = ownerStats.maxStamina * drainPctPerSec * Time.deltaTime;
        ownerStats.currentStamina = Mathf.Max(0f, ownerStats.currentStamina - amount);
    }
    void TickWeaveHitboxDisable()
    {
        if (headHitColliders == null || headHitColliders.Length == 0) return;
        bool canWeaveIntangible = isWeaving && !blockOrDuckDisabled && !clinchActive;
        if (!canWeaveIntangible)
        {
            if (weaveHitboxDisabled) SetHeadHitboxesEnabled(true);
            weaveHitboxTickAccum = 0f;
            weaveHitboxChanceReadout = "WeaveHitbox: 0%";
            return;
        }
        weaveHitboxTickAccum += Time.deltaTime;
        while (weaveHitboxTickAccum >= weaveHitboxTick)
        {
            weaveHitboxTickAccum -= weaveHitboxTick;
            int myLvl = (levelController != null) ? Mathf.Clamp(levelController.level, 1, 100) : 1;
            int oppLvl = 1;
            LevelController oppLC = null;
            Transform opp = (ownerController != null) ? ownerController.opponent : null;
            if (opp != null) oppLC = LevelController.GetFor(opp);
            if (oppLC != null) oppLvl = Mathf.Clamp(oppLC.level, 1, 100);
            int gap = myLvl - oppLvl;
            float lvlAdj = (gap >= 0) ? (weaveHitboxChancePerLevelAbove * gap) : (-weaveHitboxChancePerLevelBelow * (-gap));
            float stam01 = 0f;
            if (ownerStats != null && ownerStats.maxStamina > 0.0001f) stam01 = Mathf.Clamp01(ownerStats.currentStamina / ownerStats.maxStamina);
            float stamAdj = 0f;
            if (stam01 > 0.95f) stamAdj += 0.10f;
            if (stam01 <= 0.20f) stamAdj += 0.10f;
            if (stam01 < 0.10f) stamAdj += 0.10f;
            float p = Mathf.Clamp01((weaveHitboxBaseChance + lvlAdj + stamAdj) * weaveHoldHitboxChanceMult);
            float delta = p - weaveHitboxBaseChance;
            weaveHitboxChanceReadout = "WeaveHitbox: " + (p * 100f).ToString("0.0") + "% Δ" + (delta * 100f).ToString("+0.0;-0.0;0.0") + "% L" + (lvlAdj * 100f).ToString("+0.0;-0.0;0.0") + "% S" + (stamAdj * 100f).ToString("+0.0;-0.0;0.0") + "%";
            bool disableNow = TimeBasedRoll01(p, weaveHitboxRollSalt++);
            if (disableNow)
            {
                SetHeadHitboxesEnabled(false);
                NotifyWeaveResult(true);
            }
            else SetHeadHitboxesEnabled(true);
        }
    }
    void SetHeadHitboxesEnabled(bool enabled)
    {
        if (headHitColliders == null) return;
        if (enabled && !weaveHitboxDisabled) return;
        if (!enabled && weaveHitboxDisabled) return;
        weaveHitboxDisabled = !enabled;
        for (int i = 0; i < headHitColliders.Length; i++)
        {
            var c = headHitColliders[i];
            if (c == null) continue;
            c.enabled = enabled;
        }
    }
    bool TimeBasedRoll01(float chance01, int salt)
    {
        float p = Mathf.Clamp01(chance01);
        if (p <= 0f) return false;
        if (p >= 1f) return true;
        float r = TryTimeBasedRngValue01(salt);
        return r <= p;
    }
    float TryTimeBasedRngValue01(int salt)
    {
        try
        {
            Type t = Type.GetType("TimeBasedRNG");
            if (t == null)
            {
                foreach (var a in AppDomain.CurrentDomain.GetAssemblies())
                {
                    t = a.GetType("TimeBasedRNG");
                    if (t != null) break;
                }
            }
            if (t != null)
            {
                MethodInfo m = t.GetMethod("Next01", BindingFlags.Public | BindingFlags.Static);
                if (m != null)
                {
                    object v = m.Invoke(null, new object[] { salt });
                    if (v is float f) return Mathf.Clamp01(f);
                }
                m = t.GetMethod("Value01", BindingFlags.Public | BindingFlags.Static);
                if (m != null)
                {
                    object v = m.Invoke(null, new object[] { salt });
                    if (v is float f) return Mathf.Clamp01(f);
                }
                m = t.GetMethod("Range01", BindingFlags.Public | BindingFlags.Static);
                if (m != null)
                {
                    object v = m.Invoke(null, new object[] { salt });
                    if (v is float f) return Mathf.Clamp01(f);
                }
                m = t.GetMethod("Float01", BindingFlags.Public | BindingFlags.Static);
                if (m != null)
                {
                    object v = m.Invoke(null, new object[] { salt });
                    if (v is float f) return Mathf.Clamp01(f);
                }
                m = t.GetMethod("Random01", BindingFlags.Public | BindingFlags.Static);
                if (m != null)
                {
                    object v = m.Invoke(null, new object[] { salt });
                    if (v is float f) return Mathf.Clamp01(f);
                }
                m = t.GetMethod("Get01", BindingFlags.Public | BindingFlags.Static);
                if (m != null)
                {
                    object v = m.Invoke(null, new object[] { salt });
                    if (v is float f) return Mathf.Clamp01(f);
                }
            }
        }
        catch { }
        return UnityEngine.Random.value;
    }
    void TickWeaveRegenBoost()
    {
        if (!weaveRegenBoostActive) return;
        weaveRegenBoostTimer -= Time.deltaTime;
        if (weaveRegenBoostTimer <= 0f)
        {
            weaveRegenBoostTimer = 0f;
            EndWeaveRegenBoost();
        }
    }
    void StartWeaveRegenBoost()
    {
        if (ownerStats == null) return;
        if (!weaveRegenBoostActive)
        {
            weaveRegenBoostOriginalRegen = ownerStats.staminaRegenPerSecond;
            ownerStats.staminaRegenPerSecond = weaveRegenBoostOriginalRegen * 2f;
            weaveRegenBoostActive = true;
        }
        weaveRegenBoostTimer = Mathf.Max(weaveRegenBoostTimer, 1f);
    }
    void EndWeaveRegenBoost()
    {
        if (!weaveRegenBoostActive) return;
        weaveRegenBoostActive = false;
        if (ownerStats != null) ownerStats.staminaRegenPerSecond = weaveRegenBoostOriginalRegen;
    }
    void CancelWeaveRegenBoost()
    {
        weaveRegenBoostTimer = 0f;
        EndWeaveRegenBoost();
    }
    void TryApplyWeaveStaminaReward()
    {
        int need = Mathf.Max(1, weaveStaminaRewardStreakNeeded);
        if (weaveSuccessStreak < need) return;
        if (weaveStaminaRewardCooldownTimer > 0f) { weaveSuccessStreak = 0; return; }
        if (ownerStats == null || ownerStats.maxStamina <= 0.0001f) { weaveSuccessStreak = 0; return; }
        float cap = Mathf.Clamp01(weaveStaminaRewardMaxStaminaPercentCap);
        float stam01 = Mathf.Clamp01(ownerStats.currentStamina / ownerStats.maxStamina);
        if (stam01 > cap) { weaveSuccessStreak = 0; return; }
        float gain = Mathf.Clamp01(weaveStaminaRewardGainPercent);
        if (gain > 0f)
        {
            ownerStats.currentStamina = Mathf.Min(ownerStats.maxStamina, ownerStats.currentStamina + ownerStats.maxStamina * gain);
            weaveStaminaRewardCooldownTimer = Mathf.Max(0f, weaveStaminaRewardCooldownSeconds);
        }
        weaveSuccessStreak = 0;
    }
    public void NotifyWeaveResult(bool success)
    {
        weaveReadout = success ? "Weaved" : "Fail Weave";
        if (success)
        {
            weaveSuccessStreak++;
            StartWeaveRegenBoost();
            TryApplyWeaveStaminaReward();
        }
        else
        {
            weaveSuccessStreak = 0;
            CancelWeaveRegenBoost();
        }
    }
    float GetFacingSign()
    {
        float s = transform.localScale.x;
        if (Mathf.Approximately(s, 0f)) return 1f;
        return Mathf.Sign(s);
    }
    float GetLeftFistBaselineLocalX()
    {
        float baseX = leftFistNeutralLocalPos.x + (clinchActive ? clinchForwardLocal : 0f);
        return baseX;
    }
    float GetRightFistBaselineLocalX()
    {
        float baseX = rightFistNeutralLocalPos.x + (clinchActive ? clinchForwardLocal : 0f);
        return baseX;
    }
    public float GetDirectionalBlockStandingRegenMultiplier()
    {
        if (!autoGuardActive) return 1f;
        if (isDucking) return 1f;
        if (!(highBlockActive || lowBlockActive)) return 1f;
        float slow = Mathf.Clamp01(standingDirectionalBlockRegenSlowPercent);
        return Mathf.Clamp01(1f - slow);
    }
    public bool IsWeavingActive() => isWeaving;
    public bool IsWeaveDuckActive() => isWeaveDucking;
    public bool IsWeaveMovementLocked()
    {
        return isWeaving && weaveFrozen;
    }
    public float GetWeaveMoveSpeedMultiplier()
    {
        if (blockOrDuckDisabled) return 1f;
        if (weaveHeadHitSlowTimer > 0f) return Mathf.Clamp(weaveHeadHitMoveSpeedMultiplier, 0.01f, 1f);
        if (!isWeaving) return 1f;
        return Mathf.Clamp(weaveMoveSpeedMultiplier, 0.01f, 1f);
    }
    public float GetWeaveDamageMultiplier(FistHitbox.PunchType type)
    {
        if (!isWeaving) return 1f;
        bool isHook = (type == FistHitbox.PunchType.LeftHook || type == FistHitbox.PunchType.RightHook);
        if (isHook) return Mathf.Max(0.01f, weaveHookDamageMult);
        bool isUpper = (type == FistHitbox.PunchType.LeftUppercut || type == FistHitbox.PunchType.RightUppercut);
        if (isUpper) return Mathf.Max(0.01f, weaveUppercutDamageMult);
        return Mathf.Max(0.01f, weaveStraightUpperDamageMult);
    }
    public void ApplyWeaveHeadHitPenalty()
    {
        NotifyWeaveResult(false);
        weaveHeadHitSlowTimer = Mathf.Max(weaveHeadHitSlowTimer, Mathf.Max(0f, weaveHeadHitSlowDuration));
        if (ownerStats != null) ownerStats.PauseRegen(Mathf.Max(0f, weaveHeadHitRegenPause));
    }
    public void ApplySeenPunchDebuff(float seconds)
    {
        if (seconds <= 0f) return;
        seenPunchDebuffTimer = Mathf.Max(seenPunchDebuffTimer, seconds);
    }
    public float GetSeenPunchNonChargeDamageMultiplier()
    {
        if (seenPunchDebuffTimer <= 0f) return 1f;
        return Mathf.Clamp(seenPunchNonChargeDamageMultiplier, 0.01f, 1f);
    }
    public void SetClinchState(bool active, float headDownWorld, float forwardWorld, float transitionTime, float blockEffectivenessMult)
    {
        clinchActive = active;
        duckDisabledByClinch = active;
        clinchBlockEffectivenessMult = active ? Mathf.Max(0.01f, blockEffectivenessMult) : 1f;
        clinchHeadDownLocal = active ? Mathf.Abs(headDownWorld) : 0f;
        clinchForwardLocal = active ? forwardWorld : 0f;
        if (active && isDucking) EndDuck();
        if (active && handsDownActive) DeactivateHandsDown();
        if (active && isWeaving) StopWeaveImmediate(true);
        if (!active && autoGuardActive) DeactivateAutoGuard();
        if (head != null)
        {
            Vector3 target = GetHeadBaseLocalPos(false, 0f);
            if (headMoveRoutine != null) StopCoroutine(headMoveRoutine);
            headMoveRoutine = StartCoroutine(MoveHeadRoutine(target, Mathf.Max(0f, transitionTime)));
        }
        ApplyCurrentGuardOffsets();
        ApplyClinchForwardOffsetIfNeeded();
    }
    void ApplyClinchForwardOffsetIfNeeded()
    {
        if (!clinchActive)
        {
            if (leftFist != null)
            {
                Vector3 p = leftFist.transform.localPosition;
                p.x = leftFistNeutralLocalPos.x;
                leftFist.transform.localPosition = p;
            }
            if (rightFist != null)
            {
                Vector3 p = rightFist.transform.localPosition;
                p.x = rightFistNeutralLocalPos.x;
                rightFist.transform.localPosition = p;
            }
            return;
        }
        if (leftFist != null)
        {
            Vector3 p = leftFist.transform.localPosition;
            p.x = leftFistNeutralLocalPos.x + clinchForwardLocal;
            leftFist.transform.localPosition = p;
        }
        if (rightFist != null)
        {
            Vector3 p = rightFist.transform.localPosition;
            p.x = rightFistNeutralLocalPos.x + clinchForwardLocal;
            rightFist.transform.localPosition = p;
        }
    }
    void MaintainGuardVisualWhileNotDucking()
    {
        if (blockOrDuckDisabled) return;
        if (isDucking) return;
        if (isWeaving) return;
        if (autoGuardActive)
        {
            ApplyCurrentGuardOffsets();
            ApplyClinchForwardOffsetIfNeeded();
            return;
        }
        ApplyClinchForwardOffsetIfNeeded();
    }
    public void DisableBlockAndDuckForSeconds(float seconds)
    {
        if (seconds <= 0f) return;
        blockOrDuckDisabled = true;
        blockOrDuckDisabledTimer = Mathf.Max(blockOrDuckDisabledTimer, seconds);
        if (autoGuardActive) DeactivateAutoGuard();
        if (isDucking) EndDuck();
        if (handsDownActive) DeactivateHandsDown();
        if (isWeaving) StopWeaveImmediate(true);
        if (weaveHitboxDisabled) SetHeadHitboxesEnabled(true);
        ForceFullFistReset();
    }
    void TickBlockDisableTimer()
    {
        if (!blockOrDuckDisabled) return;
        blockOrDuckDisabledTimer -= Time.deltaTime;
        if (blockOrDuckDisabledTimer <= 0f)
        {
            blockOrDuckDisabledTimer = 0f;
            blockOrDuckDisabled = false;
            ApplyCurrentGuardOffsets();
            ApplyClinchForwardOffsetIfNeeded();
        }
        else
        {
            if (autoGuardActive) DeactivateAutoGuard();
            if (isDucking) EndDuck();
            if (isWeaving) StopWeaveImmediate(true);
            if (weaveHitboxDisabled) SetHeadHitboxesEnabled(true);
            ForceFullFistReset();
        }
    }
    void HandleHandsDownInput()
    {
        if (blockOrDuckDisabled) return;
        if (clinchActive) return;
        bool shiftHeld = Input.GetKey(KeyCode.LeftShift) || Input.GetKey(KeyCode.RightShift);
        bool aHeld = Input.GetKey(KeyCode.A);
        if (!handsDownActive)
        {
            if (shiftHeld && aHeld)
            {
                handsDownHoldTimer += Time.deltaTime;
                if (handsDownHoldTimer >= handsDownHoldTime)
                {
                    ActivateHandsDown();
                    handsDownHoldTimer = 0f;
                }
            }
            else handsDownHoldTimer = 0f;
        }
        else handsDownHoldTimer = 0f;
    }
    void ActivateHandsDown()
    {
        if (blockOrDuckDisabled) return;
        if (clinchActive) return;
        handsDownActive = true;
        if (autoGuardActive)
        {
            autoGuardActive = false;
            autoGuardTimer = 0f;
            highBlockActive = false;
            lowBlockActive = false;
        }
        if (leftFist != null) leftFist.SetHandsDownActive(true, -Mathf.Abs(handsDownDropAmount), guardTransitionTime);
        if (rightFist != null) rightFist.SetHandsDownActive(true, -Mathf.Abs(handsDownDropAmount), guardTransitionTime);
        ApplyClinchForwardOffsetIfNeeded();
    }
    void DeactivateHandsDown()
    {
        if (!handsDownActive) return;
        handsDownActive = false;
        if (leftFist != null) leftFist.SetHandsDownActive(false, 0f, guardTransitionTime);
        if (rightFist != null) rightFist.SetHandsDownActive(false, 0f, guardTransitionTime);
        if (autoGuardActive && !isDucking && !blockOrDuckDisabled) ApplyCurrentGuardOffsets();
        ApplyClinchForwardOffsetIfNeeded();
    }
    void HandleSpaceInput_TapOnly()
    {
        if (blockOrDuckDisabled) return;
        if (clinchActive) return;
        if (Input.GetKeyDown(KeyCode.Space))
        {
            if (handsDownActive) DeactivateHandsDown();
            spacePressed = true;
            spacePressBeganWeave = false;
        }
        if (Input.GetKeyUp(KeyCode.Space))
        {
            if (!spacePressBeganWeave) ToggleAutoGuard_Tap();
            spacePressed = false;
            spacePressBeganWeave = false;
            if (isWeaving)
            {
                if (isWeaveDucking)
                {
                    isWeaveDucking = false;
                    ApplyClinchForwardOffsetIfNeeded();
                }
                else StopWeaveImmediate(false);
            }
        }
    }
    void ToggleAutoGuard_Tap()
    {
        if (blockOrDuckDisabled) return;
        if (clinchActive) return;
        if (!autoGuardActive) ActivateAutoGuard_ResetTimer();
        else DeactivateAutoGuard();
    }
    float GetMaxAutoGuardDurationSeconds()
    {
        if (levelController != null) return Mathf.Max(0f, levelController.AutoGuardMaxDurationSeconds);
        return 10f;
    }
    void ActivateAutoGuard_ResetTimer()
    {
        if (blockOrDuckDisabled) return;
        if (clinchActive) return;
        if (handsDownActive) DeactivateHandsDown();
        autoGuardActive = true;
        autoGuardTimer = GetMaxAutoGuardDurationSeconds();
        highBlockActive = false;
        lowBlockActive = false;
        ApplyCurrentGuardOffsets();
        ApplyClinchForwardOffsetIfNeeded();
    }
    void DeactivateAutoGuard()
    {
        autoGuardActive = false;
        autoGuardTimer = 0f;
        highBlockActive = false;
        lowBlockActive = false;
        ApplyCurrentGuardOffsets();
        ApplyClinchForwardOffsetIfNeeded();
    }
    void UpdateAutoGuardTimerAndOverHoldPenalty()
    {
        if (!autoGuardActive) return;
        if (blockOrDuckDisabled || clinchActive)
        {
            DeactivateAutoGuard();
            return;
        }
        autoGuardTimer -= Time.deltaTime;
        if (autoGuardTimer <= 0f) ApplyOverHoldPenalty();
    }
    void ApplyOverHoldPenalty()
    {
        if (ownerStats == null) return;
        float drainRate = Mathf.Max(0f, overHoldDrainMaxStaminaPerSecond);
        if (drainRate <= 0f) return;
        float amount = ownerStats.maxStamina * drainRate * Time.deltaTime;
        ownerStats.currentStamina = Mathf.Max(0f, ownerStats.currentStamina - amount);
    }
    void ApplyCurrentGuardOffsets()
    {
        float offset = 0f;
        if (autoGuardActive)
        {
            offset = guardYOffset;
            if (highBlockActive) offset = highBlockGuardYOffset;
            else if (lowBlockActive) offset = lowBlockGuardYOffset;
        }
        if (isDucking) return;
        if (leftFist != null) leftFist.SetGuardActive(autoGuardActive, offset, guardTransitionTime);
        if (rightFist != null) rightFist.SetGuardActive(autoGuardActive, offset, guardTransitionTime);
    }
    void HandleHighLowBlockInput_HoldBased()
    {
        if (blockOrDuckDisabled) return;
        if (clinchActive) return;
        if (!autoGuardActive)
        {
            if (highBlockActive || lowBlockActive)
            {
                highBlockActive = false;
                lowBlockActive = false;
                ApplyCurrentGuardOffsets();
                ApplyClinchForwardOffsetIfNeeded();
            }
            return;
        }
        bool upHeld = Input.GetKey(KeyCode.UpArrow);
        bool downHeld = Input.GetKey(KeyCode.DownArrow);
        if (isDucking)
        {
            highBlockActive = upHeld;
            lowBlockActive = false;
            return;
        }
        bool newHigh = upHeld;
        bool newLow = (!upHeld && downHeld);
        if (newHigh != highBlockActive || newLow != lowBlockActive)
        {
            highBlockActive = newHigh;
            lowBlockActive = newLow;
            ApplyCurrentGuardOffsets();
            ApplyClinchForwardOffsetIfNeeded();
        }
    }
    void HandleWeaveInput_New()
    {
        if (blockOrDuckDisabled) return;
        if (clinchActive) return;
        if (head == null) return;
        bool spaceHeld = Input.GetKey(KeyCode.Space);
        bool shiftHeld = Input.GetKey(KeyCode.LeftShift) || Input.GetKey(KeyCode.RightShift);
        if (!spaceHeld)
        {
            if (isWeaving) StopWeaveImmediate(false);
            return;
        }
        if (isWeaveDucking) return;
        if (isWeaving)
        {
            weaveFrozen = !shiftHeld;
            int desiredDirWhileWeaving = GetWeaveDesiredDirFromInput();
            spacePressBeganWeave = true;
            StartOrUpdateWeave(desiredDirWhileWeaving);
            return;
        }
        if (!shiftHeld) return;
        int desiredDir = GetWeaveDesiredDirFromInput();
        if (desiredDir == 0) return;
        spacePressBeganWeave = true;
        weaveFrozen = false;
        StartOrUpdateWeave(desiredDir);
    }
    int GetWeaveDesiredDirFromInput()
    {
        bool leftHeld = Input.GetKey(KeyCode.LeftArrow);
        bool rightHeld = Input.GetKey(KeyCode.RightArrow);
        Transform opp = (ownerController != null) ? ownerController.opponent : null;
        if (opp == null)
        {
            if (leftHeld) return -1;
            if (rightHeld) return 1;
            return 0;
        }
        float dx = opp.position.x - transform.position.x;
        if (dx > 0f)
        {
            if (leftHeld) return -1;
        }
        else if (dx < 0f)
        {
            if (rightHeld) return 1;
        }
        return 0;
    }
    void StartOrUpdateWeave(int dir)
    {
        if (!isWeaving)
        {
            weaveStartTime = Time.time;
            isWeaving = true;
            weaveDir = (dir == 0) ? 0 : ((dir < 0) ? -1 : 1);
            weaveBaseHeadLocalPos = GetHeadBaseLocalPos(false, 0f);
            weaveTempUpGuardHeld = false;
            weaveHitboxTickAccum = 0f;
            weaveHitboxRollSalt = 0;
            if (weaveRoutine != null) StopCoroutine(weaveRoutine);
            weaveRoutine = StartCoroutine(MoveHeadWeaveRoutine(GetWeaveTargetLocalPos(weaveDir), GetWeaveTransitionTime()));
        }
        else
        {
            weaveDir = (dir == 0) ? 0 : ((dir < 0) ? -1 : 1);
            if (weaveRoutine != null) StopCoroutine(weaveRoutine);
            weaveRoutine = StartCoroutine(MoveHeadWeaveRoutine(GetWeaveTargetLocalPos(weaveDir), GetWeaveTransitionTime()));
        }
    }
    Vector3 GetHeadBaseLocalPos(bool includeDuck, float duckDrop)
    {
        Vector3 p = headNeutralLocalPos;
        if (clinchActive) p += new Vector3(clinchForwardLocal, -clinchHeadDownLocal, 0f);
        if (includeDuck) p += new Vector3(0f, -Mathf.Abs(duckDrop), 0f);
        return p;
    }
    Vector3 GetWeaveTargetLocalPos(int dir)
    {
        bool ducked = isDucking;
        float drop = isWeaveDucking ? Mathf.Abs(weaveDuckHeadDrop) : Mathf.Abs(duckDistance);
        Vector3 target = GetHeadBaseLocalPos(ducked, drop);
        if (dir == 0) return target;
        float facingSign = GetFacingSign();
        float localOffsetX = Mathf.Abs(weaveDistance) * dir * facingSign;
        target.x += localOffsetX;
        return target;
    }
    float GetWeaveTransitionTime()
    {
        float t = Mathf.Max(0.001f, weaveTransitionTime);
        if (handsDownActive) t *= 0.5f;
        return t;
    }
    void StopWeaveImmediate(bool snapBack)
    {
        if (!isWeaving) return;
        isWeaving = false;
        weaveDir = 0;
        weaveFrozen = false;
        weaveTempUpGuardHeld = false;
        weaveStartTime = -999f;
        weaveHoldActiveTimer = 0f;
        weaveHoldHitboxChanceMult = 1f;
        if (weaveRoutine != null)
        {
            StopCoroutine(weaveRoutine);
            weaveRoutine = null;
        }
        if (weaveHitboxDisabled) SetHeadHitboxesEnabled(true);
        if (head != null)
        {
            Vector3 basePos = GetHeadBaseLocalPos(isDucking, isWeaveDucking ? weaveDuckHeadDrop : duckDistance);
            if (snapBack) head.localPosition = basePos;
            else
            {
                if (headMoveRoutine != null) StopCoroutine(headMoveRoutine);
                headMoveRoutine = StartCoroutine(MoveHeadRoutine(basePos, GetWeaveTransitionTime()));
            }
        }
        ForceFullFistReset();
        ApplyClinchForwardOffsetIfNeeded();
    }
    IEnumerator MoveHeadWeaveRoutine(Vector3 targetLocalPos, float duration)
    {
        if (head == null) yield break;
        Vector3 start = head.localPosition;
        if (duration <= 0f)
        {
            head.localPosition = targetLocalPos;
            yield break;
        }
        float t = 0f;
        while (t < 1f)
        {
            t += Time.deltaTime / duration;
            t = Mathf.Clamp01(t);
            head.localPosition = Vector3.Lerp(start, targetLocalPos, t);
            yield return null;
        }
        head.localPosition = targetLocalPos;
        weaveRoutine = null;
    }
    void HandleWeaveTempUpGuardPose()
    {
        if (blockOrDuckDisabled) return;
        if (!isWeaving) { weaveTempUpGuardHeld = false; return; }
        if (isDucking) { weaveTempUpGuardHeld = false; return; }
        bool upHeld = Input.GetKey(KeyCode.UpArrow);
        if (upHeld && !weaveTempUpGuardHeld)
        {
            weaveTempUpGuardHeld = true;
            ApplyTempUpGuardPose(true);
        }
        else if (!upHeld && weaveTempUpGuardHeld)
        {
            weaveTempUpGuardHeld = false;
            ApplyTempUpGuardPose(false);
        }
    }
    void ApplyTempUpGuardPose(bool active)
    {
        if (isDucking) return;
        if (active)
        {
            if (leftFist != null) leftFist.SetGuardActive(true, highBlockGuardYOffset, guardTransitionTime);
            if (rightFist != null) rightFist.SetGuardActive(true, highBlockGuardYOffset, guardTransitionTime);
        }
        else ForceFullFistReset();
        ApplyClinchForwardOffsetIfNeeded();
    }
    void HandleDuckInput()
    {
        if (blockOrDuckDisabled) return;
        if (duckDisabledByClinch) return;
        if (head == null) return;
        bool downHeld = Input.GetKey(KeyCode.DownArrow);
        if (isWeaving)
        {
            if (Input.GetKeyDown(KeyCode.DownArrow)) StartWeaveDuck();
            if (Input.GetKeyUp(KeyCode.DownArrow)) EndDuck();
            return;
        }
        if (Input.GetKeyDown(KeyCode.DownArrow)) StartDuck();
        if (Input.GetKeyUp(KeyCode.DownArrow)) EndDuck();
    }
    void StartWeaveDuck()
    {
        if (blockOrDuckDisabled) return;
        if (duckDisabledByClinch) return;
        if (isDucking) return;
        if (head == null) return;
        isDucking = true;
        isWeaveDucking = true;
        weaveDuckForceNeutralX = false;
        duckForcedFromLowBlock = false;
        duckTimer = 0f;
        lowBlockActive = false;
        Vector3 target = GetHeadBaseLocalPos(true, weaveDuckHeadDrop);
        if (isWeaving) target = GetWeaveTargetLocalPos(weaveDir);
        if (headMoveRoutine != null) StopCoroutine(headMoveRoutine);
        headMoveRoutine = StartCoroutine(MoveHeadRoutine(target, duckTransitionTime));
        if (leftFist != null) leftFist.SetDuckActive(true, fistDuckYOffset, duckTransitionTime);
        if (rightFist != null) rightFist.SetDuckActive(true, fistDuckYOffset, duckTransitionTime);
        ApplyClinchForwardOffsetIfNeeded();
    }
    void StartDuck()
    {
        if (blockOrDuckDisabled) return;
        if (duckDisabledByClinch) return;
        if (isDucking) return;
        float duckTime = duckTransitionTime;
        bool upHeld = Input.GetKey(KeyCode.UpArrow);
        if (autoGuardActive && highBlockActive && !lowBlockActive)
        {
            float slow = Mathf.Clamp01(upBlockStandingDuckSlowPercent);
            duckTime = duckTransitionTime * (1f + slow);
        }
        duckForcedFromLowBlock = (autoGuardActive && lowBlockActive);
        if (duckForcedFromLowBlock) lowBlockActive = false;
        if (autoGuardActive) highBlockActive = upHeld;
        isDucking = true;
        isWeaveDucking = false;
        weaveDuckForceNeutralX = false;
        duckTimer = 0f;
        Vector3 targetPos = GetHeadBaseLocalPos(true, duckDistance);
        if (isWeaving) targetPos = GetWeaveTargetLocalPos(weaveDir);
        if (headMoveRoutine != null) StopCoroutine(headMoveRoutine);
        headMoveRoutine = StartCoroutine(MoveHeadRoutine(targetPos, duckTime));
        if (leftFist != null) leftFist.SetDuckActive(true, fistDuckYOffset, duckTime);
        if (rightFist != null) rightFist.SetDuckActive(true, fistDuckYOffset, duckTime);
        ApplyClinchForwardOffsetIfNeeded();
    }
    void HandleWeaveDuckNeutralXRule()
    {
        if (!isWeaveDucking) return;
        if (!isDucking) return;
        if (head == null) return;
        bool downHeld = Input.GetKey(KeyCode.DownArrow);
        if (!downHeld) return;
        bool spaceHeld = Input.GetKey(KeyCode.Space);
        bool shiftHeld = Input.GetKey(KeyCode.LeftShift) || Input.GetKey(KeyCode.RightShift);
        if (!spaceHeld && !shiftHeld && !weaveDuckForceNeutralX)
        {
            weaveDuckForceNeutralX = true;
            Vector3 target = GetHeadBaseLocalPos(true, weaveDuckHeadDrop);
            if (headMoveRoutine != null) StopCoroutine(headMoveRoutine);
            headMoveRoutine = StartCoroutine(MoveHeadRoutine(target, duckTransitionTime));
        }
    }
    void EndDuck()
    {
        if (!isDucking) return;
        isDucking = false;
        isWeaveDucking = false;
        weaveDuckForceNeutralX = false;
        duckTimer = 0f;
        duckForcedFromLowBlock = false;
        Vector3 restoreHead = GetHeadBaseLocalPos(false, 0f);
        bool spaceHeld = Input.GetKey(KeyCode.Space);
        bool weaveStillHeld = isWeaving && spaceHeld;
        if (weaveStillHeld)
        {
            restoreHead = GetWeaveTargetLocalPos(weaveDir);
            restoreHead.y = GetHeadBaseLocalPos(false, 0f).y;
        }
        if (headMoveRoutine != null) StopCoroutine(headMoveRoutine);
        headMoveRoutine = StartCoroutine(MoveHeadRoutine(restoreHead, duckTransitionTime));
        if (leftFist != null) leftFist.SetDuckActive(false, fistDuckYOffset, duckTransitionTime);
        if (rightFist != null) rightFist.SetDuckActive(false, fistDuckYOffset, duckTransitionTime);
        ForceFullFistReset();
        ApplyClinchForwardOffsetIfNeeded();
    }
    IEnumerator MoveHeadRoutine(Vector3 targetLocalPos, float duration)
    {
        if (head == null) yield break;
        Vector3 start = head.localPosition;
        if (duration <= 0f)
        {
            head.localPosition = targetLocalPos;
            yield break;
        }
        float t = 0f;
        while (t < 1f)
        {
            t += Time.deltaTime / duration;
            t = Mathf.Clamp01(t);
            head.localPosition = Vector3.Lerp(start, targetLocalPos, t);
            yield return null;
        }
        head.localPosition = targetLocalPos;
    }
    void UpdateDuckEffects()
    {
        if (ownerStats == null) return;
        if (isDucking)
        {
            ownerStats.PauseRegen(0.15f);
            duckTimer += Time.deltaTime;
            if (duckTimer >= duckPenaltyDelay && duckMaxStaminaDrainPerSecond > 0f)
            {
                float drainPerSec = Mathf.Max(0f, duckMaxStaminaDrainPerSecond);
                float amount = ownerStats.maxStamina * drainPerSec * Time.deltaTime;
                ownerStats.currentStamina = Mathf.Max(0f, ownerStats.currentStamina - amount);
            }
        }
        else duckTimer = 0f;
    }
    void EnforceWeaveFistXOffsets()
    {
        if (!isWeaving) return;
        if (clinchActive) return;
        bool leftPunching = (leftFist != null && leftFist.IsPunchingNow);
        bool rightPunching = (rightFist != null && rightFist.IsPunchingNow);
        float facingSign = GetFacingSign();
        float localWeaveX = Mathf.Abs(weaveDistance) * weaveDir * facingSign;
        float fistWeaveX = localWeaveX * Mathf.Clamp(weaveFistXMultiplier, 0f, 1.25f);
        float baseLeftX = GetLeftFistBaselineLocalX();
        float baseRightX = GetRightFistBaselineLocalX();
        if (leftFist != null && !leftPunching && !weaveTempUpGuardHeld)
        {
            Vector3 p = leftFist.transform.localPosition;
            p.x = baseLeftX + fistWeaveX;
            leftFist.transform.localPosition = p;
        }
        if (rightFist != null && !rightPunching && !weaveTempUpGuardHeld)
        {
            Vector3 p = rightFist.transform.localPosition;
            p.x = baseRightX + fistWeaveX;
            rightFist.transform.localPosition = p;
        }
    }
    void ForceFullFistReset()
    {
        if (isDucking) return;
        if (handsDownActive)
        {
            if (leftFist != null) leftFist.SetHandsDownActive(true, -Mathf.Abs(handsDownDropAmount), guardTransitionTime);
            if (rightFist != null) rightFist.SetHandsDownActive(true, -Mathf.Abs(handsDownDropAmount), guardTransitionTime);
            return;
        }
        float offset = 0f;
        if (autoGuardActive)
        {
            offset = guardYOffset;
            if (highBlockActive) offset = highBlockGuardYOffset;
            else if (lowBlockActive) offset = lowBlockGuardYOffset;
        }
        if (leftFist != null) leftFist.SetGuardActive(autoGuardActive, offset, guardTransitionTime);
        if (rightFist != null) rightFist.SetGuardActive(autoGuardActive, offset, guardTransitionTime);
    }
    public bool IsAutoGuardActive() => autoGuardActive;
    public bool IsHighBlockActive() => autoGuardActive && highBlockActive;
    public bool IsLowBlockActive() => autoGuardActive && lowBlockActive;
    public bool IsDucking() => isDucking;
    public bool IsHandsDownActive() => handsDownActive;
    public void NotifyPunchStartForHitblock() => isPunchingForHitblock = true;
    public void NotifyPunchEndForHitblock() => isPunchingForHitblock = false;
    public bool IsHitBlocking() => autoGuardActive && isPunchingForHitblock;
    public void AiSetAutoGuard(bool active)
    {
        if (blockOrDuckDisabled) return;
        if (clinchActive) return;
        if (active) ActivateAutoGuard_ResetTimer();
        else DeactivateAutoGuard();
    }
    public void AiSetHighBlock(bool active)
    {
        if (blockOrDuckDisabled) return;
        if (clinchActive) return;
        if (!autoGuardActive) ActivateAutoGuard_ResetTimer();
        highBlockActive = active;
        if (active) lowBlockActive = false;
        ApplyCurrentGuardOffsets();
        ApplyClinchForwardOffsetIfNeeded();
    }
    public void AiSetLowBlock(bool active)
    {
        if (blockOrDuckDisabled) return;
        if (clinchActive) return;
        if (isDucking)
        {
            lowBlockActive = false;
            ApplyCurrentGuardOffsets();
            ApplyClinchForwardOffsetIfNeeded();
            return;
        }
        if (!autoGuardActive) ActivateAutoGuard_ResetTimer();
        lowBlockActive = active;
        if (active) highBlockActive = false;
        ApplyCurrentGuardOffsets();
        ApplyClinchForwardOffsetIfNeeded();
    }
    public void AiSetHandsDown(bool active)
    {
        if (blockOrDuckDisabled) return;
        if (clinchActive) return;
        if (active) ActivateHandsDown();
        else DeactivateHandsDown();
    }
    public void AiSetDuck(bool active)
    {
        if (blockOrDuckDisabled) return;
        if (duckDisabledByClinch) return;
        if (active) StartDuck();
        else EndDuck();
    }
}
