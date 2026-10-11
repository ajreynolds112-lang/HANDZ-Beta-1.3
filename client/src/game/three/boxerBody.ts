/**
 * The textured boxer body (client/public/models/boxer/): an Unreal-mannequin
 * skeleton FBX with its own gloves, trim, shoes and headgear as separate
 * skinned meshes, plus eyeballs from a second FBX. No animation clips: the
 * pose driver moves the bones exactly as it does for every other rig.
 *
 * Loaded once, then each fighter clones it. At load the gear meshes (which
 * come bound to their own duplicate bone copies) are re-bound to the body's
 * skeleton by bone name so one skeleton drives everything; the headgear
 * becomes rigid on the head so it can be shown and hidden as one object.
 *
 * Colour: the skin texture has its reference skin tone divided out, so the
 * material colour sets the tone (×2: the texture's reference sits at 0.5).
 * The gear atlas has its red areas turned to neutral grey with a mask of where
 * the gear colour applies; a small shader patch tints only masked texels.
 */
import * as THREE from "three";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { clone as cloneSkinned } from "three/examples/jsm/utils/SkeletonUtils.js";
import { cssColorOf } from "../spacialColor";
import { buildGirdleGeometry, girdleBandMaterial } from "./boxerGirdle";
import { type BoneName, type Region, type RigInstance, RIG_HEIGHT, attachAtBind, newMaterials, relPos } from "./fighterRig";

export const BOXER_DIR = "/models/boxer/";

/** Unreal mannequin bone → canonical bone. */
const UE_BONES: Record<string, BoneName> = {
  pelvis: "Hips", spine_01: "Spine", spine_02: "Spine1", spine_03: "Spine2", neck_01: "Neck", head: "Head",
  clavicle_l: "LeftShoulder", upperarm_l: "LeftArm", lowerarm_l: "LeftForeArm", hand_l: "LeftHand",
  clavicle_r: "RightShoulder", upperarm_r: "RightArm", lowerarm_r: "RightForeArm", hand_r: "RightHand",
  thigh_l: "LeftUpLeg", calf_l: "LeftLeg", foot_l: "LeftFoot", ball_l: "LeftToeBase",
  thigh_r: "RightUpLeg", calf_r: "RightLeg", foot_r: "RightFoot", ball_r: "RightToeBase",
};

const GLOVES = ["BM7ARM5", "BM7ARM7"];
const TRIM = ["BM7ARM9", "BM7ARM11"];
const SHOES = ["BM7ARM19"];
const HEADGEAR = ["BM7ARM3", "BM7ARM29", "BM7ARM31"];
/** Face morphs kept from the body (the rest are dropped at load). */
const MORPHS = {
  blinkL: "eyeblinkleft", blinkR: "eyebkinkright", squintL: "eyesquintleft", squintR: "eyeSquintRight",
} as const;

interface BoxerTextures {
  skinLight: THREE.Texture; skinDark: THREE.Texture; skinNormal: THREE.Texture; eyes: THREE.Texture;
  gear: THREE.Texture; gearMask: THREE.Texture; gearNormal: THREE.Texture;
  shorts: THREE.Texture; shortsNormal: THREE.Texture;
}

export interface BoxerTemplate {
  scene: THREE.Group;
  boneMap: Map<string, BoneName>;
  tex: BoxerTextures;
  /** Rigid headgear pieces, baked in the template scene's space. */
  headgearGeo: THREE.BufferGeometry;
  /** Body-space results from the first build (same for every instance). */
  cache?: { headgear: THREE.BufferGeometry; center: THREE.Vector3; hands: { left: THREE.Vector3; right: THREE.Vector3 } };
}

