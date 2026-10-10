/**
 * Leg collision. Each fighter's legs are modelled on the canvas plane as the
 * same stance the 3D body stands in (fighterPose reads its foot placement from
 * here): a capsule per leg from hip to ankle and one per foot from heel to toe,
 * plus the body circle the old minimum distance kept apart.
 *
 * Legs never push: once they touch, neither fighter can step toward the other,
 * and no movement may deepen the overlap. Moves that slide along the contact or
 * back away are kept.
 */
import type { FighterState } from "./types";

/** Engine px per metre (the 3D world mapping). */
const PX_PER_M = 50;

/** Orthodox stance foot placement, body space metres (x forward, z = fighter's right). */
export const STANCE_FEET_M = {
  lead: { x: 0.153, z: -0.094 },
  rear: { x: -0.17, z: 0.119 },
};
/** Full duck: feet this much wider side to side, and longer front to back, each (m). */
export const DUCK_FEET_WIDER_M = 0.068;
export const DUCK_FEET_LONGER_M = 0.0255;

const HIP_HALF_WIDTH_M = 0.09;
const HEEL_BACK_M = 0.07;
const TOE_FWD_M = 0.2;
const LEG_RADIUS_PX = 0.06 * PX_PER_M;
const FOOT_RADIUS_PX = 0.045 * PX_PER_M;

interface Capsule { ax: number; az: number; bx: number; bz: number; r: number }

export function legCapsules(f: FighterState, x = f.x, z = f.z): Capsule[] {
  const a = f.facingAngle ?? (f.facing === 1 ? 0 : Math.PI);
  const fx = Math.cos(a), fz = Math.sin(a);   // forward
  const rx = -Math.sin(a), rz = Math.cos(a);  // fighter's right
  const toWorld = (bx: number, bz: number): [number, number] =>
    [x + (bx * fx + bz * rx) * PX_PER_M, z + (bx * fz + bz * rz) * PX_PER_M];
  const dp = Math.max(0, Math.min(1, f.duckProgress || 0));
  const wide = DUCK_FEET_WIDER_M * dp, long = DUCK_FEET_LONGER_M * dp;
  const south = f.boxingStance === "southpaw";
  const out: Capsule[] = [];
  for (const lead of [true, false]) {
    const base = lead ? STANCE_FEET_M.lead : STANCE_FEET_M.rear;
    let ax = lead ? base.x + long : base.x - long;
    let az = lead ? base.z - wide : base.z + wide;
    ax += lead ? -0.1 * (f.frontLegDrive || 0) : 0.12 * (f.backLegDrive || 0);
    // Toe: lead points at the opponent turned in a hair, rear ~45° out.
    let tx = lead ? 1 : 0.75, tz = lead ? 0.2 : -0.66;
    if (south) { az = -az; tz = -tz; }
    const tl = Math.hypot(tx, tz); tx /= tl; tz /= tl;
    const hipZ = (az < 0 ? -1 : 1) * HIP_HALF_WIDTH_M;
    const [hx, hz] = toWorld(0, hipZ);
    const [kx, kz] = toWorld(ax, az);
    const [heX, heZ] = toWorld(ax - tx * HEEL_BACK_M, az - tz * HEEL_BACK_M);
    const [toX, toZ] = toWorld(ax + tx * TOE_FWD_M, az + tz * TOE_FWD_M);
    out.push({ ax: hx, az: hz, bx: kx, bz: kz, r: LEG_RADIUS_PX });
    out.push({ ax: heX, az: heZ, bx: toX, bz: toZ, r: FOOT_RADIUS_PX });
  }
  return out;
}

function pointSegDist(px: number, pz: number, c: Capsule): number {
  const dx = c.bx - c.ax, dz = c.bz - c.az;
  const l2 = dx * dx + dz * dz;
  const t = l2 > 1e-9 ? Math.max(0, Math.min(1, ((px - c.ax) * dx + (pz - c.az) * dz) / l2)) : 0;
  return Math.hypot(px - (c.ax + t * dx), pz - (c.az + t * dz));
}

