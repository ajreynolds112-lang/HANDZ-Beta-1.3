/**
 * Punch animation profiles (Neural Network → Punch Animation). A profile is a
 * keyframed set of joint rotations layered over the procedural 3D punch, plus a
 * speed track that really re-times the punch: the engine stretches each phase by
 * its mean 1/speed (setPunchSpeedWarp below), so a slowed section takes longer in
 * the fight too, and the renderer warps within phases to match.
 *
 * Profiles are authored orthodox and keyed by punch ROLE using the orthodox
 * PunchType names (jab = lead straight, leftHook = lead hook, ...). PunchType
 * names a literal arm, so a southpaw's lead straight is engine "cross": it reads
 * the "jab" profile and wears its exact left/right mirror.
 *
 * Storage: up to 50 slots per punch role, one default slot per role (worn by the
 * player and any AI without an assignment), and per-roster-fighter assignments.
 * Both keys are tunable config (tuning bundle registry).
 */
import type { FighterState, PunchType } from "../types";
import { punchPhaseFractions, setPunchSpeedWarp } from "../engine";
import type { BoneName } from "./fighterRig";
import { mirrorPose, type JointRot, type PoseOffsets } from "./poseOffsets";

export const PUNCH_PROFILES_KEY = "handz_punch_profiles";
export const PUNCH_PROFILE_ASSIGN_KEY = "handz_punch_profile_assign";
export const PROFILE_SLOTS = 50;
export const PUNCH_ROLES: PunchType[] = ["jab", "cross", "leftHook", "rightHook", "leftUppercut", "rightUppercut"];
export const PUNCH_ROLE_LABEL: Record<PunchType, string> = {
  jab: "Jab", cross: "Cross", leftHook: "Lead Hook", rightHook: "Rear Hook", leftUppercut: "Lead Uppercut", rightUppercut: "Rear Uppercut",
};
/** Speed track range (multiplier), drawn on a log scale. */
/** Default max joint rotation offset (degrees, either direction) a profile key may hold. */
export const ROT_MAX = 45;
/** Range a per-track limit may be set to. */
export const ROT_LIMIT_MIN = 1;
export const ROT_LIMIT_MAX = 180;
export type AxisLimits = [number, number, number];
/** A per-track rotation limit, clamped to its legal range (default ROT_MAX). */
export function cleanLimit(v: unknown): number {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(ROT_LIMIT_MIN, Math.min(ROT_LIMIT_MAX, n)) : ROT_MAX;
}
/** The x/y/z rotation limits of one joint in a profile. */
export function boneLimits(p: Pick<PunchProfile, "limits">, b: BoneName): AxisLimits {
  return p.limits?.[b] ?? [ROT_MAX, ROT_MAX, ROT_MAX];
}
export const SPEED_MIN = 0.1;
export const SPEED_MAX = 3;

export interface Key { t: number; v: number }
export type AxisTracks = [Key[], Key[], Key[]];
export interface PunchProfile {
  name: string;
  bones: Partial<Record<BoneName, AxisTracks>>;
  speed: Key[];
  /** Per joint x/y/z max rotation (degrees, either direction); absent = ROT_MAX. */
  limits?: Partial<Record<BoneName, AxisLimits>>;
  /** Loop Start (animation time): past it the animation plays back in reverse to τ=0 by the end. */
  loopStart?: number;
  /** What happens past Loop Start: play back in reverse ("loop", default) or ease back to the guard ("slide"). */
  loopMode?: "loop" | "slide";
}
export interface ProfileStore {
  slots: Record<PunchType, (PunchProfile | null)[]>;
  /** Default slot per role, -1 = stock animation. */
  active: Record<PunchType, number>;
}
/** rosterId → role → slot index. */
export type ProfileAssignments = Record<string, Partial<Record<PunchType, number>>>;

