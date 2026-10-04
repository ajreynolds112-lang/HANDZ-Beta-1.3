import * as THREE from "three";
import { createInitialState } from "@/game/engine";
import type { FighterState, GameState } from "@/game/types";
import { Fighter3D } from "@/game/three/fighterModel";
import { PROFILE_VIEW_OPP_PX } from "@/game/three/punchProfiles";
import { BONE_NAMES, type BoneName, ensureFighterAssets, fighterAssetEpoch } from "@/game/three/fighterRig";

export const JOINT_LABEL: Record<BoneName, string> = {
  Hips: "Hips", Spine: "Lower Spine", Spine1: "Mid Spine", Spine2: "Chest", Neck: "Neck", Head: "Head",
  LeftShoulder: "L Shoulder", LeftArm: "L Upper Arm", LeftForeArm: "L Forearm", LeftHand: "L Hand",
  RightShoulder: "R Shoulder", RightArm: "R Upper Arm", RightForeArm: "R Forearm", RightHand: "R Hand",
  LeftUpLeg: "L Thigh", LeftLeg: "L Shin", LeftFoot: "L Foot", LeftToeBase: "L Toes",
  RightUpLeg: "R Thigh", RightLeg: "R Shin", RightFoot: "R Foot", RightToeBase: "R Toes",
};
export const GROUPS: [string, BoneName[]][] = [
  ["Torso & head", ["Hips", "Spine", "Spine1", "Spine2", "Neck", "Head"]],
  ["Left arm", ["LeftShoulder", "LeftArm", "LeftForeArm", "LeftHand"]],
  ["Right arm", ["RightShoulder", "RightArm", "RightForeArm", "RightHand"]],
  ["Left leg", ["LeftUpLeg", "LeftLeg", "LeftFoot", "LeftToeBase"]],
  ["Right leg", ["RightUpLeg", "RightLeg", "RightFoot", "RightToeBase"]],
];
export interface PoseStageFrame {
  southpaw: boolean;
  fullGuard: boolean;
  selected: BoneName | null;
  /** Last word on the posed fighter each frame (e.g. drive a punch). */
  pose?: (fighter: FighterState, state: GameState) => void;
}

/**
 * The editors' 3D stage: one boxer at the ring centre facing +x, orbit camera
 * (drag), shift-drag to raise/lower, wheel zoom, click a joint to pick it.
 * Returns the disposer.
 */
