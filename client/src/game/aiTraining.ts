/**
 * The AI training tournament: unrendered bouts, fundamental scoring, and the
 * generation loop.
 *
 * Two things are deliberately kept apart here.
 *
 *  - **Behaviour** comes from a seed's parameters, folded onto the existing
 *    neural knobs by `deriveNeuralState` and delivered through the normal
 *    override channel. Evolution therefore drives the real AI, not a shadow copy.
 *  - **Measurement** comes from this file's observer, which watches game state and
 *    counts opportunities and successes with *fixed* thresholds. Those thresholds
 *    must never read a seed's own parameters: a boxer that could lower the bar it
 *    is being measured against would evolve to do exactly that instead of learning
 *    to box.
 *
 * The run is a sweep. One fundamental is under test at a time: every pair of
 * seeds meets a fixed number of times, the seed that executed that fundamental
 * best takes it, and only *its* parameters for that one fundamental are handed
 * to the Champion AI. The sweep then moves to the next fundamental, and getting
 * to the end of the list is what closes a generation and triggers the cut.
 *
 * Bouts run on the main thread in time-budgeted slices, and nothing is rendered:
 * every bout is headless, so the whole frame goes to simulating. The engine is
 * not worker-safe (module-level input state, audio, a config import from a React
 * module), so a cycle is spread across frames rather than moved off-thread.
 */
import type { GameState, FighterState } from "./types";
import { initAiBrain } from "./ai";
import { ROUND_SECONDS, startHeadlessBout, stepHeadless, type HeadlessOutcome } from "./headlessBout";
import { soundEngine } from "./sound";
import {
  FUNDAMENTALS, type Fundamental, type FundamentalSeed, type FundStat,
  emptyStats, makeFounder, evolveNextGeneration, rankSeeds, deriveNeuralState,
  paramId, TRAINING_ROSTER_BASE, basicsPunchClass, BASICS_INSIDE_PX, type BasicsPunchClass,
} from "./aiFundamentals";
import { getPunchReachPx } from "./engine";
import {
  SituationTracker, recordState, emptyStore,
  type Situation, type FundamentalStateStore,
} from "./fundamentalStates";
import {
  learnFundamental, sampleReplacements, judgeGate, pushLeague, emptyLearner,
  evidenceScore, fieldRate, GATE_BOUTS_PER_CYCLE,
  type LearnerState, type GateTally, type GateDecision,
} from "./fundamentalLearning";

export { TRAINING_ROSTER_BASE, isTrainingRosterId } from "./aiFundamentals";

// Timestep, round length, bout ceiling and resolution rules live in
// headlessBout.ts, shared with the RL policy trainer.

// ------------------------------------------------------------------ observer

interface CornerObs {
  stats: Record<string, FundStat>;
  prevThrown: number;
  prevLanded: number;
  prevOppLanded: number;
  prevDist: number;
  prevX: number;
  prevOppX: number;
  /** Seconds left in which a pending event can still be resolved. */
  missWindow: number;
  missResolved: boolean;
  jabWindow: number;
  evadeWindow: number;
  evadeResolved: boolean;
  pullWindow: number;
  pullResolved: boolean;
  gaveGround: number;
  inviteWindow: number;
  inviteResolved: boolean;
  hurtTick: number;
  hurtGuard: boolean;
  hurtThrown: number;
  hurtHitTaken: boolean;
  resetTick: number;
  resetJab: boolean;
  resetHit: boolean;
  landWindow: number;
  landOppX: number;
  landWasBody: boolean;
  landOppStamina: number;
  blockWindow: number;
  checkWindow: number;
  oppLastThrow: number;
  // 50 / 51 / 52 — one feint is scored by three fundamentals at once: did it draw
  // a reaction, did it turn into something, and had it been earned by real work.
  prevFeinting: boolean;
  feintWindow: number;
  feintReacted: boolean;
  feintConverted: boolean;
  feintCredited: boolean;
  feintStartX: number;
  feintOppBusy: boolean;
  lastLandAt: number;
  // 53
  lastPunchType: string | null;
  lastAimHead: boolean;
  sameTypeRun: number;
  // 54
  trapWindow: number;
  trapResolved: boolean;
  // 55
  throwWindow: number;
  throwResolved: boolean;
  // 56 / 57
  chainCount: number;
  chainGap: number;
  chainScored: boolean;
  chainMoved: boolean;
  chainStartX: number;
  chainStartAngle: number;
  // 58
  entryActive: boolean;
  entryFeint: boolean;
  entryHurt: boolean;
  entryScored: boolean;
  entryWindow: number;
  // 59
  lastPunchAt: number;
  gaps: number[];
  tempoTick: number;
  // ---- Tier 5 (37-49). Defensive and counterpunching architecture.
  prevOppThrown: number;
  // 37
  adWindow: number; adResolved: boolean; adStartX: number; adStartAngle: number;
  // 38
  dfWindow: number;
  // 39
  ieWindow: number; ieResolved: boolean; ieDefendedAt: number;
  // 40
  rfWindow: number; rfOppThrown: number; rfCounted: boolean;
  // 41
  dzWindow: number; dzResolved: boolean; dzX: number;
  // 42 / 45 — one counter is graded twice: was the window seen, and was the
  // punch that took it a different punch from last time.
  cwWindow: number; cwResolved: boolean; cvLastType: string | null;
  // 43
  ccWindow: number; ccResolved: boolean; ccOppThrown: number; ccDrewFire: boolean;
  // 44
  dvLastMethod: string | null; dvRun: number; dvPrevDefending: boolean;
  // 46
  ceWindow: number; ceResolved: boolean; ceStartX: number;
  // 47
  mmWindow: number; mmResolved: boolean; mmLanded: boolean; mmX: number;
  // 48
  ftUnanswered: number; ftWindow: number; ftResolved: boolean; ftX: number;
  // 49
  pnWindow: number; pnHit: boolean; pnLayers: number; pnStartX: number; pnStartAngle: number;
  // ---- Tier 1-4 (1-36). Philosophy, prediction, strategy, structure.
  prevOppPunching: boolean;
  prevActing: boolean;
  // 1
  caTick: number; caGain: boolean; caHit: boolean;
  // 2
  drWindow: number; drHit: boolean; drSafe: boolean;
  // 3
  pqWindow: number; pqResolved: boolean;
  // 4
  cmpTick: number; cmpThrown: number; cmpHit: boolean;
  // 5
  ktTick: number; ktOppThrown: number; ktOppX: number;
  // 6
  apIdle: number; apWorked: boolean;
  // 7
  spTick: number; spThrown: number; spDefend: number; spLast: number;
  // 8
  laMiss: number; laWindow: number; laResolved: boolean; laX: number;
  laType: string | null; laMethod: string | null;
  // 9
  ihTypes: string[]; ihThrown: number;
  // 10
  ptWindow: number;
  // 11
  heOppType: string | null; heRun: number; heWindow: number; heResolved: boolean;
  // 12
  taWindow: number; taHit: boolean;
  // 13
  idWindow: number; idResolved: boolean; idX: number; idType: string | null; idMethod: string | null;
  // 15
  cmWindow: number; cmHit: boolean;
  // 16
  evWindow: number; evTook: boolean; evLanded: boolean; evHit: boolean;
  // 17
  ipWindow: number; ipResolved: boolean;
  // 18
  rgWindow: number;
  // 19
  tcTick: number; tcOurs: number; tcTheirs: number; tcPrevOurs: number; tcPrevTheirs: number; tcHave: boolean;
  // 20
  momMineRun: number; momOppRun: number; momWindow: number; momMine: boolean; momResolved: boolean;
  // 21
  rpAdv: number; rpHit: boolean;
  // 22
  raWindow: number; raResolved: boolean; raArmed: boolean;
  // 23
  reWindow: number; reResolved: boolean;
  // 24
  awWindow: number; awFollow: number; awHit: boolean; awX: number;
  // 25
  relIn: boolean; relWindow: number; relResolved: boolean; relHit: boolean;
  // 26
  stWindow: number; stResolved: boolean; stSelfX: number;
  // 27
  adoWindow: number; adoResolved: boolean; adoAngle: number; adoOppAngle: number;
  // 28
  lhWindow: number; lhOppThrown: number; lhHit: boolean;
  // 29
  riWindow: number; riResolved: boolean; riOppDir: number;
  // 30
  biWindow: number; biResolved: boolean; biX: number;
  // 31
  papWindow: number; papResolved: boolean; papX: number; papAngle: number;
  // 32
  fpWindow: number; fpResolved: boolean; fpOppX: number; fpOppGuard: boolean;
  // 34
  xcActive: boolean; xcWindow: number; xcEntry: boolean; xcAttack: boolean; xcTrans: boolean; xcExit: boolean;
  // 35
  ctPrev: string | null; ctGap: number;
  // 36
  erWindow: number; erResolved: boolean; erArmed: boolean;
  // 74-94 Basics
  bs: BasicsObs;
  /** Rolling situation windows for this corner. */
  tracker: SituationTracker;
  /** Situations this corner executed the fundamental under test in. */
  hits: Situation[];
}

export interface FightObserver {
  a: CornerObs;
  b: CornerObs;
  elapsed: number;
  /** The fundamental being swept. Only this one has its situations kept. */
  fundKey: string;
}

/** Observer state for the Basics layer (74-94). Kept in one record so the
 *  layer reads as a unit; every threshold below is a fixed constant. */
interface BasicsObs {
  wasPunching: boolean;
  ownWindow: number; ownHit: boolean;
  jabWindow: number;
  crossWindow: number; hookThrown: boolean;
  afterWindow: number; afterMoved: boolean; afterHit: boolean;
  inCls: BasicsPunchClass | null; inHit: boolean; inSlip: boolean; inDuck: boolean;
  evadeWindow: number;
  cutWindow: number;
  // 85-94
  blockedByMe: number; blockedByOpp: number;
  catchWindow: number; catchKind: "jab" | "power";
  ripWindow: number;
  dhWindow: number; dhHit: boolean;
  exitWindow: number; exitHit: boolean;
  ropeWindow: number; ropeHits: number;
  circleWindow: number; circleLat: number; circleBack: number; prevX: number; prevZ: number; prevRd: number; prevOppZ: number;
  upWindow: number;
  levels: boolean[]; levelCount: number;
}

const newBasicsObs = (): BasicsObs => ({
  wasPunching: false, ownWindow: 0, ownHit: false, jabWindow: 0, crossWindow: 0, hookThrown: false,
  afterWindow: 0, afterMoved: false, afterHit: false,
  inCls: null, inHit: false, inSlip: false, inDuck: false, evadeWindow: 0, cutWindow: 0,
  blockedByMe: -1, blockedByOpp: -1, catchWindow: 0, catchKind: "jab", ripWindow: 0,
  dhWindow: 0, dhHit: false, exitWindow: 0, exitHit: false, ropeWindow: 0, ropeHits: 0,
  circleWindow: 0, circleLat: 0, circleBack: 0, prevX: 0, prevZ: 0, prevRd: 0, prevOppZ: 0, upWindow: 0, levels: [], levelCount: 0,
});

/** Per-tick facts the corner can't read off the two fighters: punches each
 *  side blocked this round, and the ring's half-width. */
interface CornerCtx { byMe: number; byOpp: number; cx: number; cz: number; halfW: number; halfH: number }
const ctxFor = (state: GameState, self: FighterState): CornerCtx => {
  const rs = state.roundStats;
  const pb = rs?.playerPunchesBlocked ?? 0, eb = rs?.enemyPunchesBlocked ?? 0;
  return { byMe: self.isPlayer ? pb : eb, byOpp: self.isPlayer ? eb : pb,
    cx: (state.ringLeft + state.ringRight) / 2, cz: (state.ringTop + state.ringBottom) / 2,
    halfW: (state.ringRight - state.ringLeft) / 2, halfH: (state.ringBottom - state.ringTop) / 2 };
};

