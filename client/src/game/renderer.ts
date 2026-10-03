import { GameState, FighterState, FighterColors, HitEffect, SlipDir, KD_FALL_DURATION, BIG_SHOT_TEXT_DURATION, MAX_STAMINA_DELTA_TEXT_LIFETIME } from "./types";
import { soundEngine } from "./sound";
import { getActivePunchAnimConfig } from "@/lib/punchAnimConfig";
import { xpToNextLevel, fatigueSwayOffsets, resetHeadDuckOffset, fatigueArmSnapHold, fatigueSwaySlipFraction, resetSnapDistanceMult, createFatigueState, rhythmVulnStackWidth, flinchArmOffsets } from "./engine";
import { SPACIAL_BASE_HEX, SPACIAL_COLOR, cssColorOf, enableSpacialFills, isSpacial, spacialPaint } from "./spacialColor";
import { DEFAULT_RING_COLORS } from "./ringColors";
import { levelScale } from "@/lib/scalingConfig";

// Set by renderFighterPunchFrame so the live preview uses the editor's slider values.
// null = drawArms falls back to the saved PunchAnimConfig (fight rendering).
let _previewParams: {
  distanceMult: number;
  arcAmplitude: number;
  dropDepth: number;
  riseHeight: number;
  dropPhase: number;
} | null = null;

// ── Offscreen-canvas silhouette outline ───────────────────────────────────────
// Two canvases (body + silhouette) cached per canvas size – no per-frame GC.
const _offscreenCache = new Map<
  string,
  [HTMLCanvasElement, CanvasRenderingContext2D, HTMLCanvasElement, CanvasRenderingContext2D]
>();
// When true, drawArms skips glows so they are absent from the silhouette pass
// and therefore never receive a black outline ring of their own.
let _silhouetteMode = false;
/** Set by renderFighterPreview so the colour-picker preview shows headgear. */
let _previewHeadgear = false;

/**
 * True only while a still preview canvas is being drawn (menu portraits,
 * create-fighter, roster cards, the career-hub gym sprite).  Those poses read
 * as facing the camera, which needs two fixes the live fight must never get:
 * the stance's shoe direction points away from the way the fighter is looking,
 * and the head's forward offset stretches the neck.
 */
let _stillPreview = false;

function _getOffscreens(
  w: number,
  h: number,
): [HTMLCanvasElement, CanvasRenderingContext2D, HTMLCanvasElement, CanvasRenderingContext2D] {
  const key = `${w}x${h}`;
  let e = _offscreenCache.get(key);
  if (!e) {
    const body = document.createElement("canvas");
    body.width = w; body.height = h;
    const sil  = document.createElement("canvas");
    sil.width  = w; sil.height  = h;
    e = [body, body.getContext("2d")!, sil, sil.getContext("2d")!];
    _offscreenCache.set(key, e);
  }
  return e;
}

