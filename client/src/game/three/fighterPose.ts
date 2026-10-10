/**
 * Pose solver: FighterState (+ the engine's exported visual helpers) → joint
 * targets for a boxer rig, in the fighter's body space (metres, +x toward the
 * way the fighter faces, +y up, +z the fighter's right).
 *
 * Ported from the 2D drawFighter / drawArms so every readable cue keeps the
 * engine's timing. Nothing here writes to the fighter. The only memory kept is
 * render-side smoothing (stance blend, walk phase, punch/body follow-through),
 * owned by the caller.
 *
 * Punches are smoothed render-side: the engine's arm can restart from guard
 * (re-punch, interrupted punch, telegraph pull-back ending) in a single tick,
 * which on a 2 m boxer reads as the fist and body teleporting. Each arm's
 * extension follows the engine's on a critically damped spring (accelerates
 * out of the guard, decelerates into the target, never overshoots), an arm
 * that stops punching eases home along the punch it was throwing, and the
 * body (lunge, rotation, lean) follows the arms on a slower spring. Gloves still land at the real hit
 * range because the target is measured from the fighter's origin and the arm IK
 * stretches for whatever the body hasn't covered yet.
 *
 * Punch reach uses the real hit range (getPunchReachPx), never the visual-only
 * reach sliders, so a glove that lands in 3D is a punch that can land.
 */
import * as THREE from "three";
import { PUNCH_CONFIGS, type FighterState, type PunchType } from "../types";
import {
  fatigueArmSnapHold, fatigueSwayOffsets, fatigueSwaySlipFraction, flinchArmOffsets,
  getPunchReachPx, punchPhaseFractions, resetHeadDuckOffset, resetSnapDistanceMult,
  HOOK_HEAD_TURN_DURATION, STUN_HEAD_TURN_DURATION,
} from "../engine";
import { levelScale } from "@/lib/scalingConfig";
import { getActivePunchAnimConfig } from "@/lib/punchAnimConfig";
import { PX_PER_UNIT } from "./worldMapping";
import { getStandHeightConfig } from "@/lib/standHeightConfig";
import { STANCE_FEET_M, DUCK_FEET_WIDER_M, DUCK_FEET_LONGER_M } from "../legCollision";

/** 2D figure body height in px (BODY_H in renderer.ts), the unit its offsets scale with. */
const BODY_H_PX = 28 * 1.6;
/** 2D px → metres on this figure: the 2D boxer is ~107px tall, the rig 2m. */
const PX2M = 2.0 / 107;
const TELEGRAPH_PULLBACK_M = 2 * PX2M * 1.6; // a touch larger than 2D so it reads at broadcast distance
const TELEGRAPH_PULLBACK_START = 0.6;
const SLIP_WORLD_DIR: Record<string, { x: number; z: number }> = {
  left: { x: -1, z: 0 }, right: { x: 1, z: 0 }, forward: { x: 0, z: -1 }, back: { x: 0, z: 1 },
};
const LEFT_PUNCHES = new Set<PunchType>(["jab", "leftHook", "leftUppercut"] as PunchType[]);

/** Rig measurements the solver needs (bind pose, body space). */
export interface RigDims {
  hips: THREE.Vector3;
  chest: THREE.Vector3;      // Spine2
  headY: number;             // head centre height
  shoulder: [THREE.Vector3, THREE.Vector3]; // upper-arm joints, left/right
  armLen: number;            // shoulder → glove centre, straight
  legLen: number;            // hip joint → ankle
  ankleY: number;
}

export interface PoseTargets {
  pelvisOffset: THREE.Vector3;
  pelvisRot: THREE.Quaternion;
  chestRot: THREE.Quaternion;
  headRot: THREE.Quaternion;  // body space
  /** Hit turn of the head (rad, + = left), applied by the model after it aims the nose line: crit snap or hook turn. */
  headTurnYaw: number;
  glove: [THREE.Vector3, THREE.Vector3];
  elbowPole: [THREE.Vector3, THREE.Vector3];
  maxStretch: [number, number];
  ankle: [THREE.Vector3, THREE.Vector3];
  kneePole: [THREE.Vector3, THREE.Vector3];
  toeDir: [THREE.Vector3, THREE.Vector3];
}

export interface PoseMemory {
  stanceBlend: number;  // 0 orthodox → 1 southpaw
  /** Last engine step cycle seen (one cycle = both feet have stepped once). */
  walkT?: number;
  walkAmt: number;
  /** Which foot opens the current step cycle (0 left, 1 right). */
  walkFirst?: 0 | 1;
  /** Stride shown (m): the engine's while stepping, settling to 0 once planted. */
  walkD?: number;
  walkIdle?: boolean;
  /** Feet were planted last frame (next step re-picks its first foot). */
  walkPlanted?: boolean;
  lastX: number;
  lastZ: number;
  /** Body-space direction the feet step along. Held through frames with no
   *  real movement so a stalled or blocked step doesn't flicker the feet. */
  walkDirX?: number;
  walkDirZ?: number;
  init: boolean;
  /** Per arm (left, right): displayed extension 0..1, following the engine's. */
  armExt: [number, number];
  /** The punch each arm is showing (kept while it eases home after the engine drops it). */
  armPunch: [PunchType | null, PunchType | null];
  /** Head/body of that punch, latched with it. */
  armBody: [boolean, boolean];
  /** Per arm: how far the body has followed that arm's punch (slower than the arm). */
  bodyExt: [number, number];
  /** Spring velocities for armExt / bodyExt (1/s). */
  armVel: [number, number];
  bodyVel: [number, number];
  /** Per arm: displayed telegraph pull-back 0..1. */
  pullback: [number, number];
  /** Per arm: how far the punch's shoulder-joint rotation (Punch Animation Editor) is blended in, 0..1. */
  shW: [number, number];
  /** The punch whose shoulder rotation that arm is showing (latched while it eases out). */
  shPunch: [PunchType | null, PunchType | null];
  /** Per arm: 1 = the glove takes the punch's outbound path (hook arc, uppercut U), 0 = straight home to the guard. */
  arcK: [number, number];
  /** Displayed head pitch (rad) looking down at a ducked opponent during a duck-tracked punch. */
  duckLook: number;
  /** Per arm, the punch motion: torso turn, hip turn, the other glove's cover and the uppercut knee dip, 0..1. */
  motBody?: [number, number];
  motHip?: [number, number];
  motCover?: [number, number];
  motDip?: [number, number];
}

