import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Download, Trash2, Upload } from "lucide-react";
import type { Fighter, FightingStyleSave, SavedFightingStyle } from "@shared/schema";
import * as localSaves from "@/lib/localSaves";
import { ANIM_SETS, BASE_STANCES, STYLE_NAME_MAX, cleanStyle, fightingStyleOf, styleForBase } from "@/game/fightingStyle";
import { createPoseStage } from "./poseStage";
import { trainingColors } from "@/lib/trainingColors";
import { PB_LABELS, PB_VARIANTS, shoulderRollEnabled } from "@/game/three/poseOffsets";
import { PUNCH_ROLES, PUNCH_ROLE_LABEL, enginePunchForRole, fighterAtPunchTime } from "@/game/three/punchProfiles";

type PreviewMode = "stance" | "defense" | "punches";
/** focus: one defensive variant / punch (index) looped on its own; unset = cycle them all. */
interface Preview { base: number; defense: number[]; punches: number[]; mode: PreviewMode; focus?: number }

const FILE_KIND = "handz-fighting-style";
const NONE = "none";
const PB_SEC = 1.2, PB_ON = 0.8, PUNCH_SEC = 1.1, PUNCH_REST = 0.5;

const activeKey = (a: FightingStyleSave["active"]) => (a ? `${a.kind}:${a.index}` : NONE);
const presetStyle = styleForBase;
const previewOf = (s: Omit<SavedFightingStyle, "name">, mode: PreviewMode, focus?: number): Preview => ({ base: s.base, defense: s.defense, punches: s.punches, mode, focus });

