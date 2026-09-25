/**
 * Item Distribution config — how many boost items a career opponent walks into
 * the ring carrying, and which rarities those items are drawn from.
 *
 * Shape deliberately mirrors the crate-odds model on the same page: six
 * percentage sliders that always total 100, plus a per-band count. The count
 * decides how many item slots are rolled; the odds decide what each slot is.
 *
 * Kept in its own localStorage key (not inside the Roster Generation config)
 * because this tab auto-saves on every edit, while the generation tab stays
 * behind its explicit Save button — sharing a blob would let one commit the
 * other's half-finished edits.
 */
import { buildBandBounds } from "./rosterGenConfig";
import { ITEM_RARITIES, loadItemsConfig, type ItemDefinition, type ItemRarity } from "./itemsConfig";
import { effectOf } from "./itemEffects";
import { familyActiveStacks, getItemFamily } from "./itemFamily";

/** Percentage odds per rarity; the six values always add up to 100. */
export type RarityChances = Record<ItemRarity, number>;

export interface ItemDistBand {
  /** Numerically higher (worse) rank bound, inclusive. */
  hiRank: number;
  /** Numerically lower (better) rank bound, inclusive. */
  loRank: number;
  /** Per-rarity chance (%) that a rolled slot draws from that rarity. Sums to 100. */
  chances: RarityChances;
  /** How many boost items opponents in this band carry (0–40; 0 = none). */
  count: number;
}

export interface ItemDistConfig {
  bands: ItemDistBand[];
  /** Rank 1 champion is configured on its own, exactly like the crate odds. */
  rank1Chances: RarityChances;
  rank1Count: number;
  /**
   * % chance (0–100) that any career opponent also walks in wearing one
   * keepsake, on top of whatever boost slots their band rolls. Beating them
   * hands it over, so this is the only way to win a keepsake off a fighter.
   */
  keepsakeChancePct: number;
}

/** Most boost items a single opponent can be handed. */
export const ITEM_COUNT_MAX = 40;

/** Default odds an opponent carries a keepsake the player hasn't collected. */
export const KEEPSAKE_CHANCE_DEFAULT = 2;

export function clampKeepsakeChance(v: unknown): number {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.round(v) : 0;
  return Math.max(0, Math.min(100, n));
}

const STORAGE_KEY = "handz_item_dist_config";

export function clampItemCount(v: unknown): number {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.round(v) : 0;
  return Math.max(0, Math.min(ITEM_COUNT_MAX, n));
}

function zeroChances(): RarityChances {
  return ITEM_RARITIES.reduce((acc, r) => { acc[r] = 0; return acc; }, {} as RarityChances);
}

/** An even 100-point split across the given rarities (remainder to the first). */
export function chancesFromRarityList(list: ItemRarity[]): RarityChances {
  const out = zeroChances();
  const ids = list.filter(r => ITEM_RARITIES.includes(r));
  if (ids.length === 0) return out;
  const each = Math.floor(100 / ids.length);
  for (const r of ids) out[r] = each;
  out[ids[0]] += 100 - each * ids.length;
  return out;
}

/**
 * Coerce stored/edited odds into six non-negative integers summing to exactly
 * 100. Anything unusable (missing, all zero, NaN) falls back to `fallback`.
 */
export function normalizeRarityChances(raw: unknown, fallback: RarityChances): RarityChances {
  const src = (raw ?? {}) as Record<string, unknown>;
  const vals = zeroChances();
  let total = 0;
  for (const r of ITEM_RARITIES) {
    const v = src[r];
    const n = typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
    vals[r] = n;
    total += n;
  }
  if (total <= 0) return { ...fallback };
  const out = zeroChances();
  let assigned = 0;
  for (const r of ITEM_RARITIES) {
    out[r] = Math.round((vals[r] / total) * 100);
    assigned += out[r];
  }
  if (assigned !== 100) {
    const biggest = ITEM_RARITIES.reduce((a, b) => (out[b] > out[a] ? b : a), ITEM_RARITIES[0]);
    out[biggest] = Math.max(0, out[biggest] + (100 - assigned));
  }
  return out;
}

/**
 * Move one rarity to `next`% and spread the remaining 100−next across the other
 * five in proportion to what they hold now (evenly when they're all at zero).
 * Largest-remainder allocation, so the six values are always non-negative
 * integers totalling exactly 100 — no intermediate slider state can drift off.
 */
