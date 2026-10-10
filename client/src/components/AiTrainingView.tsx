/**
 * AI Training — evolve boxers by sweeping the fundamentals they box on.
 *
 * The run tests one fundamental at a time. Every pair of seeds meets five times
 * while it is under test, and the seed that executed *that* fundamental best
 * during those bouts takes it: its parameters for that one fundamental are
 * copied into the Champion AI used by ordinary play, and nothing else about the
 * champion moves. The sweep then steps to the next fundamental. Working through
 * all 73 is what closes a generation, at which point the top half of the
 * population is kept whole, the bottom half is drawn again, and the sweep starts
 * over.
 *
 * So the champion is not any one seed. It is an assembly: 73 fundamentals, each
 * held by whichever seed proved best at it.
 *
 * Nothing is rendered. Every bout is headless, which is what makes the sweep
 * finishable — a generation is 5475 one-minute bouts.
 *
 * Seeds reach the AI through the ordinary neural-override channel, so what
 * evolves here is the same machinery the tuning screen edits by hand.
 */
import { useRef, useEffect, useState, useCallback } from "react";
import type { AiBrainState, GameState } from "@/game/types";
import {
  createInitialState, startFight, updateGame, handleKeyDown, handleKeyUp, clearAllKeys,
} from "@/game/engine";
import { initAiBrain } from "@/game/ai";
import { resetAutoZoom } from "@/game/renderer";
import { soundEngine } from "@/game/sound";
import { useFightScene3D } from "@/game/three/useFightScene3D";
import { setTrainingNeuralOverrides } from "@/components/NeuralNetworkView";
import {
  FUNDAMENTALS, EXEC_FLOOR, type FundamentalSeed,
  executionRate, lifetimeRate, winRate, rankSeeds,
  paramId,
} from "@/game/aiFundamentals";
import {
  type TrainingRun, type GenerationRecord, type FightObserver,
  type Pairing, type CycleBase, type FundCycleRecord, type CycleStat,
  DEFAULT_RUN_CONFIG, SWEEP_LENGTH, sweepPosition, setSweepSelection,
  createRun, runHeadless, cycleComplete, currentFundamental, cycleStat, cycleSize,
  neuralOverridesForRun, seedRosterId, newObserver, observeAiTick, foldAiObservations,
} from "@/game/aiTraining";
import {
  normalizeLearner, sigmaFor, LEAGUE_SIZE, GATE_MIN_BOUTS, GATE_ROLLBACK_BELOW,
  type LearnerState, type GateTally, type GateDecision,
} from "@/game/fundamentalLearning";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { X, Play, Pause, RotateCcw, Swords, ChevronLeft } from "lucide-react";
import RlTrainingPanel from "@/components/RlTrainingPanel";
import type { RlRun } from "@/game/rlRun";
import { buildLearnerBrain, newRlRuntime, stableRlRun, stopRl, RL_LEARNER_ROSTER_ID, type RlRuntime } from "@/game/rlTraining";
import { saveFundamentalsRun, loadFundamentalsRun, closeFundamentalCycle } from "@/game/fundamentalsRunStore";
import {
  pauseBackgroundTraining, takeSharedFundamentalsRun, takeSharedRlRun,
  shareFundamentalsRun, shareRlRun,
} from "@/game/backgroundTraining";
import BackgroundTrainingControl from "@/components/BackgroundTrainingControl";
import type { RlPolicy } from "@/game/rlPolicy";

type TrainingMode = "fundamentals" | "rl";

type Sparring =
  | { kind: "seed"; seed: FundamentalSeed; minutes: number; obs: FightObserver }
  | { kind: "rl"; policy: RlPolicy; minutes: number };

/** Keys the fight owns while a spar is up, kept in step with GameCanvas. */
const GAME_KEYS = [
  "arrowleft", "arrowright", "arrowup", "arrowdown", "escape", " ",
  "w", "e", "q", "r", "s", "d", "f", "a", "z", "x", "c", "v", "shift", "tab", "enter",
];
/** Milliseconds per frame handed to the sweep. Nothing is drawn, so this is
 *  most of the frame; what is left covers the React pass and the browser. */
const FRAME_BUDGET_MS = 12;

/** How often the in-flight cycle is written back. */
const AUTOSAVE_MS = 10000;


const pct = (v: number) => `${(v * 100).toFixed(1)}%`;

