/**
 * Defensive Mastery meter — sits under Punch Endurance in the gym.
 *
 * Shows a 0-100% bar (see game/defensiveMastery.ts) and the next reward.
 * Every 10% tier the
 * bar reaches pays diamonds once; payment happens here, off the freshest save,
 * the moment the gym sees a tier that has not been paid yet.
 */
import { useEffect } from "react";
import type { CareerRosterState, Fighter } from "@shared/schema";
import {
  defensiveMasteryOf, defensiveMasteryTier, defensiveMasteryPaidTierOf,
  defensiveMasteryTierDiamonds, DEFENSIVE_MASTERY_AUTO_SLIP_TARGET,
} from "@/game/defensiveMastery";
import * as localSaves from "@/lib/localSaves";
import MeterHoverReadout from "@/components/MeterHoverReadout";

interface DefensiveMasteryMeterProps {
  fighter: Fighter;
  roster: CareerRosterState | null | undefined;
  onFighterChanged?: (fighter: Fighter) => void;
  className?: string;
}

export default function DefensiveMasteryMeter({ fighter, roster, onFighterChanged, className = "" }: DefensiveMasteryMeterProps) {
  const m = defensiveMasteryOf(fighter, roster);
  const tier = defensiveMasteryTier(m.pct);

  // Pay any 10% tiers reached but not yet paid. Re-derived from the saved
  // record so a stale prop can never pay a tier twice (the storage layer also
  // refuses to lower the paid mark).
  useEffect(() => {
    const saved = localSaves.getFighter(fighter.id);
    const rs = saved?.careerRosterState as CareerRosterState | null | undefined;
    if (!saved || !rs) return;
    const reached = defensiveMasteryTier(defensiveMasteryOf(saved, rs).pct);
    const paid = defensiveMasteryPaidTierOf(rs);
    if (reached <= paid) return;
    let gain = 0;
    for (let t = paid + 1; t <= reached; t++) gain += defensiveMasteryTierDiamonds(t);
    const updated = localSaves.updateFighter(fighter.id, {
      diamonds: (saved.diamonds ?? 0) + gain,
      careerRosterState: { ...rs, defensiveMasteryPaidTier: reached },
    });
    if (updated) onFighterChanged?.(updated);
  }, [fighter.id, tier]); // eslint-disable-line react-hooks/exhaustive-deps

  const nextTier = Math.min(10, tier + 1);
  const nextReward = tier < 10 ? defensiveMasteryTierDiamonds(nextTier) : 0;

  return (
    <div
      className={`group relative w-52 rounded border border-sky-800/60 bg-sky-950/40 px-2 py-1 ${className}`}
      data-testid="defensive-mastery-progress"
    >
      <MeterHoverReadout
        title="DEFENSIVE MASTERY"
        testId="defensive-mastery-readout"
        rows={[
          { label: `Defense refinement (Lv.${m.bestRefinementLevel}/100)`, value: `${m.refinementPct.toFixed(3)}%` },
          { label: `Defense stat (${m.defenseLevel}/1000)`, value: `${m.defensePct.toFixed(3)}%` },
          { label: `Auto slip (${(m.autoSlip * 100).toFixed(3)}%/${(DEFENSIVE_MASTERY_AUTO_SLIP_TARGET * 100).toFixed(0)}%)`, value: `${m.autoSlipPct.toFixed(3)}%` },
          { label: "Perfect blocks", value: `+${m.perfectBlockPct.toFixed(4)}%` },
          { label: "Total", value: `${(Math.floor(m.pct * 1000) / 1000).toFixed(3)}%` },
        ]}
      />
      <div className="flex items-baseline justify-between gap-2 leading-none">
        <span className="text-sky-200 text-[10px] font-bold tracking-wide">🛡️ DEFENSIVE MASTERY</span>
        <span className="text-white text-[10px] font-mono font-bold tabular-nums" data-testid="defensive-mastery-value">
          {(Math.floor(m.pct * 1000) / 1000).toFixed(3)}%
        </span>
      </div>
      <div className="relative mt-1 h-1.5 rounded-full overflow-hidden bg-black/50">
        <div
          className="h-full rounded-full bg-gradient-to-r from-sky-600 to-cyan-300 transition-[width] duration-500"
          style={{ width: `${m.pct}%` }}
        />
        {/* 10% reward ticks */}
        {Array.from({ length: 9 }, (_, i) => (
          <div key={i} className="absolute top-0 h-full w-px bg-black/60" style={{ left: `${(i + 1) * 10}%` }} />
        ))}
      </div>
      <div className="mt-0.5 text-[9px] leading-none text-cyan-300" data-testid="defensive-mastery-reward">
        {tier < 10
          ? <>Next reward at {nextTier * 10}%: {nextReward}💎</>
          : <>All rewards claimed</>}
      </div>
    </div>
  );
}
