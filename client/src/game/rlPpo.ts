/**
 * ===== PPO FOR THE RL TACTICAL POLICY =====
 *
 * Proximal Policy Optimisation, written out by hand for the policy in
 * rlPolicy.ts: GAE advantages, the clipped surrogate objective, a value loss
 * and an entropy bonus, minimised with Adam over shuffled minibatches.
 *
 * The update is a resumable job. The AI Training screen runs everything on
 * the main thread inside a per-frame time budget, so a job processes as many
 * samples as the budget allows and picks up where it left off next frame.
 *
 * Plain Float32Array / Float64Array math, no engine imports, so the check
 * script can exercise it under Node.
 */
import {
  RlPolicy,
  maskedLogSoftmax,
  seededUniform,
  bytesToBase64,
  base64ToBytes,
} from "./rlPolicy";

// ===== CONFIG =====

export interface PpoConfig {
  gamma: number;
  lambda: number;
  clip: number;
  learningRate: number;
  epochs: number;
  minibatch: number;
  valueCoef: number;
  entropyCoef: number;
  maxGradNorm: number;
  /** Decisions collected before an update runs (K). */
  rolloutSize: number;
}

export const DEFAULT_PPO_CONFIG: PpoConfig = {
  gamma: 0.99,
  lambda: 0.95,
  clip: 0.2,
  learningRate: 3e-4,
  epochs: 4,
  minibatch: 64,
  valueCoef: 0.5,
  entropyCoef: 0.01,
  maxGradNorm: 0.5,
  rolloutSize: 512,
};

export function sanitizePpoConfig(c: unknown): PpoConfig {
  const src = (c && typeof c === "object" ? c : {}) as Record<string, unknown>;
  const out = { ...DEFAULT_PPO_CONFIG };
  for (const k of Object.keys(out) as (keyof PpoConfig)[]) {
    const v = src[k];
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) out[k] = v;
  }
  out.epochs = Math.max(1, Math.round(out.epochs));
  out.minibatch = Math.max(1, Math.round(out.minibatch));
  out.rolloutSize = Math.max(1, Math.round(out.rolloutSize));
  return out;
}

// ===== TRANSITIONS & GAE =====

/** One recorded decision with the reward its interval earned. */
export interface RlTransition {
  obs: Float32Array;
  mask: Uint8Array;
  stringIndex: number;
  tempoIndex: number;
  utility: number;
  /** Behaviour policy's joint log-probability when the action was taken. */
  logProb: number;
  /** Behaviour policy's value estimate at the time. */
  value: number;
  reward: number;
  /** The episode ended after this decision. */
  done: boolean;
}

/**
 * Generalised advantage estimation. `dones[t]` marks that the episode ended
 * after step t, so nothing past it is bootstrapped; `lastValue` bootstraps the
 * final step when it is not terminal.
 */
export function computeGae(
  rewards: ArrayLike<number>,
  values: ArrayLike<number>,
  dones: ArrayLike<boolean | number>,
  lastValue: number,
  gamma: number,
  lambda: number,
): { advantages: Float64Array; returns: Float64Array } {
  const n = rewards.length;
  const advantages = new Float64Array(n);
  const returns = new Float64Array(n);
  let gae = 0;
  for (let t = n - 1; t >= 0; t--) {
    const nonTerminal = dones[t] ? 0 : 1;
    const nextValue = t === n - 1 ? lastValue : values[t + 1];
    const delta = rewards[t] + gamma * nextValue * nonTerminal - values[t];
    gae = delta + gamma * lambda * nonTerminal * gae;
    advantages[t] = gae;
    returns[t] = gae + values[t];
  }
  return { advantages, returns };
}

// ===== ADAM =====

export interface AdamState {
  m: Float32Array;
  v: Float32Array;
  /** Steps taken, for bias correction. */
  t: number;
}

export function createAdam(n: number): AdamState {
  return { m: new Float32Array(n), v: new Float32Array(n), t: 0 };
}

export function adamStep(
  params: Float32Array,
  grad: ArrayLike<number>,
  st: AdamState,
  lr: number,
  beta1 = 0.9,
  beta2 = 0.999,
  eps = 1e-8,
): void {
  st.t++;
  const c1 = 1 - Math.pow(beta1, st.t);
  const c2 = 1 - Math.pow(beta2, st.t);
  for (let i = 0; i < params.length; i++) {
    const g = grad[i];
    const m = (st.m[i] = beta1 * st.m[i] + (1 - beta1) * g);
    const v = (st.v[i] = beta2 * st.v[i] + (1 - beta2) * g * g);
    params[i] -= (lr * (m / c1)) / (Math.sqrt(v / c2) + eps);
  }
}