export function rebalanceRarityChances(chances: RarityChances, moved: ItemRarity, next: number): RarityChances {
  const target = Math.max(0, Math.min(100, Math.round(next)));
  const others = ITEM_RARITIES.filter(r => r !== moved);
  const rest = 100 - target;
  const out = zeroChances();
  out[moved] = target;
  const currentRest = others.reduce((sum, r) => sum + Math.max(0, chances?.[r] ?? 0), 0);
  const shares = others.map(r => {
    const weight = currentRest > 0 ? Math.max(0, chances?.[r] ?? 0) / currentRest : 1 / others.length;
    return { r, exact: rest * weight };
  });
  let assigned = 0;
  for (const s of shares) {
    out[s.r] = Math.floor(s.exact);
    assigned += out[s.r];
  }
  // Hand the rounding remainder to the largest fractional parts first.
  const leftovers = shares
    .map(s => ({ r: s.r, frac: s.exact - Math.floor(s.exact) }))
    .sort((a, b) => b.frac - a.frac);
  let remainder = rest - assigned;
  for (let i = 0; i < leftovers.length && remainder > 0; i++, remainder--) {
    out[leftovers[i].r]++;
  }
  return out;
}

/** Rarity a band's items lean toward by default — richer the higher the rank. */
function defaultRarityFor(rank: number): ItemRarity {
  if (rank <= 1) return "GOAT";
  if (rank <= 9) return "Undisputed";
  if (rank <= 49) return "Champion";
  if (rank <= 199) return "Elite";
  if (rank <= 499) return "Contender";
  return "Journeyman";
}

/**
 * Defaults hand out zero items everywhere. Opponents only start carrying gear
 * once the user raises a band's count, so adding this feature never silently
 * changes the difficulty of an existing career.
 */
export function buildDefaultItemDistConfig(): ItemDistConfig {
  const bands: ItemDistBand[] = buildBandBounds().map(({ hiRank, loRank }) => {
    const mid = Math.round((hiRank + loRank) / 2);
    return { hiRank, loRank, chances: chancesFromRarityList([defaultRarityFor(mid)]), count: 0 };
  });
  return {
    bands,
    rank1Chances: chancesFromRarityList([defaultRarityFor(1)]),
    rank1Count: 0,
    // Keepsakes are the exception to the zero-by-default rule: they are pure
    // collectibles the player can only win off an opponent, so the carry
    // chance ships switched on.
    keepsakeChancePct: KEEPSAKE_CHANCE_DEFAULT,
  };
}

// Parsed-config cache keyed on the raw string, so per-fight rolls don't
// re-parse while a save from any tab is still picked up immediately.
let cachedRaw: string | null = null;
let cachedCfg: ItemDistConfig | null = null;

/** The saved config, backfilled against the current band layout. */
export function loadItemDistConfig(): ItemDistConfig {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(STORAGE_KEY) : null;
    if (!raw) { cachedRaw = null; cachedCfg = null; return buildDefaultItemDistConfig(); }
    if (raw === cachedRaw && cachedCfg) return cachedCfg;
    const parsed = JSON.parse(raw) as Partial<ItemDistConfig>;
    const defaults = buildDefaultItemDistConfig();
    if (!parsed || !Array.isArray(parsed.bands) || parsed.bands.length === 0) return defaults;
    // Rebuild off the canonical band list so a stored config from an older
    // band layout can never drop or duplicate a rank range.
    const saved = new Map(parsed.bands.map(b => [`${b.hiRank}-${b.loRank}`, b]));
    const bands = defaults.bands.map(def => {
      const b = saved.get(`${def.hiRank}-${def.loRank}`);
      if (!b) return def;
      return {
        hiRank: def.hiRank,
        loRank: def.loRank,
        chances: normalizeRarityChances(b.chances, def.chances),
        count: clampItemCount(b.count),
      };
    });
    const cfg: ItemDistConfig = {
      bands,
      rank1Chances: normalizeRarityChances(parsed.rank1Chances, defaults.rank1Chances),
      rank1Count: clampItemCount(parsed.rank1Count),
      // A config saved before keepsake carry existed has no field at all — that
      // is "never configured", not "set to zero", so it takes the default.
      keepsakeChancePct: parsed.keepsakeChancePct == null
        ? defaults.keepsakeChancePct
        : clampKeepsakeChance(parsed.keepsakeChancePct),
    };
    cachedRaw = raw;
    cachedCfg = cfg;
    return cfg;
  } catch {
    return buildDefaultItemDistConfig();
  }
}

