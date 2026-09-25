using UnityEngine;
public class RhythmController : MonoBehaviour
{
    public enum FootWeight
    {
        Back,
        Neutral,
        Front
    }
    [Header("Control Mode")]
    [Tooltip("Check this on the human-controlled fighter. Uncheck on AI so AI doesn't read keyboard.")]
    public bool isPlayerControlled = true;
    [Header("Rhythm State (debug)")]
    [Range(0, 4)] public int rhythmSpeed = 0;
    [Range(0f, 1f)] public float rhythmPhase = 0f;
    [Range(1, 17)] public int currentFrame = 1;
    public FootWeight currentWeight = FootWeight.Neutral;
    [Header("Visual Settings")]
    public float baseCycleDuration = 1.2f;
    public float tiltDegrees = 2f;
    [Header("Movement Direction Effect")]
    public float movementDirectionalBonus = 0.07f;
    [Header("Back-Foot Region (Frames 1–3)")]
    public float backFootJabDamageBonus = 0.07f;
    public float backFootJabSpeedBonus = 0.07f;
    public float backFootWhiffBonus = 0.07f;
    public float backFootRangePenalty = 0.07f;
    public float backFootCrossRetractSlow = 0.07f;
    public float backFootRegenPenalty = 0.07f;
    [Header("Peak Region (Frames 8–10)")]
    public float peakRegenBonus = 0.14f;
    public float peakPunchSpeedBonus = 0.07f;
    public float peakHitRegenPauseShort = 0.2f;
    public float peakHitRegenPauseLong = 1.0f;
    [Header("Front-Foot Region (Frames 14–17)")]
    public float frontFootHookDamageBonus = 0.07f;
    public float frontFootHookSpeedBonus = 0.07f;
    public float frontFootCrossDamageBonus = 0.07f;
    public float frontFootCrossSpeedBonus = 0.07f;
    public float frontFootRangeBonus = 0.07f;
    public float frontFootAccuracyBonus = 0.07f;
    public float frontFootRegenPenalty = 0.07f;
    [Header("Target Weight Hit Bonuses")]
    public float vsBackFootDamageBonus = 0.07f;
    public float vsFrontFootSpeedBonus = 0.07f;
    [Header("Fatigue Integration")]
    public bool useFatigueRhythmLimit = true;
    [Range(0f, 1f)] public float fatigueRhythmDisableThreshold = 0.25f;

    bool isPausedByShiftHold = false;
    float storedPhaseWhenPaused = 0f;
    FootWeight manualStance = FootWeight.Neutral;
    private FatigueController fatigue;
    private bool rhythmLockedByFatigue = false;
    private HitstopController hitstop;

    private DefenseController defense;
    private ClinchController clinch;
    private bool rhythmLockedByClinch = false;
    private int preClinchSpeed = 0;
    private float preClinchPhase = 0f;
    private FootWeight preClinchManualStance = FootWeight.Neutral;



    [Header("Rhythm Animation Speed Variance")]
    [Tooltip("Max +/- variance applied ONCE per fight to how fast rhythm animates (very subtle).")]
    [Range(0f, 0.10f)]
    public float perFightAnimSpeedVariancePercent = 0.02f; // 2% default
    [Tooltip("Every round, rhythm animation speed gets slower by this % (subtle fatigue).")]
    [Range(0f, 0.10f)]
    public float perRoundAnimSpeedDecreasePercent = 0.015f; // 1.5% default
    private float fightAnimSpeedMultiplier = 1f; // rolled once per fight
    private float roundAnimSpeedMultiplier = 1f; // derived from round number



