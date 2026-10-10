/**
 * The career gym as a 3D venue: room shell, equipment, trophy cases, the
 * equipment crate, gym lighting (day / night) and hover highlights.
 *
 * Shared by the gym home screen and every sparring bout (the ring itself comes
 * from Arena3D with its arena venue hidden). Props start as code stand-ins and
 * swap to the local GLBs in client/public/models when they load; nothing here
 * talks to Tripo. Positions and click boxes live in gymLayout.ts.
 */
import * as THREE from "three";
import { type PropPlacement, PropSlot, coloredPart, getFittedPropParts, mergeParts } from "./props3d";
import { GYM_BAG_HANG, GYM_GLOVES, GYM_OFFICE, GYM_ROOM, GYM_SPOTS, GYM_ZONE_BOXES, TROPHY_CASE, type GymZone3D } from "./gymLayout";
import { MAT_HEIGHT, RING_HALF_X, RING_HALF_Z } from "./worldMapping";
import { GYM_LOOK_DEFAULTS, type GymLook, gymLookKey } from "../gymLook";

/** What fills the trophy cases and whether the crate is open (career state). */
export interface GymDressing {
  aTrophies: number;
  aMedals: number;
  bTrophies: number;
  bMedals: number;
  crateUnlocked: boolean;
  /** Which wall glove pairs have turned gold (original, then the two behind the ring). */
  goldGloves?: [boolean, boolean, boolean];
}

// The home screen writes this; sparring bouts read the last value, like the
// 2D gym's module-level trophy/crate snapshot.
let currentDressing: GymDressing = { aTrophies: 0, aMedals: 0, bTrophies: 0, bMedals: 0, crateUnlocked: false };
export function setGymDressing(d: GymDressing): void { currentDressing = { ...d }; }
export function getGymDressing(): GymDressing { return currentDressing; }

// Career gym customisation, written by the home screen and read by every gym
// render (home and sparring), same as the dressing snapshot.
let currentLook: GymLook = {};
export function setGymLook(l: GymLook): void {
  currentLook = { ...l };
  bagUniforms.uBagOn.value = l.bagPrimary || l.bagSecondary ? 1 : 0;
  bagUniforms.uBagPrimary.value.set(l.bagPrimary ?? GYM_LOOK_DEFAULTS.bagPrimary);
  bagUniforms.uBagSecondary.value.set(l.bagSecondary ?? GYM_LOOK_DEFAULTS.bagSecondary);
  for (const [id, u] of Object.entries(propUniforms)) {
    const [ka, kb] = PROP_TINT_KEYS[id];
    u.uOn.value.set(l[ka] ? 1 : 0, kb && l[kb] ? 1 : 0);
    u.uA.value.set(l[ka] ?? GYM_LOOK_DEFAULTS[ka]);
    if (kb) u.uB.value.set(l[kb] ?? GYM_LOOK_DEFAULTS[kb]);
  }
}

/**
 * Recolouring the baked Tripo textures of the lockers, door, wooden bench and
 * bench press. Each keeps the texture's shading: the painted region (blue
 * locker steel, red bench-press frame, all bench wood, door wood) takes the
 * chosen colour scaled by the texel's brightness against that region's
 * typical value; glass, brass, white and black parts stay as baked. The door
 * leaf and its frame are told apart by their texture-atlas islands.
 */
type TintKey = "lockers" | "door" | "doorFrame" | "woodBench" | "benchPress";
const PROP_TINT_KEYS: Record<string, [TintKey, TintKey?]> = {
  gym_lockers: ["lockers"],
  gym_door: ["door", "doorFrame"],
  gym_wood_bench: ["woodBench"],
  gym_bench_press: ["benchPress"],
};
const propUniforms: Record<string, { uOn: { value: THREE.Vector2 }; uA: { value: THREE.Color }; uB: { value: THREE.Color } }> =
  Object.fromEntries(Object.keys(PROP_TINT_KEYS).map(id => [id, {
    uOn: { value: new THREE.Vector2(0, 0) },
    uA: { value: new THREE.Color(GYM_LOOK_DEFAULTS[PROP_TINT_KEYS[id][0]]) },
    uB: { value: new THREE.Color(GYM_LOOK_DEFAULTS[PROP_TINT_KEYS[id][1] ?? PROP_TINT_KEYS[id][0]]) },
  }]));
const PROP_TINT_GLSL: Record<string, string> = {
  gym_lockers: `
    float w = smoothstep(0.12, 0.3, bc.b - max(bc.r, bc.g));
    bc = mix(bc, uTintA * clamp(bc.b / 0.7, 0.25, 1.5), w * uTintOn.x);`,
  gym_bench_press: `
    float w = smoothstep(0.15, 0.35, bc.r - max(bc.g, bc.b));
    bc = mix(bc, uTintA * clamp(bc.r / 0.7, 0.25, 1.5), w * uTintOn.x);`,
  gym_wood_bench: `
    float l = dot(bc, vec3(0.2126, 0.7152, 0.0722));
    bc = mix(bc, uTintA * clamp(l / 0.21, 0.3, 1.8), uTintOn.x);`,
  gym_door: `
    float l = dot(bc, vec3(0.2126, 0.7152, 0.0722));
    float glass = smoothstep(0.0, 0.06, bc.b - bc.r);
    float brass = smoothstep(0.6, 0.72, bc.g / max(bc.r, 0.001)) * smoothstep(0.25, 0.4, bc.r);
    float wood = (1.0 - glass) * (1.0 - brass);
    vec2 uv = vMapUv;
    float leaf = (uv.x > 0.47 && uv.x < 0.765 && uv.y > 0.36) || (uv.x > 0.39 && uv.y < 0.345) ? 1.0 : 0.0;
    vec3 tint = mix(uTintB, uTintA, leaf);
    float on = mix(uTintOn.y, uTintOn.x, leaf);
    bc = mix(bc, tint * clamp(l / 0.21, 0.3, 1.8), wood * on);`,
};
function patchPropMaterial(mat: THREE.Material, id: string): void {
  if (mat.userData.tintPatched) return;
  const u = propUniforms[id];
  if (!u) return;
  mat.userData.tintPatched = true;
  mat.onBeforeCompile = shader => {
    shader.uniforms.uTintOn = u.uOn;
    shader.uniforms.uTintA = u.uA;
    shader.uniforms.uTintB = u.uB;
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nuniform vec2 uTintOn;\nuniform vec3 uTintA;\nuniform vec3 uTintB;")
      .replace("#include <color_fragment>", `#include <color_fragment>
      if (uTintOn.x + uTintOn.y > 0.5) {
        vec3 bc = diffuseColor.rgb;${PROP_TINT_GLSL[id]}
        diffuseColor.rgb = bc;
      }`);
  };
  mat.customProgramCacheKey = () => `gym-tint-${id}`;
  mat.needsUpdate = true;
}

/**
 * Wall glove pair: red leather recoloured to `tint` (null keeps it), and when
 * `gold` is on, every glove surface (not the wooden board or hooks) turns
 * polished gold.
 */
