/**
 * ===== RL TACTICAL POLICY =====
 *
 * A small multilayer perceptron that sits on top of the string engine. The
 * existing AI still decides *when* to attack, how to defend and where to move;
 * at the moment a string is picked this network decides three things instead
 * of the weighted random chooser:
 *
 *   - which string (one logit per library entry, masked to what is eligible),
 *   - what tempo — the beat delay used for every slot of that run,
 *   - which tactical utility wraps it (standard, Reset, arm Charge,
 *     slip-then-counter, stance switch).
 *
 * It also carries a value head, which the trainer needs for advantage
 * estimates and the live game ignores.
 *
 * Plain Float32Array math with no dependencies and no engine imports, so the
 * same module runs in the browser and under the Node check script. Weights are
 * stored as JSON (base64 little-endian float32) with a version field.
 */

export const RL_POLICY_KIND = "handz-rl-policy";
export const RL_POLICY_VERSION = 1;

// ===== ACTION SPACE =====

/** Tempo range the policy chooses from, in seconds per beat. */
export const RL_TEMPO_MIN = 0.005;
export const RL_TEMPO_MAX = 0.5;
/** Must match the string engine's BEAT_STEP; the check script asserts it. */
export const RL_TEMPO_STEP = 0.005;
export const RL_TEMPO_BIN_COUNT = 10;

export const RL_UTILITIES = ["standard", "reset", "charge", "slipCounter", "switchStance"] as const;
export type RlUtility = (typeof RL_UTILITIES)[number];
export const RL_UTILITY_COUNT = RL_UTILITIES.length;
export const RL_UTILITY_LABELS: Record<RlUtility, string> = {
  standard: "Standard",
  reset: "Reset",
  charge: "Charge",
  slipCounter: "Slip-counter",
  switchStance: "Stance switch",
};

/**
 * Log-spaced tempo bins over [RL_TEMPO_MIN, RL_TEMPO_MAX], each snapped to the
 * beat step. Snapping can collapse neighbours at the bottom of the range, so a
 * collision is pushed up one step to keep every bin distinct.
 */
export function rlTempoBins(count: number = RL_TEMPO_BIN_COUNT): number[] {
  const out: number[] = [];
  const n = Math.max(2, Math.floor(count));
  for (let i = 0; i < n; i++) {
    const raw = RL_TEMPO_MIN * Math.pow(RL_TEMPO_MAX / RL_TEMPO_MIN, i / (n - 1));
    let v = Math.round(raw / RL_TEMPO_STEP) * RL_TEMPO_STEP;
    v = Math.round(v * 1000) / 1000;
    if (out.length > 0 && v <= out[out.length - 1]) {
      v = Math.round((out[out.length - 1] + RL_TEMPO_STEP) * 1000) / 1000;
    }
    out.push(Math.min(RL_TEMPO_MAX, Math.max(RL_TEMPO_MIN, v)));
  }
  return out;
}

// ===== NETWORK SHAPE & PARAMETER LAYOUT =====

export interface RlPolicyShape {
  obsSize: number;
  hidden1: number;
  hidden2: number;
  /** String head width: one logit per entry of `stringIds`. */
  nStrings: number;
  nTempo: number;
  nUtility: number;
}

/** Offsets into the flat parameter vector, in storage order. */
export interface RlParamLayout {
  w1: number; b1: number;
  w2: number; b2: number;
  ws: number; bs: number;
  wt: number; bt: number;
  wu: number; bu: number;
  wv: number; bv: number;
  total: number;
}

export function rlParamLayout(s: RlPolicyShape): RlParamLayout {
  let o = 0;
  const take = (n: number) => { const at = o; o += n; return at; };
  const w1 = take(s.hidden1 * s.obsSize);
  const b1 = take(s.hidden1);
  const w2 = take(s.hidden2 * s.hidden1);
  const b2 = take(s.hidden2);
  const ws = take(s.nStrings * s.hidden2);
  const bs = take(s.nStrings);
  const wt = take(s.nTempo * s.hidden2);
  const bt = take(s.nTempo);
  const wu = take(s.nUtility * s.hidden2);
  const bu = take(s.nUtility);
  const wv = take(s.hidden2);
  const bv = take(1);
  return { w1, b1, w2, b2, ws, bs, wt, bt, wu, bu, wv, bv, total: o };
}