    [Header("RhythmCut Windows (Hit Effects)")]
    [Tooltip("If hit occurs while target is in these frames, stamina regen pause applies.")]
    public Vector2Int rhythmCutRegenPauseFrames = new Vector2Int(7, 11);
    [Tooltip("If hit occurs while target is in these frames, stun chance gets a bonus (if not blocked / or punching while blocking).")]
    public Vector2Int rhythmCutStunBonusFrames = new Vector2Int(8, 10);
    [Tooltip("If hit occurs exactly on this frame, crit/stun bonuses apply AND movement slow applies (if allowed).")]
    [Range(1, 17)]
    public int rhythmCutPerfectFrame = 9;
    [Tooltip("Regen pause duration when hit in RhythmCutRegenPauseFrames.")]
    public float rhythmCutRegenPauseDuration = 0.75f;
    [Tooltip("Movement slow duration when hit on perfect frame (default 0.75).")]
    public float rhythmCutMoveSlowDuration = 0.75f;
    [Tooltip("Extra stun chance added when hit in rhythmCutStunBonusFrames (not a multiplier; your hit system decides how to use this).")]
    [Range(0f, 1f)]
    public float rhythmCutStunChanceBonus = 0.12f;
    [Tooltip("Extra crit chance added when hit on perfect frame (not a multiplier; your hit system decides how to use this).")]
    [Range(0f, 1f)]
    public float rhythmCutCritChanceBonusOnPerfect = 0.10f;
    [Tooltip("Extra stun chance added when hit on perfect frame (stacked on top of frame window bonus if you want).")]
    [Range(0f, 1f)]
    public float rhythmCutStunChanceBonusOnPerfect = 0.18f;
    float GetEffectiveAnimSpeedMultiplier()
    {
        return Mathf.Max(0.01f, fightAnimSpeedMultiplier * roundAnimSpeedMultiplier);
    }
    public void RollPerFightAnimSpeed(TimeBasedRNG rng)
    {
        if (rng == null)
        {
            fightAnimSpeedMultiplier = 1f;
            return;
        }
        float v = Mathf.Clamp(perFightAnimSpeedVariancePercent, 0f, 0.10f);
        float delta = rng.Range(-v, v);
        fightAnimSpeedMultiplier = 1f + delta;
    }
    public void ApplyRoundAnimSpeedFatigue(int roundNumber)
    {
        int r = Mathf.Max(1, roundNumber);
        float d = Mathf.Clamp(perRoundAnimSpeedDecreasePercent, 0f, 0.10f);
        roundAnimSpeedMultiplier = Mathf.Pow(1f - d, r - 1);
        roundAnimSpeedMultiplier = Mathf.Max(0.01f, roundAnimSpeedMultiplier);
    }
    public void ForceRhythmSpeed(int newSpeed, bool resetPhaseToNeutral = true)
    {
        if (rhythmLockedByClinch) return;
        rhythmSpeed = Mathf.Clamp(newSpeed, 0, 4);
        isPausedByShiftHold = false;
        storedPhaseWhenPaused = 0f;
        if (resetPhaseToNeutral)
        {
            manualStance = FootWeight.Neutral;
            rhythmPhase = 0.5f;
            storedPhaseWhenPaused = rhythmPhase;
        }
    }
    void Awake()
    {
        fatigue = FatigueController.GetFor(this);
        hitstop = HitstopController.GetFor(this);
        defense = GetComponent<DefenseController>();
        clinch = GetComponent<ClinchController>();
    }
    void Update()
    {
        if (useFatigueRhythmLimit)
            UpdateFatigueRhythmLock();
        UpdateClinchRhythmLock();
        if (hitstop != null && hitstop.IsInHitstop)
            return;
        if (rhythmLockedByClinch)
        {
            ApplyVisualTilt();
            UpdateFrameAndWeight();
            return;
        }
        if (isPlayerControlled)
            HandleInput();
        UpdateRhythmPhase(Time.deltaTime);
        ApplyVisualTilt();
        UpdateFrameAndWeight();
    }
    void UpdateClinchRhythmLock()
    {
        bool clinchingNow =
            (clinch != null && clinch.IsClinching) ||
            (defense != null && defense.IsClinchActive());
        if (clinch != null && clinchingNow && !rhythmLockedByClinch)
        {
            rhythmLockedByClinch = true;
            preClinchSpeed = rhythmSpeed;
            preClinchPhase = rhythmPhase;
            preClinchManualStance = manualStance;
            rhythmSpeed = 0;
            rhythmPhase = 0f;
            isPausedByShiftHold = false;
            storedPhaseWhenPaused = 0f;
            manualStance = FootWeight.Neutral;
        }
        else if (!clinchingNow && rhythmLockedByClinch)
        {
            rhythmLockedByClinch = false;
            rhythmSpeed = preClinchSpeed;
            rhythmPhase = preClinchPhase;
            manualStance = preClinchManualStance;
        }
    }
    void UpdateFatigueRhythmLock()
    {
        float fatigueProgress = 0f;
        if (fatigue != null)
            fatigueProgress = Mathf.Clamp01(fatigue.FatigueProgress);
        bool shouldLock = fatigueProgress >= fatigueRhythmDisableThreshold;
        if (shouldLock && !rhythmLockedByFatigue)
        {
            rhythmLockedByFatigue = true;
            rhythmSpeed = 0;
            isPausedByShiftHold = false;
            manualStance = FootWeight.Neutral;
            rhythmPhase = 0.5f;
            storedPhaseWhenPaused = rhythmPhase;
        }
        else if (!shouldLock && rhythmLockedByFatigue)
        {
            rhythmLockedByFatigue = false;
        }
    }
    void HandleInput()
    {
        bool shiftHeld =
            Input.GetKey(KeyCode.LeftShift) ||
            Input.GetKey(KeyCode.RightShift);
        bool shiftDownThisFrame =
            Input.GetKeyDown(KeyCode.LeftShift) ||
            Input.GetKeyDown(KeyCode.RightShift);
        if (rhythmLockedByFatigue)
        {
            if (shiftDownThisFrame)
                CycleManualStance();
            return;
        }
        if (shiftHeld && Input.GetKeyDown(KeyCode.UpArrow))
            rhythmSpeed = Mathf.Clamp(rhythmSpeed + 1, 0, 4);
        if (shiftHeld && Input.GetKeyDown(KeyCode.DownArrow))
            rhythmSpeed = Mathf.Clamp(rhythmSpeed - 1, 0, 4);
        if (rhythmSpeed > 0)
        {
            if (shiftHeld && !isPausedByShiftHold)
            {
                isPausedByShiftHold = true;
                SnapPhaseToNearestWeight();
                storedPhaseWhenPaused = rhythmPhase;
            }
            else if (!shiftHeld && isPausedByShiftHold)
            {
                isPausedByShiftHold = false;
            }
        }
        else
        {
            if (shiftDownThisFrame)
                CycleManualStance();
        }
    }
    void CycleManualStance()
    {
        switch (manualStance)
        {
            case FootWeight.Back: manualStance = FootWeight.Neutral; break;
            case FootWeight.Neutral: manualStance = FootWeight.Front; break;
            case FootWeight.Front: manualStance = FootWeight.Back; break;
        }
    }
    void UpdateRhythmPhase(float dt)
    {
        if (rhythmLockedByFatigue || rhythmSpeed <= 0)
        {
            switch (manualStance)
            {
                case FootWeight.Back: rhythmPhase = 0.0f; break;
                case FootWeight.Neutral: rhythmPhase = 0.5f; break;
                case FootWeight.Front: rhythmPhase = 1.0f; break;
            }
            return;
        }
        if (isPausedByShiftHold)
        {
            rhythmPhase = storedPhaseWhenPaused;
            return;
        }
        float animSpeedMult = GetEffectiveAnimSpeedMultiplier();
        float cycleDuration = baseCycleDuration / Mathf.Max(0.01f, rhythmSpeed * animSpeedMult);
        rhythmPhase += dt / cycleDuration;
        rhythmPhase %= 1f;
    }
    void SnapPhaseToNearestWeight()
    {
        float backCenter = 1.5f / 17f;
        float frontCenter = 15.5f / 17f;
        float distToBack = Mathf.Abs(rhythmPhase - backCenter);
        float distToFront = Mathf.Abs(rhythmPhase - frontCenter);
        rhythmPhase = (distToBack <= distToFront) ? backCenter : frontCenter;
    }
    void ApplyVisualTilt()
    {
        if (rhythmLockedByClinch || rhythmLockedByFatigue || rhythmSpeed <= 0)
        {
            transform.localRotation = Quaternion.identity;
            return;
        }
        float angle = Mathf.Sin(rhythmPhase * Mathf.PI * 2f) * tiltDegrees;
        transform.localRotation = Quaternion.Euler(0f, 0f, angle);
    }
    void UpdateFrameAndWeight()
    {
        currentFrame = Mathf.Clamp(Mathf.FloorToInt(rhythmPhase * 17f) + 1, 1, 17);
        if (currentFrame >= 1 && currentFrame <= 3) currentWeight = FootWeight.Back;
        else if (currentFrame >= 14 && currentFrame <= 17) currentWeight = FootWeight.Front;
        else currentWeight = FootWeight.Neutral;
    }



