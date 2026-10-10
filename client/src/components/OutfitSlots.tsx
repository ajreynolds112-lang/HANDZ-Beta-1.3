import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Copy, Download, Pencil, Save, Shirt, Trash2 } from "lucide-react";
import { OUTFIT_SLOT_COUNT, type GearColors, type SavedOutfit } from "@shared/schema";
import { cssColorOf, SPACIAL_COLOR } from "@/game/spacialColor";

const NAME_MAX = 24;

/** Always exactly OUTFIT_SLOT_COUNT entries; anything malformed reads as an empty slot. */
export function outfitSlotsOf(raw: unknown): (SavedOutfit | null)[] {
  const list = Array.isArray(raw) ? raw : [];
  return Array.from({ length: OUTFIT_SLOT_COUNT }, (_, i) => {
    const o = list[i] as SavedOutfit | null | undefined;
    if (!o || typeof o !== "object" || !o.gearColors || typeof o.gearColors !== "object") return null;
    return {
      name: typeof o.name === "string" && o.name.trim() ? o.name.slice(0, NAME_MAX) : `Outfit ${i + 1}`,
      gearColors: { ...o.gearColors },
      spacialParts: Array.isArray(o.spacialParts) ? o.spacialParts.filter(k => typeof k === "string") : [],
    };
  });
}

/** Swatch order shown on a slot card. */
const SWATCH_KEYS: (keyof GearColors)[] = ["gloves", "gloveTape", "trunks", "shoes", "socks", "headgear"];

function Swatches({ outfit }: { outfit: SavedOutfit }) {
  return (
    <div className="flex gap-0.5">
      {SWATCH_KEYS.map(k => {
        const v = outfit.spacialParts.includes(k) ? SPACIAL_COLOR : outfit.gearColors[k];
        if (!v) return null;
        return (
          <span
            key={k}
            className="w-3.5 h-3.5 rounded-sm border border-white/20"
            style={{ background: cssColorOf(v) }}
          />
        );
      })}
    </div>
  );
}

/**
 * The five named outfit slots in the career colour editor, behind a button that
 * opens them as a popup card. Slot edits persist at once through `onChange`;
 * loading only fills the editor (and closes the card), which still needs Save
 * Colors to be worn.
 */
