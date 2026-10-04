/**
 * Fight effects in the 3D view, all spawned from state the engine already keeps:
 *
 *  - hit effects: every new entry in state.hitEffects (the same list the 2D
 *    renderer draws) spawns effects (only a crit flashes, in red); a landed stun or crit also
 *    throws a sweat spray away from the attacker. Perfect blocks spark on the guard without
 *    sweat; feints get a small pale puff where the feinted glove stopped;
 *  - the towel: on a towel stoppage, a white towel tumbles from the corner
 *    (towelStart) to the fighters (towelEnd) on the stoppage timer.
 *
 * The 2D hit text still draws on the HUD layer. Read-only on GameState: the
 * only memory is which effect objects have already been spawned.
 */
import * as THREE from "three";
import type { GameState, HitEffect } from "../types";
import { MAT_HEIGHT, toSceneX, toSceneZ } from "./worldMapping";

const MAX_PARTICLES = 480;
const MAX_FLASHES = 12;
const GRAVITY = 9.0;

interface Flash { sprite: THREE.Sprite; life: number; max: number; size: number }

/** A target the hit can be attached to: the head position and the fighter's floor point. */
export interface EffectFighter { x: number; z: number; head: THREE.Vector3 }

export class FightEffects3D {
  readonly group = new THREE.Group();
  private seen = new WeakSet<HitEffect>();
  private pos = new Float32Array(MAX_PARTICLES * 3);
  private col = new Float32Array(MAX_PARTICLES * 3);
  private base = new Float32Array(MAX_PARTICLES * 3);
  private vel = new Float32Array(MAX_PARTICLES * 3);
  private life = new Float32Array(MAX_PARTICLES);
  private maxLife = new Float32Array(MAX_PARTICLES);
  private next = 0;
  private points: THREE.Points;
  private flashes: Flash[] = [];
  private flashNext = 0;
  private flashTex: THREE.Texture | null;
  private towel: THREE.Mesh;
  private towelSpin = new THREE.Vector3(1, 0.4, 0.2).normalize();
  private lastT = -1;
  private _v = new THREE.Vector3();
  /** Big-shot camera kick requested this frame (consumed by the scene). */
  kick = 0;

