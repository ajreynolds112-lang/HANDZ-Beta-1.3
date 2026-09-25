/**
 * Items config — the admin-defined catalog of every item in the game.
 *
 * Items are created/tuned in the Neural Network → Items editor and persisted
 * to localStorage (same pattern as rosterGenConfig). The shipped catalog in
 * `defaultItems.ts` is always present and saved entries override it by id;
 * older saved configs are backfilled field-by-field so new fields never crash.
 */
import { DEFAULT_ITEMS } from "@/game/defaultItems";

export type ItemRarity =
  | "Journeyman"
  | "Contender"
  | "Elite"
  | "Champion"
  | "Undisputed"
  | "GOAT";

export const ITEM_RARITIES: ItemRarity[] = [
  "Journeyman", "Contender", "Elite", "Champion", "Undisputed", "GOAT",
];

export const RARITY_COLORS: Record<ItemRarity, string> = {
  Journeyman: "#22aa44",
  Contender: "#3b82f6",
  Elite: "#a855f7",
  Champion: "#f5b301",
  Undisputed: "#ffffff",
  /**
   * GOAT is drawn as an animated starfield rather than a flat colour — this is
   * only the fallback for places that can't take a CSS class (canvas, title
   * attributes, inline SVG fills).
   */
  GOAT: "#8b5cf6",
};

/**
 * Rarity styling helpers.
 *
 * Every tier below GOAT is a flat colour applied inline. GOAT gets a
 * pulsating black/purple starfield defined in `index.css`, which can only be
 * expressed as a class — so each call site pairs the style with the class and
 * lets the class win for GOAT.
 */
export function rarityTextStyle(rarity: ItemRarity): { color?: string } {
  return rarity === "GOAT" ? {} : { color: RARITY_COLORS[rarity] };
}

export function rarityTextClass(rarity: ItemRarity): string {
  return rarity === "GOAT" ? "rarity-goat-text" : "";
}

export function rarityBorderStyle(rarity: ItemRarity): { borderColor?: string } {
  return rarity === "GOAT" ? {} : { borderColor: RARITY_COLORS[rarity] };
}

export function rarityBorderClass(rarity: ItemRarity): string {
  return rarity === "GOAT" ? "rarity-goat-border" : "";
}

/**
 * The reward paths that can hand an item over. Every sparring mode counts as
 * training — the gym's workouts, sparring wins, Nightmare and the Doghouse all
 * answer to the same flag — so these four partition every source in the game.
 */
export type ItemSource = "training" | "equipment" | "daily" | "career";

export const ITEM_SOURCES: { key: ItemSource; label: string; hint: string }[] = [
  { key: "training", label: "Training rewards", hint: "Gym workouts and every sparring mode: sparring wins, Nightmare and the Doghouse." },
  { key: "equipment", label: "Equipment level-up chests", hint: "Chests handed over when an equipment level is bought." },
  { key: "daily", label: "Daily rewards", hint: "The daily login chests." },
  { key: "career", label: "Career bouts", hint: "Chests won by taking a career fight." },
];

