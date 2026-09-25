/**
 * Item effects — the gameplay layer behind the item catalog.
 *
 * `itemsConfig.ts` stores *what* an item is (rarity, limits, sell price); this
 * module stores *what it does* and resolves the active set into modifiers the
 * rest of the game queries:
 *
 *   getFightMods()      → engine.ts stat / stamina / stun / KD / rhythm hooks
 *   getTrainingMods()   → WL + Heavy Bag XP / SP hooks
 *   getSparringXpMult() → sparring EXP hook
 *   getGymIncomeMult()  → GymView passive income
 *   hasPerk()           → one-off unlocks (Credit Limit, Challenge Clause, ...)
 *   getActiveBoosts()   → the boost HUD icons + tooltips
 *
 * Durations
 *   permanent  — owned copies are always on (one-per-save keepsakes)
 *   instant    — consumed for a grant, never "active"
 *   nextFight / nextWL / nextHB / nextSpar — armed until that event resolves
 *   week       — armed for one roster week (tracked in `boostWeek`)
 *   camp       — armed for one fight camp (tracked in `boostCamp`)
 *   24h        — the single AC slot (tracked in `acBoost`)
 */
import type { CareerRosterState, Fighter, ItemInventory, SkillPoints } from "@shared/schema";
import { getItemDefinition, loadItemsConfig, type ItemDefinition } from "@/game/itemsConfig";
import { clampFamilyStacks, itemFamilyKey } from "@/game/itemFamily";
import { countMap, repairOwnedFromLedger } from "@/lib/itemLedger";

export type EffectDuration =
  | "permanent"
  | "instant"
  | "nextFight"
  | "nextWL"
  | "nextHB"
  | "nextSpar"
  | "week"
  | "camp"
  | "24h";

/** Where combat modifiers apply. Career-only effects stay out of sparring. */
export type FightScope = "career" | "both";

/** One-off capabilities an item unlocks, rather than a numeric modifier. */
export type ItemPerk = "diamondConversion" | "importSparring" | "extraReschedule";

export interface ItemEffect {
  duration: EffectDuration;
  /** Human-readable effect text, shown in the Locker and the boost HUD tooltip. */
  text: string;

  // ---- instant grants ----
  grantForce?: number;
  grantDiamonds?: number;
  grantRefinementPoints?: number;

  // ---- training ----
  /** Multiplier on training XP. */
  trainXpMult?: number;
  /** Multiplier on training stat points. */
  trainSpMult?: number;
  /** Flat stat points added to every training reward. */
  trainSpFlat?: number;
  /** Multiplier on sparring EXP. */
  sparXpMult?: number;
  /** Multiplier on the stat points a sparring session awards. */
  sparSpMult?: number;
  /** Chance (0–1) a weightlifting rep counts twice. */
  doubleRepChance?: number;
  /** Letters removed from the heavy-bag combo string length. */
  comboLenReduce?: number;
  /** Training Frenzy is wasted if the week is skipped with Simulate Week. */
  nullifiedBySimulateWeek?: boolean;
  /**
   * This item's `trainXpMult` also counts as sparring EXP in the gym's own
   * sparring modes (Nightmare, Doghouse) — a week-long boost covers everything
   * done in the gym that week, not just weightlifting and the heavy bag. The
   * ordinary sparring session keeps its own set (`sparXpMult`).
   */
  gymSparringXp?: boolean;
  /** Permanent per-camp-sparring stat growth (Coach's Notes), in percent. */
  coachNotesPerSparring?: number;

  // ---- fight ----
  fightScope?: FightScope;
  powerPct?: number;
  speedPct?: number;
  defensePct?: number;
  staminaPct?: number;
  focusPct?: number;
  dodgePct?: number;
  critPct?: number;
  staminaRecoveryPct?: number;
  stunChancePct?: number;
  /** 0–1 chance an incoming knockdown is shrugged off. */
  kdAvoidChance?: number;
  /** 0–1 chance an opponent's rhythm cut fails. */
  rhythmCutFailChance?: number;
  /** Multiplier on Force earned from the next career win. */
  forceMult?: number;

  // ---- gym / economy ----
  gymIncomeMult?: number;
  /** Perk flags consumed by UI unlocks. */
  perk?: ItemPerk;
  /** 0–1 chance per copy to duplicate a single item reward. */
  luckyCoinChance?: number;
}

// ---------------------------------------------------------------------------
// Effect table
// ---------------------------------------------------------------------------

const FORCE_BUNDLE = [10_000, 50_000, 100_000, 250_000, 1_000_000, 5_000_000];
const TOME_POINTS = [2, 5, 8, 10, 15, 20];
const SESSION_MULT = [1.5, 2, 2.5, 3, 4, 7];
/**
 * Stat points ride a flatter ladder than XP: the session families (Pre-Workout
 * Powder, Combo Tape, Headgear Strap) hand out far fewer start points than the
 * XP curve would imply, so the top tiers stay worth chasing without minting a
 * fighter's whole build in one session. Kept as plain per-copy multipliers so
 * an Additive synergy family still reads linearly — two 1.5× copies are 3×.
 */
