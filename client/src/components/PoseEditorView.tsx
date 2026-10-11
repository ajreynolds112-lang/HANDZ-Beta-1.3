import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, RotateCcw, Save, Undo2, Redo2, Copy, ClipboardPaste } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { BONE_NAMES, type BoneName } from "@/game/three/fighterRig";
import { createPoseStage, GROUPS, JOINT_LABEL } from "@/components/poseStage";
import {
  type JointRot, type PbPose, type PbVariant, type PoseLayer, type PoseOffsets, type StancePoses,
  FULL_GUARD_LAYERS, GUARD_STANCE_LABELS, HIP_HEIGHT_MAX, PB_LABELS, PB_VARIANTS,
  getSavedStancePoses, isArmJoint, isPbJoint, savePoseOffsets, setPoseOffsetsDraft,
} from "@/game/three/poseOffsets";

const AXES = [
  { label: "X", hint: "roll about the forward axis" },
  { label: "Y", hint: "turn about the vertical axis" },
  { label: "Z", hint: "tilt about the side axis" },
];
const ZERO: JointRot = [0, 0, 0];
const same = (a: StancePoses, b: StancePoses) => JSON.stringify(a) === JSON.stringify(b);
/** A pose layer, or a full guard's perfect block variant pose. */
type Target = PoseLayer | `pb:${number}:${PbVariant}`;
/**
 * Where a joint's edit lives: in Perfect block, arms + torso on that variant's
 * pose; otherwise arms on the stance or chosen full-guard set, torso/legs on stance or duck.
 */
const targetFor = (bone: BoneName, duck: boolean, fullGuard: boolean, guard: number, pb: PbVariant | null): Target =>
  pb && isPbJoint(bone) ? `pb:${guard}:${pb}` : isArmJoint(bone) ? (fullGuard ? FULL_GUARD_LAYERS[guard] : "stance") : duck ? "duck" : "stance";
const pbOf = (t: Target) => { const [, g, v] = t.split(":"); return [Number(g), v as PbVariant] as const; };
/** A variant with no pose of its own shows (and starts editing from) its guard's Standard. */
const getSet = (p: StancePoses, t: Target): PoseOffsets => {
  if (!t.startsWith("pb:")) return p[t as PoseLayer];
  const [g, v] = pbOf(t);
  return p.perfectBlocks[g][v].pose ?? p.perfectBlocks[g].standard.pose ?? {};
};
/** Replace one guard's variant entry (only that guard's set changes). */
const withPb = (p: StancePoses, g: number, v: PbVariant, e: PbPose): StancePoses =>
  ({ ...p, perfectBlocks: p.perfectBlocks.map((s, i) => (i === g ? { ...s, [v]: e } : s)) });
const withSet = (p: StancePoses, t: Target, set: PoseOffsets): StancePoses => {
  if (!t.startsWith("pb:")) return { ...p, [t]: set };
  const [g, v] = pbOf(t);
  return withPb(p, g, v, { ...p.perfectBlocks[g][v], pose: set });
};
const copyPoses = (p: StancePoses): StancePoses => structuredClone(p);

/**
 * Neural Network → Edit Poses: rotate any joint of the 3D boxer's fight stance
 * on three body axes, live on a posed model. Cmd/Ctrl+Z undoes, Shift+Cmd/Ctrl+Z
 * redoes, Save (confirmed) writes the set the fights use. One set is authored
 * (orthodox); southpaw fighters use its mirror. With Duck on, torso and leg
 * edits go to the duck layer while arm edits stay on the stance set, because
 * ducking never moves the hands. With Full guard on, arm edits go to the full
 * guard's own arm set (the fights slide the arms between the two), so the
 * normal guard and the full guard are edited independently. There are three
 * full guards (cycled with Tab in fights). Perfect block edits an arm + torso
 * pose per variant; an unedited variant wears Standard's.
 */
