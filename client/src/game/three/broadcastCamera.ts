/**
 * Broadcast fight camera: the 2D renderer's camera behaviour ported to a
 * perspective camera orbiting the ring.
 *
 * Same inputs, same constants, same per-frame lerps as renderer.ts:
 *  - yaw tracks where the action is relative to ring centre, clamped to
 *    ±CAM_YAW_MAX — here it orbits the camera instead of rotating the plane;
 *  - auto-zoom 1..3 from fighter separation (min during the countdown) — here
 *    it dollies the camera in instead of scaling the canvas;
 *  - the look-at point follows the fighters' midpoint with the same delayed lerp;
 *  - `staticCamera` pins all of it; shake becomes a camera offset.
 *
 * Reads GameState only. Its state lives on the instance, never on the fight.
 */
import * as THREE from "three";
import type { GameState } from "../types";
import {
  ENGINE_RING_CX, ENGINE_RING_CY, ENGINE_RING_HALF_W, ENGINE_RING_HALF_H,
  MAT_HEIGHT, RING_HALF_X, RING_HALF_Z, toSceneX, toSceneZ,
} from "./worldMapping";

// Mirrors renderer.ts — keep these in step with the 2D camera.
const CAM_YAW_MAX = 0.55;
const CAM_YAW_LERP = 0.04;
const AUTO_ZOOM_MIN = 1.0;
const AUTO_ZOOM_MAX = 3.0;
const AUTO_ZOOM_LERP = 0.04;
const AUTO_ZOOM_DIST_MIN = 40;
const AUTO_ZOOM_DIST_MAX = 350;
const CAMERA_POS_LERP = 0.055;

/** Vertical field of view; the frame is always 4:3 like the 2D canvas. */
export const CAMERA_FOV = 35;
export const CAMERA_ASPECT = 4 / 3;
/** Distance at zoom 1: frames the whole ring with a small margin. */
const BASE_DISTANCE = 14.2;
/** Elevation: high and wide when zoomed out, lower and closer when in. */
const PITCH_WIDE = THREE.MathUtils.degToRad(30);
const PITCH_CLOSE = THREE.MathUtils.degToRad(18);
/** The look-at point sits at chest height, like the 2D camera's Y bias. */
const LOOK_HEIGHT = 0.95;
/** Screen height of the 2D canvas, for converting shake px into units. */
const SCREEN_H = 600;
/** Knockdown shot: low and close on the downed fighter. */
const KD_DISTANCE = 3.4;
const KD_CAM_HEIGHT = 0.75;
const KD_LOOK_HEIGHT = 0.3;
const KD_SWING = 0.55;
const KD_MIN_DISTANCE = 2.0;
const KD_BODY_OFFSET_PX = 30;
const UP_AXIS = new THREE.Vector3(0, 1, 0);

export class BroadcastCamera {
  readonly camera = new THREE.PerspectiveCamera(CAMERA_FOV, CAMERA_ASPECT, 0.1, 200);
  private yaw = 0;
  private zoom = AUTO_ZOOM_MIN;
  private focusX = 0;
  private focusZ = 0;
  private resetEpoch = -1;
  private kdBlend = 0;
  private kdX = 0;
  private kdZ = 0;
  private kickAmt = 0;
  /** Which way the knockdown shot swings (chosen once per knockdown). */
  private kdSide = 0;
  private lastS = -1;

  /** Snap back to the wide centred shot (new fight, restart). */
  reset(): void {
    this.zoom = AUTO_ZOOM_MIN;
    this.focusX = 0;
    this.focusZ = 0;
    this.kdBlend = 0;
    this.kickAmt = 0;
  }

