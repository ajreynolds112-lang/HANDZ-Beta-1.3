/**
 * Applies item boosts to a live fight.
 *
 * Kept out of `engine.ts` so it can be exercised without loading the engine's
 * audio and asset imports. `engine.ts` re-exports both symbols.
 */
import type { GameState } from "./types";

/**
 * Modifiers items apply to the player for one fight.
 *
 * Every `*Pct` field is a **fraction** (0.25 = +25%), already normalized from
 * the whole-percentage values the effect table stores. Chance fields are 0–1.
 */
export interface ItemFightMods {
  powerPct: number;
  speedPct: number;
  defensePct: number;
  staminaPct: number;
  focusPct: number;
  dodgePct: number;
  critPct: number;
  staminaRecoveryPct: number;
  stunChancePct: number;
  kdAvoidChance: number;
  rhythmCutFailChance: number;
}

/**
 * Layer item boosts on top of the fighter the stat/refinement passes already
 * built. Applied as multipliers so base stat storage and the existing caps stay
 * untouched — an item can push a derived value past a stat cap, but it never
 * rewrites the stats themselves.
 *
 * Call once, right after `startFight`, before the fight is handed to the loop.
 *
 * The tutorial is exempt for both corners. It teaches the base mechanics on a
 * fixed generic fighter, so a boosted stat would quietly change the numbers the
 * lessons are calibrated against. No tutorial path applies mods today; the
 * guard lives here so a future caller can't reintroduce them by accident.
 */
export function applyItemFightMods(
  state: GameState,
  mods: ItemFightMods,
  target: "player" | "opponent" = "player",
): void {
  if (state.tutorialMode) return;
  const p = target === "opponent" ? state.enemy : state.player;
  // Power is the exception to the "applied as multipliers" note above: it ADDS to
  // the fighter's power pool so it sums with refinements, gloves and drilled
  // mastery rather than compounding on top of them.
  if (mods.powerPct) p.powerBonusPct += mods.powerPct;
  if (mods.speedPct) {
    p.punchSpeedMult *= 1 + mods.speedPct;
    p.moveSpeed *= 1 + mods.speedPct;
    p.duckSpeedMult *= 1 + mods.speedPct;
  }
  if (mods.defensePct) {
    p.blockMult *= 1 + mods.defensePct;
    p.critResistMult = Math.max(0, p.critResistMult * (1 - mods.defensePct));
    p.autoGuardDuration *= 1 + mods.defensePct;
  }
  if (mods.staminaPct) {
    p.maxStamina *= 1 + mods.staminaPct;
    p.maxStaminaCap *= 1 + mods.staminaPct;
    p.stamina = p.maxStamina;
  }
  if (mods.focusPct) {
    p.critMult *= 1 + mods.focusPct;
    p.stunMult *= 1 + mods.focusPct;
  }
  if (mods.staminaRecoveryPct) p.staminaRegen *= 1 + mods.staminaRecoveryPct;
  if (mods.critPct) p.critMult *= 1 + mods.critPct;
  if (mods.stunChancePct) p.stunMult *= 1 + mods.stunChancePct;
  // Flat dodge chance, on its own independent roll in tryHit.
  if (mods.dodgePct) {
    p.slipperyDodgeBonus = Math.min(0.95, (p.slipperyDodgeBonus ?? 0) + mods.dodgePct);
  }
  // Chance-based effects live on the state rather than the fighter, so each
  // side gets its own slot. The rhythm-cut save is a player-only mechanic, so
  // an opponent's copy of that item simply has nothing to act on.
  if (target === "opponent") {
    state.opponentItemKdAvoidChance = Math.max(0, Math.min(1, mods.kdAvoidChance));
    return;
  }
  state.itemKdAvoidChance = Math.max(0, Math.min(1, mods.kdAvoidChance));
  state.itemRhythmCutFailChance = Math.max(0, Math.min(1, mods.rhythmCutFailChance));
}
