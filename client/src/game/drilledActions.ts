/**
 * DRILLED ACTIONS
 * ===============
 *
 * The player's own half of the pattern game. The AI keeps a tape of the
 * combinations it catches the player repeating; this is the combinations the
 * player has deliberately grooved, and what grooving one buys them.
 *
 * A drilled action is three links long -- the same three-action chunk the AI
 * memorizes -- and it is tokenized with exactly the same vocabulary, so the two
 * systems can never disagree about what "the same punch" is. Everything else
 * about them is separate, and in one respect they are mirror images:
 *
 *   the AI tape   is written by career bouts and never by gym work.
 *   drilled work  is counted by gym sparring and never by a career bout.
 *
 * The buffs a drilled string earns apply everywhere, career bouts included.
 * Drill it in the gym, cash it in on fight night.
 *
 * The entry key is the three action tokens ALONE -- deliberately not the tape's
 * `context#actions` key. A drilled combination is the same combination whatever
 * the opponent happened to do just before it, and folding context in would
 * shatter one combination into dozens of variants, none of which would ever
 * reach the two repeats it takes to be listed.
 */

import { PUNCH_CONFIGS } from "./types";
import { parseActionToken, PATTERN_LENGTH, type ParsedAction } from "./aiPatterns";

// ===== CONFIG =================================================================
//
// Every tunable number the feature has, in one block. There is no tuning card
// for it yet; the point of keeping them together is that adding one later is a
// UI job and not an archaeology job.

export interface DrilledActionConfig {
  /** Links thrown from further out than this are not drilling, and a string
   *  being built does not survive stepping outside it. */
  observeRangePx: number;
  /** Successes a string needs before it is listed at all. Below this it is an
   *  unlisted candidate. */
  listThreshold: number;
  /** Entries kept on the career save; the weakest is evicted when full. */
  listCap: number;
  /** Ceiling on a single string's success count. */
  sharpnessCap: number;
  /** Sharpness the closing-punch buffs switch on at. */
  buffSharpness: number;
  /** Label-only rung between the buffs switching on and the closing punch going
   *  free. It grants nothing of its own -- the closing bonuses scale per rep, so
   *  this just marks the point where they have grown into real numbers. */
  sharpTierSharpness: number;
  /** Added stun chance per success, and its ceiling. */
  stunPerSuccess: number;
  stunBonusCap: number;
  /** Added crit chance per success, and its ceiling. */
  critPerSuccess: number;
  critBonusCap: number;
  // There is deliberately no per-rep damage ramp. Stun and crit climb with every
  // repetition; damage does not climb at all. It is a single flat mastery perk --
  // see the two `mastery*PowerBonus` keys -- so the only way to hit harder with a drilled
  // combination is to master it outright.
  /** Sharpness at which the closing punch stops costing stamina. */
  freeStaminaSharpness: number;
  /** How long a landed free closing punch pauses the burst-cost count for. */
  staminaPenaltyPauseSec: number;
  /** Sharpness at which finishing the string opens the dodge window. Held equal
   *  to `masterySharpness` on purpose: the dodge window is a mastery perk, not a
   *  rung of its own. The check script asserts the two stay together. */
  dodgeSharpness: number;
  /** Chance the window gives the player to slip a punch outright. */
  dodgeChance: number;
  /** How long the window stays open. */
  dodgeWindowSec: number;
  /** Sharpness at which the string's OPENING punch is mastered. */
  masterySharpness: number;
  /** Animation speed multiplier for a mastered opener: 1.5 = 50% faster. */
  masteryPunchSpeedMult: number;
  /** Added crit chance on a mastered opener. */
  masteryCritBonus: number;
  /** Added damage percentage on the two end punches of a MASTERED combination,
   *  and the only source of drilled damage there is. `+0.2` is 1.2x, `+0.5` is
   *  1.5x. The closer is the bigger of the two on purpose: it is the punch the
   *  whole combination is built to set up. A punch that is at once a mastered
   *  opener and a mastered closer takes the better of the two, never the sum. */
  masteryOpenerPowerBonus: number;
  masteryCloserPowerBonus: number;