function patchGloveMaterial(mat: THREE.MeshStandardMaterial, tint: string | null, gold: { value: number }): void {
  const uTint = { value: new THREE.Color(tint ?? "#ffffff") };
  const uTintOn = { value: tint ? 1 : 0 };
  mat.onBeforeCompile = shader => {
    Object.assign(shader.uniforms, { uGloveTint: uTint, uGloveTintOn: uTintOn, uGloveGold: gold });
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nuniform vec3 uGloveTint;\nuniform float uGloveTintOn;\nuniform float uGloveGold;")
      .replace("#include <color_fragment>", `#include <color_fragment>
      vec3 gc = diffuseColor.rgb;
      // Board and hooks are orange-brown wood; everything else is glove.
      float gWood = smoothstep(0.35, 0.5, gc.g / max(gc.r, 0.001)) * smoothstep(0.08, 0.18, gc.r - gc.b);
      float gGlove = 1.0 - gWood;
      float gRed = smoothstep(0.12, 0.3, gc.r - max(gc.g, gc.b));
      gc = mix(gc, uGloveTint * clamp(gc.r / 0.6, 0.3, 1.5), gRed * uGloveTintOn);
      float gLum = dot(gc, vec3(0.2126, 0.7152, 0.0722));
      gc = mix(gc, vec3(1.0, 0.78, 0.32) * clamp(0.8 + gLum * 1.2, 0.8, 1.5), gGlove * uGloveGold);
      diffuseColor.rgb = gc;`)
      .replace("#include <roughnessmap_fragment>", "#include <roughnessmap_fragment>\n      roughnessFactor = mix(roughnessFactor, 0.35, gGlove * uGloveGold);")
      .replace("#include <metalnessmap_fragment>", "#include <metalnessmap_fragment>\n      metalnessFactor = mix(metalnessFactor, 0.55, gGlove * uGloveGold);")
      // No environment map in the gym, so a touch of self-glow keeps the metal from going black.
      .replace("#include <emissivemap_fragment>", "#include <emissivemap_fragment>\n      totalEmissiveRadiance += vec3(0.32, 0.22, 0.05) * gGlove * uGloveGold;");
  };
  mat.customProgramCacheKey = () => "gym-wall-gloves";
  mat.needsUpdate = true;
}

/** Patch a gym prop group's GLB materials for live recolouring (idempotent). */
export function patchGymPropColors(id: string, root: THREE.Object3D): void {
  if (id === "gym_hanging_bag") {
    root.traverse(o => { const m = (o as THREE.Mesh).material; if (m) for (const mat of Array.isArray(m) ? m : [m]) patchBagMaterial(mat); });
    return;
  }
  if (!propUniforms[id]) return;
  root.traverse(o => { const m = (o as THREE.Mesh).material; if (m) for (const mat of Array.isArray(m) ? m : [m]) patchPropMaterial(mat, id); });
}

/** The current career gym look (training minigames dress to match it). */
export function getGymLook(): GymLook { return currentLook; }

/** Brick-wall material for a wall `len` × `height` metres, in the current look. */
export function makeGymWallMaterial(len: number, height: number): THREE.MeshStandardMaterial {
  const t = canvasTexture(512, 512, (c, w, h) => drawWall(c, w, h, currentLook));
  t.wrapS = THREE.RepeatWrapping;
  // Same brick size as the gym's walls (one texture height per GYM_ROOM.wallH).
  t.repeat.set(len / (6 * height / GYM_ROOM.wallH), 1);
  return new THREE.MeshStandardMaterial({ map: t, roughness: 0.92 });
}

/** Rubber-mat colour, shared by the gym and the training scenes. */
export function gymMatColor(): string { return currentLook.mats ?? GYM_LOOK_DEFAULTS.mats; }

/** The career gym's custom name, if renamed (printed on the gym ring's apron). */
export function getGymRingName(): string | undefined { return currentLook.name; }

/**
 * The hanging-bag GLB is one baked texture (red leather, black tape, grey
 * metal). Recolouring keeps its shading: red texels take the primary colour,
 * dark low-saturation texels (the tape) take the secondary, grey metal stays.
 * Uniforms are module-level so a material shared through the GLB cache is
 * patched once and follows every scene.
 */
const bagUniforms = {
  uBagOn: { value: 0 },
  uBagPrimary: { value: new THREE.Color(GYM_LOOK_DEFAULTS.bagPrimary) },
  uBagSecondary: { value: new THREE.Color(GYM_LOOK_DEFAULTS.bagSecondary) },
};
function patchBagMaterial(mat: THREE.Material): void {
  if (mat.userData.bagPatched) return;
  mat.userData.bagPatched = true;
  mat.onBeforeCompile = shader => {
    Object.assign(shader.uniforms, bagUniforms);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nuniform float uBagOn;\nuniform vec3 uBagPrimary;\nuniform vec3 uBagSecondary;")
      .replace("#include <color_fragment>", `#include <color_fragment>
      if (uBagOn > 0.5) {
        vec3 bc = diffuseColor.rgb;
        float mx = max(bc.r, max(bc.g, bc.b));
        float redW = smoothstep(0.04, 0.14, bc.r - max(bc.g, bc.b));
        float darkW = (1.0 - redW) * (1.0 - smoothstep(0.05, 0.11, mx));
        // Shade relative to the texture's typical value for each region.
        vec3 prim = uBagPrimary * clamp(bc.r / 0.28, 0.25, 1.5);
        vec3 sec = uBagSecondary * clamp(mx / 0.035, 0.35, 1.6);
        bc = mix(bc, sec, darkW);
        bc = mix(bc, prim, redW);
        diffuseColor.rgb = bc;
      }`);
  };
  mat.customProgramCacheKey = () => "gym-bag-recolor";
  mat.needsUpdate = true;
}

const TROPHIES_PER_ROW = 10;
const MEDALS_PER_ROW = 14;
const HOVER_COLORS: Partial<Record<GymZone3D, string>> = {
  player: "#7fd3ff", office: "#ffd27a", equipCrate: "#ffc04d", door: "#ff8a6a",
  trophyA: "#ffe27a", trophyB: "#b9a6ff", lockers: "#8ad1ff",
};

export class GymEnvironment3D {
  readonly group = new THREE.Group();
  readonly props = new Map<string, PropSlot>();
  private lights = new THREE.Group();
  private hemi = new THREE.HemisphereLight("#fff4e0", "#5a4330", 0.95);
  private key = new THREE.DirectionalLight("#fff3dd", 1.7);
  private lamps: THREE.PointLight[] = [];
  private lampMat = new THREE.MeshStandardMaterial({ color: "#ffffff", emissive: "#fff8e8", emissiveIntensity: 1.4 });
  private monitorLight = new THREE.PointLight("#dce8ff", 0, 4.5, 1.6);
  private monitorMat = new THREE.MeshStandardMaterial({ color: "#1a2030", emissive: "#dce8ff", emissiveIntensity: 0 });
  private crateLocked = new THREE.Group();
  private crateOpen = new THREE.Group();
  private hoverGroup = new THREE.Group();
  private hoverMeshes = new Map<GymZone3D, THREE.Object3D>();
  private glowTex = makeGlowTexture();
  private night = -1;
  private disposables: { dispose(): void }[] = [];

  constructor() {
    this.group.name = "gym-venue";
    this.buildRoom();
    this.buildProps();
    this.buildTrophyCases();
    this.buildCrate();
    this.buildLights();
    this.buildHover();
    this.group.add(this.lights, this.hoverGroup);
    this.setNight(false);
  }

  // -- customisation ---------------------------------------------------------

  private wallCanvas: HTMLCanvasElement | null = null;
  private bannerCanvas: HTMLCanvasElement | null = null;
  private signCanvas: HTMLCanvasElement | null = null;
  /** Every texture sampling a redrawable canvas (wall clones share one canvas). */
  private lookTextures: THREE.Texture[] = [];
  private lookKey = gymLookKey({});

  private trackLook(t: THREE.CanvasTexture, which: "banner" | "sign"): THREE.CanvasTexture {
    if (which === "banner") this.bannerCanvas = t.image as HTMLCanvasElement;
    else this.signCanvas = t.image as HTMLCanvasElement;
    this.lookTextures.push(t);
    return t;
  }

