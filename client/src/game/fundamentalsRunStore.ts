/**
 * Persistence for the fundamentals training run, shared by the AI Training
 * screen and the background trainer so both read and write the same run.
 */
import {
  FUNDAMENTALS, normalizeSeed, type FundamentalSeed,
  deriveNeuralState,
} from "@/game/aiFundamentals";
import {
  type TrainingRun, type GenerationRecord, type Pairing, type CycleBase, type FundCycleRecord,
  DEFAULT_RUN_CONFIG, createRun, startCycle, expectedScheduleLength, pairingValid,
  advanceFundamental, neuralOverridesForRun,
} from "@/game/aiTraining";
import { serializeStore, deserializeStore, emptyStore } from "@/game/fundamentalStates";
import {
  normalizeLearner, LEAGUE_SIZE,
  type LearnerState, type GateTally, type GateDecision,
} from "@/game/fundamentalLearning";
import { publishChampionFundamentals } from "@/game/championStates";
import { setTrainingNeuralOverrides, promoteToChampion } from "@/components/NeuralNetworkView";

const LS_KEY = "handz_ai_training";

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
  /** Fundamental keys the sweep loops on; absent/empty = all. */
  selected?: string[];
  /** Learning layer: Adam/width state, frozen league, gate. */
  learner?: LearnerState;
  league?: Record<string, number>[];
  lastGood?: { params: Record<string, number>; states: Record<string, unknown> } | null;
  gate?: GateTally;
  leagueTally?: Record<number, { wins: number; bouts: number }>;
  lastGate?: (GateDecision & { gen: number }) | null;
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

export function saveFundamentalsRun(run: TrainingRun) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({
      population: run.population, gen: run.gen, history: run.history.slice(-25),
      fundIndex: run.fundIndex,
      schedule: run.schedule, cursor: run.cursor, completed: run.completed,
      cycleBase: run.cycleBase,
      champion: run.champion, cycleLog: run.cycleLog,
      selected: run.selected ?? [],
      learner: run.learner, league: run.league ?? [],
      lastGood: run.lastGood
        ? { params: run.lastGood.params, states: serializeStore(run.lastGood.states) }
        : null,
      gate: run.gate, leagueTally: run.leagueTally ?? {}, lastGate: run.lastGate ?? null,
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
  if (Number.isFinite(saved.fundIndex)) {
    run.fundIndex = Math.min(Math.max(saved.fundIndex as number, 0), FUNDAMENTALS.length - 1);
  }
  if (saved.champion) run.champion = normalizeSeed(saved.champion);
  // Before the cycle check below, so a reopened cycle lands on a selected one.
  if (Array.isArray(saved.selected)) {
    run.selected = saved.selected.filter(k => FUNDAMENTALS.some(f => f.key === k));
  }
  if (Array.isArray(saved.cycleLog)) run.cycleLog = saved.cycleLog;
  // The memory belongs with the champion, not with the cycle: it is the whole
  // sweep's worth of closed fundamentals and survives a reopened cycle.
  if (saved.championStates) run.championStates = deserializeStore(saved.championStates);

  // The learning layer, before the schedule check: the league and the gate
  // decide how many fixtures a cycle has. A save from before it existed has
  // none of these and simply starts learning from here.
  run.learner = normalizeLearner(saved.learner);
  const paramsOk = (p: unknown): p is Record<string, number> =>
    !!p && typeof p === "object" && Object.values(p as object).every(v => typeof v === "number" && Number.isFinite(v));
  run.league = Array.isArray(saved.league) ? saved.league.filter(paramsOk).slice(0, LEAGUE_SIZE) : [];
  run.lastGood = saved.lastGood && paramsOk(saved.lastGood.params)
    ? { params: saved.lastGood.params, states: deserializeStore(saved.lastGood.states ?? {}) }
    : null;
  const g = saved.gate;
  run.gate = g && [g.wins, g.losses, g.bouts].every(v => Number.isFinite(v) && v >= 0)
    ? { wins: g.wins, losses: g.losses, bouts: g.bouts } : { wins: 0, losses: 0, bouts: 0 };
  run.leagueTally = saved.leagueTally && typeof saved.leagueTally === "object" ? saved.leagueTally : {};
  run.lastGate = saved.lastGate ?? null;

  const sched = saved.schedule;
  // Length is checked, not just validity. A save written before the sweep
  // existed carries a whole 1000-bout generation in this field, and every
  // pairing in it is still a legal pairing — adopting it would run one
  // fundamental for thirteen cycles' worth of bouts.
  const expected = expectedScheduleLength(run);
  const usable = Array.isArray(sched)
    && sched.length === expected
    && sched.every(p => pairingValid(run, p))
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

/** The stored run, or a fresh one when there is none. */
export function loadFundamentalsRun(): TrainingRun {
  const saved = load();
  const run = createRun(DEFAULT_RUN_CONFIG, Math.random);
  if (saved) {
    run.population = saved.population.slice(0, DEFAULT_RUN_CONFIG.populationSize);
    run.gen = saved.gen || 1;
    run.history = saved.history || [];
    restoreCycle(run, saved);
  }
  return run;
}

/**
 * Close the fundamental whose cycle just finished: advanceFundamental writes
 * its winner into run.champion and opens the next one (rolling the generation
 * after the last). The champion is read after it returns, so what goes out
 * includes this fundamental. Parameters and situations ship together.
 */
export function closeFundamentalCycle(run: TrainingRun) {
  advanceFundamental(run, Math.random);
  promoteToChampion(deriveNeuralState(run.champion));
  publishChampionFundamentals(run.champion.params, run.championStates);
  setTrainingNeuralOverrides(neuralOverridesForRun(run));
  saveFundamentalsRun(run);
}
