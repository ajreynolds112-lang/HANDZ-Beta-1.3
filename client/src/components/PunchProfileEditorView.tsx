import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Copy, Pause, Play, Redo2, RotateCcw, Save, Star, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import PunchAnimEditor from "@/components/PunchAnimEditor";
import PunchTimelineLane, { type PhaseBand } from "@/components/PunchTimelineLane";
import { createPoseStage, GROUPS, JOINT_LABEL } from "@/components/poseStage";
import { createInitialState, punchPhaseFractions, punchTotalDuration } from "@/game/engine";
import type { PunchType } from "@/game/types";
import type { BoneName } from "@/game/three/fighterRig";
import {
  PROFILE_SLOTS, PUNCH_ROLES, PUNCH_ROLE_LABEL, type AxisTracks, type Key, type PunchProfile,
  copyProfileSlot, enginePunchForRole, fighterAtPunchTime, loadProfileStore, saveProfile, setDefaultSlot,
  realTimeOf, setPunchProfileDraft, speedSlowdown, warpTime,
} from "@/game/three/punchProfiles";

const AXIS_LANES = [
  { label: "X roll", color: "#ef4444" },
  { label: "Y turn", color: "#22c55e" },
  { label: "Z tilt", color: "#3b82f6" },
];
const RATES = [0.1, 0.25, 0.5, 1];
/** 1× playback spreads the punch over this many times its engine duration (the raw engine clock read as 10× too fast). */
const PLAYBACK_STRETCH = 10;
const PHASE_LABEL: Record<string, string> = { launchDelay: "Launch", armSpeed: "Extend", contact: "Contact", linger: "Linger", retraction: "Retract" };
const EMPTY_TRACKS = (): AxisTracks => [[], [], []];
const blank = (): PunchProfile => ({ name: "", bones: {}, speed: [] });
const clone = (p: PunchProfile): PunchProfile => JSON.parse(JSON.stringify(p));
const mirrorName = (b: BoneName): BoneName =>
  (b.startsWith("Left") ? "Right" + b.slice(4) : b.startsWith("Right") ? "Left" + b.slice(5) : b) as BoneName;
const slotLabel = (p: PunchProfile | null, i: number) => `#${i + 1} ${p ? (p.name || "Untitled") : "(empty)"}`;

/**
 * Neural Network → Punch Animation: keyframe each of the six punches on the 3D
 * boxer. Pick a joint (click it or the list) to get its X/Y/Z rotation lanes
 * under the looping playback track; a fifth lane re-times the punch. Saved
 * profiles live in 50 slots per punch; southpaw wears the exact mirror.
 */
