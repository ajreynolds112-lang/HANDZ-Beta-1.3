/**
 * Ordinary sparring (Journeyman → Champion): session length and the reward
 * tier a session pays at.
 *
 * A win at or above the configured accuracy (default 60%) pays the NEXT tier's rewards:
 * Journeyman → Contender → Elite → Champion → Undisputed. "Undisputed" exists
 * only as a reward tier (there is no Undisputed sparring partner). The payout
 * and the difficulty cards both read these tables, so the advertised numbers
 * are the paid ones. Every number is tunable on the Neural Network screen
 * (SPARRING_REWARD_CONFIG_KEY), which the parameter file carries.
 */
import type { AIDifficulty } from "./types";
import { ITEM_RARITIES, type ItemRarity } from "./itemsConfig";

export type SparringRewardTier = AIDifficulty | "undisputed";

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

// ===== Tunable config (Neural Network → Sparring Rewards; rides the parameter file) =====

export const SPARRING_REWARD_CONFIG_KEY = "handz_sparring_reward_config";
export const SPARRING_REWARD_TIERS: SparringRewardTier[] = ["journeyman", "contender", "elite", "champion", "undisputed"];

export interface SparringTierRewards {
  /** XP multiplier. */
  xpMult: number;
  /** Starting stat points for a win (before bonuses/multipliers). */
  winPoints: number;
  /** Per-session stat-point ceiling (before the idle halving). */
  pointCap: number;
}

export interface SparringRewardConfig {
  /** Win at or above this accuracy (%) to be paid the next tier. */
  upgradeAccuracyPct: number;
  /** An upgraded win's item is at least the upgraded grade. */
  upgradeItemFloor: boolean;
  tiers: Record<SparringRewardTier, SparringTierRewards>;
}

export const DEFAULT_SPARRING_REWARD_CONFIG: SparringRewardConfig = {
  upgradeAccuracyPct: 60,
  upgradeItemFloor: true,
  tiers: {
    journeyman: { xpMult: 0.8, winPoints: 2, pointCap: 12 },
    contender: { xpMult: 1.0, winPoints: 3, pointCap: 18 },
    elite: { xpMult: 1.35, winPoints: 4, pointCap: 24 },
    champion: { xpMult: 1.75, winPoints: 5, pointCap: 30 },
    // Continues the Elite→Champion step; exists only as a reward tier.
    undisputed: { xpMult: 2.2, winPoints: 6, pointCap: 36 },
  },
};

export const SPARRING_FIELD_RANGES: Record<keyof SparringTierRewards, [number, number]> = {
  xpMult: [0, 20],
  winPoints: [0, 100],
  pointCap: [0, 1000],
};

const clamp = (v: unknown, lo: number, hi: number, fallback: number) =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;

/** Merge field by field over the defaults, so a hand-edited file can't break a payout. */
export function sanitizeSparringRewardConfig(raw: unknown): SparringRewardConfig {
  const d = DEFAULT_SPARRING_REWARD_CONFIG;
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<SparringRewardConfig>;
  const tiersIn = (r.tiers && typeof r.tiers === "object" ? r.tiers : {}) as Partial<Record<SparringRewardTier, Partial<SparringTierRewards>>>;
  const tiers = {} as Record<SparringRewardTier, SparringTierRewards>;
  for (const t of SPARRING_REWARD_TIERS) {
    const src = tiersIn[t] ?? {};
    tiers[t] = {
      xpMult: clamp(src.xpMult, ...SPARRING_FIELD_RANGES.xpMult, d.tiers[t].xpMult),
      winPoints: Math.round(clamp(src.winPoints, ...SPARRING_FIELD_RANGES.winPoints, d.tiers[t].winPoints)),
      pointCap: Math.round(clamp(src.pointCap, ...SPARRING_FIELD_RANGES.pointCap, d.tiers[t].pointCap)),
    };
  }
  return {
    upgradeAccuracyPct: clamp(r.upgradeAccuracyPct, 0, 101, d.upgradeAccuracyPct),
    upgradeItemFloor: typeof r.upgradeItemFloor === "boolean" ? r.upgradeItemFloor : d.upgradeItemFloor,
    tiers,
  };
}