export interface RlForward {
  /** Post-activation hidden layers (kept for the trainer's backward pass). */
  h1: Float32Array;
  h2: Float32Array;
  stringLogits: Float32Array;
  tempoLogits: Float32Array;
  utilityLogits: Float32Array;
  value: number;
}

export interface RlPolicyMeta {
  createdAt?: string;
  /** Environment steps / decisions the trainer has fed this policy. */
  trainedSteps?: number;
  /** PPO updates the trainer had run when this policy was deployed. */
  updates?: number;
  note?: string;
}

export class RlPolicy {
  readonly shape: RlPolicyShape;
  /** Head index -> AI_STRINGS id. */
  readonly stringIds: number[];
  /** Head index -> beat delay in seconds. */
  readonly tempoBins: number[];
  readonly layout: RlParamLayout;
  readonly params: Float32Array;
  meta: RlPolicyMeta;

  constructor(
    shape: RlPolicyShape,
    stringIds: number[],
    tempoBins: number[],
    params?: Float32Array,
    meta: RlPolicyMeta = {},
  ) {
    if (stringIds.length !== shape.nStrings) {
      throw new Error(`stringIds has ${stringIds.length} entries, shape expects ${shape.nStrings}`);
    }
    if (tempoBins.length !== shape.nTempo) {
      throw new Error(`tempoBins has ${tempoBins.length} entries, shape expects ${shape.nTempo}`);
    }
    this.shape = { ...shape };
    this.stringIds = stringIds.slice();
    this.tempoBins = tempoBins.slice();
    this.layout = rlParamLayout(shape);
    if (params && params.length !== this.layout.total) {
      throw new Error(`params has ${params.length} values, shape expects ${this.layout.total}`);
    }
    this.params = params ? params : new Float32Array(this.layout.total);
    this.meta = { ...meta };
  }

  forward(obs: ArrayLike<number>): RlForward {
    const s = this.shape;
    const L = this.layout;
    const p = this.params;
    const h1 = dense(p, L.w1, L.b1, obs, s.obsSize, s.hidden1, true);
    const h2 = dense(p, L.w2, L.b2, h1, s.hidden1, s.hidden2, true);
    const stringLogits = dense(p, L.ws, L.bs, h2, s.hidden2, s.nStrings, false);
    const tempoLogits = dense(p, L.wt, L.bt, h2, s.hidden2, s.nTempo, false);
    const utilityLogits = dense(p, L.wu, L.bu, h2, s.hidden2, s.nUtility, false);
    const value = dense(p, L.wv, L.bv, h2, s.hidden2, 1, false)[0];
    return { h1, h2, stringLogits, tempoLogits, utilityLogits, value };
  }

  clone(): RlPolicy {
    return new RlPolicy(this.shape, this.stringIds, this.tempoBins, new Float32Array(this.params), this.meta);
  }
}

/** y = act(W x + b), W row-major [outN][inN]. Missing inputs read as 0. */
function dense(
  p: Float32Array,
  wOff: number,
  bOff: number,
  x: ArrayLike<number>,
  inN: number,
  outN: number,
  tanh: boolean,
): Float32Array {
  const y = new Float32Array(outN);
  for (let o = 0; o < outN; o++) {
    let acc = p[bOff + o];
    const row = wOff + o * inN;
    for (let i = 0; i < inN; i++) {
      const xi = x[i];
      if (xi) acc += p[row + i] * xi;
    }
    y[o] = tanh ? Math.tanh(acc) : acc;
  }
  return y;
}

// ===== INITIALISATION =====