export interface AdamJson { t: number; m: string; v: string; }

export function f32ToB64(f: Float32Array): string {
  const bytes = new Uint8Array(f.length * 4);
  const dv = new DataView(bytes.buffer);
  for (let i = 0; i < f.length; i++) dv.setFloat32(i * 4, f[i], true);
  return bytesToBase64(bytes);
}

export function b64ToF32(s: string, expected?: number): Float32Array {
  const bytes = base64ToBytes(s);
  const n = bytes.length >> 2;
  if (expected !== undefined && n !== expected) throw new Error(`decoded ${n} floats, expected ${expected}`);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = dv.getFloat32(i * 4, true);
  return out;
}

export function adamToJson(st: AdamState): AdamJson {
  return { t: st.t, m: f32ToB64(st.m), v: f32ToB64(st.v) };
}

export function adamFromJson(j: AdamJson, n: number): AdamState {
  if (!j || typeof j.t !== "number" || typeof j.m !== "string" || typeof j.v !== "string") {
    throw new Error("Adam state is malformed.");
  }
  return { t: j.t, m: b64ToF32(j.m, n), v: b64ToF32(j.v, n) };
}

// ===== GRADIENT OF ONE SAMPLE =====

export interface PpoSampleStats {
  policyLoss: number;
  valueLoss: number;
  entropy: number;
  /** logπ_old − logπ_new, the usual approximate KL. */
  approxKl: number;
  clipped: boolean;
}

function headGrad(
  logits: Float32Array,
  mask: ArrayLike<number> | null,
  action: number,
  gLogp: number,
  entCoef: number,
  dz: Float64Array,
): { logp: number; entropy: number } {
  const lp = maskedLogSoftmax(logits, mask);
  dz.fill(0);
  if (!lp) return { logp: -Infinity, entropy: 0 };
  let h = 0;
  for (let j = 0; j < lp.length; j++) if (lp[j] !== -Infinity) h -= Math.exp(lp[j]) * lp[j];
  for (let j = 0; j < lp.length; j++) {
    if (lp[j] === -Infinity) continue;
    const p = Math.exp(lp[j]);
    // d(logp_a)/dz_j = δ_aj − p_j;  d(−H)/dz_j = p_j (logp_j + H)
    dz[j] = gLogp * ((j === action ? 1 : 0) - p) + entCoef * p * (lp[j] + h);
  }
  return { logp: lp[action] ?? -Infinity, entropy: h };
}

/**
 * Add one sample's gradient of the PPO loss (scaled by `scale`) into `grad`.
 * Loss = −min(r·A, clip(r)·A) + c_v · ½(V − R)² − c_e · H.
 */