export interface ItemDefinition {
  id: string;
  name: string;
  /** Emoji / short text drawn as the item's icon in the Locker grid. */
  icon: string;
  /** Optional isometric pixel-art PNG (public path). Falls back to `icon` when absent. */
  iconImage?: string;
  /**
   * Key into the code-defined effect table (`itemEffects.ts`). Built-in items
   * use their own id; admin-authored items can point at any shipped effect.
   */
  effectId?: string;
  rarity: ItemRarity;
  /** Category flags — an item can be a Boost Item and also Consumable/Keepsake. */
  isBoost: boolean;
  isConsumable: boolean;
  isKeepsake: boolean;
  /** Max copies a save can ever obtain. Consumables lock to 9999; keepsakes default 1 (editable). */
  obtainableLimit: number;
  /** Synergy items may stack the same active boost multiple times. */
  synergy: boolean;
  /** Max simultaneous stacks when synergy is on (1–9999). */
  synergyStackCount: number;
  /**
   * How duplicate stacks combine. False (the default) compounds — each stack
   * multiplies the running total, so n copies of a 5× item give 5^n×. True
   * makes them additive: n copies give 5n×. Only multiplicative effects are
   * affected; percentage and flat effects always added linearly.
   */
  synergyAdditive: boolean;
  /** When false the item can't be sold at all; the sell amounts below are ignored. */
  sellable: boolean;
  /** Sell payout in Shards (0–999,999,999). */
  sellShards: number;
  /** Sell payout in Force (0–999,999,999). */
  sellForce: number;
  /** Sell payout in Diamonds (0–999,999,999). */
  sellDiamonds: number;
  /** Drop weighting used by reward draws, 0–100%. */
  rarityPercent: number;
  /**
   * Career rank the player must have reached before this item exists for them
   * at all — in the store and in every reward draw alike. Ranks count down, so
   * a threshold of 300 opens at 300th or better, and it stays open for good
   * once reached. Null = available from the start.
   */
  rankUnlockThreshold: number | null;
  /** Listed on the gym store's shelf. Force Bundles are never listed. */
  storeVisible: boolean;
  /** Store price in Force. Diamonds cover any shortfall — see diamondsForForce. */
  storeCostForce: number;
  /** Store price in Diamonds, charged on top of the Force price. Either may be 0. */
  storeCostDiamonds: number;
  /** Rank the player must have reached to buy it (lower is better). Null = no gate. */
  storeRankUnlock: number | null;
  /** Which reward paths may hand this item over. Every source is on by default. */
  sourceAllowed: Record<ItemSource, boolean>;
}

const STORAGE_KEY = "handz_items_config";

export const MAX_SYNERGY_STACK = 9999;
export const CONSUMABLE_LIMIT = 9999;
/** Cap on every per-currency sell amount. */
export const MAX_SELL_AMOUNT = 999999999;
/** Cap on an item's store price, same scale as the sell payouts. */
export const MAX_STORE_COST = 999999999;
/**
 * How many Diamonds it takes to cover a Force shortfall at the store counter.
 *
 * The rate is not flat: these anchors are the fixed points of the scale, and a
 * shortfall between two of them is priced by walking the line between them. A
 * shortfall past the last anchor keeps climbing at that final segment's rate.
 * One table so the quote, the purchase and the price label can never disagree.
 */
export const DIAMOND_COVERAGE: { force: number; diamonds: number }[] = [
  { force: 0, diamonds: 0 },
  { force: 2_500, diamonds: 1 },
  { force: 1_000_000, diamonds: 5_000 },
  { force: 1_000_000_000, diamonds: 150_000 },
];

/**
 * Diamonds needed to cover this much missing Force. Always rounded up and
 * never below 1 for a real shortfall — the last Diamond buys no change.
 */
export function diamondsForForce(shortfall: number): number {
  const need = Number.isFinite(shortfall) ? Math.max(0, Math.ceil(shortfall)) : 0;
  if (need <= 0) return 0;
  for (let i = 1; i < DIAMOND_COVERAGE.length; i++) {
    const hi = DIAMOND_COVERAGE[i];
    if (need > hi.force) continue;
    const lo = DIAMOND_COVERAGE[i - 1];
    const span = hi.force - lo.force;
    const t = span > 0 ? (need - lo.force) / span : 1;
    return Math.max(1, Math.ceil(lo.diamonds + t * (hi.diamonds - lo.diamonds)));
  }
  // Past the top anchor the scale simply carries on at its closing rate.
  const last = DIAMOND_COVERAGE[DIAMOND_COVERAGE.length - 1];
  const prev = DIAMOND_COVERAGE[DIAMOND_COVERAGE.length - 2];
  const rate = (last.diamonds - prev.diamonds) / (last.force - prev.force);
  return Math.max(1, Math.ceil(last.diamonds + (need - last.force) * rate));
}

/**
 * Force Bundles pay out Force, so listing them for a Force price would be a
 * closed loop. They are the one family the store never sells, whatever the
 * saved config says.
 */
export function isForceBundleId(id: string): boolean {
  return id === "force_bundle" || id.startsWith("force_bundle_");
}

/** Everything the store is allowed to put on the shelf right now. */
export function storeCatalog(items: ItemDefinition[]): ItemDefinition[] {
  return items.filter(d => d.storeVisible && !isForceBundleId(d.id));
}

