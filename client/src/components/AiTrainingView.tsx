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
import { setTrainingNeuralOverrides, promoteToChampion } from "@/components/NeuralNetworkView";
import {
  FUNDAMENTALS, EXEC_FLOOR, type FundamentalSeed,
  normalizeSeed, executionRate, lifetimeRate, winRate, rankSeeds,
  deriveNeuralState, paramId,
} from "@/game/aiFundamentals";
import {
  type TrainingRun, type GenerationRecord, type FightObserver,
  type Pairing, type CycleBase, type FundCycleRecord, type CycleStat,
  DEFAULT_RUN_CONFIG, SWEEP_LENGTH,
  createRun, runHeadless, advanceFundamental, cycleComplete, startCycle,
  currentFundamental, cycleStat, cycleSize,
  neuralOverridesFor, seedRosterId,
  newObserver, observeAiTick, foldAiObservations,
} from "@/game/aiTraining";
import { serializeStore, deserializeStore, emptyStore } from "@/game/fundamentalStates";
import { publishChampionFundamentals } from "@/game/championStates";
import { Button } from "@/components/ui/button";
import { X, Play, Pause, RotateCcw, Swords, ChevronLeft } from "lucide-react";
import RlTrainingPanel from "@/components/RlTrainingPanel";
import type { RlRun } from "@/game/rlRun";
import { buildLearnerBrain, newRlRuntime, RL_LEARNER_ROSTER_ID, type RlRuntime } from "@/game/rlTraining";
import type { RlPolicy } from "@/game/rlPolicy";

type TrainingMode = "fundamentals" | "rl";

type Sparring =
  | { kind: "seed"; seed: FundamentalSeed; minutes: number; obs: FightObserver }
  | { kind: "rl"; policy: RlPolicy; minutes: number };

const LS_KEY = "handz_ai_training";
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

interface Persisted {
  population: FundamentalSeed[];
  gen: number;
  history: GenerationRecord[];
  // The part-finished cycle. A cycle is 75 bouts and a sweep is 73 of them, so
  // without these a reload throws away everything gathered since the last
  // fundamental closed.
  fundIndex?: number;
  schedule?: Pairing[];
  cursor?: number;
  completed?: number;
  cycleBase?: Record<number, CycleBase>;
  /** Situation memory assembled so far, one entry per closed fundamental. */
  championStates?: Record<string, unknown>;
  /** Seed id -> what it has learned about the fundamental still under test. */
  cycleStores?: Record<string, Record<string, unknown>>;
  /** The assembled champion — one fundamental's winner at a time. */
  champion?: FundamentalSeed;
  cycleLog?: FundCycleRecord[];
}

function load(): Persisted | null {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as Persisted;
    if (!Array.isArray(p.population) || p.population.length === 0) return null;
    return { ...p, population: p.population.map(normalizeSeed) };
  } catch { return null; }
}

function save(run: TrainingRun) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({
      population: run.population, gen: run.gen, history: run.history.slice(-25),
      fundIndex: run.fundIndex,
      schedule: run.schedule, cursor: run.cursor, completed: run.completed,
      cycleBase: run.cycleBase,
      champion: run.champion, cycleLog: run.cycleLog,
      championStates: serializeStore(run.championStates ?? emptyStore()),
      cycleStores: Object.fromEntries(Object.entries(run.cycleStores)
        .map(([id, st]) => [id, serializeStore(st)])),
    } satisfies Persisted));
  } catch { /* storage full or unavailable — training is scratch work, carry on */ }
}

/**
 * Put a part-finished sweep back where it was: same fundamental, same fixtures,
 * same place in them, same pending per-pairing evidence, and the same champion
 * assembled so far. Rebuilding instead would restart the fundamental from zero
 * on every reload.
 *
 * Nothing needs requeuing: a headless bout either finishes inside the frame or
 * has its cursor put back, so no bout is ever half-run when this is written.
 */
