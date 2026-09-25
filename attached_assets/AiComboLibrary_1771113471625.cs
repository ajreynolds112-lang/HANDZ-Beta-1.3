using UnityEngine;
using System;
using System.Collections.Generic;
#if UNITY_EDITOR
using UnityEditor;
#endif
/// <summary>
/// Stores premade combos and generates dynamic combos.
/// Also owns:
/// - Combo Grammar (legal sequences + constraints)
/// - Parameter list (tunable behaviors)
/// - Scoring weights (how combo success is evaluated)
/// - State table (context -> style weights)
///
/// AiBrain will request combos from here.
/// AiComboRunner will execute them.
/// AiActionDataBank will score and remember performance.
///
/// Attach this to the AI fighter root (same object as AiBrain / AiActionDataBank).
/// </summary>
[ExecuteAlways]
public class AiComboLibrary : MonoBehaviour
{



    [System.Serializable]
    public class ComboStep
    {
        public FistHitbox.PunchType punch;
        public float delayAfter;          // time before next step
        public bool isFeint;              // if true, call StartFeint on fist
        public AiActionDataBank.HitRegion intendedRegion; // for tracking/analysis only
    }
    [System.Serializable]
    public class AiCombo
    {
        public string name;
        public string id; // stable signature id (used by databank scoring)
        public List<ComboStep> steps = new List<ComboStep>();
        public float idealMinRange = 0.7f;  // in blocks
        public float idealMaxRange = 1.6f;  // in blocks
        public bool isDynamic;              // generated at runtime
    }
    [Header("Preset Combos (Inspector Editable)")]
    [SerializeField] public List<AiCombo> presetCombos = new List<AiCombo>();



    public enum RangeBucket { Long, Mid, Close }
    public enum Phase { Download, Probe, Pressure, BodyHunt, WhiffPunish, Finish, Panic }
    public enum OppDefenseProfile { Unknown, HighBlockHeavy, LowBlockHeavy, DuckHeavy, Shelling, HandsDown }
    public enum OppAggressionBand { Low, Medium, High }
    [System.Serializable]
    public struct ComboContext
    {
        public float distanceBlocks;
        public RangeBucket rangeBucket;
        public float aiStaminaFrac;
        public float oppStaminaFrac;
        public float aiMomentum01;
        public float oppAggression01;
        public OppDefenseProfile defenseProfile;
        public Phase phase;
        public bool punishWindow; // whiff punish / hard read window
    }



    [Header("Editor / Debug")]
    [Tooltip("If true, auto-build default preset combos in EDIT MODE when list is empty.")]
    public bool autoBuildPresetsInEditor = true;
    [Tooltip("If true, record generated combos (runtime) into the inspector for debugging (Play Mode).")]
    public bool recordGeneratedCombosInPlay = true;
    [Range(0, 50)]
    public int maxRecordedGeneratedCombos = 12;
    [SerializeField] private List<AiCombo> generatedCombosDebug = new List<AiCombo>();



    [Header("Difficulty Scaling (from LevelSelect / GameConfig)")]
    [Tooltip("If true, uses GameConfig.Instance.enemyDifficulty to scale Dynamic Combo chance + Jab Doctrine.")]
    public bool useDifficultyFromGameConfig = true;
    [Tooltip("Treats DifficultyBand 0..3 (Journeyman..Champion) as 0..1 scaling.")]
    [SerializeField] private bool debugPrintDifficulty = false;
    [Header("Dynamic Combo Chance (scaled by difficulty)")]
    [Tooltip("Dynamic combo chance on Easy/Journeyman (DifficultyBand 0).")]
    [Range(0f, 1f)] public float dynamicChanceEasy = 0.25f;
    [Tooltip("Dynamic combo chance on Hardcore/Champion (DifficultyBand 3).")]
    [Range(0f, 1f)] public float dynamicChanceHardcore = 0.80f;
    [Tooltip("Extra multiplier for dynamic chance during Explore states (keeps 'explore' meaningful without forcing chaos).")]
    [Range(0.5f, 1.5f)] public float exploreDynamicMult = 1.0f;
    [Header("Jab Doctrine (scaled by difficulty)")]
    [Tooltip("Jab doctrine chance on Easy/Journeyman (DifficultyBand 0).")]
    [Range(0f, 1f)] public float jabDoctrineEasy = 0.20f;
    [Tooltip("Jab doctrine chance on Hardcore/Champion (DifficultyBand 3).")]
    [Range(0f, 1f)] public float jabDoctrineHardcore = 0.50f;
    [Tooltip("If true, jabStartProbability is overridden by Jab Doctrine scaling (easy->hardcore).")]
    public bool overrideJabStartProbabilityWithDoctrine = true;
    [Header("Prefer Clean Hits Over Volume (seeded personality)")]
    [Tooltip("If true, preferCleanHitOverVolume is driven by a stable per-AI seed (more defensive/counterpunchy at higher values).")]
    public bool seedCleanPreference = true;
    [Tooltip("Min seeded clean-hit preference (more volume-y / messy).")]
    [Range(0f, 1f)] public float cleanPrefMin = 0.20f;
    [Tooltip("Max seeded clean-hit preference (more defensive / counterpunchy).")]
    [Range(0f, 1f)] public float cleanPrefMax = 0.80f;
    [Tooltip("How strongly clean preference pushes toward shorter combos and punish starters (0 = no effect).")]
    [Range(0f, 1f)] public float cleanPreferenceInfluence = 0.65f;



