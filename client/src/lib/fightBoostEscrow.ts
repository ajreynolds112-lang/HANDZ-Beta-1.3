/**
 * Armed-boost escrow — a bout only burns the boosts it actually delivered.
 *
 * Using an item from the Locker moves the copy out of `owned` and arms it in
 * `activeBoosts`. The armed copy is meant to be burned by the bout it was armed
 * for, which only happens when that bout *concludes* (see `consumeBoostsFor`).
 *
 * Quitting from the pause menu, or closing the tab mid-fight, is not a
 * conclusion — the player must get every armed boost back exactly as it stood
 * when the bout started. This module snapshots the armed state at fight start
 * and hands it back on abandonment:
 *
 *   openFightBoostEscrow(id)  — at fight start (career bout and every sparring
 *                               mode: sparring, Nightmare, Doghouse).
 *   closeFightBoostEscrow()   — the moment the bout concludes, so the burn the
 *                               fight-end code just did is never undone.
 *   restoreFightBoostEscrow() — on quit, and once on app start to catch fights
 *                               abandoned by closing the tab.
 *
 * The snapshot lives in localStorage rather than a React ref precisely because
 * it has to survive a reload. Restoring never *adds* stacks: it only tops an
 * item back up to the count it had at the opening bell, so a concluded bout
 * whose escrow was closed can never be replayed into duplicate boosts.
 */
import type { Fighter } from "@shared/schema";
import * as localSaves from "@/lib/localSaves";
import { getInventory } from "@/lib/itemInventory";

const ESCROW_KEY = "handz_fight_boost_escrow";

interface FightBoostEscrow {
  fighterId: string;
  /** activeBoosts as it stood at the opening bell. */
  activeBoosts: Record<string, number>;
  /** Week/camp windows for the armed items, so a restored boost stays live. */
  boostWeek: Record<string, number>;
  boostCamp: Record<string, string>;
}

function readEscrow(): FightBoostEscrow | null {
  try {
    const raw = localStorage.getItem(ESCROW_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<FightBoostEscrow> | null;
    if (!parsed || typeof parsed.fighterId !== "string" || !parsed.activeBoosts) return null;
    return {
      fighterId: parsed.fighterId,
      activeBoosts: { ...parsed.activeBoosts },
      boostWeek: { ...(parsed.boostWeek ?? {}) },
      boostCamp: { ...(parsed.boostCamp ?? {}) },
    };
  } catch {
    return null;
  }
}

/** Snapshot the fighter's armed boosts as the bout starts. */
export function openFightBoostEscrow(fighterId: string | undefined | null): void {
  if (!fighterId) return;
  const inv = getInventory(localSaves.getFighter(fighterId));
  const escrow: FightBoostEscrow = {
    fighterId,
    activeBoosts: { ...inv.activeBoosts },
    boostWeek: { ...(inv.boostWeek ?? {}) },
    boostCamp: { ...(inv.boostCamp ?? {}) },
  };
  try {
    localStorage.setItem(ESCROW_KEY, JSON.stringify(escrow));
  } catch {
    /* storage full / unavailable — the bout still runs, it just can't be refunded */
  }
}

/** The bout concluded: whatever it burned stays burned. */
export function closeFightBoostEscrow(): void {
  try {
    localStorage.removeItem(ESCROW_KEY);
  } catch {
    /* nothing to do */
  }
}

/** True while a bout is open — i.e. one was started and never concluded. */
export function hasOpenFightBoostEscrow(): boolean {
  return readEscrow() !== null;
}

/**
 * Hand the escrowed boosts back to the save and close the escrow.
 *
 * Returns the updated fighter when something was actually re-armed, so callers
 * can refresh their in-memory snapshot; undefined when there was nothing to
 * give back.
 */
export function restoreFightBoostEscrow(): Fighter | undefined {
  const escrow = readEscrow();
  closeFightBoostEscrow();
  if (!escrow) return undefined;
  const fighter = localSaves.getFighter(escrow.fighterId);
  if (!fighter) return undefined;

  const inv = getInventory(fighter);
  let changed = false;
  for (const [itemId, count] of Object.entries(escrow.activeBoosts)) {
    if (!(count > 0)) continue;
    if ((inv.activeBoosts[itemId] ?? 0) >= count) continue;
    inv.activeBoosts[itemId] = count;
    const week = escrow.boostWeek[itemId];
    if (week !== undefined) inv.boostWeek = { ...(inv.boostWeek ?? {}), [itemId]: week };
    const campSig = escrow.boostCamp[itemId];
    if (campSig !== undefined) inv.boostCamp = { ...(inv.boostCamp ?? {}), [itemId]: campSig };
    changed = true;
  }
  if (!changed) return undefined;
  return localSaves.updateFighter(escrow.fighterId, { itemInventory: inv });
}