/** Load the FBXs and textures and prepare the shared template. */
/** `girdle` is a full URL to the Tripo girdle shell (optional; no girdle if it fails). */
export async function loadBoxerTemplate(files: { body: string; eyes?: string; girdle?: string }): Promise<BoxerTemplate> {
  const fbx = new FBXLoader();
  const tl = new THREE.TextureLoader();
  const tex = (f: string, srgb: boolean) => tl.loadAsync(BOXER_DIR + f).then(t => {
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.anisotropy = 4;
    return t;
  });
  const [main, eyes, girdleSrc, ...t] = await Promise.all([
    fbx.loadAsync(BOXER_DIR + files.body),
    files.eyes ? fbx.loadAsync(BOXER_DIR + files.eyes) : Promise.resolve(null),
    files.girdle
      ? new GLTFLoader().loadAsync(files.girdle).then(g => g.scene, err => { console.warn("[3D] girdle unavailable", err); return null; })
      : Promise.resolve(null),
    tex("skin_light.jpg", true), tex("skin_dark.jpg", true), tex("skin_normal.jpg", false), tex("eyes.jpg", true),
    tex("gear.jpg", true), tex("gear_regions.png", false), tex("gear_normal.jpg", false),
    tex("shorts.jpg", true), tex("shorts_normal.jpg", false),
  ]);
  const textures: BoxerTextures = {
    skinLight: t[0], skinDark: t[1], skinNormal: t[2], eyes: t[3],
    gear: t[4], gearMask: t[5], gearNormal: t[6], shorts: t[7], shortsNormal: t[8],
  };

  main.updateMatrixWorld(true);
  const body = main.getObjectByName("blendshape51") as THREE.SkinnedMesh | undefined;
  if (!body?.isSkinnedMesh) throw new Error("boxer body mesh not found");
  const skel = body.skeleton;
  const boneIndex = new Map<string, number>();
  skel.bones.forEach((b, i) => { if (!boneIndex.has(b.name)) boneIndex.set(b.name, i); });
  const bodyInv = new THREE.Matrix4().copy(body.matrixWorld).invert().premultiply(body.bindMatrixInverse);

  keepMorphs(body);

  // Gear: re-bind to the body skeleton by name, or bake rigid (headgear).
  const parent = body.parent!;
  const headgearParts: THREE.BufferGeometry[] = [];
  const rebind = (m: THREE.SkinnedMesh, role: string) => {
    const baked = bakeBind(m);
    if (role === "headgear") { headgearParts.push(baked); return; }
    const si = baked.getAttribute("skinIndex");
    const sw = baked.getAttribute("skinWeight");
    const rigid = role === "glove" || role === "trim";
    let left = 0;
    if (rigid) {
      for (let k = 0; k < si.count; k++) if (m.skeleton.bones[si.getComponent(k, 0)]?.name.endsWith("_l")) left++;
      extendCuff(baked, left * 2 > si.count ? "l" : "r");
    }
    baked.applyMatrix4(bodyInv);
    if (rigid) {
      // A glove is rigid: the whole glove and its cuff ride the hand alone, so
      // turning the wrist turns the glove instead of wringing its cuff.
      const hand = boneIndex.get(left * 2 > si.count ? "hand_l" : "hand_r")!;
      for (let k = 0; k < si.count; k++) { si.setXYZW(k, hand, 0, 0, 0); sw.setXYZW(k, 1, 0, 0, 0); }
    } else for (let k = 0; k < si.count; k++) {
      for (let c = 0; c < 4; c++) {
        let b: THREE.Object3D | null = m.skeleton.bones[si.getComponent(k, c)] ?? null;
        while (b && !boneIndex.has(b.name)) b = b.parent;
        si.setComponent(k, c, b ? boneIndex.get(b.name)! : 0);
      }
    }
    const out = new THREE.SkinnedMesh(baked, new THREE.MeshBasicMaterial());
    out.name = `boxer:${role}:${m.name}`;
    parent.add(out);
    out.bind(skel, body.bindMatrix);
  };
  const gearMeshes: [THREE.SkinnedMesh, string][] = [];
  main.traverse(o => {
    const m = o as THREE.SkinnedMesh;
    if (!m.isSkinnedMesh || m === body) return;
    const role = GLOVES.includes(m.name) ? "glove" : TRIM.includes(m.name) ? "trim"
      : SHOES.includes(m.name) ? "shoe" : HEADGEAR.includes(m.name) ? "headgear" : null;
    if (role) gearMeshes.push([m, role]);
  });
  if (!gearMeshes.some(([, r]) => r === "glove")) throw new Error("boxer gloves not found");
  for (const [m, role] of gearMeshes) rebind(m, role);
  if (eyes) {
    eyes.updateMatrixWorld(true);
    const list: THREE.SkinnedMesh[] = [];
    eyes.traverse(o => { if ((o as THREE.SkinnedMesh).isSkinnedMesh) list.push(o as THREE.SkinnedMesh); });
    for (const m of list) rebind(m, "eye");
  }
  // Drop the gear's duplicate bone copies and its original meshes.
  for (const c of [...main.children]) if (c !== body && c !== skel.bones[0]?.parent && !c.name.startsWith("boxer:")) {
    let holdsBones = false;
    c.traverse(o => { if (o === skel.bones[0]) holdsBones = true; });
    if (!holdsBones) main.remove(c);
  }
  const headgearGeo = mergeSimple(headgearParts);
  if (girdleSrc) {
    // Built against the body's own materials (skipping the hidden tank top).
    const geo = buildGirdleGeometry(girdleSrc, body, "blinn21");
    if (geo) {
      const g = new THREE.SkinnedMesh(geo, [new THREE.MeshBasicMaterial(), new THREE.MeshBasicMaterial()]);
      g.name = "boxer:girdle:shell";
      parent.add(g);
      g.bind(skel, body.bindMatrix);
    }
  }
  shortenForearms(main, skel);

  const boneMap = new Map<string, BoneName>();
  for (const b of skel.bones) { const cb = UE_BONES[b.name]; if (cb) boneMap.set(b.name, cb); }
  const missing = Object.values(UE_BONES).filter(b => !Array.from(boneMap.values()).includes(b));
  if (missing.length) throw new Error(`boxer rig is missing bones: ${missing.join(", ")}`);
  return { scene: main, boneMap, tex: textures, headgearGeo };
}

