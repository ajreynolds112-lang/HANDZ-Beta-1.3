/**
 * Ordinary sparring (Journeyman → Champion): session length and the reward
 * tier a session pays at.
 *
 * A win at or above SPARRING_UPGRADE_ACCURACY pays the NEXT tier's rewards:
 * Journeyman → Contender → Elite → Champion → Undisputed. "Undisputed" exists
 * only as a reward tier (there is no Undisputed sparring partner). The payout
 * and the difficulty cards both read these tables, so the advertised numbers
 * are the paid ones.
 */
import type { AIDifficulty } from "./types";
import { ITEM_RARITIES, type ItemRarity } from "./itemsConfig";

export type SparringRewardTier = AIDifficulty | "undisputed";

export const SPARRING_UPGRADE_ACCURACY = 0.6;

const NEXT_TIER: Record<AIDifficulty, SparringRewardTier> = {
  journeyman: "contender",
  contender: "elite",
  elite: "champion",
  champion: "undisputed",
};

export const SPARRING_TIER_LABELS: Record<SparringRewardTier, string> = {
  journeyman: "Journeyman",
  contender: "Contender",
  elite: "Elite",
  champion: "Champion",
  undisputed: "Undisputed",
};

/** XP multiplier by reward tier (Undisputed continues the Elite→Champion step). */
export const SPARRING_XP_MULT: Record<SparringRewardTier, number> = {
  journeyman: 0.8,
  contender: 1.0,
  elite: 1.35,
  champion: 1.75,
  undisputed: 2.2,
};

/** Base stat points for a win. */
export const SPARRING_WIN_POINTS: Record<SparringRewardTier, number> = {
  journeyman: 2,
  contender: 3,
  elite: 4,
  champion: 5,
  undisputed: 6,
};

/** Per-session stat-point ceiling (before the idle halving). */
export const SPARRING_POINT_CAP: Record<SparringRewardTier, number> = {
  journeyman: 12,
  contender: 18,
  elite: 24,
  champion: 30,
  undisputed: 36,
};

/** Ceiling on a win's item: each tier pays at most one grade above itself. */
export const SPARRING_WIN_RARITY_CAP: Record<SparringRewardTier, ItemRarity> = {
  journeyman: "Contender",
  contender: "Elite",
  elite: "Champion",
  champion: "Undisputed",
  undisputed: "Undisputed",
};

/** Item floor on an upgraded win: at least the grade the win was upgraded to. */
const UPGRADE_RARITY_FLOOR: Record<SparringRewardTier, ItemRarity> = {
  journeyman: "Journeyman",
  contender: "Contender",
  elite: "Elite",
  champion: "Champion",
  undisputed: "Undisputed",
};

/** Finish-time item tiers: a faster finish pays a better item. */
const SPARRING_WIN_ITEM_TIERS: { maxSeconds: number; rarity: ItemRarity }[] = [
  { maxSeconds: 25, rarity: "Undisputed" },
  { maxSeconds: 30, rarity: "Champion" },
  { maxSeconds: 45, rarity: "Elite" },
  { maxSeconds: 50, rarity: "Contender" },
  { maxSeconds: Infinity, rarity: "Journeyman" },
];

export function isSparringUpgrade(won: boolean, accuracy: number): boolean {
  return won && accuracy >= SPARRING_UPGRADE_ACCURACY;
}

/** The tier a session pays at: the difficulty sparred, or the next one up on an accurate win. */
export function sparringRewardTier(difficulty: AIDifficulty, won: boolean, accuracy: number): SparringRewardTier {
  return isSparringUpgrade(won, accuracy) ? NEXT_TIER[difficulty] : difficulty;
}

export function nextSparringTier(difficulty: AIDifficulty): SparringRewardTier {
  return NEXT_TIER[difficulty];
}

/**
 * The single calculator for a sparring win's item tier: pick by finish time,
 * lift to the upgrade floor, then clamp to the reward tier's ceiling.
 */
export function sparringWinRarity(elapsedSeconds: number, tier: SparringRewardTier, upgraded: boolean): ItemRarity {
  let rarity = SPARRING_WIN_ITEM_TIERS.find(t => elapsedSeconds <= t.maxSeconds)?.rarity ?? "Journeyman";
  const idx = (r: ItemRarity) => ITEM_RARITIES.indexOf(r);
  if (upgraded && idx(rarity) < idx(UPGRADE_RARITY_FLOOR[tier])) rarity = UPGRADE_RARITY_FLOOR[tier];
  const cap = SPARRING_WIN_RARITY_CAP[tier];
  return idx(rarity) > idx(cap) ? cap : rarity;
}

// ===== Session length =====

export const SPARRING_DURATIONS = [60, 120, 180] as const;
export type SparringDuration = (typeof SPARRING_DURATIONS)[number];
const DURATION_KEY = "handz_sparring_duration";

export function loadSparringDuration(): SparringDuration {
  try {
    const n = Number(localStorage.getItem(DURATION_KEY));
    if ((SPARRING_DURATIONS as readonly number[]).includes(n)) return n as SparringDuration;
  } catch { /* no storage */ }
  return 60;
}

export function saveSparringDuration(seconds: SparringDuration): void {
  try { localStorage.setItem(DURATION_KEY, String(seconds)); } catch { /* no storage */ }
}
