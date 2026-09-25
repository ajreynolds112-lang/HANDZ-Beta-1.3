
using UnityEngine;
using System;
using System.Reflection;
public class CritController : MonoBehaviour
{
    [Header("Control Mode")]
    [Tooltip("Check this on the human-controlled fighter. Uncheck on AI so AI does not read A for charge.")]
    public bool isPlayerControlled = true;
    [Header("Crit Settings")]
    [Range(0f, 1f)] public float headCritChance = 0.03f;
    [Range(0f, 1f)] public float bodyCritChance = 0.08f;
    public float critDamageMultiplier = 3f;
    [Header("Crit Effects")]
    public float critRegenPause = 0.5f;
    public float critMovementSlowMultiplier = 0.5f;
    public float critMovementSlowDuration = 2f;
    [Header("RNG (shared personality)")]
    public TimeBasedRNG rng;
    [Header("Charge Punch Settings")]
    public float chargeHoldTime = 0.5f;
    public float chargePunchDamageMultiplier = 1.7f;
    public float chargeStaminaCostMultiplier = 3f;
    public float chargeWhiffRegenPause = 1f;
    [Header("Charge Punch Accuracy")]
    [Tooltip("Base accuracy used ONLY for charge punches (before level/rhythm multipliers). Default 0.60.")]
    [Range(0f, 1f)] public float chargePunchBaseAccuracy = 0.60f;
    [Header("Charge Cooldown")]
    [Range(0f, 30f)] public float chargeCooldownDuration = 10f;
    public float chargeCooldownRemaining = 0f;
    [Header("Charge Ready Window")]
    [Range(0f, 5f)] public float chargeReadyWindowDuration = 2f;
    public float chargeReadyWindowRemaining = 0f;



    [Header("Stun Chance")]
    [Tooltip("Rolled per LANDED punch (after accuracy). Charge punches always stun.")]
    [Range(0f, 1f)] public float baseStunChance = 0.01f; // 1%
    [Header("Stun Effects (on TARGET)")]
    [Range(0.1f, 1f)] public float stunMoveSpeedMultiplier = 0.70f;
    public float stunMoveSlowDuration = 3f;
    public float stunBlockDisableDuration = 1f;
    public float stunRegenDisableDuration = 2f;
    [Range(0.1f, 1f)] public float stunPunchExtendSpeedMultiplier = 0.75f;
    public float stunPunchExtendSlowDuration = 3f;
    [Header("Stun Effects (NEW) - Disable Punching")]
    [Tooltip("If > 0, stun will also prevent the target from punching for this duration. Default 1.0s.")]
    [Range(0f, 5f)] public float stunPunchDisableDuration = 1.0f;
    [Header("Clinch Crit Modifier")]
    [Tooltip("While clinched, the fighter who DID NOT start the clinch gets this crit chance multiplier (spec says 2x).")]
    [Range(1f, 5f)] public float clinchNonInitiatorCritChanceMult = 2f;
    public bool debugStun = false;



    float chargeTimer = 0f;
    bool hasReachedReadyThisHold = false;
    bool inReadyWindow = false;
    private bool aiChargeHeld = false;
    FighterController fighter;
    private LevelController levelController;
    private ClinchController clinch;
    public bool ChargeReady => inReadyWindow && chargeCooldownRemaining <= 0f;
    public bool ChargeOffCooldown => chargeCooldownRemaining <= 0f;
    void Awake()
    {
        fighter = GetComponent<FighterController>();
        if (rng == null) rng = GetComponent<TimeBasedRNG>();
        levelController = LevelController.GetFor(this);
        clinch = GetComponent<ClinchController>();
    }
    void Update()
    {
        HandleCooldown();
        HandleReadyWindow();
        if (isPlayerControlled) HandleChargeInput_Player();
        else HandleChargeInput_Ai();
    }
    public void AiSetChargeHeld(bool held)
    {
        aiChargeHeld = held;
        if (!aiChargeHeld)
        {
            chargeTimer = 0f;
            hasReachedReadyThisHold = false;
        }
    }