function newCorner(): CornerObs {
  return {
    bs: newBasicsObs(),
    stats: emptyStats(),
    tracker: new SituationTracker(),
    hits: [],
    prevThrown: 0, prevLanded: 0, prevOppLanded: 0, prevDist: 0, prevX: 0, prevOppX: 0,
    missWindow: 0, missResolved: false, jabWindow: 0,
    evadeWindow: 0, evadeResolved: false, pullWindow: 0, pullResolved: false,
    gaveGround: 0, inviteWindow: 0, inviteResolved: false,
    hurtTick: 0, hurtGuard: false, hurtThrown: 0, hurtHitTaken: false,
    resetTick: 0, resetJab: false, resetHit: false,
    landWindow: 0, landOppX: 0, landWasBody: false, landOppStamina: 0,
    blockWindow: 0, checkWindow: 0, oppLastThrow: 0,
    prevFeinting: false, feintWindow: 0, feintReacted: false, feintConverted: false,
    feintCredited: false, feintStartX: 0, feintOppBusy: false, lastLandAt: -99,
    lastPunchType: null, lastAimHead: true, sameTypeRun: 0,
    trapWindow: 0, trapResolved: false,
    throwWindow: 0, throwResolved: false,
    chainCount: 0, chainGap: 0, chainScored: false, chainMoved: false,
    chainStartX: 0, chainStartAngle: 0,
    entryActive: false, entryFeint: false, entryHurt: false, entryScored: false, entryWindow: 0,
    lastPunchAt: 0, gaps: [], tempoTick: 0,
    prevOppThrown: 0,
    adWindow: 0, adResolved: false, adStartX: 0, adStartAngle: 0,
    dfWindow: 0,
    ieWindow: 0, ieResolved: false, ieDefendedAt: -99,
    rfWindow: 0, rfOppThrown: 0, rfCounted: false,
    dzWindow: 0, dzResolved: false, dzX: 0,
    cwWindow: 0, cwResolved: false, cvLastType: null,
    ccWindow: 0, ccResolved: false, ccOppThrown: 0, ccDrewFire: false,
    dvLastMethod: null, dvRun: 0, dvPrevDefending: false,
    ceWindow: 0, ceResolved: false, ceStartX: 0,
    mmWindow: 0, mmResolved: false, mmLanded: false, mmX: 0,
    ftUnanswered: 0, ftWindow: 0, ftResolved: false, ftX: 0,
    pnWindow: 0, pnHit: false, pnLayers: 0, pnStartX: 0, pnStartAngle: 0,
    prevOppPunching: false, prevActing: false,
    caTick: 0, caGain: false, caHit: false,
    drWindow: 0, drHit: false, drSafe: false,
    pqWindow: 0, pqResolved: false,
    cmpTick: 0, cmpThrown: 0, cmpHit: false,
    ktTick: 0, ktOppThrown: 0, ktOppX: 0,
    apIdle: 0, apWorked: false,
    spTick: 0, spThrown: 0, spDefend: 0, spLast: -1,
    laMiss: 0, laWindow: 0, laResolved: false, laX: 0, laType: null, laMethod: null,
    ihTypes: [], ihThrown: 0,
    ptWindow: 0,
    heOppType: null, heRun: 0, heWindow: 0, heResolved: false,
    taWindow: 0, taHit: false,
    idWindow: 0, idResolved: false, idX: 0, idType: null, idMethod: null,
    cmWindow: 0, cmHit: false,
    evWindow: 0, evTook: false, evLanded: false, evHit: false,
    ipWindow: 0, ipResolved: false,
    rgWindow: 0,
    tcTick: 0, tcOurs: 0, tcTheirs: 0, tcPrevOurs: 0, tcPrevTheirs: 0, tcHave: false,
    momMineRun: 0, momOppRun: 0, momWindow: 0, momMine: false, momResolved: false,
    rpAdv: 0, rpHit: false,
    raWindow: 0, raResolved: false, raArmed: false,
    reWindow: 0, reResolved: false,
    awWindow: 0, awFollow: 0, awHit: false, awX: 0,
    relIn: false, relWindow: 0, relResolved: false, relHit: false,
    stWindow: 0, stResolved: false, stSelfX: 0,
    adoWindow: 0, adoResolved: false, adoAngle: 0, adoOppAngle: 0,
    lhWindow: 0, lhOppThrown: 0, lhHit: false,
    riWindow: 0, riResolved: false, riOppDir: 0,
    biWindow: 0, biResolved: false, biX: 0,
    papWindow: 0, papResolved: false, papX: 0, papAngle: 0,
    fpWindow: 0, fpResolved: false, fpOppX: 0, fpOppGuard: false,
    xcActive: false, xcWindow: 0, xcEntry: false, xcAttack: false, xcTrans: false, xcExit: false,
    ctPrev: null, ctGap: 0,
    erWindow: 0, erResolved: false, erArmed: false,
  };
}

export function newObserver(fundKey = ""): FightObserver {
  return { a: newCorner(), b: newCorner(), elapsed: 0, fundKey };
}

/** Situations kept from a single bout. A bout is a minute long, so this is a
 *  ceiling against a runaway rather than a meaningful limit. */
const MAX_BOUT_SITUATIONS = 60;

/**
 * Score one corner for the tick, and when the fundamental under test is
 * executed, remember the situation it was executed in.
 *
 * The situation is read just after the tick that scored the success. The
 * trailing windows are seconds long, so a tick either side is noise — what
 * matters is that recording and fight-time reading go through the same tracker
 * and therefore see the same shape of situation.
 */
function captureCorner(
  obs: FightObserver, o: CornerObs,
  self: FighterState, opp: FighterState, dt: number, cx: number, ctx: CornerCtx,
) {
  o.tracker.update(dt, self, opp);
  const before = o.stats[obs.fundKey]?.successes ?? 0;
  observeCorner(o, self, opp, dt, obs.elapsed, cx, ctx);
  const after = o.stats[obs.fundKey]?.successes ?? 0;
  if (after > before && o.hits.length < MAX_BOUT_SITUATIONS) o.hits.push(o.tracker.read(self, opp));
}

const bump = (o: CornerObs, key: string, attempt: boolean, success: boolean) => {
  const s = o.stats[key];
  if (!s) return;
  if (attempt) s.attempts++;
  if (success) s.successes++;
};

const distOf = (f: FighterState, g: FighterState) => Math.abs(f.x - g.x);
const energy = (f: FighterState) => (f.maxStamina > 0 ? f.stamina / f.maxStamina : 0);
const guarding = (f: FighterState) => f.blockTimer > 0 || f.guardBlend > 0.6;
const evading = (f: FighterState) => f.duckTimer > 0 || f.slipActive;
const isJab = (f: FighterState) => f.currentPunch === "jab";
const isStraight = (f: FighterState) => f.currentPunch === "jab" || f.currentPunch === "cross";

/**
 * Score one tick for one corner. Thresholds here are constants on purpose — see
 * the note at the top of the file.
 */