export default function OutfitSlots({ outfits, current, onChange, onLoad }: {
  outfits: (SavedOutfit | null)[];
  /** The editor's colours right now, as an outfit to save into a slot. */
  current: () => Omit<SavedOutfit, "name">;
  onChange: (next: (SavedOutfit | null)[]) => void;
  onLoad: (outfit: SavedOutfit) => void;
}) {
  const [open, setOpen] = useState(false);
  const [renaming, setRenaming] = useState<number | null>(null);
  const [draftName, setDraftName] = useState("");
  const [confirm, setConfirm] = useState<{ kind: "delete" | "overwrite"; slot: number } | null>(null);

  const write = (slot: number, value: SavedOutfit | null) =>
    onChange(outfits.map((o, i) => (i === slot ? value : o)));

  const saveInto = (slot: number) => {
    const name = outfits[slot]?.name ?? `Outfit ${slot + 1}`;
    write(slot, { name, ...current() });
  };

  const firstEmpty = outfits.findIndex(o => !o);
  const copy = (slot: number) => {
    const src = outfits[slot];
    if (!src || firstEmpty < 0) return;
    const name = `${src.name} copy`.slice(0, NAME_MAX);
    write(firstEmpty, { name, gearColors: { ...src.gearColors }, spacialParts: [...src.spacialParts] });
  };

  const commitRename = () => {
    if (renaming == null) return;
    const src = outfits[renaming];
    const name = draftName.trim().slice(0, NAME_MAX);
    if (src && name) write(renaming, { ...src, name });
    setRenaming(null);
  };

  const confirmSlot = confirm ? outfits[confirm.slot] : null;

  return (
    <Dialog open={open} onOpenChange={o => { setOpen(o); if (!o) setRenaming(null); }}>
      <DialogTrigger asChild>
        <Button
          variant="outline"
          className="gap-2 bg-black/40 border-white/20 text-white hover:bg-white/10 hover:text-white"
          data-testid="button-open-outfits"
        >
          <Shirt className="w-4 h-4" /> Outfits
        </Button>
      </DialogTrigger>
      <DialogContent className="bg-[#1a1a1a] border-white/15 text-white max-w-md space-y-2" data-testid="panel-outfits">
      <DialogHeader>
        <DialogTitle className="text-yellow-400 font-black italic uppercase">Outfits</DialogTitle>
      </DialogHeader>
      {outfits.map((o, i) => (
        <div
          key={i}
          className="flex items-center gap-2 bg-black/40 border border-white/10 rounded-lg px-3 py-2"
          data-testid={`outfit-slot-${i}`}
        >
          <span className="text-[10px] text-white/30 font-mono w-3 shrink-0">{i + 1}</span>
          <div className="flex-1 min-w-0">
            {renaming === i ? (
              <Input
                autoFocus
                value={draftName}
                maxLength={NAME_MAX}
                onChange={e => setDraftName(e.target.value)}
                onBlur={commitRename}
                onKeyDown={e => {
                  e.stopPropagation();
                  if (e.key === "Enter") commitRename();
                  else if (e.key === "Escape") setRenaming(null);
                }}
                className="h-7 text-xs bg-black/60 border-white/20 text-white"
                data-testid={`input-outfit-name-${i}`}
              />
            ) : o ? (
              <div className="flex items-center gap-2 min-w-0">
                <span className="text-xs text-white font-semibold truncate" data-testid={`text-outfit-name-${i}`}>{o.name}</span>
                <Swatches outfit={o} />
              </div>
            ) : (
              <span className="text-xs text-white/30 italic">Empty</span>
            )}
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <Button
              size="icon" variant="ghost" className="h-7 w-7 text-white/70 hover:text-white"
              title="Save" aria-label="Save"
              onClick={() => (o ? setConfirm({ kind: "overwrite", slot: i }) : saveInto(i))}
              data-testid={`button-outfit-save-${i}`}
            >
              <Save className="w-3.5 h-3.5" />
            </Button>
            <Button
              size="icon" variant="ghost" className="h-7 w-7 text-white/70 hover:text-white"
              title="Load" aria-label="Load" disabled={!o}
              onClick={() => { if (o) { onLoad(o); setOpen(false); } }}
              data-testid={`button-outfit-load-${i}`}
            >
              <Download className="w-3.5 h-3.5" />
            </Button>
            <Button
              size="icon" variant="ghost" className="h-7 w-7 text-white/70 hover:text-white"
              title="Rename" aria-label="Rename" disabled={!o}
              onClick={() => { if (o) { setDraftName(o.name); setRenaming(i); } }}
              data-testid={`button-outfit-rename-${i}`}
            >
              <Pencil className="w-3.5 h-3.5" />
            </Button>
            <Button
              size="icon" variant="ghost" className="h-7 w-7 text-white/70 hover:text-white"
              title="Copy" aria-label="Copy" disabled={!o || firstEmpty < 0}
              onClick={() => copy(i)}
              data-testid={`button-outfit-copy-${i}`}
            >
              <Copy className="w-3.5 h-3.5" />
            </Button>
            <Button
              size="icon" variant="ghost" className="h-7 w-7 text-red-400/80 hover:text-red-300"
              title="Delete" aria-label="Delete" disabled={!o}
              onClick={() => o && setConfirm({ kind: "delete", slot: i })}
              data-testid={`button-outfit-delete-${i}`}
            >
              <Trash2 className="w-3.5 h-3.5" />
            </Button>
          </div>
        </div>
      ))}

      <AlertDialog open={!!confirm} onOpenChange={open => { if (!open) setConfirm(null); }}>
        <AlertDialogContent className="bg-[#1a1a1a] border-white/15 text-white">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirm?.kind === "delete" ? "Delete outfit?" : "Overwrite outfit?"}
            </AlertDialogTitle>
            <AlertDialogDescription className="text-white/60">
              {confirmSlot?.name}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="bg-transparent border-white/20 text-white hover:bg-white/10" data-testid="button-outfit-confirm-cancel">
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              className={confirm?.kind === "delete" ? "bg-red-600 hover:bg-red-500 text-white" : "bg-[#634b3b] hover:bg-[#7a5c4a] text-white"}
              onClick={() => {
                if (!confirm) return;
                if (confirm.kind === "delete") write(confirm.slot, null);
                else saveInto(confirm.slot);
                setConfirm(null);
              }}
              data-testid="button-outfit-confirm"
            >
              {confirm?.kind === "delete" ? "Delete" : "Overwrite"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      </DialogContent>
    </Dialog>
  );
}
