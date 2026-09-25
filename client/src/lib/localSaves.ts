import type { Fighter, InsertFighter, FightResult, InsertFightResult, ItemInventory } from "@shared/schema";
import { DEFAULT_GEAR_COLORS } from "@shared/schema";
import { loadXpConfig, saveXpConfig, XP_CONFIG_KEY, type XpConfig } from "@/lib/xpConfig";
import { clampPassiveClock } from "@/game/gymIncome";
import { reloadScaling } from "@/lib/scalingConfig";

const SAVES_KEY = "handz_saves";
const FIGHT_RESULTS_KEY = "handz_fight_results";

function generateId(): string {
  return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

function loadSaves(): Fighter[] {
  try {
    const raw = localStorage.getItem(SAVES_KEY);
    const fighters: Fighter[] = raw ? JSON.parse(raw) : [];
    // A stale writer could subtract more stat points than the fighter had and
    // leave the pool negative, which then blocks every spend (exchange, allocate)
    // forever. Heal it on read so an existing career recovers without a reset.
    for (const f of fighters) {
      if ((f.availableStatPoints ?? 0) < 0) f.availableStatPoints = 0;
    }
    return fighters;
  } catch {
    return [];
  }
}

function persistSaves(fighters: Fighter[]): void {
  localStorage.setItem(SAVES_KEY, JSON.stringify(fighters));
}

function loadFightResults(): FightResult[] {
  try {
    const raw = localStorage.getItem(FIGHT_RESULTS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function persistFightResults(results: FightResult[]): void {
  localStorage.setItem(FIGHT_RESULTS_KEY, JSON.stringify(results));
}

export function getFighters(): Fighter[] {
  return loadSaves();
}

export function getFighter(id: string): Fighter | undefined {
  return loadSaves().find(f => f.id === id);
}

/**
 * Progress that lives outside the fighter record but still belongs to one
 * career. Items, item effects and training high scores all ride on the fighter
 * itself, so a new fighter id already starts them empty — these browser-level
 * leftovers are the only way old progress can bleed into a fresh save.
 */
const CROSS_SAVE_PROGRESS_KEYS = [
  "handz_gym_state",          // gym equipment levels / passive Force production
  "handz_player_playstyle",   // learned playstyle profile
  "handz_champ_beaten_wl",    // weightlifting auto-lift speed-up
  "handz_pending_alloc",      // stat points owed from an interrupted session
  "handz_fight_boost_escrow", // boosts armed for a bout that never concluded
] as const;

/** Wipe every scrap of career progress held outside the fighter record. */
export function clearCrossSaveProgress(): void {
  for (const key of CROSS_SAVE_PROGRESS_KEYS) {
    try { localStorage.removeItem(key); } catch {}
  }
}

/**
 * The Skill Refinement case wears a "new" dot from the moment it unlocks until
 * the player looks inside it once. Every route that shows the refinement screen
 * calls this, so the dot cannot survive a viewing through a side door.
 */
export function markRefinementCaseSeen(fighterId: string): Fighter | undefined {
  const fighter = getFighter(fighterId);
  const roster = fighter?.careerRosterState as { refinementCaseSeen?: boolean } | null | undefined;
  if (!fighter || !roster || roster.refinementCaseSeen) return fighter;
  return updateFighter(fighterId, {
    careerRosterState: { ...roster, refinementCaseSeen: true },
  } as Partial<InsertFighter>);
}

/**
 * Record the Punch Endurance pair the player has now had on screen, so the gym
 * meter flashes any change exactly once.
 *
 * Writes only when a number actually moved: an unchanged pair must not cost a
 * save write on every visit to the gym.
 */
export function markPunchEnduranceSeen(
  fighterId: string,
  punchEndurance: number,
  punchEnduranceLoss: number,
): Fighter | undefined {
  const fighter = getFighter(fighterId);
  const roster = fighter?.careerRosterState as
    { punchEnduranceSeen?: number; punchEnduranceLossSeen?: number } | null | undefined;
  if (!fighter || !roster) return fighter;
  if (roster.punchEnduranceSeen === punchEndurance && roster.punchEnduranceLossSeen === punchEnduranceLoss) {
    return fighter;
  }
  return updateFighter(fighterId, {
    careerRosterState: {
      ...roster,
      punchEnduranceSeen: punchEndurance,
      punchEnduranceLossSeen: punchEnduranceLoss,
    },
  } as Partial<InsertFighter>);
}

export function createFighter(data: InsertFighter): Fighter {
  // Deliberately does NOT touch the Neural Network tuning (XP/stat-point
  // multipliers, AI graphs, rhythm-cut settings). That tuning is the player's
  // own hand-set configuration, not career progress, so it carries into a new
  // save and only ever changes from the Neural Network screen itself.
  // Items, boosts and high scores are per-fighter and start empty below; this
  // clears the out-of-save leftovers that would otherwise carry over.
  clearCrossSaveProgress();
  const fighters = loadSaves();
  const fighter: Fighter = {
    id: generateId(),
    name: data.name,
    firstName: data.firstName ?? "",
    nickname: data.nickname ?? "",
    lastName: data.lastName ?? "",
    archetype: data.archetype ?? "BoxerPuncher",
    level: data.level ?? 1,
    xp: data.xp ?? 0,
    wins: data.wins ?? 0,
    losses: data.losses ?? 0,
    draws: data.draws ?? 0,
    knockouts: data.knockouts ?? 0,
    skillPoints: data.skillPoints ?? { power: 0, speed: 0, defense: 0, stamina: 0, focus: 0 },
    availableStatPoints: data.availableStatPoints ?? 0,
    careerBoutIndex: data.careerBoutIndex ?? 0,
    careerDifficulty: data.careerDifficulty ?? "contender",
    roundLengthMins: data.roundLengthMins ?? 3,
    careerStats: data.careerStats ?? { totalPunchesThrown: 0, totalPunchesLanded: 0, totalKnockdownsGiven: 0, totalKnockdownsTaken: 0, totalBlocksMade: 0, totalDodges: 0, totalDamageDealt: 0, totalDamageReceived: 0, totalRoundsWon: 0, totalRoundsLost: 0, lifetimeXp: 0 },
    skinColor: data.skinColor ?? "#e8c4a0",
    gearColors: data.gearColors ?? { ...DEFAULT_GEAR_COLORS },
    trainingBonuses: data.trainingBonuses ?? { weightLifting: 0, heavyBag: 0, sparring: 0 },
    careerTrainingSessions: data.careerTrainingSessions ?? 0,
    highScoreMilestoneSeen: data.highScoreMilestoneSeen ?? false,
    careerRosterState: data.careerRosterState ?? null,
    force: data.force ?? 0,
    spacialRevealed: data.spacialRevealed ?? false,
    spacialUnlocked: data.spacialUnlocked ?? false,
    spacialColors: data.spacialColors ?? false,
    spacialParts: data.spacialParts ?? null,
    spacialOwned: data.spacialOwned ?? null,
    ringColors: data.ringColors ?? null,
    ringSpacialUnlocked: data.ringSpacialUnlocked ?? false,
    diamonds: data.diamonds ?? 0,
    shards: data.shards ?? 0,
    diamondLevelsBought: data.diamondLevelsBought ?? 0,
    statPointsBought: data.statPointsBought ?? 0,
    // Refinement — including the permanent diamond-bought costReduction — is
    // career progress, so a new save always starts clean. Hard null rather than
    // `data.skillRefinement ?? null`: updateFighter's never-decrease guard means
    // a reduction that got in here could never be undone. Save import builds its
    // fighter through its own path below and is unaffected.
    skillRefinement: null,
    // Equipment Upgrades are career progress bought with Force, so a new save
    // starts with nothing. Hard null for the same reason refinement is: the
    // never-decrease guard in updateFighter means a level that got in here
    // could never be taken back out.
    equipment: null,
    itemInventory: (data.itemInventory as Fighter["itemInventory"] | undefined) ?? { owned: {}, lifetimeObtained: {}, keepsakesReceived: [], activeBoosts: {} },
    createdAt: new Date(),
  };
  fighters.push(fighter);
  persistSaves(fighters);
  return fighter;
}

/**
 * Merges an incoming inventory over the stored one so nothing can be lost:
 * owned copies and lifetime counts take the higher of the two and keepsakes are
 * unioned. Everything else (active boosts, scopes, seen flags) is taken from
 * the writer as-is.
 */
function mergeInventoryUpwards(stored: Partial<ItemInventory> | null, incoming: ItemInventory): ItemInventory {
  const maxMerge = (a: Record<string, number> | undefined, b: Record<string, number> | undefined) => {
    const out: Record<string, number> = { ...(a ?? {}) };
    for (const [k, v] of Object.entries(b ?? {})) out[k] = Math.max(out[k] ?? 0, v ?? 0);
    for (const k of Object.keys(out)) if (!(out[k] > 0)) delete out[k];
    return out;
  };
  const keepsakes = Array.isArray(stored?.keepsakesReceived) ? [...stored!.keepsakesReceived] : [];
  for (const k of incoming.keepsakesReceived ?? []) if (!keepsakes.includes(k)) keepsakes.push(k);
  // Spend receipts only ever grow. A stale writer must not be able to forget
  // a sale, or merging upward would hand the sold copy back.
  const itemsSpent = maxMerge(stored?.itemsSpent, incoming.itemsSpent);
  // A writer holding a snapshot from before a sale still carries the pre-sale
  // owned count, which would win the merge and resurrect the sold copy. Discount
  // its counts by the receipts it never saw. The stored count is still honoured
  // below, so this can only cancel a stale number, never take a copy away — and
  // a writer with no ledger at all is left alone, since its counts can't be
  // judged against receipts.
  let incomingOwned = incoming.owned;
  if (incoming.itemsSpent && typeof incoming.itemsSpent === "object") {
    incomingOwned = { ...(incoming.owned ?? {}) };
    for (const [id, spent] of Object.entries(itemsSpent)) {
      const missed = spent - Math.max(0, Math.floor(incoming.itemsSpent[id] ?? 0));
      if (missed > 0 && (incomingOwned[id] ?? 0) > 0) {
        incomingOwned[id] = Math.max(0, incomingOwned[id] - missed);
      }
    }
  }
  return {
    ...incoming,
    owned: maxMerge(stored?.owned, incomingOwned),
    lifetimeObtained: maxMerge(stored?.lifetimeObtained, incoming.lifetimeObtained),
    itemsSpent,
    keepsakesReceived: keepsakes,
    recoveredFromLifetimeV1: incoming.recoveredFromLifetimeV1 || stored?.recoveredFromLifetimeV1 || undefined,
  };
}

/**
 * `allowInventoryShrink` marks the write as an intentional spend (selling,
 * using or arming an item). Only the item library sets it, and it always reads
 * the save immediately before writing. Every other writer — fight, training and
 * reward payouts that fold an inventory into a bigger save write — can add
 * items but never remove them, so a snapshot taken before a grant can't roll
 * the locker back.
 */
export function updateFighter(
  id: string,
  data: Partial<InsertFighter>,
  opts?: { allowInventoryShrink?: boolean },
): Fighter | undefined {
  const fighters = loadSaves();
  const idx = fighters.findIndex(f => f.id === id);
  if (idx === -1) return undefined;
  if (data.itemInventory && typeof data.itemInventory === "object" && !opts?.allowInventoryShrink) {
    data = {
      ...data,
      itemInventory: mergeInventoryUpwards(
        (fighters[idx].itemInventory ?? null) as Partial<ItemInventory> | null,
        data.itemInventory as ItemInventory,
      ) as Fighter["itemInventory"],
    };
  }
  // costReduction (a diamond purchase) and activeSlotsUnlocked (Refinement
  // Slots earned by rank) are permanent — they can only ever go up. Writers that
  // rebuild skillRefinement from a stale in-memory fighter must not lower or
  // drop them; the legacy purchase counter is guarded for the same reason.
  if (data.skillRefinement && typeof data.skillRefinement === "object") {
    const existing = (fighters[idx].skillRefinement ?? null) as Record<string, unknown> | null;
    const incoming = data.skillRefinement as Record<string, unknown>;
    const patch: Record<string, number> = {};
    for (const key of ["costReduction", "activeSlotsUnlocked", "activeSlotsPurchased"] as const) {
      const was = Number(existing?.[key]) || 0;
      if ((Number(incoming[key]) || 0) < was) patch[key] = was;
    }
    if (Object.keys(patch).length) {
      data = { ...data, skillRefinement: { ...incoming, ...patch } as typeof data.skillRefinement };
    }
  }
  // An item's rank unlock is permanent: reaching the rank is what opens it, and
  // sliding back down the ladder afterwards must not shut it again. The mark is
  // stamped here rather than at the dozen-odd places that write playerRank —
  // every one of them spreads a whole roster blob, so a mark maintained at any
  // one of them would be rolled back by the next writer working off a stale
  // copy. Stamping it at the door also catches up careers that predate it.
  if (data.careerRosterState && typeof data.careerRosterState === "object") {
    const incoming = data.careerRosterState;
    const existing = fighters[idx].careerRosterState;
    const marks = [incoming.bestRankEver, existing?.bestRankEver, incoming.playerRank]
      .filter((n): n is number => typeof n === "number" && Number.isFinite(n) && n > 0);
    if (marks.length) {
      const best = Math.min(...marks);
      if (incoming.bestRankEver !== best) {
        data = { ...data, careerRosterState: { ...incoming, bestRankEver: best } as typeof data.careerRosterState };
      }
    }
  }
  // The stat-point pool is a count of unspent points — it can never be negative.
  // A negative value would disable every spend button, so clamp it at the door.
  if (data.availableStatPoints != null && data.availableStatPoints < 0) {
    data = { ...data, availableStatPoints: 0 };
  }
  // Spacial purchases and the reveal milestone can never be taken back. Writers
  // that rebuild the record from a stale snapshot must not drop them (whether
  // the finish is *worn* is a normal toggle and stays writable).
  for (const flag of ["spacialUnlocked", "spacialRevealed", "ringSpacialUnlocked"] as const) {
    if (fighters[idx][flag] && data[flag] === false) {
      data = { ...data, [flag]: true };
    }
  }
  // Gear pieces are bought one at a time, so the owned list is a ledger of
  // purchases rather than a setting: it merges upward and never shrinks.
  const ownedBefore = fighters[idx].spacialOwned;
  if (Array.isArray(ownedBefore) && ownedBefore.length) {
    const incoming = Array.isArray(data.spacialOwned) ? data.spacialOwned : [];
    const merged = Array.from(new Set([...ownedBefore, ...incoming]));
    if (merged.length !== incoming.length) {
      data = { ...data, spacialOwned: merged };
    }
  }
  // Equipment levels are bought one at a time and never refundable, and each one
  // sets the price of the next, so every slot merges upward. A writer rebuilding
  // the record from a stale snapshot can add levels but never rewind them.
  if (data.equipment && typeof data.equipment === "object") {
    const stored = (fighters[idx].equipment ?? {}) as Record<string, number>;
    const incoming = data.equipment as Record<string, number>;
    const merged: Record<string, number> = { ...incoming };
    let changed = false;
    for (const [slot, level] of Object.entries(stored)) {
      const have = typeof level === "number" && Number.isFinite(level) ? level : 0;
      const next = typeof merged[slot] === "number" && Number.isFinite(merged[slot]) ? merged[slot] : 0;
      if (have > next) { merged[slot] = have; changed = true; }
    }
    if (changed) data = { ...data, equipment: merged };
  }
  // The bought-level counter sets the diamond price of the next level, so it can
  // only ever go up. A stale writer must not be able to rewind the price curve.
  if (data.diamondLevelsBought != null) {
    const existingBought = fighters[idx].diamondLevelsBought ?? 0;
    if (data.diamondLevelsBought < existingBought) {
      data = { ...data, diamondLevelsBought: existingBought };
    }
  }
  // Same for bought stat points: the counter sets the Force price of the next
  // one, so a stale writer must not be able to rewind the price curve.
  if (data.statPointsBought != null) {
    const existingSpBought = fighters[idx].statPointsBought ?? 0;
    if (data.statPointsBought < existingSpBought) {
      data = { ...data, statPointsBought: existingSpBought };
    }
  }
  // The daily-reward stamp is a lockout, not a setting: once today is claimed it
  // can only move forward. careerRosterState is a single blob rewritten whole
  // from dozens of handlers, so any one of them holding a snapshot taken before
  // the claim would otherwise rewind the stamp — and the next visit to the hub
  // would hand over a second lot of chests for the same day. Guarding it here
  // covers every writer at once, including ones added later. An absent stamp on
  // the incoming blob counts as a rewind (empty string sorts below any day key).
  //
  // A stamp already sitting in the future is the one case left writable: that is
  // the broken-clock escape hatch healing itself, and it heals by stamping today
  // over a later day. Deciding whether that is allowed belongs to the claim, not
  // here, so this only holds the line on stamps that are actually still binding.
  if (data.careerRosterState && typeof data.careerRosterState === "object") {
    const storedRs = (fighters[idx].careerRosterState ?? null) as Record<string, unknown> | null;
    const incomingRs = data.careerRosterState as Record<string, unknown>;
    const wasDay = typeof storedRs?.lastDailyRewardDay === "string" ? storedRs.lastDailyRewardDay : "";
    const nextDay = typeof incomingRs.lastDailyRewardDay === "string" ? incomingRs.lastDailyRewardDay : "";
    // Local `YYYY-MM-DD`, inlined rather than imported: the daily-reward module
    // reads this one, so importing it back would close a cycle.
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    if (wasDay && wasDay <= today && nextDay < wasDay) {
      const wasAt = typeof storedRs?.lastDailyRewardAt === "number" ? storedRs.lastDailyRewardAt : undefined;
      data = {
        ...data,
        careerRosterState: {
          ...incomingRs,
          lastDailyRewardDay: wasDay,
          // Keep the display timestamp with the day it belongs to; a stale blob
          // that lost the day usually lost the minute alongside it.
          ...(wasAt != null ? { lastDailyRewardAt: wasAt } : {}),
        } as typeof data.careerRosterState,
      };
    }
  }
  fighters[idx] = { ...fighters[idx], ...data };
  persistSaves(fighters);
  return fighters[idx];
}

export function deleteFighter(id: string): void {
  const fighters = loadSaves().filter(f => f.id !== id);
  persistSaves(fighters);
  const results = loadFightResults().filter(r => r.fighterId !== id);
  persistFightResults(results);
  // With no career left, nothing outside the save should survive either.
  if (fighters.length === 0) clearCrossSaveProgress();
}

export function createFightResult(data: InsertFightResult): FightResult {
  const results = loadFightResults();
  const result: FightResult = {
    id: generateId(),
    fighterId: data.fighterId,
    opponentName: data.opponentName,
    opponentLevel: data.opponentLevel,
    opponentArchetype: data.opponentArchetype ?? "BoxerPuncher",
    result: data.result,
    method: data.method,
    rounds: data.rounds,
    xpGained: data.xpGained ?? 0,
    boutNumber: data.boutNumber ?? 0,
    createdAt: new Date(),
  };
  results.push(result);
  persistFightResults(results);
  return result;
}

export function getFightResults(fighterId: string): FightResult[] {
  return loadFightResults().filter(r => r.fighterId === fighterId);
}

export interface SaveFileData {
  version: 1;
  fighter: Fighter;
  fightResults: FightResult[];
  xpConfig?: XpConfig;
  // Gym equipment levels (ring/weight rack/heavy bags) — these determine the
  // Force generation speed, so they travel with the save file.
  gymState?: unknown;
  // Hand-set Neural Network tuning (see TUNING_KEYS).
  tuning?: Record<string, unknown>;
  // Every other browser-held key this game writes (see exportBrowserState) —
  // the item catalog, roster customizations, editor configs, settings and the
  // per-career flags. Raw strings exactly as localStorage holds them.
  browserState?: Record<string, string>;
}

const GYM_LS_KEY = "handz_gym_state";

/**
 * Everything tuned by hand on the Neural Network screen: the per-difficulty AI
 * graphs, the per-opponent overrides, the XP / stat-point multipliers and the
 * rhythm-cut settings. This is the player's own configuration rather than
 * career progress, so it deliberately sits outside the fighter record, is never
 * cleared by starting a new save, and only changes from that screen. It still
 * rides along inside an exported save file so a career moved to another browser
 * arrives tuned the same way.
 */
const TUNING_KEYS = [
  "handz_neural_state",     // global per-difficulty AI graphs
  "handz_neural_defaults",  // "set as default" graph snapshots
  "handz_neural_presets",   // saved named presets
  "handz_fighter_neural",   // per-opponent AI graph overrides
  "handz_rc_config",        // rhythm-cut chances, delays and windows
  "handz_directional_perfect_block", // posture-matched perfect block toggle
  "handz_xp_defaults",      // "set as default" XP / stat-point multipliers
  "handz_scaling_config",   // level ramps + stat-point coefficients and caps
] as const;

/**
 * Everything else this game keeps in the browser rather than on the fighter
 * record — the item catalog and its drop distribution, roster customizations
 * and rank edits, the punch-animation and cascade editors, fight settings,
 * sound, tutorial flags, and the per-career markers keyed by fighter id.
 *
 * Rather than a whitelist that goes stale every time a screen adds a key, the
 * export sweeps every `handz_` key in localStorage. Only these two are left
 * out: they are the career itself, and they travel in their own payload fields
 * so the import can re-key them onto a new fighter id.
 */
const BUNDLE_SKIP_KEYS: string[] = [
  SAVES_KEY,                // the career list itself — rebuilt under a new id
  FIGHT_RESULTS_KEY,        // travels in its own field, re-keyed to the new id
  // The career's PIN and its lock flag stay in the browser they were set in: a
  // save file is meant to be shared, and the same PIN also opens the admin
  // editors. An imported career simply starts unlocked.
  "handz_career_pins",
  "handz_career_pin_locks",
];

/**
 * Keys that end in a fighter id. Only the exported career's copy travels, and
 * it goes in under a placeholder so the import can point it at the new id.
 */
const PER_FIGHTER_KEY_PREFIXES = [
  "handz_trophies_",              // gym trophy shelf
  "handz_negotiate_unlock_",      // purse negotiation unlock
  "handz_allskills_banner_seen_", // "all skills maxed" banner
];

/**
 * Values that are an object keyed by fighter id. Only this career's entry
 * travels, filed under the placeholder.
 */
const FIGHTER_MAP_KEYS = ["handz_player_playstyle"];

/**
 * Values that are a single record tagged with the career it belongs to. They
 * travel only when they belong to the exported career, with the tag replaced.
 */
const FIGHTER_TAGGED_KEYS = [
  "handz_pending_alloc",      // stat points owed from an interrupted session
  "handz_fight_boost_escrow", // boosts armed for a bout that never concluded
];

const FIGHTER_ID_TOKEN = "{fighterId}";

/** Splits a per-career key into its prefix and the fighter id it belongs to. */
function perFighterKeyOwner(key: string): { prefix: string; fighterId: string } | null {
  for (const prefix of PER_FIGHTER_KEY_PREFIXES) {
    if (key.startsWith(prefix)) return { prefix, fighterId: key.slice(prefix.length) };
  }
  return null;
}

function parseRecord(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** The value to file under `key`, or null when it doesn't belong to this career. */
function bundleValueForExport(key: string, raw: string, fighterId: string): string | null {
  if (FIGHTER_MAP_KEYS.includes(key)) {
    const rec = parseRecord(raw);
    if (!rec || rec[fighterId] === undefined) return null;
    return JSON.stringify({ [FIGHTER_ID_TOKEN]: rec[fighterId] });
  }
  if (FIGHTER_TAGGED_KEYS.includes(key)) {
    const rec = parseRecord(raw);
    if (!rec || rec.fighterId !== fighterId) return null;
    return JSON.stringify({ ...rec, fighterId: FIGHTER_ID_TOKEN });
  }
  return raw;
}

/** The value to write for `key`, pointed at the id the career now has. */
function bundleValueForImport(key: string, raw: string, newFighterId: string): string | null {
  if (FIGHTER_MAP_KEYS.includes(key)) {
    const rec = parseRecord(raw);
    const value = rec?.[FIGHTER_ID_TOKEN];
    if (value === undefined) return null;
    return JSON.stringify({ [newFighterId]: value });
  }
  if (FIGHTER_TAGGED_KEYS.includes(key)) {
    const rec = parseRecord(raw);
    if (!rec) return null;
    return JSON.stringify({ ...rec, fighterId: newFighterId });
  }
  return raw;
}

function exportBrowserState(fighterId: string): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith("handz_") || BUNDLE_SKIP_KEYS.includes(key)) continue;
      const owner = perFighterKeyOwner(key);
      // Another career's marker is not this save's business.
      if (owner && owner.fighterId !== fighterId) continue;
      const raw = localStorage.getItem(key);
      if (raw === null) continue;
      const value = bundleValueForExport(key, raw, fighterId);
      if (value === null) continue;
      out[owner ? owner.prefix + FIGHTER_ID_TOKEN : key] = value;
    }
  } catch {}
  return out;
}

/**
 * An all-or-nothing group of localStorage writes.
 *
 * Importing a file rewrites the career, the item catalog, every editor config
 * and a pile of settings. Running out of storage part-way through would leave
 * the browser holding a stranger's configuration and no career, so every key is
 * snapshotted before it is touched and put back if any write throws.
 */
function beginStorageTransaction() {
  const undo: Array<[string, string | null]> = [];
  const remember = (key: string) => {
    if (undo.some(([k]) => k === key)) return;
    try { undo.push([key, localStorage.getItem(key)]); } catch { undo.push([key, null]); }
  };
  return {
    /** Snapshot a key another module is about to write on our behalf. */
    remember,
    set(key: string, value: string) { remember(key); localStorage.setItem(key, value); },
    remove(key: string) { remember(key); localStorage.removeItem(key); },
    rollback() {
      for (let i = undo.length - 1; i >= 0; i--) {
        const [key, previous] = undo[i];
        try {
          if (previous === null) localStorage.removeItem(key);
          else localStorage.setItem(key, previous);
        } catch {}
      }
    },
  };
}
type StorageTransaction = ReturnType<typeof beginStorageTransaction>;

/** Writes the bundle back and reports which keys it actually restored. */
function importBrowserState(
  bundle: Record<string, string> | undefined,
  newFighterId: string,
  tx: StorageTransaction,
): Set<string> {
  const restored = new Set<string>();
  if (!bundle || typeof bundle !== "object" || Array.isArray(bundle)) return restored;
  for (const [bundleKey, raw] of Object.entries(bundle)) {
    // The file is user-supplied: ignore anything outside this game's
    // namespace, and never let it rewrite the save list, the fight-result
    // store or another career's PIN.
    if (typeof bundleKey !== "string" || !bundleKey.startsWith("handz_")) continue;
    if (typeof raw !== "string" || BUNDLE_SKIP_KEYS.includes(bundleKey)) continue;
    const value = bundleValueForImport(bundleKey, raw, newFighterId);
    if (value === null) continue;
    const key = bundleKey.replace(FIGHTER_ID_TOKEN, newFighterId);
    if (BUNDLE_SKIP_KEYS.includes(key)) continue;
    tx.set(key, value);
    restored.add(key);
  }
  return restored;
}

function exportTuning(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of TUNING_KEYS) {
    try {
      const raw = localStorage.getItem(key);
      if (raw) out[key] = JSON.parse(raw);
    } catch {}
  }
  return out;
}