export function accumulatePpoSampleGrad(
  policy: RlPolicy,
  tr: RlTransition,
  advantage: number,
  ret: number,
  cfg: PpoConfig,
  grad: Float64Array,
  scale: number,
  scratch?: PpoScratch,
): PpoSampleStats {
  const s = policy.shape;
  const L = policy.layout;
  const p = policy.params;
  const sc = scratch ?? createPpoScratch(policy);
  const fwd = policy.forward(tr.obs);

  // First pass: joint log-prob under the current weights, for the ratio.
  const ls = maskedLogSoftmax(fwd.stringLogits, tr.mask);
  const lt = maskedLogSoftmax(fwd.tempoLogits);
  const lu = maskedLogSoftmax(fwd.utilityLogits);
  const logp = (ls ? ls[tr.stringIndex] : -Infinity) + (lt ? lt[tr.tempoIndex] : -Infinity) + (lu ? lu[tr.utility] : -Infinity);
  if (!Number.isFinite(logp)) {
    return { policyLoss: 0, valueLoss: 0, entropy: 0, approxKl: 0, clipped: false };
  }
  const ratio = Math.exp(Math.max(-20, Math.min(20, logp - tr.logProb)));
  const surr1 = ratio * advantage;
  const clippedRatio = Math.min(1 + cfg.clip, Math.max(1 - cfg.clip, ratio));
  const surr2 = clippedRatio * advantage;
  const useClipped = surr2 < surr1;
  const policyLoss = -Math.min(surr1, surr2);
  // Gradient flows through the unclipped branch only when it is the minimum.
  const gLogp = useClipped ? 0 : -advantage * ratio;

  const e1 = headGrad(fwd.stringLogits, tr.mask, tr.stringIndex, gLogp, cfg.entropyCoef, sc.dzS);
  const e2 = headGrad(fwd.tempoLogits, null, tr.tempoIndex, gLogp, cfg.entropyCoef, sc.dzT);
  const e3 = headGrad(fwd.utilityLogits, null, tr.utility, gLogp, cfg.entropyCoef, sc.dzU);
  const entropy = e1.entropy + e2.entropy + e3.entropy;

  const vErr = fwd.value - ret;
  const valueLoss = 0.5 * vErr * vErr;
  const dv = cfg.valueCoef * vErr;

  // Heads -> h2.
  const h2 = fwd.h2;
  const h1 = fwd.h1;
  const dh2 = sc.dh2;
  dh2.fill(0);
  const head = (wOff: number, bOff: number, dz: Float64Array, n: number) => {
    for (let j = 0; j < n; j++) {
      const g = dz[j];
      if (g === 0) continue;
      const row = wOff + j * s.hidden2;
      grad[bOff + j] += scale * g;
      for (let i = 0; i < s.hidden2; i++) {
        grad[row + i] += scale * g * h2[i];
        dh2[i] += g * p[row + i];
      }
    }
  };
  head(L.ws, L.bs, sc.dzS, s.nStrings);
  head(L.wt, L.bt, sc.dzT, s.nTempo);
  head(L.wu, L.bu, sc.dzU, s.nUtility);
  grad[L.bv] += scale * dv;
  for (let i = 0; i < s.hidden2; i++) {
    grad[L.wv + i] += scale * dv * h2[i];
    dh2[i] += dv * p[L.wv + i];
  }

  // h2 -> h1 (tanh).
  const dh1 = sc.dh1;
  dh1.fill(0);
  for (let o = 0; o < s.hidden2; o++) {
    const g = dh2[o] * (1 - h2[o] * h2[o]);
    if (g === 0) continue;
    grad[L.b2 + o] += scale * g;
    const row = L.w2 + o * s.hidden1;
    for (let i = 0; i < s.hidden1; i++) {
      grad[row + i] += scale * g * h1[i];
      dh1[i] += g * p[row + i];
    }
  }

  // h1 -> obs (tanh).
  const x = tr.obs;
  for (let o = 0; o < s.hidden1; o++) {
    const g = dh1[o] * (1 - h1[o] * h1[o]);
    if (g === 0) continue;
    grad[L.b1 + o] += scale * g;
    const row = L.w1 + o * s.obsSize;
    for (let i = 0; i < s.obsSize; i++) {
      const xi = x[i];
      if (xi) grad[row + i] += scale * g * xi;
    }
  }

  return { policyLoss, valueLoss, entropy, approxKl: tr.logProb - logp, clipped: useClipped || clippedRatio !== ratio };
}

export interface PpoScratch {
  dzS: Float64Array;
  dzT: Float64Array;
  dzU: Float64Array;
  dh1: Float64Array;
  dh2: Float64Array;
}

export function createPpoScratch(policy: RlPolicy): PpoScratch {
  const s = policy.shape;
  return {
    dzS: new Float64Array(s.nStrings),
    dzT: new Float64Array(s.nTempo),
    dzU: new Float64Array(s.nUtility),
    dh1: new Float64Array(s.hidden1),
    dh2: new Float64Array(s.hidden2),
  };
}

/** Rescale `g` in place so its L2 norm is at most `maxNorm`. Returns the pre-clip norm. */
export function clipGradNorm(g: Float64Array, maxNorm: number): number {
  let sq = 0;
  for (let i = 0; i < g.length; i++) sq += g[i] * g[i];
  const norm = Math.sqrt(sq);
  if (maxNorm > 0 && norm > maxNorm) {
    const k = maxNorm / (norm + 1e-12);
    for (let i = 0; i < g.length; i++) g[i] *= k;
  }
  return norm;
}

// ===== THE UPDATE JOB =====

export interface PpoUpdateStats {
  policyLoss: number;
  valueLoss: number;
  entropy: number;
  approxKl: number;
  clipFrac: number;
  gradNorm: number;
  samples: number;
  minibatches: number;
}

export interface PpoUpdateJob {
  data: RlTransition[];
  adv: Float64Array;
  ret: Float64Array;
  perm: Uint32Array;
  epoch: number;
  /** Position in `perm` of the next sample. */
  cursor: number;
  /** Samples already folded into the open minibatch. */
  inBatch: number;
  batchSize: number;
  grad: Float64Array;
  rand: () => number;
  scratch: PpoScratch;
  acc: { policyLoss: number; valueLoss: number; entropy: number; approxKl: number; clipped: number; n: number; gradNorm: number; batches: number };
  done: boolean;
}

function shuffleInPlace(a: Uint32Array, rand: () => number): void {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
}

