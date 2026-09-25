// Deterministic per-fighter offense/defense execution profile.
// Generated purely from fighter identity (roster id) + archetype, so the same
// fighter always gets the same profile whether it's regenerated on the fly or
// read back from a persisted career save.

import type { OffenseProfile } from "@shared/schema";
import type { Archetype } from "./types";

export const OFFENSE_PROFILE_VERSION = 1;

// Small deterministic LCG (mulberry32-style) seeded from an integer.
function profileRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function archSeed(archetype: Archetype): number {
  switch (archetype) {
    case "BoxerPuncher": return 101;
    case "OutBoxer": return 211;
    case "Brawler": return 307;
    case "Swarmer": return 401;
    default: return 1;
  }
}

interface ArchBias {
  opening: number;      // opening-window sniping
  body: number;         // body campaigns
  ambush: number;       // close-range charged ambushes
  combo: number;        // combo layering / level changes
  ringCut: number;      // ring cutting
  discipline: number;   // post-exchange defensive discipline
  rhythmRead: number;   // reading repetitive head spam
}

function archBias(archetype: Archetype): ArchBias {
  switch (archetype) {
    case "OutBoxer":
      return { opening: 0.15, body: -0.10, ambush: -0.10, combo: -0.05, ringCut: -0.05, discipline: 0.15, rhythmRead: 0.15 };
    case "Brawler":
      return { opening: -0.05, body: 0.05, ambush: 0.18, combo: 0.05, ringCut: 0.10, discipline: -0.10, rhythmRead: -0.05 };
    case "Swarmer":
      return { opening: 0.00, body: 0.18, ambush: 0.05, combo: 0.12, ringCut: 0.15, discipline: -0.05, rhythmRead: 0.00 };
    case "BoxerPuncher":
    default:
      return { opening: 0.10, body: 0.05, ambush: 0.05, combo: 0.08, ringCut: 0.05, discipline: 0.08, rhythmRead: 0.08 };
  }
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

// Deterministic: same (id, archetype) always yields the same profile.
export function generateOffenseProfile(rosterId: number, archetype: Archetype): OffenseProfile {
  const r = profileRng((rosterId | 0) * 2654435761 + archSeed(archetype) * 97);
  const b = archBias(archetype);
  return {
    version: OFFENSE_PROFILE_VERSION,
    openingShots: clamp01(0.25 + r() * 0.55 + b.opening),
    bodyCampaign: clamp01(0.15 + r() * 0.55 + b.body),
    bodyCampaignRangePx: 34 + Math.round(r() * 26),           // 34–60px preferred campaign range
    bodyCampaignDuration: 4 + Math.round(r() * 6),            // 4–10s campaigns
    chargedAmbush: clamp01(0.10 + r() * 0.45 + b.ambush),
    chargedAmbushRangePx: 30 + Math.round(r() * 18),          // 30–48px ambush trigger range
    chargedAmbushBars: 1 + (r() < 0.55 ? 0 : r() < 0.75 ? 1 : 2), // 1–3 bars
    comboLayering: clamp01(0.20 + r() * 0.55 + b.combo),
    ringCutting: clamp01(0.20 + r() * 0.55 + b.ringCut),
    bodySpamCounter: clamp01(0.25 + r() * 0.55 + b.rhythmRead * 0.5),
    headRhythmRead: clamp01(0.20 + r() * 0.55 + b.rhythmRead),
    chargedRespect: clamp01(0.30 + r() * 0.55 + b.discipline * 0.5),
    postExchangeDiscipline: clamp01(0.20 + r() * 0.55 + b.discipline),
  };
}

// Fallback for non-roster opponents (quick fight randoms, nightmare, etc.):
// seeded from archetype + level so it's stable within a fight but varied across fights.
export function generateFallbackOffenseProfile(archetype: Archetype, seed: number): OffenseProfile {
  const pseudoId = 100000 + (Math.abs(seed | 0) % 100000);
  return generateOffenseProfile(pseudoId, archetype);
}
