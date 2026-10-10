import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, RotateCcw, Save, Undo2, Redo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import type { BoneName } from "@/game/three/fighterRig";
import { createPoseStage, GROUPS, JOINT_LABEL } from "@/components/poseStage";
import {
  type JointRot, type PoseLayer, type StancePoses,
  POSE_LAYERS, getSavedStancePoses, isArmJoint, savePoseOffsets, setPoseOffsetsDraft,
} from "@/game/three/poseOffsets";

const AXES = [
  { label: "X", hint: "roll about the forward axis" },
  { label: "Y", hint: "turn about the vertical axis" },
  { label: "Z", hint: "tilt about the side axis" },
];
const ZERO: JointRot = [0, 0, 0];
const same = (a: StancePoses, b: StancePoses) => JSON.stringify(a) === JSON.stringify(b);
/** Where a joint's edit lives: arms on the stance or full-guard set, torso/legs on stance or duck. */
const layerFor = (bone: BoneName, duck: boolean, fullGuard: boolean): PoseLayer =>
  isArmJoint(bone) ? (fullGuard ? "fullGuard" : "stance") : duck ? "duck" : "stance";
const copyPoses = (p: StancePoses): StancePoses => {
  const out = Object.fromEntries(POSE_LAYERS.map(k => [k, { ...p[k] }])) as StancePoses;
  if (p.noseLine) out.noseLine = [...p.noseLine] as JointRot;
  return out;
};

/**
 * Neural Network → Edit Poses: rotate any joint of the 3D boxer's fight stance
 * on three body axes, live on a posed model. Cmd/Ctrl+Z undoes, Shift+Cmd/Ctrl+Z
 * redoes, Save (confirmed) writes the set the fights use. One set is authored
 * (orthodox); southpaw fighters use its mirror. With Duck on, torso and leg
 * edits go to the duck layer while arm edits stay on the stance set, because
 * ducking never moves the hands. With Full guard on, arm edits go to the full
 * guard's own arm set (the fights slide the arms between the two), so the
 * normal guard and the full guard are edited independently.
 */