  private applyLook(l: GymLook): void {
    for (const id of ["gym_hanging_bag", ...Object.keys(PROP_TINT_KEYS)]) {
      const slot = this.props.get(id);
      if (slot?.hasModel) patchGymPropColors(id, slot.group);
    }
    this.matMat.color.set(l.mats ?? GYM_LOOK_DEFAULTS.mats);
    this.officeMat.color.set(l.office ?? GYM_LOOK_DEFAULTS.office);
    this.trophyWoodMat.color.set(l.trophyCases ?? GYM_LOOK_DEFAULTS.trophyCases);
    const key = gymLookKey(l);
    if (key === this.lookKey) return;
    this.lookKey = key;
    const redraw = (c: HTMLCanvasElement | null, draw: (ctx: CanvasRenderingContext2D, w: number, h: number, l: GymLook) => void) => {
      if (c) draw(c.getContext("2d")!, c.width, c.height, l);
    };
    redraw(this.wallCanvas, drawWall);
    redraw(this.bannerCanvas, drawBanner);
    redraw(this.signCanvas, drawOfficeSign);
    for (const t of this.lookTextures) t.needsUpdate = true;
  }

  // -- room ----------------------------------------------------------------

  private homeOnly = new THREE.Group();
  private matMat = new THREE.MeshStandardMaterial({ color: GYM_LOOK_DEFAULTS.mats, roughness: 0.95 });
  /** The office booth's frame and lower panels. */
  private officeMat = new THREE.MeshStandardMaterial({ color: GYM_LOOK_DEFAULTS.office, roughness: 0.5, metalness: 0.4 });
  /** Trophy cases' outer wood (plinth, top, sides). */
  private trophyWoodMat = new THREE.MeshStandardMaterial({ color: GYM_LOOK_DEFAULTS.trophyCases, roughness: 0.6 });

  private buildRoom(): void {
    const R = GYM_ROOM;
    const w = R.maxX - R.minX, d = R.maxZ - R.minZ;
    const cx = (R.minX + R.maxX) / 2, cz = (R.minZ + R.maxZ) / 2;
    const floorTex = canvasTexture(512, 512, drawPlanks);
    floorTex.wrapS = floorTex.wrapT = THREE.RepeatWrapping;
    floorTex.repeat.set(w / 4, d / 4);
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(w, d), new THREE.MeshStandardMaterial({ map: floorTex, roughness: 0.62 }));
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(cx, 0, cz);
    floor.receiveShadow = true;
    this.group.add(floor);

