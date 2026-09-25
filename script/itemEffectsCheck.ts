/**
 * Item effect checks — run with `npx tsx script/itemEffectsCheck.ts`.
 *
 * The project has no test runner, so this is a self-contained assertion script
 * covering the item boost rules that are easy to break silently: catalog
 * integrity, instant grants, boost arming/expiry, Coach's Notes accrual and
 * the fight modifiers it feeds, Simulate Week nullification, and the AC boost
 * single-slot replacement.
 */
import type { CareerRosterState, Fighter, ItemInventory } from "../shared/schema";
import type { ItemDefinition } from "../client/src/game/itemsConfig";

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// The inventory/save layer runs in the browser — stub the storage it needs.
const store: Record<string, string> = {};
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store[k] ?? null,
  setItem: (k: string, v: string) => { store[k] = v; },
  removeItem: (k: string) => { delete store[k]; },
  clear: () => { for (const k of Object.keys(store)) delete store[k]; },
  key: () => null,
  length: 0,
};

const fs = await import("node:fs");
const localSaves = await import("../client/src/lib/localSaves");
const { DEFAULT_ITEMS } = await import("../client/src/game/defaultItems");
const {
  ITEM_EFFECTS, getFightMods, getTrainingMods, getSparringXpMult, getSparringSpMult, getTrainingSpFlat,
  getGymIncomeMult, getForceMult, hasPerk, countPerk, coachNotesPctFor, AC_BOOST_MS,
  getActiveBoosts, describeActiveBoost, getLuckyCoinChance,
} = await import("../client/src/game/itemEffects");
const { applyItemFightMods } = await import("../client/src/game/itemFightMods");
const {
  getInventory, grantItem, useItem, consumeBoostsFor, pruneBoosts,
  nullifySimulatedWeekBoosts, accrueCoachNotes, withSavedInventory, claimOpponentKeepsakes,
  heldKeepsakeIds, sellItem, recoverLockerFromLifetime, healLockerFromLedger,
  normalizeKeepsakeHoldings, purgeRetiredItems,
} = await import("../client/src/lib/itemInventory");
const {
  openFightBoostEscrow, closeFightBoostEscrow, restoreFightBoostEscrow,
} = await import("../client/src/lib/fightBoostEscrow");

/** A fresh save with `n` copies of each of the given items already owned. */
function saveWith(name: string, items: string[], n = 1): Fighter {
  const f = localSaves.createFighter({ name } as never);
  for (const id of items) for (let i = 0; i < n; i++) {
    // Keepsakes are refused by grantItem — the only way to own one is to win it
    // off an opponent, so hand it over through that path instead.
    if (!grantItem(f.id, id, 1).ok) {
      const won = claimOpponentKeepsakes(localSaves.getFighter(f.id), { [id]: 1 });
      if (won.inventory) localSaves.updateFighter(f.id, { itemInventory: won.inventory } as never);
    }
  }
  return localSaves.getFighter(f.id)!;
}

const camp: CareerRosterState = {
  selectedOpponentId: 42, prepWeeksRemaining: 3, weekNumber: 5,
} as unknown as CareerRosterState;

// ---------------------------------------------------------------------------
console.log("1. every catalog item resolves to a real effect and a real icon");
{
  const noEffect = DEFAULT_ITEMS.filter(d => !d.effectId);
  check("every item declares an effect", noEffect.length === 0, noEffect.map(d => d.id).join(", "));
  const dangling = DEFAULT_ITEMS.filter(d => d.effectId && !ITEM_EFFECTS[d.effectId]);
  check("no item points at a missing effect", dangling.length === 0, dangling.map(d => d.id).join(", "));
  const missingIcon = DEFAULT_ITEMS.filter(d => !d.iconImage || !fs.existsSync("client/public" + d.iconImage));
  check("every item icon exists on disk", missingIcon.length === 0, missingIcon.map(d => d.id).join(", "));
  const unused = Object.keys(ITEM_EFFECTS).filter(k => !DEFAULT_ITEMS.some(d => d.effectId === k));
  check("no effect is orphaned", unused.length === 0, unused.join(", "));
}

// ---------------------------------------------------------------------------
console.log("2. instant grants pay out and consume exactly one copy");
{
  const f = saveWith("Grants", ["force_bundle_journeyman", "diamond_jar", "refinement_tome_journeyman"]);
  const force0 = f.force ?? 0;
  const dia0 = f.diamonds ?? 0;

  useItem(f.id, "force_bundle_journeyman");
  const afterForce = localSaves.getFighter(f.id)!;
  check("Force Bundle grants 10k Force", (afterForce.force ?? 0) === force0 + 10_000,
    `${force0} → ${afterForce.force}`);
  check("Force Bundle is consumed", (getInventory(afterForce).owned["force_bundle_journeyman"] ?? 0) === 0);

  useItem(f.id, "diamond_jar");
  const afterDia = localSaves.getFighter(f.id)!;
  check("Diamond Jar grants 5 diamonds", (afterDia.diamonds ?? 0) === dia0 + 5,
    `${dia0} → ${afterDia.diamonds}`);

  const ref0 = (localSaves.getFighter(f.id)!.skillRefinement as { availablePoints?: number } | null)?.availablePoints ?? 0;
  useItem(f.id, "refinement_tome_journeyman");
  const afterTome = localSaves.getFighter(f.id)!;
  const ref1 = (afterTome.skillRefinement as { availablePoints?: number } | null)?.availablePoints ?? 0;
  check("Refinement Tome grants 2 points", ref1 === ref0 + 2, `${ref0} → ${ref1}`);

  const spent = useItem(f.id, "force_bundle_journeyman");
  check("a spent consumable cannot be used again", !spent.ok, spent.message);
}

// ---------------------------------------------------------------------------
console.log("3. Sparta's Trophy doubles the Force payout for as long as it is owned");
{
  const f = saveWith("Trophy", ["spartas_trophy"]);
  const used = useItem(f.id, "spartas_trophy");
  check("it is never spent — owning it is enough", !used.ok, used.message);
  check("and the copy stays in the locker",
    (getInventory(localSaves.getFighter(f.id)).owned["spartas_trophy"] ?? 0) === 1);
  check("owning it doubles the Force payout", getForceMult(localSaves.getFighter(f.id), camp) === 2,
    String(getForceMult(localSaves.getFighter(f.id), camp)));

  // It multiplies a Fight Surge rather than replacing it.
  const surge = ITEM_EFFECTS[DEFAULT_ITEMS.find(d => d.id === "fight_surge_goat")!.effectId!].forceMult!;
  const both = saveWith("Trophy and Surge", ["spartas_trophy", "fight_surge_goat"]);
  useItem(both.id, "fight_surge_goat", { roster: camp });
  const stacked = getForceMult(localSaves.getFighter(both.id), camp);
  check("it stacks on top of Fight Surge", Math.abs(stacked - surge * 2) < 1e-9, `${stacked} vs ${surge * 2}`);

  // A save from when the trophy was a stackable consumable can hold several
  // copies, which a per-copy permanent effect would compound.
  const many = saveWith("Trophy pile", ["spartas_trophy"]);
  const pile = getInventory(localSaves.getFighter(many.id));
  pile.owned["spartas_trophy"] = 3;
  pile.lifetimeObtained["spartas_trophy"] = 3;
  localSaves.updateFighter(many.id, { itemInventory: pile } as never);
  check("a legacy stockpile would compound the doubling",
    getForceMult(localSaves.getFighter(many.id), camp) > 2,
    String(getForceMult(localSaves.getFighter(many.id), camp)));
  normalizeKeepsakeHoldings(many.id);
  check("the fold-in collapses it to the lifetime limit",
    (getInventory(localSaves.getFighter(many.id)).owned["spartas_trophy"] ?? 0) === 1,
    String(getInventory(localSaves.getFighter(many.id)).owned["spartas_trophy"]));
  check("so the doubling never compounds", getForceMult(localSaves.getFighter(many.id), camp) === 2,
    String(getForceMult(localSaves.getFighter(many.id), camp)));
}

// ---------------------------------------------------------------------------
console.log("4. a next-fight boost applies to one bout and never a second");
{
  const f = saveWith("Surge", ["fight_surge_goat", "electrolyte_bottle_goat", "old_fight_poster"]);
  useItem(f.id, "fight_surge_goat", { roster: camp });
  useItem(f.id, "electrolyte_bottle_goat", { roster: camp });
  useItem(f.id, "old_fight_poster", { roster: camp });

  const armed = localSaves.getFighter(f.id)!;
  const modsBefore = getFightMods(armed, camp);
  check("Fight Surge multiplies the Force payout", modsBefore.forceMult > 1, String(modsBefore.forceMult));
  check("Electrolytes raise stamina recovery", modsBefore.staminaRecoveryPct > 0, String(modsBefore.staminaRecoveryPct));
  check("Old Fight Poster raises stun chance", modsBefore.stunChancePct > 0, String(modsBefore.stunChancePct));

  // The bout resolves: every "nextFight" boost is burned in the same save write.
  const after = consumeBoostsFor(armed, "fight", camp);
  check("resolving a bout changes the inventory", after !== null);
  localSaves.updateFighter(f.id, { itemInventory: after } as never);

  const reloaded = localSaves.getFighter(f.id)!;
  const modsAfter = getFightMods(reloaded, camp);
  check("Force multiplier is gone next bout", modsAfter.forceMult === 1, String(modsAfter.forceMult));
  check("stamina recovery is gone next bout", modsAfter.staminaRecoveryPct === 0, String(modsAfter.staminaRecoveryPct));
  check("stun chance is gone next bout", modsAfter.stunChancePct === 0, String(modsAfter.stunChancePct));
  check("the copies are not returned to the locker",
    (getInventory(reloaded).owned["fight_surge_goat"] ?? 0) === 0);
}

