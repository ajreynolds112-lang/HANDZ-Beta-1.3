/**
 * Reward crates — the chests won from career fights.
 *
 * Each crate has a fixed rarity table (which tier each of its 2–5 items rolls
 * from) and a visual identity (body / trim colours + surface texture) used by
 * the crate reveal screen. How many crates a fight awards and the odds of each
 * one are configured per rank band in Neural Network → Roster Generation →
 * Rewards.
 *
 * Drawing an item is a two-step roll:
 *   1. pick a rarity tier from the crate's tier table
 *   2. pick an item of that tier weighted by its editor-set "Rarity %"
 * Items set to 0% Rarity, items that already sit at their lifetime obtainable
 * limit (9999 for consumables), keepsakes already received, and consumables
 * outside their rank-exclusive window are excluded from every draw.
 */
import type { ItemInventory } from "@shared/schema";
import { loadItemsConfig, itemAllowedFrom, rankUnlockMet, ITEM_RARITIES, type ItemDefinition, type ItemRarity, type ItemSource } from "@/game/itemsConfig";
import { effectOf } from "@/game/itemEffects";

export type CrateId =
  | "journeyman"
  | "contender"
  | "elite"
  | "champion"
  | "undisputed"
  | "goat";

export type CrateTexture = "wood" | "metal" | "quartz";

export interface CrateDefinition {
  id: CrateId;
  name: string;
  /** Tier → percentage chance for a single item draw (sums to 100). */
  table: Partial<Record<ItemRarity, number>>;
  /** Main chest body colour. */
  body: string;
  /** Darker body shade used for the chest's shadowed faces. */
  bodyDark: string;
  /** Bands / corners / lock colour. */
  trim: string;
  /** Brighter trim shade used for the metallic highlight. */
  trimLight: string;
  texture: CrateTexture;
  /** Short description shown in the Rewards editor. */
  blurb: string;
}

/** Items granted by opening a crate — every crate rolls its own size in this range. */
export const CRATE_ITEM_COUNT_MIN = 2;
export const CRATE_ITEM_COUNT_MAX = 5;

/**
 * Chance of each item past the guaranteed two, rolled in order: the 3rd item at
 * 80%, then the 4th at 60%, then the 5th at 50%. A failed roll ends the crate,
 * so a miss on the 3rd item means no 4th or 5th either.
 */
export const CRATE_EXTRA_ITEM_CHANCES = [0.80, 0.60, 0.50] as const;

/** How many items this crate will hold: 2 guaranteed, then the bonus ladder. */
export function rollCrateItemCount(rng: () => number = Math.random): number {
  let count = CRATE_ITEM_COUNT_MIN;
  for (const chance of CRATE_EXTRA_ITEM_CHANCES) {
    if (rng() >= chance) break;
    count++;
  }
  return Math.min(CRATE_ITEM_COUNT_MAX, count);
}

export const CRATES: Record<CrateId, CrateDefinition> = {
  journeyman: {
    id: "journeyman",
    name: "Journeyman's Crate",
    table: { Journeyman: 85, Contender: 14, Elite: 1 },
    body: "#c19a6b", bodyDark: "#8d6c46",
    trim: "#2f8f4e", trimLight: "#5fd486",
    texture: "wood",
    blurb: "85% J / 14% C / 1% E",
  },
  contender: {
    id: "contender",
    name: "Contender's Crate",
    table: { Journeyman: 10, Contender: 75, Elite: 14, Champion: 1 },
    body: "#c19a6b", bodyDark: "#8d6c46",
    trim: "#2f6fd0", trimLight: "#6fa8ff",
    texture: "wood",
    blurb: "10% J / 75% C / 14% E / 1% Ch",
  },
  elite: {
    id: "elite",
    name: "Elite's Crate",
    table: { Contender: 10, Elite: 75, Champion: 14.75, Undisputed: 0.25 },
    body: "#8a8f98", bodyDark: "#5c626b",
    trim: "#8e44ad", trimLight: "#c77dff",
    texture: "metal",
    blurb: "10% C / 75% E / 14.75% Ch / 0.25% U",
  },
  champion: {
    id: "champion",
    name: "Champion's Crate",
    table: { Elite: 10, Champion: 89, Undisputed: 1 },
    body: "#8a8f98", bodyDark: "#5c626b",
    trim: "#e0b23c", trimLight: "#ffe08a",
    texture: "metal",
    blurb: "10% E / 89% Ch / 1% U",
  },
  undisputed: {
    id: "undisputed",
    name: "Undisputed's Crate",
    table: { Champion: 55, Undisputed: 44.99, GOAT: 0.01 },
    body: "#eef2f7", bodyDark: "#c3ccd8",
    trim: "#cfd6dd", trimLight: "#ffffff",
    texture: "quartz",
    blurb: "55% Ch / 44.99% U / 0.01% GOAT",
  },
  goat: {
    id: "goat",
    name: "GOAT's Crate",
    table: { Champion: 30, Undisputed: 55, GOAT: 15 },
    body: "#3a3d42", bodyDark: "#22252a",
    trim: "#63c8f0", trimLight: "#b9ecff",
    texture: "metal",
    blurb: "30% Ch / 55% U / 15% GOAT",
  },
};

