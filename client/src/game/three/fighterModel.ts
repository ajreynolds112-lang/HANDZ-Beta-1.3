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
  defaultLaceColor, defaultSoleColor, defaultGearDecalColor,
} from "../renderer";
import { BONE_NAMES, type BoneName, type Region, type RigInstance, createRig, fighterAssetEpoch } from "./fighterRig";
import { type PoseMemory, type PoseTargets, type RigDims, eyeState, newPoseMemory, newPoseTargets, solvePose } from "./fighterPose";
import { PB_VARIANTS, getGuardOffsets, getNoseLine, getPoseOffsets, pickPbVariant, shoulderRollEnabled, type PbVariant, type PoseOffsets } from "./poseOffsets";
import { PROFILE_VIEW_OPP_PX, activePunchProfile, type ActivePunchProfile } from "./punchProfiles";
import { createInitialState } from "../engine";
import { MAT_HEIGHT, toSceneX, toSceneYaw, toSceneZ } from "./worldMapping";
import { type BodyTilt, type KdMemory, applyKnockdownPose, newKdMemory } from "./knockdownPose";
import { maskedTintOf } from "./boxerBody";
import type { GloveHitBox } from "./gloveHitBox";
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
  const mt = maskedTintOf(mat);
  if (mt) { mt.spacialOn.value = on ? 1 : 0; mt.spacialMap.value = on ? tex : null; return; }
  const ls = mat.userData.linkedSpacial as { on: { value: number }; map: { value: THREE.Texture | null } } | undefined;
  if (ls) { ls.on.value = on ? 1 : 0; ls.map.value = on ? tex : null; mat.userData.spacial = on; return; }
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

/** Set a region's colour: textured gear tints through its mask, the textured skin through the rig. */
function setRegionColor(rig: RigInstance, r: Region, css: string): void {
  const mat = rig.materials[r];
  const linked = mat.userData.linkedTints as { value: THREE.Color }[] | undefined;
  if (linked) for (const u of linked) u.value.set(css);
  const mt = maskedTintOf(mat);
  if (mt) { mt.tint.value.set(css); mat.color.set("#ffffff"); return; }
  if (r === "skin" && rig.skinTone) { rig.skinTone(css); return; }
  mat.color.set(css);
}

const RED = new THREE.Color("#ff2222");
const CHARGE = new THREE.Color("#4a8cff");
const BLACK = new THREE.Color("#000000");

