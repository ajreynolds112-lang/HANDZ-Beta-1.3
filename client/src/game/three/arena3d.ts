/**
 * The 3D fight arena: ring (from code, sized off the engine ring extents and
 * coloured from the ring palette), ringside props (Tripo models or stand-ins),
 * tiered stands with an instanced crowd, and the overhead lighting rig.
 *
 * Draw calls are kept low: the crowd is two instanced meshes, ropes three,
 * posts one, every prop type one per material part, and all static structure
 * (stands, room) is merged.
 */
import * as THREE from "three";
import type { GameState } from "../types";
import { DEFAULT_RING_COLORS } from "../ringColors";
import { SPACIAL_COLOR, isSpacial, cssColorOf, enableSpacialFills } from "../spacialColor";
import {
  MAT_HEIGHT, POST_HEIGHT, ROPE_HEIGHTS, RING_HALF_X, RING_HALF_Z, ringCorners,
} from "./worldMapping";
import { PropSlot, coloredPart, mergeParts, type PropPlacement } from "./props3d";

/** The 2D renderer's stock literals, used when the palette is absent. */
const STOCK_FLOOR = "#3d2f1e";
const STOCK_BORDER = "#8b7355";

interface RingPalette {
  canvas: string;
  apron: string;
  border: string;
  ropes: [string, string, string];
  /** Corner order matches ringCorners(): far, right (enemy), near, left (player). */
  posts: [string, string, string, string];
}

function darkenHex(hex: string, amount: number): string {
  const r = Math.max(0, parseInt(hex.slice(1, 3), 16) - amount);
  const g = Math.max(0, parseInt(hex.slice(3, 5), 16) - amount);
  const b = Math.max(0, parseInt(hex.slice(5, 7), 16) - amount);
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
}

/** Same resolution rules as renderer.ts's drawRingFloor / getCornerPostColor. */
function ringPaletteOf(state: GameState): RingPalette {
  const rc = state.ringColors;
  const canvas = rc?.canvas || state.ringCanvasColor || STOCK_FLOOR;
  const apron = isSpacial(canvas) ? SPACIAL_COLOR : darkenHex(cssColorOf(canvas), 20);
  const post = (idx: number): string => {
    if (rc?.posts) return rc.posts;
    if (idx === 3) return cssColorOf(state.playerColors.trunks);
    if (idx === 1) return cssColorOf(state.enemyColors.trunks);
    return "#ffffff";
  };
  return {
    canvas,
    apron,
    border: rc?.border || STOCK_BORDER,
    ropes: [
      rc?.ropeLower || DEFAULT_RING_COLORS.ropeLower,
      rc?.ropeMiddle || DEFAULT_RING_COLORS.ropeMiddle,
      rc?.ropeUpper || DEFAULT_RING_COLORS.ropeUpper,
    ],
    posts: [post(0), post(1), post(2), post(3)],
  };
}

function paletteKey(p: RingPalette): string {
  return [p.canvas, p.apron, p.border, ...p.ropes, ...p.posts].join("|");
}

/**
 * The animated starfield as a texture. It is painted through the same canvas
 * fill interception the 2D renderer uses, so the Spacial finish looks the same.
 */
class SpacialTexture {
  readonly canvas = document.createElement("canvas");
  readonly texture: THREE.CanvasTexture;
  private ctx: CanvasRenderingContext2D;
  private lastDraw = -1;

  constructor() {
    this.canvas.width = 256;
    this.canvas.height = 256;
    this.ctx = this.canvas.getContext("2d")!;
    enableSpacialFills(this.ctx);
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.wrapS = this.texture.wrapT = THREE.RepeatWrapping;
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.draw();
  }

  draw(): void {
    this.ctx.fillStyle = SPACIAL_COLOR;
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    this.texture.needsUpdate = true;
  }

  tick(nowMs: number): void {
    if (nowMs - this.lastDraw < 80) return;
    this.lastDraw = nowMs;
    this.draw();
  }

  dispose(): void {
    this.texture.dispose();
  }
}