    [Header("Grammar & Generation Parameters")]
    [Range(0f, 1f)] public float jabStartProbability = 0.95f; // can be overridden by doctrine scaling
    [Range(0f, 1f)] public float feintStartProbability = 0.25f; // chance entry is jab-feint instead of jab
    [Range(0f, 1f)] public float insertFeintProbability = 0.12f; // chance insert a feint mid-combo (only if legal)
    [Range(2, 7)] public int minComboLen = 2;
    [Range(2, 7)] public int maxComboLen = 5;
    [Header("Range Buckets (blocks)")]
    public float closeMax = 1.0f;
    public float midMax = 1.6f;
    [Header("Delays (seconds)")]
    public float longMinDelay = 0.24f;
    public float longMaxDelay = 0.40f;
    public float closeMinDelay = 0.18f;
    public float closeMaxDelay = 0.32f;
    public float punishDelayMult = 0.80f;   // faster hands in punish windows
    public float finishDelayMult = 0.85f;   // faster hands when finishing
    [Header("Abort / Safety Constraints (runner may enforce)")]
    [Range(0f, 1f)] public float abortIfAiStaminaBelow = 0.08f; // if stamina too low mid-combo, stop
    [Range(0f, 2f)] public float abortIfOutOfRangePadding = 0.20f; // allow small range drift
    [Tooltip("Influences internal style: higher = more selective, shorter, more punish/counter style.")]
    [Range(0f, 1f)] public float preferCleanHitOverVolume = 0.75f; // now optionally seeded
    [Header("Mutation & Exploration")]
    [Range(0f, 1f)] public float exploreProbabilityDownload = 0.45f;
    [Range(0f, 1f)] public float exploreProbabilityProbe = 0.30f;
    [Range(0f, 1f)] public float exploreProbabilityPressure = 0.12f;
    [Range(0f, 1f)] public float exploreProbabilityFinish = 0.08f;

    [Range(0f, 1f)] public float dynamicComboChanceWhenNoPresets = 0.65f;
    [Range(0f, 1f)] public float dynamicComboChanceEvenIfPresets = 0.18f;
    [Header("Jab Doctrine Helpers")]
    [Range(0f, 1f)] public float doubleJabChanceWhenUnsure = 0.22f;
    [Range(0f, 1f)] public float jabToBodyChanceWhenHighBlock = 0.18f; // informational only (region tag)
    [Range(0f, 1f)] public float shiftToBodyWhenDuckHeavy = 0.45f;     // informational only (region tag)



    [Header("Combo Scoring Weights")]
    public float w_cleanDamageDealt = 1.10f;
    public float w_totalDamageDealt = 0.35f;
    public float w_damageTaken = 1.25f;
    public float w_whiffs = 0.55f;
    public float w_blockedHits = 0.18f;
    public float w_forcedReactionBonus = 0.25f; // later hook from AiBrain (optional)
    public float w_finishBonus = 0.25f;         // extra weight when opponent low stamina
    public float w_punishBonus = 0.35f;



    [System.Serializable]
    public class StateBias
    {
        [Range(0f, 1f)] public float preferBody = 0.30f;
        [Range(0f, 1f)] public float preferHead = 0.70f;
        [Range(0f, 1f)] public float preferShortCombos = 0.55f;
        [Range(0f, 1f)] public float preferLongCombos = 0.45f;
        [Range(0f, 1f)] public float preferFeints = 0.25f;
        [Range(0f, 1f)] public float preferPowerShots = 0.25f; // hooks/uppers
        [Range(0f, 1f)] public float preferStraightShots = 0.75f; // jab/cross
    }
    private readonly Dictionary<string, StateBias> stateTable = new Dictionary<string, StateBias>();



    private TimeBasedRNG rng;
    private AiActionDataBank dataBank;

    [SerializeField, HideInInspector] private float cachedSeed01 = -1f;

    private float EffectiveDifficulty01 => GetDifficulty01();
    private float EffectiveCleanPreference01 => GetEffectiveCleanPreference01();
    private float EffectiveDynamicComboChance01 => GetEffectiveDynamicComboChance01();
    private float EffectiveJabDoctrine01 => GetEffectiveJabDoctrine01();
    void Awake()
    {
        SafeInitRefs();
        EnsureStateTable();
        EnsurePresetsBuiltIfNeeded();
        EnsureStableIds();
        EnsureSeedCached();
    }
    void OnEnable()
    {
        SafeInitRefs();
        EnsureStateTable();
        EnsurePresetsBuiltIfNeeded();
        EnsureStableIds();
        EnsureSeedCached();
    }
    void OnValidate()
    {
        dynamicChanceEasy = Mathf.Clamp01(dynamicChanceEasy);
        dynamicChanceHardcore = Mathf.Clamp01(dynamicChanceHardcore);
        jabDoctrineEasy = Mathf.Clamp01(jabDoctrineEasy);
        jabDoctrineHardcore = Mathf.Clamp01(jabDoctrineHardcore);
        cleanPrefMin = Mathf.Clamp01(cleanPrefMin);
        cleanPrefMax = Mathf.Clamp01(cleanPrefMax);
        if (cleanPrefMax < cleanPrefMin) cleanPrefMax = cleanPrefMin;
        cleanPreferenceInfluence = Mathf.Clamp01(cleanPreferenceInfluence);
        if (!Application.isPlaying && autoBuildPresetsInEditor)
        {
            EnsureStateTable();
            EnsurePresetsBuiltIfNeeded();
            EnsureStableIds();
#if UNITY_EDITOR
            EditorUtility.SetDirty(this);
#endif
        }
    }
    void SafeInitRefs()
    {
        if (rng == null) rng = GetComponent<TimeBasedRNG>();
        if (dataBank == null) dataBank = GetComponent<AiActionDataBank>();
    }
    void EnsureStateTable()
    {
        if (stateTable.Count == 0)
            BuildStateTableDefaults();
    }
    void EnsurePresetsBuiltIfNeeded()
    {
        if (presetCombos == null)
            presetCombos = new List<AiCombo>();
        if (presetCombos.Count == 0)
            BuildDefaultCombos();
    }
    void EnsureStableIds()
    {
        if (presetCombos == null) return;
        foreach (var c in presetCombos)
        {
            if (c == null) continue;
            if (string.IsNullOrEmpty(c.id))
                c.id = MakeComboIdFromSteps(c);
        }
    }
    void EnsureSeedCached()
    {


        if (cachedSeed01 >= 0f && cachedSeed01 <= 1f) return;


        float s = TryGetSeed01FromRng();
        if (s < 0f)
        {

            int h = (gameObject.scene.name + "|" + gameObject.name).GetHashCode();
            uint uh = (uint)h;
            s = (uh % 10000u) / 9999f;
        }
        cachedSeed01 = Mathf.Clamp01(s);
    }
    float TryGetSeed01FromRng()
    {
        if (rng == null) return -1f;





        return -1f;
    }



