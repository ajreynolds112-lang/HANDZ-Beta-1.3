/**
 * Ring palette — the career hub ring's own colours.
 *
 * Gear colours live on the fighter; these live beside them but describe the
 * furniture instead of the boxer. They are kept in their own module because the
 * ring is drawn by shared renderer helpers that the in-fight view also uses: the
 * palette arrives on `GameState.ringColors`, and every one of those helpers
 * falls back to its original literal when the field is absent. That is what lets
 * the hub be repainted without touching how a bout looks.
 *
 * Like gear, any slot may hold the Spacial sentinel rather than a hex. The same
 * two rules apply — resolve it before parsing, let the canvas interception paint
 * it — with one addition: the ring used to be forbidden from wearing the finish
 * at all (corner posts borrow trunk colours and merely resolved the sentinel).
 * That is no longer true, so a ring surface must now be able to paint it.
 */

/** Force price of the one-time Spacial ring unlock. */
export const RING_SPACIAL_PRICE_FORCE = 50_000_000_000;

/**
 * The apron is deliberately not a key: it is derived from the canvas so the
 * ring skirt always reads as the same material as the mat.
 */
export const RING_COLOR_KEYS = [
  "canvas", "border", "ropeLower", "ropeMiddle", "ropeUpper", "posts",
] as const;

export type RingColorKey = typeof RING_COLOR_KEYS[number];
export type RingColors = Partial<Record<RingColorKey, string>>;

/** What each slot looks like before anyone touches it — the stock hub ring. */
export const DEFAULT_RING_COLORS: Record<RingColorKey, string> = {
  canvas: "#BDEDF2",
  border: "#8b7355",
  ropeLower: "#cc3333",
  ropeMiddle: "#ffffff",
  ropeUpper: "#cc3333",
  posts: "#ffffff",
};

export const RING_COLOR_LABELS: Record<RingColorKey, string> = {
  canvas: "Canvas",
  border: "Ring Edge",
  ropeLower: "Lower Rope",
  ropeMiddle: "Middle Rope",
  ropeUpper: "Upper Rope",
  posts: "Corner Posts",
};

type RingColorSource = { ringColors?: unknown; ringSpacialUnlocked?: boolean | null } | null | undefined;

/**
 * A fighter's saved ring palette, filled in with the stock colours.
 *
 * Always returns every key so the editor and the renderer agree on what "unset"
 * looks like; a save written before ring colours existed simply reads as stock.
 */
export function ringColorsOf(f: RingColorSource): Record<RingColorKey, string> {
  const saved = (f?.ringColors ?? null) as RingColors | null;
  const out = { ...DEFAULT_RING_COLORS };
  if (saved && typeof saved === "object") {
    for (const key of RING_COLOR_KEYS) {
      const v = saved[key];
      if (typeof v === "string" && v) out[key] = v;
    }
  }
  return out;
}

/** Whether the Spacial finish has been bought for the ring. */
export function ringSpacialUnlockedOf(f: RingColorSource): boolean {
  return !!f?.ringSpacialUnlocked;
}
