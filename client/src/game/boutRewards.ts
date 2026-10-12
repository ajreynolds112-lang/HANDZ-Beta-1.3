import type { AIDifficulty } from "./types";

/**
 * Stat points an official career bout pays, before the stat cap. Shared by the
 * fight-end payout and the challenge contract quote.
 */
export function boutStatPoints(p: {
  careerDiff: AIDifficulty;
  level: number;
  accuracy: number;
  accuracyBonusStat: number;
  statBoutMult: number;
  koTimeBonus: number;
  oppLevel: number;
  enemyLevel: number;
  playerStatTotal: number;
  oppStatTotal: number | null;
  isLoss: boolean;
}): number {
  let pts = (p.careerDiff === "champion" ? 5 : p.careerDiff === "elite" ? 2 : 1) + p.accuracyBonusStat;
  if (p.level >= 20 && p.accuracy > 0.6) pts += (Math.floor(p.level / 10) - 1) * 2;
  pts = Math.floor(Math.ceil(pts * 1.75 * 4) * 0.5);
  pts = Math.round(pts * p.statBoutMult);
  pts += p.koTimeBonus * 3;
  const upset = Math.max(0, p.oppLevel - p.level);
  if (upset > 0) pts += upset * 2;
  // Stat-point discrepancy bonus: opponent has >15% more total stat points than the player.
  // +10% per percentage point above the 15% threshold, capped at +100%; halved on a loss.
  if (p.oppStatTotal != null && p.playerStatTotal > 0 && p.oppStatTotal > p.playerStatTotal * 1.15) {
    const bonusFrac = Math.min(1.0, (p.oppStatTotal / p.playerStatTotal - 1 - 0.15) * 10);
    pts = Math.round(pts * (1 + bonusFrac * (p.isLoss ? 0.5 : 1.0)));
  }
  if (p.level >= 100) {
    // Endgame: zero vs opponents 5+ levels below you, otherwise x0.3 (floored) and hard-capped at 20.
    pts = p.enemyLevel < p.level - 5 ? 0 : Math.min(20, Math.floor(pts * 0.3));
  }
  return pts;
}
