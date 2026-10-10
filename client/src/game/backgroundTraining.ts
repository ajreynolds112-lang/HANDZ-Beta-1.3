/**
 * Background training — keeps the fundamentals sweep and/or the RL trainer
 * running while the player is elsewhere in the game, for 1–8 hours or until
 * the page is reloaded (the on/off state is never persisted; only the chosen
 * hours and trainers are remembered as a preference).
 *
 * Ownership: exactly one place runs a given trainer at a time. While the AI
 * Training screen is open it owns both runs and this runner is paused; the
 * screen and this module hand the live run objects back and forth through the
 * shared slots below, so neither ever re-reads a checkpoint that may still be
 * on its way to IndexedDB.
 *
 * It also pauses during live bouts, training minigames and the week sim: the
 * engine keeps a little module-level recording state that interleaved headless
 * bouts would disturb, and those screens need the frame budget anyway.
 */
import { soundEngine } from "./sound";
import { type TrainingRun, runHeadless, cycleComplete, currentFundamental, neuralOverridesForRun } from "./aiTraining";
import { loadFundamentalsRun, saveFundamentalsRun, closeFundamentalCycle } from "./fundamentalsRunStore";
import { createRlRun, loadRlCheckpoint, type RlRun } from "./rlRun";
import { newRlRuntime, runRlFrame, saveRlRun, stableRlRun, stopRl, runFromDeployedIfAhead, type RlRuntime } from "./rlTraining";
import { setTrainingNeuralOverrides } from "@/components/NeuralNetworkView";

export const BG_TRAINING_MIN_HOURS = 1;
export const BG_TRAINING_MAX_HOURS = 8;

const PREFS_KEY = "handz_bg_training_prefs";
/** Per-slice simulation budget while the tab is visible (keeps menus smooth). */
const VISIBLE_BUDGET_MS = 6;
/** While hidden nothing is drawn, so slices can be much longer. */
const HIDDEN_BUDGET_MS = 50;
const FUND_AUTOSAVE_MS = 10000;
const RL_AUTOSAVE_MS = 15000;

export type BgPauseReason = "view" | "fight";

export interface BgTrainingPrefs { fundamentals: boolean; rl: boolean; hours: number }

export interface BgTrainingStatus extends BgTrainingPrefs {
  on: boolean;
  endsAt: number | null;
  paused: boolean;
  pausedFor: BgPauseReason[];
  fundGen: number | null;
  fundName: string | null;
  fundDone: number;
  fundTotal: number;
  rlSteps: number | null;
  rlUpdates: number | null;
  /** Why the last session ended, shown once. */
  lastEnded: "time" | "off" | null;
}

// ---- hand-off slots shared with the AI Training screen ---------------------
let sharedFund: TrainingRun | null = null;
let sharedRl: RlRun | null = null;
export function shareFundamentalsRun(run: TrainingRun) { sharedFund = run; }
export function shareRlRun(run: RlRun) { sharedRl = run; }
export function takeSharedFundamentalsRun(): TrainingRun | null { const r = sharedFund; sharedFund = null; return r; }
export function takeSharedRlRun(): RlRun | null { const r = sharedRl; sharedRl = null; return r; }

// ---- state -----------------------------------------------------------------
function clampHours(h: unknown): number {
  const n = Math.round(Number(h));
  return Number.isFinite(n) ? Math.min(BG_TRAINING_MAX_HOURS, Math.max(BG_TRAINING_MIN_HOURS, n)) : BG_TRAINING_MAX_HOURS;
}

function loadPrefs(): BgTrainingPrefs {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY) || "null");
    if (p && typeof p === "object") {
      return { fundamentals: p.fundamentals !== false, rl: p.rl !== false, hours: clampHours(p.hours) };
    }
  } catch { /* fall through */ }
  return { fundamentals: true, rl: true, hours: BG_TRAINING_MAX_HOURS };
}

let prefs: BgTrainingPrefs = loadPrefs();
let on = false;
let endsAt: number | null = null;
let lastEnded: BgTrainingStatus["lastEnded"] = null;
const pausedFor = new Set<BgPauseReason>();

