/**
 * Boxer rigs for the 3D view: one skeleton interface, two ways to build it.
 *
 * - The Tripo body (client/public/models/fighter/body.glb), auto-rigged with
 *   Mixamo bone names, loaded once and cloned per fighter.
 * - A jointed rig built in code with the same bone names, used until the GLB
 *   has loaded or if it never does.
 *
 * Either way a RigInstance hands the pose driver a `body` group facing +x,
 * y up, feet on y=0, about RIG_HEIGHT tall, plus its bones by canonical name.
 * The Tripo body wears no added gloves or shoes: its own hands and feet are
 * split into the glove and shoe material groups so they take the fighter's
 * colours. Only the code rig gets mesh gloves/shoes. Headgear and eyes are
 * attached to bones from their bind placement on both.
 */
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { clone as cloneSkinned } from "three/examples/jsm/utils/SkeletonUtils.js";

export const RIG_HEIGHT = 2.0;
const MODEL_DIR = "/models/fighter/";

export const BONE_NAMES = [
  "Hips", "Spine", "Spine1", "Spine2", "Neck", "Head",
  "LeftShoulder", "LeftArm", "LeftForeArm", "LeftHand",
  "RightShoulder", "RightArm", "RightForeArm", "RightHand",
  "LeftUpLeg", "LeftLeg", "LeftFoot", "LeftToeBase",
  "RightUpLeg", "RightLeg", "RightFoot", "RightToeBase",
] as const;
export type BoneName = typeof BONE_NAMES[number];

/** Material slots every rig exposes; the fighter tints them from its colours. */
export type BodyRegion = "skin" | "trunks" | "stripe" | "socks";
export type GearRegion = "glove" | "tape" | "shoe" | "laces" | "sole" | "headgear";
export type Region = BodyRegion | GearRegion;
const BODY_REGIONS: BodyRegion[] = ["skin", "trunks", "stripe", "socks"];

export interface RigInstance {
  /** Faces +x, y up, feet at y=0. Add to the fighter's root group. */
  body: THREE.Group;
  bones: Record<BoneName, THREE.Object3D>;
  /** One material per region, owned by this instance. */
  materials: Record<Region, THREE.MeshStandardMaterial>;
  /** Attach points created at bind time: glove centres, eyes, headgear. */
  gloveCenter: { left: THREE.Object3D; right: THREE.Object3D };
  eyes: THREE.Mesh[];
  headgear: THREE.Object3D;
  /** Body-space corrections for a bind pose that isn't upright (Tripo: a head pitched down). Applied before the pose. */
  bindFix?: Partial<Record<BoneName, THREE.Quaternion>>;
  kind: "tripo" | "code";
  dispose(): void;
}

// ───────────────────────── shared helpers ─────────────────────────

function newMaterials(): Record<Region, THREE.MeshStandardMaterial> {
  const m = (rough: number) => new THREE.MeshStandardMaterial({ roughness: rough, metalness: 0 });
  return {
    skin: m(0.62), trunks: m(0.5), stripe: m(0.5), socks: m(0.85),
    glove: m(0.35), tape: m(0.8), shoe: m(0.55), laces: m(0.8), sole: m(0.7), headgear: m(0.5),
  };
}

const tmpM = new THREE.Matrix4();
/** Object's matrix relative to `root` (both world matrices must be current). */
function relMatrix(obj: THREE.Object3D, root: THREE.Object3D, out = new THREE.Matrix4()): THREE.Matrix4 {
  return out.copy(root.matrixWorld).invert().multiply(obj.matrixWorld);
}
function relPos(obj: THREE.Object3D, root: THREE.Object3D): THREE.Vector3 {
  return new THREE.Vector3().setFromMatrixPosition(relMatrix(obj, root, tmpM));
}

/** Parent `child` to `bone` so it sits at `placeInBody` (body-space matrix) in the bind pose. */
function attachAtBind(child: THREE.Object3D, bone: THREE.Object3D, body: THREE.Object3D, placeInBody: THREE.Matrix4): void {
  const boneRel = relMatrix(bone, body);
  const local = boneRel.invert().multiply(placeInBody);
  local.decompose(child.position, child.quaternion, child.scale);
  bone.add(child);
}

// ───────────────────────── gear templates ─────────────────────────

interface GearTemplate {
  /** Geometry normalised: +x forward (fist / toe / face), y up, origin as documented per part. */
  geo: THREE.BufferGeometry;
}

interface GearSet { glove: GearTemplate; shoe: GearTemplate; headgear: GearTemplate }

/** Glove: origin at the cuff opening, fist along +x, length 1. Groups: 0 glove, 1 tape (cuff). */
function codeGloveGeo(): THREE.BufferGeometry {
  const fist = new THREE.SphereGeometry(0.36, 14, 10);
  fist.scale(1.25, 1, 1);
  fist.translate(0.6, 0, 0);
  const cuff = new THREE.CylinderGeometry(0.24, 0.27, 0.34, 12);
  cuff.rotateZ(Math.PI / 2);
  cuff.translate(0.17, 0, 0);
  return groupsOf([fist, cuff]);
}
/** Shoe: origin under the ankle, toe along +x, sole at y=0, length 1. Groups: shoe, laces, sole. */
function codeShoeGeo(): THREE.BufferGeometry {
  const upper = new THREE.BoxGeometry(0.85, 0.42, 0.34);
  upper.translate(0.18, 0.26, 0);
  const laces = new THREE.BoxGeometry(0.4, 0.04, 0.14);
  laces.translate(0.32, 0.48, 0);
  const sole = new THREE.BoxGeometry(0.95, 0.07, 0.38);
  sole.translate(0.18, 0.035, 0);
  return groupsOf([upper, laces, sole]);
}
/** Headgear: origin at the head centre, face toward +x, width 1. */
function codeHeadgearGeo(): THREE.BufferGeometry {
  const g = new THREE.SphereGeometry(0.5, 16, 12, Math.PI * 0.35, Math.PI * 1.3, 0, Math.PI * 0.62);
  g.rotateY(Math.PI);
  return groupsOf([g]);
}

function groupsOf(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const nonIndexed = parts.map(p => (p.index ? p.toNonIndexed() : p));
  const out = new THREE.BufferGeometry();
  const pos: number[] = [];
  const nor: number[] = [];
  let start = 0;
  nonIndexed.forEach((p, i) => {
    p.computeVertexNormals();
    pos.push(...Array.from(p.getAttribute("position").array as Float32Array));
    nor.push(...Array.from(p.getAttribute("normal").array as Float32Array));
    const count = p.getAttribute("position").count;
    out.addGroup(start, count, i);
    start += count;
  });
  out.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
  return out;
}

/** Pull one merged, world-baked geometry out of a loaded GLB scene. */
function mergedGeometryOf(scene: THREE.Object3D): THREE.BufferGeometry | null {
  scene.updateMatrixWorld(true);
  const pos: number[] = [];
  scene.traverse(o => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const g = (mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry.clone());
    g.applyMatrix4(mesh.matrixWorld);
    for (const v of Array.from(g.getAttribute("position").array as Float32Array)) pos.push(v);
  });
  if (pos.length === 0) return null;
  const out = new THREE.BufferGeometry();
  out.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  return out;
}