const MIRROR_ROLE: Record<PunchType, PunchType> = {
  jab: "cross", cross: "jab", leftHook: "rightHook", rightHook: "leftHook", leftUppercut: "rightUppercut", rightUppercut: "leftUppercut",
};
/** The engine punch a stance throws for a profile role (and back: the map is its own inverse). */
export function enginePunchForRole(role: PunchType, southpaw: boolean): PunchType {
  return southpaw ? MIRROR_ROLE[role] : role;
}

// ── storage ──
function cleanKeys(v: unknown, lo: number, hi: number): Key[] {
  if (!Array.isArray(v)) return [];
  const out: Key[] = [];
  for (const k of v) {
    const t = Number(k?.t), val = Number(k?.v);
    if (Number.isFinite(t) && Number.isFinite(val)) out.push({ t: Math.max(0, Math.min(1, t)), v: Math.max(lo, Math.min(hi, val)) });
  }
  return out.sort((a, b) => a.t - b.t);
}
export function cleanProfile(v: unknown): PunchProfile | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const limits: NonNullable<PunchProfile["limits"]> = {};
  if (o.limits && typeof o.limits === "object") {
    for (const [b, l] of Object.entries(o.limits as Record<string, unknown>)) {
      if (!Array.isArray(l) || l.length !== 3) continue;
      const lim = l.map(cleanLimit) as AxisLimits;
      if (lim.some(x => x !== ROT_MAX)) limits[b as BoneName] = lim;
    }
  }
  const bones: PunchProfile["bones"] = {};
  if (o.bones && typeof o.bones === "object") {
    for (const [b, tr] of Object.entries(o.bones as Record<string, unknown>)) {
      if (!Array.isArray(tr) || tr.length !== 3) continue;
      const lim = boneLimits({ limits }, b as BoneName);
      const axes = tr.map((a, i) => cleanKeys(a, -lim[i], lim[i])) as AxisTracks;
      if (axes.some(a => a.length)) bones[b as BoneName] = axes;
    }
  }
  const out: PunchProfile = { name: typeof o.name === "string" ? o.name.slice(0, 40) : "", bones, speed: cleanKeys(o.speed, SPEED_MIN, SPEED_MAX) };
  if (Object.keys(limits).length) out.limits = limits;
  const ls = validLoopStart(o.loopStart);
  if (ls != null) out.loopStart = ls;
  if (ls != null && o.loopMode === "slide") out.loopMode = "slide";
  return out;
}
function emptyStore(): ProfileStore {
  const slots = {} as ProfileStore["slots"], active = {} as ProfileStore["active"];
  for (const r of PUNCH_ROLES) { slots[r] = Array(PROFILE_SLOTS).fill(null); active[r] = -1; }
  return { slots, active };
}
function cleanStore(v: unknown): ProfileStore {
  const out = emptyStore();
  const o = v && typeof v === "object" ? v as Record<string, any> : {};
  for (const r of PUNCH_ROLES) {
    const arr = Array.isArray(o.slots?.[r]) ? o.slots[r] : [];
    for (let i = 0; i < PROFILE_SLOTS; i++) out.slots[r][i] = cleanProfile(arr[i]);
    const a = Number(o.active?.[r]);
    out.active[r] = Number.isInteger(a) && a >= 0 && a < PROFILE_SLOTS && out.slots[r][a] ? a : -1;
  }
  return out;
}

function cachedRead<T>(key: string, parse: (raw: string | null) => T) {
  let lastRaw: string | null | undefined, val: T;
  return (): T => {
    let raw: string | null = null;
    try { raw = localStorage.getItem(key); } catch { /* no storage */ }
    if (raw !== lastRaw) {
      lastRaw = raw;
      try { val = parse(raw); } catch { val = parse(null); }
    }
    return val;
  };
}
export const loadProfileStore = cachedRead(PUNCH_PROFILES_KEY, raw => cleanStore(raw ? JSON.parse(raw) : {}));
export const loadAssignments = cachedRead(PUNCH_PROFILE_ASSIGN_KEY, raw => {
  const o = raw ? JSON.parse(raw) : {};
  return (o && typeof o === "object" && !Array.isArray(o) ? o : {}) as ProfileAssignments;
});

