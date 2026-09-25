using UnityEngine;
/// <summary>
/// Simple time-based RNG helper: returns smoothly-varying random values.
/// Attach once in the scene, or per-AI if you want.
/// </summary>
public class TimeBasedRNG : MonoBehaviour
{
    [Tooltip("Base seed so different AIs can have different 'personalities'.")]
    public int seed = 12345;
    [Tooltip("How often (in seconds) the random cache updates.")]
    public float cacheInterval = 0.2f;
    private System.Random rand;
    private float lastUpdateTime;
    private float cachedValue01;
    void Awake()
    {
        EnsureInitialized();
    }
    void OnEnable()
    {

        EnsureInitialized();
    }
    /// <summary>
    /// Ensures the RNG is initialized (protects against Unity Awake order issues).
    /// </summary>
    void EnsureInitialized()
    {
        if (rand != null) return;

        rand = new System.Random(seed);
        lastUpdateTime = -999f;
        cachedValue01 = (float)rand.NextDouble();
    }
    /// <summary>
    /// Reseed the RNG so AI decisions and accuracy can share the same seed.
    /// </summary>
    public void Reseed(int newSeed)
    {
        seed = newSeed;
        rand = new System.Random(seed);
        lastUpdateTime = -999f;
        cachedValue01 = (float)rand.NextDouble();
    }
    /// <summary>
    /// Returns a 0..1 value that only changes every cacheInterval seconds.
    /// </summary>
    public float Next01()
    {
        EnsureInitialized();
        if (Time.time - lastUpdateTime > cacheInterval)
        {
            cachedValue01 = (float)rand.NextDouble();
            lastUpdateTime = Time.time;
        }
        return cachedValue01;
    }
    /// <summary>
    /// Returns a random float between minInclusive and maxInclusive.
    /// </summary>
    public float Range(float minInclusive, float maxInclusive)
    {
        EnsureInitialized();
        float t = (float)rand.NextDouble();
        return Mathf.Lerp(minInclusive, maxInclusive, t);
    }
    /// <summary>
    /// Returns a random int in [minInclusive, maxExclusive).
    /// </summary>
    public int RangeInt(int minInclusive, int maxExclusive)
    {
        EnsureInitialized();
        if (maxExclusive <= minInclusive) return minInclusive;
        return rand.Next(minInclusive, maxExclusive);
    }
    /// <summary>
    /// Returns true with given probability (0..1).
    /// </summary>
    public bool Chance(float probability)
    {
        EnsureInitialized();
        float t = (float)rand.NextDouble();
        return t <= Mathf.Clamp01(probability);
    }
}