type Axis = 0 | 1 | 2;
/** Re-split a non-indexed geometry's triangles into material groups by a classifier over the triangle centroid. */
function splitByRegion(g: THREE.BufferGeometry, classify: (c: THREE.Vector3, n: THREE.Vector3) => number, nGroups: number): THREE.BufferGeometry {
  const src = g.getAttribute("position").array as Float32Array;
  const tris = src.length / 9;
  const buckets: number[][] = Array.from({ length: nGroups }, () => []);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3(), cen = new THREE.Vector3();
  for (let t = 0; t < tris; t++) {
    a.fromArray(src, t * 9); b.fromArray(src, t * 9 + 3); c.fromArray(src, t * 9 + 6);
    cen.copy(a).add(b).add(c).multiplyScalar(1 / 3);
    n.subVectors(c, b).cross(a.clone().sub(b)).normalize();
    buckets[Math.max(0, Math.min(nGroups - 1, classify(cen, n)))].push(t);
  }
  const pos = new Float32Array(src.length);
  const out = new THREE.BufferGeometry();
  let w = 0;
  buckets.forEach((list, gi) => {
    const start = w / 3;
    for (const t of list) { pos.set(src.subarray(t * 9, t * 9 + 9), w); w += 9; }
    out.addGroup(start, list.length * 3, gi);
  });
  out.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  out.computeVertexNormals();
  return out;
}

/**
 * Normalise a Tripo gear mesh: longest horizontal axis becomes x, the end the
 * `pickForward` test prefers becomes +x, then translate/scale per part.
 */
function orientGear(g: THREE.BufferGeometry, pickForward: (posHalfStats: { maxY: number; spread: number }, negHalfStats: { maxY: number; spread: number }) => boolean): THREE.BufferGeometry {
  g.computeBoundingBox();
  const size = g.boundingBox!.getSize(new THREE.Vector3());
  const center = g.boundingBox!.getCenter(new THREE.Vector3());
  g.translate(-center.x, -center.y, -center.z);
  if (size.z > size.x) g.rotateY(Math.PI / 2);
  const arr = g.getAttribute("position").array as Float32Array;
  const stat = (sign: number) => {
    let maxY = -Infinity, spread = 0, cnt = 0;
    for (let i = 0; i < arr.length; i += 3) {
      if (Math.sign(arr[i]) !== sign) continue;
      maxY = Math.max(maxY, arr[i + 1]);
      spread += Math.hypot(arr[i + 1], arr[i + 2]);
      cnt++;
    }
    return { maxY, spread: cnt ? spread / cnt : 0 };
  };
  if (!pickForward(stat(1), stat(-1))) g.rotateY(Math.PI);
  g.computeBoundingBox();
  return g;
}

function prepareGlove(raw: THREE.BufferGeometry): THREE.BufferGeometry {
  // Glove: the fist half is the bulkier one.
  const g = orientGear(raw, (p, n) => p.spread >= n.spread);
  const bb = g.boundingBox!;
  const len = bb.max.x - bb.min.x;
  g.translate(-bb.min.x, 0, 0);
  g.scale(1 / len, 1 / len, 1 / len);
  return splitByRegion(g, c => (c.x < 0.3 ? 1 : 0), 2);
}

function prepareShoe(raw: THREE.BufferGeometry): THREE.BufferGeometry {
  // Shoe: the heel half carries the high ankle collar, so +x (toe) is the lower half.
  const g = orientGear(raw, (p, n) => p.maxY <= n.maxY);
  const bb = g.boundingBox!;
  const len = bb.max.x - bb.min.x;
  const h = bb.max.y - bb.min.y;
  const w = bb.max.z - bb.min.z;
  // Origin under the ankle: a quarter of the length in from the heel.
  g.translate(-(bb.min.x + len * 0.3), -bb.min.y, 0);
  g.scale(1 / len, 1 / len, 1 / len);
  const hn = h / len, wn = w / len;
  return splitByRegion(g, (c, n) => {
    if (c.y < hn * 0.12) return 2;
    if (c.y > hn * 0.42 && c.x > 0.0 && c.x < 0.5 && Math.abs(c.z) < wn * 0.22 && n.y > 0.35) return 1;
    return 0;
  }, 3);
}

function prepareHeadgear(raw: THREE.BufferGeometry): THREE.BufferGeometry {
  raw.computeBoundingBox();
  const bb = raw.boundingBox!;
  const c = bb.getCenter(new THREE.Vector3());
  const size = bb.getSize(new THREE.Vector3());
  raw.translate(-c.x, -c.y, -c.z);
  // The generated headgear's face opening looks down -z. Turn it to +x.
  raw.rotateY(-Math.PI / 2);
  const w = Math.max(size.x, size.z);
  raw.scale(1 / w, 1 / w, 1 / w);
  return splitByRegion(raw, () => 0, 1);
}

// ───────────────────────── templates (loaded once) ─────────────────────────

interface TripoBodyTemplate {
  scene: THREE.Object3D;
  /** Mixamo-ish bone name → canonical name. */
  boneMap: Map<string, BoneName>;
}

let gearSet: GearSet = {
  glove: { geo: codeGloveGeo() },
  shoe: { geo: codeShoeGeo() },
  headgear: { geo: codeHeadgearGeo() },
};
let tripoBody: TripoBodyTemplate | null = null;
let loadStarted = false;
let assetEpoch = 0;

/** Bumped every time a loaded asset replaces a stand-in, so fighters rebuild. */
export function fighterAssetEpoch(): number {
  return assetEpoch;
}

function canonicalBone(name: string): BoneName | null {
  const stripped = name.replace(/^mixamorig[:_]?/i, "").replace(/^.*[:|]/, "");
  const hit = BONE_NAMES.find(b => b.toLowerCase() === stripped.toLowerCase());
  return hit ?? null;
}

/** Kick off the one-time GLB loads. Safe to call every frame. */
export function ensureFighterAssets(isDisposed: () => boolean): void {
  if (loadStarted) return;
  loadStarted = true;
  const loader = new GLTFLoader();
  const load = (file: string) => loader.loadAsync(MODEL_DIR + file);
  void fetch(MODEL_DIR + "fighter-manifest.json")
    .then(r => (r.ok ? r.json() : null))
    .then(async (manifest: { parts?: Record<string, { file: string }> } | null) => {
      const parts = manifest?.parts ?? {};
      const tasks: Promise<void>[] = [];
      const gear = (key: "glove" | "shoe" | "headgear", prep: (g: THREE.BufferGeometry) => THREE.BufferGeometry) => {
        if (!parts[key]) return;
        tasks.push(load(parts[key].file).then(gltf => {
          const raw = mergedGeometryOf(gltf.scene);
          if (raw) gearSet = { ...gearSet, [key]: { geo: prep(raw) } };
        }).catch(err => console.warn(`[3D] ${key} model unavailable, using stand-in`, err)));
      };
      gear("glove", prepareGlove);
      gear("shoe", prepareShoe);
      gear("headgear", prepareHeadgear);
      if (parts.body) {
        tasks.push(load(parts.body.file).then(gltf => {
          const boneMap = new Map<string, BoneName>();
          gltf.scene.traverse(o => {
            const cb = canonicalBone(o.name);
            if (cb && (o as THREE.Bone).isBone) boneMap.set(o.name, cb);
          });
          const missing = BONE_NAMES.filter(b => !Array.from(boneMap.values()).includes(b) && !b.endsWith("ToeBase"));
          if (missing.length > 0) throw new Error(`rig is missing bones: ${missing.join(", ")}`);
          rescaleArmSegments(gltf.scene, boneMap);
          tripoBody = { scene: gltf.scene, boneMap };
        }).catch(err => console.warn("[3D] boxer body unavailable, using code rig", err)));
      }
      await Promise.all(tasks);
      if (!isDisposed()) assetEpoch++;
    })
    .catch(err => console.warn("[3D] fighter manifest unavailable, using code rig", err));
}

