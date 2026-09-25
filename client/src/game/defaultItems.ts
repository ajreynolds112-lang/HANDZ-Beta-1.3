/**
 * Built-in item catalog — every item shipped with the game.
 *
 * These definitions are merged into the saved items config on load, so a fresh
 * save already has the full catalog while anything the admin edits in the
 * Neural Network → Items editor still wins (matched by id). Ids are stable
 * strings: `itemEffects.ts` keys each item's gameplay effect off the same id.
 *
 * Icons are isometric pixel-art PNGs under `client/public/items/`; the emoji is
 * only a fallback for when the PNG hasn't loaded.
 */
import { allSourcesAllowed, type ItemDefinition, type ItemRarity } from "@/game/itemsConfig";

const TIERS: ItemRarity[] = ["Journeyman", "Contender", "Elite", "Champion", "Undisputed", "GOAT"];
const ROMAN = ["I", "II", "III", "IV", "V", "VI"];

/** Compact authoring shape — expanded into full ItemDefinitions below. */
interface Seed {
  id: string;
  name: string;
  rarity: ItemRarity;
  /** Emoji fallback drawn when the PNG is missing. */
  icon: string;
  /** File name (without extension) under `client/public/items/`. */
  img: string;
  /** Consumables stack to 9999; keepsakes are permanent one-per-save gifts. */
  kind: "consumable" | "keepsake" | "permanent";
  /** Lifetime obtainable limit for `permanent` items (keepsakes are always 1). */
  limit?: number;
  /** Activatable boost (shows Activate in the Locker and an icon in the boost HUD). */
  boost?: boolean;
  /** Synergy stack count — omitted means no synergy. */
  synergy?: number;
  /** Drop weight inside its rarity tier. */
  pct: number;
  sellShards?: number;
  sellForce?: number;
  sellDiamonds?: number;
}

function tiered(
  base: string,
  idBase: string,
  icon: string,
  img: string,
  pct: number,
  tiers: ItemRarity[] = TIERS,
  /**
   * Families whose artwork is re-tinted per rarity (see
   * script/recolorItemIcons.ts) point each tier at its own `<img>_<rarity>.png`
   * instead of sharing the one base sprite.
   */
  perRarityArt = false,
): Seed[] {
  return tiers.map((rarity, i) => ({
    id: `${idBase}_${rarity.toLowerCase()}`,
    name: `${base} ${ROMAN[TIERS.indexOf(rarity)]}`,
    rarity,
    icon,
    img: perRarityArt ? `${img}_${rarity.toLowerCase()}` : img,
    kind: "consumable" as const,
    boost: true,
    pct,
  }));
}