    float GetDifficulty01()
    {
        if (!useDifficultyFromGameConfig) return 1f / 3f; // default ~Normal
        if (GameConfig.Instance == null) return 1f / 3f;

        int band = Mathf.Clamp((int)GameConfig.Instance.enemyDifficulty, 0, 3);
        float d01 = band / 3f;
        if (debugPrintDifficulty && Application.isPlaying)
            Debug.Log($"[AiComboLibrary] DifficultyBand={band} => d01={d01:0.00}", this);
        return d01;
    }
    float GetEffectiveDynamicComboChance01()
    {
        float d01 = EffectiveDifficulty01;
        float chance = Mathf.Lerp(dynamicChanceEasy, dynamicChanceHardcore, d01);
        return Mathf.Clamp01(chance);
    }
    float GetEffectiveJabDoctrine01()
    {
        float d01 = EffectiveDifficulty01;
        float doctrine = Mathf.Lerp(jabDoctrineEasy, jabDoctrineHardcore, d01);
        return Mathf.Clamp01(doctrine);
    }
    float GetEffectiveCleanPreference01()
    {
        if (!seedCleanPreference)
            return Mathf.Clamp01(preferCleanHitOverVolume);
        EnsureSeedCached();
        float seeded = Mathf.Lerp(cleanPrefMin, cleanPrefMax, Mathf.Clamp01(cachedSeed01));
        return Mathf.Clamp01(seeded);
    }



    [ContextMenu("Rebuild Default Preset Combos")]
    public void Context_RebuildDefaultPresets()
    {
        BuildDefaultCombos();
        EnsureStableIds();
#if UNITY_EDITOR
        EditorUtility.SetDirty(this);
#endif
    }
    [ContextMenu("Clear Preset Combos")]
    public void Context_ClearPresets()
    {
        presetCombos = new List<AiCombo>();
#if UNITY_EDITOR
        EditorUtility.SetDirty(this);
#endif
    }
    [ContextMenu("Clear Generated Combo Debug List")]
    public void Context_ClearGeneratedDebug()
    {
        generatedCombosDebug.Clear();
#if UNITY_EDITOR
        EditorUtility.SetDirty(this);
#endif
    }