/** Career Fighting Style card: style in use, 5 named custom styles, a looping 3D preview, upload/download, confirm-save. */
export default function FightingStyleDialog({ open, onOpenChange, fighter, onSaved }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  fighter: Fighter;
  onSaved?: (f: Fighter) => void;
}) {
  const [draft, setDraft] = useState<FightingStyleSave>(() => fightingStyleOf(fighter.fightingStyle));
  const colorsRef = useRef(trainingColors(fighter));
  const [slot, setSlot] = useState(0);
  const [preview, setPreview] = useState<Preview>({ ...presetStyle(0), mode: "stance" });
  const [confirming, setConfirming] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // Fresh from the save only when the card opens: the gym re-passes the fighter
  // often, and reloading on that would wipe edits in progress.
  const fighterRef = useRef(fighter);
  fighterRef.current = fighter;
  useEffect(() => {
    if (!open) return;
    const fighter = fighterRef.current;
    colorsRef.current = trainingColors(fighter);
    const d = fightingStyleOf((localSaves.getFighter(fighter.id) ?? fighter).fightingStyle);
    setDraft(d);
    const a = d.active;
    const s = a?.kind === "custom" ? d.custom[a.index] : null;
    setSlot(a?.kind === "custom" ? a.index : 0);
    setPreview({ ...(s ?? presetStyle(a?.kind === "preset" ? a.index : 0)), mode: "stance" });
  }, [open]);

  // ── 3D preview: the picked animation set, looping ──
  const previewRef = useRef(preview);
  previewRef.current = preview;
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!host) return;
    const t0 = performance.now();
    return createPoseStage(host, () => {
      const p = previewRef.current;
      const t = (performance.now() - t0) / 1000;
      const southpaw = p.base % 2 === 1;
      const pbs = PB_VARIANTS.filter(v => v !== "shoulderRoll" || shoulderRollEnabled(0, p.defense));
      const focusPb = p.mode === "defense" && p.focus != null ? PB_VARIANTS[p.focus] : null;
      return {
        southpaw,
        colors: colorsRef.current,
        fullGuard: true,
        guardStance: Math.floor(p.base / 2),
        selected: null,
        pbPreview: p.mode !== "defense" ? undefined
          : focusPb ? (t % PB_SEC < PB_ON ? focusPb : undefined)
          : pbs[Math.floor(t / PB_SEC) % pbs.length],
        pose: a => {
          a.defenseStance = p.defense;
          a.punchStance = p.punches;
          if (p.mode !== "punches") return;
          const cycle = PUNCH_SEC + PUNCH_REST;
          const u = (t % cycle) / PUNCH_SEC;
          if (u >= 1) return;
          a.isPunching = true;
          a.currentPunch = enginePunchForRole(PUNCH_ROLES[p.focus ?? Math.floor(t / cycle) % PUNCH_ROLES.length], southpaw);
          a.isFeinting = false;
          a.isRePunch = false;
          a.isCharging = false;
          Object.assign(a, fighterAtPunchTime(a, u, true));
        },
      };
    }, () => {});
  }, [host]);

  const cur = draft.custom[slot];
  const writeSlot = (s: SavedFightingStyle | null) => {
    const custom = draft.custom.map((c, i) => (i === slot ? s : c));
    const a = draft.active;
    setDraft({ custom, active: a?.kind === "custom" && !custom[a.index] ? null : a });
  };
  const editSlot = (patch: Partial<SavedFightingStyle>, mode: PreviewMode, focus?: number) => {
    if (!cur) return;
    const s = { ...cur, ...patch };
    writeSlot(s);
    setPreview(previewOf(s, mode, focus));
  };
  const setAt = (a: number[], i: number, n: number) => a.map((x, j) => (j === i ? n : x));
  const pickSlot = (i: number) => {
    setSlot(i);
    const s = draft.custom[i];
    if (s) setPreview(previewOf(s, "stance"));
  };
  const pickActive = (v: string) => {
    if (v === NONE) { setDraft({ ...draft, active: null }); return; }
    const [kind, n] = v.split(":");
    const index = Number(n);
    setDraft({ ...draft, active: { kind: kind as "preset" | "custom", index } });
    const s = kind === "custom" ? draft.custom[index] : null;
    setPreview({ ...(s ?? presetStyle(index)), mode: "stance" });
  };

  const download = () => {
    const blob = new Blob([JSON.stringify({ kind: FILE_KIND, version: 1, custom: draft.custom }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${(fighter.name || "fighter").replace(/[^a-z0-9]+/gi, "_")}_fighting_styles.json`;
    a.click();
    URL.revokeObjectURL(url);
  };
  const upload = async (file: File) => {
    try {
      const data = JSON.parse(await file.text());
      if (data?.kind !== FILE_KIND || !Array.isArray(data.custom)) throw new Error("not a style file");
      const custom = draft.custom.map((c, i) => (data.custom[i] ? cleanStyle(data.custom[i], i) : c));
      setDraft({ ...draft, custom });
    } catch {
      alert("That file is not a HANDZ fighting style file.");
    }
  };

  const save = () => {
    const updated = localSaves.updateFighter(fighter.id, { fightingStyle: draft });
    if (updated) onSaved?.(updated);
    setConfirming(false);
    onOpenChange(false);
  };

  const animSelect = (label: string, value: number, onChange: (n: number) => void, mode: PreviewMode, testId: string, options: readonly string[] = ANIM_SETS, focus?: number) => (
    <label className="block space-y-1">
      <span className="text-[11px] text-white/60 font-semibold">{label}</span>
      <Select
        value={String(value)}
        onValueChange={v => onChange(Number(v))}
        onOpenChange={o => { if (o && cur) setPreview(previewOf(cur, mode, focus)); }}
      >
        <SelectTrigger className="h-8 text-xs bg-black/60 border-white/20" data-testid={testId}><SelectValue /></SelectTrigger>
        <SelectContent>
          {options.map((l, i) => <SelectItem key={i} value={String(i)}>{l}</SelectItem>)}
        </SelectContent>
      </Select>
    </label>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-[#1a1a1a] border-white/15 text-white max-w-none w-[94vw] h-[90vh] flex flex-col" data-testid="panel-fighting-style">
        <DialogHeader>
          <DialogTitle className="text-yellow-400 font-black italic uppercase">Fighting Style</DialogTitle>
        </DialogHeader>
        <div className="grid grid-cols-[3fr_2fr] gap-4 flex-1 min-h-0">
          <div className="flex flex-col gap-2 min-h-0">
            <div ref={setHost} className="flex-1 min-h-0 rounded-lg overflow-hidden border border-white/10" data-testid="fighting-style-preview" />
            <div className="flex gap-1">
              {(["stance", "defense", "punches"] as const).map(m => (
                <Button
                  key={m} size="sm" variant="ghost"
                  className={`flex-1 h-7 text-xs ${preview.mode === m ? "bg-white/15 text-white" : "text-white/60"}`}
                  onClick={() => setPreview({ ...preview, mode: m, focus: undefined })}
                  data-testid={`button-style-preview-${m}`}
                >
                  {m === "stance" ? "Stance" : m === "defense" ? "Defense" : "Punches"}
                </Button>
              ))}
            </div>
          </div>
          <div className="space-y-3 overflow-y-auto min-h-0">
            <label className="block space-y-1">
              <span className="text-[11px] text-white/60 font-semibold">Style in use</span>
              <Select value={activeKey(draft.active)} onValueChange={pickActive}>
                <SelectTrigger className="h-8 text-xs bg-black/60 border-white/20" data-testid="select-style-active"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>None</SelectItem>
                  {BASE_STANCES.map((l, i) => <SelectItem key={l} value={`preset:${i}`}>{l}</SelectItem>)}
                  {draft.custom.map((c, i) => c && <SelectItem key={`c${i}`} value={`custom:${i}`}>{c.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </label>
            <div className="space-y-2 bg-black/30 border border-white/10 rounded-lg p-2">
              <div className="flex gap-1">
                {draft.custom.map((c, i) => (
                  <Button
                    key={i} size="sm" variant="ghost"
                    className={`flex-1 min-w-0 h-7 px-1 text-[11px] truncate ${slot === i ? "bg-white/15 text-white" : c ? "text-white/70" : "text-white/30 italic"}`}
                    onClick={() => pickSlot(i)}
                    data-testid={`button-style-slot-${i}`}
                  >
                    <span className="truncate">{c ? c.name : `${i + 1}`}</span>
                  </Button>
                ))}
              </div>
              {cur ? <>
                <div className="flex items-center gap-1">
                  <Input
                    value={cur.name}
                    maxLength={STYLE_NAME_MAX}
                    onChange={e => writeSlot({ ...cur, name: e.target.value.slice(0, STYLE_NAME_MAX) })}
                    onBlur={() => { if (!cur.name.trim()) writeSlot({ ...cur, name: `Style ${slot + 1}` }); }}
                    onKeyDown={e => e.stopPropagation()}
                    className="h-8 text-xs bg-black/60 border-white/20 text-white"
                    data-testid="input-style-name"
                  />
                  <Button
                    size="icon" variant="ghost" className="h-8 w-8 text-red-400/80 hover:text-red-300 shrink-0"
                    title="Delete" aria-label="Delete" onClick={() => writeSlot(null)}
                    data-testid="button-style-delete"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </Button>
                </div>
                {animSelect("Base Stance", cur.base, n => editSlot({ base: n }, "stance"), "stance", "select-style-base", BASE_STANCES)}
                <div className="text-[11px] text-white/80 font-bold pt-1">Defensive Animations</div>
                <div className="grid grid-cols-2 gap-2">
                  {PB_VARIANTS.map((v, i) => <div key={v}>{animSelect(PB_LABELS[v], cur.defense[i], n => editSlot({ defense: setAt(cur.defense, i, n) }, "defense", i), "defense", `select-style-defense-${v}`, ANIM_SETS, i)}</div>)}
                </div>
                <div className="text-[11px] text-white/80 font-bold pt-1">Punch Animations</div>
                <div className="grid grid-cols-2 gap-2">
                  {PUNCH_ROLES.map((r, i) => <div key={r}>{animSelect(PUNCH_ROLE_LABEL[r], cur.punches[i], n => editSlot({ punches: setAt(cur.punches, i, n) }, "punches", i), "punches", `select-style-punch-${r}`, ANIM_SETS, i)}</div>)}
                </div>
              </> : (
                <Button
                  size="sm" variant="outline"
                  className="w-full bg-black/40 border-white/20 text-white hover:bg-white/10 hover:text-white"
                  onClick={() => { writeSlot({ name: `Style ${slot + 1}`, ...presetStyle(0) }); setPreview({ ...presetStyle(0), mode: "stance" }); }}
                  data-testid="button-style-create"
                >
                  Create Style
                </Button>
              )}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 pt-1">
          <input
            ref={fileRef} type="file" accept="application/json,.json" className="hidden"
            onChange={e => { const f = e.target.files?.[0]; if (f) upload(f); e.target.value = ""; }}
            data-testid="input-style-upload"
          />
          <Button size="sm" variant="ghost" className="gap-1 text-white/70 hover:text-white" onClick={() => fileRef.current?.click()} data-testid="button-style-upload">
            <Upload className="w-3.5 h-3.5" /> Upload
          </Button>
          <Button size="sm" variant="ghost" className="gap-1 text-white/70 hover:text-white" onClick={download} data-testid="button-style-download">
            <Download className="w-3.5 h-3.5" /> Download
          </Button>
          <div className="flex-1" />
          <Button size="sm" variant="ghost" className="text-white/60 hover:text-white" onClick={() => onOpenChange(false)} data-testid="button-style-cancel">Cancel</Button>
          <Button size="sm" className="bg-[#634b3b] hover:bg-[#7a5c4a] text-white" onClick={() => setConfirming(true)} data-testid="button-style-save">Save</Button>
        </div>

        <AlertDialog open={confirming} onOpenChange={setConfirming}>
          <AlertDialogContent className="bg-[#1a1a1a] border-white/15 text-white">
            <AlertDialogHeader>
              <AlertDialogTitle>Save fighting style?</AlertDialogTitle>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel className="bg-transparent border-white/20 text-white hover:bg-white/10" data-testid="button-style-confirm-cancel">Cancel</AlertDialogCancel>
              <AlertDialogAction className="bg-[#634b3b] hover:bg-[#7a5c4a] text-white" onClick={save} data-testid="button-style-confirm">Save</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </DialogContent>
    </Dialog>
  );
}
