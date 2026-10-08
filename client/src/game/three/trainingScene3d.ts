/**
 * 3D scenes for the gym training minigames (Heavy Bag, Weight Lifting).
 *
 * Each minigame owns one WebGL canvas under its 2D HUD canvas. The boxer is
 * the regular fight rig driven by a FighterState from createInitialState (the
 * engine is never stepped); the minigame pushes its live values in through
 * `setInputs` and the scene runs its own animation loop.
 */
import * as THREE from "three";
import type { FighterColors, FighterState, GameState, PunchType } from "../types";
import { createInitialState, punchPhaseFractions } from "../engine";
import { Fighter3D } from "./fighterModel";
import { ensureFighterAssets } from "./fighterRig";

export type TrainingKind = "heavyBag" | "weights";

export interface TrainingInputs {
  colors: FighterColors;
  /** Idle bounce phase (radians). */
  bobPhase: number;
  /** Heavy bag: the punch being thrown, progress 0..1 over its life. */
  punch?: { type: PunchType; progress: number } | null;
  /** Heavy bag: swing push from the HUD (px; decays on its own). */
  bagSwing?: number;
  /** Heavy bag: 0..1 hit flash. */
  hitFlash?: number;
  /** Weights: press progress for the current rep, 0..1. */
  lift?: number;
}

/** The bag hangs where the rig's stand-in opponent stands (engine px from the boxer). */
const OPP_DIST_PX = 55;
const BAG_DIST_M = 0.95;
const BAG_RADIUS = 0.22;
const BAG_HEIGHT = 1.15;
const BAG_BOTTOM_Y = 0.75;
const CHAIN_TOP_Y = 3.1;

function mat(color: string, roughness = 0.8, metalness = 0): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness });
}

function box(w: number, h: number, d: number, m: THREE.Material, x: number, y: number, z: number): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
  mesh.position.set(x, y, z);
  return mesh;
}

/** Barbell along local z, centred on the origin. */
function buildBarbell(): THREE.Group {
  const g = new THREE.Group();
  const steel = mat("#b8bcc4", 0.35, 0.85);
  const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.016, 1.9, 12), steel);
  bar.rotation.x = Math.PI / 2;
  g.add(bar);
  const plate = mat("#26262c", 0.6, 0.2);
  const rim = mat("#c23a32", 0.55, 0.1);
  for (const side of [-1, 1]) {
    const sleeve = new THREE.Mesh(new THREE.CylinderGeometry(0.026, 0.026, 0.06, 12), steel);
    sleeve.rotation.x = Math.PI / 2;
    sleeve.position.z = side * 0.64;
    g.add(sleeve);
    const big = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.05, 32), rim);
    big.rotation.x = Math.PI / 2;
    big.position.z = side * 0.7;
    const small = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 0.04, 28), plate);
    small.rotation.x = Math.PI / 2;
    small.position.z = side * 0.75;
    g.add(big, small);
  }
  return g;
}

export class TrainingScene3D {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(34, 720 / 620, 0.1, 60);
  private rig = new Fighter3D();
  private state: GameState;
  private fighter: FighterState;
  private opponent: FighterState;
  private inputs: TrainingInputs | null = null;
  private frame = 0;
  private raf = 0;
  private disposed = false;
  // Heavy bag
  private bagPivot: THREE.Group | null = null;
  private bagMat: THREE.MeshStandardMaterial | null = null;
  private bagAngle = 0;
  private bagVel = 0;
  private lastSwing = 0;
  // Weights
  private barbell: THREE.Group | null = null;
  private liftShown = 0;
  private readonly gloveMid = new THREE.Vector3();

  constructor(canvas: HTMLCanvasElement, private kind: TrainingKind) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(canvas.width, canvas.height, false);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.camera.aspect = canvas.width / canvas.height;
    this.camera.updateProjectionMatrix();

    this.state = createInitialState();
    this.fighter = this.state.player;
    this.opponent = this.state.enemy;
    ensureFighterAssets(() => this.disposed);