/** Boxer arm proportions relative to the source model: shorter upper arm, longer forearm. */
const UPPER_ARM_SCALE = 0.9;
const FOREARM_SCALE = 1.15;

/**
 * Re-proportions the arms in the loaded body's BIND pose, once per load: the
 * elbow and wrist joints move along the arm and every arm vertex slides with
 * them (piecewise along the shoulder→wrist line, weighted by how much of it is
 * skinned to that arm), then the bone inverses are rebuilt. Everything
 * downstream (region cuts, own hands, IK lengths) reads the new bind.
 */
function rescaleArmSegments(scene: THREE.Object3D, boneMap: Map<string, BoneName>): void {
  const mesh = findSkinned(scene);
  if (!mesh) return;
  scene.updateMatrixWorld(true);
  const byName = {} as Partial<Record<BoneName, THREE.Bone>>;
  scene.traverse(o => { const cb = boneMap.get(o.name); if (cb && !byName[cb]) byName[cb] = o as THREE.Bone; });
  const wp = (b: THREE.Object3D) => new THREE.Vector3().setFromMatrixPosition(b.matrixWorld);
  const skelBones = mesh.skeleton.bones;
  const arms = (["Left", "Right"] as const).flatMap(side => {
    const arm = byName[`${side}Arm`], fore = byName[`${side}ForeArm`], hand = byName[`${side}Hand`];
    if (!arm || !fore || !hand) return [];
    const S = wp(arm), E = wp(fore), H = wp(hand);
    const E2 = S.clone().lerp(E, UPPER_ARM_SCALE);
    const H2 = E2.clone().add(H.clone().sub(E).multiplyScalar(FOREARM_SCALE));
    const dir = H.clone().sub(S);
    const len = dir.length();
    dir.divideScalar(len);
    const members = new Set<number>();
    skelBones.forEach((b, j) => { let o: THREE.Object3D | null = b; while (o) { if (o === arm) { members.add(j); break; } o = o.parent; } });
    return [{ fore, hand, S, dir, tE: E.clone().sub(S).dot(dir), tH: len, dE: E2.sub(E), dH: H2.sub(H), members }];
  });
  if (arms.length === 0) return;

  const geo = mesh.geometry;
  const pos = geo.attributes.position, si = geo.attributes.skinIndex, sw = geo.attributes.skinWeight;
  const bind = mesh.bindMatrix, bindInv = mesh.bindMatrixInverse;
  const v = new THREE.Vector3(), d = new THREE.Vector3();
  for (let k = 0; k < pos.count; k++) {
    v.fromBufferAttribute(pos, k).applyMatrix4(bind);
    for (const a of arms) {
      let w = 0;
      for (let c = 0; c < 4; c++) if (a.members.has(si.getComponent(k, c))) w += sw.getComponent(k, c);
      if (w <= 0) continue;
      const t = d.copy(v).sub(a.S).dot(a.dir);
      if (t <= 0) continue;
      if (t < a.tE) d.copy(a.dE).multiplyScalar(t / a.tE);
      else if (t < a.tH) d.copy(a.dE).lerp(a.dH, (t - a.tE) / (a.tH - a.tE));
      else d.copy(a.dH);
      v.addScaledVector(d, w);
    }
    v.applyMatrix4(bindInv);
    pos.setXYZ(k, v.x, v.y, v.z);
  }
  pos.needsUpdate = true;
  geo.computeBoundingBox();
  geo.computeBoundingSphere();

  for (const a of arms) {
    a.fore.position.multiplyScalar(UPPER_ARM_SCALE);
    a.hand.position.multiplyScalar(FOREARM_SCALE);
  }
  scene.updateMatrixWorld(true);
  mesh.skeleton.calculateInverses();
}

// ───────────────────────── instance builders ─────────────────────────

export function createRig(): RigInstance {
  if (tripoBody) {
    try {
      return buildTripoRig(tripoBody);
    } catch (err) {
      console.warn("[3D] boxer body failed to build, using code rig", err);
      tripoBody = null;
    }
  }
  return buildCodeRig();
}

/** Finish an instance: gear on hands/feet/head, eyes, glove centre markers. */
function finishRig(
  body: THREE.Group,
  bones: Record<BoneName, THREE.Object3D>,
  materials: Record<Region, THREE.MeshStandardMaterial>,
  kind: RigInstance["kind"],
  headInfo: { center: THREE.Vector3; radius: number; frontX: number; eyeY: number; eyes?: [THREE.Vector3, THREE.Vector3] },
  ownedGeos: THREE.BufferGeometry[],
  /** Tripo: the model's own fists, centre per side in body space. No mesh gear is added. */
  ownHands?: { left: THREE.Vector3; right: THREE.Vector3 },
  /** Tripo: headgear shaped to this model's skull, in body space. */
  fittedHeadgear?: THREE.BufferGeometry,
): RigInstance {
  body.updateMatrixWorld(true);
  const gloveLen = 0.3;
  const gloveCenter = { left: new THREE.Object3D(), right: new THREE.Object3D() };
  if (ownHands) {
    for (const side of ["left", "right"] as const) {
      const centre = new THREE.Matrix4().makeTranslation(ownHands[side].x, ownHands[side].y, ownHands[side].z);
      attachAtBind(gloveCenter[side], bones[side === "left" ? "LeftHand" : "RightHand"], body, centre);
    }
  }
  for (const side of (ownHands ? [] : ["Left", "Right"]) as ("Left" | "Right")[]) {
    const hand = bones[`${side}Hand`];
    const fore = bones[`${side}ForeArm`];
    const handP = relPos(hand, body);
    const dir = handP.clone().sub(relPos(fore, body)).normalize();
    // Cuff sits a little back up the forearm so the wrist is covered.
    const cuff = handP.clone().addScaledVector(dir, -0.03);
    const up = new THREE.Vector3(0, 1, 0);
    const z = new THREE.Vector3().crossVectors(dir, up).normalize();
    const y = new THREE.Vector3().crossVectors(z, dir).normalize();
    const basis = new THREE.Matrix4().makeBasis(dir, y, z);
    const mirror = side === "Right" ? -1 : 1;
    const place = new THREE.Matrix4().compose(
      cuff, new THREE.Quaternion().setFromRotationMatrix(basis), new THREE.Vector3(gloveLen, gloveLen, gloveLen * mirror),
    );
    const glove = new THREE.Mesh(gearSet.glove.geo, [materials.glove, materials.tape]);
    glove.castShadow = true;
    attachAtBind(glove, hand, body, place);
    const centre = new THREE.Matrix4().compose(cuff.clone().addScaledVector(dir, gloveLen * 0.62), new THREE.Quaternion(), new THREE.Vector3(1, 1, 1));
    attachAtBind(gloveCenter[side === "Left" ? "left" : "right"], hand, body, centre);

    const foot = bones[`${side}Foot`];
    const footP = relPos(foot, body);
    const shoeLen = 0.3;
    const shoePlace = new THREE.Matrix4().compose(
      new THREE.Vector3(footP.x, 0, footP.z), new THREE.Quaternion(), new THREE.Vector3(shoeLen, shoeLen, shoeLen * mirror),
    );
    const shoe = new THREE.Mesh(gearSet.shoe.geo, [materials.shoe, materials.laces, materials.sole]);
    shoe.castShadow = true;
    attachAtBind(shoe, foot, body, shoePlace);
  }

  const head = bones.Head;
  const hgPlace = new THREE.Matrix4().compose(
    headInfo.center.clone().add(new THREE.Vector3(-headInfo.radius * 0.08, headInfo.radius * 0.12, 0)),
    new THREE.Quaternion(), new THREE.Vector3().setScalar(headInfo.radius * 3.6),
  );
  const headgear = new THREE.Mesh(fittedHeadgear ?? gearSet.headgear.geo, materials.headgear);
  headgear.castShadow = true;
  headgear.visible = false;
  if (fittedHeadgear) {
    ownedGeos.push(fittedHeadgear);
    materials.headgear.side = THREE.DoubleSide; // the inside shows through the face opening
  }
  // The headgear's origin doubles as the head centre for the pose driver, so
  // the fitted (body-space) shell is re-centred on it.
  if (fittedHeadgear) fittedHeadgear.translate(-headInfo.center.x, -headInfo.center.y, -headInfo.center.z);
  attachAtBind(headgear, head, body, fittedHeadgear
    ? new THREE.Matrix4().makeTranslation(headInfo.center.x, headInfo.center.y, headInfo.center.z)
    : hgPlace);

  const eyeGeo = new THREE.SphereGeometry(1, 10, 8);
  ownedGeos.push(eyeGeo);
  const eyeMat = new THREE.MeshBasicMaterial({ color: "#141414" });
  const eyes: THREE.Mesh[] = [];
  for (const s of [-1, 1]) {
    const eye = new THREE.Mesh(eyeGeo, eyeMat);
    const r = headInfo.radius * 0.11;
    const place = new THREE.Matrix4().compose(
      headInfo.eyes?.[s < 0 ? 0 : 1].clone()
        ?? new THREE.Vector3(headInfo.frontX - r * 0.25, headInfo.eyeY, headInfo.center.z + s * headInfo.radius * 0.36),
      new THREE.Quaternion(), new THREE.Vector3(r * 0.35, r * 0.75, r),
    );
    attachAtBind(eye, head, body, place);
    eyes.push(eye);
  }

  return {
    body, bones, materials, gloveCenter, eyes, headgear, kind,
    dispose() {
      for (const g of ownedGeos) g.dispose();
      eyeMat.dispose();
      for (const m of Object.values(materials)) m.dispose();
    },
  };
}