  // --- PRACTICE UPKEEP --------------------------------------------------------
  //
  // Sharpness only ever goes up; rehearsal is the half that rots. A drilled
  // string the player has stopped throwing gets expensive to throw -- its
  // closing punch pays a multiple of its normal stamina -- and the only way
  // back down the ladder is to keep working it.

  /** Stamina multipliers charged on a drilled string's CLOSING punch, worst
   *  first. Index 0 is what a string nobody has rehearsed pays; the last entry
   *  is the floor a fully rehearsed one reaches. A practised week moves a
   *  string one step toward the floor and a neglected week past its grace
   *  moves it one step back, so the ladder's length IS the number of weeks
   *  either journey takes. */
  staminaLadder: number[];
  /** SPARRING throws of the same string inside one career week that earn a rung
   *  down the ladder. Throws, not landings -- rehearsal is the act of throwing.
   *  Improving a string is gym work and gym work only. */
  practiceThrowsPerWeek: number;
  /** Throws inside one career week -- in ANY bout, gym or career -- that hold a
   *  string where it is. Keeping a combination is a far lower bar than
   *  improving it: use it in a real fight and it does not rust. */
  maintenanceThrowsPerWeek: number;
  /** Neglected weeks a string is allowed before it starts sliding back. */
  decayGraceWeeks: number;
  /** Lifetime repetitions that buy one extra week of grace. */
  repsPerDecayBufferWeek: number;
  /** Ceiling on the grace weeks sheer volume can buy. */
  decayBufferWeeksMax: number;
}

export const DRILLED_ACTION_CONFIG: DrilledActionConfig = {
  observeRangePx: 90,
  listThreshold: 2,
  listCap: 1000,
  sharpnessCap: 3000,
  buffSharpness: 20,
  sharpTierSharpness: 100,
  stunPerSuccess: 0.0005,
  stunBonusCap: 0.30,
  critPerSuccess: 0.0005,
  critBonusCap: 0.30,
  freeStaminaSharpness: 200,
  staminaPenaltyPauseSec: 1.0,
  dodgeSharpness: 3000,
  dodgeChance: 0.50,
  dodgeWindowSec: 1.0,
  // Mastery sits exactly ON the cap on purpose: the top tier is "this string is
  // as sharp as a string can get". It moves whenever sharpnessCap moves.
  masterySharpness: 3000,
  masteryPunchSpeedMult: 1.5,
  masteryCritBonus: 0.30,
  masteryOpenerPowerBonus: 0.2,
  masteryCloserPowerBonus: 0.5,
  staminaLadder: [3, 2, 1, 0.5],
  practiceThrowsPerWeek: 2,
  maintenanceThrowsPerWeek: 1,
  decayGraceWeeks: 3,
  repsPerDecayBufferWeek: 50,
  decayBufferWeeksMax: 999,
};

/** A string is this many links long. Shared with the AI tape on purpose. */
export const DRILLED_LENGTH = PATTERN_LENGTH;

// ===== ENTRIES ================================================================

/**
 * One drilled string: how sharp it is, and how well rehearsed.
 *
 * The two are separate clocks on purpose. Sharpness only ever climbs and is
 * bought with landed reps in the gym. Rehearsal rots, is measured in throws
 * rather than landings, and counts wherever the string is thrown.
 *
 * The upkeep fields are all optional and absent means zero, so every save
 * written before the upkeep clock existed reads back as an unrehearsed string
 * with a clean sheet rather than needing a migration of its own.
 */
export interface DrilledActionEntry {
  /** The three tokens joined. Identity -- no context, by design. */
  key: string;
  acts: string[];
  /** Success count, which IS the sharpness. */
  n: number;
  /** Index into `staminaLadder`: how rehearsed the string currently is, 0 being
   *  not at all. Moves at most one rung per career week. */
  st?: number;
  /** SPARRING throws banked toward this career week's improvement quota -- the
   *  bar for moving a rung DOWN the ladder. Zeroed every week. */
  wt?: number;
  /** Throws banked this career week in ANY bout, gym or career, toward the much
   *  lower bar that merely holds the string where it is. Zeroed every week. */
  wu?: number;
  /** Consecutive career weeks even the maintenance bar went unmet. */
  dw?: number;
}

