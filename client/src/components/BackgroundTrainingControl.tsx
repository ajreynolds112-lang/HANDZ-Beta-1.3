/**
 * On/off switch for background training (fundamentals + RL), with a 1–8 hour
 * timer. "full" is the control panel; "badge" is a small floating pill shown
 * anywhere in the game while a session is on, with a Stop button.
 */
import { useEffect, useState, useSyncExternalStore } from "react";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import {
  subscribeBackgroundTraining, getBackgroundTrainingStatus,
  startBackgroundTraining, stopBackgroundTraining, setBackgroundTrainingPrefs,
  BG_TRAINING_MIN_HOURS, BG_TRAINING_MAX_HOURS, type BgTrainingStatus,
} from "@/game/backgroundTraining";

const HOURS = Array.from(
  { length: BG_TRAINING_MAX_HOURS - BG_TRAINING_MIN_HOURS + 1 },
  (_, i) => BG_TRAINING_MIN_HOURS + i,
);

function useStatus(): BgTrainingStatus {
  return useSyncExternalStore(subscribeBackgroundTraining, getBackgroundTrainingStatus);
}

/** Re-render once a second so the countdown moves. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

function left(endsAt: number | null, now: number): string {
  if (endsAt == null) return "";
  const s = Math.max(0, Math.round((endsAt - now) / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h > 0 ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m ${String(sec).padStart(2, "0")}s`;
}

function pauseText(st: BgTrainingStatus): string | null {
  if (!st.paused) return null;
  if (st.pausedFor.includes("view")) return "paused while AI Training is open";
  return "paused during the bout";
}

function progressText(st: BgTrainingStatus): string {
  const parts: string[] = [];
  if (st.fundamentals && st.fundGen != null) {
    parts.push(`Gen ${st.fundGen} · ${st.fundName} ${st.fundDone}/${st.fundTotal}`);
  }
  if (st.rl && st.rlSteps != null) parts.push(`RL ${st.rlSteps.toLocaleString()} steps · ${st.rlUpdates} updates`);
  return parts.join("  ·  ");
}

export default function BackgroundTrainingControl({ variant = "full" }: { variant?: "full" | "badge" }) {
  const st = useStatus();
  const now = useNow(st.on);

  if (variant === "badge") {
    if (!st.on) return null;
    const p = pauseText(st);
    return (
      <div
        className="fixed bottom-3 left-3 z-[60] flex items-center gap-2 rounded-full border border-yellow-500/40 bg-black/80 px-3 py-1 text-[11px] text-white/80 shadow-lg"
        data-testid="badge-bg-training"
      >
        <span className={`h-2 w-2 rounded-full ${p ? "bg-white/40" : "animate-pulse bg-yellow-400"}`} />
        <span>Training in background · {left(st.endsAt, now)} left{p ? ` · ${p}` : ""}</span>
        <button className="ml-1 text-white/50 underline hover:text-white" onClick={() => stopBackgroundTraining("off")}
          data-testid="button-bg-training-stop">
          Stop
        </button>
      </div>
    );
  }

  const p = pauseText(st);
  const prog = progressText(st);
  return (
    <div className="flex flex-wrap items-center gap-3 rounded border border-white/15 bg-black/30 px-3 py-2 text-xs"
      data-testid="panel-bg-training">
      <label className="flex cursor-pointer items-center gap-2">
        <Switch
          checked={st.on}
          disabled={!st.fundamentals && !st.rl}
          onCheckedChange={v => (v ? startBackgroundTraining() : stopBackgroundTraining("off"))}
          data-testid="switch-bg-training"
        />
        <span className="font-semibold">Background training</span>
      </label>
      <label className="flex cursor-pointer items-center gap-1">
        <Checkbox checked={st.fundamentals} onCheckedChange={v => setBackgroundTrainingPrefs({ fundamentals: !!v })}
          data-testid="checkbox-bg-fundamentals" />
        Fundamentals
      </label>
      <label className="flex cursor-pointer items-center gap-1">
        <Checkbox checked={st.rl} onCheckedChange={v => setBackgroundTrainingPrefs({ rl: !!v })}
          data-testid="checkbox-bg-rl" />
        RL
      </label>
      <label className="flex items-center gap-1">
        <span className="text-white/50">for</span>
        <select
          className="h-7 rounded border border-white/15 bg-black/40 px-1"
          value={st.hours}
          onChange={e => setBackgroundTrainingPrefs({ hours: Number(e.target.value) })}
          data-testid="select-bg-hours"
        >
          {HOURS.map(h => <option key={h} value={h}>{h} hour{h === 1 ? "" : "s"}</option>)}
        </select>
      </label>
      <span className="text-white/45" data-testid="text-bg-status">
        {st.on
          ? <>{left(st.endsAt, now)} left{p ? ` · ${p}` : ""}{prog ? ` · ${prog}` : ""}</>
          : st.lastEnded === "time" ? "Time's up — stopped." : "Off. Runs until the timer ends or the page reloads."}
      </span>
    </div>
  );
}
