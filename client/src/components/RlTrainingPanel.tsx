/**
 * AI Training — RL Policy mode.
 *
 * Trains the RL tactical policy with PPO on the same headless bouts the
 * fundamentals sweep uses. The run and its runtime are owned by the parent
 * (AiTrainingView) so a spar, which unmounts this panel, comes back to the
 * very same in-memory run.
 */
import { useEffect, useRef, useState, type MutableRefObject } from "react";
import { Button } from "@/components/ui/button";
import { Play, Pause, Swords, Upload } from "lucide-react";
import { AI_STRINGS_BY_ID } from "@/game/aiStrings";
import { RL_UTILITIES, RL_UTILITY_LABELS, rlPolicyToJson, type RlPolicy } from "@/game/rlPolicy";
import { loadRlDeployConfig, saveRlDeployConfig, rlPolicyDeployProblem, RL_DEPLOY_MODE_LABELS } from "@/game/rlDeploy";
import {
  RL_REWARD_TERMS,
  RL_REWARD_TERM_LABELS,
  type RlRewardWeights,
} from "@/game/rlReward";
import {
  createRlRun,
  loadRlCheckpoint,
  rlRecentSummary,
  sanitizeRlOpponentMix,
  RL_RECENT_WINDOW,
  type RlPickCounts,
  type RlRun,
} from "@/game/rlRun";
import {
  newRlRuntime,
  runRlFrame,
  saveRlRun,
  stableRlPolicy,
  runFromDeployedIfAhead,
  stopRl,
  type RlRuntime,
} from "@/game/rlTraining";

/** Same share of the frame the sweep gets. */
const FRAME_BUDGET_MS = 12;
const AUTOSAVE_MS = 15000;

const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
const fmt = (v: number, d = 3) => (Number.isFinite(v) ? v.toFixed(d) : "—");

/** Weight inputs, in the order the design note lists them. */
const WEIGHT_ROWS: { key: keyof RlRewardWeights; label: string; term?: (typeof RL_REWARD_TERMS)[number]; unit: string }[] = [
  { key: "damage", label: RL_REWARD_TERM_LABELS.damage, term: "damage", unit: "per 1% of opp. pool" },
  { key: "counter", label: RL_REWARD_TERM_LABELS.counter, term: "counter", unit: "per landed punch" },
  { key: "perfectBlock", label: RL_REWARD_TERM_LABELS.perfectBlock, term: "perfectBlock", unit: "per block" },
  { key: "dodge", label: RL_REWARD_TERM_LABELS.dodge, term: "dodge", unit: "per slip" },
  { key: "lowStamina", label: RL_REWARD_TERM_LABELS.lowStamina, term: "lowStamina", unit: "per decision" },
  { key: "chargedWhiff", label: RL_REWARD_TERM_LABELS.chargedWhiff, term: "chargedWhiff", unit: "per whiff" },
  { key: "passiveBehind", label: RL_REWARD_TERM_LABELS.passiveBehind, term: "passiveBehind", unit: "per second" },
  { key: "win", label: "Win bonus", term: "outcome", unit: "per bout" },
  { key: "loss", label: "Loss bonus", unit: "per bout" },
];