export function saveProfileStore(s: ProfileStore): void {
  localStorage.setItem(PUNCH_PROFILES_KEY, JSON.stringify(cleanStore(s)));
}
export function saveProfile(role: PunchType, slot: number, p: PunchProfile, makeDefault: boolean): void {
  const s = loadProfileStore();
  const next: ProfileStore = { slots: { ...s.slots, [role]: [...s.slots[role]] }, active: { ...s.active } };
  next.slots[role][slot] = cleanProfile(p);
  if (makeDefault) next.active[role] = slot;
  saveProfileStore(next);
}
export function copyProfileSlot(role: PunchType, from: number, to: number): void {
  const s = loadProfileStore();
  const src = s.slots[role][from];
  if (!src || from === to) return;
  const next: ProfileStore = { slots: { ...s.slots, [role]: [...s.slots[role]] }, active: s.active };
  next.slots[role][to] = cleanProfile(JSON.parse(JSON.stringify(src)));
  saveProfileStore(next);
}
export function setDefaultSlot(role: PunchType, slot: number): void {
  const s = loadProfileStore();
  saveProfileStore({ ...s, active: { ...s.active, [role]: slot } });
}
export function setAssignments(rosterId: number, a: Partial<Record<PunchType, number>>): void {
  const all = { ...loadAssignments() };
  const clean: Partial<Record<PunchType, number>> = {};
  for (const r of PUNCH_ROLES) if (a[r] != null && a[r]! >= 0) clean[r] = a[r];
  if (Object.keys(clean).length) all[rosterId] = clean; else delete all[rosterId];
  localStorage.setItem(PUNCH_PROFILE_ASSIGN_KEY, JSON.stringify(all));
}
/** A random filled slot per role (roles with no saved profiles stay on the default). */
export function randomAssignments(rand: () => number = Math.random): Partial<Record<PunchType, number>> {
  const s = loadProfileStore();
  const out: Partial<Record<PunchType, number>> = {};
  for (const r of PUNCH_ROLES) {
    const filled = s.slots[r].map((p, i) => (p ? i : -1)).filter(i => i >= 0);
    if (filled.length) out[r] = filled[Math.floor(rand() * filled.length)];
  }
  return out;
}

// ── evaluation ──
const smooth = (x: number) => x * x * (3 - 2 * x);

/** Rotation track value: keys eased between, implicit 0 at both ends unless a key sits there. */
export function evalRotation(keys: Key[], t: number): number {
  if (!keys.length) return 0;
  let prev: Key = keys[0].t <= 0 ? keys[0] : { t: 0, v: 0 };
  for (const k of keys) {
    if (k.t >= t) {
      if (k.t <= prev.t) return k.v;
      return prev.v + (k.v - prev.v) * smooth((t - prev.t) / (k.t - prev.t));
    }
    prev = k;
  }
  const end: Key = { t: 1, v: 0 };
  if (prev.t >= 1) return prev.v;
  return prev.v + (end.v - prev.v) * smooth((t - prev.t) / (end.t - prev.t));
}

/** Speed track value: linear between keys, flat past the first/last key, 1 with none. */
export function evalSpeed(keys: Key[], t: number): number {
  const v = evalSpeedRaw(keys, t);
  return Number.isFinite(v) ? Math.max(SPEED_MIN, Math.min(SPEED_MAX, v)) : 1;
}
function evalSpeedRaw(keys: Key[], t: number): number {
  if (!keys.length) return 1;
  if (t <= keys[0].t) return keys[0].v;
  for (let i = 1; i < keys.length; i++) {
    const a = keys[i - 1], b = keys[i];
    if (t <= b.t) return b.t <= a.t ? b.v : a.v + (b.v - a.v) * (t - a.t) / (b.t - a.t);
  }
  return keys[keys.length - 1].v;
}

