import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ArrowLeft, Plus, Trash2, BarChart3, ChevronUp, ChevronLeft, ChevronRight, Dumbbell, Target, Trophy, Users, Swords, Pencil, Save, Check, Settings, Lock, Unlock, Download, Upload, Music, ListMusic, Play, Pause, Hammer, RotateCcw, MessageSquare, Copy, ClipboardPaste, Zap } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { SPARRING_MODE_COSTS, grandfatherSparringUnlocks, type SparringMode } from "@/game/sparringModes";
import { Dialog, DialogTrigger, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogClose } from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { MUSIC_TRACK_NAMES } from "@/game/musicTracks";
import { musicEngine } from "@/game/sound";
import type { Fighter, CareerStats, SkillPoints, GearColors, TrainingBonuses, CareerRosterState, RosterFighterState, SkillRefinement } from "@shared/schema";
import { DEFAULT_CAREER_STATS, DEFAULT_GEAR_COLORS, DEFAULT_TRAINING_BONUSES, DEFAULT_SKILL_REFINEMENT, statPointCap, perStatCap, maxActiveRefinementsFor, refinementSlotsForRank, refinementSlotsUnlocked, REFINEMENT_SLOT_RANK_UNLOCKS } from "@shared/schema";
import { migrateStatCaps, updateFighter } from "@/lib/localSaves";
import { claimDailyReward } from "@/lib/dailyReward";
import type { CrateId } from "@/game/cratesConfig";
import GymView, { FORCE_PER_DIAMOND } from "@/components/GymView";
import EquipmentUpgradesView from "@/components/EquipmentUpgradesView";
import { EQUIPMENT, type EquipmentSlot } from "@/game/equipmentConfig";
import { takeEquipmentUnlockAnnouncement } from "@/lib/equipmentUpgrades";
import { diamondLevelUpCost } from "@/game/diamondLevelCost";
import ActiveBoostsHud from "@/components/ActiveBoostsHud";
import { hasPerk, countPerk, getForceMult } from "@/game/itemEffects";
import { computeForceEarned } from "@/game/forceRewards";
import { withSavedInventory } from "@/lib/itemInventory";
import { SPACIAL_COLOR, SPACIAL_GEAR_KEYS, SPACIAL_PRICE_PER_GEAR_FORCE, applySpacialGear, cssColorOf, isSpacial, spacialOwnedOf, spacialSelectionOf } from "@/game/spacialColor";
import { DEFAULT_RING_COLORS, RING_COLOR_KEYS, RING_COLOR_LABELS, RING_SPACIAL_PRICE_FORCE, ringColorsOf, type RingColorKey, type RingColors } from "@/game/ringColors";
import RingOnlyBackground from "@/components/RingOnlyBackground";
import { useState, useEffect, useRef, useCallback, type ReactNode } from "react";
import LoadingScreen from "@/components/LoadingScreen";
import { useChunkedLoader } from "@/lib/useChunkedLoader";
import { Archetype, ARCHETYPE_STATS, AIDifficulty, AI_DIFFICULTY_LABELS, FighterColors, SKIN_COLOR_PRESETS, COLOR_PRESETS } from "@/game/types";
import { xpToNextLevel } from "@/game/engine";
import { listedDrilledActions, normalizeDrilledActions, describeDrilledAction, drilledTierLabel, drilledNextTierAt, drilledUpkeepOf } from "@/game/drilledActions";
import {
  refCurve, refNum,
  precisionStrikerRangeBonus, slipperyRepunchThreshold, chinHitterChargeMult, technicianWhiffForgiveness,
} from "@/game/refinementTuning";
import { SkinColorField } from "@/components/ColorPicker";
import { defaultLaceColor, defaultSoleColor, defaultWaistStripeColor } from "@/game/renderer";
import { STAT_POINTS_PER_LEVEL } from "@/game/career";
import {
  getOpponentCandidates,
  isExpandedOpponentBoard,
  ensureEndgamePool,
  buildOpponentFromRoster,
  getRosterEntryById,
  initRosterState,
  computePlayerRankFromRating,
  redistributeRosterLevels,
  applyRefinementGenV3,
  applyRefinementFiveCap,
  backfillMissingRefinements,
  backfillPunchEndurance,
  backfillDrilledActions,
  mergeNewFightersIntoRoster,
  ensureOffenseProfiles,
  saveRosterCustomizations,
  applyRosterCustomizations,
  clearRosterCustomizationNumbers,
  getRosterFighterColors,
  isChampBeaten,
  updateRankings,
  respawnRetiredFighters,
  resolveRank1Holder,
  getChampionPrepSchedule,
  getHiddenStatKeys,
  demotePlayerOneRank,
  saveRankEdits,
  applyRankEditsToRoster,
  type CareerOpponentFromRoster,
} from "@/game/careerRoster";
import { getRosterDisplayName, ROSTER_DATA, KEY_FIGHTER_IDS } from "@/game/rosterData";
import FighterStanceCanvas from "@/components/FighterStanceCanvas";
import { BoxingGloveIcon } from "@/components/BoxingGloveIcon";
import NeuralNetworkView, { fighterHasNeural } from "@/components/NeuralNetworkView";
import * as localSaves from "@/lib/localSaves";

export type TrainingType = "weightLifting" | "heavyBag" | "sparring";

interface CareerModeProps {
  fighters: Fighter[];
  onSelectFighter: (fighter: Fighter, opponentId: number) => void;
  onCreateFighter: (data: {
    firstName: string;
    nickname: string;
    lastName: string;
    archetype: Archetype;
    careerDifficulty: AIDifficulty;
    roundLengthMins: number;
    skinColor: string;
    gearColors: GearColors;
    boxingStance: "orthodox" | "southpaw";
  }) => void;
  onDeleteFighter: (id: string) => void;
  onBack: () => void;
  onAllocateStats: (fighterId: string, skillPoints: SkillPoints, spent: number) => void;
  onStartTraining: (fighter: Fighter, type: TrainingType, sparringDifficulty?: AIDifficulty, importedPartnerId?: number) => void;
  onEndWeek?: () => void;
  onSimulateWeek?: (fighter: Fighter) => void;
  onSweepTraining?: (fighter: Fighter, type: "weightLifting" | "heavyBag") => void;
  onStartNightmare?: (fighter: Fighter) => void;
  onStartDoghouse?: (fighter: Fighter) => void;
  onSelectOpponent: (fighterId: string, opponentId: number) => void;
  onInitRoster: (fighterId: string, rosterState: CareerRosterState) => void;
  /**
   * Today's daily reward chests, already rolled, granted and persisted here.
   * The parent only announces them and runs the reveal.
   */
  onDailyReward?: (crates: { crateId: CrateId; itemIds: string[] }[]) => void;
  onUpdateColors?: (fighterId: string, skinColor: string, gearColors: GearColors, spacialParts?: string[]) => void;
  isLoading: boolean;
  careerRefStoppageEnabled: boolean;
  onToggleCareerRefStoppage: (enabled: boolean) => void;
  careerTowelStoppageEnabled: boolean;
  onToggleCareerTowelStoppage: (enabled: boolean) => void;
  careerFightMusicEnabled: boolean;
  onToggleCareerFightMusic: (enabled: boolean) => void;
  careerFightMusicTrack: number;
  onSelectCareerFightMusic: (idx: number) => void;
  onTutorial?: (name: string, colors: FighterColors) => void;
  onUnlockRefinement?: (fighterId: string, track: "offense" | "defense" | "fightIq") => void;
  onAllocateRefinement?: (fighterId: string, refinement: SkillRefinement, forceCost?: number, diamondCost?: number, shardCost?: number) => void;
  onForceSpend?: (fighterId: string, amount: number) => void;
  onShardSpend?: (fighterId: string, amount: number) => void;
  onDiamondSpend?: (fighterId: string, amount: number) => void;
  /** Freshly persisted save after a Locker sale or item use — replaces stale snapshots. */
  onFighterRefresh?: (fighter: Fighter) => void;
  showExpBar: boolean;
  onToggleShowExpBar: (enabled: boolean) => void;
  showFightItemsHud: boolean;
  onToggleShowFightItemsHud: (enabled: boolean) => void;
}

type CareerView = "slots" | "create" | "generating" | "hub" | "stats" | "allocate" | "opponents" | "rankings" | "rosterEdit" | "editColors" | "editRingColors" | "sparringSelect" | "prepWeeks" | "reschedule" | "refinement" | "negotiate" | "gym" | "equipment";

const MAX_SLOTS = 1;
const PIN_STORAGE_KEY = "handz_career_pins";
const PIN_LOCK_KEY = "handz_career_pin_locks";

function getPinStore(): Record<string, string> {
  try { const raw = localStorage.getItem(PIN_STORAGE_KEY); return raw ? JSON.parse(raw) : {}; } catch { return {}; }
}
function savePinStore(store: Record<string, string>) {
  localStorage.setItem(PIN_STORAGE_KEY, JSON.stringify(store));
}
function getFighterPin(fighterId: string): string | null {
  return getPinStore()[fighterId] || null;
}
function setFighterPin(fighterId: string, pin: string) {
  const store = getPinStore(); store[fighterId] = pin; savePinStore(store);
}
function removeFighterPin(fighterId: string) {
  const store = getPinStore(); delete store[fighterId]; savePinStore(store);
}
function getLockStore(): Record<string, boolean> {
  try { const raw = localStorage.getItem(PIN_LOCK_KEY); return raw ? JSON.parse(raw) : {}; } catch { return {}; }
}
function isPinLocked(fighterId: string): boolean {
  const locks = getLockStore();
  return locks[fighterId] !== false;
}
function setPinLocked(fighterId: string, locked: boolean) {
  const locks = getLockStore(); locks[fighterId] = locked; localStorage.setItem(PIN_LOCK_KEY, JSON.stringify(locks));
}

type PinFlowMode = "setNew" | "confirmNew" | "enterLoad" | "enterDelete" | "enterChange" | "setChangeNew" | "confirmChangeNew";

type RefField = "pressureFighter" | "precisionStriker" | "jabPower" | "hookPower" | "uppercutPower" | "bruiser" | "koArtist" | "ironChin" | "slippery" | "guardMaster" | "duckRecovery" | "punchRolling" | "fastTwitch" | "heartRefinement" | "chinHitter" | "technician" | "lifeDrain";
const REF_FIELDS: RefField[] = ["pressureFighter", "precisionStriker", "jabPower", "hookPower", "uppercutPower", "bruiser", "koArtist", "ironChin", "slippery", "guardMaster", "duckRecovery", "punchRolling", "fastTwitch", "heartRefinement", "chinHitter", "technician", "lifeDrain"];
/**
 * Freshest stored roster state for a save, falling back to the caller's copy.
 * Editor screens keep the snapshot they mounted with, so merging their edits
 * onto the stored state stops an out-of-band rewrite (a Roster Generation
 * regeneration, say) from being rolled back by a later save from that screen.
 */
function mergeBaseRosterState(fighterId: string, fallback: CareerRosterState): CareerRosterState {
  try {
    const stored = localSaves.getFighter(fighterId)?.careerRosterState as CareerRosterState | null | undefined;
    if (stored && Array.isArray(stored.roster) && stored.roster.length > 0) return stored;
  } catch { /* fall through to the in-memory copy */ }
  return fallback;
}

function calcAllocated(r: SkillRefinement): number {
  return REF_FIELDS.reduce((s, k) => s + ((r[k] as number) || 0), 0);
}

export function refinementExchangeCost(level: number, costReduction: number = 0): number {
  return Math.max(1, baseRefinementExchangeCost(level) - Math.max(0, costReduction));
}

export function baseRefinementExchangeCost(level: number): number {
  if (level >= 500) return 2;
  if (level >= 350) return 3;
  if (level >= 250) return 4;
  if (level >= 170) return 5;
  if (level >= 120) return 6;
  if (level >= 80) return 7;
  if (level >= 70) return 8;
  if (level >= 60) return 9;
  return 10;
}

function fmtPct(fraction: number): string {
  const v = Math.round(fraction * 1000) / 10;
  return Number.isInteger(v) ? v.toFixed(0) : v.toFixed(1);
}

/** Lifetime career reschedules: 2 by default, +1 per Challenge Clause owned (they stack). */
const BASE_CAREER_RESCHEDULES = 2;
function careerRescheduleAllowance(
  fighter: Fighter | null | undefined,
  rosterState: CareerRosterState | null | undefined,
): number {
  return BASE_CAREER_RESCHEDULES + countPerk(fighter, "extraReschedule", rosterState);
}

const REF_EFFECT_DESC: Record<RefField, (lvl: number) => string> = {
  pressureFighter: (lvl) => {
    const dmg = refCurve("pressureFighter", "damage", lvl) * refNum("pressureFighter", "powerScale");
    const chance = refCurve("pressureFighter", "cutChance", lvl);
    return `+${fmtPct(dmg)}% punch power, ${fmtPct(chance)}% rhythm cut chance`;
  },
  precisionStriker: (lvl) => {
    const crit = refCurve("precisionStriker", "crit", lvl);
    const stamina = Math.min(1 - refNum("precisionStriker", "staminaCostFloor"), refCurve("precisionStriker", "staminaCost", lvl));
    const range = precisionStrikerRangeBonus(lvl);
    const dodge = refCurve("precisionStriker", "dodgeNegate", lvl);
    return `+${fmtPct(crit)}% crit, −${fmtPct(stamina)}% stamina/punch, +${range} range, −${fmtPct(dodge)}% opponent dodge`;
  },
  jabPower: (lvl) => {
    const dmg = refCurve("jabPower", "damage", lvl) * refNum("jabPower", "powerScale");
    const bypass = refCurve("jabPower", "chargeBypass", lvl);
    const ignore = refCurve("jabPower", "blockIgnore", lvl);
    return `Jab & Cross +${fmtPct(dmg)}% DMG, -${fmtPct(bypass)}% Charge Block, ${fmtPct(ignore)}% ignore block`;
  },
  hookPower: (lvl) => {
    const dmg = refCurve("hookPower", "damage", lvl) * refNum("hookPower", "powerScale");
    const bypass = refCurve("hookPower", "chargeBypass", lvl);
    const ignore = refCurve("hookPower", "blockIgnore", lvl);
    return `Hook +${fmtPct(dmg)}% DMG, -${fmtPct(bypass)}% Charge Block, ${fmtPct(ignore)}% ignore block`;
  },
  uppercutPower: (lvl) => {
    const dmg = refCurve("uppercutPower", "damage", lvl) * refNum("uppercutPower", "powerScale");
    const bypass = refCurve("uppercutPower", "chargeBypass", lvl);
    const ignore = refCurve("uppercutPower", "blockIgnore", lvl);
    return `Uppercut +${fmtPct(dmg)}% DMG, -${fmtPct(bypass)}% Charge Block, ${fmtPct(ignore)}% ignore block`;
  },
  bruiser: (lvl) => `${fmtPct(refCurve("bruiser", "blockIgnore", lvl))}% chance for a punch to ignore block when thrown on either side of their sway`,
  koArtist: (lvl) => {
    const perSec = refCurve("koArtist", "chargePerSec", lvl);
    const secsPerBar = 100 / perSec;
    const barTime = secsPerBar >= 10 ? secsPerBar.toFixed(0) : secsPerBar.toFixed(1);
    return `charge meter fills ${fmtPct(perSec / 100)}% of a bar per second on its own (a bar every ${barTime}s) — stops while anyone is down`;
  },
  ironChin: (lvl) => {
    const stun = refCurve("ironChin", "stunResist", lvl);
    const dmg = refCurve("ironChin", "damageReduction", lvl);
    const slowReduc = refCurve("ironChin", "stunDelay", lvl);
    return `-${fmtPct(stun)}% stun chance against you, takes ${fmtPct(dmg)}% less punch damage (adds with Punch Rolling), -${slowReduc.toFixed(2)}s stun turn delay`;
  },
  slippery: (lvl) => {
    const slipSpeed = `+${fmtPct(refCurve("slippery", "slipSpeed", lvl))}% slip speed`;
    const threshold = slipperyRepunchThreshold(lvl);
    return threshold ? `${slipSpeed}, opponent gets repunch penalty after ${threshold} punches within ${refNum("slippery", "proximityPx")}px` : slipSpeed;
  },
  guardMaster: (lvl) => {
    const base = `+${fmtPct(refCurve("guardMaster", "blockMult", lvl))}% block effectiveness`;
    return lvl >= refNum("guardMaster", "pbIgnoresVulnLevel") ? `${base}, perfect block works during rhythm vulnerability` : base;
  },
  duckRecovery: (lvl) => `${fmtPct(refCurve("duckRecovery", "regen", lvl))}% stamina regen speed while ducking`,
  punchRolling: (lvl) => `incoming punches deal ${fmtPct(1 - refCurve("punchRolling", "damageTaken", lvl))}% damage, opponent's repunch penalty is +${fmtPct(refCurve("punchRolling", "repunchBoost", lvl))}% effective, ${fmtPct(refCurve("punchRolling", "bigShotNegate", lvl))}% chance to shrug off a Big Shot (takes normal damage instead)`,
  fastTwitch: (lvl) => {
    const telegraph = refCurve("fastTwitch", "telegraph", lvl);
    const moveSpeed = Math.min(100, Math.max(0, lvl)) * refNum("fastTwitch", "movePerLevel");
    return `-${fmtPct(telegraph)}% telegraph, +${fmtPct(moveSpeed)}% move speed`;
  },
  heartRefinement: (lvl) => {
    const stamina = refCurve("heartRefinement", "stamina", lvl);
    const repunch = refCurve("heartRefinement", "repunchPenalty", lvl);
    return `+${fmtPct(stamina)}% stamina, repunch penalties ${lvl > 0 ? fmtPct(repunch) : "0"}% as effective`;
  },
  chinHitter: (lvl) => {
    const stun = refCurve("chinHitter", "stun", lvl);
    const vuln = refCurve("chinHitter", "vuln", lvl);
    const chargeMult = chinHitterChargeMult(lvl);
    return `+${fmtPct(stun)}% stun chance, +${fmtPct(vuln)}% rhythm vuln, ${chargeMult.toFixed(2)}x charge punch dmg`;
  },
  technician: (lvl) => {
    const stun = refCurve("technician", "rcStun", lvl);
    const forgive = technicianWhiffForgiveness(lvl);
    const retries = forgive > 0 ? `, ${forgive} free charge whiff${forgive === 1 ? "" : "s"}` : "";
    const unlock = lvl >= refNum("technician", "feintCancelLevel") ? " — feint-cancel unlocked" : "";
    return `${fmtPct(stun)}% chance a landed rhythm cut stuns${retries}${unlock}`;
  },
  lifeDrain: (lvl) => `every punch that lands restores ${fmtPct(refCurve("lifeDrain", "drain", lvl))}% of max stamina — blocked punches still pay out, only a perfect block denies it; paused while a debuff has your stamina regen stopped`,
};

const HOLD_REPEAT_DELAY_MS = 500;
const HOLD_REPEAT_INTERVAL_MS = 50;

function useHoldRepeat(action: () => void) {
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const repeatedRef = useRef(false);
  const actionRef = useRef(action);
  actionRef.current = action;

  const clear = () => {
    if (timeoutRef.current !== null) { clearTimeout(timeoutRef.current); timeoutRef.current = null; }
    if (intervalRef.current !== null) { clearInterval(intervalRef.current); intervalRef.current = null; }
    window.removeEventListener("mouseup", clear);
    window.removeEventListener("touchend", clear);
    window.removeEventListener("touchcancel", clear);
  };

  const start = () => {
    clear();
    repeatedRef.current = false;
    window.addEventListener("mouseup", clear);
    window.addEventListener("touchend", clear);
    window.addEventListener("touchcancel", clear);
    timeoutRef.current = setTimeout(() => {
      intervalRef.current = setInterval(() => {
        repeatedRef.current = true;
        actionRef.current();
      }, HOLD_REPEAT_INTERVAL_MS);
    }, HOLD_REPEAT_DELAY_MS);
  };

  const handleClick = () => {
    if (repeatedRef.current) {
      repeatedRef.current = false;
      return;
    }
    actionRef.current();
  };

  useEffect(() => clear, []);

  return {
    onMouseDown: start,
    onMouseLeave: clear,
    onTouchStart: start,
    onClick: handleClick,
  };
}

const FIELD_TO_TRACK: Record<RefField, "offense" | "defense" | "fightIq"> = {
  pressureFighter: "offense", precisionStriker: "offense", jabPower: "offense", hookPower: "offense", uppercutPower: "offense",
  bruiser: "offense", koArtist: "offense",
  ironChin: "defense", slippery: "defense", guardMaster: "defense", duckRecovery: "defense", punchRolling: "defense",
  fastTwitch: "fightIq", heartRefinement: "fightIq", chinHitter: "fightIq", technician: "fightIq",
  lifeDrain: "fightIq",
};

export function refUnlockForceCost(track: "offense" | "defense" | "fightIq"): number {
  return track === "fightIq" ? 150_000 : track === "defense" ? 100_000 : 50_000;
}
/** Shards charged on top of Force to unlock a refinement track. Striking is Force-only. */
export function refUnlockShardCost(track: "offense" | "defense" | "fightIq"): number {
  return track === "fightIq" ? 100_000 : track === "defense" ? 50_000 : 0;
}
/** @deprecated renamed to refUnlockForceCost */
export const refUnlockFocusCost = refUnlockForceCost;

/**
 * Shard price of the levels that sit between the diamond gates. Level 51 is the
 * first and costs 10,000; every in-between level after it costs 10% more than
 * the one before, through level 99. The gate levels (50/60/70/80/90) and every
 * level at or below 50 cost no shards.
 */
export function shardCostForRefLevel(level: number): number {
  if (level < 51 || level > 99 || level % 10 === 0) return 0;
  // How many in-between levels came before this one, counting 51 as the first.
  const stepsFrom51 = (level - 50) - (Math.floor(level / 10) - 5) - 1;
  return Math.round(10_000 * Math.pow(1.1, stepsFrom51));
}

export function forceCostForRefLevel(track: "offense" | "defense" | "fightIq", level: number): { force: number; diamonds: number; shards: number } {
  if (level <= 10) return { force: 0, diamonds: 0, shards: 0 };
  // All refinement tracks: level 11 costs 250 Force, each subsequent level costs 1.075x the last.
  // Cost(L) = 250 * 1.075^(L - 11) for L = 11..100.
  const force = Math.round(250 * Math.pow(1.075, level - 11));
  const shards = shardCostForRefLevel(level);
  // Every tenth level from 50 to 90 is a diamond gate: 5 diamonds on top of the
  // Force price. The levels in between cost Force plus shards.
  if (level <= 90) {
    const isGate = level >= 50 && level % 10 === 0;
    return { force, diamonds: isGate ? 5 : 0, shards };
  }
  const diamondCost = track === "fightIq" ? 2 : 1;
  return { force, diamonds: diamondCost, shards };
}

/**
 * Shard price of guaranteeing a negotiation: 10,000 for the first, and 10%
 * more than the last for every guarantee bought after it.
 */
export const GUARANTEE_NEGOTIATE_BASE_SHARDS = 50_000;
export function computeGuaranteeNegotiateShardCost(timesUsed: number): number {
  return Math.round(GUARANTEE_NEGOTIATE_BASE_SHARDS * Math.pow(1.1, Math.max(0, timesUsed)));
}

/** One currency in a refinement's next-level price. `short` is true only when
 *  the player can't cover THAT currency, so it alone turns red. */
type RefCostPart = { text: string; short: boolean };

/** Compact currency amount for the tiny cost label under the + button. */
function fmtRefCost(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(0) + "k";
  return String(n);
}

function RefSkillRow({ label, field, locked, localRef, savedRef, availPts, onInc, onDec, nextCostParts, forceLocked, active, onToggleActive, activeFull }: {
  label: string; field: RefField; locked: boolean;
  localRef: SkillRefinement; savedRef: SkillRefinement; availPts: number;
  onInc: (f: RefField) => void; onDec: (f: RefField) => void;
  nextCostParts?: RefCostPart[];
  forceLocked?: boolean;
  active: boolean;
  onToggleActive: (f: RefField) => void;
  activeFull: boolean;
}) {
  const val = localRef[field] as number;
  const savedVal = savedRef[field] as number;
  const effectDesc = REF_EFFECT_DESC[field](val);
  const decHold = useHoldRepeat(() => onDec(field));
  const incHold = useHoldRepeat(() => onInc(field));
  const incDisabled = locked || forceLocked || availPts <= 0 || val >= 100;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <Checkbox
          checked={active}
          disabled={locked || (!active && activeFull)}
          onCheckedChange={() => onToggleActive(field)}
          className="flex-shrink-0"
          data-testid={`checkbox-active-${field}`}
        />
        <span className="text-sm font-medium flex-1 min-w-0">{label}</span>
        <div className="flex items-center gap-1 flex-shrink-0">
          <Button variant="outline" size="icon" className="h-7 w-7 text-base"
            disabled={locked || val <= savedVal} data-testid={`button-dec-${field}`} {...decHold}>−</Button>
          <span className="w-8 text-center font-mono font-bold text-sm">{val}</span>
          <div className="flex flex-col items-center">
            <Button variant="outline" size="icon" className="h-7 w-7 text-base"
              disabled={incDisabled} data-testid={`button-inc-${field}`} {...incHold}>+</Button>
            {nextCostParts && nextCostParts.length > 0 && !locked && val < 100 && (
              <span className="text-[8px] leading-none mt-0.5 whitespace-nowrap" data-testid={`text-cost-${field}`}>
                {nextCostParts.map((part, i) => (
                  <span key={i} className={part.short ? "text-red-500 font-bold" : "text-yellow-400"}>{i > 0 ? " " : ""}{part.text}</span>
                ))}
              </span>
            )}
          </div>
        </div>
      </div>
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="w-full h-2.5 rounded-full bg-muted overflow-hidden cursor-help" data-testid={`bar-${field}`}>
            <div
              className="h-full bg-blue-500 rounded-full transition-all"
              style={{ width: `${Math.max(0, Math.min(100, val))}%` }}
            />
          </div>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-[240px] text-xs leading-snug" data-testid={`tooltip-${field}`}>
          {effectDesc}
        </TooltipContent>
      </Tooltip>
    </div>
  );
}

/** The player's gear colours, spacial finish resolved — what every career-side preview is drawn with. */
export function careerFighterColors(f: Fighter): FighterColors {
  const gear = f.gearColors as GearColors | null;
  return applySpacialGear({
    gloves: gear?.gloves || DEFAULT_GEAR_COLORS.gloves,
    gloveTape: gear?.gloveTape || DEFAULT_GEAR_COLORS.gloveTape,
    trunks: gear?.trunks || DEFAULT_GEAR_COLORS.trunks,
    shoes: gear?.shoes || DEFAULT_GEAR_COLORS.shoes,
    skin: f.skinColor || "#e8c4a0",
    headgear: gear?.headgear || DEFAULT_GEAR_COLORS.headgear,
    socks: gear?.socks || DEFAULT_GEAR_COLORS.socks,
    laces: gear?.laces,
    soles: gear?.soles,
    waistStripe: gear?.waistStripe,
  }, spacialSelectionOf(f));
}