    public bool TryApplyCrit(FighterStats targetStats, bool isHeadHit, ref float damage)
    {
        return TryApplyCrit(targetStats, isHeadHit, ref damage, 1f);
    }

    public bool TryApplyCrit(FighterStats targetStats, bool isHeadHit, ref float damage, float externalChanceMult)
    {
        float chance = isHeadHit ? headCritChance : bodyCritChance;
        chance = Mathf.Clamp01(chance);
        if (chance <= 0f) return false;
        externalChanceMult = Mathf.Max(0f, externalChanceMult);
        chance *= externalChanceMult;
        if (levelController != null)
            chance *= Mathf.Max(0f, levelController.CritChanceMult);
        LevelController targetLevelController = LevelController.GetFor(targetStats);
        if (levelController != null && targetLevelController != null)
        {
            float discMult = levelController.GetCritDiscrepancyMult(targetLevelController);
            chance *= Mathf.Max(0f, discMult);
        }
        if (targetStats != null)
        {
            FatigueController targetFatigue = FatigueController.GetFor(targetStats);
            if (targetFatigue != null)
                chance *= Mathf.Max(0f, targetFatigue.CritVulnerabilityMult);
        }
        if (clinch != null && clinch.IsClinching)
        {
            if (!clinch.IStartedThisClinch)
                chance *= Mathf.Max(1f, clinchNonInitiatorCritChanceMult);
        }
        chance = Mathf.Clamp01(chance);
        bool isCrit = (rng != null) ? rng.Chance(chance) : (UnityEngine.Random.value <= chance);
        if (!isCrit) return false;
        if (damage > 0f)
        {
            float mult = Mathf.Max(1f, critDamageMultiplier);
            if (levelController != null)
                mult *= Mathf.Max(0f, levelController.CritDamageMult);
            damage *= mult;
        }
        if (targetStats != null)
        {
            if (critRegenPause > 0f) targetStats.PauseRegen(critRegenPause);
            if (critMovementSlowDuration > 0f && critMovementSlowMultiplier < 1f)
                targetStats.SlowMovement(critMovementSlowMultiplier, critMovementSlowDuration);
        }
        return true;
    }



