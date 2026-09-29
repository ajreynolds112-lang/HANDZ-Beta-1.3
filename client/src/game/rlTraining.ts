/**
 * ===== RL POLICY TRAINER: THE BOUT LOOP =====
 *
 * Runs PPO for the RL tactical policy on the same unrendered CPU-vs-CPU bouts
 * the fundamentals sweep uses (headlessBout.ts), inside the same per-frame
 * time budget on the main thread.
 *
 * Each bout puts the learning policy in one corner — recording its decisions,
 * under a training-range roster id so the champion redirect leaves it alone —
 * and an opponent from the pool in the other: the current Champion AI, or a
 * frozen snapshot of the policy riding on the Champion's brain. The reward
 * observer diffs the learner's corner after every fixed step and closes one
 * reward interval per recorded decision. Whole bouts go into the rollout
 * buffer; once it holds K decisions the bouts pause and a PPO update runs, a
 * few samples per frame, until it is done.
 */
import type { AiBrainState, AiRlDecisionRecord, Archetype, GameState } from "./types";
import { initAiBrain, CHAMPION_AI_SOURCE_ID } from "./ai";
import { attachRlPolicy } from "./aiStringRunner";
import { soundEngine } from "./sound";
import { TRAINING_ROSTER_BASE } from "./aiFundamentals";
import { DEFAULT_RUN_CONFIG } from "./aiTraining";
import { startHeadlessBout, stepHeadless, type CornerSetup, type HeadlessBoutCore } from "./headlessBout";
import { getNeuralOverrides, setTrainingNeuralOverride } from "@/components/NeuralNetworkView";
import type { RlPolicy } from "./rlPolicy";
import {
  startPpoUpdate,
  stepPpoUpdate,
  ppoUpdateStats,
  type AdamState,
  type PpoUpdateJob,
  type RlTransition,
} from "./rlPpo";
import {
  accumulateRlReward,
  closeRlRewardInterval,
  emptyRlRewardTerms,
  addRlRewardTerms,
  sumRlRewardTerms,
  newRlRewardTracker,
  rlOutcomeReward,
  rlRewardSnapshot,
  type RlRewardSnapshot,
  type RlRewardTerms,
  type RlRewardTracker,
  type RlRewardWeights,
} from "./rlReward";
import {
  foldRlBout,
  finishRlUpdate,
  openRlRollout,
  rolloutReady,
  rlNextDraw,
  saveRlCheckpoint,
  type RlOpponentKind,
  type RlRun,
} from "./rlRun";

/**
 * The learner's roster id. Well clear of the fundamentals population's ids
 * (which count up from TRAINING_ROSTER_BASE), and inside the training range so
 * no deployed policy is attached and the champion redirect skips it.
 */
export const RL_LEARNER_ROSTER_ID = TRAINING_ROSTER_BASE + 800000;

/** Engine steps between deadline checks while a bout runs. */
const TICKS_PER_SLICE = 120;

/**
 * A brain for the learning policy. It boxes with the Champion's own neural
 * knobs, published under the learner's training id, so the only thing that
 * differs from the Champion is the policy picking its strings.
 */
export function buildLearnerBrain(
  policy: RlPolicy,
  archetype: Archetype,
  level: number,
  opts: { recording: boolean; cpuVsCpu: boolean },
): AiBrainState {
  try {
    const champ = getNeuralOverrides(CHAMPION_AI_SOURCE_ID ?? undefined).champion;
    setTrainingNeuralOverride(RL_LEARNER_ROSTER_ID, champ ?? null);
  } catch {
    /* no tuning to read: the learner falls back to the saved sets */
  }
  const brain = initAiBrain("champion", archetype, level, opts.cpuVsCpu, RL_LEARNER_ROSTER_ID);
  attachRlPolicy(brain, policy, { recording: opts.recording });
  return brain;
}

/** The current Champion AI, exactly as a champion-difficulty roster opponent gets it. */
function buildChampionBrain(archetype: Archetype, level: number): AiBrainState {
  return initAiBrain("champion", archetype, level, true, CHAMPION_AI_SOURCE_ID ?? undefined);
}

