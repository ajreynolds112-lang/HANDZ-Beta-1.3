import type { Fighter, GearColors } from "@shared/schema";
import { DEFAULT_GEAR_COLORS } from "@shared/schema";
import type { FighterColors } from "@/game/types";

/** A saved fighter's gear and skin as the 3D rig's colour set. */
export function trainingColors(fighter: Fighter): FighterColors {
  const gc = (fighter.gearColors as GearColors | null) || DEFAULT_GEAR_COLORS;
  return {
    gloves: gc.gloves || "#cc0000",
    gloveTape: gc.gloveTape || "#eeeeee",
    trunks: gc.trunks || "#ffffff",
    shoes: gc.shoes || "#333333",
    skin: fighter.skinColor || "#e8c4a0",
    socks: gc.socks || "#f0f0f0",
    laces: gc.laces,
    soles: gc.soles,
    waistStripe: gc.waistStripe,
  };
}