function importTuning(tuning: Record<string, unknown> | undefined, tx: StorageTransaction): void {
  if (!tuning) return;
  for (const key of TUNING_KEYS) {
    const value = tuning[key];
    // An older file that never carried this section must not wipe the tuning
    // already in the browser — only a value actually present replaces it.
    if (value === undefined || value === null) continue;
    // A failed write propagates: the import as a whole rolls back rather than
    // leaving half the neural tuning replaced.
    tx.set(key, JSON.stringify(value));
  }
  // The in-memory scaling cache is refreshed by the caller once every write has
  // landed — repopulating it here would leave a rolled-back import's curve live
  // in the fight loop for the rest of the session.
}

export function exportSaveFile(fighter: Fighter): SaveFileData {
  let gymState: unknown = undefined;
  try {
    const raw = localStorage.getItem(GYM_LS_KEY);
    if (raw) gymState = JSON.parse(raw);
  } catch {}
  // Always export the freshest persisted copy of the fighter — the caller may
  // hold a stale in-memory object missing recent careerRosterState updates
  // (prep weeks, ELO rating/rank, camp training sessions, etc.).
  const fresh = getFighter(fighter.id) ?? fighter;
  return {
    version: 1,
    fighter: fresh,
    fightResults: getFightResults(fighter.id),
    xpConfig: loadXpConfig(),
    gymState,
    tuning: exportTuning(),
    browserState: exportBrowserState(fighter.id),
  };
}

