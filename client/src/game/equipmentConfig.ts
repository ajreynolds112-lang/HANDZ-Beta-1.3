/**
 * Equipment Upgrades — the gym crate beside the far-right heavy bag.
 *
 * Five pieces of gear the player buys levels in with Force plus a flat Diamond
 * a level. Every level is bought one at a time and the Force price compounds,
 * so the ladder is effectively endless even though a hidden ceiling exists.
 *
 * Deliberately free of engine imports: `engine.ts` pulls the audio module,
 * which pulls `@assets/*.mp3`, so anything importing it can't run under `tsx`.
 * The check script and the UI both read these numbers from here.
 */
import type { CrateId } from "./cratesConfig";

export type EquipmentSlot = "gloves" | "shoes" | "trunks" | "mouthguard" | "wraps";

/** Levels bought per slot. Absent/zero everywhere means nothing bought yet. */
export type EquipmentLevels = Record<EquipmentSlot, number>;

export const EQUIPMENT_SLOTS: EquipmentSlot[] = ["gloves", "shoes", "trunks", "mouthguard", "wraps"];

/**
 * Hidden ceiling. Never shown in the UI — the player is meant to experience the
 * ladder as endless, and the compounding price makes it so long before here.
 */
export const EQUIPMENT_MAX_LEVEL = 1000;

/**
 * Every purchase costs 2.35% more than the one before it — tuned so the last
 * level of the gloves lands at roughly 3 trillion Force.
 */
export const EQUIPMENT_COST_GROWTH = 1.0235;

/** A chest drops on every tenth level of a piece. */
export const EQUIPMENT_CRATE_INTERVAL = 10;

export interface EquipmentDefinition {
  slot: EquipmentSlot;
  name: string;
  /** Career wins before this piece can be bought at all. */
  unlockWins: number;
  /** Force price of the first level; every level after compounds from it. */
  baseCost: number;
  /** One line per effect, `{v}` replaced with the per-level value. */
  effects: string[];
  /** Which of the player's gear colours the outlined icon is tinted with. */
  tint: "gloves" | "shoes" | "trunks" | "neutral";
}

export const EQUIPMENT: Record<EquipmentSlot, EquipmentDefinition> = {
  gloves: {
    slot: "gloves",
    name: "Fight Gloves",
    unlockWins: 1,
    baseCost: 250,
    effects: ["+0.25% punch power per level", "+0.1% auto-guard duration per level"],
    tint: "gloves",
  },
  shoes: {
    slot: "shoes",
    name: "Shoes",
    unlockWins: 3,
    baseCost: 500,
    effects: ["+0.1% movement speed per level"],
    tint: "shoes",
  },
  trunks: {
    slot: "trunks",
    name: "Trunks",
    unlockWins: 4,
    baseCost: 750,
    effects: ["+10 max stamina at the bell per level, up to +50% of your own tank"],
    tint: "trunks",
  },
  mouthguard: {
    slot: "mouthguard",
    name: "Mouthguard",
    unlockWins: 5,
    baseCost: 600,
    effects: [
      "+0.009% chance per level to shrug off a max-stamina loss",
      "+0.05% crit damage resistance per level",
      "20% chance to shrug off a Big Shot at level 1, up to 55% at level 150",
    ],
    tint: "gloves",
  },
  wraps: {
    slot: "wraps",
    name: "Hand Wraps",
    unlockWins: 6,
    baseCost: 650,
    effects: [
      "+0.01% blocking effectiveness per level",
      "+0.01% perfect block hold time per level",
      "+0.05% crit chance per level",
      "+0.05% stun chance per level",
    ],
    tint: "neutral",
  },
};

// ---------------------------------------------------------------- levels

export function emptyEquipmentLevels(): EquipmentLevels {
  return { gloves: 0, shoes: 0, trunks: 0, mouthguard: 0, wraps: 0 };
}

