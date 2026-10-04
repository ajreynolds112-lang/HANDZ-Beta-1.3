/**
 * One 3D boxer: a rig instance (Tripo body or the code rig), driven every frame
 * from FighterState through the pose solver, tinted from the fighter's colours.
 *
 * The driver works in the fighter's body space with its own forward kinematics
 * (no Tripo animation clips), so timing is exactly the engine's: torso bones
 * take the solver's rotations, arms and legs are two-bone IK onto the solver's
 * glove and ankle targets from wherever the rig's real shoulders/hips ended up.
 * Read-only on the fighter.
 */
import * as THREE from "three";
import type { FighterColors, FighterState, GameState } from "../types";
import { cssColorOf, getSpacialTileCanvas, isSpacial } from "../spacialColor";
import {
  DEFAULT_HEADGEAR_COLOR, DEFAULT_SOCK_COLOR, SPARRING_HEADGEAR_BY_DIFFICULTY,
  defaultLaceColor, defaultSoleColor, defaultWaistStripeColor,
} from "../renderer";
import { BONE_NAMES, type BoneName, type Region, type RigInstance, createRig, fighterAssetEpoch } from "./fighterRig";
import { type PoseMemory, type PoseTargets, type RigDims, eyeState, newPoseMemory, newPoseTargets, solvePose } from "./fighterPose";
import { getPoseOffsets, type PoseOffsets } from "./poseOffsets";
import { PROFILE_VIEW_OPP_PX, activePunchProfile } from "./punchProfiles";
import { MAT_HEIGHT, toSceneX, toSceneYaw, toSceneZ } from "./worldMapping";
import { type BodyTilt, type KdMemory, applyKnockdownPose, newKdMemory } from "./knockdownPose";
import { type RefereeMemory, buildRefereeClothes, newRefereeMemory, solveRefereePose } from "./referee3d";

interface BoneBind {
  bone: THREE.Object3D;
  parent: BoneName | null;
  localPos: THREE.Vector3;
  localQ: THREE.Quaternion;
  bodyQ: THREE.Quaternion;
  bodyPos: THREE.Vector3;
  /** Uniform body-space scale of the parent (local units → body metres). */
  parentScale: number;
}

// ── shared spacial texture: one upload per frame for every fighter ──
let spacialTex: THREE.CanvasTexture | null = null;
let spacialFrame = -1;
function spacialTexture(frame: number): THREE.CanvasTexture | null {
  const c = getSpacialTileCanvas();
  if (!c) return null;
  if (!spacialTex || spacialTex.image !== c) {
    spacialTex = new THREE.CanvasTexture(c);
    spacialTex.colorSpace = THREE.SRGBColorSpace;
    spacialTex.wrapS = spacialTex.wrapT = THREE.RepeatWrapping;
  }
  if (frame !== spacialFrame) { spacialFrame = frame; spacialTex.needsUpdate = true; }
  return spacialTex;
}

/** Screen-anchored starfield, like the 2D finish: sample by gl_FragCoord. */
function setSpacial(mat: THREE.MeshStandardMaterial, on: boolean, tex: THREE.Texture | null): void {
  const was = mat.userData.spacial === true;
  if (on === was) {
    if (on && mat.userData.uniform) mat.userData.uniform.value = tex;
    return;
  }
  mat.userData.spacial = on;
  if (on) {
    const uniform = { value: tex };
    mat.userData.uniform = uniform;
    mat.onBeforeCompile = sh => {
      sh.uniforms.spacialMap = uniform;
      sh.fragmentShader = "uniform sampler2D spacialMap;\n" + sh.fragmentShader.replace(
        "#include <map_fragment>",
        "#include <map_fragment>\n diffuseColor.rgb = texture2D(spacialMap, gl_FragCoord.xy / 110.0).rgb;",
      );
    };
    mat.customProgramCacheKey = () => "spacial";
  } else {
    mat.onBeforeCompile = () => {};
    mat.customProgramCacheKey = () => "plain";
  }
  mat.needsUpdate = true;
}