/**
 * Ranks count down — #1 is the champion — so a gate of 50 opens once the player
 * is 50th or better. An unranked save has not reached any rank yet.
 */
export function storeRankMet(def: ItemDefinition, playerRank: number | null | undefined): boolean {
  if (def.storeRankUnlock == null) return true;
  return playerRank != null && playerRank <= def.storeRankUnlock;
}

/**
 * Has this career earned the item yet? A threshold, not a window: ranks count
 * down, so 300 means "300th or better", and the gate never shuts again once
 * the rank has been reached. That permanence is why the caller must hand in the
 * career's BEST rank rather than where the player sits today.
 *
 * One predicate for every way an item can arrive — reward draws, direct grants
 * and the gym store alike — and for every kind of item. A gate that only shut
 * the drop paths would still leave the item on the shelf.
 *
 * A save with no rank at all has reached nothing, so a gated item stays shut.
 */
export function rankUnlockMet(def: ItemDefinition, bestRank: number | null | undefined): boolean {
  if (def.rankUnlockThreshold == null) return true;
  return bestRank != null && bestRank <= def.rankUnlockThreshold;
}

/** The gate in words, for the message that explains a refusal. */
export function rankUnlockText(def: ItemDefinition): string {
  return def.rankUnlockThreshold == null
    ? "at any rank"
    : `once you reach rank ${def.rankUnlockThreshold}`;
}

/**
 * The threshold, migrated off the two-sided window it replaced. A gated item
 * used to carry lo/hi bounds and shut again above the better edge; the gate is
 * now "reach this rank and it is yours for good", so the better edge (hi) is
 * the number that survives — and a config that only ever set lo still means the
 * rank its admin typed in.
 */
function readRankUnlock(r: Record<string, unknown>): number | null {
  const pick = (v: unknown) =>
    typeof v === "number" && Number.isFinite(v) ? Math.max(1, Math.round(v)) : null;
  return pick(r.rankUnlockThreshold) ?? pick(r.rankExclusiveHi) ?? pick(r.rankExclusiveLo);
}

/**
 * May this reward path hand the item over? An untagged draw (no source) is
 * ungated, so a caller that forgets to declare itself still works — the flags
 * only ever narrow a source that names itself.
 */
export function itemAllowedFrom(def: ItemDefinition, source: ItemSource | null | undefined): boolean {
  if (!source) return true;
  // Optional-chained: a hand-edited import or a test fixture built without the
  // field still draws from everywhere, matching the backfill's default.
  return def.sourceAllowed?.[source] !== false;
}

/** Every source enabled — what a brand new item, and any item saved before the flags existed, gets. */
export function allSourcesAllowed(): Record<ItemSource, boolean> {
  return { training: true, equipment: true, daily: true, career: true };
}