/** Coerce anything off a save into five clamped integers. Absent = zero. */
export function normalizeEquipmentLevels(raw: unknown): EquipmentLevels {
  const src = (raw ?? {}) as Record<string, unknown>;
  const out = emptyEquipmentLevels();
  for (const slot of EQUIPMENT_SLOTS) {
    const v = src[slot];
    out[slot] = clampEquipmentLevel(typeof v === "number" ? v : 0);
  }
  return out;
}

export function clampEquipmentLevel(v: number): number {
  if (!Number.isFinite(v) || v <= 0) return 0;
  return Math.min(EQUIPMENT_MAX_LEVEL, Math.floor(v));
}

/** The same level in all five slots — how a career opponent carries equipment. */
export function uniformEquipmentLevels(level: number): EquipmentLevels {
  const l = clampEquipmentLevel(level);
  return { gloves: l, shoes: l, trunks: l, mouthguard: l, wraps: l };
}

export function totalEquipmentLevels(levels: EquipmentLevels | null | undefined): number {
  if (!levels) return 0;
  return EQUIPMENT_SLOTS.reduce((sum, slot) => sum + clampEquipmentLevel(levels[slot] ?? 0), 0);
}

/** Mean level across the five slots, rounded down. Drives the post-champ floor. */
export function averageEquipmentLevel(levels: EquipmentLevels | null | undefined): number {
  return Math.floor(totalEquipmentLevels(levels) / EQUIPMENT_SLOTS.length);
}

// ---------------------------------------------------------------- pricing

/**
 * Force price of the upgrade that takes a piece from `currentLevel` to the next
 * one. Closed-form rather than a loop: the ceiling is 1000 levels and
 * 1.0235^999 is around 1.2e10, so the curve is walked by exponent, never summed.
 *
 * Returns Infinity at the ceiling, which no purchase path can afford — the
 * buttons gate on `canBuyEquipmentLevel` before it ever shows.
 */
export function equipmentForceCost(slot: EquipmentSlot, currentLevel: number): number {
  const lvl = clampEquipmentLevel(currentLevel);
  if (lvl >= EQUIPMENT_MAX_LEVEL) return Infinity;
  return EQUIPMENT[slot].baseCost * Math.pow(EQUIPMENT_COST_GROWTH, lvl);
}

/**
 * Diamonds charged on top of the Force price, the same on every piece at every
 * depth. Five slots at a thousand levels each means taking the whole set to the
 * ceiling costs exactly 5,000 diamonds.
 */
export const EQUIPMENT_DIAMOND_COST = 1;

/**
 * Zero at the ceiling, where there is no next level to price — the Force side
 * returns Infinity there and `maxed` blocks the buy either way, so this just
 * keeps the UI from advertising a diamond for a purchase that can't happen.
 */
export function equipmentDiamondCost(_slot: EquipmentSlot, currentLevel: number): number {
  if (clampEquipmentLevel(currentLevel) >= EQUIPMENT_MAX_LEVEL) return 0;
  return EQUIPMENT_DIAMOND_COST;
}

export interface EquipmentPurse {
  force?: number | null;
  diamonds?: number | null;
}

export interface EquipmentPurchaseQuote {
  /** The level this purchase buys (currentLevel + 1). */
  targetLevel: number;
  force: number;
  diamonds: number;
  /** True when the piece is at the hidden ceiling — nothing further to buy. */
  maxed: boolean;
  affordable: boolean;
  /** Crate this purchase hands over, or null when it isn't a tenth level. */
  crate: CrateId | null;
}

export function quoteEquipmentUpgrade(
  slot: EquipmentSlot,
  currentLevel: number,
  purse: EquipmentPurse,
): EquipmentPurchaseQuote {
  const lvl = clampEquipmentLevel(currentLevel);
  const maxed = lvl >= EQUIPMENT_MAX_LEVEL;
  const force = equipmentForceCost(slot, lvl);
  const diamonds = equipmentDiamondCost(slot, lvl);
  const targetLevel = Math.min(EQUIPMENT_MAX_LEVEL, lvl + 1);
  return {
    targetLevel,
    force,
    diamonds,
    maxed,
    affordable: !maxed && (purse.force ?? 0) >= force && (purse.diamonds ?? 0) >= diamonds,
    crate: maxed ? null : equipmentCrateForLevel(targetLevel),
  };
}