function observeCorner(o: CornerObs, self: FighterState, opp: FighterState, dt: number, elapsed: number, ringCx: number, ctx: CornerCtx) {
  const threw = self.punchesThrown - o.prevThrown;
  const landed = self.punchesLanded - o.prevLanded;
  const tookHit = opp.punchesLanded - o.prevOppLanded > 0;
  const dist = distOf(self, opp);
  const closing = dist < o.prevDist - 0.2;
  const backing = (self.x - o.prevX) * (opp.x - self.x) < -0.05;
  const oppAdvancing = closing && Math.abs(opp.x - o.prevOppX) > Math.abs(self.x - o.prevX);
  const tick = (w: number) => Math.max(0, w - dt);

  // --- 60 Opening Calibration: probing punches in the first quarter of the round.
  if (threw > 0 && elapsed < ROUND_SECONDS * 0.25) {
    bump(o, "opening_calibration", true, dist > 110 && guarding(opp) === false ? false : dist > 90);
  }

  // --- 61 Finish Discipline: sampled once a second while the opponent is hurt.
  if (energy(opp) < 0.30) {
    o.hurtTick += dt;
    if (guarding(self)) o.hurtGuard = true;
    o.hurtThrown += threw;
    if (tookHit) o.hurtHitTaken = true;
    if (o.hurtTick >= 1) {
      bump(o, "finish_discipline", true, o.hurtThrown >= 2 && o.hurtGuard && !o.hurtHitTaken);
      o.hurtTick = 0; o.hurtGuard = false; o.hurtThrown = 0; o.hurtHitTaken = false;
    }
  } else {
    o.hurtTick = 0; o.hurtGuard = false; o.hurtThrown = 0; o.hurtHitTaken = false;
  }

  // --- 62 Reset Jab: sampled once a second while resetting or running on empty.
  if (self.fatigue?.resetActive || energy(self) < 0.25) {
    o.resetTick += dt;
    if (threw > 0 && isJab(self) && dist > 100) o.resetJab = true;
    if (tookHit) o.resetHit = true;
    if (o.resetTick >= 1) {
      bump(o, "recovery_jab", true, o.resetJab && !o.resetHit);
      o.resetTick = 0; o.resetJab = false; o.resetHit = false;
    }
  } else {
    o.resetTick = 0; o.resetJab = false; o.resetHit = false;
  }

  // --- 63 Miss Reset: a thrown punch that did not land opens a recovery window.
  if (threw > 0 && landed === 0) {
    if (o.missWindow > 0 && !o.missResolved) bump(o, "miss_recovery", true, false);
    o.missWindow = 0.6;
    o.missResolved = false;
  } else if (o.missWindow > 0) {
    if (tookHit) {
      bump(o, "miss_recovery", true, false);
      o.missWindow = 0; o.missResolved = true;
    } else if (guarding(self) || evading(self) || self.fatigue?.resetActive || backing) {
      bump(o, "miss_recovery", true, true);
      o.missWindow = 0; o.missResolved = true;
    }
    o.missWindow = tick(o.missWindow);
    if (o.missWindow <= 0 && !o.missResolved) { bump(o, "miss_recovery", true, false); o.missResolved = true; }
  }

  // --- 64 Back-Foot Invitation: give ground to a coming opponent, then counter.
  if (oppAdvancing) {
    o.gaveGround += backing ? dt : 0;
    if (o.gaveGround > 0.4 && o.inviteWindow <= 0) { o.inviteWindow = 1.2; o.inviteResolved = false; }
  } else if (!oppAdvancing && o.inviteWindow <= 0) {
    o.gaveGround = 0;
  }
  if (o.inviteWindow > 0) {
    if (landed > 0 && !o.inviteResolved) {
      bump(o, "back_foot_invitation", true, true);
      o.inviteResolved = true; o.inviteWindow = 0; o.gaveGround = 0;
    } else {
      o.inviteWindow = tick(o.inviteWindow);
      if (o.inviteWindow <= 0 && !o.inviteResolved) {
        bump(o, "back_foot_invitation", true, false);
        o.gaveGround = 0;
      }
    }
  }

  // --- 65 Double-Jab Disruption: a second jab inside the gap after the first.
  if (threw > 0 && isJab(self)) {
    if (o.jabWindow > 0) {
      bump(o, "double_jab_disruption", true, landed > 0 || guarding(opp));
      o.jabWindow = 0;
    } else {
      o.jabWindow = 0.55;
    }
  } else if (o.jabWindow > 0) {
    o.jabWindow = tick(o.jabWindow);
    if (o.jabWindow <= 0) bump(o, "double_jab_disruption", true, false);
  }

  // --- 66 Check-Hook Intercept: catch the rusher before they smother.
  if (oppAdvancing && dist > 60 && dist < 130) {
    bump(o, "check_hook_intercept", true, landed > 0 && dist > 70);
  }

  // --- 67 Close-Miss Countering: evaded, still close, countered before recovery.
  if (evading(self) && opp.isPunching && o.evadeWindow <= 0) {
    o.evadeWindow = 0.7; o.evadeResolved = false;
  }
  if (o.evadeWindow > 0) {
    if (landed > 0 && dist < 120 && !o.evadeResolved) {
      bump(o, "close_miss_countering", true, true);
      o.evadeResolved = true; o.evadeWindow = 0;
    } else {
      o.evadeWindow = tick(o.evadeWindow);
      if (o.evadeWindow <= 0 && !o.evadeResolved) bump(o, "close_miss_countering", true, false);
    }
  }

  // --- 68 Lead-Hand Occupation: land while they are guarding, then land again.
  if (landed > 0 && guarding(opp)) {
    bump(o, "lead_hand_occupation", true, o.landWindow > 0);
  }

  // --- 69 Hand-Check Rhythm Disruption: feint at range and break their timing.
  if (self.isFeinting && dist > 90 && dist < 160 && o.checkWindow <= 0) {
    o.checkWindow = 0.8;
    o.oppLastThrow = opp.punchesThrown;
    bump(o, "hand_check_disruption", true, false);
  } else if (o.checkWindow > 0) {
    o.checkWindow = tick(o.checkWindow);
    if (o.checkWindow <= 0 && opp.punchesThrown === o.oppLastThrow && guarding(self)) {
      // Their rhythm broke and ours held: retro-credit the attempt just logged.
      o.stats.hand_check_disruption.successes++;
    }
  }

  // --- 70 Pull Counter: they commit to a straight, we pull, cross, then exit.
  if (opp.isPunching && isStraight(opp) && dist > 80 && o.pullWindow <= 0) {
    o.pullWindow = 0.9; o.pullResolved = false;
    bump(o, "pull_counter", true, false);
  } else if (o.pullWindow > 0) {
    if (!o.pullResolved && backing && landed > 0) {
      o.stats.pull_counter.successes++;
      o.pullResolved = true;
    }
    o.pullWindow = tick(o.pullWindow);
  }

  // --- 71 Attrition Targeting: body work that actually costs them stamina.
  if (landed > 0) {
    const body = !self.punchAimsHead;
    bump(o, "attrition_targeting", true, body && opp.stamina < o.landOppStamina);
    o.landWasBody = body;
    o.landOppStamina = opp.stamina;
    o.landOppX = opp.x;
    o.landWindow = 0.6;
  }

  // --- 72 Emergency Blocking: nowhere to go, so the guard has to hold.
  if (opp.isPunching && dist < 80) {
    if (o.blockWindow <= 0) {
      o.blockWindow = 0.5;
      bump(o, "emergency_blocking", true, false);
    }
    if (guarding(self) && !tookHit) o.stats.emergency_blocking.successes++;
  }
  o.blockWindow = tick(o.blockWindow);

  // --- 73 Forced Readjustment: the punch moved them off their spot.
  if (o.landWindow > 0) {
    o.landWindow = tick(o.landWindow);
    if (o.landWindow <= 0) {
      bump(o, "forced_readjustment", true, Math.abs(opp.x - o.landOppX) > 4);
    }
  }

  // --- 50/51/52 Feint work. One feint opens a window scored three ways: did it
  // draw a reaction, did it turn into a punch or a step, and had this fighter
  // banked real landed work recently enough for the feint to be believable.
  const feintStarted = self.isFeinting && !o.prevFeinting;
  const oppReacting = guarding(opp) || evading(opp);
  if (landed > 0) o.lastLandAt = elapsed;

  if (feintStarted && dist < 170) {
    o.feintWindow = 0.6;
    o.feintReacted = false;
    o.feintConverted = false;
    o.feintCredited = elapsed - o.lastLandAt < 4;
    o.feintStartX = self.x;
    // Only a reaction the feint actually caused counts, so remember whether they
    // were already busy defending when it went out.
    o.feintOppBusy = oppReacting;
    bump(o, "reaction_engineering", true, false);
    bump(o, "feint_conversion", true, false);
    if (o.feintCredited) bump(o, "feint_credibility", true, false);
  } else if (o.feintWindow > 0) {
    if (!o.feintReacted && oppReacting && !o.feintOppBusy) {
      o.stats.reaction_engineering.successes++;
      if (o.feintCredited) o.stats.feint_credibility.successes++;
      o.feintReacted = true;
    }
    if (!o.feintConverted && (threw > 0 || Math.abs(self.x - o.feintStartX) > 6)) {
      o.stats.feint_conversion.successes++;
      o.feintConverted = true;
    }
    o.feintWindow = tick(o.feintWindow);
  }

  // --- 53 Misdirection: a pattern has to exist before breaking it means anything.
  if (threw > 0) {
    const type = self.currentPunch ?? null;
    const head = self.punchAimsHead;
    const same = type === o.lastPunchType && head === o.lastAimHead;
    if (o.sameTypeRun >= 2 && !same) {
      bump(o, "misdirection", true, landed > 0);
      o.sameTypeRun = 1;
    } else if (same) {
      o.sameTypeRun++;
      if (o.sameTypeRun > 4) {
        // Ran on without ever breaking it — the chance came and went.
        bump(o, "misdirection", true, false);
        o.sameTypeRun = 1;
      }
    } else {
      o.sameTypeRun = 1;
    }
    o.lastPunchType = type;
    o.lastAimHead = head;
  }

  // --- 54 Trap Engineering: show the opening, then punish what comes through it.
  if (!guarding(self) && self.guardBlend < 0.35 && dist < 140 && opp.isPunching && o.trapWindow <= 0) {
    o.trapWindow = 0.8;
    o.trapResolved = false;
    bump(o, "trap_engineering", true, false);
  } else if (o.trapWindow > 0) {
    if (!o.trapResolved && landed > 0 && !tookHit) {
      o.stats.trap_engineering.successes++;
      o.trapResolved = true;
    }
    if (tookHit) o.trapResolved = true; // the bait simply got them hit
    o.trapWindow = tick(o.trapWindow);
  }

  // --- 55 Throwaway Setup: a jab spent on attention, cashed by the real punch.
  if (threw > 0 && isJab(self) && landed === 0) {
    o.throwWindow = 0.8;
    o.throwResolved = false;
    bump(o, "throwaway_setup", true, false);
  } else if (o.throwWindow > 0) {
    if (!o.throwResolved && landed > 0 && !isJab(self)) {
      o.stats.throwaway_setup.successes++;
      o.throwResolved = true;
    }
    o.throwWindow = tick(o.throwWindow);
  }

  // --- 56/57 Chains. A second punch inside the gap makes it a combination, which
  // is the chance for both a three-layer finish and an angle change.
  if (threw > 0) {
    if (o.chainGap > 0) {
      o.chainCount++;
      if (o.chainCount === 2) {
        bump(o, "setup_distraction_finish", true, false);
        bump(o, "angular_combination_chaining", true, false);
      }
      if (o.chainCount >= 3 && landed > 0 && !o.chainScored) {
        o.stats.setup_distraction_finish.successes++;
        o.chainScored = true;
      }
    } else {
      o.chainCount = 1;
      o.chainScored = false;
      o.chainMoved = false;
      o.chainStartX = self.x;
      o.chainStartAngle = self.facingAngle;
    }
    o.chainGap = 0.7;
  } else if (o.chainGap > 0) {
    o.chainGap = tick(o.chainGap);
    if (o.chainGap <= 0) {
      if (o.chainCount >= 2 && o.chainMoved) o.stats.angular_combination_chaining.successes++;
      o.chainCount = 0;
    }
  }
  if (o.chainCount >= 2 &&
      (Math.abs(self.x - o.chainStartX) > 10 || Math.abs(self.facingAngle - o.chainStartAngle) > 0.12)) {
    o.chainMoved = true;
  }

  // --- 58 Layered Entry: the trip from outside to punching range, graded on what
  // it cost and whether anything came of it.
  if (!o.entryActive && o.entryWindow <= 0 && dist > 150) {
    o.entryActive = true;
    o.entryFeint = false;
    o.entryHurt = false;
  }
  if (o.entryActive) {
    if (self.isFeinting || (threw > 0 && isJab(self))) o.entryFeint = true;
    if (tookHit) o.entryHurt = true;
    if (dist < 105) {
      o.entryActive = false;
      o.entryWindow = 1.0;
      o.entryScored = false;
      bump(o, "layered_entry", true, false);
    }
  } else if (o.entryWindow > 0) {
    if (!o.entryScored && landed > 0 && o.entryFeint && !o.entryHurt) {
      o.stats.layered_entry.successes++;
      o.entryScored = true;
    }
    o.entryWindow = tick(o.entryWindow);
  }

  // --- 59 Rhythm Variability: the spread of the gaps between punches, sampled
  // every three seconds. A metronome fails this however busy it is.
  if (threw > 0) {
    if (o.lastPunchAt > 0) {
      const gap = elapsed - o.lastPunchAt;
      if (gap > 0.05 && gap < 6) {
        o.gaps.push(gap);
        if (o.gaps.length > 8) o.gaps.shift();
      }
    }
    o.lastPunchAt = elapsed;
  }
  o.tempoTick += dt;
  if (o.tempoTick >= 3) {
    o.tempoTick = 0;
    if (o.gaps.length >= 3) {
      const lo = Math.min(...o.gaps);
      const hi = Math.max(...o.gaps);
      bump(o, "rhythm_variability", true, hi > lo * 1.8);
      o.gaps = [];
    }
  }

  // ------------------------------------------------------ Tier 5 (37 - 49)
  // Defensive and counterpunching architecture. Same handful of fighter fields
  // as everything above, same fixed thresholds.
  const oppThrew = opp.punchesThrown - o.prevOppThrown > 0;
  const defending = guarding(self) || evading(self);
  const movedFrom = (from: number, by: number) => Math.abs(self.x - from) > by;
  const turnedFrom = (from: number, by: number) => Math.abs(self.facingAngle - from) > by;

  // --- 37 Active Defense: cover that also moves, turns or answers.
  if (defending && opp.isPunching && o.adWindow <= 0) {
    o.adWindow = 0.7; o.adResolved = false;
    o.adStartX = self.x; o.adStartAngle = self.facingAngle;
    bump(o, "active_defense", true, false);
  } else if (o.adWindow > 0) {
    if (!o.adResolved && (threw > 0 || movedFrom(o.adStartX, 6) || turnedFrom(o.adStartAngle, 0.1))) {
      o.stats.active_defense.successes++;
      o.adResolved = true;
    }
    o.adWindow = tick(o.adWindow);
  }

  // --- 38 Distance-First Defense: range should be doing the work first.
  if (oppThrew && o.dfWindow <= 0) {
    o.dfWindow = 0.5;
    bump(o, "distance_first_defense", true, dist > 120 || (defending && !tookHit));
  }
  o.dfWindow = tick(o.dfWindow);

  // --- 39 Integrated Evasion: defense either side of the punch, not after it.
  if (defending) o.ieDefendedAt = elapsed;
  if (threw > 0) {
    // Defence in the half second before the punch already counts as integrated.
    const before = elapsed - o.ieDefendedAt < 0.5;
    o.ieWindow = 0.5;
    o.ieResolved = before;
    bump(o, "integrated_evasion", true, before);
  } else if (o.ieWindow > 0) {
    if (!o.ieResolved && defending) {
      o.stats.integrated_evasion.successes++;
      o.ieResolved = true;
    }
    o.ieWindow = tick(o.ieWindow);
  }

  // --- 40 Return-Fire Expectation: only gradeable once they actually come back.
  if (threw > 0) {
    o.rfWindow = 0.8; o.rfOppThrown = opp.punchesThrown; o.rfCounted = false;
  } else if (o.rfWindow > 0) {
    if (!o.rfCounted && opp.punchesThrown > o.rfOppThrown) {
      bump(o, "return_fire_expectation", true, !tookHit && (defending || backing));
      o.rfCounted = true;
    }
    o.rfWindow = tick(o.rfWindow);
  }

  // --- 41 Dead-Zone Avoidance: the spot you just punched from is the bad one.
  if (threw > 0 && dist < 140) {
    o.dzWindow = 0.7; o.dzResolved = false; o.dzX = self.x;
    bump(o, "dead_zone_avoidance", true, false);
  } else if (o.dzWindow > 0) {
    if (!o.dzResolved && (movedFrom(o.dzX, 8) || defending)) {
      o.stats.dead_zone_avoidance.successes++;
      o.dzResolved = true;
    }
    o.dzWindow = tick(o.dzWindow);
  }

  // --- 42 Counter Window Recognition, and 45 Counter Variation on the way out.
  if (oppThrew && o.cwWindow <= 0) {
    o.cwWindow = 0.5; o.cwResolved = false;
    bump(o, "counter_window_recognition", true, false);
  } else if (o.cwWindow > 0) {
    if (!o.cwResolved && landed > 0) {
      o.stats.counter_window_recognition.successes++;
      o.cwResolved = true;
      const type = self.currentPunch ?? null;
      bump(o, "counter_variation", true, o.cvLastType !== null && type !== o.cvLastType);
      o.cvLastType = type;
    }
    o.cwWindow = tick(o.cwWindow);
  }

  // --- 43 Counter Window Creation: bait, draw the punch, then land.
  if (feintStarted && dist < 160 && o.ccWindow <= 0) {
    o.ccWindow = 1.1; o.ccResolved = false; o.ccDrewFire = false;
    o.ccOppThrown = opp.punchesThrown;
    bump(o, "counter_window_creation", true, false);
  } else if (o.ccWindow > 0) {
    if (opp.punchesThrown > o.ccOppThrown) o.ccDrewFire = true;
    if (!o.ccResolved && o.ccDrewFire && landed > 0) {
      o.stats.counter_window_creation.successes++;
      o.ccResolved = true;
    }
    o.ccWindow = tick(o.ccWindow);
  }

  // --- 44 Defensive Variation: graded on entering a defensive action, so a long
  // hold counts once rather than once per tick.
  const method = evading(self) ? "evade" : guarding(self) ? "guard" : null;
  if (method !== null && !o.dvPrevDefending) {
    if (method === o.dvLastMethod) {
      o.dvRun++;
      if (o.dvRun >= 4) { bump(o, "defensive_variation", true, false); o.dvRun = 1; }
    } else {
      if (o.dvRun >= 2) bump(o, "defensive_variation", true, true);
      o.dvRun = 1;
      o.dvLastMethod = method;
    }
  }
  o.dvPrevDefending = method !== null;

  // --- 46 Commitment Evasion: move while they are committed to something.
  if ((opp.isPunching || oppAdvancing) && o.ceWindow <= 0) {
    o.ceWindow = 0.5; o.ceResolved = false; o.ceStartX = self.x;
    bump(o, "commitment_evasion", true, false);
  } else if (o.ceWindow > 0) {
    if (!o.ceResolved && (movedFrom(o.ceStartX, 7) || evading(self))) {
      o.stats.commitment_evasion.successes++;
      o.ceResolved = true;
    }
    o.ceWindow = tick(o.ceWindow);
  }

  // --- 47 Make-Miss-Pay-Exit: three stages, and the exit is measured from where
  // the counter landed rather than from where the slip started.
  if (evading(self) && opp.isPunching && o.mmWindow <= 0) {
    o.mmWindow = 1.3; o.mmResolved = false; o.mmLanded = false; o.mmX = self.x;
    bump(o, "make_miss_pay_exit", true, false);
  } else if (o.mmWindow > 0) {
    if (!o.mmLanded && landed > 0) {
      o.mmLanded = true; o.mmX = self.x;
    } else if (o.mmLanded && !o.mmResolved && (movedFrom(o.mmX, 8) || guarding(self))) {
      o.stats.make_miss_pay_exit.successes++;
      o.mmResolved = true;
    }
    o.mmWindow = tick(o.mmWindow);
  }

  // --- 48 Front-Time Limit: two taken with nothing sent back is the evidence.
  if (tookHit) o.ftUnanswered++;
  if (threw > 0) o.ftUnanswered = 0;
  if (o.ftUnanswered >= 2 && o.ftWindow <= 0) {
    o.ftWindow = 1.2; o.ftResolved = false; o.ftX = self.x; o.ftUnanswered = 0;
    bump(o, "front_time_limit", true, false);
  } else if (o.ftWindow > 0) {
    if (!o.ftResolved && (threw > 0 || movedFrom(o.ftX, 12))) {
      o.stats.front_time_limit.successes++;
      o.ftResolved = true;
    }
    o.ftWindow = tick(o.ftWindow);
  }

  // --- 49 Punch Neutralization: not landing is not enough, it has to be more
  // than one layer doing it. Graded at the end of the window.
  if (oppThrew && dist < 150 && o.pnWindow <= 0) {
    o.pnWindow = 0.6; o.pnHit = false; o.pnLayers = 0;
    o.pnStartX = self.x; o.pnStartAngle = self.facingAngle;
    bump(o, "punch_neutralization", true, false);
  } else if (o.pnWindow > 0) {
    if (tookHit) o.pnHit = true;
    let layers = 0;
    if (movedFrom(o.pnStartX, 6)) layers++;
    if (turnedFrom(o.pnStartAngle, 0.1)) layers++;
    if (defending) layers++;
    if (layers > o.pnLayers) o.pnLayers = layers;
    o.pnWindow = tick(o.pnWindow);
    if (o.pnWindow <= 0 && !o.pnHit && o.pnLayers >= 2) {
      o.stats.punch_neutralization.successes++;
    }
  }

  // ------------------------------------------------------ Tier 1 - 4 (1 - 36)
  // Philosophy, prediction, strategy and exchange structure. Written after the
  // Tier 5 block rather than before it so it can reuse the locals declared
  // there (`oppThrew`, `defending`, `method`, `movedFrom`, `turnedFrom`).
  // Scoring order within a tick carries no meaning; display order is the id.
  const advancing = (self.x - o.prevX) * (opp.x - self.x) > 0.05;
  const oppPunchStart = opp.isPunching && !o.prevOppPunching;
  const oppDx = opp.x - o.prevOppX;

  // --- 1 Continuous Advantage: sampled every second, no neutral seconds.
  if (landed > 0 || threw > 0 || advancing) o.caGain = true;
  if (tookHit) o.caHit = true;
  o.caTick += dt;
  if (o.caTick >= 1) {
    bump(o, "continuous_advantage", true, o.caGain && !o.caHit);
    o.caTick = 0; o.caGain = false; o.caHit = false;
  }

  // --- 2 Defensive Responsibility: offense must not open the door.
  if (threw > 0 && o.drWindow <= 0) {
    o.drWindow = 0.7; o.drHit = false; o.drSafe = false;
    bump(o, "defensive_responsibility", true, false);
  } else if (o.drWindow > 0) {
    if (tookHit) o.drHit = true;
    if (guarding(self) || backing || dist > 130) o.drSafe = true;
    o.drWindow = tick(o.drWindow);
    if (o.drWindow <= 0 && o.drSafe && !o.drHit) o.stats.defensive_responsibility.successes++;
  }

  // --- 3 Decision Quality Under Pressure: acting while tired or under fire.
  if ((energy(self) < 0.35 || opp.isPunching) && threw > 0 && o.pqWindow <= 0) {
    o.pqWindow = 0.6; o.pqResolved = false;
    bump(o, "pressure_decision_quality", true, false);
  } else if (o.pqWindow > 0) {
    if (!o.pqResolved && (landed > 0 || defending)) {
      o.stats.pressure_decision_quality.successes++;
      o.pqResolved = true;
    }
    o.pqWindow = tick(o.pqWindow);
  }

  // --- 4 Combat Composure: busy without spraying.
  o.cmpTick += dt; o.cmpThrown += threw;
  if (tookHit) o.cmpHit = true;
  if (o.cmpTick >= 1) {
    bump(o, "combat_composure", true, o.cmpThrown >= 1 && o.cmpThrown <= 4 && !o.cmpHit);
    o.cmpTick = 0; o.cmpThrown = 0; o.cmpHit = false;
  }

  // --- 5 Constraint Control: their options should shrink inside our range.
  if (dist < 150) {
    if (o.ktTick <= 0) { o.ktOppThrown = opp.punchesThrown; o.ktOppX = opp.x; }
    o.ktTick += dt;
    if (o.ktTick >= 1) {
      const stalled = opp.punchesThrown === o.ktOppThrown;
      const pinned = Math.abs(opp.x - o.ktOppX) < 18;
      bump(o, "constraint_control", true, stalled || pinned);
      o.ktTick = 0;
    }
  } else o.ktTick = 0;

  // --- 6 Active Patience: a wait only counts if it was worked, and it has to
  // end in a punch. Standing off for three seconds is the failure case.
  if (threw > 0) {
    if (o.apIdle >= 0.8) bump(o, "active_patience", true, o.apWorked);
    o.apIdle = 0; o.apWorked = false;
  } else {
    o.apIdle += dt;
    if (self.isFeinting || advancing || backing || defending) o.apWorked = true;
    if (o.apIdle >= 3) {
      bump(o, "active_patience", true, false);
      o.apIdle = 0; o.apWorked = false;
    }
  }

  // --- 7 Style Plasticity: attack-versus-defense balance, block against block.
  o.spTick += dt; o.spThrown += threw;
  if (defending) o.spDefend += dt;
  if (o.spTick >= 15) {
    const share = o.spThrown / Math.max(1, o.spThrown + o.spDefend);
    if (o.spLast >= 0) bump(o, "style_plasticity", true, Math.abs(share - o.spLast) > 0.12);
    o.spLast = share;
    o.spTick = 0; o.spThrown = 0; o.spDefend = 0;
  }

  // --- 8 Layered Adaptation: when it stops working, change more than one thing.
  if (landed > 0) o.laMiss = 0;
  else if ((threw > 0 && landed === 0) || tookHit) o.laMiss++;
  if (o.laMiss >= 3 && o.laWindow <= 0) {
    o.laWindow = 1.5; o.laResolved = false; o.laMiss = 0;
    o.laX = self.x; o.laType = self.currentPunch ?? o.lastPunchType; o.laMethod = method;
    bump(o, "layered_adaptation", true, false);
  } else if (o.laWindow > 0) {
    let layers = 0;
    if (movedFrom(o.laX, 25)) layers++;
    if (self.currentPunch != null && self.currentPunch !== o.laType) layers++;
    if (method !== null && method !== o.laMethod) layers++;
    if (!o.laResolved && layers >= 2) {
      o.stats.layered_adaptation.successes++;
      o.laResolved = true;
    }
    o.laWindow = tick(o.laWindow);
  }

  // --- 9 Information Harvesting: the early work has to be varied to reveal much.
  if (threw > 0 && elapsed < ROUND_SECONDS * 0.33) {
    const t = self.currentPunch ?? "?";
    if (!o.ihTypes.includes(t)) o.ihTypes.push(t);
    o.ihThrown++;
    if (o.ihThrown >= 4) {
      bump(o, "information_harvesting", true, o.ihTypes.length >= 3);
      o.ihThrown = 0; o.ihTypes = [];
    }
  }

  // --- 10 Predictive Timing: graded at the instant they commit, so being
  // already in motion is the whole test. Reacting afterwards is a different
  // fundamental (42) and is not credited here.
  if (oppPunchStart && o.ptWindow <= 0) {
    o.ptWindow = 0.45;
    bump(o, "predictive_timing", true, defending || threw > 0 || backing);
  }
  o.ptWindow = tick(o.ptWindow);

  // --- 11 Habit Exploitation: they repeated themselves, make it cost.
  if (oppThrew) {
    const t = opp.currentPunch ?? "?";
    if (t === o.heOppType) o.heRun++;
    else { o.heRun = 1; o.heOppType = t; }
    if (o.heRun >= 2 && o.heWindow <= 0) {
      o.heWindow = 0.8; o.heResolved = false;
      bump(o, "habit_exploitation", true, false);
    }
  }
  if (o.heWindow > 0) {
    if (!o.heResolved && (landed > 0 || (evading(self) && !tookHit))) {
      o.stats.habit_exploitation.successes++;
      o.heResolved = true;
    }
    o.heWindow = tick(o.heWindow);
  }

  // --- 12 Threat Assumption: an open opponent is a question, not a gift. Taking
  // it and declining it both pass; what fails is being caught either way.
  if (dist < 140 && !guarding(opp) && !opp.isPunching && o.taWindow <= 0) {
    o.taWindow = 0.9; o.taHit = false;
    bump(o, "threat_assumption", true, false);
  } else if (o.taWindow > 0) {
    if (tookHit) o.taHit = true;
    o.taWindow = tick(o.taWindow);
    if (o.taWindow <= 0 && !o.taHit) o.stats.threat_assumption.successes++;
  }

  // --- 13 Impact Diagnosis: getting hit has to change something.
  if (tookHit && o.idWindow <= 0) {
    o.idWindow = 1.5; o.idResolved = false;
    o.idX = self.x; o.idMethod = method; o.idType = self.currentPunch ?? o.lastPunchType;
    bump(o, "impact_diagnosis", true, false);
  } else if (o.idWindow > 0) {
    const changed = movedFrom(o.idX, 20)
      || (method !== null && method !== o.idMethod)
      || (self.currentPunch != null && self.currentPunch !== o.idType);
    if (!o.idResolved && changed) {
      o.stats.impact_diagnosis.successes++;
      o.idResolved = true;
    }
    o.idWindow = tick(o.idWindow);
  }

  // --- 14 Defense Vulnerability Modeling: hit what their shape gives up — the
  // body against a high guard, the head against a duck.
  if (threw > 0 && (guarding(opp) || evading(opp))) {
    bump(o, "defense_vulnerability_model", true,
      evading(opp) ? self.punchAimsHead : !self.punchAimsHead);
  }

  // --- 15 Counter-Threat Mapping: throwing close invites a specific answer.
  if (threw > 0 && dist < 120 && o.cmWindow <= 0) {
    o.cmWindow = 0.9; o.cmHit = false;
    bump(o, "counter_threat_mapping", true, false);
  } else if (o.cmWindow > 0) {
    if (tookHit) o.cmHit = true;
    o.cmWindow = tick(o.cmWindow);
    if (o.cmWindow <= 0 && !o.cmHit) o.stats.counter_threat_mapping.successes++;
  }

  // --- 16 Risk-Reward Counter Selection: taking a counter and missing is worse
  // than passing on it, so declining cleanly scores and a wild answer does not.
  if (oppThrew && !tookHit && dist < 150 && o.evWindow <= 0) {
    o.evWindow = 0.7; o.evTook = false; o.evLanded = false; o.evHit = false;
    bump(o, "counter_expected_value", true, false);
  } else if (o.evWindow > 0) {
    if (threw > 0) o.evTook = true;
    if (landed > 0) o.evLanded = true;
    if (tookHit) o.evHit = true;
    o.evWindow = tick(o.evWindow);
    if (o.evWindow <= 0 && (o.evTook ? o.evLanded && !o.evHit : !o.evHit)) {
      o.stats.counter_expected_value.successes++;
    }
  }

  // --- 17 Initiative Priority: out of a neutral moment, who goes first.
  if (!self.isPunching && !opp.isPunching && !defending && dist < 160 && o.ipWindow <= 0) {
    o.ipWindow = 1.0; o.ipResolved = false;
    bump(o, "initiative_priority", true, false);
  } else if (o.ipWindow > 0) {
    if (!o.ipResolved) {
      if (threw > 0 || self.isFeinting) {
        o.stats.initiative_priority.successes++;
        o.ipResolved = true;
      } else if (opp.isPunching || oppThrew) o.ipResolved = true;
    }
    o.ipWindow = tick(o.ipWindow);
  }

  // --- 18 Ring Generalship: an exchange on our terms — our range, or our ground.
  if ((threw > 0 || oppThrew) && o.rgWindow <= 0) {
    o.rgWindow = 1.2;
    const centre = Math.abs(self.x - ringCx) < Math.abs(opp.x - ringCx);
    bump(o, "ring_generalship", true, (advancing && dist < 130) || centre);
  }
  o.rgWindow = tick(o.rgWindow);

  // --- 19 Tempo Control: our rate should move independently of theirs.
  o.tcTick += dt; o.tcOurs += threw; if (oppThrew) o.tcTheirs++;
  if (o.tcTick >= 2) {
    if (o.tcHave) {
      const dOurs = o.tcOurs - o.tcPrevOurs;
      const dTheirs = o.tcTheirs - o.tcPrevTheirs;
      bump(o, "tempo_control", true, Math.abs(dOurs) >= 1 && dOurs * dTheirs <= 0);
    }
    o.tcPrevOurs = o.tcOurs; o.tcPrevTheirs = o.tcTheirs; o.tcHave = true;
    o.tcOurs = 0; o.tcTheirs = 0; o.tcTick = 0;
  }

  // --- 20 Momentum Management: extend ours, break theirs.
  if (landed > 0) { o.momMineRun += landed; o.momOppRun = 0; }
  if (tookHit) { o.momOppRun++; o.momMineRun = 0; }
  if (o.momWindow <= 0 && (o.momMineRun >= 2 || o.momOppRun >= 2)) {
    o.momMine = o.momMineRun >= 2;
    o.momWindow = 1.2; o.momResolved = false;
    o.momMineRun = 0; o.momOppRun = 0;
    bump(o, "momentum_management", true, false);
  } else if (o.momWindow > 0) {
    const held = o.momMine ? landed > 0 : (threw > 0 || defending || backing) && !tookHit;
    if (!o.momResolved && held) {
      o.stats.momentum_management.successes++;
      o.momResolved = true;
    }
    o.momWindow = tick(o.momWindow);
  }

  // --- 21 Pressure With Responsibility: ground taken without shipping anything.
  if (advancing && dist < 200) {
    o.rpAdv += dt;
    if (tookHit) o.rpHit = true;
    if (o.rpAdv >= 1) {
      bump(o, "responsible_pressure", true, !o.rpHit && (guarding(self) || dist > 90));
      o.rpAdv = 0; o.rpHit = false;
    }
  } else if (dist > 200) { o.rpAdv = 0; o.rpHit = false; }

  // --- 22 Reset Advantage: after an exchange, who is live again first.
  const exchangeLive = self.isPunching || opp.isPunching;
  if (exchangeLive) o.raArmed = true;
  if (!exchangeLive && o.raArmed && o.raWindow <= 0) {
    o.raArmed = false; o.raWindow = 1.0; o.raResolved = false;
    bump(o, "reset_advantage", true, false);
  } else if (o.raWindow > 0) {
    if (!o.raResolved) {
      const weSet = guarding(self) || threw > 0;
      const theySet = guarding(opp) || opp.isPunching;
      if (weSet && !theySet) {
        o.stats.reset_advantage.successes++;
        o.raResolved = true;
      } else if (theySet && !weSet) o.raResolved = true;
    }
    o.raWindow = tick(o.raWindow);
  }

  // --- 23 Reset Exploitation: the moment their punch ends is the moment to go.
  if (o.prevOppPunching && !opp.isPunching && dist < 160 && o.reWindow <= 0) {
    o.reWindow = 0.8; o.reResolved = false;
    bump(o, "reset_exploitation", true, false);
  } else if (o.reWindow > 0) {
    if (!o.reResolved && landed > 0) {
      o.stats.reset_exploitation.successes++;
      o.reResolved = true;
    }
    o.reWindow = tick(o.reWindow);
  }

  // --- 24 Advantage Window: follow the landing up, then be gone.
  if (landed > 0 && o.awWindow <= 0) {
    o.awWindow = 1.4; o.awFollow = 0; o.awHit = false; o.awX = self.x;
    bump(o, "advantage_window", true, false);
  } else if (o.awWindow > 0) {
    o.awFollow += threw;
    if (tookHit) o.awHit = true;
    o.awWindow = tick(o.awWindow);
    if (o.awWindow <= 0 && o.awFollow >= 1 && !o.awHit && (movedFrom(o.awX, 10) || dist > 130)) {
      o.stats.advantage_window.successes++;
    }
  }

  // --- 25 Range Elasticity: crossing in is the chance, getting back out clean
  // is the test. Staying inside until the window lapses fails it.
  const inRange = dist < 120;
  if (inRange && !o.relIn) {
    o.relIn = true;
    o.relWindow = 1.6; o.relResolved = false; o.relHit = false;
    bump(o, "range_elasticity", true, false);
  }
  if (!inRange) o.relIn = false;
  if (o.relWindow > 0) {
    if (tookHit) o.relHit = true;
    if (!o.relResolved && !inRange && !o.relHit) {
      o.stats.range_elasticity.successes++;
      o.relResolved = true;
    }
    o.relWindow = tick(o.relWindow);
  }

  // --- 26 Step Timing: our own displacement has to answer their step, so it is
  // measured on our x rather than on the gap, which their step moves anyway.
  if (Math.abs(oppDx) > 0.6 && o.stWindow <= 0) {
    o.stWindow = 0.4; o.stResolved = false; o.stSelfX = self.x;
    bump(o, "step_timing", true, false);
  } else if (o.stWindow > 0) {
    if (!o.stResolved && movedFrom(o.stSelfX, 8)) {
      o.stats.step_timing.successes++;
      o.stResolved = true;
    }
    o.stWindow = tick(o.stWindow);
  }

  // --- 27 Angle Dominance: we turned and they have not corrected for it.
  if (dist < 150 && o.adoWindow <= 0) {
    o.adoWindow = 0.8; o.adoResolved = false;
    o.adoAngle = self.facingAngle; o.adoOppAngle = opp.facingAngle;
    bump(o, "angle_dominance", true, false);
  } else if (o.adoWindow > 0) {
    const weTurned = Math.abs(self.facingAngle - o.adoAngle) > 0.12;
    const theyTurned = Math.abs(opp.facingAngle - o.adoOppAngle) > 0.12;
    if (!o.adoResolved && weTurned && !theyTurned) {
      o.stats.angle_dominance.successes++;
      o.adoResolved = true;
    }
    o.adoWindow = tick(o.adoWindow);
  }

  // --- 28 Lead-Hand Dominance: the jab should buy silence on their side.
  if (threw > 0 && isJab(self) && dist < 170 && o.lhWindow <= 0) {
    o.lhWindow = 0.9; o.lhOppThrown = opp.punchesThrown; o.lhHit = false;
    bump(o, "lead_hand_dominance", true, false);
  } else if (o.lhWindow > 0) {
    if (tookHit) o.lhHit = true;
    o.lhWindow = tick(o.lhWindow);
    if (o.lhWindow <= 0 && opp.punchesThrown === o.lhOppThrown && !o.lhHit) {
      o.stats.lead_hand_dominance.successes++;
    }
  }

  // --- 29 Ring Interception: gaining on them while going their way is cutting
  // them off; going their way and losing ground is following them.
  if (Math.abs(oppDx) > 0.5 && dist > 90 && o.riWindow <= 0) {
    o.riWindow = 0.6; o.riResolved = false; o.riOppDir = Math.sign(oppDx);
    bump(o, "ring_interception", true, false);
  } else if (o.riWindow > 0) {
    const ourDx = self.x - o.prevX;
    if (!o.riResolved && Math.sign(ourDx) === o.riOppDir && dist < o.prevDist) {
      o.stats.ring_interception.successes++;
      o.riResolved = true;
    }
    o.riWindow = tick(o.riWindow);
  }

  // --- 30 Balance Integrity: landing while able to carry straight on.
  if (landed > 0 && o.biWindow <= 0) {
    o.biWindow = 0.5; o.biResolved = false; o.biX = self.x;
    bump(o, "balance_integrity", true, false);
  } else if (o.biWindow > 0) {
    if (!o.biResolved && (threw > 0 || defending || movedFrom(o.biX, 5))) {
      o.stats.balance_integrity.successes++;
      o.biResolved = true;
    }
    o.biWindow = tick(o.biWindow);
  }

  // --- 31 Post-Action Positioning: where the action left us.
  const acting = self.isPunching || defending;
  if (o.prevActing && !acting && o.papWindow <= 0) {
    o.papWindow = 0.6; o.papResolved = false;
    o.papX = self.x; o.papAngle = self.facingAngle;
    bump(o, "post_action_positioning", true, false);
  } else if (o.papWindow > 0) {
    if (!o.papResolved && (dist > 130 || movedFrom(o.papX, 10) || turnedFrom(o.papAngle, 0.1))) {
      o.stats.post_action_positioning.successes++;
      o.papResolved = true;
    }
    o.papWindow = tick(o.papWindow);
  }
  o.prevActing = acting;

  // --- 32 Functional Punch Effect: a punch that missed can still have worked.
  if (threw > 0 && landed === 0 && o.fpWindow <= 0) {
    o.fpWindow = 0.7; o.fpResolved = false;
    o.fpOppX = opp.x; o.fpOppGuard = guarding(opp);
    bump(o, "functional_punch_effect", true, false);
  } else if (o.fpWindow > 0) {
    const movedThem = Math.abs(opp.x - o.fpOppX) > 12;
    const raisedGuard = !o.fpOppGuard && guarding(opp);
    if (!o.fpResolved && (movedThem || raisedGuard || landed > 0)) {
      o.stats.functional_punch_effect.successes++;
      o.fpResolved = true;
    }
    o.fpWindow = tick(o.fpWindow);
  }

  // --- 33 Positional Shot Selection: straight shots long, short shots short.
  if (threw > 0) {
    bump(o, "positional_shot_selection", true, dist > 110 ? isStraight(self) : !isStraight(self));
  }

  // --- 34 Exchange Cycle: entry, attack, transition, exit — all four or none.
  if (!o.xcActive && threw > 0) {
    o.xcActive = true; o.xcWindow = 2.0;
    o.xcEntry = closing || advancing;
    o.xcAttack = true; o.xcTrans = false; o.xcExit = false;
    bump(o, "exchange_cycle", true, false);
  } else if (o.xcActive) {
    if (defending) o.xcTrans = true;
    if (backing || dist > 140) o.xcExit = true;
    o.xcWindow = tick(o.xcWindow);
    if (o.xcWindow <= 0) {
      if (o.xcEntry && o.xcAttack && o.xcTrans && o.xcExit) o.stats.exchange_cycle.successes++;
      o.xcActive = false;
    }
  }

  // --- 35 Combat State Transition: graded on the change itself, and what it
  // costs is the neutral time sitting between the two states.
  const stateNow = self.isPunching ? "off" : defending ? "def" : null;
  if (stateNow === null) o.ctGap += dt;
  else {
    if (o.ctPrev !== null && stateNow !== o.ctPrev) {
      bump(o, "combat_state_transition", true, o.ctGap < 0.35);
    }
    o.ctPrev = stateNow; o.ctGap = 0;
  }

  // --- 36 Exit-to-Reentry: leaving is only half of it.
  if (threw > 0 && dist < 130) o.erArmed = true;
  if (o.erArmed && dist > 140 && o.erWindow <= 0) {
    o.erArmed = false; o.erWindow = 2.0; o.erResolved = false;
    bump(o, "exit_to_reentry", true, false);
  } else if (o.erWindow > 0) {
    if (!o.erResolved && dist < 120 && threw > 0) {
      o.stats.exit_to_reentry.successes++;
      o.erResolved = true;
    }
    o.erWindow = tick(o.erWindow);
  }

  // ------------------------------------------------------ Basics (74 - 94)
  // Beginner technique. Own-punch tests key off the punch-start edge; the four
  // defensive tests grade each incoming punch once, when it finishes.
  {
    const bs = o.bs ?? (o.bs = newBasicsObs());
    const myStart = self.isPunching && !bs.wasPunching;
    const myEnd = !self.isPunching && bs.wasPunching;
    const p = self.currentPunch;
    const isHook = (x: string | null) => x === "leftHook" || x === "rightHook";

    // 75 Hands Back Home: resolve the previous punch's recovery before a new one opens.
    if (bs.ownWindow > 0) {
      if (tookHit) bs.ownHit = true;
      bs.ownWindow = tick(bs.ownWindow);
      if ((bs.ownWindow <= 0 || myStart) && !bs.ownHit) o.stats.basics_hands_home.successes++;
      if (myStart) bs.ownWindow = 0;
    }
    if (myStart && p) {
      // 74 Punch From Balance: thrown with the target inside the punch's reach,
      // short of full stretch (the last 10% is where the lean over the knee is).
      const d2 = Math.hypot(self.x - opp.x, self.z - opp.z);
      bump(o, "basics_balanced_range", true, d2 <= getPunchReachPx(self, p) * 0.9);
      bump(o, "basics_hands_home", true, false);
      bs.ownWindow = 0.6; bs.ownHit = false;
      // 76 The 1-2.
      if (p === "cross" && bs.jabWindow > 0) { o.stats.basics_one_two.successes++; bs.jabWindow = 0; }
      if (p === "jab") { bump(o, "basics_one_two", true, false); bs.jabWindow = 0.45; }
      // 77 Hook off the right hand.
      if (isHook(p) && bs.crossWindow > 0) bs.hookThrown = true;
      if (p === "cross") { bump(o, "basics_hook_off_straight", true, false); bs.crossWindow = 0.7; bs.hookThrown = false; }
      // 78: a punch starting soon after the last one ended was mid-combo, not the end.
      if (bs.afterWindow > 0.3) bs.afterWindow = 0;
    }
    if (bs.crossWindow > 0) {
      if (bs.hookThrown && landed > 0 && isHook(p)) { o.stats.basics_hook_off_straight.successes++; bs.crossWindow = 0; }
      bs.crossWindow = tick(bs.crossWindow);
    }
    bs.jabWindow = tick(bs.jabWindow);

    // 78 Head Off the Centre Line: after the last punch, in range, move the head.
    if (myEnd && dist < 130) { bs.afterWindow = 0.6; bs.afterMoved = false; bs.afterHit = false; }
    if (bs.afterWindow > 0) {
      if (evading(self)) bs.afterMoved = true;
      if (tookHit) bs.afterHit = true;
      bs.afterWindow = tick(bs.afterWindow);
      if (bs.afterWindow <= 0) bump(o, "basics_head_off_line", true, bs.afterMoved && !bs.afterHit);
    }

    const rd = Math.hypot(self.x - opp.x, (self.z ?? 0) - (opp.z ?? 0));
    // The gap closing because the opponent walked in, not because this corner did.
    const myStep = Math.hypot(self.x - bs.prevX, (self.z ?? 0) - bs.prevZ);
    const oppStep = Math.hypot(opp.x - o.prevOppX, (opp.z ?? 0) - bs.prevOppZ);
    const advancingMe = myStep > oppStep && rd < bs.prevRd;

    // 85/86 Caught a punch with the guard: what comes back, and how fast.
    if (bs.blockedByMe < 0 || ctx.byMe < bs.blockedByMe) bs.blockedByMe = ctx.byMe;
    if (bs.blockedByOpp < 0 || ctx.byOpp < bs.blockedByOpp) bs.blockedByOpp = ctx.byOpp;
    const caught = ctx.byMe > bs.blockedByMe;
    const gotBlocked = ctx.byOpp > bs.blockedByOpp;
    bs.blockedByMe = ctx.byMe; bs.blockedByOpp = ctx.byOpp;
    const inNow = basicsPunchClass(opp) ?? bs.inCls;
    if (caught && inNow && bs.catchWindow <= 0) {
      bs.catchKind = inNow === "straight" ? "jab" : "power";
      bump(o, bs.catchKind === "jab" ? "basics_catch_return_jab" : "basics_catch_hook_fire_back", true, false);
      bs.catchWindow = bs.catchKind === "jab" ? 0.5 : 0.6;
    } else if (bs.catchWindow > 0) {
      if (myStart && p) {
        if (bs.catchKind === "jab" && p === "jab") { o.stats.basics_catch_return_jab.successes++; bs.catchWindow = 0; }
        else if (bs.catchKind === "power" && p !== "jab") { o.stats.basics_catch_hook_fire_back.successes++; bs.catchWindow = 0; }
      }
      bs.catchWindow = tick(bs.catchWindow);
    }

    // 88 Double Up the Hook: own hook blocked, the same again without eating one.
    if (gotBlocked && isHook(p) && bs.dhWindow <= 0) { bump(o, "basics_double_hook", true, false); bs.dhWindow = 0.7; bs.dhHit = false; }
    else if (bs.dhWindow > 0) {
      if (tookHit) bs.dhHit = true;
      if (myStart && isHook(p) && !bs.dhHit) { o.stats.basics_double_hook.successes++; bs.dhWindow = 0; }
      bs.dhWindow = tick(bs.dhWindow);
    }

    // 79-82 The incoming punch, graded by kind when it finishes.
    if (opp.isPunching && !o.prevOppPunching && dist < 150) {
      bs.inCls = basicsPunchClass(opp); bs.inHit = false; bs.inSlip = false; bs.inDuck = false;
    }
    if (bs.inCls) {
      if (tookHit) bs.inHit = true;
      if (self.slipActive) bs.inSlip = true;
      if (self.defenseState === "duck" || self.duckTimer > 0) bs.inDuck = true;
      if (!opp.isPunching) {
        const ok = !bs.inHit;
        if (bs.inCls === "straight") bump(o, "basics_slip_straight", true, ok && (bs.inSlip || bs.inDuck));
        else if (bs.inCls === "hook") bump(o, "basics_roll_hook", true, ok && bs.inDuck);
        else if (bs.inCls === "uppercut") bump(o, "basics_guard_uppercut", true, ok && !bs.inDuck);
        else bump(o, "basics_elbows_body", true, ok);
        // 83 Tight Defence, Quick Counter: an evasion that worked opens the counter.
        if (ok && (bs.inSlip || bs.inDuck)) { bump(o, "basics_tight_counter", true, false); bs.evadeWindow = 0.8; }
        // 87 Slip and Rip: a straight slipped clean opens the body shot.
        if (ok && bs.inCls === "straight" && (bs.inSlip || bs.inDuck)) { bump(o, "basics_slip_and_rip", true, false); bs.ripWindow = 0.8; }
        bs.inCls = null;
      }
    }
    if (bs.evadeWindow > 0) {
      if (landed > 0) { o.stats.basics_tight_counter.successes++; bs.evadeWindow = 0; }
      bs.evadeWindow = tick(bs.evadeWindow);
    }

    // 84 Body Hook Cut-Off: the opponent leaves at close range.
    const oppLeaving = dist < 120 && dist > o.prevDist + 0.3 && Math.abs(oppDx) > Math.abs(self.x - o.prevX);
    if (oppLeaving && bs.cutWindow <= 0) { bump(o, "basics_cutoff_body_hook", true, false); bs.cutWindow = 1.0; }
    if (bs.cutWindow > 0) {
      if (landed > 0 && isHook(p) && !self.punchAimsHead) { o.stats.basics_cutoff_body_hook.successes++; bs.cutWindow = 0; }
      bs.cutWindow = tick(bs.cutWindow);
    }

    // 85-94 measure range in the ring plane (x and z), not x alone.
    // 87 resolve: a body punch lands off the slip.
    if (bs.ripWindow > 0) {
      if (landed > 0 && !self.punchAimsHead) { o.stats.basics_slip_and_rip.successes++; bs.ripWindow = 0; }
      bs.ripWindow = tick(bs.ripWindow);
    }

    // 89 Jab and Get Out: a jab landed from mid range, then out of their reach.
    if (bs.exitWindow > 0) {
      if (tookHit) bs.exitHit = true;
      if (!bs.exitHit && rd > getPunchReachPx(opp, "jab")) { o.stats.basics_jab_and_exit.successes++; bs.exitWindow = 0; }
      bs.exitWindow = tick(bs.exitWindow);
    } else if (landed > 0 && p === "jab") {
      bump(o, "basics_jab_and_exit", true, false); bs.exitWindow = 0.6; bs.exitHit = false;
    }

    // 90 Inside Work and 94 Mix Head and Body, graded per punch thrown.
    if (myStart && p) {
      const body = !self.punchAimsHead;
      if (rd < BASICS_INSIDE_PX) bump(o, "basics_inside_work", true, body || p === "leftUppercut" || p === "rightUppercut");
      bs.levels.push(body); if (bs.levels.length > 4) bs.levels.shift();
      bs.levelCount++;
      if (bs.levelCount % 4 === 0) bump(o, "basics_mix_levels", true, bs.levels.includes(true) && bs.levels.includes(false));
    }

    // 91 Off the Ropes. The ring is a diamond in x/z; 1 is the ropes.
    const ropeNorm = (f: FighterState) =>
      Math.abs(f.x - ctx.cx) / ctx.halfW + Math.abs((f.z ?? ctx.cz) - ctx.cz) / ctx.halfH;
    const myRope = ropeNorm(self);
    const onRopes = myRope > 0.8 && ropeNorm(opp) < myRope && rd < 130;
    if (bs.ropeWindow > 0) {
      if (tookHit) bs.ropeHits++;
      if (myRope < 0.68 && bs.ropeHits < 2) { o.stats.basics_off_the_ropes.successes++; bs.ropeWindow = 0; }
      else bs.ropeWindow = tick(bs.ropeWindow);
    } else if (onRopes) {
      bump(o, "basics_off_the_ropes", true, false); bs.ropeWindow = 1.5; bs.ropeHits = 0;
    }

    // 92 Circle, Don't Back Up Straight: own movement split into straight away
    // from the opponent and across them, while being walked down.
    const sz = self.z ?? 0;
    if (bs.circleWindow > 0) {
      const mx = self.x - bs.prevX, mz = sz - bs.prevZ;
      const ax = self.x - opp.x, az = sz - (opp.z ?? 0);
      const al = Math.hypot(ax, az) || 1;
      const along = (mx * ax + mz * az) / al;
      bs.circleLat += Math.abs((mx * -az + mz * ax) / al);
      if (along > 0) bs.circleBack += along;
      bs.circleWindow = tick(bs.circleWindow);
      if (bs.circleWindow <= 0) bump(o, "basics_circle_off", true, bs.circleLat > bs.circleBack);
    } else if (rd >= BASICS_INSIDE_PX && rd < 160 && rd < bs.prevRd - 0.2 && !advancingMe) {
      bs.circleWindow = 0.6; bs.circleLat = 0; bs.circleBack = 0;
    }
    bs.prevX = self.x; bs.prevZ = sz; bs.prevRd = rd; bs.prevOppZ = opp.z ?? 0;

    // 93 Downstairs, Then Upstairs.
    if (bs.upWindow > 0) {
      if (landed > 0 && self.punchAimsHead) { o.stats.basics_body_then_head.successes++; bs.upWindow = 0; }
      bs.upWindow = tick(bs.upWindow);
    } else if (landed > 0 && !self.punchAimsHead) {
      bump(o, "basics_body_then_head", true, false); bs.upWindow = 1.0;
    }
    bs.wasPunching = self.isPunching;
  }

  o.prevOppPunching = opp.isPunching;
  o.prevThrown = self.punchesThrown;
  o.prevLanded = self.punchesLanded;
  o.prevOppLanded = opp.punchesLanded;
  o.prevOppThrown = opp.punchesThrown;
  o.prevDist = dist;
  o.prevX = self.x;
  o.prevOppX = opp.x;
  o.prevFeinting = self.isFeinting;
}

