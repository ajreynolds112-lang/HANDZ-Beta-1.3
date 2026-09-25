/**
 * Item Distribution tab — how many boost items career opponents in each
 * ranking band carry, and which rarities those items are drawn from.
 *
 * Every edit persists immediately (no Save button), so the odds here are never
 * left half-committed while the Roster Generation tab holds unsaved ranges.
 */
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { RotateCcw } from "lucide-react";
import PctInput from "@/components/PctInput";
import {
  ITEM_RARITIES, RARITY_COLORS, rarityTextClass, type ItemRarity,
} from "@/game/itemsConfig";
import {
  ITEM_COUNT_MAX, assignableBoostItems, assignableKeepsakeItems, buildDefaultItemDistConfig,
  clampItemCount, clampKeepsakeChance, clearItemDistConfig, loadItemDistConfig,
  rebalanceRarityChances, saveItemDistConfig,
  type ItemDistBand, type ItemDistConfig, type RarityChances,
} from "@/game/itemDistConfig";
import { useMemo, useState } from "react";

/** Compact column headers — full names sit in the legend above the table. */
const RARITY_SHORT: Record<ItemRarity, string> = {
  Journeyman: "J", Contender: "C", Elite: "E", Champion: "Ch", Undisputed: "U", GOAT: "G",
};

/** Six percentage sliders (one per rarity) plus the items-per-opponent count. */
function RarityChanceSliders({ chances, count, onChance, onCount, testIdPrefix }: {
  chances: RarityChances;
  count: number;
  onChance: (rarity: ItemRarity, pct: number) => void;
  onCount: (raw: string) => void;
  testIdPrefix: string;
}) {
  const off = count <= 0;
  return (
    <>
      {ITEM_RARITIES.map(r => {
        const pct = Math.max(0, Math.min(100, Math.round(chances?.[r] ?? 0)));
        return (
          <div key={r} className={`flex items-center gap-1 px-0.5 ${off ? "opacity-40" : ""}`} title={r}>
            <input
              type="range"
              min={0}
              max={100}
              step={1}
              value={pct}
              disabled={off}
              onChange={e => onChance(r, parseInt(e.target.value, 10))}
              className="flex-1 min-w-0 h-1.5 cursor-pointer"
              style={{ accentColor: RARITY_COLORS[r] }}
              data-testid={`${testIdPrefix}-${r.toLowerCase()}`}
            />
            <PctInput
              value={pct}
              disabled={off}
              color={pct > 0 ? RARITY_COLORS[r] : "rgba(255,255,255,0.35)"}
              onCommit={next => onChance(r, next)}
              testId={`${testIdPrefix}-${r.toLowerCase()}-value`}
            />
          </div>
        );
      })}
      <Input
        type="number"
        min={0}
        max={ITEM_COUNT_MAX}
        className="h-7 text-[11px] px-1 text-center"
        value={count}
        title={`Boost items this opponent carries (0–${ITEM_COUNT_MAX}; 0 = none)`}
        onChange={e => onCount(e.target.value)}
        data-testid={`${testIdPrefix}-count`}
      />
    </>
  );
}

function BandRow({ band, idx, onChance, onCount }: {
  band: ItemDistBand;
  idx: number;
  onChance: (idx: number, rarity: ItemRarity, pct: number) => void;
  onCount: (idx: number, raw: string) => void;
}) {
  return (
    <>
      <p className="text-xs font-semibold self-center whitespace-nowrap" data-testid={`text-itemdist-band-${band.hiRank}`}>
        {band.hiRank === band.loRank ? band.hiRank : `${band.hiRank}–${band.loRank}`}
      </p>
      <RarityChanceSliders
        chances={band.chances}
        count={band.count}
        onChance={(r, pct) => onChance(idx, r, pct)}
        onCount={raw => onCount(idx, raw)}
        testIdPrefix={`slider-itemdist-${band.hiRank}`}
      />
    </>
  );
}