// ===== ONE BOUT =====

export interface RlBout extends HeadlessBoutCore {
  side: "player" | "enemy";
  opponent: RlOpponentKind;
  /** Seed-stream state to commit if (and only if) the bout is folded. */
  rngAfter: number;
  weights: RlRewardWeights;
  prev: RlRewardSnapshot;
  track: RlRewardTracker;
  /** The open decision interval's reward, per term. */
  interval: RlRewardTerms;
  /** The whole bout's reward, per term, including before the first decision. */
  totals: RlRewardTerms;
  open: AiRlDecisionRecord | null;
  transitions: RlTransition[];
  onTick: (state: GameState, dt: number) => void;
}

function learnerBrain(bout: RlBout): AiBrainState | null {
  return (bout.side === "player" ? bout.state.playerAiBrain : bout.state.aiBrain) ?? null;
}

/** Close the open interval, paying its reward (plus `extra`) to the open decision. */
function closeInterval(bout: RlBout, done: boolean): void {
  closeRlRewardInterval(bout.interval, bout.weights, bout.track);
  const reward = sumRlRewardTerms(bout.interval);
  addRlRewardTerms(bout.totals, bout.interval);
  bout.interval = emptyRlRewardTerms();
  const rec = bout.open;
  if (!rec) return;
  bout.transitions.push({
    obs: rec.obs,
    mask: rec.mask,
    stringIndex: rec.stringIndex,
    tempoIndex: rec.tempoIndex,
    utility: rec.utility,
    logProb: rec.logProb,
    value: rec.value,
    reward,
    done,
  });
  bout.open = null;
}

/**
 * Take the learner's newly recorded decisions. The one still pending (picked
 * but not yet run — it may yet be refused and popped) stays in the log until
 * it is settled.
 */
function drainDecisions(bout: RlBout): void {
  const rl = learnerBrain(bout)?.rl;
  if (!rl || rl.log.length === 0) return;
  const pendingRec = rl.pending?.record ?? null;
  let k = rl.log.length;
  if (pendingRec && rl.log[k - 1] === pendingRec) k--;
  if (k <= 0) return;
  const recs = rl.log.splice(0, k);
  for (const rec of recs) {
    closeInterval(bout, false);
    bout.open = rec;
  }
}

export function createRlBout(run: RlRun): RlBout {
  const r = rlNextDraw(run.rngState);
  // High bits only: an LCG's low bits cycle with short periods, which would
  // leave the learner in one corner for long runs of bouts.
  const side: "player" | "enemy" = (r >>> 30) & 1 ? "enemy" : "player";
  const u = ((r >>> 12) % 1000) / 1000;
  const useChampion = run.snapshots.length === 0 || u < run.mix.championShare;
  const snap = useChampion ? null : run.snapshots[Math.floor(r / 262144) % run.snapshots.length];
  const level = DEFAULT_RUN_CONFIG.level;
  const policy = run.policy;

  const learner: CornerSetup = {
    name: "RL Policy",
    rosterId: RL_LEARNER_ROSTER_ID,
    buildBrain: (arch, lv) => buildLearnerBrain(policy, arch, lv, { recording: true, cpuVsCpu: true }),
  };
  const opponent: CornerSetup = {
    name: snap ? `Snapshot u${snap.update}` : "Champion",
    rosterId: CHAMPION_AI_SOURCE_ID ?? undefined,
    buildBrain: (arch, lv) => {
      const b = buildChampionBrain(arch, lv);
      if (snap) attachRlPolicy(b, snap.policy, { recording: false });
      return b;
    },
  };
  const state = side === "player"
    ? startHeadlessBout(r, level, learner, opponent)
    : startHeadlessBout(r, level, opponent, learner);

  const bout: RlBout = {
    state,
    ticks: 0,
    done: false,
    winner: null,
    outcome: "cards",
    side,
    opponent: snap ? "snapshot" : "champion",
    rngAfter: r,
    weights: { ...run.reward },
    prev: rlRewardSnapshot(state, side),
    track: newRlRewardTracker(),
    interval: emptyRlRewardTerms(),
    totals: emptyRlRewardTerms(),
    open: null,
    transitions: [],
    onTick: () => {},
  };
  bout.onTick = (s, dt) => {
    const cur = rlRewardSnapshot(s, bout.side);
    accumulateRlReward(bout.interval, bout.prev, cur, dt, bout.weights, bout.track);
    bout.prev = cur;
    drainDecisions(bout);
  };
  return bout;
}