/**
 * Wrist strap length: the glove cuff (and its strap) is pushed down the forearm
 * so the cuff is ~0.42x the glove body, like the user's reference glove. Axis
 * and centre = each glove's long axis in the FBX bind world (measured offline);
 * the stretch sits between the cuff label and the opening so neither distorts.
 */
const CUFF_AXIS = { l: { c: [59.65, 103.32, 3.31], v: [-0.379, 0.861, -0.34] }, r: { c: [-60, 103.19, 3.39], v: [0.409, 0.851, -0.33] } };
const CUFF_EXTEND = 1.7, CUFF_RAMP0 = 10.4, CUFF_RAMP1 = 11.4;

function extendCuff(g: THREE.BufferGeometry, side: "l" | "r"): void {
  const { c, v } = CUFF_AXIS[side];
  const pos = g.getAttribute("position") as THREE.BufferAttribute;
  for (let k = 0; k < pos.count; k++) {
    const x = pos.getX(k), y = pos.getY(k), z = pos.getZ(k);
    const t = (x - c[0]) * v[0] + (y - c[1]) * v[1] + (z - c[2]) * v[2];
    const d = CUFF_EXTEND * THREE.MathUtils.clamp((t - CUFF_RAMP0) / (CUFF_RAMP1 - CUFF_RAMP0), 0, 1);
    if (d > 0) pos.setXYZ(k, x + v[0] * d, y + v[1] * d, z + v[2] * d);
  }
}

/** Forearm length relative to the source model (the upper arm is untouched). */
const FOREARM_SCALE = 0.9;

/**
 * Shortens both forearms in the BIND pose, once per load: the bones below the
 * elbow move up the forearm, every vertex skinned below the elbow slides with
 * them (proportionally along elbow→wrist, the hand and glove rigidly), and the
 * bone inverses are shifted to match. Works off the bind matrices, so it does
 * not care what pose the loaded scene is in.
 */
