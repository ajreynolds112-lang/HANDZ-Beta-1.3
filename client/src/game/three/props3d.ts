/**
 * Arena props: Tripo-generated GLB models when they exist, code-built stand-ins
 * otherwise.
 *
 * Every prop type is drawn as instanced meshes — one draw call per material
 * part no matter how many chairs or pads are placed — so the arena stays cheap.
 * A prop slot starts with its stand-in and is swapped in place once (and only
 * if) its GLB loads, so a missing or broken model never leaves a hole.
 */
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { PROP_CATALOG, PROP_MANIFEST_URL, type PropManifest, type PropSpec } from "./propCatalog";

export interface PropPlacement {
  x: number;
  y: number;
  z: number;
  rotY: number;
  /** Optional per-instance tint (multiplies the model's colours). */
  tint?: string;
  scale?: number;
}

/** A renderable piece of a prop: geometry already in prop-local space. */
export interface PropPart {
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
}

/** Bake a box/cylinder/etc. into prop space with a flat vertex colour. */
export function coloredPart(geo: THREE.BufferGeometry, color: string, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0): THREE.BufferGeometry {
  const g = geo.index ? geo.toNonIndexed() : geo;
  g.deleteAttribute("uv");
  const m = new THREE.Matrix4().compose(
    new THREE.Vector3(x, y, z),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)),
    new THREE.Vector3(1, 1, 1),
  );
  g.applyMatrix4(m);
  const c = new THREE.Color(color);
  const n = g.getAttribute("position").count;
  const colors = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  g.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  return g;
}

/** Merge baked parts into one vertex-coloured stand-in geometry. */
export function mergeParts(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const merged = mergeGeometries(parts, false);
  if (!merged) throw new Error("stand-in geometry merge failed");
  for (const p of parts) p.dispose();
  return merged;
}

const standInMaterial = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.75, metalness: 0.1 });

/**
 * One prop type in the scene: a group of instanced meshes, one per part.
 * Starts on the stand-in and is rebuilt when a model arrives.
 */
export class PropSlot {
  readonly group = new THREE.Group();
  private meshes: THREE.InstancedMesh[] = [];
  private usingModel = false;
  /** Per-placement visibility (null = all shown); hidden ones get a zero scale. */
  private shown: boolean[] | null = null;

  constructor(
    readonly id: string,
    private placements: PropPlacement[],
    standIn: THREE.BufferGeometry,
    private castShadow = false,
  ) {
    this.group.name = `prop:${id}`;
    this.build([{ geometry: standIn, material: standInMaterial }]);
  }

  get hasModel(): boolean {
    return this.usingModel;
  }

  useModel(parts: PropPart[]): void {
    this.clear(true);
    this.usingModel = true;
    this.build(parts);
  }

  /** Re-tint placements (palette changes) without rebuilding. */
  setTints(tints: (string | undefined)[]): void {
    for (let i = 0; i < this.placements.length; i++) this.placements[i].tint = tints[i];
    const c = new THREE.Color();
    for (const mesh of this.meshes) {
      for (let i = 0; i < this.placements.length; i++) {
        c.set(this.placements[i].tint ?? "#ffffff");
        mesh.setColorAt(i, c);
      }
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
  }

  /** Show or hide individual placements (e.g. trophies filling a case) without rebuilding. */
  setShown(shown: boolean[]): void {
    if (this.shown && this.shown.length === shown.length && this.shown.every((v, i) => v === shown[i])) return;
    this.shown = shown.slice();
    const m = new THREE.Matrix4();
    for (const mesh of this.meshes) {
      this.placements.forEach((p, i) => { this.composeAt(p, i, m); mesh.setMatrixAt(i, m); });
      mesh.instanceMatrix.needsUpdate = true;
    }
  }

  private composeAt(p: PropPlacement, i: number, out: THREE.Matrix4): void {
    const s = this.shown && this.shown[i] === false ? 0 : (p.scale ?? 1);
    out.compose(
      new THREE.Vector3(p.x, p.y, p.z),
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), p.rotY),
      new THREE.Vector3(s, s, s),
    );
  }

  private build(parts: PropPart[]): void {
    const m = new THREE.Matrix4();
    const c = new THREE.Color();
    for (const part of parts) {
      const mesh = new THREE.InstancedMesh(part.geometry, part.material, this.placements.length);
      this.placements.forEach((p, i) => {
        this.composeAt(p, i, m);
        mesh.setMatrixAt(i, m);
        c.set(p.tint ?? "#ffffff");
        mesh.setColorAt(i, c);
      });
      mesh.instanceMatrix.needsUpdate = true;
      mesh.castShadow = this.castShadow;
      mesh.receiveShadow = true;
      this.meshes.push(mesh);
      this.group.add(mesh);
    }
  }

  private clear(disposeGeometry: boolean): void {
    for (const mesh of this.meshes) {
      this.group.remove(mesh);
      if (disposeGeometry) mesh.geometry.dispose();
      mesh.dispose();
    }
    this.meshes = [];
  }

  dispose(): void {
    this.clear(true);
  }
}