let fundRun: TrainingRun | null = null;
let fundSavedAt = 0;
let rlRun: RlRun | null = null;
let rlRt: RlRuntime = newRlRuntime();
let rlLoading = false;
let rlSavedAt = 0;
let sliceCount = 0;

let timer: ReturnType<typeof setTimeout> | null = null;
let channel: MessageChannel | null = null;
let looping = false;

const listeners = new Set<() => void>();
let lastEmit = 0;
let cachedStatus: BgTrainingStatus | null = null;

function emit(force = false) {
  const now = Date.now();
  if (!force && now - lastEmit < 500) return;
  lastEmit = now;
  cachedStatus = null;
  listeners.forEach(l => l());
}

export function subscribeBackgroundTraining(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function getBackgroundTrainingStatus(): BgTrainingStatus {
  if (cachedStatus) return cachedStatus;
  const f = fundRun ?? sharedFund;
  const r = rlRun ?? sharedRl;
  cachedStatus = {
    ...prefs,
    on, endsAt, lastEnded,
    paused: pausedFor.size > 0,
    pausedFor: Array.from(pausedFor),
    fundGen: f ? f.gen : null,
    fundName: f ? currentFundamental(f).label : null,
    fundDone: f ? f.cursor : 0,
    fundTotal: f ? f.schedule.length : 0,
    rlSteps: r ? r.totalSteps : null,
    rlUpdates: r ? r.updates : null,
  };
  return cachedStatus;
}

// ---- run ownership ---------------------------------------------------------
function flushSaves() {
  if (fundRun) saveFundamentalsRun(fundRun);
  if (rlRun) void saveRlRun(rlRun, rlRt);
}

/** Give the live runs up (saved, and left in the hand-off slots). */
function releaseRuns() {
  flushSaves();
  if (fundRun) { sharedFund = fundRun; fundRun = null; }
  if (rlRun) { sharedRl = stableRlRun(rlRun, rlRt); rlRun = null; }
  stopRl(rlRt);
  rlRt = newRlRuntime();
}

function ensureFundRun(): TrainingRun {
  if (!fundRun) {
    fundRun = takeSharedFundamentalsRun() ?? loadFundamentalsRun();
    fundSavedAt = Date.now();
  }
  return fundRun;
}

/** Null while the checkpoint is still loading. */
function ensureRlRun(): RlRun | null {
  if (rlRun) return rlRun;
  const shared = takeSharedRlRun();
  if (shared) { rlRun = runFromDeployedIfAhead(shared) ?? shared; rlSavedAt = Date.now(); return rlRun; }
  if (!rlLoading) {
    rlLoading = true;
    loadRlCheckpoint().then((stored) => {
      rlLoading = false;
      // Taken over (screen opened / switched off) while loading: leave it.
      if (!on || pausedFor.has("view") || rlRun) {
        if (stored && !sharedRl) sharedRl = stored;
        return;
      }
      rlRun = runFromDeployedIfAhead(stored) ?? stored ?? createRlRun((Math.random() * 0x7fffffff) >>> 0);
      rlSavedAt = Date.now();
      void saveRlRun(rlRun, rlRt);
    }).catch(() => { rlLoading = false; });
  }
  return null;
}

// ---- loop ------------------------------------------------------------------
function active(): boolean {
  return on && pausedFor.size === 0 && (prefs.fundamentals || prefs.rl);
}

function scheduleNext() {
  if (!active()) { looping = false; return; }
  looping = true;
  if (typeof document !== "undefined" && document.hidden) {
    // Hidden tabs throttle timers to once a second or worse; a message
    // channel keeps the slices coming.
    if (!channel) {
      channel = new MessageChannel();
      channel.port1.onmessage = () => tick();
    }
    channel.port2.postMessage(0);
  } else {
    timer = setTimeout(tick, 16);
  }
}

function tick() {
  timer = null;
  if (!active()) { looping = false; return; }
  if (endsAt != null && Date.now() >= endsAt) { stopBackgroundTraining("time"); return; }

  const budget = typeof document !== "undefined" && document.hidden ? HIDDEN_BUDGET_MS : VISIBLE_BUDGET_MS;
  const both = prefs.fundamentals && prefs.rl;
  const doFund = prefs.fundamentals && (!both || sliceCount % 2 === 0);
  sliceCount++;
  const wasSilent = soundEngine.isSilent();
  try {
    const now = Date.now();
    if (doFund) {
      const firstLoad = !fundRun;
      const run = ensureFundRun();
      // The seeds reach the AI through the training override channel.
      if (firstLoad) setTrainingNeuralOverrides(neuralOverridesForRun(run));
      runHeadless(run, budget);
      if (cycleComplete(run)) {
        closeFundamentalCycle(run);
        fundSavedAt = now;
      } else if (now - fundSavedAt > FUND_AUTOSAVE_MS) {
        fundSavedAt = now;
        saveFundamentalsRun(run);
      }
    } else {
      const run = ensureRlRun();
      if (run) {
        const updated = runRlFrame(run, rlRt, budget);
        if (updated || now - rlSavedAt > RL_AUTOSAVE_MS) {
          rlSavedAt = now;
          void saveRlRun(run, rlRt);
        }
      }
    }
  } catch (err) {
    console.error("[background training] stopped after an error", err);
    stopBackgroundTraining("off");
    return;
  } finally {
    // The headless runners silence the sound engine; the game must not stay muted.
    soundEngine.setSilent(wasSilent);
  }
  emit();
  scheduleNext();
}

function kick() {
  if (!looping && active()) scheduleNext();
  emit(true);
}

// ---- public controls -------------------------------------------------------
export function setBackgroundTrainingPrefs(next: Partial<BgTrainingPrefs>) {
  const wasFund = prefs.fundamentals, wasRl = prefs.rl;
  prefs = {
    fundamentals: next.fundamentals ?? prefs.fundamentals,
    rl: next.rl ?? prefs.rl,
    hours: next.hours != null ? clampHours(next.hours) : prefs.hours,
  };
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* ignore */ }
  // A trainer switched off mid-session gives its run up straight away.
  if (wasFund && !prefs.fundamentals && fundRun) { saveFundamentalsRun(fundRun); sharedFund = fundRun; fundRun = null; }
  if (wasRl && !prefs.rl && rlRun) { void saveRlRun(rlRun, rlRt); sharedRl = stableRlRun(rlRun, rlRt); rlRun = null; stopRl(rlRt); rlRt = newRlRuntime(); }
  // Changing the hours while running restarts the countdown from now.
  if (on && next.hours != null) endsAt = Date.now() + prefs.hours * 3600_000;
  if (on && !prefs.fundamentals && !prefs.rl) { stopBackgroundTraining("off"); return; }
  kick();
}

export function startBackgroundTraining() {
  on = true;
  lastEnded = null;
  endsAt = Date.now() + prefs.hours * 3600_000;
  kick();
}

export function stopBackgroundTraining(why: "time" | "off" = "off") {
  if (!on) return;
  on = false;
  endsAt = null;
  lastEnded = why;
  if (timer) { clearTimeout(timer); timer = null; }
  looping = false;
  releaseRuns();
  emit(true);
}

export function pauseBackgroundTraining(reason: BgPauseReason, paused: boolean) {
  if (paused) {
    if (pausedFor.has(reason)) return;
    pausedFor.add(reason);
    if (timer) { clearTimeout(timer); timer = null; }
    looping = false;
    // The training screen takes the runs over; a fight just waits.
    if (reason === "view") releaseRuns(); else flushSaves();
    emit(true);
  } else {
    if (!pausedFor.delete(reason)) return;
    kick();
  }
}

if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", flushSaves);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) flushSaves();
    // Switch the loop to the right kind of scheduling for the new visibility.
    if (looping && timer) { clearTimeout(timer); timer = null; looping = false; kick(); }
  });
}