/** The three tokens as one comparable string. */
export function drilledActionKey(acts: string[]): string {
  return acts.join("|");
}

/** A saved blob read back as entries, dropping anything malformed. */
export function normalizeDrilledActions(
  entries: DrilledActionEntry[] | undefined | null,
  cfg: DrilledActionConfig = DRILLED_ACTION_CONFIG,
): DrilledActionEntry[] {
  if (!Array.isArray(entries)) return [];
  const out: DrilledActionEntry[] = [];
  const seen = new Set<string>();
  for (const e of entries) {
    if (!e || !Array.isArray(e.acts) || e.acts.length !== DRILLED_LENGTH) continue;
    if (!e.acts.every(a => typeof a === "string" && a.length > 0)) continue;
    const n = Math.max(0, Math.min(cfg.sharpnessCap, Math.floor(Number(e.n) || 0)));
    if (n <= 0) continue;
    const key = drilledActionKey(e.acts);
    if (seen.has(key)) continue;
    seen.add(key);
    const topRung = Math.max(0, cfg.staminaLadder.length - 1);
    const st = Math.max(0, Math.min(topRung, Math.floor(Number(e.st) || 0)));
    const wt = Math.max(0, Math.min(cfg.practiceThrowsPerWeek, Math.floor(Number(e.wt) || 0)));
    const wu = Math.max(0, Math.min(cfg.maintenanceThrowsPerWeek, Math.floor(Number(e.wu) || 0)));
    const dw = Math.max(0, Math.floor(Number(e.dw) || 0));
    out.push({ key, acts: [...e.acts], n, st, wt, wu, dw });
  }
  return sortDrilledActions(out).slice(0, cfg.listCap);
}

/** Success count first, so the most-landed string is always on top. */
export function sortDrilledActions(entries: DrilledActionEntry[]): DrilledActionEntry[] {
  return [...entries].sort((a, b) => (b.n - a.n) || a.key.localeCompare(b.key));
}

/**
 * What the player actually sees. Candidates -- strings landed once and never
 * repeated -- are stored so the second success can find them, but they are not
 * a drilled action yet and are not listed.
 */
export function listedDrilledActions(
  entries: DrilledActionEntry[],
  cfg: DrilledActionConfig = DRILLED_ACTION_CONFIG,
): DrilledActionEntry[] {
  return sortDrilledActions(entries.filter(e => e.n >= cfg.listThreshold));
}

/**
 * Credit one repetition of a string, returning the new collection.
 *
 * A string not seen before is stored as a candidate at 1; its second success is
 * the promotion that puts it on the list. When the store is full the weakest
 * entry goes -- candidates first, since they are the lowest counts there are.
 */
export function creditDrilledAction(
  entries: DrilledActionEntry[],
  acts: string[],
  cfg: DrilledActionConfig = DRILLED_ACTION_CONFIG,
): DrilledActionEntry[] {
  if (!Array.isArray(acts) || acts.length !== DRILLED_LENGTH) return entries;
  const key = drilledActionKey(acts);
  const idx = entries.findIndex(e => e.key === key);
  if (idx >= 0) {
    const hit = entries[idx];
    if (hit.n >= cfg.sharpnessCap) return entries;
    const next = [...entries];
    next[idx] = { ...hit, n: Math.min(cfg.sharpnessCap, hit.n + 1) };
    return next;
  }
  const next = [...entries, { key, acts: [...acts], n: 1 }];
  if (next.length <= cfg.listCap) return next;
  // Full, so the weakest entry goes. A tie breaks toward the OLDEST rather than
  // a key comparison: a full store of never-repeated candidates would otherwise
  // refuse every newcomer whose key happened to sort late, and those strings
  // could never reach the second success it takes to be listed at all.
  let weakest = 0;
  for (let i = 1; i < next.length; i++) {
    if (next[i].n < next[weakest].n) weakest = i;
  }
  return next.filter((_, i) => i !== weakest);
}