export default function PunchProfileEditorView({ onBack }: { onBack: () => void }) {
  const [role, setRole] = useState<PunchType>("jab");
  const [slot, setSlot] = useState(0);
  const [store, setStore] = useState(() => loadProfileStore());
  const [draft, setDraft] = useState<PunchProfile>(() => clone(loadProfileStore().slots.jab[0] ?? blank()));
  const [savedSnap, setSavedSnap] = useState(() => JSON.stringify(loadProfileStore().slots.jab[0] ?? blank()));
  const [selected, setSelected] = useState<BoneName>("LeftArm");
  const [southpaw, setSouthpaw] = useState(false);
  const [playing, setPlaying] = useState(true);
  const [rate, setRate] = useState(1);
  const [u, setU] = useState(0);
  const [copyTo, setCopyTo] = useState(1);
  const [confirmSave, setConfirmSave] = useState(false);
  const [makeDefault, setMakeDefault] = useState(true);
  const [confirmCopy, setConfirmCopy] = useState(false);
  const [pendingSwitch, setPendingSwitch] = useState<{ role: PunchType; slot: number } | "leave" | null>(null);
  const [showBase, setShowBase] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const dirty = JSON.stringify(draft) !== savedSnap;
  useEffect(() => { setCopyTo(c => (c === slot ? (slot + 1) % PROFILE_SLOTS : c)); }, [slot]);

  // ── undo ──
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const undoRef = useRef<PunchProfile[]>([]);
  const redoRef = useRef<PunchProfile[]>([]);
  const [, bump] = useState(0);
  const checkpoint = useCallback(() => {
    undoRef.current.push(draftRef.current);
    if (undoRef.current.length > 200) undoRef.current.shift();
    redoRef.current = [];
    bump(n => n + 1);
  }, []);
  const undo = useCallback(() => {
    const prev = undoRef.current.pop();
    if (!prev) return;
    redoRef.current.push(draftRef.current);
    setDraft(prev);
  }, []);
  const redo = useCallback(() => {
    const next = redoRef.current.pop();
    if (!next) return;
    undoRef.current.push(draftRef.current);
    setDraft(next);
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) redo(); else undo();
      } else if (e.key === " " && !(e.target instanceof HTMLInputElement)) {
        e.preventDefault();
        setPlaying(p => !p);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo]);

  // ── renderer draft ──
  useEffect(() => { setPunchProfileDraft({ role, profile: draft }); }, [role, draft]);
  useEffect(() => () => setPunchProfileDraft(null), []);

  // ── punch timing for the preview fighter ──
  const sample = useMemo(() => createInitialState().player, []);
  // Lanes are keyed on the stock (animation-time) timeline; the playback bar and
  // its clock are real time, which the speed track stretches/squeezes per phase
  // exactly as the engine does in a fight.
  const { duration, bands, realBands } = useMemo(() => {
    const punch = enginePunchForRole(role, southpaw);
    const f = { ...sample, isPunching: true, currentPunch: punch, isRePunch: false, isCharging: false };
    const fr = punchPhaseFractions(f, true);
    const b: PhaseBand[] = fr
      ? Object.entries(fr).filter(([, [a, z]]) => z - a > 1e-6).map(([k, [a, z]]) => ({ label: PHASE_LABEL[k] ?? k, from: a, to: z }))
      : [];
    const rb = b.map(x => ({ ...x, from: realTimeOf(draft.speed, x.from), to: realTimeOf(draft.speed, x.to) }));
    const total = punchTotalDuration(f, punch, true) * speedSlowdown(draft.speed, 0, 1);
    return { duration: Math.max(0.05, total), bands: b, realBands: rb };
  }, [role, southpaw, sample, draft.speed]);

  // ── playback clock ──
  const uRef = useRef(u);
  const playRef = useRef({ playing, rate, duration });
  playRef.current = { playing, rate, duration };
  useEffect(() => {
    let raf = 0, last = performance.now();
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const p = playRef.current;
      if (!p.playing) return;
      uRef.current = (uRef.current + dt * p.rate / (p.duration * PLAYBACK_STRETCH)) % 1;
      setU(uRef.current);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);
  const tau = warpTime(draft.speed, u);

  // ── 3D stage ──
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef({ role, southpaw, selected });
  viewRef.current = { role, southpaw, selected };
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    return createPoseStage(host, () => {
      const v = viewRef.current;
      return {
        southpaw: v.southpaw,
        fullGuard: false,
        selected: v.southpaw ? mirrorName(v.selected) : v.selected,
        pose: (a) => {
          a.isPunching = true;
          a.currentPunch = enginePunchForRole(v.role, v.southpaw);
          a.isFeinting = false;
          a.isRePunch = false;
          a.isCharging = false;
          // Engine state at the real-time fraction; the renderer applies the profile's warp.
          Object.assign(a, fighterAtPunchTime(a, uRef.current, true));
        },
      };
    }, b => setSelected(viewRef.current.southpaw ? mirrorName(b) : b));
  }, []);

  // ── scrubbing ──
  const scrubRef = useRef<HTMLDivElement>(null);
  const scrubAt = (clientX: number) => {
    const r = scrubRef.current!.getBoundingClientRect();
    uRef.current = Math.max(0, Math.min(0.9999, (clientX - r.left) / r.width));
    setU(uRef.current);
  };

  // ── editing ──
  const tracks = draft.bones[selected] ?? EMPTY_TRACKS();
  const setAxis = (axis: number, keys: Key[]) => {
    setDraft(d => {
      const cur = d.bones[selected] ?? EMPTY_TRACKS();
      const next = [...cur] as AxisTracks;
      next[axis] = keys;
      const bones = { ...d.bones };
      if (next.some(k => k.length)) bones[selected] = next; else delete bones[selected];
      return { ...d, bones };
    });
  };
  const clearJoint = () => {
    checkpoint();
    setDraft(d => { const bones = { ...d.bones }; delete bones[selected]; return { ...d, bones }; });
  };

  // ── slots ──
  const load = (r: PunchType, s: number) => {
    const st = loadProfileStore();
    setStore(st);
    const p = st.slots[r][s] ?? blank();
    setRole(r);
    setSlot(s);
    setDraft(clone(p));
    setSavedSnap(JSON.stringify(p));
    undoRef.current = [];
    redoRef.current = [];
    setJustSaved(false);
  };
  const requestSwitch = (r: PunchType, s: number) => {
    if (r === role && s === slot) return;
    if (dirty) setPendingSwitch({ role: r, slot: s }); else load(r, s);
  };
  const slots = store.slots[role];
  const isDefault = store.active[role] === slot;
  const keyedBones = Object.keys(draft.bones).length;

  return (
    <div className="flex flex-col h-full w-full gap-2 p-3 overflow-hidden" data-testid="punch-profile-editor">
      <div className="flex items-center gap-2 flex-wrap">
        <Button variant="ghost" size="sm" onClick={() => (dirty ? setPendingSwitch("leave") : onBack())} data-testid="button-punchanim-back">
          <ArrowLeft className="w-4 h-4 mr-1" /> Back
        </Button>
        <h2 className="text-lg font-bold mr-2">Punch Animation</h2>
        <div className="flex gap-1 flex-wrap mr-auto">
          {PUNCH_ROLES.map(r => (
            <Button key={r} size="sm" className="h-7 px-2 text-xs" variant={r === role ? "default" : "outline"}
              onClick={() => requestSwitch(r, store.active[r] >= 0 ? store.active[r] : 0)} data-testid={`button-punchanim-role-${r}`}>
              {PUNCH_ROLE_LABEL[r]}
            </Button>
          ))}
        </div>
        <Button variant="outline" size="sm" onClick={() => setShowBase(b => !b)} data-testid="button-punchanim-base">
          {showBase ? "Keyframes" : "Base params"}
        </Button>
        <Button variant="outline" size="sm" onClick={undo} disabled={!undoRef.current.length} title="Undo (Cmd/Ctrl+Z)" data-testid="button-punchanim-undo">
          <Undo2 className="w-4 h-4" />
        </Button>
        <Button variant="outline" size="sm" onClick={redo} disabled={!redoRef.current.length} title="Redo (Shift+Cmd/Ctrl+Z)" data-testid="button-punchanim-redo">
          <Redo2 className="w-4 h-4" />
        </Button>
        <Button size="sm" onClick={() => { setMakeDefault(isDefault || store.active[role] < 0); setConfirmSave(true); }} data-testid="button-punchanim-save">
          <Save className="w-4 h-4 mr-1" /> {justSaved && !dirty ? "Saved" : "Save"}
        </Button>
      </div>

      {showBase ? (
        <div className="flex-1 min-h-0 overflow-y-auto"><PunchAnimEditor defaultExpanded /></div>
      ) : (
        <>
          <div className="flex flex-1 min-h-0 gap-2 flex-col lg:flex-row">
            <div className="relative flex-1 min-h-[260px] rounded-md overflow-hidden border border-border">
              <div ref={hostRef} className="absolute inset-0" />
              <div className="absolute left-2 bottom-2 text-[11px] text-white/60 pointer-events-none">
                Drag to orbit · Shift-drag to raise/lower · Scroll to zoom · Click a joint · Space plays/pauses
              </div>
              <div className="absolute right-2 top-2 flex gap-1">
                <Button size="sm" variant={southpaw ? "outline" : "default"} onClick={() => setSouthpaw(false)} data-testid="button-punchanim-orthodox">Orthodox</Button>
                <Button size="sm" variant={southpaw ? "default" : "outline"} onClick={() => setSouthpaw(true)} data-testid="button-punchanim-southpaw">Southpaw</Button>
              </div>
              {southpaw && (
                <div className="absolute left-2 top-2 text-[11px] bg-black/60 text-white/80 rounded px-2 py-1 max-w-[260px]">
                  Southpaw wears the exact mirror. The lanes edit the orthodox profile.
                </div>
              )}
            </div>

            <Card className="w-full lg:w-[320px] p-3 flex flex-col gap-3 overflow-y-auto">
              <div className="flex flex-col gap-1.5">
                <div className="text-xs text-muted-foreground">{PUNCH_ROLE_LABEL[role]} profile slot</div>
                <Select value={String(slot)} onValueChange={v => requestSwitch(role, Number(v))}>
                  <SelectTrigger className="h-8" data-testid="select-punchanim-slot"><SelectValue /></SelectTrigger>
                  <SelectContent className="max-h-72">
                    {slots.map((p, i) => (
                      <SelectItem key={i} value={String(i)}>{slotLabel(p, i)}{store.active[role] === i ? " ★" : ""}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Input className="h-8" placeholder="Profile name" maxLength={40} value={draft.name}
                  onChange={e => setDraft(d => ({ ...d, name: e.target.value }))} data-testid="input-punchanim-name" />
                <div className="flex gap-1">
                  <Button size="sm" variant="outline" className="flex-1 h-7 text-xs" disabled={!slots[slot] || isDefault}
                    onClick={() => { setDefaultSlot(role, slot); setStore(loadProfileStore()); }} data-testid="button-punchanim-default">
                    <Star className="w-3 h-3 mr-1" /> {isDefault ? "Default" : "Make default"}
                  </Button>
                  <Button size="sm" variant="outline" className="flex-1 h-7 text-xs" disabled={store.active[role] < 0}
                    onClick={() => { setDefaultSlot(role, -1); setStore(loadProfileStore()); }} data-testid="button-punchanim-stock">
                    Use stock
                  </Button>
                </div>
                <div className="flex gap-1 items-center">
                  <Select value={String(copyTo)} onValueChange={v => setCopyTo(Number(v))}>
                    <SelectTrigger className="h-7 text-xs flex-1" data-testid="select-punchanim-copyto"><SelectValue /></SelectTrigger>
                    <SelectContent className="max-h-72">
                      {slots.map((p, i) => i === slot ? null : <SelectItem key={i} value={String(i)}>{slotLabel(p, i)}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  <Button size="sm" variant="outline" className="h-7 text-xs" disabled={!slots[slot] || copyTo === slot}
                    onClick={() => setConfirmCopy(true)} data-testid="button-punchanim-copy">
                    <Copy className="w-3 h-3 mr-1" /> Copy
                  </Button>
                </div>
                <p className="text-[11px] text-muted-foreground">
                  The default (★) is worn by you and any opponent without an assigned profile. Copy copies the saved slot.
                </p>
              </div>

              <div className="border-t border-border pt-2 flex flex-col gap-2">
                {GROUPS.map(([g, bones]) => (
                  <div key={g}>
                    <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{g}</div>
                    <div className="flex flex-wrap gap-1 mt-1">
                      {bones.map(b => (
                        <Button key={b} size="sm" variant={b === selected ? "default" : "outline"} className="h-6 px-1.5 text-[11px]"
                          onClick={() => setSelected(b)} data-testid={`button-punchanim-joint-${b}`}>
                          {JOINT_LABEL[b]}{draft.bones[b] ? " •" : ""}
                        </Button>
                      ))}
                    </div>
                  </div>
                ))}
                <div className="text-[11px] text-muted-foreground">{keyedBones} joint{keyedBones === 1 ? "" : "s"} keyed{dirty ? " · unsaved changes" : ""}</div>
              </div>
            </Card>
          </div>

          <Card className="p-2 flex flex-col gap-1.5 shrink-0" onContextMenu={e => e.preventDefault()}>
            <div className="flex items-center gap-2">
              <div className="w-20 shrink-0 flex items-center gap-1">
                <Button size="icon" variant="outline" className="h-7 w-7" onClick={() => setPlaying(p => !p)} data-testid="button-punchanim-play">
                  {playing ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
                </Button>
                <Select value={String(rate)} onValueChange={v => setRate(Number(v))}>
                  <SelectTrigger className="h-7 w-[52px] px-1 text-[11px]" data-testid="select-punchanim-rate"><SelectValue /></SelectTrigger>
                  <SelectContent>{RATES.map(r => <SelectItem key={r} value={String(r)}>{r}×</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <div ref={scrubRef} className="relative flex-1 h-7 rounded bg-black/50 border border-border cursor-pointer select-none overflow-hidden"
                style={{ touchAction: "none" }}
                onPointerDown={e => { if (e.button !== 0) return; e.currentTarget.setPointerCapture(e.pointerId); scrubAt(e.clientX); }}
                onPointerMove={e => { if (e.currentTarget.hasPointerCapture(e.pointerId)) scrubAt(e.clientX); }}
                data-testid="track-punchanim-playback">
                {realBands.map((b, i) => (
                  <div key={b.label} className="absolute inset-y-0 flex items-center justify-center text-[9px] text-white/45 overflow-hidden"
                    style={{ left: `${b.from * 100}%`, width: `${(b.to - b.from) * 100}%`, background: i % 2 ? "rgba(255,255,255,0.06)" : "transparent" }}>
                    {b.to - b.from > 0.08 ? b.label : ""}
                  </div>
                ))}
                <div className="absolute inset-y-0 w-0.5 bg-yellow-300" style={{ left: `${u * 100}%` }} />
              </div>
              <span className="w-24 text-[11px] text-muted-foreground tabular-nums text-right">
                {(u * duration).toFixed(2)}s / {duration.toFixed(2)}s
              </span>
            </div>
            <div className="flex items-center gap-2 text-[11px] text-muted-foreground pl-[88px]">
              <span className="font-semibold text-foreground mr-auto">{JOINT_LABEL[selected]}</span>
              <span>Right-click adds or removes a point · drag a point to move it · Shift-click copies a point · Shift-right-click pastes</span>
              <Button size="sm" variant="ghost" className="h-6 text-[11px]" disabled={!draft.bones[selected]} onClick={clearJoint} data-testid="button-punchanim-clear-joint">
                <RotateCcw className="w-3 h-3 mr-1" /> Clear joint
              </Button>
            </div>
            {AXIS_LANES.map((ax, i) => (
              <PunchTimelineLane key={`${selected}-${i}`} label={ax.label} kind="rotation" color={ax.color} keys={tracks[i]}
                playhead={tau} bands={bands} onBeginEdit={checkpoint} onChange={k => setAxis(i, k)} testId={`lane-punchanim-${"xyz"[i]}`} />
            ))}
            <PunchTimelineLane label="Speed" kind="speed" color="#eab308" keys={draft.speed} playhead={tau} bands={bands} height={52}
              onBeginEdit={checkpoint} onChange={k => setDraft(d => ({ ...d, speed: k }))} testId="lane-punchanim-speed" />
          </Card>
        </>
      )}

      <AlertDialog open={confirmSave} onOpenChange={setConfirmSave}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Save {PUNCH_ROLE_LABEL[role]} profile to slot #{slot + 1}?</AlertDialogTitle>
            <AlertDialogDescription>
              {slots[slot] ? `This replaces "${slots[slot]!.name || "Untitled"}". ` : ""}
              {keyedBones} joint{keyedBones === 1 ? "" : "s"} keyed{draft.speed.length ? ", speed track set" : ""}. Southpaw uses its mirror.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={makeDefault} onCheckedChange={v => setMakeDefault(!!v)} data-testid="checkbox-punchanim-make-default" />
            Make this the default {PUNCH_ROLE_LABEL[role]} (you and unassigned opponents)
          </label>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction data-testid="button-punchanim-save-confirm" onClick={() => {
              saveProfile(role, slot, draft, makeDefault);
              const st = loadProfileStore();
              setStore(st);
              setSavedSnap(JSON.stringify(st.slots[role][slot] ?? blank()));
              setDraft(clone(st.slots[role][slot] ?? blank()));
              setJustSaved(true);
            }}>Save</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmCopy} onOpenChange={setConfirmCopy}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Copy slot #{slot + 1} to slot #{copyTo + 1}?</AlertDialogTitle>
            <AlertDialogDescription>
              {slots[copyTo] ? `Slot #${copyTo + 1} ("${slots[copyTo]!.name || "Untitled"}") will be overwritten. ` : ""}
              The saved version of slot #{slot + 1} is copied{dirty ? " (your unsaved edits are not included)" : ""}.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction data-testid="button-punchanim-copy-confirm" onClick={() => {
              copyProfileSlot(role, slot, copyTo);
              setStore(loadProfileStore());
            }}>Copy</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={pendingSwitch != null} onOpenChange={o => { if (!o) setPendingSwitch(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard unsaved changes?</AlertDialogTitle>
            <AlertDialogDescription>Your edits to {PUNCH_ROLE_LABEL[role]} slot #{slot + 1} since the last save will be lost.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep editing</AlertDialogCancel>
            <AlertDialogAction data-testid="button-punchanim-discard" onClick={() => {
              const p = pendingSwitch;
              setPendingSwitch(null);
              if (p === "leave") onBack(); else if (p) load(p.role, p.slot);
            }}>Discard</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