    void BuildStateTableDefaults()
    {
        stateTable.Clear();
        void Put(Phase p, RangeBucket r, Action<StateBias> edit)
        {
            var b = new StateBias();
            edit?.Invoke(b);
            stateTable[Key(p, r)] = b;
        }

        Put(Phase.Download, RangeBucket.Long, b =>
        {
            b.preferHead = 0.75f; b.preferBody = 0.25f;
            b.preferShortCombos = 0.70f; b.preferLongCombos = 0.30f;
            b.preferFeints = 0.35f;
            b.preferStraightShots = 0.88f; b.preferPowerShots = 0.12f;
        });
        Put(Phase.Download, RangeBucket.Mid, b =>
        {
            b.preferHead = 0.70f; b.preferBody = 0.30f;
            b.preferShortCombos = 0.65f; b.preferLongCombos = 0.35f;
            b.preferFeints = 0.32f;
            b.preferStraightShots = 0.80f; b.preferPowerShots = 0.20f;
        });
        Put(Phase.Download, RangeBucket.Close, b =>
        {
            b.preferHead = 0.55f; b.preferBody = 0.45f;
            b.preferShortCombos = 0.70f; b.preferLongCombos = 0.30f;
            b.preferFeints = 0.22f;
            b.preferStraightShots = 0.60f; b.preferPowerShots = 0.40f;
        });

        Put(Phase.Pressure, RangeBucket.Long, b =>
        {
            b.preferHead = 0.70f; b.preferBody = 0.30f;
            b.preferShortCombos = 0.45f; b.preferLongCombos = 0.55f;
            b.preferFeints = 0.18f;
            b.preferStraightShots = 0.80f; b.preferPowerShots = 0.20f;
        });
        Put(Phase.Pressure, RangeBucket.Mid, b =>
        {
            b.preferHead = 0.60f; b.preferBody = 0.40f;
            b.preferShortCombos = 0.40f; b.preferLongCombos = 0.60f;
            b.preferFeints = 0.15f;
            b.preferStraightShots = 0.68f; b.preferPowerShots = 0.32f;
        });
        Put(Phase.Pressure, RangeBucket.Close, b =>
        {
            b.preferHead = 0.48f; b.preferBody = 0.52f;
            b.preferShortCombos = 0.50f; b.preferLongCombos = 0.50f;
            b.preferFeints = 0.10f;
            b.preferStraightShots = 0.50f; b.preferPowerShots = 0.50f;
        });

        Put(Phase.BodyHunt, RangeBucket.Long, b =>
        {
            b.preferHead = 0.55f; b.preferBody = 0.45f;
            b.preferShortCombos = 0.55f; b.preferLongCombos = 0.45f;
            b.preferFeints = 0.18f;
            b.preferStraightShots = 0.78f; b.preferPowerShots = 0.22f;
        });
        Put(Phase.BodyHunt, RangeBucket.Mid, b =>
        {
            b.preferHead = 0.40f; b.preferBody = 0.60f;
            b.preferShortCombos = 0.45f; b.preferLongCombos = 0.55f;
            b.preferFeints = 0.14f;
            b.preferStraightShots = 0.62f; b.preferPowerShots = 0.38f;
        });
        Put(Phase.BodyHunt, RangeBucket.Close, b =>
        {
            b.preferHead = 0.30f; b.preferBody = 0.70f;
            b.preferShortCombos = 0.50f; b.preferLongCombos = 0.50f;
            b.preferFeints = 0.08f;
            b.preferStraightShots = 0.48f; b.preferPowerShots = 0.52f;
        });

        Put(Phase.WhiffPunish, RangeBucket.Long, b =>
        {
            b.preferHead = 0.80f; b.preferBody = 0.20f;
            b.preferShortCombos = 0.80f; b.preferLongCombos = 0.20f;
            b.preferFeints = 0.08f;
            b.preferStraightShots = 0.92f; b.preferPowerShots = 0.08f;
        });
        Put(Phase.WhiffPunish, RangeBucket.Mid, b =>
        {
            b.preferHead = 0.75f; b.preferBody = 0.25f;
            b.preferShortCombos = 0.78f; b.preferLongCombos = 0.22f;
            b.preferFeints = 0.06f;
            b.preferStraightShots = 0.88f; b.preferPowerShots = 0.12f;
        });
        Put(Phase.WhiffPunish, RangeBucket.Close, b =>
        {
            b.preferHead = 0.55f; b.preferBody = 0.45f;
            b.preferShortCombos = 0.75f; b.preferLongCombos = 0.25f;
            b.preferFeints = 0.06f;
            b.preferStraightShots = 0.70f; b.preferPowerShots = 0.30f;
        });

        Put(Phase.Finish, RangeBucket.Long, b =>
        {
            b.preferHead = 0.75f; b.preferBody = 0.25f;
            b.preferShortCombos = 0.62f; b.preferLongCombos = 0.38f;
            b.preferFeints = 0.08f;
            b.preferStraightShots = 0.78f; b.preferPowerShots = 0.22f;
        });
        Put(Phase.Finish, RangeBucket.Mid, b =>
        {
            b.preferHead = 0.60f; b.preferBody = 0.40f;
            b.preferShortCombos = 0.55f; b.preferLongCombos = 0.45f;
            b.preferFeints = 0.06f;
            b.preferStraightShots = 0.62f; b.preferPowerShots = 0.38f;
        });
        Put(Phase.Finish, RangeBucket.Close, b =>
        {
            b.preferHead = 0.45f; b.preferBody = 0.55f;
            b.preferShortCombos = 0.65f; b.preferLongCombos = 0.35f;
            b.preferFeints = 0.04f;
            b.preferStraightShots = 0.45f; b.preferPowerShots = 0.55f;
        });

        Put(Phase.Panic, RangeBucket.Long, b =>
        {
            b.preferHead = 0.80f; b.preferBody = 0.20f;
            b.preferShortCombos = 0.92f; b.preferLongCombos = 0.08f;
            b.preferFeints = 0.05f;
            b.preferStraightShots = 0.95f; b.preferPowerShots = 0.05f;
        });
        Put(Phase.Panic, RangeBucket.Mid, b =>
        {
            b.preferHead = 0.75f; b.preferBody = 0.25f;
            b.preferShortCombos = 0.92f; b.preferLongCombos = 0.08f;
            b.preferFeints = 0.05f;
            b.preferStraightShots = 0.92f; b.preferPowerShots = 0.08f;
        });
        Put(Phase.Panic, RangeBucket.Close, b =>
        {
            b.preferHead = 0.55f; b.preferBody = 0.45f;
            b.preferShortCombos = 0.92f; b.preferLongCombos = 0.08f;
            b.preferFeints = 0.03f;
            b.preferStraightShots = 0.82f; b.preferPowerShots = 0.18f;
        });

        Put(Phase.Probe, RangeBucket.Long, b =>
        {
            b.preferHead = 0.72f; b.preferBody = 0.28f;
            b.preferShortCombos = 0.68f; b.preferLongCombos = 0.32f;
            b.preferFeints = 0.28f;
            b.preferStraightShots = 0.85f; b.preferPowerShots = 0.15f;
        });
        Put(Phase.Probe, RangeBucket.Mid, b =>
        {
            b.preferHead = 0.65f; b.preferBody = 0.35f;
            b.preferShortCombos = 0.62f; b.preferLongCombos = 0.38f;
            b.preferFeints = 0.25f;
            b.preferStraightShots = 0.78f; b.preferPowerShots = 0.22f;
        });
        Put(Phase.Probe, RangeBucket.Close, b =>
        {
            b.preferHead = 0.52f; b.preferBody = 0.48f;
            b.preferShortCombos = 0.62f; b.preferLongCombos = 0.38f;
            b.preferFeints = 0.18f;
            b.preferStraightShots = 0.60f; b.preferPowerShots = 0.40f;
        });
    }
    static string Key(Phase p, RangeBucket r) => p.ToString() + "_" + r.ToString();



