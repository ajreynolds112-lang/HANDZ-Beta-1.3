/**
 * Knockdown staging for the 3D boxer: the fall, the time on the canvas, a KO,
 * and the get-up, layered over the standing pose from solvePose.
 *
 * Timing is the engine's: the fall follows state.kdFallTimer (0 → KD_FALL_DURATION)
 * while a knockdown is live, and the kind of fall comes from the existing flags
 * (kdIsBodyShot, kdTakeKnee). Two things are render-side only, because the engine
 * has no state for them: a short settle after a body-shot drop (knees, then onto
 * the side) and the get-up, which plays after isKnockedDown clears. Both run on
 * this module's own clock and never touch the fight.
 *
 * A KO needs no special case: the counted-out fighter keeps isKnockedDown, so it
 * stays down. Once the bout ends or a stoppage starts, the engine's fall timer
 * may be frozen (an immediate TKO leaves it at 0), so the fall finishes on the
 * render clock instead.
 *
 * Poses are built in the rig's body space (x forward, y up, z right) before a
 * whole-body tilt: Rz(+90°) lays the fighter on its back with the head away from
 * the way it faced; Rx(+90°) rolls a kneeling, curled fighter onto its right side.
 */
import * as THREE from "three";
import { KD_FALL_DURATION, type FighterState, type GameState } from "../types";
import type { PoseTargets, RigDims } from "./fighterPose";
import { newPoseTargets } from "./fighterPose";

type KdKind = "head" | "body" | "knee";

export interface KdMemory {
  down: boolean;
  kind: KdKind;
  /** Own clock since the knockdown began (s). */
  downT: number;
  /** Own clock since the fall landed (s); drives the body-shot roll and the stir. */
  settleT: number;
  /** Get-up clock (s), -1 when not getting up. */
  upT: number;
  /** Tilt fraction and limb weight at the moment the fighter got up. */
  lastTilt: number;
  epoch: number;
  // scratch poses
  a: PoseTargets;
  b: PoseTargets;
}

export function newKdMemory(): KdMemory {
  return { down: false, kind: "head", downT: 0, settleT: 0, upT: -1, lastTilt: 0, epoch: -1, a: newPoseTargets(), b: newPoseTargets() };
}

/** Whole-body transform for rig.body (identity when standing). */
export interface BodyTilt {
  q: THREE.Quaternion;
  pos: THREE.Vector3;
}

const GETUP_DURATION = 0.9;
const GETUP_KNEE_DURATION = 0.45;
const BODY_ROLL_DURATION = 0.55;

const Z = new THREE.Vector3(0, 0, 1);
const X = new THREE.Vector3(1, 0, 0);
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();

function clamp01(t: number): number { return Math.max(0, Math.min(1, t)); }
function smooth(t: number): number { const c = clamp01(t); return c * c * (3 - 2 * c); }
/** Lean the torso forward (+) or back (−) by `a` radians, in body space. */
function pitchQ(a: number, out = new THREE.Quaternion()): THREE.Quaternion { return out.setFromAxisAngle(Z, -a); }
function rollQ(a: number, out = new THREE.Quaternion()): THREE.Quaternion { return out.setFromAxisAngle(X, a); }

/** out = a·(1−t) + b·t, component-wise (vectors lerp, rotations slerp). out may alias a. */
export function lerpPose(a: PoseTargets, b: PoseTargets, t: number, out: PoseTargets): PoseTargets {
  out.pelvisOffset.lerpVectors(a.pelvisOffset, b.pelvisOffset, t);
  out.pelvisRot.slerpQuaternions(a.pelvisRot, b.pelvisRot, t);
  out.chestRot.slerpQuaternions(a.chestRot, b.chestRot, t);
  out.headRot.slerpQuaternions(a.headRot, b.headRot, t);
  for (let i = 0; i < 2; i++) {
    out.glove[i].lerpVectors(a.glove[i], b.glove[i], t);
    out.elbowPole[i].lerpVectors(a.elbowPole[i], b.elbowPole[i], t).normalize();
    out.ankle[i].lerpVectors(a.ankle[i], b.ankle[i], t);
    out.kneePole[i].lerpVectors(a.kneePole[i], b.kneePole[i], t).normalize();
    out.toeDir[i].lerpVectors(a.toeDir[i], b.toeDir[i], t).normalize();
  }
  return out;
}

/** Point fixed to the torso: hips + chestRot·local, all body space. */
function onTorso(dims: RigDims, P: PoseTargets, lx: number, ly: number, lz: number, out: THREE.Vector3): THREE.Vector3 {
  return out.set(lx, ly, lz).applyQuaternion(P.chestRot).add(dims.hips).add(P.pelvisOffset);
}

/**
 * Kneeling on both knees, shins flat behind. `curl` 0 = upright and dazed
 * (the get-up's middle), 1 = folded over the body, gloves clutching the stomach.
 */