const LEFT_PUNCHES = new Set(["jab", "leftHook", "leftUppercut"]);
const RED = new THREE.Color("#ff2222");
const WHITE = new THREE.Color("#ffffff");
const CHARGE = new THREE.Color("#4a8cff");
const EMPOWERED = new THREE.Color("#ffb41e");
const PB_BLUE = new THREE.Color("#96d2ff");
const BLACK = new THREE.Color("#000000");

export class Fighter3D {
  readonly root = new THREE.Group();
  private rig!: RigInstance;
  private epoch = -1;
  private bind = {} as Record<BoneName, BoneBind>;
  private dims!: RigDims;
  private hipsParentInv = new THREE.Matrix4();
  private hipsParentQ = new THREE.Quaternion();
  private mem: PoseMemory = newPoseMemory();
  private pose: PoseTargets = newPoseTargets();
  private kd: KdMemory = newKdMemory();
  private tilt: BodyTilt = { q: new THREE.Quaternion(), pos: new THREE.Vector3() };
  private refMem: RefereeMemory = newRefereeMemory();
  private shirt: THREE.Object3D | null = null;
  private colorKey = "";
  private glow: THREE.Mesh[] = [];
  private glowGeo = new THREE.SphereGeometry(0.13, 14, 10);
  private lastT = -1;
  private armLens: [number, number][] = [];
  private legLens: [number, number][] = [];
  /** Editor previews: arms keep their bind length (in fights they stretch to reach the real hit range). */
  noStretch = false;
  /** This frame's arm stretch is off (editor preview, or a profiled punch playing as authored). */
  private stretchOff = false;
  /** Hand joint → glove centre, the part of the arm that never stretches. */
  private gloveTail: [number, number] = [0, 0];
  // FK scratch: current body-space pose of every bone.
  private cq = {} as Record<BoneName, THREE.Quaternion>;
  private cp = {} as Record<BoneName, THREE.Vector3>;

  constructor() {
    for (const b of BONE_NAMES) { this.cq[b] = new THREE.Quaternion(); this.cp[b] = new THREE.Vector3(); }
    this.build();
  }

  get kind(): RigInstance["kind"] { return this.rig.kind; }

  private build(): void {
    if (this.rig) {
      this.root.remove(this.rig.body);
      this.rig.dispose();
    }
    this.epoch = fighterAssetEpoch();
    this.rig = createRig();
    this.root.add(this.rig.body);
    this.colorKey = "";
    this.captureBind();
    this.glow = [];
    for (const c of [this.rig.gloveCenter.left, this.rig.gloveCenter.right]) {
      const m = new THREE.Mesh(this.glowGeo, new THREE.MeshBasicMaterial({
        color: "#ffffff", transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false,
      }));
      m.visible = false;
      c.add(m);
      this.glow.push(m);
    }
  }