export const CRATE_IDS: CrateId[] = ["journeyman", "contender", "elite", "champion", "undisputed", "goat"];

export function getCrate(id: string | null | undefined): CrateDefinition | null {
  if (!id) return null;
  return (CRATES as Record<string, CrateDefinition>)[id] ?? null;
}

export function isCrateId(id: unknown): id is CrateId {
  return typeof id === "string" && CRATE_IDS.includes(id as CrateId);
}

// ==================== DRAWING ITEMS ====================

/**
 * Can this item still be obtained? Mirrors the rules enforced by grantItem so
 * a crate never rolls something the grant path would refuse.
 * `extraObtained` counts copies already drawn earlier in the same crate.
 */
function isDrawable(
  def: ItemDefinition,
  inv: ItemInventory,
  extraObtained: number,
  playerRank: number | null | undefined,
  allowKeepsakes = false,
  refinementMaxed = false,
  source: ItemSource | null = null,
): boolean {
  // The admin can bar an item from a specific reward path. An untagged draw
  // passes, so only a caller that names its source is ever narrowed.
  if (!itemAllowedFrom(def, source)) return false;
  // Rarity % is the drop weighting, so 0% means "never drops from a crate".
  if (def.rarityPercent <= 0) return false;
  // Every refinement category already at its ceiling — a tome's points can
  // never be spent, so it stops dropping. Read off the save's own refinement,
  // so the lockout travels with an exported career.
  if (refinementMaxed && (effectOf(def)?.grantRefinementPoints ?? 0) > 0) return false;
  // Keepsakes are won, never dropped: the only way into the locker is beating
  // an opponent who walked in wearing one (claimOpponentKeepsakes) — except
  // where a caller opts in (training rewards), and then still one of each ever.
  if (def.isKeepsake) {
    if (!allowKeepsakes) return false;
    if (inv.keepsakesReceived.includes(def.id)) return false;
    if ((inv.owned[def.id] ?? 0) > 0) return false;
    // One of each, ever — whatever obtainable limit the item was authored with.
    if (extraObtained > 0) return false;
  }
  const lifetime = (inv.lifetimeObtained[def.id] ?? 0) + extraObtained;
  if (lifetime >= def.obtainableLimit) return false;
  if (!rankUnlockMet(def, playerRank)) return false;
  return true;
}

/**
 * Weighted pick. Zero-weight entries can never be selected — when nothing has a
 * positive weight the pick fails rather than silently going uniform, so a 0%
 * item is never handed out just because its tier holds nothing else.
 */
function weightedPick<T>(entries: T[], weightOf: (e: T) => number, rng: () => number): T | null {
  if (entries.length === 0) return null;
  const total = entries.reduce((sum, e) => sum + Math.max(0, weightOf(e)), 0);
  if (total <= 0) return null;
  let roll = rng() * total;
  for (const e of entries) {
    roll -= Math.max(0, weightOf(e));
    if (roll <= 0) return e;
  }
  return entries[entries.length - 1];
}

/**
 * A rolled tier with no eligible items (empty, all capped, or every item set to
 * 0% Rarity) substitutes the nearest
 * tier that does have something to give (closest below first, then above), so a
 * crate still delivers its full rolled size while the configured tier odds
 * stay exactly as authored for every tier that *is* stocked.
 */
function nearestStockedTier(target: ItemRarity, stocked: Map<ItemRarity, ItemDefinition[]>): ItemRarity | null {
  if (stocked.has(target)) return target;
  const ti = ITEM_RARITIES.indexOf(target);
  if (ti < 0) return null;
  for (let d = 1; d < ITEM_RARITIES.length; d++) {
    const below = ITEM_RARITIES[ti - d];
    if (below && stocked.has(below)) return below;
    const above = ITEM_RARITIES[ti + d];
    if (above && stocked.has(above)) return above;
  }
  return null;
}

export interface RollCrateOptions {
  /** Current inventory — used to skip items already at their lifetime cap. */
  inventory: ItemInventory;
  /** Player rank, for consumable rank-exclusivity. */
  playerRank?: number | null;
  /** Item catalog override (defaults to the saved items config). */
  items?: ItemDefinition[];
  rng?: () => number;
  /**
   * Let keepsakes into the draw. Off everywhere except the gym — a workout
   * reward can turn one up, still one of each ever. Fight and daily chests
   * leave them to the ring.
   */
  allowKeepsakes?: boolean;
  /**
   * Which reward path is drawing. Items the admin barred from this source drop
   * out of the draw entirely. Omitted = ungated.
   */
  source?: ItemSource | null;
  /**
   * Every refinement category is already at its ceiling — refinement tomes are
   * dead weight, so they leave the draw entirely.
   */
  refinementMaxed?: boolean;
}