function kneelPose(dims: RigDims, curl: number, out: PoseTargets): PoseTargets {
  const thigh = dims.legLen * 0.5;
  out.pelvisOffset.set(-0.04 - 0.06 * curl, thigh + 0.06 - dims.hips.y, 0);
  const lean = 0.2 + 0.75 * curl;
  out.pelvisRot.copy(pitchQ(lean * 0.45));
  out.chestRot.copy(pitchQ(lean));
  out.headRot.copy(pitchQ(lean + 0.25 + 0.2 * curl));
  for (let i = 0; i < 2; i++) {
    const side = i === 0 ? -1 : 1;
    out.ankle[i].set(-dims.legLen * 0.48, dims.ankleY, side * 0.14);
    out.kneePole[i].set(1, -1, side * 0.2).normalize();
    out.toeDir[i].set(1, 0, 0);
    // Gloves: hanging by the thighs when upright, pressed to the stomach when curled.
    const hang = _p.set(0.12, -0.22, side * 0.24);
    const clutch = new THREE.Vector3(0.24, 0.12, side * 0.06);
    hang.lerp(clutch, curl);
    onTorso(dims, out, hang.x, hang.y, hang.z, out.glove[i]);
    out.elbowPole[i].set(-0.3, -1, side * 0.8).normalize();
  }
  return out;
}

/** Taking a knee: lead foot planted, rear knee on the canvas, a glove on the lead knee. */
function takeKneePose(dims: RigDims, f: FighterState, out: PoseTargets): PoseTargets {
  const southpaw = f.boxingStance === "southpaw";
  const lead = southpaw ? 1 : 0;
  const thigh = dims.legLen * 0.5;
  out.pelvisOffset.set(-0.05, thigh + 0.1 - dims.hips.y, 0);
  out.pelvisRot.copy(pitchQ(0.1));
  out.chestRot.copy(pitchQ(0.3));
  out.headRot.copy(pitchQ(0.55));
  for (let i = 0; i < 2; i++) {
    const side = i === 0 ? -1 : 1;
    const isLead = i === lead;
    if (isLead) {
      out.ankle[i].set(thigh * 0.95, dims.ankleY, side * 0.16);
      out.kneePole[i].set(1, 0.4, side * 0.1).normalize();
      // Glove resting on top of the raised knee.
      out.glove[i].set(thigh * 0.85, thigh + 0.18, side * 0.12);
      out.elbowPole[i].set(-0.2, -1, side * 0.6).normalize();
    } else {
      out.ankle[i].set(-dims.legLen * 0.5, dims.ankleY, side * 0.16);
      out.kneePole[i].set(1, -1, side * 0.1).normalize();
      onTorso(dims, out, 0.1, -0.24, side * 0.26, out.glove[i]);
      out.elbowPole[i].set(-0.3, -1, side * 0.8).normalize();
    }
    out.toeDir[i].set(1, 0, 0);
  }
  return out;
}

/** On the back (pre-tilt): one knee up, one arm flung past the head, one across the body. */
function lyingBackPose(dims: RigDims, out: PoseTargets): PoseTargets {
  out.pelvisOffset.set(0, -0.04, 0);
  out.pelvisRot.copy(rollQ(0.12));
  out.chestRot.copy(pitchQ(-0.12)).premultiply(rollQ(0.16, _q));
  // Head rolled to the side, chin up a touch.
  out.headRot.copy(pitchQ(-0.25)).premultiply(rollQ(0.55, _q));
  const sh = dims.shoulder;
  // Left (i=0): flung out above the head on the mat.
  out.glove[0].set(-0.06, sh[0].y + 0.38, sh[0].z - 0.38);
  out.elbowPole[0].set(-0.3, 0, -1).normalize();
  // Right: draped across the stomach.
  onTorso(dims, out, 0.2, 0.22, -0.04, out.glove[1]);
  out.elbowPole[1].set(0.2, -0.2, 1).normalize();
  // Left leg straight, right knee bent up (pre-tilt +x is world up once laid back).
  out.ankle[0].set(0.02, dims.ankleY + 0.02, -0.2);
  out.kneePole[0].set(1, 0, -0.2).normalize();
  out.ankle[1].set(-0.06, dims.ankleY + dims.legLen * 0.45, 0.2);
  out.kneePole[1].set(1, 0, 0.25).normalize();
  out.toeDir[0].set(0.4, 0, -1).normalize();
  out.toeDir[1].set(1, 0, 0.3).normalize();
  return out;
}

function tiltFor(kind: KdKind, frac: number, tilt: BodyTilt): void {
  if (kind === "head") {
    // Hinge back about the feet; lift so the back rests on the canvas, not in it.
    tilt.q.setFromAxisAngle(Z, (Math.PI / 2) * frac);
    tilt.pos.set(0, 0.14 * frac, 0);
  } else if (kind === "body") {
    // Roll onto the right side about the right knee.
    tilt.q.setFromAxisAngle(X, (Math.PI / 2) * frac);
    const pivot = _p.set(0, 0, 0.16);
    tilt.pos.copy(pivot).sub(pivot.clone().applyQuaternion(tilt.q));
    tilt.pos.y += 0.06 * frac;
  } else {
    tilt.q.identity();
    tilt.pos.set(0, 0, 0);
  }
}