export function newPoseMemory(): PoseMemory {
  return {
    stanceBlend: 0, walkAmt: 0, lastX: 0, lastZ: 0, init: false,
    armExt: [0, 0], armPunch: [null, null], armBody: [false, false], bodyExt: [0, 0], pullback: [0, 0],
    armVel: [0, 0], bodyVel: [0, 0], shW: [0, 0], shPunch: [null, null], arcK: [1, 1], duckLook: 0,
    motBody: [0, 0], motHip: [0, 0], motCover: [0, 0], motDip: [0, 0],
  };
}

/** Arm spring stiffness (rad/s): guard → full extension in ~0.15s, peak hand speed ~10 m/s. */
const ARM_OMEGA = 30;
/** Retraction is a touch slower so the glove visibly travels home. */
const ARM_BACK_OMEGA = 22;
/** Body follow-through spring (rad/s): the torso trails the arm. */
const BODY_OMEGA = 15;

/** Critically damped spring step, exact for any dt. Returns [x, v]. */
function spring(x: number, v: number, target: number, omega: number, dt: number): [number, number] {
  const e = x - target;
  const k = Math.exp(-omega * dt);
  const c = v + omega * e;
  return [target + (e + c * dt) * k, (v - omega * c * dt) * k];
}

/** Move `cur` toward `target`: exponential approach, capped at `maxStep`. */
function follow(cur: number, target: number, rate: number, maxStep: number, dt: number): number {
  const d = (target - cur) * Math.min(1, dt * rate);
  return cur + Math.max(-maxStep, Math.min(maxStep, d));
}

export interface PoseContext {
  opponent: FighterState | null;
  dt: number;
  /**
   * Keyframed (profiled) punch: arms skip the follow-through springs (with no
   * engine punch passed in, both hold the guard exactly). Fight punches last
   * well under the springs' ~0.13s rise, so smoothing them leaves a twitch.
   */
  snapPunch?: boolean;
  /** Punch profile height track (m): raises/lowers the hips; feet stay planted. */
  hipHeight?: number;
  /** Leave out the backward (away from the opponent) part of the slip lean. */
  dropBackSlip?: boolean;
}

const UP = new THREE.Vector3(0, 1, 0);
const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();

/** Strides at least this long (m) get the full foot lift. */
const LIFT_FULL_STRIDE = 0.3;

function smooth(t: number): number {
  const c = Math.max(0, Math.min(1, t));
  return c * c * (3 - 2 * c);
}
function yawQ(a: number, out = new THREE.Quaternion()): THREE.Quaternion {
  return out.setFromAxisAngle(UP, a);
}
/** Tilt the up axis toward (lx, 1, lz) — lean forward/sideways in body space. */
function tiltQ(lx: number, lz: number, out = new THREE.Quaternion()): THREE.Quaternion {
  return out.setFromUnitVectors(UP, _v.set(lx, 1, lz).normalize());
}

/** World (engine x/z) direction → body-space (x fwd, z right) for this facing. */
function toLocal(dx: number, dz: number, fa: number): { x: number; z: number } {
  const c = Math.cos(fa), s = Math.sin(fa);
  return { x: dx * c + dz * s, z: -dx * s + dz * c };
}

/**
 * High or low line for the arm pose: the punch config's hitsHead, with the aim
 * flag consulted while the attacker is ducking, and a standing duck-tracked
 * punch dropped to the low line while its target is ducking.
 */
export function punchHitsHead(f: FighterState, punch: PunchType): boolean {
  const hitsHead = PUNCH_CONFIGS[punch]?.hitsHead ?? true;
  if (f.defenseState === "duck") return f.punchAimsHead && hitsHead;
  // Duck-tracked at a ducked head: thrown from standing on the low line.
  return hitsHead && !f.duckTrackLowLine;
}

/** How far a full duck drops the head (m): punches and the look-down aim this far lower. */
const DUCK_HEAD_DROP_M = 0.23;
/** Opponent duck depth (0..1) below which the puncher's head stays level. */
const DUCK_LOOK_MIN = 0.2;
/** Stun-hook head turn: peak yaw (rad) and how fast it snaps in (s). */
const HEAD_SNAP_ANGLE = Math.PI / 4; // uppercut look-up: 45°, out and back inside the snap's duration
const HEAD_TURN_ANGLE = Math.PI / 2; // straight/hook turn: 90°
const STUN_HEAD_TURN_IN = 0.1;
/** Landed hook to the head: the head turns this far with the punch (30°), in fast, then eases home. */
const HOOK_TURN_ANGLE = Math.PI / 6;
const HOOK_TURN_IN = 0.15;

/** Share of a hook's way home covered during its linger (the rest in retraction). */
const HOOK_LINGER_RETURN = 0.6;
/** Sideways torso lean (tilt ratio) of the uppercut slip at full weight. */
const UPPER_SLIP = 0.22;
/** Extra hip drop at a full duck (fraction of leg length). */
const DUCK_HIP_DROP = 0.11;
/** Full duck: feet this much wider side to side, and longer front to back (shared with leg collision). */
const DUCK_FEET_WIDER = DUCK_FEET_WIDER_M;
const DUCK_FEET_LONGER = DUCK_FEET_LONGER_M;


