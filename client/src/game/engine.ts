import { aiRNG } from "./aiRng";
import {
  GameState, FighterState, PunchType, Archetype, DefenseState,
  PUNCH_CONFIGS, ARCHETYPE_STATS, ENEMY_NAMES, HitEffect, Vec2,
  FighterColors, DEFAULT_PLAYER_COLORS, DEFAULT_ENEMY_COLORS, StanceType, SKIN_COLOR_PRESETS,
  PunchPhaseType, RhythmPhase, PauseAction, PunchConfig,
  AIDifficulty, AI_KD_CHANCES, TimerSpeed, JudgeScore, RoundScore, SlipDir,
  RecordedEvent, RecordedRound, RoundRecordSummary, InputRecording, AiDecisionStats,
  BehaviorProfile, RingZone, SequenceTracker, AdaptiveMemory, ObservedPattern,
  AiBrainState, DoghouseOpponentSpec, BoxingStance, KD_FALL_DURATION, BIG_SHOT_TEXT_DURATION,
  BIG_SHOT_BASE_CHANCE,
  MAX_STAMINA_DELTA_TEXT_LIFETIME, FatigueState,
} from "./types";
import { getAiDecisionStats, initAiBrain, updateAI as updateAIBrain, notifyAiHitLanded, notifyAiPunchWhiffed, notifyAiBlockContact, createAdaptiveMemory, reviewAdaptiveMemory, onRoundBoundaryAdaptive, onRoundBoundaryRangeLearning, notifyAiRangeDisrupt, notifyAiRangeWhiff, notifyAiWhiffContext, notifyAiKnockedDown, notifyAiStunOrCrit, notifyAiPlayerStunned, notifyAiRcPunchResolved, notifyAiStunned, resetAiPerfectBlockHold, notifyAiRhythmCutLanded, notifyAiCleanHitNotRhythmCut, notifyAiPunchPerfectBlocked, notifyAiPunchAvoided, notifyAiPunchThrown, notifyAiStunLanded, notifyAiPunchTrigger, gradeAiSlipReadTiming, resetAiPatternRound } from "./ai";
import { soundEngine, type PunchSoundType } from "./sound";
import { setSpacialMotionBoost } from "./spacialColor";
import { getActivePunchAnimConfig } from "../lib/punchAnimConfig";
import { levelScale, levelT as scalingLevelT, pointCoef, getScaling, levelGapAdj, clampGapMult } from "../lib/scalingConfig";
import { isDirectionalPerfectBlockEnabled, getMaxStamConfig, activeMaxStamAmounts, isMaxStamEnabled, getTurnConfig, getStoppageConfig, getFatigueConfig, type MaxStamAmounts } from "@/components/NeuralNetworkView";
import {
  refCurve, refNum,
  precisionStrikerRangeBonus, slipperyRepunchThreshold, chinHitterChargeMult, technicianWhiffForgiveness,
} from "./refinementTuning";
import { PUNCH_ENDURANCE_MIN, clampPunchEnduranceLoss, PUNCH_ENDURANCE_LOSS_MIN } from "./punchEndurance";
import {
  DRILLED_ACTION_CONFIG, DRILLED_LENGTH, createDrilledFightState, clearDrilledWindow,
  applyDrilledSuccess, drilledClosingFor, drilledPowerBonus,
  drilledStaminaMultFor, noteDrilledThrow,
  type DrilledActionEntry, type DrilledFightState,
} from "./drilledActions";
import { punchActionToken, feintActionToken, PATTERN_TOKEN_CHARGE, PATTERN_TOKEN_DUCK } from "./aiPatterns";
import { cappedStartMaxStamina, equipmentEffects, hasEquipment, type EquipmentLevels } from "./equipmentConfig";
import { MAX_ACTIVE_REFINEMENTS, maxActiveRefinementsFor } from "@shared/schema";

let recordingAccumulator = 0;
const RECORD_MOVE_INTERVAL = 0.1;
let lastPlayerDefState: DefenseState = "none";
let lastEnemyDefState: DefenseState = "none";
let roundRecordingElapsed = 0;

function recordEvent(state: GameState, type: RecordedEvent["type"], actor: "player" | "enemy", data: Record<string, unknown>) {
  if (!state.recordInputs || !state.inputRecording) return;
  const round = state.inputRecording.rounds[state.inputRecording.rounds.length - 1];
  if (!round) return;
  const dx = state.enemy.x - state.player.x;
  const dz = state.enemy.z - state.player.z;
  const dist = Math.sqrt(dx * dx + dz * dz);
  const elapsed = roundRecordingElapsed * 1000;
  round.events.push({
    t: Math.round(elapsed * 10) / 10,
    type,
    actor,
    data,
    px: Math.round(state.player.x),
    pz: Math.round(state.player.z),
    ex: Math.round(state.enemy.x),
    ez: Math.round(state.enemy.z),
    dist: Math.round(dist),
    pStam: Math.round(state.player.stamina),
    eStam: Math.round(state.enemy.stamina),
  });
}

function initRoundRecording(state: GameState) {
  if (!state.recordInputs || !state.inputRecording) return;
  lastPlayerDefState = "none";
  lastEnemyDefState = "none";
  recordingAccumulator = 0;
  roundRecordingElapsed = 0;
  state.inputRecording.rounds.push({
    roundNumber: state.currentRound,
    startTime: 0,
    events: [],
    summary: createEmptyRoundSummary(),
    aiStatsAtStart: getAiDecisionStats(state.aiBrain),
  });
}

/** Counters are cumulative on the brain, so the dump reports the round's delta. */
const AI_STAT_COUNTER_KEYS = [
  "punchesThrown", "bodyPunchesThrown", "powerSwayThrows", "powerSwayLanded",
  "offenseSuppressedTicks", "reflexHeldOffTicks", "inRangeTime",
  "blockSyncArmed", "blockSyncLanded",
  "gasPullouts", "gasHoldSec",
] as const;

function diffAiDecisionStats(end: AiDecisionStats, start: AiDecisionStats | null | undefined): AiDecisionStats {
  if (!start) return end;
  const out = { ...end };
  for (const k of AI_STAT_COUNTER_KEYS) out[k] = Math.max(0, end[k] - start[k]);
  return out;
}

function createEmptyRoundSummary(): RoundRecordSummary {
  const punchInit = () => ({ thrown: 0, landed: 0, feinted: 0, charged: 0, body: 0 });
  return {
    playerPunches: { jab: punchInit(), cross: punchInit(), leftHook: punchInit(), rightHook: punchInit(), leftUppercut: punchInit(), rightUppercut: punchInit() },
    enemyPunches: { jab: punchInit(), cross: punchInit(), leftHook: punchInit(), rightHook: punchInit(), leftUppercut: punchInit(), rightUppercut: punchInit() },
    playerMovement: { totalDistance: 0, avgDistFromEnemy: 0, timeInRange: 0, timeOutRange: 0 },
    enemyMovement: { totalDistance: 0, avgDistFromEnemy: 0, timeInRange: 0, timeOutRange: 0 },
    playerDefense: { ducks: 0, duckTime: 0, fullGuards: 0, blocksLanded: 0, dodges: 0 },
    enemyDefense: { ducks: 0, duckTime: 0, fullGuards: 0, blocksLanded: 0, dodges: 0 },
    knockdowns: { player: 0, enemy: 0 },
    duration: 0,
  };
}

function finalizeRoundRecording(state: GameState) {
  if (!state.recordInputs || !state.inputRecording) return;
  const round = state.inputRecording.rounds[state.inputRecording.rounds.length - 1];
  if (!round) return;
  round.summary.duration = state.roundDuration - state.roundTimer;
  round.summary.aiDecisions = diffAiDecisionStats(getAiDecisionStats(state.aiBrain), round.aiStatsAtStart);
  const punchEvents = round.events.filter(e => e.type === "punch");
  for (const e of punchEvents) {
    const punchName = e.data.punch as string;
    const bucket = e.actor === "player" ? round.summary.playerPunches : round.summary.enemyPunches;
    if (bucket[punchName]) {
      bucket[punchName].thrown++;
      if (e.data.feint) bucket[punchName].feinted++;
      if (e.data.charged) bucket[punchName].charged++;
      if (e.data.body) bucket[punchName].body++;
    }
  }
  const hitEvents = round.events.filter(e => e.type === "hit");
  for (const e of hitEvents) {
    const punchName = e.data.punch as string;
    const bucket = e.actor === "player" ? round.summary.playerPunches : round.summary.enemyPunches;
    if (bucket[punchName]) bucket[punchName].landed++;
  }
  const blockEvents = round.events.filter(e => e.type === "block");
  for (const e of blockEvents) {
    const defBucket = e.actor === "player" ? round.summary.playerDefense : round.summary.enemyDefense;
    defBucket.blocksLanded++;
  }
  const dodgeEvents = round.events.filter(e => e.type === "dodge");
  for (const e of dodgeEvents) {
    const defBucket = e.actor === "player" ? round.summary.playerDefense : round.summary.enemyDefense;
    defBucket.dodges++;
  }
  const kdEvents = round.events.filter(e => e.type === "knockdown");
  for (const e of kdEvents) {
    if (e.actor === "player") round.summary.knockdowns.enemy++;
    else round.summary.knockdowns.player++;
  }
  const defEvents = round.events.filter(e => e.type === "defense");
  for (const e of defEvents) {
    const defBucket = e.actor === "player" ? round.summary.playerDefense : round.summary.enemyDefense;
    const ds = e.data.state as string;
    if (ds === "duck") defBucket.ducks++;
    else if (ds === "fullGuard") defBucket.fullGuards++;
  }
  let pDist = 0, eDist = 0, distSamples = 0, pInRange = 0, pOutRange = 0;
  const moveEvents = round.events.filter(e => e.type === "move");
  let lastPx = 0, lastPz = 0, lastEx = 0, lastEz = 0;
  for (let i = 0; i < moveEvents.length; i++) {
    const m = moveEvents[i];
    if (i > 0) {
      pDist += Math.sqrt((m.px - lastPx) ** 2 + (m.pz - lastPz) ** 2);
      eDist += Math.sqrt((m.ex - lastEx) ** 2 + (m.ez - lastEz) ** 2);
    }
    distSamples++;
    if (m.dist <= 80) pInRange += RECORD_MOVE_INTERVAL;
    else pOutRange += RECORD_MOVE_INTERVAL;
    lastPx = m.px; lastPz = m.pz; lastEx = m.ex; lastEz = m.ez;
  }
  round.summary.playerMovement.totalDistance = Math.round(pDist);
  round.summary.enemyMovement.totalDistance = Math.round(eDist);
  round.summary.playerMovement.avgDistFromEnemy = distSamples > 0 ? Math.round(moveEvents.reduce((s, m) => s + m.dist, 0) / distSamples) : 0;
  round.summary.enemyMovement.avgDistFromEnemy = round.summary.playerMovement.avgDistFromEnemy;
  round.summary.playerMovement.timeInRange = Math.round(pInRange * 10) / 10;
  round.summary.playerMovement.timeOutRange = Math.round(pOutRange * 10) / 10;
  round.summary.enemyMovement.timeInRange = round.summary.playerMovement.timeInRange;
  round.summary.enemyMovement.timeOutRange = round.summary.playerMovement.timeOutRange;
}

export function formatRecordingForExport(recording: InputRecording): string {
  const lines: string[] = [];
  const s = recording.fightSettings;
  const matchType = s.cpuVsCpu ? "CPU vs CPU" : "Player vs CPU";
  const mode = s.practiceMode ? "Practice" : "Normal";
  lines.push("=== HANDZ INPUT RECORDING ===");
  lines.push(`Date: ${new Date().toISOString()}`);
  lines.push(`Match Type: ${matchType} | Mode: ${mode}`);
  lines.push("");
  lines.push("--- FIGHT SETTINGS ---");
  lines.push(`${s.playerName} (${s.playerArchetype}) vs ${s.enemyName} (${s.enemyArchetype})`);
  lines.push(`Player Level: ${s.playerLevel} | Enemy Level: ${s.enemyLevel}`);
  lines.push(`AI Difficulty: ${s.aiDifficulty}`);
  lines.push(`Round Duration: ${s.roundDuration}s | Timer Speed: ${s.timerSpeed} | Total Rounds: ${s.totalRounds}`);
  lines.push(`Player Arm: ${s.playerArmLength}" | Enemy Arm: ${s.enemyArmLength}"`);
  lines.push("");

  for (const round of recording.rounds) {
    lines.push(`=== ROUND ${round.roundNumber} === (${round.summary.duration.toFixed(1)}s)`);
    lines.push("");
    lines.push("--- PUNCH SUMMARY ---");
    lines.push("PLAYER:");
    for (const [name, p] of Object.entries(round.summary.playerPunches)) {
      if (p.thrown > 0) {
        lines.push(`  ${name}: ${p.thrown} thrown, ${p.landed} landed (${p.thrown > 0 ? Math.round(p.landed / p.thrown * 100) : 0}%)${p.feinted ? ` ${p.feinted} feints` : ""}${p.charged ? ` ${p.charged} charged` : ""}${p.body ? ` ${p.body} body` : ""}`);
      }
    }
    lines.push("ENEMY:");
    for (const [name, p] of Object.entries(round.summary.enemyPunches)) {
      if (p.thrown > 0) {
        lines.push(`  ${name}: ${p.thrown} thrown, ${p.landed} landed (${p.thrown > 0 ? Math.round(p.landed / p.thrown * 100) : 0}%)${p.feinted ? ` ${p.feinted} feints` : ""}${p.charged ? ` ${p.charged} charged` : ""}${p.body ? ` ${p.body} body` : ""}`);
      }
    }
    lines.push("");
    lines.push("--- MOVEMENT ---");
    lines.push(`Player distance traveled: ${round.summary.playerMovement.totalDistance}px | Avg dist from enemy: ${round.summary.playerMovement.avgDistFromEnemy}px`);
    lines.push(`Time in range: ${round.summary.playerMovement.timeInRange}s | Out of range: ${round.summary.playerMovement.timeOutRange}s`);
    lines.push("");
    lines.push("--- DEFENSE ---");
    const pd = round.summary.playerDefense;
    lines.push(`Player: ${pd.ducks} ducks, ${pd.fullGuards} full guards, ${pd.blocksLanded} blocks hit, ${pd.dodges} dodges`);
    const ed = round.summary.enemyDefense;
    lines.push(`Enemy: ${ed.ducks} ducks, ${ed.fullGuards} full guards, ${ed.blocksLanded} blocks hit, ${ed.dodges} dodges`);
    lines.push("");
    lines.push("--- KNOCKDOWNS ---");
    lines.push(`Player scored: ${round.summary.knockdowns.enemy} | Enemy scored: ${round.summary.knockdowns.player}`);
    lines.push("");

    const ai = round.summary.aiDecisions;
    if (ai) {
      const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 100) : 0);
      lines.push("--- AI DECISIONS ---");
      lines.push(`Punches thrown: ${ai.punchesThrown} (${ai.bodyPunchesThrown} body, ${pct(ai.bodyPunchesThrown, ai.punchesThrown)}%) | Time in range: ${ai.inRangeTime.toFixed(1)}s`);
      lines.push(`Power-sway throws: ${ai.powerSwayThrows}, landed ${ai.powerSwayLanded} (${pct(ai.powerSwayLanded, ai.powerSwayThrows)}%) | Sway adapt: ${ai.rhythmSwayAdapt.toFixed(2)} -> best lvl ${ai.bestSwayLevel || "-"}`);
      lines.push(`Timed blocks: ${ai.blockSyncArmed} armed, ${ai.blockSyncLanded} connected (${pct(ai.blockSyncLanded, ai.blockSyncArmed)}%) | Learnt timing: ${ai.blockTimingLearntMs >= 0 ? "+" : ""}${Math.round(ai.blockTimingLearntMs)}ms`);
      lines.push(`Read of player: punch interval ${ai.playerPunchIntervalAvg.toFixed(2)}s | lands from ${Math.round(ai.playerLandRangeAvg)}px | jab windup ${Math.round(ai.playerJabFlightSec * 1000)}ms | body bias ${ai.bodyBias.toFixed(2)}`);
      lines.push(`Suppressed offense ticks: ${ai.offenseSuppressedTicks} | Reflex yielded ticks: ${ai.reflexHeldOffTicks}`);
      lines.push(`Gas: pulled out of ${ai.gasPullouts} burst(s), offence paused ${ai.gasHoldSec.toFixed(1)}s`);
      lines.push("");
    }
    lines.push("--- EVENT LOG ---");
    lines.push("Time(ms) | Actor  | Event      | Details                                  | Positions (P/E) | Dist | Stam(P/E)");
    lines.push("-".repeat(120));
    for (const e of round.events) {
      if (e.type === "rhythmCutHit") continue; // printed in dedicated section below
      const details = Object.entries(e.data).map(([k, v]) => `${k}=${v}`).join(" ");
      const time = String(Math.round(e.t)).padStart(8);
      const actor = e.actor.padEnd(6);
      const type = e.type.padEnd(10);
      const pos = `(${e.px},${e.pz})/(${e.ex},${e.ez})`;
      lines.push(`${time} | ${actor} | ${type} | ${details.padEnd(40).slice(0, 40)} | ${pos.padEnd(15)} | ${String(e.dist).padStart(4)} | ${e.pStam}/${e.eStam}`);
    }
    lines.push("");
    const rcHits = round.events.filter(e => e.type === "rhythmCutHit");
    if (rcHits.length > 0) {
      lines.push("--- RHYTHM CUT HITS ---");
      lines.push("Time(ms) | Actor  | Punch           | P(px,pz)       | E(px,pz)       | Dist | Rhythm% | Vul(ends)  | SwayOff | Dir | SpeedLv | MsOff");
      lines.push("-".repeat(135));
      for (const e of rcHits) {
        const time = String(Math.round(e.t)).padStart(8);
        const actor = e.actor.padEnd(6);
        const punch = String(e.data.punch ?? "?").padEnd(15);
        const pp = `(${e.px},${e.pz})`.padEnd(14);
        const ep = `(${e.ex},${e.ez})`.padEnd(14);
        // Recordings made before the window moved to the ends still carry lo/hi.
        const vul = (e.data.vulHalfPct != null
          ? `≤${e.data.vulHalfPct}/≥${100 - Number(e.data.vulHalfPct)}%`
          : `${e.data.vulLoPct ?? "?"}–${e.data.vulHiPct ?? "?"}%`).padEnd(10);
        lines.push(`${time} | ${actor} | ${punch} | ${pp} | ${ep} | ${String(e.dist).padStart(4)} | ${String(e.data.rhythmPct ?? "?").padStart(7)} | ${vul} | ${String(e.data.swayOffset ?? "?").padStart(7)} | ${String(e.data.swayDir ?? "?").padStart(3)} | ${String(e.data.swaySpeedLv ?? "?").padStart(7)} | ${String(e.data.msOff ?? "?").padStart(5)}`);
      }
      lines.push("");
    }
  }

  return lines.join("\n");
}

export function formatRoundRecordingForExport(recording: InputRecording, roundNumber: number): string {
  const round = recording.rounds.find(r => r.roundNumber === roundNumber);
  if (!round) return "";
  const lines: string[] = [];
  const s = recording.fightSettings;
  const matchType = s.cpuVsCpu ? "CPU vs CPU" : "Player vs CPU";
  const mode = s.practiceMode ? "Practice" : "Normal";
  lines.push("=== HANDZ INPUT RECORDING (SINGLE ROUND) ===");
  lines.push(`Date: ${new Date().toISOString()}`);
  lines.push(`Match Type: ${matchType} | Mode: ${mode}`);
  lines.push("");
  lines.push("--- FIGHT SETTINGS ---");
  lines.push(`${s.playerName} (${s.playerArchetype}) vs ${s.enemyName} (${s.enemyArchetype})`);
  lines.push(`Player Level: ${s.playerLevel} | Enemy Level: ${s.enemyLevel}`);
  lines.push(`AI Difficulty: ${s.aiDifficulty}`);
  lines.push(`Round Duration: ${s.roundDuration}s | Timer Speed: ${s.timerSpeed} | Total Rounds: ${s.totalRounds}`);
  lines.push(`Player Arm: ${s.playerArmLength}" | Enemy Arm: ${s.enemyArmLength}"`);
  lines.push("");

  lines.push(`=== ROUND ${round.roundNumber} === (${round.summary.duration.toFixed(1)}s)`);
  lines.push("");
  lines.push("--- PUNCH SUMMARY ---");
  lines.push("PLAYER:");
  for (const [name, p] of Object.entries(round.summary.playerPunches)) {
    if (p.thrown > 0) {
      lines.push(`  ${name}: ${p.thrown} thrown, ${p.landed} landed (${p.thrown > 0 ? Math.round(p.landed / p.thrown * 100) : 0}%)${p.feinted ? ` ${p.feinted} feints` : ""}${p.charged ? ` ${p.charged} charged` : ""}${p.body ? ` ${p.body} body` : ""}`);
    }
  }
  lines.push("ENEMY:");
  for (const [name, p] of Object.entries(round.summary.enemyPunches)) {
    if (p.thrown > 0) {
      lines.push(`  ${name}: ${p.thrown} thrown, ${p.landed} landed (${p.thrown > 0 ? Math.round(p.landed / p.thrown * 100) : 0}%)${p.feinted ? ` ${p.feinted} feints` : ""}${p.charged ? ` ${p.charged} charged` : ""}${p.body ? ` ${p.body} body` : ""}`);
    }
  }
  lines.push("");
  lines.push("--- MOVEMENT ---");
  lines.push(`Player distance traveled: ${round.summary.playerMovement.totalDistance}px | Avg dist from enemy: ${round.summary.playerMovement.avgDistFromEnemy}px`);
  lines.push(`Time in range: ${round.summary.playerMovement.timeInRange}s | Out of range: ${round.summary.playerMovement.timeOutRange}s`);
  lines.push("");
  lines.push("--- DEFENSE ---");
  const pd = round.summary.playerDefense;
  lines.push(`Player: ${pd.ducks} ducks, ${pd.fullGuards} full guards, ${pd.blocksLanded} blocks hit, ${pd.dodges} dodges`);
  const ed = round.summary.enemyDefense;
  lines.push(`Enemy: ${ed.ducks} ducks, ${ed.fullGuards} full guards, ${ed.blocksLanded} blocks hit, ${ed.dodges} dodges`);
  lines.push("");
  lines.push("--- KNOCKDOWNS ---");
  lines.push(`Player scored: ${round.summary.knockdowns.enemy} | Enemy scored: ${round.summary.knockdowns.player}`);
  lines.push("");
  const ai = round.summary.aiDecisions;
  if (ai) {
    const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 100) : 0);
    lines.push("--- AI DECISIONS ---");
    lines.push(`Punches thrown: ${ai.punchesThrown} (${ai.bodyPunchesThrown} body, ${pct(ai.bodyPunchesThrown, ai.punchesThrown)}%) | Time in range: ${ai.inRangeTime.toFixed(1)}s`);
    lines.push(`Power-sway throws: ${ai.powerSwayThrows}, landed ${ai.powerSwayLanded} (${pct(ai.powerSwayLanded, ai.powerSwayThrows)}%) | Sway adapt: ${ai.rhythmSwayAdapt.toFixed(2)} -> best lvl ${ai.bestSwayLevel || "-"}`);
    lines.push(`Timed blocks: ${ai.blockSyncArmed} armed, ${ai.blockSyncLanded} connected (${pct(ai.blockSyncLanded, ai.blockSyncArmed)}%) | Learnt timing: ${ai.blockTimingLearntMs >= 0 ? "+" : ""}${Math.round(ai.blockTimingLearntMs)}ms`);
    lines.push(`Read of player: punch interval ${ai.playerPunchIntervalAvg.toFixed(2)}s | lands from ${Math.round(ai.playerLandRangeAvg)}px | jab windup ${Math.round(ai.playerJabFlightSec * 1000)}ms | body bias ${ai.bodyBias.toFixed(2)}`);
    lines.push(`Suppressed offense ticks: ${ai.offenseSuppressedTicks} | Reflex yielded ticks: ${ai.reflexHeldOffTicks}`);
    lines.push(`Gas: pulled out of ${ai.gasPullouts} burst(s), offence paused ${ai.gasHoldSec.toFixed(1)}s`);
    lines.push("");
  }
  lines.push("--- EVENT LOG ---");
  lines.push("Time(ms) | Actor  | Event      | Details                                  | Positions (P/E) | Dist | Stam(P/E)");
  lines.push("-".repeat(120));
  for (const e of round.events) {
    if (e.type === "rhythmCutHit") continue;
    const details = Object.entries(e.data).map(([k, v]) => `${k}=${v}`).join(" ");
    const time = String(Math.round(e.t)).padStart(8);
    const actor = e.actor.padEnd(6);
    const type = e.type.padEnd(10);
    const pos = `(${e.px},${e.pz})/(${e.ex},${e.ez})`;
    lines.push(`${time} | ${actor} | ${type} | ${details.padEnd(40).slice(0, 40)} | ${pos.padEnd(15)} | ${String(e.dist).padStart(4)} | ${e.pStam}/${e.eStam}`);
  }
  lines.push("");
  const rcHits = round.events.filter(e => e.type === "rhythmCutHit");
  if (rcHits.length > 0) {
    lines.push("--- RHYTHM CUT HITS ---");
    lines.push("Time(ms) | Actor  | Punch           | P(px,pz)       | E(px,pz)       | Dist | Rhythm% | Vul(ends)  | SwayOff | Dir | SpeedLv | MsOff");
    lines.push("-".repeat(135));
    for (const e of rcHits) {
      const time = String(Math.round(e.t)).padStart(8);
      const actor = e.actor.padEnd(6);
      const punch = String(e.data.punch ?? "?").padEnd(15);
      const pp = `(${e.px},${e.pz})`.padEnd(14);
      const ep = `(${e.ex},${e.ez})`.padEnd(14);
      // Recordings made before the window moved to the ends still carry lo/hi.
      const vul = (e.data.vulHalfPct != null
        ? `≤${e.data.vulHalfPct}/≥${100 - Number(e.data.vulHalfPct)}%`
        : `${e.data.vulLoPct ?? "?"}–${e.data.vulHiPct ?? "?"}%`).padEnd(10);
      lines.push(`${time} | ${actor} | ${punch} | ${pp} | ${ep} | ${String(e.dist).padStart(4)} | ${String(e.data.rhythmPct ?? "?").padStart(7)} | ${vul} | ${String(e.data.swayOffset ?? "?").padStart(7)} | ${String(e.data.swayDir ?? "?").padStart(3)} | ${String(e.data.swaySpeedLv ?? "?").padStart(7)} | ${String(e.data.msOff ?? "?").padStart(5)}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

// The AI's RNG lives in its own import-free module so the string runner (and
// its Node check scripts) can load it without dragging the whole engine in.
export { aiRNG };

const LAUNCH_DELAY_MULT = 0.033;
const ARM_SPEED_MULT = 7.5;
const LINGER_MULT = 0.133;
const RETRACTION_MULT = 0.133;
const PUNCH_ANGLE_NORMAL = -13;
const PUNCH_ANGLE_DUCK_BODY = 2;
/**
 * Turning is animated, not teleported: `facingAngle` swings toward the opponent
 * at `PI / duration` rad/s, so the base delay is both the wait before the
 * discrete `facing` flip and the time the body spends visibly coming around.
 * The number itself is player-tuned on the Neural Network screen (0 to 10s),
 * read fresh each tick from its cache. Stun's turn penalties raise the same
 * duration, so a stunned fighter is seen turning slower, not just flipping later.
 */
function baseFacingTurnDelay(): number {
  return getTurnConfig().baseTurnDelay;
}

/**
 * How far a fighter's body has been left behind by its turn, as a percentage of
 * a quarter turn: 0% is pointed dead at the opponent, 100% is squared off
 * perpendicular to them (a quarter turned away), and anything beyond that
 * clamps at 100%. Every rule that cares about turn delay reads this one number.
 */
const QUARTER_TURN_RAD = Math.PI / 2;
function turnPercentTo(f: FighterState, targetX: number, targetZ: number): number {
  const err = Math.abs(facingErrorTo(f, targetX, targetZ));
  return Math.min(100, (err / QUARTER_TURN_RAD) * 100);
}

/**
 * Chance a punch thrown at this much turn makes contact at all, 0–1. Pointed
 * dead-on it is a certainty — the defender can still block it, perfect-block it
 * or slip it, but the punch is never simply thrown past them. From there it
 * falls off a cliff, because a body still coming around is swinging the punch
 * across its own chest: 5% of a quarter turn (4.5°) halves the chance, 10% (9°)
 * leaves a tenth of it, and by 15% (13.5°) the punch cannot land at all.
 */
function facingAccuracy(turnPct: number): number {
  if (turnPct <= 0) return 1;
  if (turnPct >= 15) return 0;
  if (turnPct <= 5) return 1 - (turnPct / 5) * 0.5;
  if (turnPct <= 10) return 0.5 - ((turnPct - 5) / 5) * 0.4;
  return 0.1 - ((turnPct - 10) / 5) * 0.1;
}

/** Wrap to (-PI, PI] so angle differences take the short way around. */
function normalizeAngle(a: number): number {
  let out = a;
  while (out > Math.PI) out -= Math.PI * 2;
  while (out < -Math.PI) out += Math.PI * 2;
  return out;
}

/** How long a perfect block leaves its blocker turning with no delay at all. */
const PERFECT_BLOCK_TURN_ZERO_DURATION = 1.0;

/**
 * How much of a charge punch's EXTRA damage a raised auto guard soaks once the
 * defender is at the Defense cap. It scales linearly with Defense — nothing at
 * 0, this fraction at 1000 — and only ever eats the surplus a charge carries
 * over an ordinary punch. The punch itself still lands for its normal damage,
 * so a maxed-Defense fighter behind auto guard turns a charge back into roughly
 * a regular shot rather than negating it.
 */
const CHARGE_AUTOGUARD_RESIST_AT_CAP = 0.85;

/**
 * How close the two have to be for a whiffed punch to still count as work: a
 * punch thrown from across the ring teaches the thrower nothing, one missed in
 * the pocket does.
 */
const WHIFF_CLOSE_RANGE_PX = 90;

/**
 * How long a *completed* slip keeps the head off the punch line. The clock only
 * starts once the slide into position has finished: a head shot arriving while
 * the fighter is still moving lands, and so does one arriving after they have sat
 * in the slipped position longer than this.
 */
export const SLIP_DODGE_WINDOW = 0.15;
/**
 * Seconds the slide into the slipped position takes, at Speed 0 and at the Speed
 * where it stops getting quicker. A slip is not a teleport — the head travels,
 * and even a slow fighter's head is only briefly still on the line after they
 * commit to it.
 *
 * Both ends are scaled together on purpose: a fresh career sits at the slow end,
 * so making a beginner's slip quicker without moving the fast end would leave a
 * high-Speed fighter slipping SLOWER than a beginner. Scaling both keeps the
 * Speed stat worth the same 1.75x it always was.
 */
const SLIP_ENTER_SLOW = 0.117;
const SLIP_ENTER_FAST = 0.067;
const SLIP_ENTER_SPEED_CAP = 300;
/**
 * Crossing from one *completed* slip to the other side costs this much of a
 * fresh slide: the head is all the way out and has to come back through the
 * middle before it can go the other way. A fighter still sliding into their
 * first slip pays nothing extra for changing their mind — they are not slipped
 * yet. Either way the dodge window does not reopen until the head arrives.
 */
const SLIP_SWITCH_TIME_MULT = 1.75;
/** Longest a single slip can be held. Nothing follows it — the cooldown is zero. */
export const SLIP_MAX_HOLD = 2.0;
/** Slipping is locked out this long after a head shot catches a slipping fighter. */
export const SLIP_HEAD_HIT_DISABLE = 0.75;
/**
 * What a slip takes out of the fighter, as a share of their max stamina: the base
 * price, and the extra every consecutive slip adds on top. Slips are consecutive
 * while they keep landing inside SLIP_CHAIN_WINDOW of the last one — so a fighter
 * living on the slip pays more for each one. Let the window lapse and the next
 * slip is back to the base price.
 */
const SLIP_STAMINA_COST = 0.001;
const SLIP_STAMINA_COST_STEP = 0.0005;
const SLIP_CHAIN_WINDOW = 0.75;
/** Power multiplier for a punch thrown out of the slip that sets it up. */
const SLIP_COUNTER_BONUS = 1.2;
/** How quickly the visible lean snaps back out of a slip. The way in is timed. */
const SLIP_LEAN_RATE = 16;

/* ────────────────────────── Energy fatigue & Reset ──────────────────────────
 * A third fatigue axis. Punches taken drain Energy; a drained fighter's torso
 * and forearms lag behind their footwork, and that inertia sway is what carries
 * every penalty. Reset (B) snaps the stance clean and suspends them.
 *
 * Every number in the system is balance-sensitive and none of it is surfaced as
 * on-screen text in a bout, so all of it is tunable from the Neural Network
 * screen's "Energy Fatigue & Reset" card — see FatigueConfig for what each field
 * means. Read through getFatigueConfig() at the point of use rather than cached
 * in a module const, so an edit is live in the next bout.
 * ------------------------------------------------------------------------- */

/** The Reset input key. A binding, not a balance number, so it stays here. */
const RESET_KEY = "b";

export function createFatigueState(maxEnergy: number): FatigueState {
  return {
    energy: maxEnergy,
    maxEnergy,
    sampled: false,
    punchesTaken: 0,
    consecutiveTaken: 0,
    duckLagHits: 0,
    vulnStack: 0,
    rhythmBurstTimer: 0,
    staminaCarry: 0,
    swayTimer: 0,
    swayDuration: 0,
    swayDir: 0,
    swayActive: false,
    swayPunch: false,
    resetActive: false,
    resetTimer: 0,
    resetStaminaOnly: false,
    resetLockTimer: 0,
    snapSlowPunches: 0,
    snapSlowGrace: 0,
    snapSlowMult: 1,
    snapTimer: 0,
    snapStagger: getFatigueConfig().resetSnapStagger,
    snapActive: false,
    snapArmHoldLead: 0,
    snapArmHoldRear: 0,
    snapTorsoHold: 0,
    trainBlock: 0,
    trainDamage: 0,
    trainSlip: 0,
    trainSpeed: 0,
    gymChargeLanded: 0,
    gymResetSlips: 0,
    strengthMult: 1,
    headDuckTimer: 0,
    maxStaminaPenalty: 0,
  };
}

/** How far along this fighter's fatigue ramps are, on the punches-taken axis. */
function fatigueRampT(fighter: FighterState, capPunches: number): number {
  if (capPunches <= 0) return 1;
  // strengthMult is a debug dial and sits here rather than on the individual
  // penalties: scaling the ramp means a high setting arrives at the designed
  // maximum off fewer punches, where scaling the penalties would push them past
  // ceilings that assume a 0..1 input (a block reduction can go negative).
  const strength = fighter.fatigue.strengthMult || 1;
  return Math.min(1, Math.max(0, (fighter.fatigue.punchesTaken * strength) / capPunches));
}

/**
 * Has this fighter taken enough punishment to be fatigued at all? This is the
 * gate the stun rule keys off, so it is deliberately the same test everywhere:
 * a fighter still inside their free punches is fresh and cannot be stunned.
 */
export function isFatigued(fighter: FighterState): boolean {
  return fighter.fatigue.punchesTaken > getFatigueConfig().freePunches;
}

/**
 * Is a live Reset still paying for itself? A punch that gets through during the
 * window strips what the Reset was worth without ending it: the fighter keeps
 * the air it buys — see resetDistanceRegenMult, which deliberately reads
 * resetActive rather than this — but eats fatigue at full strength again until
 * they spend another whole Reset. Every other benefit of the window reads this.
 */
export function resetBenefitsActive(fighter: FighterState): boolean {
  const f = fighter.fatigue;
  return !!f?.resetActive && !f.resetStaminaOnly;
}

/**
 * How much of its rated strength fatigue is worth for this fighter right now.
 * A Reset turns everything down to a tenth rather than switching it off, so
 * every fatigue penalty is scaled through here instead of gated on a boolean.
 */
export function fatigueEffectMult(fighter: FighterState): number {
  return resetBenefitsActive(fighter) ? getFatigueConfig().resetEffectMult : 1;
}

/**
 * The stamina recovery multiplier a Reset is worth at this instant.
 *
 * A Reset clears the fatigue wherever it is taken, but it only pays for air
 * when the fighter actually uses it to get out: recovery is multiplied while
 * the window is live AND the two fighters are further apart than the configured
 * gap, centre to centre — the same distance the rest of the engine measures
 * between fighters. Checked every tick rather than latched at the press, so
 * walking back into the pocket ends the boost and backing out again restores
 * it. Both corners are measured identically.
 */
export function resetDistanceRegenMult(fighter: FighterState, state: GameState): number {
  if (!fighter.fatigue?.resetActive) return 1;
  const fc = getFatigueConfig();
  const mult = fc.resetFarRegenMult;
  if (!(mult > 1)) return 1;
  const opp = fighter === state.player ? state.enemy : state.player;
  if (!opp) return 1;
  const dx = fighter.x - opp.x;
  const dz = fighter.z - opp.z;
  return Math.sqrt(dx * dx + dz * dz) > fc.resetFarDistancePx ? mult : 1;
}

/**
 * Is the inertia sway playing at all? Still true at a tenth strength.
 * Optional-chained: the renderer reuses drawFighter for menu and roster
 * previews, whose stub fighters are not built through createFighter.
 */
export function isFatigueSwaying(fighter: FighterState): boolean {
  return !!fighter.fatigue?.swayActive;
}

/**
 * Is the sway playing at FULL strength? The one place this matters is perfect
 * block, which is refused outright by a real sway but works as normal through
 * the damped one a Reset leaves behind.
 */
export function isFatigueSwayFull(fighter: FighterState): boolean {
  return !!fighter.fatigue?.swayActive && !resetBenefitsActive(fighter);
}

/** 0..1 through the torso sway. */
export function fatigueSwayProgress(fighter: FighterState): number {
  const f = fighter.fatigue;
  if (!f.swayActive || f.swayDuration <= 0) return 1;
  return Math.min(1, Math.max(0, f.swayTimer / f.swayDuration));
}

/** True when this fighter's lead hand is the left one, i.e. they box orthodox. */
function fatigueLeadIsLeft(fighter: FighterState): boolean {
  return fighter.boxingStance !== "southpaw";
}

/**
 * 0..1 through the ARM sway. Both forearms trail the torso by the config's
 * armLagFrac, and the rear one trails the lead one by a further armStaggerFrac.
 * Each arm still finishes exactly when the sway does, so a late starter never
 * gets cut off mid-travel.
 *
 * `isLeft` omitted reads the lead arm — that's what the punch-input gate wants,
 * since the first arm back in place is the one that frees the input.
 */
export function fatigueArmProgress(fighter: FighterState, isLeft?: boolean): number {
  const p = fatigueSwayProgress(fighter);
  const isRear = isLeft !== undefined && isLeft !== fatigueLeadIsLeft(fighter);
  const fc = getFatigueConfig();
  const start = fc.armLagFrac + (isRear ? fc.armStaggerFrac : 0);
  return Math.min(1, Math.max(0, (p - start) / (1 - start)));
}

/**
 * Signed sway travel for the renderer, in units of "full sway distance", for
 * the torso and for the trailing forearms. Out and back over the sway's life.
 */
export function fatigueSwayOffsets(
  fighter: FighterState
): { torso: number; armLead: number; armRear: number } {
  if (!isFatigueSwaying(fighter)) {
    // A Reset tears the sway down, but the torso still has to travel home. It
    // eases out of its frozen pose over the snap's first stage; the forearms
    // follow in theirs, via fatigueArmSnapHold.
    const f = fighter.fatigue;
    if (!f?.snapActive || f.snapStagger <= 0 || f.snapTorsoHold === 0) {
      return { torso: 0, armLead: 0, armRear: 0 };
    }
    return {
      torso: f.snapTorsoHold * snapEaseOut(f.snapTimer / f.snapStagger),
      armLead: 0,
      armRear: 0,
    };
  }
  const fc = getFatigueConfig();
  const intensity = fatigueRampT(fighter, fc.swayTimeCapPunches)
    * fc.swayDistRampMax * fatigueEffectMult(fighter);
  const dir = fighter.fatigue.swayDir;
  const lead = fatigueLeadIsLeft(fighter);
  return {
    torso: Math.sin(Math.PI * fatigueSwayProgress(fighter)) * intensity * dir,
    armLead: Math.sin(Math.PI * fatigueArmProgress(fighter, lead)) * intensity * dir,
    armRear: Math.sin(Math.PI * fatigueArmProgress(fighter, !lead)) * intensity * dir,
  };
}

/**
 * Fraction of full sway travel, exposed so the renderer owns no tuning. A call
 * rather than a const because the value is now editable at runtime — a module
 * const would freeze whatever it read at import time.
 */
export function fatigueSwaySlipFraction(): number {
  return getFatigueConfig().swayDistFracOfSlip;
}

/** Playback speed for the whole Reset snap. Clamped off zero so it can't stall. */
function resetSnapSpeed(): number {
  return Math.max(0.01, getFatigueConfig().resetSnapSpeedMult);
}

/**
 * How far the Reset's travel is exaggerated over the ordinary fatigue sway it
 * is easing out of. The gesture is a readability cue — a Reset should be
 * legible from across the ring — so it is scaled up rather than retracing the
 * sway's own modest distance.
 *
 * Applied at the render read rather than baked into the stored holds, which
 * stay in raw sway units: tryReset re-captures those holds when a Reset lands
 * during an earlier one's snap, and a scaled hold would be scaled twice.
 *
 * Returns 1 whenever a fresh sway has started over the top of a running snap,
 * because at that point what is being drawn is the sway, not the Reset.
 */
export function resetSnapDistanceMult(fighter: FighterState): number {
  const f = fighter.fatigue;
  if (!f?.snapActive || isFatigueSwaying(fighter)) return 1;
  return getFatigueConfig().resetSnapDistMult;
}

/**
 * Ease a frozen pose out to nothing over 0..1 — smoothstep, run backwards, so
 * the limb leaves and arrives without a visible edge at either end.
 */
function snapEaseOut(t: number): number {
  const c = Math.min(1, Math.max(0, t));
  return 1 - c * c * (3 - 2 * c);
}

/**
 * Seconds this fighter's duck is currently running behind the input that asked
 * for it. Every punch taken since their last Reset adds duckLagPerHit, and the
 * Reset is the only thing that clears the debt. The same rule in both corners:
 * a worn-down AI is late onto its duck exactly as a worn-down player is.
 *
 * The debt stops growing at duckLagMax, so a fighter who never resets ends up
 * permanently late rather than unable to duck at all. A cap of 0 lifts the
 * ceiling; zero duckLagPerHit to switch the lag off instead.
 */
export function duckLagSeconds(fighter: FighterState): number {
  const hits = fighter.fatigue?.duckLagHits ?? 0;
  if (hits <= 0) return 0;
  const fc = getFatigueConfig();
  const lag = hits * fc.duckLagPerHit;
  return fc.duckLagMax > 0 ? Math.min(lag, fc.duckLagMax) : lag;
}

/**
 * Is this fighter actually down in a crouch, as opposed to having merely asked
 * for one? defenseState flips to "duck" the instant the input or the AI calls
 * for it, but a worn-down fighter's body takes duckLagSeconds to get there —
 * and until it does they are still standing up into whatever is coming.
 *
 * This is the read for everything the crouch physically DOES. Intent reads —
 * what a fighter is aiming at, what the AI sees its opponent committing to —
 * stay on defenseState, because those are decisions rather than positions.
 */
export function isDuckLive(fighter: FighterState): boolean {
  if (fighter.defenseState !== "duck") return false;
  return (fighter.duckHoldTime ?? 0) >= duckLagSeconds(fighter);
}

/**
 * A punch reached this fighter. The single accrual point for Energy — every
 * punch taken comes through here, blocked or clean, so the drain cannot be
 * bypassed by a call site that forgets it.
 */
function onPunchTaken(fighter: FighterState, state: GameState): void {
  const f = fighter.fatigue;
  const fc = getFatigueConfig();
  f.punchesTaken++;
  // Career bouts charge a fighter for what they are eating: every punch that
  // gets through banks resetSnapSlowPerPunch onto how long their NEXT Reset
  // takes to play. A perfect block never reaches this function, which is the
  // read that buys out of it. The first resetSnapSlowGraceHits punches after a
  // Reset are owed to the grace rather than banked, so the snap cannot start
  // dragging again off the same exchange the Reset just answered.
  if (state.careerFightMode && !state.sparringMode) {
    if (f.snapSlowGrace > 0) f.snapSlowGrace--;
    else f.snapSlowPunches++;
  }
  // Above the grace on purpose: the free punches buy a fighter out of the
  // energy drain, not out of having their reactions worn down. Every punch
  // that reaches them pushes their duck further behind their input.
  f.duckLagHits++;
  // Same deal for the rhythm: a fighter who keeps eating shots without buying
  // the fatigue off with a Reset gets easier to catch on the turn, the green
  // zone at each end of their arc widening by vulnPerHit per punch. Only
  // punches that actually got through count — the call site already excludes a
  // perfect block, which is the read that earns its way out of this.
  f.vulnStack++;
  if (f.punchesTaken <= fc.freePunches) return;

  f.consecutiveTaken++;
  const steps = f.consecutiveTaken - 1;
  const cost = fc.energyBaseCost +
    Math.min(fc.energyEscalationCap, steps * fc.energyEscalation);
  // Uncapped on the way down: Energy is allowed past zero, and the ramps that
  // read it are all clamped on the punch count instead.
  f.energy -= cost;

  f.staminaCarry += cost;
  const stepSize = Math.max(0.0001, fc.energyPerStaminaStep);
  const converted = Math.floor(f.staminaCarry / stepSize);
  if (converted > 0) {
    f.staminaCarry -= converted * stepSize;
    const perStep = fc.staminaPerStep +
      Math.min(fc.staminaEscalationCap, steps * fc.staminaEscalation);
    fighter.stamina = Math.max(0, fighter.stamina - converted * perStep);
  }
}

/** Arm a fresh inertia sway in the direction the fighter last walked. */
function startFatigueSway(fighter: FighterState): void {
  const f = fighter.fatigue;
  const dir = fighter.lastWalkDir;
  if (dir === "none") return;
  f.swayActive = true;
  f.swayTimer = 0;
  f.swayDir = dir === "forward" ? 1 : -1;
  const fc = getFatigueConfig();
  f.swayDuration = fc.swayTimeMin +
    (fc.swayTimeMax - fc.swayTimeMin) * fatigueRampT(fighter, fc.swayTimeCapPunches);
}

/** Cancel the sway outright — used by Reset and by every bout interruption. */
function clearFatigueSway(fighter: FighterState): void {
  const f = fighter.fatigue;
  f.swayActive = false;
  f.swayTimer = 0;
  f.swayDuration = 0;
}

/**
 * The Reset action itself. Returns false when it was refused, so the caller can
 * leave the input unconsumed rather than silently eating it.
 */
export function tryReset(fighter: FighterState, state: GameState): boolean {
  const f = fighter.fatigue;
  const fc = getFatigueConfig();
  if (fighter.isKnockedDown || state.knockdownActive) return false;
  // No cooldown and no in-window refusal: pressing Reset again mid-snap starts
  // a fresh snap (and a fresh window), so the button is always live outside a
  // knockdown or a stun lock. This is also how a window a punch has stripped
  // gets its benefits back.
  // Stunned fighters cannot buy their way out of it — see applyResetStunLock.
  if (f.resetLockTimer > 0) return false;

  // Panic Reset: pressing it while still rocked from a punch costs max stamina
  // for the rest of the bout, down to a floor. What it costs is a Max Stamina
  // event like every other pool-mover, so it carries that card's points/percent
  // unit and its off switch; only the window that counts as "still rocked" and
  // the floor the bite stops at stay on the fatigue card. Base is recovered from
  // the running penalty so no separate bout-start snapshot has to be kept in
  // sync. Signed like the rest of the registry: a positive amount hands tank
  // back through the registry's own restore path instead of taking it.
  //
  // A Reset timed into a bait is the exception: a feint still in the air, or an
  // opponent sitting in a duck, is something the fighter read rather than
  // panicked at, so it costs nothing at all. The flinch that bait was fishing
  // for is refused below like any other one following a Reset.
  const readingBait = flinchBaitBeingRead(fighter, state);
  if (!readingBait && fighter.timeSinceLastDamageTaken < fc.resetPanicWindow) {
    const panic = maxStamAmount(fighter, "resetPanic");
    if (panic < 0) {
      const base = fighter.maxStamina + f.maxStaminaPenalty;
      const allowance = base * (1 - fc.resetPanicFloor) - f.maxStaminaPenalty;
      const bite = Math.min(-panic, Math.max(0, allowance));
      if (bite > 0) {
        fighter.maxStamina -= bite;
        f.maxStaminaPenalty += bite;
        fighter.stamina = Math.min(fighter.stamina, fighter.maxStamina);
      }
    } else if (panic > 0) {
      applyMaxStaminaDelta(fighter, panic);
    }
  }

  // Freeze where the torso and each arm were before the sway is torn down. None
  // of them jump home: each eases out of the pose it is holding when its stage
  // of the stagger below comes round.
  const heldSway = fatigueSwayOffsets(fighter);
  f.snapTorsoHold = heldSway.torso;
  f.snapArmHoldLead = heldSway.armLead;
  f.snapArmHoldRear = heldSway.armRear;

  clearFatigueSway(fighter);
  f.resetActive = true;
  // A whole new Reset is what buys the benefits back after a punch stripped
  // them off the last one.
  f.resetStaminaOnly = false;
  // Both escalations are what the fighter actually bought with the Reset.
  f.consecutiveTaken = 0;
  f.staminaCarry = 0;
  // So is a duck that answers the input again instead of trailing it.
  f.duckLagHits = 0;
  // And so is a rhythm that has been widening with every shot eaten since the
  // last one: the window goes back to its base width.
  f.vulnStack = 0;
  // The flinch reaction goes back to full strength — a composed fighter reacts
  // to what is in front of them again instead of being numb to it — and the
  // hands come home out of any flinch that was playing. Resetting just before
  // the opponent throws also buys a pass on the next one.
  fighter.flinchReactions = 0;
  fighter.flinchTimer = 0;
  fighter.flinchNegateTimer = Math.max(0, fc.flinchResetNegateWindow);

  // The staggered snap, stretched by how gassed the fighter is and then played
  // at the configured speed.
  const staminaFrac = fighter.maxStamina > 0
    ? Math.min(1, Math.max(0.01, fighter.stamina / fighter.maxStamina))
    : 0.01;
  const snapSpeed = resetSnapSpeed();
  // Sparring mileage is bought off the stagger itself, before the gassed-fighter
  // stretch and the animation speed multiply it: a fighter who spars keeps their
  // Reset crisp for longer, rather than being handed a flat bonus that a tired
  // fighter never feels.
  const trainedStagger = Math.max(0, fc.resetSnapStagger - Math.max(0, f.trainSpeed ?? 0));
  // Punishment banked since the last Reset, career bouts only (see
  // onPunchTaken): the whole snap drags by resetSnapSlowPerPunch for every
  // punch that got through. Spending the Reset spends the bank — it plays at
  // the length the fighter earned and the count goes back to its trained
  // baseline, with the next few punches owed to the grace before it fills
  // again. Multiplied on top of the gassed-fighter stretch rather than folded
  // into it: the two are separate reasons for the same snap to drag. Kept on
  // the state so the head dip can be read back against the same length.
  const snapSlow = 1 + Math.max(0, f.snapSlowPunches) * Math.max(0, fc.resetSnapSlowPerPunch);
  f.snapSlowMult = snapSlow;
  f.snapSlowPunches = 0;
  f.snapSlowGrace = Math.max(0, fc.resetSnapSlowGraceHits);
  f.snapStagger = trainedStagger
    * (fc.resetSnapSlowMax - (fc.resetSnapSlowMax - 1) * staminaFrac) * snapSlow / snapSpeed;
  f.snapTimer = 0;
  f.snapActive = true;
  // The window lasts exactly as long as the snap animation: it closes when the
  // rear arm is home (see updateFatigue), so it is always well under a second
  // or two, however gassed the fighter is.
  f.headDuckTimer = fc.resetHeadDuckTime * snapSlow / snapSpeed;
  // The window IS the snap animation: torso → lead → rear arm plus the head
  // dip, whichever runs longer. Sparring mileage can train the stagger all the
  // way to 0 (RESET_SPEED_MAX equals the default stagger); without the dip in
  // here that left a head bob with a one-tick window and no Reset.
  f.snapDuration = Math.max(f.snapStagger * 3, f.headDuckTimer);
  f.resetTimer = f.snapDuration;

  // The rhythm kicks instead of parking. A Reset throws the sway into a
  // full-speed sweep for resetRhythmBurst seconds — running whether or not the
  // feet are moving, so the fighter visibly works the rhythm back rather than
  // snapping to a standstill — and then hands the rhythm straight back to their
  // footwork: their own sweep if they are walking, the front-foot park if they
  // are not. Any rhythm-cut hold is cleared so the burst starts clean, and the
  // burst self-heals by counting down, so a Reset cut short cannot strand it.
  fighter.rhythmPauseTimer = 0;
  f.rhythmBurstTimer = Math.max(0, fc.resetRhythmBurst);
  return true;
}

/**
 * How far this arm is still held out in its pre-Reset pose, in units of full
 * sway distance. The torso snaps immediately, the lead arm one stagger later
 * and the rear arm one after that — mirrored for a southpaw, whose lead hand is
 * the right. Zero once the arm has been released.
 */
export function fatigueArmSnapHold(fighter: FighterState, isLeft: boolean): number {
  const f = fighter.fatigue;
  if (!f?.snapActive || f.snapStagger <= 0) return 0;
  const isLead = isLeft === fatigueLeadIsLeft(fighter);
  const held = isLead ? f.snapArmHoldLead : f.snapArmHoldRear;
  if (held === 0) return 0;
  // The arm sits still through the stages ahead of it, then eases home over its
  // own — it never blinks back to neutral the frame its turn arrives.
  const easeFrom = isLead ? f.snapStagger : f.snapStagger * 2;
  if (f.snapTimer < easeFrom) return held;
  return held * snapEaseOut((f.snapTimer - easeFrom) / f.snapStagger);
}

/**
 * Screen-space head dip for the snap that opens a Reset: down and back up over
 * the dip's own lifetime. Zero whenever no dip is running.
 */
export function resetHeadDuckOffset(fighter: FighterState): number {
  const t = fighter.fatigue?.headDuckTimer ?? 0;
  if (t <= 0) return 0;
  const fc = getFatigueConfig();
  // Against the length this dip was actually armed with: a career fighter who
  // has been eating punches gets a slower snap, and the curve has to be read
  // over the same stretch or the dip jumps at the end of it.
  const dipTime = Math.max(0.0001, fc.resetHeadDuckTime * Math.max(0.0001, fighter.fatigue?.snapSlowMult ?? 1) / resetSnapSpeed());
  const prog = Math.max(0, Math.min(1, 1 - t / dipTime));
  // Scaled by the same travel multiplier as the torso and arms so the whole
  // gesture grows together rather than the head staying behind.
  return Math.sin(Math.PI * prog) * fc.resetHeadDuckPx * fc.resetSnapDistMult;
}

/**
 * Whether a CPU corner may spend a Reset at all in this bout. Ordinary gym
 * sparring and Nightmare are the player's rooms to work in: the partner never
 * buys its own fatigue off there, so whatever the player puts on it stays on
 * it. Career bouts, the Doghouse and quick fights are untouched — the single
 * gate for every AI Reset path, so neither one can drift from the other.
 */
export function aiResetAllowed(state: GameState): boolean {
  if (state.nightmareMode) return false;
  if (!state.sparringMode || state.doghouseMode) return true;
  // The champion partner is the exception: at that tier the room is meant to
  // fight back properly, so it buys its fatigue off the way an opponent would.
  // Nightmare shares the champion difficulty and is excluded above, not here.
  return state.aiDifficulty === "champion";
}

/**
 * A CPU-controlled fighter spends a Reset the moment it gets stunned or crit —
 * the same read a player is expected to make. Refused while its own snap runs, like before
 * else's, and it pays the panic penalty for resetting while still rocked.
 * Called after the hit has already ended any window that was running.
 */
function aiMaybeReset(fighter: FighterState, state: GameState): void {
  const cpuControlled = !fighter.isPlayer || !!state.playerAiBrain;
  if (!cpuControlled) return;
  if (!aiResetAllowed(state)) return;
  // Only the player may restart a running snap; the CPU's reflex Reset keeps
  // the old one-at-a-time behaviour so its output is unchanged.
  if (fighter.fatigue.resetActive) return;
  tryReset(fighter, state);
}

/** Centre-to-centre gap, measured the way the Reset's far-regen bonus measures it. */
function fighterGapPx(a: FighterState, b: FighterState): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

/**
 * Was the defender answering the shot rather than just wearing it? Anything
 * here, taken between the punch launching and it reaching full extension, is
 * what a flinch is the absence of.
 */
function flinchDefenceActive(defender: FighterState): boolean {
  if (defender.perfectBlockState === "rising" || defender.perfectBlockState === "active") return true;
  if (defender.slipActive) return true;
  if (resetBenefitsActive(defender)) return true;
  if (defender.defenseState === "duck") return true;
  return false;
}

/**
 * Planted feet do not flinch: a fighter has to be carrying their weight around
 * for the shot to catch their hands out of position at all. The exception is
 * the opponent dropping into a crouch — a fighter working the levels draws the
 * reaction out of a standing defender too.
 */
function flinchMotionOk(defender: FighterState, attacker: FighterState): boolean {
  return defender.currentMoveDir !== "none" || attacker.defenseState === "duck";
}

/**
 * A feint only sells while the fighter is still honest about that punch. The
 * books are kept per punch AND per stance — an orthodox jab and a southpaw jab
 * are two different sells — and the allowance is a ratio: one committed punch
 * buys flinchFeintRatioLimit feints of the same punch. Past that the fighter is
 * crying wolf, and their feints of that punch stop drawing a reaction until a
 * real one goes out and closes the ratio again.
 *
 * Only what happens inside flinchRangePx counts on either side of it: selling
 * from out of range is not selling anything, and a real punch thrown from out
 * there does not buy the fighter's credibility back.
 *
 * Returns whether THIS punch, being a feint, is still inside its allowance.
 */
function noteFlinchPunchRatio(fighter: FighterState, opponent: FighterState, isFeint: boolean): boolean {
  const punch = fighter.currentPunch;
  if (!punch || !opponent) return false;
  const fc = getFatigueConfig();
  if (fighterGapPx(fighter, opponent) > Math.max(0, fc.flinchRangePx)) return false;
  const key = `${punch}|${fighter.boxingStance === "southpaw" ? "southpaw" : "orthodox"}`;
  const counts = fighter.feintFlinchCounts;
  if (!isFeint) {
    // The committed punch that pays for the next batch.
    counts[key] = 0;
    return false;
  }
  const limit = Math.max(0, Math.floor(fc.flinchFeintRatioLimit));
  // Parked one past the limit: the count only has to say "spent".
  const sold = Math.min(limit + 1, (counts[key] ?? 0) + 1);
  counts[key] = sold;
  return sold <= limit;
}

/**
 * The reaction flinch: the defender's hands slide out of position for a beat
 * because something happened in their face and they did nothing about it.
 * Three things draw it, all inside flinchRangePx — a feint reaching full
 * extension, a punch landing, and the opponent dropping into a crouch.
 *
 * Which way the hands go is a read on where the opponent has been working:
 * forward and down if the body has been taking most of it, forward and high if
 * the head has, a coin flip when they are level. Each reaction takes
 * flinchDecayPerReaction off the next one — the fighter gets used to it — and
 * spending a Reset puts that back to full.
 */
export function triggerFlinch(defender: FighterState, attacker: FighterState, state: GameState): void {
  if (!defender || !attacker || defender === attacker) return;
  if (state.phase !== "fighting" || state.knockdownActive || state.isPaused) return;
  if (defender.isKnockedDown || attacker.isKnockedDown) return;
  const fc = getFatigueConfig();
  if (fighterGapPx(defender, attacker) > Math.max(0, fc.flinchRangePx)) return;
  if (!flinchMotionOk(defender, attacker)) return;
  if (flinchDefenceActive(defender)) return;
  // A Reset spent just before the shot came steadies the hands through exactly
  // one reaction, and is spent doing it.
  if (defender.flinchNegateTimer > 0) {
    defender.flinchNegateTimer = 0;
    return;
  }
  const decay = Math.max(0, defender.flinchReactions) * Math.max(0, fc.flinchDecayPerReaction);
  const mag = Math.max(0, fc.flinchBasePx) * Math.max(0, 1 - decay);
  defender.flinchReactions++;
  if (mag <= 0) return;
  const head = defender.shotsTakenHead;
  const body = defender.shotsTakenBody;
  defender.flinchDirY = body > head ? 1 : head > body ? -1 : (Math.random() < 0.5 ? 1 : -1);
  defender.flinchMag = mag;
  defender.flinchDuration = Math.max(0.01, fc.flinchDuration);
  defender.flinchTimer = defender.flinchDuration;
}

/**
 * Is the opponent showing this fighter something to read right now? A punch is
 * answerable from the moment it launches until it lands, and that flight is the
 * window a Reset has to be timed into; a duck the opponent is holding is the
 * one bait with no punch of its own to time against.
 *
 * Only a feint counts on the punch side. Resetting into a real punch is exactly
 * the panic the max-stamina penalty exists for — it is a read only if nothing
 * was ever coming.
 */
function flinchBaitBeingRead(fighter: FighterState, state: GameState): boolean {
  const opponent = fighter === state.player ? state.enemy : state.player;
  if (!opponent) return false;
  if (fighterGapPx(fighter, opponent) > Math.max(0, getFatigueConfig().flinchRangePx)) return false;
  if (opponent.defenseState === "duck") return true;
  return !!opponent.isFeinting && opponent.isPunching
    && (opponent.punchPhase === "launchDelay" || opponent.punchPhase === "armSpeed");
}

/** True while the hands are out of position — the guard is bypassed for it. */
export function isFlinching(fighter: FighterState): boolean {
  return (fighter?.flinchTimer ?? 0) > 0;
}

/**
 * How far this arm has been dragged out of the guard right now, in px: forward
 * along the punch direction, and up or down the screen. Out and back over the
 * flinch's life, with the same limb delay the fatigue sway uses, so the rear
 * hand trails the lead one instead of both snapping together.
 */
export function flinchArmOffsets(fighter: FighterState, isLeft: boolean): { forward: number; vertical: number } {
  const timer = fighter?.flinchTimer ?? 0;
  const dur = fighter?.flinchDuration ?? 0;
  if (timer <= 0 || dur <= 0) return { forward: 0, vertical: 0 };
  const fc = getFatigueConfig();
  const p = Math.min(1, Math.max(0, 1 - timer / dur));
  const isRear = isLeft !== fatigueLeadIsLeft(fighter);
  const start = fc.armLagFrac + (isRear ? fc.armStaggerFrac : 0);
  const armP = Math.min(1, Math.max(0, (p - start) / Math.max(0.01, 1 - start)));
  const travel = Math.sin(Math.PI * armP) * (fighter.flinchMag ?? 0);
  return { forward: travel, vertical: travel * (fighter.flinchDirY ?? 1) };
}

/**
 * Per-tick flinch bookkeeping. The crouch trigger lives here because, unlike a
 * feint or a landed punch, a duck has no moment of its own to fire from: the
 * crouch going live is the edge.
 */
function updateFlinch(fighter: FighterState, dt: number, state: GameState): void {
  if (fighter.flinchTimer > 0) fighter.flinchTimer = Math.max(0, fighter.flinchTimer - dt);
  if (fighter.flinchNegateTimer > 0) fighter.flinchNegateTimer = Math.max(0, fighter.flinchNegateTimer - dt);
  // The input, not the crouch: a duck asked for is a duck the other corner has
  // to read, and it is the same input that lets a standing defender flinch.
  const ducking = fighter.defenseState === "duck";
  if (ducking && !fighter.flinchDuckSeen) {
    const opponent = fighter === state.player ? state.enemy : state.player;
    if (opponent) triggerFlinch(opponent, fighter, state);
  }
  fighter.flinchDuckSeen = ducking;
}

/** Per-tick fatigue bookkeeping: sway lifecycle, Reset window, timers. */
/** Length of the running snap animation = the Reset window. Old states lack snapDuration. */
function snapLength(f: FighterState["fatigue"]): number {
  return Math.max(f.snapStagger * 3, f.snapDuration ?? 0);
}

function updateFatigue(fighter: FighterState, dt: number, state: GameState): void {
  const f = fighter.fatigue;
  updateFlinch(fighter, dt, state);

  // The stun lockout burns off through the rest of the bout: a fighter who is
  // being stopped from resetting is not being asked to do anything.
  if (f.resetLockTimer > 0) f.resetLockTimer = Math.max(0, f.resetLockTimer - dt);
  if (f.headDuckTimer > 0) f.headDuckTimer = Math.max(0, f.headDuckTimer - dt);
  // The post-Reset rhythm kick. Ticked here rather than in the sway so it runs
  // out on its own clock even if the sway is held by something else.
  if (f.rhythmBurstTimer > 0) f.rhythmBurstTimer = Math.max(0, f.rhythmBurstTimer - dt);

  if (f.snapActive) {
    f.snapTimer += dt;
    // Three stages now, not two: torso, then lead arm, then rear arm, each
    // easing home over one stagger instead of vanishing at the end of its hold.
    if (f.snapTimer >= snapLength(f)) {
      f.snapActive = false;
      // The whole animation has played: that is what counts as fully reset,
      // and it is also the end of the Reset window.
      onResetFullyPlayed(fighter);
    }
  }

  // The Reset window is the snap animation: it ends the moment the snap does.
  // Deliberately no early return while it runs: a Reset damps fatigue rather
  // than switching it off, so the sway keeps running underneath the window.
  if (f.resetActive) {
    f.resetTimer = f.snapActive ? Math.max(0, snapLength(f) - f.snapTimer) : 0;
    if (!f.snapActive) {
      f.resetActive = false;
      f.resetStaminaOnly = false;
    }
  }

  const fighting = state.phase === "fighting" && !state.knockdownActive && !state.isPaused;
  if (!fighting || fighter.isKnockedDown) {
    clearFatigueSway(fighter);
    return;
  }

  // First fighting tick of the bout: take the Energy ceiling off the pool as it
  // actually stands, now that every mode rescale has been applied to it.
  if (!f.sampled) {
    f.sampled = true;
    f.maxEnergy = fighter.stamina;
    f.energy = fighter.stamina;
  }

  if (f.swayActive) {
    f.swayTimer += dt;
    if (f.swayTimer >= f.swayDuration) clearFatigueSway(fighter);
  }

  // Walking while fatigued is what drags the sway along behind the fighter, so
  // it re-arms for as long as the feet keep moving.
  if (!f.swayActive && isFatigued(fighter) && fighter.currentMoveDir !== "none") {
    startFatigueSway(fighter);
  }
}

/**
 * Is punch input being swallowed by the sway right now? Inputs arriving before
 * the ARM sway is far enough along are dropped outright rather than buffered —
 * the hand is not where the fighter thinks it is.
 */
export function fatigueBlocksPunchInput(fighter: FighterState): boolean {
  if (!isFatigueSwaying(fighter)) return false;
  return fatigueArmProgress(fighter) < getFatigueConfig().swayInputGate * fatigueEffectMult(fighter);
}

/**
 * A punch reached this fighter mid-Reset. The window is not torn down — it runs
 * to its end so the air a Reset buys keeps being paid — but everything else the
 * Reset was worth switches off until the fighter spends a whole new one:
 * fatigue goes back to full strength, the sway hardens up again and the trained
 * slip speed inside the window stops applying. A new Reset can't be spent
 * until this window has run out. Idempotent, so further punches inside the same
 * window change nothing.
 */
function stripResetOnHit(fighter: FighterState): void {
  const f = fighter.fatigue;
  if (!f.resetActive) return;
  f.resetStaminaOnly = true;
}

const BLINK_LENGTH = 0.12;

/** Close the eyes for one blink. The quiet is the caller's to respect. */
function startBlink(f: FighterState, duration: number = BLINK_LENGTH): void {
  f.isBlinking = true;
  f.blinkDuration = duration;
}

/**
 * How long each blink of the stun lockout's double tell lasts. Short enough
 * that both of them, half a window apart, finish inside the window.
 */
function stunLockBlinkLength(): number {
  return Math.min(BLINK_LENGTH, Math.max(0.02, getFatigueConfig().stunLockBlinkWindow * 0.3));
}

/**
 * The Reset played all the way through. One blink marks it landing, and then
 * the eyes stay open: resetBlinkQuietMax seconds for a fighter who has taken
 * nothing this bout, falling in a straight line to resetBlinkQuietMin by
 * resetBlinkQuietCapPunches punches taken — a fighter who has been eating shots
 * all night is back to blinking almost at once. Nothing reopens the quiet
 * early, not even a stun lockout wanting its own tell.
 */
function onResetFullyPlayed(fighter: FighterState): void {
  const fc = getFatigueConfig();
  const cap = Math.max(1, fc.resetBlinkQuietCapPunches);
  const t = Math.max(0, Math.min(1, fighter.fatigue.punchesTaken / cap));
  fighter.blinkQueued = 0;
  fighter.blinkQueueTimer = 0;
  startBlink(fighter);
  // Armed alongside the blink rather than after it: the quiet only withholds
  // blinks that have not started, so the one marking the Reset still plays.
  fighter.blinkQuietTimer = Math.max(0, fc.resetBlinkQuietMax + (fc.resetBlinkQuietMin - fc.resetBlinkQuietMax) * t);
}

/**
 * A stun locks the fighter out of Reset. Defense decides for how long:
 * resetStunLockMax seconds for a fighter with none of the stat, down a straight
 * line to resetStunLockMin at its cap — so the answer to fatigue is the first
 * thing a stun takes off a defensively soft fighter.
 *
 * Armed the instant the punch lands rather than inside applyStunEffects: a
 * corner's own reflex Reset off a stun or crit is applied later in the same
 * hit, and would otherwise get one in underneath the lock.
 */
export function applyResetStunLock(fighter: FighterState): void {
  const fc = getFatigueConfig();
  const t = Math.max(0, Math.min(1, fighter.defenseT ?? 0));
  const lock = Math.max(0, fc.resetStunLockMax + (fc.resetStunLockMin - fc.resetStunLockMax) * t);
  const f = fighter.fatigue;
  f.resetLockTimer = Math.max(f.resetLockTimer, lock);
  // The tell: two blinks half a window apart, so a fighter who cannot answer
  // reads off the fighter themselves. The post-Reset quiet outranks it — that
  // one holds the eyes open no matter what put the lockout on.
  if (fighter.blinkQuietTimer <= 0) {
    startBlink(fighter, stunLockBlinkLength());
    fighter.blinkQueued = 1;
    fighter.blinkQueueTimer = Math.max(0, fc.stunLockBlinkWindow) / 2;
  }
}

/**
 * Seconds this fighter needs to slide into a slip: their raw speed stat sets the
 * base, and Slippery divides it down. Clamped at 1 so the refinement can only
 * ever make the slip quicker, never slower.
 */
function slipEnterDuration(f: FighterState): number {
  const t = Math.max(0, Math.min(1, (f.rawSpeed ?? 0) / SLIP_ENTER_SPEED_CAP));
  const base = SLIP_ENTER_SLOW + (SLIP_ENTER_FAST - SLIP_ENTER_SLOW) * t;
  // Slipping inside your own Reset is the one thing fatigue training makes
  // quicker rather than merely less bad, and only while the window is open.
  const trained = resetBenefitsActive(f) ? 1 + (f.fatigue.trainSlip ?? 0) / 100 : 1;
  return base / (Math.max(1, f.slipperySpeedMult ?? 1) * trained);
}

/**
 * Take the head off the punch line. Shared by the player's key handler and the
 * AI, which arms the same slip in place of a perfect block; the AI shortens the
 * hold afterwards rather than sitting on the full two seconds.
 */
/**
 * Take the price of one slip out of the fighter and step the chain on. An open
 * chain window makes this slip consecutive — a step dearer than the last — and
 * every charge re-arms that window, not just the first. Re-aiming a slip that is
 * already up is free; only starting one is charged.
 */
function chargeSlip(f: FighterState): void {
  f.slipChainCount = f.slipChainTimer > 0 ? (f.slipChainCount || 0) + 1 : 0;
  f.slipChainTimer = SLIP_CHAIN_WINDOW;
  const costPct = SLIP_STAMINA_COST + f.slipChainCount * SLIP_STAMINA_COST_STEP;
  // Rounded up to a whole point, so a slip always costs something the bar shows.
  f.stamina = Math.max(0, f.stamina - Math.ceil(f.maxStamina * costPct));
}

export function startSlip(f: FighterState, dir: SlipDir): void {
  if (f.slipDisabledTimer > 0 || f.isKnockedDown) return;
  // Slipping inside your own Reset is what buys Reset slip speed. Counted here
  // because every slip funnels through this one function; whether the tally is
  // worth anything is decided at the fold, which only banks gym work.
  if (f.fatigue?.resetActive) f.fatigue.gymResetSlips++;
  chargeSlip(f);
  f.slipActive = true;
  f.slipDir = dir;
  f.slipLeanDir = dir;
  f.slipTimer = 0;
  // Stamped once, so the slide, the dodge window and the AI's read on its own
  // timing all measure the same slip against the same number.
  f.slipEnterDuration = slipEnterDuration(f);
  // Re-slipping before the last one has snapped all the way back picks up where
  // the lean is rather than dropping the torso and starting again.
  f.slipLeanStart = Math.max(0, Math.min(1, f.slipLean));
  f.slipSwitchFrom = null;
  f.slipHoldTimer = SLIP_MAX_HOLD;
}

/**
 * Re-aim a slip that is already up. The head does not jump across: it travels
 * back off the side it is on, through the middle, and out the other one. Leaving
 * a finished slip costs 1.75x a fresh slide; changing direction while still on
 * the way into one costs nothing extra, since there is no slipped position to
 * come out of yet. Either way the slide clock restarts, so the head is hittable
 * for the whole journey and only dodges again once it has arrived. No stamina is
 * charged: the slip was paid for when it started.
 */
export function redirectSlip(f: FighterState, dir: SlipDir): void {
  if (!f.slipActive || dir === f.slipDir) return;
  const wasCompleted = f.slipTimer >= f.slipEnterDuration;
  f.slipDir = dir;
  // The side the head is actually on right now, which is not necessarily the
  // side of the slip being replaced — a crossover can be re-aimed mid-flight.
  f.slipSwitchFrom = f.slipLeanDir;
  f.slipLeanStart = Math.max(0, Math.min(1, f.slipLean));
  f.slipTimer = 0;
  f.slipEnterDuration = slipEnterDuration(f) * (wasCompleted ? SLIP_SWITCH_TIME_MULT : 1);
}

/** End a slip. The lean is deliberately left alone so the torso snaps back. */
export function endSlip(f: FighterState): void {
  f.slipActive = false;
  f.slipTimer = 0;
  f.slipHoldTimer = 0;
  // The per-slip stamps go with it, so nothing is left describing a slip that is
  // over. Both are re-stamped by the next startSlip.
  f.slipEnterDuration = 0;
  f.slipLeanStart = 0;
  f.slipSwitchFrom = null;
}

/** How long the AI holds a slip it read — enough to cover the shot, no more. */
export const AI_SLIP_HOLD = 0.4;

/** Cancel a scheduled slip and drop the attempt it was going to be graded on. */
export function cancelPendingSlip(f: FighterState): void {
  f.slipPendingTimer = 0;
  f.slipPendingDir = null;
  f.slipReadAttemptTimer = 0;
}

/** Per-frame slip bookkeeping: the hold budget, the lockout, and the eased lean. */
function tickSlip(f: FighterState, dt: number): void {
  if (f.slipDisabledTimer > 0) {
    f.slipDisabledTimer -= dt;
    if (f.slipDisabledTimer < 0) f.slipDisabledTimer = 0;
  }
  if (f.slipReadAttemptTimer > 0) {
    f.slipReadAttemptTimer -= dt;
    if (f.slipReadAttemptTimer < 0) f.slipReadAttemptTimer = 0;
  }
  // Runs from the moment a slip starts: outlast it and the escalating cost resets.
  if (f.slipChainTimer > 0) {
    f.slipChainTimer -= dt;
    if (f.slipChainTimer <= 0) {
      f.slipChainTimer = 0;
      f.slipChainCount = 0;
    }
  }
  // A read slip waits out the AI's learned delay before it actually moves.
  if (f.slipPendingTimer > 0) {
    f.slipPendingTimer -= dt;
    if (f.slipPendingTimer <= 0) {
      const dir = f.slipPendingDir ?? "back";
      f.slipPendingTimer = 0;
      f.slipPendingDir = null;
      startSlip(f, dir);
      if (f.slipActive) f.slipHoldTimer = AI_SLIP_HOLD;
    }
  }
  if (f.slipActive) {
    f.slipTimer += dt;
    f.slipHoldTimer -= dt;
    if (f.slipHoldTimer <= 0 || f.isKnockedDown || f.slipDisabledTimer > 0) endSlip(f);
  }
  if (f.slipActive) {
    // Timed slide rather than a snap: eased so the head leaves and arrives soft,
    // and reaching a full lean is the exact moment the head counts as off the line.
    const dur = f.slipEnterDuration > 0 ? f.slipEnterDuration : SLIP_ENTER_SLOW;
    const t = Math.max(0, Math.min(1, f.slipTimer / dur));
    const eased = t * t * (3 - 2 * t);
    if (f.slipSwitchFrom && f.slipSwitchFrom !== f.slipDir) {
      // Crossover: one eased ramp over the whole journey — off the old side, then
      // out to a full lean on the new one — so the head is at its quickest as it
      // passes through the middle and settles softly at both ends.
      const total = f.slipLeanStart + 1;
      const travelled = eased * total;
      if (travelled < f.slipLeanStart) {
        f.slipLeanDir = f.slipSwitchFrom;
        f.slipLean = f.slipLeanStart - travelled;
      } else {
        f.slipLeanDir = f.slipDir;
        f.slipLean = Math.min(1, travelled - f.slipLeanStart);
      }
      if (t >= 1) f.slipSwitchFrom = null;
    } else {
      f.slipLeanDir = f.slipDir;
      f.slipLean = f.slipLeanStart + (1 - f.slipLeanStart) * eased;
    }
  } else {
    f.slipLean += (0 - f.slipLean) * Math.min(1, dt * SLIP_LEAN_RATE);
    if (f.slipLean < 0.002) f.slipLean = 0;
  }
}

/** Seconds this fighter currently needs for a full 180° turn. */
function facingTurnDuration(f: FighterState): number {
  // Landing a punch squares a fighter up: until the opponent lands one back,
  // they have no turn delay at all and track instantly. A perfect block buys the
  // same thing outright for a second, whatever else is on the fighter.
  if (f.turnDelayCancelled || f.turnDelayZeroTimer > 0) return 0;
  const base = Math.max(
    baseFacingTurnDelay(),
    f.facingTurnDelay,
    f.stunFacingSlowTimer > 0 ? f.stunFacingTurnDelay : 0
  );
  return Math.max(0, base + f.turnDelayAdjust);
}

/**
 * Move a fighter's own turn delay by one event's signed amount, in seconds. The
 * amounts are player-tuned on the Neural Network screen and can be saved with
 * either sign, so nothing here assumes a reward or a punishment.
 *
 * Floored at whatever would take the base delay to zero: without that, a fighter
 * who spends a round landing punches banks a reduction so deep that being hit,
 * dropped or crit stops registering at all for the rest of it.
 */
function applyTurnDelayEvent(f: FighterState, delta: number): void {
  if (!delta) return;
  f.turnDelayAdjust = Math.max(-baseFacingTurnDelay(), f.turnDelayAdjust + delta);
}

/** Signed radians between where this fighter is pointed and where the target is. */
function facingErrorTo(f: FighterState, targetX: number, targetZ: number): number {
  return normalizeAngle(Math.atan2(targetZ - f.z, targetX - f.x) - f.facingAngle);
}

/**
 * Swing the rendered angle toward a target at the fighter's own turn rate. This
 * is the only thing that moves `facingAngle` during a bout — the control paths
 * used to slam it onto the opponent's bearing every tick, which made every turn
 * delay invisible. A facing lock freezes the body outright: a fighter whose head
 * was just snapped around cannot track at all until it expires.
 */
function turnFacingToward(f: FighterState, targetX: number, targetZ: number, dt: number): void {
  if (f.facingLockTimer > 0) return;
  const err = facingErrorTo(f, targetX, targetZ);
  const step = (Math.PI / Math.max(0.001, facingTurnDuration(f))) * dt;
  const applied = Math.abs(err) <= step ? err : Math.sign(err) * step;
  f.facingAngle = normalizeAngle(f.facingAngle + applied);
}

/**
 * Point a fighter straight at a target with no turn at all — the bell, corner
 * resets and anyone dropped into the ring mid-bout, who would otherwise spend
 * their first quarter-second spinning out of whatever angle they spawned with
 * (and whiffing everything they threw while they did it).
 */
function snapFacingToward(f: FighterState, targetX: number, targetZ: number): void {
  f.facingAngle = Math.atan2(targetZ - f.z, targetX - f.x);
  f.facing = (Math.cos(f.facingAngle) >= 0 ? 1 : -1) as 1 | -1;
}

/**
 * The discrete side follows the body rather than a timer of its own: gloves,
 * stance and reach swap at the exact moment the turn carries the fighter past
 * front-on, so what the fight code reads can never disagree with what is drawn.
 * The dead band keeps a fighter stacked square above their opponent, where the
 * bearing sits right on the boundary, from flickering between sides.
 */
const FACING_SIDE_DEADBAND = 0.08;
function applyBodySideFacing(f: FighterState): void {
  const c = Math.cos(f.facingAngle);
  if (Math.abs(c) > FACING_SIDE_DEADBAND) f.facing = (c >= 0 ? 1 : -1) as 1 | -1;
}

// Arm length is authored in inches; this is the one conversion to pixels.
// 65" (the baseline arm) => 85px, which is exactly the jab's base hit range.
export const PX_PER_INCH = 1.3076923;

function getEffectivePunchConfig(punchType: PunchType): PunchConfig {
  const base = PUNCH_CONFIGS[punchType];
  const anim = getActivePunchAnimConfig()[punchType];
  const dm = anim?.distanceMult ?? 1.0;
  const damage = anim?.damage ?? base.damage;
  const staminaCost = anim?.staminaCost ?? base.staminaCost;
  if (dm === 1.0 && damage === base.damage && staminaCost === base.staminaCost) return base;
  return { ...base, range: base.range * dm, damage, staminaCost };
}

// Actual gameplay hit-detection range in pixels, editable directly in the Punch
// Animation Editor. Independent from reachMult/distanceMult above, which only
// affect how far the arm visually extends and never influence hit detection.
function getHitPunchConfig(punchType: PunchType): PunchConfig {
  const base = PUNCH_CONFIGS[punchType];
  const anim = getActivePunchAnimConfig()[punchType];
  const hitRangePx = anim?.hitRangePx;
  const damage = anim?.damage ?? base.damage;
  const staminaCost = anim?.staminaCost ?? base.staminaCost;
  const range = hitRangePx == null ? base.range : hitRangePx;
  if (range === base.range && damage === base.damage && staminaCost === base.staminaCost) return base;
  return { ...base, range, damage, staminaCost };
}

// Real hit-detection reach of one punch for one fighter, in pixels. Mirrors the
// gate tryHit() applies, minus the transient rhythm range buff. Exported so the AI
// can tell whether a punch it is about to throw can physically land.
export function getPunchReachPx(fighter: FighterState, punchType: PunchType): number {
  const config = getHitPunchConfig(punchType);
  const armReachBonus = (fighter.armLength - 65) * PX_PER_INCH;
  return config.range + 20 + armReachBonus + (fighter.precisionStrikerRangeBonus ?? 0);
}

// Punch names are absolute: jab / leftHook / leftUppercut always come off the LEFT
// arm, cross / rightHook / rightUppercut off the RIGHT one. Stance never changes
// that — it only remaps which key throws which punch.
function isLeftArmPunch(punchType: PunchType): boolean {
  return punchType === "jab" || punchType === "leftHook" || punchType === "leftUppercut";
}

// True when the punch comes off the fighter's LEAD hand: orthodox leads with the
// left, southpaw with the right.
export function isLeadArmPunch(punchType: PunchType, stance: BoxingStance): boolean {
  return isLeftArmPunch(punchType) === (stance === "orthodox");
}

const CANVAS_W = 800;
const CANVAS_H = 600;
const RING_CX = CANVAS_W / 2;
const RING_CY = 260;
const RING_HALF_W = 280;
const RING_HALF_H = 180;
const RING_LEFT = RING_CX - RING_HALF_W;
const RING_RIGHT = RING_CX + RING_HALF_W;
const RING_TOP = RING_CY - RING_HALF_H;
const RING_BOTTOM = RING_CY + RING_HALF_H;
const ROUND_DURATION = 180;
const BASE_STAMINA = 250;
const BASE_REGEN = 6;
const BASE_MOVE_SPEED = 138;
const KNOCKDOWN_DURATION = 4;
const COUNTDOWN_DURATION = 3;
const MIN_DISTANCE = 30;
const CHARGE_TIME = 0.5;

const CHARGE_STAMINA_COST_MULT = 3;
const CHARGE_CONSECUTIVE_EXTRA_COST = 0.5;
const CHARGE_CONSECUTIVE_WINDOW = 3;
const CHARGE_SELF_REGEN_PAUSE = 0.3;
const CHARGE_WHIFF_RETRACT_SLOW = 0.25;

/**
 * Technician: hand back what a missed charged punch spent.
 *
 * Called for both a clean whiff and a dodge — either way the charge never
 * landed, and letting a dodged charge cost more than one thrown at thin air
 * would be backwards. The recovery penalties for whiffing are NOT undone; only
 * the charge itself is refunded.
 *
 * Anything that strips a charge zeroes chargeWhiffForgivenessLeft, so a punch
 * still in flight when its owner is hit, drained, dropped or belled cannot
 * resurrect the charge that was just taken away.
 */
function refundForgivenChargeWhiff(fighter: FighterState): void {
  if ((fighter.chargeWhiffForgivenessLeft ?? 0) <= 0) return;
  fighter.chargeWhiffForgivenessLeft = fighter.chargeWhiffForgivenessLeft! - 1;
  fighter.chargeUsesLeft++;
  fighter.chargeMeterBars = Math.min(6, fighter.chargeMeterBars + 1);
  if (!fighter.chargeArmed) {
    fighter.chargeArmed = true;
    fighter.chargeArmTimer = fighter.chargeArmTimerAtThrow ?? 0;
  }
  // Re-apply the throw's own empowered rule now the bar is back, so a forgiven
  // miss leaves exactly the state the throw would have if it cost nothing.
  fighter.chargeEmpoweredTimer = fighter.chargeMeterBars >= 1 ? fighter.chargeEmpoweredDuration : 0;
}
const CHARGE_GUARDDOWN_SPEED_BONUS = 1.2;
const NO_GUARD_CRIT_MULT = 3;
const HEAD_CRIT_CHANCE = 0.03;
const BODY_CRIT_CHANCE = 0.08;
const CRIT_DAMAGE_MULT = 8.4;
const CRIT_REGEN_PAUSE = 0.5;
const CRIT_MOVE_SLOW_MULT = 0.5;
const CRIT_MOVE_SLOW_DURATION = 2;
const BASE_STUN_CHANCE = 0.01;
// A stun stops the defender's rhythm marker only when the punch caught them
// inside their vulnerability (green) zone, and even then only one time in ten.
const STUN_RHYTHM_PAUSE_CHANCE = 0.10;
const STUN_MOVE_SLOW_MULT = 0.70;
const STUN_MOVE_SLOW_DURATION = 3;
const STUN_BLOCK_DISABLE_DURATION = 1;
const STUN_REGEN_DISABLE_DURATION = 2.5;
const STUN_BLOCK_WEAKEN_DURATION = 4;
const STUN_BLOCK_WEAKEN_MULT = 0.5;
const STUN_PUNCH_SLOW_MULT = 0.75;
const STUN_PUNCH_SLOW_DURATION = 3;
const STUN_PUNCH_DISABLE_DURATION = 2;
/**
 * A stun stops the feet dead for this long. Flat, unlike the stun slows around
 * it, which scale with focus -- this is the "rocked on the spot" beat, not a
 * lingering handicap. The duck lockout has no constant of its own: it runs for
 * the same focus- and iron-chin-scaled window as the stun's other slows.
 */
const STUN_MOVE_FREEZE_DURATION = 0.7;


function isInsideDiamond(px: number, pz: number, margin: number = 0): boolean {
  const dx = Math.abs(px - RING_CX) / (RING_HALF_W - margin);
  const dz = Math.abs(pz - RING_CY) / (RING_HALF_H - margin);
  return dx + dz <= 1;
}

function clampToDiamond(fighter: { x: number; z: number }, margin: number = 20): void {
  const hw = RING_HALF_W - margin;
  const hh = RING_HALF_H - margin;
  const dx = (fighter.x - RING_CX) / hw;
  const dz = (fighter.z - RING_CY) / hh;
  const dist = Math.abs(dx) + Math.abs(dz);
  if (dist > 1) {
    fighter.x = RING_CX + (dx / dist) * hw;
    fighter.z = RING_CY + (dz / dist) * hh;
  }
}

function hexToHSL(hex: string): [number, number, number] {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return [h * 360, s, l];
}

function hslToHex(h: number, s: number, l: number): string {
  const hue2rgb = (p: number, q: number, t: number) => {
    if (t < 0) t += 1; if (t > 1) t -= 1;
    if (t < 1/6) return p + (q - p) * 6 * t;
    if (t < 1/2) return q;
    if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const r = Math.round(hue2rgb(p, q, h / 360) * 255);
  const g = Math.round(hue2rgb(p, q, (h / 360) + 1/3) * 255);
  const b = Math.round(hue2rgb(p, q, (h / 360) - 1/3) * 255);
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

let nextRingCanvasColor = "#BDEDF2";

function rollNextRingCanvasColor(): void {
  const roll = Math.random();
  if (roll < 0.85) nextRingCanvasColor = "#BDEDF2";
  else if (roll < 0.95) nextRingCanvasColor = "#F5F5F5";
  else if (roll < 0.98) nextRingCanvasColor = "#FFFFFF";
  else if (roll < 0.99) nextRingCanvasColor = "#FFABAB";
  else nextRingCanvasColor = "#EBD7AB";
}

export function getTelegraphMult(): number {
  try {
    const raw = localStorage.getItem("handz_telegraph_mult");
    if (raw) return Math.max(0.1, Math.min(3.0, parseFloat(raw)));
  } catch {}
  return 1.0;
}

export function setTelegraphMult(val: number): void {
  const clamped = Math.max(0.1, Math.min(3.0, val));
  localStorage.setItem("handz_telegraph_mult", clamped.toString());
}

export function getAdaptiveAiEnabled(): boolean {
  return true;
}

export function setAdaptiveAiEnabled(_val: boolean): void {
}

function getRingZone(x: number, z: number, state: GameState): RingZone {
  const cx = (state.ringLeft + state.ringRight) / 2;
  const cz = (state.ringTop + state.ringBottom) / 2;
  const hw = (state.ringRight - state.ringLeft) / 2;
  const hz = (state.ringBottom - state.ringTop) / 2;
  const nx = hw > 1 ? (x - cx) / hw : 0;
  const nz = hz > 1 ? (z - cz) / hz : 0;
  const edgeThresh = 0.65;
  const cornerThresh = 0.55;
  if (Math.abs(nx) > cornerThresh && Math.abs(nz) > cornerThresh) {
    if (nx > 0 && nz < 0) return "cornerNE";
    if (nx < 0 && nz < 0) return "cornerNW";
    if (nx > 0 && nz > 0) return "cornerSE";
    return "cornerSW";
  }
  if (nx > edgeThresh) return "ropeE";
  if (nx < -edgeThresh) return "ropeW";
  if (nz < -edgeThresh) return "ropeN";
  if (nz > edgeThresh) return "ropeS";
  return "center";
}

function createBehaviorProfile(state: GameState): BehaviorProfile {
  return {
    activeSequences: [],
    recentPlayerMoveX: [],
    recentPlayerMoveZ: [],
    recentPlayerPunchTimes: [],
    playerLastPunchTime: 0,
    playerLastDuckTime: 0,
    playerLastBlockTime: 0,
    playerLastDodgeTime: 0,
    playerLastRetreatTime: 0,
    playerWasMovingForward: false,
    playerWasMovingBackward: false,
    playerWasMovingLateral: false,
    playerPrevX: state.player.x,
    playerPrevZ: state.player.z,
    playerPrevStamina: state.player.stamina,
    aiPrevStamina: state.enemy.stamina,
    exchangeStartTime: 0,
    exchangeActive: false,
    exchangePlayerDmgStart: 0,
    exchangeAiDmgStart: 0,
    exchangePlayerStamStart: 0,
    exchangeAiStamStart: 0,
    exchangeZone: "center",
    exchangeComboKeys: [],
    lastExchangeEnd: 0,
    ringCutTimer: 0,
    ringCutStartStamina: state.player.stamina,
    ringCutStartAiStamina: state.enemy.stamina,
    ringCutStartDmg: 0,
    ringCutStartAiDmg: 0,
    ringCutZone: "center",
    cornerPressureTimer: 0,
    cornerPressureStartStamina: state.player.stamina,
    cornerPressureStartAiStamina: state.enemy.stamina,
    cornerPressureStartDmg: 0,
    cornerPressureStartAiDmg: 0,
    ropeEscapeTimer: 0,
    ropeEscapeStartStamina: state.player.stamina,
    ropeEscapeStartAiStamina: state.enemy.stamina,
    ropeEscapeStartDmg: 0,
    ropeEscapeStartAiDmg: 0,
    centerControlTimer: 0,
    centerControlStartStamina: state.player.stamina,
    centerControlStartAiStamina: state.enemy.stamina,
    centerControlStartDmg: 0,
    centerControlStartAiDmg: 0,
    lastMacroCheckTime: 0,
    playerLastPunchEndTime: 0,
    postPunchRetreatDetected: false,
    swayFireTimer: 0,
  };
}

function updateBehaviorProfile(state: GameState, dt: number): void {
  const bp = state.behaviorProfile;
  if (!bp) return;
  const player = state.player;
  const enemy = state.enemy;
  const t = state.fightElapsedTime;
  const zone = getRingZone(player.x, player.z, state);
  const enemyZone = getRingZone(enemy.x, enemy.z, state);
  const pStamFrac = player.maxStamina > 0 ? player.stamina / player.maxStamina : 1;
  const aStamFrac = enemy.maxStamina > 0 ? enemy.stamina / enemy.maxStamina : 1;

  const dx = player.x - bp.playerPrevX;
  const dz = player.z - bp.playerPrevZ;
  const toEnemyX = enemy.x - player.x;
  const toEnemyZ = enemy.z - player.z;
  const distToEnemy = Math.sqrt(toEnemyX * toEnemyX + toEnemyZ * toEnemyZ);
  const movingForward = distToEnemy > 1 && (dx * toEnemyX > 0);
  const movingBackward = distToEnemy > 1 && (dx * toEnemyX < 0);
  const movingLateral = Math.abs(dz) > Math.abs(dx) * 0.5 && Math.abs(dz) > 0.5;

  bp.playerWasMovingForward = movingForward;
  bp.playerWasMovingBackward = movingBackward;
  bp.playerWasMovingLateral = movingLateral;

  bp.recentPlayerMoveX.push(dx);
  bp.recentPlayerMoveZ.push(dz);
  if (bp.recentPlayerMoveX.length > 60) { bp.recentPlayerMoveX.shift(); bp.recentPlayerMoveZ.shift(); }

  if (!player.isPunching && bp.playerLastPunchTime > 0 && t - bp.playerLastPunchTime > 0.05) {
    bp.playerLastPunchEndTime = t;
  }
  if (bp.playerLastPunchEndTime > 0 && movingBackward && t - bp.playerLastPunchEndTime < 0.4 && !bp.postPunchRetreatDetected) {
    bp.postPunchRetreatDetected = true;
    startSequence(bp, "postPunchRetreat", t, player, enemy, zone);
  }
  if (player.isPunching) bp.postPunchRetreatDetected = false;

  if (movingLateral && !player.isPunching && player.defenseState === "none") {
    bp.swayFireTimer += dt;
  } else {
    bp.swayFireTimer = 0;
  }
  if (bp.swayFireTimer > 0.15 && player.isPunching && player.punchPhase === "launchDelay") {
    startSequence(bp, "swayFire", t, player, enemy, zone);
    bp.swayFireTimer = 0;
  }

  if (player.isPunching && player.punchPhase === "contact") {
    const punchTime = t;
    if (punchTime - bp.playerLastPunchTime > 0.05) {
      bp.recentPlayerPunchTimes.push(punchTime);
      if (bp.recentPlayerPunchTimes.length > 30) bp.recentPlayerPunchTimes.shift();

      const punchKey = player.currentPunch || "jab";

      if (bp.playerWasMovingForward && t - bp.playerLastPunchTime < 0.3 && punchKey === "jab") {
        startSequence(bp, "jabStep", t, player, enemy, zone);
      }
      if (bp.playerWasMovingBackward && t - bp.playerLastRetreatTime < 0.4) {
        startSequence(bp, "backstepCounter", t, player, enemy, zone);
      }
      if (bp.playerWasMovingLateral && t - bp.playerLastPunchTime < 0.3) {
        startSequence(bp, "pivotPunch", t, player, enemy, zone);
      }
      if (player.defenseState === "duck" && t - bp.playerLastDuckTime < 0.5) {
        startSequence(bp, "duckCounter", t, player, enemy, zone);
      }
      if (t - bp.playerLastBlockTime < 0.5) {
        startSequence(bp, "blockCounter", t, player, enemy, zone);
      }
      if (t - bp.playerLastDodgeTime < 0.5) {
        startSequence(bp, "dodgeCounter", t, player, enemy, zone);
      }

      if (!bp.exchangeActive && t - bp.lastExchangeEnd > 0.3) {
        bp.exchangeActive = true;
        bp.exchangeStartTime = t;
        bp.exchangePlayerDmgStart = player.damageDealt;
        bp.exchangeAiDmgStart = enemy.damageDealt;
        bp.exchangePlayerStamStart = player.stamina;
        bp.exchangeAiStamStart = enemy.stamina;
        bp.exchangeZone = zone;
        bp.exchangeComboKeys = [punchKey];
      } else if (bp.exchangeActive) {
        bp.exchangeComboKeys.push(punchKey);
        if (bp.exchangeComboKeys.length > 10) bp.exchangeComboKeys = bp.exchangeComboKeys.slice(-10);
      }

      bp.playerLastPunchTime = punchTime;
    }
  }

  if (player.defenseState === "duck" && bp.playerLastDuckTime < t - 0.05) {
    bp.playerLastDuckTime = t;
  }
  if (player.defenseState === "fullGuard") {
    bp.playerLastBlockTime = t;
  }
  if (movingBackward) {
    bp.playerLastRetreatTime = t;
  }

  const isCorner = (z: RingZone) => z.startsWith("corner");
  const isRope = (z: RingZone) => z.startsWith("rope");

  const playerCuttingRing = movingForward && movingLateral && (isRope(enemyZone) || isCorner(enemyZone));
  if (playerCuttingRing) {
    if (bp.ringCutTimer === 0) {
      bp.ringCutStartStamina = player.stamina;
      bp.ringCutStartAiStamina = enemy.stamina;
      bp.ringCutStartDmg = player.damageDealt;
      bp.ringCutStartAiDmg = enemy.damageDealt;
      bp.ringCutZone = zone;
    }
    bp.ringCutTimer += dt;
  } else if (bp.ringCutTimer > 0) {
    if (bp.ringCutTimer >= 1.0) {
      emitMacroObservation(state, bp, "ringCutting", bp.ringCutZone, bp.ringCutStartStamina, bp.ringCutStartAiStamina, bp.ringCutStartDmg, bp.ringCutStartAiDmg, t, pStamFrac, aStamFrac);
    }
    bp.ringCutTimer = 0;
  }

  const enemyInCorner = isCorner(enemyZone);
  const playerPressing = distToEnemy < 120 && (player.isPunching || movingForward);
  if (enemyInCorner && playerPressing) {
    if (bp.cornerPressureTimer === 0) {
      bp.cornerPressureStartStamina = player.stamina;
      bp.cornerPressureStartAiStamina = enemy.stamina;
      bp.cornerPressureStartDmg = player.damageDealt;
      bp.cornerPressureStartAiDmg = enemy.damageDealt;
    }
    bp.cornerPressureTimer += dt;
  } else if (bp.cornerPressureTimer > 0) {
    if (bp.cornerPressureTimer >= 1.0) {
      emitMacroObservation(state, bp, "cornerPressure", enemyZone, bp.cornerPressureStartStamina, bp.cornerPressureStartAiStamina, bp.cornerPressureStartDmg, bp.cornerPressureStartAiDmg, t, pStamFrac, aStamFrac);
    }
    bp.cornerPressureTimer = 0;
  }

  const playerOnRope = isRope(zone) || isCorner(zone);
  const playerEscaping = playerOnRope && (movingLateral || movingBackward) && !player.isPunching;
  if (playerEscaping) {
    if (bp.ropeEscapeTimer === 0) {
      bp.ropeEscapeStartStamina = player.stamina;
      bp.ropeEscapeStartAiStamina = enemy.stamina;
      bp.ropeEscapeStartDmg = player.damageDealt;
      bp.ropeEscapeStartAiDmg = enemy.damageDealt;
    }
    bp.ropeEscapeTimer += dt;
  } else if (bp.ropeEscapeTimer > 0) {
    if (bp.ropeEscapeTimer >= 0.5 && zone === "center") {
      emitMacroObservation(state, bp, "ropeEscape", zone, bp.ropeEscapeStartStamina, bp.ropeEscapeStartAiStamina, bp.ropeEscapeStartDmg, bp.ropeEscapeStartAiDmg, t, pStamFrac, aStamFrac);
    }
    bp.ropeEscapeTimer = 0;
  }

  if (zone === "center" && player.isPunching) {
    if (bp.centerControlTimer === 0) {
      bp.centerControlStartStamina = player.stamina;
      bp.centerControlStartAiStamina = enemy.stamina;
      bp.centerControlStartDmg = player.damageDealt;
      bp.centerControlStartAiDmg = enemy.damageDealt;
    }
    bp.centerControlTimer += dt;
  } else if (bp.centerControlTimer > 0) {
    if (bp.centerControlTimer >= 1.5) {
      emitMacroObservation(state, bp, "centerControl", "center", bp.centerControlStartStamina, bp.centerControlStartAiStamina, bp.centerControlStartDmg, bp.centerControlStartAiDmg, t, pStamFrac, aStamFrac);
    }
    bp.centerControlTimer = 0;
  }

  if (bp.exchangeActive) {
    if (t - bp.playerLastPunchTime > 1.0 && t - bp.exchangeStartTime > 0.3) {
      const playerDmgDelta = player.damageDealt - bp.exchangePlayerDmgStart;
      const aiDmgDelta = enemy.damageDealt - bp.exchangeAiDmgStart;
      const playerStamLoss = bp.exchangePlayerStamStart - player.stamina;
      const aiStamLoss = bp.exchangeAiStamStart - enemy.stamina;
      const aiHurtMore = aiStamLoss > playerStamLoss || playerDmgDelta > aiDmgDelta;

      if (aiHurtMore && state.aiBrain?.adaptiveMemory) {
        const comboSeq = bp.exchangeComboKeys.length > 0 ? bp.exchangeComboKeys.join(">") : null;
        const comboLen = bp.exchangeComboKeys.length;
        const comboConfBoost = comboLen >= 3 ? 0.4 : comboLen >= 2 ? 0.2 : 0;
        const baseConf = 1.0 + comboConfBoost;
        addObservation(state.aiBrain.adaptiveMemory, {
          kind: "exchange",
          zone: bp.exchangeZone,
          round: state.currentRound,
          fightTime: t,
          playerStaminaDelta: playerStamLoss,
          aiStaminaDelta: aiStamLoss,
          damageToAi: playerDmgDelta,
          damageToPlayer: aiDmgDelta,
          comboSequence: comboSeq,
          confidence: baseConf,
          count: 1,
          playerStaminaFrac: pStamFrac,
          aiStaminaFrac: aStamFrac,
        });
        if (comboSeq && comboLen >= 2) {
          addObservation(state.aiBrain.adaptiveMemory, {
            kind: "combo:" + comboSeq,
            zone: bp.exchangeZone,
            round: state.currentRound,
            fightTime: t,
            playerStaminaDelta: playerStamLoss,
            aiStaminaDelta: aiStamLoss,
            damageToAi: playerDmgDelta,
            damageToPlayer: aiDmgDelta,
            comboSequence: comboSeq,
            confidence: baseConf + 0.3,
            count: 1,
            playerStaminaFrac: pStamFrac,
            aiStaminaFrac: aStamFrac,
          });
        }
      }
      bp.exchangeActive = false;
      bp.lastExchangeEnd = t;
    }
  }

  for (let i = bp.activeSequences.length - 1; i >= 0; i--) {
    const seq = bp.activeSequences[i];
    if (t - seq.startTime > 1.0) {
      const playerStamLoss = seq.startPlayerStamina - player.stamina;
      const aiStamLoss = seq.startAiStamina - enemy.stamina;
      const playerDmg = player.damageDealt - seq.startPlayerDamageDealt;
      const aiDmg = enemy.damageDealt - seq.startAiDamageDealt;
      const aiHurtMore = aiStamLoss > playerStamLoss || playerDmg > aiDmg;

      if (aiHurtMore && state.aiBrain?.adaptiveMemory) {
        addObservation(state.aiBrain.adaptiveMemory, {
          kind: seq.kind,
          zone: seq.zone,
          round: state.currentRound,
          fightTime: t,
          playerStaminaDelta: playerStamLoss,
          aiStaminaDelta: aiStamLoss,
          damageToAi: playerDmg,
          damageToPlayer: aiDmg,
          comboSequence: seq.comboKeys.length > 0 ? seq.comboKeys.join(">") : null,
          confidence: 1,
          count: 1,
          playerStaminaFrac: pStamFrac,
          aiStaminaFrac: aStamFrac,
        });
      }
      bp.activeSequences.splice(i, 1);
    }
  }

  bp.playerPrevX = player.x;
  bp.playerPrevZ = player.z;
  bp.playerPrevStamina = player.stamina;
  bp.aiPrevStamina = enemy.stamina;
}

function emitMacroObservation(
  state: GameState, bp: BehaviorProfile, kind: string, zone: RingZone,
  startStam: number, startAiStam: number, startDmg: number, startAiDmg: number,
  t: number, pStamFrac: number, aStamFrac: number
): void {
  const player = state.player;
  const enemy = state.enemy;
  const playerStamLoss = startStam - player.stamina;
  const aiStamLoss = startAiStam - enemy.stamina;
  const playerDmg = player.damageDealt - startDmg;
  const aiDmg = enemy.damageDealt - startAiDmg;
  const aiHurtMore = aiStamLoss > playerStamLoss || playerDmg > aiDmg;
  if (aiHurtMore && state.aiBrain?.adaptiveMemory) {
    addObservation(state.aiBrain.adaptiveMemory, {
      kind, zone,
      round: state.currentRound,
      fightTime: t,
      playerStaminaDelta: playerStamLoss,
      aiStaminaDelta: aiStamLoss,
      damageToAi: playerDmg,
      damageToPlayer: aiDmg,
      comboSequence: null,
      confidence: 1.2,
      count: 1,
      playerStaminaFrac: pStamFrac,
      aiStaminaFrac: aStamFrac,
    });
  }
}

function startSequence(bp: BehaviorProfile, kind: string, t: number, player: FighterState, enemy: FighterState, zone: RingZone): void {
  if (bp.activeSequences.some(s => s.kind === kind && t - s.startTime < 0.5)) return;
  if (bp.activeSequences.length >= 8) bp.activeSequences.shift();
  bp.activeSequences.push({
    kind,
    startTime: t,
    startPlayerStamina: player.stamina,
    startAiStamina: enemy.stamina,
    startPlayerDamageDealt: player.damageDealt,
    startAiDamageDealt: enemy.damageDealt,
    phase: 0,
    zone,
    comboKeys: player.currentPunch ? [player.currentPunch] : [],
  });
}

function addObservation(mem: AdaptiveMemory, obs: ObservedPattern): void {
  const existing = mem.observations.find(o => o.kind === obs.kind && o.zone === obs.zone);
  const comboBoost = obs.comboSequence ? 0.1 : 0;
  if (existing) {
    existing.count++;
    existing.confidence = Math.min(existing.confidence + 0.15 + comboBoost, 5.0);
    existing.aiStaminaDelta = existing.aiStaminaDelta * 0.7 + obs.aiStaminaDelta * 0.3;
    existing.playerStaminaDelta = existing.playerStaminaDelta * 0.7 + obs.playerStaminaDelta * 0.3;
    existing.damageToAi = existing.damageToAi * 0.7 + obs.damageToAi * 0.3;
    existing.damageToPlayer = existing.damageToPlayer * 0.7 + obs.damageToPlayer * 0.3;
    existing.playerStaminaFrac = existing.playerStaminaFrac * 0.7 + obs.playerStaminaFrac * 0.3;
    existing.aiStaminaFrac = existing.aiStaminaFrac * 0.7 + obs.aiStaminaFrac * 0.3;
    if (obs.comboSequence) existing.comboSequence = obs.comboSequence;
    existing.fightTime = obs.fightTime;
    existing.round = obs.round;
  } else {
    if (mem.observations.length >= 50) {
      let minIdx = 0;
      let minConf = mem.observations[0].confidence;
      for (let i = 1; i < mem.observations.length; i++) {
        if (mem.observations[i].confidence < minConf) { minConf = mem.observations[i].confidence; minIdx = i; }
      }
      mem.observations.splice(minIdx, 1);
    }
    mem.observations.push({ ...obs });
  }
}

function createFighter(
  name: string, archetype: Archetype, level: number, x: number, z: number, facing: 1 | -1, isPlayer: boolean, colors?: FighterColors, armLength: number = 65, boxingStance: BoxingStance = "orthodox"
): FighterState {
  const stats = ARCHETYPE_STATS[archetype];
  const maxStamina = BASE_STAMINA * stats.maxStaminaMult * levelScale(level, 1, 10, "maxStamina");
  const baseBobSpeed = 1.8;
  return {
    name,
    archetype,
    level,
    x,
    z,
    y: 0,
    prevX: x,
    prevZ: z,
    currentMoveDir: "none",
    punchMoveDir: "none",
    facingAngle: facing === 1 ? 0 : Math.PI,
    stamina: maxStamina,
    maxStamina,
    maxStaminaCap: maxStamina,
    staminaRegen: BASE_REGEN * stats.regenMult * levelScale(level, 1, 1.8, "staminaRegen"),
    facing,
    headOffset: { x: 0, y: 0 },
    leftGloveOffset: { x: facing * 6, y: -12 },
    rightGloveOffset: { x: facing * 6, y: -8 },
    bodyOffset: { x: 0, y: 0 },
    bobPhase: 0,
    bobSpeed: baseBobSpeed,
    baseBobSpeed,
    defenseState: "fullGuard",
    preDuckBlockState: null,
    guardBlend: 1.0,
    isPunching: false,
    currentPunch: null,
    currentPunchStaminaCost: 0,
    punchProgress: 0,
    punchCooldown: 0,
    isHit: false,
    hitTimer: 0,
    critHitTimer: 0,
    cleanHitEyeTimer: 0,
    regenPauseTimer: 0,
    moveSpeed: BASE_MOVE_SPEED * stats.speedMult * levelScale(level, 1, 0.72, "moveSpeed"),
    punchSpeedMult: stats.speedMult * levelScale(level, 2, 1.8, "punchSpeedMult") * 0.1917,
    damageMult: stats.damageMult * levelScale(level, 1, 3.5, "damageMult") * 1.1,
    // The additive power pool starts empty. `damageMult` above is the BASE — the
    // level ramp and (later) spent stat points — and everything the fighter earns
    // on top of that base sums into this instead of multiplying the base.
    powerBonusPct: 0,
    defenseMult: levelScale(level, 1, 0.7, "defenseMult"),
    staminaCostMult: stats.punchCostMult * levelScale(level, 1, 0.8, "staminaCostMult"),
    knockdowns: 0,
    knockdownsGiven: 0,
    punchesThrown: 0,
    jabThrown: 0,
    hookThrown: 0,
    uppercutThrown: 0,
    punchesLanded: 0,
    cleanPunchesLanded: 0,
    cleanPunchesTakenFight: 0,
    rhythmCutPoolLost: 0,
    // Punch Endurance is a per-bout drain: fighters are rebuilt for every bout,
    // so this is the only place it needs clearing. Career/roster values are
    // layered on top by applyPunchEndurance right after startFight.
    punchEndurance: PUNCH_ENDURANCE_MIN,
    punchEnduranceLoss: PUNCH_ENDURANCE_LOSS_MIN,
    punchesSincePoolDrain: 0,
    feintBaits: 0,
    damageDealt: 0,
    timeSinceLastLanded: 0,
    timeSinceLastDamageTaken: Infinity,
    damageTakenRegenPauseFired: false,
    kdRegenBoostActive: false,
    unansweredStreak: 0,
    momentumRegenBoost: 0,
    momentumRegenTimer: 0,
    isPlayer,
    isKnockedDown: false,
    knockdownTimer: 0,
    duckTimer: 0,
    duckHoldTime: 0,
    colors: colors || (isPlayer ? { ...DEFAULT_PLAYER_COLORS } : { ...DEFAULT_ENEMY_COLORS }),
    isFeinting: false,
    isCharging: false,
    chargeTimer: 0,
    stance: "neutral",
    handsDown: false,
    halfGuardPunch: false,
    rhythmLevel: 2,
    rhythmProgress: 0,
    rhythmDirection: 1,
    punchPhase: null,
    punchPhaseTimer: 0,
    isRePunch: false,
    retractionProgress: 0,
    earlyRepunchPenaltyTimer: 0,
    staminaPauseFromRhythm: 0,
    staminaPenaltyPending: false,
    speedBoostTimer: 0,
    punchAimsHead: false,
    blockTimer: 0,
    maxBlockDuration: levelScale(level, 20, 180, "maxBlockDuration"),
    blockRegenPenaltyTimer: 0,
    blockRegenPenaltyDuration: levelScale(level, 0.25, 0, "blockRegenPenaltyDuration"),
    punchingWhileBlocking: false,
    burstPunchCount: 0,
    burstPunchTimer: 1.5,
    duckHoldTimer: 0,
    duckDrainCooldown: 0,
    duckProgress: 0,
    backLegDrive: 0,
    frontLegDrive: 0,
    moveSlowMult: 1,
    moveSlowTimer: 0,
    ironChinStunResist: 0,
    ironChinDamageReduction: 0,
    pressureRhythmCutChance: 0,
    pressureRhythmCutMult: 1.0,
    rhythmCutTimer: 0,
    rhythmCutMult: 1.0,
    rhythmCutPending: false,
    pushbackVx: 0,
    pushbackVz: 0,
    guardDownTimer: 0,
    guardDownSpeedBoost: 0,
    guardDownBoostTimer: 0,
    guardDownBoostMax: 0.24,
    pressureDropTimer: 0,
    pdRecoveryActive: false,
    pdPrevX: x,
    pdPrevZ: z,
    stunBlockDisableTimer: 0,
    stunBlockWeakenTimer: 0,
    stunPunchDisableTimer: 0,
    stunPunchSlowMult: 1,
    stunPunchSlowTimer: 0,
    stunMoveFreezeTimer: 0,
    slipActive: false,
    slipDir: "back" as const,
    slipTimer: 0,
    slipEnterDuration: 0,
    slipSwitchFrom: null,
    slipHoldTimer: 0,
    slipDisabledTimer: 0,
    slipChainTimer: 0,
    slipChainCount: 0,
    slipKeyWasUp: true,
    slipLean: 0,
    slipLeanStart: 0,
    slipLeanDir: "back" as const,
    slipDirAtPunch: null,
    slipPendingTimer: 0,
    slipPendingDir: null,
    slipReadAttemptTimer: 0,
    slipReadPunchId: -1,
    slipReadDelay: 0,
    slipReadHitsTaken: 0,
    punchInputUnread: false,
    chargeCooldownTimer: 0,
    chargeReadyWindowTimer: 0,
    chargeReady: false,
    chargeArmed: false,
    chargeUsesLeft: 0,
    chargeArmTimer: 0,
    chargeMeterCounters: 0,
    chargeMeterBars: 0,
    chargeEmpoweredTimer: 0,
    chargeEmpoweredDuration: 3.0,
    chargeMeterLockoutTimer: 0,
    chargeHoldTimer: 0,
    chargeFlashTimer: 0,
    chargeHeadOffset: 0,
    blockFlashTimer: 0,
    rhythmHitFlashTimer: 0,
    punchTravelStartTime: 0,
    consecutiveChargeTimer: 0,
    consecutiveChargeCount: 0,
    feintWhiffPenaltyCooldown: 0,
    retractionPenaltyMult: 1,
    armLength,
    aiGuardDropTimer: 0,
    aiGuardDropCooldown: 0,
    telegraphPhase: "none",
    telegraphTimer: 0,
    telegraphDuration: 0,
    telegraphPunchType: null,
    telegraphIsFeint: false,
    telegraphIsCharged: false,
    telegraphRhythmPaused: false,
    telegraphIsLockout: false,
    postPunchLockoutTimer: 0,
    postPunchLockoutDuration: 0,
    fastTwitchRank: 0,
    pendingPunchInput: null,
    pendingPunchInputTimer: 0,
    pendingPunchCharged: false,
    pendingPunchBody: false,
    timeSinceLastPunch: 999,
    timeSinceGuardRaised: 999,
    blinkTimer: 4 + Math.random() * 4,
    blinkDuration: 0,
    isBlinking: false,
    blinkQueued: 0,
    blinkQueueTimer: 0,
    blinkQuietTimer: 0,
    flinchTimer: 0,
    flinchDuration: 0,
    flinchMag: 0,
    flinchDirY: 1,
    flinchReactions: 0,
    flinchNegateTimer: 0,
    flinchDuckSeen: false,
    feintFlinchCounts: {},
    shotsTakenHead: 0,
    shotsTakenBody: 0,
    feintTelegraphDisableTimer: 0,
    feintedTelegraphBoost: 0,
    telegraphKdMult: 1,
    telegraphRoundBonus: 0,
    telegraphFeintRoundPenalty: 0,
    telegraphSlowTimer: 0,
    telegraphSlowDuration: 0,
    telegraphRhythmBoost: 0,
    duckSpeedMult: 1,
    blockMult: 1,
    critResistMult: 1,
    rhythmCritVulnStack: 0,
    critMult: 1,
    stunMult: 1,
    focusT: 0,
    defenseT: 0,
    speedT: 0,
    facingLockTimer: 0,
    facingTurnDelay: 0,
    facingPendingTimer: 0,
    turnDelayCancelled: false,
    turnDelayAdjust: 0,
    turnDelayZeroTimer: 0,
    stunFacingSlowTimer: 0,
    stunFacingTurnDelay: 0,
    ironChinStunSlowReduction: 0,
    telegraphSpeedMult: 1,
    punchLaunchDamageMult: 1,
    rawPower: 0,
    rawStamina: 0,
    rawSpeed: 0,
    handsDownTimer: 0,
    handsDownCooldown: 0,
    feintHoldTimer: 0,
    feintTouchingOpponent: false,
    feintDuckTouchingOpponent: false,
    feintArmed: false,
    feintArmTimer: 0,
    autoGuardActive: false,
    autoGuardTimer: 0,
    autoGuardDuration: 0,
    lastSpacePressTime: -999,
    spaceWasUp: true,
    perfectBlockActive: false,
    perfectBlockTimer: 0,
    pbIgnoresRhythmVuln: false,
    perfectBlockFlashTimer: 0,
    perfectBlockState: "idle" as const,
    perfectBlockRiseTimer: 0,
    perfectBlockHoldTimer: 0,
    perfectBlockCooldownTimer: 0,
    perfectBlockGloveYOffset: 0,
    perfectBlockKeyWasUp: true,
    turnPunchPenaltyActive: false,

    swayPhase: 0,
    swayDir: 1,
    swayOffset: 0,
    swaySpeedLevel: 3,
    punchThrowRhythmProgress: null,
    swayFrozen: false,
    swayZone: "neutral",
    swayDamageMult: 1,
    swayTelegraphMult: 1,
    miniStunTimer: 0,
    rhythmPauseTimer: 0,
    rhythmCutHitsLanded: 0,
    boxingStance,

    // Energy fatigue. The ceiling is re-sampled from current stamina in
    // startFight once the pool has been built; this is only the placeholder
    // that keeps the field non-optional.
    lastWalkDir: "none",
    fatigue: createFatigueState(maxStamina),
  };
}

const RING_CENTER_Z = RING_CY;
const PLAYER_START_X = RING_CX - 120;
const PLAYER_START_Z = RING_CENTER_Z;
const ENEMY_START_X = RING_CX + 120;
const ENEMY_START_Z = RING_CENTER_Z;

export function createInitialState(): GameState {
  return {
    phase: "menu",
    player: createFighter("Player", "BoxerPuncher", 1, PLAYER_START_X, PLAYER_START_Z, 1, true),
    enemy: createFighter("Enemy", "BoxerPuncher", 1, ENEMY_START_X, ENEMY_START_Z, -1, false),
    currentRound: 1,
    totalRounds: 3,
    roundTimer: ROUND_DURATION,
    roundDuration: ROUND_DURATION,
    roundScores: [],
    fightResult: null,
    fightWinner: null,
    xpGained: 0,
    careerXpMult: 1,
    canSurpassLevel100: true,
    itemKdAvoidChance: 0,
    itemRhythmCutFailChance: 0,
    opponentItemKdAvoidChance: 0,
    opponentItems: undefined,
    countdownTimer: COUNTDOWN_DURATION,
    knockdownCountdown: 0,
    knockdownMashCount: 0,
    knockdownMashRequired: 25,
    knockdownMashTimer: 0,
    knockdownRefCount: 0,
    knockdownActive: false,
    kdFallTimer: KD_FALL_DURATION,
    ringWidth: RING_RIGHT - RING_LEFT,
    ringLeft: RING_LEFT,
    ringRight: RING_RIGHT,
    ringTop: RING_TOP,
    ringBottom: RING_BOTTOM,
    ringDepth: RING_BOTTOM - RING_TOP,
    selectedArchetype: "BoxerPuncher",
    playerLevel: 1,
    enemyLevel: 1,
    enemyName: ENEMY_NAMES[Math.floor(Math.random() * ENEMY_NAMES.length)],
    isPaused: false,
    pauseSelectedIndex: 0,
    pauseAction: null,
    pauseSoundTab: false,
    pauseControlsTab: false,
    isQuickFight: false,
    fatigueEnabled: false,
    aiDifficulty: "contender",
    cornerWalkActive: false,
    cornerWalkTimer: 0,
    aiKdGetUpTime: 0,
    aiKdWillGetUp: false,
    earlyBlitzKoActive: false,
    earlyBlitzStopCount: 0,
    aiKdChancePenalty: 0,
    refereeVisible: false,
    standingFighterTargetX: 0,
    standingFighterTargetZ: RING_CENTER_Z,
    savedDefenseState: "none",
    savedHandsDown: false,
    savedBlockTimer: 0,
    savedStandingIsPlayer: false,
    kdSavedKnockedRhythmLevel: 2,
    kdSavedStandingRhythmLevel: 2,
    shakeIntensity: 0,
    shakeTimer: 0,
    hitEffects: [],
    maxStaminaDeltaTexts: [],
    playerColors: { ...DEFAULT_PLAYER_COLORS },
    roundStats: {
      playerDamageThisRound: 0,
      enemyDamageThisRound: 0,
      playerActualDamageThisRound: 0,
      enemyActualDamageThisRound: 0,
      playerPunchesThisRound: 0,
      enemyPunchesThisRound: 0,
      playerLandedThisRound: 0,
      enemyLandedThisRound: 0,
      playerKDsThisRound: 0,
      enemyKDsThisRound: 0,
      playerAggressionTime: 0,
      enemyAggressionTime: 0,
      playerRingControlTime: 0,
      enemyRingControlTime: 0,
      playerPunchesDodged: 0,
      enemyPunchesDodged: 0,
      playerPunchesBlocked: 0,
      enemyPunchesBlocked: 0,
      playerDuckDodges: 0,
      playerComboCount: 0,
      playerConsecutiveLanded: 0,
    },
    timerSpeed: "normal" as TimerSpeed,
    aiBrain: null,
    fightTotalDuckDodges: 0,
    fightTotalCombos: 0,
    fightFastTwitchBonus: 0,
    kdIsBodyShot: false,
    kdTakeKnee: false,
    kdFaceRefActive: false,
    kdFaceRefTimer: 0,
    refStoppageActive: false,
    refStoppageTimer: 0,
    refStoppageType: null,
    mercyStoppageEnabled: true,
    towelStoppageEnabled: true,
    practiceMode: false,
    cpuAttacksEnabled: true,
    cpuDefenseEnabled: true,
    sparringMode: false,
    directionalPerfectBlock: false,
    staticCamera: false,
    doghouseMode: false,
    careerFightMode: false,
    enemyWhiffBonus: 0,
    towelActive: false,
    towelTimer: 0,
    towelStartX: 0,
    towelStartY: 0,
    towelEndX: 0,
    towelEndY: 0,
    refX: RING_CX,
    refZ: RING_CY,
    enemyColors: { ...DEFAULT_ENEMY_COLORS },
    ringCanvasColor: "#3d2f1e",
    totalEnemyKDs: 0,
    kdSequence: [],
    towelImmunityUsed: false,
    fightElapsedTime: 0,
    kdTimerExpired: false,
    koDelayTimer: -1,
    aiKoStopTime: -1,
    aiKoPendingResult: null,
    bigShotTextTimer: 0,
    kdEarlyStopCheckedCount: 0,
    introAnimActive: false,
    introAnimTimer: 0,
    introAnimPhase: 0,
    playerIntroPlaying: false,
    enemyIntroPlaying: false,
    playerSavedRhythmLevel: 2,
    enemySavedRhythmLevel: 2,
    swarmerPunchQueue: [],
    swarmerPunchIndex: 0,
    swarmerPunchDelay: 0,
    swarmerIsPlayer: false,
    recordInputs: false,
    inputRecording: null,
    cpuVsCpu: false,
    playerAiBrain: null,
    telegraphMult: 1.0,
    hitstopTimer: 0,
    hitstopDuration: 0,
    crowdBobTime: 0,
    crowdKdBounceTimer: 0,
    crowdExciteTimer: 0,
    crowdKdSpeedTimer: 0,
    cleanHitStreak: 0,
    playerCurrentXp: 0,
    midFightLevelUps: 0,
    midFightLevelUpTimer: 0,
    adaptiveAiEnabled: false,
    behaviorProfile: null,
    tutorialMode: false,
    tutorialStage: 0,
    tutorialStep: 0,
    tutorialPrompt: "",
    tutorialPromptTimer: 0,
    tutorialAiIdle: false,
    tutorialTracking: createDefaultTutorialTracking(),
    tutorialShowContinueButton: false,
    tutorialDelayTimer: 0,
    tutorialCareerMode: false,
    tutorialFightUnlocked: false,
    nightmareMode: false,
    nightmareEnemies: [],
    nightmareAiBrains: [],
    nightmareKillCount: 0,
    nightmareSpawnTimer: 0,
    nightmareSpawnDelay: 0,
    nightmareEnemyDefeated: false,
    nightmareLevel: 1,
    nightmareDifficulty: "champion",
    nightmareTimeSurvived: 0,
    nightmareRegenBoostTimer: 0,
    nightmareCurrentSpawnInterval: 25,
    nightmareEnemyActiveSince: 0,
    nightmareQuickKOs: 0,
    nightmareVeryQuickKOs: 0,
    nightmareRegenBoostMult: 0,
    nightmareStaminaDrainTimer: 0,
    nightmareRefinementBudget: 0,
    nightmareRefinementPlayerTotal: 0,
    nightmareSpawnIndex: 0,
    doghouseOpponentsDefeated: 0,
    doghouseStaminaMult: 1,
    doghousePowerMult: 1,
    doghouseOpponentPool: [],
  };
}

function createDefaultTutorialTracking(): import("./types").TutorialTracking {
  return {
    movedLeft: false,
    movedRight: false,
    movedUp: false,
    movedDown: false,
    threwJab: false,
    threwCross: false,
    threwLeftHook: false,
    threwRightHook: false,
    threwLeftUppercut: false,
    threwRightUppercut: false,
    punchesBlocked: 0,
    duckCount: 0,
    autoGuardActivated: false,
    guardToggled: false,
    perfectBlockCount: 0,
    rhythmChangeCount: 0,
    chargeUsed: false,
    feintCount: 0,
    punchFeintCount: 0,
    rhythmHits: 0,
  };
}

const PLAYER_CORNER_X = PLAYER_START_X;
const PLAYER_CORNER_Z = RING_CENTER_Z;
const ENEMY_CORNER_X = ENEMY_START_X;
const ENEMY_CORNER_Z = RING_CENTER_Z;
const CORNER_WALK_SPEED = 120;

const NEUTRAL_CORNER_TOP_X = RING_CX;
const NEUTRAL_CORNER_TOP_Z = RING_CY - RING_HALF_H + 30;
const NEUTRAL_CORNER_BOT_X = RING_CX;
const NEUTRAL_CORNER_BOT_Z = RING_CY + RING_HALF_H - 30;

function getFarthestNeutralCorner(fromX: number, fromZ: number): { x: number; z: number } {
  const distTop = Math.sqrt((fromX - NEUTRAL_CORNER_TOP_X) ** 2 + (fromZ - NEUTRAL_CORNER_TOP_Z) ** 2);
  const distBot = Math.sqrt((fromX - NEUTRAL_CORNER_BOT_X) ** 2 + (fromZ - NEUTRAL_CORNER_BOT_Z) ** 2);
  if (distTop >= distBot) {
    return { x: NEUTRAL_CORNER_TOP_X, z: NEUTRAL_CORNER_TOP_Z };
  }
  return { x: NEUTRAL_CORNER_BOT_X, z: NEUTRAL_CORNER_BOT_Z };
}

/** Seconds between a clean Life Drain punch landing and the stamina coming back. */

/** Every refinement a fighter can hold levels in. */
export const REFINEMENT_KEYS = [
  "jabPower", "hookPower", "uppercutPower", "bruiser", "koArtist",
  "ironChin", "slippery", "guardMaster", "duckRecovery", "punchRolling",
  "fastTwitch", "heartRefinement", "chinHitter", "technician", "lifeDrain",
  "pressureFighter", "precisionStriker",
] as const;

export const REFINEMENT_LEVEL_CAP = 100;
/** Most refinement any one fighter can hold: every skill maxed. */
export const REFINEMENT_TOTAL_CAP = REFINEMENT_KEYS.length * REFINEMENT_LEVEL_CAP;

/** Refinements a fighter can bring into the ring at once. The rest sit at their bought level doing nothing. */
export { MAX_ACTIVE_REFINEMENTS, maxActiveRefinementsFor };

/**
 * The refinements a blob actually brings into the ring — the single gate every
 * corner passes through before its refinement levels turn into fight numbers.
 *
 * A player save carries its own `activeRefinements` pick list, which is
 * authoritative including when it is empty (no bonuses at all), and is trimmed
 * to the ring slots that save has actually unlocked. An opponent map carries no
 * list, so its active set is its highest-level entries up to the hard ceiling.
 * Pass `explicitOnly` for the player corner so a save whose list has not been
 * written yet reads as "nothing active" rather than falling back to their best.
 *
 * Keys that are not active are dropped from the returned copy, so every
 * `?? 0` read downstream sees a zero. Unlock flags and the pick list ride
 * through untouched.
 */
export function activeRefinementsOnly<T extends Record<string, unknown> | undefined>(
  ref: T,
  explicitOnly: boolean = false,
): T {
  if (!ref) return ref;
  const list = (ref as Record<string, unknown>).activeRefinements;
  let active: Set<string>;
  if (Array.isArray(list)) {
    active = new Set((list as unknown[])
      .filter((k): k is string => typeof k === "string")
      .slice(0, maxActiveRefinementsFor(ref as { activeSlotsUnlocked?: number })));
  } else if (explicitOnly) {
    active = new Set<string>();
  } else {
    active = new Set(
      REFINEMENT_KEYS
        .filter(k => typeof ref[k] === "number" && (ref[k] as number) > 0)
        .sort((a, b) => (ref[b] as number) - (ref[a] as number))
        .slice(0, MAX_ACTIVE_REFINEMENTS),
    );
  }
  const out: Record<string, unknown> = { ...(ref as Record<string, unknown>) };
  for (const k of REFINEMENT_KEYS) if (!active.has(k)) delete out[k];
  return out as T;
}

/**
 * Scatters `total` refinement points at random over `keyCount` randomly chosen
 * skills, capped at 100 each, so two opponents built from the same budget still
 * fight differently. The rounding remainder is handed out a point at a time,
 * which keeps the parts adding back up to the budget exactly; budget that no
 * longer fits under the cap is dropped rather than spilling into another key,
 * because a fighter never brings more than its chosen keys into the ring.
 */
export function spreadRefinementPoints(total: number, keyCount: number = MAX_ACTIVE_REFINEMENTS): Record<string, number> {
  const count = Math.max(0, Math.min(MAX_ACTIVE_REFINEMENTS, Math.floor(keyCount)));
  const target = Math.min(count * REFINEMENT_LEVEL_CAP, Math.max(0, Math.round(total)));
  const result: Record<string, number> = {};
  if (target <= 0 || count <= 0) return result;

  const keys = [...REFINEMENT_KEYS];
  for (let i = keys.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [keys[i], keys[j]] = [keys[j], keys[i]];
  }
  const picked = keys.slice(0, count);
  const weights = picked.map(() => Math.random() + 0.05);
  const weightSum = weights.reduce((a, b) => a + b, 0);
  const alloc = weights.map(w => Math.min(REFINEMENT_LEVEL_CAP, Math.floor((target * w) / weightSum)));
  let left = target - alloc.reduce((a, b) => a + b, 0);
  while (left > 0) {
    const open: number[] = [];
    for (let i = 0; i < alloc.length; i++) if (alloc[i] < REFINEMENT_LEVEL_CAP) open.push(i);
    if (open.length === 0) break;
    alloc[open[Math.floor(Math.random() * open.length)]]++;
    left--;
  }
  picked.forEach((key, i) => { if (alloc[i] > 0) result[key] = alloc[i]; });
  return result;
}

// Slippery refinement: how much quicker the fighter slides into a slip, as a
// straight speed multiplier on the slide. It buys nothing on its own; the
// fighter still has to read the punch and complete the movement, they just get
// there sooner.
function slipperySpeedMult(level: number): number {
  return 1 + refCurve("slippery", "slipSpeed", level);
}

// Speed 220 soft-cap: a fighter's own movement/punch speed effect never exceeds what raw speed=220
// would provide. Any excess speed above 220 is instead expressed as a relative discrepancy that
// slows down a slower opponent proportionally (rather than boosting the faster fighter further).
const SPEED_SOFT_CAP = 220;
function effectiveSpeedFraction(mySpeed: number, oppSpeed: number): number {
  const caps = getScaling().caps;
  const softCap = caps.speedSoftCap;
  const div = caps.speedDivisor;
  const cappedMine = Math.min(mySpeed, softCap) / div;
  if (oppSpeed > softCap && mySpeed < oppSpeed) {
    // Full handicap drags the slower fighter down in proportion to how far behind
    // they are. Strength blends between that and no handicap at all; the soft cap
    // itself still applies either way, so 0 leaves raw speed capped but unpunished.
    const handicapped = (softCap / div) * (mySpeed / oppSpeed);
    return Math.max(0, cappedMine + (handicapped - cappedMine) * caps.speedHandicapStrength);
  }
  return cappedMine;
}

// Precision Striker accuracy: the attacker's level scales DOWN the defender's
// dodge chance.
function precisionStrikerDodgeNegate(level: number): number {
  return refCurve("precisionStriker", "dodgeNegate", level);
}

// Total attacker-side dodge negation. Technician and Precision Striker stack
// multiplicatively, so two maxed refinements shave 74% rather than erasing
// dodging outright.
function combinedDodgeNegate(techNegate: number, attacker: FighterState): number {
  const precision = Math.min(1, attacker.precisionStrikerDodgeNegate ?? 0);
  return 1 - (1 - techNegate) * (1 - precision);
}

// Straight / Hook / Uppercut refinements: that punch family gets a chance to go
// straight through a normal guard. Each family carries its own curve.
function punchBlockIgnore(key: "jabPower" | "hookPower" | "uppercutPower", level: number): number {
  return refCurve(key, "blockIgnore", level);
}

/**
 * The defender-rhythm window that counts as a rhythm cut. Shared by the
 * block-ignore roll in tryHit and the cut classification in applyHit, so the two
 * cannot drift: a punch the roll lets through must also register as a cut.
 *
 * Half-width, hung off BOTH ends of the arc like the base vulnerability window
 * (see isInRhythmVulnWindow): the cut keeps its own fixed 10% of total exposure,
 * it just sits at the turnarounds now instead of the middle.
 */
const RHYTHM_CUT_VULN_HALF = 0.05;
/**
 * Base chance a punch arriving inside that window ignores the guard — and,
 * unlike every other bypass in tryHit, a perfect block with it. Both corners.
 */
const RHYTHM_CUT_BLOCK_IGNORE_CHANCE = 0.25;
// What a landed rhythm cut takes off the defender's max stamina, and the most
// every cut together can take in one bout, are Max Stamina Events like the rest
// — both live in the Neural Network tuning screen.

/**
 * Bruiser only pays out from the outer quarters of the THROWER's own sway — the
 * back foot (0-25%) and the front foot (75-100%) — measured when the punch was
 * thrown, not when it lands.
 */
function bruiserBlockIgnore(level: number): number {
  return refCurve("bruiser", "blockIgnore", level);
}

/**
 * KO Artist fills the charge meter on its own. The rate is in meter units per
 * second, and one of the six bars is 100 units. The gain is fractional by
 * design; it lands in `chargeMeterCounters`, never rounded.
 */
export function koArtistChargeRate(level: number): number {
  return refCurve("koArtist", "chargePerSec", level);
}

/**
 * Is this fighter's sway actually sweeping right now? A sway that is switched off
 * or paused by a landed cut parks at an extreme of the arc, so rhythmProgress on
 * its own cannot tell "throwing off the back foot" from "not swaying at all".
 */
function isSwayRunning(fighter: FighterState): boolean {
  if (fighter.rhythmPauseTimer > 0 || fighter.swayFrozen) return false;
  return fighter.defenseState === "duck" ? fighter.rhythmLevel > 0 : fighter.swaySpeedLevel > 0;
}

export function startFight(state: GameState, archetype: Archetype, playerLevel: number, enemyLevel: number, playerName?: string, playerColors?: FighterColors, isQuickFight: boolean = false, aiDifficulty: AIDifficulty = "contender", totalRounds: number = 3, roundDurationSeconds: number = 180, timerSpeed: TimerSpeed = "normal", playerArmLength: number = 65, enemyArmLength: number = 65, overrideEnemyArchetype?: Archetype, overrideEnemyName?: string, trainingBonuses?: { weightLifting: number; heavyBag: number; sparring?: number }, fatigueEnabled: boolean = false, towelStoppageEnabled: boolean = true, practiceMode: boolean = false, recordInputs: boolean = false, cpuVsCpu: boolean = false, overrideEnemyColors?: FighterColors, sparringMode: boolean = false, careerStaminaTier?: AIDifficulty, qfAiPowerMult: number = 1, qfAiSpeedMult: number = 1, qfAiStaminaMult: number = 1, playerSkillPoints?: { power: number; speed: number; defense: number; stamina: number; focus?: number }, enemySkillPoints?: { power: number; speed: number; defense: number; stamina: number; focus?: number }, mercyStoppageEnabled: boolean = true, enemyRosterId?: number, playerRefinement?: { offenseUnlocked?: boolean; defenseUnlocked?: boolean; fightIqUnlocked?: boolean; pressureFighter?: number; precisionStriker?: number; jabPower?: number; hookPower?: number; uppercutPower?: number; bruiser?: number; koArtist?: number; ironChin?: number; slippery?: number; guardMaster?: number; duckRecovery?: number; punchRolling?: number; fastTwitch?: number; heartRefinement?: number; chinHitter?: number; technician?: number; lifeDrain?: number }, enemyRefinement?: { offenseUnlocked?: boolean; defenseUnlocked?: boolean; fightIqUnlocked?: boolean; pressureFighter?: number; precisionStriker?: number; jabPower?: number; hookPower?: number; uppercutPower?: number; bruiser?: number; koArtist?: number; ironChin?: number; slippery?: number; guardMaster?: number; duckRecovery?: number; punchRolling?: number; fastTwitch?: number; heartRefinement?: number; chinHitter?: number; technician?: number; lifeDrain?: number }, isNightmareFight: boolean = false, enemyRank?: number, doghouseMode: boolean = false, doghouseOpponentPool?: DoghouseOpponentSpec[], playerBoxingStance: BoxingStance = "orthodox", enemyBoxingStance: BoxingStance = "orthodox"): GameState {
  const enemyArchetypes: Archetype[] = ["BoxerPuncher", "OutBoxer", "Brawler", "Swarmer"];
  const enemyArchetype = overrideEnemyArchetype || enemyArchetypes[Math.floor(Math.random() * enemyArchetypes.length)];
  const enemyName = overrideEnemyName || ENEMY_NAMES[Math.floor(Math.random() * ENEMY_NAMES.length)];

  const randomEnemyColors: FighterColors = overrideEnemyColors || {
    gloves: ["#1155cc", "#22aa22", "#ddaa00", "#aa22aa", "#ff6600"][Math.floor(Math.random() * 5)],
    gloveTape: ["#eeeeee", "#cccccc", "#222222"][Math.floor(Math.random() * 3)],
    socks: ["#f0f0f0", "#e6e6e6", "#111111", "#cc2222"][Math.floor(Math.random() * 4)],
    trunks: ["#222222", "#cc2222", "#22aa22", "#ddaa00", "#aa22aa"][Math.floor(Math.random() * 5)],
    shoes: ["#1a1a1a", "#2a1a1a", "#222222"][Math.floor(Math.random() * 3)],
    skin: SKIN_COLOR_PRESETS[Math.floor(Math.random() * SKIN_COLOR_PRESETS.length)],
  };

  const player = createFighter(playerName || "Player", archetype, playerLevel, PLAYER_START_X, PLAYER_START_Z, 1, true, playerColors || state.playerColors, playerArmLength, playerBoxingStance);
  player.maxStamina *= 1.1;
  player.maxStaminaCap *= 1.1;
  player.stamina = player.maxStamina;
  if (trainingBonuses) {
    const wl = trainingBonuses.weightLifting;
    const hb = trainingBonuses.heavyBag;
    if (wl > 0) {
      player.damageMult *= 1 + Math.min(wl * 0.005, 0.15);
      player.defenseMult *= 1 - Math.min(wl * 0.005, 0.15);
    }
    if (hb > 0) {
      player.punchSpeedMult *= 1 + Math.min(hb * 0.005, 0.15);
      player.moveSpeed *= 1 + Math.min(hb * 0.005, 0.15);
      player.damageMult *= 1 + Math.min(hb * 0.005, 0.15);
    }
  }

  const enemy = createFighter(enemyName, enemyArchetype, enemyLevel, ENEMY_START_X, ENEMY_START_Z, -1, false, randomEnemyColors, enemyArmLength, enemyBoxingStance);
  enemy.punchProfileRosterId = enemyRosterId;

  {
    player.autoGuardDuration = levelScale(playerLevel, 10, 45, "autoGuardBase");
  }

  if (playerSkillPoints) {
    const sp = playerSkillPoints;
    const SC = getScaling();
    const MAX_SP = SC.caps.maxSp;
    const STAMINA_REGEN_CAP = SC.caps.staminaRegenCap;
    player.rawPower = sp.power;
    player.rawStamina = sp.stamina;
    player.rawSpeed = sp.speed;
    const pT = Math.min(1, sp.power / MAX_SP);
    const sT = effectiveSpeedFraction(sp.speed, enemySkillPoints?.speed || 0);
    const dT = Math.min(1, sp.defense / MAX_SP);
    const stT = Math.min(STAMINA_REGEN_CAP, sp.stamina) / SC.caps.staminaRegenDivisor;
    const stPoolT = Math.min(1, sp.stamina / MAX_SP);
    // Both corners run this identical line — no player-only champion boost.
    // The coefficient is the whole power term: maxed Power tops out at 6x.
    player.damageMult *= 1 + pointCoef("powerDamage", 5) * pT * pT;
    player.punchSpeedMult *= 1 + sT * pointCoef("speedPunch", 1.427);
    player.moveSpeed *= 1 + sT * pointCoef("speedMove", 0.15);
    player.duckSpeedMult = 1 + sT * pointCoef("speedDuck", 0.6);
    player.blockMult = 1 + dT * pointCoef("defenseBlock", 0.6);
    player.critResistMult = 1 - dT * pointCoef("defenseCritResist", 0.27);
    player.telegraphSpeedMult = speedTelegraphMult(sp.speed);
    player.staminaRegen *= 1 + stT * pointCoef("staminaRegen", 0.6);
    player.maxStamina *= 1 + stPoolT * pointCoef("staminaPool", 0.24);
    player.maxStaminaCap *= 1 + stPoolT * pointCoef("staminaPool", 0.24);
    player.stamina = player.maxStamina;
    player.defenseT = dT;
    player.speedT = sT;
    const fT = Math.min(1, (playerSkillPoints.focus || 0) / MAX_SP);
    player.focusT = fT;
    player.critMult *= 1 + fT * pointCoef("focusCrit", 1.8);
    player.stunMult *= 1 + fT * pointCoef("focusStun", 1.8);
    player.chargeEmpoweredDuration = 3.0 + fT * pointCoef("focusChargeWindow", 2.1);
    const baseAutoGuard = levelScale(playerLevel, 10, 45, "autoGuardBase");
    const defenseBlockMult = 1 + pointCoef("defenseAutoGuardRamp", 9) * Math.min(1, Math.max(0, (dT - 0.2) / 0.8));
    player.autoGuardDuration = baseAutoGuard + dT * pointCoef("defenseAutoGuard", 40.5) * defenseBlockMult;
  }

  // Only the refinements each corner is actually bringing turn into fight
  // numbers. The player's pick list decides theirs (empty = none); an opponent
  // map has no list, so its five highest stand in. Everything below — both
  // corner blocks and the fast-twitch pass — reads the filtered maps.
  playerRefinement = activeRefinementsOnly(playerRefinement, true);
  enemyRefinement = activeRefinementsOnly(enemyRefinement);

  if (playerRefinement) {
    const r = playerRefinement;
    if (r.offenseUnlocked) {
      if ((r.pressureFighter ?? 0) > 0) {
        const pf = refCurve("pressureFighter", "damage", r.pressureFighter!) * refNum("pressureFighter", "powerScale");
        player.powerBonusPct += pf;
        player.pressureRhythmCutChance = refCurve("pressureFighter", "cutChance", r.pressureFighter!);
        player.pressureRhythmCutMult = 1.0 - refCurve("pressureFighter", "cutStrength", r.pressureFighter!);
        player.pressureBlockDmgMult = 1 + (r.pressureFighter! >= refNum("pressureFighter", "blockDmgLevel1") ? refNum("pressureFighter", "blockDmgBonus1") : 0) + (r.pressureFighter! >= refNum("pressureFighter", "blockDmgLevel2") ? refNum("pressureFighter", "blockDmgBonus2") : 0);
      }
      if ((r.precisionStriker ?? 0) > 0) {
        player.critMult *= (1 + refCurve("precisionStriker", "crit", r.precisionStriker!));
        player.staminaCostMult *= Math.max(refNum("precisionStriker", "staminaCostFloor"), 1 - refCurve("precisionStriker", "staminaCost", r.precisionStriker!));
        player.precisionStrikerRangeBonus = precisionStrikerRangeBonus(r.precisionStriker!);
        player.precisionStrikerDodgeNegate = precisionStrikerDodgeNegate(r.precisionStriker!);
      }
      if ((r.jabPower ?? 0) > 0) {
        player.refJabBonus = refCurve("jabPower", "damage", r.jabPower!) * refNum("jabPower", "powerScale");
        player.chargeJabBlockBypass = refCurve("jabPower", "chargeBypass", r.jabPower!);
        player.refJabCritMult = refCurve("jabPower", "crit", r.jabPower!);
        player.straightBlockIgnoreChance = punchBlockIgnore("jabPower", r.jabPower!);
      }
      if ((r.hookPower ?? 0) > 0) {
        player.refHookBonus = refCurve("hookPower", "damage", r.hookPower!) * refNum("hookPower", "powerScale");
        player.chargeHookBlockBypass = refCurve("hookPower", "chargeBypass", r.hookPower!);
        player.refHookCritMult = refCurve("hookPower", "crit", r.hookPower!);
        player.hookBlockIgnoreChance = punchBlockIgnore("hookPower", r.hookPower!);
      }
      if ((r.uppercutPower ?? 0) > 0) {
        player.refUppercutBonus = refCurve("uppercutPower", "damage", r.uppercutPower!) * refNum("uppercutPower", "powerScale");
        player.chargeUppercutBlockBypass = refCurve("uppercutPower", "chargeBypass", r.uppercutPower!);
        player.refUppercutCritMult = refCurve("uppercutPower", "crit", r.uppercutPower!);
        player.uppercutBlockIgnoreChance = punchBlockIgnore("uppercutPower", r.uppercutPower!);
      }
      if ((r.bruiser ?? 0) > 0) {
        player.bruiserBlockIgnoreChance = bruiserBlockIgnore(r.bruiser!);
      }
      if ((r.koArtist ?? 0) > 0) {
        player.koArtistChargeRate = koArtistChargeRate(r.koArtist!);
      }
    }
    if (r.defenseUnlocked) {
      if ((r.ironChin ?? 0) > 0) {
        player.ironChinStunResist = refCurve("ironChin", "stunResist", r.ironChin!);
        player.ironChinDamageReduction = refCurve("ironChin", "damageReduction", r.ironChin!);
        player.ironChinStunSlowReduction = refCurve("ironChin", "stunDelay", r.ironChin!);
      }
      if ((r.slippery ?? 0) > 0) {
        player.slipperySpeedMult = slipperySpeedMult(r.slippery!);
        player.slipperyRepunchThreshold = slipperyRepunchThreshold(r.slippery!);
      }
      if ((r.guardMaster ?? 0) > 0) {
        player.blockMult *= (1 + refCurve("guardMaster", "blockMult", r.guardMaster!));
        player.chargePunchFullBlock = r.guardMaster! >= refNum("guardMaster", "chargeFullBlockLevel");
        player.pbIgnoresRhythmVuln = r.guardMaster! >= refNum("guardMaster", "pbIgnoresVulnLevel");
      }
      if ((r.duckRecovery ?? 0) > 0) {
        player.duckStaminaRegenMult = refCurve("duckRecovery", "regen", r.duckRecovery!);
      }
      if ((r.punchRolling ?? 0) > 0) {
        player.punchRollingMult = 1 - refCurve("punchRolling", "damageTaken", r.punchRolling!);
        player.punchRollingRepunchBoost = refCurve("punchRolling", "repunchBoost", r.punchRolling!);
        player.punchRollingBigShotNegate = refCurve("punchRolling", "bigShotNegate", r.punchRolling!);
      }
    }
    if (r.fightIqUnlocked) {
      if ((r.fastTwitch ?? 0) > 0) {
        player.telegraphSpeedMult *= Math.max(0, 1 - refCurve("fastTwitch", "telegraph", r.fastTwitch!));
        player.fastTwitchRank = r.fastTwitch!;
      }
      if ((r.heartRefinement ?? 0) > 0) {
        const hb = refCurve("heartRefinement", "stamina", r.heartRefinement!);
        player.maxStamina *= (1 + hb);
        player.maxStaminaCap *= (1 + hb);
        player.stamina = player.maxStamina;
        player.staminaRegen *= (1 + hb);
        player.repunchPenaltyMult = refCurve("heartRefinement", "repunchPenalty", r.heartRefinement!);
      }
      if ((r.chinHitter ?? 0) > 0) {
        player.stunMult *= (1 + refCurve("chinHitter", "stun", r.chinHitter!));
        player.chinHitterVulnBonus = refCurve("chinHitter", "vuln", r.chinHitter!);
        player.chinHitterChargeDamageMult = chinHitterChargeMult(r.chinHitter!);
      }
      if ((r.technician ?? 0) > 0) {
        player.technicianRcStunChance = refCurve("technician", "rcStun", r.technician!);
        player.technicianChargeWhiffForgiveness = technicianWhiffForgiveness(r.technician!);
        player.technicianFeintCancelUnlocked = r.technician! >= refNum("technician", "feintCancelLevel");
        player.technicianAccuracyBoost = refCurve("technician", "accuracy", r.technician!);
      }
      if ((r.lifeDrain ?? 0) > 0) {
        player.lifeDrainPct = refCurve("lifeDrain", "drain", r.lifeDrain!);
      }
    }
  }

  if (enemyRefinement) {
    const er = enemyRefinement;
    if (er.offenseUnlocked) {
      if ((er.pressureFighter ?? 0) > 0) {
        const pf = refCurve("pressureFighter", "damage", er.pressureFighter!) * refNum("pressureFighter", "powerScale");
        enemy.powerBonusPct += pf;
        enemy.pressureRhythmCutChance = refCurve("pressureFighter", "cutChance", er.pressureFighter!);
        enemy.pressureRhythmCutMult = 1.0 - refCurve("pressureFighter", "cutStrength", er.pressureFighter!);
        enemy.pressureBlockDmgMult = 1 + (er.pressureFighter! >= refNum("pressureFighter", "blockDmgLevel1") ? refNum("pressureFighter", "blockDmgBonus1") : 0) + (er.pressureFighter! >= refNum("pressureFighter", "blockDmgLevel2") ? refNum("pressureFighter", "blockDmgBonus2") : 0);
      }
      if ((er.precisionStriker ?? 0) > 0) {
        enemy.critMult *= (1 + refCurve("precisionStriker", "crit", er.precisionStriker!));
        enemy.staminaCostMult *= Math.max(refNum("precisionStriker", "staminaCostFloor"), 1 - refCurve("precisionStriker", "staminaCost", er.precisionStriker!));
        enemy.precisionStrikerRangeBonus = precisionStrikerRangeBonus(er.precisionStriker!);
        enemy.precisionStrikerDodgeNegate = precisionStrikerDodgeNegate(er.precisionStriker!);
      }
      if ((er.jabPower ?? 0) > 0) {
        enemy.refJabBonus = refCurve("jabPower", "damage", er.jabPower!) * refNum("jabPower", "powerScale");
        enemy.chargeJabBlockBypass = refCurve("jabPower", "chargeBypass", er.jabPower!);
        enemy.refJabCritMult = refCurve("jabPower", "crit", er.jabPower!);
        enemy.straightBlockIgnoreChance = punchBlockIgnore("jabPower", er.jabPower!);
      }
      if ((er.hookPower ?? 0) > 0) {
        enemy.refHookBonus = refCurve("hookPower", "damage", er.hookPower!) * refNum("hookPower", "powerScale");
        enemy.chargeHookBlockBypass = refCurve("hookPower", "chargeBypass", er.hookPower!);
        enemy.refHookCritMult = refCurve("hookPower", "crit", er.hookPower!);
        enemy.hookBlockIgnoreChance = punchBlockIgnore("hookPower", er.hookPower!);
      }
      if ((er.uppercutPower ?? 0) > 0) {
        enemy.refUppercutBonus = refCurve("uppercutPower", "damage", er.uppercutPower!) * refNum("uppercutPower", "powerScale");
        enemy.chargeUppercutBlockBypass = refCurve("uppercutPower", "chargeBypass", er.uppercutPower!);
        enemy.refUppercutCritMult = refCurve("uppercutPower", "crit", er.uppercutPower!);
        enemy.uppercutBlockIgnoreChance = punchBlockIgnore("uppercutPower", er.uppercutPower!);
      }
      if ((er.bruiser ?? 0) > 0) {
        enemy.bruiserBlockIgnoreChance = bruiserBlockIgnore(er.bruiser!);
      }
      if ((er.koArtist ?? 0) > 0) {
        enemy.koArtistChargeRate = koArtistChargeRate(er.koArtist!);
      }
    }
    if (er.defenseUnlocked) {
      if ((er.ironChin ?? 0) > 0) {
        enemy.ironChinStunResist = refCurve("ironChin", "stunResist", er.ironChin!);
        enemy.ironChinDamageReduction = refCurve("ironChin", "damageReduction", er.ironChin!);
        enemy.ironChinStunSlowReduction = refCurve("ironChin", "stunDelay", er.ironChin!);
      }
      if ((er.slippery ?? 0) > 0) {
        enemy.slipperySpeedMult = slipperySpeedMult(er.slippery!);
        enemy.slipperyRepunchThreshold = slipperyRepunchThreshold(er.slippery!);
      }
      if ((er.guardMaster ?? 0) > 0) {
        enemy.blockMult *= (1 + refCurve("guardMaster", "blockMult", er.guardMaster!));
        enemy.chargePunchFullBlock = er.guardMaster! >= refNum("guardMaster", "chargeFullBlockLevel");
        enemy.pbIgnoresRhythmVuln = er.guardMaster! >= refNum("guardMaster", "pbIgnoresVulnLevel");
      }
      if ((er.duckRecovery ?? 0) > 0) {
        enemy.duckStaminaRegenMult = refCurve("duckRecovery", "regen", er.duckRecovery!);
      }
      if ((er.punchRolling ?? 0) > 0) {
        enemy.punchRollingMult = 1 - refCurve("punchRolling", "damageTaken", er.punchRolling!);
        enemy.punchRollingRepunchBoost = refCurve("punchRolling", "repunchBoost", er.punchRolling!);
        enemy.punchRollingBigShotNegate = refCurve("punchRolling", "bigShotNegate", er.punchRolling!);
      }
    }
    if (er.fightIqUnlocked) {
      if ((er.fastTwitch ?? 0) > 0) {
        enemy.telegraphSpeedMult *= Math.max(0, 1 - refCurve("fastTwitch", "telegraph", er.fastTwitch!));
        enemy.fastTwitchRank = er.fastTwitch!;
      }
      if ((er.heartRefinement ?? 0) > 0) {
        const hb = refCurve("heartRefinement", "stamina", er.heartRefinement!);
        enemy.maxStamina *= (1 + hb);
        enemy.maxStaminaCap *= (1 + hb);
        enemy.stamina = enemy.maxStamina;
        enemy.staminaRegen *= (1 + hb);
        enemy.repunchPenaltyMult = refCurve("heartRefinement", "repunchPenalty", er.heartRefinement!);
      }
      if ((er.chinHitter ?? 0) > 0) {
        enemy.stunMult *= (1 + refCurve("chinHitter", "stun", er.chinHitter!));
        enemy.chinHitterVulnBonus = refCurve("chinHitter", "vuln", er.chinHitter!);
        enemy.chinHitterChargeDamageMult = chinHitterChargeMult(er.chinHitter!);
      }
      if ((er.technician ?? 0) > 0) {
        enemy.technicianRcStunChance = refCurve("technician", "rcStun", er.technician!);
        enemy.technicianChargeWhiffForgiveness = technicianWhiffForgiveness(er.technician!);
        enemy.technicianFeintCancelUnlocked = er.technician! >= refNum("technician", "feintCancelLevel");
        enemy.technicianAccuracyBoost = refCurve("technician", "accuracy", er.technician!);
      }
      if ((er.lifeDrain ?? 0) > 0) {
        enemy.lifeDrainPct = refCurve("lifeDrain", "drain", er.lifeDrain!);
      }
    }
  }

  // Fast twitch moveSpeed: each fighter's rank applies independently as a flat
  // multiplier. The coefficient is 30% off its original 0.0035 -- a maxed rank
  // was opening a footspeed gap that read as the opponent teleporting around
  // the ring rather than as a refinement.
  {
    const playerFT = playerRefinement?.fastTwitch ?? 0;
    const enemyFT = enemyRefinement?.fastTwitch ?? 0;
    if (playerFT > 0) player.moveSpeed *= 1 + playerFT * refNum("fastTwitch", "movePerLevel");
    if (enemyFT > 0) enemy.moveSpeed *= 1 + enemyFT * refNum("fastTwitch", "movePerLevel");
  }

  if (enemySkillPoints) {
    const esp = enemySkillPoints;
    const SC = getScaling();
    const MAX_SP = SC.caps.maxSp;
    const STAMINA_REGEN_CAP = SC.caps.staminaRegenCap;
    enemy.rawPower = esp.power;
    enemy.rawStamina = esp.stamina;
    enemy.rawSpeed = esp.speed;
    const epT = Math.min(1, esp.power / MAX_SP);
    const esT = effectiveSpeedFraction(esp.speed, playerSkillPoints?.speed || 0);
    const edT = Math.min(1, esp.defense / MAX_SP);
    const estT = Math.min(STAMINA_REGEN_CAP, esp.stamina) / SC.caps.staminaRegenDivisor;
    const estPoolT = Math.min(1, esp.stamina / MAX_SP);
    enemy.damageMult *= 1 + pointCoef("powerDamage", 5) * epT * epT;
    enemy.punchSpeedMult *= 1 + esT * pointCoef("speedPunch", 1.427);
    enemy.moveSpeed *= 1 + esT * pointCoef("speedMove", 0.15);
    enemy.duckSpeedMult = 1 + esT * pointCoef("speedDuck", 0.6);
    enemy.blockMult = 1 + edT * pointCoef("defenseBlock", 0.6);
    enemy.critResistMult = 1 - edT * pointCoef("defenseCritResist", 0.27);
    enemy.telegraphSpeedMult = speedTelegraphMult(esp.speed);
    enemy.staminaRegen *= 1 + estT * pointCoef("staminaRegen", 0.6);
    enemy.maxStamina *= 1 + estPoolT * pointCoef("staminaPool", 0.24);
    enemy.maxStaminaCap *= 1 + estPoolT * pointCoef("staminaPool", 0.24);
    enemy.stamina = enemy.maxStamina;
    enemy.defenseT = edT;
    enemy.speedT = esT;
    const efT = Math.min(1, (esp.focus || 0) / MAX_SP);
    enemy.focusT = efT;
    enemy.critMult *= 1 + efT * pointCoef("focusCrit", 1.8);
    enemy.stunMult *= 1 + efT * pointCoef("focusStun", 1.8);
    enemy.chargeEmpoweredDuration = 3.0 + efT * pointCoef("focusChargeWindow", 2.1);
    const eBaseAutoGuard = levelScale(enemyLevel, 10, 45, "autoGuardBase");
    const eDefenseBlockMult = 1 + pointCoef("defenseAutoGuardRamp", 9) * Math.min(1, Math.max(0, (edT - 0.2) / 0.8));
    enemy.autoGuardDuration = eBaseAutoGuard + edT * pointCoef("defenseAutoGuard", 40.5) * eDefenseBlockMult;
  }

  // The level gap's biggest single effect: the higher-level corner simply moves
  // and hits harder for the whole bout. Set at the bell, so it is the one gap
  // row that needs a new fight to take effect.
  const lvlGap = playerLevel - enemyLevel;
  const gapMult = (id: string, diff: number) => clampGapMult(1 + levelGapAdj(id, diff));
  player.damageMult *= gapMult("gapDamage", lvlGap);
  player.moveSpeed *= gapMult("gapMoveSpeed", lvlGap);
  enemy.damageMult *= gapMult("gapDamage", -lvlGap);
  enemy.moveSpeed *= gapMult("gapMoveSpeed", -lvlGap);

  if (aiDifficulty === "champion") {
    enemy.damageMult *= 1.185;
    enemy.moveSpeed *= 1.05;
  } else if (aiDifficulty === "elite") {
    enemy.damageMult *= 1.133;
    enemy.moveSpeed *= 1.02;
  } else if (aiDifficulty === "contender") {
    enemy.damageMult *= 1.082;
  } else {
    enemy.damageMult *= 1.030;
  }

  if (aiDifficulty === "champion") {
    enemy.damageMult *= 1.6;
  }

  // Career bouts carry NO hardcoded corner multipliers. Everything career-specific
  // rides the neural tuning values (careerPlayer*/careerOpponent*, default 1.0) so
  // the two corners run identical math and every handicap is visible and tunable.

  if (isQuickFight) {
    enemy.damageMult *= qfAiPowerMult;
    enemy.moveSpeed *= qfAiSpeedMult;
  }

  if (careerStaminaTier) {
    // The career AI's gas tank is a *share* of the pool it was already built
    // with, not an absolute points figure.
    //
    // Everything else on the board — the player, the sparring partner, the
    // quick-fight AI — gets BASE_STAMINA scaled by the maxStamina ramp and the
    // staminaPool coefficient, both of which are tunable and both of which have
    // been raised well past their original values. An absolute table could not
    // follow them, so the official-fight AI ended up on a different scale
    // entirely and emptied its tank in the first round. Sparring never passes a
    // tier, which is exactly why sparring always felt right: it runs on the
    // natural pool. A share keeps official fights in line with it while still
    // letting the tiers differ.
    const tierShare: Record<AIDifficulty, [number, number]> = {
      journeyman: [0.70, 0.80],
      contender: [0.78, 0.88],
      elite: [0.86, 0.94],
      champion: [0.92, 1.00],
    };
    const tierRampId: Record<AIDifficulty, string> = {
      journeyman: "careerStaminaShareJourneyman",
      contender: "careerStaminaShareContender",
      elite: "careerStaminaShareElite",
      champion: "careerStaminaShareChampion",
    };
    // The champion's tank used to take a separate 15% trim on top of its tier.
    // That trim lives in the share ladder now, so it is not applied twice.
    const [minShare, maxShare] = tierShare[careerStaminaTier];
    const share = levelScale(enemyLevel, minShare, maxShare, tierRampId[careerStaminaTier]);
    enemy.maxStamina *= share;
    enemy.maxStaminaCap *= share;
    enemy.stamina = enemy.maxStamina;
  }

  enemy.stamina *= qfAiStaminaMult;
  enemy.maxStamina *= qfAiStaminaMult;
  enemy.maxStaminaCap *= qfAiStaminaMult;

  const newState: GameState = {
    ...state,
    phase: "prefight" as const,
    player,
    enemy,
    currentRound: 1,
    totalRounds: totalRounds,
    roundTimer: roundDurationSeconds,
    roundDuration: roundDurationSeconds,
    roundScores: [],
    fightResult: null,
    fightWinner: null,
    xpGained: 0,
    careerXpMult: 1,
    canSurpassLevel100: true,
    itemKdAvoidChance: 0,
    itemRhythmCutFailChance: 0,
    opponentItemKdAvoidChance: 0,
    opponentItems: undefined,
    // Equipment is handed to the state after startFight, per bout — cleared here
    // so a previous bout's gear can't ride along into the next one.
    playerEquipment: null,
    opponentEquipment: null,
    countdownTimer: COUNTDOWN_DURATION,
    knockdownCountdown: 0,
    knockdownMashCount: 0,
    knockdownMashRequired: 25,
    knockdownMashTimer: 0,
    knockdownRefCount: 0,
    knockdownActive: false,
    kdFallTimer: KD_FALL_DURATION,
    enemyName,
    enemyLevel,
    playerLevel,
    isPaused: false,
    pauseSelectedIndex: 0,
    pauseAction: null,
    pauseSoundTab: false,
    pauseControlsTab: false,
    isQuickFight,
    fatigueEnabled,
    aiDifficulty,
    cornerWalkActive: false,
    cornerWalkTimer: 0,
    aiKdGetUpTime: 0,
    aiKdWillGetUp: false,
    earlyBlitzKoActive: false,
    earlyBlitzStopCount: 0,
    aiKdChancePenalty: 0,
    refereeVisible: false,
    standingFighterTargetX: 0,
    standingFighterTargetZ: RING_CENTER_Z,
    savedDefenseState: "none",
    savedHandsDown: false,
    savedBlockTimer: 0,
    savedStandingIsPlayer: false,
    kdSavedKnockedRhythmLevel: 2,
    kdSavedStandingRhythmLevel: 2,
    hitEffects: [],
    maxStaminaDeltaTexts: [],
    shakeIntensity: 0,
    shakeTimer: 0,
    ringTop: RING_TOP,
    ringBottom: RING_BOTTOM,
    ringDepth: RING_BOTTOM - RING_TOP,
    roundStats: {
      playerDamageThisRound: 0,
      enemyDamageThisRound: 0,
      playerActualDamageThisRound: 0,
      enemyActualDamageThisRound: 0,
      playerPunchesThisRound: 0,
      enemyPunchesThisRound: 0,
      playerLandedThisRound: 0,
      enemyLandedThisRound: 0,
      playerKDsThisRound: 0,
      enemyKDsThisRound: 0,
      playerAggressionTime: 0,
      enemyAggressionTime: 0,
      playerRingControlTime: 0,
      enemyRingControlTime: 0,
      playerPunchesDodged: 0,
      enemyPunchesDodged: 0,
      playerPunchesBlocked: 0,
      enemyPunchesBlocked: 0,
      playerDuckDodges: 0,
      playerComboCount: 0,
      playerConsecutiveLanded: 0,
    },
    timerSpeed,
    aiBrain: initAiBrain(aiDifficulty, enemyArchetype, enemyLevel, cpuVsCpu, enemyRosterId, sparringMode && !isNightmareFight && aiDifficulty === "champion", enemyRank),
    fightTotalDuckDodges: 0,
    fightTotalCombos: 0,
    fightFastTwitchBonus: 0,
    kdIsBodyShot: false,
    kdTakeKnee: false,
    kdFaceRefActive: false,
    kdFaceRefTimer: 0,
    refStoppageActive: false,
    refStoppageTimer: 0,
    refStoppageType: null,
    mercyStoppageEnabled: mercyStoppageEnabled,
    towelStoppageEnabled: towelStoppageEnabled,
    practiceMode: practiceMode,
    cpuAttacksEnabled: true,
    cpuDefenseEnabled: true,
    sparringMode: sparringMode,
    // Per-fight, and set by the caller *after* startFight: a stale true from a
    // previous session would otherwise black out an ordinary sparring gym.
    importSparring: false,
    // Snapshotted at the bell so hit resolution never touches localStorage per punch.
    directionalPerfectBlock: isDirectionalPerfectBlockEnabled(),
    staticCamera: false,
    doghouseMode: doghouseMode,
    towelActive: false,
    towelTimer: 0,
    towelStartX: 0,
    towelStartY: 0,
    towelEndX: 0,
    towelEndY: 0,
    refX: RING_CX,
    refZ: RING_CY,
    playerColors: playerColors ? { ...playerColors } : { ...state.playerColors },
    enemyColors: { ...randomEnemyColors },
    ringCanvasColor: doghouseMode ? DOGHOUSE_RING_COLOR : nextRingCanvasColor,
    // Cleared every fight: only the sparring entry points re-apply the
    // player's saved ring, so a career bout always gets the house ring.
    ringColors: undefined,
    nightmareMode: false,
    nightmareEnemies: [],
    nightmareAiBrains: [],
    nightmareKillCount: 0,
    nightmareSpawnTimer: 0,
    nightmareSpawnDelay: 0,
    nightmareEnemyDefeated: false,
    nightmareLevel: 1,
    nightmareDifficulty: "champion",
    nightmareTimeSurvived: 0,
    nightmareRegenBoostTimer: 0,
    nightmareCurrentSpawnInterval: 25,
    nightmareEnemyActiveSince: 0,
    nightmareQuickKOs: 0,
    nightmareVeryQuickKOs: 0,
    nightmareRegenBoostMult: 0,
    nightmareStaminaDrainTimer: 0,
    nightmareRefinementBudget: 0,
    nightmareRefinementPlayerTotal: 0,
    nightmareSpawnIndex: 0,
    doghouseOpponentsDefeated: 0,
    doghouseStaminaMult: doghouseMode ? DOGHOUSE_ENEMY_STAMINA_MULT : 1,
    doghousePowerMult: doghouseMode ? 2 : 1,
    doghouseOpponentPool: doghouseOpponentPool || [],
    totalEnemyKDs: 0,
    kdSequence: [],
    towelImmunityUsed: false,
    enemyRank,
    fightElapsedTime: 0,
    kdTimerExpired: false,
    koDelayTimer: -1,
    aiKoStopTime: -1,
    aiKoPendingResult: null,
    bigShotTextTimer: 0,
    kdEarlyStopCheckedCount: 0,
    introAnimActive: true,
    introAnimTimer: 0,
    introAnimPhase: 0,
    playerIntroPlaying: true,
    enemyIntroPlaying: true,
    playerSavedRhythmLevel: player.rhythmLevel,
    enemySavedRhythmLevel: 2,
    swarmerPunchQueue: generateSwarmerPunchQueue(),
    swarmerPunchIndex: 0,
    swarmerPunchDelay: 0,
    swarmerIsPlayer: archetype === "Swarmer",
    cpuVsCpu,
    playerAiBrain: cpuVsCpu ? initAiBrain(aiDifficulty, archetype, playerLevel, true) : null,
    telegraphMult: getTelegraphMult(),
    hitstopTimer: 0,
    hitstopDuration: 0,
    crowdBobTime: 0,
    crowdKdBounceTimer: 0,
    crowdExciteTimer: 0,
    crowdKdSpeedTimer: 0,
    recordInputs,
    inputRecording: recordInputs ? {
      fightSettings: {
        playerArchetype: archetype,
        enemyArchetype,
        playerLevel,
        enemyLevel,
        aiDifficulty,
        roundDuration: roundDurationSeconds,
        timerSpeed,
        totalRounds,
        playerArmLength,
        enemyArmLength,
        practiceMode,
        cpuVsCpu,
        playerName: playerName || "Player",
        enemyName: overrideEnemyName || "Enemy",
      },
      rounds: [],
    } : null,
    playerCurrentXp: 0,
    midFightLevelUps: 0,
    midFightLevelUpTimer: 0,
    adaptiveAiEnabled: getAdaptiveAiEnabled(),
    behaviorProfile: null,
  };
  if (newState.adaptiveAiEnabled) {
    newState.behaviorProfile = createBehaviorProfile(newState);
    if (newState.aiBrain) {
      newState.aiBrain.adaptiveMemory = createAdaptiveMemory(newState.aiBrain);
    }
    if (newState.playerAiBrain) {
      newState.playerAiBrain.adaptiveMemory = createAdaptiveMemory(newState.playerAiBrain);
    }
  }
  startIntroAnimForFighter(newState.player, newState.playerSavedRhythmLevel);
  startIntroAnimForFighter(newState.enemy, newState.enemySavedRhythmLevel);
  return newState;
}

/** Percent-style modifiers items apply to the player for one fight. */
export { applyItemFightMods } from "./itemFightMods";
export { applyAiPatternStudy, foldAiPatternLibrary } from "./ai";
export type { ItemFightMods } from "./itemFightMods";

const NIGHTMARE_SPAWN_INTERVAL = 25;
const NIGHTMARE_DEFEAT_BONUS_TIME = 2;
const NIGHTMARE_RING_COLOR = "#FFABAB";
/** The Doghouse always fights on a blue canvas, whatever the ring roll said. */
const DOGHOUSE_RING_COLOR = "#7FB4EA";

function randomNightmareColors(): FighterColors {
  return {
    gloves: ["#1155cc", "#22aa22", "#ddaa00", "#aa22aa", "#ff6600", "#cc2222"][Math.floor(Math.random() * 6)],
    gloveTape: ["#eeeeee", "#cccccc", "#222222"][Math.floor(Math.random() * 3)],
    socks: ["#f0f0f0", "#e6e6e6", "#111111", "#cc2222"][Math.floor(Math.random() * 4)],
    trunks: ["#222222", "#cc2222", "#22aa22", "#ddaa00", "#aa22aa", "#1155cc"][Math.floor(Math.random() * 6)],
    shoes: ["#1a1a1a", "#2a1a1a", "#222222"][Math.floor(Math.random() * 3)],
    skin: SKIN_COLOR_PRESETS[Math.floor(Math.random() * SKIN_COLOR_PRESETS.length)],
  };
}

function pickNightmareCorner(): { x: number; z: number } {
  const corners = [
    { x: RING_LEFT + 45, z: RING_TOP + 45 },
    { x: RING_RIGHT - 45, z: RING_TOP + 45 },
    { x: RING_LEFT + 45, z: RING_BOTTOM - 45 },
    { x: RING_RIGHT - 45, z: RING_BOTTOM - 45 },
  ];
  return corners[Math.floor(Math.random() * corners.length)];
}

/**
 * Share of its natural gas tank a Nightmare opponent walks in with. Applied to
 * every one of them — the fighter startFight built for the opening bell and
 * every spawn after it — before refinement and before the per-kill growth, so
 * the whole ladder is scaled, not just the first rung.
 */
export const NIGHTMARE_STAMINA_START_PCT = 0.20;

/**
 * One rung of the Nightmare refinement ladder. The first opponent carries this
 * share of everything the player has spent, and every opponent after it is one
 * more rung deep, to a ceiling of 100% (a full mirror of the player).
 */
export const NIGHTMARE_REFINEMENT_STEP_PCT = 0.02;

/** Points already spent across every refinement on a levels blob. */
function refinementPointsSpent(ref: Record<string, unknown> | undefined): number {
  if (!ref) return 0;
  let total = 0;
  for (const key of REFINEMENT_KEYS) {
    const lvl = ref[key];
    if (typeof lvl === "number" && lvl > 0) total += lvl;
  }
  return total;
}

/** Refinement budget for the nth Nightmare opponent (n = 1 is the first one). */
export function nightmareRefinementBudgetFor(playerTotal: number, n: number): number {
  if (playerTotal <= 0 || n < 1) return 0;
  const pct = Math.min(1, NIGHTMARE_REFINEMENT_STEP_PCT * n);
  return Math.min(REFINEMENT_TOTAL_CAP, Math.ceil(playerTotal * pct));
}

function applyNightmareModifiers(fighter: FighterState): void {
  fighter.moveSpeed *= 0.6;
  fighter.punchSpeedMult *= 0.6;
  fighter.maxStamina *= 0.75 * NIGHTMARE_STAMINA_START_PCT;
  fighter.maxStaminaCap = fighter.maxStamina;
  fighter.stamina = fighter.maxStamina;
}

/** Refinement levels an AI opponent can be built with. */
export interface RefinementLevels {
  offenseUnlocked?: boolean; defenseUnlocked?: boolean; fightIqUnlocked?: boolean;
  pressureFighter?: number; precisionStriker?: number; jabPower?: number; hookPower?: number;
  uppercutPower?: number; bruiser?: number; koArtist?: number; ironChin?: number; slippery?: number; guardMaster?: number;
  duckRecovery?: number; punchRolling?: number; fastTwitch?: number; heartRefinement?: number;
  chinHitter?: number; technician?: number; lifeDrain?: number;
}

/**
 * Applies a refinement spread to an AI fighter that was built outside
 * startFight — the Doghouse queue and Nightmare spawns both hand their
 * opponents levels this way. startFight has its own copy of these formulas for
 * the two corners it builds itself.
 */
export function applyRefinementToFighter(fighter: FighterState, ref: RefinementLevels | Record<string, number> | undefined): void {
  if (!ref) return;
  // Same five-active gate startFight's two corners run through.
  ref = activeRefinementsOnly(ref as Record<string, unknown>) as typeof ref;
  const er = { offenseUnlocked: true as boolean, defenseUnlocked: true as boolean, fightIqUnlocked: true as boolean, ...ref } as RefinementLevels;
  if (er.offenseUnlocked) {
    if ((er.pressureFighter ?? 0) > 0) { fighter.powerBonusPct += refCurve("pressureFighter", "damage", er.pressureFighter!) * refNum("pressureFighter", "powerScale"); fighter.pressureRhythmCutChance = refCurve("pressureFighter", "cutChance", er.pressureFighter!); fighter.pressureRhythmCutMult = 1.0 - refCurve("pressureFighter", "cutStrength", er.pressureFighter!); fighter.pressureBlockDmgMult = 1 + (er.pressureFighter! >= refNum("pressureFighter", "blockDmgLevel1") ? refNum("pressureFighter", "blockDmgBonus1") : 0) + (er.pressureFighter! >= refNum("pressureFighter", "blockDmgLevel2") ? refNum("pressureFighter", "blockDmgBonus2") : 0); }
    if ((er.jabPower ?? 0) > 0) { fighter.refJabBonus = refCurve("jabPower", "damage", er.jabPower!) * refNum("jabPower", "powerScale"); fighter.chargeJabBlockBypass = refCurve("jabPower", "chargeBypass", er.jabPower!); fighter.refJabCritMult = refCurve("jabPower", "crit", er.jabPower!); fighter.straightBlockIgnoreChance = punchBlockIgnore("jabPower", er.jabPower!); }
    if ((er.hookPower ?? 0) > 0) { fighter.refHookBonus = refCurve("hookPower", "damage", er.hookPower!) * refNum("hookPower", "powerScale"); fighter.chargeHookBlockBypass = refCurve("hookPower", "chargeBypass", er.hookPower!); fighter.refHookCritMult = refCurve("hookPower", "crit", er.hookPower!); fighter.hookBlockIgnoreChance = punchBlockIgnore("hookPower", er.hookPower!); }
    if ((er.uppercutPower ?? 0) > 0) { fighter.refUppercutBonus = refCurve("uppercutPower", "damage", er.uppercutPower!) * refNum("uppercutPower", "powerScale"); fighter.chargeUppercutBlockBypass = refCurve("uppercutPower", "chargeBypass", er.uppercutPower!); fighter.refUppercutCritMult = refCurve("uppercutPower", "crit", er.uppercutPower!); fighter.uppercutBlockIgnoreChance = punchBlockIgnore("uppercutPower", er.uppercutPower!); }
    if ((er.bruiser ?? 0) > 0) { fighter.bruiserBlockIgnoreChance = bruiserBlockIgnore(er.bruiser!); }
    if ((er.koArtist ?? 0) > 0) { fighter.koArtistChargeRate = koArtistChargeRate(er.koArtist!); }
    if ((er.precisionStriker ?? 0) > 0) { fighter.critMult *= (1 + refCurve("precisionStriker", "crit", er.precisionStriker!)); fighter.staminaCostMult *= Math.max(refNum("precisionStriker", "staminaCostFloor"), 1 - refCurve("precisionStriker", "staminaCost", er.precisionStriker!)); fighter.precisionStrikerRangeBonus = precisionStrikerRangeBonus(er.precisionStriker!); fighter.precisionStrikerDodgeNegate = precisionStrikerDodgeNegate(er.precisionStriker!); }
  }
  if (er.defenseUnlocked) {
    if ((er.ironChin ?? 0) > 0) { fighter.ironChinStunResist = refCurve("ironChin", "stunResist", er.ironChin!); fighter.ironChinDamageReduction = refCurve("ironChin", "damageReduction", er.ironChin!); fighter.ironChinStunSlowReduction = refCurve("ironChin", "stunDelay", er.ironChin!); }
    if ((er.slippery ?? 0) > 0) { fighter.slipperySpeedMult = slipperySpeedMult(er.slippery!); fighter.slipperyRepunchThreshold = slipperyRepunchThreshold(er.slippery!); }
    if ((er.guardMaster ?? 0) > 0) { fighter.blockMult *= (1 + refCurve("guardMaster", "blockMult", er.guardMaster!)); fighter.chargePunchFullBlock = er.guardMaster! >= refNum("guardMaster", "chargeFullBlockLevel"); fighter.pbIgnoresRhythmVuln = er.guardMaster! >= refNum("guardMaster", "pbIgnoresVulnLevel"); }
    if ((er.duckRecovery ?? 0) > 0) { fighter.duckStaminaRegenMult = refCurve("duckRecovery", "regen", er.duckRecovery!); }
    if ((er.punchRolling ?? 0) > 0) { fighter.punchRollingMult = 1 - refCurve("punchRolling", "damageTaken", er.punchRolling!); fighter.punchRollingRepunchBoost = refCurve("punchRolling", "repunchBoost", er.punchRolling!); fighter.punchRollingBigShotNegate = refCurve("punchRolling", "bigShotNegate", er.punchRolling!); }
  }
  if (er.fightIqUnlocked) {
    if ((er.fastTwitch ?? 0) > 0) { fighter.telegraphSpeedMult *= Math.max(0, 1 - refCurve("fastTwitch", "telegraph", er.fastTwitch!)); fighter.fastTwitchRank = er.fastTwitch!; fighter.moveSpeed *= 1 + er.fastTwitch! * refNum("fastTwitch", "movePerLevel"); }
    if ((er.heartRefinement ?? 0) > 0) { const hb = refCurve("heartRefinement", "stamina", er.heartRefinement!); fighter.maxStamina *= (1 + hb); fighter.maxStaminaCap *= (1 + hb); fighter.stamina = fighter.maxStamina; fighter.staminaRegen *= (1 + hb); fighter.repunchPenaltyMult = refCurve("heartRefinement", "repunchPenalty", er.heartRefinement!); }
    if ((er.chinHitter ?? 0) > 0) { fighter.stunMult *= (1 + refCurve("chinHitter", "stun", er.chinHitter!)); fighter.chinHitterVulnBonus = refCurve("chinHitter", "vuln", er.chinHitter!); fighter.chinHitterChargeDamageMult = chinHitterChargeMult(er.chinHitter!); }
    if ((er.technician ?? 0) > 0) { fighter.technicianRcStunChance = refCurve("technician", "rcStun", er.technician!); fighter.technicianChargeWhiffForgiveness = technicianWhiffForgiveness(er.technician!); fighter.technicianFeintCancelUnlocked = er.technician! >= refNum("technician", "feintCancelLevel"); fighter.technicianAccuracyBoost = refCurve("technician", "accuracy", er.technician!); }
    if ((er.lifeDrain ?? 0) > 0) { fighter.lifeDrainPct = refCurve("lifeDrain", "drain", er.lifeDrain!); }
  }
  fighter.refinementLevels = Object.fromEntries(
    REFINEMENT_KEYS.filter(k => ((ref as Record<string, number>)[k] ?? 0) > 0).map(k => [k, (ref as Record<string, number>)[k]]),
  );
}

/**
 * Applies a spread of Equipment Upgrade levels to a fighter.
 *
 * The single place the five pieces turn into fight numbers — both corners at
 * fight start and every mid-fight replacement corner run through here, so an
 * effect written once reaches all of them. Applied after startFight rather than
 * through its parameter list, the same way item boosts and punch endurance are.
 */
export function applyEquipmentToFighter(fighter: FighterState, levels: Record<string, number> | null | undefined): void {
  if (!hasEquipment(levels as EquipmentLevels | null)) return;
  const e = equipmentEffects(levels as EquipmentLevels);
  // Fight Gloves — a summand in the additive power pool, not a factor on the base.
  if (e.powerPct > 0) fighter.powerBonusPct += e.powerPct;
  if (e.autoGuardPct > 0) fighter.autoGuardDuration *= 1 + e.autoGuardPct;
  // Shoes
  if (e.moveSpeedPct > 0) fighter.moveSpeed *= 1 + e.moveSpeedPct;
  // Trunks — a flat pool addition the fighter walks in with, capped against the
  // tank they already have so the same flat number can't be worth ten times a
  // low-level fighter's whole pool. Applied before the first tick, which is
  // where boutStartMaxStamina is snapshotted, so the bigger tank is what every
  // refund is measured against.
  const trunksAdd = cappedStartMaxStamina(e.startMaxStamina, fighter.maxStamina);
  if (trunksAdd > 0) {
    fighter.maxStamina += trunksAdd;
    fighter.maxStaminaCap += trunksAdd;
    fighter.stamina = fighter.maxStamina;
  }
  // Mouthguard
  if (e.maxStaminaNegateChance > 0) fighter.maxStaminaNegateChance = e.maxStaminaNegateChance;
  if (e.critDamageResistPct > 0) fighter.critDamageResistPct = e.critDamageResistPct;
  if (e.bigShotNegateChance > 0) fighter.equipmentBigShotNegate = e.bigShotNegateChance;
  // Hand Wraps
  if (e.blockPct > 0) fighter.blockMult *= 1 + e.blockPct;
  if (e.perfectBlockHoldPct > 0) {
    fighter.perfectBlockHoldMult = (fighter.perfectBlockHoldMult ?? 1) * (1 + e.perfectBlockHoldPct);
  }
  if (e.critPct > 0) fighter.critMult *= 1 + e.critPct;
  if (e.stunPct > 0) fighter.stunMult *= 1 + e.stunPct;
}

/**
 * Hand both corners the Equipment Upgrades they walked in with and record them
 * on the state, so the corners built later in the bout — the Nightmare ladder
 * and the Doghouse pool — inherit the same gear.
 */
export function applyFightEquipment(
  state: GameState,
  levels: { player?: Record<string, number> | null; opponent?: Record<string, number> | null },
): void {
  state.playerEquipment = hasEquipment(levels.player as EquipmentLevels | null) ? levels.player! : null;
  state.opponentEquipment = hasEquipment(levels.opponent as EquipmentLevels | null) ? levels.opponent! : null;
  applyEquipmentToFighter(state.player, state.playerEquipment);
  applyEquipmentToFighter(state.enemy, state.opponentEquipment);
}

/**
 * Hand a mid-fight replacement corner the endurance values the bout was set up
 * with. Doghouse and Nightmare build fresh opponents long after the fight-start
 * pass has run, so without this they fall back to the engine defaults and a
 * configured roster-wide cost quietly stops applying after the first partner.
 */
function inheritPunchEnduranceFromCurrentEnemy(state: GameState, fighter: FighterState): void {
  const from = state.enemy;
  if (!from) return;
  fighter.punchEndurance = from.punchEndurance;
  fighter.punchEnduranceLoss = from.punchEnduranceLoss;
}

function buildNightmareEnemy(state: GameState): { fighter: FighterState; brain: AiBrainState } {
  const archetypes: Archetype[] = ["BoxerPuncher", "OutBoxer", "Brawler", "Swarmer"];
  const archetype = archetypes[Math.floor(Math.random() * archetypes.length)];
  const corner = pickNightmareCorner();
  const facing: 1 | -1 = corner.x < RING_CX ? 1 : -1;
  const name = ENEMY_NAMES[Math.floor(Math.random() * ENEMY_NAMES.length)];
  const colors = randomNightmareColors();
  const armLength = Math.round(58 + Math.random() * 17);
  const fighter = createFighter(name, archetype, state.nightmareLevel, corner.x, corner.z, facing, false, colors, armLength);
  applyNightmareModifiers(fighter);

  // Refinement: the opening opponent carried one ladder rung of the player's
  // spread and every one after it is a rung deeper, to a full mirror at 100%.
  // The spread is re-rolled per fighter, so two opponents on the same budget
  // still favour different skills.
  const nmSpawnIndex = (state.nightmareSpawnIndex ?? 0) + 1;
  state.nightmareSpawnIndex = nmSpawnIndex;
  // A run already in flight when the ladder changed carries no player total —
  // its stored budget was cut to a different share and cannot be inverted. The
  // player's own spread is the 100% the ladder climbs toward, so read it back
  // off the fight instead. A budget of zero means refinement was locked when
  // the run started, and the whole ladder stays off.
  const nmPlayerTotal = (state.nightmareRefinementPlayerTotal ?? 0) > 0
    ? state.nightmareRefinementPlayerTotal
    : ((state.nightmareRefinementBudget ?? 0) > 0
      ? refinementPointsSpent(activeRefinementsOnly(state.playerRefinement as Record<string, unknown> | undefined, true))
      : 0);
  // The ladder brings exactly as many refinements as the player is bringing —
  // no more keys, no fewer. A player with none active faces opponents with none.
  const nmPlayerActive = activeRefinementsOnly(state.playerRefinement as Record<string, unknown> | undefined, true);
  const nmKeyCount = REFINEMENT_KEYS.filter(k => ((nmPlayerActive?.[k] as number | undefined) ?? 0) > 0).length;
  const nmRefBudget = nmKeyCount > 0 ? nightmareRefinementBudgetFor(nmPlayerTotal, nmSpawnIndex + 1) : 0;
  if (nmRefBudget > 0) {
    applyRefinementToFighter(fighter, spreadRefinementPoints(nmRefBudget, nmKeyCount));
  }

  const staminaScale = Math.pow(1.15, state.nightmareKillCount);
  fighter.maxStamina = Math.round(fighter.maxStamina * staminaScale);
  fighter.maxStaminaCap = Math.round(fighter.maxStaminaCap * staminaScale);
  fighter.stamina = fighter.maxStamina;
  fighter.defenseState = "none";
  fighter.guardBlend = 0;
  const brain = initAiBrain(state.nightmareDifficulty, archetype, state.nightmareLevel);
  inheritPunchEnduranceFromCurrentEnemy(state, fighter);
  // Every rung of the ladder wears the same equipment the bout was set up with.
  applyEquipmentToFighter(fighter, state.opponentEquipment);
  // Spawned in a corner, so they arrive already looking at the player instead of
  // turning out of their corner's angle while their first punches sail past.
  snapFacingToward(fighter, state.player.x, state.player.z);
  return { fighter, brain };
}

function buildDoghouseEnemy(state: GameState): { fighter: FighterState; brain: AiBrainState } {
  const pool = state.doghouseOpponentPool;
  const pick = pool.length > 0 ? pool[Math.floor(Math.random() * pool.length)] : undefined;
  const archetypes: Archetype[] = ["BoxerPuncher", "OutBoxer", "Brawler", "Swarmer"];
  const archetype = pick?.archetype || archetypes[Math.floor(Math.random() * archetypes.length)];
  const name = pick?.name || ENEMY_NAMES[Math.floor(Math.random() * ENEMY_NAMES.length)];
  const armLength = pick?.armLength ?? Math.round(58 + Math.random() * 17);
  // Level tracks the player, including any mid-session level-ups, so the queue
  // never drifts above or below them however deep the run goes.
  const level = Math.max(1, state.playerLevel || state.player.level || 1);
  const colors = pick?.colors || randomNightmareColors();
  const corner = pickNightmareCorner();
  const facing: 1 | -1 = corner.x < RING_CX ? 1 : -1;
  const fighter = createFighter(name, archetype, level, corner.x, corner.z, facing, false, colors, armLength);

  const dhSP = pick?.skillPoints;
  if (dhSP) {
    const SC = getScaling();
    const MAX_SP = SC.caps.maxSp;
    const STAMINA_REGEN_CAP = SC.caps.staminaRegenCap;
    fighter.rawPower = dhSP.power;
    fighter.rawStamina = dhSP.stamina;
    fighter.rawSpeed = dhSP.speed;
    const epT = Math.min(1, dhSP.power / MAX_SP);
    const esT = Math.min(1, dhSP.speed / MAX_SP);
    const edT = Math.min(1, dhSP.defense / MAX_SP);
    const estT = Math.min(STAMINA_REGEN_CAP, dhSP.stamina) / SC.caps.staminaRegenDivisor;
    const estPoolT = Math.min(1, dhSP.stamina / MAX_SP);
    const efT = Math.min(1, (dhSP.focus || 0) / MAX_SP);
    fighter.damageMult *= 1 + pointCoef("powerDamage", 5) * epT * epT;
    fighter.punchSpeedMult *= 1 + esT * pointCoef("speedPunch", 1.427);
    fighter.moveSpeed *= 1 + esT * pointCoef("speedMove", 0.15);
    fighter.duckSpeedMult = 1 + esT * pointCoef("speedDuck", 0.6);
    fighter.blockMult = 1 + edT * pointCoef("defenseBlock", 0.6);
    fighter.critResistMult = 1 - edT * pointCoef("defenseCritResist", 0.27);
    fighter.telegraphSpeedMult = speedTelegraphMult(dhSP.speed);
    fighter.staminaRegen *= 1 + estT * pointCoef("staminaRegen", 0.6);
    fighter.maxStamina *= 1 + estPoolT * pointCoef("staminaPool", 0.24);
    fighter.maxStaminaCap *= 1 + estPoolT * pointCoef("staminaPool", 0.24);
    fighter.stamina = fighter.maxStamina;
    fighter.defenseT = edT;
    fighter.speedT = esT;
    fighter.focusT = efT;
    fighter.critMult *= 1 + efT * pointCoef("focusCrit", 1.8);
    fighter.stunMult *= 1 + efT * pointCoef("focusStun", 1.8);
  }

  const dhRef = pick?.refinement;
  if (dhRef && Object.values(dhRef).some(v => (v as number) > 0)) {
    applyRefinementToFighter(fighter, dhRef as RefinementLevels);
  }

  // Each fresh opponent walks in with 10% more stamina than the one before.
  state.doghouseStaminaMult *= 1.1;
  state.doghousePowerMult *= 2;
  fighter.maxStamina = Math.round(fighter.maxStamina * state.doghouseStaminaMult);
  fighter.maxStaminaCap = Math.round(fighter.maxStaminaCap * state.doghouseStaminaMult);
  fighter.stamina = fighter.maxStamina;
  fighter.damageMult = (fighter.damageMult ?? 1) * state.doghousePowerMult;
  fighter.defenseState = "none";
  fighter.guardBlend = 0;
  fighter.punchProfileRosterId = pick?.rosterId;
  const brain = initAiBrain(state.aiDifficulty, archetype, level, false, pick?.rosterId);
  inheritPunchEnduranceFromCurrentEnemy(state, fighter);
  // Every opponent in the queue wears the same equipment the bout was set up with.
  applyEquipmentToFighter(fighter, state.opponentEquipment);
  // The next man up walks in already squared up on the player rather than
  // spending his opening exchange turning out of his corner's angle.
  snapFacingToward(fighter, state.player.x, state.player.z);
  return { fighter, brain };
}

/**
 * Stamina every Doghouse opponent walks in with, as a multiple of its natural
 * pool. The queue grows from here (see buildDoghouseEnemy), so this is the one
 * number that sets how deep the whole ladder's tanks are.
 */
export const DOGHOUSE_ENEMY_STAMINA_MULT = 3.51;

/** Stamina the player brings to a Doghouse round, as a multiple of their own pool. */
export const DOGHOUSE_PLAYER_STAMINA_MULT = 3;

export function activateNightmareMode(state: GameState, level: number, difficulty: AIDifficulty = "champion", refinementBudget: number = 0, refinementPlayerTotal: number = 0): void {
  state.nightmareMode = true;
  state.nightmareRefinementBudget = refinementBudget;
  state.nightmareRefinementPlayerTotal = refinementPlayerTotal;
  state.nightmareSpawnIndex = 0;
  state.nightmareEnemies = [];
  state.nightmareAiBrains = [];
  state.nightmareKillCount = 0;
  state.nightmareSpawnTimer = 0;
  state.nightmareSpawnDelay = 0;
  state.nightmareEnemyDefeated = false;
  state.nightmareLevel = level;
  state.nightmareDifficulty = difficulty;
  state.nightmareTimeSurvived = 0;
  state.nightmareRegenBoostTimer = 0;
  state.nightmareCurrentSpawnInterval = 25;
  state.nightmareEnemyActiveSince = 0;
  state.nightmareQuickKOs = 0;
  state.nightmareVeryQuickKOs = 0;
  state.nightmareRegenBoostMult = 0;
  state.nightmareStaminaDrainTimer = 0;
  state.roundTimer = 120;
  state.roundDuration = 120;
  state.ringCanvasColor = NIGHTMARE_RING_COLOR;
  applyNightmareModifiers(state.enemy);
  const corner = pickNightmareCorner();
  state.enemy.x = corner.x;
  state.enemy.z = corner.z;
  state.enemy.prevX = corner.x;
  state.enemy.prevZ = corner.z;
  state.enemy.facing = corner.x < RING_CX ? 1 : -1;
  // Teleported into a fresh corner, so point them at the player outright rather
  // than making them turn out of whatever angle the old position left behind.
  snapFacingToward(state.enemy, state.player.x, state.player.z);
}

const ALL_PUNCHES: PunchType[] = ["jab", "cross", "leftHook", "rightHook", "leftUppercut", "rightUppercut"];

function generateSwarmerPunchQueue(): PunchType[] {
  const q: PunchType[] = [];
  for (let i = 0; i < 3; i++) {
    q.push(ALL_PUNCHES[Math.floor(Math.random() * ALL_PUNCHES.length)]);
  }
  return q;
}

function shouldPlayIntroAnim(state: GameState, fighter: FighterState): boolean {
  if (state.currentRound === 1) return true;
  if (state.currentRound === state.totalRounds) return true;
  const lastScore = state.roundScores.length > 0 ? state.roundScores[state.roundScores.length - 1] : null;
  if (lastScore) {
    let pTotal = 0, eTotal = 0;
    lastScore.judges.forEach((j: { player: number; enemy: number }) => { pTotal += j.player; eTotal += j.enemy; });
    if (fighter.isPlayer && pTotal > eTotal) return true;
    if (!fighter.isPlayer && eTotal > pTotal) return true;
  }
  return false;
}

function startIntroAnimForFighter(fighter: FighterState, savedRhythm: number): void {
  const arch = fighter.archetype;
  const baseRhythm = savedRhythm > 0 ? savedRhythm : 2;
  const introRhythm = Math.min(4, Math.round(baseRhythm * 1.2));
  if (arch === "OutBoxer") {
    fighter.defenseState = "none";
    fighter.guardBlend = 0;
    fighter.handsDown = true;
    fighter.rhythmLevel = introRhythm;
  } else if (arch === "BoxerPuncher") {
    fighter.rhythmLevel = introRhythm;
    fighter.headOffset = { x: fighter.headOffset.x, y: fighter.headOffset.y - 5 };
  } else if (arch === "Brawler") {
    fighter.rhythmLevel = introRhythm;
  } else if (arch === "Swarmer") {
    fighter.rhythmLevel = introRhythm;
  }
}

function startCosmeticPunch(fighter: FighterState, punchType: PunchType): void {
  if (fighter.isPunching) return;
  fighter.isPunching = true;
  fighter.currentPunch = punchType;
  fighter.punchProgress = 0;
  fighter.punchPhase = "launchDelay";
  fighter.punchPhaseTimer = 0;
  fighter.isRePunch = false;
  fighter.retractionProgress = 0;
  fighter.isFeinting = false;
  fighter.feintHoldTimer = 0;
  fighter.feintTouchingOpponent = false;
  fighter.feintDuckTouchingOpponent = false;
  fighter.isCharging = false;
  fighter.punchAimsHead = true;
  fighter.currentPunchStaminaCost = 0;
}

function updateIntroAnim(state: GameState, dt: number): void {
  if (!state.introAnimActive) return;
  state.introAnimTimer += dt;
  const totalDur = COUNTDOWN_DURATION;
  const progress = Math.min(state.introAnimTimer / totalDur, 1);

  for (const isPlayer of [true, false]) {
    const fighter = isPlayer ? state.player : state.enemy;
    const playing = isPlayer ? state.playerIntroPlaying : state.enemyIntroPlaying;
    if (!playing) continue;

    const arch = fighter.archetype;

    if (arch === "OutBoxer") {
      fighter.defenseState = "none";
      fighter.handsDown = true;
      fighter.guardBlend = 0;
    } else if (arch === "BoxerPuncher") {
      const guardProg = Math.min(progress / 0.9, 1);
      fighter.guardBlend = guardProg;
      fighter.headOffset = { x: 0, y: -5 * (1 - guardProg) };
    } else if (arch === "Brawler") {
      const phase4 = progress * 4;
      if (phase4 < 1) {
        fighter.defenseState = "duck";
      } else if (phase4 < 2) {
        fighter.defenseState = "none";
      } else if (phase4 < 3) {
        fighter.defenseState = "duck";
      } else {
        fighter.defenseState = "none";
      }
    } else if (arch === "Swarmer") {
      const punchTimes = [0.15, 0.45, 0.7];
      for (let pi = 0; pi < 3; pi++) {
        const prevProg = Math.max(0, (state.introAnimTimer - dt) / totalDur);
        if (prevProg < punchTimes[pi] && progress >= punchTimes[pi] && !fighter.isPunching) {
          const punchType = ALL_PUNCHES[Math.floor(Math.random() * ALL_PUNCHES.length)];
          startCosmeticPunch(fighter, punchType);
        }
      }
      if (progress > 0.85 && !fighter.isPunching) {
        fighter.handsDown = true;
        fighter.defenseState = "none";
        fighter.guardBlend = 0;
        if (fighter.isPlayer) {
          fighter.rhythmLevel = 0;
        }
      }
    }
  }
}

function resetIntroAnim(state: GameState): void {
  for (const isPlayer of [true, false]) {
    const fighter = isPlayer ? state.player : state.enemy;
    const playing = isPlayer ? state.playerIntroPlaying : state.enemyIntroPlaying;
    if (!playing) continue;

    const savedR = isPlayer ? state.playerSavedRhythmLevel : state.enemySavedRhythmLevel;
    fighter.rhythmLevel = savedR > 0 ? savedR : 2;
    fighter.rhythmProgress = 0;
    fighter.rhythmDirection = 1;
    fighter.handsDown = false;
    fighter.defenseState = "fullGuard";
    fighter.headOffset = { x: 0, y: 0 };
  }
  state.introAnimActive = false;
  state.playerIntroPlaying = false;
  state.enemyIntroPlaying = false;
}

const keys: Record<string, boolean> = {};
const keyJustPressed: Record<string, boolean> = {};
// Punches are thrown on the way UP, so the release edge is tracked alongside the
// press edge and consumed the same way.
const keyJustReleased: Record<string, boolean> = {};
// A feint goes out on the press, so that punch key's eventual release is already
// spent — this is what stops it throwing a real shot on the way back up.
const feintSoldOnPress: Record<string, boolean> = {};
let shiftHeldTime = 0;
let gameElapsedTime = 0;

export function clearAllKeys(): void {
  for (const k in keys) {
    keys[k] = false;
  }
  for (const k in keyJustPressed) {
    keyJustPressed[k] = false;
  }
  for (const k in keyJustReleased) {
    keyJustReleased[k] = false;
  }
  for (const k in feintSoldOnPress) {
    feintSoldOnPress[k] = false;
  }
}

export function handleKeyDown(e: KeyboardEvent) {
  if (e.code === "ShiftRight") {
    if (!keys["shiftright"]) keyJustPressed["shiftright"] = true;
    keys["shiftright"] = true;
    return;
  }
  const k = e.key.toLowerCase();
  if (!keys[k]) {
    keyJustPressed[k] = true;
  }
  keys[k] = true;
}

export function handleKeyUp(e: KeyboardEvent) {
  if (e.code === "ShiftRight") {
    if (keys["shiftright"]) keyJustReleased["shiftright"] = true;
    keys["shiftright"] = false;
    return;
  }
  const k = e.key.toLowerCase();
  if (keys[k]) keyJustReleased[k] = true;
  keys[k] = false;
}

function consumePress(key: string): boolean {
  if (keyJustPressed[key]) {
    keyJustPressed[key] = false;
    return true;
  }
  return false;
}

function consumeRelease(key: string): boolean {
  if (keyJustReleased[key]) {
    keyJustReleased[key] = false;
    return true;
  }
  return false;
}

function clearFrameInput(): void {
  for (const k in keyJustPressed) {
    keyJustPressed[k] = false;
  }
  for (const k in keyJustReleased) {
    keyJustReleased[k] = false;
  }
}

function getDistance(a: FighterState, b: FighterState): number {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dz * dz);
}

function getRhythmPhase(progress: number): RhythmPhase {
  if (progress <= 0.4) return "beginning";
  if (progress <= 0.6) return "middle";
  return "end";
}

function getRhythmPhaseIntensity(progress: number): number {
  if (progress <= 0.4) return progress / 0.4;
  if (progress <= 0.6) return (progress - 0.4) / 0.2;
  return (progress - 0.6) / 0.4;
}

interface RhythmBuffs {
  jabDamageMult: number;
  jabSpeedMult: number;
  hookDamageMult: number;
  hookSpeedMult: number;
  crossDamageMult: number;
  crossSpeedMult: number;
  crossRetractMult: number;
  whiffChance: number;
  rangeMult: number;
  accuracyMult: number;
  staminaRecoveryMult: number;
  punchSpeedMult: number;
  hitStaminaPauseDuration: number;
}

function getRhythmBuffs(fighter: FighterState): RhythmBuffs {
  const buffs: RhythmBuffs = {
    jabDamageMult: 1,
    jabSpeedMult: 1,
    hookDamageMult: 1,
    hookSpeedMult: 1,
    crossDamageMult: 1,
    crossSpeedMult: 1,
    crossRetractMult: 1,
    whiffChance: 0,
    rangeMult: 1,
    accuracyMult: 1,
    staminaRecoveryMult: 1,
    punchSpeedMult: 1,
    hitStaminaPauseDuration: 0,
  };

  if (fighter.rhythmLevel === 0) return buffs;
  if (fighter.defenseState === "duck") return buffs;

  const phase = getRhythmPhase(fighter.rhythmProgress);
  const intensity = getRhythmPhaseIntensity(fighter.rhythmProgress);

  switch (phase) {
    case "beginning":
      buffs.jabDamageMult = 1 + 0.07 * intensity;
      buffs.jabSpeedMult = 1 + 0.07 * intensity;
      buffs.whiffChance = 0.07 * intensity;
      buffs.rangeMult = 1 - 0.07 * intensity;
      buffs.crossRetractMult = 1 - 0.07 * intensity;
      buffs.staminaRecoveryMult = 1 - 0.07 * intensity;
      break;
    case "middle":
      buffs.staminaRecoveryMult = 1 + 0.14 * intensity;
      buffs.punchSpeedMult = 1 + 0.07 * intensity;
      if (fighter.rhythmProgress >= 0.45 && fighter.rhythmProgress <= 0.55) {
        buffs.hitStaminaPauseDuration = 0.2;
      }
      if (fighter.rhythmProgress >= 0.48 && fighter.rhythmProgress <= 0.52) {
        buffs.hitStaminaPauseDuration = 1.0;
      }
      break;
    case "end":
      buffs.hookDamageMult = 1 + 0.07 * intensity;
      buffs.hookSpeedMult = 1 + 0.07 * intensity;
      buffs.crossDamageMult = 1 + 0.07 * intensity;
      buffs.crossSpeedMult = 1 + 0.07 * intensity;
      buffs.rangeMult = 1 + 0.07 * intensity;
      buffs.accuracyMult = 1 + 0.07 * intensity;
      buffs.staminaRecoveryMult = 1 - 0.07 * intensity;
      break;
  }

  return buffs;
}

/** How much slower a feint's arm comes out than the real punch's. */
const FEINT_EXTEND_SLOW_MULT = 1.3;

function getPunchPhaseDurations(fighter: FighterState, config: PunchConfig, isRePunch: boolean): Record<PunchPhaseType, number> {
  let speedMult = config.speed * fighter.punchSpeedMult;
  if (fighter.isCharging) {
    const guardDown = fighter.handsDown;
    speedMult *= guardDown ? CHARGE_GUARDDOWN_SPEED_BONUS : 0.7;
  }
  if (fighter.halfGuardPunch) speedMult *= 0.85;
  if (fighter.speedBoostTimer > 0) speedMult *= 1.07;
  
  if (fighter.stunPunchSlowTimer > 0) speedMult *= fighter.stunPunchSlowMult;

  const rhythmBuffs = getRhythmBuffs(fighter);
  speedMult *= rhythmBuffs.punchSpeedMult;

  // A fully mastered drilled string permanently sharpens the punch it OPENS
  // with, wherever that punch is thrown -- in the combination or on its own.
  if (fighter.drilledPunch?.mastered) speedMult *= DRILLED_ACTION_CONFIG.masteryPunchSpeedMult;

  const punchType = fighter.currentPunch;
  if (punchType === "jab") speedMult *= rhythmBuffs.jabSpeedMult;
  if (punchType === "jab" && fighter.defenseState !== "duck") speedMult *= 1.2;
  if (punchType === "cross") speedMult *= rhythmBuffs.crossSpeedMult;
  if (punchType === "leftHook" || punchType === "rightHook") speedMult *= rhythmBuffs.hookSpeedMult;

  const animCfg = punchType ? getActivePunchAnimConfig()[punchType] : null;
  // Energy fatigue stretches the launch and the retraction. The punch's own
  // travel is untouched — a tired fighter's shot is as fast in flight, it just
  // takes longer to leave the shoulder and longer to come home.
  const fatigueSlow = 1 + getFatigueConfig().punchSlowMax
    * fatigueRampT(fighter, getFatigueConfig().punchSlowCapPunches) * fatigueEffectMult(fighter);
  const rawLaunchBase = 0.1 / speedMult * LAUNCH_DELAY_MULT;
  const launchBase = rawLaunchBase * (animCfg?.launchDelayMult ?? 1) * fatigueSlow;
  const armSpeedBase = 0.12 / speedMult / ARM_SPEED_MULT * (animCfg?.armSpeedMult ?? 1);
  const contactBase = 0.03;
  const lingerBase = levelScale(fighter.level, 0.2, 0.05, "punchLinger") / speedMult * LINGER_MULT * (animCfg?.lingerMult ?? 1);
  let retractBase = rawLaunchBase * 1.1;
  if (punchType === "cross") retractBase /= rhythmBuffs.crossRetractMult;
  retractBase *= fighter.retractionPenaltyMult;
  retractBase *= (animCfg?.retractionMult ?? 1);
  retractBase *= fatigueSlow;

  const isSnapPunch = fighter.punchLaunchDamageMult < 1;
  // A feint is sold, not thrown: the arm comes out FEINT_EXTEND_SLOW_MULT slower
  // than the real punch so the shape has time to read. Only the way out is
  // slowed — the snap back runs at normal speed, which is what leaves the same
  // arm a live retraction to turn into a real punch.
  const feintOut = fighter.isFeinting ? FEINT_EXTEND_SLOW_MULT : 1;
  return {
    launchDelay: (isRePunch ? launchBase * 0.5 : launchBase) * feintOut,
    armSpeed: (isSnapPunch ? armSpeedBase * 0.5 : armSpeedBase) * feintOut,
    contact: contactBase,
    linger: isSnapPunch ? 0 : lingerBase,
    retraction: isSnapPunch ? retractBase * 0.5 : retractBase,
  };
}

/**
 * Read-only visual helper: where each phase of the punch in flight starts and
 * ends as a fraction of punchProgress. The fatigue multiplier scales every
 * phase alike, so the fractions are exact without it. Null when not punching.
 */
/** Real seconds a fighter's punch takes, launch → end of retraction. */
export function punchTotalDuration(fighter: FighterState, punchType: PunchType): number {
  const d = getPunchPhaseDurations(fighter, getEffectivePunchConfig(punchType), false);
  let total = 0;
  for (const v of Object.values(d)) total += Math.max(0, v);
  return total;
}

export function punchPhaseFractions(fighter: FighterState): Record<PunchPhaseType, [number, number]> | null {
  if (!fighter.isPunching || !fighter.currentPunch) return null;
  const d = getPunchPhaseDurations(fighter, getEffectivePunchConfig(fighter.currentPunch), fighter.isRePunch);
  const order: PunchPhaseType[] = ["launchDelay", "armSpeed", "contact", "linger", "retraction"];
  let total = 0;
  for (const p of order) total += Math.max(0, d[p]);
  if (total <= 0) return null;
  const out = {} as Record<PunchPhaseType, [number, number]>;
  let acc = 0;
  for (const p of order) {
    const s = acc / total;
    acc += Math.max(0, d[p]);
    out[p] = [s, acc / total];
  }
  return out;
}

function getTelegraphCooldownZ(_level: number, _punchType: PunchType): number {
  return 2.0;
}

function getTelegraphBaseDuration(level: number, punchType: PunchType): number {
  const isHook = punchType.includes("Hook");
  const isUppercut = punchType.includes("Uppercut");
  // Base durations are long enough to be clearly visible at speed 0.
  // speedTelegraphMult then shortens them proportional to the fighter's speed stat.
  if (isHook) return levelScale(level, 0.90, 0.75, "telegraphHook");
  if (isUppercut) return levelScale(level, 1.10, 0.90, "telegraphUppercut");
  return levelScale(level, 0.60, 0.50, "telegraphJab"); // jab/cross
}

function speedTelegraphMult(rawSpeed: number): number {
  if (rawSpeed <= 0) return 1.0;
  const c200 = pointCoef("speedTelegraphAt200", 0.75);
  const c1000 = pointCoef("speedTelegraphAt1000", 0.125);
  if (rawSpeed <= 200) {
    return 1.0 - (rawSpeed / 200) * c200;
  }
  const t = Math.min(1, (rawSpeed - 200) / 800);
  return (1.0 - c200) - t * c1000;
}

function shouldTelegraph(fighter: FighterState, _isRePunch: boolean, _punchType: PunchType = "jab"): boolean {
  const level = Math.max(1, fighter.level);
  // Level 1  → 100% chance every punch is telegraphed (fully predictable beginner)
  // Level 50 → ~50% chance
  // Level 100+ → 0% (no telegraph, fast/unpredictable)
  const telegraphChance = levelScale(level, 1, 0, "telegraphChance");
  if (telegraphChance <= 0) return false;
  return Math.random() < telegraphChance;
}

function computeSwayZoneMults(fighter: FighterState): void {
  const absSwayNorm = Math.abs(fighter.swayOffset) / 5;
  // The zones ARE the weight transfer, so they only exist while the feet are
  // working. Standing still parks the sway at the front foot, and a parked foot
  // is not a loaded power shot.
  const isActive = effectiveSwaySpeedLevel(fighter) > 0 && fighter.rhythmWalking !== false;
  const leavingFoot = fighter.swayDir * fighter.swayOffset < 0;
  if (isActive && absSwayNorm >= 0.9) {
    fighter.swayZone = "power";
    fighter.swayDamageMult = 1.5;
    fighter.swayTelegraphMult = 0.5;
  } else if (isActive && absSwayNorm >= 0.1 && leavingFoot) {
    fighter.swayZone = "offBalance";
    fighter.swayDamageMult = 0.85;
    fighter.swayTelegraphMult = 1.5;
  } else {
    fighter.swayZone = "neutral";
    fighter.swayDamageMult = 1;
    fighter.swayTelegraphMult = 1;
  }
}

/**
 * Feinting and perfect blocking are mutually exclusive: the gloves are either
 * committed to the block or selling a punch, never both. A feint counts as
 * engaged from the moment its telegraph starts, not just once it lands in the
 * linger, so pressing block mid-telegraph can't sneak past the rule.
 */
export function isPerfectBlockEngaged(f: FighterState): boolean {
  return f.perfectBlockActive || f.perfectBlockState === "rising" || f.perfectBlockState === "active";
}

export function isFeintEngaged(f: FighterState): boolean {
  return f.isFeinting || (f.telegraphIsFeint && f.telegraphPhase !== "none");
}

/**
 * Let a held feint go. The arm snaps back through an ordinary retraction rather
 * than the punch state being wiped where it stands, which is what gives the
 * same arm something to turn into a real punch on the way home.
 */
function startFeintRetraction(fighter: FighterState): void {
  fighter.punchPhase = "retraction";
  fighter.punchPhaseTimer = 0;
  fighter.retractionProgress = 0;
  fighter.feintHoldTimer = 0;
  fighter.feintTouchingOpponent = false;
  fighter.feintDuckTouchingOpponent = false;
}

/**
 * Abandon a feint outright, arm and all. Used when the OTHER arm answers a
 * retracting feint: that hand isn't continuing the feint, it's starting its own
 * punch, so the feint has to be off the books before the new one is attempted.
 */
function endFeintPunch(fighter: FighterState): void {
  fighter.isPunching = false;
  fighter.currentPunch = null;
  fighter.punchProgress = 0;
  fighter.punchPhase = null;
  fighter.punchPhaseTimer = 0;
  fighter.punchCooldown = 0;
  fighter.isFeinting = false;
  fighter.isCharging = false;
  fighter.halfGuardPunch = false;
  fighter.isRePunch = false;
  fighter.retractionProgress = 0;
  fighter.retractionPenaltyMult = 1;
  fighter.feintHoldTimer = 0;
  fighter.feintTouchingOpponent = false;
  fighter.feintDuckTouchingOpponent = false;
  fighter.drilledPunch = null;
}

/**
 * Half-width of the green rhythm-vulnerability window, which the *attacker*
 * owns: focus widens it for either corner. The Chin Hitter refinement's extra
 * width stays player-only. One half-width is hung off each end of the arc — see
 * isInRhythmVulnWindow.
 */
export function getRhythmVulnHalfWidth(attacker: FighterState, defender?: FighterState | null): number {
  const focusT = attacker.focusT;
  const chinHitterHalf = attacker.isPlayer ? (attacker.chinHitterVulnBonus ?? 0) : 0;
  const base = 0.05 + 0.15 * focusT + chinHitterHalf;
  // Half the arc at each end is the whole arc, so there is nothing wider to win.
  return Math.min(0.5, base + rhythmVulnStackWidth(defender));
}

/**
 * How much wider the defender's own fatigue has made that window. Every punch
 * they take without a perfect block and without Resetting hangs another
 * vulnPerHit on EACH end of the arc, so a fighter who keeps eating shots keeps
 * opening up; a Reset clears the stack outright.
 */
export function rhythmVulnStackWidth(defender?: FighterState | null): number {
  const stack = defender?.fatigue?.vulnStack ?? 0;
  if (stack <= 0) return 0;
  return stack * Math.max(0, getFatigueConfig().vulnPerHit);
}

/**
 * The vulnerable slice of the rhythm arc. The window is split down the middle
 * and hung off BOTH ends of the sweep instead of sitting in the centre: a 10%
 * window is 5% at the start and 5% at the end. Total exposure is unchanged —
 * it just sits where the fighter is turning around rather than where they are
 * squarest up.
 */
export function isInRhythmVulnWindow(progress: number, half: number): boolean {
  return progress <= half || progress >= 1 - half;
}

/** Is this fighter's rhythm marker sitting in a green zone right now? */
export function isRhythmVulnerable(defender: FighterState, attacker: FighterState): boolean {
  if (defender.rhythmLevel <= 0) return false;
  // No footwork, no rhythm. A fighter stood still has their rhythm switched off
  // outright, so the marker parked at an end of the arc isn't an open door.
  if (!defender.rhythmWalking) return false;
  // Ducking grants full immunity to one's own rhythm vulnerabilities — but only
  // once the crouch is actually there, not the moment it is asked for.
  if (isDuckLive(defender)) return false;
  const half = getRhythmVulnHalfWidth(attacker, defender);
  return isInRhythmVulnWindow(defender.rhythmProgress, half);
}

/**
 * A perfect block goes on hold while its owner's rhythm is in the green zone:
 * the hold timer freezes (nothing is wasted) but the window is shut, so punches
 * fall through to ordinary guard blocking. Guard Master 100 lifts the pause
 * entirely and the block keeps working through the vulnerability.
 */
export function isPerfectBlockRhythmPaused(defender: FighterState, attacker: FighterState): boolean {
  if (defender.pbIgnoresRhythmVuln) return false;
  // Refreshing here as well as in the main loop is deliberate and idempotent:
  // the callers are spread across the player's block state machine and three
  // reads in the AI, and none of them should be able to act on a stale latch.
  updatePerfectBlockRhythmLatch(defender, attacker);
  return !!defender.pbRhythmCutLatched;
}

/**
 * The marker's fixed rhythm-cut slice — the ±5% at the ends that lets a punch
 * bypass a guard outright. Narrower than the full vulnerability window and
 * unaffected by the attacker, which is why it is the thing that arms the
 * perfect-block hold below rather than the window itself.
 */
function isInRhythmCutRange(defender: FighterState): boolean {
  if (defender.rhythmLevel <= 0) return false;
  if (!defender.rhythmWalking) return false;
  if (effectiveSwaySpeedLevel(defender) <= 0) return false;
  if (isDuckLive(defender)) return false;
  return isInRhythmVulnWindow(defender.rhythmProgress, RHYTHM_CUT_VULN_HALF);
}

/**
 * Arm and disarm that hold. It latches: entering the cut range shuts the
 * perfect block, and it stays shut until the marker is clear of the whole
 * vulnerability window — which is wider than the cut range and grows with the
 * defender's own fatigue, so a gassed fighter stays locked out for longer after
 * every pass through the turn. Standing still, ducking or rhythm being off all
 * read as "outside the window" and clear it.
 */
export function updatePerfectBlockRhythmLatch(defender: FighterState, attacker: FighterState): void {
  if (isInRhythmCutRange(defender)) {
    defender.pbRhythmCutLatched = true;
  } else if (!isRhythmVulnerable(defender, attacker)) {
    defender.pbRhythmCutLatched = false;
  }
}

/**
 * Centre-to-centre distance (px) at which the two fighters' guards meet: each
 * guard glove sits ~0.45 m in front of its owner, so gloves/forearms touch at
 * roughly 0.9 m apart. Lead feet are bladed to opposite sides and never get
 * there first.
 */
export const LIMB_CONTACT_DIST = 46;

/**
 * How exposed a fighter's rhythm is right now, 0..1: 1 with the marker at an
 * end of the arc (where the vulnerability window lives), 0 at the centre. Off
 * (0) when the rhythm isn't running or the duck's immunity is in, matching
 * isRhythmVulnerable.
 */
export function rhythmExposure(f: FighterState): number {
  if (f.isKnockedDown || f.rhythmLevel <= 0) return 0;
  if (!f.rhythmWalking) return 0;
  if (isDuckLive(f)) return 0;
  const p = Math.max(0, Math.min(1, f.rhythmProgress));
  return 1 - 2 * Math.min(p, 1 - p);
}

function isHoldingFeint(f: FighterState): boolean {
  return !!f.isFeinting && !!f.isPunching && f.punchPhase === "linger";
}

/**
 * Limb contact: once the guards touch, the fighter whose rhythm is the more
 * exposed is pinned (can't walk in, can't jab); if the other is holding a
 * feint into the contact, the pinned fighter's straights fail too. Stamped
 * once per tick before either corner moves or punches.
 */
export function updateLimbContact(state: GameState): void {
  const a = state.player, b = state.enemy;
  a.limbContactPinned = b.limbContactPinned = false;
  a.limbContactStraightsLocked = b.limbContactStraightsLocked = false;
  if (a.isKnockedDown || b.isKnockedDown) return;
  if (getDistance(a, b) > LIMB_CONTACT_DIST) return;
  const ea = rhythmExposure(a), eb = rhythmExposure(b);
  if (ea === eb) return;
  const [pinned, other] = ea > eb ? [a, b] : [b, a];
  pinned.limbContactPinned = true;
  pinned.limbContactStraightsLocked = isHoldingFeint(other);
}

/** Does limb contact refuse this punch input? Feints are never refused. */
export function isPunchContactLocked(f: FighterState, punchType: PunchType, isFeint: boolean): boolean {
  if (isFeint) return false;
  if (f.limbContactPinned && punchType === "jab") return true;
  return !!f.limbContactStraightsLocked && (punchType === "jab" || punchType === "cross");
}

/** Removes the component of a move direction that points at the opponent. */
export function stripMoveTowardOpponent(self: FighterState, opp: FighterState, moveX: number, moveZ: number): [number, number] {
  const tx = opp.x - self.x, tz = opp.z - self.z;
  const len = Math.sqrt(tx * tx + tz * tz);
  if (len <= 0.01) return [moveX, moveZ];
  const nx = tx / len, nz = tz / len;
  const dot = moveX * nx + moveZ * nz;
  if (dot <= 0) return [moveX, moveZ];
  return [moveX - dot * nx, moveZ - dot * nz];
}

function startTelegraph(fighter: FighterState, punchType: PunchType, isFeint: boolean, isCharged: boolean, telegraphMult: number, opponent: FighterState): boolean {
  if (isPunchContactLocked(fighter, punchType, isFeint)) return false;
  if (isFeint && isPerfectBlockEngaged(fighter)) return false;
  // Snap-punch zones: scale with rawPower — 90% shorter telegraph, damage scales with power
  fighter.punchLaunchDamageMult = 1;
  if (fighter.rhythmLevel > 0) {
    const rp = fighter.rhythmProgress;
    const pr = Math.min(fighter.rawPower, 200) / 200;
    const z1lo = 0.10 - 0.10 * pr;
    const z1hi = 0.30 + 0.20 * pr;
    const z2lo = 0.70 - 0.20 * pr;
    const z2hi = 0.90 + 0.10 * pr;
    const inSnapZone = (rp >= z1lo && rp <= z1hi) || (rp >= z2lo && rp <= z2hi);
    if (inSnapZone) {
      const p = fighter.rawPower;
      const snapDmg = p >= 50 ? 1.0
        : p >= 10 ? 0.97 + (p - 10) / 40 * 0.03
        : 0.95 + Math.max(0, p - 1) / 9 * 0.02;
      fighter.punchLaunchDamageMult = snapDmg;
      telegraphMult *= 0.1;
    }
  }
  // Rhythm-based telegraph speedup/disable
  if (fighter.rhythmLevel > 0) {
    const rp = fighter.rhythmProgress;
    if (rp > 0.95) return false; // >95% rhythm: skip telegraph entirely
    if (rp >= 0.90) telegraphMult *= 0.5; // 90-95%: telegraph 2x faster
  }
  const isHook = punchType.includes("Hook");
  const isUppercut = punchType.includes("Uppercut");
  const isDucking = fighter.defenseState === "duck";

  // Advancing (non-ducking) cross skips its telegraph and fires immediately.
  if (punchType === "cross" && fighter.currentMoveDir === "forward" && !isDucking) {
    return false;
  }

  let baseDur = getTelegraphBaseDuration(fighter.level, punchType);

  let boostMult = 1 + fighter.feintedTelegraphBoost;
  if (isCharged) {
    const chargeIncrease = levelScale(fighter.level, 0.15, 0.03, "chargeTelegraphIncrease");
    boostMult *= (1 + chargeIncrease);
  }
  baseDur *= boostMult * telegraphMult * fighter.telegraphKdMult * Math.max(0.1, fighter.telegraphSpeedMult);
  baseDur += fighter.telegraphRoundBonus + fighter.telegraphFeintRoundPenalty;

  computeSwayZoneMults(fighter);
  baseDur *= fighter.swayTelegraphMult;

  // Hooks thrown while moving (toward or away) wind up 1.3x slower.
  if (isHook && (fighter.currentMoveDir === "forward" || fighter.currentMoveDir === "backward")) {
    baseDur *= 1.3;
  }

  fighter.telegraphDuration = baseDur;
  fighter.telegraphTimer = 0;
  fighter.telegraphPunchType = punchType;
  fighter.telegraphIsFeint = isFeint;
  fighter.telegraphIsCharged = isCharged;

  if ((isHook || isUppercut) && !isDucking) {
    fighter.telegraphPhase = "duckDown";
  } else {
    fighter.telegraphPhase = "down";
  }
  fighter.feintedTelegraphBoost = 0;

  // A windup only pauses the thrower's own rhythm when the punch was triggered
  // with their marker already in the green zone: get caught starting a punch
  // inside your own vulnerability window and you are held there for the windup.
  // Triggered anywhere else, the rhythm sweeps on through it.
  fighter.telegraphRhythmPaused = isRhythmVulnerable(fighter, opponent);
  fighter.swayFrozen = fighter.telegraphRhythmPaused;

  const slowDur = levelScale(fighter.level, 1.0, 0.25, "telegraphSlowDuration");
  fighter.telegraphSlowTimer = slowDur;
  fighter.telegraphSlowDuration = slowDur;

  return true;
}

function updateTelegraph(fighter: FighterState, dt: number): PunchType | null {
  if (fighter.telegraphPhase === "none") return null;
  fighter.telegraphTimer += dt;
  const half = fighter.telegraphDuration * 0.5;

  if (fighter.telegraphPhase === "down" || fighter.telegraphPhase === "duckDown") {
    if (fighter.telegraphTimer >= half) {
      fighter.telegraphPhase = fighter.telegraphPhase === "duckDown" ? "duckUp" : "up";
    }
  }

  if (fighter.telegraphTimer >= fighter.telegraphDuration) {
    const isLockout = fighter.telegraphIsLockout;
    const punchType = fighter.telegraphPunchType;
    fighter.telegraphPhase = "none";
    fighter.telegraphTimer = 0;
    fighter.telegraphDuration = 0;
    fighter.telegraphIsLockout = false;
    fighter.postPunchLockoutTimer = 0;
    fighter.postPunchLockoutDuration = 0;
    fighter.telegraphPunchType = null;
    fighter.telegraphIsFeint = false;
    fighter.telegraphIsCharged = false;
    if (isLockout) return null;
    return punchType;
  }
  return null;
}

function updateFighterTelegraph(fighter: FighterState, state: GameState, actor: "player" | "enemy", dt: number): void {
  fighter.timeSinceLastPunch += dt;
  if (fighter.postPunchLockoutTimer > 0 && !fighter.telegraphIsLockout) {
    fighter.postPunchLockoutTimer = Math.max(0, fighter.postPunchLockoutTimer - dt);
  }
  if (fighter.earlyRepunchPenaltyTimer > 0) {
    fighter.earlyRepunchPenaltyTimer = Math.max(0, fighter.earlyRepunchPenaltyTimer - dt);
  }

  // Punch input buffer: fire queued punch as soon as the gate opens
  if (fighter.pendingPunchInputTimer > 0) {
    fighter.pendingPunchInputTimer = Math.max(0, fighter.pendingPunchInputTimer - dt);
    if (fighter.pendingPunchInputTimer <= 0) {
      fighter.pendingPunchInput = null; // buffer expired
    }
  }
  if (fighter.pendingPunchInput && !fighter.isPunching && fighter.telegraphPhase === "none" && fighter.postPunchLockoutTimer <= 0) {
    const bufferedPunch = fighter.pendingPunchInput;
    const bufferedCharged = fighter.pendingPunchCharged;
    const bufferedBody = fighter.pendingPunchBody;
    fighter.pendingPunchInput = null;
    fighter.pendingPunchInputTimer = 0;
    if (bufferedBody) fighter.punchAimsHead = false;
    const telegraphOpponent = actor === "player" ? state.enemy : state.player;
    if (attemptPunch(fighter, bufferedPunch, false, bufferedCharged, false, state.practiceMode, state.roundDuration - state.roundTimer, telegraphOpponent)) {
      if (actor === "player") state.roundStats.playerPunchesThisRound++;
      else state.roundStats.enemyPunchesThisRound++;
      recordEvent(state, "punch", actor, { punch: bufferedPunch, feint: false, charged: bufferedCharged, body: bufferedBody, rePunch: false });
      // This release never passes back through the AI's throw wrapper, so a
      // Rhythm Attacking budget would not see it. Account for it here instead,
      // at the point the punch was actually accepted -- never at queue time,
      // since a buffer that expires unspent is not a punch. A human-driven
      // corner has no brain, so this is a no-op outside brain-run fighters.
      notifyAiPunchThrown(raBrainFor(fighter, state));
    }
  }
  if (fighter.feintTelegraphDisableTimer > 0) {
    fighter.feintTelegraphDisableTimer -= dt;
    if (fighter.feintTelegraphDisableTimer < 0) fighter.feintTelegraphDisableTimer = 0;
  }

  if (fighter.telegraphPhase === "none") return;

  const savedIsFeint = fighter.telegraphIsFeint;
  const savedIsCharged = fighter.telegraphIsCharged;
  const completedPunch = updateTelegraph(fighter, dt);
  if (completedPunch) {
    const isFeint = savedIsFeint;
    const isCharged = savedIsCharged;
    const telegraphOpponent = actor === "player" ? state.enemy : state.player;
    if (attemptPunch(fighter, completedPunch, isFeint, isCharged, false, state.practiceMode, state.roundDuration - state.roundTimer, telegraphOpponent)) {
      if (actor === "player") {
        state.roundStats.playerPunchesThisRound++;
      } else {
        state.roundStats.enemyPunchesThisRound++;
      }
      recordEvent(state, isFeint ? "feint" : "punch", actor, { punch: completedPunch, feint: isFeint, charged: isCharged, body: !fighter.punchAimsHead, rePunch: false });
    }
  }
}

/**
 * Length of a burst window. Punches thrown inside it are charged an escalating
 * cost, and the count only clears once this much time has passed since the last
 * punch -- so this is also the exact moment the penalty stops applying, which is
 * what the AI's gas hold waits out.
 */
export const BURST_WINDOW_SEC = 1.0;

/** Punches allowed inside one burst window before the cost starts escalating. */
export function getBurstPunchMax(fighter: FighterState): number {
  const staminaStatT = Math.max(0, Math.min(1, fighter.rawStamina / 200));
  return Math.round(4 + staminaStatT * 6);
}

/**
 * How many punches into the exponential penalty a fighter already is, right now.
 * Zero once the window has lapsed. Single source of truth shared with the AI, so
 * its read of its own gas can never disagree with what it is actually charged.
 */
export function getBurstPunchExcess(fighter: FighterState): number {
  if (fighter.burstPunchTimer >= BURST_WINDOW_SEC) return 0;
  return Math.max(0, fighter.burstPunchCount - getBurstPunchMax(fighter));
}

// ===== DRILLED ACTIONS: IN-BOUT OBSERVATION ==================================
//
// The player's own pattern list. It borrows the AI tape's tokenizer so the two
// can never disagree about what "the same punch" is, but nothing else: this is
// its own observation path on purpose. The AI's recording sits behind the
// neural editor's master switch and returns early on a knockdown or inside its
// rhythm-vulnerability window -- any of which would silently freeze drilled
// progress for reasons that have nothing to do with drilling.

/** The player's drilling context, when this bout has one. */
function drilledOf(fighter: FighterState | null | undefined): DrilledFightState | null {
  return fighter && fighter.drilled ? fighter.drilled : null;
}

/**
 * The token for an action, spelled exactly the way the AI tape spells it.
 *
 * Posture decides the target rather than the aim flag alone: hit resolution
 * only consults punchAimsHead on a punch thrown out of a duck, and the human
 * corner never sets it true, so reading it raw would file every player punch as
 * body work.
 */
function drilledActionTokenFor(fighter: FighterState, punchType: PunchType, isFeint: boolean): string {
  const aimsHead = fighter.defenseState !== "duck" || fighter.punchAimsHead;
  return isFeint
    ? feintActionToken(punchType, fighter.boxingStance)
    : punchActionToken(punchType, aimsHead, fighter.boxingStance);
}

/** Close enough for the action to be part of a combination worth drilling. */
function drilledInRange(fighter: FighterState, opponent?: FighterState | null): boolean {
  if (!opponent) return false;
  return getDistance(fighter, opponent) <= DRILLED_ACTION_CONFIG.observeRangePx;
}

/**
 * Add one link to the combination in progress.
 *
 * When the third link arrives the string is resolved and the window is CLEARED,
 * not slid by one. That is deliberate: a sliding window turns a looped
 * combination into every rotation of itself and would fill the list with the
 * same three actions three times over.
 *
 * `closerPunchId` is the thrower's punch counter, so a later unrelated punch
 * can never settle the string this one closed.
 */
function pushDrilledLink(fighter: FighterState, token: string, isPunch: boolean, opponent?: FighterState | null): void {
  const ds = drilledOf(fighter);
  if (!ds) return;
  if (fighter.isKnockedDown || (opponent && opponent.isKnockedDown)) { clearDrilledWindow(ds); return; }
  if (!drilledInRange(fighter, opponent)) { clearDrilledWindow(ds); return; }

  ds.window.push(token);
  if (ds.window.length < DRILLED_LENGTH) return;

  const acts = ds.window.slice(0, DRILLED_LENGTH);
  const landedSoFar = ds.windowLanded;
  clearDrilledWindow(ds);
  // A string that does not close on a punch can never make contact, so it is
  // resolved as a failure and thrown away rather than left waiting.
  if (!isPunch) return;
  // Rehearsal is banked here, on the throw, and deliberately before anyone
  // knows whether it landed: keeping a combination sharp is about working it,
  // not about the opponent's guard. Unlike the sharpness credit below this is
  // not gated on `recording`, so a career bout maintains a string too.
  noteDrilledThrow(ds, acts);
  ds.pending = { acts, closerPunchId: fighter.punchesThrown, landed: landedSoFar, ready: false };
}

/**
 * Record how a punch of the player's actually finished.
 *
 * Called once per punch from the top of hit resolution, before any of its early
 * returns, and graded off the explicit flags rather than the absence of a miss:
 * a blocked punch runs the hit path and then the guard path in the same tick, a
 * slip or a duck-under returns early down a different branch, and a feint
 * reaches here reporting no hit at all. An ordinary block and a perfect block
 * are both contact -- the punch reached the opponent, which is the whole test.
 */
function noteDrilledContact(attacker: FighterState, landed: boolean, isFeint: boolean): void {
  const ds = drilledOf(attacker);
  if (!ds || isFeint) return;
  // The closer resolved its string on the way out, so it is no longer part of
  // the window -- crediting it there would hand the NEXT string a landed punch
  // it never threw. Its outcome belongs to the string it closed and nothing else.
  const pending = ds.pending;
  if (pending && attacker.punchesThrown === pending.closerPunchId) {
    if (landed) pending.landed = true;
    pending.ready = true;
    return;
  }
  if (landed) ds.windowLanded = true;
}

/**
 * Settle at most one resolved string, at the end of the tick.
 *
 * A string's fate is only known after its punches resolve, so nothing acts on
 * the first notification that arrives.
 */
function settleDrilledActions(state: GameState): void {
  const ds = drilledOf(state.player);
  if (!ds || !ds.pending) return;
  const pending = ds.pending;
  if (!pending.ready) {
    // The closer never reached hit resolution and is over, or the player has
    // moved on to another punch: either way its outcome will never arrive.
    if (state.player.punchesThrown !== pending.closerPunchId || !state.player.isPunching) ds.pending = null;
    return;
  }
  ds.pending = null;
  if (!pending.landed) return;
  // Buffs apply everywhere, but only gym sparring may move a counter.
  if (!ds.recording) return;
  applyDrilledSuccess(ds, pending.acts);
}

/**
 * Per-tick drilling upkeep: the held-action links, the range gate, and the two
 * timers drilling owns.
 */
function updateDrilledActions(state: GameState, dt: number): void {
  const player = state.player;
  const ds = drilledOf(player);
  if (player.drilledDodgeTimer && player.drilledDodgeTimer > 0) {
    player.drilledDodgeTimer = Math.max(0, player.drilledDodgeTimer - dt);
  }
  if (player.drilledBurstPauseTimer && player.drilledBurstPauseTimer > 0) {
    player.drilledBurstPauseTimer = Math.max(0, player.drilledBurstPauseTimer - dt);
  }
  if (!ds) return;

  // Nothing spans a knockdown, and a combination does not survive the player
  // stepping back out of it.
  if (player.isKnockedDown || state.enemy.isKnockedDown) {
    clearDrilledWindow(ds);
    ds.prevCharge = !!player.chargeArmed;
    ds.prevDuck = player.defenseState === "duck";
    return;
  }
  if (!drilledInRange(player, state.enemy)) {
    clearDrilledWindow(ds);
    ds.prevCharge = !!player.chargeArmed;
    ds.prevDuck = player.defenseState === "duck";
    return;
  }

  // Charging and dropping to the body are held states, so only the rising edge
  // is an action -- otherwise a held charge would be a link sixty times a second.
  const chargeNow = !!player.chargeArmed;
  if (chargeNow && !ds.prevCharge) pushDrilledLink(player, PATTERN_TOKEN_CHARGE, false, state.enemy);
  ds.prevCharge = chargeNow;

  const duckNow = player.defenseState === "duck";
  if (duckNow && !ds.prevDuck) pushDrilledLink(player, PATTERN_TOKEN_DUCK, false, state.enemy);
  ds.prevDuck = duckNow;
}

/** The bell and knockdowns end a combination and any string awaiting its fate. */
function resetDrilledForBreak(state: GameState): void {
  const ds = drilledOf(state.player);
  if (ds) clearDrilledWindow(ds);
  state.player.drilledPunch = null;
  state.player.drilledDodgeTimer = 0;
  state.player.drilledBurstPauseTimer = 0;
}

/**
 * Hang the career's drilled list on the player for this bout.
 *
 * `recording` is gym sparring only -- ordinary sparring at every difficulty,
 * Nightmare and the Doghouse Round. A career bout, Quick Fight, the tutorial
 * and the menu background fight attach with it off, because the buffs are
 * earned in the gym and spent everywhere.
 */
export function attachDrilledActions(state: GameState, entries: DrilledActionEntry[] | undefined | null, recording: boolean): void {
  state.player.drilled = createDrilledFightState(entries ?? [], recording);
  state.player.drilledPunch = null;
  state.player.drilledDodgeTimer = 0;
  state.player.drilledBurstPauseTimer = 0;
}

/**
 * Hand the drilled list from a bout being restarted to the one replacing it.
 *
 * A restart throws the run away, but the reps already grooved in it were real
 * gym work and only reach the save at the exit handler, which reads the final
 * state. Without this they would be silently discarded. The in-progress window
 * is not carried: a combination cannot span the restart.
 */
export function carryDrilledActions(from: GameState | null | undefined, to: GameState): void {
  const ds = drilledOf(from?.player);
  if (!ds) return;
  to.player.drilled = { ...ds, window: [], pending: null };
  to.player.drilledPunch = null;
  to.player.drilledDodgeTimer = 0;
  to.player.drilledBurstPauseTimer = 0;
}

/**
 * The list as it stands after the bout, or null when nothing moved.
 *
 * The rehearsal fields ride along with the sharpness count, because a career
 * bout that banked nothing but throws still has a list worth writing -- it is
 * the only thing standing between a maintained combination and its decay.
 */
/**
 * Reps the gym just put toward the Reset buy-backs, or null if it put none.
 *
 * Gated on the sparring flag rather than at the counting sites: ordinary
 * sparring, the Doghouse and Nightmare are all gym work and all bank, exactly as
 * drilled recording scopes it. A career bout is fight night — the counters still
 * move during it, and nothing ever reads them.
 */
export function collectResetTrainingReps(
  state: GameState | null | undefined,
): { charge: number; slips: number } | null {
  if (!state?.sparringMode) return null;
  const f = state.player?.fatigue;
  if (!f) return null;
  const charge = Math.max(0, f.gymChargeLanded | 0);
  const slips = Math.max(0, f.gymResetSlips | 0);
  return charge > 0 || slips > 0 ? { charge, slips } : null;
}

export function collectDrilledActions(state: GameState | null | undefined): DrilledActionEntry[] | null {
  const ds = drilledOf(state?.player);
  if (!ds || !ds.dirty) return null;
  return ds.entries.map(e => ({
    key: e.key,
    acts: [...e.acts],
    n: e.n,
    st: e.st ?? 0,
    wt: e.wt ?? 0,
    wu: e.wu ?? 0,
    dw: e.dw ?? 0,
  }));
}

function attemptPunch(fighter: FighterState, punchType: PunchType, isFeint: boolean = false, isCharged: boolean = false, isRePunch: boolean = false, practiceMode: boolean = false, roundElapsed: number = 999, opponent?: FighterState): boolean {
  if (fighter.isKnockedDown) return false;
  if (isPunchContactLocked(fighter, punchType, isFeint)) return false;
  if (fighter.telegraphIsLockout) return false;

  // Technician L20+: a real punch input while holding a feint cancels the feint
  // with a fast retraction, firing the new punch halfway through that retraction.
  const feintCancel = !isFeint && !!fighter.isFeinting && fighter.punchPhase === "linger" && !!fighter.technicianFeintCancelUnlocked;

  if (!isRePunch && !feintCancel && (fighter.isPunching || fighter.punchCooldown > 0)) return false;
  if (isRePunch && fighter.punchPhase !== "retraction") return false;
  if (fighter.miniStunTimer > 0) return false;

  if (feintCancel) {
    fighter.isFeinting = false;
    fighter.feintHoldTimer = 0;
    fighter.feintTouchingOpponent = false;
    fighter.feintDuckTouchingOpponent = false;
    fighter.punchPhase = "retraction";
    fighter.punchPhaseTimer = 0;
    fighter.retractionProgress = 0;
    fighter.feintCancelActive = true;
    fighter.feintCancelTimer = 0;
    fighter.feintCancelDuration = 0.12;
    fighter.feintCancelPunchType = punchType;
    fighter.feintCancelCharged = isCharged;
    fighter.feintCancelBody = !fighter.punchAimsHead;
    // Return false: the punch hasn't actually landed yet, it fires (and is
    // recorded) once the fast feint-retraction reaches the halfway point.
    return false;
  }

  if (isRePunch && fighter.punchPhase === "retraction" && fighter.currentPunch && fighter.retractionProgress < 1) {
    const priorConfig = getEffectivePunchConfig(fighter.currentPunch);
    const priorDurations = getPunchPhaseDurations(fighter, priorConfig, fighter.isRePunch);
    const remainingRetraction = Math.max(0, priorDurations.retraction - fighter.punchPhaseTimer) * (fighter.repunchPenaltyMult ?? 1);
    fighter.earlyRepunchPenaltyTimer = Math.max(fighter.earlyRepunchPenaltyTimer, remainingRetraction);
  }
  if (isCharged && roundElapsed < 10) return false;
  if (isCharged && !fighter.chargeArmed) return false;
  if (isCharged && fighter.chargeMeterBars < 1) {
    isCharged = false;
    fighter.chargeArmed = false;
    fighter.chargeUsesLeft = 0;
    fighter.chargeWhiffForgivenessLeft = 0;
    fighter.chargeArmTimer = 0;
  }
  if (isFeint && (punchType === "leftUppercut" || punchType === "rightUppercut")) return false;

  if (isFeint && isPerfectBlockEngaged(fighter)) return false;
  computeSwayZoneMults(fighter);

  // Drilled Actions: what this throw is worth is decided here, not at contact.
  // The stamina and animation halves are spent on the way out while the power,
  // crit and stun halves are consumed later in hit resolution, so the whole
  // bundle has to ride the punch rather than be recomputed downstream. It is
  // held in a local until the throw actually commits, so a path that still
  // returns false below cannot leave a stamp behind.
  const drilledState = drilledOf(fighter);
  const drilledToken = drilledState && drilledInRange(fighter, opponent)
    ? drilledActionTokenFor(fighter, punchType, isFeint)
    : null;
  const drilledClosing = drilledState && drilledToken ? drilledClosingFor(drilledState, drilledToken) : null;
  const drilledMastered = !!(drilledState && drilledToken && drilledState.mastery.includes(drilledToken));
  const drilledFree = !isFeint && !!drilledClosing?.freeStamina;
  const drilledBurstPaused = (fighter.drilledBurstPauseTimer ?? 0) > 0;
  // Rehearsal upkeep, read off its own ladder rather than the closing bundle:
  // the surcharge starts the moment a string is listed, well below the
  // sharpness the buffs switch on at. A feint is not a rehearsal of anything
  // and is never surcharged.
  const drilledStaminaMult = !isFeint && drilledState && drilledToken
    ? drilledStaminaMultFor(drilledState, drilledToken)
    : 1;

  const config = getEffectivePunchConfig(punchType);
  let cost = config.staminaCost * fighter.staminaCostMult;
  if (isFeint) cost *= 0.3;
  if (isCharged) {
    cost *= CHARGE_STAMINA_COST_MULT;
    if (fighter.consecutiveChargeCount > 0) {
      cost *= (1 + fighter.consecutiveChargeCount * CHARGE_CONSECUTIVE_EXTRA_COST);
    }
  }
  // Burst stamina penalty: escalating cost when throwing too many punches in 1 second.
  // A drilled string at 200+ pauses this count outright for a second once its
  // closing punch makes contact, so nothing thrown inside that window advances it.
  if (!isFeint && !drilledBurstPaused) {
    const burstMax = getBurstPunchMax(fighter);
    if (fighter.burstPunchTimer >= BURST_WINDOW_SEC) fighter.burstPunchCount = 0;
    fighter.burstPunchCount++;
    fighter.burstPunchTimer = 0;
    if (fighter.burstPunchCount > burstMax) {
      const excess = fighter.burstPunchCount - burstMax;
      cost *= Math.pow(1.5, excess);
      if (!drilledFree) fighter.staminaPenaltyPending = true;
    }
  }
  if (fighter.isPlayer) cost *= 0.85;
  // Upkeep surcharge on the punch that CLOSES a drilled string -- 3x on one the
  // player has let go stale, down to half price on one they keep working.
  if (drilledStaminaMult !== 1) cost *= drilledStaminaMult;
  // 200+ sharpness: the closing punch is free. Applied after every other term so
  // nothing can add a cost back on top of it -- a string sharp enough to be
  // free has outgrown its upkeep, surcharge included.
  if (drilledFree) cost = 0;

  if (fighter.defenseState === "fullGuard" && !isFeint) {
    fighter.halfGuardPunch = true;
  }

  if (practiceMode) {
    if (fighter.stamina < cost) {
      cost = 0;
    }
    fighter.stamina = Math.max(1, fighter.stamina - cost);
  } else {
    if (fighter.stamina < cost * 0.5 && fighter.stamina > 1) return false;
    fighter.stamina = Math.max(1, fighter.stamina - cost);
  }
  fighter.currentPunchStaminaCost = cost;

  // Punch Endurance: throwing shrinks your own tank for the rest of the bout.
  // Every `punchEndurance` real punches costs `punchEnduranceLoss` PERCENT of the
  // pool this fighter walked in with, and a punch that actually goes out charged
  // costs the charge surcharge on top. Feints buy neither — they never advance
  // the counter and never pay the surcharge. `isCharged` is read after the
  // no-meter-bar downgrade above, so a charge that fizzled to a normal punch is
  // billed as one. Mirrors the clean-punches-taken pool loss: pool and ceiling
  // both come down and current stamina clamps with them.
  //
  // The cost defaults to the PUNCH_ENDURANCE_LOSS_MIN opening rate for anyone
  // without a value — AI corners, gym partners, quick fight — and only climbs
  // from there, a point per decay cycle away from the heavy bag.
  if (!isFeint) {
    const perPoint = Math.max(1, Math.round(fighter.punchEndurance ?? PUNCH_ENDURANCE_MIN));
    const perDrainPct = clampPunchEnduranceLoss(fighter.punchEnduranceLoss);
    let poolDelta = 0;
    let permanent = 0;
    fighter.punchesSincePoolDrain = (fighter.punchesSincePoolDrain ?? 0) + 1;
    if (fighter.punchesSincePoolDrain >= perPoint) {
      fighter.punchesSincePoolDrain = 0;
      // Read against the bout-start pool, like every other percent-mode event, so
      // the tenth cycle costs what the first did instead of tailing off as the
      // tank shrinks.
      permanent = maxStamPoints(fighter, perDrainPct, false);
      poolDelta -= permanent;
    }
    // The charge surcharge is signed and tunable, so it is added rather than
    // subtracted — set it positive and a charged punch pays its thrower instead.
    if (isCharged) poolDelta += maxStamAmount(fighter, "chargedPunchThrown");
    // One call for both halves: routed through the shared path so equipment gets
    // its save here too — a pool loss is a pool loss whichever end of the punch
    // it comes from — and so one punch never rolls two separate saves. Only the
    // endurance half is permanent; the surcharge stays refundable, since the
    // charged crit/stun refund exists to hand exactly that back.
    if (poolDelta !== 0) applyMaxStaminaDelta(fighter, poolDelta, { permanentAmount: permanent });
  }

  // Bruiser is graded on where the thrower's own sway sat the moment the punch
  // went, not where it is at contact. Null while the sway isn't sweeping: a frozen
  // sway parks at an extreme, which would otherwise read as a permanent back-foot
  // throw and hand the refinement a free pass on every punch.
  fighter.punchThrowRhythmProgress = isSwayRunning(fighter) ? fighter.rhythmProgress : null;
  fighter.timeSinceLastPunch = 0;
  fighter.isPunching = true;
  fighter.currentPunch = punchType;
  fighter.punchMoveDir = fighter.currentMoveDir;
  // Stamped at the throw. A short sway can be over by the time the glove
  // arrives, but the punch is still the one it spoiled.
  fighter.fatigue.swayPunch = isFatigueSwaying(fighter);
  // Latched at the throw, not at contact: the counter bonus belongs to a punch
  // fired out of the slip, even if the slip lapses before the glove lands.
  fighter.slipDirAtPunch = fighter.slipActive ? fighter.slipDir : null;
  // The one thing the opponent AI is allowed to read directly. Consumed on the
  // next tick, where the state is in hand, and used for nothing but slipping.
  fighter.punchInputUnread = true;
  fighter.punchProgress = 0;
  fighter.punchPhase = "launchDelay";
  fighter.punchPhaseTimer = 0;
  fighter.punchTravelStartTime = gameElapsedTime;
  fighter.isRePunch = isRePunch;
  fighter.retractionProgress = 0;
  fighter.punchesThrown++;
  // Drilled Actions: the throw has committed, so the bundle computed above is
  // stamped on the punch and the action joins the combination in progress. The
  // stamp goes on first -- pushDrilledLink reads punchesThrown, which is why it
  // runs after the increment.
  if (drilledState) {
    fighter.drilledPunch = (drilledClosing && drilledClosing.sharpness > 0) || drilledMastered
      ? { closing: drilledClosing && drilledClosing.sharpness > 0 ? drilledClosing : null, mastered: drilledMastered }
      : null;
    // The dodge window opens on completing the string, not on landing it.
    if (drilledClosing?.opensDodgeWindow && !isFeint) {
      fighter.drilledDodgeTimer = DRILLED_ACTION_CONFIG.dodgeWindowSec;
    }
    if (drilledToken) pushDrilledLink(fighter, drilledToken, !isFeint, opponent);
    else clearDrilledWindow(drilledState);
  }
  if (fighter.currentPunch === "jab") { fighter.jabThrown = (fighter.jabThrown ?? 0) + 1; }
  else if (fighter.currentPunch === "leftHook" || fighter.currentPunch === "rightHook") { fighter.hookThrown = (fighter.hookThrown ?? 0) + 1; }
  else if (fighter.currentPunch === "leftUppercut" || fighter.currentPunch === "rightUppercut") { fighter.uppercutThrown = (fighter.uppercutThrown ?? 0) + 1; }
  fighter.isFeinting = isFeint;
  fighter.isCharging = isCharged;
  if (isFeint) {
    fighter.feintTelegraphDisableTimer = 0.5;
  }
  if (!isFeint) soundEngine.punchWhoosh();
  if (isCharged) {
    // Remember the armed window before it is spent: a Technician-forgiven whiff
    // has to restore it exactly, and the disarm below zeroes it.
    fighter.chargeArmTimerAtThrow = fighter.chargeArmTimer;
    fighter.chargeUsesLeft--;
    if (fighter.chargeUsesLeft <= 0) {
      fighter.chargeArmed = false;
      fighter.chargeUsesLeft = 0;
      fighter.chargeArmTimer = 0;
    }
    fighter.chargeReady = false;
    fighter.chargeMeterBars--;
    if (fighter.chargeMeterBars >= 1) {
      fighter.chargeEmpoweredTimer = fighter.chargeEmpoweredDuration;
    } else {
      fighter.chargeEmpoweredTimer = 0;
    }
  }

  if (fighter.defenseState !== "fullGuard" && fighter.defenseState !== "duck") {
    fighter.defenseState = "none";
  }
  // Turn-while-punching penalty: the cost is the one-second lockout applied at
  // the moment of the turn (see the facing block). It used to be re-armed after
  // every subsequent punch for the rest of the round, which read as a fair rule
  // but was in practice an output ceiling of one punch per second — and one only
  // the AI ever paid, since no player input path gates on stunPunchDisableTimer.
  // The flag is still latched so the penalty can be given teeth again deliberately.
  // Slippery refinement: if the opponent (whoever owns this refinement) has been
  // punched at close range enough times in a row, the puncher suffers an
  // early-repunch-style penalty, same as over-eagerly re-punching.
  if (opponent && !isFeint) {
    const oppThreshold = opponent.slipperyRepunchThreshold;
    if (oppThreshold) {
      if (getDistance(fighter, opponent) <= refNum("slippery", "proximityPx")) {
        opponent.slipperyCloseRangeStreak = (opponent.slipperyCloseRangeStreak ?? 0) + 1;
        if (opponent.slipperyCloseRangeStreak >= oppThreshold) {
          fighter.earlyRepunchPenaltyTimer = Math.max(fighter.earlyRepunchPenaltyTimer, refNum("slippery", "penaltySeconds") * (fighter.repunchPenaltyMult ?? 1));
          opponent.slipperyCloseRangeStreak = 0;
        }
      } else {
        opponent.slipperyCloseRangeStreak = 0;
      }
    }
  }
  return true;
}

function tryHit(
  attacker: FighterState, defender: FighterState, state: GameState
): { hit: boolean; damage: number; cleanDamage?: number; blocked: boolean; isCrit?: boolean; isStun?: boolean; isHeadHit?: boolean; punchTravelTime?: number; isPerfectBlock?: boolean; isDodge?: boolean; isEvaded?: boolean; isWhiff?: boolean; isRhythmVulnHit?: boolean; blockReduction?: number } {
  if (!attacker.currentPunch) return { hit: false, damage: 0, blocked: false };
  // Cleared every punch; only set if this punch's own mid-rhythm sap fires.
  attacker.selfRhythmSapPrevPause = undefined;

  if (attacker.isFeinting) {
    return { hit: false, damage: 0, blocked: false };
  }

  const config = getHitPunchConfig(attacker.currentPunch);
  const rhythmBuffs = getRhythmBuffs(attacker);
  const dist = getDistance(attacker, defender);

  const attackerDucking = attacker.defenseState === "duck";
  const punchHitsHead = attackerDucking ? (attacker.punchAimsHead && config.hitsHead) : config.hitsHead;

  const armReachBonus = (attacker.armLength - 65) * PX_PER_INCH;
  const effectiveRange = (config.range + 20 + armReachBonus + (attacker.precisionStrikerRangeBonus ?? 0)) * rhythmBuffs.rangeMult;
  // Out of range: a true whiff, one of only two ways a punch cannot land at all.
  if (dist > effectiveRange) { soundEngine.whiff(); return { hit: false, damage: 0, blocked: false, isWhiff: true }; }
  if (defender.isKnockedDown) return { hit: false, damage: 0, blocked: false };

  // How square the attacker is decides whether the punch reaches the opponent at
  // all. Dead-on is a guaranteed touch; from there the odds fall away with the
  // turn and are gone entirely by 15% of a quarter turn. The turn rate outruns
  // any circling, so this only bites mid-turn — or while a clean hit has the
  // attacker's facing locked away from where the opponent now is.
  const turnPct = turnPercentTo(attacker, defender.x, defender.z);
  const turnAccuracy = facingAccuracy(turnPct);
  if (turnAccuracy <= 0 || Math.random() >= turnAccuracy) {
    soundEngine.whiff();
    // Turned too far away to connect: the other true whiff.
    return { hit: false, damage: 0, blocked: false, isWhiff: true };
  }

  const inPerfectRange = dist <= effectiveRange && dist >= effectiveRange * 0.6;

  // Difficulty scaling for level-discrepancy bonuses/penalties:
  // Easy=50%, Medium=75%, Hard=90%, Hardcore=100%.
  const diffBand = state.aiBrain?.difficultyBand ?? "Hard";
  const diffScale = diffBand === "Easy" ? 0.50 : diffBand === "Medium" ? 0.75 : diffBand === "Hard" ? 0.90 : 1.00;

  // Focus-based miss reduction: at 200 focus the player misses 65% less often.
  // The level-gap term is tunable (Level & Stat Scaling) and scaled by difficulty.
  let effectiveWhiffChance = rhythmBuffs.whiffChance;
  if (attacker.isPlayer && attacker.focusT > 0) {
    const focusLevelDiff = attacker.level - defender.level;
    const focusLevelAdj = diffScale * levelGapAdj("gapFocusWhiff", focusLevelDiff);
    const focusMissReduction = Math.max(0, Math.min(1, attacker.focusT * 0.65 + focusLevelAdj));
    effectiveWhiffChance = Math.max(0, effectiveWhiffChance * (1 - focusMissReduction));
  }
  // A punch thrown while the body was still swaying goes out off-line. Its own
  // roll, deliberately outside the perfect-range exemption below: the fault is
  // in the fighter, not the distance. Returned unflagged rather than as a whiff
  // so it never reaches the AI's range learning as a range mistake.
  if (attacker.fatigue.swayPunch && Math.random() < getFatigueConfig().swayMissAdd * fatigueEffectMult(attacker)) {
    soundEngine.whiff();
    return { hit: false, damage: 0, blocked: false };
  }
  if (!inPerfectRange && effectiveWhiffChance > 0 && Math.random() < effectiveWhiffChance) {
    state.hitEffects.push({
      x: attacker.x + attacker.facing * 30,
      y: attacker.z - 25,
      timer: 0.4,
      type: "normal",
      text: "MISS",
      attackerColor: attacker.colors.trunks,
    });
    soundEngine.whiff();
    return { hit: false, damage: 0, blocked: false };
  }

  if (!attacker.isPlayer && state.aiBrain) {
    const aiWhiffRates: Record<string, number> = { "Easy": 0.20, "Medium": 0.15, "Hard": 0.10, "Hardcore": 0.05 };
    const aiWhiff = (aiWhiffRates[state.aiBrain.difficultyBand] || 0.10) + state.enemyWhiffBonus;
    if (Math.random() < aiWhiff) {
      return { hit: false, damage: 0, blocked: false };
    }
  }

  // Slipped: the head only counts as off the line once the slide into the slipped
  // position has finished, and only for a short window after that — caught still
  // moving, or sat in the slip too long, and the shot lands. Body shots go through
  // untouched either way — the slip only moves the head. This sits ahead of every
  // other evasion so a well-timed slip is what decides the punch, and it returns
  // the canonical dodge flag: the popup, the dodge count and the dodge turn-delay
  // events are all paid out by the dodge branch in applyHit.
  if (punchHitsHead && defender.slipActive
      && defender.slipTimer >= defender.slipEnterDuration
      && defender.slipTimer <= defender.slipEnterDuration + SLIP_DODGE_WINDOW) {
    if (defender.isPlayer) {
      state.roundStats.playerConsecutiveLanded = 0;
      if (state.aiBrain) state.aiBrain.lastPunchDodgedTimer = 0.6;
      if (state.behaviorProfile) state.behaviorProfile.playerLastDodgeTime = state.fightElapsedTime;
    }
    recordEvent(state, "dodge", defender.isPlayer ? "player" : "enemy", {
      punch: attacker.currentPunch, method: "slip",
    });
    // Timed right: the read-slip needs no correction, so the attempt closes here.
    defender.slipReadAttemptTimer = 0;
    return { hit: false, damage: 0, blocked: false, isDodge: true };
  }

  // The crouch as it physically stands, not as it was asked for: a fighter
  // still serving their duck lag is upright and evades nothing.
  const isDucking = isDuckLive(defender);

  // Defense-based evasion: player's defense stat causes incoming punches to miss.
  // Ducking: 75% base miss rate at defense=200; standing: 78% base miss rate.
  // The level-gap term is tunable (Level & Stat Scaling) and scaled by difficulty.
  if (defender.isPlayer && defender.defenseT > 0) {
    const evadeLevelDiff = defender.level - attacker.level;
    const evadeLevelAdj = diffScale * levelGapAdj("gapEvade", evadeLevelDiff);
    const evadeBase = isDucking ? defender.defenseT * 0.60 : defender.defenseT * 0.65;
    const evadeChance = Math.max(0, Math.min(1, evadeBase + evadeLevelAdj));
    if (Math.random() < evadeChance) {
      soundEngine.whiff();
      // Evaded, not whiffed: the defender's stat is what made it miss, so this
      // is a dodge as far as the turn-delay events are concerned, even though it
      // carries none of the DODGE popup's accounting.
      return { hit: false, damage: 0, blocked: false, isEvaded: true };
    }
  }

  // Uppercuts pierce through duck defense and still hit the head
  const isUppercut = attacker.currentPunch?.includes("Uppercut");
  if (punchHitsHead && isDucking && !isUppercut) {
    if (defender.isPlayer) {
      state.roundStats.playerPunchesDodged++;
      state.roundStats.playerDuckDodges++;
      state.roundStats.playerConsecutiveLanded = 0;
      if (state.aiBrain) {
        state.aiBrain.lastPunchDodgedTimer = 0.6;
      }
      if (state.behaviorProfile) {
        state.behaviorProfile.playerLastDodgeTime = state.fightElapsedTime;
      }
    } else {
      state.roundStats.enemyPunchesDodged++;
    }
    recordEvent(state, "dodge", defender.isPlayer ? "player" : "enemy", {
      punch: attacker.currentPunch, method: "duck",
    });
    // Ducking under the shot is the game's own canonical dodge — it is counted
    // as one right above — so it must never be paid out as a whiff.
    return { hit: false, damage: 0, blocked: false, isEvaded: true };
  }

  // An armed flag only counts while its window is genuinely open: the player's is owned by
  // the V-key state machine, an AI-driven one by its perfectBlockTimer hold.
  const perfectBlockWindowOpen = defender.perfectBlockState === "active" || defender.perfectBlockTimer > 0;
  // With the directional toggle on, the postures have to match: a standing perfect
  // block only turns away punches thrown from a standing attacker, and a ducking one
  // only turns away punches thrown out of a duck. A mismatch falls through to
  // ordinary blocking. With it off, an open window stops anything.
  const perfectBlockCoversPunch = !state.directionalPerfectBlock || attackerDucking === isDucking;
  const isPerfectBlock = defender.perfectBlockActive && perfectBlockWindowOpen && perfectBlockCoversPunch;

  let blocked = false;
  let blockReduction = 0;
  // Set when a level-100 punch refinement ignores a normal block, so nothing
  // downstream can quietly hand the guard back.
  let normalBlockIgnored = false;
  // Set when the rhythm-cut / Bruiser roll below beats a perfect block, so the
  // result doesn't go on to report a perfect block that never actually held.
  let ignoredPerfectBlock = false;

  const punchDurations = getPunchPhaseDurations(attacker, config, attacker.isRePunch);
  const totalPreContactTime = punchDurations.launchDelay + punchDurations.armSpeed;

  const isHeadPunch = punchHitsHead && !isDucking;
  const isBodyPunch = !punchHitsHead || isDucking;
  const highGuardUp = defender.defenseState === "fullGuard";
  const lowGuardUp = defender.defenseState === "none" && !defender.handsDown;

  // Throwing a punch opens that side of the guard. From the moment the punch
  // launches until it is fully retracted, the puncher's ordinary guard no longer
  // covers punches coming off the opponent's matching arm — lead answers lead,
  // rear answers rear, each read through its own fighter's stance. So an orthodox
  // fighter punching with the left is open to an orthodox opponent's LEFT hand and
  // a southpaw opponent's RIGHT hand. Feints count: the arm is out and the punch
  // still owns it until the feint ends, which is exactly the window isPunching
  // spans. Posture is irrelevant: it holds whether either fighter is ducking or
  // standing. Perfect block is exempt — it re-asserts the block further down;
  // this only opens the normal guard.
  const guardSideOpen = defender.isPunching && defender.currentPunch != null &&
    isLeadArmPunch(defender.currentPunch, defender.boxingStance) ===
      isLeadArmPunch(attacker.currentPunch, attacker.boxingStance);

  // A fighter mid-flinch has their hands somewhere else: the ordinary guard is
  // bypassed outright for as long as the reaction lasts, hooks very much
  // included — nothing comes off a hook thrown into a flinch unless the
  // defender actually times a perfect block. Perfect block is not touched here:
  // it re-asserts below, and putting it up is one of the things that stops the
  // flinch happening in the first place.
  const defenderFlinching = isFlinching(defender);

  if (highGuardUp && !guardSideOpen && !defenderFlinching) {
    blocked = true;
    const levelT = scalingLevelT(defender.level);
    const baseBlock = isHeadPunch
      ? levelScale(defender.level, 0.40, 0.70, "blockReductionHead")
      : levelScale(defender.level, 0.30, 0.50, "blockReductionBody");
    blockReduction = baseBlock * defender.blockMult;
    blockReduction = Math.min(blockReduction, 0.95);
    if (highGuardUp && !defender.autoGuardActive && !isPerfectBlock && defender.timeSinceGuardRaised < totalPreContactTime) {
      // Speed narrows the defender's vulnerability window, either corner:
      // speed 0 → 35-65%, speed 200 → 45-55%.
      const _defSpeedHalf = 0.15 - 0.10 * defender.speedT;
      const inRhythmWeak = defender.rhythmLevel > 0 &&
        defender.rhythmProgress >= (0.5 - _defSpeedHalf) && defender.rhythmProgress <= (0.5 + _defSpeedHalf);
      const extraFrac = inRhythmWeak ? 0.10 : 0.50;
      blockReduction = Math.min(0.95, blockReduction + (1 - blockReduction) * extraFrac);
    }
  }

  if (blocked && defender.punchingWhileBlocking) {
    blockReduction *= 0.75;
  }

  if (blocked && defender.stunBlockWeakenTimer > 0) {
    blockReduction *= STUN_BLOCK_WEAKEN_MULT;
  }

  // Caught mid-sway: the guard is trailing the body and barely stops anything.
  // Deliberately above the perfect-block override — a perfect block re-asserts
  // last and stays exempt, and the sway refuses perfect block outright anyway.
  if (blocked && isFatigueSwaying(defender)) {
    // Weight Lifting buys this back a point at a time, down to nothing at all.
    const ineffective = Math.max(0,
      getFatigueConfig().swayBlockIneffective - (defender.fatigue.trainBlock ?? 0) / 100);
    blockReduction *= 1 - ineffective * fatigueEffectMult(defender);
  }

  // Early re-punch penalty: throwing another punch before the previous one's
  // retraction fully completed leaves the puncher exposed until that
  // retraction would have finished.
  if (blocked && defender.earlyRepunchPenaltyTimer > 0) {
    // Punch Rolling refinement: increases how much this penalty hurts the opponent.
    blockReduction *= Math.max(0, 0.5 * (1 - (attacker.punchRollingRepunchBoost ?? 0)));
  }

  if (blocked && attacker.swayZone === "power") {
    const levelDisc = attacker.level - defender.level;
    const bypassChance = Math.max(0, Math.min(0.90, 0.30 + attacker.level * 0.0025 + levelGapAdj("gapPowerBypass", levelDisc)));
    if (Math.random() < bypassChance) {
      blocked = false;
      blockReduction = 0;
    }
  }

  // Charge refinement block bypass: a fully charged punch of the matching type
  // has a chance (scaled by refinement level) to bypass the defender's block entirely.
  if (blocked && attacker.isCharging) {
    let chargeBypass: number | undefined;
    const cp = attacker.currentPunch;
    if (cp === "jab" || cp === "cross") chargeBypass = attacker.chargeJabBlockBypass;
    else if (cp === "leftHook" || cp === "rightHook") chargeBypass = attacker.chargeHookBlockBypass;
    else if (cp === "leftUppercut" || cp === "rightUppercut") chargeBypass = attacker.chargeUppercutBlockBypass;
    if (chargeBypass != null && Math.random() < chargeBypass) {
      blocked = false;
      blockReduction = 0;
    }
  }

  // Punch refinement block ignore: at level 100 the matching punch family gets a
  // flat chance to go straight through a normal guard, charged or not. Perfect
  // block is explicitly exempt — it is the one defence this cannot beat. The
  // !isPerfectBlock guard is belt-and-braces: the perfect-block branch below
  // re-asserts the block anyway, but the intent should not rest on ordering.
  if (blocked && !isPerfectBlock) {
    let ignoreChance: number | undefined;
    const bp = attacker.currentPunch;
    if (bp === "jab" || bp === "cross") ignoreChance = attacker.straightBlockIgnoreChance;
    else if (bp === "leftHook" || bp === "rightHook") ignoreChance = attacker.hookBlockIgnoreChance;
    else if (bp === "leftUppercut" || bp === "rightUppercut") ignoreChance = attacker.uppercutBlockIgnoreChance;
    if (ignoreChance != null && Math.random() < ignoreChance) {
      blocked = false;
      blockReduction = 0;
      normalBlockIgnored = true;
    }
  }

  // Defense-based auto-block/dodge: 0 defense → no advantage; 200 defense → 80% base chance.
  // +0.12% per level the defender is above the opponent, -0.25% per level below (scaled by difficulty).
  // When guard is UP (fullGuard): fully blocks the hit. When guard is DOWN: becomes a DODGE instead.
  // Attacker's Technician refinement reduces dodge chance (lv1=5% → lv100=60%).
  // A punch that just ignored the guard is not offered back to this roll: the
  // guard is necessarily up in that case, so its only outcome here would be a
  // full re-block, undoing the ignore. Slippery below is deliberately left
  // reachable — the refinement ignores blocks, not evasion.
  // A guard whose punching side is open is skipped for the same reason: with the
  // guard up this roll only ever produces a block, and that side is not covered.
  // A guard that is DOWN still gets its dodge — that is evasion, not blocking.
  if (!blocked && !normalBlockIgnored && !(highGuardUp && guardSideOpen) && defender.defenseT > 0) {
    const defLevelDiff = defender.level - attacker.level;
    const defBlockAdj = diffScale * levelGapAdj("gapBlockRoll", defLevelDiff);
    const techNegate = Math.min(1, attacker.technicianAccuracyBoost ?? 0);
    // This roll is a BLOCK when the guard is up and a DODGE when it is down.
    // Precision Striker sharpens against evasion only, so it joins the negation
    // for the dodge outcome and leaves the guard-up block untouched.
    const negate = highGuardUp ? techNegate : combinedDodgeNegate(techNegate, attacker);
    const defBlockChance = Math.max(0, Math.min(1, (defender.defenseT * 0.80 + defBlockAdj) * (1 - negate) - (defender.dodgePenalty ?? 0)));
    if (Math.random() < defBlockChance) {
      if (highGuardUp) {
        // Same bypass as above: the roll succeeds, but there is no guard in
        // the way to spend it on.
        if (!defenderFlinching) {
          blocked = true;
          blockReduction = 1.0;
        }
      } else {
        return { hit: false, damage: 0, blocked: false, isDodge: true };
      }
    }
  }
  // Drilled Actions, Mastered only: for a second after finishing the string the player is
  // much harder to hit. Its own independent roll, like Slippery below, and always
  // a DODGE whatever the guard is doing — the window is footwork off the back of
  // the combination, not a block.
  if (!blocked && defender.isPlayer && (defender.drilledDodgeTimer ?? 0) > 0) {
    if (Math.random() < DRILLED_ACTION_CONFIG.dodgeChance) {
      return { hit: false, damage: 0, blocked: false, isDodge: true };
    }
  }
  // Item-granted flat dodge chance, on its own independent roll. Always a DODGE —
  // slipping the punch regardless of guard state. Attacker's Technician refinement
  // reduces this chance too.
  if (!blocked && (defender.slipperyDodgeBonus ?? 0) > 0) {
    const techNegate = Math.min(1, attacker.technicianAccuracyBoost ?? 0);
    const negate = combinedDodgeNegate(techNegate, attacker);
    const slipChance = Math.max(0, defender.slipperyDodgeBonus! * (1 - negate) - (defender.dodgePenalty ?? 0));
    if (Math.random() < slipChance) {
      return { hit: false, damage: 0, blocked: false, isDodge: true };
    }
  }

  // Focus-based block bypass: 0 focus → no advantage; 200 focus → 65% base chance.
  // +0.25% per level above opponent, -0.2% per level below (scaled by difficulty).
  if (blocked && attacker.isPlayer && attacker.focusT > 0) {
    const levelDiff = attacker.level - defender.level;
    const focusBypassLevelAdj = diffScale * levelGapAdj("gapFocusBypass", levelDiff);
    const focusBypassChance = Math.max(0, Math.min(1, attacker.focusT * 0.65 + focusBypassLevelAdj));
    if (Math.random() < focusBypassChance) {
      blocked = false;
      blockReduction = 0;
    }
  }

  if (!punchHitsHead && isDucking) {
    blockReduction = Math.max(blockReduction, 0.3);
  }

  // Defender rhythm vulnerability: a punch landing while the defender's rhythm is
  // in the green zone cannot be blocked.
  // The green zone widens with the attacker's focus (0 pts → 45-55%, 200 pts → 23-87%).
  // Chin Hitter refinement further widens the window.
  // Ducking grants full immunity to own rhythm vulnerabilities.
  let isRhythmVulnHit = false;
  if (defender.rhythmLevel > 0 && !isDucking && defender.rhythmWalking) {
    const _vulnHalf = getRhythmVulnHalfWidth(attacker, defender);
    if (isInRhythmVulnWindow(defender.rhythmProgress, _vulnHalf)) {
      blocked = false;
      blockReduction = 0;
      defender.rhythmHitFlashTimer = 0.36;
      isRhythmVulnHit = true;
    }
  }

  // Perfect block: V key pressed at contact moment — negates ALL damage (100%).
  // Overrides all other block/unblock logic.
  // Both sides hold the window: the player's is owned by the perfect block state machine,
  // the AI's by its perfectBlockTimer hold (Defense-scaled, same ceiling). While the window
  // is open it negates every punch that lands inside it; the owner closes it, not the hit.
  if (isPerfectBlock) {
    blocked = true;
    blockReduction = 1.0;
  }

  // Rhythm-cut and Bruiser block ignore. Unlike the punch-family refinements
  // higher up, these two are allowed to beat a perfect block, so they roll last —
  // after the perfect-block override has had its say. Every remaining use of
  // blockReduction below is gated on `blocked`, so clearing it here is final.
  if (blocked) {
    // Base rule, both corners: a punch arriving while the defender's rhythm sits
    // in the cut window has a flat chance to go straight through. Same window
    // applyHit classifies a rhythm cut with, so a punch that gets through here
    // goes on to register as one. Walking gate included: the marker is parked at
    // progress 0 when a fighter stands still, and 0 is now inside the window.
    const inCutWindow = effectiveSwaySpeedLevel(defender) > 0
      && !!defender.rhythmWalking
      && isInRhythmVulnWindow(defender.rhythmProgress, RHYTHM_CUT_VULN_HALF);
    // Bruiser is judged on the ATTACKER's own sway at the moment they threw: the
    // two outer quarters of the arc (back foot / front foot), never the middle.
    const throwProgress = attacker.punchThrowRhythmProgress;
    const onSwayEdge = throwProgress != null
      && (throwProgress <= refNum("bruiser", "swayEdgeLo") || throwProgress >= refNum("bruiser", "swayEdgeHi"));
    const cutChance = inCutWindow ? RHYTHM_CUT_BLOCK_IGNORE_CHANCE : 0;
    const bruiserChance = onSwayEdge ? (attacker.bruiserBlockIgnoreChance ?? 0) : 0;
    // Two independent effects on the same punch: either one landing is enough.
    const ignoreChance = 1 - (1 - cutChance) * (1 - bruiserChance);
    if (ignoreChance > 0 && Math.random() < ignoreChance) {
      blocked = false;
      blockReduction = 0;
      ignoredPerfectBlock = isPerfectBlock;
    }
  }

  const punchType = attacker.currentPunch;

  // ── THE POWER POOL ────────────────────────────────────────────────────────
  // Every "more power" source this fighter carries is a percentage POINT, and
  // the points are SUMMED and applied to the base exactly once.
  //
  //   `damageMult`      the base: the level ramp and spent stat points
  //   `powerBonusPct`   fighter-wide extras already summed in at fight build —
  //                     the Pressure Fighter refinement, Fight Gloves, item
  //                     boosts such as Gummy Candy and the Hand Wraps
  //   + below           the punch-family refinement matching THIS punch
  //                     (Straight / Hook / Uppercut) and drilled mastery
  //
  // They never multiply each other. A +50% refinement alongside a +50% glove is
  // +100% on the base, not +125%. Adding a new power source means adding another
  // summand here or into `powerBonusPct` — never another `damage *= ...` line,
  // which would silently reintroduce the compounding this replaced.
  //
  // Everything BELOW this point stays multiplicative on purpose: counter-hit,
  // stance, distance, charge, rhythm, crit and block all modify the particular
  // punch that was thrown, rather than how hard this fighter hits.
  let powerPct = attacker.powerBonusPct;
  if (attacker.refJabBonus != null && (punchType === "jab" || punchType === "cross")) powerPct += attacker.refJabBonus;
  if (attacker.refHookBonus != null && (punchType === "leftHook" || punchType === "rightHook")) powerPct += attacker.refHookBonus;
  if (attacker.refUppercutBonus != null && (punchType === "leftUppercut" || punchType === "rightUppercut")) powerPct += attacker.refUppercutBonus;
  if (attacker.drilledPunch) {
    powerPct += drilledPowerBonus(attacker.drilledPunch.closing, attacker.drilledPunch.mastered);
  }

  let damage = config.damage * attacker.damageMult * Math.max(0, 1 + powerPct);
  damage *= attacker.swayDamageMult;

  const shortArmBonus = attacker.armLength < 65 ? 1 + (65 - attacker.armLength) * 0.02 : 1;
  damage *= shortArmBonus;

  damage *= attacker.punchLaunchDamageMult;
  // Countering out of a slip: the hooks come off a backward slip, and each
  // straight off the slip to its own side. Applied before the rhythm, charge and
  // crit multipliers so those all scale the bonus with it.
  if (attacker.slipDirAtPunch) {
    const isHook = punchType === "leftHook" || punchType === "rightHook";
    const slipCounter =
      (attacker.slipDirAtPunch === "back" && isHook) ||
      (attacker.slipDirAtPunch === "left" && punchType === "jab") ||
      (attacker.slipDirAtPunch === "right" && punchType === "cross");
    if (slipCounter) damage *= SLIP_COUNTER_BONUS;
  }
  if (punchType === "jab") damage *= rhythmBuffs.jabDamageMult;
  if (punchType === "cross") damage *= rhythmBuffs.crossDamageMult;
  if (punchType === "leftHook" || punchType === "rightHook") damage *= rhythmBuffs.hookDamageMult;

  const insideRange = dist < effectiveRange * 0.6;
  if (insideRange) {
    if (punchType === "leftHook" || punchType === "rightHook" || punchType === "leftUppercut" || punchType === "rightUppercut") {
      damage *= 1.15;
    } else if (punchType === "jab" || punchType === "cross") {
      damage *= 0.85;
    }
  }

  // Stance/movement base-damage modifiers (applied to base; crit & stun computed after).
  const moveDir = attacker.punchMoveDir;
  if (punchType === "leftUppercut" || punchType === "rightUppercut") {
    if (attackerDucking && !blocked) {
      damage *= 1.3 + Math.random() * 0.2; // ducking uppercut: 1.3-1.5x when not blocked
    } else if (!attackerDucking) {
      damage *= 0.85 + Math.random() * 0.15; // standing uppercut: 0.85-1.0x
    }
  } else if (punchType === "leftHook" || punchType === "rightHook") {
    if (moveDir === "forward" || moveDir === "backward") {
      damage *= 1.3; // hook while moving: +1.3x power
    }
    if (!attackerDucking) {
      damage *= 1.2; // standing hook: +20%
    }
    if (defender.handsDown) {
      damage *= 1.2; // hook vs no guard: +20%
    }
  } else if (punchType === "cross") {
    if (!attackerDucking) {
      damage *= 1.2; // standing cross: +20%
    }
  } else if (punchType === "jab") {
    if (moveDir === "forward") {
      damage *= 0.9; // advancing jab: 0.9x power
    }
  }

  // Snapshot pre-charge damage for perfect block feedback (used in applyHit)
  const cleanDamage = damage;

  if (attacker.isCharging) {
    let chargeMult: number;
    if (attacker.rawPower <= 200) {
      const _cpT = Math.max(0, Math.min(1, (attacker.rawPower - 1) / 199));
      chargeMult = 1.5 * (1.05 + _cpT * 1.95);
    } else {
      const _cpT2 = Math.min(1, (attacker.rawPower - 200) / 800);
      chargeMult = 4.5 * (1 - 0.5 * _cpT2);
    }
    if (attacker.chargeEmpoweredTimer > 0) {
      chargeMult *= 1.5;
      attacker.chargeEmpoweredTimer = 0;
    }
    if (attacker.chinHitterChargeDamageMult) {
      chargeMult *= attacker.chinHitterChargeDamageMult;
    }

    // A raised auto guard soaks the extra damage the charge is carrying, in
    // proportion to the defender's Defense: none of it at Defense 0, up to
    // CHARGE_AUTOGUARD_RESIST_AT_CAP of it at the 1000 cap. Only the surplus
    // over an uncharged punch is resisted, so the shot still lands for its
    // ordinary damage no matter how much Defense is behind the guard.
    //
    // Every charge bonus above — the power curve, the empowered window and Chin
    // Hitter — is folded into `chargeMult` FIRST so the resist applies to the
    // whole surplus. A new charge bonus applied as its own `damage *= ...` after
    // this point would bypass the guard entirely.
    if (defender.autoGuardActive && highGuardUp) {
      const resist = CHARGE_AUTOGUARD_RESIST_AT_CAP * Math.max(0, Math.min(1, defender.defenseT));
      chargeMult = 1 + (chargeMult - 1) * (1 - resist);
    }

    damage *= chargeMult;
  }

  // Cross-stance matchup modifiers (orthodox vs southpaw)
  if (attacker.boxingStance !== defender.boxingStance) {
    if (punchType === "jab") {
      if (blocked && !isPerfectBlock) blockReduction = Math.min(0.95, blockReduction + 0.10);
      damage *= 1.12;
      damage = Math.ceil(damage);
    } else if (punchType === "cross") {
      if (blocked && !isPerfectBlock) blockReduction = Math.max(0, blockReduction - 0.20);
    } else if (punchType === "leftHook" || punchType === "rightHook") {
      if (!attackerDucking) damage *= 1.10;
    } else {
      const isFrontUppercut = attacker.boxingStance === "orthodox" ? punchType === "leftUppercut" : punchType === "rightUppercut";
      if (isFrontUppercut) damage *= 1.10;
    }
  }

  if (attacker.halfGuardPunch) {
    damage *= 0.7;
  }

  if (attacker.isRePunch) {
    damage *= 0.75;
  }

  if (blocked) {
    damage *= (1 - blockReduction);
  }

  if (defender.stance === "backFoot") {
    damage *= 1.07;
  }

  // Puncher (attacker) rhythm: while NOT ducking, landing inside 45-55% saps power
  // (0.9x) and pauses the attacker's stamina recovery for 0.75s; landing at the
  // extremes (<=15% or >=85%) adds 1.2x power.
  if (attacker.rhythmLevel > 0 && !attackerDucking) {
    const arp = attacker.rhythmProgress;
    if (arp >= 0.45 && arp <= 0.55) {
      damage *= 0.9;
      attacker.selfRhythmSapPrevPause = attacker.staminaPauseFromRhythm;
      attacker.staminaPauseFromRhythm = Math.max(attacker.staminaPauseFromRhythm, 0.75);
    } else if (arp <= 0.15 || arp >= 0.85) {
      damage *= 1.2;
    }
  }

  // Thrown mid-sway: the shot lands soft, flat, and cannot finish anyone. The
  // flag is stamped at launch rather than re-tested here, because a short sway
  // can finish while the punch it spoiled is still in flight.
  const swayPunchT = attacker.fatigue.swayPunch ? fatigueEffectMult(attacker) : 0;
  if (swayPunchT > 0) {
    // Charge punches landed in sparring buy this back a point at a time.
    const debuff = Math.max(0,
      getFatigueConfig().swayDamageDebuff - (attacker.fatigue.trainDamage ?? 0) / 100);
    damage *= 1 - debuff * swayPunchT;
  }

  const isHeadHit = punchHitsHead && !isDucking;
  let baseCritChance = isHeadHit ? HEAD_CRIT_CHANCE : BODY_CRIT_CHANCE;
  baseCritChance *= levelScale(attacker.level, 1, 1.5, "critChance");
  const defenderGuardDown = defender.handsDown && !defender.isPunching;
  if (defenderGuardDown) baseCritChance *= NO_GUARD_CRIT_MULT;
  baseCritChance *= Math.max(0, defender.critResistMult);
  baseCritChance *= attacker.critMult;
  if (attacker.swaySpeedLevel === 0) {
    baseCritChance *= 0.9;
  }
  // Ducking attacker: crit chance reduced by 20%
  if (attackerDucking) {
    baseCritChance *= 0.8;
  }
  // Early re-punch penalty: puncher is exposed to extra crit risk until the
  // interrupted punch's retraction would have naturally finished.
  if (defender.earlyRepunchPenaltyTimer > 0) {
    // Punch Rolling refinement: increases how much this penalty hurts the opponent.
    baseCritChance *= 1 + 0.15 * (1 + (attacker.punchRollingRepunchBoost ?? 0));
  }
  // Defender at 49-51% rhythm: high crit chance override (player 90%, AI 80%).
  if (defender.rhythmLevel > 0 && !isDucking) {
    const rp = defender.rhythmProgress;
    if (rp >= 0.49 && rp <= 0.51) {
      const rhythmCritFloor = attacker.isPlayer ? 0.90 : 0.80;
      baseCritChance = Math.max(baseCritChance, rhythmCritFloor);
    }
  }
  // Rhythm's accuracy buff is additive: the bonus over 1 lands as flat
  // percentage points alongside the other additive terms below, rather than
  // scaling whatever the chance has already been multiplied up to.
  baseCritChance += rhythmBuffs.accuracyMult - 1;
  baseCritChance += (defender.rhythmCritVulnStack ?? 0);
  // Drilled Actions. Unlike power, the crit halves are additive percentage points
  // and both apply: a punch that is at once a mastered opener and the closer of
  // another string is sharper for both. The closing half ramps with repetition.
  if (attacker.drilledPunch) {
    baseCritChance += attacker.drilledPunch.closing?.critBonus ?? 0;
    if (attacker.drilledPunch.mastered) baseCritChance += DRILLED_ACTION_CONFIG.masteryCritBonus;
  }
  // A sway punch cannot crit. Through a Reset's damped sway it very nearly can.
  baseCritChance *= 1 - swayPunchT;
  baseCritChance = Math.min(1, Math.max(0, baseCritChance));
  const isCrit = Math.random() < baseCritChance;
  if (isCrit) {
    // Crit damage adds, it never compounds. The base crit and the punch
    // family's refinement bonus sum into one multiplier applied to the clean
    // punch once: a maxed jabPower crit is 8.4 + 3 = 11.4x, not 8.4 x 4.
    let critDamageMult = CRIT_DAMAGE_MULT;
    if (punchType === "jab" || punchType === "cross") critDamageMult += attacker.refJabCritMult ?? 0;
    else if (punchType === "leftHook" || punchType === "rightHook") critDamageMult += attacker.refHookCritMult ?? 0;
    else if (punchType === "leftUppercut" || punchType === "rightUppercut") critDamageMult += attacker.refUppercutCritMult ?? 0;
    const preCritDamage = damage;
    damage = preCritDamage * critDamageMult;
    // Equipment Upgrades — Mouthguard. Absorbs a share of the crit's BONUS
    // damage, so a fully resisted crit still lands as a normal punch rather
    // than fading to nothing.
    const critResist = defender.critDamageResistPct ?? 0;
    if (critResist > 0) damage -= (damage - preCritDamage) * Math.min(1, critResist);
  }

  let isStun = false;
  const isAi = attacker === state.enemy;
  let stunChance: number;
  if (attacker.isCharging) {
    stunChance = isAi ? 0.25 : 0.30;
  } else {
    stunChance = BASE_STUN_CHANCE;
  }
  stunChance *= Math.max(0, defender.critResistMult);
  // Iron Chin: a flat share of the stun chance comes straight off the top.
  stunChance *= Math.max(0, 1 - (defender.ironChinStunResist ?? 0));
  stunChance *= attacker.stunMult;
  // Ducking attacker: stun chance reduced by 20%
  if (attackerDucking) {
    stunChance *= 0.8;
  }
  // Defender rhythm zones (defender = the one being punched): 48-52% while NOT
  // ducking → guaranteed stun; otherwise green zone → 3x and 35-65% → 2x stun chance.
  // Green zone widens with the attacker's focus, either corner (0 pts → 45-55%,
  // maxed → 23-87%).
  // Ducking grants full immunity to own rhythm vulnerabilities.
  let guaranteedStun = false;
  if (defender.rhythmLevel > 0 && !isDucking) {
    const rp = defender.rhythmProgress;
    const _stunFocusT = attacker.focusT;
    const _stunHalf = 0.05 + 0.15 * _stunFocusT;
    const _stunLow = 0.5 - _stunHalf;
    const _stunHigh = 0.5 + _stunHalf;
    if (!isDucking && rp >= 0.48 && rp <= 0.52) {
      guaranteedStun = true;
    } else if (rp >= _stunLow && rp <= _stunHigh) {
      stunChance *= 3.0;
    } else {
      // Speed narrows the defender's outer rhythm vulnerability zone, either
      // corner (35-65% → 45-55% at speed 200).
      const _stunVulnHalf = 0.15 - 0.10 * defender.speedT;
      if (rp >= (0.5 - _stunVulnHalf) && rp <= (0.5 + _stunVulnHalf)) {
        stunChance *= 2.0;
      }
    }
  }
  if (defender.feintDuckTouchingOpponent) {
    stunChance *= 2.0;
  }
  // Drilled Actions: the closing punch's added stun chance. Additive percentage
  // points, and deliberately still subject to the attacker power-zone gate
  // below — a drilled combination sharpens the punch, it does not exempt it
  // from the rhythm rule every other stun obeys.
  if (attacker.drilledPunch?.closing) stunChance += attacker.drilledPunch.closing.stunBonus;
  stunChance = Math.max(0, stunChance);
  // Rhythm gate: attacker must be in their power zone (≤15% or ≥85%) to land a stun.
  // Applies only when the attacker has an active rhythm bar; charged punches bypass this.
  if (attacker.rhythmLevel > 0 && !attacker.isCharging && !attackerDucking) {
    const arp = attacker.rhythmProgress;
    if (!(arp <= 0.15 || arp >= 0.85)) {
      stunChance = 0;
      guaranteedStun = false;
    }
  }
  // Technician: a landed rhythm cut carries its own stun roll. This is the
  // refinement's entire rhythm-cut effect, and it sits outside the attacker
  // power-zone gate above — landing the cut is what earns the stun, so the
  // attacker's own rhythm position must not veto it.
  let technicianRcStun = false;
  if (!blocked && (attacker.technicianRcStunChance ?? 0) > 0 && defender.swaySpeedLevel > 0) {
    const _rcRp = defender.rhythmProgress;
    if (_rcRp >= 0.45 && _rcRp <= 0.55) technicianRcStun = Math.random() < attacker.technicianRcStunChance!;
  }
  // A sway punch cannot stun, on the same terms as the crit above.
  if (swayPunchT > 0) {
    stunChance *= 1 - swayPunchT;
    if (swayPunchT >= 1) {
      guaranteedStun = false;
      technicianRcStun = false;
    }
  }
  // Energy fatigue is the only door to a stun now. A fresh fighter cannot be
  // stunned by anything — a guaranteed green-zone window and a landed rhythm
  // cut included. Deliberately the last word, so nothing above reopens it.
  if (!isFatigued(defender)) {
    stunChance = 0;
    guaranteedStun = false;
    technicianRcStun = false;
  }
  isStun = guaranteedStun || technicianRcStun || Math.random() < stunChance;

  if (state.tutorialMode && state.tutorialStage === 3 && state.tutorialStep === 6 && attacker.isPlayer && defender.rhythmLevel > 0) {
    const rp = defender.rhythmProgress;
    const _tutVulnHalf = 0.05 + 0.15 * attacker.focusT;
    if (rp >= 0.5 - _tutVulnHalf && rp <= 0.5 + _tutVulnHalf) {
      state.tutorialTracking.rhythmHits++;
    }
  }

  if (blocked && !isPerfectBlock && (attacker.pressureBlockDmgMult ?? 1) > 1) {
    damage *= attacker.pressureBlockDmgMult!;
  }

  return { hit: true, damage, cleanDamage, blocked, blockReduction, isCrit, isStun, isHeadHit, punchTravelTime: totalPreContactTime, isPerfectBlock: isPerfectBlock && !ignoredPerfectBlock, isRhythmVulnHit };
}

function applyStunEffects(target: FighterState): void {
  target.moveSlowMult = STUN_MOVE_SLOW_MULT;
  target.moveSlowTimer = STUN_MOVE_SLOW_DURATION;
  target.regenPauseTimer = Math.max(target.regenPauseTimer, STUN_REGEN_DISABLE_DURATION);
  target.stunBlockWeakenTimer = STUN_BLOCK_WEAKEN_DURATION;
  target.stunPunchSlowMult = STUN_PUNCH_SLOW_MULT;
  target.stunPunchSlowTimer = STUN_PUNCH_SLOW_DURATION;
  target.facingTurnDelay += 0.30;
  target.chargeMeterLockoutTimer = 3.0;
  {
    const totalPct = target.chargeMeterBars * 100 + target.chargeMeterCounters;
    const afterDrain = Math.max(0, totalPct - 100);
    target.chargeMeterBars = Math.floor(afterDrain / 100);
    target.chargeMeterCounters = afterDrain % 100;
  }
  target.rhythmLevel = 0;
  target.rhythmProgress = 0;
  target.stance = "neutral";
  target.autoGuardActive = false;
  target.autoGuardTimer = 0;
}

function toPunchSound(punch: PunchType | null): PunchSoundType {
  if (!punch) return "jab";
  if (punch === "cross") return "jab";
  if (punch.includes("Hook")) return "hook";
  if (punch.includes("Uppercut")) return "uppercut";
  return "jab";
}

/**
 * Turns one tuning-screen number into the stamina points this fighter pays or
 * gets back right now.
 *
 * In points mode the number IS the points, so a 600-pool fighter and a 200-pool
 * one lose the same. In percent mode it is read against the pool that fighter
 * walked in with rather than their current one, which keeps a rule linear: ten
 * knockdowns cost ten times what one does instead of tailing off as the pool
 * shrinks, and the same event costs the same whether it lands in round 1 or
 * round 12. Falls back to the live pool on the opening frame, before
 * `boutStartMaxStamina` has been snapshotted.
 *
 * The unit is per event, not per screen, so it has to be passed in.
 */
function maxStamPoints(f: FighterState, raw: number, usePoints: boolean): number {
  if (!raw) return 0;
  if (usePoints) return raw;
  const pool = f.boutStartMaxStamina ?? f.maxStamina;
  return pool * (raw / 100);
}

/**
 * The signed points one named max-stamina event moves this fighter's pool by,
 * or 0 when that event is switched off in the tuning screen.
 *
 * Where several amounts stack into one charge, add up what this returns rather
 * than the raw numbers: each event carries its own unit and its own on/off
 * switch, so only the converted points are comparable.
 */
function maxStamAmount(f: FighterState, key: keyof MaxStamAmounts): number {
  const cfg = getMaxStamConfig();
  if (!isMaxStamEnabled(cfg, key)) return 0;
  return maxStamPoints(f, activeMaxStamAmounts(cfg)[key] ?? 0, cfg.usePoints[key]);
}

/**
 * The one place a rule takes gas permanently out of a fighter's tank.
 *
 * Pool and ceiling come down together: leaving `maxStaminaCap` where it was would
 * let regen quietly refill past the new pool, undoing the drain. Current stamina
 * is clamped so the HUD can never read `cur > max`. Floors at 1 -- a fighter with
 * literally no tank isn't a state the rest of the engine expects to handle.
 *
 * Every call here is picked up by the pool watcher and surfaces as an orange
 * "-N max stamina" tick beside that fighter's bar; nothing extra to wire up.
 */
interface MaxStaminaDrainOpts {
  /**
   * True when the loss is being charged for the punch that put this fighter on
   * the canvas. Equipment cannot shrug those off — getting dropped always costs
   * the tank it costs.
   */
  knockdownAttributed?: boolean;
  /**
   * For the losses that were never a punch landing on anybody — the bell's own
   * round-end reduction and the rhythm penalty it pays out. A mouthguard is
   * protection against shots taken; it has never saved a fighter from the
   * scorecards, and letting it start would be a silent equipment buff.
   */
  unnegatable?: boolean;
  /**
   * How much of this drain, in points, is PERMANENT for the rest of the bout —
   * Punch Endurance, whose whole point is that the tank never comes back. It
   * lowers the ceiling a later refund can restore to. Anything beyond this figure
   * (a charged punch's surcharge rides along in the same call) stays refundable.
   */
  permanentAmount?: number;
}

/**
 * Equipment Upgrades — Mouthguard. Rolls whether a pool loss is shrugged off
 * entirely. Rolled per loss rather than per punch, so a punch that charges two
 * separate losses gets two independent saves.
 */
function rollMaxStaminaNegate(f: FighterState, opts?: MaxStaminaDrainOpts): boolean {
  if (opts?.knockdownAttributed || opts?.unnegatable) return false;
  const chance = f.maxStaminaNegateChance ?? 0;
  return chance > 0 && Math.random() < chance;
}

/**
 * The floor every max-stamina event stops at: 2% of the pool the fighter walked
 * in with. Once 98% of a tank has been shrunk away there is nothing left to take,
 * and an event that would fire below it does not fire at all.
 */
function maxStaminaEventFloor(f: FighterState): number {
  return Math.max(1, (f.boutStartMaxStamina ?? f.maxStamina) * 0.02);
}

/** Returns the pool actually taken — 0 when the loss was shrugged off. */
function drainMaxStamina(f: FighterState, amount: number, opts?: MaxStaminaDrainOpts): number {
  if (amount <= 0) return 0;
  const floor = maxStaminaEventFloor(f);
  // Already down to the last 2%: the event does not activate, and does not burn
  // an equipment save doing nothing.
  if (f.maxStamina <= floor) return 0;
  if (rollMaxStaminaNegate(f, opts)) return 0;
  const before = f.maxStamina;
  f.maxStamina = Math.max(floor, f.maxStamina - amount);
  const drop = before - f.maxStamina;
  // The ceiling comes down by exactly what the pool did, so a drain clipped by
  // the floor never quietly clips more off the cap than it took.
  f.maxStaminaCap = Math.max(1, f.maxStaminaCap - drop);
  if (f.stamina > f.maxStamina) f.stamina = f.maxStamina;
  // A permanent loss is the new ceiling for the rest of the bout — a later refund
  // restores to here, never back to the pool the fighter walked in with.
  const permanent = Math.min(drop, opts?.permanentAmount ?? 0);
  if (permanent > 0) {
    const ceiling = f.maxStaminaHardCeiling ?? f.boutStartMaxStamina ?? before;
    f.maxStaminaHardCeiling = Math.max(floor, ceiling - permanent);
  }
  return drop;
}

/**
 * The mirror of drainMaxStamina, for the rules that hand tank back.
 *
 * Capped at the pool the fighter started the bout with: these are refunds of gas
 * already lost, never a way to build a bigger fighter mid-fight. Ceiling rises
 * only by however much the pool actually did, so a fighter at full tank gains
 * nothing rather than silently inflating their cap.
 */
/**
 * Ring mileage: time spent walking costs tank.
 *
 * Called from the two places a fighter moves under their OWN power -- the
 * player's input block and the AI's movement block. Deliberately not derived
 * from a position delta: position is also mutated by clean-hit pushback,
 * minimum-distance collision separation and the between-round corner walk, none
 * of which is the fighter choosing to walk. It also accumulates `dt` rather than
 * distance, so the 15-second interval means the same thing at any frame rate --
 * comparing a per-frame distance against a fixed threshold would make the
 * effective cutoff `threshold / dt` and silently change with performance.
 *
 * A `while` rather than an `if` so one oversized frame can't bank the excess.
 */
export function accrueRingMileage(f: FighterState, dt: number): void {
  const interval = Math.max(0.1, getMaxStamConfig().ringMileageInterval);
  // updateAI can apply movement twice in one tick -- the charge-respect step-out
  // runs after the main movement pass -- and the fighter really does take two
  // steps. But this is a rule about TIME spent walking, so the same frame must
  // not be charged twice. Cleared at the top of every frame in
  // updateMovementContext, before any movement runs.
  if (f.mileageChargedThisTick) return;
  f.mileageChargedThisTick = true;
  f.movingTime = (f.movingTime ?? 0) + dt;
  while (f.movingTime >= interval) {
    f.movingTime -= interval;
    applyMaxStaminaDelta(f, maxStamAmount(f, "ringMileage"));
  }
}

function restoreMaxStamina(f: FighterState, amount: number): void {
  if (amount <= 0) return;
  // Permanent losses lower the bar a refund can lift the pool back to: the
  // bout-start pool is only the ceiling until the first one lands.
  const ceiling = Math.min(f.boutStartMaxStamina ?? f.maxStamina, f.maxStaminaHardCeiling ?? Infinity);
  const restored = Math.min(ceiling, f.maxStamina + amount);
  const gained = restored - f.maxStamina;
  if (gained <= 0) return;
  f.maxStamina = restored;
  f.maxStaminaCap = Math.min(ceiling, f.maxStaminaCap + gained);
}

/**
 * Applies a SIGNED max-stamina delta -- negative takes tank away, positive hands
 * it back.
 *
 * Every tunable pool rule goes through here rather than calling drain/restore
 * directly, because the amounts are player-editable in the tuning screen and can
 * legitimately be saved with either sign. Routing on the sign at the moment of
 * use means flipping a value from -3 to +3 turns that rule from a punishment into
 * a reward with no other code change.
 */
function applyMaxStaminaDelta(f: FighterState, delta: number, opts?: MaxStaminaDrainOpts): void {
  if (delta < 0) drainMaxStamina(f, -delta, opts);
  else if (delta > 0) restoreMaxStamina(f, delta);
}

/**
 * Which brain, if any, should hear about the outcome of this punch for Rhythm
 * Attacking. The notifications are symmetric: in a menu or auto-play bout both
 * corners are brain-driven, so the *punching* side is the one that needs to
 * know. Feints are excluded outright — a feint is meant to miss, and letting one
 * count as an avoided shot would spend a sequence the player never beat.
 */
function raBrainFor(attacker: FighterState, state: GameState) {
  if (attacker.isFeinting) return null;
  return (attacker.isPlayer ? state.playerAiBrain : state.aiBrain) ?? null;
}

function applyHit(attacker: FighterState, defender: FighterState, state: GameState): void {
  const result = tryHit(attacker, defender, state);
  // Drilled Actions: grade this punch before any of the early returns below, and
  // off the explicit flags rather than the absence of a miss. Reaching the
  // opponent is the whole test, so an ordinary block and a perfect block both
  // count; a slip, a duck-under, an evade, a whiff and a feint do not.
  noteDrilledContact(attacker, !!result.hit || !!result.blocked || !!result.isPerfectBlock, !!attacker.isFeinting);
  // 200+ sharpness: a free closing punch that makes contact pauses the burst
  // stamina-penalty count for a second.
  if (attacker.drilledPunch?.closing?.freeStamina && (result.hit || result.blocked)) {
    attacker.drilledBurstPauseTimer = DRILLED_ACTION_CONFIG.staminaPenaltyPauseSec;
  }
  // Snapshot ALL relevant state at impact, before any hit-reaction mutations (pushback, rhythm resets, etc.)
  const defRhythmProgressAtImpact = defender.rhythmProgress;
  const defSwayOffsetAtImpact     = defender.swayOffset;
  const defSwayDirAtImpact        = defender.swayDir;
  const defSwaySpeedLvAtImpact    = effectiveSwaySpeedLevel(defender);
  const defRhythmLvAtImpact       = defender.rhythmLevel;
  // Needed as a snapshot like the rest: the vulnerability windows now sit at the
  // ends of the arc, where a parked (progress 0) marker also sits, so every
  // window read has to know whether the defender was actually on their feet.
  const defRhythmWalkingAtImpact  = !!defender.rhythmWalking;
  // Fighter positions + dist at exact moment of impact (before pushback)
  const snapPlayerX  = Math.round(state.player.x);
  const snapPlayerZ  = Math.round(state.player.z);
  const snapEnemyX   = Math.round(state.enemy.x);
  const snapEnemyZ   = Math.round(state.enemy.z);
  const snapDxImpact = state.enemy.x - state.player.x;
  const snapDzImpact = state.enemy.z - state.player.z;
  const snapDistImpact = Math.round(Math.sqrt(snapDxImpact * snapDxImpact + snapDzImpact * snapDzImpact));
  const snapPStam    = Math.round(state.player.stamina);
  const snapEStam    = Math.round(state.enemy.stamina);
  if (!result.hit) {
    // Bout tally the RL trainer's reward reads: a charged punch that failed to
    // land in any way. A feint was never a real punch.
    if (attacker.isCharging && !attacker.isFeinting) {
      attacker.chargedPunchesMissed = (attacker.chargedPunchesMissed ?? 0) + 1;
    }
    if (result.isDodge) {
      state.hitEffects.push({
        x: defender.x + defender.facing * 10,
        y: defender.z - 25 + (Math.random() - 0.5) * 15,
        timer: 0.6,
        type: "normal",
        text: "DODGE",
        attackerColor: defender.colors.trunks,
      });
      if (defender.isPlayer) {
        state.roundStats.playerPunchesDodged++;
      } else {
        state.roundStats.enemyPunchesDodged++;
      }
      if (attacker.isCharging) refundForgivenChargeWhiff(attacker);
      // Reading the shot well enough to slip it sharpens the defender's turn,
      // and having one slipped moves the thrower's own delay too.
      applyTurnDelayEvent(defender, getTurnConfig().dodge);
      applyTurnDelayEvent(attacker, getTurnConfig().punchDodged);
      soundEngine.whiff();
      // Rhythm Attacking, ending 2. A slip returns here, well before the whiff
      // notifier further down, so the avoided-shot count has to be taken on this
      // path too — otherwise the most common way to beat a sequence, actually
      // slipping the shots, would never register at all.
      {
        const _raB = raBrainFor(attacker, state);
        if (_raB) notifyAiPunchAvoided(_raB);
      }
      return;
    }
    // Rhythm Attacking, ending 2: every other way a punch fails to land.
    {
      const _raB = raBrainFor(attacker, state);
      if (_raB) notifyAiPunchAvoided(_raB);
    }
    // A whiff is only a punch that could not land at all: out of range, or thrown
    // while turned too far away. Nothing else here qualifies — a slip took the
    // early return above, a duck-under or defense-stat evasion is the defender
    // avoiding a punch that could have landed, and the MISS roll is a punch that
    // could have landed and didn't. Each miss pays at most one of the two.
    if (result.isEvaded) {
      applyTurnDelayEvent(defender, getTurnConfig().dodge);
      applyTurnDelayEvent(attacker, getTurnConfig().punchDodged);
    } else if (result.isWhiff && getDistance(attacker, defender) <= WHIFF_CLOSE_RANGE_PX) {
      // Whiffed from inside the pocket: real work, so the thrower's own delay moves.
      applyTurnDelayEvent(attacker, getTurnConfig().whiffClose);
    }
    state.cleanHitStreak = 0;
    if (attacker.isPlayer) {
      state.roundStats.playerConsecutiveLanded = 0;
    }
    if (attacker.isCharging) {
      attacker.retractionPenaltyMult = Math.max(attacker.retractionPenaltyMult, 1 / CHARGE_WHIFF_RETRACT_SLOW);
      attacker.moveSlowMult = 0.40;
      attacker.moveSlowTimer = 2.0;
      attacker.regenPauseTimer = Math.max(attacker.regenPauseTimer, 1.0);
      attacker.chargeReady = false;
      attacker.chargeReadyWindowTimer = 0;
      refundForgivenChargeWhiff(attacker);
    }
    if (attacker.currentPunch && defender.isFeinting && attacker.feintWhiffPenaltyCooldown <= 0) {
      const config = getHitPunchConfig(attacker.currentPunch);
      const dist = getDistance(attacker, defender);
      const inRange = dist <= (config.range + 20) * 1.15;
      if (inRange) {
        defender.feintBaits++;
        attacker.retractionPenaltyMult = 2;
        attacker.feintWhiffPenaltyCooldown = 0.5;
        attacker.feintedTelegraphBoost = levelScale(attacker.level, 0.20, 0.05, "feintTelegraphBoost");
        attacker.telegraphFeintRoundPenalty += 0.025;
      }
    }
    if (state.aiBrain && attacker.currentPunch) {
      const config = getHitPunchConfig(attacker.currentPunch);
      const dist = getDistance(attacker, defender);
      const inRange = dist <= (config.range + 20) * 1.15;
      notifyAiPunchWhiffed(state.aiBrain, attacker.isPlayer, inRange);
      // Range-whiff learning: when the punch physically could not reach, hand the
      // AI the exact pixel shortfall so it can plan to close that gap.
      const reachPx = getPunchReachPx(attacker, attacker.currentPunch);
      if (dist > reachPx) {
        const deficitPx = dist - reachPx;
        if (!attacker.isPlayer) notifyAiRangeWhiff(state.aiBrain, attacker.currentPunch, deficitPx);
        else if (state.playerAiBrain) notifyAiRangeWhiff(state.playerAiBrain, attacker.currentPunch, deficitPx);
      }
      // Snapshot whiff context for the AI's own punch misses
      if (!attacker.isPlayer) {
        notifyAiWhiffContext(state.aiBrain, dist, defender.defenseState === "duck", defender.swaySpeedLevel);
        // RC feedback on whiff: the punch missed so record where defender's sway was
        notifyAiRcPunchResolved(state.aiBrain, defSwayOffsetAtImpact, defSwaySpeedLvAtImpact, defRhythmLvAtImpact);
      }
      if (attacker.isPlayer && state.playerAiBrain) {
        notifyAiWhiffContext(state.playerAiBrain, dist, defender.defenseState === "duck", defender.swaySpeedLevel);
      }
    }
    return;
  }
  if (result.hit) {
    // Contact squares the attacker up for good: their turn delay is cancelled
    // until the opponent lands one back on them. A block or a perfect block is
    // still contact — only a slip leaves the attacker turning the slow way.
    attacker.turnDelayCancelled = true;
    attacker.facingPendingTimer = 0;
    defender.turnDelayCancelled = false;
    // Both sides' own turn delays move on any punch that reaches the opponent,
    // on the same blocked-still-counts terms as the cancel above.
    applyTurnDelayEvent(attacker, getTurnConfig().punchLanded);
    applyTurnDelayEvent(defender, getTurnConfig().punchTaken);
    // Caught in the head mid-slip: the slip dies on the spot and cannot be
    // thrown again for a moment. A blocked shot never got through, so it is free.
    if (result.isHeadHit && !result.blocked) {
      // A head shot getting through is also the AI's only feedback on its timing,
      // and only the punch the slip was read off can grade it. Graded before the
      // slip is torn down, since the verdict reads that state.
      if (defender.slipReadAttemptTimer > 0 && attacker.punchesThrown === defender.slipReadPunchId) {
        gradeAiSlipReadTiming(defender);
      }
      if (defender.slipActive) {
        endSlip(defender);
        defender.slipDisabledTimer = Math.max(defender.slipDisabledTimer, SLIP_HEAD_HIT_DISABLE);
      }
    }
    // Every ten punches that get through wear this fighter's slip chance down for
    // the rest of the bout. An ordinary block still counts as getting through; a
    // perfect block does not.
    if (!result.isPerfectBlock) defender.slipReadHitsTaken++;
    // Energy fatigue: every punch that reaches this fighter drains Energy and
    // ends a live Reset. A perfect block is the single exception to both — it
    // is a clean read, so it costs nothing and buys the Reset time instead.
    if (!result.isPerfectBlock) {
      onPunchTaken(defender, state);
      stripResetOnHit(defender);
      // Where the opponent has been landing is what decides which way this
      // fighter's hands slide when they flinch, so the bout-long tally is taken
      // on the same shots that count as getting through.
      if (result.isHeadHit) defender.shotsTakenHead++;
      else defender.shotsTakenBody++;
      triggerFlinch(defender, attacker, state);
    }
    // A stun takes the answer to itself away for a beat, Defense deciding how
    // long. Armed here, ahead of the stun and crit reaction blocks further down
    // this same hit, so a corner's reflex Reset cannot land underneath it.
    if (result.isStun && !result.blocked) applyResetStunLock(defender);
    attacker.timeSinceLastPunch = 0; // reset on punch landed (blocked or clean)
    let rawDamage = result.damage;
    if (state.nightmareMode && !attacker.isPlayer) {
      const nmDamageSteps = Math.floor(state.nightmareTimeSurvived / 20);
      rawDamage *= 1 + nmDamageSteps * 0.15;
    }
    if (state.nightmareMode && attacker.isPlayer) {
      rawDamage *= 1 + state.nightmareKillCount * 0.10;
    }
    const staminaBefore = defender.stamina;
    // Punch Rolling and Iron Chin both take a slice off an incoming punch, and
    // the two slices add: 80% + 35% leaves the punch doing nothing rather than
    // 20% x 65%.
    const punchRollingCut = 1 - (defender.punchRollingMult != null ? defender.punchRollingMult : 1);
    const damageTakenMult = Math.max(0, 1 - (punchRollingCut + (defender.ironChinDamageReduction ?? 0)));
    const dealtDamage = rawDamage * damageTakenMult;
    defender.stamina = Math.max(1, defender.stamina - dealtDamage);
    let actualDamage = staminaBefore - defender.stamina;
    // What the judges are shown is the damage the punch did, not how far the bar
    // moved. The bar stops at 1 and recovers between punches, so crediting the
    // drop would pay nothing for a round spent beating on a gassed opponent.
    let scoredDamage = dealtDamage;
    attacker.punchesLanded++;
    attacker.timeSinceLastLanded = 0;
    defender.timeSinceLastLanded = Infinity;
    defender.timeSinceLastDamageTaken = 0;
    defender.damageTakenRegenPauseFired = false;
    attacker.unansweredStreak++;
    defender.unansweredStreak = 0;
    const actualTravelMs = attacker.punchTravelStartTime > 0 ? Math.round((gameElapsedTime - attacker.punchTravelStartTime) * 1000) : Math.round((result.punchTravelTime || 0) * 1000);
    // Life Drain: the punch pays its stamina back immediately. It fires on every
    // punch that gets through in any measure — a clean hit, and equally a punch
    // an ordinary guard (auto-guard included) merely softened, since normal block
    // reduction is capped at 95%. Only a punch stopped outright pays nothing:
    // that is the perfect block and the defense-stat auto-block behind a raised
    // guard, both of which resolve to 100% reduction.
    // Any debuff that has the attacker's regen paused still holds the skill off
    // for as long as it runs. Landing while your OWN rhythm marker sits mid-band
    // is not such a debuff: that pause was created by this punch, so measure the
    // pre-punch value instead.
    if ((result.blockReduction ?? 0) < 1) {
      const ldRhythmPause = attacker.selfRhythmSapPrevPause ?? attacker.staminaPauseFromRhythm;
      if ((attacker.lifeDrainPct ?? 0) > 0 &&
          attacker.regenPauseTimer <= 0 && ldRhythmPause <= 0) {
        const drain = Math.ceil(attacker.maxStamina * attacker.lifeDrainPct!);
        if (drain > 0) attacker.stamina = Math.min(attacker.maxStamina, attacker.stamina + drain);
      }
    }
    if (result.blocked) {
      recordEvent(state, "block", defender.isPlayer ? "player" : "enemy", {
        punch: attacker.currentPunch, damage: Math.round(actualDamage), blocked: true,
        punchTravelMs: actualTravelMs,
      });
      defender.blockFlashTimer = 0.1;
      if (result.isPerfectBlock && defender.isPlayer && attacker.rhythmLevel > 1) {
        attacker.rhythmLevel = 1;
      }
      if (result.isPerfectBlock) {
        // Bout tally the RL trainer's reward reads.
        defender.perfectBlocksMade = (defender.perfectBlocksMade ?? 0) + 1;
        attacker.moveSlowMult = Math.min(attacker.moveSlowMult, 0.50);
        attacker.moveSlowTimer = Math.max(attacker.moveSlowTimer, 0.75);
        attacker.regenPauseTimer = Math.max(attacker.regenPauseTimer, 2.0);
        // Attacker loses half the clean-hit stamina cost and has recovery paused 2s
        const _pbStamDrain = (result.cleanDamage ?? 0) * 0.5;
        attacker.stamina = Math.max(0, attacker.stamina - _pbStamDrain);
        attacker.staminaPauseFromRhythm = Math.max(attacker.staminaPauseFromRhythm, 2.0);
        // Reading the punch perfectly moves the blocker's pool -- by default the
        // one rule that hands tank back, and never past what they walked in with.
        applyMaxStaminaDelta(defender, maxStamAmount(defender, "perfectBlock"));
        applyTurnDelayEvent(defender, getTurnConfig().perfectBlock);
        // ...and for the second that follows, the blocker turns with no delay at
        // all — on top of the standing reduction the event above hands them.
        defender.turnDelayZeroTimer = Math.max(defender.turnDelayZeroTimer, PERFECT_BLOCK_TURN_ZERO_DURATION);
      }
    } else {
      attacker.cleanPunchesLanded++;
      // Accumulated punishment: every Nth clean punch a fighter takes moves their
      // pool for the rest of the fight, N and the amount both tunable.
      defender.cleanPunchesTakenFight = (defender.cleanPunchesTakenFight ?? 0) + 1;
      // The punch has already been taken off the bar above, so a defender sitting
      // at the floor here is one this punch is dropping — equipment never shrugs
      // off the pool a knockdown costs.
      const kdAttributed = defender.stamina <= 1;
      const streak = Math.max(1, Math.round(getMaxStamConfig().cleanStreakPunches));
      if (defender.cleanPunchesTakenFight % streak === 0) {
        applyMaxStaminaDelta(defender, maxStamAmount(defender, "cleanStreakTaken"), { knockdownAttributed: kdAttributed });
      }
      // On top of that running punishment, every clean punch carries its own
      // chance of moving the pool. Both can fire on the same punch -- the pool
      // watcher merges them into a single tick.
      if (Math.random() * 100 < getMaxStamConfig().cleanHitChance) {
        applyMaxStaminaDelta(defender, maxStamAmount(defender, "cleanHitTaken"), { knockdownAttributed: kdAttributed });
      }
      // A charged punch that lands a crit or a stun buys its own gas back: the
      // pool it burned going out comes back for the rest of the bout, one refund
      // whether it lands both. Pool and ceiling rise together — the mirror of the
      // drains that took them — and never past what the fighter started with.
      if (attacker.isCharging && (result.isCrit || result.isStun)) {
        applyMaxStaminaDelta(attacker, maxStamAmount(attacker, "chargedCritRefund"));
      }
      recordEvent(state, "hit", attacker.isPlayer ? "player" : "enemy", {
        punch: attacker.currentPunch, damage: Math.round(actualDamage), crit: !!result.isCrit, stun: !!result.isStun, body: !attacker.punchAimsHead,
        punchTravelMs: actualTravelMs,
      });
    }
    if (attacker.isPlayer) {
      state.roundStats.playerConsecutiveLanded++;
      if (state.roundStats.playerConsecutiveLanded >= 3) {
        state.roundStats.playerComboCount++;
      }
    } else {
      state.roundStats.playerConsecutiveLanded = 0;
    }
    const staminaRefund = attacker.currentPunchStaminaCost * 0.4;
    attacker.stamina = Math.min(attacker.maxStamina, attacker.stamina + staminaRefund);
    attacker.damageDealt += actualDamage;

    if (attacker.isPlayer && (state.careerFightMode || state.sparringMode) && !state.isQuickFight && !state.practiceMode) {
      const diffMults: Record<string, number> = { journeyman: 0.8, contender: 1.0, elite: 1.35, champion: 1.75 };
      const diffMult = diffMults[state.aiDifficulty] || 1.0;
      const levelGap = state.enemyLevel - state.playerLevel;
      const levelGapMult = Math.max(0.7, Math.min(2.0, 1 + levelGap * 0.04));
      const champFightXpMult = state.careerFightMode && state.aiDifficulty === "champion" ? 1.5 : 1.0;
      const punchXp = Math.max(1, Math.floor((8 + actualDamage * 2) * diffMult * levelGapMult * 0.7 * champFightXpMult));
      checkMidFightLevelUp(state, punchXp);
    }

    if (attacker.isCharging) {
      attacker.chargeReady = false;
      attacker.chargeReadyWindowTimer = 0;
      attacker.regenPauseTimer = Math.max(attacker.regenPauseTimer, CHARGE_SELF_REGEN_PAUSE);
      attacker.consecutiveChargeCount++;
      attacker.consecutiveChargeTimer = CHARGE_CONSECUTIVE_WINDOW;
      if (!result.blocked) {
        const chargeFacingLock = 0.5 - defender.focusT * 0.3;
        defender.facingLockTimer += chargeFacingLock;
      }
    }

    defender.isHit = true;
    defender.hitTimer = 0.15;
    if (!result.blocked) {
      defender.cleanHitEyeTimer = 0.2;
      const facingLockBase = 0.4 - defender.focusT * 0.36;
      defender.facingLockTimer += facingLockBase;
      if (defender.isBlinking) {
        defender.rhythmLevel = 2;
        defender.rhythmProgress = 0;
      }
      // Rhythm vulnerability zone hit: 30% chance to stack +1% crit vulnerability (cap 55%, whole fight)
      if (result.isRhythmVulnHit && Math.random() < 0.30) {
        defender.rhythmCritVulnStack = Math.min(0.55, (defender.rhythmCritVulnStack ?? 0) + 0.01);
      }
    }

    // Outside the chargeArmed guard on purpose: the last use of a charge
    // disarms at throw time, so a punch can still be in flight with the fighter
    // showing no armed charge. Burning the refunds here is what stops that
    // punch from re-arming the charge this hit just took away.
    defender.chargeWhiffForgivenessLeft = 0;
    if (defender.chargeArmed) {
      defender.chargeArmed = false;
      defender.chargeUsesLeft = 0;
      defender.chargeArmTimer = 0;
      defender.chargeMeterBars = Math.max(0, defender.chargeMeterBars - 1);
    }

    const defenderRhythmBuffs = getRhythmBuffs(defender);
    const _stamStat = Math.max(0, Math.min(1000, defender.rawStamina ?? 0));
    const basePause = _stamStat <= 200
      ? 3 - 2 * (_stamStat / 200)
      : 1 - (_stamStat - 200) / 800;
    const rhythmPause = defender.defenseState === "duck" ? 0 : defenderRhythmBuffs.hitStaminaPauseDuration;
    if (basePause > 0) defender.regenPauseTimer = Math.max(defender.regenPauseTimer, basePause);
    if (rhythmPause > 0) {
      defender.staminaPauseFromRhythm = Math.max(defender.staminaPauseFromRhythm, rhythmPause);
    }

    if (result.isCrit && !result.blocked) {
      applyTurnDelayEvent(defender, getTurnConfig().critTaken);
      defender.regenPauseTimer = Math.max(defender.regenPauseTimer, CRIT_REGEN_PAUSE);
      defender.moveSlowMult = CRIT_MOVE_SLOW_MULT;
      defender.moveSlowTimer = Math.max(defender.moveSlowTimer, CRIT_MOVE_SLOW_DURATION);
      defender.critHitTimer = 0.15;
      aiMaybeReset(defender, state);
      if (!defender.isPlayer && state.aiBrain) {
        notifyAiStunOrCrit(state.aiBrain, defender, attacker.focusT);
      }
      if (defender.isPlayer && state.aiBrain) {
        notifyAiPlayerStunned(state.aiBrain);
      }
      if (defender.isPlayer && state.playerAiBrain) {
        notifyAiStunOrCrit(state.playerAiBrain, defender, attacker.focusT);
      }
    }

    if (result.isStun && !result.blocked) {
      applyStunEffects(defender);
      // Getting stunned can freeze the AI's timing adaptation for the rest of the round (30%)
      if (!defender.isPlayer && state.aiBrain) notifyAiStunned(state.aiBrain);
      if (defender.isPlayer && state.playerAiBrain) notifyAiStunned(state.playerAiBrain);
      const stunFacingLock = 0.5 - defender.focusT * 0.3;
      defender.facingLockTimer += stunFacingLock;
      const rawSlowDuration = 3.0 - 1.0 * defender.focusT;
      const slowDuration = Math.max(0, rawSlowDuration - (defender.ironChinStunSlowReduction ?? 0));
      if (slowDuration > 0) {
        defender.stunFacingSlowTimer = Math.max(defender.stunFacingSlowTimer, slowDuration);
        defender.stunFacingTurnDelay = Math.max(defender.stunFacingTurnDelay, 0.50 - 0.25 * defender.focusT);
      }
      // Stun deliberately leaves the duck alone. Every other posture the stun
      // touches is slowed or disabled, but ducking out of a follow-up stays
      // available: it is the one answer a stunned fighter always has.
      // ...and the feet stop dead for a beat.
      defender.stunMoveFreezeTimer = Math.max(defender.stunMoveFreezeTimer, STUN_MOVE_FREEZE_DURATION);
      // A stun moves the pool outright -- no roll, unlike the clean-hit slice
      // that already fired for this same punch.
      applyMaxStaminaDelta(defender, maxStamAmount(defender, "stunTaken"), { knockdownAttributed: defender.stamina <= 1 });
      // Rhythm Attacking: a stun opens a sequence just like a timed cut does,
      // but only once per chain -- see notifyAiStunLanded.
      notifyAiStunLanded(raBrainFor(attacker, state));
      aiMaybeReset(defender, state);
      if (!defender.isPlayer && state.aiBrain) {
        notifyAiStunOrCrit(state.aiBrain, defender, attacker.focusT);
      }
      if (defender.isPlayer && state.aiBrain) {
        notifyAiPlayerStunned(state.aiBrain);
      }
      if (defender.isPlayer && state.playerAiBrain) {
        notifyAiStunOrCrit(state.playerAiBrain, defender, attacker.focusT);
      }
    }

    // KD-chance degradation: in non-practice QF, career, and doghouse modes,
    // each clean crit on the AI costs 1% get-up chance for KD1-3;
    // each clean stun costs an additional 0.5% on top of any crit penalty.
    if (!defender.isPlayer && !result.blocked &&
        ((state.isQuickFight && !state.practiceMode && !state.sparringMode) || state.careerFightMode || state.doghouseMode)) {
      if (result.isCrit) state.aiKdChancePenalty += 0.01;
      if (result.isStun) state.aiKdChancePenalty += 0.005;
    }

    // Stun → dodge rate penalty (persists fight, capped at 10% total).
    // AI hit with stun: 50% chance to lose 2% dodge rate.
    // Player hit with stun: 25% chance to lose 2% dodge rate.
    if (result.isStun && !result.blocked) {
      const stunDodgePenaltyChance = defender.isPlayer ? 0.25 : 0.30;
      if (Math.random() < stunDodgePenaltyChance) {
        defender.dodgePenalty = Math.min((defender.dodgePenalty ?? 0) + 0.02, 0.10);
      }
    }

    if (result.blocked) {
      defender.blockRegenPenaltyTimer = defender.blockRegenPenaltyDuration;
      if (defender.isPlayer) {
        state.roundStats.playerPunchesBlocked++;
        if (state.tutorialMode) {
          state.tutorialTracking.punchesBlocked++;
          if (result.isPerfectBlock) {
            state.tutorialTracking.perfectBlockCount++;
          }
        }
      } else {
        state.roundStats.enemyPunchesBlocked++;
      }
    }

    if (defender.rhythmLevel > 0 && !result.blocked) {
      if (defender.rhythmProgress < 0.9) {
        const pushDist = 8 + Math.random() * 7;
        const dx = defender.x - attacker.x;
        const dz = defender.z - attacker.z;
        const len = Math.sqrt(dx * dx + dz * dz);
        if (len > 0.01) {
          const pushSpeed = pushDist / 0.12;
          defender.pushbackVx = (dx / len) * pushSpeed;
          defender.pushbackVz = (dz / len) * pushSpeed;
        }
      }
      defender.rhythmProgress = 0;
      defender.rhythmDirection = 1;
    }
    if (defender.rhythmLevel === 0 && defender.stance !== "neutral") {
      defender.stance = "neutral";
    }

    if (attacker.isPlayer) {
      state.roundStats.playerDamageThisRound += scoredDamage;
      state.roundStats.playerActualDamageThisRound += actualDamage;
      state.roundStats.playerLandedThisRound++;
    } else {
      state.roundStats.enemyDamageThisRound += scoredDamage;
      state.roundStats.enemyActualDamageThisRound += actualDamage;
      state.roundStats.enemyLandedThisRound++;
    }

    {
      const defBrain = defender.isPlayer ? state.playerAiBrain : state.aiBrain;
      if (defBrain && !result.blocked) {
        const zone: "head" | "body" = attacker.punchAimsHead ? "head" : "body";
        defBrain.guardConditioningMemory.push({ zone, damage: actualDamage, time: defBrain.gameTime });
        if (defBrain.guardConditioningMemory.length > defBrain.guardConditioningMax) {
          defBrain.guardConditioningMemory.shift();
        }
      }
    }

    if (attacker.chargeMeterLockoutTimer <= 0) {
      // Gains are % of total 600-unit system; divide by 6 to get per-bar units (each bar = 100)
      let meterGain = result.blocked ? 5 / 6 : result.isCrit ? 20 / 6 : 10 / 6;
      const _astT = Math.max(0, Math.min(1, (attacker.rawStamina - 1) / 199));
      meterGain *= 1.02 + _astT * 2.98;
      if (attacker.isPlayer && state.careerFightMode) meterGain *= 2;
      if (!attacker.isPlayer) {
        const aiChargeMult =
          state.aiDifficulty === "champion" ? 4.5 :
          state.aiDifficulty === "elite" ? 3.0 :
          state.aiDifficulty === "contender" ? 2.0 : 1.0;
        meterGain *= aiChargeMult;
      }
      attacker.chargeMeterCounters += meterGain;
      while (attacker.chargeMeterCounters >= 100 && attacker.chargeMeterBars < 6) {
        attacker.chargeMeterCounters -= 100;
        attacker.chargeMeterBars++;
      }
      if (attacker.chargeMeterBars >= 6) attacker.chargeMeterCounters = 0;
    }
    if (defender.chargeMeterLockoutTimer <= 0) {
      let defMeterGain = result.blocked ? 5 / 6 : result.isCrit ? 15 / 6 : 10 / 6;
      const _dstT = Math.max(0, Math.min(1, (defender.rawStamina - 1) / 199));
      defMeterGain *= 1.02 + _dstT * 2.98;
      if (defender.isPlayer && state.careerFightMode) defMeterGain *= 2;
      if (!defender.isPlayer) {
        const aiChargeMult =
          state.aiDifficulty === "champion" ? 4.5 :
          state.aiDifficulty === "elite" ? 3.0 :
          state.aiDifficulty === "contender" ? 2.0 : 1.0;
        defMeterGain *= aiChargeMult;
      }
      defender.chargeMeterCounters += defMeterGain;
      while (defender.chargeMeterCounters >= 100 && defender.chargeMeterBars < 6) {
        defender.chargeMeterCounters -= 100;
        defender.chargeMeterBars++;
      }
      if (defender.chargeMeterBars >= 6) defender.chargeMeterCounters = 0;
    }

    if (!result.blocked) {
      const pushAngle = attacker.facingAngle;
      const pushAmount = Math.min(12, actualDamage * 0.3);
      defender.x += Math.cos(pushAngle) * pushAmount;
      defender.z += Math.sin(pushAngle) * pushAmount;
      clampToDiamond(defender);

      const defSwayNorm = Math.abs(defender.swayOffset) / 5;
      const defLeavingFoot = defender.swayDir * defender.swayOffset < 0;
      const defIsOffBalance = defender.swaySpeedLevel > 0 && !defender.swayFrozen
        && defSwayNorm >= 0.1 && defSwayNorm < 0.9 && defLeavingFoot;
      if (defIsOffBalance) {
        const levelDisc = attacker.level - defender.level;
        const miniStunChance = Math.max(0, Math.min(0.9, 0.25 + levelGapAdj("gapMiniStun", levelDisc) + defender.level * 0.001));
        if (Math.random() < miniStunChance) {
          const slideAngle = attacker.facingAngle;
          const oldX = defender.x;
          const oldZ = defender.z;
          defender.x += Math.cos(slideAngle) * 5;
          defender.z += Math.sin(slideAngle) * 5;
          clampToDiamond(defender);
          const slid = Math.sqrt((defender.x - oldX) ** 2 + (defender.z - oldZ) ** 2);
          if (slid < 5) {
            defender.x = oldX + Math.cos(slideAngle) * slid;
            defender.z = oldZ + Math.sin(slideAngle) * slid;
            clampToDiamond(defender);
          }

          defender.miniStunTimer = 0.75;
          const bonusDmg = actualDamage * 0.2;
          const staminaBeforeMiniStun = defender.stamina;
          defender.stamina = Math.max(1, defender.stamina - bonusDmg);
          const miniStunActual = staminaBeforeMiniStun - defender.stamina;
          actualDamage += miniStunActual;
          attacker.damageDealt += miniStunActual;
          if (attacker.isPlayer) {
            state.roundStats.playerDamageThisRound += bonusDmg;
            state.roundStats.playerActualDamageThisRound += miniStunActual;
          } else {
            state.roundStats.enemyDamageThisRound += bonusDmg;
            state.roundStats.enemyActualDamageThisRound += miniStunActual;
          }

          defender.swayOffset = defender.swayDir * 5;
          // Freezing the marker is now the exception, not the rule: the punch
          // has to have landed in the defender's vulnerability zone, and the
          // roll has to come in. Outside the zone a stun never pauses rhythm.
          if (result.isRhythmVulnHit && Math.random() < STUN_RHYTHM_PAUSE_CHANCE) {
            defender.rhythmPauseTimer = 0.25;
          }

          if (!defender.isPlayer && state.aiBrain) notifyAiStunOrCrit(state.aiBrain, defender);
          if (defender.isPlayer && state.playerAiBrain) notifyAiStunOrCrit(state.playerAiBrain, defender);

          if (!defender.isPlayer && state.aiBrain) notifyAiRangeDisrupt(state.aiBrain);
          if (defender.isPlayer && state.playerAiBrain) notifyAiRangeDisrupt(state.playerAiBrain);
        }
      }
    }

    state.shakeIntensity = result.blocked ? 2 : Math.min(8, actualDamage * 0.4);
    state.shakeTimer = 0.15;

    const effectType = result.blocked ? (result.isPerfectBlock ? "perfectBlock" : "block") : (result.isStun || result.isCrit ? "crit" : (actualDamage > 20 ? "crit" : "normal"));
    const effectText = result.blocked
      ? (result.isPerfectBlock ? "BLOCK" : Math.round(actualDamage).toString())
      : (result.isStun && result.isCrit ? "CRIT STUN!" : (result.isStun ? "STUN!" : (result.isCrit ? "CRIT!" : Math.round(actualDamage).toString())));
    state.hitEffects.push({
      x: defender.x + defender.facing * 10,
      y: defender.z - 25 + (Math.random() - 0.5) * 15,
      timer: 0.6,
      type: effectType,
      text: effectText,
      attackerColor: result.blocked ? defender.colors.trunks : attacker.colors.trunks,
      stunOrCrit: !result.blocked && (!!result.isStun || !!result.isCrit),
    });

    const hasCrowd = !state.practiceMode && !state.sparringMode;
    const canCheer = hasCrowd && (attacker.isPlayer || state.cpuVsCpu);
    const pSound = toPunchSound(attacker.currentPunch);
    const isP = attacker.isPlayer;

    if (result.blocked) {
      soundEngine.punchLandBlocked(pSound, isP);
      state.cleanHitStreak = 0;
    } else if (attacker.isCharging) {
      soundEngine.chargePunchLand(pSound, isP);
      // Gym work toward the sway's damage buy-back. Blocked charges are handled
      // in the branch above and never reach here, which is what "landed" means.
      if (attacker.fatigue) attacker.fatigue.gymChargeLanded++;
      if (hasCrowd) soundEngine.crowdOoh(0.5);
      const punchName = attacker.currentPunch || "jab";
      const hitstopDur = punchName === "jab" ? 0.1 : punchName === "cross" ? 0.15 : (punchName.includes("Hook") ? 0.18 : 0.2);
      state.hitstopTimer = hitstopDur;
      state.hitstopDuration = hitstopDur;
      state.shakeIntensity = Math.min(12, actualDamage * 0.6);
      state.shakeTimer = hitstopDur + 0.1;
      state.cleanHitStreak = 1;
      if (canCheer) soundEngine.playCheer(1);
      // Pressure Fighter: chance to trigger Rhythm Cut on the defender.
      // Footwork Laces give the player a chance to make that cut fail outright.
      const lacesSave = defender.isPlayer && state.itemRhythmCutFailChance > 0
        && Math.random() < state.itemRhythmCutFailChance;
      if ((attacker.pressureRhythmCutChance ?? 0) > 0 && !lacesSave && Math.random() < attacker.pressureRhythmCutChance!) {
        if (defender.rhythmLevel > 0) defender.rhythmLevel = 2;
        defender.rhythmCutMult = attacker.pressureRhythmCutMult ?? 0.40;
        defender.rhythmCutTimer = 0;
        defender.rhythmCutPending = true;
      }
    } else if (result.isStun && result.isCrit) {
      soundEngine.stunLand(pSound, isP);
      if (hasCrowd) soundEngine.crowdOoh(0.5);
      state.cleanHitStreak = 1;
      if (canCheer) soundEngine.playCheer(1);
    } else if (result.isStun) {
      soundEngine.stunLand(pSound, isP);
      if (hasCrowd) soundEngine.crowdOoh(0.5);
      state.cleanHitStreak = 1;
      if (canCheer) soundEngine.playCheer(1);
    } else if (result.isCrit) {
      soundEngine.critLand(pSound, isP);
      if (hasCrowd) soundEngine.crowdOoh(0.5);
      state.cleanHitStreak = 1;
      if (canCheer) soundEngine.playCheer(1);
    } else {
      soundEngine.punchLandClean(pSound, isP);
      state.cleanHitStreak++;
      if (canCheer && state.cleanHitStreak >= 2) {
        soundEngine.playCheer(state.cleanHitStreak >= 3 ? 3 : 2);
      }
    }

    const punchName = attacker.currentPunch || "jab";
    const isJab = punchName === "jab";
    const jabExciting = attacker.isCharging || result.isCrit || result.isStun;
    if (!result.blocked && hasCrowd && (!isJab || jabExciting)) {
      state.crowdExciteTimer = 3.0;
      soundEngine.crowdSurge();
    }

    if (defender.stance === "frontFoot" && !result.blocked) {
      attacker.speedBoostTimer = 2.0;
    }

    if (state.aiBrain) {
      const config = getEffectivePunchConfig(attacker.currentPunch!);
      const hitHead = config.hitsHead && !isDuckLive(defender);
      const isPlayerPunch = attacker.isPlayer;
      notifyAiHitLanded(state.aiBrain, isPlayerPunch, hitHead, isPlayerPunch ? undefined : (attacker.currentPunch ?? undefined));
      if (result.blocked) {
        notifyAiBlockContact(state.aiBrain, true);
        // Blocked = unclean hit; snapshot context for whiff learning (only for AI's punch)
        if (!isPlayerPunch) {
          const bDist = getDistance(attacker, defender);
          notifyAiWhiffContext(state.aiBrain, bDist, defender.defenseState === "duck", defSwaySpeedLvAtImpact);
          notifyAiRcPunchResolved(state.aiBrain, defSwayOffsetAtImpact, defSwaySpeedLvAtImpact, defRhythmLvAtImpact);
        }
      } else if (!isPlayerPunch) {
        // Clean hit by AI — RC feedback with actual landing position (use pre-impact snapshot)
        notifyAiRcPunchResolved(state.aiBrain, defSwayOffsetAtImpact, defSwaySpeedLvAtImpact, defRhythmLvAtImpact);
        // AI clean-hit streak: accumulate for stance switch
        if (!result.blocked) {
          state.aiBrain.stanceCleanHitStreak = (state.aiBrain.stanceCleanHitStreak || 0) + 1;
          if (state.aiBrain.stanceCleanHitStreak >= (state.aiBrain.stanceCleanStreakTriggers || 3) &&
              (state.aiBrain.stanceSwitchTimer || 0) <= 0) {
            const diffMult = state.aiDifficulty === "champion" ? 0.30 : state.aiDifficulty === "elite" ? 0.18 : state.aiDifficulty === "contender" ? 0.08 : 0.02;
            if (Math.random() < (state.aiBrain.stanceSwitchChance || 0.15) * diffMult * 5) {
              attacker.boxingStance = attacker.boxingStance === "orthodox" ? "southpaw" : "orthodox";
              state.aiBrain.stanceSwitchTimer = state.aiBrain.stanceSwitchDuration || 20;
              state.aiBrain.stanceCleanHitStreak = 0;
              state.hitEffects.push({
                x: attacker.x,
                y: attacker.z - 35,
                timer: 0.8,
                type: "normal",
                text: "SWITCH",
                attackerColor: attacker.colors.gloves,
              });
            }
          }
        }
      }
      // Crit or stun against the AI: roll escalating chance to forget learnt range
      if (isPlayerPunch && !result.blocked && (result.isCrit || result.isStun)) {
        notifyAiRangeDisrupt(state.aiBrain);
      }
    }
    // Rhythm Attacking, ending 1. Only a *perfect* block counts: eating ordinary
    // blocks is not the player beating the sequence, it is the sequence working.
    // Read straight off the result rather than inferred from the block notifier
    // above, which fires for both corners and cannot tell the two apart.
    if (result.blocked && result.isPerfectBlock) {
      const _raB = raBrainFor(attacker, state);
      if (_raB) notifyAiPunchPerfectBlocked(_raB);
    }
    // BIG SHOT: set below when a charged punch crits, stuns AND lands as a
    // rhythm cut all at once. That punch drops the defender outright, whatever
    // stamina they had left.
    let bigShotKd = false;
    let wasRhythmCut = false;
    // RhythmCutHit: clean punch while the defender is in the vulnerable rhythm
    // window — the outer 5% at each end of the arc (≤5% or ≥95%).
    // Always: pause the defender's sway rhythm for 0.5 s (stacking, capped at 2.5 s).
    // When recording: log the event with pre-impact snapshots for all fields.
    if (!result.blocked && defSwaySpeedLvAtImpact > 0 && defRhythmWalkingAtImpact) {
      const rp = defRhythmProgressAtImpact;
      if (isInRhythmVulnWindow(rp, RHYTHM_CUT_VULN_HALF)) {
        wasRhythmCut = true;
        // Rhythm pause: freeze the defender's sway in place for 0.5 s per landed RC punch (stacks)
        defender.rhythmPauseTimer = Math.min(2.5, defender.rhythmPauseTimer + 0.5);
        attacker.rhythmCutHitsLanded = (attacker.rhythmCutHitsLanded || 0) + 1;
        // Cutting a man's rhythm takes gas out of his tank too: 1% of the pool
        // he walked into the bout with per landed cut, and never more than half
        // that pool across the whole fight. Only what the drain actually takes
        // is booked, so a shrugged-off loss doesn't eat into the allowance.
        // Switching the cap off means uncapped, not capped at nothing.
        const rcRoom = isMaxStamEnabled(getMaxStamConfig(), "rhythmCutFightCap")
          ? Math.abs(maxStamAmount(defender, "rhythmCutFightCap")) - (defender.rhythmCutPoolLost ?? 0)
          : Infinity;
        const rcAmount = maxStamAmount(defender, "rhythmCutHit");
        if (rcRoom > 0 && rcAmount < 0) {
          // Kept fractional on purpose: rounding the step down would quietly
          // charge less than the configured amount on most pools and stretch the
          // cap past the number of cuts it is meant to allow.
          const rcStep = Math.min(-rcAmount, rcRoom);
          defender.rhythmCutPoolLost = (defender.rhythmCutPoolLost ?? 0)
            + drainMaxStamina(defender, rcStep, { knockdownAttributed: defender.stamina <= 1 });
        } else if (rcAmount > 0) {
          // Flipped positive, the cut hands tank back instead — a refund is not
          // a loss, so the bout cap has nothing to say about it.
          applyMaxStaminaDelta(defender, rcAmount);
        }
        // The one punch that has everything: charged, critical, stunning and cut
        // straight through the rhythm. Even then it only lands as a Big Shot on
        // the BIG_SHOT_BASE_CHANCE roll, and never in gym sparring — Nightmare
        // and the Doghouse are their own modes and keep it.
        //
        // Once it does fire it's an automatic knockdown, unless the defender
        // rolls with it. Punch Rolling hands out a negate chance (10% at level 1
        // up to 20% at level 100) and the Mouthguard a second (20% at level 1 up
        // to 55% at level 150); the two stack. On a successful roll the punch
        // still lands for its full multiplied damage, it just doesn't put the
        // defender down on the spot.
        const gymSparring = state.sparringMode && !state.doghouseMode && !state.nightmareMode;
        if (result.isCrit && result.isStun && attacker.isCharging && !state.practiceMode
            && !gymSparring && Math.random() < BIG_SHOT_BASE_CHANCE) {
          const bigShotNegate = Math.min(1, Math.max(0,
            (defender.punchRollingBigShotNegate ?? 0) + (defender.equipmentBigShotNegate ?? 0)));
          if (bigShotNegate > 0 && Math.random() < bigShotNegate) {
            recordEvent(state, "dodge", defender.isPlayer ? "player" : "enemy",
              { note: "Rolled with it — Big Shot knockdown negated" });
          } else {
            bigShotKd = true;
            state.bigShotTextTimer = BIG_SHOT_TEXT_DURATION;
            state.shakeIntensity = 20;
            state.shakeTimer = 0.7;
          }
        }
        // Charge bar drain: log-linear chance based on defender level
        // 50% at level 1, 10% at level 100, 1% at level 1000
        if (defender.chargeMeterBars > 0) {
          const _rcLvl = Math.max(1, defender.level);
          const _drainChance = _rcLvl <= 100
            ? 0.50 * Math.pow(0.2, (_rcLvl - 1) / 99)
            : 0.10 * Math.pow(0.1, (_rcLvl - 100) / 900);
          if (Math.random() < _drainChance) {
            defender.chargeMeterBars = 0;
            defender.chargeMeterCounters = 0;
            // See the opponent-hit strip: cleared outside the guard so a
            // charged punch already in flight cannot refund the drained meter.
            defender.chargeWhiffForgivenessLeft = 0;
            if (defender.chargeArmed) {
              defender.chargeArmed = false;
              defender.chargeUsesLeft = 0;
              defender.chargeArmTimer = 0;
            }
            if (state.aiBrain && !defender.isPlayer) {
              state.aiBrain.aiChargeTargetBars = 0;
              state.aiBrain.aiChargeArmDelayTimer = 0;
            }
          }
        }
        if (state.recordInputs && state.inputRecording) {
          const rcRound = state.inputRecording.rounds[state.inputRecording.rounds.length - 1];
          if (rcRound) {
            const bobSpeed = Math.max(1.0, defRhythmLvAtImpact * 0.8 + 1.0);
            const swayRate = (20.0 / 3.0) * defSwaySpeedLvAtImpact * bobSpeed * 0.5;
            const msOff = swayRate > 0.01 ? Math.round((defSwayOffsetAtImpact / swayRate) * 1000) : 0;
            rcRound.events.push({
              t: Math.round(roundRecordingElapsed * 1000 * 10) / 10,
              type: "rhythmCutHit",
              actor: attacker.isPlayer ? "player" : "enemy",
              data: {
                punch: attacker.currentPunch,
                rhythmPct: Math.round(rp * 1000) / 10,
                vulHalfPct: RHYTHM_CUT_VULN_HALF * 100,
                swayOffset: Math.round(defSwayOffsetAtImpact * 100) / 100,
                swayDir: defSwayDirAtImpact,
                swaySpeedLv: defSwaySpeedLvAtImpact,
                rhythmLv: defRhythmLvAtImpact,
                msOff,
              },
              px: snapPlayerX, pz: snapPlayerZ,
              ex: snapEnemyX,  ez: snapEnemyZ,
              dist: snapDistImpact,
              pStam: snapPStam, eStam: snapEStam,
            });
          }
        }
      }
    }
    // Rhythm Attacking: the trigger, and the thing that breaks its chain streak.
    // A timed cut opens a sequence (or extends the consecutive-cut run that buys
    // the end-of-sequence chain roll); any other clean landing breaks that run.
    // Blocked punches are neither — they are handled by the perfect-block path.
    if (!result.blocked) {
      const _raB = raBrainFor(attacker, state);
      if (_raB) {
        if (wasRhythmCut) notifyAiRhythmCutLanded(_raB);
        else notifyAiCleanHitNotRhythmCut(_raB);
      }
    }
    // CPU-vs-CPU: disrupt player AI's learnt range if they got crit/stunned
    if (state.playerAiBrain && !attacker.isPlayer && !result.blocked && (result.isCrit || result.isStun)) {
      notifyAiRangeDisrupt(state.playerAiBrain);
    }

    // 2088 Mouthguard: the player shrugs the knockdown off and stays upright.
    // Checked before every KD branch so it covers career, sparring and doghouse.
    if (defender.stamina <= 1 && !bigShotKd && defender.isPlayer && state.itemKdAvoidChance > 0
        && !state.practiceMode && Math.random() < state.itemKdAvoidChance) {
      defender.stamina = Math.max(defender.stamina, Math.min(defender.maxStamina, defender.maxStamina * 0.08));
      recordEvent(state, "dodge", "player", { note: "2088 Mouthguard — knockdown avoided" });
    }
    // Same save for an AI opponent carrying the item out of Item Distribution.
    if (defender.stamina <= 1 && !bigShotKd && !defender.isPlayer && (state.opponentItemKdAvoidChance ?? 0) > 0
        && !state.practiceMode && Math.random() < state.opponentItemKdAvoidChance) {
      defender.stamina = Math.max(defender.stamina, Math.min(defender.maxStamina, defender.maxStamina * 0.08));
      recordEvent(state, "dodge", "enemy", { note: "2088 Mouthguard — knockdown avoided" });
    }

    if ((defender.stamina <= 1 || bigShotKd) && state.nightmareMode && !defender.isPlayer) {
      state.nightmareEnemyDefeated = true;
      defender.isPunching = false;
      defender.currentPunch = null;
      defender.punchPhase = null;
      defender.isCharging = false;
      defender.isFeinting = false;
      return;
    }

    if ((defender.stamina <= 1 || bigShotKd) && state.sparringMode && !state.doghouseMode && !(state.nightmareMode && defender.isPlayer) && !(state.tutorialMode && !state.tutorialFightUnlocked)) {
      defender.isKnockedDown = true;
      // Nothing spans a knockdown: not the combination in progress, not the
      // string waiting on its closer, not the dodge window one just opened. The
      // per-tick pass is skipped while the count runs, so this cannot be left to it.
      resetDrilledForBreak(state);
      // The count is not slip time: the global timer pass is skipped while the
      // knockdown branch returns early, so a slip caught by a body shot would
      // otherwise still be running — window and all — when the fighter gets up.
      endSlip(defender);
      cancelPendingSlip(defender);
      defender.slipDisabledTimer = 0;
      defender.slipChainTimer = 0;
      defender.slipChainCount = 0;
      defender.slipLean = 0;
      defender.knockdowns++;
      attacker.knockdownsGiven++;
      if (attacker.isPlayer && (state.careerFightMode || state.sparringMode) && !state.isQuickFight && !state.practiceMode) {
        checkMidFightLevelUp(state, 80);
      }
      applyTurnDelayEvent(defender, getTurnConfig().knockdownTaken);
      state.kdSequence.push(defender.isPlayer ? "player" : "enemy");
      if (defender.isPlayer) {
        state.roundStats.enemyKDsThisRound++;
        if (state.playerAiBrain) notifyAiKnockedDown(state.playerAiBrain);
      } else {
        state.roundStats.playerKDsThisRound++;
        state.totalEnemyKDs++;
        if (state.aiBrain) notifyAiKnockedDown(state.aiBrain);
      }
      for (const f of [state.player, state.enemy]) {
        f.isPunching = false;
        f.currentPunch = null;
        f.punchPhase = null;
        f.punchPhaseTimer = 0;
        f.punchCooldown = 0;
        f.punchProgress = 0;
        f.isFeinting = false;
        f.isCharging = false;
        f.defenseState = "none";
        f.telegraphPhase = "none";
        f.telegraphTimer = 0;
        f.telegraphIsLockout = false;
        f.postPunchLockoutTimer = 0;
        f.postPunchLockoutDuration = 0;
        f.pendingPunchInput = null;
        f.pendingPunchInputTimer = 0;
      }
      finalizeRoundRecording(state);
      const sparRoundScore = scoreRound(state);
      state.roundScores.push(sparRoundScore);
      rollNextRingCanvasColor();
      state.phase = "fightEnd";
      state.knockdownActive = true;
      state.fightTotalDuckDodges += state.roundStats.playerDuckDodges;
      state.fightTotalCombos += state.roundStats.playerComboCount;
      // The knockdown is what ends the session, so it decides it: whoever went
      // down loses, however the volume/damage tally looked up to that point.
      // (A sparring session that runs to the final bell is still scored.)
      state.fightResult = "Decision";
      state.fightWinner = defender.isPlayer ? "enemy" : "player";
      state.xpGained = calculateXP(state);
      state.refereeVisible = false;
      return;
    } else if ((defender.stamina <= 1 || bigShotKd) && !state.practiceMode && (!state.sparringMode || state.doghouseMode || (state.nightmareMode && defender.isPlayer)) && !(state.tutorialMode && !state.tutorialFightUnlocked)) {
      // A Big Shot drops them whatever was left in the tank, so empty it here.
      // Every other knockdown starts from an exhausted bar and the count plays
      // out the same way, so a Big Shot leaving the bar half full read as a
      // bug. Covers every bout that gets a real ref count — career, Doghouse
      // and the Nightmare player. Beating the count still hands back the
      // per-knockdown share of the pool (see the get-up path).
      if (bigShotKd) defender.stamina = 0;
      soundEngine.knockdown();
      soundEngine.crowdCheer(0.5);
      soundEngine.playCheer(1);
      defender.isKnockedDown = true;
      // Same as the sparring knockdown above: drilling stops dead at the count.
      resetDrilledForBreak(state);
      // The count is not slip time: the global timer pass is skipped while the
      // knockdown branch returns early, so a slip caught by a body shot would
      // otherwise still be running — window and all — when the fighter gets up.
      endSlip(defender);
      cancelPendingSlip(defender);
      defender.slipDisabledTimer = 0;
      defender.slipChainTimer = 0;
      defender.slipChainCount = 0;
      defender.slipLean = 0;
      defender.knockdowns++;
      attacker.knockdownsGiven++;
      if (attacker.isPlayer && (state.careerFightMode || state.sparringMode) && !state.isQuickFight && !state.practiceMode) {
        checkMidFightLevelUp(state, 80);
      }
      applyTurnDelayEvent(defender, getTurnConfig().knockdownTaken);
      attacker.kdRegenBoostActive = true;
      defender.telegraphKdMult *= 1.2;
      state.crowdKdBounceTimer = 10 + Math.random() * 10;
      state.kdSequence.push(defender.isPlayer ? "player" : "enemy");
      recordEvent(state, "knockdown", attacker.isPlayer ? "player" : "enemy", {
        punch: attacker.currentPunch, defenderStamina: Math.round(defender.stamina), kdCount: defender.knockdowns,
      });
      if (defender.isPlayer) {
        state.roundStats.enemyKDsThisRound++;
        if (state.playerAiBrain) notifyAiKnockedDown(state.playerAiBrain);
      } else {
        state.roundStats.playerKDsThisRound++;
        state.totalEnemyKDs++;
        if (state.aiBrain) notifyAiKnockedDown(state.aiBrain);
      }
      state.knockdownActive = true;
      state.knockdownMashCount = 0;
      state.knockdownMashTimer = 10.0;
      state.knockdownRefCount = 0;
      state.knockdownCountdown = 0;
      state.kdTimerExpired = false;
      state.kdEarlyStopCheckedCount = 0;
      // Every knockdown plays the fall animation into the sprawled lying
      // pose; the ref count only starts once the fall finishes.
      state.kdFallTimer = 0;

      const isBodyShot = !attacker.punchAimsHead;
      state.kdIsBodyShot = isBodyShot;
      state.kdTakeKnee = false;
      state.kdFaceRefActive = false;
      state.kdFaceRefTimer = 0;

      const kdCount = defender.knockdowns;
      if (kdCount >= 3 && !state.practiceMode && state.doghouseMode && defender.isPlayer) {
        finalizeRoundRecording(state);
        rollNextRingCanvasColor();
        state.phase = "fightEnd";
        state.fightResult = "TKO";
        state.fightWinner = "enemy";
        state.fightTotalDuckDodges += state.roundStats.playerDuckDodges;
        state.fightTotalCombos += state.roundStats.playerComboCount;
        state.xpGained = calculateXP(state);
        state.refereeVisible = false;
      } else if (kdCount >= 2 && !state.practiceMode && state.doghouseMode && !defender.isPlayer) {
        state.doghouseOpponentsDefeated++;
        soundEngine.knockdown();
        const spawned = buildDoghouseEnemy(state);
        state.enemy = spawned.fighter;
        state.aiBrain = spawned.brain;
        state.enemyColors = { ...state.enemy.colors };
        state.knockdownActive = false;
        state.knockdownMashCount = 0;
        state.knockdownRefCount = 0;
        state.knockdownCountdown = 0;
        state.kdTimerExpired = false;
        state.refereeVisible = false;
        for (const f of [state.player, state.enemy]) {
          f.isPunching = false;
          f.currentPunch = null;
          f.punchPhase = null;
          f.punchPhaseTimer = 0;
          f.punchProgress = 0;
          f.isFeinting = false;
          f.isCharging = false;
          f.defenseState = "none";
        }
        return;
      } else if (kdCount >= 4 && defender.isPlayer && !state.practiceMode && (!state.sparringMode || state.doghouseMode)) {
        finalizeRoundRecording(state);
        rollNextRingCanvasColor();
      state.phase = "fightEnd";
        state.fightResult = "TKO";
        state.fightWinner = defender.isPlayer ? "enemy" : "player";
        state.fightTotalDuckDodges += state.roundStats.playerDuckDodges;
        state.fightTotalCombos += state.roundStats.playerComboCount;
        state.xpGained = calculateXP(state);
        state.refereeVisible = false;
      } else {
        if (defender.isPlayer) {
          state.knockdownMashRequired = kdCount === 1 ? 25 : kdCount === 2 ? 35 : 50;
        } else {
          state.knockdownMashRequired = kdCount <= 2 ? 25 : 45;
        }
      }
      if (!defender.isPlayer) {
        const chances = state.doghouseMode ? AI_KD_CHANCES.elite : AI_KD_CHANCES[state.aiDifficulty];
        const rawGetUpChance = kdCount === 1 ? chances.kd1 : kdCount === 2 ? chances.kd2 : chances.kd3;
        const getUpChance = Math.max(0, rawGetUpChance - (state.aiKdChancePenalty ?? 0));
        state.aiKdWillGetUp = state.doghouseMode ? aiRNG.chance(getUpChance) : (state.practiceMode || state.sparringMode) ? true : aiRNG.chance(getUpChance);
        if (state.aiDifficulty === "champion") {
          state.aiKdGetUpTime = kdCount === 1 ? aiRNG.range(1, 3) : kdCount === 2 ? aiRNG.range(3, 6) : aiRNG.range(6, 9.9);
        } else {
          state.aiKdGetUpTime = kdCount === 1 ? aiRNG.range(2, 5) : kdCount === 2 ? aiRNG.range(4, 7) : aiRNG.range(6, 9);
        }
        maybeArmEarlyBlitzKo(state, defender);
        // A fourth knockdown is a TKO — the AI does not get back up for it.
        if (kdCount >= 4 && !state.practiceMode && !state.sparringMode && !state.doghouseMode) {
          state.aiKdWillGetUp = false;
        }
        // The AI is not beating this count. Rather than cutting to the victory
        // screen, keep the fight on screen — they stay down, the referee counts —
        // and declare the result once a random 2-10s window elapses.
        state.aiKoPendingResult = null;
        state.aiKoStopTime = -1;
        if (!state.aiKdWillGetUp && !state.earlyBlitzKoActive
            && !state.practiceMode && !state.sparringMode && !state.doghouseMode) {
          state.aiKoPendingResult = kdCount >= 4 ? "TKO" : "KO";
          state.aiKoStopTime = 2 + Math.random() * 8;
        }
      }
      state.shakeIntensity = 12;
      state.shakeTimer = 0.4;

      const standingFighter = defender.isPlayer ? state.enemy : state.player;
      const neutralCorner = getFarthestNeutralCorner(defender.x, defender.z);
      state.standingFighterTargetX = neutralCorner.x;
      state.standingFighterTargetZ = neutralCorner.z;

      state.savedDefenseState = standingFighter.defenseState;
      state.savedHandsDown = false;
      state.savedBlockTimer = standingFighter.blockTimer;
      state.savedStandingIsPlayer = standingFighter.isPlayer;

      state.kdSavedKnockedRhythmLevel = defender.rhythmLevel > 0 ? defender.rhythmLevel : 2;
      state.kdSavedStandingRhythmLevel = standingFighter.rhythmLevel > 0 ? standingFighter.rhythmLevel : 2;

      standingFighter.isPunching = false;
      standingFighter.currentPunch = null;
      standingFighter.punchPhase = null;
      standingFighter.punchPhaseTimer = 0;
      standingFighter.isFeinting = false;
      standingFighter.isCharging = false;
      standingFighter.chargeArmed = false;
      standingFighter.chargeUsesLeft = 0;
      standingFighter.chargeWhiffForgivenessLeft = 0;
      standingFighter.chargeArmTimer = 0;
      standingFighter.retractionPenaltyMult = 1;
      standingFighter.defenseState = "none";
      standingFighter.punchProgress = 0;
      standingFighter.leftGloveOffset = { x: standingFighter.facing * 15, y: -5 };
      standingFighter.rightGloveOffset = { x: standingFighter.facing * 18, y: 0 };
      standingFighter.halfGuardPunch = false;
      standingFighter.punchingWhileBlocking = false;
      standingFighter.isRePunch = false;
      standingFighter.retractionProgress = 0;
      standingFighter.earlyRepunchPenaltyTimer = 0;
      standingFighter.staminaPenaltyPending = false;
      standingFighter.feintCancelActive = false;
      standingFighter.feintCancelPunchType = null;
      standingFighter.feintCancelTimer = 0;

      standingFighter.telegraphPhase = "none";
      standingFighter.telegraphTimer = 0;
      standingFighter.telegraphDuration = 0;
      if (standingFighter.isPlayer) {
        standingFighter.rhythmLevel = 0;
      }
      standingFighter.rhythmPauseTimer = 0;

      state.refereeVisible = true;
      state.refX = defender.x + 40;
      state.refZ = defender.z - 20;
    }
  }
}

const FEINT_HOLD_MAX = 3.0;
/** Seconds a tapped F stays armed, waiting for the punch it will turn into a feint. */
const FEINT_ARM_WINDOW = 1.0;
const FEINT_HOLD_STAM_PAUSE = 2.0;

function isFeintTouchingOpponent(fighter: FighterState, opponent: FighterState): boolean {
  if (!fighter.isFeinting || !fighter.isPunching) return false;
  if (fighter.punchPhase !== "linger") return false;
  const config = getHitPunchConfig(fighter.currentPunch!);
  const armReachBonus = (fighter.armLength - 65) * PX_PER_INCH;
  const feintReach = (config.range + 20 + armReachBonus + (fighter.precisionStrikerRangeBonus ?? 0)) * 0.3;
  const dist = getDistance(fighter, opponent);
  return dist <= feintReach;
}

function getFeintPunchFailChance(fighter: FighterState, state: GameState): number {
  if (fighter.isPlayer) {
    return levelScale(fighter.level, 0.60, 0.30, "feintFailChance");
  } else {
    const diff = state.aiDifficulty;
    switch (diff) {
      case "journeyman": return 0.85;
      case "contender": return 0.80;
      case "elite": return 0.75;
      case "champion": return 0.70;
      default: return 0.75;
    }
  }
}

function updatePunch(fighter: FighterState, opponent: FighterState, state: GameState, dt: number): void {
  if (!fighter.isPunching || !fighter.currentPunch) return;

  if (fighter.feintCancelActive) {
    fighter.feintCancelTimer = (fighter.feintCancelTimer ?? 0) + dt;
    const cancelDur = Math.max(0.001, fighter.feintCancelDuration ?? 0.12);
    fighter.retractionProgress = Math.min(1, fighter.feintCancelTimer / cancelDur);
    if (fighter.retractionProgress >= 0.5) {
      const queuedPunch = fighter.feintCancelPunchType;
      const queuedCharged = fighter.feintCancelCharged ?? false;
      const queuedBody = fighter.feintCancelBody ?? false;
      fighter.feintCancelActive = false;
      fighter.feintCancelPunchType = null;
      fighter.feintCancelTimer = 0;
      fighter.feintCancelDuration = 0;
      fighter.isPunching = false;
      fighter.currentPunch = null;
      fighter.punchPhase = null;
      fighter.punchPhaseTimer = 0;
      fighter.punchProgress = 0;
      fighter.punchCooldown = 0;
      fighter.retractionProgress = 0;
      fighter.retractionPenaltyMult = 1;
      fighter.drilledPunch = null;
      if (queuedPunch) {
        if (queuedBody) fighter.punchAimsHead = false;
        const roundElapsed = state.roundDuration - state.roundTimer;
        if (attemptPunch(fighter, queuedPunch, false, queuedCharged, false, state.practiceMode, roundElapsed, opponent)) {
          if (fighter.isPlayer) {
            state.roundStats.playerPunchesThisRound++;
            recordEvent(state, "punch", "player", { punch: queuedPunch, feint: false, charged: queuedCharged, body: queuedBody, rePunch: false });
          } else {
            state.roundStats.enemyPunchesThisRound++;
            recordEvent(state, "punch", "enemy", { punch: queuedPunch, feint: false, charged: queuedCharged, body: queuedBody, rePunch: false });
          }
        }
      }
    }
    return;
  }

  const config = getEffectivePunchConfig(fighter.currentPunch);
  const durations = getPunchPhaseDurations(fighter, config, fighter.isRePunch);
  if (state.fatigueEnabled) {
    const fatigueMult = 1 / Math.max(0.5, 1 - Math.floor(fighter.punchesThrown / 50) * 0.0025);
    for (const phase of Object.keys(durations) as PunchPhaseType[]) {
      durations[phase] *= fatigueMult;
    }
  }
  const phases: PunchPhaseType[] = ["launchDelay", "armSpeed", "contact", "linger", "retraction"];

  if (!fighter.punchPhase) fighter.punchPhase = "launchDelay";

  if (fighter.isFeinting && fighter.punchPhase === "linger") {
    fighter.feintHoldTimer += dt;
    const touching = isFeintTouchingOpponent(fighter, opponent);
    const feinterDucking = fighter.defenseState === "duck";
    fighter.feintTouchingOpponent = touching && !feinterDucking;
    fighter.feintDuckTouchingOpponent = touching && feinterDucking;

    // Technician's rhythm debuffs used to fire from a feint touching the
    // opponent; they now ride on a landed rhythm cut instead (see the
    // RhythmCutHit block in resolveHit).

    if (fighter.feintHoldTimer < FEINT_HOLD_MAX) {
      return;
    }
    // Held all the way to the cap: let it go the same way a released one goes,
    // through a normal retraction rather than vanishing off the arm.
    startFeintRetraction(fighter);
    return;
  }

  fighter.punchPhaseTimer += dt;

  const currentPhaseDuration = durations[fighter.punchPhase];

  let totalDuration = 0;
  for (const p of phases) totalDuration += durations[p];
  let elapsed = 0;
  for (const p of phases) {
    if (p === fighter.punchPhase) {
      elapsed += Math.min(fighter.punchPhaseTimer, durations[p]);
      break;
    }
    elapsed += durations[p];
  }
  fighter.punchProgress = Math.min(1, elapsed / totalDuration);

  if (fighter.punchPhase === "retraction") {
    fighter.retractionProgress = Math.min(1, fighter.punchPhaseTimer / currentPhaseDuration);
  }

  if (fighter.punchPhaseTimer >= currentPhaseDuration) {
    const currentIdx = phases.indexOf(fighter.punchPhase);

    if (fighter.punchPhase === "contact") {
      applyHit(fighter, opponent, state);
      // A feint reaching full extension is one of the three things that draw a
      // flinch. A real punch draws one by landing instead, down in applyHit, so
      // only the empty one is claimed here — and only while this punch's feints
      // are still being paid for with real ones out of the same stance.
      const stillSelling = noteFlinchPunchRatio(fighter, opponent, !!fighter.isFeinting);
      if (fighter.isFeinting && stillSelling) triggerFlinch(opponent, fighter, state);
    }

    if (currentIdx < phases.length - 1) {
      fighter.punchPhase = phases[currentIdx + 1];
      fighter.punchPhaseTimer = 0;
      if (fighter.punchPhase === "retraction") {
        const animCfg = getActivePunchAnimConfig();
        const lockoutBase = (animCfg[fighter.currentPunch!].lockoutMs ?? 200) / 1000;
        fighter.postPunchLockoutTimer = lockoutBase * (1 - Math.min(100, fighter.fastTwitchRank) / 100);
      }
      if (fighter.isFeinting && fighter.punchPhase === "linger") {
        fighter.feintHoldTimer = 0;
      }
    } else {
      const lastPunch = fighter.currentPunch;
      fighter.isPunching = false;
      fighter.currentPunch = null;
      fighter.punchProgress = 0;
      fighter.punchPhase = null;
      fighter.punchPhaseTimer = 0;
      fighter.punchCooldown = 0;
      fighter.isFeinting = false;
      fighter.isCharging = false;
      fighter.halfGuardPunch = false;
      fighter.isRePunch = false;
      fighter.retractionProgress = 0;
      fighter.retractionPenaltyMult = 1;
      fighter.feintHoldTimer = 0;
      fighter.feintTouchingOpponent = false;
      fighter.feintDuckTouchingOpponent = false;
      // The drilled bundle belongs to the punch that carried it, and dies with it.
      fighter.drilledPunch = null;
      // If lockout time still remains from the input-time start, play the animation for it
      const remaining = fighter.postPunchLockoutTimer;
      if (remaining > 0.001 && lastPunch) {
        fighter.postPunchLockoutDuration = remaining;
        fighter.telegraphPhase = "down";
        fighter.telegraphTimer = 0;
        fighter.telegraphDuration = remaining;
        fighter.telegraphPunchType = lastPunch;
        fighter.telegraphIsFeint = false;
        fighter.telegraphIsCharged = false;
        fighter.telegraphIsLockout = true;
      }
    }
  }
}

function updateRhythm(fighter: FighterState, dt: number): void {
  if (fighter.isKnockedDown) return;
  if (fighter.rhythmLevel === 0) {
    return;
  }
}

/**
 * Is this fighter walking right now? Read off the voluntary movement input of
 * whichever corner owns them, never a position delta — so being backed into the
 * ropes or shoved by a punch doesn't read as footwork.
 */
function isFighterWalking(fighter: FighterState, state?: GameState): boolean {
  if (fighter.isPlayer) {
    return Boolean(keys["arrowleft"] || keys["arrowright"] || keys["arrowup"] || keys["arrowdown"]);
  }
  return Boolean(state?.aiBrain && (state.aiBrain.desiredMoveInput !== 0 || state.aiBrain.desiredMoveZ !== 0));
}

/**
 * Where the rhythm marker sits — or nowhere at all. Standing still switches the
 * rhythm off outright instead of parking the marker at an extreme of the arc,
 * which with the vulnerable zones now AT the extremes would otherwise leave a
 * stationary fighter permanently open.
 */
function syncRhythmProgress(fighter: FighterState): void {
  fighter.rhythmProgress = fighter.rhythmWalking
    ? Math.max(0, Math.min(1, fighter.swayOffset / 10 + 0.5))
    : 0;
}

/**
 * Is a ducking fighter's rhythm sweeping? A duck only sways while the fighter is
 * actually moving, and both the sweep and the body it drives need the answer.
 */
function isDuckRhythmSwaying(fighter: FighterState, state?: GameState): boolean {
  if (fighter.rhythmLevel <= 0) return false;
  return isRhythmLive(fighter, state);
}

/**
 * Telegraph tell — the rhythm lift. How much faster a fighter's own rhythm
 * marker sweeps while they are winding a punch up, and how long the lift takes
 * to ease in at the start of the windup and back out after it fires. The ramp
 * is a fraction of the shortest windup in the game, so the lift is at full
 * strength for nearly the whole telegraph rather than chasing it.
 */
const TELEGRAPH_RHYTHM_SPEEDUP = 0.30;
const TELEGRAPH_RHYTHM_RAMP = 0.10;

/**
 * Where a fighter's weight sits when they aren't working their feet. The arc
 * runs -5 (back foot) to +5 (front foot) in swayOffset units, and standing
 * still parks them at the front-foot end of it.
 */
const SWAY_FRONT_FOOT = 5;

/** Top of the sway speed ladder — what a Reset's rhythm kick runs at. */
const SWAY_SPEED_LEVEL_MAX = 5;

/** Is this fighter inside the rhythm kick a Reset throws them into? */
export function isResetRhythmBurst(fighter: FighterState): boolean {
  return (fighter.fatigue?.rhythmBurstTimer ?? 0) > 0;
}

/**
 * Is the rhythm actually running for this fighter? Footwork is what normally
 * drives it, but the kick a Reset opens with runs the sweep whether or not the
 * feet are moving — and while it does, everything the arc drives (the
 * vulnerability window, the power and off-balance zones, the bob) is live with
 * it. Every reader goes through here rather than asking about walking directly.
 */
function isRhythmLive(fighter: FighterState, state?: GameState): boolean {
  return isResetRhythmBurst(fighter) || isFighterWalking(fighter, state);
}

/**
 * The sway speed the marker is actually sweeping at: the fighter's own setting,
 * or the top of the ladder for as long as a Reset's kick is running.
 */
export function effectiveSwaySpeedLevel(fighter: FighterState): number {
  return isResetRhythmBurst(fighter) ? SWAY_SPEED_LEVEL_MAX : fighter.swaySpeedLevel;
}

/**
 * The sway sweep itself, and everything read off where the marker sits. Kept
 * apart from the body it drives because throwing a punch no longer stops a
 * fighter's own rhythm: the sweep runs through the windup and the punch, while
 * the punch animation keeps the body. That is also what makes a puncher
 * catchable in their own green zone instead of parked at an extreme of the arc.
 */
function advanceSway(fighter: FighterState, dt: number, state?: GameState): void {
  // Footwork is what runs the rhythm — and so does the kick a Reset opens with,
  // which is the one time the sweep runs with the feet still. Stamped once per
  // tick so every reader downstream — vulnerability, the HUD bar — gets the
  // same answer.
  fighter.rhythmWalking = isRhythmLive(fighter, state);

  // Telegraph tell — the rhythm lift. A windup runs the winder's own marker
  // TELEGRAPH_RHYTHM_SPEEDUP faster for exactly as long as the windup lasts,
  // eased in and out over TELEGRAPH_RHYTHM_RAMP so the sweep never steps. This
  // and the 2px arm draw in the renderer are the whole telegraph read now.
  //
  // The ramp is advanced here rather than in updateBob so it can only ever move
  // on a tick that also moves the sway: a knockdown, the bell or a green-zone
  // hold all stop both together, and the two can never drift apart.
  const boostTarget = fighter.telegraphPhase !== "none" ? 1 : 0;
  const rampStep = TELEGRAPH_RHYTHM_RAMP > 0 ? dt / TELEGRAPH_RHYTHM_RAMP : 1;
  const boostNow = fighter.telegraphRhythmBoost ?? 0;
  fighter.telegraphRhythmBoost = boostNow < boostTarget
    ? Math.min(boostTarget, boostNow + rampStep)
    : Math.max(boostTarget, boostNow - rampStep);
  const telegraphSpeedMult = 1 + fighter.telegraphRhythmBoost * TELEGRAPH_RHYTHM_SPEEDUP;

  // Feet still, rhythm off. The sway settles onto the front foot and holds there
  // instead of sweeping on the spot, which also parks the body: everything the
  // arc drives — the vulnerability window, the power and off-balance zones, the
  // bob — is footwork, so none of it is on offer to a fighter stood still. The
  // first step sets the arc off again from that front-foot end.
  if (!fighter.rhythmWalking) {
    const diff = SWAY_FRONT_FOOT - fighter.swayOffset;
    if (Math.abs(diff) < 0.5) {
      fighter.swayOffset = SWAY_FRONT_FOOT;
      fighter.swayFrozen = true;
      // Parked at the front end, so the only way back out is the other way.
      fighter.swayDir = -1;
    } else {
      fighter.swayOffset += Math.sign(diff) * Math.min(Math.abs(diff), 15 * dt);
      fighter.swayFrozen = false;
    }
    syncRhythmProgress(fighter);
    computeSwayZoneMults(fighter);
    return;
  }

  if (fighter.defenseState === "duck") {
    if (isDuckRhythmSwaying(fighter, state)) {
      const rhythmSpeedMult = (!fighter.isPlayer && state?.aiBrain) ? state.aiBrain.aiRhythmSpeedMult : 1.0;
      const rhythmCutFactor = (fighter.rhythmCutTimer > 0) ? (fighter.rhythmCutMult ?? 1.0) : 1.0;
      const swaySpeed = (fighter.rhythmLevel * 0.8 + 1.0) * rhythmSpeedMult * rhythmCutFactor * telegraphSpeedMult;
      const swayAmp = 5;
      fighter.swayFrozen = false;
      fighter.swayOffset += fighter.swayDir * swaySpeed * dt * 8;
      if (Math.abs(fighter.swayOffset) >= swayAmp) {
        fighter.swayOffset = fighter.swayDir * swayAmp;
        fighter.swayDir = (fighter.swayDir === 1 ? -1 : 1) as 1 | -1;
        if (fighter.rhythmCutPending) { fighter.rhythmCutPending = false; fighter.rhythmCutTimer = 1.0; }
      }
    } else {
      const duckSwayTarget = fighter.swayDir * 5;
      const diff = duckSwayTarget - fighter.swayOffset;
      if (Math.abs(diff) < 0.4) {
        fighter.swayOffset = duckSwayTarget;
        fighter.swayFrozen = true;
      } else {
        fighter.swayOffset += Math.sign(diff) * Math.min(Math.abs(diff), 60 * dt);
        fighter.swayFrozen = false;
      }
    }
    syncRhythmProgress(fighter);
    computeSwayZoneMults(fighter);
    return;
  }

  if (fighter.rhythmPauseTimer > 0) {
    fighter.rhythmPauseTimer = Math.max(0, fighter.rhythmPauseTimer - dt);
  } else if (fighter.isPlayer && keys["tab"]) {
    // Tab held: freeze sway movement; rhythm debuffs at current position still apply
  } else if (effectiveSwaySpeedLevel(fighter) === 0) {
    const target = fighter.swayDir * 5;
    const diff = target - fighter.swayOffset;
    if (Math.abs(diff) < 0.5) {
      fighter.swayOffset = target;
      fighter.swayFrozen = true;
    } else {
      const speed = 15 * dt;
      fighter.swayOffset += Math.sign(diff) * Math.min(Math.abs(diff), speed);
      fighter.swayFrozen = false;
    }
  } else {
    fighter.swayFrozen = false;
    const rhythmSpeedMult2 = (!fighter.isPlayer && state?.aiBrain) ? state.aiBrain.aiRhythmSpeedMult : 1.0;
    const rhythmCutFactor2 = (fighter.rhythmCutTimer > 0) ? (fighter.rhythmCutMult ?? 1.0) : 1.0;
    const swaySpeed = (effectiveSwaySpeedLevel(fighter) / 3) * (fighter.rhythmLevel > 0 ? fighter.rhythmLevel * 0.8 + 1.0 : fighter.baseBobSpeed) * 0.5 * rhythmSpeedMult2 * rhythmCutFactor2 * telegraphSpeedMult;
    const swayAmp = 5;
    // Linear (constant-speed) sweep across the full range, matching the duck-rhythm
    // branch above. A sinusoidal sweep (previous behavior) lingers near the extremes
    // (beginning/end) and rushes through the center (green zone), which skews where
    // punches actually land relative to the visually-fair green zone. The speed here
    // (4x amplitude x swaySpeed) preserves the same overall full-cycle timing as the
    // old sine wave (average |velocity| of A*sin(wt) is (2/pi)*A*w).
    fighter.swayOffset += fighter.swayDir * swayAmp * 4 * swaySpeed * dt;
    if (Math.abs(fighter.swayOffset) >= swayAmp) {
      fighter.swayOffset = fighter.swayDir * swayAmp;
      fighter.swayDir = (fighter.swayDir === 1 ? -1 : 1) as 1 | -1;
      if (fighter.rhythmCutPending) { fighter.rhythmCutPending = false; fighter.rhythmCutTimer = 1.0; }
    }
  }

  syncRhythmProgress(fighter);

  computeSwayZoneMults(fighter);
}

function updateBob(fighter: FighterState, dt: number, state?: GameState): void {
  // A windup cancelled before it fired (knockdown, bell, corner walk) would leave
  // its green-zone pause — and the freeze it holds the marker with — stamped on
  // the fighter. Drop both the moment the windup is gone.
  if (fighter.telegraphRhythmPaused && fighter.telegraphPhase === "none") {
    fighter.telegraphRhythmPaused = false;
    fighter.swayFrozen = false;
  }
  const duckTarget = isDuckLive(fighter) ? 1 : 0;
  const guardActive = fighter.defenseState === "fullGuard";
  const duckSpeed = (guardActive ? 8.0 : 8.0 * 1.2) * 1.05 * fighter.duckSpeedMult;
  fighter.duckProgress += (duckTarget - fighter.duckProgress) * Math.min(1, duckSpeed * dt);
  if (Math.abs(fighter.duckProgress - duckTarget) < 0.01) fighter.duckProgress = duckTarget;

  const duckWithGuard = fighter.defenseState === "duck" && fighter.preDuckBlockState !== null;
  const guardTarget = (guardActive || duckWithGuard) ? 1.0 : 0.0;
  const isRaising = (guardActive || duckWithGuard);
  let guardSpeed: number;
  if (isRaising) {
    const guardSlideMs = levelScale(fighter.level, 50, 20, "guardRaiseMs");
    const defGuardMult = 1 + pointCoef("defenseAutoGuardRamp", 9) * Math.min(1, Math.max(0, ((fighter.defenseT ?? 0) - 0.2) / 0.8));
    guardSpeed = (1000 / guardSlideMs) * defGuardMult;
    // Tired arms bring the guard up slower. Only the raise is slowed; dropping
    // the guard is gravity and costs a fatigued fighter nothing.
    guardSpeed *= 1 - getFatigueConfig().guardSlowMax
      * fatigueRampT(fighter, getFatigueConfig().guardSlowCapPunches) * fatigueEffectMult(fighter);
  } else {
    guardSpeed = 6.0;
  }
  if (fighter.perfectBlockState === "rising") {
    const pbRiseDuration = 0.0333 - fighter.speedT * 0.00833;
    fighter.guardBlend = Math.min(1, pbRiseDuration > 0 ? fighter.perfectBlockRiseTimer / pbRiseDuration : 1);
  } else if (fighter.perfectBlockState === "active") {
    fighter.guardBlend = 1;
  } else {
    fighter.guardBlend += (guardTarget - fighter.guardBlend) * Math.min(1, guardSpeed * dt);
    if (Math.abs(fighter.guardBlend - guardTarget) < 0.02) fighter.guardBlend = guardTarget;
    if (fighter.autoGuardActive && fighter.autoGuardTimer > 0 && fighter.defenseState === "fullGuard" && !fighter.isPunching) {
      fighter.guardBlend = 1;
    }
  }

  const levelSpeedScale = levelScale(fighter.level, 1, 2.5, "animSpeedScale");
  const isRetracting = fighter.isPunching && fighter.punchPhase === "retraction";
  const isDuckCross = fighter.defenseState === "duck" && fighter.isPunching && fighter.currentPunch === "cross";
  const isLeftHook = fighter.isPunching && fighter.currentPunch === "leftHook";

  if (isDuckCross && !isRetracting) {
    const driveSpeed = 12.0 * 1.1 * levelSpeedScale;
    fighter.backLegDrive += (1 - fighter.backLegDrive) * Math.min(1, driveSpeed * dt);
    if (fighter.backLegDrive > 0.99) fighter.backLegDrive = 1;
  } else if (fighter.backLegDrive > 0) {
    const returnSpeed = 6.0 * 0.95 * levelSpeedScale;
    fighter.backLegDrive -= fighter.backLegDrive * Math.min(1, returnSpeed * dt);
    if (fighter.backLegDrive < 0.01) fighter.backLegDrive = 0;
  }

  if (isLeftHook && !isRetracting) {
    const driveSpeed = 12.0 * 1.1 * levelSpeedScale;
    fighter.frontLegDrive += (1 - fighter.frontLegDrive) * Math.min(1, driveSpeed * dt);
    if (fighter.frontLegDrive > 0.99) fighter.frontLegDrive = 1;
  } else if (fighter.frontLegDrive > 0) {
    const returnSpeed = 6.0 * 0.95 * levelSpeedScale;
    fighter.frontLegDrive -= fighter.frontLegDrive * Math.min(1, returnSpeed * dt);
    if (fighter.frontLegDrive < 0.01) fighter.frontLegDrive = 0;
  }

  if (fighter.isKnockedDown) return;
  // Mid-punch the sweep still runs; only the body is left to the punch animation.
  if (fighter.isPunching) {
    advanceSway(fighter, dt, state);
    return;
  }

  const isTelegraphing = fighter.telegraphPhase !== "none";

  if (fighter.miniStunTimer > 0) {
    fighter.miniStunTimer = Math.max(0, fighter.miniStunTimer - dt);
  }

  // The windup holds the marker only for a punch triggered in the thrower's own
  // green zone (stamped at the trigger); every other windup keeps sweeping.
  if (isTelegraphing) {
    if (fighter.telegraphRhythmPaused) fighter.swayFrozen = true;
    else advanceSway(fighter, dt, state);
    return;
  }

  const isDucking = fighter.defenseState === "duck";

  // The bob is footwork too: a fighter stood still holds their stance instead of
  // idling up and down on the spot. Read live rather than off the stamp so the
  // body and the sway answer the same tick.
  const isWalkingNow = isRhythmLive(fighter, state);

  let effectiveBobSpeed = fighter.rhythmLevel > 0 ? fighter.rhythmLevel * 0.8 + 1.0 : fighter.baseBobSpeed;
  if (!isDucking && isWalkingNow) {
    fighter.bobPhase += dt * effectiveBobSpeed * Math.PI * 2;
    if (fighter.bobPhase > Math.PI * 2) fighter.bobPhase -= Math.PI * 2;
  }

  if (!isDucking) {
    const bobAmplitude = fighter.rhythmLevel > 0 ? 2 + fighter.rhythmLevel * 0.5 : 3;

    if (fighter.rhythmLevel > 0) {
      const swayNorm = fighter.swayOffset / 5;
      const bobX = swayNorm * bobAmplitude * fighter.facing;
      const bobY = -Math.abs(swayNorm) * 4;
      fighter.bodyOffset = { x: bobX, y: bobY };
      if (fighter.defenseState === "none" && !fighter.isPunching) {
        fighter.headOffset = {
          x: swayNorm * (bobAmplitude + 1) * fighter.facing,
          y: bobY - 2 + Math.abs(swayNorm) * 2,
        };
      }
    } else if (isWalkingNow) {
      const bobX = Math.sin(fighter.bobPhase) * bobAmplitude * fighter.facing;
      const bobY = Math.abs(Math.sin(fighter.bobPhase * 0.5)) * -4;
      fighter.bodyOffset = { x: bobX, y: bobY };
      if (fighter.defenseState === "none" && !fighter.isPunching) {
        fighter.headOffset = {
          x: Math.sin(fighter.bobPhase + 0.5) * (bobAmplitude + 1) * fighter.facing,
          y: bobY - 2 + Math.sin(fighter.bobPhase * 1.5) * 2,
        };
      }
    } else {
      // No rhythm and no footwork — there is no sway to park on, so the idle bob
      // eases out to a square stance rather than freezing mid-dip.
      const settle = Math.min(1, 10 * dt);
      fighter.bodyOffset = {
        x: fighter.bodyOffset.x * (1 - settle),
        y: fighter.bodyOffset.y * (1 - settle),
      };
      if (fighter.defenseState === "none" && !fighter.isPunching) {
        fighter.headOffset = {
          x: fighter.headOffset.x * (1 - settle),
          y: fighter.headOffset.y * (1 - settle),
        };
      }
    }
  }

  if (isDucking) {
    advanceSway(fighter, dt, state);
    if (isDuckRhythmSwaying(fighter, state)) {
      const swayNorm = fighter.swayOffset / 5;
      const bobAmplitude = 2 + fighter.rhythmLevel * 0.5;
      const bobX = swayNorm * bobAmplitude * fighter.facing;
      const bobY = -Math.abs(swayNorm) * 4;
      fighter.bodyOffset = { x: bobX, y: bobY };
    }
    return;
  }

  advanceSway(fighter, dt, state);
}

function updateDefense(fighter: FighterState, dt: number, practiceMode: boolean = false): void {
  // One clock for how long the crouch has really been held, zeroed the instant
  // the fighter is out of it. The duck lag is measured against this rather than
  // duckTimer, which the AI pre-seeds to fake a crouch already under way.
  if (fighter.defenseState !== "duck") fighter.duckHoldTime = 0;

  if (fighter.isKnockedDown) {
    fighter.defenseState = "none";
    return;
  }

  switch (fighter.defenseState) {
    case "fullGuard":
      fighter.leftGloveOffset = { x: fighter.facing * 6, y: -12 };
      fighter.rightGloveOffset = { x: fighter.facing * 6, y: -8 };
      fighter.headOffset = { x: 0, y: -3 };
      break;
    case "duck": {
      fighter.duckTimer += dt;
      fighter.duckHoldTime += dt;
      // Asking for the duck is not being in it. A fighter still serving their
      // lag stays stood up, hands where they were, until the debt is paid.
      if (isDuckLive(fighter)) {
        const duckDrop = 18;
        fighter.headOffset = { x: 0, y: duckDrop };
        if (!fighter.isPunching) {
          fighter.leftGloveOffset = { x: fighter.facing * 5, y: duckDrop };
          fighter.rightGloveOffset = { x: fighter.facing * 5, y: duckDrop };
        }
      }
      break;
    }
    case "none":
      if (!fighter.isPunching) {
        fighter.duckTimer = 0;
      }
      break;
  }
}

function updatePunchAnimation(fighter: FighterState): void {
  if (!fighter.isPunching || !fighter.currentPunch) {
    if (fighter.defenseState === "none" && fighter.handsDown) {
      const defaultLeft = { x: fighter.facing * 15, y: -5 };
      const defaultRight = { x: fighter.facing * 18, y: 0 };
      fighter.leftGloveOffset = lerpVec(fighter.leftGloveOffset, defaultLeft, 0.2);
      fighter.rightGloveOffset = lerpVec(fighter.rightGloveOffset, defaultRight, 0.2);
    }
    return;
  }

  const config = getEffectivePunchConfig(fighter.currentPunch);
  const phase = fighter.punchPhase;

  if (fighter.isFeinting) {
    let extend = 0;
    if (fighter.punchPhase === "linger" && fighter.feintHoldTimer > 0) {
      extend = 0.3;
    } else if (fighter.punchPhase === "launchDelay") {
      extend = 0.05 * 0.3;
    } else if (fighter.punchPhase === "armSpeed") {
      const armT = Math.min(1, fighter.punchPhaseTimer / 0.12);
      extend = (0.05 + 0.95 * armT) * 0.3;
    } else if (fighter.punchPhase === "contact") {
      extend = 0.3;
    } else if (fighter.punchPhase === "linger") {
      extend = 0.3;
    }
    const feintReach = config.range * fighter.facing * extend;
    if (config.isLeft) {
      fighter.leftGloveOffset = { x: feintReach, y: -3 };
    } else {
      fighter.rightGloveOffset = { x: feintReach, y: -3 };
    }
    return;
  }

  let extend = 0;
  switch (phase) {
    case "launchDelay":
      extend = 0.05;
      break;
    case "armSpeed":
      extend = 0.05 + 0.95 * Math.min(1, fighter.punchPhaseTimer / 0.12);
      break;
    case "contact":
    case "linger":
      extend = 1.0;
      break;
    case "retraction":
      extend = 1.0 - fighter.retractionProgress;
      break;
  }

  if (fighter.feintCancelActive && phase === "retraction") {
    extend = 0.3 * (1 - fighter.retractionProgress);
  }

  const animCfg = getActivePunchAnimConfig()[fighter.currentPunch];
  const reachX = config.range * fighter.facing * extend;
  const isUppercut = fighter.currentPunch.includes("Uppercut");
  const isHook = fighter.currentPunch.includes("Hook");

  let punchOffset: Vec2;
  if (isUppercut) {
    const uPhase = extend;
    const dp = animCfg.dropPhase;
    let uy: number;
    if (uPhase < dp) {
      const dropT = uPhase / dp;
      uy = animCfg.dropDepth * dropT;
    } else {
      const riseT = (uPhase - dp) / (1 - dp);
      uy = animCfg.dropDepth * (1 - riseT) - animCfg.riseHeight * Math.sin(riseT * Math.PI * animCfg.riseArcFactor);
    }
    const xProgress = uPhase < dp ? uPhase * 0.4 / dp : 0.4 + (uPhase - dp) * 0.6 / (1 - dp);
    punchOffset = {
      x: config.range * fighter.facing * xProgress,
      y: uy,
    };
  } else if (isHook) {
    const arc = Math.sin(extend * Math.PI) * animCfg.arcAmplitude;
    punchOffset = {
      x: reachX * animCfg.hookReachMult,
      y: -arc,
    };
  } else {
    punchOffset = { x: reachX * animCfg.reachMult, y: animCfg.angle * extend };
  }

  if (fighter.defenseState === "duck") {
    const duckDrop = 18;
    if (fighter.punchAimsHead) {
      punchOffset.y = animCfg.angle * extend;
    } else {
      const bodyTarget = duckDrop + PUNCH_ANGLE_DUCK_BODY * extend;
      if (isUppercut) {
        const uPhase = extend;
        const dp = animCfg.dropPhase;
        let arc: number;
        if (uPhase < dp) {
          arc = animCfg.dropDepth * 0.667 * (uPhase / dp);
        } else {
          const riseT = (uPhase - dp) / (1 - dp);
          arc = animCfg.dropDepth * 0.667 * (1 - riseT) - animCfg.riseHeight * 0.778 * Math.sin(riseT * Math.PI * animCfg.riseArcFactor);
        }
        punchOffset.y = bodyTarget + arc;
      } else if (isHook) {
        punchOffset.y = bodyTarget;
      } else {
        punchOffset.y = bodyTarget;
      }
    }
  }

  if (config.isLeft) {
    fighter.leftGloveOffset = punchOffset;
  } else {
    fighter.rightGloveOffset = punchOffset;
  }
}

function lerpVec(a: Vec2, b: Vec2, t: number): Vec2 {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

function updateAILegacy(state: GameState, dt: number): void {
  const roundElapsed = state.roundDuration - state.roundTimer;
  const wrappedAttemptPunch = (fighter: FighterState, punchType: PunchType, isFeint?: boolean, isCharged?: boolean): boolean => {
    if (fighter.telegraphPhase !== "none") {
      // During the post-punch lockout animation the gate is closed but isPunching/punchCooldown
      // are already 0, so the AI's gate check passes and the attack timer fires — then the punch
      // silently fails and the timer resets to 0, compounding over the fight.
      // Buffer the punch (same mechanism as the player fix) so it fires the instant the gate opens.
      if (fighter.telegraphIsLockout && !isFeint && !fighter.pendingPunchInput) {
        fighter.pendingPunchInput = punchType;
        fighter.pendingPunchCharged = !!isCharged;
        fighter.pendingPunchBody = !fighter.punchAimsHead;
        fighter.pendingPunchInputTimer = 0.200;
      }
      return false;
    }
    if (isCharged && roundElapsed < 10) return false;
    if (!isFeint && (state.player.feintTouchingOpponent || state.player.feintDuckTouchingOpponent)) {
      const failChance = getFeintPunchFailChance(fighter, state);
      if (Math.random() < failChance) return false;
    }
    if (!fighter.isPunching && shouldTelegraph(fighter, false, punchType)) {
      if (startTelegraph(fighter, punchType, !!isFeint, !!isCharged, state.telegraphMult, state.player)) {
        return true;
      }
      // rhythm >95%: telegraph skipped, fall through to direct punch
    }
    const result = attemptPunch(fighter, punchType, isFeint, isCharged, false, state.practiceMode, roundElapsed, state.player);
    if (result) {
      state.roundStats.enemyPunchesThisRound++;
      recordEvent(state, isFeint ? "feint" : "punch", "enemy", { punch: punchType, feint: !!isFeint, charged: !!isCharged, body: !fighter.punchAimsHead });
    }
    return result;
  };
  // The AI's input read: it learns a punch has been triggered the instant it is,
  // whoever threw it — human or CPU — and may only spend that knowledge on
  // deciding to slip. Read in both directions so a CPU-driven player corner gets
  // the same mechanic against its opponent.
  if (state.player.punchInputUnread) {
    state.player.punchInputUnread = false;
    notifyAiPunchTrigger(state, state.enemy, state.player);
  }
  if (state.enemy.punchInputUnread) {
    state.enemy.punchInputUnread = false;
    notifyAiPunchTrigger(state, state.player, state.enemy);
  }
  updateAIBrain(state, dt, wrappedAttemptPunch);

  // Pressure Drop Recovery: AI stands still with guard down when far from player
  if (state.aiBrain && !state.enemy.isPunching && !state.enemy.isKnockedDown) {
    const brain = state.aiBrain;
    const dist = getDistance(state.player, state.enemy);
    brain.aiPdrRollTimer -= dt;

    if (dist > 300 && !state.enemy.isHit && state.enemy.regenPauseTimer <= 0) {
      if (brain.aiPdrRollTimer <= 0) {
        brain.aiPdrRollTimer = 2.0;
        const chance = state.aiDifficulty === "champion" ? 0.90 :
                       state.aiDifficulty === "elite"    ? 0.75 :
                       state.aiDifficulty === "contender" ? 0.60 : 0.50;
        brain.aiPdrActive = Math.random() < chance;
      }
    } else {
      brain.aiPdrActive = false;
      brain.aiPdrRollTimer = 0;
    }

    if (brain.aiPdrActive) {
      brain.desiredMoveInput = 0;
      brain.desiredMoveZ = 0;
      state.enemy.handsDown = true;
    }
  }
}

function updatePlayerAI(state: GameState, dt: number): void {
  const roundElapsed = state.roundDuration - state.roundTimer;
  const wrappedAttemptPunch = (fighter: FighterState, punchType: PunchType, isFeint?: boolean, isCharged?: boolean): boolean => {
    if (fighter.telegraphPhase !== "none") {
      if (fighter.telegraphIsLockout && !isFeint && !fighter.pendingPunchInput) {
        fighter.pendingPunchInput = punchType;
        fighter.pendingPunchCharged = !!isCharged;
        fighter.pendingPunchBody = !fighter.punchAimsHead;
        fighter.pendingPunchInputTimer = 0.200;
      }
      return false;
    }
    if (isCharged && roundElapsed < 10) return false;
    if (!isFeint && (state.enemy.feintTouchingOpponent || state.enemy.feintDuckTouchingOpponent)) {
      const failChance = getFeintPunchFailChance(fighter, state);
      if (Math.random() < failChance) return false;
    }
    if (!fighter.isPunching && shouldTelegraph(fighter, false, punchType)) {
      if (startTelegraph(fighter, punchType, !!isFeint, !!isCharged, state.telegraphMult, state.enemy)) {
        return true;
      }
      // rhythm >95%: telegraph skipped, fall through to direct punch
    }
    const result = attemptPunch(fighter, punchType, isFeint, isCharged, false, state.practiceMode, roundElapsed, state.enemy);
    if (result) {
      state.roundStats.playerPunchesThisRound++;
      recordEvent(state, isFeint ? "feint" : "punch", "player", { punch: punchType, feint: !!isFeint, charged: !!isCharged, body: !fighter.punchAimsHead });
    }
    return result;
  };
  updateAIBrain(state, dt, wrappedAttemptPunch, true);
}

function updateNightmareExtras(state: GameState, dt: number): void {
  if (state.phase !== "fighting" || state.knockdownActive) return;

  state.nightmareTimeSurvived += dt;

  // After 30s: drain player maxStaminaCap by 1 every second; after 60s every 0.75s
  if (state.nightmareTimeSurvived > 30) {
    const drainInterval = state.nightmareTimeSurvived >= 60 ? 0.75 : 1;
    state.nightmareStaminaDrainTimer += dt;
    while (state.nightmareStaminaDrainTimer >= drainInterval) {
      state.nightmareStaminaDrainTimer -= drainInterval;
      state.player.maxStaminaCap = Math.max(20, state.player.maxStaminaCap - 1);
      state.player.maxStamina = Math.min(state.player.maxStamina, state.player.maxStaminaCap);
      state.player.stamina = Math.min(state.player.stamina, state.player.maxStaminaCap);
    }
  }

  // Process a defeated primary enemy (flag set in applyHit when stamina bottoms out)
  if (state.nightmareEnemyDefeated) {
    state.nightmareEnemyDefeated = false;
    const _elapsed = state.nightmareTimeSurvived - state.nightmareEnemyActiveSince;
    if (_elapsed < 10) {
      state.nightmareVeryQuickKOs++;
    } else if (_elapsed < 20) {
      state.nightmareQuickKOs++;
    }
    state.player.moveSpeed *= 1.02;
    state.nightmareKillCount++;
    state.roundTimer += NIGHTMARE_DEFEAT_BONUS_TIME;
    soundEngine.knockdown();
    state.nightmareSpawnDelay = 1.0;
    if (state.nightmareRegenBoostTimer > 0) {
      state.nightmareRegenBoostMult += 1.5;
      state.nightmareRegenBoostTimer += 1.0;
    } else {
      state.nightmareRegenBoostMult = 3.0;
      state.nightmareRegenBoostTimer = 5.0;
    }
    if (state.nightmareEnemies.length > 0) {
      let nearestIdx = 0;
      let nearestDist = Infinity;
      for (let i = 0; i < state.nightmareEnemies.length; i++) {
        const d = getDistance(state.player, state.nightmareEnemies[i]);
        if (d < nearestDist) { nearestDist = d; nearestIdx = i; }
      }
      state.enemy = state.nightmareEnemies[nearestIdx];
      state.aiBrain = state.nightmareAiBrains[nearestIdx];
      state.nightmareEnemies.splice(nearestIdx, 1);
      state.nightmareAiBrains.splice(nearestIdx, 1);
      state.careerEnemyRefinement = state.enemy.refinementLevels ?? {};
      // Replacement spawn delayed by 1 second — handled by periodic spawn below
    } else {
      const spawned = buildNightmareEnemy(state);
      state.enemy = spawned.fighter;
      state.aiBrain = spawned.brain;
      state.careerEnemyRefinement = state.enemy.refinementLevels ?? {};
    }
    state.enemy.isKnockedDown = false;
    state.enemyColors = { ...state.enemy.colors };
    state.nightmareEnemyActiveSince = state.nightmareTimeSurvived;
  }

  // Count-down spawn delay and regen boost (both set on defeat)
  if (state.nightmareSpawnDelay > 0) {
    state.nightmareSpawnDelay = Math.max(0, state.nightmareSpawnDelay - dt);
  }
  if (state.nightmareRegenBoostTimer > 0) {
    state.nightmareRegenBoostTimer = Math.max(0, state.nightmareRegenBoostTimer - dt);
    if (state.nightmareRegenBoostTimer === 0) {
      state.nightmareRegenBoostMult = 0;
    }
  }

  // Periodic spawn: interval starts at 25s and decreases by 3 on each spawn (min 10s)
  state.nightmareSpawnTimer += dt;
  const nmTotalAI = 1 + state.nightmareEnemies.length;
  if (state.nightmareSpawnTimer >= state.nightmareCurrentSpawnInterval && state.nightmareSpawnDelay <= 0 && nmTotalAI < 9) {
    state.nightmareSpawnTimer -= state.nightmareCurrentSpawnInterval;
    state.nightmareCurrentSpawnInterval = Math.max(10, state.nightmareCurrentSpawnInterval - 3);
    const spawned = buildNightmareEnemy(state);
    state.nightmareEnemies.push(spawned.fighter);
    state.nightmareAiBrains.push(spawned.brain);
  }

  // Auto-target: make the nearest enemy the primary the player is fighting
  if (!state.player.isPunching && state.nightmareEnemies.length > 0) {
    let bestIdx = -1;
    let bestDist = getDistance(state.player, state.enemy);
    for (let i = 0; i < state.nightmareEnemies.length; i++) {
      const d = getDistance(state.player, state.nightmareEnemies[i]);
      if (d < bestDist - 25) { bestDist = d; bestIdx = i; }
    }
    if (bestIdx >= 0) {
      const oldEnemy = state.enemy;
      const oldBrain = state.aiBrain;
      state.enemy = state.nightmareEnemies[bestIdx];
      state.aiBrain = state.nightmareAiBrains[bestIdx];
      state.nightmareEnemies[bestIdx] = oldEnemy;
      state.nightmareAiBrains[bestIdx] = oldBrain;
      state.enemyColors = { ...state.enemy.colors };
      state.careerEnemyRefinement = state.enemy.refinementLevels ?? {};
    }
  }

  // Update each extra enemy by temporarily swapping it into the primary slot
  const savedEnemy = state.enemy;
  const savedBrain = state.aiBrain;
  for (let i = 0; i < state.nightmareEnemies.length; i++) {
    const extra = state.nightmareEnemies[i];
    const brain = state.nightmareAiBrains[i];
    if (!brain) continue;
    extra.isKnockedDown = false;
    state.enemy = extra;
    state.aiBrain = brain;
    updateAILegacy(state, dt);
    updatePunch(extra, state.player, state, dt);
    updateRhythm(extra, dt);
    updateFatigue(extra, dt, state);
    updateBob(extra, dt, state);
    updateDefense(extra, dt, state.practiceMode);
    updatePunchAnimation(extra);
    updateFighterTelegraph(extra, state, "enemy", dt);
    if (extra.facingLockTimer > 0) {
      extra.facingLockTimer -= dt;
      if (extra.facingLockTimer < 0) extra.facingLockTimer = 0;
    }
    if (extra.turnDelayZeroTimer > 0) {
      extra.turnDelayZeroTimer -= dt;
      if (extra.turnDelayZeroTimer < 0) extra.turnDelayZeroTimer = 0;
    }
    if (extra.stunFacingSlowTimer > 0) {
      extra.stunFacingSlowTimer -= dt;
      if (extra.stunFacingSlowTimer <= 0) {
        extra.stunFacingSlowTimer = 0;
        extra.stunFacingTurnDelay = 0;
      }
    }
    tickSlip(extra, dt);
    turnFacingToward(extra, state.player.x, state.player.z, dt);
    if (extra.facingLockTimer <= 0) {
      const extraTargetFacing = (extra.x < state.player.x ? 1 : -1) as 1 | -1;
      if (extra.facing !== extraTargetFacing && extra.facingPendingTimer <= 0) {
        extra.facingPendingTimer = facingTurnDuration(extra);
      }
      if (extra.facingPendingTimer > 0) {
        extra.facingPendingTimer -= dt;
        if (extra.facingPendingTimer < 0) extra.facingPendingTimer = 0;
      }
      applyBodySideFacing(extra);
    }
    extra.x = Math.max(RING_LEFT + 10, Math.min(RING_RIGHT - 10, extra.x));
    extra.z = Math.max(RING_TOP + 10, Math.min(RING_BOTTOM - 10, extra.z));
  }
  state.enemy = savedEnemy;
  state.aiBrain = savedBrain;
}

function handlePlayerInput(player: FighterState, enemy: FighterState, state: GameState, dt: number): void {
  if (player.isKnockedDown || state.knockdownActive || state.phase !== "fighting") return;

  const shiftHeld = keys["shift"];
  const tabHeld = keys["tab"];

  // Slip (hold C, aim with the arrows). Runs ahead of movement: while it is held
  // the arrows aim the slip instead of walking, so the fighter is pinned in place
  // from the same frame the key goes down. Tab+C still cycles stance.
  {
    const slipHeld = !!keys["c"] && !tabHeld;
    const aimed: SlipDir | null =
      keys["arrowleft"] ? "left" :
      keys["arrowright"] ? "right" :
      keys["arrowup"] ? "forward" :
      keys["arrowdown"] ? "back" : null;
    if (!slipHeld) player.slipKeyWasUp = true;
    if (player.slipActive) {
      // Letting go ends the slip, and it is settled first: the arrows only aim a
      // slip that is still held, so releasing with an arrow down is not a re-aim
      // and is not charged as one.
      if (!slipHeld) endSlip(player);
      // Re-aimable mid-slip: the arrows send the head across to the new side
      // rather than teleporting it, and that crossover has to complete before
      // the slip is dodging anything again.
      else if (aimed) redirectSlip(player, aimed);
    } else if (slipHeld && player.slipKeyWasUp && player.slipDisabledTimer <= 0) {
      // Unaimed slips go backwards — off the punch line and out of range.
      startSlip(player, aimed ?? "back");
      player.slipKeyWasUp = false;
    }
  }

  let moveX = 0;
  let moveZ = 0;
  if (!player.slipActive) {
    if (keys["arrowleft"] && !tabHeld) moveX -= 1;
    if (keys["arrowright"] && !tabHeld) moveX += 1;
    if (keys["arrowup"]) moveZ -= 1;
    if (keys["arrowdown"]) moveZ += 1;
  }

  if (moveX !== 0 || moveZ !== 0) {
    const mag = Math.sqrt(moveX * moveX + moveZ * moveZ);
    moveX /= mag;
    moveZ /= mag;

    if (player.limbContactPinned) {
      [moveX, moveZ] = stripMoveTowardOpponent(player, enemy, moveX, moveZ);
    }
    if (enemy.feintTouchingOpponent) {
      const toEnemyX = enemy.x - player.x;
      const toEnemyZ = enemy.z - player.z;
      const toEnemyLen = Math.sqrt(toEnemyX * toEnemyX + toEnemyZ * toEnemyZ);
      if (toEnemyLen > 0.01) {
        const dot = (moveX * toEnemyX + moveZ * toEnemyZ) / toEnemyLen;
        if (dot > 0 && player.defenseState !== "duck") {
          const nX = toEnemyX / toEnemyLen;
          const nZ = toEnemyZ / toEnemyLen;
          moveX -= dot * nX;
          moveZ -= dot * nZ;
        }
      }
    }
    if (enemy.feintDuckTouchingOpponent) {
      const toEnemyX = enemy.x - player.x;
      const toEnemyZ = enemy.z - player.z;
      const toEnemyLen = Math.sqrt(toEnemyX * toEnemyX + toEnemyZ * toEnemyZ);
      if (toEnemyLen > 0.01) {
        const dot = (moveX * toEnemyX + moveZ * toEnemyZ) / toEnemyLen;
        if (dot > 0) {
          const nX = toEnemyX / toEnemyLen;
          const nZ = toEnemyZ / toEnemyLen;
          moveX -= dot * nX;
          moveZ -= dot * nZ;
        }
      }
    }

    let speedMod = 1;
    speedMod *= player.moveSlowMult;
    if (player.stance === "frontFoot") speedMod *= 1.07;
    if (player.stance === "backFoot") speedMod *= 1.07;
    if (state.fatigueEnabled) {
      speedMod *= Math.max(0.5, 1 - Math.floor(player.punchesThrown / 50) * 0.0025);
    }
    if (player.guardDownSpeedBoost > 0) speedMod *= (1 + player.guardDownSpeedBoost);
    if (enemy.telegraphPhase !== "none" && getDistance(player, enemy) < 150) speedMod *= 1.5;
    // A stun stops the feet outright. Applied last so nothing above -- including
    // the telegraph closing burst -- can multiply movement back in.
    if (player.stunMoveFreezeTimer > 0) speedMod = 0;

    player.x += moveX * player.moveSpeed * dt * speedMod;
    player.z += moveZ * player.moveSpeed * dt * speedMod;
    // Charged only for footwork the player actually produced: movement keys are
    // held (the enclosing branch), the feet aren't frozen by a stun, and the
    // touching-opponent projection above hasn't cancelled the direction outright.
    const walkMag = Math.sqrt(moveX * moveX + moveZ * moveZ);
    if (speedMod > 0 && walkMag > 0.01) accrueRingMileage(player, dt);
  }
  clampToDiamond(player);

  // Orientation is not set here. Both corners turn through the one rate-limited
  // update in the main tick, so the turn delay applies to the player's rendered
  // geometry instead of being overwritten by an instant snap every frame.

  if (consumePress("x")) {
    player.rhythmLevel = Math.min(4, player.rhythmLevel + 1);
  }
  if (consumePress("z")) {
    player.rhythmLevel = Math.max(0, player.rhythmLevel - 1);
  }
  // Tab+C: C on its own is the slip key now.
  if (tabHeld && consumePress("c")) {
    if (player.rhythmLevel > 0) {
      const stances: StanceType[] = ["backFoot", "neutral", "frontFoot"];
      const idx = stances.indexOf(player.stance);
      player.stance = stances[(idx + 1) % stances.length];
    }
  }

  if (tabHeld && consumePress("arrowright")) {
    player.swaySpeedLevel = Math.min(5, player.swaySpeedLevel + 1);
    if (state.tutorialMode) state.tutorialTracking.rhythmChangeCount++;
  }
  if (tabHeld && consumePress("arrowleft")) {
    player.swaySpeedLevel = Math.max(0, player.swaySpeedLevel - 1);
    if (state.tutorialMode) state.tutorialTracking.rhythmChangeCount++;
  }

  const spaceHeld = keys[" "];
  const spaceRisingEdge = spaceHeld && player.spaceWasUp;
  if (!spaceHeld) {
    player.spaceWasUp = true;
  } else if (spaceRisingEdge) {
    player.spaceWasUp = false;
    const now = performance.now() / 1000;
    if (player.autoGuardActive) {
      player.autoGuardActive = false;
      player.autoGuardTimer = 0;
    } else if (now - player.lastSpacePressTime <= 0.3 && player.autoGuardDuration > 0) {
      player.autoGuardActive = true;
      player.autoGuardTimer = player.autoGuardDuration;
      if (state.tutorialMode) {
        state.tutorialTracking.autoGuardActivated = true;
      }
    }
    player.lastSpacePressTime = now;
  }

  if (player.autoGuardActive) {
    player.autoGuardTimer -= dt;
    if (player.autoGuardTimer <= 0) {
      player.autoGuardActive = false;
      player.autoGuardTimer = 0;
      player.defenseState = "none";
      player.handsDown = true;
      player.guardBlend = 0;
    }
  }

  if (!player.isPunching && shiftHeld) {
    if (player.defenseState !== "duck") {
      const wasBlocking = player.defenseState === "fullGuard";
      if (wasBlocking) {
        player.preDuckBlockState = player.defenseState;
      }
      player.defenseState = "duck";
      player.punchAimsHead = false;
      if (state.tutorialMode) {
        state.tutorialTracking.duckCount++;
      }
    }
  } else if (player.defenseState === "duck" && !shiftHeld && !player.isPunching) {
    if (player.preDuckBlockState || player.autoGuardActive) {
      player.defenseState = "fullGuard";
    } else {
      player.defenseState = "none";
      player.handsDown = false;
    }
    player.preDuckBlockState = null;
    player.punchAimsHead = false;
  } else if (!player.isPunching && !shiftHeld) {
    if (player.autoGuardActive) {
      player.defenseState = "fullGuard";
    } else if (spaceHeld) {
      if (player.defenseState !== "fullGuard" && player.defenseState !== "duck") {
        player.defenseState = "fullGuard";
        if (state.tutorialMode) {
          state.tutorialTracking.guardToggled = true;
        }
      }
    } else {
      if (player.defenseState === "fullGuard") {
        player.defenseState = "none";
        player.handsDown = false;
      }
    }
  }

  if (player.autoGuardActive && player.autoGuardTimer > 0) {
    if (player.defenseState !== "duck" && !player.isPunching) {
      player.defenseState = "fullGuard";
      player.guardBlend = 1;
      player.handsDown = false;
    }
  }

  // Perfect block state machine (V key)
  // Rise: 100ms at Speed 1 → 75ms at Speed 200
  // Hold: 450ms at Defense 1 → 900ms at Defense 200 (3x the original 150→300ms)
  // Cooldown: none — re-armable as soon as the key comes back up.
  {
    const rightShiftHeld = !!keys["v"];
    const pbRiseDuration = 0.0333 - player.speedT * 0.00833;
    // Equipment Upgrades — Hand Wraps lengthen the hold.
    const pbMaxHold = (0.15 + player.defenseT * 0.15) * 3 * (player.perfectBlockHoldMult ?? 1);
    // No lockout between executions. The cooldown state is still entered and
    // passed straight through on the next tick, so the guard-drop cleanup at
    // the end of it keeps running; a fresh block is gated only by
    // perfectBlockKeyWasUp, i.e. by actually releasing and re-pressing.
    const pbCooldown = 0;

    if (player.isKnockedDown) {
      if (player.perfectBlockState === "rising" || player.perfectBlockState === "active") {
        player.perfectBlockState = "cooldown";
        player.perfectBlockCooldownTimer = pbCooldown;
        player.perfectBlockActive = false;
      }
    } else {
      switch (player.perfectBlockState) {
        case "idle":
          // Mutually exclusive with feinting — see isFeintEngaged for the other half.
          // A full-strength sway refuses the perfect block outright. Through
          // the damped sway a Reset leaves behind it works exactly as normal.
          if (rightShiftHeld && player.perfectBlockKeyWasUp && !isFeintEngaged(player) && !isFatigueSwayFull(player)) {
            player.perfectBlockState = "rising";
            player.perfectBlockRiseTimer = 0;
            player.perfectBlockHoldTimer = pbMaxHold;
            player.perfectBlockKeyWasUp = false;
          }
          break;
        case "rising":
          player.perfectBlockRiseTimer += dt;
          if (!player.isPunching && player.defenseState !== "duck") {
            player.defenseState = "fullGuard";
          }
          if (!rightShiftHeld || isFeintEngaged(player)) {
            player.perfectBlockState = "cooldown";
            player.perfectBlockCooldownTimer = pbCooldown;
          } else if (player.perfectBlockRiseTimer >= pbRiseDuration) {
            player.perfectBlockState = "active";
            player.perfectBlockActive = true;
          }
          break;
        case "active": {
          // Rhythm vulnerability puts the block on hold instead of burning it:
          // the timer freezes and the window shuts until the marker leaves the
          // green zone. Guard Master 100 blocks straight through it.
          const pbPaused = isPerfectBlockRhythmPaused(player, enemy);
          player.perfectBlockActive = !pbPaused;
          if (!pbPaused) player.perfectBlockHoldTimer -= dt;
          if (!player.isPunching && player.defenseState !== "duck") {
            player.defenseState = "fullGuard";
          }
          if (!rightShiftHeld || isFeintEngaged(player) || player.perfectBlockHoldTimer <= 0) {
            player.perfectBlockState = "cooldown";
            player.perfectBlockCooldownTimer = pbCooldown;
            player.perfectBlockActive = false;
          }
          break;
        }
        case "cooldown":
          player.perfectBlockCooldownTimer -= dt;
          if (player.perfectBlockCooldownTimer <= 0) {
            player.perfectBlockState = "idle";
            player.perfectBlockCooldownTimer = 0;
            if (!player.autoGuardActive && !spaceHeld && !shiftHeld && player.defenseState === "fullGuard") {
              player.defenseState = "none";
              player.handsDown = false;
            }
          }
          break;
      }
    }
    if (!rightShiftHeld) player.perfectBlockKeyWasUp = true;
    player.perfectBlockTimer = 0;
    player.perfectBlockFlashTimer = 0;

    // Glove seek: smoothly slide toward attacker's punch height
    {
      let targetGloveYOffset = 0;
      // While directional, a standing block covers the head only, so the gloves stay
      // up; the ducking version is the one that drops to meet a body shot.
      if (player.perfectBlockState !== "idle" && (!state.directionalPerfectBlock || player.defenseState === "duck")) {
        if (enemy.isPunching && enemy.currentPunch) {
          const cfg = getEffectivePunchConfig(enemy.currentPunch);
          if (!cfg.hitsHead) targetGloveYOffset = 14; // body punch → gloves seek down
        }
      }
      const seekSpeed = 8.0;
      player.perfectBlockGloveYOffset += (targetGloveYOffset - player.perfectBlockGloveYOffset) * Math.min(1, seekSpeed * dt);
      if (Math.abs(player.perfectBlockGloveYOffset - targetGloveYOffset) < 0.3) {
        player.perfectBlockGloveYOffset = targetGloveYOffset;
      }
    }
  }

  if (player.defenseState === "duck" && player.autoGuardActive) {
    player.duckHoldTimer += dt;
    if (player.duckHoldTimer > 2.5 && player.duckDrainCooldown <= 0) {
      player.stamina = Math.max(1, player.stamina - player.maxStamina * 0.02);
      player.duckDrainCooldown = 0.5;
    }
  } else {
    if (player.duckHoldTimer > 2.5) {
      player.duckDrainCooldown = 1.0;
    }
    player.duckHoldTimer = 0;
  }
  if (player.duckDrainCooldown > 0) {
    player.duckDrainCooldown -= dt;
    if (player.duckDrainCooldown < 0) player.duckDrainCooldown = 0;
  }

  const perfectBlockBusy = isPerfectBlockEngaged(player);

  // Feints are ARMED, like a charge: tapping F readies one, and the next punch
  // launched inside FEINT_ARM_WINDOW goes out as a feint instead of a real shot.
  // Launching it spends the arm on the spot with no cooldown, so F can be tapped
  // again straight away. Tapping F while already armed restarts the window.
  if (consumePress("f")) {
    player.feintArmed = true;
    player.feintArmTimer = FEINT_ARM_WINDOW;
  } else if (player.feintArmed) {
    player.feintArmTimer = (player.feintArmTimer ?? 0) - dt;
    if (player.feintArmTimer <= 0) {
      player.feintArmed = false;
      player.feintArmTimer = 0;
    }
  }
  const feintArmed = !!player.feintArmed;

  // A feint stays out for as long as the punch key that sold it is held (up to
  // the hold cap). Letting that key go snaps the arm back through an ordinary
  // retraction, which the same arm can still turn into the real punch on its
  // way home. A feint sold on a release has no key down, so it snaps straight
  // back once it reaches full extension.
  if (player.isFeinting && player.punchPhase === "linger") {
    let feintKeyHeld = false;
    for (const k in feintSoldOnPress) {
      if (feintSoldOnPress[k] && keys[k]) { feintKeyHeld = true; break; }
    }
    if (!feintKeyHeld) startFeintRetraction(player);
  }

  // Right-Shift: stance switch (freely available, toggles between orthodox/southpaw)
  if (consumePress("shiftright") && !player.isPunching && !perfectBlockBusy) {
    const newStance: BoxingStance = player.boxingStance === "orthodox" ? "southpaw" : "orthodox";
    player.boxingStance = newStance;
    try { localStorage.setItem("handz_player_boxing_stance", newStance); } catch {}
    const opponentLevel = enemy.level;
    const switchChance = Math.min(0.95, Math.max(0.05, 0.50 + levelGapAdj("gapStanceSwitch", player.level - opponentLevel)));
    if (Math.random() < switchChance) {
      player.rhythmProgress = Math.random();
    }
    state.hitEffects.push({
      x: player.x,
      y: player.z - 35,
      timer: 0.9,
      type: "normal",
      text: "SWITCH",
      attackerColor: player.colors.gloves,
    });
  }

  if (consumePress("a") && !player.isPunching && player.chargeMeterBars >= 1) {
    if (player.chargeArmed) {
      player.chargeArmed = false;
      player.chargeUsesLeft = 0;
      player.chargeWhiffForgivenessLeft = 0;
      player.chargeArmTimer = 0;
    } else {
      player.chargeArmed = true;
      player.chargeUsesLeft = 2;
      player.chargeWhiffForgivenessLeft = player.technicianChargeWhiffForgiveness ?? 0;
      player.chargeFlashTimer = 0.15;
      player.chargeArmTimer = 1 + Math.min(1, (player.rawPower ?? 0) / 200) * 6;
    }
  }

  const chargeHeadTarget = player.chargeArmed && !player.isPunching ? 0.05 : 0;
  const chargeHeadSpeed = chargeHeadTarget > 0 ? 10.0 : 4.0;
  player.chargeHeadOffset += (chargeHeadTarget - player.chargeHeadOffset) * Math.min(1, chargeHeadSpeed * dt);
  if (Math.abs(player.chargeHeadOffset - chargeHeadTarget) < 0.001) player.chargeHeadOffset = chargeHeadTarget;

  if (player.isPunching && player.punchPhase === "retraction" && player.retractionProgress >= 0.25) {
    player.chargeHeadOffset *= 0.9;
  }

  const isCharged = player.chargeArmed;

  // Reset (B). Spent on the way UP, like a punch: the read is graded against
  // where the bout is when the key comes back up, not when it went down, so a
  // held key cannot bank a Reset and drop it into a window later. Always live:
  // a press mid-snap restarts the snap; refused only during a stun lock or a
  // knockdown.
  consumePress(RESET_KEY);
  if (consumeRelease(RESET_KEY)) {
    tryReset(player, state);
  }

  const punchKeys: [string, PunchType][] = player.boxingStance === "southpaw" ? [
    ["w", "cross"],
    ["e", "jab"],
    ["q", "rightHook"],
    ["r", "leftHook"],
    ["s", "rightUppercut"],
    ["d", "leftUppercut"],
  ] : [
    ["w", "jab"],
    ["e", "cross"],
    ["q", "leftHook"],
    ["r", "rightHook"],
    ["s", "leftUppercut"],
    ["d", "rightUppercut"],
  ];

  for (const [key, punch] of punchKeys) {
    // A real throw lands on the way UP, so nothing real commits until the key
    // comes back up. An armed feint is the exception: the punch key sells it on
    // the way DOWN, so feints come out as fast as the hand resets, and holding
    // that key holds the feint out. The release that follows a sold feint is
    // eaten rather than throwing a second shot. A key already down when F was
    // tapped still feints on its release, as long as the arm is live.
    // An input arriving too early in the sway is DROPPED, not queued for when
    // the arm catches up.
    const inputReady = (!perfectBlockBusy || shiftHeld) && !fatigueBlocksPunchInput(player);
    const soldOnPress = feintArmed && inputReady && consumePress(key);
    const releasedKey = consumeRelease(key);
    if (releasedKey && feintSoldOnPress[key]) {
      feintSoldOnPress[key] = false;
      break;
    }
    if ((soldOnPress || releasedKey) && inputReady) {
      if (state.tutorialMode) {
        const tt = state.tutorialTracking;
        if (punch === "jab") tt.threwJab = true;
        else if (punch === "cross") tt.threwCross = true;
        else if (punch === "leftHook") tt.threwLeftHook = true;
        else if (punch === "rightHook") tt.threwRightHook = true;
        else if (punch === "leftUppercut") tt.threwLeftUppercut = true;
        else if (punch === "rightUppercut") tt.threwRightUppercut = true;
      }
      // Whatever punch comes out while the arm is live is the feint.
      const asFeint = feintArmed;
      let charged = isCharged;
      if (charged && (state.roundDuration - state.roundTimer) < 10) charged = false;
      // A feint commits nothing — the charge is kept back for a real punch.
      if (asFeint) charged = false;
      const bodyShot = shiftHeld;

      if (enemy.feintTouchingOpponent || enemy.feintDuckTouchingOpponent) {
        const failChance = getFeintPunchFailChance(player, state);
        if (Math.random() < failChance) break;
      }

      // A feint already on its way back can be cashed in as the real punch, but
      // only by the arm that sold it: that hand carries on out of its own
      // retraction. The other hand isn't continuing anything, so it drops the
      // feint and starts a punch of its own from scratch.
      const feintRetracting = player.isPunching && player.isFeinting && player.punchPhase === "retraction";
      const sameArm = feintRetracting && !!player.currentPunch
        && isLeftArmPunch(player.currentPunch) === isLeftArmPunch(punch);
      const feintCancelReady = player.isFeinting && player.punchPhase === "linger" && !!player.technicianFeintCancelUnlocked;

      if (feintRetracting && !asFeint) {
        if (bodyShot) player.punchAimsHead = false;
        if (!sameArm) endFeintPunch(player);
        if (attemptPunch(player, punch, false, charged, sameArm, state.practiceMode, state.roundDuration - state.roundTimer, enemy)) {
          player.isFeinting = false;
          player.pendingPunchInput = null;
          state.roundStats.playerPunchesThisRound++;
          recordEvent(state, "punch", "player", { punch, feint: false, charged, body: bodyShot, rePunch: sameArm });
          if (sameArm && state.tutorialMode) state.tutorialTracking.punchFeintCount++;
        }
      } else if ((!player.isPunching || feintCancelReady) && player.telegraphPhase === "none" && player.postPunchLockoutTimer <= 0) {
        if (bodyShot) player.punchAimsHead = false;
        if (attemptPunch(player, punch, asFeint, charged, false, state.practiceMode, state.roundDuration - state.roundTimer, enemy)) {
          if (asFeint) {
            // Only a feint that actually launched spends the arm (and claims
            // its key's release). A refused one leaves the arm running, so the
            // key's release can still come out as the feint inside the window.
            if (soldOnPress) feintSoldOnPress[key] = true;
            player.feintArmed = false;
            player.feintArmTimer = 0;
          }
          player.pendingPunchInput = null;
          state.roundStats.playerPunchesThisRound++;
          recordEvent(state, asFeint ? "feint" : "punch", "player", { punch, feint: asFeint, charged, body: bodyShot, rePunch: false });
          if (asFeint && state.tutorialMode) state.tutorialTracking.feintCount++;
        }
      } else if (!asFeint) {
        // Gate is closed — buffer the input for up to 200ms. A feint is never
        // buffered: one that can't come out now is simply dropped.
        player.pendingPunchInput = punch as PunchType;
        player.pendingPunchInputTimer = 0.200;
        player.pendingPunchCharged = charged;
        player.pendingPunchBody = bodyShot;
      }
      break;
    }
  }
}

const JUDGE_WEIGHTS = [
  { cleanHits: 5.5,  damage: 3.2,  aggression: 0.45,  ringControl: 0.20,  defense: 0.15 },
  { cleanHits: 5.3,  damage: 3.4,  aggression: 0.55,  ringControl: 0.15,  defense: 0.10 },
  { cleanHits: 5.6,  damage: 3.0,  aggression: 0.35,  ringControl: 0.25,  defense: 0.20 },
];

function judgeRound(stats: GameState["roundStats"], bias: number, judgeIndex: number): JudgeScore {
  const w = JUDGE_WEIGHTS[judgeIndex] || JUDGE_WEIGHTS[0];
  const pLanded = stats.playerLandedThisRound;
  const eLanded = stats.enemyLandedThisRound;
  const pDmg = stats.playerDamageThisRound;
  const eDmg = stats.enemyDamageThisRound;
  const pKDs = stats.playerKDsThisRound;
  const eKDs = stats.enemyKDsThisRound;
  const pThrown = stats.playerPunchesThisRound || 1;
  const eThrown = stats.enemyPunchesThisRound || 1;

  const totalKDs = pKDs + eKDs;
  if (totalKDs > 0) {
    if (pKDs > eKDs) {
      return { player: 10, enemy: Math.max(7, 10 - pKDs) };
    } else if (eKDs > pKDs) {
      return { player: Math.max(7, 10 - eKDs), enemy: 10 };
    }
  }

  let pScore = 0;
  let eScore = 0;

  const cleanHitDiff = pLanded - eLanded;
  const totalLanded = pLanded + eLanded || 1;
  pScore += (cleanHitDiff / totalLanded) * w.cleanHits;
  eScore += (-cleanHitDiff / totalLanded) * w.cleanHits;

  const totalDmg = pDmg + eDmg || 1;
  const dmgDiff = (pDmg - eDmg) / totalDmg;
  pScore += dmgDiff * w.damage;
  eScore += -dmgDiff * w.damage;

  const pAggr = stats.playerAggressionTime;
  const eAggr = stats.enemyAggressionTime;
  const totalAggr = pAggr + eAggr || 1;
  pScore += ((pAggr - eAggr) / totalAggr) * w.aggression;
  eScore += ((eAggr - pAggr) / totalAggr) * w.aggression;

  const pRing = stats.playerRingControlTime;
  const eRing = stats.enemyRingControlTime;
  const totalRing = pRing + eRing || 1;
  pScore += ((pRing - eRing) / totalRing) * w.ringControl;
  eScore += ((eRing - pRing) / totalRing) * w.ringControl;

  const pDefEff = (stats.playerPunchesDodged + stats.playerPunchesBlocked) / (eThrown || 1);
  const eDefEff = (stats.enemyPunchesDodged + stats.enemyPunchesBlocked) / (pThrown || 1);
  pScore += (pDefEff - eDefEff) * w.defense;
  eScore += (eDefEff - pDefEff) * w.defense;

  pScore += bias;
  eScore -= bias;

  if (pScore > eScore) return { player: 10, enemy: 9 };
  if (eScore > pScore) return { player: 9, enemy: 10 };
  return { player: 10, enemy: 10 };
}

function scoreRound(state: GameState): RoundScore {
  const stats = state.roundStats;
  const pKDs = stats.playerKDsThisRound;
  const eKDs = stats.enemyKDsThisRound;
  const pThrown = stats.playerPunchesThisRound || 1;
  const eThrown = stats.enemyPunchesThisRound || 1;
  const pLanded = stats.playerLandedThisRound;
  const eLanded = stats.enemyLandedThisRound;
  const pLandedPct = Math.round((pLanded / pThrown) * 100);
  const eLandedPct = Math.round((eLanded / eThrown) * 100);

  const biases = [
    (Math.random() - 0.5) * 0.2,
    (Math.random() - 0.5) * 0.2,
    (Math.random() - 0.5) * 0.2,
  ];

  const judges: [JudgeScore, JudgeScore, JudgeScore] = [
    judgeRound(stats, biases[0], 0),
    judgeRound(stats, biases[1], 1),
    judgeRound(stats, biases[2], 2),
  ];

  let playerTotal = 0, enemyTotal = 0;
  judges.forEach(j => { playerTotal += j.player; enemyTotal += j.enemy; });
  const player = Math.round(playerTotal / 3);
  const enemy = Math.round(enemyTotal / 3);

  return {
    player,
    enemy,
    judges,
    playerKDsThisRound: pKDs,
    enemyKDsThisRound: eKDs,
    playerLandedPct: pLandedPct,
    enemyLandedPct: eLandedPct,
    playerDamage: Math.round(stats.playerDamageThisRound),
    enemyDamage: Math.round(stats.enemyDamageThisRound),
    playerLandedThisRound: stats.playerLandedThisRound,
    enemyLandedThisRound: stats.enemyLandedThisRound,
  };
}

function checkFastTwitchRoundBonus(state: GameState, roundScore: RoundScore): void {
  if (!state.careerFightMode || state.sparringMode) return;
  if (roundScore.player <= roundScore.enemy) return;
  const eThrown = state.roundStats.enemyPunchesThisRound;
  const eLanded = state.roundStats.enemyLandedThisRound;
  const eAcc = eThrown > 0 ? eLanded / eThrown : 0;
  if (eAcc < 0.40) {
    state.fightFastTwitchBonus = (state.fightFastTwitchBonus || 0) + 1;
  }
}

function getTotalPunchStats(state: GameState): { playerLanded: number; playerThrown: number; enemyLanded: number; enemyThrown: number } {
  let playerLanded = state.player.punchesLanded;
  let playerThrown = state.player.punchesThrown;
  let enemyLanded = state.enemy.punchesLanded;
  let enemyThrown = state.enemy.punchesThrown;
  return { playerLanded, playerThrown, enemyLanded, enemyThrown };
}

/**
 * A fighter who beats the count is never the same again — getting up costs the
 * tuning screen's knockdown amount for the rest of the bout, and every further
 * knockdown costs it again.
 *
 * Both the pool and its ceiling shrink, so regen and the long-fight cap drain
 * can't hand the stamina back. Call this *before* restoring the get-up stamina
 * so the loss comes off the pool the fighter gets up on. Applies to every
 * fighter in every mode; a fighter who is counted out never gets here.
 *
 * Charged as knockdown-attributed, which is what keeps a mouthguard from
 * shrugging off the cost of being dropped.
 */
function applyKnockdownStaminaDebuff(f: FighterState): void {
  applyMaxStaminaDelta(f, maxStamAmount(f, "knockdownSurvived"), { knockdownAttributed: true });
}

/**
 * Ends a bout the AI cannot continue. The knockdown and the referee's count
 * have already played out on screen by the time this runs — it only declares
 * the result, which is what releases the victory screen.
 */
function declareAiKo(state: GameState, result: "KO" | "TKO"): void {
  state.knockdownActive = false;
  state.refereeVisible = false;
  state.player.kdRegenBoostActive = false;
  state.enemy.kdRegenBoostActive = false;
  state.aiKoPendingResult = null;
  state.aiKoStopTime = -1;
  finalizeRoundRecording(state);
  rollNextRingCanvasColor();
  state.fightResult = result;
  state.fightWinner = "player";
  state.fightTotalDuckDodges += state.roundStats.playerDuckDodges;
  state.fightTotalCombos += state.roundStats.playerComboCount;
  state.xpGained = calculateXP(state);
  state.phase = "fightEnd";
  soundEngine.playCheer(3);
}

function checkMercyStoppage(state: GameState): boolean {
  if (!state.mercyStoppageEnabled || state.practiceMode || state.sparringMode) return false;
  const cfg = getStoppageConfig();
  if (state.totalEnemyKDs < cfg.mercyMinKds || state.totalEnemyKDs > cfg.mercyMaxKds) return false;
  const stats = getTotalPunchStats(state);
  const isCareer = !state.isQuickFight && !state.practiceMode && !state.sparringMode;
  const threshold = isCareer ? cfg.mercyRatioCareer : cfg.mercyRatioQuick;
  if (stats.enemyLanded === 0) return stats.playerLanded > 0;
  return stats.playerLanded >= stats.enemyLanded * threshold;
}

function checkTowelStoppage(state: GameState, dt: number): boolean {
  if (!state.towelStoppageEnabled || state.practiceMode || state.sparringMode) return false;
  const cfg = getStoppageConfig();
  if (state.currentRound < cfg.towelFirstRound) return false;

  const rs = state.roundStats;
  // Stoppage reads the bar, not the scorecard: the round figures the judges see
  // ignore the stamina floor, and the fight totals below are real bar movement,
  // so both halves of this comparison have to be the actual damage.
  const pRoundDmg = rs.playerActualDamageThisRound;
  const eRoundDmg = rs.enemyActualDamageThisRound;
  const pTotalDmg = state.player.damageDealt;
  const eTotalDmg = state.enemy.damageDealt;

  const roundPlayerRatio = eRoundDmg <= 0 ? 0 : pRoundDmg / eRoundDmg;
  const roundEnemyRatio = pRoundDmg <= 0 ? 0 : eRoundDmg / pRoundDmg;
  const totalPlayerRatio = eTotalDmg <= 0 ? 0 : pTotalDmg / eTotalDmg;
  const totalEnemyRatio = pTotalDmg <= 0 ? 0 : eTotalDmg / pTotalDmg;

  // Eased once per round past the first eligible one, but never below 1 — at 0
  // both corners read as dominating and the fight stops on the first tick of
  // the round. (At exactly 1, equal damage still qualifies and the tie falls to
  // the player, so a threshold that low is a deliberate setting, not a default.)
  const roundsPastFirst = Math.max(0, state.currentRound - cfg.towelFirstRound);
  const ratioThreshold = Math.max(1, cfg.towelDamageRatio - roundsPastFirst * cfg.towelRatioDropPerRound);

  const playerDominating = roundPlayerRatio >= ratioThreshold || totalPlayerRatio >= ratioThreshold;
  const enemyDominating = roundEnemyRatio >= ratioThreshold || totalEnemyRatio >= ratioThreshold;

  if (!playerDominating && !enemyDominating) return false;

  const losingFighter = playerDominating ? state.enemy : state.player;
  const dominantFighter = playerDominating ? state.player : state.enemy;
  const streak = dominantFighter.unansweredStreak;

  const scores = state.roundScores;
  if (scores.length >= 1) {
    const lastScore = scores[scores.length - 1];
    const pAvg = (lastScore.judges[0].player + lastScore.judges[1].player + lastScore.judges[2].player) / 3;
    const eAvg = (lastScore.judges[0].enemy + lastScore.judges[1].enemy + lastScore.judges[2].enemy) / 3;
    const loserWonLast = (losingFighter === state.player && pAvg > eAvg) || (losingFighter === state.enemy && eAvg > pAvg);
    if (loserWonLast) return false;
  }

  let hasImmunity = false;

  const loserDmg = losingFighter === state.player ? state.player.damageDealt : state.enemy.damageDealt;
  const domDmg = dominantFighter.damageDealt;
  if (domDmg > 0 && loserDmg >= domDmg * cfg.towelImmunityDamageShare) hasImmunity = true;

  const opponentKDLabel: "player" | "enemy" = losingFighter === state.player ? "enemy" : "player";
  let loserDealtKDsWithoutReceiving = 0;
  for (let i = state.kdSequence.length - 1; i >= 0; i--) {
    if (state.kdSequence[i] === opponentKDLabel) {
      loserDealtKDsWithoutReceiving++;
    } else {
      break;
    }
  }
  if (loserDealtKDsWithoutReceiving >= cfg.towelImmunityKds) hasImmunity = true;

  if (hasImmunity) {
    if (state.towelImmunityUsed) {
      hasImmunity = false;
    } else {
      state.towelImmunityUsed = true;
      return false;
    }
  }

  let loserRoundsWon = 0;
  for (const rs of scores) {
    const pAvg = (rs.judges[0].player + rs.judges[1].player + rs.judges[2].player) / 3;
    const eAvg = (rs.judges[0].enemy + rs.judges[1].enemy + rs.judges[2].enemy) / 3;
    if (losingFighter === state.player && pAvg > eAvg) loserRoundsWon++;
    if (losingFighter === state.enemy && eAvg > pAvg) loserRoundsWon++;
  }

  const baseChance = cfg.towelBaseChance * dt;
  const streakChance = streak * cfg.towelStreakChance * dt;
  const roundPenalty = loserRoundsWon * cfg.towelRoundWonPenalty * dt;
  let totalChance = Math.max(0, baseChance + streakChance - roundPenalty);
  const isCareer = !state.isQuickFight && !state.practiceMode && !state.sparringMode;
  if (isCareer) totalChance *= cfg.towelCareerMult;
  // Applied on top of the career reduction above, so career fights take both.
  totalChance *= cfg.towelGlobalMult;
  return Math.random() < totalChance;
}

/**
 * Career-only "early blitz" rule: dropping the OPPONENT twice within the first
 * 45 seconds of round 1 is an automatic stoppage KO, overriding whatever
 * difficulty/get-up parameters were rolled. The ref counts to a random point
 * between 4 and 9, then waves it off (ref stoppage overlay). Never applies to
 * the player being dropped, nor outside career fights.
 */
function maybeArmEarlyBlitzKo(state: GameState, knocked: FighterState): void {
  if (knocked.isPlayer) return;
  if (state.earlyBlitzKoActive) return;
  if (!state.careerFightMode || state.sparringMode || state.practiceMode || state.doghouseMode || state.isQuickFight) return;
  if (state.currentRound !== 1) return;
  if (state.roundDuration - state.roundTimer > 45) return;
  if (knocked.knockdowns < 2) return;
  state.earlyBlitzKoActive = true;
  state.aiKdWillGetUp = false; // overrides difficulty get-up roll
  state.earlyBlitzStopCount = 4 + Math.floor(aiRNG.range(0, 5.9999)); // count 4..9
}

function triggerRefStoppage(state: GameState, type: "mercy" | "towel"): void {
  state.refStoppageActive = true;
  state.refStoppageTimer = 1.0;
  state.refStoppageType = type;
  state.refereeVisible = true;

  const midX = (state.player.x + state.enemy.x) / 2;
  const midZ = (state.player.z + state.enemy.z) / 2;
  state.refX = midX;
  state.refZ = midZ;

  if (type === "towel") {
    state.towelActive = true;
    state.towelTimer = 1.0;
    state.towelStartX = RING_CX + RING_HALF_W;
    state.towelStartY = RING_CY;
    state.towelEndX = midX;
    state.towelEndY = midZ;
  }
}

function updateTutorial(state: GameState, dt: number): void {
  if (!state.tutorialMode) return;
  if (state.phase !== "fighting") return;

  const t = state.tutorialTracking;

  if (keys["arrowleft"]) t.movedLeft = true;
  if (keys["arrowright"]) t.movedRight = true;
  if (keys["arrowup"]) t.movedUp = true;
  if (keys["arrowdown"]) t.movedDown = true;

  if (state.tutorialPromptTimer > 0) {
    state.tutorialPromptTimer -= dt;
    if (state.tutorialPromptTimer <= 0) {
      state.tutorialPromptTimer = 0;
      if (state.tutorialFightUnlocked) {
        state.tutorialPrompt = "";
      }
    }
    return;
  }

  if (state.tutorialShowContinueButton) return;

  if (state.tutorialDelayTimer > 0) {
    state.tutorialDelayTimer -= dt;
    if (state.tutorialDelayTimer > 0) return;
    state.tutorialDelayTimer = 0;
  }

  if (state.tutorialStage === 1 && !state.tutorialFightUnlocked) {
    state.player.telegraphSpeedMult = 0.25;
  }

  if (state.tutorialStage === 1) {
    switch (state.tutorialStep) {
      case 1:
        state.tutorialPrompt = "Move with Arrow Keys";
        state.tutorialAiIdle = true;
        if (t.movedLeft && t.movedRight && t.movedUp && t.movedDown) {
          state.tutorialStep = 2;
          state.tutorialDelayTimer = 0.8;
          t.threwJab = false;
        }
        break;
      case 2:
        state.tutorialPrompt = "Jab with W";
        state.tutorialAiIdle = true;
        if (t.threwJab) {
          state.tutorialStep = 3;
          state.tutorialDelayTimer = 0.8;
          t.threwCross = false;
        }
        break;
      case 3:
        state.tutorialPrompt = "Cross with E";
        state.tutorialAiIdle = true;
        if (t.threwCross) {
          state.tutorialStep = 4;
          state.tutorialDelayTimer = 0.8;
          t.threwLeftHook = false;
          t.threwRightHook = false;
        }
        break;
      case 4:
        state.tutorialPrompt = "Throw Hooks with Q and R";
        state.tutorialAiIdle = true;
        if (t.threwLeftHook && t.threwRightHook) {
          state.tutorialStep = 5;
          state.tutorialDelayTimer = 0.8;
          t.threwLeftUppercut = false;
          t.threwRightUppercut = false;
        }
        break;
      case 5:
        state.tutorialPrompt = "Throw Uppercuts with S and D";
        state.tutorialAiIdle = true;
        if (t.threwLeftUppercut && t.threwRightUppercut) {
          state.tutorialStep = 6;
          state.tutorialDelayTimer = 0.8;
          t.punchesBlocked = 0;
          state.tutorialAiIdle = false;
        }
        break;
      case 6:
        state.tutorialPrompt = `Block by Holding Space (${t.punchesBlocked}/4)`;
        state.tutorialAiIdle = false;
        if (t.punchesBlocked >= 4) {
          state.tutorialStep = 7;
          state.tutorialDelayTimer = 0.8;
          t.duckCount = 0;
        }
        break;
      case 7:
        state.tutorialPrompt = `Duck by Holding Shift (${Math.min(t.duckCount, 3)}/3)`;
        state.tutorialAiIdle = false;
        if (t.duckCount >= 3) {
          state.tutorialStep = 8;
          state.tutorialDelayTimer = 0.8;
          state.tutorialShowContinueButton = true;
          state.tutorialPrompt = "Punch combos have a telegraph time when you haven't thrown in awhile, this time will decrease as you level up.";
          state.tutorialAiIdle = true;
        }
        break;
      case 8:
        break;
      case 9:
        break;
      case 10:
        state.tutorialPrompt = "";
        break;
    }
  } else if (state.tutorialStage === 2) {
    switch (state.tutorialStep) {
      case 1:
        state.tutorialPrompt = "Double Tap Space to Trigger Auto High Guard";
        state.tutorialAiIdle = true;
        if (t.autoGuardActivated) {
          state.tutorialStep = 2;
          state.tutorialDelayTimer = 0.8;
          t.feintCount = 0;
        }
        break;
      case 2:
        state.tutorialPrompt = `Tap F, then throw a punch (W/E/Q/R) within a second to feint it. This baits the opponent to throw and gives you a short bonus window on your next throw. (${t.feintCount}/2)`;
        state.tutorialAiIdle = true;
        if (t.feintCount >= 2) {
          state.tutorialStep = 3;
          state.tutorialDelayTimer = 0.8;
          t.punchFeintCount = 0;
        }
        break;
      case 3:
        state.tutorialPrompt = `Let a feint go, then throw it for real with the SAME arm while it is snapping back; this adjusts your timing and hits an opponent off-rhythm. (${t.punchFeintCount}/3)`;
        state.tutorialAiIdle = true;
        if (t.punchFeintCount >= 3) {
          state.tutorialStep = 4;
          state.tutorialDelayTimer = 0.8;
          t.guardToggled = false;
        }
        break;
      case 4:
        state.tutorialPrompt = "Tap Space to Toggle Guard States";
        state.tutorialAiIdle = true;
        if (t.guardToggled) {
          state.tutorialStep = 5;
          state.tutorialDelayTimer = 0.8;
          t.perfectBlockCount = 0;
        }
        break;
      case 5:
        state.tutorialPrompt = `Execute a Perfect Block with V (${t.perfectBlockCount}/3)`;
        state.tutorialAiIdle = false;
        if (t.perfectBlockCount >= 3) {
          state.tutorialStep = 6;
          state.tutorialDelayTimer = 0.8;
          t.rhythmChangeCount = 0;
        }
        break;
      case 6:
        state.tutorialPrompt = `Press Tab + Left and Right to Raise and Lower Rhythm Speed (${t.rhythmChangeCount}/5)`;
        state.tutorialAiIdle = true;
        if (t.rhythmChangeCount >= 5) {
          state.tutorialStep = 7;
          state.tutorialDelayTimer = 0.8;
          state.tutorialShowContinueButton = true;
          state.tutorialPrompt = "Hitting a fighter between their rhythm grants a punch effect bonus, as well as hitting at the beginning or end of your rhythm";
        }
        break;
      case 7:
        break;
      case 8:
        break;
      case 9:
        break;
      case 10:
        state.tutorialPrompt = "";
        break;
    }
  } else if (state.tutorialStage === 3) {
    if (!state.tutorialFightUnlocked) {
      if (state.player.stamina < 2) state.player.stamina = 2;
      if (state.enemy.stamina < 2) state.enemy.stamina = 2;
    }
    if (state.tutorialStep === 6 && state.tutorialTracking.rhythmHits < 5 && state.enemy.rhythmLevel !== 1) {
      state.enemy.rhythmLevel = 1;
    }
    switch (state.tutorialStep) {
      case 1:
        state.tutorialAiIdle = true;
        state.tutorialPrompt = "POWER: Each point boosts punch damage. More power means harder hits that drain your opponent's stamina faster.";
        state.tutorialShowContinueButton = true;
        break;
      case 2:
        break;
      case 3:
        break;
      case 4:
        break;
      case 5:
        break;
      case 6:
        state.tutorialAiIdle = false;
        state.tutorialPrompt = `Hit your opponent during their rhythm — watch the green zone on the enemy indicator bottom-right. (${t.rhythmHits}/5)`;
        if (t.rhythmHits >= 5) {
          state.tutorialStep = 7;
          state.tutorialDelayTimer = 0.4;
          state.tutorialAiIdle = true;
          state.tutorialShowContinueButton = true;
          state.tutorialPrompt = "Excellent rhythm timing! You've got it — now defeat your opponent!";
        }
        break;
      case 7:
        break;
      case 10:
        state.tutorialPrompt = "";
        break;
    }
  }
}

export function advanceTutorialContinue(state: GameState): void {
  if (state.tutorialStage === 1 && state.tutorialStep === 8) {
    state.tutorialShowContinueButton = false;
    state.tutorialStep = 9;
    state.tutorialShowContinueButton = true;
    state.tutorialPrompt = "Your Stamina is your lifeline. Punches cost a small amount of stamina, so be sure to punch with precision, this will cost less as you level up.";
  } else if (state.tutorialStage === 1 && state.tutorialStep === 9) {
    state.tutorialShowContinueButton = false;
    state.tutorialStep = 10;
    state.tutorialPrompt = "Beat Your Opponent!";
    state.tutorialPromptTimer = 2.0;
    state.tutorialFightUnlocked = true;
    state.tutorialAiIdle = false;
    state.player.telegraphSpeedMult = 1;
  } else if (state.tutorialStage === 2 && state.tutorialStep === 7) {
    state.tutorialShowContinueButton = false;
    state.tutorialStep = 8;
    state.tutorialShowContinueButton = true;
    state.tutorialPrompt = "The blue bar under your stamina is a Charge Punch Meter, it fills up when you land hits.";
  } else if (state.tutorialStage === 2 && state.tutorialStep === 8) {
    state.tutorialShowContinueButton = false;
    state.tutorialStep = 9;
    state.tutorialShowContinueButton = true;
    state.tutorialPrompt = "Get Close to the opponent, then Press A to activate Charge Punch when the bar is full, and throw a punch quickly to hurt your opponent!";
    if (state.player.chargeMeterBars < 1) {
      state.player.chargeMeterBars = 2;
      state.player.chargeMeterCounters = 0;
    }
  } else if (state.tutorialStage === 2 && state.tutorialStep === 9) {
    state.tutorialShowContinueButton = false;
    state.tutorialStep = 10;
    state.tutorialPrompt = "Defeat Your Opponent!";
    state.tutorialPromptTimer = 2.5;
    state.tutorialFightUnlocked = true;
    state.tutorialAiIdle = false;
  } else if (state.tutorialStage === 3 && state.tutorialStep === 1) {
    state.tutorialShowContinueButton = false;
    state.tutorialStep = 2;
    state.tutorialShowContinueButton = true;
    state.tutorialPrompt = "DEFENSE: Each point increases your auto-block chance and lets you dodge incoming punches entirely. Reduces damage taken.";
  } else if (state.tutorialStage === 3 && state.tutorialStep === 2) {
    state.tutorialShowContinueButton = false;
    state.tutorialStep = 3;
    state.tutorialShowContinueButton = true;
    state.tutorialPrompt = "SPEED: Increases movement and punch speed, reduces telegraph time, and narrows the green zone on your rhythm bar (bottom-left). Harder for opponents to time their hits against you.";
  } else if (state.tutorialStage === 3 && state.tutorialStep === 3) {
    state.tutorialShowContinueButton = false;
    state.tutorialStep = 4;
    state.tutorialShowContinueButton = true;
    state.tutorialPrompt = "STAMINA: Increases your total stamina pool and recovery rate. A larger stamina bar means more punches before tiring out.";
  } else if (state.tutorialStage === 3 && state.tutorialStep === 4) {
    state.tutorialShowContinueButton = false;
    state.tutorialStep = 5;
    state.tutorialShowContinueButton = true;
    state.tutorialPrompt = "FOCUS: Boosts stun and crit chance, reduces your miss rate, and widens the green zone on the enemy rhythm bar (bottom-right). Makes it easier to land high-impact hits through their guard.";
  } else if (state.tutorialStage === 3 && state.tutorialStep === 5) {
    state.tutorialShowContinueButton = false;
    state.tutorialStep = 6;
    state.tutorialAiIdle = false;
    state.tutorialTracking.rhythmHits = 0;
  } else if (state.tutorialStage === 3 && state.tutorialStep === 7) {
    state.tutorialShowContinueButton = false;
    state.tutorialStep = 10;
    state.tutorialPrompt = "Defeat Your Opponent!";
    state.tutorialPromptTimer = 2.5;
    state.tutorialFightUnlocked = true;
    state.tutorialAiIdle = false;
  }
}

const MOVE_DIR_EPS = 0.15;

// Classifies each fighter's movement relative to the opponent for this frame
// (forward = toward opponent, backward = away). Used by punch modifiers. The
// value lags one frame, which is imperceptible at gameplay framerates.
function updateMovementContext(state: GameState): void {
  const fighters: FighterState[] = [state.player, state.enemy];
  const fighting = state.phase === "fighting" && !state.knockdownActive && !state.isPaused;
  // Nightmare extras move through the same applyMovement path, but they get
  // swapped into the state.enemy slot later in the tick and so are not in
  // `fighters` here. Without their own reset the flag latches true after their
  // first accrual and they stop banking mileage until promoted to primary.
  if (state.nightmareEnemies) {
    for (const extra of state.nightmareEnemies) extra.mileageChargedThisTick = false;
  }
  for (const f of fighters) {
    // Cleared once per frame, ahead of every movement pass this tick.
    f.mileageChargedThisTick = false;
    const opp = f === state.player ? state.enemy : state.player;
    const vX = f.x - f.prevX;
    const vZ = f.z - f.prevZ;
    f.prevX = f.x;
    f.prevZ = f.z;
    if (!fighting || f.isKnockedDown) {
      f.currentMoveDir = "none";
      continue;
    }
    const toOppX = opp.x - f.x;
    const toOppZ = opp.z - f.z;
    const distToOpp = Math.sqrt(toOppX * toOppX + toOppZ * toOppZ);
    const moveMag = Math.sqrt(vX * vX + vZ * vZ);
    if (distToOpp <= 1 || moveMag < MOVE_DIR_EPS) {
      f.currentMoveDir = "none";
      continue;
    }
    // Project velocity onto the opponent axis; pure lateral movement (≈0
    // projection) stays "none" so circling doesn't read as forward/backward.
    const projectedSpeed = (vX * toOppX + vZ * toOppZ) / distToOpp;
    if (Math.abs(projectedSpeed) < MOVE_DIR_EPS) {
      f.currentMoveDir = "none";
      continue;
    }
    f.currentMoveDir = projectedSpeed > 0 ? "forward" : "backward";
    // The inertia sway travels the way the fighter last walked, so it still
    // needs that direction once the feet have already come to a stop.
    f.lastWalkDir = f.currentMoveDir;
  }
}

/**
 * Focus a player needs before they can read the opponent's tank shrinking.
 * At 1 this is effectively "always on" for anyone who has put a single point
 * into Focus; a fighter sitting on literally zero still does not see it.
 */
const AI_POOL_DRAIN_REVEAL_FOCUS = 1;
/** Two changes inside this window read as one bigger tick rather than stacking. */
const MAX_STAM_DELTA_TEXT_MERGE_WINDOW = 0.5;

/**
 * Your own pool is always legible; the opponent's is hidden information until
 * your Focus is high enough to read their condition.
 */
function canReadOpponentPool(state: GameState): boolean {
  return state.player.focusT * getScaling().caps.maxSp >= AI_POOL_DRAIN_REVEAL_FOCUS;
}

/**
 * Queues a tick beside a bar. `delta` is signed -- negative is tank taken away,
 * positive is tank handed back.
 *
 * Merging only ever combines ticks of the SAME direction. A loss and a gain
 * inside the same window would otherwise net toward zero and print a number that
 * matches neither event, or cancel out and print nothing at all.
 */
function pushMaxStaminaDelta(state: GameState, side: "player" | "enemy", delta: number): void {
  if (delta === 0) return;
  if (side === "enemy" && !canReadOpponentPool(state)) return;
  const recent = state.maxStaminaDeltaTexts.find(
    t => t.side === side
      && Math.sign(t.delta) === Math.sign(delta)
      && t.timer > MAX_STAMINA_DELTA_TEXT_LIFETIME - MAX_STAM_DELTA_TEXT_MERGE_WINDOW,
  );
  if (recent) {
    recent.delta += delta;
    recent.timer = MAX_STAMINA_DELTA_TEXT_LIFETIME;
    return;
  }
  state.maxStaminaDeltaTexts.push({ side, delta, timer: MAX_STAMINA_DELTA_TEXT_LIFETIME });
}

/**
 * Drives the "-N" / "+N" max-stamina ticks beside the stamina bars.
 *
 * This watches the pool rather than being called from each drain site. The
 * changes are spread across the accepted-punch path (which has no `state` and
 * whose call sites we do not want to re-thread), the clean-punches-taken
 * punishment, the perfect-block and charged-crit refunds, ring mileage and the
 * Nightmare trickle -- watching catches all of them, plus any added later, and it
 * reports exactly the change visible in the bar's cur/max readout rather than a
 * raw float delta that might not move the display at all.
 */
/**
 * The baseline lives on the FIGHTER, not on GameState, because `state.enemy` is
 * reassigned at eight sites (Doghouse queue, Nightmare spawn/re-select/restore).
 * A baseline held per-side would survive those swaps and read the incoming
 * fighter's smaller natural pool as the outgoing fighter's loss. Hanging it off
 * the fighter means a stranger walking into the corner is simply untracked, and
 * a familiar one (Nightmare re-select) resumes their own history exactly.
 */
function trackPoolFor(state: GameState, f: FighterState, side: "player" | "enemy"): void {
  const shown = Math.round(f.maxStamina);
  if (f.poolShown === undefined) {
    // First sight. For the bout's own fighters this is the first update tick, by
    // which point item mods, refinements and Doghouse scaling have all landed --
    // snapshotting back in createFighter would bank a pre-scaling number and fire
    // a bogus drop on the opening frame.
    f.poolShown = shown;
    // Anything still in flight on this side belonged to whoever they replaced.
    state.maxStaminaDeltaTexts = state.maxStaminaDeltaTexts.filter(t => t.side !== side);
    return;
  }
  // Signed: `shown` above the baseline is a gain, below it is a loss.
  pushMaxStaminaDelta(state, side, shown - f.poolShown);
  // Re-based in both directions: the perfect-block and charged-crit refunds hand
  // pool back, and a baseline left stranded above the pool would overstate the
  // next real drain.
  f.poolShown = shown;
}

function updateMaxStaminaDeltaTexts(state: GameState, dt: number): void {
  // A live GameState can predate this field -- HMR keeps the running fight's state
  // object across a reload, so it arrives `undefined` rather than defaulted.
  if (!state.maxStaminaDeltaTexts) state.maxStaminaDeltaTexts = [];

  trackPoolFor(state, state.player, "player");
  trackPoolFor(state, state.enemy, "enemy");

  state.maxStaminaDeltaTexts = state.maxStaminaDeltaTexts.filter(t => {
    t.timer -= dt;
    return t.timer > 0;
  });
}

export function updateGame(state: GameState, dt: number): GameState {
  gameElapsedTime += dt;
  // Snapshot the pool each corner walked in with, once per bout. Taken on the
  // first tick rather than in createFighter because every setup multiplier
  // (items, refinements, Doghouse/Nightmare scaling) lands before this runs.
  // It is the ceiling a charged crit/stun refund can restore the pool to.
  if (state.player.boutStartMaxStamina == null) state.player.boutStartMaxStamina = state.player.maxStamina;
  if (state.enemy.boutStartMaxStamina == null) state.enemy.boutStartMaxStamina = state.enemy.maxStamina;
  // Spacial gear streaks while its wearer walks the ring. Same conditions the
  // movement code uses, so the stars only run hot when the fighter really moves.
  setSpacialMotionBoost(
    state.phase === "fighting" &&
    !state.isPaused &&
    !state.knockdownActive &&
    !state.player.isKnockedDown &&
    (((keys["arrowleft"] || keys["arrowright"]) && !keys["tab"]) || keys["arrowup"] || keys["arrowdown"]),
  );
  updateMovementContext(state);
  if (consumePress("escape")) {
    if (state.isPaused) {
      if (state.pauseBoutDetailsTab) {
        state.pauseBoutDetailsTab = false;
      } else if (state.pauseControlsTab) {
        state.pauseControlsTab = false;
      } else if (state.pauseSoundTab) {
        state.pauseSoundTab = false;
      } else {
        state.isPaused = false;
        state.pauseAction = null;
        if (!state.practiceMode && !state.sparringMode) soundEngine.resumeCrowdAmbient();
      }
    } else if (state.phase === "fighting" || state.phase === "prefight") {
      state.isPaused = true;
      state.pauseSelectedIndex = 0;
      state.pauseAction = null;
      state.pauseSoundTab = false;
      state.pauseControlsTab = false;
      state.pauseBoutDetailsTab = false;
      if (!state.practiceMode && !state.sparringMode) soundEngine.pauseCrowdAmbient();
    }
    clearFrameInput();
    return state;
  }

  if (state.tutorialMode && state.tutorialShowContinueButton && consumePress("enter")) {
    soundEngine.uiClick();
    advanceTutorialContinue(state);
    clearFrameInput();
    return state;
  }

  if (state.isPaused) {
    if (state.pauseSoundTab || state.pauseControlsTab) {
      clearFrameInput();
      return state;
    }
    const isTutorialPause = state.tutorialMode;
    const isCareerPause = state.sparringMode || state.careerFightMode;
    const menuItems = isTutorialPause ? 2 : state.practiceMode ? 7 : isCareerPause ? 4 : 5;
    if (consumePress("arrowup")) {
      state.pauseSelectedIndex = (state.pauseSelectedIndex - 1 + menuItems) % menuItems;
    }
    if (consumePress("arrowdown")) {
      state.pauseSelectedIndex = (state.pauseSelectedIndex + 1) % menuItems;
    }
    if (consumePress("enter") || consumePress(" ")) {
      soundEngine.uiClick();
      if (isTutorialPause) {
        if (state.pauseSelectedIndex === 0) {
          state.pauseAction = "restart";
        } else if (state.pauseSelectedIndex === 1) {
          state.pauseAction = "quit";
        }
      } else if (state.practiceMode) {
        if (state.pauseSelectedIndex === 0) {
          state.isPaused = false;
          state.pauseAction = null;
        } else if (state.pauseSelectedIndex === 1) {
          state.cpuAttacksEnabled = !state.cpuAttacksEnabled;
        } else if (state.pauseSelectedIndex === 2) {
          state.cpuDefenseEnabled = !state.cpuDefenseEnabled;
        } else if (state.pauseSelectedIndex === 3) {
          state.pauseControlsTab = true;
        } else if (state.pauseSelectedIndex === 4) {
          state.pauseSoundTab = true;
        } else if (state.pauseSelectedIndex === 5) {
          state.pauseAction = "restart";
        } else if (state.pauseSelectedIndex === 6) {
          state.pauseAction = "quit";
        }
      } else {
        if (state.pauseSelectedIndex === 0) {
          state.isPaused = false;
          state.pauseAction = null;
          if (!state.practiceMode && !state.sparringMode) soundEngine.resumeCrowdAmbient();
        } else if (state.pauseSelectedIndex === 1) {
          state.pauseControlsTab = true;
        } else if (state.pauseSelectedIndex === 2) {
          state.pauseSoundTab = true;
        } else if (!isCareerPause && state.pauseSelectedIndex === 3) {
          state.pauseAction = "restart";
        } else if ((isCareerPause && state.pauseSelectedIndex === 3) || (!isCareerPause && state.pauseSelectedIndex === 4)) {
          state.pauseAction = "quit";
        }
      }
    }
    clearFrameInput();
    return state;
  }

  if (state.phase !== "fighting" && state.phase !== "prefight") { clearFrameInput(); return state; }

  if (state.phase === "prefight") {
    if (!state.practiceMode && !state.sparringMode) {
      soundEngine.startCrowdAmbient();
    }
    state.countdownTimer -= dt;
    if (state.countdownTimer <= 0) {
      state.phase = "fighting";
      state.countdownTimer = 0;
      clearAllKeys();
      resetIntroAnim(state);
      initRoundRecording(state);
      soundEngine.bell();
    }
    if (state.introAnimActive) {
      updateIntroAnim(state, dt);
    }
    updateRhythm(state.player, dt);
    updateRhythm(state.enemy, dt);
    updateBob(state.player, dt, state);
    updateBob(state.enemy, dt, state);
    updatePunchAnimation(state.player);
    updatePunchAnimation(state.enemy);
    clearFrameInput();
    return state;
  }

  if (state.crowdKdSpeedTimer > 0) {
    state.crowdKdSpeedTimer -= dt;
    if (state.crowdKdSpeedTimer < 0) state.crowdKdSpeedTimer = 0;
  }
  const lastPunchEither = Math.min(state.player.timeSinceLastPunch, state.enemy.timeSinceLastPunch);
  const hasCrowdScene = !state.practiceMode && !state.sparringMode;
  const isLastRound = state.currentRound >= state.totalRounds && hasCrowdScene;
  const timeElapsed = state.roundDuration - state.roundTimer;
  const lastRoundBoost = isLastRound && (timeElapsed <= 20 || state.roundTimer <= 20);
  let crowdSpeed = 1.0;
  if (state.crowdKdSpeedTimer > 0) {
    crowdSpeed = 3.0;
  } else if (state.crowdExciteTimer > 0) {
    crowdSpeed = 2.0;
  } else if (lastRoundBoost) {
    crowdSpeed = 2.0;
  } else if (lastPunchEither >= 5.0) {
    crowdSpeed = 0.5;
  }
  state.crowdBobTime += dt * crowdSpeed;
  if (state.crowdKdBounceTimer > 0) {
    state.crowdKdBounceTimer -= dt;
    if (state.crowdKdBounceTimer < 0) state.crowdKdBounceTimer = 0;
  }
  if (state.crowdExciteTimer > 0) {
    state.crowdExciteTimer -= dt;
    if (state.crowdExciteTimer <= 0) {
      state.crowdExciteTimer = 0;
      soundEngine.crowdCalm();
    }
  }

  if (state.hitstopTimer > 0) {
    state.hitstopTimer -= dt;
    if (state.hitstopTimer <= 0) state.hitstopTimer = 0;

    if (state.shakeTimer > 0) {
      state.shakeTimer -= dt;
      if (state.shakeTimer <= 0) state.shakeIntensity = 0;
    }

    if (state.bigShotTextTimer > 0) {
      state.bigShotTextTimer = Math.max(0, state.bigShotTextTimer - dt);
    }

    state.hitEffects = state.hitEffects.filter(e => {
      e.timer -= dt;
      return e.timer > 0;
    });
    updateMaxStaminaDeltaTexts(state, dt);

    updateFighterTelegraph(state.player, state, "player", dt);
    updateFighterTelegraph(state.enemy, state, "enemy", dt);

    updatePunchAnimation(state.player);
    updatePunchAnimation(state.enemy);

    clearFrameInput();
    return state;
  }

  if (state.shakeTimer > 0) {
    state.shakeTimer -= dt;
    if (state.shakeTimer <= 0) {
      state.shakeIntensity = 0;
    }
  }

  if (state.bigShotTextTimer > 0) {
    state.bigShotTextTimer = Math.max(0, state.bigShotTextTimer - dt);
  }

  state.hitEffects = state.hitEffects.filter(e => {
    e.timer -= dt;
    return e.timer > 0;
  });
  updateMaxStaminaDeltaTexts(state, dt);

  if (state.cornerWalkActive) {
    state.cornerWalkTimer -= dt;
    const pDistToCorner = Math.sqrt((state.player.x - PLAYER_CORNER_X) ** 2 + (state.player.z - PLAYER_CORNER_Z) ** 2);
    const eDistToCorner = Math.sqrt((state.enemy.x - ENEMY_CORNER_X) ** 2 + (state.enemy.z - ENEMY_CORNER_Z) ** 2);
    const playerAtCorner = pDistToCorner < 5;
    const enemyAtCorner = eDistToCorner < 5;

    if (!playerAtCorner && pDistToCorner > 0.1) {
      // Instantly snap player — never auto-walk the player without input
      state.player.x = PLAYER_CORNER_X;
      state.player.z = PLAYER_CORNER_Z;
    }
    if (!enemyAtCorner && eDistToCorner > 0.1) {
      const eDx = ENEMY_CORNER_X - state.enemy.x;
      const eDz = ENEMY_CORNER_Z - state.enemy.z;
      const eLen = Math.sqrt(eDx * eDx + eDz * eDz);
      state.enemy.x += (eDx / eLen) * CORNER_WALK_SPEED * dt;
      state.enemy.z += (eDz / eLen) * CORNER_WALK_SPEED * dt;
      if (Math.sqrt((state.enemy.x - ENEMY_CORNER_X) ** 2 + (state.enemy.z - ENEMY_CORNER_Z) ** 2) < 5) {
        state.enemy.x = ENEMY_CORNER_X;
        state.enemy.z = ENEMY_CORNER_Z;
      }
    }

    if ((playerAtCorner && enemyAtCorner) || state.cornerWalkTimer <= 0) {
      state.cornerWalkActive = false;
      state.player.x = PLAYER_CORNER_X;
      state.player.z = PLAYER_CORNER_Z;
      state.enemy.x = ENEMY_CORNER_X;
      state.enemy.z = ENEMY_CORNER_Z;

      const standingFighter = state.savedStandingIsPlayer ? state.player : state.enemy;
      standingFighter.defenseState = state.savedDefenseState;
      standingFighter.handsDown = false;
      standingFighter.blockTimer = state.savedBlockTimer;

      for (const f of [state.player, state.enemy]) {
        f.telegraphPhase = "none";
        f.telegraphTimer = 0;
        f.telegraphDuration = 0;
        f.isHit = false;
        f.hitTimer = 0;
        f.cleanHitEyeTimer = 0;
        f.critHitTimer = 0;
      }
    }

    clearFrameInput();
    return state;
  }

  if (state.refStoppageActive) {
    state.refStoppageTimer -= dt;
    if (state.refStoppageTimer <= 0) {
      finalizeRoundRecording(state);
      rollNextRingCanvasColor();
      state.phase = "fightEnd";
      // Early-blitz stoppages count as a full KO, not a TKO.
      state.fightResult = state.earlyBlitzKoActive ? "KO" : "TKO";
      state.fightWinner = "player";
      state.fightTotalDuckDodges += state.roundStats.playerDuckDodges;
      state.fightTotalCombos += state.roundStats.playerComboCount;
      state.xpGained = calculateXP(state);
      state.refStoppageActive = false;
      state.refereeVisible = false;
      state.towelActive = false;
      state.shakeIntensity = 0;
      state.shakeTimer = 0;
      if (!state.practiceMode && !state.sparringMode) {
        soundEngine.resumeCrowdAmbient();
        soundEngine.playCheer(2);
      }
    }
    clearFrameInput();
    return state;
  }

  if (state.kdFaceRefActive) {
    state.kdFaceRefTimer -= dt;
    if (state.kdFaceRefTimer <= 0) {
      state.kdFaceRefActive = false;
      if (state.kdTimerExpired) {
        finalizeRoundRecording(state);
        const roundScore = scoreRound(state);
        state.roundScores.push(roundScore);
        checkFastTwitchRoundBonus(state, roundScore);
        state.fightTotalDuckDodges += state.roundStats.playerDuckDodges;
        state.fightTotalCombos += state.roundStats.playerComboCount;
        if (state.currentRound >= state.totalRounds) {
          rollNextRingCanvasColor();
      state.phase = "fightEnd";
          let judgePlayerWins = 0;
          let judgeEnemyWins = 0;
          for (let ji = 0; ji < 3; ji++) {
            let pTotal = 0, eTotal = 0;
            state.roundScores.forEach(s => { pTotal += s.judges[ji].player; eTotal += s.judges[ji].enemy; });
            if (pTotal > eTotal) judgePlayerWins++;
            else if (eTotal > pTotal) judgeEnemyWins++;
          }
          if (judgePlayerWins > judgeEnemyWins) {
            state.fightResult = "Decision"; state.fightWinner = "player";
            if (!state.practiceMode && !state.sparringMode) soundEngine.playCheer(3);
          }
          else if (judgeEnemyWins > judgePlayerWins) { state.fightResult = "Decision"; state.fightWinner = "enemy"; }
          else { state.fightResult = "Draw"; state.fightWinner = null; }
          state.xpGained = calculateXP(state);
        } else {
          state.phase = "roundEnd";
        }
      } else {
        state.cornerWalkActive = true;
        state.cornerWalkTimer = 3.0;
        state.shakeIntensity = 0;
        state.shakeTimer = 0;
      }
    }
    clearFrameInput();
    return state;
  }

  if (state.knockdownActive) {
    const knockedFighter = state.player.isKnockedDown ? state.player : state.enemy;
    const standingFighter = state.player.isKnockedDown ? state.enemy : state.player;

    if (state.kdFallTimer < KD_FALL_DURATION) {
      // Fall animation still playing — the ref count doesn't start yet
      state.kdFallTimer += dt;
      state.knockdownRefCount = 0;
    } else {
      state.knockdownMashTimer -= dt;
      state.knockdownCountdown += dt;
      state.knockdownRefCount = Math.min(10, Math.floor(state.knockdownCountdown) + 1);
    }

    const timerMult = state.timerSpeed === "double" ? 2 : 1;
    if (!state.kdTimerExpired) {
      state.roundTimer -= dt * timerMult;
      if (state.roundTimer <= 0) {
        state.roundTimer = 0;
        state.kdTimerExpired = true;
      }
    }

    const slideSpeed = 150;
    const slideDx = state.standingFighterTargetX - standingFighter.x;
    const slideDz = state.standingFighterTargetZ - standingFighter.z;
    const slideDist = Math.sqrt(slideDx * slideDx + slideDz * slideDz);
    if (slideDist > 3 && !standingFighter.isPlayer) {
      standingFighter.x += (slideDx / slideDist) * slideSpeed * dt;
      standingFighter.z += (slideDz / slideDist) * slideSpeed * dt;
      if (Math.sqrt((state.standingFighterTargetX - standingFighter.x) ** 2 + (state.standingFighterTargetZ - standingFighter.z) ** 2) < 3) {
        standingFighter.x = state.standingFighterTargetX;
        standingFighter.z = state.standingFighterTargetZ;
      }
    } else if (slideDist > 3 && standingFighter.isPlayer) {
      // Snap player to target instantly — never auto-slide the player without input
      standingFighter.x = state.standingFighterTargetX;
      standingFighter.z = state.standingFighterTargetZ;
    }
    standingFighter.stamina = Math.min(standingFighter.maxStamina, standingFighter.stamina + standingFighter.staminaRegen * 3.0 * dt);

    const kdStaminaFrac = knockedFighter.knockdowns === 1 ? 0.60 : knockedFighter.knockdowns === 2 ? 0.40 : 0.25;

    if (standingFighter.regenPauseTimer <= 0 && standingFighter.staminaPauseFromRhythm <= 0) {
      standingFighter.stamina = Math.min(standingFighter.maxStamina, standingFighter.stamina + standingFighter.staminaRegen * 3 * dt);
    }

    let fighterGotUp = false;

    // Once the ref count reaches/shows 10 the fight is over — nobody beats a 10 count.
    // Get-up logic (mash or AI get-up timer) only runs while the count is 9 or less.
    if (state.knockdownRefCount >= 10) {
      // fall through to the KO handling below
    } else if (knockedFighter.isPlayer) {
      if (state.cpuVsCpu) {
        const autoMashRate = 8 + Math.random() * 6;
        state.knockdownMashCount += autoMashRate * dt;
      } else {
        if (keyJustPressed[" "]) {
          state.knockdownMashCount++;
          keyJustPressed[" "] = false;
        }
      }
      if (state.knockdownMashCount >= state.knockdownMashRequired) {
        fighterGotUp = true;
      }
    } else {
      // Early-blitz KO: ref waves it off at the pre-rolled count (4-9).
      if (state.earlyBlitzKoActive && state.knockdownRefCount >= state.earlyBlitzStopCount && state.knockdownRefCount <= 9) {
        state.knockdownActive = false;
        state.player.kdRegenBoostActive = false;
        state.enemy.kdRegenBoostActive = false;
        triggerRefStoppage(state, "mercy");
        clearFrameInput();
        return state;
      }
      if (state.aiKdWillGetUp && state.knockdownCountdown >= state.aiKdGetUpTime) {
        fighterGotUp = true;
      } else if (state.aiKoPendingResult && state.knockdownCountdown >= state.aiKoStopTime) {
        // Count window is up: the AI stayed down, so the fight is over now.
        declareAiKo(state, state.aiKoPendingResult);
        clearFrameInput();
        return state;
      }
    }

    if (fighterGotUp) {
      // Beating the count costs 10% of the stamina pool for the rest of the bout.
      applyKnockdownStaminaDebuff(knockedFighter);
      knockedFighter.isKnockedDown = false;
      knockedFighter.stamina = knockedFighter.maxStamina * kdStaminaFrac;
      knockedFighter.isPunching = false;
      knockedFighter.currentPunch = null;
      knockedFighter.punchPhase = null;
      knockedFighter.punchPhaseTimer = 0;
      knockedFighter.punchProgress = 0;
      knockedFighter.punchCooldown = 0;
      knockedFighter.isFeinting = false;
      knockedFighter.isCharging = false;
      knockedFighter.halfGuardPunch = false;
      knockedFighter.isRePunch = false;
      knockedFighter.retractionProgress = 0;
      knockedFighter.earlyRepunchPenaltyTimer = 0;
      knockedFighter.staminaPenaltyPending = false;
      knockedFighter.retractionPenaltyMult = 1;
      knockedFighter.feintCancelActive = false;
      knockedFighter.feintCancelPunchType = null;
      knockedFighter.feintCancelTimer = 0;
      knockedFighter.stunPunchDisableTimer = 0;
      knockedFighter.stunPunchSlowTimer = 0;
      knockedFighter.stunPunchSlowMult = 1;
      knockedFighter.stunBlockDisableTimer = 0;
      knockedFighter.stunBlockWeakenTimer = 0;
      endSlip(knockedFighter);
      cancelPendingSlip(knockedFighter);
      knockedFighter.slipDisabledTimer = 0;
      knockedFighter.slipChainTimer = 0;
      knockedFighter.slipChainCount = 0;
      knockedFighter.stunMoveFreezeTimer = 0;
      knockedFighter.fatigue.resetLockTimer = 0;
      knockedFighter.chargeReady = false;
      knockedFighter.chargeArmed = false;
      knockedFighter.chargeUsesLeft = 0;
      knockedFighter.chargeWhiffForgivenessLeft = 0;
      knockedFighter.chargeArmTimer = 0;
      knockedFighter.chargeHoldTimer = 0;
      // Nothing ticks during the count, so an armed feint would survive it.
      knockedFighter.feintArmed = false;
      knockedFighter.feintArmTimer = 0;
      knockedFighter.blockFlashTimer = 0;
      knockedFighter.defenseState = "none";

      for (const f of [knockedFighter, standingFighter]) {
        f.telegraphPhase = "none";
        f.telegraphTimer = 0;
        f.telegraphDuration = 0;
        f.isHit = false;
        f.hitTimer = 0;
        f.cleanHitEyeTimer = 0;
        f.critHitTimer = 0;
        // Drilled timers are armed for a second and nothing ticks while a
        // fighter is down, so an unspent one would resume after the count.
        f.drilledDodgeTimer = 0;
        f.drilledBurstPauseTimer = 0;
        f.drilledPunch = null;
      }
      resetDrilledForBreak(state);

      knockedFighter.rhythmLevel = state.kdSavedKnockedRhythmLevel;
      knockedFighter.rhythmProgress = 0;
      standingFighter.rhythmLevel = state.kdSavedStandingRhythmLevel;
      standingFighter.rhythmProgress = 0;

      state.knockdownActive = false;
      state.player.kdRegenBoostActive = false;
      state.enemy.kdRegenBoostActive = false;
      state.knockdownRefCount = 0;
      state.knockdownCountdown = 0;
      state.refereeVisible = false;
      state.crowdKdSpeedTimer = 10.0;

      if (state.kdTakeKnee && state.kdIsBodyShot) {
        state.kdFaceRefActive = true;
        state.kdFaceRefTimer = 1.0;
      } else if (state.kdTimerExpired) {
        finalizeRoundRecording(state);
        const roundScore = scoreRound(state);
        state.roundScores.push(roundScore);
        checkFastTwitchRoundBonus(state, roundScore);
        state.fightTotalDuckDodges += state.roundStats.playerDuckDodges;
        state.fightTotalCombos += state.roundStats.playerComboCount;
        if (state.currentRound >= state.totalRounds) {
          rollNextRingCanvasColor();
      state.phase = "fightEnd";
          let judgePlayerWins = 0;
          let judgeEnemyWins = 0;
          for (let ji = 0; ji < 3; ji++) {
            let pTotal = 0, eTotal = 0;
            state.roundScores.forEach(s => { pTotal += s.judges[ji].player; eTotal += s.judges[ji].enemy; });
            if (pTotal > eTotal) judgePlayerWins++;
            else if (eTotal > pTotal) judgeEnemyWins++;
          }
          if (judgePlayerWins > judgeEnemyWins) {
            state.fightResult = "Decision"; state.fightWinner = "player";
            if (!state.practiceMode && !state.sparringMode) soundEngine.playCheer(3);
          }
          else if (judgeEnemyWins > judgePlayerWins) { state.fightResult = "Decision"; state.fightWinner = "enemy"; }
          else { state.fightResult = "Draw"; state.fightWinner = null; }
          state.xpGained = calculateXP(state);
        } else {
          state.phase = "roundEnd";
        }
      } else {
        if (!knockedFighter.isPlayer && !state.practiceMode) {
          const shouldMercyStop = checkMercyStoppage(state);
          if (shouldMercyStop) {
            triggerRefStoppage(state, "mercy");
            clearFrameInput();
            return state;
          }
        }
        state.cornerWalkActive = true;
        state.cornerWalkTimer = 3.0;
        state.shakeIntensity = 0;
        state.shakeTimer = 0;
      }
    }

    if (state.knockdownRefCount >= 10 && state.knockdownActive) {
      if (state.doghouseMode && !knockedFighter.isPlayer) {
        state.doghouseOpponentsDefeated++;
        soundEngine.knockdown();
        const spawned = buildDoghouseEnemy(state);
        state.enemy = spawned.fighter;
        state.aiBrain = spawned.brain;
        state.enemyColors = { ...state.enemy.colors };
        state.knockdownActive = false;
        state.knockdownMashCount = 0;
        state.knockdownRefCount = 0;
        state.knockdownCountdown = 0;
        state.kdTimerExpired = false;
        state.refereeVisible = false;
        state.player.kdRegenBoostActive = false;
        state.enemy.kdRegenBoostActive = false;
        for (const f of [state.player, state.enemy]) {
          f.isPunching = false;
          f.currentPunch = null;
          f.punchPhase = null;
          f.punchPhaseTimer = 0;
          f.punchProgress = 0;
          f.isFeinting = false;
          f.isCharging = false;
          f.defenseState = "none";
        }
      } else if (state.practiceMode || state.sparringMode) {
        // Practice and sparring wave the count off instead of ending the bout,
        // but the fighter still got dropped — same permanent stamina cost.
        applyKnockdownStaminaDebuff(knockedFighter);
        knockedFighter.isKnockedDown = false;
        knockedFighter.stamina = Math.max(1, knockedFighter.maxStamina * 0.30);
        knockedFighter.isPunching = false;
        knockedFighter.currentPunch = null;
        knockedFighter.punchPhase = null;
        knockedFighter.punchPhaseTimer = 0;
        knockedFighter.punchProgress = 0;
        knockedFighter.punchCooldown = 0;
        knockedFighter.isFeinting = false;
        knockedFighter.isCharging = false;
        knockedFighter.halfGuardPunch = false;
        knockedFighter.isRePunch = false;
        knockedFighter.retractionProgress = 0;
        knockedFighter.earlyRepunchPenaltyTimer = 0;
        knockedFighter.staminaPenaltyPending = false;
        knockedFighter.retractionPenaltyMult = 1;
        knockedFighter.feintCancelActive = false;
        knockedFighter.feintCancelPunchType = null;
        knockedFighter.feintCancelTimer = 0;
        knockedFighter.stunPunchDisableTimer = 0;
        knockedFighter.stunPunchSlowTimer = 0;
        knockedFighter.stunPunchSlowMult = 1;
        knockedFighter.stunBlockDisableTimer = 0;
        knockedFighter.stunBlockWeakenTimer = 0;
        endSlip(knockedFighter);
        cancelPendingSlip(knockedFighter);
        knockedFighter.slipDisabledTimer = 0;
        knockedFighter.slipChainTimer = 0;
        knockedFighter.slipChainCount = 0;
        knockedFighter.stunMoveFreezeTimer = 0;
        knockedFighter.fatigue.resetLockTimer = 0;
        knockedFighter.chargeReady = false;
        knockedFighter.chargeArmed = false;
        knockedFighter.chargeUsesLeft = 0;
        knockedFighter.chargeWhiffForgivenessLeft = 0;
        knockedFighter.chargeArmTimer = 0;
        knockedFighter.chargeHoldTimer = 0;
        knockedFighter.feintArmed = false;
        knockedFighter.feintArmTimer = 0;
        knockedFighter.blockFlashTimer = 0;
        knockedFighter.defenseState = "none";

        for (const f of [knockedFighter, standingFighter]) {
          f.telegraphPhase = "none";
          f.telegraphTimer = 0;
          f.telegraphDuration = 0;
          f.isHit = false;
          f.hitTimer = 0;
          f.cleanHitEyeTimer = 0;
          f.critHitTimer = 0;
          // Same as the normal get-up: nothing ticked while they were down.
          f.drilledDodgeTimer = 0;
          f.drilledBurstPauseTimer = 0;
          f.drilledPunch = null;
        }
        resetDrilledForBreak(state);

        knockedFighter.rhythmLevel = state.kdSavedKnockedRhythmLevel;
        knockedFighter.rhythmProgress = 0;
        standingFighter.rhythmLevel = state.kdSavedStandingRhythmLevel;
        standingFighter.rhythmProgress = 0;

        state.knockdownActive = false;
        state.player.kdRegenBoostActive = false;
        state.enemy.kdRegenBoostActive = false;
        state.knockdownRefCount = 0;
        state.knockdownCountdown = 0;
        state.refereeVisible = false;
      } else if (!knockedFighter.isPlayer) {
        // A full ten count on the AI ends the bout on this frame, always. Only an
        // AI rolled to stay down gets a pre-armed stop window, and an AI rolled to
        // get up can still be overtaken by the count (get-up times run to 9.9s,
        // the count shows ten at 9.0s) — that case arrives here with no window
        // armed, and must not fall through to the generic 2-10s KO delay below
        // and sit on a finished count for several more seconds.
        declareAiKo(state, state.aiKoPendingResult ?? (knockedFighter.knockdowns >= 4 ? "TKO" : "KO"));
      } else {
        // First frame: arm the KO delay (2–10s) so the ref count stays visible
        if (state.koDelayTimer < 0) {
          state.koDelayTimer = 2 + Math.random() * 8;
          finalizeRoundRecording(state);
          rollNextRingCanvasColor();
          state.fightResult = "KO";
          state.fightWinner = knockedFighter.isPlayer ? "enemy" : "player";
          state.fightTotalDuckDodges += state.roundStats.playerDuckDodges;
          state.fightTotalCombos += state.roundStats.playerComboCount;
          state.xpGained = calculateXP(state);
        }
        state.koDelayTimer -= dt;
        if (state.koDelayTimer <= 0) {
          state.koDelayTimer = -1;
          state.phase = "fightEnd";
          state.knockdownActive = false;
          state.player.kdRegenBoostActive = false;
          state.enemy.kdRegenBoostActive = false;
          state.refereeVisible = false;
        }
      }
    }

    clearFrameInput();
    return state;
  }

  const timerMult = state.timerSpeed === "double" ? 2 : 1;
  if (!state.tutorialMode || state.tutorialFightUnlocked) {
    state.roundTimer -= dt * timerMult;
  }
  state.fightElapsedTime += dt;
  if (state.midFightLevelUpTimer > 0) state.midFightLevelUpTimer -= dt;

  if (state.recordInputs && state.inputRecording) {
    roundRecordingElapsed += dt;
    recordingAccumulator += dt;

    recordEvent(state, "pos", "player", {
      pFacing: state.player.facing,
      eFacing: state.enemy.facing,
      pDuck: state.player.defenseState === "duck" ? 1 : 0,
      eDuck: state.enemy.defenseState === "duck" ? 1 : 0,
      pGuard: state.player.defenseState === "guard" ? 1 : 0,
      eGuard: state.enemy.defenseState === "guard" ? 1 : 0,
      pPunch: state.player.isPunching ? (state.player.currentPunch || "?") : 0,
      ePunch: state.enemy.isPunching ? (state.enemy.currentPunch || "?") : 0,
      pKD: state.player.isKnockedDown ? 1 : 0,
      eKD: state.enemy.isKnockedDown ? 1 : 0,
      dt: Math.round(dt * 1000),
    });

    if (recordingAccumulator >= RECORD_MOVE_INTERVAL) {
      recordingAccumulator -= RECORD_MOVE_INTERVAL;
      recordEvent(state, "move", "player", {
        pDef: state.player.defenseState, pStance: state.player.stance, pRhythm: state.player.rhythmLevel,
        pPunching: state.player.isPunching, pPunch: state.player.currentPunch,
        eDef: state.enemy.defenseState, ePunching: state.enemy.isPunching, ePunch: state.enemy.currentPunch,
        eCharging: state.enemy.isCharging,
        aiPhase: state.aiBrain?.currentPhase || "none",
      });
    }
    if (state.player.defenseState !== lastPlayerDefState) {
      recordEvent(state, "defense", "player", { state: state.player.defenseState, prev: lastPlayerDefState });
      lastPlayerDefState = state.player.defenseState;
    }
    if (state.enemy.defenseState !== lastEnemyDefState) {
      recordEvent(state, "defense", "enemy", { state: state.enemy.defenseState, prev: lastEnemyDefState });
      lastEnemyDefState = state.enemy.defenseState;
    }
    if (state.player.chargeArmed) {
      recordEvent(state, "charge", "player", { armed: true, bars: state.player.chargeMeterBars });
    }
  }

  if (!state.refStoppageActive && !state.knockdownActive && checkTowelStoppage(state, dt)) {
    triggerRefStoppage(state, "towel");
    if (!state.practiceMode && !state.sparringMode) soundEngine.playCheer(3);
    clearFrameInput();
    return state;
  }

  if ((state.player.isKnockedDown || state.enemy.isKnockedDown) && !state.knockdownActive && state.phase === "fighting") {
    const knocked = state.player.isKnockedDown ? state.player : state.enemy;
    const standing = state.player.isKnockedDown ? state.enemy : state.player;
    state.knockdownActive = true;
    state.knockdownMashCount = 0;
    state.knockdownMashTimer = 10.0;
    state.knockdownRefCount = 0;
    state.knockdownCountdown = 0;
    state.kdTimerExpired = false;
    state.kdFallTimer = 0;
    state.kdIsBodyShot = false;
    state.kdTakeKnee = false;
    state.kdFaceRefActive = false;
    state.kdFaceRefTimer = 0;
    const kdCount = knocked.knockdowns;
    if (knocked.isPlayer) {
      state.knockdownMashRequired = kdCount === 1 ? 25 : kdCount === 2 ? 35 : 50;
    } else {
      state.knockdownMashRequired = kdCount <= 2 ? 25 : 45;
      if (!state.aiKdGetUpTime) {
        const chances = AI_KD_CHANCES[state.aiDifficulty] ?? AI_KD_CHANCES.contender;
        const rawGetUpChance = kdCount === 1 ? chances.kd1 : kdCount === 2 ? chances.kd2 : chances.kd3;
        const getUpChance = Math.max(0, rawGetUpChance - (state.aiKdChancePenalty ?? 0));
        state.aiKdWillGetUp = (state.practiceMode || state.sparringMode) ? true : aiRNG.chance(getUpChance);
        state.aiKdGetUpTime = kdCount === 1 ? aiRNG.range(2, 5) : kdCount === 2 ? aiRNG.range(4, 7) : aiRNG.range(6, 9);
      }
      maybeArmEarlyBlitzKo(state, knocked);
      state.kdEarlyStopCheckedCount = 0;
      // The main knockdown path usually armed this already — only roll a window
      // here if this bootstrap is the activation that started the count.
      if (state.aiKoPendingResult === null) {
        state.aiKoStopTime = -1;
        if (!state.aiKdWillGetUp && !state.earlyBlitzKoActive
            && !state.practiceMode && !state.sparringMode && !state.doghouseMode) {
          state.aiKoPendingResult = kdCount >= 4 ? "TKO" : "KO";
          state.aiKoStopTime = 2 + Math.random() * 8;
        }
      }
    }
    const neutralCorner = getFarthestNeutralCorner(knocked.x, knocked.z);
    state.standingFighterTargetX = neutralCorner.x;
    state.standingFighterTargetZ = neutralCorner.z;
    standing.isPunching = false;
    standing.currentPunch = null;
    standing.punchPhase = null;
    standing.punchPhaseTimer = 0;
    standing.punchCooldown = 0;
    standing.isFeinting = false;
    standing.isCharging = false;
    standing.chargeArmed = false;
    standing.chargeUsesLeft = 0;
    standing.chargeWhiffForgivenessLeft = 0;
    standing.chargeArmTimer = 0;
    standing.defenseState = "none";
    standing.punchProgress = 0;
    standing.telegraphPhase = "none";
    standing.telegraphTimer = 0;
    standing.telegraphIsLockout = false;
    standing.postPunchLockoutTimer = 0;
    standing.postPunchLockoutDuration = 0;
    standing.pendingPunchInput = null;
    standing.pendingPunchInputTimer = 0;
    state.refereeVisible = true;
    state.refX = knocked.x + 40;
    state.refZ = knocked.z - 20;
    clearFrameInput();
    return state;
  }

  updateLimbContact(state);
  if (state.cpuVsCpu) {
    updatePlayerAI(state, dt);
  } else {
    handlePlayerInput(state.player, state.enemy, state, dt);
  }
  if (state.tutorialMode && state.tutorialAiIdle) {
    state.enemy.defenseState = "none";
    state.enemy.handsDown = true;
  } else {
    updateAILegacy(state, dt);
  }
  if (state.tutorialMode) {
    updateTutorial(state, dt);
  }

  // Drilled Actions: the held-state links, the range gate, and the two timers
  // drilling owns. Its own path, not a hook into the AI's pattern memory.
  updateDrilledActions(state, dt);

  // Track how long each fighter has had their guard raised (for pop-up guard mechanic)
  for (const f of [state.player, state.enemy]) {
    if (f.defenseState !== "fullGuard") {
      f.timeSinceGuardRaised = 999;
    } else if (f.timeSinceGuardRaised >= 999) {
      f.timeSinceGuardRaised = 0; // just raised guard this frame
    } else {
      f.timeSinceGuardRaised += dt;
    }
  }

  if (state.adaptiveAiEnabled && state.behaviorProfile) {
    updateBehaviorProfile(state, dt);
    if (state.aiBrain) reviewAdaptiveMemory(state.aiBrain, dt);
    if (state.playerAiBrain) reviewAdaptiveMemory(state.playerAiBrain, dt);
  }
  // Decay AI stance-switch cooldown timer
  if (state.aiBrain && (state.aiBrain.stanceSwitchTimer || 0) > 0) {
    state.aiBrain.stanceSwitchTimer = Math.max(0, (state.aiBrain.stanceSwitchTimer || 0) - dt);
  }

  updateFighterTelegraph(state.player, state, "player", dt);
  updateFighterTelegraph(state.enemy, state, "enemy", dt);

  if (state.enemy.defenseState === "duck") {
    state.enemy.duckHoldTimer += dt;
    if (state.enemy.duckHoldTimer > 1.5 && state.enemy.duckDrainCooldown <= 0) {
      state.enemy.stamina -= state.enemy.maxStamina * 0.02 * dt;
      if (state.enemy.stamina < 1) state.enemy.stamina = 1;
    }
  } else {
    if (state.enemy.duckHoldTimer > 0) {
      state.enemy.duckDrainCooldown = 3.0;
    }
    state.enemy.duckHoldTimer = 0;
  }
  if (state.enemy.duckDrainCooldown > 0) {
    state.enemy.duckDrainCooldown -= dt;
  }

  const enforceDist = getDistance(state.player, state.enemy);
  if (enforceDist < MIN_DISTANCE && enforceDist > 0.01) {
    const overlap = MIN_DISTANCE - enforceDist;
    const sepDx = state.player.x - state.enemy.x;
    const sepDz = state.player.z - state.enemy.z;
    const sepLen = Math.sqrt(sepDx * sepDx + sepDz * sepDz);
    const nx = sepDx / sepLen;
    const nz = sepDz / sepLen;
    
    const playerAtWall = !isInsideDiamond(state.player.x, state.player.z, 30);
    const enemyAtWall = !isInsideDiamond(state.enemy.x, state.enemy.z, 30);

    if (playerAtWall && !enemyAtWall) {
      state.enemy.x -= nx * overlap;
      state.enemy.z -= nz * overlap;
    } else if (enemyAtWall && !playerAtWall) {
      state.player.x += nx * overlap;
      state.player.z += nz * overlap;
    } else {
      // Resolved exactly, no extra margin: a +1 px overshoot here pushed a
      // fighter walking in back past where they started every other tick,
      // which read as a jitter whenever the two walked into each other.
      const push = overlap / 2;
      state.player.x += nx * push;
      state.player.z += nz * push;
      state.enemy.x -= nx * push;
      state.enemy.z -= nz * push;
    }
  }
  clampToDiamond(state.player);
  clampToDiamond(state.enemy);

  [state.player, state.enemy].forEach(f => {
    if (f.punchCooldown > 0) f.punchCooldown -= dt;
    if (f.hitTimer > 0) f.hitTimer -= dt;
    if (f.cleanHitEyeTimer > 0) f.cleanHitEyeTimer = Math.max(0, f.cleanHitEyeTimer - dt);
    else f.isHit = false;
    // The post-Reset quiet outranks every blink there is: while it runs the
    // eyes stay open, any blink still owed is dropped, and the idle countdown
    // is held rather than spent, so the next natural blink comes at its own
    // pace once the quiet ends instead of firing the instant it does.
    if (f.blinkQuietTimer > 0) f.blinkQuietTimer = Math.max(0, f.blinkQuietTimer - dt);
    if (f.blinkQueued > 0) {
      if (f.blinkQuietTimer > 0) {
        f.blinkQueued = 0;
        f.blinkQueueTimer = 0;
      } else {
        f.blinkQueueTimer -= dt;
        if (f.blinkQueueTimer <= 0 && !f.isBlinking) {
          f.blinkQueued--;
          startBlink(f, stunLockBlinkLength());
        }
      }
    }
    if (f.isBlinking) {
      f.blinkDuration -= dt;
      if (f.blinkDuration <= 0) {
        f.isBlinking = false;
        const opp = f === state.player ? state.enemy : state.player;
        const bdx = f.x - opp.x;
        const bdz = f.z - opp.z;
        const bDist = Math.sqrt(bdx * bdx + bdz * bdz);
        const inRange = bDist < Math.max(f.armLength, opp.armLength) * 1.8;
        f.blinkTimer = inRange ? 10 + Math.random() * 5 : 4 + Math.random() * 4;
      }
    } else if (f.blinkQuietTimer <= 0) {
      f.blinkTimer -= dt;
      if (f.blinkTimer <= 0) {
        startBlink(f);
      }
    }
    if (f.critHitTimer > 0) f.critHitTimer -= dt;
    if (f.speedBoostTimer > 0) f.speedBoostTimer -= dt;
    if (f.blockRegenPenaltyTimer > 0) f.blockRegenPenaltyTimer -= dt;
    if (f.facingLockTimer > 0) {
      f.facingLockTimer -= dt;
      if (f.facingLockTimer < 0) f.facingLockTimer = 0;
    }
    if (f.turnDelayZeroTimer > 0) {
      f.turnDelayZeroTimer -= dt;
      if (f.turnDelayZeroTimer < 0) f.turnDelayZeroTimer = 0;
    }
    if (f.stunFacingSlowTimer > 0) {
      f.stunFacingSlowTimer -= dt;
      if (f.stunFacingSlowTimer <= 0) {
        f.stunFacingSlowTimer = 0;
        f.stunFacingTurnDelay = 0;
      }
    }
    if (f.moveSlowTimer > 0) {
      f.moveSlowTimer -= dt;
      if (f.moveSlowTimer <= 0) { f.moveSlowTimer = 0; f.moveSlowMult = 1; }
    }
    if (f.stunMoveFreezeTimer > 0) {
      f.stunMoveFreezeTimer -= dt;
      if (f.stunMoveFreezeTimer < 0) f.stunMoveFreezeTimer = 0;
    }
    tickSlip(f, dt);
    if (f.rhythmCutTimer > 0) {
      f.rhythmCutTimer -= dt;
      if (f.rhythmCutTimer <= 0) { f.rhythmCutTimer = 0; f.rhythmCutMult = 1.0; }
    }
    if (f.pushbackVx !== 0 || f.pushbackVz !== 0) {
      const decay = Math.pow(0.00001, dt);
      f.x += f.pushbackVx * dt;
      f.z += f.pushbackVz * dt;
      f.x = Math.max(RING_LEFT + 10, Math.min(RING_RIGHT - 10, f.x));
      f.z = Math.max(RING_TOP + 10, Math.min(RING_BOTTOM - 10, f.z));
      f.pushbackVx *= decay;
      f.pushbackVz *= decay;
      if (Math.abs(f.pushbackVx) < 1 && Math.abs(f.pushbackVz) < 1) {
        f.pushbackVx = 0;
        f.pushbackVz = 0;
      }
    }
    const guardIsDown = f.handsDown && !f.isPunching && !f.isFeinting && !f.isKnockedDown && !f.isHit;
    if (guardIsDown) {
      f.guardDownTimer += dt;
      if (f.guardDownTimer >= 1.0 && f.guardDownSpeedBoost === 0 && f.guardDownBoostTimer <= 0) {
        f.guardDownSpeedBoost = f.guardDownBoostMax;
        f.guardDownBoostTimer = 3.0;
      }
    } else {
      f.guardDownTimer = 0;
    }
    if (f.guardDownBoostTimer > 0) {
      if (f.isPunching || f.isFeinting || f.isHit || f.defenseState === "duck") {
        f.guardDownSpeedBoost = 0;
        f.guardDownBoostTimer = 0;
      } else {
        f.guardDownBoostTimer -= dt;
        if (f.guardDownBoostTimer <= 0) {
          f.guardDownSpeedBoost = 0;
          f.guardDownBoostTimer = 0;
        }
      }
    }
    if (f.telegraphSlowTimer > 0) {
      f.telegraphSlowTimer -= dt;
      if (f.telegraphSlowTimer <= 0) f.telegraphSlowTimer = 0;
    }
    if (f.stunBlockDisableTimer > 0) {
      f.stunBlockDisableTimer -= dt;
      if (f.stunBlockDisableTimer <= 0) f.stunBlockDisableTimer = 0;
    }
    if (f.stunBlockWeakenTimer > 0) {
      f.stunBlockWeakenTimer -= dt;
      if (f.stunBlockWeakenTimer <= 0) f.stunBlockWeakenTimer = 0;
    }
    if (f.chargeArmTimer > 0 && f.chargeArmed) {
      f.chargeArmTimer -= dt;
      if (f.chargeArmTimer <= 0) {
        f.chargeArmTimer = 0;
        f.chargeArmed = false;
        f.chargeUsesLeft = 0;
        f.chargeWhiffForgivenessLeft = 0;
        f.chargeMeterBars = Math.max(0, f.chargeMeterBars - 1);
      }
    }
    if (f.stunPunchDisableTimer > 0) {
      f.stunPunchDisableTimer -= dt;
      if (f.stunPunchDisableTimer <= 0) f.stunPunchDisableTimer = 0;
    }
    if (f.chargeMeterLockoutTimer > 0) {
      f.chargeMeterLockoutTimer -= dt;
      if (f.chargeMeterLockoutTimer <= 0) f.chargeMeterLockoutTimer = 0;
    }
    // KO Artist: the meter fills on its own while the fight is being fought. A
    // knockdown on either side stops it — the rate is per second of live boxing,
    // not of wall clock. The gain is fractional and stays in the sub-bar
    // counters until it rolls a whole bar, exactly like a landed punch's gain,
    // and a drained/locked meter is still locked.
    if ((f.koArtistChargeRate ?? 0) > 0
      && !state.knockdownActive
      && !f.isKnockedDown
      && f.chargeMeterLockoutTimer <= 0
      && f.chargeMeterBars < 6) {
      f.chargeMeterCounters += f.koArtistChargeRate! * dt;
      while (f.chargeMeterCounters >= 100 && f.chargeMeterBars < 6) {
        f.chargeMeterCounters -= 100;
        f.chargeMeterBars++;
      }
      if (f.chargeMeterBars >= 6) f.chargeMeterCounters = 0;
    }
    if (f.stunPunchSlowTimer > 0) {
      f.stunPunchSlowTimer -= dt;
      if (f.stunPunchSlowTimer <= 0) { f.stunPunchSlowTimer = 0; f.stunPunchSlowMult = 1; }
    }
    if (f.chargeEmpoweredTimer > 0) {
      f.chargeEmpoweredTimer -= dt;
      if (f.chargeEmpoweredTimer <= 0) f.chargeEmpoweredTimer = 0;
    }
    if (f.chargeCooldownTimer > 0) {
      f.chargeCooldownTimer -= dt;
      if (f.chargeCooldownTimer <= 0) f.chargeCooldownTimer = 0;
    }
    if (f.chargeReadyWindowTimer > 0) {
      f.chargeReadyWindowTimer -= dt;
      if (f.chargeReadyWindowTimer <= 0) { f.chargeReadyWindowTimer = 0; f.chargeReady = false; }
    }
    if (f.feintWhiffPenaltyCooldown > 0) {
      f.feintWhiffPenaltyCooldown -= dt;
      if (f.feintWhiffPenaltyCooldown <= 0) f.feintWhiffPenaltyCooldown = 0;
    }
    if (f.chargeFlashTimer > 0) {
      f.chargeFlashTimer -= dt;
      if (f.chargeFlashTimer <= 0) f.chargeFlashTimer = 0;
    }
    if (f.consecutiveChargeTimer > 0) {
      f.consecutiveChargeTimer -= dt;
      if (f.consecutiveChargeTimer <= 0) { f.consecutiveChargeTimer = 0; f.consecutiveChargeCount = 0; }
    }
    if (f.blockFlashTimer > 0) {
      f.blockFlashTimer -= dt;
      if (f.blockFlashTimer <= 0) f.blockFlashTimer = 0;
    }
    if (f.rhythmHitFlashTimer > 0) {
      f.rhythmHitFlashTimer -= dt;
      if (f.rhythmHitFlashTimer <= 0) f.rhythmHitFlashTimer = 0;
    }
    if (f.aiGuardDropTimer > 0) {
      f.aiGuardDropTimer -= dt;
      if (f.aiGuardDropTimer <= 0) { f.aiGuardDropTimer = 0; }
    }
    if (f.aiGuardDropCooldown > 0) {
      f.aiGuardDropCooldown -= dt;
      if (f.aiGuardDropCooldown <= 0) f.aiGuardDropCooldown = 0;
    }

    if (f.defenseState === "fullGuard") {
      if (f.autoGuardActive && f.autoGuardTimer > 0) {
        f.blockTimer = 0;
      } else {
        f.blockTimer += dt;
        if (f.blockTimer >= f.maxBlockDuration) {
          f.defenseState = "none";
          f.blockTimer = 0;
        }
      }
    }

    if (f.isPunching && f.defenseState === "fullGuard") {
      f.punchingWhileBlocking = true;
    } else if (!f.isPunching) {
      f.punchingWhileBlocking = false;
    }

    const rBuffs = getRhythmBuffs(f);
    const isNmBoostActive = state.nightmareMode && f.isPlayer && state.nightmareRegenBoostTimer > 0;
    let regenMult = (f.defenseState === "duck" && !isNmBoostActive) ? 1 : rBuffs.staminaRecoveryMult;
    if (f.blockRegenPenaltyTimer > 0) {
      regenMult *= 0.8;
    }
    if (f.defenseState === "fullGuard") {
      const guardRegenPenalty = levelScale(f.level, 0.75, 0.90, "fullGuardRegenMult");
      regenMult *= guardRegenPenalty;
    }
    f.burstPunchTimer += dt;

    f.timeSinceLastLanded += dt;
    f.timeSinceLastDamageTaken += dt;

    if (!f.damageTakenRegenPauseFired && f.timeSinceLastDamageTaken >= 1.5 && f.timeSinceLastDamageTaken < Infinity) {
      f.damageTakenRegenPauseFired = true;
      f.regenPauseTimer = Math.max(f.regenPauseTimer, 1.0);
      const curHandsDown = f.guardBlend < 0.05 && !f.isPunching && !f.isKnockedDown;
      if (curHandsDown) {
        f.handsDownCooldown = Math.max(f.handsDownCooldown, 3.0);
      }
    }

    if (f.momentumRegenTimer > 0) {
      f.momentumRegenTimer -= dt;
      if (f.momentumRegenTimer <= 0) {
        f.momentumRegenBoost = 0;
        f.momentumRegenTimer = 0;
      }
    }

    const handsDown = f.guardBlend < 0.05 && !f.isPunching && !f.isKnockedDown;
    if (handsDown && f.handsDownCooldown <= 0) {
      f.handsDownTimer += dt;
    } else {
      if (f.handsDownTimer > 0) {
        f.handsDownCooldown = 15;
      }
      f.handsDownTimer = 0;
    }
    if (f.handsDownCooldown > 0 && !handsDown) {
      f.handsDownCooldown -= dt;
      if (f.handsDownCooldown < 0) f.handsDownCooldown = 0;
    }

    const feintStamPause = (f.isFeinting && f.feintHoldTimer >= FEINT_HOLD_STAM_PAUSE) ||
                           f.feintDuckTouchingOpponent;

    // Pressure Drop Recovery: standing still + guard down for 1+ second gives a regen bonus
    const pdGuardDown = f.handsDown && !f.isPunching && !f.isFeinting && !f.isKnockedDown && !f.isHit;
    const pdMoved = Math.hypot(f.x - f.pdPrevX, f.z - f.pdPrevZ) > 2.0;
    f.pdPrevX = f.x;
    f.pdPrevZ = f.z;
    if (pdGuardDown && !pdMoved && f.regenPauseTimer <= 0 && !feintStamPause) {
      f.pressureDropTimer += dt;
    } else {
      f.pressureDropTimer = 0;
    }
    f.pdRecoveryActive = f.pressureDropTimer >= 1.0;
    let pressureDropMult = 1.0;
    if (f.pdRecoveryActive) {
      const ms = f.maxStamina;
      if (ms <= 200) {
        pressureDropMult = 2.0 + (ms / 200) * 2.0;
      } else if (ms <= 1000) {
        pressureDropMult = 4.0 + ((ms - 200) / 800) * 4.5;
      } else {
        pressureDropMult = 8.5;
      }
    }

    if (feintStamPause && !isNmBoostActive) {
    } else if (f.regenPauseTimer > 0 && !isNmBoostActive) {
      f.regenPauseTimer -= dt;
    } else if (f.staminaPauseFromRhythm > 0 && !isNmBoostActive) {
      f.staminaPauseFromRhythm -= dt;
    } else if (!f.isKnockedDown) {
      const lastHitBonus = f.timeSinceLastLanded >= 2 ? 1.30 : 1.0;
      const momentumBonus = 1.0 + f.momentumRegenBoost;
      let handsDownMult = 1.0;
      if (handsDown && f.handsDownCooldown <= 0) {
        if (f.handsDownTimer <= 0.5) {
          handsDownMult = 1.75;
        }
      }
      const kdBoost = f.kdRegenBoostActive ? 6.0 : 1.0;
      const nmRegenBoost = isNmBoostActive ? state.nightmareRegenBoostMult : 1.0;
      const tutorialRegenBoost = (state.tutorialMode && f.isPlayer) ? 4.0 : 1.0;
      // A Reset taken out of the pocket recovers faster for as long as the
      // fighter keeps that distance.
      const resetFarBoost = resetDistanceRegenMult(f, state);
      f.stamina = Math.min(f.maxStamina, f.stamina + f.staminaRegen * regenMult * lastHitBonus * momentumBonus * handsDownMult * kdBoost * nmRegenBoost * tutorialRegenBoost * pressureDropMult * resetFarBoost * dt);
    }
    if (f.isPlayer && f.duckStaminaRegenMult != null && f.defenseState === "duck" && !f.isKnockedDown && !feintStamPause) {
      f.stamina = Math.min(f.maxStamina, f.stamina + f.staminaRegen * f.duckStaminaRegenMult * dt);
    }
  });

  updatePunch(state.player, state.enemy, state, dt);
  if (state.knockdownActive || (state.phase as string) === "fightEnd") { clearFrameInput(); return state; }
  updatePunch(state.enemy, state.player, state, dt);
  if (state.knockdownActive || (state.phase as string) === "fightEnd") { clearFrameInput(); return state; }

  updateRhythm(state.player, dt);
  updateRhythm(state.enemy, dt);
  // Ahead of updateBob: the guard slide reads the fatigue ramps, so the sway
  // and Reset state have to be current for this tick before it runs.
  updateFatigue(state.player, dt, state);
  updateFatigue(state.enemy, dt, state);
  updateBob(state.player, dt, state);
  updateBob(state.enemy, dt, state);
  // Both perfect-block holds are judged once the markers have moved for this
  // tick, so a block that is about to be asked about has already seen the
  // rhythm it is being judged against.
  updatePerfectBlockRhythmLatch(state.player, state.enemy);
  updatePerfectBlockRhythmLatch(state.enemy, state.player);
  updateDefense(state.player, dt, state.practiceMode);
  updateDefense(state.enemy, dt, state.practiceMode);
  updatePunchAnimation(state.player);
  updatePunchAnimation(state.enemy);

  if (state.nightmareMode) {
    updateNightmareExtras(state, dt);
  }

  // The rendered turn itself, for both corners and every mode. The discrete
  // `facing` flip below still waits out its timer; this is the body coming
  // around over the same window, at whatever rate the fighter's stun penalties
  // currently allow.
  turnFacingToward(state.player, state.enemy.x, state.enemy.z, dt);
  turnFacingToward(state.enemy, state.player.x, state.player.z, dt);

  const playerFacing = state.player.x < state.enemy.x ? 1 : -1;
  if (state.player.facingLockTimer <= 0) {
    if (state.player.facing !== (playerFacing as 1 | -1) && state.player.facingPendingTimer <= 0) {
      // Turning to face opponent while executing moves — apply input delay penalty for rest of round
      // Turning out of a committed punch is the cheat this penalty exists for.
      // Simply holding a guard while the two cross sides is not: an AI corner
      // keeps its hands up almost permanently, so counting that latched the
      // penalty within seconds of the first bell and then re-armed a one-second
      // punch lockout after every punch for the rest of the round — an output
      // ceiling of roughly one punch per second that only the AI ever paid,
      // since nothing gates player input on it.
      if (state.player.isPunching) {
        state.player.stunBlockDisableTimer = Math.max(state.player.stunBlockDisableTimer, STUN_BLOCK_DISABLE_DURATION);
        state.player.stunPunchDisableTimer = Math.max(state.player.stunPunchDisableTimer, STUN_BLOCK_DISABLE_DURATION);
        state.player.turnPunchPenaltyActive = true;
      }
      // Latch only: it keeps the penalty above from re-firing every frame of the
      // turn. The side itself swaps off the body's angle, below.
      state.player.facingPendingTimer = facingTurnDuration(state.player);
    }
    if (state.player.facingPendingTimer > 0) {
      state.player.facingPendingTimer -= dt;
      if (state.player.facingPendingTimer < 0) state.player.facingPendingTimer = 0;
    }
    applyBodySideFacing(state.player);
  }
  if (state.enemy.facingLockTimer <= 0) {
    const enemyFacing = -playerFacing as 1 | -1;
    if (state.enemy.facing !== enemyFacing && state.enemy.facingPendingTimer <= 0) {
      // Turning to face opponent while executing moves — apply input delay penalty for rest of round
      // Same rule as the player's side above: the punch is what gets punished.
      if (state.enemy.isPunching) {
        state.enemy.stunBlockDisableTimer = Math.max(state.enemy.stunBlockDisableTimer, STUN_BLOCK_DISABLE_DURATION);
        state.enemy.stunPunchDisableTimer = Math.max(state.enemy.stunPunchDisableTimer, STUN_BLOCK_DISABLE_DURATION);
        state.enemy.turnPunchPenaltyActive = true;
      }
      state.enemy.facingPendingTimer = facingTurnDuration(state.enemy);
    }
    if (state.enemy.facingPendingTimer > 0) {
      state.enemy.facingPendingTimer -= dt;
      if (state.enemy.facingPendingTimer < 0) state.enemy.facingPendingTimer = 0;
    }
    applyBodySideFacing(state.enemy);
  }

  if (!state.knockdownActive) {
    const dist = getDistance(state.player, state.enemy);
    const playerPressing = state.player.isPunching && dist < 120;
    const enemyPressing = state.enemy.isPunching && dist < 120;
    if (playerPressing) state.roundStats.playerAggressionTime += dt;
    if (enemyPressing) state.roundStats.enemyAggressionTime += dt;

    const ringCenter = state.ringWidth / 2;
    const pDistCenter = Math.abs(state.player.x - ringCenter);
    const eDistCenter = Math.abs(state.enemy.x - ringCenter);
    if (pDistCenter < eDistCenter) {
      state.roundStats.playerRingControlTime += dt;
    } else if (eDistCenter < pDistCenter) {
      state.roundStats.enemyRingControlTime += dt;
    }
  }

  if (state.roundTimer <= 0) {
    soundEngine.bell();
    if (!state.practiceMode && !state.sparringMode) soundEngine.crowdCheer(0.5);
    state.fightTotalDuckDodges += state.roundStats.playerDuckDodges;
    state.fightTotalCombos += state.roundStats.playerComboCount;
    finalizeRoundRecording(state);
    const roundScore = scoreRound(state);
    state.roundScores.push(roundScore);
    checkFastTwitchRoundBonus(state, roundScore);

    if (state.currentRound >= state.totalRounds) {
      rollNextRingCanvasColor();
      state.phase = "fightEnd";
      let judgePlayerWins = 0;
      let judgeEnemyWins = 0;
      for (let ji = 0; ji < 3; ji++) {
        let pTotal = 0, eTotal = 0;
        state.roundScores.forEach(s => { pTotal += s.judges[ji].player; eTotal += s.judges[ji].enemy; });
        if (pTotal > eTotal) judgePlayerWins++;
        else if (eTotal > pTotal) judgeEnemyWins++;
      }

      if (state.sparringMode) {
        const pStats = getTotalPunchStats(state);
        let sparPScore = 0;
        let sparEScore = 0;
        sparPScore += pStats.playerLanded * 2;
        sparEScore += pStats.enemyLanded * 2;
        sparPScore += state.player.damageDealt;
        sparEScore += state.enemy.damageDealt;
        sparPScore += state.player.knockdownsGiven * 50;
        sparEScore += state.enemy.knockdownsGiven * 50;
        if (sparPScore > sparEScore) {
          state.fightResult = "Decision";
          state.fightWinner = "player";
        } else if (sparEScore > sparPScore) {
          state.fightResult = "Decision";
          state.fightWinner = "enemy";
        } else {
          state.fightResult = "Draw";
          state.fightWinner = null;
        }
      } else if (judgePlayerWins > judgeEnemyWins) {
        state.fightResult = "Decision";
        state.fightWinner = "player";
        if (!state.practiceMode && !state.sparringMode) soundEngine.playCheer(3);
      } else if (judgeEnemyWins > judgePlayerWins) {
        state.fightResult = "Decision";
        state.fightWinner = "enemy";
      } else {
        state.fightResult = "Draw";
        state.fightWinner = null;
      }
      state.xpGained = calculateXP(state);
    } else {
      state.phase = "roundEnd";
      if (state.aiBrain) {
        const drift = (Math.random() * 0.04 - 0.02) + (Math.random() > 0.5 ? 0.01 : -0.01);
        state.aiBrain.aiRhythmSpeedMult = Math.max(0.9, Math.min(1.1, state.aiBrain.aiRhythmSpeedMult + drift));
      }
      if (state.adaptiveAiEnabled) {
        if (state.aiBrain) onRoundBoundaryAdaptive(state.aiBrain);
        if (state.playerAiBrain) onRoundBoundaryAdaptive(state.playerAiBrain);
      }
      // Range learning is core behaviour, not part of the adaptive-AI feature flag
      onRoundBoundaryRangeLearning(state.aiBrain);
      onRoundBoundaryRangeLearning(state.playerAiBrain);
    }
  }

  // Drilled Actions settle once, at the end of the tick: a blocked punch runs
  // the hit path and then the guard path within the same one, so nothing may
  // act on the first notification to arrive.
  settleDrilledActions(state);

  clearFrameInput();
  return state;
}

function checkMidFightLevelUp(state: GameState, xpAmount: number): void {
  state.playerCurrentXp += xpAmount * (state.careerXpMult ?? 1);
  const needed = xpToNextLevel(state.playerLevel);
  if (state.playerCurrentXp >= needed) {
    if (state.playerLevel >= 1000) {
      // Absolute level cap regardless of champion status.
      state.playerCurrentXp = Math.min(state.playerCurrentXp, needed - 1);
      return;
    }
    state.playerCurrentXp -= needed;
    state.playerLevel++;
    state.player.level = state.playerLevel;
    state.midFightLevelUps++;
    state.midFightLevelUpTimer = 3.0;
    if (state.fightLiveXp !== undefined) {
      state.fightLiveXp = state.playerCurrentXp;
    }
  }
}

function calculateXP(state: GameState): number {
  const opponentLevel = Math.max(1, state.enemyLevel);
  const playerLevel = Math.max(1, state.playerLevel);

  let baseMatchXP = 4000 * (opponentLevel / 100);

  if (state.fightWinner === "player") {
    baseMatchXP *= 1.0;
  } else if (state.fightResult === "Draw") {
    baseMatchXP *= 0.5;
  } else {
    baseMatchXP *= 0.25;
  }

  if ((state.fightResult === "KO" || state.fightResult === "TKO") && state.fightWinner === "player") {
    baseMatchXP *= 1.15;
  }

  const diffMults: Record<string, number> = {
    journeyman: 0.8,
    contender: 1.0,
    elite: 1.35,
    champion: 1.75,
  };
  const difficultyMult = diffMults[state.aiDifficulty] || 1.0;

  const levelGap = opponentLevel - playerLevel;
  const levelGapMult = Math.max(0.7, Math.min(2.0, 1 + levelGap * 0.04));

  let totalXP = baseMatchXP * difficultyMult * levelGapMult * 1.5 * 1.3 * 0.7;

  if (state.isCareerFight) {
    const P = Math.max(0, ((playerLevel - opponentLevel) / playerLevel) * 100);
    if (P > 0) totalXP *= Math.pow(0.98, P);
  }

  return Math.max(1, Math.floor(totalXP));
}

export interface FightPerformanceStats {
  punchesThrown: number;
  punchesLanded: number;
  knockdownsGiven: number;
  knockdownsTaken: number;
  blocksMade: number;
  dodges: number;
  damageDealt: number;
  damageReceived: number;
  roundsWon: number;
  roundsLost: number;
}

export function extractPerformanceStats(state: GameState): FightPerformanceStats {
  let knockdownsGiven = 0;
  let knockdownsTaken = 0;
  let blocksMade = 0;
  let dodges = 0;
  let roundsWon = 0;
  let roundsLost = 0;

  for (const rs of state.roundScores) {
    knockdownsGiven += rs.playerKDsThisRound;
    knockdownsTaken += rs.enemyKDsThisRound;
    const pTotal = rs.judges.reduce((s, j) => s + j.player, 0);
    const eTotal = rs.judges.reduce((s, j) => s + j.enemy, 0);
    if (pTotal > eTotal) roundsWon++;
    else if (eTotal > pTotal) roundsLost++;
  }

  knockdownsGiven += state.roundStats.playerKDsThisRound;
  knockdownsTaken += state.roundStats.enemyKDsThisRound;
  blocksMade += state.roundStats.playerPunchesBlocked;
  dodges += state.roundStats.playerPunchesDodged;

  if (state.fightWinner === "player" && (state.fightResult === "KO" || state.fightResult === "TKO")) {
    roundsWon++;
  } else if (state.fightWinner === "enemy" && (state.fightResult === "KO" || state.fightResult === "TKO")) {
    roundsLost++;
  }

  return {
    punchesThrown: state.player.punchesThrown,
    punchesLanded: state.player.punchesLanded,
    knockdownsGiven,
    knockdownsTaken,
    blocksMade,
    dodges,
    damageDealt: Math.floor(state.player.damageDealt),
    damageReceived: Math.floor(state.enemy.damageDealt),
    roundsWon,
    roundsLost,
  };
}

export function startNextRound(state: GameState): GameState {
  for (const f of [state.player, state.enemy]) {
    if (f.unansweredStreak >= 2) {
      f.momentumRegenBoost = 0.20;
      f.momentumRegenTimer = 15;
    } else {
      f.momentumRegenBoost = 0;
      f.momentumRegenTimer = 0;
    }
    f.unansweredStreak = 0;
    // Ring mileage is per-round for both corners: the bell wipes the walking
    // clock, so part-worn progress toward the next drain does not carry over.
    f.movingTime = 0;
  }

  // Held AI perfect blocks never carry across the bell
  if (state.aiBrain) resetAiPerfectBlockHold(state.aiBrain, state.enemy);
  if (state.playerAiBrain) resetAiPerfectBlockHold(state.playerAiBrain, state.player);
  // Neither does a half-seen combination or the counter script answering one.
  // What the AI has learned this bout survives; the chunk in progress does not.
  if (state.aiBrain) resetAiPatternRound(state.aiBrain);
  if (state.playerAiBrain) resetAiPatternRound(state.playerAiBrain);
  // The player's own drilling obeys the same rule: the list survives the bell,
  // the combination in progress and the dodge window it opened do not.
  resetDrilledForBreak(state);

  state.currentRound++;
  state.roundTimer = state.roundDuration;
  state.phase = "prefight";
  state.countdownTimer = COUNTDOWN_DURATION;
  state.shakeIntensity = 0;
  state.shakeTimer = 0;
  state.crowdKdSpeedTimer = 0;
  state.crowdExciteTimer = 0;

  const lastScore = state.roundScores.length > 0 ? state.roundScores[state.roundScores.length - 1] : null;
  let playerLostRound = false;
  let enemyLostRound = false;
  if (lastScore) {
    let pTotal = 0, eTotal = 0;
    lastScore.judges.forEach((j: { player: number; enemy: number }) => { pTotal += j.player; eTotal += j.enemy; });
    playerLostRound = pTotal < eTotal;
    enemyLostRound = eTotal < pTotal;
  }

  for (const f of [state.player, state.enemy]) {
    f.guardDownBoostMax = Math.max(0, f.guardDownBoostMax - 0.02);
    f.guardDownTimer = 0;
    f.guardDownSpeedBoost = 0;
    f.guardDownBoostTimer = 0;

    const isPlayer = f === state.player;
    const roundKDs = isPlayer ? state.roundStats.playerKDsThisRound : state.roundStats.enemyKDsThisRound;
    const roundPunches = isPlayer ? state.roundStats.playerPunchesThisRound : state.roundStats.enemyPunchesThisRound;
    const lostRound = isPlayer ? playerLostRound : enemyLostRound;

    // The bell's own bill: a flat charge on everyone, plus what the round cost
    // this particular fighter. Each of the four carries its own unit and its own
    // on/off switch, so they are converted to points first and summed after --
    // there is no one unit the sum could be read in. A percent-mode share still
    // reads against the opening pool, so it can't compound within the bell.
    let bell = maxStamAmount(f, "roundEndBase");
    if (lostRound) bell += maxStamAmount(f, "roundEndLostRound");
    bell += roundKDs * maxStamAmount(f, "roundEndPerKd");
    bell += Math.floor(roundPunches / 50) * maxStamAmount(f, "roundEndPer50Punches");

    // Unnegatable: the scorecards are not a punch, so a mouthguard has no say.
    applyMaxStaminaDelta(f, bell, { unnegatable: true });
  }

  state.player.autoGuardActive = false;
  state.player.autoGuardTimer = 0;

  state.player.stamina = state.player.maxStamina;
  state.enemy.stamina = state.enemy.maxStamina;

  state.player.x = PLAYER_START_X;
  state.player.z = PLAYER_START_Z;
  state.enemy.x = ENEMY_START_X;
  state.enemy.z = ENEMY_START_Z;
  state.player.isPunching = false;
  state.enemy.isPunching = false;
  state.player.defenseState = "fullGuard";
  state.enemy.defenseState = "fullGuard";
  state.player.guardBlend = 1.0;
  state.enemy.guardBlend = 1.0;
  state.player.leftGloveOffset = { x: state.player.facing * 6, y: -12 };
  state.player.rightGloveOffset = { x: state.player.facing * 6, y: -8 };
  state.enemy.leftGloveOffset = { x: state.enemy.facing * 6, y: -12 };
  state.enemy.rightGloveOffset = { x: state.enemy.facing * 6, y: -8 };
  state.player.isKnockedDown = false;
  state.enemy.isKnockedDown = false;
  
  state.player.blockTimer = 0;
  state.enemy.blockTimer = 0;
  state.player.blockRegenPenaltyTimer = 0;
  state.enemy.blockRegenPenaltyTimer = 0;
  state.player.punchPhase = null;
  state.enemy.punchPhase = null;
  state.player.punchCooldown = 0;
  state.enemy.punchCooldown = 0;
  state.player.punchPhaseTimer = 0;
  state.enemy.punchPhaseTimer = 0;
  state.player.punchProgress = 0;
  state.enemy.punchProgress = 0;
  state.player.currentPunch = null;
  state.enemy.currentPunch = null;
  state.player.isFeinting = false;
  state.enemy.isFeinting = false;
  state.player.feintHoldTimer = 0;
  state.enemy.feintHoldTimer = 0;
  state.player.feintTouchingOpponent = false;
  state.enemy.feintTouchingOpponent = false;
  state.player.feintDuckTouchingOpponent = false;
  state.enemy.feintDuckTouchingOpponent = false;
  state.player.isCharging = false;
  state.enemy.isCharging = false;
  state.player.isRePunch = false;
  state.enemy.isRePunch = false;
  state.player.halfGuardPunch = false;
  state.enemy.halfGuardPunch = false;
  state.player.retractionProgress = 0;
  state.enemy.retractionProgress = 0;
  state.player.earlyRepunchPenaltyTimer = 0;
  state.enemy.earlyRepunchPenaltyTimer = 0;
  state.player.staminaPenaltyPending = false;
  state.enemy.staminaPenaltyPending = false;
  state.player.retractionPenaltyMult = 1;
  state.enemy.retractionPenaltyMult = 1;
  state.player.feintCancelActive = false;
  state.enemy.feintCancelActive = false;
  state.player.feintCancelPunchType = null;
  state.enemy.feintCancelPunchType = null;
  state.player.feintCancelTimer = 0;
  state.enemy.feintCancelTimer = 0;
  state.player.stunPunchDisableTimer = 0;
  state.enemy.stunPunchDisableTimer = 0;
  state.player.stunPunchSlowTimer = 0;
  state.enemy.stunPunchSlowTimer = 0;
  state.player.stunPunchSlowMult = 1;
  state.enemy.stunPunchSlowMult = 1;
  state.player.stunBlockDisableTimer = 0;
  state.enemy.stunBlockDisableTimer = 0;
  state.player.turnPunchPenaltyActive = false;
  state.enemy.turnPunchPenaltyActive = false;
  state.player.stunBlockWeakenTimer = 0;
  state.enemy.stunBlockWeakenTimer = 0;
  state.player.chargeArmTimer = 0;
  state.enemy.chargeArmTimer = 0;
  state.player.moveSlowTimer = 0;
  state.enemy.moveSlowTimer = 0;
  state.player.moveSlowMult = 1;
  state.enemy.moveSlowMult = 1;
  endSlip(state.player);
  endSlip(state.enemy);
  cancelPendingSlip(state.player);
  cancelPendingSlip(state.enemy);
  state.player.slipDisabledTimer = 0;
  state.enemy.slipDisabledTimer = 0;
  state.player.slipChainTimer = 0;
  state.enemy.slipChainTimer = 0;
  state.player.slipChainCount = 0;
  state.enemy.slipChainCount = 0;
  state.player.slipLean = 0;
  state.enemy.slipLean = 0;
  state.player.slipKeyWasUp = true;
  state.enemy.slipKeyWasUp = true;
  state.player.stunMoveFreezeTimer = 0;
  state.enemy.stunMoveFreezeTimer = 0;
  state.player.fatigue.resetLockTimer = 0;
  state.enemy.fatigue.resetLockTimer = 0;
  state.player.chargeReady = false;
  state.enemy.chargeReady = false;
  state.player.chargeArmed = false;
  state.player.chargeUsesLeft = 0;
  state.player.chargeWhiffForgivenessLeft = 0;
  state.player.feintArmed = false;
  state.player.feintArmTimer = 0;
  state.enemy.feintArmed = false;
  state.enemy.feintArmTimer = 0;
  state.enemy.chargeArmed = false;
  state.enemy.chargeUsesLeft = 0;
  state.enemy.chargeWhiffForgivenessLeft = 0;
  state.player.chargeHoldTimer = 0;
  state.enemy.chargeHoldTimer = 0;
  state.player.blockFlashTimer = 0;
  state.enemy.blockFlashTimer = 0;
  state.player.punchTravelStartTime = 0;
  state.enemy.punchTravelStartTime = 0;
  state.player.retractionPenaltyMult = 1;
  state.enemy.retractionPenaltyMult = 1;
  state.player.feintWhiffPenaltyCooldown = 0;
  state.enemy.feintWhiffPenaltyCooldown = 0;
  state.player.facingTurnDelay = 0;
  state.enemy.facingTurnDelay = 0;
  state.player.facingPendingTimer = 0;
  state.enemy.facingPendingTimer = 0;
  state.player.stunFacingSlowTimer = 0;
  state.enemy.stunFacingSlowTimer = 0;
  state.player.stunFacingTurnDelay = 0;
  state.enemy.stunFacingTurnDelay = 0;
  state.player.facingLockTimer = 0;
  state.enemy.facingLockTimer = 0;
  state.player.turnDelayCancelled = false;
  state.enemy.turnDelayCancelled = false;
  state.player.turnDelayAdjust = 0;
  state.enemy.turnDelayAdjust = 0;
  state.player.turnDelayZeroTimer = 0;
  state.enemy.turnDelayZeroTimer = 0;
  // Both corners answer the bell already squared up, so nobody opens the round
  // turning out of a lock or an angle left over from the last exchange.
  snapFacingToward(state.player, state.enemy.x, state.enemy.z);
  snapFacingToward(state.enemy, state.player.x, state.player.z);
  for (const f of [state.player, state.enemy]) {
    if (state.currentRound > 1) {
      const roundIncrease = levelScale(f.level, 0.05, 0.01, "telegraphRoundBonus");
      f.telegraphRoundBonus += roundIncrease;
    }
  }
  state.player.telegraphPhase = "none";
  state.player.telegraphTimer = 0;
  state.player.telegraphDuration = 0;
  state.player.telegraphPunchType = null;
  state.player.telegraphIsFeint = false;
  state.player.telegraphIsCharged = false;
  state.player.telegraphRhythmPaused = false;
  state.player.swayFrozen = false;
  state.player.telegraphIsLockout = false;
  state.player.postPunchLockoutTimer = 0;
  state.player.postPunchLockoutDuration = 0;
  state.player.pendingPunchInput = null;
  state.player.pendingPunchInputTimer = 0;
  state.player.timeSinceLastPunch = 999;
  state.player.feintTelegraphDisableTimer = 0;
  state.player.feintedTelegraphBoost = 0;
  state.enemy.telegraphPhase = "none";
  state.enemy.telegraphTimer = 0;
  state.enemy.telegraphDuration = 0;
  state.enemy.telegraphPunchType = null;
  state.enemy.telegraphIsFeint = false;
  state.enemy.telegraphIsCharged = false;
  state.enemy.telegraphRhythmPaused = false;
  state.enemy.swayFrozen = false;
  state.enemy.telegraphIsLockout = false;
  state.enemy.postPunchLockoutTimer = 0;
  state.enemy.postPunchLockoutDuration = 0;
  state.enemy.pendingPunchInput = null;
  state.enemy.pendingPunchInputTimer = 0;
  state.enemy.timeSinceLastPunch = 999;
  state.enemy.feintTelegraphDisableTimer = 0;
  state.enemy.feintedTelegraphBoost = 0;
  for (const f of [state.player, state.enemy]) {
    f.telegraphSlowTimer = 0;
    f.telegraphSlowDuration = 0;
    f.telegraphRhythmBoost = 0;
  }
  state.player.isRePunch = false;
  state.enemy.isRePunch = false;
  state.player.earlyRepunchPenaltyTimer = 0;
  state.enemy.earlyRepunchPenaltyTimer = 0;
  state.player.staminaPenaltyPending = false;
  state.enemy.staminaPenaltyPending = false;
  state.player.feintCancelActive = false;
  state.enemy.feintCancelActive = false;
  state.player.feintCancelPunchType = null;
  state.enemy.feintCancelPunchType = null;
  state.player.feintCancelTimer = 0;
  state.enemy.feintCancelTimer = 0;
  state.player.burstPunchCount = 0;
  state.player.burstPunchTimer = 1.5;
  state.enemy.burstPunchCount = 0;
  state.enemy.burstPunchTimer = 1.5;
  if (state.aiBrain) {
    state.aiBrain.comboLimitTimer = 0;
    state.aiBrain.comboLimitMax = 0;
    state.aiBrain.staminaPenaltyStreak = 0;
    state.aiBrain.staminaPenaltyCooldown = 0;
  }
  if (state.playerAiBrain) {
    state.playerAiBrain.comboLimitTimer = 0;
    state.playerAiBrain.comboLimitMax = 0;
    state.playerAiBrain.staminaPenaltyStreak = 0;
    state.playerAiBrain.staminaPenaltyCooldown = 0;
  }
  state.player.duckHoldTimer = 0;
  state.player.duckDrainCooldown = 0;
  state.enemy.duckHoldTimer = 0;
  state.enemy.duckDrainCooldown = 0;
  state.knockdownActive = false;
  state.knockdownMashCount = 0;
  state.knockdownMashTimer = 0;
  state.knockdownRefCount = 0;
  state.knockdownCountdown = 0;
  state.kdFallTimer = KD_FALL_DURATION;
  state.kdIsBodyShot = false;
  state.kdTakeKnee = false;
  state.kdFaceRefActive = false;
  state.kdFaceRefTimer = 0;
  state.refStoppageActive = false;
  state.refStoppageTimer = 0;
  state.refStoppageType = null;
  state.towelActive = false;
  state.towelTimer = 0;
  state.refereeVisible = false;
  state.kdTimerExpired = false;
  state.kdEarlyStopCheckedCount = 0;
  state.aiKoPendingResult = null;
  state.aiKoStopTime = -1;
  // Early-blitz rule only lives in round 1 — clear it at every round transition.
  state.earlyBlitzKoActive = false;
  state.earlyBlitzStopCount = 0;

  // Accuracy fatigue: the fighter with lower accuracy this round loses 2% stamina
  if (state.currentRound > 1) {
    const pThrown = state.roundStats.playerPunchesThisRound;
    const eThrown = state.roundStats.enemyPunchesThisRound;
    const pAcc = pThrown > 0 ? state.roundStats.playerLandedThisRound / pThrown : 0;
    const eAcc = eThrown > 0 ? state.roundStats.enemyLandedThisRound / eThrown : 0;
    if (pAcc < eAcc) {
      state.player.stamina = Math.max(1, state.player.stamina * 0.98);
    } else if (eAcc < pAcc) {
      state.enemy.stamina = Math.max(1, state.enemy.stamina * 0.98);
    }
  }

  state.roundStats = {
    playerDamageThisRound: 0,
    enemyDamageThisRound: 0,
    playerActualDamageThisRound: 0,
    enemyActualDamageThisRound: 0,
    playerPunchesThisRound: 0,
    enemyPunchesThisRound: 0,
    playerLandedThisRound: 0,
    enemyLandedThisRound: 0,
    playerKDsThisRound: 0,
    enemyKDsThisRound: 0,
    playerAggressionTime: 0,
    enemyAggressionTime: 0,
    playerRingControlTime: 0,
    enemyRingControlTime: 0,
    playerPunchesDodged: 0,
    enemyPunchesDodged: 0,
    playerPunchesBlocked: 0,
    enemyPunchesBlocked: 0,
    playerDuckDodges: 0,
    playerComboCount: 0,
    playerConsecutiveLanded: 0,
  };

  const playerPlays = shouldPlayIntroAnim(state, state.player);
  const enemyPlays = shouldPlayIntroAnim(state, state.enemy);
  state.introAnimActive = playerPlays || enemyPlays;
  state.introAnimTimer = 0;
  state.introAnimPhase = 0;
  state.playerIntroPlaying = playerPlays;
  state.enemyIntroPlaying = enemyPlays;
  state.playerSavedRhythmLevel = state.player.rhythmLevel > 0 ? state.player.rhythmLevel : 2;
  state.enemySavedRhythmLevel = state.enemy.rhythmLevel > 0 ? state.enemy.rhythmLevel : 2;
  state.swarmerPunchQueue = generateSwarmerPunchQueue();
  state.swarmerPunchIndex = 0;
  state.swarmerPunchDelay = 0;
  state.swarmerIsPlayer = state.player.archetype === "Swarmer";

  if (playerPlays) {
    startIntroAnimForFighter(state.player, state.playerSavedRhythmLevel);
  }
  if (enemyPlays) {
    startIntroAnimForFighter(state.enemy, state.enemySavedRhythmLevel);
  }

  return state;
}

function totalXpForLevel(level: number): number {
  return Math.floor(10000000 * Math.pow(level / 100, 3));
}

export function xpToNextLevel(level: number): number {
  return Math.ceil((totalXpForLevel(level + 1) - totalXpForLevel(level)) * 1.25);
}

export type PlayerPlaystyle = Record<string, number>;

export function extractPlayerPlaystyle(state: GameState): PlayerPlaystyle {
  const p = state.player;
  const thrown = p.punchesThrown || 1;
  const landed = p.punchesLanded || 0;
  const accuracy = landed / thrown;
  const clean = p.cleanPunchesLanded || 0;
  const cleanRatio = clean / Math.max(landed, 1);
  const feintBaits = p.feintBaits || 0;
  const kdsGiven = p.knockdownsGiven || 0;
  const kdsReceived = p.knockdowns || 0;
  const elapsed = state.fightElapsedTime || 1;
  const punchRate = thrown / elapsed;

  const totalBlocks = state.roundStats.playerPunchesBlocked || 0;
  const totalDodges = state.roundStats.playerPunchesDodged || 0;
  const totalDucks = (state.fightTotalDuckDodges || 0) + (state.roundStats.playerDuckDodges || 0);
  const totalAggrTime = state.roundStats.playerAggressionTime || 0;
  const totalRingControl = state.roundStats.playerRingControlTime || 0;
  const totalEnemyAggr = state.roundStats.enemyAggressionTime || 0;

  let totalPlayerDmg = 0;
  let totalEnemyDmg = 0;
  for (const rs of state.roundScores) {
    totalPlayerDmg += rs.playerDamage || 0;
    totalEnemyDmg += rs.enemyDamage || 0;
  }
  totalPlayerDmg += state.roundStats.playerDamageThisRound || 0;
  totalEnemyDmg += state.roundStats.enemyDamageThisRound || 0;

  const aggressionRatio = totalAggrTime / Math.max(totalAggrTime + totalEnemyAggr, 1);
  const ringControlRatio = totalRingControl / Math.max(elapsed, 1);
  const combos = state.fightTotalCombos || 0;
  const comboRate = combos / Math.max(thrown / 3, 1);
  const dmgRatio = totalPlayerDmg / Math.max(totalPlayerDmg + totalEnemyDmg, 1);
  const feintRate = feintBaits / Math.max(elapsed / 10, 1);
  const defTotal = totalBlocks + totalDodges + totalDucks + 1;
  const blockRate = totalBlocks / defTotal;
  const dodgeRate = totalDodges / defTotal;
  const duckRate = totalDucks / defTotal;
  const survival = 1.0 - Math.min(kdsReceived * 0.3, 1.0);

  const clamp = (v: number) => Math.max(0.02, Math.min(1.0, v));

  return {
    aggression: clamp(aggressionRatio * 1.2),
    guardParanoia: clamp(blockRate * 1.5),
    feintiness: clamp(feintRate * 0.5),
    cleanHitsVsVolume: clamp(cleanRatio * 1.3),
    stateThinkSpeed: clamp(accuracy * 1.1),
    moveThinkSpeed: clamp(ringControlRatio * 1.5),
    attackInterval: clamp(Math.min(punchRate * 1.5, 1.0)),
    perfectReactChance: clamp(dodgeRate * 2.0),
    defenseCycleSpeed: clamp((blockRate + dodgeRate + duckRate) * 0.8),
    headCondThreshold: clamp(survival),
    bodyCondThreshold: clamp(survival * 0.9),
    rhythmCutCommit: clamp(aggressionRatio * comboRate * 2),
    rhythmCutAggression: clamp(aggressionRatio * punchRate),
    chargedPunchChance: clamp(dmgRatio * 0.8),
    comboCommitChance: clamp(comboRate * 1.2),
    ringCutoff: clamp(ringControlRatio * 1.3),
    ropeEscapeAwareness: clamp(dodgeRate * 1.5 + duckRate),
    lateralStrength: clamp(ringControlRatio * 1.2),
    kdRecovery1: clamp(survival * 1.1),
    kdRecovery2: clamp(survival * 0.85),
    kdRecovery3: clamp(survival * 0.6),
    survivalInstinct: clamp(survival * dmgRatio * 1.5),
  };
}

const PLAYSTYLE_LS_KEY = "handz_player_playstyle";

export function loadPlayerPlaystyle(fighterId: number): PlayerPlaystyle | null {
  try {
    const raw = localStorage.getItem(PLAYSTYLE_LS_KEY);
    if (!raw) return null;
    const all = JSON.parse(raw);
    return all[String(fighterId)] || null;
  } catch { return null; }
}

export function savePlayerPlaystyle(fighterId: number, newSample: PlayerPlaystyle) {
  const existing = loadPlayerPlaystyle(fighterId);
  const blended: PlayerPlaystyle = {};
  for (const key of Object.keys(newSample)) {
    if (existing && existing[key] != null) {
      blended[key] = existing[key] * 0.87 + newSample[key] * 0.13;
    } else {
      blended[key] = newSample[key];
    }
  }
  try {
    const raw = localStorage.getItem(PLAYSTYLE_LS_KEY);
    const all = raw ? JSON.parse(raw) : {};
    all[String(fighterId)] = blended;
    localStorage.setItem(PLAYSTYLE_LS_KEY, JSON.stringify(all));
  } catch {}
}
