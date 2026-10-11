/**
 * Career gym in 3D: where everything stands, which box each click target is,
 * and the fixed home-screen camera with its project / pick helpers.
 *
 * Pure data + maths (no scene objects), shared by the gym environment, the
 * WebGL scene and GymView's hover/click and DOM tag placement, so a click
 * target and the prop it names can never drift apart. Scene units are metres,
 * ring centre at the origin, 50 engine px = 1 m (worldMapping).
 */
import * as THREE from "three";
import { MAT_HEIGHT, PX_PER_UNIT, RING_HALF_X, RING_HALF_Z, ENGINE_RING_CX, ENGINE_RING_CY } from "./worldMapping";

export type GymZone3D =
  | "ring" | "weights" | "bag1" | "bag2" | "bag3" | "lockers" | "door"
  | "trophyA" | "trophyB" | "office" | "player" | "equipCrate";

/**
 * Room shell: a long warehouse gym. The ring sits at the origin near the +x
 * end; the training floor stretches out toward -x, where the far wall holds
 * the lockers, the glass office, the trophy cases and the exit door.
 * `maxZ` is the front wall, drawn on the home screen only (the sparring
 * broadcast camera stands beyond it).
 */
export const GYM_ROOM = { minX: -15.5, maxX: 10, minZ: -8.6, maxZ: 9.5, wallH: 7 };

/** Facing yaw: rotY that turns a prop's +z front toward +x / -x / +z / -z. */
const FACE_Z = 0, FACE_PX = Math.PI / 2, FACE_NX = -Math.PI / 2;

/** Glass office booth in the far wall's middle (x from the wall, z span). */
export const GYM_OFFICE = { x0: GYM_ROOM.minX, x1: -13.4, z0: -0.6, z1: 1.9, h: 2.7 };

