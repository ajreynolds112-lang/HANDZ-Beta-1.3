using System.Collections;
using System.Collections.Generic;
using UnityEngine;
/// <summary>
/// Executes AiCombo objects step-by-step.
/// AiBrain hands a combo to this runner.
/// Reports attempts to AiActionDataBank for scoring/memory.
///
/// Attach to AI fighter root (same object that has FighterController).
/// </summary>
[ExecuteAlways]
public class AiComboRunner : MonoBehaviour
{
    private FighterController controller;
    private AiActionDataBank dataBank;
    private AiComboLibrary comboLibrary;
    private bool runningCombo = false;
    private Coroutine comboRoutine;

    private Transform opponent;

    private RhythmController opponentRhythm;

    private bool hasScheduledStart = false;
    private float scheduledStartDelay = 0f;
    private int scheduledTargetFrame = -1;



    public enum AbortReason
    {
        None,
        ManualStop,
        NullControllerOrStats,
        KnockedDownFrozen,
        StaminaZero,
        StaminaAbortThreshold,
        OutOfRangeDrift,
        ExhaustedDuringWait
    }
    [Header("Debug (Runner)")]
    [Tooltip("If true, runner writes debug info into inspector fields while playing.")]
    public bool debugToInspector = true;
    [Tooltip("If true, runner prints step logs to Console (can get spammy).")]
    public bool debugToConsole = false;
    [Tooltip("Keep last N log entries in inspector.")]
    [Range(0, 50)]
    public int maxLogEntries = 12;
    [System.Serializable]
    public class StepSnapshot
    {
        public int index;
        public FistHitbox.PunchType punch;
        public bool isFeint;
        public AiActionDataBank.HitRegion intendedRegion;
        public float delayAfter;
    }
    [System.Serializable]
    public class RunnerDebugState
    {
        public bool isRunning;
        public string activeComboName;
        public string activeComboId;
        public bool activeComboIsDynamic;
        public int currentStepIndex;
        public StepSnapshot currentStep;
        public float currentStepDelayTotal;
        public float currentStepDelayRemaining;
        public float aiStaminaFrac;
        public float distanceToOpponentX;
        public AbortReason lastAbortReason = AbortReason.None;
        public string lastAbortNote;
        public List<string> recentLog = new List<string>();

        public bool scheduled;
        public float scheduledDelayRemaining;
        public int scheduledTargetFrame;
        public int opponentFrameAtStart;
    }
    [Header("Runtime (Read Only)")]
    [SerializeField] private RunnerDebugState debugState = new RunnerDebugState();
    public bool IsRunningCombo => runningCombo;

    public bool IsWaitingToStart => hasScheduledStart;



    [Header("RhythmCut Start Timing (Best-Effort)")]
    [Tooltip("Approx seconds from StartPunch() to impact for a Jab (includes launch delay + extension). Tune until it feels right.")]
    public float jabLeadTime = 0.18f;
    [Tooltip("Approx seconds from StartPunch() to impact for a Cross.")]
    public float crossLeadTime = 0.22f;
    [Tooltip("Approx seconds from StartPunch() to impact for a Hook.")]
    public float hookLeadTime = 0.26f;
    [Tooltip("Approx seconds from StartPunch() to impact for an Uppercut.")]
    public float upperLeadTime = 0.28f;
    [Tooltip("Random +/- jitter added to scheduled start delay (makes it feel human).")]
    [Range(0f, 0.15f)]
    public float scheduleJitter = 0.03f;
    void Awake()
    {
        SafeInitRefs();
        TryFindOpponentBestEffort();
        TryFindOpponentRhythmBestEffort();
    }
    void OnEnable()
    {
        SafeInitRefs();
        TryFindOpponentBestEffort();
        TryFindOpponentRhythmBestEffort();
    }
    void OnValidate()
    {
        if (!Application.isPlaying)
        {
            SafeInitRefs();
            TryFindOpponentBestEffort();
            TryFindOpponentRhythmBestEffort();
        }
    }
    void SafeInitRefs()
    {
        if (controller == null) controller = GetComponent<FighterController>();
        if (dataBank == null) dataBank = GetComponent<AiActionDataBank>();
        if (comboLibrary == null) comboLibrary = GetComponent<AiComboLibrary>();
        if (controller == null)
            Debug.LogError("AiComboRunner requires FighterController on the same object!");
    }
    void TryFindOpponentBestEffort()
    {
        if (opponent != null) return;
        if (controller == null) return;
        var all = FindObjectsOfType<FighterController>();
        foreach (var fc in all)
        {
            if (fc != null && fc != controller)
            {
                opponent = fc.transform;
                break;
            }
        }
    }
    void TryFindOpponentRhythmBestEffort()
    {
        if (opponentRhythm != null) return;
        if (opponent != null)
        {
            opponentRhythm = opponent.GetComponent<RhythmController>();
            if (opponentRhythm != null) return;
        }

        var allRhythm = FindObjectsOfType<RhythmController>();
        foreach (var rc in allRhythm)
        {
            if (rc != null && rc.transform != transform)
            {
                opponentRhythm = rc;
                break;
            }
        }
    }