/** Point a material at a palette colour, or at the starfield for the sentinel. */
function applyColor(mat: THREE.MeshStandardMaterial, color: string, spacial: SpacialTexture): void {
  if (isSpacial(color)) {
    if (mat.map !== spacial.texture) {
      mat.map = spacial.texture;
      mat.needsUpdate = true;
    }
    mat.color.set("#ffffff");
  } else {
    if (mat.map) {
      mat.map = null;
      mat.needsUpdate = true;
    }
    mat.color.set(color);
  }
}

/** Unit cylinder (height 1 along y, centred) placed between two points. */
function segmentMatrix(a: THREE.Vector3, b: THREE.Vector3, radiusScale = 1): THREE.Matrix4 {
  const dir = new THREE.Vector3().subVectors(b, a);
  const len = dir.length();
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
  return new THREE.Matrix4().compose(
    new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5),
    q,
    new THREE.Vector3(radiusScale, len, radiusScale),
  );
}

/** Rotation that turns a +x-facing prop toward direction (dx, dz). */
function yawToward(dx: number, dz: number): number {
  return -Math.atan2(dz, dx);
}

// ---------------------------------------------------------------------------
// Stand-in prop geometry. Every prop faces +x (toward the ring) and stands on y=0.
// ---------------------------------------------------------------------------

function standInTurnbuckle(): THREE.BufferGeometry {
  return mergeParts([
    coloredPart(new THREE.CapsuleGeometry(0.1, 0.12, 3, 8), "#ffffff", 0, 0.16, 0),
  ]);
}

function standInSteps(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const steps = 3;
  for (let k = 0; k < steps; k++) {
    const h = (MAT_HEIGHT * (k + 1)) / steps;
    parts.push(coloredPart(new THREE.BoxGeometry(0.32, h, 1.0), k % 2 ? "#3a3a40" : "#45454c", -0.32 * (steps - 1 - k), h / 2, 0));
  }
  for (const side of [-0.5, 0.5]) {
    parts.push(coloredPart(new THREE.CylinderGeometry(0.025, 0.025, 1.0, 6), "#b8bcc4", -0.64, 0.5 + 0.5 / 3, side));
    parts.push(coloredPart(new THREE.CylinderGeometry(0.025, 0.025, 0.95, 6), "#b8bcc4", -0.32, 1.35, side, 0, 0, Math.PI / 2 - 0.55));
  }
  return mergeParts(parts);
}

function standInTable(): THREE.BufferGeometry {
  return mergeParts([
    coloredPart(new THREE.BoxGeometry(0.7, 0.05, 2.4), "#1b1b20", 0, 0.75, 0),
    coloredPart(new THREE.BoxGeometry(0.68, 0.72, 2.36), "#0f0f13", 0, 0.36, 0),
    coloredPart(new THREE.BoxGeometry(0.2, 0.04, 0.3), "#d8d8d8", 0.05, 0.795, -0.6),
    coloredPart(new THREE.BoxGeometry(0.2, 0.04, 0.3), "#d8d8d8", 0.05, 0.795, 0.6),
  ]);
}

function standInChair(): THREE.BufferGeometry {
  const parts = [
    coloredPart(new THREE.BoxGeometry(0.42, 0.05, 0.42), "#202024", 0, 0.46, 0),
    coloredPart(new THREE.BoxGeometry(0.05, 0.42, 0.42), "#202024", -0.2, 0.7, 0),
  ];
  for (const [x, z] of [[-0.18, -0.18], [-0.18, 0.18], [0.18, -0.18], [0.18, 0.18]]) {
    parts.push(coloredPart(new THREE.CylinderGeometry(0.015, 0.015, 0.46, 5), "#77787d", x, 0.23, z));
  }
  return mergeParts(parts);
}

function standInStool(): THREE.BufferGeometry {
  const parts = [coloredPart(new THREE.CylinderGeometry(0.2, 0.2, 0.06, 12), "#26262b", 0, 0.58, 0)];
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    parts.push(coloredPart(new THREE.CylinderGeometry(0.018, 0.018, 0.6, 5), "#9a9ca2", Math.cos(a) * 0.14, 0.29, Math.sin(a) * 0.14, Math.sin(a) * 0.12, 0, -Math.cos(a) * 0.12));
  }
  return mergeParts(parts);
}

