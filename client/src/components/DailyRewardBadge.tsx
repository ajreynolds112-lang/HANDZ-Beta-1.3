/**
 * Daily reward status chip for the gym HUD.
 *
 * Shows how long is left until the chests reset at 00:00 and when the last lot
 * was taken. Everything is read off the device clock and the career's own save,
 * so it keeps counting down with no connection — and when the countdown reaches
 * zero with the game still open, it asks the parent to claim the new day.
 */
import { useEffect, useRef, useState } from "react";
import type { CareerRosterState } from "@shared/schema";
import {
  dailyRewardAvailable,
  formatDailyCountdown,
  lastDailyRewardAt,
  msUntilNextDailyReward,
  todayKey,
} from "@/lib/dailyReward";

interface DailyRewardBadgeProps {
  roster?: CareerRosterState | null;
  /** Fired once when a new day rolls over while the gym is open. */
  onDue?: () => void;
  className?: string;
}

/** `Today 09:14`, `Yesterday 23:58`, `12 Mar 08:02`. */
function formatClaimedAt(ms: number): string {
  const d = new Date(ms);
  const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  const day = todayKey(d);
  const today = todayKey();
  if (day === today) return `Today ${time}`;
  const yesterday = todayKey(new Date(Date.now() - 86_400_000));
  if (day === yesterday) return `Yesterday ${time}`;
  return `${d.toLocaleDateString(undefined, { day: "numeric", month: "short" })} ${time}`;
}

export default function DailyRewardBadge({ roster, onDue, className = "" }: DailyRewardBadgeProps) {
  const [, setTick] = useState(0);
  // One repaint a second is enough for a minute-resolution countdown, and keeps
  // the gym's own animation loop untouched.
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  // Midnight while the gym is open: hand the claim back to the parent once for
  // the new day. Re-armed by the day key changing, so it can never loop.
  const claimedDayRef = useRef<string | null>(null);
  const due = dailyRewardAvailable(roster);
  useEffect(() => {
    if (!roster || !due) return;
    const today = todayKey();
    if (claimedDayRef.current === today) return;
    claimedDayRef.current = today;
    onDue?.();
  });

  if (!roster) return null;

  const claimedAt = lastDailyRewardAt(roster);
  const left = msUntilNextDailyReward();

  return (
    <div
      className={`bg-black/70 border border-white/10 rounded px-2 py-1 leading-tight ${className}`}
      title={claimedAt
        ? `Last daily reward: ${formatClaimedAt(claimedAt)} — chests reset at midnight`
        : "Chests reset at midnight"}
      data-testid="gym-daily-reward-badge"
    >
      <div className="flex items-center gap-1.5">
        <span className="text-[11px] leading-none">🎁</span>
        {/* A due reward is claimed the moment the gym opens, so the chip only
            ever needs to say when the next lot lands. */}
        <span className="text-white/70 text-[10px] font-mono" data-testid="text-daily-reward-status">
          Next reward in {formatDailyCountdown(left)}
        </span>
      </div>
      {claimedAt != null && !due && (
        <div className="text-white/35 text-[9px] font-mono" data-testid="text-daily-reward-last">
          Last: {formatClaimedAt(claimedAt)}
        </div>
      )}
    </div>
  );
}
