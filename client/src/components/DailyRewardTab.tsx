/**
 * Reward Rarity tab — the chests a career is handed once per real-world day,
 * decided by the rank it is sitting at.
 *
 * Rank bands are the same ranges as Roster Generation, but here they govern the
 * odds each daily chest rolls and how many chests the day pays out. Every edit
 * persists immediately, with no Save button and no confirmation.
 */
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { RotateCcw } from "lucide-react";
import PctInput from "@/components/PctInput";
import { CRATES, CRATE_IDS, type CrateId } from "@/game/cratesConfig";
import {
  DAILY_CRATE_COUNT_MAX, buildDefaultDailyRewardConfig, clampDailyCrateCount,
  clearDailyRewardConfig, loadDailyRewardConfig, rebalanceCrateChances, saveDailyRewardConfig,
  type CrateChances, type DailyRewardBand, type DailyRewardConfig,
} from "@/game/dailyRewardConfig";
import { useState } from "react";

/** Compact column headers — the legend above the table spells them out. */
const CRATE_SHORT: Record<CrateId, string> = {
  journeyman: "J", contender: "C", elite: "E", champion: "Ch", undisputed: "U", goat: "G",
};

/** Six percentage sliders (one per crate) plus the chests-per-day count. */
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
        max={DAILY_CRATE_COUNT_MAX}
        className="h-7 text-[11px] px-1 text-center"
        value={count}
        title={`Chests awarded per day (0–${DAILY_CRATE_COUNT_MAX}; 0 = none)`}
        onChange={e => onCount(e.target.value)}
        data-testid={`${testIdPrefix}-count`}
      />
    </>
  );
}

function BandRow({ band, idx, onChance, onCount }: {
  band: DailyRewardBand;
  idx: number;
  onChance: (idx: number, crate: CrateId, pct: number) => void;
  onCount: (idx: number, raw: string) => void;
}) {
  return (
    <>
      <p className="text-xs font-semibold self-center whitespace-nowrap" data-testid={`text-daily-band-${band.hiRank}`}>
        {band.hiRank === band.loRank ? band.hiRank : `${band.hiRank}–${band.loRank}`}
      </p>
      <CrateChanceSliders
        chances={band.chances}
        count={band.count}
        onChance={(id, pct) => onChance(idx, id, pct)}
        onCount={raw => onCount(idx, raw)}
        testIdPrefix={`slider-daily-${band.hiRank}`}
      />
    </>
  );
}

export default function DailyRewardTab() {
  const [config, setConfig] = useState<DailyRewardConfig>(() => loadDailyRewardConfig());

  /** Every edit lands in state and on disk in the same breath. */
  const commit = (next: DailyRewardConfig) => {
    setConfig(next);
    saveDailyRewardConfig(next);
  };

  const setBandChance = (idx: number, crate: CrateId, pct: number) => {
    commit({
      ...config,
      bands: config.bands.map((b, i) =>
        i === idx ? { ...b, chances: rebalanceCrateChances(b.chances, crate, pct) } : b),
    });
  };

  const setBandCount = (idx: number, raw: string) => {
    const val = parseInt(raw, 10);
    if (isNaN(val)) return;
    commit({
      ...config,
      bands: config.bands.map((b, i) => (i === idx ? { ...b, count: clampDailyCrateCount(val) } : b)),
    });
  };

  const setRank1Chance = (crate: CrateId, pct: number) => {
    commit({ ...config, rank1Chances: rebalanceCrateChances(config.rank1Chances, crate, pct) });
  };

  const setRank1Count = (raw: string) => {
    const val = parseInt(raw, 10);
    if (isNaN(val)) return;
    commit({ ...config, rank1Count: clampDailyCrateCount(val) });
  };

  return (
    <div className="flex flex-col items-center gap-3 w-full">
      <p className="text-[11px] text-muted-foreground w-full">
        Chests the <strong className="text-foreground">player</strong> is handed once a day, when the gym is opened on a
        new calendar day. The rank ranges are the same bands as Roster Generation; the six sliders are the % odds each
        chest is that crate — they always add up to 100, so raising one lowers the rest.{" "}
        <strong className="text-foreground">Chests</strong> is how many are handed out that day (0–{DAILY_CRATE_COUNT_MAX},
        0 = none), each rolled separately. Changes save automatically.
      </p>
      <div className="w-full flex flex-wrap gap-x-3 gap-y-1">
        {CRATE_IDS.map(id => (
          <span key={id} className="text-[10px] text-muted-foreground flex items-center gap-1">
            <span className="w-2.5 h-2.5 rounded-sm inline-block" style={{ background: CRATES[id].trim }} />
            {CRATE_SHORT[id]} = <span style={{ color: CRATES[id].trimLight }}>{CRATES[id].name}</span>
          </span>
        ))}
      </div>

      {/* Rank 1 — the champion's day is set on its own */}
      <Card className="p-3 w-full border-yellow-700/50">
        <p className="text-sm font-bold text-yellow-400 mb-2">Rank 1 (Champion)</p>
        <div className="grid gap-1 items-center" style={{ gridTemplateColumns: `repeat(${CRATE_IDS.length}, minmax(6.5rem, 1fr)) 4.5rem` }}>
          {CRATE_IDS.map(id => (
            <p key={id} className="text-[10px] font-bold text-center truncate" style={{ color: CRATES[id].trimLight }}>
              {CRATE_SHORT[id]}
            </p>
          ))}
          <p className="text-[10px] font-bold text-muted-foreground text-center">Chests</p>
          <CrateChanceSliders
            chances={config.rank1Chances}
            count={config.rank1Count}
            onChance={setRank1Chance}
            onCount={setRank1Count}
            testIdPrefix="slider-daily-rank1"
          />
        </div>
      </Card>

      {/* Band table */}
      <Card className="p-3 w-full overflow-x-auto">
        <div
          className="grid gap-1 min-w-[48rem]"
          style={{ gridTemplateColumns: `5.5rem repeat(${CRATE_IDS.length}, minmax(6.5rem, 1.4fr)) 4.5rem` }}
        >
          <p className="text-[10px] font-bold text-muted-foreground self-end">Ranks</p>
          {CRATE_IDS.map(id => (
            <p key={id} className="text-[10px] font-bold self-end text-center truncate" style={{ color: CRATES[id].trimLight }} title={CRATES[id].name}>
              {CRATE_SHORT[id]} %
            </p>
          ))}
          <p className="text-[10px] font-bold text-muted-foreground self-end text-center">Chests</p>
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
          clearDailyRewardConfig();
          setConfig(buildDefaultDailyRewardConfig());
        }}
        data-testid="button-reset-daily-reward"
      >
        <RotateCcw className="w-3 h-3" /> Reset to defaults (one chest a day)
      </Button>
    </div>
  );
}