    // Black rubber training mats under the bags and the weights corner.
    const matMat = this.matMat;
    const mats: [number, number, number, number][] = [[-11, -6.8, 7.2, 3.0], [-8.7, -2.0, 4.6, 3.2]];
    for (const [x, z, mw, md] of mats) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(mw, 0.03, md), matMat);
      m.position.set(x, 0.015, z);
      m.receiveShadow = true;
      this.group.add(m);
      this.disposables.push(m.geometry);
    }
    this.disposables.push(matMat);

    // Exposed-brick warehouse walls.
    const wallTex = canvasTexture(512, 512, (c, w, h) => drawWall(c, w, h, {}));
    wallTex.wrapS = THREE.RepeatWrapping;
    this.wallCanvas = wallTex.image as HTMLCanvasElement;
    this.lookTextures.push(wallTex);
    const wallMat = (len: number) => {
      const t = wallTex.clone();
      t.needsUpdate = true;
      this.lookTextures.push(t);
      t.repeat.set(len / 6, 1);
      this.disposables.push(t);
      return new THREE.MeshStandardMaterial({ map: t, roughness: 0.92 });
    };
    const far = new THREE.Mesh(new THREE.PlaneGeometry(d, R.wallH), wallMat(d));
    far.rotation.y = Math.PI / 2;
    far.position.set(R.minX, R.wallH / 2, cz);
    const side = new THREE.Mesh(new THREE.PlaneGeometry(w, R.wallH), wallMat(w));
    side.position.set(cx, R.wallH / 2, R.minZ);
    const near = new THREE.Mesh(new THREE.PlaneGeometry(d, R.wallH), wallMat(d));
    near.rotation.y = -Math.PI / 2;
    near.position.set(R.maxX, R.wallH / 2, cz);
    for (const m of [far, side, near]) { m.receiveShadow = true; this.group.add(m); }
    // Front wall, ceiling and trusses are home-screen only: the sparring
    // broadcast camera stands outside the room, above the ceiling line.
    const front = new THREE.Mesh(new THREE.PlaneGeometry(w, R.wallH), wallMat(w));
    front.rotation.y = Math.PI;
    front.position.set(cx, R.wallH / 2, R.maxZ);
    front.receiveShadow = true;
    this.homeOnly.add(front);
    this.group.add(this.homeOnly);

    // Dark ceiling with steel trusses running across the room.
    const ceilMat = new THREE.MeshStandardMaterial({ color: "#1b1714", roughness: 1 });
    const ceil = new THREE.Mesh(new THREE.PlaneGeometry(w, d), ceilMat);
    ceil.rotation.x = Math.PI / 2;
    ceil.position.set(cx, R.wallH, cz);
    this.homeOnly.add(ceil);
    const steel = new THREE.MeshStandardMaterial({ color: "#3b3d42", roughness: 0.55, metalness: 0.6 });
    const girder = new THREE.BoxGeometry(0.28, 0.42, d);
    for (let x = R.minX + 3; x < R.maxX; x += 4.5) {
      const g = new THREE.Mesh(girder, steel);
      g.position.set(x, R.wallH - 0.4, cz);
      this.homeOnly.add(g);
    }
    // The bag beam: one I-beam along the row of hanging bags.
    const b1 = GYM_SPOTS.bag1, b3 = GYM_SPOTS.bag3;
    const len = Math.hypot(b3.x - b1.x, b3.z - b1.z) + 2.4;
    const beam = new THREE.Mesh(new THREE.BoxGeometry(len, 0.3, 0.2), steel);
    beam.position.set((b1.x + b3.x) / 2, GYM_BAG_HANG.beamY, (b1.z + b3.z) / 2);
    beam.rotation.y = -Math.atan2(b3.z - b1.z, b3.x - b1.x);
    beam.castShadow = true;
    this.group.add(beam);
    const post = new THREE.BoxGeometry(0.12, R.wallH - GYM_BAG_HANG.beamY, 0.12);
    const ux = (b3.x - b1.x) / (len - 2.4), uz = (b3.z - b1.z) / (len - 2.4);
    for (const sgn of [-1, 1]) {
      const p = new THREE.Mesh(post, steel);
      p.position.set(beam.position.x + sgn * ux * len / 2, (R.wallH + GYM_BAG_HANG.beamY) / 2, beam.position.z + sgn * uz * len / 2);
      this.group.add(p);
    }
    this.disposables.push(ceilMat, steel, girder, post, beam.geometry, ceil.geometry);

    // High factory windows along the side wall, glowing with daylight.
    const winTex = canvasTexture(256, 160, drawWindow);
    for (const x of [-12, -6.5, -1, 4.5]) {
      const win = new THREE.Mesh(new THREE.PlaneGeometry(3.6, 2.2), new THREE.MeshBasicMaterial({ map: winTex, color: "#ffffff" }));
      win.position.set(x, 5.0, R.minZ + 0.03);
      win.name = "gym-window";
      this.group.add(win);
      this.windows.push(win);
    }
    this.disposables.push(winTex);

    // Banner high on the side wall, posters lower down, a clock over the door.
    const banner = new THREE.Mesh(new THREE.PlaneGeometry(6, 1.1),
      new THREE.MeshStandardMaterial({ map: this.trackLook(canvasTexture(1024, 188, (c, w, h) => drawBanner(c, w, h, {})), "banner"), roughness: 0.8 }));
    // Kept clear of the windows (bottom edge y=3.9): the old y=3.6 overlapped their
    // lower frames on the same wall plane and z-fought.
    banner.position.set(-9.5, 3.2, R.minZ + 0.05);
    this.group.add(banner);
    [[-14.2, 2.4, "MAIN EVENT"], [-1.2, 2.4, "FIGHT NIGHT"], [2.2, 2.4, "TITLE BOUT"]].forEach(([x, y, title]) => {
      const p = new THREE.Mesh(new THREE.PlaneGeometry(1.1, 1.5),
        new THREE.MeshStandardMaterial({ map: canvasTexture(220, 300, c => drawPoster(c, title as string)), roughness: 0.85 }));
      p.position.set(x as number, y as number, R.minZ + 0.03);
      this.group.add(p);
    });
    const clock = new THREE.Mesh(new THREE.CircleGeometry(0.32, 32),
      new THREE.MeshStandardMaterial({ map: canvasTexture(128, 128, drawClock), roughness: 0.6 }));
    clock.position.set(R.minX + 0.03, 2.95, GYM_SPOTS.door.z);
    clock.rotation.y = Math.PI / 2;
    this.group.add(clock);
    // A lit EXIT sign over the door.
    const exit = new THREE.Mesh(new THREE.PlaneGeometry(0.7, 0.26), new THREE.MeshBasicMaterial({ map: canvasTexture(140, 52, drawExit) }));
    exit.position.set(R.minX + 0.04, 2.55, GYM_SPOTS.door.z);
    exit.rotation.y = Math.PI / 2;
    this.group.add(exit);

    this.buildOffice();

    // Pendant lamps: cord, metal shade, glowing bulb. Lights are in buildLights.
    const shade = new THREE.ConeGeometry(0.45, 0.4, 16, 1, true);
    const shadeMat = new THREE.MeshStandardMaterial({ color: "#2f3a33", roughness: 0.5, metalness: 0.5, side: THREE.DoubleSide });
    const bulb = new THREE.SphereGeometry(0.14, 12, 8);
    const cord = new THREE.CylinderGeometry(0.012, 0.012, 1, 4);
    for (const [x, z] of LAMP_SPOTS) {
      const y = R.wallH - LAMP_DROP;
      const sh = new THREE.Mesh(shade, shadeMat);
      sh.position.set(x, y + 0.12, z);
      const bl = new THREE.Mesh(bulb, this.lampMat);
      bl.position.set(x, y, z);
      const cd = new THREE.Mesh(cord, steel);
      cd.scale.y = LAMP_DROP;
      cd.position.set(x, R.wallH - LAMP_DROP / 2, z);
      this.group.add(sh, bl, cd);
    }
    this.disposables.push(shade, shadeMat, bulb, cord);
  }

  private windows: THREE.Mesh[] = [];

  /** Glass-walled office booth on the far wall (desk, chair and monitor inside). */
  private buildOffice(): void {
    const O = GYM_OFFICE;
    const frame = this.officeMat;
    const glass = new THREE.MeshPhysicalMaterial({ color: "#bfe0ff", transparent: true, opacity: 0.16, roughness: 0.05, depthWrite: false });
    const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      m.castShadow = mat === frame;
      this.group.add(m);
      this.disposables.push(geo);
    };
    const dx = O.x1 - O.x0, dz = O.z1 - O.z0, t = 0.07;
    // Front glass wall (facing +x) with a centre mullion, and two side walls.
    add(new THREE.BoxGeometry(0.02, O.h - 0.9, dz), glass, O.x1, 0.9 + (O.h - 0.9) / 2, (O.z0 + O.z1) / 2);
    add(new THREE.BoxGeometry(0.08, 0.9, dz), frame, O.x1, 0.45, (O.z0 + O.z1) / 2);
    for (const z of [O.z0, O.z1]) {
      add(new THREE.BoxGeometry(dx, O.h - 0.9, 0.02), glass, O.x0 + dx / 2, 0.9 + (O.h - 0.9) / 2, z);
      add(new THREE.BoxGeometry(dx, 0.9, 0.08), frame, O.x0 + dx / 2, 0.45, z);
      add(new THREE.BoxGeometry(t, O.h, t), frame, O.x1, O.h / 2, z);
    }
    add(new THREE.BoxGeometry(t, O.h, t), frame, O.x1, O.h / 2, (O.z0 + O.z1) / 2);
    add(new THREE.BoxGeometry(dx + t, t * 1.5, dz + t), frame, O.x0 + dx / 2, O.h, (O.z0 + O.z1) / 2);
    // "OFFICE" plate on the booth's roof edge.
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(1.4, 0.32), new THREE.MeshBasicMaterial({ map: this.trackLook(canvasTexture(280, 64, (c, w, h) => drawOfficeSign(c, w, h, {})), "sign") }));
    sign.position.set(O.x1 + 0.05, O.h + 0.25, (O.z0 + O.z1) / 2);
    sign.rotation.y = Math.PI / 2;
    this.group.add(sign);
    this.disposables.push(frame, glass);
  }

  /** Front wall, ceiling and trusses only on the home screen (see buildRoom). */
  private setHome(home: boolean): void {
    this.homeOnly.visible = home;
  }

  // -- props ---------------------------------------------------------------

  private addSlot(id: string, placements: PropPlacement[], standIn: THREE.BufferGeometry, castShadow = true): PropSlot {
    const slot = new PropSlot(id, placements, standIn, castShadow);
    this.props.set(id, slot);
    this.group.add(slot.group);
    return slot;
  }

  private buildProps(): void {
    const S = GYM_SPOTS;
    const at = (s: { x: number; z: number; rotY: number }, y = 0): PropPlacement => ({ x: s.x, y, z: s.z, rotY: s.rotY });
    const hung = (b: { x: number; z: number; rotY: number }) => at(b, GYM_BAG_HANG.bottom);
    this.addSlot("gym_hanging_bag", [hung(S.bag1), hung(S.bag2), hung(S.bag3)], standInHangingBag());
    // Chains from the bag tops up to the beam.
    const chainMat = new THREE.MeshStandardMaterial({ color: "#8a8d94", roughness: 0.4, metalness: 0.8 });
    const chainLen = GYM_BAG_HANG.beamY - (GYM_BAG_HANG.bottom + HANGING_BAG_H);
    const chainGeo = new THREE.CylinderGeometry(0.025, 0.025, chainLen, 6);
    for (const b of [S.bag1, S.bag2, S.bag3]) {
      const c = new THREE.Mesh(chainGeo, chainMat);
      c.position.set(b.x, GYM_BAG_HANG.beamY - chainLen / 2, b.z);
      this.group.add(c);
    }
    this.disposables.push(chainMat, chainGeo);
    this.addSlot("gym_speed_bag", [at(S.speedBag)], standInSpeedBag());
    this.addSlot("gym_plate_rack", [at(S.plateRack)], standInPlateRack());
    this.addSlot("gym_bench_press", [at(S.benchPress)], standInBenchPress());
    this.addSlot("gym_dumbbell_rack", [at(S.dumbbells)], standInDumbbells());
    this.addSlot("gym_lockers", [at(S.lockers)], standInLockers());
    this.addSlot("gym_wood_bench", [at(S.woodBench)], standInWoodBench());
    this.addSlot("gym_office_desk", [at(S.desk)], standInDesk());
    this.addSlot("gym_office_chair", [at(S.chair)], standInChair());
    this.addSlot("gym_door", [at(S.door)], standInDoor(), false);
    this.addSlot("gym_water_crate", [at(S.waterCrate)], standInWaterCrate());
    this.buildGloves();

    // The desk monitor's night glow: a thin screen + light just above the desktop.
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.3), this.monitorMat);
    screen.position.set(S.desk.x - 0.05, 1.12, S.desk.z);
    screen.rotation.y = S.desk.rotY;
    screen.visible = false;
    screen.name = "monitor-screen";
    this.group.add(screen);
    this.monitorLight.position.set(S.desk.x + 0.4, 1.3, S.desk.z);
    this.group.add(this.monitorLight);
  }

  // -- trophy cases ----------------------------------------------------------

  private trophySlot!: PropSlot;
  private medalSlot!: PropSlot;
  private trophyCount = 0;
  private medalCount = 0;

  private buildTrophyCases(): void {
    const T = TROPHY_CASE;
    const wood = this.trophyWoodMat;
    const back = new THREE.MeshStandardMaterial({ color: "#2a1a12", roughness: 0.9 });
    const shelfMat = new THREE.MeshPhysicalMaterial({ color: "#d8f0ff", transparent: true, opacity: 0.35, roughness: 0.1 });
    const glass = new THREE.MeshPhysicalMaterial({ color: "#cfe8ff", transparent: true, opacity: 0.12, roughness: 0.05, depthWrite: false });
    const trophies: PropPlacement[] = [];
    const medals: PropPlacement[] = [];
    for (const spot of [GYM_SPOTS.trophyA, GYM_SPOTS.trophyB]) {
      const g = new THREE.Group();
      g.position.set(spot.x, 0, spot.z);
      g.rotation.y = spot.rotY;
      const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number) => {
        const m = new THREE.Mesh(geo, mat);
        m.position.set(x, y, z);
        m.castShadow = mat !== glass;
        m.receiveShadow = true;
        g.add(m);
        this.disposables.push(geo);
      };
      const t = 0.06;
      add(new THREE.BoxGeometry(T.w, 0.12, T.d), wood, 0, 0.06, 0);               // plinth
      add(new THREE.BoxGeometry(T.w, t, T.d), wood, 0, T.h - t / 2, 0);            // top
      add(new THREE.BoxGeometry(t, T.h, T.d), wood, -T.w / 2 + t / 2, T.h / 2, 0); // sides
      add(new THREE.BoxGeometry(t, T.h, T.d), wood, T.w / 2 - t / 2, T.h / 2, 0);
      add(new THREE.BoxGeometry(T.w, T.h, 0.03), back, 0, T.h / 2, -T.d / 2 + 0.015);
      for (const y of T.shelves) add(new THREE.BoxGeometry(T.w - 2 * t, 0.02, T.d - 0.05), shelfMat, 0, y, 0);
      add(new THREE.BoxGeometry(T.w - 2 * t, T.h - 0.18, 0.01), glass, 0, T.h / 2 + 0.03, T.d / 2 - 0.01);
      this.group.add(g);

      // Fill order matches the 2D cases: top shelf first, left to right.
      const cos = Math.cos(spot.rotY), sin = Math.sin(spot.rotY);
      const world = (lx: number, y: number, lz: number, list: PropPlacement[]) =>
        list.push({ x: spot.x + lx * cos + lz * sin, y, z: spot.z - lx * sin + lz * cos, rotY: spot.rotY });
      const inner = T.w - 2 * t - 0.12;
      for (const y of T.shelves) for (let i = 0; i < TROPHIES_PER_ROW; i++) {
        world(-inner / 2 + (i + 0.5) * (inner / TROPHIES_PER_ROW), y + 0.01, 0.06, trophies);
      }
      for (const y of T.shelves) for (let i = 0; i < MEDALS_PER_ROW; i++) {
        world(-inner / 2 + (i + 0.5) * (inner / MEDALS_PER_ROW), y + 0.25, -T.d / 2 + 0.06, medals);
      }
    }
    this.disposables.push(wood, back, shelfMat, glass);
    this.trophyCount = trophies.length / 2;
    this.medalCount = medals.length / 2;
    this.trophySlot = this.addSlot("gym_trophy", trophies, standInTrophy(), false);
    this.medalSlot = this.addSlot("gym_medal", medals, standInMedal(), false);
  }

  private applyDressing(d: GymDressing): void {
    const tShown: boolean[] = [], mShown: boolean[] = [];
    for (const [tN, mN] of [[d.aTrophies, d.aMedals], [d.bTrophies, d.bMedals]]) {
      for (let i = 0; i < this.trophyCount; i++) tShown.push(i < tN);
      for (let i = 0; i < this.medalCount; i++) mShown.push(i < mN);
    }
    this.trophySlot.setShown(tShown);
    this.medalSlot.setShown(mShown);
    this.crateLocked.visible = !d.crateUnlocked;
    this.crateOpen.visible = d.crateUnlocked;
    this.gloveGold.forEach((u, i) => { u.value = d.goldGloves?.[i] ? 1 : 0; });
  }

  // -- wall gloves -------------------------------------------------------------

  /** Per pair: gold switch (uniform shared with that pair's own material). */
  private gloveGold: { value: number }[] = [];

  /** Three glove pairs, each with its own material so it can be recoloured / turned gold alone. */
  private buildGloves(): void {
    const S = GYM_SPOTS;
    const pairs: { spot: { x: number; z: number; rotY: number }; y: number; tint: string | null }[] = [
      { spot: S.gloveRack, y: GYM_GLOVES.y, tint: null },
      { spot: S.gloveRack2, y: GYM_GLOVES.ringY, tint: "#1f5fd6" },
      { spot: S.gloveRack3, y: GYM_GLOVES.ringY, tint: "#ececec" },
    ];
    const slots = pairs.map(p => {
      const slot = new PropSlot("gym_glove_rack", [{ x: p.spot.x, y: p.y, z: p.spot.z, rotY: p.spot.rotY, scale: GYM_GLOVES.scale }], standInGloveRack(), false);
      this.group.add(slot.group);
      this.gloveSlots.push(slot);
      const gold = { value: 0 };
      this.gloveGold.push(gold);
      return { slot, gold, tint: p.tint };
    });
    void getFittedPropParts("gym_glove_rack").then(parts => {
      if (!parts || this.gloveSlots.length === 0) return;
      for (const { slot, gold, tint } of slots) {
        slot.useModel(parts.map(part => {
          const m = (part.material as THREE.MeshStandardMaterial).clone();
          patchGloveMaterial(m, tint, gold);
          this.disposables.push(m);
          return { geometry: part.geometry.clone(), material: m };
        }));
      }
    });
  }
  private gloveSlots: PropSlot[] = [];

  // -- equipment crate -------------------------------------------------------

  private buildCrate(): void {
    const s = GYM_SPOTS.equipCrate;
    const wood = new THREE.MeshStandardMaterial({ color: "#8a5a2e", roughness: 0.8 });
    const band = new THREE.MeshStandardMaterial({ color: "#3a3a40", metalness: 0.6, roughness: 0.4 });
    const gold = new THREE.MeshStandardMaterial({ color: "#d9a632", metalness: 0.8, roughness: 0.3 });
    const glow = new THREE.MeshBasicMaterial({ color: "#ffd66a", transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false });
    this.disposables.push(wood, band, gold, glow);
    const W = 0.95, H = 0.55, D = 0.65;
    const mk = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number, parent: THREE.Object3D, rx = 0) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      m.rotation.x = rx;
      m.castShadow = true;
      parent.add(m);
      this.disposables.push(geo);
      return m;
    };
    for (const grp of [this.crateLocked, this.crateOpen]) {
      grp.position.set(s.x, 0, s.z);
      grp.rotation.y = s.rotY;
      mk(new THREE.BoxGeometry(W, H, D), wood, 0, H / 2, 0, grp);
      mk(new THREE.BoxGeometry(W + 0.02, 0.06, D + 0.02), band, 0, H * 0.25, 0, grp);
      this.group.add(grp);
    }
    // Locked: closed lid, chain band, padlock.
    mk(new THREE.BoxGeometry(W + 0.04, 0.08, D + 0.04), wood, 0, H + 0.04, 0, this.crateLocked);
    mk(new THREE.BoxGeometry(0.06, H + 0.1, D + 0.04), band, 0, (H + 0.1) / 2, 0, this.crateLocked);
    mk(new THREE.BoxGeometry(0.16, 0.14, 0.06), gold, 0, H * 0.55, D / 2 + 0.04, this.crateLocked);
    mk(new THREE.TorusGeometry(0.05, 0.015, 6, 12, Math.PI), band, 0, H * 0.55 + 0.07, D / 2 + 0.04, this.crateLocked);
    // Open: lid tipped back, golden glow from inside.
    const lid = new THREE.Group();
    lid.position.set(0, H, -D / 2);
    lid.rotation.x = -1.9;
    mk(new THREE.BoxGeometry(W + 0.04, 0.08, D + 0.04), wood, 0, 0.04, D / 2, lid);
    this.crateOpen.add(lid);
    const g = mk(new THREE.PlaneGeometry(W - 0.08, D - 0.08), glow, 0, H - 0.02, 0, this.crateOpen, -Math.PI / 2);
    g.castShadow = false;
  }

  // -- lights ----------------------------------------------------------------

  private buildLights(): void {
    // Shadow-casting key from (almost) straight overhead, like the ceiling
    // lamps: the high side-wall windows can't throw light onto the floor
    // this far into the room, so a slanted "window" key cast impossible
    // long shadows. A slight tilt keeps shadows just off each object's base.
    this.key.position.set(-2.6, 24, -0.6);
    this.key.target.position.set(-3, 0, 0.4);
    this.key.castShadow = true;
    this.key.shadow.mapSize.set(2048, 2048);
    const sc = this.key.shadow.camera;
    // Square, so it covers the whole floor (x -15.5..10, z -8.6..9.5) whichever
    // way the near-vertical shadow camera's up axis ends up pointing.
    sc.left = -14; sc.right = 14; sc.top = 14; sc.bottom = -14; sc.near = 2; sc.far = 40;
    this.key.shadow.bias = -0.0006;
    this.lights.add(this.hemi, this.key, this.key.target);
    for (const [x, z] of LAMP_SPOTS) {
      const p = new THREE.PointLight("#ffd9a0", 12, 12, 1.5);
      p.position.set(x, GYM_ROOM.wallH - LAMP_DROP - 0.2, z);
      this.lamps.push(p);
      this.lights.add(p);
    }
  }

  /** Night: the gym after hours (fight week, the import sparring session). */
  setNight(on: boolean): void {
    const n = on ? 1 : 0;
    if (n === this.night) return;
    this.night = n;
    this.hemi.intensity = on ? 0.22 : 0.95;
    this.hemi.color.set(on ? "#6f84c8" : "#fff4e0");
    this.hemi.groundColor.set(on ? "#141828" : "#5a4330");
    this.key.intensity = on ? 0.35 : 1.7;
    this.key.color.set(on ? "#9fb4ff" : "#fff3dd");
    // After hours only the two lamps over the ring stay on, turned low.
    this.lamps.forEach((p, i) => { p.intensity = on ? (i < 2 ? 3.5 : 0) : 12; });
    for (const w of this.windows) (w.material as THREE.MeshBasicMaterial).color.set(on ? "#1c2440" : "#ffffff");
    this.lampMat.emissiveIntensity = on ? 0.05 : 1.4;
    this.monitorLight.intensity = on ? 3.2 : 0;
    this.monitorMat.emissiveIntensity = on ? 1.6 : 0;
    const screen = this.group.getObjectByName("monitor-screen");
    if (screen) screen.visible = on;
  }

  // -- hover -----------------------------------------------------------------

  private buildHover(): void {
    const discMat = (color: string) => new THREE.MeshBasicMaterial({
      map: this.glowTex, color, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false,
    });
    for (const zone of Object.keys(GYM_ZONE_BOXES) as Exclude<GymZone3D, "ring">[]) {
      const grp = new THREE.Group();
      for (const b of GYM_ZONE_BOXES[zone]) {
        const w = b.max[0] - b.min[0] + 0.7, d = b.max[2] - b.min[2] + 0.7;
        const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d), discMat(HOVER_COLORS[zone] ?? "#ffe9a0"));
        m.rotation.x = -Math.PI / 2;
        m.position.set((b.min[0] + b.max[0]) / 2, 0.02, (b.min[2] + b.max[2]) / 2);
        m.renderOrder = 2;
        grp.add(m);
        // From the low home camera a floor glow is often hidden, so the
        // target's volume also gets a bright outline and a faint fill.
        const bw = b.max[0] - b.min[0], bh = b.max[1] - b.min[1], bd = b.max[2] - b.min[2];
        const boxGeo = new THREE.BoxGeometry(bw, bh, bd);
        const centre = new THREE.Vector3((b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2);
        const edges = new THREE.LineSegments(new THREE.EdgesGeometry(boxGeo), new THREE.LineBasicMaterial({ color: HOVER_COLORS[zone] ?? "#ffe9a0" }));
        edges.position.copy(centre);
        const fill = new THREE.Mesh(boxGeo, new THREE.MeshBasicMaterial({
          color: HOVER_COLORS[zone] ?? "#ffe9a0", transparent: true, opacity: 0.12, blending: THREE.AdditiveBlending, depthWrite: false,
        }));
        fill.position.copy(centre);
        fill.renderOrder = 3;
        grp.add(edges, fill);
      }
      grp.visible = false;
      this.hoverMeshes.set(zone, grp);
      this.hoverGroup.add(grp);
    }
    // Ring: a bright outline round the mat edge.
    const hx = RING_HALF_X + 0.15, hz = RING_HALF_Z + 0.1;
    const pts = [[hx, 0], [0, hz], [-hx, 0], [0, -hz], [hx, 0]].map(([x, z]) => new THREE.Vector3(x, MAT_HEIGHT + 0.03, z));
    const ring = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: "#ffe066" }));
    const glowRing = new THREE.Mesh(
      new THREE.ShapeGeometry(new THREE.Shape([[hx, 0], [0, hz], [-hx, 0], [0, -hz]].map(([x, z]) => new THREE.Vector2(x, z)))),
      new THREE.MeshBasicMaterial({ color: "#ffe066", transparent: true, opacity: 0.12, depthWrite: false, side: THREE.DoubleSide }),
    );
    glowRing.rotation.x = Math.PI / 2;
    glowRing.position.y = MAT_HEIGHT + 0.025;
    const rg = new THREE.Group();
    rg.add(ring, glowRing);
    rg.visible = false;
    this.hoverMeshes.set("ring", rg);
    this.hoverGroup.add(rg);
  }

  /** Per frame: dressing from the last home-screen snapshot, hover highlight. */
  update(opts: { night: boolean; hovered?: GymZone3D | null; home?: boolean }): void {
    this.applyDressing(currentDressing);
    this.applyLook(currentLook);
    this.setHome(opts.home === true);
    this.setNight(opts.night);
    const t = performance.now() / 1000;
    this.hoverMeshes.forEach((obj, zone) => {
      obj.visible = opts.hovered === zone;
      if (obj.visible) obj.traverse(o => {
        const m = (o as THREE.Mesh).material as THREE.MeshBasicMaterial | undefined;
        if (m && "opacity" in m && m.blending === THREE.AdditiveBlending) {
          const isFill = (o as THREE.Mesh).geometry?.type === "BoxGeometry";
          m.opacity = isFill ? 0.1 + 0.06 * Math.sin(t * 5) : 0.65 + 0.25 * Math.sin(t * 5);
        }
      });
    });
  }

  dispose(): void {
    this.props.forEach(p => p.dispose());
    this.gloveSlots.forEach(p => p.dispose());
    this.gloveSlots = [];
    for (const d of this.disposables) d.dispose();
    this.glowTex.dispose();
    this.group.traverse(o => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        m.geometry?.dispose();
        const mats = Array.isArray(m.material) ? m.material : [m.material];
        for (const mat of mats) { (mat as THREE.MeshStandardMaterial).map?.dispose(); mat.dispose(); }
      }
    });
  }
}