    public bool TryRollAndApplyStun(FighterStats targetStats, bool isChargePunchLanded, FistHitbox targetFistIfKnown = null)
    {
        if (targetStats == null) return false;
        bool shouldStun = false;
        if (isChargePunchLanded) shouldStun = true;
        else
        {
            float chance = Mathf.Clamp01(baseStunChance);
            shouldStun = (rng != null) ? rng.Chance(chance) : (UnityEngine.Random.value <= chance);
        }
        if (!shouldStun) return false;
        ApplyStunEffects(targetStats);
        if (debugStun) Debug.Log($"[Stun] Applied. Charge={isChargePunchLanded}", this);
        return true;
    }
    void ApplyStunEffects(FighterStats targetStats)
    {
        RhythmController rc = targetStats.GetComponent<RhythmController>();
        if (rc == null) rc = targetStats.GetComponentInParent<RhythmController>();
        if (rc == null) rc = targetStats.GetComponentInChildren<RhythmController>();
        if (rc != null)
        {
            rc.rhythmSpeed = 0;
            rc.rhythmPhase = 0f;
        }
        AiBrain brain = targetStats.GetComponent<AiBrain>();
        if (brain == null) brain = targetStats.GetComponentInParent<AiBrain>();
        if (brain == null) brain = targetStats.GetComponentInChildren<AiBrain>();
        if (brain != null) brain.NotifyStunnedByCrit();
        if (stunMoveSlowDuration > 0f && stunMoveSpeedMultiplier < 1f)
            targetStats.SlowMovement(stunMoveSpeedMultiplier, stunMoveSlowDuration);
        if (stunRegenDisableDuration > 0f)
            targetStats.PauseRegen(stunRegenDisableDuration);
        if (stunBlockDisableDuration > 0f)
        {
            DefenseController def = targetStats.GetComponent<DefenseController>();
            if (def == null) def = targetStats.GetComponentInParent<DefenseController>();
            if (def == null) def = targetStats.GetComponentInChildren<DefenseController>();
            if (def != null)
                def.DisableBlockAndDuckForSeconds(stunBlockDisableDuration);
        }
        if (stunPunchExtendSlowDuration > 0f && stunPunchExtendSpeedMultiplier < 1f)
        {
            FighterController fc = targetStats.GetComponent<FighterController>();
            if (fc == null) fc = targetStats.GetComponentInParent<FighterController>();
            if (fc != null)
            {
                if (fc.leftFist != null) fc.leftFist.ApplyExtendSpeedMultiplier(stunPunchExtendSpeedMultiplier, stunPunchExtendSlowDuration);
                if (fc.rightFist != null) fc.rightFist.ApplyExtendSpeedMultiplier(stunPunchExtendSpeedMultiplier, stunPunchExtendSlowDuration);
            }
            else
            {
                var fists = targetStats.GetComponentsInChildren<FistHitbox>();
                foreach (var f in fists)
                    f.ApplyExtendSpeedMultiplier(stunPunchExtendSpeedMultiplier, stunPunchExtendSlowDuration);
            }
        }
        if (stunPunchDisableDuration > 0f)
            TryDisablePunchingOnTarget(targetStats, stunPunchDisableDuration);
    }
    bool TryDisablePunchingOnTarget(FighterStats targetStats, float duration)
    {
        FighterController fc = targetStats.GetComponent<FighterController>();
        if (fc == null) fc = targetStats.GetComponentInParent<FighterController>();
        if (fc == null) fc = targetStats.GetComponentInChildren<FighterController>();
        bool anyApplied = false;
        if (fc != null)
        {
            anyApplied |= TryInvokeFloatMethod(fc, "DisablePunchingForSeconds", duration);
            anyApplied |= TryInvokeFloatMethod(fc, "DisablePunchsForSeconds", duration);
            anyApplied |= TryInvokeFloatMethod(fc, "DisableAttacksForSeconds", duration);
            anyApplied |= TryInvokeFloatMethod(fc, "DisablePunchForSeconds", duration);
            anyApplied |= TrySetFloatMember(fc, "punchDisabledUntil", Time.time + duration);
            anyApplied |= TrySetFloatMember(fc, "PunchDisabledUntil", Time.time + duration);
            anyApplied |= TrySetFloatMember(fc, "attackDisabledUntil", Time.time + duration);
            anyApplied |= TrySetFloatMember(fc, "AttackDisabledUntil", Time.time + duration);
            anyApplied |= TrySetBoolMember(fc, "punchDisabled", true);
            anyApplied |= TrySetBoolMember(fc, "PunchDisabled", true);
            anyApplied |= TrySetBoolMember(fc, "attacksDisabled", true);
            anyApplied |= TrySetBoolMember(fc, "AttacksDisabled", true);
        }
        var fists = targetStats.GetComponentsInChildren<FistHitbox>();
        if (fists != null && fists.Length > 0)
        {
            foreach (var f in fists)
            {
                if (f == null) continue;
                anyApplied |= TryInvokeFloatMethod(f, "DisablePunchingForSeconds", duration);
                anyApplied |= TryInvokeFloatMethod(f, "DisablePunchForSeconds", duration);
                anyApplied |= TryInvokeFloatMethod(f, "DisableForSeconds", duration);
                anyApplied |= TrySetFloatMember(f, "punchDisabledUntil", Time.time + duration);
                anyApplied |= TrySetFloatMember(f, "PunchDisabledUntil", Time.time + duration);
                anyApplied |= TrySetBoolMember(f, "punchDisabled", true);
                anyApplied |= TrySetBoolMember(f, "PunchDisabled", true);
            }
        }
        return anyApplied;
    }
    public void ApplyChargeWhiffPenalty(FighterStats selfStats)
    {
        if (selfStats == null) return;
        if (chargeWhiffRegenPause > 0f) selfStats.PauseRegen(chargeWhiffRegenPause);
    }
    void HandleCooldown()
    {
        if (chargeCooldownRemaining > 0f)
        {
            chargeCooldownRemaining -= Time.deltaTime;
            if (chargeCooldownRemaining < 0f) chargeCooldownRemaining = 0f;
        }
    }
    void HandleReadyWindow()
    {
        if (!inReadyWindow) return;
        chargeReadyWindowRemaining -= Time.deltaTime;
        if (chargeReadyWindowRemaining <= 0f)
        {
            inReadyWindow = false;
            chargeReadyWindowRemaining = 0f;
            chargeTimer = 0f;
            hasReachedReadyThisHold = false;
        }
    }
    void HandleChargeInput_Player()
    {
        if (inReadyWindow) return;
        if (Input.GetKey(KeyCode.A))
        {
            if (chargeCooldownRemaining <= 0f)
            {
                chargeTimer += Time.deltaTime;
                if (!hasReachedReadyThisHold && chargeTimer >= chargeHoldTime)
                {
                    hasReachedReadyThisHold = true;
                    EnterReadyWindow();
                }
            }
        }
        else
        {
            chargeTimer = 0f;
            hasReachedReadyThisHold = false;
        }
    }
    void HandleChargeInput_Ai()
    {
        if (inReadyWindow) return;
        if (aiChargeHeld)
        {
            if (chargeCooldownRemaining <= 0f)
            {
                chargeTimer += Time.deltaTime;
                if (!hasReachedReadyThisHold && chargeTimer >= chargeHoldTime)
                {
                    hasReachedReadyThisHold = true;
                    EnterReadyWindow();
                }
            }
        }
        else
        {
            chargeTimer = 0f;
            hasReachedReadyThisHold = false;
        }
    }
    void EnterReadyWindow()
    {
        inReadyWindow = true;
        chargeReadyWindowRemaining = chargeReadyWindowDuration;
        if (fighter != null) fighter.TriggerChargeBounce();
    }
    public void PutChargeOnCooldown()
    {
        chargeCooldownRemaining = chargeCooldownDuration;
        inReadyWindow = false;
        chargeReadyWindowRemaining = 0f;
        chargeTimer = 0f;
        hasReachedReadyThisHold = false;
    }