export function importSaveFile(data: SaveFileData): Fighter {
  if (!data || data.version !== 1 || !data.fighter) {
    throw new Error("Invalid save file format");
  }
  // Refuse before touching anything — nothing below is undoable.
  if (loadSaves().length >= 1) {
    throw new Error("A save already exists — confirm overwrite first");
  }
  const newId = generateId();
  // Every write below joins one transaction: a browser that runs out of storage
  // part-way through must end up exactly as it started, not holding an imported
  // item catalog with no career to use it.
  const tx = beginStorageTransaction();
  try {
    const fighter = commitImport(data, newId, tx);
    // The scaling config is cached in memory for the fight loop, so the import
    // has to invalidate that cache or the old curve keeps being used. Only now
    // that every write has landed, and again after a rollback so the cache can
    // never outlive the storage it was built from.
    reloadScaling();
    return fighter;
  } catch (err) {
    tx.rollback();
    reloadScaling();
    throw err instanceof Error && err.message
      ? err
      : new Error("This save file is too large for the browser's storage — nothing was imported");
  }
}

function commitImport(data: SaveFileData, newId: string, tx: StorageTransaction): Fighter {
  // The whole browser-held layer first — item catalog, roster customizations,
  // editor configs, settings — so the sections handled specially below (XP
  // config, tuning, gym clock) still get the last word on their own keys.
  const restored = importBrowserState(data.browserState, newId, tx);
  if (data.xpConfig) {
    tx.remember(XP_CONFIG_KEY);
    saveXpConfig(data.xpConfig);
  }
  // Neural graphs, rhythm-cut settings and the saved multiplier defaults.
  importTuning(data.tuning, tx);
  // An imported file replaces the career wholesale, so drop any local leftover
  // the file did not bring with it — anything it did carry was just written by
  // importBrowserState and is restored again below.
  for (const key of CROSS_SAVE_PROGRESS_KEYS) {
    if (restored.has(key)) continue;
    tx.remove(key);
  }
  // Restore gym equipment levels (Force generation speed) and the production
  // clock, so Force earned while the career sat in a file is still waiting when
  // it is loaded — capped at the same 48 hours as any other idle stretch, and
  // never left reading from the future. Older save files without gymState reset
  // the gym to level 1 so no foreign progress leaks in.
  if (data.gymState && typeof data.gymState === "object") {
    const incoming = data.gymState as { lastUpdate?: unknown };
    const lastUpdate = clampPassiveClock(incoming.lastUpdate, Date.now());
    tx.set(GYM_LS_KEY, JSON.stringify({ ...(data.gymState as object), lastUpdate }));
  } else {
    tx.remove(GYM_LS_KEY);
  }

  const fighter: Fighter = {
    ...data.fighter,
    id: newId,
    // Older save files predate the item system — backfill Shards + inventory defaults.
    shards: data.fighter.shards ?? 0,
    // Older files predate paid levels — they have bought none, so the price starts fresh.
    diamondLevelsBought: data.fighter.diamondLevelsBought ?? 0,
    // Same for bought stat points: an older file starts at the base price.
    statPointsBought: data.fighter.statPointsBought ?? 0,
    // Equipment Upgrades travel with the file. Older files predate them, so
    // every slot starts at zero.
    equipment: data.fighter.equipment ?? null,
    itemInventory: data.fighter.itemInventory ?? { owned: {}, lifetimeObtained: {}, keepsakesReceived: [], activeBoosts: {} },
    // The Spacial Color purchase, its reveal and the pieces wearing it live on
    // the fighter record, so they travel with an exported file and vanish with
    // an erased save. Older files predate all three — start them off.
    spacialRevealed: data.fighter.spacialRevealed ?? false,
    spacialUnlocked: data.fighter.spacialUnlocked ?? false,
    spacialColors: data.fighter.spacialColors ?? false,
    spacialParts: data.fighter.spacialParts ?? null,
    spacialOwned: data.fighter.spacialOwned ?? null,
    // The ring palette and its Spacial unlock are career property too, so they
    // travel with an exported file the same way gear colours do.
    ringColors: data.fighter.ringColors ?? null,
    ringSpacialUnlocked: data.fighter.ringSpacialUnlocked ?? false,
    createdAt: new Date(),
  };

  const fighters = loadSaves();
  fighters.push(fighter);
  tx.remember(SAVES_KEY);
  persistSaves(fighters);

  if (data.fightResults && Array.isArray(data.fightResults)) {
    const results = loadFightResults();
    for (const fr of data.fightResults) {
      results.push({
        ...fr,
        id: generateId(),
        fighterId: newId,
      });
    }
    tx.remember(FIGHT_RESULTS_KEY);
    persistFightResults(results);
  }

  return fighter;
}