export function observeTick(obs: FightObserver, state: GameState, dt: number) {
  obs.elapsed += dt;
  const cx = (state.ringLeft + state.ringRight) / 2;
  captureCorner(obs, obs.a, state.player, state.enemy, dt, cx, ctxFor(state, state.player));
  captureCorner(obs, obs.b, state.enemy, state.player, dt, cx, ctxFor(state, state.enemy));
}

/**
 * Score the enemy corner only. Used when a human has taken over the player
 * corner: what the person at the keyboard does is not evidence about any seed,
 * so their side is never measured and never folded back into the population.
 */
export function observeAiTick(obs: FightObserver, state: GameState, dt: number) {
  obs.elapsed += dt;
  captureCorner(obs, obs.b, state.enemy, state.player, dt,
    (state.ringLeft + state.ringRight) / 2, ctxFor(state, state.enemy));
}

/**
 * Fold a sparring session's AI-side tallies into the seed that was fought.
 *
 * Only the fundamental counts move. Win, loss and bout count stay untouched: a
 * seed's record is its record against the other seeds under identical
 * conditions, and letting a human bout into it would make the standings
 * incomparable.
 */
export function foldAiObservations(seed: FundamentalSeed, obs: FightObserver) {
  creditSeed(seed, obs.b.stats);
}