/** mulberry32: small, fast, seedable. Only used to roll initial weights. */
export function seededUniform(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface CreateRlPolicyOptions {
  obsSize: number;
  stringIds: number[];
  hidden1?: number;
  hidden2?: number;
  tempoBins?: number[];
  seed?: number;
  meta?: RlPolicyMeta;
}

/**
 * A freshly initialised policy. Hidden layers use Xavier-uniform; the three
 * policy heads start 100x smaller so the untrained policy is close to uniform
 * over whatever the mask allows (the usual PPO initialisation), and the value
 * head starts at unit scale.
 */
export function createRlPolicy(opts: CreateRlPolicyOptions): RlPolicy {
  const tempoBins = opts.tempoBins ?? rlTempoBins();
  const shape: RlPolicyShape = {
    obsSize: opts.obsSize,
    hidden1: opts.hidden1 ?? 64,
    hidden2: opts.hidden2 ?? 64,
    nStrings: opts.stringIds.length,
    nTempo: tempoBins.length,
    nUtility: RL_UTILITY_COUNT,
  };
  const policy = new RlPolicy(shape, opts.stringIds, tempoBins, undefined, {
    createdAt: new Date().toISOString(),
    trainedSteps: 0,
    ...opts.meta,
  });
  const rand = seededUniform(opts.seed ?? 1);
  const L = policy.layout;
  const p = policy.params;
  const fill = (off: number, inN: number, outN: number, gain: number) => {
    const lim = gain * Math.sqrt(6 / (inN + outN));
    for (let i = 0; i < inN * outN; i++) p[off + i] = (rand() * 2 - 1) * lim;
  };
  fill(L.w1, shape.obsSize, shape.hidden1, 1);
  fill(L.w2, shape.hidden1, shape.hidden2, 1);
  fill(L.ws, shape.hidden2, shape.nStrings, 0.01);
  fill(L.wt, shape.hidden2, shape.nTempo, 0.01);
  fill(L.wu, shape.hidden2, shape.nUtility, 0.01);
  fill(L.wv, shape.hidden2, 1, 1);
  // Biases stay zero.
  return policy;
}

// ===== DISTRIBUTIONS =====

type MaskLike = ArrayLike<number | boolean> | null | undefined;

function allowed(mask: MaskLike, i: number): boolean {
  return !mask || !!mask[i];
}

/**
 * Log-softmax over the allowed entries. Masked-out entries come back as
 * -Infinity. Returns null when nothing is allowed.
 */
export function maskedLogSoftmax(logits: ArrayLike<number>, mask?: MaskLike): Float64Array | null {
  const n = logits.length;
  let max = -Infinity;
  for (let i = 0; i < n; i++) if (allowed(mask, i) && logits[i] > max) max = logits[i];
  if (max === -Infinity) return null;
  let sum = 0;
  for (let i = 0; i < n; i++) if (allowed(mask, i)) sum += Math.exp(logits[i] - max);
  const lse = max + Math.log(sum);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = allowed(mask, i) ? logits[i] - lse : -Infinity;
  return out;
}

/** Inverse-CDF draw from log-probabilities with one uniform in [0, 1). */
export function sampleFromLogProbs(logp: Float64Array, u: number): number {
  let last = -1;
  let acc = 0;
  for (let i = 0; i < logp.length; i++) {
    if (logp[i] === -Infinity) continue;
    last = i;
    acc += Math.exp(logp[i]);
    if (u < acc) return i;
  }
  return last; // rounding left a sliver at the top: the last allowed entry takes it
}

export function argmaxLogProbs(logp: Float64Array): number {
  let best = -1;
  let bestV = -Infinity;
  for (let i = 0; i < logp.length; i++) {
    if (logp[i] > bestV) { bestV = logp[i]; best = i; }
  }
  return best;
}

export function entropyOf(logp: Float64Array): number {
  let h = 0;
  for (let i = 0; i < logp.length; i++) {
    if (logp[i] === -Infinity) continue;
    h -= Math.exp(logp[i]) * logp[i];
  }
  return h;
}

// ===== ACTING =====

export interface RlAction {
  stringIndex: number;
  tempoIndex: number;
  utility: number;
}

export interface RlDecision extends RlAction {
  stringId: number;
  tempo: number;
  /** Joint log-probability: the sum of the three heads'. */
  logProb: number;
  logProbString: number;
  logProbTempo: number;
  logProbUtility: number;
  value: number;
  entropy: number;
}

export interface RlActOptions {
  /** Uniform [0,1) source. Live play passes the AI RNG. */
  uniform?: () => number;
  /** Argmax on every head instead of sampling (evaluation mode). */
  deterministic?: boolean;
  /** Optional utility mask; the live hook samples freely and refuses later. */
  utilityMask?: MaskLike;
}

/**
 * Choose an action. `stringMask` is indexed by head index (parallel to
 * `policy.stringIds`). Returns null when no string is eligible. Draw order is
 * fixed — string, then tempo, then utility — so a seeded source replays.
 */
export function rlAct(
  policy: RlPolicy,
  obs: ArrayLike<number>,
  stringMask: MaskLike,
  opts: RlActOptions = {},
): RlDecision | null {
  const fwd = policy.forward(obs);
  const ls = maskedLogSoftmax(fwd.stringLogits, stringMask);
  const lt = maskedLogSoftmax(fwd.tempoLogits);
  const lu = maskedLogSoftmax(fwd.utilityLogits, opts.utilityMask);
  if (!ls || !lt || !lu) return null;

  const uniform = opts.uniform ?? Math.random;
  const pick = (lp: Float64Array) =>
    opts.deterministic ? argmaxLogProbs(lp) : sampleFromLogProbs(lp, uniform());
  const stringIndex = pick(ls);
  const tempoIndex = pick(lt);
  const utility = pick(lu);
  if (stringIndex < 0 || tempoIndex < 0 || utility < 0) return null;

  const logProbString = ls[stringIndex];
  const logProbTempo = lt[tempoIndex];
  const logProbUtility = lu[utility];
  return {
    stringIndex,
    tempoIndex,
    utility,
    stringId: policy.stringIds[stringIndex],
    tempo: policy.tempoBins[tempoIndex],
    logProb: logProbString + logProbTempo + logProbUtility,
    logProbString,
    logProbTempo,
    logProbUtility,
    value: fwd.value,
    entropy: entropyOf(ls) + entropyOf(lt) + entropyOf(lu),
  };
}

/**
 * Log-probability and value of a given action under the policy — what the
 * trainer re-evaluates recorded decisions with. -Infinity for a masked action.
 */
export function rlEvaluate(
  policy: RlPolicy,
  obs: ArrayLike<number>,
  stringMask: MaskLike,
  action: RlAction,
  utilityMask?: MaskLike,
): { logProb: number; value: number; entropy: number } {
  const fwd = policy.forward(obs);
  const ls = maskedLogSoftmax(fwd.stringLogits, stringMask);
  const lt = maskedLogSoftmax(fwd.tempoLogits);
  const lu = maskedLogSoftmax(fwd.utilityLogits, utilityMask);
  if (!ls || !lt || !lu) return { logProb: -Infinity, value: fwd.value, entropy: 0 };
  return {
    logProb: (ls[action.stringIndex] ?? -Infinity) + (lt[action.tempoIndex] ?? -Infinity) + (lu[action.utility] ?? -Infinity),
    value: fwd.value,
    entropy: entropyOf(ls) + entropyOf(lt) + entropyOf(lu),
  };
}

// ===== SERIALISATION =====

export interface RlPolicyJson {
  kind: typeof RL_POLICY_KIND;
  version: number;
  shape: RlPolicyShape;
  stringIds: number[];
  tempoBins: number[];
  utilities: string[];
  paramCount: number;
  /** base64 of the flat parameter vector as little-endian float32. */
  params: string;
  meta?: RlPolicyMeta;
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_LOOKUP: Int16Array = (() => {
  const t = new Int16Array(128).fill(-1);
  for (let i = 0; i < B64.length; i++) t[B64.charCodeAt(i)] = i;
  return t;
})();

export function bytesToBase64(bytes: Uint8Array): string {
  const parts: string[] = [];
  let chunk = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    const n = (a << 16) | (b << 8) | c;
    chunk += B64[(n >> 18) & 63] + B64[(n >> 12) & 63];
    chunk += i + 1 < bytes.length ? B64[(n >> 6) & 63] : "=";
    chunk += i + 2 < bytes.length ? B64[n & 63] : "=";
    if (chunk.length >= 8192) { parts.push(chunk); chunk = ""; }
  }
  parts.push(chunk);
  return parts.join("");
}

export function base64ToBytes(s: string): Uint8Array {
  const clean = s.replace(/[^A-Za-z0-9+/=]/g, "");
  if (clean.length % 4 !== 0) throw new Error("base64 length is not a multiple of 4");
  const pad = clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0;
  const out = new Uint8Array((clean.length / 4) * 3 - pad);
  let o = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const v = [0, 1, 2, 3].map((k) => {
      const ch = clean.charCodeAt(i + k);
      if (clean[i + k] === "=") return 0;
      const d = ch < 128 ? B64_LOOKUP[ch] : -1;
      if (d < 0) throw new Error("invalid base64 character");
      return d;
    });
    const n = (v[0] << 18) | (v[1] << 12) | (v[2] << 6) | v[3];
    if (o < out.length) out[o++] = (n >> 16) & 255;
    if (o < out.length) out[o++] = (n >> 8) & 255;
    if (o < out.length) out[o++] = n & 255;
  }
  return out;
}