export default function PoseEditorView({ onBack }: { onBack: () => void }) {
  const [poses, setPoses] = useState<StancePoses>(() => copyPoses(getSavedStancePoses()));
  const [savedSnap, setSavedSnap] = useState<StancePoses>(() => copyPoses(getSavedStancePoses()));
  const [selected, setSelected] = useState<BoneName>("LeftArm");
  const [duck, setDuck] = useState(false);
  const [fullGuard, setFullGuard] = useState(false);
  /** The layer the current view edits (status line and Reset all). */
  const layer: PoseLayer = duck ? "duck" : fullGuard ? "fullGuard" : "stance";
  const duckRef = useRef(duck);
  duckRef.current = duck;
  const fullGuardRef = useRef(fullGuard);
  fullGuardRef.current = fullGuard;
  const [confirmSave, setConfirmSave] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const undoRef = useRef<StancePoses[]>([]);
  const redoRef = useRef<StancePoses[]>([]);
  const gestureRef = useRef<{ key: string; t: number } | null>(null);
  const [, bump] = useState(0);
  const offsetsRef = useRef(poses);
  offsetsRef.current = poses;
  const valueOf = (bone: BoneName) => poses[layerFor(bone, duck, fullGuard)][bone];
  const dirty = !same(poses, savedSnap);

  // The renderer reads the draft while this view is open.
  useEffect(() => { setPoseOffsetsDraft(poses); }, [poses]);
  useEffect(() => () => setPoseOffsetsDraft(null), []);

  /** One undo step per gesture: a run of edits to the same joint axis with no pause over 0.6 s. */
  const edit = useCallback((bone: BoneName, axis: number, value: number) => {
    const now = performance.now();
    const st = layerFor(bone, duckRef.current, fullGuardRef.current);
    const key = `${st}:${bone}:${axis}`;
    const g = gestureRef.current;
    if (!g || g.key !== key || now - g.t > 600) {
      undoRef.current.push(offsetsRef.current);
      if (undoRef.current.length > 200) undoRef.current.shift();
      redoRef.current = [];
    }
    gestureRef.current = { key, t: now };
    const v = Math.max(-180, Math.min(180, Math.round(value)));
    setPoses(prevAll => {
      const prev = prevAll[st];
      const r: JointRot = [...(prev[bone] ?? ZERO)] as JointRot;
      r[axis] = v;
      const next = { ...prev };
      if (r.every(x => x === 0)) delete next[bone]; else next[bone] = r;
      return { ...prevAll, [st]: next };
    });
  }, []);

  /** The nose line's rotation, one undo step per gesture like a joint. */
  const editNose = useCallback((axis: number, value: number) => {
    const now = performance.now();
    const key = `nose:${axis}`;
    const g = gestureRef.current;
    if (!g || g.key !== key || now - g.t > 600) {
      undoRef.current.push(offsetsRef.current);
      if (undoRef.current.length > 200) undoRef.current.shift();
      redoRef.current = [];
    }
    gestureRef.current = { key, t: now };
    const v = Math.max(-180, Math.min(180, Math.round(value)));
    setPoses(prevAll => {
      const r: JointRot = [...(prevAll.noseLine ?? ZERO)] as JointRot;
      r[axis] = v;
      const next = { ...prevAll };
      if (r.every(x => x === 0)) delete next.noseLine; else next.noseLine = r;
      return next;
    });
  }, []);

  const replaceAll = useCallback((next: StancePoses) => {
    undoRef.current.push(offsetsRef.current);
    redoRef.current = [];
    gestureRef.current = null;
    setPoses(next);
  }, []);

  const undo = useCallback(() => {
    const prev = undoRef.current.pop();
    if (!prev) return;
    redoRef.current.push(offsetsRef.current);
    gestureRef.current = null;
    setPoses(prev);
    bump(n => n + 1);
  }, []);
  const redo = useCallback(() => {
    const next = redoRef.current.pop();
    if (!next) return;
    undoRef.current.push(offsetsRef.current);
    gestureRef.current = null;
    setPoses(next);
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
  const viewRef = useRef({ southpaw: false, fullGuard, duck, selected, noseLine: true });
  viewRef.current = { southpaw: false, fullGuard, duck, selected, noseLine: true };
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    return createPoseStage(host, () => viewRef.current, setSelected);
  }, []);

  const selLayer = layerFor(selected, duck, fullGuard);
  const rot = valueOf(selected) ?? ZERO;
  const editedCount = Object.keys(poses[layer]).length;
  const nose = poses.noseLine ?? ZERO;

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
            <Button size="sm" variant={fullGuard ? "default" : "outline"} onClick={() => setFullGuard(g => !g)} data-testid="button-pose-guard">Full guard</Button>
            <Button size="sm" variant={duck ? "default" : "outline"} onClick={() => setDuck(d => !d)} data-testid="button-pose-duck">Duck</Button>
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
                        {JOINT_LABEL[b]}{valueOf(b) ? " •" : ""}
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
              <Button variant="ghost" size="sm" disabled={!valueOf(selected)}
                onClick={() => { const n = { ...poses[selLayer] }; delete n[selected]; replaceAll({ ...poses, [selLayer]: n }); }} data-testid="button-joint-reset">
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

          <div className="border-t border-border pt-3 flex flex-col gap-3">
            <div className="flex items-center">
              <div className="font-semibold mr-auto">Nose line</div>
              <Button variant="ghost" size="sm" disabled={!poses.noseLine}
                onClick={() => { const n = { ...poses }; delete n.noseLine; replaceAll(n); }} data-testid="button-nose-reset">
                <RotateCcw className="w-3.5 h-3.5 mr-1" /> Reset
              </Button>
            </div>
            {AXES.map((ax, i) => (
              <div key={ax.label} className="flex flex-col gap-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-mono w-4 mr-auto">{ax.label}</span>
                  <Input type="number" className="h-7 w-20 text-right" min={-180} max={180} value={nose[i]}
                    onChange={e => editNose(i, Number(e.target.value) || 0)} data-testid={`input-nose-${ax.label}`} />
                  <span className="text-xs text-muted-foreground">°</span>
                </div>
                <Slider min={-180} max={180} step={1} value={[nose[i]]}
                  onValueChange={([v]) => editNose(i, v)} data-testid={`slider-nose-${ax.label}`} />
              </div>
            ))}
          </div>

          <div className="border-t border-border pt-3 flex items-center gap-2">
            <span className="text-xs text-muted-foreground mr-auto">
              {duck ? "Duck" : fullGuard ? "Full guard" : "Stance"}: {editedCount} joint{editedCount === 1 ? "" : "s"} edited{dirty ? " · unsaved changes" : ""}
            </span>
            <Button variant="outline" size="sm" disabled={!editedCount} onClick={() => replaceAll({ ...poses, [layer]: {} })} data-testid="button-pose-reset-all">
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
              Every 3D fighter will use these joint rotations (stance: {Object.keys(poses.stance).length},
              duck: {Object.keys(poses.duck).length}, full guard: {Object.keys(poses.fullGuard).length} joints edited).
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-pose-save-cancel">Cancel</AlertDialogCancel>
            <AlertDialogAction data-testid="button-pose-save-confirm" onClick={() => {
              savePoseOffsets(poses);
              setSavedSnap(copyPoses(poses));
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
