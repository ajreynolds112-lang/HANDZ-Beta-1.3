/**
 * The locker's spend ledger.
 *
 * `lifetimeObtained` counts every copy a save was ever given and `itemsSpent`
 * counts every copy it deliberately sold, used or armed, so `lifetime - spent`
 * is what must still be sitting in the locker. Anything below that went missing
 * to a bad write, a rolled-back save or a catalog edit — never to the player —
 * so it is put back.
 *
 * Lives on its own so both the inventory library and the effect reader can
 * normalize through the same rule without importing each other.
 */

/** Copy a stored count map, dropping anything that isn't a positive number. */
export function countMap(v: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!v || typeof v !== "object") return out;
  for (const [k, raw] of Object.entries(v as Record<string, unknown>)) {
    const n = Math.floor(Number(raw));
    if (Number.isFinite(n) && n > 0) out[k] = n;
  }
  return out;
}

/**
 * Restore copies that left the locker without a receipt. `owned` is mutated in
 * place (pass a copy) and only ever raised: a duplicate that arrived some other
 * way is left alone.
 *
 * A save written before the ledger existed has no receipts, so its current
 * counts are taken as the truth and everything already gone is booked as spent.
 * That bakes in past losses — nothing resurrects — while making every loss from
 * here on recoverable.
 */
export function repairOwnedFromLedger(
  owned: Record<string, number>,
  lifetime: Record<string, number>,
  spentRaw: Record<string, number> | null | undefined,
): { owned: Record<string, number>; itemsSpent: Record<string, number> } {
  const itemsSpent: Record<string, number> = {};
  for (const [itemId, lifeRaw] of Object.entries(lifetime)) {
    const life = Math.max(0, Math.floor(lifeRaw ?? 0));
    if (life <= 0) continue;
    const have = Math.max(0, Math.floor(owned[itemId] ?? 0));
    const spent = spentRaw
      ? Math.max(0, Math.min(life, Math.floor(spentRaw[itemId] ?? 0)))
      : Math.max(0, life - have); // legacy save: assume the missing copies were spent
    if (spent > 0) itemsSpent[itemId] = spent;
    const expected = life - spent;
    if (expected > have) owned[itemId] = expected;
  }
  // Receipts for items with no lifetime record (a hand-edited or partially
  // written save) are kept as-is so they can still block a later repair.
  for (const [itemId, spentRawVal] of Object.entries(spentRaw ?? {})) {
    if (itemsSpent[itemId] == null) {
      const spent = Math.max(0, Math.floor(spentRawVal ?? 0));
      if (spent > 0) itemsSpent[itemId] = spent;
    }
  }
  return { owned, itemsSpent };
}

/** True when two count maps disagree on any id. */
export function countsDiffer(a: Record<string, number>, b: Record<string, number>): boolean {
  for (const k of Object.keys(a)) if ((a[k] ?? 0) !== (b[k] ?? 0)) return true;
  for (const k of Object.keys(b)) if ((a[k] ?? 0) !== (b[k] ?? 0)) return true;
  return false;
}
