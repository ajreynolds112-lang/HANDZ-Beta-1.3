/**
 * 3D fighter previews (colour pickers, roster cards, roster editor, punch
 * editor) without a WebGL context per card.
 *
 * One offscreen WebGLRenderer renders every preview into a corner of its own
 * canvas, and each card copies that corner into its plain 2D canvas. Cards do
 * not run their own animation loops in 3D: they subscribe to one shared loop
 * that renders a bounded number of previews per frame, round-robin, and skips
 * cards that are scrolled out of view, so a long roster list stays responsive.
 *
 * The rig is driven by a FighterState built from createInitialState (no live
 * fight); the engine is only read, never stepped.
 */
import * as THREE from "three";
import type { BoxingStance, FighterColors, FighterState, GameState, PunchType } from "../types";
import { createInitialState, punchPhaseFractions } from "../engine";
import { Fighter3D } from "./fighterModel";
import { ensureFighterAssets } from "./fighterRig";

export interface FighterPreviewPose {
  colors: FighterColors;
  stance?: BoxingStance;
  /** Idle bounce phase (radians). */
  bobPhase: number;
  /** Extra turn (radians) on top of the default angle; previews sway with it. */
  yaw?: number;
  headgear?: boolean;
  /** Punch editor: punch type and arm extension 0..1. Side-on framing. */
  punch?: { type: PunchType; extension: number } | null;
}

/** Most previews rendered in one animation frame; the rest wait their turn. */
const MAX_RENDERS_PER_FRAME = 6;
const CAM_FOV = 26;

class PreviewRenderer {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(CAM_FOV, 1, 0.1, 50);
  private rigs = new Map<string, Fighter3D>();
  private state: GameState;
  private fighter: FighterState;
  private bufW = 0;
  private bufH = 0;
  private frame = 0;

  constructor() {
    const canvas = document.createElement("canvas");
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(1);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.setClearColor(0x000000, 0);

    this.scene.add(new THREE.HemisphereLight("#cfd6ea", "#2a2230", 1.1));
    const key = new THREE.DirectionalLight("#fff1d6", 2.4);
    key.position.set(-2.5, 4, 4);
    const rim = new THREE.DirectionalLight("#a8c4ff", 1.4);
    rim.position.set(3, 3, -4);
    this.scene.add(key, rim);

    this.state = createInitialState();
    this.fighter = this.state.player;
    ensureFighterAssets(() => false);
  }

  /** One rig per stance/kind so the pose smoothing never blends two cards. */
  private rig(key: string): Fighter3D {
    let r = this.rigs.get(key);
    if (!r) {
      r = new Fighter3D();
      this.rigs.set(key, r);
      this.scene.add(r.root);
    }
    return r;
  }