function buildTripoRig(t: TripoBodyTemplate): RigInstance {
  const model = cloneSkinned(t.scene);
  const bones = {} as Record<BoneName, THREE.Object3D>;
  model.traverse(o => {
    const cb = t.boneMap.get(o.name);
    if (cb && !bones[cb]) bones[cb] = o;
  });
  // A rig without toe bones still works: the foot just isn't pitched.
  for (const side of ["Left", "Right"] as const) {
    if (!bones[`${side}ToeBase`]) {
      const toe = new THREE.Object3D();
      toe.position.set(0, 0.05, 0);
      bones[`${side}Foot`].add(toe);
      bones[`${side}ToeBase`] = toe;
    }
  }

  // Orient: forward = cross(characterLeft, up); scale to RIG_HEIGHT; feet at 0.
  const orient = new THREE.Group();
  orient.add(model);
  const body = new THREE.Group();
  body.add(orient);
  body.updateMatrixWorld(true);
  const p = (b: BoneName) => relPos(bones[b], body);
  const up = p("Head").sub(p("Hips")).normalize();
  const left = p("LeftArm").sub(p("RightArm")).normalize();
  const fwd = new THREE.Vector3().crossVectors(left, up).normalize();
  const right = new THREE.Vector3().crossVectors(fwd, up).normalize();
  const basis = new THREE.Matrix4().makeBasis(fwd, up, right); // columns: model dirs for scene x,y,z
  orient.quaternion.setFromRotationMatrix(basis.invert());
  body.updateMatrixWorld(true);

  const mesh = findSkinned(model);
  if (!mesh) throw new Error("no skinned mesh in body");
  mesh.geometry = mesh.geometry.clone();
  const box = new THREE.Box3().setFromObject(mesh, true);
  const height = box.max.y - box.min.y;
  const s = RIG_HEIGHT / Math.max(0.01, height);
  orient.scale.setScalar(s);
  body.updateMatrixWorld(true);
  const box2 = new THREE.Box3().setFromObject(mesh, true);
  orient.position.y = -box2.min.y;
  orient.position.x = -(p("Hips").x);
  orient.position.z = -(p("Hips").z);
  body.updateMatrixWorld(true);

  const materials = newMaterials();
  mesh.material = [...BODY_REGIONS.map(r => materials[r]), materials.glove, materials.shoe, materials.tape];
  mesh.castShadow = true;
  mesh.frustumCulled = false;
  // The cut/region/headgear work is ~150 ms, so it runs once per loaded template.
  if (tripoCache?.tpl !== t) {
    const toBody = new THREE.Matrix4().copy(body.matrixWorld).invert().multiply(mesh.matrixWorld);
    tripoCache = { tpl: t, ...tripoRegions(mesh.geometry, toBody, p) };
  }
  const C = tripoCache;
  mesh.geometry = C.geo.clone();
  const rigOut = finishRig(body, bones, materials, "tripo", {
    center: C.headInfo.center.clone(), radius: C.headInfo.radius, frontX: C.headInfo.frontX, eyeY: C.headInfo.eyeY,
    eyes: C.headInfo.eyes && [C.headInfo.eyes[0].clone(), C.headInfo.eyes[1].clone()],
  }, [mesh.geometry], C.ownHands && { left: C.ownHands.left.clone(), right: C.ownHands.right.clone() }, C.headgear?.clone());
  if (C.bindFix) rigOut.bindFix = { Neck: C.bindFix.Neck.clone(), Head: C.bindFix.Head.clone() };
  return rigOut;
}

let tripoCache: ({ tpl: TripoBodyTemplate } & ReturnType<typeof tripoRegions>) | null = null;