/** Stir on the canvas (0..1): the player's mash progress, or the AI nearing its get-up. */
function stirAmount(f: FighterState, state: GameState): number {
  if (!state.knockdownActive || state.kdFallTimer < KD_FALL_DURATION) return 0;
  if (f.isPlayer) {
    const req = state.knockdownMashRequired || 0;
    return req > 0 ? clamp01(state.knockdownMashCount / req) : 0;
  }
  if (!state.aiKdWillGetUp) return 0;
  return smooth((state.knockdownCountdown - (state.aiKdGetUpTime - 1.6)) / 1.6);
}

/**
 * Blend the knockdown staging into `pose` (the standing solve) and return the
 * body tilt. Returns false when the fighter is simply standing.
 */
export function applyKnockdownPose(
  f: FighterState, state: GameState, dims: RigDims, mem: KdMemory, dt: number, epoch: number,
  pose: PoseTargets, tilt: BodyTilt,
): boolean {
  dt = Math.max(0, Math.min(0.1, dt));
  if (epoch !== mem.epoch) {
    // New fight / restart: no get-up replay from the previous bout.
    mem.epoch = epoch;
    mem.down = f.isKnockedDown;
    mem.upT = -1;
    mem.downT = mem.down ? 10 : 0;
    mem.settleT = mem.down ? 10 : 0;
    mem.kind = state.kdIsBodyShot ? (state.kdTakeKnee ? "knee" : "body") : "head";
  }
  if (f.isKnockedDown && !mem.down) {
    mem.down = true;
    mem.kind = state.kdIsBodyShot ? (state.kdTakeKnee ? "knee" : "body") : "head";
    mem.downT = 0;
    mem.settleT = 0;
    mem.upT = -1;
  } else if (!f.isKnockedDown && mem.down) {
    mem.down = false;
    mem.upT = 0;
  }

  const { a, b } = mem;
  if (mem.down) {
    mem.downT += dt;
    // Trust the engine's fall timer only while the knockdown is live and the
    // bout is still on: a stoppage or the fight ending can freeze it mid-fall
    // (an immediate TKO leaves it at 0), so from then on the fall finishes on
    // the render clock, never going backwards.
    const engineP = state.knockdownActive ? clamp01(state.kdFallTimer / KD_FALL_DURATION) : 0;
    const engineLive = state.knockdownActive && state.phase !== "fightEnd" && !state.refStoppageActive && !state.towelActive;
    const p = engineLive ? engineP : Math.max(engineP, clamp01(mem.downT / KD_FALL_DURATION));
    if (p >= 1) mem.settleT += dt;
    const stir = stirAmount(f, state);
    let frac = 0;
    if (mem.kind === "head") {
      lyingBackPose(dims, a);
      // Legs go first, then gravity takes the rest.
      lerpPose(pose, a, smooth(p * 1.6), pose);
      frac = p * p;
      // A small bounce off the canvas, then up onto the elbows as they stir.
      const s = mem.settleT;
      if (s > 0 && s < 0.35) frac -= 0.06 * Math.sin((s / 0.35) * Math.PI) * (1 - s / 0.35);
      frac -= 0.26 * stir;
    } else if (mem.kind === "body") {
      kneelPose(dims, 1, a);
      lerpPose(pose, a, smooth(p), pose);
      frac = Math.pow(clamp01(mem.settleT / BODY_ROLL_DURATION), 2) * (1 - 0.3 * stir);
    } else {
      takeKneePose(dims, f, a);
      lerpPose(pose, a, smooth(p), pose);
    }
    mem.lastTilt = frac;
    tiltFor(mem.kind, frac, tilt);
    return true;
  }

  if (mem.upT >= 0) {
    mem.upT += dt;
    const total = mem.kind === "knee" ? GETUP_KNEE_DURATION : GETUP_DURATION;
    const u = mem.upT / total;
    if (u >= 1) { mem.upT = -1; return false; }
    if (mem.kind === "knee") {
      takeKneePose(dims, f, a);
      lerpPose(a, pose, smooth(u), pose);
      tiltFor("knee", 0, tilt);
      return true;
    }
    // Down → kneel (first half), kneel → standing (second half).
    if (mem.kind === "head") lyingBackPose(dims, a); else kneelPose(dims, 1, a);
    kneelPose(dims, 0.15, b);
    const m = smooth(u / 0.5);
    lerpPose(a, b, m, a);
    lerpPose(a, pose, smooth((u - 0.5) / 0.5), pose);
    tiltFor(mem.kind, mem.lastTilt * (1 - m), tilt);
    return true;
  }
  return false;
}
