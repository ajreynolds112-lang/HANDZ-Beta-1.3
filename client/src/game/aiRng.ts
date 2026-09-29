/**
 * The AI's shared random source.
 *
 * Kept free of every other import so modules that only need the RNG (the string
 * runner, the RL policy hook) can be loaded under plain Node by the check
 * scripts. engine.ts re-exports `aiRNG`, so existing imports are unchanged.
 */

export class TimeBasedRNG {
  private rand: () => number;
  private seed: number;
  private cachedValue: number;
  private lastUpdateTime: number;
  private cacheInterval: number;

  constructor(seed: number = 12345, cacheInterval: number = 0.2) {
    this.seed = seed;
    this.cacheInterval = cacheInterval;
    this.lastUpdateTime = -999;
    this.rand = this.createSeededRandom(seed);
    this.cachedValue = this.rand();
  }

  private createSeededRandom(seed: number): () => number {
    let s = seed;
    return () => {
      s = (s * 1664525 + 1013904223) & 0xFFFFFFFF;
      return (s >>> 0) / 0xFFFFFFFF;
    };
  }

  reseed(newSeed: number): void {
    this.seed = newSeed;
    this.rand = this.createSeededRandom(newSeed);
    this.lastUpdateTime = -999;
    this.cachedValue = this.rand();
  }

  next01(): number {
    const now = performance.now() / 1000;
    if (now - this.lastUpdateTime > this.cacheInterval) {
      this.cachedValue = this.rand();
      this.lastUpdateTime = now;
    }
    return this.cachedValue;
  }

  range(min: number, max: number): number {
    const t = this.rand();
    return min + (max - min) * t;
  }

  chance(probability: number): boolean {
    const t = this.rand();
    return t <= Math.max(0, Math.min(1, probability));
  }
}

export const aiRNG = new TimeBasedRNG(Date.now());
