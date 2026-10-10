import { useEffect, useMemo, useState } from "react";
import { GYM_LOOK_DEFAULTS, GYM_NAME_MAX, GYM_RENAME_FORCE, type GymLook } from "@/game/gymLook";

const PROP_ROWS = [
  ["mats", "Weightlifting Mats"],
  ["lockers", "Lockers"],
  ["door", "Door"],
  ["doorFrame", "Door Frame"],
  ["woodBench", "Bench"],
  ["benchPress", "Weightlifting Bench"],
  ["office", "Office"],
  ["trophyCases", "Trophy Cases"],
] as const;
type PropKey = typeof PROP_ROWS[number][0];
type FreeKey = "wall" | "themeDark" | "themeAccent" | "themeText" | "bagPrimary" | "bagSecondary" | PropKey;
const propDefaults = (): Record<PropKey, string> =>
  Object.fromEntries(PROP_ROWS.map(([k]) => [k, GYM_LOOK_DEFAULTS[k]])) as Record<PropKey, string>;

const WALL_PRESETS = ["#6b3526", "#8a8a86", "#e8e2d4", "#1f3a5f", "#2f4a2a", "#3a3a40", "#7a1c1c", "#c9a36b"];

interface Props {
  /** The look as saved on the fighter. */
  saved: GymLook;
  force: number;
  /** Live preview of the panel's draft on the 3D gym. */
  onPreview: (look: GymLook) => void;
  /** Persist the colour edits. */
  onSaveFree: (patch: Pick<GymLook, FreeKey>) => void;
  /** Charge Force and rename. Returns false if it couldn't be paid. */
  onBuyName: (name: string) => boolean;
  /** Free edits are saved, then the ring colour editor opens. */
  onOpenRingColors: () => void;
  onClose: () => void;
}

const btnBase = "w-full text-xs font-bold rounded px-2 py-1.5 transition-colors";
const btnGo = `${btnBase} text-black bg-yellow-500 hover:bg-yellow-400`;
const btnOff = `${btnBase} text-white/35 bg-white/5 cursor-not-allowed`;
const btnGhost = `${btnBase} text-white/70 bg-white/5 hover:bg-white/10`;

function ColorRow({ label, value, onChange, testId }: { label: string; value: string; onChange: (v: string) => void; testId: string }) {
  return (
    <label className="flex items-center justify-between gap-2 text-[11px] text-white/80">
      <span>{label}</span>
      <span className="flex items-center gap-2">
        <span className="font-mono text-white/40">{value}</span>
        <input type="color" value={value} onChange={e => onChange(e.target.value)} className="h-7 w-10 cursor-pointer rounded border border-white/20 bg-transparent" data-testid={testId} />
      </span>
    </label>
  );
}