interface Spot { x: number; z: number; rotY: number }
/** Every prop spot. rotY turns the prop's front (+z) to face the room. */
const HOME_SPOTS = {
  // Far wall (x = minX), left to right as seen from the home camera.
  lockers: { x: GYM_ROOM.minX + 0.26, z: 3.4, rotY: FACE_PX },
  desk: { x: -14.8, z: 0.65, rotY: FACE_PX },
  chair: { x: -14.0, z: 0.65, rotY: FACE_NX },
  waterCrate: { x: -15.05, z: 1.55, rotY: 0.3 },
  trophyA: { x: GYM_ROOM.minX + 0.24, z: -2.6, rotY: FACE_PX },
  door: { x: GYM_ROOM.minX + 0.1, z: -4.4, rotY: FACE_PX },
  trophyB: { x: GYM_ROOM.minX + 0.24, z: -6.2, rotY: FACE_PX },
  // Side wall (z = minZ), decor behind the ring.
  speedBag: { x: -3.2, z: GYM_ROOM.minZ + 0.45, rotY: FACE_Z },
  // Glove pairs: z puts the rack's flat back on the wall (model depth × GYM_GLOVES.scale).
  gloveRack: { x: -6.2, z: GYM_ROOM.minZ + 0.14, rotY: FACE_Z },
  // Two more pairs on the side wall behind the ring (seen in the ring view only), clear of the posters.
  gloveRack2: { x: 0.5, z: GYM_ROOM.minZ + 0.14, rotY: FACE_Z },
  gloveRack3: { x: 3.8, z: GYM_ROOM.minZ + 0.14, rotY: FACE_Z },
  // Weights station out on the training floor, in front of the bag row.
  plateRack: { x: -10.2, z: -1.9, rotY: 0.6 },
  benchPress: { x: -8.4, z: -1.4, rotY: 0.4 },
  dumbbells: { x: -7.0, z: -3.0, rotY: 0.2 },
  // Three hanging bags in a row along the side wall, between ring and far wall.
  bag1: { x: -9.0, z: -6.4, rotY: 0.5 },
  bag2: { x: -11.0, z: -6.8, rotY: -0.3 },
  bag3: { x: -13.0, z: -7.2, rotY: 0.9 },
  woodBench: { x: -7.75, z: 4.6, rotY: 1.0 },
  /** The player's fighter idles in front of the bench, close to the camera. */
  player: { x: -6.9, z: 5.75, rotY: 0 },
  equipCrate: { x: -4.4, z: 2.6, rotY: 0.55 },
};
type SpotKey = keyof typeof HOME_SPOTS;
type V3 = [number, number, number];
/** A challenger's gym: the same kit rearranged, optionally shot from its own home camera. */
interface Arrangement { spots: Partial<Record<SpotKey, Spot>>; cam?: { pos: V3; target: V3 } }
const AWAY_LAYOUTS: Arrangement[] = [
  // Bags out on the floor, weights along the side wall.
  { spots: {
    bag1: { x: -8.2, z: -2.4, rotY: 0.2 },
    bag2: { x: -10.2, z: -2.0, rotY: -0.6 },
    bag3: { x: -12.2, z: -2.4, rotY: 0.7 },
    plateRack: { x: -11.4, z: -7.0, rotY: 0.1 },
    benchPress: { x: -9.4, z: -6.5, rotY: -0.2 },
    dumbbells: { x: -7.4, z: -7.3, rotY: 0.1 },
    // Lockers on the side wall behind the ring (seen in the ring view).
    lockers: { x: 8.4, z: GYM_ROOM.minZ + 0.26, rotY: FACE_Z },
    trophyB: { x: GYM_ROOM.minX + 0.24, z: 3.4, rotY: FACE_PX },
  } },
  // Turned round: shot from the office corner back toward the ring, door on the side wall.
  { spots: {
    door: { x: -3.9, z: GYM_ROOM.minZ + 0.1, rotY: FACE_Z },
    speedBag: { x: -2.4, z: GYM_ROOM.minZ + 0.45, rotY: FACE_Z },
    bag1: { x: -6.6, z: 0.2, rotY: 0.3 },
    bag2: { x: -7.0, z: 2.2, rotY: -0.5 },
    bag3: { x: -7.4, z: 4.2, rotY: 0.8 },
    lockers: { x: -9.4, z: GYM_ROOM.minZ + 0.26, rotY: FACE_Z },
    trophyA: { x: -7.5, z: GYM_ROOM.minZ + 0.24, rotY: FACE_Z },
    trophyB: { x: -5.8, z: GYM_ROOM.minZ + 0.24, rotY: FACE_Z },
    plateRack: { x: -2.6, z: 6.4, rotY: 2.4 },
    benchPress: { x: -3.6, z: 4.6, rotY: 2.0 },
    dumbbells: { x: -2.2, z: 3.8, rotY: 1.9 },
    woodBench: { x: -13.0, z: 4.2, rotY: -0.4 },
    player: { x: -12.0, z: 3.2, rotY: 0 },
    equipCrate: { x: -10.4, z: -5.4, rotY: 0.3 },
    gloveRack: { x: -11.4, z: GYM_ROOM.minZ + 0.14, rotY: FACE_Z },
  }, cam: { pos: [-14.4, 2.5, 7.4], target: [-2, 0.9, -7] } },
  // Up on the mezzanine: a high shot down over the floor, door at the front of the far wall.
  { spots: {
    door: { x: GYM_ROOM.minX + 0.1, z: 5.6, rotY: FACE_PX },
    lockers: { x: GYM_ROOM.minX + 0.26, z: -6.4, rotY: FACE_PX },
    trophyB: { x: GYM_ROOM.minX + 0.24, z: 3.4, rotY: FACE_PX },
    bag1: { x: -7.0, z: -5.4, rotY: 0.5 },
    bag2: { x: -9.0, z: -4.4, rotY: -0.3 },
    bag3: { x: -11.0, z: -3.4, rotY: 0.9 },
    plateRack: { x: -9.8, z: 1.6, rotY: 0.9 },
    benchPress: { x: -8.0, z: 2.4, rotY: 0.7 },
    dumbbells: { x: -6.6, z: 1.0, rotY: 0.4 },
  }, cam: { pos: [-3.4, 6.2, 8.8], target: [-12.4, 0.2, -1.0] } },
];
/** Live spots (mutated in place by setGymArrangement before a scene is built). */
export const GYM_SPOTS: Record<SpotKey, Spot> = Object.fromEntries(
  Object.entries(HOME_SPOTS).map(([k, v]) => [k, { ...v }]),
) as Record<SpotKey, Spot>;