/** Colour-region groups, own-hand centres, head metrics and fitted headgear for the Tripo body. */
function tripoRegions(srcGeo: THREE.BufferGeometry, toBody: THREE.Matrix4, p: (b: BoneName) => THREE.Vector3) {
  // Colour regions, all from the bind pose in body space. Every region edge is a
  // level line of a scalar field, and the mesh is first cut along each one
  // (same surface, a few extra vertices) so the colour edges are straight
  // instead of following the low-poly triangles' teeth into the skin.
  const hipsY = p("Hips").y;
  const kneeY = (p("LeftLeg").y + p("RightLeg").y) / 2;
  const ankleY = (p("LeftFoot").y + p("RightFoot").y) / 2;
  const chestY = p("Spine2").y;
  // The model's shorts have a moulded waistband that sits higher at the back:
  // its top edge is a tilted plane (measured on the Tripo boxer, relative to
  // the hips), and the whole band is the stripe colour.
  void chestY;
  const waistTop = (v: THREE.Vector3) => hipsY + 0.166 - 0.124 * v.x;
  const stripeY = hipsY + 0.028;
  const hemY = findShortsHem(srcGeo, toBody, p("LeftUpLeg"), p("LeftLeg"), kneeY, hipsY)
    ?? kneeY + (hipsY - kneeY) * 0.42;
  // The model's own feet are the shoes (boxing high-tops) and its own fists the
  // gloves, with the wrist strap (tape) just behind them: no geometry is added
  // on top, these areas just take the gear colours.
  // High-top boots run to the moulded cuff about two thirds of the way to the
  // knee (measured on this model); a short sock top shows above them.
  const shoeTop = ankleY + (kneeY - ankleY) * 0.65;
  const sockTop = shoeTop + 0.035;
  const arm = (["Left", "Right"] as const).map(side => {
    const wrist = p(`${side}Hand`);
    const dir = wrist.clone().sub(p(`${side}ForeArm`)).normalize();
    const zSign = Math.sign(wrist.z) || (side === "Left" ? -1 : 1);
    const minZ = Math.abs(p(`${side}Arm`).z) * 0.9 + Math.abs(wrist.z) * 0.1;
    return { wrist, dir, zSign, minZ };
  });
  const GLOVE_FROM = -0.02, TAPE_FROM = -0.095; // along the forearm from the wrist joint (m)
  const armS = (v: THREE.Vector3, k: number): number => {
    const a = arm[k];
    if (Math.sign(v.z) !== a.zSign || Math.abs(v.z) < a.minZ) return -1;
    return _sv.copy(v).sub(a.wrist).dot(a.dir);
  };
  const fields: ((v: THREE.Vector3) => number)[] = [
    v => v.y - waistTop(v), v => v.y - stripeY, v => v.y - hemY, v => v.y - sockTop, v => v.y - shoeTop,
    v => armS(v, 0) - GLOVE_FROM, v => armS(v, 0) - TAPE_FROM,
    v => armS(v, 1) - GLOVE_FROM, v => armS(v, 1) - TAPE_FROM,
  ];
  let geo = srcGeo;
  for (const fld of fields) geo = cutSkinnedAlong(geo, toBody, fld);
  const handSum = [new THREE.Vector3(), new THREE.Vector3()];
  const handN = [0, 0];
  {
    const pos = geo.getAttribute("position"), v = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(toBody);
      for (let k = 0; k < 2; k++) if (armS(v, k) > GLOVE_FROM + 0.005) { handSum[k].add(v); handN[k]++; }
    }
  }
  const ownHands = handN[0] > 0 && handN[1] > 0
    ? { left: handSum[0].divideScalar(handN[0]), right: handSum[1].divideScalar(handN[1]) }
    : undefined;
  const outGeo = regionGroupsForSkinned(geo, toBody, c => {
    const s = Math.max(armS(c, 0), armS(c, 1));
    if (ownHands && s > GLOVE_FROM) return 4;
    if (ownHands && s > TAPE_FROM) return 6;
    if (c.y < shoeTop) return 5;
    if (c.y > waistTop(c)) return 0;
    if (c.y > stripeY) return 2;
    if (c.y > hemY) return 1;
    if (c.y < sockTop) return 3;
    return 0;
  }, 7);
  // Head metrics from the skull vertices.
  const headInfo = headMetrics(outGeo, toBody, p("Head"), p("Neck"));
  const hg = fitHeadgear(outGeo, toBody, headInfo, (arm[0].wrist.y + arm[1].wrist.y) / 2);
  // The generated body carries its head pitched down (the reference photo was
  // shot from above): level the face line, split across neck and head.
  const level = hg ? new THREE.Quaternion().setFromUnitVectors(hg.faceUp, new THREE.Vector3(0, 1, 0)) : null;
  const bindFix = level && level.w < 0.9998 ? {
    Neck: new THREE.Quaternion().slerp(level, 0.4), Head: level.clone(),
  } : undefined;
  return { geo: outGeo, ownHands, headInfo: { ...headInfo, eyes: hg?.eyes }, headgear: hg?.geo, bindFix };
}

const _sv = new THREE.Vector3();

/**
 * Where the shorts end: walking up from just above the knee, the first height
 * where the leg's silhouette flares out past the bare thigh. Null if no flare.
 */
function findShortsHem(g: THREE.BufferGeometry, toBody: THREE.Matrix4, hip: THREE.Vector3, knee: THREE.Vector3, kneeY: number, hipsY: number): number | null {
  const pos = g.getAttribute("position");
  const axis = knee.clone().sub(hip);
  const len = axis.length();
  axis.normalize();
  const v = new THREE.Vector3(), d = new THREE.Vector3();
  const pts: { y: number; r: number }[] = [];
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).applyMatrix4(toBody);
    if (Math.sign(v.z) !== Math.sign(hip.z || -1)) continue;
    const t = d.copy(v).sub(hip).dot(axis);
    if (t < 0 || t > len) continue;
    pts.push({ y: v.y, r: d.addScaledVector(axis, -t).length() });
  }
  const p95 = (y: number) => {
    const rs = pts.filter(q => Math.abs(q.y - y) <= 0.015).map(q => q.r).sort((a, b) => a - b);
    return rs.length < 4 ? null : rs[Math.floor(rs.length * 0.95)];
  };
  const base = p95(kneeY + 0.04);
  if (base == null) return null;
  for (let y = kneeY + 0.05; y < kneeY + (hipsY - kneeY) * 0.7; y += 0.005) {
    const r = p95(y);
    if (r != null && r > base * 1.25) return y - 0.012;
  }
  return null;
}

/**
 * Cut a skinned indexed geometry along the zero line of `field` (evaluated on
 * bind positions in body space). Triangles crossing it are split in three;
 * new vertices interpolate position/normal/uv and merge the two ends' skin
 * weights (top four kept, renormalised). The surface doesn't change.
 */
