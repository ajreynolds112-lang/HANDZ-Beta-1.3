/**
 * Buying Equipment Upgrade levels.
 *
 * Every purchase is a single save write: the Force/Diamond spend, the new
 * level and any chest the level earned all land together, read from one fresh
 * copy of the save. The reveal that follows only displays items the locker
 * already holds.
 */
import type { Fighter, InsertFighter, CareerRosterState } from "@shared/schema";
import * as localSaves from "@/lib/localSaves";
import { rollCrateForFighter } from "@/lib/itemInventory";
import type { CrateId } from "@/game/cratesConfig";
import {
  EQUIPMENT,
  EQUIPMENT_SLOTS,
  type EquipmentLevels,
  type EquipmentSlot,
  normalizeEquipmentLevels,
  quoteEquipmentUpgrade,
  unlockedEquipmentSlots,
} from "@/game/equipmentConfig";

/** The five levels a save currently holds. Absent slots read as zero. */
export function getEquipmentLevels(fighter: Fighter | null | undefined): EquipmentLevels {
  return normalizeEquipmentLevels(fighter?.equipment ?? null);
}

/** Career wins, which is what every equipment unlock threshold is measured in. */
export function equipmentCareerWins(fighter: Fighter | null | undefined): number {
  return fighter?.wins ?? 0;
}

export interface EquipmentPurchaseResult {
  ok: boolean;
  message?: string;
  /** The persisted save after the purchase. */
  fighter?: Fighter;
  /** The chest this level earned, already granted to the locker. */
  crate?: { crateId: CrateId; itemIds: string[] } | null;
  /** The level just bought. */
  level?: number;
}

/**
 * Buy the next level of one piece.
 *
 * Reads the save immediately before writing so a held-down buy button can never
 * price a level off a stale balance, and folds the chest's items into the same
 * write as the spend.
 */
export function buyEquipmentLevel(fighterId: string, slot: EquipmentSlot): EquipmentPurchaseResult {
  const fighter = localSaves.getFighter(fighterId);
  if (!fighter) return { ok: false, message: "Save not found" };

  const def = EQUIPMENT[slot];
  const wins = equipmentCareerWins(fighter);
  if (wins < def.unlockWins) {
    return { ok: false, message: `${def.name} unlocks at ${def.unlockWins} career ${def.unlockWins === 1 ? "win" : "wins"}.` };
  }

  const levels = getEquipmentLevels(fighter);
  const purse = { force: fighter.force ?? 0, diamonds: fighter.diamonds ?? 0 };
  const quote = quoteEquipmentUpgrade(slot, levels[slot], purse);
  if (quote.maxed) return { ok: false, message: `${def.name} is fully upgraded.` };
  if (!quote.affordable) {
    // Every level now carries a diamond, so name whichever purse is actually short.
    const shortForce = (purse.force ?? 0) < quote.force;
    const shortGems = (purse.diamonds ?? 0) < quote.diamonds;
    return {
      ok: false,
      message: shortForce && shortGems
        ? "Not enough Force or Diamonds."
        : shortGems ? "Not enough Diamonds." : "Not enough Force.",
    };
  }

  const nextLevels: Record<string, number> = { ...levels, [slot]: quote.targetLevel };

  // Chests are granted here, at the moment the level is bought, from the same
  // read of the save the spend came off. The reveal is display only.
  const rank = (fighter.careerRosterState as CareerRosterState | null)?.playerRank ?? null;
  const roll = quote.crate ? rollCrateForFighter(fighter, quote.crate, rank, false, "equipment") : null;

  const patch: Partial<InsertFighter> = {
    force: Math.max(0, Math.round((fighter.force ?? 0) - quote.force)),
    equipment: nextLevels,
  };
  if (quote.diamonds > 0) patch.diamonds = Math.max(0, (fighter.diamonds ?? 0) - quote.diamonds);
  if (roll?.inventory) patch.itemInventory = roll.inventory as Fighter["itemInventory"];

  const updated = localSaves.updateFighter(fighterId, patch);
  return {
    ok: true,
    fighter: updated,
    level: quote.targetLevel,
    crate: quote.crate && roll && roll.itemIds.length > 0
      ? { crateId: quote.crate, itemIds: roll.itemIds }
      : null,
  };
}

/**
 * Record every unlock the player has reached as announced — called when the
 * Equipment Upgrades page opens, which is what clears the hub milestone and the
 * dot on the gym crate.
 *
 * Rebuilt from a fresh read of the roster state: every handler here writes the
 * whole blob, so starting from a stale snapshot would roll back a sibling's
 * field.
 */
/**
 * The unlocks the hub's "new gear" overlay should announce right now, recorded
 * as announced in the same call so it can only ever be raised once. Returns an
 * empty list when there is nothing new.
 *
 * Kept apart from markEquipmentSlotsSeen because the two answer different
 * questions: this one is "has the player been told", which a single overlay
 * settles forever, while `seen` is "has the player looked", which only opening
 * the Equipment Upgrades page settles and which the crate's red dot rides on.
 * Announcing therefore leaves the dot alone.
 *
 * Read off a fresh copy of the save, not a caller's snapshot: the win that
 * cleared the threshold is written by a payout handler, and every handler here
 * writes the whole roster blob.
 */
export function takeEquipmentUnlockAnnouncement(
  fighterId: string,
): { slots: EquipmentSlot[]; fighter?: Fighter } {
  const fighter = localSaves.getFighter(fighterId);
  const roster = fighter?.careerRosterState as CareerRosterState | null | undefined;
  if (!fighter || !roster) return { slots: [] };
  const seen = new Set(roster.equipmentSeenSlots ?? []);
  const announced = new Set(roster.equipmentAnnouncedSlots ?? []);
  const fresh = unlockedEquipmentSlots(equipmentCareerWins(fighter))
    .filter(slot => !seen.has(slot) && !announced.has(slot));
  if (fresh.length === 0) return { slots: [] };
  for (const slot of fresh) announced.add(slot);
  const updated = localSaves.updateFighter(fighterId, {
    careerRosterState: {
      ...roster,
      // Ordered by the slot list so the stored value is stable across writes.
      equipmentAnnouncedSlots: EQUIPMENT_SLOTS.filter(s => announced.has(s)),
    },
  } as Partial<InsertFighter>);
  // Handed back so the caller can replace its own snapshot: a screen still
  // holding the pre-announcement blob would write the flag straight back out.
  return { slots: fresh, fighter: updated };
}

export function markEquipmentSlotsSeen(fighterId: string): Fighter | undefined {
  const fighter = localSaves.getFighter(fighterId);
  const roster = fighter?.careerRosterState as CareerRosterState | null | undefined;
  if (!fighter || !roster) return fighter;
  const seen = new Set(roster.equipmentSeenSlots ?? []);
  const unlocked = unlockedEquipmentSlots(equipmentCareerWins(fighter));
  if (unlocked.every(slot => seen.has(slot))) return fighter;
  for (const slot of unlocked) seen.add(slot);
  return localSaves.updateFighter(fighterId, {
    careerRosterState: {
      ...roster,
      // Ordered by the slot list so the stored value is stable across writes.
      equipmentSeenSlots: EQUIPMENT_SLOTS.filter(s => seen.has(s)),
    },
  } as Partial<InsertFighter>);
}