const SESSION_SP_MULT = [1.2, 1.5, 1.75, 2, 2.5, 3];
/** XP boosts pay 2× the listed session multiplier; stat points use their own ladder. */
const XP_BOOST_MULT = 2;
const SESSION_XP_MULT = SESSION_MULT.map(v => v * XP_BOOST_MULT);
const ELECTROLYTE = [5, 8, 12, 15, 20, 25];
const SURGE = [2, 3, 4, 6, 10];

const TIER_KEYS = ["journeyman", "contender", "elite", "champion", "undisputed", "goat"];
const SURGE_KEYS = ["journeyman", "contender", "elite", "champion", "goat"];

function tierEffects(idBase: string, build: (i: number) => ItemEffect, keys = TIER_KEYS): Record<string, ItemEffect> {
  const out: Record<string, ItemEffect> = {};
  keys.forEach((k, i) => { out[`${idBase}_${k}`] = build(i); });
  return out;
}

const fmt = (n: number) => n.toLocaleString();

export const ITEM_EFFECTS: Record<string, ItemEffect> = {
  // ---------- currency & point grants ----------
  ...tierEffects("force_bundle", i => ({
    duration: "instant",
    text: `Grants ${fmt(FORCE_BUNDLE[i])} Force.`,
    grantForce: FORCE_BUNDLE[i],
  })),
  ...tierEffects("refinement_tome", i => ({
    duration: "instant",
    text: `Grants ${TOME_POINTS[i]} refinement point${TOME_POINTS[i] === 1 ? "" : "s"}.`,
    grantRefinementPoints: TOME_POINTS[i],
  })),
  diamond_chip: { duration: "instant", text: "Grants 1 Diamond.", grantDiamonds: 1 },
  diamond_jar: { duration: "instant", text: "Grants 5 Diamonds.", grantDiamonds: 5 },
  diamond_drawer: { duration: "instant", text: "Grants 15 Diamonds.", grantDiamonds: 15 },
  diamond_vault: { duration: "instant", text: "Grants 25 Diamonds.", grantDiamonds: 25 },
  veterans_fund_i: { duration: "instant", text: "Grants 50 Diamonds.", grantDiamonds: 50 },
  veterans_fund_ii: { duration: "instant", text: "Grants 100 Diamonds.", grantDiamonds: 100 },
  veterans_fund_iii: { duration: "instant", text: "Grants 300 Diamonds.", grantDiamonds: 300 },
  spartas_trophy: {
    // Owning it is enough — a permanent effect is read straight off `owned`.
    duration: "permanent",
    text: "Doubles the Force you earn from every fight, on top of any Fight Surge.",
    // Only career bouts pay Force, matching Fight Surge's scope. getForceMult
    // multiplies every forceMult together, so this doubles the payout whether or
    // not a Surge is also armed.
    fightScope: "career",
    forceMult: 2,
  },

  // ---------- training boosts ----------
  warmup_tape: {
    duration: "week",
    text: `${2 * XP_BOOST_MULT}× XP from every training session for the rest of this week.`,
    trainXpMult: 2 * XP_BOOST_MULT,
  },
  ...tierEffects("preworkout_powder", i => ({
    duration: "nextWL",
    text: `${SESSION_XP_MULT[i]}× XP and ${SESSION_SP_MULT[i]}× stat points from your next weightlifting session.`,
    trainXpMult: SESSION_XP_MULT[i],
    trainSpMult: SESSION_SP_MULT[i],
  })),
  ...tierEffects("combo_tape", i => ({
    duration: "nextHB",
    text: `${SESSION_XP_MULT[i]}× XP and ${SESSION_SP_MULT[i]}× stat points from your next heavy bag session.`,
    trainXpMult: SESSION_XP_MULT[i],
    trainSpMult: SESSION_SP_MULT[i],
  })),
  ...tierEffects("headgear_strap", i => ({
    duration: "nextSpar",
    text: `${SESSION_XP_MULT[i]}× EXP and ${SESSION_SP_MULT[i]}× stat points from your next sparring session.`,
    sparXpMult: SESSION_XP_MULT[i],
    sparSpMult: SESSION_SP_MULT[i],
  })),
  training_frenzy_i: {
    duration: "week", text: `${1.5 * XP_BOOST_MULT}× training XP and 1.5× stat points for one week — wasted if you Simulate the Week.`,
    trainXpMult: 1.5 * XP_BOOST_MULT, trainSpMult: 1.5, nullifiedBySimulateWeek: true, gymSparringXp: true,
  },
  training_frenzy_ii: {
    duration: "week", text: `${1.5 * XP_BOOST_MULT}× training XP and 1.5× stat points for one week — wasted if you Simulate the Week.`,
    trainXpMult: 1.5 * XP_BOOST_MULT, trainSpMult: 1.5, nullifiedBySimulateWeek: true, gymSparringXp: true,
  },
  training_frenzy_iii: {
    duration: "week", text: `${2 * XP_BOOST_MULT}× training XP and 2× stat points for one week — wasted if you Simulate the Week.`,
    trainXpMult: 2 * XP_BOOST_MULT, trainSpMult: 2, nullifiedBySimulateWeek: true, gymSparringXp: true,
  },
  training_frenzy_iv: {
    duration: "week", text: `${3 * XP_BOOST_MULT}× training XP and 3× stat points for one week — wasted if you Simulate the Week.`,
    trainXpMult: 3 * XP_BOOST_MULT, trainSpMult: 3, nullifiedBySimulateWeek: true, gymSparringXp: true,
  },
  goats_blessing: {
    duration: "permanent",
    text: `${1.5 * XP_BOOST_MULT}× all training XP, 1.5× stat points and ${1.5 * XP_BOOST_MULT}× sparring EXP, always on. Stacks with other boosters.`,
    trainXpMult: 1.5 * XP_BOOST_MULT, trainSpMult: 1.5, sparXpMult: 1.5 * XP_BOOST_MULT,
  },
  old_bell_hammer: {
    duration: "permanent",
    text: `+${Math.round((1.1 * XP_BOOST_MULT - 1) * 100)}% sparring EXP.`,
    sparXpMult: 1.1 * XP_BOOST_MULT,
  },
  gym_key: { duration: "permanent", text: "+2 stat points on every training reward.", trainSpFlat: 2 },
  compression_sleeves: { duration: "permanent", text: "3% chance a weightlifting rep counts twice.", doubleRepChance: 0.03 },
  heavy_bag_of_greatness: { duration: "permanent", text: "Heavy bag combo strings are 1 letter shorter in camp.", comboLenReduce: 1 },
  coachs_notes: {
    duration: "permanent",
    text: "Every camp sparring session permanently boosts a random stat by 0.25% (capped at 100%).",
    coachNotesPerSparring: 0.25,
  },

  // ---------- fight boosts & debuffs ----------
  ...tierEffects("fight_surge", i => ({
    duration: "nextFight",
    text: `${SURGE[i]}× Force earned from your next career win.`,
    // Career-scoped: only a career bout pays Force, so sparring, Nightmare and
    // Doghouse must neither apply nor spend it.
    fightScope: "career",
    forceMult: SURGE[i],
  }), SURGE_KEYS),
  ...tierEffects("electrolyte_bottle", i => ({
    duration: "nextFight",
    text: `+${ELECTROLYTE[i]}% stamina recovery speed next fight.`,
    fightScope: "both",
    staminaRecoveryPct: ELECTROLYTE[i],
  })),
  gummy_candy_i: {
    duration: "nextFight", fightScope: "career",
    text: "+1% Power, −1% Speed for your next career bout.",
    powerPct: 1, speedPct: -1,
  },
  gummy_candy_ii: {
    duration: "nextFight", fightScope: "career",
    text: "+1% Defense, −1% Focus for your next career bout.",
    defensePct: 1, focusPct: -1,
  },
  gummy_candy_iii: {
    duration: "nextFight", fightScope: "career",
    text: "+2% Power and Defense, −1% Dodge and Speed for your next career bout.",
    powerPct: 2, defensePct: 2, dodgePct: -1, speedPct: -1,
  },
  banana: {
    duration: "week", fightScope: "both",
    text: "+2% Dodge and Power for one week.",
    dodgePct: 2, powerPct: 2,
  },
  footwork_laces: {
    duration: "permanent", fightScope: "both",
    text: "Rhythm cuts against you have a 20% chance to fail.",
    rhythmCutFailChance: 0.2,
  },
  old_fight_poster: {
    duration: "nextFight", fightScope: "both",
    text: "+50% stun chance for your next fight.",
    stunChancePct: 50,
  },
  mouthguard_2088: {
    duration: "permanent", fightScope: "both",
    text: "65% chance to shrug off a knockdown.",
    kdAvoidChance: 0.65,
  },
  refined_film: {
    duration: "permanent", fightScope: "both",
    text: "+25% Defense in career bouts and sparring.",
    defensePct: 25,
  },
  veterans_footage: {
    duration: "permanent", fightScope: "both",
    text: "+10% Dodge chance and Focus in career bouts and sparring.",
    dodgePct: 10, focusPct: 10,
  },
  veterans_hand_wraps: {
    duration: "permanent", fightScope: "both",
    text: "+15% Power and Crit chance in career bouts and sparring.",
    powerPct: 15, critPct: 15,
  },
  veterans_amateur_belt: {
    duration: "permanent", fightScope: "both",
    text: "+3% Speed in career bouts and sparring.",
    speedPct: 3,
  },
  veterans_weighted_vest: {
    duration: "permanent", fightScope: "both",
    text: "+15% Stamina in career bouts and sparring.",
    staminaPct: 15,
  },
  corner_bucket: {
    duration: "permanent", fightScope: "both",
    text: "+10% stamina recovery speed in career bouts and sparring.",
    staminaRecoveryPct: 10,
  },

  // ---------- gym & economy ----------
  ac_blast_i: {
    duration: "24h", fightScope: "career",
    text: "1.5× passive gym income for 24 hours — costs 8% stamina in career bouts.",
    gymIncomeMult: 1.5, staminaPct: -8,
  },
  ac_blast_ii: {
    duration: "24h", fightScope: "career",
    text: "2× passive gym income for 24 hours — costs 7.5% stamina in career bouts.",
    gymIncomeMult: 2, staminaPct: -7.5,
  },
  ac_blast_iii: {
    duration: "24h", fightScope: "both",
    text: "3× passive gym income for 24 hours — costs 5% stamina in career bouts and sparring.",
    gymIncomeMult: 3, staminaPct: -5,
  },
  ac_blast_iv: { duration: "24h", text: "4× passive gym income for 24 hours.", gymIncomeMult: 4 },
  ac_blast_v: { duration: "24h", text: "5× passive gym income for 24 hours.", gymIncomeMult: 5 },
  credit_limit_increase: {
    duration: "permanent",
    text: "The Force counter can now convert to Diamonds — 500,000 Force per Diamond.",
    perk: "diamondConversion",
  },
  challenge_clause: {
    duration: "permanent",
    text: "Grants one extra career reschedule. Stacks — each copy adds another.",
    perk: "extraReschedule",
  },
  import_ticket: {
    duration: "nextSpar",
    text: "Your next sparring session can be against anyone on the active roster, at their level.",
    perk: "importSparring",
  },
  lucky_coin: {
    duration: "permanent",
    text: "1% chance to duplicate any single item reward.",
    luckyCoinChance: 0.01,
  },
};