// ---------------------------------------------------------------------------
console.log("5. training boosts fire on their own session type only");
{
  const f = saveWith("Training", ["preworkout_powder_goat", "combo_tape_goat"]);
  useItem(f.id, "preworkout_powder_goat", { roster: camp });
  useItem(f.id, "combo_tape_goat", { roster: camp });
  const armed = localSaves.getFighter(f.id)!;

  const wl = getTrainingMods(armed, camp, "weightLifting");
  const hb = getTrainingMods(armed, camp, "heavyBag");
  check("Pre-Workout Powder boosts weightlifting", wl.xpMult > 1 || wl.spMult > 1, JSON.stringify(wl));
  check("Combo Tape boosts the heavy bag", hb.xpMult > 1 || hb.spMult > 1, JSON.stringify(hb));

  const afterWl = consumeBoostsFor(armed, "weightLifting", camp)!;
  localSaves.updateFighter(f.id, { itemInventory: afterWl } as never);
  const spent = localSaves.getFighter(f.id)!;
  check("the weightlifting boost is spent", getTrainingMods(spent, camp, "weightLifting").xpMult === 1);
  check("the heavy bag boost survives", getTrainingMods(spent, camp, "heavyBag").xpMult > 1);

  // Headgear belongs in the ring, so the Strap is a sparring boost.
  const h = saveWith("Headgear", ["headgear_strap_goat"]);
  useItem(h.id, "headgear_strap_goat", { roster: camp });
  const hArmed = localSaves.getFighter(h.id)!;
  check("Headgear Strap boosts sparring EXP and stat points",
    getSparringXpMult(hArmed, camp) > 1 && getSparringSpMult(hArmed, camp) > 1,
    `${getSparringXpMult(hArmed, camp)} / ${getSparringSpMult(hArmed, camp)}`);
  check("Headgear Strap leaves weightlifting and the heavy bag alone",
    getTrainingMods(hArmed, camp, "weightLifting").xpMult === 1
    && getTrainingMods(hArmed, camp, "weightLifting").spMult === 1
    && getTrainingMods(hArmed, camp, "heavyBag").xpMult === 1
    && getTrainingMods(hArmed, camp, "heavyBag").spMult === 1);

  const afterHb = consumeBoostsFor(hArmed, "heavyBag", camp);
  const survivedHb = afterHb ? { ...hArmed, itemInventory: afterHb } : hArmed;
  check("a heavy bag session does not spend the Strap", getSparringSpMult(survivedHb, camp) > 1);
  const afterSpar = consumeBoostsFor(survivedHb, "sparring", camp, { sparring: true })!;
  const sparred = { ...hArmed, itemInventory: afterSpar };
  check("a sparring session spends the Strap",
    getSparringSpMult(sparred, camp) === 1 && getSparringXpMult(sparred, camp) === 1);
}

// ---------------------------------------------------------------------------
console.log("6. Simulate Week wipes Training Frenzy and spares the rest");
{
  const f = saveWith("Sim", ["training_frenzy_iv", "warmup_tape"]);
  useItem(f.id, "training_frenzy_iv", { roster: camp });
  useItem(f.id, "warmup_tape", { roster: camp });
  const armed = localSaves.getFighter(f.id)!;

  const normal = getTrainingMods(armed, camp, "weightLifting");
  const simmed = getTrainingMods(armed, camp, "weightLifting", { simulateWeek: true });
  check("Training Frenzy counts on a trained week", normal.xpMult > simmed.xpMult,
    `${normal.xpMult} vs ${simmed.xpMult}`);
  check("Warmup Tape still counts on a simulated week", simmed.xpMult > 1, String(simmed.xpMult));

  const wiped = nullifySimulatedWeekBoosts(armed)!;
  localSaves.updateFighter(f.id, { itemInventory: wiped } as never);
  const after = localSaves.getFighter(f.id)!;
  const inv = getInventory(after);
  check("Training Frenzy is dropped", !inv.activeBoosts["training_frenzy_iv"]);
  check("Warmup Tape is kept", (inv.activeBoosts["warmup_tape"] ?? 0) === 1);
}

// ---------------------------------------------------------------------------
console.log("7. a camp sparring session banks Coach's Notes and it reaches the fight");
{
  const f = saveWith("Coach", ["coachs_notes"]);
  check("nothing is banked before the first spar", coachNotesPctFor(f, "power") === 0);
  const baseline = getFightMods(f, camp);
  check("no stat boost before the first spar",
    baseline.powerPct === 0 && baseline.speedPct === 0 && baseline.defensePct === 0,
    JSON.stringify(baseline));

  // Force the roll onto Power so the assertion is deterministic.
  const banked = accrueCoachNotes(f, 0.25, ["power"], () => 0)!;
  check("a camp spar banks the rate", banked.stat === "power" && Math.abs(banked.pct - 0.25) < 1e-9,
    JSON.stringify(banked));
  localSaves.updateFighter(f.id, { itemInventory: banked.inventory } as never);

  const after = localSaves.getFighter(f.id)!;
  check("the banked percentage persists", Math.abs(coachNotesPctFor(after, "power") - 0.25) < 1e-9);
  const mods = getFightMods(after, camp);
  check("the banked percentage reaches the fight", Math.abs(mods.powerPct - 0.0025) < 1e-9, String(mods.powerPct));
  check("only the banked stat moves", mods.speedPct === 0 && mods.defensePct === 0, JSON.stringify(mods));
  check("it also applies in sparring",
    Math.abs(getFightMods(after, camp, { sparring: true }).powerPct - 0.0025) < 1e-9);

  // Repeated sessions accumulate, and stop at the cap.
  let inv: ItemInventory | null = null;
  let cur = after;
  for (let i = 0; i < 8; i++) {
    inv = accrueCoachNotes(cur, 0.25, ["power"], () => 0)!.inventory;
    localSaves.updateFighter(f.id, { itemInventory: inv } as never);
    cur = localSaves.getFighter(f.id)!;
  }
  check("sessions accumulate", Math.abs(coachNotesPctFor(cur, "power") - 2.25) < 1e-9,
    String(coachNotesPctFor(cur, "power")));

  const maxed = { ...getInventory(cur), coachNotes: { power: 1000 } } as ItemInventory;
  localSaves.updateFighter(f.id, { itemInventory: maxed } as never);
  check("accrual is capped at 100%", coachNotesPctFor(localSaves.getFighter(f.id), "power") === 100);

  check("the tooltip reports what is banked",
    getActiveBoosts(cur, camp).some(b => describeActiveBoost(b).includes("Banked so far")));
}

// ---------------------------------------------------------------------------
console.log("8. only one AC boost runs at a time, on a fresh 24h timer");
{
  const f = saveWith("AC", ["ac_blast_i", "ac_blast_v"]);
  const t0 = 1_000_000_000_000;
  useItem(f.id, "ac_blast_i", { nowMs: t0 });
  const fanOn = localSaves.getFighter(f.id)!;
  const fanMult = getGymIncomeMult(fanOn, t0 + 1);
  check("the first AC Blast raises gym income", fanMult > 1, String(fanMult));
  check("its slot expires in 24h", getInventory(fanOn).acBoost?.expiresAtMs === t0 + AC_BOOST_MS);

  const blocked = useItem(f.id, "ac_blast_v", { nowMs: t0 + 1000 });
  check("swapping asks for confirmation first", !blocked.ok && !!blocked.message?.startsWith("REPLACE_AC:"),
    blocked.message);

  useItem(f.id, "ac_blast_v", { nowMs: t0 + 1000, confirmReplaceAc: true });
  const blastOn = localSaves.getFighter(f.id)!;
  const inv = getInventory(blastOn);
  check("the new AC boost replaces the old one", inv.acBoost?.itemId === "ac_blast_v", inv.acBoost?.itemId);
  check("the 24h timer restarts", inv.acBoost?.expiresAtMs === t0 + 1000 + AC_BOOST_MS);
  check("AC boosts do not stack", getGymIncomeMult(blastOn, t0 + 2000) > fanMult, String(getGymIncomeMult(blastOn, t0 + 2000)));

  const expired = pruneBoosts(blastOn, null, t0 + 1000 + AC_BOOST_MS + 1);
  check("the slot clears once the 24h is up", expired !== null && expired.acBoost === null);
}

// ---------------------------------------------------------------------------
console.log("9. permanent items work from the moment they are owned");
{
  const f = saveWith("Perms", [
    "old_bell_hammer", "gym_key", "challenge_clause", "credit_limit_increase", "mouthguard_2088",
  ]);
  check("Old Bell Hammer raises sparring EXP", getSparringXpMult(f) > 1, String(getSparringXpMult(f)));
  check("Gym Key adds flat stat points", getTrainingSpFlat(f) === 2, String(getTrainingSpFlat(f)));
  check("Challenge Clause grants the extra career reschedule", hasPerk(f, "extraReschedule"));
  check("one Challenge Clause is worth exactly +1 reschedule",
    countPerk(f, "extraReschedule") === 1, String(countPerk(f, "extraReschedule")));
  {
    // Perks add per copy rather than flipping a flag, so a second clause is a
    // second reschedule instead of a no-op.
    const two = { ...f, itemInventory: { ...getInventory(f), owned: { ...getInventory(f).owned, challenge_clause: 2 } } } as Fighter;
    check("a second Challenge Clause adds another reschedule",
      countPerk(two, "extraReschedule") === 2, String(countPerk(two, "extraReschedule")));
  }
  check("Credit Limit Increase unlocks diamond conversion", hasPerk(f, "diamondConversion"));
  check("the 2088 Mouthguard grants knockdown avoidance",
    getFightMods(f, camp).kdAvoidChance > 0, String(getFightMods(f, camp).kdAvoidChance));
  check("permanents survive a bout", consumeBoostsFor(f, "fight", camp) === null
    || getSparringXpMult(localSaves.getFighter(f.id)) > 1);

  const plain = saveWith("Plain", []);
  check("a save without them gets nothing",
    getSparringXpMult(plain) === 1 && getTrainingSpFlat(plain) === 0
    && !hasPerk(plain, "extraReschedule") && getFightMods(plain, camp).kdAvoidChance === 0);
}