const WARP_N = 256;
interface WarpTable { cum: Float32Array; total: number }
const warpCache = new WeakMap<Key[], WarpTable>();
/** cum[i] = ∫ 1/speed dτ over [0, i/N] (raw, un-normalised). */
function warpTable(keys: Key[]): WarpTable {
  let tab = warpCache.get(keys);
  if (tab) return tab;
  const cum = new Float32Array(WARP_N + 1);
  for (let i = 1; i <= WARP_N; i++) {
    const tm = (i - 0.5) / WARP_N;
    cum[i] = cum[i - 1] + 1 / (Math.max(SPEED_MIN, evalSpeed(keys, tm)) * WARP_N);
  }
  tab = { cum, total: cum[WARP_N] };
  warpCache.set(keys, tab);
  return tab;
}
function cumAt(tab: WarpTable, tau: number): number {
  const x = Math.max(0, Math.min(1, tau)) * WARP_N;
  const i = Math.min(WARP_N - 1, Math.floor(x));
  return tab.cum[i] + (tab.cum[i + 1] - tab.cum[i]) * (x - i);
}
/** Mean slow-down (1/speed) over animation time [a,b]; a zero-width span reads the point. */
export function speedSlowdown(keys: Key[], a: number, b: number): number {
  if (!keys.length) return 1;
  if (b - a < 1e-6) return 1 / Math.max(SPEED_MIN, evalSpeed(keys, a));
  const tab = warpTable(keys);
  return (cumAt(tab, b) - cumAt(tab, a)) / (b - a);
}
/** Animation time τ → real time fraction u (inverse of warpTime). */
export function realTimeOf(keys: Key[], tau: number): number {
  if (!keys.length) return tau;
  const tab = warpTable(keys);
  return tab.total > 0 ? cumAt(tab, tau) / tab.total : tau;
}
/** Real time fraction u → animation time τ (both 0..1). */
export function warpTime(keys: Key[], u: number): number {
  if (!keys.length) return u;
  const tab = warpTable(keys);
  const x = Math.max(0, Math.min(1, u)) * tab.total;
  let lo = 0, hi = WARP_N;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (tab.cum[m] <= x) lo = m; else hi = m; }
  const span = tab.cum[hi] - tab.cum[lo];
  return (lo + (span > 0 ? (x - tab.cum[lo]) / span : 0)) / WARP_N;
}

/** A usable Loop Start, or null (off / out of range). */
export function validLoopStart(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v > 0.005 && v < 0.995 ? v : null;
}
/**
 * The animation time the pose is read at. Up to Loop Start it's τ itself; past
 * it the timeline runs backwards so the end lands exactly on the first frame.
 */
export function loopTime(loopStart: number | null | undefined, tau: number): number {
  const L = validLoopStart(loopStart);
  if (L == null || tau <= L) return tau;
  return Math.max(0, L * (1 - tau) / (1 - L));
}

/** Slide Back progress 0..1 past Loop Start (0 before it / in loop mode), eased at both ends. */
export function slideWeight(p: Pick<PunchProfile, "loopStart" | "loopMode">, tau: number): number {
  const L = validLoopStart(p.loopStart);
  if (L == null || p.loopMode !== "slide" || tau <= L) return 0;
  const x = Math.max(0, Math.min(1, (tau - L) / (1 - L)));
  return x * x * x * (x * (x * 6 - 15) + 10);
}

export function evalProfileOffsets(p: PunchProfile, tau: number): PoseOffsets {
  const out: PoseOffsets = {};
  for (const [b, axes] of Object.entries(p.bones) as [BoneName, AxisTracks][]) {
    const r = axes.map(k => evalRotation(k, tau)) as JointRot;
    if (r.some(v => v !== 0)) out[b] = r;
  }
  return out;
}

