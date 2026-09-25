/**
 * Diamond packs sold for real money in the store's Resources tab.
 *
 * Prices are whole US cents so no floating-point amount ever reaches a payment
 * provider — every provider takes the minor unit, and `$2.99` written as a
 * number is not exactly 2.99.
 */
export interface DiamondPack {
  /** Stable id — this is what a checkout session is keyed on. */
  id: string;
  diamonds: number;
  cents: number;
}

export const DIAMOND_PACKS: DiamondPack[] = [
  { id: "diamonds_99", diamonds: 99, cents: 99 },
  { id: "diamonds_199", diamonds: 199, cents: 199 },
  { id: "diamonds_299", diamonds: 299, cents: 299 },
  { id: "diamonds_499", diamonds: 499, cents: 499 },
  { id: "diamonds_799", diamonds: 799, cents: 799 },
  { id: "diamonds_999", diamonds: 999, cents: 999 },
  { id: "diamonds_1999", diamonds: 1999, cents: 1999 },
  { id: "diamonds_4999", diamonds: 4999, cents: 4999 },
  { id: "diamonds_9999", diamonds: 9999, cents: 9999 },
];

export function getDiamondPack(id: string): DiamondPack | undefined {
  return DIAMOND_PACKS.find(p => p.id === id);
}

export function formatUsd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/**
 * Diamonds per dollar, so the shelf can mark the packs that are better value
 * than the smallest one instead of the player having to work it out.
 */
export function diamondsPerDollar(pack: DiamondPack): number {
  return pack.diamonds / (pack.cents / 100);
}

export interface CheckoutStart {
  ok: boolean;
  /** Where to send the browser when a provider produced a session. */
  url?: string;
  message?: string;
}

/**
 * Begin a card purchase.
 *
 * No payment provider is connected to this project yet, so this refuses
 * loudly rather than pretending the charge happened and handing out Diamonds
 * for free. Once a provider is connected this posts to its checkout endpoint
 * and returns the session URL to redirect to.
 */
export async function startDiamondCheckout(packId: string): Promise<CheckoutStart> {
  const pack = getDiamondPack(packId);
  if (!pack) return { ok: false, message: "Unknown pack" };
  return {
    ok: false,
    message: "Card payments aren't connected to this project yet.",
  };
}