export default function EditGymPanel({ saved, force, onPreview, onSaveFree, onBuyName, onOpenRingColors, onClose }: Props) {
  // Wall draft: a colour, or null for the stock brick.
  const [wall, setWall] = useState<string | null>(saved.wall ?? null);
  const [name, setName] = useState<string>(saved.name ?? GYM_LOOK_DEFAULTS.name);
  const [themeDark, setThemeDark] = useState<string>(saved.themeDark ?? GYM_LOOK_DEFAULTS.themeDark);
  const [themeAccent, setThemeAccent] = useState<string>(saved.themeAccent ?? GYM_LOOK_DEFAULTS.themeAccent);
  const [themeText, setThemeText] = useState<string>(saved.themeText ?? GYM_LOOK_DEFAULTS.themeText);
  const [bagPrimary, setBagPrimary] = useState<string>(saved.bagPrimary ?? GYM_LOOK_DEFAULTS.bagPrimary);
  const [bagSecondary, setBagSecondary] = useState<string>(saved.bagSecondary ?? GYM_LOOK_DEFAULTS.bagSecondary);
  const [props, setProps] = useState<Record<PropKey, string>>(() =>
    Object.fromEntries(PROP_ROWS.map(([k]) => [k, saved[k] ?? GYM_LOOK_DEFAULTS[k]])) as Record<PropKey, string>);
  const [confirm, setConfirm] = useState<"name" | null>(null);

  // Defaults are stored as "absent" so a stock-looking gym stays stock.
  const freePatch = useMemo((): Pick<GymLook, FreeKey> => ({
    wall: wall ?? undefined,
    ...Object.fromEntries(PROP_ROWS.map(([k]) => [k, props[k] === GYM_LOOK_DEFAULTS[k] ? undefined : props[k]])),
    themeDark: themeDark === GYM_LOOK_DEFAULTS.themeDark ? undefined : themeDark,
    themeAccent: themeAccent === GYM_LOOK_DEFAULTS.themeAccent ? undefined : themeAccent,
    themeText: themeText === GYM_LOOK_DEFAULTS.themeText ? undefined : themeText,
    bagPrimary: bagPrimary === GYM_LOOK_DEFAULTS.bagPrimary ? undefined : bagPrimary,
    bagSecondary: bagSecondary === GYM_LOOK_DEFAULTS.bagSecondary ? undefined : bagSecondary,
  }), [wall, themeDark, themeAccent, themeText, bagPrimary, bagSecondary, props]);
  const freeChanged = (Object.keys(freePatch) as (keyof typeof freePatch)[]).some(k => freePatch[k] !== saved[k]);
  // Clicking away keeps the colour edits; an unconfirmed rename is dropped.
  const closePanel = () => { if (freeChanged) onSaveFree(freePatch); onClose(); };

  const trimmedName = name.trim().slice(0, GYM_NAME_MAX);
  const savedName = saved.name ?? GYM_LOOK_DEFAULTS.name;
  const nameChanged = trimmedName.length > 0 && trimmedName !== savedName;
  const canPayName = force >= GYM_RENAME_FORCE;

  useEffect(() => {
    onPreview({ ...freePatch, name: trimmedName || savedName });
  }, [freePatch, trimmedName, savedName, onPreview]);

  // A changed name draft drops its pending confirmation.
  useEffect(() => { setConfirm(c => (c === "name" ? null : c)); }, [name]);

  return (
    <>
    <div className="absolute inset-0 z-[89]" onClick={closePanel} data-testid="edit-gym-backdrop" />
    <div
      className="absolute right-3 top-3 bottom-3 z-[90] w-72 overflow-y-auto rounded-lg border border-white/15 bg-[#151515]/95 p-3 shadow-2xl space-y-3"
      onClick={e => e.stopPropagation()}
      data-testid="edit-gym-panel"
    >
      <div className="flex items-center justify-between">
        <div className="text-sm font-black uppercase tracking-widest text-yellow-400">Edit Gym</div>
        <div className="text-[10px] text-white/50">⚡ {Math.floor(force).toLocaleString()}</div>
      </div>

      {/* Brick walls */}
      <section className="space-y-1.5 rounded border border-white/10 p-2">
        <div className="text-xs font-bold text-white">Brick Walls</div>
        <div className="flex flex-wrap gap-1.5">
          <button
            className={`h-6 rounded border px-1.5 text-[10px] text-white/80 ${wall === null ? "border-yellow-400" : "border-white/20"}`}
            onClick={() => setWall(null)}
            data-testid="edit-gym-wall-stock"
          >Stock</button>
          {WALL_PRESETS.map(c => (
            <button
              key={c}
              className={`h-6 w-6 rounded border-2 ${wall === c ? "border-yellow-400" : "border-white/20"}`}
              style={{ background: c }}
              onClick={() => setWall(c)}
              aria-label={`Wall colour ${c}`}
              data-testid={`edit-gym-wall-${c.slice(1)}`}
            />
          ))}
        </div>
        <ColorRow label="Custom" value={wall ?? GYM_LOOK_DEFAULTS.wall} onChange={setWall} testId="edit-gym-wall-custom" />
      </section>

      {/* Gym name — paid */}
      <section className="space-y-1.5 rounded border border-white/10 p-2">
        <div className="flex items-center justify-between text-xs font-bold text-white">
          <span>Gym Name</span>
          <span className="text-[10px] font-normal text-white/40">{name.length}/{GYM_NAME_MAX}</span>
        </div>
        <input
          value={name}
          maxLength={GYM_NAME_MAX}
          onChange={e => setName(e.target.value.slice(0, GYM_NAME_MAX))}
          className="w-full rounded border border-white/20 bg-black/60 px-2 py-1 text-xs text-white outline-none focus:border-yellow-500"
          data-testid="edit-gym-name-input"
        />
        {confirm === "name" ? <>
          <div className="text-center text-[10px] font-bold text-cyan-300">Rename the gym for {GYM_RENAME_FORCE.toLocaleString()} Force?</div>
          <button className={btnGo} onClick={() => { if (onBuyName(trimmedName)) setConfirm(null); }} data-testid="edit-gym-name-confirm">⚡ Confirm</button>
          <button className={btnGhost} onClick={() => setConfirm(null)} data-testid="edit-gym-name-cancel">Cancel</button>
        </> : (
          <button
            className={nameChanged && canPayName ? btnGo : btnOff}
            disabled={!nameChanged || !canPayName}
            onClick={() => setConfirm("name")}
            data-testid="edit-gym-name-buy"
          >{!canPayName ? `Rename — needs ${GYM_RENAME_FORCE.toLocaleString()} Force` : `Rename — ${GYM_RENAME_FORCE.toLocaleString()} Force`}</button>
        )}
      </section>

      {/* Theme */}
      <section className="space-y-1.5 rounded border border-white/10 p-2">
        <div className="flex items-center justify-between text-xs font-bold text-white">
          <span>Gym Theme</span>
          <button className="text-[10px] font-normal text-white/50 hover:text-white" onClick={() => { setThemeDark(GYM_LOOK_DEFAULTS.themeDark); setThemeAccent(GYM_LOOK_DEFAULTS.themeAccent); setThemeText(GYM_LOOK_DEFAULTS.themeText); }} data-testid="edit-gym-theme-reset">Reset</button>
        </div>
        <ColorRow label="Main (black)" value={themeDark} onChange={setThemeDark} testId="edit-gym-theme-dark" />
        <ColorRow label="Accent (yellow)" value={themeAccent} onChange={setThemeAccent} testId="edit-gym-theme-accent" />
        <ColorRow label="Text" value={themeText} onChange={setThemeText} testId="edit-gym-theme-text" />
      </section>

      {/* Heavy bags */}
      <section className="space-y-1.5 rounded border border-white/10 p-2">
        <div className="flex items-center justify-between text-xs font-bold text-white">
          <span>Heavy Bags</span>
          <button className="text-[10px] font-normal text-white/50 hover:text-white" onClick={() => { setBagPrimary(GYM_LOOK_DEFAULTS.bagPrimary); setBagSecondary(GYM_LOOK_DEFAULTS.bagSecondary); }} data-testid="edit-gym-bag-reset">Reset</button>
        </div>
        <ColorRow label="Primary" value={bagPrimary} onChange={setBagPrimary} testId="edit-gym-bag-primary" />
        <ColorRow label="Secondary" value={bagSecondary} onChange={setBagSecondary} testId="edit-gym-bag-secondary" />
      </section>

      {/* Other */}
      <section className="space-y-1.5 rounded border border-white/10 p-2">
        <div className="flex items-center justify-between text-xs font-bold text-white">
          <span>Other</span>
          <button className="text-[10px] font-normal text-white/50 hover:text-white" onClick={() => setProps(propDefaults())} data-testid="edit-gym-props-reset">Reset</button>
        </div>
        {PROP_ROWS.map(([k, label]) => (
          <ColorRow key={k} label={label} value={props[k]} onChange={v => setProps(p => ({ ...p, [k]: v }))} testId={`edit-gym-${k}`} />
        ))}
      </section>

      {/* Ring */}
      <section className="space-y-1.5 rounded border border-white/10 p-2">
        <div className="text-xs font-bold text-white">Ring</div>
        <button className={btnGhost} onClick={() => { if (freeChanged) onSaveFree(freePatch); onOpenRingColors(); }} data-testid="edit-gym-ring-colors">🎨 Ring Colors…</button>
      </section>
    </div>
    </>
  );
}
