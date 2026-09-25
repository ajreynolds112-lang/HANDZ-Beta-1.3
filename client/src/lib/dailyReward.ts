/**
 * Daily reward chests.
 *
 * Once per real-world calendar day a career is handed the chests its rank band
 * is configured for in Neural Network → Items → Reward Rarity. The items are
 * granted and persisted the moment the day is claimed — the reveal overlay only
 * shows what the locker already holds.
 *
 * The claim stamp lives on the career's roster state, so it rides along with a
 * save download/upload and a fresh career starts clear.
 */
import type { CrateId } from "@/game/cratesConfig";
import type { CareerRosterState, ItemInventory } from "@shared/schema";
import { pickDailyCrates } from "@/game/dailyRewardConfig";
import * as localSaves from "@/lib/localSaves";
import { rollCrateForFighter } from "@/lib/itemInventory";

export interface DailyRewardClaim {
  /** Chests granted, in the order they should be revealed. May be empty. */
  crates: { crateId: CrateId; itemIds: string[] }[];
}

/** Local calendar day, `YYYY-MM-DD` — the day the player is actually living in. */
export function todayKey(d: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * How far ahead of today a claim stamp has to sit before it is treated as a
 * broken clock rather than a wound-back one. A month is well past any timezone
 * or DST shift, so a device that was briefly set to the wrong year can heal
 * itself instead of locking the chests away forever.
 */
const CLOCK_GLITCH_DAYS = 30;

/**
 * True when this career has not yet taken today's chests.
 *
 * The day only moves forward: winding the clock back to a day that has already
 * been claimed does not make the chests due again. Day keys are `YYYY-MM-DD`,
 * which sorts chronologically as plain text.
 */
export function dailyRewardAvailable(rs: CareerRosterState | null | undefined): boolean {
  if (!rs) return false;
  const last = rs.lastDailyRewardDay;
  if (!last) return true;
  const today = todayKey();
  if (today > last) return true;
  // The stamp is today or in the future. Absurdly far in the future means the
  // clock was wrong when it was written, not that the player is time-travelling.
  const lastAt = lastDailyRewardAt(rs);
  return lastAt != null && lastAt - Date.now() > CLOCK_GLITCH_DAYS * 86_400_000;
}

/**
 * The next 00:00 on the player's own clock, in epoch ms. Everything about the
 * daily reward is worked out from the device calendar — nothing is asked of a
 * server — so the reset lands at local midnight whether the game is open, shut,
 * or the machine has been offline for a week.
 */
export function nextDailyResetAt(now: Date = new Date()): number {
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
  return midnight.getTime();
}

/** Milliseconds left until the chests reset. Never negative. */
export function msUntilNextDailyReward(now: Date = new Date()): number {
  return Math.max(0, nextDailyResetAt(now) - now.getTime());
}

/**
 * When this career last took its chests, in epoch ms, or null if it never has.
 * Old saves only carry the day stamp, so fall back to that day's midnight —
 * the exact minute is unknown but the day is not.
 */
export function lastDailyRewardAt(rs: CareerRosterState | null | undefined): number | null {
  if (!rs) return null;
  if (typeof rs.lastDailyRewardAt === "number" && rs.lastDailyRewardAt > 0) return rs.lastDailyRewardAt;
  const day = rs.lastDailyRewardDay;
  if (!day) return null;
  const [y, m, d] = day.split("-").map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d, 0, 0, 0, 0).getTime();
}

/** `7h 12m`, `12m 05s`, `45s` — a countdown short enough for a HUD chip. */
export function formatDailyCountdown(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}

/**
 * Claim today's chests for a career, granting and persisting their contents.
 *
 * Returns null when there was nothing to do — the day is already claimed or the
 * save holds no career. A claim that rolled no chests (band set to zero, empty
 * catalog) still returns, with an empty list: the day is stamped either way, so
 * an empty band doesn't re-roll on every hub visit, and the caller knows the
 * save was written and its snapshot needs refreshing.
 */
export function claimDailyReward(fighterId: string, rng: () => number = Math.random): DailyRewardClaim | null {
  const fighter = localSaves.getFighter(fighterId);
  const rs = fighter?.careerRosterState as CareerRosterState | undefined;
  if (!fighter || !rs) return null;

  const today = todayKey();
  if (!dailyRewardAvailable(rs)) return null;

  const rank = rs.playerRank;
  // No usable rank means the career isn't finished being built. There is
  // nothing to look a band up with, so leave the day unclaimed rather than
  // stamping it — a burnt day is a day the player never got to see.
  if (typeof rank !== "number" || !Number.isFinite(rank) || rank < 1) return null;
  const crateIds = pickDailyCrates(rank, rng);

  let inventory: ItemInventory | null = null;
  const crates: { crateId: CrateId; itemIds: string[] }[] = [];
  for (const crateId of crateIds) {
    // Each chest rolls against the inventory the previous one left behind, so
    // lifetime caps are honoured across the whole day's haul.
    const roll = rollCrateForFighter(
      inventory ? { ...fighter, itemInventory: inventory } : fighter,
      crateId,
      rank,
      false,
      "daily",
    );
    if (!roll.inventory || roll.itemIds.length === 0) continue;
    crates.push({ crateId, itemIds: roll.itemIds });
    inventory = roll.inventory;
  }

  // Re-read before writing: the roster blob is written whole, so the stamp has
  // to be folded into whatever the freshest save holds rather than the copy
  // this function opened with.
  const fresh = localSaves.getFighter(fighterId) ?? fighter;
  const freshRs = (fresh.careerRosterState as CareerRosterState | undefined) ?? rs;
  localSaves.updateFighter(fighterId, {
    ...(inventory ? { itemInventory: inventory } : {}),
    careerRosterState: { ...freshRs, lastDailyRewardDay: today, lastDailyRewardAt: Date.now() },
  });

  return { crates };
}