const SEEDS: Seed[] = [
  // ---------- Tiered families (one item per rarity so crates can draw by tier) ----------
  ...tiered("Force Bundle", "force_bundle", "⚡", "force_bundle", 12),
  ...tiered("Refinement Tome", "refinement_tome", "📘", "refinement_tome", 8, TIERS, true),
  // Fight Surge has no Undisputed tier in the spec.
  ...tiered("Fight Surge", "fight_surge", "💥", "fight_surge", 12,
    ["Journeyman", "Contender", "Elite", "Champion", "GOAT"]),
  ...tiered("Pre-Workout Powder", "preworkout_powder", "🥤", "preworkout_powder", 16),
  ...tiered("Combo Tape", "combo_tape", "🥊", "combo_tape", 16),
  ...tiered("Headgear Strap", "headgear_strap", "🪖", "headgear_strap", 16, TIERS, true),
  ...tiered("Electrolyte Bottle", "electrolyte_bottle", "🧴", "electrolyte_bottle", 16),

  // ---------- Journeyman exclusives ----------
  { id: "warmup_tape", name: "Warmup Tape", rarity: "Journeyman", icon: "🎞️", img: "warmup_tape", kind: "consumable", boost: true, pct: 14 },
  { id: "diamond_chip", name: "Diamond Chip", rarity: "Journeyman", icon: "💠", img: "diamond_chip", kind: "consumable", boost: true, pct: 10 },
  { id: "footwork_laces", name: "Footwork Laces", rarity: "Journeyman", icon: "👟", img: "footwork_laces", kind: "keepsake", pct: 4 },
  { id: "gummy_candy_i", name: "Gummy Candy I", rarity: "Journeyman", icon: "🍬", img: "gummy_candy", kind: "consumable", boost: true, synergy: 20, pct: 14 },
  { id: "banana", name: "Banana", rarity: "Journeyman", icon: "🍌", img: "banana", kind: "consumable", boost: true, synergy: 10, pct: 14 },

  // ---------- Contender exclusives ----------
  { id: "ac_blast_i", name: "AC Blast I", rarity: "Contender", icon: "❄️", img: "ac_blast", kind: "consumable", boost: true, pct: 10 },
  { id: "old_bell_hammer", name: "Old Bell Hammer", rarity: "Contender", icon: "🔔", img: "old_bell_hammer", kind: "keepsake", pct: 4 },
  { id: "gummy_candy_ii", name: "Gummy Candy II", rarity: "Contender", icon: "🍬", img: "gummy_candy", kind: "consumable", boost: true, synergy: 20, pct: 14 },

  // ---------- Elite exclusives ----------
  { id: "ac_blast_ii", name: "AC Blast II", rarity: "Elite", icon: "❄️", img: "ac_blast", kind: "consumable", boost: true, pct: 10 },
  { id: "diamond_jar", name: "Diamond Jar", rarity: "Elite", icon: "🫙", img: "diamond_jar", kind: "consumable", boost: true, pct: 8 },
  { id: "veterans_footage", name: "Veteran's Footage", rarity: "Elite", icon: "📽️", img: "veterans_footage", kind: "keepsake", pct: 3 },
  { id: "training_frenzy_i", name: "Training Frenzy I", rarity: "Elite", icon: "⏱️", img: "training_frenzy", kind: "consumable", boost: true, pct: 12 },

  // ---------- Champion exclusives ----------
  { id: "diamond_drawer", name: "Diamond Drawer", rarity: "Champion", icon: "🗄️", img: "diamond_drawer", kind: "consumable", boost: true, pct: 8 },
  { id: "ac_blast_iii", name: "AC Blast III", rarity: "Champion", icon: "❄️", img: "ac_blast", kind: "consumable", boost: true, pct: 10 },
  { id: "credit_limit_increase", name: "Credit Limit Increase", rarity: "Champion", icon: "💳", img: "credit_limit", kind: "keepsake", pct: 3 },
  { id: "compression_sleeves", name: "Compression Sleeves", rarity: "Champion", icon: "🦾", img: "compression_sleeves", kind: "keepsake", pct: 3 },
  { id: "veterans_hand_wraps", name: "Veteran's Hand Wraps", rarity: "Champion", icon: "🧣", img: "veterans_hand_wraps", kind: "keepsake", pct: 3 },
  { id: "veterans_fund_i", name: "Veteran's Fund I", rarity: "Champion", icon: "💰", img: "veterans_fund", kind: "consumable", boost: true, pct: 6 },
  { id: "heavy_bag_of_greatness", name: "Heavy Bag of Greatness", rarity: "Champion", icon: "🏆", img: "heavy_bag_greatness", kind: "keepsake", pct: 3 },
  { id: "training_frenzy_ii", name: "Training Frenzy II", rarity: "Champion", icon: "⏱️", img: "training_frenzy", kind: "consumable", boost: true, synergy: 9999, pct: 12 },
  { id: "import_ticket", name: "Import Ticket", rarity: "Champion", icon: "🎫", img: "import_ticket", kind: "consumable", boost: true, pct: 10 },
  { id: "gummy_candy_iii", name: "Gummy Candy III", rarity: "Champion", icon: "🍬", img: "gummy_candy", kind: "consumable", boost: true, synergy: 20, pct: 14 },

  // ---------- Undisputed exclusives ----------
  { id: "diamond_vault", name: "Diamond Vault", rarity: "Undisputed", icon: "🏦", img: "diamond_vault", kind: "consumable", boost: true, pct: 8 },
  { id: "ac_blast_iv", name: "AC Blast IV", rarity: "Undisputed", icon: "❄️", img: "ac_blast", kind: "consumable", boost: true, pct: 10, sellShards: 20000 },
  { id: "gym_key", name: "Gym Key", rarity: "Undisputed", icon: "🔑", img: "gym_key", kind: "keepsake", pct: 3 },
  { id: "corner_bucket", name: "Corner Bucket", rarity: "Undisputed", icon: "🪣", img: "corner_bucket", kind: "keepsake", pct: 3 },
  { id: "coachs_notes", name: "Coach's Notes", rarity: "Undisputed", icon: "📋", img: "coachs_notes", kind: "keepsake", pct: 3 },
  { id: "challenge_clause", name: "Challenge Clause", rarity: "Undisputed", icon: "📜", img: "challenge_clause", kind: "keepsake", pct: 3 },
  { id: "veterans_fund_ii", name: "Veteran's Fund II", rarity: "Undisputed", icon: "💰", img: "veterans_fund", kind: "consumable", boost: true, pct: 6, sellShards: 250000 },
  { id: "training_frenzy_iii", name: "Training Frenzy III", rarity: "Undisputed", icon: "⏱️", img: "training_frenzy", kind: "consumable", boost: true, synergy: 9999, pct: 12, sellShards: 60000 },

  // ---------- GOAT exclusives ----------
  { id: "ac_blast_v", name: "AC Blast V", rarity: "GOAT", icon: "❄️", img: "ac_blast", kind: "consumable", boost: true, pct: 10, sellShards: 100000 },
  { id: "goats_blessing", name: "GOAT's Blessing", rarity: "GOAT", icon: "🐐", img: "goats_blessing", kind: "keepsake", pct: 8 },
  { id: "training_frenzy_iv", name: "Training Frenzy IV", rarity: "GOAT", icon: "⏱️", img: "training_frenzy", kind: "consumable", boost: true, synergy: 9999, pct: 10, sellShards: 120000 },
  { id: "old_fight_poster", name: "Old Fight Poster", rarity: "GOAT", icon: "🪧", img: "old_fight_poster", kind: "consumable", boost: true, pct: 10 },
  { id: "lucky_coin", name: "Lucky Coin", rarity: "GOAT", icon: "🍀", img: "lucky_coin", kind: "permanent", limit: 5, pct: 6 },
  { id: "refined_film", name: "Refined Film", rarity: "GOAT", icon: "🎬", img: "refined_film", kind: "keepsake", pct: 3 },
  { id: "mouthguard_2088", name: "2088 Mouthguard", rarity: "GOAT", icon: "🦷", img: "mouthguard_2088", kind: "keepsake", pct: 3 },
  { id: "veterans_amateur_belt", name: "Veteran's Amateur Belt", rarity: "GOAT", icon: "🥇", img: "veterans_amateur_belt", kind: "keepsake", pct: 3 },
  { id: "veterans_weighted_vest", name: "Veteran's Weighted Vest", rarity: "GOAT", icon: "🎽", img: "veterans_weighted_vest", kind: "keepsake", pct: 3 },
  { id: "veterans_fund_iii", name: "Veteran's Fund III", rarity: "GOAT", icon: "💰", img: "veterans_fund", kind: "consumable", boost: true, pct: 5, sellShards: 10000000 },
  { id: "spartas_trophy", name: "Sparta's Trophy", rarity: "GOAT", icon: "🛡️", img: "spartas_trophy", kind: "permanent", limit: 1, pct: 5, sellDiamonds: 25 },
];