function shortenForearms(main: THREE.Object3D, skel: THREE.Skeleton): void {
  const meshes: THREE.SkinnedMesh[] = [];
  main.traverse(o => { const m = o as THREE.SkinnedMesh; if (m.isSkinnedMesh && m.skeleton === skel) meshes.push(m); });
  const firstNamed = (name: string) => { let hit: THREE.Object3D | null = null; main.traverse(o => { if (!hit && o.name === name) hit = o; }); return hit as THREE.Object3D | null; };
  const bindWorld = (name: string) => {
    const j = skel.bones.findIndex(b => b.name === name);
    return j < 0 ? null : new THREE.Matrix4().copy(skel.boneInverses[j]).invert();
  };
  const deltas = new Map<number, THREE.Vector3>(); // skel bone index → bind-world shift
  const arms: { E: THREE.Vector3; dir: THREE.Vector3; len: number; dH: THREE.Vector3; members: Set<number> }[] = [];
  for (const s of ["l", "r"]) {
    const fore = firstNamed(`lowerarm_${s}`), foreBind = bindWorld(`lowerarm_${s}`), handBind = bindWorld(`hand_${s}`);
    if (!fore || !foreBind || !handBind) continue;
    const rot = new THREE.Matrix3().setFromMatrix4(foreBind);
    const members = new Set<number>();
    skel.bones.forEach((b, j) => {
      // Shift = the forearm-level ancestor's local offset shortened, in bind world.
      let o: THREE.Object3D | null = b;
      while (o && o.parent !== fore) o = o.parent;
      if (!o) { if (b === fore) members.add(j); return; }
      members.add(j);
      deltas.set(j, o.position.clone().multiplyScalar(FOREARM_SCALE - 1).applyMatrix3(rot));
    });
    const E = new THREE.Vector3().setFromMatrixPosition(foreBind), H = new THREE.Vector3().setFromMatrixPosition(handBind);
    const dir = H.clone().sub(E);
    const len = dir.length();
    if (len < 1e-6) continue;
    dir.divideScalar(len);
    arms.push({ E, dir, len, dH: H.sub(E).multiplyScalar(FOREARM_SCALE - 1), members });
  }
  if (arms.length === 0) return;

  const v = new THREE.Vector3(), d = new THREE.Vector3();
  for (const mesh of meshes) {
    const geo = mesh.geometry;
    const pos = geo.attributes.position, si = geo.attributes.skinIndex, sw = geo.attributes.skinWeight;
    for (let k = 0; k < pos.count; k++) {
      v.fromBufferAttribute(pos, k).applyMatrix4(mesh.bindMatrix);
      let moved = false;
      for (const a of arms) {
        let w = 0;
        for (let c = 0; c < 4; c++) if (a.members.has(si.getComponent(k, c))) w += sw.getComponent(k, c);
        if (w <= 0) continue;
        const t = THREE.MathUtils.clamp(d.copy(v).sub(a.E).dot(a.dir) / a.len, 0, 1);
        v.addScaledVector(a.dH, t * w);
        moved = true;
      }
      if (!moved) continue;
      v.applyMatrix4(mesh.bindMatrixInverse);
      pos.setXYZ(k, v.x, v.y, v.z);
    }
    pos.needsUpdate = true;
    geo.computeBoundingBox();
    geo.computeBoundingSphere();
  }
  // Bones: the live hierarchy (the pose driver measures arm lengths off it) and the bind.
  for (const s of ["l", "r"]) firstNamed(`lowerarm_${s}`)?.children.forEach(c => c.position.multiplyScalar(FOREARM_SCALE));
  const shift = new THREE.Matrix4();
  deltas.forEach((dl, j) => skel.boneInverses[j].multiply(shift.makeTranslation(-dl.x, -dl.y, -dl.z)));
  main.updateMatrixWorld(true);
}