// ---------------------------------------------------------------------------
console.log("10. an item's stated percentage is exactly what reaches the fighter");
{
  // A fighter whose every multiplier is 1, so each assertion below reads as the
  // literal multiplier the item applied.
  function unitState() {
    return {
      player: {
        damageMult: 1, powerBonusPct: 0, punchSpeedMult: 1, moveSpeed: 1, duckSpeedMult: 1,
        blockMult: 1, critResistMult: 1, autoGuardDuration: 1,
        maxStamina: 100, maxStaminaCap: 100, stamina: 50,
        critMult: 1, stunMult: 1, staminaRegen: 1, slipperyDodgeBonus: 0,
      },
      itemKdAvoidChance: 0, itemRhythmCutFailChance: 0,
    } as unknown as Parameters<typeof applyItemFightMods>[0];
  }
  const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;

  /** Arm one item and read back the mods a real fight would receive. */
  function modsFor(id: string) {
    const f = saveWith(`Exact_${id}`, [id]);
    const armed = DEFAULT_ITEMS.find(d => d.id === id)!.effectId;
    if (ITEM_EFFECTS[armed!].duration !== "permanent") useItem(f.id, id, { roster: camp });
    return getFightMods(localSaves.getFighter(f.id)!, camp);
  }

  // Veteran's Hand Wraps: "+15% Power and Crit chance".
  {
    const m = modsFor("veterans_hand_wraps");
    check("hand wraps read as +0.15 power", near(m.powerPct, 0.15), String(m.powerPct));
    const s = unitState();
    applyItemFightMods(s, m);
    // Power is additive: it joins the fighter's power pool rather than scaling
    // the base stat, so `damageMult` must come through untouched.
    check("hand wraps add +0.15 to the power pool", near(s.player.powerBonusPct, 0.15),
      String(s.player.powerBonusPct));
    check("and leave the base damage stat alone", near(s.player.damageMult, 1),
      String(s.player.damageMult));
    check("hand wraps give 1.15× crit, not 16×", near(s.player.critMult, 1.15), String(s.player.critMult));
  }

  // Two power items on one fighter SUM their percentages. Compounding them would
  // read 1.15 × 1.02 = 1.173; the pool must read a flat 0.17.
  {
    const s = unitState();
    applyItemFightMods(s, modsFor("veterans_hand_wraps"));
    applyItemFightMods(s, modsFor("gummy_candy_iii"));
    check("two power items sum to +0.17", near(s.player.powerBonusPct, 0.17),
      String(s.player.powerBonusPct));
    check("and do not compound to +0.173",
      !near(s.player.powerBonusPct, 1.15 * 1.02 - 1), String(s.player.powerBonusPct));
    check("the base damage stat is still untouched", near(s.player.damageMult, 1),
      String(s.player.damageMult));
  }

  // Refined Film: "+25% Defense".
  {
    const m = modsFor("refined_film");
    check("refined film reads as +0.25 defense", near(m.defensePct, 0.25), String(m.defensePct));
    const s = unitState();
    applyItemFightMods(s, m);
    check("refined film gives 1.25× block", near(s.player.blockMult, 1.25), String(s.player.blockMult));
    check("refined film leaves crit resistance at 0.75, not 0",
      near(s.player.critResistMult, 0.75), String(s.player.critResistMult));
  }

  // Veteran's Footage: "+10% Dodge chance and Focus".
  {
    const m = modsFor("veterans_footage");
    check("footage reads as +0.10 dodge", near(m.dodgePct, 0.1), String(m.dodgePct));
    const s = unitState();
    applyItemFightMods(s, m);
    check("footage adds 0.10 dodge, nowhere near the 0.95 clamp",
      near(s.player.slipperyDodgeBonus ?? 0, 0.1), String(s.player.slipperyDodgeBonus));
    check("footage gives 1.10× focus-driven stun", near(s.player.stunMult, 1.1), String(s.player.stunMult));
  }

  // Veteran's Weighted Vest: "+15% Stamina".
  {
    const m = modsFor("veterans_weighted_vest");
    check("vest reads as +0.15 stamina", near(m.staminaPct, 0.15), String(m.staminaPct));
    const s = unitState();
    applyItemFightMods(s, m);
    check("vest raises max stamina 100 → 115", near(s.player.maxStamina, 115), String(s.player.maxStamina));
    check("vest tops the fighter up", near(s.player.stamina, 115), String(s.player.stamina));
  }

  // Old Fight Poster: "+50% stun chance".
  {
    const m = modsFor("old_fight_poster");
    check("poster reads as +0.50 stun", near(m.stunChancePct, 0.5), String(m.stunChancePct));
    const s = unitState();
    applyItemFightMods(s, m);
    check("poster gives 1.5× stun, not 51×", near(s.player.stunMult, 1.5), String(s.player.stunMult));
  }

  // Corner Bucket: "+10% stamina recovery speed".
  {
    const m = modsFor("corner_bucket");
    const s = unitState();
    applyItemFightMods(s, m);
    check("corner bucket gives 1.1× stamina regen", near(s.player.staminaRegen, 1.1), String(s.player.staminaRegen));
  }

  // Debuffs normalize the same way, and stay negative.
  {
    const m = modsFor("gummy_candy_iii");
    check("gummy III reads as +0.02 power", near(m.powerPct, 0.02), String(m.powerPct));
    check("gummy III reads as −0.01 speed", near(m.speedPct, -0.01), String(m.speedPct));
    const s = unitState();
    applyItemFightMods(s, m);
    check("gummy III slows the fighter to 0.99×", near(s.player.moveSpeed, 0.99), String(s.player.moveSpeed));
  }
  {
    const f = saveWith("AcPenalty", ["ac_blast_i"]);
    useItem(f.id, "ac_blast_i");
    const m = getFightMods(localSaves.getFighter(f.id)!, camp);
    check("the AC Blast costs 8% stamina, not 800%", near(m.staminaPct, -0.08), String(m.staminaPct));
    const s = unitState();
    applyItemFightMods(s, m);
    check("AC Blast leaves 92 max stamina", near(s.player.maxStamina, 92), String(s.player.maxStamina));
  }

  // Chance fields are authored as 0–1 and must pass through untouched.
  {
    const m = modsFor("mouthguard_2088");
    check("the mouthguard stays at 0.65", near(m.kdAvoidChance, 0.65), String(m.kdAvoidChance));
    const s = unitState();
    applyItemFightMods(s, m);
    check("the fight sees 0.65 knockdown avoidance", near(s.itemKdAvoidChance, 0.65), String(s.itemKdAvoidChance));
  }
  {
    const m = modsFor("footwork_laces");
    const s = unitState();
    applyItemFightMods(s, m);
    check("the laces stay at 0.20 rhythm-cut fail",
      near(s.itemRhythmCutFailChance, 0.2), String(s.itemRhythmCutFailChance));
  }

  // Stacking is linear in the stated percentage, not exponential.
  {
    const f = saveWith("Stacked", ["banana"], 3);
    for (let i = 0; i < 3; i++) useItem(f.id, "banana", { roster: camp });
    const m = getFightMods(localSaves.getFighter(f.id)!, camp);
    check("three bananas read as +0.06 power", near(m.powerPct, 0.06), String(m.powerPct));
    check("three bananas read as +0.06 dodge", near(m.dodgePct, 0.06), String(m.dodgePct));
  }
}

// ---------------------------------------------------------------------------
console.log("11. alternate bout endings disarm boosts too");
{
  // Doghouse can be finished early, and that path simulates a week before it
  // persists — so boosts are consumed against a roster state whose camp
  // signature has already moved on. That must still disarm them.
  const f = saveWith("EarlyFinish", ["electrolyte_bottle_goat", "banana", "goats_blessing"]);
  useItem(f.id, "electrolyte_bottle_goat", { roster: camp });
  useItem(f.id, "banana", { roster: camp });
  // GOAT's Blessing is a keepsake: owning it is all the activation there is.
  const armed = localSaves.getFighter(f.id)!;
  check("the bout starts with the boost armed",
    getFightMods(armed, camp, { sparring: true }).staminaRecoveryPct > 0);

  const weekLater = {
    ...camp, weekNumber: 6, prepWeeksRemaining: 2,
  } as unknown as CareerRosterState;
  const inv = consumeBoostsFor(armed, "fight", weekLater, { sparring: true })
    ?? pruneBoosts(armed, weekLater);
  check("an early finish changes the inventory", inv !== null);
  localSaves.updateFighter(f.id, { itemInventory: inv } as never);

  const after = localSaves.getFighter(f.id)!;
  check("the next-fight boost cannot carry into a later bout",
    getFightMods(after, weekLater, { sparring: true }).staminaRecoveryPct === 0,
    String(getFightMods(after, weekLater, { sparring: true }).staminaRecoveryPct));
  check("it is gone in career bouts as well",
    getFightMods(after, weekLater).staminaRecoveryPct === 0);
  const stillOn = getActiveBoosts(after, weekLater).map(b => b.def.id);
  check("the permanent keepsake survives the bout", stillOn.includes("goats_blessing"), stillOn.join(", "));
  check("the week-long boost lapsed with the simulated week", !stillOn.includes("banana"), stillOn.join(", "));
}

// ---------------------------------------------------------------------------
console.log("12. a career-only boost is neither applied nor spent by sparring-flag modes");
{
  // Nightmare and Doghouse run on the sparring flag and never pay Force, so
  // Fight Surge must survive them and still be there for the real career bout.
  const f = saveWith("Surge scope", ["fight_surge_goat"]);
  useItem(f.id, "fight_surge_goat", { roster: camp });
  const armed = localSaves.getFighter(f.id)!;
  const surge = ITEM_EFFECTS[DEFAULT_ITEMS.find(d => d.id === "fight_surge_goat")!.effectId!].forceMult!;

  check("a career bout would pay the multiplier", getFightMods(armed, camp).forceMult === surge,
    String(getFightMods(armed, camp).forceMult));
  check("a sparring-flag bout pays nothing extra",
    getFightMods(armed, camp, { sparring: true }).forceMult === 1,
    String(getFightMods(armed, camp, { sparring: true }).forceMult));

  // Run Nightmare, then Doghouse, then a Doghouse early finish.
  for (const label of ["Nightmare", "Doghouse", "Doghouse early finish"]) {
    const cur = localSaves.getFighter(f.id)!;
    const inv = consumeBoostsFor(cur, "fight", camp, { sparring: true });
    if (inv) localSaves.updateFighter(f.id, { itemInventory: inv } as never);
    check(`${label} leaves Fight Surge armed`,
      getFightMods(localSaves.getFighter(f.id)!, camp).forceMult === surge,
      String(getFightMods(localSaves.getFighter(f.id)!, camp).forceMult));
  }

  // The career bout finally cashes and burns it.
  const beforeCareer = localSaves.getFighter(f.id)!;
  check("Force payout and fight mods agree", getForceMult(beforeCareer, camp) === surge,
    String(getForceMult(beforeCareer, camp)));
  const spent = consumeBoostsFor(beforeCareer, "fight", camp)!;
  localSaves.updateFighter(f.id, { itemInventory: spent } as never);
  const done = localSaves.getFighter(f.id)!;
  check("the career bout spends Fight Surge", getFightMods(done, camp).forceMult === 1,
    String(getFightMods(done, camp).forceMult));
  check("and the Force payout drops back to 1×", getForceMult(done, camp) === 1);
}

