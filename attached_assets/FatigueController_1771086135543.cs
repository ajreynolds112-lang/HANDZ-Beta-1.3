using UnityEngine;
/// <summary>
/// Long-term fatigue based on cumulative punishment (clean + blocked hits).
/// Higher levels can take more "effective hits" before full fatigue.
/// Fatigue then smoothly reduces movement speed, punch speed, and stamina regen,
/// and increases vulnerability (damage taken, crit chance, stun chance) once
/// fatigue passes a threshold.
/// 
/// NEW: Fatigue only begins after a level-scaled hit threshold:
///   - ~50 effective hits at level 1
///   - ~200 effective hits at level 100
/// Before that, the fighter is treated as fresh (no fatigue penalties).
/// </summary>
public class FatigueController : MonoBehaviour
{
    [System.Serializable]
    public class StatScale
    {
        [Tooltip("Value at level 1.")]
        public float min = 1f;
        [Tooltip("Value at level 100.")]
        public float max = 1f;
        [Tooltip("Shaping curve over 0–1 (x = normalized level 1→100).\n" +
                 "If left linear, scaling is smooth and simple.")]
        public AnimationCurve curve = AnimationCurve.Linear(0f, 0f, 1f, 1f);
        public float Evaluate(int level)
        {
            if (level <= 1) return min;
            if (level >= 100) return max;
            float t = Mathf.Clamp01((level - 1) / 99f);
            float c = curve != null ? curve.Evaluate(t) : t;
            c = Mathf.Clamp01(c);
            return Mathf.Lerp(min, max, c);
        }
    }
    [Header("Hit Weights & Caps")]
    [Tooltip("How much a clean hit contributes to fatigue compared to 1 'effective hit'.")]
    public float cleanHitWeight = 1f;
    [Tooltip("How much a blocked hit contributes to fatigue compared to 1 'effective hit'.")]
    public float blockedHitWeight = 0.5f;
    [Tooltip("Absolute cap on effective hits counted (for safety).")]
    public float maxEffectiveHitsCap = 400f;
    [Header("Effective Hits to FULL Fatigue (vs Level)")]
    [Tooltip("How many effective hits until the fighter is considered fully fatigued.\n" +
             "Higher levels can take more punishment before gassing out.")]
    public StatScale hitsToFullFatigueScale = new StatScale
    {


        min = 120f,
        max = 400f,
        curve = AnimationCurve.Linear(0f, 0f, 1f, 1f)
    };
    [Header("Fatigue Start Threshold (vs Level)")]
    [Tooltip("Effective hits at which fatigue BEGINs (FatigueProgress leaves 0).\n" +
             "Below this, fighter is treated as fresh (no fatigue penalties).\n" +
             "Example: level 1 => ~50 hits, level 100 => ~200 hits.")]
    public StatScale hitsToStartFatigueScale = new StatScale
    {


        min = 50f,
        max = 200f,
        curve = AnimationCurve.Linear(0f, 0f, 1f, 1f)
    };
    [Header("Full-Fatigue Multipliers at Level 1→100")]
    [Tooltip("Movement speed multiplier at FULL fatigue (fatigueProgress = 1).\n" +
             "Interpolated from 1.0 at no fatigue down toward this value as fatigue increases.\n" +
             "Higher levels lose less movement at full fatigue.")]
    public StatScale moveSpeedFullFatigueMultScale = new StatScale
    {


        min = 0.50f,
        max = 0.80f,
        curve = AnimationCurve.Linear(0f, 0f, 1f, 1f)
    };
    [Tooltip("Punch speed multiplier at FULL fatigue (startup + retraction).\n" +
             "Higher levels maintain more speed at the same fatigue.")]
    public StatScale punchSpeedFullFatigueMultScale = new StatScale
    {


        min = 0.50f,
        max = 0.80f,
        curve = AnimationCurve.Linear(0f, 0f, 1f, 1f)
    };
    [Tooltip("Stamina regen multiplier at FULL fatigue.\n" +
             "Higher levels keep more regen even when very tired.")]
    public StatScale staminaRegenFullFatigueMultScale = new StatScale
    {


        min = 0.30f,
        max = 0.60f,
        curve = AnimationCurve.Linear(0f, 0f, 1f, 1f)
    };
    [Header("Fatigue Vulnerability at FULL Fatigue (Level-Scaled)")]
    [Tooltip("Damage taken multiplier at FULL fatigue.\n" +
             "Interpolated from 1.0 at no fatigue up toward this at high fatigue.\n" +
             "Higher levels are less fragile when gassed.")]
    public StatScale damageTakenFullFatigueMultScale = new StatScale
    {


        min = 4f,
        max = 2.5f,
        curve = AnimationCurve.Linear(0f, 0f, 1f, 1f)
    };
    [Tooltip("Crit chance vulnerability at FULL fatigue (multiplier on base crit chance).\n" +
             "Higher levels have less of a crit spike when tired.")]
    public StatScale critVulnerabilityFullFatigueMultScale = new StatScale
    {


        min = 3f,
        max = 1.5f,
        curve = AnimationCurve.Linear(0f, 0f, 1f, 1f)
    };
    [Tooltip("Stun chance vulnerability at FULL fatigue (multiplier on base stun chance).\n" +
             "Hook this into your stun system (e.g., StunCritController).")]
    public StatScale stunVulnerabilityFullFatigueMultScale = new StatScale
    {


        min = 3f,
        max = 1.5f,
        curve = AnimationCurve.Linear(0f, 0f, 1f, 1f)
    };
    [Header("Vulnerability Threshold")]
    [Tooltip("FatigueProgress (0–1) at which extra vulnerability begins.\n" +
             "Below this, you take normal damage / crit / stun.\n" +
             "Above this, vulnerability ramps up towards full-fatigue values.")]
    [Range(0f, 1f)] public float vulnerabilityStartFatigue = 0.40f;