    void BuildDefaultCombos()
    {
        presetCombos = new List<AiCombo>();
        presetCombos.Add(new AiCombo
        {
            name = "DoubleJabCross",
            idealMinRange = 1.0f,
            idealMaxRange = 1.6f,
            steps = new List<ComboStep>
            {
                new ComboStep{ punch = FistHitbox.PunchType.Jab, delayAfter = 0.22f, isFeint = false, intendedRegion = AiActionDataBank.HitRegion.Head },
                new ComboStep{ punch = FistHitbox.PunchType.Jab, delayAfter = 0.20f, isFeint = false, intendedRegion = AiActionDataBank.HitRegion.Head },
                new ComboStep{ punch = FistHitbox.PunchType.Cross, delayAfter = 0.35f, isFeint = false, intendedRegion = AiActionDataBank.HitRegion.Head }
            }
        });
        presetCombos.Add(new AiCombo
        {
            name = "JabHookHook",
            idealMinRange = 1.1f,
            idealMaxRange = 1.5f,
            steps = new List<ComboStep>
            {
                new ComboStep{ punch = FistHitbox.PunchType.Jab, delayAfter = 0.20f, isFeint = false, intendedRegion = AiActionDataBank.HitRegion.Head },
                new ComboStep{ punch = FistHitbox.PunchType.LeftHook, delayAfter = 0.28f, isFeint = false, intendedRegion = AiActionDataBank.HitRegion.Head },
                new ComboStep{ punch = FistHitbox.PunchType.RightHook, delayAfter = 0.35f, isFeint = false, intendedRegion = AiActionDataBank.HitRegion.Head }
            }
        });
        presetCombos.Add(new AiCombo
        {
            name = "CrossHookCross",
            idealMinRange = 1.0f,
            idealMaxRange = 1.4f,
            steps = new List<ComboStep>
            {
                new ComboStep{ punch = FistHitbox.PunchType.Cross, delayAfter = 0.25f, isFeint = false, intendedRegion = AiActionDataBank.HitRegion.Head },
                new ComboStep{ punch = FistHitbox.PunchType.LeftHook, delayAfter = 0.30f, isFeint = false, intendedRegion = AiActionDataBank.HitRegion.Head },
                new ComboStep{ punch = FistHitbox.PunchType.Cross, delayAfter = 0.35f, isFeint = false, intendedRegion = AiActionDataBank.HitRegion.Head }
            }
        });
        presetCombos.Add(new AiCombo
        {
            name = "UppercutHookCross",
            idealMinRange = 0.5f,
            idealMaxRange = 1.0f,
            steps = new List<ComboStep>
            {
                new ComboStep{ punch = FistHitbox.PunchType.RightUppercut, delayAfter = 0.28f, isFeint = false, intendedRegion = AiActionDataBank.HitRegion.Body },
                new ComboStep{ punch = FistHitbox.PunchType.LeftHook, delayAfter = 0.26f, isFeint = false, intendedRegion = AiActionDataBank.HitRegion.Head },
                new ComboStep{ punch = FistHitbox.PunchType.Cross, delayAfter = 0.35f, isFeint = false, intendedRegion = AiActionDataBank.HitRegion.Head }
            }
        });
        presetCombos.Add(new AiCombo
        {
            name = "FastFour",
            idealMinRange = 1.0f,
            idealMaxRange = 1.6f,
            steps = new List<ComboStep>
            {
                new ComboStep{ punch = FistHitbox.PunchType.Jab, delayAfter = 0.15f, isFeint = false, intendedRegion = AiActionDataBank.HitRegion.Head },
                new ComboStep{ punch = FistHitbox.PunchType.Cross, delayAfter = 0.15f, isFeint = false, intendedRegion = AiActionDataBank.HitRegion.Head },
                new ComboStep{ punch = FistHitbox.PunchType.LeftHook, delayAfter = 0.18f, isFeint = false, intendedRegion = AiActionDataBank.HitRegion.Head },
                new ComboStep{ punch = FistHitbox.PunchType.RightHook, delayAfter = 0.20f, isFeint = false, intendedRegion = AiActionDataBank.HitRegion.Head }
            }
        });
    }



    public RangeBucket GetRangeBucket(float distanceBlocks)
    {
        if (distanceBlocks <= closeMax) return RangeBucket.Close;
        if (distanceBlocks <= midMax) return RangeBucket.Mid;
        return RangeBucket.Long;
    }
    public StateBias GetBias(Phase phase, RangeBucket rangeBucket)
    {
        if (stateTable.TryGetValue(Key(phase, rangeBucket), out var b) && b != null)
            return b;
        return new StateBias();
    }
    public ComboContext BuildContext(
        float distanceBlocks,
        float aiStaminaFrac,
        float oppStaminaFrac,
        float aiMomentum01,
        float oppAggression01,
        OppDefenseProfile defenseProfile,
        Phase phase,
        bool punishWindow)
    {
        ComboContext ctx = new ComboContext
        {
            distanceBlocks = distanceBlocks,
            rangeBucket = GetRangeBucket(distanceBlocks),
            aiStaminaFrac = Mathf.Clamp01(aiStaminaFrac),
            oppStaminaFrac = Mathf.Clamp01(oppStaminaFrac),
            aiMomentum01 = Mathf.Clamp01(aiMomentum01),
            oppAggression01 = Mathf.Clamp01(oppAggression01),
            defenseProfile = defenseProfile,
            phase = phase,
            punishWindow = punishWindow
        };
        return ctx;
    }