function parseHex(hex: string): [number, number, number] {
  // The Spacial finish is not a hex — everything that shades, contrasts or
  // gradients off it works from its base black instead.
  const h = (isSpacial(hex) ? SPACIAL_BASE_HEX : hex).replace('#', '');
  if (h.length === 6) {
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  return [128, 128, 128];
}

/**
 * Telegraph tell — the arm draw. The windup no longer animates the body at all:
 * no guard slide, no glove or head buzz, no body dip, no glove tint. All that is
 * left of it on the fighter is the punching hand easing this far back down its
 * own punch line over the tail of the windup, launching from there. The other
 * half of the tell is the rhythm marker speeding up (see `advanceSway`).
 *
 * Deliberately tiny: it should read as a hand loading, not as a wind-up pose.
 */
const TELEGRAPH_PULLBACK_PX = 2;
/** Fraction of the windup elapsed before the hand starts drawing back. */
const TELEGRAPH_PULLBACK_START = 0.6;

const CANVAS_W = 800;
const CANVAS_H = 600;
const RING_CX = 400;
const RING_CY = 260;
const RING_HALF_W = 280;
const RING_HALF_H = 180;

const CAM_PITCH = 0.62;
const CAM_ZOOM = 1.35;
const CAM_YAW_MAX = 0.55;
const CAM_YAW_LERP = 0.04;
const CAM_SCREEN_CX = CANVAS_W / 2;
const CAM_SCREEN_CY = CANVAS_H * 0.48;

let currentCameraYaw = 0;
let currentAutoZoom = 1.0;
const AUTO_ZOOM_MIN = 1.0;
const AUTO_ZOOM_MAX = 3.0;
const AUTO_ZOOM_LERP = 0.04;
const AUTO_ZOOM_DIST_MIN = 40;
const AUTO_ZOOM_DIST_MAX = 350;
const CAMERA_POS_LERP = 0.055;
const CAMERA_Y_BIAS = 74;
let delayedFocusX = CAM_SCREEN_CX;
let delayedFocusY = CAM_SCREEN_CY;

interface Vec3 {
  x: number;
  y: number;
  z: number;
}

interface ScreenPt {
  sx: number;
  sy: number;
  depth: number;
}

function rotateY(p: Vec3, yaw: number): Vec3 {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  return {
    x: p.x * c + p.z * s,
    y: p.y,
    z: -p.x * s + p.z * c,
  };
}

/** Slip directions in world space — the same axes the arrow keys walk along. */
const SLIP_WORLD_DIR: Record<SlipDir, { x: number; z: number }> = {
  left: { x: -1, z: 0 },
  right: { x: 1, z: 0 },
  forward: { x: 0, z: -1 },
  back: { x: 0, z: 1 },
};

function projectToScreen(wx: number, wz: number, wy: number = 0): ScreenPt {
  const rel: Vec3 = { x: wx - RING_CX, y: wy, z: wz - RING_CY };
  const rotated = rotateY(rel, currentCameraYaw);
  const sx = CAM_SCREEN_CX + rotated.x * CAM_ZOOM;
  const sy = CAM_SCREEN_CY + rotated.z * CAM_PITCH * CAM_ZOOM - rotated.y * CAM_ZOOM;
  return { sx, sy, depth: rotated.z };
}

function updateCamera(state: GameState): void {
  const midX = (state.player.x + state.enemy.x) / 2;
  const midZ = (state.player.z + state.enemy.z) / 2;
  const offsetX = midX - RING_CX;
  const offsetZ = midZ - RING_CY;
  // Tilt the camera based on where the action is relative to ring center
  const rawYaw = (offsetX / (RING_HALF_W + 1)) * CAM_YAW_MAX * 0.85
               + (offsetZ / (RING_HALF_H + 1)) * CAM_YAW_MAX * 0.35;
  const clampedYaw = Math.max(-CAM_YAW_MAX, Math.min(CAM_YAW_MAX, rawYaw));
  if (!isFinite(currentCameraYaw)) currentCameraYaw = clampedYaw;
  currentCameraYaw += (clampedYaw - currentCameraYaw) * CAM_YAW_LERP;
}

/**
 * Bumped by every resetAutoZoom so the 3D broadcast camera, which keeps its own
 * state, snaps back to the wide shot at the same moments the 2D camera does.
 */
let cameraResetEpoch = 0;
export function getCameraResetEpoch(): number {
  return cameraResetEpoch;
}

export function resetAutoZoom(): void {
  cameraResetEpoch++;
  currentAutoZoom = 1.0;
  delayedFocusX = CAM_SCREEN_CX;
  delayedFocusY = CAM_SCREEN_CY;
}

// Live camera parameters, exposed so the gym equipment overlay (GymView)
// can project world coordinates to final screen coordinates during sparring.
export function getCameraView(): { yaw: number; zoom: number; focusX: number; focusY: number } {
  return { yaw: currentCameraYaw, zoom: currentAutoZoom, focusX: delayedFocusX, focusY: delayedFocusY };
}

// Sparring takes place in the gym: GymView registers a drawer here that paints
// the gym equipment around the ring. renderGame calls it after the world pass
// (so it follows the live camera) and before the HUD (so UI stays on top).
let gymEnvironmentDrawer: ((ctx: CanvasRenderingContext2D, state: GameState) => void) | null = null;
export function setGymEnvironmentDrawer(fn: (ctx: CanvasRenderingContext2D, state: GameState) => void): void {
  gymEnvironmentDrawer = fn;
}

export function renderRingOnly(ctx: CanvasRenderingContext2D, state: GameState): void {
  ctx.save();
  // The hub ring can wear the Spacial finish, so the sentinel has to resolve to
  // the starfield on this path too, not just on fighters.
  enableSpacialFills(ctx);

  drawBackground(ctx, state);

  const savedYaw = currentCameraYaw;
  const savedZoom = currentAutoZoom;
  const savedFx = delayedFocusX;
  const savedFy = delayedFocusY;
  currentCameraYaw = 0;
  currentAutoZoom = 1.0;
  delayedFocusX = CAM_SCREEN_CX;
  delayedFocusY = CAM_SCREEN_CY;

  ctx.save();
  ctx.translate(CANVAS_W / 2, CANVAS_H / 2);
  ctx.scale(currentAutoZoom, currentAutoZoom);
  ctx.translate(-CAM_SCREEN_CX, -CAM_SCREEN_CY);

  drawCrowd(ctx, state);
  drawRingFloor(ctx, state);
  drawRingBackRopes(ctx, state);
  drawRingFrontRopes(ctx, state);

  ctx.restore();

  currentCameraYaw = savedYaw;
  currentAutoZoom = savedZoom;
  delayedFocusX = savedFx;
  delayedFocusY = savedFy;

  ctx.restore();
}

const COLORS = {
  staminaPlayer: "#22cc44",
  staminaEnemy: "#cc4422",
  staminaBg: "rgba(0,0,0,0.6)",
  ringFloor: "#3d2f1e",
  ringBorder: "#8b7355",
  ropePosts: "#8b7355",
  ringApron: "#2a2018",
};

/** One fighter's slot in a depth-sorted draw pass. */
interface DrawOrderEntry {
  fighter: FighterState;
  opponent: FighterState;
  pt: ScreenPt;
  oppPt: ScreenPt;
}

/**
 * Depth-sorting scratch buffers. The fighter list is rebuilt every frame but its
 * shape barely ever changes, so the entries are reused in place: at 60fps the old
 * `map`/spread version churned four short-lived objects per fighter per frame.
 * The two passes keep separate buffers because renderFightersOnly runs while
 * renderGame's array is still being read by the gym overlay pass.
 */
const mainDrawOrder: DrawOrderEntry[] = [];
const overlayDrawOrder: DrawOrderEntry[] = [];

function byScreenY(a: DrawOrderEntry, b: DrawOrderEntry): number {
  return a.pt.sy - b.pt.sy;
}

function pushDrawEntry(buf: DrawOrderEntry[], n: number, fighter: FighterState, opponent: FighterState): void {
  const pt = projectToScreen(fighter.x, fighter.z);
  const oppPt = projectToScreen(opponent.x, opponent.z);
  const existing = buf[n];
  if (existing) {
    existing.fighter = fighter;
    existing.opponent = opponent;
    existing.pt = pt;
    existing.oppPt = oppPt;
  } else {
    buf[n] = { fighter, opponent, pt, oppPt };
  }
}

/** Fill `buf` with every fighter that should be drawn this pass, projected. */
function fillDrawOrder(buf: DrawOrderEntry[], state: GameState): DrawOrderEntry[] {
  let n = 0;
  pushDrawEntry(buf, n++, state.player, state.enemy);
  pushDrawEntry(buf, n++, state.enemy, state.player);
  if (state.nightmareMode) {
    for (const extra of state.nightmareEnemies) {
      pushDrawEntry(buf, n++, extra, state.player);
    }
  }
  if (buf.length > n) buf.length = n;
  return buf;
}

/** Projects an engine floor point (px) plus a height (px) to 800x600 screen space. */
export type WorldProjector = (wx: number, wz: number, heightPx: number) => { sx: number; sy: number } | null;

export interface RenderGameOptions {
  /**
   * HUD-only pass for the 3D view: the canvas is cleared to transparent and the
   * world (crowd, ring, fighters, referee, ropes) is skipped — the WebGL layer
   * underneath draws it. Every screen-space overlay and its click hit-test is
   * unchanged. Camera shake is the 3D camera's job, so the HUD stays still.
   */
  hudOnly?: boolean;
  /** Required with hudOnly: places world-anchored text (hit effects) over the 3D view. */
  project?: WorldProjector;
}

export function renderGame(ctx: CanvasRenderingContext2D, state: GameState, options?: RenderGameOptions): void {
  // The ring itself can be bought in the Spacial finish, and it is drawn before
  // any fighter, so this cannot wait for drawFighter to install it.
  enableSpacialFills(ctx);
  if (options?.hudOnly) {
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    ctx.restore();
    ctx.save();
    if (options.project) drawHitEffectsProjected(ctx, state.hitEffects, options.project);
    drawScreenOverlays(ctx, state);
    ctx.restore();
    return;
  }
  ctx.save();

  if (state.shakeIntensity > 0 && state.shakeTimer > 0 && !state.isPaused && !state.staticCamera) {
    const sx = (Math.random() - 0.5) * state.shakeIntensity * 2;
    const sy = (Math.random() - 0.5) * state.shakeIntensity * 2;
    ctx.translate(sx, sy);
  }

  if (state.staticCamera) {
    // Fixed, fully zoomed-out camera: no yaw tracking, no auto-zoom, no focus follow
    currentCameraYaw = 0;
    currentAutoZoom = AUTO_ZOOM_MIN;
    delayedFocusX = CAM_SCREEN_CX;
    delayedFocusY = CAM_SCREEN_CY;
  } else {
    updateCamera(state);

    if (state.countdownTimer > 0) {
      currentAutoZoom = AUTO_ZOOM_MIN;
    } else {
      const dx = state.player.x - state.enemy.x;
      const dz = state.player.z - state.enemy.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      const t = Math.max(0, Math.min(1, (dist - AUTO_ZOOM_DIST_MIN) / (AUTO_ZOOM_DIST_MAX - AUTO_ZOOM_DIST_MIN)));
      const rawZoom = AUTO_ZOOM_MAX + (AUTO_ZOOM_MIN - AUTO_ZOOM_MAX) * t;
      const targetZoom = Math.max(AUTO_ZOOM_MIN, rawZoom * 0.8);
      currentAutoZoom += (targetZoom - currentAutoZoom) * AUTO_ZOOM_LERP;
      currentAutoZoom = Math.max(AUTO_ZOOM_MIN, Math.min(AUTO_ZOOM_MAX, currentAutoZoom));
    }
  }

  drawBackground(ctx, state);

  if (!state.staticCamera) {
    const midWX = (state.player.x + state.enemy.x) / 2;
    const midWZ = (state.player.z + state.enemy.z) / 2;
    const midScreen = projectToScreen(midWX, midWZ);
    const targetFocusX = midScreen.sx;
    const targetFocusY = midScreen.sy - CAMERA_Y_BIAS;
    delayedFocusX += (targetFocusX - delayedFocusX) * CAMERA_POS_LERP;
    delayedFocusY += (targetFocusY - delayedFocusY) * CAMERA_POS_LERP;
  }

  ctx.save();
  ctx.translate(CANVAS_W / 2, CANVAS_H / 2);
  ctx.scale(currentAutoZoom, currentAutoZoom);
  ctx.translate(-delayedFocusX, -delayedFocusY);

  if (!state.practiceMode && !state.sparringMode) {
    drawCrowd(ctx, state);
  }

  drawRingFloor(ctx, state);
  drawRingBackRopes(ctx, state);

  // Reuse the draw-order scratch buffer instead of allocating a pair array, a
  // projected array and one object per fighter on every single frame.
  const projected = fillDrawOrder(mainDrawOrder, state);
  // Sort by screen Y: the fighter lower on the screen always renders on top
  projected.sort(byScreenY);
  for (const entry of projected) {
    drawFighterWithOutline(ctx, entry.fighter, entry.opponent, state, entry.pt, entry.oppPt);
  }

  if (state.refereeVisible) {
    drawReferee(ctx, state);
  }

  drawRingFrontRopes(ctx, state);
  drawHitEffects(ctx, state.hitEffects);

  if (state.towelActive && state.towelTimer > 0) {
    drawTowelAnimation(ctx, state);
  }

  ctx.restore();

  // All sparring modes take place in the gym: draw the gym equipment around
  // the ring (excluded: the gym home screen itself draws its own overlays).
  if (state.sparringMode && !state.menuBackground && !state.tutorialMode && gymEnvironmentDrawer) {
    gymEnvironmentDrawer(ctx, state);
  }

  drawScreenOverlays(ctx, state);

  ctx.restore();
}

/** Every screen-space layer drawn over the world: HUD, banners, prompts, pause. */
function drawScreenOverlays(ctx: CanvasRenderingContext2D, state: GameState): void {
  if ((state.phase === "fighting" || state.phase === "prefight") && !state.menuBackground) {
    drawHUD(ctx, state);
  }

  if (state.phase === "prefight" && state.countdownTimer > 0 && !state.menuBackground) {
    drawCountdown(ctx, state.countdownTimer);
  }

  if (state.knockdownActive && !state.menuBackground) {
    drawKnockdownOverlay(ctx, state);
  }

  // Screen-space, like every other announcement here. This used to be drawn
  // inside the world transform, where the camera's pan and zoom dragged it off
  // centre and clipped it against the top or bottom edge.
  if (state.refStoppageActive && !state.menuBackground) {
    drawStoppageOverlay(ctx, state);
  }

  if (state.bigShotTextTimer > 0 && !state.menuBackground) {
    drawBigShotBanner(ctx, state.bigShotTextTimer);
  }

  if (state.tutorialMode && state.tutorialPrompt && !state.isPaused) {
    drawTutorialPrompt(ctx, state);
  }

  if (state.isPaused) {
    drawPauseMenu(ctx, state.pauseSelectedIndex, state.pauseSoundTab, state.pauseControlsTab, state.sparringMode || state.careerFightMode, state);
  }
}

// Re-draws the fighters on top of whatever has been painted since renderGame.
// Used by the gym home screen: equipment near the back wall (trophy cases,
// exit door, weight row) is drawn after renderGame and would otherwise cover
// fighters standing deep in the ring, even though the fighters are closer to
// the camera. When any fighter is behind `triggerZ`, all fighters up to
// `includeZ` are re-drawn (keeping their mutual depth order) so the back-row
// props never overlap them. Fighters beyond `includeZ` are left alone so the
// front ring ropes keep overlapping them correctly.
export function renderFightersOnly(ctx: CanvasRenderingContext2D, state: GameState, triggerZ = 210, includeZ = 300): void {
  const withPt = fillDrawOrder(overlayDrawOrder, state);
  if (!withPt.some(p => p.fighter.z < triggerZ)) return;
  // A fighter past `includeZ` is normally left to the earlier world pass so the
  // front ropes still cover him — but if he is standing in front of a fighter
  // this pass re-draws, skipping him would paint the deeper body over the
  // nearer one. Whoever is lower on screen always wins, so pull those
  // neighbours into the pass too.
  const OVERLAP_PX = 70;
  const projected = withPt.filter(p =>
    p.fighter.z < includeZ
    || withPt.some(q => q.fighter.z < includeZ
      && q.pt.sy < p.pt.sy
      && Math.abs(q.pt.sx - p.pt.sx) < OVERLAP_PX));
  if (projected.length === 0) return;
  // Sort by screen Y: the fighter lower on the screen always renders on top
  projected.sort((a, b) => a.pt.sy - b.pt.sy);
  ctx.save();
  ctx.translate(CANVAS_W / 2, CANVAS_H / 2);
  ctx.scale(currentAutoZoom, currentAutoZoom);
  ctx.translate(-delayedFocusX, -delayedFocusY);
  projected.forEach(({ fighter, opponent, pt, oppPt }) => drawFighterWithOutline(ctx, fighter, opponent, state, pt, oppPt));
  // Keep the referee visible too (e.g. knockdown counts deep in the ring)
  if (state.refereeVisible && state.refZ < includeZ) {
    drawReferee(ctx, state);
  }
  ctx.restore();
}

function drawBackground(ctx: CanvasRenderingContext2D, state: GameState): void {
  const isGym = state.practiceMode || state.sparringMode;

  if (isGym) {
    // Gym: warm wood-paneled floor with depth gradient
    const gymGrad = ctx.createLinearGradient(0, 0, 0, CANVAS_H);
    gymGrad.addColorStop(0, "#b8936a");
    gymGrad.addColorStop(0.4, "#c9a47a");
    gymGrad.addColorStop(0.75, "#d4af87");
    gymGrad.addColorStop(1, "#bf9a72");
    ctx.fillStyle = gymGrad;
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
    // Overhead gym light
    const gymSpot = ctx.createRadialGradient(
      CANVAS_W / 2, CANVAS_H * 0.25, 10,
      CANVAS_W / 2, CANVAS_H * 0.5, CANVAS_H * 0.65
    );
    gymSpot.addColorStop(0, "rgba(255, 240, 200, 0.22)");
    gymSpot.addColorStop(0.4, "rgba(220, 190, 140, 0.08)");
    gymSpot.addColorStop(1, "rgba(0, 0, 0, 0.18)");
    ctx.fillStyle = gymSpot;
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
    return;
  }

  const grad = ctx.createLinearGradient(0, 0, 0, CANVAS_H);
  grad.addColorStop(0, "#06040e");
  grad.addColorStop(0.25, "#0f0a1a");
  grad.addColorStop(0.6, "#14101f");
  grad.addColorStop(1, "#0a0812");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

  // Overhead spotlight glow shining down onto the ring from above
  const arenaSpot = ctx.createRadialGradient(
    CANVAS_W / 2, CANVAS_H * 0.18, 5,
    CANVAS_W / 2, CANVAS_H * 0.5, CANVAS_H * 0.7
  );
  arenaSpot.addColorStop(0, "rgba(255, 220, 140, 0.10)");
  arenaSpot.addColorStop(0.25, "rgba(220, 170, 100, 0.05)");
  arenaSpot.addColorStop(0.6, "rgba(150, 100, 60, 0.02)");
  arenaSpot.addColorStop(1, "rgba(0, 0, 0, 0)");
  ctx.fillStyle = arenaSpot;
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

  // Subtle star/ambient particles
  ctx.fillStyle = "rgba(255, 210, 130, 0.012)";
  for (let i = 0; i < 30; i++) {
    const x = (Math.sin(i * 7.3) * 0.5 + 0.5) * CANVAS_W;
    const y = (Math.sin(i * 4.7) * 0.5 + 0.5) * CANVAS_H * 0.45;
    ctx.beginPath();
    ctx.arc(x, y, 2 + Math.sin(i * 2.1) * 1.5, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawCrowdEdge(
  ctx: CanvasRenderingContext2D,
  startWX: number, startWZ: number,
  endWX: number, endWZ: number,
  rows: number, perRow: number,
  outwardX: number, outwardZ: number,
  t0: number, kdBounce: boolean,
  seedBase: number, headSize: number, bodySize: number, brightness: number
): void {
  for (let row = 0; row < rows; row++) {
    const rowOff = (row + 1) * 18;
    const ox = outwardX * rowOff;
    const oz = outwardZ * rowOff;
    for (let i = 0; i < perRow; i++) {
      const frac = (i + 0.5) / perRow;
      const wx = startWX + (endWX - startWX) * frac + ox + Math.sin(i * 3.7 + row * 2.1) * 8;
      const wz = startWZ + (endWZ - startWZ) * frac + oz + Math.cos(i * 2.3 + row * 1.7) * 5;
      const p = projectToScreen(wx, wz);
      const seed = seedBase + i * 1.7 + row * 3.1;
      let bobX = Math.sin(t0 * 1.2 + seed) * 1.5;
      let bobY = Math.sin(t0 * 1.8 + seed * 0.7) * 1.0;
      if (kdBounce) {
        bobY += Math.abs(Math.sin(t0 * 6 + seed)) * 4;
        bobX += Math.sin(t0 * 4 + seed * 1.3) * 2;
      }
      const px = p.sx + bobX;
      const py = p.sy + bobY;
      const hue = (i * 37 + row * 90 + seedBase * 13) % 360;
      const depthDim = Math.max(0.6, 1 - row * 0.12);
      const lHead = Math.round((brightness + row * 3) * depthDim);
      const lBody = Math.round((brightness + 8 + row * 3) * depthDim);
      ctx.fillStyle = `hsl(${hue}, 30%, ${lHead}%)`;
      ctx.beginPath();
      ctx.arc(px, py, headSize - row * 0.3, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = `hsl(${hue}, 20%, ${lBody}%)`;
      ctx.beginPath();
      ctx.ellipse(px, py + headSize + 1, headSize - row * 0.2, bodySize - row * 0.3, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function drawCrowdCorner(
  ctx: CanvasRenderingContext2D,
  cornerWX: number, cornerWZ: number,
  outDirX: number, outDirZ: number,
  spreadX: number, spreadZ: number,
  count: number, rows: number,
  t0: number, kdBounce: boolean,
  seedBase: number, headSize: number, bodySize: number, brightness: number
): void {
  for (let row = 0; row < rows; row++) {
    const rowOff = (row + 1) * 16;
    for (let i = 0; i < count; i++) {
      const frac = (i - count / 2) / count;
      const wx = cornerWX + outDirX * rowOff + spreadX * frac * (row + 1) * 8 + Math.sin(i * 5.3 + row * 1.9) * 6;
      const wz = cornerWZ + outDirZ * rowOff + spreadZ * frac * (row + 1) * 8 + Math.cos(i * 3.1 + row * 2.7) * 4;
      const p = projectToScreen(wx, wz);
      const seed = seedBase + i * 2.3 + row * 4.1;
      let bobX = Math.sin(t0 * 1.2 + seed) * 1.5;
      let bobY = Math.sin(t0 * 1.8 + seed * 0.7) * 1.0;
      if (kdBounce) {
        bobY += Math.abs(Math.sin(t0 * 6 + seed)) * 4;
        bobX += Math.sin(t0 * 4 + seed * 1.3) * 2;
      }
      const px = p.sx + bobX;
      const py = p.sy + bobY;
      const hue = (i * 47 + row * 110 + seedBase * 17) % 360;
      const depthDim = Math.max(0.6, 1 - row * 0.1);
      const lHead = Math.round((brightness + row * 3) * depthDim);
      const lBody = Math.round((brightness + 8 + row * 3) * depthDim);
      ctx.fillStyle = `hsl(${hue}, 30%, ${lHead}%)`;
      ctx.beginPath();
      ctx.arc(px, py, headSize - row * 0.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = `hsl(${hue}, 20%, ${lBody}%)`;
      ctx.beginPath();
      ctx.ellipse(px, py + headSize + 1, headSize - row * 0.15, bodySize - row * 0.2, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function drawCrowd(ctx: CanvasRenderingContext2D, state: GameState): void {
  ctx.save();
  const outerW = RING_HALF_W + 50;
  const outerH = RING_HALF_H + 35;
  const corners = getDiamondCorners(outerW, outerH);
  const [top, right, bot, left] = corners;

  const t0 = state.crowdBobTime;
  const kdBounce = state.crowdKdBounceTimer > 0;

  drawCrowdEdge(ctx, left[0], left[1], top[0], top[1], 14, 28, -0.9, -0.7, t0, kdBounce, 0, 4, 5, 14);
  drawCrowdEdge(ctx, top[0], top[1], right[0], right[1], 14, 28, 0.9, -0.7, t0, kdBounce, 50, 4, 5, 14);
  drawCrowdEdge(ctx, right[0], right[1], bot[0], bot[1], 12, 24, 0.9, 0.7, t0, kdBounce, 100, 3.5, 4.5, 16);
  drawCrowdEdge(ctx, left[0], left[1], bot[0], bot[1], 12, 24, -0.9, 0.7, t0, kdBounce, 150, 3.5, 4.5, 16);

  drawCrowdCorner(ctx, top[0], top[1], 0, -1, 1, 0, 10, 10, t0, kdBounce, 200, 3.5, 4.5, 13);
  drawCrowdCorner(ctx, bot[0], bot[1], 0, 1, 1, 0, 10, 8, t0, kdBounce, 220, 3.5, 4.5, 16);
  drawCrowdCorner(ctx, left[0], left[1], -1, 0, 0, 1, 10, 10, t0, kdBounce, 240, 3.5, 4.5, 14);
  drawCrowdCorner(ctx, right[0], right[1], 1, 0, 0, 1, 10, 10, t0, kdBounce, 260, 3.5, 4.5, 14);

  ctx.restore();
}

function getDiamondCorners(hw: number = RING_HALF_W, hh: number = RING_HALF_H): [number, number][] {
  return [
    [RING_CX, RING_CY - hh],
    [RING_CX + hw, RING_CY],
    [RING_CX, RING_CY + hh],
    [RING_CX - hw, RING_CY],
  ];
}

function drawProjectedPolygon(ctx: CanvasRenderingContext2D, worldPoints: [number, number][]): void {
  if (worldPoints.length < 3) return;
  ctx.beginPath();
  const first = projectToScreen(worldPoints[0][0], worldPoints[0][1]);
  ctx.moveTo(first.sx, first.sy);
  for (let i = 1; i < worldPoints.length; i++) {
    const p = projectToScreen(worldPoints[i][0], worldPoints[i][1]);
    ctx.lineTo(p.sx, p.sy);
  }
  ctx.closePath();
}

function darkenHex(hex: string, amount: number): string {
  const r = Math.max(0, parseInt(hex.slice(1, 3), 16) - amount);
  const g = Math.max(0, parseInt(hex.slice(3, 5), 16) - amount);
  const b = Math.max(0, parseInt(hex.slice(5, 7), 16) - amount);
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

function drawRingFloor(ctx: CanvasRenderingContext2D, state: GameState): void {
  ctx.save();

  const canvasColor = state.ringColors?.canvas || state.ringCanvasColor || COLORS.ringFloor;
  // darkenHex parses a hex, so the sentinel has to be resolved before it reaches
  // it. A Spacial canvas takes a Spacial apron so the skirt reads as one material.
  const apronColor = isSpacial(canvasColor) ? SPACIAL_COLOR : darkenHex(cssColorOf(canvasColor), 20);

  ctx.fillStyle = "rgba(30, 22, 15, 0.5)";
  const shadowCorners = getDiamondCorners(RING_HALF_W + 15, RING_HALF_H + 10);
  const shadowOffset: [number, number][] = shadowCorners.map(([x, z]) => [x, z + 8]);
  drawProjectedPolygon(ctx, shadowOffset);
  ctx.fill();

  const apronCorners = getDiamondCorners(RING_HALF_W + 6, RING_HALF_H + 4);
  ctx.fillStyle = apronColor;
  drawProjectedPolygon(ctx, apronCorners);
  ctx.fill();

  const floorCorners = getDiamondCorners();
  ctx.fillStyle = canvasColor;
  drawProjectedPolygon(ctx, floorCorners);
  ctx.fill();

  ctx.strokeStyle = "rgba(255,255,255,0.025)";
  ctx.lineWidth = 1;
  for (let i = 1; i < 8; i++) {
    const t = i / 8;
    const corners = getDiamondCorners();
    const [top, right, bot, left] = corners;
    const startX = left[0] + (top[0] - left[0]) * t;
    const startZ = left[1] + (top[1] - left[1]) * t;
    const endX = right[0] + (bot[0] - right[0]) * t;
    const endZ = right[1] + (bot[1] - right[1]) * t;
    const pS = projectToScreen(startX, startZ);
    const pE = projectToScreen(endX, endZ);
    ctx.beginPath();
    ctx.moveTo(pS.sx, pS.sy);
    ctx.lineTo(pE.sx, pE.sy);
    ctx.stroke();

    const s2X = top[0] + (right[0] - top[0]) * t;
    const s2Z = top[1] + (right[1] - top[1]) * t;
    const e2X = left[0] + (bot[0] - left[0]) * t;
    const e2Z = left[1] + (bot[1] - left[1]) * t;
    const pS2 = projectToScreen(s2X, s2Z);
    const pE2 = projectToScreen(e2X, e2Z);
    ctx.beginPath();
    ctx.moveTo(pS2.sx, pS2.sy);
    ctx.lineTo(pE2.sx, pE2.sy);
    ctx.stroke();
  }

  ctx.strokeStyle = state.ringColors?.border || COLORS.ringBorder;
  ctx.lineWidth = 2;
  drawProjectedPolygon(ctx, floorCorners);
  ctx.stroke();

  // Strong overhead spotlight for depth
  const spotCX = CAM_SCREEN_CX;
  const spotCY = CAM_SCREEN_CY - 10;
  const radGrad = ctx.createRadialGradient(
    spotCX, spotCY, 5,
    spotCX, spotCY, 240
  );
  radGrad.addColorStop(0, "rgba(255, 230, 170, 0.18)");
  radGrad.addColorStop(0.35, "rgba(255, 210, 130, 0.07)");
  radGrad.addColorStop(0.7, "rgba(180, 140, 80, 0.03)");
  radGrad.addColorStop(1, "rgba(0, 0, 0, 0)");
  ctx.fillStyle = radGrad;
  drawProjectedPolygon(ctx, floorCorners);
  ctx.save();
  ctx.clip();
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
  ctx.restore();


  ctx.restore();
}

function isEdgeBackFacing(p1: [number, number], p2: [number, number]): boolean {
  const mid = projectToScreen((p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2);
  return mid.depth < 20;
}

/** The three rope colours, bottom to top, falling back to the stock red/white/red. */
function ringRopeColors(state: GameState): [string, string, string] {
  const rc = state.ringColors;
  return [
    rc?.ropeLower || DEFAULT_RING_COLORS.ropeLower,
    rc?.ropeMiddle || DEFAULT_RING_COLORS.ropeMiddle,
    rc?.ropeUpper || DEFAULT_RING_COLORS.ropeUpper,
  ];
}

function getCornerPostColor(cornerIndex: number, state: GameState): string {
  // An explicit ring palette wins, and it may legitimately BE the sentinel — the
  // ring is now allowed to wear the finish, so this can return it unresolved and
  // the caller decides between painting it and parsing it.
  const override = state.ringColors?.posts;
  if (override) return override;
  // Otherwise the furniture borrows the trunk colours but is not gear: a Spacial
  // fighter gets a black corner post, not a starfield (and never the raw
  // sentinel, which a gradient colour stop would reject).
  if (cornerIndex === 3) return cssColorOf(state.playerColors.trunks);
  if (cornerIndex === 1) return cssColorOf(state.enemyColors.trunks);
  return "#ffffff";
}

function drawRingBackRopes(ctx: CanvasRenderingContext2D, state: GameState): void {
  ctx.save();
  const corners = getDiamondCorners();
  const edges: [[number, number], [number, number]][] = [
    [corners[0], corners[1]],
    [corners[1], corners[2]],
    [corners[2], corners[3]],
    [corners[3], corners[0]],
  ];

  const ropeColors = ringRopeColors(state);
  const ropeHeights = [8, 18, 28];

  edges.forEach(([p1, p2]) => {
    if (!isEdgeBackFacing(p1, p2)) return;

    const pp1 = projectToScreen(p1[0], p1[1]);
    const pp2 = projectToScreen(p2[0], p2[1]);

    ctx.strokeStyle = COLORS.ringBorder;
    ctx.lineWidth = 3;
    ctx.globalAlpha = 0.4;
    ctx.beginPath();
    ctx.moveTo(pp1.sx, pp1.sy);
    ctx.lineTo(pp1.sx, pp1.sy - 30 * CAM_ZOOM);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(pp2.sx, pp2.sy);
    ctx.lineTo(pp2.sx, pp2.sy - 30 * CAM_ZOOM);
    ctx.stroke();

    ropeHeights.forEach((h, i) => {
      const s1 = projectToScreen(p1[0], p1[1], h);
      const s2 = projectToScreen(p2[0], p2[1], h);
      const ropeW = i === 1 ? 2.5 : 3.5;
      const ropeCol = ropeColors[i];
      const ropeHex = cssColorOf(ropeCol);
      const ropeDark = shadeColor(ropeHex === "#ffffff" ? "#888888" : ropeHex, -60);
      const ropeLight = shadeColor(ropeHex, 40);

      // 3D rope: shadow stroke + main stroke + highlight
      ctx.globalAlpha = 0.75;
      ctx.strokeStyle = ropeDark;
      ctx.lineWidth = ropeW + 2;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(s1.sx + 1, s1.sy + 1);
      ctx.lineTo(s2.sx + 1, s2.sy + 1);
      ctx.stroke();
      ctx.strokeStyle = ropeCol;
      ctx.lineWidth = ropeW;
      ctx.beginPath();
      ctx.moveTo(s1.sx, s1.sy);
      ctx.lineTo(s2.sx, s2.sy);
      ctx.stroke();
      ctx.strokeStyle = ropeLight;
      ctx.lineWidth = ropeW * 0.3;
      ctx.globalAlpha = 0.35;
      ctx.beginPath();
      ctx.moveTo(s1.sx - 0.5, s1.sy - 0.8);
      ctx.lineTo(s2.sx - 0.5, s2.sy - 0.8);
      ctx.stroke();
    });

    ctx.globalAlpha = 1;
  });

  corners.forEach(([cx, cz], idx) => {
    const cp = projectToScreen(cx, cz);
    if (cp.depth >= 20) return;
    if (!isFinite(cp.sx) || !isFinite(cp.sy)) return;

    const topP = projectToScreen(cx, cz, 36);
    const postColor = getCornerPostColor(idx, state);
    const postHex = cssColorOf(postColor);
    const postDark = shadeColor(postHex, -50);
    const postLight = shadeColor(postHex, 40);

    // Draw 3D cylinder post using gradient stroke
    const postW = 6;
    const postGrad = ctx.createLinearGradient(cp.sx - postW, cp.sy, cp.sx + postW, cp.sy);
    postGrad.addColorStop(0, postDark);
    postGrad.addColorStop(0.3, postLight);
    postGrad.addColorStop(0.65, postHex);
    postGrad.addColorStop(1, postDark);

    // A Spacial post paints the starfield instead of a shaded cylinder: the
    // sentinel cannot travel through addColorStop.
    ctx.strokeStyle = isSpacial(postColor) ? SPACIAL_COLOR : postGrad;
    ctx.lineWidth = postW * 2;
    ctx.lineCap = "round";
    ctx.globalAlpha = 0.9;
    ctx.beginPath();
    ctx.moveTo(cp.sx, cp.sy);
    ctx.lineTo(topP.sx, topP.sy);
    ctx.stroke();

    // Post cap (top)
    ctx.fillStyle = postLight;
    ctx.globalAlpha = 0.85;
    ctx.beginPath();
    ctx.ellipse(topP.sx, topP.sy, postW * 0.85, postW * 0.45, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = postDark;
    ctx.lineWidth = 0.5;
    ctx.stroke();
    ctx.globalAlpha = 1;
  });

  ctx.restore();
}

function drawRingFrontRopes(ctx: CanvasRenderingContext2D, state: GameState): void {
  ctx.save();
  const corners = getDiamondCorners();
  const edges: [[number, number], [number, number]][] = [
    [corners[0], corners[1]],
    [corners[1], corners[2]],
    [corners[2], corners[3]],
    [corners[3], corners[0]],
  ];

  const ropeColors = ringRopeColors(state);
  const ropeHeights = [8, 18, 28];

  edges.forEach(([p1, p2]) => {
    if (isEdgeBackFacing(p1, p2)) return;

    const pp1 = projectToScreen(p1[0], p1[1]);
    const pp2 = projectToScreen(p2[0], p2[1]);

    ctx.strokeStyle = COLORS.ringBorder;
    ctx.lineWidth = 3;
    ctx.globalAlpha = 0.15;
    ctx.beginPath();
    ctx.moveTo(pp1.sx, pp1.sy);
    ctx.lineTo(pp1.sx, pp1.sy - 30 * CAM_ZOOM);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(pp2.sx, pp2.sy);
    ctx.lineTo(pp2.sx, pp2.sy - 30 * CAM_ZOOM);
    ctx.stroke();

    ropeHeights.forEach((h, i) => {
      const s1 = projectToScreen(p1[0], p1[1], h);
      const s2 = projectToScreen(p2[0], p2[1], h);
      const ropeW = i === 1 ? 2.5 : 3.5;
      const ropeCol = ropeColors[i];
      const ropeHex = cssColorOf(ropeCol);
      const ropeDark = shadeColor(ropeHex === "#ffffff" ? "#888888" : ropeHex, -60);
      const ropeLight = shadeColor(ropeHex, 40);
      // Front ropes semi-transparent
      ctx.globalAlpha = 0.14;
      ctx.strokeStyle = ropeDark;
      ctx.lineWidth = ropeW + 2;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(s1.sx + 1, s1.sy + 1);
      ctx.lineTo(s2.sx + 1, s2.sy + 1);
      ctx.stroke();
      ctx.strokeStyle = ropeCol;
      ctx.lineWidth = ropeW;
      ctx.beginPath();
      ctx.moveTo(s1.sx, s1.sy);
      ctx.lineTo(s2.sx, s2.sy);
      ctx.stroke();
    });

    ctx.globalAlpha = 1;
  });

  corners.forEach(([cx, cz], idx) => {
    const cp = projectToScreen(cx, cz);
    if (cp.depth < 20) return;

    const topP = projectToScreen(cx, cz, 36);
    const postColor = getCornerPostColor(idx, state);
    const postHex = cssColorOf(postColor);
    const postDark = shadeColor(postHex, -50);
    const postLight = shadeColor(postHex, 40);

    // 3D cylinder post (front, semi-transparent to show it's in front)
    const postW = 6;
    const postGrad = ctx.createLinearGradient(cp.sx - postW, cp.sy, cp.sx + postW, cp.sy);
    postGrad.addColorStop(0, postDark);
    postGrad.addColorStop(0.3, postLight);
    postGrad.addColorStop(0.65, postHex);
    postGrad.addColorStop(1, postDark);

    // A Spacial post paints the starfield instead of a shaded cylinder: the
    // sentinel cannot travel through addColorStop.
    ctx.strokeStyle = isSpacial(postColor) ? SPACIAL_COLOR : postGrad;
    ctx.lineWidth = postW * 2;
    ctx.lineCap = "round";
    ctx.globalAlpha = 0.22;
    ctx.beginPath();
    ctx.moveTo(cp.sx, cp.sy);
    ctx.lineTo(topP.sx, topP.sy);
    ctx.stroke();

    ctx.fillStyle = postLight;
    ctx.globalAlpha = 0.12;
    ctx.beginPath();
    ctx.ellipse(topP.sx, topP.sy, postW * 0.85, postW * 0.45, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  });

  ctx.restore();
}

const FIGHTER_SCALE = 1.6;
const BODY_H = 28 * FIGHTER_SCALE;
/**
 * Started from real proportions — the body stack below the neck is
 * 54 * FIGHTER_SCALE and an adult is ~7.5 head-heights tall, giving 4.2 — then
 * bumped 30% for readability at game scale.  Everything on the head (neck,
 * eyes, headgear) is expressed as a fraction of this, so it all rescales.
 */
const HEAD_R = 6.28 * FIGHTER_SCALE;
const UPPER_ARM_L = 14 * FIGHTER_SCALE;
const FOREARM_L = 12 * FIGHTER_SCALE;
const UPPER_LEG_L = 14 * FIGHTER_SCALE;
const LOWER_LEG_L = 12 * FIGHTER_SCALE;
const GLOVE_R = 5 * FIGHTER_SCALE;
const SHOE_H = 4 * FIGHTER_SCALE;
/** Used when a save predates the editable sock colour. */
export const DEFAULT_SOCK_COLOR = "#f0f0f0";
const TORSO_W = 11.6 * FIGHTER_SCALE;

/**
 * Draws a fighter with a 1-px black silhouette outline that never overlaps the
 * fighter's own body.  The telegraph glow ring and perfect-block glow are
 * excluded from the outline so they render cleanly on top.
 *
 * Strategy:
 *  1. Capture mainCtx's current transform (zoom, shake, depth, etc.).
 *  2. Draw fighter WITHOUT glows onto bodyCanvas using that same transform.
 *  3. Build a pure-black silhouette from bodyCanvas via destination-in.
 *  4. Stamp the silhouette offset ±1 px in 8 directions at identity on mainCtx.
 *  5. Draw fighter WITH glows onto bodyCanvas, then composite at identity on top.
 */
function drawFighterWithOutline(
  mainCtx: CanvasRenderingContext2D,
  fighter: FighterState,
  opponent: FighterState,
  state: GameState,
  screenPt: ScreenPt,
  oppPt: ScreenPt,
): void {
  const cw = mainCtx.canvas.width;
  const ch = mainCtx.canvas.height;
  const [bodyCanvas, bodyCtx, silCanvas, silCtx] = _getOffscreens(cw, ch);
  const tx = mainCtx.getTransform();

  // Pass 1 – without glows, for silhouette creation.
  _silhouetteMode = true;
  bodyCtx.clearRect(0, 0, cw, ch);
  bodyCtx.setTransform(tx);
  drawFighter(bodyCtx, fighter, opponent, state, screenPt, oppPt);
  bodyCtx.setTransform(1, 0, 0, 1, 0, 0);
  _silhouetteMode = false;

  // Build black silhouette: fill black, punch through with fighter alpha.
  silCtx.clearRect(0, 0, cw, ch);
  silCtx.fillStyle = "#000000";
  silCtx.fillRect(0, 0, cw, ch);
  silCtx.globalCompositeOperation = "destination-in";
  silCtx.drawImage(bodyCanvas, 0, 0);
  silCtx.globalCompositeOperation = "source-over";

  // Pass 2 – with glows; this is what the player sees.
  bodyCtx.clearRect(0, 0, cw, ch);
  bodyCtx.setTransform(tx);
  drawFighter(bodyCtx, fighter, opponent, state, screenPt, oppPt);
  bodyCtx.setTransform(1, 0, 0, 1, 0, 0);

  // Composite onto mainCtx at identity – the pre-baked transform inside
  // bodyCanvas/silCanvas means pixels land at exactly the right screen position.
  const savedTx = mainCtx.getTransform();
  mainCtx.setTransform(1, 0, 0, 1, 0, 0);
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      if (!dx && !dy) continue;
      mainCtx.drawImage(silCanvas, dx, dy);
    }
  }
  mainCtx.drawImage(bodyCanvas, 0, 0); // body on top → outline never overlaps
  mainCtx.setTransform(savedTx);
}

function drawFighter(ctx: CanvasRenderingContext2D, fighter: FighterState, opponent: FighterState, state: GameState, screenPt: ScreenPt, oppPt: ScreenPt): void {
  // One choke point for the Spacial finish: from here on, any gear colour that
  // is the sentinel paints the drifting starfield instead of a flat colour.
  enableSpacialFills(ctx);
  if (fighter.isKnockedDown) {
    drawKnockedDownFighter(ctx, fighter, screenPt, state);
    return;
  }

  const c = fighter.colors;
  const fwdDx = oppPt.sx - screenPt.sx;
  const fwdDy = oppPt.sy - screenPt.sy;
  const fwdLen = Math.sqrt(fwdDx * fwdDx + fwdDy * fwdDy) || 1;
  const fwdNx = fwdDx / fwdLen;
  const fwdNy = fwdDy / fwdLen;
  const sx = screenPt.sx + fighter.swayOffset * fwdNx * 0.5;
  const baseY = screenPt.sy + fighter.swayOffset * fwdNy * 0.2;

  // Depth-based perspective scaling: fighters closer to camera appear larger
  const depthNorm = Math.max(-1.2, Math.min(1.2, screenPt.depth / RING_HALF_H));
  const depthScale = 1.0 - depthNorm * 0.22;

  ctx.save();
  // Apply depth perspective scale around fighter foot position
  ctx.translate(sx, baseY);
  ctx.scale(depthScale, depthScale);
  ctx.translate(-sx, -baseY);

  const critFlash = fighter.critHitTimer > 0;
  if (fighter.isHit && !critFlash) {
    ctx.globalAlpha = 0.7 + Math.sin(Date.now() * 0.03) * 0.3;
  }

  const viewAngle = fighter.facingAngle - currentCameraYaw + Math.PI;
  const sideView = Math.sin(viewAngle);
  const frontView = -Math.cos(viewAngle);

  const bodyWidthMult = Math.abs(sideView) * 0.35 + Math.abs(frontView) * 1.0;

  // Depth-aware ground shadow: radial gradient for soft 3D look
  // Excluded from silhouette pass so the shadow ellipse never gets outlined
  if (!_silhouetteMode) {
    const shadowRX = 18 * FIGHTER_SCALE * 0.6 * bodyWidthMult;
    const shadowRY = 8 * FIGHTER_SCALE * 0.4;
    const shadowGrad = ctx.createRadialGradient(sx, baseY + 2, 0, sx, baseY + 2, shadowRX);
    shadowGrad.addColorStop(0, "rgba(0,0,0,0.45)");
    shadowGrad.addColorStop(0.55, "rgba(0,0,0,0.20)");
    shadowGrad.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = shadowGrad;
    ctx.beginPath();
    ctx.ellipse(sx, baseY + 2, shadowRX * 1.15, shadowRY * 1.4, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  const isDucking = fighter.defenseState === "duck";
  const dp = fighter.duckProgress;
  const duckFactor = 1.0 - dp * 0.4;

  const bodyHeight = BODY_H * duckFactor;
  const bob = fighter.rhythmLevel > 0
    ? Math.abs(fighter.swayOffset / 5) * 3.0 * FIGHTER_SCALE
    : Math.sin(fighter.bobPhase) * 1.5 * FIGHTER_SCALE;

  const hipY = baseY - LOWER_LEG_L - UPPER_LEG_L * duckFactor + bob;
  const depthShift = frontView * 3;

  const roughShoulderY = hipY - bodyHeight;
  const oppTorsoY = oppPt.sy - (LOWER_LEG_L + UPPER_LEG_L + BODY_H * 0.5);
  const toOppDx = oppPt.sx - sx;
  const toOppDy = oppTorsoY - roughShoulderY;
  const toOppDist = Math.max(1, Math.sqrt(toOppDx * toOppDx + toOppDy * toOppDy));
  const punchDirX = toOppDx / toOppDist;
  const punchDirY = toOppDy / toOppDist;

  const torsoLeanFwd = 0.10;
  let leanOffsetX = punchDirX * bodyHeight * torsoLeanFwd;
  let leanOffsetY = punchDirY * bodyHeight * torsoLeanFwd;

  // Slip: the trunk tilts off the hips towards the slipped side and the head
  // travels further than the shoulders do. The lean is eased in the engine and
  // outlives the slip itself, which is what gives the snap back.
  let slipHeadOX = 0;
  let slipHeadOY = 0;
  if (fighter.slipLean > 0.002) {
    const sd = SLIP_WORLD_DIR[fighter.slipLeanDir];
    const slipFrom = projectToScreen(fighter.x, fighter.z);
    const slipTo = projectToScreen(fighter.x + sd.x * 30, fighter.z + sd.z * 30);
    const sdx = slipTo.sx - slipFrom.sx;
    const sdy = slipTo.sy - slipFrom.sy;
    const sdLen = Math.sqrt(sdx * sdx + sdy * sdy) || 1;
    const slipNx = sdx / sdLen;
    const slipNy = sdy / sdLen;
    leanOffsetX += slipNx * bodyHeight * 0.22 * fighter.slipLean;
    leanOffsetY += slipNy * bodyHeight * 0.22 * fighter.slipLean;
    // 4.2px of extra head travel, down 40% from the original 7 — the head still
    // leads the shoulders, but the neck no longer stretches to reach it.
    slipHeadOX = slipNx * 4.2 * FIGHTER_SCALE * fighter.slipLean;
    slipHeadOY = slipNy * 4.2 * FIGHTER_SCALE * fighter.slipLean;
  }

  // Energy fatigue: the trunk and the arms lag behind the feet. The sway runs
  // along the same axis a slip does, at a fraction of a slip's travel, and the
  // arms trail the trunk. drawArms is handed the RESIDUAL (arm minus torso) so
  // the gloves sit behind the chest they hang off rather than riding with it.
  const fSway = fatigueSwayOffsets(fighter);
  // One px scale for the torso, the per-arm residuals and the snap holds alike,
  // so they cannot drift apart. During a Reset it carries the travel multiplier
  // that exaggerates the gesture; the rest of the time it is exactly the sway.
  const fatigueSwayPx = bodyHeight * 0.22 * fatigueSwaySlipFraction() * resetSnapDistanceMult(fighter);
  leanOffsetX += punchDirX * fSway.torso * fatigueSwayPx;
  leanOffsetY += punchDirY * fSway.torso * fatigueSwayPx;
  // Per-arm lag along the sway direction, in px. The shoulders ride with the
  // torso, so what an arm actually shows is its residual against it — plus,
  // during a Reset snap, whatever pose that arm is still holding. Which side is
  // lead and whether it has been released are both settled inside drawArms.
  const fatigueLag = {
    lead: (fSway.armLead - fSway.torso) * fatigueSwayPx,
    rear: (fSway.armRear - fSway.torso) * fatigueSwayPx,
    snapLeft: fatigueArmSnapHold(fighter, true) * fatigueSwayPx,
    snapRight: fatigueArmSnapHold(fighter, false) * fatigueSwayPx,
  };

  const shoulderY = hipY - bodyHeight + Math.abs(leanOffsetY) * 0.3;
  const headY = shoulderY - HEAD_R * 1.025;
  const bodyX = sx + depthShift + leanOffsetX;

  const tW = TORSO_W * 0.5 * bodyWidthMult;
  // Boxer's V: the shoulders carry the width and the waist pulls in.
  const shoulderW = tW * 1.12;
  // The torso base is pulled in 15% for a narrower waist; the trunks and the
  // waist stripe keep the original hip width, so they are sized off hipWFull.
  const hipWFull = tW * 0.78;
  const hipW = hipWFull * 0.85;
  const trunkW = hipWFull * 1.16;

  drawLegs(ctx, fighter, sx, baseY, hipY, sideView, frontView, bodyWidthMult, duckFactor, bob, critFlash, punchDirX);

  const showingBack = frontView > 0;

  if (showingBack) {
    drawArms(ctx, fighter, bodyX, shoulderY, sideView, frontView, bodyWidthMult, bob, punchDirX, punchDirY, toOppDist, critFlash, fatigueLag);
  }

  const hipBodyX = sx + depthShift;
  const isChargeFlashing = fighter.chargeFlashTimer > 0;

  // 3D torso: use a horizontal gradient to simulate cylindrical volume
  const torsoPath = () => {
    // Sides bow out at the lats and tuck back in above the hips instead of
    // running straight, so the trunk reads as muscled rather than boxy.
    const latT = 0.42;
    const latY = shoulderY + (hipY - shoulderY) * latT;
    const latMidX = bodyX + (hipBodyX - bodyX) * latT;
    const latHalf = shoulderW + (hipW - shoulderW) * latT + tW * 0.1;
    // Rounded shoulder corners: square ones made the trunk read as a slab.
    const capR = Math.min(shoulderW * 0.42, 3.2 * FIGHTER_SCALE);
    const capDrop = capR * 0.85;
    ctx.beginPath();
    ctx.moveTo(bodyX - shoulderW, shoulderY + capDrop);
    ctx.quadraticCurveTo(bodyX - shoulderW, shoulderY, bodyX - shoulderW + capR, shoulderY);
    ctx.lineTo(bodyX + shoulderW - capR, shoulderY);
    ctx.quadraticCurveTo(bodyX + shoulderW, shoulderY, bodyX + shoulderW, shoulderY + capDrop);
    ctx.quadraticCurveTo(latMidX + latHalf, latY, hipBodyX + hipW, hipY);
    ctx.lineTo(hipBodyX - hipW, hipY);
    ctx.quadraticCurveTo(latMidX - latHalf, latY, bodyX - shoulderW, shoulderY + capDrop);
    ctx.closePath();
  };

  if (isChargeFlashing) {
    ctx.fillStyle = "rgba(60,120,255,0.7)";
  } else if (critFlash) {
    ctx.fillStyle = "#ff2222";
  } else {
    // Lit from slight front-left; shadow on opposite side
    const litX = bodyX - shoulderW * 0.8;
    const shadX = bodyX + shoulderW * 0.8;
    const torsoGrad = ctx.createLinearGradient(litX, shoulderY, shadX, shoulderY);
    const skinBase = c.shirt ?? c.skin;
    const skinDark = shadeColor(skinBase, -35);
    const skinLight = shadeColor(skinBase, 25);
    // Light comes from the front-left
    const litFrac = Math.max(0, Math.min(1, 0.5 + sideView * 0.4));
    torsoGrad.addColorStop(0, litFrac > 0.5 ? skinLight : skinDark);
    torsoGrad.addColorStop(0.45, shadeColor(skinBase, 0));
    torsoGrad.addColorStop(1, litFrac > 0.5 ? skinDark : skinLight);
    ctx.fillStyle = torsoGrad;
  }
  torsoPath();
  ctx.fill();

  // Referee-style vertical stripes on shirted torsos
  if (c.shirt && !critFlash && !isChargeFlashing) {
    ctx.save();
    torsoPath();
    ctx.clip();
    ctx.strokeStyle = "rgba(20,20,20,0.85)";
    ctx.lineWidth = 2.2;
    for (let i = -2; i <= 2; i++) {
      const fx = i / 3;
      ctx.beginPath();
      ctx.moveTo(bodyX + shoulderW * fx, shoulderY - 2);
      ctx.lineTo(hipBodyX + hipW * fx, hipY + 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  // Chest and abdominal definition: enough to read as an athlete, not a
  // bodybuilder.  Skipped on shirted torsos (the referee) and on flashes.
  if (!c.shirt && !critFlash && !isChargeFlashing) {
    ctx.save();
    torsoPath();
    ctx.clip();
    const chestY = shoulderY + (hipY - shoulderY) * 0.3;
    const chestMidX = bodyX + (hipBodyX - bodyX) * 0.3;
    const chestHalf = shoulderW * 0.82;
    ctx.strokeStyle = shadeColor(c.skin, -55);
    ctx.globalAlpha = 0.22;
    ctx.lineWidth = 1.1;
    ctx.lineCap = "round";
    // Under-pec shadow
    ctx.beginPath();
    ctx.moveTo(chestMidX - chestHalf, chestY - 1.2 * FIGHTER_SCALE);
    ctx.quadraticCurveTo(chestMidX, chestY + 1.6 * FIGHTER_SCALE, chestMidX + chestHalf, chestY - 1.2 * FIGHTER_SCALE);
    ctx.stroke();
    // Sternum / linea alba down to the waistband
    ctx.globalAlpha = 0.16;
    ctx.lineWidth = 0.9;
    ctx.beginPath();
    ctx.moveTo(chestMidX, shoulderY + (hipY - shoulderY) * 0.18);
    ctx.lineTo(hipBodyX + (bodyX - hipBodyX) * 0.35, hipY - (hipY - shoulderY) * 0.32);
    ctx.stroke();
    // Two ab creases
    for (let i = 1; i <= 2; i++) {
      const t = 0.44 + i * 0.11;
      const ay = shoulderY + (hipY - shoulderY) * t;
      const ax = bodyX + (hipBodyX - bodyX) * t;
      const half = (shoulderW + (hipW - shoulderW) * t) * 0.45;
      ctx.beginPath();
      ctx.moveTo(ax - half, ay);
      ctx.quadraticCurveTo(ax, ay + 0.8 * FIGHTER_SCALE, ax + half, ay);
      ctx.stroke();
    }
    // Collarbone highlight
    ctx.strokeStyle = shadeColor(c.skin, 45);
    ctx.globalAlpha = 0.22;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(bodyX - shoulderW * 0.72, shoulderY + 1.6 * FIGHTER_SCALE);
    ctx.quadraticCurveTo(bodyX, shoulderY + 0.4 * FIGHTER_SCALE, bodyX + shoulderW * 0.72, shoulderY + 1.6 * FIGHTER_SCALE);
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  // Torso rim highlight for 3D edge
  if (!critFlash && !isChargeFlashing) {
    ctx.strokeStyle = shadeColor(c.shirt ?? c.skin, 40);
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.35;
    torsoPath();
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  const trunkTopFrac = 0.35;
  const trunkTopX = hipBodyX + (bodyX - hipBodyX) * (1 - trunkTopFrac);
  const trunkTop = hipY - bodyHeight * trunkTopFrac + Math.abs(leanOffsetY) * 0.3 * (1 - trunkTopFrac);

  // 3D trunks with gradient
  if (critFlash) {
    ctx.fillStyle = "#cc1111";
  } else {
    const trunkGrad = ctx.createLinearGradient(trunkTopX - trunkW, trunkTop, trunkTopX + trunkW, trunkTop);
    const trunkDark = shadeColor(c.trunks, -40);
    const trunkLight = shadeColor(c.trunks, 30);
    trunkGrad.addColorStop(0, trunkDark);
    trunkGrad.addColorStop(0.4, shadeColor(c.trunks, 0));
    trunkGrad.addColorStop(0.65, trunkLight);
    trunkGrad.addColorStop(1, trunkDark);
    ctx.fillStyle = isSpacial(c.trunks) ? spacialPaint(ctx) : trunkGrad;
  }
  ctx.beginPath();
  ctx.moveTo(trunkTopX - trunkW * 0.94, trunkTop);
  ctx.lineTo(trunkTopX + trunkW * 0.94, trunkTop);
  ctx.lineTo(hipBodyX + trunkW, hipY);
  ctx.lineTo(hipBodyX - trunkW, hipY);
  ctx.closePath();
  ctx.fill();

  // Waist stripe resting on top of the trunks. Its own colour when the fighter
  // has picked one, otherwise the lightened trunk shade it has always used.
  const stripeCol = critFlash ? "#cc1111" : (c.waistStripe || defaultWaistStripeColor(c.trunks));
  const stripeX = trunkTopX - trunkW * 0.94;
  const stripeW = trunkW * 1.88;
  const stripeH = 3.6 * FIGHTER_SCALE;
  ctx.fillStyle = stripeCol;
  ctx.fillRect(stripeX, trunkTop, stripeW, stripeH);
  ctx.fillStyle = shadeColor(stripeCol, -40);
  ctx.globalAlpha = 0.5;
  ctx.fillRect(stripeX, trunkTop + stripeH - 0.8 * FIGHTER_SCALE, stripeW, 0.8 * FIGHTER_SCALE);
  ctx.globalAlpha = 1;

  const chargeHeadFwd = fighter.chargeHeadOffset * bodyHeight;
  const forwardOff = punchDirX * 5 * FIGHTER_SCALE + punchDirX * chargeHeadFwd;
  const forwardOffY = punchDirY * 3 * FIGHTER_SCALE + punchDirY * chargeHeadFwd * 0.5;
  const headShift = frontView * 2 + forwardOff;

  const chargeFlash = fighter.chargeFlashTimer > 0;
  const headCX = bodyX + headShift + slipHeadOX;
  let headCY = headY + forwardOffY + slipHeadOY + resetHeadDuckOffset(fighter);

  // Still previews look at the fighter square-on, where the head's forward
  // offset lifts the skull clear of the shoulders and leaves a long neck.
  // Pull three quarters of that exposed neck back out for previews only.
  if (_stillPreview) {
    const neckGap = shoulderY - (headCY + HEAD_R);
    if (neckGap > 0) headCY += neckGap * 0.75;
  }

  // Neck: a properly sized head no longer spans the shoulders, so without one
  // the skull looks pinned straight onto the trapezius.
  {
    const neckCol = chargeFlash
      ? "rgba(60,120,255,0.9)"
      : critFlash ? "#ff2222" : shadeColor(c.skin, -12);
    const neckBaseX = bodyX + (headCX - bodyX) * 0.3;
    const neckBaseY = shoulderY + HEAD_R * 0.15;
    drawLimb(
      ctx, neckBaseX, neckBaseY, headCX, headCY + HEAD_R * 0.5,
      HEAD_R * 0.74, HEAD_R * 0.66, HEAD_R * 0.6,
      neckCol, chargeFlash || critFlash, 0.5,
    );
  }

  if (chargeFlash) {
    ctx.fillStyle = "rgba(60,120,255,0.9)";
  } else if (critFlash) {
    ctx.fillStyle = "#ff2222";
  } else {
    // 3D radial gradient for spherical head: lit from upper-front
    const litOX = -HEAD_R * 0.3 * (1 - Math.abs(frontView));
    const litOY = -HEAD_R * 0.35;
    const headGrad = ctx.createRadialGradient(
      headCX + litOX, headCY + litOY, HEAD_R * 0.05,
      headCX, headCY, HEAD_R * 1.05
    );
    headGrad.addColorStop(0, shadeColor(c.skin, 40));
    headGrad.addColorStop(0.5, shadeColor(c.skin, 0));
    headGrad.addColorStop(1, shadeColor(c.skin, -45));
    ctx.fillStyle = headGrad;
  }
  ctx.beginPath();
  ctx.arc(headCX, headCY, HEAD_R, 0, Math.PI * 2);
  ctx.fill();
  // Head rim for 3D edge definition
  if (!chargeFlash && !critFlash) {
    ctx.strokeStyle = shadeColor(c.skin, -60);
    ctx.lineWidth = 0.8;
    ctx.globalAlpha = 0.3;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  if (Math.abs(frontView) > 0.3) {
    ctx.fillStyle = "#1a1a1a";
    const eyeOff = frontView * HEAD_R * 0.3;
    const eyeSpread = HEAD_R * 0.36 * bodyWidthMult;
    const eyeX1 = headCX + eyeOff - eyeSpread;
    const eyeX2 = headCX + eyeOff + eyeSpread;
    const eyeY = headCY - HEAD_R * 0.15;
    const telegraphing = fighter.telegraphPhase !== "none";
    const telegraphBlinkChance = telegraphing
      ? levelScale(Math.max(1, fighter.level), 0.75, 0.50, "telegraphBlinkChance")
      : 0;
    // The post-Reset quiet holds the eyes open through the telegraph flicker
    // too — the engine already withholds every real blink for its length, and
    // leaving this one running would blink straight through it.
    const blinkQuiet = (fighter.blinkQuietTimer ?? 0) > 0;
    const showBlink = fighter.cleanHitEyeTimer > 0
      || fighter.isBlinking
      || (telegraphing && !blinkQuiet && (((fighter.level * 7 + Math.floor(fighter.telegraphTimer * 100)) % 100) / 100 < telegraphBlinkChance));
    if (showBlink) {
      const ew = HEAD_R * 0.13;
      ctx.strokeStyle = "#1a1a1a";
      ctx.lineWidth = Math.max(0.5, HEAD_R * 0.09);
      ctx.beginPath();
      ctx.moveTo(eyeX1 - ew, eyeY);
      ctx.lineTo(eyeX1 + ew, eyeY);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(eyeX2 - ew, eyeY);
      ctx.lineTo(eyeX2 + ew, eyeY);
      ctx.stroke();
    } else {
      const nonJabPunch = fighter.isPunching && fighter.currentPunch && fighter.currentPunch !== "jab";
      const eyeR = HEAD_R * 0.17;
      if (nonJabPunch) {
        const sx = eyeR * 1.3;
        const sy = eyeR * 0.55;
        ctx.beginPath();
        ctx.ellipse(eyeX1, eyeY, sx, sy, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.ellipse(eyeX2, eyeY, sx, sy, 0, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.beginPath();
        ctx.arc(eyeX1, eyeY, eyeR, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(eyeX2, eyeY, eyeR, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  // Sparring headgear — gym sessions only (this covers Nightmare and Doghouse,
  // which also run in sparringMode). The referee reuses drawFighter, so he is
  // excluded along with the silhouette pass.
  const wearsHeadgear = !_drawingReferee && !_silhouetteMode
    && (_previewHeadgear || state?.sparringMode === true);
  if (wearsHeadgear) {
    const headgearColor = fighter.isPlayer
      ? (c.headgear || DEFAULT_HEADGEAR_COLOR)
      : (SPARRING_HEADGEAR_BY_DIFFICULTY[state?.aiDifficulty ?? ""] || c.headgear || DEFAULT_HEADGEAR_COLOR);
    drawHeadgear(ctx, headCX, headCY, headgearColor, frontView, punchDirX);
  }

  if (!showingBack) {
    drawArms(ctx, fighter, bodyX, shoulderY, sideView, frontView, bodyWidthMult, bob, punchDirX, punchDirY, toOppDist, critFlash, fatigueLag);
  }


  if (!state?.menuBackground) {
    ctx.save();
    ctx.fillStyle = "#ffffff";
    ctx.font = "10px 'Oxanium', sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(fighter.name, sx, headY - HEAD_R - 6);
    ctx.restore();
  }

  if (state && !_silhouetteMode && !_drawingReferee) {
    const rBarW = 50;
    const rBarH = 6;
    const rBarX = sx - rBarW / 2;
    const rBarY = baseY + 10;

    if (fighter.isPlayer || !state.nightmareMode) {
      ctx.fillStyle = "rgba(255,255,255,0.1)";
      ctx.fillRect(rBarX, rBarY, rBarW, rBarH);

      {
        const flashTimer = fighter.rhythmHitFlashTimer;
        const flashing = flashTimer > 0.24 || (flashTimer > 0 && flashTimer <= 0.12);

        // The vulnerable window is split in half and hung off BOTH ends of the
        // arc rather than sitting in the middle, so the bar reads green on the
        // way in and green on the way out with the safe ground between them.
        // Widened by whatever this fighter's own fatigue has stacked on since
        // their last Reset, so the bar shows the window they are actually
        // fighting with rather than the base one.
        const _vulnHalf = Math.min(0.5, (fighter.isPlayer ? 0.1 : (0.05 + 0.15 * (state.player.focusT || 0))) + rhythmVulnStackWidth(fighter));
        if (!fighter.rhythmWalking) {
          // Stood still: the rhythm is switched off, so there is nothing to read.
          ctx.fillStyle = "rgba(150, 150, 150, 0.15)";
          ctx.fillRect(rBarX, rBarY, rBarW, rBarH);
        } else {
          const _green = flashing ? "rgba(255, 60, 60, 0.45)" : "rgba(100, 255, 100, 0.2)";
          const _blue = flashing ? "rgba(255, 60, 60, 0.45)" : "rgba(100, 180, 255, 0.2)";
          const _orange = flashing ? "rgba(255, 60, 60, 0.45)" : "rgba(255, 180, 100, 0.2)";
          ctx.fillStyle = _green;
          ctx.fillRect(rBarX, rBarY, rBarW * _vulnHalf, rBarH);
          ctx.fillStyle = _blue;
          ctx.fillRect(rBarX + rBarW * _vulnHalf, rBarY, rBarW * (0.5 - _vulnHalf), rBarH);
          ctx.fillStyle = _orange;
          ctx.fillRect(rBarX + rBarW * 0.5, rBarY, rBarW * (0.5 - _vulnHalf), rBarH);
          ctx.fillStyle = _green;
          ctx.fillRect(rBarX + rBarW * (1 - _vulnHalf), rBarY, rBarW * _vulnHalf, rBarH);
        }

        const markerX = rBarX + fighter.rhythmProgress * rBarW;
        ctx.fillStyle = flashing ? "#ff4040" : "#ffffff";
        ctx.fillRect(markerX - 1, rBarY - 1, 2, rBarH + 2);

      }

      if (fighter.isPlayer && fighter.punchPhase === "retraction" && fighter.retractionProgress >= 0.75) {
        ctx.fillStyle = "rgba(255, 220, 100, 0.7)";
        ctx.font = "bold 8px 'Oxanium', sans-serif";
        ctx.textAlign = "center";
        ctx.fillText("RE-PUNCH!", sx, rBarY + rBarH + 9);
      }
    }
  }

  if (!_silhouetteMode && !_drawingReferee && !fighter.isPlayer && state?.nightmareMode) {
    const barW = 34;
    const barH = 4;
    const barX = sx - barW / 2;
    const barY = baseY + 8;
    const sfrac = Math.max(0, Math.min(1, fighter.stamina / fighter.maxStamina));
    ctx.fillStyle = "rgba(80, 80, 80, 0.25)";
    ctx.fillRect(barX, barY, barW, barH);
    const sCol = sfrac > 0.5 ? "rgba(80, 210, 100, 0.45)" : sfrac > 0.2 ? "rgba(230, 200, 70, 0.45)" : "rgba(220, 70, 70, 0.5)";
    ctx.fillStyle = sCol;
    ctx.fillRect(barX, barY, barW * sfrac, barH);
    ctx.strokeStyle = "rgba(255,255,255,0.2)";
    ctx.lineWidth = 0.5;
    ctx.strokeRect(barX, barY, barW, barH);

    const chY = barY + barH + 2;
    const chH = 3;
    const empowered = fighter.chargeEmpoweredTimer > 0;
    const chMaxBars = 6;
    const chGap = 1;
    const chSegW = (barW - chGap * (chMaxBars - 1)) / chMaxBars;
    for (let ci = 0; ci < chMaxBars; ci++) {
      const chSegX = barX + ci * (chSegW + chGap);
      ctx.fillStyle = "rgba(40, 40, 60, 0.25)";
      ctx.fillRect(chSegX, chY, chSegW, chH);
      const chFilled = ci < fighter.chargeMeterBars;
      const chPartial = ci === fighter.chargeMeterBars ? fighter.chargeMeterCounters / 100 : 0;
      if (chFilled) {
        ctx.fillStyle = empowered ? "rgba(255, 180, 30, 0.55)" : "rgba(70, 140, 255, 0.5)";
        ctx.fillRect(chSegX, chY, chSegW, chH);
      } else if (chPartial > 0) {
        ctx.fillStyle = empowered ? "rgba(255, 180, 30, 0.35)" : "rgba(70, 140, 255, 0.3)";
        ctx.fillRect(chSegX, chY, chSegW * chPartial, chH);
      }
    }
  }

  ctx.restore();
}

function drawLegs(
  ctx: CanvasRenderingContext2D,
  fighter: FighterState,
  sx: number, baseY: number, hipY: number,
  sideView: number, frontView: number, bodyWidthMult: number,
  duckFactor: number, bob: number, critFlash: boolean, punchDirX: number
): void {
  const c = fighter.colors;
  const depthOff = frontView * 4;

  const dp = fighter.duckProgress;
  const bld = fighter.backLegDrive;
  const fld = fighter.frontLegDrive;
  const spreadAngleDeg = 30 + dp * 18;
  const spreadAngleRad = (spreadAngleDeg * Math.PI) / 180;
  const upperLegDx = Math.sin(spreadAngleRad) * UPPER_LEG_L * bodyWidthMult;
  const upperLegDy = Math.cos(spreadAngleRad) * UPPER_LEG_L * duckFactor;

  const rhythmBob = fighter.rhythmLevel > 0
    ? (fighter.swayOffset / 5) * 2.5 * FIGHTER_SCALE
    : Math.sin(fighter.bobPhase) * 2.5 * FIGHTER_SCALE;

  const fwdTiltFrac = 0.15;
  const duckKneeBend = dp * 8 * FIGHTER_SCALE;

  const dirBlend = Math.abs(sideView);
  const depthBlend = Math.abs(frontView);
  const quarterBlend = Math.min(dirBlend, depthBlend) * 2;

  for (let side = -1; side <= 1; side += 2) {
    const isFrontLeg = (punchDirX > 0 && side === 1) || (punchDirX <= 0 && side === -1);
    const isBackLeg = !isFrontLeg;
    const hipX = sx + side * upperLegDx * 0.5 + depthOff;

    const dirDepthOffset = side * frontView * 3 * FIGHTER_SCALE;
    const perspShift = isFrontLeg
      ? frontView * 2 * FIGHTER_SCALE
      : -frontView * 2 * FIGHTER_SCALE;

    const fwdShift = punchDirX * UPPER_LEG_L * fwdTiltFrac;

    let kneeX = hipX + side * upperLegDx * 0.5 + depthOff * 0.3 + fwdShift + side * duckKneeBend * 0.5 + dirDepthOffset + perspShift;
    let kneeY = hipY + upperLegDy;

    let kneeBendFwd = isFrontLeg
      ? punchDirX * 2 * FIGHTER_SCALE + rhythmBob * 0.2
      : -punchDirX * 6 * FIGHTER_SCALE + rhythmBob * 0.4;

    if (isBackLeg && bld > 0) {
      const driveForward = bld * 10 * FIGHTER_SCALE;
      kneeX += punchDirX * driveForward;
      kneeY += bld * 3 * FIGHTER_SCALE;
    }

    if (isFrontLeg && fld > 0) {
      const driveBackward = fld * 10 * FIGHTER_SCALE;
      kneeX -= punchDirX * driveBackward;
      kneeY += fld * 3 * FIGHTER_SCALE;
    }

    const quarterKneeShift = quarterBlend * side * 1.5 * FIGHTER_SCALE;
    kneeX += quarterKneeShift;

    let footX = kneeX + kneeBendFwd;
    let footY = baseY + bob + Math.abs(rhythmBob) * 0.3;

    if (isBackLeg && bld > 0) {
      footX += punchDirX * bld * 4 * FIGHTER_SCALE;
    }

    if (isFrontLeg && fld > 0) {
      footX -= punchDirX * fld * 4 * FIGHTER_SCALE;
    }

    const legScale = isFrontLeg
      ? 1.0 + depthBlend * 0.05
      : 1.0 - depthBlend * 0.05;
    const u = FIGHTER_SCALE * legScale;
    // Lean, tapered leg: quad sweep down to a narrow knee, calf high on the shin.
    const thighTopW = 4.5 * u;
    const thighMidW = 4.7 * u;
    const thighKneeW = 3.3 * u;
    const shinTopW = 3.2 * u;
    const calfW = 3.5 * u;
    const ankleW = 2.2 * u;
    const lineW = thighMidW;

    drawLimb(
      ctx, hipX, hipY, kneeX, kneeY,
      thighTopW, thighMidW, thighKneeW,
      critFlash ? "#ff2222" : c.skin, critFlash, 0.38,
    );

    const trunkLegT = 0.62;
    const trunkEndX = hipX + (kneeX - hipX) * trunkLegT;
    const trunkEndY = hipY + (kneeY - hipY) * trunkLegT;
    // The short hugs the thigh, flaring at the hip and cut off mid-thigh.
    const trunkHemW = thighMidW * 0.95 + 1.6 * u;
    drawLimb(
      ctx, hipX, hipY, trunkEndX, trunkEndY,
      thighTopW + 2.8 * u, thighMidW + 2.1 * u, trunkHemW,
      critFlash ? "#cc1111" : c.trunks, critFlash, 0.34,
    );

    const trunkBandW = 1.5 * FIGHTER_SCALE;
    const hemHalf = trunkHemW * 0.5;
    ctx.strokeStyle = critFlash ? "#aa0000" : shadeColor(c.trunks, 30);
    ctx.lineWidth = trunkBandW;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(trunkEndX - hemHalf, trunkEndY);
    ctx.lineTo(trunkEndX + hemHalf, trunkEndY);
    ctx.stroke();

    // The shin stops at the ankle, not the floor: a full-length round cap used
    // to bulge out below the sole once the flat foot became a shoe.
    const shoeUnit = FIGHTER_SCALE * legScale * 0.92;
    const legT = Math.max(0, 1 - (2.4 * shoeUnit) / Math.max(1, Math.hypot(footX - kneeX, footY - kneeY)));
    const ankleX = kneeX + (footX - kneeX) * legT;
    const ankleY = kneeY + (footY - kneeY) * legT;
    drawLimb(
      ctx, kneeX, kneeY, ankleX, ankleY,
      shinTopW, calfW, ankleW,
      critFlash ? "#ff2222" : c.skin, critFlash, 0.28,
    );

    // 3D knee joint sphere
    const kneeSize = 2.3 * FIGHTER_SCALE * legScale;
    if (critFlash) {
      ctx.fillStyle = "#aa0000";
    } else {
      const kneeGrad = ctx.createRadialGradient(
        kneeX - kneeSize * 0.25, kneeY - kneeSize * 0.25, kneeSize * 0.05,
        kneeX, kneeY, kneeSize
      );
      kneeGrad.addColorStop(0, shadeColor(c.skin, 25));
      kneeGrad.addColorStop(1, shadeColor(c.skin, -30));
      ctx.fillStyle = kneeGrad;
    }
    ctx.beginPath();
    ctx.arc(kneeX, kneeY, kneeSize, 0, Math.PI * 2);
    ctx.fill();

    // Sock first, then the shoe: the ankle collar overlaps the sock's hem.
    const footDir = (punchDirX >= 0 ? 1 : -1) * (_stillPreview ? -1 : 1);
    if (!_drawingReferee) {
      drawSock(
        ctx, footX, footY - 3.2 * shoeUnit, kneeX, kneeY,
        ankleW * 1.35,
        critFlash ? "#cc1111" : (c.socks || DEFAULT_SOCK_COLOR),
        critFlash,
      );
    }
    drawBoxingShoe(
      ctx, footX, footY, shoeUnit, footDir,
      critFlash ? "#cc1111" : c.shoes,
      critFlash, 0, _drawingReferee, c.laces, c.soles,
    );
  }

}

function drawArms(
  ctx: CanvasRenderingContext2D,
  fighter: FighterState,
  bodyX: number, shoulderY: number,
  sideView: number, frontView: number, bodyWidthMult: number,
  bob: number,
  punchDirX: number, punchDirY: number, punchDist: number,
  critFlash: boolean,
  fatigueLag?: { lead: number; rear: number; snapLeft: number; snapRight: number }
): void {
  const c = fighter.colors;
  const guardUp = fighter.defenseState === "fullGuard";
  const isDucking = fighter.defenseState === "duck";

  const shoulderSpread = 9.8 * FIGHTER_SCALE * bodyWidthMult;
  const depthOff = frontView * 4;
  const fullArmReach = (UPPER_ARM_L + FOREARM_L) * 2.0;
  const fwdOffX = punchDirX * 4 * FIGHTER_SCALE;
  const fwdOffY = punchDirY * 2 * FIGHTER_SCALE;

  for (let side = -1; side <= 1; side += 2) {
    const isLeft = side === -1;
    const shoulderX = bodyX + side * shoulderSpread * 0.5 + depthOff;
    const sY = shoulderY + 3 * FIGHTER_SCALE;

    let elbowX: number, elbowY: number;
    let gloveX: number, gloveY: number;

    const isPunchingSide = fighter.isPunching && fighter.currentPunch && (
      (isLeft && (fighter.currentPunch === "jab" || fighter.currentPunch === "leftHook" || fighter.currentPunch === "leftUppercut")) ||
      (!isLeft && (fighter.currentPunch === "cross" || fighter.currentPunch === "rightHook" || fighter.currentPunch === "rightUppercut"))
    );

    if (isPunchingSide && fighter.currentPunch) {
      const progress = fighter.punchProgress || 0;
      const isHook = fighter.currentPunch.includes("Hook");
      const isUppercut = fighter.currentPunch.includes("Uppercut");

      // Read visual params: preview override (editor live) → saved config → defaults
      let distanceMult = 1.0, arcAmplitude = 15;
      let ucDrop = 9, ucRise = 22, ucDipPeak = 0.32;
      if (_previewParams) {
        distanceMult  = _previewParams.distanceMult;
        arcAmplitude  = _previewParams.arcAmplitude;
        ucDrop        = _previewParams.dropDepth;
        ucRise        = _previewParams.riseHeight;
        ucDipPeak     = _previewParams.dropPhase;
      } else if (fighter.currentPunch) {
        const cfg = getActivePunchAnimConfig();
        const cp = cfg[fighter.currentPunch as keyof typeof cfg];
        if (cp) {
          distanceMult = cp.distanceMult ?? 1.0;
          arcAmplitude = cp.arcAmplitude;
          ucDrop       = cp.dropDepth;
          ucRise       = cp.riseHeight;
          ucDipPeak    = cp.dropPhase;
        }
      }

      const hookReachMult = 0.8;
      const uppercutReachMult = 0.6;
      const reachMult = isHook ? hookReachMult : isUppercut ? uppercutReachMult : 1.0;
      const targetReach = Math.min(fullArmReach * reachMult * distanceMult, punchDist * 0.95);
      const reachAtProgress = targetReach * progress;

      if (isHook) {
        // Inverted-U arc: fist sweeps upward at the peak of extension (flipped uppercut shape)
        const RISE = arcAmplitude * FIGHTER_SCALE;
        const arcT = Math.sin(progress * Math.PI);  // 0 → 1 → 0

        gloveX = shoulderX + punchDirX * reachAtProgress;
        gloveY = sY - RISE * arcT + bob;             // negative Y = upward on screen
        elbowX = shoulderX + (gloveX - shoulderX) * 0.45;
        elbowY = sY - RISE * arcT * 0.5 + 2 * FIGHTER_SCALE + bob;
      } else if (isUppercut) {
        // U-shaped path: fist dips (loads), then sweeps upward to strike.
        const DROP    = ucDrop    * FIGHTER_SCALE;
        const RISE    = ucRise    * FIGHTER_SCALE;
        const dipPeak = Math.max(0.01, Math.min(0.95, ucDipPeak));

        let yOffset: number;
        if (progress < dipPeak) {
          const t = progress / dipPeak;
          yOffset = DROP * Math.sin(t * Math.PI * 0.5);       // 0 → DROP
        } else {
          const t = (progress - dipPeak) / (1 - dipPeak);
          const smooth = t * t * (3 - 2 * t);                 // smoothstep
          yOffset = DROP - (DROP + RISE) * smooth;            // DROP → -RISE
        }

        gloveX = shoulderX + punchDirX * reachAtProgress * 0.5;
        gloveY = sY + yOffset + bob;
        elbowX = shoulderX + punchDirX * reachAtProgress * 0.35;
        elbowY = sY + yOffset * 0.35 + UPPER_ARM_L * 0.7 + bob;
      } else {
        gloveX = shoulderX + punchDirX * reachAtProgress;
        gloveY = sY + punchDirY * reachAtProgress * 0.4 - 5 * FIGHTER_SCALE + bob;
        elbowX = shoulderX + punchDirX * reachAtProgress * 0.5;
        elbowY = sY + punchDirY * reachAtProgress * 0.3 + 4 * FIGHTER_SCALE + bob;
      }
    } else {
      const downElbowX = shoulderX + side * 5 * FIGHTER_SCALE * bodyWidthMult + fwdOffX * 0.4;
      const downElbowY = sY + UPPER_ARM_L * 0.7 + bob + fwdOffY * 0.3;
      const downGloveX = shoulderX + side * 2 * bodyWidthMult + fwdOffX;
      const downGloveY = sY + UPPER_ARM_L * 0.3 + bob + fwdOffY;

      const upElbowX = shoulderX + side * 4 * FIGHTER_SCALE * bodyWidthMult + fwdOffX * 0.7;
      const upElbowY = sY + 6 * FIGHTER_SCALE + bob + fwdOffY * 0.5;
      const upGloveX = shoulderX + fwdOffX * 1.8 + side * 2 * FIGHTER_SCALE * bodyWidthMult;
      const guardLift = 2 * FIGHTER_SCALE * 1.05 + 15;
      let upGloveY = sY - guardLift + bob + fwdOffY;
      // Perfect block glove seek: slide gloves toward attacker's punch height
      const pbState = fighter.perfectBlockState ?? "idle";
      const pbGloveOY = fighter.perfectBlockGloveYOffset ?? 0;
      if (pbState !== "idle") {
        upGloveY += pbGloveOY;
      }
      let upElbowYFinal = upElbowY + (pbState !== "idle" ? pbGloveOY * 0.5 : 0);

      const duckHasGuard = isDucking && fighter.preDuckBlockState !== null;
      const gb = duckHasGuard ? fighter.guardBlend : (isDucking ? 1.0 : fighter.guardBlend);
      elbowX = downElbowX + (upElbowX - downElbowX) * gb;
      elbowY = downElbowY + (upElbowYFinal - downElbowY) * gb;
      gloveX = downGloveX + (upGloveX - downGloveX) * gb;
      gloveY = downGloveY + (upGloveY - downGloveY) * gb;

      // The entire telegraph animation, replacing the guard slide and the glove
      // buzz that used to live here: over the tail of the windup the punching
      // hand draws TELEGRAPH_PULLBACK_PX back down its own punch line, then goes
      // from there. Smoothstepped, so it eases off the guard and into the launch
      // rather than stepping at either end.
      if (fighter.telegraphPhase !== "none" && fighter.telegraphPunchType) {
        const tPunch = fighter.telegraphPunchType;
        const isTelegraphLeft = tPunch === "jab" || tPunch === "leftHook" || tPunch === "leftUppercut";
        const isTelegraphRight = tPunch === "cross" || tPunch === "rightHook" || tPunch === "rightUppercut";
        if ((isLeft && isTelegraphLeft) || (!isLeft && isTelegraphRight)) {
          const tDur = fighter.telegraphDuration;
          const tProg = tDur > 0 ? Math.min(1, fighter.telegraphTimer / tDur) : 1;
          if (tProg >= TELEGRAPH_PULLBACK_START) {
            const span = 1 - TELEGRAPH_PULLBACK_START;
            const p = span > 0 ? Math.min(1, (tProg - TELEGRAPH_PULLBACK_START) / span) : 1;
            const ease = p * p * (3 - 2 * p);
            const back = -ease * TELEGRAPH_PULLBACK_PX;
            gloveX += punchDirX * back;
            gloveY += punchDirY * back;
            elbowX += punchDirX * back * 0.5;
            elbowY += punchDirY * back * 0.5;
          }
        }
      }
    }

    // Lean arm: deltoid cap, bicep belly, forearm tapering into the wrist.
    const au = FIGHTER_SCALE;
    const skinCol = critFlash ? "#ff2222" : c.skin;
    // Shoulder stops the arm short of the wrist so the glove cuff sits on skin.
    // Energy fatigue: the forearm trails the chest it hangs off. The shoulder
    // stays welded to the torso, so only the far end of the arm lags — and the
    // wrist is derived below, so it follows the glove for free. A Reset snap
    // adds this arm's frozen pose on top until the stagger releases it.
    // Reaction flinch: both hands slide forward and either down or high, out
    // and back, on the same limb delay as the sway. Applied to the resting
    // guard before that lag so the two stack rather than fight.
    {
      const fl = flinchArmOffsets(fighter, isLeft);
      if (fl.forward !== 0 || fl.vertical !== 0) {
        gloveX += punchDirX * fl.forward;
        gloveY += punchDirY * fl.forward + fl.vertical;
        elbowX += punchDirX * fl.forward * 0.45;
        elbowY += (punchDirY * fl.forward + fl.vertical) * 0.45;
      }
    }

    if (fatigueLag) {
      const isLead = isLeft === (fighter.boxingStance !== "southpaw");
      const mag = (isLead ? fatigueLag.lead : fatigueLag.rear)
        + (isLeft ? fatigueLag.snapLeft : fatigueLag.snapRight);
      if (mag !== 0) {
        elbowX += punchDirX * mag * 0.45;
        elbowY += punchDirY * mag * 0.45;
        gloveX += punchDirX * mag;
        gloveY += punchDirY * mag;
      }
    }

    const wristT = Math.max(0, 1 - (GLOVE_R * 0.55) / Math.max(1, Math.hypot(gloveX - elbowX, gloveY - elbowY)));
    const wristX = elbowX + (gloveX - elbowX) * wristT;
    const wristY = elbowY + (gloveY - elbowY) * wristT;

    drawLimb(ctx, shoulderX, sY, elbowX, elbowY, 3.6 * au, 3.9 * au, 2.7 * au, skinCol, critFlash, 0.36);
    drawLimb(ctx, elbowX, elbowY, wristX, wristY, 2.9 * au, 3.1 * au, 2.2 * au, skinCol, critFlash, 0.3);

    // Deltoid cap
    if (critFlash) {
      ctx.fillStyle = "#ff2222";
    } else {
      const delt = ctx.createRadialGradient(
        shoulderX - 1.0 * au, sY - 1.0 * au, 0.3 * au,
        shoulderX, sY, 2.6 * au,
      );
      delt.addColorStop(0, shadeColor(c.skin, 30));
      delt.addColorStop(1, shadeColor(c.skin, -28));
      ctx.fillStyle = delt;
    }
    ctx.beginPath();
    ctx.arc(shoulderX, sY, 2.5 * au, 0, Math.PI * 2);
    ctx.fill();

    // Elbow joint
    ctx.fillStyle = critFlash ? "#aa0000" : shadeColor(c.skin, -20);
    ctx.beginPath();
    ctx.arc(elbowX, elbowY, 1.9 * FIGHTER_SCALE, 0, Math.PI * 2);
    ctx.fill();

    // 3D glove with radial gradient
    const blockFlash = fighter.blockFlashTimer > 0;
    const rawGloveColor = critFlash ? "#ff3333" : blockFlash ? "#ffffff" : fighter.colors.gloves;

    // The glove and its cuff always point straight down the forearm — no
    // extra tilt blended in, so the hand never rotates away from the arm.
    let aimX = gloveX - elbowX;
    let aimY = gloveY - elbowY;
    const aimLen = Math.hypot(aimX, aimY);
    if (aimLen > 0.001) {
      aimX /= aimLen;
      aimY /= aimLen;
    } else {
      // Degenerate forearm (glove sitting on the elbow): fall back to facing.
      aimX = punchDirX;
      aimY = punchDirY;
    }

    drawBoxingGlove(
      ctx, gloveX, gloveY, GLOVE_R,
      aimX, aimY,
      rawGloveColor,
      c.gloveTape || "#eeeeee",
      Math.abs(sideView),
      critFlash || blockFlash,
      _drawingReferee,
      // Still canvases only: the right-hand glove's thumb is mirrored so the
      // pair reads as a matched set head-on. The live fight is untouched.
      _stillPreview && !isLeft,
    );

    // Telegraph warning glow: skipped during silhouette pass so the ring itself
    // never gains a black outline.
    if (!_silhouetteMode && fighter.telegraphPhase !== "none" && fighter.telegraphPunchType) {
      const tPunch = fighter.telegraphPunchType;
      const isTelegraphLeft = tPunch === "jab" || tPunch === "leftHook" || tPunch === "leftUppercut";
      const isTelegraphRight = tPunch === "cross" || tPunch === "rightHook" || tPunch === "rightUppercut";
      if ((isLeft && isTelegraphLeft) || (!isLeft && isTelegraphRight)) {
        const tDur = fighter.telegraphDuration;
        const tT = fighter.telegraphTimer;
        const tProg = tDur > 0 ? Math.min(1, tT / tDur) : 1;
        // Pulse faster as the punch is about to land
        const pulseFreq = 4 + tProg * 8;
        const pulse = 0.5 + 0.5 * Math.sin(tT * pulseFreq * Math.PI * 2);
        const ringAlpha = 0.7 + pulse * 0.3;
        const [gR, gG, gB] = parseHex(fighter.colors.gloves);
        const gloveLum = 0.299 * gR + 0.587 * gG + 0.114 * gB;
        const ringColor = gloveLum > 200 ? `rgba(100,180,255,${ringAlpha})` : `rgba(255,255,255,${ringAlpha})`;
        ctx.strokeStyle = ringColor;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(gloveX, gloveY, GLOVE_R + 1, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    // Perfect block glow: also excluded from silhouette pass (uses 'lighter' blend).
    // The player's window is owned by the V-key state machine, the AI's by its held
    // perfectBlockTimer — both light the gloves up the same way.
    const pbGlowActive = fighter.perfectBlockState === "active" ||
      (fighter.perfectBlockActive && (fighter.perfectBlockTimer ?? 0) > 0);
    if (!_silhouetteMode && pbGlowActive) {
      const [pbR, pbG, pbB] = parseHex(c.gloves);
      const gloveLuminance = (0.299 * pbR + 0.587 * pbG + 0.114 * pbB) / 255;
      const glowRgb = gloveLuminance > 0.65 ? "150, 210, 255" : "255, 255, 255";
      const glowOuter = GLOVE_R + 2;
      // The AI's held block glows at 25% of the player's opacity — a visible tell, not a beacon.
      const pbGlowAlpha = fighter.perfectBlockState === "active" ? 1 : 0.25;
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      const pbGlowGrad = ctx.createRadialGradient(gloveX, gloveY, GLOVE_R * 0.8, gloveX, gloveY, glowOuter);
      pbGlowGrad.addColorStop(0, `rgba(${glowRgb}, ${0.9 * pbGlowAlpha})`);
      pbGlowGrad.addColorStop(0.6, `rgba(${glowRgb}, ${0.5 * pbGlowAlpha})`);
      pbGlowGrad.addColorStop(1, `rgba(${glowRgb}, 0)`);
      ctx.fillStyle = pbGlowGrad;
      ctx.beginPath();
      ctx.arc(gloveX, gloveY, glowOuter, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }
}

function drawKnockedDownFighter(ctx: CanvasRenderingContext2D, fighter: FighterState, screenPt: ScreenPt, state: GameState): void {
  const c = fighter.colors;
  const sx = screenPt.sx;
  const baseY = screenPt.sy;

  // Depth-based scale for knocked down fighter
  const depthNorm = Math.max(-1.2, Math.min(1.2, screenPt.depth / RING_HALF_H));
  const depthScale = 1.0 - depthNorm * 0.22;

  ctx.save();
  ctx.translate(sx, baseY);
  ctx.scale(depthScale, depthScale);
  ctx.translate(-sx, -baseY);
  ctx.globalAlpha = 0.85;

  const angle = fighter.facingAngle - currentCameraYaw;
  const lyingDir = Math.sin(angle);

  // A downed sparring partner keeps the kit he was wearing on his feet: the
  // same headgear rule as the standing pose (gloves with tape, socks and shoes
  // are drawn from the same colours further down).
  const kdWearsHeadgear = !_drawingReferee && !_silhouetteMode
    && (_previewHeadgear || state?.sparringMode === true);
  const kdHeadgearColor = fighter.isPlayer
    ? (c.headgear || DEFAULT_HEADGEAR_COLOR)
    : (SPARRING_HEADGEAR_BY_DIFFICULTY[state?.aiDifficulty ?? ""] || c.headgear || DEFAULT_HEADGEAR_COLOR);

  if (state.kdTakeKnee && state.kdIsBodyShot) {
    ctx.fillStyle = "rgba(0,0,0,0.2)";
    ctx.beginPath();
    ctx.ellipse(sx, baseY + 2, 18 * FIGHTER_SCALE * 0.6, 8 * FIGHTER_SCALE * 0.4, 0, 0, Math.PI * 2);
    ctx.fill();

    const kneeDropY = BODY_H * 0.45;
    const torsoTopY = baseY - BODY_H + kneeDropY;
    const headY = torsoTopY - HEAD_R * 0.7;

    const kneeSpread = 10 * FIGHTER_SCALE;
    ctx.strokeStyle = c.trunks;
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(sx - kneeSpread * 0.5, baseY - kneeDropY * 0.5);
    ctx.lineTo(sx - kneeSpread, baseY);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(sx + kneeSpread * 0.5, baseY - kneeDropY * 0.5);
    ctx.lineTo(sx + kneeSpread * 0.3, baseY + 2);
    ctx.stroke();

    const kdSockCol = c.socks || DEFAULT_SOCK_COLOR;
    drawSock(ctx, sx - kneeSpread, baseY - 1, sx - kneeSpread * 0.5, baseY - kneeDropY * 0.5, 4, kdSockCol, false);
    drawSock(ctx, sx + kneeSpread * 0.3, baseY + 1, sx + kneeSpread * 0.5, baseY - kneeDropY * 0.5, 4, kdSockCol, false);
    drawBoxingShoe(ctx, sx - kneeSpread, baseY + 1, FIGHTER_SCALE * 0.8, -1, c.shoes, false, 0, false, c.laces, c.soles);
    drawBoxingShoe(ctx, sx + kneeSpread * 0.3, baseY + 3, FIGHTER_SCALE * 0.8, 1, c.shoes, false, 0, false, c.laces, c.soles);

    ctx.fillStyle = c.trunks;
    ctx.beginPath();
    ctx.ellipse(sx, (torsoTopY + baseY - kneeDropY * 0.5) / 2, 9 * FIGHTER_SCALE, BODY_H * 0.35, 0, 0, Math.PI * 2);
    ctx.fill();

    const armDangle = 6;
    const kdTape = c.gloveTape || "#eeeeee";
    drawBoxingGlove(ctx, sx - 10, torsoTopY + BODY_H * 0.5 + armDangle, GLOVE_R, -0.35, 1, c.gloves, kdTape, 0.5, false);
    drawBoxingGlove(ctx, sx + 10, torsoTopY + BODY_H * 0.5 + armDangle, GLOVE_R, 0.35, 1, c.gloves, kdTape, 0.5, false);

    ctx.fillStyle = c.skin;
    ctx.beginPath();
    ctx.arc(sx, headY, HEAD_R, 0, Math.PI * 2);
    ctx.fill();
    if (kdWearsHeadgear) {
      drawHeadgear(ctx, sx, headY, kdHeadgearColor, -1, 1);
    }
  } else {
    // Sprawled flat on the canvas: full body laid out along the lying axis
    // (head one way, feet the other), limbs visible instead of a blob.
    const dRaw = lyingDir;
    const d = dRaw >= 0 ? Math.max(0.6, dRaw) : Math.min(-0.6, dRaw);
    const dir = d > 0 ? 1 : -1;
    const tilt = dRaw * 0.18;

    const skinDark = shadeColor(c.skin, -30);
    const skinLight = shadeColor(c.skin, 20);

    const headDist = 24 * FIGHTER_SCALE;
    const hipDist = 8 * FIGHTER_SCALE;
    const kneeDist = 18 * FIGHTER_SCALE;
    const footDist = 28 * FIGHTER_SCALE;

    // Fall animation: the body starts upright (feet planted) and tips over
    // with gravity easing until it lies flat, then the ref count begins.
    const fallP = Math.min(1, (state.kdFallTimer ?? KD_FALL_DURATION) / KD_FALL_DURATION);
    const g = fallP * fallP; // ease-in (accelerating fall)

    ctx.translate(sx, baseY - 4);

    // Ground shadow (unrotated) grows as the body comes down
    ctx.fillStyle = `rgba(0,0,0,${0.10 + 0.12 * g})`;
    ctx.beginPath();
    ctx.ellipse(0, 4, (headDist + footDist) * 0.55 * (0.35 + 0.65 * g), 7 * FIGHTER_SCALE * 0.5, 0, 0, Math.PI * 2);
    ctx.fill();

    // Lift the hips while upright so the feet stay on the floor, then rotate
    // the whole body from vertical down to the lying tilt.
    ctx.translate(0, -(1 - g) * footDist * 0.9);
    ctx.rotate(g * tilt + (1 - g) * (-dir * Math.PI / 2));

    // Legs: one straight, one bent at the knee
    const legW = 3.6 * FIGHTER_SCALE;
    ctx.lineCap = "round";
    // Straight far leg
    ctx.strokeStyle = skinDark;
    ctx.lineWidth = legW;
    ctx.beginPath();
    ctx.moveTo(-dir * hipDist, -2);
    ctx.lineTo(-dir * footDist, -4);
    ctx.stroke();
    // Bent near leg: thigh up, shin back down
    ctx.strokeStyle = c.skin;
    ctx.beginPath();
    ctx.moveTo(-dir * hipDist, 0);
    ctx.lineTo(-dir * kneeDist, -7 * FIGHTER_SCALE);
    ctx.lineTo(-dir * (footDist - 4 * FIGHTER_SCALE), 1);
    ctx.stroke();
    // Trunks over the upper thighs
    ctx.strokeStyle = c.trunks;
    ctx.lineWidth = legW + 1.5;
    ctx.beginPath();
    ctx.moveTo(-dir * hipDist, -1);
    ctx.lineTo(-dir * (hipDist + 5 * FIGHTER_SCALE), -3.5 * FIGHTER_SCALE);
    ctx.stroke();
    // Socks and shoes — the feet point away from the body along the lying axis
    const sprawlSock = c.socks || DEFAULT_SOCK_COLOR;
    drawSock(ctx, -dir * (footDist - 2 * FIGHTER_SCALE), -4, -dir * kneeDist, -6 * FIGHTER_SCALE, legW, sprawlSock, false);
    drawSock(ctx, -dir * (footDist - 6 * FIGHTER_SCALE), 1, -dir * kneeDist, -6 * FIGHTER_SCALE, legW, sprawlSock, false);
    drawBoxingShoe(ctx, -dir * footDist, -4, FIGHTER_SCALE * 0.75, -dir, c.shoes, false, 0.3, false, c.laces, c.soles);
    drawBoxingShoe(ctx, -dir * (footDist - 4 * FIGHTER_SCALE), 1, FIGHTER_SCALE * 0.75, -dir, c.shoes, false, -0.25, false, c.laces, c.soles);

    // Torso lying flat: elongated along the axis with shading
    const torsoGrad = ctx.createLinearGradient(0, -8 * FIGHTER_SCALE, 0, 4);
    torsoGrad.addColorStop(0, skinLight);
    torsoGrad.addColorStop(0.55, shadeColor(c.skin, 0));
    torsoGrad.addColorStop(1, skinDark);
    ctx.fillStyle = torsoGrad;
    ctx.beginPath();
    ctx.ellipse(dir * 4 * FIGHTER_SCALE, -3.5 * FIGHTER_SCALE, 12 * FIGHTER_SCALE, 5.5 * FIGHTER_SCALE, 0, 0, Math.PI * 2);
    ctx.fill();

    // Trunks at the waist
    ctx.fillStyle = c.trunks;
    ctx.beginPath();
    ctx.ellipse(-dir * hipDist * 0.7, -3 * FIGHTER_SCALE, 6 * FIGHTER_SCALE, 5 * FIGHTER_SCALE, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = shadeColor(c.trunks, -35);
    ctx.beginPath();
    ctx.ellipse(-dir * hipDist * 0.7, -3 * FIGHTER_SCALE, 6 * FIGHTER_SCALE, 5 * FIGHTER_SCALE, 0, Math.PI * 0.15, Math.PI * 0.85);
    ctx.fill();

    // Far arm flung out above the head
    ctx.strokeStyle = skinDark;
    ctx.lineWidth = 3.6 * FIGHTER_SCALE;
    ctx.beginPath();
    ctx.moveTo(dir * 10 * FIGHTER_SCALE, -5 * FIGHTER_SCALE);
    ctx.lineTo(dir * (headDist + 8 * FIGHTER_SCALE), -6 * FIGHTER_SCALE);
    ctx.stroke();
    drawBoxingGlove(
      ctx, dir * (headDist + 8 * FIGHTER_SCALE), -6 * FIGHTER_SCALE, GLOVE_R * 0.95,
      dir, -0.15, shadeColor(c.gloves, -25), shadeColor(c.gloveTape || "#eeeeee", -25), 1, false,
    );

    // Near arm draped across the body
    ctx.strokeStyle = c.skin;
    ctx.lineWidth = 3.0 * FIGHTER_SCALE;
    ctx.beginPath();
    ctx.moveTo(dir * 9 * FIGHTER_SCALE, -4 * FIGHTER_SCALE);
    ctx.lineTo(dir * 3 * FIGHTER_SCALE, 2);
    ctx.stroke();
    drawBoxingGlove(
      ctx, dir * 3 * FIGHTER_SCALE, 2, GLOVE_R,
      -dir, 0.35, c.gloves, c.gloveTape || "#eeeeee", 1, false,
    );

    // Head tipped back, face up
    ctx.fillStyle = c.skin;
    ctx.beginPath();
    ctx.arc(dir * headDist, -4 * FIGHTER_SCALE, HEAD_R, 0, Math.PI * 2);
    ctx.fill();
    // Shaded underside of the head
    ctx.fillStyle = skinDark;
    ctx.beginPath();
    ctx.arc(dir * headDist, -4 * FIGHTER_SCALE, HEAD_R, Math.PI * 0.1, Math.PI * 0.9);
    ctx.fill();
    if (kdWearsHeadgear) {
      drawHeadgear(ctx, dir * headDist, -4 * FIGHTER_SCALE, kdHeadgearColor, -1, dir);
    }
    // Closed eyes (two small dashes), drawn last so they still read through
    // the headgear opening
    ctx.strokeStyle = "rgba(20,10,5,0.7)";
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(dir * headDist - HEAD_R * 0.42, -4 * FIGHTER_SCALE - HEAD_R * 0.36);
    ctx.lineTo(dir * headDist - HEAD_R * 0.14, -4 * FIGHTER_SCALE - HEAD_R * 0.36);
    ctx.moveTo(dir * headDist + HEAD_R * 0.14, -4 * FIGHTER_SCALE - HEAD_R * 0.36);
    ctx.lineTo(dir * headDist + HEAD_R * 0.42, -4 * FIGHTER_SCALE - HEAD_R * 0.36);
    ctx.stroke();
  }

  ctx.restore();
}

function drawStanceIndicator(ctx: CanvasRenderingContext2D, x: number, y: number, stance: string): void {
  if (stance === "neutral") return;
  ctx.save();
  ctx.font = "9px 'Oxanium', sans-serif";
  ctx.textAlign = "center";
  ctx.fillStyle = stance === "frontFoot" ? "rgba(255, 150, 50, 0.7)" : "rgba(100, 200, 255, 0.7)";
  ctx.fillText(stance === "frontFoot" ? "FRONT" : "BACK", x, y);
  ctx.restore();
}

function drawTowelAnimation(ctx: CanvasRenderingContext2D, state: GameState): void {
  const progress = 1 - (state.towelTimer / 1.0);
  const startX = CANVAS_W - 30;
  const startY = 100;
  const endX = CANVAS_W / 2;
  const endY = CANVAS_H / 2 - 40;

  const x = startX + (endX - startX) * progress;
  const arcHeight = -120 * Math.sin(progress * Math.PI);
  const y = startY + (endY - startY) * progress + arcHeight;
  const rotation = progress * Math.PI * 2;
  const size = 14 + progress * 6;

  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rotation);

  ctx.fillStyle = "#ffffff";
  ctx.shadowColor = "rgba(0,0,0,0.3)";
  ctx.shadowBlur = 4;
  ctx.beginPath();
  ctx.moveTo(-size, -size * 0.6);
  ctx.lineTo(size, -size * 0.4);
  ctx.lineTo(size * 0.8, size * 0.6);
  ctx.lineTo(-size * 0.7, size * 0.5);
  ctx.closePath();
  ctx.fill();

  ctx.strokeStyle = "#dddddd";
  ctx.lineWidth = 0.5;
  ctx.stroke();

  ctx.restore();
}

function drawStoppageOverlay(ctx: CanvasRenderingContext2D, state: GameState): void {
  ctx.save();

  ctx.fillStyle = "rgba(0,0,0,0.3)";
  ctx.fillRect(0, CANVAS_H / 2 - 40, CANVAS_W, 80);

  ctx.fillStyle = "#ff3333";
  ctx.font = "bold 32px 'Oxanium', sans-serif";
  ctx.textAlign = "center";

  const label = state.refStoppageType === "towel" ? "TOWEL STOPPAGE" : "REFEREE STOPPAGE";
  ctx.fillText(label, CANVAS_W / 2, CANVAS_H / 2 + 5);

  ctx.fillStyle = "rgba(255,255,255,0.7)";
  ctx.font = "14px 'Oxanium', sans-serif";
  ctx.fillText("THE FIGHT HAS BEEN STOPPED", CANVAS_W / 2, CANVAS_H / 2 + 28);

  ctx.restore();
}

function drawHitEffects(ctx: CanvasRenderingContext2D, effects: HitEffect[]): void {
  effects.forEach(e => {
    const rise = (0.6 - e.timer) * 30;
    const pt = projectToScreen(e.x, e.y);
    drawHitEffectText(ctx, e, pt.sx, pt.sy - rise - 30);
  });
}

/** Hit effects over the 3D view: anchored at head height through its camera. */
function drawHitEffectsProjected(ctx: CanvasRenderingContext2D, effects: HitEffect[], project: WorldProjector): void {
  for (const e of effects) {
    const pt = project(e.x, e.y, 90);
    if (!pt) continue;
    const rise = (0.6 - e.timer) * 30;
    drawHitEffectText(ctx, e, pt.sx, pt.sy - rise);
  }
}

function drawHitEffectText(ctx: CanvasRenderingContext2D, e: HitEffect, x: number, y: number): void {
  {
    const alpha = Math.min(1, e.timer * 2);
    ctx.save();
    ctx.globalAlpha = alpha;

    if (e.type === "perfectBlock") {
      ctx.fillStyle = "#eab308";
      ctx.font = "bold 16px 'Oxanium', sans-serif";
    } else if (e.type === "crit") {
      ctx.fillStyle = e.attackerColor ?? "#ff4444";
      ctx.font = "bold 20px 'Oxanium', sans-serif";
    } else if (e.type === "block") {
      ctx.fillStyle = e.attackerColor ?? "#6688ff";
      ctx.font = "bold 15px 'Oxanium', sans-serif";
    } else if (e.type === "feint") {
      ctx.fillStyle = e.attackerColor ?? "#aaaaff";
      ctx.font = "italic 14px 'Oxanium', sans-serif";
    } else {
      ctx.fillStyle = e.attackerColor ?? "#ffcc44";
      ctx.font = "bold 16px 'Oxanium', sans-serif";
    }

    ctx.textAlign = "center";
    ctx.fillText(e.text, x, y);
    ctx.restore();
  }
}

// The referee reuses the fighter model, dressed in ref clothes: striped white
// shirt, black slacks, black shoes, and bare (skin-colored) hands.
const REF_COLORS: FighterColors = {
  gloves: "#d4a574",
  gloveTape: "#c49468",
  trunks: "#16161a",
  shoes: "#101012",
  skin: "#d4a574",
  shirt: "#f2f2ee",
};
let _refFighterState: FighterState | null = null;
// While true, drawFighter suppresses combat UI (rhythm/charge/mini bars) —
// the referee reuses the fighter model but must not show fight UI.
let _drawingReferee = false;

function drawReferee(ctx: CanvasRenderingContext2D, state: GameState): void {
  const refPt = projectToScreen(state.refX, state.refZ);
  const knockedFighter = state.player.isKnockedDown ? state.player : state.enemy;
  const knockedPt = projectToScreen(knockedFighter.x, knockedFighter.z);

  if (!_refFighterState) {
    _refFighterState = createPreviewFighterState(REF_COLORS, Math.random() * Math.PI * 2);
    _refFighterState.name = "";
  }
  const ref = _refFighterState;
  ref.x = state.refX;
  ref.z = state.refZ;
  ref.facingAngle = Math.atan2(knockedFighter.z - state.refZ, knockedFighter.x - state.refX);
  ref.bobPhase = (Date.now() / 1000 * ref.bobSpeed) % (Math.PI * 2);
  // Waving off the fight: raise the guard fully so the arms read as crossed high
  ref.defenseState = state.refStoppageActive ? "fullGuard" : "none";
  ref.guardBlend = state.refStoppageActive ? 1 : 0;
  ref.handsDown = !state.refStoppageActive;

  _drawingReferee = true;
  try {
    drawFighter(ctx, ref, knockedFighter, state, refPt, knockedPt);
  } finally {
    _drawingReferee = false;
  }
}

function getBlockLabel(fighter: FighterState): { label: string; color: string } {
  if (fighter.defenseState === "fullGuard") return { label: "FULL GUARD", color: "rgba(100, 200, 255, 0.8)" };
  if (fighter.defenseState === "duck") return { label: "DUCKING", color: "rgba(200, 180, 255, 0.8)" };
  return { label: "OPEN", color: "rgba(255, 255, 255, 0.35)" };
}

function drawExpBarOverlay(ctx: CanvasRenderingContext2D, state: GameState): void {
  const level = state.playerLevel;
  const xp = state.playerCurrentXp ?? 0;
  const needed = xpToNextLevel(level);
  const fillPct = needed > 0 ? Math.min(1, xp / needed) : 1;

  const ow = 164, oh = 37;
  const ox = 0, oy = 0;
  const barX = ox + 6, barW2 = ow - 12, barH2 = 5;
  const barY = oy + oh - 14;

  ctx.save();
  // Pinned to the top middle at 80% size: the top corners belong to the
  // active-item rows, which used to sit on top of this panel.
  const XP_SCALE = 0.8;
  ctx.translate((CANVAS_W - ow * XP_SCALE) / 2, 6);
  ctx.scale(XP_SCALE, XP_SCALE);
  ctx.globalAlpha = 0.92;
  ctx.fillStyle = "#1a1a1a";
  ctx.beginPath();
  ctx.roundRect(ox, oy, ow, oh, 5);
  ctx.fill();
  ctx.globalAlpha = 1;

  ctx.font = "bold 10px 'Oxanium', sans-serif";
  ctx.textAlign = "left";
  ctx.fillStyle = "#ffffff";
  ctx.fillText(`LV ${level}`, ox + 6, oy + 14);

  const xpStr = `${Math.ceil(xp).toLocaleString()} / ${needed.toLocaleString()} XP`;
  ctx.font = "8px 'Oxanium', sans-serif";
  ctx.textAlign = "right";
  ctx.fillStyle = "rgba(255,255,255,0.55)";
  ctx.fillText(xpStr, ox + ow - 6, oy + 14);

  ctx.fillStyle = "#262626";
  ctx.beginPath();
  ctx.roundRect(barX, barY, barW2, barH2, 2);
  ctx.fill();

  if (fillPct > 0) {
    ctx.fillStyle = "#4d9432";
    ctx.beginPath();
    ctx.roundRect(barX, barY, Math.max(4, barW2 * fillPct), barH2, 2);
    ctx.fill();
  }

  if (state.midFightLevelUpTimer && state.midFightLevelUpTimer > 0) {
    const alpha = Math.min(1, state.midFightLevelUpTimer / 0.5);
    ctx.globalAlpha = alpha;
    ctx.font = "bold 9px 'Oxanium', sans-serif";
    ctx.textAlign = "left";
    ctx.fillStyle = "#ffe066";
    ctx.fillText("▲ LEVEL UP!", ox + 6, oy + oh - 2);
    ctx.globalAlpha = 1;
  }

  ctx.restore();
}

function drawHUD(ctx: CanvasRenderingContext2D, state: GameState): void {
  const barW = 260;
  const barH = 18;
  const padding = 15;
  const hudH = 70;
  const hudTop = CANVAS_H - hudH;
  const barY = hudTop + 15;

  ctx.fillStyle = "rgba(0,0,0,0.5)";
  ctx.fillRect(0, hudTop, CANVAS_W, hudH);

  const nmBoostActive = state.nightmareMode && state.nightmareRegenBoostTimer > 0;
  drawStaminaBar(ctx, padding, barY, barW, barH, state.player, true, nmBoostActive);
  if (!state.nightmareMode) {
    drawStaminaBar(ctx, CANVAS_W - padding - barW, barY, barW, barH, state.enemy, false);
  }
  drawMaxStaminaDeltaTexts(ctx, state, padding, barW, barY);

  const sqSize = 12;
  const sqGap = 3;
  const sqY = barY + (barH - sqSize) / 2;

  const pSqX = padding + barW + sqGap;
  ctx.fillStyle = state.player.colors.gloves;
  ctx.fillRect(pSqX, sqY, sqSize, sqSize);
  ctx.strokeStyle = "rgba(255,255,255,0.4)";
  ctx.lineWidth = 1;
  ctx.strokeRect(pSqX, sqY, sqSize, sqSize);

  ctx.fillStyle = state.player.colors.trunks;
  ctx.fillRect(pSqX + sqSize + 2, sqY, sqSize, sqSize);
  ctx.strokeRect(pSqX + sqSize + 2, sqY, sqSize, sqSize);

  if (!state.nightmareMode) {
    const eSqX = CANVAS_W - padding - barW - sqGap - sqSize * 2 - 2;
    ctx.fillStyle = state.enemy.colors.gloves;
    ctx.fillRect(eSqX, sqY, sqSize, sqSize);
    ctx.strokeRect(eSqX, sqY, sqSize, sqSize);

    ctx.fillStyle = state.enemy.colors.trunks;
    ctx.fillRect(eSqX + sqSize + 2, sqY, sqSize, sqSize);
    ctx.strokeRect(eSqX + sqSize + 2, sqY, sqSize, sqSize);
  }

  const cmY = barY + barH + 3;
  const cmH = 6;
  drawChargeMeter(ctx, padding, cmY, barW, cmH, state.player, true);
  if (!state.nightmareMode) {
    drawChargeMeter(ctx, CANVAS_W - padding - barW, cmY, barW, cmH, state.enemy, false);
  }

  ctx.font = "bold 11px 'Oxanium', sans-serif";
  ctx.textAlign = "left";
  const playerNameText = `${state.player.name} (LV ${state.player.level})`;
  if (state.midFightLevelUps > 0) {
    const nameOnly = `${state.player.name} (LV `;
    const levelOnly = `${state.player.level}`;
    const closeParen = `)`;
    ctx.fillStyle = "#ffffff";
    ctx.fillText(nameOnly, padding, barY - 4);
    const nameW = ctx.measureText(nameOnly).width;
    ctx.fillStyle = "#22cc44";
    ctx.fillText(levelOnly, padding + nameW, barY - 4);
    const lvW = ctx.measureText(levelOnly).width;
    ctx.fillStyle = "#ffffff";
    ctx.fillText(closeParen, padding + nameW + lvW, barY - 4);
  } else {
    ctx.fillStyle = "#ffffff";
    ctx.fillText(playerNameText, padding, barY - 4);
  }
  // Player southpaw badge
  if (state.player.boxingStance === "southpaw") {
    const nameW2 = ctx.measureText(playerNameText).width;
    ctx.font = "bold 9px 'Oxanium', sans-serif";
    ctx.fillStyle = "#f0c040";
    ctx.textAlign = "left";
    ctx.fillText("Southpaw", padding + nameW2 + 5, barY - 4);
    ctx.font = "bold 11px 'Oxanium', sans-serif";
  }
  ctx.fillStyle = "#ffffff";
  ctx.textAlign = "right";
  if (state.nightmareMode) {
    ctx.fillStyle = "#ff6666";
    ctx.font = "bold 11px 'Oxanium', sans-serif";
    ctx.fillText("NIGHTMARE", CANVAS_W - padding, barY - 4);
  } else {
    ctx.fillText(`${state.enemy.name} (LV ${state.enemy.level})`, CANVAS_W - padding, barY - 4);
    // Enemy southpaw badge
    if (state.enemy.boxingStance === "southpaw") {
      const enemyNameText = `${state.enemy.name} (LV ${state.enemy.level})`;
      const enemyNameW = ctx.measureText(enemyNameText).width;
      ctx.font = "bold 9px 'Oxanium', sans-serif";
      ctx.fillStyle = "#f0c040";
      ctx.textAlign = "right";
      ctx.fillText("Southpaw", CANVAS_W - padding - enemyNameW - 5, barY - 4);
      ctx.font = "bold 11px 'Oxanium', sans-serif";
    }
  }

  ctx.textAlign = "center";
  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 14px 'Oxanium', sans-serif";
  const roundText = `R${state.currentRound} of ${state.totalRounds}`;
  ctx.fillText(roundText, CANVAS_W / 2, barY - 2);

  const minutes = Math.floor(state.roundTimer / 60);
  const seconds = Math.floor(state.roundTimer % 60);
  const timeStr = `${minutes}:${seconds.toString().padStart(2, "0")}`;
  ctx.font = "bold 20px 'Oxanium', sans-serif";
  ctx.fillStyle = state.roundTimer < 10 ? "#ff4444" : "#ffffff";
  ctx.fillText(timeStr, CANVAS_W / 2, barY + 18);

  ctx.font = "10px 'Oxanium', sans-serif";
  ctx.fillStyle = "rgba(255,255,255,0.5)";
  ctx.textAlign = "center";
  if (state.nightmareMode) {
    ctx.fillStyle = "#ffaaaa";
    ctx.fillText(`KOs: ${state.nightmareKillCount}`, CANVAS_W / 2, barY + 35);
  } else {
    ctx.fillText(`KD: ${state.player.knockdowns}`, CANVAS_W / 2 - 35, barY + 35);
    ctx.fillText(`KD: ${state.enemy.knockdowns}`, CANVAS_W / 2 + 35, barY + 35);
  }

  if (state.player.defenseState === "fullGuard") {
    ctx.fillStyle = "rgba(100, 150, 255, 0.8)";
    ctx.font = "bold 9px 'Oxanium', sans-serif";
    ctx.textAlign = "left";
    ctx.fillText("FULL GUARD", padding, barY + 35);
    const remaining = Math.max(0, state.player.maxBlockDuration - state.player.blockTimer);
    ctx.fillStyle = "rgba(255,255,255,0.4)";
    ctx.font = "7px 'Oxanium', sans-serif";
    ctx.fillText(`${Math.ceil(remaining)}s`, padding + 60, barY + 35);
  }

  const rhythmY = barY + 42;
  if (state.player.autoGuardActive && state.player.autoGuardDuration > 0) {
    const agW = 50;
    const agH = 5;
    const pct = Math.max(0, Math.min(1, state.player.autoGuardTimer / state.player.autoGuardDuration));
    ctx.fillStyle = "rgba(80, 80, 80, 0.65)";
    ctx.fillRect(padding, rhythmY, agW, agH);
    ctx.fillStyle = "rgba(230, 210, 80, 0.85)";
    ctx.fillRect(padding, rhythmY, agW * pct, agH);
    ctx.strokeStyle = "rgba(200, 190, 100, 0.7)";
    ctx.lineWidth = 0.5;
    ctx.strokeRect(padding, rhythmY, agW, agH);
    ctx.font = "7px 'Oxanium', sans-serif";
    ctx.textAlign = "left";
    ctx.fillStyle = "rgba(230, 210, 80, 0.9)";
    ctx.fillText("AUTO", padding + agW + 3, rhythmY + 4);
  }

  drawPauseButton(ctx);

  if (state.showExpBar) {
    drawExpBarOverlay(ctx, state);
  }
}

/**
 * The orange "-N max stamina" tick that rises out of a stamina bar whenever that
 * fighter's pool shrinks. Anchored to the bar's *inner* edge, because the fighter
 * name is pinned to the outer edge -- a long name would otherwise sit under it.
 * The enemy's ticks are already filtered at source by the Focus gate; the only
 * check left here is Nightmare, where the enemy bar itself is not drawn.
 */
function drawMaxStaminaDeltaTexts(ctx: CanvasRenderingContext2D, state: GameState, padding: number, barW: number, barY: number): void {
  // Same reason as the engine-side backfill: a state that predates this field can
  // reach a render before the first update tick has had a chance to fill it in.
  if (!state.maxStaminaDeltaTexts || state.maxStaminaDeltaTexts.length === 0) return;
  ctx.save();
  ctx.font = "bold 11px 'Oxanium', sans-serif";
  state.maxStaminaDeltaTexts.forEach(t => {
    if (t.side === "enemy" && state.nightmareMode) return;
    const life = Math.max(0, Math.min(1, t.timer / MAX_STAMINA_DELTA_TEXT_LIFETIME));
    ctx.globalAlpha = Math.min(1, life * 2.5);
    const gained = t.delta > 0;
    ctx.fillStyle = gained ? "#35d46a" : "#ff7a18";
    const label = `${gained ? "+" : "-"}${Math.abs(t.delta)}`;
    // Its own lane ABOVE the name row (names sit at barY - 4 in 11px, so they
    // occupy roughly barY-15..barY-4). Anchoring to the bar's inner edge is not
    // enough on its own -- a long name reaches across and the name is painted
    // after this, so it would win the overlap.
    const ty = barY - 20 - (1 - life) * 18;
    if (t.side === "player") {
      ctx.textAlign = "right";
      ctx.fillText(label, padding + barW, ty);
    } else {
      ctx.textAlign = "left";
      ctx.fillText(label, CANVAS_W - padding - barW, ty);
    }
  });
  ctx.restore();
}

function drawStaminaBar(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, fighter: FighterState, isPlayer: boolean, glowBlue = false): void {
  ctx.fillStyle = COLORS.staminaBg;
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, 3);
  ctx.fill();

  const frac = Math.max(0, fighter.stamina / fighter.maxStamina);
  const fillColor = glowBlue ? "#3b82f6" : (frac > 0.5 ? "#22aa44" : (frac > 0.15 ? "#ccaa22" : "#cc2222"));

  const grad = ctx.createLinearGradient(x, y, x, y + h);
  grad.addColorStop(0, fillColor);
  grad.addColorStop(1, shadeColor(fillColor, -30));
  ctx.fillStyle = grad;

  const fillW = w * frac;
  const fillX = isPlayer ? x : x + w - fillW;
  ctx.beginPath();
  ctx.roundRect(fillX, y, fillW, h, 3);
  ctx.fill();

  ctx.strokeStyle = "rgba(255,255,255,0.15)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, 3);
  ctx.stroke();

  ctx.fillStyle = "rgba(255,255,255,0.9)";
  ctx.font = "bold 10px 'Oxanium', sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(`${Math.round(fighter.stamina)}/${Math.round(fighter.maxStamina)}`, x + w / 2, y + h - 4);
}

function drawChargeMeter(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, fighter: FighterState, isPlayer: boolean): void {
  const maxBars = 6;
  const gap = 2;
  const segW = (w - gap * (maxBars - 1)) / maxBars;

  for (let i = 0; i < maxBars; i++) {
    const segX = isPlayer ? x + i * (segW + gap) : x + w - (i + 1) * segW - i * gap;
    const filled = i < fighter.chargeMeterBars;
    const partial = i === fighter.chargeMeterBars ? fighter.chargeMeterCounters / 100 : 0;

    ctx.fillStyle = "rgba(0,0,0,0.4)";
    ctx.fillRect(segX, y, segW, h);

    if (filled) {
      const empowered = fighter.chargeEmpoweredTimer > 0;
      const grad = ctx.createLinearGradient(segX, y, segX, y + h);
      grad.addColorStop(0, empowered ? "#ffcc00" : "#3388ff");
      grad.addColorStop(1, empowered ? "#ff8800" : "#1155cc");
      ctx.fillStyle = grad;
      ctx.fillRect(segX, y, segW, h);
    } else if (partial > 0) {
      const fillW = segW * partial;
      const partX = isPlayer ? segX : segX + segW - fillW;
      ctx.fillStyle = "rgba(51,136,255,0.5)";
      ctx.fillRect(partX, y, fillW, h);
    }
  }
}

function drawCountdown(ctx: CanvasRenderingContext2D, timer: number): void {
  const count = Math.ceil(timer);
  ctx.save();
  ctx.fillStyle = "rgba(0,0,0,0.4)";
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

  const frac = timer - Math.floor(timer);
  const scale = 1 + frac * 0.5;

  ctx.translate(CANVAS_W / 2, CANVAS_H / 2 - 30);
  ctx.scale(scale, scale);

  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 72px 'Oxanium', sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.globalAlpha = 0.5 + frac * 0.5;
  ctx.fillText(count <= 0 ? "FIGHT!" : count.toString(), 0, 0);
  ctx.restore();
}

// The one-in-a-lifetime punch: charged, critical, stunning and straight through
// the rhythm. Slams in, holds, then fades with the knockdown it caused.
function drawBigShotBanner(ctx: CanvasRenderingContext2D, timer: number): void {
  const age = BIG_SHOT_TEXT_DURATION - timer;
  const slam = Math.min(1, age / 0.14);
  const scale = 2.2 - 1.2 * slam * slam;
  const alpha = Math.min(1, timer / 0.35);

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(CANVAS_W / 2, CANVAS_H / 2 - 60);
  ctx.scale(scale, scale);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = "bold 54px 'Oxanium', sans-serif";

  ctx.lineWidth = 8;
  ctx.strokeStyle = "#1a0505";
  ctx.strokeText("BIG SHOT", 0, 0);

  const grad = ctx.createLinearGradient(0, -28, 0, 28);
  grad.addColorStop(0, "#fff3c4");
  grad.addColorStop(0.5, "#ffb020");
  grad.addColorStop(1, "#e02a1c");
  ctx.fillStyle = grad;
  ctx.fillText("BIG SHOT", 0, 0);
  ctx.restore();
}

function drawKnockdownOverlay(ctx: CanvasRenderingContext2D, state: GameState): void {
  ctx.save();

  ctx.font = "18px 'Oxanium', sans-serif";
  ctx.fillStyle = "#cccccc";
  ctx.textAlign = "center";
  ctx.fillText("KNOCKDOWN!", CANVAS_W / 2, 30);

  // Hide the count while the fall animation is still playing
  if (state.knockdownRefCount > 0) {
    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 64px 'Oxanium', sans-serif";
    ctx.fillText(state.knockdownRefCount.toString(), CANVAS_W / 2, 80);
  }

  const knockedFighter = state.player.isKnockedDown ? state.player : state.enemy;
  if (knockedFighter.isPlayer) {
    ctx.font = "16px 'Oxanium', sans-serif";
    ctx.fillStyle = "#ffcc00";
    const kdTextY = 120;
    ctx.fillText(`MASH SPACE! ${state.knockdownMashCount} / ${state.knockdownMashRequired}`, CANVAS_W / 2, kdTextY);

    const barW = 200;
    const barH = 10;
    const barX = CANVAS_W / 2 - barW / 2;
    const barFY = kdTextY + 10;
    ctx.fillStyle = "rgba(255,255,255,0.2)";
    ctx.fillRect(barX, barFY, barW, barH);
    const progress = Math.min(1, state.knockdownMashCount / state.knockdownMashRequired);
    ctx.fillStyle = "#00ff88";
    ctx.fillRect(barX, barFY, barW * progress, barH);
  }

  ctx.restore();
}

const PAUSE_BTN_X = CANVAS_W - 35;
const PAUSE_BTN_Y = 10;
const PAUSE_BTN_SIZE = 24;

function drawPauseButton(ctx: CanvasRenderingContext2D): void {
  ctx.save();
  ctx.fillStyle = "rgba(255,255,255,0.3)";
  ctx.beginPath();
  ctx.roundRect(PAUSE_BTN_X, PAUSE_BTN_Y, PAUSE_BTN_SIZE, PAUSE_BTN_SIZE, 4);
  ctx.fill();

  ctx.fillStyle = "rgba(255,255,255,0.8)";
  const barW = 4;
  const barH = 12;
  const gap = 3;
  const cx = PAUSE_BTN_X + PAUSE_BTN_SIZE / 2;
  const cy = PAUSE_BTN_Y + PAUSE_BTN_SIZE / 2;
  ctx.fillRect(cx - gap - barW, cy - barH / 2, barW, barH);
  ctx.fillRect(cx + gap, cy - barH / 2, barW, barH);
  ctx.restore();
}

export function isPauseButtonClick(x: number, y: number): boolean {
  return x >= PAUSE_BTN_X && x <= PAUSE_BTN_X + PAUSE_BTN_SIZE &&
    y >= PAUSE_BTN_Y && y <= PAUSE_BTN_Y + PAUSE_BTN_SIZE;
}

const PAUSE_MENU_ITEM_W = 200;
const PAUSE_MENU_ITEM_H = 30;
const PAUSE_MENU_START_Y = CANVAS_H / 2 - 25;
const PAUSE_MENU_SPACING = 36;
const PAUSE_MENU_ITEMS_FULL = ["Resume", "Controls", "Sound", "Restart", "Quit"];
const PAUSE_MENU_ITEMS_CAREER = ["Resume", "Bout Details", "Controls", "Sound", "Quit"];

export function getPauseItems(isCareer: boolean, state?: GameState): string[] {
  if (state?.tutorialMode) {
    return ["Resume", "Restart Tutorial", "Quit"];
  }
  if (state?.practiceMode) {
    return [
      "Resume",
      `CPU Attacks: ${state.cpuAttacksEnabled ? "ON" : "OFF"}`,
      `CPU Defense: ${state.cpuDefenseEnabled ? "ON" : "OFF"}`,
      "Controls",
      "Sound",
      "Restart",
      "Quit",
    ];
  }
  if (isCareer && state?.doghouseMode && (state.doghouseOpponentsDefeated ?? 0) >= 2) {
    return ["Resume", "Bout Details", "Controls", "Sound", "Finish Early", "Quit"];
  }
  return isCareer ? PAUSE_MENU_ITEMS_CAREER : PAUSE_MENU_ITEMS_FULL;
}

const SOUND_SLIDER_W = 200;
const SOUND_SLIDER_H = 8;
const SOUND_SLIDER_X = CANVAS_W / 2 - SOUND_SLIDER_W / 2;
const SOUND_CATEGORIES: { label: string; key: "master" | "sfx" | "crowd" | "ui" | "music" }[] = [
  { label: "Master", key: "master" },
  { label: "Music", key: "music" },
  { label: "SFX", key: "sfx" },
  { label: "Crowd", key: "crowd" },
  { label: "UI", key: "ui" },
];
const SOUND_SLIDER_START_Y = CANVAS_H / 2 - 90;
const SOUND_SLIDER_SPACING = 50;

export function getPauseMenuClickIndex(x: number, y: number, isCareer: boolean = false, state?: GameState): number {
  const items = getPauseItems(isCareer, state);
  for (let i = 0; i < items.length; i++) {
    const itemY = PAUSE_MENU_START_Y + i * PAUSE_MENU_SPACING;
    const left = CANVAS_W / 2 - PAUSE_MENU_ITEM_W / 2;
    if (x >= left && x <= left + PAUSE_MENU_ITEM_W &&
      y >= itemY - PAUSE_MENU_ITEM_H / 2 && y <= itemY + PAUSE_MENU_ITEM_H / 2) {
      return i;
    }
  }
  return -1;
}

export function getSoundSliderClick(x: number, y: number): { key: "master" | "sfx" | "crowd" | "ui" | "music"; value: number } | null {
  for (let i = 0; i < SOUND_CATEGORIES.length; i++) {
    const sliderY = SOUND_SLIDER_START_Y + i * SOUND_SLIDER_SPACING + 20;
    if (x >= SOUND_SLIDER_X && x <= SOUND_SLIDER_X + SOUND_SLIDER_W &&
      y >= sliderY - 12 && y <= sliderY + 12) {
      const value = Math.max(0, Math.min(1, (x - SOUND_SLIDER_X) / SOUND_SLIDER_W));
      return { key: SOUND_CATEGORIES[i].key, value };
    }
  }
  const muteY = SOUND_SLIDER_START_Y + SOUND_CATEGORIES.length * SOUND_SLIDER_SPACING + 10;
  const muteW = 120;
  const muteLeft = CANVAS_W / 2 - muteW / 2;
  if (x >= muteLeft && x <= muteLeft + muteW && y >= muteY - 15 && y <= muteY + 15) {
    return { key: "master", value: -1 };
  }
  const backY = muteY + 45;
  const backW = 120;
  const backLeft = CANVAS_W / 2 - backW / 2;
  if (x >= backLeft && x <= backLeft + backW && y >= backY - 15 && y <= backY + 15) {
    return { key: "master", value: -2 };
  }
  return null;
}

// Shared by the overlay and its Back hit box, so the button stays under the
// text when a line is added to the list.
const CONTROLS_ROWS: [string, string][] = [
  ["Move", "Arrow Keys"],
    ["Duck", "Shift"],
    ["Jab", "W"],
    ["Cross", "E"],
    ["L Hook", "Q"],
    ["R Hook", "R"],
    ["L Upper", "S"],
    ["R Upper", "D"],
    ["Body Shot", "Shift + Punch"],
    ["Charge Punch", "A, then Punch"],
    ["Feint", "F, then Punch"],
    ["Full Guard", "Space x2"],
    ["Block Up/Down", "Space + Arrow"],
    ["Perfect Block", "V"],
  ["Rhythm Up", "Tab + Right"],
  ["Rhythm Down", "Tab + Left"],
  ["Pause", "Esc"],
];

const CONTROLS_START_Y = 90;
const CONTROLS_LINE_H = 22;

function drawControlsOverlay(ctx: CanvasRenderingContext2D): void {
  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 28px 'Oxanium', sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("CONTROLS", CANVAS_W / 2, 50);

  const startY = CONTROLS_START_Y;
  const lineH = CONTROLS_LINE_H;
  const colLabelX = CANVAS_W / 2 - 20;
  const colValueX = CANVAS_W / 2 + 20;

  ctx.font = "14px 'Oxanium', sans-serif";
  CONTROLS_ROWS.forEach(([label, value], i) => {
    const y = startY + i * lineH;
    ctx.fillStyle = "rgba(255, 255, 255, 0.6)";
    ctx.textAlign = "right";
    ctx.fillText(label, colLabelX, y);
    ctx.fillStyle = "#ffcc44";
    ctx.textAlign = "left";
    ctx.fillText(value, colValueX, y);
  });

  const backY = controlsBackY();
  ctx.fillStyle = "rgba(255, 255, 255, 0.8)";
  ctx.font = "bold 16px 'Oxanium', sans-serif";
  ctx.textAlign = "center";
  ctx.fillText("[ Back ]", CANVAS_W / 2, backY);
}

function controlsBackY(): number {
  return CONTROLS_START_Y + CONTROLS_ROWS.length * CONTROLS_LINE_H + 20;
}

export function getControlsBackClick(x: number, y: number): boolean {
  const backY = controlsBackY();
  const backW = 120;
  const backLeft = CANVAS_W / 2 - backW / 2;
  return x >= backLeft && x <= backLeft + backW && y >= backY - 15 && y <= backY + 15;
}

function drawPauseMenu(ctx: CanvasRenderingContext2D, selectedIndex: number, soundTab: boolean, controlsTab: boolean, isCareer: boolean = false, state?: GameState): void {
  ctx.save();
  ctx.fillStyle = "rgba(0, 0, 0, 0.75)";
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

  if (state?.pauseBoutDetailsTab) {
    ctx.restore();
    return;
  }

  const menuItems = getPauseItems(isCareer, state);

  if (controlsTab) {
    drawControlsOverlay(ctx);
  } else if (soundTab) {
    drawSoundControls(ctx);
  } else {
    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 36px 'Oxanium', sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("PAUSED", CANVAS_W / 2, CANVAS_H / 2 - 100);

    menuItems.forEach((item, i) => {
      const y = PAUSE_MENU_START_Y + i * PAUSE_MENU_SPACING;
      const isSelected = i === selectedIndex;

      if (isSelected) {
        ctx.fillStyle = "rgba(255, 200, 50, 0.15)";
        ctx.beginPath();
        ctx.roundRect(CANVAS_W / 2 - PAUSE_MENU_ITEM_W / 2, y - PAUSE_MENU_ITEM_H / 2, PAUSE_MENU_ITEM_W, PAUSE_MENU_ITEM_H, 4);
        ctx.fill();
      }

      const isToggleOn = item.endsWith(": ON");
      const isToggleOff = item.endsWith(": OFF");
      if (isSelected) {
        ctx.fillStyle = isToggleOff ? "#ff6666" : isToggleOn ? "#66ff88" : "#ffcc44";
      } else {
        ctx.fillStyle = isToggleOff ? "rgba(255, 100, 100, 0.5)" : isToggleOn ? "rgba(100, 255, 130, 0.5)" : "rgba(255, 255, 255, 0.6)";
      }
      ctx.font = isSelected ? "bold 20px 'Oxanium', sans-serif" : "18px 'Oxanium', sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(item, CANVAS_W / 2, y);
    });

    ctx.fillStyle = "rgba(255, 255, 255, 0.3)";
    ctx.font = "11px 'Oxanium', sans-serif";
    ctx.fillText("Click or use arrow keys + Enter", CANVAS_W / 2, CANVAS_H / 2 + 130);
  }

  ctx.restore();
}

function drawSoundControls(ctx: CanvasRenderingContext2D): void {
  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 28px 'Oxanium', sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("SOUND SETTINGS", CANVAS_W / 2, SOUND_SLIDER_START_Y - 50);

  const volumes = soundEngine.getVolumes();
  const isMuted = soundEngine.isMuted();

  SOUND_CATEGORIES.forEach((cat, i) => {
    const y = SOUND_SLIDER_START_Y + i * SOUND_SLIDER_SPACING;
    const sliderY = y + 20;
    const vol = volumes[cat.key];

    ctx.fillStyle = "rgba(255, 255, 255, 0.7)";
    ctx.font = "14px 'Oxanium', sans-serif";
    ctx.textAlign = "left";
    ctx.fillText(cat.label, SOUND_SLIDER_X, y + 4);

    ctx.fillStyle = `rgba(255, 255, 255, ${isMuted ? 0.15 : 0.25})`;
    ctx.font = "12px 'Oxanium', sans-serif";
    ctx.textAlign = "right";
    ctx.fillText(`${Math.round(vol * 100)}%`, SOUND_SLIDER_X + SOUND_SLIDER_W, y + 4);

    ctx.fillStyle = "rgba(255, 255, 255, 0.15)";
    ctx.beginPath();
    ctx.roundRect(SOUND_SLIDER_X, sliderY - SOUND_SLIDER_H / 2, SOUND_SLIDER_W, SOUND_SLIDER_H, 4);
    ctx.fill();

    const fillW = vol * SOUND_SLIDER_W;
    ctx.fillStyle = isMuted ? "rgba(100, 100, 100, 0.5)" : "rgba(255, 200, 50, 0.8)";
    ctx.beginPath();
    ctx.roundRect(SOUND_SLIDER_X, sliderY - SOUND_SLIDER_H / 2, fillW, SOUND_SLIDER_H, 4);
    ctx.fill();

    const knobX = SOUND_SLIDER_X + fillW;
    ctx.fillStyle = isMuted ? "#888" : "#ffcc44";
    ctx.beginPath();
    ctx.arc(knobX, sliderY, 6, 0, Math.PI * 2);
    ctx.fill();
  });

  const muteY = SOUND_SLIDER_START_Y + SOUND_CATEGORIES.length * SOUND_SLIDER_SPACING + 10;
  const muteW = 120;
  const muteLeft = CANVAS_W / 2 - muteW / 2;
  ctx.fillStyle = isMuted ? "rgba(255, 80, 80, 0.3)" : "rgba(255, 255, 255, 0.1)";
  ctx.beginPath();
  ctx.roundRect(muteLeft, muteY - 15, muteW, 30, 4);
  ctx.fill();
  ctx.fillStyle = isMuted ? "#ff6666" : "rgba(255, 255, 255, 0.7)";
  ctx.font = "14px 'Oxanium', sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(isMuted ? "UNMUTE" : "MUTE ALL", CANVAS_W / 2, muteY);

  const backY = muteY + 45;
  const backW = 120;
  const backLeft = CANVAS_W / 2 - backW / 2;
  ctx.fillStyle = "rgba(255, 200, 50, 0.15)";
  ctx.beginPath();
  ctx.roundRect(backLeft, backY - 15, backW, 30, 4);
  ctx.fill();
  ctx.fillStyle = "#ffcc44";
  ctx.font = "bold 14px 'Oxanium', sans-serif";
  ctx.textAlign = "center";
  ctx.fillText("← BACK", CANVAS_W / 2, backY);
}

/**
 * Sparring headgear colours for the AI. Matches the difficulty colour language
 * used elsewhere in the app, so the partner's headgear reads as the difficulty
 * the session was booked at.
 */
export const SPARRING_HEADGEAR_BY_DIFFICULTY: Record<string, string> = {
  journeyman: "#22aa44",
  contender: "#ddaa00",
  elite: "#cc4400",
  champion: "#cc2222",
};

export const DEFAULT_HEADGEAR_COLOR = "#2244aa";

/**
 * Padded sparring headgear, shaped like the real thing: a boxy shell with
 * heavily rounded corners, a cut-out for the face, cheek pads and a chin bar.
 * Drawn after the head/eyes so the features stay visible through the opening,
 * and before the arms so a high guard covers it.  The opening is always cut:
 * the fighter's eyes are drawn at every in-ring angle, so the headgear must
 * never close over them.
 */
function drawHeadgear(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  color: string,
  frontView: number,
  faceDirX: number,
): void {
  // 1 = squared up to the camera, 0 = pure profile.
  const ff = Math.min(1, Math.abs(frontView));
  const dir = faceDirX >= 0 ? 1 : -1;

  const halfW = HEAD_R * (1.06 + 0.2 * ff);
  const top = cy - HEAD_R * 1.3;
  const bot = cy + HEAD_R * 1.26;
  const shellH = bot - top;
  const cornerR = HEAD_R * 0.52;

  // The opening tracks the eyes (drawn at frontView * HEAD_R * 0.3) and slides
  // toward the facing side as the fighter turns to profile.
  const openCX = cx + frontView * HEAD_R * 0.28 + (1 - ff) * dir * HEAD_R * 0.4;
  const openHalfW = HEAD_R * (0.4 + 0.28 * ff);
  const openTop = cy - HEAD_R * 0.58;
  const openH = HEAD_R * 1.46;
  const openR = HEAD_R * 0.3;

  const shellPath = () => {
    ctx.beginPath();
    roundedBoxPath(ctx, cx - halfW, top, halfW * 2, shellH, cornerR);
  };
  const openPath = () => {
    roundedBoxPath(ctx, openCX - openHalfW, openTop, openHalfW * 2, openH, openR);
  };

  ctx.save();

  const grad = ctx.createLinearGradient(cx, top, cx, bot);
  grad.addColorStop(0, shadeColor(color, 50));
  grad.addColorStop(0.5, shadeColor(color, 0));
  grad.addColorStop(1, shadeColor(color, -50));
  ctx.fillStyle = isSpacial(color) ? spacialPaint(ctx) : grad;

  shellPath();
  // Reverse-wound so the even-odd fill leaves the face open.
  ctx.moveTo(openCX + openHalfW, openTop + openH - openR);
  openPath();
  ctx.fill("evenodd");

  // Pads are clipped to the shell (minus the opening) so nothing bleeds onto
  // the face or outside the silhouette.
  ctx.save();
  shellPath();
  ctx.moveTo(openCX + openHalfW, openTop + openH - openR);
  openPath();
  ctx.clip("evenodd");

  {
    // Brow pad across the crown, with a seam under it.
    ctx.fillStyle = shadeColor(color, 24);
    ctx.beginPath();
    roundedBoxPath(
      ctx, cx - halfW * 0.88, top + HEAD_R * 0.14,
      halfW * 1.76, HEAD_R * 0.66, HEAD_R * 0.28,
    );
    ctx.fill();
    ctx.strokeStyle = shadeColor(color, -40);
    ctx.globalAlpha = 0.5;
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.moveTo(cx - halfW * 0.9, openTop - HEAD_R * 0.06);
    ctx.lineTo(cx + halfW * 0.9, openTop - HEAD_R * 0.06);
    ctx.stroke();
    ctx.globalAlpha = 1;

    // Cheek pads: raised blocks hugging the opening, brighter on the near side.
    for (const sgn of [-1, 1]) {
      const pw = HEAD_R * 0.5;
      const px = openCX + sgn * (openHalfW + pw * 0.5) - pw * 0.5;
      ctx.fillStyle = shadeColor(color, sgn === dir ? 8 : -26);
      ctx.beginPath();
      roundedBoxPath(ctx, px, openTop + HEAD_R * 0.12, pw, openH * 0.86, HEAD_R * 0.24);
      ctx.fill();
    }

    // Chin cup wrapping under the opening.
    ctx.fillStyle = shadeColor(color, -16);
    ctx.beginPath();
    roundedBoxPath(
      ctx, openCX - openHalfW * 1.2, openTop + openH - HEAD_R * 0.12,
      openHalfW * 2.4, HEAD_R * 0.56, HEAD_R * 0.24,
    );
    ctx.fill();
  }

  // The far vertical face of the box, so it reads as a solid rather than a tile.
  const sideW = halfW * (0.34 + 0.3 * (1 - ff));
  ctx.fillStyle = shadeColor(color, -38);
  ctx.globalAlpha = 0.55;
  ctx.beginPath();
  roundedBoxPath(
    ctx, dir > 0 ? cx - halfW : cx + halfW - sideW, top,
    sideW, bot - top, cornerR * 0.8,
  );
  ctx.fill();
  ctx.globalAlpha = 1;

  // Ear cup on the side of the head, behind the eye line.
  const earX = cx - dir * halfW * (0.34 + 0.28 * ff);
  const earR = HEAD_R * 0.34;
  ctx.fillStyle = shadeColor(color, -32);
  ctx.beginPath();
  ctx.arc(earX, cy + HEAD_R * 0.16, earR, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = shadeColor(color, -55);
  ctx.beginPath();
  ctx.arc(earX, cy + HEAD_R * 0.16, earR * 0.42, 0, Math.PI * 2);
  ctx.fill();

  // Crown sheen.
  ctx.strokeStyle = shadeColor(color, 60);
  ctx.globalAlpha = 0.5;
  ctx.lineWidth = Math.max(0.8, HEAD_R * 0.11);
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(cx - halfW * 0.5, top + HEAD_R * 0.3);
  ctx.quadraticCurveTo(cx, top + HEAD_R * 0.12, cx + halfW * 0.42, top + HEAD_R * 0.34);
  ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.restore();

  // Outline: shell edge plus the padded rim around the face opening.
  ctx.strokeStyle = shadeColor(color, -70);
  ctx.lineWidth = 0.9;
  shellPath();
  ctx.stroke();
  ctx.strokeStyle = shadeColor(color, -60);
  ctx.lineWidth = Math.max(1, HEAD_R * 0.1);
  ctx.beginPath();
  openPath();
  ctx.stroke();

  ctx.restore();
}

/** Rounded-rectangle sub-path (hand-rolled: ctx.roundRect isn't universal). */
function roundedBoxPath(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number, r: number,
): void {
  const rr = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
}

/** Picks a light or dark accent so trim stays visible against any base colour. */
function contrastInk(hex: string, light: string, dark: string): string {
  const [r, g, b] = parseHex(hex);
  return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? dark : light;
}

/**
 * Boxing mitt. Local space points the knuckles along +x, so the caller passes
 * an aim vector (normally elbow → glove) and the cuff always ends up on the
 * wrist side. `profile` (0..1) foreshortens the mitt along the aim axis: a
 * glove travelling at or away from the camera squashes into a fist coming at
 * you instead of staying a side-on mitt.
 */
export function drawBoxingGlove(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, r: number,
  aimX: number, aimY: number,
  gloveColor: string, tapeColor: string,
  profile: number,
  flat: boolean,
  bareFist: boolean = false,
  /**
   * Mirrors the thumb across the forearm axis. The mitt art is rotated, not
   * mirrored, so the two gloves of a fighter facing the camera end up with
   * their thumbs on opposite sides; the still canvases flip the right-hand
   * glove so both thumbs read inward.
   */
  flipThumb: boolean = false,
): void {
  const aimLen = Math.hypot(aimX, aimY);
  const ang = aimLen > 0.0001 ? Math.atan2(aimY, aimX) : 0;
  const squash = 0.62 + 0.38 * Math.min(1, Math.max(0, profile));

  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(ang);
  ctx.scale(squash, 1);

  const deep = shadeColor(gloveColor, -65);

  // The referee's "gloves" are bare hands — a plain fist, no cuff or wrap.
  if (bareFist) {
    ctx.beginPath();
    ctx.ellipse(0, 0, r * 0.92, r * 0.86, 0, 0, Math.PI * 2);
    ctx.fillStyle = flat ? gloveColor : shadeColor(gloveColor, -8);
    ctx.fill();
    if (!flat) {
      ctx.strokeStyle = deep;
      ctx.globalAlpha = 0.35;
      ctx.lineWidth = 0.7;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    ctx.restore();
    return;
  }

  // ── Wrist cuff, drawn first so the mitt overlaps its front edge ────────────
  const cuffBackX = -r * 1.3;
  const cuffFrontX = -r * 0.1;
  const cuffH = r * 0.6;
  ctx.beginPath();
  roundedBoxPath(ctx, cuffBackX, -cuffH, cuffFrontX - cuffBackX, cuffH * 2, r * 0.24);
  ctx.fillStyle = flat ? gloveColor : shadeColor(gloveColor, -22);
  ctx.fill();

  if (!flat) {
    // Hand wrap at the wrist end of the cuff — this is the editable tape colour.
    const tapeW = (cuffFrontX - cuffBackX) * 0.62;
    ctx.save();
    ctx.beginPath();
    roundedBoxPath(ctx, cuffBackX, -cuffH, cuffFrontX - cuffBackX, cuffH * 2, r * 0.24);
    ctx.clip();
    ctx.fillStyle = tapeColor;
    ctx.fillRect(cuffBackX, -cuffH, tapeW, cuffH * 2);
    // Overlapping wrap turns
    ctx.strokeStyle = shadeColor(tapeColor, -50);
    ctx.globalAlpha = 0.5;
    ctx.lineWidth = 0.6;
    for (let i = 1; i <= 2; i++) {
      const bx = cuffBackX + (tapeW * i) / 3;
      ctx.beginPath();
      ctx.moveTo(bx + r * 0.14, -cuffH);
      ctx.lineTo(bx - r * 0.14, cuffH);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    // Shaded underside of the cuff
    ctx.fillStyle = "rgba(0,0,0,0.22)";
    ctx.fillRect(cuffBackX, cuffH * 0.35, cuffFrontX - cuffBackX, cuffH);
    ctx.restore();
    // Velcro strap edge where the wrap meets the leather
    ctx.strokeStyle = shadeColor(tapeColor, -60);
    ctx.globalAlpha = 0.55;
    ctx.lineWidth = 0.7;
    ctx.beginPath();
    ctx.moveTo(cuffBackX + tapeW, -cuffH);
    ctx.lineTo(cuffBackX + tapeW, cuffH);
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = deep;
    ctx.globalAlpha = 0.4;
    ctx.lineWidth = 0.7;
    ctx.beginPath();
    roundedBoxPath(ctx, cuffBackX, -cuffH, cuffFrontX - cuffBackX, cuffH * 2, r * 0.24);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // ── Mitt body ─────────────────────────────────────────────────────────────
  ctx.beginPath();
  ctx.moveTo(-r * 0.55, -r * 0.72);
  ctx.bezierCurveTo(-r * 0.1, -r * 1.12, r * 0.7, -r * 1.06, r * 0.98, -r * 0.5);
  ctx.bezierCurveTo(r * 1.26, -r * 0.06, r * 1.1, r * 0.62, r * 0.6, r * 0.86);
  ctx.bezierCurveTo(r * 0.2, r * 1.06, -r * 0.3, r * 0.98, -r * 0.55, r * 0.66);
  ctx.bezierCurveTo(-r * 0.8, r * 0.38, -r * 0.8, -r * 0.44, -r * 0.55, -r * 0.72);
  ctx.closePath();

  if (flat) {
    ctx.fillStyle = gloveColor;
  } else {
    const grad = ctx.createRadialGradient(
      -r * 0.25, -r * 0.45, r * 0.05,
      r * 0.15, r * 0.1, r * 1.4,
    );
    grad.addColorStop(0, shadeColor(gloveColor, 50));
    grad.addColorStop(0.5, shadeColor(gloveColor, 0));
    grad.addColorStop(1, shadeColor(gloveColor, -55));
    ctx.fillStyle = isSpacial(gloveColor) ? spacialPaint(ctx) : grad;
  }
  ctx.fill();

  if (!flat) {
    ctx.strokeStyle = deep;
    ctx.globalAlpha = 0.45;
    ctx.lineWidth = 0.7;
    ctx.stroke();
    ctx.globalAlpha = 1;

    // Knuckle seam
    ctx.strokeStyle = deep;
    ctx.globalAlpha = 0.35;
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.moveTo(r * 0.5, -r * 0.85);
    ctx.quadraticCurveTo(r * 0.8, 0, r * 0.42, r * 0.8);
    ctx.stroke();
    ctx.globalAlpha = 1;

    // Thumb
    const thumbSide = flipThumb ? -1 : 1;
    ctx.beginPath();
    ctx.ellipse(r * 0.05, r * 0.62 * thumbSide, r * 0.5, r * 0.33, -0.32 * thumbSide, 0, Math.PI * 2);
    ctx.fillStyle = shadeColor(gloveColor, -14);
    ctx.fill();
    ctx.strokeStyle = deep;
    ctx.globalAlpha = 0.4;
    ctx.lineWidth = 0.6;
    ctx.stroke();
    ctx.globalAlpha = 1;

    // Leather highlight
    ctx.fillStyle = "rgba(255,255,255,0.16)";
    ctx.beginPath();
    ctx.ellipse(-r * 0.08, -r * 0.55, r * 0.42, r * 0.2, -0.25, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.restore();
}

/**
 * Ribbed boxing sock covering the lower shin. Drawn between the leg and the
 * shoe so the shoe's ankle collar overlaps its bottom edge.
 */
export function drawSock(
  ctx: CanvasRenderingContext2D,
  footX: number, footY: number,
  kneeX: number, kneeY: number,
  width: number,
  color: string,
  flat: boolean,
): void {
  const dx = kneeX - footX;
  const dy = kneeY - footY;
  const topT = 0.46;
  const topX = footX + dx * topT;
  const topY = footY + dy * topT;

  ctx.save();
  ctx.lineCap = "round";
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.moveTo(footX, footY);
  ctx.lineTo(topX, topY);
  ctx.stroke();

  if (!flat) {
    // Shaded far side
    ctx.strokeStyle = "rgba(0,0,0,0.18)";
    ctx.lineWidth = width * 0.4;
    ctx.beginPath();
    ctx.moveTo(footX + width * 0.28, footY);
    ctx.lineTo(topX + width * 0.28, topY);
    ctx.stroke();

    // Ribbed cuff band at the top
    const bandT = 0.86;
    const bx = footX + (topX - footX) * bandT;
    const by = footY + (topY - footY) * bandT;
    ctx.strokeStyle = shadeColor(color, -40);
    ctx.globalAlpha = 0.55;
    ctx.lineWidth = 0.7;
    const px = -(topY - footY);
    const py = topX - footX;
    const pl = Math.hypot(px, py) || 1;
    const nx = (px / pl) * width * 0.5;
    const ny = (py / pl) * width * 0.5;
    for (let i = 0; i < 2; i++) {
      const ox = (topX - footX) * 0.06 * i;
      const oy = (topY - footY) * 0.06 * i;
      ctx.beginPath();
      ctx.moveTo(bx - nx + ox, by - ny + oy);
      ctx.lineTo(bx + nx + ox, by + ny + oy);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  ctx.restore();
}

/**
 * High-top boxing shoe: rubber sole, laced instep, ankle collar and heel tab.
 * `unit` is one FIGHTER_SCALE step for the leg being drawn, `dir` the facing
 * (+1 toe pointing right). `plain` drops the collar and laces for the referee.
 */
/**
 * Colour the laces fall back to when a fighter has not picked one: a light or
 * dark ink chosen for contrast against the shoe.  Exported so the colour
 * editors can seed their picker with exactly what the canvas would draw.
 */
export function defaultLaceColor(shoeColor: string): string {
  return contrastInk(shoeColor, "#f0ece0", "#26262a");
}

/** Sole colour used when a fighter has not picked one. */
export function defaultSoleColor(shoeColor: string): string {
  return contrastInk(shoeColor, "#e4e0d6", "#2a2a2c");
}

/** Waist-stripe colour used when a fighter has not picked one. */
export function defaultWaistStripeColor(trunksColor: string): string {
  return shadeColor(trunksColor, 30);
}

export function drawBoxingShoe(
  ctx: CanvasRenderingContext2D,
  footX: number, footY: number,
  unit: number,
  dir: number,
  color: string,
  flat: boolean,
  rot: number = 0,
  plain: boolean = false,
  laceColor?: string,
  soleColor?: string,
): void {
  const u = unit;
  ctx.save();
  ctx.translate(footX, footY);
  if (rot) ctx.rotate(rot * (dir >= 0 ? 1 : -1));
  ctx.scale(dir >= 0 ? 1 : -1, 1);

  const collarTop = plain ? -2.0 * u : -6.0 * u;

  // ── Upper ─────────────────────────────────────────────────────────────────
  ctx.beginPath();
  ctx.moveTo(-2.4 * u, 0.9 * u);
  ctx.lineTo(-2.25 * u, collarTop + 0.7 * u);
  ctx.quadraticCurveTo(-2.15 * u, collarTop, -1.2 * u, collarTop);
  ctx.lineTo(0.8 * u, collarTop + 0.15 * u);
  ctx.quadraticCurveTo(1.6 * u, collarTop + 0.3 * u, 1.8 * u, collarTop + 1.5 * u);
  ctx.lineTo(2.5 * u, -1.9 * u);
  ctx.quadraticCurveTo(3.3 * u, -1.5 * u, 4.4 * u, -1.35 * u);
  ctx.quadraticCurveTo(5.5 * u, -1.2 * u, 5.7 * u, -0.1 * u);
  ctx.lineTo(5.6 * u, 0.9 * u);
  ctx.closePath();

  if (flat) {
    ctx.fillStyle = color;
  } else {
    const grad = ctx.createLinearGradient(0, collarTop, 0, 1.2 * u);
    grad.addColorStop(0, shadeColor(color, 32));
    grad.addColorStop(0.55, shadeColor(color, 0));
    grad.addColorStop(1, shadeColor(color, -45));
    ctx.fillStyle = isSpacial(color) ? spacialPaint(ctx) : grad;
  }
  ctx.fill();
  if (!flat) {
    ctx.strokeStyle = shadeColor(color, -60);
    ctx.globalAlpha = 0.5;
    ctx.lineWidth = 0.6;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // ── Sole ──────────────────────────────────────────────────────────────────
  const soleCol = flat ? color : (soleColor || defaultSoleColor(color));
  ctx.beginPath();
  ctx.moveTo(-2.55 * u, 0.6 * u);
  ctx.lineTo(5.75 * u, 0.5 * u);
  ctx.quadraticCurveTo(6.15 * u, 0.85 * u, 5.6 * u, 1.55 * u);
  ctx.lineTo(-2.1 * u, 1.7 * u);
  ctx.quadraticCurveTo(-2.8 * u, 1.6 * u, -2.55 * u, 0.6 * u);
  ctx.closePath();
  ctx.fillStyle = soleCol;
  ctx.fill();
  if (!flat) {
    ctx.strokeStyle = "rgba(0,0,0,0.45)";
    ctx.lineWidth = 0.5;
    ctx.stroke();
    // Midsole stripe
    ctx.strokeStyle = "rgba(0,0,0,0.25)";
    ctx.beginPath();
    ctx.moveTo(-2.35 * u, 1.05 * u);
    ctx.lineTo(5.6 * u, 0.95 * u);
    ctx.stroke();
  }

  if (!plain && !flat) {
    // ── Ankle collar padding ────────────────────────────────────────────────
    ctx.strokeStyle = shadeColor(color, 45);
    ctx.lineWidth = 1.1;
    ctx.globalAlpha = 0.75;
    ctx.beginPath();
    ctx.moveTo(-2.1 * u, collarTop + 0.2 * u);
    ctx.quadraticCurveTo(-0.6 * u, collarTop - 0.25 * u, 0.9 * u, collarTop + 0.35 * u);
    ctx.stroke();
    ctx.globalAlpha = 1;

    // Heel tab
    ctx.fillStyle = shadeColor(color, -30);
    ctx.beginPath();
    roundedBoxPath(ctx, -2.5 * u, collarTop - 0.15 * u, 1.0 * u, 1.1 * u, 0.3 * u);
    ctx.fill();

    // ── Laces up the instep ─────────────────────────────────────────────────
    const laceCol = laceColor || defaultLaceColor(color);
    const sx0 = 1.35 * u, sy0 = collarTop + 1.35 * u;
    const sx1 = 3.6 * u, sy1 = -1.3 * u;
    const ldx = sx1 - sx0, ldy = sy1 - sy0;
    const ll = Math.hypot(ldx, ldy) || 1;
    const pxn = -ldy / ll, pyn = ldx / ll;
    const half = 0.8 * u;
    ctx.strokeStyle = laceCol;
    ctx.lineWidth = 0.7;
    ctx.lineCap = "round";
    for (let i = 0; i < 4; i++) {
      const t0 = 0.08 + i * 0.24;
      const t1 = t0 + 0.18;
      const ax = sx0 + ldx * t0, ay = sy0 + ldy * t0;
      const bx = sx0 + ldx * t1, by = sy0 + ldy * t1;
      ctx.beginPath();
      ctx.moveTo(ax - pxn * half, ay - pyn * half);
      ctx.lineTo(bx + pxn * half, by + pyn * half);
      ctx.moveTo(ax + pxn * half, ay + pyn * half);
      ctx.lineTo(bx - pxn * half, by - pyn * half);
      ctx.stroke();
    }
    // Tongue edge
    ctx.strokeStyle = shadeColor(color, -55);
    ctx.globalAlpha = 0.45;
    ctx.lineWidth = 0.6;
    ctx.beginPath();
    ctx.moveTo(sx0 - pxn * half * 1.15, sy0 - pyn * half * 1.15);
    ctx.lineTo(sx1 - pxn * half * 1.15, sy1 - pyn * half * 1.15);
    ctx.moveTo(sx0 + pxn * half * 1.15, sy0 + pyn * half * 1.15);
    ctx.lineTo(sx1 + pxn * half * 1.15, sy1 + pyn * half * 1.15);
    ctx.stroke();
    ctx.globalAlpha = 1;

    // Toe cap seam
    ctx.strokeStyle = shadeColor(color, -55);
    ctx.globalAlpha = 0.4;
    ctx.beginPath();
    ctx.moveTo(4.25 * u, -1.3 * u);
    ctx.quadraticCurveTo(4.0 * u, 0, 4.35 * u, 0.85 * u);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  ctx.restore();
}

/**
 * Builds the outline of one tapered limb segment: `wStart`/`wEnd` are the
 * widths at the two joints, `wMid` the belly of the muscle (bicep / calf)
 * placed `bulgeT` of the way along.  Both ends are capped with a half-round so
 * joints still read as spheres.
 */
function limbPath(
  ctx: CanvasRenderingContext2D,
  x0: number, y0: number, x1: number, y1: number,
  wStart: number, wMid: number, wEnd: number,
  bulgeT: number,
): { nx: number; ny: number } {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const rawLen = Math.hypot(dx, dy);
  const h0 = Math.max(0.1, wStart * 0.5);
  const hm = Math.max(0.1, wMid * 0.5);
  const h1 = Math.max(0.1, wEnd * 0.5);

  // Collapsed segment (a limb folded flat during a punch): fall back to a
  // single bounded joint circle so the capsule can't balloon or self-fold.
  if (!Number.isFinite(rawLen) || rawLen < 0.001) {
    ctx.beginPath();
    ctx.arc(x0, y0, Math.max(h0, h1), 0, Math.PI * 2);
    ctx.closePath();
    return { nx: -1, ny: 0 };
  }

  const len = rawLen;
  const nx = -(dy / len);
  const ny = dx / len;
  const t = Math.min(0.8, Math.max(0.2, bulgeT));
  // Quadratic control offset that makes the curve actually reach `hm` at t.
  // Clamped so a short or lopsided segment can't throw the control point far
  // outside the limb and fold the outline over itself.
  const hcRaw = (hm - (1 - t) * (1 - t) * h0 - t * t * h1) / (2 * t * (1 - t));
  const hcLimit = Math.min(Math.max(h0, hm, h1) * 2.2, len * 0.9 + hm);
  const hc = Math.min(hcLimit, Math.max(Math.min(h0, h1) * 0.5, hcRaw));
  const cx = x0 + dx * t;
  const cy = y0 + dy * t;
  const aN = Math.atan2(ny, nx);

  ctx.beginPath();
  ctx.moveTo(x0 + nx * h0, y0 + ny * h0);
  ctx.quadraticCurveTo(cx + nx * hc, cy + ny * hc, x1 + nx * h1, y1 + ny * h1);
  ctx.arc(x1, y1, h1, aN, aN - Math.PI, true);
  ctx.quadraticCurveTo(cx - nx * hc, cy - ny * hc, x0 - nx * h0, y0 - ny * h0);
  ctx.arc(x0, y0, h0, aN + Math.PI, aN, true);
  ctx.closePath();
  return { nx, ny };
}

/**
 * Draws a lean, lightly muscled limb segment: cylindrical cross-light plus a
 * short highlight over the muscle belly.  `flat` paints a single colour for the
 * crit / block flash silhouette.
 */
export function drawLimb(
  ctx: CanvasRenderingContext2D,
  x0: number, y0: number, x1: number, y1: number,
  wStart: number, wMid: number, wEnd: number,
  color: string,
  flat: boolean,
  bulgeT: number = 0.42,
): void {
  ctx.save();
  const { nx, ny } = limbPath(ctx, x0, y0, x1, y1, wStart, wMid, wEnd, bulgeT);

  if (flat) {
    ctx.fillStyle = color;
    ctx.fill();
    ctx.restore();
    return;
  }

  // The key light sits up and to the left, so the lit edge is whichever normal
  // points that way.  Without this the shading flips as a limb swings across.
  const litSign = (-nx - ny * 0.35) >= 0 ? 1 : -1;
  const mx = (x0 + x1) * 0.5;
  const my = (y0 + y1) * 0.5;
  const hMax = Math.max(wStart, wMid, wEnd) * 0.5;
  const grad = ctx.createLinearGradient(
    mx + nx * hMax * litSign, my + ny * hMax * litSign,
    mx - nx * hMax * litSign, my - ny * hMax * litSign,
  );
  grad.addColorStop(0, shadeColor(color, 24));
  grad.addColorStop(0.45, shadeColor(color, 0));
  grad.addColorStop(1, shadeColor(color, -42));
  ctx.fillStyle = isSpacial(color) ? spacialPaint(ctx) : grad;
  ctx.fill();

  // Muscle belly: a soft streak along the lit side, clipped to the limb.
  ctx.clip();
  const off = hMax * 0.34 * litSign;
  ctx.strokeStyle = shadeColor(color, 38);
  ctx.globalAlpha = 0.34;
  ctx.lineCap = "round";
  ctx.lineWidth = Math.max(0.9, hMax * 0.5);
  ctx.beginPath();
  ctx.moveTo(x0 + (x1 - x0) * 0.16 + nx * off, y0 + (y1 - y0) * 0.16 + ny * off);
  ctx.quadraticCurveTo(
    x0 + (x1 - x0) * bulgeT + nx * off * 1.25, y0 + (y1 - y0) * bulgeT + ny * off * 1.25,
    x0 + (x1 - x0) * 0.72 + nx * off * 0.6, y0 + (y1 - y0) * 0.72 + ny * off * 0.6,
  );
  ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.restore();
}

function shadeColor(color: string, percent: number): string {
  const num = parseInt((isSpacial(color) ? SPACIAL_BASE_HEX : color).replace("#", ""), 16);
  if (isNaN(num)) return color;
  const r = Math.min(255, Math.max(0, (num >> 16) + percent));
  const g = Math.min(255, Math.max(0, ((num >> 8) & 0x00ff) + percent));
  const b = Math.min(255, Math.max(0, (num & 0x0000ff) + percent));
  // Hex, not `rgb(...)`: shaded colours seed the gear colour pickers (the waist
  // stripe follows the trunks), and <input type="color"> only accepts #rrggbb —
  // an rgb() string collapses the swatch and leaks into the value label.
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;
}

function createPreviewFighterState(colors: FighterColors, bobPhase: number): FighterState {
  return {
    name: "",
    archetype: "BoxerPuncher",
    level: 1,
    // A still preview never fatigues, but drawFighter reads these, so it gets a
    // real idle fatigue object rather than relying on the null-safe reads.
    lastWalkDir: "none",
    fatigue: createFatigueState(0),
    x: RING_CX,
    z: RING_CY,
    y: 0,
    prevX: RING_CX,
    prevZ: RING_CY,
    currentMoveDir: "none",
    punchMoveDir: "none",
    stamina: 100,
    maxStamina: 100,
    maxStaminaCap: 100,
    staminaRegen: 5,
    facing: 1,
    facingAngle: Math.PI,
    headOffset: { x: 0, y: 0 },
    leftGloveOffset: { x: 0, y: 0 },
    rightGloveOffset: { x: 0, y: 0 },
    bodyOffset: { x: 0, y: 0 },
    bobPhase,
    bobSpeed: 2.6,
    baseBobSpeed: 2.6,
    defenseState: "none",
    preDuckBlockState: null,
    guardBlend: 0,
    isPunching: false,
    currentPunch: null,
    currentPunchStaminaCost: 0,
    punchProgress: 0,
    punchCooldown: 0,
    isHit: false,
    hitTimer: 0,
    critHitTimer: 0,
    regenPauseTimer: 0,
    moveSpeed: 120,
    punchSpeedMult: 1,
    damageMult: 1,
    powerBonusPct: 0,
    defenseMult: 1,
    staminaCostMult: 1,
    knockdowns: 0,
    punchesThrown: 0,
    punchesLanded: 0,
    damageDealt: 0,
    timeSinceLastLanded: 0,
    unansweredStreak: 0,
    momentumRegenBoost: 0,
    momentumRegenTimer: 0,
    isPlayer: false,
    isKnockedDown: false,
    knockdownTimer: 0,
    duckTimer: 0,
    duckHoldTime: 0,
    colors,
    isFeinting: false,
    isCharging: false,
    chargeTimer: 0,
    stance: "neutral",
    handsDown: false,
    halfGuardPunch: false,
    rhythmLevel: 2,
    rhythmProgress: 0,
    rhythmDirection: 1,
    punchPhase: null,
    punchPhaseTimer: 0,
    isRePunch: false,
    retractionProgress: 0,
    earlyRepunchPenaltyTimer: 0,
    staminaPenaltyPending: false,
    staminaPauseFromRhythm: 0,
    speedBoostTimer: 0,
    punchAimsHead: true,
    blockTimer: 0,
    maxBlockDuration: 20,
    blockRegenPenaltyTimer: 0,
    blockRegenPenaltyDuration: 0.25,
    punchingWhileBlocking: false,
    burstPunchCount: 0,
    burstPunchTimer: 1.5,
    duckHoldTimer: 0,
    duckDrainCooldown: 0,
    duckProgress: 0,
    backLegDrive: 0,
    frontLegDrive: 0,
    moveSlowMult: 1,
    moveSlowTimer: 0,
    stunBlockDisableTimer: 0,
    stunPunchDisableTimer: 0,
    stunPunchSlowMult: 1,
    stunPunchSlowTimer: 0,
    stunMoveFreezeTimer: 0,
    chargeCooldownTimer: 0,
    chargeReadyWindowTimer: 0,
    chargeReady: false,
    chargeArmed: false,
    chargeMeterCounters: 0,
    chargeMeterBars: 0,
    chargeEmpoweredTimer: 0,
    chargeMeterLockoutTimer: 0,
    chargeHoldTimer: 0,
    chargeFlashTimer: 0,
    chargeHeadOffset: 0,
    blockFlashTimer: 0,
    punchTravelStartTime: 0,
    stunBlockWeakenTimer: 0,
    chargeArmTimer: 0,
    consecutiveChargeTimer: 0,
    consecutiveChargeCount: 0,
    feintWhiffPenaltyCooldown: 0,
    retractionPenaltyMult: 1,
    armLength: 65,
    aiGuardDropTimer: 0,
    aiGuardDropCooldown: 0,
    telegraphPhase: "none",
    telegraphTimer: 0,
    telegraphDuration: 0,
    telegraphPunchType: null,
    telegraphIsFeint: false,
    telegraphIsCharged: false,
    telegraphRhythmPaused: false,
    telegraphIsLockout: false,
    postPunchLockoutTimer: 0,
    postPunchLockoutDuration: 0,
    fastTwitchRank: 0,
    pendingPunchInput: null,
    pendingPunchInputTimer: 0,
    pendingPunchCharged: false,
    pendingPunchBody: false,
    timeSinceLastPunch: 999,
    timeSinceGuardRaised: 999,
    blinkTimer: 5,
    blinkDuration: 0,
    isBlinking: false,
    blinkQueued: 0,
    blinkQueueTimer: 0,
    blinkQuietTimer: 0,
    flinchTimer: 0,
    flinchDuration: 0,
    flinchMag: 0,
    flinchDirY: 1,
    flinchReactions: 0,
    flinchNegateTimer: 0,
    flinchDuckSeen: false,
    feintFlinchCounts: {},
    shotsTakenHead: 0,
    shotsTakenBody: 0,
    feintTelegraphDisableTimer: 0,
    feintedTelegraphBoost: 0,
    telegraphKdMult: 1,
    telegraphRoundBonus: 0,
    telegraphFeintRoundPenalty: 0,
    telegraphSlowTimer: 0,
    telegraphSlowDuration: 0,
    telegraphRhythmBoost: 0,
    duckSpeedMult: 1,
    blockMult: 1,
    critResistMult: 1,
    ironChinStunResist: 0,
    ironChinDamageReduction: 0,
    stunFacingSlowTimer: 0,
    stunFacingTurnDelay: 0,
    ironChinStunSlowReduction: 0,
    critMult: 1,
    stunMult: 1,
    telegraphSpeedMult: 1,
    punchLaunchDamageMult: 1,
    rawPower: 0,
    rawSpeed: 0,
    cleanHitEyeTimer: 0,
    knockdownsGiven: 0,
    cleanPunchesLanded: 0,
    feintBaits: 0,
    timeSinceLastDamageTaken: 0,
    damageTakenRegenPauseFired: false,
    kdRegenBoostActive: false,
    guardDownTimer: 0,
    guardDownSpeedBoost: 0,
    guardDownBoostTimer: 0,
    guardDownBoostMax: 0,
    chargeUsesLeft: 0,
    chargeEmpoweredDuration: 0,
    handsDownTimer: 0,
    handsDownCooldown: 0,
    feintHoldTimer: 0,
    feintTouchingOpponent: false,
    feintDuckTouchingOpponent: false,
    autoGuardActive: false,
    autoGuardTimer: 0,
    autoGuardDuration: 0,
    lastSpacePressTime: 0,
    spaceWasUp: false,
    pressureDropTimer: 0,
    pdRecoveryActive: false,
    pdPrevX: RING_CX,
    pdPrevZ: RING_CY,
    swayPhase: 0,
    swayDir: 1 as 1 | -1,
    swayOffset: 0,
    swaySpeedLevel: 0,
    swayFrozen: false,
    swayZone: "neutral" as "power" | "offBalance" | "neutral",
    swayDamageMult: 1,
    swayTelegraphMult: 1,
    miniStunTimer: 0,
    rhythmPauseTimer: 0,
    pushbackVx: 0,
    pushbackVz: 0,
    focusT: 0,
    facingLockTimer: 0,
    facingTurnDelay: 0,
    facingPendingTimer: 0,
    turnDelayCancelled: false,
    turnDelayAdjust: 0,
    turnDelayZeroTimer: 0,
    rhythmHitFlashTimer: 0,
    perfectBlockActive: false,
    perfectBlockTimer: 0,
    perfectBlockFlashTimer: 0,
    perfectBlockState: "idle" as const,
    perfectBlockRiseTimer: 0,
    perfectBlockHoldTimer: 0,
    perfectBlockCooldownTimer: 0,
    turnPunchPenaltyActive: false,
    perfectBlockGloveYOffset: 0,
    perfectBlockKeyWasUp: false,
    slipActive: false,
    slipDir: "back" as const,
    slipTimer: 0,
    slipEnterDuration: 0,
    slipSwitchFrom: null,
    slipHoldTimer: 0,
    slipDisabledTimer: 0,
    slipChainTimer: 0,
    slipChainCount: 0,
    slipKeyWasUp: true,
    slipLean: 0,
    slipLeanStart: 0,
    slipLeanDir: "back" as const,
    slipDirAtPunch: null,
    slipPendingTimer: 0,
    slipPendingDir: null,
    slipReadAttemptTimer: 0,
    slipReadPunchId: -1,
    slipReadDelay: 0,
    slipReadHitsTaken: 0,
    punchInputUnread: false,
    defenseT: 0,
    speedT: 0,
    rawStamina: 100,
  };
}

export function renderFighterPreview(
  ctx: CanvasRenderingContext2D,
  canvasW: number,
  canvasH: number,
  colors: FighterColors,
  bobPhase: number,
  scale: number = 1,
  showHeadgear: boolean = false
): void {
  ctx.clearRect(0, 0, canvasW, canvasH);

  const savedYaw = currentCameraYaw;
  currentCameraYaw = 0;
  _previewHeadgear = showHeadgear;
  _stillPreview = true;

  const fighter = createPreviewFighterState(colors, bobPhase);
  const centerX = canvasW / 2;
  const centerZ = canvasH * 0.82 + (scale - 1) * canvasH * 0.04;
  fighter.x = RING_CX;
  fighter.z = RING_CY;

  const pt = projectToScreen(fighter.x, fighter.z);
  const offsetX = centerX - pt.sx;
  const offsetY = centerZ - pt.sy;

  const oppFighter = createPreviewFighterState(colors, 0);
  oppFighter.x = RING_CX;
  oppFighter.z = RING_CY - 100;
  const oppPt = projectToScreen(oppFighter.x, oppFighter.z);

  ctx.save();
  ctx.translate(centerX, centerZ);
  ctx.scale(scale, scale);
  ctx.translate(offsetX - centerX, offsetY - centerZ);

  try {
    drawFighterWithOutline(ctx, fighter, oppFighter, null as unknown as GameState, pt, oppPt);
  } finally {
    // Both are module-level: a throw here must not leave the in-fight renderer
    // stuck with the preview's headgear flag or camera yaw.
    ctx.restore();
    _previewHeadgear = false;
    _stillPreview = false;
    currentCameraYaw = savedYaw;
  }
}

export function renderFighterPunchFrame(
  ctx: CanvasRenderingContext2D,
  canvasW: number,
  canvasH: number,
  colors: FighterColors,
  punchType: string,
  punchProgress: number,
  bobPhase: number,
  scale: number = 1,
  punchParams?: {
    distanceMult: number;
    arcAmplitude: number;
    dropDepth: number;
    riseHeight: number;
    dropPhase: number;
  }
): void {
  ctx.clearRect(0, 0, canvasW, canvasH);
  _previewHeadgear = false;
  _stillPreview = true;

  // Keep yaw = 0, matching the actual in-ring camera at fight start
  const savedYaw = currentCameraYaw;
  currentCameraYaw = 0;

  // Fighter faces RIGHT (facingAngle = 0), matching the player's in-ring setup
  const fighter = createPreviewFighterState(colors, bobPhase);
  fighter.facingAngle = 0;
  if (punchType) {
    fighter.isPunching = true;
    fighter.currentPunch = punchType as FighterState["currentPunch"];
    fighter.punchProgress = Math.max(0, Math.min(1, punchProgress));
  }

  const centerX = canvasW / 2;
  const centerZ = canvasH * 0.72 + (scale - 1) * canvasH * 0.04;
  fighter.x = RING_CX;
  fighter.z = RING_CY;

  const pt = projectToScreen(fighter.x, fighter.z);
  const offsetX = centerX - pt.sx;
  const offsetY = centerZ - pt.sy;

  // Opponent far to the right along X → punchDirX > 0 → arm extends rightward
  const oppFighter = createPreviewFighterState(colors, 0);
  oppFighter.x = RING_CX + 220;
  oppFighter.z = RING_CY;
  const oppPt = projectToScreen(oppFighter.x, oppFighter.z);

  if (punchParams) {
    _previewParams = punchParams;
  }

  ctx.save();
  ctx.translate(centerX, centerZ);
  ctx.scale(scale, scale);
  ctx.translate(offsetX - centerX, offsetY - centerZ);

  try {
    drawFighterWithOutline(ctx, fighter, oppFighter, null as unknown as GameState, pt, oppPt);
  } finally {
    // All three are module-level: a throw here must not leave the in-fight
    // renderer drawing with the preview's params, flipped feet or camera yaw.
    ctx.restore();
    _previewParams = null;
    _stillPreview = false;
    currentCameraYaw = savedYaw;
  }
}

const TUTORIAL_CONTINUE_BTN_W = 160;
const TUTORIAL_CONTINUE_BTN_H = 36;
const TUTORIAL_CONTINUE_BTN_X = CANVAS_W / 2 - TUTORIAL_CONTINUE_BTN_W / 2;
const TUTORIAL_CONTINUE_BTN_Y = CANVAS_H / 2 + 60;

function drawTutorialPrompt(ctx: CanvasRenderingContext2D, state: GameState): void {
  const prompt = state.tutorialPrompt;
  if (!prompt) return;

  ctx.save();

  if (state.tutorialShowContinueButton) {
    ctx.fillStyle = "rgba(0, 0, 0, 0.7)";
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 16px 'Oxanium', sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    const maxW = CANVAS_W - 80;
    const words = prompt.split(" ");
    const lines: string[] = [];
    let currentLine = "";
    for (const word of words) {
      const test = currentLine ? currentLine + " " + word : word;
      if (ctx.measureText(test).width > maxW) {
        lines.push(currentLine);
        currentLine = word;
      } else {
        currentLine = test;
      }
    }
    if (currentLine) lines.push(currentLine);

    const lineH = 24;
    const startY = CANVAS_H / 2 - (lines.length * lineH) / 2;
    for (let i = 0; i < lines.length; i++) {
      ctx.fillText(lines[i], CANVAS_W / 2, startY + i * lineH);
    }

    ctx.fillStyle = "rgba(255, 200, 50, 0.9)";
    const bx = TUTORIAL_CONTINUE_BTN_X;
    const by = TUTORIAL_CONTINUE_BTN_Y;
    ctx.beginPath();
    ctx.roundRect(bx, by, TUTORIAL_CONTINUE_BTN_W, TUTORIAL_CONTINUE_BTN_H, 6);
    ctx.fill();

    ctx.fillStyle = "#000000";
    ctx.font = "bold 16px 'Oxanium', sans-serif";
    ctx.fillText("Continue", CANVAS_W / 2, by + TUTORIAL_CONTINUE_BTN_H / 2);
  } else {
    const maxTextW = CANVAS_W - 60;
    let fontSize = 20;
    ctx.font = `bold ${fontSize}px 'Oxanium', sans-serif`;
    if (ctx.measureText(prompt).width > maxTextW) {
      fontSize = 16;
      ctx.font = `bold ${fontSize}px 'Oxanium', sans-serif`;
    }
    if (ctx.measureText(prompt).width > maxTextW) {
      fontSize = 14;
      ctx.font = `bold ${fontSize}px 'Oxanium', sans-serif`;
    }

    const words = prompt.split(" ");
    const lines: string[] = [];
    let currentLine = "";
    for (const word of words) {
      const test = currentLine ? currentLine + " " + word : word;
      if (ctx.measureText(test).width > maxTextW) {
        if (currentLine) lines.push(currentLine);
        currentLine = word;
      } else {
        currentLine = test;
      }
    }
    if (currentLine) lines.push(currentLine);

    const lineH = fontSize + 6;
    const padV = 10;
    const bgH = lines.length * lineH + padV * 2;
    const bgY = 50;

    let bgW = 0;
    for (const line of lines) {
      const w = ctx.measureText(line).width;
      if (w > bgW) bgW = w;
    }
    bgW = Math.min(bgW + 40, CANVAS_W - 20);

    ctx.fillStyle = "rgba(0, 0, 0, 0.65)";
    ctx.beginPath();
    ctx.roundRect(CANVAS_W / 2 - bgW / 2, bgY, bgW, bgH, 8);
    ctx.fill();

    ctx.fillStyle = "#ffcc44";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const startY = bgY + padV + lineH / 2;
    for (let i = 0; i < lines.length; i++) {
      ctx.fillText(lines[i], CANVAS_W / 2, startY + i * lineH);
    }
  }

  // Stage 3 rhythm indicator visual hints
  if (state.tutorialStage === 3) {
    if (state.tutorialShowContinueButton && (state.tutorialStep === 3 || state.tutorialStep === 5)) {
      const drawRhythmDemo = (x: number, y: number, label: string, sublabel: string, widerGreen: boolean) => {
        const rW = 60;
        const rH = 8;
        const cx = x + rW / 2;
        ctx.fillStyle = "rgba(255,255,255,0.12)";
        ctx.beginPath();
        ctx.roundRect(x, y, rW, rH, 2);
        ctx.fill();
        const gFrac = widerGreen ? 0.36 : 0.22;
        const gX = x + rW * (0.5 - gFrac / 2);
        const gW = rW * gFrac;
        ctx.fillStyle = "rgba(80, 220, 80, 0.85)";
        ctx.beginPath();
        ctx.roundRect(gX, y, gW, rH, 2);
        ctx.fill();
        ctx.strokeStyle = "rgba(255,255,255,0.45)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.roundRect(x, y, rW, rH, 2);
        ctx.stroke();
        const pulse = (Math.sin(Date.now() / 260) + 1) / 2;
        ctx.strokeStyle = `rgba(80, 220, 80, ${0.45 + pulse * 0.5})`;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.roundRect(gX - 2, y - 2, gW + 4, rH + 4, 3);
        ctx.stroke();
        ctx.fillStyle = "rgba(255,220,80,0.95)";
        ctx.font = "bold 10px 'Oxanium', sans-serif";
        ctx.textAlign = "center";
        ctx.fillText(label, cx, y - 6);
        ctx.fillStyle = "rgba(180,180,180,0.85)";
        ctx.font = "9px 'Oxanium', sans-serif";
        ctx.fillText(sublabel, cx, y + rH + 12);
      };
      if (state.tutorialStep === 3) {
        drawRhythmDemo(30, CANVAS_H - 105, "YOUR RHYTHM", "Speed narrows green zone", false);
        ctx.fillStyle = "rgba(255,220,80,0.75)";
        ctx.font = "bold 11px 'Oxanium', sans-serif";
        ctx.textAlign = "left";
        ctx.fillText("↙ bottom-left in fight", 15, CANVAS_H - 55);
      } else {
        drawRhythmDemo(CANVAS_W - 100, CANVAS_H - 105, "ENEMY RHYTHM", "Focus widens green zone", true);
        ctx.fillStyle = "rgba(255,220,80,0.75)";
        ctx.font = "bold 11px 'Oxanium', sans-serif";
        ctx.textAlign = "right";
        ctx.fillText("bottom-right in fight ↘", CANVAS_W - 15, CANVAS_H - 55);
      }
    } else if (!state.tutorialShowContinueButton && state.tutorialStep === 6) {
      const eRhythmX = CANVAS_W - 15 - 50;
      const eRhythmCX = eRhythmX + 25;
      const rhY = (CANVAS_H - 70) + 15 + 42;
      const pulse = (Math.sin(Date.now() / 180) + 1) / 2;
      const alpha = 0.5 + pulse * 0.5;
      ctx.strokeStyle = `rgba(100, 255, 100, ${alpha})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.roundRect(eRhythmX - 3, rhY - 3, 56, 12, 3);
      ctx.stroke();
      ctx.fillStyle = `rgba(100, 255, 100, ${alpha})`;
      ctx.beginPath();
      ctx.moveTo(eRhythmCX, rhY - 6);
      ctx.lineTo(eRhythmCX - 8, rhY - 24);
      ctx.lineTo(eRhythmCX + 8, rhY - 24);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = "rgba(100, 255, 100, 0.9)";
      ctx.font = "bold 10px 'Oxanium', sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("Enemy Rhythm", eRhythmCX, rhY - 28);
    }
  }

  ctx.restore();
}

export function getTutorialContinueClick(x: number, y: number): boolean {
  return (
    x >= TUTORIAL_CONTINUE_BTN_X &&
    x <= TUTORIAL_CONTINUE_BTN_X + TUTORIAL_CONTINUE_BTN_W &&
    y >= TUTORIAL_CONTINUE_BTN_Y &&
    y <= TUTORIAL_CONTINUE_BTN_Y + TUTORIAL_CONTINUE_BTN_H
  );
}