    public FootWeight GetCurrentWeight() => currentWeight;
    public float GetMovementMultiplier(int dirX, float facingSign)
    {
        if (dirX == 0) return 1f;
        bool isBack = (currentWeight == FootWeight.Back);
        bool isFront = (currentWeight == FootWeight.Front);
        if (!isBack && !isFront) return 1f;
        bool movingForward = (dirX > 0 && facingSign > 0f) || (dirX < 0 && facingSign < 0f);
        bool favoredDirection = (isFront && movingForward) || (isBack && !movingForward);
        float bonus = movementDirectionalBonus;
        return favoredDirection ? (1f + bonus) : (1f - bonus);
    }
    public float GetAccuracyMultiplier()
    {
        if (currentWeight == FootWeight.Front)
            return 1f + frontFootAccuracyBonus;
        return 1f;
    }
    public float GetRegenMultiplier()
    {
        if (currentFrame >= 8 && currentFrame <= 10)
            return 1f + peakRegenBonus;
        if (currentWeight == FootWeight.Back)
            return 1f - backFootRegenPenalty;
        if (currentWeight == FootWeight.Front)
            return 1f - frontFootRegenPenalty;
        return 1f;
    }
    public void OnCleanHitTaken()
    {
        if (!rhythmLockedByFatigue && rhythmSpeed > 0)
        {
            rhythmPhase = 0.5f;
            storedPhaseWhenPaused = rhythmPhase;
        }
        else
        {
            manualStance = FootWeight.Neutral;
            rhythmPhase = 0.5f;
        }
    }