    private LevelController levelController;

    private float cleanHitsEffective = 0f;
    private float blockedHitsEffective = 0f;
    /// <summary>
    /// 0 = fresh, 1 = fully fatigued
    /// </summary>
    public float FatigueProgress { get; private set; } = 0f;
    /// <summary>
    /// Multiplier applied to movement speed from fatigue (1 → no fatigue, down to some value).
    /// </summary>
    public float MoveSpeedFatigueMult { get; private set; } = 1f;
    /// <summary>
    /// Multiplier applied to punch timings (launch, extend, retract) from fatigue.
    /// </summary>
    public float PunchSpeedFatigueMult { get; private set; } = 1f;
    /// <summary>
    /// Multiplier applied to stamina regen from fatigue.
    /// </summary>
    public float StaminaRegenFatigueMult { get; private set; } = 1f;
    /// <summary>
    /// Multiplier on damage taken due to fatigue (>= 1).
    /// </summary>
    public float DamageTakenMult { get; private set; } = 1f;
    /// <summary>
    /// Multiplier on crit chance against this fighter due to fatigue (>= 1).
    /// </summary>
    public float CritVulnerabilityMult { get; private set; } = 1f;
    /// <summary>
    /// Multiplier on stun chance against this fighter due to fatigue (>= 1).
    /// Your stun system should read this and multiply its base chance.
    /// </summary>
    public float StunVulnerabilityMult { get; private set; } = 1f;
    void Awake()
    {
        levelController = LevelController.GetFor(this);
        RecalculateFatigue();
    }
#if UNITY_EDITOR
    void OnValidate()
    {
        if (!Application.isPlaying)
        {

            cleanHitWeight = Mathf.Max(0f, cleanHitWeight);
            blockedHitWeight = Mathf.Max(0f, blockedHitWeight);
            maxEffectiveHitsCap = Mathf.Max(1f, maxEffectiveHitsCap);
        }
    }
#endif



    public void RegisterCleanHit()
    {
        if (cleanHitWeight <= 0f) return;
        cleanHitsEffective += cleanHitWeight;
        RecalculateFatigue();
    }
    public void RegisterBlockedHit()
    {
        if (blockedHitWeight <= 0f) return;
        blockedHitsEffective += blockedHitWeight;
        RecalculateFatigue();
    }
    /// <summary>
    /// Optional: call this between rounds to reset long-term fatigue.
    /// </summary>
    public void ResetFatigue()
    {
        cleanHitsEffective = 0f;
        blockedHitsEffective = 0f;
        RecalculateFatigue();
    }



    void RecalculateFatigue()
    {
        int level = 1;
        if (levelController != null)
            level = Mathf.Clamp(levelController.level, 1, 100);

        float hitsToFull = hitsToFullFatigueScale.Evaluate(level);
        hitsToFull = Mathf.Max(1f, hitsToFull);

        float hitsToStart = hitsToStartFatigueScale.Evaluate(level);
        hitsToStart = Mathf.Max(0f, hitsToStart);

        if (hitsToStart >= hitsToFull)
        {

            hitsToStart = hitsToFull * 0.8f;
        }
        float effectiveHits = Mathf.Clamp(
            cleanHitsEffective + blockedHitsEffective,
            0f,
            maxEffectiveHitsCap
        );

        float t = 0f;
        if (effectiveHits <= hitsToStart)
        {

            t = 0f;
        }
        else
        {
            float denom = Mathf.Max(1f, hitsToFull - hitsToStart);
            t = Mathf.Clamp01((effectiveHits - hitsToStart) / denom);
        }
        FatigueProgress = t;

        float fullMoveMult   = Mathf.Clamp01(moveSpeedFullFatigueMultScale.Evaluate(level));
        float fullPunchMult  = Mathf.Clamp01(punchSpeedFullFatigueMultScale.Evaluate(level));
        float fullRegenMult  = Mathf.Clamp01(staminaRegenFullFatigueMultScale.Evaluate(level));

        MoveSpeedFatigueMult    = Mathf.Lerp(1f, fullMoveMult,  t);
        PunchSpeedFatigueMult   = Mathf.Lerp(1f, fullPunchMult, t);
        StaminaRegenFatigueMult = Mathf.Lerp(1f, fullRegenMult, t);


        float vStart = Mathf.Clamp01(vulnerabilityStartFatigue);
        float vProgress = 0f;
        if (t > vStart)
        {

            vProgress = Mathf.Clamp01((t - vStart) / (1f - vStart));
        }

        float fullDamageTakenMult =
            Mathf.Max(1f, damageTakenFullFatigueMultScale.Evaluate(level));
        float fullCritVulnMult =
            Mathf.Max(1f, critVulnerabilityFullFatigueMultScale.Evaluate(level));
        float fullStunVulnMult =
            Mathf.Max(1f, stunVulnerabilityFullFatigueMultScale.Evaluate(level));

        DamageTakenMult       = Mathf.Lerp(1f, fullDamageTakenMult,  vProgress);
        CritVulnerabilityMult = Mathf.Lerp(1f, fullCritVulnMult,     vProgress);
        StunVulnerabilityMult = Mathf.Lerp(1f, fullStunVulnMult,     vProgress);
    }



    public static FatigueController GetFor(Component c)
    {
        if (c == null) return null;
        return c.GetComponentInParent<FatigueController>();
    }
}
