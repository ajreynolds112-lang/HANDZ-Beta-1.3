using UnityEngine;
using System.Collections.Generic;
/// <summary>
/// Central lightweight memory bank for the AI:
/// - Logs hit events (who hit, head/body, damage)
/// - Logs feint events (in-range vs out-of-range, head/body)
/// - Logs whiff events (who missed, head/body, in-range or not)
/// - Exposes hit summaries (last N hits per side)
/// - Exposes crude momentum (who's winning recent exchanges)
/// - Exposes crude player "aggression" (how active the player is)
/// - Exposes whiff counts in recent time windows
/// - Stores simplified hit-patterns (tempo-based) for the player
///   and exposes pattern matching + forgetting + counter success.
/// - NEW: Tracks combo attempts and learns which combos work in which contexts.
///
/// Attach this to the AI fighter root (same object that has AiBrain).
/// </summary>
public class AiActionDataBank : MonoBehaviour
{
    public enum Actor { Player, Ai }
    public enum HitRegion { Head, Body }
    [System.Serializable]
    public struct HitRecord
    {
        public float time;
        public Actor actor;
        public HitRegion region;
        public float damage;
        public bool inRange;
        public bool cleanHit;     // NEW: optional flag (AiBrain can supply later)
        public bool blockedHit;   // NEW: optional flag (AiBrain can supply later)
    }
    [System.Serializable]
    public struct FeintRecord
    {
        public float time;
        public bool inRange;
        public HitRegion region;
    }
    [System.Serializable]
    public struct WhiffRecord
    {
        public float time;
        public Actor actor;
        public HitRegion region;
        public bool inRange;
    }
    [System.Serializable]
    public struct HitSummary
    {
        public int headHits;
        public int bodyHits;
        public int TotalHits => headHits + bodyHits;
    }



    [System.Serializable]
    public class HitPattern
    {
        public enum PatternKind { Punch, Feint }
        public PatternKind kind;
        public float avgInterval;
        public int eventCount;
        public float lastSeenTime;
        public int successfulCounters;
        public bool locked;
    }
    [System.Serializable]
    private struct OffensiveEvent
    {
        public float time;
        public bool isFeint;
        public bool inRange;
    }



    [System.Serializable]
    public class ComboAttempt
    {
        public bool active;
        public float startTime;
        public float endTime;
        public string comboId;
        public string comboName;
        public bool isDynamic;
        public float idealMinRange;
        public float idealMaxRange;

        public float cleanDamageDealt;
        public float totalDamageDealt;
        public int blockedHitsDealt;
        public int whiffsByAi;
        public float damageTakenDuringAttempt;
        public float score;
    }
    [System.Serializable]
    public class ComboPerf
    {
        public string comboId;
        public int samples;
        public float avgScore;
        public float avgCleanDamage;
        public float avgDamageTaken;
        public float avgWhiffs;
        public float avgBlockedHits;
        public float lastUsedTime;
        public void AddSample(ComboAttempt a)
        {
            samples++;

            avgScore = avgScore + (a.score - avgScore) / samples;
            avgCleanDamage = avgCleanDamage + (a.cleanDamageDealt - avgCleanDamage) / samples;
            avgDamageTaken = avgDamageTaken + (a.damageTakenDuringAttempt - avgDamageTaken) / samples;
            avgWhiffs = avgWhiffs + (a.whiffsByAi - avgWhiffs) / samples;
            avgBlockedHits = avgBlockedHits + (a.blockedHitsDealt - avgBlockedHits) / samples;
            lastUsedTime = Time.time;
        }
    }


    private static string MakePerfKey(AiComboLibrary.ComboContext ctx)
    {
        return ctx.phase.ToString() + "_" + ctx.rangeBucket.ToString() + "_" + ctx.defenseProfile.ToString();
    }

    private readonly Dictionary<string, Dictionary<string, ComboPerf>> comboPerfByContext =
        new Dictionary<string, Dictionary<string, ComboPerf>>();
    private ComboAttempt activeAttempt = null;



