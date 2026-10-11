import * as THREE from "three";
import type { PunchAnimParams } from "@/lib/punchAnimConfig";

/** Per-face extensions (cm), in BoxGeometry group order: +x, -x, +y, -y, +z, -z. */
export const HIT_BOX_FACES = ["hitBoxPX", "hitBoxNX", "hitBoxPY", "hitBoxNY", "hitBoxPZ", "hitBoxNZ"] as const;
export type HitBoxFaceKey = typeof HIT_BOX_FACES[number];
/** Displayed face i → the stored key it edits (southpaw mirrors the lateral z faces). */
export const hitBoxFaceKey = (i: number, southpaw: boolean): HitBoxFaceKey => HIT_BOX_FACES[southpaw && i >= 4 ? 9 - i : i];

export interface GloveHitBox { q: THREE.Quaternion; c: THREE.Vector3; s: THREE.Vector3 }
export const newGloveHitBox = (): GloveHitBox => ({ q: new THREE.Quaternion(), c: new THREE.Vector3(), s: new THREE.Vector3() });
const MIN_HALF = 0.005;
const _e = new THREE.Euler();

/**
 * A punch's hit box in the glove centre's local frame (body-aligned at bind):
 * rotation q, centre offset c, half size s (m). Glove box grown by hitBoxCm on
 * every face plus each face's own extension. Southpaw mirrors across z.
 */
export function gloveHitBox(p: PunchAnimParams | undefined, glove: THREE.Vector3, southpaw: boolean, out: GloveHitBox = newGloveHitBox()): GloveHitBox {
  const base = (p?.hitBoxCm ?? 10) / 100;
  const f = (k: HitBoxFaceKey) => (p?.[k] ?? 0) / 100;
  const px = f("hitBoxPX"), nx = f("hitBoxNX"), py = f("hitBoxPY"), ny = f("hitBoxNY");
  const pz = f(southpaw ? "hitBoxNZ" : "hitBoxPZ"), nz = f(southpaw ? "hitBoxPZ" : "hitBoxNZ");
  const m = southpaw ? -1 : 1, d = Math.PI / 180;
  out.q.setFromEuler(_e.set((p?.hitBoxRotX ?? 0) * d * m, (p?.hitBoxRotY ?? 0) * d * m, (p?.hitBoxRotZ ?? 0) * d));
  out.c.set((px - nx) / 2, (py - ny) / 2, (pz - nz) / 2);
  out.s.set(
    Math.max(MIN_HALF, glove.x + base + (px + nx) / 2),
    Math.max(MIN_HALF, glove.y + base + (py + ny) / 2),
    Math.max(MIN_HALF, glove.z + base + (pz + nz) / 2),
  );
  return out;
}

/** Lowest value (cm) face i's stored key may take before its axis collapses. */
export function hitBoxFaceMinCm(p: PunchAnimParams | undefined, glove: THREE.Vector3, i: number, southpaw: boolean): number {
  const axis = i >> 1;
  const opp = hitBoxFaceKey(i ^ 1, southpaw);
  const g = axis === 0 ? glove.x : axis === 1 ? glove.y : glove.z;
  return 2 * (MIN_HALF - g - (p?.hitBoxCm ?? 10) / 100) * 100 - (p?.[opp] ?? 0);
}