export function RefinementView({ fighter, onAllocate, onUnlock, onBack, onSetActiveRefinements, onUnlockSlots, bypassLocks, playerRank, onStatExchange, exchangeCost = 10, onBuyCostReduction, playerForce = 0, playerDiamonds = 0, playerFocus = 0, playerShards = 0 }: {
  fighter: Fighter;
  onAllocate: (ref: SkillRefinement, forceCost?: number, diamondCost?: number, shardCost?: number) => void;
  onUnlock: (track: "offense" | "defense" | "fightIq") => void;
  onBack: () => void;
  onSetActiveRefinements?: (list: string[]) => void;
  onUnlockSlots?: (count: number) => void;
  bypassLocks?: boolean;
  playerRank?: number;
  onStatExchange?: () => void;
  exchangeCost?: number;
  onBuyCostReduction?: () => void;
  playerForce?: number;
  playerDiamonds?: number;
  playerFocus?: number;
  playerShards?: number;
}) {
  const savedRef: SkillRefinement = { ...DEFAULT_SKILL_REFINEMENT, ...((fighter.skillRefinement || {}) as Partial<SkillRefinement>) };
  const [localRef, setLocalRef] = useState<SkillRefinement>(savedRef);
  const [unlockConfirmTrack, setUnlockConfirmTrack] = useState<{ track: "offense" | "defense" | "fightIq"; cost: number; shardCost: number; label: string } | null>(null);
  const [buyReductionConfirmOpen, setBuyReductionConfirmOpen] = useState(false);
  const [pendingForce, setPendingForce] = useState(0);
  const [pendingDiamonds, setPendingDiamonds] = useState(0);
  const [pendingShards, setPendingShards] = useState(0);

  const pendingSpend = calcAllocated(localRef) - calcAllocated(savedRef);
  const availPts = savedRef.availablePoints - pendingSpend;
  // Never show a negative pool: a bad write in an older save could leave it below
  // zero, which reads as "-1 SP" and disables the exchange for good.
  const availSP = Math.max(0, fighter.availableStatPoints ?? 0);

  const inc = (field: RefField) => {
    const currentLevel = localRef[field] as number;
    if (currentLevel >= 100 || availPts <= 0) return;
    const nextLevel = currentLevel + 1;
    const track = FIELD_TO_TRACK[field];
    const { force: fc, diamonds: dc, shards: sc } = forceCostForRefLevel(track, nextLevel);
    if (fc > 0 && pendingForce + fc > playerForce) return;
    if (dc > 0 && pendingDiamonds + dc > playerDiamonds) return;
    if (sc > 0 && pendingShards + sc > playerShards) return;
    setLocalRef(r => ({ ...r, [field]: nextLevel }));
    if (fc > 0) setPendingForce(f => f + fc);
    if (dc > 0) setPendingDiamonds(d => d + dc);
    if (sc > 0) setPendingShards(s => s + sc);
  };
  const dec = (field: RefField) => {
    const currentLevel = localRef[field] as number;
    if (currentLevel <= (savedRef[field] as number)) return;
    const track = FIELD_TO_TRACK[field];
    const { force: fc, diamonds: dc, shards: sc } = forceCostForRefLevel(track, currentLevel);
    setLocalRef(r => ({ ...r, [field]: currentLevel - 1 }));
    if (fc > 0) setPendingForce(f => Math.max(0, f - fc));
    if (dc > 0) setPendingDiamonds(d => Math.max(0, d - dc));
    if (sc > 0) setPendingShards(s => Math.max(0, s - sc));
  };
  // The handful a fighter brings into the ring — five to start with, one more
  // at each Refinement Slot rank. The rank is checked live so a career that
  // climbed past a threshold before the slots existed is caught up here rather
  // than having to win another fight; the effect below stamps the save to match.
  // Held on the local copy so an unsaved level purchase sitting on the screen
  // survives a toggle, and written straight through so the pick is saved the
  // moment it is made.
  const storedSlots = refinementSlotsUnlocked(localRef);
  const rankSlots = refinementSlotsForRank(playerRank);
  const unlockedSlots = Math.max(storedSlots, rankSlots);
  const maxActive = maxActiveRefinementsFor({ activeSlotsUnlocked: unlockedSlots });
  useEffect(() => {
    if (rankSlots <= storedSlots) return;
    setLocalRef(r => ({ ...r, activeSlotsUnlocked: rankSlots }));
    onUnlockSlots?.(rankSlots);
    // Re-runs only when the counts move; the stamp raises storedSlots, which ends it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rankSlots, storedSlots]);
  const activeList: string[] = Array.isArray(localRef.activeRefinements)
    ? localRef.activeRefinements.filter(k => REF_FIELDS.includes(k as RefField)).slice(0, maxActive)
    : [];
  const activeFull = activeList.length >= maxActive;
  const toggleActive = (field: RefField) => {
    const has = activeList.includes(field);
    if (!has && activeFull) return;
    const next = has ? activeList.filter(k => k !== field) : [...activeList, field];
    setLocalRef(r => ({ ...r, activeRefinements: next }));
    onSetActiveRefinements?.(next);
  };

  const exchangeHold = useHoldRepeat(() => onStatExchange?.());

  const confirmUnlock = () => {
    if (!unlockConfirmTrack) return;
    const { track } = unlockConfirmTrack;
    const unlockKey = track === "offense" ? "offenseUnlocked" : track === "defense" ? "defenseUnlocked" : "fightIqUnlocked";
    setLocalRef(r => ({ ...r, [unlockKey]: true }));
    onUnlock(track);
    setUnlockConfirmTrack(null);
  };

  const getNextCostParts = (field: RefField): RefCostPart[] | undefined => {
    const val = localRef[field] as number;
    if (val >= 100) return undefined;
    const nextLevel = val + 1;
    if (nextLevel <= 10) return undefined;
    const track = FIELD_TO_TRACK[field];
    const { force: fc, diamonds: dc, shards: sc } = forceCostForRefLevel(track, nextLevel);
    if (fc === 0 && dc === 0 && sc === 0) return undefined;
    // Each currency is judged on its own balance (with the unsaved pending spend
    // included), so being short on Diamonds never reddens an affordable Force cost.
    // Out of points means nothing is blocked by price, so nothing goes red.
    const spendable = availPts > 0;
    const parts: RefCostPart[] = [];
    if (fc > 0) parts.push({ text: `⚡${fmtRefCost(fc)}`, short: spendable && pendingForce + fc > playerForce });
    if (dc > 0) parts.push({ text: `💎${dc}`, short: spendable && pendingDiamonds + dc > playerDiamonds });
    if (sc > 0) parts.push({ text: `🔷${fmtRefCost(sc)}`, short: spendable && pendingShards + sc > playerShards });
    return parts;
  };

  const getFieldForceLocked = (field: RefField): boolean => {
    const val = localRef[field] as number;
    if (val >= 100 || availPts <= 0) return false;
    const track = FIELD_TO_TRACK[field];
    const { force: fc, diamonds: dc, shards: sc } = forceCostForRefLevel(track, val + 1);
    return (fc > 0 && pendingForce + fc > playerForce)
      || (dc > 0 && pendingDiamonds + dc > playerDiamonds)
      || (sc > 0 && pendingShards + sc > playerShards);
  };

  const TrackHeader = ({ label, track, color }: { label: string; track: "offense" | "defense" | "fightIq"; color: string }) => {
    const isUnlocked = bypassLocks || (track === "offense" ? localRef.offenseUnlocked : track === "defense" ? localRef.defenseUnlocked : localRef.fightIqUnlocked);
    const forceCost = refUnlockForceCost(track);
    const shardCost = refUnlockShardCost(track);
    const canAfford = playerForce >= forceCost && playerShards >= shardCost;
    return (
      <div className="flex items-center justify-between">
        <span className={`font-bold text-sm uppercase tracking-wider ${color}`}>{label}</span>
        {!isUnlocked ? (
          <Button size="sm" variant="secondary" className="text-xs gap-1 h-7"
            disabled={!canAfford}
            onClick={() => setUnlockConfirmTrack({ track, cost: forceCost, shardCost, label })}
            data-testid={`button-unlock-${track}`}>
            <Lock className="w-3 h-3" /> Unlock (⚡{forceCost.toLocaleString()}{shardCost > 0 ? ` · 🔷${shardCost.toLocaleString()}` : " Force"})
          </Button>
        ) : bypassLocks ? (
          <span className="text-xs text-emerald-400 flex items-center gap-1"><Unlock className="w-3 h-3" /> Bypassed</span>
        ) : (
          <span className="text-xs text-green-500 flex items-center gap-1"><Unlock className="w-3 h-3" /> Unlocked</span>
        )}
      </div>
    );
  };

  const offLocked = !bypassLocks && !localRef.offenseUnlocked;
  const defLocked = !bypassLocks && !localRef.defenseUnlocked;
  const iqLocked = !bypassLocks && !localRef.fightIqUnlocked;

  return (
    <div className="flex flex-col items-center min-h-screen pt-4 pb-24 px-4 gap-4 overflow-y-auto">
      <div className="flex items-center gap-2 w-full max-w-md">
        <Button variant="ghost" size="icon" onClick={onBack} data-testid="button-refinement-back">
          <ArrowLeft className="w-5 h-5" />
        </Button>
        <h2 className="text-lg font-bold flex-1">Skill Refinement</h2>
        <div className="flex flex-col items-end">
          <span className="text-lg font-mono font-bold text-yellow-400">{availPts}</span>
          <span className="text-[10px] text-muted-foreground">pts available</span>
        </div>
      </div>

      {onStatExchange && (
        <div className="w-full max-w-md">
          <Card className="p-2 flex items-center justify-between gap-2">
            <div className="flex flex-col">
              <span className="text-xs font-semibold text-purple-400">Stat → Refinement Exchange</span>
              <span className="text-[10px] text-muted-foreground">{exchangeCost} stat points → 1 refinement point</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">{availSP} SP</span>
              <Button size="sm" variant="outline" className="text-xs h-7 border-purple-500 text-purple-400 hover:bg-purple-950"
                disabled={availSP < exchangeCost}
                data-testid="button-stat-exchange"
                {...exchangeHold}>
                Exchange
              </Button>
            </div>
          </Card>
          {/* Fully bought out — the exchange can't go below 1 SP, so the whole
              card goes away rather than sitting there permanently greyed out.
              Base cost bottoms out at 2 SP (level 500+), so reaching 1 always
              means at least one diamond was spent: a fresh save never hides it.
              Base cost only ever falls with level, so this can't come back. */}
          {exchangeCost > 1 && (
            <Card className="p-2 mt-2 flex items-center justify-between gap-2">
              <div className="flex flex-col">
                <span className="text-xs font-semibold text-cyan-400">💎 Lower Exchange Cost</span>
                <span className="text-[10px] text-muted-foreground">
                  {`Spend 1 Diamond → cost drops to ${exchangeCost - 1} SP per point (permanent)`}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground" data-testid="text-refinement-diamonds">{playerDiamonds} 💎</span>
                <Button size="sm" variant="outline" className="text-xs h-7 border-cyan-500 text-cyan-400 hover:bg-cyan-950"
                  disabled={!onBuyCostReduction || playerDiamonds < 1}
                  onClick={() => setBuyReductionConfirmOpen(true)}
                  data-testid="button-buy-cost-reduction">
                  -1 SP Cost
                </Button>
              </div>
            </Card>
          )}
        </div>
      )}

      <div className="w-full max-w-md">
        <Card className="p-2 flex items-center justify-between gap-2">
          <div className="flex flex-col">
            <span className="text-xs font-semibold text-sky-300">🔷 Refinement Slots</span>
            <span className="text-[10px] text-muted-foreground" data-testid="text-active-slots">
              {activeList.length}/{maxActive} slots active in the ring
            </span>
          </div>
          <span className="text-xs text-muted-foreground" data-testid="text-slot-rank">
            {playerRank && playerRank > 0 ? `Rank #${playerRank}` : "Unranked"}
          </span>
        </Card>
      </div>

      <div className="w-full max-w-md space-y-2">
        <TrackHeader label="Striking Refinement" track="offense" color="text-orange-400" />
        <Card className={`p-3 space-y-3${offLocked ? " opacity-40" : ""}`}>
          <RefSkillRow label="Pressure Fighter" field="pressureFighter" locked={offLocked}
            localRef={localRef} savedRef={savedRef} availPts={availPts} onInc={inc} onDec={dec}
            nextCostParts={getNextCostParts("pressureFighter")} forceLocked={getFieldForceLocked("pressureFighter")} 
            active={activeList.includes("pressureFighter")} onToggleActive={toggleActive} activeFull={activeFull} />
          <RefSkillRow label="Precision Striker" field="precisionStriker" locked={offLocked}
            localRef={localRef} savedRef={savedRef} availPts={availPts} onInc={inc} onDec={dec}
            nextCostParts={getNextCostParts("precisionStriker")} forceLocked={getFieldForceLocked("precisionStriker")} 
            active={activeList.includes("precisionStriker")} onToggleActive={toggleActive} activeFull={activeFull} />
          <RefSkillRow label="Straight Punch" field="jabPower" locked={offLocked}
            localRef={localRef} savedRef={savedRef} availPts={availPts} onInc={inc} onDec={dec}
            nextCostParts={getNextCostParts("jabPower")} forceLocked={getFieldForceLocked("jabPower")} 
            active={activeList.includes("jabPower")} onToggleActive={toggleActive} activeFull={activeFull} />
          <RefSkillRow label="Hook Power" field="hookPower" locked={offLocked}
            localRef={localRef} savedRef={savedRef} availPts={availPts} onInc={inc} onDec={dec}
            nextCostParts={getNextCostParts("hookPower")} forceLocked={getFieldForceLocked("hookPower")} 
            active={activeList.includes("hookPower")} onToggleActive={toggleActive} activeFull={activeFull} />
          <RefSkillRow label="Uppercut Power" field="uppercutPower" locked={offLocked}
            localRef={localRef} savedRef={savedRef} availPts={availPts} onInc={inc} onDec={dec}
            nextCostParts={getNextCostParts("uppercutPower")} forceLocked={getFieldForceLocked("uppercutPower")} 
            active={activeList.includes("uppercutPower")} onToggleActive={toggleActive} activeFull={activeFull} />
          <RefSkillRow label="Bruiser" field="bruiser" locked={offLocked}
            localRef={localRef} savedRef={savedRef} availPts={availPts} onInc={inc} onDec={dec}
            nextCostParts={getNextCostParts("bruiser")} forceLocked={getFieldForceLocked("bruiser")} 
            active={activeList.includes("bruiser")} onToggleActive={toggleActive} activeFull={activeFull} />
          <RefSkillRow label="KO Artist" field="koArtist" locked={offLocked}
            localRef={localRef} savedRef={savedRef} availPts={availPts} onInc={inc} onDec={dec}
            nextCostParts={getNextCostParts("koArtist")} forceLocked={getFieldForceLocked("koArtist")} 
            active={activeList.includes("koArtist")} onToggleActive={toggleActive} activeFull={activeFull} />
        </Card>
      </div>

      <div className="w-full max-w-md space-y-2">
        <TrackHeader label="Defense Refinement" track="defense" color="text-blue-400" />
        <Card className={`p-3 space-y-3${defLocked ? " opacity-40" : ""}`}>
          <RefSkillRow label="Iron Chin" field="ironChin" locked={defLocked}
            localRef={localRef} savedRef={savedRef} availPts={availPts} onInc={inc} onDec={dec}
            nextCostParts={getNextCostParts("ironChin")} forceLocked={getFieldForceLocked("ironChin")} 
            active={activeList.includes("ironChin")} onToggleActive={toggleActive} activeFull={activeFull} />
          <RefSkillRow label="Slippery" field="slippery" locked={defLocked}
            localRef={localRef} savedRef={savedRef} availPts={availPts} onInc={inc} onDec={dec}
            nextCostParts={getNextCostParts("slippery")} forceLocked={getFieldForceLocked("slippery")} 
            active={activeList.includes("slippery")} onToggleActive={toggleActive} activeFull={activeFull} />
          <RefSkillRow label="Guard Master" field="guardMaster" locked={defLocked}
            localRef={localRef} savedRef={savedRef} availPts={availPts} onInc={inc} onDec={dec}
            nextCostParts={getNextCostParts("guardMaster")} forceLocked={getFieldForceLocked("guardMaster")} 
            active={activeList.includes("guardMaster")} onToggleActive={toggleActive} activeFull={activeFull} />
          <RefSkillRow label="Duck Recovery" field="duckRecovery" locked={defLocked}
            localRef={localRef} savedRef={savedRef} availPts={availPts} onInc={inc} onDec={dec}
            nextCostParts={getNextCostParts("duckRecovery")} forceLocked={getFieldForceLocked("duckRecovery")} 
            active={activeList.includes("duckRecovery")} onToggleActive={toggleActive} activeFull={activeFull} />
          <RefSkillRow label="Punch Rolling" field="punchRolling" locked={defLocked}
            localRef={localRef} savedRef={savedRef} availPts={availPts} onInc={inc} onDec={dec}
            nextCostParts={getNextCostParts("punchRolling")} forceLocked={getFieldForceLocked("punchRolling")} 
            active={activeList.includes("punchRolling")} onToggleActive={toggleActive} activeFull={activeFull} />
        </Card>
      </div>

      <div className="w-full max-w-md space-y-2">
        <TrackHeader label="Sharpness Refinement" track="fightIq" color="text-purple-400" />
        <Card className={`p-3 space-y-3${iqLocked ? " opacity-40" : ""}`}>
          <RefSkillRow label="Fast Twitch" field="fastTwitch" locked={iqLocked}
            localRef={localRef} savedRef={savedRef} availPts={availPts} onInc={inc} onDec={dec}
            nextCostParts={getNextCostParts("fastTwitch")} forceLocked={getFieldForceLocked("fastTwitch")} 
            active={activeList.includes("fastTwitch")} onToggleActive={toggleActive} activeFull={activeFull} />
          <RefSkillRow label="Heart Refinement" field="heartRefinement" locked={iqLocked}
            localRef={localRef} savedRef={savedRef} availPts={availPts} onInc={inc} onDec={dec}
            nextCostParts={getNextCostParts("heartRefinement")} forceLocked={getFieldForceLocked("heartRefinement")} 
            active={activeList.includes("heartRefinement")} onToggleActive={toggleActive} activeFull={activeFull} />
          <RefSkillRow label="Chin Hitter" field="chinHitter" locked={iqLocked}
            localRef={localRef} savedRef={savedRef} availPts={availPts} onInc={inc} onDec={dec}
            nextCostParts={getNextCostParts("chinHitter")} forceLocked={getFieldForceLocked("chinHitter")} 
            active={activeList.includes("chinHitter")} onToggleActive={toggleActive} activeFull={activeFull} />
          <RefSkillRow label="Technician" field="technician" locked={iqLocked}
            localRef={localRef} savedRef={savedRef} availPts={availPts} onInc={inc} onDec={dec}
            nextCostParts={getNextCostParts("technician")} forceLocked={getFieldForceLocked("technician")} 
            active={activeList.includes("technician")} onToggleActive={toggleActive} activeFull={activeFull} />
          <RefSkillRow label="Life Drain" field="lifeDrain" locked={iqLocked}
            localRef={localRef} savedRef={savedRef} availPts={availPts} onInc={inc} onDec={dec}
            nextCostParts={getNextCostParts("lifeDrain")} forceLocked={getFieldForceLocked("lifeDrain")} 
            active={activeList.includes("lifeDrain")} onToggleActive={toggleActive} activeFull={activeFull} />
        </Card>
      </div>

      {pendingSpend > 0 && (
        <Button className="w-full max-w-md" onClick={() => onAllocate({ ...localRef, availablePoints: availPts, costReduction: Math.max(localRef.costReduction || 0, savedRef.costReduction || 0) }, pendingForce, pendingDiamonds, pendingShards)}
          data-testid="button-save-refinement">
          Save Changes ({pendingSpend} pt{pendingSpend !== 1 ? "s" : ""} spent{pendingForce > 0 ? ` · ⚡${pendingForce >= 1_000_000 ? (pendingForce/1_000_000).toFixed(1)+"M" : pendingForce >= 1_000 ? (pendingForce/1_000).toFixed(0)+"k" : pendingForce}` : ""}{pendingDiamonds > 0 ? ` · 💎${pendingDiamonds}` : ""}{pendingShards > 0 ? ` · 🔷${pendingShards >= 1_000_000 ? (pendingShards/1_000_000).toFixed(1)+"M" : pendingShards >= 1_000 ? (pendingShards/1_000).toFixed(0)+"k" : pendingShards}` : ""})
        </Button>
      )}

      <Dialog open={unlockConfirmTrack !== null} onOpenChange={(open) => { if (!open) setUnlockConfirmTrack(null); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Unlock {unlockConfirmTrack?.label}?</DialogTitle>
            <DialogDescription>
              This will spend <span className="font-bold text-foreground">⚡{(unlockConfirmTrack?.cost ?? 0).toLocaleString()} Force</span>
              {(unlockConfirmTrack?.shardCost ?? 0) > 0 && (
                <> and <span className="font-bold text-sky-300">🔷{(unlockConfirmTrack?.shardCost ?? 0).toLocaleString()} Shards</span></>
              )} to unlock this track permanently.
              You currently have <span className="font-bold text-foreground">⚡{playerForce.toLocaleString()} Force</span>
              {(unlockConfirmTrack?.shardCost ?? 0) > 0 && (
                <> and <span className="font-bold text-sky-300">🔷{playerShards.toLocaleString()} Shards</span></>
              )}.
            </DialogDescription>
          </DialogHeader>
          <div className="flex gap-2 mt-2">
            <DialogClose asChild>
              <Button variant="secondary" className="flex-1" data-testid="button-unlock-confirm-cancel">Cancel</Button>
            </DialogClose>
            <Button className="flex-1" onClick={confirmUnlock} data-testid="button-unlock-confirm-ok">
              Unlock
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={buyReductionConfirmOpen} onOpenChange={setBuyReductionConfirmOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Lower Exchange Cost?</DialogTitle>
            <DialogDescription>
              Spend <span className="font-bold text-cyan-400">1 Diamond</span> to permanently lower the
              Stat → Refinement exchange cost from <span className="font-bold text-foreground">{exchangeCost} SP</span> to{" "}
              <span className="font-bold text-foreground">{Math.max(1, exchangeCost - 1)} SP</span> per point?
              This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <div className="flex gap-2">
            <DialogClose asChild>
              <Button variant="outline" className="flex-1" data-testid="button-buy-reduction-cancel">Cancel</Button>
            </DialogClose>
            <Button
              className="flex-1 bg-cyan-700 hover:bg-cyan-600 text-white"
              onClick={() => {
                onBuyCostReduction?.();
                setBuyReductionConfirmOpen(false);
              }}
              data-testid="button-buy-reduction-confirm"
            >Spend 1 💎</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default function CareerMode({
  fighters, onSelectFighter, onCreateFighter, onDeleteFighter, onBack, onAllocateStats, onStartTraining, onEndWeek, onSimulateWeek, onSweepTraining, onStartNightmare, onStartDoghouse, onSelectOpponent, onInitRoster, onDailyReward, onUpdateColors, isLoading, initialFighter, careerRefStoppageEnabled, onToggleCareerRefStoppage, careerTowelStoppageEnabled, onToggleCareerTowelStoppage, careerFightMusicEnabled, onToggleCareerFightMusic, careerFightMusicTrack, onSelectCareerFightMusic, onTutorial, onUnlockRefinement, onAllocateRefinement, onForceSpend, onShardSpend, onDiamondSpend, onFighterRefresh, showExpBar, onToggleShowExpBar, showFightItemsHud, onToggleShowFightItemsHud
}: CareerModeProps & { initialFighter?: Fighter | null }) {
  const [view, setView] = useState<CareerView>(initialFighter ? "gym" : "slots");
  const [selectedFighter, setSelectedFighter] = useState<Fighter | null>(initialFighter ?? null);
  const [rebuildOpen, setRebuildOpen] = useState(false);
  const [rebuildOriginalData, setRebuildOriginalData] = useState<{ skillPoints: SkillPoints; availableStatPoints: number } | null>(null);
  const [rebuildExitConfirmOpen, setRebuildExitConfirmOpen] = useState(false);
  const [simulateConfirmOpen, setSimulateConfirmOpen] = useState(false);
  /**
   * The equipment unlocks the "new gear" overlay is currently showing, or null.
   *
   * Taking the list writes it to the save as announced, so the overlay is
   * raised exactly once per unlock: dismissing it, walking out of the hub, or
   * coming back from a sparring session quit at the pause menu — which remounts
   * this screen — can none of them raise it again. The crate's red dot is a
   * separate record and keeps burning until the page itself is opened.
   */
  const [equipAnnounce, setEquipAnnounce] = useState<EquipmentSlot[] | null>(null);
  const equipAnnounceFighterId = selectedFighter?.id ?? null;
  const equipAnnounceWins = selectedFighter?.wins ?? 0;
  useEffect(() => {
    // Only while the hub is the screen on show: the overlay is drawn there, and
    // an announcement taken anywhere else would be spent without being seen.
    if (view !== "gym" || !equipAnnounceFighterId) return;
    const { slots, fighter } = takeEquipmentUnlockAnnouncement(equipAnnounceFighterId);
    if (slots.length === 0) return;
    setEquipAnnounce(slots);
    if (fighter) { setSelectedFighter(fighter); onFighterRefresh?.(fighter); }
    // Deliberately keyed on the fighter and the win count alone: the refresh
    // callback is a fresh lambda every render, and probing the save on each one
    // would re-read the whole save file for an answer that cannot have changed.
  }, [view, equipAnnounceFighterId, equipAnnounceWins]);
  const [hubTip, setHubTip] = useState<string | null>(null);
  const [simulateTips, setSimulateTips] = useState<string[]>([]);
  // Drives the full-screen loading view for the heavy career transitions.
  const { loader, runLoader } = useChunkedLoader();
  useEffect(() => {
    migrateStatCaps();
  }, []);
  useEffect(() => {
    if (initialFighter) {
      setSelectedFighter(initialFighter);
    }
  }, [initialFighter]);

  // NOTE: offline passive gym income is accrued by GymView on mount (the gym is
  // now the career home view), so no separate accrual effect is needed here.
  // Keeping both would double-credit Force.

  // Force is written to the save file from several places (fights, training,
  // upgrades), so the in-memory selectedFighter snapshot can go stale. Re-sync
  // Force from the save whenever the gym (career hub) is shown so the chip
  // always displays the exact stored total.
  useEffect(() => {
    if (view !== "gym") return;
    setSelectedFighter(prev => {
      if (!prev) return prev;
      const fresh = localSaves.getFighter(prev.id);
      if (!fresh) return prev;
      return (fresh.force ?? 0) !== (prev.force ?? 0) ? { ...prev, force: fresh.force ?? 0 } : prev;
    });
  }, [view]);

  /**
   * Daily reward chests. The claim stamps today's date on the save before
   * returning, so a second run the same day is a no-op — and a day that rolled
   * nothing still counts as claimed.
   */
  const dailyFighterId = selectedFighter?.id;
  const runDailyClaim = useCallback(() => {
    if (!dailyFighterId) return;
    const claim = claimDailyReward(dailyFighterId);
    if (!claim) return;
    // The claim wrote the save (items and the day stamp). Refresh both
    // snapshots or the next whole-blob roster write rolls the stamp back.
    const fresh = localSaves.getFighter(dailyFighterId);
    if (fresh) {
      setSelectedFighter(prev => (prev && prev.id === fresh.id
        ? { ...prev, itemInventory: fresh.itemInventory, careerRosterState: fresh.careerRosterState }
        : prev));
      onFighterRefresh?.(fresh);
    }
    if (claim.crates.length > 0) onDailyReward?.(claim.crates);
  }, [dailyFighterId, onFighterRefresh, onDailyReward]);

  // Checked every time the career home opens. Midnight crossing while it is
  // already open is spotted by the HUD badge, which calls the same claim.
  useEffect(() => {
    if (view !== "gym") return;
    runDailyClaim();
  }, [view, runDailyClaim]);
  const [rosterEditFighter, setRosterEditFighter] = useState<Fighter | null>(null);
  const [pendingOpponentId, setPendingOpponentId] = useState<number | null>(null);
  const [showSettings, setShowSettings] = useState(false);

  // Fight-song picker: preview state. While the picker is open the menu shuffle is
  // paused; on close the shuffle restarts with the last-previewed song (if any).
  const [songPickerOpen, setSongPickerOpen] = useState(false);
  const [previewingSongIdx, setPreviewingSongIdx] = useState<number | null>(null);
  const [negotiateConfirmWeek, setNegotiateConfirmWeek] = useState<number | null>(null);
  const [negotiateResult, setNegotiateResult] = useState<'success' | 'fail' | null>(null);
  const [negotiateUnlockNotice, setNegotiateUnlockNotice] = useState(false);
  const [cancelFightConfirm, setCancelFightConfirm] = useState(false);
  const [guaranteeNegotiateConfirm, setGuaranteeNegotiateConfirm] = useState(false);
  // Force was already spent to guarantee the NEXT negotiation attempt — the week the
  // player picks will succeed with 100% chance.
  const [guaranteePending, setGuaranteePending] = useState(false);
  const lastPreviewedSongRef = useRef<number | null>(null);
  const songPickerOpenRef = useRef(false);
  useEffect(() => { songPickerOpenRef.current = songPickerOpen; }, [songPickerOpen]);

  // Safety net: if the picker is unmounted while still open (without Radix firing
  // a close), stop any preview and hand the menu music back to the shuffle.
  useEffect(() => {
    return () => {
      if (!songPickerOpenRef.current) return;
      if (lastPreviewedSongRef.current != null) {
        musicEngine.restartShuffleFrom(lastPreviewedSongRef.current);
      } else {
        musicEngine.resume();
      }
    };
  }, []);

  useEffect(() => {
    if (view !== "hub" || !selectedFighter) { setHubTip(null); return; }
    const rs = selectedFighter.careerRosterState as CareerRosterState | null;
    const allTips = localSaves.getFightTips();
    const hubCount = localSaves.incrementHubLoadCount();
    const hubCd = localSaves.getTipHubCooldowns();
    const picked = localSaves.pickFightTips(1, allTips, (i) => {
      const last = hubCd[i];
      return last !== undefined && (hubCount - last) < 20;
    });
    if (picked.length > 0) {
      localSaves.saveTipHubCooldowns({ ...hubCd, [picked[0].index]: hubCount });
      setHubTip(picked[0].text);
    } else {
      setHubTip(null);
    }
  }, [view]);

  useEffect(() => {
    if (!simulateConfirmOpen || !selectedFighter) { setSimulateTips([]); return; }
    const rs = selectedFighter.careerRosterState as CareerRosterState | null;
    const weekNum = rs?.weekNumber ?? 0;
    const allTips = localSaves.getFightTips();
    const weekCd = localSaves.getTipWeekCooldowns();
    const picked = localSaves.pickFightTips(2, allTips, (i) => {
      const last = weekCd[i];
      return last !== undefined && (weekNum - last) < 3;
    });
    if (picked.length > 0) {
      const newCd = { ...weekCd };
      for (const p of picked) newCd[p.index] = weekNum;
      localSaves.saveTipWeekCooldowns(newCd);
      setSimulateTips(picked.map(p => p.text));
    } else {
      setSimulateTips([]);
    }
  }, [simulateConfirmOpen]);

  const handleSongPickerOpenChange = (open: boolean) => {
    setSongPickerOpen(open);
    if (open) {
      lastPreviewedSongRef.current = null;
      setPreviewingSongIdx(null);
      musicEngine.pause();
    } else {
      setPreviewingSongIdx(null);
      if (lastPreviewedSongRef.current != null) {
        musicEngine.restartShuffleFrom(lastPreviewedSongRef.current);
      } else {
        musicEngine.resume();
      }
      lastPreviewedSongRef.current = null;
    }
  };

  const handleToggleSongPreview = (idx: number) => {
    if (previewingSongIdx === idx) {
      musicEngine.previewStop();
      setPreviewingSongIdx(null);
    } else {
      musicEngine.previewPlay(idx);
      setPreviewingSongIdx(idx);
      lastPreviewedSongRef.current = idx;
    }
  };

  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [pinFlow, setPinFlow] = useState<PinFlowMode | null>(null);
  const [pinDigits, setPinDigits] = useState("");
  const [pinFirstEntry, setPinFirstEntry] = useState("");
  const [pinError, setPinError] = useState("");
  const [pinSuccess, setPinSuccess] = useState("");
  const [pinTargetFighter, setPinTargetFighter] = useState<Fighter | null>(null);
  const [pinLockedState, setPinLockedState] = useState<Record<string, boolean>>({});
  const [careerRoundLen, setCareerRoundLen] = useState<number>(() => {
    try { const v = localStorage.getItem("handz_career_round_len"); return v ? parseInt(v) : 1; } catch { return 1; }
  });
  const [careerTimerSpeed, setCareerTimerSpeed] = useState<"normal" | "fast">(() => {
    try { const v = localStorage.getItem("handz_career_timer_speed"); return v === "fast" ? "fast" : "normal"; } catch { return "normal"; }
  });
  const [careerNumRounds, setCareerNumRounds] = useState<"auto" | 3 | 6 | 12>(() => {
    try { const v = localStorage.getItem("handz_career_num_rounds"); return (v === "3" ? 3 : v === "6" ? 6 : v === "12" ? 12 : "auto"); } catch { return "auto"; }
  });

  useEffect(() => {
    localStorage.setItem("handz_career_round_len", String(careerRoundLen));
  }, [careerRoundLen]);
  useEffect(() => {
    localStorage.setItem("handz_career_timer_speed", careerTimerSpeed);
  }, [careerTimerSpeed]);
  useEffect(() => {
    localStorage.setItem("handz_career_num_rounds", String(careerNumRounds));
  }, [careerNumRounds]);

  useEffect(() => {
    if (selectedFighter) {
      const updated = fighters.find(f => f.id === selectedFighter.id);
      if (updated) {
        setSelectedFighter(updated);
      }
    }
  }, [fighters]);

  const [firstName, setFirstName] = useState("");
  const [nickname, setNickname] = useState("");
  const [lastName, setLastName] = useState("");
  const [archetype, setArchetype] = useState<Archetype>("BoxerPuncher");
  const [difficulty, setDifficulty] = useState<AIDifficulty>("champion");
  const [roundLength, setRoundLength] = useState(1);
  const [skinColor, setSkinColor] = useState("#e8c4a0");
  const [gearColors, setGearColors] = useState<GearColors>({ ...DEFAULT_GEAR_COLORS });
  const [boxingStanceCreate, setBoxingStanceCreate] = useState<"orthodox" | "southpaw">("orthodox");

  const resetCreate = () => {
    setFirstName("");
    setNickname("");
    setLastName("");
    setArchetype("BoxerPuncher");
    setDifficulty("champion");
    setRoundLength(1);
    setSkinColor("#e8c4a0");
    setGearColors({ ...DEFAULT_GEAR_COLORS });
    setBoxingStanceCreate("orthodox");
  };

  const [generatingProgress, setGeneratingProgress] = useState(0);
  const [pendingFighterData, setPendingFighterData] = useState<{
    firstName: string; nickname: string; lastName: string;
    archetype: Archetype; careerDifficulty: AIDifficulty;
    roundLengthMins: number; skinColor: string; gearColors: GearColors;
    boxingStance: "orthodox" | "southpaw";
  } | null>(null);

  const handleDownloadData = (f: Fighter) => {
    const fighterName = f.firstName
      ? (f.nickname ? `${f.firstName} "${f.nickname}" ${f.lastName}` : `${f.firstName} ${f.lastName}`)
      : f.name;

    const saveData = localSaves.exportSaveFile(f);
    const json = JSON.stringify(saveData, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `handz_save_${fighterName.replace(/[^a-zA-Z0-9]/g, "_")}_${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };



  const [dragOver, setDragOver] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [pendingImportFile, setPendingImportFile] = useState<File | null>(null);

  const handleImportSave = (file: File) => {
    setImportError(null);
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = JSON.parse(e.target?.result as string);
        localSaves.importSaveFile(data);
        onDeleteFighter("");
      } catch (err: any) {
        setImportError(err.message || "Failed to import save file");
      }
    };
    reader.readAsText(file);
  };

  // Importing while a save already exists prompts an overwrite confirmation.
  const requestImportSave = (file: File) => {
    if (fighters.length > 0) {
      setPendingImportFile(file);
    } else {
      handleImportSave(file);
    }
  };

  const confirmOverwriteImport = () => {
    if (!pendingImportFile) return;
    for (const f of fighters) {
      localSaves.deleteFighter(f.id);
    }
    clearRosterCustomizationNumbers();
    handleImportSave(pendingImportFile);
    setPendingImportFile(null);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file && file.name.endsWith(".json")) {
      requestImportSave(file);
    } else {
      setImportError("Please drop a .json save file");
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    {
      setDragOver(true);
    }
  };

  const handleDragLeave = () => {
    setDragOver(false);
  };

  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      requestImportSave(file);
    }
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const handleCreate = () => {
    if (firstName.trim() && lastName.trim()) {
      setPendingFighterData({
        firstName: firstName.trim(),
        nickname: nickname.trim(),
        lastName: lastName.trim(),
        archetype,
        careerDifficulty: difficulty,
        roundLengthMins: roundLength,
        skinColor,
        gearColors,
        boxingStance: boxingStanceCreate,
      });
      setGeneratingProgress(0);
      setView("generating");
    }
  };

  useEffect(() => {
    if (view !== "generating" || !pendingFighterData) return;
    let cancelled = false;

    const steps = [
      { progress: 10, delay: 200 },
      { progress: 25, delay: 300 },
      { progress: 40, delay: 250 },
      { progress: 55, delay: 300 },
      { progress: 70, delay: 250 },
      { progress: 85, delay: 200 },
      { progress: 95, delay: 150 },
    ];

    let stepIdx = 0;
    const runStep = () => {
      if (cancelled) return;
      if (stepIdx < steps.length) {
        setGeneratingProgress(steps[stepIdx].progress);
        const delay = steps[stepIdx].delay;
        stepIdx++;
        setTimeout(runStep, delay);
      } else {
        onCreateFighter(pendingFighterData);
        setGeneratingProgress(100);
        setTimeout(() => {
          if (cancelled) return;
          setPendingFighterData(null);
          resetCreate();
        }, 400);
      }
    };

    setTimeout(runStep, 100);
    return () => { cancelled = true; };
  }, [view, pendingFighterData]);

  useEffect(() => {
    if (view !== "generating" || pendingFighterData) return;
    const newest = fighters.length > 0 ? fighters[fighters.length - 1] : null;
    if (!newest) return;

    const rosterState = initRosterState(newest.id + newest.name, newest.careerDifficulty as AIDifficulty);
    const playerRank = computePlayerRankFromRating(rosterState.roster, rosterState.playerRatingScore, rosterState.rank1HolderId);
    const initialized = { ...rosterState, playerRank };
    onInitRoster(newest.id, initialized);
    setSelectedFighter({ ...newest, careerRosterState: initialized });
    setView("gym");
  }, [view, pendingFighterData, fighters]);

  /**
   * Loading a slot runs a full roster self-heal (level redistribution, missing
   * fighter merge, re-ranking, refinement backfill). That used to run as one
   * synchronous block on the click, freezing the app until the gym appeared;
   * it now runs in chunks behind the loading screen. The phases run in the same
   * order as before, so every deterministic seed still lands the same way.
   */
  const loadSlot = (fighter: Fighter) => {
    if (!fighter.careerRosterState) {
      let initialized: CareerRosterState | null = null;
      void runLoader({
        title: "Building The Division",
        subtitle: fighter.name || "New Career",
        phases: [
          {
            label: "Generating the roster",
            weight: 4,
            run: () => {
              const rosterState = initRosterState(fighter.id + fighter.name, fighter.careerDifficulty as AIDifficulty);
              const playerRank = computePlayerRankFromRating(rosterState.roster, rosterState.playerRatingScore, rosterState.rank1HolderId);
              initialized = { ...rosterState, playerRank };
            },
          },
          {
            label: "Opening the gym",
            run: () => {
              if (!initialized) return;
              onInitRoster(fighter.id, initialized);
              setSelectedFighter({ ...fighter, careerRosterState: initialized });
              setView("gym");
            },
          },
        ],
      });
      return;
    }

    const rs = fighter.careerRosterState as CareerRosterState;
    const maxGain = fighter.careerDifficulty === "champion" ? 2 : 1;
    let fixedRoster: RosterFighterState[] = rs.roster;
    let healedHolderId: number | "player" | undefined;
    let fixedState: CareerRosterState | null = null;
    /** Set when the five-active cap stamps an empty pick list onto the player's save. */
    let fixedRefinement: SkillRefinement | null = null;

    void runLoader({
      title: "Loading Career",
      subtitle: fighter.name || undefined,
      phases: [
        {
          label: "Reading the save",
          weight: 2,
          run: () => {
            fixedRoster = applyRosterCustomizations(redistributeRosterLevels(rs.roster, maxGain, fighter.level, rs.endgameShownIds, rs.selectedOpponentId ?? undefined));
          },
        },
        {
          label: "Filling the ladder",
          weight: 2,
          run: () => {
            // Self-heal: older saves may be missing roster fighters entirely (they were
            // previously only merged in during weekly simulation). Merge them on load so
            // the rank ladder is full-length immediately.
            fixedRoster = mergeNewFightersIntoRoster({ ...rs, roster: fixedRoster }).roster;
            // Self-heal: every non-retired fighter is supposed to be active. Older saves
            // (from before the full-roster activation) still carry inactive reserves,
            // which left holes in the rank ladder (e.g. a rank-250 player seeing no
            // fighters ranked near them). Activate them all before re-ranking.
            for (const f of fixedRoster) {
              if (!f.retired && !f.active) f.active = true;
            }
            // Self-heal: retirements used to permanently remove fighters from the rank
            // ladder, shrinking it over long careers (e.g. 704 -> 250). Respawn every
            // retired slot as a fresh debut prospect so the ladder is full again.
            respawnRetiredFighters(fixedRoster, fighter.id);
          },
        },
        {
          label: "Building fighter profiles",
          run: () => {
            // Backfill deterministic per-fighter offense profiles for saves created
            // before the AI execution layer existed (idempotent — pure function of id).
            ensureOffenseProfiles(fixedRoster);
          },
        },
        {
          label: "Ranking the division",
          run: () => {
            // Self-heal rankings on every load — retroactively repairs saves where the belt holder
            // was incorrectly retired/inactive or had lost his rank-1 pin before this fix.
            updateRankings(fixedRoster, rs.rank1HolderId);
            // Persist the healed belt holder: if an AI fighter took the belt from Aruzenai Jr
            // in a save from before the guaranteed-win rule, restore it to him (204).
            healedHolderId = resolveRank1Holder(fixedRoster, rs.rank1HolderId);
          },
        },
        {
          label: "Seeding refinements",
          weight: 2,
          run: () => {
            const endgameSeed = Math.abs(Array.from(String(fighter.id)).reduce((a, c) => (a * 31 + c.charCodeAt(0)) | 0, 7)) + 1;
            // Refinements added after this save was generated (Life Drain, Bruiser) are seeded
            // onto existing opponents here — the one-time regen flags above would
            // otherwise leave them permanently at zero.
            fixedState = grandfatherSparringUnlocks(
              // Drilled Actions postdate these saves too — an empty list is the
              // stamp, so the gym has somewhere to write from the first session.
              backfillDrilledActions(
                // Punch Endurance postdates these saves: seed the player's from the
                // floor and every opponent's from their band before the gym opens.
                backfillPunchEndurance(
                  // Five refinements into the ring, no more: every opponent is cut
                  // down to their five highest once, after the late-arriving
                  // refinements above have been seeded. Levels, stats, records and
                  // ranks are untouched, and the stamp stops a reload re-trimming.
                  applyRefinementFiveCap(
                    backfillMissingRefinements(
                      applyRefinementGenV3(ensureEndgamePool({ ...rs, roster: fixedRoster, rank1HolderId: healedHolderId }, fighter.level, endgameSeed), endgameSeed),
                    ),
                  ),
                ),
              ),
              fighter.wins ?? 0,
            );
            // The player picks their five from scratch. An array — even an empty
            // one — is the stamp, so an intentionally-empty pick is never
            // mistaken for a save that has not been through here yet.
            const curRef = (fighter.skillRefinement ?? {}) as Partial<SkillRefinement>;
            if (!Array.isArray(curRef.activeRefinements)) {
              fixedRefinement = { ...DEFAULT_SKILL_REFINEMENT, ...curRef, activeRefinements: [] } as SkillRefinement;
            }
          },
        },
        {
          label: "Opening the gym",
          run: () => {
            if (!fixedState) return;
            onInitRoster(fighter.id, fixedState);
            if (fixedRefinement) {
              updateFighter(fighter.id, { skillRefinement: fixedRefinement });
            }
            setSelectedFighter({
              ...fighter,
              ...(fixedRefinement ? { skillRefinement: fixedRefinement } : {}),
              careerRosterState: fixedState,
            });
            setView("gym");
          },
        },
      ],
    });
  };

  const handleSelectSlot = (fighter: Fighter) => {
    const pin = getFighterPin(fighter.id);
    if (pin && isPinLocked(fighter.id)) {
      setPinTargetFighter(fighter);
      setPinFlow("enterLoad");
      setPinDigits("");
      setPinError("");
      setPinSuccess("");
      return;
    }
    loadSlot(fighter);
  };

  const handleDeleteSlot = (fighterId: string) => {
    const pin = getFighterPin(fighterId);
    if (pin && isPinLocked(fighterId)) {
      const fighter = fighters.find(f => f.id === fighterId) || null;
      setPinTargetFighter(fighter);
      setPinFlow("enterDelete");
      setPinDigits("");
      setPinError("");
      setPinSuccess("");
      return;
    }
    setDeleteConfirmId(fighterId);
  };

  const confirmDelete = (fighterId: string) => {
    removeFighterPin(fighterId);
    onDeleteFighter(fighterId);
    setDeleteConfirmId(null);
  };

  const clearPinFlow = () => {
    setPinFlow(null);
    setPinDigits("");
    setPinFirstEntry("");
    setPinError("");
    setPinSuccess("");
    setPinTargetFighter(null);
  };

  const handlePinSubmit = () => {
    if (pinDigits.length !== 4) { setPinError("Enter 4 digits"); return; }
    const fid = pinTargetFighter?.id || selectedFighter?.id;
    if (!fid) return;

    if (pinFlow === "setNew") {
      setPinFirstEntry(pinDigits);
      setPinDigits("");
      setPinError("");
      setPinFlow("confirmNew");
    } else if (pinFlow === "confirmNew") {
      if (pinDigits !== pinFirstEntry) {
        setPinError("Pins don't match. Try again.");
        setPinDigits("");
        setPinFlow("setNew");
        setPinFirstEntry("");
      } else {
        setFighterPin(fid, pinDigits);
        setPinLocked(fid, true);
        setPinLockedState(prev => ({ ...prev, [fid]: true }));
        setPinSuccess("Pin code saved! Loading and deleting this career now requires your 4-digit pin.");
        setPinFlow(null);
        setPinDigits("");
        setPinFirstEntry("");
        setTimeout(() => setPinSuccess(""), 4000);
      }
    } else if (pinFlow === "enterLoad") {
      const pin = getFighterPin(fid);
      if (pinDigits === pin) {
        clearPinFlow();
        const fighter = fighters.find(f => f.id === fid);
        if (fighter) loadSlot(fighter);
      } else {
        setPinError("Wrong pin code");
        setPinDigits("");
      }
    } else if (pinFlow === "enterDelete") {
      const pin = getFighterPin(fid);
      if (pinDigits === pin) {
        clearPinFlow();
        setDeleteConfirmId(fid);
      } else {
        setPinError("Wrong pin code");
        setPinDigits("");
      }
    } else if (pinFlow === "enterChange") {
      const pin = getFighterPin(fid);
      if (pinDigits === pin) {
        setPinDigits("");
        setPinError("");
        setPinFlow("setChangeNew");
      } else {
        setPinError("Wrong pin code");
        setPinDigits("");
      }
    } else if (pinFlow === "setChangeNew") {
      setPinFirstEntry(pinDigits);
      setPinDigits("");
      setPinError("");
      setPinFlow("confirmChangeNew");
    } else if (pinFlow === "confirmChangeNew") {
      if (pinDigits !== pinFirstEntry) {
        setPinError("Pins don't match. Try again.");
        setPinDigits("");
        setPinFlow("setChangeNew");
        setPinFirstEntry("");
      } else {
        setFighterPin(fid, pinDigits);
        setPinLocked(fid, true);
        setPinLockedState(prev => ({ ...prev, [fid]: true }));
        setPinSuccess("Pin code changed! Your new pin is now active.");
        setPinFlow(null);
        setPinDigits("");
        setPinFirstEntry("");
        setTimeout(() => setPinSuccess(""), 4000);
      }
    }
  };

  const handleFight = (opponentId: number) => {
    if (selectedFighter) {
      onSelectFighter(selectedFighter, opponentId);
    }
  };

  const handleRebuildSkills = () => {
    if (!selectedFighter) return;
    const sp = (selectedFighter.skillPoints as SkillPoints) || { power: 0, speed: 0, defense: 0, stamina: 0, focus: 0 };
    const normalizedSp: SkillPoints = { power: sp.power || 0, speed: sp.speed || 0, defense: sp.defense || 0, stamina: sp.stamina || 0, focus: sp.focus || 0 };
    const total = normalizedSp.power + normalizedSp.speed + normalizedSp.defense + normalizedSp.stamina + normalizedSp.focus;
    const avail = selectedFighter.availableStatPoints || 0;
    // Store original so we can restore on cancel — do NOT write to DB yet
    setRebuildOriginalData({ skillPoints: normalizedSp, availableStatPoints: avail });
    const zeroed: SkillPoints = { power: 0, speed: 0, defense: 0, stamina: 0, focus: 0 };
    setSelectedFighter(prev => prev ? { ...prev, skillPoints: zeroed, availableStatPoints: avail + total } : null);
    setRebuildOpen(false);
    setView("allocate");
  };

  const simBannerRs = selectedFighter?.careerRosterState as CareerRosterState | null;
  const simBannerCampActive = simBannerRs?.selectedOpponentId != null && (simBannerRs?.prepWeeksRemaining ?? 0) > 0;
  const simWeekBannerEl = simBannerCampActive ? (
    <div
      className="px-4 py-2.5 rounded-lg border shadow-lg bg-blue-950 border-blue-500"
      data-testid="banner-sim-week"
    >
      <p className="text-sm font-bold text-blue-200">
        {simBannerRs!.prepWeeksRemaining} {simBannerRs!.prepWeeksRemaining === 1 ? "week" : "weeks"} till fight
      </p>
    </div>
  ) : null;

  // A chunked transition is running — cover the app with the loading screen so
  // the user sees progress instead of a stalled page.
  if (loader.active) {
    return (
      <LoadingScreen
        title={loader.title}
        subtitle={loader.subtitle}
        label={loader.label}
        progress={loader.progress}
      />
    );
  }

  if (view === "create") {
    return <CreateFighter
      firstName={firstName} setFirstName={setFirstName}
      nickname={nickname} setNickname={setNickname}
      lastName={lastName} setLastName={setLastName}
      archetype={archetype} setArchetype={setArchetype}
      difficulty={difficulty} setDifficulty={setDifficulty}
      roundLength={roundLength} setRoundLength={setRoundLength}
      skinColor={skinColor} setSkinColor={setSkinColor}
      gearColors={gearColors} setGearColors={setGearColors}
      boxingStance={boxingStanceCreate} setBoxingStance={setBoxingStanceCreate}
      onCreate={handleCreate}
      onBack={() => { resetCreate(); setView("slots"); }}
    />;
  }

  if (view === "generating") {
    const messages = [
      "Setting up key fighters...",
      "Assigning fighter levels...",
      "Determining skill ratings...",
      "Generating fight records...",
      "Building fighter profiles...",
      "Populating the roster...",
      "Finalizing rankings...",
      "Preparing your career...",
    ];
    const msgIdx = Math.min(Math.floor(generatingProgress / 13), messages.length - 1);
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] gap-6 p-8">
        <BoxingGloveIcon className="w-16 h-16 text-primary animate-pulse" />
        <h2 className="text-2xl font-bold">Generating Roster</h2>
        <p className="text-muted-foreground text-center">{messages[msgIdx]}</p>
        <div className="w-64 h-3 bg-muted rounded-full overflow-hidden">
          <div
            className="h-full bg-primary rounded-full transition-all duration-300"
            style={{ width: `${generatingProgress}%` }}
          />
        </div>
        <p className="text-sm text-muted-foreground">{generatingProgress}%</p>
      </div>
    );
  }

  if (view === "stats" && selectedFighter) {
    return <CareerStatsView fighter={selectedFighter} onBack={() => setView("gym")} />;
  }

  if (view === "allocate" && selectedFighter) {
    const isRebuild = rebuildOriginalData !== null;
    const handleAllocateConfirm = (sp: SkillPoints, spent: number) => {
      if (isRebuild && rebuildOriginalData) {
        // spent = sum(newSp) since AllocateStats starts from zeroed current.
        // We need the NET change vs the original allocation so handleAllocateStats
        // computes newAvail = originalAvail - adjustedSpent correctly.
        const origTotal = rebuildOriginalData.skillPoints.power + rebuildOriginalData.skillPoints.speed +
          rebuildOriginalData.skillPoints.defense + rebuildOriginalData.skillPoints.stamina + rebuildOriginalData.skillPoints.focus;
        const adjustedSpent = spent - origTotal; // net delta vs original
        onAllocateStats(selectedFighter.id, sp, adjustedSpent);
        setSelectedFighter(prev => prev ? {
          ...prev,
          skillPoints: sp,
          availableStatPoints: rebuildOriginalData.availableStatPoints - adjustedSpent,
        } : null);
        setRebuildOriginalData(null);
      } else {
        onAllocateStats(selectedFighter.id, sp, spent);
        setSelectedFighter(prev => prev ? {
          ...prev,
          skillPoints: sp,
          availableStatPoints: prev.availableStatPoints - spent,
        } : null);
      }
      setView("hub");
    };
    const handleAllocateBack = () => {
      if (isRebuild) {
        setRebuildExitConfirmOpen(true);
      } else {
        setView("hub");
      }
    };
    const handleRebuildCancel = () => {
      if (rebuildOriginalData) {
        setSelectedFighter(prev => prev ? {
          ...prev,
          skillPoints: rebuildOriginalData.skillPoints,
          availableStatPoints: rebuildOriginalData.availableStatPoints,
        } : null);
      }
      setRebuildOriginalData(null);
      setRebuildExitConfirmOpen(false);
      setView("hub");
    };
    return (
      <>
        <AllocateStats
          fighter={selectedFighter}
          noSaveForLater={isRebuild}
          onAllocate={handleAllocateConfirm}
          onBack={handleAllocateBack}
        />
        {isRebuild && (
          <Dialog open={rebuildExitConfirmOpen} onOpenChange={(open) => { if (!open) setRebuildExitConfirmOpen(false); }}>
            <DialogContent className="max-w-sm">
              <DialogHeader>
                <DialogTitle>Exit without saving?</DialogTitle>
                <DialogDescription>
                  Your changes will be discarded and your original stat allocation will be restored.
                </DialogDescription>
              </DialogHeader>
              <div className="flex gap-2 mt-2">
                <Button variant="secondary" className="flex-1" onClick={() => setRebuildExitConfirmOpen(false)} data-testid="button-rebuild-exit-cancel">
                  Keep editing
                </Button>
                <Button className="flex-1 bg-red-600 hover:bg-red-700 text-white border-0" onClick={handleRebuildCancel} data-testid="button-rebuild-exit-confirm">
                  Exit
                </Button>
              </div>
            </DialogContent>
          </Dialog>
        )}
      </>
    );
  }

  if (view === "equipment" && selectedFighter) {
    return (
      <EquipmentUpgradesView
        fighter={selectedFighter}
        playerColors={careerFighterColors(selectedFighter)}
        onBack={() => setView("gym")}
        onFighterChanged={(f) => { setSelectedFighter(f); onFighterRefresh?.(f); }}
      />
    );
  }

  if (view === "gym" && selectedFighter) {
    const gymRs = selectedFighter.careerRosterState as CareerRosterState | null;
    const gymRefBypass = localStorage.getItem("handz_refinement_bypass") === "true";
    const gymRefinementUnlocked = gymRefBypass || !!gymRs?.refinementPermanentlyUnlocked || (gymRs?.playerRank ?? 999) <= 650;
    // The Skill Refinement case wears a red dot from the moment it unlocks until
    // the player actually looks inside it once.
    const markRefinementCaseSeen = () => {
      const seen = localSaves.markRefinementCaseSeen(selectedFighter.id);
      if (seen) setSelectedFighter(seen);
    };
    const gymSavedRef: SkillRefinement = { ...DEFAULT_SKILL_REFINEMENT, ...((selectedFighter.skillRefinement || {}) as Partial<SkillRefinement>) };
    const gymRefSpent = calcAllocated(gymSavedRef);
    // The stat pool has a ceiling (allocated + unspent). Once it's full a bought
    // point could never be spent, so the gym's Force → SP exchange closes.
    const gymIsFightWeek = (gymRs?.prepWeeksRemaining ?? 0) === 0 && gymRs?.selectedOpponentId != null;
    const gymTrainingLocked = gymIsFightWeek || (gymRs?.trainingsSinceLastWeek ?? 0) >= 2;
    const gymColors: FighterColors = careerFighterColors(selectedFighter);
    return (
      <>
      <GymView
        fighter={selectedFighter}
        onFighterChanged={(f) => { setSelectedFighter(f); onFighterRefresh?.(f); }}
        onDailyRewardDue={runDailyClaim}
        playerColors={gymColors}
        playerRank={gymRs?.playerRank ?? null}
        weeklyBonus={gymTrainingLocked ? null : (gymRs?.weeklyBonus ?? null)}
        trainingLocked={gymTrainingLocked}
        trainingLockReason={gymIsFightWeek ? "fightWeek" : "weeklyLimit"}
        refinementSpent={gymRefSpent}
        refinementUnlocked={gymRefinementUnlocked}
        refinementUnseen={gymRefinementUnlocked && !gymRs?.refinementCaseSeen}
        onExit={onBack}
        onOpenPlanner={() => setView("hub")}
        onOpenStats={() => setView("stats")}
        onOpenRefinements={() => { markRefinementCaseSeen(); setView("refinement"); }}
        onOpenEquipment={() => setView("equipment")}
        onOpenEditColors={() => setView("editColors")}
        onOpenEditRingColors={() => setView("editRingColors")}
        onLevelUp={() => {
          // Always base level and diamonds on the stored save — the in-memory
          // snapshot can be stale, and stale writes would persist wrong totals.
          const saved = localSaves.getFighter(selectedFighter.id) ?? selectedFighter;
          const diamonds = saved.diamonds ?? 0;
          const curLevel = saved.level ?? 1;
          if (curLevel >= 1000) return;
          // Price is read off the stored purchase count so the cost curve can't
          // be undercut by a stale in-memory snapshot — and so levels earned
          // with XP never make the next purchase dearer.
          const luBought = saved.diamondLevelsBought ?? 0;
          const luCost = diamondLevelUpCost(luBought);
          if (diamonds < luCost) return;
          const updated = updateFighter(selectedFighter.id, {
            level: curLevel + 1,
            diamonds: diamonds - luCost,
            diamondLevelsBought: luBought + 1,
          });
          if (updated) setSelectedFighter(updated);
        }}
        onStartSparring={() => setView("sparringSelect")}
        onStartWeightLifting={() => { onStartTraining(selectedFighter, "weightLifting"); }}
        onStartBagWork={() => { onStartTraining(selectedFighter, "heavyBag"); }}
        sweepStatus={(() => {
          const inCamp = gymRs?.selectedOpponentId != null && (gymRs?.prepWeeksRemaining ?? 0) > 0;
          if (!inCamp) return "notCamp" as const;
          const gymTb = (selectedFighter.trainingBonuses || DEFAULT_TRAINING_BONUSES) as TrainingBonuses;
          if ((gymTb.lastSweepWeek ?? -1) === gymRs!.weekNumber) {
            // Free sweep spent. Only the back half of the week can buy another
            // — in the front half the next free sweep is one week away anyway.
            return (gymRs!.trainingsSinceLastWeek ?? 0) >= 1 ? ("paid" as const) : ("used" as const);
          }
          return "available" as const;
        })()}
        onSweep={(type) => {
          onSweepTraining?.(selectedFighter, type);
          // Sweep writes to the save synchronously — re-sync the gym's snapshot
          // so the once-per-week lock and rep counters reflect immediately.
          const freshSwept = localSaves.getFighter(selectedFighter.id);
          if (freshSwept) setSelectedFighter(freshSwept);
        }}
        onForceChange={(delta) => {
          // Always base the new total on the stored value — the in-memory
          // snapshot can be stale, and delta-on-stale would persist a wrong total.
          const savedBase = localSaves.getFighter(selectedFighter.id)?.force ?? selectedFighter.force ?? 0;
          const newForce = Math.max(0, savedBase + delta);
          const updated = updateFighter(selectedFighter.id, { force: newForce });
          if (updated) setSelectedFighter(updated);
        }}
        onForceToDiamond={() => {
          const savedCnv = localSaves.getFighter(selectedFighter.id);
          const cnvBase = savedCnv?.force ?? selectedFighter.force ?? 0;
          if (cnvBase < FORCE_PER_DIAMOND) return;
          const updated = updateFighter(selectedFighter.id, {
            force: cnvBase - FORCE_PER_DIAMOND,
            diamonds: (savedCnv?.diamonds ?? selectedFighter.diamonds ?? 0) + 1,
          });
          if (updated) setSelectedFighter(updated);
        }}
        roster={gymRs}
        overlayBanner={simWeekBannerEl}
      />
      {(() => {
        // New gear announcement. Every threshold the player has cleared but not
        // been shown lands in one overlay, so a career that predates the crate
        // gets a single list instead of one popup per piece. The list was
        // recorded as announced the moment it was taken, so this is the only
        // time it is ever raised.
        const pending = equipAnnounce;
        if (!pending || pending.length === 0) return null;
        return (
          <div className="fixed inset-0 bg-black/90 flex items-center justify-center z-[9999]" data-testid="overlay-equipment-unlock">
            <div
              className="bg-zinc-900 border-2 border-yellow-500 rounded-xl p-8 max-w-sm w-full mx-4 text-center"
              style={{ boxShadow: "0 0 40px rgba(234,179,8,0.3), 0 0 0 1px rgba(234,179,8,0.1)" }}
            >
              <div className="text-5xl mb-3">📦</div>
              <h2 className="text-white text-lg font-bold mb-3">
                {pending.length > 1 ? "New Equipment Unlocked!" : `${EQUIPMENT[pending[0]].name} Unlocked!`}
              </h2>
              <p className="text-zinc-300 text-sm leading-relaxed">
                {pending.length > 1
                  ? `${pending.map(s => EQUIPMENT[s].name).join(" · ")} — upgrade them at the equipment crate in your gym.`
                  : `Upgrade it at the equipment crate beside the heavy bags.`}
              </p>
              <div className="flex gap-2 mt-6">
                <button
                  className="flex-1 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-white text-sm font-bold border border-white/10"
                  onClick={() => setEquipAnnounce(null)}
                  data-testid="button-equipment-unlock-later"
                >
                  Later
                </button>
                <button
                  className="flex-1 py-2 rounded-lg bg-yellow-500 hover:bg-yellow-400 text-black text-sm font-bold"
                  onClick={() => { setEquipAnnounce(null); setView("equipment"); }}
                  data-testid="button-equipment-unlock-open"
                >
                  Open
                </button>
              </div>
            </div>
          </div>
        );
      })()}
      </>
    );
  }

  if (view === "sparringSelect" && selectedFighter) {
    return <SparringDifficultySelect
      fighter={selectedFighter}
      onSelect={(diff, importedPartnerId) => {
        onStartTraining(selectedFighter, "sparring", diff, importedPartnerId);
      }}
      onNightmare={() => {
        onStartNightmare?.(selectedFighter);
      }}
      onDoghouse={() => {
        onStartDoghouse?.(selectedFighter);
      }}
      onUnlockMode={(mode) => {
        // Buying a mode spends real money, so the requirement and the balance
        // are both re-checked against the save — the card that sent us here was
        // rendered from a snapshot that the gym or Locker may have moved on.
        const cost = SPARRING_MODE_COSTS[mode];
        const fresh = localSaves.getFighter(selectedFighter.id) ?? selectedFighter;
        const balance = fresh.force ?? 0;
        if ((fresh.wins ?? 0) < cost.unlockWins || balance < cost.unlockForce) return;
        const freshRs = fresh.careerRosterState as CareerRosterState | null;
        if (!freshRs) return;
        const unlockedRs: CareerRosterState = mode === "nightmare"
          ? { ...freshRs, nightmareUnlocked: true }
          : { ...freshRs, doghouseUnlocked: true };
        const updated = updateFighter(selectedFighter.id, {
          force: balance - cost.unlockForce,
          careerRosterState: unlockedRs,
        });
        if (updated) setSelectedFighter(updated);
      }}
      onBack={() => setView("gym")}
    />;
  }

  if (view === "opponents" && selectedFighter) {
    const rosterState = selectedFighter.careerRosterState as CareerRosterState | null;
    if (rosterState) {
      return <OpponentSelectionView
        fighter={selectedFighter}
        rosterState={rosterState}
        onSelectOpponent={(oppId) => {
          setPendingOpponentId(oppId);
          setView("prepWeeks");
        }}
        onBack={() => setView("hub")}
      />;
    }
    return null;
  }

  if (view === "prepWeeks" && selectedFighter && pendingOpponentId != null) {
    const rosterState = selectedFighter.careerRosterState as CareerRosterState | null;
    if (rosterState) {
      const opp = rosterState.roster.find(f => f.id === pendingOpponentId);
      const oppData = opp ? buildOpponentFromRoster(opp) : null;
      const oppEntry = opp ? getRosterEntryById(opp.id) : null;
      const oppName = oppEntry && opp ? getRosterDisplayName(oppEntry, opp) : "Unknown";
      const prepPickCd = (selectedFighter.careerDifficulty || "contender") as string;
      const isChampMode = prepPickCd === "champion";
      const champSchedule = (isChampMode && opp) ? getChampionPrepSchedule(opp.id, rosterState.weekNumber, rosterState.campTrainingSessions ?? 0, rosterState.careerFightsCompleted ?? ((selectedFighter.wins ?? 0) + (selectedFighter.losses ?? 0) + (selectedFighter.draws ?? 0))) : null;
      return (
        <div className="flex flex-col items-center gap-4 p-4 max-w-md mx-auto">
          <div className="flex items-center gap-3 w-full">
            <Button variant="ghost" size="icon" onClick={() => { setPendingOpponentId(null); setView("opponents"); }} data-testid="button-back-prep">
              <ArrowLeft className="w-5 h-5" />
            </Button>
            <h2 className="text-xl font-bold flex-1 text-[#eab30a]">Fight Camp</h2>
          </div>
          {oppData && (
            <Card className="p-4 w-full text-[#fffcfc]">
              <p className="font-bold text-lg text-[#a700ff]" data-testid="text-prep-opponent">{oppName}</p>
              <p className="text-sm text-muted-foreground">
                {oppData.archetype} &bull; <span className="text-yellow-500 font-semibold">LV {oppData.level}</span> &bull; Rank #{oppData.rank}
              </p>
              <p className="text-sm text-muted-foreground">
                {oppData.wins}W-{oppData.losses}L-{oppData.draws}D &bull; {oppData.knockouts} KOs
              </p>
            </Card>
          )}
          <p className="text-sm text-center text-[#242d2e]">
            How many camp weeks do you need? Training is available during camp, but locked on fight week.
          </p>
          {isChampMode && <p className="text-xs text-center text-red-400">Opponent&apos;s schedule limits available prep windows.</p>}
          <div className="grid grid-cols-4 gap-2 w-full bg-[#0d0d0d00]">
            {[1, 2, 3, 4, 5, 6, 7, 8].map(weeks => {
              const booked = champSchedule ? !!champSchedule[weeks - 1] : false;
              return (
                <Button
                  key={weeks}
                  variant="outline"
                  disabled={booked}
                  className={`h-16 flex-col gap-1 bg-[#17161600] ${booked ? "opacity-40 cursor-not-allowed text-red-400 border-red-900" : "text-[#333333]"}`}
                  onClick={() => {
                    if (booked) return;
                    const updatedRosterState: CareerRosterState = {
                      ...rosterState,
                      selectedOpponentId: pendingOpponentId,
                      scoutedOpponentIds: pendingOpponentId != null ? Array.from(new Set([...(rosterState.scoutedOpponentIds ?? []), pendingOpponentId])) : rosterState.scoutedOpponentIds,
                      prepWeeksRemaining: weeks,
                      negotiationAttemptsUsed: 0,
                      doghouseUsedThisCamp: false,
                      nightmareUsesThisCamp: 0,
                    };
                    onInitRoster(selectedFighter.id, updatedRosterState);
                    setSelectedFighter(prev => prev ? {
                      ...prev,
                      careerRosterState: updatedRosterState,
                    } : null);
                    setPendingOpponentId(null);
                    setView("hub");
                  }}
                  data-testid={`button-prep-${weeks}`}
                >
                  <span className="text-lg font-bold">{weeks}</span>
                  <span className="text-[10px] text-[#590066]">{weeks === 1 ? "camp wk" : "camp wks"}</span>
                  {booked && <span className="text-[9px] text-red-400 font-medium">Booked</span>}
                </Button>
              );
            })}
          </div>
        </div>
      );
    }
    return null;
  }

  if (view === "reschedule" && selectedFighter) {
    const rosterState = selectedFighter.careerRosterState as CareerRosterState | null;
    if (rosterState && rosterState.selectedOpponentId != null) {
      const opp = rosterState.roster.find(f => f.id === rosterState.selectedOpponentId);
      const oppEntry = opp ? getRosterEntryById(opp.id) : null;
      const oppName = oppEntry && opp ? getRosterDisplayName(oppEntry, opp) : "Unknown";
      const oppData = opp ? buildOpponentFromRoster(opp) : null;
      const isRank1 = (rosterState.playerRank ?? 999) === 1;
      const reschedulesLeft = careerRescheduleAllowance(selectedFighter, rosterState)
        - (rosterState.rescheduledOpponentIds?.length ?? 0);
      return (
        <div className="flex flex-col items-center gap-4 p-4 max-w-md mx-auto">
          <div className="flex items-center gap-3 w-full">
            <Button variant="ghost" size="icon" onClick={() => setView("hub")} data-testid="button-back-reschedule">
              <ArrowLeft className="w-5 h-5" />
            </Button>
            <h2 className="text-xl font-bold flex-1">Reschedule Fight</h2>
          </div>

          {oppData && (
            <Card className="p-4 w-full">
              <p className="font-bold text-lg" data-testid="text-reschedule-opponent">{oppName}</p>
              <p className="text-sm text-muted-foreground">
                {oppData.archetype} &bull; <span className="text-yellow-500 font-semibold">LV {oppData.level}</span> &bull; Rank #{oppData.rank}
              </p>
              <p className="text-sm text-muted-foreground">
                Currently: <span className="text-blue-400 font-semibold">{rosterState.prepWeeksRemaining} {rosterState.prepWeeksRemaining === 1 ? "camp wk" : "camp wks"} out</span>
              </p>
            </Card>
          )}

          <p className="text-sm text-muted-foreground text-center">
            How far out do you want to delay this fight?
          </p>
          {!isRank1 && (
            <p className="text-xs text-yellow-500 -mt-2 text-center" data-testid="text-reschedules-left">
              {reschedulesLeft} career reschedule{reschedulesLeft !== 1 ? "s" : ""} remaining
            </p>
          )}
          {isRank1 && (
            <p className="text-xs text-yellow-500 -mt-2 text-center">Rank #1 — unlimited rescheduling</p>
          )}

          <div className="grid grid-cols-4 gap-2 w-full">
            {[1, 2, 3, 4, 5, 6, 7, 8].map(weeks => (
              <Button
                key={weeks}
                variant="outline"
                className="h-16 flex-col gap-1"
                onClick={() => {
                  const updatedReschOpps = isRank1
                    ? (rosterState.rescheduledOpponentIds ?? [])
                    : [...(rosterState.rescheduledOpponentIds ?? []), rosterState.selectedOpponentId!];
                  const updatedRosterState: CareerRosterState = {
                    ...rosterState,
                    prepWeeksRemaining: weeks,
                    rescheduledOpponentIds: updatedReschOpps,
                    rescheduledThisFight: isRank1 ? true : (rosterState.rescheduledThisFight ?? false),
                  };
                  onInitRoster(selectedFighter.id, updatedRosterState);
                  setSelectedFighter(prev => prev ? { ...prev, careerRosterState: updatedRosterState } : null);
                  setView("hub");
                }}
                data-testid={`button-reschedule-weeks-${weeks}`}
              >
                <span className="text-lg font-bold">{weeks}</span>
                <span className="text-[10px] text-muted-foreground">{weeks === 1 ? "camp wk" : "camp wks"}</span>
              </Button>
            ))}
          </div>
        </div>
      );
    }
    return null;
  }

  if (view === "rankings" && selectedFighter) {
    const rosterState = selectedFighter.careerRosterState as CareerRosterState | null;
    if (rosterState) {
      return <RankingsView rosterState={rosterState} fighter={selectedFighter} onBack={() => setView("hub")} />;
    }
    return null;
  }

  if (view === "rosterEdit" && rosterEditFighter) {
    const rosterState = rosterEditFighter.careerRosterState as CareerRosterState | null;
    if (rosterState) {
      const rfName = rosterEditFighter.firstName
        ? (rosterEditFighter.nickname ? `${rosterEditFighter.firstName} "${rosterEditFighter.nickname}" ${rosterEditFighter.lastName}` : `${rosterEditFighter.firstName} ${rosterEditFighter.lastName}`)
        : rosterEditFighter.name;
      return <RosterEditView
        rosterState={rosterState}
        fighterName={rfName}
        onSave={(updatedRoster) => {
          const updatedState: CareerRosterState = { ...mergeBaseRosterState(rosterEditFighter.id, rosterState), roster: updatedRoster };
          onInitRoster(rosterEditFighter.id, updatedState);
          fighters.forEach(f => {
            if (f.id === rosterEditFighter.id || !f.careerRosterState) return;
            const rs = mergeBaseRosterState(f.id, f.careerRosterState as CareerRosterState);
            onInitRoster(f.id, { ...rs, roster: applyRankEditsToRoster(rs.roster) });
          });
          setRosterEditFighter(null);
          setView("slots");
        }}
        onAutosave={(updatedRoster) => {
          const updatedState: CareerRosterState = { ...mergeBaseRosterState(rosterEditFighter.id, rosterState), roster: updatedRoster };
          onInitRoster(rosterEditFighter.id, updatedState);
        }}
        onBack={() => { setRosterEditFighter(null); setView("slots"); }}
        onRosterRegenerated={() => {
          // Roster Generation just rewrote every stored save. Re-read this one
          // and push it through onInitRoster so the parent (and the fighter
          // list it renders from) carries the new numbers right away.
          const stored = localSaves.getFighter(rosterEditFighter.id);
          const fresh = (stored?.careerRosterState as CareerRosterState | null) ?? null;
          if (!fresh) return null;
          setRosterEditFighter(prev => (prev ? { ...prev, careerRosterState: fresh } : prev));
          onInitRoster(rosterEditFighter.id, fresh);
          return fresh.roster;
        }}
      />;
    }
    return null;
  }

  if (view === "editColors" && selectedFighter) {
    return (
      <EditFighterColors
        fighter={selectedFighter}
        onSave={(skinColor, gearColors, spacialParts) => {
          if (onUpdateColors) {
            onUpdateColors(selectedFighter.id, skinColor, gearColors, spacialParts);
            setSelectedFighter(prev => prev ? { ...prev, skinColor, gearColors, spacialParts, spacialColors: false } : null);
          }
          setView("gym");
        }}
        onBack={() => setView("gym")}
        onBuySpacialPart={(partKey) => {
          // Price the purchase off the persisted balance: Force moves in the
          // gym and the Locker while this screen is open.
          const fresh = localSaves.getFighter(selectedFighter.id) ?? selectedFighter;
          const balance = fresh.force ?? 0;
          const owned = spacialOwnedOf(fresh) as string[];
          if (owned.includes(partKey) || balance < SPACIAL_PRICE_PER_GEAR_FORCE) return;
          // Paying for a piece and seeing nothing change reads as a lost
          // purchase, so a bought piece is worn straight away.
          const worn = spacialSelectionOf(fresh);
          const wornNow = worn === true ? [...SPACIAL_GEAR_KEYS] as string[] : (Array.isArray(worn) ? [...worn] : []);
          const updated = updateFighter(fresh.id, {
            force: balance - SPACIAL_PRICE_PER_GEAR_FORCE,
            spacialRevealed: true,
            spacialOwned: [...owned, partKey],
            spacialParts: wornNow.includes(partKey) ? wornNow : [...wornNow, partKey],
          });
          if (updated) { setSelectedFighter(updated); onFighterRefresh?.(updated); }
        }}
      />
    );
  }

  if (view === "editRingColors" && selectedFighter) {
    return (
      <EditRingColors
        fighter={selectedFighter}
        onBack={() => setView("gym")}
        onSave={(ringColors) => {
          const updated = updateFighter(selectedFighter.id, { ringColors });
          if (updated) { setSelectedFighter(updated); onFighterRefresh?.(updated); }
          setView("gym");
        }}
        onBuyRingSpacial={() => {
          // Price the purchase off the persisted balance: Force moves in the
          // gym and the Locker while this screen is open.
          const fresh = localSaves.getFighter(selectedFighter.id) ?? selectedFighter;
          const balance = fresh.force ?? 0;
          if (fresh.ringSpacialUnlocked || balance < RING_SPACIAL_PRICE_FORCE) return;
          const updated = updateFighter(fresh.id, {
            force: balance - RING_SPACIAL_PRICE_FORCE,
            ringSpacialUnlocked: true,
          });
          if (updated) { setSelectedFighter(updated); onFighterRefresh?.(updated); }
        }}
      />
    );
  }

  if (view === "refinement" && selectedFighter) {
    const refinementLocksBypass = localStorage.getItem("handz_refinement_bypass") === "true";
    const refRosterState = selectedFighter.careerRosterState as CareerRosterState | null;
    const refPlayerRank = refRosterState?.playerRank ?? 0;
    const refStoredRed = ((localSaves.getFighter(selectedFighter.id)?.skillRefinement as Partial<SkillRefinement> | null)?.costReduction) || 0;
    const refLocalRed = ((selectedFighter.skillRefinement as Partial<SkillRefinement> | null)?.costReduction) || 0;
    const refCostReduction = Math.max(refStoredRed, refLocalRed);
    const exchangeCost = refinementExchangeCost(selectedFighter.level || 1, refCostReduction);
    return (
      <RefinementView
        fighter={selectedFighter}
        bypassLocks={refinementLocksBypass}
        playerRank={refPlayerRank}
        exchangeCost={exchangeCost}
        playerForce={selectedFighter.force ?? 0}
        playerDiamonds={selectedFighter.diamonds ?? 0}
        playerFocus={selectedFighter.statFocus ?? 0}
        playerShards={selectedFighter.shards ?? 0}
        onAllocate={(ref, forceCost, diamondCost, shardCost) => {
          if (onAllocateRefinement) onAllocateRefinement(selectedFighter.id, ref, forceCost, diamondCost, shardCost);
          setSelectedFighter(prev => {
            if (!prev) return null;
            return {
              ...prev,
              skillRefinement: ref,
              force: Math.max(0, (prev.force ?? 0) - (forceCost ?? 0)),
              diamonds: Math.max(0, (prev.diamonds ?? 0) - (diamondCost ?? 0)),
              shards: Math.max(0, (prev.shards ?? 0) - (shardCost ?? 0)),
            };
          });
          setView("gym");
        }}
        onUnlock={(track) => {
          if (onUnlockRefinement) onUnlockRefinement(selectedFighter.id, track);
          const forceCost = refUnlockForceCost(track);
          const shardCost = refUnlockShardCost(track);
          const oldRef = (selectedFighter.skillRefinement || DEFAULT_SKILL_REFINEMENT) as SkillRefinement;
          const newRef: SkillRefinement = {
            ...oldRef,
            offenseUnlocked: track === "offense" ? true : oldRef.offenseUnlocked,
            defenseUnlocked: track === "defense" ? true : oldRef.defenseUnlocked,
            fightIqUnlocked: track === "fightIq" ? true : oldRef.fightIqUnlocked,
          };
          setSelectedFighter(prev => prev ? {
            ...prev,
            skillRefinement: newRef,
            force: Math.max(0, (prev.force ?? 0) - forceCost),
            shards: Math.max(0, (prev.shards ?? 0) - shardCost),
          } : null);
        }}
        onStatExchange={() => {
          // Both sides of the trade must come off the SAME freshly-read save.
          // The Exchange button repeats every 50ms while held, far faster than
          // React can flow a write back into this closure, so reading the pool
          // from storage but the refinement from the snapshot spends SP on every
          // repeat while re-granting "the old total + 1" each time.
          const stored = localSaves.getFighter(selectedFighter.id);
          const currentAvailSP = Math.max(0, stored?.availableStatPoints ?? selectedFighter.availableStatPoints ?? 0);
          if (currentAvailSP < exchangeCost) return;
          const baseRef = (stored?.skillRefinement ?? selectedFighter.skillRefinement ?? {}) as Partial<SkillRefinement>;
          const oldRef = { ...DEFAULT_SKILL_REFINEMENT, ...baseRef } as SkillRefinement;
          const newRef: SkillRefinement = { ...oldRef, availablePoints: (oldRef.availablePoints || 0) + 1 };
          const rawSp = (stored?.skillPoints ?? selectedFighter.skillPoints ?? {}) as Partial<SkillPoints>;
          const sp: SkillPoints = { power: rawSp.power || 0, speed: rawSp.speed || 0, defense: rawSp.defense || 0, stamina: rawSp.stamina || 0, focus: rawSp.focus || 0 };
          if (onAllocateRefinement) onAllocateRefinement(selectedFighter.id, newRef);
          onAllocateStats(selectedFighter.id, sp, exchangeCost);
          setSelectedFighter(prev => prev ? { ...prev, skillRefinement: newRef, availableStatPoints: currentAvailSP - exchangeCost } : null);
        }}
        onSetActiveRefinements={(list) => {
          // The pick is its own instant save, rebuilt on a freshly-read copy so
          // it neither rolls back a sibling write nor spends anything sitting
          // unsaved on the screen.
          const stored = localSaves.getFighter(selectedFighter.id);
          const baseRef = { ...DEFAULT_SKILL_REFINEMENT, ...((stored?.skillRefinement ?? selectedFighter.skillRefinement ?? {}) as Partial<SkillRefinement>) } as SkillRefinement;
          const newRef: SkillRefinement = { ...baseRef, activeRefinements: list };
          if (onAllocateRefinement) onAllocateRefinement(selectedFighter.id, newRef);
          setSelectedFighter(prev => prev ? { ...prev, skillRefinement: newRef } : null);
        }}
        onUnlockSlots={(count) => {
          // Catches up a career that passed a Refinement Slot rank before the
          // slots existed (or through a weekly sim that shows no milestone).
          // Rebuilt off the freshest save so this cannot roll back a sibling
          // write to the same blob; the stamp only ever moves up.
          const stored = localSaves.getFighter(selectedFighter.id);
          const baseRef = { ...DEFAULT_SKILL_REFINEMENT, ...((stored?.skillRefinement ?? selectedFighter.skillRefinement ?? {}) as Partial<SkillRefinement>) } as SkillRefinement;
          if (refinementSlotsUnlocked(baseRef) >= count) return;
          const newRef: SkillRefinement = { ...baseRef, activeSlotsUnlocked: Math.min(REFINEMENT_SLOT_RANK_UNLOCKS.length, count) };
          if (onAllocateRefinement) onAllocateRefinement(selectedFighter.id, newRef);
          setSelectedFighter(prev => prev ? { ...prev, skillRefinement: newRef } : null);
        }}
        onBuyCostReduction={exchangeCost > 1 && (selectedFighter.diamonds ?? 0) >= 1 ? () => {
          const oldRef = { ...DEFAULT_SKILL_REFINEMENT, ...((selectedFighter.skillRefinement || {}) as Partial<SkillRefinement>) } as SkillRefinement;
          const newRef: SkillRefinement = { ...oldRef, costReduction: refCostReduction + 1 };
          if (onAllocateRefinement) onAllocateRefinement(selectedFighter.id, newRef, 0, 1);
          setSelectedFighter(prev => prev ? {
            ...prev,
            skillRefinement: newRef,
            diamonds: Math.max(0, (prev.diamonds ?? 0) - 1),
          } : null);
        } : undefined}
        onBack={() => setView("gym")}
      />
    );
  }

  if (view === "hub" && selectedFighter) {
    const rosterState = selectedFighter.careerRosterState as CareerRosterState | null;
    const rawSp = (selectedFighter.skillPoints || {}) as Partial<SkillPoints>;
    const sp: SkillPoints = { power: rawSp.power || 0, speed: rawSp.speed || 0, defense: rawSp.defense || 0, stamina: rawSp.stamina || 0, focus: rawSp.focus || 0 };
    const hubChampBeaten = isChampBeaten(rosterState?.roster ?? []);
    const hubStatCap = statPointCap(hubChampBeaten);
    const hubTotalSP = sp.power + sp.speed + sp.defense + sp.stamina + sp.focus + (selectedFighter.availableStatPoints || 0);
    const showAllocateBanner = (selectedFighter.availableStatPoints || 0) > 0 && hubTotalSP < hubStatCap;
    const tb = (selectedFighter.trainingBonuses || DEFAULT_TRAINING_BONUSES) as TrainingBonuses;
    const isFightWeek = (rosterState?.prepWeeksRemaining ?? 0) === 0 && rosterState?.selectedOpponentId != null;
    const trainingsThisWeek = rosterState?.trainingsSinceLastWeek ?? 0;
    const trainingLocked = isFightWeek || trainingsThisWeek >= 2;
    const isInFightPrep = rosterState?.selectedOpponentId != null && (rosterState?.prepWeeksRemaining ?? 0) > 0;

    const selectedOpp = rosterState?.selectedOpponentId
      ? rosterState.roster.find(f => f.id === rosterState.selectedOpponentId)
      : null;
    const oppData = selectedOpp ? buildOpponentFromRoster(selectedOpp) : null;

    const rescheduledOpps = (rosterState?.rescheduledOpponentIds ?? []) as number[];
    const isRank1Hub = (rosterState?.playerRank ?? 999) === 1;
    const hasFightScheduledForReschedule = rosterState?.selectedOpponentId != null && (rosterState?.prepWeeksRemaining ?? 0) > 0;
    const rescheduleAllowance = careerRescheduleAllowance(selectedFighter, rosterState);
    const canReschedule = hasFightScheduledForReschedule && (
      isRank1Hub
        ? !(rosterState?.rescheduledThisFight ?? false)
        : rescheduledOpps.length < rescheduleAllowance && !rescheduledOpps.includes(rosterState!.selectedOpponentId!)
    );
    const hubWins = selectedFighter.wins ?? 0;
    const maxNegotiateAttempts = hubWins >= 15 ? 3 : hubWins >= 10 ? 2 : 1;
    const negotiateAttemptsUsed = rosterState?.negotiationAttemptsUsed ?? 0;
    const negotiateAttemptsLeft = hubWins >= 3 ? Math.max(0, maxNegotiateAttempts - negotiateAttemptsUsed) : 0;
    const canNegotiate = isInFightPrep && negotiateAttemptsLeft > 0;

    const hubColors: FighterColors = applySpacialGear({
      gloves: (selectedFighter.gearColors as GearColors)?.gloves || DEFAULT_GEAR_COLORS.gloves,
      gloveTape: (selectedFighter.gearColors as GearColors)?.gloveTape || DEFAULT_GEAR_COLORS.gloveTape,
      trunks: (selectedFighter.gearColors as GearColors)?.trunks || DEFAULT_GEAR_COLORS.trunks,
      shoes: (selectedFighter.gearColors as GearColors)?.shoes || DEFAULT_GEAR_COLORS.shoes,
      skin: selectedFighter.skinColor || "#e8c4a0",
      headgear: (selectedFighter.gearColors as GearColors)?.headgear || DEFAULT_GEAR_COLORS.headgear,
      socks: (selectedFighter.gearColors as GearColors)?.socks || DEFAULT_GEAR_COLORS.socks,
      laces: (selectedFighter.gearColors as GearColors)?.laces,
      soles: (selectedFighter.gearColors as GearColors)?.soles,
      waistStripe: (selectedFighter.gearColors as GearColors)?.waistStripe,
    }, spacialSelectionOf(selectedFighter));

    return (
      <div className="flex flex-col items-center gap-3 p-4 max-w-2xl mx-auto">
        <div className="flex items-center gap-3 w-full">
          <Button variant="ghost" size="icon" onClick={() => setView("gym")} data-testid="button-back-hub">
            <ArrowLeft className="w-5 h-5" />
          </Button>
          <h2 className="text-xl font-black italic tracking-wide uppercase flex-1 text-yellow-500" style={{ textShadow: "1px 1px 0 rgba(0,0,0,0.6)" }} data-testid="text-hub-title">Fight Planner</h2>
          {rosterState && (

            <div className="flex items-center gap-4">
              <div className="text-right">
                <span className="text-xs text-muted-foreground" data-testid="text-career-year-week">
                  Year: {Math.floor(rosterState.weekNumber / 52)}  Week: {rosterState.weekNumber % 52}
                </span>
                {rosterState.selectedOpponentId != null && (rosterState.prepWeeksRemaining ?? 0) > 0 && (
                  <p className="text-xs font-bold text-blue-400" data-testid="text-hub-prep-weeks">{rosterState.prepWeeksRemaining} {rosterState.prepWeeksRemaining === 1 ? "camp wk" : "camp wks"} left</p>
                )}
                {rosterState.selectedOpponentId != null && (rosterState.prepWeeksRemaining ?? 0) === 0 && (
                  <p className="text-xs font-bold text-yellow-500" data-testid="text-hub-fight-week">FIGHT WEEK</p>
                )}
              </div>
              <div className="flex flex-col items-end">
                <span className="text-2xl font-black text-yellow-500" data-testid="text-player-rank-header">#{rosterState.playerRank}</span>
                <span className="text-[10px] text-muted-foreground leading-none">RANK</span>
              </div>
            </div>
          )}
        </div>
        <div className="w-full flex flex-col items-center">
          <div className="text-center mb-1">
            <p className={`text-lg font-black tracking-wide border-t-[color:var(--tw-ring-color)] border-r-[color:var(--tw-ring-color)] border-b-[color:var(--tw-ring-color)] border-l-[color:var(--tw-ring-color)] opacity-[0.9] ${selectedFighter.careerDifficulty === "champion" ? "bg-black" : "bg-[#634b3b]"}`} data-testid="text-fighter-display-name">
              {selectedFighter.firstName || selectedFighter.name}
              {selectedFighter.nickname ? ` "${selectedFighter.nickname}"` : ""}
              {selectedFighter.lastName ? ` ${selectedFighter.lastName}` : ""}
            </p>
            <div className={`flex items-center justify-center gap-3 flex-wrap ${selectedFighter.careerDifficulty === "champion" ? "bg-black" : "bg-[#634b3b]"}`}>
              <span className="text-xs text-[#eab308]">{selectedFighter.archetype}</span>
              <span className="font-bold text-sm text-[#eab308] bg-[color:var(--badge-outline)]" data-testid="text-fighter-level">LV {selectedFighter.level}</span>
              <span className="text-green-500 font-semibold text-xs" data-testid="text-fighter-wins">{selectedFighter.wins}W</span>
              <span className="text-red-500 font-semibold text-xs" data-testid="text-fighter-losses">{selectedFighter.losses}L</span>
              <span className="text-muted-foreground text-xs" data-testid="text-fighter-draws">{selectedFighter.draws}D</span>
              <span className="text-muted-foreground text-xs">KOs: {selectedFighter.knockouts}</span>
            </div>
          </div>

          <div className="flex gap-2 mb-1 w-full max-w-sm justify-center">
            <div
              className="relative flex items-center gap-1.5 border border-yellow-700/50 rounded-md px-3 py-1.5 bg-[#713f1299] group cursor-default"
              data-testid="button-force-counter"
            >
              <span className="text-yellow-400 text-sm">⚡</span>
              <span className="text-yellow-300 font-bold text-sm font-mono tabular-nums" style={{ display: "inline-block", minWidth: "7rem", textAlign: "right" }}>{(selectedFighter.force ?? 0).toLocaleString()}</span>
              <span className="pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 rounded bg-popover border border-border px-2 py-0.5 text-xs text-popover-foreground whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity z-50 shadow">Force · convert in the Gym</span>
            </div>
            <div className="relative flex items-center gap-1.5 bg-blue-950/60 border border-blue-700/50 rounded-md px-3 py-1.5 group cursor-default">
              <span className="text-blue-300 text-sm">💎</span>
              <span className="text-blue-200 font-bold text-sm font-mono tabular-nums" style={{ display: "inline-block", width: "7rem", textAlign: "right" }}>{Math.min(selectedFighter.diamonds ?? 0, 999_999_999).toLocaleString()}</span>
              <span className="pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 rounded bg-popover border border-border px-2 py-0.5 text-xs text-popover-foreground whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity z-50 shadow">Diamonds</span>
            </div>
          </div>

          <div className="flex items-start justify-center gap-3 my-2">
            <div className="w-48 h-56">
              <FighterStanceCanvas colors={hubColors} width={192} height={224} />
            </div>
            {hubTip && (
              <div className="flex flex-col pt-6 max-w-[110px]">
                <p className="text-[10px] font-bold mb-1 flex items-center gap-0.5 bg-[#634b3b]" style={{ color: "#d4af37" }}>💡 TIP</p>
                <p className="text-[#eab30a] font-bold bg-[color:var(--elevate-1)] text-center opacity-[1] text-[11px]" style={{ color: "#c9a227" }}>{hubTip}</p>
              </div>
            )}
          </div>

          <div className="w-full max-w-sm">
            <div className="h-1.5 rounded-full overflow-hidden bg-[#262626]">
              <div
                className="h-full rounded-full bg-[#4d9432]"
                style={{ width: `${Math.min(100, (selectedFighter.xp / xpToNextLevel(selectedFighter.level)) * 100)}%` }}
              />
            </div>
            <p className="text-[10px] text-muted-foreground mt-0.5 text-center">
              {Math.ceil(selectedFighter.xp)} / {xpToNextLevel(selectedFighter.level)} XP
            </p>
          </div>

          <div className="grid grid-cols-5 gap-2 mt-2 w-full max-w-sm">
            {(["power", "speed", "defense", "stamina", "focus"] as const).map(stat => (
              <div key={stat} className="text-center relative group cursor-help" data-testid={`stat-display-${stat}`}>
                <p className="text-[10px] uppercase text-[#000000]">{stat}</p>
                <p className="text-sm font-bold text-[#5f739e]">{sp[stat] || 0}</p>
                <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 px-2 py-1 bg-popover border border-border rounded shadow-lg text-[10px] text-popover-foreground whitespace-nowrap opacity-0 group-hover:opacity-100 pointer-events-none z-50 transition-opacity">
                  {{
                    power: "Increases damage",
                    speed: "Increases punch & move speed",
                    defense: "Increases block strength & autoguard duration",
                    stamina: "Increases max stamina & regen",
                    focus: "Increases crit & stun chance",
                  }[stat]}
                </div>
              </div>
            ))}
          </div>
          <p className="text-[10px] mt-1 text-center text-[#16191c]">
            Difficulty - {(selectedFighter.careerDifficulty || "contender").charAt(0).toUpperCase() + (selectedFighter.careerDifficulty || "contender").slice(1)}
          </p>
        </div>
        {showAllocateBanner && (
          <Button variant="default" className="w-full max-w-sm gap-2" onClick={() => setView("allocate")} data-testid="button-allocate-stats">
            <ChevronUp className="w-4 h-4" />
            Allocate Stat Points ({selectedFighter.availableStatPoints} available)
          </Button>
        )}
        {oppData ? (
          <Card className="p-4 w-full max-w-sm">
            <p className="text-xs uppercase text-muted-foreground mb-1">Selected Opponent</p>
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div>
                <p className="font-bold" data-testid="text-opponent-name">{oppData.name}</p>
                <p className="text-xs text-muted-foreground">
                  {oppData.archetype} &bull; <span className="text-yellow-500 font-semibold">LV {oppData.level}</span> &bull; Rank #{oppData.rank}
                </p>
                <p className="text-xs text-muted-foreground">
                  {oppData.wins}W-{oppData.losses}L-{oppData.draws}D &bull; {oppData.knockouts} KOs
                </p>
                {(() => {
                  const opp = rosterState?.roster.find(f => f.id === oppData.rosterId);
                  if (!opp) return null;
                  const csp = opp.customSkillPoints;
                  const useCsp = !!csp && Object.values(csp).some(v => (v ?? 0) > 0);
                  const stats = [
                    { label: "POW", val: useCsp ? csp!.power : opp.statPower },
                    { label: "SPD", val: useCsp ? csp!.speed : opp.statSpeed },
                    { label: "DEF", val: useCsp ? csp!.defense : opp.statDefense },
                    { label: "STA", val: useCsp ? csp!.stamina : opp.statStamina },
                    { label: "FOC", val: useCsp ? csp!.focus : opp.statFocus },
                  ].filter(s => s.val != null);
                  if (stats.length === 0) return null;
                  return (
                    <div className="flex gap-3 mt-1 whitespace-nowrap" data-testid="opponent-stat-points">
                      {stats.map(s => (
                        <span key={s.label} className="flex flex-col items-center">
                          <span className="text-[9px] text-muted-foreground uppercase">{s.label}</span>
                          <span className="text-[11px] font-bold" style={{ color: "#eab308" }}>{s.val}</span>
                        </span>
                      ))}
                    </div>
                  );
                })()}
                <p className="text-xs text-muted-foreground">Skill: {oppData.aiDifficulty} &bull; Reach: {oppData.armLength}&quot;</p>
                {(rosterState?.prepWeeksRemaining ?? 0) > 0 && (
                  <p className="text-xs font-semibold text-blue-400 mt-1" data-testid="text-prep-remaining">{rosterState!.prepWeeksRemaining} {rosterState!.prepWeeksRemaining === 1 ? "camp wk" : "camp wks"} left in camp</p>
                )}
              </div>
              <div className="flex flex-col items-end gap-1">
                {(() => {
                  const opp = rosterState?.roster.find(f => f.id === oppData.rosterId);
                  const rounds = opp?.rank === 1 ? 12 : KEY_FIGHTER_IDS.includes(oppData.rosterId) ? 6 : 3;
                  return rounds > 3 ? (
                    <span className="text-[10px] font-bold text-yellow-500">{rounds} Rounds</span>
                  ) : null;
                })()}
                <Button onClick={() => handleFight(oppData.rosterId)} className={`gap-2 ${!isFightWeek ? "opacity-50" : ""}`} disabled={!isFightWeek && rosterState?.prepWeeksRemaining != null && rosterState.prepWeeksRemaining > 0} data-testid="button-start-bout">
                  <BoxingGloveIcon className="w-4 h-4" /> {isFightWeek ? "Fight!" : "Fight"}
                </Button>
                {canReschedule && (
                  <Button variant="outline" size="sm" className="gap-1 text-xs" onClick={() => setView("reschedule")} data-testid="button-reschedule-fight">
                    <RotateCcw className="w-3 h-3" /> Reschedule
                  </Button>
                )}
                {canNegotiate && (
                  <Button variant="outline" size="sm" className="gap-1 text-xs text-green-400 border-green-800" onClick={() => { setNegotiateResult(null); setNegotiateConfirmWeek(null); setGuaranteePending(false); setView("negotiate"); }} data-testid="button-negotiate-fight">
                    <MessageSquare className="w-3 h-3" /> Negotiate ({negotiateAttemptsLeft})
                  </Button>
                )}
                {(selectedFighter.diamonds ?? 0) >= 1 && (rosterState?.playerRank ?? 999) <= 704 && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="text-[10px] h-6 px-2 text-red-400 border-red-900 mt-1.5"
                    onClick={() => setCancelFightConfirm(true)}
                    data-testid="button-cancel-fight"
                  >
                    💎CANCEL
                  </Button>
                )}
                <Dialog open={cancelFightConfirm} onOpenChange={setCancelFightConfirm}>
                  <DialogContent className="max-w-sm">
                    <DialogHeader>
                      <DialogTitle>Cancel Fight?</DialogTitle>
                      <DialogDescription>
                        Cancel fight for the cost of 1 Diamond and 1 Rank?
                      </DialogDescription>
                    </DialogHeader>
                    <div className="flex gap-2 mt-2">
                      <Button variant="secondary" className="flex-1" onClick={() => setCancelFightConfirm(false)} data-testid="button-cancel-fight-back">Keep Fight</Button>
                      <Button
                        className="flex-1 bg-red-700 hover:bg-red-600 text-white"
                        onClick={() => {
                          if (!rosterState || (selectedFighter.diamonds ?? 0) < 1) return;
                          const demoted = demotePlayerOneRank(
                            rosterState.roster,
                            rosterState.playerRatingScore,
                            rosterState.playerRank ?? 999,
                            rosterState.rank1HolderId
                          );
                          const updatedRosterState: CareerRosterState = {
                            ...rosterState,
                            selectedOpponentId: null,
                            prepWeeksRemaining: 0,
                            negotiationAttemptsUsed: 0,
                            doghouseUsedThisCamp: false,
                            nightmareUsesThisCamp: 0,
                            playerRatingScore: demoted.playerRatingScore,
                            playerRank: demoted.playerRank,
                            rank1HolderId: demoted.rank1HolderId,
                          };
                          // Deduct the diamond in the SAME storage write as the roster
                          // update so no callback ordering can drop it.
                          const storedF = localSaves.getFighter(selectedFighter.id);
                          const newDiamonds = Math.max(0, ((storedF?.diamonds ?? selectedFighter.diamonds) ?? 0) - 1);
                          localSaves.updateFighter(selectedFighter.id, {
                            careerRosterState: updatedRosterState,
                            diamonds: newDiamonds,
                          } as any);
                          // Sync parent state (re-persists the same rosterState; harmless).
                          onInitRoster(selectedFighter.id, updatedRosterState);
                          if (onDiamondSpend) onDiamondSpend(selectedFighter.id, 0);
                          setSelectedFighter(prev => prev ? {
                            ...prev,
                            careerRosterState: updatedRosterState,
                            diamonds: newDiamonds,
                          } : null);
                          setCancelFightConfirm(false);
                        }}
                        data-testid="button-cancel-fight-confirm"
                      >
                        Cancel Fight
                      </Button>
                    </div>
                  </DialogContent>
                </Dialog>
              </div>
            </div>
          </Card>
        ) : (
          <Card className="p-4 w-full max-w-sm text-center text-[#ffffff] opacity-[1] bg-[#634b3b]">
            <p className="text-sm mb-2 text-[#70aeff]">No opponent selected yet.</p>
            <Button variant="default" className="gap-2 opacity-[1] bg-[transparent] border-t-[0px] border-r-[0px] border-b-[0px] border-l-[0px] text-[#eab30a]" onClick={() => {
              const key = `handz_negotiate_unlock_${selectedFighter.id}`;
              if ((selectedFighter.wins ?? 0) >= 3 && !localStorage.getItem(key)) {
                localStorage.setItem(key, '1');
                setNegotiateUnlockNotice(true);
              } else {
                setView("opponents");
              }
            }} data-testid="button-pick-opponent">
              <Swords className="w-4 h-4" /> Choose Opponent
            </Button>
          </Card>
        )}
        <Card className="p-3 w-full max-w-sm bg-[#634b3b]">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <Music className={`w-4 h-4 ${selectedFighter.wins >= 5 ? "text-muted-foreground" : "text-muted-foreground/50"}`} />
                <div>
                  <p className={`text-sm font-semibold ${selectedFighter.wins < 5 ? "text-muted-foreground" : ""}`}>Fight Music</p>
                  <p className="text-[10px] text-muted-foreground">Dynamic music during your fights</p>
                </div>
              </div>
              {selectedFighter.wins >= 5 ? (
                <Switch
                  checked={careerFightMusicEnabled}
                  onCheckedChange={onToggleCareerFightMusic}
                  data-testid="switch-career-fight-music"
                />
              ) : (
                <div className="flex items-center gap-1.5 text-muted-foreground/60">
                  <Lock className="w-3.5 h-3.5" />
                  <span className="text-[10px]">Unlocked after 5 wins</span>
                </div>
              )}
            </div>
            {selectedFighter.wins < 5 && (
              <p className="text-[10px] text-muted-foreground/60 mt-1.5">{selectedFighter.wins}/5 wins</p>
            )}
            {selectedFighter.wins >= 5 && careerFightMusicEnabled && (
              <div className="mt-3 pt-3 border-t flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-[10px] uppercase text-muted-foreground">Song</p>
                  <p className="text-sm font-semibold truncate" data-testid="text-selected-fight-song">
                    {MUSIC_TRACK_NAMES[careerFightMusicTrack] ?? MUSIC_TRACK_NAMES[0]}
                  </p>
                </div>
                <Dialog open={songPickerOpen} onOpenChange={handleSongPickerOpenChange}>
                  <DialogTrigger asChild>
                    <Button variant="secondary" size="sm" className="gap-1 shrink-0" data-testid="button-choose-fight-song">
                      <ListMusic className="w-4 h-4" /> Choose
                    </Button>
                  </DialogTrigger>
                  <DialogContent className="max-w-sm">
                    <DialogHeader>
                      <DialogTitle>Choose Fight Song</DialogTitle>
                      <DialogDescription>Tap the play button to preview a song, or tap a name to pick it for your fights. Your menu music pauses while you listen.</DialogDescription>
                    </DialogHeader>
                    <div className="max-h-[60vh] overflow-y-auto -mx-1 px-1 flex flex-col gap-1">
                      {MUSIC_TRACK_NAMES.map((name, idx) => (
                        <div
                          key={idx}
                          className={`flex items-center gap-1 rounded-md pr-1 transition-colors ${idx === careerFightMusicTrack ? "bg-primary/10" : "hover:bg-muted"}`}
                        >
                          <button
                            type="button"
                            onClick={() => handleToggleSongPreview(idx)}
                            className="shrink-0 p-2 rounded-md text-muted-foreground hover:text-foreground"
                            aria-label={previewingSongIdx === idx ? `Pause preview of ${name}` : `Preview ${name}`}
                            data-testid={`button-preview-song-${idx}`}
                          >
                            {previewingSongIdx === idx ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
                          </button>
                          <button
                            type="button"
                            onClick={() => onSelectCareerFightMusic(idx)}
                            className={`flex flex-1 items-center justify-between gap-2 py-2 pr-2 text-left text-sm ${idx === careerFightMusicTrack ? "font-semibold" : ""}`}
                            data-testid={`button-fight-song-${idx}`}
                          >
                            <span className="truncate">{name}</span>
                            {idx === careerFightMusicTrack && <Check className="w-4 h-4 text-primary shrink-0" />}
                          </button>
                        </div>
                      ))}
                    </div>
                    <DialogClose asChild>
                      <Button variant="secondary" size="sm" className="w-full" data-testid="button-fight-song-done">Done</Button>
                    </DialogClose>
                  </DialogContent>
                </Dialog>
              </div>
            )}
          </Card>
        {isFightWeek && (
          <p className="text-sm font-semibold text-yellow-500 w-full max-w-sm text-center" data-testid="text-fight-week">TIME TO FIGHT</p>
        )}
        {!isFightWeek && (
          <div className="flex flex-col gap-1 w-full max-w-sm">
            <div className="flex items-center justify-between">
              <p className="text-xs text-muted-foreground bg-[#634b3b]" data-testid="text-trainings-this-week">
                Sessions this week: <span className={trainingsThisWeek >= 2 ? "text-red-400 font-semibold" : "text-green-400 font-semibold"}>{trainingsThisWeek}/2</span>
              </p>
            </div>
            {isInFightPrep && !trainingLocked && (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  className="text-[10px] h-6 px-2 w-full border-yellow-600/50 hover:bg-yellow-900/20 bg-[#00000033] border-t-[#0000001a] border-r-[#0000001a] border-b-[#0000001a] border-l-[#0000001a] font-bold text-[#ffffff]"
                  onClick={() => setSimulateConfirmOpen(true)}
                  data-testid="button-simulate-week"
                >⚡ Simulate Week</Button>
                <Dialog open={simulateConfirmOpen} onOpenChange={setSimulateConfirmOpen}>
                  <DialogContent className="max-w-sm">
                    <DialogHeader>
                      <DialogTitle>Simulate Training Week?</DialogTitle>
                      <DialogDescription>
                        {(selectedFighter.careerTrainingSessions || 0) >= 50 ? (
                          <>
                            Your fighter will automatically complete Weight Lifting ({tb.wlHighScore || 12} reps) and Heavy Bag ({tb.hbHighScore || 12} reps) — your high scores — for <strong>0.85× XP and 0.85× SP</strong>, rounded up. You'll still allocate the stat points earned. Skill Refinement points are not awarded for simulated weeks.
                          </>
                        ) : (
                          <>
                            Your fighter will automatically complete Weight Lifting and Heavy Bag at 12 reps each for <strong>0.85× normal XP</strong>. You'll still allocate the stat points earned. Skill Refinement points are not awarded for simulated weeks.
                          </>
                        )}
                      </DialogDescription>
                    </DialogHeader>
                    <div className="flex gap-2 mt-2">
                      <Button variant="secondary" className="flex-1" onClick={() => setSimulateConfirmOpen(false)} data-testid="button-simulate-cancel">Cancel</Button>
                      <Button
                        className="flex-1 bg-yellow-600 hover:bg-yellow-500 text-black font-bold"
                        onClick={() => {
                          setSimulateConfirmOpen(false);
                          if (selectedFighter) onSimulateWeek?.(selectedFighter);
                        }}
                        data-testid="button-simulate-confirm"
                      >
                        Simulate
                      </Button>
                    </div>
                  </DialogContent>
                </Dialog>
              </>
            )}
          </div>
        )}
        <div className="w-full max-w-sm">
          {selectedFighter.level >= 30 ? (
            <Dialog open={rebuildOpen} onOpenChange={setRebuildOpen}>
              <DialogTrigger asChild>
                <Button
                  variant="secondary"
                  className="gap-2 h-auto py-3 flex-col bg-[#eab30b] text-[#ffffff] w-full"
                  data-testid="button-rebuild-skills"
                >
                  <Hammer className="w-5 h-5" />
                  <span className="text-xs">Rebuild Skills</span>
                  <span className="text-[10px] text-[#4d5054]">Reallocate stat points</span>
                </Button>
              </DialogTrigger>
              <DialogContent className="max-w-sm">
                <DialogHeader>
                  <DialogTitle>Rebuild Skills</DialogTitle>
                  <DialogDescription>
                    This returns every allocated stat point to your pool so you can spread them across all skills again. Your base stats stay the same.
                  </DialogDescription>
                </DialogHeader>
                <div className="flex gap-2">
                  <DialogClose asChild>
                    <Button variant="secondary" className="flex-1" data-testid="button-rebuild-cancel">Cancel</Button>
                  </DialogClose>
                  <Button className="flex-1 bg-[#dbaa24] border-t-[0px] border-r-[0px] border-b-[0px] border-l-[0px]" onClick={handleRebuildSkills} data-testid="button-rebuild-confirm">Rebuild</Button>
                </div>
              </DialogContent>
            </Dialog>
          ) : (
            <Button
              variant="secondary"
              className="gap-2 h-auto py-3 flex-col opacity-60 cursor-not-allowed bg-[#634b3b] w-full"
              disabled
              data-testid="button-rebuild-skills-locked"
            >
              <Lock className="w-5 h-5" />
              <span className="text-xs">Rebuild Skills</span>
              <span className="text-[10px] text-muted-foreground">Unlocked after level 30</span>
            </Button>
          )}
        </div>
        <div className="grid grid-cols-2 gap-2 w-full max-w-sm">
          <Button variant="secondary" className="gap-2 text-xs" onClick={() => setView("rankings")} data-testid="button-view-rankings">
            <Trophy className="w-4 h-4" /> Rankings
          </Button>
          <Button variant="secondary" className="gap-2 text-xs" onClick={() => setView("editColors")} data-testid="button-edit-colors">
            <Pencil className="w-4 h-4" /> Edit Colors
          </Button>
          <Button variant="secondary" className="gap-2 text-xs" onClick={() => setView("editRingColors")} data-testid="button-edit-ring-colors">
            <Pencil className="w-4 h-4" /> Ring Colors
          </Button>
        </div>
        {rosterState && rosterState.newsItems.length > 0 && (
          <NewsTicker news={rosterState.newsItems} />
        )}
        {onTutorial && (
          <Button
            variant="ghost"
            className="gap-2 text-xs text-muted-foreground w-full max-w-sm"
            onClick={() => {
              onTutorial(
                selectedFighter.firstName || selectedFighter.name,
                hubColors
              );
            }}
            data-testid="button-career-tutorial"
          >
            Tutorial Mode
          </Button>
        )}
        <div className="fixed bottom-4 left-4 z-40">
          <button
            onClick={() => setShowSettings(!showSettings)}
            className="w-10 h-10 rounded-full bg-muted hover:bg-muted-foreground/20 flex items-center justify-center transition-colors"
            data-testid="button-career-settings"
          >
            <Settings className="w-5 h-5 text-muted-foreground" />
          </button>
          {showSettings && (
            <div className="absolute bottom-12 left-0 bg-card border rounded-lg shadow-lg p-4 w-56" data-testid="panel-career-settings">
              <p className="text-xs font-bold uppercase text-muted-foreground mb-3">Fight Settings</p>
              <div className="space-y-3">
                <div>
                  <p className="text-xs text-muted-foreground mb-1">Rounds (Official Fights)</p>
                  <div className="flex gap-1">
                    {(["auto", 3, 6, 12] as const).map(v => (
                      <Button
                        key={v}
                        size="sm"
                        variant={careerNumRounds === v ? "default" : "secondary"}
                        className="flex-1 text-xs h-7"
                        onClick={() => setCareerNumRounds(v)}
                        data-testid={`button-career-num-rounds-${v}`}
                      >
                        {v === "auto" ? "Auto" : v}
                      </Button>
                    ))}
                  </div>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground mb-1">Round Length</p>
                  <div className="flex gap-1">
                    {[1, 2, 3].map(m => (
                      <Button
                        key={m}
                        size="sm"
                        variant={careerRoundLen === m ? "default" : "secondary"}
                        className="flex-1 text-xs h-7"
                        onClick={() => setCareerRoundLen(m)}
                        data-testid={`button-career-round-${m}`}
                      >
                        {m} min
                      </Button>
                    ))}
                  </div>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground mb-1">Clock Speed</p>
                  <div className="flex gap-1">
                    <Button
                      size="sm"
                      variant={careerTimerSpeed === "normal" ? "default" : "secondary"}
                      className="flex-1 text-xs h-7"
                      onClick={() => setCareerTimerSpeed("normal")}
                      data-testid="button-career-speed-1x"
                    >
                      1x
                    </Button>
                    <Button
                      size="sm"
                      variant={careerTimerSpeed === "fast" ? "default" : "secondary"}
                      className="flex-1 text-xs h-7"
                      onClick={() => setCareerTimerSpeed("fast")}
                      data-testid="button-career-speed-2x"
                    >
                      2x
                    </Button>
                  </div>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground mb-1">Ref Stoppages</p>
                  <div className="flex gap-1">
                    <Button
                      size="sm"
                      variant={careerRefStoppageEnabled ? "default" : "secondary"}
                      className="flex-1 text-xs h-7"
                      onClick={() => onToggleCareerRefStoppage(true)}
                      data-testid="button-ref-stoppage-on"
                    >
                      On
                    </Button>
                    <Button
                      size="sm"
                      variant={!careerRefStoppageEnabled ? "default" : "secondary"}
                      className="flex-1 text-xs h-7"
                      onClick={() => onToggleCareerRefStoppage(false)}
                      data-testid="button-ref-stoppage-off"
                    >
                      Off
                    </Button>
                  </div>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground mb-1">Towel Stoppages</p>
                  <div className="flex gap-1">
                    <Button
                      size="sm"
                      variant={careerTowelStoppageEnabled ? "default" : "secondary"}
                      className="flex-1 text-xs h-7"
                      onClick={() => onToggleCareerTowelStoppage(true)}
                      data-testid="button-towel-stoppage-on"
                    >
                      On
                    </Button>
                    <Button
                      size="sm"
                      variant={!careerTowelStoppageEnabled ? "default" : "secondary"}
                      className="flex-1 text-xs h-7"
                      onClick={() => onToggleCareerTowelStoppage(false)}
                      data-testid="button-towel-stoppage-off"
                    >
                      Off
                    </Button>
                  </div>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground mb-1">EXP Bar in Fights</p>
                  <div className="flex gap-1">
                    <Button
                      size="sm"
                      variant={showExpBar ? "default" : "secondary"}
                      className="flex-1 text-xs h-7"
                      onClick={() => onToggleShowExpBar(true)}
                      data-testid="button-exp-bar-on"
                    >
                      On
                    </Button>
                    <Button
                      size="sm"
                      variant={!showExpBar ? "default" : "secondary"}
                      className="flex-1 text-xs h-7"
                      onClick={() => onToggleShowExpBar(false)}
                      data-testid="button-exp-bar-off"
                    >
                      Off
                    </Button>
                  </div>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground mb-1">Item Icons in Fights</p>
                  <div className="flex gap-1">
                    <Button
                      size="sm"
                      variant={showFightItemsHud ? "default" : "secondary"}
                      className="flex-1 text-xs h-7"
                      onClick={() => onToggleShowFightItemsHud(true)}
                      data-testid="button-fight-items-on"
                    >
                      On
                    </Button>
                    <Button
                      size="sm"
                      variant={!showFightItemsHud ? "default" : "secondary"}
                      className="flex-1 text-xs h-7"
                      onClick={() => onToggleShowFightItemsHud(false)}
                      data-testid="button-fight-items-off"
                    >
                      Off
                    </Button>
                  </div>
                </div>
              </div>
              {selectedFighter && fighters.indexOf(selectedFighter) < 3 && (
                <div className="border-t pt-3 mt-3">
                  <p className="text-xs font-bold uppercase text-muted-foreground mb-2">PIN Protection</p>
                  {(() => {
                    const hasPin = selectedFighter ? getFighterPin(selectedFighter.id) : null;
                    const locked = selectedFighter ? isPinLocked(selectedFighter.id) : true;
                    return (
                      <div className="space-y-2">
                        {!hasPin ? (
                          <Button
                            size="sm"
                            variant="secondary"
                            className="w-full text-xs h-7 gap-1"
                            onClick={() => {
                              setPinTargetFighter(selectedFighter);
                              setPinFlow("setNew");
                              setPinDigits("");
                              setPinError("");
                              setPinSuccess("");
                              setShowSettings(false);
                            }}
                            data-testid="button-set-pin"
                          >
                            <Lock className="w-3 h-3" /> Set PIN Code
                          </Button>
                        ) : (
                          <>
                            <div className="flex items-center justify-between">
                              <span className="text-xs text-muted-foreground">PIN Active</span>
                              <Button
                                size="sm"
                                variant={locked ? "default" : "secondary"}
                                className="text-xs h-6 gap-1 px-2"
                                onClick={() => {
                                  if (selectedFighter) {
                                    const newLocked = !locked;
                                    setPinLocked(selectedFighter.id, newLocked);
                                    setPinLockedState(prev => ({ ...prev, [selectedFighter.id]: newLocked }));
                                  }
                                }}
                                data-testid="button-toggle-pin-lock"
                              >
                                {locked ? <><Lock className="w-3 h-3" /> Locked</> : <><Unlock className="w-3 h-3" /> Unlocked</>}
                              </Button>
                            </div>
                            <Button
                              size="sm"
                              variant="secondary"
                              className="w-full text-xs h-7 gap-1"
                              onClick={() => {
                                setPinTargetFighter(selectedFighter);
                                setPinFlow("enterChange");
                                setPinDigits("");
                                setPinError("");
                                setPinSuccess("");
                                setShowSettings(false);
                              }}
                              data-testid="button-change-pin"
                            >
                              Change PIN
                            </Button>
                          </>
                        )}
                      </div>
                    );
                  })()}
                </div>
              )}
            </div>
          )}
        </div>
        {pinFlow && (
          <div className="fixed inset-0 z-50 bg-background/80 flex items-center justify-center" data-testid="overlay-pin-entry">
            <Card className="p-6 max-w-xs w-full text-center space-y-4">
              <Lock className="w-8 h-8 mx-auto text-primary" />
              <p className="font-bold">
                {pinFlow === "setNew" && "Set a 4-digit PIN"}
                {pinFlow === "confirmNew" && "Confirm your PIN"}
                {pinFlow === "enterChange" && "Enter current PIN"}
                {pinFlow === "setChangeNew" && "Enter new PIN"}
                {pinFlow === "confirmChangeNew" && "Confirm new PIN"}
              </p>
              <div className="flex justify-center gap-2">
                {[0, 1, 2, 3].map(i => (
                  <div key={i} className={`w-10 h-12 border-2 rounded flex items-center justify-center text-xl font-bold ${i < pinDigits.length ? "border-primary" : "border-muted"}`}>
                    {i < pinDigits.length ? "•" : ""}
                  </div>
                ))}
              </div>
              <div className="grid grid-cols-3 gap-2 max-w-[200px] mx-auto">
                {[1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => (
                  <Button key={n} variant="secondary" className="h-10 text-lg font-bold" onClick={() => { if (pinDigits.length < 4) setPinDigits(prev => prev + n); setPinError(""); }} data-testid={`button-pin-${n}`}>{n}</Button>
                ))}
                <Button variant="secondary" className="h-10 text-xs" onClick={() => setPinDigits(prev => prev.slice(0, -1))} data-testid="button-pin-backspace">←</Button>
                <Button variant="secondary" className="h-10 text-lg font-bold" onClick={() => { if (pinDigits.length < 4) setPinDigits(prev => prev + "0"); setPinError(""); }} data-testid="button-pin-0">0</Button>
                <Button variant="default" className="h-10 text-xs font-bold" onClick={handlePinSubmit} disabled={pinDigits.length !== 4} data-testid="button-pin-submit">OK</Button>
              </div>
              {pinError && <p className="text-sm text-destructive font-semibold" data-testid="text-pin-error">{pinError}</p>}
              <Button variant="ghost" size="sm" onClick={clearPinFlow} data-testid="button-pin-cancel">Cancel</Button>
            </Card>
          </div>
        )}
        {pinSuccess && (
          <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 bg-green-600 text-white px-4 py-2 rounded-lg shadow-lg text-sm font-semibold" data-testid="text-pin-success">
            {pinSuccess}
          </div>
        )}
        <Dialog open={negotiateUnlockNotice} onOpenChange={(open) => { if (!open) { setNegotiateUnlockNotice(false); setView("opponents"); } }}>
          <DialogContent className="max-w-sm">
            <DialogHeader>
              <DialogTitle>Camp Negotiation Unlocked</DialogTitle>
              <DialogDescription>
                Fight camps can now be negotiated. When you have a fight scheduled, use the <strong>Negotiate</strong> button to try moving the camp date. Your base success chance is <strong>25%</strong>, rising by 3% for every win — capped at 90%.
              </DialogDescription>
            </DialogHeader>
            <Button className="w-full bg-[#0068ff] border-t-[0px] border-r-[0px] border-b-[0px] border-l-[0px]" onClick={() => { setNegotiateUnlockNotice(false); setView("opponents"); }} data-testid="button-negotiate-unlock-ok">Got it</Button>
          </DialogContent>
        </Dialog>
      </div>
    );
  }

  if (view === "negotiate" && selectedFighter) {
    const rosterState = selectedFighter.careerRosterState as CareerRosterState | null;
    if (rosterState && rosterState.selectedOpponentId != null) {
      const opp = rosterState.roster.find(f => f.id === rosterState.selectedOpponentId);
      const oppEntry = opp ? getRosterEntryById(opp.id) : null;
      const oppName = oppEntry && opp ? getRosterDisplayName(oppEntry, opp) : "Unknown";
      const wins = selectedFighter.wins ?? 0;
      const negotiateChance = Math.min(0.90, 0.25 + wins * 0.03);
      const maxAttempts = wins >= 15 ? 3 : wins >= 10 ? 2 : 1;
      const attemptsUsed = rosterState.negotiationAttemptsUsed ?? 0;
      const attemptsLeft = Math.max(0, maxAttempts - attemptsUsed);
      const guaranteesUsed = rosterState.guaranteedNegotiationsUsed ?? 0;
      const isChampMode = (selectedFighter.careerDifficulty || "contender") === "champion";
      const champSchedule = (isChampMode && opp) ? getChampionPrepSchedule(opp.id, rosterState.weekNumber, rosterState.campTrainingSessions ?? 0, rosterState.careerFightsCompleted ?? ((selectedFighter.wins ?? 0) + (selectedFighter.losses ?? 0) + (selectedFighter.draws ?? 0))) : null;

      // Roster state as stored right now. Guarantee purchases and negotiation
      // attempts both write the whole object, so each must build on the other's
      // save rather than on the roster this render happened to capture.
      const freshNegotiateRoster = (): CareerRosterState =>
        (localSaves.getFighter(selectedFighter.id)?.careerRosterState as CareerRosterState | null) ?? rosterState;

      const confirmNegotiate = () => {
        if (negotiateResult === 'success') return;
        if (negotiateConfirmWeek == null) return;
        const weeks = negotiateConfirmWeek;
        const rand = ((Date.now() % 1000) / 1000);
        const success = guaranteePending || rand < negotiateChance;
        const newAttemptsUsed = attemptsUsed + 1;
        if (guaranteePending) setGuaranteePending(false);
        const rosterBase = freshNegotiateRoster();
        if (success) {
          const updatedRosterState: CareerRosterState = { ...rosterBase, prepWeeksRemaining: weeks, negotiationAttemptsUsed: newAttemptsUsed };
          onInitRoster(selectedFighter.id, updatedRosterState);
          setSelectedFighter(prev => prev ? { ...prev, careerRosterState: updatedRosterState } : null);
          setNegotiateConfirmWeek(null);
          setGuaranteeNegotiateConfirm(false);
        } else {
          const updatedRosterState: CareerRosterState = { ...rosterBase, negotiationAttemptsUsed: newAttemptsUsed };
          onInitRoster(selectedFighter.id, updatedRosterState);
          setSelectedFighter(prev => prev ? { ...prev, careerRosterState: updatedRosterState } : null);
          setNegotiateConfirmWeek(null);
        }
        setNegotiateResult(success ? 'success' : 'fail');
      };

      return (
        <div className="flex flex-col items-center gap-4 p-4 max-w-md mx-auto">
          <div className="flex items-center gap-3 w-full">
            <Button variant="ghost" size="icon" onClick={() => { setNegotiateConfirmWeek(null); setNegotiateResult(null); setView("hub"); }} data-testid="button-back-negotiate">
              <ArrowLeft className="w-5 h-5" />
            </Button>
            <h2 className="text-xl font-bold flex-1">Negotiate Camp Date</h2>
          </div>
          <Card className="p-4 w-full">
            <p className="font-bold" data-testid="text-negotiate-opponent">{oppName}</p>
            <p className="text-sm text-muted-foreground">
              Currently: <span className="text-blue-400 font-semibold">{rosterState.prepWeeksRemaining} {rosterState.prepWeeksRemaining === 1 ? "camp wk" : "camp wks"} out</span>
            </p>
          </Card>
          <div className="flex justify-between items-center w-full text-sm">
            <span className="text-muted-foreground">Chance: <span className="text-green-400 font-bold">{guaranteePending ? 100 : Math.round(negotiateChance * 100)}%</span></span>
            <span className="text-muted-foreground">Attempts left: <span className="text-yellow-400 font-bold">{attemptsLeft}</span></span>
          </div>
          {(() => {
            const guaranteeCost = computeGuaranteeNegotiateShardCost(guaranteesUsed);
            const playerShardAmt = selectedFighter.shards ?? 0;
            const canAffordGuarantee = playerShardAmt >= guaranteeCost;
            return (
              <div className="w-full flex items-center justify-between border border-sky-700/40 rounded-md px-3 py-2 gap-2 bg-[#23252b]">
                <div>
                  <p className="text-xs font-bold text-sky-300">🔷 Shard Guarantee</p>
                  <p className="text-[10px] text-[#ffffff]">Spend 🔷{guaranteeCost.toLocaleString()} Shards to guarantee success</p>
                  <p className="text-[10px] text-sky-500">You have 🔷{playerShardAmt.toLocaleString()} Shards — each guarantee makes the next 10% dearer</p>
                </div>
                <Button size="sm" variant="outline"
                  className="border-sky-700 text-sky-300 hover:bg-sky-900 text-xs h-8"
                  disabled={!canAffordGuarantee || negotiateResult === 'success' || guaranteePending}
                  onClick={() => setGuaranteeNegotiateConfirm(true)}
                  data-testid="button-guarantee-negotiate">
                  {guaranteePending ? "Guaranteed ✓" : "Guarantee"}
                </Button>
              </div>
            );
          })()}
          <Dialog open={guaranteeNegotiateConfirm} onOpenChange={setGuaranteeNegotiateConfirm}>
            <DialogContent className="max-w-sm">
              <DialogHeader>
                <DialogTitle>Guarantee Negotiation?</DialogTitle>
                <DialogDescription>
                  Spend <span className="font-bold text-foreground">🔷{computeGuaranteeNegotiateShardCost(guaranteesUsed).toLocaleString()} Shards</span> to guarantee your next negotiation succeeds?
                </DialogDescription>
              </DialogHeader>
              <div className="flex gap-2 mt-2">
                <DialogClose asChild>
                  <Button variant="secondary" className="flex-1">Cancel</Button>
                </DialogClose>
                <Button className="flex-1 bg-sky-700 hover:bg-sky-600"
                  onClick={() => {
                    if (negotiateResult === 'success' || guaranteePending) { setGuaranteeNegotiateConfirm(false); return; }
                    const rosterBase = freshNegotiateRoster();
                    const usedNow = rosterBase.guaranteedNegotiationsUsed ?? guaranteesUsed;
                    const guaranteeCost2 = computeGuaranteeNegotiateShardCost(usedNow);
                    const currentShards2 = (localSaves.getFighter(selectedFighter.id)?.shards ?? selectedFighter.shards) ?? 0;
                    if (currentShards2 < guaranteeCost2) return;
                    // Every purchase raises the next price, so the counter is persisted
                    // with the save rather than kept in view state.
                    const guaranteeRosterState: CareerRosterState = {
                      ...rosterBase,
                      guaranteedNegotiationsUsed: usedNow + 1,
                    };
                    onInitRoster(selectedFighter.id, guaranteeRosterState);
                    if (onShardSpend) onShardSpend(selectedFighter.id, guaranteeCost2);
                    setSelectedFighter(prev => prev ? {
                      ...prev,
                      shards: currentShards2 - guaranteeCost2,
                      careerRosterState: guaranteeRosterState,
                    } : null);
                    setGuaranteePending(true);
                    setGuaranteeNegotiateConfirm(false);
                  }}
                  data-testid="button-guarantee-negotiate-ok">
                  Confirm
                </Button>
              </div>
            </DialogContent>
          </Dialog>
          {negotiateResult === 'success' && (
            <div className="w-full bg-green-950 border border-green-600 rounded-md px-3 py-2">
              <p className="text-sm text-green-300 font-semibold">✓ Negotiation successful! Camp date updated.</p>
            </div>
          )}
          {negotiateResult === 'fail' && (
            <div className="w-full bg-red-950 border border-red-600 rounded-md px-3 py-2">
              <p className="text-sm text-red-300 font-semibold">✗ Negotiation failed.{attemptsLeft > 0 ? ` ${attemptsLeft} attempt${attemptsLeft !== 1 ? "s" : ""} remaining.` : " No more attempts this camp."}</p>
            </div>
          )}
          {guaranteePending && negotiateResult !== 'success' && (
            <div className="w-full bg-yellow-950 border border-yellow-600 rounded-md px-3 py-2">
              <p className="text-sm text-yellow-300 font-semibold">⚡ Guarantee active — pick a week below. It will succeed.</p>
            </div>
          )}
          {(attemptsLeft > 0 || guaranteePending) && negotiateResult !== 'success' ? (
            <div className="grid grid-cols-4 gap-2 w-full">
              {[1, 2, 3, 4, 5, 6, 7, 8].map(weeks => {
                const booked = champSchedule ? !!champSchedule[weeks - 1] : false;
                return (
                  <Button
                    key={weeks}
                    variant="outline"
                    className={`h-16 flex-col gap-1 ${booked ? "border-orange-600/50 text-orange-400" : ""}`}
                    onClick={() => setNegotiateConfirmWeek(weeks)}
                    data-testid={`button-negotiate-week-${weeks}`}
                  >
                    <span className="text-lg font-bold">{weeks}</span>
                    <span className="text-[10px] text-[#ffffff] bg-[#424242]">{weeks === 1 ? "camp wk" : "camp wks"}</span>
                    {booked && <span className="text-[9px] text-orange-400 font-medium">Booked</span>}
                  </Button>
                );
              })}
            </div>
          ) : (
            negotiateResult !== 'success' && (
              <p className="text-sm text-muted-foreground text-center">No negotiation attempts remaining this camp.</p>
            )
          )}
          {negotiateResult === 'success' && (
            <Button className="w-full" onClick={() => { setNegotiateResult(null); setView("hub"); }} data-testid="button-negotiate-done">Done</Button>
          )}
          <Dialog open={negotiateConfirmWeek != null} onOpenChange={(open) => { if (!open) setNegotiateConfirmWeek(null); }}>
            <DialogContent className="max-w-sm">
              <DialogHeader>
                <DialogTitle>Negotiate for this week?</DialogTitle>
                <DialogDescription>
                  You have a <span className="text-green-400 font-bold">{guaranteePending ? 100 : Math.round(negotiateChance * 100)}%</span> chance of moving the fight to <strong>{negotiateConfirmWeek} {negotiateConfirmWeek === 1 ? "camp week" : "camp weeks"}</strong> out. This uses 1 attempt.
                </DialogDescription>
              </DialogHeader>
              <div className="flex gap-2 mt-2">
                <Button variant="secondary" className="flex-1" onClick={() => setNegotiateConfirmWeek(null)}>Cancel</Button>
                <Button className="flex-1" onClick={confirmNegotiate} data-testid="button-negotiate-confirm">Negotiate</Button>
              </div>
            </DialogContent>
          </Dialog>
        </div>
      );
    }
    return null;
  }

  return (
    <div className="flex flex-col items-center gap-4 p-4 max-w-lg mx-auto">
      <div className="flex items-center gap-3 w-full">
        <Button variant="ghost" size="icon" onClick={() => onBack()} data-testid="button-back-career">
          <ArrowLeft className="w-5 h-5" />
        </Button>
        <h2 className="text-2xl font-bold flex-1" data-testid="text-career-title">Career Mode</h2>
      </div>
      {isLoading ? (
        <div className="text-muted-foreground text-sm py-8">Loading...</div>
      ) : (
        <div className="space-y-3 w-full">
          {fighters.map((f, i) => (
            <Card
              key={f.id}
              className="p-4 cursor-pointer hover-elevate bg-[#634b3b]"
              onClick={() => handleSelectSlot(f)}
              data-testid={`card-slot-${i}`}
            >
              <div className="flex items-center justify-between gap-3">
                <div className="flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-xs text-muted-foreground">Slot {i + 1}</span>
                    <span className="font-bold text-[#eab308]">
                      {f.firstName || f.name}
                      {f.nickname ? ` "${f.nickname}"` : ""}
                      {f.lastName ? ` ${f.lastName}` : ""}
                    </span>
                  </div>
                  <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground flex-wrap">
                    <span className="font-semibold text-[#eab308]">LV {f.level}</span>
                    <span className="text-[#80a8ff]">{f.archetype}</span>
                    <span className="text-[#eab308]">{f.wins}W-{f.losses}L-{f.draws}D</span>
                  </div>
                  <div className="text-[#82acff]">
                    <div
                      className="h-full rounded-full bg-primary"
                      style={{ width: `${Math.min(100, (f.xp / xpToNextLevel(f.level)) * 100)}%` }}
                    />
                  </div>
                </div>
                <div className="flex flex-col gap-1">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-[#266e3e]"
                    onClick={e => { e.stopPropagation(); handleDownloadData(f); }}
                    title="Download Save"
                    data-testid={`button-download-slot-${i}`}
                  >
                    <Download className="w-4 h-4 text-muted-foreground" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    onClick={e => { e.stopPropagation(); handleDeleteSlot(f.id); }}
                    data-testid={`button-delete-slot-${i}`}
                  >
                    <Trash2 className="w-4 h-4 text-muted-foreground" />
                  </Button>
                </div>
              </div>
            </Card>
          ))}

          {fighters.length < MAX_SLOTS && (
            <Card
              className="p-6 cursor-pointer hover-elevate border-dashed text-center bg-[#634b3b]"
              onClick={() => setView("create")}
              data-testid="card-new-slot"
            >
              <Plus className="w-6 h-6 mx-auto mb-1 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">New Fighter</p>
            </Card>
          )}

          {(
              <Card
                className="shadcn-card rounded-xl border border-card-border text-card-foreground shadow-sm p-6 border-dashed text-center transition-colors bg-[#634b3b]"
                onDrop={handleDrop}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                data-testid="card-import-slot"
              >
                <Upload className="w-6 h-6 mx-auto mb-1 text-muted-foreground" />
                <p className="text-sm text-muted-foreground mb-2">
                  {dragOver ? "Drop save file here" : "Drag a save file here, or"}
                </p>
                {!dragOver && (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => fileInputRef.current?.click()}
                    data-testid="button-upload-save"
                  >
                    <Upload className="w-3 h-3 mr-1" /> Upload Save
                  </Button>
                )}
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".json"
                  className="hidden"
                  onChange={handleFileSelect}
                />
              </Card>
          )}

          {importError && (
            <p className="text-destructive text-sm text-center" data-testid="text-import-error">{importError}</p>
          )}
        </div>
      )}
      {pendingImportFile && (
        <div className="fixed inset-0 z-50 bg-background/80 flex items-center justify-center" data-testid="overlay-overwrite-confirm">
          <Card className="p-6 max-w-xs w-full text-center space-y-4 bg-[#002b8a] text-[#ffffff]">
            <Upload className="w-8 h-8 mx-auto text-destructive" />
            <p className="font-bold">Overwrite your existing save?</p>
            <p className="text-sm text-[#ffffff]">Importing this file will replace your current save. This action cannot be undone.</p>
            <div className="flex gap-2 justify-center">
              <Button variant="secondary" className="bg-[#5f79a6]" onClick={() => setPendingImportFile(null)} data-testid="button-cancel-overwrite">Cancel</Button>
              <Button variant="destructive" onClick={confirmOverwriteImport} data-testid="button-confirm-overwrite">Overwrite</Button>
            </div>
          </Card>
        </div>
      )}
      {deleteConfirmId && (
        <div className="fixed inset-0 z-50 bg-background/80 flex items-center justify-center" data-testid="overlay-delete-confirm">
          <Card className="p-6 max-w-xs w-full text-center space-y-4 bg-[#002b8a] text-[#ffffff]">
            <Trash2 className="w-8 h-8 mx-auto text-destructive" />
            <p className="font-bold">Delete this save?</p>
            <p className="text-sm text-[#ffffff]">This action cannot be undone. All progress will be lost.</p>
            <div className="flex gap-2 justify-center">
              <Button variant="secondary" className="bg-[#5f79a6]" onClick={() => setDeleteConfirmId(null)} data-testid="button-cancel-delete">Cancel</Button>
              <Button variant="destructive" onClick={() => confirmDelete(deleteConfirmId)} data-testid="button-confirm-delete">Delete</Button>
            </div>
          </Card>
        </div>
      )}
      {pinFlow && (
        <div className="fixed inset-0 z-50 bg-background/80 flex items-center justify-center" data-testid="overlay-pin-entry">
          <Card className="p-6 max-w-xs w-full text-center space-y-4">
            <Lock className="w-8 h-8 mx-auto text-primary" />
            <p className="font-bold">
              {pinFlow === "setNew" && "Set a 4-digit PIN"}
              {pinFlow === "confirmNew" && "Confirm your PIN"}
              {pinFlow === "enterLoad" && "Enter PIN to load"}
              {pinFlow === "enterDelete" && "Enter PIN to delete"}
              {pinFlow === "enterChange" && "Enter current PIN"}
              {pinFlow === "setChangeNew" && "Enter new PIN"}
              {pinFlow === "confirmChangeNew" && "Confirm new PIN"}
            </p>
            <div className="flex justify-center gap-2">
              {[0, 1, 2, 3].map(i => (
                <div key={i} className={`w-10 h-12 border-2 rounded flex items-center justify-center text-xl font-bold ${i < pinDigits.length ? "border-primary" : "border-muted"}`}>
                  {i < pinDigits.length ? "•" : ""}
                </div>
              ))}
            </div>
            <div className="grid grid-cols-3 gap-2 max-w-[200px] mx-auto">
              {[1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => (
                <Button key={n} variant="secondary" className="h-10 text-lg font-bold" onClick={() => { if (pinDigits.length < 4) setPinDigits(prev => prev + n); setPinError(""); }} data-testid={`button-pin-${n}`}>{n}</Button>
              ))}
              <Button variant="secondary" className="h-10 text-xs" onClick={() => setPinDigits(prev => prev.slice(0, -1))} data-testid="button-pin-backspace">←</Button>
              <Button variant="secondary" className="h-10 text-lg font-bold" onClick={() => { if (pinDigits.length < 4) setPinDigits(prev => prev + "0"); setPinError(""); }} data-testid="button-pin-0">0</Button>
              <Button variant="default" className="h-10 text-xs font-bold" onClick={handlePinSubmit} disabled={pinDigits.length !== 4} data-testid="button-pin-submit">OK</Button>
            </div>
            {pinError && <p className="text-sm text-destructive font-semibold" data-testid="text-pin-error">{pinError}</p>}
            <Button variant="ghost" size="sm" onClick={clearPinFlow} data-testid="button-pin-cancel">Cancel</Button>
          </Card>
        </div>
      )}
      {pinSuccess && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 bg-green-600 text-white px-4 py-2 rounded-lg shadow-lg text-sm font-semibold" data-testid="text-pin-success">
          {pinSuccess}
        </div>
      )}
    </div>
  );
}

function NewsTicker({ news }: { news: string[] }) {
  const tickerRef = useRef<HTMLDivElement>(null);
  const [offset, setOffset] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => {
      setOffset(prev => prev - 1);
    }, 30);
    return () => clearInterval(interval);
  }, []);

  const tickerText = news.join("  \u2022  ") + "  \u2022  " + news.join("  \u2022  ");

  useEffect(() => {
    if (tickerRef.current) {
      const halfWidth = tickerRef.current.scrollWidth / 2;
      if (Math.abs(offset) >= halfWidth) {
        setOffset(0);
      }
    }
  }, [offset]);

  return (
    <div className="w-full max-w-sm overflow-hidden bg-muted/50 rounded-lg py-1.5 px-2" data-testid="news-ticker">
      <div
        ref={tickerRef}
        className="whitespace-nowrap text-xs text-[#eab308]"
        style={{ transform: `translateX(${offset}px)`, display: "inline-block" }}
      >
        {tickerText}
      </div>
    </div>
  );
}