// ---------------------------------------------------------------------------
console.log("13. an item armed in the Locker reaches the very next activity");
{
  // The Locker writes straight to the save, so any fighter snapshot the UI was
  // already holding is stale the moment an item is used. Every activity must
  // resolve boosts against the save, not that snapshot.
  const f = saveWith("Locker", [
    "electrolyte_bottle_goat", "preworkout_powder_goat", "combo_tape_goat",
    "old_bell_hammer", "coachs_notes",
  ]);
  useItem(f.id, "preworkout_powder_goat", { roster: camp });  // armed before the snapshot
  const stale = localSaves.getFighter(f.id)!;                 // what the UI is holding
  useItem(f.id, "electrolyte_bottle_goat", { roster: camp }); // armed from the Locker after
  useItem(f.id, "combo_tape_goat", { roster: camp });

  check("the stale snapshot really is stale",
    getFightMods(stale, camp).staminaRecoveryPct === 0 && getTrainingMods(stale, camp, "heavyBag").xpMult === 1);

  const fresh = withSavedInventory(stale);
  check("a career bout sees the new boost", getFightMods(fresh, camp).staminaRecoveryPct > 0);
  check("a sparring bout sees it too", getFightMods(fresh, camp, { sparring: true }).staminaRecoveryPct > 0);
  check("the heavy bag sees its boost", getTrainingMods(fresh, camp, "heavyBag").xpMult > 1);
  check("the boost armed earlier is still there", getTrainingMods(fresh, camp, "weightLifting").xpMult > 1);
  check("the boost HUD sees the new items",
    getActiveBoosts(fresh, camp).length === getActiveBoosts(stale, camp).length + 2);

  // A keepsake won mid-session must land the same way.
  const bought = saveWith("Bought", []);
  const preBuy = localSaves.getFighter(bought.id)!;
  const won = claimOpponentKeepsakes(localSaves.getFighter(bought.id), { old_bell_hammer: 1 });
  localSaves.updateFighter(bought.id, { itemInventory: won.inventory! } as never);
  check("a keepsake won after the snapshot still counts",
    getSparringXpMult(withSavedInventory(preBuy)) > 1 && getSparringXpMult(preBuy) === 1);

  // The dangerous direction: finishing a workout and writing the stale
  // inventory back would erase whatever the Locker armed in the meantime.
  const staleWrite = consumeBoostsFor(stale, "weightLifting", camp);
  check("a stale write would wipe the newly armed boosts",
    !!staleWrite && !staleWrite.activeBoosts["electrolyte_bottle_goat"]
    && !staleWrite.activeBoosts["combo_tape_goat"],
    JSON.stringify(staleWrite?.activeBoosts));

  // Reading the save first spends only the session that actually ran.
  const freshWrite = consumeBoostsFor(withSavedInventory(localSaves.getFighter(f.id)!), "weightLifting", camp)!;
  localSaves.updateFighter(f.id, { itemInventory: freshWrite } as never);
  const after = localSaves.getFighter(f.id)!;
  check("the weightlifting boost is spent", getTrainingMods(after, camp, "weightLifting").xpMult === 1);
  check("the heavy bag boost survives", getTrainingMods(after, camp, "heavyBag").xpMult > 1);
  check("the fight boost survives", getFightMods(after, camp).staminaRecoveryPct > 0);

  check("withSavedInventory keeps the rest of the snapshot",
    withSavedInventory({ ...stale, level: 999 }).level === 999);
}

// ---------------------------------------------------------------------------
console.log("14. the Import Ticket is only spent by a session that actually imported");
{
  const f = saveWith("Import", ["import_ticket"]);
  useItem(f.id, "import_ticket", { roster: camp });
  const armed = localSaves.getFighter(f.id)!;
  check("the ticket unlocks roster sparring", hasPerk(armed, "importSparring", camp));

  // A session that fell back to a normal partner (nothing picked, or a picked
  // fighter who is no longer on the roster) must leave the ticket armed.
  for (const label of ["normal partner picked", "picked fighter left the roster"]) {
    const cur = localSaves.getFighter(f.id)!;
    const inv = consumeBoostsFor(cur, "sparring", camp, { sparring: true, skipPerks: ["importSparring"] });
    if (inv) localSaves.updateFighter(f.id, { itemInventory: inv } as never);
    check(`${label} leaves the ticket armed`,
      hasPerk(localSaves.getFighter(f.id)!, "importSparring", camp));
  }

  // The session that really imported someone spends it.
  const before = localSaves.getFighter(f.id)!;
  const spent = consumeBoostsFor(before, "sparring", camp, { sparring: true })!;
  check("an imported session changes the inventory", !!spent);
  localSaves.updateFighter(f.id, { itemInventory: spent } as never);
  const after = localSaves.getFighter(f.id)!;
  check("the imported session spends the ticket", !hasPerk(after, "importSparring", camp));
  check("and it is not returned to the locker", (getInventory(after).owned["import_ticket"] ?? 0) === 0);

  // Skipping a perk must not shelter unrelated boosts of the same duration.
  const g = saveWith("Import mix", ["import_ticket", "old_bell_hammer"]);
  useItem(g.id, "import_ticket", { roster: camp });
  const mixed = consumeBoostsFor(localSaves.getFighter(g.id)!, "sparring", camp,
    { sparring: true, skipPerks: ["diamondConversion"] });
  check("an unrelated skipPerks entry still spends the ticket",
    !!mixed && !mixed.activeBoosts["import_ticket"]);
}

// ---------------------------------------------------------------------------
console.log("15. quitting a bout (or closing the tab) never burns an armed boost");
{
  const f = saveWith("Escrow", ["fight_surge_goat", "electrolyte_bottle_goat"]);
  useItem(f.id, "fight_surge_goat", { roster: camp });
  useItem(f.id, "electrolyte_bottle_goat", { roster: camp });
  const armed = localSaves.getFighter(f.id)!;
  check("both boosts are armed before the bell",
    getFightMods(armed, camp).forceMult > 1 && getFightMods(armed, camp).staminaRecoveryPct > 0);

  // The bout starts, then the player quits from the pause menu. Whatever the
  // in-fight code did to the inventory, the escrow puts it back.
  openFightBoostEscrow(f.id);
  const burned = consumeBoostsFor(localSaves.getFighter(f.id)!, "fight", camp)!;
  localSaves.updateFighter(f.id, { itemInventory: burned } as never);
  check("a burn really did happen", getFightMods(localSaves.getFighter(f.id)!, camp).forceMult === 1);

  const requeued = restoreFightBoostEscrow();
  check("quitting re-arms the boosts", !!requeued);
  const afterQuit = localSaves.getFighter(f.id)!;
  check("Fight Surge is armed again", getFightMods(afterQuit, camp).forceMult > 1);
  check("Electrolytes are armed again", getFightMods(afterQuit, camp).staminaRecoveryPct > 0);
  check("the copies did not reappear in the locker",
    (getInventory(afterQuit).owned["fight_surge_goat"] ?? 0) === 0);

  // Restoring twice must not stack — the escrow is one-shot.
  const again = restoreFightBoostEscrow();
  check("a second restore does nothing", again === undefined);
  check("stacks are not duplicated",
    (getInventory(localSaves.getFighter(f.id)!).activeBoosts["fight_surge_goat"] ?? 0) === 1);

  // A bout that concluded closes the escrow, so the burn sticks.
  openFightBoostEscrow(f.id);
  const spent = consumeBoostsFor(localSaves.getFighter(f.id)!, "fight", camp)!;
  localSaves.updateFighter(f.id, { itemInventory: spent } as never);
  closeFightBoostEscrow();
  check("closing the escrow leaves nothing to restore", restoreFightBoostEscrow() === undefined);
  check("a concluded bout keeps its boosts spent",
    getFightMods(localSaves.getFighter(f.id)!, camp).forceMult === 1);

  // Sparring modes take the same escrow: a career-scoped boost skipped by a
  // sparring session is still armed, and quitting mid-session changes nothing.
  const s = saveWith("Escrow spar", ["electrolyte_bottle_goat"]);
  useItem(s.id, "electrolyte_bottle_goat", { roster: camp });
  openFightBoostEscrow(s.id);
  const sparBurn = consumeBoostsFor(localSaves.getFighter(s.id)!, "fight", camp, { sparring: true })!;
  localSaves.updateFighter(s.id, { itemInventory: sparBurn } as never);
  restoreFightBoostEscrow();
  check("a quit sparring session keeps its boost",
    getFightMods(localSaves.getFighter(s.id)!, camp, { sparring: true }).staminaRecoveryPct > 0);

  // Week/camp windows ride along, so a restored boost is still live.
  const w = saveWith("Escrow window", ["training_frenzy_iv"]);
  useItem(w.id, "training_frenzy_iv", { roster: camp });
  openFightBoostEscrow(w.id);
  localSaves.updateFighter(w.id, {
    itemInventory: { ...getInventory(localSaves.getFighter(w.id)!), activeBoosts: {}, boostWeek: {}, boostCamp: {} },
  } as never);
  restoreFightBoostEscrow();
  const restoredWindow = localSaves.getFighter(w.id)!;
  check("a week/camp boost is live again after a quit",
    getTrainingMods(restoredWindow, camp, "weightLifting").xpMult > 1,
    JSON.stringify(getInventory(restoredWindow).activeBoosts));
}

