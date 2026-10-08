/**
 * ===== RL TRAINING RUN STATE =====
 *
 * Everything the RL trainer carries between frames and across reloads: the
 * learning policy and its Adam state, the reward weights and opponent mix, the
 * frozen self-play snapshots, the rollout buffer and the running statistics —
 * plus the checkpoint format and its IndexedDB home (weights, optimiser state
 * and snapshots are far too large for localStorage).
 *
 * The bouts themselves live in rlTraining.ts. This module has no engine
 * imports so the check script can round-trip a checkpoint under Node.
 */
import { AI_STRINGS } from "./aiStrings";
import { RL_OBS_SIZE } from "./rlObservation";
import {
  createRlPolicy,
  rlPolicyFromJson,
  rlPolicyToJson,
  bytesToBase64,
  base64ToBytes,
  RL_UTILITY_COUNT,
  type RlPolicy,
  type RlPolicyJson,
} from "./rlPolicy";
import {
  DEFAULT_PPO_CONFIG,
  sanitizePpoConfig,
  createAdam,
  adamToJson,
  adamFromJson,
  f32ToB64,
  b64ToF32,
  type AdamJson,
  type AdamState,
  type PpoConfig,
  type PpoUpdateStats,
  type RlTransition,
} from "./rlPpo";
import {
  DEFAULT_RL_REWARD_WEIGHTS,
  sanitizeRlRewardWeights,
  emptyRlRewardTerms,
  RL_REWARD_TERMS,
  type RlRewardTerms,
  type RlRewardWeights,
} from "./rlReward";

// ===== CONFIG =====

export interface RlOpponentMix {
  /** Share of bouts against the current Champion AI; the rest face snapshots. */
  championShare: number;
  /** A frozen snapshot of the policy joins the pool every this many updates. */
  snapshotEvery: number;
  /** Oldest snapshots drop off past this many. */
  maxSnapshots: number;
}

export const DEFAULT_RL_OPPONENT_MIX: RlOpponentMix = {
  championShare: 0.7,
  snapshotEvery: 5,
  maxSnapshots: 8,
};

export function sanitizeRlOpponentMix(m: unknown): RlOpponentMix {
  const src = (m && typeof m === "object" ? m : {}) as Record<string, unknown>;
  const num = (k: keyof RlOpponentMix) => {
    const v = src[k];
    return typeof v === "number" && Number.isFinite(v) ? v : DEFAULT_RL_OPPONENT_MIX[k];
  };
  return {
    championShare: Math.min(1, Math.max(0, num("championShare"))),
    snapshotEvery: Math.max(1, Math.round(num("snapshotEvery"))),
    maxSnapshots: Math.max(1, Math.round(num("maxSnapshots"))),
  };
}

/** Bouts the win rate and reward averages are taken over. */
export const RL_RECENT_WINDOW = 100;
/** Bout records kept (a little over the window so the panel can scroll back). */
const RL_RECENT_CAP = 200;
/** Update records kept for the loss charts. */
const RL_HISTORY_CAP = 300;

// ===== STATE =====

export type RlOpponentKind = "champion" | "snapshot";

export interface RlBoutRecord {
  /** From the learner's side; null for a draw. */
  won: boolean | null;
  opponent: RlOpponentKind;
  side: "player" | "enemy";
  outcome: string;
  reward: number;
  terms: RlRewardTerms;
  decisions: number;
}

export interface RlUpdateRecord {
  update: number;
  steps: number;
  bouts: number;
  policyLoss: number;
  valueLoss: number;
  entropy: number;
  approxKl: number;
  clipFrac: number;
  avgReward: number;
  winRate: number;
}

export interface RlPickCounts {
  strings: Record<number, number>;
  tempo: number[];
  utility: number[];
  n: number;
}

export interface RlSnapshot {
  update: number;
  policy: RlPolicy;
}