    [Header("History Limits")]
    public int maxHitHistory = 200;
    public int maxFeintHistory = 100;
    public int maxWhiffHistory = 120;
    [Header("AI Link (for conditioning / patterns / difficulty)")]
    public AiBrain aiBrain;
    [Header("Hit Pattern Memory")]
    public bool enablePatternMemory = true;
    public int maxHitPatterns = 50;
    public float patternWindowSeconds = 2f;
    public float patternIntervalTolerance = 0.18f;
    [Header("Combo Learning")]
    [Tooltip("How many seconds after BeginComboAttempt to auto-close attempt if EndComboAttempt never called.")]
    public float comboAttemptMaxSeconds = 6f;
    [Tooltip("If true, logs combo scores to console (debug).")]
    public bool debugComboScoring = false;



    private readonly List<HitRecord> recentHits = new List<HitRecord>();
    private readonly List<FeintRecord> recentFeints = new List<FeintRecord>();
    private readonly List<WhiffRecord> recentWhiffs = new List<WhiffRecord>();
    private readonly List<OffensiveEvent> offensiveEvents = new List<OffensiveEvent>();
    private readonly List<HitPattern> hitPatterns = new List<HitPattern>();
    void Awake()
    {
        if (aiBrain == null)
            aiBrain = GetComponent<AiBrain>();
    }
    void Update()
    {

        if (activeAttempt != null && activeAttempt.active)
        {
            if (Time.time - activeAttempt.startTime > comboAttemptMaxSeconds)
            {
                EndComboAttempt();
            }
        }
    }



    /// <summary>
    /// Backwards-compatible overload: logs a hit and assumes inRange = true.
    /// cleanHit/blockedHit unknown -> false.
    /// </summary>
    public void LogHit(Actor actor, HitRegion region, float damage)
    {
        LogHit(actor, region, damage, true, false, false);
    }
    /// <summary>
    /// Backwards-compatible overload: logs a hit + inRange.
    /// </summary>
    public void LogHit(Actor actor, HitRegion region, float damage, bool inRange)
    {
        LogHit(actor, region, damage, inRange, false, false);
    }
    /// <summary>
    /// NEW: Log a hit event with optional clean/blocked flags (AiBrain can supply later).
    /// </summary>
    public void LogHit(Actor actor, HitRegion region, float damage, bool inRange, bool cleanHit, bool blockedHit)
    {
        HitRecord rec = new HitRecord
        {
            time = Time.time,
            actor = actor,
            region = region,
            damage = damage,
            inRange = inRange,
            cleanHit = cleanHit,
            blockedHit = blockedHit
        };
        recentHits.Add(rec);
        if (recentHits.Count > maxHitHistory)
            recentHits.RemoveAt(0);

        if (enablePatternMemory && actor == Actor.Player && inRange)
        {
            OffensiveEvent oe = new OffensiveEvent
            {
                time = rec.time,
                isFeint = false,
                inRange = true
            };
            offensiveEvents.Add(oe);
            PruneOffensiveEvents();
            MaybeBuildPunchPattern();
        }
    }



    public void LogFeint(bool inRange, HitRegion region)
    {
        FeintRecord fr = new FeintRecord
        {
            time = Time.time,
            inRange = inRange,
            region = region
        };
        recentFeints.Add(fr);
        if (recentFeints.Count > maxFeintHistory)
            recentFeints.RemoveAt(0);

        if (aiBrain != null && aiBrain.enableConditioning)
        {
            float feintWeight = Mathf.Max(0f, aiBrain.feintConditionWeight);
            if (inRange)
            {
                if (region == HitRegion.Head)
                    aiBrain.headConditionScore += aiBrain.headHitConditionValue * feintWeight;
                else
                    aiBrain.bodyConditionScore += aiBrain.bodyHitConditionValue * feintWeight;
            }
        }

        if (enablePatternMemory && inRange)
        {
            OffensiveEvent oe = new OffensiveEvent
            {
                time = fr.time,
                isFeint = true,
                inRange = true
            };
            offensiveEvents.Add(oe);
            PruneOffensiveEvents();
            MaybeBuildFeintPattern();
        }
    }



    public void LogWhiff(Actor actor, HitRegion region, bool inRange)
    {
        WhiffRecord wr = new WhiffRecord
        {
            time = Time.time,
            actor = actor,
            region = region,
            inRange = inRange
        };
        recentWhiffs.Add(wr);
        if (recentWhiffs.Count > maxWhiffHistory)
            recentWhiffs.RemoveAt(0);
    }