    /// <summary>
    /// True only when rhythm is actually animating and meaningful for timing.
    /// </summary>
    public bool IsRhythmActive()
    {
        if (rhythmLockedByClinch) return false;
        if (rhythmLockedByFatigue) return false;
        if (rhythmSpeed <= 0) return false;
        if (isPausedByShiftHold) return false;
        return true;
    }
    /// <summary>
    /// Current discrete rhythm frame (1..17).
    /// </summary>
    public int GetCurrentFrame() => currentFrame;
    public float GetCurrentPhase01() => rhythmPhase;
    public float GetCycleDurationSeconds()
    {
        if (!IsRhythmActive()) return float.PositiveInfinity;
        float animSpeedMult = GetEffectiveAnimSpeedMultiplier();
        float cycleDuration = baseCycleDuration / Mathf.Max(0.01f, rhythmSpeed * animSpeedMult);
        return Mathf.Max(0.01f, cycleDuration);
    }
    public float GetSecondsPerFrame()
    {
        float cd = GetCycleDurationSeconds();
        if (float.IsInfinity(cd)) return float.PositiveInfinity;
        return cd / 17f;
    }
    /// <summary>
    /// Returns time until we ENTER the given frame number (1..17) in the current cycle.
    /// If we're already in that frame, returns 0.
    /// </summary>
    public float GetTimeUntilFrame(int targetFrame)
    {
        if (!IsRhythmActive()) return float.PositiveInfinity;
        targetFrame = Mathf.Clamp(targetFrame, 1, 17);

        float framePosNow = rhythmPhase * 17f; // 0..17
        int frameNow = Mathf.Clamp(Mathf.FloorToInt(framePosNow) + 1, 1, 17);
        if (frameNow == targetFrame)
            return 0f;

        float targetFrameStartPhase = (targetFrame - 1) / 17f;
        float deltaPhase = targetFrameStartPhase - rhythmPhase;
        if (deltaPhase < 0f) deltaPhase += 1f; // wrap around
        float cycleDuration = GetCycleDurationSeconds();
        return deltaPhase * cycleDuration;
    }
    /// <summary>
    /// Predicts what frame we'd be in after dt seconds (best-effort, ignores hitstop).
    /// </summary>
    public int PredictFrameAfterSeconds(float dt)
    {
        if (!IsRhythmActive()) return currentFrame;
        float cd = GetCycleDurationSeconds();
        if (float.IsInfinity(cd)) return currentFrame;
        float p = (rhythmPhase + (dt / cd)) % 1f;
        int f = Mathf.Clamp(Mathf.FloorToInt(p * 17f) + 1, 1, 17);
        return f;
    }