/** How sharp a string is right now. 0 when it has never been landed. */
export function drilledSharpnessOf(entries: DrilledActionEntry[], acts: string[]): number {
  const key = drilledActionKey(acts);
  const hit = entries.find(e => e.key === key);
  return hit ? hit.n : 0;
}

/**
 * The opening tokens of every fully mastered string.
 *
 * Mastery lives on the punch a string OPENS with, not on the string, so this is
 * the set the throw path checks a punch against.
 */
export function drilledMasteryOpeners(
  entries: DrilledActionEntry[],
  cfg: DrilledActionConfig = DRILLED_ACTION_CONFIG,
): string[] {
  const out: string[] = [];
  for (const e of entries) {
    if (e.n < cfg.masterySharpness) continue;
    const opener = e.acts[0];
    if (opener && !out.includes(opener)) out.push(opener);
  }
  return out;
}

// ===== SHARPNESS CURVE ========================================================

/** Everything one success count buys the punch that closes the string. */
export interface DrilledClosingBuffs {
  /** The success count this was derived from. */
  sharpness: number;
  /** Added stun chance, as a fraction. */
  stunBonus: number;
  /** Added crit chance, as a fraction. */
  critBonus: number;
  /** Added damage percentage, as a fraction. Mastery-only: it is 0 at every
   *  sharpness below the mastery threshold and jumps straight to the flat
   *  mastery bonus at it. There is no ramp. */
  powerBonus: number;
  /** The closing punch costs nothing and pauses the burst count when it lands. */
  freeStamina: boolean;
  /** Completing the string opens the post-string dodge window. */
  opensDodgeWindow: boolean;
}

/** No string, or one too blunt to do anything. */
export const NO_DRILLED_CLOSING: DrilledClosingBuffs = {
  sharpness: 0,
  stunBonus: 0,
  critBonus: 0,
  powerBonus: 0,
  freeStamina: false,
  opensDodgeWindow: false,
};

/**
 * The whole curve in one place: one success count in, every effect out.
 *
 * Below the switch-on point a string is remembered and listed but does nothing,
 * which is what makes the first twenty repetitions feel like work.
 */
export function drilledClosingBuffs(
  sharpness: number,
  cfg: DrilledActionConfig = DRILLED_ACTION_CONFIG,
): DrilledClosingBuffs {
  const s = Math.max(0, Math.min(cfg.sharpnessCap, Math.floor(sharpness)));
  if (s < cfg.buffSharpness) return NO_DRILLED_CLOSING;
  return {
    sharpness: s,
    stunBonus: Math.min(cfg.stunBonusCap, cfg.stunPerSuccess * s),
    critBonus: Math.min(cfg.critBonusCap, cfg.critPerSuccess * s),
    // Damage does not ramp. A string is worth nothing extra in power until it
    // is mastered, and then its closer is worth the flat mastery bonus.
    powerBonus: s >= cfg.masterySharpness ? cfg.masteryCloserPowerBonus : 0,
    freeStamina: s >= cfg.freeStaminaSharpness,
    opensDodgeWindow: s >= cfg.dodgeSharpness,
  };
}

/**
 * The one place a drilled damage multiplier is decided.
 *
 * Mastering a string is the whole of drilled damage: it makes the string's two
 * end punches hit harder -- the closer by more than the opener -- and nothing
 * else in the system touches power at all. Below mastery a string is worth stun,
 * crit, cheap stamina and a slip window, but never a harder punch.
 *
 * The two terms are combined with MAX rather than a sum, so a punch that is at
 * once a mastered opener and a mastered closer takes the better of the two and
 * never both. That matters now that the two are tuned apart: such a punch reads
 * as the closer it is, rather than quietly becoming the strongest punch in the
 * game for standing in two places at once.
 */
export function drilledPowerBonus(
  closing: DrilledClosingBuffs | null | undefined,
  mastered: boolean,
  cfg: DrilledActionConfig = DRILLED_ACTION_CONFIG,
): number {
  const bonus = Math.max(closing?.powerBonus ?? 0, mastered ? cfg.masteryOpenerPowerBonus : 0);
  return Math.max(0, bonus);
}

