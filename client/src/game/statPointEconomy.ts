/**
 * The stat-point economy: what an earned stat point is worth once the cap
 * leaves no room for it.
 *
 * Stat points cannot be bought — Force only ever flows the other way, out of
 * points that would otherwise be lost. The rates are flat, and the counters
 * behind them live in the career save, so they travel with an exported file
 * and start clean in a brand-new career.
 */

/** Force paid per stat point an official bout earned past the cap. */
export const FORCE_PER_CAPPED_SP_BOUT = 100_000;
/** Force paid per stat point a training session earned past the cap. */
export const FORCE_PER_CAPPED_SP_TRAINING = 10_000;

/**
 * What the points that could not fit under the stat cap are worth instead.
 * Every reward path clamps its earned points to the remaining headroom; the
 * difference is handed back as Force rather than being lost.
 */
export function cappedStatPointForce(overflowPoints: number, ratePerPoint: number): number {
  const pts = Number.isFinite(overflowPoints) ? Math.max(0, Math.floor(overflowPoints)) : 0;
  return pts * ratePerPoint;
}