/** A piece is buyable once its win threshold is cleared and it isn't maxed. */
export function canBuyEquipmentLevel(slot: EquipmentSlot, currentLevel: number, careerWins: number): boolean {
  return careerWins >= EQUIPMENT[slot].unlockWins && clampEquipmentLevel(currentLevel) < EQUIPMENT_MAX_LEVEL;
}

/**
 * Compact price text. The curve tops out around 9e12 Force at the ceiling, so
 * this renders plain separators throughout; the exponent branch is a guard for
 * anything past what `toLocaleString` shows readably.
 */
export function formatEquipmentCost(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (n < 1e15) return Math.round(n).toLocaleString();
  return n.toExponential(2).replace("e+", "e");
}

// ---------------------------------------------------------------- crates

/**
 * Chest handed out for reaching this level, or null when it isn't a tenth
 * level. Tier is read off the level itself, so the deeper the ladder the
 * richer the chest.
 */
export function equipmentCrateForLevel(level: number): CrateId | null {
  const lvl = clampEquipmentLevel(level);
  if (lvl <= 0 || lvl % EQUIPMENT_CRATE_INTERVAL !== 0) return null;
  if (lvl <= 100) return "journeyman";
  if (lvl <= 200) return "contender";
  if (lvl <= 300) return "elite";
  if (lvl <= 400) return "champion";
  if (lvl <= 500) return "undisputed";
  return "goat";
}

// ---------------------------------------------------------------- unlocks

/** Slots whose win threshold `careerWins` has cleared. */
export function unlockedEquipmentSlots(careerWins: number): EquipmentSlot[] {
  return EQUIPMENT_SLOTS.filter(slot => careerWins >= EQUIPMENT[slot].unlockWins);
}

/**
 * Unlocks the player has reached but not yet been shown. Drives the hub
 * milestone popup and the crate's red dot; entering the page marks them seen.
 */
export function pendingEquipmentUnlocks(careerWins: number, seen: string[] | undefined): EquipmentSlot[] {
  const already = new Set(seen ?? []);
  return unlockedEquipmentSlots(careerWins).filter(slot => !already.has(slot));
}

/** The crate itself appears once the player has a single career win. */
export const EQUIPMENT_CRATE_UNLOCK_WINS = EQUIPMENT.gloves.unlockWins;

export function isEquipmentCrateUnlocked(careerWins: number): boolean {
  return careerWins >= EQUIPMENT_CRATE_UNLOCK_WINS;
}

// ---------------------------------------------------------------- effects

/**
 * Everything the five pieces are worth, as fight-ready numbers. Percentages
 * are fractions (0.25 = +25%); `startMaxStamina` is a flat pool addition.
 */
export interface EquipmentEffects {
  powerPct: number;
  autoGuardPct: number;
  moveSpeedPct: number;
  startMaxStamina: number;
  /** 0–1 chance a max-stamina loss is shrugged off entirely. */
  maxStaminaNegateChance: number;
  /** 0–1 share of a crit's bonus damage that is absorbed. */
  critDamageResistPct: number;
  /**
   * 0–1 chance a Big Shot doesn't put this fighter down. Stacks on top of the
   * Punch Rolling and Iron Chin refinements, which grant the same kind of save.
   */
  bigShotNegateChance: number;
  blockPct: number;
  perfectBlockHoldPct: number;
  /** Multiplier lift on the fighter's crit chance. */
  critPct: number;
  /** Multiplier lift on the fighter's stun chance. */
  stunPct: number;
}

