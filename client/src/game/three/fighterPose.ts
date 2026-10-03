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
} from "../engine";
import { levelScale } from "@/lib/scalingConfig";
import { PX_PER_UNIT } from "./worldMapping";

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
  glove: [THREE.Vector3, THREE.Vector3];
  elbowPole: [THREE.Vector3, THREE.Vector3];
  maxStretch: [number, number];
  ankle: [THREE.Vector3, THREE.Vector3];
  kneePole: [THREE.Vector3, THREE.Vector3];
  toeDir: [THREE.Vector3, THREE.Vector3];
}

export interface PoseMemory {
  stanceBlend: number;  // 0 orthodox → 1 southpaw
  walkPhase: number;
  walkAmt: number;
  lastX: number;
  lastZ: number;
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
}

export function newPoseMemory(): PoseMemory {
  return {
    stanceBlend: 0, walkPhase: 0, walkAmt: 0, lastX: 0, lastZ: 0, init: false,
    armExt: [0, 0], armPunch: [null, null], armBody: [false, false], bodyExt: [0, 0], pullback: [0, 0],
    armVel: [0, 0], bodyVel: [0, 0],
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
}

const UP = new THREE.Vector3(0, 1, 0);
const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();

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

/** Punch extension 0..1 from the engine's phase + progress. */
export function punchExtension(f: FighterState): number {
  if (!f.isPunching || !f.currentPunch) return 0;
  const fr = punchPhaseFractions(f);
  const p = f.punchProgress || 0;
  const phase = f.punchPhase;
  let e: number;
  if (!fr || !phase) e = Math.sin(Math.min(1, p) * Math.PI);
  else if (phase === "launchDelay") e = 0;
  else if (phase === "armSpeed") {
    const [a, b] = fr.armSpeed;
    const t = b > a ? (p - a) / (b - a) : 1;
    // Ease in AND out: an ease-out starts at full speed, which reads as the
    // glove popping out of the guard.
    e = smooth(t);
  } else if (phase === "contact" || phase === "linger") e = 1;
  else e = 1 - smooth(f.retractionProgress || 0);
  // A feint is a short sold punch: it stops well short and comes back.
  return f.isFeinting ? e * 0.42 : e;
}

/**
 * Head or body, decided exactly like tryHit: the punch config's hitsHead, with
 * the aim flag consulted only while the attacker is ducking.
 */
export function punchHitsHead(f: FighterState, punch: PunchType): boolean {
  const hitsHead = PUNCH_CONFIGS[punch]?.hitsHead ?? true;
  return f.defenseState === "duck" ? (f.punchAimsHead && hitsHead) : hitsHead;
}

/** Lunge cap (m): past this, the arm stretches instead so contact always lands. */
const MAX_REACH_LUNGE = 0.45;

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
  const walkTarget = Math.min(1, speed / 1.2);
  mem.walkAmt += (walkTarget - mem.walkAmt) * Math.min(1, dt * 10);
  mem.walkPhase += (moved / 0.34) * Math.PI;

  // ── body-level readings ──
  const dp = Math.max(0, Math.min(1, f.duckProgress || 0)); // the delayed crouch, never the input
  const bobPx = f.rhythmLevel > 0 ? Math.abs((f.swayOffset || 0) / 5) * 3 * 1.6 : Math.sin(f.bobPhase || 0) * 1.5 * 1.6;
  const swayFwdPx = (f.swayOffset || 0) * 0.5;

  // ── punch follow-through (render-side) ──
  const rawExt = punchExtension(f);
  const enginePunch = f.isPunching ? f.currentPunch : null;
  const firstFrame = !mem.armExt; // memory from before these fields existed
  if (firstFrame || !mem.armVel) Object.assign(mem, { armExt: [0, 0], armPunch: [null, null], armBody: [false, false], bodyExt: [0, 0], pullback: [0, 0], armVel: [0, 0], bodyVel: [0, 0] });
  for (let i = 0; i < 2; i++) {
    const isLeft = i === 0;
    const mine = !!enginePunch && LEFT_PUNCHES.has(enginePunch) === isLeft;
    if (mine) {
      // A different punch on the same arm restarts from where the glove is now.
      mem.armPunch[i] = enginePunch;
      mem.armBody[i] = !punchHitsHead(f, enginePunch!);
    }
    const target = mine ? rawExt : 0;
    if (snapAll) { mem.armExt[i] = target; mem.armVel[i] = 0; mem.bodyExt[i] = target; mem.bodyVel[i] = 0; }
    else {
      const w = target >= mem.armExt[i] ? ARM_OMEGA : ARM_BACK_OMEGA;
      [mem.armExt[i], mem.armVel[i]] = spring(mem.armExt[i], mem.armVel[i], target, w, dt);
      mem.armExt[i] = Math.max(0, Math.min(1, mem.armExt[i]));
      [mem.bodyExt[i], mem.bodyVel[i]] = spring(mem.bodyExt[i], mem.bodyVel[i], mem.armExt[i], BODY_OMEGA, dt);
      mem.bodyExt[i] = Math.max(0, Math.min(1, mem.bodyExt[i]));
    }
    // Forget the punch only once both the arm and the body are home, or the
    // body terms it drives would snap off.
    if (!mine && mem.armExt[i] < 0.002 && mem.bodyExt[i] < 0.002) {
      mem.armExt[i] = 0; mem.bodyExt[i] = 0; mem.armVel[i] = 0; mem.bodyVel[i] = 0; mem.armPunch[i] = null;
    }
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
    slipX = l.x * 0.22 * f.slipLean;
    slipZ = l.z * 0.22 * f.slipLean;
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
  const oppDirX = oppL.x / oppDist, oppDirZ = oppL.z / oppDist;

  // Body follow-through, summed per arm off the body's (slower) follow value, so
  // a punch handed from one hand to the other turns the hips through rather
  // than flipping them.
  // Real-reach lunge: a punch that can land at this distance must visibly get
  // there. Step the body in by whatever the straight arm can't cover (capped);
  // the arm IK stretches for the rest.
  let reachLunge = 0, punchYaw = 0, lunge = 0, bodyDip = 0, upperDip = 0, punchLean = 0;
  for (let i = 0; i < 2; i++) {
    const p = mem.armPunch[i];
    const be = mem.bodyExt[i];
    if (!p || be <= 0) continue;
    const left = i === 0;
    const hook = p.includes("Hook"), upper = p.includes("Uppercut");
    const rear = left === southpaw;
    const bShot = mem.armBody[i];
    const reach = getPunchReachPx(f, p) / PX_PER_UNIT;
    const along = Math.max(0.25, Math.min(oppDist, reach) - (bShot ? 0.2 : 0.14));
    const deficit = along - (Math.max(0, dims.shoulder[i].x) + dims.armLen * 1.05);
    reachLunge = Math.max(reachLunge, Math.min(MAX_REACH_LUNGE, Math.max(0, deficit)) * be);
    punchYaw += (left ? -1 : 1) * (hook ? 0.75 : upper ? 0.4 : rear ? 0.6 : 0.18) * be;
    if (!upper) lunge = Math.max(lunge, (hook ? 0.05 : rear ? 0.12 : 0.09) * be);
    if (bShot) bodyDip = Math.max(bodyDip, 0.09 * be);
    if (upper) upperDip = Math.max(upperDip, 0.05 * Math.sin(Math.PI * be));
    punchLean = Math.max(punchLean, (bShot ? 0.25 : 0.1) * be);
  }

  // ── pelvis ──
  // A real boxing stance: bladed about 35-40° off the opponent, hips sat down
  // into bent knees.
  const blade = THREE.MathUtils.lerp(-0.62, 0.62, sb);
  out.pelvisOffset.set(
    swayFwdPx * PX2M + lunge + fSway.torso * swayM * 0.25 - hitSnap * 0.03 + reachLunge * oppDirX,
    -bobPx * PX2M - dims.legLen * 0.2 * dp - bodyDip - upperDip - dims.legLen * 0.09,
    reachLunge * oppDirZ,
  );
  out.pelvisRot.copy(tiltQ(0.03 + slipX * 0.35, slipZ * 0.35)).multiply(yawQ(blade * 0.75 + punchYaw * 0.45, _q));

  // ── chest ──
  const fwdLean = 0.14 + 0.42 * dp + (fSway.torso * swayM) / torsoBodyH
    + punchLean - hitSnap * 0.12 - crit * 0.05;
  out.chestRot.copy(tiltQ(fwdLean + slipX, slipZ)).multiply(yawQ(blade + punchYaw, _q));

  // ── head: level the gaze, dip on a Reset, push on a charge, snap on a hit ──
  const dipM = resetHeadDuckOffset(f) * PX2M;
  const chargeM = (f.chargeHeadOffset || 0) * BODY_H_PX * PX2M;
  // Chin tucked a touch below level, eyes up at the opponent.
  const headPitch = -fwdLean * 0.7 + 0.08 + dipM / 0.12 + chargeM / 0.25 - hitSnap * 0.45 - crit * 0.2;
  const headSlip = (f.slipLean || 0) > 0 ? 0.35 : 0;
  out.headRot.copy(tiltQ(headPitch + slipX * headSlip, slipZ * headSlip)).multiply(yawQ(blade * 0.2, _q));

  // ── legs ──
  const legSpread = 0.05 * dp;
  // Feet about shoulder width apart side to side, a long pace front to back.
  const ortho = { lead: new THREE.Vector3(0.26, 0, -0.16 - legSpread), rear: new THREE.Vector3(-0.28, 0, 0.2 + legSpread) };
  // Orthodox: left leads. Southpaw mirrors across z.
  const leftOrtho = ortho.lead, rightOrtho = ortho.rear;
  const leftSouth = new THREE.Vector3(ortho.rear.x, 0, -ortho.rear.z);
  const rightSouth = new THREE.Vector3(ortho.lead.x, 0, -ortho.lead.z);
  const switchLift = Math.sin(Math.PI * sb) * 0.09;
  const bld = f.backLegDrive || 0, fld = f.frontLegDrive || 0;
  for (let i = 0; i < 2; i++) {
    const isLeft = i === 0;
    const a = out.ankle[i].copy(isLeft ? leftOrtho : rightOrtho).lerp(isLeft ? leftSouth : rightSouth, sb);
    const leadness = isLeft ? 1 - sb : sb; // 1 = this foot leads
    a.x += (1 - leadness) * 0.12 * bld - leadness * 0.1 * fld;
    // The lead foot steps in with a reach lunge; the rear foot stays planted.
    a.x += leadness * reachLunge * oppDirX * 0.8;
    a.z += leadness * reachLunge * oppDirZ * 0.8;
    // Walk cycle: alternate steps along the move direction with a small lift.
    const ph = mem.walkPhase + (isLeft ? 0 : Math.PI);
    const step = Math.sin(ph) * 0.09 * mem.walkAmt;
    a.x += (moveLocal.x / ml) * step;
    a.z += (moveLocal.z / ml) * step;
    a.y = dims.ankleY + Math.max(0, Math.cos(ph)) * 0.05 * mem.walkAmt + switchLift * (isLeft ? 1 : 0.6);
    // Lead toe points at the opponent (turned in a hair), rear foot ~45° out.
    const toeLead = new THREE.Vector3(1, 0, isLeft ? 0.2 : -0.2);
    const toeRear = new THREE.Vector3(0.75, 0, isLeft ? -0.66 : 0.66);
    out.toeDir[i].copy(toeRear).lerp(toeLead, leadness).normalize();
    // Knees track over the toes.
    out.kneePole[i].set(1, 0, (isLeft ? 0.1 : -0.1) * leadness + (isLeft ? -0.6 : 0.6) * (1 - leadness)).normalize();
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
    const ducking = f.defenseState === "duck";
    const gb = ducking && f.preDuckBlockState === null ? 1 : (f.guardBlend || 0);
    const pbOffM = (f.perfectBlockState ?? "idle") !== "idle" ? -(f.perfectBlockGloveYOffset ?? 0) * PX2M : 0;
    // Ordinary guard: lead glove out in front at chin/eye height, rear glove
    // tucked by the chin, elbows in. Full guard pulls both up to the brow,
    // tight together in front of the face.
    const down = _a.set(isLead ? 0.4 : 0.22, isLead ? 0.11 : 0.1, -side * (isLead ? 0.13 : 0.14));
    const up = _b.set(isLead ? 0.27 : 0.23, 0.2 + pbOffM, -side * 0.15);
    const guardLocal = down.lerp(up, gb);
    // Guard is held relative to the chest (follows lean and blade), yaw only partly.
    const guard = _c.copy(guardLocal).applyQuaternion(out.chestRot).add(sh);
    g.copy(guard);
    // Elbows tucked down over the ribs, not flared.
    out.elbowPole[i].set(-0.25, -1, side * 0.12).applyQuaternion(out.chestRot).normalize();
    out.maxStretch[i] = 1.04;

    const punchDir = _d.set(oppL.x, 0, oppL.z).normalize();
    const punch = mem.armPunch[i];
    const ext = mem.armExt[i];
    if (punch && ext > 0) {
      const isHook = punch.includes("Hook");
      const isUpper = punch.includes("Uppercut");
      const reach = getPunchReachPx(f, punch) / PX_PER_UNIT;
      const aimHead = !mem.armBody[i];
      const headY = dims.headY * (1 - 0.2 * oppDuck) - 0.05;
      const bodyY = dims.chest.y - 0.18 - 0.2 * oppDuck;
      const surface = aimHead ? 0.14 : 0.2;
      const along = Math.max(0.25, Math.min(oppDist, reach) - surface);
      // Distance is measured from this fighter's origin; the reach lunge moved the
      // shoulders, not the target.
      const target = _e.set(punchDir.x * along, aimHead ? headY : bodyY, punchDir.z * along);
      if (isHook) {
        // Wide arc in from the outside, elbow up level with the fist.
        const arc = Math.sin(Math.PI * ext);
        g.lerpVectors(guard, target, ext);
        const outward = _f.set(-punchDir.z, 0, punchDir.x).multiplyScalar(side * 0.32 * arc);
        g.add(outward);
        g.y += 0.05 * arc;
        out.elbowPole[i].set(0, 0.6, side).normalize();
      } else if (isUpper) {
        // Dip to load, then drive up (to the body: the engine scores uppercuts as body shots).
        const dipPeak = 0.32;
        let yOff: number;
        if (ext < dipPeak) yOff = -0.16 * Math.sin((ext / dipPeak) * Math.PI * 0.5);
        else yOff = -0.16 * (1 - smooth((ext - dipPeak) / (1 - dipPeak)));
        g.lerpVectors(guard, target, smooth(ext));
        g.y += yOff;
        out.elbowPole[i].set(0.2, -1, side * 0.3).normalize();
      } else {
        g.lerpVectors(guard, target, ext);
        out.elbowPole[i].set(-0.3, -1, side * 0.5).normalize();
      }
      // Never truncate a valid reach. The IK only stretches as far as the target is,
      // so the margin covers the gap between the estimated and real shoulder.
      out.maxStretch[i] = Math.max(1.45, sh.distanceTo(g) / Math.max(0.1, dims.armLen) + 0.25);
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

export function newPoseTargets(): PoseTargets {
  const v = () => new THREE.Vector3();
  return {
    pelvisOffset: v(), pelvisRot: new THREE.Quaternion(), chestRot: new THREE.Quaternion(), headRot: new THREE.Quaternion(),
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
