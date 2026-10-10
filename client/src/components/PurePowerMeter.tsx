/**
 * Pure Power meter — sits under Defensive Mastery in the gym. 0-100%, fed by
 * Weight Lifting (see game/purePower.ts).
 */
import type { CareerRosterState } from "@shared/schema";
import {
  purePowerOf, purePowerBonusOf, PURE_POWER_MAX, PURE_POWER_PER_SESSION,
  PURE_POWER_CRIT_RESIST_PER_STEP, PURE_POWER_FULL_STAMINA_PENALTY, PURE_POWER_FULL_SPEED_PENALTY,
} from "@/game/purePower";
import MeterHoverReadout from "@/components/MeterHoverReadout";

interface PurePowerMeterProps {
  roster: CareerRosterState | null | undefined;
  className?: string;
}

export default function PurePowerMeter({ roster, className = "" }: PurePowerMeterProps) {
  const pct = purePowerOf(roster);
  const bonus = Math.round(purePowerBonusOf(roster) * 100);
  const critCut = Math.round(Math.floor(pct / PURE_POWER_PER_SESSION) * PURE_POWER_CRIT_RESIST_PER_STEP * 100);
  const full = pct >= PURE_POWER_MAX;
  return (
    <div className={`group relative w-52 rounded border border-rose-800/60 bg-rose-950/40 px-2 py-1 ${className}`} data-testid="pure-power-progress">
      <MeterHoverReadout
        title="PURE POWER"
        testId="pure-power-readout"
        rows={[
          { label: "Power", value: `+${bonus}%`, tone: bonus > 0 ? "good" : undefined },
          { label: "Crit chance against you", value: `-${critCut}%`, tone: critCut > 0 ? "good" : undefined },
          { label: "Max stamina", value: full ? `-${Math.round(PURE_POWER_FULL_STAMINA_PENALTY * 100)}%` : "0%", tone: full ? "bad" : undefined },
          { label: "Speed", value: full ? `-${Math.round(PURE_POWER_FULL_SPEED_PENALTY * 100)}%` : "0%", tone: full ? "bad" : undefined },
        ]}
      />
      <div className="flex items-baseline justify-between gap-2 leading-none">
        <span className="text-rose-200 text-[10px] font-bold tracking-wide">💪 PURE POWER</span>
        <span className="text-white text-[10px] font-mono font-bold tabular-nums" data-testid="pure-power-value">{Math.round(pct)}%</span>
      </div>
      <div className="relative mt-1 h-1.5 rounded-full overflow-hidden bg-black/50">
        <div
          className="h-full rounded-full bg-gradient-to-r from-rose-700 to-amber-300 transition-[width] duration-500"
          style={{ width: `${(pct / PURE_POWER_MAX) * 100}%` }}
        />
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="absolute top-0 h-full w-px bg-black/60" style={{ left: `${(i + 1) * 20}%` }} />
        ))}
      </div>
      <div className="mt-0.5 text-[9px] leading-none text-amber-300" data-testid="pure-power-bonus">+{bonus}% Power</div>
    </div>
  );
}
