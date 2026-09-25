/**
 * Skill Refinement unlock meter — how close the player is to cracking the top
 * 650 and opening the Refinement system.
 *
 * The bar spans the whole climb: 0% at the dead-last rank a fresh career starts
 * on, 100% the moment the unlock rank is reached. It disappears once Refinement
 * is unlocked, since the number has nothing left to say.
 */
import type { CareerRosterState } from "@shared/schema";
import { TOTAL_ROSTER } from "@/game/rosterData";

/** Breaking into this rank unlocks the Refinement system. */
export const REFINEMENT_UNLOCK_RANK = 650;
/** Rank a fresh career starts on — the 0% end of the meter. */
const START_RANK = TOTAL_ROSTER + 1;

/** Is Refinement open for this career? Mirrors the gym's gate. */
export function isRefinementUnlocked(roster: CareerRosterState | null | undefined): boolean {
  if (!roster) return false;
  return !!roster.refinementPermanentlyUnlocked || (roster.playerRank ?? START_RANK) <= REFINEMENT_UNLOCK_RANK;
}

/** 0–100: how far the player has climbed toward the unlock rank. */
export function refinementUnlockProgress(roster: CareerRosterState | null | undefined): number {
  if (isRefinementUnlocked(roster)) return 100;
  const rank = roster?.playerRank ?? START_RANK;
  const climbed = START_RANK - rank;
  const total = START_RANK - REFINEMENT_UNLOCK_RANK;
  return Math.max(0, Math.min(100, (climbed / total) * 100));
}

interface RefinementProgressMeterProps {
  roster: CareerRosterState | null | undefined;
  /** Host's own unlock verdict — pass it so a dev bypass hides the meter too. */
  unlocked?: boolean;
  className?: string;
}

export default function RefinementProgressMeter({ roster, unlocked, className = "" }: RefinementProgressMeterProps) {
  // Nothing to chase once it is open.
  if (unlocked || isRefinementUnlocked(roster)) return null;

  const rank = roster?.playerRank ?? START_RANK;
  const pct = refinementUnlockProgress(roster);
  const ranksToGo = Math.max(0, rank - REFINEMENT_UNLOCK_RANK);

  return (
    <div
      className={`w-52 rounded border border-purple-800/60 bg-purple-950/40 px-2 py-1 ${className}`}
      title={`Reach rank ${REFINEMENT_UNLOCK_RANK} to unlock Skill Refinement — ${ranksToGo} rank${ranksToGo === 1 ? "" : "s"} to go`}
      data-testid="refinement-progress"
    >
      <div className="flex items-baseline justify-between gap-2 leading-none">
        <span className="text-purple-200 text-[10px] font-bold tracking-wide">🔷 REFINEMENT</span>
        <span className="text-purple-100 text-[10px] font-mono font-bold tabular-nums" data-testid="refinement-progress-pct">
          {Math.floor(pct)}%
        </span>
      </div>
      <div className="mt-1 h-1.5 rounded-full overflow-hidden bg-black/50">
        <div
          className="h-full rounded-full bg-gradient-to-r from-purple-600 to-fuchsia-400 transition-[width] duration-500"
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="mt-0.5 text-[9px] text-purple-300/80 leading-none" data-testid="refinement-progress-detail">
        {ranksToGo} rank{ranksToGo === 1 ? "" : "s"} to #{REFINEMENT_UNLOCK_RANK}
      </div>
    </div>
  );
}
