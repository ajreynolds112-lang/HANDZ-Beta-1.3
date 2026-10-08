/**
 * Hand-tuned joint rotations layered over the solved 3D fight pose, edited in
 * Neural Network → Edit Poses. Each joint holds degrees about the fighter's
 * body axes (x forward, y up, z the fighter's right), applied root → leaf so
 * rotating a joint carries everything below it. Orthodox and southpaw each
 * keep their own set; one can be mirrored onto the other.
 *
 * Stored as tunable config (joins the tuning bundle registry), so it exports,
 * uploads and ships with a publish like every other Neural Network setting.
 */
import type { BoneName } from "./fighterRig";

export const POSE_OFFSETS_KEY = "handz_pose_offsets";

export type JointRot = [number, number, number];
export type PoseOffsets = Partial<Record<BoneName, JointRot>>;
export type PoseStance = "orthodox" | "southpaw";
export type StancePoses = Record<PoseStance, PoseOffsets>;

let draft: StancePoses | null = null;
let lastRaw: string | null | undefined;
let cached: StancePoses = { orthodox: {}, southpaw: {} };

function cleanSet(v: unknown): PoseOffsets {
  const out: PoseOffsets = {};
  if (!v || typeof v !== "object" || Array.isArray(v)) return out;
  for (const [k, r] of Object.entries(v as Record<string, unknown>)) {
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

function clean(v: unknown): StancePoses {
  const o = v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
  if ("orthodox" in o || "southpaw" in o) return { orthodox: cleanSet(o.orthodox), southpaw: cleanSet(o.southpaw) };
  // Older single-set format: it was the orthodox pose; southpaw starts as its mirror.
  const ortho = cleanSet(o);
  return { orthodox: ortho, southpaw: mirrorPose(ortho) };
}

/** Saved poses (cached on the raw string, so uploads and other tabs are picked up for free). */
export function getSavedStancePoses(): StancePoses {
  let raw: string | null = null;
  try { raw = localStorage.getItem(POSE_OFFSETS_KEY); } catch { /* no storage */ }
  if (raw !== lastRaw) {
    lastRaw = raw;
    try { cached = clean(raw ? JSON.parse(raw) : {}); } catch { cached = { orthodox: {}, southpaw: {} }; }
  }
  return cached;
}

/** What the renderer applies for a stance: the editor's unsaved draft while it is open, else the saved set. */
export function getPoseOffsets(stance: PoseStance): PoseOffsets {
  return (draft ?? getSavedStancePoses())[stance];
}

export function setPoseOffsetsDraft(d: StancePoses | null): void {
  draft = d;
}

export function savePoseOffsets(p: StancePoses): void {
  localStorage.setItem(POSE_OFFSETS_KEY, JSON.stringify(clean(p)));
}
