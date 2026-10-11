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
 * both guards. There are three full guards (the fighter's guard stance, cycled
 * with Tab); each starts as a copy of the first.
 *
 * Perfect block poses (arms + torso): eight variants, slid to while a perfect
 * block is up, picked by the incoming punch and the guard stance. A variant
 * with no pose of its own wears Standard's; a non-standard variant is only used
 * in the stances it lists, and may open a counter window when it blocks.
 *
 * The nose line: a guide ray out of the face, rotated (degrees, YXZ like a
 * joint, in the head's own frame) until it runs straight out of the nose. In
 * fights the head yaws (never pitches) so the line points at the opponent's.
 *
 * Stored as tunable config (joins the tuning bundle registry), so it exports,
 * uploads and ships with a publish like every other Neural Network setting.
 */
import type { BoneName } from "./fighterRig";
import type { PunchType } from "../types";

export const POSE_OFFSETS_KEY = "handz_pose_offsets";

export type JointRot = [number, number, number];
export type PoseOffsets = Partial<Record<BoneName, JointRot>>;
/** The stance pose, the duck layer added on top of it, or one of the three full guards' arms. */
export type PoseLayer = "stance" | "duck" | "fullGuard" | "fullGuard2" | "fullGuard3";
export const FULL_GUARD_LAYERS = ["fullGuard", "fullGuard2", "fullGuard3"] as const;
export const GUARD_STANCE_LABELS = ["Full Guard", "Secondary Full Guard", "Third Full Guard"];
export const PB_VARIANTS = ["standard", "jab", "cross", "leftHook", "rightHook", "leftUppercut", "rightUppercut", "shoulderRoll"] as const;
export type PbVariant = typeof PB_VARIANTS[number];
export const PB_LABELS: Record<PbVariant, string> = {
  standard: "Standard", jab: "Jab", cross: "Cross", leftHook: "Left Hook", rightHook: "Right Hook",
  leftUppercut: "Left Uppercut", rightUppercut: "Right Uppercut", shoulderRoll: "Shoulder Roll",
};
/**
 * pose absent = wears its guard's Standard. enabled: the guard may use it.
 */
export interface PbPose { pose?: PoseOffsets; enabled: boolean; counter: boolean }
export type PbSet = Record<PbVariant, PbPose>;
/** perfectBlocks[i] = full guard i's own eight perfect block poses. */
/** hipHeight / duckHipHeight: hips raised (+) or lowered (-) in cm; the duck's adds on by crouch depth. */
export type StancePoses = Record<PoseLayer, PoseOffsets> & { noseLine?: JointRot; perfectBlocks: PbSet[]; hipHeight?: number; duckHipHeight?: number };
export const HIP_HEIGHT_MAX = 40;
const cleanCm = (v: unknown): number => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.max(-HIP_HEIGHT_MAX, Math.min(HIP_HEIGHT_MAX, n)) : 0; };
export const POSE_LAYERS: PoseLayer[] = ["stance", "duck", "fullGuard", "fullGuard2", "fullGuard3"];
export const emptyPoses = (): StancePoses => cleanPoses({});

/** Shoulder → hand on either side: the joints the duck layer may not move. */
export const isArmJoint = (name: string): boolean => /^(Left|Right)(Shoulder|Arm|ForeArm|Hand)$/.test(name);
/** Arms and torso: the joints a perfect block pose holds. */
export const isPbJoint = (name: string): boolean => isArmJoint(name) || /^Spine\d?$/.test(name);
const notArm = (k: string) => !isArmJoint(k);

let draft: StancePoses | null = null;
let lastRaw: string | null | undefined;
let cached: StancePoses | null = null;