// ---------------------------------------------------------------------------
console.log("16. synergy stacks pool across every tier of the same item");
{
  const { itemFamilyName, getItemFamily, familySynergyPatch } = await import("../client/src/game/itemFamily");
  const { loadItemsConfig, saveItemsConfig } = await import("../client/src/game/itemsConfig");

  check("a tier numeral is stripped to the base name", itemFamilyName("Electrolyte Bottle VI") === "Electrolyte Bottle");
  check("a hand-numbered tier resolves the same", itemFamilyName("Training Frenzy IV") === "Training Frenzy");
  check("an untiered name is its own family", itemFamilyName("Corner Bucket") === "Corner Bucket");
  // "C" is a Roman numeral but never a tier label — a general numeral pattern
  // would pool "Vitamin C" with "Vitamin I".
  check("a trailing non-tier letter is not a numeral", itemFamilyName("Vitamin C") === "Vitamin C");
  check("unrelated same-stem items never share a family",
    getItemFamily({ id: "vitamin_c", name: "Vitamin C" }, [
      { id: "vitamin_c", name: "Vitamin C", synergy: true, synergyStackCount: 5 },
      { id: "vitamin_i", name: "Vitamin I", synergy: false, synergyStackCount: 1 },
    ] as never).memberIds.length === 1);

  // Shipped Training Frenzy has synergy on II–IV but not I; the family verdict
  // is what the game applies, so tier I inherits it.
  const frenzy = getItemFamily({ id: "training_frenzy_i", name: "Training Frenzy I" });
  check("one synergy tier turns the whole family on", frenzy.synergy && frenzy.memberIds.length === 4,
    JSON.stringify(frenzy.memberIds));

  // Turn synergy on for a single Electrolyte Bottle tier — the editor's write
  // path spreads it across the ladder.
  const patched = familySynergyPatch(loadItemsConfig(), { id: "electrolyte_bottle_journeyman", name: "Electrolyte Bottle I" },
    { synergy: true, synergyStackCount: 3 });
  saveItemsConfig(patched);
  const bottles = patched.filter(i => i.name.startsWith("Electrolyte Bottle"));
  check("every bottle tier took the same synergy setting",
    bottles.length === 6 && bottles.every(b => b.synergy && b.synergyStackCount === 3));
  const baselineSynergy = DEFAULT_ITEMS.filter(i => i.synergy && !i.name.startsWith("Electrolyte Bottle")).length;
  check("the family patch touched no other family's synergy",
    patched.filter(i => i.synergy).length === baselineSynergy + bottles.length,
    `${patched.filter(i => i.synergy).length} vs ${baselineSynergy + bottles.length}`);

  // ...and only synergy: names, rarities and sell values stay per tier.
  const before = new Map(DEFAULT_ITEMS.map(i => [i.id, i]));
  const strayEdit = patched.find(i => {
    const b = before.get(i.id);
    if (!b) return false;
    return b.name !== i.name || b.rarity !== i.rarity || b.rarityPercent !== i.rarityPercent
      || b.sellShards !== i.sellShards || b.effectId !== i.effectId || b.obtainableLimit !== i.obtainableLimit;
  });
  check("no field other than synergy was shared across tiers", strayEdit === undefined, strayEdit?.id ?? "");

  // Three bottles total, in any mix of tiers — the fourth is refused.
  const f = saveWith("Synergy", ["electrolyte_bottle_journeyman", "electrolyte_bottle_goat"], 3);
  check("first bottle arms", useItem(f.id, "electrolyte_bottle_journeyman", { roster: camp }).ok);
  check("a different tier still arms", useItem(f.id, "electrolyte_bottle_goat", { roster: camp }).ok);
  check("a repeat of the first tier arms", useItem(f.id, "electrolyte_bottle_journeyman", { roster: camp }).ok);
  const fourth = useItem(f.id, "electrolyte_bottle_goat", { roster: camp });
  check("the fourth bottle is refused across the whole family", !fourth.ok, fourth.message ?? "");
  check("the refusal names the family, not one tier",
    (fourth.message ?? "").startsWith("Electrolyte Bottle is at its maximum of 3"), fourth.message ?? "");
  const armedInv = getInventory(localSaves.getFighter(f.id)!);
  check("exactly three stacks are live",
    (armedInv.activeBoosts["electrolyte_bottle_journeyman"] ?? 0) + (armedInv.activeBoosts["electrolyte_bottle_goat"] ?? 0) === 3,
    JSON.stringify(armedInv.activeBoosts));
  check("only the armed copies left the locker",
    (armedInv.owned["electrolyte_bottle_journeyman"] ?? 0) === 1 && (armedInv.owned["electrolyte_bottle_goat"] ?? 0) === 2,
    JSON.stringify(armedInv.owned));

  // A family with synergy off keeps the old per-tier single slot.
  const g = saveWith("No synergy", ["combo_tape_journeyman", "combo_tape_goat"], 2);
  check("a non-synergy tier arms once", useItem(g.id, "combo_tape_journeyman", { roster: camp }).ok);
  const dupe = useItem(g.id, "combo_tape_journeyman", { roster: camp });
  check("the same tier cannot arm twice", !dupe.ok && (dupe.message ?? "").includes("already active"), dupe.message ?? "");
  check("a sibling tier is still unaffected by the family",
    useItem(g.id, "combo_tape_goat", { roster: camp }).ok);

  // A save made before the pool was shared can hold more than the ceiling —
  // those stacks must stop applying, not ride out their duration.
  const legacy = saveWith("Legacy stacks", ["electrolyte_bottle_journeyman"]);
  localSaves.updateFighter(legacy.id, {
    itemInventory: {
      ...getInventory(localSaves.getFighter(legacy.id)!),
      activeBoosts: { electrolyte_bottle_journeyman: 3, electrolyte_bottle_goat: 4 },
    },
  } as never);
  const trimmed = getInventory(localSaves.getFighter(legacy.id)!).activeBoosts;
  check("an over-cap legacy save is trimmed to the family ceiling",
    (trimmed["electrolyte_bottle_journeyman"] ?? 0) + (trimmed["electrolyte_bottle_goat"] ?? 0) === 3,
    JSON.stringify(trimmed));
  check("the earliest tier keeps its stacks", (trimmed["electrolyte_bottle_journeyman"] ?? 0) === 3,
    JSON.stringify(trimmed));
  const legacyBoosts = getActiveBoosts(localSaves.getFighter(legacy.id)!, camp);
  check("the dropped stacks do not reach the fight",
    legacyBoosts.filter(b => b.def.name.startsWith("Electrolyte Bottle")).reduce((n, b) => n + b.stacks, 0) === 3,
    JSON.stringify(legacyBoosts.map(b => [b.def.id, b.stacks])));

  saveItemsConfig(DEFAULT_ITEMS);
}

// ---------------------------------------------------------------------------
console.log("17. an Additive family adds its stacked multipliers instead of compounding");
{
  const { familySynergyPatch } = await import("../client/src/game/itemFamily");
  const { loadItemsConfig, saveItemsConfig, getItemDefinition } = await import("../client/src/game/itemsConfig");

  const strap = { id: "headgear_strap_goat", name: "Headgear Strap VI" };
  const effect = ITEM_EFFECTS[getItemDefinition(strap.id)!.effectId!];
  const m = effect.sparSpMult!;
  const closeTo = (a: number, b: number) => Math.abs(a - b) < 1e-9;

  // Two straps armed, compounding (the default).
  saveItemsConfig(familySynergyPatch(loadItemsConfig(), strap, { synergy: true, synergyStackCount: 3, synergyAdditive: false }));
  const f = saveWith("Compound", [strap.id], 2);
  useItem(f.id, strap.id, { roster: camp });
  useItem(f.id, strap.id, { roster: camp });
  const armed = localSaves.getFighter(f.id)!;
  check("two stacks compound by default", closeTo(getSparringSpMult(armed, camp), m * m),
    `${getSparringSpMult(armed, camp)} vs ${m * m}`);

  // Same save, same stacks — only the family flag changes.
  saveItemsConfig(familySynergyPatch(loadItemsConfig(), strap, { synergyAdditive: true }));
  check("the same two stacks add up once Additive is on",
    closeTo(getSparringSpMult(armed, camp), m * 2), `${getSparringSpMult(armed, camp)} vs ${m * 2}`);
  check("Additive also applies to the EXP multiplier",
    closeTo(getSparringXpMult(armed, camp), effect.sparXpMult! * 2),
    `${getSparringXpMult(armed, camp)} vs ${effect.sparXpMult! * 2}`);

  // Additive is family-wide and a single stack is untouched either way.
  const family = (await import("../client/src/game/itemFamily")).getItemFamily({ id: "headgear_strap_journeyman", name: "Headgear Strap I" });
  check("Additive spreads across every tier of the family", family.additive && family.memberIds.length > 1,
    JSON.stringify(family.memberIds));
  const one = saveWith("Single", [strap.id], 1);
  useItem(one.id, strap.id, { roster: camp });
  check("one stack is the plain multiplier either way",
    closeTo(getSparringSpMult(localSaves.getFighter(one.id)!, camp), m));

  // A half-migrated ladder (Additive set on one tier only) must not compound
  // on the other tiers while the editor shows the family as Additive.
  const mixed = loadItemsConfig().map(i =>
    i.name.startsWith("Headgear Strap")
      ? { ...i, synergy: true, synergyStackCount: 3, synergyAdditive: i.id === "headgear_strap_journeyman" }
      : i);
  saveItemsConfig(mixed);
  check("a mixed ladder still adds on every tier", closeTo(getSparringSpMult(armed, camp), m * 2),
    `${getSparringSpMult(armed, camp)} vs ${m * 2}`);

  // Force and training multipliers take the same rule.
  saveItemsConfig(loadItemsConfig().map(i =>
    i.name.startsWith("Fight Surge") ? { ...i, synergy: true, synergyStackCount: 3, synergyAdditive: true } : i));
  const surgeMult = ITEM_EFFECTS[getItemDefinition("fight_surge_goat")!.effectId!].forceMult!;
  const s2 = saveWith("Surge stack", ["fight_surge_goat"], 2);
  useItem(s2.id, "fight_surge_goat", { roster: camp });
  useItem(s2.id, "fight_surge_goat", { roster: camp });
  check("an Additive Force multiplier adds too",
    closeTo(getForceMult(localSaves.getFighter(s2.id)!, camp), surgeMult * 2),
    `${getForceMult(localSaves.getFighter(s2.id)!, camp)} vs ${surgeMult * 2}`);

  // Turning Additive back off returns the same stacks to compounding.
  saveItemsConfig(familySynergyPatch(loadItemsConfig(), strap, { synergyAdditive: false }));
  check("clearing Additive restores compounding", closeTo(getSparringSpMult(armed, camp), m * m),
    `${getSparringSpMult(armed, camp)} vs ${m * m}`);

  saveItemsConfig(DEFAULT_ITEMS);
}