export function saveItemDistConfig(cfg: ItemDistConfig): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
  } catch {}
  cachedRaw = null;
  cachedCfg = null;
}

export function clearItemDistConfig(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {}
  cachedRaw = null;
  cachedCfg = null;
}

/** Odds + item count configured for an opponent sitting at this rank. */
export function getItemDistForRank(rank: number, cfg: ItemDistConfig = loadItemDistConfig()): { chances: RarityChances; count: number } {
  if (rank <= 1) return { chances: cfg.rank1Chances, count: clampItemCount(cfg.rank1Count) };
  const band = cfg.bands.find(b => rank <= b.hiRank && rank >= b.loRank);
  if (!band) return { chances: zeroChances(), count: 0 };
  return { chances: band.chances, count: clampItemCount(band.count) };
}

// ---------------------------------------------------------------------------
// Rolling an opponent's kit
// ---------------------------------------------------------------------------

/**
 * Boost items that can actually do something for an AI opponent: a Boost Item
 * whose effect moves at least one combat value. Gym-income, training-only and
 * payout boosts (Fight Surge's Force multiplier) are excluded — they'd occupy
 * a slot and a HUD icon while changing nothing in the ring. So is the 24h AC
 * slot, which is a gym fixture rather than fight gear.
 *
 * Keepsakes never ride in an ordinary slot, whatever flags a saved catalog
 * puts on them: they are collection items, and the only route onto an opponent
 * is the keepsake pool below, which is filtered against what the player
 * already holds. A keepsake reaching a boost slot would skip that filter and
 * hand out one the player can never win.
 */
export function assignableBoostItems(defs: ItemDefinition[] = loadItemsConfig()): ItemDefinition[] {
  return defs.filter(d => {
    if (!d.isBoost || d.isKeepsake) return false;
    const e = effectOf(d);
    if (!e || !e.fightScope) return false;
    if (e.duration === "instant" || e.duration === "24h") return false;
    return !!(e.powerPct || e.speedPct || e.defensePct || e.staminaPct || e.focusPct
      || e.dodgePct || e.critPct || e.staminaRecoveryPct || e.stunChancePct || e.kdAvoidChance);
  });
}

/**
 * Every keepsake in the catalog, boost-flagged or not. Unlike the boost pool
 * these are not filtered by what they do in the ring — an opponent carries a
 * keepsake as loot, and the player wins it by beating them.
 */
export function assignableKeepsakeItems(defs: ItemDefinition[] = loadItemsConfig()): ItemDefinition[] {
  return defs.filter(d => d.isKeepsake);
}

/** Pick a rarity from the six weighted odds. */
function pickRarity(chances: RarityChances, rnd: () => number): ItemRarity | null {
  const total = ITEM_RARITIES.reduce((sum, r) => sum + Math.max(0, chances?.[r] ?? 0), 0);
  if (total <= 0) return null;
  let roll = rnd() * total;
  for (const r of ITEM_RARITIES) {
    roll -= Math.max(0, chances?.[r] ?? 0);
    if (roll <= 0) return r;
  }
  return ITEM_RARITIES[ITEM_RARITIES.length - 1];
}

/** Weighted pick inside a rarity, using each item's own drop weighting. */
function pickItem(candidates: ItemDefinition[], rnd: () => number): ItemDefinition | null {
  if (candidates.length === 0) return null;
  const total = candidates.reduce((sum, d) => sum + Math.max(0, d.rarityPercent ?? 0), 0);
  if (total <= 0) return candidates[Math.floor(rnd() * candidates.length)] ?? candidates[0];
  let roll = rnd() * total;
  for (const d of candidates) {
    roll -= Math.max(0, d.rarityPercent ?? 0);
    if (roll <= 0) return d;
  }
  return candidates[candidates.length - 1];
}

/** Flat pick — every candidate equally likely, ignoring drop weighting. */
function pickUniform(candidates: ItemDefinition[], rnd: () => number): ItemDefinition | null {
  if (candidates.length === 0) return null;
  return candidates[Math.min(candidates.length - 1, Math.floor(rnd() * candidates.length))] ?? null;
}

