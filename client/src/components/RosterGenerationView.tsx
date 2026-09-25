import { useState } from "react";
import PctInput from "@/components/PctInput";
import ItemDistributionTab from "@/components/ItemDistributionTab";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog";
import { ArrowLeft, Save, RotateCcw, ChevronDown } from "lucide-react";
import {
  buildDefaultRosterGenConfig, loadCustomRosterGenConfig, saveRosterGenConfig, clampEloMult,
  clampCrateCount, normalizeCrateChances, rebalanceCrateChances, CRATE_COUNT_MAX, clampEquipLevel,
  clampRefCount,
  type RosterGenConfig, type RosterGenBand, type CrateChances,
} from "@/game/rosterGenConfig";
import { MAX_ACTIVE_REFINEMENTS } from "@shared/schema";
import { REFINEMENT_KEYS, REFINEMENT_LABELS, sanitizeRefinementKeys } from "@/game/refinementKeys";
import { EQUIPMENT_MAX_LEVEL } from "@/game/equipmentConfig";
import {
  clampPunchEndurance, PUNCH_ENDURANCE_MIN, PUNCH_ENDURANCE_MAX,
  clampPunchEnduranceLoss, PUNCH_ENDURANCE_LOSS_MIN, PUNCH_ENDURANCE_LOSS_MAX,
} from "@/game/punchEndurance";
import {
  CRATES, CRATE_IDS, CRATE_ITEM_COUNT_MIN, CRATE_ITEM_COUNT_MAX, type CrateId,
} from "@/game/cratesConfig";

interface RosterGenerationViewProps {
  onBack: () => void;
  /** Called after the config is persisted so the parent can apply it to the current career roster. */
  onSaved?: (cfg: RosterGenConfig) => void;
}

type NumField = keyof Pick<RosterGenBand, "levelLo" | "levelHi" | "statLo" | "statHi" | "refLo" | "refHi" | "refCount" | "peLo" | "peHi" | "peLoss" | "equipLo" | "equipHi" | "eloMult">;

/** Compact per-crate toggle labels used in the Rewards column. */
const CRATE_SHORT: Record<CrateId, string> = {
  journeyman: "J", contender: "C", elite: "E", champion: "Ch", undisputed: "U", goat: "G",
};

/** Six percentage sliders (one per crate) plus the chests-per-win count. */
function CrateChanceSliders({ chances, count, onChance, onCount, testIdPrefix }: {
  chances: CrateChances;
  count: number;
  onChance: (crate: CrateId, pct: number) => void;
  onCount: (raw: string) => void;
  testIdPrefix: string;
}) {
  const off = count <= 0;
  return (
    <>
      {CRATE_IDS.map(id => {
        const crate = CRATES[id];
        const pct = Math.max(0, Math.min(100, Math.round(chances?.[id] ?? 0)));
        return (
          <div key={id} className={`flex items-center gap-1 px-0.5 ${off ? "opacity-40" : ""}`} title={`${crate.name} — ${crate.blurb}`}>
            <input
              type="range"
              min={0}
              max={100}
              step={1}
              value={pct}
              disabled={off}
              onChange={e => onChance(id, parseInt(e.target.value, 10))}
              className="flex-1 min-w-0 h-1.5 cursor-pointer"
              style={{ accentColor: crate.trim }}
              data-testid={`${testIdPrefix}-${id}`}
            />
            <PctInput
              value={pct}
              disabled={off}
              color={pct > 0 ? crate.trimLight : "rgba(255,255,255,0.35)"}
              onCommit={next => onChance(id, next)}
              testId={`${testIdPrefix}-${id}-value`}
            />
          </div>
        );
      })}
      <Input
        type="number"
        min={0}
        max={CRATE_COUNT_MAX}
        className="h-7 text-[11px] px-1 text-center"
        value={count}
        title={`Chests awarded per win (0–${CRATE_COUNT_MAX}; 0 = no reward)`}
        onChange={e => onCount(e.target.value)}
        data-testid={`${testIdPrefix}-count`}
      />
    </>
  );
}

const FIELD_COLS: { key: NumField; label: string; float?: boolean }[] = [
  { key: "levelLo", label: "Lvl min" },
  { key: "levelHi", label: "Lvl max" },
  { key: "statLo", label: "Stat min" },
  { key: "statHi", label: "Stat max" },
  { key: "eloMult", label: "ELO ×", float: true },
];

/**
 * Refinements live on their own tab: how many a fighter brings into the ring
 * (0–{@link MAX_ACTIVE_REFINEMENTS}) and the level range each of those is rolled at.
 */
const REF_COLS: { key: NumField; label: string; min: number; max: number }[] = [
  { key: "refCount", label: "How many", min: 0, max: MAX_ACTIVE_REFINEMENTS },
  { key: "refLo", label: "Ref min", min: 0, max: 100 },
  { key: "refHi", label: "Ref max", min: 0, max: 100 },
];

/**
 * The "always generate with" picker for one ranking band — a dropdown listing
 * every refinement with a check box. Checked ones go to every fighter generated
 * in that band and eat into "how many"; the rest of the slots stay random.
 */
