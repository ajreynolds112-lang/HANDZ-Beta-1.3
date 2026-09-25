/**
 * Rules for the gym's passive Force production.
 *
 * The gym pays out for time the player was away, so the only state it needs is
 * a timestamp of when production was last banked. That clock lives with the gym
 * equipment levels in browser storage *and* travels inside an exported save
 * file, which is why the cap lives here rather than in the gym screen — both
 * the screen and the save-file layer have to agree on it.
 */

/** Offline Force growth is capped at 2 days; idle longer and the rest is lost. */
export const MAX_PASSIVE_HOURS = 48;

export const MAX_PASSIVE_MS = MAX_PASSIVE_HOURS * 3_600_000;

/**
 * Pull a production clock into the range the gym will actually pay for.
 *
 * A timestamp older than the cap is moved forward to exactly the cap, so an
 * import (or a save left alone for a month) grants the full 2 days and no more.
 * A timestamp in the future — a system clock change, or a file written on
 * another machine — is reeled back to now instead of stalling production until
 * real time catches up.
 */
export function clampPassiveClock(lastUpdate: unknown, now: number): number {
  if (typeof lastUpdate !== "number" || !Number.isFinite(lastUpdate)) return now;
  if (lastUpdate > now) return now;
  return Math.max(lastUpdate, now - MAX_PASSIVE_MS);
}