export default function ItemDistributionTab() {
  const [config, setConfig] = useState<ItemDistConfig>(() => loadItemDistConfig());

  /** Every edit lands in state and on disk in the same breath. */
  const commit = (next: ItemDistConfig) => {
    setConfig(next);
    saveItemDistConfig(next);
  };

  const setBandChance = (idx: number, rarity: ItemRarity, pct: number) => {
    commit({
      ...config,
      bands: config.bands.map((b, i) =>
        i === idx ? { ...b, chances: rebalanceRarityChances(b.chances, rarity, pct) } : b),
    });
  };

  const setBandCount = (idx: number, raw: string) => {
    const val = parseInt(raw, 10);
    if (isNaN(val)) return;
    commit({
      ...config,
      bands: config.bands.map((b, i) => (i === idx ? { ...b, count: clampItemCount(val) } : b)),
    });
  };

  const setRank1Chance = (rarity: ItemRarity, pct: number) => {
    commit({ ...config, rank1Chances: rebalanceRarityChances(config.rank1Chances, rarity, pct) });
  };

  const setRank1Count = (raw: string) => {
    const val = parseInt(raw, 10);
    if (isNaN(val)) return;
    commit({ ...config, rank1Count: clampItemCount(val) });
  };

  const setKeepsakeChance = (raw: string) => {
    const val = parseInt(raw, 10);
    if (isNaN(val)) return;
    commit({ ...config, keepsakeChancePct: clampKeepsakeChance(val) });
  };

  // How much of the catalog these odds can actually draw from, per rarity.
  const poolByRarity = useMemo(() => {
    const counts = ITEM_RARITIES.reduce((acc, r) => { acc[r] = 0; return acc; }, {} as Record<ItemRarity, number>);
    for (const def of assignableBoostItems()) counts[def.rarity]++;
    return counts;
  }, []);

  const keepsakeCount = useMemo(() => assignableKeepsakeItems().length, []);

  return (
    <div className="flex flex-col items-center gap-3 w-full">
      <p className="text-[11px] text-muted-foreground w-full">
        Boost items the <strong className="text-foreground">AI opponent</strong> brings into a career fight. The six
        sliders are the % odds a rolled item slot draws from that rarity — they always add up to 100, so raising one
        lowers the rest. <strong className="text-foreground">Items</strong> is how many slots are rolled per opponent
        (0–{ITEM_COUNT_MAX}, 0 = none) — every slot gets filled, falling back to another rarity when the rolled one has
        nothing left to give. Duplicates are allowed up to an item's synergy limit, and keepsakes are limited
        to one of each. Changes save automatically.
      </p>
      <div className="w-full flex flex-wrap gap-x-3 gap-y-1">
        {ITEM_RARITIES.map(r => (
          <span key={r} className="text-[10px] text-muted-foreground flex items-center gap-1">
            <span className="w-2.5 h-2.5 rounded-sm inline-block" style={{ background: RARITY_COLORS[r] }} />
            {RARITY_SHORT[r]} = <span className={rarityTextClass(r)} style={r === "GOAT" ? {} : { color: RARITY_COLORS[r] }}>{r}</span>
            <span className="opacity-60">({poolByRarity[r]} boost item{poolByRarity[r] === 1 ? "" : "s"})</span>
          </span>
        ))}
      </div>

      {/* Keepsake carry — one flat chance, shared by every rank */}
      <Card className="p-3 w-full border-amber-600/40">
        <div className="flex items-center gap-3">
          <div className="flex-1">
            <p className="text-sm font-bold text-amber-300">Keepsake carry chance</p>
            <p className="text-[11px] text-muted-foreground">
              Chance any opponent also wears one keepsake, on top of their boost slots. Beating them hands it over —
              the pool is every keepsake in the catalog ({keepsakeCount}), minus the ones you have already collected,
              picked evenly — rarity never gates which one shows up. Once you hold all {keepsakeCount} and every Lucky
              Coin, keepsakes join the ordinary item pool instead: opponents can wear any of them, as many as their
              slot count allows, still outside the rarity odds.
            </p>
          </div>
          <Input
            type="number"
            min={0}
            max={100}
            className="h-7 w-20 text-[11px] px-1 text-center"
            value={config.keepsakeChancePct}
            title="Chance (%) an opponent carries a keepsake (0 = never)"
            onChange={e => setKeepsakeChance(e.target.value)}
            data-testid="input-itemdist-keepsake-chance"
          />
        </div>
      </Card>

      {/* Rank 1 — the champion carries their own kit */}
      <Card className="p-3 w-full border-yellow-700/50">
        <p className="text-sm font-bold text-yellow-400 mb-2">Rank 1 (Champion)</p>
        <div className="grid gap-1 items-center" style={{ gridTemplateColumns: `repeat(${ITEM_RARITIES.length}, minmax(6.5rem, 1fr)) 4.5rem` }}>
          {ITEM_RARITIES.map(r => (
            <p key={r} className="text-[10px] font-bold text-center truncate" style={{ color: RARITY_COLORS[r] }}>
              {RARITY_SHORT[r]}
            </p>
          ))}
          <p className="text-[10px] font-bold text-muted-foreground text-center">Items</p>
          <RarityChanceSliders
            chances={config.rank1Chances}
            count={config.rank1Count}
            onChance={setRank1Chance}
            onCount={setRank1Count}
            testIdPrefix="slider-itemdist-rank1"
          />
        </div>
      </Card>

      {/* Band table */}
      <Card className="p-3 w-full overflow-x-auto">
        <div
          className="grid gap-1 min-w-[48rem]"
          style={{ gridTemplateColumns: `5.5rem repeat(${ITEM_RARITIES.length}, minmax(6.5rem, 1.4fr)) 4.5rem` }}
        >
          <p className="text-[10px] font-bold text-muted-foreground self-end">Ranks</p>
          {ITEM_RARITIES.map(r => (
            <p key={r} className="text-[10px] font-bold self-end text-center truncate" style={{ color: RARITY_COLORS[r] }} title={r}>
              {RARITY_SHORT[r]} %
            </p>
          ))}
          <p className="text-[10px] font-bold text-muted-foreground self-end text-center">Items</p>
          {config.bands.map((band, idx) => (
            <BandRow
              key={`${band.hiRank}-${band.loRank}`}
              band={band}
              idx={idx}
              onChance={setBandChance}
              onCount={setBandCount}
            />
          ))}
        </div>
      </Card>

      <Button
        variant="outline"
        size="sm"
        className="gap-1 text-xs text-muted-foreground"
        onClick={() => {
          clearItemDistConfig();
          setConfig(buildDefaultItemDistConfig());
        }}
        data-testid="button-reset-item-dist"
      >
        <RotateCcw className="w-3 h-3" /> Reset to defaults (no items)
      </Button>
    </div>
  );
}