/**
 * The mouthguard's Big Shot save — a chance to take the punch, damage and all,
 * without being dropped by it. Unlike the rest of the gear this is not a
 * per-level trickle: the first level is already worth a fifth, it climbs to its
 * ceiling at level 150, and nothing past that buys another point.
 */
export const MOUTHGUARD_BIG_SHOT_NEGATE_L1 = 0.20;
export const MOUTHGUARD_BIG_SHOT_NEGATE_MAX = 0.55;
export const MOUTHGUARD_BIG_SHOT_NEGATE_CAP_LEVEL = 150;

/** The curve above, as a 0–1 chance. No mouthguard is no chance. */
export function mouthguardBigShotNegate(level: number): number {
  const l = Number.isFinite(level) ? Math.floor(level) : 0;
  if (l < 1) return 0;
  if (l >= MOUTHGUARD_BIG_SHOT_NEGATE_CAP_LEVEL) return MOUTHGUARD_BIG_SHOT_NEGATE_MAX;
  const t = (l - 1) / (MOUTHGUARD_BIG_SHOT_NEGATE_CAP_LEVEL - 1);
  return MOUTHGUARD_BIG_SHOT_NEGATE_L1
    + t * (MOUTHGUARD_BIG_SHOT_NEGATE_MAX - MOUTHGUARD_BIG_SHOT_NEGATE_L1);
}

/** Per-level values, kept as named constants so the check script can assert them. */
export const EQUIPMENT_PER_LEVEL = {
  glovesPowerPct: 0.0025,
  glovesAutoGuardPct: 0.001,
  shoesMoveSpeedPct: 0.001,
  trunksStartMaxStamina: 10,
  mouthguardNegateChance: 0.00009,
  mouthguardCritDamageResistPct: 0.0005,
  wrapsBlockPct: 0.0001,
  wrapsPerfectBlockHoldPct: 0.0001,
  wrapsCritPct: 0.0005,
  wrapsStunPct: 0.0005,
} as const;

/**
 * The most the trunks' pool bonus can be worth, as a share of the tank the
 * wearer already has when the gear goes on.
 *
 * The bonus itself is flat — ten points a level, the same ten whether it is
 * worn by a level 3 prospect or a level 1000 champion. A fighter's natural pool
 * is not flat: it ramps with their level, from a few hundred at the bottom to
 * tens of thousands at the top. So the same pair of trunks that is a sensible
 * top-up on a big tank is several times the whole tank on a small one, which is
 * how a level 3 opponent ended up walking in with 3,000 stamina against a level
 * 17 player's 871. Capping the addition against the wearer's own pool keeps the
 * gear worth buying at every level without letting one slot outweigh levels,
 * stats and refinements combined — and both corners are capped identically.
 */
export const EQUIPMENT_POOL_BONUS_CAP_SHARE = 0.5;

/**
 * What the trunks actually add to a fighter with this much pool already, after
 * the cap above. `poolBeforeGear` is the tank the fighter walks in with — level
 * ramp, stat points, refinements and any mode scaling — measured before the
 * gear is applied.
 */
export function cappedStartMaxStamina(startMaxStamina: number, poolBeforeGear: number): number {
  if (!Number.isFinite(startMaxStamina) || startMaxStamina <= 0) return 0;
  const pool = Number.isFinite(poolBeforeGear) && poolBeforeGear > 0 ? poolBeforeGear : 0;
  return Math.min(startMaxStamina, pool * EQUIPMENT_POOL_BONUS_CAP_SHARE);
}