// ---------------------------------------------------------------------------
console.log("18. beating an opponent hands over a keepsake from their kit");
{
  const keepsakeId = "veterans_hand_wraps";
  const kit = { [keepsakeId]: 1, fight_surge_goat: 2 };

  const winner = saveWith("Spoils", []);
  const claim = claimOpponentKeepsakes(winner, kit);
  check("the opponent's keepsake is claimed", claim.itemIds.length === 1 && claim.itemIds[0] === keepsakeId,
    JSON.stringify(claim.itemIds));
  check("the non-keepsake half of the kit is left behind",
    (claim.inventory?.owned.fight_surge_goat ?? 0) === 0);
  check("one copy lands in the locker", (claim.inventory?.owned[keepsakeId] ?? 0) === 1);
  check("it counts against the lifetime limit", (claim.inventory?.lifetimeObtained[keepsakeId] ?? 0) === 1);
  check("it is recorded as received", !!claim.inventory?.keepsakesReceived.includes(keepsakeId));
  check("it flags the locker dot", !!claim.inventory?.unseenItemIds?.includes(keepsakeId));

  // Persist it, then beat another opponent carrying the same keepsake.
  localSaves.updateFighter(winner.id, { itemInventory: claim.inventory! });
  const again = claimOpponentKeepsakes(localSaves.getFighter(winner.id)!, kit);
  check("a keepsake already owned is not handed over twice", again.itemIds.length === 0 && again.inventory === null);

  // A kit without keepsakes, or no kit at all, awards nothing.
  check("an opponent with no keepsake gives nothing",
    claimOpponentKeepsakes(saveWith("No keepsake", []), { fight_surge_goat: 1 }).itemIds.length === 0);
  check("an opponent with no kit gives nothing",
    claimOpponentKeepsakes(saveWith("No kit", []), undefined).itemIds.length === 0);
}

// ---------------------------------------------------------------------------
console.log("19. opponents carry a keepsake the player is still missing");
{
  const {
    KEEPSAKE_CHANCE_DEFAULT, assignableKeepsakeItems, buildDefaultItemDistConfig,
    loadItemDistConfig, rollOpponentItems, saveItemDistConfig, clearItemDistConfig,
  } = await import("../client/src/game/itemDistConfig");
  const { getItemDefinition } = await import("../client/src/game/itemsConfig");

  const keepsakeIds = assignableKeepsakeItems(DEFAULT_ITEMS).map(d => d.id);
  check("the keepsake pool is the whole catalog's keepsakes, boost-flagged or not",
    keepsakeIds.length === DEFAULT_ITEMS.filter(d => d.isKeepsake).length && keepsakeIds.length > 0,
    `${keepsakeIds.length}`);

  // A band that hands out no boost items at all — anything rolled is the keepsake.
  const always = { ...buildDefaultItemDistConfig(), keepsakeChancePct: 100 };
  const never = { ...buildDefaultItemDistConfig(), keepsakeChancePct: 0 };
  const rnd = () => 0;

  const carried = rollOpponentItems(500, always, rnd);
  const carriedIds = Object.keys(carried);
  check("a 100% chance always fields a keepsake", carriedIds.length === 1, JSON.stringify(carried));
  check("and what it fields really is a keepsake",
    !!getItemDefinition(carriedIds[0] ?? "")?.isKeepsake, carriedIds[0]);
  check("exactly one copy is carried", carried[carriedIds[0]] === 1);
  check("a 0% chance never fields one", Object.keys(rollOpponentItems(500, never, rnd)).length === 0);

  // Keepsakes the player already holds are dropped from the pool.
  const without = rollOpponentItems(500, always, rnd, [carriedIds[0]]);
  check("a keepsake the player owns is not carried again",
    !Object.keys(without).includes(carriedIds[0]), JSON.stringify(without));
  check("a different keepsake takes its place", Object.keys(without).length === 1);
  check("owning every keepsake leaves the opponent empty-handed",
    Object.keys(rollOpponentItems(500, always, rnd, keepsakeIds)).length === 0);

  // A locker that holds a keepsake it never recorded as received — an imported
  // or recovered save — still counts as holding it, or the opponent keeps
  // walking in with one the claim will refuse to hand over.
  {
    const unrecorded = saveWith("Unrecorded keepsake", []);
    const inv = getInventory(unrecorded);
    inv.owned[carriedIds[0]] = 1;
    inv.lifetimeObtained[carriedIds[0]] = 1;
    inv.keepsakesReceived = [];
    localSaves.updateFighter(unrecorded.id, { itemInventory: inv } as never);
    const holder = localSaves.getFighter(unrecorded.id)!;
    check("a keepsake owned but never recorded still counts as held",
      heldKeepsakeIds(holder).includes(carriedIds[0]), heldKeepsakeIds(holder).join(", "));
    check("and it is not carried in again",
      !Object.keys(rollOpponentItems(500, always, rnd, heldKeepsakeIds(holder))).includes(carriedIds[0]));
    check("the claim agrees it is already held",
      claimOpponentKeepsakes(holder, { [carriedIds[0]]: 1 }).itemIds.length === 0);
  }

  // No save behind the fight means no way to tell what the player holds, so
  // the opponent carries nothing rather than something unwinnable.
  check("an unknown collection carries no keepsake",
    Object.keys(rollOpponentItems(500, always, rnd, null)).length === 0);

  // A keepsake flagged as a Boost item must not slip into an ordinary slot,
  // which would skip the collection filter entirely.
  {
    const { loadItemsConfig, saveItemsConfig } = await import("../client/src/game/itemsConfig");
    const { assignableBoostItems } = await import("../client/src/game/itemDistConfig");
    saveItemsConfig(loadItemsConfig().map(d => (d.isKeepsake ? { ...d, isBoost: true } : d)));
    check("a boost-flagged keepsake is still not an assignable boost",
      assignableBoostItems().every(d => !d.isKeepsake));
    const slots = { ...buildDefaultItemDistConfig(), keepsakeChancePct: 0 };
    const kit = rollOpponentItems(500, slots, Math.random, keepsakeIds);
    check("and no keepsake fills a boost slot",
      Object.keys(kit).every(id => !getItemDefinition(id)?.isKeepsake), JSON.stringify(kit));
    saveItemsConfig(DEFAULT_ITEMS);
  }

  // Config compatibility: shipped on, and a pre-feature save is not read as 0%.
  check("the shipped default carries a chance", buildDefaultItemDistConfig().keepsakeChancePct === KEEPSAKE_CHANCE_DEFAULT
    && KEEPSAKE_CHANCE_DEFAULT > 0);
  const legacy = buildDefaultItemDistConfig() as Partial<ReturnType<typeof buildDefaultItemDistConfig>>;
  delete legacy.keepsakeChancePct;
  localStorage.setItem("handz_item_dist_config", JSON.stringify(legacy));
  check("a config saved before the feature falls back to the default, not 0",
    loadItemDistConfig().keepsakeChancePct === KEEPSAKE_CHANCE_DEFAULT);
  saveItemDistConfig({ ...buildDefaultItemDistConfig(), keepsakeChancePct: 0 });
  check("an explicit 0 is respected", loadItemDistConfig().keepsakeChancePct === 0);
  clearItemDistConfig();
}

// ---------------------------------------------------------------------------
console.log("20. session boosts pay the flatter stat-point ladder");
{
  const { familySynergyPatch } = await import("../client/src/game/itemFamily");
  const { loadItemsConfig, saveItemsConfig, getItemDefinition } = await import("../client/src/game/itemsConfig");
  const closeTo = (a: number, b: number) => Math.abs(a - b) < 1e-9;
  const SP = [1.2, 1.5, 1.75, 2, 2.5, 3];
  const XP = [3, 4, 5, 6, 8, 14];
  const TIER_IDS = ["journeyman", "contender", "elite", "champion", "undisputed", "goat"];
  const families = [
    ["preworkout_powder", "trainSpMult", "trainXpMult"],
    ["combo_tape", "trainSpMult", "trainXpMult"],
    ["headgear_strap", "sparSpMult", "sparXpMult"],
  ] as const;

  for (const [base, spField, xpField] of families) {
    TIER_IDS.forEach((tier, i) => {
      const e = ITEM_EFFECTS[getItemDefinition(`${base}_${tier}`)!.effectId!];
      check(`${base} ${tier} grants ${SP[i]}x stat points`, closeTo(e[spField]!, SP[i]), `${e[spField]}`);
      check(`${base} ${tier} keeps its ${XP[i]}x XP`, closeTo(e[xpField]!, XP[i]), `${e[xpField]}`);
    });
  }

  // The nerfed numbers still add cleanly on an Additive family.
  const strap = { id: "headgear_strap_contender", name: "Headgear Strap II" };
  saveItemsConfig(familySynergyPatch(loadItemsConfig(), strap,
    { synergy: true, synergyStackCount: 3, synergyAdditive: true }));
  const pair = saveWith("Nerfed additive", [strap.id], 2);
  useItem(pair.id, strap.id, { roster: camp });
  useItem(pair.id, strap.id, { roster: camp });
  const got = getSparringSpMult(localSaves.getFighter(pair.id)!, camp);
  check("two 1.5x straps add up to 3x", closeTo(got, 3), `${got}`);
  saveItemsConfig(DEFAULT_ITEMS);
}

