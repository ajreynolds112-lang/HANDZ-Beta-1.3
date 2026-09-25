import type { PunchType, DefenseState } from "./types";

export interface SituationContext {
  playerDef?: DefenseState[];
  enemyDef?: DefenseState[];
  distFrac?: [number, number];
  playerPunching?: boolean;
  playerDucked?: boolean;
  enemyDucked?: boolean;
  recentPlayerPunches?: PunchType[];
  minPlayerPunchCount?: number;
  playerSustainedDuckSec?: number;
  playerDuckPunchCount?: number;
  playerCrossRatio?: number;
  playerBodyRatio?: number;
  guardDropSec?: number;
  prevDefWas?: string;
  defSwitchAgeSec?: number;
  playerApproaching?: boolean;
}

export interface SituationCounter {
  action: "punch" | "stepBack" | "feint" | "guardSwitch" | "none";
  punch?: PunchType;
  targetBody?: boolean;
  forceGuard?: "high" | "low" | "duck";
  wantCharge?: boolean;
}

export interface SituationEntry {
  id: string;
  name: string;
  context: SituationContext;
  counters: SituationCounter[];
  baseRecognition: number;
}

export const SITUATION_DB: SituationEntry[] = [
  {
    id: "duck_approach_body_cross",
    name: "Duck approach body cross spam",
    context: {
      playerDucked: true,
      distFrac: [0.3, 1.0],
      playerApproaching: true,
      recentPlayerPunches: ["cross"],
      playerBodyRatio: 0.4,
    },
    counters: [
      { action: "guardSwitch", forceGuard: "low" },
      { action: "stepBack" },
      { action: "punch", punch: "leftUppercut", targetBody: true },
    ],
    baseRecognition: 0.35,
  },
  {
    id: "duck_uppercut_flurry",
    name: "Rapid duck uppercut chain",
    context: {
      playerDucked: true,
      distFrac: [0.2, 0.9],
      recentPlayerPunches: ["leftUppercut", "leftUppercut"],
      playerDuckPunchCount: 3,
    },
    counters: [
      { action: "guardSwitch", forceGuard: "low" },
      { action: "stepBack" },
      { action: "punch", punch: "cross", targetBody: true },
    ],
    baseRecognition: 0.4,
  },
  {
    id: "guard_duck_guard_cycling",
    name: "Guard-duck-guard bait cycling",
    context: {
      defSwitchAgeSec: 0.5,
      distFrac: [0.2, 0.8],
    },
    counters: [
      { action: "none" },
      { action: "guardSwitch", forceGuard: "low" },
      { action: "punch", punch: "leftUppercut", targetBody: false },
    ],
    baseRecognition: 0.3,
  },
  {
    id: "guard_approach_sudden_cross",
    name: "Guard walk-in then sudden body cross",
    context: {
      playerDef: ["fullGuard"],
      playerApproaching: true,
      distFrac: [0.3, 0.7],
      recentPlayerPunches: ["cross"],
      playerBodyRatio: 0.3,
    },
    counters: [
      { action: "stepBack" },
      { action: "punch", punch: "jab", targetBody: false },
      { action: "guardSwitch", forceGuard: "low" },
    ],
    baseRecognition: 0.3,
  },
  {
    id: "jab_probe_cross_follow",
    name: "Jab probe into cross",
    context: {
      distFrac: [0.3, 0.8],
      recentPlayerPunches: ["jab", "cross"],
    },
    counters: [
      { action: "guardSwitch", forceGuard: "high" },
      { action: "punch", punch: "cross", targetBody: true },
      { action: "stepBack" },
    ],
    baseRecognition: 0.25,
  },
  {
    id: "fullguard_to_duck_uppercut",
    name: "Guard drop to duck then uppercut",
    context: {
      prevDefWas: "fullGuard",
      playerDucked: true,
      distFrac: [0.2, 0.8],
      recentPlayerPunches: ["leftUppercut"],
    },
    counters: [
      { action: "guardSwitch", forceGuard: "low" },
      { action: "punch", punch: "rightUppercut", targetBody: true },
      { action: "stepBack" },
    ],
    baseRecognition: 0.35,
  },
  {
    id: "sustained_duck_body_spam",
    name: "Sustained duck with body punch spam",
    context: {
      playerDucked: true,
      playerSustainedDuckSec: 1.5,
      playerBodyRatio: 0.5,
      distFrac: [0.2, 0.8],
    },
    counters: [
      { action: "punch", punch: "leftUppercut", targetBody: true },
      { action: "stepBack" },
      { action: "guardSwitch", forceGuard: "low" },
    ],
    baseRecognition: 0.4,
  },
  {
    id: "cross_dominant_fighter",
    name: "Heavy cross usage pattern",
    context: {
      playerCrossRatio: 0.4,
      minPlayerPunchCount: 8,
      distFrac: [0.3, 0.9],
    },
    counters: [
      { action: "guardSwitch", forceGuard: "duck" },
      { action: "punch", punch: "leftHook", targetBody: true },
      { action: "stepBack" },
    ],
    baseRecognition: 0.3,
  },
  {
    id: "close_range_guard_drop",
    name: "Guard drop at close range",
    context: {
      guardDropSec: 0.5,
      distFrac: [0.2, 0.6],
    },
    counters: [
      { action: "punch", punch: "cross", targetBody: false },
      { action: "punch", punch: "rightHook", targetBody: true },
      { action: "punch", punch: "leftUppercut", targetBody: false },
    ],
    baseRecognition: 0.35,
  },
  {
    id: "duck_cross_dodge_cross",
    name: "Duck cross then dodge then cross again",
    context: {
      playerDucked: true,
      distFrac: [0.2, 0.7],
      recentPlayerPunches: ["cross", "cross"],
    },
    counters: [
      { action: "guardSwitch", forceGuard: "low" },
      { action: "stepBack" },
      { action: "punch", punch: "leftUppercut", targetBody: true },
    ],
    baseRecognition: 0.35,
  },
  {
    id: "rapid_left_uppercut_duck_spam",
    name: "Rapid left uppercut spam from duck",
    context: {
      playerDucked: true,
      recentPlayerPunches: ["leftUppercut", "leftUppercut", "leftUppercut"],
      distFrac: [0.2, 1.0],
    },
    counters: [
      { action: "guardSwitch", forceGuard: "low" },
      { action: "stepBack" },
      { action: "punch", punch: "cross", targetBody: true },
    ],
    baseRecognition: 0.45,
  },
  {
    id: "jab_cross_uppercut_sequence",
    name: "Jab probe into cross then uppercut finish",
    context: {
      distFrac: [0.3, 0.9],
      recentPlayerPunches: ["jab", "cross", "leftUppercut"],
    },
    counters: [
      { action: "stepBack" },
      { action: "guardSwitch", forceGuard: "low" },
      { action: "punch", punch: "rightHook", targetBody: true },
    ],
    baseRecognition: 0.3,
  },
  {
    id: "body_cross_spam_from_range",
    name: "Repeated body crosses from medium range",
    context: {
      distFrac: [0.5, 1.0],
      recentPlayerPunches: ["cross", "cross", "cross"],
      playerBodyRatio: 0.4,
    },
    counters: [
      { action: "guardSwitch", forceGuard: "duck" },
      { action: "punch", punch: "leftHook", targetBody: true },
      { action: "stepBack" },
    ],
    baseRecognition: 0.35,
  },
  {
    id: "guard_walk_jab_probe",
    name: "Walk forward in guard with jab probes",
    context: {
      playerDef: ["fullGuard"],
      playerApproaching: true,
      distFrac: [0.4, 1.0],
      recentPlayerPunches: ["jab"],
    },
    counters: [
      { action: "stepBack" },
      { action: "punch", punch: "jab", targetBody: false },
      { action: "none" },
    ],
    baseRecognition: 0.2,
  },
  {
    id: "duck_to_guard_cross_reset",
    name: "Switch from duck to guard then throw cross",
    context: {
      prevDefWas: "duck",
      playerDef: ["fullGuard"],
      distFrac: [0.3, 0.8],
      recentPlayerPunches: ["cross"],
    },
    counters: [
      { action: "guardSwitch", forceGuard: "duck" },
      { action: "punch", punch: "leftUppercut", targetBody: false },
      { action: "stepBack" },
    ],
    baseRecognition: 0.3,
  },
];