export function createPoseStage(host: HTMLElement, read: () => PoseStageFrame, onPick: (b: BoneName) => void): () => void {
  let disposed = false;
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
  renderer.shadowMap.enabled = true;
  host.appendChild(renderer.domElement);
  renderer.domElement.style.display = "block";
  renderer.domElement.style.touchAction = "none";
  const scene = new THREE.Scene();
  scene.background = new THREE.Color("#15171c");
  scene.add(new THREE.HemisphereLight("#ffffff", "#3a3d48", 1.4));
  const sun = new THREE.DirectionalLight("#ffffff", 2.2);
  sun.position.set(3, 6, 4);
  sun.castShadow = true;
  scene.add(sun);
  const floor = new THREE.Mesh(new THREE.CircleGeometry(3, 48), new THREE.MeshStandardMaterial({ color: "#2a2e38", roughness: 0.9 }));
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);
  const grid = new THREE.GridHelper(6, 12, "#3b4252", "#2f3542");
  grid.position.y = 0.002;
  scene.add(grid);
  const marker = new THREE.Mesh(new THREE.SphereGeometry(0.035, 16, 12), new THREE.MeshBasicMaterial({ color: "#facc15", depthTest: false }));
  marker.renderOrder = 10;
  scene.add(marker);

  const camera = new THREE.PerspectiveCamera(35, 1, 0.05, 50);
  const orbit = { yaw: 0.55, pitch: 0.12, dist: 4.6 };
  const target = new THREE.Vector3(0, 1.05, 0);

  ensureFighterAssets(() => disposed);
  const st = createInitialState();
  let fig: Fighter3D | null = null;
  let raf = 0;
  const bindOf = () => (fig as unknown as { bind: Record<BoneName, { bone: THREE.Object3D }> }).bind;

  const resize = () => {
    const w = host.clientWidth, h = host.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  const ro = new ResizeObserver(resize);
  ro.observe(host);
  resize();

  const loop = () => {
    if (disposed) return;
    raf = requestAnimationFrame(loop);
    if (!fig && fighterAssetEpoch() > 0) {
      fig = new Fighter3D();
      fig.noStretch = true;
      scene.add(fig.root);
    }
    const v = read();
    if (fig) {
      const a = st.player, d = st.enemy;
      // Opponent out of shot.
      a.x = 400; a.z = 300; a.facingAngle = 0;
      d.x = a.x + PROFILE_VIEW_OPP_PX; d.z = 300; d.facingAngle = Math.PI;
      a.boxingStance = (v.southpaw ? "southpaw" : "orthodox") as typeof a.boxingStance;
      a.guardBlend = v.fullGuard ? 1 : 0;
      a.isPunching = false;
      a.currentPunch = null;
      v.pose?.(a, st);
      fig.update(a, st.playerColors, d, st, 1);
      fig.root.position.set(0, 0, 0);
      fig.root.updateMatrixWorld(true);
      const bone = v.selected ? bindOf()[v.selected]?.bone : null;
      marker.visible = !!bone;
      if (bone) bone.getWorldPosition(marker.position);
    }
    camera.position.set(
      target.x + Math.cos(orbit.pitch) * Math.cos(orbit.yaw) * orbit.dist,
      target.y + Math.sin(orbit.pitch) * orbit.dist,
      target.z + Math.cos(orbit.pitch) * Math.sin(orbit.yaw) * orbit.dist,
    );
    camera.lookAt(target);
    renderer.render(scene, camera);
  };
  loop();

  let drag: { x: number; y: number; moved: boolean; shift: boolean } | null = null;
  const el = renderer.domElement;
  const onDown = (e: PointerEvent) => { drag = { x: e.clientX, y: e.clientY, moved: false, shift: e.shiftKey }; el.setPointerCapture(e.pointerId); };
  const onMove = (e: PointerEvent) => {
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
    drag.x = e.clientX; drag.y = e.clientY;
    if (drag.shift) target.y = Math.max(0.1, Math.min(2.2, target.y + dy * 0.004));
    else {
      orbit.yaw += dx * 0.008;
      orbit.pitch = Math.max(-0.4, Math.min(1.3, orbit.pitch + dy * 0.006));
    }
  };
  const onUp = (e: PointerEvent) => {
    const d = drag;
    drag = null;
    if (!d || d.moved || !fig) return;
    const rect = el.getBoundingClientRect();
    const px = e.clientX - rect.left, py = e.clientY - rect.top;
    const bind = bindOf();
    let best: BoneName | null = null, bestD = 22;
    const p = new THREE.Vector3();
    for (const name of BONE_NAMES) {
      bind[name].bone.getWorldPosition(p).project(camera);
      const sx = (p.x * 0.5 + 0.5) * rect.width, sy = (-p.y * 0.5 + 0.5) * rect.height;
      const dd = Math.hypot(sx - px, sy - py);
      if (dd < bestD) { bestD = dd; best = name; }
    }
    if (best) onPick(best);
  };
  const onWheel = (e: WheelEvent) => { e.preventDefault(); orbit.dist = Math.max(1.2, Math.min(9, orbit.dist * Math.exp(e.deltaY * 0.001))); };
  el.addEventListener("pointerdown", onDown);
  el.addEventListener("pointermove", onMove);
  el.addEventListener("pointerup", onUp);
  el.addEventListener("wheel", onWheel, { passive: false });

  return () => {
    disposed = true;
    cancelAnimationFrame(raf);
    ro.disconnect();
    fig?.dispose();
    for (const m of [floor, marker]) { m.geometry.dispose(); (m.material as THREE.Material).dispose(); }
    grid.dispose();
    renderer.dispose();
    el.remove();
  };
}