    public void StartCombo(AiComboLibrary.AiCombo combo)
    {
        if (runningCombo) return;
        if (hasScheduledStart) return;
        if (combo == null) return;
        if (controller == null || controller.stats == null) return;
        comboRoutine = StartCoroutine(RunComboRoutine(combo, 0f, -1));
    }
    /// <summary>
    /// Start a combo after a fixed delay (used by AiBrain to time RhythmCut).
    /// </summary>
    public void StartComboWithDelay(AiComboLibrary.AiCombo combo, float delaySeconds, int debugTargetFrame = -1)
    {
        if (runningCombo) return;
        if (hasScheduledStart) return;
        if (combo == null) return;
        if (controller == null || controller.stats == null) return;
        delaySeconds = Mathf.Max(0f, delaySeconds);
        comboRoutine = StartCoroutine(RunComboRoutine(combo, delaySeconds, debugTargetFrame));
    }
    /// <summary>
    /// Best-effort helper:
    /// Schedules combo so FIRST STEP is likely to land near opponent target frame.
    /// AiBrain can call this when it chooses RhythmCut.
    /// </summary>
    public void StartComboTargetOpponentFrame(AiComboLibrary.AiCombo combo, int targetFrame)
    {
        if (runningCombo) return;
        if (hasScheduledStart) return;
        if (combo == null) return;
        if (combo.steps == null || combo.steps.Count == 0) return;
        if (controller == null || controller.stats == null) return;
        TryFindOpponentBestEffort();
        TryFindOpponentRhythmBestEffort();
        if (opponentRhythm == null || !opponentRhythm.IsRhythmActive())
        {

            StartCombo(combo);
            return;
        }
        var first = combo.steps[0];

        float lead = EstimateLeadTime(first.punch);
        float tUntilFrame = opponentRhythm.GetTimeUntilFrame(Mathf.Clamp(targetFrame, 1, 17));


        float jitter = Random.Range(-scheduleJitter, scheduleJitter);
        float delay = Mathf.Max(0f, (tUntilFrame - lead) + jitter);
        StartComboWithDelay(combo, delay, targetFrame);
    }
    public void StopCombo()
    {
        if (comboRoutine != null)
            StopCoroutine(comboRoutine);
        comboRoutine = null;
        runningCombo = false;
        hasScheduledStart = false;
        scheduledStartDelay = 0f;
        scheduledTargetFrame = -1;
        SetAbort(AbortReason.ManualStop, "Manual StopCombo() called.");
        if (dataBank != null)
            dataBank.AbortActiveComboAttempt();
        UpdateInspectorRunning(false);
        Log("STOP: Combo aborted manually.");
    }