    static bool TryInvokeFloatMethod(object target, string methodName, float arg)
    {
        if (target == null) return false;
        Type t = target.GetType();
        var m = t.GetMethod(methodName, BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);
        if (m == null) return false;
        var pars = m.GetParameters();
        if (pars == null || pars.Length != 1) return false;
        if (pars[0].ParameterType != typeof(float)) return false;
        try { m.Invoke(target, new object[] { arg }); return true; }
        catch { return false; }
    }
    static bool TrySetFloatMember(object target, string memberName, float value)
    {
        if (target == null) return false;
        Type t = target.GetType();
        var f = t.GetField(memberName, BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);
        if (f != null && f.FieldType == typeof(float))
        {
            try { f.SetValue(target, value); return true; }
            catch { return false; }
        }
        var p = t.GetProperty(memberName, BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);
        if (p != null && p.PropertyType == typeof(float) && p.CanWrite)
        {
            try { p.SetValue(target, value, null); return true; }
            catch { return false; }
        }
        return false;
    }
    static bool TrySetBoolMember(object target, string memberName, bool value)
    {
        if (target == null) return false;
        Type t = target.GetType();
        var f = t.GetField(memberName, BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);
        if (f != null && f.FieldType == typeof(bool))
        {
            try { f.SetValue(target, value); return true; }
            catch { return false; }
        }
        var p = t.GetProperty(memberName, BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);
        if (p != null && p.PropertyType == typeof(bool) && p.CanWrite)
        {
            try { p.SetValue(target, value, null); return true; }
            catch { return false; }
        }
        return false;
    }
}