function expand(s: Seed): ItemDefinition {
  const isConsumable = s.kind === "consumable";
  const isKeepsake = s.kind === "keepsake";
  const sellShards = s.sellShards ?? 0;
  const sellForce = s.sellForce ?? 0;
  const sellDiamonds = s.sellDiamonds ?? 0;
  return {
    id: s.id,
    name: s.name,
    icon: s.icon,
    iconImage: `/items/${s.img}.png`,
    rarity: s.rarity,
    isBoost: s.boost === true,
    isConsumable,
    isKeepsake,
    obtainableLimit: isConsumable ? 9999 : isKeepsake ? 1 : Math.max(1, s.limit ?? 1),
    synergy: s.synergy != null,
    synergyStackCount: s.synergy ?? 1,
    // Shipped families compound; Additive is an opt-in set in the Items editor.
    synergyAdditive: false,
    sellable: !isKeepsake && (sellShards > 0 || sellForce > 0 || sellDiamonds > 0),
    sellShards,
    sellForce,
    sellDiamonds,
    rarityPercent: s.pct,
    rankUnlockThreshold: null,
    // A built-in is handed straight to the game whenever the saved config has no
    // override for it (no saved config at all, or the admin deleted the entry),
    // so every field the UI reads has to be present here — not just the ones the
    // load-time backfill would have filled in.
    storeVisible: false,
    storeCostForce: 0,
    storeCostDiamonds: 0,
    storeRankUnlock: null,
    sourceAllowed: allSourcesAllowed(),
    effectId: s.id,
  };
}

/** The full shipped catalog, in tier order. */
export const DEFAULT_ITEMS: ItemDefinition[] = SEEDS.map(expand);

/** Ids of every built-in item — used to tell shipped items from admin-authored ones. */
export const DEFAULT_ITEM_IDS = new Set(DEFAULT_ITEMS.map(i => i.id));