function cross(ax: number, az: number, bx: number, bz: number, cx: number, cz: number): number {
  return (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
}

/** Signed gap between two segments: negative (endpoint depth) once they cross. */
function segGap(p: Capsule, q: Capsule): number {
  const d = Math.min(
    pointSegDist(p.ax, p.az, q), pointSegDist(p.bx, p.bz, q),
    pointSegDist(q.ax, q.az, p), pointSegDist(q.bx, q.bz, p),
  );
  const d1 = cross(q.ax, q.az, q.bx, q.bz, p.ax, p.az), d2 = cross(q.ax, q.az, q.bx, q.bz, p.bx, p.bz);
  const d3 = cross(p.ax, p.az, p.bx, p.bz, q.ax, q.az), d4 = cross(p.ax, p.az, p.bx, p.bz, q.bx, q.bz);
  const crossing = ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
  return crossing ? -d : d;
}

/** Total overlap (px) between the two fighters' legs and bodies at these positions. */
export function legOverlap(a: FighterState, ax: number, az: number, b: FighterState, bx: number, bz: number, minBodyDist: number): number {
  const ca = legCapsules(a, ax, az), cb = legCapsules(b, bx, bz);
  let pen = Math.max(0, minBodyDist - Math.hypot(ax - bx, az - bz));
  for (const p of ca) for (const q of cb) pen += Math.max(0, p.r + q.r - segGap(p, q));
  return pen;
}

/** Contact counts from this close, so a fighter resting against the other is "touching". */
const CONTACT_EPS = 0.5;
const PEN_EPS = 1e-4;

/**
 * Applies the leg rule to this tick's movement. `pa`/`pb` are each fighter's
 * position at the start of the tick; the current positions are what the tick
 * moved them to. Facing, stance and crouch are taken as they are now, so a turn
 * or a duck never counts as a step into the other fighter.
 */
export function resolveLegCollision(
  a: FighterState, pax: number, paz: number,
  b: FighterState, pbx: number, pbz: number,
  minBodyDist: number,
): void {
  if (a.isKnockedDown || b.isKnockedDown) return;
  const base = legOverlap(a, pax, paz, b, pbx, pbz, minBodyDist);
  // Touching = overlapping, or close enough that a hair more would be.
  const touching = base > 0 || touchAt(a, pax, paz, b, pbx, pbz, minBodyDist);

  // Each judged against where the other started, then both together.
  const [nax, naz] = limitMove(a, pax, paz, b, pbx, pbz, true, base, touching, minBodyDist);
  const [nbx, nbz] = limitMove(b, pbx, pbz, a, pax, paz, false, base, touching, minBodyDist);
  let s = 1;
  if (legOverlap(a, nax, naz, b, nbx, nbz, minBodyDist) > base + PEN_EPS) {
    let lo = 0, hi = 1;
    for (let i = 0; i < 12; i++) {
      const m = (lo + hi) / 2;
      const ok = legOverlap(a, pax + (nax - pax) * m, paz + (naz - paz) * m, b, pbx + (nbx - pbx) * m, pbz + (nbz - pbz) * m, minBodyDist) <= base + PEN_EPS;
      if (ok) lo = m; else hi = m;
    }
    s = lo;
  }
  // Leftover slivers from the search would read as a twitch on screen: a
  // fighter either moves a real amount or stays exactly where it was.
  const settle = (f: FighterState, px: number, pz: number, nx: number, nz: number, moved: boolean) => {
    if (!moved || Math.hypot(nx - px, nz - pz) >= MIN_STEP_PX) { f.x = nx; f.z = nz; }
    else { f.x = px; f.z = pz; }
  };
  const aCut = nax !== a.x || naz !== a.z || s < 1;
  const bCut = nbx !== b.x || nbz !== b.z || s < 1;
  settle(a, pax, paz, pax + (nax - pax) * s, paz + (naz - paz) * s, aCut);
  settle(b, pbx, pbz, pbx + (nbx - pbx) * s, pbz + (nbz - pbz) * s, bCut);
}

/** A cut-back move shorter than this is dropped rather than taken. */
const MIN_STEP_PX = 0.1;

/** Legs (or bodies) touching where the fighters stand now. */
export function legsTouching(a: FighterState, b: FighterState, minBodyDist: number): boolean {
  return touchAt(a, a.x, a.z, b, b.x, b.z, minBodyDist);
}

/** Any leg capsule pair within CONTACT_EPS of touching. */
function touchAt(a: FighterState, ax: number, az: number, b: FighterState, bx: number, bz: number, minBodyDist: number): boolean {
  if (Math.hypot(ax - bx, az - bz) <= minBodyDist + CONTACT_EPS) return true;
  const ca = legCapsules(a, ax, az), cb = legCapsules(b, bx, bz);
  for (const p of ca) for (const q of cb) if (segGap(p, q) <= p.r + q.r + CONTACT_EPS) return true;
  return false;
}

/** One fighter's move from (sx, sz) to where it stands now, cut back against the other standing at (ox, oz). */
function limitMove(
  self: FighterState, sx: number, sz: number, opp: FighterState, ox: number, oz: number,
  isA: boolean, base: number, touching: boolean, minBodyDist: number,
): [number, number] {
  let dx = self.x - sx, dz = self.z - sz;
  if (Math.abs(dx) < 1e-9 && Math.abs(dz) < 1e-9) return [sx, sz];
  // Touching: no step toward the other fighter at all.
  if (touching) {
    const tx = ox - sx, tz = oz - sz, tl = Math.hypot(tx, tz);
    if (tl > 0.01) {
      const along = (dx * tx + dz * tz) / tl;
      if (along > 0) { dx -= along * tx / tl; dz -= along * tz / tl; }
    }
  }
  const pen = (x: number, z: number) => isA
    ? legOverlap(self, x, z, opp, ox, oz, minBodyDist)
    : legOverlap(opp, ox, oz, self, x, z, minBodyDist);
  if (pen(sx + dx, sz + dz) <= base + PEN_EPS) return [sx + dx, sz + dz];
  // Slide along the contact: drop the part of the move that digs in.
  const h = 0.25;
  const gx = (pen(sx + h, sz) - pen(sx - h, sz)) / (2 * h);
  const gz = (pen(sx, sz + h) - pen(sx, sz - h)) / (2 * h);
  const gl = Math.hypot(gx, gz);
  if (gl > 1e-6) {
    const into = (dx * gx + dz * gz) / gl;
    if (into > 0) {
      const sdx = dx - into * gx / gl, sdz = dz - into * gz / gl;
      if (pen(sx + sdx, sz + sdz) <= base + PEN_EPS) return [sx + sdx, sz + sdz];
      dx = sdx; dz = sdz;
    }
  }
  // Otherwise as far along it as stays clear.
  let lo = 0, hi = 1;
  for (let i = 0; i < 12; i++) {
    const m = (lo + hi) / 2;
    if (pen(sx + dx * m, sz + dz * m) <= base + PEN_EPS) lo = m; else hi = m;
  }
  return [sx + dx * lo, sz + dz * lo];
}


/**
 * Limits a single fighter's move made outside the main movement pass (the
 * body-shot step) against the opponent where it stands, so code that tracks
 * the ground it actually covered stays honest.
 */
export function limitSoloMove(self: FighterState, sx: number, sz: number, opp: FighterState, minBodyDist: number): void {
  if (self.isKnockedDown || opp.isKnockedDown) return;
  const base = legOverlap(self, sx, sz, opp, opp.x, opp.z, minBodyDist);
  const touching = base > 0 || touchAt(self, sx, sz, opp, opp.x, opp.z, minBodyDist);
  const [nx, nz] = limitMove(self, sx, sz, opp, opp.x, opp.z, true, base, touching, minBodyDist);
  if (nx !== self.x || nz !== self.z) {
    const keep = Math.hypot(nx - sx, nz - sz) >= MIN_STEP_PX;
    self.x = keep ? nx : sx; self.z = keep ? nz : sz;
  }
}