function floatsToBase64(f: Float32Array): string {
  const bytes = new Uint8Array(f.length * 4);
  const dv = new DataView(bytes.buffer);
  for (let i = 0; i < f.length; i++) dv.setFloat32(i * 4, f[i], true);
  return bytesToBase64(bytes);
}

function base64ToFloats(s: string, expected: number): Float32Array {
  const bytes = base64ToBytes(s);
  if (bytes.length !== expected * 4) {
    throw new Error(`params decode to ${bytes.length / 4} values, expected ${expected}`);
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Float32Array(expected);
  for (let i = 0; i < expected; i++) out[i] = dv.getFloat32(i * 4, true);
  return out;
}

export function rlPolicyToJson(policy: RlPolicy): RlPolicyJson {
  return {
    kind: RL_POLICY_KIND,
    version: RL_POLICY_VERSION,
    shape: { ...policy.shape },
    stringIds: policy.stringIds.slice(),
    tempoBins: policy.tempoBins.slice(),
    utilities: RL_UTILITIES.slice(),
    paramCount: policy.params.length,
    params: floatsToBase64(policy.params),
    meta: { ...policy.meta },
  };
}

const isPosInt = (v: unknown): v is number =>
  typeof v === "number" && Number.isInteger(v) && v > 0;

/** null when `data` is a loadable policy file, otherwise the reason. */
export function validateRlPolicyJson(data: unknown): string | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return "Policy must be a JSON object.";
  const d = data as Record<string, unknown>;
  if (d.kind !== RL_POLICY_KIND) return `Not a policy file — "kind" must be "${RL_POLICY_KIND}".`;
  if (typeof d.version !== "number" || !Number.isFinite(d.version)) return `"version" must be a number.`;
  if (d.version > RL_POLICY_VERSION) {
    return `Policy is version ${d.version}, this build reads up to ${RL_POLICY_VERSION}.`;
  }
  const sh = d.shape as Record<string, unknown> | undefined;
  if (!sh || typeof sh !== "object") return `"shape" is missing.`;
  for (const k of ["obsSize", "hidden1", "hidden2", "nStrings", "nTempo", "nUtility"]) {
    if (!isPosInt(sh[k])) return `"shape.${k}" must be a positive integer.`;
  }
  if (sh.nUtility !== RL_UTILITY_COUNT) return `"shape.nUtility" must be ${RL_UTILITY_COUNT}.`;
  if (!Array.isArray(d.stringIds) || d.stringIds.length !== sh.nStrings ||
      !d.stringIds.every((v) => typeof v === "number" && Number.isInteger(v))) {
    return `"stringIds" must list ${String(sh.nStrings)} integer ids.`;
  }
  if (!Array.isArray(d.tempoBins) || d.tempoBins.length !== sh.nTempo ||
      !d.tempoBins.every((v) => typeof v === "number" && Number.isFinite(v) && v > 0)) {
    return `"tempoBins" must list ${String(sh.nTempo)} positive numbers.`;
  }
  if (typeof d.params !== "string") return `"params" must be a base64 string.`;
  const expected = rlParamLayout(sh as unknown as RlPolicyShape).total;
  if (d.paramCount !== undefined && d.paramCount !== expected) {
    return `"paramCount" is ${String(d.paramCount)}, the shape needs ${expected}.`;
  }
  return null;
}

/** Load a policy file. Throws with a readable message when it is not valid. */
export function rlPolicyFromJson(data: unknown): RlPolicy {
  const bad = validateRlPolicyJson(data);
  if (bad) throw new Error(bad);
  const d = data as RlPolicyJson;
  const layout = rlParamLayout(d.shape);
  const params = base64ToFloats(d.params, layout.total);
  for (let i = 0; i < params.length; i++) {
    if (!Number.isFinite(params[i])) throw new Error("params contain a non-finite value.");
  }
  const tempoBins = d.tempoBins.map((t) => Math.min(RL_TEMPO_MAX, Math.max(RL_TEMPO_MIN, t)));
  return new RlPolicy(d.shape, d.stringIds, tempoBins, params, d.meta ?? {});
}