export interface RlRun {
  policy: RlPolicy;
  adam: AdamState;
  ppo: PpoConfig;
  /** Weights in force for the rollout being collected. */
  reward: RlRewardWeights;
  /** Weights as edited; adopted when the next rollout opens. */
  pendingReward: RlRewardWeights;
  mix: RlOpponentMix;
  snapshots: RlSnapshot[];
  /** Decisions collected into rollouts (and so trained on). */
  totalSteps: number;
  boutsPlayed: number;
  updates: number;
  /** RL bout seed stream. Only advances when a bout is folded. */
  rngState: number;
  buffer: RlTransition[];
  bufferBouts: number;
  recent: RlBoutRecord[];
  history: RlUpdateRecord[];
  /** Picks in the rollout being collected. */
  picks: RlPickCounts;
  /** Picks in the last completed rollout. */
  lastPicks: RlPickCounts | null;
  createdAt: string;
}

export function emptyPicks(nTempo: number): RlPickCounts {
  return { strings: {}, tempo: new Array(nTempo).fill(0), utility: new Array(RL_UTILITY_COUNT).fill(0), n: 0 };
}

export function createRlRun(seed: number, keep?: { reward?: RlRewardWeights; mix?: RlOpponentMix; ppo?: PpoConfig }): RlRun {
  const policy = createRlPolicy({
    obsSize: RL_OBS_SIZE,
    stringIds: AI_STRINGS.map((d) => d.id),
    seed: (seed >>> 0) || 1,
    meta: { note: "RL trainer" },
  });
  const reward = sanitizeRlRewardWeights(keep?.reward ?? DEFAULT_RL_REWARD_WEIGHTS);
  return {
    policy,
    adam: createAdam(policy.params.length),
    ppo: sanitizePpoConfig(keep?.ppo ?? DEFAULT_PPO_CONFIG),
    reward: { ...reward },
    pendingReward: { ...reward },
    mix: sanitizeRlOpponentMix(keep?.mix ?? DEFAULT_RL_OPPONENT_MIX),
    snapshots: [],
    totalSteps: 0,
    boutsPlayed: 0,
    updates: 0,
    rngState: ((seed >>> 0) % 0x7fffffff) || 1,
    buffer: [],
    bufferBouts: 0,
    recent: [],
    history: [],
    picks: emptyPicks(policy.shape.nTempo),
    lastPicks: null,
    createdAt: new Date().toISOString(),
  };
}

/**
 * A run that picks up from a deployed policy, for a browser with no training
 * run of its own (the published site, a fresh browser). Without it the trainer
 * there would open on random weights and look like the deployed work was lost.
 * Null when the policy doesn't fit this build's trainer (observation, strings
 * or tempo layout changed), so the caller falls back to a fresh run.
 */
export function createRlRunFromPolicy(
  deployed: RlPolicy,
  seed: number,
  keep?: { reward?: RlRewardWeights; mix?: RlOpponentMix; ppo?: PpoConfig },
): RlRun | null {
  const run = createRlRun(seed, keep);
  const fresh = run.policy;
  const sameList = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((v, i) => v === b[i]);
  if (deployed.shape.obsSize !== RL_OBS_SIZE) return null;
  if (!sameList(deployed.stringIds, fresh.stringIds)) return null;
  if (!sameList(deployed.tempoBins, fresh.tempoBins)) return null;
  if (deployed.params.length !== fresh.params.length) return null;
  const policy = deployed.clone();
  const meta = deployed.meta ?? {};
  const noted = /after (\d+) updates/.exec(meta.note ?? "");
  run.policy = policy;
  run.adam = createAdam(policy.params.length);
  run.totalSteps = Math.max(0, Math.floor(meta.trainedSteps ?? 0));
  run.updates = Math.max(0, Math.floor(meta.updates ?? (noted ? Number(noted[1]) : 0)));
  run.picks = emptyPicks(policy.shape.nTempo);
  return run;
}

/** The next draw of the RL seed stream after `state`, without committing it. */
export const rlNextDraw = (state: number) => (state * 1103515245 + 12345) & 0x7fffffff;

/** Fold one finished bout into the run. */
export function foldRlBout(run: RlRun, rec: RlBoutRecord, transitions: RlTransition[], rngAfter: number): void {
  run.rngState = rngAfter;
  run.boutsPlayed++;
  run.recent.push(rec);
  if (run.recent.length > RL_RECENT_CAP) run.recent.splice(0, run.recent.length - RL_RECENT_CAP);
  if (transitions.length === 0) return;
  for (const t of transitions) {
    run.buffer.push(t);
    const id = run.policy.stringIds[t.stringIndex];
    run.picks.strings[id] = (run.picks.strings[id] ?? 0) + 1;
    if (t.tempoIndex < run.picks.tempo.length) run.picks.tempo[t.tempoIndex]++;
    if (t.utility < run.picks.utility.length) run.picks.utility[t.utility]++;
    run.picks.n++;
  }
  run.bufferBouts++;
  run.totalSteps += transitions.length;
}