function genItemId(): string {
  return typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function buildNewItem(): ItemDefinition {
  return {
    id: genItemId(),
    name: "New Item",
    icon: "🎁",
    rarity: "Journeyman",
    isBoost: false,
    isConsumable: false,
    isKeepsake: false,
    obtainableLimit: 1,
    synergy: false,
    synergyStackCount: 1,
    synergyAdditive: false,
    sellable: false,
    sellShards: 0,
    sellForce: 0,
    sellDiamonds: 0,
    rarityPercent: 0,
    rankUnlockThreshold: null,
    storeVisible: false,
    storeCostForce: 0,
    storeCostDiamonds: 0,
    storeRankUnlock: null,
    sourceAllowed: allSourcesAllowed(),
  };
}

function normalizeSources(raw: unknown): Record<ItemSource, boolean> {
  const r = (raw && typeof raw === "object") ? raw as Record<string, unknown> : null;
  const out = allSourcesAllowed();
  for (const s of ITEM_SOURCES) {
    const v = r ? r[s.key] : undefined;
    if (typeof v === "boolean") out[s.key] = v;
  }
  return out;
}

/** Backfill/normalize a raw stored item so configs saved before new fields existed keep working. */
function normalizeItem(raw: unknown): ItemDefinition | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || r.id === "") return null;
  const num = (v: unknown, def: number) =>
    typeof v === "number" && Number.isFinite(v) ? v : def;
  const rarity = ITEM_RARITIES.includes(r.rarity as ItemRarity)
    ? (r.rarity as ItemRarity)
    : "Journeyman";
  const isConsumable = r.isConsumable === true;
  const isKeepsake = !isConsumable && r.isKeepsake === true;
  const money = (v: unknown, def: number) =>
    Math.max(0, Math.min(MAX_SELL_AMOUNT, Math.round(num(v, def))));
  // Legacy configs stored a single Shards "sellPrice" and every item was sellable.
  const legacyShards = Math.max(0, Math.round(num(r.sellPrice, 0)));
  // Keepsakes are never sellable, whatever an older config or hand-edited import claims.
  const sellable = isKeepsake
    ? false
    : typeof r.sellable === "boolean" ? r.sellable : legacyShards > 0;
  const item: ItemDefinition = {
    id: r.id,
    name: typeof r.name === "string" ? r.name : "Unnamed Item",
    icon: typeof r.icon === "string" && r.icon !== "" ? r.icon : "🎁",
    iconImage: typeof r.iconImage === "string" && r.iconImage !== "" ? r.iconImage : undefined,
    effectId: typeof r.effectId === "string" && r.effectId !== "" ? r.effectId : undefined,
    rarity,
    isBoost: r.isBoost === true,
    isConsumable,
    isKeepsake,
    obtainableLimit: Math.max(1, Math.round(num(r.obtainableLimit, 1))),
    synergy: r.synergy === true,
    synergyStackCount: Math.max(1, Math.min(MAX_SYNERGY_STACK, Math.round(num(r.synergyStackCount, 1)))),
    synergyAdditive: r.synergyAdditive === true,
    sellable,
    sellShards: money(r.sellShards, legacyShards),
    sellForce: money(r.sellForce, 0),
    sellDiamonds: money(r.sellDiamonds, 0),
    rarityPercent: Math.max(0, Math.min(100, num(r.rarityPercent, 0))),
    rankUnlockThreshold: readRankUnlock(r),
    // A config saved before the store existed lists nothing, so the shelf stays
    // empty until an admin stocks it rather than dumping the whole catalog on it.
    storeVisible: !isForceBundleId(r.id) && r.storeVisible === true,
    storeCostForce: Math.max(0, Math.min(MAX_STORE_COST, Math.round(num(r.storeCostForce, 0)))),
    storeCostDiamonds: Math.max(0, Math.min(MAX_STORE_COST, Math.round(num(r.storeCostDiamonds, 0)))),
    storeRankUnlock: typeof r.storeRankUnlock === "number" && Number.isFinite(r.storeRankUnlock)
      ? Math.max(1, Math.round(r.storeRankUnlock))
      : null,
    // Unlike the store flags, an item saved before the source gates existed
    // stays available everywhere — the gates take away, so silence means "all".
    sourceAllowed: normalizeSources(r.sourceAllowed),
  };
  if (item.isConsumable) item.obtainableLimit = CONSUMABLE_LIMIT;
  return item;
}

// Cache keyed on the raw string so hot paths don't re-parse but saves apply immediately.
let cachedRaw: string | null = null;
let cachedItems: ItemDefinition[] | null = null;

/**
 * The shipped catalog plus whatever the admin saved.
 *
 * Built-ins always exist so a fresh save has the full item list; a saved entry
 * with the same id overrides its built-in field-for-field (that's how the Items
 * editor tunes shipped items), and admin-authored items are appended.
 */
/**
 * True when the saved copy still points at a family's single untinted sprite
 * while the shipped item has moved to its own rarity-tinted variant of that
 * exact file (see script/recolorItemIcons.ts). Configs saved before the tinted
 * art existed carry the old path, which would otherwise override the new art
 * and show every tier of Headgear Strap / Refinement Tome in the same colour.
 * Genuinely custom artwork points somewhere else and is left alone.
 */
function isPreTintArt(builtInImage: string | undefined, savedImage: string | undefined, rarity: ItemRarity): boolean {
  if (!builtInImage || !savedImage || builtInImage === savedImage) return false;
  const suffix = `_${rarity.toLowerCase()}.png`;
  return builtInImage.endsWith(suffix) && savedImage === `${builtInImage.slice(0, -suffix.length)}.png`;
}

