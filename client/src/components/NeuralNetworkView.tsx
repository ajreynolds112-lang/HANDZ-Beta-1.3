import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { getFightTips, saveFightTips } from "@/lib/localSaves";
import { useState, useEffect, useRef, useCallback } from "react";
import { downloadAllSounds } from "@/lib/downloadSounds";
import { loadXpConfig, saveXpConfig, loadXpDefaults, saveXpDefaults, hasCustomXpDefaults, DEFAULT_XP_CONFIG, type XpConfig } from "@/lib/xpConfig";
import PunchAnimEditor from "@/components/PunchAnimEditor";
import NeuralTestFight from "@/components/NeuralTestFight";
import AiTrainingView from "@/components/AiTrainingView";
import RosterGenerationView from "@/components/RosterGenerationView";
import * as localSaves from "@/lib/localSaves";
import { regenerateRosterNumbers } from "@/game/careerRoster";
import type { CareerRosterState } from "@shared/schema";
import { ADMIN_PIN, isValidPin } from "@/lib/pinAuth";
import { ArrowLeft, RotateCcw, Save, Lock, Download, Upload, Trash2, Star, Music, Lightbulb, Plus, Minus, Users, Package, BookOpen, Swords } from "lucide-react";
import ItemsEditorView from "@/components/ItemsEditorView";
import GameDocsView from "@/components/GameDocsView";
import { RefinementTuningCard } from "@/components/RefinementTuningCard";
import { RlPolicyCard } from "@/components/RlPolicyCard";
import ScalingReferenceTables from "@/components/ScalingReferenceTables";
import {
  AI_PATTERN_RANGES, DEFAULT_AI_PATTERN_CONFIG, PATTERN_HUD_MAX, clampAiPatternField,
  sanitizeAiPatternConfig, type AiPatternConfig,
} from "@/game/aiPatterns";
import { isUnderTheHoodEnabled, setUnderTheHoodEnabled } from "@/components/PatternMemoryHud";
import {
  applyTuningBundle,
  buildTuningBundle,
  pushTuningDefaults,
  startTuningDefaultsWatcher,
  validateTuningBundle,
  type TuningBundle,
} from "@/lib/tuningBundle";

const LS_KEY = "handz_neural_state";
const LS_PRESETS_KEY = "handz_neural_presets";
const LS_DEFAULTS_KEY = "handz_neural_defaults";
const LS_FIGHTER_NEURAL_KEY = "handz_fighter_neural";
const LS_NIGHTMARE_BYPASS_KEY = "handz_nightmare_bypass";
const LS_REFINEMENT_BYPASS_KEY = "handz_refinement_bypass";
const LS_RC_CONFIG_KEY = "handz_rc_config";
const LS_DIRECTIONAL_PB_KEY = "handz_directional_perfect_block";
const LS_MAX_STAM_CONFIG_KEY = "handz_max_stamina_config";
const LS_TURN_CONFIG_KEY = "handz_turn_config";
const LS_AI_RANGE_CONFIG_KEY = "handz_ai_range_config";
const LS_STOPPAGE_CONFIG_KEY = "handz_stoppage_config";
const LS_AI_PATTERN_CONFIG_KEY = "handz_ai_pattern_config";
const LS_FATIGUE_CONFIG_KEY = "handz_fatigue_config";

/**
 * Directional perfect block: when on, a standing perfect block only nullifies
 * punches thrown by a standing attacker and a ducking one only nullifies punches
 * thrown out of a duck. Off by default — a perfect block stops anything.
 */
export function isDirectionalPerfectBlockEnabled(): boolean {
  try { return localStorage.getItem(LS_DIRECTIONAL_PB_KEY) === "true"; } catch { return false; }
}

export interface RcConfig {
  chanceJourneyman: number;
  chanceContender: number;
  chanceElite: number;
  chanceChampion: number;
  delayMinSec: number;
  delayMaxSec: number;
  speedupMinSec: number;
  speedupMaxSec: number;
  vulnerableWindowHalf: number;
}

export const DEFAULT_RC_CONFIG: RcConfig = {
  chanceJourneyman: 0.40,
  chanceContender: 0.65,
  chanceElite: 0.85,
  chanceChampion: 1.00,
  delayMinSec: 0.01,
  delayMaxSec: 0.05,
  speedupMinSec: 0.02,
  speedupMaxSec: 0.10,
  vulnerableWindowHalf: 1.0,
};

function loadRcConfig(): RcConfig {
  try {
    const raw = localStorage.getItem(LS_RC_CONFIG_KEY);
    if (!raw) return { ...DEFAULT_RC_CONFIG };
    return { ...DEFAULT_RC_CONFIG, ...JSON.parse(raw) };
  } catch { return { ...DEFAULT_RC_CONFIG }; }
}

function saveRcConfig(cfg: RcConfig) {
  localStorage.setItem(LS_RC_CONFIG_KEY, JSON.stringify(cfg));
}

export function getRcConfig(): RcConfig {
  return loadRcConfig();
}

/** One amount per mid-fight event that moves a fighter's tank. See MaxStamConfig. */
export interface MaxStamAmounts {
  /** Clean punch taken, rolled at `cleanHitChance`. */
  cleanHitTaken: number;
  /** Every `cleanStreakPunches` clean punches taken, on top of the roll above. */
  cleanStreakTaken: number;
  stunTaken: number;
  perfectBlock: number;
  /** Charged the moment a punch lands inside the taker's vulnerable sway window. */
  rhythmCutHit: number;
  /**
   * The most every rhythm cut together can take off one fighter in one bout —
   * a magnitude, not a signed amount, and the only entry here that caps another.
   * Only pool the cut actually took counts against it, so a loss the mouthguard
   * shrugs off doesn't eat the allowance.
   */
  rhythmCutFightCap: number;
  /** Every `ringMileageInterval` seconds the fighter spends walking. */
  ringMileage: number;
  /** Surcharge on a punch that actually goes out charged. */
  chargedPunchThrown: number;
  /** Handed back when a charged punch lands a crit or a stun. */
  chargedCritRefund: number;
  /**
   * Panic Reset: hitting Reset while still rocked from a punch that just landed.
   * The window that counts as "still rocked", and the floor the bite stops at,
   * stay on the fatigue card — this is only what one panic Reset costs.
   */
  resetPanic: number;
  /** Charged once per knockdown the fighter gets up from. */
  knockdownSurvived: number;
  /** The bell: every fighter pays this at the end of every round... */
  roundEndBase: number;
  /** ...plus this if they lost the round... */
  roundEndLostRound: number;
  /** ...plus this per knockdown they went down in... */
  roundEndPerKd: number;
  /** ...plus this per 50 punches they threw. */
  roundEndPer50Punches: number;
}

/**
 * One flag per event, used twice over: `usePoints` (true reads that event's
 * points number, false its percent one) and `enabled` (false switches the event
 * off outright, without touching either number).
 */
export type MaxStamFlags = Record<keyof MaxStamAmounts, boolean>;

/**
 * Every mid-fight event that moves a fighter's max stamina, in one place.
 *
 * Signed throughout: negative subtracts, positive adds. A rule can be flipped
 * from a punishment into a reward (or the other way) purely by changing its sign
 * here -- the engine reads the sign and routes to the drain or the restore path,
 * so no code change is needed either way. Gains remain capped at the pool the
 * fighter started the bout with, so a large positive number hands tank back
 * faster but never grows a fighter past their opening pool.
 *
 * `usePoints` carries a unit per amount, not one for the card, so the events can
 * be weighted against each other individually -- a bell that costs everyone the
 * same 5 points while a knockdown takes a tenth of whatever tank that particular
 * fighter brought:
 *
 * - on (default): the number is a literal count of stamina points. A big tank
 *   and a small one lose exactly the same amount, so the rule bites hardest on
 *   small fighters and the pool comes down in a straight line.
 * - off: the number is a percent of the pool that fighter started the bout with.
 *   Everyone pays proportionally, which is how the round-end, knockdown and
 *   clean-punch-streak rules behaved before the toggle existed.
 *
 * The two unit sets are stored separately rather than converted, because there
 * is no honest exchange rate between them -- "3 points" is a different rule at
 * every pool size. Ticking one row's box swaps which set that row reads and
 * leaves both numbers untouched, so switching back and forth costs nothing.
 *
 * `enabled` is the on/off switch for each event, kept separate from its amount
 * so a rule can be parked without losing the number it was tuned to. A disabled
 * event never fires: it is not a zero amount, it simply doesn't happen.
 */
export interface MaxStamConfig {
  usePoints: MaxStamFlags;
  enabled: MaxStamFlags;
  points: MaxStamAmounts;
  percent: MaxStamAmounts;
  /** Odds (%) a clean punch taken charges `cleanHitTaken`. */
  cleanHitChance: number;
  /** Clean punches taken per `cleanStreakTaken` payout. */
  cleanStreakPunches: number;
  /** Seconds of movement banked per `ringMileage` payout. */
  ringMileageInterval: number;
}

/** Points-mode defaults. Percent-mode figures at a 250-point pool, rounded. */
const DEFAULT_MAX_STAM_POINTS: MaxStamAmounts = {
  cleanHitTaken: -3,
  cleanStreakTaken: -2,
  stunTaken: -3,
  perfectBlock: 2,
  rhythmCutHit: -2.5,
  rhythmCutFightCap: 125,
  ringMileage: -2,
  chargedPunchThrown: -3,
  chargedCritRefund: 8,
  resetPanic: -2.5,
  knockdownSurvived: -25,
  roundEndBase: -5,
  roundEndLostRound: -0.3,
  roundEndPerKd: -1.5,
  roundEndPer50Punches: -0.05,
};

/** Percent-mode defaults — what these rules charged before the unit toggle. */
const DEFAULT_MAX_STAM_PERCENT: MaxStamAmounts = {
  cleanHitTaken: -1.2,
  cleanStreakTaken: -0.5,
  stunTaken: -1.2,
  perfectBlock: 0.8,
  rhythmCutHit: -1,
  rhythmCutFightCap: 50,
  ringMileage: -0.8,
  chargedPunchThrown: -1.2,
  chargedCritRefund: 3.2,
  resetPanic: -1,
  knockdownSurvived: -10,
  roundEndBase: -2,
  roundEndLostRound: -0.1,
  roundEndPerKd: -0.5,
  roundEndPer50Punches: -0.01,
};

/** Every event key, in the order the card lists them. */
export const MAX_STAM_KEYS = Object.keys(DEFAULT_MAX_STAM_POINTS) as (keyof MaxStamAmounts)[];

function allMaxStamFlags(value: boolean): MaxStamFlags {
  const flags = {} as MaxStamFlags;
  for (const k of MAX_STAM_KEYS) flags[k] = value;
  return flags;
}

export const DEFAULT_MAX_STAM_CONFIG: MaxStamConfig = {
  usePoints: allMaxStamFlags(true),
  enabled: allMaxStamFlags(true),
  points: { ...DEFAULT_MAX_STAM_POINTS },
  percent: { ...DEFAULT_MAX_STAM_PERCENT },
  cleanHitChance: 50,
  cleanStreakPunches: 10,
  ringMileageInterval: 15,
};

function cloneMaxStamDefaults(): MaxStamConfig {
  return {
    ...DEFAULT_MAX_STAM_CONFIG,
    usePoints: allMaxStamFlags(true),
    enabled: allMaxStamFlags(true),
    points: { ...DEFAULT_MAX_STAM_POINTS },
    percent: { ...DEFAULT_MAX_STAM_PERCENT },
  };
}

/** The four amounts the pre-toggle config stored flat on the object, in points. */
const LEGACY_MAX_STAM_KEYS = ["cleanHitTaken", "stunTaken", "perfectBlock", "ringMileage"] as const;

