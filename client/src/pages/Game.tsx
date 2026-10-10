import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { requestCloudSave, setScreenKind } from "@/lib/uiChrome";
import BackgroundTrainingControl from "@/components/BackgroundTrainingControl";
import { pauseBackgroundTraining } from "@/game/backgroundTraining";
import * as localSaves from "@/lib/localSaves";
import { GameState, Archetype, FighterColors, DEFAULT_PLAYER_COLORS, AIDifficulty, TimerSpeed, DoghouseOpponentSpec, BoxingStance, PunchType } from "@/game/types";
import { creditBagSession } from "@/game/drilledActions";
import { createInitialState, startFight, startNextRound, xpToNextLevel, extractPerformanceStats, extractPlayerPlaystyle, savePlayerPlaystyle, activateNightmareMode, clearAllKeys, applyItemFightMods, applyAiPatternStudy, foldAiPatternLibrary, attachDrilledActions, collectDrilledActions, collectResetTrainingReps, carryDrilledActions, applyFightEquipment, spreadRefinementPoints, activeRefinementsOnly, MAX_ACTIVE_REFINEMENTS, REFINEMENT_TOTAL_CAP, NIGHTMARE_REFINEMENT_STEP_PCT, nightmareRefinementBudgetFor, DOGHOUSE_ENEMY_STAMINA_MULT, DOGHOUSE_PLAYER_STAMINA_MULT } from "@/game/engine";
import {
  uniformEquipmentLevels, scaleEquipmentLevels,
  SPARRING_EQUIPMENT_SHARE, NIGHTMARE_EQUIPMENT_SHARE, DOGHOUSE_EQUIPMENT_SHARE,
} from "@/game/equipmentConfig";
import { getEquipmentLevels } from "@/lib/equipmentUpgrades";
import { soundEngine } from "@/game/sound";
import { resetAutoZoom } from "@/game/renderer";
import {
  initRosterState,
  clearRosterCustomizationNumbers,
  simulateWeek,
  simulateWeekSteps,
  ensureEndgamePool,
  isChampBeaten,
  refinementTotal,
  computePlayerRankFromRating,
  updatePlayerRating,
  smoothPlayerRankMovement,
  computeEloChange,
  updateRankings,
  resolveRank1Holder,
  buildOpponentFromRoster,
  getRandomQuickFightOpponent,
  getRosterFighterColors,
  getRosterEntryById,
  getQuickFightColorsForRosterId,
  saveRosterCustomizations,
  EXPANDED_BOARD_WIN_THRESHOLD,
} from "@/game/careerRoster";
import {
  applyPunchEndurance, clampPunchEndurance, punchEnduranceOf,
  clampPunchEnduranceLoss, punchEnduranceLossOf, PUNCH_ENDURANCE_LOSS_PER_BAG_SESSION,
  NIGHTMARE_KILLS_PER_PUNCH_ENDURANCE,
} from "@/game/punchEndurance";
import { applyPurePower, clampPurePower, purePowerOf, PURE_POWER_PER_SESSION } from "@/game/purePower";
import { grantDefensiveMasteryBonus, perfectBlocksOf, doghousePerfectBlocksBankedOf, MASTERY_PCT_PER_PERFECT_BLOCK, MASTERY_PCT_PER_PERFECT_BLOCK_DOGHOUSE } from "@/game/defensiveMastery";
import { applySlipTraining, autoSlipTrainedOf, bankSlipsLanded, grantSlipTraining, slipsLandedOf, SLIP_TRAINING_PCT_PER_SLIP, SLIP_TRAINING_PCT_PER_SLIP_DOGHOUSE } from "@/game/slipTraining";
import { applyResetTraining, resetTrainingOf, growResetTraining, resetSpeedBonusOf, sparSessionsForDifficulty, sparSessionsForSeconds, RESET_SPEED_PER_NIGHTMARE_WIN, RESET_SPEED_PER_DOGHOUSE_WIN } from "@/game/resetTraining";
import { KEY_FIGHTER_IDS, getRosterDisplayName, type RosterEntry } from "@/game/rosterData";
import { applySpacialGear, spacialSelectionOf } from "@/game/spacialColor";
import GameCanvas from "@/game/GameCanvas";
import RingWalkOverlay from "@/components/RingWalkOverlay";
import DecisionCeremony from "@/components/DecisionCeremony";
import MainMenu from "@/components/MainMenu";
import MenuBackgroundFight from "@/components/MenuBackgroundFight";
import RingOnlyBackground from "@/components/RingOnlyBackground";
import ClassSelect from "@/components/ClassSelect";
import RoundEnd from "@/components/RoundEnd";
import FightEnd from "@/components/FightEnd";
import CareerMode, { type TrainingType, RosterEditView, AllocateStats, RefinementView, refinementExchangeCost, refUnlockForceCost, refUnlockShardCost } from "@/components/CareerMode";
import { SPARRING_MODE_COSTS, type SparringMode } from "@/game/sparringModes";
import { ringColorsOf } from "@/game/ringColors";
import { gymLookOf } from "@/game/gymLook";
import WeightLiftingGame from "@/components/WeightLiftingGame";
import { PAID_SWEEP_SHARD_COST } from "@/components/GymView";
import { cappedStatPointForce, FORCE_PER_CAPPED_SP_BOUT, FORCE_PER_CAPPED_SP_TRAINING } from "@/game/statPointEconomy";
import HeavyBagGame from "@/components/HeavyBagGame";
import PausePunchEditor from "@/components/PausePunchEditor";
import { Settings } from "lucide-react";
import type { Fighter, SkillPoints, CareerStats, GearColors, TrainingBonuses, CareerRosterState, RosterFighterState, SkillRefinement, ItemInventory } from "@shared/schema";
import { DEFAULT_CAREER_STATS, DEFAULT_TRAINING_BONUSES, DEFAULT_GEAR_COLORS, DEFAULT_SKILL_REFINEMENT, statPointCap, totalSkillPts, perStatCap, refinementSlotsForRank, refinementSlotsUnlocked, REFINEMENT_SLOT_RANK_UNLOCKS, BASE_ACTIVE_REFINEMENT_SLOTS } from "@shared/schema";
import { loadXpConfig } from "@/lib/xpConfig";
import CrateRevealView from "@/components/CrateRevealView";
import { useEnterKey, ENTER_PRIORITY } from "@/hooks/useEnterKey";
import {
  rollCrateForFighter, rollRarityItemForFighter, claimOpponentKeepsakes, consumeBoostsFor, pruneBoosts,
  nullifySimulatedWeekBoosts, accrueCoachNotes, withSavedInventory, recoverLockerFromLifetime,
  healLockerFromLedger, normalizeKeepsakeHoldings, purgeRetiredItems, getInventory,
  hasAllKeepsakesAndCoins, heldKeepsakeIds,
} from "@/lib/itemInventory";
import { getItemDefinition, ITEM_RARITIES, type ItemRarity } from "@/game/itemsConfig";
import {
  openFightBoostEscrow, closeFightBoostEscrow, restoreFightBoostEscrow,
} from "@/lib/fightBoostEscrow";
import {
  getSparringXpMult, getSparringSpMult, getGymSparringXpMult, getTrainingMods, getForceMult, getCoachNotesRate, COACH_NOTES_STATS, getFightMods,
  boostsFromItemCounts, fightModsFromBoosts,
} from "@/game/itemEffects";
import { rollOpponentItems } from "@/game/itemDistConfig";
import FightItemsHud from "@/components/FightItemsHud";
import PatternMemoryHud from "@/components/PatternMemoryHud";
import LoadingScreen from "@/components/LoadingScreen";
import { preload3dAssets } from "@/game/three/preload3d";
import { useChunkedLoader } from "@/lib/useChunkedLoader";
import { pickRewardCrates, getAiPunchEnduranceLossForRank } from "@/game/rosterGenConfig";
import { computeForceEarned } from "@/game/forceRewards";
import { getSparringRewardConfig, SPARRING_WIN_RARITY_CAP, sparringRewardTier, sparringWinRarity, isSparringUpgrade, SPARRING_TIER_LABELS, championDefenceDiamonds, type SparringDuration } from "@/game/sparringRewards";
import type { CrateId } from "@/game/cratesConfig";

/**
 * What a sparring defeat pays, as a share of the session's stat points. It is
 * applied at the very end of the accumulation, which is the point: everything
 * that fed the total is included by construction — the camp/prep bonus, the
 * configured sparring multiplier and the item SP boost among them — so a loss
 * keeps its proportion of each rather than being zeroed out. Bonuses that are
 * already win-gated (the difficulty base, the KO-speed bonus, the Import
 * Ticket) never entered the total on a loss, so they are not discounted twice.
 */
const SPARRING_LOSS_SP_SHARE = 0.5;

/** Nightmare KO milestones — every threshold a run clears pays out one chest. */
const NIGHTMARE_CRATE_MILESTONES: { kos: number; crate: CrateId }[] = [
  { kos: 10, crate: "elite" },
  { kos: 15, crate: "champion" },
  { kos: 25, crate: "undisputed" },
  { kos: 35, crate: "goat" },
];

/**
 * Doghouse pays one chest per opponent put away, on a fixed ladder: the first
 * scalp is a Champion's Crate, the second an Undisputed's, and every one after
 * that is a coin flip between a GOAT's and an Undisputed's. Deeper runs are
 * what pay, rather than a flat per-chest gamble.
 */
function doghouseCrateForIndex(index: number, rng: () => number = Math.random): CrateId {
  if (index === 0) return "champion";
  if (index === 1) return "undisputed";
  return rng() < 0.5 ? "goat" : "undisputed";
}

/** Doghouse opponents keep coming, so the payout gets a sane ceiling per round. */
const DOGHOUSE_MAX_CHESTS = 30;

/**
 * Roll the Doghouse haul: one chest per opponent put away, each drawn off the
 * inventory the previous chest produced so lifetime caps and one-time keepsakes
 * hold across the whole run. Shared by the normal fight end and the early
 * finish so both pay out identically.
 */
function rollDoghouseChests(
  fighter: Fighter,
  inventory: ItemInventory | null,
  opponentsDefeated: number,
  playerRank: number | null,
): { inventory: ItemInventory | null; crates: { crateId: CrateId; itemIds: string[] }[] } {
  const crates: { crateId: CrateId; itemIds: string[] }[] = [];
  let inv = inventory;
  const count = Math.min(Math.max(0, opponentsDefeated), DOGHOUSE_MAX_CHESTS);
  for (let i = 0; i < count; i++) {
    const crateId = doghouseCrateForIndex(i);
    const roll = rollCrateForFighter(inv ? { ...fighter, itemInventory: inv } : fighter, crateId, playerRank, false, "training");
    if (roll.inventory && roll.itemIds.length > 0) {
      crates.push({ crateId, itemIds: roll.itemIds });
      inv = roll.inventory;
    }
  }
  return { inventory: inv, crates };
}

/**
 * Workout rep milestones. A session pays the highest tier its rep count clears
 * and nothing below the first threshold. During the last week of a fight camp
 * the same ranges pay a chest of that tier instead of a single item.
 */
const TRAINING_REWARD_TIERS: Record<"weightLifting" | "heavyBag", { reps: number; rarity: ItemRarity; crate: CrateId }[]> = {
  // Workouts top out at Undisputed — GOAT rewards come from fights, not the gym.
  weightLifting: [
    { reps: 70, rarity: "Undisputed", crate: "undisputed" },
    { reps: 60, rarity: "Champion", crate: "champion" },
    { reps: 45, rarity: "Elite", crate: "elite" },
    { reps: 30, rarity: "Journeyman", crate: "journeyman" },
  ],
  heavyBag: [
    { reps: 60, rarity: "Undisputed", crate: "undisputed" },
    { reps: 55, rarity: "Champion", crate: "champion" },
    { reps: 50, rarity: "Elite", crate: "elite" },
    { reps: 35, rarity: "Journeyman", crate: "journeyman" },
  ],
};

/**
 * Pay out a finished workout. `fighter` must already carry the freshest
 * inventory; the returned inventory is what the caller folds into its own save
 * write so the reward and the session results land together.
 */
function grantTrainingReward(opts: {
  fighter: Fighter;
  inventory: ItemInventory | null;
  type: "weightLifting" | "heavyBag";
  reps: number;
  lastCampWeek: boolean;
  playerRank: number | null;
}): {
  inventory: ItemInventory | null;
  crate: { crateId: CrateId; itemIds: string[] } | null;
  itemNames: string[];
  rarity: ItemRarity | null;
} {
  const none = { inventory: null, crate: null, itemNames: [] as string[], rarity: null };
  const tier = TRAINING_REWARD_TIERS[opts.type].find(t => opts.reps >= t.reps);
  if (!tier) return none;
  const base = opts.inventory ? { ...opts.fighter, itemInventory: opts.inventory } : opts.fighter;

  if (opts.lastCampWeek) {
    // The gym is the one reward path keepsakes can come out of — one of each,
    // ever, enforced by the roll itself.
    const roll = rollCrateForFighter(base, tier.crate, opts.playerRank, true, "training");
    if (!roll.inventory || roll.itemIds.length === 0) return none;
    return {
      inventory: roll.inventory,
      crate: { crateId: tier.crate, itemIds: roll.itemIds },
      itemNames: [],
      rarity: tier.rarity,
    };
  }

  const roll = rollRarityItemForFighter(base, tier.rarity, opts.playerRank, null, true, "training");
  if (!roll.inventory || roll.itemIds.length === 0) return none;
  return {
    inventory: roll.inventory,
    crate: null,
    itemNames: roll.itemIds.map(id => getItemDefinition(id)?.name ?? id),
    rarity: tier.rarity,
  };
}

function generateWeeklyBonus(
  wins: number,
  careerStats: CareerStats | null | undefined,
  newRosterState: CareerRosterState
): CareerRosterState["weeklyBonus"] {
  const isFightWeek = newRosterState.selectedOpponentId != null && (newRosterState.prepWeeksRemaining ?? 1) === 0;
  if (isFightWeek) return null;
  const kdsGiven = (careerStats as CareerStats | null)?.totalKnockdownsGiven ?? 0;
  const chance = Math.min(0.95, 0.5 + kdsGiven * 0.001);
  if (Math.random() >= chance) return null;
  const types: Array<"weightLifting" | "heavyBag" | "sparring"> = ["weightLifting", "heavyBag", "sparring"];
  const trainingType = types[Math.floor(Math.random() * 3)];
  const bonusType: "xp" | "sp" = Math.random() < 0.5 ? "xp" : "sp";
  const tierRoll = Math.random();
  let value: number;
  if (bonusType === "xp") {
    value = tierRoll < 0.5 ? 2 : tierRoll < 0.8 ? 3 : tierRoll < 0.95 ? 4 : 5;
  } else {
    value = tierRoll < 0.5 ? 5 : tierRoll < 0.8 ? 10 : tierRoll < 0.95 ? 15 : 20;
  }
  return { trainingType, bonusType, value };
}

function applyTrainingDecay(rosterState: CareerRosterState, sp: SkillPoints): SkillPoints {
  const week = rosterState.weekNumber;
  let { power, speed, defense, stamina, focus } = { ...sp };
  const weeksSinceSpar = week - (rosterState.lastSparWeek ?? 0);
  if (weeksSinceSpar >= 6) {
    const d1 = Math.random() < 0.5 ? 2 : 3;
    const d2 = Math.random() < 0.5 ? 2 : 3;
    focus   = Math.max(0, focus   - d1);
    stamina = Math.max(0, stamina - d2);
  }
  const weeksSinceWL = week - (rosterState.lastWLWeek ?? 0);
  if (weeksSinceWL >= 6) {
    power   = Math.max(0, power   - 1);
    defense = Math.max(0, defense - 1);
  }
  const weeksSinceHB = week - (rosterState.lastHBWeek ?? 0);
  if (weeksSinceHB >= 6) {
    speed = Math.max(0, speed - 1);
  }
  return { power, speed, defense, stamina, focus };
}

const FIGHT_MILESTONES: Array<{
  type: "wins" | "bouts" | "level" | "trainingSessions";
  threshold: number;
  title: string;
  description: string;
  icon: string;
}> = [
  { type: "wins", threshold: 6, title: "Training Upgrade!", description: "You can now choose an additional stat Weight Lifting trains.", icon: "💪" },
  { type: "wins", threshold: 15, title: "Sparring Mastery!", description: "All stats are now available in every sparring session.", icon: "🥊" },
  { type: "bouts", threshold: 15, title: "Iron Conditioning!", description: "Weight Lifting now allows Stamina growth alongside Power and Defense.", icon: "🏆" },
  { type: "level", threshold: 30, title: "Rebuild Skills Unlocked!", description: "You can now reset and reallocate all your stat points from the career hub at any time.", icon: "🔨" },
  { type: "trainingSessions", threshold: 50, title: "High-Score Simulation Unlocked!", description: "Simulate Week now recreates your personal-best Weight Lifting and Heavy Bag reps instead of a flat 12, at 0.85× XP and 0.85× Stat Points (rounded up).", icon: "🏋️" },
  { type: "level", threshold: 50, title: "Skill Refinement Unlocked!", description: "You can now access the Refinement system — exchange stat points for refinement points and fine-tune your fighter's edge. Cost: 10 SP per point.", icon: "🔷" },
  { type: "level", threshold: 60, title: "Refinement Cost Reduced! (9 SP)", description: "Your experience is paying off. Skill Refinement now costs only 9 SP per point.", icon: "🔷" },
  { type: "level", threshold: 70, title: "Refinement Cost Reduced! (8 SP)", description: "Refinement now costs 8 SP per point — keep grinding.", icon: "🔷" },
  { type: "level", threshold: 80, title: "Refinement Cost Reduced! (7 SP)", description: "Refinement now costs 7 SP per point.", icon: "🔷" },
  { type: "level", threshold: 120, title: "Refinement Cost Reduced! (6 SP)", description: "Elite-level efficiency. Refinement now costs 6 SP per point.", icon: "🔷" },
  { type: "level", threshold: 170, title: "Refinement Cost Reduced! (5 SP)", description: "Refinement now costs 5 SP per point — you're approaching mastery.", icon: "🔷" },
  { type: "level", threshold: 250, title: "Refinement Cost Reduced! (4 SP)", description: "Refinement now costs 4 SP per point.", icon: "🔷" },
  { type: "level", threshold: 350, title: "Refinement Cost Reduced! (3 SP)", description: "Refinement now costs 3 SP per point — legendary caliber.", icon: "🔷" },
  { type: "level", threshold: 500, title: "Refinement Cost Reduced! (2 SP)", description: "Maximum efficiency reached. Refinement costs only 2 SP per point.", icon: "🔷" },
];

/**
 * The week a gym activity that just happened should be stamped with.
 *
 * Both Punch Endurance clocks measure their grace period from the week the
 * activity was logged in, so the stamp is not bookkeeping — it *is* the
 * protection. A stamp that lands in the past shortens the grace by exactly as
 * many weeks as it is behind, and a stamp two weeks behind lets the very next
 * advance charge a point off work the player has only just done.
 *
 * That is why this cannot read the caller's captured copy. Payout handlers
 * rebuild the roster blob wholesale from a snapshot taken at render, which a
 * sibling handler may already have moved past — the same hazard that makes
 * grantPunchEndurance and improvedPunchEnduranceLoss re-read the save for their
 * *values*, applied to the week those values are dated with.
 *
 * Takes the later of the two rather than the saved week outright: the save
 * cannot legitimately be behind the snapshot, but a max says which direction
 * the hazard runs and still works for a fighter with no save row yet.
 */
function activityStampWeek(fighterId: string, rs: CareerRosterState | null | undefined): number {
  const saved = localSaves.getFighter(fighterId)?.careerRosterState as CareerRosterState | null;
  return Math.max(rs?.weekNumber ?? 0, saved?.weekNumber ?? 0);
}

/**
 * Record that a sparring session (regular, Doghouse or Nightmare) happened this
 * week, restarting the three-week Punch Endurance decay clock. Apply it *before*
 * the week advance: the decay pass measures against `lastSparWeek`, so a session
 * stamped with the week being left can never be decayed by the same advance.
 *
 * Takes the fighter id rather than reading the week off `rs` so the stamp is
 * always dated from the freshest save — see activityStampWeek.
 */
function stampSparWeek(fighterId: string, rs: CareerRosterState, sessions: number = 1): CareerRosterState {
  return { ...rs, lastSparWeek: activityStampWeek(fighterId, rs), totalSpars: nextSparCount(fighterId, rs, sessions) };
}

/**
 * The career's lifetime sparring count with this session added — what the
 * Reset's speed is read off. Same freshest-save rule as the week stamp above:
 * the blob a payout handler captured at render may already be a session behind
 * what a sibling handler has written, and a count that goes backwards would
 * hand the player's ring time back.
 */
function nextSparCount(fighterId: string, rs: CareerRosterState | null | undefined, sessions: number = 1): number {
  const saved = localSaves.getFighter(fighterId)?.careerRosterState as CareerRosterState | null;
  // Fractional and zero sessions are both legitimate: an ordinary session is
  // worth a multiple of one by the partner's grade, and Nightmare and the
  // Doghouse pay by the opponent, so a run that puts nobody away adds nothing.
  return Math.max(rs?.totalSpars ?? 0, saved?.totalSpars ?? 0) + Math.max(0, sessions);
}

/**
 * Bank a Punch Endurance gain onto the roster blob a payout is about to write.
 *
 * Payout handlers rewrite that blob wholesale from a copy captured at render,
 * which can be older than what a sibling handler has since persisted — so the
 * new total is built from the freshest saved value rather than the captured one.
 * Clamped to the 120 ceiling like every other read and write.
 */
/**
 * Pin the freshest saved pattern collections onto a roster blob.
 *
 * Two collections are earned in one mode and written by whole-blob roster
 * writes made in another, and they are exact mirror images of each other:
 *
 *   the AI pattern library is written by career bouts and never by gym work.
 *   the drilled action list is written by gym work and never by a career bout.
 *
 * Either way the danger is the same. Every roster write starts from the copy on
 * activeFighter, which can predate whatever the OTHER mode last folded in, so
 * writing it back would quietly roll that mode's progress off. Both collections
 * are therefore re-read from the save and pinned on here, and every roster
 * write -- the gym exits AND the career bout -- goes through this one helper
 * rather than each site remembering which of the two it is at risk of losing.
 */
function withSavedPatternLibrary(fighterId: string, rs: CareerRosterState | null): CareerRosterState | null {
  if (!rs) return rs;
  const saved = localSaves.getFighter(fighterId)?.careerRosterState as CareerRosterState | null;
  if (!saved) return rs;
  const next = { ...rs };
  if (saved.aiPatternLibrary) next.aiPatternLibrary = saved.aiPatternLibrary;
  if (saved.drilledActions) next.drilledActions = saved.drilledActions;
  return next;
}

/**
 * Fold whatever the gym just drilled into a roster blob.
 *
 * Returns the blob untouched when the bout moved no counter, so a career bout
 * or a session with nothing repeated in it never rewrites the list.
 */
function withGymWorkFromBout(rs: CareerRosterState | null, st: GameState | null): CareerRosterState | null {
  if (!rs) return rs;
  let out = rs;
  const drilled = collectDrilledActions(st);
  if (drilled) out = { ...out, drilledActions: drilled };
  // The gym's Reset work rides the same fold so it reaches every bout-end path
  // the drilled list already does, and lands before the week sim can advance
  // past the week the work happened in.
  const reps = collectResetTrainingReps(st);
  if (reps) {
    const week = out.weekNumber ?? 0;
    let rt = resetTrainingOf(out);
    rt = growResetTraining(rt, "damage", reps.charge, week);
    rt = growResetTraining(rt, "slip", reps.slips, week);
    out = { ...out, resetTraining: rt };
  }
  return out;
}

/**
 * The Reset blocking buy-back after a Weight Lifting session adds its point.
 *
 * Reads the freshest saved value for the same reason improvedPunchEnduranceLoss
 * does: payout handlers rebuild the roster blob wholesale from a snapshot taken
 * at render, which a sibling handler may already have moved past.
 */
/** Pure Power after a Weight Lifting session adds its 20%, off the freshest save. */
function liftedPurePower(fighterId: string, rs: CareerRosterState | null): number {
  const saved = localSaves.getFighter(fighterId)?.careerRosterState as CareerRosterState | null;
  return clampPurePower(purePowerOf(saved ?? rs) + PURE_POWER_PER_SESSION);
}

function liftedResetBlock(fighterId: string, rs: CareerRosterState | null, week: number) {
  const saved = localSaves.getFighter(fighterId)?.careerRosterState as CareerRosterState | null;
  return growResetTraining(resetTrainingOf(saved ?? rs), "block", 1, week);
}

/** Diamonds the Doghouse pays per opponent put away, on top of its other rewards. */
const DOGHOUSE_DIAMONDS_PER_WIN = 5;

function grantPunchEndurance(fighterId: string, rs: CareerRosterState, gain: number): CareerRosterState {
  if (gain <= 0) return rs;
  const saved = localSaves.getFighter(fighterId)?.careerRosterState as CareerRosterState | null;
  return { ...rs, punchEndurance: clampPunchEndurance(punchEnduranceOf(saved ?? rs) + gain) };
}

/**
 * The Punch Endurance cost after a heavy bag session drills a point off it.
 *
 * Every session counts and lands the moment the session ends — the two-week
 * clock governs only the recovery back toward the ceiling, never the drill.
 * Gains are earned per session; only decay waits out a grace period.
 *
 * Reads the freshest saved value rather than the caller's captured copy for the
 * same reason grantPunchEndurance does: payout handlers rebuild the roster blob
 * wholesale from a snapshot taken at render, which a sibling handler may already
 * have moved past. Clamped, so it stops at the floor instead of going negative.
 */
/** Free bag mode pays the Punch Endurance cut at this many punches per minute of session. */
const FREE_BAG_PUNCHES_PER_MINUTE = 100;

function improvedPunchEnduranceLoss(fighterId: string, rs: CareerRosterState | null): number {
  const saved = localSaves.getFighter(fighterId)?.careerRosterState as CareerRosterState | null;
  return clampPunchEnduranceLoss(punchEnduranceLossOf(saved ?? rs) - PUNCH_ENDURANCE_LOSS_PER_BAG_SESSION);
}

function refCostReductionOf(f: { skillRefinement?: unknown } | null): number {
  return ((f?.skillRefinement as { costReduction?: number } | null)?.costReduction) || 0;
}

// Returns a stepwise predicate for "Refinement Cost Reduced" milestones: a
// milestone only shows if it strictly lowers the effective exchange cost
// (diamond reductions may already have it at/below, incl. the 1 SP minimum).
// Stateful across a single filter pass so multi-threshold level jumps only
// show milestones that each lower the cost further.
function makeRefCostMilestoneFilter(currentLevel: number, costReduction: number): (title: string, threshold: number) => boolean {
  let lastCost = refinementExchangeCost(currentLevel || 1, costReduction);
  return (title, threshold) => {
    if (!title.startsWith("Refinement Cost Reduced")) return true;
    const c = refinementExchangeCost(threshold, costReduction);
    if (c >= lastCost) return false;
    lastCost = c;
    return true;
  };
}

/** Screens whose exit back to the career hub gets the short gym loading screen. */
const GYM_RETURN_FROM = new Set<string>(["fighting", "fightEnd", "training", "trainingAllocate", "resultsCeremony"]);

type UIMode = "menu" | "classSelect" | "career" | "fighting" | "fightEnd" | "training" | "rosterEdit" | "simulating" | "tutorial" | "tutorialComplete" | "ringWalk" | "resultsCeremony" | "doghouseSetup" | "trainingAllocate";
/** Fights and minigames: the account/settings gear stays hidden over these. */
const PLAY_MODES = new Set<string>(["fighting", "training", "tutorial", "ringWalk"]);
/** Leaving any of these means a fight, minigame or payout just finished: save now. */
const SAVE_AFTER_MODES = new Set<string>(["fighting", "fightEnd", "training", "trainingAllocate", "resultsCeremony", "tutorial", "simulating", "doghouseSetup"]);
const BG_TRAINING_PAUSE_MODES = new Set<string>(["fighting", "training", "simulating", "ringWalk", "tutorial", "trainingAllocate"]);

function SimulationScreen({ news, weekNumber, onComplete }: { news: string[]; weekNumber: number; onComplete: () => void }) {
  const [visibleCount, setVisibleCount] = useState(0);
  const [done, setDone] = useState(false);
  const [tips, setTips] = useState<string[]>([]);

  useEnterKey(onComplete, { enabled: done });

  useEffect(() => {
    const allTips = localSaves.getFightTips();
    const weekCd = localSaves.getTipWeekCooldowns();
    const picked = localSaves.pickFightTips(2, allTips, (i) => {
      const last = weekCd[i];
      return last !== undefined && (weekNumber - last) < 3;
    });
    if (picked.length > 0) {
      const newCd = { ...weekCd };
      for (const p of picked) newCd[p.index] = weekNumber;
      localSaves.saveTipWeekCooldowns(newCd);
      setTips(picked.map(p => p.text));
    }
  }, []);

  useEffect(() => {
    if (visibleCount < news.length) {
      const timer = setTimeout(() => setVisibleCount(v => v + 1), 350);
      return () => clearTimeout(timer);
    } else if (news.length > 0) {
      const timer = setTimeout(() => setDone(true), 600);
      return () => clearTimeout(timer);
    } else {
      setDone(true);
    }
  }, [visibleCount, news.length]);

  return (
    <div className="fixed inset-0 bg-black flex flex-col items-center justify-center z-50" data-testid="simulation-screen">
      <div className="text-yellow-500 text-2xl font-black mb-2" data-testid="text-sim-week">Week {weekNumber}</div>
      <div className="text-white text-lg mb-6">Around the boxing world...</div>
      <div className="w-full max-w-md px-4 space-y-2 max-h-[60vh] overflow-y-auto">
        {news.slice(0, visibleCount).map((item, i) => {
          const isBold = item.startsWith("STATCAP:");
          const display = isBold ? item.slice("STATCAP:".length) : item;
          return (
            <div
              key={i}
              className={`text-sm bg-gray-900 rounded px-3 py-2 animate-in fade-in slide-in-from-bottom-2 duration-300 ${isBold ? "text-yellow-300 font-black text-base" : "text-gray-300"}`}
              data-testid={`text-sim-news-${i}`}
            >
              {display}
            </div>
          );
        })}
      </div>
      {done && (
        <button
          onClick={onComplete}
          autoFocus
          className="mt-8 px-6 py-2 bg-yellow-600 hover:bg-yellow-500 text-black font-bold rounded transition-colors"
          data-testid="button-sim-continue"
        >
          Continue
        </button>
      )}
      {tips.length > 0 && (
        <div className="absolute bottom-4 left-4 max-w-[220px] rounded-md p-2 space-y-1" style={{ background: "#0a0a0f", border: "1px solid #2a2218" }}>
          <p className="text-[10px] font-bold" style={{ color: "#d4af37" }}>💡 Fight Tips</p>
          {tips.map((tip, i) => (
            <p key={i} className="text-center text-[#ca8a07] font-bold text-[15px]" style={{ color: "#c9a227" }}>• {tip}</p>
          ))}
        </div>
      )}
    </div>
  );
}

function DoghouseSetupScreen({ onConfirm, onCancel }: { onConfirm: (durationSecs: number) => void; onCancel: () => void }) {
  const [minutes, setMinutes] = useState(20);
  const clamp = (v: number) => Math.max(15, Math.min(60, v));
  const display = `${String(minutes).padStart(2, "0")}:00`;
  const dhCost = SPARRING_MODE_COSTS.doghouse;
  return (
    <div className="fixed inset-0 bg-black flex flex-col items-center justify-center gap-6 z-50" data-testid="screen-doghouse-setup">
      <h1 className="text-5xl font-black tracking-widest text-yellow-400" style={{ textShadow: "0 0 30px rgba(255,200,0,0.45)" }} data-testid="text-doghouse-title">
        DOGHOUSE ROUND
      </h1>
      <p className="text-base text-[#bfe3ff] font-semibold tracking-wide" data-testid="text-doghouse-subtitle">Set the clock.</p>
      <div className="flex items-center gap-10 mt-2">
        <button
          onClick={() => setMinutes(m => clamp(m - 1))}
          disabled={minutes <= 15}
          className="w-16 h-16 rounded-full bg-[#1a3a5c] border border-[#2a5080] text-white text-4xl font-bold flex items-center justify-center disabled:opacity-30 hover:bg-[#2a5080] transition-colors"
          data-testid="button-doghouse-dec"
        >−</button>
        <div className="text-8xl font-black text-white" style={{ textShadow: "0 0 24px rgba(100,180,255,0.5)", fontVariantNumeric: "tabular-nums" }} data-testid="text-doghouse-clock">
          {display}
        </div>
        <button
          onClick={() => setMinutes(m => clamp(m + 1))}
          disabled={minutes >= 60}
          className="w-16 h-16 rounded-full bg-[#1a3a5c] border border-[#2a5080] text-white text-4xl font-bold flex items-center justify-center disabled:opacity-30 hover:bg-[#2a5080] transition-colors"
          data-testid="button-doghouse-inc"
        >+</button>
      </div>
      <div className="flex flex-col items-center gap-3 mt-6">
        <button
          onClick={() => onConfirm(minutes * 60)}
          className="px-12 py-4 bg-yellow-500 hover:bg-yellow-400 text-black font-black text-xl rounded-xl tracking-wider transition-colors shadow-xl"
          data-testid="button-doghouse-confirm"
        >
          ENTER THE DOGHOUSE
        </button>
        <button
          onClick={onCancel}
          className="px-6 py-2 text-[#8fcaf0] hover:text-white transition-colors text-[20px]"
          data-testid="button-doghouse-cancel"
        >BACK</button>
      </div>
      <div className="mt-4 text-center text-[#6a9abf] text-xs max-w-xs leading-relaxed">
        <span className="text-yellow-500 font-bold">2 knockdowns</span> and your session ends. Every opponent you put away pays experience and a crate — no stat points.
        <div className="mt-2 text-[#8fcaf0]">Entry: <span className="font-bold">{dhCost.sessionForce.toLocaleString()} Force</span> + <span className="font-bold">{dhCost.sessionShards.toLocaleString()} Shards</span>.</div>
      </div>
    </div>
  );
}

function TutorialCompleteScreen({ onFinish }: { onFinish: () => void }) {
  useEffect(() => {
    const timer = setTimeout(() => {
      onFinish();
    }, 4000);
    return () => clearTimeout(timer);
  }, [onFinish]);

  return (
    <div className="flex flex-col items-center justify-center min-h-screen gap-6 p-6" data-testid="tutorial-complete-screen">
      <h1
        className="text-3xl font-black tracking-wider text-primary text-center"
        style={{ textShadow: "0 0 30px rgba(200,50,50,0.3), 0 3px 6px rgba(0,0,0,0.4)" }}
        data-testid="text-tutorial-complete"
      >
        You seem to know what you're doing!
      </h1>
      <p className="text-xl text-yellow-500 font-bold text-center" data-testid="text-tutorial-encourage">
        Now let's Throw Some Handz!
      </p>
      <p className="text-sm text-muted-foreground mt-2" data-testid="text-tutorial-returning">
        Returning to main menu...
      </p>
    </div>
  );
}

export default function Game({ autoCreateCareer = false, canEditRoster = false }: { autoCreateCareer?: boolean; canEditRoster?: boolean }) {
  const [gameState, setGameState] = useState<GameState>(createInitialState());
  /**
   * The live fight state the canvas loop mutates 60x a second. `gameState` is
   * only a throttled snapshot of it, so any patch applied mid-fight has to build
   * on this object — patching the snapshot would rewind the bout by up to a
   * quarter of a second.
   */
  const liveStateRef = useRef<GameState>(gameState);
  // Drives the full-screen loading view for week advances and fight setup.
  const { loader, runLoader } = useChunkedLoader();
  /** Replace the whole fight state (fight start, restart, quit, round change). */
  const commitGameState = useCallback((next: GameState) => {
    liveStateRef.current = next;
    setGameState(next);
  }, []);
  /** Patch the live fight state in flight (XP ticks, pause tabs, forced endings). */
  const patchLiveState = useCallback((patch: (prev: GameState) => GameState) => {
    setGameState(prev => {
      const base = liveStateRef.current ?? prev;
      const next = patch(base);
      if (next === base) return prev;
      liveStateRef.current = next;
      return next;
    });
  }, []);
  const [uiMode, setUiModeRaw] = useState<UIMode>("menu");
  const uiModeRef = useRef<UIMode>("menu");
  // Background training waits out live bouts, minigames and the week sim:
  // they need the frame budget, and headless bouts share engine recording state.
  useEffect(() => {
    pauseBackgroundTraining("fight", BG_TRAINING_PAUSE_MODES.has(uiMode));
  }, [uiMode]);
  const setUiMode = useCallback((mode: UIMode) => {
    if (mode !== "fighting") {
      soundEngine.stopCrowdAmbient();
    }
    const from = uiModeRef.current;
    uiModeRef.current = mode;
    setScreenKind(PLAY_MODES.has(mode) ? "play" : mode === "menu" ? "menu" : "other");
    // Payouts persist in the same handler that switches screens; let them land first.
    if (from !== mode && (SAVE_AFTER_MODES.has(from) || mode === "fightEnd")) setTimeout(requestCloudSave, 300);
    // Finishing or quitting a bout or a training minigame: a short loading
    // screen covers the gym while its 3D scene is rebuilt underneath. Skipped
    // when a heavier loader (week advance) is already up.
    if (mode === "career" && from !== mode && GYM_RETURN_FROM.has(from)) {
      void runLoader({
        title: "Back To The Gym",
        minDurationMs: 650,
        phases: [{ label: "Setting up the gym", run: () => preload3dAssets() }],
      });
    }
    setUiModeRaw(mode);
  }, [runLoader]);
  // Boot: the first loading screen pulls in every 3D asset (boxer rig, props,
  // sign font) so the menu ring and the gym never pop models in after it lifts.
  useEffect(() => () => setScreenKind("menu"), []);
  useEffect(() => {
    void runLoader({
      title: "HANDZ",
      minDurationMs: 500,
      phases: [{ label: "Loading 3D assets", run: () => preload3dAssets() }],
    });
  }, [runLoader]);
  /**
   * True while a sparring session that actually resolved an imported roster
   * partner is running. The Import Ticket is only spent when this is set — a
   * session that fell back to a normal partner (no id, or an id that is no
   * longer on the roster) must leave the ticket armed.
   */
  const importedPartnerUsedRef = useRef(false);

  const [showPausePunchEditor, setShowPausePunchEditor] = useState(false);
  const [selectedArchetype, setSelectedArchetype] = useState<Archetype>("BoxerPuncher");
  const [activeFighterRaw, setActiveFighterRaw] = useState<Fighter | null>(null);
  const activeFighter = useMemo(() => {
    if (!activeFighterRaw) return null;
    const raw = (activeFighterRaw.skillPoints || {}) as Partial<SkillPoints>;
    return {
      ...activeFighterRaw,
      skillPoints: {
        power: raw.power || 0,
        speed: raw.speed || 0,
        defense: raw.defense || 0,
        stamina: raw.stamina || 0,
        focus: raw.focus || 0,
      } as SkillPoints,
    };
  }, [activeFighterRaw]);
  const setActiveFighter = setActiveFighterRaw;
  // Career-best rep/combo counts shown live inside the training minigames. Read
  // from the persisted save (the freshest copy) rather than the in-memory
  // fighter, and only when the active fighter changes — not on every render.
  const trainingRecords = useMemo(() => {
    if (!activeFighter) return { wl: 0, hb: 0 };
    const tb = ((localSaves.getFighter(activeFighter.id)?.trainingBonuses ?? activeFighter.trainingBonuses) || null) as TrainingBonuses | null;
    return { wl: tb?.wlHighScore ?? 0, hb: tb?.hbHighScore ?? 0 };
  }, [activeFighter]);
  const [preFightSnapshot, setPreFightSnapshot] = useState<Fighter | null>(null);
  /** Latched by the Doghouse early finish so its rewards can only be taken once. */
  const doghouseEarlyFinishedRef = useRef(false);
  const [isCareerFight, setIsCareerFight] = useState(false);
  const [playerColors, setPlayerColors] = useState<FighterColors>(() => {
    try {
      const raw = localStorage.getItem("quickFightColors");
      return raw ? JSON.parse(raw) : { ...DEFAULT_PLAYER_COLORS };
    } catch { return { ...DEFAULT_PLAYER_COLORS }; }
  });
  const savedQF = (() => {
    try {
      const raw = localStorage.getItem("quickFightSettings");
      const parsed = raw ? JSON.parse(raw) : null;
      // One-time clear of the stored AI Stamina handicap. A leftover 0.3 left CPU opponents on
      // a third of their pool, which reads in-fight as the AI refusing to engage rather than as
      // a handicap. The slider still works; this only drops the persisted value once.
      if (parsed && localStorage.getItem("handz_qf_ai_stamina_handicap_cleared") !== "true") {
        parsed.aiStaminaMult = 1;
        try {
          // Persist before flagging: if the write fails the flag stays unset, so the migration
          // retries next load instead of being marked done with the handicap still stored.
          localStorage.setItem("quickFightSettings", JSON.stringify(parsed));
          localStorage.setItem("handz_qf_ai_stamina_handicap_cleared", "true");
        } catch {
          // Storage unavailable. The in-memory value is corrected for this session regardless.
        }
      }
      return parsed;
    } catch { return null; }
  })();
  const [quickFightPlayerLevel, setQuickFightPlayerLevel] = useState(savedQF?.playerLevel ?? 1);
  const [quickFightEnemyLevel, setQuickFightEnemyLevel] = useState(savedQF?.enemyLevel ?? 1);
  const [aiDifficulty, setAiDifficulty] = useState<AIDifficulty>(savedQF?.difficulty ?? "contender");
  const [roundDurationMins, setRoundDurationMins] = useState(savedQF?.roundDuration ?? 3);
  const [timerSpeed, setTimerSpeed] = useState<TimerSpeed>(savedQF?.timerSpeed ?? "normal");
  const [maxRounds, setMaxRounds] = useState(savedQF?.maxRounds ?? 3);
  const [playerArmLength, setPlayerArmLength] = useState(savedQF?.playerArm ?? 65);
  const [enemyArmLength, setEnemyArmLength] = useState(savedQF?.enemyArm ?? 65);
  const [towelStoppageEnabled, setTowelStoppageEnabled] = useState(savedQF?.towelStoppage ?? true);
  const [practiceMode, setPracticeMode] = useState(savedQF?.practiceMode ?? false);
  const [recordInputs, setRecordInputs] = useState(savedQF?.recordInputs ?? false);
  const [cpuVsCpu, setCpuVsCpu] = useState(savedQF?.cpuVsCpu ?? false);
  const [aiPowerMult, setAiPowerMult] = useState(savedQF?.aiPowerMult ?? 1);
  const [aiSpeedMult, setAiSpeedMult] = useState(savedQF?.aiSpeedMult ?? 1);
  const [aiStaminaMult, setAiStaminaMult] = useState(savedQF?.aiStaminaMult ?? 1);
  const [quickFightNightmare, setQuickFightNightmare] = useState(savedQF?.nightmare ?? false);
  const [selectedRosterFighters, setSelectedRosterFighters] = useState<RosterEntry[]>([]);
  const [careerRefStoppageEnabled, setCareerRefStoppageEnabled] = useState(() => {
    try { const v = localStorage.getItem("handz_career_ref_stoppage"); return v !== null ? v === "true" : true; } catch { return true; }
  });
  const [careerTowelStoppageEnabled, setCareerTowelStoppageEnabled] = useState(() => {
    try { const v = localStorage.getItem("handz_career_towel_stoppage"); return v !== null ? v === "true" : true; } catch { return true; }
  });
  const [showExpBar, setShowExpBar] = useState(() => {
    try { const v = localStorage.getItem("handz_show_exp_bar"); return v === null ? true : v === "true"; } catch { return true; }
  });
  const [showFightItemsHud, setShowFightItemsHud] = useState(() => {
    try { const v = localStorage.getItem("handz_show_fight_items"); return v === null ? true : v === "true"; } catch { return true; }
  });
  const [trainingType, setTrainingType] = useState<TrainingType | null>(null);
  // Free heavy bag: unscored, no session count, no rewards.
  const [freeBagMode, setFreeBagMode] = useState(false);
  /** Free bag: the session's punches in order, banked into Drilled Actions on exit. */
  const freeBagPunchesRef = useRef<{ type: PunchType; head: boolean }[]>([]);
  // Chosen free-bag length (minutes); 0 = session never started.
  const freeBagMinutesRef = useRef(0);
  // True only once the free-bag clock has run all the way out.
  const freeBagFullTimeRef = useRef(false);
  const [trainingLiveXp, setTrainingLiveXp] = useState(0);
  const [sparringDifficulty, setSparringDifficulty] = useState<AIDifficulty>("contender");
  const [isSparring, setIsSparring] = useState(false);
  const [isNightmare, setIsNightmare] = useState(false);
  const [isDoghouse, setIsDoghouse] = useState(false);
  const [doghousePendingFighter, setDoghousePendingFighter] = useState<Fighter | null>(null);
  const [careerOpponentId, setCareerOpponentId] = useState<number | null>(null);
  const [simulationNews, setSimulationNews] = useState<string[]>([]);
  const [pendingTrainingAlloc, setPendingTrainingAlloc] = useState<{
    points: number;
    allowedStats: (keyof SkillPoints)[];
    didSimulate: boolean;
    isManualSimulate?: boolean;
    simulationNews?: string[];
    showAllSkillsBanner?: boolean;
    /**
     * Set when these points came from a WL/Heavy Bag workout. That workout's
     * item boosts are not spent until these points are actually distributed.
     */
    trainingSource?: "weightLifting" | "heavyBag";
  } | null>(null);
  const [allocShowsRefinement, setAllocShowsRefinement] = useState(false);
  const [statUnlockPending, setStatUnlockPending] = useState<{
    allocData: { points: number; allowedStats: (keyof SkillPoints)[]; didSimulate: boolean; simulationNews?: string[] } | null;
    tbToSave: TrainingBonuses;
    fighterId: number;
    didSimulate: boolean;
    updatedRosterState: CareerRosterState | null;
    trainingSource?: "weightLifting" | "heavyBag";
  } | null>(null);
  const deferredMilestoneRef = useRef<{
    allocData: { points: number; allowedStats: (keyof SkillPoints)[]; didSimulate: boolean; simulationNews?: string[] } | null;
    tbToSave: TrainingBonuses;
    fighterId: number;
    didSimulate: boolean;
    updatedRosterState: CareerRosterState | null;
    trainingSource?: "weightLifting" | "heavyBag";
  } | null>(null);
  // `kind: "reward"` entries reuse the milestone popup but are NOT achievements —
  // they show their own header and a plain rewards line (e.g. Training Sweep).
  const [pendingMilestones, setPendingMilestones] = useState<Array<{ title: string; description: string; icon: string; kind?: "reward" }>>([]);
  const deferredFightMilestonesRef = useRef<Array<{ title: string; description: string; icon: string; kind?: "reward" }> | null>(null);
  const [tutorialStage, setTutorialStage] = useState(0);
  const [isTutorialFight, setIsTutorialFight] = useState(false);
  const [tutorialCompletedStages, setTutorialCompletedStages] = useState<number[]>(() => {
    try { const s = localStorage.getItem("handz_tutorial_completed_stages"); return s ? JSON.parse(s) : []; } catch { return []; }
  });
  const [isCareerTutorial, setIsCareerTutorial] = useState(false);
  const careerTutorialInfoRef = useRef<{ name: string; colors: FighterColors } | null>(null);
  const nightmareResultRef = useRef<{ exp: number; kos: number; timeSurvived: number } | null>(null);
  const deferredSparSimNewsRef = useRef<string[] | null>(null);
  const champDefeatSimNewsRef = useRef<string[] | null>(null);
  const lastForceEarnedRef = useRef(0);
  const lastDiamondsEarnedRef = useRef(0);
  // Crates won from the fight just finished — handed to the reveal overlay by
  // handleContinue (reward blocks never route screens themselves). A band can
  // award up to 99 chests, so these are revealed one after another.
  const pendingCratesRef = useRef<{ crateId: CrateId; itemIds: string[] }[] | null>(null);
  const [crateReveal, setCrateReveal] = useState<
    { queue: { crateId: CrateId; itemIds: string[] }[]; index: number; label?: string; quickOpenTitle?: string } | null
  >(null);
  const [ringWalkData, setRingWalkData] = useState<{
    playerName: string;
    enemyName: string;
    playerColors: FighterColors;
    enemyColors: FighterColors;
    playerLevel: number;
    playerWins: number;
    playerLosses: number;
    playerDraws: number;
    playerKOs: number;
    playerSp?: { power: number; speed: number; defense: number; stamina: number; focus: number };
    playerRefinement?: Record<string, number>;
    enemyLevel: number;
    enemyWins: number;
    enemyLosses: number;
    enemyDraws: number;
    enemyKOs: number;
    enemySp?: { power: number; speed: number; defense: number; stamina: number; focus: number };
    enemyRefinement?: Record<string, number>;
    enemyRank?: number;
    playerRank?: number;
    playerNickname?: string;
  } | null>(null);
  const [ceremonyData, setCeremonyData] = useState<{
    isWin: boolean;
    isDraw: boolean;
    playerName: string;
    enemyName: string;
    playerColors: FighterColors;
    enemyColors: FighterColors;
    ringCanvasColor: string;
  } | null>(null);

  useEffect(() => {
    localStorage.setItem("quickFightSettings", JSON.stringify({
      playerLevel: quickFightPlayerLevel,
      enemyLevel: quickFightEnemyLevel,
      difficulty: aiDifficulty,
      roundDuration: roundDurationMins,
      timerSpeed,
      maxRounds,
      playerArm: playerArmLength,
      enemyArm: enemyArmLength,
      towelStoppage: towelStoppageEnabled,
      practiceMode,
      recordInputs,
      cpuVsCpu,
      aiPowerMult,
      aiSpeedMult,
      aiStaminaMult,
      nightmare: quickFightNightmare,
    }));
  }, [quickFightPlayerLevel, quickFightEnemyLevel, aiDifficulty, roundDurationMins, timerSpeed, maxRounds, playerArmLength, enemyArmLength, towelStoppageEnabled, practiceMode, recordInputs, cpuVsCpu, aiPowerMult, aiSpeedMult, aiStaminaMult, quickFightNightmare]);

  const [fighters, setFighters] = useState<Fighter[]>([]);
  const [careerStartInCreate, setCareerStartInCreate] = useState(false);
  const [fightersLoading] = useState(false);

  useEffect(() => {
    // A bout left open by closing the tab never concluded — give its armed
    // boosts back before anything reads the inventory.
    restoreFightBoostEscrow();
    const loaded = localSaves.getFighters();
    setFighters(loaded);
    // A signed-in account with no career goes straight to the career creator.
    if (autoCreateCareer && loaded.length === 0) {
      setCareerStartInCreate(true);
      setUiMode("career");
    }
  }, []);

  // Real-time nightmare XP bar: recompute fightLiveXp on each new KO
  useEffect(() => {
    if (!isNightmare || !activeFighter || !gameState.showExpBar) return;
    const kos = gameState.nightmareKillCount ?? 0;
    const timeSurvived = gameState.nightmareTimeSurvived ?? 0;
    const nmKoMult = Math.pow(1.05, kos);
    const nmLevelMult = 1 + 0.001 * (gameState.nightmareLevel ?? 1);
    const nmXpCfg = loadXpConfig();
    const nmBoutMult = Math.pow(nmXpCfg.boutBase, activeFighter.careerBoutIndex || 0);
    const nmSparWinMult = Math.pow(nmXpCfg.sparWinBase, activeFighter.wins || 0);
    const liveXpEarned = Math.floor(
      (kos * 150 + timeSurvived * 3) * nmKoMult * nmLevelMult *
      (gameState.careerXpMult || nmXpCfg.careerMult) * 6 * nmBoutMult * nmSparWinMult * 0.35
    );
    patchLiveState(prev => ({ ...prev, fightLiveXp: (activeFighter.xp ?? 0) + liveXpEarned }));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gameState.nightmareKillCount, isNightmare]);

  const pendingAllocApplied = useRef(false);

  useEffect(() => {
    if (!activeFighter) return;
    patchLiveState(prev => {
      if (prev.playerCurrentXp === activeFighter.xp && prev.playerLevel === activeFighter.level) return prev;
      return { ...prev, playerCurrentXp: activeFighter.xp, playerLevel: activeFighter.level, fightLiveXp: activeFighter.xp };
    });
  }, [activeFighter?.xp, activeFighter?.level]);

  useEffect(() => {
    setTrainingLiveXp(0);
  }, [trainingType]);

  // Close the punch editor overlay whenever the game leaves the paused state
  useEffect(() => {
    if (!gameState.isPaused && showPausePunchEditor) {
      setShowPausePunchEditor(false);
    }
  }, [gameState.isPaused, showPausePunchEditor]);

  const refreshFighters = useCallback(() => {
    setFighters(localSaves.getFighters());
  }, []);

  // One-time locker recovery for saves whose items were rolled back by a stale
  // write: every keepsake and permanent item is rebuilt from the lifetime
  // record. Runs once per save and is a no-op for saves that never lost
  // anything.
  useEffect(() => {
    for (const f of localSaves.getFighters()) {
      // An item pulled from the game leaves copies — and possibly an armed
      // boost — in every save that owned one. Clear them first, so the two
      // rebuild passes below have nothing left to restore.
      purgeRetiredItems(f.id);
      recoverLockerFromLifetime(f.id);
      // ...a fold-in for keepsakes a save is holding the old way, from before
      // the item was one (several copies, or its only copy armed)...
      normalizeKeepsakeHoldings(f.id);
      // ...and a standing repair for anything that goes missing later: the
      // spend ledger puts back every copy that left without being sold or used.
      healLockerFromLedger(f.id);
    }
    refreshFighters();
  }, [refreshFighters]);

  const createFighterMutation = {
    mutate: (data: Record<string, unknown>, opts?: { onSuccess?: (res: any) => void }) => {
      const fighter = localSaves.createFighter(data as any);
      refreshFighters();
      opts?.onSuccess?.({ json: () => Promise.resolve(fighter) });
    },
    mutateAsync: async (data: Record<string, unknown>) => {
      const fighter = localSaves.createFighter(data as any);
      refreshFighters();
      return { json: () => Promise.resolve(fighter) };
    },
    isPending: false,
  };

  const deleteFighterMutation = {
    mutate: (id: string) => {
      localSaves.deleteFighter(id);
      // Wipe persisted per-fighter generated numbers (refinements/skill points)
      // so the next career is generated purely from the Roster Generation config.
      clearRosterCustomizationNumbers();
      refreshFighters();
    },
    isPending: false,
  };

  const updateFighterMutation = {
    mutate: ({ id, data }: { id: string; data: Record<string, unknown> }) => {
      localSaves.updateFighter(id, data as any);
      refreshFighters();
    },
    isPending: false,
  };

  /**
   * Fee owed by the paid sparring session in progress. Nothing is taken until
   * the session pays out, so a crash, a reload or a quit mid-session costs
   * nothing — the debt lives only here, and dies with the page.
   */
  const pendingSparringFeeRef = useRef<{ mode: SparringMode; fighterId: string } | null>(null);

  /**
   * Entry check for a paid sparring mode: the player must be able to cover the
   * fee, but is not charged for it yet.
   *
   * Balances come from the save rather than the fighter in hand — the Locker
   * and the gym both write straight to storage, so an in-memory snapshot can be
   * stale enough to wave through money the player no longer has.
   */
  const beginSparringSession = (fighter: Fighter, mode: SparringMode): boolean => {
    const cost = SPARRING_MODE_COSTS[mode];
    const fresh = localSaves.getFighter(fighter.id) ?? fighter;
    if ((fresh.force ?? 0) < cost.sessionForce || (fresh.shards ?? 0) < cost.sessionShards) return false;
    pendingSparringFeeRef.current = { mode, fighterId: fighter.id };
    return true;
  };

  /**
   * Take the session fee as the rewards land. Runs at every payout point and
   * clears the debt first, so a session can only ever be charged once.
   */
  const settleSparringSessionFee = () => {
    const pending = pendingSparringFeeRef.current;
    if (!pending) return;
    pendingSparringFeeRef.current = null;
    const cost = SPARRING_MODE_COSTS[pending.mode];
    const fresh = localSaves.getFighter(pending.fighterId);
    if (!fresh) return;
    const force = Math.max(0, (fresh.force ?? 0) - cost.sessionForce);
    const shards = Math.max(0, (fresh.shards ?? 0) - cost.sessionShards);
    updateFighterMutation.mutate({ id: pending.fighterId, data: { force, shards } });
    setActiveFighter(prev => prev && prev.id === pending.fighterId ? { ...prev, force, shards } : prev);
  };

  const saveFightResultMutation = {
    mutate: (data: Record<string, unknown>) => {
      localSaves.createFightResult(data as any);
    },
    isPending: false,
  };

  const STAT_CAP = 1000;
  const normalizeSkillPoints = (raw: unknown): SkillPoints => {
    const r = (raw || {}) as Partial<SkillPoints>;
    return {
      power: Math.max(0, Math.min(STAT_CAP, Math.floor(r.power || 0))),
      speed: Math.max(0, Math.min(STAT_CAP, Math.floor(r.speed || 0))),
      defense: Math.max(0, Math.min(STAT_CAP, Math.floor(r.defense || 0))),
      stamina: Math.max(0, Math.min(STAT_CAP, Math.floor(r.stamina || 0))),
      focus: Math.max(0, Math.min(STAT_CAP, Math.floor(r.focus || 0))),
    };
  };

  const runStatPointCheck = (fighter: Fighter) => {
    const sp = normalizeSkillPoints(fighter.skillPoints);
    const avail = Math.max(0, fighter.availableStatPoints || 0);
    const raw = (fighter.skillPoints || {}) as Partial<SkillPoints>;
    const needsFix =
      sp.power !== (raw.power ?? 0) ||
      sp.speed !== (raw.speed ?? 0) ||
      sp.defense !== (raw.defense ?? 0) ||
      sp.stamina !== (raw.stamina ?? 0) ||
      sp.focus !== (raw.focus ?? 0) ||
      avail !== (fighter.availableStatPoints || 0);
    if (needsFix) {
      console.log("[StatCheck] Fixed skill point integrity:", sp, "avail:", avail);
      updateFighterMutation.mutate({
        id: fighter.id,
        data: { skillPoints: sp, availableStatPoints: avail },
      });
      setActiveFighter(prev => prev ? { ...prev, skillPoints: sp, availableStatPoints: avail } : null);
    }
  };

  const startTutorialFight = useCallback((stage: number, playerName?: string, playerColors?: FighterColors) => {
    resetAutoZoom();
    setIsTutorialFight(true);
    setTutorialStage(stage);
    setIsCareerFight(false);
    setIsSparring(false);
    const name = playerName || careerTutorialInfoRef.current?.name || "Player";
    const colors = playerColors || careerTutorialInfoRef.current?.colors || { ...DEFAULT_PLAYER_COLORS };
    const tutorialLevel = stage === 3 ? 100 : 10;
    const newState = startFight(
      createInitialState(),
      "BoxerPuncher",
      tutorialLevel,
      tutorialLevel,
      name,
      colors,
      true,
      "journeyman",
      3,
      180,
      "normal",
      65,
      65,
      "BoxerPuncher",
      "Tutorial Opponent",
      undefined,
      false,
      false,
      false,
      false,
      false,
      undefined,
      false,
      undefined,
      1,
      1,
      1,
    );
    newState.tutorialMode = true;
    newState.tutorialStage = stage;
    newState.tutorialStep = 1;
    newState.tutorialAiIdle = true;
    newState.tutorialCareerMode = isCareerTutorial;
    newState.tutorialTracking = {
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
      rhythmChangeCount: 0,
      chargeUsed: false,
      rhythmHits: 0,
      perfectBlockCount: 0,
      feintCount: 0,
      punchFeintCount: 0,
      bodyShotCount: 0,
      slipsDodged: 0,
      heldPunchCount: 0,
      resetDone: false,
      finishLanded: false,
    };
    if (stage === 1) {
      newState.enemy.stamina = Math.round(newState.enemy.stamina / 4);
      newState.enemy.maxStamina = Math.round(newState.enemy.maxStamina / 4);
      newState.enemy.maxStaminaCap = Math.round(newState.enemy.maxStaminaCap / 4);
    } else if (stage === 2) {
      newState.enemy.stamina = Math.round(newState.enemy.stamina / 3);
      newState.enemy.maxStamina = Math.round(newState.enemy.maxStamina / 3);
      newState.enemy.maxStaminaCap = Math.round(newState.enemy.maxStaminaCap / 3);
    } else if (stage === 3) {
      newState.enemy.stamina = Math.round(newState.enemy.stamina / 3);
      newState.enemy.maxStamina = Math.round(newState.enemy.maxStamina / 3);
      newState.enemy.maxStaminaCap = Math.round(newState.enemy.maxStaminaCap / 3);
      newState.enemy.rhythmLevel = 1;
      newState.enemy.rhythmProgress = 0.5;
      newState.player.focusT = 1.0;
    }
    commitGameState(newState);
    setUiMode("fighting");
  }, [isCareerTutorial]);

  const handleStateChange = useCallback((newState: GameState) => {
    if (newState.pauseAction === "restart") {
      if (isTutorialFight) {
        startTutorialFight(tutorialStage);
        return;
      }
      if (newState.nightmareMode) {
        resetAutoZoom();
        const nmArchetypes: Archetype[] = ["BoxerPuncher", "OutBoxer", "Brawler", "Swarmer"];
        const firstArch = nmArchetypes[Math.floor(Math.random() * nmArchetypes.length)];
        const firstArm = Math.round(58 + Math.random() * 17);
        // A restart is a fresh run at the same ladder: both corners keep the
        // refinement they walked in with, and the opponent re-rolls its spread
        // off the first rung again.
        const nmRestartBudget = newState.nightmareRefinementBudget ?? 0;
        // Same rule as entry: as many keys as the player is bringing.
        const nmRestartKeys = playerActiveRefinementCount(newState.playerRefinement as SkillRefinement | undefined);
        const nmRestartRef: EnemyRefinement | undefined = nmRestartBudget > 0 && nmRestartKeys > 0
          ? { offenseUnlocked: true, defenseUnlocked: true, fightIqUnlocked: true, ...spreadRefinementPoints(nmRestartBudget, nmRestartKeys) } as EnemyRefinement
          : undefined;
        const nmRestart = startFight(
          createInitialState(),
          newState.player.archetype,
          newState.playerLevel,
          newState.enemyLevel,
          newState.player.name,
          newState.player.colors,
          newState.isQuickFight,
          newState.aiDifficulty,
          1,
          newState.roundDuration,
          newState.timerSpeed,
          newState.player.armLength,
          firstArm,
          firstArch,
          undefined,
          undefined,
          false,
          false,
          false,
          false,
          false,
          undefined,
          true,
          undefined,
          newState.isQuickFight ? aiPowerMult : 1,
          newState.isQuickFight ? aiSpeedMult : 1,
          newState.isQuickFight ? aiStaminaMult : 1,
          undefined,
          undefined,
          false,
          undefined,
          newState.playerRefinement,
          nmRestartRef,
          true
        );
        if (newState.playerRefinement) nmRestart.playerRefinement = { ...newState.playerRefinement };
        nmRestart.careerEnemyRefinement = (nmRestartRef ? { ...nmRestartRef } : {}) as Record<string, number>;
        nmRestart.careerXpMult = newState.careerXpMult;
        nmRestart.canSurpassLevel100 = newState.canSurpassLevel100;
        activateNightmareMode(nmRestart, Math.max(1, newState.playerLevel - 15), newState.aiDifficulty, newState.nightmareRefinementBudget ?? 0, newState.nightmareRefinementPlayerTotal ?? 0);
        // Same run again: both corners keep the equipment they walked in with.
        // After activation, which rescales the opening enemy's stamina pool —
        // every replacement rung is equipped after its own scaling too, so the
        // trunks have to land on the same side of it for the first one.
        applyFightEquipment(nmRestart, { player: newState.playerEquipment, opponent: newState.opponentEquipment });
        // The run is thrown away, the reps grooved in it are not.
        carryDrilledActions(newState, nmRestart);
        // After activation, which owns the themed floor — same order as entry.
        nmRestart.ringColors = newState.ringColors;
        nmRestart.gymRingName = newState.gymRingName;
        commitGameState(nmRestart);
        return;
      }
      resetAutoZoom();
      const restartState = startFight(
        createInitialState(),
        newState.player.archetype,
        newState.playerLevel,
        newState.enemyLevel,
        newState.player.name,
        newState.player.colors,
        newState.isQuickFight,
        newState.aiDifficulty,
        newState.totalRounds,
        newState.roundDuration,
        newState.timerSpeed,
        newState.player.armLength,
        newState.enemy.armLength,
        newState.enemy.archetype,
        newState.enemyName,
        undefined,
        false,
        newState.towelStoppageEnabled,
        newState.practiceMode,
        newState.recordInputs,
        newState.cpuVsCpu,
        undefined,
        false,
        undefined,
        newState.isQuickFight ? aiPowerMult : 1,
        newState.isQuickFight ? aiSpeedMult : 1,
        newState.isQuickFight ? aiStaminaMult : 1,
        undefined,
        newState.careerEnemySkillPoints,
        undefined,
        undefined,
        newState.playerRefinement
      );
      restartState.ringColors = newState.ringColors;
      restartState.gymRingName = newState.gymRingName;
      if (newState.careerEnemySkillPoints) {
        restartState.careerEnemySkillPoints = newState.careerEnemySkillPoints;
      }
      if (newState.playerRefinement) {
        restartState.playerRefinement = newState.playerRefinement;
      }
      if (newState.careerEnemyRefinement) {
        restartState.careerEnemyRefinement = newState.careerEnemyRefinement;
      }
      // startFight builds a bare state, so a restart has to re-apply the item
      // boosts both corners walked in with — otherwise the bout resumes with
      // the gear stripped off. The opponent keeps the kit it was rolled, since
      // this is the same bout being run back.
      if (activeFighter && !newState.isQuickFight && !newState.practiceMode) {
        applyItemFightMods(
          restartState,
          getFightMods(withSavedInventory(activeFighter), activeFighter.careerRosterState as CareerRosterState | null, { sparring: !!newState.sparringMode }),
        );
      }
      if (newState.opponentItems && Object.keys(newState.opponentItems).length > 0) {
        restartState.opponentItems = newState.opponentItems;
        applyItemFightMods(restartState, fightModsFromBoosts(boostsFromItemCounts(newState.opponentItems)), "opponent");
      }
      // Same bout run back, so the drilled list (and whatever this session has
      // already added to it) comes with it.
      carryDrilledActions(newState, restartState);
      // Same bout run back: both corners keep the Punch Endurance they walked in
      // with, and the per-bout drain starts over with the rebuilt fighters.
      applyPunchEndurance(restartState, {
        player: newState.player.punchEndurance,
        enemy: newState.enemy.punchEndurance,
        playerLoss: newState.player.punchEnduranceLoss,
        enemyLoss: newState.enemy.punchEnduranceLoss,
      });
      // Same bout run back: the player keeps their trained auto slip chance.
      restartState.player.autoSlipTrainedBonus = newState.player.autoSlipTrainedBonus;
      if (activeFighter && !newState.isQuickFight) {
        applyPurePower(restartState, localSaves.getFighter(activeFighter.id)?.careerRosterState as CareerRosterState | null);
      }
      // Same bout run back: both corners keep the equipment they walked in with.
      applyFightEquipment(restartState, { player: newState.playerEquipment, opponent: newState.opponentEquipment });
      commitGameState(restartState);
      return;
    }
    if (newState.pauseAction === "quit") {
      soundEngine.stopCrowdAmbient();
      // Walking out is not a finish: the paid session goes uncharged.
      pendingSparringFeeRef.current = null;
      commitGameState(createInitialState());
      // Quitting is not a conclusion: every boost armed for this bout goes back
      // to the save untouched (career bout and all sparring modes alike).
      restoreFightBoostEscrow();
      if (isTutorialFight) {
        setIsTutorialFight(false);
        if (isCareerTutorial) {
          setIsCareerTutorial(false);
          careerTutorialInfoRef.current = null;
          setUiMode("career");
        } else {
          setUiMode("tutorial");
        }
        return;
      }
      // Nightmare is a career activity like any other: it is entered from the
      // sparring menu and has to return there. It tracks itself with its own
      // flag instead of isSparring, so it must be named here explicitly or it
      // falls through to the home screen.
      const isCareerActivity = isCareerFight || isSparring || isNightmare;
      const goBack = isCareerActivity ? "career" : "menu";
      // Take the persisted inventory rather than this snapshot's. The restore
      // above just wrote to the save, and anything the Locker armed was never in
      // this snapshot to begin with. Unconditional on purpose: "nothing to
      // re-arm" is the ordinary quit — the boosts were never burned — and that
      // is precisely the case where the stale snapshot showed the hub an empty
      // boost row and made the player think the item had been spent.
      setActiveFighter(prev => prev ? withSavedInventory(prev) : prev);
      if (isCareerActivity && preFightSnapshot) {
        // Quitting rewinds the fight's own progress by writing the whole
        // pre-fight roster blob back. Purchases are not fight progress: a mode
        // bought with Force just before entering must not be un-bought by
        // bailing out, so those flags are carried over from the live save.
        const snapRs = preFightSnapshot.careerRosterState as CareerRosterState | null;
        const liveRs = localSaves.getFighter(preFightSnapshot.id)?.careerRosterState as CareerRosterState | null;
        const restoredRs: CareerRosterState | null = snapRs
          ? {
              ...snapRs,
              doghouseUnlocked: snapRs.doghouseUnlocked || liveRs?.doghouseUnlocked || false,
              nightmareUnlocked: snapRs.nightmareUnlocked || liveRs?.nightmareUnlocked || false,
            }
          : snapRs;
        const restoredFighter: Fighter = { ...preFightSnapshot, careerRosterState: restoredRs };
        setActiveFighter(withSavedInventory(restoredFighter));
        updateFighterMutation.mutate({
          id: preFightSnapshot.id,
          data: {
            xp: preFightSnapshot.xp,
            level: preFightSnapshot.level,
            skillPoints: preFightSnapshot.skillPoints,
            careerStats: preFightSnapshot.careerStats,
            trainingBonuses: preFightSnapshot.trainingBonuses,
            careerRosterState: restoredRs,
          },
        });
        setPreFightSnapshot(null);
      }
      // Every mode flag has to be dropped here, not just isSparring. A flag
      // left standing re-runs that mode's payout block when the *next* bout
      // ends, and those blocks persist a roster blob rebuilt from React state
      // captured before the quit — which silently reverts anything bought in
      // between, the paid unlock flags included.
      setIsSparring(false);
      setIsNightmare(false);
      setIsDoghouse(false);
      setIsCareerFight(false);
      setTrainingType(null);
      setUiMode(goBack);
      return;
    }

    commitGameState(newState);
    if (newState.phase === "fightEnd" && uiMode === "fighting") {
      soundEngine.stopCrowdAmbient();
      // The bout reached a result — the boosts it burns below stay burned.
      closeFightBoostEscrow();
      if (isTutorialFight || isNightmare || isSparring) {
        setUiMode("fightEnd");
      } else {
        setCeremonyData({
          isWin: newState.fightWinner === "player",
          isDraw: newState.fightResult === "Draw",
          playerName: newState.player.name || "PLAYER",
          enemyName: newState.enemy.name || "OPPONENT",
          playerColors: newState.player.colors,
          enemyColors: newState.enemy.colors,
          ringCanvasColor: newState.ringCanvasColor || "#3d2f1e",
        });
        setUiMode("resultsCeremony");
      }
      if (isNightmare) {
        const kos = newState.nightmareKillCount;
        const timeSurvived = Math.floor(newState.nightmareTimeSurvived);
        const nmKoMult = Math.pow(1.05, kos);
        const nmLevelMult = 1 + 0.001 * (newState.nightmareLevel ?? 1);

        // Level-gap penalty: if camp opponent is 5+ levels below player, reduce rewards
        const nmGapRs = activeFighter ? (activeFighter.careerRosterState as CareerRosterState | null) : null;
        const nmGapOpp = nmGapRs?.selectedOpponentId != null ? nmGapRs.roster.find(f => f.id === nmGapRs.selectedOpponentId) : null;
        const nmOppLevel = nmGapOpp?.level ?? (activeFighter?.level ?? 0);
        const nmGap = activeFighter ? Math.max(0, activeFighter.level - nmOppLevel) : 0;
        const nmXpGapMult = nmGap >= 5 ? Math.max(0.04, 1 - 0.02 * nmGap) : 1;

        const nmXpCfg = loadXpConfig();
        const nmBoutMult = activeFighter ? Math.pow(nmXpCfg.boutBase, activeFighter.careerBoutIndex || 0) : 1;
        const nmSparWinMult = activeFighter ? Math.pow(nmXpCfg.sparWinBase, activeFighter.wins || 0) : 1;
        const nmXpRaw = Math.floor((kos * 150 + timeSurvived * 3) * nmKoMult * nmLevelMult * (newState.careerXpMult || nmXpCfg.careerMult) * 6 * nmBoutMult * nmSparWinMult * 0.35);
        // Nightmare burns the next-sparring boosts it used, so it pays them:
        // Headgear Strap and the permanents, plus a live Training Frenzy.
        const nmItemXpMult = activeFighter ? getGymSparringXpMult(withSavedInventory(activeFighter), nmGapRs) : 1;
        const nmXpGained = Math.max(1, Math.floor(nmXpRaw * nmXpGapMult * nmItemXpMult));

        if (activeFighter) {
          // Nightmare pays in XP and crates only — no stat or refinement points.
          const nmMidFightLevel = newState.midFightLevelUps > 0 ? newState.playerLevel : activeFighter.level;
          const nmMidFightXp = newState.midFightLevelUps > 0 ? newState.playerCurrentXp : activeFighter.xp;
          let nmNewXp = nmMidFightXp + nmXpGained;
          let nmNewLevel = nmMidFightLevel;
          while (nmNewXp >= xpToNextLevel(nmNewLevel) && nmNewLevel < 1000) {
            nmNewXp -= xpToNextLevel(nmNewLevel);
            nmNewLevel++;
          }
          if (nmNewLevel >= 1000) {
            nmNewLevel = 1000;
            nmNewXp = Math.min(nmNewXp, xpToNextLevel(1000) - 1);
          }

          const nmOldStats = (activeFighter.careerStats || DEFAULT_CAREER_STATS) as CareerStats;
          const nmNewCareerStats: CareerStats = {
            ...nmOldStats,
            lifetimeXp: nmOldStats.lifetimeXp + nmXpGained,
          };

          let nmRosterState = withSavedPatternLibrary(activeFighter.id, activeFighter.careerRosterState as CareerRosterState | null);
          // Nightmare is gym work, so anything grooved in it counts — and it has
          // to be folded in ahead of the weekly simulation below, which is what
          // turns the rehearsal week over.
          nmRosterState = withGymWorkFromBout(nmRosterState, newState);
          if (nmRosterState) {
            const nmWeekSeed = Date.now();
            const nmInCamp = nmRosterState.selectedOpponentId != null && (nmRosterState.prepWeeksRemaining ?? 0) > 0;
            // A Nightmare run counts as a sparring session however it ended —
            // that is what restarts the rust clock. The snap time it buys is
            // paid by the body instead: nothing for a run that killed nobody.
            const nmSnapSessions = sparSessionsForSeconds(RESET_SPEED_PER_NIGHTMARE_WIN * kos);
            nmRosterState = simulateWeek(stampSparWeek(activeFighter.id, nmRosterState, nmSnapSessions), nmWeekSeed, activeFighter.careerDifficulty, nmNewLevel, false, refinementTotal(activeFighter.skillRefinement as Record<string, number> | null), getEquipmentLevels(activeFighter));
            nmRosterState = { ...nmRosterState, trainingsSinceLastWeek: 0 };
            const nmPRating = nmRosterState.playerRatingScore ?? 1000;
            const nmNewRank = nmInCamp
              ? (nmRosterState.playerRank ?? 701)
              : Math.max(computePlayerRankFromRating(nmRosterState.roster, nmPRating, nmRosterState.rank1HolderId), nmRosterState.playerRank ?? 701);
            nmRosterState = { ...nmRosterState, playerRank: nmNewRank };
            // Conditioning from the run: one point per whole 15 kills, leftovers
            // dropped — they don't carry into the next run.
            nmRosterState = grantPunchEndurance(
              activeFighter.id,
              nmRosterState,
              Math.floor(kos / NIGHTMARE_KILLS_PER_PUNCH_ENDURANCE),
            );
          }

          const nmDecayedSP = nmRosterState ? applyTrainingDecay(nmRosterState, (activeFighter.skillPoints || {}) as SkillPoints) : null;

          // Nightmare is a real bout and a sparring session — burn the
          // one-fight boosts it just used and the sparring ones (Headgear
          // Strap) it was paid for. The Import Ticket is the exception: the
          // run never brings in a roster fighter, so it stays armed.
          const nmSaved = withSavedInventory(activeFighter);
          let nmInventory =
            consumeBoostsFor(nmSaved, ["fight", "sparring"], nmRosterState, {
              sparring: true,
              skipPerks: ["importSparring"],
            }) ?? pruneBoosts(nmSaved, nmRosterState);

          // Survival chests: every KO milestone this run cleared pays out, and
          // each chest rolls against the inventory the previous one produced so
          // lifetime caps and one-per-save keepsakes hold across the haul.
          // handleContinue shows the reveals — this block never routes screens.
          pendingCratesRef.current = null;
          const nmCratesWon: { crateId: CrateId; itemIds: string[] }[] = [];
          for (const milestone of NIGHTMARE_CRATE_MILESTONES) {
            if (kos < milestone.kos) continue;
            const roll = rollCrateForFighter(
              nmInventory ? { ...nmSaved, itemInventory: nmInventory } : nmSaved,
              milestone.crate,
              nmRosterState?.playerRank ?? null,
              false,
              "training",
            );
            if (roll.inventory && roll.itemIds.length > 0) {
              nmCratesWon.push({ crateId: milestone.crate, itemIds: roll.itemIds });
              nmInventory = roll.inventory;
            }
          }

          updateFighterMutation.mutate({
            id: activeFighter.id,
            data: {
              xp: nmNewXp,
              level: nmNewLevel,
              careerStats: nmNewCareerStats,
              itemInventory: nmInventory,
              ...(nmRosterState ? { careerRosterState: nmRosterState } : {}),
              ...(nmDecayedSP ? { skillPoints: nmDecayedSP } : {}),
            },
          });
          setActiveFighter(prev => prev ? {
            ...prev,
            xp: nmNewXp,
            level: nmNewLevel,
            careerStats: nmNewCareerStats,
            itemInventory: nmInventory,
            ...(nmRosterState ? { careerRosterState: nmRosterState } : {}),
            ...(nmDecayedSP ? { skillPoints: nmDecayedSP } : {}),
          } : null);

          // The run paid out, so now the session fee comes due.
          settleSparringSessionFee();

          // Reveal only what actually committed with the run above.
          if (nmCratesWon.length > 0) pendingCratesRef.current = nmCratesWon;

        }
        nightmareResultRef.current = { exp: nmXpGained, kos, timeSurvived };
      } else if (isDoghouse && activeFighter) {
        const dhWon = newState.fightWinner === "player";
        const dhOpponentsDefeated = newState.doghouseOpponentsDefeated ?? 0;

        // Level-gap penalty: camp opponent 5+ levels below player → reduced rewards
        const dhGapRs = activeFighter.careerRosterState as CareerRosterState | null;
        const dhGapOpp = dhGapRs?.selectedOpponentId != null ? dhGapRs.roster.find(f => f.id === dhGapRs.selectedOpponentId) : null;
        const dhOppLevel = dhGapOpp?.level ?? activeFighter.level;
        const dhGap = Math.max(0, activeFighter.level - dhOppLevel);
        const dhXpGapMult = dhGap >= 5 ? Math.max(0.05, 1 - 0.01 * dhGap) : 1;

        // The Doghouse pays in XP and crates only — no stat points.

        const dhOldStats = (activeFighter.careerStats || DEFAULT_CAREER_STATS) as CareerStats;
        const sparringBase = 400 * (activeFighter.level / 100) * 0.5 * 20 * 4 * 0.7;
        const dhWinMult = dhWon ? 1.0 : 0.4;
        const dhXpCfg = loadXpConfig();
        const dhBoutMult = Math.pow(dhXpCfg.boutBase, activeFighter.careerBoutIndex || 0);
        const dhSparWinMult = Math.pow(dhXpCfg.sparWinBase, activeFighter.wins || 0);
        // Same sparring boosts a gym session pays — the round burns them too.
        const dhItemXpMult = getGymSparringXpMult(withSavedInventory(activeFighter), dhGapRs);
        const dhXpGained = Math.max(1, Math.floor(sparringBase * 1.75 * dhWinMult * 0.32 * Math.pow(1.2, dhOpponentsDefeated) * dhXpGapMult * dhBoutMult * dhSparWinMult * dhItemXpMult));
        const dhNewCareerStats: CareerStats = {
          ...dhOldStats,
          totalKnockdownsGiven: dhOldStats.totalKnockdownsGiven + (newState.player.knockdownsGiven ?? 0),
          lifetimeXp: dhOldStats.lifetimeXp + dhXpGained,
        };

        const dhMidFightLevel = newState.midFightLevelUps > 0 ? newState.playerLevel : activeFighter.level;
        const dhMidFightXp = newState.midFightLevelUps > 0 ? newState.playerCurrentXp : activeFighter.xp;
        let dhNewXp = dhMidFightXp + dhXpGained;
        let dhNewLevel = dhMidFightLevel;
        const dhRs = withSavedPatternLibrary(activeFighter.id, activeFighter.careerRosterState as CareerRosterState | null);
        while (dhNewXp >= xpToNextLevel(dhNewLevel) && dhNewLevel < 1000) {
          dhNewXp -= xpToNextLevel(dhNewLevel);
          dhNewLevel++;
        }
        if (dhNewLevel >= 1000) {
          dhNewLevel = 1000;
          dhNewXp = Math.min(dhNewXp, xpToNextLevel(1000) - 1);
        }

        runStatPointCheck(activeFighter);

        let dhUpdatedRosterState = dhRs;
        // Ahead of the weekly simulation, for the reason spelled out in the
        // sparring handler: the sim is what turns the rehearsal week over.
        dhUpdatedRosterState = withGymWorkFromBout(dhUpdatedRosterState, newState);
        // Snap time bought by this round, paid per opponent put away. Taken once
        // here because both arms of the week branch below stamp the session.
        const dhSnapSessions = sparSessionsForSeconds(RESET_SPEED_PER_DOGHOUSE_WIN * dhOpponentsDefeated);
        let dhDecayedSP: SkillPoints | null = null;
        if (dhUpdatedRosterState) {
          const dhPrevTrainings = dhUpdatedRosterState.trainingsSinceLastWeek ?? 0;
          if (dhPrevTrainings >= 1) {
            const dhWeekSeed = Date.now();
            const dhInCamp = dhUpdatedRosterState.selectedOpponentId != null && (dhUpdatedRosterState.prepWeeksRemaining ?? 0) > 0;
            // A Doghouse Round counts as a sparring session, won or lost — the
            // rust clock restarts either way. The snap time it buys is paid by
            // the body: nothing for a round that put nobody away.
            dhUpdatedRosterState = simulateWeek(stampSparWeek(activeFighter.id, { ...dhUpdatedRosterState, weeklyBonus: null }, dhSnapSessions), dhWeekSeed, activeFighter.careerDifficulty, dhNewLevel, true, refinementTotal(activeFighter.skillRefinement as Record<string, number> | null), getEquipmentLevels(activeFighter));
            dhUpdatedRosterState = { ...dhUpdatedRosterState, trainingsSinceLastWeek: 0 };
            const dhPRating = dhUpdatedRosterState.playerRatingScore ?? 1000;
            const dhNewRank = dhInCamp
              ? (dhUpdatedRosterState.playerRank ?? 701)
              : Math.max(computePlayerRankFromRating(dhUpdatedRosterState.roster, dhPRating, dhUpdatedRosterState.rank1HolderId), dhUpdatedRosterState.playerRank ?? 701);
            const dhNewWeeklyBonus = generateWeeklyBonus(activeFighter.wins || 0, activeFighter.careerStats, dhUpdatedRosterState);
            dhUpdatedRosterState = { ...dhUpdatedRosterState, playerRank: dhNewRank, weeklyBonus: dhNewWeeklyBonus ?? null };
            dhDecayedSP = applyTrainingDecay(dhUpdatedRosterState, (activeFighter.skillPoints || {}) as SkillPoints);
          } else {
            const dhNextBonus = generateWeeklyBonus(activeFighter.wins || 0, activeFighter.careerStats, dhUpdatedRosterState);
            dhUpdatedRosterState = stampSparWeek(activeFighter.id, { ...dhUpdatedRosterState, trainingsSinceLastWeek: 1, weeklyBonus: dhNextBonus ?? null }, dhSnapSessions);
          }
          // Mark Doghouse as used for this opponent — opponent ID mismatch = available again next camp
          dhUpdatedRosterState = { ...dhUpdatedRosterState, lastDoghouseOpponentId: dhUpdatedRosterState.selectedOpponentId ?? null };
          // Conditioning: a point per opponent put away, win or lose. The early
          // finish handler pays the same run, so it only lands here if that one
          // did not already bank it.
          if (!doghouseEarlyFinishedRef.current) {
            dhUpdatedRosterState = grantPunchEndurance(activeFighter.id, dhUpdatedRosterState, dhOpponentsDefeated);
            dhUpdatedRosterState = bankSlipsLanded(
              dhUpdatedRosterState,
              localSaves.getFighter(activeFighter.id)?.careerRosterState as CareerRosterState | null,
              slipsLandedOf(newState),
            );
            // Perfect blocks are paid opponent by opponent, as each one falls.
            dhUpdatedRosterState = grantDefensiveMasteryBonus(
              dhUpdatedRosterState,
              localSaves.getFighter(activeFighter.id)?.careerRosterState as CareerRosterState | null,
              doghousePerfectBlocksBankedOf(newState) * MASTERY_PCT_PER_PERFECT_BLOCK_DOGHOUSE,
            );
            // Slip training pays only for a round that put someone away.
            if (dhOpponentsDefeated >= 1) {
              dhUpdatedRosterState = grantSlipTraining(
                dhUpdatedRosterState,
                localSaves.getFighter(activeFighter.id)?.careerRosterState as CareerRosterState | null,
                slipsLandedOf(newState) * SLIP_TRAINING_PCT_PER_SLIP_DOGHOUSE,
              );
            }
          }
        }

        // The Doghouse round is a real bout and a sparring session — burn the
        // one-fight boosts it used and the sparring ones (Headgear Strap) it
        // just paid out. The Import Ticket is the exception: the round never
        // brings in a roster fighter, so it stays armed for a real session.
        const dhSaved = withSavedInventory(activeFighter);
        let dhInventory =
          consumeBoostsFor(dhSaved, ["fight", "sparring"], dhUpdatedRosterState, {
            sparring: true,
            skipPerks: ["importSparring"],
          }) ?? pruneBoosts(dhSaved, dhUpdatedRosterState);

        // One chest per opponent put away. handleContinue shows the reveals.
        pendingCratesRef.current = null;
        const dhHaul = rollDoghouseChests(dhSaved, dhInventory, dhOpponentsDefeated, dhUpdatedRosterState?.playerRank ?? null);
        const dhCratesWon = dhHaul.crates;
        if (dhHaul.inventory) dhInventory = dhHaul.inventory;
        // 5 diamonds per opponent put away, on top of everything else. The
        // early finish handler pays the same run, so only one of them does.
        const dhDiamondsEarned = doghouseEarlyFinishedRef.current ? 0 : DOGHOUSE_DIAMONDS_PER_WIN * dhOpponentsDefeated;
        const dhNewDiamonds = (localSaves.getFighter(activeFighter.id)?.diamonds ?? activeFighter.diamonds ?? 0) + dhDiamondsEarned;

        updateFighterMutation.mutate({
          id: activeFighter.id,
          data: {
            xp: dhNewXp,
            level: dhNewLevel,
            careerStats: dhNewCareerStats,
            careerRosterState: dhUpdatedRosterState,
            itemInventory: dhInventory,
            ...(dhDecayedSP ? { skillPoints: dhDecayedSP } : {}),
            ...(dhDiamondsEarned > 0 ? { diamonds: dhNewDiamonds } : {}),
          },
        });
        setActiveFighter(prev => prev ? {
          ...prev,
          xp: dhNewXp,
          level: dhNewLevel,
          careerStats: dhNewCareerStats,
          careerRosterState: dhUpdatedRosterState,
          itemInventory: dhInventory,
          ...(dhDecayedSP ? { skillPoints: dhDecayedSP } : {}),
          ...(dhDiamondsEarned > 0 ? { diamonds: dhNewDiamonds } : {}),
        } : null);

        // The round paid out, so now the session fee comes due.
        settleSparringSessionFee();

        // Reveal only what actually committed with the round above.
        if (dhCratesWon.length > 0) pendingCratesRef.current = dhCratesWon;

        const dhPlaystyle = extractPlayerPlaystyle(newState);
        savePlayerPlaystyle(activeFighter.id, dhPlaystyle);

      } else if (isSparring && activeFighter) {
        const sparringWon = newState.fightWinner === "player";
        const thrown = newState.player.punchesThrown;
        const landed = newState.player.punchesLanded;
        const accuracy = thrown > 0 ? landed / thrown : 0;
        // A win at 60%+ accuracy pays the next tier's rewards (Champion → Undisputed).
        const sparRewardCfg = getSparringRewardConfig();
        const sparUpgraded = isSparringUpgrade(sparringWon, accuracy, sparRewardCfg);
        const sparRewardTier = sparringRewardTier(sparringDifficulty, sparringWon, accuracy, sparRewardCfg);
        const sparTierRewards = sparRewardCfg.tiers[sparRewardTier];
        const sparringBase = 400 * (activeFighter.level / 100) * 0.5 * 20 * 4 * 0.7;
        const sparringDiffMult = sparTierRewards.xpMult;
        const winMult = sparringWon ? 1.0 : 0.4;
        const xpGained = Math.max(1, Math.floor(sparringBase * sparringDiffMult * winMult * 0.32));

        let sparringAllocPoints = sparringWon ? sparTierRewards.winPoints : 1;

        let sparRefPts = 0;
        if (sparringWon) {
          if (accuracy >= 0.90) sparRefPts = 4;
          else if (accuracy > 0.80) sparRefPts = 2;
          else if (accuracy >= 0.75) sparRefPts = 1;
        }
        const oldSparRef = (activeFighter.skillRefinement || DEFAULT_SKILL_REFINEMENT) as SkillRefinement;

        if (accuracy > 0.6) sparringAllocPoints += 1;
        else if (accuracy > 0.4) sparringAllocPoints += 1;

        if (activeFighter.level >= 20 && accuracy > 0.6) {
          const sparTiers = Math.floor(activeFighter.level / 10) - 1;
          sparringAllocPoints += sparTiers * 2;
        }

        const sparIdleRs = activeFighter.careerRosterState as CareerRosterState | null;
        const sparChampBeaten = sparIdleRs ? isChampBeaten(sparIdleRs.roster) : false;
        const sparIdleWeeks = (sparIdleRs?.selectedOpponentId != null && (sparIdleRs?.prepWeeksRemaining ?? 0) > 0) ? 0 : (sparIdleRs?.idleWeeks ?? 0);
        const sparIsFightPrep = !!(sparIdleRs?.selectedOpponentId != null && (sparIdleRs?.prepWeeksRemaining ?? 0) > 0);
        sparringAllocPoints = Math.ceil(sparringAllocPoints * 1.75);
        const isKO = newState.fightResult === "KO" || newState.fightResult === "TKO";
        if (sparringWon && isKO) {
          const koElapsed = newState.roundDuration - newState.roundTimer;
          if (koElapsed <= 25) sparringAllocPoints += 6;
          else if (koElapsed <= 30) sparringAllocPoints += 3;
          else if (koElapsed <= 35) sparringAllocPoints += 2;
          else if (koElapsed <= 40) sparringAllocPoints += 1;
        }
        const sparCfg = loadXpConfig();
        const sparBonusX = Math.max(1, Math.round(sparCfg.statSparBonusX ?? 1));
        const sparBonusY = Math.max(1, Math.round(sparCfg.statSparBonusY ?? 5));
        sparringAllocPoints += Math.floor(landed / sparBonusY) * sparBonusX;
        const sparStatPct = sparIsFightPrep ? (sparCfg.statSparPrepBonus ?? 0) : (sparCfg.statSparIdleBonus ?? 0);
        if (sparStatPct !== 0) sparringAllocPoints = Math.round(sparringAllocPoints * (1 + sparStatPct / 100));
        sparringAllocPoints = Math.round(sparringAllocPoints * (sparCfg.statSparMult ?? 1.0));
        // Global training SP rebalance: all training rewards are reduced by 40%.
        sparringAllocPoints = Math.ceil(sparringAllocPoints * 0.6);
        const sparMaxByDiffBase = sparTierRewards.pointCap;
        // Idle penalties only kick in after a 4-week grace period with no opponent.
        const sparMaxByDiff = sparIdleWeeks === 5 ? Math.ceil(sparMaxByDiffBase / 2) : sparMaxByDiffBase;
        sparringAllocPoints = Math.min(sparringAllocPoints, sparMaxByDiff);
        if (sparIdleWeeks >= 6) {
          sparringAllocPoints = Math.ceil(sparringAllocPoints * 0.2);
        }
        const currentWeeklyBonus = (activeFighter.careerRosterState as CareerRosterState | null)?.weeklyBonus ?? null;
        if (currentWeeklyBonus?.trainingType === "sparring" && currentWeeklyBonus.bonusType === "sp") {
          sparringAllocPoints += currentWeeklyBonus.value;
        }
        // Headgear Strap: applied after the difficulty cap so the boost is felt.
        const sparItemSpMult = getSparringSpMult(withSavedInventory(activeFighter), sparIdleRs);
        if (sparItemSpMult !== 1) sparringAllocPoints = Math.ceil(sparringAllocPoints * sparItemSpMult);
        // Import Ticket: beating an imported roster fighter pays 4x. Applied
        // after the difficulty cap, like the item multiplier, so it lands.
        const sparWasImport = importedPartnerUsedRef.current;
        if (sparWasImport && sparringWon) sparringAllocPoints *= 4;
        // A sparring defeat pays a share of the session rather than nothing.
        // Deliberately last in the accumulation so the loss keeps its cut of
        // every multiplier that fed the total — see SPARRING_LOSS_SP_SHARE. The
        // difficulty cap and the stat cap still apply below. A draw is
        // unaffected and keeps its full consolation payout.
        if (newState.fightWinner === "enemy") {
          sparringAllocPoints = Math.floor(sparringAllocPoints * SPARRING_LOSS_SP_SHARE);
        }
        // The all-skills unlock pays a one-time 1.5× on the session. It is
        // folded in before the cap so the milestone can't smuggle points past
        // it — the excess pays Force like any other overflow.
        const bannerKey = `handz_allskills_banner_seen_${activeFighter.id}`;
        const sparAllSkillsUnlocked = (activeFighter.careerBoutIndex || 0) >= 10;
        // Never on a loss. This is a one-time 1.5×, and a losing session is
        // only worth half of one, so burning the milestone there costs the
        // player most of it. Losses paying nothing used to make that automatic
        // via the early return below; now that they pay, it has to be explicit.
        // Draws are unchanged — they were always eligible.
        const showAllSkillsBanner = sparAllSkillsUnlocked
          && localStorage.getItem(bannerKey) !== "true"
          && newState.fightWinner !== "enemy";
        if (showAllSkillsBanner) sparringAllocPoints = Math.ceil(sparringAllocPoints * 1.5);
        const sparUncapped = sparringAllocPoints;
        sparringAllocPoints = Math.min(
          sparringAllocPoints,
          Math.max(0, statPointCap(sparChampBeaten) - totalSkillPts(activeFighter.skillPoints, activeFighter.availableStatPoints || 0))
        );
        // Points the stat cap left no room for are paid out as Force instead.
        // Sparring is gym work, so it pays the training rate.
        const sparOverflowForce = cappedStatPointForce(sparUncapped - sparringAllocPoints, FORCE_PER_CAPPED_SP_TRAINING);
        const sparForceBase = localSaves.getFighter(activeFighter.id)?.force ?? activeFighter.force ?? 0;
        const sparTotalRefPts = sparRefPts;
        const newSparRef: SkillRefinement = sparTotalRefPts > 0
          ? { ...oldSparRef, availablePoints: (oldSparRef.availablePoints || 0) + sparTotalRefPts }
          : oldSparRef;
        const sparWeeklyXpMult = (currentWeeklyBonus?.trainingType === "sparring" && currentWeeklyBonus.bonusType === "xp") ? currentWeeklyBonus.value : 1;

        const sparringBonusXp = Math.floor(
          ((newState.player.punchesLanded * 2) +
          (newState.player.cleanPunchesLanded * 10) +
          (newState.player.feintBaits * 20)) * 0.7 * 0.32
        );

        const midFightLevel = newState.midFightLevelUps > 0 ? newState.playerLevel : activeFighter.level;
        const midFightXp = newState.midFightLevelUps > 0 ? newState.playerCurrentXp : activeFighter.xp;
        const sparXpCfg = loadXpConfig();
        const sparWinXpMult = Math.pow(sparXpCfg.sparWinBase, activeFighter.wins || 0);
        const sparXpBonusPct = sparIsFightPrep ? (sparXpCfg.xpSparPrepBonus ?? 0) : (sparXpCfg.xpSparIdleBonus ?? 0);
        // Item boosts: Old Bell Hammer's permanent +10% and GOAT's Blessing.
        const sparItemXpMult = getSparringXpMult(withSavedInventory(activeFighter), sparIdleRs);
        const sparImportXpMult = (sparWasImport && sparringWon) ? 4 : 1;
        const sparXpFinal = Math.max(1, Math.floor((xpGained + sparringBonusXp) * sparWinXpMult * (1 + sparXpBonusPct / 100) * sparWeeklyXpMult * sparItemXpMult * sparImportXpMult));
        let newXp = midFightXp + sparXpFinal;
        let newLevel = midFightLevel;
        while (newXp >= xpToNextLevel(newLevel) && newLevel < 1000) {
          newXp -= xpToNextLevel(newLevel);
          newLevel++;
        }
        if (newLevel >= 1000) {
          newLevel = 1000;
          newXp = Math.min(newXp, xpToNextLevel(1000) - 1);
        }

        const oldStats = (activeFighter.careerStats || DEFAULT_CAREER_STATS) as CareerStats;
        const newCareerStats: CareerStats = {
          ...oldStats,
          totalKnockdownsGiven: oldStats.totalKnockdownsGiven + (newState.player.knockdownsGiven ?? 0),
          lifetimeXp: oldStats.lifetimeXp + (xpGained + sparringBonusXp),
        };

        const tb = (activeFighter.trainingBonuses || DEFAULT_TRAINING_BONUSES) as TrainingBonuses;
        // Lifetime rhythm cut counter: every 20 clean rhythm cuts landed in sparring = 1 diamond
        const RC_PER_DIAMOND = 20;
        const prevRcHits = tb.totalRhythmCutHits || 0;
        const newRcHits = prevRcHits + Math.max(0, newState.player.rhythmCutHitsLanded || 0);
        const rcDiamonds = Math.floor(newRcHits / RC_PER_DIAMOND) - Math.floor(prevRcHits / RC_PER_DIAMOND);
        const newTB: TrainingBonuses = {
          ...tb,
          sparring: (tb.sparring || 0) + 1,
          totalRhythmCutHits: newRcHits,
        };
        // Champion sparring: keeping the partner's accuracy down pays diamonds.
        const defDiamonds = championDefenceDiamonds(sparringDifficulty, newState.roundDuration, newState.enemy.punchesThrown, newState.enemy.punchesLanded);
        if (defDiamonds > 0) {
          const oppAccPct = Math.round((newState.enemy.punchesLanded / Math.max(1, newState.enemy.punchesThrown)) * 100);
          const ddm = {
            title: "Champion Defence",
            description: `Partner held to ${oppAccPct}% accuracy — earned ${defDiamonds} Diamond${defDiamonds > 1 ? "s" : ""}!`,
            icon: "💎",
          };
          deferredFightMilestonesRef.current = deferredFightMilestonesRef.current?.length ? [...deferredFightMilestonesRef.current, ddm] : [ddm];
        }
        const sparDiamondsEarned = rcDiamonds + defDiamonds;
        if (rcDiamonds > 0) {
          const rcm = {
            title: "Rhythm Cut Mastery",
            description: `Earned ${rcDiamonds} Diamond${rcDiamonds > 1 ? "s" : ""}!`,
            icon: "💎",
          };
          deferredFightMilestonesRef.current = deferredFightMilestonesRef.current?.length ? [...deferredFightMilestonesRef.current, rcm] : [rcm];
        }

        runStatPointCheck(activeFighter);

        let updatedRosterState = withSavedPatternLibrary(activeFighter.id, activeFighter.careerRosterState as CareerRosterState | null);
        // Drilled work goes in FIRST, before the weekly simulation below. That
        // sim settles every string's rehearsal for the week — banking the
        // session's throws after it would hand the new week a stale tally and
        // roll the rollover straight back.
        updatedRosterState = withGymWorkFromBout(updatedRosterState, newState);
        let didSimulate = false;
        let sparDecayedSP: SkillPoints | null = null;
        if (updatedRosterState) {
          // Persistent availability perk: camp sparring sessions also add +0.1% each.
          const wasInFightCampSpar = updatedRosterState.selectedOpponentId != null && (updatedRosterState.prepWeeksRemaining ?? 0) > 0;
          const prevTrainingsSpar = updatedRosterState.trainingsSinceLastWeek ?? 0;
          const sparPreWeek = activityStampWeek(activeFighter.id, updatedRosterState);
          // Ordinary sparring stamps its week inline rather than through
          // stampSparWeek, so the session has to be counted here too — both
          // branches below, exactly once each. What it is worth towards the
          // Reset's snap rides on the partner's grade.
          const sparTotal = nextSparCount(activeFighter.id, updatedRosterState, sparSessionsForDifficulty(sparringDifficulty));
          if (prevTrainingsSpar >= 1) {
            const sparInFightCamp = updatedRosterState.selectedOpponentId != null && (updatedRosterState.prepWeeksRemaining ?? 0) > 0;
            const weekSeed = Date.now();
            updatedRosterState = simulateWeek({ ...updatedRosterState, lastSparWeek: sparPreWeek, totalSpars: sparTotal, weeklyBonus: null }, weekSeed, activeFighter.careerDifficulty, newLevel, true, refinementTotal(activeFighter.skillRefinement as Record<string, number> | null), getEquipmentLevels(activeFighter));
            updatedRosterState = { ...updatedRosterState, trainingsSinceLastWeek: 0 };
            didSimulate = true;
            const pRating = updatedRosterState.playerRatingScore ?? 1000;
            const newPlayerRank = sparInFightCamp ? updatedRosterState.playerRank : Math.max(computePlayerRankFromRating(updatedRosterState.roster, pRating, updatedRosterState.rank1HolderId), updatedRosterState.playerRank ?? 701);
            const newWeeklyBonus = generateWeeklyBonus(activeFighter.wins || 0, activeFighter.careerStats, updatedRosterState);
            updatedRosterState = {
              ...updatedRosterState,
              playerRank: newPlayerRank,
              refinementPermanentlyUnlocked: updatedRosterState.refinementPermanentlyUnlocked || newPlayerRank <= 650,
              savedChargeBars: newState.player.chargeMeterBars,
              savedChargeCounters: newState.player.chargeMeterCounters,
              weeklyBonus: newWeeklyBonus ?? null,
            };
            sparDecayedSP = applyTrainingDecay(updatedRosterState, (activeFighter.skillPoints || {}) as SkillPoints);
          } else {
            const nextBonusSpar = generateWeeklyBonus(activeFighter.wins || 0, activeFighter.careerStats, updatedRosterState);
            updatedRosterState = {
              ...updatedRosterState,
              trainingsSinceLastWeek: 1,
              lastSparWeek: sparPreWeek,
              totalSpars: sparTotal,
              savedChargeBars: newState.player.chargeMeterBars,
              savedChargeCounters: newState.player.chargeMeterCounters,
              weeklyBonus: nextBonusSpar ?? null,
            };
          }
          if (wasInFightCampSpar) {
            updatedRosterState = { ...updatedRosterState, campTrainingSessions: (updatedRosterState.campTrainingSessions ?? 0) + 1 };
          }
          // Every counted slip goes on the Defensive Mastery tally, win or lose.
          updatedRosterState = bankSlipsLanded(
            updatedRosterState,
            localSaves.getFighter(activeFighter.id)?.careerRosterState as CareerRosterState | null,
            slipsLandedOf(newState),
          );
          // Perfect blocks raise Defensive Mastery, win or lose, at the grade's rate.
          updatedRosterState = grantDefensiveMasteryBonus(
            updatedRosterState,
            localSaves.getFighter(activeFighter.id)?.careerRosterState as CareerRosterState | null,
            perfectBlocksOf(newState) * (MASTERY_PCT_PER_PERFECT_BLOCK[sparringDifficulty] ?? 0),
          );
          // Conditioning: winning the session is worth a point. Losing still
          // restarts the decay clock through the stamp above.
          if (sparringWon) {
            updatedRosterState = grantPunchEndurance(activeFighter.id, updatedRosterState, 1);
            // Slip training: every close-range hand slip pays its grade's rate.
            updatedRosterState = grantSlipTraining(
              updatedRosterState,
              localSaves.getFighter(activeFighter.id)?.careerRosterState as CareerRosterState | null,
              slipsLandedOf(newState) * (SLIP_TRAINING_PCT_PER_SLIP[sparringDifficulty] ?? 0),
            );
          }
        }

        // Item bookkeeping: burn the Import Ticket the session used, expire any
        // lapsed boosts, and bank Coach's Notes growth for camp sessions.
        const sparSaved = withSavedInventory(activeFighter);
        const sparImported = importedPartnerUsedRef.current;
        importedPartnerUsedRef.current = false;
        let sparInventory: ItemInventory | null =
          consumeBoostsFor(sparSaved, "sparring", updatedRosterState, {
            sparring: true,
            // The session only spends the ticket if it really imported someone.
            skipPerks: sparImported ? undefined : ["importSparring"],
          }) ?? pruneBoosts(sparSaved, updatedRosterState);
        const sparIsCampSession = (activeFighter.careerRosterState as CareerRosterState | null)?.selectedOpponentId != null
          && (((activeFighter.careerRosterState as CareerRosterState | null)?.prepWeeksRemaining ?? 0) > 0);
        const coachRate = getCoachNotesRate(withSavedInventory(activeFighter));
        if (sparIsCampSession && coachRate > 0) {
          const notesFighter = sparInventory ? { ...sparSaved, itemInventory: sparInventory } : sparSaved;
          const noted = accrueCoachNotes(notesFighter, coachRate, COACH_NOTES_STATS as readonly string[]);
          if (noted) sparInventory = noted.inventory;
        }

        // Sparring win reward: one item, its tier set by how fast the session
        // was finished (a decision win pays the base tier) and capped by the
        // difficulty sparred. Rolled off the inventory the boost burn produced
        // so both land in one save write. The cap is handed to the roll too, or
        // an exhausted tier could fall back to something above the ceiling.
        const sparElapsedSeconds = Math.max(0, newState.roundDuration - newState.roundTimer);
        const sparRewardRarity = sparringWon
          ? sparringWinRarity(sparElapsedSeconds, sparRewardTier, sparUpgraded, sparRewardCfg)
          : null;
        if (sparUpgraded) {
          const upgradeMilestone = {
            title: `${SPARRING_TIER_LABELS[sparRewardTier]} Rewards`,
            description: `Won with ${Math.round(accuracy * 100)}% accuracy — this session paid ${SPARRING_TIER_LABELS[sparRewardTier]}-tier rewards.`,
            icon: "🎯",
            kind: "reward" as const,
          };
          deferredFightMilestonesRef.current = deferredFightMilestonesRef.current?.length
            ? [...deferredFightMilestonesRef.current, upgradeMilestone]
            : [upgradeMilestone];
        }
        if (sparRewardRarity) {
          const sparRewardRoll = rollRarityItemForFighter(
            sparInventory ? { ...sparSaved, itemInventory: sparInventory } : sparSaved,
            sparRewardRarity,
            updatedRosterState?.playerRank ?? null,
            SPARRING_WIN_RARITY_CAP[sparRewardTier] ?? null,
            false,
            "training",
          );
          if (sparRewardRoll.inventory && sparRewardRoll.itemIds.length > 0) {
            sparInventory = sparRewardRoll.inventory;
            const sparRewardNames = sparRewardRoll.itemIds
              .map(id => getItemDefinition(id)?.name ?? id)
              .join(" · ");
            const sparRewardMilestone = {
              title: "Sparring Reward",
              description: `${sparRewardNames} — waiting in your Locker.`,
              icon: "🎁",
              kind: "reward" as const,
            };
            deferredFightMilestonesRef.current = deferredFightMilestonesRef.current?.length
              ? [...deferredFightMilestonesRef.current, sparRewardMilestone]
              : [sparRewardMilestone];
          }
        }

        updateFighterMutation.mutate({
          id: activeFighter.id,
          data: {
            xp: newXp,
            level: newLevel,
            trainingBonuses: newTB,
            careerStats: newCareerStats,
            careerRosterState: updatedRosterState,
            ...(sparTotalRefPts > 0 ? { skillRefinement: newSparRef } : {}),
            ...(sparOverflowForce > 0 ? { force: sparForceBase + sparOverflowForce } : {}),
            ...(sparDiamondsEarned > 0 ? { diamonds: (activeFighter.diamonds ?? 0) + sparDiamondsEarned } : {}),
            ...(sparDecayedSP ? { skillPoints: sparDecayedSP } : {}),
            ...(sparInventory ? { itemInventory: sparInventory } : {}),
          },
        });

        setActiveFighter(prev => prev ? {
          ...prev,
          xp: newXp,
          level: newLevel,
          trainingBonuses: newTB,
          careerStats: newCareerStats,
          careerRosterState: updatedRosterState,
          ...(sparTotalRefPts > 0 ? { skillRefinement: newSparRef } : {}),
          ...(sparOverflowForce > 0 ? { force: sparForceBase + sparOverflowForce } : {}),
          ...(sparDiamondsEarned > 0 ? { diamonds: (prev.diamonds ?? 0) + sparDiamondsEarned } : {}),
          ...(sparDecayedSP ? { skillPoints: sparDecayedSP } : {}),
          ...(sparInventory ? { itemInventory: sparInventory } : {}),
        } : null);

        const sparPlaystyle = extractPlayerPlaystyle(newState);
        savePlayerPlaystyle(activeFighter.id, sparPlaystyle);

        const sparCustomUnlock = tb.customStatUnlock as keyof SkillPoints | undefined;
        const sparFocusUnlockedSpar = (activeFighter.careerBoutIndex || 0) >= 2;
        const sparBaseAllowed: (keyof SkillPoints)[] = sparFocusUnlockedSpar ? ["speed", "defense", "stamina", "focus"] : ["speed", "defense", "stamina"];
        const sparAllowedStats: (keyof SkillPoints)[] = sparAllSkillsUnlocked
          ? ["power", "speed", "defense", "stamina", "focus"]
          : (sparCustomUnlock && !sparBaseAllowed.includes(sparCustomUnlock) ? [...sparBaseAllowed, sparCustomUnlock] : sparBaseAllowed);
        if (sparringAllocPoints <= 0) {
          deferredSparSimNewsRef.current = (didSimulate && updatedRosterState) ? updatedRosterState.newsItems : null;
          return;
        }
        if (showAllSkillsBanner) localStorage.setItem(bannerKey, "true");
        // The milestone's 1.5× is already in sparringAllocPoints (applied above,
        // under the cap). Manual allocation screen for sparring.
        setPendingTrainingAlloc({
          points: sparringAllocPoints,
          allowedStats: sparAllowedStats,
          didSimulate: !!(didSimulate && updatedRosterState),
          simulationNews: didSimulate && updatedRosterState ? updatedRosterState.newsItems : undefined,
          showAllSkillsBanner,
        });
        setAllocShowsRefinement(false);
      } else if (isCareerFight && activeFighter) {
        const isWin = newState.fightWinner === "player";
        const isDraw = newState.fightResult === "Draw";
        const isKO = newState.fightResult === "KO" || newState.fightResult === "TKO";

        const xpCfg = loadXpConfig();
        const fightBonusMult = Math.pow(xpCfg.boutBase, activeFighter.careerBoutIndex);
        const fightBonusXp = Math.floor(
          (newState.player.cleanPunchesLanded * 20 +
           newState.player.feintBaits * 40 +
           newState.player.knockdownsGiven * 100) * 0.7
        );

        const thrown = newState.player.punchesThrown;
        const landed = newState.player.punchesLanded;
        const accuracy = thrown > 0 ? landed / thrown : 0;
        let accuracyMult = 1.0;
        let accuracyBonusStat = 0;
        if (accuracy >= 0.75) { accuracyMult = xpCfg.accMult75; accuracyBonusStat = 1; }
        else if (accuracy >= 0.70) accuracyMult = xpCfg.accMult70;
        else if (accuracy >= 0.65) accuracyMult = xpCfg.accMult65;
        else if (accuracy >= 0.60) accuracyMult = xpCfg.accMult60;
        else if (accuracy >= 0.50) accuracyMult = xpCfg.accMult50;

        const champWinBonus = isWin && newState.aiDifficulty === "champion" ? xpCfg.champBonus : 1.0;
        const endgameXpMult = activeFighter.level >= 100 ? xpCfg.endgameMult : 1.0;
        const fightRosterForXp = activeFighter.careerRosterState as CareerRosterState | null;
        const fightPreChampXpMult = fightRosterForXp && isChampBeaten(fightRosterForXp.roster) ? 1.0 : xpCfg.preChampMult;

        // Level-gap XP bonus: reward fighting opponents more than 2 levels above the player.
        // Applies on any result; adds a flat 20% of the base XP per level past the +2 threshold
        // (linear, NOT compounding). A loss only keeps 35% of that bonus.
        const oppRosterEntry = fightRosterForXp?.roster?.find(f => f.id === careerOpponentId);
        const oppStartLevel = oppRosterEntry?.level ?? activeFighter.level;
        const levelGap = oppStartLevel - activeFighter.level;
        const levelsPastThreshold = levelGap > 2 ? levelGap - 2 : 0;
        const isLoss = !isWin && !isDraw;
        const levelGapBonusFraction = levelsPastThreshold > 0
          ? levelsPastThreshold * 0.2 * (isLoss ? 0.35 : 1)
          : 0;
        const levelGapMult = 1 + levelGapBonusFraction;

        // Lower-opponent EXP debuff: scale down XP when opponent is below player level.
        const lowerOppP = Math.max(0, ((activeFighter.level - oppStartLevel) / activeFighter.level) * 100);
        const lowerOppDebuff = lowerOppP > 0 ? Math.pow(0.98, lowerOppP) : 1;

        // Base post-fight XP (no level-gap multiplier — used for normal leveling)
        const baseXp = Math.floor((newState.xpGained * fightBonusMult + fightBonusXp) * accuracyMult * champWinBonus * endgameXpMult * fightPreChampXpMult * xpCfg.careerMult * xpCfg.finalDoubler * lowerOppDebuff);
        const midFightLevel = newState.midFightLevelUps > 0 ? newState.playerLevel : activeFighter.level;
        const midFightXp = newState.midFightLevelUps > 0 ? newState.playerCurrentXp : activeFighter.xp;
        const fightChampBeaten = (fightRosterForXp ? isChampBeaten(fightRosterForXp.roster) : false) || (careerOpponentId === 204 && isWin);
        let newXp = midFightXp + baseXp;
        let newLevel = midFightLevel;
        while (newXp >= xpToNextLevel(newLevel) && newLevel < 1000) {
          newXp -= xpToNextLevel(newLevel);
          newLevel++;
        }
        if (newLevel >= 1000) {
          newLevel = 1000;
          newXp = Math.min(newXp, xpToNextLevel(1000) - 1);
        }
        // Level-gap bonus applied after normal leveling so it never inflates mid-fight level ups
        if (levelGapMult > 1) {
          const bonusXp = baseXp * (levelGapMult - 1);
          newXp += bonusXp;
          while (newXp >= xpToNextLevel(newLevel) && newLevel < 1000) {
            newXp -= xpToNextLevel(newLevel);
            newLevel++;
          }
          if (newLevel >= 1000) {
            newLevel = 1000;
            newXp = Math.min(newXp, xpToNextLevel(1000) - 1);
          }
        }

        const perfStats = extractPerformanceStats(newState);
        const oldStats = (activeFighter.careerStats || DEFAULT_CAREER_STATS) as CareerStats;
        const newCareerStats: CareerStats = {
          totalPunchesThrown: oldStats.totalPunchesThrown + perfStats.punchesThrown,
          totalPunchesLanded: oldStats.totalPunchesLanded + perfStats.punchesLanded,
          totalKnockdownsGiven: oldStats.totalKnockdownsGiven + perfStats.knockdownsGiven,
          totalKnockdownsTaken: oldStats.totalKnockdownsTaken + perfStats.knockdownsTaken,
          totalBlocksMade: oldStats.totalBlocksMade + perfStats.blocksMade,
          totalDodges: oldStats.totalDodges + perfStats.dodges,
          totalDamageDealt: oldStats.totalDamageDealt + perfStats.damageDealt,
          totalDamageReceived: oldStats.totalDamageReceived + perfStats.damageReceived,
          totalRoundsWon: oldStats.totalRoundsWon + perfStats.roundsWon,
          totalRoundsLost: oldStats.totalRoundsLost + perfStats.roundsLost,
          lifetimeXp: oldStats.lifetimeXp + Math.floor(newState.xpGained * fightPreChampXpMult * xpCfg.careerMult),
        };

        const newBoutIndex = activeFighter.careerBoutIndex + 1;
        const newWins = activeFighter.wins + (isWin ? 1 : 0);
        const newLosses = activeFighter.losses + (!isWin && !isDraw ? 1 : 0);
        const newDraws = activeFighter.draws + (isDraw ? 1 : 0);
        const newKnockouts = activeFighter.knockouts + (isWin && isKO ? 1 : 0);

        const allTriggered: Array<{ title: string; description: string; icon: string }> = [];
        const wasChampBeaten = isChampBeaten(fightRosterForXp?.roster ?? []);
        if (careerOpponentId === 204 && isWin && !wasChampBeaten) {
          allTriggered.push({
            title: "Champion Defeated!",
            description: "The undisputed champion has been defeated. Free skin color selection and endgame opponents are now unlocked.",
            icon: "👑",
          });
        }
        // Endgame unlock: 50 wins + champion beaten → Nightmare and Doghouse always available
        const newChampBeaten = wasChampBeaten || (careerOpponentId === 204 && isWin);
        const wasEndgameUnlocked = wasChampBeaten && activeFighter.wins >= 50;
        const isNowEndgameUnlocked = newChampBeaten && newWins >= 50;
        if (!wasEndgameUnlocked && isNowEndgameUnlocked) {
          allTriggered.push({
            title: "Elite Status!",
            description: "Nightmare Mode and Doghouse sparring are now permanently available — no fight camp required.",
            icon: "🔓",
          });
        }
        const fightRefCostFilter = makeRefCostMilestoneFilter(activeFighter.level || 1, refCostReductionOf(activeFighter));
        allTriggered.push(...FIGHT_MILESTONES.filter(m =>
          (m.type === "wins"
            ? activeFighter.wins < m.threshold && newWins >= m.threshold
            : m.type === "bouts"
            ? activeFighter.careerBoutIndex < m.threshold && newBoutIndex >= m.threshold
            : activeFighter.level < m.threshold && newLevel >= m.threshold)
          && fightRefCostFilter(m.title, m.threshold)
        ).map(m => ({ title: m.title, description: m.description, icon: m.icon })));
        if (allTriggered.length > 0) {
          deferredFightMilestonesRef.current = allTriggered;
        }

        runStatPointCheck(activeFighter);

        // Whole-blob write ahead: the copy on activeFighter can predate whatever
        // the gym last drilled, so the saved collections are pinned back on
        // before anything else touches it.
        let updatedRosterState = withSavedPatternLibrary(activeFighter.id, activeFighter.careerRosterState as CareerRosterState | null);
        // A career bout cannot sharpen a drilled string, but throwing one still
        // counts as rehearsal — so the list comes back from here too, or a
        // combination the player only ever uses on fight night decays as though
        // it had been abandoned. Folded before the post-fight weekly sim, which
        // is what settles the rehearsal week. No-ops when nothing moved.
        updatedRosterState = withGymWorkFromBout(updatedRosterState, newState);
        const wasRefinementUnlockedPre = !!(updatedRosterState as CareerRosterState | null)?.refinementPermanentlyUnlocked;
        // Read before updateRankings runs, so the crate upset boost below weighs
        // the gap the player actually fought across, not their post-win rank.
        const preFightPlayerRank = (updatedRosterState as CareerRosterState | null)?.playerRank ?? null;
        // The best (lowest) rank this bout reached. Refinement Slots are earned
        // off it rather than off the rank the save ends on, because the weekly
        // sim that runs after every career fight is allowed to push rank back
        // out — a threshold the fight itself crossed still counts.
        let bestRankThisBout = preFightPlayerRank ?? 999;
        let oppRankForForce = 704;
        if (updatedRosterState && careerOpponentId) {
          const currentHolderId = resolveRank1Holder(updatedRosterState.roster, updatedRosterState.rank1HolderId);
          let newHolderId: number | "player" = currentHolderId;
          if (isWin && currentHolderId === careerOpponentId) {
            newHolderId = "player";
          } else if (!isWin && !isDraw && currentHolderId === "player") {
            newHolderId = careerOpponentId;
          }
          const newRoster = updatedRosterState.roster.map(f => {
            if (f.id === careerOpponentId) {
              const updated = { ...f };
              if (isWin) {
                updated.losses++;
                updated.totalFights++;
                if (KEY_FIGHTER_IDS.includes(f.id) || f.alwaysUndefeated) {
                  updated.beatenByPlayer = true;
                }
                if (f.alwaysUndefeated) {
                  updated.alwaysUndefeated = false;
                }
              } else if (isDraw) {
                updated.draws++;
                updated.totalFights++;
              } else {
                updated.wins++;
                updated.totalFights++;
                if (isKO) updated.knockouts++;
              }
              return updated;
            }
            return { ...f };
          });
          const oppEntry = newRoster.find(f => f.id === careerOpponentId);
          const oppRank = oppEntry?.rank ?? 999;
          oppRankForForce = oppRank;
          const oppRating = oppEntry?.ratingScore ?? 1000;

          let method: "close" | "dominant" | "ko" = "close";
          if (isKO) method = "ko";
          else {
            const kdsGiven = perfStats.knockdownsGiven;
            if (kdsGiven >= 2) method = "dominant";
          }

          const careerDiff = (activeFighter.careerDifficulty as AIDifficulty) || "contender";
          const preFightPlayerRating = updatedRosterState.playerRatingScore ?? 1000;
          const currentPlayerRank = updatedRosterState.playerRank ?? 705;
          const fightResult: "win" | "loss" | "draw" = isWin ? "win" : isDraw ? "draw" : "loss";
          // ELO changes first (standard formula + rank-gap multiplier)...
          const pRating = updatePlayerRating(preFightPlayerRating, oppRating, fightResult, method, careerDiff, currentPlayerRank, oppRank, activeFighter.level, oppEntry?.level);

          if (isWin && oppEntry) {
            const { loserDelta } = computeEloChange(preFightPlayerRating, oppRating, method, 1.0, oppRank === 1, currentPlayerRank, oppRank, undefined, oppEntry.totalFights);
            oppEntry.ratingScore = Math.max(800, (oppEntry.ratingScore ?? 1000) + loserDelta);
          } else if (!isWin && !isDraw && oppEntry) {
            const { winnerDelta } = computeEloChange(oppRating, preFightPlayerRating, method, 1.0, false, oppRank, currentPlayerRank, oppEntry.totalFights, undefined);
            oppEntry.ratingScore = (oppEntry.ratingScore ?? 1000) + winnerDelta;
          }

          // ...then rankings recompute from ELO with movement smoothing.
          // Rank 1 stays a sticky belt via newHolderId — never displaced by sorting.
          updateRankings(newRoster, newHolderId);
          let newPlayerRank: number;
          if (newHolderId === "player") {
            newPlayerRank = 1;
          } else {
            const eloRank = computePlayerRankFromRating(newRoster, pRating, newHolderId);
            newPlayerRank = smoothPlayerRankMovement(currentPlayerRank, eloRank, oppRank, fightResult);
          }
          bestRankThisBout = Math.min(bestRankThisBout, newPlayerRank);

          updatedRosterState = {
            ...updatedRosterState,
            roster: newRoster,
            selectedOpponentId: null,
            playerRank: newPlayerRank,
            refinementPermanentlyUnlocked: updatedRosterState.refinementPermanentlyUnlocked || newPlayerRank <= 650,
            playerRatingScore: pRating,
            rank1HolderId: newHolderId,
            prepWeeksRemaining: undefined,
            rescheduledThisFight: false,
            careerFightsCompleted: (updatedRosterState.careerFightsCompleted ?? 0) + 1,
            savedChargeBars: newState.player.chargeMeterBars,
            savedChargeCounters: newState.player.chargeMeterCounters,
          };
          if (!wasRefinementUnlockedPre && newPlayerRank <= 650) {
            const m = { title: "Skill Refinement Unlocked!", description: "You've broken into the top 650. You can now access the Refinement system — exchange stat points for refinement points and fine-tune your fighter's edge.", icon: "🔷" };
            deferredFightMilestonesRef.current = deferredFightMilestonesRef.current ? [...deferredFightMilestonesRef.current, m] : [m];
          }
        }

        const careerDiffForPoints = (activeFighter.careerDifficulty as AIDifficulty) || "contender";
        let fightStatPoints = (careerDiffForPoints === "champion" ? 5 : careerDiffForPoints === "elite" ? 2 : 1) + accuracyBonusStat;
        if (activeFighter.level >= 20 && accuracy > 0.6) {
          const fightTiers = Math.floor(activeFighter.level / 10) - 1;
          fightStatPoints += fightTiers * 2;
        }
        fightStatPoints = Math.floor(Math.ceil(fightStatPoints * 1.75 * 4) * 0.5);
        fightStatPoints = Math.round(fightStatPoints * (xpCfg.statBoutMult ?? 1.0));
        if (isKO && isWin) {
          const koElapsed = newState.roundDuration - newState.roundTimer;
          const koTimeBonus = koElapsed <= 25 ? 6 : koElapsed <= 30 ? 3 : koElapsed <= 35 ? 2 : koElapsed <= 40 ? 1 : 0;
          fightStatPoints += koTimeBonus * 3;
        }
        const upsetLevelDiff = Math.max(0, oppStartLevel - activeFighter.level);
        if (upsetLevelDiff > 0) {
          fightStatPoints += upsetLevelDiff * 2;
        }
        // Stat-point discrepancy bonus: opponent has >15% more total stat points than the player.
        // Adds +10% per percentage point above the 15% threshold, capped at +100%.
        // The bonus is halved on a loss.
        if (oppRosterEntry) {
          const sp = activeFighter.skillPoints as { power?: number; speed?: number; defense?: number; stamina?: number; focus?: number } | null;
          const playerStatTotal = (sp?.power ?? 0) + (sp?.speed ?? 0) + (sp?.defense ?? 0) + (sp?.stamina ?? 0) + (sp?.focus ?? 0);
          const oppStatTotal = (oppRosterEntry.statPower ?? 0) + (oppRosterEntry.statSpeed ?? 0) + (oppRosterEntry.statDefense ?? 0) + (oppRosterEntry.statStamina ?? 0) + (oppRosterEntry.statFocus ?? 0);
          if (playerStatTotal > 0 && oppStatTotal > playerStatTotal * 1.15) {
            const excessPct = oppStatTotal / playerStatTotal - 1;
            const bonusFrac = Math.min(1.0, (excessPct - 0.15) * 10);
            const bonusMult = 1 + bonusFrac * (isLoss ? 0.5 : 1.0);
            fightStatPoints = Math.round(fightStatPoints * bonusMult);
          }
        }
        if (activeFighter.level >= 100) {
          // Endgame stat-point rules: zero vs opponents 5+ levels below you, otherwise x0.3 (floored) and hard-capped at 20.
          if (newState.enemyLevel < activeFighter.level - 5) {
            fightStatPoints = 0;
          } else {
            fightStatPoints = Math.min(20, Math.floor(fightStatPoints * 0.3));
          }
        }
        const fightUncappedSp = fightStatPoints;
        fightStatPoints = Math.min(
          fightStatPoints,
          Math.max(0, statPointCap(fightChampBeaten) - totalSkillPts(activeFighter.skillPoints, activeFighter.availableStatPoints || 0))
        );
        // Whatever the cap left no room for is paid as Force instead, at the
        // official-bout rate.
        const fightOverflowForce = cappedStatPointForce(fightUncappedSp - fightStatPoints, FORCE_PER_CAPPED_SP_BOUT);
        const fightAllStats: (keyof SkillPoints)[] = ["power", "speed", "defense", "stamina", "focus"];
        const newStatPoints = activeFighter.availableStatPoints;
        if (fightStatPoints > 0) {
          setPendingTrainingAlloc({ points: fightStatPoints, allowedStats: fightAllStats, didSimulate: false });
          setAllocShowsRefinement(false);
        }

        const oldRef = { ...DEFAULT_SKILL_REFINEMENT, ...((activeFighter.skillRefinement || {}) as Partial<SkillRefinement>) } as SkillRefinement;
        let newRef: SkillRefinement = { ...oldRef, availablePoints: (oldRef.availablePoints || 0) + 2 };

        if (isWin && isKO && oldRef.offenseUnlocked) {
          const jab = newState.player.jabThrown ?? 0;
          const hook = newState.player.hookThrown ?? 0;
          const ucut = newState.player.uppercutThrown ?? 0;
          const maxThrown = Math.max(jab, hook, ucut);
          let koField: "jabPower" | "hookPower" | "uppercutPower";
          if (maxThrown === 0 || (jab === hook && hook === ucut)) {
            const r = Math.random();
            koField = r < 1/3 ? "jabPower" : r < 2/3 ? "hookPower" : "uppercutPower";
          } else if (jab >= hook && jab >= ucut) {
            koField = "jabPower";
          } else if (hook >= ucut) {
            koField = "hookPower";
          } else {
            koField = "uppercutPower";
          }
          newRef = { ...newRef, [koField]: Math.min(100, (newRef[koField] || 0) + 2) };
        }

        const ftBonus = newState.fightFastTwitchBonus || 0;
        if (ftBonus > 0 && oldRef.fightIqUnlocked) {
          newRef = { ...newRef, fastTwitch: Math.min(100, (newRef.fastTwitch || 0) + ftBonus) };
        }

        const preTB = (activeFighter.trainingBonuses || DEFAULT_TRAINING_BONUSES) as TrainingBonuses;
        const clearedTB: TrainingBonuses = {
          ...preTB,
          postFightXpBoost: (preTB.postFightXpBoost || 0) + 1,
        };

        const champNewlyBeaten = careerOpponentId === 204 && isWin && !wasChampBeaten;
        if (updatedRosterState && (newLevel >= 100 || champNewlyBeaten)) {
          // Reaching level 100, or beating the champion, via an official fight: make sure the
          // endgame pool exists and is level-jumped.
          updatedRosterState = ensureEndgamePool(updatedRosterState, newLevel, Date.now());
        }
        if (updatedRosterState) {
          // Run a full week simulation after every career fight so roster stats grow
          // via the flat +10-30-per-stat weekly growth. On champ defeat the sim also
          // fires the first endgame pool pass; its news items are stored for the hub.
          const simSeed = Date.now();
          const simCareerDiff = (activeFighter.careerDifficulty as AIDifficulty) || "contender";
          const simResult = simulateWeek({ ...updatedRosterState, weeklyBonus: null }, simSeed, simCareerDiff, newLevel, true, refinementTotal(activeFighter.skillRefinement as Record<string, number> | null), getEquipmentLevels(activeFighter));
          // simResult.playerRank is the fight-result rank (simulateWeek preserves it).
          // Don't let the post-fight roster sim push rank higher than what the fight itself earned.
          const simWeekRank = Math.max(computePlayerRankFromRating(simResult.roster, simResult.playerRatingScore ?? 1000, simResult.rank1HolderId), simResult.playerRank ?? 701);
          const wasRefinementUnlockedSim = !!updatedRosterState.refinementPermanentlyUnlocked;
          updatedRosterState = {
            ...simResult,
            playerRank: simWeekRank,
            refinementPermanentlyUnlocked: updatedRosterState.refinementPermanentlyUnlocked || simWeekRank <= 650,
          };
          if (!wasRefinementUnlockedSim && simWeekRank <= 650) {
            const m = { title: "Skill Refinement Unlocked!", description: "You've broken into the top 650. You can now access the Refinement system — exchange stat points for refinement points and fine-tune your fighter's edge.", icon: "🔷" };
            deferredFightMilestonesRef.current = deferredFightMilestonesRef.current?.length > 0 ? [...deferredFightMilestonesRef.current, m] : [m];
          }
          if (champNewlyBeaten) {
            champDefeatSimNewsRef.current = Array.isArray(simResult.newsItems) ? simResult.newsItems : [];
          }
        }

        // Refinement Slots are earned by climbing the rankings and never taken
        // back, so the stamp only moves up. It rides along in this result's save
        // write because the fight engine reads the player's cap off it.
        if (updatedRosterState) {
          bestRankThisBout = Math.min(bestRankThisBout, updatedRosterState.playerRank ?? 999);
          // The baseline is what the career had walked in with — its stamp, or
          // the rank it already held. A save from before slots existed is caught
          // up silently by the stamp below; only rungs this bout actually earned
          // announce themselves.
          const slotsHad = refinementSlotsUnlocked(newRef);
          const slotsBaseline = Math.max(slotsHad, refinementSlotsForRank(preFightPlayerRank));
          const slotsNow = Math.max(slotsBaseline, refinementSlotsForRank(bestRankThisBout));
          if (slotsNow > slotsHad) {
            newRef = { ...newRef, activeSlotsUnlocked: slotsNow };
          }
          for (let i = slotsBaseline; i < slotsNow; i++) {
            const m = {
              title: "Refinement Slot Unlocked!",
              description: `You've broken into the top ${REFINEMENT_SLOT_RANK_UNLOCKS[i]}. You can now carry ${BASE_ACTIVE_REFINEMENT_SLOTS + i + 1} refinements into the ring at once — pick the extra one on the Refinement screen.`,
              icon: "🔷",
            };
            deferredFightMilestonesRef.current = deferredFightMilestonesRef.current ? [...deferredFightMilestonesRef.current, m] : [m];
          }
        }

        const savedForChampPts = champNewlyBeaten ? (updatedRosterState?.savedForChampStatPoints ?? 0) : 0;
        if (champNewlyBeaten && savedForChampPts > 0 && updatedRosterState) {
          updatedRosterState = { ...updatedRosterState, savedForChampStatPoints: 0 };
        }

        // Fight Surge multiplies the win's Force payout.
        const forceItemMult = getForceMult(activeFighter, updatedRosterState);
        const forceEarned = isWin ? Math.round(computeForceEarned(oppRankForForce) * forceItemMult) : 0;
        // Every win pays a diamond — the fight-end card reports it, so there is
        // no milestone popup for it.
        const diamondsEarned = isWin ? 1 : 0;
        // Read the balance back off storage: the gym pays passive Force behind
        // this screen's back, so the React snapshot can be stale.
        const fightForceBase = localSaves.getFighter(activeFighter.id)?.force ?? activeFighter.force ?? 0;
        const newForce = fightForceBase + forceEarned + fightOverflowForce;
        const newDiamonds = (activeFighter.diamonds ?? 0) + diamondsEarned;
        // The capped-out stat points became Force, so the fight-end readout
        // counts them with the purse.
        lastForceEarnedRef.current = forceEarned + fightOverflowForce;
        lastDiamondsEarnedRef.current = diamondsEarned;

        // Fight-win crates: the opponent's rank band decides how many chests the
        // win awards and the odds of each one. The rolls run off the freshly-read
        // save and their inventory rides along in the same save write as the fight
        // result below, so the rewards and the result commit together.
        // handleContinue shows the reveals, so this block never routes screens.
        pendingCratesRef.current = null;
        const cratesWon: { crateId: CrateId; itemIds: string[] }[] = [];
        // The bout just resolved, so burn its one-shot boosts first — the crates
        // then roll against that inventory and all land in one save write.
        const storedForItems = localSaves.getFighter(activeFighter.id);
        let crateInventory: ItemInventory | null =
          consumeBoostsFor(storedForItems, "fight", updatedRosterState) ?? pruneBoosts(storedForItems, updatedRosterState);
        if (isWin && storedForItems) {
          // Each chest rolls against the inventory the previous one produced, so
          // lifetime caps and one-per-save keepsakes hold across the whole haul.
          for (const wonCrate of pickRewardCrates(oppRankForForce, undefined, preFightPlayerRank)) {
            const roll = rollCrateForFighter(
              crateInventory ? { ...storedForItems, itemInventory: crateInventory } : storedForItems,
              wonCrate,
              updatedRosterState?.playerRank ?? null,
              false,
              "career",
            );
            if (roll.inventory && roll.itemIds.length > 0) {
              cratesWon.push({ crateId: wonCrate, itemIds: roll.itemIds });
              crateInventory = roll.inventory;
            }
          }
          // Spoils of war: a keepsake the beaten opponent was carrying changes
          // hands, unless the player already owns that one-of-a-kind item. It
          // runs off the same inventory chain as the crates so everything the
          // win awarded rides in the single save write below.
          const keepsakeClaim = claimOpponentKeepsakes(
            crateInventory ? { ...storedForItems, itemInventory: crateInventory } : storedForItems,
            newState.opponentItems,
          );
          if (keepsakeClaim.inventory && keepsakeClaim.itemIds.length > 0) {
            crateInventory = keepsakeClaim.inventory;
            const keepsakeNames = keepsakeClaim.itemIds
              .map(id => getItemDefinition(id)?.name ?? id)
              .join(" · ");
            const km = {
              title: "Keepsake Claimed",
              description: `${keepsakeNames} — taken from ${newState.enemyName} and waiting in your Locker.`,
              icon: "🏆",
              kind: "reward" as const,
            };
            deferredFightMilestonesRef.current = deferredFightMilestonesRef.current?.length
              ? [...deferredFightMilestonesRef.current, km]
              : [km];
          }
        }

        // 10 career wins permanently widens the Select Opponent board. Remember it on
        // the roster state so it rides along with save download/upload instead of
        // being recomputed from scratch every time.
        if (updatedRosterState && !updatedRosterState.expandedOpponentBoardUnlocked && newWins >= EXPANDED_BOARD_WIN_THRESHOLD) {
          updatedRosterState = { ...updatedRosterState, expandedOpponentBoardUnlocked: true };
        }

        // Whatever this opponent worked out about the player goes on the tape,
        // so the next one can study it before the bell.
        if (updatedRosterState) {
          const foldedPatterns = foldAiPatternLibrary(newState, updatedRosterState.aiPatternLibrary);
          if (foldedPatterns) {
            updatedRosterState = { ...updatedRosterState, aiPatternLibrary: foldedPatterns };
          }
        }

        updateFighterMutation.mutate({
          id: activeFighter.id,
          data: {
            xp: newXp,
            level: newLevel,
            wins: newWins,
            losses: newLosses,
            draws: newDraws,
            knockouts: newKnockouts,
            careerBoutIndex: newBoutIndex,
            availableStatPoints: newStatPoints + savedForChampPts,
            force: newForce,
            diamonds: newDiamonds,
            careerStats: newCareerStats,
            careerRosterState: updatedRosterState,
            trainingBonuses: clearedTB,
            skillRefinement: newRef,
            ...(crateInventory ? { itemInventory: crateInventory } : {}),
          },
        });

        // Reveal only what actually committed with the result above.
        if (cratesWon.length > 0) pendingCratesRef.current = cratesWon;

        setActiveFighter(prev => prev ? {
          ...prev,
          availableStatPoints: newStatPoints + savedForChampPts,
          skillRefinement: newRef,
        } : null);

        const careerPlaystyle = extractPlayerPlaystyle(newState);
        savePlayerPlaystyle(activeFighter.id, careerPlaystyle);

        saveFightResultMutation.mutate({
          fighterId: activeFighter.id,
          opponentName: newState.enemyName,
          opponentLevel: newState.enemyLevel,
          opponentArchetype: newState.enemy.archetype,
          result: isWin ? "win" : (isDraw ? "draw" : "loss"),
          method: newState.fightResult || "Decision",
          rounds: newState.currentRound,
          xpGained: Math.floor(newState.xpGained * fightPreChampXpMult * xpCfg.careerMult),
          boutNumber: newBoutIndex,
        });

        setActiveFighter(prev => prev ? {
          ...prev,
          xp: newXp,
          level: newLevel,
          wins: newWins,
          losses: newLosses,
          draws: newDraws,
          knockouts: newKnockouts,
          careerBoutIndex: newBoutIndex,
          careerStats: newCareerStats,
          careerRosterState: updatedRosterState,
          trainingBonuses: clearedTB,
          force: newForce,
          diamonds: newDiamonds,
        } : null);
      }
    }
  }, [uiMode, isCareerFight, isSparring, isNightmare, activeFighter, careerOpponentId, sparringDifficulty, isTutorialFight, tutorialStage, startTutorialFight, isCareerTutorial]);

  const handleQuickFight = () => {
    setIsCareerFight(false);
    setActiveFighter(null);
    try {
      const raw = localStorage.getItem("quickFightColors");
      if (raw) setPlayerColors(JSON.parse(raw));
      else setPlayerColors({ ...DEFAULT_PLAYER_COLORS });
    } catch { setPlayerColors({ ...DEFAULT_PLAYER_COLORS }); }
    setUiMode("classSelect");
  };

  const handleCareer = () => {
    setUiMode("career");
  };

  const handleEditRoster = () => {
    const fighterWithRoster = fighters.find(f => f.careerRosterState);
    if (fighterWithRoster) {
      setActiveFighter(fighterWithRoster);
      setUiMode("rosterEdit");
    } else if (fighters.length > 0) {
      const f = fighters[0];
      const rs = initRosterState(f.id + f.name, f.careerDifficulty as AIDifficulty);
      const pr = computePlayerRankFromRating(rs.roster, rs.playerRatingScore, rs.rank1HolderId);
      const initialized = { ...rs, playerRank: pr };
      handleInitRoster(f.id, initialized);
      setActiveFighter({ ...f, careerRosterState: initialized });
      setUiMode("rosterEdit");
    } else {
      const rs = initRosterState("default_roster", "contender" as AIDifficulty);
      const tempFighter = {
        id: -1,
        name: "Roster Preview",
        archetype: "BoxerPuncher",
        level: 1,
        xp: 0,
        wins: 0,
        losses: 0,
        draws: 0,
        knockouts: 0,
        statPoints: 0,
        speed: 50,
        power: 50,
        defense: 50,
        stamina: 50,
        careerBoutIndex: 0,
        careerDifficulty: "contender",
        careerRosterState: rs,
      } as any;
      setActiveFighter(tempFighter);
      setUiMode("rosterEdit");
    }
  };

  type EnemyRefinement = { offenseUnlocked?: boolean; defenseUnlocked?: boolean; fightIqUnlocked?: boolean; pressureFighter?: number; precisionStriker?: number; jabPower?: number; hookPower?: number; uppercutPower?: number; bruiser?: number; koArtist?: number; ironChin?: number; slippery?: number; guardMaster?: number; duckRecovery?: number; punchRolling?: number; fastTwitch?: number; heartRefinement?: number; chinHitter?: number; technician?: number; lifeDrain?: number };

  /**
   * Whether AI opponents fight with (and show) their refinement skills. Level 50
   * was the original rule, but a career also unlocks refinement by climbing to
   * rank 650, which is the condition the Bout Details panel keys off — the two
   * have to agree or the panel shows the opponent as all zeroes.
   */
  const careerRefinementUnlocked = (fighter: Fighter | null | undefined): boolean => {
    if (!fighter) return false;
    if ((fighter.level || 1) >= 50) return true;
    const rs = fighter.careerRosterState as CareerRosterState | null;
    return !!rs?.refinementPermanentlyUnlocked || (rs?.playerRank ?? 999) <= 650;
  };

  const buildEnemyRefinement = (refPoints: number, arch: Archetype | string): EnemyRefinement | undefined => {
    if (refPoints <= 0) return undefined;
    const ALL_SKILLS: (keyof EnemyRefinement)[] = [
      "jabPower", "hookPower", "uppercutPower", "bruiser", "koArtist",
      "ironChin", "slippery", "guardMaster", "duckRecovery", "punchRolling",
      "fastTwitch", "heartRefinement", "chinHitter", "technician", "lifeDrain",
      "pressureFighter", "precisionStriker",
    ];
    const ARCH_SKILLS: Record<string, (keyof EnemyRefinement)[]> = {
      BoxerPuncher: ["jabPower", "hookPower", "guardMaster", "fastTwitch"],
      OutBoxer:     ["fastTwitch", "slippery", "precisionStriker", "technician"],
      Brawler:      ["hookPower", "ironChin", "heartRefinement", "pressureFighter"],
      Swarmer:      ["jabPower", "heartRefinement", "pressureFighter", "fastTwitch"],
    };
    const archKeys = new Set(ARCH_SKILLS[arch] ?? ARCH_SKILLS["BoxerPuncher"]);
    const otherKeys = ALL_SKILLS.filter(k => !archKeys.has(k));

    const archBudget = Math.floor(refPoints * 0.70);
    const otherBudget = refPoints - archBudget;
    const archPerSkill = Math.min(100, Math.floor(archBudget / archKeys.size));

    const result: EnemyRefinement = { offenseUnlocked: true, defenseUnlocked: true, fightIqUnlocked: true };
    for (const k of archKeys) (result as Record<string, boolean | number>)[k] = archPerSkill;

    const otherPerSkillMax = Math.min(100, Math.floor(otherBudget / otherKeys.length));
    if (otherPerSkillMax > 0) {
      for (const k of otherKeys) {
        const pts = Math.floor(Math.random() * (otherPerSkillMax + 1));
        if (pts > 0) (result as Record<string, boolean | number>)[k] = pts;
      }
    }
    return result;
  };

  /** Every refinement a fighter can hold levels in. */
  const REFINEMENT_SKILL_KEYS: (keyof EnemyRefinement)[] = [
    "jabPower", "hookPower", "uppercutPower", "bruiser", "koArtist",
    "ironChin", "slippery", "guardMaster", "duckRecovery", "punchRolling",
    "fastTwitch", "heartRefinement", "chinHitter", "technician", "lifeDrain",
    "pressureFighter", "precisionStriker",
  ];
  const REFINEMENT_LEVEL_CAP = 100;
  /** Under this many spent points the mirror stays off and opponents fall back to their own refinement. */
  const REFINEMENT_MIRROR_MIN_TOTAL = 20;

  /**
   * Points the player is actually bringing into the ring — only the refinements
   * they have checked count. Unlock flags and the unspent pool are not levels,
   * and a level sitting on an unchecked refinement contributes nothing.
   */
  const playerRefinementTotal = (ref: SkillRefinement | null | undefined): number => {
    if (!ref) return 0;
    const active = activeRefinementsOnly(ref as unknown as Record<string, unknown>, true);
    let total = 0;
    for (const key of REFINEMENT_SKILL_KEYS) {
      const lvl = active[key as string];
      if (typeof lvl === "number" && lvl > 0) total += lvl;
    }
    return total;
  };

  /** How many refinements the player is bringing into the ring right now (0–5). */
  const playerActiveRefinementCount = (ref: SkillRefinement | null | undefined): number => {
    if (!ref) return 0;
    const active = activeRefinementsOnly(ref as unknown as Record<string, unknown>, true);
    return REFINEMENT_SKILL_KEYS.filter(k => {
      const lvl = active[k as string];
      return typeof lvl === "number" && lvl > 0;
    }).length;
  };

  /**
   * Sparring/Nightmare/Doghouse opponents mirror the player's refinement depth:
   * `pct` of everything the player has spent, scattered at random over every
   * refinement so the parts add back up to that share. Returns undefined when
   * the mirror is off — refinement still locked, or fewer than
   * REFINEMENT_MIRROR_MIN_TOTAL points spent — so the caller keeps its own
   * fallback behaviour.
   */
  const buildMirroredRefinement = (fighter: Fighter | null | undefined, pct: number, keyCount: number = MAX_ACTIVE_REFINEMENTS): EnemyRefinement | undefined => {
    if (!careerRefinementUnlocked(fighter)) return undefined;
    const count = Math.max(0, Math.min(MAX_ACTIVE_REFINEMENTS, Math.floor(keyCount)));
    // No keys to fill means no mirror at all — the minimum-spend floor below must
    // never be able to hand an opponent refinements the player is not bringing.
    if (count <= 0) return undefined;
    const spent = playerRefinementTotal(fighter?.skillRefinement as SkillRefinement | null | undefined);
    if (spent < REFINEMENT_MIRROR_MIN_TOTAL) return undefined;

    // The mirror concentrates into `count` keys, so the ceiling is theirs — any
    // budget left over once they are all capped is dropped rather than spilling
    // into a sixth refinement the opponent could not carry anyway.
    const target = Math.min(count * REFINEMENT_LEVEL_CAP, Math.round(spent * pct));
    if (target <= 0) return undefined;

    const keys = [...REFINEMENT_SKILL_KEYS];
    for (let i = keys.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [keys[i], keys[j]] = [keys[j], keys[i]];
    }
    const picked = keys.slice(0, count);

    // Random split, then hand the rounding remainder out one point at a time so
    // the distribution lands on the target exactly without breaching the cap.
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

    const result: EnemyRefinement = { offenseUnlocked: true, defenseUnlocked: true, fightIqUnlocked: true };
    picked.forEach((key, i) => {
      if (alloc[i] > 0) (result as Record<string, boolean | number>)[key as string] = alloc[i];
    });
    return result;
  };

  /** Share of the player's refinement total each sparring tier's partner mirrors. */
  const SPARRING_MIRROR_PCT: Record<string, number> = {
    champion: 0.90,
    elite: 0.85,
    contender: 0.75,
    journeyman: 0.60,
  };
  const DOGHOUSE_MIRROR_PCT = 1.0;

  const handleStartFight = (playerLevel: number, enemyLevel: number, name?: string, isQuick: boolean = false, enemyArch?: Archetype, careerAiDiff?: AIDifficulty, careerRoundLen?: number, eArm?: number, enemyName?: string, enemyColors?: FighterColors, overridePlayerColors?: FighterColors, overrideFighter?: Fighter, careerRounds?: number, careerSpeed?: TimerSpeed, enemyRosterId?: number, enemyRank?: number, rosterStats?: { power?: number; speed?: number; defense?: number; stamina?: number; focus?: number }) => {
    const fighter = overrideFighter || activeFighter;
    const rounds = isQuick ? maxRounds : (careerRounds || 3);
    const duration = isQuick ? roundDurationMins * 60 : (careerRoundLen || 3) * 60;
    const speed = isQuick ? timerSpeed : (careerSpeed || "normal" as TimerSpeed);
    const pArm = isQuick ? playerArmLength : 65;
    const enemyArmLen = isQuick ? enemyArmLength : (eArm || 65);
    const diff = isQuick ? aiDifficulty : (careerAiDiff || "contender");
    const tb = !isQuick && fighter
      ? (fighter.trainingBonuses || DEFAULT_TRAINING_BONUSES) as TrainingBonuses
      : undefined;
    const towel = isQuick ? towelStoppageEnabled : careerTowelStoppageEnabled;
    const mercy = isQuick ? true : careerRefStoppageEnabled;
    const practice = isQuick ? practiceMode : false;
    const record = isQuick ? recordInputs : true;
    const simMode = isQuick ? cpuVsCpu : false;
    const fightColors = overridePlayerColors || (!isQuick && fighter ? fighterToColors(fighter) : playerColors);
    const careerTier = !isQuick && careerAiDiff ? careerAiDiff : undefined;
    const sp = !isQuick && fighter ? (fighter.skillPoints as SkillPoints) : undefined;
    const ref = !isQuick && fighter ? (fighter.skillRefinement as SkillRefinement ?? undefined) : undefined;
    let enemySp: SkillPoints | undefined = undefined;
    if (!isQuick && rosterStats && rosterStats.power != null) {
      enemySp = {
        power: rosterStats.power ?? 0,
        speed: rosterStats.speed ?? 0,
        defense: rosterStats.defense ?? 0,
        stamina: rosterStats.stamina ?? 0,
        focus: rosterStats.focus ?? 0,
      };
    } else if (!isQuick && enemyLevel > 0) {
      // Level-appropriate fallback: derive stats from enemy level so a level-99
      // opponent always fights with ~198-per-stat rather than the player's own stats.
      const ls = Math.round(enemyLevel * 2);
      enemySp = { power: ls, speed: ls, defense: ls, stamina: ls, focus: Math.round(enemyLevel) };
    }
    resetAutoZoom();
    const boutCfg = loadXpConfig();
    // Career opponent stamina is scaled inside the engine: the same natural
    // pool the player gets (BASE_STAMINA ramp + staminaPool skill-point coef),
    // trimmed to a per-tier share. The old absolute 7.80/3.90 compensation
    // predates that share and was stacking on top of it, handing opponents
    // several times the player's tank. Only the tunable neural-network
    // multiplier rides through here now.
    const careerOfficialStaminaMult = (!isQuick && !isSparring) ? boutCfg.careerOpponentMult : 1;
    const refinementUnlocked = !isQuick && careerRefinementUnlocked(fighter);
    let enemyRef: EnemyRefinement | undefined = undefined;
    if (!isQuick && enemyRosterId != null && refinementUnlocked) {
      const rs = (fighter?.careerRosterState as CareerRosterState | null)?.roster;
      const enemyRosterFighter = rs?.find(f => f.id === enemyRosterId);
      if (enemyRosterFighter?.customRefinementSkills) {
        const skills = enemyRosterFighter.customRefinementSkills;
        if (Object.values(skills).some(v => v > 0)) {
          enemyRef = { offenseUnlocked: true, defenseUnlocked: true, fightIqUnlocked: true, ...skills } as EnemyRefinement;
        }
      } else if (enemyRosterFighter && (enemyRosterFighter.refPoints ?? 0) > 0) {
        enemyRef = buildEnemyRefinement(enemyRosterFighter.refPoints!, enemyArch ?? "BoxerPuncher");
      }
    }
    if (!isQuick && enemyRosterId != null) {
      const rsSP = (fighter?.careerRosterState as CareerRosterState | null)?.roster;
      const enemyFighterSP = rsSP?.find(f => f.id === enemyRosterId);
      if (enemyFighterSP?.customSkillPoints) {
        const csp = enemyFighterSP.customSkillPoints;
        if (Object.values(csp).some(v => v > 0)) {
          enemySp = { power: csp.power, speed: csp.speed, defense: csp.defense, stamina: csp.stamina, focus: csp.focus };
        }
      }
    }
    // Opponent mults use (!isQuick && !isSparring), which correctly includes Nightmare and Doghouse career bouts.
    const careerOfficialPowerMult = (!isQuick && !isSparring) ? boutCfg.careerOpponentPowerMult : 1;
    const careerOfficialSpeedMult = (!isQuick && !isSparring) ? boutCfg.careerOpponentSpeedMult : 1;
    const playerBoxingStance = (() => { try { return localStorage.getItem("handz_player_boxing_stance") === "southpaw" ? "southpaw" : "orthodox"; } catch { return "orthodox"; } })() as BoxingStance;
    const enemyBoxingStance = (() => {
      if (!isQuick && enemyRosterId != null && fighter) {
        const rs = (fighter.careerRosterState as CareerRosterState | null)?.roster;
        const rf = rs?.find(f => f.id === enemyRosterId);
        return rf?.boxingStance === "southpaw" ? "southpaw" : "orthodox";
      }
      return "orthodox";
    })() as BoxingStance;
    const newState = startFight(gameState, isQuick ? selectedArchetype : (fighter?.archetype as Archetype || selectedArchetype), playerLevel, enemyLevel, name, fightColors, isQuick, diff, rounds, duration, speed, pArm, enemyArmLen, enemyArch, enemyName, tb, false, towel, practice, record, simMode, enemyColors, false, careerTier, isQuick ? aiPowerMult : careerOfficialPowerMult, isQuick ? aiSpeedMult : careerOfficialSpeedMult, isQuick ? aiStaminaMult : careerOfficialStaminaMult, sp, enemySp, mercy, enemyRosterId, ref, enemyRef, false, enemyRank, false, undefined, playerBoxingStance, enemyBoxingStance);
    // Apply player career multipliers for all official career bouts (not quick, not sparring).
    // Nightmare and Doghouse are intentionally included — they are official career bouts.
    if (!isQuick && !isSparring) {
      const pStaminaMult = boutCfg.careerPlayerMult;
      const pPowerMult = boutCfg.careerPlayerPowerMult;
      const pSpeedMult = boutCfg.careerPlayerSpeedMult;
      if (pStaminaMult !== 1) {
        newState.player.stamina *= pStaminaMult;
        newState.player.maxStamina *= pStaminaMult;
        newState.player.maxStaminaCap *= pStaminaMult;
      }
      if (pPowerMult !== 1) {
        newState.player.damageMult *= pPowerMult;
      }
      if (pSpeedMult !== 1) {
        newState.player.moveSpeed *= pSpeedMult;
      }
      newState.boutPlayerStaminaMult = pStaminaMult;
      newState.boutPlayerPowerMult = pPowerMult;
      newState.boutPlayerSpeedMult = pSpeedMult;
    }
    if (enemySp) {
      newState.careerEnemySkillPoints = enemySp;
    }
    if (ref) {
      newState.playerRefinement = { ...ref };
    }
    if (enemyRef) {
      newState.careerEnemyRefinement = { ...enemyRef };
    }
    // Punch Endurance rides in as a post-setup modifier rather than yet another
    // startFight argument: the player's career value, and the opponent's own
    // roster entry. Quick fights, practice and anyone without an entry keep the
    // engine's floor.
    if (fighter && !isQuick) {
      const peRs = fighter.careerRosterState as CareerRosterState | null;
      const peEnemyEntry = enemyRosterId != null
        ? peRs?.roster.find(f => f.id === enemyRosterId)
        : undefined;
      // The AI's cost per drain is banded by rank like the rest of the roster, so
      // it reads off the opponent's own rank. Only the player has a heavy bag to
      // drill their own cost down below whatever the config hands out.
      applyPunchEndurance(newState, {
        player: punchEnduranceOf(peRs),
        enemy: peEnemyEntry?.punchEndurance,
        playerLoss: punchEnduranceLossOf(peRs),
        enemyLoss: getAiPunchEnduranceLossForRank(peEnemyEntry?.rank ?? peRs?.playerRank),
      });
      // The Reset buy-backs are the player's own gym work, so they come into
      // every bout they fight. Opponents carry none and fight untrained.
      applyResetTraining(newState, { player: resetTrainingOf(peRs), playerSpeed: resetSpeedBonusOf(peRs) });
      applySlipTraining(newState, autoSlipTrainedOf(peRs));
      applyPurePower(newState, peRs);
      // Drilling is cashed in on fight night: the list comes into a career bout
      // so its buffs are live, but recording is off — a bout never moves a
      // counter. Practice and Quick Fight are excluded above and get nothing.
      if (!practice) attachDrilledActions(newState, peRs?.drilledActions, false);
    }
    const effectiveCareerFight = isCareerFight || (!isQuick && careerAiDiff != null && !isSparring);
    // Tape study: a ranked opponent has already watched some of what the player
    // repeats and walks in with those answers prepared. Seeded off their roster
    // id, so the same opponent has studied the same card every time.
    if (fighter && effectiveCareerFight && !isQuick && !practice && enemyRank != null) {
      const studyRs = fighter.careerRosterState as CareerRosterState | null;
      applyAiPatternStudy(newState, studyRs?.aiPatternLibrary, enemyRosterId ?? enemyRank, enemyRank);
    }
    // Item boosts ride on top of the stat/refinement passes. Quick fights and
    // practice have no save behind them, so they get nothing.
    if (fighter && !isQuick && !practice) {
      applyItemFightMods(
        newState,
        getFightMods(withSavedInventory(fighter), fighter.careerRosterState as CareerRosterState | null, { sparring: isSparring }),
      );
      // Hold the armed boosts in escrow until this bout actually concludes.
      openFightBoostEscrow(fighter.id);
    }
    // Item Distribution: ranked career opponents bring their own boost kit,
    // rolled fresh for the bout from the odds configured for their rank band,
    // plus a chance at a keepsake the player has yet to collect (beating them
    // hands it over — see claimOpponentKeepsakes at fight end).
    if (effectiveCareerFight && !isSparring && !isQuick && !practice && enemyRank != null) {
      const invFighter = fighter ? withSavedInventory(fighter) : null;
      // Every keepsake already in the locker, however it got there — a save can
      // hold one it never recorded as received, and offering that back is a
      // keepsake the player watches walk in and can never claim. Null means no
      // save to check against, which skips the keepsake carry entirely.
      const ownedKeepsakes = invFighter ? heldKeepsakeIds(invFighter) : null;
      // Collection complete (every keepsake + every Lucky Coin): opponents are
      // free to wear any keepsakes their item count has room for.
      const oppItems = rollOpponentItems(
        enemyRank, undefined, undefined, ownedKeepsakes, hasAllKeepsakesAndCoins(invFighter),
      );
      if (Object.keys(oppItems).length > 0) {
        newState.opponentItems = oppItems;
        applyItemFightMods(newState, fightModsFromBoosts(boostsFromItemCounts(oppItems)), "opponent");
      }
    }
    // Equipment Upgrades. Applied last so the flat trunks pool lands on top of
    // the mode multipliers rather than being scaled by them. A career opponent
    // wears one level in all five slots; quick fights and practice have no save
    // behind them, so neither corner brings gear.
    if (fighter && !isQuick && !practice) {
      const eqOpponentLevel = (!isSparring && enemyRosterId != null)
        ? ((fighter.careerRosterState as CareerRosterState | null)?.roster.find(f => f.id === enemyRosterId)?.equipmentLevel ?? 0)
        : 0;
      applyFightEquipment(newState, {
        player: getEquipmentLevels(fighter),
        opponent: eqOpponentLevel > 0 ? uniformEquipmentLevels(eqOpponentLevel) : null,
      });
    }
    if (effectiveCareerFight || isSparring) {
      if (effectiveCareerFight) newState.careerFightMode = true;
      newState.showExpBar = showExpBar;
      if (fighter) { newState.playerCurrentXp = fighter.xp; newState.fightLiveXp = fighter.xp; }
      const rs = fighter?.careerRosterState as CareerRosterState | null;
      newState.careerXpMult = (rs && isChampBeaten(rs.roster) ? 1.0 : loadXpConfig().preChampMult) * loadXpConfig().careerMult;
      newState.canSurpassLevel100 = true;
      if (rs && (rs.savedChargeBars || rs.savedChargeCounters)) {
        newState.player.chargeMeterBars = rs.savedChargeBars || 0;
        newState.player.chargeMeterCounters = rs.savedChargeCounters || 0;
      }
      if (activeFighter) {
        setPreFightSnapshot(JSON.parse(JSON.stringify(activeFighter)));
      }
    }
    commitGameState(newState);
    const showRingWalk = effectiveCareerFight || (isQuick && !practice);
    if (showRingWalk) {
      const walkRoster = (fighter?.careerRosterState as CareerRosterState | null)?.roster;
      const walkEnemyEntry = enemyRosterId != null ? walkRoster?.find(f => f.id === enemyRosterId) : null;
      setRingWalkData({
        playerName: newState.player.name,
        enemyName: newState.enemy.name,
        playerColors: newState.player.colors,
        enemyColors: newState.enemy.colors,
        playerLevel: fighter?.level ?? newState.player.level ?? 1,
        playerWins: fighter?.wins ?? 0,
        playerLosses: fighter?.losses ?? 0,
        playerDraws: fighter?.draws ?? 0,
        playerKOs: fighter?.knockouts ?? 0,
        playerSp: sp ? { power: sp.power, speed: sp.speed, defense: sp.defense, stamina: sp.stamina, focus: sp.focus ?? 0 } : undefined,
        playerRefinement: newState.playerRefinement as Record<string, number> | undefined,
        enemyLevel: newState.enemy.level ?? enemyLevel,
        enemyWins: walkEnemyEntry?.wins ?? 0,
        enemyLosses: walkEnemyEntry?.losses ?? 0,
        enemyDraws: walkEnemyEntry?.draws ?? 0,
        enemyKOs: walkEnemyEntry?.knockouts ?? 0,
        enemySp: newState.careerEnemySkillPoints ? { power: newState.careerEnemySkillPoints.power, speed: newState.careerEnemySkillPoints.speed, defense: newState.careerEnemySkillPoints.defense, stamina: newState.careerEnemySkillPoints.stamina, focus: newState.careerEnemySkillPoints.focus ?? 0 } : undefined,
        enemyRefinement: newState.careerEnemyRefinement as Record<string, number> | undefined,
        enemyRank: walkEnemyEntry?.rank,
        playerRank: (fighter?.careerRosterState as CareerRosterState | null)?.playerRank,
        playerNickname: fighter?.nickname ?? undefined,
      });
      setUiMode("ringWalk");
    } else {
      setUiMode("fighting");
    }
  };

  const handleConfirmClass = () => {
    if (isCareerFight && activeFighter && careerOpponentId) {
      const rosterState = activeFighter.careerRosterState as CareerRosterState | null;
      if (!rosterState) return;
      const oppState = rosterState.roster.find(f => f.id === careerOpponentId);
      if (!oppState) return;
      // Building the opponent (refinement spread, stat block, item kit) and the
      // initial fight state used to happen inline on the click, so the app froze
      // between the button press and the ring walk. It now runs in phases behind
      // the loading screen.
      void runLoader({
        title: "Making The Walk",
        subtitle: "Fight Night",
        minDurationMs: 700,
        phases: [
          { label: "Weighing in", weight: 1, run: () => {} },
          { label: "Sizing up the opponent", weight: 3, run: careerFightSetupJob(activeFighter, oppState) },
        ],
      });
      return;
    }
    handleConfirmClassNonCareer();
  };

  /** Builds the career opponent and hands off to the fight, phase by phase. */
  const careerFightSetupJob = (activeFighter: Fighter, oppState: RosterFighterState) => function* (): Generator<string, void, void> {
      const opp = buildOpponentFromRoster(oppState);
      if (!opp) return;

      const playerName = activeFighter.firstName
        ? (activeFighter.nickname
          ? `${activeFighter.firstName} "${activeFighter.nickname}" ${activeFighter.lastName}`
          : `${activeFighter.firstName} ${activeFighter.lastName}`)
        : activeFighter.name;

      const oppColors = getRosterFighterColors(oppState);
      const enemyFighterColors: FighterColors = {
        gloves: oppColors.gloves,
        gloveTape: oppColors.gloveTape,
        trunks: oppColors.trunks,
        shoes: oppColors.shoes,
        skin: oppColors.skin,
        socks: oppColors.socks,
        laces: oppColors.laces,
        soles: oppColors.soles,
        waistStripe: oppColors.waistStripe,
      };

      let savedRoundLen = 3;
      let savedTimerSpeed: TimerSpeed = "normal";
      try {
        const rl = localStorage.getItem("handz_career_round_len");
        if (rl) savedRoundLen = parseInt(rl) || 3;
        const ts = localStorage.getItem("handz_career_timer_speed");
        if (ts === "fast") savedTimerSpeed = "fast";
      } catch {}

      let careerRounds = oppState.rank === 1 ? 12 : KEY_FIGHTER_IDS.includes(oppState.id) ? 6 : 3;
      try {
        const savedNumRounds = localStorage.getItem("handz_career_num_rounds");
        if (savedNumRounds && savedNumRounds !== "auto") {
          const parsed = parseInt(savedNumRounds);
          if (parsed === 3 || parsed === 6 || parsed === 12) careerRounds = parsed;
        }
      } catch {}

      yield "Taping the hands";

      handleStartFight(
        activeFighter.level,
        opp.level,
        playerName,
        false,
        opp.archetype,
        opp.aiDifficulty,
        savedRoundLen,
        opp.armLength,
        opp.name,
        enemyFighterColors,
        fighterToColors(activeFighter),
        activeFighter,
        careerRounds,
        savedTimerSpeed,
        opp.rosterId,
        oppState.rank,
        { power: opp.statPower, speed: opp.statSpeed, defense: opp.statDefense, stamina: opp.statStamina, focus: opp.statFocus }
      );
  };

  /** Quick Fight / Nightmare setup — light enough to stay on the click. */
  const handleConfirmClassNonCareer = () => {
    if (quickFightNightmare) {
      setIsNightmare(true);
      setIsSparring(false);
      setIsCareerFight(false);
      setActiveFighter(null);

      const nmArchetypes: Archetype[] = ["BoxerPuncher", "OutBoxer", "Brawler", "Swarmer"];
      const firstArch = nmArchetypes[Math.floor(Math.random() * nmArchetypes.length)];
      const firstArm = Math.round(58 + Math.random() * 17);

      resetAutoZoom();
      const newState = startFight(
        gameState,
        selectedArchetype,
        quickFightPlayerLevel,
        quickFightEnemyLevel,
        undefined,
        playerColors,
        true,
        aiDifficulty,
        1,
        roundDurationMins * 60,
        timerSpeed,
        playerArmLength,
        firstArm,
        firstArch,
        undefined,
        undefined,
        false,
        false,
        false,
        false,
        false,
        undefined,
        true,
        undefined,
        aiPowerMult,
        aiSpeedMult,
        aiStaminaMult,
        undefined,
        undefined,
        false,
        undefined,
        undefined,
        undefined,
        true
      );
      activateNightmareMode(newState, Math.max(1, quickFightPlayerLevel - 15), aiDifficulty);
      commitGameState(newState);
      setUiMode("fighting");
      return;
    } else {
      let rosterOpp;
      if (selectedRosterFighters.length > 0) {
        const pick = selectedRosterFighters[Math.floor(Math.random() * selectedRosterFighters.length)];
        const name = pick.nickname
          ? `${pick.firstName} "${pick.nickname}" ${pick.lastName}`
          : `${pick.firstName} ${pick.lastName}`;
        rosterOpp = {
          rosterId: pick.id,
          name,
          archetype: pick.archetype,
          armLength: Math.round(58 + Math.random() * 17),
        };
      } else {
        const rand = getRandomQuickFightOpponent(aiDifficulty);
        rosterOpp = { rosterId: rand.rosterId, name: rand.name, archetype: rand.archetype, armLength: rand.armLength };
      }
      const qfColors = getQuickFightColorsForRosterId(rosterOpp.rosterId);
      const qfEnemyColors: FighterColors = {
        gloves: qfColors.gloves,
        gloveTape: qfColors.gloveTape,
        trunks: qfColors.trunks,
        shoes: qfColors.shoes,
        skin: qfColors.skin,
        socks: qfColors.socks,
        laces: qfColors.laces,
        soles: qfColors.soles,
        waistStripe: qfColors.waistStripe,
      };
      handleStartFight(
        quickFightPlayerLevel,
        quickFightEnemyLevel,
        undefined,
        true,
        rosterOpp.archetype,
        undefined,
        undefined,
        rosterOpp.armLength,
        rosterOpp.name,
        qfEnemyColors,
        undefined,
        undefined,
        undefined,
        undefined,
        rosterOpp.rosterId
      );
    }
  };

  const handleNextRound = () => {
    const newState = startNextRound({ ...gameState });
    commitGameState(newState);
    setUiMode("fighting");
  };

  const handleDoghouseEarlyFinish = () => {
    if (!activeFighter || !isDoghouse) return;
    // One payout per session. The button lives on the pause overlay, which
    // stays mounted for a beat after the first click, so without this latch a
    // second click banks a second full haul.
    if (doghouseEarlyFinishedRef.current) return;
    doghouseEarlyFinishedRef.current = true;

    const dhOpponentsDefeated = gameState.doghouseOpponentsDefeated ?? 0;

    // Level-gap penalty (same logic as fight-end handler)
    const efRs = activeFighter.careerRosterState as CareerRosterState | null;
    const efGapOpp = efRs?.selectedOpponentId != null ? efRs.roster.find(f => f.id === efRs.selectedOpponentId) : null;
    const efOppLevel = efGapOpp?.level ?? activeFighter.level;
    const efGap = Math.max(0, activeFighter.level - efOppLevel);
    const efXpGapMult = efGap >= 5 ? Math.max(0.05, 1 - 0.01 * efGap) : 1;

    // Finishing early pays the same way a full round does: XP and crates only.

    const dhOldStats = (activeFighter.careerStats || DEFAULT_CAREER_STATS) as CareerStats;
    const sparringBase = 400 * (activeFighter.level / 100) * 0.5 * 20 * 4 * 0.7;
    const efItemXpMult = getGymSparringXpMult(withSavedInventory(activeFighter), efRs);
    const dhXpGained = Math.max(1, Math.floor(sparringBase * 1.75 * 1.0 * 0.32 * Math.pow(1.2, dhOpponentsDefeated) * efXpGapMult * efItemXpMult));
    const dhNewCareerStats: CareerStats = {
      ...dhOldStats,
      totalKnockdownsGiven: dhOldStats.totalKnockdownsGiven + (gameState.player.knockdownsGiven ?? 0),
      lifetimeXp: dhOldStats.lifetimeXp + dhXpGained,
    };

    const dhMidFightLevel = gameState.midFightLevelUps > 0 ? gameState.playerLevel : activeFighter.level;
    const dhMidFightXp = gameState.midFightLevelUps > 0 ? gameState.playerCurrentXp : activeFighter.xp;
    let dhNewXp = dhMidFightXp + dhXpGained;
    let dhNewLevel = dhMidFightLevel;
    const dhRs = withSavedPatternLibrary(activeFighter.id, activeFighter.careerRosterState as CareerRosterState | null);
    while (dhNewXp >= xpToNextLevel(dhNewLevel) && dhNewLevel < 1000) {
      dhNewXp -= xpToNextLevel(dhNewLevel);
      dhNewLevel++;
    }
    if (dhNewLevel >= 1000) {
      dhNewLevel = 1000;
      dhNewXp = Math.min(dhNewXp, xpToNextLevel(1000) - 1);
    }

    runStatPointCheck(activeFighter);

    let dhUpdatedRosterState = dhRs;
    // Bailing out early still banks whatever was drilled on the way, and it
    // still has to land before the weekly simulation below.
    dhUpdatedRosterState = withGymWorkFromBout(dhUpdatedRosterState, gameState);
    // Same per-opponent snap time the full round pays, for both arms below.
    const dhSnapSessions = sparSessionsForSeconds(RESET_SPEED_PER_DOGHOUSE_WIN * dhOpponentsDefeated);
    if (dhUpdatedRosterState) {
      const dhPrevTrainings = dhUpdatedRosterState.trainingsSinceLastWeek ?? 0;
      if (dhPrevTrainings >= 1) {
        const dhWeekSeed = Date.now();
        const dhInCamp2 = dhUpdatedRosterState.selectedOpponentId != null && (dhUpdatedRosterState.prepWeeksRemaining ?? 0) > 0;
        // Finishing early still completes a sparring session, and still pays
        // the snap by the opponents actually put away.
        dhUpdatedRosterState = simulateWeek(stampSparWeek(activeFighter.id, { ...dhUpdatedRosterState, weeklyBonus: null }, dhSnapSessions), dhWeekSeed, activeFighter.careerDifficulty, dhNewLevel, true, refinementTotal(activeFighter.skillRefinement as Record<string, number> | null), getEquipmentLevels(activeFighter));
        dhUpdatedRosterState = { ...dhUpdatedRosterState, trainingsSinceLastWeek: 0 };
        const dhPRating = dhUpdatedRosterState.playerRatingScore ?? 1000;
        const dhNewRank = dhInCamp2
          ? (dhUpdatedRosterState.playerRank ?? 701)
          : Math.max(computePlayerRankFromRating(dhUpdatedRosterState.roster, dhPRating, dhUpdatedRosterState.rank1HolderId), dhUpdatedRosterState.playerRank ?? 701);
        const dhNewWeeklyBonus = generateWeeklyBonus(activeFighter.wins || 0, activeFighter.careerStats, dhUpdatedRosterState);
        dhUpdatedRosterState = { ...dhUpdatedRosterState, playerRank: dhNewRank, weeklyBonus: dhNewWeeklyBonus ?? null };
      } else {
        const dhNextBonus = generateWeeklyBonus(activeFighter.wins || 0, activeFighter.careerStats, dhUpdatedRosterState);
        dhUpdatedRosterState = stampSparWeek(activeFighter.id, { ...dhUpdatedRosterState, trainingsSinceLastWeek: 1, weeklyBonus: dhNextBonus ?? null }, dhSnapSessions);
      }
      // Mark Doghouse as used for this opponent — covers early finish the same as normal completion
      dhUpdatedRosterState = { ...dhUpdatedRosterState, lastDoghouseOpponentId: dhUpdatedRosterState.selectedOpponentId ?? null };
      // Conditioning: a point per opponent put away. The latch at the top of
      // this handler is what keeps the run from being paid twice.
      dhUpdatedRosterState = grantPunchEndurance(activeFighter.id, dhUpdatedRosterState, dhOpponentsDefeated);
      dhUpdatedRosterState = bankSlipsLanded(
        dhUpdatedRosterState,
        localSaves.getFighter(activeFighter.id)?.careerRosterState as CareerRosterState | null,
        slipsLandedOf(liveStateRef.current ?? gameState),
      );
      dhUpdatedRosterState = grantDefensiveMasteryBonus(
        dhUpdatedRosterState,
        localSaves.getFighter(activeFighter.id)?.careerRosterState as CareerRosterState | null,
        doghousePerfectBlocksBankedOf(liveStateRef.current ?? gameState) * MASTERY_PCT_PER_PERFECT_BLOCK_DOGHOUSE,
      );
      if (dhOpponentsDefeated >= 1) {
        dhUpdatedRosterState = grantSlipTraining(
          dhUpdatedRosterState,
          localSaves.getFighter(activeFighter.id)?.careerRosterState as CareerRosterState | null,
          slipsLandedOf(liveStateRef.current ?? gameState) * SLIP_TRAINING_PCT_PER_SLIP_DOGHOUSE,
        );
      }
    }

    // Finishing early still ends the bout — burn the one-fight boosts it used
    // and the sparring ones it was paid for, the Import Ticket aside.
    closeFightBoostEscrow();
    const dhSaved = withSavedInventory(activeFighter);
    let dhEarlyInventory =
      consumeBoostsFor(dhSaved, ["fight", "sparring"], dhUpdatedRosterState, {
        sparring: true,
        skipPerks: ["importSparring"],
      }) ?? pruneBoosts(dhSaved, dhUpdatedRosterState);

    // Bailing out early still banks a chest per opponent already put away.
    pendingCratesRef.current = null;
    const dhEarlyHaul = rollDoghouseChests(dhSaved, dhEarlyInventory, dhOpponentsDefeated, dhUpdatedRosterState?.playerRank ?? null);
    if (dhEarlyHaul.inventory) dhEarlyInventory = dhEarlyHaul.inventory;
    const dhEarlyDiamonds = DOGHOUSE_DIAMONDS_PER_WIN * dhOpponentsDefeated;
    const dhEarlyNewDiamonds = (localSaves.getFighter(activeFighter.id)?.diamonds ?? activeFighter.diamonds ?? 0) + dhEarlyDiamonds;

    updateFighterMutation.mutate({
      id: activeFighter.id,
      data: {
        xp: dhNewXp,
        level: dhNewLevel,
        careerStats: dhNewCareerStats,
        careerRosterState: dhUpdatedRosterState,
        itemInventory: dhEarlyInventory,
        ...(dhEarlyDiamonds > 0 ? { diamonds: dhEarlyNewDiamonds } : {}),
      },
    });
    setActiveFighter(prev => prev ? {
      ...prev,
      xp: dhNewXp,
      level: dhNewLevel,
      careerStats: dhNewCareerStats,
      careerRosterState: dhUpdatedRosterState,
      itemInventory: dhEarlyInventory,
      ...(dhEarlyDiamonds > 0 ? { diamonds: dhEarlyNewDiamonds } : {}),
    } : null);

    const dhPlaystyle = extractPlayerPlaystyle(gameState);
    savePlayerPlaystyle(activeFighter.id, dhPlaystyle);

    // Finishing early is still a finish — the fee comes due with the payout.
    settleSparringSessionFee();

    // Reveal only what actually committed with the round above.
    if (dhEarlyHaul.crates.length > 0) pendingCratesRef.current = dhEarlyHaul.crates;

    // Drop out of the pause menu on the way to the results overlay — leaving it
    // up hides the very screen the payout is being shown on.
    soundEngine.stopCrowdAmbient();
    patchLiveState(prev => ({
      ...prev,
      phase: "fightEnd",
      fightWinner: "player",
      fightResult: "Decision",
      isPaused: false,
      pauseAction: null,
      pauseBoutDetailsTab: false,
      pauseControlsTab: false,
      pauseSoundTab: false,
    }));
    setUiMode("fightEnd");
  };

  const handleContinue = () => {
    soundEngine.stopCrowdAmbient();
    const wasTutorial = isTutorialFight;
    const currentTutorialStage = tutorialStage;
    const tutorialWon = gameState.fightWinner === "player";
    commitGameState(createInitialState());
    setPreFightSnapshot(null);
    if (wasTutorial) {
      setIsTutorialFight(false);
      if (tutorialWon) {
        if (isCareerTutorial) {
          if (currentTutorialStage < 3) {
            const next = currentTutorialStage + 1;
            setTutorialStage(next);
            startTutorialFight(next);
          } else {
            setIsCareerTutorial(false);
            careerTutorialInfoRef.current = null;
            setUiMode("career");
          }
          return;
        }
        const newCompleted = tutorialCompletedStages.includes(currentTutorialStage)
          ? tutorialCompletedStages
          : [...tutorialCompletedStages, currentTutorialStage];
        setTutorialCompletedStages(newCompleted);
        try { localStorage.setItem("handz_tutorial_completed_stages", JSON.stringify(newCompleted)); } catch {}
        if (newCompleted.includes(1) && newCompleted.includes(2) && newCompleted.includes(3)) {
          setUiMode("tutorialComplete");
        } else {
          setUiMode("tutorial");
        }
        return;
      } else {
        if (isCareerTutorial) {
          setIsCareerTutorial(false);
          careerTutorialInfoRef.current = null;
          setUiMode("career");
        } else {
          startTutorialFight(currentTutorialStage);
        }
        return;
      }
    }
    const wasSparring = isSparring;
    const wasCareer = isCareerFight;
    const wasNightmare = isNightmare;
    const wasDoghouse = isDoghouse;
    // Crates won by this fight — the reveals overlay whichever screen comes next.
    if (pendingCratesRef.current) {
      setCrateReveal({ queue: pendingCratesRef.current, index: 0 });
      pendingCratesRef.current = null;
    }
    setIsSparring(false);
    setIsNightmare(false);
    setIsDoghouse(false);
    setIsCareerFight(false);
    setTrainingType(null);
    setCareerOpponentId(null);
    nightmareResultRef.current = null;
    if (wasNightmare && pendingTrainingAlloc) {
      setUiMode("trainingAllocate");
    } else if (wasNightmare) {
      setUiMode(activeFighter ? "career" : "menu");
    } else if (wasDoghouse && pendingTrainingAlloc) {
      setAllocShowsRefinement(false);
      setUiMode("trainingAllocate");
    } else if (wasDoghouse) {
      setUiMode(activeFighter ? "career" : "menu");
    } else if (wasSparring && deferredMilestoneRef.current) {
      const data = deferredMilestoneRef.current;
      deferredMilestoneRef.current = null;
      setStatUnlockPending(data);
      setUiMode("career");
    } else if (wasSparring && pendingTrainingAlloc) {
      setAllocShowsRefinement(false);
      setUiMode("trainingAllocate");
    } else if (wasSparring && deferredSparSimNewsRef.current) {
      const news = deferredSparSimNewsRef.current;
      deferredSparSimNewsRef.current = null;
      setSimulationNews(news);
      setUiMode("simulating");
    } else if (wasCareer && pendingTrainingAlloc) {
      setAllocShowsRefinement(false);
      setUiMode("trainingAllocate");
    } else if (wasCareer && champDefeatSimNewsRef.current) {
      const news = champDefeatSimNewsRef.current;
      champDefeatSimNewsRef.current = null;
      setSimulationNews(news);
      setUiMode("simulating");
    } else if (wasCareer || wasSparring) {
      setUiMode("career");
      if ((wasCareer || wasSparring) && deferredFightMilestonesRef.current?.length) {
        setPendingMilestones(deferredFightMilestonesRef.current);
        deferredFightMilestonesRef.current = null;
      }
    } else {
      setUiMode("menu");
    }
  };

  // Enter advances the overlays that don't own their own button component: the
  // Nightmare result card and the milestone popup. Priorities keep the
  // topmost overlay the one that answers when several are stacked.
  useEnterKey(handleContinue, { enabled: uiMode === "fightEnd" && gameState.nightmareMode });
  useEnterKey(
    () => setPendingMilestones(prev => prev.slice(1)),
    { enabled: pendingMilestones.length > 0, priority: ENTER_PRIORITY.milestone },
  );

  const fighterToColors = (fighter: Fighter): FighterColors => {
    const gc = (fighter.gearColors || DEFAULT_GEAR_COLORS) as GearColors;
    // The Spacial finish paints over the saved gear colours without replacing
    // them, so taking it off brings the fighter's own colours straight back.
    return applySpacialGear({
      gloves: gc.gloves,
      gloveTape: gc.gloveTape,
      trunks: gc.trunks,
      shoes: gc.shoes,
      skin: fighter.skinColor || "#e8c4a0",
      headgear: gc.headgear || DEFAULT_GEAR_COLORS.headgear,
      socks: gc.socks || DEFAULT_GEAR_COLORS.socks,
      // Left undefined when unset so the renderer keeps deriving them from the
      // shoe and trunk colours.
      laces: gc.laces,
      soles: gc.soles,
      waistStripe: gc.waistStripe,
    }, spacialSelectionOf(fighter));
  };

  const handleSelectCareerFighter = (fighter: Fighter, opponentId: number) => {
    setActiveFighter(fighter);
    setSelectedArchetype(fighter.archetype as Archetype);
    setIsCareerFight(true);
    setCareerOpponentId(opponentId);

    const careerColors = fighterToColors(fighter);
    setPlayerColors(careerColors);

    const rosterState = fighter.careerRosterState as CareerRosterState | null;
    if (!rosterState) return;
    const oppState = rosterState.roster.find(f => f.id === opponentId);
    if (!oppState) return;
    const opp = buildOpponentFromRoster(oppState);
    if (!opp) return;

    const playerName = fighter.firstName
      ? (fighter.nickname
        ? `${fighter.firstName} "${fighter.nickname}" ${fighter.lastName}`
        : `${fighter.firstName} ${fighter.lastName}`)
      : fighter.name;

    const oppColors = getRosterFighterColors(oppState);
    const enemyFighterColors: FighterColors = {
      gloves: oppColors.gloves,
      gloveTape: oppColors.gloveTape,
      trunks: oppColors.trunks,
      shoes: oppColors.shoes,
      skin: oppColors.skin,
      socks: oppColors.socks,
      laces: oppColors.laces,
      soles: oppColors.soles,
      waistStripe: oppColors.waistStripe,
    };

    let savedRoundLen2 = fighter.roundLengthMins || 3;
    try {
      const rl2 = localStorage.getItem("handz_career_round_len");
      if (rl2) savedRoundLen2 = parseInt(rl2) || savedRoundLen2;
    } catch {}

    let careerRounds2 = oppState.rank === 1 ? 12 : KEY_FIGHTER_IDS.includes(oppState.id) ? 6 : 3;
    try {
      const savedNumRounds = localStorage.getItem("handz_career_num_rounds");
      if (savedNumRounds && savedNumRounds !== "auto") {
        const parsed = parseInt(savedNumRounds);
        if (parsed === 3 || parsed === 6 || parsed === 12) careerRounds2 = parsed;
      }
    } catch {}

    handleStartFight(
      fighter.level,
      opp.level,
      playerName,
      false,
      opp.archetype,
      opp.aiDifficulty,
      savedRoundLen2,
      opp.armLength,
      opp.name,
      enemyFighterColors,
      careerColors,
      fighter,
      careerRounds2,
      undefined,
      opp.rosterId,
      oppState.rank,
      { power: opp.statPower, speed: opp.statSpeed, defense: opp.statDefense, stamina: opp.statStamina, focus: opp.statFocus }
    );
  };

  const handleCreateFighter = (data: {
    firstName: string;
    nickname: string;
    lastName: string;
    archetype: Archetype;
    careerDifficulty: AIDifficulty;
    roundLengthMins: number;
    skinColor: string;
    gearColors: GearColors;
    boxingStance: "orthodox" | "southpaw";
  }) => {
    const displayName = data.nickname
      ? `${data.firstName} "${data.nickname}" ${data.lastName}`
      : `${data.firstName} ${data.lastName}`;

    const rosterState = initRosterState(displayName + Date.now(), data.careerDifficulty);
    try { localStorage.setItem("handz_player_boxing_stance", data.boxingStance); } catch {}
    // A brand-new career starts from zero progress. Items, item effects and
    // training high scores ride on the fighter record, which is brand new here;
    // clearCrossSaveProgress wipes the gym levels, playstyle profile and other
    // browser-level leftovers that would otherwise carry over.
    localSaves.clearCrossSaveProgress();

    createFighterMutation.mutate({
      name: displayName,
      firstName: data.firstName,
      nickname: data.nickname,
      lastName: data.lastName,
      archetype: data.archetype,
      careerDifficulty: data.careerDifficulty,
      roundLengthMins: data.roundLengthMins,
      skinColor: data.skinColor,
      gearColors: data.gearColors,
      careerRosterState: rosterState,
    });
  };

  const handleStartNightmare = (fighter: Fighter) => {
    // Nightmare has no per-camp limit any more — it is bought by the session,
    // and the fee is taken when the run pays out rather than at the door.
    if (!beginSparringSession(fighter, "nightmare")) return;
    setActiveFighter(fighter);
    setTrainingType(null);
    setIsNightmare(true);
    setIsSparring(false);
    setIsCareerFight(false);
    setPreFightSnapshot(fighter);

    const playerName = fighter.firstName
      ? (fighter.nickname
        ? `${fighter.firstName} "${fighter.nickname}" ${fighter.lastName}`
        : `${fighter.firstName} ${fighter.lastName}`)
      : fighter.name;

    const careerColors = fighterToColors(fighter);
    setPlayerColors(careerColors);

    const tb = (fighter.trainingBonuses || DEFAULT_TRAINING_BONUSES) as TrainingBonuses;
    const nmArchetypes: Archetype[] = ["BoxerPuncher", "OutBoxer", "Brawler", "Swarmer"];
    const firstArch = nmArchetypes[Math.floor(Math.random() * nmArchetypes.length)];
    const firstArm = Math.round(58 + Math.random() * 17);
    const nmPlayerSp = fighter.skillPoints as SkillPoints | null;

    // Refinement: the first Nightmare opponent carries one ladder rung (2%) of
    // everything the player has spent, rounded up, scattered at random over the
    // skills. Each spawn after it is another rung deeper (engine side), so the
    // queue climbs to a full mirror of the player at rung 50. Refinement still
    // locked means none of them get any.
    const nmPlayerRef = fighter.skillRefinement as SkillRefinement | undefined;
    const nmPlayerRefTotal = careerRefinementUnlocked(fighter) ? playerRefinementTotal(nmPlayerRef) : 0;
    // The ladder brings exactly as many refinements as the player is bringing,
    // at random, with the player's active total spread across that many keys —
    // so the strength stays comparable rather than ballooning as it concentrates.
    // A player with none active faces opponents with none.
    const nmKeyCount = careerRefinementUnlocked(fighter) ? playerActiveRefinementCount(nmPlayerRef) : 0;
    const nmRefBudget = nmKeyCount > 0 ? nightmareRefinementBudgetFor(nmPlayerRefTotal, 1) : 0;
    const nmEnemyRef: EnemyRefinement | undefined = nmRefBudget > 0
      ? { offenseUnlocked: true, defenseUnlocked: true, fightIqUnlocked: true, ...spreadRefinementPoints(nmRefBudget, nmKeyCount) } as EnemyRefinement
      : undefined;

    resetAutoZoom();
    const newState = startFight(
      gameState,
      fighter.archetype as Archetype,
      fighter.level,
      fighter.level,
      playerName,
      careerColors,
      false,
      "champion",
      1,
      180,
      "normal" as TimerSpeed,
      65,
      firstArm,
      firstArch,
      undefined,
      tb,
      false,
      false,
      false,
      false,
      false,
      undefined,
      true,
      undefined,
      1,
      1,
      1,
      nmPlayerSp || undefined,
      undefined,
      false,
      undefined,
      nmPlayerRef,
      nmEnemyRef,
      true
    );
    if (nmPlayerRef) newState.playerRefinement = { ...nmPlayerRef };
    // Mirror the opponent's refinement onto the state the Bout Details panel
    // reads — without this the pause screen shows the AI as all zeroes even
    // though the fight is using these values.
    if (nmEnemyRef) newState.careerEnemyRefinement = { ...nmEnemyRef } as Record<string, number>;
    const rs = fighter.careerRosterState as CareerRosterState | null;
    // Nightmare runs on the sparring flags, so it gets the sparring-legal boosts.
    applyItemFightMods(newState, getFightMods(withSavedInventory(fighter), rs, { sparring: true }));
    // The player's gym conditioning carries into the run. Its partners have no
    // roster entry, so they throw at the floor and pay the cost the player's own
    // division pays — the cost is config, not a value generated onto a fighter.
    applyPunchEndurance(newState, {
      player: punchEnduranceOf(rs),
      playerLoss: punchEnduranceLossOf(rs),
      enemyLoss: getAiPunchEnduranceLossForRank(rs?.playerRank),
    });
    applyResetTraining(newState, { player: resetTrainingOf(rs), playerSpeed: resetSpeedBonusOf(rs) });
    applySlipTraining(newState, autoSlipTrainedOf(rs));
    applyPurePower(newState, rs);
    // Nightmare is gym work: the drilled list comes in and counters may move.
    attachDrilledActions(newState, rs?.drilledActions, true);
    openFightBoostEscrow(fighter.id);
    newState.careerXpMult = (rs && isChampBeaten(rs.roster) ? 1.0 : loadXpConfig().preChampMult) * loadXpConfig().careerMult;
    newState.canSurpassLevel100 = true;
    newState.showExpBar = showExpBar;
    newState.playerCurrentXp = fighter.xp;
    newState.fightLiveXp = fighter.xp;
    activateNightmareMode(newState, Math.max(1, fighter.level - 15), "champion", nmRefBudget, nmPlayerRefTotal);
    // Every rung of the ladder wears a tenth of the player's own equipment.
    // After activateNightmareMode, which rescales the opening enemy's stamina
    // pool — every replacement rung is equipped after its own scaling too, so
    // the trunks have to land on the same side of it for the first one.
    {
      const nmPlayerEquip = getEquipmentLevels(fighter);
      applyFightEquipment(newState, {
        player: nmPlayerEquip,
        opponent: scaleEquipmentLevels(nmPlayerEquip, NIGHTMARE_EQUIPMENT_SHARE),
      });
    }
    // After activateNightmareMode, which sets the themed floor colour itself.
    newState.ringColors = fighter.ringColors ? ringColorsOf(fighter) : undefined;
    newState.gymRingName = gymLookOf(localSaves.getFighter(fighter.id) ?? fighter).name ?? null;
    commitGameState(newState);
    setUiMode("fighting");
  };

  const handleStartDoghouse = (fighter: Fighter) => {
    setDoghousePendingFighter(fighter);
    setActiveFighter(fighter);
    setUiMode("doghouseSetup");
  };

  const handleConfirmDoghouse = (fighter: Fighter, durationSecs: number) => {
    doghouseEarlyFinishedRef.current = false;
    // The fee is only owed once the round pays out; entering just has to prove
    // the player can cover it.
    if (!beginSparringSession(fighter, "doghouse")) { setUiMode("career"); return; }
    setActiveFighter(fighter);
    setTrainingType(null);
    setIsDoghouse(true);
    setIsSparring(true);
    setIsNightmare(false);
    setIsCareerFight(false);
    setPreFightSnapshot(fighter);

    const playerName = fighter.firstName
      ? (fighter.nickname
        ? `${fighter.firstName} "${fighter.nickname}" ${fighter.lastName}`
        : `${fighter.firstName} ${fighter.lastName}`)
      : fighter.name;

    const careerColors = fighterToColors(fighter);
    setPlayerColors(careerColors);

    const tb = (fighter.trainingBonuses || DEFAULT_TRAINING_BONUSES) as TrainingBonuses;

    const rosterState = fighter.careerRosterState as CareerRosterState | null;
    let dhPartnerName = "Sparring Partner";
    let dhPartnerArch: Archetype | undefined = undefined;
    let dhPartnerArm = 65;
    let dhPartnerColors: FighterColors | undefined = undefined;
    let dhPartnerRosterId: number | undefined = undefined;

    const dhAvailable = rosterState
      ? rosterState.roster.filter(f => !f.retired && f.active && f.id !== rosterState.selectedOpponentId)
      : [];
    if (dhAvailable.length > 0) {
      const dhPartner = dhAvailable[Math.floor(Math.random() * dhAvailable.length)];
      dhPartnerName = dhPartner.name;
      dhPartnerArch = dhPartner.archetype as Archetype;
      dhPartnerArm = dhPartner.armLength || 65;
      dhPartnerRosterId = dhPartner.id;
      const sc = getRosterFighterColors(dhPartner);
      dhPartnerColors = {
        gloves: sc.gloves,
        gloveTape: sc.gloveTape,
        trunks: sc.trunks,
        shoes: sc.shoes,
        skin: sc.skin,
        socks: sc.socks,
        laces: sc.laces,
        soles: sc.soles,
        waistStripe: sc.waistStripe,
      };
    }

    // Reference opponent: current camp selected, else most recently beaten
    const campOppState = rosterState && rosterState.selectedOpponentId != null
      ? rosterState.roster.find(f => f.id === rosterState.selectedOpponentId)
      : null;
    const refOppState = campOppState ?? (() => {
      const beaten = rosterState?.roster.filter(f => f.beatenByPlayer) ?? [];
      if (!beaten.length) return null;
      return beaten.reduce((best, f) =>
        (f.lastFightWeek ?? 0) > (best.lastFightWeek ?? 0) ? f : best, beaten[0]);
    })();

    const dhSp = fighter.skillPoints as SkillPoints | null;
    const clamp = (v: number) => Math.max(0, Math.min(1000, v));
    let dhEnemySp: SkillPoints;
    if (refOppState && refOppState.statPower != null) {
      dhEnemySp = {
        power:   clamp(refOppState.statPower ?? 0),
        speed:   clamp(refOppState.statSpeed ?? 0),
        defense: clamp(refOppState.statDefense ?? 0),
        stamina: clamp(refOppState.statStamina ?? 0),
        focus:   clamp(refOppState.statFocus ?? 0),
      };
    } else {
      const refLevel = refOppState?.level ?? fighter.level;
      const totalSP = Math.round((refLevel - 1) * 2);
      const perStat = Math.round(totalSP / 5);
      const variance = () => Math.round((Math.random() - 0.5) * perStat * 0.4);
      dhEnemySp = {
        power:   clamp(perStat + variance()),
        speed:   clamp(perStat + variance()),
        defense: clamp(perStat + variance()),
        stamina: clamp(perStat + variance()),
        focus:   clamp(Math.round(perStat * 0.5) + variance()),
      };
    }

    // Doghouse opponents always walk in at the player's level — the camp
    // opponent this session is modelled on only lends its stats and skills.
    const dhRefLevel = fighter.level;

    type EnemyRef = { offenseUnlocked?: boolean; defenseUnlocked?: boolean; fightIqUnlocked?: boolean; [k: string]: unknown };
    const dhRefUnlocked = careerRefinementUnlocked(fighter);
    // Every Doghouse opponent mirrors 100% of the player's refinement total,
    // each with their own random spread. With the mirror off (refinement locked,
    // or under the minimum spend) they fall back to the reference opponent's own skills.
    const dhMirrorOn = buildMirroredRefinement(fighter, DOGHOUSE_MIRROR_PCT) != null;
    const dhFallbackRef: EnemyRef | undefined = dhRefUnlocked && (refOppState?.customRefinementSkills &&
      Object.values(refOppState.customRefinementSkills).some(v => (v as number) > 0))
      ? { offenseUnlocked: true, defenseUnlocked: true, fightIqUnlocked: true, ...refOppState.customRefinementSkills }
      : undefined;
    /** Numbers only — the pool spec carries levels, the unlock flags are forced on when they are applied. */
    const dhMirrorLevels = (): Record<string, number> | undefined => {
      const mirrored = buildMirroredRefinement(fighter, DOGHOUSE_MIRROR_PCT);
      if (!mirrored) return undefined;
      const levels: Record<string, number> = {};
      for (const [k, v] of Object.entries(mirrored)) if (typeof v === "number" && v > 0) levels[k] = v;
      return levels;
    };
    const dhEnemyRef: EnemyRef | undefined = dhMirrorOn
      ? { offenseUnlocked: true, defenseUnlocked: true, fightIqUnlocked: true, ...dhMirrorLevels() }
      : dhFallbackRef;

    const dhPlayerRef = fighter.skillRefinement as SkillRefinement | undefined;

    const dhOpponentPool: DoghouseOpponentSpec[] = dhAvailable.map(f => {
      const sc = getRosterFighterColors(f);
      return {
        rosterId: f.id,
        name: f.name,
        archetype: f.archetype as Archetype,
        armLength: f.armLength || 65,
        colors: { gloves: sc.gloves, gloveTape: sc.gloveTape, trunks: sc.trunks, shoes: sc.shoes, skin: sc.skin, socks: sc.socks, laces: sc.laces, soles: sc.soles, waistStripe: sc.waistStripe },
        level: dhRefLevel,
        skillPoints: dhEnemySp,
        refinement: dhMirrorOn
          ? dhMirrorLevels()
          : (dhRefUnlocked ? (refOppState?.customRefinementSkills ?? undefined) : undefined),
      };
    });

    resetAutoZoom();
    const newState = startFight(
      gameState,
      fighter.archetype as Archetype,
      fighter.level,
      dhRefLevel,
      playerName,
      careerColors,
      false,
      "contender",
      1,
      durationSecs,
      "normal" as TimerSpeed,
      65,
      dhPartnerArm,
      dhPartnerArch,
      dhPartnerName,
      tb,
      false,
      false,
      false,
      true,
      false,
      dhPartnerColors,
      true,
      undefined,
      1,
      1,
      1,
      dhSp || undefined,
      dhEnemySp,
      true,
      dhPartnerRosterId,
      dhPlayerRef,
      dhEnemyRef ?? undefined,
      false,
      undefined,
      true,
      dhOpponentPool
    );
    // Doghouse also rides the sparring flags — apply before its stamina scaling
    // so the multipliers compose the same way they do elsewhere.
    applyItemFightMods(
      newState,
      getFightMods(withSavedInventory(fighter), fighter.careerRosterState as CareerRosterState | null, { sparring: true }),
    );
    openFightBoostEscrow(fighter.id);
    newState.player.maxStamina = Math.round(newState.player.maxStamina * DOGHOUSE_PLAYER_STAMINA_MULT);
    newState.player.maxStaminaCap = Math.round(newState.player.maxStaminaCap * DOGHOUSE_PLAYER_STAMINA_MULT);
    newState.player.stamina = newState.player.maxStamina;
    newState.enemy.maxStamina = Math.round(newState.enemy.maxStamina * DOGHOUSE_ENEMY_STAMINA_MULT);
    newState.enemy.maxStaminaCap = Math.round(newState.enemy.maxStaminaCap * DOGHOUSE_ENEMY_STAMINA_MULT);
    newState.enemy.stamina = newState.enemy.maxStamina;
    newState.enemy.damageMult *= 2;
    // The Doghouse queue matches the player's equipment level for level, applied
    // after the mode's stamina multipliers so the flat trunks pool isn't doubled.
    {
      const dhPlayerEquip = getEquipmentLevels(fighter);
      applyFightEquipment(newState, {
        player: dhPlayerEquip,
        opponent: scaleEquipmentLevels(dhPlayerEquip, DOGHOUSE_EQUIPMENT_SHARE),
      });
    }
    newState.careerEnemySkillPoints = dhEnemySp;
    if (dhPlayerRef) newState.playerRefinement = { ...dhPlayerRef };
    if (dhEnemyRef) newState.careerEnemyRefinement = { ...dhEnemyRef } as Record<string, number>;
    const rs = fighter.careerRosterState as CareerRosterState | null;
    // Doghouse partners have no roster entry, so only the player brings a punch
    // count; the cost is config, so they pay what the player's own division pays.
    applyPunchEndurance(newState, {
      player: punchEnduranceOf(rs),
      playerLoss: punchEnduranceLossOf(rs),
      enemyLoss: getAiPunchEnduranceLossForRank(rs?.playerRank),
    });
    applyResetTraining(newState, { player: resetTrainingOf(rs), playerSpeed: resetSpeedBonusOf(rs) });
    applySlipTraining(newState, autoSlipTrainedOf(rs));
    applyPurePower(newState, rs);
    // The Doghouse Round is gym work: counters may move in here.
    attachDrilledActions(newState, rs?.drilledActions, true);
    newState.careerXpMult = (rs && isChampBeaten(rs.roster) ? 1.0 : loadXpConfig().preChampMult) * loadXpConfig().careerMult;
    newState.canSurpassLevel100 = true;
    newState.showExpBar = showExpBar;
    newState.playerCurrentXp = fighter.xp;
    newState.fightLiveXp = fighter.xp;
    newState.ringColors = fighter.ringColors ? ringColorsOf(fighter) : undefined;
    newState.gymRingName = gymLookOf(localSaves.getFighter(fighter.id) ?? fighter).name ?? null;
    commitGameState(newState);
    setUiMode("fighting");
  };

  const handleStartTraining = (fighter: Fighter, type: TrainingType, sparDiff?: AIDifficulty, importedPartnerId?: number, sparDuration: SparringDuration = 60) => {
    // Clear any leftover flag from a session that was started but abandoned.
    importedPartnerUsedRef.current = false;
    setFreeBagMode(false);
    setActiveFighter(fighter);
    setTrainingType(type);
    if (type === "sparring" && sparDiff) {
      setSparringDifficulty(sparDiff);
      setIsSparring(true);
      setIsCareerFight(false);

      const playerName = fighter.firstName
        ? (fighter.nickname
          ? `${fighter.firstName} "${fighter.nickname}" ${fighter.lastName}`
          : `${fighter.firstName} ${fighter.lastName}`)
        : fighter.name;

      const careerColors = fighterToColors(fighter);
      setPlayerColors(careerColors);

      const tb = (fighter.trainingBonuses || DEFAULT_TRAINING_BONUSES) as TrainingBonuses;

      const rosterState = fighter.careerRosterState as CareerRosterState | null;
      let sparPartnerName = "Sparring Partner";
      let sparPartnerArch: Archetype | undefined = undefined;
      let sparPartnerArm = 65;
      let sparPartnerColors: FighterColors | undefined = undefined;
      let sparPartnerRosterId: number | undefined = undefined;

      // Import Ticket overrides partner selection entirely — the player already
      // picked who they want off the roster. Read the entry back from the
      // freshest save so the name, colours, level and stats are the ones the
      // roster screen just showed, not a stale copy on the fighter in hand.
      const importRosterState = (localSaves.getFighter(fighter.id)?.careerRosterState as CareerRosterState | null) ?? rosterState;
      const importedPartner = importedPartnerId != null
        ? importRosterState?.roster.find(f => f.id === importedPartnerId) ?? null
        : null;
      importedPartnerUsedRef.current = importedPartner != null;
      const foughtOpponents = rosterState ? rosterState.roster.filter(f => f.beatenByPlayer) : [];
      const usePreviousOpponent = !importedPartner && fighter.careerBoutIndex >= 3 && foughtOpponents.length > 0 && Math.random() < 0.35;

      if (importedPartner) {
        // A roster entry stores only the *custom* name parts and no archetype —
        // both live in the roster catalogue, keyed by id. Reading them straight
        // off the entry yields undefined, which is why an imported partner used
        // to walk out with a random name and a random style.
        const impEntry = getRosterEntryById(importedPartner.id);
        sparPartnerName = impEntry
          ? getRosterDisplayName(impEntry, importedPartner)
          : `Fighter ${importedPartner.id}`;
        sparPartnerArch = (impEntry?.archetype as Archetype) ?? "BoxerPuncher";
        sparPartnerArm = importedPartner.armLength || 65;
        sparPartnerRosterId = importedPartner.id;
        const sc = getRosterFighterColors(importedPartner);
        sparPartnerColors = { gloves: sc.gloves, gloveTape: sc.gloveTape, trunks: sc.trunks, shoes: sc.shoes, skin: sc.skin, socks: sc.socks, laces: sc.laces, soles: sc.soles, waistStripe: sc.waistStripe };
      } else if (usePreviousOpponent && foughtOpponents.length > 0) {
        const sparPartner = foughtOpponents[Math.floor(Math.random() * foughtOpponents.length)];
        sparPartnerName = sparPartner.name;
        sparPartnerArch = sparPartner.archetype as Archetype;
        sparPartnerArm = sparPartner.armLength || 65;
        sparPartnerRosterId = sparPartner.id;
        const sc = getRosterFighterColors(sparPartner);
        sparPartnerColors = {
          gloves: sc.gloves,
          gloveTape: sc.gloveTape,
          trunks: sc.trunks,
          shoes: sc.shoes,
          skin: sc.skin,
          socks: sc.socks,
          laces: sc.laces,
          soles: sc.soles,
          waistStripe: sc.waistStripe,
        };
      } else if (rosterState && rosterState.roster.length > 0) {
        const randomIdx = Math.floor(Math.random() * rosterState.roster.length);
        const sparPartner = rosterState.roster[randomIdx];
        sparPartnerName = sparPartner.name;
        sparPartnerArch = sparPartner.archetype as Archetype;
        sparPartnerArm = sparPartner.armLength || 65;
        sparPartnerRosterId = sparPartner.id;
        const sc = getRosterFighterColors(sparPartner);
        sparPartnerColors = {
          gloves: sc.gloves,
          gloveTape: sc.gloveTape,
          trunks: sc.trunks,
          shoes: sc.shoes,
          skin: sc.skin,
          socks: sc.socks,
          laces: sc.laces,
          soles: sc.soles,
          waistStripe: sc.waistStripe,
        };
      }

      const sparSp = fighter.skillPoints as SkillPoints | null;
      const sparPartnerState = sparPartnerRosterId
        ? rosterState?.roster.find(f => f.id === sparPartnerRosterId)
        : undefined;

      const clampSp = (v: number) => Math.max(0, Math.min(1000, Math.round(v)));
      const playerTotal = sparSp
        ? (sparSp.power + sparSp.speed + sparSp.defense + sparSp.stamina + sparSp.focus)
        : 0;
      const isSparFightCamp = (rosterState?.selectedOpponentId != null) && (rosterState?.prepWeeksRemaining ?? 0) > 0;

      let sparEnemySp: SkillPoints;

      if (importedPartner) {
        // Import Ticket: the partner spars as themselves — their own level and
        // full stats. An old roster entry with no stored stats falls back to
        // its own level (the same level→stat rule career fights use), never to
        // the player's spread, or the import would just mirror the player.
        const impLvlSp = Math.round((importedPartner.level ?? fighter.level) * 2);
        sparEnemySp = {
          power:   clampSp(importedPartner.statPower ?? impLvlSp),
          speed:   clampSp(importedPartner.statSpeed ?? impLvlSp),
          defense: clampSp(importedPartner.statDefense ?? impLvlSp),
          stamina: clampSp(importedPartner.statStamina ?? impLvlSp),
          focus:   clampSp(importedPartner.statFocus ?? Math.round((importedPartner.level ?? fighter.level))),
        };
      } else if (isSparFightCamp) {
        // Fight camp: 80% of selected opponent's stats
        const selectedOpp = rosterState?.roster.find(f => f.id === rosterState.selectedOpponentId);
        if (selectedOpp && selectedOpp.statPower != null) {
          sparEnemySp = {
            power:   clampSp((selectedOpp.statPower ?? 0) * 0.8),
            speed:   clampSp((selectedOpp.statSpeed ?? 0) * 0.8),
            defense: clampSp((selectedOpp.statDefense ?? 0) * 0.8),
            stamina: clampSp((selectedOpp.statStamina ?? 0) * 0.8),
            focus:   clampSp((selectedOpp.statFocus ?? 0) * 0.8),
          };
        } else {
          // Opponent has no stored stats — use 80% of player
          sparEnemySp = {
            power:   clampSp((sparSp?.power ?? 0) * 0.8),
            speed:   clampSp((sparSp?.speed ?? 0) * 0.8),
            defense: clampSp((sparSp?.defense ?? 0) * 0.8),
            stamina: clampSp((sparSp?.stamina ?? 0) * 0.8),
            focus:   clampSp((sparSp?.focus ?? 0) * 0.8),
          };
        }
      } else {
        // Regular sparring: total within ±5 of player total, distributed with slight per-stat variance
        const totalVariance = Math.round((Math.random() - 0.5) * 10); // ±5
        const targetTotal = Math.max(0, playerTotal + totalVariance);
        if (targetTotal === 0) {
          sparEnemySp = { power: 0, speed: 0, defense: 0, stamina: 0, focus: 0 };
        } else {
          const base = targetTotal / 5;
          const raw = [base, base, base, base, base].map(v => Math.max(0, v + (Math.random() - 0.5) * base * 0.3));
          const rawSum = raw.reduce((a, b) => a + b, 0);
          const scale = rawSum > 0 ? targetTotal / rawSum : 1;
          const [pw, sp2, df, st, fo] = raw.map(v => clampSp(v * scale));
          sparEnemySp = { power: pw, speed: sp2, defense: df, stamina: st, focus: fo };
        }
      }

      // Refinement: a randomized partner mirrors a tier-based share of the
      // player's own spread (Champion 90% → Journeyman 60%). An Import Ticket
      // partner spars as themselves, so they keep the old rule: 75% of the
      // selected opponent's, rounded up. That rule is also the fallback when the
      // mirror is off (refinement locked, or under the minimum spend).
      const sparPlayerRef = fighter.skillRefinement as SkillRefinement | undefined;
      let sparEnemyRef: EnemyRefinement | undefined = importedPartner
        ? undefined
        : buildMirroredRefinement(fighter, SPARRING_MIRROR_PCT[sparDiff] ?? SPARRING_MIRROR_PCT.journeyman);
      const sparSelectedOppId = rosterState?.selectedOpponentId;
      if (!sparEnemyRef && sparSelectedOppId != null) {
        const sparOpp = rosterState?.roster.find(f => f.id === sparSelectedOppId);
        if (sparOpp) {
          let baseRef: EnemyRefinement | undefined;
          const sparRefUnlocked = careerRefinementUnlocked(activeFighter);
          if (sparRefUnlocked && sparOpp.customRefinementSkills && Object.values(sparOpp.customRefinementSkills).some(v => (v as number) > 0)) {
            baseRef = { offenseUnlocked: true, defenseUnlocked: true, fightIqUnlocked: true, ...sparOpp.customRefinementSkills } as EnemyRefinement;
          } else if (sparRefUnlocked && (sparOpp.refPoints ?? 0) > 0) {
            baseRef = buildEnemyRefinement(sparOpp.refPoints!, ((sparOpp as any).archetype as Archetype) ?? "BoxerPuncher");
          }
          if (baseRef) {
            const scaled: Record<string, boolean | number> = {};
            for (const [k, v] of Object.entries(baseRef)) {
              if (typeof v === 'boolean') scaled[k] = v;
              else if (typeof v === 'number' && v > 0) scaled[k] = Math.ceil(v * 0.75);
            }
            sparEnemyRef = scaled as EnemyRefinement;
          }
        }
      }

      resetAutoZoom();
      const newState = startFight(
        gameState,
        fighter.archetype as Archetype,
        fighter.level,
        importedPartner?.level ?? fighter.level,
        playerName,
        careerColors,
        false,
        sparDiff,
        1,
        // An Import Ticket buys a full three-minute round; normal sparring
        // runs the 1/2/3-minute length picked on the difficulty screen.
        importedPartner ? 180 : sparDuration,
        "normal" as TimerSpeed,
        65,
        sparPartnerArm,
        sparPartnerArch,
        sparPartnerName,
        tb,
        false,
        false,
        false,
        true,
        false,
        sparPartnerColors,
        true,
        undefined,
        1,
        1,
        1,
        sparSp || undefined,
        sparEnemySp,
        true,
        sparPartnerRosterId,
        sparPlayerRef,
        sparEnemyRef
      );
      // An imported partner is bought for a full three-minute round, so it
      // carries double the gas. Champion partners no longer do: a flat x2 on
      // top of their tier pool left them with roughly two and a half times the
      // player's tank off a near-identical stamina stat.
      if (importedPartner) {
        newState.enemy.maxStamina = Math.round(newState.enemy.maxStamina * 2);
        newState.enemy.maxStaminaCap = Math.round(newState.enemy.maxStaminaCap * 2);
        newState.enemy.stamina = newState.enemy.maxStamina;
        // An imported bout is the closest sparring gets to the real thing, so
        // the gym goes dark around the ring — the fight-week look.
        newState.importSparring = true;
      }
      newState.careerEnemySkillPoints = sparEnemySp;
      if (sparPlayerRef) newState.playerRefinement = { ...sparPlayerRef };
      if (sparEnemyRef) newState.careerEnemyRefinement = { ...sparEnemyRef };
      // Tape study: the gym is where the player finds out what the roster has
      // already worked out about them, so a sparring partner walks in having
      // studied the same career library a ranked opponent would. Read-only —
      // foldAiPatternLibrary refuses a sparring bout, so nothing the partner
      // picks up in here goes back on the tape.
      //
      // Rank drives how much they studied: their own roster rank when the
      // partner is a real fighter, otherwise the player's, since a generic gym
      // partner is drawn from the player's own division. Seeded off the partner
      // id so the same partner has studied the same card every session.
      {
        const sparStudyRank = importedPartner?.rank ?? sparPartnerState?.rank ?? importRosterState?.playerRank;
        if (sparStudyRank != null && sparStudyRank > 0) {
          applyAiPatternStudy(
            newState,
            importRosterState?.aiPatternLibrary,
            sparPartnerRosterId ?? sparStudyRank,
            sparStudyRank,
          );
        }
      }
      // Sparring only gets the boosts flagged as sparring-legal.
      applyItemFightMods(newState, getFightMods(withSavedInventory(fighter), rosterState, { sparring: true }));
      openFightBoostEscrow(fighter.id);
      // A sparring partner wears a tier-based share of the player's equipment,
      // the same way their stats and refinement mirror it.
      {
        const sparPlayerEquip = getEquipmentLevels(fighter);
        const sparShare = SPARRING_EQUIPMENT_SHARE[(sparDiff ?? "journeyman") as keyof typeof SPARRING_EQUIPMENT_SHARE]
          ?? SPARRING_EQUIPMENT_SHARE.journeyman;
        applyFightEquipment(newState, {
          player: sparPlayerEquip,
          opponent: scaleEquipmentLevels(sparPlayerEquip, sparShare),
        });
      }
      // Gym partners have no roster entry, so only the player's own conditioning
      // comes into the session; the partner pays the player's division's cost.
      applyPunchEndurance(newState, {
        player: punchEnduranceOf(rosterState),
        playerLoss: punchEnduranceLossOf(rosterState),
        enemyLoss: getAiPunchEnduranceLossForRank(rosterState?.playerRank),
      });
      applyResetTraining(newState, { player: resetTrainingOf(rosterState), playerSpeed: resetSpeedBonusOf(rosterState) });
      // Ordinary sparring, every difficulty: this is where drilling happens.
      attachDrilledActions(newState, rosterState?.drilledActions, true);
      const rs = fighter.careerRosterState as CareerRosterState | null;
      newState.careerXpMult = (rs && isChampBeaten(rs.roster) ? 1.0 : loadXpConfig().preChampMult) * loadXpConfig().careerMult;
      newState.canSurpassLevel100 = true;
      newState.showExpBar = showExpBar;
      newState.playerCurrentXp = fighter.xp ?? 0;
      newState.fightLiveXp = fighter.xp ?? 0;
      if (rs && (rs.savedChargeBars || rs.savedChargeCounters)) {
        newState.player.chargeMeterBars = rs.savedChargeBars || 0;
        newState.player.chargeMeterCounters = rs.savedChargeCounters || 0;
      }
      newState.ringColors = fighter.ringColors ? ringColorsOf(fighter) : undefined;
      newState.gymRingName = gymLookOf(localSaves.getFighter(fighter.id) ?? fighter).name ?? null;
      commitGameState(newState);
      setUiMode("fighting");
    } else {
      setUiMode("training");
    }
  };

  /**
   * Spend the Weight Lifting / Heavy Bag boosts a finished workout used. Only
   * called once that session's stat points have actually been distributed, so a
   * quit workout or an abandoned allocation screen leaves the items armed.
   * Returns the new inventory when something was burned, for the caller's write.
   */
  const consumeTrainingBoosts = (
    fighterId: string,
    type: "weightLifting" | "heavyBag",
  ): ItemInventory | null => {
    const saved = localSaves.getFighter(fighterId);
    if (!saved) return null;
    return consumeBoostsFor(saved, type, saved.careerRosterState as CareerRosterState | null);
  };

  const handleTrainingComplete = (xpGained: number, reps: number) => {
    if (!activeFighter || !trainingType) return;

    const endgameTrain = activeFighter.level >= 100;
    const tb = (activeFighter.trainingBonuses || DEFAULT_TRAINING_BONUSES) as TrainingBonuses;
    // Lifetime rep counter (persists across WL + Heavy Bag sessions):
    // every 50 combined reps = 1 refinement point; every 300 reps per activity = 1 diamond
    const prevTotalReps = tb.totalTrainingReps || 0;
    const newTotalReps = prevTotalReps + Math.max(0, reps);
    const repRefPts = Math.floor(newTotalReps / 50) - Math.floor(prevTotalReps / 50);
    const REPS_PER_DIAMOND = 300;
    const prevTypeReps = (trainingType === "weightLifting" ? tb.wlTotalReps : tb.hbTotalReps) || 0;
    const newTypeReps = prevTypeReps + Math.max(0, reps);
    const repDiamonds = Math.floor(newTypeReps / REPS_PER_DIAMOND) - Math.floor(prevTypeReps / REPS_PER_DIAMOND);
    const newTB: TrainingBonuses = {
      ...tb,
      [trainingType]: tb[trainingType] + 1,
      totalTrainingReps: newTotalReps,
      ...(trainingType === "weightLifting"
        ? { wlHighScore: Math.max(tb.wlHighScore || 0, reps), wlTotalReps: newTypeReps }
        : {}),
      ...(trainingType === "heavyBag"
        ? { hbHighScore: Math.max(tb.hbHighScore || 0, reps), hbTotalReps: newTypeReps }
        : {}),
    };

    const trainRs = activeFighter.careerRosterState as CareerRosterState | null;
    const trainIdleWeeks = (trainRs?.selectedOpponentId != null && (trainRs?.prepWeeksRemaining ?? 0) > 0) ? 0 : (trainRs?.idleWeeks ?? 0);
    const isFightPrepMode = !!(trainRs?.selectedOpponentId != null && (trainRs?.prepWeeksRemaining ?? 0) > 0);
    const trainXpCfg = loadXpConfig();
    const trainXpBonusPct = isFightPrepMode
      ? (trainingType === "weightLifting" ? (trainXpCfg.xpWlPrepBonus ?? 0) : (trainXpCfg.xpHbPrepBonus ?? 0))
      : (trainingType === "weightLifting" ? (trainXpCfg.xpWlIdleBonus ?? 0) : (trainXpCfg.xpHbIdleBonus ?? 0));
    const trainWeeklyBonus = trainRs?.weeklyBonus ?? null;
    const trainWeeklyXpMult = (trainWeeklyBonus?.trainingType === trainingType && trainWeeklyBonus.bonusType === "xp") ? trainWeeklyBonus.value : 1;
    const isLastPrepWeek = isFightPrepMode && (trainRs?.prepWeeksRemaining ?? 0) === 1;
    const lastPrepWeekMult = isLastPrepWeek ? 5 : 1;
    const trainWinMult = Math.pow(trainXpCfg.trainWinBase, activeFighter.wins || 0);
    const trainBoutMult = Math.pow(trainXpCfg.boutBase, activeFighter.careerBoutIndex || 0);
    // Item boosts for this session (Warmup Tape, Pre-Workout, Training Frenzy, ...).
    const trainItemMods = getTrainingMods(withSavedInventory(activeFighter), trainRs, trainingType as "weightLifting" | "heavyBag");
    const scaledXp = Math.max(1, Math.ceil(xpGained * (1 + trainXpBonusPct / 100) * trainWeeklyXpMult * lastPrepWeekMult * trainWinMult * trainBoutMult * trainItemMods.xpMult));
    const trainChampBeaten = trainRs ? isChampBeaten(trainRs.roster) : false;
    let newXp = activeFighter.xp + scaledXp;
    let newLevel = activeFighter.level;
    while (newXp >= xpToNextLevel(newLevel) && newLevel < 1000) {
      newXp -= xpToNextLevel(newLevel);
      newLevel++;
    }
    if (newLevel >= 1000) {
      newLevel = 1000;
      newXp = Math.min(newXp, xpToNextLevel(1000) - 1);
    }

    runStatPointCheck(activeFighter);

    let updatedRosterState = activeFighter.careerRosterState as CareerRosterState | null;
    let didSimulate = false;
    let trainDecayedSP: SkillPoints | null = null;
    if (updatedRosterState) {
      // Persistent availability perk: every training session done during a fight
      // camp permanently adds +0.1% availability chance per prep-week slot.
      const wasInFightCampTrain = updatedRosterState.selectedOpponentId != null && (updatedRosterState.prepWeeksRemaining ?? 0) > 0;
      const prevTrainingsTrain = updatedRosterState.trainingsSinceLastWeek ?? 0;
      const trainPreWeek = activityStampWeek(activeFighter.id, updatedRosterState);
      // A heavy bag session does double duty: it restarts the rise clock and
      // drills a point off the Punch Endurance cost. Weight lifting only stamps
      // its own decay week.
      const trainTracking = trainingType === "weightLifting"
        ? { lastWLWeek: trainPreWeek, resetTraining: liftedResetBlock(activeFighter.id, updatedRosterState, trainPreWeek), purePower: liftedPurePower(activeFighter.id, updatedRosterState) }
        : { lastHBWeek: trainPreWeek, punchEnduranceLoss: improvedPunchEnduranceLoss(activeFighter.id, updatedRosterState) };
      if (prevTrainingsTrain >= 1) {
        const trainInFightCamp = updatedRosterState.selectedOpponentId != null && (updatedRosterState.prepWeeksRemaining ?? 0) > 0;
        const weekSeed = Date.now();
        updatedRosterState = simulateWeek({ ...updatedRosterState, ...trainTracking, weeklyBonus: null }, weekSeed, activeFighter.careerDifficulty, newLevel, true, refinementTotal(activeFighter.skillRefinement as Record<string, number> | null), getEquipmentLevels(activeFighter));
        updatedRosterState = { ...updatedRosterState, trainingsSinceLastWeek: 0 };
        didSimulate = true;
        const pRating = updatedRosterState.playerRatingScore ?? 1000;
        const newPlayerRank = trainInFightCamp ? updatedRosterState.playerRank : Math.max(computePlayerRankFromRating(updatedRosterState.roster, pRating, updatedRosterState.rank1HolderId), updatedRosterState.playerRank ?? 701);
        const trainNewWeeklyBonus = generateWeeklyBonus(activeFighter.wins || 0, activeFighter.careerStats, updatedRosterState);
        updatedRosterState = {
          ...updatedRosterState,
          playerRank: newPlayerRank,
          refinementPermanentlyUnlocked: updatedRosterState.refinementPermanentlyUnlocked || newPlayerRank <= 650,
          weeklyBonus: trainNewWeeklyBonus ?? null,
        };
        trainDecayedSP = applyTrainingDecay(updatedRosterState, (activeFighter.skillPoints || {}) as SkillPoints);
      } else {
        const nextBonus = generateWeeklyBonus(activeFighter.wins || 0, activeFighter.careerStats, updatedRosterState);
        updatedRosterState = { ...updatedRosterState, trainingsSinceLastWeek: 1, ...trainTracking, weeklyBonus: nextBonus ?? null };
      }
      if (wasInFightCampTrain) {
        updatedRosterState = { ...updatedRosterState, campTrainingSessions: (updatedRosterState.campTrainingSessions ?? 0) + 1 };
      }
    }

    let allocPoints: number;
    if (trainingType === "weightLifting") {
      allocPoints = Math.floor(Math.min(reps, 20) / 4) + (reps > 20 ? Math.floor((reps - 20) / 4) * 2 : 0);
      const wlStatPct = isFightPrepMode ? (trainXpCfg.statWlPrepBonus ?? 0) : (trainXpCfg.statWlIdleBonus ?? 0);
      if (wlStatPct !== 0) allocPoints = Math.round(allocPoints * (1 + wlStatPct / 100));
      allocPoints = Math.round(allocPoints * (trainXpCfg.statWlMult ?? 1.0));
    } else {
      allocPoints = Math.floor(Math.min(reps, 25) / 5) + (reps > 25 ? Math.floor((reps - 25) / 4) * 2 : 0);
      const hbStatPct = isFightPrepMode ? (trainXpCfg.statHbPrepBonus ?? 0) : (trainXpCfg.statHbIdleBonus ?? 0);
      if (hbStatPct !== 0) allocPoints = Math.round(allocPoints * (1 + hbStatPct / 100));
      allocPoints = Math.round(allocPoints * (trainXpCfg.statHbMult ?? 1.0));
    }
    // Global training SP rebalance: all training rewards are reduced by 40%.
    allocPoints = Math.ceil(allocPoints * 0.6);
    const trainHardCap = 20;
    allocPoints = Math.min(trainHardCap, allocPoints);
    // Idle penalty only after the 4-week grace period.
    if (trainIdleWeeks >= 6) {
      allocPoints = Math.ceil(allocPoints * 0.2);
    }
    if (trainWeeklyBonus?.trainingType === trainingType && trainWeeklyBonus.bonusType === "sp") {
      allocPoints += trainWeeklyBonus.value;
    }
    // Item boosts land after the hard cap — that's the point of buying them.
    if (trainItemMods.spMult !== 1) allocPoints = Math.ceil(allocPoints * trainItemMods.spMult);
    if (trainItemMods.spFlat > 0 && allocPoints > 0) allocPoints += trainItemMods.spFlat;
    // The stat-unlock milestone pays a one-time 1.5× on the session. It is
    // folded in before the cap so the milestone can't smuggle points past it —
    // the excess pays Force like any other overflow.
    const needsWlUnlock = trainingType === "weightLifting" && (activeFighter.careerBoutIndex || 0) >= 5 && !tb.wlCustomStatUnlock;
    const needsHbUnlock = trainingType === "heavyBag" && (activeFighter.careerBoutIndex || 0) >= 8 && !tb.hbCustomStatUnlock;
    if ((needsWlUnlock || needsHbUnlock) && allocPoints > 0) allocPoints = Math.ceil(allocPoints * 1.5);
    const trainUncapped = allocPoints;
    allocPoints = Math.min(
      allocPoints,
      Math.max(0, statPointCap(trainChampBeaten) - totalSkillPts(activeFighter.skillPoints, activeFighter.availableStatPoints || 0))
    );
    const trainOverflowAmt = Math.max(0, trainUncapped - allocPoints);
    // Points the stat cap left no room for are paid out as Force instead.
    const trainOverflowForce = cappedStatPointForce(trainOverflowAmt, FORCE_PER_CAPPED_SP_TRAINING);
    const trainForceBase = localSaves.getFighter(activeFighter.id)?.force ?? activeFighter.force ?? 0;
    const oldTrainRef = (activeFighter.skillRefinement || DEFAULT_SKILL_REFINEMENT) as SkillRefinement;
    const trainTotalRefPts = repRefPts;
    const newTrainRef: SkillRefinement = trainTotalRefPts > 0
      ? { ...oldTrainRef, availablePoints: (oldTrainRef.availablePoints || 0) + trainTotalRefPts }
      : oldTrainRef;

    const wlFights = activeFighter.careerBoutIndex || 0;
    const wlTrainingForFight = trainRs?.selectedOpponentId != null && (trainRs?.prepWeeksRemaining ?? 0) > 0;
    const wlStaminaUnlocked = wlFights >= 15 || (wlFights >= 7 && wlTrainingForFight);
    const wlFocusUnlocked = (activeFighter.wins || 0) >= 6;
    const wlCustomUnlock = tb.wlCustomStatUnlock as keyof SkillPoints | undefined;
    const hbCustomUnlock = tb.hbCustomStatUnlock as keyof SkillPoints | undefined;
    const baseWlStats: (keyof SkillPoints)[] = ["power", "defense", ...(wlCustomUnlock ? [wlCustomUnlock] : [])];
    const baseHbStats: (keyof SkillPoints)[] = ["power", "speed", ...(hbCustomUnlock ? [hbCustomUnlock] : [])];
    const allowedStats: (keyof SkillPoints)[] = trainingType === "weightLifting" ? baseWlStats : baseHbStats;

    const newTrainingSessions = (activeFighter.careerTrainingSessions || 0) + 1;
    const newlyShowsHighScoreMilestone = newTrainingSessions >= 50 && !activeFighter.highScoreMilestoneSeen;

    // The milestone's 1.5× is already in allocPoints (applied above, under the
    // cap); these are the points handed to the stat-unlock pick screen.
    const milestonePoints = allocPoints;

    // A workout's boosts are only spent once it has actually paid out — that is,
    // once the stat points it earned have been distributed. If points are still
    // owed, the burn is deferred to handleTrainingAllocConfirm so quitting the
    // allocation screen (or the tab) leaves the items armed.
    const trainAwaitsAlloc = (needsWlUnlock || needsHbUnlock) ? milestonePoints > 0 : allocPoints > 0;
    const trainSaved = withSavedInventory(activeFighter);
    let trainInventory = trainAwaitsAlloc
      ? pruneBoosts(trainSaved, updatedRosterState)
      : consumeBoostsFor(trainSaved, trainingType as "weightLifting" | "heavyBag", updatedRosterState)
        ?? pruneBoosts(trainSaved, updatedRosterState);

    // Rep payout: an item for the tier the session's reps cleared, or a chest of
    // that tier during the last week of a fight camp. Rolled off the inventory
    // the boost burn produced so both land in the save write below.
    const trainReward = grantTrainingReward({
      fighter: trainSaved,
      inventory: trainInventory,
      type: trainingType as "weightLifting" | "heavyBag",
      reps,
      lastCampWeek: isLastPrepWeek,
      playerRank: updatedRosterState?.playerRank ?? null,
    });
    if (trainReward.inventory) trainInventory = trainReward.inventory;

    updateFighterMutation.mutate({
      id: activeFighter.id,
      data: {
        xp: newXp,
        level: newLevel,
        trainingBonuses: newTB,
        careerRosterState: updatedRosterState,
        careerTrainingSessions: newTrainingSessions,
        ...(newlyShowsHighScoreMilestone ? { highScoreMilestoneSeen: true } : {}),
        ...(trainTotalRefPts > 0 ? { skillRefinement: newTrainRef } : {}),
        ...(trainOverflowForce > 0 ? { force: trainForceBase + trainOverflowForce } : {}),
        ...(repDiamonds > 0 ? { diamonds: (activeFighter.diamonds ?? 0) + repDiamonds } : {}),
        ...(trainDecayedSP ? { skillPoints: trainDecayedSP } : {}),
        ...(trainInventory ? { itemInventory: trainInventory } : {}),
      },
    });

    setActiveFighter(prev => prev ? {
      ...prev,
      xp: newXp,
      level: newLevel,
      trainingBonuses: newTB,
      careerRosterState: updatedRosterState,
      careerTrainingSessions: newTrainingSessions,
      ...(newlyShowsHighScoreMilestone ? { highScoreMilestoneSeen: true } : {}),
      ...(trainTotalRefPts > 0 ? { skillRefinement: newTrainRef } : {}),
      ...(trainOverflowForce > 0 ? { force: trainForceBase + trainOverflowForce } : {}),
      ...(repDiamonds > 0 ? { diamonds: (prev.diamonds ?? 0) + repDiamonds } : {}),
      ...(trainDecayedSP ? { skillPoints: trainDecayedSP } : {}),
      ...(trainInventory ? { itemInventory: trainInventory } : {}),
    } : null);

    setTrainingType(null);

    const trainRefCostFilter = makeRefCostMilestoneFilter(activeFighter.level || 1, refCostReductionOf(activeFighter));
    const trainLevelMilestones: Array<{ title: string; description: string; icon: string; kind?: "reward" }> = FIGHT_MILESTONES
      .filter(m =>
        ((m.type === "level" && activeFighter.level < m.threshold && newLevel >= m.threshold) ||
        (m.type === "trainingSessions" && m.threshold === 50 && newlyShowsHighScoreMilestone))
        && trainRefCostFilter(m.title, m.threshold)
      )
      .map(m => ({ title: m.title, description: m.description, icon: m.icon }));
    if (repDiamonds > 0) {
      const activityName = trainingType === "weightLifting" ? "Weight Lifting" : "Heavy Bag";
      trainLevelMilestones.push({
        title: "Diamond Grind",
        description: `${newTypeReps.toLocaleString()} lifetime ${activityName} reps — earned ${repDiamonds} Diamond${repDiamonds > 1 ? "s" : ""}! (1 per 300 reps)`,
        icon: "💎",
      });
    }
    if (trainReward.itemNames.length > 0) {
      trainLevelMilestones.unshift({
        title: "Workout Reward",
        description: `${trainReward.itemNames.join(" · ")} (${trainReward.rarity}) — waiting in your Locker.`,
        icon: "🎁",
        kind: "reward",
      });
    }
    if (trainLevelMilestones.length > 0) {
      setPendingMilestones(trainLevelMilestones);
    }
    // Camp's final week pays a chest instead — the overlay sits on top of
    // whichever screen the session hands off to below.
    if (trainReward.crate) {
      setCrateReveal({ queue: [trainReward.crate], index: 0 });
    }

    if (needsWlUnlock || needsHbUnlock) {
      setStatUnlockPending({
        allocData: milestonePoints > 0 ? {
          points: milestonePoints,
          allowedStats,
          didSimulate,
          simulationNews: didSimulate && updatedRosterState ? updatedRosterState.newsItems : undefined,
        } : null,
        tbToSave: newTB,
        fighterId: activeFighter.id,
        didSimulate,
        updatedRosterState,
        trainingSource: trainingType as "weightLifting" | "heavyBag",
      });
      setUiMode("career");
      return;
    }

    // Manual allocation screen for WL/HB stat points
    if (allocPoints > 0) {
      setPendingTrainingAlloc({
        points: allocPoints,
        allowedStats,
        didSimulate,
        simulationNews: didSimulate && updatedRosterState ? updatedRosterState.newsItems : undefined,
        trainingSource: trainingType as "weightLifting" | "heavyBag",
      });
      setAllocShowsRefinement(false);
      setUiMode("trainingAllocate");
      return;
    }
    if (didSimulate && updatedRosterState) {
      setSimulationNews(updatedRosterState.newsItems);
      setUiMode("simulating");
    } else {
      setUiMode("career");
    }
  };

  // Training Sweep: auto-completes a WL/HB session at the fighter's personal-best
  // rep count (min 20) with full rewards, auto-distributed stat points, and the
  // normal half-week cost. Fight camp only, once per roster week.
  const handleSweepTraining = (passedFighter: Fighter, type: "weightLifting" | "heavyBag") => {
    const f = localSaves.getFighter(passedFighter.id) ?? passedFighter;
    setActiveFighter(f);
    const tb = (f.trainingBonuses || DEFAULT_TRAINING_BONUSES) as TrainingBonuses;
    const rs = f.careerRosterState as CareerRosterState | null;
    if (!rs) return;
    const inCamp = rs.selectedOpponentId != null && (rs.prepWeeksRemaining ?? 0) > 0;
    if (!inCamp) return;
    if ((rs.trainingsSinceLastWeek ?? 0) >= 2) return;
    // The weekly sweep is free once. After that, the back half of the week can
    // buy a second one with shards; the front half can't, because the free
    // sweep already covers it.
    const paidSweep = (tb.lastSweepWeek ?? -1) === rs.weekNumber;
    if (paidSweep) {
      if ((rs.trainingsSinceLastWeek ?? 0) < 1) return;
      if ((f.shards ?? 0) < PAID_SWEEP_SHARD_COST) return;
    }

    const reps = Math.max(20, (type === "weightLifting" ? tb.wlHighScore : tb.hbHighScore) || 0);
    const xpGained = Math.max(1, Math.floor(reps * (type === "weightLifting" ? 3.6 : 2.04)));

    // Lifetime rep counters: every 50 combined reps = 1 refinement point; every 300 per activity = 1 diamond
    const prevTotalReps = tb.totalTrainingReps || 0;
    const newTotalReps = prevTotalReps + reps;
    const repRefPts = Math.floor(newTotalReps / 50) - Math.floor(prevTotalReps / 50);
    const prevTypeReps = (type === "weightLifting" ? tb.wlTotalReps : tb.hbTotalReps) || 0;
    const newTypeReps = prevTypeReps + reps;
    const repDiamonds = Math.floor(newTypeReps / 300) - Math.floor(prevTypeReps / 300);
    const sweepWeek = rs.weekNumber;
    const newTB: TrainingBonuses = {
      ...tb,
      [type]: (tb[type] || 0) + 1,
      totalTrainingReps: newTotalReps,
      lastSweepWeek: sweepWeek,
      ...(type === "weightLifting" ? { wlTotalReps: newTypeReps } : { hbTotalReps: newTypeReps }),
    };

    const trainXpCfg = loadXpConfig();
    const trainXpBonusPct = type === "weightLifting" ? (trainXpCfg.xpWlPrepBonus ?? 0) : (trainXpCfg.xpHbPrepBonus ?? 0);
    const weeklyBonus = rs.weeklyBonus ?? null;
    const weeklyXpMult = (weeklyBonus?.trainingType === type && weeklyBonus.bonusType === "xp") ? weeklyBonus.value : 1;
    const lastPrepWeekMult = (rs.prepWeeksRemaining ?? 0) === 1 ? 5 : 1;
    const trainWinMult = Math.pow(trainXpCfg.trainWinBase, f.wins || 0);
    const trainBoutMult = Math.pow(trainXpCfg.boutBase, f.careerBoutIndex || 0);
    // Item boosts apply to swept sessions exactly as they do to played ones.
    const sweepItemMods = getTrainingMods(withSavedInventory(f), rs, type);
    const scaledXp = Math.max(1, Math.ceil(xpGained * (1 + trainXpBonusPct / 100) * weeklyXpMult * lastPrepWeekMult * trainWinMult * trainBoutMult * sweepItemMods.xpMult));
    const champBeaten = isChampBeaten(rs.roster);
    let newXp = f.xp + scaledXp;
    let newLevel = f.level;
    while (newXp >= xpToNextLevel(newLevel) && newLevel < 1000) {
      newXp -= xpToNextLevel(newLevel);
      newLevel++;
    }
    if (newLevel >= 1000) {
      newLevel = 1000;
      newXp = Math.min(newXp, xpToNextLevel(1000) - 1);
    }

    // Week progression — identical to a normal training session (half week each)
    let updatedRosterState: CareerRosterState = rs;
    let didSimulate = false;
    let decayedSP: SkillPoints | null = null;
    {
      // Sweeping the bag counts as bag work, same as playing it out by hand.
      // Dated through activityStampWeek like every other gym stamp: `rs` is
      // already the freshest save here, so this reads the same week today — it
      // is what stops that from silently ceasing to be true.
      const sweepStampWeek = activityStampWeek(f.id, rs);
      const tracking = type === "weightLifting"
        ? { lastWLWeek: sweepStampWeek, resetTraining: liftedResetBlock(f.id, rs, sweepStampWeek), purePower: liftedPurePower(f.id, rs) }
        : { lastHBWeek: sweepStampWeek, punchEnduranceLoss: improvedPunchEnduranceLoss(f.id, rs) };
      if ((rs.trainingsSinceLastWeek ?? 0) >= 1) {
        const weekSeed = Date.now();
        updatedRosterState = simulateWeek({ ...rs, ...tracking, weeklyBonus: null }, weekSeed, f.careerDifficulty, newLevel, true, refinementTotal(f.skillRefinement as Record<string, number> | null), getEquipmentLevels(f));
        updatedRosterState = { ...updatedRosterState, trainingsSinceLastWeek: 0 };
        didSimulate = true;
        const pRating = updatedRosterState.playerRatingScore ?? 1000;
        const newPlayerRank = updatedRosterState.playerRank; // in camp: rank frozen
        updatedRosterState = {
          ...updatedRosterState,
          playerRank: newPlayerRank,
          refinementPermanentlyUnlocked: updatedRosterState.refinementPermanentlyUnlocked || (newPlayerRank ?? 701) <= 650,
          weeklyBonus: generateWeeklyBonus(f.wins || 0, f.careerStats, updatedRosterState) ?? null,
        };
        decayedSP = applyTrainingDecay(updatedRosterState, (f.skillPoints || {}) as SkillPoints);
      } else {
        const nextBonus = generateWeeklyBonus(f.wins || 0, f.careerStats, rs);
        updatedRosterState = { ...rs, trainingsSinceLastWeek: 1, ...tracking, weeklyBonus: nextBonus ?? null };
      }
      updatedRosterState = { ...updatedRosterState, campTrainingSessions: (updatedRosterState.campTrainingSessions ?? 0) + 1 };
    }

    // Stat points — same formula as a played session (fight-prep bonuses apply)
    let allocPoints: number;
    if (type === "weightLifting") {
      allocPoints = Math.floor(Math.min(reps, 20) / 4) + (reps > 20 ? Math.floor((reps - 20) / 4) * 2 : 0);
      const pct = trainXpCfg.statWlPrepBonus ?? 0;
      if (pct !== 0) allocPoints = Math.round(allocPoints * (1 + pct / 100));
      allocPoints = Math.round(allocPoints * (trainXpCfg.statWlMult ?? 1.0));
    } else {
      allocPoints = Math.floor(Math.min(reps, 25) / 5) + (reps > 25 ? Math.floor((reps - 25) / 4) * 2 : 0);
      const pct = trainXpCfg.statHbPrepBonus ?? 0;
      if (pct !== 0) allocPoints = Math.round(allocPoints * (1 + pct / 100));
      allocPoints = Math.round(allocPoints * (trainXpCfg.statHbMult ?? 1.0));
    }
    allocPoints = Math.ceil(allocPoints * 0.6);
    allocPoints = Math.min(20, allocPoints);
    if (weeklyBonus?.trainingType === type && weeklyBonus.bonusType === "sp") {
      allocPoints += weeklyBonus.value;
    }
    if (sweepItemMods.spMult !== 1) allocPoints = Math.ceil(allocPoints * sweepItemMods.spMult);
    if (sweepItemMods.spFlat > 0 && allocPoints > 0) allocPoints += sweepItemMods.spFlat;
    const uncapped = allocPoints;
    allocPoints = Math.min(
      allocPoints,
      Math.max(0, statPointCap(champBeaten) - totalSkillPts(f.skillPoints, f.availableStatPoints || 0))
    );
    const overflowAmt = Math.max(0, uncapped - allocPoints);
    // Points the stat cap left no room for are paid out as Force instead.
    const sweepOverflowForce = cappedStatPointForce(overflowAmt, FORCE_PER_CAPPED_SP_TRAINING);
    const sweepForceBase = localSaves.getFighter(f.id)?.force ?? f.force ?? 0;
    const oldRef = (f.skillRefinement || DEFAULT_SKILL_REFINEMENT) as SkillRefinement;
    const totalRefPts = repRefPts;
    const newRef: SkillRefinement = totalRefPts > 0
      ? { ...oldRef, availablePoints: (oldRef.availablePoints || 0) + totalRefPts }
      : oldRef;

    // Auto-distribute swept stat points round-robin across the allowed stats
    const wlCustomUnlock = tb.wlCustomStatUnlock as keyof SkillPoints | undefined;
    const hbCustomUnlock = tb.hbCustomStatUnlock as keyof SkillPoints | undefined;
    const allowedStats: (keyof SkillPoints)[] = type === "weightLifting"
      ? ["power", "defense", ...(wlCustomUnlock ? [wlCustomUnlock] : [])]
      : ["power", "speed", ...(hbCustomUnlock ? [hbCustomUnlock] : [])];
    const baseSP = { ...(decayedSP ?? ((f.skillPoints || {}) as SkillPoints)) } as SkillPoints;
    const statCapEach = perStatCap(champBeaten);
    let leftover = 0;
    for (let i = 0, placed = 0, stuck = 0; placed < allocPoints; i++) {
      const stat = allowedStats[i % allowedStats.length];
      if ((baseSP[stat] || 0) < statCapEach) {
        baseSP[stat] = (baseSP[stat] || 0) + 1;
        placed++;
        stuck = 0;
      } else if (++stuck >= allowedStats.length) {
        leftover = allocPoints - placed;
        break;
      }
    }

    const newTrainingSessions = (f.careerTrainingSessions || 0) + 1;
    const sweepSaved = withSavedInventory(f);
    let sweepInventory = consumeBoostsFor(sweepSaved, type, updatedRosterState) ?? pruneBoosts(sweepSaved, updatedRosterState);

    // A swept session pays the same rep reward a played one would.
    const sweepReward = grantTrainingReward({
      fighter: sweepSaved,
      inventory: sweepInventory,
      type,
      reps,
      lastCampWeek: (rs.prepWeeksRemaining ?? 0) === 1,
      playerRank: rs.playerRank ?? null,
    });
    if (sweepReward.inventory) sweepInventory = sweepReward.inventory;

    const updateData = {
      xp: newXp,
      level: newLevel,
      trainingBonuses: newTB,
      careerRosterState: updatedRosterState,
      careerTrainingSessions: newTrainingSessions,
      skillPoints: baseSP,
      ...(leftover > 0 ? { availableStatPoints: (f.availableStatPoints || 0) + leftover } : {}),
      ...(totalRefPts > 0 ? { skillRefinement: newRef } : {}),
      ...(sweepOverflowForce > 0 ? { force: sweepForceBase + sweepOverflowForce } : {}),
      ...(repDiamonds > 0 ? { diamonds: (f.diamonds ?? 0) + repDiamonds } : {}),
      ...(sweepInventory ? { itemInventory: sweepInventory } : {}),
      ...(paidSweep ? { shards: Math.max(0, (f.shards ?? 0) - PAID_SWEEP_SHARD_COST) } : {}),
    };
    updateFighterMutation.mutate({ id: f.id, data: updateData });
    setActiveFighter(prev => prev ? { ...prev, ...updateData } : { ...f, ...updateData });

    const activityName = type === "weightLifting" ? "Weight Lifting" : "Heavy Bag";
    const sweepRefCostFilter = makeRefCostMilestoneFilter(f.level || 1, refCostReductionOf(f));
    const milestones: Array<{ title: string; description: string; icon: string; kind?: "reward" }> = FIGHT_MILESTONES
      .filter(m => m.type === "level" && f.level < m.threshold && newLevel >= m.threshold && sweepRefCostFilter(m.title, m.threshold))
      .map(m => ({ title: m.title, description: m.description, icon: m.icon }));
    milestones.unshift({
      title: "Sweep!",
      description: `+${scaledXp} XP, +${allocPoints} stat point${allocPoints === 1 ? "" : "s"}${totalRefPts > 0 ? `, +${totalRefPts} refinement pt${totalRefPts === 1 ? "" : "s"}` : ""}${repDiamonds > 0 ? `, +${repDiamonds} 💎` : ""}${paidSweep ? ` (−${PAID_SWEEP_SHARD_COST.toLocaleString()} shards)` : ""}`,
      icon: "🧹",
      kind: "reward",
    });
    if (repDiamonds > 0) {
      milestones.push({
        title: "Diamond Grind",
        description: `${newTypeReps.toLocaleString()} lifetime ${activityName} reps — earned ${repDiamonds} Diamond${repDiamonds > 1 ? "s" : ""}! (1 per 300 reps)`,
        icon: "💎",
      });
    }
    if (sweepReward.itemNames.length > 0) {
      milestones.push({
        title: "Workout Reward",
        description: `${sweepReward.itemNames.join(" · ")} (${sweepReward.rarity}) — waiting in your Locker.`,
        icon: "🎁",
        kind: "reward",
      });
    }
    setPendingMilestones(milestones);
    if (sweepReward.crate) {
      setCrateReveal({ queue: [sweepReward.crate], index: 0 });
    }

    if (didSimulate) {
      setSimulationNews(updatedRosterState.newsItems);
      setUiMode("simulating");
    }
  };

  const handleStartFreeBag = (fighter: Fighter) => {
    setActiveFighter(fighter);
    setTrainingLiveXp(0);
    setFreeBagMode(true);
    freeBagPunchesRef.current = [];
    freeBagMinutesRef.current = 0;
    freeBagFullTimeRef.current = false;
    setTrainingType("heavyBag");
    setUiMode("training");
  };

  const handleFreeBagExit = () => {
    setFreeBagMode(false);
    // Free mode pays nothing else, but its strings count as gym drilling.
    // Built off the freshest saved roster blob (whole-object writes).
    const punches = freeBagPunchesRef.current;
    freeBagPunchesRef.current = [];
    const minutes = freeBagMinutesRef.current;
    freeBagMinutesRef.current = 0;
    const ranFullTime = freeBagFullTimeRef.current;
    freeBagFullTimeRef.current = false;
    const id = activeFighter?.id;
    const saved = id ? localSaves.getFighter(id) : null;
    const rs = saved?.careerRosterState as CareerRosterState | null | undefined;
    if (id && rs) {
      let nextRs: CareerRosterState = rs;
      if (punches.length >= 3) {
        const stance: BoxingStance = (() => { try { return localStorage.getItem("handz_player_boxing_stance") === "southpaw" ? "southpaw" : "orthodox"; } catch { return "orthodox"; } })();
        const drilled = creditBagSession(rs.drilledActions, punches, stance);
        if (drilled) nextRs = { ...nextRs, drilledActions: drilled };
      }
      // Hitting the bag 100 times per minute of the chosen length (100 / 200 /
      // 300) earns the heavy bag's Punch Endurance cut (max stamina per X punches).
      // Only a session that ran the full clock qualifies — quitting or finishing early never does.
      // It counts as a full heavy bag session: the cut lands now, and the
      // three-week rise clock restarts so the next week advance doesn't take it
      // straight back. Available in and out of fight camp alike.
      if (ranFullTime && minutes > 0 && punches.length >= minutes * FREE_BAG_PUNCHES_PER_MINUTE) {
        nextRs = {
          ...nextRs,
          lastHBWeek: activityStampWeek(id, rs),
          punchEnduranceLoss: improvedPunchEnduranceLoss(id, rs),
        };
      }
      if (nextRs !== rs) {
        updateFighterMutation.mutate({ id, data: { careerRosterState: nextRs } });
        setActiveFighter(prev => prev && prev.id === id ? { ...prev, careerRosterState: nextRs } : prev);
      }
    }
    handleTrainingQuit();
  };

  const handleTrainingQuit = () => {
    // Walking out of a workout is not a payout, so the session's armed boosts
    // are still sitting in the save untouched. Pull the persisted inventory
    // back into the in-memory fighter on the way out, so the hub shows them
    // still active on arrival instead of waiting for an unrelated write.
    setActiveFighter(prev => prev ? withSavedInventory(prev) : prev);
    setUiMode("career");
    setTrainingType(null);
  };

  const handleEndWeek = () => {
    if (!activeFighter) return;
    const rs = activeFighter.careerRosterState as CareerRosterState | null;
    if (!rs) return;
    // The week runs behind the loading screen: the simulation is delegated to
    // simulateWeekSteps, which yields between phases so the bar can move. The
    // phases execute in the original order, so the seeded schedule is unchanged.
    void runLoader({
      title: "Advancing Week",
      subtitle: `Week ${(rs.weekNumber ?? 0) + 1}`,
      phases: [{ label: "Ending the week", weight: 1, run: endWeekJob(activeFighter, rs) }],
    });
  };

  const endWeekJob = (activeFighter: Fighter, rs: CareerRosterState) => function* (): Generator<string, void, void> {
    const endWeekInFightCamp = rs.selectedOpponentId != null && (rs.prepWeeksRemaining ?? 0) > 0;
    const weekSeed = Date.now();
    const newLevel = activeFighter.level;
    let updatedRs = yield* simulateWeekSteps({ ...rs, weeklyBonus: null }, weekSeed, activeFighter.careerDifficulty, newLevel, true, refinementTotal(activeFighter.skillRefinement as Record<string, number> | null), getEquipmentLevels(activeFighter));
    yield "Filing the results";
    updatedRs = { ...updatedRs, trainingsSinceLastWeek: 0 };
    const pRating = updatedRs.playerRatingScore ?? 1000;
    const newPlayerRank = endWeekInFightCamp ? updatedRs.playerRank : Math.max(computePlayerRankFromRating(updatedRs.roster, pRating, updatedRs.rank1HolderId), updatedRs.playerRank ?? 701);
    const newWeeklyBonus = generateWeeklyBonus(activeFighter.wins || 0, activeFighter.careerStats, updatedRs);
    updatedRs = { ...updatedRs, playerRank: newPlayerRank, refinementPermanentlyUnlocked: updatedRs.refinementPermanentlyUnlocked || newPlayerRank <= 650, weeklyBonus: newWeeklyBonus ?? null };
    const endWeekDecayedSP = applyTrainingDecay(updatedRs, (activeFighter.skillPoints || {}) as SkillPoints);
    // The week moved on, so week-scoped boosts lapse with it.
    const endWeekInventory = pruneBoosts(withSavedInventory(activeFighter), updatedRs);
    updateFighterMutation.mutate({
      id: activeFighter.id,
      data: {
        careerRosterState: updatedRs,
        skillPoints: endWeekDecayedSP,
        ...(endWeekInventory ? { itemInventory: endWeekInventory } : {}),
      },
    });
    setActiveFighter(prev => prev ? {
      ...prev,
      careerRosterState: updatedRs,
      skillPoints: endWeekDecayedSP,
      ...(endWeekInventory ? { itemInventory: endWeekInventory } : {}),
    } : null);
    setSimulationNews(updatedRs.newsItems);
    setUiMode("simulating");
  };

  const handleStatUnlockPick = (stat: keyof SkillPoints) => {
    if (!statUnlockPending) return;
    const { allocData, tbToSave, fighterId, didSimulate, updatedRosterState } = statUnlockPending;
    const updatedTB: TrainingBonuses = statUnlockPending.trainingSource === "weightLifting"
      ? { ...tbToSave, wlCustomStatUnlock: stat as string }
      : { ...tbToSave, hbCustomStatUnlock: stat as string };
    updateFighterMutation.mutate({ id: fighterId, data: { trainingBonuses: updatedTB } });
    setActiveFighter(prev => prev ? { ...prev, trainingBonuses: updatedTB } : null);
    setStatUnlockPending(null);
    if (allocData) {
      // Points in allocData.points are already 1.5× boosted from handleTrainingComplete
      const allowedWithUnlock: (keyof SkillPoints)[] = allocData.allowedStats.includes(stat)
        ? allocData.allowedStats
        : [...allocData.allowedStats, stat];
      setPendingTrainingAlloc({
        points: allocData.points,
        allowedStats: allowedWithUnlock,
        didSimulate: allocData.didSimulate,
        simulationNews: allocData.simulationNews,
        trainingSource: statUnlockPending.trainingSource,
      });
      setAllocShowsRefinement(false);
      setUiMode("trainingAllocate");
    } else if (didSimulate && updatedRosterState) {
      setSimulationNews(updatedRosterState.newsItems);
      setUiMode("simulating");
    } else {
      setUiMode("career");
    }
  };

  const handleDeleteFighter = (id: string) => {
    deleteFighterMutation.mutate(id);
    if (activeFighter?.id === id) {
      setActiveFighter(null);
    }
  };

  const handleAllocateStats = (fighterId: string, skillPoints: SkillPoints, spent: number) => {
    // Always price the spend off the stored pool. The in-memory fighter lags
    // behind rapid repeated spends (the refinement exchange repeats every 50ms
    // while held), which would let the same pool be spent over and over.
    const stored = localSaves.getFighter(fighterId);
    const currentAvailable = stored?.availableStatPoints
      ?? (activeFighter?.id === fighterId ? (activeFighter?.availableStatPoints || 0) : 0);
    // The pool is a count of unspent points — a spend can never drive it negative.
    const newAvailable = Math.max(0, currentAvailable - spent);
    updateFighterMutation.mutate({
      id: fighterId,
      data: {
        skillPoints,
        availableStatPoints: newAvailable,
      },
    });
    setActiveFighter(prev => (prev && prev.id === fighterId) ? { ...prev, skillPoints, availableStatPoints: newAvailable } : prev);
  };

  const handleUnlockRefinement = (fighterId: string, track: "offense" | "defense" | "fightIq") => {
    if (!activeFighter) return;
    const forceCost = refUnlockForceCost(track);
    const shardCost = refUnlockShardCost(track);
    // Read the freshest persisted balances — the hub can hold a stale activeFighter.
    const stored = localSaves.getFighter(fighterId);
    const currentForce = stored?.force ?? activeFighter.force ?? 0;
    const currentShards = stored?.shards ?? activeFighter.shards ?? 0;
    if (currentForce < forceCost || currentShards < shardCost) return;
    const oldRef = (activeFighter.skillRefinement || DEFAULT_SKILL_REFINEMENT) as SkillRefinement;
    const newRef: SkillRefinement = {
      ...oldRef,
      offenseUnlocked: track === "offense" ? true : oldRef.offenseUnlocked,
      defenseUnlocked: track === "defense" ? true : oldRef.defenseUnlocked,
      fightIqUnlocked: track === "fightIq" ? true : oldRef.fightIqUnlocked,
    };
    const newForce = currentForce - forceCost;
    const newShards = currentShards - shardCost;
    updateFighterMutation.mutate({ id: fighterId, data: { skillRefinement: newRef, force: newForce, shards: newShards } });
    setActiveFighter(prev => prev ? { ...prev, skillRefinement: newRef, force: newForce, shards: newShards } : null);
  };

  const handleAllocateRefinement = (fighterId: string, refinement: SkillRefinement, forceCost: number = 0, diamondCost: number = 0, shardCost: number = 0) => {
    // costReduction is a permanent diamond purchase — never allow a write to lower it.
    // Baseline comes from the fighter actually being updated (looked up by id from
    // storage), not from activeFighter, which may be a different or stale fighter.
    const storedTarget = localSaves.getFighter(fighterId);
    const targetFighter = storedTarget ?? (activeFighter?.id === fighterId ? activeFighter : null);
    const existingReduction = refCostReductionOf(targetFighter);
    if ((refinement.costReduction || 0) < existingReduction) {
      refinement = { ...refinement, costReduction: existingReduction };
    }
    // Rank-earned Refinement Slots are permanent too — storage clamps them
    // upward, so the copy pushed into React state has to match or the screen
    // would show fewer slots than the save actually has until the next reload.
    const existingSlots = refinementSlotsUnlocked(targetFighter?.skillRefinement as { activeSlotsUnlocked?: number } | null);
    if (refinementSlotsUnlocked(refinement) < existingSlots) {
      refinement = { ...refinement, activeSlotsUnlocked: existingSlots };
    }
    const updateData: Record<string, unknown> = { skillRefinement: refinement };
    if (forceCost > 0 && targetFighter) updateData.force = Math.max(0, (targetFighter.force ?? 0) - forceCost);
    if (diamondCost > 0 && targetFighter) updateData.diamonds = Math.max(0, (targetFighter.diamonds ?? 0) - diamondCost);
    if (shardCost > 0 && targetFighter) updateData.shards = Math.max(0, (targetFighter.shards ?? 0) - shardCost);
    updateFighterMutation.mutate({ id: fighterId, data: updateData });
    setActiveFighter(prev => prev && prev.id === fighterId ? {
      ...prev,
      skillRefinement: refinement,
      ...(forceCost > 0 ? { force: Math.max(0, (prev.force ?? 0) - forceCost) } : {}),
      ...(diamondCost > 0 ? { diamonds: Math.max(0, (prev.diamonds ?? 0) - diamondCost) } : {}),
      ...(shardCost > 0 ? { shards: Math.max(0, (prev.shards ?? 0) - shardCost) } : {}),
    } : prev);
  };

  const handleSimulateWeek = (passedFighter: Fighter) => {
    const simRs = passedFighter.careerRosterState as CareerRosterState | null;
    if (!simRs) return;
    // Training payout + the division's own week are heavy enough to freeze the
    // app, so they run in chunks behind the loading screen.
    void runLoader({
      title: "Simulating Week",
      subtitle: `Week ${(simRs.weekNumber ?? 0) + 1}`,
      phases: [{ label: "Logging the week's training", weight: 1, run: simulateWeekJob(passedFighter) }],
    });
  };

  const simulateWeekJob = (passedFighter: Fighter) => function* (): Generator<string, void, void> {
    // Use the fighter passed directly from CareerMode (avoids stale/null activeFighter)
    const f = passedFighter;
    setActiveFighter(f);

    const tb = (f.trainingBonuses || DEFAULT_TRAINING_BONUSES) as TrainingBonuses;
    const trainRs = f.careerRosterState as CareerRosterState | null;
    if (!trainRs) return;
    const roster = Array.isArray(trainRs.roster) ? trainRs.roster : [];

    const trainXpCfg = loadXpConfig();
    const endgameTrain = (f.level || 1) >= 100;

    // Once 50 training sessions are logged, Simulate Week uses each exercise's personal-best
    // reps instead of a flat 12, and applies 0.85× to both XP and Stat Points (rounded up).
    const simMilestoneReached = (f.careerTrainingSessions || 0) >= 50;
    const simWlReps = simMilestoneReached ? Math.max(1, tb.wlHighScore || 12) : 12;
    const simHbReps = simMilestoneReached ? Math.max(1, tb.hbHighScore || 12) : 12;

    // WL: simWlReps × 3.6, then × 0.85 (rounded up once the milestone is reached)
    const scaledWlXp = simMilestoneReached
      ? Math.max(1, Math.ceil(simWlReps * 3.6 * 0.85 * (1 + (trainXpCfg.xpWlPrepBonus ?? 0) / 100)))
      : Math.max(1, Math.floor(Math.floor(simWlReps * 3.6) * 0.85 * (1 + (trainXpCfg.xpWlPrepBonus ?? 0) / 100)));
    // HB: simHbReps × 2.04, then × 0.85 (rounded up once the milestone is reached)
    const scaledHbXp = simMilestoneReached
      ? Math.max(1, Math.ceil(simHbReps * 2.04 * 0.85 * (1 + (trainXpCfg.xpHbPrepBonus ?? 0) / 100)))
      : Math.max(1, Math.floor(Math.floor(simHbReps * 2.04) * 0.85 * (1 + (trainXpCfg.xpHbPrepBonus ?? 0) / 100)));

    // 5% jackpot: ×50 XP, seeded by current timestamp
    const weekSeed = Date.now();
    const jackpotRng = ((weekSeed * 1664525 + 1013904223) >>> 0) / 4294967296;
    const isXpJackpot = jackpotRng < 0.05;
    // Simulating the week keeps the generic boosters but explicitly wastes
    // Training Frenzy, which is the tradeoff the item advertises.
    const simItemMods = getTrainingMods(withSavedInventory(f), trainRs, "weightLifting", { simulateWeek: true });
    const totalXp = Math.max(1, Math.ceil(
      (isXpJackpot ? (scaledWlXp + scaledHbXp) * 50 : (scaledWlXp + scaledHbXp)) * simItemMods.xpMult,
    ));
    const trainChampBeaten = isChampBeaten(roster);
    let newXp = (f.xp || 0) + totalXp;
    let newLevel = f.level || 1;
    while (newXp >= xpToNextLevel(newLevel) && newLevel < 1000) {
      newXp -= xpToNextLevel(newLevel);
      newLevel++;
    }
    if (newLevel >= 1000) {
      newLevel = 1000;
      newXp = Math.min(newXp, xpToNextLevel(1000) - 1);
    }

    // WL stat pts (simWlReps): 1pt/4reps up to 20, then 2pts/4reps
    let wlPts = Math.floor(Math.min(simWlReps, 20) / 4) + (simWlReps > 20 ? Math.floor((simWlReps - 20) / 4) * 2 : 0);
    wlPts = Math.round(wlPts * (1 + (trainXpCfg.statWlPrepBonus ?? 0) / 100));
    wlPts = Math.round(wlPts * (trainXpCfg.statWlMult ?? 1.0));
    if (simMilestoneReached) wlPts = Math.max(0, Math.ceil(wlPts * 0.85));

    // HB stat pts (simHbReps): 1pt/5combos up to 25, then 2pts/4combos
    let hbPts = Math.floor(Math.min(simHbReps, 25) / 5) + (simHbReps > 25 ? Math.floor((simHbReps - 25) / 4) * 2 : 0);
    hbPts = Math.round(hbPts * (1 + (trainXpCfg.statHbPrepBonus ?? 0) / 100));
    hbPts = Math.round(hbPts * (trainXpCfg.statHbMult ?? 1.0));
    if (simMilestoneReached) hbPts = Math.max(0, Math.ceil(hbPts * 0.85));

    const sp = f.skillPoints as SkillPoints;
    const simHeadroom = Math.max(0, statPointCap(trainChampBeaten) - totalSkillPts(sp, f.availableStatPoints || 0));
    const simIsPastCap = simHeadroom <= 0;
    let simEarned = simIsPastCap ? 3 : Math.min(8, wlPts + hbPts);
    if (simItemMods.spMult !== 1) simEarned = Math.ceil(simEarned * simItemMods.spMult);
    if (simItemMods.spFlat > 0 && simEarned > 0) simEarned += simItemMods.spFlat;
    // Decay penalty: -1 per neglected training type (WL or HB not done in 6+ weeks)
    const _nextWeek = trainRs.weekNumber + 1;
    const _simWlDecay = (_nextWeek - (trainRs.lastWLWeek ?? 0)) >= 6;
    const _simHbDecay = (_nextWeek - (trainRs.lastHBWeek ?? 0)) >= 6;
    const _simDecayPenalty = (trainRs.trainingsSinceLastWeek ?? 0) >= 1 ? 0 : (_simWlDecay ? 1 : 0) + (_simHbDecay ? 1 : 0);
    const simCapped = Math.min(simEarned, simHeadroom);
    const simOverflowAmt = Math.max(0, simEarned - simCapped);
    // The decay penalty is a loss, not overflow: it comes off after the cap
    // split so neglected training can't be cashed in as Force.
    let allocPoints = Math.max(0, simCapped - _simDecayPenalty);
    // Points the stat cap left no room for are paid out as Force instead.
    const simOverflowForce = cappedStatPointForce(simOverflowAmt, FORCE_PER_CAPPED_SP_TRAINING);
    const simForceBase = localSaves.getFighter(f.id)?.force ?? f.force ?? 0;

    const newTB: TrainingBonuses = { ...tb, weightLifting: (tb.weightLifting || 0) + 1, heavyBag: (tb.heavyBag || 0) + 1 };
    const wlCustomUnlock = tb.wlCustomStatUnlock as keyof SkillPoints | undefined;
    const hbCustomUnlock = tb.hbCustomStatUnlock as keyof SkillPoints | undefined;
    const allAllowedStats = [...new Set<keyof SkillPoints>([
      "power", "defense", "speed",
      ...(wlCustomUnlock ? [wlCustomUnlock] : []),
      ...(hbCustomUnlock ? [hbCustomUnlock] : []),
    ])];

    // Simulate week does NOT count as WL or HB training — lastWLWeek/lastHBWeek unchanged
    const wlInCamp = trainRs.selectedOpponentId != null && (trainRs.prepWeeksRemaining ?? 0) > 0;
    const simResult = yield* simulateWeekSteps({ ...trainRs, roster, weeklyBonus: null }, weekSeed, f.careerDifficulty, newLevel, true, refinementTotal(f.skillRefinement as Record<string, number> | null), getEquipmentLevels(f));
    yield "Filing the results";
    const _wlSimRank = wlInCamp
      ? (simResult.playerRank ?? 701)
      : Math.max(computePlayerRankFromRating(simResult.roster, simResult.playerRatingScore ?? 1000, simResult.rank1HolderId), simResult.playerRank ?? 701);
    const updatedRs: CareerRosterState = {
      ...simResult,
      trainingsSinceLastWeek: 0,
      playerRank: _wlSimRank,
      refinementPermanentlyUnlocked: (trainRs.refinementPermanentlyUnlocked || _wlSimRank <= 650),
      weeklyBonus: generateWeeklyBonus(f.wins || 0, f.careerStats, simResult) ?? null,
    };
    const simDecayedSP = applyTrainingDecay(updatedRs, (f.skillPoints || {}) as SkillPoints);

    const newlyShowsHighScoreMilestone = simMilestoneReached && !f.highScoreMilestoneSeen;
    // Training Frenzy is burned by simulating rather than training the week.
    const simSaved = withSavedInventory(f);
    const simInventory = nullifySimulatedWeekBoosts(simSaved) ?? pruneBoosts(simSaved, updatedRs);
    const updatedFighterData = {
      xp: newXp,
      level: newLevel,
      trainingBonuses: newTB,
      careerRosterState: updatedRs,
      ...(newlyShowsHighScoreMilestone ? { highScoreMilestoneSeen: true } : {}),
      ...(simOverflowForce > 0 ? { force: simForceBase + simOverflowForce } : {}),
      skillPoints: simDecayedSP,
      ...(simInventory ? { itemInventory: simInventory } : {}),
    };
    updateFighterMutation.mutate({ id: f.id, data: updatedFighterData });
    setActiveFighter({ ...f, ...updatedFighterData });

    if (newlyShowsHighScoreMilestone) {
      const highScoreMilestoneDef = FIGHT_MILESTONES.find(m => m.type === "trainingSessions" && m.threshold === 50);
      if (highScoreMilestoneDef) {
        setPendingMilestones([{ title: highScoreMilestoneDef.title, description: highScoreMilestoneDef.description, icon: highScoreMilestoneDef.icon }]);
      }
    }

    const newsItems: string[] = [
      ...(isXpJackpot ? ["⚡ BREAKTHROUGH WEEK! Your fighter hit a training flow state — XP gained ×50!"] : []),
      ...(simIsPastCap
        ? [simOverflowForce > 0
            ? `💪 Your fighter is past the stat cap — this week's training paid ⚡ ${simOverflowForce.toLocaleString()} Force instead of stat points.`
            : `💪 Your fighter is at the stat cap — no additional stat points were earned this week.`]
        : simOverflowForce > 0
          ? [`💪 Training exceeded your remaining stat point headroom — the extra paid ⚡ ${simOverflowForce.toLocaleString()} Force.`]
          : []),
      ...(Array.isArray(updatedRs.newsItems) ? updatedRs.newsItems : []),
    ];

    if (allocPoints <= 0) {
      setSimulationNews(newsItems);
      setUiMode("simulating");
      return;
    }
    setPendingTrainingAlloc({ points: allocPoints, allowedStats: allAllowedStats, didSimulate: true, isManualSimulate: true, simulationNews: newsItems });
    setAllocShowsRefinement(false);
    setUiMode("trainingAllocate");
  };

  const handleTrainingAllocConfirm = (newSkillPoints: SkillPoints, savedPoints: number = 0) => {
    if (!activeFighter) return;
    const alloc = pendingTrainingAlloc;
    const updateData: {
      skillPoints: SkillPoints;
      availableStatPoints?: number;
      itemInventory?: ItemInventory;
    } = { skillPoints: newSkillPoints };
    if (savedPoints > 0) {
      updateData.availableStatPoints = (activeFighter.availableStatPoints || 0) + savedPoints;
    }
    // The workout that produced these points has now paid out in full, so this
    // is where its Weight Lifting / Heavy Bag boosts are finally spent.
    const spentTrainInv = alloc?.trainingSource
      ? consumeTrainingBoosts(activeFighter.id, alloc.trainingSource)
      : null;
    if (spentTrainInv) updateData.itemInventory = spentTrainInv;
    updateFighterMutation.mutate({
      id: activeFighter.id,
      data: updateData,
    });
    setActiveFighter(prev => prev ? {
      ...prev,
      skillPoints: newSkillPoints,
      ...(savedPoints > 0 ? { availableStatPoints: (prev.availableStatPoints || 0) + savedPoints } : {}),
      ...(spentTrainInv ? { itemInventory: spentTrainInv } : {}),
    } : null);
    setPendingTrainingAlloc(null);
    if (alloc?.didSimulate && alloc.simulationNews) {
      setSimulationNews(alloc.simulationNews);
      setUiMode("simulating");
    } else if (champDefeatSimNewsRef.current) {
      const news = champDefeatSimNewsRef.current;
      champDefeatSimNewsRef.current = null;
      setSimulationNews(news);
      setUiMode("simulating");
    } else {
      setUiMode("career");
      if (deferredFightMilestonesRef.current?.length) {
        setPendingMilestones(deferredFightMilestonesRef.current);
        deferredFightMilestonesRef.current = [];
      }
    }
  };

  useEffect(() => {
    if (pendingTrainingAlloc && !pendingTrainingAlloc.didSimulate && activeFighter) {
      try {
        localStorage.setItem("handz_pending_alloc", JSON.stringify({
          fighterId: activeFighter.id,
          points: pendingTrainingAlloc.points,
          // Carried so a reload still knows which workout's boosts are owed.
          trainingSource: pendingTrainingAlloc.trainingSource,
        }));
      } catch {}
    } else if (!pendingTrainingAlloc) {
      try { localStorage.removeItem("handz_pending_alloc"); } catch {}
    }
  }, [pendingTrainingAlloc, activeFighter?.id]);

  useEffect(() => {
    if (!activeFighter || pendingAllocApplied.current) return;
    try {
      const saved = localStorage.getItem("handz_pending_alloc");
      if (!saved) return;
      const { fighterId, points, trainingSource } = JSON.parse(saved) as {
        fighterId: string; points: number; trainingSource?: "weightLifting" | "heavyBag";
      };
      if (String(fighterId) === String(activeFighter.id) && points > 0) {
        pendingAllocApplied.current = true;
        const newAvail = (activeFighter.availableStatPoints || 0) + points;
        // The points are being handed over now, so the workout that earned them
        // finally spends its boosts.
        const recoveredInv = trainingSource ? consumeTrainingBoosts(activeFighter.id, trainingSource) : null;
        updateFighterMutation.mutate({
          id: activeFighter.id,
          data: { availableStatPoints: newAvail, ...(recoveredInv ? { itemInventory: recoveredInv } : {}) },
        });
        setActiveFighter(prev => prev ? {
          ...prev,
          availableStatPoints: newAvail,
          ...(recoveredInv ? { itemInventory: recoveredInv } : {}),
        } : null);
        localStorage.removeItem("handz_pending_alloc");
      }
    } catch {}
  }, [activeFighter?.id]);

  /**
   * Freshest stored roster state for a save, falling back to the caller's copy.
   * The roster editor keeps the snapshot it mounted with, so its saves merge
   * onto the stored state — otherwise an out-of-band rewrite (a Roster
   * Generation regeneration, say) would be rolled back by the next editor save.
   */
  const freshestRosterState = (fighterId: string, fallback: CareerRosterState): CareerRosterState => {
    try {
      const stored = localSaves.getFighter(fighterId)?.careerRosterState as CareerRosterState | null | undefined;
      if (stored && Array.isArray(stored.roster) && stored.roster.length > 0) return stored;
    } catch { /* fall through to the in-memory copy */ }
    return fallback;
  };

  const handleInitRoster = (fighterId: string, rosterState: CareerRosterState) => {
    updateFighterMutation.mutate({
      id: fighterId,
      data: {
        careerRosterState: rosterState,
      },
    });
    setActiveFighter(prev => prev ? {
      ...prev,
      careerRosterState: rosterState,
    } : null);
  };

  const handleUpdateColors = (fighterId: string, skinColor: string, gearColors: GearColors, spacialParts?: string[]) => {
    // An explicit piece list replaces the older whole-kit flag, so clear it —
    // otherwise unticking every piece would still read as "wearing it".
    const spacialData = spacialParts === undefined ? {} : { spacialParts, spacialColors: false };
    updateFighterMutation.mutate({
      id: fighterId,
      data: { skinColor, gearColors, ...spacialData },
    });
    if (spacialParts !== undefined) {
      setActiveFighter(prev => (prev && prev.id === fighterId ? { ...prev, skinColor, gearColors, ...spacialData } : prev));
    }
  };

  const handleSelectOpponent = (fighterId: string, opponentId: number) => {
    if (!activeFighter) return;
    const rosterState = activeFighter.careerRosterState as CareerRosterState | null;
    if (!rosterState) return;

    const updatedRosterState: CareerRosterState = {
      ...rosterState,
      selectedOpponentId: opponentId,
      doghouseUsedThisCamp: false,
      nightmareUsesThisCamp: 0, // new camp — resets per-camp use counts
    };

    updateFighterMutation.mutate({
      id: fighterId,
      data: {
        careerRosterState: updatedRosterState,
      },
    });

    setActiveFighter(prev => prev ? {
      ...prev,
      careerRosterState: updatedRosterState,
    } : null);
  };

  return (
    <div className="min-h-screen bg-background flex flex-col items-center justify-center relative overflow-hidden">
      {loader.active && (
        <LoadingScreen
          title={loader.title}
          subtitle={loader.subtitle}
          label={loader.label}
          progress={loader.progress}
        />
      )}
      {uiMode !== "fighting" && uiMode !== "fightEnd" && uiMode !== "menu" && uiMode !== "ringWalk" && uiMode !== "resultsCeremony" && (
        <div className="fixed inset-0 z-0" aria-hidden="true">
          <RingOnlyBackground colors={activeFighter?.ringColors ?? null} />
        </div>
      )}
      <div className="w-full mx-auto relative z-10">
        {(uiMode === "fighting" || uiMode === "fightEnd") && (
          <div className="fixed inset-0 bg-black flex items-center justify-center overflow-hidden">
            {/* Tracks the letterboxed canvas exactly (same 4:3 base as the
                canvas element), so overlays pinned to its edges stay on the
                picture instead of spilling into the black side margins. */}
            <div className="relative" style={{ height: "100vh", aspectRatio: "4 / 3", maxWidth: "100vw" }}>
              <GameCanvas state={gameState} onStateChange={handleStateChange} liveStateRef={liveStateRef} />
              {/* No item affects a tutorial bout, so the kit row stays hidden
                  there rather than advertising boosts that aren't in play. */}
              {uiMode === "fighting" && showFightItemsHud && !gameState.tutorialMode && (
                <FightItemsHud
                  fighter={activeFighter}
                  roster={activeFighter?.careerRosterState as CareerRosterState | null}
                  opponentItems={gameState.opponentItems}
                />
              )}
              {uiMode === "fighting" && <PatternMemoryHud liveStateRef={liveStateRef} />}
              {gameState.isPaused && !gameState.pauseBoutDetailsTab && isDoghouse && gameState.doghouseOpponentsDefeated >= 1 && (
                <button
                  onClick={handleDoghouseEarlyFinish}
                  className="absolute bottom-6 left-1/2 -translate-x-1/2 z-[54] px-5 py-2 bg-yellow-400/85 hover:bg-yellow-300 text-black font-bold rounded-lg text-sm tracking-wide shadow-lg transition-colors"
                  data-testid="button-doghouse-finish-early"
                >
                  Finish Session · Full Rewards
                </button>
              )}
              {gameState.isPaused && !gameState.pauseBoutDetailsTab && (
                <button
                  className="absolute top-4 right-4 z-[55] w-10 h-10 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center text-white transition-colors"
                  onClick={() => setShowPausePunchEditor(true)}
                  data-testid="button-pause-settings-gear"
                >
                  <Settings className="w-5 h-5" />
                </button>
              )}
            </div>
            {gameState.isPaused && showPausePunchEditor && (
              <div className="absolute inset-0 bg-black/90 z-[56] overflow-y-auto" data-testid="overlay-pause-punch-editor">
                <PausePunchEditor onClose={() => setShowPausePunchEditor(false)} />
              </div>
            )}
            {gameState.isPaused && gameState.pauseBoutDetailsTab && (gameState.careerFightMode || gameState.sparringMode) && (() => {
              const MAX_SP = 200;
              const pSp = activeFighter?.skillPoints as SkillPoints | undefined;
              const eSp = gameState.careerEnemySkillPoints;
              const playerName = activeFighter
                ? (activeFighter.firstName && activeFighter.lastName
                  ? (activeFighter.nickname ? `${activeFighter.firstName} "${activeFighter.nickname}" ${activeFighter.lastName}` : `${activeFighter.firstName} ${activeFighter.lastName}`)
                  : (activeFighter.name || "Player"))
                : "Player";
              const rosterEntry = careerOpponentId != null
                ? (activeFighter?.careerRosterState as CareerRosterState | null)?.roster?.find(r => r.id === careerOpponentId)
                : null;
              const enemyW = rosterEntry?.wins ?? 0;
              const enemyL = rosterEntry?.losses ?? 0;
              const enemyD = rosterEntry?.draws ?? 0;
              const enemyKO = rosterEntry?.knockouts ?? 0;
              const enemyLevel = gameState.enemy.level;
              const statKeys: { key: keyof SkillPoints; label: string; color: string }[] = [
                { key: "power", label: "Power", color: "#ef4444" },
                { key: "speed", label: "Speed", color: "#3b82f6" },
                { key: "defense", label: "Defense", color: "#22c55e" },
                { key: "stamina", label: "Stamina", color: "#f59e0b" },
                { key: "focus", label: "Focus", color: "#a855f7" },
              ];
              const REF_KEYS = ["jabPower","hookPower","uppercutPower","ironChin","slippery","guardMaster","duckRecovery","punchRolling","fastTwitch","heartRefinement","chinHitter","technician","lifeDrain","pressureFighter","precisionStriker","bruiser","koArtist"] as const;
              const REF_LABELS: Record<string, string> = {
                jabPower: "Straight Punch", hookPower: "Hook Power", uppercutPower: "Uppercut Power", bruiser: "Bruiser", koArtist: "KO Artist",
                ironChin: "Iron Chin", slippery: "Slippery", guardMaster: "Guard Master",
                duckRecovery: "Duck Recovery", punchRolling: "Punch Rolling", fastTwitch: "Fast Twitch",
                heartRefinement: "Heart", chinHitter: "Chin Hitter", technician: "Technician", lifeDrain: "Life Drain",
                pressureFighter: "Pressure Fighter", precisionStriker: "Precision Striker",
              };
              const StatBar = ({ val, color }: { val: number; color: string }) => (
                <div className="w-full bg-white/10 rounded-full h-2 overflow-hidden">
                  <div className="h-full rounded-full transition-all" style={{ width: `${Math.min(100, (val / MAX_SP) * 100)}%`, backgroundColor: color }} />
                </div>
              );
              const bdRs = activeFighter?.careerRosterState as CareerRosterState | null;
              const bdShowRefinement = !!bdRs?.refinementPermanentlyUnlocked || (bdRs?.playerRank ?? 999) <= 650;
              const FighterCard = ({ name, level, wins, losses, draws, kos, sp, side, refinement, refinementIsPlayer }: { name: string; level: number; wins: number; losses: number; draws: number; kos: number; sp: SkillPoints | undefined; side: "left" | "right"; refinement?: Record<string, number>; refinementIsPlayer?: boolean }) => {
                // Only what this corner is actually bringing into the ring. The
                // player's own pick list decides theirs (none checked = nothing
                // listed); an opponent map has no list, so its five highest stand
                // in. Anything left out is skipped rather than shown at zero.
                const activeRef = activeRefinementsOnly(refinement as Record<string, unknown> | undefined, !!refinementIsPlayer) as Record<string, number> | undefined;
                const shownRefKeys = REF_KEYS.filter(k => (activeRef?.[k] ?? 0) > 0);
                return (
                <div className={`flex-1 flex flex-col gap-3 p-4 rounded-xl border border-white/10 bg-white/5 ${side === "left" ? "text-left" : "text-right"}`}>
                  <div>
                    <p className="text-xs uppercase tracking-widest text-white/40 font-semibold">{side === "left" ? "Player" : "Opponent"}</p>
                    <p className="text-lg font-black text-white leading-tight mt-0.5">{name}</p>
                  </div>
                  <div className="flex gap-3">
                    <div className="flex-1 bg-white/5 rounded-lg p-2 text-center">
                      <p className="text-xs text-white/40 uppercase tracking-wide">Level</p>
                      <p className="text-xl font-black text-yellow-400">{level}</p>
                    </div>
                    <div className="flex-1 bg-white/5 rounded-lg p-2 text-center">
                      <p className="text-xs text-white/40 uppercase tracking-wide">Record</p>
                      <p className="text-base font-bold text-white">{wins}-{losses}-{draws}</p>
                      {kos > 0 && <p className="text-xs text-red-400">{kos} KO{kos !== 1 ? "s" : ""}</p>}
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <p className="text-xs uppercase tracking-widest text-white/40 font-semibold">Stat Points</p>
                    {statKeys.map(({ key, label, color }) => (
                      <div key={key} className="flex items-center gap-2">
                        <span className="text-xs text-white/50 w-14 shrink-0">{label}</span>
                        <StatBar val={sp?.[key] ?? 0} color={color} />
                        <span className="text-xs font-bold text-white w-8 text-right shrink-0">{sp?.[key] ?? 0}</span>
                      </div>
                    ))}
                  </div>
                  {bdShowRefinement && shownRefKeys.length > 0 && (
                    <div className="border-t border-white/10 pt-2 space-y-1.5">
                      <p className="text-xs uppercase tracking-widest text-white/40 font-semibold">Refinement</p>
                      {shownRefKeys.map(k => {
                        const val = activeRef?.[k] ?? 0;
                        return (
                          <div key={k} className="flex items-center gap-2">
                            <span className="text-xs text-white/50 w-24 shrink-0">{REF_LABELS[k]}</span>
                            <div className="flex-1 bg-white/10 rounded-full h-1.5 overflow-hidden">
                              <div className="h-full rounded-full bg-purple-400 transition-all" style={{ width: `${val}%` }} />
                            </div>
                            <span className="text-xs font-bold w-7 text-right shrink-0 text-purple-300">{val}</span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
                );
              };
              return (
                <div className="absolute inset-0 flex flex-col items-center bg-black/80 z-50 overflow-y-auto py-4" data-testid="overlay-bout-details">
                  <div className="w-full max-w-2xl flex flex-col gap-4 px-4">
                    <h2 className="text-center text-xl font-black tracking-widest text-white uppercase">Bout Details</h2>
                    <div className="flex gap-3">
                      <FighterCard
                        name={playerName}
                        level={activeFighter?.level ?? 1}
                        wins={activeFighter?.wins ?? 0}
                        losses={activeFighter?.losses ?? 0}
                        draws={activeFighter?.draws ?? 0}
                        kos={activeFighter?.knockouts ?? 0}
                        sp={pSp}
                        side="left"
                        refinement={gameState.playerRefinement as Record<string, number> | undefined}
                        refinementIsPlayer
                      />
                      <FighterCard
                        name={gameState.enemyName}
                        level={enemyLevel}
                        wins={enemyW}
                        losses={enemyL}
                        draws={enemyD}
                        kos={enemyKO}
                        sp={eSp ? { power: eSp.power, speed: eSp.speed, defense: eSp.defense, stamina: eSp.stamina, focus: eSp.focus ?? 0 } : undefined}
                        side="right"
                        refinement={gameState.careerEnemyRefinement as Record<string, number> | undefined}
                      />
                    </div>
                    <button
                      className="mx-auto px-8 py-2 rounded-lg bg-white/10 hover:bg-white/20 text-white font-bold text-sm tracking-wide transition-colors"
                      onClick={() => patchLiveState(prev => ({ ...prev, pauseBoutDetailsTab: false }))}
                      data-testid="button-bout-details-back"
                    >
                      Back
                    </button>
                  </div>
                </div>
              );
            })()}
            {gameState.phase === "roundEnd" && (
              <div className="absolute inset-0 flex items-center justify-center bg-black/70 z-50">
                <RoundEnd state={gameState} onNextRound={handleNextRound} />
              </div>
            )}
            {uiMode === "fightEnd" && gameState.nightmareMode && (
              <div className="absolute inset-0 flex items-center justify-center bg-black/80 z-50" data-testid="overlay-nightmare-end">
                <div className="rounded-2xl border-2 border-[#FFABAB] bg-[#1a0a0a] px-10 py-8 w-[340px] flex flex-col items-center gap-6 shadow-2xl">
                  <h2 className="text-3xl font-black tracking-widest text-[#FFABAB]" data-testid="text-nightmare-title">NIGHTMARE</h2>
                  <div className="w-full flex flex-col gap-4">
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-semibold text-[#ffd1d1] uppercase tracking-wide">EXP</span>
                      <span className="text-2xl font-black text-white" data-testid="text-nightmare-exp">{nightmareResultRef.current?.exp ?? 0}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-semibold text-[#ffd1d1] uppercase tracking-wide">Total KOs</span>
                      <span className="text-2xl font-black text-white" data-testid="text-nightmare-kos">{nightmareResultRef.current?.kos ?? gameState.nightmareKillCount}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-semibold text-[#ffd1d1] uppercase tracking-wide">Total Time</span>
                      <span className="text-2xl font-black text-white" data-testid="text-nightmare-time">{(() => {
                        const t = nightmareResultRef.current?.timeSurvived ?? Math.floor(gameState.nightmareTimeSurvived);
                        const m = Math.floor(t / 60);
                        const s = t % 60;
                        return `${m}:${s.toString().padStart(2, "0")}`;
                      })()}</span>
                    </div>
                  </div>
                  <button
                    onClick={handleContinue}
                    className="w-full px-6 py-3 bg-[#FFABAB] hover:bg-[#ff9090] text-black font-bold rounded-lg text-lg transition-colors"
                    data-testid="button-nightmare-continue"
                  >
                    Continue
                  </button>
                </div>
              </div>
            )}
            {uiMode === "fightEnd" && !gameState.nightmareMode && (
              <div className="absolute inset-0 flex items-center justify-center bg-black/70 z-50">
                <FightEnd
                  state={gameState}
                  forceEarned={lastForceEarnedRef.current}
                  diamondsEarned={lastDiamondsEarnedRef.current}
                  onContinue={handleContinue}
                  xpToNext={xpToNextLevel(activeFighter?.level || 1)}
                  currentXp={activeFighter?.xp || 0}
                />
              </div>
            )}
          </div>
        )}

        {uiMode === "ringWalk" && ringWalkData && (
          <RingWalkOverlay
            playerName={ringWalkData.playerName}
            enemyName={ringWalkData.enemyName}
            playerColors={ringWalkData.playerColors}
            enemyColors={ringWalkData.enemyColors}
            boutDetails={ringWalkData.playerSp || ringWalkData.enemySp ? {
              playerLevel: ringWalkData.playerLevel,
              playerWins: ringWalkData.playerWins,
              playerLosses: ringWalkData.playerLosses,
              playerDraws: ringWalkData.playerDraws,
              playerKOs: ringWalkData.playerKOs,
              playerSp: ringWalkData.playerSp,
              playerRefinement: ringWalkData.playerRefinement,
              enemyLevel: ringWalkData.enemyLevel,
              enemyWins: ringWalkData.enemyWins,
              enemyLosses: ringWalkData.enemyLosses,
              enemyDraws: ringWalkData.enemyDraws,
              enemyKOs: ringWalkData.enemyKOs,
              enemySp: ringWalkData.enemySp,
              enemyRefinement: ringWalkData.enemyRefinement,
              enemyRank: ringWalkData.enemyRank,
            } : undefined}
            playerRank={ringWalkData.playerRank}
            playerNickname={ringWalkData.playerNickname}
            onComplete={() => { clearAllKeys(); setUiMode("fighting"); }}
          />
        )}

        {uiMode === "resultsCeremony" && ceremonyData && (
          <DecisionCeremony
            isWin={ceremonyData.isWin}
            isDraw={ceremonyData.isDraw}
            playerName={ceremonyData.playerName}
            enemyName={ceremonyData.enemyName}
            playerColors={ceremonyData.playerColors}
            enemyColors={ceremonyData.enemyColors}
            ringCanvasColor={ceremonyData.ringCanvasColor}
            onContinue={() => setUiMode("fightEnd")}
          />
        )}

        {uiMode === "menu" && (
          <div className="relative min-h-screen w-full overflow-hidden" data-testid="menu-with-background">
            <div className="absolute inset-0 z-0" aria-hidden="true">
              <MenuBackgroundFight />
            </div>
            <div className="relative z-10">
              <MainMenu
                onQuickFight={handleQuickFight}
                onCareer={handleCareer}
                onEditRoster={canEditRoster ? handleEditRoster : undefined}
                onTutorial={() => { setTutorialStage(1); setUiMode("tutorial"); }}
                fighterName={activeFighter?.name}
                fighterLevel={activeFighter?.level}
                wins={activeFighter?.wins}
                losses={activeFighter?.losses}
              />
            </div>
          </div>
        )}

        {uiMode === "tutorial" && (
          <div className="flex flex-col items-center justify-center min-h-screen gap-6 p-6" data-testid="tutorial-screen">
            <h1
              className="text-4xl font-black tracking-wider text-[#ca8a07]"
              style={{ textShadow: "0 0 30px rgba(200,50,50,0.3), 0 3px 6px rgba(0,0,0,0.4)" }}
              data-testid="text-tutorial-title"
            >
              TUTORIAL
            </h1>
            <p className="text-muted-foreground text-sm text-center max-w-xs">Learn every aspect of the ring!</p>
            <div className="flex flex-col gap-3 w-full max-w-sm">
              {([
                { stage: 1, name: "Stage 1 — Basics", desc: "Movement, punches, blocking, and ducking." },
                { stage: 2, name: "Stage 2 — Advanced", desc: "Auto guard, feints, weaving, and rhythm." },
                { stage: 3, name: "Stage 3 — Stat Points", desc: "Power, Defense, Speed, Stamina, and Focus." },
              ] as { stage: number; name: string; desc: string }[]).map(({ stage, name, desc }) => {
                const done = tutorialCompletedStages.includes(stage);
                return (
                  <div key={stage} className="flex items-center gap-3 bg-black/30 border border-white/10 rounded-lg px-4 py-3">
                    <div className={`flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center font-bold text-sm border-2 ${done ? "border-green-500 bg-green-500/20 text-green-400" : "border-white/30 text-white/60"}`}>
                      {done ? "✓" : stage}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="font-bold text-sm text-white">{name}</p>
                      <p className="text-xs text-muted-foreground">{desc}</p>
                    </div>
                    <button
                      onClick={() => { setTutorialStage(stage); startTutorialFight(stage); }}
                      className={`flex-shrink-0 px-4 py-1.5 rounded font-bold text-sm transition-colors ${done ? "bg-gray-700 hover:bg-gray-600 text-white" : "bg-yellow-600 hover:bg-yellow-500 text-black"}`}
                      data-testid={`button-start-tutorial-${stage}`}
                    >
                      {done ? "Replay" : "Start"}
                    </button>
                  </div>
                );
              })}
            </div>
            <button
              onClick={() => setUiMode("menu")}
              className="w-full max-w-sm px-6 py-3 bg-gray-700 hover:bg-gray-600 text-white font-bold rounded text-lg transition-colors"
              data-testid="button-tutorial-exit"
            >
              Back to Menu
            </button>
          </div>
        )}

        {uiMode === "tutorialComplete" && (
          <TutorialCompleteScreen onFinish={() => setUiMode("menu")} />
        )}

        {uiMode === "classSelect" && (
          <ClassSelect
            selected={isCareerFight ? (activeFighter?.archetype as Archetype || selectedArchetype) : selectedArchetype}
            onSelect={a => !isCareerFight && setSelectedArchetype(a)}
            onConfirm={handleConfirmClass}
            onBack={() => setUiMode(isCareerFight ? "career" : "menu")}
            colors={playerColors}
            onColorsChange={(c: FighterColors) => {
              setPlayerColors(c);
              if (!isCareerFight) {
                localStorage.setItem("quickFightColors", JSON.stringify(c));
              }
            }}
            lockedArchetype={isCareerFight}
            showLevelSelect={!isCareerFight}
            playerLevel={quickFightPlayerLevel}
            enemyLevel={quickFightEnemyLevel}
            onPlayerLevelChange={setQuickFightPlayerLevel}
            onEnemyLevelChange={setQuickFightEnemyLevel}
            difficulty={aiDifficulty}
            onDifficultyChange={setAiDifficulty}
            roundDuration={roundDurationMins}
            onRoundDurationChange={setRoundDurationMins}
            timerSpeed={timerSpeed}
            onTimerSpeedChange={setTimerSpeed}
            maxRounds={maxRounds}
            onMaxRoundsChange={setMaxRounds}
            playerArmLength={playerArmLength}
            enemyArmLength={enemyArmLength}
            onPlayerArmLengthChange={setPlayerArmLength}
            onEnemyArmLengthChange={setEnemyArmLength}
            towelStoppageEnabled={towelStoppageEnabled}
            onTowelStoppageChange={setTowelStoppageEnabled}
            practiceMode={practiceMode}
            onPracticeModeChange={setPracticeMode}
            recordInputs={recordInputs}
            onRecordInputsChange={setRecordInputs}
            cpuVsCpu={cpuVsCpu}
            onCpuVsCpuChange={setCpuVsCpu}
            aiPowerMult={aiPowerMult}
            onAiPowerMultChange={setAiPowerMult}
            aiSpeedMult={aiSpeedMult}
            onAiSpeedMultChange={setAiSpeedMult}
            aiStaminaMult={aiStaminaMult}
            onAiStaminaMultChange={setAiStaminaMult}
            selectedRosterFighters={selectedRosterFighters}
            onRosterFightersChange={setSelectedRosterFighters}
            nightmareMode={quickFightNightmare}
            onNightmareModeChange={setQuickFightNightmare}
          />
        )}

        {uiMode === "career" && (
          <CareerMode
            fighters={fighters}
            onSelectFighter={handleSelectCareerFighter}
            onCreateFighter={handleCreateFighter}
            onDeleteFighter={handleDeleteFighter}
            onAllocateStats={handleAllocateStats}
            onStartTraining={handleStartTraining}
            onStartFreeBag={handleStartFreeBag}
            onSweepTraining={handleSweepTraining}
            onEndWeek={handleEndWeek}
            onSimulateWeek={handleSimulateWeek}
            onStartNightmare={handleStartNightmare}
            onStartDoghouse={handleStartDoghouse}
            onSelectOpponent={handleSelectOpponent}
            onInitRoster={handleInitRoster}
            // Today's chests, already granted and persisted by the hub. The
            // milestone popup sits above the reveal (z-9999 over z-95), so the
            // player is told what it is before the chests appear underneath.
            onDailyReward={(crates) => {
              // Daily chests are handed out, not won — Quick Open says so too.
              setCrateReveal({ queue: crates, index: 0, label: "Daily Reward", quickOpenTitle: "Daily Reward" });
              setPendingMilestones(prev => [...prev, {
                title: "Daily Reward",
                description: crates.length === 1
                  ? "Your chest for today is ready to open."
                  : `${crates.length} chests are waiting for you today.`,
                icon: "🎁",
                kind: "reward" as const,
              }]);
            }}
            onUpdateColors={handleUpdateColors}
            onBack={() => { sessionStorage.removeItem("handz_hub_passive_shown"); setActiveFighter(null); setUiMode("menu"); }}
            isLoading={fightersLoading}
            initialFighter={activeFighter}
            startInCreate={careerStartInCreate}
            onFighterRefresh={(f) => { setActiveFighter(prev => (prev && prev.id === f.id ? { ...prev, ...f } : prev)); refreshFighters(); }}
            careerRefStoppageEnabled={careerRefStoppageEnabled}
            onToggleCareerRefStoppage={(enabled) => { setCareerRefStoppageEnabled(enabled); try { localStorage.setItem("handz_career_ref_stoppage", String(enabled)); } catch {} }}
            careerTowelStoppageEnabled={careerTowelStoppageEnabled}
            onToggleCareerTowelStoppage={(enabled) => { setCareerTowelStoppageEnabled(enabled); try { localStorage.setItem("handz_career_towel_stoppage", String(enabled)); } catch {} }}
            showExpBar={showExpBar}
            onToggleShowExpBar={(enabled) => { setShowExpBar(enabled); try { localStorage.setItem("handz_show_exp_bar", String(enabled)); } catch {} }}
            showFightItemsHud={showFightItemsHud}
            onToggleShowFightItemsHud={(enabled) => { setShowFightItemsHud(enabled); try { localStorage.setItem("handz_show_fight_items", String(enabled)); } catch {} }}
            onUnlockRefinement={handleUnlockRefinement}
            onAllocateRefinement={handleAllocateRefinement}
            onForceSpend={(fighterId, amount) => {
              if (!activeFighter) return;
              const newForce = Math.max(0, (activeFighter.force ?? 0) - amount);
              updateFighterMutation.mutate({ id: fighterId, data: { force: newForce } });
              setActiveFighter(prev => prev ? { ...prev, force: newForce } : null);
            }}
            onShardSpend={(fighterId, amount) => {
              const f = localSaves.getFighter(fighterId) ?? activeFighter;
              if (!f) return;
              const newShards = Math.max(0, (f.shards ?? 0) - amount);
              updateFighterMutation.mutate({ id: fighterId, data: { shards: newShards } });
              setActiveFighter(prev => prev && prev.id === fighterId ? { ...prev, shards: newShards } : prev);
            }}
            onDiamondSpend={(fighterId, amount) => {
              // Read the freshest persisted fighter — activeFighter can be null when a slot
              // was loaded directly into the career hub.
              const f = localSaves.getFighter(fighterId) ?? activeFighter;
              if (!f) return;
              const newDiamonds = Math.max(0, (f.diamonds ?? 0) - amount);
              updateFighterMutation.mutate({ id: fighterId, data: { diamonds: newDiamonds } });
              setActiveFighter(prev => prev && prev.id === fighterId ? { ...prev, diamonds: newDiamonds } : prev);
            }}
            onTutorial={(name, colors) => {
              setIsCareerTutorial(true);
              careerTutorialInfoRef.current = { name, colors };
              setTutorialStage(1);
              startTutorialFight(1, name, colors);
            }}
          />
        )}

        {uiMode === "doghouseSetup" && doghousePendingFighter && (
          <DoghouseSetupScreen
            onConfirm={(durationSecs) => {
              setDoghousePendingFighter(null);
              handleConfirmDoghouse(doghousePendingFighter, durationSecs);
            }}
            onCancel={() => {
              setDoghousePendingFighter(null);
              setUiMode("career");
            }}
          />
        )}

        {uiMode === "rosterEdit" && activeFighter && activeFighter.careerRosterState && (
          <RosterEditView
            rosterState={activeFighter.careerRosterState as CareerRosterState}
            onSave={(updatedRoster) => {
              if (activeFighter.id === -1) {
                saveRosterCustomizations(updatedRoster);
              } else {
                const rs = freshestRosterState(activeFighter.id, activeFighter.careerRosterState as CareerRosterState);
                const updatedState: CareerRosterState = { ...rs, roster: updatedRoster };
                handleInitRoster(activeFighter.id, updatedState);
              }
              setActiveFighter(null);
              setUiMode("menu");
            }}
            onAutosave={(updatedRoster) => {
              if (activeFighter.id !== -1) {
                const rs = freshestRosterState(activeFighter.id, activeFighter.careerRosterState as CareerRosterState);
                const updatedState: CareerRosterState = { ...rs, roster: updatedRoster };
                handleInitRoster(activeFighter.id, updatedState);
              } else {
                saveRosterCustomizations(updatedRoster);
              }
            }}
            onBack={() => { sessionStorage.removeItem("handz_hub_passive_shown"); setActiveFighter(null); setUiMode("menu"); }}
            careerFighterId={(activeFighter.id as unknown) !== -1 ? activeFighter.id : null}
            onDiamondsInjected={(f) => {
              setActiveFighter(prev => (prev && prev.id === f.id ? { ...prev, ...f } : prev));
              refreshFighters();
            }}
            onRosterRegenerated={() => {
              // Adopt the rosters Roster Generation just rewrote, so the editor
              // and the live career both show the new ranges without a reload.
              if (activeFighter.id === -1) return null;
              const stored = localSaves.getFighter(activeFighter.id);
              const fresh = (stored?.careerRosterState as CareerRosterState | null) ?? null;
              if (!fresh) return null;
              handleInitRoster(activeFighter.id, fresh);
              return fresh.roster;
            }}
          />
        )}

        {uiMode === "simulating" && (
          <SimulationScreen
            news={simulationNews}
            weekNumber={activeFighter?.careerRosterState ? (activeFighter.careerRosterState as CareerRosterState).weekNumber : 0}
            onComplete={() => {
              setUiMode("career");
              if (deferredFightMilestonesRef.current?.length) {
                setPendingMilestones(deferredFightMilestonesRef.current);
                deferredFightMilestonesRef.current = null;
              }
            }}
          />
        )}

        {uiMode === "training" && (trainingType === "weightLifting" || trainingType === "heavyBag") && activeFighter && (() => {
          const trainRsForCalc = activeFighter.careerRosterState as CareerRosterState | null;
          const isFightPrepCalc = !!(trainRsForCalc?.selectedOpponentId != null && (trainRsForCalc?.prepWeeksRemaining ?? 0) > 0);
          const endgameTrainCalc = activeFighter.level >= 100;
          const trainIdleWeeksCalc = isFightPrepCalc ? 0 : (trainRsForCalc?.idleWeeks ?? 0);
          const trainChampBeatenCalc = trainRsForCalc ? isChampBeaten(trainRsForCalc.roster) : false;
          const makeCalcStatPts = (type: "weightLifting" | "heavyBag") => (count: number): number => {
            const previewCfg = loadXpConfig();
            let pts: number;
            if (type === "weightLifting") {
              pts = Math.floor(Math.min(count, 20) / 4) + (count > 20 ? Math.floor((count - 20) / 4) * 2 : 0);
              const wlStatPct = isFightPrepCalc ? (previewCfg.statWlPrepBonus ?? 0) : (previewCfg.statWlIdleBonus ?? 0);
              if (wlStatPct !== 0) pts = Math.round(pts * (1 + wlStatPct / 100));
              pts = Math.round(pts * (previewCfg.statWlMult ?? 1.0));
            } else {
              pts = Math.floor(Math.min(count, 25) / 5) + (count > 25 ? Math.floor((count - 25) / 4) * 2 : 0);
              const hbStatPct = isFightPrepCalc ? (previewCfg.statHbPrepBonus ?? 0) : (previewCfg.statHbIdleBonus ?? 0);
              if (hbStatPct !== 0) pts = Math.round(pts * (1 + hbStatPct / 100));
              pts = Math.round(pts * (previewCfg.statHbMult ?? 1.0));
            }
            // Global training SP rebalance: all training rewards are reduced by 40%.
            pts = Math.ceil(pts * 0.6);
            const hardCap = 20;
            pts = Math.min(hardCap, pts);
            if (trainIdleWeeksCalc >= 6) pts = Math.ceil(pts * 0.2);
            // Add weekly SP bonus (same order as handleTrainingComplete)
            const displayWeeklyBonus = trainRsForCalc?.weeklyBonus ?? null;
            if (displayWeeklyBonus?.trainingType === type && displayWeeklyBonus.bonusType === "sp") {
              pts += displayWeeklyBonus.value;
            }
            pts = Math.min(pts, Math.max(0, statPointCap(trainChampBeatenCalc) - totalSkillPts(activeFighter.skillPoints, activeFighter.availableStatPoints || 0)));
            // Mirror 1.5× milestone bonus when the stat-unlock milestone will trigger
            const displayTb = (activeFighter.trainingBonuses || DEFAULT_TRAINING_BONUSES) as TrainingBonuses;
            const willUnlock = (type === "weightLifting" && (activeFighter.careerBoutIndex || 0) >= 5 && !displayTb.wlCustomStatUnlock)
                            || (type === "heavyBag" && (activeFighter.careerBoutIndex || 0) >= 8 && !displayTb.hbCustomStatUnlock);
            if (willUnlock && pts > 0) pts = Math.ceil(pts * 1.5);
            const previewMods = getTrainingMods(withSavedInventory(activeFighter), trainRsForCalc, type);
            if (previewMods.spMult !== 1) pts = Math.ceil(pts * previewMods.spMult);
            if (previewMods.spFlat > 0 && pts > 0) pts += previewMods.spFlat;
            return pts;
          };
          const makeCalcXP = (type: "weightLifting" | "heavyBag") => (count: number): number => {
            const previewCfg = loadXpConfig();
            const xpPerUnit = type === "weightLifting" ? 3.6 : 2.04;
            const rawXp = Math.floor(count * xpPerUnit);
            const xpBonusPct = isFightPrepCalc
              ? (type === "weightLifting" ? (previewCfg.xpWlPrepBonus ?? 0) : (previewCfg.xpHbPrepBonus ?? 0))
              : (type === "weightLifting" ? (previewCfg.xpWlIdleBonus ?? 0) : (previewCfg.xpHbIdleBonus ?? 0));
            const weeklyBonus = trainRsForCalc?.weeklyBonus ?? null;
            const weeklyXpMult = (weeklyBonus?.trainingType === type && weeklyBonus.bonusType === "xp") ? weeklyBonus.value : 1;
            const isLastPrepWeekCalc = isFightPrepCalc && (trainRsForCalc?.prepWeeksRemaining ?? 0) === 1;
            const lastPrepWeekMultCalc = isLastPrepWeekCalc ? 5 : 1;
            const trainWinMultCalc = Math.pow(previewCfg.trainWinBase, activeFighter.wins || 0);
            const trainBoutMultCalc = Math.pow(previewCfg.boutBase, activeFighter.careerBoutIndex || 0);
            const previewXpMult = getTrainingMods(withSavedInventory(activeFighter), trainRsForCalc, type).xpMult;
            return Math.max(1, rawXp * (1 + xpBonusPct / 100) * weeklyXpMult * lastPrepWeekMultCalc * trainWinMultCalc * trainBoutMultCalc * previewXpMult);
          };
          let trainLiveLvl = activeFighter.level;
          let trainXpInLvl = activeFighter.xp + trainingLiveXp;
          let trainLeveledUp = false;
          while (trainXpInLvl >= xpToNextLevel(trainLiveLvl) && trainLiveLvl < 1000) {
            trainXpInLvl -= xpToNextLevel(trainLiveLvl);
            trainLiveLvl++;
            trainLeveledUp = true;
          }
          const trainNeeded = xpToNextLevel(trainLiveLvl);
          const trainLiveXp = trainXpInLvl;
          const trainingExpOverlay = showExpBar ? (
            <div style={{
              position: "fixed", top: 8, left: 8, zIndex: 50, pointerEvents: "none",
              background: "rgba(26,26,26,0.92)", borderRadius: 5, width: 164, padding: "4px 8px"
            }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                <span style={{ fontSize: 10, fontWeight: "bold", color: trainLeveledUp ? "#ffe066" : "#fff", fontFamily: "Oxanium,sans-serif" }}>
                  {trainLeveledUp ? "▲ " : ""}LV {trainLiveLvl}
                </span>
                <span style={{ fontSize: 8, color: "rgba(255,255,255,0.55)", fontFamily: "Oxanium,sans-serif" }}>
                  {Math.ceil(trainLiveXp).toLocaleString()} / {trainNeeded.toLocaleString()} XP
                </span>
              </div>
              <div style={{ background: "#262626", borderRadius: 2, height: 5 }}>
                <div style={{
                  background: trainLeveledUp ? "#ffe066" : "#4d9432", borderRadius: 2, height: 5,
                  width: `${Math.min(100, (trainLiveXp / Math.max(1, trainNeeded)) * 100)}%`
                }} />
              </div>
            </div>
          ) : null;
          if (trainingType === "weightLifting") {
            return (
              <>
                <WeightLiftingGame
                  fighter={activeFighter}
                  onComplete={handleTrainingComplete}
                  onQuit={handleTrainingQuit}
                  calcStatPoints={makeCalcStatPts("weightLifting")}
                  calcXP={makeCalcXP("weightLifting")}
                  isFightPrep={isFightPrepCalc}
                  isIdleWeek={!isFightPrepCalc}
                  playerRank={
                    trainRsForCalc
                      ? computePlayerRankFromRating(trainRsForCalc.roster, trainRsForCalc.playerRatingScore, trainRsForCalc.rank1HolderId)
                      : (activeFighter.rank ?? 999)
                  }
                  hasBeatenChampion={trainChampBeatenCalc}
                  onLiveXpChange={(xp) => setTrainingLiveXp(xp)}
                  record={trainingRecords.wl}
                />
                {trainingExpOverlay}
              </>
            );
          }
          if (freeBagMode) {
            return (
              <HeavyBagGame
                fighter={activeFighter}
                freeMode
                onPunch={(p, head) => { freeBagPunchesRef.current.push({ type: p, head }); }}
                onSessionStart={(m) => { freeBagMinutesRef.current = m; freeBagPunchesRef.current = []; freeBagFullTimeRef.current = false; }}
                onSessionTimeUp={() => { freeBagFullTimeRef.current = true; }}
                freeTargetPerMinute={FREE_BAG_PUNCHES_PER_MINUTE}
                onComplete={handleFreeBagExit}
                onQuit={handleFreeBagExit}
              />
            );
          }
          return (
            <>
              <HeavyBagGame
                fighter={activeFighter}
                onComplete={handleTrainingComplete}
                onQuit={handleTrainingQuit}
                calcStatPoints={makeCalcStatPts("heavyBag")}
                calcXP={makeCalcXP("heavyBag")}
                isFightPrep={isFightPrepCalc}
                isIdleWeek={!isFightPrepCalc}
                onLiveXpChange={(xp) => setTrainingLiveXp(xp)}
                record={trainingRecords.hb}
              />
              {trainingExpOverlay}
            </>
          );
        })()}

        {uiMode === "trainingAllocate" && activeFighter && pendingTrainingAlloc && (() => {
          const rs = activeFighter.careerRosterState as CareerRosterState | null;
          const bypass = typeof window !== "undefined" && localStorage.getItem("handz_refinement_bypass") === "true";
          const isRefinementUnlocked = bypass || (activeFighter.level || 1) >= 50;
          const refPts = (activeFighter.skillRefinement as SkillRefinement | null)?.availablePoints ?? 0;
          const refPlayerRank = rs?.playerRank ?? 0;
          if (allocShowsRefinement) {
            const allocExchangeCost = refinementExchangeCost(activeFighter.level || 1, refCostReductionOf(activeFighter));
            return (
              <RefinementView
                fighter={activeFighter}
                bypassLocks={bypass}
                playerRank={refPlayerRank}
                exchangeCost={allocExchangeCost}
                playerForce={activeFighter.force ?? 0}
                playerDiamonds={activeFighter.diamonds ?? 0}
                playerShards={activeFighter.shards ?? 0}
                onAllocate={(ref, forceCost, diamondCost, shardCost) => {
                  handleAllocateRefinement(activeFighter.id, ref, forceCost ?? 0, diamondCost ?? 0, shardCost ?? 0);
                  setAllocShowsRefinement(false);
                }}
                onUnlock={(track) => handleUnlockRefinement(activeFighter.id, track)}
                onBack={() => setAllocShowsRefinement(false)}
                onStatExchange={() => {
                  // Pool and refinement must come off the SAME freshly-read save:
                  // the button repeats every 50ms while held, faster than a write
                  // can flow back into this closure, so mixing stored SP with a
                  // snapshot refinement burns SP per repeat for a single point.
                  const stored = localSaves.getFighter(activeFighter.id);
                  const currentAvailSP = Math.max(0, stored?.availableStatPoints ?? activeFighter.availableStatPoints ?? 0);
                  if (currentAvailSP < allocExchangeCost) return;
                  const baseRef = (stored?.skillRefinement ?? activeFighter.skillRefinement ?? {}) as Partial<SkillRefinement>;
                  const oldRef = { ...DEFAULT_SKILL_REFINEMENT, ...baseRef } as SkillRefinement;
                  const newRef: SkillRefinement = { ...oldRef, availablePoints: (oldRef.availablePoints || 0) + 1 };
                  const newAvailSP = currentAvailSP - allocExchangeCost;
                  updateFighterMutation.mutate({ id: activeFighter.id, data: { skillRefinement: newRef, availableStatPoints: newAvailSP } });
                  setActiveFighter(prev => prev ? { ...prev, skillRefinement: newRef, availableStatPoints: newAvailSP } : null);
                }}
              />
            );
          }
          const isSimAlloc = pendingTrainingAlloc.isManualSimulate === true;
          return (
            <div className="flex flex-col items-center gap-3 w-full max-w-lg mx-auto">
              <AllocateStats
                fighter={activeFighter}
                fixedPoints={pendingTrainingAlloc.points}
                allowedStats={pendingTrainingAlloc.allowedStats}
                showAllSkillsBanner={pendingTrainingAlloc.showAllSkillsBanner}
                onAllocate={(sp, spent) => { const rem = isSimAlloc ? 0 : pendingTrainingAlloc.points - spent; setAllocShowsRefinement(false); handleTrainingAllocConfirm(sp, rem); }}
                onBack={() => {}}
                noSaveForLater={isSimAlloc}
                refinementSlot={!isSimAlloc && isRefinementUnlocked ? (
                  <button
                    data-testid="button-open-refinement-from-alloc"
                    onClick={() => {
                      // Opening refinement from here counts as seeing the case,
                      // so the gym's "new" dot must not survive it.
                      if (activeFighter) localSaves.markRefinementCaseSeen(activeFighter.id);
                      setAllocShowsRefinement(true);
                    }}
                    className="w-full bg-[#95b1c7] flex items-center justify-center gap-2 py-2 px-4 rounded-lg text-white font-semibold text-sm"
                  >
                    <span>⚔️ Skill Refinement</span>
                    {refPts > 0 && (
                      <span className="text-yellow-400 font-bold text-xs">{refPts} pts available</span>
                    )}
                  </button>
                ) : undefined}
              />
            </div>
          );
        })()}
      </div>
      <BackgroundTrainingControl variant="badge" />
      {statUnlockPending && (() => {
        const alreadyProvidedStats: (keyof SkillPoints)[] =
          statUnlockPending.trainingSource === "weightLifting" ? ["power", "defense"] :
          statUnlockPending.trainingSource === "heavyBag" ? ["power", "speed"] : [];
        return (
          <div className="fixed inset-0 bg-black/90 flex items-center justify-center z-[9999]">
            <div className="bg-zinc-900 border border-yellow-500/60 rounded-xl p-8 max-w-sm w-full mx-4 shadow-2xl">
              <div className="text-center mb-6">
                <div className="text-yellow-400 text-4xl mb-2">🏆</div>
                <h2 className="text-yellow-400 text-xl font-bold tracking-wide uppercase mb-1">Milestone Reached!</h2>
                <p className="text-zinc-300 text-sm">10 training sessions completed.</p>
                <p className="text-white font-semibold mt-2">Choose one stat your training will permanently unlock:</p>
              </div>
              <div className="flex flex-col gap-3">
                {(["power", "speed", "defense", "stamina", "focus"] as (keyof SkillPoints)[]).map(stat => {
                  const isProvided = alreadyProvidedStats.includes(stat);
                  return isProvided ? (
                    <div
                      key={stat}
                      className="w-full py-3 px-4 rounded-lg bg-zinc-800/50 border border-zinc-700 flex items-center justify-between opacity-60 cursor-default"
                    >
                      <span className="text-zinc-400 font-semibold capitalize text-sm tracking-wide">{stat.charAt(0).toUpperCase() + stat.slice(1)}</span>
                      <span className="text-green-400 font-bold text-base">✓ Already trained</span>
                    </div>
                  ) : (
                    <button
                      key={stat}
                      data-testid={`button-stat-unlock-${stat}`}
                      onClick={() => handleStatUnlockPick(stat)}
                      className="w-full py-3 px-4 rounded-lg bg-zinc-800 border border-zinc-600 hover:border-yellow-400 hover:bg-zinc-700 text-white font-semibold capitalize transition-all text-sm tracking-wide"
                    >
                      {stat.charAt(0).toUpperCase() + stat.slice(1)}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        );
      })()}
      {crateReveal && crateReveal.queue[crateReveal.index] && (
        <CrateRevealView
          // Remounting per chest replays the open animation for each one.
          key={crateReveal.index}
          crateId={crateReveal.queue[crateReveal.index].crateId}
          itemIds={crateReveal.queue[crateReveal.index].itemIds}
          crateIndex={crateReveal.index}
          crateTotal={crateReveal.queue.length}
          label={crateReveal.label}
          {...(crateReveal.quickOpenTitle ? { quickOpenTitle: crateReveal.quickOpenTitle } : {})}
          // Everything still unopened, so a big haul can be taken in one go.
          quickOpenItemIds={crateReveal.queue.slice(crateReveal.index).flatMap(c => c.itemIds)}
          onQuickOpen={() => setCrateReveal(null)}
          onClose={() => setCrateReveal(cur =>
            cur && cur.index + 1 < cur.queue.length ? { ...cur, index: cur.index + 1 } : null,
          )}
        />
      )}
      {pendingMilestones.length > 0 && (
        <div className="fixed inset-0 bg-black/90 flex items-center justify-center z-[9999]">
          <div
            className="bg-zinc-900 border-2 border-yellow-500 rounded-xl p-8 max-w-sm w-full mx-4"
            style={{ boxShadow: "0 0 40px rgba(234,179,8,0.3), 0 0 0 1px rgba(234,179,8,0.1)" }}
          >
            <div className="text-center mb-6">
              <div className="text-5xl mb-3">{pendingMilestones[0].icon}</div>
              {pendingMilestones[0].kind === "reward" ? (
                <h2 className="text-white text-lg font-bold mb-3">{pendingMilestones[0].title}</h2>
              ) : (
                <>
                  <p className="text-yellow-400 text-xs font-bold tracking-widest uppercase mb-2">Milestone Reached!</p>
                  <h2 className="text-white text-lg font-bold mb-3">{pendingMilestones[0].title}</h2>
                </>
              )}
              <p className="text-zinc-300 text-sm leading-relaxed">{pendingMilestones[0].description}</p>
              {pendingMilestones.length > 1 && (
                <p className="text-zinc-500 text-xs mt-3">+{pendingMilestones.length - 1} more milestone{pendingMilestones.length > 2 ? "s" : ""} unlocked</p>
              )}
            </div>
            <button
              data-testid="button-milestone-dismiss"
              onClick={() => setPendingMilestones(prev => prev.slice(1))}
              className="w-full py-3 px-4 rounded-lg bg-yellow-500 hover:bg-yellow-400 text-black font-bold uppercase tracking-wide transition-all text-sm"
            >
              {pendingMilestones.length > 1 ? `Next (${pendingMilestones.length - 1} more)` : "Got It!"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