/** Pendant lamps: over the ring, along the bag row, the weights and the far wall. */
const LAMP_SPOTS: [number, number][] = [[-2.2, 0], [2.2, 0], [-10, -5.6], [-8.6, -1.6], [-12, -3.5], [-11, 1.2], [-7.5, 5.2]];
/** How far each pendant hangs below the ceiling. */
const LAMP_DROP = 1.6;
/** Height of the fitted hanging-bag model (catalog size), for the chain above it. */
const HANGING_BAG_H = 2.2;

// ── textures ────────────────────────────────────────────────────────────────

function canvasTexture(w: number, h: number, draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  draw(c.getContext("2d")!, w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

function drawPlanks(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const rows = 8, rh = h / rows;
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  for (let r = 0; r < rows; r++) {
    let x = -rnd() * w * 0.5;
    while (x < w) {
      const len = w * (0.35 + rnd() * 0.4);
      const l = 34 + rnd() * 10;
      ctx.fillStyle = `hsl(28, 42%, ${l}%)`;
      ctx.fillRect(x, r * rh, len, rh);
      ctx.fillStyle = "rgba(0,0,0,0.35)";
      ctx.fillRect(x, r * rh, 2, rh);
      for (let g = 0; g < 4; g++) {
        ctx.fillStyle = `rgba(60,30,10,${0.06 + rnd() * 0.06})`;
        ctx.fillRect(x, r * rh + rnd() * rh, len, 1.5);
      }
      x += len;
    }
    ctx.fillStyle = "rgba(0,0,0,0.4)";
    ctx.fillRect(0, r * rh, w, 2);
  }
}

function drawWall(ctx: CanvasRenderingContext2D, w: number, h: number, look: GymLook): void {
  // Exposed red-brown brick above a dark painted dado and skirting. A repaint
  // keeps the same brick pattern, varied around the chosen colour.
  const paint = look.wall ? hexToHsl(look.wall) : null;
  ctx.fillStyle = paint ? `hsl(${paint.h}, ${paint.s * 0.8}%, ${paint.l * 0.62}%)` : "#5e3326";
  ctx.fillRect(0, 0, w, h);
  let seed = 11;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const rows = 22, bh = h / rows, bw = w / 6;
  for (let r = 0; r < rows; r++) {
    for (let x = (r % 2) * -bw / 2; x < w; x += bw) {
      const a = rnd(), b = rnd(), c = rnd();
      ctx.fillStyle = paint
        ? `hsl(${paint.h - 5 + b * 10}, ${Math.max(0, Math.min(100, paint.s - 7 + c * 14))}%, ${Math.max(3, Math.min(95, paint.l * (0.86 + a * 0.4)))}%)`
        : `hsl(${12 + b * 10}, ${38 + c * 14}%, ${26 + a * 12}%)`;
      ctx.fillRect(x + 2, r * bh + 2, bw - 4, bh - 4);
    }
  }
  ctx.fillStyle = look.themeDark ?? "#1f2422";
  ctx.fillRect(0, h * 0.8, w, h * 0.2);
  ctx.fillStyle = look.themeAccent ?? "#b8902f";
  ctx.fillRect(0, h * 0.8, w, h * 0.008);
  ctx.fillStyle = "#121414";
  ctx.fillRect(0, h * 0.96, w, h * 0.04);
}

function hexToHsl(hex: string): { h: number; s: number; l: number } {
  const c = new THREE.Color(hex);
  const o = { h: 0, s: 0, l: 0 };
  c.getHSL(o, THREE.SRGBColorSpace);
  return { h: o.h * 360, s: o.s * 100, l: o.l * 100 };
}

function drawWindow(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, "#fff7e4"); g.addColorStop(1, "#d9e6f2");
  ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = "#2a2d30"; ctx.lineWidth = 10;
  ctx.strokeRect(5, 5, w - 10, h - 10);
  ctx.lineWidth = 5;
  for (let i = 1; i < 4; i++) { ctx.beginPath(); ctx.moveTo((w * i) / 4, 0); ctx.lineTo((w * i) / 4, h); ctx.stroke(); }
  ctx.beginPath(); ctx.moveTo(0, h / 2); ctx.lineTo(w, h / 2); ctx.stroke();
}

function drawExit(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  ctx.fillStyle = "#0c3d1c"; ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = "#5dff8a";
  ctx.font = `900 ${Math.round(h * 0.7)}px 'Oxanium', sans-serif`;
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText("EXIT", w / 2, h / 2 + 2);
}

function drawOfficeSign(ctx: CanvasRenderingContext2D, w: number, h: number, look: GymLook): void {
  ctx.fillStyle = look.themeDark ?? "#15151a"; ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = look.themeText ?? GYM_LOOK_DEFAULTS.themeText;
  ctx.font = `800 ${Math.round(h * 0.62)}px 'Oxanium', sans-serif`;
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText("OFFICE", w / 2, h / 2 + 2);
}

function drawBanner(ctx: CanvasRenderingContext2D, w: number, h: number, look: GymLook): void {
  const dark = look.themeDark ?? GYM_LOOK_DEFAULTS.themeDark;
  const accent = look.themeAccent ?? GYM_LOOK_DEFAULTS.themeAccent;
  ctx.fillStyle = dark;
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = accent;
  ctx.lineWidth = 8;
  ctx.strokeRect(10, 10, w - 20, h - 20);
  ctx.fillStyle = look.themeText ?? GYM_LOOK_DEFAULTS.themeText;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  // Long names shrink to fit inside the border.
  const text = look.name ?? GYM_LOOK_DEFAULTS.name;
  const maxW = w - 80;
  let size = Math.round(h * 0.5);
  ctx.font = `900 ${size}px 'Oxanium', sans-serif`;
  const tw = ctx.measureText(text).width;
  if (tw > maxW) {
    size = Math.max(10, Math.floor(size * maxW / tw));
    ctx.font = `900 ${size}px 'Oxanium', sans-serif`;
  }
  ctx.fillText(text, w / 2, h / 2 + 4);
}

function drawPoster(ctx: CanvasRenderingContext2D, title: string): void {
  const w = 220, h = 300;
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, "#b3261e"); g.addColorStop(1, "#2a0b0b");
  ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = "#f4e6c4";
  ctx.font = "900 28px 'Oxanium', sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(title, w / 2, 44);
  ctx.fillStyle = "rgba(0,0,0,0.55)";
  ctx.beginPath(); ctx.arc(70, 170, 46, 0, Math.PI * 2); ctx.arc(150, 170, 46, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "#f4e6c4";
  ctx.font = "700 20px 'Oxanium', sans-serif";
  ctx.fillText("VS", w / 2, 178);
  ctx.font = "600 16px 'Oxanium', sans-serif";
  ctx.fillText("SATURDAY · 9PM", w / 2, 270);
}

function drawClock(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  ctx.fillStyle = "#f6f3ea"; ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = "#222"; ctx.lineWidth = 8;
  ctx.beginPath(); ctx.arc(w / 2, h / 2, w / 2 - 6, 0, Math.PI * 2); ctx.stroke();
  ctx.lineWidth = 5;
  ctx.beginPath(); ctx.moveTo(w / 2, h / 2); ctx.lineTo(w / 2, h * 0.2); ctx.moveTo(w / 2, h / 2); ctx.lineTo(w * 0.72, h * 0.58); ctx.stroke();
}

function makeGlowTexture(): THREE.CanvasTexture {
  return canvasTexture(128, 128, (ctx, w, h) => {
    const g = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
    g.addColorStop(0, "rgba(255,255,255,0.9)");
    g.addColorStop(0.6, "rgba(255,255,255,0.35)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  });
}

// ── stand-ins (shown until the GLBs load, and if one is missing) ────────────

const B = (w: number, h: number, d: number) => new THREE.BoxGeometry(w, h, d);
const C = (r: number, h: number, seg = 12) => new THREE.CylinderGeometry(r, r, h, seg);

function standInHangingBag(): THREE.BufferGeometry {
  return mergeParts([
    coloredPart(C(0.26, 1.7, 14), "#7a1a1a", 0, 0.85),
    coloredPart(C(0.265, 0.07, 14), "#111114", 0, 0.4),
    coloredPart(C(0.265, 0.07, 14), "#111114", 0, 1.35),
    coloredPart(C(0.03, 0.5), "#8a8d94", 0, 1.95),
  ]);
}

function standInSpeedBag(): THREE.BufferGeometry {
  return mergeParts([
    coloredPart(B(0.6, 0.06, 0.6), "#1b1b1f", 0, 0.03),
    coloredPart(C(0.04, 2.0), "#2a2a2e", 0, 1.03),
    coloredPart(C(0.4, 0.06, 18), "#6b4426", 0, 2.02, 0.25),
    coloredPart(new THREE.SphereGeometry(0.11, 10, 8), "#7a4a24", 0, 1.82, 0.25),
  ]);
}
function standInPlateRack(): THREE.BufferGeometry {
  const parts = [coloredPart(B(0.6, 0.05, 0.6), "#222", 0, 0.025), coloredPart(C(0.035, 1.2), "#333", 0, 0.6)];
  [0.35, 0.65, 0.95].forEach((y, i) => parts.push(coloredPart(C(0.24 - i * 0.04, 0.05, 16), i === 1 ? "#a32222" : "#151515", 0, y, 0.12, Math.PI / 2)));
  return mergeParts(parts);
}
function standInBenchPress(): THREE.BufferGeometry {
  return mergeParts([
    coloredPart(B(1.2, 0.12, 0.32), "#9e1f1f", 0, 0.45),
    coloredPart(B(0.08, 0.4, 0.08), "#222", -0.4, 0.2), coloredPart(B(0.08, 0.4, 0.08), "#222", 0.4, 0.2),
    coloredPart(B(0.06, 1.2, 0.06), "#222", 0.55, 0.6, -0.35), coloredPart(B(0.06, 1.2, 0.06), "#222", 0.55, 0.6, 0.35),
    coloredPart(C(0.02, 1.8), "#aaa", 0.55, 1.12, 0, Math.PI / 2),
    coloredPart(C(0.22, 0.06, 16), "#151515", 0.55, 1.12, -0.75, Math.PI / 2),
    coloredPart(C(0.22, 0.06, 16), "#151515", 0.55, 1.12, 0.75, Math.PI / 2),
  ]);
}
function standInDumbbells(): THREE.BufferGeometry {
  const parts = [coloredPart(B(1.6, 0.06, 0.45), "#333", 0, 0.45), coloredPart(B(1.6, 0.06, 0.45), "#333", 0, 0.85)];
  for (const x of [-0.78, 0.78]) parts.push(coloredPart(B(0.05, 0.9, 0.45), "#222", x, 0.45));
  for (let i = 0; i < 6; i++) for (const y of [0.53, 0.93]) parts.push(coloredPart(B(0.18, 0.1, 0.1), "#111", -0.62 + i * 0.25, y));
  return mergeParts(parts);
}
function standInLockers(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 4; i++) {
    parts.push(coloredPart(B(0.55, 1.9, 0.5), i % 2 ? "#2f5d8a" : "#346795", -0.86 + i * 0.575, 0.95));
    parts.push(coloredPart(B(0.04, 0.12, 0.02), "#ccc", -0.66 + i * 0.575, 1.0, 0.26));
  }
  return mergeParts(parts);
}
function standInWoodBench(): THREE.BufferGeometry {
  return mergeParts([
    coloredPart(B(1.6, 0.07, 0.38), "#9a6a3a", 0, 0.45),
    coloredPart(B(0.08, 0.42, 0.32), "#6b4426", -0.65, 0.21), coloredPart(B(0.08, 0.42, 0.32), "#6b4426", 0.65, 0.21),
  ]);
}
function standInDesk(): THREE.BufferGeometry {
  return mergeParts([
    coloredPart(B(1.6, 0.06, 0.8), "#6b4426", 0, 0.76),
    coloredPart(B(0.45, 0.73, 0.75), "#5a3a22", -0.55, 0.37), coloredPart(B(0.05, 0.73, 0.75), "#5a3a22", 0.75, 0.37),
    coloredPart(B(0.55, 0.36, 0.05), "#111", 0, 1.0, -0.15), coloredPart(B(0.3, 0.02, 0.4), "#f2f2f2", 0.45, 0.8, 0.1),
  ]);
}
function standInChair(): THREE.BufferGeometry {
  return mergeParts([
    coloredPart(C(0.3, 0.05, 10), "#222", 0, 0.05), coloredPart(C(0.03, 0.4), "#333", 0, 0.25),
    coloredPart(B(0.5, 0.08, 0.5), "#151515", 0, 0.5), coloredPart(B(0.5, 0.55, 0.07), "#151515", 0, 0.82, -0.22),
  ]);
}
function standInDoor(): THREE.BufferGeometry {
  return mergeParts([
    coloredPart(B(1.2, 2.2, 0.08), "#3b2a1c", 0, 1.1),
    coloredPart(B(1.0, 2.05, 0.06), "#7a5434", 0, 1.03, 0.03),
    coloredPart(B(0.35, 0.35, 0.02), "#a9c6d8", 0, 1.6, 0.07),
    coloredPart(new THREE.SphereGeometry(0.04, 8, 6), "#d4a640", 0.38, 1.0, 0.09),
  ]);
}
function standInWaterCrate(): THREE.BufferGeometry {
  const parts = [coloredPart(B(0.6, 0.2, 0.4), "#2a6fb5", 0, 0.1)];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 2; j++) parts.push(coloredPart(C(0.05, 0.3, 8), "#bfe6ff", -0.18 + i * 0.18, 0.3, -0.09 + j * 0.18));
  return mergeParts(parts);
}
function standInGloveRack(): THREE.BufferGeometry {
  const parts = [coloredPart(B(1.4, 0.12, 0.06), "#6b4426", 0, 0.5)];
  for (let i = 0; i < 4; i++) parts.push(coloredPart(new THREE.SphereGeometry(0.12, 8, 6), i % 2 ? "#141414" : "#b31d1d", -0.5 + i * 0.33, 0.3, 0.1));
  return mergeParts(parts);
}
function standInTrophy(): THREE.BufferGeometry {
  return mergeParts([
    coloredPart(B(0.08, 0.05, 0.08), "#151515", 0, 0.025),
    coloredPart(C(0.012, 0.08, 6), "#d9a632", 0, 0.09),
    coloredPart(new THREE.CylinderGeometry(0.05, 0.025, 0.09, 10), "#e2b33c", 0, 0.175),
  ]);
}
function standInMedal(): THREE.BufferGeometry {
  return mergeParts([
    coloredPart(B(0.03, 0.11, 0.005), "#b31d1d", 0, 0.14),
    coloredPart(new THREE.CylinderGeometry(0.04, 0.04, 0.01, 12), "#c9ccd2", 0, 0.05, 0, Math.PI / 2),
  ]);
}
