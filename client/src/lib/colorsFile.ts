/**
 * Colours file: every non-player colour on a career save (ring palette and
 * gym look colours), downloadable from one save and uploadable onto another.
 * The gym name is not a colour and does not travel.
 */
import type { Fighter } from "@shared/schema";
import { RING_COLOR_KEYS, type RingColors } from "@/game/ringColors";
import { GYM_LOOK_DEFAULTS, gymLookOf, type GymLook } from "@/game/gymLook";
import { SPACIAL_COLOR } from "@/game/spacialColor";
import * as localSaves from "@/lib/localSaves";

const KIND = "handz-colors";
const HEX = /^#[0-9a-fA-F]{6}$/;
const GYM_COLOR_KEYS = (Object.keys(GYM_LOOK_DEFAULTS) as (keyof GymLook)[]).filter(k => k !== "name");

export interface ColorsFile {
  kind: typeof KIND;
  version: 1;
  ringColors: RingColors;
  gymColors: Omit<GymLook, "name">;
}

export function exportColors(f: Fighter): ColorsFile {
  const ring = (f.ringColors ?? {}) as RingColors;
  const ringColors: RingColors = {};
  for (const k of RING_COLOR_KEYS) if (typeof ring[k] === "string" && ring[k]) ringColors[k] = ring[k];
  const look = gymLookOf(f);
  const gymColors: Omit<GymLook, "name"> = {};
  for (const k of GYM_COLOR_KEYS) if (look[k]) (gymColors as Record<string, string>)[k] = look[k]!;
  return { kind: KIND, version: 1, ringColors, gymColors };
}

/** Apply a colours file to a save. Throws on a file that isn't one. */
export function importColors(fighterId: string, data: unknown): Fighter {
  const d = data as Partial<ColorsFile> | null;
  if (!d || typeof d !== "object" || d.kind !== KIND) throw new Error("Not a colours file");
  const f = localSaves.getFighter(fighterId);
  if (!f) throw new Error("Save not found");

  // The Spacial ring finish only applies to a save that has bought it.
  const spacialOk = !!f.ringSpacialUnlocked;
  const ringIn = (d.ringColors ?? {}) as Record<string, unknown>;
  const ringColors: Record<string, string> = {};
  for (const k of RING_COLOR_KEYS) {
    const v = ringIn[k];
    if (typeof v !== "string") continue;
    if (HEX.test(v) || (v === SPACIAL_COLOR && spacialOk)) ringColors[k] = v;
  }

  const gymIn = (d.gymColors ?? {}) as Record<string, unknown>;
  const gymLook: Record<string, string> = {};
  const keepName = gymLookOf(f).name;
  if (keepName) gymLook.name = keepName;
  for (const k of GYM_COLOR_KEYS) {
    const v = gymIn[k];
    if (typeof v === "string" && HEX.test(v) && (k === "wall" || v !== GYM_LOOK_DEFAULTS[k])) gymLook[k] = v;
  }

  const updated = localSaves.updateFighter(fighterId, {
    ringColors: Object.keys(ringColors).length ? ringColors : null,
    gymLook,
  });
  if (!updated) throw new Error("Failed to save colours");
  return updated;
}