    public AiCombo GetRandomComboForRange(float distance)
    {
        ComboContext ctx = BuildContext(
            distanceBlocks: distance,
            aiStaminaFrac: 1f,
            oppStaminaFrac: 1f,
            aiMomentum01: 0.5f,
            oppAggression01: 0.5f,
            defenseProfile: OppDefenseProfile.Unknown,
            phase: Phase.Probe,
            punishWindow: false);
        return RequestCombo(ctx);
    }



    public AiCombo RequestCombo(ComboContext ctx)
    {
        List<AiCombo> validPresets = GetPresetsForRange(ctx.distanceBlocks);
        bool explore = ShouldExplore(ctx);

        float dynChance = EffectiveDynamicComboChance01;
        if (explore) dynChance *= exploreDynamicMult;
        dynChance = Mathf.Clamp01(dynChance);

        dynamicComboChanceWhenNoPresets = dynChance;
        dynamicComboChanceEvenIfPresets = dynChance;
        bool forceDynamic = (validPresets.Count == 0 && Next01() < dynChance);
        bool allowDynamicEvenIfPresets = (validPresets.Count > 0 && Next01() < dynChance);
        if (forceDynamic || explore || allowDynamicEvenIfPresets)
        {
            var dyn = GenerateDynamicCombo(ctx);
            RecordGeneratedIfWanted(dyn);
            return dyn;
        }
        return SelectBestPreset(validPresets, ctx);
    }
    void RecordGeneratedIfWanted(AiCombo c)
    {
        if (!Application.isPlaying) return;
        if (!recordGeneratedCombosInPlay) return;
        if (c == null) return;
        generatedCombosDebug.Add(CloneCombo(c));
        if (maxRecordedGeneratedCombos >= 0 && generatedCombosDebug.Count > maxRecordedGeneratedCombos)
        {
            int remove = generatedCombosDebug.Count - maxRecordedGeneratedCombos;
            generatedCombosDebug.RemoveRange(0, remove);
        }
    }
    AiCombo CloneCombo(AiCombo src)
    {
        AiCombo c = new AiCombo();
        c.name = src.name;
        c.id = src.id;
        c.idealMinRange = src.idealMinRange;
        c.idealMaxRange = src.idealMaxRange;
        c.isDynamic = src.isDynamic;
        c.steps = new List<ComboStep>();
        if (src.steps != null)
        {
            foreach (var s in src.steps)
            {
                c.steps.Add(new ComboStep
                {
                    punch = s.punch,
                    delayAfter = s.delayAfter,
                    isFeint = s.isFeint,
                    intendedRegion = s.intendedRegion
                });
            }
        }
        return c;
    }
    bool ShouldExplore(ComboContext ctx)
    {
        float p = 0.0f;
        switch (ctx.phase)
        {
            case Phase.Download: p = exploreProbabilityDownload; break;
            case Phase.Probe: p = exploreProbabilityProbe; break;
            case Phase.Pressure: p = exploreProbabilityPressure; break;
            case Phase.Finish: p = exploreProbabilityFinish; break;
            default: p = 0.10f; break;
        }

        float clean01 = EffectiveCleanPreference01;
        float cleanExploreMult = Mathf.Lerp(1.0f, 0.70f, clean01 * cleanPreferenceInfluence);
        p *= cleanExploreMult;
        if (ctx.phase == Phase.Panic || ctx.aiStaminaFrac < 0.15f)
            p *= 0.35f;
        return Next01() < p;
    }
    List<AiCombo> GetPresetsForRange(float distanceBlocks)
    {
        List<AiCombo> valid = new List<AiCombo>();
        if (presetCombos == null) return valid;
        foreach (var combo in presetCombos)
        {
            if (combo == null) continue;
            if (distanceBlocks >= combo.idealMinRange && distanceBlocks <= combo.idealMaxRange)
                valid.Add(combo);
        }
        return valid;
    }
    AiCombo SelectBestPreset(List<AiCombo> presets, ComboContext ctx)
    {
        if (presets == null || presets.Count == 0)
        {
            var dyn = GenerateDynamicCombo(ctx);
            RecordGeneratedIfWanted(dyn);
            return dyn;
        }
        if (dataBank == null)
            return presets[UnityEngine.Random.Range(0, presets.Count)];
        float bestScore = float.NegativeInfinity;
        AiCombo best = null;
        float clean01 = EffectiveCleanPreference01;
        foreach (var c in presets)
        {
            float perf = dataBank.GetComboPerformanceScore(c.id, ctx);

            perf += (Next01() - 0.5f) * 0.05f;


            if (cleanPreferenceInfluence > 0f && c.steps != null)
            {
                float lenPenalty = Mathf.InverseLerp(2f, 5f, Mathf.Clamp(c.steps.Count, 2, 5)); // 0 short -> 1 long
                float cleanLenBias = Mathf.Lerp(0.0f, -0.12f, clean01 * cleanPreferenceInfluence) * lenPenalty;
                perf += cleanLenBias;
            }
            if (perf > bestScore)
            {
                bestScore = perf;
                best = c;
            }
        }
        return best != null ? best : presets[UnityEngine.Random.Range(0, presets.Count)];
    }