  render(target: CanvasRenderingContext2D, pose: FighterPreviewPose): void {
    const outW = target.canvas.width;
    const outH = target.canvas.height;
    if (outW <= 0 || outH <= 0) return;
    if (outW > this.bufW || outH > this.bufH) {
      this.bufW = Math.max(this.bufW, outW);
      this.bufH = Math.max(this.bufH, outH);
      this.renderer.setSize(this.bufW, this.bufH, false);
    }

    const f = this.fighter;
    const punch = pose.punch ?? null;
    f.isPlayer = true;
    f.boxingStance = pose.stance ?? "orthodox";
    f.bobPhase = pose.bobPhase;
    f.rhythmLevel = 0;
    f.swayOffset = 0;
    f.isFeinting = false;
    f.isRePunch = false;
    f.retractionProgress = 0;
    if (punch && punch.extension > 0) {
      f.isPunching = true;
      f.currentPunch = punch.type;
      // Drive the arm with the engine's own phase reading: inside armSpeed the
      // extension is 1-(1-t)^2, so invert that for the wanted extension.
      const fr = punchPhaseFractions(f);
      const ext = Math.max(0, Math.min(1, punch.extension));
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
    } else {
      f.isPunching = false;
      f.currentPunch = null;
      f.punchProgress = 0;
      f.punchPhase = null;
    }

    // Side-on (facing right) for the punch editor; three-quarter for cards.
    const baseAngle = punch ? 0.3 : Math.PI / 2 - 0.55;
    f.facingAngle = baseAngle + (pose.yaw ?? 0);
    this.state.sparringMode = pose.headgear === true;

    const key = (punch ? "punch|" : "idle|") + f.boxingStance;
    this.rigs.forEach((r, k) => { r.root.visible = k === key; });
    const rig = this.rig(key);
    rig.root.visible = true;
    this.frame++;
    rig.update(f, pose.colors, null, this.state, this.frame, 0);
    rig.root.position.set(0, 0, 0);

    // Frame the whole body (plus the reach, side-on) in this card's shape.
    const aspect = outW / outH;
    const halfTan = Math.tan(THREE.MathUtils.degToRad(CAM_FOV / 2));
    const lookX = punch ? 0.55 : 0;
    const halfH = Math.max(punch ? 1.25 : 1.28, (punch ? 1.9 : 0.66) / aspect);
    const dist = halfH / halfTan;
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
    this.camera.position.set(lookX, 1.2, dist);
    this.camera.lookAt(lookX, 1.08, 0);

    // Render into the bottom-left corner (GL origin), then copy that corner.
    const r = this.renderer;
    r.setScissorTest(true);
    r.setViewport(0, 0, outW, outH);
    r.setScissor(0, 0, outW, outH);
    r.clear();
    r.render(this.scene, this.camera);
    r.setScissorTest(false);

    target.save();
    target.setTransform(1, 0, 0, 1, 0, 0);
    target.clearRect(0, 0, outW, outH);
    target.drawImage(r.domElement, 0, this.bufH - outH, outW, outH, 0, 0, outW, outH);
    target.restore();
  }
}

let shared: PreviewRenderer | null = null;
let unavailable = false;

function getRenderer(): PreviewRenderer | null {
  if (unavailable) return null;
  if (!shared) {
    try {
      shared = new PreviewRenderer();
    } catch (err) {
      console.error("[3D] preview renderer unavailable, using Classic 2D", err);
      unavailable = true;
      return null;
    }
  }
  return shared;
}

/** Whether the shared 3D preview renderer can be used (creates it on first ask). */
export function fighterPreview3DAvailable(): boolean {
  return getRenderer() !== null;
}

/**
 * Draw one 3D preview into `target` (sized by its canvas). Returns false when
 * WebGL is unavailable, so the caller can draw its 2D preview instead.
 */
export function renderFighterPreview3D(target: CanvasRenderingContext2D, pose: FighterPreviewPose): boolean {
  const r = getRenderer();
  if (!r) return false;
  try {
    r.render(target, pose);
    return true;
  } catch (err) {
    console.error("[3D] preview render failed", err);
    return false;
  }
}

// ───────── shared loop ─────────

interface PreviewSlot {
  draw: (now: number) => void;
  visible: () => boolean;
}

const slots: PreviewSlot[] = [];
let cursor = 0;
let rafId = 0;

function tick(now: number): void {
  rafId = 0;
  if (slots.length === 0) return;
  const live = slots.filter(s => s.visible());
  const n = Math.min(MAX_RENDERS_PER_FRAME, live.length);
  for (let i = 0; i < n; i++) {
    const slot = live[(cursor + i) % live.length];
    slot.draw(now);
  }
  cursor = live.length > 0 ? (cursor + n) % live.length : 0;
  rafId = requestAnimationFrame(tick);
}

/**
 * Join the shared preview loop. `draw` is called at most once per frame, and
 * only while `visible()` says the card is on screen. Returns the unsubscribe.
 */
export function subscribeFighterPreview(draw: (now: number) => void, visible: () => boolean): () => void {
  const slot: PreviewSlot = { draw, visible };
  slots.push(slot);
  if (!rafId) rafId = requestAnimationFrame(tick);
  return () => {
    const i = slots.indexOf(slot);
    if (i >= 0) slots.splice(i, 1);
    if (slots.length === 0 && rafId) { cancelAnimationFrame(rafId); rafId = 0; }
  };
}
