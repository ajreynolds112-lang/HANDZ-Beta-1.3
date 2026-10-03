/**
 * The one mapping between the engine's world (pixels on a flat x/z plane) and
 * the 3D scene (metres, y up). Every 3D module goes through here so the ring,
 * the fighters and anything added later all share one scale.
 *
 * Engine facts mirrored here (see engine.ts): the ring is a rhombus centred on
 * (RING_CX, RING_CY) with half-diagonals RING_HALF_W along x and RING_HALF_H
 * along z, and fighters are clamped inside it. Engine distances are isotropic
 * (sqrt(dx²+dz²) in px), so one scale serves both axes — stretching z to make
 * the ring look square would make a 100px gap look different by direction.
 */

export const ENGINE_RING_CX = 400;
export const ENGINE_RING_CY = 260;
export const ENGINE_RING_HALF_W = 280;
export const ENGINE_RING_HALF_H = 180;

/** Engine pixels per 3D unit (one unit = one metre). */
export const PX_PER_UNIT = 50;

/** Height of the canvas mat above the arena floor. */
export const MAT_HEIGHT = 1.0;

/** Rope heights above the mat, bottom to top. */
export const ROPE_HEIGHTS = [0.45, 0.85, 1.25] as const;
/** Corner post height above the mat. */
export const POST_HEIGHT = 1.45;

/** Ring half-diagonals in units. */
export const RING_HALF_X = ENGINE_RING_HALF_W / PX_PER_UNIT;
export const RING_HALF_Z = ENGINE_RING_HALF_H / PX_PER_UNIT;

/** Engine x (px) → scene x. */
export function toSceneX(px: number): number {
  return (px - ENGINE_RING_CX) / PX_PER_UNIT;
}

/** Engine z (px) → scene z. Larger engine z is nearer the default camera. */
export function toSceneZ(pz: number): number {
  return (pz - ENGINE_RING_CY) / PX_PER_UNIT;
}

/** An engine length (px) → scene units. */
export function toSceneLen(px: number): number {
  return px / PX_PER_UNIT;
}

/**
 * Engine facingAngle (atan2 over px dz/dx) → Object3D.rotation.y for a model
 * whose forward is +x. three rotates +x to (cos θ, 0, -sin θ), so negate.
 */
export function toSceneYaw(facingAngle: number): number {
  return -facingAngle;
}

/**
 * Ring corners in scene units, in the same order the 2D renderer uses:
 * 0 far (top), 1 right (enemy corner), 2 near (bottom), 3 left (player corner).
 */
export function ringCorners(extraX = 0, extraZ = 0): [number, number][] {
  const hx = RING_HALF_X + extraX;
  const hz = RING_HALF_Z + extraZ;
  return [
    [0, -hz],
    [hx, 0],
    [0, hz],
    [-hx, 0],
  ];
}
