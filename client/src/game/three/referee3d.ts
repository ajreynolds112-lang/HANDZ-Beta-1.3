/**
 * The 3D referee: the boxer rig dressed in a striped shirt and dark trousers,
 * posed from the knockdown/stoppage state the engine already keeps.
 *
 *  - while the count runs (knockdownRefCount 1..9): bent over the downed
 *    fighter, the right arm chopping down once per count, on the engine's
 *    knockdownCountdown clock;
 *  - a ten count, a referee stoppage or a towel: both arms scissoring overhead
 *    (the wave-off);
 *  - otherwise standing, arms loose.
 *
 * Read-only on GameState. The only memory is the render-side blend between poses.
 */
import * as THREE from "three";
import type { GameState } from "../types";
import type { BoneName, RigInstance } from "./fighterRig";
import { newPoseTargets, type PoseTargets, type RigDims } from "./fighterPose";
import { lerpPose } from "./knockdownPose";

export interface RefereeMemory { cur: PoseTargets; target: PoseTargets; init: boolean; t: number }

export function newRefereeMemory(): RefereeMemory {
  return { cur: newPoseTargets(), target: newPoseTargets(), init: false, t: 0 };
}

const Z = new THREE.Vector3(0, 0, 1);
function pitchQ(a: number, out: THREE.Quaternion): THREE.Quaternion { return out.setFromAxisAngle(Z, -a); }

export type RefereeAction = "stand" | "count" | "waveOff";

export function refereeAction(state: GameState): RefereeAction {
  if (state.refStoppageActive || state.towelActive) return "waveOff";
  if (state.knockdownRefCount >= 10) return "waveOff";
  if (state.knockdownActive && state.knockdownRefCount > 0) return "count";
  return "stand";
}

export function solveRefereePose(state: GameState, dims: RigDims, mem: RefereeMemory, dt: number, out: PoseTargets): PoseTargets {
  dt = Math.max(0, Math.min(0.1, dt));
  mem.t += dt;
  const T = mem.target;
  const action = refereeAction(state);
  const sh = dims.shoulder;
  const lean = action === "count" ? 0.42 : action === "waveOff" ? -0.05 : 0.04;
  const crouch = action === "count" ? 0.1 : 0;
  T.pelvisOffset.set(-0.05 * (action === "count" ? 1 : 0), -0.02 - crouch, 0);
  pitchQ(lean * 0.35, T.pelvisRot);
  pitchQ(lean, T.chestRot);
  pitchQ(action === "count" ? 0.2 : 0, T.headRot);
  for (let i = 0; i < 2; i++) {
    const side = i === 0 ? -1 : 1;
    T.ankle[i].set(0.03, dims.ankleY, side * 0.17);
    T.kneePole[i].set(1, 0, side * 0.15).normalize();
    T.toeDir[i].set(1, 0, side * 0.25).normalize();
    T.maxStretch[i] = 1;
    T.elbowPole[i].set(-0.4, -1, side * 0.5).normalize();
    const g = T.glove[i];
    if (action === "count") {
      if (i === 1) {
        // One chop per second of the engine count: raise, then drive down.
        const c = state.knockdownCountdown - Math.floor(state.knockdownCountdown);
        const k = c < 0.3 ? 1 - c / 0.3 : c < 0.5 ? (c - 0.3) / 0.2 : 1;
        const upP = 1 - k * k;
        g.set(0.62 - 0.38 * upP, sh[1].y - 0.55 + 0.95 * upP - crouch, 0.22);
        T.elbowPole[i].set(-0.2, -0.3, 1).normalize();
      } else {
        g.set(0.42, dims.hips.y - 0.38 - crouch, -0.2); // hand on the knee
      }
    } else if (action === "waveOff") {
      const s = Math.cos(mem.t * 10);
      g.set(0.28, dims.headY + 0.22, side * 0.08 + s * side * 0.42 * (i === 0 ? 1 : -1));
      T.elbowPole[i].set(0, -0.2, side).normalize();
    } else {
      g.set(0.05, dims.hips.y - 0.08, side * (Math.abs(sh[i].z) + 0.12));
      T.elbowPole[i].set(-1, -0.2, side * 0.3).normalize();
    }
  }
  if (!mem.init) { lerpPose(T, T, 0, mem.cur); mem.init = true; }
  const rate = action === "waveOff" ? 22 : 14;
  lerpPose(mem.cur, T, 1 - Math.exp(-dt * rate), mem.cur);
  return lerpPose(mem.cur, mem.cur, 0, out);
}