    /// <summary>
    /// Called by AiComboRunner when it begins executing a combo.
    /// AiBrain will later be able to pass a richer context; for now,
    /// this logs a bounded time window to score outcomes based on hit/whiff logs.
    /// </summary>
    public void BeginComboAttempt(string comboId, string comboName, float idealMinRange, float idealMaxRange, bool isDynamic)
    {

        if (activeAttempt != null && activeAttempt.active)
            EndComboAttempt();
        activeAttempt = new ComboAttempt
        {
            active = true,
            startTime = Time.time,
            comboId = string.IsNullOrEmpty(comboId) ? "Combo_Unknown" : comboId,
            comboName = comboName,
            idealMinRange = idealMinRange,
            idealMaxRange = idealMaxRange,
            isDynamic = isDynamic
        };
    }
    public void AbortActiveComboAttempt()
    {
        if (activeAttempt != null)
            activeAttempt.active = false;
    }
    public void EndComboAttempt()
    {
        if (activeAttempt == null || !activeAttempt.active)
            return;
        activeAttempt.active = false;
        activeAttempt.endTime = Time.time;
        ComputeComboAttemptMetrics(activeAttempt);

        AiComboLibrary lib = GetComponent<AiComboLibrary>();
        if (lib != null)
        {
            activeAttempt.score = ComputeScoreWithLibrary(activeAttempt, lib);
        }
        else
        {
            activeAttempt.score = DefaultScore(activeAttempt);
        }



        StoreComboPerf(activeAttempt, perfKey: "Unknown");
        if (debugComboScoring)
        {
            Debug.Log($"[ComboScore] {activeAttempt.comboName} ({activeAttempt.comboId}) score={activeAttempt.score:F2} " +
                      $"cleanDmg={activeAttempt.cleanDamageDealt:F1} totalDmg={activeAttempt.totalDamageDealt:F1} " +
                      $"taken={activeAttempt.damageTakenDuringAttempt:F1} whiffs={activeAttempt.whiffsByAi} blocked={activeAttempt.blockedHitsDealt}");
        }
    }
    void ComputeComboAttemptMetrics(ComboAttempt a)
    {
        float t0 = a.startTime;
        float t1 = a.endTime;

        float totalDealt = 0f;
        float cleanDealt = 0f;
        int blockedHits = 0;
        for (int i = recentHits.Count - 1; i >= 0; i--)
        {
            var h = recentHits[i];
            if (h.time < t0) break;
            if (h.time > t1) continue;
            if (h.actor == Actor.Ai)
            {
                totalDealt += Mathf.Max(0f, h.damage);

                bool clean = h.cleanHit || (!h.blockedHit);
                if (clean) cleanDealt += Mathf.Max(0f, h.damage);
                if (h.blockedHit) blockedHits++;
            }
        }

        float taken = 0f;
        for (int i = recentHits.Count - 1; i >= 0; i--)
        {
            var h = recentHits[i];
            if (h.time < t0) break;
            if (h.time > t1) continue;
            if (h.actor == Actor.Player)
                taken += Mathf.Max(0f, h.damage);
        }

        int whiffs = 0;
        for (int i = recentWhiffs.Count - 1; i >= 0; i--)
        {
            var w = recentWhiffs[i];
            if (w.time < t0) break;
            if (w.time > t1) continue;
            if (w.actor == Actor.Ai)
                whiffs++;
        }
        a.totalDamageDealt = totalDealt;
        a.cleanDamageDealt = cleanDealt;
        a.damageTakenDuringAttempt = taken;
        a.whiffsByAi = whiffs;
        a.blockedHitsDealt = blockedHits;
    }
    float ComputeScoreWithLibrary(ComboAttempt a, AiComboLibrary lib)
    {

        float score =
            (a.cleanDamageDealt * lib.w_cleanDamageDealt) +
            (a.totalDamageDealt * lib.w_totalDamageDealt) -
            (a.damageTakenDuringAttempt * lib.w_damageTaken) -
            (a.whiffsByAi * lib.w_whiffs) -
            (a.blockedHitsDealt * lib.w_blockedHits);


        if (aiBrain != null && aiBrain.enemyStats != null && aiBrain.enemyStats.maxStamina > 0f)
        {
            float oppFrac = aiBrain.enemyStats.currentStamina / Mathf.Max(1f, aiBrain.enemyStats.maxStamina);
            if (oppFrac <= 0.20f) score += lib.w_finishBonus * (a.cleanDamageDealt * 0.05f + 1f);
        }
        return score;
    }
    float DefaultScore(ComboAttempt a)
    {

        return (a.cleanDamageDealt * 1.0f) + (a.totalDamageDealt * 0.25f) - (a.damageTakenDuringAttempt * 1.25f) - (a.whiffsByAi * 0.5f) - (a.blockedHitsDealt * 0.15f);
    }
    void StoreComboPerf(ComboAttempt a, string perfKey)
    {
        if (string.IsNullOrEmpty(a.comboId))
            return;
        if (!comboPerfByContext.TryGetValue(a.comboId, out var byKey))
        {
            byKey = new Dictionary<string, ComboPerf>();
            comboPerfByContext[a.comboId] = byKey;
        }
        if (!byKey.TryGetValue(perfKey, out var perf))
        {
            perf = new ComboPerf { comboId = a.comboId };
            byKey[perfKey] = perf;
        }
        perf.AddSample(a);
    }
    /// <summary>
    /// AiComboLibrary calls this to rank combos for a given context.
    /// We return a normalized-ish score:
    /// - prefer combos with higher avgScore in this context
    /// - if no samples exist, return 0.5 baseline
    /// </summary>
    public float GetComboPerformanceScore(string comboId, AiComboLibrary.ComboContext ctx)
    {
        if (string.IsNullOrEmpty(comboId))
            return 0.5f;

        string key = MakePerfKey(ctx);
        if (comboPerfByContext.TryGetValue(comboId, out var byKey))
        {
            if (byKey.TryGetValue(key, out var perf))
            {
                return NormalizePerf(perf);
            }

            if (byKey.TryGetValue("Unknown", out var perf2))
            {
                return NormalizePerf(perf2) * 0.85f; // slightly discounted
            }
        }
        return 0.5f;
    }
    float NormalizePerf(ComboPerf perf)
    {



        float v = 0.5f + (perf.avgScore * 0.02f);
        return Mathf.Clamp01(v);
    }
    /// <summary>
    /// Later (when AiBrain exists) it can store results into real context buckets.
    /// Call this after EndComboAttempt() if AiBrain knows the context.
    /// </summary>
    public void StoreLastAttemptIntoContext(AiComboLibrary.ComboContext ctx)
    {






    }