/** Wall glove pairs: model scale, and the hang height of the pair's lowest point. */
export const GYM_GLOVES = { scale: 0.42, y: 1.45, ringY: 2.3 };

/** Hanging bag: height of the bag's lowest point, and the ceiling beam it hangs from. */
export const GYM_BAG_HANG = { bottom: 0.55, beamY: 5.6 };

/** Trophy case cabinet (code-built): outer size and shelf heights, top shelf first. */
export const TROPHY_CASE = { w: 1.5, d: 0.45, h: 2.05, shelves: [1.52, 1.0, 0.48], perShelf: 8, rows: 2 };

/** Engine-px floor point for the idle player (fed to the rig through a FighterState); set by setGymArrangement. */
export const GYM_PLAYER_PX = { x: 0, z: 0, facing: 0 };

interface Box { min: [number, number, number]; max: [number, number, number] }
const box = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): Box => ({ min: [x0, y0, z0], max: [x1, y1, z1] });
const around = (s: { x: number; z: number }, hw: number, h: number, hd = hw): Box => box(s.x - hw, 0, s.z - hd, s.x + hw, h, s.z + hd);

/** Click boxes (world AABBs). The ring is a rhombus, handled separately. */
const O = GYM_OFFICE;
/** A prop standing against whichever wall its facing puts its back to. */
const wall = (s: Spot, half: number, h: number, depth = 0.5): Box => {
  if (Math.abs(Math.sin(s.rotY)) > 0.7) {
    const x0 = Math.sin(s.rotY) > 0 ? GYM_ROOM.minX : GYM_ROOM.maxX - depth;
    return box(x0, 0, s.z - half, x0 + depth, h, s.z + half);
  }
  const z0 = Math.cos(s.rotY) > 0 ? GYM_ROOM.minZ : GYM_ROOM.maxZ - depth;
  return box(s.x - half, 0, z0, s.x + half, h, z0 + depth);
};
/** Lockers stand against a wall or, mid-floor, as a free block. */
const lockerBox = (s: Spot): Box => {
  const nearWall = s.x < GYM_ROOM.minX + 1 || s.x > GYM_ROOM.maxX - 1 || s.z < GYM_ROOM.minZ + 1 || s.z > GYM_ROOM.maxZ - 1;
  if (nearWall) return wall(s, 1.15, 2.1);
  return Math.abs(Math.sin(s.rotY)) > 0.7 ? around(s, 0.3, 2.1, 1.15) : around(s, 1.15, 2.1, 0.3);
};
const hangingBag = (s: { x: number; z: number }): Box => box(s.x - 0.45, GYM_BAG_HANG.bottom, s.z - 0.45, s.x + 0.45, GYM_BAG_HANG.bottom + 1.75, s.z + 0.45);
const zoneBoxes = (): Record<Exclude<GymZone3D, "ring">, Box[]> => ({
  weights: [around(GYM_SPOTS.benchPress, 1.0, 1.3), around(GYM_SPOTS.plateRack, 0.55, 1.3), around(GYM_SPOTS.dumbbells, 0.85, 1.0)],
  bag1: [hangingBag(GYM_SPOTS.bag1)],
  bag2: [hangingBag(GYM_SPOTS.bag2)],
  bag3: [hangingBag(GYM_SPOTS.bag3)],
  lockers: [lockerBox(GYM_SPOTS.lockers)],
  door: [wall(GYM_SPOTS.door, 0.65, 2.3, 0.3)],
  trophyA: [wall(GYM_SPOTS.trophyA, TROPHY_CASE.w / 2, TROPHY_CASE.h)],
  trophyB: [wall(GYM_SPOTS.trophyB, TROPHY_CASE.w / 2, TROPHY_CASE.h)],
  office: [box(O.x0, 0, O.z0, O.x1, O.h, O.z1), around(GYM_SPOTS.waterCrate, 0.4, 0.5)],
  // The fighter only — the bench behind them is scenery, not a target.
  player: [around(GYM_SPOTS.player, 0.36, 1.95)],
  equipCrate: [around(GYM_SPOTS.equipCrate, 0.5, 0.65, 0.4)],
});
export const GYM_ZONE_BOXES = zoneBoxes();