// ── punch motion (all six punches) ──
// Every punch is phase-locked to the engine timeline (animation time):
//   Launch  — the other glove comes up to the cheek, the hips start to turn and
//             the punching hand sets: barely leaves the guard on a straight,
//             chambers out to the side on a hook, drops to load an uppercut.
//   Extend  — the punch itself, driven by the hips (they lead the shoulders),
//             landing exactly at the end of Extend.
//   Linger  — held on the target.
//   Retract — straight back to the guard; the covering glove stays up until
//             the punching hand is nearly home.
/** Glove travel at the end of Launch (share of the punch path) per class. */
const STRAIGHT_LAUNCH_E = 0.04, HOOK_LAUNCH_E = 0.12, UPPER_LAUNCH_E = 0.3;
/** Fastest a glove may travel along its path (share per second): a full punch in no less than 50 ms. */
const PUNCH_MAX_RATE = 20;
/** Hook chamber at the end of Launch: out to the side and up from the guard (m). */
const HOOK_CHAMBER_OUT = 0.12, HOOK_CHAMBER_UP = 0.04;
/** Uppercut load: glove drop below the shoulder (m). */
const UPPER_LOAD_DROP = 0.4;
/** Chin tuck (rad of head pitch) behind the punching shoulder at contact. */
const PUNCH_CHIN_TUCK = 0.12;
/** Knee dip (m) of the uppercut load, before the legs drive up through the punch. */
const UPPER_DIP_M = 0.06;
type PunchClass = "jab" | "cross" | "leadHook" | "rearHook" | "leadUpper" | "rearUpper";
/** Body at contact per punch class: torso yaw (rad), pelvis yaw (rad), forward lean (tilt ratio, before Lean Forward), foot pivot (0-1). */
const PUNCH_BODY: Record<PunchClass, { chest: number; hip: number; lean: number; pivot: number }> = {
  jab:       { chest: 0.32, hip: 0.12, lean: 0.05, pivot: 0 },
  cross:     { chest: 0.95, hip: 0.62, lean: 0.16, pivot: 0.8 },
  // Lead hook: turned by the hips and shoulders, snapped short; the lead foot
  // barely pivots (only the weight shift of a head hook turns it).
  leadHook:  { chest: 0.62, hip: 0.36, lean: 0.03, pivot: 0.35 },
  rearHook:  { chest: 0.85, hip: 0.55, lean: 0.06, pivot: 0.9 },
  leadUpper: { chest: 0.3, hip: 0.22, lean: 0, pivot: 0.45 },
  rearUpper: { chest: 0.62, hip: 0.42, lean: 0.03, pivot: 0.75 },
};
function punchClass(p: PunchType, rear: boolean): PunchClass {
  if (p.includes("Hook")) return rear ? "rearHook" : "leadHook";
  if (p.includes("Uppercut")) return rear ? "rearUpper" : "leadUpper";
  return rear ? "cross" : "jab";
}

interface PunchMotion { e: number; body: number; hip: number; cover: number; dip: number }
function punchMotion(f: FighterState, p: PunchType): PunchMotion {
  const fr = punchPhaseFractions(f, true);
  const ph = f.punchPhase;
  const hook = p.includes("Hook"), upper = p.includes("Uppercut");
  const e0 = hook ? HOOK_LAUNCH_E : upper ? UPPER_LAUNCH_E : STRAIGHT_LAUNCH_E;
  let m: PunchMotion;
  if (!fr || !ph) { const e = Math.sin(Math.min(1, f.punchProgress || 0) * Math.PI); m = { e, body: e, hip: e, cover: e, dip: 0 }; }
  else {
    const pr = f.punchProgress || 0;
    const prog = (k: keyof typeof fr) => { const [a, b] = fr[k]; return b > a ? Math.max(0, Math.min(1, (pr - a) / (b - a))) : 1; };
    if (ph === "launchDelay") {
      const L = smooth(prog("launchDelay"));
      // Hooks and uppercuts set the hips earlier than a straight.
      m = { e: e0 * L, body: (hook ? 0.12 : upper ? 0.1 : 0.08) * L, hip: (hook || upper ? 0.3 : 0.25) * L, cover: 0.6 * L, dip: upper ? L : 0 };
    } else if (ph === "armSpeed") {
      const X = prog("armSpeed");
      // Straights accelerate late into lockout; hooks and uppercuts are thrown
      // by the turn, with an even swing.
      const travel = hook || upper ? smooth(X) : smooth(Math.pow(X, 1.25));
      const b0 = hook ? 0.12 : upper ? 0.1 : 0.08, h0 = hook || upper ? 0.3 : 0.25;
      m = {
        e: e0 + (1 - e0) * travel,
        body: b0 + (1 - b0) * smooth(X / (hook ? 0.9 : 1)),
        hip: h0 + (1 - h0) * smooth(X / (hook || upper ? 0.6 : 0.7)),
        cover: 0.6 + 0.4 * smooth(X / 0.4),
        // The legs drive the uppercut up out of the dip.
        dip: upper ? 1 - smooth(X / 0.6) : 0,
      };
    } else if (ph === "retraction") {
      const R = Math.max(0, Math.min(1, f.retractionProgress || 0));
      const back = 1 - smooth(R);
      m = { e: (hook ? 1 - HOOK_LINGER_RETURN : 1) * back, body: back, hip: 1 - smooth(R / 0.9), cover: 1 - smooth((R - 0.45) / 0.55), dip: 0 };
    } else if (ph === "linger" && hook) {
      // A hook snaps off the target: it starts home through the linger.
      m = { e: 1 - HOOK_LINGER_RETURN * smooth(prog("linger")), body: 1, hip: 1, cover: 1, dip: 0 };
    } else m = { e: 1, body: 1, hip: 1, cover: 1, dip: 0 };
  }
  // A feint is a short sold punch: it stops well short and comes back.
  if (f.isFeinting) { m.e *= 0.42; m.body *= 0.5; m.hip *= 0.5; m.dip *= 0.5; }
  return m;
}