/** Open a rollout: the edited reward weights come into force. */
export function openRlRollout(run: RlRun): void {
  run.reward = { ...run.pendingReward };
}

export function rolloutReady(run: RlRun): boolean {
  return run.buffer.length >= run.ppo.rolloutSize;
}

/** Book-keeping once an update has been applied to the policy's weights. */
export function finishRlUpdate(run: RlRun, stats: PpoUpdateStats): void {
  run.updates++;
  const sum = rlRecentSummary(run);
  run.history.push({
    update: run.updates,
    steps: run.totalSteps,
    bouts: run.boutsPlayed,
    policyLoss: stats.policyLoss,
    valueLoss: stats.valueLoss,
    entropy: stats.entropy,
    approxKl: stats.approxKl,
    clipFrac: stats.clipFrac,
    avgReward: sum.avgReward,
    winRate: sum.winRate,
  });
  if (run.history.length > RL_HISTORY_CAP) run.history.splice(0, run.history.length - RL_HISTORY_CAP);
  run.policy.meta.trainedSteps = run.totalSteps;
  if (run.updates % run.mix.snapshotEvery === 0) {
    const snap = run.policy.clone();
    snap.meta = { ...snap.meta, note: `snapshot @ update ${run.updates}` };
    run.snapshots.push({ update: run.updates, policy: snap });
    if (run.snapshots.length > run.mix.maxSnapshots) run.snapshots.splice(0, run.snapshots.length - run.mix.maxSnapshots);
  }
  run.buffer = [];
  run.bufferBouts = 0;
  run.lastPicks = run.picks;
  run.picks = emptyPicks(run.policy.shape.nTempo);
}

export interface RlRecentSummary {
  bouts: number;
  winRate: number;
  wins: number;
  losses: number;
  draws: number;
  avgReward: number;
  avgTerms: RlRewardTerms;
  avgDecisions: number;
  vsChampion: { bouts: number; winRate: number };
  vsSnapshot: { bouts: number; winRate: number };
}

export function rlRecentSummary(run: RlRun, window = RL_RECENT_WINDOW): RlRecentSummary {
  const rows = run.recent.slice(-window);
  const avgTerms = emptyRlRewardTerms();
  let wins = 0, losses = 0, draws = 0, reward = 0, dec = 0;
  const vs = { champion: { b: 0, w: 0 }, snapshot: { b: 0, w: 0 } };
  for (const r of rows) {
    if (r.won === true) wins++;
    else if (r.won === false) losses++;
    else draws++;
    reward += r.reward;
    dec += r.decisions;
    for (const k of RL_REWARD_TERMS) avgTerms[k] += r.terms[k] ?? 0;
    vs[r.opponent].b++;
    if (r.won === true) vs[r.opponent].w++;
  }
  const n = rows.length;
  if (n > 0) for (const k of RL_REWARD_TERMS) avgTerms[k] /= n;
  return {
    bouts: n,
    winRate: n > 0 ? wins / n : 0,
    wins, losses, draws,
    avgReward: n > 0 ? reward / n : 0,
    avgTerms,
    avgDecisions: n > 0 ? dec / n : 0,
    vsChampion: { bouts: vs.champion.b, winRate: vs.champion.b ? vs.champion.w / vs.champion.b : 0 },
    vsSnapshot: { bouts: vs.snapshot.b, winRate: vs.snapshot.b ? vs.snapshot.w / vs.snapshot.b : 0 },
  };
}

// ===== CHECKPOINT =====

export const RL_CHECKPOINT_KIND = "handz-rl-checkpoint";
export const RL_CHECKPOINT_VERSION = 1;

interface TransitionJson {
  o: string; m: string;
  s: number; t: number; u: number;
  lp: number; v: number; r: number; d: boolean;
}