/**
 * Roll the crate's contents against a single catalog snapshot and return the
 * item definitions drawn (duplicates possible). Always returns the crate's
 * rolled size (2–5) unless the catalog runs out of eligible items — e.g. an
 * empty catalog (none) or every remaining item hitting its lifetime cap
 * partway through the crate (fewer).
 *
 * Callers must grant exactly these definitions: rolling and granting off the
 * same snapshot is what keeps the reveal and the inventory in agreement.
 */
export function rollCrateDraw(crateId: CrateId, opts: RollCrateOptions): ItemDefinition[] {
  const crate = CRATES[crateId];
  if (!crate) return [];
  const rng = opts.rng ?? Math.random;
  const catalog = opts.items ?? loadItemsConfig();
  const playerRank = opts.playerRank ?? null;

  const tiers = (Object.entries(crate.table) as [ItemRarity, number][])
    .filter(([, pct]) => pct > 0);
  if (tiers.length === 0) return [];

  // Track copies drawn within this crate so a 1-of item can't drop twice.
  const drawnCounts: Record<string, number> = {};
  const drawn: ItemDefinition[] = [];

  const itemCount = rollCrateItemCount(rng);
  for (let i = 0; i < itemCount; i++) {
    const stocked = new Map<ItemRarity, ItemDefinition[]>();
    for (const [tier] of tiers) {
      const list = catalog.filter(d =>
        d.rarity === tier && isDrawable(d, opts.inventory, drawnCounts[d.id] ?? 0, playerRank, opts.allowKeepsakes, opts.refinementMaxed, opts.source));
      if (list.length > 0) stocked.set(tier, list);
    }
    if (stocked.size === 0) break; // nothing left to give

    // 1. tier roll — always over the crate's full configured table so the
    //    authored odds hold; empty tiers resolve to their nearest stocked tier.
    const tierEntry = weightedPick(tiers, ([, pct]) => pct, rng);
    if (!tierEntry) break;
    const tier = nearestStockedTier(tierEntry[0], stocked);
    if (!tier) break;

    // 2. item roll within the tier, weighted by the editor's Rarity %
    const pick = weightedPick(stocked.get(tier) ?? [], d => d.rarityPercent, rng);
    if (!pick) break;

    drawn.push(pick);
    drawnCounts[pick.id] = (drawnCounts[pick.id] ?? 0) + 1;
  }

  return drawn;
}

/**
 * Draw a single item of one specific rarity — sparring wins pay out a loose
 * item rather than a chest. Eligibility matches a crate draw (0% rarity,
 * lifetime caps, one-time keepsakes, rank-exclusive consumables), and an
 * exhausted tier falls back to its nearest stocked neighbour so a win is never
 * silently unrewarded.
 *
 * `maxRarity` is a hard ceiling that binds the fallback as well as the request.
 * Without it an exhausted tier can substitute the nearest stocked tier *above*
 * itself, which would quietly hand out something better than the caller allows
 * once the lower tiers hit their lifetime caps. Callers that advertise a
 * maximum tier must pass it here; omitting it keeps the unbounded behaviour.
 */
export function rollItemOfRarity(
  rarity: ItemRarity,
  opts: RollCrateOptions & { maxRarity?: ItemRarity | null },
): ItemDefinition | null {
  const rng = opts.rng ?? Math.random;
  const catalog = opts.items ?? loadItemsConfig();
  const playerRank = opts.playerRank ?? null;
  const ceilingIdx = opts.maxRarity ? ITEM_RARITIES.indexOf(opts.maxRarity) : -1;

  const stocked = new Map<ItemRarity, ItemDefinition[]>();
  for (const tier of ITEM_RARITIES) {
    if (ceilingIdx >= 0 && ITEM_RARITIES.indexOf(tier) > ceilingIdx) continue;
    const list = catalog.filter(d => d.rarity === tier && isDrawable(d, opts.inventory, 0, playerRank, opts.allowKeepsakes, opts.refinementMaxed, opts.source));
    if (list.length > 0) stocked.set(tier, list);
  }
  // Clamp the request itself so the search starts inside the ceiling.
  const target = ceilingIdx >= 0 && ITEM_RARITIES.indexOf(rarity) > ceilingIdx
    ? ITEM_RARITIES[ceilingIdx]
    : rarity;
  const tier = nearestStockedTier(target, stocked);
  if (!tier) return null;
  return weightedPick(stocked.get(tier) ?? [], d => d.rarityPercent, rng);
}

/** Convenience wrapper over rollCrateDraw for callers that only need the ids. */
export function rollCrateItems(crateId: CrateId, opts: RollCrateOptions): string[] {
  return rollCrateDraw(crateId, opts).map(d => d.id);
}