function standInBell(): THREE.BufferGeometry {
  return mergeParts([
    coloredPart(new THREE.BoxGeometry(0.22, 0.03, 0.3), "#5a3a1e", 0, 0.015, 0),
    coloredPart(new THREE.BoxGeometry(0.03, 0.26, 0.22), "#5a3a1e", -0.08, 0.15, 0),
    coloredPart(new THREE.SphereGeometry(0.09, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2), "#d4a63a", -0.02, 0.12, 0, 0, 0, -Math.PI / 2),
  ]);
}

function standInSeatingCorner(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const rows = 10;
  for (let r = 0; r < rows; r++) {
    const h = 0.3 + r * 0.45;
    parts.push(coloredPart(new THREE.BoxGeometry(0.9, h, 6 + r * 0.9), r % 2 ? "#1a1820" : "#211e28", -r * 0.9, h / 2, 0));
  }
  return mergeParts(parts);
}

const TRUSS_W = 10;
const TRUSS_D = 7.5;

function standInTruss(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const beam = "#6d7078";
  for (const z of [-TRUSS_D / 2, TRUSS_D / 2]) {
    for (const dy of [0, 0.4]) parts.push(coloredPart(new THREE.BoxGeometry(TRUSS_W, 0.08, 0.08), beam, 0, dy, z));
  }
  for (const x of [-TRUSS_W / 2, TRUSS_W / 2]) {
    for (const dy of [0, 0.4]) parts.push(coloredPart(new THREE.BoxGeometry(0.08, 0.08, TRUSS_D), beam, x, dy, 0));
  }
  // Lamp cans along the long sides.
  for (const z of [-TRUSS_D / 2, TRUSS_D / 2]) {
    for (let i = 0; i < 5; i++) {
      const x = -TRUSS_W / 2 + 1 + i * ((TRUSS_W - 2) / 4);
      parts.push(coloredPart(new THREE.CylinderGeometry(0.16, 0.12, 0.35, 8), "#1c1c20", x, -0.25, z));
    }
  }
  return mergeParts(parts);
}

// ---------------------------------------------------------------------------
// Crowd
// ---------------------------------------------------------------------------

interface CrowdSeat {
  x: number;
  y: number;
  z: number;
  rotY: number;
}

/**
 * Vertex-shader crowd sway: phase comes from each instance's position, so the
 * whole crowd animates on the GPU from one time uniform.
 */