  update(state: GameState, resetEpoch: number): void {
    if (resetEpoch !== this.resetEpoch) {
      this.resetEpoch = resetEpoch;
      this.reset();
    }

    const p = state.player;
    const e = state.enemy;

    if (state.staticCamera) {
      this.yaw = 0;
      this.zoom = AUTO_ZOOM_MIN;
      this.focusX = 0;
      this.focusZ = 0;
    } else {
      const midX = (p.x + e.x) / 2;
      const midZ = (p.z + e.z) / 2;
      const offsetX = midX - ENGINE_RING_CX;
      const offsetZ = midZ - ENGINE_RING_CY;
      const rawYaw = (offsetX / (ENGINE_RING_HALF_W + 1)) * CAM_YAW_MAX * 0.85
                   + (offsetZ / (ENGINE_RING_HALF_H + 1)) * CAM_YAW_MAX * 0.35;
      const clampedYaw = Math.max(-CAM_YAW_MAX, Math.min(CAM_YAW_MAX, rawYaw));
      if (!isFinite(this.yaw)) this.yaw = clampedYaw;
      this.yaw += (clampedYaw - this.yaw) * CAM_YAW_LERP;

      if (state.countdownTimer > 0) {
        this.zoom = AUTO_ZOOM_MIN;
      } else {
        const dx = p.x - e.x;
        const dz = p.z - e.z;
        const dist = Math.sqrt(dx * dx + dz * dz);
        const t = Math.max(0, Math.min(1, (dist - AUTO_ZOOM_DIST_MIN) / (AUTO_ZOOM_DIST_MAX - AUTO_ZOOM_DIST_MIN)));
        const rawZoom = AUTO_ZOOM_MAX + (AUTO_ZOOM_MIN - AUTO_ZOOM_MAX) * t;
        const targetZoom = Math.max(AUTO_ZOOM_MIN, rawZoom * 0.8);
        this.zoom += (targetZoom - this.zoom) * AUTO_ZOOM_LERP;
        this.zoom = Math.max(AUTO_ZOOM_MIN, Math.min(AUTO_ZOOM_MAX, this.zoom));
      }

      const tx = toSceneX(midX);
      const tz = toSceneZ(midZ);
      this.focusX += (tx - this.focusX) * CAMERA_POS_LERP;
      this.focusZ += (tz - this.focusZ) * CAMERA_POS_LERP;
    }

    const zoomT = (this.zoom - AUTO_ZOOM_MIN) / (AUTO_ZOOM_MAX * 0.8 - AUTO_ZOOM_MIN);
    const pitch = THREE.MathUtils.lerp(PITCH_WIDE, PITCH_CLOSE, THREE.MathUtils.clamp(zoomT, 0, 1));
    const distance = BASE_DISTANCE / this.zoom;
    const target = new THREE.Vector3(this.focusX, MAT_HEIGHT + LOOK_HEIGHT, this.focusZ);
    // From the target back to the camera. With this orbit the camera's screen-
    // right axis is (cos yaw, 0, sin yaw), exactly the 2D renderer's rotateY.
    const horiz = Math.cos(pitch) * distance;
    const pos = new THREE.Vector3(
      target.x - Math.sin(this.yaw) * horiz,
      target.y + Math.sin(pitch) * distance,
      target.z + Math.cos(this.yaw) * horiz,
    );

    if (state.shakeIntensity > 0 && state.shakeTimer > 0 && !state.isPaused && !state.staticCamera) {
      // Same random jitter as the 2D canvas translate, in screen pixels, turned
      // into units at the focus distance so a shake reads the same size.
      const unitsPerPx = (2 * distance * Math.tan(THREE.MathUtils.degToRad(CAMERA_FOV / 2))) / SCREEN_H;
      const sx = (Math.random() - 0.5) * state.shakeIntensity * 2 * unitsPerPx;
      const sy = (Math.random() - 0.5) * state.shakeIntensity * 2 * unitsPerPx;
      const right = new THREE.Vector3(Math.cos(this.yaw), 0, Math.sin(this.yaw));
      const offset = right.multiplyScalar(sx).add(new THREE.Vector3(0, -sy, 0));
      pos.add(offset);
      target.add(offset);
    }

    // Knockdown shot: a low, close angle on the fighter on the canvas while the
    // knockdown (or a KO) lasts, blending back to the broadcast camera after.
    const down = p.isKnockedDown ? p : e.isKnockedDown ? e : null;
    const kdOn = !!down && !state.staticCamera && (state.knockdownActive || state.phase === "fightEnd");
    if (down) {
      // Aim at the body, not the feet: a fall lays the body out behind where it faced.
      this.kdX = down.x - Math.cos(down.facingAngle) * KD_BODY_OFFSET_PX;
      this.kdZ = down.z - Math.sin(down.facingAngle) * KD_BODY_OFFSET_PX;
    }
    // Fast in (a cut on the fall), gentle out.
    const nowS = performance.now() / 1000;
    const dtS = this.lastS < 0 ? 1 / 60 : Math.min(0.25, Math.max(0, nowS - this.lastS));
    this.lastS = nowS;
    // Per-frame rates of 0.12 (in) / 0.045 (out) at 60 fps, made frame-rate independent.
    const rate = kdOn ? 0.12 : 0.045;
    this.kdBlend += ((kdOn ? 1 : 0) - this.kdBlend) * (1 - Math.pow(1 - rate, dtS * 60));
    if (this.kdBlend < 0.001) this.kdBlend = 0;
    if (!kdOn && this.kdBlend === 0) this.kdSide = 0;
    if (this.kdBlend > 0) {
      const k = this.kdBlend * this.kdBlend * (3 - 2 * this.kdBlend);
      const dx = toSceneX(this.kdX), dz = toSceneZ(this.kdZ);
      const kdTarget = new THREE.Vector3(dx, MAT_HEIGHT + KD_LOOK_HEIGHT, dz);
      // From the broadcast side, pulled toward the ring centre and swung round so
      // the body is seen across the canvas; kept inside the ropes.
      const dir = new THREE.Vector3(-Math.sin(this.yaw), 0, Math.cos(this.yaw));
      const toC = new THREE.Vector3(-dx, 0, -dz);
      if (toC.lengthSq() > 0.25) dir.addScaledVector(toC.normalize(), 1.2);
      dir.normalize();
      // Swing to whichever side keeps the standing fighter out of the shot.
      const stand = down === p ? e : p;
      const toStand = new THREE.Vector3(toSceneX(stand.x) - dx, 0, toSceneZ(stand.z) - dz);
      const left = dir.clone().applyAxisAngle(UP_AXIS, KD_SWING);
      const right = dir.clone().applyAxisAngle(UP_AXIS, -KD_SWING);
      if (this.kdSide === 0) this.kdSide = left.dot(toStand) < right.dot(toStand) ? 1 : -1;
      dir.copy(this.kdSide > 0 ? left : right);
      // The ring is a rhombus (|x|/hx + |z|/hz ≤ 1); shorten the shot until the
      // camera is inside the ropes, else pull it toward the centre.
      const hx = RING_HALF_X - 0.6, hz = RING_HALF_Z - 0.4;
      const inside = (x: number, z: number) => Math.abs(x) / hx + Math.abs(z) / hz;
      let d = KD_DISTANCE;
      while (d > KD_MIN_DISTANCE && inside(dx + dir.x * d, dz + dir.z * d) > 1) d -= 0.1;
      const kdPos = new THREE.Vector3(dx, MAT_HEIGHT + KD_CAM_HEIGHT, dz).addScaledVector(dir, d);
      const out = inside(kdPos.x, kdPos.z);
      if (out > 1) { kdPos.x /= out; kdPos.z /= out; }
      pos.lerp(kdPos, k);
      target.lerp(kdTarget, k);
    }

    // Render-side kick for big shots (crits): a short decaying jolt.
    if (this.kickAmt > 0.001 && !state.isPaused && !state.staticCamera) {
      const j = this.kickAmt * 0.06;
      const off = new THREE.Vector3((Math.random() - 0.5) * j, (Math.random() - 0.5) * j, (Math.random() - 0.5) * j);
      pos.add(off);
      target.addScaledVector(off, 0.5);
      this.kickAmt *= 0.86;
    } else if (state.isPaused) {
      // hold
    } else this.kickAmt = 0;

    this.camera.position.copy(pos);
    this.camera.lookAt(target);
    this.camera.updateMatrixWorld();
  }

  /** Request a big-shot jolt (1 = a crit). */
  kick(amount: number): void { this.kickAmt = Math.max(this.kickAmt, amount); }

  /** 0..1 how far the knockdown shot has taken over (for tests/HUD). */
  get knockdownBlend(): number { return this.kdBlend; }
}