/** The effect a definition points at, if any. Falls back to matching by item id. */
export function effectOf(def: ItemDefinition | undefined | null): ItemEffect | undefined {
  if (!def) return undefined;
  return ITEM_EFFECTS[def.effectId ?? def.id];
}

export function effectOfId(itemId: string): ItemEffect | undefined {
  return effectOf(getItemDefinition(itemId));
}

/** True when the item is used up on the spot for a grant rather than armed. */
export function isInstantGrant(def: ItemDefinition | undefined | null): boolean {
  return effectOf(def)?.duration === "instant";
}

/** True when the item's effect is simply on for as long as it's owned. */
export function isPermanentEffect(def: ItemDefinition | undefined | null): boolean {
  return effectOf(def)?.duration === "permanent";
}

/** True when the item must be armed from the Locker before it does anything. */
export function isArmable(def: ItemDefinition | undefined | null): boolean {
  const e = effectOf(def);
  if (!e) return false;
  return e.duration !== "instant" && e.duration !== "permanent";
}

// ---------------------------------------------------------------------------
// Duration bookkeeping
// ---------------------------------------------------------------------------

export const AC_BOOST_MS = 24 * 60 * 60 * 1000;

/**
 * Stable id for the fight camp currently being prepared. Camp-scoped boosts are
 * pinned to it, so they lapse the moment the camp ends.
 */
