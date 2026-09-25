/**
 * Force paid for a win, by opponent rank.
 *
 * This lives on its own because two screens have to agree on it: the fight-end
 * screen that hands the money over, and the Choose Opponent card that promises
 * it beforehand. A card that advertises a different number than the payout is
 * worse than no card at all, so there is exactly one curve and both read it.
 */

/** Every payout on the rank curve below is scaled by this. */
export const FORCE_REWARD_MULT = 250;

/**
 * Rank 1 pays 1.5M, the bottom of the board pays 1,000, and everything between
 * is a straight line between the listed rungs.
 */
export function computeForceEarned(oppRank: number): number {
  const pts: [number, number][] = [
    [1, 150000], [100, 50000], [200, 30000], [300, 25000],
    [400, 15000], [500, 5000], [600, 1000], [704, 100],
  ];
  const scale = (force: number) => Math.round(force * FORCE_REWARD_MULT);
  if (oppRank <= 1) return scale(150000);
  if (oppRank >= 704) return scale(100);
  for (let i = 0; i < pts.length - 1; i++) {
    const [r1, f1] = pts[i];
    const [r2, f2] = pts[i + 1];
    if (oppRank <= r2) {
      const t = (oppRank - r1) / (r2 - r1);
      return scale(f1 + (f2 - f1) * t);
    }
  }
  return scale(100);
}
