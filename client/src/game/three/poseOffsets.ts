/**
 * Hand-tuned joint rotations layered over the solved 3D fight pose, edited in
 * Neural Network → Edit Poses. Each joint holds degrees about the fighter's
 * body axes (x forward, y up, z the fighter's right), applied root → leaf so
 * rotating a joint carries everything below it.
 *
 * One set is authored, in the orthodox stance; a southpaw fighter always uses
 * its left/right mirror. The duck layer sits on top of the stance set,
 * weighted by the crouch, and never holds arm joints: it bends the legs and
 * torso, and the arms keep their joint rotations, riding the torso.
 *
 * Full guard has its own arm set: the arms slide (by the guard blend) from the
 * stance set's arm rotations to the full-guard set's, so editing the normal
 * guard never moves the full guard. Torso and legs come from the stance set in
 * both guards.
 *
 * The nose line: a guide ray out of the face, rotated (degrees, YXZ like a
 * joint, in the head's own frame) until it runs straight out of the nose. In
 * fights the head yaws (never pitches) so the line points at the opponent's.
 *
 * Stored as tunable config (joins the tuning bundle registry), so it exports,
 * uploads and ships with a publish like every other Neural Network setting.
 */
import type { BoneName } from "./fighterRig";

export const POSE_OFFSETS_KEY = "handz_pose_offsets";

export type JointRot = [number, number, number];
export type PoseOffsets = Partial<Record<BoneName, JointRot>>;
/** The stance pose, the duck layer added on top of it, or the full guard's arms. */
export type PoseLayer = "stance" | "duck" | "fullGuard";
export type StancePoses = Record<PoseLayer, PoseOffsets> & { noseLine?: JointRot };
export const POSE_LAYERS: PoseLayer[] = ["stance", "duck", "fullGuard"];
export const emptyPoses = (): StancePoses => ({ stance: {}, duck: {}, fullGuard: {} });

/** Shoulder → hand on either side: the joints the duck layer may not move. */
export const isArmJoint = (name: string): boolean => /^(Left|Right)(Shoulder|Arm|ForeArm|Hand)$/.test(name);

let draft: StancePoses | null = null;
let lastRaw: string | null | undefined;
let cached: StancePoses = emptyPoses();

function cleanSet(v: unknown, noArms = false, armsOnly = false): PoseOffsets {
  const out: PoseOffsets = {};
  if (!v || typeof v !== "object" || Array.isArray(v)) return out;
  for (const [k, r] of Object.entries(v as Record<string, unknown>)) {
    if (noArms && isArmJoint(k)) continue;
    if (armsOnly && !isArmJoint(k)) continue;
    if (!Array.isArray(r) || r.length !== 3) continue;
    const n = r.map(Number);
    if (n.every(Number.isFinite) && n.some(x => x !== 0)) out[k as BoneName] = n as JointRot;
  }
  return out;
}

/**
 * Reflect a pose across the boxer's centre plane: Left ↔ Right joints swap, and
 * rotations about the forward (x) and vertical (y) axes change sign while the
 * side-axis (z) tilt keeps it.
 */
export function mirrorPose(o: PoseOffsets): PoseOffsets {
  const out: PoseOffsets = {};
  for (const [k, r] of Object.entries(o) as [BoneName, JointRot][]) {
    const name = (k.startsWith("Left") ? "Right" + k.slice(4) : k.startsWith("Right") ? "Left" + k.slice(5) : k) as BoneName;
    out[name] = [r[0] === 0 ? 0 : -r[0], r[1] === 0 ? 0 : -r[1], r[2]];
  }
  return out;
}

export function cleanPoses(v: unknown): StancePoses {
  const o = v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
  let stance: PoseOffsets, duck: PoseOffsets;
  if ("stance" in o || "duck" in o) { stance = cleanSet(o.stance); duck = cleanSet(o.duck, true); }
  // Older per-stance format: the orthodox sets become the one authored set.
  else if ("orthodox" in o || "southpaw" in o) { stance = cleanSet(o.orthodox); duck = cleanSet(o.orthodoxDuck, true); }
  // Oldest single-set format: it was the orthodox pose.
  else { stance = cleanSet(o); duck = {}; }
  // Saved before full guard had its own arms: it was the stance arms, so it starts there.
  const fullGuard = "fullGuard" in o ? cleanSet(o.fullGuard, false, true) : cleanSet(stance, false, true);
  const out: StancePoses = { stance, duck, fullGuard };
  const nl = cleanRot(o.noseLine);
  if (nl) out.noseLine = nl;
  return out;
}