function numOr(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/**
 * Reads one per-event flag block off a saved config.
 *
 * Three shapes have shipped for `usePoints`: absent (everything was points), a
 * single boolean for the whole card, and today's one-flag-per-event object. The
 * first two both collapse to "give every event the same value", which leaves a
 * config tuned under either of them fighting exactly the way it did. `enabled`
 * only has the absent case, and absent means every event is live.
 */
function loadMaxStamFlags(raw: unknown, fallback: boolean): MaxStamFlags {
  if (typeof raw === "boolean") return allMaxStamFlags(raw);
  const flags = allMaxStamFlags(fallback);
  if (raw && typeof raw === "object") {
    for (const k of MAX_STAM_KEYS) {
      const v = (raw as Record<string, unknown>)[k];
      if (typeof v === "boolean") flags[k] = v;
    }
  }
  return flags;
}

function loadMaxStamConfig(): MaxStamConfig {
  const def = cloneMaxStamDefaults();
  try {
    const raw = localStorage.getItem(LS_MAX_STAM_CONFIG_KEY);
    if (!raw) return def;
    const parsed = JSON.parse(raw) ?? {};
    // Configs saved before the unit toggle kept the four amounts they had at the
    // top level, all of them in points. They belong in the points set, and the
    // fighter must keep fighting the way that config said.
    const legacy: Partial<MaxStamAmounts> = {};
    for (const k of LEGACY_MAX_STAM_KEYS) {
      if (typeof parsed[k] === "number" && Number.isFinite(parsed[k])) legacy[k] = parsed[k];
    }
    return {
      usePoints: loadMaxStamFlags(parsed.usePoints, true),
      enabled: loadMaxStamFlags(parsed.enabled, true),
      points: { ...def.points, ...legacy, ...(parsed.points ?? {}) },
      percent: { ...def.percent, ...(parsed.percent ?? {}) },
      cleanHitChance: numOr(parsed.cleanHitChance, def.cleanHitChance),
      cleanStreakPunches: numOr(parsed.cleanStreakPunches, def.cleanStreakPunches),
      ringMileageInterval: numOr(parsed.ringMileageInterval, def.ringMileageInterval),
    };
  } catch { return def; }
}

function saveMaxStamConfig(cfg: MaxStamConfig) {
  localStorage.setItem(LS_MAX_STAM_CONFIG_KEY, JSON.stringify(cfg));
  maxStamCache = {
    ...cfg,
    usePoints: { ...cfg.usePoints },
    enabled: { ...cfg.enabled },
    points: { ...cfg.points },
    percent: { ...cfg.percent },
  };
}

/**
 * The number showing against each event — taken from the points set or the
 * percent set per key, since every event picks its own unit. Disabled events
 * keep their number here so the card can still show what they were tuned to;
 * it is `maxStamAmount` in the engine that reads the enable flag and the unit
 * together and hands back the points to actually charge.
 */
export function activeMaxStamAmounts(cfg: MaxStamConfig): MaxStamAmounts {
  const out = {} as MaxStamAmounts;
  for (const k of MAX_STAM_KEYS) out[k] = (cfg.usePoints[k] ? cfg.points : cfg.percent)[k];
  return out;
}

/** Whether one event fires at all. A disabled event is skipped, not zeroed. */
export function isMaxStamEnabled(cfg: MaxStamConfig, key: keyof MaxStamAmounts): boolean {
  return cfg.enabled[key] !== false;
}

/**
 * Cached, unlike getRcConfig, because the fight loop reads this on every accepted
 * punch rather than once at brain construction. saveMaxStamConfig refreshes the
 * cache synchronously, so an edit is live in the next bout with no reload -- the
 * same contract getScaling() offers.
 */
let maxStamCache: MaxStamConfig | null = null;
export function getMaxStamConfig(): MaxStamConfig {
  if (!maxStamCache) maxStamCache = loadMaxStamConfig();
  return maxStamCache;
}

/**
 * Energy fatigue & Reset. The third fatigue axis: punches taken drain Energy, a
 * drained fighter's torso and forearms lag behind their footwork, and that
 * inertia sway is what carries every penalty. Reset (B) snaps the stance clean
 * and turns the whole system down for a window.
 *
 * Fatigue and Reset share one card because they are one system — Reset exists to
 * answer fatigue, and half these numbers are only meaningful against the other
 * half. None of it is surfaced as on-screen text in a bout, so until now the only
 * way to retune it was to edit engine.ts.
 */
export interface FatigueConfig {
  /** Punches taken before Energy starts draining at all. */
  freePunches: number;
  /** Energy a punch costs once the free ones are used up. */
  energyBaseCost: number;
  /** Each consecutive punch taken adds this much on top, to a ceiling. */
  energyEscalation: number;
  energyEscalationCap: number;
  /** Energy converts to CURRENT stamina in fixed steps: N Energy costs M stamina. */
  energyPerStaminaStep: number;
  staminaPerStep: number;
  /**
   * Consecutive punches also make each step cost more. Capped for the same reason
   * the Energy escalation is: uncapped, a long exchange drains the pool faster
   * than it can possibly regenerate and the round is decided by arithmetic.
   */
  staminaEscalation: number;
  staminaEscalationCap: number;

  /** Sway length ramps between these over swayTimeCapPunches. */
  swayTimeMin: number;
  swayTimeMax: number;
  swayTimeCapPunches: number;
  /**
   * Sway travel, as a share of the head travel a full slip produces, and the
   * ramp ceiling applied on top of it.
   */
  swayDistFracOfSlip: number;
  swayDistRampMax: number;
  /**
   * How far into the sway the forearms start their own. This lag is the whole
   * visual: the torso goes first and the arms are still catching up. It also sets
   * where the punch-input gate sits, since that is measured on the ARM sway.
   */
  armLagFrac: number;
  /**
   * Extra lag the REAR forearm carries on top of that, so the two arms don't move
   * as one piece. The sway therefore starts in the same order the Reset snap
   * finishes in — torso, then lead arm, then rear arm.
   */
  armStaggerFrac: number;

  /** Guard raising slows by up to this much, reached at the punch count below. */
  guardSlowMax: number;
  guardSlowCapPunches: number;
  /** Punch launch and retraction stretch by up to this much, 0 punches → cap. */
  punchSlowMax: number;
  punchSlowCapPunches: number;

  /** Share of a block's effectiveness lost while the sway is playing. */
  swayBlockIneffective: number;
  /** Punch input is dropped until the ARM sway is this far along. */
  swayInputGate: number;
  /** What a punch thrown into the sway suffers. It also cannot crit or stun. */
  swayMissAdd: number;
  swayDamageDebuff: number;
  /**
   * Seconds of lag every punch taken adds to this fighter's duck, for both
   * corners alike. The duck still goes on the instant it is asked for — it just
   * does not become a real crouch, and stops evading anything, until the debt
   * has been served. Only a Reset wipes it. 0 restores an instant duck.
   */
  duckLagPerHit: number;
  /**
   * How much wider a fighter's own rhythm vulnerability window gets for every
   * punch that lands on them without being perfect blocked, as a share of the
   * arc added to the half-width at EACH end. Wiped by a Reset, so it measures
   * how long they have gone on eating shots without one.
   */
  vulnPerHit: number;
  /**
   * Ceiling on the accrued lag, in seconds, however many punches a fighter has
   * eaten since their last Reset. 0 lifts the cap entirely — to switch the lag
   * itself off, zero duckLagPerHit instead.
   */
  duckLagMax: number;

  /**
   * A Reset does not switch fatigue off — it turns it down. Every fatigue debuff
   * keeps applying at this share of its strength for the life of the window, so
   * a badly gassed fighter who resets is sharp again but never quite fresh.
   */
  resetEffectMult: number;
  /**
   * Career bouts only: each punch that gets through drags the fighter's next
   * Reset out by this share of how long their snap currently takes, and
   * spending a Reset spends the whole bank. The first resetSnapSlowGraceHits
   * punches after a Reset are owed to the grace instead of banked. 0 turns the
   * whole thing off.
   */
  resetSnapSlowPerPunch: number;
  resetSnapSlowGraceHits: number;
  /**
   * A stun locks the stunned fighter out of Reset: this many seconds for a
   * fighter with no Defense, down a straight line to resetStunLockMin at the
   * stat's cap.
   */
  resetStunLockMax: number;
  resetStunLockMin: number;
  /** A stun lockout announces itself with two blinks inside this window. */
  stunLockBlinkWindow: number;
  /**
   * A Reset that plays all the way through is marked with one blink, after
   * which the eyes stay open: this long for a fighter who has taken nothing,
   * falling in a straight line to resetBlinkQuietMin by
   * resetBlinkQuietCapPunches punches taken over the bout.
   */
  resetBlinkQuietMax: number;
  resetBlinkQuietMin: number;
  resetBlinkQuietCapPunches: number;
  /**
   * Reaction flinch. A feint reaching full extension, a punch landing, or the
   * opponent dropping into a crouch, all inside flinchRangePx, drags a
   * defender's hands out of the guard by flinchBasePx for flinchDuration —
   * forward and down or forward and high depending on where they have been
   * getting hit — and their guard is bypassed outright while it plays. Only a
   * fighter who is walking or already crouched flinches at all, and a
   * defensive answer to the shot (perfect block, a duck thrown at it, a slip,
   * a live Reset) cancels it. Each reaction takes flinchDecayPerReaction off
   * the next; a Reset puts that back to full and buys a pass on one flinch
   * for flinchResetNegateWindow seconds.
   */
  flinchRangePx: number;
  flinchBasePx: number;
  flinchDuration: number;
  flinchDecayPerReaction: number;
  flinchResetNegateWindow: number;
  /**
   * How many feints of the same punch, out of the same stance, one committed
   * punch of it buys. Feints past the allowance still play but stop drawing a
   * reaction, until that punch is thrown for real in range again. Counted only
   * inside flinchRangePx, on both sides of the ratio.
   */
  flinchFeintRatioLimit: number;
  /** Gap between the torso, lead-arm and rear-arm snaps. */
  resetSnapStagger: number;
  /** Plays the whole snap — stagger and head dip alike — this much faster. */
  resetSnapSpeedMult: number;
  /**
   * Exaggerates how far the Reset actually travels — torso, arms and head dip —
   * over the modest fatigue sway it is easing out of. This is a readability
   * cue, not a physical quantity: 1 retraces the sway exactly, higher makes the
   * Reset legible from across the ring.
   */
  resetSnapDistMult: number;
  /** The stagger stretches to this multiple as current stamina approaches zero. */
  resetSnapSlowMax: number;
  /**
   * A Reset kicks the resetter's rhythm over to a full-speed level-1 sweep for
   * this long — running whether or not their feet are moving — and then hands
   * the rhythm back to their own footwork.
   */
  resetRhythmBurst: number;
  /** The subtle head dip that opens a Reset. */
  resetHeadDuckTime: number;
  resetHeadDuckPx: number;
  /**
   * Stamina recovery multiplier while a Reset is running AND the resetter is
   * further than resetFarDistancePx from their opponent. A Reset taken on the
   * back foot is meant to buy air, so getting out of the pocket with it is what
   * pays; resetting in range still clears the fatigue but recovers at the
   * ordinary rate. Both corners are measured the same way. 1 turns it off.
   */
  resetFarRegenMult: number;
  /** Centre-to-centre gap that counts as out of the pocket for the boost above. */
  resetFarDistancePx: number;
  /**
   * Resetting inside this long after being hit is a panic Reset: it costs max
   * stamina for the REMAINDER OF THE BOUT only. Nothing here is ever persisted —
   * startFight rebuilds maxStamina every bout, which is what keeps it fight-local.
   */
  resetPanicWindow: number;
  /** Panic Resets stop biting once max stamina is down to this share of base. */
  resetPanicFloor: number;
}

export const DEFAULT_FATIGUE_CONFIG: FatigueConfig = {
  freePunches: 3,
  energyBaseCost: 5,
  energyEscalation: 1,
  energyEscalationCap: 20,
  energyPerStaminaStep: 5,
  staminaPerStep: 3,
  staminaEscalation: 1,
  staminaEscalationCap: 20,

  swayTimeMin: 0.02,
  swayTimeMax: 0.5,
  swayTimeCapPunches: 250,
  swayDistFracOfSlip: 0.4,
  swayDistRampMax: 0.5,
  armLagFrac: 0.3,
  armStaggerFrac: 0.15,

  guardSlowMax: 0.5,
  guardSlowCapPunches: 150,
  punchSlowMax: 0.5,
  punchSlowCapPunches: 250,

  swayBlockIneffective: 0.9,
  swayInputGate: 0.25,
  swayMissAdd: 0.25,
  swayDamageDebuff: 0.5,
  duckLagPerHit: 0.02,
  duckLagMax: 0.4,
  vulnPerHit: 0.005,

  resetEffectMult: 0.1,
  resetSnapSlowPerPunch: 0.0025,
  resetSnapSlowGraceHits: 2,
  resetStunLockMax: 5,
  resetStunLockMin: 0.5,
  stunLockBlinkWindow: 0.35,
  resetBlinkQuietMax: 20,
  resetBlinkQuietMin: 3,
  resetBlinkQuietCapPunches: 200,
  flinchRangePx: 95,
  flinchBasePx: 8,
  flinchDuration: 0.35,
  flinchDecayPerReaction: 0.05,
  flinchResetNegateWindow: 1.5,
  flinchFeintRatioLimit: 4,
  resetSnapStagger: 0.1,
  resetSnapSpeedMult: 1.2,
  resetSnapDistMult: 2,
  resetSnapSlowMax: 2,
  resetRhythmBurst: 1,
  resetHeadDuckTime: 0.25,
  resetHeadDuckPx: 2,
  resetFarRegenMult: 3,
  resetFarDistancePx: 95,
  resetPanicWindow: 2,
  resetPanicFloor: 0.9,
};

function loadFatigueConfig(): FatigueConfig {
  try {
    const raw = localStorage.getItem(LS_FATIGUE_CONFIG_KEY);
    if (!raw) return { ...DEFAULT_FATIGUE_CONFIG };
    const parsed = JSON.parse(raw) as Partial<FatigueConfig>;
    const out = { ...DEFAULT_FATIGUE_CONFIG };
    // Field-by-field so a corrupt or half-written entry can only lose the fields
    // it actually broke. The fight loop reads these every tick and a NaN here
    // propagates straight into a fighter's stamina.
    for (const k of Object.keys(out) as (keyof FatigueConfig)[]) {
      const v = parsed?.[k];
      if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    }
    return out;
  } catch { return { ...DEFAULT_FATIGUE_CONFIG }; }
}

/**
 * Cached for the same reason getMaxStamConfig is: the fight loop reads it on
 * every tick, not once at fighter construction. The save refreshes the cache
 * synchronously, so an edit is live in the next bout with no reload.
 */
let fatigueCache: FatigueConfig | null = null;
export function getFatigueConfig(): FatigueConfig {
  if (!fatigueCache) fatigueCache = loadFatigueConfig();
  return fatigueCache;
}

function saveFatigueConfig(cfg: FatigueConfig) {
  localStorage.setItem(LS_FATIGUE_CONFIG_KEY, JSON.stringify(cfg));
  fatigueCache = { ...cfg };
}

/**
 * Seconds a fighter needs to come all the way around (180°) with nothing else
 * slowing them down. Turning is animated rather than instant, so this is both
 * the time the body spends visibly coming around and the wait before the
 * fighter counts as squared up — and a punch thrown before then misses. Stun's
 * own turn penalty is layered on top of this, never under it.
 *
 * 0 restores an instant snap; the ceiling is deliberately far past anything
 * playable so the turn can be slowed right down to watch it.
 *
 * Alongside the base delay sit the six mid-fight events that move a fighter's
 * own turn delay for the rest of the round. Each is a signed number of seconds:
 * negative sharpens the fighter up, positive leaves them turning slower, and
 * flipping a sign turns a punishment into a reward with no code change. The
 * running total can never take a fighter below an instant turn.
 */
export interface TurnConfig {
  baseTurnDelay: number;
  punchLanded: number;
  punchTaken: number;
  perfectBlock: number;
  critTaken: number;
  dodge: number;
  punchDodged: number;
  whiffClose: number;
  knockdownTaken: number;
}

export const DEFAULT_TURN_CONFIG: TurnConfig = {
  baseTurnDelay: 0.25,
  punchLanded: -0.002,
  punchTaken: 0.02,
  perfectBlock: -0.02,
  critTaken: 0.1,
  dodge: -0.05,
  punchDodged: -0.02,
  whiffClose: -0.01,
  knockdownTaken: 0.2,
};

export const TURN_DELAY_MIN = 0;
export const TURN_DELAY_MAX = 10;
export const TURN_EVENT_MIN = -1;
export const TURN_EVENT_MAX = 1;

export const TURN_EVENT_KEYS = [
  "punchLanded", "punchTaken", "perfectBlock", "critTaken", "dodge", "punchDodged", "whiffClose", "knockdownTaken",
] as const;
export type TurnEventKey = typeof TURN_EVENT_KEYS[number];

function clampTurnDelay(v: number): number {
  if (!Number.isFinite(v)) return DEFAULT_TURN_CONFIG.baseTurnDelay;
  return Math.min(TURN_DELAY_MAX, Math.max(TURN_DELAY_MIN, v));
}

function clampTurnEvent(v: number, key: TurnEventKey): number {
  if (!Number.isFinite(v)) return DEFAULT_TURN_CONFIG[key];
  return Math.min(TURN_EVENT_MAX, Math.max(TURN_EVENT_MIN, v));
}

function sanitizeTurnConfig(cfg: TurnConfig): TurnConfig {
  const out: TurnConfig = { ...cfg, baseTurnDelay: clampTurnDelay(cfg.baseTurnDelay) };
  for (const k of TURN_EVENT_KEYS) out[k] = clampTurnEvent(cfg[k], k);
  return out;
}

function loadTurnConfig(): TurnConfig {
  try {
    const raw = localStorage.getItem(LS_TURN_CONFIG_KEY);
    if (!raw) return { ...DEFAULT_TURN_CONFIG };
    return sanitizeTurnConfig({ ...DEFAULT_TURN_CONFIG, ...JSON.parse(raw) });
  } catch { return { ...DEFAULT_TURN_CONFIG }; }
}

function saveTurnConfig(cfg: TurnConfig) {
  const clamped = sanitizeTurnConfig(cfg);
  localStorage.setItem(LS_TURN_CONFIG_KEY, JSON.stringify(clamped));
  turnCache = { ...clamped };
}

/** Cached like the max-stamina block: the fight loop reads this every tick, for every fighter in the ring. */
let turnCache: TurnConfig | null = null;
export function getTurnConfig(): TurnConfig {
  if (!turnCache) turnCache = loadTurnConfig();
  return turnCache;
}

/**
 * The gap (in pixels, edge to edge) the AI tries to hold in neutral — its base
 * desired punching distance, and the anchor every other range decision starts
 * from. 52.5px is the default: a 65" arm lands a jab at roughly 85px, and
 * recorded bouts show fighters committing from about 42-80px, so the default
 * sits inside the AI's own reach.
 *
 * This is only the starting point. The AI still shifts off it for the phase it
 * is in (pressure sits closer, whiff-punishing sits further out), for its class,
 * and for what it learns about its effective range during the bout — so the
 * distance you watch it hold will drift around this number rather than sit on it.
 *
 * The bounds are the engine's own ideal-range clamp, so anything set here is a
 * distance the AI can actually be asked to hold.
 */
export interface AiRangeConfig {
  baseDesiredDistancePx: number;
  standDistanceOffsetPx: number;
}

export const DEFAULT_AI_RANGE_CONFIG: AiRangeConfig = {
  baseDesiredDistancePx: 52.5,
  standDistanceOffsetPx: 18,
};

export const AI_RANGE_MIN_PX = 24.5;
export const AI_RANGE_MAX_PX = 157.5;
export const AI_STAND_OFFSET_MIN_PX = -100;
export const AI_STAND_OFFSET_MAX_PX = 100;

function clampAiRange(v: number): number {
  if (!Number.isFinite(v)) return DEFAULT_AI_RANGE_CONFIG.baseDesiredDistancePx;
  return Math.min(AI_RANGE_MAX_PX, Math.max(AI_RANGE_MIN_PX, v));
}

function clampAiStandOffset(v: number): number {
  if (!Number.isFinite(v)) return DEFAULT_AI_RANGE_CONFIG.standDistanceOffsetPx;
  return Math.min(AI_STAND_OFFSET_MAX_PX, Math.max(AI_STAND_OFFSET_MIN_PX, v));
}

function sanitizeAiRangeConfig(cfg: AiRangeConfig): AiRangeConfig {
  return {
    baseDesiredDistancePx: clampAiRange(cfg.baseDesiredDistancePx),
    standDistanceOffsetPx: clampAiStandOffset(cfg.standDistanceOffsetPx),
  };
}

function loadAiRangeConfig(): AiRangeConfig {
  try {
    const raw = localStorage.getItem(LS_AI_RANGE_CONFIG_KEY);
    if (!raw) return { ...DEFAULT_AI_RANGE_CONFIG };
    return sanitizeAiRangeConfig({ ...DEFAULT_AI_RANGE_CONFIG, ...JSON.parse(raw) });
  } catch { return { ...DEFAULT_AI_RANGE_CONFIG }; }
}

function saveAiRangeConfig(cfg: AiRangeConfig) {
  const clamped = sanitizeAiRangeConfig(cfg);
  localStorage.setItem(LS_AI_RANGE_CONFIG_KEY, JSON.stringify(clamped));
  aiRangeCache = { ...clamped };
}

/**
 * Cached: the base distance is read once when a brain is built, but the standing
 * offset is read every time the AI works out where it wants to be, which is every
 * tick. Saving refreshes the cache, so an edit is live in the next bout.
 */
let aiRangeCache: AiRangeConfig | null = null;
export function getAiRangeConfig(): AiRangeConfig {
  if (!aiRangeCache) aiRangeCache = loadAiRangeConfig();
  return aiRangeCache;
}

/**
 * When a beating is one-sided enough for someone to end it early.
 *
 * Two separate rules, both off in practice and sparring:
 *
 *  - The REF stoppage waves the fight off while the AI is on the canvas, and
 *    only inside a knockdown window (by default the 2nd and 3rd knockdown it
 *    has taken). It fires when the player has landed a big enough multiple of
 *    what the opponent has landed — a punch-count comparison, not damage.
 *
 *  - The TOWEL comes in from the corner of whoever is losing, mid-round, from
 *    the first eligible round onwards. It compares real damage on the bar (this
 *    round OR the fight so far) and needs one side ahead by the ratio below,
 *    which eases a little every round so a long fight can still be stopped.
 *    Once a side qualifies, the corner still has to decide: that's a per-second
 *    roll built from a base chance plus the dominant fighter's unanswered
 *    streak, minus a penalty for every round the losing fighter has won.
 *
 * The towel also has two immunities — the loser has landed a real share of the
 * damage, or has been the last one scoring knockdowns. Immunity is spent once
 * per fight; the second time it would apply, the towel comes in anyway.
 */
export interface StoppageConfig {
  mercyMinKds: number;
  mercyMaxKds: number;
  mercyRatioCareer: number;
  mercyRatioQuick: number;
  towelFirstRound: number;
  towelDamageRatio: number;
  towelRatioDropPerRound: number;
  towelImmunityDamageShare: number;
  towelImmunityKds: number;
  towelBaseChance: number;
  towelStreakChance: number;
  towelRoundWonPenalty: number;
  towelCareerMult: number;
  towelGlobalMult: number;
}

export const DEFAULT_STOPPAGE_CONFIG: StoppageConfig = {
  mercyMinKds: 2,
  mercyMaxKds: 3,
  mercyRatioCareer: 9,
  mercyRatioQuick: 6,
  towelFirstRound: 2,
  towelDamageRatio: 30,
  towelRatioDropPerRound: 0.2,
  towelImmunityDamageShare: 0.5,
  towelImmunityKds: 2,
  towelBaseChance: 0.05,
  towelStreakChance: 0.02,
  towelRoundWonPenalty: 0.05,
  towelCareerMult: 0.6,
  towelGlobalMult: 0.7,
};

/** Per-field [min, max]; the counts are additionally rounded to whole numbers. */
const STOPPAGE_RANGES: Record<keyof StoppageConfig, [number, number]> = {
  mercyMinKds: [1, 20],
  mercyMaxKds: [1, 20],
  mercyRatioCareer: [1, 100],
  mercyRatioQuick: [1, 100],
  towelFirstRound: [1, 20],
  towelDamageRatio: [1, 200],
  towelRatioDropPerRound: [0, 20],
  towelImmunityDamageShare: [0, 1],
  towelImmunityKds: [1, 20],
  towelBaseChance: [0, 5],
  towelStreakChance: [0, 1],
  towelRoundWonPenalty: [0, 1],
  towelCareerMult: [0, 5],
  towelGlobalMult: [0, 5],
};

const STOPPAGE_INT_KEYS: (keyof StoppageConfig)[] = ["mercyMinKds", "mercyMaxKds", "towelFirstRound", "towelImmunityKds"];

export function clampStoppageField(key: keyof StoppageConfig, v: number): number {
  if (!Number.isFinite(v)) return DEFAULT_STOPPAGE_CONFIG[key];
  const [lo, hi] = STOPPAGE_RANGES[key];
  const clamped = Math.min(hi, Math.max(lo, v));
  return STOPPAGE_INT_KEYS.includes(key) ? Math.round(clamped) : clamped;
}

function sanitizeStoppageConfig(cfg: StoppageConfig): StoppageConfig {
  const out = {} as StoppageConfig;
  for (const k of Object.keys(DEFAULT_STOPPAGE_CONFIG) as (keyof StoppageConfig)[]) {
    out[k] = clampStoppageField(k, cfg[k]);
  }
  // A window that reads backwards would switch the ref stoppage off with no
  // sign of why, so the top of it follows the bottom up.
  out.mercyMaxKds = Math.max(out.mercyMaxKds, out.mercyMinKds);
  return out;
}

function loadStoppageConfig(): StoppageConfig {
  try {
    const raw = localStorage.getItem(LS_STOPPAGE_CONFIG_KEY);
    if (!raw) return { ...DEFAULT_STOPPAGE_CONFIG };
    return sanitizeStoppageConfig({ ...DEFAULT_STOPPAGE_CONFIG, ...JSON.parse(raw) });
  } catch { return { ...DEFAULT_STOPPAGE_CONFIG }; }
}

function saveStoppageConfig(cfg: StoppageConfig) {
  const clamped = sanitizeStoppageConfig(cfg);
  localStorage.setItem(LS_STOPPAGE_CONFIG_KEY, JSON.stringify(clamped));
  stoppageCache = { ...clamped };
}

/** Cached like the rest: the towel rule is rolled every tick of every round. */
let stoppageCache: StoppageConfig | null = null;
export function getStoppageConfig(): StoppageConfig {
  if (!stoppageCache) stoppageCache = loadStoppageConfig();
  return stoppageCache;
}

/**
 * AI pattern memory: how quickly each tier recognizes a repeated combination,
 * how many it can hold, and how confidently it counters one. See aiPatterns.ts
 * for what the numbers mean.
 */
function loadAiPatternConfig(): AiPatternConfig {
  try {
    const raw = localStorage.getItem(LS_AI_PATTERN_CONFIG_KEY);
    if (!raw) return { ...DEFAULT_AI_PATTERN_CONFIG };
    return sanitizeAiPatternConfig({ ...DEFAULT_AI_PATTERN_CONFIG, ...JSON.parse(raw) });
  } catch { return { ...DEFAULT_AI_PATTERN_CONFIG }; }
}

function saveAiPatternConfig(cfg: AiPatternConfig) {
  const clean = sanitizeAiPatternConfig(cfg);
  localStorage.setItem(LS_AI_PATTERN_CONFIG_KEY, JSON.stringify(clean));
  aiPatternCache = { ...clean };
}

/** Cached: read on every observed action, which is several times a second. */
let aiPatternCache: AiPatternConfig | null = null;
export function getAiPatternConfig(): AiPatternConfig {
  if (!aiPatternCache) aiPatternCache = loadAiPatternConfig();
  return aiPatternCache;
}

/**
 * Drop the caches this module holds so the next read comes from storage.
 * Called after a parameter bundle is uploaded — every other config either
 * exposes its own reload or keys its cache on the stored string.
 */
export function invalidateNeuralParamCaches(): void {
  maxStamCache = null;
  fatigueCache = null;
  turnCache = null;
  aiRangeCache = null;
  stoppageCache = null;
  aiPatternCache = null;
}

type Difficulty = "journeyman" | "contender" | "elite" | "champion";

interface NeuralParam {
  id: string;
  label: string;
  category: string;
}

const NEURAL_PARAMS: NeuralParam[] = [
  { id: "aggression", label: "Aggression", category: "Personality" },
  { id: "guardParanoia", label: "Guard Paranoia", category: "Personality" },
  { id: "feintiness", label: "Feintiness", category: "Personality" },
  { id: "cleanHitsVsVolume", label: "Precision vs Volume", category: "Personality" },
  { id: "stateThinkSpeed", label: "State Think Speed", category: "Reaction" },
  { id: "moveThinkSpeed", label: "Move Think Speed", category: "Reaction" },
  { id: "attackInterval", label: "Attack Frequency", category: "Reaction" },
  { id: "perfectReactChance", label: "Perfect React", category: "Defense" },
  { id: "defenseCycleSpeed", label: "Defense Cycling", category: "Defense" },
  { id: "headCondThreshold", label: "Head Conditioning", category: "Defense" },
  { id: "bodyCondThreshold", label: "Body Conditioning", category: "Defense" },
  { id: "rhythmCutCommit", label: "Rhythm Cut Commit", category: "Offense" },
  { id: "rhythmCutAggression", label: "Rhythm Cut Aggression", category: "Offense" },
  { id: "rhythmSwayAdapt", label: "Rhythm Sway Adapt", category: "Offense" },
  { id: "chargedPunchChance", label: "Charge Punch Chance", category: "Offense" },
  { id: "comboCommitChance", label: "Combo Commitment", category: "Offense" },
  { id: "executionIntensity", label: "Execution Layer", category: "Offense" },
  { id: "ringCutoff", label: "Ring Cutoff", category: "Movement" },
  { id: "ropeEscapeAwareness", label: "Rope Escape", category: "Movement" },
  { id: "lateralStrength", label: "Lateral Strength", category: "Movement" },
  { id: "kdRecovery1", label: "KD1 Recovery", category: "Resilience" },
  { id: "kdRecovery2", label: "KD2 Recovery", category: "Resilience" },
  { id: "kdRecovery3", label: "KD3 Recovery", category: "Resilience" },
  { id: "survivalInstinct", label: "Survival Instinct", category: "Resilience" },
];

type NeuralState = Record<string, number>;

const DEFAULT_STATES: Record<Difficulty, NeuralState> = {
  journeyman: {
    aggression: 0.33, guardParanoia: 0.25, feintiness: 0.10, cleanHitsVsVolume: 0.20,
    stateThinkSpeed: 0.15, moveThinkSpeed: 0.15, attackInterval: 0.20,
    perfectReactChance: 0.35, defenseCycleSpeed: 0.25, headCondThreshold: 0.80, bodyCondThreshold: 0.90,
    rhythmCutCommit: 0.10, rhythmCutAggression: 0.10, chargedPunchChance: 0.21, comboCommitChance: 0.25, executionIntensity: 0.25, rhythmSwayAdapt: 0.10,
    ringCutoff: 0.10, ropeEscapeAwareness: 0.20, lateralStrength: 0.20,
    kdRecovery1: 0.80, kdRecovery2: 0.50, kdRecovery3: 0.20, survivalInstinct: 0.20,
  },
  contender: {
    aggression: 0.59, guardParanoia: 0.35, feintiness: 0.20, cleanHitsVsVolume: 0.38,
    stateThinkSpeed: 0.40, moveThinkSpeed: 0.40, attackInterval: 0.38,
    perfectReactChance: 0.58, defenseCycleSpeed: 0.45, headCondThreshold: 0.55, bodyCondThreshold: 0.65,
    rhythmCutCommit: 0.30, rhythmCutAggression: 0.30, chargedPunchChance: 0.38, comboCommitChance: 0.45, executionIntensity: 0.55, rhythmSwayAdapt: 0.35,
    ringCutoff: 0.30, ropeEscapeAwareness: 0.40, lateralStrength: 0.35,
    kdRecovery1: 0.90, kdRecovery2: 0.70, kdRecovery3: 0.40, survivalInstinct: 0.40,
  },
  elite: {
    aggression: 0.81, guardParanoia: 0.45, feintiness: 0.29, cleanHitsVsVolume: 0.53,
    stateThinkSpeed: 0.70, moveThinkSpeed: 0.70, attackInterval: 0.62,
    perfectReactChance: 0.86, defenseCycleSpeed: 0.70, headCondThreshold: 0.35, bodyCondThreshold: 0.40,
    rhythmCutCommit: 0.55, rhythmCutAggression: 0.55, chargedPunchChance: 0.60, comboCommitChance: 0.80, executionIntensity: 0.80, rhythmSwayAdapt: 0.65,
    ringCutoff: 0.60, ropeEscapeAwareness: 0.65, lateralStrength: 0.50,
    kdRecovery1: 0.95, kdRecovery2: 0.85, kdRecovery3: 0.65, survivalInstinct: 0.70,
  },
  champion: {
    aggression: 0.93, guardParanoia: 0.55, feintiness: 0.37, cleanHitsVsVolume: 0.68,
    stateThinkSpeed: 0.95, moveThinkSpeed: 0.95, attackInterval: 0.85,
    perfectReactChance: 0.95, defenseCycleSpeed: 0.90, headCondThreshold: 0.22, bodyCondThreshold: 0.25,
    rhythmCutCommit: 0.83, rhythmCutAggression: 0.80, chargedPunchChance: 0.74, comboCommitChance: 0.95, executionIntensity: 1.0, rhythmSwayAdapt: 0.90,
    ringCutoff: 0.80, ropeEscapeAwareness: 0.80, lateralStrength: 0.65,
    kdRecovery1: 1.0, kdRecovery2: 1.0, kdRecovery3: 1.0, survivalInstinct: 0.90,
  },
};

const DIFFICULTY_LABELS: Record<Difficulty, string> = {
  journeyman: "Journeyman",
  contender: "Contender",
  elite: "Elite",
  champion: "Champion",
};

const DIFFICULTY_COLORS: Record<Difficulty, string> = {
  journeyman: "#22aa44",
  contender: "#ddaa00",
  elite: "#cc4400",
  champion: "#cc2222",
};

function loadSavedState(): Record<Difficulty, NeuralState> | null {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch { return null; }
}

function saveState(states: Record<Difficulty, NeuralState>) {
  localStorage.setItem(LS_KEY, JSON.stringify(states));
}

/**
 * Live overrides for AI training seeds, keyed by their synthetic roster id.
 * In memory only: a training population is a scratch experiment and must never
 * be written into the saved per-fighter neural store.
 */
let trainingNeural: Record<number, NeuralState> | null = null;

export function setTrainingNeuralOverrides(map: Record<number, NeuralState> | null) {
  trainingNeural = map;
}

/**
 * Set (or with null, remove) one training-range id's override without
 * touching the rest of the map. The RL trainer's learner uses this to box with
 * the Champion's own knobs while keeping its training identity.
 */
export function setTrainingNeuralOverride(id: number, state: NeuralState | null) {
  if (state) {
    trainingNeural = { ...(trainingNeural || {}), [id]: state };
  } else if (trainingNeural && trainingNeural[id]) {
    const next = { ...trainingNeural };
    delete next[id];
    trainingNeural = next;
  }
}

export function getNeuralOverrides(fighterId?: number): Record<Difficulty, NeuralState> {
  if (fighterId != null) {
    const training = trainingNeural?.[fighterId];
    if (training) {
      // Seeds only ever fight at champion difficulty; the rest of the record is
      // filled from the saved sets so nothing downstream reads an empty slot.
      const base = loadSavedState() || getEffectiveDefaults();
      return { ...base, champion: training };
    }
    const fighterState = loadFighterNeural(fighterId);
    if (fighterState) return fighterState;
  }
  // The "set as default" layer sits between the live graphs and the built-in
  // constants, and a promoted training seed writes it. Falling straight through
  // to DEFAULT_STATES here would mean a browser holding the trained defaults but
  // no live graphs still fought the shipped champion.
  return loadSavedState() || getEffectiveDefaults();
}

/**
 * Writes a trained seed's parameters into the Champion set, at every difficulty
 * that reads it — which is every mode with a champion AI, since they all resolve
 * their graphs through `getNeuralOverrides`.
 *
 * Both layers, deliberately. The live graphs are what the next bout reads; the
 * "set as default" snapshot is what the fallback above lands on when a browser
 * has no live graphs of its own. Writing only the live one would leave the
 * defaults still holding the shipped constants, so anything reaching for them
 * would quietly fight the untrained champion.
 *
 * There is deliberately no path back. The graph editor used to offer a
 * per-difficulty reset and a global wipe; both restored the built-in constants
 * over a promoted brain, which is the silent reversion this is meant to prevent.
 * A trained champion is replaced only by promoting another one.
 *
 * Both keys are already in the save-file tuning set and in the published
 * parameter bundle, so a promotion survives starting a new career, a save moved
 * to another browser, and a publish — until the next promotion replaces it.
 *
 * Merged over the existing record rather than replacing it: a seed derives one
 * knob (`perfectBlockIntent`) that the graph editor's fixed node list does not
 * draw, and spreading keeps it alongside the knobs the editor does.
 */
export function promoteToChampion(state: NeuralState) {
  const live = loadSavedState() || getEffectiveDefaults();
  saveState({ ...live, champion: { ...live.champion, ...state } });
  const defaults = getEffectiveDefaults();
  saveCustomDefaults({ ...defaults, champion: { ...defaults.champion, ...state } });
}

function loadAllFighterNeurals(): Record<number, Record<Difficulty, NeuralState>> {
  try {
    const raw = localStorage.getItem(LS_FIGHTER_NEURAL_KEY);
    if (!raw) return {};
    return JSON.parse(raw);
  } catch { return {}; }
}

function saveAllFighterNeurals(data: Record<number, Record<Difficulty, NeuralState>>) {
  localStorage.setItem(LS_FIGHTER_NEURAL_KEY, JSON.stringify(data));
}

function loadFighterNeural(fighterId: number): Record<Difficulty, NeuralState> | null {
  const all = loadAllFighterNeurals();
  return all[fighterId] || null;
}

function saveFighterNeural(fighterId: number, states: Record<Difficulty, NeuralState>) {
  const all = loadAllFighterNeurals();
  all[fighterId] = states;
  saveAllFighterNeurals(all);
}

function deleteFighterNeural(fighterId: number) {
  const all = loadAllFighterNeurals();
  delete all[fighterId];
  saveAllFighterNeurals(all);
}

export function fighterHasNeural(fighterId: number): boolean {
  return loadFighterNeural(fighterId) !== null;
}

interface NeuralPreset {
  name: string;
  states: Record<Difficulty, NeuralState>;
  createdAt: number;
}

function loadPresets(): NeuralPreset[] {
  try {
    const raw = localStorage.getItem(LS_PRESETS_KEY);
    if (!raw) return [];
    return JSON.parse(raw);
  } catch { return []; }
}

function savePresets(presets: NeuralPreset[]) {
  localStorage.setItem(LS_PRESETS_KEY, JSON.stringify(presets));
}

function loadCustomDefaults(): Record<Difficulty, NeuralState> | null {
  try {
    const raw = localStorage.getItem(LS_DEFAULTS_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch { return null; }
}

function saveCustomDefaults(defaults: Record<Difficulty, NeuralState>) {
  localStorage.setItem(LS_DEFAULTS_KEY, JSON.stringify(defaults));
}

function getEffectiveDefaults(): Record<Difficulty, NeuralState> {
  const custom = loadCustomDefaults();
  if (!custom) return JSON.parse(JSON.stringify(DEFAULT_STATES));
  return {
    journeyman: custom.journeyman || DEFAULT_STATES.journeyman,
    contender: custom.contender || DEFAULT_STATES.contender,
    elite: custom.elite || DEFAULT_STATES.elite,
    champion: custom.champion || DEFAULT_STATES.champion,
  };
}

const NEURAL_PARAM_IDS = NEURAL_PARAMS.map(p => p.id);
const DIFFICULTIES: Difficulty[] = ["journeyman", "contender", "elite", "champion"];
const XP_KEYS = Object.keys(DEFAULT_XP_CONFIG) as (keyof XpConfig)[];
/** Percentage swings rather than multipliers: -100 to 100. */
const BONUS_XP_KEYS = new Set<keyof XpConfig>([
  "statWlPrepBonus", "statWlIdleBonus", "statHbPrepBonus", "statHbIdleBonus",
  "statSparPrepBonus", "statSparIdleBonus",
  "xpWlPrepBonus", "xpWlIdleBonus", "xpHbPrepBonus", "xpHbIdleBonus",
  "xpSparPrepBonus", "xpSparIdleBonus",
]);
/** Probabilities, where 0 means "never" and is a real setting rather than a typo. */
const CHANCE_XP_KEYS = new Set<keyof XpConfig>([
  "careerOppGrowthChanceJourneyman", "careerOppGrowthChanceContender",
  "careerOppGrowthChanceElite", "careerOppGrowthChanceChampion",
]);
/** Signed level offsets: zero and negative both mean something here. */
const OFFSET_XP_KEYS = new Set<keyof XpConfig>([
  "careerOppGrowthFreezeGap", "careerOppGrowthCapOverPlayer",
]);

function validateNeuralDiffMap(obj: Record<string, unknown>, path: string): string | null {
  for (const diff of DIFFICULTIES) {
    if (!(diff in obj)) return `"${path}.${diff}" is missing.`;
    const ds = obj[diff];
    if (!ds || typeof ds !== "object" || Array.isArray(ds))
      return `"${path}.${diff}" must be an object, got ${JSON.stringify(ds)}.`;
    const state = ds as Record<string, unknown>;
    for (const pid of NEURAL_PARAM_IDS) {
      if (!(pid in state)) return `"${path}.${diff}.${pid}" is missing.`;
      const v = state[pid];
      if (typeof v !== "number" || !isFinite(v))
        return `"${path}.${diff}.${pid}" must be a number, got ${JSON.stringify(v)}.`;
      if (v < 0 || v > 1)
        return `"${path}.${diff}.${pid}" must be 0–1, got ${v}.`;
    }
  }
  return null;
}

function validateUploadData(data: unknown): string | null {
  if (!data || typeof data !== "object" || Array.isArray(data))
    return "Root must be a JSON object.";
  const d = data as Record<string, unknown>;

  if (d.version !== 1)
    return `"version" must be 1, got ${JSON.stringify(d.version)}.`;

  const validateXpSection = (section: unknown, name: string): string | null => {
    if (section === undefined) return null;
    if (!section || typeof section !== "object" || Array.isArray(section))
      return `"${name}" must be an object.`;
    const xp = section as Record<string, unknown>;
    for (const key of XP_KEYS) {
      // A key the file doesn't carry is not an error. Applying the section
      // merges it over the built-in defaults, so an absent key lands on its
      // default — which is what lets a file written by an older build still
      // upload after a new parameter has been added to this screen.
      if (!(key in xp)) continue;
      const v = xp[key];
      if (typeof v !== "number" || !isFinite(v))
        return `"${name}.${key}" must be a finite number, got ${JSON.stringify(v)}.`;
      if (BONUS_XP_KEYS.has(key)) {
        if (v < -100 || v > 100)
          return `"${name}.${key}" must be between -100 and 100, got ${v}.`;
      } else if (CHANCE_XP_KEYS.has(key)) {
        if (v < 0 || v > 1)
          return `"${name}.${key}" must be between 0 and 1, got ${v}.`;
      } else if (OFFSET_XP_KEYS.has(key)) {
        /* any finite offset, including 0 and negatives */
      } else if (v <= 0) {
        return `"${name}.${key}" must be greater than 0, got ${v}.`;
      }
    }
    return null;
  };

  const xpErr = validateXpSection(d.xpConfig, "xpConfig");
  if (xpErr) return xpErr;
  const xpDefErr = validateXpSection(d.xpDefaults, "xpDefaults");
  if (xpDefErr) return xpDefErr;

  if (d.neural !== undefined) {
    if (!d.neural || typeof d.neural !== "object" || Array.isArray(d.neural))
      return '"neural" must be an object.';
    const n = d.neural as Record<string, unknown>;

    if (n.states !== undefined) {
      if (!n.states || typeof n.states !== "object" || Array.isArray(n.states))
        return '"neural.states" must be an object.';
      const err = validateNeuralDiffMap(n.states as Record<string, unknown>, "neural.states");
      if (err) return err;
    }

    if (n.defaults !== undefined) {
      if (!n.defaults || typeof n.defaults !== "object" || Array.isArray(n.defaults))
        return '"neural.defaults" must be an object.';
      const err = validateNeuralDiffMap(n.defaults as Record<string, unknown>, "neural.defaults");
      if (err) return err;
    }

    if (n.presets !== undefined && !Array.isArray(n.presets))
      return '"neural.presets" must be an array.';

    if (n.fighterOverrides !== undefined) {
      if (!n.fighterOverrides || typeof n.fighterOverrides !== "object" || Array.isArray(n.fighterOverrides))
        return '"neural.fighterOverrides" must be an object.';
      const fo = n.fighterOverrides as Record<string, unknown>;
      for (const key of Object.keys(fo)) {
        if (!/^\d+$/.test(key))
          return `"neural.fighterOverrides" key "${key}" must be a numeric fighter ID.`;
        if (!fo[key] || typeof fo[key] !== "object" || Array.isArray(fo[key]))
          return `"neural.fighterOverrides.${key}" must be an object.`;
        const err = validateNeuralDiffMap(fo[key] as Record<string, unknown>, `neural.fighterOverrides.${key}`);
        if (err) return err;
      }
    }
  }

  return null;
}

const CATEGORIES = ["Personality", "Reaction", "Defense", "Offense", "Movement", "Resilience"];
const CAT_COLORS: Record<string, string> = {
  Personality: "#ff6b6b",
  Reaction: "#ffd93d",
  Defense: "#6bcb77",
  Offense: "#4d96ff",
  Movement: "#9b59b6",
  Resilience: "#e67e22",
};

interface NeuralNetworkViewProps {
  onBack: () => void;
  fighterId?: number;
  fighterName?: string;
  /**
   * Fired right after a Roster Generation save has rewritten every stored
   * career roster, so whoever opened this screen can pull the regenerated
   * numbers back into memory instead of waiting for a reload.
   */
  onRosterRegenerated?: () => void;
}

export default function NeuralNetworkView({ onBack, fighterId, fighterName, onRosterRegenerated }: NeuralNetworkViewProps) {
  const isFighterMode = fighterId != null;
  const [unlocked, setUnlocked] = useState(isFighterMode);
  const [pinInput, setPinInput] = useState("");
  const [pinError, setPinError] = useState(false);
  const [pinEntered, setPinEntered] = useState(false);
  const [activeDiff, setActiveDiff] = useState<Difficulty>("champion");
  const [states, setStates] = useState<Record<Difficulty, NeuralState>>(() => {
    if (isFighterMode) {
      const fighterState = loadFighterNeural(fighterId);
      if (fighterState) return JSON.parse(JSON.stringify(fighterState));
      const globalState = loadSavedState();
      return globalState || JSON.parse(JSON.stringify(DEFAULT_STATES));
    }
    const saved = loadSavedState();
    return saved || JSON.parse(JSON.stringify(DEFAULT_STATES));
  });
  const [hasPersonalNetwork, setHasPersonalNetwork] = useState(() => isFighterMode && loadFighterNeural(fighterId!) !== null);
  const [saved, setSaved] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [hoveredNode, setHoveredNode] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const nodePositionsRef = useRef<Map<string, { x: number; y: number; param: NeuralParam }>>(new Map());
  const containerRef = useRef<HTMLDivElement>(null);
  const [presets, setPresets] = useState<NeuralPreset[]>(() => loadPresets());
  const [showSavePreset, setShowSavePreset] = useState(false);
  const [showLoadPreset, setShowLoadPreset] = useState(false);
  const [soundsDlPct, setSoundsDlPct] = useState<number | null>(null);
  const [presetName, setPresetName] = useState("");
  const [defaultSet, setDefaultSet] = useState(false);
  const [deleted, setDeleted] = useState(false);
  const [nightmareBypass, setNightmareBypass] = useState(() => localStorage.getItem(LS_NIGHTMARE_BYPASS_KEY) === "true");
  const [refinementBypass, setRefinementBypass] = useState(() => localStorage.getItem(LS_REFINEMENT_BYPASS_KEY) === "true");
  const [directionalPb, setDirectionalPb] = useState(() => isDirectionalPerfectBlockEnabled());
  const [xpConfig, setXpConfig] = useState<XpConfig>(() => loadXpConfig());
  const [showSetDefaultConfirm, setShowSetDefaultConfirm] = useState(false);
  const [xpDefaultSaved, setXpDefaultSaved] = useState(false);
  const [xpUserDefaults, setXpUserDefaults] = useState<XpConfig>(() => loadXpDefaults());
  const [rcConfig, setRcConfig] = useState<RcConfig>(() => loadRcConfig());
  const [fatigueConfig, setFatigueConfig] = useState<FatigueConfig>(() => getFatigueConfig());
  const [maxStamConfig, setMaxStamConfig] = useState<MaxStamConfig>(() => getMaxStamConfig());
  const [turnConfig, setTurnConfig] = useState<TurnConfig>(() => getTurnConfig());
  const [aiRangeConfig, setAiRangeConfig] = useState<AiRangeConfig>(() => getAiRangeConfig());
  const [stoppageConfig, setStoppageConfig] = useState<StoppageConfig>(() => getStoppageConfig());
  const [aiPatternConfig, setAiPatternConfig] = useState<AiPatternConfig>(() => getAiPatternConfig());
  const [underTheHood, setUnderTheHood] = useState(() => isUnderTheHoodEnabled());
  const [showUploadZone, setShowUploadZone] = useState(false);
  const [uploadDragOver, setUploadDragOver] = useState(false);
  const [uploadStatus, setUploadStatus] = useState<"idle" | "success" | "error">("idle");
  const [uploadErrorMsg, setUploadErrorMsg] = useState("");
  const [showFightTipsEditor, setShowFightTipsEditor] = useState(false);
  const [showRosterGen, setShowRosterGen] = useState(false);
  const [testMode, setTestMode] = useState<null | "choose" | "normal" | "training">(null);
  const [showItemsEditor, setShowItemsEditor] = useState(false);
  const [showDocs, setShowDocs] = useState(false);
  const [fightTips, setFightTips] = useState<string[]>(() => getFightTips());
  const [tipDeleteConfirm, setTipDeleteConfirm] = useState<number | null>(null);
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const [paramStatus, setParamStatus] = useState<"idle" | "success" | "error">("idle");
  const [paramError, setParamError] = useState("");
  /** Bumped after an upload to remount the editors that hold their own copy. */
  const [paramEpoch, setParamEpoch] = useState(0);
  const paramInputRef = useRef<HTMLInputElement>(null);

  const updateXpField = <K extends keyof XpConfig>(key: K, raw: string) => {
    const val = parseFloat(raw);
    if (isNaN(val)) return;
    const next = { ...xpConfig, [key]: val };
    setXpConfig(next);
    saveXpConfig(next);
  };

  const resetXpConfig = () => {
    const def = loadXpDefaults();
    setXpConfig(def);
    saveXpConfig(def);
  };

  const updateRcField = <K extends keyof RcConfig>(key: K, raw: string) => {
    const val = parseFloat(raw);
    if (isNaN(val)) return;
    const next = { ...rcConfig, [key]: val };
    setRcConfig(next);
    saveRcConfig(next);
  };

  const resetRcConfigToDefaults = () => {
    setRcConfig({ ...DEFAULT_RC_CONFIG });
    saveRcConfig({ ...DEFAULT_RC_CONFIG });
  };

  const updateFatigueField = <K extends keyof FatigueConfig>(key: K, raw: string) => {
    const val = parseFloat(raw);
    if (isNaN(val)) return;
    const next = { ...fatigueConfig, [key]: val };
    setFatigueConfig(next);
    saveFatigueConfig(next);
  };

  const resetFatigueConfigToDefaults = () => {
    setFatigueConfig({ ...DEFAULT_FATIGUE_CONFIG });
    saveFatigueConfig({ ...DEFAULT_FATIGUE_CONFIG });
  };

  const commitMaxStam = (next: MaxStamConfig) => {
    setMaxStamConfig(next);
    saveMaxStamConfig(next);
  };

  // No clamping and no non-negative guard: the sign is the whole point of these
  // fields, and "-" on its own parses as NaN mid-typing, which the guard drops.
  // The edit lands in whichever unit set THIS event is reading, so the other one
  // is preserved and unticking the box brings the old number straight back.
  const updateMaxStamAmount = <K extends keyof MaxStamAmounts>(key: K, raw: string) => {
    const val = parseFloat(raw);
    if (isNaN(val)) return;
    const unit = maxStamConfig.usePoints[key] ? "points" : "percent";
    commitMaxStam({ ...maxStamConfig, [unit]: { ...maxStamConfig[unit], [key]: val } });
  };

  /** Flips one event between stamina points and percent, on its own. */
  const toggleMaxStamUnit = (key: keyof MaxStamAmounts, usePoints: boolean) => {
    commitMaxStam({ ...maxStamConfig, usePoints: { ...maxStamConfig.usePoints, [key]: usePoints } });
  };

  /** Switches one event off or back on, leaving both its numbers where they are. */
  const toggleMaxStamEnabled = (key: keyof MaxStamAmounts, enabled: boolean) => {
    commitMaxStam({ ...maxStamConfig, enabled: { ...maxStamConfig.enabled, [key]: enabled } });
  };

  /** The odds/interval fields, which mean the same thing in either unit. */
  const updateMaxStamTiming = <K extends "cleanHitChance" | "cleanStreakPunches" | "ringMileageInterval">(key: K, raw: string) => {
    const val = parseFloat(raw);
    if (isNaN(val)) return;
    commitMaxStam({ ...maxStamConfig, [key]: Math.max(0, val) });
  };

  const resetMaxStamConfig = () => commitMaxStam(cloneMaxStamDefaults());

  // Clamped on the way in as well as in the input's own min/max, since a typed
  // value can land outside the range the spinner enforces.
  const updateTurnDelay = (raw: string) => {
    const val = parseFloat(raw);
    if (isNaN(val)) return;
    const next: TurnConfig = { ...turnConfig, baseTurnDelay: Math.min(TURN_DELAY_MAX, Math.max(TURN_DELAY_MIN, val)) };
    setTurnConfig(next);
    saveTurnConfig(next);
  };

  // Signed, so no non-negative guard — but still clamped to the ±1s the inputs
  // advertise, since a typed value can land outside what the spinner enforces.
  const updateTurnEventField = (key: TurnEventKey, raw: string) => {
    const val = parseFloat(raw);
    if (isNaN(val)) return;
    const next: TurnConfig = { ...turnConfig, [key]: Math.min(TURN_EVENT_MAX, Math.max(TURN_EVENT_MIN, val)) };
    setTurnConfig(next);
    saveTurnConfig(next);
  };

  const resetTurnConfig = () => {
    setTurnConfig({ ...DEFAULT_TURN_CONFIG });
    saveTurnConfig({ ...DEFAULT_TURN_CONFIG });
  };

  // Clamped on the way in as well as in the input's own min/max: a typed value
  // can land outside the range the spinner enforces. The offset is signed, so it
  // gets no non-negative guard — a lone "-" mid-typing parses as NaN and drops out.
  const updateAiRangeField = <K extends keyof AiRangeConfig>(key: K, raw: string) => {
    const val = parseFloat(raw);
    if (isNaN(val)) return;
    const clamped = key === "baseDesiredDistancePx"
      ? Math.min(AI_RANGE_MAX_PX, Math.max(AI_RANGE_MIN_PX, val))
      : Math.min(AI_STAND_OFFSET_MAX_PX, Math.max(AI_STAND_OFFSET_MIN_PX, val));
    const next: AiRangeConfig = { ...aiRangeConfig, [key]: clamped };
    setAiRangeConfig(next);
    saveAiRangeConfig(next);
  };

  const resetAiRangeConfig = () => {
    setAiRangeConfig({ ...DEFAULT_AI_RANGE_CONFIG });
    saveAiRangeConfig({ ...DEFAULT_AI_RANGE_CONFIG });
  };

  // Clamped on the way in as well as by the input's own min/max: a typed value
  // can land outside the range the spinner enforces.
  const updateStoppageField = <K extends keyof StoppageConfig>(key: K, raw: string) => {
    const val = parseFloat(raw);
    if (isNaN(val)) return;
    const next: StoppageConfig = { ...stoppageConfig, [key]: clampStoppageField(key, val) };
    setStoppageConfig(next);
    saveStoppageConfig(next);
  };

  const resetStoppageConfig = () => {
    setStoppageConfig({ ...DEFAULT_STOPPAGE_CONFIG });
    saveStoppageConfig({ ...DEFAULT_STOPPAGE_CONFIG });
  };

  const updateAiPatternField = <K extends Exclude<keyof AiPatternConfig, "enabled">>(key: K, raw: string) => {
    const val = parseFloat(raw);
    if (isNaN(val)) return;
    const next: AiPatternConfig = { ...aiPatternConfig, [key]: clampAiPatternField(key, val) };
    setAiPatternConfig(next);
    saveAiPatternConfig(next);
  };

  const toggleAiPatterns = (on: boolean) => {
    const next: AiPatternConfig = { ...aiPatternConfig, enabled: on };
    setAiPatternConfig(next);
    saveAiPatternConfig(next);
  };

  const resetAiPatternConfig = () => {
    setAiPatternConfig({ ...DEFAULT_AI_PATTERN_CONFIG });
    saveAiPatternConfig({ ...DEFAULT_AI_PATTERN_CONFIG });
  };

  const confirmSetXpDefault = () => {
    saveXpDefaults(xpConfig);
    setXpUserDefaults({ ...xpConfig });
    setShowSetDefaultConfirm(false);
    setXpDefaultSaved(true);
    setTimeout(() => setXpDefaultSaved(false), 2000);
  };

  const downloadAllData = () => {
    const data = {
      version: 1,
      xpConfig: loadXpConfig(),
      xpDefaults: loadXpDefaults(),
      neural: {
        states: loadSavedState() || DEFAULT_STATES,
        defaults: loadCustomDefaults(),
        presets: loadPresets(),
        fighterOverrides: loadAllFighterNeurals(),
      },
    };
    const json = JSON.stringify(data, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `handz_data_${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleUploadData = (file: File) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      let data: unknown;
      try {
        data = JSON.parse(e.target?.result as string);
      } catch {
        setUploadStatus("error");
        setUploadErrorMsg("File is not valid JSON — check for missing commas, brackets, or quotes.");
        setTimeout(() => { setUploadStatus("idle"); setUploadErrorMsg(""); }, 5000);
        return;
      }

      const validationError = validateUploadData(data);
      if (validationError) {
        setUploadStatus("error");
        setUploadErrorMsg(validationError);
        setTimeout(() => { setUploadStatus("idle"); setUploadErrorMsg(""); }, 5000);
        return;
      }

      const d = data as Record<string, unknown>;
      if (d.xpConfig) {
        const merged = { ...DEFAULT_XP_CONFIG, ...(d.xpConfig as XpConfig) };
        saveXpConfig(merged);
        setXpConfig(merged);
      }
      if (d.xpDefaults) {
        const merged = { ...DEFAULT_XP_CONFIG, ...(d.xpDefaults as XpConfig) };
        saveXpDefaults(merged);
        setXpUserDefaults(merged);
      }
      const n = d.neural as Record<string, unknown> | undefined;
      if (n?.states) {
        const ns = n.states as Record<Difficulty, NeuralState>;
        saveState(ns);
        setStates(JSON.parse(JSON.stringify(ns)));
      }
      if (n?.defaults) saveCustomDefaults(n.defaults as Record<Difficulty, NeuralState>);
      if (n?.presets) { savePresets(n.presets as Preset[]); setPresets(n.presets as Preset[]); }
      if (n?.fighterOverrides) saveAllFighterNeurals(n.fighterOverrides as Record<number, Record<Difficulty, NeuralState>>);

      setUploadStatus("success");
      setShowUploadZone(false);
      setTimeout(() => setUploadStatus("idle"), 2500);
    };
    reader.readAsText(file);
  };

  /** Every parameter this screen and the editors it opens expose, as one file. */
  const downloadParameters = () => {
    const json = JSON.stringify(buildTuningBundle(), null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `handz_parameters_${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleParameterUpload = (file: File) => {
    const fail = (msg: string) => {
      setParamStatus("error");
      setParamError(msg);
      setTimeout(() => { setParamStatus("idle"); setParamError(""); }, 6000);
    };
    const reader = new FileReader();
    reader.onload = e => {
      let data: unknown;
      try {
        data = JSON.parse(e.target?.result as string);
      } catch {
        fail("File is not valid JSON — check for missing commas, brackets, or quotes.");
        return;
      }
      const invalid = validateTuningBundle(data);
      if (invalid) { fail(invalid); return; }

      applyTuningBundle(data as TuningBundle);
      invalidateNeuralParamCaches();

      // Everything this screen shows, re-read from what just landed.
      setStates(JSON.parse(JSON.stringify(loadSavedState() || DEFAULT_STATES)));
      setPresets(loadPresets());
      setXpConfig(loadXpConfig());
      setXpUserDefaults(loadXpDefaults());
      setRcConfig(loadRcConfig());
      setMaxStamConfig(getMaxStamConfig());
      setTurnConfig(getTurnConfig());
      setAiRangeConfig(getAiRangeConfig());
      setStoppageConfig(getStoppageConfig());
      setAiPatternConfig(loadAiPatternConfig());
      setFightTips(getFightTips());
      setNightmareBypass(localStorage.getItem(LS_NIGHTMARE_BYPASS_KEY) === "true");
      setRefinementBypass(localStorage.getItem(LS_REFINEMENT_BYPASS_KEY) === "true");
      setDirectionalPb(isDirectionalPerfectBlockEnabled());
      setParamEpoch(n => n + 1);
      void pushTuningDefaults();

      setParamStatus("success");
      setParamError("");
      setTimeout(() => setParamStatus("idle"), 2500);
    };
    reader.readAsText(file);
  };

  // A tweak anywhere on this screen becomes the default the next build ships.
  // Nothing to press: the watcher pushes the bundle whenever a value changes.
  useEffect(() => {
    if (isFighterMode || !unlocked) return;
    return startTuningDefaultsWatcher();
  }, [isFighterMode, unlocked]);

  const tryUnlock = () => {
    if (isValidPin(pinInput)) {
      setUnlocked(true);
      setPinError(false);
      if (pinInput === ADMIN_PIN) setPinEntered(true);
    } else {
      setPinError(true);
      setPinInput("");
    }
  };

  const downloadSourceCode = () => {
    const a = document.createElement("a");
    a.href = "/api/download-source?k=007342";
    a.download = "handz_source.tar.gz";
    a.click();
  };

  const currentState = states[activeDiff];

  const lastCanvasSize = useRef<{ w: number; h: number }>({ w: 0, h: 0 });

  const drawWeb = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (lastCanvasSize.current.w !== w || lastCanvasSize.current.h !== h) {
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      lastCanvasSize.current = { w, h };
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    ctx.fillStyle = "#0a0a0f";
    ctx.fillRect(0, 0, w, h);

    const cx = w / 2;
    const cy = h / 2;
    const maxR = Math.min(w, h) * 0.38;

    const n = NEURAL_PARAMS.length;
    const angleStep = (Math.PI * 2) / n;

    for (let ring = 1; ring <= 5; ring++) {
      const r = (ring / 5) * maxR;
      ctx.strokeStyle = `rgba(100, 120, 180, ${0.08 + ring * 0.03})`;
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      for (let i = 0; i <= n; i++) {
        const angle = i * angleStep - Math.PI / 2;
        const x = cx + Math.cos(angle) * r;
        const y = cy + Math.sin(angle) * r;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.stroke();
    }

    for (let i = 0; i < n; i++) {
      const angle = i * angleStep - Math.PI / 2;
      const x2 = cx + Math.cos(angle) * maxR;
      const y2 = cy + Math.sin(angle) * maxR;
      ctx.strokeStyle = "rgba(100, 120, 180, 0.12)";
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    }

    const diffColor = DIFFICULTY_COLORS[activeDiff];

    ctx.fillStyle = diffColor + "10";
    ctx.strokeStyle = diffColor + "90";
    ctx.lineWidth = 2;
    ctx.beginPath();
    const nodePositions = new Map<string, { x: number; y: number; param: NeuralParam }>();

    for (let i = 0; i < n; i++) {
      const param = NEURAL_PARAMS[i];
      const val = currentState[param.id] ?? 0.5;
      const angle = i * angleStep - Math.PI / 2;
      const r = val * maxR;
      const x = cx + Math.cos(angle) * r;
      const y = cy + Math.sin(angle) * r;
      nodePositions.set(param.id, { x, y, param });
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    const innerConnections: [number, number][] = [];
    for (let i = 0; i < n; i++) {
      for (let j = i + 2; j < n; j++) {
        if (j - i === n - 1) continue;
        const pi = NEURAL_PARAMS[i];
        const pj = NEURAL_PARAMS[j];
        if (pi.category === pj.category) {
          innerConnections.push([i, j]);
        }
      }
    }
    for (const [i, j] of innerConnections) {
      const pi = NEURAL_PARAMS[i];
      const pj = NEURAL_PARAMS[j];
      const posI = nodePositions.get(pi.id)!;
      const posJ = nodePositions.get(pj.id)!;
      const catColor = CAT_COLORS[pi.category] || "#888";
      ctx.strokeStyle = catColor + "25";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(posI.x, posI.y);
      ctx.lineTo(posJ.x, posJ.y);
      ctx.stroke();
    }

    for (let i = 0; i < n; i++) {
      const param = NEURAL_PARAMS[i];
      const pos = nodePositions.get(param.id)!;
      const catColor = CAT_COLORS[param.category] || "#888";
      const isHovered = hoveredNode === param.id;
      const isDragged = dragging === param.id;
      const nodeR = isHovered || isDragged ? 7 : 5;

      if (isHovered || isDragged) {
        ctx.fillStyle = catColor + "30";
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, 14, 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.fillStyle = catColor;
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = isHovered || isDragged ? 2 : 1;
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, nodeR, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      const angle = i * angleStep - Math.PI / 2;
      const labelR = maxR + 18;
      const lx = cx + Math.cos(angle) * labelR;
      const ly = cy + Math.sin(angle) * labelR;

      ctx.fillStyle = isHovered || isDragged ? "#ffffff" : "#8890aa";
      ctx.font = `${isHovered || isDragged ? "bold " : ""}10px sans-serif`;
      ctx.textAlign = Math.cos(angle) > 0.1 ? "left" : Math.cos(angle) < -0.1 ? "right" : "center";
      ctx.textBaseline = Math.sin(angle) > 0.1 ? "top" : Math.sin(angle) < -0.1 ? "bottom" : "middle";
      ctx.fillText(param.label, lx, ly);

      if (isHovered || isDragged) {
        const val = currentState[param.id] ?? 0.5;
        ctx.fillStyle = "#fff";
        ctx.font = "bold 11px sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "bottom";
        ctx.fillText(`${Math.round(val * 100)}%`, pos.x, pos.y - 12);
      }
    }

    nodePositionsRef.current = nodePositions;

    ctx.fillStyle = "#8890aa";
    ctx.font = "9px sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    let legendY = 10;
    for (const cat of CATEGORIES) {
      ctx.fillStyle = CAT_COLORS[cat];
      ctx.fillRect(8, legendY, 8, 8);
      ctx.fillStyle = "#8890aa";
      ctx.fillText(cat, 20, legendY);
      legendY += 14;
    }
  }, [currentState, activeDiff, hoveredNode, dragging]);

  useEffect(() => {
    if (!unlocked) return;
    drawWeb();
  }, [drawWeb, unlocked]);

  const getNodeAtPos = (mx: number, my: number): string | null => {
    for (const [id, pos] of nodePositionsRef.current) {
      const dx = mx - pos.x;
      const dy = my - pos.y;
      if (dx * dx + dy * dy < 200) return id;
    }
    return null;
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    if (dragging) {
      const cx = canvas.clientWidth / 2;
      const cy = canvas.clientHeight / 2;
      const maxR = Math.min(canvas.clientWidth, canvas.clientHeight) * 0.38;
      const idx = NEURAL_PARAMS.findIndex(p => p.id === dragging);
      if (idx < 0) return;
      const angleStep = (Math.PI * 2) / NEURAL_PARAMS.length;
      const angle = idx * angleStep - Math.PI / 2;
      const dx = mx - cx;
      const dy = my - cy;
      const projection = dx * Math.cos(angle) + dy * Math.sin(angle);
      const newVal = Math.min(1, Math.max(0.02, projection / maxR));

      setStates(prev => ({
        ...prev,
        [activeDiff]: { ...prev[activeDiff], [dragging]: Math.round(newVal * 100) / 100 },
      }));
      setSaved(false);
    } else {
      const node = getNodeAtPos(mx, my);
      setHoveredNode(node);
      canvas.style.cursor = node ? "grab" : "default";
    }
  };

  const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const node = getNodeAtPos(mx, my);
    if (node) {
      setDragging(node);
      canvas.style.cursor = "grabbing";
    }
  };

  const handleMouseUp = () => {
    setDragging(null);
    if (canvasRef.current) {
      canvasRef.current.style.cursor = hoveredNode ? "grab" : "default";
    }
  };

  const handleMouseLeave = () => {
    setDragging(null);
    setHoveredNode(null);
  };

  const saveNeuralState = () => {
    if (isFighterMode) {
      saveFighterNeural(fighterId!, states);
      setHasPersonalNetwork(true);
    } else {
      saveState(states);
    }
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const deletePersonalNetwork = () => {
    if (!isFighterMode) return;
    deleteFighterNeural(fighterId!);
    setHasPersonalNetwork(false);
    const globalState = loadSavedState() || JSON.parse(JSON.stringify(DEFAULT_STATES));
    setStates(JSON.parse(JSON.stringify(globalState)));
    setDeleted(true);
    setTimeout(() => setDeleted(false), 2000);
  };

  const setAsDefault = () => {
    if (isFighterMode) return;
    const current = loadCustomDefaults() || JSON.parse(JSON.stringify(DEFAULT_STATES));
    current[activeDiff] = { ...states[activeDiff] };
    saveCustomDefaults(current);
    setDefaultSet(true);
    setTimeout(() => setDefaultSet(false), 2000);
  };

  const saveAllAsPreset = () => {
    if (!presetName.trim()) return;
    const preset: NeuralPreset = {
      name: presetName.trim(),
      states: JSON.parse(JSON.stringify(states)),
      createdAt: Date.now(),
    };
    const updated = [...presets, preset];
    setPresets(updated);
    savePresets(updated);
    setPresetName("");
    setShowSavePreset(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const loadPresetByIndex = (idx: number) => {
    const preset = presets[idx];
    if (!preset) return;
    setStates(JSON.parse(JSON.stringify(preset.states)));
    if (isFighterMode) {
      saveFighterNeural(fighterId!, preset.states);
      setHasPersonalNetwork(true);
    } else {
      saveState(preset.states);
    }
    setShowLoadPreset(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const deletePresetByIndex = (idx: number) => {
    const updated = presets.filter((_, i) => i !== idx);
    setPresets(updated);
    savePresets(updated);
  };

  // Gated on `unlocked` like every other subview: these early returns sit above
  // the PIN check, so one without it would render straight past the gate.
  if (testMode === "normal" && unlocked) {
    return <NeuralTestFight onExit={() => setTestMode(null)} />;
  }

  if (testMode === "training" && unlocked) {
    return <AiTrainingView onExit={() => setTestMode(null)} />;
  }

  if (showDocs && unlocked) {
    return <GameDocsView onBack={() => setShowDocs(false)} />;
  }

  if (showItemsEditor && unlocked) {
    return <ItemsEditorView onBack={() => setShowItemsEditor(false)} />;
  }

  if (showRosterGen && unlocked) {
    return (
      <RosterGenerationView
        onBack={() => setShowRosterGen(false)}
        onSaved={() => {
          // Apply the new generation ranges to every existing career roster
          // (levels, stats, refinements regenerated per rank; records kept).
          for (const f of localSaves.getFighters()) {
            const rs = f.careerRosterState as CareerRosterState | null;
            if (!rs || !Array.isArray(rs.roster) || rs.roster.length === 0) continue;
            const seed = f.name ? f.name.split("").reduce((a, c) => a + c.charCodeAt(0), 0) : 1;
            const updated = regenerateRosterNumbers(rs, seed + rs.weekNumber);
            localSaves.updateFighter(f.id, { careerRosterState: updated } as any);
          }
          // Push the regenerated rosters back into the live career state —
          // without this the screens keep rendering (and re-saving) the numbers
          // from before the edit until the game is reloaded.
          onRosterRegenerated?.();
        }}
      />
    );
  }

  if (showFightTipsEditor && unlocked) {
    const updateTip = (i: number, val: string) => {
      const updated = [...fightTips];
      updated[i] = val;
      setFightTips(updated);
      saveFightTips(updated);
    };
    const addTipAfter = (i: number) => {
      if (fightTips.length >= 100) return;
      const updated = [...fightTips.slice(0, i + 1), "", ...fightTips.slice(i + 1)];
      setFightTips(updated);
      saveFightTips(updated);
      setTipDeleteConfirm(null);
    };
    const removeTip = (i: number) => {
      const updated = fightTips.filter((_, j) => j !== i);
      setFightTips(updated);
      saveFightTips(updated);
      setTipDeleteConfirm(null);
    };

    return (
      <div className="flex flex-col items-center gap-3 p-4 max-w-2xl mx-auto">
        <div className="flex items-center gap-3 w-full">
          <Button variant="ghost" size="icon" onClick={() => { setShowFightTipsEditor(false); setTipDeleteConfirm(null); }} data-testid="button-back-fight-tips">
            <ArrowLeft className="w-5 h-5" />
          </Button>
          <h2 className="text-xl font-bold flex-1">Fight Tips</h2>
          <span className="text-sm text-muted-foreground">{fightTips.length} / 100</span>
        </div>

        <p className="text-xs text-muted-foreground w-full">
          Tips appear randomly on the Simulate Week screen (2 tips) and Career Hub (1 tip). Each tip has an equal <strong>{fightTips.length > 0 ? Math.round(100 / fightTips.length) : 0}%</strong> chance of being chosen. A tip is guaranteed to appear once you have at least 20 tips. Shown tips are hidden for 3 simulated weeks (simulate screen) or 20 hub visits (career hub).
        </p>

        <div className="flex flex-col gap-3 w-full">
          {fightTips.length === 0 && (
            <div className="text-center py-8 text-muted-foreground">
              <Lightbulb className="w-8 h-8 mx-auto mb-2 opacity-30" />
              <p className="text-sm">No tips yet. Add your first tip below.</p>
              <Button className="mt-3 gap-2" onClick={() => { const u = [""]; setFightTips(u); saveFightTips(u); }} data-testid="button-add-first-tip">
                <Plus className="w-4 h-4" /> Add First Tip
              </Button>
            </div>
          )}
          {fightTips.map((tip, i) => (
            <Card key={i} className="p-2 w-full space-y-1.5" style={{ background: "#0a0a14", border: "1px solid #222244" }}>
              <textarea
                value={tip}
                onChange={e => updateTip(i, e.target.value)}
                placeholder="Enter a fight tip…"
                rows={2}
                className="w-full bg-transparent text-sm text-white placeholder:text-muted-foreground resize-none outline-none p-1 rounded"
                data-testid={`textarea-tip-${i}`}
              />
              <div className="flex gap-1.5">
                {fightTips.length < 100 && (
                  <Button size="sm" variant="outline" className="text-xs h-6 gap-1 px-2" onClick={() => addTipAfter(i)} data-testid={`button-add-tip-after-${i}`}>
                    <Plus className="w-3 h-3" /> Add below
                  </Button>
                )}
                {tipDeleteConfirm === i ? (
                  <>
                    <Button size="sm" variant="destructive" className="text-xs h-6 px-2" onClick={() => removeTip(i)} data-testid={`button-confirm-remove-tip-${i}`}>
                      Confirm
                    </Button>
                    <Button size="sm" variant="outline" className="text-xs h-6 px-2" onClick={() => setTipDeleteConfirm(null)} data-testid={`button-cancel-remove-tip-${i}`}>
                      Cancel
                    </Button>
                  </>
                ) : (
                  <Button size="sm" variant="outline" className="text-xs h-6 gap-1 px-2 text-destructive border-destructive/30 hover:bg-destructive/10" onClick={() => setTipDeleteConfirm(i)} data-testid={`button-remove-tip-${i}`}>
                    <Minus className="w-3 h-3" /> Remove
                  </Button>
                )}
              </div>
            </Card>
          ))}
          {fightTips.length > 0 && fightTips.length < 100 && (
            <Button variant="outline" className="w-full gap-2" onClick={() => { const u = [...fightTips, ""]; setFightTips(u); saveFightTips(u); }} data-testid="button-add-tip-end">
              <Plus className="w-4 h-4" /> Add Tip
            </Button>
          )}
          {fightTips.length >= 100 && (
            <p className="text-xs text-center text-muted-foreground">Maximum 100 tips reached.</p>
          )}
        </div>
      </div>
    );
  }

  if (!unlocked) {
    return (
      <div className="flex flex-col items-center gap-4 p-4 max-w-lg mx-auto">
        <div className="flex items-center gap-3 w-full">
          <Button variant="ghost" size="icon" onClick={() => onBack()} data-testid="button-back-neural">
            <ArrowLeft className="w-5 h-5" />
          </Button>
          <h2 className="text-xl font-bold flex-1">Neural Network</h2>
        </div>
        <Card className="p-8 w-full text-center space-y-4">
          <Lock className="w-12 h-12 mx-auto text-muted-foreground" />
          <h3 className="text-lg font-bold">Admin Access Required</h3>
          <p className="text-sm text-muted-foreground">Enter your admin or career PIN to access neural network parameters.</p>
          <div className="flex gap-2 justify-center items-center">
            <Input
              type="password"
              maxLength={4}
              value={pinInput}
              onChange={e => {
                setPinInput(e.target.value.replace(/\D/g, ""));
                setPinError(false);
              }}
              onKeyDown={e => { if (e.key === "Enter") tryUnlock(); }}
              placeholder="PIN"
              className="w-24 text-center tracking-widest"
              data-testid="input-neural-pin"
            />
            <Button onClick={tryUnlock} data-testid="button-neural-unlock">Unlock</Button>
          </div>
          {pinError && <p className="text-xs text-destructive">Incorrect PIN</p>}
        </Card>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="flex flex-col items-center gap-3 p-4 max-w-2xl mx-auto">
      <div className="flex items-center gap-3 w-full">
        <Button variant="ghost" size="icon" onClick={() => onBack()} data-testid="button-back-neural">
          <ArrowLeft className="w-5 h-5" />
        </Button>
        <div className="flex-1">
          <h2 className="text-xl font-bold">{isFighterMode ? `${fighterName || "Fighter"} Neural Net` : "Neural Network"}</h2>
          {isFighterMode && (
            <p className="text-xs text-muted-foreground">
              {hasPersonalNetwork ? "Personal network active" : "Using global network (no personal override)"}
            </p>
          )}
        </div>
      </div>
      <Card className="p-3 w-full" style={{ background: "#0a1a0a", border: "1px solid #1a4a1a" }}>
        <label className="flex items-start gap-2 cursor-pointer" data-testid="toggle-under-the-hood">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={underTheHood}
            onChange={e => {
              setUnderTheHood(e.target.checked);
              setUnderTheHoodEnabled(e.target.checked);
            }}
          />
          <span>
            <span className="text-xs font-semibold block" style={{ color: "#c8ffaa" }}>Under the Hood</span>
            <span className="text-[10px] block" style={{ color: "#66aa66" }}>
              Overlays the last {PATTERN_HUD_MAX} combinations the AI has memorized off you in the top right of the fight screen, and marks the one it is answering. Display only — it changes nothing about the fight.
            </span>
          </span>
        </label>
      </Card>
      {/* Solid backing so the outline buttons stay readable over any career ring colour behind the menu. */}
      <Card className="p-3 w-full space-y-2" style={{ background: "#0a0a0f" }} data-testid="card-neural-actions">
      <Button
        variant="outline"
        className="w-full gap-2"
        onClick={() => setShowDocs(true)}
        data-testid="button-game-docs"
      >
        <BookOpen className="w-4 h-4" /> Docs
      </Button>
      {!isFighterMode && (
        <div className="w-full space-y-1">
          <div className="flex gap-2 w-full">
            <Button
              variant="outline"
              className="flex-1 gap-2"
              onClick={downloadParameters}
              data-testid="button-download-parameters"
            >
              <Download className="w-4 h-4" /> Download Parameters
            </Button>
            <Button
              variant="outline"
              className="flex-1 gap-2"
              onClick={() => paramInputRef.current?.click()}
              data-testid="button-upload-parameters"
              style={paramStatus === "error" ? { borderColor: "#a33", color: "#ff9999" } : undefined}
            >
              <Upload className="w-4 h-4" />
              {paramStatus === "success" ? "Loaded!" : paramStatus === "error" ? "Error" : "Upload Parameters"}
            </Button>
            <input
              ref={paramInputRef}
              type="file"
              accept=".json,application/json"
              className="hidden"
              onChange={e => {
                const file = e.target.files?.[0];
                if (file) handleParameterUpload(file);
                e.target.value = "";
              }}
              data-testid="input-upload-parameters"
            />
          </div>
          {paramError && (
            <p className="text-[11px]" style={{ color: "#ff9999" }} data-testid="text-parameter-upload-error">{paramError}</p>
          )}
        </div>
      )}
      {!isFighterMode && (
        <div className="flex gap-2 w-full">
          <Button
            variant="outline"
            className="flex-1 gap-2"
            onClick={() => setShowRosterGen(true)}
            data-testid="button-roster-generation"
          >
            <Users className="w-4 h-4" /> Roster Generation
          </Button>
          <Button
            variant="outline"
            className="flex-1 gap-2"
            onClick={() => setShowFightTipsEditor(true)}
            data-testid="button-fight-tips"
          >
            <Lightbulb className="w-4 h-4" /> Fight Tips
          </Button>
          <Button
            variant="outline"
            className="flex-1 gap-2"
            onClick={() => setShowItemsEditor(true)}
            data-testid="button-items-editor"
          >
            <Package className="w-4 h-4" /> Items
          </Button>
        </div>
      )}
      <Button
        variant="outline"
        className="w-full gap-2"
        onClick={() => setTestMode("choose")}
        data-testid="button-test-fight"
      >
        <Swords className="w-4 h-4" /> Test.
      </Button>
      </Card>
      {testMode === "choose" && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
          onClick={() => setTestMode(null)}
          data-testid="overlay-test-mode"
        >
          <Card
            className="w-full max-w-md space-y-3 p-5"
            style={{ background: "#0a0a0f" }}
            onClick={e => e.stopPropagation()}
          >
            <div className="text-sm font-semibold text-white">Test</div>
            <Button
              variant="outline"
              className="h-auto w-full flex-col items-start gap-1 py-3 text-left"
              onClick={() => setTestMode("normal")}
              data-testid="button-test-normal"
            >
              <span className="font-semibold">Normal Test</span>
              <span className="text-xs font-normal text-white/50">
                One endless throwaway bout with both corners fully editable.
              </span>
            </Button>
            <Button
              variant="outline"
              className="h-auto w-full flex-col items-start gap-1 py-3 text-left"
              onClick={() => setTestMode("training")}
              data-testid="button-test-training"
            >
              <span className="font-semibold">AI Training</span>
              <span className="text-xs font-normal text-white/50">
                Evolve a population of boxers on the fundamentals, then promote the
                winner into the Champion AI.
              </span>
            </Button>
          </Card>
        </div>
      )}
      <PunchAnimEditor key={`anim-${paramEpoch}`} />
      <Card className="p-3 w-full" style={{ background: "#0a0a0f" }}>
        <canvas
          ref={canvasRef}
          className="w-full"
          style={{ height: "420px", cursor: "default" }}
          onMouseMove={handleMouseMove}
          onMouseDown={handleMouseDown}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseLeave}
          data-testid="canvas-neural-web"
        />
      </Card>
      <div className="flex gap-2 w-full">
        {(["journeyman", "contender", "elite", "champion"] as Difficulty[]).map(diff => (
          <Button
            key={diff}
            variant={activeDiff === diff ? "default" : "outline"}
            className="flex-1 text-xs"
            style={activeDiff === diff ? { backgroundColor: DIFFICULTY_COLORS[diff], color: "#fff", borderColor: DIFFICULTY_COLORS[diff] } : { borderColor: DIFFICULTY_COLORS[diff], color: DIFFICULTY_COLORS[diff] }}
            onClick={() => setActiveDiff(diff)}
            data-testid={`button-diff-${diff}`}
          >
            {DIFFICULTY_LABELS[diff]}
          </Button>
        ))}
      </div>
      <div className="flex gap-2 w-full">
        {!isFighterMode && (
          <Button onClick={setAsDefault} className="flex-1 gap-2" variant="outline" data-testid="button-set-default-neural">
            <Star className="w-4 h-4" /> {defaultSet ? "Default Set!" : `Set ${DIFFICULTY_LABELS[activeDiff]} Default`}
          </Button>
        )}
        {isFighterMode && hasPersonalNetwork && (
          <Button variant="destructive" onClick={deletePersonalNetwork} className="flex-1 gap-2" data-testid="button-delete-fighter-neural">
            <Trash2 className="w-4 h-4" /> {deleted ? "Reset to Global!" : "Delete Personal Network"}
          </Button>
        )}
      </div>
      <div className="flex gap-2 w-full">
        <Button onClick={saveNeuralState} className="flex-1 gap-2" data-testid="button-save-neural">
          <Save className="w-4 h-4" /> {saved ? "Saved!" : isFighterMode ? "Save Personal Network" : "Save Active State"}
        </Button>
      </div>
      <div className="flex gap-2 w-full">
        <Button variant="outline" onClick={() => { setShowSavePreset(!showSavePreset); setShowLoadPreset(false); }} className="flex-1 gap-2" data-testid="button-save-all-networks">
          <Download className="w-4 h-4" /> Save All Networks
        </Button>
        <Button variant="outline" onClick={() => { setShowLoadPreset(!showLoadPreset); setShowSavePreset(false); }} className="flex-1 gap-2" data-testid="button-load-networks">
          <Upload className="w-4 h-4" /> Load Networks
        </Button>
      </div>
      <div className="flex gap-2 w-full">
        <Button variant="outline" onClick={downloadAllData} className="flex-1 gap-2" data-testid="button-download-all-data">
          <Download className="w-4 h-4" /> Download Data
        </Button>
        <Button
          variant="outline"
          onClick={() => setShowUploadZone(v => !v)}
          className="flex-1 gap-2"
          style={uploadStatus === "success" ? { borderColor: "#22aa44", color: "#22aa44" } : uploadStatus === "error" ? { borderColor: "#cc2222", color: "#cc2222" } : {}}
          data-testid="button-upload-data"
        >
          <Upload className="w-4 h-4" />
          {uploadStatus === "success" ? "Loaded!" : uploadStatus === "error" ? "Error" : "Upload Data"}
        </Button>
      </div>
      {showUploadZone && (
        <Card className="p-3 w-full space-y-2">
          <input
            ref={uploadInputRef}
            type="file"
            accept=".json"
            className="hidden"
            onChange={e => { if (e.target.files?.[0]) handleUploadData(e.target.files[0]); }}
            data-testid="input-upload-file"
          />
          <div
            className="rounded-md p-6 text-center cursor-pointer select-none transition-colors"
            style={{
              border: `2px dashed ${uploadDragOver ? "#4a9eff" : "#334466"}`,
              background: uploadDragOver ? "#0a1a2a" : "transparent",
            }}
            onDragOver={e => { e.preventDefault(); setUploadDragOver(true); }}
            onDragLeave={() => setUploadDragOver(false)}
            onDrop={e => {
              e.preventDefault();
              setUploadDragOver(false);
              const file = e.dataTransfer.files?.[0];
              if (file) handleUploadData(file);
            }}
            onClick={() => uploadInputRef.current?.click()}
            data-testid="zone-upload-data"
          >
            <Upload className="w-6 h-6 mx-auto mb-2 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">Drop JSON here, or click to browse</p>
            {uploadStatus === "error" && (
              <p className="text-xs text-destructive mt-2">{uploadErrorMsg}</p>
            )}
          </div>
        </Card>
      )}
      <div className="flex gap-2 w-full">
        <Button
          variant="outline"
          className="flex-1 gap-2"
          disabled={soundsDlPct !== null}
          onClick={async () => {
            setSoundsDlPct(0);
            try {
              await downloadAllSounds((pct) => setSoundsDlPct(pct));
            } finally {
              setSoundsDlPct(null);
            }
          }}
          data-testid="button-download-sounds"
        >
          <Music className="w-4 h-4" />
          {soundsDlPct !== null ? `Downloading… ${soundsDlPct}%` : "Download Sounds & Music"}
        </Button>
      </div>
      {pinEntered && (
        <div className="flex flex-col gap-2 w-full">
          <Card className="p-3 w-full" style={{ background: "#1a0a0a", border: "1px solid #7a1414" }}>
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-sm font-semibold text-[#ffd1d1]">Nightmare Mode Bypass</p>
                <p className="text-[10px] text-[#ffb3b3]">Removes rank 50 &amp; fight-week requirements</p>
              </div>
              <Button
                size="sm"
                variant={nightmareBypass ? "destructive" : "outline"}
                onClick={() => {
                  const next = !nightmareBypass;
                  localStorage.setItem(LS_NIGHTMARE_BYPASS_KEY, String(next));
                  setNightmareBypass(next);
                }}
                data-testid="button-nightmare-bypass-toggle"
                style={nightmareBypass ? {} : { borderColor: "#7a1414", color: "#ffd1d1" }}
              >
                {nightmareBypass ? "ON" : "OFF"}
              </Button>
            </div>
          </Card>
          <Card className="p-3 w-full" style={{ background: "#0a1a0f", border: "1px solid #1a7a3a" }}>
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-sm font-semibold text-[#d1ffd1]">Skill Refinement Bypass</p>
                <p className="text-[10px] text-[#b3ffb3]">Unlocks all refinement tracks on all saves — no fight or SP cost required</p>
              </div>
              <Button
                size="sm"
                variant={refinementBypass ? "default" : "outline"}
                onClick={() => {
                  const next = !refinementBypass;
                  localStorage.setItem(LS_REFINEMENT_BYPASS_KEY, String(next));
                  setRefinementBypass(next);
                }}
                data-testid="button-refinement-bypass-toggle"
                style={refinementBypass ? { background: "#1a7a3a", borderColor: "#1a7a3a" } : { borderColor: "#1a7a3a", color: "#d1ffd1" }}
              >
                {refinementBypass ? "ON" : "OFF"}
              </Button>
            </div>
          </Card>
          <Card className="p-3 w-full" style={{ background: "#0a0f1a", border: "1px solid #1a4a7a" }}>
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-sm font-semibold text-[#d1e8ff]">Directional Perfect Block</p>
                <p className="text-[10px] text-[#b3d4ff]">Perfect block only stops punches thrown from the same posture — standing blocks standing, ducking blocks ducking. Off = a perfect block stops anything.</p>
              </div>
              <Button
                size="sm"
                variant={directionalPb ? "default" : "outline"}
                onClick={() => {
                  const next = !directionalPb;
                  localStorage.setItem(LS_DIRECTIONAL_PB_KEY, String(next));
                  setDirectionalPb(next);
                }}
                data-testid="button-directional-perfect-block-toggle"
                style={directionalPb ? { background: "#1a5a9a", borderColor: "#1a5a9a" } : { borderColor: "#1a4a7a", color: "#d1e8ff" }}
              >
                {directionalPb ? "ON" : "OFF"}
              </Button>
            </div>
          </Card>
          <div className="flex-1 flex flex-col gap-0.5">
            <Button
              variant="outline"
              onClick={downloadSourceCode}
              className="w-full gap-2"
              data-testid="button-download-source"
              title="Includes client/src, server, shared, config files. Excludes node_modules, dist, .git."
            >
              <Download className="w-4 h-4" /> Download Source Code
            </Button>
            <p className="text-xs text-center" style={{ color: "#5a7aaa" }}>
              Includes source (client, server, shared, config) + BUILD_INFO.txt · Excludes node_modules, dist, .git
            </p>
          </div>
          <Card className="p-3 w-full space-y-3" style={{ background: "#0a0f1a", border: "1px solid #1a2a4a" }}>
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm font-semibold text-[#aac8ff]">XP Multipliers</p>
              <div className="flex gap-1">
                <Button size="sm" variant="outline" onClick={resetXpConfig} className="text-xs h-7 px-2" data-testid="button-reset-xp-config" title="Reset to saved defaults">
                  <RotateCcw className="w-3 h-3 mr-1" /> Reset
                </Button>
                <Button size="sm" variant="outline" onClick={() => setShowSetDefaultConfirm(v => !v)} className="text-xs h-7 px-2" style={{ borderColor: "#4a6aaa", color: "#aac8ff" }} data-testid="button-set-xp-default">
                  <Star className="w-3 h-3 mr-1" /> {xpDefaultSaved ? "Saved!" : "Set Default"}
                </Button>
              </div>
            </div>
            {showSetDefaultConfirm && (
              <div className="rounded-md p-2 space-y-2" style={{ background: "#0d1a2e", border: "1px solid #2a4a7a" }}>
                <p className="text-xs text-[#aac8ff]">Save current multipliers as defaults?</p>
                <div className="flex gap-2">
                  <Button size="sm" onClick={confirmSetXpDefault} className="flex-1 h-7 text-xs" style={{ background: "#1a3a6a", color: "#fff" }} data-testid="button-confirm-xp-default">
                    Confirm
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setShowSetDefaultConfirm(false)} className="flex-1 h-7 text-xs" data-testid="button-cancel-xp-default">
                    Cancel
                  </Button>
                </div>
              </div>
            )}
            <p className="text-[10px] text-[#6688aa]">Career Fights</p>
            {(
              [
                { key: "boutBase", label: "Bout Base (1.x per fight)" },
                { key: "careerMult", label: "Career Multiplier" },
                { key: "finalDoubler", label: "Final Doubler" },
                { key: "champBonus", label: "Champion Win Bonus" },
                { key: "endgameMult", label: "Endgame Mult (lvl 100+)" },
                { key: "preChampMult", label: "Pre-Champ Mult" },
                { key: "accMult50", label: "Accuracy ≥50% Mult" },
                { key: "accMult60", label: "Accuracy ≥60% Mult" },
                { key: "accMult65", label: "Accuracy ≥65% Mult" },
                { key: "accMult70", label: "Accuracy ≥70% Mult" },
                { key: "accMult75", label: "Accuracy ≥75% Mult" },
              ] as { key: keyof XpConfig; label: string }[]
            ).map(({ key, label }) => (
              <div key={key} className="flex items-center gap-2">
                <span className="text-xs text-[#aac8ff] flex-1">{label}</span>
                <Input
                  type="number"
                  step="0.01"
                  min="0"
                  value={xpConfig[key]}
                  onChange={e => updateXpField(key, e.target.value)}
                  className="w-24 h-7 text-xs text-right"
                  data-testid={`input-xp-${key}`}
                />
              </div>
            ))}
            <p className="text-[10px] text-[#6688aa] pt-1">Training (per career win)</p>
            {(
              [
                { key: "sparWinBase", label: "Sparring Per-Win Base" },
                { key: "trainWinBase", label: "Weight/Bag Per-Win Base" },
              ] as { key: keyof XpConfig; label: string }[]
            ).map(({ key, label }) => (
              <div key={key} className="flex items-center gap-2">
                <span className="text-xs text-[#aac8ff] flex-1">{label}</span>
                <Input
                  type="number"
                  step="0.01"
                  min="0"
                  value={xpConfig[key]}
                  onChange={e => updateXpField(key, e.target.value)}
                  className="w-24 h-7 text-xs text-right"
                  data-testid={`input-xp-${key}`}
                />
              </div>
            ))}
            <p className="text-[10px] text-[#6688aa] pt-1">XP Week Bonuses (%)</p>
            {(
              [
                { key: "xpWlPrepBonus", label: "WL Prep Week XP %" },
                { key: "xpWlIdleBonus", label: "WL Idle Week XP %" },
                { key: "xpHbPrepBonus", label: "Heavy Bag Prep Week XP %" },
                { key: "xpHbIdleBonus", label: "Heavy Bag Idle Week XP %" },
                { key: "xpSparPrepBonus", label: "Sparring Prep Week XP %" },
                { key: "xpSparIdleBonus", label: "Sparring Idle Week XP %" },
              ] as { key: keyof XpConfig; label: string }[]
            ).map(({ key, label }) => (
              <div key={key} className="flex items-center gap-2">
                <span className="text-xs text-[#aac8ff] flex-1">{label}</span>
                <Input
                  type="number"
                  step="1"
                  min="-100"
                  max="100"
                  value={xpConfig[key]}
                  onChange={e => updateXpField(key, e.target.value)}
                  className="w-24 h-7 text-xs text-right"
                  data-testid={`input-xp-${key}`}
                />
              </div>
            ))}
          </Card>
          <Card className="shadcn-card rounded-xl border border-card-border text-card-foreground shadow-sm p-3 w-full space-y-3 bg-[#ffffff]">
            <p className="text-sm font-semibold text-[#000000]">Career Official Bout Multipliers</p>
            <p className="text-[10px] text-[#6688aa]">Applied to official career bouts only (0.1× – 100×, default 1×). Autosaved.</p>
            <p className="text-[10px] font-semibold pt-1 text-[#000000]">AI Opponent</p>
            {(
              [
                { key: "careerOpponentMult", label: "Base Stamina Multiplier" },
                { key: "careerOpponentPowerMult", label: "Power Multiplier" },
                { key: "careerOpponentSpeedMult", label: "Speed Multiplier" },
              ] as { key: keyof XpConfig; label: string }[]
            ).map(({ key, label }) => (
              <div key={key} className="flex items-center gap-2">
                <span className="text-xs text-[#aac8ff] flex-1">{label}</span>
                <Input
                  type="number"
                  step="0.01"
                  min="0.01"
                  max="100"
                  value={xpConfig[key]}
                  onChange={e => updateXpField(key, e.target.value)}
                  className="w-24 h-7 text-xs text-right"
                  data-testid={`input-xp-${key}`}
                />
              </div>
            ))}
            <p className="text-[10px] font-semibold pt-1 text-[#000000]">Player</p>
            {(
              [
                { key: "careerPlayerMult", label: "Base Stamina Multiplier" },
                { key: "careerPlayerPowerMult", label: "Power Multiplier" },
                { key: "careerPlayerSpeedMult", label: "Speed Multiplier" },
              ] as { key: keyof XpConfig; label: string }[]
            ).map(({ key, label }) => (
              <div key={key} className="flex items-center gap-2">
                <span className="text-xs text-[#aac8ff] flex-1">{label}</span>
                <Input
                  type="number"
                  step="0.01"
                  min="0.01"
                  max="100"
                  value={xpConfig[key]}
                  onChange={e => updateXpField(key, e.target.value)}
                  className="w-24 h-7 text-xs text-right"
                  data-testid={`input-xp-${key}`}
                />
              </div>
            ))}
          </Card>
          <Card className="shadcn-card rounded-xl border border-card-border text-card-foreground shadow-sm p-3 w-full space-y-3 bg-[#ffffff]">
            <p className="text-sm font-semibold text-[#000000]">Career Selected Opponent Level Growth</p>
            <p className="text-[10px] text-[#6688aa]">How fast the opponent you have selected gains levels between weeks. Frozen while they sit further than the gap above you, and never taken past your level plus the cap. Autosaved.</p>
            <p className="text-[10px] font-semibold pt-1 text-[#000000]">Weekly Level-Up Chance (0–1)</p>
            {(
              [
                { key: "careerOppGrowthChanceJourneyman", label: "Journeyman" },
                { key: "careerOppGrowthChanceContender", label: "Contender" },
                { key: "careerOppGrowthChanceElite", label: "Elite" },
                { key: "careerOppGrowthChanceChampion", label: "Champion" },
              ] as { key: keyof XpConfig; label: string }[]
            ).map(({ key, label }) => (
              <div key={key} className="flex items-center gap-2">
                <span className="text-xs text-[#aac8ff] flex-1">{label}</span>
                <Input
                  type="number"
                  step="0.01"
                  min="0"
                  max="1"
                  value={xpConfig[key]}
                  onChange={e => updateXpField(key, e.target.value)}
                  className="w-24 h-7 text-xs text-right"
                  data-testid={`input-xp-${key}`}
                />
              </div>
            ))}
            <p className="text-[10px] font-semibold pt-1 text-[#000000]">Bounds (levels)</p>
            {(
              [
                { key: "careerOppGrowthFreezeGap", label: "Freeze When Ahead By" },
                { key: "careerOppGrowthCapOverPlayer", label: "Level Cap Over Player" },
              ] as { key: keyof XpConfig; label: string }[]
            ).map(({ key, label }) => (
              <div key={key} className="flex items-center gap-2">
                <span className="text-xs text-[#aac8ff] flex-1">{label}</span>
                <Input
                  type="number"
                  step="1"
                  min="-1000"
                  max="1000"
                  value={xpConfig[key]}
                  onChange={e => updateXpField(key, e.target.value)}
                  className="w-24 h-7 text-xs text-right"
                  data-testid={`input-xp-${key}`}
                />
              </div>
            ))}
          </Card>
          <Card className="p-3 w-full space-y-3" style={{ background: "#0a0f1a", border: "1px solid #1a2a4a" }}>
            <p className="text-sm font-semibold text-[#aac8ff]">Stat Points</p>
            <p className="text-[10px] text-[#6688aa]">Per-Type Multiplier</p>
            {(
              [
                { key: "statBoutMult", label: "Career Bout Mult" },
                { key: "statWlMult", label: "Weight Lifting Mult" },
                { key: "statSparMult", label: "Sparring Mult" },
                { key: "statHbMult", label: "Heavy Bag Mult" },
              ] as { key: keyof XpConfig; label: string }[]
            ).map(({ key, label }) => (
              <div key={key} className="flex items-center gap-2">
                <span className="text-xs text-[#aac8ff] flex-1">{label}</span>
                <Input
                  type="number"
                  step="0.01"
                  min="0"
                  value={xpConfig[key]}
                  onChange={e => updateXpField(key, e.target.value)}
                  className="w-24 h-7 text-xs text-right"
                  data-testid={`input-xp-${key}`}
                />
              </div>
            ))}
            <p className="text-[10px] text-[#6688aa] pt-1">+X Stat per Y Reps Bonus</p>
            <div className="flex items-center gap-2">
              <span className="text-xs text-[#aac8ff] flex-1">WL: +X per Y reps</span>
              <Input
                type="number" step="1" min="1"
                value={xpConfig.statWlBonusX}
                onChange={e => updateXpField("statWlBonusX", e.target.value)}
                className="w-16 h-7 text-xs text-right"
                data-testid="input-xp-statWlBonusX"
                placeholder="X"
              />
              <Input
                type="number" step="1" min="1"
                value={xpConfig.statWlBonusY}
                onChange={e => updateXpField("statWlBonusY", e.target.value)}
                className="w-16 h-7 text-xs text-right"
                data-testid="input-xp-statWlBonusY"
                placeholder="Y"
              />
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-[#aac8ff] flex-1">Spar: +X per Y punches</span>
              <Input
                type="number" step="1" min="1"
                value={xpConfig.statSparBonusX}
                onChange={e => updateXpField("statSparBonusX", e.target.value)}
                className="w-16 h-7 text-xs text-right"
                data-testid="input-xp-statSparBonusX"
                placeholder="X"
              />
              <Input
                type="number" step="1" min="1"
                value={xpConfig.statSparBonusY}
                onChange={e => updateXpField("statSparBonusY", e.target.value)}
                className="w-16 h-7 text-xs text-right"
                data-testid="input-xp-statSparBonusY"
                placeholder="Y"
              />
            </div>
            <p className="text-[10px] text-[#6688aa] pt-1">Prep / Idle Week Stat Bonus (%)</p>
            {(
              [
                { key: "statWlPrepBonus", label: "WL Prep Week %" },
                { key: "statWlIdleBonus", label: "WL Idle Week %" },
                { key: "statHbPrepBonus", label: "Heavy Bag Prep Week %" },
                { key: "statHbIdleBonus", label: "Heavy Bag Idle Week %" },
                { key: "statSparPrepBonus", label: "Sparring Prep Week %" },
                { key: "statSparIdleBonus", label: "Sparring Idle Week %" },
              ] as { key: keyof XpConfig; label: string }[]
            ).map(({ key, label }) => (
              <div key={key} className="flex items-center gap-2">
                <span className="text-xs text-[#aac8ff] flex-1">{label}</span>
                <Input
                  type="number"
                  step="1"
                  min="-100"
                  max="100"
                  value={xpConfig[key]}
                  onChange={e => updateXpField(key, e.target.value)}
                  className="w-24 h-7 text-xs text-right"
                  data-testid={`input-xp-${key}`}
                />
              </div>
            ))}
          </Card>
          <Card className="p-3 w-full space-y-3" style={{ background: "#0a1a0a", border: "1px solid #1a4a1a" }}>
            <div className="flex items-center justify-between gap-2">
              <div>
                <p className="text-sm font-semibold" style={{ color: "#c8ffaa" }}>Max Stamina Events</p>
                <p className="text-[10px]" style={{ color: "#66aa66" }}>Every rule that moves a fighter's max stamina mid-fight — negative subtracts, positive adds</p>
              </div>
              <Button size="sm" variant="outline" onClick={resetMaxStamConfig} className="text-xs h-7 px-2" data-testid="button-reset-max-stam-config" style={{ borderColor: "#1a7a1a", color: "#c8ffaa" }}>
                <RotateCcw className="w-3 h-3 mr-1" /> Reset
              </Button>
            </div>
            <p className="text-[10px]" style={{ color: "#66aa66" }}>Applies to whichever fighter the event happens to, player or AI. Set 0 to switch a rule off. Gains stop at the pool that fighter started the bout with.</p>
            <p className="text-[11px] leading-tight rounded px-2 py-1.5" style={{ background: "#0d240d", color: "#c8ffaa" }}>
              Every event carries its own two boxes, so they can be weighted against each other individually.
              <span className="block text-[10px]" style={{ color: "#66aa66" }}>
                <strong style={{ color: "#c8ffaa" }}>Left box</strong> — whether the event happens at all. Untick it and the rule never fires; its numbers are kept for when you tick it back on.
              </span>
              <span className="block text-[10px]" style={{ color: "#66aa66" }}>
                <strong style={{ color: "#c8ffaa" }}>pts box</strong> — ticked, the amount is a flat number of stamina points, the same for a big tank and a small one. Unticked, it's a % of the pool that fighter started the bout with, so everyone pays proportionally. Each unit keeps its own number per event, so ticking back and forth loses nothing.
              </span>
            </p>
            {(
              [
                {
                  group: "Punches taken", rows: [
                    { key: "cleanHitTaken", label: "Clean punch taken (rolled)" },
                    { key: "cleanStreakTaken", label: "Clean punch streak payout" },
                    { key: "stunTaken", label: "Stunned" },
                    { key: "rhythmCutHit", label: "Rhythm cut taken" },
                    { key: "rhythmCutFightCap", label: "Most all rhythm cuts can take in one bout" },
                  ],
                },
                {
                  group: "Own work", rows: [
                    { key: "perfectBlock", label: "Perfect block landed" },
                    { key: "ringMileage", label: "Per movement interval" },
                    { key: "chargedPunchThrown", label: "Charged punch thrown" },
                    { key: "chargedCritRefund", label: "Charged punch crits or stuns" },
                    { key: "resetPanic", label: "Reset pressed while still rocked (panic)" },
                  ],
                },
                {
                  group: "Knockdowns & the bell", rows: [
                    { key: "knockdownSurvived", label: "Got up from a knockdown" },
                    { key: "roundEndBase", label: "End of every round" },
                    { key: "roundEndLostRound", label: "…and the round was lost" },
                    { key: "roundEndPerKd", label: "…per knockdown that round" },
                    { key: "roundEndPer50Punches", label: "…per 50 punches thrown that round" },
                  ],
                },
              ] as { group: string; rows: { key: keyof MaxStamAmounts; label: string }[] }[]
            ).map(({ group, rows }) => (
              <div key={group} className="space-y-2">
                <p className="text-[10px] uppercase tracking-wide pt-1" style={{ color: "#4d8a4d" }}>{group}</p>
                {rows.map(({ key, label }) => {
                  const on = maxStamConfig.enabled[key] !== false;
                  const pts = maxStamConfig.usePoints[key];
                  return (
                    <div key={key} className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={e => toggleMaxStamEnabled(key, e.target.checked)}
                        className="h-3.5 w-3.5 shrink-0 cursor-pointer accent-[#66cc66]"
                        title={on ? "This event is live — untick to switch it off" : "Switched off — tick to bring it back"}
                        data-testid={`toggle-maxstam-enabled-${key}`}
                      />
                      <span
                        className="text-xs flex-1"
                        style={{ color: on ? "#c8ffaa" : "#4d7a4d", textDecoration: on ? "none" : "line-through" }}
                      >
                        {label}
                      </span>
                      <Input
                        type="number"
                        disabled={!on}
                        step={pts ? "0.5" : "0.05"}
                        min={pts ? "-999" : "-100"}
                        max={pts ? "999" : "100"}
                        value={activeMaxStamAmounts(maxStamConfig)[key]}
                        onChange={e => updateMaxStamAmount(key, e.target.value)}
                        className="w-24 h-7 text-xs text-right disabled:opacity-40"
                        data-testid={`input-maxstam-${key}`}
                      />
                      <label
                        className="flex items-center gap-1 w-9 shrink-0 cursor-pointer"
                        title={pts ? "Stamina points — untick for a % of the bout-start pool" : "% of the bout-start pool — tick for flat stamina points"}
                      >
                        <input
                          type="checkbox"
                          checked={pts}
                          onChange={e => toggleMaxStamUnit(key, e.target.checked)}
                          className="h-3 w-3 shrink-0 cursor-pointer accent-[#66cc66]"
                          data-testid={`toggle-maxstam-unit-${key}`}
                        />
                        <span className="text-[10px]" style={{ color: "#66aa66" }}>{pts ? "pts" : "%"}</span>
                      </label>
                    </div>
                  );
                })}
              </div>
            ))}
            <p className="text-[10px] uppercase tracking-wide pt-1" style={{ color: "#4d8a4d" }}>Odds &amp; intervals</p>
            <p className="text-[10px] -mt-1" style={{ color: "#66aa66" }}>How often three of the events above come round. No boxes of their own: they follow the event they belong to, and switching that event off switches them off with it.</p>
            {(
              [
                { key: "cleanHitChance", label: "Clean punch taken — odds it charges", unit: "%", step: "1" },
                { key: "cleanStreakPunches", label: "Clean punches taken per streak payout", unit: "hits", step: "1" },
                { key: "ringMileageInterval", label: "Seconds of movement per payout", unit: "s", step: "1" },
              ] as { key: "cleanHitChance" | "cleanStreakPunches" | "ringMileageInterval"; label: string; unit: string; step: string }[]
            ).map(({ key, label, unit, step }) => (
              <div key={key} className="flex items-center gap-2">
                <span className="text-xs flex-1" style={{ color: "#c8ffaa" }}>{label}</span>
                <Input
                  type="number" step={step} min="0" max={key === "cleanHitChance" ? "100" : "999"}
                  value={maxStamConfig[key]}
                  onChange={e => updateMaxStamTiming(key, e.target.value)}
                  className="w-24 h-7 text-xs text-right"
                  data-testid={`input-maxstam-${key}`}
                />
                <span className="text-[10px] w-6" style={{ color: "#66aa66" }}>{unit}</span>
              </div>
            ))}
          </Card>
          <RefinementTuningCard key={`refine-${paramEpoch}`} />
          <RlPolicyCard key={`rl-${paramEpoch}`} />
          <Card className="p-3 w-full space-y-3" style={{ background: "#0a1a0a", border: "1px solid #1a4a1a" }}>
            <div className="flex items-center justify-between gap-2">
              <div>
                <p className="text-sm font-semibold" style={{ color: "#c8ffaa" }}>Turn Delay</p>
                <p className="text-[10px]" style={{ color: "#66aa66" }}>Seconds a fighter needs to turn all the way around (180°)</p>
              </div>
              <Button size="sm" variant="outline" onClick={resetTurnConfig} className="text-xs h-7 px-2" data-testid="button-reset-turn-config" style={{ borderColor: "#1a7a1a", color: "#c8ffaa" }}>
                <RotateCcw className="w-3 h-3 mr-1" /> Reset
              </Button>
            </div>
            <p className="text-[10px]" style={{ color: "#66aa66" }}>Applies to both corners. 0.00 turns instantly, 10.00 is the slowest. Stun's turn penalty is added on top, and a punch thrown before the body is squared up misses.</p>
            <div className="flex items-center gap-2">
              <span className="text-xs flex-1" style={{ color: "#c8ffaa" }}>Base turn delay (seconds)</span>
              <Input
                type="number" step="0.01" min={TURN_DELAY_MIN} max={TURN_DELAY_MAX}
                value={turnConfig.baseTurnDelay}
                onChange={e => updateTurnDelay(e.target.value)}
                className="w-24 h-7 text-xs text-right"
                data-testid="input-turn-base-delay"
              />
            </div>
            <p className="text-[10px]" style={{ color: "#66aa66" }}>Seconds each event adds to (positive) or takes off (negative) that fighter's own turn delay, −1.00 to +1.00. They stack for the rest of the round and reset at the bell; no amount of reduction turns a fighter faster than instant.</p>
            {(
              [
                { key: "punchLanded", label: "Punch landed (blocks count)" },
                { key: "punchTaken", label: "Punch taken (blocks count)" },
                { key: "perfectBlock", label: "Perfect block landed" },
                { key: "critTaken", label: "Crit taken" },
                { key: "dodge", label: "Punch dodged (dodger)" },
                { key: "punchDodged", label: "Punch dodged (thrower)" },
                { key: "whiffClose", label: "Punch whiffed within 90px" },
                { key: "knockdownTaken", label: "Knocked down" },
              ] as { key: TurnEventKey; label: string }[]
            ).map(({ key, label }) => (
              <div key={key} className="flex items-center gap-2">
                <span className="text-xs flex-1" style={{ color: "#c8ffaa" }}>{label}</span>
                <Input
                  type="number" step="0.001" min={TURN_EVENT_MIN} max={TURN_EVENT_MAX}
                  value={turnConfig[key]}
                  onChange={e => updateTurnEventField(key, e.target.value)}
                  className="w-24 h-7 text-xs text-right"
                  data-testid={`input-turn-${key}`}
                />
              </div>
            ))}
          </Card>
          <Card className="p-3 w-full space-y-3" style={{ background: "#0a1a0a", border: "1px solid #1a4a1a" }}>
            <div className="flex items-center justify-between gap-2">
              <div>
                <p className="text-sm font-semibold" style={{ color: "#c8ffaa" }}>AI Punch Distance</p>
                <p className="text-[10px]" style={{ color: "#66aa66" }}>The gap the AI wants to hold before it opens up</p>
              </div>
              <Button size="sm" variant="outline" onClick={resetAiRangeConfig} className="text-xs h-7 px-2" data-testid="button-reset-ai-range-config" style={{ borderColor: "#1a7a1a", color: "#c8ffaa" }}>
                <RotateCcw className="w-3 h-3 mr-1" /> Reset
              </Button>
            </div>
            <p className="text-[10px]" style={{ color: "#66aa66" }}>Its base desired punching distance, in pixels ({AI_RANGE_MIN_PX} to {AI_RANGE_MAX_PX}). Default 52.5; a jab from a 65" arm reaches about 85px. Lower crowds the opponent, higher keeps the fight long. The AI still moves off this for the phase it is in, its class, and what it learns about its own reach during the bout — and picks the new number up on its next fight.</p>
            <div className="flex items-center gap-2">
              <span className="text-xs flex-1" style={{ color: "#c8ffaa" }}>Base desired distance (px)</span>
              <Input
                type="number" step="0.5" min={AI_RANGE_MIN_PX} max={AI_RANGE_MAX_PX}
                value={aiRangeConfig.baseDesiredDistancePx}
                onChange={e => updateAiRangeField("baseDesiredDistancePx", e.target.value)}
                className="w-24 h-7 text-xs text-right"
                data-testid="input-ai-range-base"
              />
            </div>
            <p className="text-[10px]" style={{ color: "#66aa66" }}>How much further out the AI stands than the distance it just worked out, in pixels ({AI_STAND_OFFSET_MIN_PX} to {AI_STAND_OFFSET_MAX_PX}). Positive backs it off, negative walks it in. This one is added last, after phase, class and everything the AI has learnt about its own reach, so the whole shift always lands.</p>
            <div className="flex items-center gap-2">
              <span className="text-xs flex-1" style={{ color: "#c8ffaa" }}>Extra standing distance (px)</span>
              <Input
                type="number" step="1" min={AI_STAND_OFFSET_MIN_PX} max={AI_STAND_OFFSET_MAX_PX}
                value={aiRangeConfig.standDistanceOffsetPx}
                onChange={e => updateAiRangeField("standDistanceOffsetPx", e.target.value)}
                className="w-24 h-7 text-xs text-right"
                data-testid="input-ai-range-stand-offset"
              />
            </div>
          </Card>
          <Card className="p-3 w-full space-y-3" style={{ background: "#0a1a0a", border: "1px solid #1a4a1a" }}>
            <div className="flex items-center justify-between gap-2">
              <div>
                <p className="text-sm font-semibold" style={{ color: "#c8ffaa" }}>Rhythm Cut Parameters</p>
                <p className="text-[10px]" style={{ color: "#66aa66" }}>Controls AI timing autocorrect for rhythm sway window</p>
              </div>
              <Button size="sm" variant="outline" onClick={resetRcConfigToDefaults} className="text-xs h-7 px-2" data-testid="button-reset-rc-config" style={{ borderColor: "#1a7a1a", color: "#c8ffaa" }}>
                <RotateCcw className="w-3 h-3 mr-1" /> Reset
              </Button>
            </div>
            <p className="text-[10px]" style={{ color: "#66aa66" }}>Trigger Chance per Difficulty (0 = off, 1 = always)</p>
            {(
              [
                { key: "chanceJourneyman", label: "Journeyman" },
                { key: "chanceContender", label: "Contender" },
                { key: "chanceElite", label: "Elite" },
                { key: "chanceChampion", label: "Champion" },
              ] as { key: keyof RcConfig; label: string }[]
            ).map(({ key, label }) => (
              <div key={key} className="flex items-center gap-2">
                <span className="text-xs flex-1" style={{ color: "#c8ffaa" }}>{label} Chance</span>
                <Input
                  type="number" step="0.01" min="0" max="1"
                  value={rcConfig[key]}
                  onChange={e => updateRcField(key, e.target.value)}
                  className="w-24 h-7 text-xs text-right"
                  data-testid={`input-rc-${key}`}
                />
              </div>
            ))}
            <p className="text-[10px] pt-1" style={{ color: "#66aa66" }}>Approach Delay Range (seconds) — used when player heading toward window</p>
            {(
              [
                { key: "delayMinSec", label: "Delay Min (s)" },
                { key: "delayMaxSec", label: "Delay Max (s)" },
              ] as { key: keyof RcConfig; label: string }[]
            ).map(({ key, label }) => (
              <div key={key} className="flex items-center gap-2">
                <span className="text-xs flex-1" style={{ color: "#c8ffaa" }}>{label}</span>
                <Input
                  type="number" step="0.005" min="0" max="1"
                  value={rcConfig[key]}
                  onChange={e => updateRcField(key, e.target.value)}
                  className="w-24 h-7 text-xs text-right"
                  data-testid={`input-rc-${key}`}
                />
              </div>
            ))}
            <p className="text-[10px] pt-1" style={{ color: "#66aa66" }}>Learned Correction Clamp Range (seconds) — limits how much timing EMA can shift</p>
            {(
              [
                { key: "speedupMinSec", label: "Correction Min (s)" },
                { key: "speedupMaxSec", label: "Correction Max (s)" },
              ] as { key: keyof RcConfig; label: string }[]
            ).map(({ key, label }) => (
              <div key={key} className="flex items-center gap-2">
                <span className="text-xs flex-1" style={{ color: "#c8ffaa" }}>{label}</span>
                <Input
                  type="number" step="0.005" min="0" max="1"
                  value={rcConfig[key]}
                  onChange={e => updateRcField(key, e.target.value)}
                  className="w-24 h-7 text-xs text-right"
                  data-testid={`input-rc-${key}`}
                />
              </div>
            ))}
            <p className="text-[10px] pt-1" style={{ color: "#66aa66" }}>Vulnerable Window — swayOffset units in from each END of the arc (±5) that count as the hit window</p>
            <div className="flex items-center gap-2">
              <span className="text-xs flex-1" style={{ color: "#c8ffaa" }}>Half-width (swayOffset units)</span>
              <Input
                type="number" step="0.1" min="0.1" max="5"
                value={rcConfig.vulnerableWindowHalf}
                onChange={e => updateRcField("vulnerableWindowHalf", e.target.value)}
                className="w-24 h-7 text-xs text-right"
                data-testid="input-rc-vulnerableWindowHalf"
              />
            </div>
          </Card>
          <Card className="p-3 w-full space-y-3" style={{ background: "#0a1a0a", border: "1px solid #1a4a1a" }}>
            <div className="flex items-center justify-between gap-2">
              <div>
                <p className="text-sm font-semibold" style={{ color: "#c8ffaa" }}>Energy Fatigue &amp; Reset</p>
                <p className="text-[10px]" style={{ color: "#66aa66" }}>Punches taken drain Energy; the inertia sway carries every penalty. Reset (B) snaps the stance clean.</p>
              </div>
              <Button size="sm" variant="outline" onClick={resetFatigueConfigToDefaults} className="text-xs h-7 px-2" data-testid="button-reset-fatigue-config" style={{ borderColor: "#1a7a1a", color: "#c8ffaa" }}>
                <RotateCcw className="w-3 h-3 mr-1" /> Reset
              </Button>
            </div>
            <p className="text-[10px]" style={{ color: "#66aa66" }}>Applies to both corners. Edits are live in the next bout.</p>
            {(
              [
                { heading: "Energy Drain — punches taken into Energy, Energy into stamina", rows: [
                  { key: "freePunches", label: "Free Punches (before any drain)", step: "1" },
                  { key: "energyBaseCost", label: "Energy per Punch Taken", step: "1" },
                  { key: "energyEscalation", label: "Energy Escalation per Consecutive", step: "0.5" },
                  { key: "energyEscalationCap", label: "Energy Escalation Cap", step: "1" },
                  { key: "energyPerStaminaStep", label: "Energy per Stamina Step", step: "1" },
                  { key: "staminaPerStep", label: "Stamina per Step", step: "1" },
                  { key: "staminaEscalation", label: "Stamina Escalation per Consecutive", step: "0.5" },
                  { key: "staminaEscalationCap", label: "Stamina Escalation Cap", step: "1" },
                ] },
                { heading: "Inertia Sway — the lag that carries the penalties", rows: [
                  { key: "swayTimeMin", label: "Sway Length Min (s)", step: "0.01" },
                  { key: "swayTimeMax", label: "Sway Length Max (s)", step: "0.01" },
                  { key: "swayTimeCapPunches", label: "Sway Length Cap (punches taken)", step: "10" },
                  { key: "swayDistFracOfSlip", label: "Sway Travel (share of a full slip)", step: "0.05" },
                  { key: "swayDistRampMax", label: "Sway Travel Ramp Ceiling", step: "0.05" },
                  { key: "armLagFrac", label: "Forearm Lag (share of sway)", step: "0.05" },
                  { key: "armStaggerFrac", label: "Rear Forearm Extra Lag", step: "0.05" },
                ] },
                { heading: "Penalties — what being gassed actually costs", rows: [
                  { key: "guardSlowMax", label: "Guard Raise Slow Max", step: "0.05" },
                  { key: "guardSlowCapPunches", label: "Guard Slow Cap (punches taken)", step: "10" },
                  { key: "punchSlowMax", label: "Punch Launch/Retract Slow Max", step: "0.05" },
                  { key: "punchSlowCapPunches", label: "Punch Slow Cap (punches taken)", step: "10" },
                  { key: "swayBlockIneffective", label: "Block Effectiveness Lost in Sway", step: "0.05" },
                  { key: "swayInputGate", label: "Punch Input Gate (arm sway progress)", step: "0.05" },
                  { key: "swayMissAdd", label: "Added Miss Chance Punching in Sway", step: "0.05" },
                  { key: "swayDamageDebuff", label: "Damage Lost Punching in Sway", step: "0.05" },
                  { key: "duckLagPerHit", label: "Duck Lag per Punch Taken (s)", step: "0.01" },
                  { key: "duckLagMax", label: "Duck Lag Cap (s)", step: "0.05" },
                  { key: "vulnPerHit", label: "Rhythm Vuln Added per Punch Taken (arc share, each end)", step: "0.005" },
                ] },
                { heading: "Reset (B) — the answer to fatigue", rows: [
                  { key: "resetEffectMult", label: "Fatigue Strength During Window", step: "0.05" },
                  { key: "resetSnapSlowPerPunch", label: "Snap Slowed per Punch Taken, Career Bouts (share)", step: "0.0025" },
                  { key: "resetSnapSlowGraceHits", label: "Punches Owed After a Reset Before It Slows Again", step: "1" },
                  { key: "resetStunLockMax", label: "Stun Locks Reset Out at Defense 0 (s)", step: "0.5" },
                  { key: "resetStunLockMin", label: "Stun Locks Reset Out at Max Defense (s)", step: "0.1" },
                  { key: "stunLockBlinkWindow", label: "Stun Lockout Double-Blink Window (s)", step: "0.05" },
                  { key: "resetBlinkQuietMax", label: "Eyes Held Open After a Full Reset, 0 Punches Taken (s)", step: "1" },
                  { key: "resetBlinkQuietMin", label: "Eyes Held Open After a Full Reset, at the Punch Cap (s)", step: "0.5" },
                  { key: "resetBlinkQuietCapPunches", label: "Punches Taken That Reach the Short Hold", step: "10" },
                ] },
                { heading: "Reaction Flinch — hands dragged out of the guard", rows: [
                  { key: "flinchRangePx", label: "Flinch Range (px)", step: "5" },
                  { key: "flinchBasePx", label: "Flinch Travel (px)", step: "1" },
                  { key: "flinchDuration", label: "Flinch Length (s)", step: "0.05" },
                  { key: "flinchDecayPerReaction", label: "Intensity Lost per Reaction", step: "0.01" },
                  { key: "flinchResetNegateWindow", label: "Reset Negates the Next Flinch For (s)", step: "0.1" },
                  { key: "flinchFeintRatioLimit", label: "Feints per Committed Punch (same punch & stance)", step: "1" },
                  { key: "resetSnapStagger", label: "Snap Stagger (s)", step: "0.01" },
                  { key: "resetSnapSpeedMult", label: "Snap Animation Speed (x)", step: "0.1" },
                  { key: "resetSnapDistMult", label: "Snap Travel Distance (x)", step: "0.25" },
                  { key: "resetSnapSlowMax", label: "Snap Stagger Stretch at 0 Stamina", step: "0.1" },
                  { key: "resetRhythmBurst", label: "Rhythm Burst on Reset (s at full sway speed)", step: "0.25" },
                  { key: "resetHeadDuckTime", label: "Head Dip Time (s)", step: "0.05" },
                  { key: "resetHeadDuckPx", label: "Head Dip Depth (px)", step: "1" },
                  { key: "resetFarRegenMult", label: "Stamina Recovery Out of the Pocket (x)", step: "0.25" },
                  { key: "resetFarDistancePx", label: "Out-of-Pocket Distance (px)", step: "5" },
                  { key: "resetPanicWindow", label: "Panic Reset Window After a Hit (s)", step: "0.5" },
                  { key: "resetPanicFloor", label: "Panic Bite Floor (share of base)", step: "0.05" },
                ] },
              ] as { heading: string; rows: { key: keyof FatigueConfig; label: string; step: string }[] }[]
            ).map(({ heading, rows }) => (
              <div key={heading} className="space-y-1">
                <p className="text-[10px] pt-1" style={{ color: "#66aa66" }}>{heading}</p>
                {rows.map(({ key, label, step }) => (
                  <div key={key} className="flex items-center gap-2">
                    <span className="text-xs flex-1" style={{ color: "#c8ffaa" }}>{label}</span>
                    <Input
                      type="number" step={step} min="0"
                      value={fatigueConfig[key]}
                      onChange={e => updateFatigueField(key, e.target.value)}
                      className="w-24 h-7 text-xs text-right"
                      data-testid={`input-fatigue-${key}`}
                    />
                  </div>
                ))}
              </div>
            ))}
          </Card>
          <Card className="p-3 w-full space-y-3" style={{ background: "#0a1a0a", border: "1px solid #1a4a1a" }}>
            <div className="flex items-center justify-between gap-2">
              <div>
                <p className="text-sm font-semibold" style={{ color: "#c8ffaa" }}>Ref &amp; Towel Stoppage</p>
                <p className="text-[10px]" style={{ color: "#66aa66" }}>How one-sided a fight has to get before someone ends it</p>
              </div>
              <Button size="sm" variant="outline" onClick={resetStoppageConfig} className="text-xs h-7 px-2" data-testid="button-reset-stoppage-config" style={{ borderColor: "#1a7a1a", color: "#c8ffaa" }}>
                <RotateCcw className="w-3 h-3 mr-1" /> Reset
              </Button>
            </div>
            <p className="text-[10px]" style={{ color: "#66aa66" }}>Never applies in practice or sparring, and both rules can still be switched off per fight. Edits are live in the next bout.</p>

            <p className="text-[10px] pt-1 font-semibold" style={{ color: "#8fdc6a" }}>REF STOPPAGE — waved off while the opponent is down</p>
            <p className="text-[10px]" style={{ color: "#66aa66" }}>Only considered on these knockdowns (the opponent's 2nd and 3rd by default). Outside the window the ref lets it go on.</p>
            {(
              [
                { key: "mercyMinKds", label: "From knockdown #", step: "1" },
                { key: "mercyMaxKds", label: "Up to knockdown #", step: "1" },
              ] as { key: keyof StoppageConfig; label: string; step: string }[]
            ).map(({ key, label, step }) => (
              <div key={key} className="flex items-center gap-2">
                <span className="text-xs flex-1" style={{ color: "#c8ffaa" }}>{label}</span>
                <Input
                  type="number" step={step} min={STOPPAGE_RANGES[key][0]} max={STOPPAGE_RANGES[key][1]}
                  value={stoppageConfig[key]}
                  onChange={e => updateStoppageField(key, e.target.value)}
                  className="w-24 h-7 text-xs text-right"
                  data-testid={`input-stoppage-${key}`}
                />
              </div>
            ))}
            <p className="text-[10px]" style={{ color: "#66aa66" }}>Inside that window it stops when your landed punches are this many times the opponent's. Higher is rarer.</p>
            {(
              [
                { key: "mercyRatioCareer", label: "Landed-punch ratio — career", step: "0.5" },
                { key: "mercyRatioQuick", label: "Landed-punch ratio — quick fight", step: "0.5" },
              ] as { key: keyof StoppageConfig; label: string; step: string }[]
            ).map(({ key, label, step }) => (
              <div key={key} className="flex items-center gap-2">
                <span className="text-xs flex-1" style={{ color: "#c8ffaa" }}>{label}</span>
                <Input
                  type="number" step={step} min={STOPPAGE_RANGES[key][0]} max={STOPPAGE_RANGES[key][1]}
                  value={stoppageConfig[key]}
                  onChange={e => updateStoppageField(key, e.target.value)}
                  className="w-24 h-7 text-xs text-right"
                  data-testid={`input-stoppage-${key}`}
                />
              </div>
            ))}

            <p className="text-[10px] pt-2 font-semibold" style={{ color: "#8fdc6a" }}>TOWEL STOPPAGE — thrown in mid-round by the losing corner</p>
            <p className="text-[10px]" style={{ color: "#66aa66" }}>Qualifying: from this round onwards, one side's damage on the bar — this round or the fight so far — has to be this many times the other's. The ratio eases every round past the first, so a long beating still qualifies eventually (it never drops below 1).</p>
            {(
              [
                { key: "towelFirstRound", label: "First round it can happen", step: "1" },
                { key: "towelDamageRatio", label: "Damage ratio needed", step: "0.5" },
                { key: "towelRatioDropPerRound", label: "Ratio drop per later round", step: "0.05" },
              ] as { key: keyof StoppageConfig; label: string; step: string }[]
            ).map(({ key, label, step }) => (
              <div key={key} className="flex items-center gap-2">
                <span className="text-xs flex-1" style={{ color: "#c8ffaa" }}>{label}</span>
                <Input
                  type="number" step={step} min={STOPPAGE_RANGES[key][0]} max={STOPPAGE_RANGES[key][1]}
                  value={stoppageConfig[key]}
                  onChange={e => updateStoppageField(key, e.target.value)}
                  className="w-24 h-7 text-xs text-right"
                  data-testid={`input-stoppage-${key}`}
                />
              </div>
            ))}
            <p className="text-[10px] pt-1" style={{ color: "#66aa66" }}>Immunity: the losing fighter is spared if they have dealt this share of the winner's damage, or have scored this many knockdowns in a row without going down themselves. Either way it only saves them once per fight.</p>
            {(
              [
                { key: "towelImmunityDamageShare", label: "Damage share that spares them", step: "0.05" },
                { key: "towelImmunityKds", label: "Unanswered knockdowns scored", step: "1" },
              ] as { key: keyof StoppageConfig; label: string; step: string }[]
            ).map(({ key, label, step }) => (
              <div key={key} className="flex items-center gap-2">
                <span className="text-xs flex-1" style={{ color: "#c8ffaa" }}>{label}</span>
                <Input
                  type="number" step={step} min={STOPPAGE_RANGES[key][0]} max={STOPPAGE_RANGES[key][1]}
                  value={stoppageConfig[key]}
                  onChange={e => updateStoppageField(key, e.target.value)}
                  className="w-24 h-7 text-xs text-right"
                  data-testid={`input-stoppage-${key}`}
                />
              </div>
            ))}
            <p className="text-[10px] pt-1" style={{ color: "#66aa66" }}>Once it qualifies, the corner rolls every second: base chance, plus the winner's unanswered punch streak, minus a cut for every round the losing fighter has won. Career fights then take both multipliers below; quick fights only take the last one.</p>
            {(
              [
                { key: "towelBaseChance", label: "Base chance per second", step: "0.005" },
                { key: "towelStreakChance", label: "Per unanswered punch", step: "0.005" },
                { key: "towelRoundWonPenalty", label: "Per round the loser won", step: "0.005" },
                { key: "towelCareerMult", label: "Career multiplier", step: "0.05" },
                { key: "towelGlobalMult", label: "Overall multiplier", step: "0.05" },
              ] as { key: keyof StoppageConfig; label: string; step: string }[]
            ).map(({ key, label, step }) => (
              <div key={key} className="flex items-center gap-2">
                <span className="text-xs flex-1" style={{ color: "#c8ffaa" }}>{label}</span>
                <Input
                  type="number" step={step} min={STOPPAGE_RANGES[key][0]} max={STOPPAGE_RANGES[key][1]}
                  value={stoppageConfig[key]}
                  onChange={e => updateStoppageField(key, e.target.value)}
                  className="w-24 h-7 text-xs text-right"
                  data-testid={`input-stoppage-${key}`}
                />
              </div>
            ))}
          </Card>
          <Card className="p-3 w-full space-y-3" style={{ background: "#0a1a0a", border: "1px solid #1a4a1a" }}>
            <div className="flex items-center justify-between gap-2">
              <div>
                <p className="text-sm font-semibold" style={{ color: "#c8ffaa" }}>Pattern Memory</p>
                <p className="text-[10px]" style={{ color: "#66aa66" }}>The AI remembers combinations you repeat, and prepares an answer</p>
              </div>
              <Button size="sm" variant="outline" onClick={resetAiPatternConfig} className="text-xs h-7 px-2" data-testid="button-reset-ai-pattern-config" style={{ borderColor: "#1a7a1a", color: "#c8ffaa" }}>
                <RotateCcw className="w-3 h-3 mr-1" /> Reset
              </Button>
            </div>
            <p className="text-[10px]" style={{ color: "#66aa66" }}>
              Recognizing a combination never makes the AI read more of your punches — the existing read chance is still the first gate. It only changes what the AI does with the reads it already wins. Edits are live in the next bout.
            </p>
            <label className="flex items-center gap-2 cursor-pointer" data-testid="toggle-ai-pattern-enabled">
              <input
                type="checkbox"
                checked={aiPatternConfig.enabled}
                onChange={e => toggleAiPatterns(e.target.checked)}
              />
              <span className="text-xs" style={{ color: "#c8ffaa" }}>Enabled — off restores the old reaction-only AI</span>
            </label>

            <p className="text-[10px] pt-1 font-semibold" style={{ color: "#8fdc6a" }}>WHAT GETS REMEMBERED</p>
            <p className="text-[10px]" style={{ color: "#66aa66" }}>Patterns are three actions long. Separation is only a gate — anything thrown inside the watch range counts as the same pattern. Two are only the same pattern if they come off the same last punch the AI landed.</p>
            {(
              [
                { key: "observeRangePx", label: "Only watch inside (px)", step: "5" },
                { key: "maxCandidates", label: "Unrecognized patterns held", step: "5" },
              ] as { key: Exclude<keyof AiPatternConfig, "enabled">; label: string; step: string }[]
            ).map(({ key, label, step }) => (
              <div key={key} className="flex items-center gap-2">
                <span className="text-xs flex-1" style={{ color: "#c8ffaa" }}>{label}</span>
                <Input
                  type="number" step={step} min={AI_PATTERN_RANGES[key][0]} max={AI_PATTERN_RANGES[key][1]}
                  value={aiPatternConfig[key]}
                  onChange={e => updateAiPatternField(key, e.target.value)}
                  className="w-24 h-7 text-xs text-right"
                  data-testid={`input-ai-pattern-${key}`}
                />
              </div>
            ))}

            <p className="text-[10px] pt-2 font-semibold" style={{ color: "#8fdc6a" }}>REPEATS BEFORE IT CATCHES ON</p>
            <p className="text-[10px]" style={{ color: "#66aa66" }}>How many times you have to throw the same combination before that tier starts answering it.</p>
            {(
              [
                { key: "recogChampion", label: "Champion", step: "1" },
                { key: "recogElite", label: "Elite", step: "1" },
                { key: "recogContender", label: "Contender", step: "1" },
                { key: "recogJourneyman", label: "Journeyman", step: "1" },
              ] as { key: Exclude<keyof AiPatternConfig, "enabled">; label: string; step: string }[]
            ).map(({ key, label, step }) => (
              <div key={key} className="flex items-center gap-2">
                <span className="text-xs flex-1" style={{ color: "#c8ffaa" }}>{label}</span>
                <Input
                  type="number" step={step} min={AI_PATTERN_RANGES[key][0]} max={AI_PATTERN_RANGES[key][1]}
                  value={aiPatternConfig[key]}
                  onChange={e => updateAiPatternField(key, e.target.value)}
                  className="w-24 h-7 text-xs text-right"
                  data-testid={`input-ai-pattern-${key}`}
                />
              </div>
            ))}

            <p className="text-[10px] pt-2 font-semibold" style={{ color: "#8fdc6a" }}>HOW MANY IT CAN HOLD</p>
            <p className="text-[10px]" style={{ color: "#66aa66" }}>Learning a new one past the limit pushes out the least-seen. Change your combinations and the old book goes stale.</p>
            {(
              [
                { key: "capChampion", label: "Champion", step: "1" },
                { key: "capElite", label: "Elite", step: "1" },
                { key: "capContender", label: "Contender", step: "1" },
                { key: "capJourneyman", label: "Journeyman", step: "1" },
              ] as { key: Exclude<keyof AiPatternConfig, "enabled">; label: string; step: string }[]
            ).map(({ key, label, step }) => (
              <div key={key} className="flex items-center gap-2">
                <span className="text-xs flex-1" style={{ color: "#c8ffaa" }}>{label}</span>
                <Input
                  type="number" step={step} min={AI_PATTERN_RANGES[key][0]} max={AI_PATTERN_RANGES[key][1]}
                  value={aiPatternConfig[key]}
                  onChange={e => updateAiPatternField(key, e.target.value)}
                  className="w-24 h-7 text-xs text-right"
                  data-testid={`input-ai-pattern-${key}`}
                />
              </div>
            ))}

            <p className="text-[10px] pt-2 font-semibold" style={{ color: "#8fdc6a" }}>HOW CONFIDENTLY IT COMMITS</p>
            <p className="text-[10px]" style={{ color: "#66aa66" }}>Rolled only after the read gate passes. Getting hit and getting dropped both shake the AI's confidence in what it thinks it knows.</p>
            {(
              [
                { key: "baseChancePct", label: "Base chance %", step: "1" },
                { key: "perRepeatPct", label: "+ per extra repeat seen", step: "1" },
                { key: "perHitTakenPct", label: "− per punch taken clean", step: "0.05" },
                { key: "knockdownMult", label: "× per knockdown suffered", step: "0.05" },
                { key: "maxChancePct", label: "Ceiling %", step: "1" },
                { key: "stunPenaltyPct", label: "− % while stunned", step: "1" },
                { key: "holdSec", label: "Prepared guard held (sec)", step: "0.05" },
                { key: "stepOutPx", label: "Step off the punch line (px)", step: "1" },
              ] as { key: Exclude<keyof AiPatternConfig, "enabled">; label: string; step: string }[]
            ).map(({ key, label, step }) => (
              <div key={key} className="flex items-center gap-2">
                <span className="text-xs flex-1" style={{ color: "#c8ffaa" }}>{label}</span>
                <Input
                  type="number" step={step} min={AI_PATTERN_RANGES[key][0]} max={AI_PATTERN_RANGES[key][1]}
                  value={aiPatternConfig[key]}
                  onChange={e => updateAiPatternField(key, e.target.value)}
                  className="w-24 h-7 text-xs text-right"
                  data-testid={`input-ai-pattern-${key}`}
                />
              </div>
            ))}

            <p className="text-[10px] pt-2 font-semibold" style={{ color: "#8fdc6a" }}>CAREER TAPE STUDY</p>
            <p className="text-[10px]" style={{ color: "#66aa66" }}>Career only. What one opponent works out about you goes on your tape, and better-ranked opponents walk in already knowing some of it — nothing at the bottom of the ladder, all ten by the title fight. They study your most-repeated combinations first and keep building on them during the fight. A fresh career starts them blind again.</p>
            {(
              [
                { key: "studyScale", label: "Study multiplier (0 = off)", step: "0.05" },
                { key: "studyCarryPct", label: "% of tape repeats carried in", step: "1" },
                { key: "studyCarryMax", label: "Max repeats carried in", step: "1" },
                { key: "libraryMax", label: "Patterns kept on your tape", step: "10" },
              ] as { key: Exclude<keyof AiPatternConfig, "enabled">; label: string; step: string }[]
            ).map(({ key, label, step }) => (
              <div key={key} className="flex items-center gap-2">
                <span className="text-xs flex-1" style={{ color: "#c8ffaa" }}>{label}</span>
                <Input
                  type="number" step={step} min={AI_PATTERN_RANGES[key][0]} max={AI_PATTERN_RANGES[key][1]}
                  value={aiPatternConfig[key]}
                  onChange={e => updateAiPatternField(key, e.target.value)}
                  className="w-24 h-7 text-xs text-right"
                  data-testid={`input-ai-pattern-${key}`}
                />
              </div>
            ))}
          </Card>
        </div>
      )}
      {showSavePreset && (
        <Card className="p-3 w-full space-y-2">
          <p className="text-sm font-semibold">Save All Networks as Preset</p>
          <div className="flex gap-2">
            <Input
              value={presetName}
              onChange={e => setPresetName(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") saveAllAsPreset(); }}
              placeholder="Preset name..."
              className="flex-1"
              data-testid="input-preset-name"
            />
            <Button onClick={saveAllAsPreset} disabled={!presetName.trim()} data-testid="button-confirm-save-preset">
              Save
            </Button>
          </div>
        </Card>
      )}
      {showLoadPreset && (
        <Card className="p-3 w-full space-y-2">
          <p className="text-sm font-semibold">Load Network Preset</p>
          {presets.length === 0 ? (
            <p className="text-xs text-muted-foreground">No saved presets yet.</p>
          ) : (
            <div className="space-y-1 max-h-48 overflow-y-auto">
              {presets.map((p, i) => (
                <div key={i} className="flex items-center gap-2 p-2 rounded hover:bg-muted/50" data-testid={`preset-item-${i}`}>
                  <button
                    className="flex-1 text-left text-sm font-medium hover:underline cursor-pointer"
                    onClick={() => loadPresetByIndex(i)}
                    data-testid={`button-load-preset-${i}`}
                  >
                    {p.name}
                  </button>
                  <span className="text-xs text-muted-foreground">
                    {new Date(p.createdAt).toLocaleDateString()}
                  </span>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    onClick={() => deletePresetByIndex(i)}
                    data-testid={`button-delete-preset-${i}`}
                  >
                    <Trash2 className="w-3 h-3" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </Card>
      )}
      <ScalingReferenceTables key={`scaling-${paramEpoch}`} />
      <Card className="p-2 w-full" style={{ minHeight: 36, visibility: hoveredNode ? "visible" : "hidden" }}>
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 rounded-full" style={{ backgroundColor: hoveredNode ? CAT_COLORS[NEURAL_PARAMS.find(p => p.id === hoveredNode)?.category || ""] : "transparent" }} />
          <span className="text-sm font-semibold">{hoveredNode ? NEURAL_PARAMS.find(p => p.id === hoveredNode)?.label : "\u00A0"}</span>
          <span className="text-xs text-muted-foreground ml-auto">{hoveredNode ? NEURAL_PARAMS.find(p => p.id === hoveredNode)?.category : ""}</span>
          <span className="text-sm font-bold">{hoveredNode ? `${Math.round((currentState[hoveredNode] ?? 0.5) * 100)}%` : ""}</span>
        </div>
      </Card>
    </div>
  );
}