// ---------------------------------------------------------------- bout runner

export type BoutOutcome = HeadlessOutcome;

export interface Bout {
  seedA: number;
  seedB: number;
  state: GameState;
  obs: FightObserver;
  ticks: number;
  done: boolean;
  /** 0 for corner A, 1 for corner B, null for a draw. */
  winner: 0 | 1 | null;
  outcome: BoutOutcome;
}

let boutRng = 1;
const nextSeed = () => (boutRng = (boutRng * 1103515245 + 12345) & 0x7fffffff);

/** Roster id for a seed, so its neural override is found and the champion brain
 *  redirect leaves it alone. */
export const seedRosterId = (seedId: number) => TRAINING_ROSTER_BASE + seedId;

export function createBout(seedA: FundamentalSeed, seedB: FundamentalSeed, level: number, fundKey: string): Bout {
  // Each seed's brain carries its real roster id, so its neural override is
  // found and the champion redirect leaves it alone.
  const state = startHeadlessBout(nextSeed(), level,
    { name: seedA.name, buildBrain: (arch, lv) => initAiBrain("champion", arch, lv, true, seedRosterId(seedA.id)) },
    { name: seedB.name, rosterId: seedRosterId(seedB.id), buildBrain: (arch, lv) => initAiBrain("champion", arch, lv, true, seedRosterId(seedB.id)) },
  );
  return { seedA: seedA.id, seedB: seedB.id, state, obs: newObserver(fundKey), ticks: 0, done: false, winner: null, outcome: "cards" };
}