/**
 * The same figure as a ready-made multiplier. The engine does NOT use this —
 * drilled power is a summand in the fighter's additive power pool, not a factor
 * of its own — but it keeps the standalone value readable for checks and UI.
 */
export function drilledPowerMult(
  closing: DrilledClosingBuffs | null | undefined,
  mastered: boolean,
  cfg: DrilledActionConfig = DRILLED_ACTION_CONFIG,
): number {
  return 1 + drilledPowerBonus(closing, mastered, cfg);
}

/** Which tier a string has reached, for the progress panel. */
export function drilledTierLabel(
  sharpness: number,
  cfg: DrilledActionConfig = DRILLED_ACTION_CONFIG,
): string {
  if (sharpness >= cfg.masterySharpness) return "Mastered";
  if (sharpness >= cfg.freeStaminaSharpness) return "Effortless";
  if (sharpness >= cfg.sharpTierSharpness) return "Sharp";
  if (sharpness >= cfg.buffSharpness) return "Good";
  return "Rough";
}

/** The next tier's threshold, or null once the string is mastered. */
export function drilledNextTierAt(
  sharpness: number,
  cfg: DrilledActionConfig = DRILLED_ACTION_CONFIG,
): number | null {
  for (const step of [cfg.buffSharpness, cfg.sharpTierSharpness, cfg.freeStaminaSharpness, cfg.masterySharpness]) {
    if (sharpness < step) return step;
  }
  return null;
}

// ===== PRACTICE UPKEEP ========================================================
//
// The half of a drilled string that rots. Sharpness is what the string is
// worth; rehearsal is what it costs to throw, and it is the only drilled number
// that can go backwards.
//
// Two rules keep the clocks apart, and neither is an accident:
//
//   sharpness  is bought by LANDING the string, in gym sparring only.
//   rehearsal  is bought by THROWING it, and splits into two bars:
//
//     IMPROVING a string -- moving a rung down toward half price -- takes the
//     full quota of throws in GYM SPARRING inside one career week, and takes it
//     again every week the player wants another rung.
//
//     HOLDING a string where it is takes a single throw in ANY bout, career
//     fights included, and buys three weeks of quiet.
//
// So a real fight keeps a combination from rusting but can never sharpen it or
// make it cheaper -- the same "drill it in the gym, cash it in on fight night"
// split the buffs already run on, pointed the other way.

/** Grace weeks a string's sheer volume has bought it. */
export function drilledDecayBufferWeeks(
  n: number,
  cfg: DrilledActionConfig = DRILLED_ACTION_CONFIG,
): number {
  const reps = Math.max(0, Math.floor(Number(n) || 0));
  if (cfg.repsPerDecayBufferWeek <= 0) return 0;
  return Math.min(cfg.decayBufferWeeksMax, Math.floor(reps / cfg.repsPerDecayBufferWeek));
}

/** Neglected weeks a string survives before it starts sliding back down. */
export function drilledGraceWeeks(
  n: number,
  cfg: DrilledActionConfig = DRILLED_ACTION_CONFIG,
): number {
  return cfg.decayGraceWeeks + drilledDecayBufferWeeks(n, cfg);
}

/** What one rung of the ladder charges the closing punch. */
export function drilledStaminaMultForTier(
  tier: number,
  cfg: DrilledActionConfig = DRILLED_ACTION_CONFIG,
): number {
  const ladder = cfg.staminaLadder;
  if (!ladder.length) return 1;
  const i = Math.max(0, Math.min(ladder.length - 1, Math.floor(Number(tier) || 0)));
  return ladder[i];
}

/**
 * The stamina multiplier a string's closing punch is paying right now.
 *
 * Only a LISTED string is a drilled action, so the surcharge starts where the
 * list does. A combination thrown once and never repeated is not something the
 * player has committed to and is billed as three ordinary punches -- otherwise
 * every improvised three-action flurry in the game would quietly cost triple.
 */
export function drilledStaminaMultOf(
  entries: DrilledActionEntry[] | undefined | null,
  acts: string[],
  cfg: DrilledActionConfig = DRILLED_ACTION_CONFIG,
): number {
  if (!Array.isArray(entries)) return 1;
  const key = drilledActionKey(acts);
  const hit = entries.find(e => e.key === key);
  if (!hit || hit.n < cfg.listThreshold) return 1;
  return drilledStaminaMultForTier(hit.st ?? 0, cfg);
}

