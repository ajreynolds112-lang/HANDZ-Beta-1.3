/**
 * Item families — the tier ladders behind names like "Electrolyte Bottle I…VI".
 *
 * Tiered items ship as separate ids (`electrolyte_bottle_journeyman` …
 * `_goat`), so nothing in the data model tied them together. Synergy needs
 * that link: a family with synergy on shares ONE stack pool, so three bottles
 * means three bottles total across every tier, not three of each.
 *
 * The family is keyed off the item's base name (its name minus a trailing
 * Roman numeral) rather than its id, because the shipped catalog builds tier
 * ids two different ways (`_rarity` suffixes for `tiered()` families, `_ii`
 * suffixes for hand-written ones) and admin-authored items follow neither.
 * Base name is the one signal that holds for all three — and it matches what
 * a player means by "the same item".
 */
import { loadItemsConfig, type ItemDefinition } from "@/game/itemsConfig";

/**
 * Recognised tier numerals. A closed list rather than a general Roman-numeral
 * pattern on purpose: `[IVXLCDM]+` would read the "C" in "Vitamin C" as a tier
 * and silently pool two unrelated items.
 */
const TIER_NUMERALS = new Set([
  "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI", "XII",
]);

/** The tier numeral ending a name, or null when the name isn't a tier. */
function tierSuffix(name: string): string | null {
  const m = /\s+([A-Za-z]+)$/.exec(name.trim());
  if (!m) return null;
  const numeral = m[1].toUpperCase();
  return TIER_NUMERALS.has(numeral) ? numeral : null;
}

/** "Electrolyte Bottle IV" → "Electrolyte Bottle". Untiered names pass through. */
export function itemFamilyName(name: string): string {
  const trimmed = (name ?? "").trim();
  if (!tierSuffix(trimmed)) return trimmed;
  const stripped = trimmed.replace(/\s+[A-Za-z]+$/, "").trim();
  // A name that is nothing but a numeral ("IV") keeps its own name as the base.
  return stripped === "" ? trimmed : stripped;
}

/**
 * Case/space-insensitive key two tiers of the same item agree on.
 *
 * Only names carrying a tier numeral can share a key — anything else is its
 * own family, keyed by id, so two same-named items never merge by accident.
 */
export function itemFamilyKey(def: Pick<ItemDefinition, "id" | "name">): string {
  const name = (def.name ?? "").trim();
  if (!tierSuffix(name)) return `#${def.id}`;
  const base = itemFamilyName(name).toLowerCase().replace(/\s+/g, " ");
  return base === "" ? `#${def.id}` : base;
}

export interface ItemFamily {
  /** Shared key every member resolves to. */
  key: string;
  /** Display name without the tier numeral, e.g. "Electrolyte Bottle". */
  baseName: string;
  /** Every item id in the family, including the one asked about. */
  memberIds: string[];
  /** True when ANY member is flagged as a synergy item. */
  synergy: boolean;
  /** Shared stack ceiling — the largest count any synergy member asks for. */
  stackCount: number;
  /** True when the family's stacks add up instead of compounding. */
  additive: boolean;
  /** True when the family spans more than one tier. */
  tiered: boolean;
}

/**
 * Resolve the synergy rules that apply to `def`, pooled across its whole tier
 * ladder. Synergy turns on for the family as soon as one member has it, and
 * the ceiling is the largest count any of those members declares — so a mixed
 * legacy config still lands on one coherent answer instead of a per-tier
 * free-for-all.
 */
export function getItemFamily(
  def: Pick<ItemDefinition, "id" | "name">,
  all: ItemDefinition[] = loadItemsConfig(),
): ItemFamily {
  const key = itemFamilyKey(def);
  const members = all.filter(i => itemFamilyKey(i) === key);
  // An item missing from the catalog (deleted mid-save) is its own family.
  if (members.length === 0) {
    return { key, baseName: itemFamilyName(def.name ?? ""), memberIds: [def.id], synergy: false, stackCount: 1, additive: false, tiered: false };
  }
  const synergyMembers = members.filter(m => m.synergy);
  const stackCount = synergyMembers.reduce((max, m) => Math.max(max, Math.max(1, m.synergyStackCount)), 1);
  return {
    key,
    baseName: itemFamilyName(members[0].name),
    memberIds: members.map(m => m.id),
    synergy: synergyMembers.length > 0,
    stackCount,
    additive: synergyMembers.some(m => m.synergyAdditive),
    tiered: members.length > 1,
  };
}

/** Total stacks currently armed across every tier of the family. */
export function familyActiveStacks(
  activeBoosts: Record<string, number> | undefined | null,
  memberIds: string[],
): number {
  if (!activeBoosts) return 0;
  return memberIds.reduce((n, id) => n + (activeBoosts[id] ?? 0), 0);
}

/**
 * Trim armed stacks down to the synergy ceiling of each family.
 *
 * The activation check only guards new arms, so a save made before a family
 * shared its pool (or before the admin lowered the ceiling) can already hold
 * more stacks than the rule now allows. Every inventory read runs through this
 * so the extra stacks neither apply nor persist. Members are trimmed from the
 * end of the catalog backwards, so the earliest tiers keep their stacks.
 *
 * Returns the same object when nothing is over the cap, so callers can cheaply
 * tell whether anything changed.
 */
export function clampFamilyStacks(
  active: Record<string, number>,
  all: ItemDefinition[] = loadItemsConfig(),
): Record<string, number> {
  const armed = Object.keys(active).filter(id => (active[id] ?? 0) > 0);
  if (armed.length === 0) return active;

  const byId = new Map(all.map(i => [i.id, i]));
  const families = new Map<string, string[]>();
  for (const def of all) {
    if (!byId.has(def.id)) continue;
    const key = itemFamilyKey(def);
    const list = families.get(key);
    if (list) list.push(def.id); else families.set(key, [def.id]);
  }

  let out: Record<string, number> | null = null;
  for (const [key, memberIds] of Array.from(families.entries())) {
    const armedMembers = memberIds.filter(id => (active[id] ?? 0) > 0);
    if (armedMembers.length === 0) continue;
    const family = getItemFamily(byId.get(armedMembers[0])!, all);
    // Without synergy each tier keeps its own single slot — no shared pool.
    if (!family.synergy) {
      for (const id of armedMembers) {
        if ((active[id] ?? 0) > 1) {
          out = out ?? { ...active };
          out[id] = 1;
        }
      }
      continue;
    }
    const cap = Math.max(1, family.stackCount);
    let total = armedMembers.reduce((n, id) => n + (active[id] ?? 0), 0);
    if (total <= cap) continue;
    out = out ?? { ...active };
    for (let i = armedMembers.length - 1; i >= 0 && total > cap; i--) {
      const id = armedMembers[i];
      const drop = Math.min(out[id], total - cap);
      out[id] -= drop;
      total -= drop;
      if (out[id] === 0) delete out[id];
    }
    void key;
  }
  return out ?? active;
}

/**
 * The synergy patch to apply when the admin edits one tier — every member of
 * the family gets the same flag and ceiling, so the editor can never leave a
 * ladder half-configured.
 */
export function familySynergyPatch(
  all: ItemDefinition[],
  def: Pick<ItemDefinition, "id" | "name">,
  patch: { synergy?: boolean; synergyStackCount?: number; synergyAdditive?: boolean },
): ItemDefinition[] {
  const key = itemFamilyKey(def);
  return all.map(it => (itemFamilyKey(it) === key ? { ...it, ...patch } : it));
}
