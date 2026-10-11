/**
 * Neural Network → Sound EQ: a 7-band EQ and fine pitch for every recorded
 * sound. Edits are a draft until "Save as Default", which writes the
 * handz_sound_eq parameter (carried by the parameter file / shipped defaults).
 */
import { useRef, useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Play, RotateCcw, Upload, X } from "lucide-react";
import { soundEngine, SOUND_LABELS, type SoundId } from "@/game/sound";
import { EQ_BANDS, EQ_DB_MAX, PITCH_MAX, flatEq, getSoundEqConfig, isFlat, saveSoundEqConfig, type SoundEqConfig } from "@/lib/soundEqConfig";

const IDS = Object.keys(SOUND_LABELS) as SoundId[];
const hz = (f: number) => (f >= 1000 ? `${f / 1000}k` : `${f}`);

export default function SoundEqCard() {
  const [saved, setSaved] = useState<SoundEqConfig>(() => getSoundEqConfig());
  const [draft, setDraft] = useState<SoundEqConfig>(saved);
  const [id, setId] = useState<SoundId>(IDS[0]);
  const eq = draft[id] ?? flatEq();
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const fileInput = useRef<HTMLInputElement>(null);
  const [uploadError, setUploadError] = useState("");

  const upload = async (file: File | undefined) => {
    if (!file) return;
    setUploadError("");
    const ext = file.name.split(".").pop()?.toLowerCase();
    try {
      const res = await fetch(`/api/sound-files?id=${id}&ext=${ext}`, { method: "POST", body: file });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "Upload failed");
      edit({ file: body.url });
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "Upload failed");
    }
  };

  const edit = (patch: Partial<typeof eq>) => {
    const next = { ...eq, ...patch };
    if (!next.file) delete next.file;
    const d = { ...draft };
    if (isFlat(next)) delete d[id]; else d[id] = next;
    setDraft(d);
  };

  return (
    <Card className="p-3 w-full space-y-3" style={{ background: "#0a1a0a", border: "1px solid #1a4a1a" }} data-testid="card-sound-eq">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-semibold" style={{ color: "#c8ffaa" }}>Sound EQ &amp; Pitch</p>
        <div className="flex gap-1">
          <Button size="sm" variant="outline" className="text-xs h-7 px-2" style={{ borderColor: "#1a7a1a", color: "#c8ffaa" }}
            disabled={!dirty} onClick={() => setDraft(saved)} data-testid="button-sound-eq-revert">Revert</Button>
          <Button size="sm" className="text-xs h-7 px-2 bg-[#1a5a1a] hover:bg-[#237a23] text-white"
            disabled={!dirty} onClick={() => { const s = saveSoundEqConfig(draft); setSaved(s); setDraft(s); }} data-testid="button-sound-eq-save">Save as Default</Button>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Select value={id} onValueChange={v => setId(v as SoundId)}>
          <SelectTrigger className="h-8 text-xs flex-1" data-testid="select-sound-eq"><SelectValue /></SelectTrigger>
          <SelectContent>
            {IDS.map(s => <SelectItem key={s} value={s}>{SOUND_LABELS[s]}{draft[s] ? " •" : ""}</SelectItem>)}
          </SelectContent>
        </Select>
        <Button size="sm" variant="outline" className="h-8 px-2 gap-1 text-xs" style={{ borderColor: "#1a7a1a", color: "#c8ffaa" }}
          data-ui-sound="none" onClick={() => soundEngine.previewSound(id, eq)} data-testid="button-sound-eq-play"><Play className="w-3.5 h-3.5" /> Play</Button>
        <Button size="sm" variant="outline" className="h-8 w-8 p-0" style={{ borderColor: "#1a7a1a", color: "#c8ffaa" }}
          title="Flat" aria-label="Flat" onClick={() => edit(flatEq())} data-testid="button-sound-eq-flat"><RotateCcw className="w-3.5 h-3.5" /></Button>
      </div>
      <div className="flex items-center gap-2">
        <input ref={fileInput} type="file" accept=".mp3,.wav,audio/mpeg,audio/wav" className="hidden"
          onChange={e => { upload(e.target.files?.[0]); e.target.value = ""; }} data-testid="input-sound-eq-file" />
        <Button size="sm" variant="outline" className="h-7 px-2 gap-1 text-xs" style={{ borderColor: "#1a7a1a", color: "#c8ffaa" }}
          onClick={() => fileInput.current?.click()} data-testid="button-sound-eq-replace"><Upload className="w-3.5 h-3.5" /> Replace</Button>
        {eq.file && (
          <Button size="sm" variant="outline" className="h-7 px-2 gap-1 text-xs" style={{ borderColor: "#1a7a1a", color: "#c8ffaa" }}
            onClick={() => edit({ file: undefined })} data-testid="button-sound-eq-original"><X className="w-3.5 h-3.5" /> Original</Button>
        )}
        <span className="text-[10px] truncate" style={{ color: uploadError ? "#ff8080" : "#66aa66" }}>{uploadError || (eq.file ? eq.file.split("/").pop() : "")}</span>
      </div>
      <div className="grid grid-cols-7 gap-2">
        {EQ_BANDS.map((f, i) => (
          <div key={f} className="flex flex-col items-center gap-1">
            <span className="text-[10px] font-mono" style={{ color: "#c8ffaa" }}>{eq.gains[i] > 0 ? "+" : ""}{eq.gains[i].toFixed(1)}</span>
            <Slider
              orientation="vertical" className="h-28" min={-EQ_DB_MAX} max={EQ_DB_MAX} step={0.5}
              value={[eq.gains[i]]}
              onValueChange={([v]) => edit({ gains: eq.gains.map((g, j) => (j === i ? v : g)) })}
              data-testid={`slider-sound-eq-${f}`}
            />
            <span className="text-[10px]" style={{ color: "#66aa66" }}>{hz(f)}</span>
          </div>
        ))}
      </div>
      <div className="flex items-center gap-2">
        <span className="text-xs w-12" style={{ color: "#c8ffaa" }}>Pitch</span>
        <Slider className="flex-1" min={-PITCH_MAX} max={PITCH_MAX} step={0.01} value={[eq.pitch]}
          onValueChange={([v]) => edit({ pitch: v })} data-testid="slider-sound-eq-pitch" />
        <span className="text-[10px] font-mono w-16 text-right" style={{ color: "#c8ffaa" }}>{eq.pitch > 0 ? "+" : ""}{eq.pitch.toFixed(2)} st</span>
      </div>
    </Card>
  );
}