/** Advance one bout by up to `maxTicks` engine steps. Returns ticks consumed. */
export function stepBout(bout: Bout, maxTicks: number): number {
  return stepHeadless(bout, maxTicks, (state, dt) => observeTick(bout.obs, state, dt));
}

// ------------------------------------------------------------------ the run

/**
 * One fixture. Non-negative values index the population; negative values are
 * the fixed corners of the learning layer: frozen past champions (the league)
 * and the two sides of the champion gate.
 */
export interface Pairing { a: number; b: number; }

/** League opponent k (0 = newest frozen champion). */
export const LEAGUE_SLOT = (k: number) => -1 - k;
export const CHAMP_SLOT = -100;
export const LAST_GOOD_SLOT = -101;
/** Seed ids (and so roster ids) for the fixed corners; well clear of the
 *  population's 0..n-1. */
const LEAGUE_SEED_ID = 500;
const CHAMP_SEED_ID = 600;
const LAST_GOOD_SEED_ID = 601;

function pseudoSeed(id: number, name: string, params: Record<string, number>): FundamentalSeed {
  return { id, name, gen: 0, params, stats: {}, lifetime: {}, wins: 0, losses: 0, bouts: 0, parents: null, salvaged: [] };
}

/** The fighter a fixture slot stands for, or null if the slot no longer exists. */
export function cornerFor(run: TrainingRun, slot: number): FundamentalSeed | null {
  if (slot >= 0) return run.population[slot] ?? null;
  if (slot === CHAMP_SLOT) return pseudoSeed(CHAMP_SEED_ID, "Champion", run.champion.params);
  if (slot === LAST_GOOD_SLOT) {
    return run.lastGood ? pseudoSeed(LAST_GOOD_SEED_ID, "Last passed champion", run.lastGood.params) : null;
  }
  const k = -1 - slot;
  const p = run.league?.[k];
  return p ? pseudoSeed(LEAGUE_SEED_ID + k, `League ${k + 1}`, p) : null;
}