function cleanRot(v: unknown): JointRot | null {
  if (!Array.isArray(v) || v.length !== 3) return null;
  const n = v.map(Number);
  if (!n.every(Number.isFinite) || n.every(x => x === 0)) return null;
  return n.map(x => Math.max(-180, Math.min(180, x))) as JointRot;
}

const NO_ROT: JointRot = [0, 0, 0];
/** The nose line's rotation the renderer uses (draft while editing), mirrored for a southpaw. */
export function getNoseLine(southpaw: boolean): JointRot {
  const r = (draft ?? getSavedStancePoses()).noseLine ?? NO_ROT;
  return southpaw ? [-r[0], -r[1], r[2]] : r;
}

/** Saved poses (cached on the raw string, so uploads and other tabs are picked up for free). */
export function getSavedStancePoses(): StancePoses {
  let raw: string | null = null;
  try { raw = localStorage.getItem(POSE_OFFSETS_KEY); } catch { /* no storage */ }
  if (raw !== lastRaw) {
    lastRaw = raw;
    try { cached = cleanPoses(raw ? JSON.parse(raw) : {}); } catch { cached = emptyPoses(); }
  }
  return cached;
}

const mirrored = new WeakMap<PoseOffsets, PoseOffsets>();
const NO_OFFSETS: PoseOffsets = {};
/**
 * What the renderer applies: the editor's unsaved draft while it is open, else
 * the saved set; mirrored for a southpaw. The duck layer never returns arm joints.
 */
export function getPoseOffsets(layer: PoseLayer, southpaw: boolean): PoseOffsets {
  let set = (draft ?? getSavedStancePoses())[layer] ?? NO_OFFSETS;
  if (layer === "duck" && Object.keys(set).some(isArmJoint)) set = cleanSet(set, true);
  if (layer === "fullGuard" && Object.keys(set).some(k => !isArmJoint(k))) set = cleanSet(set, false, true);
  if (!southpaw) return set;
  let m = mirrored.get(set);
  if (!m) { m = mirrorPose(set); mirrored.set(set, m); }
  return m;
}

const blendCache = new WeakMap<PoseOffsets, WeakMap<PoseOffsets, PoseOffsets>>();
/**
 * The stance set with its arm joints slid toward the full guard's by the guard
 * blend g (0 = normal guard, 1 = full guard), mirrored for a southpaw.
 */
export function getGuardOffsets(southpaw: boolean, g: number): PoseOffsets {
  const stance = getPoseOffsets("stance", southpaw);
  const full = getPoseOffsets("fullGuard", southpaw);
  const t = Math.max(0, Math.min(1, g || 0));
  const merge = (w: number): PoseOffsets => {
    const out: PoseOffsets = {};
    for (const [k, r] of Object.entries(stance) as [BoneName, JointRot][]) if (!isArmJoint(k)) out[k] = r;
    const names = new Set([...Object.keys(stance), ...Object.keys(full)].filter(isArmJoint) as BoneName[]);
    names.forEach(k => {
      const a = stance[k] ?? [0, 0, 0], b = full[k] ?? [0, 0, 0];
      out[k] = [a[0] + (b[0] - a[0]) * w, a[1] + (b[1] - a[1]) * w, a[2] + (b[2] - a[2]) * w];
    });
    return out;
  };
  if (t <= 0) {
    // Normal guard: the stance arms as they are.
    return stance;
  }
  if (t < 1) return merge(t);
  let inner = blendCache.get(stance);
  if (!inner) { inner = new WeakMap(); blendCache.set(stance, inner); }
  let m = inner.get(full);
  if (!m) { m = merge(1); inner.set(full, m); }
  return m;
}

export function setPoseOffsetsDraft(d: StancePoses | null): void {
  draft = d;
}

export function savePoseOffsets(p: StancePoses): void {
  localStorage.setItem(POSE_OFFSETS_KEY, JSON.stringify(cleanPoses(p)));
}