export function migrateFromServer(serverFighters: Fighter[], serverResults: FightResult[]): void {
  const existing = loadSaves();
  if (existing.length > 0) return;
  if (serverFighters.length === 0) return;
  persistSaves(serverFighters);
  persistFightResults(serverResults);
}

const LS_FIGHT_TIPS = "handz_fight_tips";
const LS_TIP_WEEK_CD = "handz_fight_tips_week_cd";
const LS_TIP_HUB_CD = "handz_fight_tips_hub_cd";
const LS_HUB_LOAD_COUNT = "handz_hub_load_count";

export function getFightTips(): string[] {
  try {
    const raw = localStorage.getItem(LS_FIGHT_TIPS);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

export function saveFightTips(tips: string[]): void {
  localStorage.setItem(LS_FIGHT_TIPS, JSON.stringify(tips.slice(0, 100)));
}

export function getTipWeekCooldowns(): Record<number, number> {
  try {
    const raw = localStorage.getItem(LS_TIP_WEEK_CD);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

export function saveTipWeekCooldowns(cd: Record<number, number>): void {
  localStorage.setItem(LS_TIP_WEEK_CD, JSON.stringify(cd));
}

export function getTipHubCooldowns(): Record<number, number> {
  try {
    const raw = localStorage.getItem(LS_TIP_HUB_CD);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

export function saveTipHubCooldowns(cd: Record<number, number>): void {
  localStorage.setItem(LS_TIP_HUB_CD, JSON.stringify(cd));
}

export function getHubLoadCount(): number {
  try { return parseInt(localStorage.getItem(LS_HUB_LOAD_COUNT) || "0", 10) || 0; }
  catch { return 0; }
}

export function incrementHubLoadCount(): number {
  const next = getHubLoadCount() + 1;
  localStorage.setItem(LS_HUB_LOAD_COUNT, String(next));
  return next;
}

export function pickFightTips(
  count: number,
  allTips: string[],
  isOnCooldown: (index: number) => boolean,
): Array<{ index: number; text: string }> {
  const N = allTips.length;
  if (N === 0 || count <= 0) return [];

  const eligible: Array<{ index: number; text: string }> = [];
  for (let i = 0; i < N; i++) {
    if (!allTips[i] || allTips[i].trim() === "") continue;
    if (isOnCooldown(i)) continue;
    eligible.push({ index: i, text: allTips[i] });
  }

  if (eligible.length === 0) return [];

  // ≥20 eligible tips → always show; below 20 → linear scale (e.g. 10 tips = 50% chance)
  const showChance = Math.min(1, eligible.length / 20);
  if (Math.random() >= showChance) return [];

  // Shuffle and return up to count — each tip has equal 1/eligible.length probability
  for (let i = eligible.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [eligible[i], eligible[j]] = [eligible[j], eligible[i]];
  }
  return eligible.slice(0, count);
}

export function migrateStatCaps(): void {
  const fighters = loadSaves();
  let changed = false;
  for (const f of fighters) {
    const rs = f.careerRosterState as { roster?: Array<{ id: number; beatenByPlayer?: boolean }> } | null;
    const champBeaten = rs?.roster?.some(r => r.id === 204 && r.beatenByPlayer) ?? false;
    if (champBeaten) continue;

    const raw = (f.skillPoints ?? {}) as { power?: number; speed?: number; defense?: number; stamina?: number; focus?: number };
    const PER_CAP = 1000;
    const TOTAL_CAP = 5000;

    const newSp = {
      power: raw.power || 0,
      speed: raw.speed || 0,
      defense: raw.defense || 0,
      stamina: raw.stamina || 0,
      focus: raw.focus || 0,
    };

    let avail = f.availableStatPoints ?? 0;
    for (const stat of ['power', 'speed', 'defense', 'stamina', 'focus'] as const) {
      if (newSp[stat] > PER_CAP) {
        avail += newSp[stat] - PER_CAP;
        newSp[stat] = PER_CAP;
      }
    }

    const total = newSp.power + newSp.speed + newSp.defense + newSp.stamina + newSp.focus + avail;
    if (total > TOTAL_CAP) {
      avail = Math.max(0, avail - (total - TOTAL_CAP));
    }

    if (
      newSp.power !== (raw.power || 0) || newSp.speed !== (raw.speed || 0) ||
      newSp.defense !== (raw.defense || 0) || newSp.stamina !== (raw.stamina || 0) ||
      newSp.focus !== (raw.focus || 0) || avail !== (f.availableStatPoints ?? 0)
    ) {
      f.skillPoints = newSp;
      f.availableStatPoints = avail;
      changed = true;
    }
  }
  if (changed) persistSaves(fighters);
}