export default function PoseEditorView({ onBack }: { onBack: () => void }) {
  const [poses, setPoses] = useState<StancePoses>(() => copyPoses(getSavedStancePoses()));
  const [savedSnap, setSavedSnap] = useState<StancePoses>(() => copyPoses(getSavedStancePoses()));
  const [selected, setSelected] = useState<BoneName>("LeftArm");
  const [duck, setDuck] = useState(false);
  const [fullGuard, setFullGuard] = useState(false);
  const [guard, setGuard] = useState(0);
  const [pbOn, setPbOn] = useState(false);
  const [pbVar, setPbVar] = useState<PbVariant>("standard");
  const pb = pbOn ? pbVar : null;
  /** The set the current view edits (status line and Reset all). */
  const layer: Target = pb ? `pb:${guard}:${pb}` : duck ? "duck" : fullGuard ? FULL_GUARD_LAYERS[guard] : "stance";
  const viewRef2 = useRef({ duck, fullGuard, guard, pb });
  viewRef2.current = { duck, fullGuard, guard, pb };
  const [confirmSave, setConfirmSave] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const undoRef = useRef<StancePoses[]>([]);
  const redoRef = useRef<StancePoses[]>([]);
  const gestureRef = useRef<{ key: string; t: number } | null>(null);
  const [, bump] = useState(0);
  const offsetsRef = useRef(poses);
  offsetsRef.current = poses;
  const tFor = (bone: BoneName) => targetFor(bone, duck, fullGuard, guard, pb);
  const valueOf = (bone: BoneName) => getSet(poses, tFor(bone))[bone];
  const dirty = !same(poses, savedSnap);

  // The renderer reads the draft while this view is open.
  useEffect(() => { setPoseOffsetsDraft(poses); }, [poses]);
  useEffect(() => () => setPoseOffsetsDraft(null), []);

  /** One undo step per gesture: a run of edits to the same joint axis with no pause over 0.6 s. */
  const edit = useCallback((bone: BoneName, axis: number, value: number) => {
    const now = performance.now();
    const vw = viewRef2.current;
    const st = targetFor(bone, vw.duck, vw.fullGuard, vw.guard, vw.pb);
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
      const prev = getSet(prevAll, st);
      const r: JointRot = [...(prev[bone] ?? ZERO)] as JointRot;
      r[axis] = v;
      const next = { ...prev };
      if (r.every(x => x === 0)) delete next[bone]; else next[bone] = r;
      return withSet(prevAll, st, next);
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

  /** Hip height (cm) of the stance, or the duck with Duck on; one undo step per gesture. */
  const editHip = useCallback((value: number) => {
    const now = performance.now();
    const k = viewRef2.current.duck ? "duckHipHeight" : "hipHeight";
    const g = gestureRef.current;
    if (!g || g.key !== k || now - g.t > 600) {
      undoRef.current.push(offsetsRef.current);
      if (undoRef.current.length > 200) undoRef.current.shift();
      redoRef.current = [];
    }
    gestureRef.current = { key: k, t: now };
    const v = Math.max(-HIP_HEIGHT_MAX, Math.min(HIP_HEIGHT_MAX, Math.round(value)));
    setPoses(prevAll => {
      const next = { ...prevAll };
      if (v) next[k] = v; else delete next[k];
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
  const frame = { southpaw: false, fullGuard, duck, selected, noseLine: true, guardStance: guard, pbPreview: pb ?? undefined };
  const viewRef = useRef(frame);
  viewRef.current = frame;
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    return createPoseStage(host, () => viewRef.current, setSelected);
  }, []);

  const selLayer = tFor(selected);
  const rot = valueOf(selected) ?? ZERO;
  const editedCount = Object.keys(getSet(poses, layer)).length;
  const pbEntry = poses.perfectBlocks[guard][pbVar];
  const setPbEntry = (patch: Partial<PbPose>) => replaceAll(withPb(poses, guard, pbVar, { ...pbEntry, ...patch }));
  const nose = poses.noseLine ?? ZERO;
  const hip = (duck ? poses.duckHipHeight : poses.hipHeight) ?? 0;
  /** Copy: every joint as this view shows it. Paste: onto the set this view edits (its own joints only). */
  const [clip, setClip] = useState<PoseOffsets | null>(null);
  const copyPose = () => {
    const out: PoseOffsets = {};
    for (const b of BONE_NAMES) { const v = valueOf(b); if (v) out[b] = [...v] as JointRot; }
    setClip(out);
  };
  const pastePose = () => {
    if (!clip) return;
    const next = { ...getSet(poses, layer) };
    for (const b of BONE_NAMES) {
      if (tFor(b) !== layer) continue;
      if (clip[b]) next[b] = [...clip[b]!] as JointRot; else delete next[b];
    }
    replaceAll(withSet(poses, layer, next));
  };

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
        <Button variant="outline" size="sm" onClick={copyPose} data-testid="button-pose-copy">
          <Copy className="w-4 h-4 mr-1" /> Copy
        </Button>
        <Button variant="outline" size="sm" onClick={pastePose} disabled={!clip} data-testid="button-pose-paste">
          <ClipboardPaste className="w-4 h-4 mr-1" /> Paste
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
            {(fullGuard || pbOn) && (
              <Select value={String(guard)} onValueChange={v => setGuard(Number(v))}>
                <SelectTrigger className="h-8 text-xs w-48" data-testid="select-pose-guard"><SelectValue /></SelectTrigger>
                <SelectContent>{GUARD_STANCE_LABELS.map((l, i) => <SelectItem key={i} value={String(i)}>{l}</SelectItem>)}</SelectContent>
              </Select>
            )}
            <Button size="sm" variant={fullGuard ? "default" : "outline"} onClick={() => setFullGuard(g => !g)} data-testid="button-pose-guard">Full guard</Button>
            {pbOn && (
              <Select value={pbVar} onValueChange={v => setPbVar(v as PbVariant)}>
                <SelectTrigger className="h-8 text-xs w-40" data-testid="select-pose-pb"><SelectValue /></SelectTrigger>
                <SelectContent>{PB_VARIANTS.map(v => <SelectItem key={v} value={v}>{PB_LABELS[v]}</SelectItem>)}</SelectContent>
              </Select>
            )}
            <Button size="sm" variant={pbOn ? "default" : "outline"} onClick={() => setPbOn(p => !p)} data-testid="button-pose-pb">Perfect block</Button>
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
                onClick={() => { const n = { ...getSet(poses, selLayer) }; delete n[selected]; replaceAll(withSet(poses, selLayer, n)); }} data-testid="button-joint-reset">
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

          {pbOn && pbVar !== "standard" && (
            <div className="border-t border-border pt-3 flex flex-col gap-2" data-testid="panel-pb-variant">
              <div className="flex items-center">
                <div className="font-semibold mr-auto">{GUARD_STANCE_LABELS[guard]} perfect block: {PB_LABELS[pbVar]}</div>
                <Button variant="ghost" size="sm" disabled={!pbEntry.pose}
                  onClick={() => { const { pose: _drop, ...rest } = pbEntry; replaceAll(withPb(poses, guard, pbVar, rest)); }}
                  data-testid="button-pb-revert">
                  <RotateCcw className="w-3.5 h-3.5 mr-1" /> Revert to Standard
                </Button>
              </div>
              <div className="text-xs text-muted-foreground">Stances</div>
              <label className="flex items-center gap-2 text-sm">
                <Checkbox checked={pbEntry.enabled} data-testid="check-pb-enabled" onCheckedChange={c => setPbEntry({ enabled: !!c })} />
                {GUARD_STANCE_LABELS[guard]}
              </label>
              <label className="flex items-center gap-2 text-sm">
                <Checkbox checked={pbEntry.counter} onCheckedChange={c => setPbEntry({ counter: !!c })} data-testid="check-pb-counter" />
                Trigger counterpunch
              </label>
            </div>
          )}

          <div className="border-t border-border pt-3 flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <div className="font-semibold mr-auto">{duck ? "Duck hip height" : "Hip height"}</div>
              <Input type="number" className="h-7 w-20 text-right" min={-HIP_HEIGHT_MAX} max={HIP_HEIGHT_MAX} value={hip}
                onChange={e => editHip(Number(e.target.value) || 0)} data-testid="input-pose-hip-height" />
              <span className="text-xs text-muted-foreground">cm</span>
            </div>
            <Slider min={-HIP_HEIGHT_MAX} max={HIP_HEIGHT_MAX} step={1} value={[hip]}
              onValueChange={([v]) => editHip(v)} data-testid="slider-pose-hip-height" />
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
              {pb ? `${GUARD_STANCE_LABELS[guard]} perfect block (${PB_LABELS[pb]})` : duck ? "Duck" : fullGuard ? GUARD_STANCE_LABELS[guard] : "Stance"}: {editedCount} joint{editedCount === 1 ? "" : "s"} edited{dirty ? " · unsaved changes" : ""}
            </span>
            <Button variant="outline" size="sm" disabled={!editedCount} onClick={() => replaceAll(withSet(poses, layer, {}))} data-testid="button-pose-reset-all">
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
              duck: {Object.keys(poses.duck).length}, full guards: {FULL_GUARD_LAYERS.map(l => Object.keys(poses[l]).length).join("/")} joints
              edited; perfect block variants with their own pose: {poses.perfectBlocks.map(s => PB_VARIANTS.filter(v => v !== "standard" && s[v].pose).length).join("/")} of 7).
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