export interface RlCheckpoint {
  kind: typeof RL_CHECKPOINT_KIND;
  version: number;
  savedAt: string;
  createdAt: string;
  policy: RlPolicyJson;
  adam: AdamJson;
  ppo: PpoConfig;
  reward: RlRewardWeights;
  pendingReward: RlRewardWeights;
  mix: RlOpponentMix;
  snapshots: { update: number; policy: RlPolicyJson }[];
  totalSteps: number;
  boutsPlayed: number;
  updates: number;
  rngState: number;
  buffer: TransitionJson[];
  bufferBouts: number;
  recent: RlBoutRecord[];
  history: RlUpdateRecord[];
  picks: RlPickCounts;
  lastPicks: RlPickCounts | null;
}

export function serializeRlRun(run: RlRun): RlCheckpoint {
  return {
    kind: RL_CHECKPOINT_KIND,
    version: RL_CHECKPOINT_VERSION,
    savedAt: new Date().toISOString(),
    createdAt: run.createdAt,
    policy: rlPolicyToJson(run.policy),
    adam: adamToJson(run.adam),
    ppo: { ...run.ppo },
    reward: { ...run.reward },
    pendingReward: { ...run.pendingReward },
    mix: { ...run.mix },
    snapshots: run.snapshots.map((s) => ({ update: s.update, policy: rlPolicyToJson(s.policy) })),
    totalSteps: run.totalSteps,
    boutsPlayed: run.boutsPlayed,
    updates: run.updates,
    rngState: run.rngState,
    buffer: run.buffer.map((t) => ({
      o: f32ToB64(t.obs), m: bytesToBase64(t.mask),
      s: t.stringIndex, t: t.tempoIndex, u: t.utility,
      lp: t.logProb, v: t.value, r: t.reward, d: t.done,
    })),
    bufferBouts: run.bufferBouts,
    recent: run.recent.map((r) => ({ ...r, terms: { ...r.terms } })),
    history: run.history.map((h) => ({ ...h })),
    picks: clonePicks(run.picks),
    lastPicks: run.lastPicks ? clonePicks(run.lastPicks) : null,
  };
}

function clonePicks(p: RlPickCounts): RlPickCounts {
  return { strings: { ...p.strings }, tempo: p.tempo.slice(), utility: p.utility.slice(), n: p.n };
}

function readPicks(p: unknown, nTempo: number): RlPickCounts {
  const d = p as Partial<RlPickCounts> | null;
  const out = emptyPicks(nTempo);
  if (!d || typeof d !== "object") return out;
  if (d.strings && typeof d.strings === "object") {
    for (const [k, v] of Object.entries(d.strings)) if (typeof v === "number") out.strings[Number(k)] = v;
  }
  if (Array.isArray(d.tempo)) d.tempo.forEach((v, i) => { if (i < nTempo && typeof v === "number") out.tempo[i] = v; });
  if (Array.isArray(d.utility)) d.utility.forEach((v, i) => { if (i < RL_UTILITY_COUNT && typeof v === "number") out.utility[i] = v; });
  out.n = typeof d.n === "number" ? d.n : 0;
  return out;
}

const num = (v: unknown, dflt = 0) => (typeof v === "number" && Number.isFinite(v) ? v : dflt);