function mergeWithBuiltIns(saved: ItemDefinition[]): ItemDefinition[] {
  const savedById = new Map(saved.map(i => [i.id, i]));
  const merged = DEFAULT_ITEMS.map(builtIn => {
    const override = savedById.get(builtIn.id);
    if (!override) return builtIn;
    savedById.delete(builtIn.id);
    // Effect wiring lives in code, so a saved copy from before effects existed
    // still resolves to the built-in's effect.
    const iconImage = isPreTintArt(builtIn.iconImage, override.iconImage, builtIn.rarity)
      ? builtIn.iconImage
      : override.iconImage ?? builtIn.iconImage;
    return { ...override, effectId: override.effectId ?? builtIn.effectId, iconImage };
  });
  return [...merged, ...Array.from(savedById.values())];
}

/**
 * Items pulled from the game after release.
 *
 * Deleting the seed from the shipped catalog is not enough: a saved config keeps
 * its own copy of every item the admin has touched, and the merge below treats a
 * saved id with no matching built-in as an admin-authored item — so the retired
 * item would come straight back as a custom entry. Filtering on every load
 * (rather than once, stamped) also covers a tuning bundle exported before the
 * retirement, which carries the whole old catalog with it.
 *
 * Copies sitting in existing lockers are cleared separately, by
 * `purgeRetiredItems` in the item inventory layer.
 */
export const RETIRED_ITEM_IDS: readonly string[] = ["ac_fan"];

export function isRetiredItemId(id: string): boolean {
  return RETIRED_ITEM_IDS.includes(id);
}

/**
 * Shipped items whose category changed after release. A saved copy overrides the
 * built-in wholesale, so anyone who has opened the Items editor would otherwise
 * keep the old category forever. Each id is force-reset to the built-in's
 * categories exactly once and then stamped, so a later edit in the editor sticks.
 */
const RECATEGORIZED_ITEM_IDS = ["goats_blessing", "spartas_trophy"];
const RECATEGORIZED_KEY = "handz_items_recategorized";

function applyCategoryResets(items: ItemDefinition[]): ItemDefinition[] {
  if (typeof localStorage === "undefined") return items;
  let done: string[] = [];
  try {
    const parsed = JSON.parse(localStorage.getItem(RECATEGORIZED_KEY) ?? "[]");
    if (Array.isArray(parsed)) done = parsed.filter(id => typeof id === "string");
  } catch { /* a corrupt stamp just means the reset runs again, which is harmless */ }
  const pending = RECATEGORIZED_ITEM_IDS.filter(id => !done.includes(id));
  if (pending.length === 0) return items;

  const out = items.map(item => {
    if (!pending.includes(item.id)) return item;
    const builtIn = DEFAULT_ITEMS.find(d => d.id === item.id);
    if (!builtIn) return item;
    return {
      ...item,
      isBoost: builtIn.isBoost,
      isConsumable: builtIn.isConsumable,
      isKeepsake: builtIn.isKeepsake,
      obtainableLimit: builtIn.obtainableLimit,
      sellable: builtIn.sellable,
    };
  });
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(out));
    localStorage.setItem(RECATEGORIZED_KEY, JSON.stringify([...done, ...pending]));
  } catch { /* out of storage: the reset simply retries on the next load */ }
  return out;
}

export function loadItemsConfig(): ItemDefinition[] {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(STORAGE_KEY) : null;
    if (!raw) { cachedRaw = null; cachedItems = null; return DEFAULT_ITEMS; }
    if (raw === cachedRaw && cachedItems) return cachedItems;
    const parsed = JSON.parse(raw);
    const items = applyCategoryResets(mergeWithBuiltIns(Array.isArray(parsed)
      ? (parsed.map(normalizeItem).filter(Boolean) as ItemDefinition[]).filter(i => !isRetiredItemId(i.id))
      : []));
    cachedRaw = raw;
    cachedItems = items;
    return items;
  } catch {
    return DEFAULT_ITEMS;
  }
}

export function saveItemsConfig(items: ItemDefinition[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
  cachedRaw = null;
  cachedItems = null;
}

export function getItemDefinition(itemId: string): ItemDefinition | undefined {
  return loadItemsConfig().find(i => i.id === itemId);
}