  private captureBind(): void {
    const body = this.rig.body;
    body.updateMatrixWorld(true);
    const inv = new THREE.Matrix4().copy(body.matrixWorld).invert();
    const m = new THREE.Matrix4(), p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
    const boneSet = new Set(Object.values(this.rig.bones));
    for (const name of BONE_NAMES) {
      const bone = this.rig.bones[name];
      m.copy(inv).multiply(bone.matrixWorld).decompose(p, q, s);
      let parentName: BoneName | null = null;
      if (bone.parent && boneSet.has(bone.parent)) {
        parentName = BONE_NAMES.find(n => this.rig.bones[n] === bone.parent) ?? null;
      }
      const ps = new THREE.Vector3();
      new THREE.Matrix4().copy(inv).multiply(bone.parent!.matrixWorld).decompose(new THREE.Vector3(), new THREE.Quaternion(), ps);
      this.bind[name] = {
        bone, parent: parentName,
        localPos: bone.position.clone(), localQ: bone.quaternion.clone(),
        bodyQ: q.clone(), bodyPos: p.clone(), parentScale: ps.x,
      };
      if (name === "Hips") {
        const pm = new THREE.Matrix4().copy(inv).multiply(bone.parent!.matrixWorld);
        this.hipsParentInv.copy(pm).invert();
        pm.decompose(new THREE.Vector3(), this.hipsParentQ, new THREE.Vector3());
      }
    }
    const P = (n: BoneName) => this.bind[n].bodyPos;
    const gl = new THREE.Vector3().setFromMatrixPosition(m.copy(inv).multiply(this.rig.gloveCenter.left.matrixWorld));
    const gr = new THREE.Vector3().setFromMatrixPosition(m.copy(inv).multiply(this.rig.gloveCenter.right.matrixWorld));
    this.armLens = [
      [P("LeftArm").distanceTo(P("LeftForeArm")), P("LeftForeArm").distanceTo(gl)],
      [P("RightArm").distanceTo(P("RightForeArm")), P("RightForeArm").distanceTo(gr)],
    ];
    this.gloveTail = [P("LeftHand").distanceTo(gl), P("RightHand").distanceTo(gr)];
    this.legLens = [
      [P("LeftUpLeg").distanceTo(P("LeftLeg")), P("LeftLeg").distanceTo(P("LeftFoot"))],
      [P("RightUpLeg").distanceTo(P("RightLeg")), P("RightLeg").distanceTo(P("RightFoot"))],
    ];
    const headCenter = this.rig.headgear.getWorldPosition(new THREE.Vector3()).applyMatrix4(inv);
    this.dims = {
      hips: P("Hips").clone(),
      chest: P("Spine2").clone(),
      headY: headCenter.y,
      shoulder: [P("LeftArm").clone(), P("RightArm").clone()],
      armLen: this.armLens[0][0] + this.armLens[0][1],
      legLen: this.legLens[0][0] + this.legLens[0][1],
      ankleY: (P("LeftFoot").y + P("RightFoot").y) / 2,
    };
  }

  update(f: FighterState, colors: FighterColors, opponent: FighterState | null, state: GameState, frame: number, epoch = 0): void {
    if (fighterAssetEpoch() !== this.epoch) this.build();
    const now = performance.now() / 1000;
    const dt = this.lastT < 0 ? 1 / 60 : now - this.lastT;
    this.lastT = now;

    this.root.position.set(toSceneX(f.x), MAT_HEIGHT, toSceneZ(f.z));
    this.root.rotation.set(0, toSceneYaw(f.facingAngle), 0);

    // A punch-animation profile re-times the pose solve (visual only) and adds
    // its keyframed joint rotations on top of the stance edits.
    const prof = f.isKnockedDown ? null : activePunchProfile(f);
    const sliding = !!prof && prof.slide > 0;
    // Visual only: a profiled punch is solved against the editor's stand-in
    // opponent (same direction, editor distance, not ducking) with no arm
    // stretch, so it never compresses or over-reaches. Hits are untouched.
    this.stretchOff = this.noStretch || !!prof;
    if (prof && opponent) {
      const dx = opponent.x - f.x, dz = opponent.z - f.z, d = Math.hypot(dx, dz);
      const ux = d > 1e-6 ? dx / d : Math.cos(f.facingAngle), uz = d > 1e-6 ? dz / d : Math.sin(f.facingAngle);
      opponent = { ...opponent, x: f.x + ux * PROFILE_VIEW_OPP_PX, z: f.z + uz * PROFILE_VIEW_OPP_PX, duckProgress: 0 };
    }
    if (sliding && !this.slideFrom) this.captureSlideFrom(prof!, opponent);
    if (!sliding) this.slideFrom = null;
    // Sliding back: the live solve already heads home (its springs end at the
    // guard when the punch does); it's blended in from the held Loop Start pose.
    const solveF = sliding ? { ...f, isPunching: false, currentPunch: null } : (prof?.fighter ?? f);
    solvePose(solveF, this.dims, this.mem, { opponent, dt, snapPunch: !!prof && !sliding }, this.pose);
    // Knockdown fall / canvas / get-up, layered over the standing solve.
    if (applyKnockdownPose(f, state, this.dims, this.kd, dt, epoch, this.pose, this.tilt)) {
      this.rig.body.quaternion.copy(this.tilt.q);
      this.rig.body.position.copy(this.tilt.pos);
    } else {
      this.rig.body.quaternion.identity();
      this.rig.body.position.set(0, 0, 0);
    }
    this.applyPose();
    if (!f.isKnockedDown) this.applyPoseOffsets(getPoseOffsets(this.mem.stanceBlend >= 0.5 ? "southpaw" : "orthodox"), true);
    if (prof && !sliding) this.applyPoseOffsets(prof.offsets, false);
    if (sliding) this.blendFromSlide(prof!.slide);
    this.preSlide = !!prof && !sliding;
    this.applyLook(f, colors, state, frame);
    if (f.isKnockedDown) for (const e of this.rig.eyes) e.scale.y = e.userData.baseScale.y * 0.15;
  }

