/**
 * Diamond pricing for buying a level in the gym.
 *
 * The price is driven by how many levels the player has *bought*, never by the
 * level itself — levels earned with XP must not make the next purchase dearer.
 * That counter (`Fighter.diamondLevelsBought`) lives in the career save, so it
 * travels with the export file and starts at zero in a brand-new career.
 */

/** Diamond price of the very first bought level. */
export const DIAMOND_LEVEL_BASE_COST = 1;
/** The price multiplies by this much each time it steps up. */
export const DIAMOND_LEVEL_COST_MULT = 1.5;
/** Purchases per price step — the multiplier lands every other bought level. */
export const DIAMOND_LEVEL_COST_STEP = 2;

/**
 * Diamonds needed for the next bought level, given how many levels this career
 * has already bought. The price is 1.5× the last price, but it only steps up
 * every other purchase: the 1st and 2nd bought levels cost the base price, the
 * 3rd and 4th cost 1.5×, the 5th and 6th cost 2.25×, and so on.
 */
export function diamondLevelUpCost(levelsBought: number | null | undefined): number {
  // Saves written before paid levels existed carry no counter — they have
  // bought nothing, so they must start at the base price rather than NaN.
  const owned = Number.isFinite(levelsBought) ? Math.max(0, levelsBought as number) : 0;
  const steps = Math.floor(owned / DIAMOND_LEVEL_COST_STEP);
  const raw = DIAMOND_LEVEL_BASE_COST * Math.pow(DIAMOND_LEVEL_COST_MULT, steps);
  // Deep into the level-1000 endgame the curve overflows a double — clamp it.
  if (!Number.isFinite(raw) || raw > Number.MAX_SAFE_INTEGER) return Number.MAX_SAFE_INTEGER;
  return Math.ceil(raw);
}