function ForcedRefinementPicker({ selected, count, onChange, testId }: {
  selected: string[] | undefined;
  count: number;
  onChange: (next: string[]) => void;
  testId: string;
}) {
  const picked = sanitizeRefinementKeys(selected);
  // Only the first `count` picks fit the band's allowance. Checking more is
  // blocked outright; a list can still overflow by lowering "how many"
  // afterwards, so the ones that no longer fit are called out rather than
  // silently dropped at generation time.
  const applied = picked.slice(0, count);
  const over = picked.length > count;
  const full = picked.length >= count;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className={`h-7 w-full justify-between gap-1 px-2 text-[11px] font-normal ${
            over ? "border-amber-500 text-amber-400"
              : picked.length > 0 ? "border-primary/60 text-foreground" : "text-muted-foreground"
          }`}
          title={picked.length === 0
            ? "Every refinement is dealt at random"
            : `Always: ${picked.map(k => REFINEMENT_LABELS[k]).join(", ")}`}
          data-testid={testId}
        >
          <span className="truncate">{picked.length === 0 ? "All random" : `${picked.length} set`}</span>
          <ChevronDown className="w-3 h-3 shrink-0 opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-56 p-2">
        <div className="flex items-center justify-between gap-2 pb-1">
          <p className="text-[10px] font-bold text-muted-foreground">Always generate with</p>
          <button
            className="text-[10px] text-muted-foreground hover:text-foreground disabled:opacity-40"
            disabled={picked.length === 0}
            onClick={() => onChange([])}
            data-testid={`${testId}-clear`}
          >
            Clear
          </button>
        </div>
        <p className={`text-[10px] pb-1 ${over ? "text-amber-400" : "text-muted-foreground"}`}>
          {count <= 0
            ? "This band generates no refinements at all."
            : over
              ? `Only ${count} fit "how many" — the greyed picks below are ignored.`
              : `${picked.length} of ${count} slots pinned — the other ${count - picked.length} are random.`}
        </p>
        <div className="max-h-64 overflow-y-auto pr-1">
          {REFINEMENT_KEYS.map(k => {
            const on = picked.includes(k);
            const ignored = on && !applied.includes(k);
            // At capacity nothing new can be checked — unpin something first, or
            // raise "how many".
            const locked = !on && full;
            return (
              <label
                key={k}
                className={`flex items-center gap-2 rounded px-1 py-0.5 ${
                  locked ? "cursor-not-allowed opacity-40" : "cursor-pointer hover:bg-white/5"
                }`}
                title={ignored
                  ? `Past this band's ${count} refinement${count === 1 ? "" : "s"} — not generated`
                  : locked ? `All ${count} slots are pinned already` : undefined}
                data-testid={`${testId}-${k}`}
              >
                <Checkbox
                  checked={on}
                  disabled={locked}
                  className="h-3.5 w-3.5"
                  onCheckedChange={() => onChange(on ? picked.filter(x => x !== k) : [...picked, k])}
                />
                <span className={`text-[11px] ${ignored ? "text-amber-400 line-through" : ""}`}>
                  {REFINEMENT_LABELS[k]}
                </span>
              </label>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * Punch Endurance lives on its own tab, so it gets its own narrow table. Each
 * column carries its own bounds — the cost and the punch count are on very
 * different scales.
 */
const PE_COLS: { key: NumField; label: string; min: number; max: number }[] = [
  { key: "peLoss", label: "Max stam %", min: PUNCH_ENDURANCE_LOSS_MIN, max: PUNCH_ENDURANCE_LOSS_MAX },
  { key: "peLo", label: "Punches min", min: PUNCH_ENDURANCE_MIN, max: PUNCH_ENDURANCE_MAX },
  { key: "peHi", label: "Punches max", min: PUNCH_ENDURANCE_MIN, max: PUNCH_ENDURANCE_MAX },
];

/**
 * Equipment lives on its own tab: a single upgrade level per fighter, rolled
 * once from a Lo/Hi range and worn in all five slots. 0 means no equipment.
 */
const EQUIP_COLS: { key: NumField; label: string }[] = [
  { key: "equipLo", label: "Equip min" },
  { key: "equipHi", label: "Equip max" },
];

export default function RosterGenerationView({ onBack, onSaved }: RosterGenerationViewProps) {
  const [config, setConfig] = useState<RosterGenConfig>(
    () => loadCustomRosterGenConfig() ?? buildDefaultRosterGenConfig()
  );
  const [dirty, setDirty] = useState(false);
  const [exitConfirm, setExitConfirm] = useState(false);
  const [savedNotice, setSavedNotice] = useState(false);
  const [tab, setTab] = useState<"generation" | "refinements" | "endurance" | "equipment" | "items">("generation");
  // The "every AI" punches box is a bulk setter over the per-band ranges rather
  // than a competing source of truth, so it starts on the value the roster is
  // already uniform at (falling back to the champion's when bands disagree).
  const [bulkPe, setBulkPe] = useState<number>(
    () => clampPunchEndurance((loadCustomRosterGenConfig() ?? buildDefaultRosterGenConfig()).rank1Pe)
  );
  const [bulkPeLoss, setBulkPeLoss] = useState<number>(
    () => clampPunchEnduranceLoss((loadCustomRosterGenConfig() ?? buildDefaultRosterGenConfig()).rank1PeLoss)
  );
  // Same bulk-setter idea for refinements: seeded from the champion's values so
  // the boxes open on something the roster is already at.
  const [bulkRefCount, setBulkRefCount] = useState<number>(
    () => clampRefCount((loadCustomRosterGenConfig() ?? buildDefaultRosterGenConfig()).rank1RefCount)
  );
  const [bulkRefLo, setBulkRefLo] = useState<number>(
    () => (loadCustomRosterGenConfig() ?? buildDefaultRosterGenConfig()).rank1Ref
  );
  const [bulkRefHi, setBulkRefHi] = useState<number>(
    () => (loadCustomRosterGenConfig() ?? buildDefaultRosterGenConfig()).rank1Ref
  );

  const updateBand = (idx: number, key: NumField, raw: string) => {
    const parsed = key === "eloMult" ? parseFloat(raw) : parseInt(raw, 10);
    if (isNaN(parsed)) return;
    const val = (key === "equipLo" || key === "equipHi")
      ? clampEquipLevel(parsed)
      : key === "refCount" ? clampRefCount(parsed) : parsed;
    setConfig(prev => ({
      ...prev,
      bands: prev.bands.map((b, i) => (i === idx ? { ...b, [key]: val } : b)),
    }));
    setDirty(true);
    setSavedNotice(false);
  };

  const setBandChance = (idx: number, crate: CrateId, pct: number) => {
    setConfig(prev => ({
      ...prev,
      bands: prev.bands.map((b, i) =>
        i === idx ? { ...b, crateChances: rebalanceCrateChances(b.crateChances, crate, pct) } : b),
    }));
    setDirty(true);
    setSavedNotice(false);
  };

  /** The refinements every fighter generated in this band is handed. */
  const setBandForced = (idx: number, next: string[]) => {
    const clean = sanitizeRefinementKeys(next);
    setConfig(prev => ({
      ...prev,
      bands: prev.bands.map((b, i) => (i === idx ? { ...b, refForced: clean } : b)),
    }));
    setDirty(true);
    setSavedNotice(false);
  };

  const setRank1Forced = (next: string[]) => {
    setConfig(prev => ({ ...prev, rank1RefForced: sanitizeRefinementKeys(next) }));
    setDirty(true);
    setSavedNotice(false);
  };

  const setBandCrateCount = (idx: number, raw: string) => {
    const val = parseInt(raw, 10);
    if (isNaN(val)) return;
    setConfig(prev => ({
      ...prev,
      bands: prev.bands.map((b, i) => (i === idx ? { ...b, crateCount: clampCrateCount(val) } : b)),
    }));
    setDirty(true);
    setSavedNotice(false);
  };

  const setRank1Chance = (crate: CrateId, pct: number) => {
    setConfig(prev => ({ ...prev, rank1CrateChances: rebalanceCrateChances(prev.rank1CrateChances, crate, pct) }));
    setDirty(true);
    setSavedNotice(false);
  };

  const setRank1CrateCount = (raw: string) => {
    const val = parseInt(raw, 10);
    if (isNaN(val)) return;
    setConfig(prev => ({ ...prev, rank1CrateCount: clampCrateCount(val) }));
    setDirty(true);
    setSavedNotice(false);
  };

  const updateRank1 = (key: "rank1Level" | "rank1Stat" | "rank1Ref" | "rank1RefCount" | "rank1Pe" | "rank1PeLoss" | "rank1Equip" | "rank1EloMult", raw: string) => {
    const parsed = key === "rank1EloMult" ? parseFloat(raw) : parseInt(raw, 10);
    if (isNaN(parsed)) return;
    const val = key === "rank1Equip"
      ? clampEquipLevel(parsed)
      : key === "rank1RefCount" ? clampRefCount(parsed) : parsed;
    setConfig(prev => ({ ...prev, [key]: val }));
    setDirty(true);
    setSavedNotice(false);
  };

  /** Write one cost and one punch count across every band and the champion. */
  const applyPeToEveryAi = () => {
    const loss = clampPunchEnduranceLoss(bulkPeLoss);
    const punches = clampPunchEndurance(bulkPe);
    setBulkPeLoss(loss);
    setBulkPe(punches);
    setConfig(prev => ({
      ...prev,
      rank1Pe: punches,
      rank1PeLoss: loss,
      bands: prev.bands.map(b => ({ ...b, peLo: punches, peHi: punches, peLoss: loss })),
    }));
    setDirty(true);
    setSavedNotice(false);
  };

  /** Write one count and one level range across every band and the champion. */
  const applyRefToEveryAi = () => {
    const count = clampRefCount(bulkRefCount);
    const lo = Math.max(0, Math.min(100, Math.round(bulkRefLo)));
    const hi = Math.max(lo, Math.min(100, Math.round(bulkRefHi)));
    setBulkRefCount(count);
    setBulkRefLo(lo);
    setBulkRefHi(hi);
    setConfig(prev => ({
      ...prev,
      rank1RefCount: count,
      rank1Ref: hi,
      bands: prev.bands.map(b => ({ ...b, refCount: count, refLo: lo, refHi: hi })),
    }));
    setDirty(true);
    setSavedNotice(false);
  };

  const handleSave = () => {
    // Clamp ELO multipliers to 0.4x–10x and re-settle crate odds on 100 before storing.
    const clamped: RosterGenConfig = {
      ...config,
      rank1EloMult: clampEloMult(config.rank1EloMult),
      rank1RefCount: clampRefCount(config.rank1RefCount),
      rank1Pe: clampPunchEndurance(config.rank1Pe),
      rank1PeLoss: clampPunchEnduranceLoss(config.rank1PeLoss),
      rank1Equip: clampEquipLevel(config.rank1Equip),
      rank1CrateChances: normalizeCrateChances(config.rank1CrateChances, config.rank1CrateChances),
      rank1CrateCount: clampCrateCount(config.rank1CrateCount),
      rank1RefForced: sanitizeRefinementKeys(config.rank1RefForced),
      bands: config.bands.map(b => ({
        ...b,
        eloMult: clampEloMult(b.eloMult),
        refCount: clampRefCount(b.refCount),
        refForced: sanitizeRefinementKeys(b.refForced),
        peLo: clampPunchEndurance(b.peLo),
        peHi: clampPunchEndurance(b.peHi),
        peLoss: clampPunchEnduranceLoss(b.peLoss),
        equipLo: clampEquipLevel(b.equipLo),
        equipHi: clampEquipLevel(b.equipHi),
        crateChances: normalizeCrateChances(b.crateChances, b.crateChances),
        crateCount: clampCrateCount(b.crateCount),
      })),
    };
    setConfig(clamped);
    saveRosterGenConfig(clamped);
    setDirty(false);
    setSavedNotice(true);
    if (onSaved) onSaved(clamped);
  };

  const handleBack = () => {
    if (dirty) setExitConfirm(true);
    else onBack();
  };

  return (
    <div className="flex flex-col items-center gap-3 p-4 max-w-[1500px] mx-auto">
      <div className="flex items-center gap-3 w-full">
        <Button variant="ghost" size="icon" onClick={handleBack} data-testid="button-back-roster-gen">
          <ArrowLeft className="w-5 h-5" />
        </Button>
        <div className="flex-1">
          <h2 className="text-xl font-bold">Roster Generation</h2>
          <p className="text-xs text-muted-foreground">
            {tab === "generation"
              ? "Initial level / stat ranges per ranking band"
              : tab === "refinements"
                ? "How many refinements each AI opponent brings, and the level range they are rolled at"
                : tab === "endurance"
                  ? "How fast every AI corner burns its own max stamina by throwing"
                  : tab === "equipment"
                    ? "Equipment Upgrade level range each AI opponent is generated with"
                    : "Boost items AI opponents carry into career fights — saves as you edit"}
          </p>
        </div>
        {tab !== "items" && (
          <Button size="sm" className="gap-1" onClick={handleSave} data-testid="button-save-roster-gen">
            <Save className="w-4 h-4" /> Save
          </Button>
        )}
      </div>
      <div className="flex gap-1 w-full border-b border-white/10">
        {([
          ["generation", "Roster Generation"],
          ["refinements", "Refinements"],
          ["endurance", "Roster Endurance"],
          ["equipment", "Equipment"],
          ["items", "Item Distribution"],
        ] as const).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`px-3 py-1.5 text-xs font-bold rounded-t transition-colors ${
              tab === key ? "bg-white/10 text-foreground border-b-2 border-primary" : "text-muted-foreground hover:text-foreground"
            }`}
            data-testid={`tab-${key}`}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === "items" && <ItemDistributionTab />}
      {tab === "refinements" && (<>
      {savedNotice && (
        <div className="w-full bg-green-950 border border-green-600 rounded-md px-3 py-2">
          <p className="text-sm text-green-300 font-semibold">✓ Saved — applied to your current career roster and every new one.</p>
        </div>
      )}
      <p className="text-[11px] text-muted-foreground w-full">
        A fighter can only carry <strong className="text-foreground">{MAX_ACTIVE_REFINEMENTS}</strong> refinements into the
        ring. <strong className="text-foreground">How many</strong> is how many of them an opponent in that band is generated
        with (0–{MAX_ACTIVE_REFINEMENTS}; 0 = none at all); which ones they get is picked per fighter and stays the same on
        every load. <strong className="text-foreground">Ref min/max</strong> is the level range each of those chosen
        refinements is rolled at — every other refinement reads zero.{" "}
        <strong className="text-foreground">Refinements</strong> pins which ones a band carries: anything you check there is
        handed to every fighter in that band and takes up one of its "how many" slots, and whatever slots are left over are
        still dealt at random.
      </p>

      {/* Every AI — one control set for the whole roster */}
      <Card className="p-3 w-full border-orange-700/50">
        <p className="text-sm font-bold text-orange-400 mb-2">Every AI</p>
        <div className="flex flex-wrap items-end gap-3">
          <div className="w-32">
            <p className="text-[10px] text-muted-foreground mb-1">How many (0–{MAX_ACTIVE_REFINEMENTS})</p>
            <Input
              type="number"
              min={0}
              max={MAX_ACTIVE_REFINEMENTS}
              className="h-8 text-xs"
              value={bulkRefCount}
              onChange={e => { const v = parseInt(e.target.value, 10); if (!isNaN(v)) setBulkRefCount(v); }}
              data-testid="input-ai-ref-count"
            />
          </div>
          <p className="text-xs text-muted-foreground pb-2 whitespace-nowrap">refinements, each rolled</p>
          <div className="w-32">
            <p className="text-[10px] text-muted-foreground mb-1">Ref min (0–100)</p>
            <Input
              type="number"
              min={0}
              max={100}
              className="h-8 text-xs"
              value={bulkRefLo}
              onChange={e => { const v = parseInt(e.target.value, 10); if (!isNaN(v)) setBulkRefLo(v); }}
              data-testid="input-ai-ref-lo"
            />
          </div>
          <div className="w-32">
            <p className="text-[10px] text-muted-foreground mb-1">Ref max (0–100)</p>
            <Input
              type="number"
              min={0}
              max={100}
              className="h-8 text-xs"
              value={bulkRefHi}
              onChange={e => { const v = parseInt(e.target.value, 10); if (!isNaN(v)) setBulkRefHi(v); }}
              data-testid="input-ai-ref-hi"
            />
          </div>
          <Button size="sm" variant="secondary" className="h-8 text-xs" onClick={applyRefToEveryAi} data-testid="button-apply-ref-all">
            Apply to every AI
          </Button>
        </div>
        <p className="text-[10px] text-muted-foreground mt-2">
          All three are stored per ranking band, so this fills every band and the champion with the set above — fine-tune
          individual ranks underneath afterwards. The champion carries one exact level rather than a range, so he takes the
          max. Nothing is written until you press Save.
        </p>
      </Card>

      {/* Per-band refinement counts and ranges */}
      <Card className="p-3 w-full overflow-x-auto">
        <div
          className="grid gap-1 min-w-[26rem] max-w-[42rem]"
          style={{ gridTemplateColumns: `6.5rem repeat(${REF_COLS.length}, minmax(5rem, 1fr)) 7.5rem` }}
        >
          <p className="text-[10px] font-bold text-muted-foreground self-end">Ranks</p>
          {REF_COLS.map(c => (
            <p key={c.key} className="text-[10px] font-bold text-muted-foreground self-end text-center">{c.label}</p>
          ))}
          <p className="text-[10px] font-bold text-muted-foreground self-end text-center">Refinements</p>
          <p className="text-xs font-semibold self-center whitespace-nowrap text-yellow-400">1 (Champ)</p>
          <Input
            type="number"
            min={0}
            max={MAX_ACTIVE_REFINEMENTS}
            className="h-7 text-[11px] px-1 text-center"
            value={config.rank1RefCount}
            onChange={e => updateRank1("rank1RefCount", e.target.value)}
            data-testid="input-rank1-ref-count"
          />
          <Input
            type="number"
            min={0}
            max={100}
            className="h-7 text-[11px] px-1 text-center"
            value={config.rank1Ref}
            onChange={e => updateRank1("rank1Ref", e.target.value)}
            data-testid="input-rank1-ref"
          />
          <p className="text-[10px] text-muted-foreground self-center text-center opacity-40" title="The champion's refinements sit at one exact level, not a range.">—</p>
          <ForcedRefinementPicker
            selected={config.rank1RefForced}
            count={clampRefCount(config.rank1RefCount)}
            onChange={setRank1Forced}
            testId="picker-rank1-ref-forced"
          />
          {config.bands.map((band, idx) => (
            <RefRowInputs
              key={`${band.hiRank}-${band.loRank}`}
              band={band}
              idx={idx}
              onChange={updateBand}
              onForcedChange={setBandForced}
            />
          ))}
        </div>
      </Card>

      <Button
        variant="outline"
        size="sm"
        className="gap-1 text-xs text-muted-foreground"
        onClick={() => {
          // Local-only reset of the refinement numbers; other tabs' edits stay put.
          const defaults = buildDefaultRosterGenConfig();
          setConfig(prev => ({
            ...prev,
            rank1Ref: defaults.rank1Ref,
            rank1RefCount: defaults.rank1RefCount,
            rank1RefForced: [],
            bands: prev.bands.map((b, i) => ({
              ...b,
              refLo: defaults.bands[i]?.refLo ?? 0,
              refHi: defaults.bands[i]?.refHi ?? 0,
              refCount: defaults.bands[i]?.refCount ?? MAX_ACTIVE_REFINEMENTS,
              refForced: [],
            })),
          }));
          setBulkRefCount(defaults.rank1RefCount);
          setBulkRefLo(defaults.rank1Ref);
          setBulkRefHi(defaults.rank1Ref);
          setDirty(true);
          setSavedNotice(false);
        }}
        data-testid="button-reset-roster-refinements"
      >
        <RotateCcw className="w-3 h-3" /> Reset refinements to defaults
      </Button>
      </>)}
      {tab === "endurance" && (<>
      {savedNotice && (
        <div className="w-full bg-green-950 border border-green-600 rounded-md px-3 py-2">
          <p className="text-sm text-green-300 font-semibold">✓ Saved — applied to your current career roster and every new one.</p>
        </div>
      )}
      <p className="text-[11px] text-muted-foreground w-full">
        Throwing costs a fighter their own conditioning: every <strong className="text-foreground">Y</strong> punches they
        throw, <strong className="text-foreground">X%</strong> of their max stamina comes off their pool for the rest of the bout. A
        higher punch count lasts longer; a higher stamina cost gasses faster. This tab sets both for the AI side of the
        roster only — your own fighter's cost is the one you drill down on the heavy bag in the gym.
      </p>

      {/* Every AI — one control pair for the whole roster */}
      <Card className="p-3 w-full border-orange-700/50">
        <p className="text-sm font-bold text-orange-400 mb-2">Every AI</p>
        <div className="flex flex-wrap items-end gap-3">
          <div className="w-32">
            <p className="text-[10px] text-muted-foreground mb-1">Max stamina % ({PUNCH_ENDURANCE_LOSS_MIN}–{PUNCH_ENDURANCE_LOSS_MAX})</p>
            <Input
              type="number"
              min={PUNCH_ENDURANCE_LOSS_MIN}
              max={PUNCH_ENDURANCE_LOSS_MAX}
              className="h-8 text-xs"
              value={bulkPeLoss}
              onChange={e => { const v = parseInt(e.target.value, 10); if (!isNaN(v)) setBulkPeLoss(v); }}
              data-testid="input-ai-pe-loss"
            />
          </div>
          <p className="text-xs text-muted-foreground pb-2 whitespace-nowrap">% of max stamina per</p>
          <div className="w-32">
            <p className="text-[10px] text-muted-foreground mb-1">Punches ({PUNCH_ENDURANCE_MIN}–{PUNCH_ENDURANCE_MAX})</p>
            <Input
              type="number"
              min={PUNCH_ENDURANCE_MIN}
              max={PUNCH_ENDURANCE_MAX}
              className="h-8 text-xs"
              value={bulkPe}
              onChange={e => { const v = parseInt(e.target.value, 10); if (!isNaN(v)) setBulkPe(v); }}
              data-testid="input-ai-pe-punches"
            />
          </div>
          <Button size="sm" variant="secondary" className="h-8 text-xs" onClick={applyPeToEveryAi} data-testid="button-apply-pe-all">
            Apply to every AI
          </Button>
        </div>
        <p className="text-[10px] text-muted-foreground mt-2">
          Both numbers are stored per ranking band, so this fills every band and the champion with the pair above — fine-tune
          individual ranks underneath afterwards. Nothing is written until you press Save.
        </p>
      </Card>

      {/* Per-band punch counts */}
      <Card className="p-3 w-full overflow-x-auto">
        <div
          className="grid gap-1 min-w-[22rem] max-w-[34rem]"
          style={{ gridTemplateColumns: `6.5rem repeat(${PE_COLS.length}, minmax(5rem, 1fr))` }}
        >
          <p className="text-[10px] font-bold text-muted-foreground self-end">Ranks</p>
          {PE_COLS.map(c => (
            <p key={c.key} className="text-[10px] font-bold text-muted-foreground self-end text-center">{c.label}</p>
          ))}
          <p className="text-xs font-semibold self-center whitespace-nowrap text-yellow-400">1 (Champ)</p>
          <Input
            type="number"
            min={PUNCH_ENDURANCE_LOSS_MIN}
            max={PUNCH_ENDURANCE_LOSS_MAX}
            className="h-7 text-[11px] px-1 text-center"
            value={config.rank1PeLoss}
            onChange={e => updateRank1("rank1PeLoss", e.target.value)}
            data-testid="input-rank1-pe-loss"
          />
          <Input
            type="number"
            min={PUNCH_ENDURANCE_MIN}
            max={PUNCH_ENDURANCE_MAX}
            className="h-7 text-[11px] px-1 text-center"
            value={config.rank1Pe}
            onChange={e => updateRank1("rank1Pe", e.target.value)}
            data-testid="input-rank1-pe"
          />
          <p className="text-[10px] text-muted-foreground self-center text-center opacity-40" title="The champion fights at one exact value, not a range.">—</p>
          {config.bands.map((band, idx) => (
            <PeRowInputs key={`${band.hiRank}-${band.loRank}`} band={band} idx={idx} onChange={updateBand} />
          ))}
        </div>
      </Card>

      <Button
        variant="outline"
        size="sm"
        className="gap-1 text-xs text-muted-foreground"
        onClick={() => {
          // Local-only reset of the endurance numbers; other tabs' edits stay put.
          const defaults = buildDefaultRosterGenConfig();
          setConfig(prev => ({
            ...prev,
            rank1Pe: defaults.rank1Pe,
            rank1PeLoss: defaults.rank1PeLoss,
            bands: prev.bands.map((b, i) => ({
              ...b,
              peLo: defaults.bands[i]?.peLo ?? PUNCH_ENDURANCE_MIN,
              peHi: defaults.bands[i]?.peHi ?? PUNCH_ENDURANCE_MIN,
              peLoss: defaults.bands[i]?.peLoss ?? PUNCH_ENDURANCE_LOSS_MIN,
            })),
          }));
          setBulkPe(defaults.rank1Pe);
          setBulkPeLoss(defaults.rank1PeLoss);
          setDirty(true);
          setSavedNotice(false);
        }}
        data-testid="button-reset-roster-endurance"
      >
        <RotateCcw className="w-3 h-3" /> Reset endurance to defaults
      </Button>
      </>)}
      {tab === "equipment" && (<>
      {savedNotice && (
        <div className="w-full bg-green-950 border border-green-600 rounded-md px-3 py-2">
          <p className="text-sm text-green-300 font-semibold">✓ Saved — applied to your current career roster and every new one.</p>
        </div>
      )}
      <p className="text-[11px] text-muted-foreground w-full">
        Every career opponent carries <strong className="text-foreground">one</strong> Equipment Upgrade level, worn in all
        five slots (Fight Gloves, Shoes, Trunks, Mouthguard, Hand Wraps). It is rolled once per fighter from their band's
        range below; <strong className="text-foreground">0</strong> means they own no equipment. Opponents that own gear also
        grow 1–5 levels on a 30% weekly roll, so their level can drift above the band over a long career — that is intended.
        This range is the generation floor, not a ceiling ({0}–{EQUIPMENT_MAX_LEVEL}).
      </p>

      {/* Per-band equipment levels */}
      <Card className="p-3 w-full overflow-x-auto">
        <div
          className="grid gap-1 min-w-[20rem] max-w-[30rem]"
          style={{ gridTemplateColumns: `6.5rem repeat(${EQUIP_COLS.length}, minmax(5rem, 1fr))` }}
        >
          <p className="text-[10px] font-bold text-muted-foreground self-end">Ranks</p>
          {EQUIP_COLS.map(c => (
            <p key={c.key} className="text-[10px] font-bold text-muted-foreground self-end text-center">{c.label}</p>
          ))}
          <p className="text-xs font-semibold self-center whitespace-nowrap text-yellow-400">1 (Champ)</p>
          <Input
            type="number"
            min={0}
            max={EQUIPMENT_MAX_LEVEL}
            className="h-7 text-[11px] px-1 text-center"
            value={config.rank1Equip}
            onChange={e => updateRank1("rank1Equip", e.target.value)}
            data-testid="input-rank1-equip"
          />
          <p className="text-[10px] text-muted-foreground self-center text-center opacity-40" title="The champion wears one exact level, not a range.">—</p>
          {config.bands.map((band, idx) => (
            <EquipRowInputs key={`${band.hiRank}-${band.loRank}`} band={band} idx={idx} onChange={updateBand} />
          ))}
        </div>
      </Card>

      <Button
        variant="outline"
        size="sm"
        className="gap-1 text-xs text-muted-foreground"
        onClick={() => {
          // Local-only reset of the equipment numbers; other tabs' edits stay put.
          const defaults = buildDefaultRosterGenConfig();
          setConfig(prev => ({
            ...prev,
            rank1Equip: defaults.rank1Equip,
            bands: prev.bands.map((b, i) => ({
              ...b,
              equipLo: defaults.bands[i]?.equipLo ?? 0,
              equipHi: defaults.bands[i]?.equipHi ?? 0,
            })),
          }));
          setDirty(true);
          setSavedNotice(false);
        }}
        data-testid="button-reset-roster-equipment"
      >
        <RotateCcw className="w-3 h-3" /> Reset equipment to defaults
      </Button>
      </>)}
      {tab === "generation" && (<>
      {savedNotice && (
        <div className="w-full bg-green-950 border border-green-600 rounded-md px-3 py-2">
          <p className="text-sm text-green-300 font-semibold">✓ Saved — current career roster updated; new careers will use these ranges.</p>
        </div>
      )}
      <p className="text-[11px] text-muted-foreground w-full">
        Stat min/max is the target <em>average</em> of the 5 stats; each stat varies around it.
        Refinements now live on the <strong className="text-foreground">Refinements</strong> tab, and
        Punch Endurance on the <strong className="text-foreground">Roster Endurance</strong> tab.
      </p>
      <p className="text-[11px] text-muted-foreground w-full">
        <strong className="text-foreground">Rewards</strong> — the six sliders are the % odds of each chest type a win in
        that band awards; drag them or type a number in the box beside each one. They always add up to 100, so raising one
        lowers the rest. <strong className="text-foreground">Chests</strong>{" "}
        is how many are handed out per win (0–{CRATE_COUNT_MAX}, 0 = no reward) — each one rolls its odds separately and
        holds {CRATE_ITEM_COUNT_MIN}–{CRATE_ITEM_COUNT_MAX} items.
      </p>
      <div className="w-full flex flex-wrap gap-x-3 gap-y-1">
        {CRATE_IDS.map(id => (
          <span key={id} className="text-[10px] text-muted-foreground flex items-center gap-1">
            <span className="w-2.5 h-2.5 rounded-sm inline-block" style={{ background: CRATES[id].trim }} />
            {CRATE_SHORT[id]} = {CRATES[id].name} <span className="opacity-60">({CRATES[id].blurb})</span>
          </span>
        ))}
      </div>

      {/* Rank 1 — manual */}
      <Card className="p-3 w-full border-yellow-700/50">
        <p className="text-sm font-bold text-yellow-400 mb-2">Rank 1 (Champion) — manually set</p>
        <div className="grid grid-cols-3 gap-2">
          <div>
            <p className="text-[10px] text-muted-foreground mb-1">Level</p>
            <Input type="number" className="h-8 text-xs" value={config.rank1Level}
              onChange={e => updateRank1("rank1Level", e.target.value)} data-testid="input-rank1-level" />
          </div>
          <div>
            <p className="text-[10px] text-muted-foreground mb-1">Every stat</p>
            <Input type="number" className="h-8 text-xs" value={config.rank1Stat}
              onChange={e => updateRank1("rank1Stat", e.target.value)} data-testid="input-rank1-stat" />
          </div>
          <div>
            <p className="text-[10px] text-muted-foreground mb-1">ELO × (0.4–10)</p>
            <Input type="number" step="0.01" min={0.4} max={10} className="h-8 text-xs" value={config.rank1EloMult}
              onChange={e => updateRank1("rank1EloMult", e.target.value)} data-testid="input-rank1-elomult" />
          </div>
        </div>
        <div className="mt-2">
          <p className="text-[10px] text-muted-foreground mb-1">Rewards for beating the champion (odds must total 100)</p>
          <div className="grid gap-1 items-center" style={{ gridTemplateColumns: `repeat(${CRATE_IDS.length}, minmax(6.5rem, 1fr)) 4.5rem` }}>
            {CRATE_IDS.map(id => (
              <p key={id} className="text-[10px] font-bold text-center truncate" style={{ color: CRATES[id].trimLight }}>
                {CRATE_SHORT[id]}
              </p>
            ))}
            <p className="text-[10px] font-bold text-muted-foreground text-center">Chests</p>
            <CrateChanceSliders
              chances={config.rank1CrateChances}
              count={config.rank1CrateCount}
              onChance={setRank1Chance}
              onCount={setRank1CrateCount}
              testIdPrefix="slider-rank1-crate"
            />
          </div>
        </div>
      </Card>

      {/* Band table */}
      <Card className="p-3 w-full overflow-x-auto">
        <div
          className="grid gap-1 min-w-[64rem]"
          style={{ gridTemplateColumns: `5.5rem repeat(${FIELD_COLS.length}, minmax(3.5rem, 1fr)) repeat(${CRATE_IDS.length}, minmax(6.5rem, 1.4fr)) 4.5rem` }}
        >
          <p className="text-[10px] font-bold text-muted-foreground self-end">Ranks</p>
          {FIELD_COLS.map(c => (
            <p key={c.key} className="text-[10px] font-bold text-muted-foreground self-end text-center">{c.label}</p>
          ))}
          {CRATE_IDS.map(id => (
            <p
              key={id}
              className="text-[10px] font-bold self-end text-center truncate"
              style={{ color: CRATES[id].trimLight }}
              title={`${CRATES[id].name} — ${CRATES[id].blurb}`}
            >
              {CRATE_SHORT[id]} %
            </p>
          ))}
          <p className="text-[10px] font-bold text-muted-foreground self-end text-center">Chests</p>
          {config.bands.map((band, idx) => (
            <RowInputs
              key={`${band.hiRank}-${band.loRank}`}
              band={band}
              idx={idx}
              onChange={updateBand}
              onChance={setBandChance}
              onCrateCount={setBandCrateCount}
            />
          ))}
        </div>
      </Card>

      <Button
        variant="outline"
        size="sm"
        className="gap-1 text-xs text-muted-foreground"
        onClick={() => {
          // Local-only reset — nothing is persisted until Save is pressed.
          setConfig(buildDefaultRosterGenConfig());
          setDirty(true);
          setSavedNotice(false);
        }}
        data-testid="button-reset-roster-gen"
      >
        <RotateCcw className="w-3 h-3" /> Reset to defaults
      </Button>
      </>)}

      <Dialog open={exitConfirm} onOpenChange={setExitConfirm}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Exit without saving?</DialogTitle>
            <DialogDescription>Your unsaved changes to the generation ranges will be lost.</DialogDescription>
          </DialogHeader>
          <div className="flex gap-2 mt-2">
            <Button variant="secondary" className="flex-1" onClick={() => setExitConfirm(false)} data-testid="button-exit-cancel">Keep Editing</Button>
            <Button variant="destructive" className="flex-1" onClick={() => { setExitConfirm(false); onBack(); }} data-testid="button-exit-confirm">Exit</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function PeRowInputs({ band, idx, onChange }: {
  band: RosterGenBand;
  idx: number;
  onChange: (idx: number, key: NumField, raw: string) => void;
}) {
  return (
    <>
      <p className="text-xs font-semibold self-center whitespace-nowrap" data-testid={`text-pe-band-${band.hiRank}`}>
        {band.hiRank === band.loRank ? band.hiRank : `${band.hiRank}–${band.loRank}`}
      </p>
      {PE_COLS.map(c => (
        <Input
          key={c.key}
          type="number"
          min={c.min}
          max={c.max}
          className="h-7 text-[11px] px-1 text-center"
          value={band[c.key]}
          onChange={e => onChange(idx, c.key, e.target.value)}
          data-testid={`input-pe-band-${band.hiRank}-${c.key}`}
        />
      ))}
    </>
  );
}

function RefRowInputs({ band, idx, onChange, onForcedChange }: {
  band: RosterGenBand;
  idx: number;
  onChange: (idx: number, key: NumField, raw: string) => void;
  onForcedChange: (idx: number, next: string[]) => void;
}) {
  return (
    <>
      <p className="text-xs font-semibold self-center whitespace-nowrap" data-testid={`text-ref-band-${band.hiRank}`}>
        {band.hiRank === band.loRank ? band.hiRank : `${band.hiRank}–${band.loRank}`}
      </p>
      {REF_COLS.map(c => (
        <Input
          key={c.key}
          type="number"
          min={c.min}
          max={c.max}
          className="h-7 text-[11px] px-1 text-center"
          value={band[c.key]}
          onChange={e => onChange(idx, c.key, e.target.value)}
          data-testid={`input-ref-band-${band.hiRank}-${c.key}`}
        />
      ))}
      <ForcedRefinementPicker
        selected={band.refForced}
        count={clampRefCount(band.refCount)}
        onChange={next => onForcedChange(idx, next)}
        testId={`picker-ref-band-${band.hiRank}-forced`}
      />
    </>
  );
}

function EquipRowInputs({ band, idx, onChange }: {
  band: RosterGenBand;
  idx: number;
  onChange: (idx: number, key: NumField, raw: string) => void;
}) {
  return (
    <>
      <p className="text-xs font-semibold self-center whitespace-nowrap" data-testid={`text-equip-band-${band.hiRank}`}>
        {band.hiRank === band.loRank ? band.hiRank : `${band.hiRank}–${band.loRank}`}
      </p>
      {EQUIP_COLS.map(c => (
        <Input
          key={c.key}
          type="number"
          min={0}
          max={EQUIPMENT_MAX_LEVEL}
          className="h-7 text-[11px] px-1 text-center"
          value={band[c.key]}
          onChange={e => onChange(idx, c.key, e.target.value)}
          data-testid={`input-equip-band-${band.hiRank}-${c.key}`}
        />
      ))}
    </>
  );
}

function RowInputs({ band, idx, onChange, onChance, onCrateCount }: {
  band: RosterGenBand;
  idx: number;
  onChange: (idx: number, key: NumField, raw: string) => void;
  onChance: (idx: number, crate: CrateId, pct: number) => void;
  onCrateCount: (idx: number, raw: string) => void;
}) {
  return (
    <>
      <p className="text-xs font-semibold self-center whitespace-nowrap" data-testid={`text-band-${band.hiRank}`}>
        {band.hiRank === band.loRank ? band.hiRank : `${band.hiRank}–${band.loRank}`}
      </p>
      {FIELD_COLS.map(c => (
        <Input
          key={c.key}
          type="number"
          step={c.float ? "0.01" : undefined}
          min={c.float ? 0.4 : undefined}
          max={c.float ? 10 : undefined}
          className="h-7 text-[11px] px-1 text-center"
          value={band[c.key]}
          onChange={e => onChange(idx, c.key, e.target.value)}
          data-testid={`input-band-${band.hiRank}-${c.key}`}
        />
      ))}
      <CrateChanceSliders
        chances={band.crateChances}
        count={band.crateCount}
        onChance={(crate, pct) => onChance(idx, crate, pct)}
        onCount={raw => onCrateCount(idx, raw)}
        testIdPrefix={`slider-band-${band.hiRank}-crate`}
      />
    </>
  );
}