function cutSkinnedAlong(g: THREE.BufferGeometry, toBody: THREE.Matrix4, field: (v: THREE.Vector3) => number): THREE.BufferGeometry {
  const names = Object.keys(g.attributes);
  const src = names.map(n => g.getAttribute(n) as THREE.BufferAttribute);
  const data = src.map(a => Array.from(a.array as ArrayLike<number>));
  const sizes = src.map(a => a.itemSize);
  const posI = names.indexOf("position"), siI = names.indexOf("skinIndex"), swI = names.indexOf("skinWeight");
  const n0 = src[posI].count;
  const fv: number[] = new Array(n0);
  const v = new THREE.Vector3();
  for (let i = 0; i < n0; i++) fv[i] = field(v.fromBufferAttribute(src[posI], i).applyMatrix4(toBody));
  let count = n0;
  const edgeCache = new Map<string, number>();
  const EPS = 1e-6;
  const mid = (a: number, b: number): number => {
    const key = a < b ? `${a}_${b}` : `${b}_${a}`;
    const hit = edgeCache.get(key);
    if (hit !== undefined) return hit;
    const t = fv[a] / (fv[a] - fv[b]);
    names.forEach((_, k) => {
      const sz = sizes[k], arr = data[k];
      if (k === siI || k === swI) return;
      for (let c = 0; c < sz; c++) arr.push(arr[a * sz + c] + (arr[b * sz + c] - arr[a * sz + c]) * t);
    });
    if (siI >= 0 && swI >= 0) {
      const w = new Map<number, number>();
      for (const [vi, f] of [[a, 1 - t], [b, t]] as [number, number][]) {
        for (let c = 0; c < 4; c++) {
          const bi = data[siI][vi * 4 + c], bw = data[swI][vi * 4 + c] * f;
          if (bw > 0) w.set(bi, (w.get(bi) ?? 0) + bw);
        }
      }
      const top = Array.from(w.entries()).sort((x, y) => y[1] - x[1]).slice(0, 4);
      const sum = top.reduce((s2, e) => s2 + e[1], 0) || 1;
      for (let c = 0; c < 4; c++) { data[siI].push(top[c]?.[0] ?? 0); data[swI].push((top[c]?.[1] ?? 0) / sum); }
    }
    fv.push(0);
    edgeCache.set(key, count);
    return count++;
  };
  const index = g.index ? Array.from(g.index.array) : Array.from({ length: n0 }, (_, i) => i);
  const out: number[] = [];
  for (let t = 0; t < index.length; t += 3) {
    const tri = [index[t], index[t + 1], index[t + 2]];
    const sg = tri.map(i => (fv[i] > EPS ? 1 : fv[i] < -EPS ? -1 : 0));
    if (!(sg.includes(1) && sg.includes(-1))) { out.push(...tri); continue; }
    // Rotate so vertex 0 is the one alone on its side (or the one on the line).
    let r = 0;
    for (let k = 0; k < 3; k++) {
      const a = sg[k], b = sg[(k + 1) % 3], c = sg[(k + 2) % 3];
      if (a === 0 || (b !== a && c !== a && b !== 0 && c !== 0)) { r = k; break; }
    }
    const [A, B, C] = [tri[r], tri[(r + 1) % 3], tri[(r + 2) % 3]];
    if (sg[r] === 0) {
      // A on the line, B and C on opposite sides: split edge BC only.
      const m = mid(B, C);
      out.push(A, B, m, A, m, C);
    } else {
      const mab = mid(A, B), mac = mid(A, C);
      out.push(A, mab, mac, mab, B, C, mab, C, mac);
    }
  }
  const res = new THREE.BufferGeometry();
  names.forEach((n, k) => {
    const Arr = (src[k].array as any).constructor as { new (a: number[]): ArrayLike<number> };
    res.setAttribute(n, new THREE.BufferAttribute(Arr === Uint8Array || Arr === Uint16Array ? new (Arr as any)(data[k]) : new Float32Array(data[k]), sizes[k], src[k].normalized));
  });
  res.setIndex(out);
  return res;
}

function findSkinned(o: THREE.Object3D): THREE.SkinnedMesh | null {
  let found: THREE.SkinnedMesh | null = null;
  o.traverse(c => { if (!found && (c as THREE.SkinnedMesh).isSkinnedMesh) found = c as THREE.SkinnedMesh; });
  return found;
}

/** Reorder an indexed skinned geometry's triangles into region groups (bind positions in body space). */
function regionGroupsForSkinned(
  g: THREE.BufferGeometry, toBody: THREE.Matrix4,
  classify: (centroid: THREE.Vector3) => number, nGroups = BODY_REGIONS.length,
): THREE.BufferGeometry {
  const pos = g.getAttribute("position");
  const index = g.index ? Array.from(g.index.array) : Array.from({ length: pos.count }, (_, i) => i);
  const v = new THREE.Vector3(), c = new THREE.Vector3();
  const buckets: number[][] = Array.from({ length: nGroups }, () => []);
  for (let t = 0; t < index.length; t += 3) {
    c.set(0, 0, 0);
    for (let k = 0; k < 3; k++) c.add(v.fromBufferAttribute(pos, index[t + k]).applyMatrix4(toBody));
    const r = classify(c.multiplyScalar(1 / 3));
    buckets[Math.max(0, Math.min(nGroups - 1, r))].push(index[t], index[t + 1], index[t + 2]);
  }
  const flat: number[] = [];
  g.clearGroups();
  buckets.forEach((b, i) => { g.addGroup(flat.length, b.length, i); flat.push(...b); });
  g.setIndex(flat);
  g.computeVertexNormals();
  return g;
}

/**
 * Amateur headgear shaped to the model's own skull: the head's surface pushed
 * out into a smooth padded shell (crown, forehead pad, cheek protectors, back),
 * with the face (brow to chin), jaw and ear holes open and a padded rim round
 * every opening. Built in a head frame from the face profile, so a head that
 * is pitched in the bind pose still gets a level opening. Body space, or null.
 * Also returns where the model's eyes are, for the blink spheres.
 */
