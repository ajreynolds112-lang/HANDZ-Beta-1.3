import { sql } from "drizzle-orm";
import { pgTable, text, varchar, integer, real, jsonb, timestamp, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export interface SkillPoints {
  power: number;
  speed: number;
  defense: number;
  stamina: number;
  focus: number;
}

export interface GearColors {
  gloves: string;
  gloveTape: string;
  trunks: string;
  shoes: string;
  /** Sparring headgear. Optional so saves written before headgear existed load. */
  headgear?: string;
  /** Boxing socks. Optional so saves written before socks existed load. */
  socks?: string;
  /** Shoe laces. Optional: absent means "derive from the shoe colour". */
  laces?: string;
  /** Shoe soles. Optional: absent means "derive from the shoe colour". */
  soles?: string;
  /** Trunk waist stripe. Optional: absent means "derive from the trunks colour". */
  waistStripe?: string;
}

export interface TrainingBonuses {
  weightLifting: number;
  heavyBag: number;
  sparring: number;
  postFightXpBoost?: number;
  customStatUnlock?: string;
  wlCustomStatUnlock?: string;
  hbCustomStatUnlock?: string;
  wlHighScore?: number;
  hbHighScore?: number;
  /** Lifetime rep counter across Weight Lifting + Heavy Bag; every 50 reps = 1 refinement point */
  totalTrainingReps?: number;
  /** Lifetime Weight Lifting reps; every 300 reps = 1 diamond */
  wlTotalReps?: number;
  /** Lifetime Heavy Bag reps; every 300 reps = 1 diamond */
  hbTotalReps?: number;
  /** Lifetime clean rhythm cut hits landed in sparring; every 20 = 1 diamond */
  totalRhythmCutHits?: number;
  /** Roster week number of the last training sweep (1 sweep allowed per week, fight camp only) */
  lastSweepWeek?: number;
}

export const DEFAULT_GEAR_COLORS: GearColors = {
  gloves: "#cc2222",
  gloveTape: "#eeeeee",
  trunks: "#2244aa",
  shoes: "#1a1a1a",
  headgear: "#2244aa",
  socks: "#f0f0f0",
};

export const DEFAULT_TRAINING_BONUSES: TrainingBonuses = {
  weightLifting: 0,
  heavyBag: 0,
  sparring: 0,
};

/**
 * Total stat points a career can hold before the champion is beaten. Left just
 * under the per-stat ceiling × 5 on purpose: a player who specs narrowly can
 * still take a few stats all the way to 1000, but not every one of them.
 */
export const MAX_STAT_POINTS = 4880;
/** Beating the champion lifts the pool to a full 1000 in every stat. */
export const CHAMPION_STAT_CAP = 5000;
export const PRE_CHAMP_PER_STAT_CAP = 1000;
export const PER_STAT_CAP = 1000;

export function statPointCap(champBeaten: boolean): number {
  return champBeaten ? CHAMPION_STAT_CAP : MAX_STAT_POINTS;
}

export function perStatCap(_champBeaten: boolean): number {
  return 1000;
}

export function totalSkillPts(sp: unknown, avail = 0): number {
  const s = (sp || {}) as Partial<{ power: number; speed: number; defense: number; stamina: number; focus: number }>;
  return (s.power || 0) + (s.speed || 0) + (s.defense || 0) + (s.stamina || 0) + (s.focus || 0) + avail;
}

export interface SkillRefinement {
  availablePoints: number;
  /** Permanent SP-cost reduction bought with diamonds (1 diamond = -1 SP per refinement point, min cost 1) */
  costReduction?: number;
  offenseUnlocked: boolean;
  defenseUnlocked: boolean;
  fightIqUnlocked: boolean;
  pressureFighter: number;
  precisionStriker: number;
  jabPower: number;
  hookPower: number;
  uppercutPower: number;
  /** Bruiser — punches thrown from either outer quarter of the fighter's own
   *  sway get a chance to ignore the guard, perfect block included. */
  bruiser: number;
  /** KO Artist — the charge meter fills on its own while nobody is down. */
  koArtist: number;
  ironChin: number;
  slippery: number;
  guardMaster: number;
  duckRecovery: number;
  punchRolling: number;
  fastTwitch: number;
  heartRefinement: number;
  chinHitter: number;
  technician: number;
  /** Life Drain — restores a slice of max stamina 1s after every clean punch landed. */
  lifeDrain: number;
  /**
   * The refinements the fighter actually brings into the ring — at most
   * {@link MAX_ACTIVE_REFINEMENTS}, and for the player no more than the slots
   * they have unlocked. Authoritative for the player even when empty: an empty
   * list means no refinement bonuses apply, never "their best few". Everything
   * left out keeps its purchased level and can be swapped back in at any time.
   */
  activeRefinements?: string[];
  /**
   * Extra Refinement Slots earned by climbing the rankings, on top of the
   * {@link BASE_ACTIVE_REFINEMENT_SLOTS} every career starts with. Stamped the
   * moment a rank threshold is crossed and never lowered again, so a losing run
   * cannot take a slot back. Absent on saves written before the feature.
   */
  activeSlotsUnlocked?: number;
  /** @deprecated Short-lived shard-purchase counter, read only so those saves keep their slots. */
  activeSlotsPurchased?: number;
}

/**
 * The most refinements any fighter can bring into the ring at once — the hard
 * ceiling for AI opponents and for a player who has bought every slot. Lives
 * here rather than in the fight engine because the config layer and the Roster
 * Generation screen need it at module-init time, and the engine sits behind an
 * import cycle from those.
 */
export const MAX_ACTIVE_REFINEMENTS = 8;

/** Refinement Slots a career starts with. The rest are earned by ranking up. */
export const BASE_ACTIVE_REFINEMENT_SLOTS = 5;

/**
 * The career rank each extra Refinement Slot is earned at, best-rank-last: the
 * 6th slot at rank 550, the 7th at 300, the 8th at 100. Its length is what makes
 * the player's ceiling meet MAX_ACTIVE_REFINEMENTS, so adding a rung extends the
 * ladder rather than needing the cap moved as well.
 */
export const REFINEMENT_SLOT_RANK_UNLOCKS = [550, 300, 100] as const;

/** Extra slots a rank has earned. Rank 0/unknown reads as none earned yet. */
export function refinementSlotsForRank(rank: number | null | undefined): number {
  const r = Number(rank);
  if (!Number.isFinite(r) || r <= 0) return 0;
  return REFINEMENT_SLOT_RANK_UNLOCKS.filter(threshold => r <= threshold).length;
}

/** Extra slots stamped on the save, read defensively — old saves carry no field. */
export function refinementSlotsUnlocked(ref: { activeSlotsUnlocked?: number; activeSlotsPurchased?: number } | null | undefined): number {
  const clamp = (v: unknown) => {
    const raw = Number(v ?? 0);
    if (!Number.isFinite(raw)) return 0;
    return Math.max(0, Math.min(REFINEMENT_SLOT_RANK_UNLOCKS.length, Math.floor(raw)));
  };
  return Math.max(clamp(ref?.activeSlotsUnlocked), clamp(ref?.activeSlotsPurchased));
}

/** How many refinements this particular save may carry into the ring. */
export function maxActiveRefinementsFor(ref: { activeSlotsUnlocked?: number; activeSlotsPurchased?: number } | null | undefined): number {
  return Math.min(MAX_ACTIVE_REFINEMENTS, BASE_ACTIVE_REFINEMENT_SLOTS + refinementSlotsUnlocked(ref));
}

/** The rank the next slot is waiting on, or null once every slot is unlocked. */
export function nextRefinementSlotRank(ref: { activeSlotsUnlocked?: number; activeSlotsPurchased?: number } | null | undefined): number | null {
  const have = refinementSlotsUnlocked(ref);
  return have >= REFINEMENT_SLOT_RANK_UNLOCKS.length ? null : REFINEMENT_SLOT_RANK_UNLOCKS[have];
}

export const DEFAULT_SKILL_REFINEMENT: SkillRefinement = {
  availablePoints: 0,
  offenseUnlocked: false,
  defenseUnlocked: false,
  fightIqUnlocked: false,
  pressureFighter: 0,
  precisionStriker: 0,
  jabPower: 0,
  hookPower: 0,
  uppercutPower: 0,
  bruiser: 0,
  koArtist: 0,
  ironChin: 0,
  slippery: 0,
  guardMaster: 0,
  duckRecovery: 0,
  punchRolling: 0,
  fastTwitch: 0,
  heartRefinement: 0,
  chinHitter: 0,
  technician: 0,
  lifeDrain: 0,
  activeRefinements: [],
  activeSlotsUnlocked: 0,
};

export interface OffenseProfile {
  version: number;
  openingShots: number;
  bodyCampaign: number;
  bodyCampaignRangePx: number;
  bodyCampaignDuration: number;
  chargedAmbush: number;
  chargedAmbushRangePx: number;
  chargedAmbushBars: number;
  comboLayering: number;
  ringCutting: number;
  bodySpamCounter: number;
  headRhythmRead: number;
  chargedRespect: number;
  postExchangeDiscipline: number;
}

export interface RosterFighterState {
  id: number;
  wins: number;
  losses: number;
  draws: number;
  knockouts: number;
  totalFights: number;
  level: number;
  armLength: number;
  active: boolean;
  retired: boolean;
  rank: number;
  ratingScore: number;
  beatenByPlayer: boolean;
  lastFightWeek?: number;
  unavailableThisWeek?: boolean;
  wasUnavailableLast?: boolean;
  championLocked?: boolean;
  fighterDifficulty?: "journeyman" | "contender" | "elite" | "champion";
  genSkinColor?: string;
  genGloves?: string;
  genGloveTape?: string;
  genTrunks?: string;
  genShoes?: string;
  genSocks?: string;
  customFirstName?: string;
  customNickname?: string;
  customLastName?: string;
  customSkinColor?: string;
  customGloves?: string;
  customGloveTape?: string;
  customTrunks?: string;
  customShoes?: string;
  customSocks?: string;
  customLaces?: string;
  customSoles?: string;
  customWaistStripe?: string;
  /** Wears the Spacial Color finish instead of its own gear colours. */
  /** Legacy whole-kit toggle, kept so rosters saved before per-piece picking still wear it. */
  customSpacial?: boolean;
  /** Which gear pieces wear the Spacial finish. Their own colours stay underneath. */
  customSpacialParts?: string[];
  statPower?: number;
  statSpeed?: number;
  statDefense?: number;
  statStamina?: number;
  statFocus?: number;
  overallRating?: number;
  refPoints?: number;
  customRefPoints?: number;
  customRefinementSkills?: Record<string, number>;
  customSkillPoints?: { power: number; speed: number; defense: number; stamina: number; focus: number };
  alwaysUndefeated?: boolean;
  momentum?: number;
  winStreak?: number;
  loseStreak?: number;
  drawStreak?: number;
  weeksSinceLastFight?: number;
  lastFightResults?: string[];
  lastOpponentId?: number;
  lastOpponentWeek?: number;
  boxingStance?: "orthodox" | "southpaw";
  offenseProfile?: OffenseProfile;
  /**
   * Punches this fighter gets per point of max stamina lost during a bout,
   * handed out by their Roster Generation band. Missing = the 20 floor.
   */
  punchEndurance?: number;
  /**
   * Equipment Upgrades this fighter walks in with. Career opponents carry a
   * single level worn in all five slots, handed out by their Roster Generation
   * band and grown weekly. Missing = no equipment.
   */
  equipmentLevel?: number;
}

export interface CareerRosterState {
  roster: RosterFighterState[];
  weekNumber: number;
  newsItems: string[];
  selectedOpponentId: number | null;
  playerRank: number;
  /**
   * The best rank this career has ever held — a high-water mark, so it only
   * ever moves toward #1. Rank-gated unlocks read this rather than playerRank:
   * reaching the number is what earns them, and sliding back down the ladder
   * afterwards must not take them away again.
   *
   * Absent on every career that predates the field; treat a missing value as
   * "no better than where the save sits right now".
   */
  bestRankEver?: number;
  playerRatingScore: number;
  trainingsSinceLastWeek: number;
  /**
   * Combinations the player has been caught repeating, kept career-long so
   * later opponents can study them off tape before the bell. Written at the end
   * of every bout the AI learned something in. See client/src/game/aiPatterns.ts.
   */
  aiPatternLibrary?: { key: string; ctx: string; acts: string[]; n: number }[];
  /**
   * The player's own half of the same game: three-link combinations they have
   * grooved in the gym, and how many times each has landed. `n` — the sharpness
   * — is counted by gym sparring only and never by a career bout, the exact
   * mirror of the tape above, while the buffs it earns apply everywhere. Keyed
   * on the three action tokens alone, with no context prefix.
   *
   * `st`/`wt`/`wu`/`dw` are the rehearsal clock, which runs the other way: how
   * far down the stamina ladder the string has been worked, the sparring throws
   * banked toward this career week's improvement quota, the throws banked in
   * any bout toward merely holding it, and the run of weeks it went untouched.
   * Maintenance counts throws in career bouts too; improvement is gym-only. All
   * four are optional, so a save written before the clock existed reads back as
   * an unrehearsed string with a clean sheet.
   * See client/src/game/drilledActions.ts.
   */
  drilledActions?: { key: string; acts: string[]; n: number; st?: number; wt?: number; wu?: number; dw?: number }[];
  rank1HolderId?: number | "player";
  prepWeeksRemaining?: number;
  savedChargeBars?: number;
  savedChargeCounters?: number;
  winsVsTop25?: number;
  winsVsTop10?: number;
  top5Beaten?: number[];
  endgameShownIds?: number[];
  endgamePoolInitialized?: boolean;
  idleWeeks?: number;
  rescheduledOpponentIds?: number[];
  // Opponents the player has booked a fight against at least once — their full
  // stat spread is permanently revealed on the opponent select screen.
  scoutedOpponentIds?: number[];
  rescheduledThisFight?: boolean;
  careerFightsCompleted?: number;
  negotiationAttemptsUsed?: number;
  /** Lifetime count of Shard-bought negotiation guarantees — each one raises the next price 10%. */
  guaranteedNegotiationsUsed?: number;
  /** Set the first time the player opens the Skill Refinement case — kills its "new" dot. */
  refinementCaseSeen?: boolean;
  /**
   * Equipment Upgrade slots whose win threshold has already been announced.
   * Each newly cleared threshold raises a hub milestone and a dot on the gym
   * crate until the player opens the page, which records them here.
   */
  equipmentSeenSlots?: string[];
  /**
   * Slots the hub's "new gear" overlay has already been raised for. Separate
   * from equipmentSeenSlots on purpose: the overlay is a one-time announcement
   * and records itself the moment it opens, while the crate's red dot keeps
   * burning until the player actually opens the Equipment Upgrades page.
   */
  equipmentAnnouncedSlots?: string[];
  doghouseUsedThisCamp?: boolean;
  lastDoghouseOpponentId?: number | null;
  /**
   * Bought once with Force, after which the mode can be entered as often as the
   * player can pay the per-session fee. On the roster state so they ride along
   * with a save download/upload and start clear again on a fresh career.
   */
  doghouseUnlocked?: boolean;
  nightmareUnlocked?: boolean;
  /**
   * Set once per career, the first time it is loaded by a build that has the
   * paid unlocks. A career that got this far without them was played under the
   * old rules, where clearing the win requirement *was* the unlock, so the
   * modes it had already earned are handed over free rather than taken away.
   */
  sparringUnlocksMigrated?: boolean;
  endgameRefFloorApplied?: boolean;
  refinementGenV2Applied?: boolean;
  refinementGenV3Applied?: boolean;
  /**
   * Set once, when a career first loads under the five-active refinement cap and
   * every roster opponent is trimmed to their five highest. Stops a reload from
   * re-trimming loadouts that have legitimately moved on since.
   */
  refinementFiveCapApplied?: boolean;
  weeklyBonus?: {
    trainingType: "weightLifting" | "heavyBag" | "sparring";
    bonusType: "xp" | "sp";
    value: number;
  } | null;
  lastSparWeek?: number;
  lastWLWeek?: number;
  lastHBWeek?: number;
  /**
   * Local calendar day (`YYYY-MM-DD`) this career last took its daily reward
   * chests. Absent on a career that has never claimed one, which reads as due.
   */
  lastDailyRewardDay?: string;
  /**
   * When that claim happened, in epoch ms. Purely local: the countdown to the
   * next 00:00 reset is worked out from this and the device clock, so the
   * daily reward keeps ticking with no connection.
   */
  lastDailyRewardAt?: number;
  /**
   * Punch Endurance: punches the player gets per point of max stamina lost in a
   * bout. Grown by the three sparring modes, decayed by idle weeks, held between
   * 20 and 120. Missing on careers saved before it existed — they read as 20.
   */
  punchEndurance?: number;
  /**
   * Week the next Punch Endurance decay is due — `lastSparWeek` plus the grace
   * period, then one step forward per point taken, so a sparring session
   * restarts the clock simply by overtaking it. A fight week slides it forward
   * a week instead of taking a point, so the bout costs the player nothing.
   */
  punchEnduranceDecayWeek?: number;
  /**
   * Max stamina lost each time the Punch Endurance counter comes round — the
   * "8" in "8 max stamina every 20 punches". Heavy bag work drills it down
   * toward 1; three full weeks off the bag start it climbing back at a point a
   * week. Missing on careers saved before it existed — they read as the 8
   * ceiling, which is where an untrained fighter sits anyway.
   */
  punchEnduranceLoss?: number;
  /** True once {@link punchEnduranceLoss} is a percentage of the pool, not a point count. */
  punchEnduranceLossPct?: boolean;
  /**
   * Week the next heavy-bag cost rise is due — `lastHBWeek` plus the grace
   * period, then one step forward per point handed back, so a bag session
   * restarts the clock simply by overtaking it. Slides on a fight week for the
   * same reason its sparring counterpart does.
   */
  punchEnduranceLossRiseWeek?: number;
  /**
   * The Punch Endurance pair the player has already had on screen. When either
   * of these differs from the live value, the gym meter flashes that number
   * once — green if the change helped, red if it hurt — then records it here so
   * the same change never flashes twice.
   */
  punchEnduranceSeen?: number;
  punchEnduranceLossSeen?: number;
  /**
   * Reset training — the three Energy-fatigue buy-backs. Each track carries the
   * percentage points currently held, the reps banked toward the next point, the
   * lifetime reps that buy extra weeks onto its decay clock, and the roster week
   * its next point is due off. Absent on careers saved before it existed, which
   * read as untrained — the plain fatigue behaviour.
   */
  resetTraining?: {
    block: { value: number; carry: number; reps: number; due: number };
    damage: { value: number; carry: number; reps: number; due: number };
    slip: { value: number; carry: number; reps: number; due: number };
  };
  /**
   * Lifetime sparring sessions of any kind — regular, Doghouse, Nightmare — with
   * the harder modes weighted: a Doghouse Round banks five. The Reset's own
   * speed is read off this: every session shaves a little off the snap, up to
   * its cap. Absent on careers saved before it existed, which read as none and
   * train the speed from scratch.
   */
  totalSpars?: number;
  /**
   * Sessions' worth of that speed already rusted back on by weeks out of the
   * gym, subtracted from the count above rather than taken off it — so a return
   * to sparring buys the time back one session at a time.
   */
  resetSpeedDecaySteps?: number;
  /**
   * Week the next rust step is due — `lastSparWeek` plus the grace period, then
   * one step forward per step taken, so a session restarts the clock simply by
   * overtaking it.
   */
  resetSpeedRiseWeek?: number;
  savedForChampStatPoints?: number;
  refinementPermanentlyUnlocked?: boolean;
  /**
   * Set for good at 10 career wins: the Select Opponent screen offers 15 fighters
   * instead of 7 and rerolling reaches up to 50 ranks above the player. Lives on
   * the roster state so it rides along with save download/upload and starts clear
   * again on a fresh career.
   */
  expandedOpponentBoardUnlocked?: boolean;
  nightmareUsesThisCamp?: number;
  autoAllocUnlocked?: boolean;
  // Lifetime count of training sessions completed during fight camps. Each one
  // permanently adds +0.1% availability chance to every prep-week slot, so
  // long-term players eventually choose camp length freely.
  campTrainingSessions?: number;
}

export interface ItemInventory {
  /** itemId → owned copies (current, after sells/consumes). */
  owned: Record<string, number>;
  /** itemId → lifetime obtained count, used to enforce obtainable limits. */
  lifetimeObtained: Record<string, number>;
  /**
   * itemId → copies deliberately spent (sold, used or armed). Together with
   * `lifetimeObtained` it is the receipt that lets the locker prove a missing
   * copy was actually spent: anything unaccounted for is restored on read.
   */
  itemsSpent?: Record<string, number>;
  /** Keepsakes are permanent one-time gifts — once granted, never grantable again. */
  keepsakesReceived: string[];
  /** itemId → active stack count for boost items ("already active" / synergy rules). */
  activeBoosts: Record<string, number>;
  /** Items obtained but not yet seen in the Locker — drives the gym locker notification dot. */
  unseenItemIds?: string[];
  /** itemId → roster week the week-scoped boost was armed for; it expires when the week advances. */
  boostWeek?: Record<string, number>;
  /** itemId → camp signature the camp-scoped boost was armed for (GOAT's Blessing). */
  boostCamp?: Record<string, string>;
  /** The single active 24h gym AC boost — arming another replaces it and resets the timer. */
  acBoost?: { itemId: string; expiresAtMs: number } | null;
  /** Coach's Notes accrued permanent bonus percent per stat (each capped at 100). */
  coachNotes?: Record<string, number>;
  /**
   * Set once the one-time locker recovery has run for this save (rebuilds owned
   * copies and keepsakes from `lifetimeObtained`). Kept on the save so the
   * recovery can never resurrect an item the player later sold.
   */
  recoveredFromLifetimeV1?: boolean;
}
export interface CareerStats {
  totalPunchesThrown: number;
  totalPunchesLanded: number;
  totalKnockdownsGiven: number;
  totalKnockdownsTaken: number;
  totalBlocksMade: number;
  totalDodges: number;
  totalDamageDealt: number;
  totalDamageReceived: number;
  totalRoundsWon: number;
  totalRoundsLost: number;
  lifetimeXp: number;
}

export const DEFAULT_CAREER_STATS: CareerStats = {
  totalPunchesThrown: 0,
  totalPunchesLanded: 0,
  totalKnockdownsGiven: 0,
  totalKnockdownsTaken: 0,
  totalBlocksMade: 0,
  totalDodges: 0,
  totalDamageDealt: 0,
  totalDamageReceived: 0,
  totalRoundsWon: 0,
  totalRoundsLost: 0,
  lifetimeXp: 0,
};

export const fighters = pgTable("fighters", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  firstName: text("first_name").notNull().default(""),
  nickname: text("nickname").notNull().default(""),
  lastName: text("last_name").notNull().default(""),
  archetype: text("archetype").notNull().default("BoxerPuncher"),
  level: integer("level").notNull().default(1),
  xp: integer("xp").notNull().default(0),
  wins: integer("wins").notNull().default(0),
  losses: integer("losses").notNull().default(0),
  draws: integer("draws").notNull().default(0),
  knockouts: integer("knockouts").notNull().default(0),
  skillPoints: jsonb("skill_points").$type<SkillPoints>().default({ power: 0, speed: 0, defense: 0, stamina: 0, focus: 0 }),
  availableStatPoints: integer("available_stat_points").notNull().default(0),
  careerBoutIndex: integer("career_bout_index").notNull().default(0),
  careerDifficulty: text("career_difficulty").notNull().default("contender"),
  roundLengthMins: integer("round_length_mins").notNull().default(3),
  careerStats: jsonb("career_stats").$type<CareerStats>().default(DEFAULT_CAREER_STATS),
  skinColor: text("skin_color").notNull().default("#e8c4a0"),
  gearColors: jsonb("gear_colors").$type<GearColors>().default(DEFAULT_GEAR_COLORS),
  trainingBonuses: jsonb("training_bonuses").$type<TrainingBonuses>().default(DEFAULT_TRAINING_BONUSES),
  careerTrainingSessions: integer("career_training_sessions").notNull().default(0),
  highScoreMilestoneSeen: boolean("high_score_milestone_seen").notNull().default(false),
  careerRosterState: jsonb("career_roster_state").$type<CareerRosterState>(),
  skillRefinement: jsonb("skill_refinement").$type<SkillRefinement>(),
  force: integer("force").default(0),
  /** Spacial Color: the offer is hidden until the player first banks 100M Force. */
  spacialRevealed: boolean("spacial_revealed").notNull().default(false),
  /**
   * Legacy whole-kit unlock. Superseded by per-piece buying, but a career that
   * paid for it keeps every piece — it is read as "owns them all", never cleared.
   */
  spacialUnlocked: boolean("spacial_unlocked").notNull().default(false),
  /** Legacy whole-kit toggle, kept so saves written before per-piece picking still wear it. */
  spacialColors: boolean("spacial_colors").notNull().default(false),
  /** Which gear pieces wear the finish. Their own colours are kept underneath. */
  spacialParts: jsonb("spacial_parts").$type<string[]>(),
  /** Which gear pieces the finish has been BOUGHT for — one purchase per piece. */
  spacialOwned: jsonb("spacial_owned").$type<string[]>(),
  /** Career hub ring palette. Absent means the stock ring. */
  ringColors: jsonb("ring_colors").$type<Record<string, string>>(),
  /** Spacial finish for the ring — a single permanent purchase. */
  ringSpacialUnlocked: boolean("ring_spacial_unlocked").notNull().default(false),
  diamonds: integer("diamonds").default(0),
  shards: integer("shards").default(0),
  /** Levels bought with diamonds. Drives the level-up price, so XP levels never raise it. */
  diamondLevelsBought: integer("diamond_levels_bought").notNull().default(0),
  /** How many stat points this career has BOUGHT — sets the price of the next one. */
  statPointsBought: integer("stat_points_bought").notNull().default(0),
  /**
   * Equipment Upgrade levels per slot ("gloves" | "shoes" | "trunks" |
   * "mouthguard" | "wraps"). Bought one level at a time and never refundable,
   * so the storage layer merges them upward. Absent slots read as level 0 —
   * see `normalizeEquipmentLevels` in the game's equipment config.
   */
  equipment: jsonb("equipment").$type<Record<string, number>>(),
  itemInventory: jsonb("item_inventory").$type<ItemInventory>(),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertFighterSchema = createInsertSchema(fighters).omit({ id: true, createdAt: true });
export type InsertFighter = z.infer<typeof insertFighterSchema>;
export type Fighter = typeof fighters.$inferSelect;

export const fightResults = pgTable("fight_results", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  fighterId: varchar("fighter_id").notNull(),
  opponentName: text("opponent_name").notNull(),
  opponentLevel: integer("opponent_level").notNull(),
  opponentArchetype: text("opponent_archetype").notNull().default("BoxerPuncher"),
  result: text("result").notNull(),
  method: text("method").notNull(),
  rounds: integer("rounds").notNull(),
  xpGained: integer("xp_gained").notNull().default(0),
  boutNumber: integer("bout_number").notNull().default(0),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertFightResultSchema = createInsertSchema(fightResults).omit({ id: true, createdAt: true });
export type InsertFightResult = z.infer<typeof insertFightResultSchema>;
export type FightResult = typeof fightResults.$inferSelect;

export const DEFAULT_ITEM_INVENTORY: ItemInventory = {
  owned: {},
  lifetimeObtained: {},
  itemsSpent: {},
  keepsakesReceived: [],
  activeBoosts: {},
  unseenItemIds: [],
  boostWeek: {},
  boostCamp: {},
  acBoost: null,
  coachNotes: {},
};