export function campSignature(roster: CareerRosterState | null | undefined): string | null {
  if (!roster) return null;
  const oppId = roster.selectedOpponentId;
  const weeksLeft = roster.prepWeeksRemaining ?? 0;
  if (oppId == null || weeksLeft <= 0) return null;
  return `${oppId}:${roster.weekNumber + weeksLeft}`;
}

/** Is this armed boost still live? Week/camp/24h boosts silently lapse. */
function boostIsLive(
  itemId: string,
  effect: ItemEffect,
  inv: ItemInventory,
  roster: CareerRosterState | null | undefined,
  nowMs: number,
): boolean {
  switch (effect.duration) {
    case "week":
      return (inv.boostWeek?.[itemId] ?? -1) === (roster?.weekNumber ?? -1);
    case "camp": {
      const sig = campSignature(roster);
      return sig != null && inv.boostCamp?.[itemId] === sig;
    }
    case "24h":
      return inv.acBoost?.itemId === itemId && inv.acBoost.expiresAtMs > nowMs;
    default:
      return true;
  }
}

/**
 * Drop every armed boost whose window has closed. Mutates and returns the
 * inventory, and reports whether anything changed so callers can skip the write.
 */
export function pruneExpiredBoosts(
  inv: ItemInventory,
  roster: CareerRosterState | null | undefined,
  nowMs = Date.now(),
): boolean {
  let changed = false;
  for (const itemId of Object.keys(inv.activeBoosts ?? {})) {
    const effect = effectOfId(itemId);
    if (!effect) continue;
    if (boostIsLive(itemId, effect, inv, roster, nowMs)) continue;
    delete inv.activeBoosts[itemId];
    if (inv.boostWeek) delete inv.boostWeek[itemId];
    if (inv.boostCamp) delete inv.boostCamp[itemId];
    changed = true;
  }
  if (inv.acBoost && inv.acBoost.expiresAtMs <= nowMs) {
    inv.acBoost = null;
    changed = true;
  }
  return changed;
}