/** Keep only the face morphs we drive. */
function keepMorphs(body: THREE.SkinnedMesh): void {
  const dict = body.morphTargetDictionary ?? {};
  const g = body.geometry;
  const wanted = Object.values(MORPHS);
  const find = (n: string) => Object.keys(dict).find(k => k.toLowerCase().endsWith("." + n.toLowerCase()));
  const keep = wanted.map(find);
  const idx = keep.map(k => (k ? dict[k] : -1));
  const ma = g.morphAttributes as Record<string, THREE.BufferAttribute[]>;
  for (const key of Object.keys(ma)) {
    const arr = ma[key];
    ma[key] = idx.filter(i => i >= 0).map(i => arr[i]);
  }
  const nd: Record<string, number> = {};
  let n = 0;
  wanted.forEach((w, i) => { if (idx[i] >= 0) nd[w] = n++; });
  if (n === 0) { g.morphAttributes = {}; }
  body.morphTargetDictionary = nd;
  body.morphTargetInfluences = new Array(n).fill(0);
}

/** A skinned mesh's bind-pose vertices in world space (non-indexed copy). */
function bakeBind(m: THREE.SkinnedMesh): THREE.BufferGeometry {
  const g = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone();
  g.morphAttributes = {};
  const pos = g.getAttribute("position") as THREE.BufferAttribute;
  const nor = g.getAttribute("normal") as THREE.BufferAttribute | undefined;
  const nm = new THREE.Matrix3().getNormalMatrix(m.matrixWorld);
  const v = new THREE.Vector3();
  for (let k = 0; k < pos.count; k++) {
    m.applyBoneTransform(k, v.fromBufferAttribute(pos, k));
    v.applyMatrix4(m.matrixWorld);
    pos.setXYZ(k, v.x, v.y, v.z);
    if (nor) { v.fromBufferAttribute(nor, k).applyMatrix3(nm).normalize(); nor.setXYZ(k, v.x, v.y, v.z); }
  }
  g.clearGroups();
  return g;
}

/** Concatenate non-indexed geometries' position/normal/uv. */
function mergeSimple(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const out = new THREE.BufferGeometry();
  for (const [name, size] of [["position", 3], ["normal", 3], ["uv", 2]] as const) {
    if (!parts.every(p => p.getAttribute(name))) continue;
    const total = parts.reduce((s, p) => s + p.getAttribute(name).count, 0);
    const arr = new Float32Array(total * size);
    let off = 0;
    for (const p of parts) {
      const a = p.getAttribute(name);
      for (let k = 0; k < a.count; k++) for (let c = 0; c < size; c++) arr[off++] = a.getComponent(k, c);
    }
    out.setAttribute(name, new THREE.BufferAttribute(arr, size));
  }
  for (const p of parts) p.dispose();
  return out;
}

// ───────────────────────── masked tint ─────────────────────────

export interface MaskedTint {
  tint: { value: THREE.Color };
  spacialOn: { value: number };
  spacialMap: { value: THREE.Texture | null };
}

/**
 * Region mask (gear_regions.png): r = the piece's own colour, g = its secondary
 * (Gear Decal on gloves/headgear, Soles = the shoe's white), b = laces. g/b
 * repaint by texel brightness; their colours ride other regions' materials
 * (`linkedTints`). `darkLift` (the trim strap) colours the dark base instead; b on the glove = its cuff band, tinted with the strap.
 */