export default function AiTrainingView({ onExit }: { onExit: () => void }) {
  const runRef = useRef<TrainingRun | null>(null);
  const rafRef = useRef<number>(0);
  const lastRef = useRef<number>(0);
  const uiRef = useRef<number>(0);
  const saveRef = useRef<number>(0);
  const runningRef = useRef(false);

  const [running, setRunning] = useState(false);
  const [, forceTick] = useState(0);
  const [tab, setTab] = useState<"board" | "fundamentals" | "select">("board");
  const [selected, setSelected] = useState(0);
  const [sparring, setSparring] = useState<Sparring | null>(null);
  const [mode, setMode] = useState<TrainingMode>("fundamentals");
  // The RL run lives here rather than in its panel, so a spar (which unmounts
  // the panel) comes back to the same in-memory run instead of re-reading a
  // checkpoint that may still be on its way to disk.
  const rlRunRef = useRef<RlRun | null>(null);
  const rlRtRef = useRef<RlRuntime>(newRlRuntime());
  const [rlRunning, setRlRunning] = useState(false);

  runningRef.current = running;
  const modeRef = useRef<TrainingMode>(mode);
  modeRef.current = mode;

  // Only one trainer runs at a time: switching stops both.
  const switchMode = (m: TrainingMode) => {
    if (m === mode) return;
    setRunning(false);
    setRlRunning(false);
    setMode(m);
  };

  // Boot the population, then publish it so the AI can find each seed's brain.
  if (runRef.current === null) {
    // Background training hands over its live run (it is paused while this
    // screen is open); otherwise the run is read back from storage.
    pauseBackgroundTraining("view", true);
    rlRunRef.current = takeSharedRlRun();
    const run = takeSharedFundamentalsRun() ?? loadFundamentalsRun();
    runRef.current = run;
    setTrainingNeuralOverrides(neuralOverridesForRun(run));
  }

  const run = runRef.current!;

  const republish = useCallback(() => {
    setTrainingNeuralOverrides(neuralOverridesForRun(runRef.current!));
  }, []);

  useEffect(() => {
    soundEngine.setSilent(true);
    // Leaving the screen or closing the tab must not cost the cycle.
    const flush = () => { if (runRef.current) saveFundamentalsRun(runRef.current); };
    window.addEventListener("beforeunload", flush);
    return () => {
      window.removeEventListener("beforeunload", flush);
      flush();
      soundEngine.setSilent(false);
      setTrainingNeuralOverrides(null);
      clearAllKeys();
      // Hand the live runs back so background training (if switched on)
      // carries on from exactly here.
      if (runRef.current) shareFundamentalsRun(runRef.current);
      if (rlRunRef.current) shareRlRun(stableRlRun(rlRunRef.current, rlRtRef.current));
      stopRl(rlRtRef.current);
      pauseBackgroundTraining("view", false);
    };
  }, []);

  // The sweep. Every bout is headless, so the frame budget is spent entirely on
  // simulating; closing a fundamental hands its winner straight to the champion.
  useEffect(() => {
    const loop = (ts: number) => {
      if (lastRef.current === 0) lastRef.current = ts;
      lastRef.current = ts;
      const r = runRef.current!;

      if (runningRef.current && !sparring && modeRef.current === "fundamentals") {
        runHeadless(r, FRAME_BUDGET_MS);
        if (cycleComplete(r)) closeFundamentalCycle(r);
      }

      // The standings only move when a bout ends, so redrawing the tables every
      // frame would just steal time from the simulation.
      if (ts - uiRef.current > 200) {
        uiRef.current = ts;
        forceTick(n => (n + 1) % 1000000);
      }
      // Checkpoint the cycle as it goes, not just at its boundary.
      if (ts - saveRef.current > AUTOSAVE_MS) {
        saveRef.current = ts;
        saveFundamentalsRun(r);
      }
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafRef.current);
  }, [sparring]);

  const reset = () => {
    setRunning(false);
    const fresh = createRun(DEFAULT_RUN_CONFIG, Math.random);
    // The training list is a preference, not progress: it survives a reset.
    const keep = runRef.current?.selected;
    if (keep && keep.length > 0) setSweepSelection(fresh, keep, Math.random);
    runRef.current = fresh;
    republish();
    saveFundamentalsRun(fresh);
  };

  if (sparring && sparring.kind === "seed") {
    const { seed, obs } = sparring;
    return (
      <TraineeFight
        title={seed.name}
        minutes={sparring.minutes}
        enemyRosterId={seedRosterId(seed.id)}
        // Same reason as the tournament: give the brain the seed's own identity
        // so its evolved parameters are the ones being fought.
        buildBrain={() => initAiBrain("champion", "BoxerPuncher", 100, false, seedRosterId(seed.id))}
        onTick={(s, dt) => observeAiTick(obs, s, dt)}
        onClose={() => foldAiObservations(seed, obs)}
        onExit={() => {
          clearAllKeys();
          // The spar folds the AI's fundamentals straight into the seed, so the
          // population on disk is stale until this runs.
          saveFundamentalsRun(runRef.current!);
          setSparring(null);
        }}
      />
    );
  }
  if (sparring && sparring.kind === "rl") {
    const policy = sparring.policy;
    // A normal-speed bout against the training policy. Nothing is recorded and
    // nothing folds back: it never counts toward training.
    return (
      <TraineeFight
        title="RL policy (training)"
        minutes={sparring.minutes}
        enemyRosterId={RL_LEARNER_ROSTER_ID}
        buildBrain={() => buildLearnerBrain(policy, "BoxerPuncher", 100, { recording: false, cpuVsCpu: false })}
        onExit={() => {
          clearAllKeys();
          setSparring(null);
        }}
      />
    );
  }

  const ranked = rankSeeds(run.population);
  const sel = run.population.find(s => s.id === selected) || run.population[0];

  const fund = currentFundamental(run);
  const cycleTotal = cycleSize(run);
  const cycleFrac = cycleTotal > 0 ? Math.min(1, run.completed / cycleTotal) : 0;
  const sweep = sweepPosition(run);
  const sweepFrac = (sweep.pos + cycleFrac) / sweep.len;
  const pickedList = run.selected ?? [];
  const picked = new Set(pickedList);
  const looping = picked.size > 0;
  const applySelection = (keys: string[]) => {
    setSweepSelection(run, keys, Math.random);
    saveFundamentalsRun(run);
    forceTick(n => (n + 1) % 1000000);
  };

  // Cycle figures are read once and shared by the panel and the standings, so
  // the two can never disagree about who is leading the fundamental.
  const cycleById = new Map<number, CycleStat>();
  run.population.forEach(s => cycleById.set(s.id, cycleStat(run, s)));
  const cycleRows = [...run.population].sort((x, y) => {
    const a = cycleById.get(x.id)!, b = cycleById.get(y.id)!;
    return (b.rate - a.rate) || (b.attempts - a.attempts);
  });
  const lastClosed = run.cycleLog[run.cycleLog.length - 1];

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-[#07070b] text-white" data-testid="ai-training-view">
      <div className="mx-auto max-w-6xl space-y-4 p-4">

        <div className="flex flex-wrap items-center gap-2">
          <Button variant="ghost" size="sm" onClick={onExit} data-testid="button-training-exit">
            <ChevronLeft className="w-4 h-4" /> Back
          </Button>
          <div className="text-lg font-semibold">AI Training</div>
          <div className="flex rounded border border-white/15 p-0.5" data-testid="switch-training-mode">
            <Button size="sm" variant={mode === "fundamentals" ? "default" : "ghost"} className="h-7"
              onClick={() => switchMode("fundamentals")} data-testid="button-mode-fundamentals">
              Fundamentals
            </Button>
            <Button size="sm" variant={mode === "rl" ? "default" : "ghost"} className="h-7"
              onClick={() => switchMode("rl")} data-testid="button-mode-rl">
              RL Policy
            </Button>
          </div>
          {mode === "fundamentals" && <>
          <div className="text-xs text-white/50" data-testid="text-sweep-position">
            Generation {run.gen} · fundamental {sweep.pos + 1}/{sweep.len}{looping ? " selected" : ""} · {run.completed}/{cycleTotal} bouts
          </div>
          <div className="ml-auto flex gap-2">
            <Button size="sm" onClick={() => setRunning(v => !v)} data-testid="button-training-toggle">
              {running ? <><Pause className="w-4 h-4" /> Stop</> : <><Play className="w-4 h-4" /> Start</>}
            </Button>
            <Button size="sm" variant="outline" onClick={reset} data-testid="button-training-reset">
              <RotateCcw className="w-4 h-4" /> Reset
            </Button>
          </div>
          </>}
        </div>

        <BackgroundTrainingControl />

        {mode === "rl" ? (
          <RlTrainingPanel
            runRef={rlRunRef}
            rtRef={rlRtRef}
            running={rlRunning}
            setRunning={setRlRunning}
            onFight={(policy, minutes) => { setRlRunning(false); setSparring({ kind: "rl", policy, minutes }); }}
          />
        ) : (<>

        {/* Sweep progress. The bar is the whole 73-fundamental sweep, filled
            smoothly by the bouts inside the fundamental under test. */}
        <div className="space-y-1">
          <div className="h-2 w-full overflow-hidden rounded bg-white/10">
            <div className="h-full bg-yellow-500 transition-all" style={{ width: `${sweepFrac * 100}%` }} />
          </div>
          <div className="flex justify-between text-[11px] text-white/40">
            <span data-testid="text-sweep-count">
              {sweep.pos + 1} / {sweep.len} {looping ? "selected fundamentals (looping)" : "fundamentals"}
            </span>
            <span>{pct(sweepFrac)} of generation {run.gen}</span>
          </div>
        </div>

        {/* What is being tested right now. */}
        <div className="rounded border border-yellow-500/30 bg-yellow-500/5 p-3" data-testid="panel-fundamental-under-test">
          <div className="flex flex-wrap items-baseline gap-2">
            <span className="text-[10px] uppercase tracking-wide text-yellow-500/70">Under test</span>
            <span className="text-white/30 text-xs">{fund.id}</span>
            <span className="text-sm font-semibold" data-testid="text-current-fundamental">{fund.label}</span>
            <span className="ml-auto text-xs tabular-nums text-white/50">
              {run.completed}/{cycleTotal} bouts · {DEFAULT_RUN_CONFIG.meetingsPerFundamental} meetings a pair
            </span>
          </div>
          <div className="pt-1 text-xs text-white/50">{fund.meaning}</div>
          <div className="pt-1 text-[11px] text-white/35">
            Chance: {fund.opportunity} — Executed: {fund.success}
          </div>
          <div className="mt-2 h-1 w-full overflow-hidden rounded bg-white/10">
            <div className="h-full bg-yellow-500/60" style={{ width: `${cycleFrac * 100}%` }} />
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 pt-2 text-[11px]">
            {cycleRows.map((s, i) => {
              const c = cycleById.get(s.id)!;
              return (
                <span key={s.id} className={c.attempts === 0 ? "text-white/25" : i === 0 ? "text-yellow-400" : "text-white/55"}>
                  {s.name}{" "}
                  <span className="tabular-nums">
                    {c.attempts === 0 ? "—" : `${c.successes}/${c.attempts} · ${pct(c.rate)}`}
                  </span>
                </span>
              );
            })}
          </div>
          <div className="pt-2 text-[11px] text-white/35">
            When this cycle closes, the leader's parameters for {fund.label} — and nothing
            else — are written into the Champion AI used in ordinary play.
          </div>
        </div>

        <div className="flex gap-2">
          <Button size="sm" variant={tab === "board" ? "default" : "outline"} onClick={() => setTab("board")}>
            Standings
          </Button>
          <Button size="sm" variant={tab === "fundamentals" ? "default" : "outline"} onClick={() => setTab("fundamentals")} data-testid="button-tab-fundamentals">
            Fundamentals
          </Button>
          <Button size="sm" variant={tab === "select" ? "default" : "outline"} onClick={() => setTab("select")} data-testid="button-tab-select">
            Training list {looping ? `(${picked.size})` : "(all)"}
          </Button>
        </div>

        {tab === "select" && (
          <div className="space-y-2" data-testid="panel-training-list">
            <div className="flex flex-wrap items-center gap-2 text-xs text-white/50">
              <span>
                Tick the fundamentals to train. The sweep visits only those, in order, and
                starts over after the last one (the generation cut happens there). Nothing
                ticked trains all {SWEEP_LENGTH}. A cycle already under way finishes first.
              </span>
              <div className="ml-auto flex gap-2">
                <Button size="sm" variant="outline" className="h-7"
                  onClick={() => applySelection(FUNDAMENTALS.map(f => f.key))} data-testid="button-select-all">
                  All
                </Button>
                <Button size="sm" variant="outline" className="h-7"
                  onClick={() => applySelection([])} data-testid="button-select-none">
                  Clear
                </Button>
              </div>
            </div>
            {[
              { title: "Advanced", list: FUNDAMENTALS.filter(f => f.layer !== "basics") },
              { title: "Basics", list: FUNDAMENTALS.filter(f => f.layer === "basics") },
            ].map(g => (
              <div key={g.title} className="rounded border border-white/10 p-2">
                <div className="flex items-center gap-2 pb-1 text-xs text-white/60">
                  <span>{g.title}</span>
                  <button className="text-white/40 underline hover:text-white/70"
                    onClick={() => applySelection(pickedList.concat(g.list.map(f => f.key).filter(k => !picked.has(k))))}
                    data-testid={`button-select-group-${g.title.toLowerCase()}`}>
                    tick all
                  </button>
                  <button className="text-white/40 underline hover:text-white/70"
                    onClick={() => applySelection(pickedList.filter(k => !g.list.some(f => f.key === k)))}
                    data-testid={`button-clear-group-${g.title.toLowerCase()}`}>
                    untick all
                  </button>
                </div>
                <div className="grid gap-x-4 gap-y-1 sm:grid-cols-2 lg:grid-cols-3">
                  {g.list.map(f => {
                    const on = picked.has(f.key);
                    return (
                      <label key={f.key} className="flex cursor-pointer items-center gap-2 text-xs" title={f.meaning}>
                        <Checkbox checked={on}
                          onCheckedChange={v => applySelection(v
                            ? pickedList.concat(f.key)
                            : pickedList.filter(k => k !== f.key))}
                          data-testid={`checkbox-fund-${f.key}`} />
                        <span className="w-6 text-right tabular-nums text-white/35">{f.id}</span>
                        <span className={on ? "text-white" : "text-white/60"}>{f.label}</span>
                        {f.key === fund.key && <span className="text-yellow-500/80">· testing</span>}
                      </label>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}

        {tab === "board" && (
          <div className="space-y-2">
            <div className="overflow-x-auto rounded border border-white/10">
              <table className="w-full text-xs">
                <thead className="bg-white/5 text-white/60">
                  <tr>
                    <th className="p-2 text-left">Seed</th>
                    <th className="p-2 text-right">W</th>
                    <th className="p-2 text-right">Bouts</th>
                    <th className="p-2 text-right">Win rate</th>
                    <th className="p-2 text-right" title="wins / bouts against frozen past champions this generation">League</th>
                    <th className="p-2 text-right" title={`execution of ${fund.label} in this cycle only`}>
                      {fund.label}
                    </th>
                    <th className="p-2" />
                  </tr>
                </thead>
                <tbody>
                  {ranked.map((s, i) => {
                    const safe = i < Math.ceil(ranked.length / 2);
                    const c = cycleById.get(s.id);
                    return (
                      <tr key={s.id} className={`border-t border-white/10 ${safe ? "" : "bg-red-500/5"}`}>
                        <td className="p-2">
                          {safe
                            ? <span className="mr-1 text-yellow-500" title="kept at the end of the generation">★</span>
                            : <span className="mr-1 text-red-400/70" title="replaced at the end of the generation">✕</span>}
                          {s.name}
                        </td>
                        <td className="p-2 text-right">{s.wins}</td>
                        <td className="p-2 text-right">{s.bouts}</td>
                        <td className="p-2 text-right">{pct(winRate(s))}</td>
                        <td className="p-2 text-right tabular-nums text-white/60">
                          {run.leagueTally?.[s.id]?.bouts
                            ? `${run.leagueTally[s.id].wins}/${run.leagueTally[s.id].bouts}`
                            : <span className="text-white/25">—</span>}
                        </td>
                        <td className="p-2 text-right tabular-nums text-white/60">
                          {!c || c.attempts === 0
                            ? <span className="text-white/25" title="nothing credited this cycle">—</span>
                            : `${pct(c.rate)}`}
                        </td>
                        <td className="p-2">
                          <div className="flex justify-end gap-1">
                            <Button size="sm" variant="ghost" onClick={() => { setSelected(s.id); setTab("fundamentals"); }}>
                              View
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => setSparring({ kind: "seed", seed: s, minutes: 1, obs: newObserver() })} data-testid={`button-fight-${s.id}`}>
                              <Swords className="w-3 h-3" />
                            </Button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="text-xs text-white/40">
              ★ is kept whole at the end of the generation, which is the end of the sweep. ✕ is
              thrown out and drawn again, apart from any fundamental it executed more often than
              every seed above it.
            </div>
            <div className="text-xs text-white/40">
              Every bout credits both corners, won or lost. A bout turns on all {SWEEP_LENGTH}{" "}
              fundamentals at once, so which seed won it says nothing about which one executes
              <span className="text-white/60"> {fund.label}</span> best — the column below is the
              only thing that decides it. Ties go to the seed with more attempts, and if nobody
              executes it at all the Champion keeps the parameters it already had.
            </div>
            <div className="text-xs text-white/40">
              The column headed <span className="text-white/60">{fund.label}</span> is this cycle
              alone, not the generation: it is what the fundamental is being decided on.
            </div>

            {run.cycleLog.length > 0 && (
              <div className="rounded border border-white/10 p-3 text-xs" data-testid="panel-cycle-log">
                <div className="pb-1 text-white/60">Fundamentals sent to the Champion AI</div>
                {run.cycleLog.slice(-8).reverse().map(c => (
                  <div key={`${c.gen}-${c.index}-${c.fundKey}`} className="flex flex-wrap gap-2 border-t border-white/5 py-1">
                    <span className="w-24 text-white/40">Gen {c.gen} · {c.index}/{SWEEP_LENGTH}</span>
                    <span className="w-56 truncate">{c.label}</span>
                    <span className="text-yellow-500/80">{c.winnerName}</span>
                    <span className="tabular-nums text-white/40">
                      {c.attempts > 0 ? `${pct(c.rate)} of ${c.attempts}` : "no chances came up"}
                    </span>
                    {c.attempts === 0
                      ? <span className="text-orange-400/60" title="nobody executed it, so the Champion kept the parameters it had">kept</span>
                      : <span className="text-white/30" title="situations remembered for this fundamental">{c.situations} states</span>}
                  </div>
                ))}
              </div>
            )}

            {lastClosed && (
              <div className="text-xs text-white/40">
                Last closed: <span className="text-white/60">{lastClosed.label}</span>, situations from{" "}
                <span className="text-white/60">{lastClosed.winnerName}</span>.
              </div>
            )}

            <div className="flex flex-wrap items-center gap-2 text-xs text-white/50">
              <span>Fight a seed at normal speed for</span>
              {[1, 2, 3].map(m => (
                <Button key={m} size="sm" variant="outline" disabled={!ranked[0]}
                  onClick={() => ranked[0] && setSparring({ kind: "seed", seed: ranked[0], minutes: m, obs: newObserver() })}
                  data-testid={`button-spar-${m}`}>
                  {m} min
                </Button>
              ))}
              <span>against {ranked[0]?.name ?? "the leader"}.</span>
            </div>

            <div className="rounded border border-white/10 p-3 text-xs space-y-1" data-testid="panel-learning">
              <div className="text-white/60">Learning</div>
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-white/50">
                <span>
                  {fund.label} search width{" "}
                  <span className="text-white/80 tabular-nums">{pct(sigmaFor(run.learner ?? normalizeLearner(null), fund.key))}</span>
                </span>
                <span>
                  steps taken <span className="text-white/80 tabular-nums">{run.learner?.steps[fund.key] ?? 0}</span>
                </span>
                {lastClosed && (
                  <span>
                    last step ({lastClosed.label}){" "}
                    <span className="text-white/80 tabular-nums">
                      {lastClosed.stepped ? pct(lastClosed.stepSize ?? 0) : "none"}
                    </span>
                  </span>
                )}
                <span>
                  league <span className="text-white/80">{run.league?.length ?? 0}/{LEAGUE_SIZE}</span>
                </span>
                <span>
                  gate{" "}
                  {run.lastGood
                    ? <span className="text-white/80 tabular-nums">
                        {run.gate?.wins ?? 0}–{run.gate?.losses ?? 0} of {run.gate?.bouts ?? 0}
                        {(run.gate?.bouts ?? 0) < GATE_MIN_BOUTS && <span className="text-white/40"> (needs {GATE_MIN_BOUTS})</span>}
                      </span>
                    : <span className="text-white/40">opens after gen 1</span>}
                </span>
                {run.lastGate && (
                  <span className={run.lastGate.rolledBack ? "text-red-400/80" : "text-green-400/80"}>
                    gen {run.lastGate.gen}: {run.lastGate.rolledBack ? "rolled back" : "passed"} at {pct(run.lastGate.rate)}
                  </span>
                )}
              </div>
              <div className="text-white/40">
                Each closed cycle moves the Champion's block for that fundamental one step toward
                the seeds that executed it better than the field and away from the ones that did
                worse — every seed counts, rates are weighed by how many chances they rest on, and
                no parameter moves more than 12% of its range in one step. Replacements are drawn
                around the Champion at a width that grows while steps agree and shrinks when they
                flip, plus one fully random explorer. Every seed also boxes the last {LEAGUE_SIZE}{" "}
                champions that passed their gate; the Champion boxes the last one that passed, and
                a generation that wins under {pct(GATE_ROLLBACK_BELOW)} of those is rolled back.
              </div>
            </div>

            {run.history.length > 0 && (
              <div className="rounded border border-white/10 p-3 text-xs">
                <div className="pb-1 text-white/60">Previous generations</div>
                {run.history.slice(-6).reverse().map(h => (
                  <div key={h.gen} className="flex flex-wrap gap-2 border-t border-white/5 py-1">
                    <span className="w-16 text-white/40">Gen {h.gen}</span>
                    <span>
                      kept {h.standings.filter(s => (h.survivors ?? []).includes(s.id)).map(s => s.name).join(", ") || "—"}
                    </span>
                    <span className="text-red-400/50">
                      replaced {(h.replaced ?? []).length}
                    </span>
                    <span className="text-white/40">
                      best {pct(h.standings[0]?.rate ?? 0)}
                    </span>
                    {h.gate?.decided && (
                      <span className={h.gate.rolledBack ? "text-red-400/70" : "text-green-400/70"}>
                        gate {h.gate.rolledBack ? "rolled back" : "passed"} {pct(h.gate.rate)}
                      </span>
                    )}
                    {Object.keys(h.salvage).length > 0 && (
                      <span className="text-yellow-500/70">
                        {Object.values(h.salvage).reduce((a, b) => a + b.length, 0)} fundamentals carried over
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {tab === "fundamentals" && sel && (
          <div className="space-y-2">
            <div className="flex flex-wrap gap-1">
              {run.population.map(s => (
                <Button key={s.id} size="sm" variant={s.id === sel.id ? "default" : "outline"}
                  onClick={() => setSelected(s.id)}>
                  {s.name}
                </Button>
              ))}
            </div>
            <div className="text-xs text-white/50">
              Execution floor is {pct(EXEC_FLOOR)} of the chances a fundamental gets.
              A fundamental that never came up is not counted against the seed.
            </div>
            <div className="text-xs text-white/40">
              The first figure is this generation, and it starts again at every cut because
              that is what the cut has to judge on. <span className="text-white/60">life</span> is
              the running total for this slot across every generation it has ever run — it carries
              through cuts, replacements and reloads, and nothing clears it.
            </div>

            {FUNDAMENTALS.map(f => {
              const st = sel.stats[f.key] ?? { attempts: 0, successes: 0 };
              const lt = sel.lifetime?.[f.key] ?? { attempts: 0, successes: 0 };
              const rate = executionRate(sel, f.key);
              const failing = st.attempts > 0 && rate < EXEC_FLOOR;
              const carried = sel.salvaged.includes(f.key);
              const testing = f.key === fund.key;
              return (
                <div key={f.key} className={`rounded border p-3 ${
                  testing ? "border-yellow-500/40 bg-yellow-500/5"
                    : failing ? "border-red-500/40 bg-red-500/5"
                      : "border-white/10 bg-black/20"}`}>
                  <div className="flex flex-wrap items-baseline gap-2">
                    <span className="text-white/30 text-xs">{f.id}</span>
                    <span className="text-sm font-semibold">{f.label}</span>
                    {testing && <span className="rounded bg-yellow-500/20 px-1 text-[10px] text-yellow-400">under test</span>}
                    {carried && <span className="rounded bg-yellow-500/20 px-1 text-[10px] text-yellow-400">carried over</span>}
                    <span className="ml-auto flex items-baseline gap-2">
                      <span className={`text-xs tabular-nums ${failing ? "text-red-400" : "text-white/60"}`}
                        title="this generation — cleared at the cut">
                        {st.successes}/{st.attempts} · {pct(rate)}
                      </span>
                      <span className="text-[11px] tabular-nums text-white/35"
                        title="lifetime for this slot across every generation — never cleared">
                        life {lt.successes}/{lt.attempts} · {pct(lifetimeRate(sel, f.key))}
                      </span>
                    </span>
                  </div>
                  <div className="pt-1 text-xs text-white/50">{f.meaning}</div>
                  <div className="pt-1 text-[11px] text-white/35">
                    Chance: {f.opportunity} — Executed: {f.success}
                  </div>
                  <div className="grid grid-cols-2 gap-x-4 pt-2 md:grid-cols-4">
                    {f.params.map(pr => {
                      const id = paramId(f.key, pr.key);
                      const v = sel.params[id] ?? pr.def;
                      const drift = v - pr.def;
                      const champ = run.champion.params[id] ?? pr.def;
                      return (
                        <div key={pr.key} className="text-[11px]">
                          <div className="truncate text-white/45">{pr.label}</div>
                          <div className="flex items-baseline gap-1">
                            <span className="tabular-nums">{v.toFixed(3)}</span>
                            <span className={`tabular-nums ${Math.abs(drift) < 0.005 ? "text-white/25" : drift > 0 ? "text-green-400/70" : "text-orange-400/70"}`}>
                              {drift >= 0 ? "+" : ""}{drift.toFixed(3)}
                            </span>
                            <span className="tabular-nums text-white/25" title="what the Champion AI is currently holding">
                              ch {champ.toFixed(3)}
                            </span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        )}
        </>)}
      </div>
    </div>
  );
}

// ------------------------------------------------------- fight one of them

/**
 * Take the CPU's place against a trainee.
 *
 * The player corner is fully hand-driven — `cpuVsCpu` is false and the player
 * brain is nulled, so nothing is steering the fighter but the keyboard.
 *
 * Only the AI corner is scored. A human is not a seed: what the person at the
 * keyboard does is not evidence about anything being evolved, so their side is
 * never measured, and the AI's fundamental counts are the only thing that
 * reaches the population. The record — wins, losses, bouts — is left alone
 * entirely, because a seed's win rate has to stay comparable with the seeds it
 * is ranked against.
 */
function TraineeFight({ title, minutes, enemyRosterId, buildBrain, onTick, onClose, onExit }: {
  title: string;
  minutes: number;
  enemyRosterId?: number;
  /** Builds the AI corner's brain once the fight has started. */
  buildBrain: () => AiBrainState;
  /** Called after every engine step (the seed spar scores the AI side here). */
  onTick?: (s: GameState, dt: number) => void;
  /** Called exactly once when the fight goes away. */
  onClose?: () => void;
  onExit: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stateRef = useRef<GameState | null>(null);
  const closedRef = useRef(false);
  const rafRef = useRef<number>(0);
  const lastRef = useRef<number>(0);
  const tickRef = useRef(onTick);
  tickRef.current = onTick;
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const view3d = useFightScene3D();

  if (stateRef.current === null) {
    resetAutoZoom();
    const s = startFight(
      createInitialState(),
      "BoxerPuncher", 100, 100,
      "You", undefined,
      true, "champion",
      1, minutes * 60, "normal",
      65, 65,
      "BoxerPuncher", title,
      undefined,
      false, false, false, false,
      false,                 // player-controlled
      undefined,
      false, undefined,
      1, 1, 1,
      undefined, undefined,
      false,
      enemyRosterId,
    );
    s.aiBrain = buildBrain();
    // Explicit: this corner is the player's, and nothing else is to drive it.
    s.playerAiBrain = null;
    s.phase = "fighting";
    s.countdownTimer = 0;
    s.introAnimActive = false;
    s.introAnimTimer = 0;
    s.playerIntroPlaying = false;
    s.enemyIntroPlaying = false;
    stateRef.current = s;
  }

  // Close once, on the way out. Guarded because an effect cleanup runs twice
  // under StrictMode and whatever onClose folds is cumulative.
  useEffect(() => () => {
    if (closedRef.current) return;
    closedRef.current = true;
    closeRef.current?.();
  }, []);

  // The parent rebuilds onExit on every render and re-renders five times a
  // second to refresh the standings. This effect must therefore not depend on
  // it: re-running the cleanup mid-fight calls clearAllKeys(), which drops
  // whatever key is being held and makes movement and blocking nearly unusable.
  const exitRef = useRef(onExit);
  exitRef.current = onExit;

  useEffect(() => {
    soundEngine.setSilent(false);
    const down = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase();
      // Same set the real fight swallows. Without this the arrows and space
      // scroll the standings page sitting behind this overlay instead of
      // reaching the fighter.
      if (GAME_KEYS.includes(key)) e.preventDefault();
      if (key === "escape") { exitRef.current(); return; }
      handleKeyDown(e);
    };
    const up = (e: KeyboardEvent) => handleKeyUp(e);
    // A held key that is released while the window is unfocused never delivers
    // its keyup, so it would stay down forever.
    const blur = () => clearAllKeys();
    const vis = () => { if (document.hidden) clearAllKeys(); };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    document.addEventListener("visibilitychange", vis);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
      document.removeEventListener("visibilitychange", vis);
      soundEngine.setSilent(true);
      clearAllKeys();
    };
  }, []);

  useEffect(() => {
    const loop = (ts: number) => {
      if (lastRef.current === 0) lastRef.current = ts;
      const dt = Math.min(0.05, (ts - lastRef.current) / 1000);
      lastRef.current = ts;
      let s = stateRef.current!;
      if (s.phase === "fighting" || s.phase === "prefight") {
        s = updateGame({ ...s }, dt);
        stateRef.current = s;
        tickRef.current?.(s, dt);
      }
      view3d.draw(canvasRef.current?.getContext("2d") ?? null, s);
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafRef.current);
  }, []);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black" data-testid="trainee-fight">
      <div className="relative" style={{ lineHeight: 0 }}>
        <canvas
          ref={view3d.glCanvasRef}
          className="absolute inset-0 block"
          style={{ width: "100%", height: "100%", pointerEvents: "none", visibility: "hidden" }}
        />
        <canvas ref={canvasRef} width={800} height={600} className="relative block" style={{ height: "100vh", width: "auto" }} />
      </div>
      <div className="absolute top-3 left-3 text-xs text-white/50">
        {title} · {minutes} min · Esc to leave
      </div>
      <Button size="sm" variant="destructive" className="absolute top-3 right-3" onClick={onExit}>
        <X className="w-4 h-4" /> Leave
      </Button>
    </div>
  );
}