function addCrowdBob(mat: THREE.Material, uniforms: { uTime: { value: number }; uBounce: { value: number } }): void {
  mat.onBeforeCompile = shader => {
    shader.uniforms.uTime = uniforms.uTime;
    shader.uniforms.uBounce = uniforms.uBounce;
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nuniform float uTime;\nuniform float uBounce;")
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
        float ph = dot(instanceMatrix[3].xz, vec2(1.7, 2.3));
        transformed.y += sin(uTime * 1.8 + ph * 0.7) * 0.025 + uBounce * abs(sin(uTime * 6.0 + ph)) * 0.14;
        transformed.z += sin(uTime * 1.2 + ph) * 0.02;`,
      );
  };
}

export class Arena3D {
  readonly group = new THREE.Group();
  private spacial = new SpacialTexture();
  private paletteKeyCache = "";
  private palette: RingPalette | null = null;

  private matCanvas = document.createElement("canvas");
  private matTexture: THREE.CanvasTexture;
  private skirtCanvas = document.createElement("canvas");
  private skirtTexture: THREE.CanvasTexture;

  private borderMat = new THREE.MeshStandardMaterial({ roughness: 0.6 });
  private ropeMats = [0, 1, 2].map(() => new THREE.MeshStandardMaterial({ roughness: 0.45 }));
  private postMat = new THREE.MeshStandardMaterial({ roughness: 0.35, metalness: 0.3 });
  private posts!: THREE.InstancedMesh;

  readonly props = new Map<string, PropSlot>();
  /**
   * Everything that makes this the arena rather than the gym: room, stands,
   * crowd and the ringside furniture. The ring and its turnbuckles stay out of
   * it, so the gym venue reuses the same ring by hiding this group.
   */
  private venueGroup = new THREE.Group();
  private crowdGroup = new THREE.Group();
  private crowdUniforms = { uTime: { value: 0 }, uBounce: { value: 0 } };
  private disposables: { dispose(): void }[] = [];

  constructor() {
    this.matCanvas.width = 1024;
    this.matCanvas.height = Math.round(1024 * (RING_HALF_Z / RING_HALF_X));
    this.matTexture = new THREE.CanvasTexture(this.matCanvas);
    this.matTexture.flipY = false;
    this.matTexture.colorSpace = THREE.SRGBColorSpace;
    this.matTexture.anisotropy = 4;
    this.skirtCanvas.width = 512;
    this.skirtCanvas.height = 64;
    this.skirtTexture = new THREE.CanvasTexture(this.skirtCanvas);
    this.skirtTexture.colorSpace = THREE.SRGBColorSpace;
    this.disposables.push(this.matTexture, this.skirtTexture, this.spacial, this.borderMat, this.postMat, ...this.ropeMats);

    this.venueGroup.name = "arena-venue";
    this.group.add(this.venueGroup);
    this.buildRoom();
    this.buildRing();
    this.buildProps();
    this.buildStandsAndCrowd();
  }

  // -- Ring ----------------------------------------------------------------

  private buildRing(): void {
    const ring = new THREE.Group();
    ring.name = "ring";
    const hx = RING_HALF_X;
    const hz = RING_HALF_Z;

    // Canvas mat: the exact engine rhombus, UVs spanning the mat texture.
    const matGeo = new THREE.BufferGeometry();
    const top = [0, MAT_HEIGHT, -hz], right = [hx, MAT_HEIGHT, 0], bottom = [0, MAT_HEIGHT, hz], left = [-hx, MAT_HEIGHT, 0];
    const verts = [...top, ...bottom, ...right, ...top, ...left, ...bottom];
    matGeo.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
    const uvs: number[] = [];
    for (let i = 0; i < verts.length; i += 3) uvs.push((verts[i] / hx + 1) / 2, (verts[i + 2] / hz + 1) / 2);
    matGeo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
    matGeo.computeVertexNormals();
    const matMat = new THREE.MeshStandardMaterial({ map: this.matTexture, roughness: 0.85 });
    const mat = new THREE.Mesh(matGeo, matMat);
    mat.receiveShadow = true;
    ring.add(mat);
    this.disposables.push(matGeo, matMat);

    // Apron: the slightly larger rhombus (2D: +6px / +4px) and its skirt.
    const apron = ringCorners(6 / 50, 4 / 50);
    const skirtPos: number[] = [];
    const skirtUv: number[] = [];
    for (let i = 0; i < 4; i++) {
      const [ax, az] = apron[i];
      const [bx, bz] = apron[(i + 1) % 4];
      skirtPos.push(ax, 0, az, bx, 0, bz, bx, MAT_HEIGHT, bz, ax, 0, az, bx, MAT_HEIGHT, bz, ax, MAT_HEIGHT, az);
      // u runs b→a so the banner reads left-to-right from outside the ring.
      skirtUv.push(1, 0, 0, 0, 0, 1, 1, 0, 0, 1, 1, 1);
    }
    const skirtGeo = new THREE.BufferGeometry();
    skirtGeo.setAttribute("position", new THREE.Float32BufferAttribute(skirtPos, 3));
    skirtGeo.setAttribute("uv", new THREE.Float32BufferAttribute(skirtUv, 2));
    skirtGeo.computeVertexNormals();
    const skirtMat = new THREE.MeshStandardMaterial({ map: this.skirtTexture, roughness: 0.9, side: THREE.DoubleSide });
    ring.add(new THREE.Mesh(skirtGeo, skirtMat));
    const lipGeo = new THREE.BufferGeometry();
    const at = (i: number) => [apron[i][0], MAT_HEIGHT - 0.004, apron[i][1]];
    lipGeo.setAttribute("position", new THREE.Float32BufferAttribute([...at(0), ...at(2), ...at(1), ...at(0), ...at(3), ...at(2)], 3));
    lipGeo.computeVertexNormals();
    const lipMat = new THREE.MeshStandardMaterial({ roughness: 0.9 });
    ring.add(new THREE.Mesh(lipGeo, lipMat));
    this.apronLipMat = lipMat;
    this.disposables.push(skirtGeo, skirtMat, lipGeo, lipMat);

    // Padded border round the mat edge (the 2D renderer's ring-edge stroke).
    const corners = ringCorners();
    const borderGeo = new THREE.CylinderGeometry(0.06, 0.06, 1, 8);
    const border = new THREE.InstancedMesh(borderGeo, this.borderMat, 4);
    for (let i = 0; i < 4; i++) {
      const a = new THREE.Vector3(corners[i][0], MAT_HEIGHT + 0.04, corners[i][1]);
      const b = new THREE.Vector3(corners[(i + 1) % 4][0], MAT_HEIGHT + 0.04, corners[(i + 1) % 4][1]);
      border.setMatrixAt(i, segmentMatrix(a, b));
    }
    ring.add(border);
    this.disposables.push(borderGeo);

    // Ropes: one instanced mesh per rope level, four sides each.
    const ropeGeo = new THREE.CylinderGeometry(0.028, 0.028, 1, 8);
    this.disposables.push(ropeGeo);
    ROPE_HEIGHTS.forEach((h, level) => {
      const ropes = new THREE.InstancedMesh(ropeGeo, this.ropeMats[level], 4);
      for (let i = 0; i < 4; i++) {
        const a = new THREE.Vector3(corners[i][0], MAT_HEIGHT + h, corners[i][1]);
        const b = new THREE.Vector3(corners[(i + 1) % 4][0], MAT_HEIGHT + h, corners[(i + 1) % 4][1]);
        ropes.setMatrixAt(i, segmentMatrix(a, b));
      }
      ropes.castShadow = true;
      ring.add(ropes);
    });

    // Corner posts, tinted per corner.
    const postGeo = new THREE.CylinderGeometry(0.07, 0.08, 1, 12);
    this.posts = new THREE.InstancedMesh(postGeo, this.postMat, 4);
    for (let i = 0; i < 4; i++) {
      const a = new THREE.Vector3(corners[i][0], MAT_HEIGHT - 0.2, corners[i][1]);
      const b = new THREE.Vector3(corners[i][0], MAT_HEIGHT + POST_HEIGHT, corners[i][1]);
      this.posts.setMatrixAt(i, segmentMatrix(a, b));
      this.posts.setColorAt(i, new THREE.Color("#ffffff"));
    }
    this.posts.castShadow = true;
    ring.add(this.posts);
    this.disposables.push(postGeo);

    this.group.add(ring);
  }

  private apronLipMat: THREE.MeshStandardMaterial | null = null;

  private drawMat(p: RingPalette): void {
    const ctx = this.matCanvas.getContext("2d")!;
    enableSpacialFills(ctx);
    const W = this.matCanvas.width;
    const H = this.matCanvas.height;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = p.canvas;
    ctx.fillRect(0, 0, W, H);
    // Faint diamond grid, parallel to the ring edges like the 2D mat.
    const T = [W / 2, 0], R = [W, H / 2], B = [W / 2, H], L = [0, H / 2];
    ctx.strokeStyle = "rgba(0,0,0,0.06)";
    ctx.lineWidth = 2;
    for (let i = 1; i < 8; i++) {
      const t = i / 8;
      ctx.beginPath();
      ctx.moveTo(L[0] + (T[0] - L[0]) * t, L[1] + (T[1] - L[1]) * t);
      ctx.lineTo(R[0] + (B[0] - R[0]) * t, R[1] + (B[1] - R[1]) * t);
      ctx.moveTo(T[0] + (R[0] - T[0]) * t, T[1] + (R[1] - T[1]) * t);
      ctx.lineTo(L[0] + (B[0] - L[0]) * t, L[1] + (B[1] - L[1]) * t);
      ctx.stroke();
    }
    // Centre logo, printed into the canvas.
    ctx.save();
    ctx.translate(W / 2, H / 2);
    ctx.globalAlpha = 0.16;
    ctx.fillStyle = "#000000";
    ctx.font = `900 ${Math.round(H * 0.16)}px 'Oxanium', sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("HANDZ", 0, 0);
    ctx.lineWidth = 6;
    ctx.strokeStyle = "#000000";
    ctx.beginPath();
    ctx.ellipse(0, 0, W * 0.16, H * 0.16, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
    this.matTexture.needsUpdate = true;
  }

  private drawSkirt(p: RingPalette): void {
    const ctx = this.skirtCanvas.getContext("2d")!;
    enableSpacialFills(ctx);
    const W = this.skirtCanvas.width;
    const H = this.skirtCanvas.height;
    ctx.fillStyle = p.apron;
    ctx.fillRect(0, 0, W, H);
    const shade = ctx.createLinearGradient(0, 0, 0, H);
    shade.addColorStop(0, "rgba(255,255,255,0.08)");
    shade.addColorStop(1, "rgba(0,0,0,0.35)");
    ctx.fillStyle = shade;
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = "rgba(222,179,69,0.85)";
    ctx.font = `900 ${Math.round(H * 0.5)}px 'Oxanium', sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("HANDZ  BOXING", W / 2, H / 2);
    this.skirtTexture.needsUpdate = true;
  }

  // -- Props ---------------------------------------------------------------

  private addSlot(id: string, placements: PropPlacement[], standIn: THREE.BufferGeometry, castShadow = false, arenaOnly = true): void {
    const slot = new PropSlot(id, placements, standIn, castShadow);
    this.props.set(id, slot);
    (arenaOnly ? this.venueGroup : this.group).add(slot.group);
  }

  /** Show the arena around the ring, or only the ring (the gym builds its own room). */
  setVenue(venue: "arena" | "gym"): void {
    this.venueGroup.visible = venue === "arena";
  }

  private buildProps(): void {
    const corners = ringCorners();

    // Turnbuckle pads: one per rope per corner, facing the ring centre.
    const pads: PropPlacement[] = [];
    corners.forEach(([cx, cz]) => {
      const len = Math.hypot(cx, cz);
      const ix = -cx / len, iz = -cz / len;
      for (const h of ROPE_HEIGHTS) {
        pads.push({ x: cx + ix * 0.1, y: MAT_HEIGHT + h - 0.16, z: cz + iz * 0.1, rotY: yawToward(ix, iz) });
      }
    });
    this.addSlot("turnbuckle", pads, standInTurnbuckle(), true, false);

    // Steps and stools at the two fighters' corners (left = player, right = enemy).
    const hx = RING_HALF_X;
    this.addSlot("ring_steps", [
      { x: -hx - 0.75, y: 0, z: 0.0, rotY: 0 },
      { x: hx + 0.75, y: 0, z: 0.0, rotY: Math.PI },
    ], standInSteps());
    this.addSlot("corner_stool", [
      { x: -hx - 0.9, y: 0, z: 1.1, rotY: 0 },
      { x: hx + 0.9, y: 0, z: -1.1, rotY: Math.PI },
    ], standInStool());

    // Ringside tables along every edge, chairs behind them facing the ring.
    const tables: PropPlacement[] = [];
    const chairs: PropPlacement[] = [];
    for (let i = 0; i < 4; i++) {
      const [ax, az] = corners[i];
      const [bx, bz] = corners[(i + 1) % 4];
      const ex = bx - ax, ez = bz - az;
      const elen = Math.hypot(ex, ez);
      const ux = ex / elen, uz = ez / elen;
      // Outward normal: away from the ring centre.
      let nx = uz, nz = -ux;
      if (nx * (ax + bx) + nz * (az + bz) < 0) { nx = -nx; nz = -nz; }
      const rot = yawToward(-nx, -nz);
      for (const f of [0.3, 0.7]) {
        const px = ax + ex * f + nx * 1.7;
        const pz = az + ez * f + nz * 1.7;
        tables.push({ x: px, y: 0, z: pz, rotY: rot });
        for (const s of [-0.75, 0, 0.75]) {
          chairs.push({ x: px + nx * 0.7 + ux * s, y: 0, z: pz + nz * 0.7 + uz * s, rotY: rot });
        }
      }
    }
    this.addSlot("ringside_table", tables, standInTable());
    this.addSlot("ringside_chair", chairs, standInChair());
    // The timekeeper's bell sits on the far-right table.
    const bellTable = tables[2];
    this.addSlot("ring_bell", [{ x: bellTable.x, y: 0.775, z: bellTable.z, rotY: bellTable.rotY }], standInBell());

    // Seating wedges in the four arena corners, between the main stands.
    this.addSlot("seating_section", [
      { x: -14.5, y: 0, z: -11, rotY: yawToward(1, 0.75) },
      { x: 14.5, y: 0, z: -11, rotY: yawToward(-1, 0.75) },
      { x: -14.5, y: 0, z: 11.5, rotY: yawToward(1, -0.75) },
      { x: 14.5, y: 0, z: 11.5, rotY: yawToward(-1, -0.75) },
    ], standInSeatingCorner());

    // Lighting rig over the ring.
    this.addSlot("lighting_truss", [{ x: 0, y: MAT_HEIGHT + 7.2, z: 0, rotY: 0 }], standInTruss());
  }

  // -- Arena ---------------------------------------------------------------

  private buildRoom(): void {
    const floorGeo = new THREE.PlaneGeometry(90, 90);
    floorGeo.rotateX(-Math.PI / 2);
    const floorMat = new THREE.MeshStandardMaterial({ color: "#16131c", roughness: 0.95 });
    const floor = new THREE.Mesh(floorGeo, floorMat);
    floor.receiveShadow = true;
    this.venueGroup.add(floor);
    // A dark bowl wall far out; the fog does most of the work.
    const wallGeo = new THREE.CylinderGeometry(40, 40, 22, 32, 1, true);
    const wallMat = new THREE.MeshBasicMaterial({ color: "#07050c", side: THREE.BackSide });
    const wall = new THREE.Mesh(wallGeo, wallMat);
    wall.position.y = 11;
    this.venueGroup.add(wall);
    this.disposables.push(floorGeo, floorMat, wallGeo, wallMat);
  }

  private buildStandsAndCrowd(): void {
    const riserParts: THREE.BufferGeometry[] = [];
    const seats: CrowdSeat[] = [];
    const ROWS = 12;
    const ROW_D = 0.9;
    const ROW_RISE = 0.45;
    const SEAT_W = 0.62;

    // Each stand: start point of its front edge, run direction, outward normal.
    const stands = [
      { cx: 0, cz: -10.5, len: 26, rx: 1, rz: 0, nx: 0, nz: -1 }, // far
      { cx: 0, cz: 12, len: 26, rx: 1, rz: 0, nx: 0, nz: 1 }, // near (behind camera)
      { cx: -15, cz: 0.5, len: 18, rx: 0, rz: 1, nx: -1, nz: 0 }, // left
      { cx: 15, cz: 0.5, len: 18, rx: 0, rz: 1, nx: 1, nz: 0 }, // right
    ];

    let seed = 1337;
    const rnd = () => {
      seed = (seed * 1664525 + 1013904223) & 0x7fffffff;
      return seed / 0x7fffffff;
    };

    for (const s of stands) {
      const rot = yawToward(-s.nx, -s.nz);
      for (let r = 0; r < ROWS; r++) {
        const h = 0.3 + r * ROW_RISE;
        const off = r * ROW_D + ROW_D / 2;
        const len = s.len + r * 0.6;
        const g = new THREE.BoxGeometry(ROW_D, h, len);
        riserParts.push(coloredPart(g, r % 2 ? "#1c1922" : "#24202c", s.cx + s.nx * off, h / 2, s.cz + s.nz * off, 0, rot, 0));
        const n = Math.floor(len / SEAT_W);
        for (let i = 0; i < n; i++) {
          if (rnd() < 0.12) continue; // a few empty seats
          const t = (i + 0.5) / n - 0.5;
          seats.push({
            x: s.cx + s.rx * t * len + s.nx * (off - 0.1) + (rnd() - 0.5) * 0.08,
            y: h,
            z: s.cz + s.rz * t * len + s.nz * (off - 0.1) + (rnd() - 0.5) * 0.08,
            rotY: rot + (rnd() - 0.5) * 0.3,
          });
        }
      }
    }
    const risers = new THREE.Mesh(mergeParts(riserParts), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 }));
    risers.receiveShadow = true;
    this.venueGroup.add(risers);
    this.disposables.push(risers.geometry, risers.material as THREE.Material);

    // Crowd: seated torsos and heads, two instanced meshes sharing matrices.
    const torsoGeo = new THREE.BoxGeometry(0.3, 0.55, 0.42);
    torsoGeo.translate(0, 0.32, 0);
    const headGeo = new THREE.IcosahedronGeometry(0.12, 1);
    headGeo.translate(0.02, 0.74, 0);
    const torsoMat = new THREE.MeshStandardMaterial({ roughness: 0.9 });
    const headMat = new THREE.MeshStandardMaterial({ roughness: 0.8 });
    addCrowdBob(torsoMat, this.crowdUniforms);
    addCrowdBob(headMat, this.crowdUniforms);
    const torsos = new THREE.InstancedMesh(torsoGeo, torsoMat, seats.length);
    const heads = new THREE.InstancedMesh(headGeo, headMat, seats.length);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const shirt = new THREE.Color();
    const skin = new THREE.Color();
    const skinTones = ["#f1c7a5", "#d9a47e", "#b67a52", "#8a5634", "#5e3a22"];
    seats.forEach((seat, i) => {
      q.setFromAxisAngle(up, seat.rotY);
      const sc = 0.9 + rnd() * 0.2;
      m.compose(new THREE.Vector3(seat.x, seat.y, seat.z), q, new THREE.Vector3(sc, sc, sc));
      torsos.setMatrixAt(i, m);
      heads.setMatrixAt(i, m);
      shirt.setHSL(rnd(), 0.25 + rnd() * 0.35, 0.18 + rnd() * 0.3);
      torsos.setColorAt(i, shirt);
      skin.set(skinTones[Math.floor(rnd() * skinTones.length)]);
      heads.setColorAt(i, skin);
    });
    this.crowdGroup.add(torsos, heads);
    this.venueGroup.add(this.crowdGroup);
    this.disposables.push(torsoGeo, headGeo, torsoMat, headMat, torsos, heads);
  }

  // -- Per frame -----------------------------------------------------------

  update(state: GameState, nowMs: number): void {
    const p = ringPaletteOf(state);
    const key = paletteKey(p);
    if (key !== this.paletteKeyCache) {
      this.paletteKeyCache = key;
      this.palette = p;
      this.applyPalette(p);
    }
    const pal = this.palette!;
    const anySpacial = key.includes(SPACIAL_COLOR);
    if (anySpacial) {
      this.spacial.tick(nowMs);
      // The printed mat and skirt carry the starfield too; refresh them at the
      // same cadence so the stars keep moving.
      if (isSpacial(pal.canvas) && this.spacialMatRedrawAt + 80 <= nowMs) {
        this.spacialMatRedrawAt = nowMs;
        this.drawMat(pal);
        this.drawSkirt(pal);
      }
    }

    // The 2D renderer skips the crowd in practice and sparring.
    this.crowdGroup.visible = !state.practiceMode && !state.sparringMode;
    this.crowdUniforms.uTime.value = state.crowdBobTime;
    const target = state.crowdKdBounceTimer > 0 ? 1 : 0;
    this.crowdUniforms.uBounce.value += (target - this.crowdUniforms.uBounce.value) * 0.15;
  }

  private spacialMatRedrawAt = 0;

  private applyPalette(p: RingPalette): void {
    this.drawMat(p);
    this.drawSkirt(p);
    if (this.apronLipMat) applyColor(this.apronLipMat, p.apron, this.spacial);
    applyColor(this.borderMat, p.border, this.spacial);
    p.ropes.forEach((c, i) => applyColor(this.ropeMats[i], c, this.spacial));

    // Posts share one material; an explicit palette colour (possibly Spacial)
    // applies to all four, otherwise each corner is tinted per instance.
    const allSame = p.posts.every(c => c === p.posts[0]);
    const tint = new THREE.Color();
    if (allSame) {
      applyColor(this.postMat, p.posts[0], this.spacial);
      for (let i = 0; i < 4; i++) this.posts.setColorAt(i, tint.set("#ffffff"));
    } else {
      applyColor(this.postMat, "#ffffff", this.spacial);
      for (let i = 0; i < 4; i++) this.posts.setColorAt(i, tint.set(cssColorOf(p.posts[i])));
    }
    if (this.posts.instanceColor) this.posts.instanceColor.needsUpdate = true;

    // Pads are tinted per instance, so the finish reads as its base colour there.
    const padTints: string[] = [];
    for (let i = 0; i < 4; i++) for (let k = 0; k < 3; k++) padTints.push(cssColorOf(p.posts[i]));
    this.props.get("turnbuckle")?.setTints(padTints);
  }

  dispose(): void {
    this.props.forEach(slot => slot.dispose());
    for (const d of this.disposables) d.dispose();
  }
}