export interface SituationMatchResult {
  entry: SituationEntry;
  counter: SituationCounter;
}

export function matchSituation(
  db: SituationEntry[],
  currentContext: {
    playerDef: DefenseState;
    enemyDef: DefenseState;
    distFrac: number;
    playerPunching: boolean;
    recentPunches: PunchType[];
    sustainedDuckSec: number;
    duckPunchCount: number;
    crossRatio: number;
    bodyRatio: number;
    guardDropSec: number;
    prevDef: string;
    defSwitchAge: number;
    approaching: boolean;
    totalPunchCount: number;
  },
  difficultyMult: number,
  rng01: () => number
): SituationMatchResult | null {
  const matched: SituationMatchResult[] = [];

  for (const entry of db) {
    if (!contextMatches(entry.context, currentContext)) continue;

    const recognition = entry.baseRecognition * difficultyMult;
    if (rng01() > recognition) continue;

    const counter = entry.counters[Math.floor(rng01() * entry.counters.length)];
    matched.push({ entry, counter });
  }

  if (matched.length === 0) return null;
  return matched[Math.floor(rng01() * matched.length)];
}

function contextMatches(
  ctx: SituationContext,
  cur: {
    playerDef: DefenseState;
    enemyDef: DefenseState;
    distFrac: number;
    playerPunching: boolean;
    recentPunches: PunchType[];
    sustainedDuckSec: number;
    duckPunchCount: number;
    crossRatio: number;
    bodyRatio: number;
    guardDropSec: number;
    prevDef: string;
    defSwitchAge: number;
    approaching: boolean;
    totalPunchCount: number;
  }
): boolean {
  if (ctx.playerDef && !ctx.playerDef.includes(cur.playerDef)) return false;
  if (ctx.enemyDef && !ctx.enemyDef.includes(cur.enemyDef)) return false;

  if (ctx.distFrac) {
    if (cur.distFrac < ctx.distFrac[0] || cur.distFrac > ctx.distFrac[1]) return false;
  }

  if (ctx.playerPunching !== undefined && ctx.playerPunching !== cur.playerPunching) return false;

  if (ctx.playerDucked !== undefined) {
    const isDucked = cur.playerDef === "duck";
    if (ctx.playerDucked !== isDucked) return false;
  }

  if (ctx.enemyDucked !== undefined) {
    const isDucked = cur.enemyDef === "duck";
    if (ctx.enemyDucked !== isDucked) return false;
  }

  if (ctx.recentPlayerPunches && ctx.recentPlayerPunches.length > 0) {
    const needed = ctx.recentPlayerPunches;
    const recent = cur.recentPunches.slice(-needed.length);
    if (recent.length < needed.length) return false;
    for (let i = 0; i < needed.length; i++) {
      if (recent[i] !== needed[i]) return false;
    }
  }

  if (ctx.minPlayerPunchCount !== undefined && cur.totalPunchCount < ctx.minPlayerPunchCount) return false;
  if (ctx.playerSustainedDuckSec !== undefined && cur.sustainedDuckSec < ctx.playerSustainedDuckSec) return false;
  if (ctx.playerDuckPunchCount !== undefined && cur.duckPunchCount < ctx.playerDuckPunchCount) return false;
  if (ctx.playerCrossRatio !== undefined && cur.crossRatio < ctx.playerCrossRatio) return false;
  if (ctx.playerBodyRatio !== undefined && cur.bodyRatio < ctx.playerBodyRatio) return false;
  if (ctx.guardDropSec !== undefined && cur.guardDropSec < ctx.guardDropSec) return false;

  if (ctx.prevDefWas !== undefined && cur.prevDef !== ctx.prevDefWas) return false;
  if (ctx.defSwitchAgeSec !== undefined && cur.defSwitchAge > ctx.defSwitchAgeSec) return false;

  if (ctx.playerApproaching !== undefined && ctx.playerApproaching !== cur.approaching) return false;

  return true;
}

export function getDifficultyMultiplier(band: string): number {
  switch (band) {
    case "Easy": return 0.15;
    case "Medium": return 0.35;
    case "Hard": return 0.7;
    case "Hardcore": return 1.0;
    default: return 0.25;
  }
}
