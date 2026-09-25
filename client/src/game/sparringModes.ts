/**
 * Entry rules for the two paid sparring modes — Nightmare and the Doghouse.
 *
 * Both are bought once with Force after a career-win threshold, then charge a
 * Force + Shard fee every session, with no per-camp limit: if the player can
 * pay, they can play. The numbers live here because three layers need to agree
 * on them — the sparring menu (progress bars, unlock button, affordability),
 * the entry handlers that actually take the payment, and the reward payout.
 */

export type SparringMode = "nightmare" | "doghouse";

export interface SparringModeCost {
  /** Career wins required before the mode can be bought at all. */
  unlockWins: number;
  /** One-time Force price to unlock the mode for this career. */
  unlockForce: number;
  /** Force taken at the start of every session. */
  sessionForce: number;
  /** Shards taken at the start of every session. */
  sessionShards: number;
}

export const SPARRING_MODE_COSTS: Record<SparringMode, SparringModeCost> = {
  nightmare: {
    unlockWins: 10,
    unlockForce: 10_000_000,
    sessionForce: 5_000,
    sessionShards: 5_000,
  },
  doghouse: {
    unlockWins: 20,
    unlockForce: 20_000_000,
    sessionForce: 10_000,
    sessionShards: 10_000,
  },
};

interface SparringUnlockFlags {
  nightmareUnlocked?: boolean;
  doghouseUnlocked?: boolean;
  sparringUnlocksMigrated?: boolean;
}

/**
 * Grandfathers a career that predates the paid unlocks: any mode whose win
 * requirement it has already cleared is unlocked free of charge, once, on load.
 *
 * Fresh careers are stamped as migrated the moment their roster is generated,
 * so they never qualify and always pay. Idempotent -- the stamp is what stops a
 * career that later spends its unlock from being handed it back.
 */
export function grandfatherSparringUnlocks<T extends SparringUnlockFlags>(state: T, careerWins: number): T {
  if (state.sparringUnlocksMigrated) return state;
  return {
    ...state,
    nightmareUnlocked: state.nightmareUnlocked || careerWins >= SPARRING_MODE_COSTS.nightmare.unlockWins,
    doghouseUnlocked: state.doghouseUnlocked || careerWins >= SPARRING_MODE_COSTS.doghouse.unlockWins,
    sparringUnlocksMigrated: true,
  };
}

export interface SparringPurse {
  force?: number | null;
  shards?: number | null;
}

export function canAffordSparringSession(purse: SparringPurse, mode: SparringMode): boolean {
  const cost = SPARRING_MODE_COSTS[mode];
  return (purse.force ?? 0) >= cost.sessionForce && (purse.shards ?? 0) >= cost.sessionShards;
}