/**
 * Roll every drilled string's rehearsal clock forward exactly one career week.
 *
 * Called once from the weekly simulation, which never advances more than a
 * single week at a time -- so this steps rather than catching up, and the
 * week's throw tallies are consumed here and nowhere else.
 *
 * Three outcomes, in priority order:
 *
 *   the sparring quota was met  -- a rung down, and the dry streak is wiped.
 *   the string was thrown at all -- held exactly where it is, streak wiped.
 *   neither                      -- the streak grows, and every week past the
 *                                   string's grace period costs it a rung back.
 *
 * Because the improvement lands at week rollover, the week the work went in is
 * still billed at the old rate and the discount shows up the week after. That
 * is deliberate: it makes the ladder feel like upkeep rather than a switch the
 * player flips inside a session.
 */
export function advanceDrilledWeek(
  entries: DrilledActionEntry[] | undefined | null,
  cfg: DrilledActionConfig = DRILLED_ACTION_CONFIG,
): DrilledActionEntry[] {
  if (!Array.isArray(entries) || entries.length === 0) return [];
  const topRung = Math.max(0, cfg.staminaLadder.length - 1);
  return entries.map(e => {
    const sparred = Math.max(0, Math.floor(e.wt ?? 0));
    const used = Math.max(0, Math.floor(e.wu ?? 0));
    let st = Math.max(0, Math.min(topRung, Math.floor(e.st ?? 0)));
    let dw = Math.max(0, Math.floor(e.dw ?? 0));
    if (sparred >= cfg.practiceThrowsPerWeek) {
      st = Math.min(topRung, st + 1);
      dw = 0;
    } else if (used >= cfg.maintenanceThrowsPerWeek) {
      dw = 0;
    } else {
      // Capped at the point where it can do no more damage -- the streak only
      // has to outlast the grace period plus one rung per remaining step, and
      // an abandoned string would otherwise carry a number that climbs forever.
      const grace = drilledGraceWeeks(e.n, cfg);
      dw = Math.min(dw + 1, grace + topRung + 1);
      if (dw > grace) st = Math.max(0, st - 1);
    }
    return { ...e, st, dw, wt: 0, wu: 0 };
  });
}

/** Everything the progress panel needs about one string's rehearsal. */
export interface DrilledUpkeep {
  /** Stamina multiplier the closing punch is paying right now. */
  staminaMult: number;
  /** Sparring throws banked toward this week's improvement quota. */
  sparred: number;
  /** Sparring throws the improvement quota asks for. */
  quota: number;
  /** The improvement quota is met: the string drops a rung at rollover. */
  improving: boolean;
  /** Thrown at all this week, in any bout, so the decay clock stays parked. */
  maintained: boolean;
  /** Consecutive weeks the string went untouched. */
  dryWeeks: number;
  /** The dry streak has hit its cap and stopped counting, so `dryWeeks` is a
   *  floor rather than the real figure -- show it as "8+ weeks", not "8". */
  dryCapped: boolean;
  /** Weeks of neglect this string survives before it slides back. */
  graceWeeks: number;
  /** Untouched weeks still in hand before the slide starts. */
  weeksBeforeDecay: number;
  /** The string is already as cheap as the ladder goes. */
  atFloor: boolean;
}

export function drilledUpkeepOf(
  entry: DrilledActionEntry,
  cfg: DrilledActionConfig = DRILLED_ACTION_CONFIG,
): DrilledUpkeep {
  const sparred = Math.max(0, Math.floor(entry.wt ?? 0));
  const used = Math.max(0, Math.floor(entry.wu ?? 0));
  const dryWeeks = Math.max(0, Math.floor(entry.dw ?? 0));
  const graceWeeks = drilledGraceWeeks(entry.n, cfg);
  const topRung = Math.max(0, cfg.staminaLadder.length - 1);
  return {
    staminaMult: drilledStaminaMultOf([entry], entry.acts, cfg),
    sparred,
    quota: cfg.practiceThrowsPerWeek,
    improving: sparred >= cfg.practiceThrowsPerWeek,
    maintained: used >= cfg.maintenanceThrowsPerWeek,
    dryWeeks,
    dryCapped: dryWeeks >= graceWeeks + topRung + 1,
    graceWeeks,
    weeksBeforeDecay: Math.max(0, graceWeeks - dryWeeks),
    atFloor: Math.max(0, Math.min(topRung, Math.floor(entry.st ?? 0))) >= topRung,
  };
}

