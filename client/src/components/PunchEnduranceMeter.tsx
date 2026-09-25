/**
 * Punch Endurance meter — how many punches the player currently gets per hit to
 * their max stamina, and how big that hit is.
 *
 * Two numbers, moved by two different pieces of gym work and read in opposite
 * directions: punches-per-hit is grown by sparring (higher is better), while the
 * percentage of the pool each hit costs is drilled down by the heavy bag (lower
 * is better).
 * Whichever one has moved since the player last had it on screen is called out
 * in green or red, once.
 *
 * Styled after the Refinement unlock meter it sits under, and always visible:
 * the numbers only move in the gym, so they belong beside the rest of the
 * training readouts whether or not Refinement has opened.
 */
import { useEffect, useRef } from "react";
import type { CareerRosterState } from "@shared/schema";
import {
  punchEnduranceOf, punchEnduranceLossOf,
  PUNCH_ENDURANCE_MAX, PUNCH_ENDURANCE_LOSS_MIN,
} from "@/game/punchEndurance";
import * as localSaves from "@/lib/localSaves";

interface PunchEnduranceMeterProps {
  roster: CareerRosterState | null | undefined;
  /** Whose save carries the "already seen these numbers" markers. */
  fighterId?: string;
  className?: string;
}

/** null = unchanged, "good" = moved the player's way, "bad" = moved against them. */
type Flash = null | "good" | "bad";

function flashClass(flash: Flash): string {
  if (flash === "good") return "text-green-400 font-bold";
  if (flash === "bad") return "text-red-400 font-bold";
  return "";
}

export default function PunchEnduranceMeter({ roster, fighterId, className = "" }: PunchEnduranceMeterProps) {
  const value = punchEnduranceOf(roster);
  const loss = punchEnduranceLossOf(roster);
  const pct = Math.max(0, Math.min(100, (value / PUNCH_ENDURANCE_MAX) * 100));

  // The pair the player had on screen last time, captured once per mount from
  // the freshest save rather than from the roster prop — the prop is a parent
  // snapshot, and re-reading it would let a change flash again on every render.
  //
  // Held past the point the effect below records the new pair, deliberately: the
  // highlight should stay lit for as long as the gym is on screen, and only fall
  // back to white the next time the player comes in.
  const seenRef = useRef<{ pe?: number; loss?: number } | null>(null);
  if (seenRef.current === null) {
    const saved = fighterId
      ? (localSaves.getFighter(fighterId)?.careerRosterState as CareerRosterState | null | undefined)
      : null;
    seenRef.current = { pe: saved?.punchEnduranceSeen, loss: saved?.punchEnduranceLossSeen };
  }

  // A save with no marker yet has simply never been looked at — that is not a
  // change, so it must not flash. Only a recorded number that no longer matches
  // counts.
  const seen = seenRef.current;
  const peFlash: Flash = typeof seen.pe === "number" && seen.pe !== value
    ? (value > seen.pe ? "good" : "bad")
    : null;
  const lossFlash: Flash = typeof seen.loss === "number" && seen.loss !== loss
    ? (loss < seen.loss ? "good" : "bad")
    : null;

  useEffect(() => {
    if (fighterId) localSaves.markPunchEnduranceSeen(fighterId, value, loss);
  }, [fighterId, value, loss]);

  return (
    <div
      className={`w-52 rounded border border-orange-800/60 bg-orange-950/40 px-2 py-1 ${className}`}
      title={`Punch Endurance — you lose ${loss}% of your max stamina every ${value} punches you throw, and it stays lost for the rest of the fight. Sparring, the Doghouse and Nightmare raise the punch count (max ${PUNCH_ENDURANCE_MAX}); after three weeks without sparring it sheds a point a week. Every heavy bag session cuts the stamina hit by 1% (down to ${PUNCH_ENDURANCE_LOSS_MIN}%); after three weeks off the bag it climbs back a point a week. Neither clock runs during fight week.`}
      data-testid="punch-endurance-progress"
    >
      <div className="flex items-baseline justify-between gap-2 leading-none">
        <span className="text-orange-200 text-[10px] font-bold tracking-wide">🥊 PUNCH ENDURANCE</span>
        <span className="text-white text-[10px] font-mono font-bold tabular-nums" data-testid="punch-endurance-value">
          {value}/{PUNCH_ENDURANCE_MAX}
        </span>
      </div>
      <div className="mt-1 h-1.5 rounded-full overflow-hidden bg-black/50">
        <div
          className="h-full rounded-full bg-gradient-to-r from-orange-600 to-amber-400 transition-[width] duration-500"
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="mt-0.5 text-[9px] text-white leading-none" data-testid="punch-endurance-detail">
        <span className={flashClass(lossFlash)} data-testid="punch-endurance-loss-amount">{loss}%</span>
        {" max stamina per "}
        <span className={flashClass(peFlash)} data-testid="punch-endurance-punch-count">{value}</span>
        {" punches thrown"}
      </div>
    </div>
  );
}