// ───────── clothes ─────────

let stripeTex: THREE.CanvasTexture | null = null;
function stripeTexture(): THREE.Texture | null {
  if (stripeTex) return stripeTex;
  if (typeof document === "undefined") return null;
  const c = document.createElement("canvas");
  c.width = 64; c.height = 4;
  const ctx = c.getContext("2d");
  if (!ctx) return null;
  ctx.fillStyle = "#f2f2ee";
  ctx.fillRect(0, 0, 64, 4);
  ctx.fillStyle = "#151515";
  ctx.fillRect(0, 0, 24, 4);
  stripeTex = new THREE.CanvasTexture(c);
  stripeTex.colorSpace = THREE.SRGBColorSpace;
  stripeTex.wrapS = THREE.RepeatWrapping;
  stripeTex.repeat.set(9, 1);
  return stripeTex;
}

/**
 * Overlay clothes on the rig's bones: the shirt (vertical black stripes) over
 * the torso and upper arms, trousers over the legs. Each piece is a tube built
 * in body space between two bind-pose bone positions and parented to the first
 * bone, so it follows the pose like the skin does. Call once per rig, unposed.
 */
export function buildRefereeClothes(rig: RigInstance, _bind: unknown, dims: RigDims): THREE.Object3D {
  const body = rig.body;
  body.updateWorldMatrix(true, true);
  const inv = new THREE.Matrix4().copy(body.matrixWorld).invert();
  const pos = (b: BoneName) => new THREE.Vector3().setFromMatrixPosition(new THREE.Matrix4().copy(inv).multiply(rig.bones[b].matrixWorld));
  const tex = stripeTexture();
  const shirtMat = new THREE.MeshStandardMaterial({ color: tex ? "#ffffff" : "#f2f2ee", map: tex, roughness: 0.8 });
  const pantsMat = new THREE.MeshStandardMaterial({ color: "#16161a", roughness: 0.75 });
  const marker = new THREE.Group();
  const geos: THREE.BufferGeometry[] = [];

  const tube = (bone: BoneName, a: THREE.Vector3, b: THREE.Vector3, rx: number, rz: number, r1Scale: number, mat: THREE.Material) => {
    const len = a.distanceTo(b);
    const g = new THREE.CylinderGeometry(r1Scale, 1, len, 18, 1, true);
    g.scale(rx, 1, rz);
    g.translate(0, len / 2, 0);
    // Body space: from a toward b.
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
    g.applyMatrix4(new THREE.Matrix4().compose(a, q, new THREE.Vector3(1, 1, 1)));
    // Into the bone's local space.
    const boneRel = new THREE.Matrix4().copy(inv).multiply(rig.bones[bone].matrixWorld).invert();
    g.applyMatrix4(boneRel);
    geos.push(g);
    const m = new THREE.Mesh(g, mat);
    m.castShadow = true;
    rig.bones[bone].add(m);
  };

  const halfW = Math.max(0.14, Math.abs(dims.shoulder[1].z - dims.shoulder[0].z) / 2);
  const hips = pos("Hips"), spine1 = pos("Spine1"), neck = pos("Neck");
  const waist = hips.clone().add(new THREE.Vector3(0, 0.04, 0));
  tube("Spine", waist, spine1, halfW * 0.62, halfW * 0.92, 1.0, shirtMat);
  tube("Spine2", spine1, neck.clone().add(new THREE.Vector3(0, -0.03, 0)), halfW * 0.62, halfW * 0.92, 0.8, shirtMat);
  for (const s of ["Left", "Right"] as const) {
    const sh = pos(`${s}Arm`), el = pos(`${s}ForeArm`);
    const sleeveEnd = sh.clone().lerp(el, 0.45);
    tube(`${s}Arm`, sh.clone().lerp(el, -0.12), sleeveEnd, halfW * 0.42, halfW * 0.42, 0.85, shirtMat);
    const hip = pos(`${s}UpLeg`), knee = pos(`${s}Leg`), ankle = pos(`${s}Foot`);
    tube(`${s}UpLeg`, hip.clone().add(new THREE.Vector3(0, 0.08, 0)), knee, halfW * 0.6, halfW * 0.6, 0.72, pantsMat);
    tube(`${s}Leg`, knee, ankle.clone().add(new THREE.Vector3(0, 0.03, 0)), halfW * 0.44, halfW * 0.44, 0.8, pantsMat);
  }
  marker.userData.dispose = () => { geos.forEach(g => g.dispose()); shirtMat.dispose(); pantsMat.dispose(); };
  return marker;
}