// ---------------------------------------------------------------------------
console.log("21. items only leave the locker when they are used or sold");
{
  const { isInstantGrant } = await import("../client/src/game/itemEffects");
  const plain = (min: number) => DEFAULT_ITEMS.filter(d =>
    !d.isKeepsake && d.rankUnlockThreshold == null && (d.obtainableLimit ?? 0) >= min);
  const sellId = plain(3).find(d => d.sellable)!.id;
  const otherId = plain(2).find(d => d.id !== sellId)!.id;
  const grantId = plain(2).find(d => isInstantGrant(d))!.id;
  const armId = "preworkout_powder_journeyman";
  const invOf = (f: Fighter) => getInventory(localSaves.getFighter(f.id)!);
  const wipe = (f: Fighter, inv: ItemInventory) => localSaves.updateFighter(
    f.id, { itemInventory: { ...inv, owned: {} } } as never, { allowInventoryShrink: true });

  // A sale writes a receipt, and the receipt keeps the copy gone.
  const seller = saveWith("Ledger seller", [sellId], 3);
  check("three copies owned before selling", invOf(seller).owned[sellId] === 3, `${invOf(seller).owned[sellId]}`);
  sellItem(seller.id, sellId, 2);
  const sold = invOf(seller);
  check("selling leaves one copy", sold.owned[sellId] === 1, `${sold.owned[sellId]}`);
  check("the sale is booked as spent", (sold.itemsSpent?.[sellId] ?? 0) === 2, `${sold.itemsSpent?.[sellId]}`);

  // Using a copy books it too, so a used item never comes back.
  const user = saveWith("Ledger user", [grantId], 2);
  useItem(user.id, grantId, {});
  const used = invOf(user);
  check("using a copy books it as spent", (used.itemsSpent?.[grantId] ?? 0) === 1, `${used.itemsSpent?.[grantId]}`);
  check("using a copy leaves the rest", used.owned[grantId] === 1, `${used.owned[grantId]}`);

  // A write that drops owned copies with no receipt is a loss — put them back.
  const wiped = saveWith("Ledger wipe", [sellId, otherId], 2);
  wipe(wiped, invOf(wiped));
  const healed = invOf(wiped);
  check("an unaccounted wipe is restored", healed.owned[sellId] === 2 && healed.owned[otherId] === 2,
    JSON.stringify(healed.owned));

  // ...but a wipe never resurrects what was already sold.
  sellItem(wiped.id, sellId, 1);
  const afterSale = invOf(wiped);
  wipe(wiped, afterSale);
  check("the repair stops at the sold copy", invOf(wiped).owned[sellId] === 1, `${invOf(wiped).owned[sellId]}`);

  // A stale writer that forgot the sale must not hand the copy back.
  localSaves.updateFighter(wiped.id, { itemInventory: { ...afterSale, itemsSpent: {} } } as never);
  const healed3 = invOf(wiped);
  check("a stale write cannot erase a receipt", (healed3.itemsSpent?.[sellId] ?? 0) === 1,
    `${healed3.itemsSpent?.[sellId]}`);
  check("and cannot resurrect the sold copy", healed3.owned[sellId] === 1, `${healed3.owned[sellId]}`);

  // A save written before the ledger existed keeps exactly what it holds now.
  const legacy = saveWith("Ledger legacy", [sellId], 3);
  const legacyInv = invOf(legacy);
  localSaves.updateFighter(legacy.id, {
    itemInventory: { ...legacyInv, owned: { [sellId]: 1 }, itemsSpent: undefined },
  } as never, { allowInventoryShrink: true });
  const migrated = invOf(legacy);
  check("a legacy save keeps its current count", migrated.owned[sellId] === 1, `${migrated.owned[sellId]}`);
  check("its missing copies are booked as spent", (migrated.itemsSpent?.[sellId] ?? 0) === 2,
    `${migrated.itemsSpent?.[sellId]}`);

  // Arming a boost is a spend as well — it must not be handed back mid-camp.
  const armer = saveWith("Ledger armer", [armId], 1);
  useItem(armer.id, armId, { roster: camp });
  const armed = invOf(armer);
  check("arming books the copy as spent", (armed.itemsSpent?.[armId] ?? 0) === 1, `${armed.itemsSpent?.[armId]}`);
  check("an armed copy is not restored to the locker", (armed.owned[armId] ?? 0) === 0, `${armed.owned[armId]}`);
  check("the armed boost is still live", (armed.activeBoosts[armId] ?? 0) === 1, `${armed.activeBoosts[armId]}`);

  // A writer holding a pre-sale snapshot must not win the merge and hand the
  // sold copy back — its counts are discounted by the receipts it never saw.
  const stale = saveWith("Ledger stale", [sellId], 2);
  const preSale = invOf(stale);
  sellItem(stale.id, sellId, 2);
  localSaves.updateFighter(stale.id, { itemInventory: preSale } as never);
  check("a pre-sale snapshot cannot resurrect a sold copy", (invOf(stale).owned[sellId] ?? 0) === 0,
    `${invOf(stale).owned[sellId]}`);

  // A writer with no ledger at all can't be judged against receipts, so it must
  // still be able to add copies (a grant folded into a pre-ledger save write).
  const noLedger = saveWith("Ledger-less writer", [sellId], 1);
  sellItem(noLedger.id, sellId, 1);
  const spentInv = invOf(noLedger);
  localSaves.updateFighter(noLedger.id, {
    itemInventory: {
      ...spentInv, owned: { [sellId]: 1 }, lifetimeObtained: { [sellId]: 2 }, itemsSpent: undefined,
    },
  } as never);
  check("a write with no ledger can still add a copy", invOf(noLedger).owned[sellId] === 1,
    `${invOf(noLedger).owned[sellId]}`);

  // The one-shot lifetime recovery honours receipts on a ledger save...
  const permId = DEFAULT_ITEMS.find(d => !d.isKeepsake && !d.isConsumable && (d.obtainableLimit ?? 0) >= 2)!.id;
  const recSave = saveWith("Ledger recovery", [permId], 2);
  localSaves.updateFighter(recSave.id, {
    itemInventory: { ...invOf(recSave), owned: { [permId]: 1 }, itemsSpent: { [permId]: 1 } },
  } as never, { allowInventoryShrink: true });
  recoverLockerFromLifetime(recSave.id);
  check("recovery leaves a spent copy spent", invOf(recSave).owned[permId] === 1,
    `${invOf(recSave).owned[permId]}`);

  // ...and still rebuilds a pre-ledger save whose locker was wiped.
  const oldSave = saveWith("Ledger pre-ledger recovery", [permId], 2);
  localSaves.updateFighter(oldSave.id, {
    itemInventory: {
      ...invOf(oldSave), owned: {}, itemsSpent: undefined, recoveredFromLifetimeV1: undefined,
    },
  } as never, { allowInventoryShrink: true });
  recoverLockerFromLifetime(oldSave.id);
  const rebuilt = invOf(oldSave);
  check("recovery still rebuilds a pre-ledger wipe", rebuilt.owned[permId] === 2, `${rebuilt.owned[permId]}`);
  check("and clears the guessed receipts", (rebuilt.itemsSpent?.[permId] ?? 0) === 0,
    `${rebuilt.itemsSpent?.[permId]}`);

  // A locker wiped by some other writer heals on its own: the effect layer
  // reads the repaired counts immediately, and the load-time heal writes them
  // back so the stored save (and its export) is whole again.
  const heal = saveWith("Ledger heal", [permId], 2);
  const perkBefore = getLuckyCoinChance(localSaves.getFighter(heal.id));
  localSaves.updateFighter(heal.id, {
    itemInventory: { ...invOf(heal), owned: {} },
  } as never, { allowInventoryShrink: true });
  const rawWiped = localSaves.getFighter(heal.id)!.itemInventory as ItemInventory;
  check("the wipe really hit storage", (rawWiped.owned[permId] ?? 0) === 0, `${rawWiped.owned[permId]}`);
  check("the effect layer still sees the lost copies",
    getLuckyCoinChance(localSaves.getFighter(heal.id)) === perkBefore && perkBefore > 0,
    `${getLuckyCoinChance(localSaves.getFighter(heal.id))} vs ${perkBefore}`);
  healLockerFromLedger(heal.id);
  const rawHealed = localSaves.getFighter(heal.id)!.itemInventory as ItemInventory;
  check("the load-time heal writes the repair into the save", rawHealed.owned[permId] === 2,
    `${rawHealed.owned[permId]}`);
}