// ---------------------------------------------------------------------------
// Active-boost resolution
// ---------------------------------------------------------------------------

export interface ActiveBoost {
  def: ItemDefinition;
  effect: ItemEffect;
  /** Copies contributing to the effect (synergy stacks, or owned copies for permanents). */
  stacks: number;
  /** Wall-clock expiry, 24h AC boosts only. */
  expiresAtMs?: number;
  /** Short duration label for the HUD tooltip. */
  durationLabel: string;
  /** Extra tooltip line for effects whose value depends on accrued progress. */
  detail?: string;
}

const DURATION_LABELS: Record<EffectDuration, string> = {
  permanent: "Permanent",
  instant: "Instant",
  nextFight: "Next fight",
  nextWL: "Next weightlifting session",
  nextHB: "Next heavy bag session",
  nextSpar: "Next sparring session",
  week: "This week",
  camp: "This fight camp",
  "24h": "24 hours",
};

function inventoryOf(fighter: Fighter | null | undefined): ItemInventory {
  const inv = (fighter?.itemInventory ?? null) as Partial<ItemInventory> | null;
  // Copies missing from `owned` without a spend receipt were lost, not used, so
  // they count for effects exactly like the locker shows them (see itemLedger).
  const ledger = repairOwnedFromLedger(
    countMap(inv?.owned), countMap(inv?.lifetimeObtained), inv?.itemsSpent,
  );
  return {
    owned: ledger.owned,
    itemsSpent: ledger.itemsSpent,
    lifetimeObtained: inv?.lifetimeObtained ?? {},
    keepsakesReceived: inv?.keepsakesReceived ?? [],
    // Over-cap stacks from an older save never apply (see clampFamilyStacks).
    activeBoosts: clampFamilyStacks(inv?.activeBoosts ?? {}),
    unseenItemIds: inv?.unseenItemIds ?? [],
    boostWeek: inv?.boostWeek ?? {},
    boostCamp: inv?.boostCamp ?? {},
    acBoost: inv?.acBoost ?? null,
    coachNotes: inv?.coachNotes ?? {},
  };
}

/**
 * Every effect currently doing something for this fighter: owned permanents,
 * live armed boosts, and the 24h AC slot.
 */
export function getActiveBoosts(
  fighter: Fighter | null | undefined,
  roster?: CareerRosterState | null,
  nowMs = Date.now(),
): ActiveBoost[] {
  if (!fighter) return [];
  const inv = inventoryOf(fighter);
  const out: ActiveBoost[] = [];
  for (const def of loadItemsConfig()) {
    const effect = effectOf(def);
    if (!effect || effect.duration === "instant") continue;
    if (effect.duration === "permanent") {
      const owned = inv.owned[def.id] ?? 0;
      if (owned > 0) {
        // Coach's Notes has no fixed value — surface what it has actually banked.
        const detail = effect.coachNotesPerSparring
          ? coachNotesSummary(inv)
          : undefined;
        out.push({ def, effect, stacks: owned, durationLabel: DURATION_LABELS.permanent, detail });
      }
      continue;
    }
    if (effect.duration === "24h") {
      if (inv.acBoost?.itemId === def.id && inv.acBoost.expiresAtMs > nowMs) {
        out.push({ def, effect, stacks: 1, expiresAtMs: inv.acBoost.expiresAtMs, durationLabel: DURATION_LABELS["24h"] });
      }
      continue;
    }
    const stacks = inv.activeBoosts[def.id] ?? 0;
    if (stacks <= 0) continue;
    if (!boostIsLive(def.id, effect, inv, roster, nowMs)) continue;
    out.push({ def, effect, stacks, durationLabel: DURATION_LABELS[effect.duration] });
  }
  return out;
}