/**
 * Prepare an update over `data`. Advantages come from GAE over the buffer in
 * order (episodes are separated by their `done` flags) and are normalised
 * across the whole rollout. `seed` makes the minibatch shuffle replayable.
 */
export function startPpoUpdate(policy: RlPolicy, data: RlTransition[], cfg: PpoConfig, seed: number): PpoUpdateJob {
  const rewards = data.map((d) => d.reward);
  const values = data.map((d) => d.value);
  const dones = data.map((d) => d.done);
  const { advantages, returns } = computeGae(rewards, values, dones, 0, cfg.gamma, cfg.lambda);
  if (advantages.length > 1) {
    let mean = 0;
    for (let i = 0; i < advantages.length; i++) mean += advantages[i];
    mean /= advantages.length;
    let v = 0;
    for (let i = 0; i < advantages.length; i++) v += (advantages[i] - mean) ** 2;
    const sd = Math.sqrt(v / advantages.length) + 1e-8;
    for (let i = 0; i < advantages.length; i++) advantages[i] = (advantages[i] - mean) / sd;
  }
  const perm = new Uint32Array(data.length);
  for (let i = 0; i < perm.length; i++) perm[i] = i;
  const rand = seededUniform(seed);
  shuffleInPlace(perm, rand);
  return {
    data,
    adv: advantages,
    ret: returns,
    perm,
    epoch: 0,
    cursor: 0,
    inBatch: 0,
    batchSize: Math.min(cfg.minibatch, Math.max(1, data.length)),
    grad: new Float64Array(policy.params.length),
    rand,
    scratch: createPpoScratch(policy),
    acc: { policyLoss: 0, valueLoss: 0, entropy: 0, approxKl: 0, clipped: 0, n: 0, gradNorm: 0, batches: 0 },
    done: data.length === 0,
  };
}

/**
 * Advance the job until `deadline` (a `now()` reading) or completion. Time is
 * checked every few samples, so a call overruns its deadline by at most a
 * handful of forward/backward passes. Returns true once finished.
 */
export function stepPpoUpdate(
  job: PpoUpdateJob,
  policy: RlPolicy,
  adam: AdamState,
  cfg: PpoConfig,
  deadline: number,
  now: () => number = () => performance.now(),
): boolean {
  const n = job.data.length;
  let sinceCheck = 0;
  while (!job.done) {
    const idx = job.perm[job.cursor];
    const remaining = n - (job.cursor - job.inBatch);
    const thisBatch = Math.min(job.batchSize, remaining);
    const st = accumulatePpoSampleGrad(policy, job.data[idx], job.adv[idx], job.ret[idx], cfg, job.grad, 1 / thisBatch, job.scratch);
    job.acc.policyLoss += st.policyLoss;
    job.acc.valueLoss += st.valueLoss;
    job.acc.entropy += st.entropy;
    job.acc.approxKl += st.approxKl;
    job.acc.clipped += st.clipped ? 1 : 0;
    job.acc.n++;
    job.cursor++;
    job.inBatch++;

    if (job.inBatch >= thisBatch) {
      job.acc.gradNorm += clipGradNorm(job.grad, cfg.maxGradNorm);
      job.acc.batches++;
      adamStep(policy.params, job.grad, adam, cfg.learningRate);
      job.grad.fill(0);
      job.inBatch = 0;
      if (job.cursor >= n) {
        job.epoch++;
        job.cursor = 0;
        if (job.epoch >= cfg.epochs) { job.done = true; break; }
        shuffleInPlace(job.perm, job.rand);
      }
    }
    if (++sinceCheck >= 4) {
      sinceCheck = 0;
      if (now() >= deadline) break;
    }
  }
  return job.done;
}

export function ppoUpdateStats(job: PpoUpdateJob): PpoUpdateStats {
  const a = job.acc;
  const n = Math.max(1, a.n);
  return {
    policyLoss: a.policyLoss / n,
    valueLoss: a.valueLoss / n,
    entropy: a.entropy / n,
    approxKl: a.approxKl / n,
    clipFrac: a.clipped / n,
    gradNorm: a.gradNorm / Math.max(1, a.batches),
    samples: a.n,
    minibatches: a.batches,
  };
}

/** Run a whole update synchronously (check script / tests). */
export function runPpoUpdate(policy: RlPolicy, adam: AdamState, data: RlTransition[], cfg: PpoConfig, seed = 1): PpoUpdateStats {
  const job = startPpoUpdate(policy, data, cfg, seed);
  while (!stepPpoUpdate(job, policy, adam, cfg, Infinity, () => 0)) { /* until done */ }
  return ppoUpdateStats(job);
}