    public AiCombo GenerateDynamicCombo(ComboContext ctx)
    {
        AiCombo c = new AiCombo();
        c.isDynamic = true;
        int len = ChooseLength(ctx);
        StateBias bias = GetBias(ctx.phase, ctx.rangeBucket);
        float clean01 = EffectiveCleanPreference01;

        float doctrine = EffectiveJabDoctrine01;

        float jabStartP = overrideJabStartProbabilityWithDoctrine ? doctrine : jabStartProbability;



        float punishCleanStarterShift = Mathf.Lerp(0f, 0.22f, clean01 * cleanPreferenceInfluence);
        bool startWithJab = (Next01() < jabStartP) || ctx.punishWindow == false;
        bool startWithFeint = startWithJab && (Next01() < Mathf.Clamp01(feintStartProbability * bias.preferFeints + (clean01 * 0.10f)));
        if (ctx.punishWindow)
        {

            if (Next01() < punishCleanStarterShift)
                startWithJab = false;
            if (Next01() < 0.25f)
            {
                startWithJab = (Next01() < 0.60f);
                startWithFeint = false;
            }
        }
        float preferBody = bias.preferBody;
        preferBody = ApplyDefenseProfileBodyShift(preferBody, ctx.defenseProfile);
        if (startWithJab)
        {
            AddStep(c, FistHitbox.PunchType.Jab, MakeDelay(ctx), startWithFeint, PickRegion(preferBody));

            bool unsure = (ctx.phase == Phase.Download || ctx.phase == Phase.Probe || ctx.aiMomentum01 < 0.50f);
            float doctrineDoubleJabBoost = Mathf.Lerp(0f, 0.12f, doctrine);
            float doubleJabP = Mathf.Clamp01(doubleJabChanceWhenUnsure + doctrineDoubleJabBoost);
            if (unsure && Next01() < doubleJabP && c.steps.Count < len)
            {
                AddStep(c, FistHitbox.PunchType.Jab, MakeDelay(ctx), false, PickRegion(preferBody));
            }
        }
        else
        {
            var start = PickPunishStarter(ctx);
            AddStep(c, start, MakeDelay(ctx), false, AiActionDataBank.HitRegion.Head);
        }
        while (c.steps.Count < len)
        {


            float feintP = insertFeintProbability * bias.preferFeints;
            feintP *= Mathf.Lerp(1.0f, 0.80f, clean01 * cleanPreferenceInfluence);
            bool wantFeint = (Next01() < Mathf.Clamp01(feintP));
            if (wantFeint)
            {
                var ft = (Next01() < 0.85f) ? FistHitbox.PunchType.Jab : FistHitbox.PunchType.Cross;
                AddStep(c, ft, MakeDelay(ctx), true, PickRegion(preferBody));
                continue;
            }
            FistHitbox.PunchType next = PickNextPunchByGrammar(c, ctx, bias);
            AddStep(c, next, MakeDelay(ctx), false, PickRegion(preferBody));
        }
        ApplyRangeEnvelope(c, ctx);
        c.name = "Dynamic_" + UnityEngine.Random.Range(1000, 9999);
        c.id = MakeComboIdFromSteps(c);
        return c;
    }
    int ChooseLength(ComboContext ctx)
    {
        StateBias bias = GetBias(ctx.phase, ctx.rangeBucket);
        int minL = Mathf.Clamp(minComboLen, 2, 7);
        int maxL = Mathf.Clamp(maxComboLen, minL, 7);
        if (ctx.phase == Phase.Panic || ctx.aiStaminaFrac < 0.20f)
            maxL = Mathf.Min(maxL, 3);
        if (ctx.phase == Phase.Finish && ctx.aiStaminaFrac > 0.25f)
            maxL = Mathf.Min(5, maxL);

        float clean01 = EffectiveCleanPreference01;
        float cleanShortBoost = Mathf.Lerp(0f, 0.30f, clean01 * cleanPreferenceInfluence); // boosts short bias up to +0.30
        float shortBias = Mathf.Clamp01(bias.preferShortCombos + cleanShortBoost);
        float r = Next01();
        if (r < shortBias)
            return UnityEngine.Random.Range(minL, Mathf.Min(minL + 2, maxL) + 1);
        return UnityEngine.Random.Range(Mathf.Max(minL + 1, 3), maxL + 1);
    }
    float ApplyDefenseProfileBodyShift(float preferBody, OppDefenseProfile prof)
    {
        switch (prof)
        {
            case OppDefenseProfile.HighBlockHeavy:
            case OppDefenseProfile.Shelling:
                preferBody = Mathf.Clamp01(preferBody + jabToBodyChanceWhenHighBlock);
                break;
            case OppDefenseProfile.DuckHeavy:
                preferBody = Mathf.Clamp01(preferBody + shiftToBodyWhenDuckHeavy);
                break;
        }
        return preferBody;
    }
    AiActionDataBank.HitRegion PickRegion(float preferBody)
    {
        return (Next01() < preferBody) ? AiActionDataBank.HitRegion.Body : AiActionDataBank.HitRegion.Head;
    }
    FistHitbox.PunchType PickPunishStarter(ComboContext ctx)
    {
        if (ctx.rangeBucket == RangeBucket.Close)
            return (Next01() < 0.50f) ? FistHitbox.PunchType.RightUppercut : FistHitbox.PunchType.LeftHook;
        return (Next01() < 0.65f) ? FistHitbox.PunchType.Cross : FistHitbox.PunchType.Jab;
    }
    FistHitbox.PunchType PickNextPunchByGrammar(AiCombo combo, ComboContext ctx, StateBias bias)
    {
        FistHitbox.PunchType last = combo.steps[combo.steps.Count - 1].punch;
        int repeats = CountTrailingRepeats(combo, last);
        bool close = ctx.rangeBucket == RangeBucket.Close;
        bool lng = ctx.rangeBucket == RangeBucket.Long;
        if (repeats >= 2)
        {
            if (last == FistHitbox.PunchType.Jab) return FistHitbox.PunchType.Cross;
            if (last == FistHitbox.PunchType.Cross) return FistHitbox.PunchType.LeftHook;
            return FistHitbox.PunchType.Jab;
        }
        float clean01 = EffectiveCleanPreference01;
        float straightW = bias.preferStraightShots;
        float powerW = bias.preferPowerShots;
        if (lng)
        {
            straightW = Mathf.Clamp01(straightW + 0.18f);
            powerW = Mathf.Clamp01(powerW - 0.18f);
        }
        else if (close)
        {
            straightW = Mathf.Clamp01(straightW - 0.18f);
            powerW = Mathf.Clamp01(powerW + 0.18f);
        }

        float cleanStraightBoost = Mathf.Lerp(0f, 0.12f, clean01 * cleanPreferenceInfluence);
        float cleanPowerDrop = Mathf.Lerp(0f, 0.10f, clean01 * cleanPreferenceInfluence);
        straightW = Mathf.Clamp01(straightW + cleanStraightBoost);
        powerW = Mathf.Clamp01(powerW - cleanPowerDrop);
        if (last == FistHitbox.PunchType.Jab && Next01() < 0.60f)
            return FistHitbox.PunchType.Cross;
        List<FistHitbox.PunchType> cand = new List<FistHitbox.PunchType>();
        cand.Add(FistHitbox.PunchType.Jab);
        if (Next01() < straightW)
            cand.Add(FistHitbox.PunchType.Cross);
        if (close || ctx.punishWindow || ctx.rangeBucket == RangeBucket.Mid)
        {
            if (Next01() < powerW)
            {
                cand.Add(FistHitbox.PunchType.LeftHook);
                if (close) cand.Add(FistHitbox.PunchType.RightHook);
                if (close && Next01() < 0.55f) cand.Add(FistHitbox.PunchType.LeftUppercut);
                if (close && Next01() < 0.55f) cand.Add(FistHitbox.PunchType.RightUppercut);
            }
        }
        if (lng && !ctx.punishWindow)
        {
            cand.Remove(FistHitbox.PunchType.LeftUppercut);
            cand.Remove(FistHitbox.PunchType.RightUppercut);
            if (Next01() < 0.85f)
            {
                cand.Remove(FistHitbox.PunchType.LeftHook);
                cand.Remove(FistHitbox.PunchType.RightHook);
            }
        }
        if (cand.Count == 0)
            return FistHitbox.PunchType.Jab;
        return cand[UnityEngine.Random.Range(0, cand.Count)];
    }
    int CountTrailingRepeats(AiCombo c, FistHitbox.PunchType p)
    {
        int count = 0;
        for (int i = c.steps.Count - 1; i >= 0; i--)
        {
            if (c.steps[i].punch == p) count++;
            else break;
        }
        return count;
    }
    void ApplyRangeEnvelope(AiCombo c, ComboContext ctx)
    {
        if (ctx.rangeBucket == RangeBucket.Close)
        {
            c.idealMinRange = 0.45f;
            c.idealMaxRange = 1.05f;
        }
        else if (ctx.rangeBucket == RangeBucket.Mid)
        {
            c.idealMinRange = 0.95f;
            c.idealMaxRange = 1.55f;
        }
        else
        {
            c.idealMinRange = 1.35f;
            c.idealMaxRange = 2.10f;
        }
    }
    void AddStep(AiCombo c, FistHitbox.PunchType p, float delay, bool feint, AiActionDataBank.HitRegion region)
    {
        c.steps.Add(new ComboStep
        {
            punch = p,
            delayAfter = delay,
            isFeint = feint,
            intendedRegion = region
        });
    }
    float MakeDelay(ComboContext ctx)
    {
        bool close = ctx.rangeBucket == RangeBucket.Close;
        float minD = close ? closeMinDelay : longMinDelay;
        float maxD = close ? closeMaxDelay : longMaxDelay;
        float d = UnityEngine.Random.Range(minD, maxD);
        if (ctx.punishWindow)
            d *= Mathf.Max(0.01f, punishDelayMult);
        if (ctx.phase == Phase.Finish)
            d *= Mathf.Max(0.01f, finishDelayMult);


        float clean01 = EffectiveCleanPreference01;
        float slowMult = Mathf.Lerp(1.0f, 1.08f, clean01 * cleanPreferenceInfluence);
        d *= slowMult;
        return Mathf.Max(0.01f, d);
    }



    public static string MakeComboIdFromSteps(AiCombo c)
    {
        if (c == null || c.steps == null || c.steps.Count == 0)
            return "Combo_Empty";
        System.Text.StringBuilder sb = new System.Text.StringBuilder();
        sb.Append("CB_");
        for (int i = 0; i < c.steps.Count; i++)
        {
            var s = c.steps[i];
            if (s.isFeint) sb.Append("F");
            sb.Append(ShortPunch(s.punch));
            if (i < c.steps.Count - 1) sb.Append("-");
        }
        return sb.ToString();
    }
    static string ShortPunch(FistHitbox.PunchType p)
    {
        switch (p)
        {
            case FistHitbox.PunchType.Jab: return "J";
            case FistHitbox.PunchType.Cross: return "C";
            case FistHitbox.PunchType.LeftHook: return "LH";
            case FistHitbox.PunchType.RightHook: return "RH";
            case FistHitbox.PunchType.LeftUppercut: return "LU";
            case FistHitbox.PunchType.RightUppercut: return "RU";
        }
        return "X";
    }
    float Next01()
    {
        if (rng != null) return rng.Next01();
        return UnityEngine.Random.value;
    }
}
