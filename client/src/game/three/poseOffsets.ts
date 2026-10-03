/**
 * Hand-tuned joint rotations layered over the solved 3D fight pose, edited in
 * Neural Network → Edit Poses. Each joint holds degrees about the fighter's
 * body axes (x forward, y up, z the fighter's right), applied root → leaf so
 * rotating a joint carries everything below it.
 *
 * Stored as tunable config (joins the tuning bundle registry), so it exports,
 * uploads and ships with a publish like every other Neural Network setting.
 */
import type { BoneName } from "./fighterRig";

export const POSE_OFFSETS_KEY = "handz_pose_offsets";

export type JointRot = [number, number, number];
export type PoseOffsets = Partial<Record<BoneName, JointRot>>;

let draft: PoseOffsets | null = null;
let lastRaw: string | null | undefined;
let cached: PoseOffsets = {};

function clean(v: unknown): PoseOffsets {
  const out: PoseOffsets = {};
  if (!v || typeof v !== "object" || Array.isArray(v)) return out;
  for (const [k, r] of Object.entries(v as Record<string, unknown>)) {
    if (!Array.isArray(r) || r.length !== 3) continue;
    const n = r.map(Number);
    if (n.every(Number.isFinite) && n.some(x => x !== 0)) out[k as BoneName] = n as JointRot;
  }
  return out;
}

/** Saved offsets (cached on the raw string, so uploads and other tabs are picked up for free). */
export function getSavedPoseOffsets(): PoseOffsets {
  let raw: string | null = null;
  try { raw = localStorage.getItem(POSE_OFFSETS_KEY); } catch { /* no storage */ }
  if (raw !== lastRaw) {
    lastRaw = raw;
    try { cached = clean(raw ? JSON.parse(raw) : {}); } catch { cached = {}; }
  }
  return cached;
}

/** What the renderer applies: the editor's unsaved draft while it is open, else the saved set. */
export function getPoseOffsets(): PoseOffsets {
  return draft ?? getSavedPoseOffsets();
}

export function setPoseOffsetsDraft(d: PoseOffsets | null): void {
  draft = d;
}

export function savePoseOffsets(o: PoseOffsets): void {
  localStorage.setItem(POSE_OFFSETS_KEY, JSON.stringify(clean(o)));
}