    public HitSummary GetLastHits(Actor actor, int lookbackCount = 3)
    {
        HitSummary summary = new HitSummary();
        if (recentHits.Count == 0 || lookbackCount <= 0)
            return summary;
        int processed = 0;
        for (int i = recentHits.Count - 1; i >= 0 && processed < lookbackCount; i--)
        {
            var rec = recentHits[i];
            if (rec.actor != actor)
                continue;
            processed++;
            if (rec.region == HitRegion.Head)
                summary.headHits++;
            else
                summary.bodyHits++;
        }
        return summary;
    }



    public float GetAiMomentum(float windowSeconds)
    {
        if (windowSeconds <= 0f)
            return 0.5f;
        float now = Time.time;
        int aiHits = 0;
        int playerHits = 0;
        for (int i = recentHits.Count - 1; i >= 0; i--)
        {
            var rec = recentHits[i];
            if (now - rec.time > windowSeconds)
                break;
            if (rec.actor == Actor.Ai)
                aiHits++;
            else
                playerHits++;
        }
        int total = aiHits + playerHits;
        if (total == 0)
            return 0.5f;
        float raw = (aiHits - playerHits) / (float)total; // -1..1
        return Mathf.Clamp01(0.5f + 0.5f * raw);
    }
    public float GetPlayerAggression(float windowSeconds)
    {
        if (windowSeconds <= 0f)
            return 0f;
        float now = Time.time;
        int playerHits = 0;
        for (int i = recentHits.Count - 1; i >= 0; i--)
        {
            var rec = recentHits[i];
            if (now - rec.time > windowSeconds)
                break;
            if (rec.actor == Actor.Player)
                playerHits++;
        }
        return Mathf.Clamp01(playerHits / 10f);
    }



    public int GetWhiffCount(Actor actor, float windowSeconds, bool inRangeOnly)
    {
        if (windowSeconds <= 0f)
            return 0;
        if (recentWhiffs.Count == 0)
            return 0;
        float now = Time.time;
        int count = 0;
        for (int i = recentWhiffs.Count - 1; i >= 0; i--)
        {
            var wr = recentWhiffs[i];
            if (now - wr.time > windowSeconds)
                break;
            if (wr.actor != actor)
                continue;
            if (inRangeOnly && !wr.inRange)
                continue;
            count++;
        }
        return count;
    }