/** Human-readable list of the stat percentages Coach's Notes has banked. */
function coachNotesSummary(inv: ItemInventory): string | undefined {
  const notes = inv.coachNotes ?? {};
  const parts = COACH_NOTES_STATS
    .map(s => [s, Math.min(COACH_NOTES_CAP, notes[s as string] ?? 0)] as const)
    .filter(([, pct]) => pct > 0)
    .map(([s, pct]) => `${s} +${pct.toFixed(2)}%`);
  return parts.length ? `Banked so far: ${parts.join(", ")}.` : "Nothing banked yet.";
}

/** Tooltip body for a live boost, including its stack count and remaining time. */
export function describeActiveBoost(b: ActiveBoost, nowMs = Date.now()): string {
  const parts = [b.effect.text];
  if (b.detail) parts.push(b.detail);
  if (b.stacks > 1) parts.push(`Active ×${b.stacks}.`);
  if (b.expiresAtMs) {
    const mins = Math.max(0, Math.round((b.expiresAtMs - nowMs) / 60000));
    parts.push(mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m remaining.` : `${mins}m remaining.`);
  } else {
    parts.push(`${b.durationLabel}.`);
  }
  return parts.join(" ");
}

// ---------------------------------------------------------------------------
// Modifier resolution
// ---------------------------------------------------------------------------

export interface FightMods {
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
  forceMult: number;
}

export const NO_FIGHT_MODS: FightMods = {
  powerPct: 0, speedPct: 0, defensePct: 0, staminaPct: 0, focusPct: 0,
  dodgePct: 0, critPct: 0, staminaRecoveryPct: 0, stunChancePct: 0,
  kdAvoidChance: 0, rhythmCutFailChance: 0, forceMult: 1,
};

/** Independent-chance stacking so multiple sources can never exceed 100%. */
function combineChance(a: number, b: number): number {
  return 1 - (1 - a) * (1 - b);
}

/**
 * Combat modifiers for the fight about to start. `sparring` excludes
 * career-only effects (Gummy Candies, most AC stamina penalties).
 */
export function getFightMods(
  fighter: Fighter | null | undefined,
  roster: CareerRosterState | null | undefined,
  opts: { sparring?: boolean } = {},
): FightMods {
  const mods = fightModsFromBoosts(getActiveBoosts(fighter, roster), opts);
  // Coach's Notes accrues a permanent per-stat percentage from camp sparring.
  // It rides the same percentage layer as every other item boost rather than
  // touching stored skill points, so it keeps working past the stat cap.
  mods.powerPct += coachNotesPctFor(fighter, "power") / 100;
  mods.speedPct += coachNotesPctFor(fighter, "speed") / 100;
  mods.defensePct += coachNotesPctFor(fighter, "defense") / 100;
  mods.staminaPct += coachNotesPctFor(fighter, "stamina") / 100;
  mods.focusPct += coachNotesPctFor(fighter, "focus") / 100;
  return mods;
}

// Additive is a family-wide rule, like the rest of synergy: one tier flagged
// Additive makes the whole ladder additive, so a half-migrated config can't
// compound on some tiers and add on others. Resolving that per boost would
// rescan the catalog, so the answer is cached against the catalog array
// `loadItemsConfig` hands back — a saved edit returns a new array and the
// cache rebuilds on the next read.
let additiveCacheFor: ItemDefinition[] | null = null;
let additiveIds: Set<string> = new Set();

function isAdditiveFamily(def: ItemDefinition): boolean {
  const all = loadItemsConfig();
  if (additiveCacheFor !== all) {
    additiveCacheFor = all;
    additiveIds = new Set<string>();
    const byFamily = new Map<string, ItemDefinition[]>();
    for (const d of all) {
      const key = itemFamilyKey(d);
      const list = byFamily.get(key);
      if (list) list.push(d); else byFamily.set(key, [d]);
    }
    for (const members of Array.from(byFamily.values())) {
      // Only synergy members get a vote, matching `getItemFamily`.
      if (!members.some(m => m.synergy && m.synergyAdditive)) continue;
      for (const m of members) additiveIds.add(m.id);
    }
  }
  // An item deleted from the catalog mid-save keeps its own flag.
  return additiveIds.has(def.id) || (def.synergyAdditive === true && !all.some(d => d.id === def.id));
}

/**
 * Combine one effect multiplier across `n` stacks of the same item.
 *
 * The default is compounding: the second copy multiplies the already-multiplied
 * total, so n stacks of a 5× item give 5^n×. A family flagged **Additive** in
 * the Items editor scales linearly instead — two copies of a 5× item read 10×,
 * not 25× — which is how a heavy multiplier stays usable at high stack counts.
 *
 * Only multiplicative effects go through here; percentage and flat effects were
 * always linear in the stack count. A reducing multiplier (< 1) ignores the
 * flag, because m×n would turn a penalty into a bonus.
 */
function stackMult(mult: number, n: number, def: ItemDefinition): number {
  if (n <= 0) return 1;
  return mult >= 1 && isAdditiveFamily(def) ? mult * n : Math.pow(mult, n);
}

/**
 * The combat half of `getFightMods`, working off an already-resolved boost
 * list. Split out so a fighter with no locker behind it — an AI opponent
 * handed items by the Item Distribution config — can be modified the same way.
 */
export function fightModsFromBoosts(
  boosts: ActiveBoost[],
  opts: { sparring?: boolean } = {},
): FightMods {
  const mods: FightMods = { ...NO_FIGHT_MODS };
  for (const b of boosts) {
    const e = b.effect;
    const scope = e.fightScope;
    if (!scope) {
      // Non-combat effect (gym income, perks, training) — only the Force
      // multiplier is fight-facing.
      if (e.forceMult != null) mods.forceMult *= stackMult(e.forceMult, b.stacks, b.def);
      continue;
    }
    if (opts.sparring && scope === "career") continue;
    const n = b.stacks;
    // The effect table stores human-readable whole percentages ("+25% Defense"
    // is 25), while FightMods carries fractions. Normalize exactly once, here.
    // Chance fields are already 0–1 and must not be scaled.
    const pct = n / 100;
    mods.powerPct += (e.powerPct ?? 0) * pct;
    mods.speedPct += (e.speedPct ?? 0) * pct;
    mods.defensePct += (e.defensePct ?? 0) * pct;
    mods.staminaPct += (e.staminaPct ?? 0) * pct;
    mods.focusPct += (e.focusPct ?? 0) * pct;
    mods.dodgePct += (e.dodgePct ?? 0) * pct;
    mods.critPct += (e.critPct ?? 0) * pct;
    mods.staminaRecoveryPct += (e.staminaRecoveryPct ?? 0) * pct;
    mods.stunChancePct += (e.stunChancePct ?? 0) * pct;
    for (let i = 0; i < n; i++) {
      if (e.kdAvoidChance) mods.kdAvoidChance = combineChance(mods.kdAvoidChance, e.kdAvoidChance);
      if (e.rhythmCutFailChance) mods.rhythmCutFailChance = combineChance(mods.rhythmCutFailChance, e.rhythmCutFailChance);
    }
    if (e.forceMult != null) mods.forceMult *= stackMult(e.forceMult, n, b.def);
  }
  return mods;
}

/**
 * Resolve an item-id → stacks map (an AI opponent's rolled kit) into the same
 * boost list the locker produces, so mods and HUD icons share one code path.
 * Unknown ids and effect-less items are dropped.
 */
export function boostsFromItemCounts(counts: Record<string, number> | null | undefined): ActiveBoost[] {
  if (!counts) return [];
  const out: ActiveBoost[] = [];
  for (const def of loadItemsConfig()) {
    const stacks = counts[def.id] ?? 0;
    if (stacks <= 0) continue;
    const effect = effectOf(def);
    if (!effect || effect.duration === "instant") continue;
    out.push({ def, effect, stacks, durationLabel: DURATION_LABELS[effect.duration] });
  }
  return out;
}

/** Force multiplier for the next career win (Fight Surge). */
export function getForceMult(fighter: Fighter | null | undefined, roster?: CareerRosterState | null): number {
  let mult = 1;
  for (const b of getActiveBoosts(fighter, roster)) {
    if (b.effect.forceMult != null) mult *= stackMult(b.effect.forceMult, b.stacks, b.def);
  }
  return mult;
}

export interface TrainingMods {
  xpMult: number;
  spMult: number;
  spFlat: number;
  doubleRepChance: number;
  comboLenReduce: number;
}

export const NO_TRAINING_MODS: TrainingMods = {
  xpMult: 1, spMult: 1, spFlat: 0, doubleRepChance: 0, comboLenReduce: 0,
};

/**
 * Training multipliers for a weightlifting or heavy bag session.
 * `simulateWeek` nullifies Training Frenzy, exactly as the item warns.
 */
export function getTrainingMods(
  fighter: Fighter | null | undefined,
  roster: CareerRosterState | null | undefined,
  type: "weightLifting" | "heavyBag",
  opts: { simulateWeek?: boolean } = {},
): TrainingMods {
  const mods: TrainingMods = { ...NO_TRAINING_MODS };
  for (const b of getActiveBoosts(fighter, roster)) {
    const e = b.effect;
    if (opts.simulateWeek && e.nullifiedBySimulateWeek) continue;
    if (e.duration === "nextWL" && type !== "weightLifting") continue;
    if (e.duration === "nextHB" && type !== "heavyBag") continue;
    const n = b.stacks;
    if (e.trainXpMult != null) mods.xpMult *= stackMult(e.trainXpMult, n, b.def);
    if (e.trainSpMult != null) mods.spMult *= stackMult(e.trainSpMult, n, b.def);
    mods.spFlat += (e.trainSpFlat ?? 0) * n;
    for (let i = 0; i < n; i++) {
      if (e.doubleRepChance) mods.doubleRepChance = combineChance(mods.doubleRepChance, e.doubleRepChance);
    }
    mods.comboLenReduce += (e.comboLenReduce ?? 0) * n;
  }
  return mods;
}

/** Sparring EXP multiplier (Old Bell Hammer, GOAT's Blessing). */
export function getSparringXpMult(fighter: Fighter | null | undefined, roster?: CareerRosterState | null): number {
  let mult = 1;
  for (const b of getActiveBoosts(fighter, roster)) {
    if (b.effect.sparXpMult != null) mult *= stackMult(b.effect.sparXpMult, b.stacks, b.def);
  }
  return mult;
}

/**
 * EXP multiplier for the gym's own sparring modes (Nightmare, Doghouse).
 *
 * Those bouts already burn the next-sparring boosts they use, so they pay the
 * same sparring set an ordinary session does, plus the week-long training
 * boosts that cover the whole gym (Training Frenzy).
 */
export function getGymSparringXpMult(fighter: Fighter | null | undefined, roster?: CareerRosterState | null): number {
  let mult = getSparringXpMult(fighter, roster);
  for (const b of getActiveBoosts(fighter, roster)) {
    if (b.effect.gymSparringXp && b.effect.trainXpMult != null) {
      mult *= stackMult(b.effect.trainXpMult, b.stacks, b.def);
    }
  }
  return mult;
}

/** Sparring stat-point multiplier (Headgear Strap). */
export function getSparringSpMult(fighter: Fighter | null | undefined, roster?: CareerRosterState | null): number {
  let mult = 1;
  for (const b of getActiveBoosts(fighter, roster)) {
    if (b.effect.sparSpMult != null) mult *= stackMult(b.effect.sparSpMult, b.stacks, b.def);
  }
  return mult;
}

/** Flat stat points added to any training reward (Gym Key). */
export function getTrainingSpFlat(fighter: Fighter | null | undefined, roster?: CareerRosterState | null): number {
  let flat = 0;
  for (const b of getActiveBoosts(fighter, roster)) flat += (b.effect.trainSpFlat ?? 0) * b.stacks;
  return flat;
}

/** Passive gym income multiplier from the single live AC boost. */
export function getGymIncomeMult(fighter: Fighter | null | undefined, nowMs = Date.now()): number {
  const inv = inventoryOf(fighter);
  if (!inv.acBoost || inv.acBoost.expiresAtMs <= nowMs) return 1;
  return effectOfId(inv.acBoost.itemId)?.gymIncomeMult ?? 1;
}

/** Does the save own a live item granting this perk? */
export function hasPerk(
  fighter: Fighter | null | undefined,
  perk: NonNullable<ItemEffect["perk"]>,
  roster?: CareerRosterState | null,
): boolean {
  return getActiveBoosts(fighter, roster).some(b => b.effect.perk === perk);
}

/**
 * How many copies of a perk are live — every stack counts, so a second
 * Challenge Clause is a second extra reschedule rather than a no-op.
 */
export function countPerk(
  fighter: Fighter | null | undefined,
  perk: NonNullable<ItemEffect["perk"]>,
  roster?: CareerRosterState | null,
): number {
  return getActiveBoosts(fighter, roster)
    .filter(b => b.effect.perk === perk)
    .reduce((n, b) => n + Math.max(1, b.stacks), 0);
}

/** Combined chance that a single item reward is duplicated (Lucky Coin). */
export function getLuckyCoinChance(fighter: Fighter | null | undefined): number {
  const inv = inventoryOf(fighter);
  let chance = 0;
  for (const [itemId, owned] of Object.entries(inv.owned)) {
    const per = effectOfId(itemId)?.luckyCoinChance;
    if (!per || owned <= 0) continue;
    for (let i = 0; i < owned; i++) chance = combineChance(chance, per);
  }
  return chance;
}

/** Percent-per-camp-sparring permanent growth from Coach's Notes. */
export function getCoachNotesRate(fighter: Fighter | null | undefined): number {
  const inv = inventoryOf(fighter);
  let rate = 0;
  for (const [itemId, owned] of Object.entries(inv.owned)) {
    const per = effectOfId(itemId)?.coachNotesPerSparring;
    if (per && owned > 0) rate += per * owned;
  }
  return rate;
}

export const COACH_NOTES_CAP = 100;
export const COACH_NOTES_STATS: (keyof SkillPoints)[] = ["power", "speed", "defense", "stamina", "focus"];

/** Coach's Notes accrued percent for a stat, capped. */
export function coachNotesPctFor(fighter: Fighter | null | undefined, stat: keyof SkillPoints): number {
  const notes = inventoryOf(fighter).coachNotes ?? {};
  return Math.min(COACH_NOTES_CAP, notes[stat as string] ?? 0);
}