function maskedTintMaterial(map: THREE.Texture, mask: THREE.Texture, normal: THREE.Texture, roughness: number, darkLift = false): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ map, normalMap: normal, roughness, metalness: 0 });
  mat.normalScale.set(1, -1);
  const u = {
    tint: { value: new THREE.Color(1, 1, 1) }, tint2: { value: new THREE.Color(1, 1, 1) }, tint3: { value: new THREE.Color(1, 1, 1) },
    spacialOn: { value: 0 }, spacialMap: { value: null as THREE.Texture | null }, tintMask: { value: mask }, darkLift: { value: darkLift ? 1 : 0 },
  };
  mat.userData.maskedTint = u;
  mat.onBeforeCompile = sh => {
    Object.assign(sh.uniforms, { tintColor: u.tint, tint2Color: u.tint2, tint3Color: u.tint3, spacialOn: u.spacialOn, spacialMap: u.spacialMap, tintMask: u.tintMask, darkLift: u.darkLift });
    sh.fragmentShader = "uniform vec3 tintColor;\nuniform vec3 tint2Color;\nuniform vec3 tint3Color;\nuniform float spacialOn;\nuniform float darkLift;\nuniform sampler2D spacialMap;\nuniform sampler2D tintMask;\n"
      + sh.fragmentShader.replace("#include <map_fragment>", `#include <map_fragment>
  vec3 tintM3 = texture2D(tintMask, vMapUv).rgb;
  float tintM = tintM3.r;
  float tintL = min(1.0, dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722)) * 1.35);
  vec3 tinted = darkLift > 0.5 ? tintColor * min(1.0, 0.75 + tintL) : diffuseColor.rgb * tintColor;
  diffuseColor.rgb = mix(diffuseColor.rgb, tinted, tintM);
  diffuseColor.rgb = mix(diffuseColor.rgb, tint2Color * tintL, tintM3.g);
  diffuseColor.rgb = mix(diffuseColor.rgb, tint3Color * tintL, tintM3.b);
  if (spacialOn > 0.5) diffuseColor.rgb = mix(diffuseColor.rgb, texture2D(spacialMap, gl_FragCoord.xy / 110.0).rgb, tintM);`);
  };
  mat.customProgramCacheKey = () => "boxerMaskedTint";
  return mat;
}

// ───────────────────────── instance ─────────────────────────

/** Sock top height in the body's bind space (model units, feet at 0). */
const SOCK_TOP = 31;