export function equipmentEffects(levels: EquipmentLevels | null | undefined): EquipmentEffects {
  const l = normalizeEquipmentLevels(levels);
  const P = EQUIPMENT_PER_LEVEL;
  return {
    powerPct: l.gloves * P.glovesPowerPct,
    autoGuardPct: l.gloves * P.glovesAutoGuardPct,
    moveSpeedPct: l.shoes * P.shoesMoveSpeedPct,
    startMaxStamina: l.trunks * P.trunksStartMaxStamina,
    // Both mouthguard effects are chances/shares, so they are held below 1.
    maxStaminaNegateChance: Math.min(1, l.mouthguard * P.mouthguardNegateChance),
    critDamageResistPct: Math.min(1, l.mouthguard * P.mouthguardCritDamageResistPct),
    bigShotNegateChance: mouthguardBigShotNegate(l.mouthguard),
    blockPct: l.wraps * P.wrapsBlockPct,
    perfectBlockHoldPct: l.wraps * P.wrapsPerfectBlockHoldPct,
    critPct: l.wraps * P.wrapsCritPct,
    stunPct: l.wraps * P.wrapsStunPct,
  };
}

/** True when a spread is worth applying at all — lets callers skip the pass. */
export function hasEquipment(levels: EquipmentLevels | null | undefined): boolean {
  return totalEquipmentLevels(levels) > 0;
}

// ---------------------------------------------------------------- opponents

/**
 * Share of the player's own equipment a sparring partner walks in with, by the
 * difficulty tier of the partner. Nightmare and Doghouse are modes rather than
 * tiers, so they carry their own share.
 */
export const SPARRING_EQUIPMENT_SHARE: Record<"journeyman" | "contender" | "elite" | "champion", number> = {
  journeyman: 0.75,
  contender: 0.80,
  elite: 0.85,
  champion: 0.90,
};

export const NIGHTMARE_EQUIPMENT_SHARE = 0.10;
export const DOGHOUSE_EQUIPMENT_SHARE = 1.00;

/**
 * Scale a spread by a share, rounding each piece up so a partner on a share
 * always brings something once the player owns anything at all.
 */
export function scaleEquipmentLevels(levels: EquipmentLevels | null | undefined, share: number): EquipmentLevels {
  const src = normalizeEquipmentLevels(levels);
  const out = emptyEquipmentLevels();
  const s = Math.max(0, share);
  for (const slot of EQUIPMENT_SLOTS) {
    out[slot] = clampEquipmentLevel(Math.ceil(src[slot] * s));
  }
  return out;
}

/** Once the champion is beaten, no career opponent fights below this share. */
export const POST_CHAMP_EQUIPMENT_FLOOR_SHARE = 0.75;

/**
 * The floor a career opponent's single equipment level is raised to after the
 * champion falls — three quarters of the player's average level.
 */
export function postChampEquipmentFloor(playerLevels: EquipmentLevels | null | undefined): number {
  return clampEquipmentLevel(Math.ceil(averageEquipmentLevel(playerLevels) * POST_CHAMP_EQUIPMENT_FLOOR_SHARE));
}

// ---------------------------------------------------------------- weekly growth

export const WEEKLY_EQUIPMENT_GROWTH_CHANCE = 0.30;
export const WEEKLY_EQUIPMENT_GROWTH_MIN = 1;
export const WEEKLY_EQUIPMENT_GROWTH_MAX = 5;

/**
 * One week of growth for an equipped opponent: a 30% roll for 1–5 levels.
 *
 * Takes two independent rolls in [0,1) rather than an rng function so callers
 * can feed it a per-fighter hash stream. The weekly simulation's own seeded
 * generator must not be drawn from here — shifting its draw order silently
 * rewrites every existing save's schedule.
 */
export function grownEquipmentLevel(current: number, rollChance: number, rollAmount: number): number {
  const lvl = clampEquipmentLevel(current);
  if (lvl <= 0) return lvl;
  if (rollChance >= WEEKLY_EQUIPMENT_GROWTH_CHANCE) return lvl;
  const span = WEEKLY_EQUIPMENT_GROWTH_MAX - WEEKLY_EQUIPMENT_GROWTH_MIN + 1;
  const gain = WEEKLY_EQUIPMENT_GROWTH_MIN + Math.floor(Math.max(0, Math.min(0.999999, rollAmount)) * span);
  return clampEquipmentLevel(lvl + gain);
}