/** World point a zone's floating tag / dot hangs over (top of its first box). */
export function gymZoneAnchor(zone: GymZone3D, lift = 0.25): THREE.Vector3 {
  if (zone === "ring") return new THREE.Vector3(-RING_HALF_X * 0.55, MAT_HEIGHT + 1.7 + lift, RING_HALF_Z * 0.25);
  const b = GYM_ZONE_BOXES[zone][0];
  return new THREE.Vector3((b.min[0] + b.max[0]) / 2, b.max[1] + lift, (b.min[2] + b.max[2]) / 2);
}

// ── home camera ────────────────────────────────────────────────────────────

/**
 * The home screen is a low, cinematic shot: eye-level-ish from beside the
 * ring, looking down the training floor at the far wall, with the player's
 * fighter large in the foreground. The camera breathes a little (slow
 * handheld drift), so picking and tag placement must use the live camera.
 */
export const GYM_HOME_FOV = 56;
const HOME_CAM = { pos: [-2.6, 2.4, 7.8] as V3, target: [-14, 0.8, -5] as V3 };
/** Live home-camera pose (set by setGymArrangement). */
const HOME_POS = new THREE.Vector3(...HOME_CAM.pos);
const HOME_TARGET = new THREE.Vector3(...HOME_CAM.target);
const SCREEN_W = 800;
const SCREEN_H = 600;

/** The home screen's camera at rest (4:3 like the 2D canvas). */
export function makeGymHomeCamera(): THREE.PerspectiveCamera {
  const cam = new THREE.PerspectiveCamera(GYM_HOME_FOV, SCREEN_W / SCREEN_H, 0.1, 200);
  poseGymHomeCamera(cam, 0);
  cam.updateProjectionMatrix();
  return cam;
}

const _target = new THREE.Vector3();
/** Place the home camera for time `t` (seconds): a slow, small handheld drift. */
export function poseGymHomeCamera(cam: THREE.PerspectiveCamera, t: number): void {
  cam.position.set(
    HOME_POS.x + 0.16 * Math.sin(t * 0.21),
    HOME_POS.y + 0.06 * Math.sin(t * 0.33 + 1.1),
    HOME_POS.z + 0.1 * Math.sin(t * 0.17 + 2.3),
  );
  _target.set(
    HOME_TARGET.x + 0.25 * Math.sin(t * 0.13 + 0.7),
    HOME_TARGET.y + 0.08 * Math.sin(t * 0.27),
    HOME_TARGET.z,
  );
  cam.lookAt(_target);
  cam.updateMatrixWorld();
}

/**
 * Ring view: hovering the ring pans from the home shot to a ringside view of
 * the AI sparring bout. `k` (0 = home, 1 = ring) blends the two poses; the
 * caller eases it.
 */
const RING_POS = new THREE.Vector3(-1.2, 4.3, 9.1);
const RING_TARGET = new THREE.Vector3(0, MAT_HEIGHT + 0.5, -0.2);
const _homePos = new THREE.Vector3();
const _homeQuat = new THREE.Quaternion();
const _ringQuat = new THREE.Quaternion();
export function poseGymCamera(cam: THREE.PerspectiveCamera, t: number, k: number): void {
  poseGymHomeCamera(cam, t);
  if (k <= 0) return;
  _homePos.copy(cam.position);
  _homeQuat.copy(cam.quaternion);
  cam.position.set(
    RING_POS.x + 0.12 * Math.sin(t * 0.19),
    RING_POS.y + 0.05 * Math.sin(t * 0.31 + 0.4),
    RING_POS.z,
  );
  cam.lookAt(RING_TARGET);
  _ringQuat.copy(cam.quaternion);
  const e = Math.min(1, k);
  cam.position.lerpVectors(_homePos, cam.position, e);
  cam.quaternion.slerpQuaternions(_homeQuat, _ringQuat, e);
  cam.updateMatrixWorld();
}