/** Settle a finished bout: terminal bonus, last interval, fold into the run. */
export function finishRlBout(run: RlRun, bout: RlBout): void {
  drainDecisions(bout);
  const learnerCorner = bout.side === "player" ? 0 : 1;
  const won = bout.winner === null ? null : bout.winner === learnerCorner;
  bout.interval.outcome += rlOutcomeReward(won, bout.weights);
  closeInterval(bout, true);
  foldRlBout(run, {
    won,
    opponent: bout.opponent,
    side: bout.side,
    outcome: bout.outcome,
    reward: sumRlRewardTerms(bout.totals),
    terms: bout.totals,
    decisions: bout.transitions.length,
  }, bout.transitions, bout.rngAfter);
}

// ===== THE FRAME LOOP =====

export interface RlRuntime {
  /** The bout being played. Never persisted: a stop or reload discards it. */
  bout: RlBout | null;
  job: PpoUpdateJob | null;
  /** Weights and optimiser state from before the running update. */
  preParams: Float32Array | null;
  preAdam: AdamState | null;
}

export function newRlRuntime(): RlRuntime {
  return { bout: null, job: null, preParams: null, preAdam: null };
}

/**
 * Spend up to `budgetMs` on training. Returns true when an update finished
 * during the call (the caller checkpoints then).
 */
export function runRlFrame(run: RlRun, rt: RlRuntime, budgetMs: number): boolean {
  soundEngine.setSilent(true);
  const deadline = performance.now() + budgetMs;
  let updated = false;
  while (performance.now() < deadline) {
    if (rt.job) {
      if (!stepPpoUpdate(rt.job, run.policy, run.adam, run.ppo, deadline)) break;
      finishRlUpdate(run, ppoUpdateStats(rt.job));
      rt.job = null;
      rt.preParams = null;
      rt.preAdam = null;
      updated = true;
      continue;
    }
    if (!rt.bout) {
      if (rolloutReady(run)) {
        rt.preParams = new Float32Array(run.policy.params);
        rt.preAdam = { m: new Float32Array(run.adam.m), v: new Float32Array(run.adam.v), t: run.adam.t };
        rt.job = startPpoUpdate(run.policy, run.buffer, run.ppo, (run.updates * 2654435761 + 97) >>> 0);
        continue;
      }
      if (run.buffer.length === 0) openRlRollout(run);
      rt.bout = createRlBout(run);
    }
    const bout = rt.bout;
    stepHeadless(bout, TICKS_PER_SLICE, bout.onTick);
    if (bout.done) {
      finishRlBout(run, bout);
      rt.bout = null;
    }
  }
  return updated;
}

/** Stop: the bout in progress is put back (never scored); an update resumes later. */
export function stopRl(rt: RlRuntime): void {
  rt.bout = null;
}

/**
 * The run as it should be stored. Mid-update, the weights and Adam state from
 * before the update go out with the untouched buffer, so a reload simply runs
 * the update again rather than resuming half-applied weights.
 */
export function stableRlRun(run: RlRun, rt: RlRuntime): RlRun {
  if (!rt.job || !rt.preParams || !rt.preAdam) return run;
  const policy = run.policy.clone();
  policy.params.set(rt.preParams);
  return { ...run, policy, adam: rt.preAdam };
}

export function saveRlRun(run: RlRun, rt: RlRuntime): Promise<void> {
  return saveRlCheckpoint(stableRlRun(run, rt));
}

/** The policy to deploy or fight: never one caught half-way through an update. */
export function stableRlPolicy(run: RlRun, rt: RlRuntime): RlPolicy {
  return stableRlRun(run, rt).policy.clone();
}