export function buildBoxerRig(t: BoxerTemplate): RigInstance {
  const model = cloneSkinned(t.scene) as THREE.Group;
  const bones = {} as Record<BoneName, THREE.Object3D>;
  model.traverse(o => {
    const cb = t.boneMap.get(o.name);
    if (cb && (o as THREE.Bone).isBone && !bones[cb]) bones[cb] = o;
  });
  const skinned: THREE.SkinnedMesh[] = [];
  model.traverse(o => { if ((o as THREE.SkinnedMesh).isSkinnedMesh) skinned.push(o as THREE.SkinnedMesh); });
  const body = skinned.find(m => m.name === "blendshape51");
  if (!body) throw new Error("boxer body missing from clone");
  const role = (m: THREE.SkinnedMesh) => m.name.split(":")[1] ?? "body";

  // Orient: forward = cross(characterLeft, up); scale to RIG_HEIGHT; feet at 0.
  const orient = new THREE.Group();
  orient.add(model);
  const root = new THREE.Group();
  root.add(orient);
  root.updateMatrixWorld(true);
  const p = (b: BoneName) => relPos(bones[b], root);
  const up = p("Head").sub(p("Hips")).normalize();
  const left = p("LeftArm").sub(p("RightArm")).normalize();
  const fwd = new THREE.Vector3().crossVectors(left, up).normalize();
  const right = new THREE.Vector3().crossVectors(fwd, up).normalize();
  orient.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(fwd, up, right).invert());
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(body, true);
  orient.scale.setScalar(RIG_HEIGHT / Math.max(0.01, box.max.y - box.min.y));
  root.updateMatrixWorld(true);
  const box2 = new THREE.Box3().setFromObject(body, true);
  orient.position.y = -box2.min.y;
  orient.position.x = -p("Hips").x;
  orient.position.z = -p("Hips").z;
  root.updateMatrixWorld(true);

  // Body-space gear metrics, once per template.
  if (!t.cache) {
    const toBody = new THREE.Matrix4().copy(root.matrixWorld).invert().multiply(model.matrixWorld);
    const hg = t.headgearGeo.clone().applyMatrix4(toBody);
    hg.computeBoundingBox();
    const center = hg.boundingBox!.getCenter(new THREE.Vector3());
    hg.translate(-center.x, -center.y, -center.z);
    const sums = { left: new THREE.Vector3(), right: new THREE.Vector3() }, ns = { left: 0, right: 0 };
    const lz = p("LeftHand").z;
    for (const m of skinned) {
      if (role(m) !== "glove") continue;
      const g = m.geometry.getAttribute("position");
      const c = new THREE.Vector3(), v = new THREE.Vector3();
      for (let k = 0; k < g.count; k++) {
        m.applyBoneTransform(k, v.fromBufferAttribute(g, k));
        c.add(v.applyMatrix4(m.matrixWorld));
      }
      c.divideScalar(Math.max(1, g.count)).applyMatrix4(new THREE.Matrix4().copy(root.matrixWorld).invert());
      const side = Math.sign(c.z) === Math.sign(lz) ? "left" : "right";
      sums[side].add(c); ns[side]++;
    }
    const hands = {
      left: ns.left ? sums.left.divideScalar(ns.left) : p("LeftHand"),
      right: ns.right ? sums.right.divideScalar(ns.right) : p("RightHand"),
    };
    t.cache = { headgear: hg, center, hands };
  }
  const C = t.cache;

  // Materials: the fighter tints each region.
  const T = t.tex;
  const materials = newMaterials();
  const tex = (m: THREE.MeshStandardMaterial, map: THREE.Texture, normal: THREE.Texture) => {
    m.map = map; m.normalMap = normal; m.normalScale.set(1, -1); m.needsUpdate = true;
  };
  tex(materials.skin, T.skinLight, T.skinNormal);
  tex(materials.trunks, T.shorts, T.shortsNormal);
  materials.glove.dispose(); materials.shoe.dispose(); materials.headgear.dispose(); materials.tape.dispose();
  materials.glove = maskedTintMaterial(T.gear, T.gearMask, T.gearNormal, 0.4);
  materials.shoe = maskedTintMaterial(T.gear, T.gearMask, T.gearNormal, 0.55);
  materials.headgear = maskedTintMaterial(T.gear, T.gearMask, T.gearNormal, 0.5);
  materials.tape = maskedTintMaterial(T.gear, T.gearMask, T.gearNormal, 0.8, true);
  materials.headgear.side = THREE.DoubleSide;
  const sub = (m: THREE.Material) => m.userData.maskedTint as { tint2: { value: THREE.Color }; tint3: { value: THREE.Color } };
  materials.decal.userData.linkedTints = [sub(materials.glove).tint2, sub(materials.headgear).tint2];
  materials.sole.userData.linkedTints = [sub(materials.shoe).tint2];
  materials.laces.userData.linkedTints = [sub(materials.shoe).tint3];
  // The wrist strap is the glove's cuff band (blue on the glove) plus the trim piece.
  materials.tape.userData.linkedTints = [sub(materials.glove).tint3];
  // Socks: the body has no sock mesh, so the skin paints them below a height
  // line in bind space (the shoe tops reach y≈25.8 in model units).
  const girdleLaceColor = { value: new THREE.Color(1, 1, 1) };
  // The laces are painted by the band shader, so their Spacial finish rides uniforms too.
  const girdleLaceSpacial = { on: { value: 0 }, map: { value: null as THREE.Texture | null } };
  materials.girdleLaces.userData.linkedTints = [girdleLaceColor];
  materials.girdleLaces.userData.linkedSpacial = girdleLaceSpacial;
  const girdleBand = girdleBandMaterial(girdleLaceColor, girdleLaceSpacial);
  const sockColor = { value: new THREE.Color(1, 1, 1) };
  materials.socks.userData.linkedTints = [sockColor];
  materials.skin.onBeforeCompile = sh => {
    sh.uniforms.sockColor = sockColor;
    sh.vertexShader = "varying float vSockY;\n" + sh.vertexShader.replace("#include <begin_vertex>", "#include <begin_vertex>\n  vSockY = position.y;");
    sh.fragmentShader = "uniform vec3 sockColor;\nvarying float vSockY;\n" + sh.fragmentShader
      .replace("#include <map_fragment>", `#include <map_fragment>
  float sockM = step(vSockY, ${SOCK_TOP.toFixed(1)});
  diffuseColor.rgb = mix(diffuseColor.rgb, sockColor * 0.9, sockM);`)
      .replace("#include <roughnessmap_fragment>", "#include <roughnessmap_fragment>\n  roughnessFactor = mix(roughnessFactor, 0.95, sockM);");
  };
  materials.skin.customProgramCacheKey = () => "boxerSkinSocks";
  const eyeMat = new THREE.MeshStandardMaterial({ map: T.eyes, roughness: 0.25, metalness: 0 });
  const mouthMat = new THREE.MeshStandardMaterial({ color: "#4a2424", roughness: 0.7, metalness: 0 });
  const hidden = new THREE.MeshBasicMaterial({ visible: false });

  const srcMats = ([] as THREE.Material[]).concat(body.material);
  body.material = srcMats.map(m => m.name === "phong1" ? materials.trunks
    : m.name === "blinn21" ? hidden // the tank top: boxers fight bare-chested
      : m.name === "phongE1" ? mouthMat
        : materials.skin);
  const gloveMeshes: THREE.Object3D[] = [];
  let girdle: THREE.Object3D | undefined;
  for (const m of skinned) {
    const r = role(m);
    if (r === "girdle") { m.material = [materials.girdle, girdleBand]; m.visible = false; girdle = m; }
    if (r === "glove") { m.material = materials.glove; gloveMeshes.push(m); }
    else if (r === "trim") { m.material = materials.tape; gloveMeshes.push(m); }
    else if (r === "shoe") m.material = materials.shoe;
    else if (r === "eye") m.material = eyeMat;
    m.castShadow = true;
    m.frustumCulled = false;
  }

  const gloveCenter = { left: new THREE.Object3D(), right: new THREE.Object3D() };
  for (const side of ["left", "right"] as const) {
    const h = C.hands[side];
    attachAtBind(gloveCenter[side], bones[side === "left" ? "LeftHand" : "RightHand"], root, new THREE.Matrix4().makeTranslation(h.x, h.y, h.z));
  }
  const headgear = new THREE.Group();
  const hgMesh = new THREE.Mesh(C.headgear, materials.headgear);
  hgMesh.castShadow = true;
  headgear.add(hgMesh);
  headgear.visible = false;
  attachAtBind(headgear, bones.Head, root, new THREE.Matrix4().makeTranslation(C.center.x, C.center.y, C.center.z));

  const morph = body.morphTargetDictionary ?? {};
  const infl = body.morphTargetInfluences ?? [];
  const setMorph = (name: string, w: number) => { const i = morph[name]; if (i !== undefined) infl[i] = w; };
  const skinColor = new THREE.Color();

  return {
    body: root, bones, materials, gloveCenter, eyes: [], headgear, girdle, kind: "boxer",
    skinTone(css: string) {
      skinColor.set(cssColorOf(css));
      const hsl = { h: 0, s: 0, l: 0 };
      skinColor.getHSL(hsl, THREE.SRGBColorSpace);
      const map = hsl.l < 0.36 ? T.skinDark : T.skinLight;
      if (materials.skin.map !== map) materials.skin.map = map;
      materials.skin.color.copy(skinColor).multiplyScalar(2);
    },
    setEyes(state) {
      const blink = state === "closed" ? 1 : 0, squint = state === "squint" ? 0.8 : 0;
      setMorph(MORPHS.blinkL, blink); setMorph(MORPHS.blinkR, blink);
      setMorph(MORPHS.squintL, squint); setMorph(MORPHS.squintR, squint);
    },
    setRefereeMode() {
      for (const g of gloveMeshes) g.visible = false;
    },
    dispose() {
      for (const m of Object.values(materials) as THREE.Material[]) m.dispose();
      eyeMat.dispose(); mouthMat.dispose(); hidden.dispose(); girdleBand.dispose();
    },
  };
}

/** Regions whose colour this rig applies through the masked-tint uniform instead of material.color. */
export function maskedTintOf(m: THREE.Material): MaskedTint | null {
  return (m.userData?.maskedTint as MaskedTint | undefined) ?? null;
}
export type { Region };