function fitHeadgear(
  src: THREE.BufferGeometry, toBody: THREE.Matrix4,
  head: { center: THREE.Vector3; radius: number; frontX: number; eyeY: number },
  armY: number,
): { geo: THREE.BufferGeometry; eyes: [THREE.Vector3, THREE.Vector3]; faceUp: THREE.Vector3 } | null {
  const c0 = head.center, cz = c0.z;
  const all = (geo: THREE.BufferGeometry) => {
    const pos = geo.getAttribute("position");
    return Array.from({ length: pos.count }, (_, i) => new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(toBody));
  };
  let vb = all(src);
  const isHead = (v: THREE.Vector3) => v.y > armY + 0.05 && Math.abs(v.z - cz) < 0.2 && v.distanceTo(c0) < 0.3;
  // Face profile: the front-most midline point per 1 cm of height.
  const prof = new Map<number, number>();
  for (const v of vb) {
    if (!isHead(v) || Math.abs(v.z - cz) > 0.015 || v.x < c0.x) continue;
    const k = Math.round((v.y - c0.y) * 100);
    prof.set(k, Math.max(prof.get(k) ?? -Infinity, v.x));
  }
  const keys = Array.from(prof.keys()).sort((x, y) => x - y);
  if (keys.length < 10) return null;
  const maxPX = Math.max(...Array.from(prof.values()));
  // Chin: the lowest profile point well out in front (the neck sits behind it).
  const chinK = keys.find(k => prof.get(k)! > c0.x + 0.6 * (maxPX - c0.x))!;
  const chin = new THREE.Vector3(prof.get(chinK)!, c0.y + chinK / 100, cz);
  const fhK = keys.reduce((best, k) => Math.abs(k - (chinK + 17)) < Math.abs(best - (chinK + 17)) ? k : best, keys[0]);
  const fore = new THREE.Vector3(prof.get(fhK)!, c0.y + fhK / 100, cz);
  const U = fore.clone().sub(chin).normalize();          // up the face
  const Z = new THREE.Vector3(0, 0, 1);
  const F = new THREE.Vector3().crossVectors(U, Z).normalize(); // out of the face
  const loc = (v: THREE.Vector3) => { const d = _sv.copy(v).sub(c0); return { f: d.dot(F), u: d.dot(U), r: v.z - cz }; };
  let crownU = -Infinity, maxF = -Infinity;
  for (const v of vb) if (isHead(v)) { const l = loc(v); crownU = Math.max(crownU, l.u); maxF = Math.max(maxF, l.f); }
  const chinU = loc(chin).u;
  const h = crownU - chinU;
  if (!isFinite(h) || h < 0.15 || h > 0.5) return null;
  const browU = crownU - 0.44 * h;        // forehead pad ends just over the brows
  const cheekLowU = crownU - 0.82 * h;    // cheek protectors stop at mouth level
  const openHalf = 0.21 * h;              // half-width of the face opening
  const faceF = maxF - 0.085;             // in front of this is "face side"
  const bottomU = chinU + 0.03;           // back of the neck stays bare
  const eyeU = crownU - 0.52 * h;
  // Ear holes: the outermost point of each ear.
  const ear = [-1, 1].map(sd => {
    let best: { f: number; u: number; r: number } | null = null;
    for (const v of vb) {
      if (!isHead(v)) continue;
      const l = loc(v);
      if (l.u < chinU + 0.3 * h || l.u > crownU - 0.35 * h || Math.sign(l.r) !== sd) continue;
      if (!best || Math.abs(l.r) > Math.abs(best.r)) best = { ...l };
    }
    return best;
  });
  const EAR_R = 0.024;
  const earField = (k: number) => (v: THREE.Vector3) => {
    const e = ear[k]; if (!e) return 1;
    const l = loc(v);
    if (Math.sign(l.r) !== Math.sign(e.r) || Math.abs(l.r) < Math.abs(e.r) * 0.5) return 1;
    return Math.hypot(l.f - e.f, l.u - e.u) - EAR_R;
  };
  let g = src;
  for (const fld of [
    (v: THREE.Vector3) => loc(v).u - browU, (v: THREE.Vector3) => loc(v).u - cheekLowU, (v: THREE.Vector3) => loc(v).u - bottomU,
    (v: THREE.Vector3) => loc(v).f - faceF, (v: THREE.Vector3) => loc(v).r - openHalf, (v: THREE.Vector3) => loc(v).r + openHalf,
    earField(0), earField(1),
  ]) g = cutSkinnedAlong(g, toBody, fld);
  vb = all(g);
  const index = g.index ? g.index.array : Array.from({ length: vb.length }, (_, i) => i);
  const inHead = (v: THREE.Vector3) => isHead(v) && loc(v).u > bottomU - 0.02;
  const keep = (cc: THREE.Vector3) => {
    const l = loc(cc);
    if (l.u < bottomU) return false;
    const front = l.f > faceF;
    if (front && Math.abs(l.r) < openHalf && l.u < browU) return false; // face
    if (front && l.u < cheekLowU) return false;                         // jaw & chin
    if (earField(0)(cc) < 0 || earField(1)(cc) < 0) return false;       // ear holes
    return true;
  };
  // Weld by position (1 mm grid: cut points from neighbouring triangles land a
  // hair apart): one shell vertex per surface point.
  const key = (v: THREE.Vector3) => `${Math.round(v.x * 1000)},${Math.round(v.y * 1000)},${Math.round(v.z * 1000)}`;
  const weld = new Map<string, number>();
  const base: THREE.Vector3[] = [], nrm: THREE.Vector3[] = [];
  const wid = (v: THREE.Vector3) => {
    const k = key(v);
    let i = weld.get(k);
    if (i === undefined) { i = base.length; weld.set(k, i); base.push(v.clone()); nrm.push(new THREE.Vector3()); }
    return i;
  };
  const tris: number[] = [];
  const e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), n = new THREE.Vector3(), cc = new THREE.Vector3();
  for (let t = 0; t < index.length; t += 3) {
    const a = vb[index[t]], b = vb[index[t + 1]], d = vb[index[t + 2]];
    if (!inHead(a) || !inHead(b) || !inHead(d)) continue;
    const ia = wid(a), ib = wid(b), id = wid(d);
    n.crossVectors(e1.subVectors(b, a), e2.subVectors(d, a));
    nrm[ia].add(n); nrm[ib].add(n); nrm[id].add(n);
    cc.copy(a).add(b).add(d).multiplyScalar(1 / 3);
    if (keep(cc) && ia !== ib && ib !== id && ia !== id) tris.push(ia, ib, id);
  }
  if (tris.length < 90) return null;
  for (const v of nrm) v.normalize();
  // Edges used once are the openings' borders.
  const edgeCount = new Map<string, number>();
  const ek = (x: number, y: number) => x < y ? `${x}_${y}` : `${y}_${x}`;
  for (let t = 0; t < tris.length; t += 3) for (let j = 0; j < 3; j++) {
    const k = ek(tris[t + j], tris[t + (j + 1) % 3]);
    edgeCount.set(k, (edgeCount.get(k) ?? 0) + 1);
  }
  const used = Array.from(new Set(tris));
  const nb = new Map<number, Set<number>>();
  const border = new Set<number>();
  for (let t = 0; t < tris.length; t += 3) for (let j = 0; j < 3; j++) {
    const x = tris[t + j], y = tris[t + (j + 1) % 3];
    const isB = edgeCount.get(ek(x, y)) === 1;
    if (isB) { border.add(x); border.add(y); }
    for (const [p, q] of [[x, y], [y, x]]) (nb.get(p) ?? nb.set(p, new Set()).get(p)!).add(q);
  }
  // Padding: thick, then smoothed so the skull's detail (ears, brow, nose
  // bridge) melts into a smooth pad. Borders only smooth along the border.
  const THICK = 0.028, RIM_IN = 0.004;
  let P = base.map((v, i) => v.clone().addScaledVector(nrm[i], THICK));
  for (let it = 0; it < 8; it++) {
    const Q = P.map(v => v.clone());
    for (const i of used) {
      const ns = Array.from(nb.get(i)!).filter(j => !border.has(i) || border.has(j));
      if (!ns.length) continue;
      const avg = new THREE.Vector3();
      for (const j of ns) avg.add(P[j]);
      avg.divideScalar(ns.length);
      Q[i].lerp(avg, 0.5);
    }
    P = Q;
  }
  // Smoothing shrinks the shell; push every vertex back out to its padding depth.
  for (const i of used) {
    const out = _sv.copy(P[i]).sub(base[i]).dot(nrm[i]);
    if (out < THICK * 0.8) P[i].addScaledVector(nrm[i], THICK * 0.8 - out);
  }
  const posOut: number[] = [];
  for (const v of P) posOut.push(v.x, v.y, v.z);
  const idxOut = [...tris];
  // Rim: a band from each border edge back down to the head, so the padding has visible thickness.
  const inner = new Map<number, number>();
  const innerOf = (i: number) => {
    let j = inner.get(i);
    if (j === undefined) {
      j = posOut.length / 3; inner.set(i, j);
      const v = base[i].clone().addScaledVector(nrm[i], RIM_IN);
      posOut.push(v.x, v.y, v.z);
    }
    return j;
  };
  for (let t = 0; t < tris.length; t += 3) for (let j = 0; j < 3; j++) {
    const x = tris[t + j], y = tris[t + (j + 1) % 3];
    if (edgeCount.get(ek(x, y)) !== 1) continue;
    const xi = innerOf(x), yi = innerOf(y);
    idxOut.push(y, x, xi, y, xi, yi);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(posOut, 3));
  geo.setIndex(idxOut);
  geo.computeVertexNormals();
  geo.addGroup(0, idxOut.length, 0);
  // Eyes: the front-most surface point at eye height, a little in from the midline.
  const eyes = [-1, 1].map(sd => {
    let best: THREE.Vector3 | null = null, bf = -Infinity;
    for (const v of vb) {
      if (!isHead(v)) continue;
      const l = loc(v);
      if (Math.abs(l.u - eyeU) > 0.012 || Math.abs(l.r - sd * 0.033) > 0.01) continue;
      if (l.f > bf) { bf = l.f; best = v; }
    }
    return (best ?? c0.clone().addScaledVector(F, maxF - 0.02).addScaledVector(U, eyeU).add(new THREE.Vector3(0, 0, sd * 0.033)))
      .clone().addScaledVector(F, -0.006);
  }) as [THREE.Vector3, THREE.Vector3];
  return { geo, eyes, faceUp: U.clone() };
}