    void PruneOffensiveEvents()
    {
        float cutoff = Time.time - (patternWindowSeconds + 0.5f);
        for (int i = offensiveEvents.Count - 1; i >= 0; i--)
        {
            if (offensiveEvents[i].time < cutoff)
                offensiveEvents.RemoveAt(i);
        }
    }
    bool TryComputeCurrentTempo(bool wantFeints, out float avgInterval, out int eventCount)
    {
        avgInterval = 0f;
        eventCount = 0;
        float now = Time.time;
        float windowStart = now - patternWindowSeconds;
        List<float> times = new List<float>();
        for (int i = offensiveEvents.Count - 1; i >= 0; i--)
        {
            var e = offensiveEvents[i];
            if (e.time < windowStart)
                break;
            if (!e.inRange)
                continue;
            if (e.isFeint != wantFeints)
                continue;
            times.Add(e.time);
        }
        if (times.Count < 2)
            return false;
        times.Sort();
        float sumIntervals = 0f;
        for (int i = 1; i < times.Count; i++)
            sumIntervals += (times[i] - times[i - 1]);
        avgInterval = sumIntervals / (times.Count - 1);
        eventCount = times.Count;
        return true;
    }
    void MaybeBuildPunchPattern()
    {
        if (!enablePatternMemory || aiBrain == null)
            return;
        float now = Time.time;
        float windowStart = now - patternWindowSeconds;
        float avgInterval;
        int eventCount;
        if (!TryComputeCurrentTempo(false, out avgInterval, out eventCount))
            return;
        int hitsInWindow = 0;
        for (int i = recentHits.Count - 1; i >= 0; i--)
        {
            var rec = recentHits[i];
            if (rec.time < windowStart)
                break;
            if (rec.actor == Actor.Player && rec.inRange)
                hitsInWindow++;
        }
        int threshold = 3;
        float storeChance = 0.3f;
        switch (aiBrain.difficultyBand)
        {
            case AiBrain.DifficultyBand.Easy:
                threshold = 3; storeChance = 0.3f; break;
            case AiBrain.DifficultyBand.Medium:
                threshold = 3; storeChance = 0.5f; break;
            case AiBrain.DifficultyBand.Hard:
                threshold = 4; storeChance = 0.8f; break;
        }
        if (hitsInWindow < threshold)
            return;
        float roll = (aiBrain.rng != null) ? aiBrain.rng.Next01() : Random.value;
        if (roll > storeChance)
            return;
        for (int i = 0; i < hitPatterns.Count; i++)
        {
            var p = hitPatterns[i];
            if (p.kind != HitPattern.PatternKind.Punch)
                continue;
            float diff = Mathf.Abs(p.avgInterval - avgInterval);
            if (diff < patternIntervalTolerance * 0.5f)
            {
                p.lastSeenTime = now;
                hitPatterns[i] = p;
                return;
            }
        }
        HitPattern newPat = new HitPattern
        {
            kind = HitPattern.PatternKind.Punch,
            avgInterval = avgInterval,
            eventCount = eventCount,
            lastSeenTime = now,
            successfulCounters = 0,
            locked = false
        };
        hitPatterns.Add(newPat);
        if (hitPatterns.Count > maxHitPatterns)
            DropOldestNonLockedPattern();
    }
    void MaybeBuildFeintPattern()
    {
        if (!enablePatternMemory || aiBrain == null)
            return;
        float now = Time.time;
        float avgInterval;
        int eventCount;
        if (!TryComputeCurrentTempo(true, out avgInterval, out eventCount))
            return;
        float storeChance = 0.5f;
        float roll = (aiBrain.rng != null) ? aiBrain.rng.Next01() : Random.value;
        if (roll > storeChance)
            return;
        for (int i = 0; i < hitPatterns.Count; i++)
        {
            var p = hitPatterns[i];
            if (p.kind != HitPattern.PatternKind.Feint)
                continue;
            float diff = Mathf.Abs(p.avgInterval - avgInterval);
            if (diff < patternIntervalTolerance * 0.5f)
            {
                p.lastSeenTime = now;
                hitPatterns[i] = p;
                return;
            }
        }
        HitPattern newPat = new HitPattern
        {
            kind = HitPattern.PatternKind.Feint,
            avgInterval = avgInterval,
            eventCount = eventCount,
            lastSeenTime = now,
            successfulCounters = 0,
            locked = false
        };
        hitPatterns.Add(newPat);
        if (hitPatterns.Count > maxHitPatterns)
            DropOldestNonLockedPattern();
    }
    void DropOldestNonLockedPattern()
    {
        int oldestIdx = -1;
        float oldestTime = float.MaxValue;
        for (int i = 0; i < hitPatterns.Count; i++)
        {
            if (hitPatterns[i].locked)
                continue;
            if (hitPatterns[i].lastSeenTime < oldestTime)
            {
                oldestTime = hitPatterns[i].lastSeenTime;
                oldestIdx = i;
            }
        }
        if (oldestIdx >= 0)
            hitPatterns.RemoveAt(oldestIdx);
        else
            hitPatterns.RemoveAt(0);
    }