/** Read fresh each call: used at fight end and on screen render only. */
export function getSparringRewardConfig(): SparringRewardConfig {
  try {
    const raw = localStorage.getItem(SPARRING_REWARD_CONFIG_KEY);
    return sanitizeSparringRewardConfig(raw ? JSON.parse(raw) : null);
  } catch {
    return sanitizeSparringRewardConfig(null);
  }
}

export function saveSparringRewardConfig(cfg: SparringRewardConfig): SparringRewardConfig {
  const clean = sanitizeSparringRewardConfig(cfg);
  try { localStorage.setItem(SPARRING_REWARD_CONFIG_KEY, JSON.stringify(clean)); } catch { /* no storage */ }
  return clean;
}

export function resetSparringRewardConfig(): void {
  try { localStorage.removeItem(SPARRING_REWARD_CONFIG_KEY); } catch { /* no storage */ }
}

/** 101% switches the upgrade off entirely (accuracy can't exceed 100%). */
export function isSparringUpgrade(won: boolean, accuracy: number, cfg = getSparringRewardConfig()): boolean {
  return won && accuracy * 100 >= cfg.upgradeAccuracyPct;
}

/** The tier a session pays at: the difficulty sparred, or the next one up on an accurate win. */
export function sparringRewardTier(difficulty: AIDifficulty, won: boolean, accuracy: number, cfg = getSparringRewardConfig()): SparringRewardTier {
  return isSparringUpgrade(won, accuracy, cfg) ? NEXT_TIER[difficulty] : difficulty;
}

export function nextSparringTier(difficulty: AIDifficulty): SparringRewardTier {
  return NEXT_TIER[difficulty];
}

/**
 * The single calculator for a sparring win's item tier: pick by finish time,
 * lift to the upgrade floor, then clamp to the reward tier's ceiling.
 */
export function sparringWinRarity(elapsedSeconds: number, tier: SparringRewardTier, upgraded: boolean, cfg = getSparringRewardConfig()): ItemRarity {
  let rarity = SPARRING_WIN_ITEM_TIERS.find(t => elapsedSeconds <= t.maxSeconds)?.rarity ?? "Journeyman";
  const idx = (r: ItemRarity) => ITEM_RARITIES.indexOf(r);
  if (upgraded && cfg.upgradeItemFloor && idx(rarity) < idx(UPGRADE_RARITY_FLOOR[tier])) rarity = UPGRADE_RARITY_FLOOR[tier];
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

// ===== Champion defence diamonds =====

/**
 * Champion sparring only: hold the partner's accuracy down and get paid in
 * diamonds. At or below 45% → 1, 40% → 2, 35% → 3, 30% → 4, 25% → 5; a
 * 2-minute session adds 1, a 3-minute session adds 2. A partner who threw
 * nothing pays nothing.
 */
const CHAMPION_DEFENCE_TIERS: { maxAccuracy: number; diamonds: number }[] = [
  { maxAccuracy: 0.25, diamonds: 5 },
  { maxAccuracy: 0.30, diamonds: 4 },
  { maxAccuracy: 0.35, diamonds: 3 },
  { maxAccuracy: 0.40, diamonds: 2 },
  { maxAccuracy: 0.45, diamonds: 1 },
];

export function championDefenceDiamonds(difficulty: AIDifficulty, sessionSeconds: number, oppThrown: number, oppLanded: number): number {
  if (difficulty !== "champion" || oppThrown <= 0) return 0;
  const acc = oppLanded / oppThrown;
  const tier = CHAMPION_DEFENCE_TIERS.find(t => acc <= t.maxAccuracy + 1e-9);
  if (!tier) return 0;
  const durationBonus = sessionSeconds >= 180 ? 2 : sessionSeconds >= 120 ? 1 : 0;
  return tier.diamonds + durationBonus;
}