  constructor() {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(this.pos, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(this.col, 3));
    for (let i = 0; i < MAX_PARTICLES; i++) this.pos[i * 3 + 1] = -100;
    this.points = new THREE.Points(geo, new THREE.PointsMaterial({
      size: 0.045, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    this.points.frustumCulled = false;
    this.group.add(this.points);

    this.flashTex = radialTexture();
    for (let i = 0; i < MAX_FLASHES; i++) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({
        map: this.flashTex, color: "#ffffff", transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending,
      }));
      s.visible = false;
      this.group.add(s);
      this.flashes.push({ sprite: s, life: 0, max: 1, size: 1 });
    }

    // Towel: a sagging square of cloth.
    const tg = new THREE.PlaneGeometry(0.55, 0.55, 6, 6);
    const p = tg.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i);
      p.setZ(i, -0.25 * (x * x + y * y) + 0.04 * Math.sin(x * 14));
    }
    tg.computeVertexNormals();
    this.towel = new THREE.Mesh(tg, new THREE.MeshStandardMaterial({ color: "#f4f4f0", roughness: 0.95, side: THREE.DoubleSide }));
    this.towel.castShadow = true;
    this.towel.visible = false;
    this.group.add(this.towel);
  }

  /**
   * `fighters` are the two main corners (player first). Spawns for unseen hit
   * effects, advances particles, places the towel.
   */
  update(state: GameState, fighters: EffectFighter[]): void {
    const now = performance.now() / 1000;
    const dt = this.lastT < 0 ? 1 / 60 : Math.min(0.1, now - this.lastT);
    this.lastT = now;
    this.kick = 0;
    for (const e of state.hitEffects ?? []) {
      if (this.seen.has(e)) continue;
      this.seen.add(e);
      this.spawn(e, fighters);
    }
    if (!state.isPaused) this.step(dt);
    this.updateTowel(state);
  }

  private spawn(e: HitEffect, fighters: EffectFighter[]): void {
    // Hit effects sit at (x, z − 25); find which corner it belongs to.
    const ex = e.x, ez = e.y + 25;
    let best = 0, bestD = Infinity;
    fighters.forEach((f, i) => {
      const d = (f.x - ex) ** 2 + (f.z - ez) ** 2;
      if (d < bestD) { bestD = d; best = i; }
    });
    const near = fighters[best];
    const other = fighters[1 - best] ?? near;
    if (!near) return;
    // Direction from the other fighter toward this one (the punch's travel).
    const dir = this._v.set(toSceneX(near.x) - toSceneX(other.x), 0, toSceneZ(near.z) - toSceneZ(other.z));
    if (dir.lengthSq() < 1e-6) dir.set(1, 0, 0);
    dir.normalize();

    if (e.type === "feint") {
      // The feint effect is placed ahead of the attacker (near), along its facing.
      const at = new THREE.Vector3(toSceneX(ex), near.head.y - 0.25, toSceneZ(ez));
      this.flash(at, "#b8b0ff", 0.35, 0.22);
      this.spray(at, dir.clone().negate(), 6, 0.9, [0.55, 0.5, 0.9], 0.3);
      return;
    }
    const head = near.head;
    const at = new THREE.Vector3().copy(head).addScaledVector(dir, -0.12);
    if (e.type === "block" || e.type === "perfectBlock") {
      // On the guard, in front of the face.
      at.addScaledVector(dir, -0.12).y -= 0.08;
      const pb = e.type === "perfectBlock";
      if (pb) this.spray(at, dir.clone().negate(), 14, 1.6, [0.5, 0.85, 1], 0.35);
      return;
    }
    const crit = e.type === "crit";
    // No land flash on ordinary hits; only a crit keeps its red flash.
    if (crit) this.flash(at, "#ff5a3a", 1.15, 0.3);
    // Sweat flies off the far side, away from the punch, only on a stun or crit.
    if (e.stunOrCrit) this.spray(head, dir, crit ? 70 : 32, crit ? 3.4 : 2.4, [0.75, 0.88, 1], crit ? 0.75 : 0.55);
    if (crit) this.kick = Math.max(this.kick, 1);
  }

  private flash(at: THREE.Vector3, color: string, size: number, life: number): void {
    const f = this.flashes[this.flashNext];
    this.flashNext = (this.flashNext + 1) % MAX_FLASHES;
    f.sprite.position.copy(at);
    (f.sprite.material as THREE.SpriteMaterial).color.set(color);
    f.life = life; f.max = life; f.size = size;
    f.sprite.visible = true;
  }

  private spray(at: THREE.Vector3, dir: THREE.Vector3, n: number, speed: number, rgb: [number, number, number], life: number): void {
    for (let k = 0; k < n; k++) {
      const i = this.next;
      this.next = (this.next + 1) % MAX_PARTICLES;
      const s = speed * (0.4 + Math.random() * 0.8);
      // Cone around dir, biased upward.
      const vx = dir.x + (Math.random() - 0.5) * 1.1;
      const vy = 0.35 + Math.random() * 0.9;
      const vz = dir.z + (Math.random() - 0.5) * 1.1;
      const l = Math.hypot(vx, vy, vz) || 1;
      this.vel[i * 3] = (vx / l) * s; this.vel[i * 3 + 1] = (vy / l) * s; this.vel[i * 3 + 2] = (vz / l) * s;
      this.pos[i * 3] = at.x + (Math.random() - 0.5) * 0.08;
      this.pos[i * 3 + 1] = at.y + (Math.random() - 0.5) * 0.08;
      this.pos[i * 3 + 2] = at.z + (Math.random() - 0.5) * 0.08;
      const b = 0.7 + Math.random() * 0.3;
      this.base[i * 3] = rgb[0] * b; this.base[i * 3 + 1] = rgb[1] * b; this.base[i * 3 + 2] = rgb[2] * b;
      this.life[i] = this.maxLife[i] = life * (0.6 + Math.random() * 0.6);
    }
  }

  private step(dt: number): void {
    const floor = MAT_HEIGHT + 0.01;
    for (let i = 0; i < MAX_PARTICLES; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt;
      const j = i * 3;
      if (this.life[i] <= 0) { this.pos[j + 1] = -100; this.col[j] = this.col[j + 1] = this.col[j + 2] = 0; continue; }
      this.vel[j + 1] -= GRAVITY * dt;
      this.pos[j] += this.vel[j] * dt;
      this.pos[j + 1] = Math.max(floor, this.pos[j + 1] + this.vel[j + 1] * dt);
      this.pos[j + 2] += this.vel[j + 2] * dt;
      const a = this.life[i] / this.maxLife[i];
      this.col[j] = this.base[j] * a; this.col[j + 1] = this.base[j + 1] * a; this.col[j + 2] = this.base[j + 2] * a;
    }
    const g = this.points.geometry;
    (g.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (g.attributes.color as THREE.BufferAttribute).needsUpdate = true;
    for (const f of this.flashes) {
      if (!f.sprite.visible) continue;
      f.life -= dt;
      if (f.life <= 0) { f.sprite.visible = false; continue; }
      const t = 1 - f.life / f.max;
      f.sprite.scale.setScalar(f.size * (0.45 + 0.75 * Math.sqrt(t)));
      (f.sprite.material as THREE.SpriteMaterial).opacity = (1 - t) * (1 - t);
    }
  }

  private updateTowel(state: GameState): void {
    if (!state.towelActive) { this.towel.visible = false; return; }
    // The engine arms towelTimer at 1 but only refStoppageTimer (1 → 0) runs
    // during the stoppage; take whichever has advanced further.
    const run = state.refStoppageActive ? 1 - state.refStoppageTimer : 1;
    const p = Math.max(0, Math.min(1, Math.max(1 - state.towelTimer, run)));
    const sx = toSceneX(state.towelStartX), sz = toSceneZ(state.towelStartY);
    const ex = toSceneX(state.towelEndX), ez = toSceneZ(state.towelEndY);
    // Thrown from the corner at shoulder height, arcing up and landing on the canvas.
    const startY = MAT_HEIGHT + 1.7, endY = MAT_HEIGHT + 0.03;
    const y = startY + (endY - startY) * p + 4 * 1.4 * p * (1 - p);
    this.towel.visible = true;
    this.towel.position.set(sx + (ex - sx) * p, y, sz + (ez - sz) * p);
    if (p < 1) {
      this.towel.quaternion.setFromAxisAngle(this.towelSpin, p * Math.PI * 3.2);
    } else {
      // Landed: lies flat on the mat.
      this.towel.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
    }
  }

  dispose(): void {
    this.points.geometry.dispose();
    (this.points.material as THREE.Material).dispose();
    for (const f of this.flashes) (f.sprite.material as THREE.Material).dispose();
    this.flashTex?.dispose();
    this.towel.geometry.dispose();
    (this.towel.material as THREE.Material).dispose();
  }
}

function radialTexture(): THREE.Texture | null {
  if (typeof document === "undefined") return null;
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const ctx = c.getContext("2d");
  if (!ctx) return null;
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.25, "rgba(255,255,255,0.8)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}