  /**
   * Drive this rig as the referee: same skeleton, solved by the referee pose
   * instead of a FighterState. No gear flashes, glows or headgear.
   */
  updateReferee(x: number, z: number, facing: number, state: GameState, colors: FighterColors, frame: number): void {
    if (fighterAssetEpoch() !== this.epoch) { this.build(); this.shirt = null; }
    const now = performance.now() / 1000;
    const dt = this.lastT < 0 ? 1 / 60 : now - this.lastT;
    this.lastT = now;
    this.root.position.set(toSceneX(x), MAT_HEIGHT, toSceneZ(z));
    this.root.rotation.set(0, toSceneYaw(facing), 0);
    this.rig.body.quaternion.identity();
    this.rig.body.position.set(0, 0, 0);
    if (!this.shirt) this.shirt = buildRefereeClothes(this.rig, this.bind, this.dims);
    solveRefereePose(state, this.dims, this.refMem, dt, this.pose);
    this.applyPose();
    const M = this.rig.materials;
    const key = "ref|" + colors.skin;
    if (key !== this.colorKey) {
      this.colorKey = key;
      M.skin.color.set(colors.skin);
      M.glove.color.set(colors.skin);
      M.tape.color.set(colors.skin);
      for (const r of ["trunks", "stripe", "socks", "shoe", "laces", "sole"] as Region[]) M[r].color.set("#141416");
      for (const r of Object.keys(M) as Region[]) { M[r].emissive.copy(BLACK); setSpacial(M[r], false, null); }
    }
    for (const g of this.glow) g.visible = false;
    this.rig.headgear.visible = false;
  }

  /** World position of the head (for hit effects). One frame stale, which is fine for a spawn point. */
  headWorld(out: THREE.Vector3): THREE.Vector3 {
    return this.rig.bones.Head.getWorldPosition(out);
  }

  // ───────── driver ─────────

  private setBody(name: BoneName, bodyQ: THREE.Quaternion): void {
    const b = this.bind[name];
    const parentQ = b.parent ? this.cq[b.parent] : this.hipsParentQ;
    b.bone.quaternion.copy(parentQ).invert().multiply(bodyQ);
    this.cq[name].copy(bodyQ);
  }
  private keepBind(name: BoneName): void {
    const b = this.bind[name];
    b.bone.quaternion.copy(b.localQ);
    this.cq[name].copy(this.cq[b.parent!]).multiply(b.localQ);
  }
  /** FK position of `name` from its parent's current body pose. */
  private fk(name: BoneName): THREE.Vector3 {
    const b = this.bind[name];
    return this.cp[name].copy(b.bone.position).multiplyScalar(b.parentScale).applyQuaternion(this.cq[b.parent!]).add(this.cp[b.parent!]);
  }

