using UnityEngine;
public class FighterStats : MonoBehaviour
{
    [Header("Stamina (Base Values)")]
    [Tooltip("Base max stamina at level 1. LevelController scales this.")]
    public float maxStamina = 100f;
    [Tooltip("Current stamina (runtime).")]
    public float currentStamina = 100f;
    [Tooltip("Base stamina regen per second at level 1. LevelController scales this.")]
    public float staminaRegenPerSecond = 20f;
    float baseMaxStamina;
    float baseStaminaRegenPerSecond;
    float regenMultiplier = 1f;
    float regenPauseTimer = 0f;
    float regenPenaltyTimer = 0f;
    float moveSlowMultiplier = 1f;
    float moveSlowTimer = 0f;
    [Header("Rhythm / Defense (optional)")]
    public RhythmController rhythm;
    public DefenseController defense;
    [Header("Clinch Integration")]
    public ClinchController clinch;
    [Tooltip("If hit during clinch, regen pauses this long (spec says 0.5s). We will call this from FistHitbox later.")]
    public float clinchHitRegenPauseSeconds = 0.5f;
    private LevelController levelController;
    private FighterClass fighterClass;
    public float CurrentStamina => currentStamina;
    public bool IsExhausted => currentStamina <= 0f;
    void Awake()
    {
        if (rhythm == null) rhythm = GetComponent<RhythmController>();
        if (defense == null) defense = GetComponent<DefenseController>();
        if (clinch == null) clinch = GetComponent<ClinchController>();
        levelController = LevelController.GetFor(this);
        fighterClass = GetComponent<FighterClass>();
        if (fighterClass == null) fighterClass = GetComponentInParent<FighterClass>();
        baseMaxStamina = maxStamina;
        baseStaminaRegenPerSecond = staminaRegenPerSecond;
    }
    void Start()
    {
        if (levelController == null)
            levelController = LevelController.GetFor(this);
        if (fighterClass == null)
        {
            fighterClass = GetComponent<FighterClass>();
            if (fighterClass == null) fighterClass = GetComponentInParent<FighterClass>();
        }
        float scaledMax = GetScaledMaxStamina();
        maxStamina = scaledMax;
        currentStamina = maxStamina;
        staminaRegenPerSecond = GetScaledRegenPerSecond();
    }
    void Update()
    {
        UpdateLevelScaledStats();
        HandleRegen();
        HandleSlow();
    }
    public void ResetStaminaToMax(bool clearRegenPauses = true)
    {
        if (levelController == null) levelController = LevelController.GetFor(this);
        if (fighterClass == null)
        {
            fighterClass = GetComponent<FighterClass>();
            if (fighterClass == null) fighterClass = GetComponentInParent<FighterClass>();
        }
        maxStamina = GetScaledMaxStamina();
        staminaRegenPerSecond = GetScaledRegenPerSecond();
        currentStamina = maxStamina;
        if (clearRegenPauses)
        {
            regenPauseTimer = 0f;
            regenPenaltyTimer = 0f;
            regenMultiplier = 1f;
            moveSlowTimer = 0f;
            moveSlowMultiplier = 1f;
        }
    }
    void UpdateLevelScaledStats()
    {
        if (fighterClass == null)
        {
            fighterClass = GetComponent<FighterClass>();
            if (fighterClass == null) fighterClass = GetComponentInParent<FighterClass>();
        }
        maxStamina = GetScaledMaxStamina();
        staminaRegenPerSecond = GetScaledRegenPerSecond();
        currentStamina = Mathf.Clamp(currentStamina, 0f, maxStamina);
    }
    float GetScaledMaxStamina()
    {
        float levelMult = (levelController != null) ? levelController.StaminaMaxMult : 1f;
        float classMult = (fighterClass != null) ? fighterClass.MaxStaminaMult : 1f;
        return baseMaxStamina * levelMult * classMult;
    }
    float GetScaledRegenPerSecond()
    {
        float levelMult = (levelController != null) ? levelController.StaminaRegenMult : 1f;
        float classMult = (fighterClass != null) ? fighterClass.RegenMult : 1f;
        return baseStaminaRegenPerSecond * levelMult * classMult;
    }
    void HandleRegen()
    {
        if (regenPauseTimer > 0f)
        {
            regenPauseTimer -= Time.deltaTime;
            return;
        }
        if (regenPenaltyTimer > 0f)
        {
            regenPenaltyTimer -= Time.deltaTime;
            if (regenPenaltyTimer <= 0f)
                regenMultiplier = 1f;
        }
        float rhythmMult = 1f;
        if (rhythm != null)
            rhythmMult = rhythm.GetRegenMultiplier();
        float defenseMult = 1f;
        if (defense != null && defense.IsHandsDownActive())
            defenseMult *= (1f + defense.handsDownRegenBonus);
        float clinchMult = 1f;
        bool clinchingNow = (clinch != null && clinch.IsClinching) || (defense != null && defense.IsClinchActive());
        if (clinchingNow && clinch != null && clinch.IsClinching)
        {
            clinchMult = Mathf.Max(0f, clinch.GetCurrentClinchRegenMultiplier());
        }
        float amount = staminaRegenPerSecond * regenMultiplier * rhythmMult * defenseMult * clinchMult * Time.deltaTime;
        currentStamina = Mathf.Min(maxStamina, currentStamina + amount);
    }
    void HandleSlow()
    {
        if (moveSlowTimer > 0f)
        {
            moveSlowTimer -= Time.deltaTime;
            if (moveSlowTimer <= 0f)
                moveSlowMultiplier = 1f;
        }
    }
    public float GetMoveSlowMultiplier() => moveSlowMultiplier;
    public void PauseRegen(float duration)
    {
        regenPauseTimer = Mathf.Max(regenPauseTimer, duration);
    }
    public void OnHitTakenDuringClinch()
    {
        bool clinchingNow = (clinch != null && clinch.IsClinching) || (defense != null && defense.IsClinchActive());
        if (!clinchchingNowSafe(clinchingNow)) return;
        if (clinchHitRegenPauseSeconds > 0f)
            PauseRegen(clinchHitRegenPauseSeconds);
    }
    bool clinchchingNowSafe(bool clinchingNow) => clinchingNow;
    public void ApplyDamage(float d) => ApplyDamageAndGetTaken(d);
    public float ApplyDamageAndGetTaken(float d)
    {
        float taken = d;
        if (levelController != null)
            taken *= levelController.StaminaDamageTakenMult;
        FatigueController fatigue = FatigueController.GetFor(this);
        if (fatigue != null)
            taken *= Mathf.Max(0f, fatigue.DamageTakenMult);
        taken = Mathf.Max(0f, taken);
        float before = currentStamina;
        currentStamina = Mathf.Max(0f, currentStamina - taken);
        return Mathf.Max(0f, before - currentStamina);
    }
    public void PenalizeRegenHit(float mult, float dur)
    {
        regenMultiplier = Mathf.Min(regenMultiplier, mult);
        regenPenaltyTimer = Mathf.Max(regenPenaltyTimer, dur);
    }
    public void SlowMovement(float mult, float dur)
    {
        moveSlowMultiplier = Mathf.Min(moveSlowMultiplier, mult);
        moveSlowTimer = Mathf.Max(moveSlowTimer, dur);
    }
    public float GetPunchCostMult() => (fighterClass != null) ? fighterClass.PunchCostMult : 1f;
    public float GetDamageDealtMult() => (fighterClass != null) ? fighterClass.DamageDealtMult : 1f;
    public bool TrySpendStamina(float amount)
    {
        float cost = amount;
        if (levelController != null)
            cost *= levelController.PunchCostMult;
        if (fighterClass != null)
            cost *= fighterClass.PunchCostMult;
        if (currentStamina < cost)
            return false;
        currentStamina -= cost;
        return true;
    }
    public void ApplyGetupStaminaFraction(float baseFraction, float bonusFraction)
    {
        float finalFrac = Mathf.Clamp01(baseFraction + bonusFraction);
        float restore = maxStamina * finalFrac;
        currentStamina = Mathf.Clamp(restore, 0f, maxStamina);
        PauseRegen(0.05f);
    }
}