/** Flatten a loaded GLB into fitted, prop-space parts. */
function partsFromModel(root: THREE.Object3D, spec: PropSpec): PropPart[] {
  if (spec.yawOffset) root.rotation.y += spec.yawOffset;
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root);
  const size = box.getSize(new THREE.Vector3());
  const extent = size[spec.fitAxis];
  if (!(extent > 0)) return [];
  const s = spec.size / extent;
  const center = box.getCenter(new THREE.Vector3());
  // Scale uniformly, centre on x/z, stand on y = 0.
  const fit = new THREE.Matrix4()
    .makeScale(s, s, s)
    .premultiply(new THREE.Matrix4().makeTranslation(-center.x * s, -box.min.y * s, -center.z * s));
  const parts: PropPart[] = [];
  root.traverse(obj => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    const geo = mesh.geometry.clone();
    geo.applyMatrix4(new THREE.Matrix4().multiplyMatrices(fit, mesh.matrixWorld));
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    // Multi-material meshes are rare in these exports; take the first.
    parts.push({ geometry: geo, material: mats[0] });
  });
  return parts;
}

/**
 * Fitted parts per prop id, loaded once per page. Every scene (gym home,
 * sparring, arena, menu ring) draws from this one cache, so a scene built after
 * the preload finishes gets its models on the first frame instead of popping
 * them in over the stand-ins.
 */
let fittedCache: Map<string, PropPart[]> | null = null;
let fittedPromise: Promise<Map<string, PropPart[]>> | null = null;

/** Start (or join) the one-time GLB load. Resolves once every model is fitted or failed. */
export function preloadGeneratedProps(): Promise<Map<string, PropPart[]>> {
  if (fittedPromise) return fittedPromise;
  fittedPromise = (async () => {
    const out = new Map<string, PropPart[]>();
    let manifest: PropManifest;
    try {
      const res = await fetch(PROP_MANIFEST_URL, { cache: "no-cache" });
      if (!res.ok) return out;
      manifest = await res.json();
    } catch {
      return out;
    }
    if (!Array.isArray(manifest?.assets) || manifest.assets.length === 0) return out;
    const loader = new GLTFLoader();
    await Promise.all(manifest.assets.map(async entry => {
      const spec = PROP_CATALOG.find(p => p.id === entry.id);
      if (!spec) return;
      try {
        const gltf = await loader.loadAsync(`/models/${entry.file}`);
        const parts = partsFromModel(gltf.scene, spec);
        if (parts.length > 0) out.set(entry.id, parts);
      } catch (err) {
        console.warn(`[3D] prop "${entry.id}" failed to load, keeping stand-in`, err);
      }
    }));
    return out;
  })().then(m => { fittedCache = m; return m; });
  return fittedPromise;
}

function applyFitted(slots: Map<string, PropSlot>, fitted: Map<string, PropPart[]>): void {
  slots.forEach((slot, id) => {
    const parts = fitted.get(id);
    // Slots dispose their geometry, so each one gets its own copy; materials are shared.
    if (parts) slot.useModel(parts.map(p => ({ geometry: p.geometry.clone(), material: p.material })));
  });
}

/**
 * Hand every slot its generated model. Synchronous when the preload has already
 * finished; otherwise the stand-ins show until it does. Failures leave the
 * stand-in in place.
 */
export async function loadGeneratedProps(slots: Map<string, PropSlot>, isCancelled: () => boolean): Promise<void> {
  if (fittedCache) { applyFitted(slots, fittedCache); return; }
  const fitted = await preloadGeneratedProps();
  if (isCancelled()) return;
  applyFitted(slots, fitted);
}

/** One prop's fitted GLB parts from the shared cache (undefined if it has no model). Shared: clone before mutating. */
export async function getFittedPropParts(id: string): Promise<PropPart[] | undefined> {
  return (fittedCache ?? await preloadGeneratedProps()).get(id);
}