// ── punch clock ──
/** The engine punch's overall real-time fraction 0..1 (launch → end of retraction). */
export function punchClock(f: FighterState): number | null {
  if (!f.isPunching || !f.currentPunch) return null;
  const fr = punchPhaseFractions(f);
  if (!fr) return null;
  if (f.punchPhase === "retraction") {
    const [a, b] = fr.retraction;
    return a + (b - a) * Math.max(0, Math.min(1, f.retractionProgress || 0));
  }
  return Math.max(0, Math.min(1, f.punchProgress || 0));
}

/**
 * A copy of the fighter whose punch phase/progress sit at time `tau`: animation
 * time on the stock timeline (what the pose solve reads), or with `real` the
 * engine's real-time fraction (what the engine itself would hold).
 */
export function fighterAtPunchTime(f: FighterState, tau: number, real = false): FighterState {
  const fr = punchPhaseFractions(f, !real);
  if (!fr) return f;
  const order = ["launchDelay", "armSpeed", "contact", "linger", "retraction"] as const;
  let phase: (typeof order)[number] = "retraction";
  for (const ph of order) { if (tau < fr[ph][1]) { phase = ph; break; } }
  if (phase === "retraction") {
    const [a, b] = fr.retraction;
    return { ...f, punchPhase: "retraction", punchProgress: a, retractionProgress: b > a ? (tau - a) / (b - a) : 1 };
  }
  return { ...f, punchPhase: phase, punchProgress: tau, retractionProgress: 0 };
}

// ── resolution ──
let draft: { role: PunchType; profile: PunchProfile } | null = null;
/** The editor's unsaved profile, worn for its role while the editor is open. */
export function setPunchProfileDraft(d: typeof draft): void { draft = d; }

export function profileForRole(f: FighterState, role: PunchType): PunchProfile | null {
  if (draft) return draft.role === role ? draft.profile : null;
  const store = loadProfileStore();
  let slot = store.active[role];
  if (f.punchProfileRosterId != null) {
    const a = loadAssignments()[f.punchProfileRosterId]?.[role];
    if (a != null && store.slots[role][a]) slot = a;
  }
  return slot >= 0 ? store.slots[role][slot] : null;
}

// The engine reads the speed track through this hook (it can't import us).
setPunchSpeedWarp(f => {
  if (!f.currentPunch) return null;
  const p = profileForRole(f, enginePunchForRole(f.currentPunch, f.boxingStance === "southpaw"));
  const keys = p?.speed;
  return keys && keys.length ? (a, b) => speedSlowdown(keys, a, b) : null;
});

export interface ActivePunchProfile {
  /** Fighter re-timed by the speed track (pass to the pose solve). */
  fighter: FighterState;
  /** Joint offsets at this instant, already mirrored for a southpaw. */
  offsets: PoseOffsets;
  /** Slide Back blend toward the guard pose, 0..1 (fighter/offsets are then held at Loop Start). */
  slide: number;
}
/** The profile a punching fighter wears this frame, or null for the stock animation. */
export function activePunchProfile(f: FighterState): ActivePunchProfile | null {
  const u = punchClock(f);
  if (u == null || !f.currentPunch) return null;
  const southpaw = f.boxingStance === "southpaw";
  const role = enginePunchForRole(f.currentPunch, southpaw);
  const p = profileForRole(f, role);
  if (!p) return null;
  const raw = warpTime(p.speed, u);
  const slide = slideWeight(p, raw);
  const L = validLoopStart(p.loopStart);
  const tau = p.loopMode === "slide" ? (L != null ? Math.min(raw, L) : raw) : loopTime(p.loopStart, raw);
  const offs = evalProfileOffsets(p, tau);
  const retimed = p.speed.length > 0 || L != null;
  return { fighter: retimed ? fighterAtPunchTime(f, tau) : f, offsets: southpaw ? mirrorPose(offs) : offs, slide };
}
