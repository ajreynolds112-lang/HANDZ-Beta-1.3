/**
 * Every gym layout: each click target's box must be on screen and pick to
 * itself from the rest camera for a fair share of its sample points.
 */
import * as THREE from "three";
import { GYM_ZONE_BOXES, makeGymHomeCamera, pickGymZone, poseGymCamera, projectGymPoint, setGymArrangement, type GymZone3D } from "../client/src/game/three/gymLayout";

const MIN_SHARE = 0.25;
let failed = 0;
for (const layout of [null, 0, 1, 2]) {
  setGymArrangement(layout);
  const home = makeGymHomeCamera(), ringView = makeGymHomeCamera();
  poseGymCamera(ringView, 0, 1);
  const rows: string[] = [];
  const share = (zone: Exclude<GymZone3D, "ring">, cam: THREE.Camera) => {
    let seen = 0, own = 0;
    for (const b of GYM_ZONE_BOXES[zone]) {
      for (const fx of [0.2, 0.5, 0.8]) for (const fy of [0.2, 0.5, 0.8]) for (const fz of [0.2, 0.5, 0.8]) {
        const p = new THREE.Vector3(b.min[0] + (b.max[0] - b.min[0]) * fx, b.min[1] + (b.max[1] - b.min[1]) * fy, b.min[2] + (b.max[2] - b.min[2]) * fz);
        const s = projectGymPoint(p, cam);
        if (s.x < 0 || s.x > 800 || s.y < 0 || s.y > 600) continue;
        seen++;
        if (pickGymZone(s.x, s.y, cam) === zone) own++;
      }
    }
    return { pct: seen ? own / seen : 0, seen };
  };
  for (const zone of Object.keys(GYM_ZONE_BOXES) as Exclude<GymZone3D, "ring">[]) {
    // Reachable from the home shot, or else from the ring view (hover the ring, then click).
    let r = share(zone, home), via = "home";
    if (r.pct < MIN_SHARE) { r = share(zone, ringView); via = "ring"; }
    // The office is never clickable away from home.
    const bad = r.pct < MIN_SHARE && !(layout != null && zone === "office");
    if (bad) failed++;
    rows.push(`${bad ? "FAIL" : "ok  "} ${zone.padEnd(10)} ${(r.pct * 100).toFixed(0).padStart(3)}% of ${r.seen} via ${via}`);
  }
  console.log(`layout ${layout ?? "home"}\n  ${rows.join("\n  ")}`);
}
if (failed) { console.error(`${failed} unreachable target(s)`); process.exit(1); }
console.log("all gym targets reachable");
