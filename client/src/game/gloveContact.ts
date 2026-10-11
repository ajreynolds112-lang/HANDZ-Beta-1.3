import type { FighterState } from "./types";

/**
 * Live 3D glove→target gaps (metres the punch's hit box is short by; <= 0 = touching), written by the fight scene
 * after both fighters are posed. Hit detection uses them when fresh; headless
 * sims (no 3D) never write any and fall back to the distance reach.
 */
const gaps = new WeakMap<FighterState, { left: number; right: number; at: number }>();
export function setGloveGaps(f: FighterState, left: number, right: number): void {
  gaps.set(f, { left, right, at: performance.now() });
}
export function gloveGapM(f: FighterState, isLeft: boolean): number | null {
  const g = gaps.get(f);
  if (!g || performance.now() - g.at > 100) return null;
  return isLeft ? g.left : g.right;
}