export interface GenerationRecord {
  gen: number;
  /** Ids kept whole, best first. */
  survivors: number[];
  /** Ids thrown out and drawn again. */
  replaced: number[];
  standings: { id: number; name: string; wins: number; bouts: number; rate: number }[];
  salvage: Record<number, string[]>;
  /** The champion gate's verdict at this cut; absent when there was nothing to
   *  judge against yet. */
  gate?: GateDecision;
}

/**
 * A seed's tallies for the fundamental under test as its cycle opened.
 *
 * The observer scores all 73 fundamentals every tick regardless of which one is
 * being swept, and `seed.stats` runs cumulatively to the cut. Grading a cycle on
 * the raw total would therefore grade it on every cycle before it as well, so
 * the cycle's own figures are the difference against this.
 */
export interface CycleBase {
  attempts: number;
  successes: number;
}

/** One seed's showing on the fundamental its cycle tested. */
export interface CycleStat {
  attempts: number;
  successes: number;
  rate: number;
}

/** A closed fundamental cycle, and who took it. */
export interface FundCycleRecord {
  gen: number;
  /** 1-based position in the sweep. */
  index: number;
  fundKey: string;
  label: string;
  /** -1 when nobody executed the fundamental and the champion kept what it had. */
  winnerId: number;
  winnerName: string;
  rate: number;
  attempts: number;
  /** Remembered situations written for this fundamental. */
  situations: number;
  /** Whether the learner moved the champion's block, and by how much at most
   *  (share of a parameter's range). */
  stepped?: boolean;
  stepSize?: number;
  /** This fundamental's search width after the step. */
  sigma?: number;
}

export interface TrainingRun {
  population: FundamentalSeed[];
  gen: number;
  /** Index into FUNDAMENTALS of the fundamental under test. */
  fundIndex: number;
  schedule: Pairing[];
  cursor: number;
  /** Bouts finished in the current cycle. */
  completed: number;
  level: number;
  meetingsPerFundamental: number;
  history: GenerationRecord[];
  /**
   * The parameter set handed to the Champion AI. It starts at the shipped
   * defaults and each closed cycle replaces exactly one fundamental's block of
   * it, so a full sweep assembles a champion out of 73 separate winners.
   */
  champion: FundamentalSeed;
  /** Seed id -> where its tallies stood when this cycle opened. */
  cycleBase: Record<number, CycleBase>;
  /** Closed cycles, newest last. */
  cycleLog: FundCycleRecord[];
  /**
   * Situation-keyed memory handed to ordinary play alongside the champion.
   * One list per fundamental, rebuilt from that fundamental's winner when its
   * cycle closes.
   */
  championStates: FundamentalStateStore;
  /** Seed id -> what it learned about the fundamental under test this cycle. */
  cycleStores: Record<number, FundamentalStateStore>;
  /**
   * Fundamental keys the sweep visits, in FUNDAMENTALS order. Absent or empty
   * means all of them. The generation closes at the end of this list, so a
   * short list loops on just those fundamentals.
   */
  selected?: string[];
  /** Adam moments, step counts and search widths of the learning layer. */
  learner?: LearnerState;
  /** Frozen champions that passed their gate, newest first. Every seed boxes
   *  each of them once per cycle, so the population is measured against a
   *  field it is not co-evolving with. */
  league?: Record<string, number>[];
  /** The last champion that passed its gate, with its situation memory: what
   *  a failed generation is rolled back to. Null until the first generation
   *  closes. */
  lastGood?: { params: Record<string, number>; states: FundamentalStateStore } | null;
  /** Champion-vs-last-passed results, accumulated until the gate can decide. */
  gate?: GateTally;
  /** Seed id -> its record against the league this generation. */
  leagueTally?: Record<number, { wins: number; bouts: number }>;
  /** The most recent gate decision, for display. */
  lastGate?: (GateDecision & { gen: number }) | null;
}

export interface RunConfig {
  populationSize: number;
  meetingsPerFundamental: number;
  level: number;
  scatter: number;
}

export const DEFAULT_RUN_CONFIG: RunConfig = {
  populationSize: 6,
  // Every pair meets five times per fundamental. Six seeds make fifteen
  // pairings, so a fundamental costs 75 bouts and the full 73-fundamental sweep
  // that makes up a generation costs 5475.
  meetingsPerFundamental: 5,
  level: 100,
  scatter: 0.08,
};

/** How many closed cycles are kept for display. */
const CYCLE_LOG_LIMIT = 80;

function shuffle<T>(xs: T[], rand: () => number): T[] {
  for (let i = xs.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [xs[i], xs[j]] = [xs[j], xs[i]];
  }
  return xs;
}

/**
 * One fundamental's fixtures: every pair of seeds meets exactly `meetings`
 * times. Equal meetings for everyone is what keeps the cycle's records
 * comparable — a win rate only means anything if everyone faced the same field
 * the same number of times.
 *
 * Shuffled so the standings fill evenly as the cycle runs instead of one seed
 * completing all of its bouts first.
 */
function buildSchedule(run: TrainingRun, rand: () => number): Pairing[] {
  const size = run.population.length;
  const out: Pairing[] = [];
  for (let i = 0; i < size; i++) {
    for (let j = i + 1; j < size; j++) {
      for (let m = 0; m < run.meetingsPerFundamental; m++) out.push({ a: i, b: j });
    }
  }
  // Corner sides are drawn, not fixed: the two corners are not built the same
  // way, and a fixed side would make it part of what is being measured.
  const sided = (a: number, b: number): Pairing => (rand() < 0.5 ? { a, b } : { a: b, b: a });
  // League: every seed meets every frozen champion once, so the field is equal.
  const league = run.league?.length ?? 0;
  for (let i = 0; i < size; i++) {
    for (let k = 0; k < league; k++) out.push(sided(i, LEAGUE_SLOT(k)));
  }
  // Gate: the champion as it stands against the last one that passed.
  if (run.lastGood) {
    for (let g = 0; g < GATE_BOUTS_PER_CYCLE; g++) out.push(sided(CHAMP_SLOT, LAST_GOOD_SLOT));
  }
  return shuffle(out, rand);
}

/** The fixture count a cycle opened now would have; the restore path checks a
 *  saved schedule against it. */
export function expectedScheduleLength(run: TrainingRun): number {
  const size = run.population.length;
  return ((size * (size - 1)) / 2) * run.meetingsPerFundamental
    + size * (run.league?.length ?? 0)
    + (run.lastGood ? GATE_BOUTS_PER_CYCLE : 0);
}

/** True if both slots of a saved fixture still name a fighter. */
export function pairingValid(run: TrainingRun, p: Pairing | null | undefined): boolean {
  if (!p || !Number.isInteger(p.a) || !Number.isInteger(p.b) || p.a === p.b) return false;
  return cornerFor(run, p.a) !== null && cornerFor(run, p.b) !== null;
}

/** The fundamental currently under test. */
export const currentFundamental = (run: TrainingRun): Fundamental =>
  FUNDAMENTALS[run.fundIndex] ?? FUNDAMENTALS[0];

/** Where each seed stood as the cycle opened, so its own figures can be read
 *  back out of the cumulative tallies at the end of it. */
function snapshotCycle(run: TrainingRun) {
  const key = currentFundamental(run).key;
  const base: Record<number, CycleBase> = {};
  for (const s of run.population) {
    const st = s.stats[key] ?? { attempts: 0, successes: 0 };
    base[s.id] = { attempts: st.attempts, successes: st.successes };
  }
  run.cycleBase = base;
}

/**
 * Open a cycle on whatever fundamental `fundIndex` is pointing at. Exported for
 * the restore path: a saved schedule that no longer describes the population is
 * thrown away, and the cycle has to be reopened on the restored fundamental
 * rather than left pointing at the one createRun happened to build.
 */
export function startCycle(run: TrainingRun, rand: () => number) {
  run.schedule = buildSchedule(run, rand);
  run.cursor = 0;
  run.completed = 0;
  run.cycleStores = {};
  snapshotCycle(run);
}

export function createRun(cfg: RunConfig, rand: () => number): TrainingRun {
  const population = Array.from({ length: cfg.populationSize }, (_, i) =>
    makeFounder(i, `Seed ${String.fromCharCode(65 + i)}`, cfg.scatter * 2, rand));
  const run: TrainingRun = {
    population,
    gen: 1,
    fundIndex: 0,
    schedule: [],
    cursor: 0,
    completed: 0,
    level: cfg.level,
    meetingsPerFundamental: cfg.meetingsPerFundamental,
    history: [],
    // Scatter 0: the champion opens at the shipped defaults, so until a cycle
    // closes nothing random has reached ordinary play.
    champion: makeFounder(-1, "Champion", 0, rand),
    cycleBase: {},
    cycleLog: [],
    championStates: emptyStore(),
    cycleStores: {},
    learner: emptyLearner(),
    league: [],
    lastGood: null,
    gate: { wins: 0, losses: 0, bouts: 0 },
    leagueTally: {},
    lastGate: null,
  };
  startCycle(run, rand);
  return run;
}

/** Bouts in one fundamental's cycle. */
export const cycleSize = (run: TrainingRun) => run.schedule.length;

/** Fundamentals in a full sweep. */
export const SWEEP_LENGTH = FUNDAMENTALS.length;

/** FUNDAMENTALS indices the sweep visits, in order (all when nothing's picked). */
export function sweepIndices(run: TrainingRun): number[] {
  const pick = new Set(run.selected ?? []);
  const out = FUNDAMENTALS.map((f, i) => (pick.has(f.key) ? i : -1)).filter(i => i >= 0);
  return out.length > 0 ? out : FUNDAMENTALS.map((_, i) => i);
}

/** Where the sweep is: 0-based position of the fundamental under test within
 *  the selected list (the next selected one if it was just deselected), and the
 *  list's length. */
export function sweepPosition(run: TrainingRun): { pos: number; len: number } {
  const idx = sweepIndices(run);
  const at = idx.findIndex(i => i >= run.fundIndex);
  return { pos: at < 0 ? idx.length - 1 : at, len: idx.length };
}

/**
 * Change which fundamentals the sweep visits. Unknown keys are dropped. If
 * nothing has been played in the open cycle and it is no longer selected, the
 * cycle is reopened on the first selected fundamental at or after it;
 * otherwise the open cycle finishes and the change applies from the next one.
 */
export function setSweepSelection(run: TrainingRun, keys: string[], rand: () => number) {
  const known = new Set(FUNDAMENTALS.map(f => f.key));
  run.selected = keys.filter(k => known.has(k));
  const idx = sweepIndices(run);
  if (run.completed === 0 && run.cursor === 0 && !idx.includes(run.fundIndex)) {
    run.fundIndex = idx.find(i => i > run.fundIndex) ?? idx[0];
    startCycle(run, rand);
  }
}

function addStats(dst: Record<string, FundStat>, src: Record<string, FundStat>) {
  for (const f of FUNDAMENTALS) {
    const s = src[f.key];
    if (!s) continue;
    // Created on demand: a pending buffer restored from an older save predates
    // any fundamental added since, and would otherwise drop it silently.
    const d = dst[f.key] ?? (dst[f.key] = { attempts: 0, successes: 0 });
    d.attempts += s.attempts;
    d.successes += s.successes;
  }
}

/**
 * Award evidence to a seed. The generation tally is what the cut and the failing
 * check read, and it is cleared at every cut. The lifetime tally is the same
 * numbers with nothing ever removed.
 */