export class Fighter3D {
  readonly root = new THREE.Group();
  /**
   * Training minigames: rewrites the solved joint targets (body space) before
   * they are applied, e.g. a barbell press. Stance edits are skipped while set.
   */
  poseHook: ((pose: PoseTargets, dims: RigDims, dt: number) => void) | null = null;
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
  private lastT = -1;
  private armLens: [number, number][] = [];
  private legLens: [number, number][] = [];
  /** Editor previews: arms keep their bind length (in fights they stretch to reach the real hit range). */
  noStretch = false;
  /** Yaw the head so its nose line points at the opponent (off in Edit Poses, where the line is tuned). */
  aimHead = true;
  /** The opponent's model: its head centre is what the nose line aims at (else the opponent's position). */
  aimAt: Fighter3D | null = null;
  /** World head centre as of this fighter's last update (the nose line passes through it). */
  readonly headCenter = new THREE.Vector3();
  private headCenterValid = false;
  /** Smoothed nose-line aim correction (rad, + = left). */
  private aimYaw = 0;
  private aimLive = false;
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
    this.measureTorso(inv);
  }

  // ── hands never pass through the torso ──
  /** Torso slabs in bind body space, each riding its spine bone; gloves are spheres of gloveR. */
  private torso: { bone: BoneName; bind: THREE.Matrix4; y0: number; y1: number; cx: number; cz: number; d: number; w: number; back?: boolean }[] = [];
  private gloveR = 0.09;
  private headR = 0.1;
  /** Glove hit box half-extents (m) in each glove centre's local frame [left, right]. */
  readonly gloveHalf = [new THREE.Vector3(0.06, 0.06, 0.08), new THREE.Vector3(0.06, 0.06, 0.08)];
  private armPrev: (THREE.Quaternion[] | null)[] = [null, null];
  private armPen = [0, 0];
  private measureTorso(inv: THREE.Matrix4): void {
    const TORSO: BoneName[] = ["Hips", "Spine", "Spine1", "Spine2"];
    const pts: Partial<Record<BoneName, THREE.Vector3[]>> = {};
    const glove: number[] = [];
    const shoulders: THREE.Vector3[] = [];
    const head: number[] = [];
    const hc = this.rig.headgear.getWorldPosition(new THREE.Vector3()).applyMatrix4(inv);
    const gc = [this.rig.gloveCenter.left, this.rig.gloveCenter.right].map(o => o.getWorldPosition(new THREE.Vector3()).applyMatrix4(inv));
    const gl = [this.rig.gloveCenter.left, this.rig.gloveCenter.right].map(o => new THREE.Matrix4().copy(o.matrixWorld).invert());
    const ext: number[][][] = [[[], [], []], [[], [], []]];
    const lv = new THREE.Vector3();
    const canon = new Map<THREE.Object3D, BoneName>();
    for (const n of BONE_NAMES) canon.set(this.rig.bones[n], n);
    const v = new THREE.Vector3();
    this.rig.body.traverse(o => {
      const m = o as THREE.SkinnedMesh;
      if (!m.isSkinnedMesh || !m.geometry.attributes.skinIndex) return;
      const si = m.geometry.attributes.skinIndex, sw = m.geometry.attributes.skinWeight;
      for (let i = 0; i < si.count; i++) {
        let best = 0;
        for (let k = 1; k < 4; k++) if (sw.getComponent(i, k) > sw.getComponent(i, best)) best = k;
        const n = canon.get(m.skeleton.bones[si.getComponent(i, best)]);
        if (!n) continue;
        const side = n === "LeftHand" ? 0 : n === "RightHand" ? 1 : -1;
        const sh = n === "LeftShoulder" || n === "RightShoulder";
        if (side < 0 && !sh && n !== "Head" && !TORSO.includes(n)) continue;
        m.getVertexPosition(i, v).applyMatrix4(m.matrixWorld);
        if (side >= 0) { lv.copy(v).applyMatrix4(gl[side]); ext[side][0].push(Math.abs(lv.x)); ext[side][1].push(Math.abs(lv.y)); ext[side][2].push(Math.abs(lv.z)); }
        v.applyMatrix4(inv);
        if (side >= 0) glove.push(v.distanceTo(gc[side]));
        else if (n === "Head") head.push(v.distanceTo(hc));
        else if (sh) shoulders.push(v.clone());
        else if (n !== "Hips" || v.y > this.dims.hips.y - 0.1) (pts[n] ??= []).push(v.clone());
      }
    });
    const pct = (a: number[], q: number) => { a.sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor(q * a.length))]; };
    this.torso = [];
    // Upper back (shoulder-blade/trap verts, riding Spine2): tested behind the axis only, so guards are untouched.
    if (shoulders.length >= 20) pts.Neck = shoulders;
    for (const n of [...TORSO, "Neck" as BoneName]) {
      const a = pts[n];
      if (!a || a.length < 20) continue;
      const fx = pct(a.map(p => p.x), 0.95), bx = pct(a.map(p => p.x), 0.05);
      const rz = pct(a.map(p => p.z), 0.95), lz = pct(a.map(p => p.z), 0.05);
      this.torso.push({
        bone: n === "Neck" ? "Spine2" : n, back: n === "Neck", bind: new THREE.Matrix4().copy(inv).multiply(this.rig.bones[n === "Neck" ? "Spine2" : n].matrixWorld),
        y0: pct(a.map(p => p.y), 0.02), y1: pct(a.map(p => p.y), 0.98),
        cx: (fx + bx) / 2, cz: (rz + lz) / 2, d: (fx - bx) / 2, w: (rz - lz) / 2,
      });
    }
    if (!this.torso.length) {
      // Code rig (no skinned body): one slab from the trunks to the shoulders.
      this.torso.push({ bone: "Spine1", bind: new THREE.Matrix4().copy(inv).multiply(this.rig.bones.Spine1.matrixWorld),
        y0: this.dims.hips.y - 0.08, y1: this.dims.shoulder[0].y, cx: 0, cz: 0, d: 0.12, w: 0.16 });
    }
    if (glove.length > 20) this.gloveR = pct(glove, 0.5);
    ext.forEach((e, s) => { if (e[0].length > 20) this.gloveHalf[s].set(pct(e[0], 0.95), pct(e[1], 0.95), pct(e[2], 0.95)); });
    if (head.length > 20) this.headR = pct(head, 0.6);
    this.armPrev = [null, null];
    this.armPrevO = [null, null];
  }
  private _tm = new THREE.Matrix4();
  private _tb = new THREE.Matrix4();
  private _tp = new THREE.Vector3();
  private _push = new THREE.Vector3();
  private _tq = new THREE.Quaternion();
  private _tg = new THREE.Matrix4();
  private _tv = new THREE.Vector3();
  private _tp2 = new THREE.Vector3();
  /** How far glove `side` sits inside `o`'s torso (0 = clear, 1 = at its axis); _push = world move that would put it on the surface. bodyInv = o's body inverse. */
  private torsoPen(side: 0 | 1, bodyInv: THREE.Matrix4, o: Fighter3D = this): number {
    const g = (side ? this.rig.gloveCenter.right : this.rig.gloveCenter.left).getWorldPosition(this._tp).applyMatrix4(bodyInv);
    const gx = g.x, gy = g.y, gz = g.z;
    const r = this.gloveR;
    let pen = 0;
    for (const t of o.torso) {
      // Back into the slab's bind frame: bind · current⁻¹.
      this._tm.copy(bodyInv).multiply(o.rig.bones[t.bone].matrixWorld).invert().premultiply(t.bind);
      const p = this._tp.set(gx, gy, gz).applyMatrix4(this._tm);
      if (p.y < t.y0 || p.y > t.y1) continue;
      const a = t.d + r, b = t.w + r, dx = p.x - t.cx, dz = p.z - t.cz;
      let ux: number, uz: number, depth: number;
      if (dx < 0) {
        // Behind the axis (anywhere back there within the torso's width): never out the back, always out the nearer side.
        const az = Math.abs(dz);
        if (az >= b || 1 - az / b <= pen) continue;
        pen = 1 - az / b;
        ux = 0; uz = az > 1e-6 ? Math.sign(dz) : side ? 1 : -1;
        depth = b - az + 0.003;
      } else {
        if (t.back) continue;
        const e = Math.hypot(dx / a, dz / b);
        if (e >= 1 || 1 - e <= pen) continue;
        pen = 1 - e;
        // Straight out from the slab's axis, by the depth along that line (+3mm).
        const len = Math.hypot(dx, dz);
        ux = len > 1e-6 ? dx / len : 1; uz = len > 1e-6 ? dz / len : 0;
        depth = pen / Math.hypot(ux / a, uz / b) + 0.003;
      }
      this._push.set(ux * depth, 0, uz * depth).transformDirection(this._tm.invert().premultiply(o.rig.body.matrixWorld)).multiplyScalar(depth);
    }
    return pen;
  }
  /** How far (m, per face) glove `side`'s hit box is from o's head or front torso; <= 0 = touching. */
  gloveGap(side: 0 | 1, o: Fighter3D, box: GloveHitBox): number {
    const gc = side ? this.rig.gloveCenter.right : this.rig.gloveCenter.left;
    const h = box.s;
    const gInv = this._tg.copy(gc.matrixWorld).invert();
    const qInv = this._tq.copy(box.q).invert();
    // How far (per face) the hit box must grow to reach world point q.
    const grow = (q: THREE.Vector3) => { q.applyMatrix4(gInv).applyQuaternion(qInv).sub(box.c); return Math.max(Math.abs(q.x) - h.x, Math.abs(q.y) - h.y, Math.abs(q.z) - h.z); };
    let gap = o.headCenterValid ? grow(this._tv.copy(o.headCenter)) - o.headR : Infinity;
    const bodyInv = this._tb.copy(o.rig.body.matrixWorld).invert();
    const g = gc.getWorldPosition(this._tp2).applyMatrix4(bodyInv);
    for (const t of o.torso) {
      if (t.back) continue;
      this._tm.copy(bodyInv).multiply(o.rig.bones[t.bone].matrixWorld).invert().premultiply(t.bind);
      const p = this._tp.copy(g).applyMatrix4(this._tm);
      const dx = p.x - t.cx, dz = p.z - t.cz, len = Math.hypot(dx, dz);
      const r = len > 1e-6 ? 1 / Math.hypot(dx / len / t.d, dz / len / t.w) : 0;
      if (len <= r && p.y >= t.y0 && p.y <= t.y1) { gap = Math.min(gap, -0.05); continue; }
      // Nearest torso surface point, back to world.
      const k = len > r ? r / len : 1;
      p.set(t.cx + dx * k, Math.min(t.y1, Math.max(t.y0, p.y)), t.cz + dz * k)
        .applyMatrix4(this._tm.invert()).applyMatrix4(o.rig.body.matrixWorld);
      gap = Math.min(gap, grow(p));
    }
    return gap;
  }
  private armPrevO: (THREE.Quaternion[] | null)[] = [null, null];
  /** The punch profile playing has self-collision off: the own-torso pass only tracks its baseline. */
  private selfCollideOff = false;
  private armPenO = [0, 0];
  /**
   * Hands never go into a torso (own, or the opponent's after both are posed): an arm
   * moving in stops where its glove touches; a torso moving in swings the arm out.
   */
  keepHandsOut(o: Fighter3D = this): void {
    const self = o === this;
    const body = o.rig.body;
    body.updateMatrixWorld(true);
    const bodyInv = this._tb.copy(body.matrixWorld).invert();
    const prevs = self ? this.armPrev : this.armPrevO, pens = self ? this.armPen : this.armPenO;
    ([0, 1] as const).forEach(side => {
      const chain = Fighter3D.ARM_CHAIN.map(j => this.bind[`${side ? "Right" : "Left"}${j}` as BoneName].bone);
      const cur = chain.map(b => b.quaternion.clone());
      let pen = this.torsoPen(side, bodyInv, o);
      if (self && this.selfCollideOff) { prevs[side] = cur; pens[side] = pen; return; }
      const prev = prevs[side];
      if (prev && pen > pens[side] + 1e-4) {
        // The shoulder joint (clavicle, i = 0) is never held back: it may enter its own torso.
        const set = (k: number) => { chain.forEach((b, i) => { if (i) b.quaternion.slerpQuaternions(prev[i], cur[i], k); }); chain[0].updateMatrixWorld(true); };
        let lo = 0, hi = 1;
        for (let it = 0; it < 6; it++) {
          const mid = (lo + hi) / 2;
          set(mid);
          if (this.torsoPen(side, bodyInv, o) > pens[side]) hi = mid; else lo = mid;
        }
        set(lo);
        pen = this.torsoPen(side, bodyInv, o);
      }
      // Still inside (the torso moved, or it started there): swing the upper arm until the glove sits on the surface.
      const arm = chain[1], glove = side ? this.rig.gloveCenter.right : this.rig.gloveCenter.left;
      for (let it = 0; it < 6 && pen > 0; it++) {
        const sh = arm.getWorldPosition(new THREE.Vector3());
        const v1 = glove.getWorldPosition(new THREE.Vector3()).sub(sh);
        const v2 = v1.clone().add(this._push);
        this._tq.setFromUnitVectors(v1.normalize(), v2.normalize());
        const parentQ = arm.parent!.getWorldQuaternion(new THREE.Quaternion());
        arm.quaternion.copy(parentQ.clone().invert().multiply(this._tq).multiply(arm.getWorldQuaternion(new THREE.Quaternion())));
        arm.updateMatrixWorld(true);
        pen = this.torsoPen(side, bodyInv, o);
      }
      prevs[side] = chain.map(b => b.quaternion.clone());
      pens[side] = pen;
      if (!self) {
        // The arm moved after the self pass: it is next frame's baseline there too.
        this.armPrev[side] = prevs[side];
        this.armPen[side] = this.torsoPen(side, this._tb.copy(this.rig.body.matrixWorld).invert());
        this._tb.copy(body.matrixWorld).invert();
      }
    });
  }


  update(f: FighterState, colors: FighterColors, opponent: FighterState | null, state: GameState, frame: number, epoch = 0): void {
    if (fighterAssetEpoch() !== this.epoch) this.build();
    const now = performance.now() / 1000;
    const dt = this.lastT < 0 ? 1 / 60 : now - this.lastT;
    this.lastT = now;
    const gStance = Math.max(0, Math.min(2, Math.round(f.guardStance ?? 0)));
    this.updateGuardWeights(f, opponent, gStance, dt);
    this.ensureGuardRef(this.mem.stanceBlend >= 0.5, gStance);

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
    // A profiled punch is animated from scratch: the solve holds the guard (no
    // stock punch motion) and the profile's keyframes do all the moving.
    // Sliding back blends that guard in from the held Loop Start pose.
    // Auto motion on: the keyframes ride on the stock punch instead.
    const solveF = !prof ? f : !prof.auto ? guardOnly(f) : sliding ? { ...f, isPunching: false, currentPunch: null } : prof.fighter;
    const backArms = this.backSlipArms(f, solveF, opponent, prof, sliding, dt);
    solvePose(solveF, this.dims, this.mem, { opponent, dt, snapPunch: !!prof && !sliding, hipHeight: prof && !sliding ? prof.height * prof.guardIn : 0 }, this.pose);
    if (this.poseHook) this.poseHook(this.pose, this.dims, dt);
    // Knockdown fall / canvas / get-up, layered over the standing solve.
    if (applyKnockdownPose(f, state, this.dims, this.kd, dt, epoch, this.pose, this.tilt)) {
      this.rig.body.quaternion.copy(this.tilt.q);
      this.rig.body.position.copy(this.tilt.pos);
    } else {
      this.rig.body.quaternion.identity();
      this.rig.body.position.set(0, 0, 0);
    }
    this.applyPose();
    this.arm0 = prof && !sliding && !f.isKnockedDown && !this.poseHook ? this.armsAtGuard0(prof, backArms, this.mem) : null;
    if (!f.isKnockedDown && !this.poseHook) this.applyStanceOffsets(f, this.mem);
    if (backArms) this.restoreArmLocals(backArms);
    const locks = this.applyGuardLocks(f, prof, dt);
    if (prof && !sliding) this.applyProfile(prof, locks);
    if (sliding) this.blendFromSlide(prof!.slide);
    this.preSlide = !!prof && !sliding;
    this.applyHeadYaw(f, opponent, dt);
    this.selfCollideOff = !!prof && !prof.selfCollide;
    this.keepHandsOut();
    this.applyLook(f, colors, state, frame);
    if (f.isKnockedDown) {
      for (const e of this.rig.eyes) e.scale.y = e.userData.baseScale.y * 0.15;
      this.rig.setEyes?.("closed");
    }
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
      this.rig.setRefereeMode?.();
      setRegionColor(this.rig, "skin", cssColorOf(colors.skin));
      setRegionColor(this.rig, "glove", cssColorOf(colors.skin));
      setRegionColor(this.rig, "tape", cssColorOf(colors.skin));
      for (const r of ["trunks", "stripe", "socks", "shoe", "laces", "sole", "decal"] as Region[]) setRegionColor(this.rig, r, "#141416");
      for (const r of Object.keys(M) as Region[]) { M[r].emissive.copy(BLACK); setSpacial(M[r], false, null); }
    }
    this.rig.headgear.visible = false;
    if (this.rig.girdle) this.rig.girdle.visible = false;
  }

  // ── nose line ──
  private _nq = new THREE.Quaternion();
  private _nq2 = new THREE.Quaternion();
  private _ne = new THREE.Euler();
  private _nd = new THREE.Vector3();
  private static readonly UP = new THREE.Vector3(0, 1, 0);
  private static readonly AIM_MAX = Math.PI / 6;

  /**
   * The nose line in world space: through the head centre, along the head's
   * facing (bind corrected) turned by the Edit Poses nose-line rotation.
   */
  noseRay(origin: THREE.Vector3, dir: THREE.Vector3): void {
    const head = this.rig.bones.Head;
    const q = head.getWorldQuaternion(this._nq).multiply(this._nq2.copy(this.bind.Head.bodyQ).invert());
    const fix = this.rig.bindFix?.Head;
    if (fix) q.multiply(this._nq2.copy(fix).invert());
    const r = getNoseLine(this.mem.stanceBlend >= 0.5), D = THREE.MathUtils.DEG2RAD;
    q.multiply(this._nq2.setFromEuler(this._ne.set(r[0] * D, r[1] * D, r[2] * D, "YXZ")));
    dir.set(1, 0, 0).applyQuaternion(q);
    this.rig.headgear.getWorldPosition(origin);
  }

  /** Premultiply a bone's world rotation by a yaw about the world vertical. */
  private yawBone(bone: THREE.Object3D, yaw: number): void {
    const P = bone.parent!.getWorldQuaternion(this._nq);
    const R = this._nq2.setFromAxisAngle(Fighter3D.UP, yaw);
    // local' = P⁻¹·R·P·local
    bone.quaternion.premultiply(R.premultiply(P.clone().invert()).multiply(P));
  }

  /**
   * Standing: yaw the head (neck takes 40%) so the nose line's horizontal
   * direction points at the opponent's head centre, at most 30° off the solved
   * pose, never pitching. Then the hit turn (crit snap / hook) goes on top.
   */
  private applyHeadYaw(f: FighterState, opponent: FighterState | null, dt: number): void {
    let yaw = 0;
    if (f.isKnockedDown) { this.aimLive = false; this.aimYaw = 0; }
    else {
      let tx: number | null = null, tz = 0;
      if (this.aimAt?.headCenterValid) { tx = this.aimAt.headCenter.x; tz = this.aimAt.headCenter.z; }
      else if (opponent) { tx = toSceneX(opponent.x); tz = toSceneZ(opponent.z); }
      if (this.aimHead && tx !== null) {
        const c = this._x, d = this._nd;
        this.noseRay(c, d);
        let err = 0;
        if (Math.hypot(d.x, d.z) > 0.05) {
          const cur = Math.atan2(-d.z, d.x), want = Math.atan2(-(tz - c.z), tx - c.x);
          err = Math.atan2(Math.sin(want - cur), Math.cos(want - cur));
          err = Math.max(-Fighter3D.AIM_MAX, Math.min(Fighter3D.AIM_MAX, err));
        }
        this.aimYaw = this.aimLive ? this.aimYaw + (err - this.aimYaw) * (1 - Math.exp(-Math.max(0, dt) * 25)) : err;
        this.aimLive = true;
      } else { this.aimLive = false; this.aimYaw = 0; }
      yaw = this.aimYaw + (this.pose.headTurnYaw || 0);
    }
    if (Math.abs(yaw) > 1e-5) {
      this.yawBone(this.rig.bones.Neck, yaw * 0.4);
      this.yawBone(this.rig.bones.Head, yaw * 0.6);
    }
    this.rig.headgear.getWorldPosition(this.headCenter);
    this.headCenterValid = true;
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
  private captureSlideFrom(prof: ActivePunchProfile, opponent: FighterState | null): void {
    // Played straight into the slide: the bones still hold the last frame — exactly
    // the pose at Loop Start, springs and all. Jumped in (scrub): solve it fresh.
    if (!this.preSlide) {
      const scratch: PoseMemory = JSON.parse(JSON.stringify(this.mem));
      solvePose(prof.auto ? prof.fighter : guardOnly(prof.fighter), this.dims, scratch, { opponent, dt: 1, snapPunch: !prof.auto, hipHeight: prof.height * prof.guardIn }, this.pose);
      this.rig.body.quaternion.identity();
      this.rig.body.position.set(0, 0, 0);
      this.applyPose();
      this.arm0 = this.armsAtGuard0(prof, null, scratch);
      this.applyStanceOffsets(prof.fighter, scratch);
      const locks = this.applyGuardLocks(prof.fighter, prof, 0, scratch, true);
      this.applyProfile(prof, locks, scratch);
    }
    this.slideFrom = this.snapBones();
  }
  /**
   * The profile's keyframes on top of the guard the solve left on the bones.
   * Keyframes are authored on the editor's normal guard, so (keyframes alone) the
   * free arm joints are first moved from the fighter's current guard (full guard
   * blends in by guardBlend) onto that normal guard, then the offsets go on: the
   * punch looks as authored in either guard. The offsets are the Full Guard On
   * and Off animations blended by guardBlend. Over the Full Guard Slide the whole
   * pose eases from the current guard into that animation (shortest arc per joint).
   */
  private applyProfile(prof: ActivePunchProfile, locks: Partial<Record<BoneName, number>>, mem: PoseMemory = this.mem): void {
    const w = Math.max(0, Math.min(1, prof.guardIn));
    const from = w < 1 ? this.snapBones() : null;
    const ref = this.guardRef;
    const g = Math.max(0, Math.min(1, prof.fighter.guardBlend || 0));
    const a0 = this.arm0;
    if (ref && g > 0 && (!prof.auto || a0)) {
      (["Left", "Right"] as const).forEach((s, side) => {
        Fighter3D.ARM_CHAIN.forEach((j, n) => {
          const name = `${s}${j}` as BoneName;
          const free = 1 - (locks[name] ?? 0);
          if (free <= 0) return;
          if (a0) {
            // Secondary/Third: free joints take exactly what the Full Guard would give them.
            if (prof.auto) this._oq.copy(a0[side][n]);
            else this._oq.slerpQuaternions(ref.q[0][side][n], ref.q[2][side][n], g).invert().multiply(ref.q[0][side][n]).premultiply(a0[side][n]);
            this.bind[name].bone.quaternion.slerp(this._oq, free);
            return;
          }
          // Live ≈ guard(g); live · guard(g)⁻¹ · guard(0) = the normal guard, keeping live detail.
          this._oq.slerpQuaternions(ref.q[0][side][n], ref.q[1][side][n], g).invert().multiply(ref.q[0][side][n]);
          this._ob.identity().slerp(this._oq, free);
          this.bind[name].bone.quaternion.multiply(this._ob);
        });
      });
    }
    this.applyPoseOffsets(unlockedOffsets(prof.offsets, locks), false, mem, 1, prof.isolate);
    if (from) {
      BONE_NAMES.forEach((n, i) => {
        const bone = this.bind[n].bone;
        this._oq.copy(from.q[i]).slerp(bone.quaternion, w);
        bone.quaternion.copy(this._oq);
      });
    }
    this.bind.Hips.bone.updateMatrixWorld(true);
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
   * The Edit Poses stance set (mirrored for a southpaw; its arms slid toward the
   * full guard's own arm set by the guard blend), then the duck layer
   * weighted by the (delayed) crouch depth. The duck layer holds legs and torso
   * only; the arms keep their joint rotations and ride the torso.
   */
  /** Full-guard stance weights (slide on a Tab change) and perfect block pose weights. */
  private stanceW = [1, 0, 0];
  private pbW: Partial<Record<PbVariant, number>> = {};
  private updateGuardWeights(f: FighterState, opponent: FighterState | null, stance: number, dt: number): void {
    const ease = (w: number, t: number, rate: number) => {
      const n = w + (t - w) * (1 - Math.exp(-Math.max(0, dt) * rate));
      return Math.abs(n - t) < 0.002 ? t : n;
    };
    this.stanceW = this.stanceW.map((w, i) => ease(w, i === stance ? 1 : 0, 12));
    // Fighting style: each perfect block / shoulder roll pose can come from any guard.
    const src = f.defenseStance;
    const up = f.pbPreview != null || (!f.isKnockedDown && (f.perfectBlockState === "rising" || f.perfectBlockState === "active"
      || (f.perfectBlockActive && f.perfectBlockTimer > 0)));
    // X held in full guard plays this guard's Shoulder Roll slot (when active), over any perfect block.
    const roll = f.pbPreview == null && !f.isKnockedDown && !!f.shoulderRolling && shoulderRollEnabled(stance, src);
    const v = roll ? "shoulderRoll" : f.pbPreview ?? pickPbVariant(opponent?.isPunching ? opponent.currentPunch : null, this.mem.stanceBlend >= 0.5, stance, src);
    for (const x of PB_VARIANTS) {
      const w = ease(this.pbW[x] ?? 0, (up || roll) && x === v ? 1 : 0, 20);
      if (w > 0) this.pbW[x] = w; else delete this.pbW[x];
    }
  }
  private applyStanceOffsets(f: FighterState, mem: PoseMemory): void {
    const southpaw = mem.stanceBlend >= 0.5;
    this.applyPoseOffsets(getGuardOffsets(southpaw, f.guardBlend || 0, this.stanceW, this.pbW, f.defenseStance), true, mem);
    const dp = Math.max(0, Math.min(1, f.duckProgress || 0));
    if (dp <= 0) return;
    const duck = getPoseOffsets("duck", southpaw);
    let any = false;
    for (const k in duck) { any = true; break; }
    if (!any) return;
    this.applyPoseOffsets(duck, true, mem, dp);
  }

  /** Secondary/Third profiled punch: the arm locals the Full Guard's stance edits would leave (null otherwise). */
  private arm0: THREE.Quaternion[][] | null = null;
  private armsAtGuard0(prof: ActivePunchProfile, backArms: (THREE.Quaternion[] | null)[] | null, mem: PoseMemory): THREE.Quaternion[][] | null {
    const f = prof.fighter;
    if (Math.round(f.guardStance ?? 0) < 1 || !((f.guardBlend || 0) > 0)) return null;
    const snap = this.snapBones();
    const w = this.stanceW;
    this.stanceW = [1, 0, 0];
    this.applyStanceOffsets(f, mem);
    this.stanceW = w;
    if (backArms) this.restoreArmLocals(backArms);
    const out = (["Left", "Right"] as const).map(s => Fighter3D.ARM_CHAIN.map(j => this.bind[`${s}${j}` as BoneName].bone.quaternion.clone()));
    BONE_NAMES.forEach((n, i) => this.bind[n].bone.quaternion.copy(snap.q[i]));
    this.bind.Hips.bone.position.copy(snap.hips);
    this.bind.Hips.bone.updateMatrixWorld(true);
    return out;
  }
  private static readonly ARM_CHAIN = ["Shoulder", "Arm", "ForeArm", "Hand"] as const;
  private backPose: PoseTargets = newPoseTargets();
  /**
   * A backward slip leans the chest but never changes the shoulders or the bend
   * in the arms: the arms are solved as if there were no backward lean, and
   * their local joint rotations (shoulder down) are kept, so they ride the
   * leaning chest rigidly. A punching arm is left to aim at its target.
   * Returns the local rotations per side (null = leave that arm), or null when
   * there is no backward slip.
   */
  private backSlipArms(f: FighterState, solveF: FighterState, opponent: FighterState | null,
    prof: { height: number } | null, sliding: boolean, dt: number): (THREE.Quaternion[] | null)[] | null {
    if (f.isKnockedDown || this.poseHook || (f.slipLean || 0) <= 0.001) return null;
    const sd = SLIP_BACK_DIR[f.slipLeanDir];
    if (!sd) return null;
    const c = Math.cos(f.facingAngle), sn = Math.sin(f.facingAngle);
    if (sd.x * c + sd.z * sn >= 0) return null; // no backward component
    const scratch: PoseMemory = JSON.parse(JSON.stringify(this.mem));
    const keep = this.pose;
    this.pose = this.backPose;
    solvePose(solveF, this.dims, scratch, { opponent, dt, snapPunch: !!prof && !sliding, hipHeight: prof && !sliding ? prof.height : 0, dropBackSlip: true }, this.pose);
    this.rig.body.quaternion.identity();
    this.rig.body.position.set(0, 0, 0);
    this.applyPose();
    this.applyStanceOffsets(f, scratch);
    this.pose = keep;
    return (["Left", "Right"] as const).map((s, i) =>
      scratch.armPunch[i] && scratch.armExt[i] > 0 ? null
        : Fighter3D.ARM_CHAIN.map(j => this.bind[`${s}${j}` as BoneName].bone.quaternion.clone()));
  }
  private restoreArmLocals(held: (THREE.Quaternion[] | null)[]): void {
    (["Left", "Right"] as const).forEach((s, i) => {
      const q = held[i];
      if (!q) return;
      Fighter3D.ARM_CHAIN.forEach((j, k) => this.bind[`${s}${j}` as BoneName].bone.quaternion.copy(q[k]));
    });
    this.bind.Hips.bone.updateMatrixWorld(true);
  }

  // ── Full Guard Follow ──
  /**
   * The arm joints' local rotations (Shoulder → Hand, per side) exactly as the
   * Edit Poses editor shows them: [normal guard, full guard, the Full Guard's full guard]. Rebuilt when the
   * stance set, the stance or the rig changes.
   */
  private guardRef: { key: string; offs: PoseOffsets; full: PoseOffsets; full0: PoseOffsets; q: THREE.Quaternion[][][] } | null = null;
  private guardPose: PoseTargets = newPoseTargets();
  private lockW: Partial<Record<BoneName, number>> = {};
  private ensureGuardRef(southpaw: boolean, stance: number): void {
    const offs = getPoseOffsets("stance", southpaw);
    const full = getGuardOffsets(southpaw, 1, [0, 1, 2].map(i => (i === stance ? 1 : 0)));
    const full0 = getGuardOffsets(southpaw, 1, [1, 0, 0]);
    const key = `${this.epoch}|${southpaw}`;
    if (this.guardRef && this.guardRef.key === key && this.guardRef.offs === offs && this.guardRef.full === full && this.guardRef.full0 === full0) return;
    const st = createInitialState();
    const a = st.player, d = st.enemy;
    a.x = 400; a.z = 300; a.facingAngle = 0;
    d.x = a.x + PROFILE_VIEW_OPP_PX; d.z = 300; d.facingAngle = Math.PI;
    a.boxingStance = (southpaw ? "southpaw" : "orthodox") as typeof a.boxingStance;
    a.defenseState = "none"; a.duckProgress = 0; a.isPunching = false; a.currentPunch = null;
    const keepPose = this.pose, keepStretch = this.stretchOff;
    this.pose = this.guardPose;
    this.stretchOff = true;
    const q = [0, 1, 2].map(g => {
      a.guardBlend = Math.min(1, g);
      const mem = newPoseMemory();
      solvePose(a, this.dims, mem, { opponent: d, dt: 1 }, this.pose);
      this.rig.body.quaternion.identity();
      this.rig.body.position.set(0, 0, 0);
      this.applyPose();
      this.applyPoseOffsets(g === 2 ? full0 : g ? full : offs, true, mem);
      return (["Left", "Right"] as const).map(s => Fighter3D.ARM_CHAIN.map(j => this.bind[`${s}${j}` as BoneName].bone.quaternion.clone()));
    });
    this.pose = keepPose;
    this.stretchOff = keepStretch;
    this.guardRef = { key, offs, full, full0, q };
  }
  /**
   * Hold joints at their Edit Poses guard rotation (full guard or normal guard,
   * by the fighter's guard blend) while the body animates around them. A stock
   * punch holds the whole non-punching arm; a profiled punch holds the joints
   * its profile marks. Returns each held joint's weight (eased in and out).
   */
  private applyGuardLocks(f: FighterState, prof: { guardLock: BoneName[] } | null, dt: number, mem: PoseMemory = this.mem, snap = false): Partial<Record<BoneName, number>> {
    const ref = this.guardRef;
    const target = new Set<BoneName>();
    if (!f.isKnockedDown && !this.poseHook && ref) {
      if (prof) prof.guardLock.forEach(b => target.add(b));
      else {
        (["Left", "Right"] as const).forEach((s, i) => {
          if (mem.armPunch[1 - i] && !mem.armPunch[i]) Fighter3D.ARM_CHAIN.forEach(j => target.add(`${s}${j}` as BoneName));
        });
      }
    }
    const g = Math.max(0, Math.min(1, f.guardBlend || 0));
    const k = snap ? 1 : 1 - Math.exp(-Math.max(0, dt) * 20);
    const out: Partial<Record<BoneName, number>> = {};
    (["Left", "Right"] as const).forEach((s, side) => {
      Fighter3D.ARM_CHAIN.forEach((j, n) => {
        const name = `${s}${j}` as BoneName;
        const want = target.has(name) ? 1 : 0;
        let w = this.lockW[name] ?? 0;
        w += (want - w) * k;
        if (Math.abs(w - want) < 0.002) w = want;
        if (!snap) this.lockW[name] = w;
        if (w <= 0 || !ref) return;
        out[name] = w;
        this._oq.slerpQuaternions(ref.q[0][side][n], ref.q[1][side][n], g);
        this.bind[name].bone.quaternion.slerp(this._oq, w);
      });
    });
    this.bind.Hips.bone.updateMatrixWorld(true);
    return out;
  }
  /**
   * Hand-edited joint rotations (Edit Poses), about the body axes, root → leaf
   * so a joint carries its children. With fadeWithPunch a punching arm's offsets
   * fade out with its extension (stance edits); punch profiles apply in full.
   */
  /** isolate: each joint turns only itself; its children keep their body-space orientation. */
  private applyPoseOffsets(offs: PoseOffsets, fadeWithPunch: boolean, mem: PoseMemory = this.mem, weight = 1, isolate = false): void {
    let any = false;
    for (const k in offs) { any = true; break; }
    if (!any) return;
    const bodyInv = this.rig.body.getWorldQuaternion(this._ob).invert();
    const bodyQ = (o: THREE.Object3D) => o.getWorldQuaternion(new THREE.Quaternion()).premultiply(bodyInv);
    const before = isolate ? BONE_NAMES.map(n => bodyQ(this.bind[n].bone)) : null;
    const moved = new Set<THREE.Object3D>();
    for (let i = 0; i < BONE_NAMES.length; i++) {
      const name = BONE_NAMES[i];
      const r = offs[name];
      if (before) {
        const bone = this.bind[name].bone;
        let a = bone.parent;
        while (a && a !== this.rig.body && !moved.has(a)) a = a.parent;
        const carried = !!a && a !== this.rig.body;
        if (!r && !carried) continue;
        // Target = own offset on the pre-offset orientation; local = parent⁻¹ · target.
        const T = before[i].clone();
        if (r) T.premultiply(this._oq.setFromEuler(this._oe.set(r[0] * weight * THREE.MathUtils.DEG2RAD, r[1] * weight * THREE.MathUtils.DEG2RAD, r[2] * weight * THREE.MathUtils.DEG2RAD, "YXZ")));
        bone.quaternion.copy(bodyQ(bone.parent!).invert().multiply(T));
        moved.add(bone);
        continue;
      }
      if (!r) continue;
      const armSide = name.startsWith("Left") && /Shoulder|Arm|Hand/.test(name) ? 0
        : name.startsWith("Right") && /Shoulder|Arm|Hand/.test(name) ? 1 : -1;
      // Also fades while this glove covers the face for the other hand's punch.
      const other = armSide === 0 ? 1 : 0;
      const cover = armSide >= 0 && mem.armPunch[other] ? mem.motCover?.[other] ?? 0 : 0;
      const w = weight * (fadeWithPunch && armSide >= 0 ? 1 - Math.min(1, Math.max(mem.armExt[armSide as 0 | 1] || 0, cover)) : 1);
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
      stripe: c.trunks,
      decal: c.gearDecal || defaultGearDecalColor(),
      socks: c.socks || DEFAULT_SOCK_COLOR,
      glove: c.gloves,
      tape: c.gloveTape || "#eeeeee",
      shoe: c.shoes,
      laces: c.laces || defaultLaceColor(cssColorOf(c.shoes)),
      sole: c.soles || defaultSoleColor(cssColorOf(c.shoes)),
      headgear: f.isPlayer
        ? (c.headgear || DEFAULT_HEADGEAR_COLOR)
        : (SPARRING_HEADGEAR_BY_DIFFICULTY[state.aiDifficulty ?? ""] || c.headgear || DEFAULT_HEADGEAR_COLOR),
      // Partners wear a girdle matching their headgear.
      girdle: f.isPlayer
        ? (c.girdle || DEFAULT_HEADGEAR_COLOR)
        : (SPARRING_HEADGEAR_BY_DIFFICULTY[state.aiDifficulty ?? ""] || c.girdle || DEFAULT_HEADGEAR_COLOR),
      girdleLaces: f.isPlayer ? (c.girdleLaces || "#f2f2f2") : "#f2f2f2",
    };
    const key = Object.values(regionColor).join("|");
    if (key !== this.colorKey) {
      this.colorKey = key;
      for (const r of Object.keys(regionColor) as Region[]) {
        const col = regionColor[r];
        const spacial = r !== "skin" && isSpacial(col);
        setRegionColor(this.rig, r, spacial && !M[r].userData.linkedTints ? "#ffffff" : cssColorOf(col));
        setSpacial(M[r], spacial, tex);
      }
    } else if (tex) {
      for (const r of Object.keys(regionColor) as Region[]) if (M[r].userData.spacial) setSpacial(M[r], true, tex);
    }

    // Flashes, as emissive over the base colour.
    const crit = f.critHitTimer > 0;
    const charge = f.chargeFlashTimer > 0 ? Math.min(1, f.chargeFlashTimer / 0.2) : 0;
    for (const r of ["skin", "trunks", "stripe"] as Region[]) {
      const m = M[r];
      if (crit) m.emissive.copy(RED).multiplyScalar(r === "skin" ? 0.9 : 0.5);
      else if (charge > 0) m.emissive.copy(CHARGE).multiplyScalar(0.6 * charge);
      else m.emissive.copy(BLACK);
    }
    // Gloves never glow.
    M.glove.emissive.copy(BLACK);

    // Eyes.
    const eyes = eyeState(f);
    for (const e of this.rig.eyes) {
      const base = e.userData.baseScale ?? (e.userData.baseScale = e.scale.clone());
      e.scale.copy(base);
      if (eyes === "closed") e.scale.y *= 0.15;
      else if (eyes === "squint") e.scale.y *= 0.45;
    }
    this.rig.setEyes?.(eyes);

    const gear = state.sparringMode === true || f.wearsSparringGear === true;
    this.rig.headgear.visible = gear;
    if (this.rig.girdle) this.rig.girdle.visible = gear;
  }

  dispose(): void {
    this.rig.dispose();
  }
}

/** The fighter as the pose solve should see it under a profiled punch: no stock punch or telegraph motion. */
/** World slip directions (same table the pose solver leans along). */
const SLIP_BACK_DIR: Record<string, { x: number; z: number }> = {
  left: { x: -1, z: 0 }, right: { x: 1, z: 0 }, forward: { x: 0, z: -1 }, back: { x: 0, z: 1 },
};

/** Profile offsets minus what the guard-held joints give up (a fully held joint takes none). */
function unlockedOffsets(offs: PoseOffsets, locks: Partial<Record<BoneName, number>>): PoseOffsets {
  let any = false;
  for (const k in locks) { any = true; break; }
  if (!any) return offs;
  const out: PoseOffsets = {};
  for (const [b, r] of Object.entries(offs) as [BoneName, [number, number, number]][]) {
    const keep = 1 - (locks[b] ?? 0);
    if (keep > 0.001) out[b] = keep >= 1 ? r : [r[0] * keep, r[1] * keep, r[2] * keep];
  }
  return out;
}

function guardOnly(f: FighterState): FighterState {
  return { ...f, isPunching: false, currentPunch: null, isFeinting: false, telegraphPhase: "none", telegraphPunchType: null };
}