    [System.Serializable]
    public struct RhythmHitEffect
    {
        public bool isRhythmCutHit;
        public float regenPauseSeconds;
        public float stunChanceBonus;
        public float critChanceBonus;
        public float moveSlowSeconds;
        public int frameAtHit;
        public bool blockedButAllowed;
    }
    bool IsFrameInRangeInclusive(int f, Vector2Int range)
    {
        int min = Mathf.Min(range.x, range.y);
        int max = Mathf.Max(range.x, range.y);
        return f >= min && f <= max;
    }
    /// <summary>
    /// Call this FROM your hit processing code when a fighter takes a hit.
    /// Provide whether they were blocking, and whether they were punching/feinting/retracting at that moment.
    /// </summary>
    public RhythmHitEffect GetRhythmHitEffect(bool wasBlocking, bool wasPunchingOrFeintingOrRetracting)
    {
        RhythmHitEffect e = new RhythmHitEffect
        {
            isRhythmCutHit = false,
            regenPauseSeconds = 0f,
            stunChanceBonus = 0f,
            critChanceBonus = 0f,
            moveSlowSeconds = 0f,
            frameAtHit = currentFrame,
            blockedButAllowed = false
        };
        if (!IsRhythmActive())
            return e;
        int f = currentFrame;
        bool allowOffensiveEffects = !wasBlocking || wasPunchingOrFeintingOrRetracting;
        if (wasBlocking && allowOffensiveEffects)
            e.blockedButAllowed = true;
        if (IsFrameInRangeInclusive(f, rhythmCutRegenPauseFrames))
        {
            e.isRhythmCutHit = true;
            e.regenPauseSeconds = Mathf.Max(0f, rhythmCutRegenPauseDuration);
        }
        if (allowOffensiveEffects)
        {
            if (IsFrameInRangeInclusive(f, rhythmCutStunBonusFrames))
            {
                e.isRhythmCutHit = true;
                e.stunChanceBonus += Mathf.Clamp01(rhythmCutStunChanceBonus);
            }
            if (f == rhythmCutPerfectFrame)
            {
                e.isRhythmCutHit = true;
                e.critChanceBonus += Mathf.Clamp01(rhythmCutCritChanceBonusOnPerfect);
                e.stunChanceBonus += Mathf.Clamp01(rhythmCutStunChanceBonusOnPerfect);
                e.moveSlowSeconds = Mathf.Max(0f, rhythmCutMoveSlowDuration);
            }
        }
        return e;
    }
}