// ---------------------------------------------------------------------------
console.log("22. an item that became a keepsake folds its old holdings into one copy");
{
  const KEEPSAKE = "goats_blessing";
  const invOf = (f: Fighter) => getInventory(localSaves.getFighter(f.id)!);
  /** Write a pre-keepsake inventory straight into the save. */
  const legacy = (name: string, patch: Partial<ItemInventory>): Fighter => {
    const f = saveWith(name, []);
    localSaves.updateFighter(f.id, {
      itemInventory: { ...invOf(f), ...patch },
    } as never, { allowInventoryShrink: true });
    return f;
  };

  // Several copies owned from when it was a stackable consumable: a permanent
  // effect would read every one of them as a stack.
  const many = legacy("Legacy copies", {
    owned: { [KEEPSAKE]: 3 }, lifetimeObtained: { [KEEPSAKE]: 3 }, itemsSpent: {}, keepsakesReceived: [],
  });
  normalizeKeepsakeHoldings(many.id);
  const manyInv = invOf(many);
  check("three old copies fold into one", manyInv.owned[KEEPSAKE] === 1, `${manyInv.owned[KEEPSAKE]}`);
  check("the surplus is booked as spent, so the ledger repair leaves it gone",
    (manyInv.itemsSpent?.[KEEPSAKE] ?? 0) === 2, `${manyInv.itemsSpent?.[KEEPSAKE]}`);
  check("the keepsake is recorded as received", manyInv.keepsakesReceived.includes(KEEPSAKE));
  const manyOn = getActiveBoosts(localSaves.getFighter(many.id), camp).filter(b => b.def.id === KEEPSAKE);
  check("it is active as a single permanent stack",
    manyOn.length === 1 && manyOn[0].stacks === 1, `${manyOn.length} × ${manyOn[0]?.stacks}`);

  // The only copy armed as a camp boost: nothing reads activeBoosts for a
  // permanent effect, so that copy has to come back to the locker.
  const armed = legacy("Legacy armed copy", {
    owned: {}, lifetimeObtained: { [KEEPSAKE]: 1 }, itemsSpent: { [KEEPSAKE]: 1 },
    activeBoosts: { [KEEPSAKE]: 1 }, boostCamp: { [KEEPSAKE]: "42:8" }, keepsakesReceived: [],
  });
  check("the armed copy really left the locker", (invOf(armed).owned[KEEPSAKE] ?? 0) === 0);
  normalizeKeepsakeHoldings(armed.id);
  const armedInv = invOf(armed);
  check("the armed copy comes back as an owned one", armedInv.owned[KEEPSAKE] === 1,
    `${armedInv.owned[KEEPSAKE]}`);
  check("its arming receipt is torn up", (armedInv.itemsSpent?.[KEEPSAKE] ?? 0) === 0,
    `${armedInv.itemsSpent?.[KEEPSAKE]}`);
  check("nothing is left armed", (armedInv.activeBoosts[KEEPSAKE] ?? 0) === 0
    && armedInv.boostCamp?.[KEEPSAKE] === undefined);
  check("the effect is on again",
    getActiveBoosts(localSaves.getFighter(armed.id), camp).some(b => b.def.id === KEEPSAKE));

  // A save that never had it is not gifted one, and a healthy save is untouched.
  const none = legacy("No keepsake", { owned: {}, lifetimeObtained: {}, itemsSpent: {}, keepsakesReceived: [] });
  normalizeKeepsakeHoldings(none.id);
  check("a save that never had it stays without it", (invOf(none).owned[KEEPSAKE] ?? 0) === 0);
  normalizeKeepsakeHoldings(many.id);
  check("running it again changes nothing", invOf(many).owned[KEEPSAKE] === 1
    && (invOf(many).itemsSpent?.[KEEPSAKE] ?? 0) === 2);
}

// ---------------------------------------------------------------------------
console.log("23. an item pulled from the game leaves nothing behind");
{
  const { loadItemsConfig, saveItemsConfig, RETIRED_ITEM_IDS } = await import("../client/src/game/itemsConfig");
  const invOf = (f: Fighter) => getInventory(localSaves.getFighter(f.id)!);
  check("at least one item is retired", RETIRED_ITEM_IDS.length > 0);
  const gone = RETIRED_ITEM_IDS[0];
  check("the shipped catalog no longer lists it", !DEFAULT_ITEMS.some(d => d.id === gone));
  check("its effect went with it", RETIRED_ITEM_IDS.every(id => !ITEM_EFFECTS[id]));

  // A saved config holds a copy of every item the admin has touched, and the
  // merge reads a saved id with no built-in as an admin-authored item — so the
  // load filter is the only thing stopping a retired item coming back.
  saveItemsConfig([...DEFAULT_ITEMS, { ...DEFAULT_ITEMS[0], id: gone, name: "Retired Item" }]);
  check("a saved override cannot bring it back", !loadItemsConfig().some(d => d.id === gone));
  check("the rest of the saved catalog survives the filter", loadItemsConfig().length === DEFAULT_ITEMS.length);
  saveItemsConfig(DEFAULT_ITEMS);

  // A save that owned one keeps every trace of it: copies, the lifetime record
  // the ledger rebuilds from, and the single 24h AC slot it was holding.
  const held = saveWith("Retired holder", []);
  localSaves.updateFighter(held.id, {
    itemInventory: {
      ...getInventory(held),
      owned: { [gone]: 2 }, lifetimeObtained: { [gone]: 3 }, itemsSpent: { [gone]: 1 },
      activeBoosts: { [gone]: 1 }, unseenItemIds: [gone],
      acBoost: { itemId: gone, expiresAtMs: 9_999_999_999_999 },
    },
  } as never);
  check("the save really is holding it", (invOf(held).owned[gone] ?? 0) === 2);

  purgeRetiredItems(held.id);
  const inv = invOf(held);
  check("no copies are left", (inv.owned[gone] ?? 0) === 0, String(inv.owned[gone]));
  check("the lifetime record goes too", (inv.lifetimeObtained[gone] ?? 0) === 0, String(inv.lifetimeObtained[gone]));
  check("its receipts are torn up", (inv.itemsSpent?.[gone] ?? 0) === 0);
  check("nothing is left armed", (inv.activeBoosts[gone] ?? 0) === 0);
  check("the 24h AC slot is free again", inv.acBoost == null);
  check("it is not holding the locker's unseen dot", !(inv.unseenItemIds ?? []).includes(gone));

  // The two rebuild passes run on the same load — neither may resurrect it.
  recoverLockerFromLifetime(held.id);
  healLockerFromLedger(held.id);
  check("the lifetime recovery cannot bring it back", (invOf(held).owned[gone] ?? 0) === 0);
  purgeRetiredItems(held.id);
  check("running the purge again changes nothing", (invOf(held).owned[gone] ?? 0) === 0);
}

// ---------------------------------------------------------------------------
console.log("24. a consumable restocks however many the save has been through");
{
  const { storeBlock, storeMaxQty, careerBestRank } = await import("../client/src/lib/itemInventory");
  const { CONSUMABLE_LIMIT } = await import("../client/src/game/itemsConfig");
  const { DEFAULT_ITEM_INVENTORY } = await import("../shared/schema");
  const shelf = (d: Partial<ItemDefinition>) => ({
    ...DEFAULT_ITEMS[0], storeVisible: true, storeCostForce: 10, storeCostDiamonds: 0,
    storeRankUnlock: null, rankUnlockThreshold: null, ...d,
  }) as ItemDefinition;
  const held = (id: string, n: number): ItemInventory => ({
    ...DEFAULT_ITEM_INVENTORY, owned: { [id]: n }, lifetimeObtained: { [id]: n },
  });

  const potion = shelf({ id: "potion", name: "Potion", isConsumable: true, isKeepsake: false, obtainableLimit: CONSUMABLE_LIMIT });
  check("a consumable the save has none of is buyable", storeBlock(potion, held("potion", 0), 100) === null);
  check("owning a stack of them changes nothing", storeBlock(potion, held("potion", 40), 100) === null);
  check("nor does a lifetime past any sane limit", storeBlock(potion, held("potion", 99_999), 100) === null);

  // A built-in read straight off the seed never goes through the catalog's
  // consumable clamp, so the store must not treat its limit as a ceiling.
  const unclamped = shelf({ id: "unclamped", name: "Unclamped", isConsumable: true, isKeepsake: false, obtainableLimit: 1 });
  check("an unclamped consumable still restocks", storeBlock(unclamped, held("unclamped", 5), 100) === null);
  check("and the counter will still sell a batch", storeMaxQty(unclamped, held("unclamped", 5), 1_000_000, 0) > 1);

  // The two refusals that really are about ownership keep saying so.
  const keepsake = shelf({ id: "keeps", name: "Keepsake", isConsumable: false, isKeepsake: true, obtainableLimit: 1 });
  check("a keepsake already held reads as owned", storeBlock(keepsake, held("keeps", 1), 100)?.kind === "owned");
  const permanent = shelf({ id: "perm", name: "Permanent", isConsumable: false, isKeepsake: false, obtainableLimit: 2 });
  check("a permanent item below its limit is buyable", storeBlock(permanent, held("perm", 1), 100) === null);
  check("at its limit it reads as owned", storeBlock(permanent, held("perm", 2), 100)?.kind === "owned");

  // A rank threshold is a permanent unlock on the item itself — not a window,
  // and not a consumable-only rule. Reaching the number opens it on the shelf
  // and in the draws alike, and nothing shuts it again.
  const ranked = shelf({ id: "ranked", name: "Ranked", isConsumable: true, isKeepsake: false, obtainableLimit: CONSUMABLE_LIMIT, rankUnlockThreshold: 500 });
  check("a fresh save cannot buy past a rank gate", storeBlock(ranked, held("ranked", 0), 900)?.kind === "locked");
  check("nor can a save with no rank at all", storeBlock(ranked, held("ranked", 0), null)?.kind === "locked");
  check("reaching the rank opens it", storeBlock(ranked, held("ranked", 0), 500) === null);
  check("and climbing past it keeps it open", storeBlock(ranked, held("ranked", 0), 100) === null);
  const rankedPerm = shelf({ id: "rperm", name: "Ranked Perm", isConsumable: false, isKeepsake: false, obtainableLimit: 2, rankUnlockThreshold: 500 });
  check("a permanent item obeys the same gate", storeBlock(rankedPerm, held("rperm", 0), 900)?.kind === "locked");
  check("and opens on the same rank", storeBlock(rankedPerm, held("rperm", 0), 400) === null);

  // The permanence itself lives in the rank the callers hand in, not in the
  // gate: a career reads as the best rank it ever held.
  type RankSave = Parameters<typeof careerBestRank>[0];
  const save = (playerRank: number, bestRankEver?: number) =>
    ({ careerRosterState: { playerRank, bestRankEver } }) as unknown as RankSave;
  check("a career that slid back keeps its best rank", careerBestRank(save(900, 400)) === 400);
  check("so the item it earned stays on sale", storeBlock(ranked, held("ranked", 0), careerBestRank(save(900, 400))) === null);
  check("a live rank better than the mark wins", careerBestRank(save(200, 400)) === 200);
  check("a career with no mark yet reads its live rank", careerBestRank(save(700)) === 700);
  check("and no save at all has reached nothing", careerBestRank(null) === null);
  const gated = shelf({ id: "gated", name: "Gated", isConsumable: true, isKeepsake: false, obtainableLimit: CONSUMABLE_LIMIT, storeRankUnlock: 50 });
  check("a shelf-locked row reads as locked", storeBlock(gated, held("gated", 0), 900)?.kind === "locked");
}

console.log(failures === 0 ? "\nAll item effect checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