    public void TickPatternForgetting(AiBrain.DifficultyBand difficulty, float staminaFraction)
    {
        if (!enablePatternMemory)
            return;
        if (hitPatterns.Count == 0)
            return;
        float chanceHigh;
        float chanceLow;
        switch (difficulty)
        {
            case AiBrain.DifficultyBand.Easy:
                chanceHigh = 0.20f;
                chanceLow = 0.70f;
                break;
            case AiBrain.DifficultyBand.Hard:
                chanceHigh = 0.01f;
                chanceLow = 0.20f;
                break;
            default:
                chanceHigh = 0.10f;
                chanceLow = 0.40f;
                break;
        }
        float chance = (staminaFraction > 0.5f) ? chanceHigh : chanceLow;
        if (chance <= 0f)
            return;
        float roll = (aiBrain != null && aiBrain.rng != null) ? aiBrain.rng.Next01() : Random.value;
        if (roll > chance)
            return;
        List<int> candidates = new List<int>();
        for (int i = 0; i < hitPatterns.Count; i++)
        {
            if (!hitPatterns[i].locked)
                candidates.Add(i);
        }
        if (candidates.Count == 0)
            return;
        int idx = candidates[Random.Range(0, candidates.Count)];
        hitPatterns.RemoveAt(idx);
    }
    public bool TryGetCurrentPatternMatch(float windowSeconds, out int patternIndex, out HitPattern pattern)
    {
        patternIndex = -1;
        pattern = null;
        if (!enablePatternMemory || hitPatterns.Count == 0)
            return false;
        float avgPunchInterval;
        int punchCount;
        bool havePunchTempo = TryComputeCurrentTempo(false, out avgPunchInterval, out punchCount);
        float avgFeintInterval;
        int feintCount;
        bool haveFeintTempo = TryComputeCurrentTempo(true, out avgFeintInterval, out feintCount);
        if (!havePunchTempo && !haveFeintTempo)
            return false;
        bool preferFeint = !havePunchTempo && haveFeintTempo;
        HitPattern.PatternKind targetKind = preferFeint ? HitPattern.PatternKind.Feint : HitPattern.PatternKind.Punch;
        float targetInterval = preferFeint ? avgFeintInterval : avgPunchInterval;
        float now = Time.time;
        float bestDiff = float.MaxValue;
        int bestIdx = -1;
        HitPattern bestPat = null;
        for (int i = 0; i < hitPatterns.Count; i++)
        {
            var p = hitPatterns[i];
            if (p.kind != targetKind)
                continue;
            float diff = Mathf.Abs(p.avgInterval - targetInterval);
            if (diff > patternIntervalTolerance)
                continue;
            float bias = p.locked ? 0.9f : 1.0f;
            float score = diff * bias;
            if (score < bestDiff)
            {
                bestDiff = score;
                bestIdx = i;
                bestPat = p;
            }
        }
        if (bestIdx < 0 || bestPat == null)
            return false;
        bestPat.lastSeenTime = now;
        hitPatterns[bestIdx] = bestPat;
        patternIndex = bestIdx;
        pattern = bestPat;
        return true;
    }
    public void RegisterCounterSuccess(int patternIndex)
    {
        if (!enablePatternMemory)
            return;
        if (patternIndex < 0 || patternIndex >= hitPatterns.Count)
            return;
        HitPattern p = hitPatterns[patternIndex];
        p.successfulCounters++;
        if (p.successfulCounters >= 2)
            p.locked = true;
        hitPatterns[patternIndex] = p;
    }
}