/**
 * Can this item take one more copy on top of what's already assigned?
 *
 * - Keepsakes: one of each, ever.
 * - Synergy items: up to the family's shared stack ceiling, pooled across tiers.
 * - Everything else: a single active copy, same as the player's locker allows.
 */
function hasRoom(def: ItemDefinition, assigned: Record<string, number>, defs: ItemDefinition[]): boolean {
  if (def.isKeepsake) return (assigned[def.id] ?? 0) < 1;
  const family = getItemFamily(def, defs);
  if (family.synergy) return familyActiveStacks(assigned, family.memberIds) < family.stackCount;
  return (assigned[def.id] ?? 0) < 1;
}

/**
 * Roll the items a career opponent at `rank` carries into the fight.
 * Returns an item-id → stacks map shaped like a locker's `activeBoosts`.
 *
 * The band's slot count is a promise, not a ceiling: every slot gets filled.
 * A slot rolls its rarity from the odds as before, but if that rarity has
 * nothing left to give (its items are all at their ceiling) the slot falls
 * back to any item that still has room rather than going to waste. Only a
 * genuinely exhausted catalog leaves an opponent short.
 *
 * `alreadyOwnedKeepsakeIds` are the keepsakes the player already holds — by any
 * measure the claim respects, not just the received list. They are dropped
 * from the keepsake pool, so a carried keepsake is always one the player can
 * actually win, and the pick is flat across what is left so the pool rotates
 * through the whole catalog instead of leaning on drop weights. Passing `null`
 * means the collection is unknown (no save behind this fight): the opponent
 * then carries no keepsake at all rather than one that might be unwinnable.
 *
 * `keepsakesUnrestricted` flips on once the player owns every keepsake and
 * every Lucky Coin. There is nothing left to win, so keepsakes stop being a
 * single bonus slot and join the ordinary pool: an opponent can wear any of
 * them, and as many as their configured item count has room for. Keepsakes
 * ignore the rarity odds while they sit in that pool — every one of them is a
 * candidate for every slot, so a GOAT keepsake is as reachable as a Journeyman
 * one instead of waiting on its rarity to be rolled.
 */
export function rollOpponentItems(
  rank: number,
  cfg: ItemDistConfig = loadItemDistConfig(),
  rnd: () => number = Math.random,
  alreadyOwnedKeepsakeIds: readonly string[] | null = [],
  keepsakesUnrestricted = false,
): Record<string, number> {
  const { chances, count } = getItemDistForRank(rank, cfg);
  const assigned: Record<string, number> = {};
  const defs = loadItemsConfig();
  const owned = new Set(alreadyOwnedKeepsakeIds ?? []);
  const keepsakePool = alreadyOwnedKeepsakeIds == null
    ? []
    : assignableKeepsakeItems(defs).filter(d => keepsakesUnrestricted || !owned.has(d.id));
  const pool = keepsakesUnrestricted
    ? [...assignableBoostItems(defs), ...keepsakePool]
    : assignableBoostItems(defs);
  if (count > 0 && pool.length > 0) {
    for (let slot = 0; slot < count; slot++) {
      const rarity = pickRarity(chances, rnd);
      // Keepsakes sit outside the rarity draw — they are eligible for any slot.
      let candidates = rarity
        ? pool.filter(d => (d.isKeepsake || d.rarity === rarity) && hasRoom(d, assigned, defs))
        : [];
      if (candidates.length === 0) candidates = pool.filter(d => hasRoom(d, assigned, defs));
      const pick = pickItem(candidates, rnd);
      if (!pick) break;
      assigned[pick.id] = (assigned[pick.id] ?? 0) + 1;
    }
  }
  // Keepsake carry runs whatever the band's boost count is — a band handing out
  // zero boost items can still field an opponent wearing a keepsake. Once the
  // collection is complete the keepsakes ride in the pool above instead, inside
  // the configured item count, so this bonus slot stops.
  const keepsakeChance = clampKeepsakeChance(cfg.keepsakeChancePct);
  if (!keepsakesUnrestricted && keepsakeChance > 0 && rnd() * 100 < keepsakeChance) {
    const pick = pickUniform(keepsakePool.filter(d => hasRoom(d, assigned, defs)), rnd);
    if (pick) assigned[pick.id] = (assigned[pick.id] ?? 0) + 1;
  }
  return assigned;
}