    this.buildRoom();
    this.scene.add(this.rig.root);
    if (kind === "heavyBag") this.buildHeavyBag();
    else this.buildWeights();

    const loop = () => {
      if (this.disposed) return;
      this.renderFrame();
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  setInputs(inputs: TrainingInputs): void {
    this.inputs = inputs;
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.rig.dispose();
    this.scene.traverse(o => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        m.geometry?.dispose();
        const mats = Array.isArray(m.material) ? m.material : [m.material];
        mats.forEach(x => x?.dispose());
      }
    });
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }

  // ── Scene building ──

  private buildRoom(): void {
    const s = this.scene;
    s.background = new THREE.Color("#1c1c28");
    s.fog = new THREE.Fog("#1c1c28", 9, 22);

    s.add(new THREE.HemisphereLight("#cfd6ea", "#3a2a1e", 0.9));
    const key = new THREE.DirectionalLight("#fff1d6", 2.2);
    key.position.set(-2.5, 5, 4);
    const rim = new THREE.DirectionalLight("#a8c4ff", 1.2);
    rim.position.set(3, 3.5, -4);
    s.add(key, rim);
    const lamp = new THREE.PointLight("#ffd9a0", 6, 9, 1.6);
    lamp.position.set(0.5, 3.4, 0.5);
    s.add(lamp);
    const shade = new THREE.Mesh(new THREE.ConeGeometry(0.28, 0.22, 20, 1, true), mat("#2b2b30", 0.5, 0.5));
    shade.position.set(0.5, 3.55, 0.5);
    s.add(shade);

    // Wood floor with plank lines.
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(16, 12), mat("#6b4226", 0.85));
    floor.rotation.x = -Math.PI / 2;
    s.add(floor);
    const seam = mat("#4f301b", 0.9);
    for (let x = -8; x <= 8; x += 0.5) {
      const line = new THREE.Mesh(new THREE.PlaneGeometry(0.012, 12), seam);
      line.rotation.x = -Math.PI / 2;
      line.position.set(x, 0.001, 0);
      s.add(line);
    }
    // Rubber training mat under the boxer.
    const mat2 = new THREE.Mesh(new THREE.PlaneGeometry(3.2, 2.4), mat("#23232b", 0.95));
    mat2.rotation.x = -Math.PI / 2;
    mat2.position.set(this.kind === "heavyBag" ? 0.5 : 0, 0.004, 0);
    s.add(mat2);

    // Brick back wall + side wall.
    const wallM = mat("#2c2c3c", 0.95);
    s.add(box(16, 4.2, 0.2, wallM, 0, 2.1, -3.2));
    s.add(box(0.2, 4.2, 9, wallM, -5.2, 2.1, 1.2));
    const mortar = mat("#353548", 0.95);
    for (let y = 0.3; y < 4.2; y += 0.3) s.add(box(16, 0.02, 0.01, mortar, 0, y, -3.09));
    s.add(box(16, 0.18, 0.06, mat("#444460", 0.7), 0, 0.09, -3.08));
    // Ceiling beam the chains hang from.
    s.add(box(16, 0.25, 0.3, mat("#3a3a46", 0.6, 0.3), 0, CHAIN_TOP_Y + 0.12, 0));

    // Framed fight posters on the back wall.
    const frameM = mat("#5a4020", 0.7);
    const posterCols = ["#8a2a2a", "#2a4a8a", "#8a6a1a", "#3a6a3a"];
    [-3.6, -1.6, 1.8, 3.8].forEach((x, i) => {
      s.add(box(0.75, 1.0, 0.04, frameM, x, 2.2, -3.08));
      s.add(box(0.65, 0.9, 0.05, mat(posterCols[i], 0.8), x, 2.2, -3.06));
    });

    // Corner of a ring at the left.
    const post = mat("#3a3a4a", 0.5, 0.4);
    const rope = mat("#dd3333", 0.6);
    s.add(box(0.12, 1.5, 0.12, post, -4.4, 0.75, -2.2));
    s.add(box(0.12, 1.5, 0.12, post, -4.4, 0.75, 0.2));
    for (const y of [0.55, 0.95, 1.35]) s.add(box(0.04, 0.04, 2.4, rope, -4.4, y, -1.0));
    s.add(box(1.4, 0.5, 2.6, mat("#30303c", 0.9), -5.0, 0.25, -1.0));

    // Water cooler + a background speed bag on the right.
    s.add(box(0.4, 1.0, 0.4, mat("#cc8800", 0.6), 4.2, 0.5, -2.6));
    const jug = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 0.4, 16), new THREE.MeshStandardMaterial({ color: "#88bbff", roughness: 0.2, transparent: true, opacity: 0.7 }));
    jug.position.set(4.2, 1.2, -2.6);
    s.add(jug);
    s.add(box(0.7, 0.06, 0.5, mat("#4a4a52", 0.6, 0.3), 3.2, 2.0, -2.9));
    const speed = new THREE.Mesh(new THREE.SphereGeometry(0.12, 16, 12), mat("#8b4513", 0.6));
    speed.scale.set(1, 1.4, 1);
    speed.position.set(3.2, 1.75, -2.75);
    s.add(speed);
  }

  private buildHeavyBag(): void {
    const pivot = new THREE.Group();
    pivot.position.set(BAG_DIST_M, CHAIN_TOP_Y, 0);
    const leather = mat("#8b3a3a", 0.55);
    this.bagMat = leather;
    const bagTopLocal = BAG_BOTTOM_Y + BAG_HEIGHT - CHAIN_TOP_Y;
    const body = new THREE.Mesh(new THREE.CylinderGeometry(BAG_RADIUS, BAG_RADIUS * 0.97, BAG_HEIGHT, 32), leather);
    body.position.y = bagTopLocal - BAG_HEIGHT / 2;
    pivot.add(body);
    const capM = mat("#3a1010", 0.6);
    const top = new THREE.Mesh(new THREE.CylinderGeometry(BAG_RADIUS * 0.85, BAG_RADIUS, 0.06, 32), capM);
    top.position.y = bagTopLocal + 0.03;
    const bottom = new THREE.Mesh(new THREE.SphereGeometry(BAG_RADIUS * 0.97, 32, 12, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2), capM);
    bottom.scale.y = 0.3;
    bottom.position.y = bagTopLocal - BAG_HEIGHT;
    pivot.add(top, bottom);
    const seamM = mat("#c9b9a9", 0.7);
    for (const t of [0.32, 0.63]) {
      const seam = new THREE.Mesh(new THREE.TorusGeometry(BAG_RADIUS * 0.99, 0.006, 6, 40), seamM);
      seam.rotation.x = Math.PI / 2;
      seam.position.y = bagTopLocal - BAG_HEIGHT * t;
      pivot.add(seam);
    }
    // Chains: four straps to a swivel, one chain to the beam.
    const steel = mat("#888c94", 0.4, 0.8);
    const swivelY = bagTopLocal + 0.4;
    const main = new THREE.Mesh(new THREE.CylinderGeometry(0.01, 0.01, -swivelY, 8), steel);
    main.position.y = swivelY / 2;
    pivot.add(main);
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
      const from = new THREE.Vector3(Math.cos(a) * BAG_RADIUS * 0.8, bagTopLocal + 0.04, Math.sin(a) * BAG_RADIUS * 0.8);
      const to = new THREE.Vector3(0, swivelY, 0);
      const len = from.distanceTo(to);
      const c = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, len, 6), steel);
      c.position.copy(from).add(to).multiplyScalar(0.5);
      c.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), to.clone().sub(from).normalize());
      pivot.add(c);
    }
    this.bagPivot = pivot;
    this.scene.add(pivot);

    // Floor shadow blobs.
    this.addBlob(BAG_DIST_M, 0, 0.32);
    this.addBlob(0, 0, 0.45);

    // Boxer faces +x toward the bag; the rig aims at a stand-in opponent there.
    this.fighter.x = 400;
    this.fighter.z = 260;
    this.fighter.facingAngle = 0;
    this.opponent.x = 400 + OPP_DIST_PX;
    this.opponent.z = 260;
    this.opponent.facingAngle = Math.PI;

    // Three-quarter side view from the boxer's right.
    this.camera.position.set(0.25, 1.55, 3.4);
    this.camera.lookAt(0.45, 1.15, 0);
  }

  private buildWeights(): void {
    this.barbell = buildBarbell();
    this.scene.add(this.barbell);
    this.addBlob(0, 0, 0.5);

    // Weight rack behind the lifter with spare plates.
    const frame = mat("#3a3a42", 0.45, 0.6);
    for (const z of [-1.0, 1.0]) this.scene.add(box(0.08, 1.8, 0.08, frame, -1.4, 0.9, z));
    this.scene.add(box(0.08, 0.08, 2.1, frame, -1.4, 1.5, 0));
    this.scene.add(box(0.08, 0.08, 2.1, frame, -1.4, 0.4, 0));
    const plateM = mat("#26262c", 0.6, 0.2);
    for (let i = 0; i < 4; i++) {
      const p = new THREE.Mesh(new THREE.CylinderGeometry(0.2 - i * 0.02, 0.2 - i * 0.02, 0.05, 28), plateM);
      p.rotation.z = Math.PI / 2;
      p.position.set(-1.32 + i * 0.06, 0.62, -0.7);
      this.scene.add(p);
    }
    // Dumbbell row on the floor.
    const db = mat("#55555e", 0.4, 0.7);
    for (let i = 0; i < 5; i++) {
      const g = new THREE.Group();
      const h = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.3, 8), db);
      h.rotation.x = Math.PI / 2;
      g.add(h);
      for (const z of [-0.13, 0.13]) {
        const b = new THREE.Mesh(new THREE.CylinderGeometry(0.05 + i * 0.008, 0.05 + i * 0.008, 0.06, 6), db);
        b.rotation.x = Math.PI / 2;
        b.position.z = z;
        g.add(b);
      }
      g.position.set(1.5 + i * 0.28, 0.07, -1.2);
      g.rotation.y = Math.PI / 2;
      this.scene.add(g);
    }

    // Lifter faces the camera (engine facing pi/2 = +z), feet square.
    this.fighter.x = 400;
    this.fighter.z = 260;
    this.fighter.facingAngle = Math.PI / 2;
    this.rig.poseHook = (pose, dims, dt) => {
      const target = Math.max(0, Math.min(1, this.inputs?.lift ?? 0));
      // Fast up, faster drop when a rep resets.
      const rate = target < this.liftShown ? 18 : 10;
      this.liftShown += (target - this.liftShown) * Math.min(1, dt * rate);
      const t = this.liftShown;
      const e = t * t * (3 - 2 * t);
      pose.pelvisRot.identity();
      pose.chestRot.identity();
      pose.headRot.setFromAxisAngle(new THREE.Vector3(0, 0, 1), 0.08 * e);
      pose.pelvisOffset.set(0, -0.04 * (1 - e), 0);
      for (let i = 0; i < 2; i++) {
        const sh = dims.shoulder[i];
        const side = Math.sign(sh.z) || (i === 0 ? -1 : 1);
        const w = Math.abs(sh.z) + 0.16;
        const rackY = sh.y + 0.04;
        const topY = sh.y + dims.armLen * 0.92;
        pose.glove[i].set(sh.x + 0.2 * (1 - e) + 0.04, rackY + (topY - rackY) * e, side * w);
        pose.elbowPole[i].set(0.35 * (1 - e), -1, side * (0.6 + 0.5 * e)).normalize();
        pose.maxStretch[i] = 1;
        pose.ankle[i].set(0, dims.ankleY, side * 0.17);
        pose.toeDir[i].set(1, 0, side * 0.2).normalize();
        pose.kneePole[i].set(1, 0, side * 0.25).normalize();
      }
      this.gloveMid.copy(pose.glove[0]).add(pose.glove[1]).multiplyScalar(0.5);
    };

    this.camera.position.set(0.6, 1.45, 3.6);
    this.camera.lookAt(0, 1.3, 0);
  }

  private addBlob(x: number, z: number, r: number): void {
    const blob = new THREE.Mesh(
      new THREE.CircleGeometry(r, 32),
      new THREE.MeshBasicMaterial({ color: "#000000", transparent: true, opacity: 0.3, depthWrite: false }),
    );
    blob.rotation.x = -Math.PI / 2;
    blob.position.set(x, 0.006, z);
    this.scene.add(blob);
  }

  // ── Per frame ──

  private renderFrame(): void {
    const inp = this.inputs;
    if (inp) {
      const f = this.fighter;
      f.isPlayer = true;
      f.boxingStance = "orthodox";
      f.bobPhase = this.kind === "weights" ? 0 : inp.bobPhase;
      f.rhythmLevel = 0;
      f.swayOffset = 0;
      f.isFeinting = false;
      f.isRePunch = false;
      f.retractionProgress = 0;
      this.setPunch(f, this.kind === "heavyBag" ? inp.punch ?? null : null);
      this.frame++;
      this.rig.update(f, inp.colors, this.kind === "heavyBag" ? this.opponent : null, this.state, this.frame, 0);
      // The rig stands on the ring mat height; the gym floor is y = 0.
      this.rig.root.position.set(0, 0, 0);

      if (this.bagPivot && this.bagMat) this.updateBag(inp);
      if (this.barbell) {
        this.rig.root.updateMatrixWorld(true);
        this.barbell.position.copy(this.gloveMid).applyMatrix4(this.rig.root.matrixWorld);
        this.barbell.rotation.set(0, this.rig.root.rotation.y, 0);
      }
    }
    this.renderer.render(this.scene, this.camera);
  }

  /** Same arm drive as the preview cards: the engine's own phase reading. */
  private setPunch(f: FighterState, punch: { type: PunchType; progress: number } | null): void {
    if (!punch) {
      f.isPunching = false;
      f.currentPunch = null;
      f.punchProgress = 0;
      f.punchPhase = null;
      return;
    }
    f.isPunching = true;
    f.currentPunch = punch.type;
    const ext = Math.sin(Math.max(0, Math.min(1, punch.progress)) * Math.PI);
    const fr = punchPhaseFractions(f);
    if (fr && ext < 0.999) {
      const [a, b] = fr.armSpeed;
      f.punchPhase = "armSpeed";
      f.punchProgress = a + (1 - Math.sqrt(1 - ext)) * (b - a);
    } else if (fr) {
      f.punchPhase = "contact";
      f.punchProgress = (fr.contact[0] + fr.contact[1]) / 2;
    } else {
      f.punchPhase = null;
      f.punchProgress = Math.asin(ext) / Math.PI;
    }
  }

  private updateBag(inp: TrainingInputs): void {
    // Each landed punch adds to bagSwing; turn the increase into a shove.
    const swing = inp.bagSwing ?? 0;
    if (swing > this.lastSwing + 0.5) this.bagVel += (swing - this.lastSwing) * 0.018;
    this.lastSwing = swing;
    const dt = 1 / 60;
    // Damped pendulum about the beam; positive angle swings away from the boxer.
    this.bagVel += (-this.bagAngle * 9.8 / (CHAIN_TOP_Y - BAG_BOTTOM_Y) - this.bagVel * 1.4) * dt;
    this.bagAngle += this.bagVel * dt;
    this.bagAngle = Math.max(-0.35, Math.min(0.35, this.bagAngle));
    this.bagPivot!.rotation.z = this.bagAngle;
    const flash = Math.max(0, inp.hitFlash ?? 0);
    this.bagMat!.emissive.setRGB(0.55 * flash, 0.4 * flash, 0.05 * flash);
  }
}