/** Rebuild a run from a checkpoint. Throws with a readable reason when it can't. */
export function deserializeRlRun(data: unknown): RlRun {
  if (!data || typeof data !== "object") throw new Error("Checkpoint must be an object.");
  const d = data as Partial<RlCheckpoint>;
  if (d.kind !== RL_CHECKPOINT_KIND) throw new Error("Not an RL training checkpoint.");
  if (typeof d.version !== "number" || d.version > RL_CHECKPOINT_VERSION) {
    throw new Error(`Checkpoint version ${String(d.version)} is not readable by this build.`);
  }
  const policy = rlPolicyFromJson(d.policy);
  if (policy.shape.obsSize !== RL_OBS_SIZE) {
    throw new Error(`Checkpoint policy reads ${policy.shape.obsSize} observation values; this build produces ${RL_OBS_SIZE}.`);
  }
  const n = policy.params.length;
  const adam = adamFromJson(d.adam as AdamJson, n);
  const obsSize = policy.shape.obsSize;
  const buffer: RlTransition[] = [];
  for (const t of Array.isArray(d.buffer) ? d.buffer : []) {
    const obs = b64ToF32(t.o);
    const mask = base64ToBytes(t.m);
    if (obs.length !== obsSize || mask.length !== policy.shape.nStrings) continue;
    buffer.push({
      obs, mask,
      stringIndex: t.s, tempoIndex: t.t, utility: t.u,
      logProb: t.lp, value: t.v, reward: t.r, done: !!t.d,
    });
  }
  // A buffer that lost entries can't be trusted to end on an episode boundary.
  const bufferOk = buffer.length === (Array.isArray(d.buffer) ? d.buffer.length : 0);
  const snapshots: RlSnapshot[] = [];
  for (const s of Array.isArray(d.snapshots) ? d.snapshots : []) {
    try {
      const p = rlPolicyFromJson(s.policy);
      if (p.shape.obsSize === obsSize) snapshots.push({ update: num(s.update), policy: p });
    } catch { /* a broken snapshot just leaves the pool */ }
  }
  const nTempo = policy.shape.nTempo;
  return {
    policy,
    adam,
    ppo: sanitizePpoConfig(d.ppo),
    reward: sanitizeRlRewardWeights(d.reward),
    pendingReward: sanitizeRlRewardWeights(d.pendingReward ?? d.reward),
    mix: sanitizeRlOpponentMix(d.mix),
    snapshots,
    totalSteps: num(d.totalSteps),
    boutsPlayed: num(d.boutsPlayed),
    updates: num(d.updates),
    rngState: num(d.rngState, 1) || 1,
    buffer: bufferOk ? buffer : [],
    bufferBouts: bufferOk ? num(d.bufferBouts) : 0,
    recent: Array.isArray(d.recent)
      ? d.recent.map((r) => ({ ...r, terms: { ...emptyRlRewardTerms(), ...(r.terms || {}) } }))
      : [],
    history: Array.isArray(d.history) ? d.history.slice() : [],
    picks: readPicks(d.picks, nTempo),
    lastPicks: d.lastPicks ? readPicks(d.lastPicks, nTempo) : null,
    createdAt: typeof d.createdAt === "string" ? d.createdAt : new Date().toISOString(),
  };
}

// ===== INDEXEDDB =====

const DB_NAME = "handz_rl_training";
const DB_STORE = "checkpoints";
const DB_KEY = "current";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") { reject(new Error("IndexedDB is not available.")); return; }
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(DB_STORE)) req.result.createObjectStore(DB_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB open failed."));
  });
}

// Writes are chained so a slow earlier save can never land after a later one.
let writeChain: Promise<void> = Promise.resolve();

/**
 * Queue a checkpoint write. The run is serialised synchronously, so what is
 * stored is the run as it stands at the call, whatever happens after.
 */
export function saveRlCheckpoint(run: RlRun): Promise<void> {
  let cp: RlCheckpoint;
  try {
    cp = serializeRlRun(run);
  } catch (err) {
    console.warn("[rl] checkpoint serialise failed:", err);
    return writeChain;
  }
  writeChain = writeChain.then(async () => {
    try {
      const db = await openDb();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(DB_STORE, "readwrite");
        tx.objectStore(DB_STORE).put(cp, DB_KEY);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error("checkpoint write failed"));
        tx.onabort = () => reject(tx.error ?? new Error("checkpoint write aborted"));
      });
      db.close();
    } catch (err) {
      console.warn("[rl] checkpoint save failed:", err);
    }
  });
  return writeChain;
}

/** The stored checkpoint exactly as saved (for the parameter file). Throws on a read error. */
export async function loadRlCheckpointRaw(): Promise<unknown> {
  await writeChain;
  const db = await openDb();
  try {
    return await new Promise<unknown>((resolve, reject) => {
      const tx = db.transaction(DB_STORE, "readonly");
      const req = tx.objectStore(DB_STORE).get(DB_KEY);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => reject(req.error ?? new Error("checkpoint read failed"));
    });
  } finally {
    db.close();
  }
}

/** The stored run, or null when there is none (or it can't be read). */
export async function loadRlCheckpoint(): Promise<RlRun | null> {
  try {
    const raw = await loadRlCheckpointRaw();
    if (!raw) return null;
    return deserializeRlRun(raw);
  } catch (err) {
    console.warn("[rl] checkpoint load failed:", err);
    return null;
  }
}
