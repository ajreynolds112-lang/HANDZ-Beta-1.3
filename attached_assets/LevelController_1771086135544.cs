using UnityEngine;
public class LevelController : MonoBehaviour
{
    [Header("Level (1–100)")]
    [Range(1, 100)]
    public int level = 1;
    [System.Serializable]
    public class DifficultyMultipliers
    {
        [Header("Difficulty Multipliers (sliders)")]
        [Range(0.50f, 2.00f)] public float accuracyMult = 1.00f;
        [Range(0.50f, 2.50f)] public float damageDealtMult = 1.00f;
        [Range(0.35f, 2.00f)] public float damageTakenMult = 1.00f;
        [Range(0.50f, 2.50f)] public float punchSpeedMult = 1.00f;
        [Range(0.50f, 2.00f)] public float moveSpeedMult = 1.00f;
    }
    [Header("AI Difficulty (from AiBrain)")]
    public bool useAiDifficultyMultipliers = false;
    [Range(0.70f, 1.00f)]
    public float hardcoreScoreThreshold = 0.90f;
    [Header("Per-Difficulty Slider Sets")]
    public DifficultyMultipliers easy = new DifficultyMultipliers
    {
        accuracyMult     = 0.95f,
        damageDealtMult  = 0.95f,
        damageTakenMult  = 1.05f,
        punchSpeedMult   = 0.95f,
        moveSpeedMult    = 0.95f
    };
    public DifficultyMultipliers medium = new DifficultyMultipliers
    {
        accuracyMult     = 1.00f,
        damageDealtMult  = 1.00f,
        damageTakenMult  = 1.00f,
        punchSpeedMult   = 1.00f,
        moveSpeedMult    = 1.00f
    };
    public DifficultyMultipliers hard = new DifficultyMultipliers
    {
        accuracyMult     = 1.08f,
        damageDealtMult  = 1.10f,
        damageTakenMult  = 0.92f,
        punchSpeedMult   = 1.10f,
        moveSpeedMult    = 1.06f
    };
    public DifficultyMultipliers hardcore = new DifficultyMultipliers
    {
        accuracyMult     = 1.15f,
        damageDealtMult  = 1.18f,
        damageTakenMult  = 0.86f,
        punchSpeedMult   = 1.18f,
        moveSpeedMult    = 1.10f
    };
    [Header("Active Difficulty Multipliers (debug)")]
    [SerializeField] private float _activeDifficultyAccuracy = 1f;
    [SerializeField] private float _activeDifficultyDamageDealt = 1f;
    [SerializeField] private float _activeDifficultyDamageTaken = 1f;
    [SerializeField] private float _activeDifficultyPunchSpeed = 1f;
    [SerializeField] private float _activeDifficultyMoveSpeed = 1f;
    [System.Serializable]
    public class StatScale
    {
        public float min = 1f;
        public float max = 1f;
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
    [System.Serializable]
    public class DiscrepancyScale
    {
        public int thresholdGap = 8;
        public int maxGap = 40;
        public float maxMult = 2f;
        public AnimationCurve curve = AnimationCurve.Linear(0f, 0f, 1f, 1f);
        public float Evaluate(int myLevel, int oppLevel)
        {
            if (oppLevel <= 0) return 1f;
            int gap = myLevel - oppLevel;
            if (gap <= thresholdGap) return 1f;
            int span = Mathf.Max(1, maxGap - thresholdGap);
            int over = Mathf.Clamp(gap - thresholdGap, 0, maxGap - thresholdGap);
            float t = Mathf.Clamp01((float)over / span);
            float c = curve != null ? Mathf.Clamp01(curve.Evaluate(t)) : t;
            return Mathf.Lerp(1f, maxMult, c);
        }
    }
    [Header("Punch / Animation Speed")]
    public StatScale punchSpeedScale = new StatScale { min = 1.0f, max = 1.8f, curve = AnimationCurve.Linear(0f, 0f, 1f, 1f) };
    [Header("Stamina Pool / Regen")]
    public StatScale staminaMaxScale = new StatScale { min = 1.0f, max = 10.0f, curve = AnimationCurve.Linear(0f, 0f, 1f, 1f) };
    public StatScale staminaRegenScale = new StatScale { min = 1.0f, max = 2.5f, curve = AnimationCurve.Linear(0f, 0f, 1f, 1f) };
    [Header("Movement")]
    public StatScale moveSpeedScale = new StatScale { min = 1.0f, max = 1.4f, curve = AnimationCurve.Linear(0f, 0f, 1f, 1f) };
    [Header("Offense (Damage / Costs)")]
    public StatScale punchCostScale = new StatScale { min = 1.0f, max = 0.6f, curve = AnimationCurve.Linear(0f, 0f, 1f, 1f) };
    public StatScale damageScale = new StatScale { min = 1.0f, max = 1.7f, curve = AnimationCurve.Linear(0f, 0f, 1f, 1f) };
    public StatScale staminaDamageTakenScale = new StatScale { min = 1.0f, max = 0.6f, curve = AnimationCurve.Linear(0f, 0f, 1f, 1f) };
    [Header("Defense / Blocking")]
    public StatScale blockEffectScale = new StatScale { min = 1.0f, max = 1.5f, curve = AnimationCurve.Linear(0f, 0f, 1f, 1f) };
    [Header("Accuracy / Crits")]
    public StatScale accuracyScale = new StatScale { min = 1.0f, max = 1.25f, curve = AnimationCurve.Linear(0f, 0f, 1f, 1f) };
    public StatScale critChanceScale = new StatScale { min = 1.0f, max = 1.75f, curve = AnimationCurve.Linear(0f, 0f, 1f, 1f) };
    [Header("Advanced Offense (Crit / Charge Damage)")]
    public StatScale critDamageScale = new StatScale { min = 1.0f, max = 1.5f, curve = AnimationCurve.Linear(0f, 0f, 1f, 1f) };
    public StatScale chargeDamageScale = new StatScale { min = 1.0f, max = 1.6f, curve = AnimationCurve.Linear(0f, 0f, 1f, 1f) };
    [Header("Auto Guard Duration (seconds)")]
    [Tooltip("Max Auto Guard time at each level. Used by DefenseController.\n10s at level 1 → 150s at level 100 by default.")]
    public StatScale autoGuardDurationSecondsScale =
        new StatScale { min = 10.0f, max = 150.0f, curve = AnimationCurve.Linear(0f, 0f, 1f, 1f) };
    [Header("Level Discrepancy Boosts (vs lower-level opponent)")]
    public DiscrepancyScale critDiscrepancyScale = new DiscrepancyScale { thresholdGap = 8, maxGap = 40, maxMult = 3.0f, curve = AnimationCurve.Linear(0f, 0f, 1f, 1f) };
    public DiscrepancyScale stunDiscrepancyScale = new DiscrepancyScale { thresholdGap = 8, maxGap = 40, maxMult = 2.0f, curve = AnimationCurve.Linear(0f, 0f, 1f, 1f) };
    public DiscrepancyScale damageDiscrepancyScale = new DiscrepancyScale { thresholdGap = 8, maxGap = 40, maxMult = 1.4f, curve = AnimationCurve.Linear(0f, 0f, 1f, 1f) };
    public float PunchSpeedMult { get; private set; } = 1f;
    public float StaminaMaxMult { get; private set; } = 1f;
    public float StaminaRegenMult { get; private set; } = 1f;
    public float MoveSpeedMult { get; private set; } = 1f;
    public float PunchCostMult { get; private set; } = 1f;
    public float DamageMult { get; private set; } = 1f;
    public float StaminaDamageTakenMult { get; private set; } = 1f;
    public float BlockEffectMult { get; private set; } = 1f;
    public float AccuracyMult { get; private set; } = 1f;
    public float CritChanceMult { get; private set; } = 1f;
    public float CritDamageMult { get; private set; } = 1f;
    public float ChargeDamageMult { get; private set; } = 1f;
    public float AutoGuardMaxDurationSeconds { get; private set; } = 10f;
    private int _lastLevel = -1;
    void Awake()
    {
        RecalculateAll();
    }
#if UNITY_EDITOR
    void OnValidate()
    {
        if (!Application.isPlaying)
        {
            RecalculateAll();
        }
    }
#endif
    void Update()
    {
        if (level != _lastLevel)
        {
            RecalculateAll();
        }
        else
        {
            if (useAiDifficultyMultipliers)
                RecalculateAll();
        }
    }
    void RecalculateAll()
    {
        int clampedLevel = Mathf.Clamp(level, 1, 100);
        _lastLevel = clampedLevel;
        level = clampedLevel;
        float basePunchSpeed   = punchSpeedScale.Evaluate(clampedLevel);
        float baseStamMax      = staminaMaxScale.Evaluate(clampedLevel);
        float baseStamRegen    = staminaRegenScale.Evaluate(clampedLevel);
        float baseMoveSpeed    = moveSpeedScale.Evaluate(clampedLevel);
        float basePunchCost    = punchCostScale.Evaluate(clampedLevel);
        float baseDamage       = damageScale.Evaluate(clampedLevel);
        float baseStamTaken    = staminaDamageTakenScale.Evaluate(clampedLevel);
        float baseBlock        = blockEffectScale.Evaluate(clampedLevel);
        float baseAccuracy     = accuracyScale.Evaluate(clampedLevel);
        float baseCritChance   = critChanceScale.Evaluate(clampedLevel);
        float baseCritDamage   = critDamageScale.Evaluate(clampedLevel);
        float baseChargeDamage = chargeDamageScale.Evaluate(clampedLevel);
        AutoGuardMaxDurationSeconds = Mathf.Max(0f, autoGuardDurationSecondsScale.Evaluate(clampedLevel));
        var d = GetActiveDifficultyMultipliersFromAiBrain();
        _activeDifficultyAccuracy     = d.accuracyMult;
        _activeDifficultyDamageDealt  = d.damageDealtMult;
        _activeDifficultyDamageTaken  = d.damageTakenMult;
        _activeDifficultyPunchSpeed   = d.punchSpeedMult;
        _activeDifficultyMoveSpeed    = d.moveSpeedMult;
        PunchSpeedMult         = basePunchSpeed * d.punchSpeedMult;
        StaminaMaxMult         = baseStamMax;
        StaminaRegenMult       = baseStamRegen;
        MoveSpeedMult          = baseMoveSpeed * d.moveSpeedMult;
        PunchCostMult          = basePunchCost;
        DamageMult             = baseDamage * d.damageDealtMult;
        StaminaDamageTakenMult = baseStamTaken * d.damageTakenMult;
        BlockEffectMult        = baseBlock;
        AccuracyMult           = baseAccuracy * d.accuracyMult;
        CritChanceMult         = baseCritChance;
        CritDamageMult         = baseCritDamage;
        ChargeDamageMult       = baseChargeDamage;
    }
    DifficultyMultipliers GetActiveDifficultyMultipliersFromAiBrain()
    {
        if (!useAiDifficultyMultipliers)
        {
            return new DifficultyMultipliers
            {
                accuracyMult = 1f,
                damageDealtMult = 1f,
                damageTakenMult = 1f,
                punchSpeedMult = 1f,
                moveSpeedMult = 1f
            };
        }
        AiBrain brain = GetComponentInParent<AiBrain>();
        if (brain == null)
        {
            return medium ?? new DifficultyMultipliers();
        }
        bool treatAsHardcore = (brain.difficultyScore >= hardcoreScoreThreshold);
        switch (brain.difficultyBand)
        {
            case AiBrain.DifficultyBand.Easy:
                return easy ?? new DifficultyMultipliers();
            case AiBrain.DifficultyBand.Medium:
                return medium ?? new DifficultyMultipliers();
            case AiBrain.DifficultyBand.Hard:
                return treatAsHardcore ? (hardcore ?? new DifficultyMultipliers())
                                       : (hard ?? new DifficultyMultipliers());
        }
        return medium ?? new DifficultyMultipliers();
    }
    public float GetCritDiscrepancyMult(LevelController opponent)
    {
        if (opponent == null || critDiscrepancyScale == null) return 1f;
        return critDiscrepancyScale.Evaluate(level, opponent.level);
    }
    public float GetStunDiscrepancyMult(LevelController opponent)
    {
        if (opponent == null || stunDiscrepancyScale == null) return 1f;
        return stunDiscrepancyScale.Evaluate(level, opponent.level);
    }
    public float GetDamageDiscrepancyMult(LevelController opponent)
    {
        if (opponent == null || damageDiscrepancyScale == null) return 1f;
        return damageDiscrepancyScale.Evaluate(level, opponent.level);
    }
    public static LevelController GetFor(Component c)
    {
        if (c == null) return null;
        return c.GetComponentInParent<LevelController>();
    }
}
