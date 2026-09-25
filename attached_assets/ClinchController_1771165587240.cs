using UnityEngine;
using System.Collections;
[DisallowMultipleComponent]
public class ClinchController : MonoBehaviour
{
    [Header("References")]
    public FighterController fighter;          // auto-filled
    public DefenseController defense;          // auto-filled
    public Transform opponent;                 // uses FighterController.opponent if null
    [Header("Clinch Start (Player Input)")]
    [Tooltip("Player double-taps clinchKey to attempt clinch.")]
    public KeyCode clinchKey = KeyCode.T;
    [Tooltip("Max seconds between taps to count as a double-tap.")]
    public float doubleTapWindow = 0.25f;
    [Tooltip("If true, prints why clinch didn't start (out of range, missing refs, etc.).")]
    public bool debugClinchInput = false;
    [Header("Clinch Chance / Stats (Inspector)")]
    [Tooltip("If enabled, clinch start is probabilistic (useful for AI + anti-spam). Set baseClinchChance=1 to mimic old behavior.")]
    public bool useClinchChance = true;
    [Tooltip("Base success chance when in range. Set to 1.0 to preserve old always-success behavior.")]
    [Range(0f, 1f)] public float baseClinchChance = 1.0f;
    [Tooltip("Initiator skill multiplier (1 = neutral). >1 makes clinch more likely.")]
    [Range(0.25f, 2.5f)] public float initiatorClinchSkillMult = 1.0f;
    [Tooltip("Defender resistance multiplier (1 = neutral). >1 makes clinch less likely.")]
    [Range(0.25f, 2.5f)] public float defenderClinchResistMult = 1.0f;
    [Tooltip("Extra multiplier based on how close you are within START range (x-axis is normalized distance: 0=touching, 1=at start range).")]
    public AnimationCurve distanceChanceMultiplier = AnimationCurve.Linear(0f, 1.15f, 1f, 1.0f);
    [Tooltip("Cooldown after ANY clinch attempt (success OR fail), per fighter.")]
    public float clinchAttemptCooldown = 0.35f;
    [Tooltip("If true, initiator/defender multipliers are taken from their respective ClinchController fields (so each fighter can have different clinch skill/resist).")]
    public bool useOpponentResistanceFromTheirController = true;
    [Header("Optional Stamina Costs (default 0 = no change)")]
    [Tooltip("Stamina cost applied to INITIATOR when a clinch successfully starts.")]
    public float clinchStartStaminaCost = 0f;
    [Tooltip("Stamina drained per second while clinched. Applied to BOTH fighters by default.")]
    public float clinchHoldStaminaDrainPerSecond = 0f;
    [Tooltip("If false, only the initiator pays the hold drain.")]
    public bool holdDrainAffectsBoth = true;
    [Header("Clinch Stamina Regen Multipliers (NEW)")]
    [Tooltip("How long the special clinch-start regen bonuses last for BOTH fighters.")]
    public float clinchBonusWindowSeconds = 3f;
    [Tooltip("Initiator (the one who started the clinch) regen multiplier during the bonus window.")]
    public float starterRegenMultFirstWindow = 3.0f;
    [Tooltip("Opponent (the one getting clinched) regen multiplier during the bonus window.")]
    public float opponentRegenMultFirstWindow = 1.2f;
    [Tooltip("After the bonus window, BOTH fighters regen at this multiplier while clinched (editable).")]
    public float bothRegenMultAfterWindow = 0.5f;
    [Header("Clinch Range / Units")]
    [Tooltip("If true, clinch range uses blocks. Otherwise uses world units.")]
    public bool useBlocks = true;
    [Tooltip("How many world units equal 1 block.")]
    public float worldUnitsPerBlock = 1f;
    [Tooltip("Max distance to START clinch (in blocks if useBlocks, else world units).")]
    public float clinchStartRange = 0.5f;
    [Tooltip("Max distance allowed while clinched BEFORE it breaks (in blocks if useBlocks, else world units).")]
    public float clinchBreakRange = 0.75f;
    [Tooltip("Target spacing once clinched (in blocks if useBlocks, else world units).")]
    public float clinchTargetDistance = 0.4f;
    [Header("Slide / Push Into Clinch")]
    [Tooltip("Delay before the slide begins (so it feels like a push, not teleport).")]
    public float slideDelay = 0.06f;
    [Tooltip("How long the slide takes.")]
    public float slideDuration = 0.12f;
    [Tooltip("Easing for slide-in (higher = snappier at start).")]
    [Range(1f, 6f)] public float slideEase = 3f;
    [Header("Ring Edge Behavior")]
    [Tooltip("If a fighter is at/over this X (absolute), we do the edge behavior: only the other fighter shifts.")]
    public float ringEdgeAbsX = 7.4f;
    [Header("Defense Effects While Clinched")]
    [Tooltip("Head drops down by this many blocks/world units while clinched.")]
    public float clinchHeadDown = 0.2f;
    [Tooltip("Head and fists offset forward by this many blocks/world units while clinched.")]
    public float clinchForward = 0.1f;
    [Tooltip("Transition time for head/fist offsets when clinch STARTS.")]
    public float clinchVisualTransition = 0.10f;
    [Tooltip("Transition time for head/fist offsets when clinch ENDS. Set 0 for instant snap-back.")]
    public float clinchEndTransition = 0f;
    [Tooltip("Blocking is more effective by this multiplier while clinched.")]
    public float clinchBlockEffectivenessMult = 1.5f;
    private bool isClinching = false;
    private bool iStartedThisClinch = false;
    private float clinchStartTime = -999f; // ✅ NEW: shared timestamp when clinch begins
    private float lastTapTime = -999f;
    private int tapCount = 0;
    private ClinchController opponentClinch;
    private Coroutine clinchRoutine;
    private float nextAttemptAllowedTime = 0f;
    public bool IsClinching => isClinching;
    public bool IStartedThisClinch => iStartedThisClinch;
    public float GetCurrentClinchRegenMultiplier()
    {
        if (!isClinching) return 1f;
        float t = Time.time - clinchStartTime;
        float window = Mathf.Max(0f, clinchBonusWindowSeconds);
        if (t <= window)
        {
            return iStartedThisClinch ? Mathf.Max(0f, starterRegenMultFirstWindow)
                                      : Mathf.Max(0f, opponentRegenMultFirstWindow);
        }
        return Mathf.Max(0f, bothRegenMultAfterWindow);
    }
    void Awake()
    {
        if (fighter == null) fighter = GetComponent<FighterController>();
        if (defense == null) defense = GetComponent<DefenseController>();
        RefreshOpponentReference();
    }
    void OnValidate()
    {
        doubleTapWindow = Mathf.Max(0.05f, doubleTapWindow);
        worldUnitsPerBlock = Mathf.Max(0.0001f, worldUnitsPerBlock);
        clinchStartRange = Mathf.Max(0.01f, clinchStartRange);
        clinchBreakRange = Mathf.Max(clinchStartRange, clinchBreakRange);
        clinchTargetDistance = Mathf.Max(0.01f, clinchTargetDistance);
        slideDelay = Mathf.Max(0f, slideDelay);
        slideDuration = Mathf.Max(0.0001f, slideDuration);
        slideEase = Mathf.Clamp(slideEase, 1f, 6f);
        clinchVisualTransition = Mathf.Max(0f, clinchVisualTransition);
        clinchEndTransition = Mathf.Max(0f, clinchEndTransition);
        clinchBlockEffectivenessMult = Mathf.Max(0.01f, clinchBlockEffectivenessMult);
        clinchAttemptCooldown = Mathf.Max(0f, clinchAttemptCooldown);
        clinchStartStaminaCost = Mathf.Max(0f, clinchStartStaminaCost);
        clinchHoldStaminaDrainPerSecond = Mathf.Max(0f, clinchHoldStaminaDrainPerSecond);
        clinchBonusWindowSeconds = Mathf.Max(0f, clinchBonusWindowSeconds);
        starterRegenMultFirstWindow = Mathf.Max(0f, starterRegenMultFirstWindow);
        opponentRegenMultFirstWindow = Mathf.Max(0f, opponentRegenMultFirstWindow);
        bothRegenMultAfterWindow = Mathf.Max(0f, bothRegenMultAfterWindow);
        if (distanceChanceMultiplier == null)
            distanceChanceMultiplier = AnimationCurve.Linear(0f, 1.15f, 1f, 1.0f);
    }
    void OnDisable()
    {
        if (isClinching) ForceEndClinch(immediate: true);
    }
    void Update()
    {
        if (fighter == null) return;
        RefreshOpponentReference();
        if (opponent == null) return;
        if (isClinching)
        {
            ApplyHoldStaminaDrain(Time.deltaTime);
            if (!IsOpponentWithinRange(clinchBreakRange))
            {
                if (debugClinchInput) Debug.Log("[ClinchController] Clinch broke: out of break range.", this);
                ForceEndClinch(immediate: true);
            }
            return;
        }
        if (!fighter.isPlayerControlled) return;
        HandleClinchInput_Player();
    }
    void RefreshOpponentReference()
    {
        if (fighter != null && (opponent == null))
            opponent = fighter.opponent;
        if (fighter != null && fighter.opponent != null)
            opponent = fighter.opponent;
    }
    void HandleClinchInput_Player()
    {
        if (!Input.GetKeyDown(clinchKey)) return;
        float now = Time.time;
        if (now - lastTapTime > doubleTapWindow)
            tapCount = 0;
        tapCount++;
        lastTapTime = now;
        if (tapCount >= 2)
        {
            tapCount = 0;
            AttemptStartClinchAsInitiator();
        }
    }
    public void AttemptStartClinchAsInitiator()
    {
        if (fighter == null)
        {
            if (debugClinchInput) Debug.Log("[ClinchController] Can't clinch: fighter ref missing.", this);
            return;
        }
        if (Time.time < nextAttemptAllowedTime)
        {
            if (debugClinchInput) Debug.Log("[ClinchController] Can't clinch: attempt cooldown.", this);
            return;
        }
        RefreshOpponentReference();
        if (opponent == null)
        {
            if (debugClinchInput) Debug.Log("[ClinchController] Can't clinch: opponent ref missing.", this);
            return;
        }
        if (isClinching) return;
        if (!IsOpponentWithinRange(clinchStartRange))
        {
            if (debugClinchInput) Debug.Log("[ClinchController] Can't clinch: out of START range.", this);
            return;
        }
        opponentClinch = opponent.GetComponentInParent<ClinchController>();
        if (opponentClinch == null)
        {
            Debug.LogWarning("[ClinchController] Opponent has no ClinchController. Add it to both fighters.", this);
            return;
        }
        opponentClinch.RefreshOpponentReference();
        if (opponentClinch.isClinching)
        {
            if (debugClinchInput) Debug.Log("[ClinchController] Can't clinch: opponent already clinching.", this);
            return;
        }
        if (useClinchChance)
        {
            float chance = ComputeClinchSuccessChance();
            float roll = Random.value;
            nextAttemptAllowedTime = Time.time + Mathf.Max(0f, clinchAttemptCooldown);
            if (roll > Mathf.Clamp01(chance))
            {
                if (debugClinchInput) Debug.Log($"[ClinchController] Clinch FAILED (roll={roll:0.00} > chance={chance:0.00}).", this);
                return;
            }
        }
        else
        {
            nextAttemptAllowedTime = Time.time + Mathf.Max(0f, clinchAttemptCooldown);
        }
        opponentClinch.opponentClinch = this;
        if (clinchRoutine != null) StopCoroutine(clinchRoutine);
        clinchRoutine = StartCoroutine(BeginClinchRoutine());
    }
    float ComputeClinchSuccessChance()
    {
        float chance = Mathf.Clamp01(baseClinchChance);
        float atk = Mathf.Clamp(initiatorClinchSkillMult, 0.01f, 10f);
        float def = defenderClinchResistMult;
        if (useOpponentResistanceFromTheirController && opponentClinch != null)
            def = opponentClinch.defenderClinchResistMult;
        def = Mathf.Clamp(def, 0.01f, 10f);
        float dist = Mathf.Abs(opponent.position.x - transform.position.x);
        float max = clinchStartRange * (useBlocks ? worldUnitsPerBlock : 1f);
        float norm = (max > 0.0001f) ? Mathf.Clamp01(dist / max) : 1f;
        float distMult = (distanceChanceMultiplier != null) ? Mathf.Max(0f, distanceChanceMultiplier.Evaluate(norm)) : 1f;
        chance *= atk;
        chance *= distMult;
        chance /= def;
        return Mathf.Clamp01(chance);
    }
    bool IsOpponentWithinRange(float range)
    {
        if (opponent == null) return false;
        float dx = Mathf.Abs(opponent.position.x - transform.position.x);
        float max = range;
        if (useBlocks)
            max *= worldUnitsPerBlock;
        return dx <= max;
    }
    IEnumerator BeginClinchRoutine()
    {
        isClinching = true;
        iStartedThisClinch = true;
        clinchStartTime = Time.time;
        if (opponentClinch != null)
        {
            opponentClinch.isClinching = true;
            opponentClinch.iStartedThisClinch = false;
            opponentClinch.opponentClinch = this;
            opponentClinch.clinchStartTime = clinchStartTime;
        }
        ApplyDefenseClinchEffects(this, active: true, transitionOverride: clinchVisualTransition);
        ApplyDefenseClinchEffects(opponentClinch, active: true, transitionOverride: clinchVisualTransition);
        ApplyStartStaminaCost();
        yield return new WaitForSeconds(Mathf.Max(0f, slideDelay));
        if (!isClinching) yield break;
        yield return SlideFightersToTargetDistance();
        if (isClinching && !IsOpponentWithinRange(clinchBreakRange))
            ForceEndClinch(immediate: true);
        clinchRoutine = null;
    }
    void ApplyStartStaminaCost()
    {
        if (clinchStartStaminaCost <= 0f) return;
        FighterStats fs = (fighter != null) ? fighter.GetComponent<FighterStats>() : null;
        if (fs == null) return;
        fs.currentStamina = Mathf.Max(0f, fs.currentStamina - clinchStartStaminaCost);
    }
    void ApplyHoldStaminaDrain(float dt)
    {
        if (clinchHoldStaminaDrainPerSecond <= 0f) return;
        if (!isClinching) return;
        FighterStats fsA = (fighter != null) ? fighter.GetComponent<FighterStats>() : null;
        if (fsA != null)
            fsA.currentStamina = Mathf.Max(0f, fsA.currentStamina - clinchHoldStaminaDrainPerSecond * dt);
        if (!holdDrainAffectsBoth) return;
        if (opponentClinch != null && opponentClinch.fighter != null)
        {
            FighterStats fsB = opponentClinch.fighter.GetComponent<FighterStats>();
            if (fsB != null)
                fsB.currentStamina = Mathf.Max(0f, fsB.currentStamina - clinchHoldStaminaDrainPerSecond * dt);
        }
    }
    void ApplyDefenseClinchEffects(ClinchController cc, bool active, float transitionOverride)
    {
        if (cc == null || cc.defense == null) return;
        float headDown = clinchHeadDown;
        float forward = clinchForward;
        if (useBlocks)
        {
            float u = worldUnitsPerBlock;
            headDown *= u;
            forward *= u;
        }
        float t = Mathf.Max(0f, transitionOverride);
        cc.defense.SetClinchState(
            active: active,
            headDownWorld: headDown,
            forwardWorld: forward,
            transitionTime: t,
            blockEffectivenessMult: clinchBlockEffectivenessMult
        );
    }
    IEnumerator SlideFightersToTargetDistance()
    {
        if (fighter == null || opponentClinch == null || opponentClinch.fighter == null)
            yield break;
        Rigidbody2D rbA = fighter.GetComponent<Rigidbody2D>();
        Rigidbody2D rbB = opponentClinch.fighter.GetComponent<Rigidbody2D>();
        if (rbA == null || rbB == null) yield break;
        Vector2 startA = rbA.position;
        Vector2 startB = rbB.position;
        float targetDist = clinchTargetDistance;
        if (useBlocks)
            targetDist *= worldUnitsPerBlock;
        bool aLeftOfB = startA.x <= startB.x;
        float sign = aLeftOfB ? 1f : -1f;
        float mid = (startA.x + startB.x) * 0.5f;
        float half = targetDist * 0.5f;
        float desiredAx = mid - half * sign;
        float desiredBx = mid + half * sign;
        bool aAtEdge = Mathf.Abs(startA.x) >= ringEdgeAbsX;
        bool bAtEdge = Mathf.Abs(startB.x) >= ringEdgeAbsX;
        float minX = fighter.ringMinX;
        float maxX = fighter.ringMaxX;
        minX = Mathf.Max(minX, opponentClinch.fighter.ringMinX);
        maxX = Mathf.Min(maxX, opponentClinch.fighter.ringMaxX);
        if (aAtEdge && !bAtEdge)
        {
            desiredAx = startA.x;
            float dirTowardA = Mathf.Sign(startA.x - startB.x);
            desiredBx = startA.x - dirTowardA * targetDist;
        }
        else if (bAtEdge && !aAtEdge)
        {
            desiredBx = startB.x;
            float dirTowardB = Mathf.Sign(startB.x - startA.x);
            desiredAx = startB.x - dirTowardB * targetDist;
        }
        else if (aAtEdge && bAtEdge)
        {
            yield break;
        }
        desiredAx = Mathf.Clamp(desiredAx, minX, maxX);
        desiredBx = Mathf.Clamp(desiredBx, minX, maxX);
        Vector2 endA = new Vector2(desiredAx, startA.y);
        Vector2 endB = new Vector2(desiredBx, startB.y);
        float dur = Mathf.Max(0.0001f, slideDuration);
        float t = 0f;
        while (t < 1f)
        {
            if (!isClinching) yield break;
            t += Time.deltaTime / dur;
            float tt = Mathf.Clamp01(t);
            float eased = EaseInOut(tt, slideEase);
            Vector2 posA = Vector2.Lerp(startA, endA, eased);
            Vector2 posB = Vector2.Lerp(startB, endB, eased);
            rbA.MovePosition(posA);
            rbB.MovePosition(posB);
            yield return null;
        }
        rbA.MovePosition(endA);
        rbB.MovePosition(endB);
    }
    static float EaseInOut(float t, float k)
    {
        t = Mathf.Clamp01(t);
        float s = t * t * (3f - 2f * t);
        return Mathf.Pow(s, 1f / Mathf.Max(0.01f, k));
    }
    public void ForceEndClinch() => ForceEndClinch(immediate: true);
    void ForceEndClinch(bool immediate)
    {
        if (!isClinching) return;
        isClinching = false;
        iStartedThisClinch = false;
        clinchStartTime = -999f;
        if (clinchRoutine != null)
        {
            StopCoroutine(clinchRoutine);
            clinchRoutine = null;
        }
        float endT = immediate ? 0f : clinchEndTransition;
        ApplyDefenseClinchEffects(this, active: false, transitionOverride: endT);
        if (opponentClinch != null)
        {
            opponentClinch.isClinching = false;
            opponentClinch.iStartedThisClinch = false;
            opponentClinch.clinchStartTime = -999f;
            if (opponentClinch.clinchRoutine != null)
            {
                opponentClinch.StopCoroutine(opponentClinch.clinchRoutine);
                opponentClinch.clinchRoutine = null;
            }
            opponentClinch.ApplyDefenseClinchEffects(opponentClinch, active: false, transitionOverride: endT);
            opponentClinch.opponentClinch = null;
        }
        opponentClinch = null;
    }
}