// ===== READOUT ================================================================

const PUNCH_FAMILY: Record<string, string> = {
  jab: "Jab",
  cross: "Cross",
  leftHook: "Hook",
  rightHook: "Hook",
  leftUppercut: "Uppercut",
  rightUppercut: "Uppercut",
};

/**
 * A link named the way a boxer would name it.
 *
 * Punch names are absolute in this engine: a jab is always the left glove and a
 * cross always the right, in both stances (keys map to gloves, not roles). So a
 * southpaw's lead-hand punch is internally a `cross`
 * and has to read as "Right Jab", while their rear hand reads as "Left Cross".
 * That remapping is exactly what makes the four jab/cross variants four
 * distinct drilled actions rather than two, so the readout has to show it --
 * unlike the AI overlay, which prints absolute names and leaves stance off.
 *
 * Hooks and uppercuts carry their glove in the name already and have no
 * lead/rear alias, so they are just glove plus family.
 */
export function describeDrilledLink(token: string): string {
  const act: ParsedAction = parseActionToken(token);
  if (act.kind === "charge") return "Armed Charge";
  if (act.kind === "duck") return "Duck";
  if (!act.punch) return "?";

  const cfg = PUNCH_CONFIGS[act.punch];
  const hand = cfg ? (cfg.isLeft ? "Left" : "Right") : (act.hand === "left" ? "Left" : "Right");
  let family = PUNCH_FAMILY[act.punch] ?? String(act.punch);
  if (act.punch === "jab" || act.punch === "cross") {
    // Lead hand throws the jab, rear hand throws the cross -- whichever glove
    // that happens to be in this stance.
    const leadIsLeft = act.stance !== "southpaw";
    const thrownByLead = cfg ? cfg.isLeft === leadIsLeft : true;
    family = thrownByLead ? "Jab" : "Cross";
  }

  const name = `${hand} ${family}`;
  if (act.kind === "feint") return `${name} Feint`;
  return act.head ? name : `${name} (Body)`;
}

/** The whole string on one line, in the order it gets thrown. */
export function describeDrilledAction(acts: string[]): string {
  return acts.map(describeDrilledLink).join(" \u203a ");
}

// ===== IN-BOUT STATE ==========================================================

/** A resolved string waiting to find out whether it made contact. */
export interface DrilledPending {
  acts: string[];
  /** The thrower's punch counter at the moment the closer went out, so a later
   *  unrelated punch can never settle this string. */
  closerPunchId: number;
  /** Some punch in the string reached the opponent. */
  landed: boolean;
  /** The closer has reported; settle at the end of this tick. */
  ready: boolean;
}

/**
 * Everything drilling needs during a bout, hung off the player's fighter state.
 *
 * It lives on the fighter rather than the game state because the throw path --
 * where the closing bundle has to be stamped, before the stamina for the punch
 * is charged -- has the fighter in hand and no ambient state reference.
 */
export interface DrilledFightState {
  /** The career collection, candidates included. Rebuilt on every credit. */
  entries: DrilledActionEntry[];
  /** Opening tokens of mastered strings, kept in step with `entries`. */
  mastery: string[];
  /** Gym sparring only: the one place a counter may move. Buffs do not care. */
  recording: boolean;
  /** The three-link window being built. */
  window: string[];
  /** A punch already in the window reached the opponent. */
  windowLanded: boolean;
  /** The resolved string awaiting its closer's outcome. */
  pending: DrilledPending | null;
  /** Rising-edge trackers for the held actions. */
  prevCharge: boolean;
  prevDuck: boolean;
  /** A repetition was credited this bout, so the save is worth rewriting. */
  dirty: boolean;
}