    IEnumerator RunComboRoutine(AiComboLibrary.AiCombo combo, float startDelay, int debugTargetFrame)
    {
        runningCombo = true;
        UpdateInspectorRunning(true);
        hasScheduledStart = startDelay > 0f;
        scheduledStartDelay = startDelay;
        scheduledTargetFrame = debugTargetFrame;
        if (debugToInspector)
        {
            debugState.scheduled = hasScheduledStart;
            debugState.scheduledDelayRemaining = startDelay;
            debugState.scheduledTargetFrame = debugTargetFrame;
            debugState.opponentFrameAtStart = -1;
            debugState.activeComboName = combo.name;
            debugState.activeComboId = combo.id;
            debugState.activeComboIsDynamic = combo.isDynamic;
            debugState.currentStepIndex = -1;
            debugState.currentStep = null;
            debugState.currentStepDelayTotal = 0f;
            debugState.currentStepDelayRemaining = 0f;
            debugState.lastAbortReason = AbortReason.None;
            debugState.lastAbortNote = "";
        }
        Log($"START: {combo.name} ({combo.id}) steps={combo.steps?.Count ?? 0} dynamic={combo.isDynamic} startDelay={startDelay:0.00}");

        if (dataBank != null)
            dataBank.BeginComboAttempt(combo.id, combo.name, combo.idealMinRange, combo.idealMaxRange, combo.isDynamic);

        if (startDelay > 0f)
        {
            float t = 0f;
            while (t < startDelay)
            {
                if (controller == null || controller.stats == null)
                {
                    SetAbort(AbortReason.NullControllerOrStats, "Controller/stats missing during startDelay.");
                    FinishAttempt();
                    yield break;
                }
                if (controller.isFrozenByKD)
                {
                    SetAbort(AbortReason.KnockedDownFrozen, "Frozen by KD during startDelay.");
                    FinishAttempt();
                    yield break;
                }
                if (controller.stats.currentStamina <= 0f)
                {
                    SetAbort(AbortReason.StaminaZero, "Stamina hit 0 during startDelay.");
                    FinishAttempt();
                    yield break;
                }
                t += Time.deltaTime;
                if (debugToInspector)
                    debugState.scheduledDelayRemaining = Mathf.Max(0f, startDelay - t);
                yield return null;
            }
        }
        hasScheduledStart = false;
        scheduledStartDelay = 0f;
        if (debugToInspector)
        {
            debugState.scheduled = false;
            debugState.scheduledDelayRemaining = 0f;
        }

        TryFindOpponentRhythmBestEffort();
        if (debugToInspector && opponentRhythm != null)
            debugState.opponentFrameAtStart = opponentRhythm.GetCurrentFrame();

        if (combo.steps == null || combo.steps.Count == 0)
        {
            SetAbort(AbortReason.NullControllerOrStats, "Combo had no steps.");
            FinishAttempt();
            yield break;
        }
        for (int i = 0; i < combo.steps.Count; i++)
        {
            var step = combo.steps[i];

            if (controller == null || controller.stats == null)
            {
                SetAbort(AbortReason.NullControllerOrStats, "Controller or stats missing.");
                break;
            }
            if (controller.isFrozenByKD)
            {
                SetAbort(AbortReason.KnockedDownFrozen, "AI frozen by KD.");
                break;
            }
            if (controller.stats.currentStamina <= 0f)
            {
                SetAbort(AbortReason.StaminaZero, "AI stamina hit 0.");
                break;
            }

            float staminaFrac = GetAiStaminaFrac();
            if (comboLibrary != null && staminaFrac <= comboLibrary.abortIfAiStaminaBelow)
            {
                SetAbort(AbortReason.StaminaAbortThreshold,
                    $"Stamina abort: frac={staminaFrac:0.00} <= {comboLibrary.abortIfAiStaminaBelow:0.00}");
                break;
            }

            float distX = GetDistanceX();
            if (comboLibrary != null && opponent != null)
            {
                float pad = comboLibrary.abortIfOutOfRangePadding;
                if (distX < (combo.idealMinRange - pad) || distX > (combo.idealMaxRange + pad))
                {
                    SetAbort(AbortReason.OutOfRangeDrift,
                        $"Range drift abort: distX={distX:0.00} ideal=[{combo.idealMinRange:0.00},{combo.idealMaxRange:0.00}] pad={pad:0.00}");
                    break;
                }
            }

            SetCurrentStepSnapshot(i, step, staminaFrac, distX);

            Log($"STEP {i + 1}/{combo.steps.Count}: {(step.isFeint ? "FEINT " : "")}{step.punch} region={step.intendedRegion} delay={step.delayAfter:0.00}");
            ThrowStep(step);

            float wait = Mathf.Max(0.01f, step.delayAfter);
            float wt = 0f;
            if (debugToInspector)
            {
                debugState.currentStepDelayTotal = wait;
                debugState.currentStepDelayRemaining = wait;
            }
            while (wt < wait)
            {
                if (controller == null || controller.stats == null)
                {
                    SetAbort(AbortReason.NullControllerOrStats, "Controller/stats lost during wait.");
                    wt = wait;
                    break;
                }
                if (controller.stats.IsExhausted)
                {
                    SetAbort(AbortReason.ExhaustedDuringWait, "Exhausted during wait.");
                    wt = wait;
                    break;
                }
                if (controller.isFrozenByKD)
                {
                    SetAbort(AbortReason.KnockedDownFrozen, "Frozen by KD during wait.");
                    wt = wait;
                    break;
                }
                wt += Time.deltaTime;
                if (debugToInspector)
                {
                    debugState.aiStaminaFrac = GetAiStaminaFrac();
                    debugState.distanceToOpponentX = GetDistanceX();
                    debugState.currentStepDelayRemaining = Mathf.Max(0f, wait - wt);
                }
                yield return null;
            }

            if (debugState.lastAbortReason != AbortReason.None &&
                debugState.lastAbortReason != AbortReason.ManualStop)
            {
                break;
            }
        }
        FinishAttempt();
    }
    void FinishAttempt()
    {
        if (dataBank != null)
            dataBank.EndComboAttempt();
        runningCombo = false;
        comboRoutine = null;
        hasScheduledStart = false;
        scheduledStartDelay = 0f;
        scheduledTargetFrame = -1;
        UpdateInspectorRunning(false);
        if (debugState.lastAbortReason == AbortReason.None)
            Log("END: Combo completed.");
        else
            Log($"END: Combo stopped. reason={debugState.lastAbortReason} note={debugState.lastAbortNote}");
    }
    void UpdateInspectorRunning(bool isRunning)
    {
        if (!debugToInspector) return;
        debugState.isRunning = isRunning;
    }
    void SetAbort(AbortReason reason, string note)
    {
        if (!debugToInspector)
        {
            if (debugToConsole && reason != AbortReason.None)
                Debug.Log($"[AiComboRunner] Abort: {reason} - {note}", this);
            return;
        }
        if (debugState.lastAbortReason == AbortReason.None)
        {
            debugState.lastAbortReason = reason;
            debugState.lastAbortNote = note;
        }
    }
    void SetCurrentStepSnapshot(int idx, AiComboLibrary.ComboStep step, float staminaFrac, float distX)
    {
        if (!debugToInspector) return;
        debugState.currentStepIndex = idx;
        debugState.aiStaminaFrac = staminaFrac;
        debugState.distanceToOpponentX = distX;
        debugState.currentStep = new StepSnapshot
        {
            index = idx,
            punch = step.punch,
            isFeint = step.isFeint,
            intendedRegion = step.intendedRegion,
            delayAfter = step.delayAfter
        };
    }
    float GetAiStaminaFrac()
    {
        if (controller == null || controller.stats == null) return 0f;
        float max = Mathf.Max(1f, controller.stats.maxStamina);
        return Mathf.Clamp01(controller.stats.currentStamina / max);
    }
    float GetDistanceX()
    {
        if (controller == null) return 999f;
        if (opponent == null) return 999f;
        return Mathf.Abs(opponent.position.x - controller.transform.position.x);
    }
    void Log(string msg)
    {
        if (debugToInspector)
        {
            if (debugState.recentLog == null)
                debugState.recentLog = new List<string>();
            debugState.recentLog.Add(msg);
            if (maxLogEntries >= 0 && debugState.recentLog.Count > maxLogEntries)
            {
                int remove = debugState.recentLog.Count - maxLogEntries;
                debugState.recentLog.RemoveRange(0, remove);
            }
        }
        if (debugToConsole)
            Debug.Log("[AiComboRunner] " + msg, this);
    }
    void ThrowStep(AiComboLibrary.ComboStep step)
    {
        if (controller == null) return;
        if (step.isFeint) ThrowFeint(step.punch);
        else ThrowPunch(step.punch);
    }
    void ThrowFeint(FistHitbox.PunchType punch)
    {
        if (controller == null) return;
        switch (punch)
        {
            case FistHitbox.PunchType.Jab: controller.leftFist.StartFeint(FistHitbox.PunchType.Jab); break;
            case FistHitbox.PunchType.Cross: controller.rightFist.StartFeint(FistHitbox.PunchType.Cross); break;
            case FistHitbox.PunchType.LeftHook: controller.leftFist.StartFeint(FistHitbox.PunchType.LeftHook); break;
            case FistHitbox.PunchType.RightHook: controller.rightFist.StartFeint(FistHitbox.PunchType.RightHook); break;
            case FistHitbox.PunchType.LeftUppercut: controller.leftFist.StartFeint(FistHitbox.PunchType.LeftUppercut); break;
            case FistHitbox.PunchType.RightUppercut: controller.rightFist.StartFeint(FistHitbox.PunchType.RightUppercut); break;
        }
    }
    void ThrowPunch(FistHitbox.PunchType punch)
    {
        if (controller == null) return;
        switch (punch)
        {
            case FistHitbox.PunchType.Jab: controller.leftFist.StartPunch(FistHitbox.PunchType.Jab); break;
            case FistHitbox.PunchType.Cross: controller.rightFist.StartPunch(FistHitbox.PunchType.Cross); break;
            case FistHitbox.PunchType.LeftHook: controller.leftFist.StartPunch(FistHitbox.PunchType.LeftHook); break;
            case FistHitbox.PunchType.RightHook: controller.rightFist.StartPunch(FistHitbox.PunchType.RightHook); break;
            case FistHitbox.PunchType.LeftUppercut: controller.leftFist.StartPunch(FistHitbox.PunchType.LeftUppercut); break;
            case FistHitbox.PunchType.RightUppercut: controller.rightFist.StartPunch(FistHitbox.PunchType.RightUppercut); break;
        }
    }
    float EstimateLeadTime(FistHitbox.PunchType punch)
    {
        switch (punch)
        {
            case FistHitbox.PunchType.Jab: return Mathf.Max(0.01f, jabLeadTime);
            case FistHitbox.PunchType.Cross: return Mathf.Max(0.01f, crossLeadTime);
            case FistHitbox.PunchType.LeftHook:
            case FistHitbox.PunchType.RightHook:
                return Mathf.Max(0.01f, hookLeadTime);
            case FistHitbox.PunchType.LeftUppercut:
            case FistHitbox.PunchType.RightUppercut:
                return Mathf.Max(0.01f, upperLeadTime);
        }
        return 0.2f;
    }
}