function creditSeed(seed: FundamentalSeed, src: Record<string, FundStat>) {
  addStats(seed.stats, src);
  if (!seed.lifetime) seed.lifetime = emptyStats();
  addStats(seed.lifetime, src);
}

/**
 * Fold a corner's successes into that seed's memory for the fundamental under
 * test, under the parameters it ran them with.
 *
 * Merged as they arrive rather than piled up raw: recordState collapses
 * situations that are the same situation, so a whole cycle settles into at most
 * fifty entries per seed instead of thousands, and the count on each entry
 * becomes how often that situation actually came up.
 */
function keepSituations(run: TrainingRun, seed: FundamentalSeed, hits: Situation[]) {
  if (hits.length === 0) return;
  const f = currentFundamental(run);
  const params: Record<string, number> = {};
  for (const pr of f.params) {
    const id = paramId(f.key, pr.key);
    params[id] = seed.params[id];
  }
  const store = (run.cycleStores[seed.id] ??= emptyStore());
  for (const s of hits) recordState(store, f.key, s, params);
}

function foldResult(run: TrainingRun, bout: Bout) {
  const a = run.population.find(s => s.id === bout.seedA) ?? null;
  const b = run.population.find(s => s.id === bout.seedB) ?? null;

  if (!a && !b) {
    // Gate bout: neither corner is a seed, so nothing is credited to anyone.
    // Read from the current champion's side, whichever corner it took.
    const champIs = bout.seedA === CHAMP_SEED_ID ? 0 : bout.seedB === CHAMP_SEED_ID ? 1 : -1;
    if (champIs < 0) return;
    const g = (run.gate ??= { wins: 0, losses: 0, bouts: 0 });
    g.bouts++;
    if (bout.winner === champIs) g.wins++;
    else if (bout.winner === (1 - champIs)) g.losses++;
    run.completed++;
    return;
  }

  if (!a || !b) {
    // League bout: one seed against a frozen champion. The seed's record and
    // evidence land as usual; the frozen corner is held out and learns nothing.
    // Every seed gets the same league fixtures, so the column stays comparable.
    const seed = (a ?? b)!;
    const side = a ? 0 : 1;
    seed.bouts++;
    if (bout.winner === side) seed.wins++;
    else seed.losses++;
    const lt = ((run.leagueTally ??= {})[seed.id] ??= { wins: 0, bouts: 0 });
    lt.bouts++;
    if (bout.winner === side) lt.wins++;
    run.completed++;
    const obs = side === 0 ? bout.obs.a : bout.obs.b;
    creditSeed(seed, obs.stats);
    keepSituations(run, seed, obs.hits);
    return;
  }

  // The record is per bout and lands immediately. It ranks the standings and it
  // decides the cut at the end of the sweep — but it has no say in whose
  // parameters for a fundamental are passed on.
  a.bouts++; b.bouts++;
  if (bout.winner === 0) { a.wins++; b.losses++; }
  else if (bout.winner === 1) { b.wins++; a.losses++; }
  else { a.losses++; b.losses++; }
  run.completed++;

  // Fundamental evidence is credited to both corners, won or lost. What the
  // cycle is deciding is who executes THIS fundamental best, and a fundamental
  // executed on the way to losing the bout is still the fundamental being
  // executed — the bout may well have been lost on one of the other 72.
  creditSeed(a, bout.obs.a.stats);
  creditSeed(b, bout.obs.b.stats);

  // ...along with the situations they executed it in, which is what the live AI
  // will match against to decide when to adopt the winner's parameters.
  keepSituations(run, a, bout.obs.a.hits);
  keepSituations(run, b, bout.obs.b.hits);
}

/**
 * Burn through the cycle with whatever slice of the frame it is given. Nothing
 * is drawn, so the whole budget goes to simulating: a full sweep is 5475
 * one-minute bouts, which is over ninety hours of boxing at normal speed and
 * would never finish if any of it had to be watched.
 */
export function runHeadless(run: TrainingRun, budgetMs: number, ticksPerSlice = 600) {
  soundEngine.setSilent(true);
  const deadline = performance.now() + budgetMs;
  while (performance.now() < deadline && run.cursor < run.schedule.length) {
    const pair = run.schedule[run.cursor++];
    const ca = cornerFor(run, pair.a), cb = cornerFor(run, pair.b);
    if (!ca || !cb) { run.completed++; continue; } // a slot that no longer exists
    const bout = createBout(ca, cb, run.level, currentFundamental(run).key);
    while (!bout.done) {
      stepBout(bout, ticksPerSlice);
      if (!bout.done && performance.now() >= deadline + 40) break; // never wedge a frame
    }
    if (bout.done) foldResult(run, bout);
    else run.cursor--; // put it back rather than scoring a partial bout
  }
}

/** True once every bout in the current fundamental's cycle has been scored. */
export const cycleComplete = (run: TrainingRun) => run.cursor >= run.schedule.length;

/**
 * What a seed did with the fundamental under test *during this cycle*, read as
 * the difference against the snapshot taken when the cycle opened.
 */
export function cycleStat(run: TrainingRun, seed: FundamentalSeed): CycleStat {
  const key = currentFundamental(run).key;
  const base = run.cycleBase[seed.id] ?? { attempts: 0, successes: 0 };
  const st = seed.stats[key] ?? { attempts: 0, successes: 0 };
  // Clamped: a cut or a reload can leave a snapshot ahead of the tally, and a
  // negative count would read as a seed that un-executed a fundamental.
  const attempts = Math.max(0, st.attempts - base.attempts);
  const successes = Math.max(0, st.successes - base.successes);
  return { attempts, successes, rate: attempts > 0 ? successes / attempts : 0 };
}

/**
 * Who takes the fundamental.
 *
 * Execution of that one fundamental inside its own cycle, and nothing else.
 * Winning bouts does not enter into it at any stage: a bout turns on all 73
 * fundamentals at once, so using it to decide a single one would hand every
 * fundamental to whoever is strongest overall and the sweep would stop
 * measuring anything. The seed that does this best takes this.
 *
 * Rates are read as evidence: each is shrunk toward the field's pooled rate by
 * how few attempts it rests on, so 1 from 1 cannot outrank 40 from 50. Ties
 * still break on attempts.
 *
 * Nobody takes a fundamental that never came up. Passing on parameters that
 * were never exercised would be noise dressed as a result, so the champion
 * keeps what it already has and the log records that the cycle was empty.
 */
export function cycleWinner(run: TrainingRun):
  { seed: FundamentalSeed; stat: CycleStat } | null {
  let best: FundamentalSeed | null = null;
  let bestStat: CycleStat | null = null;
  let bestScore = -1;
  const stats = run.population.map(s => cycleStat(run, s));
  const field = fieldRate(stats.filter(st => st.attempts > 0));
  for (let i = 0; i < run.population.length; i++) {
    const st = stats[i];
    if (st.attempts <= 0) continue;
    const score = evidenceScore(st.successes, st.attempts, field);
    if (!bestStat
      || score > bestScore
      || (score === bestScore && st.attempts > bestStat.attempts)) {
      best = run.population[i]; bestStat = st; bestScore = score;
    }
  }
  return best && bestStat ? { seed: best, stat: bestStat } : null;
}

/**
 * Close the fundamental under test and open the next one.
 *
 * The champion's block for *that fundamental only* takes one learning step
 * (fundamentalLearning.ts): an evidence-ranked, baseline-subtracted direction
 * across every seed that had a chance, through Adam and a trust region. Every
 * seed's result moves it, not just the winner's, and no single cycle can
 * overwrite the block in one jump. Everything else in the champion is left
 * where it is.
 *
 * The situations the winner executed it in are copied across with them, as that
 * fundamental's entry in the champion's memory. They are replaced rather than
 * merged: a remembered situation is only meaningful next to the parameters that
 * produced it, and those have just changed.
 *
 * Reaching the end of the list is what closes the generation, so the cut and the
 * breeding happen on the wrap.
 */
export function advanceFundamental(run: TrainingRun, rand: () => number): FundCycleRecord {
  const f = currentFundamental(run);
  const won = cycleWinner(run);

  const learner = (run.learner ??= emptyLearner());
  const learned = learnFundamental(
    f,
    run.population.map(seed => { const st = cycleStat(run, seed); return { seed, attempts: st.attempts, successes: st.successes }; }),
    run.champion,
    learner,
  );

  if (won) {
    if (!run.championStates) run.championStates = emptyStore();
    // An empty cycle leaves the previous memory alone. Nobody having executed
    // the fundamental is not evidence that what was remembered has stopped
    // applying, and an empty list would switch it off in ordinary play.
    const remembered = run.cycleStores[won.seed.id]?.[f.key];
    if (remembered && remembered.length > 0) run.championStates[f.key] = remembered;
  }

  const record: FundCycleRecord = {
    gen: run.gen,
    index: run.fundIndex + 1,
    fundKey: f.key,
    label: f.label,
    winnerId: won?.seed.id ?? -1,
    winnerName: won?.seed.name ?? "—",
    rate: won?.stat.rate ?? 0,
    attempts: won?.stat.attempts ?? 0,
    situations: run.championStates?.[f.key]?.length ?? 0,
    stepped: learned.stepped,
    stepSize: learned.stepSize,
    sigma: learned.sigma,
  };
  run.cycleLog.push(record);
  if (run.cycleLog.length > CYCLE_LOG_LIMIT) {
    run.cycleLog.splice(0, run.cycleLog.length - CYCLE_LOG_LIMIT);
  }

  const next = sweepIndices(run).find(i => i > run.fundIndex);
  if (next === undefined) advanceGeneration(run, rand);
  else {
    run.fundIndex = next;
    startCycle(run, rand);
  }
  return record;
}

/**
 * Close the generation.
 *
 * 1. The gate. The champion has boxed the last champion that passed all
 *    generation; if it clearly lost (below GATE_ROLLBACK_BELOW over at least
 *    GATE_MIN_BOUTS), the whole generation's learning is rolled back. A pass
 *    makes it the new last-passed champion and enters it into the league. Too
 *    few bouts carries the tally on undecided.
 * 2. The cut: the top half is kept whole. The emptied slots are refilled by
 *    the search distribution — one explorer from the whole space, the rest
 *    mirrored pairs around the champion at each fundamental's learned width —
 *    with salvaged blocks laid on top.
 */
export function advanceGeneration(run: TrainingRun, rand: () => number): GenerationRecord {
  const ranked = rankSeeds(run.population);
  const learner = (run.learner ??= emptyLearner());

  let gate: GateDecision | undefined;
  const snapshot = () => ({ params: { ...run.champion.params }, states: { ...(run.championStates ?? emptyStore()) } });
  if (!run.lastGood) {
    // Nothing to judge against yet: the first champion passes by default.
    run.lastGood = snapshot();
    run.league = pushLeague(run.league ?? [], run.champion.params);
    run.gate = { wins: 0, losses: 0, bouts: 0 };
  } else {
    gate = judgeGate(run.gate ?? { wins: 0, losses: 0, bouts: 0 });
    if (gate.decided) {
      if (gate.rolledBack) {
        run.champion.params = { ...run.lastGood.params };
        run.championStates = { ...run.lastGood.states };
      } else {
        run.lastGood = snapshot();
        run.league = pushLeague(run.league ?? [], run.champion.params);
      }
      run.gate = { wins: 0, losses: 0, bouts: 0 };
      run.lastGate = { ...gate, gen: run.gen };
    }
  }

  const { next, survivors, replaced, salvageLog } = evolveNextGeneration(
    run.population, run.gen + 1, rand,
    (slots, gen) => sampleReplacements(slots, gen, run.champion, learner, rand),
  );

  const record: GenerationRecord = {
    gen: run.gen,
    survivors,
    replaced,
    standings: ranked.map(s => ({
      id: s.id, name: s.name, wins: s.wins, bouts: s.bouts,
      rate: s.bouts > 0 ? s.wins / s.bouts : 0,
    })),
    salvage: salvageLog,
    gate,
  };

  run.history.push(record);
  run.population = next;
  run.leagueTally = {};
  run.gen++;
  run.fundIndex = sweepIndices(run)[0];
  startCycle(run, rand);
  return record;
}

/** Neural override for every seed, keyed by the roster id its brain will use. */
export function neuralOverridesFor(pop: FundamentalSeed[]): Record<number, Record<string, number>> {
  const out: Record<number, Record<string, number>> = {};
  for (const s of pop) out[seedRosterId(s.id)] = deriveNeuralState(s);
  return out;
}

/** The population plus the learning layer's fixed corners (league, champion,
 *  last passed champion). Republish whenever the champion moves. */
export function neuralOverridesForRun(run: TrainingRun): Record<number, Record<string, number>> {
  const out = neuralOverridesFor(run.population);
  const slots = [CHAMP_SLOT, LAST_GOOD_SLOT, ...(run.league ?? []).map((_, k) => LEAGUE_SLOT(k))];
  for (const slot of slots) {
    const c = cornerFor(run, slot);
    if (c) out[seedRosterId(c.id)] = deriveNeuralState(c);
  }
  return out;
}