export function createDrilledFightState(
  entries: DrilledActionEntry[],
  recording: boolean,
  cfg: DrilledActionConfig = DRILLED_ACTION_CONFIG,
): DrilledFightState {
  const normalized = normalizeDrilledActions(entries, cfg);
  return {
    entries: normalized,
    mastery: drilledMasteryOpeners(normalized, cfg),
    recording,
    window: [],
    windowLanded: false,
    pending: null,
    prevCharge: false,
    prevDuck: false,
    dirty: false,
  };
}

/** Drop the combination in progress. Nothing spans a bell, a knockdown, or the
 *  player backing out of range. */
export function clearDrilledWindow(ds: DrilledFightState): void {
  ds.window = [];
  ds.windowLanded = false;
  ds.pending = null;
}

/** Credit a repetition in place, keeping the mastery set in step. */
export function applyDrilledSuccess(
  ds: DrilledFightState,
  acts: string[],
  cfg: DrilledActionConfig = DRILLED_ACTION_CONFIG,
): void {
  const before = ds.entries;
  ds.entries = creditDrilledAction(before, acts, cfg);
  if (ds.entries === before) return;
  ds.mastery = drilledMasteryOpeners(ds.entries, cfg);
  ds.dirty = true;
}

/** What the punch about to be thrown is worth, if it closes a known string. */
export function drilledClosingFor(
  ds: DrilledFightState,
  token: string,
  cfg: DrilledActionConfig = DRILLED_ACTION_CONFIG,
): DrilledClosingBuffs {
  if (ds.window.length !== DRILLED_LENGTH - 1) return NO_DRILLED_CLOSING;
  return drilledClosingBuffs(drilledSharpnessOf(ds.entries, [...ds.window, token]), cfg);
}

/**
 * What the punch about to be thrown COSTS, if it closes a known string.
 *
 * Deliberately not folded into the closing bundle above: that bundle is gated
 * behind `buffSharpness` and returns nothing at all below it, while the upkeep
 * surcharge has to bite from the moment a string is listed. A string sitting
 * between the two thresholds is a real drilled action the player has not earned
 * anything for yet, and it is exactly the one that should feel expensive.
 */
export function drilledStaminaMultFor(
  ds: DrilledFightState,
  token: string,
  cfg: DrilledActionConfig = DRILLED_ACTION_CONFIG,
): number {
  if (ds.window.length !== DRILLED_LENGTH - 1) return 1;
  return drilledStaminaMultOf(ds.entries, [...ds.window, token], cfg);
}

/**
 * Bank one throw of a string against this career week's two rehearsal bars.
 *
 * Throws, not landings. The maintenance tally takes the throw wherever it
 * happened, career bouts included -- it is the one drilled counter not gated on
 * `recording` -- while the improvement quota takes it only in the gym, since
 * `recording` is exactly the gym-sparring scope.
 *
 * A string with no entry yet is ignored: rehearsal maintains a drilled action
 * and cannot create one, which stays the job of landing it twice in the gym.
 *
 * Both tallies stop at their bar, so an abandoned career's save cannot carry an
 * ever-growing count on a string that only ever needed two.
 */
export function noteDrilledThrow(
  ds: DrilledFightState,
  acts: string[],
  cfg: DrilledActionConfig = DRILLED_ACTION_CONFIG,
): void {
  const key = drilledActionKey(acts);
  const idx = ds.entries.findIndex(e => e.key === key);
  if (idx < 0) return;
  const hit = ds.entries[idx];
  const sparred = Math.max(0, Math.floor(hit.wt ?? 0));
  const used = Math.max(0, Math.floor(hit.wu ?? 0));
  const nextSparred = ds.recording ? Math.min(cfg.practiceThrowsPerWeek, sparred + 1) : sparred;
  const nextUsed = Math.min(cfg.maintenanceThrowsPerWeek, used + 1);
  if (nextSparred === sparred && nextUsed === used) return;
  const next = [...ds.entries];
  next[idx] = { ...hit, wt: nextSparred, wu: nextUsed };
  ds.entries = next;
  ds.dirty = true;
}
