/**
 * The refinement skills a fighter can carry, and their display names.
 *
 * Order is load-bearing: pickRefinementKeys (careerRoster.ts) shuffles this
 * array by fighter id, so new keys go on the end — appending only ever swaps
 * one existing pick for the new key rather than re-dealing every opponent's
 * loadout.
 */
export const REFINEMENT_KEYS = [
  'pressureFighter', 'precisionStriker', 'jabPower', 'hookPower', 'uppercutPower', 'bruiser',
  'ironChin', 'slippery', 'guardMaster', 'duckRecovery', 'punchRolling',
  'fastTwitch', 'heartRefinement', 'chinHitter', 'technician', 'lifeDrain',
  'koArtist',
] as const;

export type RefinementKey = typeof REFINEMENT_KEYS[number];

/** Names as they read in the Skill Refinement screen. */
export const REFINEMENT_LABELS: Record<RefinementKey, string> = {
  pressureFighter: "Pressure Fighter",
  precisionStriker: "Precision Striker",
  jabPower: "Straight Punch",
  hookPower: "Hook Power",
  uppercutPower: "Uppercut Power",
  bruiser: "Bruiser",
  ironChin: "Iron Chin",
  slippery: "Slippery",
  guardMaster: "Guard Master",
  duckRecovery: "Duck Recovery",
  punchRolling: "Punch Rolling",
  fastTwitch: "Fast Twitch",
  heartRefinement: "Heart",
  chinHitter: "Chin Hitter",
  technician: "Technician",
  lifeDrain: "Life Drain",
  koArtist: "KO Artist",
};

export function isRefinementKey(v: unknown): v is RefinementKey {
  return typeof v === "string" && (REFINEMENT_KEYS as readonly string[]).includes(v);
}

/**
 * Coerce a stored or edited list of refinement keys into known keys only, with
 * no duplicates and always in the canonical order above — so a saved list reads
 * the same however it was clicked together, and a key that has since been
 * renamed or removed drops out instead of poisoning generation.
 */
export function sanitizeRefinementKeys(raw: unknown): RefinementKey[] {
  if (!Array.isArray(raw)) return [];
  const picked = new Set<string>();
  for (const v of raw) if (isRefinementKey(v)) picked.add(v);
  return REFINEMENT_KEYS.filter(k => picked.has(k));
}
