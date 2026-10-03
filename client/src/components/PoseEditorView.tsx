import { useCallback, useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { ArrowLeft, RotateCcw, Save, Undo2, Redo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { createInitialState } from "@/game/engine";
import { Fighter3D } from "@/game/three/fighterModel";
import { BONE_NAMES, type BoneName, ensureFighterAssets, fighterAssetEpoch } from "@/game/three/fighterRig";
import {
  type JointRot, type PoseOffsets, getSavedPoseOffsets, savePoseOffsets, setPoseOffsetsDraft,
} from "@/game/three/poseOffsets";

const JOINT_LABEL: Record<BoneName, string> = {
  Hips: "Hips", Spine: "Lower Spine", Spine1: "Mid Spine", Spine2: "Chest", Neck: "Neck", Head: "Head",
  LeftShoulder: "L Shoulder", LeftArm: "L Upper Arm", LeftForeArm: "L Forearm", LeftHand: "L Hand",
  RightShoulder: "R Shoulder", RightArm: "R Upper Arm", RightForeArm: "R Forearm", RightHand: "R Hand",
  LeftUpLeg: "L Thigh", LeftLeg: "L Shin", LeftFoot: "L Foot", LeftToeBase: "L Toes",
  RightUpLeg: "R Thigh", RightLeg: "R Shin", RightFoot: "R Foot", RightToeBase: "R Toes",
};
const GROUPS: [string, BoneName[]][] = [
  ["Torso & head", ["Hips", "Spine", "Spine1", "Spine2", "Neck", "Head"]],
  ["Left arm", ["LeftShoulder", "LeftArm", "LeftForeArm", "LeftHand"]],
  ["Right arm", ["RightShoulder", "RightArm", "RightForeArm", "RightHand"]],
  ["Left leg", ["LeftUpLeg", "LeftLeg", "LeftFoot", "LeftToeBase"]],
  ["Right leg", ["RightUpLeg", "RightLeg", "RightFoot", "RightToeBase"]],
];
const AXES = [
  { label: "X", hint: "roll about the forward axis" },
  { label: "Y", hint: "turn about the vertical axis" },
  { label: "Z", hint: "tilt about the side axis" },
];
const ZERO: JointRot = [0, 0, 0];
const same = (a: PoseOffsets, b: PoseOffsets) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Neural Network → Edit Poses: rotate any joint of the 3D boxer's fight stance
 * on three body axes, live on a posed model. Cmd/Ctrl+Z undoes, Shift+Cmd/Ctrl+Z
 * redoes, Save (confirmed) writes the set the fights use.
 */
export default function PoseEditorView({ onBack }: { onBack: () => void }) {
  const [offsets, setOffsets] = useState<PoseOffsets>(() => ({ ...getSavedPoseOffsets() }));
  const [savedSnap, setSavedSnap] = useState<PoseOffsets>(() => ({ ...getSavedPoseOffsets() }));
  const [selected, setSelected] = useState<BoneName>("LeftArm");
  const [southpaw, setSouthpaw] = useState(false);
  const [fullGuard, setFullGuard] = useState(false);
  const [confirmSave, setConfirmSave] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const undoRef = useRef<PoseOffsets[]>([]);
  const redoRef = useRef<PoseOffsets[]>([]);
  const gestureRef = useRef<{ key: string; t: number } | null>(null);
  const [, bump] = useState(0);
  const offsetsRef = useRef(offsets);
  offsetsRef.current = offsets;
  const dirty = !same(offsets, savedSnap);

  // The renderer reads the draft while this view is open.
  useEffect(() => { setPoseOffsetsDraft(offsets); }, [offsets]);
  useEffect(() => () => setPoseOffsetsDraft(null), []);

  /** One undo step per gesture: a run of edits to the same joint axis with no pause over 0.6 s. */
  const edit = useCallback((bone: BoneName, axis: number, value: number) => {
    const now = performance.now();
    const key = `${bone}:${axis}`;
    const g = gestureRef.current;
    if (!g || g.key !== key || now - g.t > 600) {
      undoRef.current.push(offsetsRef.current);
      if (undoRef.current.length > 200) undoRef.current.shift();
      redoRef.current = [];
    }
    gestureRef.current = { key, t: now };
    const v = Math.max(-180, Math.min(180, Math.round(value)));
    setOffsets(prev => {
      const r: JointRot = [...(prev[bone] ?? ZERO)] as JointRot;
      r[axis] = v;
      const next = { ...prev };
      if (r.every(x => x === 0)) delete next[bone]; else next[bone] = r;
      return next;
    });
  }, []);

  const replaceAll = useCallback((next: PoseOffsets) => {
    undoRef.current.push(offsetsRef.current);
    redoRef.current = [];
    gestureRef.current = null;
    setOffsets(next);
  }, []);

  const undo = useCallback(() => {
    const prev = undoRef.current.pop();
    if (!prev) return;
    redoRef.current.push(offsetsRef.current);
    gestureRef.current = null;
    setOffsets(prev);
    bump(n => n + 1);
  }, []);
  const redo = useCallback(() => {
    const next = redoRef.current.pop();
    if (!next) return;
    undoRef.current.push(offsetsRef.current);
    gestureRef.current = null;
    setOffsets(next);
    bump(n => n + 1);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "z") return;
      e.preventDefault();
      if (e.shiftKey) redo(); else undo();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo]);

  // ── 3D viewport ──
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef({ southpaw, fullGuard, selected });
  viewRef.current = { southpaw, fullGuard, selected };
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
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
        scene.add(fig.root);
      }
      const v = viewRef.current;
      if (fig) {
        const a = st.player, d = st.enemy;
        // Fighter at the ring centre facing +x, opponent out of shot.
        a.x = 400; a.z = 300; a.facingAngle = 0;
        d.x = 560; d.z = 300; d.facingAngle = Math.PI;
        a.boxingStance = (v.southpaw ? "southpaw" : "orthodox") as typeof a.boxingStance;
        a.guardBlend = v.fullGuard ? 1 : 0;
        fig.update(a, st.playerColors, d, st, 1);
        fig.root.position.set(0, 0, 0);
        fig.root.updateMatrixWorld(true);
        const bone = (fig as unknown as { bind: Record<BoneName, { bone: THREE.Object3D }> }).bind[v.selected]?.bone;
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

    // Drag to orbit, shift-drag to pan up/down, wheel to zoom, click a joint to select it.
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
      const bind = (fig as unknown as { bind: Record<BoneName, { bone: THREE.Object3D }> }).bind;
      let best: BoneName | null = null, bestD = 22;
      const p = new THREE.Vector3();
      for (const name of BONE_NAMES) {
        bind[name].bone.getWorldPosition(p).project(camera);
        const sx = (p.x * 0.5 + 0.5) * rect.width, sy = (-p.y * 0.5 + 0.5) * rect.height;
        const dd = Math.hypot(sx - px, sy - py);
        if (dd < bestD) { bestD = dd; best = name; }
      }
      if (best) setSelected(best);
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
  }, []);

  const rot = offsets[selected] ?? ZERO;
  const editedCount = Object.keys(offsets).length;

  return (
    <div className="flex flex-col h-full w-full gap-3 p-4 overflow-hidden" data-testid="pose-editor">
      <div className="flex items-center gap-2 flex-wrap">
        <Button variant="ghost" size="sm" onClick={() => (dirty ? setConfirmLeave(true) : onBack())} data-testid="button-pose-back">
          <ArrowLeft className="w-4 h-4 mr-1" /> Back
        </Button>
        <h2 className="text-lg font-bold mr-auto">Edit Poses</h2>
        <Button variant="outline" size="sm" onClick={undo} disabled={!undoRef.current.length} title="Undo (Cmd/Ctrl+Z)" data-testid="button-pose-undo">
          <Undo2 className="w-4 h-4" />
        </Button>
        <Button variant="outline" size="sm" onClick={redo} disabled={!redoRef.current.length} title="Redo (Shift+Cmd/Ctrl+Z)" data-testid="button-pose-redo">
          <Redo2 className="w-4 h-4" />
        </Button>
        <Button size="sm" onClick={() => setConfirmSave(true)} disabled={!dirty} data-testid="button-pose-save">
          <Save className="w-4 h-4 mr-1" /> {justSaved && !dirty ? "Saved" : "Save"}
        </Button>
      </div>

      <div className="flex flex-1 min-h-0 gap-3 flex-col lg:flex-row">
        <div className="relative flex-1 min-h-[320px] rounded-md overflow-hidden border border-border">
          <div ref={hostRef} className="absolute inset-0" />
          <div className="absolute left-2 bottom-2 text-[11px] text-white/60 pointer-events-none">
            Drag to orbit · Shift-drag to raise/lower · Scroll to zoom · Click a joint to select it
          </div>
          <div className="absolute right-2 top-2 flex gap-1">
            <Button size="sm" variant={southpaw ? "outline" : "default"} onClick={() => setSouthpaw(false)} data-testid="button-pose-orthodox">Orthodox</Button>
            <Button size="sm" variant={southpaw ? "default" : "outline"} onClick={() => setSouthpaw(true)} data-testid="button-pose-southpaw">Southpaw</Button>
            <Button size="sm" variant={fullGuard ? "default" : "outline"} onClick={() => setFullGuard(g => !g)} data-testid="button-pose-guard">Full guard</Button>
          </div>
        </div>

        <Card className="w-full lg:w-[360px] p-3 flex flex-col gap-3 overflow-y-auto">
          <div>
            <div className="text-xs text-muted-foreground mb-1">Joint</div>
            <div className="flex flex-col gap-2">
              {GROUPS.map(([g, bones]) => (
                <div key={g}>
                  <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{g}</div>
                  <div className="flex flex-wrap gap-1 mt-1">
                    {bones.map(b => (
                      <Button key={b} size="sm" variant={b === selected ? "default" : "outline"} className="h-7 px-2 text-xs"
                        onClick={() => setSelected(b)} data-testid={`button-joint-${b}`}>
                        {JOINT_LABEL[b]}{offsets[b] ? " •" : ""}
                      </Button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="border-t border-border pt-3 flex flex-col gap-3">
            <div className="flex items-center">
              <div className="font-semibold mr-auto">{JOINT_LABEL[selected]}</div>
              <Button variant="ghost" size="sm" disabled={!offsets[selected]}
                onClick={() => { const n = { ...offsets }; delete n[selected]; replaceAll(n); }} data-testid="button-joint-reset">
                <RotateCcw className="w-3.5 h-3.5 mr-1" /> Reset joint
              </Button>
            </div>
            {AXES.map((ax, i) => (
              <div key={ax.label} className="flex flex-col gap-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-mono w-4">{ax.label}</span>
                  <span className="text-xs text-muted-foreground mr-auto">{ax.hint}</span>
                  <Input type="number" className="h-7 w-20 text-right" min={-180} max={180} value={rot[i]}
                    onChange={e => edit(selected, i, Number(e.target.value) || 0)} data-testid={`input-rot-${ax.label}`} />
                  <span className="text-xs text-muted-foreground">°</span>
                </div>
                <Slider min={-180} max={180} step={1} value={[rot[i]]}
                  onValueChange={([v]) => edit(selected, i, v)} data-testid={`slider-rot-${ax.label}`} />
              </div>
            ))}
            <p className="text-[11px] text-muted-foreground">
              Rotations are about the boxer's own axes and carry every joint below. A punching arm's edits fade
              out as it extends, so punches still land at their real reach.
            </p>
          </div>

          <div className="border-t border-border pt-3 flex items-center gap-2">
            <span className="text-xs text-muted-foreground mr-auto">
              {editedCount} joint{editedCount === 1 ? "" : "s"} edited{dirty ? " · unsaved changes" : ""}
            </span>
            <Button variant="outline" size="sm" disabled={!editedCount} onClick={() => replaceAll({})} data-testid="button-pose-reset-all">
              Reset all
            </Button>
          </div>
        </Card>
      </div>

      <AlertDialog open={confirmSave} onOpenChange={setConfirmSave}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Save fight pose?</AlertDialogTitle>
            <AlertDialogDescription>
              Every 3D fighter will use these joint rotations ({editedCount} joint{editedCount === 1 ? "" : "s"} edited).
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-pose-save-cancel">Cancel</AlertDialogCancel>
            <AlertDialogAction data-testid="button-pose-save-confirm" onClick={() => {
              savePoseOffsets(offsets);
              setSavedSnap(offsets);
              setJustSaved(true);
            }}>Save</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmLeave} onOpenChange={setConfirmLeave}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard unsaved pose changes?</AlertDialogTitle>
            <AlertDialogDescription>Your edits since the last save will be lost.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep editing</AlertDialogCancel>
            <AlertDialogAction onClick={onBack} data-testid="button-pose-discard">Discard</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