function Sparkline({ values, color, testId }: { values: number[]; color: string; testId?: string }) {
  if (values.length < 2) {
    return <div className="h-10 text-[10px] text-white/25 flex items-center" data-testid={testId}>waiting for updates</div>;
  }
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = hi - lo || 1;
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * 100},${36 - ((v - lo) / span) * 32}`).join(" ");
  return (
    <svg viewBox="0 0 100 40" preserveAspectRatio="none" className="h-10 w-full" data-testid={testId}>
      <polyline points={pts} fill="none" stroke={color} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function Stat({ label, value, sub, testId }: { label: string; value: string; sub?: string; testId?: string }) {
  return (
    <div className="rounded border border-white/10 bg-black/20 p-2">
      <div className="text-[10px] uppercase tracking-wide text-white/40">{label}</div>
      <div className="text-lg font-semibold tabular-nums" data-testid={testId}>{value}</div>
      {sub && <div className="text-[10px] text-white/40 tabular-nums">{sub}</div>}
    </div>
  );
}

function PickTables({ picks, policy }: { picks: RlPickCounts | null; policy: RlPolicy }) {
  if (!picks || picks.n === 0) {
    return <div className="text-xs text-white/30">No decisions recorded yet.</div>;
  }
  const top = Object.entries(picks.strings)
    .map(([id, n]) => ({ id: Number(id), n }))
    .sort((a, b) => b.n - a.n)
    .slice(0, 10);
  const tempoMax = Math.max(1, ...picks.tempo);
  return (
    <div className="grid gap-4 md:grid-cols-3">
      <div>
        <div className="pb-1 text-[11px] text-white/45">Most-picked strings</div>
        {top.map((r) => {
          const def = AI_STRINGS_BY_ID.get(r.id);
          return (
            <div key={r.id} className="flex items-baseline gap-2 text-xs" data-testid={`row-rl-string-${r.id}`}>
              <span className="truncate" title={def?.raw}>{def?.name ?? `#${r.id}`}</span>
              <span className="ml-auto tabular-nums text-white/50">{pct(r.n / picks.n)}</span>
            </div>
          );
        })}
      </div>
      <div>
        <div className="pb-1 text-[11px] text-white/45">Tempo (seconds between punches)</div>
        {policy.tempoBins.map((t, i) => (
          <div key={i} className="flex items-center gap-2 text-xs">
            <span className="w-10 tabular-nums text-white/60">{t.toFixed(2)}</span>
            <div className="h-2 flex-1 rounded bg-white/5">
              <div className="h-2 rounded bg-sky-400/60" style={{ width: `${((picks.tempo[i] ?? 0) / tempoMax) * 100}%` }} />
            </div>
            <span className="w-12 text-right tabular-nums text-white/50">{pct((picks.tempo[i] ?? 0) / picks.n)}</span>
          </div>
        ))}
      </div>
      <div>
        <div className="pb-1 text-[11px] text-white/45">Utility</div>
        {RL_UTILITIES.map((u, i) => (
          <div key={u} className="flex items-baseline gap-2 text-xs">
            <span>{RL_UTILITY_LABELS[u]}</span>
            <span className="ml-auto tabular-nums text-white/50">{pct((picks.utility[i] ?? 0) / picks.n)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function RlTrainingPanel({ runRef, rtRef, running, setRunning, onFight }: {
  runRef: MutableRefObject<RlRun | null>;
  rtRef: MutableRefObject<RlRuntime>;
  running: boolean;
  setRunning: (v: boolean) => void;
  onFight: (policy: RlPolicy, minutes: number) => void;
}) {
  const [loaded, setLoaded] = useState(runRef.current !== null);
  const [, forceTick] = useState(0);
  const [message, setMessage] = useState<string | null>(null);
  const [fightMinutes, setFightMinutes] = useState(1);
  const runningRef = useRef(running);
  runningRef.current = running;
  const rafRef = useRef(0);
  const uiRef = useRef(0);
  const saveRef = useRef(0);

  // Resume the stored run, or start fresh when there is none. Either way, a
  // deployed policy further trained than the run (uploaded, or from another
  // browser such as the published site) takes over, so the trainer continues
  // from it and its step count matches.
  useEffect(() => {
    const adopt = (next: RlRun) => {
      setRunning(false);
      stopRl(rtRef.current);
      rtRef.current = newRlRuntime();
      runRef.current = next;
      setMessage(`Synced to the deployed policy (${next.updates} updates, ${next.totalSteps.toLocaleString()} steps).`);
      void saveRlRun(next, rtRef.current);
    };
    if (runRef.current) {
      const next = runFromDeployedIfAhead(runRef.current);
      if (next) adopt(next);
      return;
    }
    let cancelled = false;
    loadRlCheckpoint().then((stored) => {
      if (cancelled || runRef.current) return;
      const next = runFromDeployedIfAhead(stored);
      if (next) {
        adopt(next);
      } else if (stored) {
        runRef.current = stored;
      } else {
        runRef.current = createRlRun((Math.random() * 0x7fffffff) >>> 0);
        void saveRlRun(runRef.current, rtRef.current);
      }
      setLoaded(true);
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runRef, rtRef]);

  // Leaving the screen or closing the tab keeps the run; the bout in progress
  // is dropped (it would otherwise be scored half-played).
  useEffect(() => {
    const flush = () => { if (runRef.current) void saveRlRun(runRef.current, rtRef.current); };
    const onHide = () => { if (document.visibilityState === "hidden") flush(); };
    window.addEventListener("beforeunload", flush);
    document.addEventListener("visibilitychange", onHide);
    return () => {
      window.removeEventListener("beforeunload", flush);
      document.removeEventListener("visibilitychange", onHide);
      stopRl(rtRef.current);
      flush();
    };
  }, [runRef, rtRef]);

  // Stopping puts the in-progress bout back in the queue.
  useEffect(() => {
    if (!running) {
      stopRl(rtRef.current);
      if (runRef.current) void saveRlRun(runRef.current, rtRef.current);
    }
  }, [running, runRef, rtRef]);

  useEffect(() => {
    const loop = (ts: number) => {
      const run = runRef.current;
      if (run && runningRef.current) {
        const updated = runRlFrame(run, rtRef.current, FRAME_BUDGET_MS);
        if (updated || ts - saveRef.current > AUTOSAVE_MS) {
          saveRef.current = ts;
          void saveRlRun(run, rtRef.current);
        }
      }
      if (ts - uiRef.current > 250) {
        uiRef.current = ts;
        forceTick((n) => (n + 1) % 1000000);
      }
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafRef.current);
  }, [runRef, rtRef]);

  const run = runRef.current;
  if (!loaded || !run) {
    return <div className="text-sm text-white/50" data-testid="text-rl-loading">Loading RL checkpoint…</div>;
  }
  const rt = rtRef.current;
  const sum = rlRecentSummary(run);
  const hist = run.history;
  const last = hist[hist.length - 1];
  const deploy = loadRlDeployConfig();
  const rewardPending = JSON.stringify(run.reward) !== JSON.stringify(run.pendingReward);
  const updating = rt.job !== null;
  const updateFrac = rt.job
    ? (rt.job.epoch * rt.job.data.length + rt.job.cursor) / Math.max(1, run.ppo.epochs * rt.job.data.length)
    : 0;

  const deployNow = () => {
    const policy = stableRlPolicy(run, rt);
    policy.meta = { ...policy.meta, trainedSteps: run.totalSteps, updates: run.updates, note: `Deployed from AI Training after ${run.updates} updates` };
    const json = rlPolicyToJson(policy);
    const problem = rlPolicyDeployProblem(json);
    if (problem) { setMessage(`Can't deploy: ${problem}`); return; }
    const cfg = loadRlDeployConfig();
    saveRlDeployConfig({ mode: cfg.mode, policy: json });
    const check = loadRlDeployConfig();
    if (!check.policy || check.policy.meta?.note !== json.meta?.note) {
      setMessage("Deploy failed: the browser refused to store the policy (storage full?).");
      return;
    }
    // The deployed policy is a registered tuning section: the Neural Network
    // screen's watcher writes it to the build defaults, so this is the policy
    // the next publish ships.
    setMessage(cfg.mode === "off"
      ? "Deployed — this is now the version your next publish ships. Live use is Off — switch it on in the Neural Network screen's RL policy section."
      : `Deployed — this is now the version your next publish ships. Live fights (${RL_DEPLOY_MODE_LABELS[cfg.mode]}) use this policy.`);
  };

  const setWeight = (k: keyof RlRewardWeights, v: string) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return;
    run.pendingReward = { ...run.pendingReward, [k]: n };
    forceTick((x) => x + 1);
  };
  const setMix = (patch: Partial<RlRun["mix"]>) => {
    run.mix = sanitizeRlOpponentMix({ ...run.mix, ...patch });
    forceTick((x) => x + 1);
  };

  return (
    <div className="space-y-4" data-testid="panel-rl-training">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={() => setRunning(!running)} data-testid="button-rl-toggle">
          {running ? <><Pause className="w-4 h-4" /> Stop</> : <><Play className="w-4 h-4" /> {run.totalSteps > 0 ? "Resume" : "Start"}</>}
        </Button>
        <Button size="sm" variant="outline" onClick={deployNow} data-testid="button-rl-deploy">
          <Upload className="w-4 h-4" /> Deploy
        </Button>
        <div className="flex items-center gap-1">
          <Button size="sm" variant="outline" onClick={() => onFight(stableRlPolicy(run, rt), fightMinutes)} data-testid="button-rl-fight">
            <Swords className="w-4 h-4" /> Fight this policy
          </Button>
          <select
            className="h-8 rounded border border-white/15 bg-black/40 px-1 text-xs"
            value={fightMinutes}
            onChange={(e) => setFightMinutes(Number(e.target.value))}
            data-testid="select-rl-fight-minutes"
          >
            {[1, 2, 3].map((m) => <option key={m} value={m}>{m} min</option>)}
          </select>
        </div>
        <span className="ml-auto text-[11px] text-white/40">
          Live use: <span className="text-white/70">{RL_DEPLOY_MODE_LABELS[deploy.mode]}</span>
          {deploy.policy ? ` · deployed policy ${deploy.policy.meta?.trainedSteps ?? 0} steps` : " · nothing deployed"}
        </span>
      </div>
      {message && <div className="text-xs text-yellow-300/80" data-testid="text-rl-message">{message}</div>}

      <div className="grid grid-cols-2 gap-2 md:grid-cols-6">
        <Stat label="Decision steps" value={run.totalSteps.toLocaleString()} testId="text-rl-steps" />
        <Stat label="Bouts" value={run.boutsPlayed.toLocaleString()} sub={`${run.updates} updates`} testId="text-rl-bouts" />
        <Stat label={`Win rate (last ${RL_RECENT_WINDOW})`} value={sum.bouts ? pct(sum.winRate) : "—"}
          sub={`${sum.wins}W ${sum.losses}L ${sum.draws}D`} testId="text-rl-winrate" />
        <Stat label="vs Champion / snapshots"
          value={`${sum.vsChampion.bouts ? pct(sum.vsChampion.winRate) : "—"} / ${sum.vsSnapshot.bouts ? pct(sum.vsSnapshot.winRate) : "—"}`}
          sub={`${sum.vsChampion.bouts} / ${sum.vsSnapshot.bouts} bouts`} testId="text-rl-vs" />
        <Stat label="Avg reward / bout" value={sum.bouts ? fmt(sum.avgReward, 2) : "—"}
          sub={`${fmt(sum.avgDecisions, 1)} decisions / bout`} testId="text-rl-avg-reward" />
        <Stat label={updating ? "Updating policy" : "Rollout"}
          value={updating ? pct(updateFrac) : `${run.buffer.length}/${run.ppo.rolloutSize}`}
          sub={updating ? `${run.ppo.epochs} epochs · minibatch ${run.ppo.minibatch}` : `${run.bufferBouts} bouts in buffer`}
          testId="text-rl-rollout" />
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div className="rounded border border-white/10 bg-black/20 p-3">
          <div className="pb-2 text-sm font-semibold">Training curves</div>
          <div className="grid grid-cols-2 gap-3 text-[11px]">
            {([
              ["Avg reward", hist.map((h) => h.avgReward), "#facc15", fmt(last?.avgReward ?? NaN, 2)],
              ["Win rate", hist.map((h) => h.winRate), "#4ade80", last ? pct(last.winRate) : "—"],
              ["Policy loss", hist.map((h) => h.policyLoss), "#f472b6", fmt(last?.policyLoss ?? NaN, 4)],
              ["Value loss", hist.map((h) => h.valueLoss), "#60a5fa", fmt(last?.valueLoss ?? NaN, 3)],
              ["Entropy", hist.map((h) => h.entropy), "#c084fc", fmt(last?.entropy ?? NaN, 3)],
              ["Approx. KL / clip", hist.map((h) => h.approxKl), "#fb923c", last ? `${fmt(last.approxKl, 4)} · ${pct(last.clipFrac)}` : "—"],
            ] as const).map(([label, vals, color, latest]) => (
              <div key={label}>
                <div className="flex items-baseline gap-1">
                  <span className="text-white/45">{label}</span>
                  <span className="ml-auto tabular-nums" data-testid={`text-rl-${label.toLowerCase().replace(/[^a-z]+/g, "-")}`}>{latest}</span>
                </div>
                <Sparkline values={[...vals]} color={color} />
              </div>
            ))}
          </div>
        </div>

        <div className="rounded border border-white/10 bg-black/20 p-3">
          <div className="flex items-baseline pb-2">
            <span className="text-sm font-semibold">Reward</span>
            <span className="ml-auto text-[11px] text-white/40">
              {rewardPending ? "edits apply from the next rollout" : `avg per bout over last ${sum.bouts} bouts`}
            </span>
          </div>
          <table className="w-full text-xs">
            <thead>
              <tr className="text-[10px] uppercase tracking-wide text-white/35">
                <th className="text-left font-normal">Term</th>
                <th className="text-right font-normal">Per bout</th>
                <th className="text-right font-normal">Weight</th>
              </tr>
            </thead>
            <tbody>
              {WEIGHT_ROWS.map((r) => {
                const avg = r.term && r.key !== "loss" ? sum.avgTerms[r.term] : null;
                const changed = run.pendingReward[r.key] !== run.reward[r.key];
                return (
                  <tr key={r.key} className="border-t border-white/5">
                    <td className="py-1">
                      <div>{r.key === "win" ? RL_REWARD_TERM_LABELS.outcome : r.label}</div>
                      <div className="text-[10px] text-white/30">{r.key === "win" ? "win bonus" : r.unit}</div>
                    </td>
                    <td className={`py-1 text-right tabular-nums ${avg == null ? "text-white/20" : avg >= 0 ? "text-green-400/80" : "text-orange-400/80"}`}
                      data-testid={`text-rl-term-${r.key}`}>
                      {avg == null ? "" : fmt(avg, 2)}
                    </td>
                    <td className="py-1 text-right">
                      <input
                        type="number"
                        step="0.1"
                        className={`w-20 rounded border bg-black/40 px-1 text-right tabular-nums ${changed ? "border-yellow-500/60" : "border-white/15"}`}
                        value={run.pendingReward[r.key]}
                        onChange={(e) => setWeight(r.key, e.target.value)}
                        data-testid={`input-rl-weight-${r.key}`}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div className="rounded border border-white/10 bg-black/20 p-3">
        <div className="flex flex-wrap items-baseline gap-2 pb-2">
          <span className="text-sm font-semibold">Opponent pool</span>
          <span className="text-[11px] text-white/40">
            {run.snapshots.length} frozen snapshot{run.snapshots.length === 1 ? "" : "s"}
            {run.snapshots.length > 0 && ` (updates ${run.snapshots.map((s) => s.update).join(", ")})`}
            {run.snapshots.length === 0 && " — every bout is against the Champion until the first one is saved"}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-4 text-xs">
          <label className="flex items-center gap-2">
            <span className="text-white/50">Champion share</span>
            <input type="range" min={0} max={100} step={5} value={Math.round(run.mix.championShare * 100)}
              onChange={(e) => setMix({ championShare: Number(e.target.value) / 100 })}
              data-testid="input-rl-champion-share" />
            <span className="w-10 tabular-nums">{pct(run.mix.championShare)}</span>
          </label>
          <label className="flex items-center gap-2">
            <span className="text-white/50">Snapshot every</span>
            <input type="number" min={1} className="w-14 rounded border border-white/15 bg-black/40 px-1 text-right"
              value={run.mix.snapshotEvery} onChange={(e) => setMix({ snapshotEvery: Number(e.target.value) })}
              data-testid="input-rl-snapshot-every" />
            <span className="text-white/50">updates</span>
          </label>
          <label className="flex items-center gap-2">
            <span className="text-white/50">Keep</span>
            <input type="number" min={1} className="w-14 rounded border border-white/15 bg-black/40 px-1 text-right"
              value={run.mix.maxSnapshots} onChange={(e) => setMix({ maxSnapshots: Number(e.target.value) })}
              data-testid="input-rl-max-snapshots" />
            <span className="text-white/50">snapshots</span>
          </label>
        </div>
      </div>

      <div className="rounded border border-white/10 bg-black/20 p-3">
        <div className="flex items-baseline pb-2">
          <span className="text-sm font-semibold">What the policy picks</span>
          <span className="ml-auto text-[11px] text-white/40">
            {run.picks.n > 0 ? `current rollout · ${run.picks.n} decisions` : run.lastPicks ? "last rollout" : ""}
          </span>
        </div>
        <PickTables picks={run.picks.n > 0 ? run.picks : run.lastPicks} policy={run.policy} />
      </div>
    </div>
  );
}