function headMetrics(geo: THREE.BufferGeometry, toBody: THREE.Matrix4, headP: THREE.Vector3, neckP: THREE.Vector3) {
  const pos = geo.getAttribute("position");
  const pts: THREE.Vector3[] = [];
  const box = new THREE.Box3();
  // The skull: everything a little above the head joint, near the midline.
  for (let i = 0; i < pos.count; i++) {
    const v = new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(toBody);
    if (v.y > headP.y + 0.03 && Math.abs(v.z - headP.z) < 0.14) { box.expandByPoint(v); pts.push(v); }
  }
  if (box.isEmpty()) {
    const r = Math.max(0.1, headP.distanceTo(neckP) * 1.6);
    return { center: headP.clone().add(new THREE.Vector3(0, r, 0)), radius: r, frontX: headP.x + r, eyeY: headP.y + r };
  }
  const size = box.getSize(new THREE.Vector3());
  const radius = size.z * 0.5;
  const center = new THREE.Vector3(headP.x, box.min.y + size.y * 0.5, headP.z);
  const eyeY = box.min.y + size.y * 0.55;
  // Face surface at eye height, where the eyes sit.
  let frontX = -Infinity;
  for (const v of pts) {
    if (Math.abs(v.y - eyeY) < 0.03 && Math.abs(Math.abs(v.z - headP.z) - radius * 0.36) < 0.025) frontX = Math.max(frontX, v.x);
  }
  if (!isFinite(frontX)) frontX = box.max.x;
  return { center, radius, frontX, eyeY };
}

// ───────────────────────── code rig ─────────────────────────

/** Bind joint positions for the code rig (body space, metres), T-pose, facing +x. */
const CODE_BIND: Record<BoneName, [BoneName | null, number, number, number]> = {
  Hips: [null, 0, 1.0, 0],
  Spine: ["Hips", 0, 1.1, 0],
  Spine1: ["Spine", 0, 1.24, 0],
  Spine2: ["Spine1", 0, 1.38, 0],
  Neck: ["Spine2", 0, 1.6, 0],
  Head: ["Neck", 0.01, 1.68, 0],
  LeftShoulder: ["Spine2", 0, 1.54, -0.06],
  LeftArm: ["LeftShoulder", 0, 1.56, -0.21],
  LeftForeArm: ["LeftArm", 0, 1.56, -(0.21 + 0.32 * UPPER_ARM_SCALE)],
  LeftHand: ["LeftForeArm", 0, 1.56, -(0.21 + 0.32 * UPPER_ARM_SCALE + 0.29 * FOREARM_SCALE)],
  RightShoulder: ["Spine2", 0, 1.54, 0.06],
  RightArm: ["RightShoulder", 0, 1.56, 0.21],
  RightForeArm: ["RightArm", 0, 1.56, 0.21 + 0.32 * UPPER_ARM_SCALE],
  RightHand: ["RightForeArm", 0, 1.56, 0.21 + 0.32 * UPPER_ARM_SCALE + 0.29 * FOREARM_SCALE],
  LeftUpLeg: ["Hips", 0, 0.96, -0.11],
  LeftLeg: ["LeftUpLeg", 0, 0.52, -0.11],
  LeftFoot: ["LeftLeg", 0, 0.09, -0.11],
  LeftToeBase: ["LeftFoot", 0.17, 0.02, -0.11],
  RightUpLeg: ["Hips", 0, 0.96, 0.11],
  RightLeg: ["RightUpLeg", 0, 0.52, 0.11],
  RightFoot: ["RightLeg", 0, 0.09, 0.11],
  RightToeBase: ["RightFoot", 0.17, 0.02, 0.11],
};

function buildCodeRig(): RigInstance {
  const body = new THREE.Group();
  const bones = {} as Record<BoneName, THREE.Object3D>;
  const abs = (b: BoneName) => new THREE.Vector3(CODE_BIND[b][1], CODE_BIND[b][2], CODE_BIND[b][3]);
  for (const name of BONE_NAMES) {
    const bone = new THREE.Bone();
    bone.name = name;
    const parent = CODE_BIND[name][0];
    const p = abs(name);
    if (parent) {
      bone.position.copy(p.sub(abs(parent)));
      bones[parent].add(bone);
    } else {
      bone.position.copy(p);
      body.add(bone);
    }
    bones[name] = bone;
  }
  const materials = newMaterials();
  const geos: THREE.BufferGeometry[] = [];
  const seg = (from: BoneName, to: BoneName, r0: number, r1: number, mat: THREE.Material) => {
    const a = abs(from), b = abs(to);
    const len = a.distanceTo(b);
    const g = new THREE.CylinderGeometry(r1, r0, len, 10);
    g.translate(0, len / 2, 0);
    geos.push(g);
    const m = new THREE.Mesh(g, mat);
    m.castShadow = true;
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
    bones[from].add(m);
  };
  const ball = (bone: BoneName, r: number, mat: THREE.Material, off = new THREE.Vector3()) => {
    const g = new THREE.SphereGeometry(r, 14, 10);
    geos.push(g);
    const m = new THREE.Mesh(g, mat);
    m.castShadow = true;
    m.position.copy(off);
    bones[bone].add(m);
    return m;
  };
  seg("Spine", "Neck", 0.15, 0.2, materials.skin);
  ball("Spine2", 0.2, materials.skin).scale.set(0.75, 1, 1.15);
  seg("Neck", "Head", 0.06, 0.06, materials.skin);
  ball("Head", 0.115, materials.skin, new THREE.Vector3(0.01, 0.1, 0)).scale.set(1.05, 1.15, 0.95);
  // Trunks: hip block with a stripe band on top.
  const trunks = new THREE.CylinderGeometry(0.2, 0.21, 0.24, 14);
  trunks.translate(0, -0.04, 0);
  geos.push(trunks);
  bones.Hips.add(Object.assign(new THREE.Mesh(trunks, materials.trunks), { castShadow: true }));
  const stripe = new THREE.CylinderGeometry(0.205, 0.205, 0.05, 14);
  stripe.translate(0, 0.1, 0);
  geos.push(stripe);
  bones.Hips.add(new THREE.Mesh(stripe, materials.stripe));
  for (const side of ["Left", "Right"] as const) {
    seg(`${side}Shoulder`, `${side}Arm`, 0.06, 0.07, materials.skin);
    seg(`${side}Arm`, `${side}ForeArm`, 0.065, 0.05, materials.skin);
    seg(`${side}ForeArm`, `${side}Hand`, 0.05, 0.04, materials.skin);
    seg(`${side}UpLeg`, `${side}Leg`, 0.095, 0.065, materials.skin);
    const thighTrunk = new THREE.CylinderGeometry(0.1, 0.11, 0.2, 10);
    thighTrunk.translate(0, -0.1, 0);
    geos.push(thighTrunk);
    bones[`${side}UpLeg`].add(new THREE.Mesh(thighTrunk, materials.trunks));
    seg(`${side}Leg`, `${side}Foot`, 0.062, 0.045, materials.skin);
    const sock = new THREE.CylinderGeometry(0.05, 0.05, 0.12, 10);
    sock.translate(0, 0.02, 0);
    geos.push(sock);
    bones[`${side}Foot`].add(new THREE.Mesh(sock, materials.socks));
  }
  const headC = abs("Head").add(new THREE.Vector3(0.01, 0.1, 0));
  return finishRig(body, bones, materials, "code",
    { center: headC, radius: 0.12, frontX: headC.x + 0.12, eyeY: headC.y + 0.01 }, geos);
}