function OpponentSelectionView({ fighter, rosterState, onSelectOpponent, onBack }: {
  fighter: Fighter;
  rosterState: CareerRosterState;
  onSelectOpponent: (oppId: number) => void;
  onBack: () => void;
}) {
  const [hoveredId, setHoveredId] = useState<number | null>(null);
  const [rerollSeed, setRerollSeed] = useState(0);
  const [prevShownIds, setPrevShownIds] = useState<number[]>([]);
  const [rerollConfirmOpen, setRerollConfirmOpen] = useState(false);
  // The card's Force figure is a promise about the payout, so it is built the
  // same way the payout is: the rank curve the fight-end screen uses, times the
  // fighter's own Force item multiplier. Anything less shows a fraction of what
  // actually lands in the bank.
  const forceMult = getForceMult(fighter, rosterState);
  // Weekly opponent availability was removed — every listed fighter is always
  // bookable, so there is nothing left for the Challenge Clause to bypass here.

  const champBeaten = isChampBeaten(rosterState.roster);

  // 10 career wins widens the board to 15 fighters and lets a reroll reach 50
  // ranks above the player. Reading the win count as well as the stored flag
  // means careers already past 10 wins get it immediately.
  const expandedBoard = isExpandedOpponentBoard(rosterState, fighter.wins ?? 0);

  const candidates = getOpponentCandidates(
    rosterState.roster,
    rosterState.playerRank ?? 999,
    fighter.level ?? undefined,
    undefined,
    fighter.wins ?? 0,
    rosterState.careerFightsCompleted,
    rerollSeed,
    prevShownIds,
    expandedBoard
  );

  return (
    <div className="flex flex-col items-center gap-3 p-4 max-w-xl mx-auto">
      <div className="flex items-center gap-3 w-full">
        <Button variant="ghost" size="icon" onClick={() => onBack()} data-testid="button-back-opponents">
          <ArrowLeft className="w-5 h-5" />
        </Button>
        <h2 className="text-xl font-bold flex-1">Choose Opponent</h2>
        <div className="flex flex-col items-end">
          <span className="text-2xl font-black text-yellow-500" data-testid="text-player-rank-opponents">#{rosterState.playerRank}</span>
          <span className="text-[10px] text-muted-foreground leading-none">RANK</span>
        </div>
      </div>
      <div className="flex items-center justify-between w-full">
        <p className="text-xs text-[#ebb400] font-bold">Select Fighter</p>
        {!champBeaten && (
          <>
            <Button
              variant="outline"
              size="sm"
              className="text-xs h-7 px-3 border-yellow-600/40 text-yellow-500 hover:bg-yellow-900/20 hover:text-yellow-400"
              onClick={() => setRerollConfirmOpen(true)}
              data-testid="button-reroll-fighters"
            >
              🎲 Reroll Fighters
            </Button>
            <Dialog open={rerollConfirmOpen} onOpenChange={setRerollConfirmOpen}>
              <DialogContent className="max-w-xs">
                <DialogHeader>
                  <DialogTitle>Reroll Opponents?</DialogTitle>
                </DialogHeader>
                <div className="flex gap-2 mt-2">
                  <Button variant="secondary" className="flex-1" onClick={() => setRerollConfirmOpen(false)} data-testid="button-reroll-cancel">Cancel</Button>
                  <Button
                    className="flex-1 bg-yellow-600 hover:bg-yellow-500 text-black font-bold"
                    onClick={() => { setPrevShownIds(candidates.map(c => c.id)); setRerollSeed(s => s + 1); setRerollConfirmOpen(false); }}
                    data-testid="button-reroll-confirm"
                  >
                    Reroll
                  </Button>
                </div>
              </DialogContent>
            </Dialog>
          </>
        )}
      </div>
      <div className="space-y-2 w-full max-h-[60vh] overflow-y-auto">
        {candidates.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-4">No opponents available in your rank range.</p>
        ) : (
          candidates.map(f => {
            const entry = getRosterEntryById(f.id);
            if (!entry) return null;
            const opp = buildOpponentFromRoster(f);
            if (!opp) return null;
            const isSelected = rosterState.selectedOpponentId === f.id;
            const isChampLocked = !!f.championLocked;
            // The champion lock is a progression gate and is the only thing that
            // can block a listed opponent now that weekly availability is gone.
            const isBlocked = isChampLocked;
            const fc = getRosterFighterColors(f);
            const fighterColors: FighterColors = {
              gloves: fc.gloves,
              gloveTape: fc.gloveTape,
              trunks: fc.trunks,
              shoes: fc.shoes,
              skin: fc.skin,
              socks: fc.socks,
              laces: fc.laces,
              soles: fc.soles,
              waistStripe: fc.waistStripe,
            };
            return (
              <Card
                key={f.id}
                className={`shadcn-card rounded-xl border border-card-border text-card-foreground shadow-sm p-3 w-full transition-all bg-[#ffffff] ${isChampLocked ? "opacity-60 cursor-not-allowed" : "cursor-pointer hover:bg-muted/50"}`}
                onClick={() => {
                  if (isBlocked) return;
                  onSelectOpponent(f.id);
                }}
                onMouseEnter={() => setHoveredId(f.id)}
                onMouseLeave={() => setHoveredId(null)}
                data-testid={`card-opponent-${f.id}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-3 flex-1 min-w-0">
                    <span className={`text-xs font-bold w-8 shrink-0 ${isBlocked ? "text-muted-foreground" : "text-primary"}`}>#{f.rank}</span>
                    <div className="min-w-0 flex-1">
                      <p className={`text-sm font-semibold truncate ${hoveredId === f.id ? "text-[#eab308]" : "text-[#212121]"}`}>{opp.name}</p>
                      <p className="text-[10px] text-[#1c242b]">
                        {opp.archetype} &bull; <span className="text-yellow-500 font-semibold">LV {opp.level}</span> &bull; {opp.aiDifficulty}
                      </p>
                      {hoveredId === f.id && f.statPower != null ? (
                        <p className="text-[10px] text-yellow-400 font-mono font-semibold" data-testid={`text-stats-${f.id}`}>
                          {opp.wins}W-{opp.losses}L-{opp.draws}D &bull; {opp.knockouts} KOs &bull; Reach: {opp.armLength}&quot;
                          {f.rank === 1 ? <span className="text-yellow-500 font-bold"> &bull; 12 Rounds</span> : KEY_FIGHTER_IDS.includes(f.id) ? <span className="text-yellow-500 font-bold"> &bull; 6 Rounds</span> : null}
                        </p>
                      ) : (
                        <p className="text-[10px] text-muted-foreground">
                          {opp.wins}W-{opp.losses}L-{opp.draws}D &bull; {opp.knockouts} KOs &bull; Reach: {opp.armLength}&quot;
                          {f.rank === 1 ? <span className="text-yellow-500 font-bold"> &bull; 12 Rounds</span> : KEY_FIGHTER_IDS.includes(f.id) ? <span className="text-yellow-500 font-bold"> &bull; 6 Rounds</span> : null}
                        </p>
                      )}
                      {(() => {
                        const csp = f.customSkillPoints;
                        const useCsp = !!csp && Object.values(csp).some(v => (v ?? 0) > 0);
                        const statVals: Record<string, number | null | undefined> = {
                          power: useCsp ? csp!.power : f.statPower,
                          speed: useCsp ? csp!.speed : f.statSpeed,
                          defense: useCsp ? csp!.defense : f.statDefense,
                          stamina: useCsp ? csp!.stamina : f.statStamina,
                          focus: useCsp ? csp!.focus : f.statFocus,
                        };
                        if (Object.values(statVals).every(v => v == null)) return null;
                        const scouted = (rosterState.scoutedOpponentIds ?? []).includes(f.id);
                        const hidden = scouted ? [] : getHiddenStatKeys(f.id);
                        const labels: [string, string][] = [["power", "POW"], ["speed", "SPD"], ["defense", "DEF"], ["stamina", "STA"], ["focus", "FOC"]];
                        return (
                          <div className="flex gap-2.5 mt-0.5 whitespace-nowrap" data-testid={`opponent-stats-${f.id}`}>
                            {labels.map(([key, label]) => (
                              <span key={key} className="flex flex-col items-center leading-tight">
                                <span className="text-[8px] text-muted-foreground uppercase">{label}</span>
                                <span className="text-[10px] font-bold" style={{ color: hidden.includes(key as any) ? "#9ca3af" : "#b8860b" }}>
                                  {hidden.includes(key as any) ? "?" : (statVals[key] ?? 0)}
                                </span>
                              </span>
                            ))}
                          </div>
                        );
                      })()}
                    </div>
                    <div className="w-12 h-16 shrink-0">
                      <FighterStanceCanvas colors={fighterColors} width={120} height={144} />
                    </div>
                  </div>
                  {isBlocked && (
                    <span
                      className="text-[10px] text-muted-foreground font-semibold shrink-0 text-right leading-tight"
                      data-testid={`text-opponent-unavailable-${f.id}`}
                    >
                      Unavailable<br />this week
                    </span>
                  )}
                  {isSelected && !isBlocked && <span className="text-xs text-primary font-semibold shrink-0">SELECTED</span>}
                  {!isBlocked && (() => {
                    const reward = Math.round(computeForceEarned(f.rank) * forceMult);
                    return (
                      <div
                        className="flex flex-col items-center shrink-0 leading-tight"
                        title={`⚡${reward.toLocaleString()} Force for a win`}
                        data-testid={`text-force-reward-${f.id}`}
                      >
                        <span className="text-yellow-500 font-bold text-xs">⚡{fmtRefCost(reward)}</span>
                        <span className="text-[8px] uppercase tracking-wide text-muted-foreground">Reward</span>
                      </div>
                    );
                  })()}
                </div>
              </Card>
            );
          })
        )}
      </div>
    </div>
  );
}

function RankingsView({ rosterState, fighter, onBack }: {
  rosterState: CareerRosterState;
  fighter: Fighter;
  onBack: () => void;
}) {
  const ranked = rosterState.roster
    .filter(f => !f.retired && f.rank > 0)
    .sort((a, b) => a.rank - b.rank);

  const playerInsertIndex = ranked.findIndex(f => f.rank >= rosterState.playerRank);
  const playerRank = rosterState.playerRank;

  const playerColors: FighterColors = {
    gloves: (fighter.gearColors as any)?.gloves || "#cc0000",
    gloveTape: (fighter.gearColors as any)?.gloveTape || "#eeeeee",
    trunks: (fighter.gearColors as any)?.trunks || "#ffffff",
    shoes: (fighter.gearColors as any)?.shoes || "#333333",
    skin: fighter.skinColor || "#e8c4a0",
    socks: (fighter.gearColors as any)?.socks || "#f0f0f0",
    laces: (fighter.gearColors as any)?.laces,
    soles: (fighter.gearColors as any)?.soles,
    waistStripe: (fighter.gearColors as any)?.waistStripe,
  };

  return (
    <div className="flex flex-col items-center gap-3 p-4 max-w-xl mx-auto">
      <div className="flex items-center gap-3 w-full">
        <Button variant="ghost" size="icon" onClick={() => onBack()} data-testid="button-back-rankings">
          <ArrowLeft className="w-5 h-5" />
        </Button>
        <h2 className="text-xl font-bold flex-1">Rankings</h2>
        <div className="flex flex-col items-end">
          <span className="text-2xl font-black text-yellow-500" data-testid="text-player-rank-rankings">#{playerRank}</span>
          <span className="text-[10px] text-muted-foreground leading-none">RANK</span>
        </div>
      </div>
      <div className="space-y-1 w-full max-h-[70vh] overflow-y-auto">
        {ranked.map((f, idx) => {
          const entry = getRosterEntryById(f.id);
          if (!entry) return null;
          const name = getRosterDisplayName(entry, f);
          const isPlayerAbove = idx === playerInsertIndex && playerInsertIndex >= 0;
          const showPlayer = isPlayerAbove && playerRank <= f.rank;
          const fc = getRosterFighterColors(f);
          const fighterColors: FighterColors = {
            gloves: fc.gloves,
            gloveTape: fc.gloveTape,
            trunks: fc.trunks,
            shoes: fc.shoes,
            skin: fc.skin,
            socks: fc.socks,
            laces: fc.laces,
            soles: fc.soles,
            waistStripe: fc.waistStripe,
          };

          return (
            <div key={f.id}>
              {showPlayer && (
                <div className="flex items-center gap-3 px-3 py-2 bg-primary/10 rounded-md" data-testid="rankings-player-row">
                  <span className="text-xs font-bold text-primary w-8">#{playerRank}</span>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-bold text-primary truncate">
                      {fighter.firstName || fighter.name}
                      {fighter.nickname ? ` "${fighter.nickname}"` : ""}
                      {fighter.lastName ? ` ${fighter.lastName}` : ""} (YOU)
                    </p>
                    <p className="text-[10px] text-primary/70">
                      {fighter.wins}W-{fighter.losses}L-{fighter.draws}D &bull; LV {fighter.level}
                    </p>
                  </div>
                  <div className="w-12 h-16 shrink-0">
                    <FighterStanceCanvas colors={playerColors} width={120} height={144} />
                  </div>
                </div>
              )}
              <div className="flex items-center gap-3 px-3 py-1.5 opacity-[1] bg-[#00000080]">
                <span className="flex items-center gap-3 px-3 py-1.5 border-t-[0px] border-r-[0px] border-b-[0px] border-l-[0px] bg-[#2424240d]">
                  #{f.rank}
                </span>
                <div className="flex-1 min-w-0">
                  <p className="truncate text-[#ffffff] font-bold bg-[#12121200] border-t-[0px] border-r-[0px] border-b-[0px] border-l-[0px] text-[17px]">{name}</p>
                  <p className="text-[#eab30a] font-bold text-[13px]">
                    {f.wins}W-{f.losses}L-{f.draws}D &bull; {f.knockouts} KOs &bull; LV {f.level}
                  </p>
                  {((f.lastFightResults ?? []).length > 0 || (f.winStreak ?? 0) >= 2 || (f.loseStreak ?? 0) >= 2) && (
                    <div className="flex items-center gap-1 mt-0.5">
                      {(f.winStreak ?? 0) >= 2 && (
                        <span className="text-emerald-400 font-bold text-[10px]">W{f.winStreak}</span>
                      )}
                      {(f.loseStreak ?? 0) >= 2 && (
                        <span className="text-red-400 font-bold text-[10px]">L{f.loseStreak}</span>
                      )}
                      {(f.lastFightResults ?? []).map((r, i) => (
                        <span key={i} className={`text-[9px] font-bold px-0.5 rounded ${
                          r === "KO" ? "bg-yellow-600 text-black" :
                          r === "W" ? "bg-emerald-700 text-white" :
                          r === "L" ? "bg-red-800 text-white" :
                          "bg-gray-600 text-white"
                        }`}>{r}</span>
                      ))}
                    </div>
                  )}
                </div>
                <div className="w-12 h-16 shrink-0">
                  <FighterStanceCanvas colors={fighterColors} width={120} height={144} />
                </div>
              </div>
            </div>
          );
        })}

        {playerInsertIndex === -1 && (
          <div className="flex items-center gap-3 px-3 py-2 bg-primary/10 rounded-md" data-testid="rankings-player-row">
            <span className="text-xs font-bold text-primary w-8">#{playerRank}</span>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-bold text-primary truncate">
                {fighter.firstName || fighter.name}
                {fighter.nickname ? ` "${fighter.nickname}"` : ""}
                {fighter.lastName ? ` ${fighter.lastName}` : ""} (YOU)
              </p>
              <p className="text-[10px] text-primary/70">
                {fighter.wins}W-{fighter.losses}L-{fighter.draws}D &bull; LV {fighter.level}
              </p>
            </div>
            <div className="w-12 h-16 shrink-0">
              <FighterStanceCanvas colors={playerColors} width={120} height={144} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function SwatchRow({ label, selected, options, onSelect, testId }: {
  label: string;
  selected: string;
  options: string[];
  onSelect: (color: string) => void;
  testId: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-muted-foreground w-14 text-right shrink-0">{label}</span>
      <div className="flex gap-1.5 flex-wrap">
        {options.map(c => (
          <button
            key={c}
            className={`w-6 h-6 rounded-md cursor-pointer transition-all ${
              selected === c ? "ring-2 ring-primary ring-offset-1 ring-offset-background" : ""
            }`}
            style={{ backgroundColor: c }}
            onClick={() => onSelect(c)}
            data-testid={`${testId}-${c}`}
          />
        ))}
      </div>
    </div>
  );
}

function CreateFighter({
  firstName, setFirstName, nickname, setNickname, lastName, setLastName,
  archetype, setArchetype, difficulty, setDifficulty, roundLength, setRoundLength,
  skinColor, setSkinColor, gearColors, setGearColors,
  boxingStance, setBoxingStance,
  onCreate, onBack,
}: {
  firstName: string; setFirstName: (v: string) => void;
  nickname: string; setNickname: (v: string) => void;
  lastName: string; setLastName: (v: string) => void;
  archetype: Archetype; setArchetype: (v: Archetype) => void;
  difficulty: AIDifficulty; setDifficulty: (v: AIDifficulty) => void;
  roundLength: number; setRoundLength: (v: number) => void;
  skinColor: string; setSkinColor: (v: string) => void;
  gearColors: GearColors; setGearColors: (v: GearColors) => void;
  boxingStance: "orthodox" | "southpaw"; setBoxingStance: (v: "orthodox" | "southpaw") => void;
  onCreate: () => void;
  onBack: () => void;
}) {
  const [showDiffConfirm, setShowDiffConfirm] = useState(false);
  const previewColors: FighterColors = {
    ...gearColors,
    skin: skinColor,
  };

  const panelCls = "bg-[#1a1a1a] border border-white/15 rounded-lg p-4 w-full space-y-3";
  const sectionLabelCls = "text-[10px] text-white/40 font-semibold uppercase tracking-widest";
  const toggleBtn = (active: boolean) =>
    `text-xs rounded-md px-3 py-2 font-bold transition-colors border ${
      active
        ? "bg-[#634b3b] border-yellow-500/40 text-white"
        : "bg-black/40 border-white/10 text-white/60 hover:bg-white/10"
    }`;
  const colorField = (label: string, value: string, onChange: (v: string) => void, testId: string) => (
    <div className="bg-black/40 border border-white/10 rounded-lg px-3 py-2">
      <label className="text-[10px] text-white/50 font-semibold uppercase tracking-widest mb-1 block">{label}</label>
      <div className="flex items-center gap-2">
        <input type="color" value={value} onChange={e => onChange(e.target.value)} className="w-8 h-8 rounded-md cursor-pointer bg-transparent" data-testid={testId} />
        <span className="text-xs text-white/60 font-mono">{value}</span>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen w-full bg-[#0d0d0d] overflow-y-auto">
      <div className="flex flex-col items-center gap-4 p-4 max-w-lg mx-auto">
        <div className="flex items-center gap-3 w-full">
          <Button variant="ghost" size="icon" onClick={() => onBack()} className="text-white/70 hover:text-white" data-testid="button-back-create">
            <ArrowLeft className="w-5 h-5" />
          </Button>
          <h2 className="flex-1 text-yellow-400 font-black italic uppercase text-xl leading-tight" style={{ textShadow: "1px 1px 0 rgba(0,0,0,0.7)" }}>Create Your Fighter</h2>
        </div>

        <div className={panelCls}>
          <p className={sectionLabelCls}>Identity</p>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-[10px] text-white/50 font-semibold uppercase tracking-widest">First Name *</label>
              <Input value={firstName} onChange={e => setFirstName(e.target.value)} maxLength={15} className="bg-black/40 border-white/10 text-white" data-testid="input-first-name" />
            </div>
            <div>
              <label className="text-[10px] text-white/50 font-semibold uppercase tracking-widest">Last Name *</label>
              <Input value={lastName} onChange={e => setLastName(e.target.value)} maxLength={15} className="bg-black/40 border-white/10 text-white" data-testid="input-last-name" />
            </div>
          </div>
          <div>
            <label className="text-[10px] text-white/50 font-semibold uppercase tracking-widest">Nickname (optional)</label>
            <Input value={nickname} onChange={e => setNickname(e.target.value)} maxLength={20} placeholder='e.g. "The Hammer"' className="bg-black/40 border-white/10 text-white placeholder:text-white/30" data-testid="input-nickname" />
          </div>
        </div>

        <div className={panelCls}>
          <p className={sectionLabelCls}>Fighting Style</p>
          <div className="grid grid-cols-2 gap-2">
            {(["BoxerPuncher", "OutBoxer", "Brawler", "Swarmer"] as Archetype[]).map(a => (
              <button
                key={a}
                onClick={() => setArchetype(a)}
                className={toggleBtn(archetype === a)}
                data-testid={`button-arch-${a}`}
              >
                {a}
              </button>
            ))}
          </div>
          <p className="text-xs text-white/50">{ARCHETYPE_STATS[archetype].description}</p>
          <div className="pt-1">
            <p className={`${sectionLabelCls} mb-1.5`}>Boxing Stance</p>
            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={() => setBoxingStance("orthodox")}
                className={toggleBtn(boxingStance === "orthodox")}
                data-testid="button-stance-orthodox"
              >
                Orthodox
              </button>
              <button
                onClick={() => setBoxingStance("southpaw")}
                className={toggleBtn(boxingStance === "southpaw")}
                data-testid="button-stance-southpaw"
              >
                Southpaw
              </button>
            </div>
            <p className="text-xs text-white/50 mt-1">
              {boxingStance === "orthodox" ? "Right-handed — left hand leads (jab=W, cross=E)" : "Left-handed — right hand leads (jab=E, cross=W)"}
            </p>
          </div>
        </div>

        <div className={panelCls}>
          <p className={sectionLabelCls}>Appearance</p>
          <div className="flex items-start gap-4">
            <div className="flex-1 space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div className="bg-black/40 border border-white/10 rounded-lg px-3 py-2">
                  <label className="text-[10px] text-white/50 font-semibold uppercase tracking-widest mb-1 block">Skin</label>
                  <SkinColorField value={skinColor} onChange={setSkinColor} unlocked={false} testId="color-create-skin" />
                </div>
                {colorField("Gloves", gearColors.gloves, c => setGearColors({ ...gearColors, gloves: c }), "color-create-gloves")}
                {colorField("Tape", gearColors.gloveTape, c => setGearColors({ ...gearColors, gloveTape: c }), "color-create-tape")}
                {colorField("Trunks", gearColors.trunks, c => setGearColors({ ...gearColors, trunks: c }), "color-create-trunks")}
                {colorField("Shoes", gearColors.shoes, c => setGearColors({ ...gearColors, shoes: c }), "color-create-shoes")}
                {colorField("Socks", gearColors.socks || DEFAULT_GEAR_COLORS.socks || "#f0f0f0", c => setGearColors({ ...gearColors, socks: c }), "color-create-socks")}
                {colorField("Headgear", gearColors.headgear || DEFAULT_GEAR_COLORS.headgear || "#2244aa", c => setGearColors({ ...gearColors, headgear: c }), "color-create-headgear")}
                {colorField("Laces", gearColors.laces || defaultLaceColor(gearColors.shoes), c => setGearColors({ ...gearColors, laces: c }), "color-create-laces")}
                {colorField("Soles", gearColors.soles || defaultSoleColor(gearColors.shoes), c => setGearColors({ ...gearColors, soles: c }), "color-create-soles")}
                {colorField("Waist Stripe", gearColors.waistStripe || defaultWaistStripeColor(gearColors.trunks), c => setGearColors({ ...gearColors, waistStripe: c }), "color-create-waist-stripe")}
              </div>
            </div>
            <div className="w-28 h-36 shrink-0 bg-black/40 border border-white/10 rounded-lg flex items-center justify-center overflow-hidden">
              <FighterStanceCanvas colors={previewColors} width={160} height={200} showHeadgear />
            </div>
          </div>
        </div>

        <div className={panelCls}>
          <p className={sectionLabelCls}>Career Difficulty</p>
          <div className="grid grid-cols-2 gap-2">
            {(["elite", "champion"] as AIDifficulty[]).map(d => (
              <button
                key={d}
                onClick={() => setDifficulty(d)}
                className={`${toggleBtn(difficulty === d)} capitalize`}
                data-testid={`button-diff-${d}`}
              >
                {d}
              </button>
            ))}
          </div>
          <p className="text-xs text-white/50">
            {difficulty === "elite" ? "Tough opponents, bigger XP gains." :
             "Maximum difficulty. Only the best survive."}
          </p>
        </div>

        <div className={panelCls}>
          <p className={sectionLabelCls}>Round Length</p>
          <div className="grid grid-cols-3 gap-2">
            {[1, 2, 3].map(m => (
              <button
                key={m}
                onClick={() => setRoundLength(m)}
                className={toggleBtn(roundLength === m)}
                data-testid={`button-round-${m}`}
              >
                {m} min
              </button>
            ))}
          </div>
        </div>

        <Button
          onClick={() => setShowDiffConfirm(true)}
          className="w-full bg-[#634b3b] hover:bg-[#7a5c4a] text-white font-bold"
          disabled={!firstName.trim() || !lastName.trim()}
          data-testid="button-create-fighter"
        >
          Create Fighter
        </Button>

        {showDiffConfirm && (
          <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50" data-testid="modal-diff-confirm">
            <div className="bg-[#1a1a1a] border border-white/20 rounded-xl p-6 max-w-sm w-full mx-4 space-y-4 shadow-2xl">
              <p className="text-lg font-bold text-center text-white">
                Start your career at difficulty:{" "}
                <span className="capitalize text-yellow-400">{difficulty}</span>?
              </p>
              <p className="text-sm text-white/50 text-center">
                {difficulty === "elite" ? "Tough opponents, bigger XP gains." :
                 "Maximum difficulty. Only the best survive."}
              </p>
              <div className="flex gap-3">
                <Button variant="secondary" className="flex-1 bg-white/10 hover:bg-white/20 text-white" onClick={() => setShowDiffConfirm(false)} data-testid="button-diff-confirm-cancel">
                  Cancel
                </Button>
                <Button className="flex-1 bg-[#634b3b] hover:bg-[#7a5c4a] text-white font-bold" onClick={() => { setShowDiffConfirm(false); onCreate(); }} data-testid="button-diff-confirm-ok">
                  Confirm
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function CareerStatsView({ fighter, onBack }: { fighter: Fighter; onBack: () => void }) {
  const stats = (fighter.careerStats || DEFAULT_CAREER_STATS) as CareerStats;
  const tb = (fighter.trainingBonuses || DEFAULT_TRAINING_BONUSES) as TrainingBonuses;
  const accuracy = stats.totalPunchesThrown > 0
    ? ((stats.totalPunchesLanded / stats.totalPunchesThrown) * 100).toFixed(1)
    : "0.0";

  // Everything the player has grooved in the gym, most-landed first. Candidates
  // -- strings landed once and never repeated -- are held back by the list rule.
  const drilled = listedDrilledActions(
    normalizeDrilledActions((fighter.careerRosterState as CareerRosterState | null)?.drilledActions),
  );

  return (
    <div className="flex flex-col items-center gap-4 p-4 max-w-lg mx-auto">
      <div className="flex items-center gap-3 w-full">
        <Button variant="ghost" size="icon" onClick={() => onBack()} data-testid="button-back-stats">
          <ArrowLeft className="w-5 h-5" />
        </Button>
        <h2 className="text-xl font-bold flex-1">Career Stats</h2>
      </div>

      <Card className="p-3 w-full">
        <p className="text-xs uppercase text-muted-foreground font-semibold mb-1">Drilled Action Progress</p>
        {drilled.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            Throw the same three-action string twice in sparring and it starts sharpening here.
          </p>
        ) : (
          <div className="max-h-64 overflow-y-auto pr-1 flex flex-col gap-1" data-testid="list-drilled-actions">
            <p className="text-[10px] text-muted-foreground leading-snug pb-1">
              A string's last punch costs extra stamina until it is rehearsed. Throw it twice in
              one week of sparring and it gets cheaper the following week; throw it at least once
              every three weeks — sparring or a real fight — and it holds where it is.
            </p>
            {drilled.map(entry => {
              const next = drilledNextTierAt(entry.n);
              // The rehearsal clock, worst news first: what the closing punch
              // costs right now, then what this week is doing about it.
              const up = drilledUpkeepOf(entry);
              // The dry streak counts whole weeks that have already rolled over,
              // so a string last thrown in the week just gone reads dw 0 -- the
              // +1 turns it into how long ago that was.
              const weeksAgo = up.dryWeeks + 1;
              const upkeepNote = up.maintained
                ? "Practiced this week"
                : `Practiced ${weeksAgo}${up.dryCapped ? "+" : ""} week${weeksAgo === 1 ? "" : "s"} ago`;
              const upkeepTone = up.staminaMult > 1
                ? "text-amber-400"
                : up.staminaMult < 1
                  ? "text-emerald-400"
                  : "text-muted-foreground";
              return (
                <div
                  key={entry.key}
                  className="flex items-center justify-between gap-2 rounded-md bg-muted/40 px-2 py-1.5"
                  data-testid={`row-drilled-${entry.key}`}
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-medium truncate">{describeDrilledAction(entry.acts)}</p>
                    <p className="text-[10px] text-muted-foreground font-mono">
                      {drilledTierLabel(entry.n)}{next != null ? ` \u00b7 next at ${next}` : ""}
                    </p>
                    <p className={`text-[10px] font-mono ${upkeepTone}`} data-testid={`text-drilled-upkeep-${entry.key}`}>
                      {up.staminaMult}&times; stamina &middot; {upkeepNote}
                    </p>
                  </div>
                  <span className="text-sm font-mono font-semibold tabular-nums shrink-0">{entry.n}</span>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      <Card className="p-4 w-full">
        <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
          <StatRow label="Bouts Fought" value={fighter.careerBoutIndex} />
          <StatRow label="Record" value={`${fighter.wins}W-${fighter.losses}L-${fighter.draws}D`} />
          <StatRow label="Knockouts" value={fighter.knockouts} />
          <StatRow label="Punches Thrown" value={stats.totalPunchesThrown} />
          <StatRow label="Punches Landed" value={stats.totalPunchesLanded} />
          <StatRow label="Accuracy" value={`${accuracy}%`} />
          <StatRow label="KDs Given" value={stats.totalKnockdownsGiven} />
          <StatRow label="KDs Taken" value={stats.totalKnockdownsTaken} />
          <StatRow label="Blocks Made" value={stats.totalBlocksMade} />
          <StatRow label="Dodges" value={stats.totalDodges} />
          <StatRow label="Damage Dealt" value={stats.totalDamageDealt} />
          <StatRow label="Damage Received" value={stats.totalDamageReceived} />
          <StatRow label="Rounds Won" value={stats.totalRoundsWon} />
          <StatRow label="Rounds Lost" value={stats.totalRoundsLost} />
          <StatRow label="Lifetime XP" value={Math.ceil(stats.lifetimeXp)} />
        </div>
      </Card>

      {(tb.weightLifting > 0 || tb.heavyBag > 0 || (tb.sparring || 0) > 0) && (
        <Card className="p-4 w-full">
          <p className="text-xs uppercase text-muted-foreground font-semibold mb-2">Training History</p>
          <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
            <StatRow label="Weight Sessions" value={tb.weightLifting} />
            <StatRow label="Bag Sessions" value={tb.heavyBag} />
            <StatRow label="Sparring Sessions" value={tb.sparring || 0} />
          </div>
        </Card>
      )}
    </div>
  );
}

function StatRow({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono font-semibold">{value}</span>
    </div>
  );
}

export const SPARRING_XP_MULT: Record<AIDifficulty, number> = {
  journeyman: 0.8,
  contender: 1.0,
  elite: 1.35,
  champion: 1.75,
};


/**
 * Nightmare / Doghouse card.
 *
 * Before the win requirement is met the card shows how far off it is rather
 * than an explainer, so the mode reads as something being worked towards. Once
 * the wins are in it turns into the unlock offer, and after that into a normal
 * enterable card carrying its per-session price.
 */
function SparringModeCard({ mode, title, wins, force, shards, detail, cardClass, titleClass, textClass, barClass, onEnter, onUnlock, unlocked }: {
  mode: SparringMode;
  title: string;
  wins: number;
  force: number;
  shards: number;
  detail: string;
  cardClass: string;
  titleClass: string;
  textClass: string;
  barClass: string;
  unlocked: boolean;
  onEnter?: () => void;
  onUnlock?: () => void;
}) {
  const cost = SPARRING_MODE_COSTS[mode];
  const requirementMet = wins >= cost.unlockWins;
  const canBuy = force >= cost.unlockForce;
  const canPaySession = force >= cost.sessionForce && shards >= cost.sessionShards;
  const enterable = unlocked && canPaySession;
  // Purchasable is not locked: the card stays lit and the whole thing buys the
  // mode, rather than hiding the sale behind a caption that reads LOCKED.
  const buyable = !unlocked && requirementMet && canBuy;
  const progress = Math.max(0, Math.min(100, (wins / cost.unlockWins) * 100));
  return (
    <Card
      className={`shadcn-card rounded-xl border border-card-border text-card-foreground shadow-sm p-3 w-full transition-all ${cardClass} ${enterable || buyable ? "cursor-pointer" : "opacity-60 cursor-not-allowed"}`}
      onClick={() => { if (enterable) onEnter?.(); else if (buyable) onUnlock?.(); }}
      data-testid={`card-sparring-${mode}`}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className={`text-sm font-semibold ${titleClass}`}>{title}</p>
          {unlocked ? (
            <p className={`text-[10px] ${textClass}`}>
              {detail} • {cost.sessionForce.toLocaleString()} Force + {cost.sessionShards.toLocaleString()} Shards per session
              {!canPaySession && <span className="text-[#ff9d9d] font-bold"> • can't afford</span>}
            </p>
          ) : requirementMet ? (
            <button
              onClick={e => { e.stopPropagation(); if (canBuy) onUnlock?.(); }}
              disabled={!canBuy}
              className={`mt-1 px-2 py-1 rounded text-[11px] font-bold ${canBuy ? "bg-white/90 text-black hover:bg-white cursor-pointer" : "bg-black/40 text-white/50 cursor-not-allowed"}`}
              data-testid={`button-unlock-${mode}`}
            >
              {canBuy
                ? `Unlock for ${cost.unlockForce.toLocaleString()} Force?`
                : `Needs ${cost.unlockForce.toLocaleString()} Force — you have ${force.toLocaleString()}`}
            </button>
          ) : (
            <div className="mt-1" data-testid={`progress-unlock-${mode}`}>
              <div className="h-1.5 w-full rounded bg-black/50 overflow-hidden">
                <div className={`h-full ${barClass}`} style={{ width: `${progress}%` }} />
              </div>
              <p className={`text-[10px] mt-0.5 ${textClass}`}>{wins} / {cost.unlockWins} career wins</p>
            </div>
          )}
        </div>
        <span className="font-semibold text-[#ffffff] text-[20px]">
          {enterable ? "ENTER" : unlocked ? "COST" : buyable ? "UNLOCK" : "LOCKED"}
        </span>
      </div>
    </Card>
  );
}

function SparringDifficultySelect({ fighter, onSelect, onNightmare, onDoghouse, onUnlockMode, onBack }: {
  fighter: Fighter;
  onSelect: (difficulty: AIDifficulty, importedPartnerId?: number) => void;
  onNightmare?: () => void;
  onDoghouse?: () => void;
  onUnlockMode?: (mode: SparringMode) => void;
  onBack: () => void;
}) {
  const difficulties: AIDifficulty[] = ["journeyman", "contender", "elite", "champion"];
  const rs = fighter.careerRosterState as CareerRosterState | null;
  const hasOpponent = rs?.selectedOpponentId != null;
  const prepWeeks = rs?.prepWeeksRemaining ?? null;
  const nearFight = hasOpponent && prepWeeks != null && prepWeeks <= 2;
  const nightmareBypass = localStorage.getItem("handz_nightmare_bypass") === "true";

  // Both paid modes are bought once and then limited only by what the player
  // can pay per session — no fight-camp window, no per-camp use count.
  //
  // The unlock flags and the balances are read off the persisted save rather
  // than the fighter in hand, for the same reason the Import Ticket below is:
  // quitting a session hands this screen a pre-session snapshot, so a mode
  // bought just before entering is missing from it and the card offers the
  // sale a second time. An unlock is one-way, so the two sources are OR'd —
  // neither a stale snapshot nor a stale save can un-buy a mode.
  const savedFighter = localSaves.getFighter(fighter.id);
  const savedRs = (savedFighter?.careerRosterState ?? null) as CareerRosterState | null;
  const nightmareUnlocked = nightmareBypass || (rs?.nightmareUnlocked ?? false) || (savedRs?.nightmareUnlocked ?? false);
  const doghouseUnlocked = (rs?.doghouseUnlocked ?? false) || (savedRs?.doghouseUnlocked ?? false);
  const careerWins = savedFighter?.wins ?? fighter.wins ?? 0;
  const forceBalance = savedFighter?.force ?? fighter.force ?? 0;
  const shardBalance = savedFighter?.shards ?? fighter.shards ?? 0;

  const allSkillsUnlocked = (fighter.careerBoutIndex || 0) >= 10;
  const sparStatLabels: string[] = allSkillsUnlocked
    ? ["Power", "Speed", "Defense", "Stamina", "Focus"]
    : fighter.level >= 50
      ? ["Speed", "Defense", "Stamina", "Focus"]
      : ["Speed", "Defense", "Stamina"];
  const sparStatText = sparStatLabels.slice(0, -1).join(", ") + (sparStatLabels.length > 1 ? ", or " : "") + sparStatLabels[sparStatLabels.length - 1];

  // Import Ticket: spar anyone on the active roster, at their current level.
  // The Locker arms boosts straight into the save, so the ticket has to be read
  // off the persisted inventory — the fighter snapshot in hand goes stale the
  // moment a session is quit, and the panel would vanish until a reload.
  const hasImportTicket = hasPerk(withSavedInventory(fighter), "importSparring", rs);
  const [importedId, setImportedId] = useState<number | null>(null);
  // Roster entries hold no name of their own; the catalogue does.
  const importRoster = hasImportTicket
    ? [...(rs?.roster ?? [])]
        .sort((a, b) => a.rank - b.rank)
        .map(f => {
          const entry = getRosterEntryById(f.id);
          return { ...f, displayName: entry ? getRosterDisplayName(entry, f) : `Fighter ${f.id}` };
        })
    : [];

  return (
    // pb-24 keeps the last card clear of the fixed boost HUD in the corner.
    <div className="flex flex-col items-center gap-3 p-4 pb-24 max-w-lg mx-auto">
      <div className="flex items-center gap-3 w-full">
        <Button variant="ghost" size="icon" onClick={() => onBack()} data-testid="button-back-sparring">
          <ArrowLeft className="w-5 h-5" />
        </Button>
        <h2 className="text-xl font-bold flex-1">Sparring</h2>
      </div>
      {/* Active item boosts live bottom-left on every screen that shows them. */}
      <ActiveBoostsHud
        fighter={fighter}
        roster={rs}
        className="fixed bottom-3 left-3 z-[70] max-w-[220px]"
        size={28}
        tooltipAlign="left"
      />
      {hasImportTicket && importRoster.length > 0 && (
        <div className="w-full bg-emerald-950/60 border border-emerald-500/40 rounded p-2" data-testid="sparring-import-ticket">
          <div className="text-emerald-200 text-[11px] font-bold mb-1">🎫 Import Ticket — spar anyone on the roster at their current level.</div>
          <select
            className="w-full bg-black/60 border border-white/20 rounded text-xs text-white px-2 py-1.5"
            value={importedId ?? ""}
            onChange={e => setImportedId(e.target.value === "" ? null : Number(e.target.value))}
            data-testid="sparring-import-select"
          >
            <option value="">Normal sparring partner</option>
            {importRoster.map(f => (
              <option key={f.id} value={f.id}>#{f.rank} {f.displayName} — LV {f.level}</option>
            ))}
          </select>
        </div>
      )}
      <p className="text-xs w-full text-[#141412] bg-[#c7c095] font-bold">
        {importedId != null
          ? `Import session: 1 round, 3 minutes \u2022 4\u00d7 rewards on a win \u2022 partner spars on double stamina. Allocate earned points to ${sparStatText}.`
          : `Practice fight: 1 round, 1 minute. Allocate earned points to ${sparStatText}.`}
      </p>
      <div className="space-y-2 w-full">
        {difficulties.map(diff => {
          const fights = fighter.careerBoutIndex || 0;
          const allSparringUnlocked = (fighter.wins || 0) >= 15;
          const minFights = diff === "champion" ? 7 : diff === "elite" ? 4 : diff === "contender" ? 1 : 0;
          const champPrepLocked = diff === "champion" && !nearFight;
          const locked = !allSparringUnlocked && (fights < minFights || champPrepLocked);
          const winPts = diff === "journeyman" ? 2 : diff === "contender" ? 3 : diff === "elite" ? 4 : 5;
          const lockReason = fights < minFights ? `Unlocks at ${minFights} fights` : champPrepLocked ? "Available in last 2 prep weeks" : "";
          return (
            <Card
              key={diff}
              className={`shadcn-card rounded-xl border border-card-border text-card-foreground shadow-sm p-3 w-full transition-all bg-[#c7c095] ${locked ? "opacity-40 cursor-not-allowed" : "cursor-pointer"}`}
              onClick={() => { if (!locked) onSelect(diff, importedId ?? undefined); }}
              data-testid={`card-sparring-${diff}`}
            >
              <div className="flex items-center justify-between gap-2">
                <div>
                  <p className="text-sm font-semibold text-[#0f0f0f]">{AI_DIFFICULTY_LABELS[diff]}</p>
                  <p className="text-[10px] text-[#012c87]">
                    {/* A defeat is no longer a shutout — it pays half the
                        session. Stated as the rule rather than a figure: the
                        loss total is built from a different base than the win
                        figure beside it, so no single number is honest here. */}
                    {locked ? lockReason : `Win: ${importedId != null ? winPts * 4 : winPts} pts \u2022 Lose: half pts`}
                  </p>
                </div>
                <span className="font-semibold text-[#ffffff] text-[20px]">{locked ? "LOCKED" : "SPAR"}</span>
              </div>
            </Card>
          );
        })}
        <SparringModeCard
          mode="nightmare"
          title="Nightmare Mode"
          wins={careerWins}
          force={forceBalance}
          shards={shardBalance}
          unlocked={nightmareUnlocked}
          detail={"Endless survival \u2022 2:00 \u2022 +5s per KO \u2022 XP & crates only"}
          cardClass="bg-[#7a1414]"
          titleClass="text-[#ffd1d1]"
          textClass="text-[#ffb3b3]"
          barClass="bg-[#ff6b6b]"
          onEnter={() => onNightmare?.()}
          onUnlock={() => onUnlockMode?.("nightmare")}
        />
        <SparringModeCard
          mode="doghouse"
          title="Doghouse Round"
          wins={careerWins}
          force={forceBalance}
          shards={shardBalance}
          unlocked={doghouseUnlocked}
          detail={"15\u201360 min \u2022 One crate per opponent \u2022 XP & crates only"}
          cardClass="bg-[#123a5e]"
          titleClass="text-[#bfe3ff]"
          textClass="text-[#8fcaf0]"
          barClass="bg-[#4aa3e0]"
          onEnter={() => onDoghouse?.()}
          onUnlock={() => onUnlockMode?.("doghouse")}
        />
      </div>
    </div>
  );
}

const STAT_TOOLTIPS: Record<keyof SkillPoints, string> = {
  power: "Increases damage",
  speed: "Increases punch & move speed",
  defense: "Increases block strength & autoguard duration",
  stamina: "Increases max stamina & regen",
  focus: "Increases crit & stun chance",
};

function StatAllocRow({ stat, isLocked, value, current, canDec, canInc, onInc, onDec }: {
  stat: keyof SkillPoints; isLocked: boolean; value: number; current: number;
  canDec: boolean; canInc: boolean; onInc: () => void; onDec: () => void;
}) {
  const decHold = useHoldRepeat(onDec);
  const incHold = useHoldRepeat(onInc);
  return (
    <div className={`flex items-center justify-between gap-3 ${isLocked ? "opacity-40" : ""}`}>
      <span className="text-sm capitalize w-20 relative group cursor-help" data-testid={`stat-label-${stat}`}>
        {stat}
        <span className="absolute bottom-full left-0 mb-1 px-2 py-1 bg-popover border border-border rounded shadow-lg text-[10px] text-popover-foreground whitespace-nowrap opacity-0 group-hover:opacity-100 pointer-events-none z-50 transition-opacity">
          {STAT_TOOLTIPS[stat]}
        </span>
      </span>
      <div className="flex items-center gap-2">
        <Button
          variant="secondary"
          size="icon"
          className="shrink-0 bg-[#363636]"
          disabled={!canDec}
          data-testid={`button-dec-${stat}`}
          {...decHold}
        >
          -
        </Button>
        <span className="w-8 text-center font-mono font-bold">{value}</span>
        <Button
          variant="secondary"
          size="icon"
          className="shrink-0 border-t-[#363636] border-r-[#363636] border-b-[#363636] border-l-[#363636]"
          disabled={!canInc}
          data-ui-sound="stats"
          data-testid={`button-inc-${stat}`}
          {...incHold}
        >
          +
        </Button>
      </div>
      <span className="text-xs text-green-500 w-8 text-right">
        {value > current ? `+${value - current}` : ""}
      </span>
    </div>
  );
}

export function AllocateStats({ fighter, onAllocate, onBack, allowedStats, fixedPoints, refinementSlot, noSaveForLater, showAllSkillsBanner }: {
  fighter: Fighter;
  onAllocate: (sp: SkillPoints, spent: number) => void;
  onBack: () => void;
  allowedStats?: (keyof SkillPoints)[];
  fixedPoints?: number;
  refinementSlot?: ReactNode;
  noSaveForLater?: boolean;
  showAllSkillsBanner?: boolean;
}) {
  const rawCurrent = fighter.skillPoints as SkillPoints;
  const current: SkillPoints = { power: rawCurrent.power || 0, speed: rawCurrent.speed || 0, defense: rawCurrent.defense || 0, stamina: rawCurrent.stamina || 0, focus: rawCurrent.focus || 0 };
  const budget = fixedPoints ?? fighter.availableStatPoints;
  const [points, setPoints] = useState<SkillPoints>({ ...current });
  const [saveConfirmOpen, setSaveConfirmOpen] = useState(false);
  const [autoConfirmOpen, setAutoConfirmOpen] = useState(false);
  const spent = (points.power - current.power) + (points.speed - current.speed) +
    (points.defense - current.defense) + (points.stamina - current.stamina) + (points.focus - current.focus);
  const remaining = budget - spent;

  const allowed = allowedStats ? new Set(allowedStats) : null;

  const champBeaten = isChampBeaten((fighter.careerRosterState as CareerRosterState | null)?.roster ?? []);
  const STAT_CAP = perStatCap(champBeaten);
  const increment = (stat: keyof SkillPoints) => {
    if (remaining > 0 && points[stat] < STAT_CAP && (!allowed || allowed.has(stat))) {
      setPoints(p => ({ ...p, [stat]: p[stat] + 1 }));
    }
  };

  const decrement = (stat: keyof SkillPoints) => {
    if (points[stat] > current[stat] && (!allowed || allowed.has(stat))) {
      setPoints(p => ({ ...p, [stat]: p[stat] - 1 }));
    }
  };

  const title = fixedPoints != null ? "Training Reward" : "Allocate Stats";

  const autoDistribute = () => {
    const order: (keyof SkillPoints)[] = (["power", "speed", "defense", "stamina", "focus"] as const)
      .filter(st => !allowed || allowed.has(st));
    const next = { ...points };
    let rem = remaining;
    let idx = 0;
    while (rem > 0 && order.some(st => next[st] < STAT_CAP)) {
      const st = order[idx % order.length];
      if (next[st] < STAT_CAP) {
        next[st] += 1;
        rem -= 1;
      }
      idx += 1;
    }
    const newSpent = (next.power - current.power) + (next.speed - current.speed) +
      (next.defense - current.defense) + (next.stamina - current.stamina) + (next.focus - current.focus);
    setAutoConfirmOpen(false);
    onAllocate(next, newSpent);
  };
  const canAutoDistribute = remaining > 0 && (["power", "speed", "defense", "stamina", "focus"] as const)
    .some(st => (!allowed || allowed.has(st)) && points[st] < STAT_CAP);

  return (
    <div className="flex flex-col items-center gap-4 p-4 max-w-lg mx-auto">
      <div className="flex items-center gap-3 w-full">
        {!fixedPoints && (
          <Button variant="ghost" size="icon" onClick={() => onBack()} data-testid="button-back-allocate">
            <ArrowLeft className="w-5 h-5" />
          </Button>
        )}
        <h2 className="text-xl font-bold flex-1 text-[gold]">{title}</h2>
        <span className="text-[#ffffff] font-extrabold text-[17px] bg-[#95b1c7] border-t-[2px] border-r-[2px] border-b-[2px] border-l-[2px] border-t-[#95b1c7] border-r-[#95b1c7] border-b-[#95b1c7] border-l-[#95b1c7]">{remaining} pts left</span>
      </div>
      {fixedPoints != null && allowedStats && (
        showAllSkillsBanner ? (
          <p className="text-sm font-semibold text-yellow-400 w-full text-center" data-testid="text-all-skills-unlocked">
            You can now allocate all points across all skills
          </p>
        ) : (
          <p className="text-xs w-full text-[#000000]">
            Allocate {budget} point{budget !== 1 ? "s" : ""} to: {allowedStats.map(s => s.charAt(0).toUpperCase() + s.slice(1)).join(", ")}
          </p>
        )
      )}
      <Card className="p-4 w-full space-y-4 bg-[#95b1c7] text-[#000000]">
        {(["power", "speed", "defense", "stamina", "focus"] as const).map(stat => {
          const isLocked = allowed != null && !allowed.has(stat);
          return (
            <StatAllocRow
              key={stat}
              stat={stat}
              isLocked={isLocked}
              value={points[stat]}
              current={current[stat]}
              canDec={!isLocked && points[stat] > current[stat]}
              canInc={!isLocked && remaining > 0 && points[stat] < STAT_CAP}
              onInc={() => increment(stat)}
              onDec={() => decrement(stat)}
            />
          );
        })}
      </Card>
      {refinementSlot}
      {canAutoDistribute && (
        <>
          <Button
            onClick={() => setAutoConfirmOpen(true)}
            className="w-full bg-amber-700 border border-amber-500 hover:border-yellow-300 text-white font-semibold"
            data-testid="button-auto-distribute"
          >
            Auto-Distribute
            <span className="ml-2 text-xs opacity-80">({remaining} pt{remaining !== 1 ? "s" : ""} remaining)</span>
          </Button>
          <Dialog open={autoConfirmOpen} onOpenChange={setAutoConfirmOpen}>
            <DialogContent className="max-w-sm">
              <DialogHeader>
                <DialogTitle>Auto-Distribute Points?</DialogTitle>
                <DialogDescription>
                  The remaining {remaining} stat point{remaining !== 1 ? "s" : ""} will be spread evenly across your available stats.
                  {spent > 0 && ` The ${spent} point${spent !== 1 ? "s" : ""} you've already placed will be kept.`}
                </DialogDescription>
              </DialogHeader>
              <div className="flex gap-2 mt-2">
                <DialogClose asChild>
                  <Button variant="secondary" className="flex-1" data-testid="button-auto-distribute-cancel">Cancel</Button>
                </DialogClose>
                <Button
                  className="flex-1 bg-[#245bdb]"
                  onClick={autoDistribute}
                  data-testid="button-auto-distribute-confirm"
                >
                  Auto-Distribute
                </Button>
              </div>
            </DialogContent>
          </Dialog>
        </>
      )}
      {!noSaveForLater && remaining > 0 ? (
        <>
          <Button
            onClick={() => setSaveConfirmOpen(true)}
            className="w-full bg-zinc-700 border border-zinc-500 hover:border-yellow-400 text-white"
            data-testid="button-save-for-later"
          >
            Save for Refinement
            <span className="ml-2 text-xs opacity-70">({remaining} pt{remaining !== 1 ? "s" : ""} unspent)</span>
          </Button>
          <Dialog open={saveConfirmOpen} onOpenChange={setSaveConfirmOpen}>
            <DialogContent className="max-w-sm">
              <DialogHeader>
                <DialogTitle>Save for Refinement?</DialogTitle>
                <DialogDescription>
                  {remaining} unspent stat point{remaining !== 1 ? "s" : ""} will be saved to your pool — allocate them any time from the career hub.
                  {spent > 0 && ` The ${spent} point${spent !== 1 ? "s" : ""} you've already placed will be kept.`}
                </DialogDescription>
              </DialogHeader>
              <div className="flex gap-2 mt-2">
                <DialogClose asChild>
                  <Button variant="secondary" className="flex-1" data-testid="button-save-later-cancel">Cancel</Button>
                </DialogClose>
                <Button
                  className="flex-1 border-t-[0px] border-r-[0px] border-b-[0px] border-l-[0px] bg-[#245bdb]"
                  onClick={() => { setSaveConfirmOpen(false); onAllocate(points, spent); }}
                  data-testid="button-confirm-save-for-later"
                >
                  Save
                </Button>
              </div>
            </DialogContent>
          </Dialog>
        </>
      ) : (
        <Button
          onClick={() => onAllocate(points, spent)}
          className="w-full flex items-center justify-center gap-2 py-2 px-4 rounded-lg bg-zinc-800 border border-zinc-600 hover:border-yellow-400 hover:bg-zinc-700 text-white font-semibold text-sm"
          disabled={spent === 0}
          data-testid="button-confirm-allocate"
        >
          Confirm Allocation
        </Button>
      )}
    </div>
  );
}

/** Compact price tag for the per-piece buy buttons, where the full figure won't fit. */
const SPACIAL_PART_PRICE_LABEL = `${Math.round(SPACIAL_PRICE_PER_GEAR_FORCE / 1_000_000)}M`;

function EditFighterColors({ fighter, onSave, onBack, onBuySpacialPart }: {
  fighter: Fighter;
  onSave: (skinColor: string, gearColors: GearColors, spacialParts: string[]) => void;
  onBack: () => void;
  /** Buy the finish for a single gear piece. Only called when the balance covers it. */
  onBuySpacialPart: (partKey: string) => void;
}) {
  const gc = (fighter.gearColors as GearColors) || DEFAULT_GEAR_COLORS;
  const [skinColor, setSkinColor] = useState(fighter.skinColor || "#e8c4a0");
  const [gloves, setGloves] = useState(gc.gloves);
  const [gloveTape, setGloveTape] = useState(gc.gloveTape);
  const [trunks, setTrunks] = useState(gc.trunks);
  const [shoes, setShoes] = useState(gc.shoes);
  const [headgear, setHeadgear] = useState(gc.headgear || DEFAULT_GEAR_COLORS.headgear || "#2244aa");
  const [socks, setSocks] = useState(gc.socks || DEFAULT_GEAR_COLORS.socks || "#f0f0f0");
  // Null means "not chosen": laces/soles/stripe keep following the shoe and
  // trunk colours until the player actually picks one.
  const [laces, setLaces] = useState<string | null>(gc.laces ?? null);
  const [soles, setSoles] = useState<string | null>(gc.soles ?? null);
  const [waistStripe, setWaistStripe] = useState<string | null>(gc.waistStripe ?? null);
  const lacesShown = laces ?? defaultLaceColor(shoes);
  const solesShown = soles ?? defaultSoleColor(shoes);
  const waistStripeShown = waistStripe ?? defaultWaistStripeColor(trunks);

  // Spacial Color: on offer from day one, whatever the player can afford, and
  // picked per gear piece once it has been bought.
  const savedParts = spacialSelectionOf(fighter);
  const [spacialParts, setSpacialParts] = useState<string[]>(
    savedParts === true ? [...SPACIAL_GEAR_KEYS] : (savedParts ? [...savedParts] : []),
  );
  const forceBalance = fighter.force ?? 0;
  // The finish is bought a piece at a time, so there is no single unlocked
  // state: a swatch shows the wear toggle once its own piece is paid for, and
  // the price tag until then.
  const ownedParts = spacialOwnedOf(fighter) as string[];
  const canAffordPart = forceBalance >= SPACIAL_PRICE_PER_GEAR_FORCE;
  const toggleSpacialPart = (key: string) =>
    setSpacialParts(prev => prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key]);
  // A purchase rewrites the record underneath this screen, so follow it.
  useEffect(() => {
    const bought = spacialSelectionOf(fighter);
    if (bought === true) setSpacialParts([...SPACIAL_GEAR_KEYS]);
    else if (Array.isArray(bought) && bought.length) setSpacialParts([...bought]);
  }, [fighter.spacialColors, fighter.spacialParts]);

  const previewColors: FighterColors = applySpacialGear({
    gloves, gloveTape, trunks, shoes, skin: skinColor, headgear, socks,
    laces: lacesShown, soles: solesShown, waistStripe: waistStripeShown,
  }, spacialParts);

  const swatchField = (label: string, value: string, onChange: (v: string) => void, testId: string, partKey?: string) => {
    const spacialOnPart = !!partKey && spacialParts.includes(partKey);
    const ownsPart = !!partKey && ownedParts.includes(partKey);
    return (
      <div className={`bg-black/40 border rounded-lg px-3 py-2 ${spacialOnPart ? "border-purple-500/60" : "border-white/10"}`}>
        <div className="flex items-center justify-between gap-2 mb-1">
          <label className="text-[10px] text-white/50 font-semibold uppercase tracking-widest">{label}</label>
          {partKey && ownsPart && (
            <button
              type="button"
              onClick={() => toggleSpacialPart(partKey)}
              title="Wear Spacial Color on this piece"
              className={`w-5 h-5 rounded border flex items-center justify-center shrink-0 ${spacialOnPart ? "bg-purple-600 border-purple-400 text-white" : "border-white/25 text-transparent hover:border-purple-400/60"}`}
              data-testid={`${testId}-spacial`}
            >
              <Check className="w-3.5 h-3.5" />
            </button>
          )}
          {partKey && !ownsPart && (
            <button
              type="button"
              onClick={() => onBuySpacialPart(partKey)}
              disabled={!canAffordPart}
              title={canAffordPart
                ? `Buy Spacial Color for this piece — ${SPACIAL_PRICE_PER_GEAR_FORCE.toLocaleString()} Force`
                : `Needs ${SPACIAL_PRICE_PER_GEAR_FORCE.toLocaleString()} Force`}
              className={`h-5 px-1.5 rounded border text-[9px] font-bold shrink-0 ${canAffordPart ? "border-purple-400/60 text-purple-200 hover:bg-purple-600/30" : "border-white/15 text-white/25 cursor-not-allowed"}`}
              data-testid={`${testId}-buy-spacial`}
            >
              ✦ {SPACIAL_PART_PRICE_LABEL}
            </button>
          )}
        </div>
        <div className="flex items-center gap-2">
          <input
            type="color"
            value={value}
            onChange={e => onChange(e.target.value)}
            disabled={spacialOnPart}
            title={spacialOnPart ? "Untick Spacial to change this colour" : undefined}
            className={`w-9 h-9 rounded-md bg-transparent ${spacialOnPart ? "opacity-40 pointer-events-none" : "cursor-pointer"}`}
            data-testid={testId}
          />
          <span className="text-xs text-white/60 font-mono">{spacialOnPart ? "Spacial" : value}</span>
        </div>
      </div>
    );
  };

  return (
    <div className="flex w-full h-screen overflow-hidden bg-[#0d0d0d]">
      <div className="flex flex-col gap-3 p-4 w-[52%] overflow-y-auto shrink-0">
        <div className="flex items-center gap-3 w-full">
          <Button variant="ghost" size="icon" onClick={() => onBack()} className="text-white/70 hover:text-white" data-testid="button-back-edit-colors">
            <ArrowLeft className="w-5 h-5" />
          </Button>
          <div className="flex-1">
            <h2 className="text-yellow-400 font-black italic uppercase text-xl leading-tight" style={{ textShadow: "1px 1px 0 rgba(0,0,0,0.7)" }}>Edit Colors</h2>
            <p className="text-white/50 text-[11px] font-mono">{fighter.name}</p>
          </div>
        </div>

        <div className="bg-[#1a1a1a] border border-white/15 rounded-lg p-4 space-y-3">
          <p className="text-[10px] text-white/40 font-semibold uppercase tracking-widest">Gear &amp; Skin</p>
          <div className="grid grid-cols-2 gap-3">
            <div className="bg-black/40 border border-white/10 rounded-lg px-3 py-2">
              <label className="text-[10px] text-white/50 font-semibold uppercase tracking-widest mb-1 block">Skin</label>
              <SkinColorField value={skinColor} onChange={setSkinColor} unlocked={isChampBeaten((fighter.careerRosterState as CareerRosterState | null)?.roster ?? []) || fighter.level >= 100} testId="color-hub-skin" />
            </div>
            {swatchField("Gloves", gloves, setGloves, "color-hub-gloves", "gloves")}
            {swatchField("Tape", gloveTape, setGloveTape, "color-hub-tape", "gloveTape")}
            {swatchField("Trunks", trunks, setTrunks, "color-hub-trunks", "trunks")}
            {swatchField("Shoes", shoes, setShoes, "color-hub-shoes", "shoes")}
            {swatchField("Socks", socks, setSocks, "color-hub-socks", "socks")}
            {swatchField("Headgear", headgear, setHeadgear, "color-hub-headgear", "headgear")}
            {swatchField("Laces", lacesShown, setLaces, "color-hub-laces", "laces")}
            {swatchField("Soles", solesShown, setSoles, "color-hub-soles", "soles")}
            {swatchField("Waist Stripe", waistStripeShown, setWaistStripe, "color-hub-waist-stripe", "waistStripe")}
          </div>
          <p className="text-[10px] text-white/35">Headgear is worn in sparring sessions. Laces, soles and the waist stripe follow your shoe and trunk colours until you pick your own.</p>
        </div>

        <div className="bg-[#120b1f] border border-purple-500/40 rounded-lg p-4 space-y-2" data-testid="panel-spacial-color">
          <div>
            <p className="text-[10px] text-purple-300/70 font-semibold uppercase tracking-widest">Spacial Color</p>
            <p className="text-[11px] text-white/50">Deep-space black with drifting purple stars.</p>
          </div>
          <p className="text-[11px] text-white/50">
            Bought one piece at a time — ⚡{SPACIAL_PRICE_PER_GEAR_FORCE.toLocaleString()} Force each.
            Hit <span className="text-purple-200 font-bold">✦</span> on a piece to buy it, then tick it to wear it.
          </p>
          <p className="text-[10px] text-white/40" data-testid="text-spacial-owned">
            {ownedParts.length} of {SPACIAL_GEAR_KEYS.length} pieces owned · you have ⚡{forceBalance.toLocaleString()} Force.
          </p>
        </div>

        <Button
          onClick={() => onSave(skinColor, {
            gloves, gloveTape, trunks, shoes, headgear, socks,
            laces: laces ?? undefined,
            soles: soles ?? undefined,
            waistStripe: waistStripe ?? undefined,
          }, spacialParts.filter(k => ownedParts.includes(k)))}
          className="w-full gap-2 bg-[#634b3b] hover:bg-[#7a5c4a] text-white font-bold"
          data-testid="button-save-colors"
        >
          <Check className="w-4 h-4" /> Save Colors
        </Button>
      </div>

      <div className="flex-1 flex items-center justify-center overflow-hidden p-4">
        <div className="bg-[#1a1a1a] border border-white/15 rounded-xl p-4 flex items-center justify-center">
          <FighterStanceCanvas colors={previewColors} width={320} height={560} scale={4} showHeadgear />
        </div>
      </div>
    </div>
  );
}


/**
 * Repaint the career hub ring.
 *
 * The palette is career property — it rides on the fighter save — and it is read
 * only by the hub background, so nothing chosen here changes how a bout looks.
 * Any slot may hold the Spacial sentinel instead of a hex once the ring finish
 * is bought; the renderer paints it, so it is stored raw and only resolved for
 * the HTML colour input, which cannot show the animation.
 */
function EditRingColors({ fighter, onSave, onBack, onBuyRingSpacial }: {
  fighter: Fighter;
  onSave: (colors: RingColors) => void;
  onBack: () => void;
  /** Pay the one-time Force price. Only called when the balance covers it. */
  onBuyRingSpacial: () => void;
}) {
  const [colors, setColors] = useState<Record<RingColorKey, string>>(() => ringColorsOf(fighter));
  // The purchase rewrites the record underneath this screen, so follow it rather
  // than saving a pre-purchase palette back over the top.
  useEffect(() => { setColors(ringColorsOf(fighter)); }, [fighter.ringColors, fighter.ringSpacialUnlocked]);

  const forceBalance = fighter.force ?? 0;
  const spacialUnlocked = !!fighter.ringSpacialUnlocked;
  const toggleSpacial = (key: RingColorKey) => setColors(prev => ({
    ...prev,
    [key]: isSpacial(prev[key]) ? DEFAULT_RING_COLORS[key] : SPACIAL_COLOR,
  }));

  return (
    <div className="flex w-full h-screen overflow-hidden bg-[#0d0d0d]">
      <div className="flex flex-col gap-3 p-4 w-[44%] overflow-y-auto shrink-0">
        <div className="flex items-center gap-3 w-full">
          <Button variant="ghost" size="icon" onClick={() => onBack()} className="text-white/70 hover:text-white" data-testid="button-back-ring-colors">
            <ArrowLeft className="w-5 h-5" />
          </Button>
          <div className="flex-1">
            <h2 className="text-yellow-400 font-black italic uppercase text-xl leading-tight" style={{ textShadow: "1px 1px 0 rgba(0,0,0,0.7)" }}>Ring Colors</h2>
            <p className="text-white/50 text-[11px] font-mono">{fighter.name}&apos;s gym ring</p>
          </div>
        </div>

        <div className="bg-[#1a1a1a] border border-white/15 rounded-lg p-4 space-y-3">
          <p className="text-[10px] text-white/40 font-semibold uppercase tracking-widest">Ring</p>
          <div className="grid grid-cols-2 gap-3">
            {RING_COLOR_KEYS.map(key => {
              const value = colors[key];
              const onSpacial = isSpacial(value);
              return (
                <div key={key} className={`bg-black/40 border rounded-lg px-3 py-2 ${onSpacial ? "border-purple-500/60" : "border-white/10"}`}>
                  <div className="flex items-center justify-between gap-2 mb-1">
                    <label className="text-[10px] text-white/50 font-semibold uppercase tracking-widest">{RING_COLOR_LABELS[key]}</label>
                    {spacialUnlocked && (
                      <button
                        type="button"
                        onClick={() => toggleSpacial(key)}
                        title="Wear Spacial Color on this part"
                        className={`w-5 h-5 rounded border flex items-center justify-center shrink-0 ${onSpacial ? "bg-purple-600 border-purple-400 text-white" : "border-white/25 text-transparent hover:border-purple-400/60"}`}
                        data-testid={`ring-color-${key}-spacial`}
                      >
                        <Check className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      type="color"
                      value={cssColorOf(value)}
                      onChange={e => setColors(prev => ({ ...prev, [key]: e.target.value }))}
                      disabled={onSpacial}
                      title={onSpacial ? "Untick Spacial to change this colour" : undefined}
                      className={`w-9 h-9 rounded-md bg-transparent ${onSpacial ? "opacity-40 pointer-events-none" : "cursor-pointer"}`}
                      data-testid={`ring-color-${key}`}
                    />
                    <span className="text-xs text-white/60 font-mono">{onSpacial ? "Spacial" : value}</span>
                  </div>
                </div>
              );
            })}
          </div>
          <p className="text-[10px] text-white/35">The apron follows the canvas colour. This dresses your gym ring — bouts still use the house ring.</p>
        </div>

        {!spacialUnlocked && (
          <div className="bg-[#120b1f] border border-purple-500/40 rounded-lg p-4 space-y-3" data-testid="panel-ring-spacial">
            <div>
              <p className="text-[10px] text-purple-300/70 font-semibold uppercase tracking-widest">Spacial Ring</p>
              <p className="text-[11px] text-white/50">Deep-space black with drifting purple stars, on the ring itself.</p>
            </div>
            <Button
              onClick={onBuyRingSpacial}
              disabled={forceBalance < RING_SPACIAL_PRICE_FORCE}
              className="w-full bg-purple-700 hover:bg-purple-600 disabled:opacity-40 text-white font-bold"
              data-testid="button-buy-ring-spacial"
            >
              Unlock for ⚡{RING_SPACIAL_PRICE_FORCE.toLocaleString()} Force
            </Button>
            <p className="text-[10px] text-white/40">You have ⚡{forceBalance.toLocaleString()} Force.</p>
          </div>
        )}

        <div className="grid grid-cols-2 gap-2">
          <Button variant="secondary" onClick={() => setColors({ ...DEFAULT_RING_COLORS })} className="text-xs" data-testid="button-reset-ring-colors">
            Reset to stock
          </Button>
          <Button onClick={() => onSave(colors)} className="gap-2 bg-[#634b3b] hover:bg-[#7a5c4a] text-white font-bold" data-testid="button-save-ring-colors">
            <Check className="w-4 h-4" /> Save
          </Button>
        </div>
      </div>

      <div className="flex-1 flex items-center justify-center overflow-hidden p-4">
        <div className="bg-[#1a1a1a] border border-white/15 rounded-xl p-3 w-full max-w-[640px]">
          <div className="relative w-full rounded-lg overflow-hidden" style={{ aspectRatio: "4 / 3" }}>
            <RingOnlyBackground colors={colors} />
          </div>
          <p className="text-[10px] text-white/35 mt-2 text-center">Live preview</p>
        </div>
      </div>
    </div>
  );
}

const REFINEMENT_SKILL_KEYS = [
  "jabPower", "hookPower", "uppercutPower", "bruiser", "koArtist",
  "ironChin", "slippery", "guardMaster", "duckRecovery", "punchRolling",
  "fastTwitch", "heartRefinement", "chinHitter", "technician", "lifeDrain",
  "pressureFighter", "precisionStriker",
] as const;

const REFINEMENT_SKILL_LABELS: Record<string, string> = {
  jabPower: "Straight Punch", hookPower: "Hook Power", uppercutPower: "Uppercut Power", bruiser: "Bruiser",
  koArtist: "KO Artist",
  ironChin: "Iron Chin", slippery: "Slippery", guardMaster: "Guard Master",
  duckRecovery: "Duck Recovery", punchRolling: "Punch Rolling", fastTwitch: "Fast Twitch",
  heartRefinement: "Heart", chinHitter: "Chin Hitter", technician: "Technician", lifeDrain: "Life Drain",
  pressureFighter: "Pressure Fighter", precisionStriker: "Precision Striker",
};

const BLANK_REF_SKILLS = () => Object.fromEntries(REFINEMENT_SKILL_KEYS.map(k => [k, 0])) as Record<string, number>;
const REF_SKILLS_CLIPBOARD_KEY = "handz_ref_skills_clipboard";

const SP_KEYS = ["power", "speed", "defense", "stamina", "focus"] as const;
const SP_LABELS: Record<string, string> = { power: "Power", speed: "Speed", defense: "Defense", stamina: "Stamina", focus: "Focus" };
const BLANK_SP = () => Object.fromEntries(SP_KEYS.map(k => [k, 0])) as Record<string, number>;
const SP_CLIPBOARD_KEY = "handz_sp_clipboard";
const SP_MAX = 200;

const CASCADE_PARAMS_KEY = "handz_cascade_params";
const SP_CASCADE_PARAMS_KEY = "handz_sp_cascade_params";
const CASCADE_CUSTOM_KEY = "handz_cascade_custom";
const SP_CASCADE_CUSTOM_KEY = "handz_sp_cascade_custom";
const CASCADE_PARAMS_USER_DEFAULT_KEY = "handz_cascade_params_user_default";
const SP_CASCADE_PARAMS_USER_DEFAULT_KEY = "handz_sp_cascade_params_user_default";
const DEFAULT_CASCADE_PARAMS_INIT = { reductionMin: 2, reductionMax: 6, boostedCountMin: 3, boostedCountMax: 12, boostMin: 1, boostMax: 5, finalReduction: 1 };
const DEFAULT_SP_CASCADE_PARAMS_INIT = { reductionMin: 2, reductionMax: 6, boostedCountMin: 2, boostedCountMax: 4, boostMin: 1, boostMax: 5, finalReduction: 1 };

export function RosterEditView({
  rosterState,
  fighterName,
  onSave,
  onAutosave,
  onBack,
  onRosterRegenerated,
}: {
  rosterState: CareerRosterState;
  fighterName?: string;
  onSave: (updatedRoster: RosterFighterState[]) => void;
  onAutosave: (updatedRoster: RosterFighterState[]) => void;
  onBack: () => void;
  /**
   * Called after a Roster Generation save rewrote the stored rosters. Returns
   * the regenerated roster for this save so the editor can adopt it instead of
   * holding (and later re-saving) the pre-edit numbers.
   */
  onRosterRegenerated?: () => RosterFighterState[] | null;
}) {
  const [editedRoster, setEditedRoster] = useState<RosterFighterState[]>(
    () => rosterState.roster.map(f => ({ ...f }))
  );
  const [search, setSearch] = useState("");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [showConfirm, setShowConfirm] = useState(false);
  const [showNeural, setShowNeural] = useState(false);

  const [editFirst, setEditFirst] = useState("");
  const [editNick, setEditNick] = useState("");
  const [editLast, setEditLast] = useState("");
  const [editSkin, setEditSkin] = useState("#e8c4a0");
  const [editSpacialParts, setEditSpacialParts] = useState<string[]>([]);
  const rosterSpacialFrom = (f: { customSpacial?: boolean; customSpacialParts?: string[] }): string[] =>
    f.customSpacialParts ? [...f.customSpacialParts] : (f.customSpacial ? [...SPACIAL_GEAR_KEYS] : []);
  const toggleEditSpacialPart = (key: string) =>
    setEditSpacialParts(prev => prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key]);
  const [editGloves, setEditGloves] = useState("#cc0000");
  const [editGloveTape, setEditGloveTape] = useState("#eeeeee");
  const [editTrunks, setEditTrunks] = useState("#ffffff");
  const [editShoes, setEditShoes] = useState("#333333");
  const [editSocks, setEditSocks] = useState("#f0f0f0");
  const [editLaces, setEditLaces] = useState<string | null>(null);
  const [editSoles, setEditSoles] = useState<string | null>(null);
  const [editWaistStripe, setEditWaistStripe] = useState<string | null>(null);
  const [editRefinementSkills, setEditRefinementSkills] = useState<Record<string, number>>(BLANK_REF_SKILLS);
  const [hasRefClipboard, setHasRefClipboard] = useState(() => {
    try { return !!localStorage.getItem(REF_SKILLS_CLIPBOARD_KEY); } catch { return false; }
  });
  const [editingNeuralId, setEditingNeuralId] = useState<number | null>(null);
  const [showRankingRef, setShowRankingRef] = useState(false);
  const [showCascadeConfirm, setShowCascadeConfirm] = useState(false);
  const [cascading, setCascading] = useState(false);
  const [showCascadeMakeDefaultConfirm, setShowCascadeMakeDefaultConfirm] = useState(false);
  const [showSPCascadeMakeDefaultConfirm, setShowSPCascadeMakeDefaultConfirm] = useState(false);
  const [customCascade, setCustomCascade] = useState(() => {
    try { return localStorage.getItem(CASCADE_CUSTOM_KEY) === "true"; } catch { return false; }
  });
  const [cascadeParams, setCascadeParams] = useState(() => {
    try { const raw = localStorage.getItem(CASCADE_PARAMS_KEY); return raw ? { ...DEFAULT_CASCADE_PARAMS_INIT, ...JSON.parse(raw) } : { ...DEFAULT_CASCADE_PARAMS_INIT }; } catch { return { ...DEFAULT_CASCADE_PARAMS_INIT }; }
  });

  const [editCustomSP, setEditCustomSP] = useState<Record<string, number>>(BLANK_SP);
  const [hasSPClipboard, setHasSPClipboard] = useState(() => {
    try { return !!localStorage.getItem(SP_CLIPBOARD_KEY); } catch { return false; }
  });
  const [showSPCascadeConfirm, setShowSPCascadeConfirm] = useState(false);
  const [customSPCascade, setCustomSPCascade] = useState(() => {
    try { return localStorage.getItem(SP_CASCADE_CUSTOM_KEY) === "true"; } catch { return false; }
  });
  const [spCascadeParams, setSpCascadeParams] = useState(() => {
    try { const raw = localStorage.getItem(SP_CASCADE_PARAMS_KEY); return raw ? { ...DEFAULT_SP_CASCADE_PARAMS_INIT, ...JSON.parse(raw) } : { ...DEFAULT_SP_CASCADE_PARAMS_INIT }; } catch { return { ...DEFAULT_SP_CASCADE_PARAMS_INIT }; }
  });


  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const savedScrollPos = useRef(0);

  useEffect(() => {
    if (editingId === null && scrollContainerRef.current) {
      scrollContainerRef.current.scrollTop = savedScrollPos.current;
    }
  }, [editingId]);

  useEffect(() => {
    try { localStorage.setItem(CASCADE_PARAMS_KEY, JSON.stringify(cascadeParams)); } catch {}
  }, [cascadeParams]);
  useEffect(() => {
    try { localStorage.setItem(SP_CASCADE_PARAMS_KEY, JSON.stringify(spCascadeParams)); } catch {}
  }, [spCascadeParams]);
  useEffect(() => {
    try { localStorage.setItem(CASCADE_CUSTOM_KEY, String(customCascade)); } catch {}
  }, [customCascade]);
  useEffect(() => {
    try { localStorage.setItem(SP_CASCADE_CUSTOM_KEY, String(customSPCascade)); } catch {}
  }, [customSPCascade]);

  const defaultRefForRank = (rank: number) => Math.round(100 * (204 - rank) / 203);

  const [rankingRefValues, setRankingRefValues] = useState<Record<number, number>>(() => {
    try {
      const raw = localStorage.getItem("handz_ranking_ref_defaults");
      if (raw) return JSON.parse(raw);
    } catch {}
    const defaults: Record<number, number> = {};
    for (let r = 1; r <= 204; r++) defaults[r] = defaultRefForRank(r);
    return defaults;
  });

  const saveRankingRefDefaults = (vals: Record<number, number>) => {
    try { localStorage.setItem("handz_ranking_ref_defaults", JSON.stringify(vals)); } catch {}
  };

  const rosterFileRef = useRef<HTMLInputElement>(null);

  const downloadRoster = () => {
    const label = fighterName || "career";
    const rosterExport = {
      exportedAt: new Date().toISOString(),
      fighterName: label,
      weekNumber: rosterState.weekNumber,
      playerRank: rosterState.playerRank,
      playerRatingScore: rosterState.playerRatingScore,
      roster: editedRoster.filter(r => r.active && !r.retired).sort((a, b) => a.rank - b.rank).map(r => {
        const entry = getRosterEntryById(r.id);
        return {
          rank: r.rank,
          id: r.id,
          name: entry ? getRosterDisplayName(entry, r) : `Fighter #${r.id}`,
          level: r.level,
          record: `${r.wins}W-${r.losses}L-${r.draws}D`,
          knockouts: r.knockouts,
          ratingScore: Math.round(r.ratingScore || 0),
          totalFights: r.totalFights,
          beatenByPlayer: r.beatenByPlayer,
          statPower: r.statPower,
          statSpeed: r.statSpeed,
          statDefense: r.statDefense,
          statStamina: r.statStamina,
          statFocus: r.statFocus,
          overallRating: r.overallRating,
        };
      }),
    };
    const json = JSON.stringify(rosterExport, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `handz_roster_${label.replace(/[^a-zA-Z0-9]/g, "_")}_week${rosterState.weekNumber}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const [importError, setRosterImportError] = useState<string | null>(null);

  const importRoster = (file: File) => {
    setRosterImportError(null);
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const data = JSON.parse(ev.target?.result as string);
        if (!data || !Array.isArray(data.roster)) {
          throw new Error("Invalid roster file format");
        }
        const importedRoster = editedRoster.map(f => ({ ...f }));
        for (const imported of data.roster) {
          const idx = importedRoster.findIndex(r => r.id === imported.id);
          if (idx >= 0) {
            if (imported.customFirstName !== undefined) importedRoster[idx].customFirstName = imported.customFirstName;
            if (imported.customNickname !== undefined) importedRoster[idx].customNickname = imported.customNickname;
            if (imported.customLastName !== undefined) importedRoster[idx].customLastName = imported.customLastName;
            if (imported.customGloves !== undefined) importedRoster[idx].customGloves = imported.customGloves;
            if (imported.customGloveTape !== undefined) importedRoster[idx].customGloveTape = imported.customGloveTape;
            if (imported.customTrunks !== undefined) importedRoster[idx].customTrunks = imported.customTrunks;
            if (imported.customShoes !== undefined) importedRoster[idx].customShoes = imported.customShoes;
            if (imported.customSocks !== undefined) importedRoster[idx].customSocks = imported.customSocks;
            if (imported.customLaces !== undefined) importedRoster[idx].customLaces = imported.customLaces;
            if (imported.customSoles !== undefined) importedRoster[idx].customSoles = imported.customSoles;
            if (imported.customWaistStripe !== undefined) importedRoster[idx].customWaistStripe = imported.customWaistStripe;
            if (imported.customSpacial !== undefined) importedRoster[idx].customSpacial = imported.customSpacial;
            if (imported.customSpacialParts !== undefined) importedRoster[idx].customSpacialParts = imported.customSpacialParts;
            if (imported.customSkinColor !== undefined) importedRoster[idx].customSkinColor = imported.customSkinColor;
          }
        }
        setEditedRoster(importedRoster);
      } catch (err: any) {
        setRosterImportError(err.message || "Failed to import roster");
      }
    };
    reader.readAsText(file);
  };

  const handleRosterFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) importRoster(file);
    if (rosterFileRef.current) rosterFileRef.current.value = "";
  };

  const activeFighters = editedRoster
    .filter(f => f.active && !f.retired)
    .sort((a, b) => a.rank - b.rank);

  const filtered = search.trim()
    ? activeFighters.filter(f => {
        const entry = getRosterEntryById(f.id);
        if (!entry) return false;
        const name = getRosterDisplayName(entry, f).toLowerCase();
        return name.includes(search.toLowerCase());
      })
    : activeFighters;

  const copyRefinementSkills = () => {
    try {
      localStorage.setItem(REF_SKILLS_CLIPBOARD_KEY, JSON.stringify(editRefinementSkills));
      setHasRefClipboard(true);
    } catch {}
  };

  const pasteRefinementSkills = () => {
    try {
      const raw = localStorage.getItem(REF_SKILLS_CLIPBOARD_KEY);
      if (raw) setEditRefinementSkills({ ...BLANK_REF_SKILLS(), ...JSON.parse(raw) });
    } catch {}
  };

  const copySP = () => {
    try {
      localStorage.setItem(SP_CLIPBOARD_KEY, JSON.stringify(editCustomSP));
      setHasSPClipboard(true);
    } catch {}
  };

  const pasteSP = () => {
    try {
      const raw = localStorage.getItem(SP_CLIPBOARD_KEY);
      if (raw) setEditCustomSP({ ...BLANK_SP(), ...JSON.parse(raw) });
    } catch {}
  };

  const startEdit = (f: RosterFighterState) => {
    const entry = getRosterEntryById(f.id);
    if (!entry) return;
    savedScrollPos.current = scrollContainerRef.current?.scrollTop ?? 0;
    const colors = getRosterFighterColors(f);
    setEditingId(f.id);
    setEditFirst(f.customFirstName ?? entry.firstName);
    setEditNick(f.customNickname ?? entry.nickname);
    setEditLast(f.customLastName ?? entry.lastName);
    setEditSkin(f.customSkinColor ?? colors.skin);
    setEditGloves(f.customGloves ?? colors.gloves);
    setEditGloveTape(f.customGloveTape ?? f.genGloveTape ?? "#eeeeee");
    setEditTrunks(f.customTrunks ?? colors.trunks);
    setEditShoes(f.customShoes ?? colors.shoes);
    setEditSocks(f.customSocks ?? colors.socks);
    setEditLaces(f.customLaces ?? null);
    setEditSoles(f.customSoles ?? null);
    setEditWaistStripe(f.customWaistStripe ?? null);
    setEditSpacialParts(rosterSpacialFrom(f));
    setEditRefinementSkills(f.customRefinementSkills
      ? { ...BLANK_REF_SKILLS(), ...f.customRefinementSkills }
      : BLANK_REF_SKILLS()
    );
    setEditCustomSP(f.customSkillPoints
      ? { ...BLANK_SP(), ...f.customSkillPoints }
      : BLANK_SP()
    );
  };

  const DEFAULT_CASCADE_PARAMS = (() => {
    try {
      const raw = localStorage.getItem(CASCADE_PARAMS_USER_DEFAULT_KEY);
      return raw ? { ...DEFAULT_CASCADE_PARAMS_INIT, ...JSON.parse(raw) } : { ...DEFAULT_CASCADE_PARAMS_INIT };
    } catch { return { ...DEFAULT_CASCADE_PARAMS_INIT }; }
  })();

  const cascadeStep = (prev: Record<string, number>, p = DEFAULT_CASCADE_PARAMS): Record<string, number> => {
    const result: Record<string, number> = {};
    const reductionRange = Math.max(0, p.reductionMax - p.reductionMin);
    for (const key of REFINEMENT_SKILL_KEYS) {
      const reduction = p.reductionMin + Math.floor(Math.random() * (reductionRange + 1));
      result[key] = Math.max(0, (prev[key] ?? 0) - reduction);
    }
    const countRange = Math.max(0, p.boostedCountMax - p.boostedCountMin);
    const numBoosted = p.boostedCountMin + Math.floor(Math.random() * (countRange + 1));
    const shuffled = ([...REFINEMENT_SKILL_KEYS] as string[]).sort(() => Math.random() - 0.5);
    const boostRange = Math.max(0, p.boostMax - p.boostMin);
    for (let i = 0; i < Math.min(numBoosted, shuffled.length); i++) {
      const boost = p.boostMin + Math.floor(Math.random() * (boostRange + 1));
      result[shuffled[i]] = (result[shuffled[i]] ?? 0) + boost;
    }
    for (const key of REFINEMENT_SKILL_KEYS) {
      result[key] = Math.max(0, (result[key] ?? 0) - p.finalReduction);
    }
    // Correct any skill that ended up above 100
    for (const key of REFINEMENT_SKILL_KEYS) {
      if (result[key] > 100) result[key] = 100;
    }
    return result;
  };

  const runCascade = () => {
    if (editingId === null) return;
    const params = customCascade ? cascadeParams : DEFAULT_CASCADE_PARAMS;
    setShowCascadeConfirm(false);
    setCascading(true);
    setTimeout(() => {
      const currentFighter = editedRoster.find(f => f.id === editingId);
      if (!currentFighter) { setCascading(false); return; }
      const currentRank = currentFighter.rank;
      const below = editedRoster
        .filter(f => f.active && !f.retired && f.rank > currentRank)
        .sort((a, b) => a.rank - b.rank);
      let prevSkills: Record<string, number> = { ...editRefinementSkills };
      const updates = new Map<number, Record<string, number>>();
      for (const f of below) {
        const newSkills = cascadeStep(prevSkills, params);
        updates.set(f.id, newSkills);
        prevSkills = newSkills;
      }
      const newRoster = editedRoster.map(f => {
        if (!updates.has(f.id)) return f;
        const skills = updates.get(f.id)!;
        const allZero = REFINEMENT_SKILL_KEYS.every(k => (skills[k] ?? 0) === 0);
        return { ...f, customRefinementSkills: allZero ? undefined : skills };
      });
      setEditedRoster(newRoster);
      saveRosterCustomizations(newRoster);
      onAutosave(newRoster);
      setCascading(false);
    }, 50);
  };

  const DEFAULT_SP_CASCADE_PARAMS = (() => {
    try {
      const raw = localStorage.getItem(SP_CASCADE_PARAMS_USER_DEFAULT_KEY);
      return raw ? { ...DEFAULT_SP_CASCADE_PARAMS_INIT, ...JSON.parse(raw) } : { ...DEFAULT_SP_CASCADE_PARAMS_INIT };
    } catch { return { ...DEFAULT_SP_CASCADE_PARAMS_INIT }; }
  })();

  const cascadeStepSP = (prev: Record<string, number>, p = DEFAULT_SP_CASCADE_PARAMS): Record<string, number> => {
    const result: Record<string, number> = {};
    const reductionRange = Math.max(0, p.reductionMax - p.reductionMin);
    for (const key of SP_KEYS) {
      const reduction = p.reductionMin + Math.floor(Math.random() * (reductionRange + 1));
      result[key] = Math.max(0, (prev[key] ?? 0) - reduction);
    }
    const countRange = Math.max(0, p.boostedCountMax - p.boostedCountMin);
    const numBoosted = p.boostedCountMin + Math.floor(Math.random() * (countRange + 1));
    const shuffled = ([...SP_KEYS] as string[]).sort(() => Math.random() - 0.5);
    const boostRange = Math.max(0, p.boostMax - p.boostMin);
    for (let i = 0; i < Math.min(numBoosted, shuffled.length); i++) {
      const boost = p.boostMin + Math.floor(Math.random() * (boostRange + 1));
      result[shuffled[i]] = (result[shuffled[i]] ?? 0) + boost;
    }
    for (const key of SP_KEYS) {
      result[key] = Math.max(0, (result[key] ?? 0) - p.finalReduction);
    }
    for (const key of SP_KEYS) {
      if (result[key] > SP_MAX) result[key] = SP_MAX;
    }
    return result;
  };

  const runSPCascade = () => {
    if (editingId === null) return;
    const params = customSPCascade ? spCascadeParams : DEFAULT_SP_CASCADE_PARAMS;
    setShowSPCascadeConfirm(false);
    setCascading(true);
    setTimeout(() => {
      const currentFighter = editedRoster.find(f => f.id === editingId);
      if (!currentFighter) { setCascading(false); return; }
      const currentRank = currentFighter.rank;
      const below = editedRoster
        .filter(f => f.active && !f.retired && f.rank > currentRank)
        .sort((a, b) => a.rank - b.rank);
      let prevSP: Record<string, number> = { ...editCustomSP };
      const updates = new Map<number, Record<string, number>>();
      for (const f of below) {
        const newSP = cascadeStepSP(prevSP, params);
        updates.set(f.id, newSP);
        prevSP = newSP;
      }
      const newRoster = editedRoster.map(f => {
        if (!updates.has(f.id)) return f;
        const sp = updates.get(f.id)!;
        const allZero = SP_KEYS.every(k => (sp[k] ?? 0) === 0);
        return { ...f, customSkillPoints: allZero ? undefined : (sp as { power: number; speed: number; defense: number; stamina: number; focus: number }) };
      });
      setEditedRoster(newRoster);
      saveRosterCustomizations(newRoster);
      onAutosave(newRoster);
      setCascading(false);
    }, 50);
  };

  const rosterColorField = (
    label: string,
    value: string,
    onChange: (v: string) => void,
    testId: string,
    partKey: string,
  ) => {
    const spacialOn = editSpacialParts.includes(partKey);
    return (
      <div>
        <div className="flex items-center justify-between gap-2 mb-1">
          <label className="text-xs text-muted-foreground">{label}</label>
          <button
            type="button"
            onClick={() => toggleEditSpacialPart(partKey)}
            title="Wear Spacial Color on this piece"
            className={`w-5 h-5 rounded border flex items-center justify-center shrink-0 ${spacialOn ? "bg-purple-600 border-purple-400 text-white" : "border-border text-transparent hover:border-purple-400/60"}`}
            data-testid={`${testId}-spacial`}
          >
            <Check className="w-3.5 h-3.5" />
          </button>
        </div>
        <div className="flex items-center gap-2">
          <input
            type="color"
            value={value}
            onChange={e => onChange(e.target.value)}
            disabled={spacialOn}
            title={spacialOn ? "Untick Spacial to change this colour" : undefined}
            className={`w-8 h-8 rounded ${spacialOn ? "opacity-40 pointer-events-none" : "cursor-pointer"}`}
            data-testid={testId}
          />
          <span className="text-xs text-muted-foreground">{spacialOn ? "Spacial" : value}</span>
        </div>
      </div>
    );
  };

  const buildEditedFighter = (f: RosterFighterState) => {
    const allZero = REFINEMENT_SKILL_KEYS.every(k => (editRefinementSkills[k] ?? 0) === 0);
    const allSPZero = SP_KEYS.every(k => (editCustomSP[k] ?? 0) === 0);
    return {
      ...f,
      customFirstName: editFirst.trim() || undefined,
      customNickname: editNick.trim() || undefined,
      customLastName: editLast.trim() || undefined,
      customSkinColor: editSkin,
      customGloves: editGloves,
      customGloveTape: editGloveTape,
      customTrunks: editTrunks,
      customShoes: editShoes,
      customSocks: editSocks,
      customLaces: editLaces ?? undefined,
      customSoles: editSoles ?? undefined,
      customWaistStripe: editWaistStripe ?? undefined,
      customSpacial: undefined,
      customSpacialParts: editSpacialParts.length ? [...editSpacialParts] : undefined,
      customRefinementSkills: allZero ? undefined : { ...editRefinementSkills },
      customSkillPoints: allSPZero ? undefined : (editCustomSP as { power: number; speed: number; defense: number; stamina: number; focus: number }),
    };
  };

  const applyEdit = () => {
    if (editingId === null) return;
    setEditedRoster(prev => prev.map(f => f.id !== editingId ? f : buildEditedFighter(f)));
    setEditingId(null);
  };

  const navigateTo = (target: RosterFighterState) => {
    if (editingId !== null) {
      setEditedRoster(prev => prev.map(f => f.id !== editingId ? f : buildEditedFighter(f)));
    }
    const entry = getRosterEntryById(target.id);
    if (!entry) return;
    const colors = getRosterFighterColors(target);
    setEditingId(target.id);
    setEditFirst(target.customFirstName ?? entry.firstName);
    setEditNick(target.customNickname ?? entry.nickname);
    setEditLast(target.customLastName ?? entry.lastName);
    setEditSkin(target.customSkinColor ?? colors.skin);
    setEditGloves(target.customGloves ?? colors.gloves);
    setEditGloveTape(target.customGloveTape ?? target.genGloveTape ?? "#eeeeee");
    setEditTrunks(target.customTrunks ?? colors.trunks);
    setEditShoes(target.customShoes ?? colors.shoes);
    setEditSocks(target.customSocks ?? colors.socks);
    setEditLaces(target.customLaces ?? null);
    setEditSoles(target.customSoles ?? null);
    setEditWaistStripe(target.customWaistStripe ?? null);
    setEditSpacialParts(rosterSpacialFrom(target));
    setEditRefinementSkills(target.customRefinementSkills
      ? { ...BLANK_REF_SKILLS(), ...target.customRefinementSkills }
      : BLANK_REF_SKILLS()
    );
    setEditCustomSP(target.customSkillPoints
      ? { ...BLANK_SP(), ...target.customSkillPoints }
      : BLANK_SP()
    );
    setShowCascadeConfirm(false);
    setShowSPCascadeConfirm(false);
  };

  const handleSave = () => {
    setShowConfirm(true);
  };

  const confirmSave = () => {
    saveRosterCustomizations(editedRoster);
    saveRankEdits(editedRoster);
    onSave(applyRankEditsToRoster(editedRoster));
  };

  if (editingNeuralId !== null) {
    const nEntry = getRosterEntryById(editingNeuralId);
    const nFighter = editedRoster.find(r => r.id === editingNeuralId);
    const nName = nEntry && nFighter ? getRosterDisplayName(nEntry, nFighter) : `Fighter ${editingNeuralId}`;
    return <NeuralNetworkView onBack={() => setEditingNeuralId(null)} fighterId={editingNeuralId} fighterName={nName} />;
  }

  if (showNeural) {
    return (
      <NeuralNetworkView
        onBack={() => setShowNeural(false)}
        onRosterRegenerated={() => {
          const fresh = onRosterRegenerated?.();
          if (fresh) setEditedRoster(fresh.map(f => ({ ...f })));
        }}
      />
    );
  }

  if (showRankingRef) {
    const BANDS = [
      { label: "Rank 1–10",    from: 1,   to: 10  },
      { label: "Rank 11–25",   from: 11,  to: 25  },
      { label: "Rank 26–50",   from: 26,  to: 50  },
      { label: "Rank 51–100",  from: 51,  to: 100 },
      { label: "Rank 101–150", from: 101, to: 150 },
      { label: "Rank 151–204", from: 151, to: 204 },
    ];
    const bandValue = (from: number, to: number) => {
      const vals = [];
      for (let r = from; r <= to; r++) vals.push(rankingRefValues[r] ?? defaultRefForRank(r));
      const avg = Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
      return avg;
    };
    const setBand = (from: number, to: number, val: number) => {
      const next = { ...rankingRefValues };
      for (let r = from; r <= to; r++) next[r] = val;
      setRankingRefValues(next);
    };
    return (
      <div className="flex flex-col items-center gap-3 p-4 max-w-xl mx-auto">
        <div className="flex items-center gap-2 w-full">
          <Button variant="ghost" size="icon" onClick={() => setShowRankingRef(false)} data-testid="button-back-ranking-ref">
            <ArrowLeft className="w-5 h-5" />
          </Button>
          <h2 className="text-lg font-bold flex-1">Ranking Refinement Stats</h2>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              const defaults: Record<number, number> = {};
              for (let r = 1; r <= 204; r++) defaults[r] = defaultRefForRank(r);
              setRankingRefValues(defaults);
            }}
            className="text-xs gap-1"
            data-testid="button-reset-ranking-ref"
          >
            Reset
          </Button>
          <Button
            size="sm"
            onClick={() => { saveRankingRefDefaults(rankingRefValues); setShowRankingRef(false); }}
            className="gap-1"
            data-testid="button-save-ranking-ref"
          >
            <Save className="w-3.5 h-3.5" /> Save
          </Button>
        </div>

        <Card className="p-3 w-full space-y-2">
          <p className="text-xs text-muted-foreground leading-relaxed">
            Set how many <strong>refinement points</strong> NPC fighters start with based on their ranking. Higher = stronger fighter. Points grow by 0–2 each simulated week (max 400). Effects apply automatically in career fights.
          </p>
          <p className="text-xs text-muted-foreground">Range: 0–400 &bull; Default: linear (rank 1 = 100, rank 204 = 0)</p>
        </Card>

        <Card className="p-3 w-full space-y-3">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Quick Set by Band</p>
          {BANDS.map(({ label, from, to }) => (
            <div key={label} className="flex items-center gap-3">
              <span className="text-xs w-32 text-muted-foreground">{label}</span>
              <input
                type="range"
                min={0}
                max={400}
                step={5}
                value={bandValue(from, to)}
                onChange={e => setBand(from, to, Number(e.target.value))}
                className="flex-1 accent-primary"
                data-testid={`slider-band-${from}`}
              />
              <input
                type="number"
                min={0}
                max={400}
                value={bandValue(from, to)}
                onChange={e => setBand(from, to, Math.max(0, Math.min(400, Number(e.target.value))))}
                className="w-16 text-xs border rounded px-2 py-1 bg-background text-center"
                data-testid={`input-band-${from}`}
              />
            </div>
          ))}
        </Card>

        <Card className="p-3 w-full">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">Individual Ranks</p>
          <div className="max-h-[45vh] overflow-y-auto space-y-0.5 pr-1">
            {Array.from({ length: 204 }, (_, i) => i + 1).map(rank => {
              const val = rankingRefValues[rank] ?? defaultRefForRank(rank);
              return (
                <div key={rank} className="flex items-center gap-2 py-0.5">
                  <span className="text-[11px] text-muted-foreground w-10 text-right">#{rank}</span>
                  <input
                    type="range"
                    min={0}
                    max={400}
                    step={1}
                    value={val}
                    onChange={e => setRankingRefValues(prev => ({ ...prev, [rank]: Number(e.target.value) }))}
                    className="flex-1 accent-primary h-1"
                    data-testid={`slider-rank-${rank}`}
                  />
                  <input
                    type="number"
                    min={0}
                    max={400}
                    value={val}
                    onChange={e => setRankingRefValues(prev => ({ ...prev, [rank]: Math.max(0, Math.min(400, Number(e.target.value))) }))}
                    className="w-14 text-[11px] border rounded px-1.5 py-0.5 bg-background text-center"
                    data-testid={`input-rank-${rank}`}
                  />
                </div>
              );
            })}
          </div>
        </Card>
      </div>
    );
  }

  if (showConfirm) {
    return (
      <div className="flex flex-col items-center gap-4 p-4 max-w-lg mx-auto">
        <Card className="p-6 w-full text-center space-y-4">
          <Check className="w-10 h-10 mx-auto text-primary" />
          <h3 className="text-lg font-bold">Save Roster Changes?</h3>
          <p className="text-sm text-muted-foreground">This will update all fighter names and colors you've edited.</p>
          <div className="flex gap-3 justify-center">
            <Button variant="secondary" onClick={() => setShowConfirm(false)} data-testid="button-cancel-save">
              Cancel
            </Button>
            <Button onClick={confirmSave} data-testid="button-confirm-save">
              <Save className="w-4 h-4 mr-2" /> Save
            </Button>
          </div>
        </Card>
      </div>
    );
  }

  if (editingId !== null) {
    const entry = getRosterEntryById(editingId);
    const f = editedRoster.find(r => r.id === editingId);
    if (!entry || !f) return null;

    // Mirrors the pickers exactly, so the preview updates as they change.
    const previewColors: FighterColors = applySpacialGear({
      skin: editSkin,
      gloves: editGloves,
      gloveTape: editGloveTape,
      trunks: editTrunks,
      shoes: editShoes,
      socks: editSocks,
      laces: editLaces ?? defaultLaceColor(editShoes),
      soles: editSoles ?? defaultSoleColor(editShoes),
      waistStripe: editWaistStripe ?? defaultWaistStripeColor(editTrunks),
    }, editSpacialParts);

    const currentIndex = filtered.findIndex(fi => fi.id === editingId);
    const prevFighter = currentIndex > 0 ? filtered[currentIndex - 1] : null;
    const nextFighter = currentIndex < filtered.length - 1 ? filtered[currentIndex + 1] : null;

    return (
      <div className="flex flex-col items-center gap-3 p-4 max-w-2xl mx-auto">
        {cascading && (
          <div className="fixed inset-0 bg-black/75 flex flex-col items-center justify-center z-50" data-testid="overlay-cascading">
            <Zap className="w-10 h-10 text-yellow-400 animate-pulse mb-3" />
            <p className="text-white text-lg font-bold">Cascading Refinements…</p>
            <p className="text-white/60 text-sm mt-1">Saving roster</p>
          </div>
        )}
        <div className="flex items-center gap-2 w-full">
          <Button variant="ghost" size="icon" onClick={() => setEditingId(null)} data-testid="button-back-edit-fighter">
            <ArrowLeft className="w-5 h-5" />
          </Button>
          <h2 className="text-xl font-bold flex-1">Edit Fighter</h2>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => prevFighter && navigateTo(prevFighter)}
            disabled={!prevFighter}
            data-testid="button-prev-fighter"
          >
            <ChevronLeft className="w-5 h-5" />
          </Button>
          {currentIndex >= 0 && (
            <span className="text-xs text-muted-foreground tabular-nums w-12 text-center">
              {currentIndex + 1}/{filtered.length}
            </span>
          )}
          <Button
            variant="ghost"
            size="icon"
            onClick={() => nextFighter && navigateTo(nextFighter)}
            disabled={!nextFighter}
            data-testid="button-next-fighter"
          >
            <ChevronRight className="w-5 h-5" />
          </Button>
        </div>
        <Card className="p-4 w-full space-y-3">
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">First Name</label>
            <Input
              value={editFirst}
              onChange={e => setEditFirst(e.target.value)}
              placeholder={entry.firstName}
              data-testid="input-edit-first"
            />
          </div>
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">Nickname</label>
            <Input
              value={editNick}
              onChange={e => setEditNick(e.target.value)}
              placeholder={entry.nickname || "None"}
              data-testid="input-edit-nick"
            />
          </div>
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">Last Name</label>
            <Input
              value={editLast}
              onChange={e => setEditLast(e.target.value)}
              placeholder={entry.lastName}
              data-testid="input-edit-last"
            />
          </div>
        </Card>
        <Card className="p-4 w-full space-y-3">
          <p className="text-sm font-semibold">Boxing Stance</p>
          <div className="grid grid-cols-2 gap-2">
            <Button
              variant={(editedRoster.find(f => f.id === editingId)?.boxingStance ?? "orthodox") === "orthodox" ? "default" : "secondary"}
              onClick={() => setEditedRoster(prev => prev.map(f => f.id !== editingId ? f : { ...f, boxingStance: "orthodox" }))}
              className="text-xs"
              data-testid="button-edit-stance-orthodox"
            >
              Orthodox
            </Button>
            <Button
              variant={(editedRoster.find(f => f.id === editingId)?.boxingStance ?? "orthodox") === "southpaw" ? "default" : "secondary"}
              onClick={() => setEditedRoster(prev => prev.map(f => f.id !== editingId ? f : { ...f, boxingStance: "southpaw" }))}
              className="text-xs"
              data-testid="button-edit-stance-southpaw"
            >
              Southpaw
            </Button>
          </div>
        </Card>
        <Card className="p-4 w-full space-y-3">
          <p className="text-sm font-semibold">Colors</p>
          <div className="flex gap-4 items-start">
          <div className="grid grid-cols-2 gap-3 flex-1 min-w-0">
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Skin</label>
              <div className="flex items-center gap-2">
                <input type="color" value={editSkin} onChange={e => setEditSkin(e.target.value)} className="w-8 h-8 rounded cursor-pointer" data-testid="color-edit-skin" />
                <span className="text-xs text-muted-foreground">{editSkin}</span>
              </div>
            </div>
            {rosterColorField("Gloves", editGloves, setEditGloves, "color-edit-gloves", "gloves")}
            {rosterColorField("Tape", editGloveTape, setEditGloveTape, "color-edit-tape", "gloveTape")}
            {rosterColorField("Trunks", editTrunks, setEditTrunks, "color-edit-trunks", "trunks")}
            {rosterColorField("Shoes", editShoes, setEditShoes, "color-edit-shoes", "shoes")}
            {rosterColorField("Socks", editSocks, setEditSocks, "color-edit-socks", "socks")}
            {rosterColorField("Laces", editLaces ?? defaultLaceColor(editShoes), setEditLaces, "color-edit-laces", "laces")}
            {rosterColorField("Soles", editSoles ?? defaultSoleColor(editShoes), setEditSoles, "color-edit-soles", "soles")}
            {rosterColorField("Waist Stripe", editWaistStripe ?? defaultWaistStripeColor(editTrunks), setEditWaistStripe, "color-edit-waist-stripe", "waistStripe")}
          </div>
          <div className="shrink-0 bg-black/30 border border-border rounded-lg p-2 flex items-center justify-center" data-testid="preview-edit-fighter">
            <FighterStanceCanvas colors={previewColors} width={180} height={280} scale={2} />
          </div>
          </div>
          <p className="text-[10px] text-muted-foreground border-t border-border pt-3">
            Tick a gear piece to paint it deep-space black with drifting stars. The piece's own colour stays saved underneath and comes back when you untick it.
          </p>
        </Card>
        <Card className="p-4 w-full space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-sm font-semibold">Stat Points</p>
            <div className="flex gap-1.5">
              <Button variant="outline" size="sm" onClick={copySP} className="text-xs gap-1 h-7 px-2" data-testid="button-copy-sp">
                <Copy className="w-3 h-3" /> Copy
              </Button>
              <Button variant="outline" size="sm" onClick={pasteSP} disabled={!hasSPClipboard} className="text-xs gap-1 h-7 px-2" data-testid="button-paste-sp">
                <ClipboardPaste className="w-3 h-3" /> Paste
              </Button>
              <Button variant="outline" size="sm" onClick={() => setShowSPCascadeConfirm(v => !v)} className="text-xs gap-1 h-7 px-2" data-testid="button-sp-cascade">
                <Zap className="w-3 h-3" /> Cascade
              </Button>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">Override this rank spot's stat points (0–{SP_MAX}). NPC fights use these instead of the auto-calculated weekly stats.</p>
          {showSPCascadeConfirm && (
            <Card className="p-3 border-orange-500/40 bg-card space-y-3">
              <div className="flex items-center justify-between">
                <p className="text-sm font-semibold">Cascade Stat Points Down?</p>
                <Button
                  variant={customSPCascade ? "default" : "outline"}
                  size="sm"
                  onClick={() => setCustomSPCascade(v => !v)}
                  className="text-xs h-6 px-2"
                  data-testid="button-sp-cascade-custom-toggle"
                >
                  {customSPCascade ? "Custom" : "Default"}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Every fighter ranked below will receive progressively weaker stat points. Roster auto-saved on confirm.
              </p>
              {customSPCascade && (
                <div className="space-y-2 border border-border rounded-md p-2">
                  <p className="text-[10px] uppercase text-muted-foreground font-semibold tracking-wide">Cascade Rules</p>
                  {([
                    { label: "Step reduction", minKey: "reductionMin" as const, maxKey: "reductionMax" as const, hint: "Each stat drops by this range per step" },
                    { label: "Stats boosted", minKey: "boostedCountMin" as const, maxKey: "boostedCountMax" as const, hint: "How many random stats get a boost" },
                    { label: "Boost amount", minKey: "boostMin" as const, maxKey: "boostMax" as const, hint: "Points added to each boosted stat" },
                  ]).map(row => (
                    <div key={row.label} className="space-y-0.5">
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-muted-foreground w-24 shrink-0">{row.label}</span>
                        <span className="text-[10px] text-muted-foreground">min</span>
                        <input
                          type="number" min={0} max={200}
                          value={spCascadeParams[row.minKey]}
                          onChange={e => setSpCascadeParams(p => ({ ...p, [row.minKey]: Math.max(0, Number(e.target.value)) }))}
                          className="w-12 text-xs border rounded px-1 py-0.5 bg-background text-center"
                          data-testid={`input-sp-cascade-${row.minKey}`}
                        />
                        <span className="text-[10px] text-muted-foreground">max</span>
                        <input
                          type="number" min={0} max={200}
                          value={spCascadeParams[row.maxKey]}
                          onChange={e => setSpCascadeParams(p => ({ ...p, [row.maxKey]: Math.max(0, Number(e.target.value)) }))}
                          className="w-12 text-xs border rounded px-1 py-0.5 bg-background text-center"
                          data-testid={`input-sp-cascade-${row.maxKey}`}
                        />
                      </div>
                      <p className="text-[10px] text-muted-foreground/60 pl-24">{row.hint}</p>
                    </div>
                  ))}
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground w-24 shrink-0">Final reduction</span>
                    <input
                      type="number" min={0} max={200}
                      value={spCascadeParams.finalReduction}
                      onChange={e => setSpCascadeParams(p => ({ ...p, finalReduction: Math.max(0, Number(e.target.value)) }))}
                      className="w-12 text-xs border rounded px-1 py-0.5 bg-background text-center"
                      data-testid="input-sp-cascade-finalReduction"
                    />
                    <p className="text-[10px] text-muted-foreground/60">All stats drop by this after boosts</p>
                  </div>
                  <Button variant="ghost" size="sm" className="text-xs h-6 w-full" onClick={() => setSpCascadeParams(DEFAULT_SP_CASCADE_PARAMS)}>
                    Reset to defaults
                  </Button>
                  {showSPCascadeMakeDefaultConfirm ? (
                    <div className="rounded-md p-2 border border-yellow-500/40 bg-yellow-950/40 space-y-2">
                      <p className="text-xs text-yellow-200">Save these values as the new permanent default?</p>
                      <div className="flex gap-2">
                        <Button size="sm" className="flex-1 h-7 text-xs" style={{ background: "#7a4400", color: "#fff" }} onClick={() => {
                          try { localStorage.setItem(SP_CASCADE_PARAMS_USER_DEFAULT_KEY, JSON.stringify(spCascadeParams)); } catch {}
                          setShowSPCascadeMakeDefaultConfirm(false);
                        }} data-testid="button-sp-cascade-make-default-confirm">
                          Confirm
                        </Button>
                        <Button size="sm" variant="outline" className="flex-1 h-7 text-xs" onClick={() => setShowSPCascadeMakeDefaultConfirm(false)} data-testid="button-sp-cascade-make-default-cancel">
                          Cancel
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <Button variant="ghost" size="sm" className="text-xs h-6 w-full text-yellow-400/80 hover:text-yellow-300" onClick={() => setShowSPCascadeMakeDefaultConfirm(true)} data-testid="button-sp-cascade-make-default">
                      Make Default
                    </Button>
                  )}
                </div>
              )}
              <div className="flex gap-2">
                <Button size="sm" onClick={runSPCascade} className="flex-1 gap-1" data-testid="button-sp-cascade-confirm">
                  <Zap className="w-3 h-3" /> Confirm Cascade
                </Button>
                <Button size="sm" variant="outline" onClick={() => setShowSPCascadeConfirm(false)} className="flex-1" data-testid="button-sp-cascade-cancel">
                  Cancel
                </Button>
              </div>
            </Card>
          )}
          <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
            {SP_KEYS.map(key => (
              <div key={key} className="flex items-center gap-2">
                <label className="text-xs text-muted-foreground w-28 shrink-0">{SP_LABELS[key]}</label>
                <input
                  type="number"
                  min={0}
                  max={SP_MAX}
                  value={editCustomSP[key] ?? 0}
                  onChange={e => setEditCustomSP(prev => ({ ...prev, [key]: Math.max(0, Math.min(SP_MAX, Number(e.target.value))) }))}
                  className="w-14 text-xs border rounded px-1.5 py-0.5 bg-background text-center"
                  data-testid={`input-sp-${key}`}
                />
              </div>
            ))}
          </div>
          {SP_KEYS.some(k => (editCustomSP[k] ?? 0) > 0) && (
            <Button variant="ghost" size="sm" onClick={() => setEditCustomSP(BLANK_SP())} className="text-xs w-full h-7">
              Clear All (revert to weekly auto-stats)
            </Button>
          )}
        </Card>
        <Card className="p-4 w-full space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-sm font-semibold">Refinement Stats</p>
            <div className="flex gap-1.5">
              <Button variant="outline" size="sm" onClick={copyRefinementSkills} className="text-xs gap-1 h-7 px-2" data-testid="button-copy-refskills">
                <Copy className="w-3 h-3" /> Copy
              </Button>
              <Button variant="outline" size="sm" onClick={pasteRefinementSkills} disabled={!hasRefClipboard} className="text-xs gap-1 h-7 px-2" data-testid="button-paste-refskills">
                <ClipboardPaste className="w-3 h-3" /> Paste
              </Button>
              <Button variant="outline" size="sm" onClick={() => setShowCascadeConfirm(v => !v)} className="text-xs gap-1 h-7 px-2" data-testid="button-auto-cascade">
                <Zap className="w-3 h-3" /> Cascade
              </Button>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">Set each skill directly (0–100). Overrides the auto-distribution. Copy all 13 values and paste them onto any other fighter.</p>
          {showCascadeConfirm && (
            <Card className="p-3 border-orange-500/40 bg-card space-y-3">
              <div className="flex items-center justify-between">
                <p className="text-sm font-semibold">Auto Cascade Down Roster?</p>
                <Button
                  variant={customCascade ? "default" : "outline"}
                  size="sm"
                  onClick={() => setCustomCascade(v => !v)}
                  className="text-xs h-6 px-2"
                  data-testid="button-cascade-custom-toggle"
                >
                  {customCascade ? "Custom" : "Default"}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Every fighter ranked below will have refinement stats derived from these values — each step progressively weaker. Roster auto-saved on confirm.
              </p>
              {customCascade && (
                <div className="space-y-2 border border-border rounded-md p-2">
                  <p className="text-[10px] uppercase text-muted-foreground font-semibold tracking-wide">Cascade Rules</p>
                  {([
                    { label: "Step reduction", minKey: "reductionMin", maxKey: "reductionMax", hint: "Each skill drops by this range per step" },
                    { label: "Skills boosted", minKey: "boostedCountMin", maxKey: "boostedCountMax", hint: "How many random skills get a boost" },
                    { label: "Boost amount", minKey: "boostMin", maxKey: "boostMax", hint: "Points added to each boosted skill" },
                  ] as const).map(row => (
                    <div key={row.label} className="space-y-0.5">
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-muted-foreground w-24 shrink-0">{row.label}</span>
                        <span className="text-[10px] text-muted-foreground">min</span>
                        <input
                          type="number" min={0} max={100}
                          value={cascadeParams[row.minKey]}
                          onChange={e => setCascadeParams(p => ({ ...p, [row.minKey]: Math.max(0, Number(e.target.value)) }))}
                          className="w-12 text-xs border rounded px-1 py-0.5 bg-background text-center"
                          data-testid={`input-cascade-${row.minKey}`}
                        />
                        <span className="text-[10px] text-muted-foreground">max</span>
                        <input
                          type="number" min={0} max={100}
                          value={cascadeParams[row.maxKey]}
                          onChange={e => setCascadeParams(p => ({ ...p, [row.maxKey]: Math.max(0, Number(e.target.value)) }))}
                          className="w-12 text-xs border rounded px-1 py-0.5 bg-background text-center"
                          data-testid={`input-cascade-${row.maxKey}`}
                        />
                      </div>
                      <p className="text-[10px] text-muted-foreground/60 pl-24">{row.hint}</p>
                    </div>
                  ))}
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground w-24 shrink-0">Final reduction</span>
                    <input
                      type="number" min={0} max={100}
                      value={cascadeParams.finalReduction}
                      onChange={e => setCascadeParams(p => ({ ...p, finalReduction: Math.max(0, Number(e.target.value)) }))}
                      className="w-12 text-xs border rounded px-1 py-0.5 bg-background text-center"
                      data-testid="input-cascade-finalReduction"
                    />
                    <p className="text-[10px] text-muted-foreground/60">All skills drop by this after boosts</p>
                  </div>
                  <Button variant="ghost" size="sm" className="text-xs h-6 w-full" onClick={() => setCascadeParams(DEFAULT_CASCADE_PARAMS)}>
                    Reset to defaults
                  </Button>
                  {showCascadeMakeDefaultConfirm ? (
                    <div className="rounded-md p-2 border border-yellow-500/40 bg-yellow-950/40 space-y-2">
                      <p className="text-xs text-yellow-200">Save these values as the new permanent default?</p>
                      <div className="flex gap-2">
                        <Button size="sm" className="flex-1 h-7 text-xs" style={{ background: "#7a4400", color: "#fff" }} onClick={() => {
                          try { localStorage.setItem(CASCADE_PARAMS_USER_DEFAULT_KEY, JSON.stringify(cascadeParams)); } catch {}
                          setShowCascadeMakeDefaultConfirm(false);
                        }} data-testid="button-cascade-make-default-confirm">
                          Confirm
                        </Button>
                        <Button size="sm" variant="outline" className="flex-1 h-7 text-xs" onClick={() => setShowCascadeMakeDefaultConfirm(false)} data-testid="button-cascade-make-default-cancel">
                          Cancel
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <Button variant="ghost" size="sm" className="text-xs h-6 w-full text-yellow-400/80 hover:text-yellow-300" onClick={() => setShowCascadeMakeDefaultConfirm(true)} data-testid="button-cascade-make-default">
                      Make Default
                    </Button>
                  )}
                </div>
              )}
              <div className="flex gap-2">
                <Button size="sm" onClick={runCascade} className="flex-1 gap-1" data-testid="button-cascade-confirm">
                  <Zap className="w-3 h-3" /> Confirm Cascade
                </Button>
                <Button size="sm" variant="outline" onClick={() => setShowCascadeConfirm(false)} className="flex-1" data-testid="button-cascade-cancel">
                  Cancel
                </Button>
              </div>
            </Card>
          )}
          <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
            {REFINEMENT_SKILL_KEYS.map(key => (
              <div key={key} className="flex items-center gap-2">
                <label className="text-xs text-muted-foreground w-28 shrink-0">{REFINEMENT_SKILL_LABELS[key]}</label>
                <input
                  type="number"
                  min={0}
                  max={100}
                  value={editRefinementSkills[key] ?? 0}
                  onChange={e => setEditRefinementSkills(prev => ({ ...prev, [key]: Math.max(0, Math.min(100, Number(e.target.value))) }))}
                  className="w-14 text-xs border rounded px-1.5 py-0.5 bg-background text-center"
                  data-testid={`input-ref-${key}`}
                />
              </div>
            ))}
          </div>
          {REFINEMENT_SKILL_KEYS.some(k => (editRefinementSkills[k] ?? 0) > 0) && (
            <Button variant="ghost" size="sm" onClick={() => setEditRefinementSkills(BLANK_REF_SKILLS())} className="text-xs w-full h-7">
              Clear All (revert to auto-distribution)
            </Button>
          )}
        </Card>
        <Button onClick={applyEdit} className="w-full gap-2" data-testid="button-apply-edit">
          <Check className="w-4 h-4" /> Apply Changes
        </Button>
        <Button
          variant="outline"
          onClick={() => setEditingNeuralId(editingId)}
          className="w-full gap-2"
          data-testid="button-edit-fighter-neural"
        >
          <BarChart3 className="w-4 h-4" /> Edit Neural Network
          {fighterHasNeural(editingId) && <span className="text-[10px] text-primary ml-1">custom</span>}
        </Button>
        <div className="flex items-center justify-center gap-2 w-full pt-1">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => prevFighter && navigateTo(prevFighter)}
            disabled={!prevFighter}
            data-testid="button-prev-fighter-bottom"
          >
            <ChevronLeft className="w-5 h-5" />
          </Button>
          {currentIndex >= 0 && (
            <span className="text-xs text-muted-foreground tabular-nums w-12 text-center">
              {currentIndex + 1}/{filtered.length}
            </span>
          )}
          <Button
            variant="ghost"
            size="icon"
            onClick={() => nextFighter && navigateTo(nextFighter)}
            disabled={!nextFighter}
            data-testid="button-next-fighter-bottom"
          >
            <ChevronRight className="w-5 h-5" />
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center gap-3 p-4 max-w-xl mx-auto">
      <div className="flex items-center gap-3 w-full">
        <Button variant="ghost" size="icon" onClick={() => onBack()} data-testid="button-back-roster-edit">
          <ArrowLeft className="w-5 h-5" />
        </Button>
        <h2 className="text-xl font-bold flex-1">Edit Roster</h2>
        <Button variant="outline" size="sm" onClick={downloadRoster} className="gap-1 text-xs" data-testid="button-download-roster" title="Download Roster">
          <Download className="w-3 h-3" /> Export
        </Button>
        <Button variant="outline" size="sm" onClick={() => rosterFileRef.current?.click()} className="gap-1 text-xs" data-testid="button-import-roster" title="Import Roster">
          <Upload className="w-3 h-3" /> Import
        </Button>
        <input
          ref={rosterFileRef}
          type="file"
          accept=".json"
          className="hidden"
          onChange={handleRosterFileSelect}
        />
        <Button variant="outline" size="sm" onClick={() => setShowRankingRef(true)} className="gap-1 text-xs" data-testid="button-ranking-ref-tab">
          Ranking Ref
        </Button>
        <Button variant="outline" size="sm" onClick={() => setShowNeural(true)} className="gap-1 text-xs" data-testid="button-neural-tab">
          Neural Net
        </Button>
        <Button onClick={handleSave} size="sm" className="gap-1" data-testid="button-save-roster">
          <Save className="w-4 h-4" /> Save
        </Button>
      </div>

      <Input
        placeholder="Search fighters..."
        value={search}
        onChange={e => setSearch(e.target.value)}
        className="w-full"
        data-testid="input-roster-search"
      />

      {importError && (
        <p className="text-destructive text-sm text-center w-full" data-testid="text-roster-import-error">{importError}</p>
      )}

      <div ref={scrollContainerRef} className="space-y-1 w-full max-h-[65vh] overflow-y-auto">
        {filtered.map(f => {
          const entry = getRosterEntryById(f.id);
          if (!entry) return null;
          const name = getRosterDisplayName(entry, f);
          const fc = getRosterFighterColors(f);
          const fighterColors: FighterColors = {
            gloves: fc.gloves,
            gloveTape: fc.gloveTape,
            trunks: fc.trunks,
            shoes: fc.shoes,
            skin: fc.skin,
            socks: fc.socks,
            laces: fc.laces,
            soles: fc.soles,
            waistStripe: fc.waistStripe,
          };
          return (
            <Card
              key={f.id}
              className="p-2 px-3 cursor-pointer hover:bg-muted/50 transition-colors"
              onClick={() => startEdit(f)}
              data-testid={`card-roster-fighter-${f.id}`}
            >
              <div className="flex items-center gap-3">
                <span className="text-xs font-bold text-muted-foreground w-8">#{f.rank}</span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm truncate">{name}</p>
                  <p className="text-[10px] text-muted-foreground">
                    {entry.archetype} &bull; {f.wins}W-{f.losses}L-{f.draws}D &bull; LV {f.level}
                  </p>
                </div>
                {(f.customFirstName || f.customNickname || f.customLastName || f.customSkinColor || f.customGloves || f.customTrunks || f.customShoes || f.customSocks || f.customGloveTape || f.customSpacial || f.customSpacialParts?.length) && (
                  <span className="text-[10px] text-primary">edited</span>
                )}
                <div className="w-12 h-16 shrink-0">
                  <FighterStanceCanvas colors={fighterColors} width={120} height={144} />
                </div>
                <Pencil className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
              </div>
            </Card>
          );
        })}
        {filtered.length === 0 && (
          <p className="text-sm text-muted-foreground text-center py-4">No fighters found.</p>
        )}
      </div>
    </div>
  );
}