/** Solve the full pose. `dims` from the rig, `mem` is the caller's per-fighter smoothing. */
export function solvePose(f: FighterState, dims: RigDims, mem: PoseMemory, ctx: PoseContext, out: PoseTargets): PoseTargets {
  const dt = Math.max(0, Math.min(0.1, ctx.dt));
  // First frame (or a long stall, e.g. a preview card coming back on screen):
  // show the engine's pose as-is rather than easing into it from nothing.
  const snapAll = !mem.init || ctx.dt > 0.25;
  const fa = f.facingAngle;
  const southpaw = f.boxingStance === "southpaw";

  // ── stance blend (render-side smoothing only) ──
  const sTarget = southpaw ? 1 : 0;
  mem.stanceBlend += (sTarget - mem.stanceBlend) * Math.min(1, dt * 7);
  if (Math.abs(mem.stanceBlend - sTarget) < 0.002) mem.stanceBlend = sTarget;
  const sb = mem.stanceBlend;

  // ── walking, from movement this frame (the 3D layer's own read) ──
  if (!mem.init) { mem.lastX = f.x; mem.lastZ = f.z; mem.init = true; }
  const mdx = f.x - mem.lastX, mdz = f.z - mem.lastZ;
  mem.lastX = f.x; mem.lastZ = f.z;
  const moved = Math.hypot(mdx, mdz) / PX_PER_UNIT;
  const speed = dt > 0 ? moved / dt : 0;
  const moveLocal = moved > 1e-5 ? toLocal(mdx, mdz, fa) : { x: 0, z: 0 };
  const ml = Math.hypot(moveLocal.x, moveLocal.z) || 1;
  if (moved > 0.0005) {
    const k = mem.walkDirX === undefined || mem.walkPlanted !== false ? 1 : Math.min(1, dt * 12);
    let wx = (mem.walkDirX ?? 0) + (moveLocal.x / ml - (mem.walkDirX ?? 0)) * k;
    let wz = (mem.walkDirZ ?? 0) + (moveLocal.z / ml - (mem.walkDirZ ?? 0)) * k;
    const wl = Math.hypot(wx, wz);
    if (wl > 1e-4) { wx /= wl; wz /= wl; mem.walkDirX = wx; mem.walkDirZ = wz; }
  }
  const walkTarget = Math.min(1, speed / 1.2);
  mem.walkAmt += (walkTarget - mem.walkAmt) * Math.min(1, dt * 10);
  // Step-and-drag, timed by the engine's step cycle (the rhythm reads the same
  // cycle). The engine advances it by distance walked, so planted feet don't skate.
  const prevCycle = Math.floor(mem.walkT ?? 0);
  const walkT = f.walkCycle ?? 0;
  let walkD = mem.walkD ?? 0;
  const stepping = (f.walkStride ?? 0) > 0;
  if (stepping) walkD = f.walkStride ?? 0;
  else walkD *= Math.exp(-dt * 10); // planted: any mid-step offset settles under the stance
  const idle = walkD < 0.005;
  if (idle) { walkD = 0; mem.walkIdle = true; mem.walkDirX = mem.walkDirZ = undefined; }
  mem.walkT = walkT; mem.walkD = walkD;

  // ── body-level readings ──
  const dp = Math.max(0, Math.min(1, f.duckProgress || 0)); // the delayed crouch, never the input
  const bobPx = f.rhythmLevel > 0 ? Math.abs((f.swayOffset || 0) / 5) * 3 * 1.6 : Math.sin(f.bobPhase || 0) * 1.5 * 1.6;
  const swayFwdPx = (f.swayOffset || 0) * 0.5;

  // ── punch follow-through (render-side) ──
  const enginePunch = f.isPunching ? f.currentPunch : null;
  const firstFrame = !mem.armExt; // memory from before these fields existed
  if (firstFrame || !mem.armVel) Object.assign(mem, { armExt: [0, 0], armPunch: [null, null], armBody: [false, false], bodyExt: [0, 0], pullback: [0, 0], armVel: [0, 0], bodyVel: [0, 0] });
  if (!mem.shW) Object.assign(mem, { shW: [0, 0], shPunch: [null, null], arcK: [1, 1] });
  if (!mem.motBody || !mem.motHip || !mem.motCover || !mem.motDip) Object.assign(mem, { motBody: [0, 0], motHip: [0, 0], motCover: [0, 0], motDip: [0, 0] });
  const motBody = mem.motBody!, motHip = mem.motHip!, motCover = mem.motCover!, motDip = mem.motDip!;
  const engineMotion = enginePunch ? punchMotion(f, enginePunch) : null;
  for (let i = 0; i < 2; i++) {
    const isLeft = i === 0;
    const mine = !!enginePunch && LEFT_PUNCHES.has(enginePunch) === isLeft;
    if (mine) {
      // A different punch on the same arm restarts from where the glove is now.
      mem.armPunch[i] = enginePunch;
      mem.armBody[i] = !punchHitsHead(f, enginePunch!);
    }
    const motion = mine ? engineMotion : null;
    const target = motion ? motion.e : 0;
    // snapPunch with no engine punch = a profiled punch solved as the guard:
    // both arms sit exactly at the guard so only the keyframes move them.
    const snapArm = snapAll || (!!ctx.snapPunch && (mine || !enginePunch));
    // Punches are phase-locked to the engine: no spring lag, so contact lands
    // exactly at the end of Extend. A spring only bridges a jump against the
    // punch's own direction (re-punch from an extended arm, interrupted punch).
    const onTrack = !!motion && (f.punchPhase === "retraction" ? target <= mem.armExt[i] + 1e-4 : target >= mem.armExt[i] - 1e-4);
    if (snapArm) { mem.armExt[i] = target; mem.armVel[i] = 0; mem.bodyExt[i] = target; mem.bodyVel[i] = 0; }
    else if (onTrack) {
      // On the engine's curve, rate-capped so a phase shorter than a frame
      // (or a skipped one) still shows travel instead of a one-frame jump.
      const step = PUNCH_MAX_RATE * dt;
      mem.armExt[i] += Math.max(-step, Math.min(step, target - mem.armExt[i]));
      mem.armVel[i] = 0; mem.bodyExt[i] = mem.armExt[i]; mem.bodyVel[i] = 0;
    }
    else {
      const w = target >= mem.armExt[i] ? ARM_OMEGA : ARM_BACK_OMEGA;
      [mem.armExt[i], mem.armVel[i]] = spring(mem.armExt[i], mem.armVel[i], target, w, dt);
      mem.armExt[i] = Math.max(0, Math.min(1, mem.armExt[i]));
      [mem.bodyExt[i], mem.bodyVel[i]] = spring(mem.bodyExt[i], mem.bodyVel[i], mem.armExt[i], BODY_OMEGA, dt);
      mem.bodyExt[i] = Math.max(0, Math.min(1, mem.bodyExt[i]));
    }
    if (motion) { motBody[i] = motion.body; motHip[i] = motion.hip; motCover[i] = motion.cover; motDip[i] = motion.dip; }
    else if (snapArm) { motBody[i] = 0; motHip[i] = 0; motCover[i] = 0; motDip[i] = 0; }
    else {
      // Dropped mid-punch: ease the body and the cover home.
      motBody[i] = follow(motBody[i], 0, 18, dt * 7, dt);
      motHip[i] = follow(motHip[i], 0, 18, dt * 7, dt);
      motCover[i] = follow(motCover[i], 0, 18, dt * 7, dt);
      motDip[i] = follow(motDip[i], 0, 18, dt * 7, dt);
    }
    // Forget the punch only once the arm, the body and the cover are home, or
    // the body terms it drives would snap off.
    if (!mine && mem.armExt[i] < 0.002 && mem.bodyExt[i] < 0.002 && Math.max(motBody[i], motHip[i], motCover[i], motDip[i]) < 0.005) {
      mem.armExt[i] = 0; mem.bodyExt[i] = 0; mem.armVel[i] = 0; mem.bodyVel[i] = 0; mem.armPunch[i] = null;
      motBody[i] = 0; motHip[i] = 0; motCover[i] = 0; motDip[i] = 0;
    }
    // Shoulder-joint rotation: eases in from the moment the punch is committed
    // (telegraph or launch), holds through contact, eases out over the retraction.
    const ph = mine ? f.punchPhase : null;
    const tele = f.telegraphPhase !== "none" && f.telegraphPunchType && LEFT_PUNCHES.has(f.telegraphPunchType) === isLeft
      ? f.telegraphPunchType : null;
    let shTarget = 0;
    if (mine) { mem.shPunch[i] = enginePunch; shTarget = ph === "retraction" ? 1 - smooth(f.retractionProgress || 0) : 1; }
    else if (tele) { mem.shPunch[i] = tele; shTarget = 1; }
    mem.shW[i] = snapArm ? shTarget : follow(mem.shW[i], shTarget, 24, dt * 7, dt);
    if (shTarget === 0 && mem.shW[i] < 0.002) { mem.shW[i] = 0; mem.shPunch[i] = null; }
    // Outbound path vs straight home: once the punch has landed (linger/retraction)
    // or been dropped, the glove heads straight back to the guard.
    const homing = !mine || ph === "linger" || ph === "retraction";
    mem.arcK[i] = homing ? (snapArm ? 0 : follow(mem.arcK[i], 0, 25, dt * 8, dt)) : 1;
    // Telegraph pull-back eases out into the punch instead of vanishing.
    let pbTarget = 0;
    if (!mine && f.telegraphPhase !== "none" && f.telegraphPunchType && LEFT_PUNCHES.has(f.telegraphPunchType) === isLeft) {
      const dur = f.telegraphDuration;
      const tp = dur > 0 ? Math.min(1, f.telegraphTimer / dur) : 1;
      if (tp >= TELEGRAPH_PULLBACK_START) pbTarget = smooth((tp - TELEGRAPH_PULLBACK_START) / (1 - TELEGRAPH_PULLBACK_START));
    }
    mem.pullback[i] = snapAll ? pbTarget : follow(mem.pullback[i], pbTarget, 30, dt / 0.08, dt);
  }

  // Fatigue sway (signed, along the punch line = forward).
  const fSway = fatigueSwayOffsets(f);
  const swayM = BODY_H_PX * (1 - 0.4 * dp) * 0.22 * fatigueSwaySlipFraction() * resetSnapDistanceMult(f) * PX2M;
  const torsoBodyH = dims.chest.y - dims.hips.y + 0.35;

  // Slip lean in body space.
  let slipX = 0, slipZ = 0;
  if ((f.slipLean || 0) > 0.001) {
    const sd = SLIP_WORLD_DIR[f.slipLeanDir] ?? SLIP_WORLD_DIR.left;
    const l = toLocal(sd.x, sd.z, fa);
    slipX = l.x * 0.44 * f.slipLean;
    slipZ = l.z * 0.44 * f.slipLean;
    if (ctx.dropBackSlip && slipX < 0) slipX = 0;
  }

  // Hit snap: the 0.15s hitTimer window throws the head and chest back.
  const hitSnap = f.hitTimer > 0 ? Math.min(1, f.hitTimer / 0.15) : 0;
  const crit = f.critHitTimer > 0 ? Math.min(1, f.critHitTimer / 0.3) : 0;

  // ── opponent, in body space ──
  const opp = ctx.opponent;
  let oppL = { x: 1.5, z: 0 }, oppDist = 1.5, oppDuck = 0;
  if (opp) {
    oppL = toLocal(opp.x - f.x, opp.z - f.z, fa);
    oppL.x /= PX_PER_UNIT; oppL.z /= PX_PER_UNIT;
    oppDist = Math.max(0.2, Math.hypot(oppL.x, oppL.z));
    oppDuck = Math.max(0, Math.min(1, opp.duckProgress || 0));
  }

  // Body follow-through, summed per arm off the body's (slower) follow value, so
  // a punch handed from one hand to the other turns the hips through rather
  // than flipping them.
  // No punch steps or lunges the body in: closing distance is the fighter's own
  // footwork. A punch at the edge of its reach is covered by the arm alone.
  let punchYaw = 0, hipYaw = 0, bodyDip = 0, upperDip = 0, punchLean = 0, chinTuck = 0;
  // Per leg: how far a same-side hook is pivoting that knee/foot inward.
  const hookPivot = [0, 0];
  // Uppercut slip: the torso dips off the line to the punching side as the
  // uppercut loads, then slides back to centre as it fires and retracts.
  let upperSlipZ = 0;
  const animCfg = getActivePunchAnimConfig();
  for (let i = 0; i < 2; i++) {
    const p = mem.armPunch[i];
    if (!p) continue;
    // Phase-locked torso and hip turn (hips lead), lean, foot pivot, chin tuck.
    const left = i === 0;
    const rear = left === southpaw;
    const cls = PUNCH_BODY[punchClass(p, rear)];
    const leanK = Math.max(0, animCfg[p as keyof typeof animCfg]?.leanMult ?? 1);
    const sgn = left ? -1 : 1;
    punchYaw += sgn * cls.chest * motBody[i];
    hipYaw += sgn * cls.hip * motHip[i];
    // The pivoting foot turns on the ball as the hip turns through.
    if (cls.pivot > 0) hookPivot[i] = Math.max(hookPivot[i], cls.pivot * motHip[i]);
    if (mem.armBody[i]) bodyDip = Math.max(bodyDip, 0.09 * motBody[i]);
    upperDip = Math.max(upperDip, UPPER_DIP_M * motDip[i]);
    punchLean = Math.max(punchLean, (mem.armBody[i] ? 0.25 : cls.lean) * motBody[i] * leanK);
    chinTuck = Math.max(chinTuck, PUNCH_CHIN_TUCK * motBody[i]);
  }
  for (let i = 0; i < 2; i++) {
    const sp = mem.shPunch[i];
    if (!sp || !sp.includes("Uppercut")) continue;
    // Rides the shoulder-joint weight (eases in from the telegraph/launch): held
    // through the throw, slides back as the glove homes and retracts.
    const slipK = mem.shW[i] * (0.35 + 0.65 * mem.arcK[i]);
    upperSlipZ += (i === 0 ? -1 : 1) * UPPER_SLIP * slipK;
  }

  slipZ += upperSlipZ;
  // ── pelvis ──
  // A real boxing stance: bladed about 35-40° off the opponent, standing tall
  // on soft knees.
  const blade = THREE.MathUtils.lerp(-0.62, 0.62, sb);
  out.pelvisOffset.set(
    swayFwdPx * PX2M + fSway.torso * swayM * 0.25 - hitSnap * 0.03,
    -bobPx * PX2M - dims.legLen * (DUCK_HIP_DROP * dp + getStandHeightConfig().standSit) - bodyDip - upperDip
      + (ctx.hipHeight ?? 0),
    0,
  );
  out.pelvisRot.copy(tiltQ(0.03 + slipX * 0.35, slipZ * 0.35)).multiply(yawQ(blade * 0.75 + hipYaw, _q));

  // ── chest ──
  const fwdLean = 0.14 + (fSway.torso * swayM) / torsoBodyH
    + punchLean - hitSnap * 0.12 - crit * 0.05;
  out.chestRot.copy(tiltQ(fwdLean + slipX, slipZ)).multiply(yawQ(blade + punchYaw, _q));

  // ── head: level the gaze, dip on a Reset, push on a charge, snap on a hit ──
  const dipM = resetHeadDuckOffset(f) * PX2M;
  const chargeM = (f.chargeHeadOffset || 0) * BODY_H_PX * PX2M;
  // Chin tucked a touch below level, eyes up at the opponent.
  const headPitch = -fwdLean * 0.7 + 0.08 + chinTuck + dipM / 0.12 + chargeM / 0.25 - hitSnap * 0.45 - crit * 0.2;
  const headSlip = (f.slipLean || 0) > 0 ? 0.35 : 0;
  // Duck-tracked punch from standing: tip the head down to look at the
  // opponent's ducked head (its drop over the distance between them) -- only
  // once the opponent is physically down in the duck. Tracking alone, a duck
  // that has only just started, or an upright opponent leaves the eyes level.
  const duckDown = smooth((oppDuck - DUCK_LOOK_MIN) / (1 - DUCK_LOOK_MIN));
  const lookTarget = f.duckTrackLowLine && f.defenseState !== "duck" && duckDown > 0
    ? Math.atan2(DUCK_HEAD_DROP_M * oppDuck, oppDist) * duckDown : 0;
  mem.duckLook = snapAll ? lookTarget : follow(mem.duckLook ?? 0, lookTarget, 18, dt * 6, dt);
  // Head snap (crit/stun to the head): straights and hooks whip the head round
  // away from the punching hand, uppercuts tip it up; either way it eases back.
  let stunYaw = 0, snapPitch = 0;
  const sht = f.stunHeadTurnTimer ?? 0;
  const snapping = sht > 0 && !!f.stunHeadTurnDir;
  if (snapping) {
    const dur = f.headSnapDuration ?? STUN_HEAD_TURN_DURATION;
    const el = dur - sht;
    const k = el < STUN_HEAD_TURN_IN ? smooth(el / STUN_HEAD_TURN_IN) : 1 - smooth((el - STUN_HEAD_TURN_IN) / (dur - STUN_HEAD_TURN_IN));
    if (f.headSnapUp) snapPitch = -HEAD_SNAP_ANGLE * k;
    else stunYaw = f.stunHeadTurnDir * HEAD_TURN_ANGLE * k;
  }
  // A landed hook turns the head with it (left hook → left) and back. The snap wins while both run.
  let hookYaw = 0;
  const hht = f.hookHeadTurnTimer ?? 0;
  if (hht > 0 && f.hookHeadTurnDir) {
    const el = HOOK_HEAD_TURN_DURATION - hht;
    const k = el < HOOK_TURN_IN ? smooth(el / HOOK_TURN_IN) : 1 - smooth((el - HOOK_TURN_IN) / (HOOK_HEAD_TURN_DURATION - HOOK_TURN_IN));
    hookYaw = f.hookHeadTurnDir * HOOK_TURN_ANGLE * k;
  }
  // Yaw at the opponent is the model's job (it aims the nose line); hit turns ride on top of that.
  out.headTurnYaw = snapping && !f.headSnapUp ? stunYaw : hookYaw;
  out.headRot.copy(tiltQ(headPitch + snapPitch + mem.duckLook + slipX * headSlip, slipZ * headSlip));

  // ── legs ──
  // A duck is just the hips sat lower into bent knees with the feet a bit wider.
  const legSpread = DUCK_FEET_WIDER * dp, legLong = DUCK_FEET_LONGER * dp;
  // Feet about shoulder width apart side to side, a long pace front to back.
  // Shared with the engine's leg collision, so the legs it keeps apart are these.
  const SF = STANCE_FEET_M;
  const ortho = { lead: new THREE.Vector3(SF.lead.x + legLong, 0, SF.lead.z - legSpread), rear: new THREE.Vector3(SF.rear.x - legLong, 0, SF.rear.z + legSpread) };
  // Orthodox: left leads. Southpaw mirrors across z.
  const leftOrtho = ortho.lead, rightOrtho = ortho.rear;
  const leftSouth = new THREE.Vector3(ortho.rear.x, 0, -ortho.rear.z);
  const rightSouth = new THREE.Vector3(ortho.lead.x, 0, -ortho.lead.z);
  const switchLift = Math.sin(Math.PI * sb) * 0.09;
  const bld = f.backLegDrive || 0, fld = f.frontLegDrive || 0;
  // The foot nearest the way you're going steps first (forward: lead foot, back: rear,
  // left: left, right: right); latched per cycle so a turn mid-step doesn't swap feet.
  const wdx = mem.walkDirX ?? 0, wdz = mem.walkDirZ ?? 0;
  if (stepping && mem.walkDirX !== undefined && (mem.walkIdle || mem.walkPlanted !== false || Math.floor(walkT) !== prevCycle)) {
    const lx = leftOrtho.x + (leftSouth.x - leftOrtho.x) * sb, lz = leftOrtho.z + (leftSouth.z - leftOrtho.z) * sb;
    const rx = rightOrtho.x + (rightSouth.x - rightOrtho.x) * sb, rz = rightOrtho.z + (rightSouth.z - rightOrtho.z) * sb;
    mem.walkFirst = lx * wdx + lz * wdz >= rx * wdx + rz * wdz ? 0 : 1;
    mem.walkIdle = false;
    mem.walkPlanted = false;
  }
  if (!stepping) mem.walkPlanted = true;
  const wt = walkT - Math.floor(walkT), wD = walkD;
  for (let i = 0; i < 2; i++) {
    const isLeft = i === 0;
    const a = out.ankle[i].copy(isLeft ? leftOrtho : rightOrtho).lerp(isLeft ? leftSouth : rightSouth, sb);
    const leadness = isLeft ? 1 - sb : sb; // 1 = this foot leads
    a.x += (1 - leadness) * 0.12 * bld - leadness * 0.1 * fld;
    // This foot's half of the cycle: it travels wD while the other stays planted
    // (planted feet slide back relative to the body, which moves steadily).
    const u = (mem.walkFirst ?? 0) === i ? Math.min(1, wt * 2) : Math.max(0, wt * 2 - 1);
    const step = wD * (smooth(u) - wt);
    a.x += wdx * step;
    a.z += wdz * step;
    // The stepping foot clears the canvas; full height from a 0.3m stride up.
    const lift = u > 0 && u < 1 ? Math.sin(Math.PI * u) * 0.1 * Math.min(1, wD / LIFT_FULL_STRIDE) : 0;
    a.y = dims.ankleY + lift + switchLift * (isLeft ? 1 : 0.6);
    // Lead toe points at the opponent (turned in a hair), rear foot ~45° out.
    const toeLead = new THREE.Vector3(1, 0, isLeft ? 0.2 : -0.2);
    const toeRear = new THREE.Vector3(0.75, 0, isLeft ? -0.66 : 0.66);
    out.toeDir[i].copy(toeRear).lerp(toeLead, leadness);
    // Knees track over the toes. A same-side hook pivots the knee and foot
    // inward (toward the body's centreline) with the hip turn.
    const inward = (isLeft ? 1 : -1) * hookPivot[i];
    out.toeDir[i].z += inward * 0.35;
    out.toeDir[i].normalize();
    out.kneePole[i].set(1, 0, (isLeft ? 0.1 : -0.1) * leadness + (isLeft ? -0.6 : 0.6) * (1 - leadness) + inward * 0.7).normalize();
  }

  // ── arms ──
  const chestPos = _chest.copy(dims.chest).sub(dims.hips).applyQuaternion(out.chestRot).add(dims.hips).add(out.pelvisOffset);

  for (let i = 0; i < 2; i++) {
    const isLeft = i === 0;
    const side = isLeft ? -1 : 1;
    const isLead = isLeft === (f.boxingStance !== "southpaw");
    const sh = _sh.copy(dims.shoulder[i]).sub(dims.chest).applyQuaternion(out.chestRot).add(chestPos);
    const g = out.glove[i];

    // Guard: blend down ↔ up exactly like drawArms' gb.
    const gb = f.guardBlend || 0;
    const pbOffM = (f.perfectBlockState ?? "idle") !== "idle" ? -(f.perfectBlockGloveYOffset ?? 0) * PX2M : 0;
    // Ordinary guard: held low, lead glove out in front around shoulder height,
    // rear glove low by the jaw line, elbows in. Full guard pulls both up to the brow,
    // tight together in front of the face.
    const down = _a.set(isLead ? 0.4 : 0.22, isLead ? -0.01 : 0.0, -side * (isLead ? 0.13 : 0.14));
    const up = _b.set(isLead ? 0.27 : 0.23, 0.2 + pbOffM, -side * 0.15);
    const guardLocal = down.lerp(up, gb);
    // Guard is held relative to the chest (follows lean and blade). A duck
    // leaves the arms exactly as they are; the whole guard just rides down.
    const guardRot = out.chestRot;
    const guard = _c.copy(guardLocal).applyQuaternion(guardRot).add(sh);
    g.copy(guard);
    // Elbows tucked down over the ribs, not flared.
    out.elbowPole[i].set(-0.25, -1, side * 0.12).applyQuaternion(guardRot).normalize();
    out.maxStretch[i] = 1.04;

    const punchDir = _d.set(oppL.x, 0, oppL.z).normalize();
    const punch = mem.armPunch[i];
    const ext = mem.armExt[i];
    if (punch && ext > 0) {
      const isHook = punch.includes("Hook");
      const isUpper = punch.includes("Uppercut");
      const reach = getPunchReachPx(f, punch) / PX_PER_UNIT;
      const aimHead = !mem.armBody[i];
      const headY = dims.headY - DUCK_HEAD_DROP_M * oppDuck - 0.05;
      const bodyY = dims.chest.y - 0.18 - DUCK_HEAD_DROP_M * oppDuck;
      const surface = aimHead ? 0.14 : 0.2;
      const along = Math.max(0.25, Math.min(oppDist, reach) - surface);
      // Distance is measured from this fighter's origin; the reach lunge moved the
      // shoulders, not the target.
      const target = _e.set(punchDir.x * along, aimHead ? headY : bodyY, punchDir.z * along);
      const arcK = mem.arcK[i];
      if (isHook) {
        // Snapped short by the hips and shoulders (refs: Mayweather's left
        // hook). Launch chambers the glove a hand out to the side, elbow
        // rising level with the fist; Extend swings it round the body's turn
        // axis onto the target, arriving from the side. Homes straight back.
        const chamber = _b.copy(guard).addScaledVector(_f.set(-punchDir.z, 0, punchDir.x), side * HOOK_CHAMBER_OUT);
        chamber.y += HOOK_CHAMBER_UP;
        const arcPath = _uc;
        if (ext <= HOOK_LAUNCH_E) arcPath.lerpVectors(guard, chamber, smooth(ext / HOOK_LAUNCH_E));
        else {
          const s = smooth((ext - HOOK_LAUNCH_E) / (1 - HOOK_LAUNCH_E));
          // Horizontal arc about the spine, radius growing to the target's.
          const px = chestPos.x, pz = chestPos.z;
          const cx = chamber.x - px, cz = chamber.z - pz, tx = target.x - px, tz = target.z - pz;
          const rc = Math.hypot(cx, cz), rt = Math.hypot(tx, tz);
          const angC = Math.atan2(cz, cx), angT = Math.atan2(tz, tx);
          let da = angC - angT;
          da = Math.atan2(Math.sin(da), Math.cos(da));
          const ang = angT + da * (1 - s), r = rc + (rt - rc) * s;
          arcPath.set(px + Math.cos(ang) * r, chamber.y + (target.y - chamber.y) * s, pz + Math.sin(ang) * r);
        }
        g.lerpVectors(guard, target, ext).lerp(arcPath, arcK);
        // Elbow: from the tucked guard pole out to the side, a touch up, as the
        // glove chambers, so the elbow rides level with the fist.
        const open = smooth(Math.min(1, ext / (HOOK_LAUNCH_E * 1.5))) * arcK;
        _f.set(0, 0.25, side).applyQuaternion(out.chestRot).normalize();
        out.elbowPole[i].lerp(_f, open).normalize();
      } else if (isUpper) {
        // A real uppercut: the glove drops to belt level and a touch back to
        // load, sweeps forward along the bottom of a U, then drives UP into the
        // target with the elbow tucked under the fist. The path ends where the
        // U-lift shoulder tilt below carries it exactly onto the target.
        const liftEnd = (animCfg[punch as keyof typeof animCfg]?.uLiftDeg ?? 15) * THREE.MathUtils.DEG2RAD;
        const end = _f.copy(target).sub(sh).applyQuaternion(_q.setFromAxisAngle(_zAxis, -liftEnd)).add(sh);
        // Loads in front of the stomach, tight to the body, not out by the hip.
        const load = _b.copy(guard).addScaledVector(punchDir, -0.06);
        load.x = chestPos.x + (load.x - chestPos.x) * 0.7;
        load.z = chestPos.z + (load.z - chestPos.z) * 0.6;
        load.y = sh.y - UPPER_LOAD_DROP;
        const dipPeak = 0.3;
        const u = _uc.copy(guard); // (_c holds the guard itself)
        if (ext < dipPeak) u.lerp(load, smooth(ext / dipPeak));
        else {
          const s = (ext - dipPeak) / (1 - dipPeak);
          // Forward travel finishes early, the climb comes late: the U's far wall.
          const fwd = smooth(Math.min(1, s / 0.6));
          u.x = load.x + (end.x - load.x) * fwd;
          u.z = load.z + (end.z - load.z) * fwd;
          u.y = load.y + (end.y - load.y) * smooth(s) * s;
        }
        // Homing: straight back from wherever the U left the glove.
        const straight = _a.lerpVectors(guard, target, ext);
        g.copy(straight).lerp(u, arcK);
        // Elbow down under the fist, tucked to the ribs.
        out.elbowPole[i].set(0.2, -1, side * 0.2).applyQuaternion(yawQ(blade + punchYaw, _q)).normalize();
      } else {
        // Straight down the line. The elbow stays under the fist out of the
        // guard, then rolls out as the fist turns palm-down into lockout.
        g.lerpVectors(guard, target, ext);
        const turn = smooth((ext - 0.45) / 0.55);
        out.elbowPole[i].lerp(_f.set(0, -0.3, side), turn).normalize();
      }
      // Never truncate a valid reach. The IK only stretches as far as the target is,
      // so the margin covers the gap between the estimated and real shoulder.
      out.maxStretch[i] = Math.max(1.45, sh.distanceTo(g) / Math.max(0.1, dims.armLen) + 0.25);
    }
    // Shoulder joint (Punch Animation Editor, body axes, degrees) plus the
    // uppercut's U-lift, rotating the whole arm about the shoulder.
    const shPunch = mem.shPunch[i];
    const shCfg = shPunch ? animCfg[shPunch as keyof typeof animCfg] : undefined;
    const sw = mem.shW[i];
    let rx = 0, ry = 0, rz = 0;
    if (shCfg && sw > 0) { rx = (shCfg.shoulderX ?? 0) * sw; ry = (shCfg.shoulderY ?? 0) * sw; rz = (shCfg.shoulderZ ?? 0) * sw; }
    if (punch && punch.includes("Uppercut") && ext > 0) {
      const lift = animCfg[punch as keyof typeof animCfg]?.uLiftDeg ?? 15;
      rz += lift * smooth((ext - 0.55) / 0.45) * mem.arcK[i];
    }
    if (rx !== 0 || ry !== 0 || rz !== 0) {
      const D = THREE.MathUtils.DEG2RAD;
      _q.setFromEuler(_eul.set(rx * D, ry * D, rz * D, "YXZ"));
      g.sub(sh).applyQuaternion(_q).add(sh);
      out.elbowPole[i].applyQuaternion(_q);
    }
    // The other hand's punch: this glove covers the cheek on its own side,
    // held off the head (which doesn't turn with the torso), elbow tucked.
    const cover = mem.armPunch[1 - i] && !(punch && ext > 0) ? motCover[1 - i] : 0;
    if (cover > 0) {
      const headC = _hc.copy(UP).multiplyScalar(dims.headY - dims.chest.y).applyQuaternion(tiltQ(fwdLean + slipX, slipZ, _q)).add(chestPos);
      const cheek = _f.set(COVER_FWD, -COVER_DROP, side * COVER_SIDE).add(headC);
      g.lerp(cheek, smooth(cover));
      out.elbowPole[i].lerp(_hc.set(-0.2, -1, side * 0.35), smooth(cover)).normalize();
    }
    if (mem.pullback[i] > 0) g.addScaledVector(punchDir, -mem.pullback[i] * TELEGRAPH_PULLBACK_M);

    // Flinch, then the fatigue lag on top (same order as 2D).
    const fl = flinchArmOffsets(f, isLeft);
    if (fl.forward !== 0 || fl.vertical !== 0) {
      g.addScaledVector(punchDir, fl.forward * PX2M);
      g.y -= fl.vertical * PX2M;
    }
    const lag = ((isLead ? fSway.armLead : fSway.armRear) - fSway.torso) * swayM + fatigueArmSnapHold(f, isLeft) * swayM;
    if (lag !== 0) g.addScaledVector(punchDir, lag);
  }
  return out;
}