function cleanSet(v: unknown, keep: (k: string) => boolean = () => true): PoseOffsets {
  const out: PoseOffsets = {};
  if (!v || typeof v !== "object" || Array.isArray(v)) return out;
  for (const [k, r] of Object.entries(v as Record<string, unknown>)) {
    if (!keep(k)) continue;
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
  if ("stance" in o || "duck" in o) { stance = cleanSet(o.stance); duck = cleanSet(o.duck, notArm); }
  // Older per-stance format: the orthodox sets become the one authored set.
  else if ("orthodox" in o || "southpaw" in o) { stance = cleanSet(o.orthodox); duck = cleanSet(o.orthodoxDuck, notArm); }
  // Oldest single-set format: it was the orthodox pose.
  else { stance = cleanSet(o); duck = {}; }
  // Saved before full guard had its own arms: it was the stance arms, so it starts there.
  const fullGuard = "fullGuard" in o ? cleanSet(o.fullGuard, isArmJoint) : cleanSet(stance, isArmJoint);
  // The secondary and third full guards start as copies of the first.
  const fullGuard2 = "fullGuard2" in o ? cleanSet(o.fullGuard2, isArmJoint) : { ...fullGuard };
  const fullGuard3 = "fullGuard3" in o ? cleanSet(o.fullGuard3, isArmJoint) : { ...fullGuard };
  // Each guard's Standard starts as that guard's arms on the stance torso. A
  // single shared set saved before guards had their own is copied to all three.
  const torso = cleanSet(stance, isPbJoint);
  const saved = Array.isArray(o.perfectBlocks) ? o.perfectBlocks : [o.perfectBlock, o.perfectBlock, o.perfectBlock];
  const perfectBlocks = [fullGuard, fullGuard2, fullGuard3].map((arms, i) => cleanPb(saved[i], { ...torso, ...arms }, i));
  const out: StancePoses = { stance, duck, fullGuard, fullGuard2, fullGuard3, perfectBlocks };
  const nl = cleanRot(o.noseLine);
  if (nl) out.noseLine = nl;
  for (const k of ["hipHeight", "duckHipHeight"] as const) { const h = cleanCm(o[k]); if (h) out[k] = h; }
  return out;
}

function cleanPb(v: unknown, seed: PoseOffsets, guard: number): PbSet {
  const o = v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, any> : {};
  const out = {} as PbSet;
  for (const k of PB_VARIANTS) {
    const e = o[k] && typeof o[k] === "object" ? o[k] : {};
    // Older shared sets listed the guards allowed to use a variant.
    const enabled = typeof e.enabled === "boolean" ? e.enabled : Array.isArray(e.stances) ? e.stances.includes(guard) : true;
    out[k] = { enabled, counter: !!e.counter };
    if (e.pose && typeof e.pose === "object") out[k].pose = cleanSet(e.pose, isPbJoint);
  }
  if (!out.standard.pose) out.standard.pose = seed;
  out.standard.enabled = true;
  out.standard.counter = false;
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

/** Edit Poses hip height (m) at crouch depth dp (draft while editing). */
export function getPoseHipHeight(dp: number): number {
  const p = draft ?? getSavedStancePoses();
  return ((p.hipHeight ?? 0) + (p.duckHipHeight ?? 0) * dp) / 100;
}

/** Saved poses (cached on the raw string, so uploads and other tabs are picked up for free). */
export function getSavedStancePoses(): StancePoses {
  let raw: string | null = null;
  try { raw = localStorage.getItem(POSE_OFFSETS_KEY); } catch { /* no storage */ }
  if (raw !== lastRaw || !cached) {
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
  if (layer === "duck" && Object.keys(set).some(isArmJoint)) set = cleanSet(set, notArm);
  if (layer.startsWith("fullGuard") && Object.keys(set).some(notArm)) set = cleanSet(set, isArmJoint);
  return mirrorIf(set, southpaw);
}
function mirrorIf(set: PoseOffsets, southpaw: boolean): PoseOffsets {
  if (!southpaw) return set;
  let m = mirrored.get(set);
  if (!m) { m = mirrorPose(set); mirrored.set(set, m); }
  return m;
}

const pbSet = (stance: number): PbSet | undefined => (draft ?? getSavedStancePoses()).perfectBlocks?.[stance];
/** Which guard variant `v` comes from: a fighting style's per-variant map (PB_VARIANTS order), else `stance`. */
const pbSrc = (v: PbVariant, stance: number, src?: readonly number[]) => src?.[PB_VARIANTS.indexOf(v)] ?? stance;
/** Guard `stance`'s perfect block variant pose (its Standard's when it has none of its own), mirrored for a southpaw. */
export function getPbPose(v: PbVariant, southpaw: boolean, stance: number): PoseOffsets {
  const pb = pbSet(stance);
  return mirrorIf(pb?.[v]?.pose ?? pb?.standard?.pose ?? NO_OFFSETS, southpaw);
}

const MIRROR_PUNCH: Record<PunchType, PunchType> = {
  jab: "cross", cross: "jab", leftHook: "rightHook", rightHook: "leftHook", leftUppercut: "rightUppercut", rightUppercut: "leftUppercut",
};
/**
 * The perfect block variant for an incoming punch (null = none) against a
 * defender in guard stance `stance`. Keyed by the punching arm as the
 * (orthodox-authored) defender sees it, so a southpaw defender mirrors it.
 * Each guard has its own eight; a straight falls back to Shoulder Roll, then
 * anything to Standard, when that guard's specific variant is switched off.
 */
export function pickPbVariant(punch: PunchType | null | undefined, defenderSouthpaw: boolean, stance: number, src?: readonly number[]): PbVariant {
  if (!punch) return "standard";
  const ok = (v: PbVariant) => !!pbSet(pbSrc(v, stance, src))?.[v]?.enabled;
  const role = defenderSouthpaw ? MIRROR_PUNCH[punch] : punch;
  if (ok(role)) return role;
  if ((role === "jab" || role === "cross") && ok("shoulderRoll")) return "shoulderRoll";
  return "standard";
}
/** Whether guard `stance` has its Shoulder Roll slot active (X plays it). */
export function shoulderRollEnabled(stance: number, src?: readonly number[]): boolean {
  return !!pbSet(pbSrc("shoulderRoll", stance, src))?.shoulderRoll?.enabled;
}
/** Whether blocking this punch in this stance is marked "trigger counterpunch". */
export function pbTriggersCounter(punch: PunchType | null | undefined, defenderSouthpaw: boolean, stance: number, src?: readonly number[]): boolean {
  const v = pickPbVariant(punch, defenderSouthpaw, stance, src);
  return v !== "standard" && !!pbSet(pbSrc(v, stance, src))?.[v]?.counter;
}

const blendCache = new WeakMap<PoseOffsets, WeakMap<PoseOffsets, PoseOffsets>>();
const lerpRot = (a: JointRot, b: JointRot, w: number): JointRot => [a[0] + (b[0] - a[0]) * w, a[1] + (b[1] - a[1]) * w, a[2] + (b[2] - a[2]) * w];
/** Weighted sum of sets (weights already normalised). */
function sumSets(sets: PoseOffsets[], ws: number[]): PoseOffsets {
  const out: PoseOffsets = {};
  sets.forEach((set, i) => {
    if (ws[i] <= 0) return;
    for (const [k, r] of Object.entries(set) as [BoneName, JointRot][]) {
      const o = out[k] ?? (out[k] = [0, 0, 0]);
      o[0] += r[0] * ws[i]; o[1] += r[1] * ws[i]; o[2] += r[2] * ws[i];
    }
  });
  return out;
}
/**
 * The stance set with its arm joints slid toward the full guard's by the guard
 * blend g (0 = normal guard, 1 = full guard), mirrored for a southpaw. The full
 * guard is the three full guards weighted by stanceW (a one-hot weight = that
 * stance); pbW slides arms + torso toward the perfect block poses.
 */
/** `pbSrc`: a fighting style's per-variant source guard (PB_VARIANTS order); unset = the guards by stanceW. */
export function getGuardOffsets(southpaw: boolean, g: number, stanceW: readonly number[] = [1, 0, 0], pbW?: Partial<Record<PbVariant, number>>, pbSrcMap?: readonly number[]): PoseOffsets {
  const base = guardOffsets(southpaw, g, stanceW);
  if (!pbW) return base;
  const vs = PB_VARIANTS.filter(v => (pbW[v] ?? 0) > 0);
  const total = vs.reduce((a, v) => a + pbW[v]!, 0);
  if (total <= 0) return base;
  const W = Math.min(1, total);
  // Mid guard switch, each guard's own pose weighted by how far the arms are into it.
  const sw = stanceW[0] + stanceW[1] + stanceW[2] || 1;
  const sets: PoseOffsets[] = [], ws: number[] = [];
  vs.forEach(v => {
    if (pbSrcMap) { sets.push(getPbPose(v, southpaw, pbSrc(v, 0, pbSrcMap))); ws.push(pbW[v]! / total); return; }
    [0, 1, 2].forEach(i => {
      if (stanceW[i] > 0) { sets.push(getPbPose(v, southpaw, i)); ws.push(pbW[v]! / total * stanceW[i] / sw); }
    });
  });
  const pb = sumSets(sets, ws);
  const out: PoseOffsets = { ...base };
  const names = new Set([...Object.keys(base), ...Object.keys(pb)].filter(isPbJoint) as BoneName[]);
  names.forEach(k => { out[k] = lerpRot(base[k] ?? NO_ROT, pb[k] ?? NO_ROT, W); });
  return out;
}
function guardOffsets(southpaw: boolean, g: number, stanceW: readonly number[]): PoseOffsets {
  const stance = getPoseOffsets("stance", southpaw);
  const sum = stanceW[0] + stanceW[1] + stanceW[2];
  const one = FULL_GUARD_LAYERS.findIndex((_, i) => stanceW[i] >= sum - 1e-6);
  const full = one >= 0 ? getPoseOffsets(FULL_GUARD_LAYERS[one], southpaw)
    : sumSets(FULL_GUARD_LAYERS.map(l => getPoseOffsets(l, southpaw)), stanceW.map(w => w / sum));
  const t = Math.max(0, Math.min(1, g || 0));
  const merge = (w: number): PoseOffsets => {
    const out: PoseOffsets = {};
    for (const [k, r] of Object.entries(stance) as [BoneName, JointRot][]) if (!isArmJoint(k)) out[k] = r;
    const names = new Set([...Object.keys(stance), ...Object.keys(full)].filter(isArmJoint) as BoneName[]);
    names.forEach(k => {
      out[k] = lerpRot(stance[k] ?? NO_ROT, full[k] ?? NO_ROT, w);
    });
    return out;
  };
  if (t <= 0) {
    // Normal guard: the stance arms as they are.
    return stance;
  }
  if (t < 1 || one < 0) return merge(t);
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

/* Edit Roster: a fixed starting guard stance per roster fighter (absent = random each fight). */
export const GUARD_STANCE_ASSIGN_KEY = "handz_guard_stance_assign";
export function loadGuardStanceAssign(): Record<string, number> {
  try {
    const o = JSON.parse(localStorage.getItem(GUARD_STANCE_ASSIGN_KEY) || "{}");
    return o && typeof o === "object" && !Array.isArray(o) ? o : {};
  } catch { return {}; }
}
export function setGuardStanceAssign(rosterId: number, stance: number | null): void {
  const all = loadGuardStanceAssign();
  if (stance == null) delete all[rosterId]; else all[rosterId] = stance;
  localStorage.setItem(GUARD_STANCE_ASSIGN_KEY, JSON.stringify(all));
}
/** An AI fighter's opening stance: its roster assignment, else random. */
export function aiOpeningStance(rosterId: number | undefined, rand: () => number = Math.random): number {
  const a = rosterId != null ? loadGuardStanceAssign()[rosterId] : undefined;
  return a === 0 || a === 1 || a === 2 ? a : Math.floor(rand() * 3);
}