function restoreCycle(run: TrainingRun, saved: Persisted) {
  const size = run.population.length;

  if (Number.isFinite(saved.fundIndex)) {
    run.fundIndex = Math.min(Math.max(saved.fundIndex as number, 0), FUNDAMENTALS.length - 1);
  }
  if (saved.champion) run.champion = normalizeSeed(saved.champion);
  if (Array.isArray(saved.cycleLog)) run.cycleLog = saved.cycleLog;
  // The memory belongs with the champion, not with the cycle: it is the whole
  // sweep's worth of closed fundamentals and survives a reopened cycle.
  if (saved.championStates) run.championStates = deserializeStore(saved.championStates);

  const sched = saved.schedule;
  // Length is checked, not just validity. A save written before the sweep
  // existed carries a whole 1000-bout generation in this field, and every
  // pairing in it is still a legal pairing — adopting it would run one
  // fundamental for thirteen cycles' worth of bouts.
  const expected = ((size * (size - 1)) / 2) * run.meetingsPerFundamental;
  const usable = Array.isArray(sched)
    && sched.length === expected
    && !sched.some(p => !p || p.a >= size || p.b >= size || p.a < 0 || p.b < 0)
    // Without a baseline there is nothing to measure the cycle against, and the
    // one createRun took was against the founders this population replaced — so
    // every seed's accumulated total would read as this cycle's work.
    && !!saved.cycleBase;

  if (!usable) {
    // Reopen the cycle on the restored fundamental rather than leaving it on the
    // one createRun happened to build, and re-baseline against this population.
    startCycle(run, Math.random);
    return;
  }

  run.schedule = sched as Pairing[];
  run.cursor = Math.min(Math.max(saved.cursor ?? 0, 0), run.schedule.length);
  run.completed = Math.min(Math.max(saved.completed ?? 0, 0), run.schedule.length);
  run.cycleBase = saved.cycleBase!;
  // Part-learned memory for the fundamental still open. Without it the cycle
  // would close having moved the champion's parameters but with nothing to
  // remember them by, and the old situations would outlive the values.
  run.cycleStores = {};
  for (const [id, st] of Object.entries(saved.cycleStores ?? {})) {
    run.cycleStores[Number(id)] = deserializeStore(st);
  }
}

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
  const [tab, setTab] = useState<"board" | "fundamentals">("board");
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
    const saved = load();
    const run = createRun(DEFAULT_RUN_CONFIG, Math.random);
    if (saved) {
      run.population = saved.population.slice(0, DEFAULT_RUN_CONFIG.populationSize);
      run.gen = saved.gen || 1;
      run.history = saved.history || [];
      restoreCycle(run, saved);
    }
    runRef.current = run;
    setTrainingNeuralOverrides(neuralOverridesFor(run.population));
  }

  const run = runRef.current!;

  const republish = useCallback(() => {
    setTrainingNeuralOverrides(neuralOverridesFor(runRef.current!.population));
  }, []);

  useEffect(() => {
    soundEngine.setSilent(true);
    // Leaving the screen or closing the tab must not cost the cycle.
    const flush = () => { if (runRef.current) save(runRef.current); };
    window.addEventListener("beforeunload", flush);
    return () => {
      window.removeEventListener("beforeunload", flush);
      flush();
      soundEngine.setSilent(false);
      setTrainingNeuralOverrides(null);
      clearAllKeys();
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
        if (cycleComplete(r)) {
          // advanceFundamental writes the winner's parameters for the fundamental
          // that just closed into run.champion, then opens the next fundamental —
          // rolling the generation if that was the last one. The champion is read
          // after it returns, so what goes out is the assembly including this
          // fundamental, not the previous state of it.
          advanceFundamental(r, Math.random);
          promoteToChampion(deriveNeuralState(r.champion));
          // The parameters and the situations they were learned in go out
          // together: ordinary play needs both to switch fundamental mid-bout.
          publishChampionFundamentals(r.champion.params, r.championStates);
          setTrainingNeuralOverrides(neuralOverridesFor(r.population));
          save(r);
        }
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
        save(r);
      }
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafRef.current);
  }, [sparring]);

  const reset = () => {
    setRunning(false);
    const fresh = createRun(DEFAULT_RUN_CONFIG, Math.random);
    runRef.current = fresh;
    republish();
    save(fresh);
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
          save(runRef.current!);
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
  const sweepFrac = (run.fundIndex + cycleFrac) / SWEEP_LENGTH;

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
            Generation {run.gen} · fundamental {run.fundIndex + 1}/{SWEEP_LENGTH} · {run.completed}/{cycleTotal} bouts
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
            <span data-testid="text-sweep-count">{run.fundIndex + 1} / {SWEEP_LENGTH} fundamentals</span>
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
        </div>

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
                Last sent: <span className="text-white/60">{lastClosed.label}</span> from{" "}
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