const _chest = new THREE.Vector3(), _sh = new THREE.Vector3();
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3();
const _d = new THREE.Vector3(), _e = new THREE.Vector3(), _f = new THREE.Vector3();
const _eul = new THREE.Euler();
const _uc = new THREE.Vector3();
const _hc = new THREE.Vector3();
/** Covering glove, from the head centre: forward, down to the cheekbone, out to its own side (m). */
const COVER_FWD = 0.2, COVER_DROP = 0.06, COVER_SIDE = 0.09;
const _zAxis = new THREE.Vector3(0, 0, 1);

export function newPoseTargets(): PoseTargets {
  const v = () => new THREE.Vector3();
  return {
    pelvisOffset: v(), pelvisRot: new THREE.Quaternion(), chestRot: new THREE.Quaternion(), headRot: new THREE.Quaternion(), headTurnYaw: 0,
    glove: [v(), v()], elbowPole: [v(), v()], maxStretch: [1, 1],
    ankle: [v(), v()], kneePole: [v(), v()], toeDir: [v(), v()],
  };
}

/** Eye state, same rules as the 2D face. */
export function eyeState(f: FighterState): "open" | "closed" | "squint" {
  const telegraphing = f.telegraphPhase !== "none";
  const chance = telegraphing ? levelScale(Math.max(1, f.level), 0.75, 0.5, "telegraphBlinkChance") : 0;
  const quiet = (f.blinkQuietTimer ?? 0) > 0;
  if (f.cleanHitEyeTimer > 0 || f.isBlinking
    || (telegraphing && !quiet && (((f.level * 7 + Math.floor(f.telegraphTimer * 100)) % 100) / 100 < chance))) return "closed";
  if (f.isPunching && f.currentPunch && f.currentPunch !== "jab") return "squint";
  return "open";
}
