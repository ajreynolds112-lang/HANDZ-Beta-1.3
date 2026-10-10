import type { Fighter, GearColors } from "@shared/schema";
import { DEFAULT_GEAR_COLORS } from "@shared/schema";
import type { FighterColors } from "@/game/types";
import { applySpacialGear, spacialSelectionOf } from "@/game/spacialColor";
import * as localSaves from "@/lib/localSaves";

/**
 * A saved fighter's gear and skin as the 3D rig's colour set, spacial finish
 * included. Read from the freshest save rather than the passed record: the
 * caller's fighter is a parent snapshot that can predate colour edits and
 * spacial purchases made in the hub.
 */
export function trainingColors(fighter: Fighter): FighterColors {
  const f = localSaves.getFighter(fighter.id) ?? fighter;
  const gc = (f.gearColors as GearColors | null) || DEFAULT_GEAR_COLORS;
  return applySpacialGear<FighterColors & Record<string, unknown>>({
    gloves: gc.gloves || DEFAULT_GEAR_COLORS.gloves,
    gloveTape: gc.gloveTape || DEFAULT_GEAR_COLORS.gloveTape,
    trunks: gc.trunks || DEFAULT_GEAR_COLORS.trunks,
    shoes: gc.shoes || DEFAULT_GEAR_COLORS.shoes,
    skin: f.skinColor || "#e8c4a0",
    headgear: gc.headgear || DEFAULT_GEAR_COLORS.headgear,
    socks: gc.socks || DEFAULT_GEAR_COLORS.socks,
    laces: gc.laces,
    soles: gc.soles,
    waistStripe: gc.waistStripe,
  }, spacialSelectionOf(f));
}
