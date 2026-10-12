import * as THREE from "three";
import type { GloveHitBox } from "./gloveHitBox";

/**
 * Hurt boxes (Edit Poses): one for the head, one for the body above the trunks.
 * A punch lands when its glove hit box overlaps either. Each box starts from the
 * measured mesh (head verts / torso verts above the waistband) and is grown by
 * sizeCm on every face, plus per-face drags, then rotated about its centre.
 * Frame: body bind space, riding the part's anchor bone.
 */
export type HurtPart = "head" | "body";
export const HURT_PARTS: HurtPart[] = ["head", "body"];
export const HURT_LABELS: Record<HurtPart, string> = { head: "Head", body: "Body" };
/** Per-face extensions (cm), in BoxGeometry group order: +x, -x, +y, -y, +z, -z. */
export const HURT_FACES = ["px", "nx", "py", "ny", "pz", "nz"] as const;
export type HurtFaceKey = typeof HURT_FACES[number];
export type HurtBoxParams = { sizeCm: number; rotX: number; rotY: number; rotZ: number } & Record<HurtFaceKey, number>;
export type HurtBoxConfig = Record<HurtPart, HurtBoxParams>;

const DEFAULT_PARAMS: HurtBoxParams = { sizeCm: 0, rotX: 0, rotY: 0, rotZ: 0, px: 0, nx: 0, py: 0, ny: 0, pz: 0, nz: 0 };
export const DEFAULT_HURT_BOXES: HurtBoxConfig = { head: { ...DEFAULT_PARAMS }, body: { ...DEFAULT_PARAMS } };
export const HURT_BOXES_KEY = "handz_hurtboxes";
const MIN_HALF = 0.005;

export function loadHurtBoxes(): HurtBoxConfig {
  const out: HurtBoxConfig = { head: { ...DEFAULT_PARAMS }, body: { ...DEFAULT_PARAMS } };
  try {
    const saved = JSON.parse(localStorage.getItem(HURT_BOXES_KEY) || "{}") as Partial<Record<HurtPart, Partial<HurtBoxParams>>>;
    for (const part of HURT_PARTS) {
      const s = saved?.[part];
      if (!s || typeof s !== "object") continue;
      for (const k of Object.keys(DEFAULT_PARAMS) as (keyof HurtBoxParams)[]) {
        if (typeof s[k] === "number" && Number.isFinite(s[k])) out[part][k] = s[k]!;
      }
    }
  } catch { /* defaults */ }
  return out;
}

let cache: HurtBoxConfig | null = null;
export function getHurtBoxes(): HurtBoxConfig {
  return cache ??= loadHurtBoxes();
}
export function invalidateHurtBoxCache(): void {
  cache = null;
}
export function saveHurtBoxes(c: HurtBoxConfig): void {
  localStorage.setItem(HURT_BOXES_KEY, JSON.stringify(c));
  cache = c;
}
export function setHurtBoxField(part: HurtPart, key: keyof HurtBoxParams, v: number): HurtBoxConfig {
  const cur = loadHurtBoxes();
  const next = { ...cur, [part]: { ...cur[part], [key]: v } };
  saveHurtBoxes(next);
  return next;
}

const _e = new THREE.Euler();
/** The box in its frame: rotation q, centre c (base centre + rotated face offset), half size s (m). */
export function hurtBoxLocal(p: HurtBoxParams, baseC: THREE.Vector3, baseS: THREE.Vector3, out: GloveHitBox): GloveHitBox {
  const base = p.sizeCm / 100, f = (k: HurtFaceKey) => p[k] / 100;
  const px = f("px"), nx = f("nx"), py = f("py"), ny = f("ny"), pz = f("pz"), nz = f("nz");
  const d = Math.PI / 180;
  out.q.setFromEuler(_e.set(p.rotX * d, p.rotY * d, p.rotZ * d));
  out.c.set((px - nx) / 2, (py - ny) / 2, (pz - nz) / 2).applyQuaternion(out.q).add(baseC);
  out.s.set(
    Math.max(MIN_HALF, baseS.x + base + (px + nx) / 2),
    Math.max(MIN_HALF, baseS.y + base + (py + ny) / 2),
    Math.max(MIN_HALF, baseS.z + base + (pz + nz) / 2),
  );
  return out;
}

/** Lowest value (cm) face i may take before its axis collapses. */
export function hurtBoxFaceMinCm(p: HurtBoxParams, baseS: THREE.Vector3, i: number): number {
  const axis = i >> 1;
  const g = axis === 0 ? baseS.x : axis === 1 ? baseS.y : baseS.z;
  return 2 * (MIN_HALF - g - p.sizeCm / 100) * 100 - p[HURT_FACES[i ^ 1]];
}

const _a = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
const _b = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
const _ha = [0, 0, 0], _hb = [0, 0, 0];
const _ca = new THREE.Vector3(), _cb = new THREE.Vector3(), _t = new THREE.Vector3(), _l = new THREE.Vector3();
/**
 * Separation (m) between two boxes given as unit-cube → world matrices
 * (separating-axis test); <= 0 = overlapping.
 */
export function boxSeparation(A: THREE.Matrix4, B: THREE.Matrix4): number {
  const ea = A.elements, eb = B.elements;
  for (let i = 0; i < 3; i++) {
    _a[i].set(ea[i * 4], ea[i * 4 + 1], ea[i * 4 + 2]); _ha[i] = _a[i].length(); _a[i].divideScalar(_ha[i] || 1);
    _b[i].set(eb[i * 4], eb[i * 4 + 1], eb[i * 4 + 2]); _hb[i] = _b[i].length(); _b[i].divideScalar(_hb[i] || 1);
  }
  _ca.set(ea[12], ea[13], ea[14]); _cb.set(eb[12], eb[13], eb[14]);
  _t.subVectors(_cb, _ca);
  let sep = -Infinity;
  const test = (L: THREE.Vector3) => {
    const len = L.length();
    if (len < 1e-6) return;
    L.divideScalar(len);
    let r = 0;
    for (let i = 0; i < 3; i++) r += _ha[i] * Math.abs(_a[i].dot(L)) + _hb[i] * Math.abs(_b[i].dot(L));
    sep = Math.max(sep, Math.abs(_t.dot(L)) - r);
  };
  for (let i = 0; i < 3; i++) { test(_l.copy(_a[i])); test(_l.copy(_b[i])); }
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) test(_l.crossVectors(_a[i], _b[j]));
  return sep;
}
