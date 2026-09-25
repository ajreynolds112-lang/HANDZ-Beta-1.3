import type { Archetype, AIDifficulty } from "./types";

export interface CareerOpponent {
  name: string;
  level: number;
  archetype: Archetype;
  aiDifficulty: AIDifficulty;
  armLength: number;
}

const FIRST_NAMES = [
  "Marcus", "Tyrell", "Diego", "Ivan", "Kofi", "Jin", "Rashid", "Viktor",
  "Carlos", "Dante", "Malik", "Sergei", "Emilio", "Kwame", "Hiro", "Andre",
  "Roman", "Jamal", "Nikolai", "Tomas", "Renzo", "Benny", "Floyd", "Manny",
  "Julio", "Dmitri", "Akeem", "Luis", "Tommy", "Saul", "Eddie", "Ray",
  "Bruno", "Lennox", "Felix", "Omar", "Santos", "Rocky", "Leo", "Jake",
  "Arturo", "Canelo", "Gennady", "Vasyl", "Naoya", "Terence", "Errol",
  "Oleksandr", "Devin", "Jermell", "Caleb", "Vergil", "Miguel", "Adrien",
  "Teofimo", "Ryan", "Tank", "Zurdo", "Abel", "Zach",
];

const LAST_NAMES = [
  "Stone", "Rivera", "Petrov", "Okafor", "Tanaka", "Hassan", "Volkov",
  "Cruz", "Williams", "Kozlov", "Santos", "Mensah", "Nakamura", "Torres",
  "Jackson", "Romanov", "Gomez", "Washington", "Marquez", "Kim",
  "Sterling", "Vega", "Johnson", "Morales", "Diaz", "Fury", "Ward",
  "Valdez", "Ortiz", "Garcia", "Lopez", "Alvarez", "Crawford", "Spence",
  "Usyk", "Haney", "Plant", "Estrada", "Inoue", "Beterbiev", "Charlo",
  "Davis", "Canizales", "Castano", "Fundora", "Berlanga", "Ramirez",
  "Stevenson", "Harrison", "Benavidez",
];

const NICKNAMES = [
  "The Hammer", "Iron Fist", "Lightning", "The Bull", "Razor",
  "The Ghost", "Dynamite", "The Cobra", "Steel", "Thunder",
  "The Machine", "Nightmare", "The Executioner", "Pitbull", "The Surgeon",
  "Smokin", "The Hitman", "Prince", "The Body Snatcher", "Cannonball",
  "Bone Crusher", "The Destroyer", "Venom", "The Natural", "Showtime",
  "Pretty Boy", "Money", "Pac-Man", "Maravilla", "Baby Bull",
  "El Chacal", "Sweet Hands", "King", "The Problem", "Boo Boo",
  "The Takeover", "Boots", "The Cat", "Double G", "Hi-Tech",
  "The Monster", "Silky", "Caution", "Magnificent", "Turbo",
  "", "", "", "", "",
];

const ARCHETYPES: Archetype[] = ["BoxerPuncher", "OutBoxer", "Brawler", "Swarmer"];

function seededRandom(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

export function generateOpponent(boutIndex: number, difficulty: AIDifficulty, fighterId: string): CareerOpponent {
  let seed = 0;
  for (let i = 0; i < fighterId.length; i++) {
    seed = ((seed << 5) - seed + fighterId.charCodeAt(i)) | 0;
  }
  seed = (seed + boutIndex * 7919) | 0;
  const rng = seededRandom(Math.abs(seed));

  const firstIdx = Math.floor(rng() * FIRST_NAMES.length);
  const lastIdx = Math.floor(rng() * LAST_NAMES.length);
  const nickIdx = Math.floor(rng() * NICKNAMES.length);

  const firstName = FIRST_NAMES[firstIdx];
  const lastName = LAST_NAMES[lastIdx];
  const nick = NICKNAMES[nickIdx];

  const name = nick ? `${firstName} "${nick}" ${lastName}` : `${firstName} ${lastName}`;

  const baseLevel = 1 + Math.floor(boutIndex * 0.5);
  const variance = Math.floor(rng() * 5) - 2;
  let level = Math.max(1, baseLevel + variance);

  const difficultyMults: Record<AIDifficulty, number> = {
    journeyman: 0.8,
    contender: 1.0,
    elite: 1.15,
    champion: 1.3,
  };
  level = Math.max(1, Math.round(level * difficultyMults[difficulty]));

  const archIdx = Math.floor(rng() * ARCHETYPES.length);
  const archetype = ARCHETYPES[archIdx];

  let aiDiff: AIDifficulty;
  if (boutIndex < 20) {
    aiDiff = "journeyman";
  } else if (boutIndex < 60) {
    aiDiff = "contender";
  } else if (boutIndex < 120) {
    aiDiff = "elite";
  } else {
    aiDiff = "champion";
  }

  const diffOverride: Record<AIDifficulty, number> = {
    journeyman: 0,
    contender: 1,
    elite: 2,
    champion: 3,
  };
  const aiDiffNum = Math.min(3, diffOverride[aiDiff] + (diffOverride[difficulty] > diffOverride[aiDiff] ? 1 : 0));
  const AI_DIFFS: AIDifficulty[] = ["journeyman", "contender", "elite", "champion"];
  aiDiff = AI_DIFFS[Math.min(3, aiDiffNum)];

  const armLength = Math.round(60 + rng() * 15);

  return { name, level, archetype, aiDifficulty: aiDiff, armLength };
}

export const MAX_CAREER_BOUTS = 200;
export const STAT_POINTS_PER_LEVEL = 2;