const restCam = makeGymHomeCamera();
const _v = new THREE.Vector3();

/** Home gym (null) or a challenger's gym layout. Call before building the scene. */
export function setGymArrangement(layout: number | null): void {
  const a = layout == null ? null : AWAY_LAYOUTS[layout] ?? AWAY_LAYOUTS[0];
  for (const k of Object.keys(HOME_SPOTS) as SpotKey[]) Object.assign(GYM_SPOTS[k], a?.spots[k] ?? HOME_SPOTS[k]);
  Object.assign(GYM_ZONE_BOXES, zoneBoxes());
  const cam = a?.cam ?? HOME_CAM;
  HOME_POS.set(...cam.pos);
  HOME_TARGET.set(...cam.target);
  poseGymHomeCamera(restCam, 0);
  const p = GYM_SPOTS.player;
  GYM_PLAYER_PX.x = ENGINE_RING_CX + p.x * PX_PER_UNIT;
  GYM_PLAYER_PX.z = ENGINE_RING_CY + p.z * PX_PER_UNIT;
  // Three-quarters toward the home camera.
  GYM_PLAYER_PX.facing = Math.atan2(HOME_POS.z - p.z, HOME_POS.x - p.x) + 0.17;
}
setGymArrangement(null);

/** World point → 800x600 screen point through the home camera (live one if given). */
export function projectGymPoint(p: THREE.Vector3, cam: THREE.Camera = restCam): { x: number; y: number } {
  _v.copy(p).project(cam);
  return { x: (_v.x * 0.5 + 0.5) * SCREEN_W, y: (-_v.y * 0.5 + 0.5) * SCREEN_H };
}

const _ray = new THREE.Ray();
const _box = new THREE.Box3();
const _hit = new THREE.Vector3();

/** 800x600 screen point → the nearest click target under it, or null. */
export function pickGymZone(sx: number, sy: number, cam: THREE.Camera = restCam): GymZone3D | null {
  const ndc = new THREE.Vector3((sx / SCREEN_W) * 2 - 1, -(sy / SCREEN_H) * 2 + 1, 0.5);
  ndc.unproject(cam);
  _ray.origin.setFromMatrixPosition(cam.matrixWorld);
  _ray.direction.copy(ndc.sub(_ray.origin).normalize());
  let best: GymZone3D | null = null;
  let bestD = Infinity;
  for (const zone of Object.keys(GYM_ZONE_BOXES) as Exclude<GymZone3D, "ring">[]) {
    for (const b of GYM_ZONE_BOXES[zone]) {
      _box.min.fromArray(b.min);
      _box.max.fromArray(b.max);
      if (_ray.intersectBox(_box, _hit)) {
        const d = _hit.distanceTo(_ray.origin);
        if (d < bestD) { bestD = d; best = zone; }
      }
    }
  }
  // Ring: seen from low down, so test the air just above it (where the
  // sparring fighters' heads are), the rope-height plane, the mat and the
  // apron's middle — any hit inside the rhombus counts unless a prop is nearer.
  for (const y of [MAT_HEIGHT + 2.1, MAT_HEIGHT + 1.3, MAT_HEIGHT, MAT_HEIGHT * 0.5]) {
    const t = (y - _ray.origin.y) / _ray.direction.y;
    if (!(t > 0 && t < bestD)) continue;
    _ray.at(t, _hit);
    if (Math.abs(_hit.x) / RING_HALF_X + Math.abs(_hit.z) / RING_HALF_Z <= 1) { best = "ring"; bestD = t; }
  }
  return best;
}