  private _q = new THREE.Quaternion();
  private _m1 = new THREE.Matrix4();
  private _m2 = new THREE.Matrix4();
  private _x = new THREE.Vector3();
  private _y = new THREE.Vector3();
  private _z = new THREE.Vector3();

  /** Body-space rotation taking the bone's bind (dir, normal) frame onto (dir, normal), applied to its bind orientation. */
  private aim(name: BoneName, bindDir: THREE.Vector3, bindN: THREE.Vector3, dir: THREE.Vector3, n: THREE.Vector3): void {
    const z0 = this._z.crossVectors(bindDir, bindN);
    this._m1.makeBasis(bindDir, bindN, z0);
    const z1 = this._y.crossVectors(dir, n);
    this._m2.makeBasis(dir, n, z1);
    this._m2.multiply(this._m1.transpose());
    this._q.setFromRotationMatrix(this._m2).multiply(this.bind[name].bodyQ);
    this.setBody(name, this._q);
  }

  private applyPose(): void {
    const P = this.pose;
    const B = this.bind;
    // Hips: position + rotation.
    const hipsPos = this.cp.Hips.copy(B.Hips.bodyPos).add(P.pelvisOffset);
    B.Hips.bone.position.copy(hipsPos).applyMatrix4(this.hipsParentInv);
    this.setBody("Hips", this._q.copy(P.pelvisRot).multiply(B.Hips.bodyQ));
    const spineK: [BoneName, number][] = [["Spine", 0.4], ["Spine1", 0.75], ["Spine2", 1]];
    const tmp = new THREE.Quaternion();
    for (const [n, k] of spineK) {
      this.fk(n);
      tmp.slerpQuaternions(P.pelvisRot, P.chestRot, k);
      this.setBody(n, tmp.multiply(B[n].bodyQ));
    }
    this.fk("Neck");
    tmp.slerpQuaternions(P.chestRot, P.headRot, 0.5);
    const fix = this.rig.bindFix;
    if (fix?.Neck) tmp.multiply(fix.Neck);
    this.setBody("Neck", tmp.multiply(B.Neck.bodyQ));
    this.fk("Head");
    tmp.copy(P.headRot);
    if (fix?.Head) tmp.multiply(fix.Head);
    this.setBody("Head", tmp.multiply(B.Head.bodyQ));

    const sides = ["Left", "Right"] as const;
    sides.forEach((s, i) => {
      this.fk(`${s}Shoulder`);
      this.keepBind(`${s}Shoulder`);
      const S = this.fk(`${s}Arm`).clone();
      this.limb(`${s}Arm`, `${s}ForeArm`, `${s}Hand`, S, P.glove[i], P.elbowPole[i], this.armLens[i], this.stretchOff ? 1 : P.maxStretch[i], new THREE.Vector3(1, 0, 0), this.gloveTail[i]);
      this.fk(`${s}Hand`);
      this.keepBind(`${s}Hand`);
    });
    sides.forEach((s, i) => {
      const H = this.fk(`${s}UpLeg`).clone();
      this.limb(`${s}UpLeg`, `${s}Leg`, `${s}Foot`, H, P.ankle[i], P.kneePole[i], this.legLens[i], 1.0, new THREE.Vector3(-1, 0, 0));
      this.fk(`${s}Foot`);
      // Foot: turn the bind foot about y so its +x heads down toeDir.
      const yaw = Math.atan2(-P.toeDir[i].z, P.toeDir[i].x);
      this.setBody(`${s}Foot`, this._q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw).multiply(B[`${s}Foot`].bodyQ));
      this.fk(`${s}ToeBase`);
      this.keepBind(`${s}ToeBase`);
    });
  }

  // ── Slide Back ──
  /** Local bone rotations (+ hips position) held at Loop Start while sliding back. */
  private slideFrom: { q: THREE.Quaternion[]; hips: THREE.Vector3 } | null = null;
  /** Last frame showed a profiled punch before its Loop Start (so the bones hold that pose). */
  private preSlide = false;
  private snapBones(): { q: THREE.Quaternion[]; hips: THREE.Vector3 } {
    return { q: BONE_NAMES.map(n => this.bind[n].bone.quaternion.clone()), hips: this.bind.Hips.bone.position.clone() };
  }
  private captureSlideFrom(prof: { fighter: FighterState; offsets: PoseOffsets }, opponent: FighterState | null): void {
    // Played straight into the slide: the bones still hold the last frame — exactly
    // the pose at Loop Start, springs and all. Jumped in (scrub): solve it fresh.
    if (!this.preSlide) {
      const scratch: PoseMemory = JSON.parse(JSON.stringify(this.mem));
      solvePose(prof.fighter, this.dims, scratch, { opponent, dt: 1 }, this.pose);
      this.rig.body.quaternion.identity();
      this.rig.body.position.set(0, 0, 0);
      this.applyPose();
      this.applyPoseOffsets(getPoseOffsets(scratch.stanceBlend >= 0.5 ? "southpaw" : "orthodox"), true, scratch);
      this.applyPoseOffsets(prof.offsets, false);
    }
    this.slideFrom = this.snapBones();
  }
  /** Shortest-arc slerp per joint from the held pose to the live guard: no joint ever spins the long way. */
  private blendFromSlide(w: number): void {
    const A = this.slideFrom;
    if (!A) return;
    BONE_NAMES.forEach((n, i) => {
      const bone = this.bind[n].bone;
      this._oq.copy(A.q[i]).slerp(bone.quaternion, w);
      bone.quaternion.copy(this._oq);
    });
    this.bind.Hips.bone.position.lerpVectors(A.hips, this.bind.Hips.bone.position, w);
  }

  private _oq = new THREE.Quaternion();
  private _ob = new THREE.Quaternion();
  private _oe = new THREE.Euler();
  /**
   * Hand-edited joint rotations (Edit Poses), about the body axes, root → leaf
   * so a joint carries its children. With fadeWithPunch a punching arm's offsets
   * fade out with its extension (stance edits); punch profiles apply in full.
   */
  private applyPoseOffsets(offs: PoseOffsets, fadeWithPunch: boolean, mem: PoseMemory = this.mem): void {
    let any = false;
    for (const k in offs) { any = true; break; }
    if (!any) return;
    const bodyInv = this.rig.body.getWorldQuaternion(this._ob).invert();
    for (const name of BONE_NAMES) {
      const r = offs[name];
      if (!r) continue;
      const armSide = name.startsWith("Left") && /Shoulder|Arm|Hand/.test(name) ? 0
        : name.startsWith("Right") && /Shoulder|Arm|Hand/.test(name) ? 1 : -1;
      const w = fadeWithPunch && armSide >= 0 ? 1 - Math.min(1, mem.armExt[armSide] || 0) : 1;
      if (w <= 0) continue;
      const bone = this.bind[name].bone;
      // B = the bone's current body-space orientation; local delta = B⁻¹·Q·B.
      const B = bone.getWorldQuaternion(new THREE.Quaternion()).premultiply(bodyInv);
      const D = THREE.MathUtils.DEG2RAD * w;
      this._oq.setFromEuler(this._oe.set(r[0] * D, r[1] * D, r[2] * D, "YXZ"));
      bone.quaternion.multiply(B.clone().invert().multiply(this._oq).multiply(B));
    }
  }

  private _bd = new THREE.Vector3();
  private _bn = new THREE.Vector3();
  private _u = new THREE.Vector3();
  private _w = new THREE.Vector3();
  private _e = new THREE.Vector3();
  private _d = new THREE.Vector3();
  private _n = new THREE.Vector3();

  /** Two-bone IK with optional stretch; `fold` is the bind-pose direction the lower bone folds toward. */
  private limb(upper: BoneName, lower: BoneName, end: BoneName, S: THREE.Vector3, T: THREE.Vector3, pole: THREE.Vector3,
    lens: [number, number], maxStretch: number, fold: THREE.Vector3, tailLen = 0): void {
    const B = this.bind;
    let [a, b] = lens;
    const toT = this._u.subVectors(T, S);
    const d = Math.max(1e-4, toT.length());
    toT.divideScalar(d);
    // Stretch scales the bones, not the unscaled tail past the end joint (the
    // glove sits a fixed distance beyond the hand), so solve k on the bones only.
    const tail = Math.min(tailLen, b * 0.9);
    const bones = a + b - tail;
    const k = d > (a + b) * 0.999 ? Math.min(maxStretch, (d / 0.999 - tail) / bones) : 1;
    a *= k; b = (b - tail) * k + tail;
    B[lower].bone.position.copy(B[lower].localPos).multiplyScalar(k);
    B[end].bone.position.copy(B[end].localPos).multiplyScalar(k);
    const dc = Math.min(a + b - 1e-4, Math.max(Math.abs(a - b) + 1e-3, d));
    const cosA = Math.max(-1, Math.min(1, (a * a + dc * dc - b * b) / (2 * a * dc)));
    const sinA = Math.sqrt(1 - cosA * cosA);
    const w = this._w.copy(pole).addScaledVector(toT, -pole.dot(toT));
    if (w.lengthSq() < 1e-8) w.set(0, -1, 0).addScaledVector(toT, toT.y);
    w.normalize();
    const E = this._e.copy(S).addScaledVector(toT, a * cosA).addScaledVector(w, a * sinA);

    // Upper bone.
    const bindUp = this._bd.subVectors(B[lower].bodyPos, B[upper].bodyPos).normalize();
    const bindN = this._bn.crossVectors(bindUp, fold).normalize();
    const dUp = this._d.subVectors(E, S).normalize();
    const tip = new THREE.Vector3().copy(S).addScaledVector(toT, dc);
    const n = this._n.crossVectors(dUp, tip.sub(E).normalize());
    if (n.lengthSq() < 1e-8) n.crossVectors(dUp, w.clone().negate());
    n.normalize();
    this.aim(upper, bindUp, bindN, dUp, n);

    // Lower bone, same hinge plane.
    this.fk(lower);
    const bindLo = this._bd.subVectors(B[end].bodyPos, B[lower].bodyPos).normalize();
    const bindN2 = new THREE.Vector3().crossVectors(bindLo, fold).normalize();
    const dLo = new THREE.Vector3().copy(S).addScaledVector(toT, dc).sub(E).normalize();
    this.aim(lower, bindLo, bindN2, dLo, n);
  }

  // ───────── colours, flashes, eyes, headgear ─────────

  private applyLook(f: FighterState, c: FighterColors, state: GameState, frame: number): void {
    const M = this.rig.materials;
    const tex = spacialTexture(frame);
    const regionColor: Record<Region, string> = {
      skin: c.skin,
      trunks: c.trunks,
      stripe: c.waistStripe || defaultWaistStripeColor(cssColorOf(c.trunks)),
      socks: c.socks || DEFAULT_SOCK_COLOR,
      glove: c.gloves,
      tape: c.gloveTape || "#eeeeee",
      shoe: c.shoes,
      laces: c.laces || defaultLaceColor(cssColorOf(c.shoes)),
      sole: c.soles || defaultSoleColor(cssColorOf(c.shoes)),
      headgear: f.isPlayer
        ? (c.headgear || DEFAULT_HEADGEAR_COLOR)
        : (SPARRING_HEADGEAR_BY_DIFFICULTY[state.aiDifficulty ?? ""] || c.headgear || DEFAULT_HEADGEAR_COLOR),
    };
    const key = Object.values(regionColor).join("|");
    if (key !== this.colorKey) {
      this.colorKey = key;
      for (const r of Object.keys(regionColor) as Region[]) {
        const col = regionColor[r];
        const spacial = r !== "skin" && isSpacial(col);
        M[r].color.set(spacial ? "#ffffff" : cssColorOf(col));
        setSpacial(M[r], spacial, tex);
      }
    } else if (tex) {
      for (const r of Object.keys(regionColor) as Region[]) if (M[r].userData.spacial) setSpacial(M[r], true, tex);
    }

    // Flashes, as emissive over the base colour.
    const crit = f.critHitTimer > 0;
    const block = f.blockFlashTimer > 0;
    const charge = f.chargeFlashTimer > 0 ? Math.min(1, f.chargeFlashTimer / 0.2) : 0;
    const hitPulse = f.isHit && !crit ? (Math.sin(performance.now() / 30) > 0 ? 0.25 : 0) : 0;
    for (const r of ["skin", "trunks", "stripe"] as Region[]) {
      const m = M[r];
      if (crit) m.emissive.copy(RED).multiplyScalar(r === "skin" ? 0.9 : 0.5);
      else if (charge > 0) m.emissive.copy(CHARGE).multiplyScalar(0.6 * charge);
      else m.emissive.copy(WHITE).multiplyScalar(hitPulse);
    }
    if (crit) M.glove.emissive.copy(RED).multiplyScalar(0.9);
    else if (block) M.glove.emissive.copy(WHITE).multiplyScalar(0.9);
    else M.glove.emissive.copy(BLACK);

    // Per-glove glow: telegraph pulse, charge, perfect block.
    const pbPlayer = f.perfectBlockState === "active";
    const pbAi = !pbPlayer && f.perfectBlockActive && (f.perfectBlockTimer ?? 0) > 0;
    const telePunch = f.telegraphPhase !== "none" ? f.telegraphPunchType : null;
    const chargedPunch = (f.isPunching && f.isCharging) ? f.currentPunch : (f.telegraphIsCharged ? telePunch : null);
    this.glow.forEach((g, i) => {
      const isLeft = i === 0;
      const mat = g.material as THREE.MeshBasicMaterial;
      let alpha = 0;
      if (pbPlayer || pbAi) {
        alpha = pbPlayer ? 0.55 : 0.14;
        mat.color.copy(PB_BLUE);
      }
      if (chargedPunch && LEFT_PUNCHES.has(chargedPunch) === isLeft) {
        alpha = Math.max(alpha, 0.5);
        mat.color.copy(f.chargeEmpoweredTimer > 0 ? EMPOWERED : CHARGE);
      } else if (telePunch && LEFT_PUNCHES.has(telePunch) === isLeft) {
        const tp = f.telegraphDuration > 0 ? Math.min(1, f.telegraphTimer / f.telegraphDuration) : 1;
        const pulse = 0.5 + 0.5 * Math.sin(f.telegraphTimer * (4 + tp * 8) * Math.PI * 2);
        alpha = Math.max(alpha, 0.18 + 0.2 * pulse);
        if (!(pbPlayer || pbAi)) mat.color.copy(WHITE);
      }
      mat.opacity = alpha;
      g.visible = alpha > 0.01;
    });

    // Eyes.
    const eyes = eyeState(f);
    for (const e of this.rig.eyes) {
      const base = e.userData.baseScale ?? (e.userData.baseScale = e.scale.clone());
      e.scale.copy(base);
      if (eyes === "closed") e.scale.y *= 0.15;
      else if (eyes === "squint") e.scale.y *= 0.45;
    }

    this.rig.headgear.visible = state.sparringMode === true;
  }

  dispose(): void {
    this.rig.dispose();
    this.glowGeo.dispose();
    for (const g of this.glow) (g.material as THREE.Material).dispose();
  }
}
